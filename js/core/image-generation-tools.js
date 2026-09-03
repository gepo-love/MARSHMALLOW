import * as db from './db.js';
import {
  getImageStylePreset,
  buildRealisticPartialPersonPrompt,
  buildRealisticPortraitPrompt,
} from './image-style-presets.js';
import { isOpaqueFetchError, makeOpaqueFetchError } from './network-error.js';
import {
  dataUrlApproxBytes,
  fileToOptimizedChatImageDataUrl,
} from './chat/chat-image-utils.js';
import { inflateRaw } from './inflate-raw.js';
import {
  getNativeHttpTransport,
  nativeHttpGetBytes,
  nativeHttpPostJson,
} from './native-http.js';
import {
  resolveSocialWorkerUrl,
  socialWorkerAuthHeaders,
} from './social-worker-client.js';
import {
  buildGoogleGeminiContentUrl,
  buildGoogleGeminiModelsUrl,
  readStream,
} from './api.js';

export const IMAGE_TOOL_CONFIG_KEY = 'imageToolConfig';
export const MAX_REFERENCE_IMAGES = 4;

export const DEFAULT_IMAGE_TOOL_CONFIG = {
  characterProvider: 'off',
  realisticProvider: 'off',
  novelAi: {
    enabled: false,
    endpoint: '',
    apiKey: '',
    model: 'nai-diffusion-4-5-full',
    promptTemplate: '',
    promptPrefix: '',
    promptSuffix: '',
    negativePrompt: '',
    size: '832x1216',
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
  },
  realistic: {
    enabled: false,
    provider: 'openai_compatible',
    endpoint: '',
    apiKey: '',
    model: '',
    promptTemplate: '',
    promptPrefix: '',
    promptSuffix: '',
    negativePrompt: '',
    dePolish: true,
    noPeople: true,
    noFaces: true,
    allowHands: true,
    size: '1024x1024',
    quality: '',
    responseFormat: '',
  },
  usage: {
    chatImages: false,
    linkCardCovers: false,
    momentsImages: false,
    weiboImages: false,
  },
  // 各场景使用哪个生图引擎：'novelai'(全部NAI) | 'realistic'(全部兼容生图) | 'smart'(人物用NAI，其余兼容)
  scenes: {
    chatImages: 'smart',
    momentsImages: 'smart',
    weiboImages: 'smart',
    offlineScene: 'smart',
    // 旅行明信片/途中生图默认走兼容引擎；画风由用户选择或全局 sceneStyleId 决定，不强制真人。
    travelImages: 'realistic',
  },
  // 全局默认画风（image-style-presets.js 的预设 id；空 = 不套用）。
  // 角色 imageStyleId、单次调用 styleId 会覆盖这里。
  styles: {
    novelAiStyleId: '',
    realisticPersonStyleId: '',
    sceneStyleId: '',
  },
};

function mergeConfig(value = {}) {
  const src = value || {};
  const realistic = { ...DEFAULT_IMAGE_TOOL_CONFIG.realistic, ...(src.realistic || {}) };
  realistic.responseFormat = ['url', 'b64_json'].includes(String(realistic.responseFormat || '').trim())
    ? String(realistic.responseFormat).trim()
    : '';
  realistic.noFaces = true;
  const novelAi = { ...DEFAULT_IMAGE_TOOL_CONFIG.novelAi, ...(src.novelAi || {}) };
  // 历史配置/预设常出现「勾了启用、Provider 仍是关闭」；只补这一侧，避免把用户关掉的启用又打开
  let realisticProvider = src.realisticProvider ?? DEFAULT_IMAGE_TOOL_CONFIG.realisticProvider;
  let characterProvider = src.characterProvider ?? DEFAULT_IMAGE_TOOL_CONFIG.characterProvider;
  if (realistic.enabled && !['openai_compatible', 'openai_chat', 'google_gemini'].includes(realisticProvider)) {
    realisticProvider = ['openai_compatible', 'openai_chat', 'google_gemini'].includes(realistic.provider)
      ? realistic.provider
      : 'openai_compatible';
  }
  realistic.provider = ['openai_chat', 'google_gemini'].includes(realisticProvider)
    ? realisticProvider
    : 'openai_compatible';
  if (novelAi.enabled) characterProvider = 'novelai';
  return {
    ...DEFAULT_IMAGE_TOOL_CONFIG,
    ...src,
    characterProvider,
    realisticProvider,
    novelAi,
    realistic,
    usage: { ...DEFAULT_IMAGE_TOOL_CONFIG.usage, ...(src.usage || {}) },
    scenes: { ...DEFAULT_IMAGE_TOOL_CONFIG.scenes, ...(src.scenes || {}) },
    styles: { ...DEFAULT_IMAGE_TOOL_CONFIG.styles, ...(src.styles || {}) },
  };
}

export async function loadImageToolConfig() {
  const row = await db.get('settings', IMAGE_TOOL_CONFIG_KEY);
  return mergeConfig(row?.value || {});
}

export async function saveImageToolConfig(config = {}) {
  const next = mergeConfig(config);
  await db.put('settings', { key: IMAGE_TOOL_CONFIG_KEY, value: next });
  return next;
}

export function isRealisticImageGenerationEnabled(config = {}) {
  const cfg = mergeConfig(config);
  return ['openai_compatible', 'openai_chat', 'google_gemini'].includes(cfg.realisticProvider)
    && cfg.realistic?.enabled === true
    && !!String(cfg.realistic?.apiKey || '').trim()
    && !!String(cfg.realistic?.model || '').trim();
}

/** NovelAI 官方图像模型（无公开 models 列表接口，故内置常用清单） */
export const NOVELAI_MODELS = [
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-full',
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-3',
  'nai-diffusion-furry-3',
];

/** NovelAI 尺寸预设（width x height） */
export const NOVELAI_SIZE_OPTIONS = [
  { value: '832x1216', label: '竖图 832×1216' },
  { value: '1216x832', label: '横图 1216×832' },
  { value: '1024x1024', label: '方图 1024×1024' },
  { value: '512x768', label: '小竖图 512×768' },
];

/** 兼容生图（gpt-image 等 OpenAI 兼容中转）尺寸预设 */
export const REALISTIC_SIZE_OPTIONS = [
  { value: '1024x1024', label: '方图 1024×1024' },
  { value: '1024x1536', label: '竖图 1024×1536' },
  { value: '1536x1024', label: '横图 1536×1024' },
  { value: 'auto', label: '自动（由模型决定，仅 gpt-image 支持）' },
];

/** AI 按画面内容建议画幅（gen_image 的 shape 字段）→ 各引擎实际尺寸 */
const ASPECT_SIZE_BY_PROVIDER = {
  novelai: { portrait: '832x1216', landscape: '1216x832', square: '1024x1024' },
  realistic: { portrait: '1024x1536', landscape: '1536x1024', square: '1024x1024' },
};

/** 归一化画幅关键词：portrait / landscape / square，识别不了返回空串 */
export function normalizeImageAspect(value = '') {
  const v = String(value || '').trim().toLowerCase();
  if (['portrait', 'vertical', 'tall', '竖', '竖图', '竖幅'].includes(v)) return 'portrait';
  if (['landscape', 'horizontal', 'wide', '横', '横图', '横幅'].includes(v)) return 'landscape';
  if (['square', '方', '方图'].includes(v)) return 'square';
  return '';
}

/** 按引擎把画幅换算成尺寸字符串；无匹配返回空串（走各引擎默认尺寸） */
export function resolveImageSizeForAspect(provider = '', aspect = '') {
  const key = normalizeImageAspect(aspect);
  if (!key) return '';
  return ASPECT_SIZE_BY_PROVIDER[provider]?.[key] || '';
}

/**
 * 决定一次请求的最终尺寸：调用方显式尺寸最高；聊天可把用户配置标记为硬约束；
 * 其余场景仍允许 AI / 业务画幅建议覆盖默认值。
 */
export function resolveImageRequestSize(provider = '', options = {}, cfg = {}) {
  const explicitSize = String(options?.size || '').trim();
  if (explicitSize) return explicitSize;
  const configuredSize = String(
    provider === 'novelai' ? cfg?.novelAi?.size : cfg?.realistic?.size,
  ).trim();
  if (options?.respectConfiguredSize === true && configuredSize) return configuredSize;
  const aspectSize = resolveImageSizeForAspect(provider, options?.aspect);
  return aspectSize || configuredSize;
}

export const NOVELAI_DEFAULT_QUALITY = 'best quality, very aesthetic, masterpiece, absurdres';

export const NOVELAI_DEFAULT_NEGATIVE = 'nsfw, lowres, worst quality, bad quality, jpeg artifacts, very displeasing, '
  + 'chromatic aberration, signature, watermark, username, logo, artistic error, scan, '
  + 'bad anatomy, bad hands, extra digits, fewer digits, missing fingers, extra fingers, '
  + 'multiple views, blurry, text';

export function isNovelAiImageGenerationEnabled(config = {}) {
  const cfg = mergeConfig(config);
  return cfg.characterProvider === 'novelai'
    && cfg.novelAi?.enabled === true
    && !!String(cfg.novelAi?.apiKey || '').trim()
    && !!String(cfg.novelAi?.model || '').trim();
}

function buildApiUrl(baseUrl, endpointPath) {
  const base = String(baseUrl || '').trim();
  const endpoint = String(endpointPath || '').startsWith('/') ? String(endpointPath || '') : `/${endpointPath || ''}`;
  const endpointWithoutV1 = endpoint.replace(/^\/v1(?=\/|$)/i, '');
  if (!base) return `/api${endpoint}`;
  const cleanBase = /^https?:\/\//i.test(base) || base.startsWith('/')
    ? base.replace(/\/+$/, '')
    : `/${base.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  if (/\/v1$/i.test(cleanBase)) return `${cleanBase}${endpointWithoutV1}`;
  if (/\/v1\/images\/generations$/i.test(cleanBase)) {
    if (/^\/v1\/images\/generations$/i.test(endpoint)) return cleanBase;
    if (/^\/v1\/models$/i.test(endpoint)) return cleanBase.replace(/\/v1\/images\/generations$/i, '/v1/models');
    if (/^\/v1\/images\/edits$/i.test(endpoint)) return cleanBase.replace(/\/v1\/images\/generations$/i, '/v1/images/edits');
    if (/^\/v1\/chat\/completions$/i.test(endpoint)) return cleanBase.replace(/\/v1\/images\/generations$/i, '/v1/chat/completions');
  }
  if (/\/v1\/models$/i.test(cleanBase)) {
    if (/^\/v1\/models$/i.test(endpoint)) return cleanBase;
    if (/^\/v1\/images\/generations$/i.test(endpoint)) return cleanBase.replace(/\/v1\/models$/i, '/v1/images/generations');
    if (/^\/v1\/images\/edits$/i.test(endpoint)) return cleanBase.replace(/\/v1\/models$/i, '/v1/images/edits');
    if (/^\/v1\/chat\/completions$/i.test(endpoint)) return cleanBase.replace(/\/v1\/models$/i, '/v1/chat/completions');
  }
  if (/\/v1\/images\/edits$/i.test(cleanBase)) {
    if (/^\/v1\/images\/edits$/i.test(endpoint)) return cleanBase;
    if (/^\/v1\/images\/generations$/i.test(endpoint)) return cleanBase.replace(/\/v1\/images\/edits$/i, '/v1/images/generations');
    if (/^\/v1\/models$/i.test(endpoint)) return cleanBase.replace(/\/v1\/images\/edits$/i, '/v1/models');
    if (/^\/v1\/chat\/completions$/i.test(endpoint)) return cleanBase.replace(/\/v1\/images\/edits$/i, '/v1/chat/completions');
  }
  if (/\/v1\/chat\/completions$/i.test(cleanBase)) {
    if (/^\/v1\/chat\/completions$/i.test(endpoint)) return cleanBase;
    if (/^\/v1\/models$/i.test(endpoint)) return cleanBase.replace(/\/v1\/chat\/completions$/i, '/v1/models');
    if (/^\/v1\/images\/generations$/i.test(endpoint)) return cleanBase.replace(/\/v1\/chat\/completions$/i, '/v1/images/generations');
    if (/^\/v1\/images\/edits$/i.test(endpoint)) return cleanBase.replace(/\/v1\/chat\/completions$/i, '/v1/images/edits');
  }
  return `${cleanBase}${endpoint}`;
}

function wrapNetworkError(err, url = '', { replayRisk = true } = {}) {
  if (isOpaqueFetchError(err)) {
    return makeOpaqueFetchError(err, url, {
      label: '图片接口请求',
      replayRisk,
      nativeHint: '反复出现时请检查图片接口线路；浏览器直连可改为预先配置的同源代理。',
    });
  }
  const raw = String(err?.message || err || '');
  return err instanceof Error ? err : new Error(raw || '图片接口请求失败');
}

export function isImageGenerationOutcomeUnknown(error) {
  if (!error) return false;
  return error.requestMayHaveReachedServer === true
    || error.replayBlocked === true
    || error.resultUnknown === true
    || error.code === 'opaque_network_error'
    || ['connect', 'total'].includes(String(error.timeoutStage || ''));
}

function markImageOutcomeUnknown(error, {
  operation = '图片生成',
  usedUrl = '',
} = {}) {
  const base = error instanceof Error ? error : new Error(String(error || '请求失败'));
  const detail = String(base.message || base || '').trim();
  const wrapped = new Error(
    `${operation}结果未知：${detail}`
    + (detail.includes('检查服务端生成记录')
      ? ''
      : ' 请先检查服务端生成记录，再决定是否重新生成。'),
  );
  for (const key of [
    'code',
    'networkFailure',
    'requestElapsedMs',
    'requestPhase',
    'timeoutStage',
    'targetOrigin',
  ]) {
    if (base[key] != null) wrapped[key] = base[key];
  }
  wrapped.operation = operation;
  wrapped.usedUrl = String(base.usedUrl || usedUrl || '');
  wrapped.requestMayHaveReachedServer = true;
  wrapped.replayBlocked = true;
  wrapped.resultUnknown = true;
  wrapped.cause = base;
  return wrapped;
}

function imageAuthHeaderValue(apiKey = '') {
  const key = String(apiKey || '').trim();
  if (!key) return '';
  if (/^(Bearer|Basic)\s+/i.test(key)) return key;
  return `Bearer ${key}`;
}

function imageHeaders(cfg = {}, { json = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (json) headers['Content-Type'] = 'application/json';
  const key = String(cfg.realistic?.apiKey || '').trim();
  if (cfg.realisticProvider === 'google_gemini') {
    if (key) headers['x-goog-api-key'] = key.replace(/^Bearer\s+/i, '').trim();
  } else {
    const auth = imageAuthHeaderValue(key);
    if (auth) headers.Authorization = auth;
  }
  return headers;
}

async function parseImageApiJsonResponse(res) {
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = data?.error?.message
      || data?.message
      || data?.error
      || text
      || res.statusText
      || '请求失败';
    throw new Error(`图片接口请求失败 (${res.status})：${String(msg).slice(0, 260)}`);
  }
  if (!data) throw new Error('图片接口返回不是 JSON');
  return data;
}

function shouldRetryImageProxy(primaryUrl = '', err = null, { sideEffectFree = false } = {}) {
  if (!/^https?:\/\//i.test(String(primaryUrl || ''))) return false;
  // 模型列表等只读请求可安全回退；生图/编辑请求可能已计费，不能凭不透明错误重放。
  return sideEffectFree && err?.code === 'opaque_network_error';
}

function normalizeImageModelId(item) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  return String(item.id || item.name || item.model || item.model_name || item.slug || '').trim();
}

function extractImageModelList(data = {}) {
  const pools = [
    Array.isArray(data) ? data : null,
    data?.data,
    data?.models,
    data?.items,
    data?.result,
    data?.data?.models,
    data?.data?.items,
  ].filter(Array.isArray);
  return [...new Set(pools.flatMap((items) => items.map(normalizeImageModelId)).filter(Boolean))].sort();
}

function normalizeGeneratedImageValue(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw) || /^https?:\/\//i.test(raw) || /^blob:/i.test(raw)) return raw;
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 80) return `data:image/png;base64,${raw.replace(/\s+/g, '')}`;
  return raw;
}

/** 从 Chat Completions 正文里提取 markdown Data URI 图片（空悲切等 NAI 中转） */
export function extractMarkdownImageDataUris(content = '') {
  const text = String(content || '');
  if (!text) return [];
  const out = [];
  const re = /!\[[^\]]*\]\((data:image\/[^;)\s]+;base64,[A-Za-z0-9+/=\s]+)\)/gi;
  let match;
  while ((match = re.exec(text))) {
    const uri = String(match[1] || '').replace(/\s+/g, '').trim();
    if (uri) out.push(uri);
  }
  // 兜底：正文直接塞了 data URI（少数中转不包 markdown）
  if (!out.length) {
    const bare = text.match(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/i);
    if (bare?.[0]) out.push(bare[0]);
  }
  return out;
}

function extractMarkdownImageUrls(content = '') {
  const text = String(content || '');
  const dataUris = extractMarkdownImageDataUris(text);
  if (dataUris.length) return dataUris;
  const out = [];
  const re = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
  let match;
  while ((match = re.exec(text))) {
    const url = normalizeGeneratedImageValue(match[1]);
    if (url) out.push(url);
  }
  return out;
}

function extractImageValueFromChatPart(part) {
  if (typeof part === 'string') return normalizeGeneratedImageValue(part);
  if (!part || typeof part !== 'object') return '';
  return normalizeGeneratedImageValue(
    part.image_url?.url
    || part.image_url
    || part.imageUrl?.url
    || part.imageUrl
    || part.url
    || part.b64_json
    || part.base64
    || '',
  );
}

function extractChatCompletionImageUrl(data = {}) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const message = choice?.message || data?.message || {};
  const imagePools = [
    message?.images,
    message?.output_images,
    data?.images,
    data?.output_images,
  ].filter(Array.isArray);
  for (const part of imagePools.flat()) {
    const url = extractImageValueFromChatPart(part);
    if (url) return url;
  }
  const directImage = extractImageValueFromChatPart(
    message?.image || message?.image_url || data?.image || data?.image_url || '',
  );
  if (directImage) return directImage;
  const content = message?.content
    ?? choice?.delta?.content
    ?? data?.content
    ?? '';
  if (typeof content === 'string') {
    const fromMd = extractMarkdownImageUrls(content)[0];
    if (fromMd) return fromMd;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = String(part.text || part.content || '').trim();
      if (text) {
        const fromMd = extractMarkdownImageUrls(text)[0];
        if (fromMd) return fromMd;
      }
      const url = extractImageValueFromChatPart(part);
      if (url) return url;
    }
  }
  return '';
}

function extractGeneratedImageUrl(data = {}) {
  const fromChat = extractChatCompletionImageUrl(data);
  if (fromChat) return fromChat;
  const geminiParts = Array.isArray(data?.candidates?.[0]?.content?.parts)
    ? data.candidates[0].content.parts
    : [];
  for (const part of geminiParts) {
    const inline = part?.inlineData || part?.inline_data;
    const inlineValue = normalizeGeneratedImageValue(inline?.data || '');
    if (inlineValue) {
      const mimeType = String(inline?.mimeType || inline?.mime_type || 'image/png').trim();
      return inlineValue.replace(/^data:image\/png/i, `data:${mimeType}`);
    }
    const fileValue = normalizeGeneratedImageValue(
      part?.fileData?.fileUri || part?.file_data?.file_uri || part?.image_url?.url || '',
    );
    if (fileValue) return fileValue;
  }
  const pools = [
    Array.isArray(data) ? data : null,
    data?.data,
    data?.images,
    data?.result,
    data?.items,
  ].filter(Array.isArray);
  const first = pools.flat()[0] || {};
  return normalizeGeneratedImageValue(
    (typeof first === 'string' ? first : '')
    || first.url
    || first.image_url
    || first.imageUrl
    || first.b64_json
    || first.base64
    || data?.url
    || data?.image_url
    || data?.imageUrl
    || data?.b64_json
    || data?.base64
    || ''
  );
}

function googleGeminiAspectRatio(size = '') {
  const normalized = normalizeOpenAiImageSize(size, 'auto');
  if (normalized === '1024x1536') return '2:3';
  if (normalized === '1536x1024') return '3:2';
  if (normalized === '1024x1024') return '1:1';
  return '';
}

function buildGoogleGeminiImageBody(prompt = '', size = '', imageParts = []) {
  const aspectRatio = googleGeminiAspectRatio(size);
  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
  };
  if (aspectRatio) generationConfig.imageConfig = { aspectRatio };
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: String(prompt || '').trim() },
        ...(Array.isArray(imageParts) ? imageParts : []),
      ],
    }],
    generationConfig,
  };
}

async function requestGoogleGeminiImage(prompt, cfg, model, options = {}, imageParts = []) {
  const endpoint = String(cfg.realistic?.endpoint || '').trim();
  const url = buildGoogleGeminiContentUrl(endpoint, model);
  const payload = JSON.stringify(buildGoogleGeminiImageBody(
    prompt,
    options.size || cfg.realistic?.size || '1024x1024',
    imageParts,
  ));
  try {
    return await runImageRequestWithTimeout(async (signal, markConnected) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: imageHeaders(cfg),
        body: payload,
        signal,
      });
      markConnected();
      const data = await parseImageApiJsonResponse(res);
      return { url: dataUrlToBlobUrl(extractGeneratedImageUrl(data)), raw: data };
    }, {
      signal: options.signal,
      connectTimeoutMs: options.connectTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      url,
    });
  } catch (e) {
    throw wrapNetworkError(e, url);
  }
}

function buildOpenAiChatImageBody(prompt = '', model = '', size = '', imageUrls = []) {
  const aspectRatio = googleGeminiAspectRatio(size);
  const images = (Array.isArray(imageUrls) ? imageUrls : []).filter(Boolean);
  const content = images.length
    ? [
        { type: 'text', text: String(prompt || '').trim() },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
    : String(prompt || '').trim();
  return {
    model,
    messages: [{ role: 'user', content }],
    stream: false,
    modalities: ['text', 'image'],
    ...(aspectRatio ? { image_config: { aspect_ratio: aspectRatio } } : {}),
  };
}

async function requestOpenAiChatImage(prompt, cfg, model, options = {}, imageUrls = []) {
  const endpoint = String(cfg.realistic?.endpoint || '').trim();
  const url = buildApiUrl(endpoint, '/v1/chat/completions');
  const payload = JSON.stringify(buildOpenAiChatImageBody(
    prompt,
    model,
    options.size || cfg.realistic?.size || '1024x1024',
    imageUrls,
  ));
  try {
    return await runImageRequestWithTimeout(async (signal, markConnected) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: imageHeaders(cfg),
        body: payload,
        signal,
      });
      markConnected();
      const text = await res.text().catch(() => '');
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
      if (!res.ok) {
        const detail = data?.error?.message || data?.message || data?.error || text || res.statusText || '请求失败';
        const err = new Error(`Chat image generation failed (${res.status}): ${String(detail).slice(0, 400)}`);
        err.httpStatus = res.status;
        err.responseText = text;
        throw err;
      }
      if (!data) throw new Error('聊天生图接口返回不是 JSON');
      const generatedUrl = extractGeneratedImageUrl(data);
      if (!generatedUrl) {
        const err = new Error('聊天生图接口已返回，但没有识别到图片；请确认中转支持 Gemini 图片输出');
        err.responseText = text;
        throw err;
      }
      return { url: dataUrlToBlobUrl(generatedUrl), raw: data };
    }, {
      signal: options.signal,
      connectTimeoutMs: options.connectTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      url,
    });
  } catch (e) {
    throw wrapNetworkError(e, url);
  }
}

/** OpenAI Images 的 size 必须是小写 x 分隔，如 1024x1024 */
export function normalizeOpenAiImageSize(size = '', fallback = '1024x1024') {
  const raw = String(size || '').trim();
  if (!raw) return fallback;
  if (/^auto$/i.test(raw)) return 'auto';
  const m = raw.toLowerCase().replace(/[×*✕]/g, 'x').match(/^(\d{2,4})\s*x\s*(\d{2,4})$/);
  if (m) return `${Number(m[1])}x${Number(m[2])}`;
  return fallback;
}

function normalizePromptText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function looksLikeBodyDetailPrompt(text = '') {
  const t = normalizePromptText(text);
  if (!t) return false;
  return [
    /手腕|手背|手指|手掌|指节|指尖|掌心|掌骨|骨节|关节/,
    /锁骨|喉结|胸膛|胸口|肩颈|肩线|脖颈|颈侧|后颈|侧颈/,
    /腰线|腰腹|腹部|上身|半身|腰腿|腿部|大腿|小腿|膝盖|脚踝|脚背|脚尖|脚/,
    /人物特写|身体局部|无脸|不露脸|半身照|近景|特写|cropped|close-up|close up|torso|hands?|neck|collarbone|waist|legs?|ankles?|feet?/,
  ].some((pattern) => pattern.test(t));
}

/** 局部人物、背影和明确无人画面都不允许身份锁定反向放开正脸。 */
export function isNoFaceImageRequest(options = {}) {
  const peopleIntent = String(options.peopleIntent || '').trim();
  return options.allowVisibleFace === false
    || options.portraitStyleAllowed === false
    || peopleIntent === 'none'
    || peopleIntent === 'partial';
}

function looksLikeMaleSubject(text = '') {
  const t = normalizePromptText(text);
  if (!t) return false;
  return /男性|男生|男士|男人|男手|男模|帅哥|male|man\b|men\b/.test(t);
}

function buildBodyDetailGuidance(basePrompt = '') {
  if (!looksLikeBodyDetailPrompt(basePrompt)) return [];
  const isMale = looksLikeMaleSubject(basePrompt);
  const lines = [
    'If a human body is present, keep the frame cropped and intentional: choose one clear focus such as hands, wrists, collarbone, neck, chest, waist, thighs, calves, ankles, or feet; do not add a face or full portrait.',
    'Prioritize anatomical coherence: natural pose, believable proportions, stable joints, correct finger count, clean nails, smooth transitions between torso and limbs, and no awkward twists.',
  ];
  if (isMale) {
    lines.push('For a male subject, use a clean attractive male fashion-editorial body shape: lean athletic build, long limbs, narrow waist, straight shoulders, good posture, subtle muscle definition, and a refined fresh look; favor cool fair ivory skin that looks clean, translucent, and not yellow; avoid overweight, bulky, sloppy, greasy, rough, dull, sallow, or exaggerated body proportions.');
    lines.push('For male hands, favor cool fair skin, slender but not weak hands, long clean fingers, clear knuckles, thin hand backs, subtle blue veins and tendons, short clean nails, relaxed confidence, and details that feel neat rather than rough.');
    lines.push('Good compositions include hands holding a cup, phone, jacket hem, book, or steering wheel; a cropped selfie starting below the jawline with neck, collarbone, and outfit visible; a half-body crop showing fitted clothing and clean shoulder-to-waist lines; a waist-down crop showing beltline, trousers, calves, and ankles; or a seated / leaning pose with only the relevant body area in frame.');
  } else {
    lines.push('Favor elegant, realistic body details with a clean editorial feel, and keep the crop tight enough that the intended body part reads clearly without accidental face visibility.');
  }
  lines.push('Clothing should be well-fitted and flattering, with believable fabric folds around shoulders, waist, wrists, knees, and ankles; do not let loose clothing make the body look shapeless unless explicitly requested.');
  lines.push('Do not over-sharpen skin texture, do not exaggerate muscles, do not make hands rough, swollen, or malformed, and do not let the subject drift into full-body portrait framing unless explicitly requested.');
  return lines;
}

export function buildRealisticImagePrompt(prompt = '', config = {}, options = {}) {
  const cfg = mergeConfig(config);
  if (options.allowFacesForThisRequest === true) {
    cfg.realistic.noFaces = false;
  }
  const base = String(prompt || '').trim();
  const template = String(cfg.realistic?.promptTemplate || '').trim();
  if (template) {
    return template.includes('{prompt}')
      ? template.replace(/\{prompt\}/g, base)
      : [template, base].filter(Boolean).join('\n');
  }
  const prefix = String(cfg.realistic?.promptPrefix || '').trim();
  const suffix = String(cfg.realistic?.promptSuffix || '').trim();
  const bodyDetailPrompt = looksLikeBodyDetailPrompt(base);
  // 保留写实/摄影质感；无脸是安全默认，不强调「真人」身份。
  const rules = [
    [prefix, base].filter(Boolean).join('\n'),
    'Photorealistic everyday life scene, natural lighting, believable phone-camera detail, crisp clear focus, no overdramatic composition.',
    'Use this as environmental evidence: food, objects, interiors, street scenery, packaging, receipts, weather, pets-related items, desk corners, window views, shop shelves, transit details, or other ordinary life texture.',
    'First-person snapshot logic: the phone taking this photo must never appear in frame (a phone may show only as a mirror reflection); keep perspective, object scale, and limb anatomy consistent and believable.',
  ];
  if (cfg.realistic.dePolish !== false) {
    rules.push('De-polished candid realism: ordinary phone snapshot, slightly imperfect framing, casual angle, real-world clutter, mundane texture, natural shadows, not luxury, not glossy, not studio-grade, not advertising photography, not cinematic, not overly clean, not AI-polished.');
    rules.push('Image integrity: at most a subtle fine film grain — no heavy noise, no smeared or mushy textures, no warped or melted objects, no bent or wobbling straight lines, no unreadable garbled text, no glitch artifacts or double edges.');
  }
  if (cfg.realistic.noFaces !== false || cfg.realistic.noPeople !== false) {
    rules.push('No visible human face anywhere: no portrait, no selfie, no face reflection, no face on a screen/poster/photo, no identifiable person as the subject, no celebrity likeness, no readable ID badge or private personal information.');
  }
  if (bodyDetailPrompt) {
    rules.push(...buildBodyDetailGuidance(base));
  } else if (cfg.realistic.noPeople !== false) {
    rules.push('Avoid full human bodies or posed people as the subject. If a person is unavoidable, keep them cropped, anonymous, out of focus, or seen only as non-identifying background detail.');
  }
  if (cfg.realistic.allowHands !== false) {
    rules.push(bodyDetailPrompt
      ? 'Hands, if included, should look like carefully lit editorial detail: cool fair skin, long clean fingers, visible knuckles, thin hand backs, subtle blue veins, natural tendons, short clean nails, correct finger count, and no awkward bend at the wrist. Avoid yellow skin, rough skin, swollen fingers, thick fingers, short fingers, dirty nails, overly long nails, plastic skin, or overly feminine hands.'
      : 'Incidental hands are allowed only when they look natural, elegant, well-proportioned, clean, and believable; avoid extra fingers, distorted joints, bad nails, uncanny skin, or awkward hand poses.');
  } else {
    rules.push('No hands.');
  }
  if (suffix) rules.push(suffix);
  return rules.filter(Boolean).join('\n');
}

/**
 * 组装兼容生图最终下发 prompt（测试、聊天、朋友圈等统一入口）。
 * - 有 promptTemplate：仅用模板包裹 core，不叠加无脸生活图规则；{prompt} 插入场景或人像 core。
 * - 有人像画风预设且判定为人物图：core 走 buildRealisticPortraitPrompt（含颜值/随手拍等保底，不强制「真人」）。
 * - 否则：走 buildRealisticImagePrompt 生活证据图规则（写实质感 + 默认无脸）。
 */
export function assembleRealisticPrompt(scenePrompt = '', config = {}, options = {}) {
  const cfg = mergeConfig(config);
  const scene = String(scenePrompt || '').trim();
  const template = String(cfg.realistic?.promptTemplate || '').trim();
  const portraitStyle = options.portraitStyle || null;
  const peopleIntent = String(options.peopleIntent || '').trim();
  const isPortrait = peopleIntent
    ? peopleIntent === 'portrait'
    : (options.forcePortrait === true
      || (portraitStyle ? looksLikePersonPrompt(scene) : false));
  const isPartialPerson = peopleIntent === 'partial';

  let core = scene;
  if (portraitStyle && isPortrait) {
    core = buildRealisticPortraitPrompt(scene, portraitStyle);
  } else if (portraitStyle && isPartialPerson) {
    core = buildRealisticPartialPersonPrompt(scene, portraitStyle, {
      allowVisibleFace: false,
    });
  }

  if (template) {
    const wrapped = template.includes('{prompt}')
      ? template.replace(/\{prompt\}/g, core)
      : [template, core].filter(Boolean).join('\n');
    if (peopleIntent === 'none') {
      return [
        wrapped,
        'Final subject constraint: no people or human figures anywhere in the image — no face, body, silhouette, reflection, portrait, or person on a screen/poster/photo.',
      ].join('\n');
    }
    if (peopleIntent === 'partial') {
      return [
        wrapped,
        'Final subject constraint: preserve the requested body detail, hands, back view, silhouette, or environmental composition. The same character may be conveyed through hair, clothing, build, and accessories, but no visible or identifiable face is allowed anywhere, including reflections, screens, posters, or photos; no portrait framing.',
      ].join('\n');
    }
    if (options.portraitStyleAllowed === false) {
      return [
        wrapped,
        'Final subject constraint: do not turn this scene into a face-focused or identifiable portrait.',
      ].join('\n');
    }
    // 角色/单次画风优先于全局自定义模板。尤其 2.5D 需要在末尾重申非摄影约束，
    // 避免模板中的 photo / realistic 等旧词把最终结果拉回真人照片。
    return portraitStyle?.finalGuard && isPortrait
      ? [wrapped, `Final rendering priority: ${portraitStyle.finalGuard}`].join('\n')
      : wrapped;
  }

  if (portraitStyle && (isPortrait || isPartialPerson)) return core;
  if (peopleIntent === 'partial') {
    const partialPrompt = buildRealisticImagePrompt(scene, {
      ...cfg,
      realistic: {
        ...(cfg.realistic || {}),
        noPeople: false,
        noFaces: true,
      },
    });
    return [
      partialPrompt,
      'Keep the requested body detail, hands, back view, silhouette, or environmental composition. Preserve non-face identity cues such as hair, clothing, build, and accessories when needed, but no visible or identifiable face is allowed anywhere and the image must not become a portrait or selfie.',
    ].join('\n');
  }
  return buildRealisticImagePrompt(scene, cfg);
}

export function buildRealisticNegativePrompt(config = {}, override = '') {
  const cfg = mergeConfig(config);
  return String(override ?? cfg.realistic?.negativePrompt ?? '').trim();
}

function applyRealisticNegativePrompt(prompt = '', config = {}, override = '') {
  const base = String(prompt || '').trim();
  const negative = buildRealisticNegativePrompt(config, override);
  if (!negative) return base;
  const marker = 'Avoid the following in the image:';
  if (base.includes(marker)) return base;
  return [base, `${marker} ${negative}`].filter(Boolean).join('\n');
}

function dataUrlToBlobUrl(dataUrl = '') {
  if (!String(dataUrl || '').startsWith('data:')) return dataUrl;
  return dataUrl;
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}

/**
 * 给 fetch 套一个超时，并能跟随外部 signal 一起取消。
 * 返回的 signal 在超时或外部取消时都会 abort，cleanup 用来清掉计时器/监听。
 */
function createTimeoutSignal(externalSignal, timeoutMs) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', onAbort);
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  };
  return { signal: ctrl.signal, cleanup };
}

const IMAGE_TOTAL_TIMEOUT_MS = 5 * 60_000;

/**
 * 生图请求默认只限制总时长。fetch 只有拿到响应头才会 resolve，无法可靠区分「尚未连接」
 * 与「服务端正在生成但还没返回响应头」；因此首响应超时仅供显式传入 connectTimeoutMs 的调用使用。
 */
export async function runImageRequestWithTimeout(request, options = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const externalSignal = options.signal;
  const requestedConnectTimeoutMs = Number(options.connectTimeoutMs);
  const connectTimeoutMs = Number.isFinite(requestedConnectTimeoutMs) && requestedConnectTimeoutMs > 0
    ? requestedConnectTimeoutMs
    : 0;
  const totalTimeoutMs = Math.max(connectTimeoutMs, Number(options.totalTimeoutMs) || IMAGE_TOTAL_TIMEOUT_MS);
  let timeoutStage = '';
  let connected = false;
  const abortForTimeout = (stage) => {
    if (controller.signal.aborted) return;
    timeoutStage = stage;
    controller.abort();
  };
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const connectTimer = connectTimeoutMs > 0
    ? setTimeout(() => abortForTimeout('connect'), connectTimeoutMs)
    : null;
  const totalTimer = setTimeout(() => abortForTimeout('total'), totalTimeoutMs);
  const markConnected = () => {
    if (connected) return;
    connected = true;
    if (connectTimer) clearTimeout(connectTimer);
  };
  try {
    return await request(controller.signal, markConnected);
  } catch (rawError) {
    if (!timeoutStage || externalSignal?.aborted) {
      if (rawError && typeof rawError === 'object' && rawError.requestElapsedMs == null) {
        rawError.requestElapsedMs = Date.now() - startedAt;
      }
      throw rawError;
    }
    const seconds = Math.round((timeoutStage === 'connect' ? connectTimeoutMs : totalTimeoutMs) / 1000);
    const nativeHint = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()
      ? ' APK 直连时请确认接口地址是完整的 http(s) 地址，并检查当前网络能否访问该中转。'
      : '';
    const error = new Error(timeoutStage === 'connect'
      ? `图片接口连接超时（${seconds} 秒内未建立响应）。请求可能已经送达服务端，结果未知；请先检查服务端生成记录，再决定是否重试。${nativeHint}`
      : `图片生成总时长超限（${seconds} 秒），已停止等待。请求可能仍在服务端处理，结果未知；请先检查服务端生成记录，再决定是否重试。${nativeHint}`);
    error.timeoutStage = timeoutStage;
    error.requestElapsedMs = Date.now() - startedAt;
    error.requestMayHaveReachedServer = true;
    error.replayBlocked = true;
    error.resultUnknown = true;
    error.cause = rawError;
    error.usedUrl = String(options.url || '');
    throw error;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

/** 远程生图 URL 常短时有效；拉取为 data URL 再写入 IndexedDB，翻记录仍可显示 */
const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;
const PERSIST_FETCH_TIMEOUT_MS = 20000;
const PERSIST_MAX_ATTEMPTS = 3;
// 与流式备份可完整保留的 data URL 上限对齐；压缩目标约 900KB，base64 后通常约 1.2MB。
const MAX_BACKUP_SAFE_IMAGE_DATA_URL_CHARS = 1_700_000;

function safeHttpOrigin(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
  } catch (_) {
    return '';
  }
}

function safeImageDownloadTarget(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    return `${parsed.protocol}//${parsed.host}`.slice(0, 300);
  } catch (_) {
    return '';
  }
}

function imagePersistErrorSummary(error) {
  if (!error) return '';
  const status = Number(error?.httpStatus || error?.status || 0);
  if (status >= 100) return `HTTP ${status}`;
  const message = String(error?.message || error || '').trim();
  if (!message) return '';
  if (/abort|取消/i.test(message)) return '请求已取消';
  if (/timeout|超时/i.test(message)) return '连接超时';
  if (/cors|failed to fetch|networkerror|load failed/i.test(message)) return '网络或跨域限制';
  return message.replace(/https?:\/\/[^\s，。；)]+/gi, '[图片地址]').slice(0, 120);
}

/**
 * 部分兼容中转把生成结果放在与 API 同源、仍需 Bearer Key 的临时地址上。
 * Key 只在图片地址与当前配置的请求端点同源时临时附带，不写入消息、日志或备份。
 */
async function resolveGeneratedImageDownloadContext(raw, options = {}) {
  const imageOrigin = safeHttpOrigin(raw);
  const explicitRequestUrl = String(options.requestUrl || '').trim();
  const explicitAuthorization = String(options.authorization || '').trim();
  if (
    imageOrigin
    && explicitAuthorization
    && safeHttpOrigin(explicitRequestUrl) === imageOrigin
  ) {
    return {
      requestUrl: explicitRequestUrl,
      authorization: explicitAuthorization,
      authApplied: true,
    };
  }
  if (!imageOrigin) return { requestUrl: '', authorization: '', authApplied: false };

  try {
    const cfg = mergeConfig(await loadImageToolConfig());
    const realisticRequestUrl = buildApiUrl(String(cfg.realistic?.endpoint || '').trim(), '/v1/images/generations');
    if (safeHttpOrigin(realisticRequestUrl) === imageOrigin) {
      const authorization = imageAuthHeaderValue(String(cfg.realistic?.apiKey || '').trim());
      return {
        requestUrl: realisticRequestUrl,
        authorization,
        authApplied: !!authorization,
      };
    }

    const novelTarget = resolveNovelAiRequestTarget(String(cfg.novelAi?.endpoint || '').trim())?.url || '';
    if (safeHttpOrigin(novelTarget) === imageOrigin) {
      const authorization = imageAuthHeaderValue(String(cfg.novelAi?.apiKey || '').trim());
      return {
        requestUrl: novelTarget,
        authorization,
        authApplied: !!authorization,
      };
    }
  } catch (_) {
    // 配置读取失败时仍继续走无鉴权下载与 Worker 兜底。
  }
  return { requestUrl: '', authorization: '', authApplied: false };
}

async function imageBlobToPersistentDataUrl(blob, options = {}) {
  if (!blob) throw new Error('empty image blob');
  if (blob.size > MAX_LOCAL_IMAGE_BYTES) {
    const tooLarge = new Error('image too large');
    tooLarge.tooLarge = true;
    throw tooLarge;
  }
  if (options.optimizeForStorage === true) {
    const optimized = await fileToOptimizedChatImageDataUrl(blob);
    const dataUrl = String(optimized?.dataUrl || '').trim();
    if (!dataUrl) throw new Error('image optimization returned empty data url');
    if (dataUrl.length > MAX_BACKUP_SAFE_IMAGE_DATA_URL_CHARS) {
      const tooLarge = new Error('optimized image remains too large');
      tooLarge.tooLarge = true;
      throw tooLarge;
    }
    return dataUrl;
  }
  return readBlobAsDataUrl(blob);
}

export async function persistGeneratedImageUrlLocally(url, options = {}) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) {
    if (options.optimizeForStorage !== true) return raw;
    try {
      const res = await fetch(raw);
      const blob = await res.blob();
      return await imageBlobToPersistentDataUrl(blob, options);
    } catch (e) {
      // 已经是可长期落库的本地 data URL；仅在体积超过备份安全线时拒绝静默保存。
      if (raw.length <= MAX_BACKUP_SAFE_IMAGE_DATA_URL_CHARS) return raw;
      if (options.requireLocal === true) {
        const err = new Error('生成图片过大且压缩失败，无法安全保存到本地，请降低生图尺寸后重试');
        err.cause = e;
        throw err;
      }
      return raw;
    }
  }
  const isBlobUrl = /^blob:/i.test(raw);
  if (!isBlobUrl && !/^https?:\/\//i.test(raw)) return raw;
  const downloadContext = !isBlobUrl
    ? await resolveGeneratedImageDownloadContext(raw, options)
    : { requestUrl: '', authorization: '', authApplied: false };
  const downloadHeaders = {
    Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
    ...(downloadContext.authorization ? { Authorization: downloadContext.authorization } : {}),
  };
  const persistDiagnostics = {
    target: safeImageDownloadTarget(raw),
    authApplied: downloadContext.authApplied === true,
    native: '',
    direct: '',
    proxy: '',
  };

  // APK WebView 的 fetch 会受 CORS / mixed-content 限制。用户自助生图要求必须本地化，
  // 旧实现会连续等三次 20 秒再失败；角色生图允许保留远程 URL，因而看起来反而正常。
  // 对 http(s) 图片先走原生二进制通道，成功后直接转成可长期落库的 data URL。
  if (!isBlobUrl && /^https?:\/\//i.test(raw)) {
    try {
      const nativeResult = await nativeHttpGetBytes(raw, {
        headers: downloadHeaders,
        signal: options.signal,
        connectTimeout: 60_000,
        readTimeout: 180_000,
      });
      const contentType = Object.entries(nativeResult.headers || {})
        .find(([key]) => String(key).toLowerCase() === 'content-type')?.[1] || '';
      const mime = imageMimeFromBytes(nativeResult.bytes, contentType);
      if (!mime || nativeResult.bytes.length <= 8) {
        throw new Error('生图地址没有返回有效图片数据');
      }
      const blob = new Blob([nativeResult.bytes], { type: mime });
      return await imageBlobToPersistentDataUrl(blob, options);
    } catch (nativeError) {
      if (nativeError?.name === 'AbortError') throw nativeError;
      persistDiagnostics.native = imagePersistErrorSummary(nativeError);
      // 网页/PWA 没有原生插件时继续走 fetch；原生偶发失败也保留 WebView 可直连的兜底。
    }
  }

  const fetchAsDataUrl = async (signal) => {
    const res = await fetch(raw, {
      method: 'GET',
      headers: downloadHeaders,
      // blob: 同源对象，不能带 cors 模式；跨域 http(s) 用 cors 才能读到字节
      mode: isBlobUrl ? undefined : 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const dataUrl = await imageBlobToPersistentDataUrl(blob, options);
    if (!dataUrl) throw new Error('empty data url');
    return dataUrl;
  };

  let lastErr = null;
  for (let attempt = 0; attempt < PERSIST_MAX_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) break;
    const { signal, cleanup } = createTimeoutSignal(options.signal, PERSIST_FETCH_TIMEOUT_MS);
    try {
      return await fetchAsDataUrl(signal);
    } catch (e) {
      lastErr = e;
      persistDiagnostics.direct = imagePersistErrorSummary(e);
      if (e?.tooLarge) {
        console.warn('[image-generation-tools] skip local persist: image too large');
        if (options.requireLocal === true) {
          const bytes = /^data:image\//i.test(raw) ? dataUrlApproxBytes(raw) : 0;
          const err = new Error(bytes > MAX_LOCAL_IMAGE_BYTES
            ? '生成图片超过 20MB，无法保存到本地，请调整尺寸后重试'
            : '生成图片压缩后仍然过大，无法安全保存和备份，请降低生图尺寸后重试');
          err.cause = e;
          throw err;
        }
        return raw;
      }
      // 外部主动取消（如离开页面）不再重试
      if (options.signal?.aborted) break;
      if (attempt < PERSIST_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    } finally {
      cleanup();
    }
  }

  // 网页/PWA 中有些签名图片允许 <img> 显示，却不开放 CORS，直接 fetch 无法读取字节。
  // 复用站内受限的公网 HTTPS 生图代理做最后一次下载，避免把可见图片误判成无法持久化。
  if (!isBlobUrl && /^https:\/\//i.test(raw) && !options.signal?.aborted) {
    try {
      const proxiedDataUrl = await downloadGeneratedImageViaWorker(raw, {
        requestUrl: downloadContext.requestUrl,
        authorization: downloadContext.authorization,
        signal: options.signal,
      });
      if (options.optimizeForStorage !== true) return proxiedDataUrl;
      const res = await fetch(proxiedDataUrl);
      const blob = await res.blob();
      return await imageBlobToPersistentDataUrl(blob, options);
    } catch (proxyError) {
      lastErr = proxyError;
      persistDiagnostics.proxy = imagePersistErrorSummary(proxyError);
    }
  }
  console.warn('[image-generation-tools] local persist failed, keeping remote URL (may expire)', lastErr);
  if (options.requireLocal === true) {
    const err = new Error('生成成功，但图片未能保存到本地，请重试');
    err.code = 'image_persist_failed';
    err.persistDiagnostics = persistDiagnostics;
    err.targetOrigin = persistDiagnostics.target;
    err.cause = lastErr;
    throw err;
  }
  return raw;
}

export async function generateRealisticImage(prompt, options = {}) {
  const cfg = mergeConfig(options.config || await loadImageToolConfig());
  if (!['openai_compatible', 'openai_chat', 'google_gemini'].includes(cfg.realisticProvider) || !cfg.realistic.enabled) {
    throw new Error('兼容生图未启用');
  }
  const endpoint = String(cfg.realistic.endpoint || '').trim();
  if (!cfg.realistic.apiKey) throw new Error('缺少兼容生图 API Key');
  const model = String(options.model || cfg.realistic.model || '').trim();
  if (!model) throw new Error('缺少兼容生图模型');
  let builtPrompt = options.promptAssembly === 'none'
    ? String(prompt || '').trim()
    : assembleRealisticPrompt(prompt, cfg, options);
  const enforceNaiCharset = options.enforceNovelAiCharset === true
    || looksLikeNovelAiModel(model)
    || /novelai|\/nai(?:\/|$)/i.test(endpoint);
  // 兼容栏填了 NovelAI 模型/中转时，清掉中文与全角，避免中转直接 400
  let finalPrompt = applyRealisticNegativePrompt(builtPrompt, cfg, options.negativePrompt);
  if (enforceNaiCharset) {
    finalPrompt = prepareNovelAiPromptText(finalPrompt, '提示词');
  }
  if (cfg.realisticProvider === 'google_gemini') {
    return requestGoogleGeminiImage(finalPrompt, cfg, model, options);
  }
  if (cfg.realisticProvider === 'openai_chat') {
    return requestOpenAiChatImage(finalPrompt, cfg, model, options);
  }
  const baseBody = {
    model,
    prompt: finalPrompt,
    size: normalizeOpenAiImageSize(options.size || cfg.realistic.size || '1024x1024', '1024x1024'),
    n: 1,
  };
  if (options.quality || cfg.realistic.quality) baseBody.quality = options.quality || cfg.realistic.quality;
  const url = buildApiUrl(endpoint, '/v1/images/generations');

  const requestOnce = async (responseFormat) => {
    const body = { ...baseBody };
    if (responseFormat) body.response_format = responseFormat;
    const payload = JSON.stringify(body);
    const requestTarget = (target) => runImageRequestWithTimeout(async (signal, markConnected) => {
      const res = await fetch(target, {
        method: 'POST',
        headers: imageHeaders(cfg),
        body: payload,
        signal,
      });
      markConnected();
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const detail = formatImageHttpErrorDetail(res.status, text || res.statusText || '');
        const err = new Error(`Image generation failed (${res.status}): ${detail}`);
        err.httpStatus = res.status;
        if (/中文|全角|CJK|英文标签/.test(detail)) err.code = 'NOVELAI_CJK_PROMPT';
        throw err;
      }
      const data = await res.json();
      return { url: dataUrlToBlobUrl(extractGeneratedImageUrl(data)), raw: data };
    }, {
      signal: options.signal,
      connectTimeoutMs: options.connectTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      url: target,
    });
    try {
      return await requestTarget(url);
    } catch (e) {
      const wrapped = wrapNetworkError(e, url);
      // 生图 POST 可能已经在服务端完成；不透明网络错误不能证明请求未送达。
      throw wrapped;
    }
  };

  // 单次请求：默认取 base64；线路不支持时直接报告，由用户调整格式或端点后重试。
  const explicitFormat = String(options.responseFormat ?? cfg.realistic.responseFormat ?? '').trim();
  try {
    return await requestOnce(explicitFormat || 'b64_json');
  } catch (error) {
    const detail = String(error?.message || error || '');
    const explicitlyNeedsChatImage = /not supported model for image generation|only imagen models are supported/i.test(detail);
    if (explicitlyNeedsChatImage && /gemini/i.test(model)) {
      return requestOpenAiChatImage(finalPrompt, cfg, model, options);
    }
    throw error;
  }
}

export async function fetchRealisticImageModelsWithError(options = {}) {
  const cfg = mergeConfig(options.config || await loadImageToolConfig());
  const endpoint = String(options.endpoint || cfg.realistic.endpoint || '').trim();
  const apiKey = String(options.apiKey || cfg.realistic.apiKey || '').trim();
  const workCfg = {
    ...cfg,
    realisticProvider: options.provider || cfg.realisticProvider,
    realistic: {
      ...(cfg.realistic || {}),
      endpoint,
      apiKey,
    },
  };
  const url = workCfg.realisticProvider === 'google_gemini'
    ? buildGoogleGeminiModelsUrl(endpoint)
    : buildApiUrl(endpoint, '/v1/models');
  const fallbackUrl = '/api/v1/models';
  const tryFetchModels = async (target) => {
    const res = await fetch(target, {
      headers: imageHeaders(workCfg, { json: false }),
      signal: options.signal,
    });
    const data = await parseImageApiJsonResponse(res);
    if (workCfg.realisticProvider === 'google_gemini') {
      const models = Array.isArray(data?.models)
        ? data.models.filter((item) => !Array.isArray(item?.supportedGenerationMethods)
          || item.supportedGenerationMethods.includes('generateContent'))
        : [];
      return [...new Set(models.map(normalizeImageModelId).map((id) => id.replace(/^models\//i, '')).filter(Boolean))].sort();
    }
    return extractImageModelList(data);
  };
  let lastError = '';
  try {
    try {
      const models = await tryFetchModels(url);
      return {
        models,
        error: models.length ? '' : '接口返回成功，但没有识别到模型列表',
        url,
      };
    } catch (e) {
      const wrapped = wrapNetworkError(e, url, { replayRisk: false });
      lastError = wrapped?.message || String(wrapped || '拉取失败');
      if (workCfg.realisticProvider !== 'google_gemini'
        && fallbackUrl !== url
        && shouldRetryImageProxy(url, wrapped, { sideEffectFree: true })) {
        const models = await tryFetchModels(fallbackUrl);
        return {
          models,
          error: models.length ? '' : '代理返回成功，但没有识别到模型列表',
          url: fallbackUrl,
        };
      } else {
        throw wrapped;
      }
    }
  } catch (e) {
    lastError = e?.message || lastError || String(e || '拉取失败');
    console.error('[image-generation-tools] fetch models failed:', e);
    return { models: [], error: lastError, url };
  }
}

export async function fetchRealisticImageModels(options = {}) {
  const result = await fetchRealisticImageModelsWithError(options);
  return result.models || [];
}

export async function testRealisticImageGeneration(options = {}) {
  try {
    const cfg = mergeConfig(options.config || await loadImageToolConfig());
    const prompt = options.prompt || 'A plain white ceramic mug on a desk beside a closed notebook, casual phone snapshot, natural indoor light.';
    const result = await generateRealisticImage(prompt, {
      config: cfg,
      model: options.model || cfg.realistic?.model,
      size: options.size || cfg.realistic?.size || '1024x1024',
      signal: options.signal,
    });
    if (!result?.url) throw new Error('生图接口返回成功，但没有图片 URL 或 base64 数据');
    return {
      ok: true,
      url: result.url,
      model: options.model || cfg.realistic?.model || '',
      size: options.size || cfg.realistic?.size || '1024x1024',
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e || '生图测试失败'),
      // API 管理页需要原始错误上的网络阶段、耗时与结果未知标记来选择正确的排障说明。
      // 只返回 message 会把长连接中断误归类为“未抽到可用正文”。
      errorObject: e instanceof Error ? e : new Error(String(e || '生图测试失败')),
    };
  }
}

/* ===================== 参考图（角色锁脸公共工具）===================== */

/** NovelAI Vibe Transfer 参考图压缩：官方/中转对请求体大小都敏感，生图结果常为 832×1216 PNG，原样 base64 极易 500 */
const NAI_REF_MAX_EDGE = 640;
const NAI_REF_MIN_EDGE = 320;
const NAI_REF_INLINE_MAX_BYTES = 120 * 1024;
const NAI_REF_TARGET_MAX_BYTES = 200 * 1024;

/** 计算参考图等比完整放入目标画布的位置；留白用于补足生成画幅，避免拉伸人物五官。 */
export function resolveContainedImagePlacement(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sw = Math.max(1, Number(sourceWidth) || 1);
  const sh = Math.max(1, Number(sourceHeight) || 1);
  const tw = Math.max(1, Math.round(Number(targetWidth) || 1));
  const th = Math.max(1, Math.round(Number(targetHeight) || 1));
  const scale = Math.min(tw / sw, th / sh);
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  return {
    x: Math.round((tw - width) / 2),
    y: Math.round((th - height) / 2),
    width,
    height,
  };
}

function novelAiRefCanvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (!canvas?.toBlob) {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function novelAiRefLoadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function compressBlobForNovelAiReference(blob) {
  if (!blob) return blob;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await novelAiRefLoadImage(objectUrl);
    const originalWidth = Number(img.naturalWidth || img.width || 0);
    const originalHeight = Number(img.naturalHeight || img.height || 0);
    if (!originalWidth || !originalHeight) return blob;
    const maxDim = Math.max(originalWidth, originalHeight);
    const needsCompress = blob.size > NAI_REF_INLINE_MAX_BYTES || maxDim > NAI_REF_MAX_EDGE;
    if (!needsCompress) return blob;

    let maxEdge = NAI_REF_MAX_EDGE;
    let bestBlob = null;
    let bestBytes = Infinity;
    while (maxEdge >= NAI_REF_MIN_EDGE) {
      const scale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));
      const width = Math.max(1, Math.round(originalWidth * scale));
      const height = Math.max(1, Math.round(originalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) break;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      const next = await novelAiRefCanvasToBlob(canvas, 'image/png');
      if (next) {
        if (next.size < bestBytes) {
          bestBlob = next;
          bestBytes = next.size;
        }
        if (next.size <= NAI_REF_TARGET_MAX_BYTES) return next;
      }
      maxEdge = Math.floor(maxEdge * 0.78);
    }
    return bestBlob || blob;
  } catch (e) {
    console.warn('[image-generation-tools] NovelAI 参考图压缩失败，使用原图', e);
    return blob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** 把 data:/blob:/http(s): 形式的图片地址读成 Blob，供参考图上传/编码使用 */
async function resolveImageBytesFromUrl(url, signal) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  if (/^data:image\//i.test(raw) || /^blob:/i.test(raw)) {
    const res = await fetch(raw, { signal });
    if (!res.ok) throw new Error(`参考图读取失败 (${res.status})`);
    return res.blob();
  }
  if (/^https?:\/\//i.test(raw)) {
    const res = await fetch(raw, { mode: 'cors', credentials: 'omit', signal });
    if (!res.ok) throw new Error(`参考图获取失败 (${res.status})`);
    return res.blob();
  }
  // 内置头像、已落地网页资源及 APK WebView 资源可能是相对地址或自定义协议。
  // 过去这里直接返回 null，多人锁脸时就可能只剩 data URL 形式的用户参考图。
  try {
    const res = await fetch(raw, { signal });
    if (!res.ok) throw new Error(`参考图读取失败 (${res.status})`);
    return res.blob();
  } catch (error) {
    const wrapped = new Error(`不支持或无法读取参考图地址：${raw.slice(0, 120)}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

/** 把参考图 URL 列表转为不含 data: 前缀的 base64（供 NovelAI Vibe Transfer 使用） */
async function convertRefImagesToBase64(urls = [], signal) {
  const list = [];
  for (const u of (Array.isArray(urls) ? urls : [urls]).slice(0, MAX_REFERENCE_IMAGES)) {
    const blob = await resolveImageBytesFromUrl(u, signal);
    if (!blob) continue;
    const compressed = await compressBlobForNovelAiReference(blob);
    const dataUrl = await readBlobAsDataUrl(compressed);
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
    if (base64) list.push(base64);
  }
  return list;
}

function referenceBase64DataUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw || /^data:image\//i.test(raw)) return raw;
  let mime = 'image/png';
  if (/^\/9j\//.test(raw)) mime = 'image/jpeg';
  else if (/^UklGR/.test(raw)) mime = 'image/webp';
  return `data:${mime};base64,${raw}`;
}

/**
 * OpenAI Chat 形态的 NAI 中转通常把参考图当作普通 i2i.image，且严格要求其像素尺寸
 * 与 size 一致。仅该传输分支使用此适配；官方 NAI Vibe / encode-vibe 继续使用小图编码。
 */
async function prepareNovelAiI2iReferenceList(rawList = [], width, height, signal) {
  const targetWidth = Math.max(1, Math.round(Number(width) || 1));
  const targetHeight = Math.max(1, Math.round(Number(height) || 1));
  const prepared = [];
  for (const raw of (Array.isArray(rawList) ? rawList : []).slice(0, MAX_REFERENCE_IMAGES)) {
    if (signal?.aborted) {
      const error = new Error('参考图处理已取消');
      error.name = 'AbortError';
      throw error;
    }
    const img = await novelAiRefLoadImage(referenceBase64DataUrl(raw));
    const sourceWidth = Number(img.naturalWidth || img.width || 0);
    const sourceHeight = Number(img.naturalHeight || img.height || 0);
    if (!sourceWidth || !sourceHeight) throw new Error('无法读取锁脸参考图尺寸');
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('当前浏览器无法调整锁脸参考图尺寸');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    const placement = resolveContainedImagePlacement(
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
    );
    ctx.drawImage(img, placement.x, placement.y, placement.width, placement.height);
    const blob = await novelAiRefCanvasToBlob(canvas, 'image/jpeg', 0.9);
    const dataUrl = blob
      ? await readBlobAsDataUrl(blob)
      : canvas.toDataURL('image/jpeg', 0.9);
    if (!dataUrl) throw new Error('锁脸参考图尺寸调整结果为空');
    prepared.push(dataUrl);
  }
  return prepared;
}

/** 把 data:/blob: 肖像图压到适合 NovelAI Vibe Transfer 的体积，供通讯录头像/锁定参考图落库前使用 */
export async function optimizeImageDataUrlForNovelAiReference(dataUrl = '', signal) {
  const raw = String(dataUrl || '').trim();
  if (!raw || !/^data:image\//i.test(raw)) return raw;
  const blob = await resolveImageBytesFromUrl(raw, signal);
  if (!blob) return raw;
  const compressed = await compressBlobForNovelAiReference(blob);
  if (!compressed || compressed === blob) return raw;
  return readBlobAsDataUrl(compressed);
}

function referenceIdentityError(provider, cause) {
  const detail = String(cause?.message || cause || '参考图未提交').slice(0, 260);
  const error = new Error(`锁脸参考图未能提交到${provider === 'novelai' ? ' NovelAI' : '兼容生图'}：${detail}`);
  error.code = 'IMAGE_REFERENCE_REQUIRED';
  error.referenceIdentityFailure = true;
  error.provider = provider;
  error.cause = cause;
  return error;
}

function referenceSubjectText(subject = {}, index = 0) {
  const label = String(subject?.label || subject?.name || '').trim();
  const id = String(subject?.id || subject?.subjectId || '').trim();
  if (label && id && label !== id) return `${label}（${id}）`;
  return label || id || `第 ${index + 1} 位人物`;
}

async function resolveRealisticReferenceInputs(urls = [], options = {}) {
  const subjects = Array.isArray(options.referenceSubjects)
    ? options.referenceSubjects.slice(0, urls.length)
    : [];
  const rows = await Promise.all(urls.map(async (url, index) => {
    const subject = subjects[index] || {};
    try {
      const blob = await resolveImageBytesFromUrl(url, options.signal);
      if (!blob) throw new Error('没有读取到图片内容');
      return { index, subject, blob, error: null };
    } catch (error) {
      return { index, subject, blob: null, error };
    }
  }));
  const failed = rows.filter((row) => !row.blob);
  if (failed.length) {
    const names = failed.map((row) => referenceSubjectText(row.subject, row.index)).join('、');
    const detail = failed
      .map((row) => String(row.error?.message || row.error || '').trim())
      .filter(Boolean)
      .join('；')
      .slice(0, 220);
    throw new Error(`以下人物的锁脸参考图读取失败：${names}${detail ? `。${detail}` : ''}`);
  }
  return rows;
}

export function assertCompleteReferenceSubmission(result = {}, options = {}) {
  if (options.requireReferenceIdentity !== true) return result;
  const expectedCount = Math.max(
    0,
    Number(options.expectedReferenceCount)
      || (Array.isArray(options.refImageUrls) ? options.refImageUrls.filter(Boolean).length : 0),
  );
  if (!expectedCount) return result;
  const actualCount = Math.max(0, Number(result?.referenceSubmittedCount) || 0);
  if (actualCount !== expectedCount) {
    throw referenceIdentityError(
      String(result?.provider || options.provider || ''),
      new Error(`预计提交 ${expectedCount} 张人物参考图，实际只提交 ${actualCount} 张`),
    );
  }
  const expectedIds = (Array.isArray(options.expectedReferenceSubjectIds)
    ? options.expectedReferenceSubjectIds
    : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const actualIds = (Array.isArray(result?.referenceSubmittedSubjectIds)
    ? result.referenceSubmittedSubjectIds
    : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const provider = String(result?.provider || options.provider || '').trim();
  if (expectedIds.length && (actualIds.length || provider === 'realistic')) {
    const sameOrder = expectedIds.length === actualIds.length
      && expectedIds.every((id, index) => id === actualIds[index]);
    if (!sameOrder) {
      throw referenceIdentityError(
        String(result?.provider || options.provider || ''),
        new Error(`人物参考图映射不完整：预计 ${expectedIds.join('、')}，实际 ${actualIds.join('、')}`),
      );
    }
  }
  return result;
}

/** 参考图编辑接口（gpt-image-1 等）常见报错的中文提示 */
function realisticEditHttpHint(status) {
  if (status === 404) return '提示：该中转/模型可能不支持 /v1/images/edits（参考图编辑），确认模型是 gpt-image-1 等支持图片编辑的模型，或换一个支持编辑接口的中转。';
  if (status === 400) return '提示：部分中转对参考图格式/大小有要求（常见需 PNG 且不超过几 MB），或该模型不支持图片编辑。';
  if (status === 401 || status === 403) return '提示：Key 无效或无权限。';
  if (status === 429) return '提示：请求过于频繁或并发受限，稍后再试。';
  if (status >= 500) return '提示：上游服务器错误，可能是中转故障，稍后重试或更换中转。';
  return '';
}

/**
 * 参考图编辑生图（OpenAI 兼容 /v1/images/edits，如 gpt-image-1）：
 * 传入一张或多张人物基准形象图作为参考，让新图尽量保持对应身份（软锁脸，无 seed 概念）。
 */
export async function generateRealisticImageEdit(prompt, refImageUrls = [], options = {}) {
  const cfg = mergeConfig(options.config || await loadImageToolConfig());
  if (!['openai_compatible', 'openai_chat', 'google_gemini'].includes(cfg.realisticProvider) || !cfg.realistic.enabled) {
    throw new Error('兼容生图未启用');
  }
  const endpoint = String(cfg.realistic.endpoint || '').trim();
  if (!cfg.realistic.apiKey) throw new Error('缺少兼容生图 API Key');
  const model = String(options.model || cfg.realistic.model || '').trim();
  if (!model) throw new Error('缺少兼容生图模型');

  const urls = (Array.isArray(refImageUrls) ? refImageUrls : [refImageUrls])
    .filter(Boolean)
    .slice(0, MAX_REFERENCE_IMAGES);
  if (!urls.length) throw new Error('缺少参考图');
  const referenceInputs = await resolveRealisticReferenceInputs(urls, options);
  const blobs = referenceInputs.map((row) => row.blob);
  const referenceSubmittedSubjectIds = referenceInputs
    .map((row) => String(row.subject?.id || row.subject?.subjectId || '').trim())
    .filter(Boolean);
  if (cfg.realisticProvider === 'google_gemini') {
    const imageParts = [];
    for (const blob of blobs) {
      const dataUrl = await readBlobAsDataUrl(blob);
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) continue;
      imageParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    if (!imageParts.length) throw new Error('参考图编码失败');
    const result = await requestGoogleGeminiImage(
      applyRealisticNegativePrompt(String(prompt || '').trim(), cfg, options.negativePrompt),
      cfg,
      model,
      options,
      imageParts,
    );
    return {
      ...result,
      referenceSubmittedCount: imageParts.length,
      referenceSubmittedSubjectIds,
    };
  }
  if (cfg.realisticProvider === 'openai_chat') {
    const imageUrls = [];
    for (const blob of blobs) imageUrls.push(await readBlobAsDataUrl(blob));
    const result = await requestOpenAiChatImage(
      applyRealisticNegativePrompt(String(prompt || '').trim(), cfg, options.negativePrompt),
      cfg,
      model,
      options,
      imageUrls,
    );
    return {
      ...result,
      referenceSubmittedCount: imageUrls.length,
      referenceSubmittedSubjectIds,
    };
  }

  const buildEditForm = (imageField) => {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', applyRealisticNegativePrompt(String(prompt || '').trim(), cfg, options.negativePrompt));
    form.append('size', options.size || cfg.realistic.size || '1024x1024');
    form.append('n', '1');
    const responseFormat = String(options.responseFormat ?? cfg.realistic.responseFormat ?? '').trim();
    if (['url', 'b64_json'].includes(responseFormat)) form.append('response_format', responseFormat);
    blobs.forEach((blob, index) => {
      form.append(imageField, blob, `reference-${index + 1}.png`);
    });
    // GPT Image 2 会自动对每张输入图做高保真处理，且不接受 input_fidelity；
    // 旧 GPT Image 模型则显式开 high，避免默认 low 导致人脸特征丢失。
    if (/^(?:gpt-image-(?:1(?:\.5)?)(?:$|-)|chatgpt-image-latest$)/i.test(model)) {
      form.append('input_fidelity', String(options.inputFidelity || 'high'));
    }
    return form;
  };

  const url = buildApiUrl(endpoint, '/v1/images/edits');
  const headers = imageHeaders(cfg, { json: false });

  const requestOnce = async (target, imageField) => runImageRequestWithTimeout(async (signal, markConnected) => {
    const form = buildEditForm(imageField);
    const res = await fetch(target, { method: 'POST', headers, body: form, signal });
    markConnected();
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const hint = realisticEditHttpHint(res.status);
      const err = new Error(`参考图编辑生图失败 (${res.status})：${text || res.statusText}${hint ? `\n${hint}` : ''}`);
      err.httpStatus = res.status;
      err.responseText = text;
      throw err;
    }
    const data = await res.json();
    return {
      url: dataUrlToBlobUrl(extractGeneratedImageUrl(data)),
      raw: data,
      referenceSubmittedCount: blobs.length,
      referenceSubmittedSubjectIds,
    };
  }, {
    signal: options.signal,
    connectTimeoutMs: options.connectTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    url: target,
  });

  try {
    // 多图使用重复的 image 字段，一次请求同时兼容 OpenAI 与常见中转。
    return await requestOnce(url, 'image');
  } catch (e) {
    const wrapped = wrapNetworkError(e, url);
    // 图片编辑同样可能已在服务端完成，不能因不透明网络错误自动再生成一次。
    throw wrapped;
  }
}

/* ===================== NovelAI 原生生图 ===================== */

export function buildNovelAiPrompt(prompt = '', config = {}) {
  const cfg = mergeConfig(config);
  const base = String(prompt || '').trim();
  const template = String(cfg.novelAi?.promptTemplate || '').trim();
  if (template) {
    return template.includes('{prompt}')
      ? template.replace(/\{prompt\}/g, base)
      : [template, base].filter(Boolean).join(', ');
  }
  const prefix = String(cfg.novelAi?.promptPrefix || '').trim();
  const suffix = String(cfg.novelAi?.promptSuffix || '').trim() || NOVELAI_DEFAULT_QUALITY;
  return [prefix, base, suffix].filter(Boolean).join(', ');
}

export function buildNovelAiNegativePrompt(config = {}, override = '') {
  const cfg = mergeConfig(config);
  const value = String(override || cfg.novelAi?.negativePrompt || '').trim();
  return value || NOVELAI_DEFAULT_NEGATIVE;
}

/**
 * NovelAI / 部分中转不允许 prompt 含 CJK 或全角字符。
 * 覆盖：CJK 标点区、假名、汉字、韩文、兼容汉字、全角 ASCII 区。
 * 注意：检测用无 g；替换必须带 g，否则只会去掉第一个非法字符。
 */
const NOVELAI_FORBIDDEN_CHAR_CLASS = '\\u3000-\\u303F\\u3040-\\u30FF\\u3400-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF00-\\uFFEF';
const NOVELAI_FORBIDDEN_CHAR_RE = new RegExp(`[${NOVELAI_FORBIDDEN_CHAR_CLASS}]`);
const NOVELAI_FORBIDDEN_CHAR_RE_G = new RegExp(`[${NOVELAI_FORBIDDEN_CHAR_CLASS}]`, 'g');

export const NOVELAI_CJK_PROMPT_HINT = 'NovelAI 提示词只能用英文标签与半角标点，不能含中文/日文/韩文或全角字符。'
  + '请把「生图外观描述」、锁定提示词、改词重画内容、正负向前缀改成英文 Danbooru 标签；中文逗号「，」也要换成英文「,」。';

const NOVELAI_TRIAL_RECAPTCHA_HINT = '当前 Key 对应的 NovelAI 账号正在使用免费试用，官方要求先在网页完成 reCAPTCHA，应用内无法代填验证码。'
  + '请换用有有效付费订阅的 NovelAI 账号 Key，或改用支持生图的中转。';

/** 判断模型名是否像 NovelAI（兼容生图栏也可能填 nai-diffusion-*） */
export function looksLikeNovelAiModel(model = '') {
  return /nai-diffusion|novelai|\bnai[_-]?v?\d|\bnai\b/i.test(String(model || '').trim());
}

/** 全角 ASCII / 常见 CJK 标点 → 半角，避免「1girl，long hair」被中转拒掉 */
export function normalizeNovelAiPromptCharset(text = '') {
  let s = String(text || '');
  s = s.replace(/\u3000/g, ' ');
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[、，]/g, ',');
  s = s.replace(/[。．]/g, '.');
  s = s.replace(/[：]/g, ':');
  s = s.replace(/[；]/g, ';');
  s = s.replace(/[！]/g, '!');
  s = s.replace(/[？]/g, '?');
  s = s.replace(/[（]/g, '(');
  s = s.replace(/[）]/g, ')');
  s = s.replace(/[「『【［]/g, '[');
  s = s.replace(/[」』】］]/g, ']');
  s = s.replace(/[—－]/g, '-');
  s = s.replace(/[・·]/g, ' ');
  s = s.replace(/\s*,\s*/g, ', ');
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim();
}

export function novelAiPromptHasForbiddenCharset(text = '') {
  return NOVELAI_FORBIDDEN_CHAR_RE.test(String(text || ''));
}

/**
 * 归一化全角后，若仍有 CJK 则剥掉 CJK 片段，保留英文标签。
 * 纯中文外观描述会被剥成空串，由调用方给出明确报错。
 */
export function scrubNovelAiPromptCharset(text = '') {
  let s = normalizeNovelAiPromptCharset(text);
  if (!novelAiPromptHasForbiddenCharset(s)) return s;
  s = s.replace(NOVELAI_FORBIDDEN_CHAR_RE_G, ' ');
  s = s.replace(/\s*,\s*/g, ', ');
  s = s.replace(/(?:,\s*){2,}/g, ', ');
  s = s.replace(/^[,\s]+|[,\s]+$/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

/** 准备最终下发的 NovelAI prompt；剥光后过短则抛出可操作的中文错误 */
export function prepareNovelAiPromptText(text = '', label = '提示词') {
  const scrubbed = scrubNovelAiPromptCharset(text);
  if (novelAiPromptHasForbiddenCharset(scrubbed) || scrubbed.length < 3) {
    const err = new Error(`${label}含有中文或全角字符，且去掉后没有足够的英文标签可用。${NOVELAI_CJK_PROMPT_HINT}`);
    err.code = 'NOVELAI_CJK_PROMPT';
    throw err;
  }
  return scrubbed;
}

function extractImageApiErrorMessage(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const data = JSON.parse(raw);
    const nested = data?.error;
    const msg = (typeof nested === 'string' ? nested : '')
      || nested?.message
      || data?.message
      || data?.msg
      || data?.detail
      || '';
    if (msg) return String(msg).trim();
  } catch (_) {
    // 非 JSON 原文直接用
  }
  return raw;
}

function formatImageHttpErrorDetail(status, text, { novelAi = false } = {}) {
  const detail = extractImageApiErrorMessage(text);
  if (/recaptcha token is required for trial generation/i.test(detail)) {
    return NOVELAI_TRIAL_RECAPTCHA_HINT;
  }
  if (/不能包含中文|CJK|全角字符|改用英文提示词|english prompts?/i.test(detail)) {
    return NOVELAI_CJK_PROMPT_HINT;
  }
  const short = detail.slice(0, 220);
  if (novelAi) {
    return short || String(text || '').slice(0, 200) || 'request failed';
  }
  return short || String(text || '').slice(0, 200) || 'request failed';
}

function resolveNovelAiSize(value = '') {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{2,4})\s*[x×*]\s*(\d{2,4})$/i);
  if (m) {
    return { width: Number(m[1]), height: Number(m[2]) };
  }
  return { width: 832, height: 1216 };
}

/** 本站同源代理：地址留空或填官方域名时优先走这里，避免浏览器直连官方被 CORS 拦 */
const NOVELAI_SAME_ORIGIN_GENERATE = '/api/ai/generate-image';
const NOVELAI_SAME_ORIGIN_ENCODE_VIBE = '/api/ai/encode-vibe';

function absolutizeImageEndpoint(endpoint = '') {
  const raw = String(endpoint || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw.replace(/\/+$/, '');
  return `https://${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function isNovelAiOfficialHost(endpoint = '') {
  const raw = String(endpoint || '').trim();
  if (!raw) return false;
  try {
    const abs = absolutizeImageEndpoint(raw);
    if (abs.startsWith('/')) return false;
    return new URL(abs).hostname.toLowerCase() === 'image.novelai.net';
  } catch (_) {
    return false;
  }
}

/**
 * 解析 NovelAI 请求目标：
 * - native：官方 / 自建 /ai/generate-image（zip 或 JSON 图）
 * - openai_chat：空悲切等 OpenAI 兼容中转，走 /v1/chat/completions，返回 markdown Data URI
 * - openai_images：仅基础文生图，走 /v1/images/generations
 *
 * 地址留空或官方域名：直接走本站 `/api/ai/generate-image`（不先打官方再失败重放，避免双扣费）。
 */
export function resolveNovelAiRequestTarget(endpoint = '') {
  const raw = String(endpoint || '').trim();
  if (!raw || isNovelAiOfficialHost(raw)) {
    return { transport: 'native', url: NOVELAI_SAME_ORIGIN_GENERATE };
  }
  const abs = absolutizeImageEndpoint(raw);
  let pathname = '';
  try {
    pathname = new URL(abs.startsWith('/') ? `https://_local_${abs}` : abs).pathname.replace(/\/+$/, '') || '/';
  } catch (_) {
    pathname = '/';
  }

  if (/\/ai\/generate-image$/i.test(pathname)) {
    return { transport: 'native', url: abs };
  }
  if (/\/v1\/images\/generations$/i.test(pathname)) {
    return { transport: 'openai_images', url: abs };
  }
  if (/\/v1\/chat\/completions$/i.test(pathname)) {
    return { transport: 'openai_chat', url: abs };
  }
  if (/\/v1$/i.test(pathname)) {
    return { transport: 'openai_chat', url: `${abs}/chat/completions` };
  }
  // 部分 NovelAI 中转把 /api 作为 OpenAI Images Base URL，由客户端补全生图路径。
  // 不能把 /api 直接当作原生 NovelAI 端点 POST，否则这类站点只会返回 404。
  if (/\/api$/i.test(pathname)) {
    return { transport: 'openai_images', url: `${abs}/v1/images/generations` };
  }
  // 带自定义路径的完整端点（如 /api/v1/novelai）→ 原生 payload 直打
  if (pathname && pathname !== '/') {
    return { transport: 'native', url: abs };
  }
  // 站点根：默认按官方约定拼 /ai/generate-image
  return { transport: 'native', url: `${abs}/ai/generate-image` };
}

export function isNovelAiOpenAiCompatibleTransport(endpoint = '') {
  const transport = resolveNovelAiRequestTarget(endpoint).transport;
  return transport === 'openai_chat' || transport === 'openai_images';
}

/**
 * 官方协议形态的自定义中转可能只实现 OpenAI Chat 绘图：
 * 普通生图会在 /ai/generate-image 404 后发现它，但参考图在更早的 encode-vibe 阶段就会失败。
 * 这里只为第三方地址推导等价的 /v1/chat/completions；官方地址不做猜测。
 */
export function resolveNovelAiOpenAiChatFallbackUrl(endpoint = '') {
  const raw = String(endpoint || '').trim();
  if (!raw) return '';
  const abs = absolutizeImageEndpoint(raw);
  let url;
  try {
    url = new URL(abs);
  } catch (_) {
    return '';
  }
  if (url.hostname.toLowerCase() === 'image.novelai.net') return '';

  let pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (/\/v1\/chat\/completions$/i.test(pathname)) return url.href.replace(/\/+$/, '');
  if (/\/v1$/i.test(pathname)) {
    url.pathname = `${pathname}/chat/completions`;
    return url.href.replace(/\/+$/, '');
  }
  if (/\/ai\/generate-image$/i.test(pathname)) {
    pathname = pathname.replace(/\/ai\/generate-image$/i, '');
    url.pathname = `${pathname}/v1/chat/completions`.replace(/\/{2,}/g, '/');
    return url.href.replace(/\/+$/, '');
  }
  // 只有站点根能安全猜测；任意自定义路径可能属于用户自己的原生协议网关。
  if (pathname !== '/') return '';
  url.pathname = '/v1/chat/completions';
  return url.href.replace(/\/+$/, '');
}

function buildNovelAiUrl(endpoint = '') {
  return resolveNovelAiRequestTarget(endpoint).url;
}

/**
 * 推导与 generate 同站点的 encode-vibe 路径。
 * - 留空 / 官方域名 → 本站同源代理
 * - 无法从自定义路径安全推导时返回空串（由上层跳过参考图，禁止回落到 image.novelai.net）
 */
export function resolveNovelAiEncodeVibeUrl(endpoint = '') {
  const raw = String(endpoint || '').trim();
  if (!raw || isNovelAiOfficialHost(raw)) return NOVELAI_SAME_ORIGIN_ENCODE_VIBE;

  const generateUrl = buildNovelAiUrl(raw);
  if (/\/ai\/generate-image$/i.test(generateUrl)) {
    return generateUrl.replace(/\/ai\/generate-image$/i, '/ai/encode-vibe');
  }
  const clean = generateUrl.replace(/\/+$/, '');
  if (/\/ai\//i.test(clean)) return clean.replace(/\/ai\/[^/]+$/i, '/ai/encode-vibe');
  return '';
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** V4+ 官方要求先 encode-vibe；同图同参数会话内缓存，避免重复扣 Anlas */
const novelAiVibeEncodeCache = new Map();

async function encodeNovelAiVibe(imageBase64, model, infoExtracted, cfg, signal) {
  const img = String(imageBase64 || '').trim();
  if (!img) throw new Error('缺少参考图数据');
  const cacheKey = `${model}|${infoExtracted}|${img.length}|${img.slice(0, 80)}`;
  const cached = novelAiVibeEncodeCache.get(cacheKey);
  if (cached) return cached;

  const primaryUrl = resolveNovelAiEncodeVibeUrl(cfg.novelAi?.endpoint);
  if (!primaryUrl) {
    const err = new Error('当前 NovelAI 地址无法推导参考图编码接口，已跳过参考图锁定');
    err.code = 'NOVELAI_ENCODE_UNAVAILABLE';
    throw err;
  }
  const body = JSON.stringify({
    image: img,
    information_extracted: infoExtracted,
    model,
  });
  const headers = {
    ...novelAiHeaders(cfg),
    Accept: 'application/json, application/octet-stream, application/binary, application/x-zip-compressed',
  };

  const requestTarget = (target) => {
    const networkTarget = resolveNovelAiNetworkTarget(target);
    return runImageRequestWithTimeout(async (requestSignal, markConnected) => {
    const res = await fetch(networkTarget, {
      method: 'POST',
      headers: { ...headers, ...novelAiHeaders(cfg, networkTarget) },
      body,
      signal: requestSignal,
    });
    markConnected();
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`NovelAI 参考图编码失败 (${res.status})：${String(text || res.statusText || '').slice(0, 200)}`);
      err.httpStatus = res.status;
      throw err;
    }
    const buf = await res.arrayBuffer();
    if (!buf?.byteLength) throw new Error('NovelAI 参考图编码返回为空');
    return uint8ArrayToBase64(new Uint8Array(buf));
    }, { signal, url: networkTarget });
  };

  let vibeB64;
  try {
    vibeB64 = await requestTarget(primaryUrl);
  } catch (e) {
    const wrapped = wrapNetworkError(e, primaryUrl);
    throw wrapped;
  }
  novelAiVibeEncodeCache.set(cacheKey, vibeB64);
  return vibeB64;
}

/** V4+ 把参考图编成 .naiv4vibe 再塞进 reference_image_multiple；V3 仍用原图 base64 */
async function prepareNovelAiReferenceList(rawImageBase64List, model, cfg, options = {}) {
  const list = (Array.isArray(rawImageBase64List) ? rawImageBase64List : [])
    .filter(Boolean)
    .slice(0, MAX_REFERENCE_IMAGES);
  if (!list.length) return { refs: [], preEncoded: false };
  const isV4 = /nai-diffusion-4/i.test(String(model || ''));
  if (!isV4) return { refs: list, preEncoded: false };
  const infoExtracted = Number.isFinite(options.referenceInfoExtracted)
    ? options.referenceInfoExtracted
    : 1;
  const encoded = [];
  for (const raw of list) {
    encoded.push(await encodeNovelAiVibe(raw, model, infoExtracted, cfg, options.signal));
  }
  return { refs: encoded, preEncoded: true };
}

/** 把常见 HTTP 状态翻译成可操作的中文排障提示（尤其 404 地址/中转不对） */
function novelAiHttpHint(status, requestedUrl = '', transport = 'native') {
  const url = String(requestedUrl || '');
  if (status === 404) {
    if (transport === 'openai_chat' || transport === 'openai_images') {
      return `提示：OpenAI 兼容 NovelAI 中转地址不对（请求的是 ${url}）。请填站点根 + /v1（例如 https://中转/v1），不要填 /ai/generate-image。`;
    }
    return `提示：该地址没有 /ai/generate-image 路径（请求的是 ${url}）。多半是「NovelAI 地址」填错——官方/自建代理只填站点根；空悲切等 OpenAI 兼容 NovelAI 中转请填「https://中转/v1」（会走 chat/completions）。若中转只支持 /v1/images/generations、没有 NovelAI 能力，请改填到「兼容生图」一栏。`;
  }
  if (status === 400) {
    return `提示：参数被拒，请以上方接口原文为准。OpenAI 兼容中转的尺寸须是 [宽,高] 数组（chat）或 832x1216 小写 x（images）；只有原文明确提到中文、全角或 CJK 时才需要改提示词。`;
  }
  if (status === 401 || status === 403) {
    return '提示：Key 无效或无权限，请检查 NovelAI Key（图像生成需要有效的 NovelAI 订阅 / Opus）。';
  }
  if (status === 402) {
    return '提示：账号余额或订阅不足，NovelAI 图像生成需要有效订阅。';
  }
  if (status === 429) {
    return '提示：请求过于频繁或并发受限，稍后再试。';
  }
  if (status === 501) {
    return '提示：该中转未实现此接口（常见于 /v1/images/edits）。本次不会自动改发纯文生图；可调整接口后手动重试。';
  }
  if (status >= 500) {
    return '提示：上游服务器错误。若只在「参考图锁定」失败，V4 原生接口需先编码参考图；OpenAI 兼容中转则走 i2i，参考图尺寸须与输出尺寸一致。也可稍后重试。';
  }
  return '';
}

function isHostedNovelAiProxyTarget(target = '') {
  const raw = String(target || '').trim();
  if (!raw) return false;
  try {
    const hostedOrigin = new URL(resolveSocialWorkerUrl('/')).origin;
    const parsed = new URL(raw, hostedOrigin);
    return parsed.origin === hostedOrigin
      && ['/api/ai/generate-image', '/api/ai/encode-vibe'].includes(parsed.pathname);
  } catch (_) {
    return false;
  }
}

function resolveNovelAiNetworkTarget(target = '') {
  const raw = String(target || '').trim();
  if (/^\/api\/ai\/(?:generate-image|encode-vibe)$/i.test(raw)) {
    return resolveSocialWorkerUrl(raw);
  }
  return raw;
}

function novelAiHeaders(cfg = {}, target = '') {
  const headers = { Accept: 'application/json, application/zip, application/x-zip-compressed', 'Content-Type': 'application/json' };
  const auth = imageAuthHeaderValue(String(cfg.novelAi?.apiKey || '').trim());
  const accessHeaders = isHostedNovelAiProxyTarget(target) ? socialWorkerAuthHeaders() : {};
  if (accessHeaders.Authorization) {
    headers.Authorization = accessHeaders.Authorization;
    if (auth) headers['X-NovelAI-Key'] = auth;
  } else if (auth) {
    headers.Authorization = auth;
  }
  return headers;
}

function bytesToDataUrl(bytes, mime = 'image/png') {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function imageMimeFromBytes(bytes, contentType = '') {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) return type;
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return '';
}

async function downloadGeneratedImageViaWorker(resolved, {
  requestUrl = '',
  authorization = '',
  signal,
} = {}) {
  const response = await fetch(resolveSocialWorkerUrl('/api/ai/image-proxy'), {
    method: 'POST',
    headers: {
      ...socialWorkerAuthHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: resolved,
      requestUrl,
      authorization,
    }),
    signal,
    cache: 'no-store',
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`NovelAI 图片代理失败 (${response.status})${detail ? `：${detail.slice(0, 200)}` : ''}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const mime = imageMimeFromBytes(bytes, response.headers.get('content-type'));
  if (!mime || bytes.length <= 8) {
    throw new Error('NovelAI 图片代理没有返回有效图片数据');
  }
  return bytesToDataUrl(bytes, mime);
}

export async function materializeGeneratedImageUrl(value, {
  requestUrl = '',
  responseUrl = '',
  apiKey = '',
  signal,
} = {}) {
  const normalized = normalizeGeneratedImageValue(value);
  if (!normalized || /^data:image\//i.test(normalized) || /^blob:/i.test(normalized)) return normalized;

  let resolved = normalized;
  try {
    resolved = new URL(normalized, responseUrl || requestUrl).href;
  } catch {
    throw new Error('NovelAI 已返回图片地址，但地址格式无效');
  }
  if (!/^https?:\/\//i.test(resolved)) {
    throw new Error('NovelAI 已返回图片地址，但该地址不是可访问的 HTTP(S) 图片');
  }

  // 一些中转只返回受保护的相对图片路径；<img> 无法携带 API Key，
  // 先在同源范围内带鉴权下载并内联，避免接口成功但预览裂图。
  const headers = { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8' };
  let matchesRequestOrigin = false;
  try {
    const imageOrigin = new URL(resolved).origin;
    const requestOrigin = new URL(requestUrl, responseUrl || undefined).origin;
    matchesRequestOrigin = imageOrigin === requestOrigin;
    if (matchesRequestOrigin) {
      const auth = imageAuthHeaderValue(String(apiKey || '').trim());
      if (auth) headers.Authorization = auth;
    }
  } catch {
    // URL 已在上方校验；这里仅决定是否安全附带鉴权。
  }

  try {
    const imageRes = await fetch(resolved, { method: 'GET', headers, signal });
    if (!imageRes.ok) {
      throw new Error(`NovelAI 图片下载失败 (${imageRes.status})`);
    }
    const bytes = new Uint8Array(await imageRes.arrayBuffer());
    const mime = imageMimeFromBytes(bytes, imageRes.headers.get('content-type'));
    if (!mime || bytes.length <= 8) {
      throw new Error('NovelAI 返回的图片地址没有提供有效图片数据');
    }
    return bytesToDataUrl(bytes, mime);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    // APK 的 WebView fetch 可能被 CORS / mixed-content 拦截，也可能只拿到
    // 中转的鉴权失败响应。无论 fetch 以哪种错误结束，都让原生通道再读一次；
    // headers 只会在图片与请求同源时包含 Key，绝不把鉴权发给第三方域名。
    let nativeError = null;
    try {
      const nativeResult = await nativeHttpGetBytes(resolved, {
        headers,
        signal,
        connectTimeout: 20_000,
        readTimeout: 60_000,
      });
      const bytes = nativeResult.bytes;
      const contentType = Object.entries(nativeResult.headers || {})
        .find(([key]) => String(key).toLowerCase() === 'content-type')?.[1] || '';
      const mime = imageMimeFromBytes(bytes, contentType);
      if (!mime || bytes.length <= 8) {
        throw new Error('NovelAI 返回的图片地址没有提供有效图片数据');
      }
      return bytesToDataUrl(bytes, mime);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      nativeError = error;
    }

    // 旧 APK 没有稳定的二进制原生桥；网页热更新不能补 Java 插件。
    // Worker 只做已生成图片的 GET，不会重新生图或重复计费。
    try {
      return await downloadGeneratedImageViaWorker(resolved, {
        requestUrl,
        authorization: matchesRequestOrigin ? String(headers.Authorization || '') : '',
        signal,
      });
    } catch (workerError) {
      if (workerError?.name === 'AbortError') throw workerError;
    }

    if (nativeError?.httpStatus) {
      throw new Error(`NovelAI 图片下载失败 (${nativeError.httpStatus})`);
    }
    // 非原生环境或旧壳没有二进制插件时，公共图床仍可交给 <img> 直连；
    // 新版原生下载若真实失败则保留具体错误。
    if (
      nativeError
      && !/原生二进制 HTTP 不可用|原生 HTTP 插件未加载|CapacitorHttp 未加载/i
        .test(String(nativeError?.message || ''))
    ) {
      throw nativeError;
    }
    // 公共图床可能允许 <img> 展示但不允许 fetch 读取（无 CORS 响应头）；
    // 保留原地址，交给最终的图片加载校验判断，避免误杀可正常显示的链接。
    if (e instanceof TypeError) return resolved;
    throw e;
  }
}

async function assertImagePreviewLoadable(url, timeoutMs = 20000) {
  if (typeof Image === 'undefined') return;
  await new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('NovelAI 已生成图片，但图片地址加载超时')),
      Math.max(3000, Number(timeoutMs) || 20000),
    );
    img.onload = () => finish();
    img.onerror = () => finish(new Error(
      'NovelAI 已返回图片地址，但图片无法显示；中转可能返回了过期、受保护或非 HTTPS 的图片链接',
    ));
    img.src = url;
  });
}

function inflateRawBytes(bytes) {
  return inflateRaw(
    bytes,
    '当前浏览器不支持解压 NovelAI 返回的图片，请更新浏览器或改用支持 OpenAI 兼容输出的中转',
  );
}

/** 解析 NovelAI 返回的 zip（含 image_0.png），取第一张图片为 Uint8Array */
async function extractFirstImageFromZip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const len = view.byteLength;
  // 从尾部定位 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = len - 22; i >= 0 && i >= len - 22 - 65536; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  const tryEntry = async (method, offset, compSize) => {
    if (view.getUint32(offset, true) !== 0x04034b50) return null;
    const fnLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + fnLen + extraLen;
    const slice = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) return slice;
    if (method === 8) return inflateRawBytes(slice);
    throw new Error(`不支持的 zip 压缩方式 ${method}`);
  };
  if (eocd >= 0) {
    const cdOffset = view.getUint32(eocd + 16, true);
    const entries = view.getUint16(eocd + 10, true);
    let p = cdOffset;
    for (let i = 0; i < entries; i += 1) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const fnLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + fnLen));
      if (/\.(png|jpe?g|webp)$/i.test(name) || entries === 1) {
        const out = await tryEntry(method, localOffset, compSize);
        if (out && out.length) return out;
      }
      p += 46 + fnLen + extraLen + commentLen;
    }
  }
  // 兜底：直接从首个本地文件头读取
  if (view.getUint32(0, true) === 0x04034b50) {
    const method = view.getUint16(8, true);
    const compSize = view.getUint32(18, true);
    if (compSize > 0) {
      const out = await tryEntry(method, 0, compSize);
      if (out && out.length) return out;
    }
  }
  return null;
}

function ensureDataUriImage(value = '', mime = 'image/png') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) return raw;
  return `data:${mime};base64,${raw.replace(/^data:[^,]*,/, '')}`;
}

function throwNovelAiHttpError(status, text, target, transport = 'native') {
  const detail = formatImageHttpErrorDetail(status, text || '', { novelAi: true });
  const hasSpecificHint = /中文|全角|CJK|英文标签|免费试用|reCAPTCHA|验证码/.test(detail);
  const hint = hasSpecificHint ? '' : novelAiHttpHint(status, target, transport);
  const err = new Error(`NovelAI 生图失败 (${status})：${detail}${hint ? `\n${hint}` : ''}`);
  err.httpStatus = status;
  err.status = status;
  err.responseText = detail;
  err.usedUrl = target;
  err.transport = transport;
  if (/中文|全角|CJK|英文标签/.test(detail)) err.code = 'NOVELAI_CJK_PROMPT';
  throw err;
}

async function materializeNovelAiJsonImage(data, target, cfg, signal) {
  const imageUrl = data ? extractGeneratedImageUrl(data) : '';
  if (!imageUrl) {
    const relayMsg = extractImageApiErrorMessage(JSON.stringify(data || {}))
      || String(data?.error?.message || data?.error || data?.message || data?.msg || data?.detail || '').trim();
    throw new Error(relayMsg
      ? `NovelAI 中转返回错误：${relayMsg.slice(0, 200)}`
      : 'NovelAI 中转返回 JSON 但未找到图片数据（OpenAI 兼容中转应返回 markdown Data URI 或 data[].b64_json）');
  }
  return materializeGeneratedImageUrl(imageUrl, {
    requestUrl: target,
    apiKey: cfg.novelAi.apiKey,
    signal,
  });
}

/** 空悲切等：Chat Completions + 内层 NAI JSON，响应里是 markdown Data URI */
async function generateNovelAiImageViaOpenAiChat({
  cfg,
  model,
  positive,
  negative,
  width,
  height,
  seed,
  options = {},
  targetUrl,
}) {
  const drawParams = {
    prompt: positive,
    negative_prompt: negative,
    size: [width, height],
    // 此类中转 steps 上限 28
    steps: Math.min(Math.max(Number(cfg.novelAi.steps) || 28, 1), 28),
    scale: Number(cfg.novelAi.scale) || 5,
    sampler: cfg.novelAi.sampler || 'k_euler_ancestral',
    seed,
    noise_schedule: cfg.novelAi.noiseSchedule || 'karras',
    image_format: 'png',
    // 我们已自行拼接质量词，避免中转再追加一套
    quality: false,
  };
  if (Array.isArray(options.refImageBase64List) && options.refImageBase64List.length) {
    const strength = Number.isFinite(options.referenceStrength) ? options.referenceStrength : 0.5;
    drawParams.i2i = {
      image: ensureDataUriImage(options.refImageBase64List[0]),
      strength: Math.min(Math.max(strength, 0.01), 0.99),
      noise: 0,
    };
  }

  // 这类中转表面是生图，传输协议仍是 Chat Completions。APK 若等非流式
  // Base64 整包，生成期间同样可能几十秒 0 字节后被 VPN/中转掐断。
  const nativeBufferedStream = getNativeHttpTransport() === 'marshmallow-http';
  const body = {
    model,
    messages: [{ role: 'user', content: JSON.stringify(drawParams) }],
    stream: nativeBufferedStream,
  };

  return runImageRequestWithTimeout(async (signal, markConnected) => {
    const headers = novelAiHeaders(cfg, targetUrl);
    const res = nativeBufferedStream
      ? await nativeHttpPostJson(targetUrl, {
        headers,
        body,
        signal,
        connectTimeout: options.connectTimeoutMs,
        readTimeout: options.totalTimeoutMs,
      })
      : await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    markConnected();
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throwNovelAiHttpError(res.status, text || res.statusText || '', targetUrl, 'openai_chat');
    }
    const data = nativeBufferedStream
      ? {
        choices: [{
          message: { content: await readStream(res) },
          finish_reason: 'stop',
        }],
      }
      : await res.json().catch(() => null);
    if (!data) throw new Error('NovelAI 中转返回不是 JSON');
    const url = await materializeNovelAiJsonImage(data, targetUrl, cfg, signal);
    return { url, raw: data, transport: 'openai_chat', seed };
  }, {
    signal: options.signal,
    connectTimeoutMs: options.connectTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    url: targetUrl,
  });
}

/** OpenAI Images 基础文生图（无负面/采样器；仅作地址被填成 images 端点时的兜底） */
async function generateNovelAiImageViaOpenAiImages({
  cfg,
  model,
  positive,
  width,
  height,
  options = {},
  targetUrl,
}) {
  const body = {
    model,
    prompt: positive,
    n: 1,
    size: normalizeOpenAiImageSize(`${width}x${height}`, '832x1216'),
    response_format: 'b64_json',
    stream: false,
  };
  return runImageRequestWithTimeout(async (signal, markConnected) => {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: novelAiHeaders(cfg, targetUrl),
      body: JSON.stringify(body),
      signal,
    });
    markConnected();
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throwNovelAiHttpError(res.status, text || res.statusText || '', targetUrl, 'openai_images');
    }
    const data = await res.json().catch(() => null);
    if (!data) throw new Error('NovelAI 中转返回不是 JSON');
    const url = await materializeNovelAiJsonImage(data, targetUrl, cfg, signal);
    return { url, raw: data, transport: 'openai_images' };
  }, {
    signal: options.signal,
    connectTimeoutMs: options.connectTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    url: targetUrl,
  });
}

export async function generateNovelAiImage(prompt, options = {}) {
  const cfg = mergeConfig(options.config || await loadImageToolConfig());
  if (cfg.characterProvider !== 'novelai' || !cfg.novelAi.enabled) {
    throw new Error('NovelAI 生图未启用');
  }
  if (!String(cfg.novelAi.apiKey || '').trim()) throw new Error('缺少 NovelAI Key');
  const model = String(options.model || cfg.novelAi.model || '').trim();
  if (!model) throw new Error('缺少 NovelAI 模型');

  let positive = options.rawPrompt === true
    ? String(prompt || '').trim()
    : buildNovelAiPrompt(prompt, cfg);
  // 画风前缀（内置画师串等）：拼在最前，且不与本次内容重复时才加
  const stylePrefix = String(options.stylePrefix || '').trim();
  if (stylePrefix && !positive.includes(stylePrefix)) {
    positive = [stylePrefix, positive].filter(Boolean).join(', ');
  }
  // 中转常拒收中文/全角；先归一化全角标点，再剥掉残留 CJK，避免 400
  positive = prepareNovelAiPromptText(positive, '正向提示词');
  const negative = prepareNovelAiPromptText(
    buildNovelAiNegativePrompt(cfg, options.negativePrompt),
    '负面提示词',
  );
  const { width, height } = resolveNovelAiSize(options.size || cfg.novelAi.size);
  const isV4 = /nai-diffusion-4/i.test(model);

  const NOVELAI_MAX_SEED = 4294967295;
  const rawSeed = Number(options.seed);
  const seed = Number.isFinite(rawSeed) && rawSeed > 0
    ? Math.min(Math.floor(rawSeed), NOVELAI_MAX_SEED)
    : Math.floor(Math.random() * NOVELAI_MAX_SEED);

  const targetInfo = resolveNovelAiRequestTarget(cfg.novelAi.endpoint);
  if (targetInfo.transport === 'openai_chat') {
    try {
      return await generateNovelAiImageViaOpenAiChat({
        cfg, model, positive, negative, width, height, seed, options, targetUrl: targetInfo.url,
      });
    } catch (e) {
      throw wrapNetworkError(e, targetInfo.url);
    }
  }
  if (targetInfo.transport === 'openai_images') {
    try {
      return await generateNovelAiImageViaOpenAiImages({
        cfg, model, positive, width, height, options, targetUrl: targetInfo.url,
      });
    } catch (e) {
      throw wrapNetworkError(e, targetInfo.url);
    }
  }

  const parameters = {
    params_version: 3,
    width,
    height,
    scale: Number(cfg.novelAi.scale) || 5,
    sampler: cfg.novelAi.sampler || 'k_euler_ancestral',
    steps: Math.min(Math.max(Number(cfg.novelAi.steps) || 28, 1), 50),
    n_samples: 1,
    ucPreset: 0,
    qualityToggle: true,
    seed,
    dynamic_thresholding: false,
    cfg_rescale: 0,
    noise_schedule: cfg.novelAi.noiseSchedule || 'karras',
    negative_prompt: negative,
  };
  if (isV4) {
    parameters.use_coords = false;
    parameters.legacy = false;
    parameters.legacy_uc = false;
    parameters.v4_prompt = {
      caption: { base_caption: positive, char_captions: [] },
      use_coords: false,
      use_order: true,
    };
    parameters.v4_negative_prompt = {
      caption: { base_caption: negative, char_captions: [] },
      legacy_uc: false,
    };
  } else {
    parameters.sm = false;
    parameters.sm_dyn = false;
  }
  // Vibe Transfer：V4+ 须为 encode-vibe 产物；V3 可直接传参考图 base64
  if (Array.isArray(options.refImageBase64List) && options.refImageBase64List.length) {
    const refs = options.refImageBase64List.slice(0, MAX_REFERENCE_IMAGES);
    const strength = Number.isFinite(options.referenceStrength) ? options.referenceStrength : 0.6;
    const infoExtracted = Number.isFinite(options.referenceInfoExtracted) ? options.referenceInfoExtracted : 1;
    parameters.reference_image_multiple = refs;
    parameters.reference_strength_multiple = refs.map(() => strength);
    if (!options.refVibePreEncoded) {
      parameters.reference_information_extracted_multiple = refs.map(() => infoExtracted);
    }
    if (isV4) parameters.normalize_reference_strength_multiple = true;
  }

  const body = { input: positive, model, action: 'generate', parameters };
  const primaryUrl = resolveNovelAiNetworkTarget(targetInfo.url);

  const requestTarget = (target) => runImageRequestWithTimeout(async (signal, markConnected) => {
    const res = await fetch(target, {
      method: 'POST',
      headers: novelAiHeaders(cfg, target),
      body: JSON.stringify(body),
      signal,
    });
    markConnected();
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throwNovelAiHttpError(res.status, text || res.statusText || '', target, 'native');
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      const data = await res.json().catch(() => null);
      const materializedUrl = await materializeNovelAiJsonImage(data, target, cfg, signal);
      return { url: materializedUrl, raw: data, transport: 'native', seed };
    }

    const buf = await res.arrayBuffer();
    const head = new DataView(buf);
    if (buf.byteLength >= 4 && head.getUint32(0, true) === 0x04034b50) {
      const imgBytes = await extractFirstImageFromZip(buf);
      if (!imgBytes || !imgBytes.length) throw new Error('NovelAI 返回的压缩包中没有解析到图片');
      return { url: bytesToDataUrl(imgBytes, 'image/png'), raw: null, transport: 'native', seed };
    }
    const rawBytes = new Uint8Array(buf);
    const rawMime = imageMimeFromBytes(rawBytes, contentType);
    if (rawMime && buf.byteLength > 8) {
      return {
        url: bytesToDataUrl(rawBytes, rawMime),
        raw: null,
        transport: 'native',
        seed,
      };
    }
    const responseKind = contentType || 'unknown content-type';
    throw new Error(`NovelAI 返回内容无法识别为图片（${responseKind}）`);
  }, {
    signal: options.signal,
    connectTimeoutMs: options.connectTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    url: target,
  });

  try {
    return await requestTarget(primaryUrl);
  } catch (e) {
    const wrapped = wrapNetworkError(e, primaryUrl);
    // NovelAI 生图可能已扣点并完成；响应丢失时不得自动向代理重放。
    throw wrapped;
  }
}

export async function testNovelAiImageGeneration(options = {}) {
  try {
    const loaded = mergeConfig(options.config || await loadImageToolConfig());
    // “测试”只验证当前草稿能否请求成功，不要求用户先把 NovelAI 设为正式启用。
    // 否则只填 Key 后点测试会在本地报“未启用”，根本没有触发接口请求。
    const cfg = mergeConfig({
      ...loaded,
      characterProvider: 'novelai',
      novelAi: {
        ...(loaded.novelAi || {}),
        enabled: true,
      },
    });
    const prompt = options.prompt || '1girl, casual outfit, soft lighting, upper body, looking at viewer';
    const result = await generateNovelAiImage(prompt, {
      config: cfg,
      model: options.model || cfg.novelAi?.model,
      size: options.size || cfg.novelAi?.size,
      signal: options.signal,
    });
    if (!result?.url) throw new Error('NovelAI 返回成功，但没有图片数据');
    await assertImagePreviewLoadable(result.url);
    return {
      ok: true,
      url: result.url,
      model: options.model || cfg.novelAi?.model || '',
      size: options.size || cfg.novelAi?.size || '',
    };
  } catch (e) {
    const message = e?.message || String(e || 'NovelAI 生图测试失败');
    const status = Number(e?.status || e?.httpStatus || 0) || 0;
    let reason = 'novelai-response-error';
    if (
      e?.code === 'opaque_network_error'
      || e?.networkFailure === 'opaque'
      || /网络|连接|fetch|CORS|拦截/i.test(message)
    ) reason = 'network-unknown';
    else if (/未启用|缺少.+(?:Key|模型)/i.test(message)) reason = 'novelai-config-error';
    else if (status >= 400) reason = 'api-http-error';
    else if (e?.timeoutStage || /超时|timeout/i.test(message)) reason = 'client-timeout';
    return {
      ok: false,
      error: message,
      errorObject: e,
      reason,
      status: status || null,
      responseText: String(e?.responseText || '').trim(),
      usedUrl: String(e?.usedUrl || '').trim(),
      transport: String(e?.transport || '').trim(),
    };
  }
}

/**
 * 解析本次生图实际生效的画风预设：
 * 单次显式 styleId（角色画风 / 直播间局内选择等）优先，其次全局默认；与当前引擎不匹配的候选跳过。
 * 兼容人物画风只在「明确是人物/人像」或调用方声明 forcePortrait 时生效，生活证据图不受影响；
 * options.portraitStyleAllowed === false 可整体豁免（线下氛围图、直播封面等明确不要人像模板的场景）。
 */
export function resolveEffectiveImageStyle(provider, prompt, options = {}, cfg = {}) {
  const defaultId = provider === 'novelai'
    ? cfg.styles?.novelAiStyleId
    : cfg.styles?.realisticPersonStyleId;
  const candidates = [options.styleId, defaultId]
    .map((id) => getImageStylePreset(id))
    .filter(Boolean);
  const preset = candidates.find((p) => p.engine === provider) || null;
  if (!preset) return null;
  if (provider === 'realistic') {
    const peopleIntent = String(options.peopleIntent || '').trim();
    if (peopleIntent === 'none') return null;
    if (peopleIntent === 'partial') {
      if (options.characterStyleAllowed !== true || !preset.partialPrompt) return null;
      return preset;
    }
    if (options.portraitStyleAllowed === false) return null;
    if (peopleIntent && peopleIntent !== 'portrait') return null;
    if (peopleIntent !== 'portrait' && options.forcePortrait !== true && !looksLikePersonPrompt(prompt)) return null;
  }
  return preset;
}

/**
 * 兼容生图的无脸档位不能被锁脸参考图覆盖：partial/none 永远拦截；portrait 只有
 * 实际启用了兼容人物画风或自定义模板时才允许提交正脸身份参考。
 */
export function shouldSuppressRealisticIdentityReference(prompt = '', options = {}, cfg = {}) {
  const refs = Array.isArray(options.refImageUrls) ? options.refImageUrls.filter(Boolean) : [];
  if (!refs.length) return false;
  const peopleIntent = String(options.peopleIntent || '').trim();
  if (isNoFaceImageRequest(options)) return true;
  if (peopleIntent !== 'portrait') return false;
  const portraitStyle = resolveEffectiveImageStyle('realistic', prompt, options, cfg);
  const customTemplate = String(cfg.realistic?.promptTemplate || '').trim();
  return !portraitStyle && !customTemplate;
}

/**
 * 按引擎实际下发生图请求；options.refImageUrls 存在时，NovelAI 走 Vibe Transfer、
 * 兼容生图走 /v1/images/edits 参考图编辑；任何失败都保留原错误，不自动改发纯文或另一引擎。
 * options.styleId / options.forcePortrait：画风预设（见 resolveEffectiveImageStyle）。
 */
async function runProviderImageGeneration(provider, prompt, options, cfg) {
  const refImageUrls = Array.isArray(options.refImageUrls) ? options.refImageUrls.filter(Boolean) : [];
  const style = resolveEffectiveImageStyle(provider, prompt, options, cfg);
  const requestSize = resolveImageRequestSize(provider, options, cfg);
  if (!options.size && requestSize) options = { ...options, size: requestSize };
  if (provider === 'novelai') {
    const model = String(options.model || cfg.novelAi?.model || '').trim();
    let refImageBase64List;
    let refVibePreEncoded = false;
    let referencePrepareError = null;
    let rawRefImageBase64List = [];
    let referenceChatFallbackUrl = '';
    const openaiCompatible = isNovelAiOpenAiCompatibleTransport(cfg.novelAi?.endpoint);
    const { width: referenceWidth, height: referenceHeight } = resolveNovelAiSize(
      options.size || cfg.novelAi?.size,
    );
    if (refImageUrls.length) {
      try {
        rawRefImageBase64List = await convertRefImagesToBase64(refImageUrls, options.signal);
        if (openaiCompatible) {
          // OpenAI 兼容中转没有 encode-vibe；参考图走 i2i，并严格适配为本次输出尺寸。
          refImageBase64List = await prepareNovelAiI2iReferenceList(
            rawRefImageBase64List,
            referenceWidth,
            referenceHeight,
            options.signal,
          );
          refVibePreEncoded = false;
        } else {
          const prepared = await prepareNovelAiReferenceList(rawRefImageBase64List, model, cfg, options);
          refImageBase64List = prepared.refs;
          refVibePreEncoded = prepared.preEncoded;
        }
      } catch (e) {
        if (isImageGenerationOutcomeUnknown(e)) {
          throw markImageOutcomeUnknown(e, {
            operation: 'NovelAI 参考图编码',
            usedUrl: e?.usedUrl,
          });
        }
        referencePrepareError = e;
        referenceChatFallbackUrl = !openaiCompatible && rawRefImageBase64List.length
          ? resolveNovelAiOpenAiChatFallbackUrl(cfg.novelAi?.endpoint)
          : '';
        console.warn(
          referenceChatFallbackUrl
            ? '[image-generation-tools] 参考图编码失败，尝试 OpenAI Chat i2i 中转'
            : '[image-generation-tools] 参考图准备失败，跳过参考图',
          e,
        );
        if (options.requireReferenceIdentity === true && !referenceChatFallbackUrl) {
          throw referenceIdentityError('novelai', e);
        }
      }
    }
    const generationCfg = referenceChatFallbackUrl
      ? {
        ...cfg,
        novelAi: {
          ...(cfg.novelAi || {}),
          endpoint: referenceChatFallbackUrl,
        },
      }
      : cfg;
    if (referenceChatFallbackUrl) {
      try {
        refImageBase64List = await prepareNovelAiI2iReferenceList(
          rawRefImageBase64List,
          referenceWidth,
          referenceHeight,
          options.signal,
        );
        refVibePreEncoded = false;
      } catch (e) {
        referencePrepareError = e;
        referenceChatFallbackUrl = '';
        refImageBase64List = undefined;
        if (options.requireReferenceIdentity === true) throw referenceIdentityError('novelai', e);
      }
    }
    if (options.requireReferenceIdentity === true && refImageUrls.length && !refImageBase64List?.length) {
      throw referenceIdentityError('novelai', referencePrepareError || new Error('参考图编码结果为空'));
    }
    const genOptions = {
      ...options,
      refImageBase64List,
      refVibePreEncoded,
      stylePrefix: style?.prompt || options.stylePrefix || '',
      config: generationCfg,
    };
    try {
      const r = await generateNovelAiImage(prompt, genOptions);
      return {
        ...r,
        provider: 'novelai',
        referenceSubmittedCount: referencePrepareError && !referenceChatFallbackUrl ? 0 : (refImageBase64List?.length || 0),
        ...(referencePrepareError && !referenceChatFallbackUrl ? {
          referenceSkipped: true,
          referenceError: String(referencePrepareError?.message || referencePrepareError || '').slice(0, 300),
        } : {}),
        ...(referenceChatFallbackUrl ? {
          referenceFallbackTransport: 'openai_chat',
        } : {}),
      };
    } catch (e) {
      if (options.requireReferenceIdentity === true && refImageBase64List?.length) {
        throw referenceIdentityError('novelai', e);
      }
      throw e;
    }
  }
  // 兼容人物画风：人像 core 与全局模板统一组装；非人物仍走生活证据图管线。
  const portraitStyle = style && style.engine === 'realistic' ? style : null;
  const assembledPrompt = assembleRealisticPrompt(prompt, cfg, {
    ...options,
    portraitStyle,
  });
  const genOptions = { ...options, config: cfg, promptAssembly: 'none' };
  let referenceError = null;
  const skipEditsForNaiRelay = looksLikeNovelAiModel(options.model || cfg.realistic?.model || '')
    || /novelai|\/nai(?:\/|$)/i.test(String(cfg.realistic?.endpoint || ''));
  if (refImageUrls.length && !skipEditsForNaiRelay) {
    try {
      const r = await generateRealisticImageEdit(assembledPrompt, refImageUrls, genOptions);
      return {
        ...r,
        provider: 'realistic',
        referenceSubmittedCount: Number(r?.referenceSubmittedCount || 0),
      };
    } catch (e) {
      if (isImageGenerationOutcomeUnknown(e)) {
        throw markImageOutcomeUnknown(e, {
          operation: '参考图编辑',
          usedUrl: e?.usedUrl,
        });
      }
      if (options.requireReferenceIdentity === true) {
        throw referenceIdentityError('realistic', e);
      }
      throw e;
    }
  } else if (refImageUrls.length && skipEditsForNaiRelay) {
    referenceError = new Error('当前 NovelAI 兼容中转不支持 /v1/images/edits，已跳过参考图锁定');
    if (options.requireReferenceIdentity === true) {
      throw referenceIdentityError('realistic', referenceError);
    }
  }
  try {
    const r = await generateRealisticImage(assembledPrompt, genOptions);
    return {
      ...r,
      provider: 'realistic',
      ...(refImageUrls.length ? { referenceSubmittedCount: 0 } : {}),
      ...(referenceError ? {
        referenceSkipped: true,
        referenceError: String(referenceError?.message || referenceError || '').slice(0, 300),
      } : {}),
    };
  } catch (generationError) {
    if (!referenceError) throw generationError;
    if (isImageGenerationOutcomeUnknown(generationError)) {
      const unknown = markImageOutcomeUnknown(generationError, {
        operation: '纯文回退生图',
        usedUrl: generationError?.usedUrl,
      });
      unknown.referenceError = referenceError;
      throw unknown;
    }
    const error = new Error(
      `参考图编辑失败：${String(referenceError?.message || referenceError || '').slice(0, 220)}；`
      + `纯文回退也失败：${String(generationError?.message || generationError || '').slice(0, 220)}`,
    );
    error.cause = generationError;
    error.referenceError = referenceError;
    throw error;
  }
}

export function resolveProviderImagePrompt(provider, prompt, options = {}) {
  return provider === 'realistic'
    ? (String(options.realisticIdentityPrompt || '').trim() || prompt)
    : prompt;
}

async function runProviderImageOnce(provider, prompt, options, cfg) {
  const validate = async (targetProvider) => {
    const suppressFaceReference = targetProvider === 'realistic'
      && shouldSuppressRealisticIdentityReference(prompt, options, cfg);
    const providerOptions = suppressFaceReference
      ? {
        ...options,
        refImageUrls: [],
        referenceSubjects: [],
        expectedReferenceCount: 0,
        expectedReferenceSubjectIds: [],
        requireReferenceIdentity: false,
        realisticIdentityPrompt: '',
      }
      : { ...options };
    const providerPrompt = resolveProviderImagePrompt(targetProvider, prompt, providerOptions);
    const result = await runProviderImageGeneration(targetProvider, providerPrompt, providerOptions, cfg);
    const checked = assertCompleteReferenceSubmission(
      { ...result, provider: String(result?.provider || targetProvider) },
      { ...providerOptions, provider: targetProvider },
    );
    return suppressFaceReference
      ? { ...checked, referenceSuppressedForNoFace: true, referenceSubmittedCount: 0 }
      : checked;
  };
  return validate(provider);
}

/**
 * 统一的角色生图入口：默认优先 NovelAI（人物绘画），否则回落兼容生图；
 * options.providerOverride 可强制指定引擎（角色画风绑了兼容人物档时用），该引擎不可用则回落默认顺序。
 * @returns {Promise<{ url: string, provider: 'novelai'|'realistic', raw?: any }>}
 */
export async function generateCharacterImage(prompt, options = {}) {
  const cfg = mergeConfig(options.config || await loadImageToolConfig());
  const naiOk = isNovelAiImageGenerationEnabled(cfg);
  const realOk = isRealisticImageGenerationEnabled(cfg);
  let provider = String(options.providerOverride || '').trim();
  if ((provider === 'novelai' && !naiOk) || (provider === 'realistic' && !realOk)) provider = '';
  if (!provider) provider = naiOk ? 'novelai' : (realOk ? 'realistic' : '');
  if (!provider) throw new Error('请先在「API 管理 › 生图」里启用 NovelAI 或兼容生图');
  const baseOptions = { ...options, forcePortrait: true };
  if (provider === 'realistic') baseOptions.rawPrompt = true;
  return runProviderImageOnce(provider, prompt, baseOptions, cfg);
}

function stripNegatedPersonTerms(text = '') {
  return normalizePromptText(text)
    .replace(/(?:无|没有|禁止(?:出现)?|避免(?:出现)?|不要(?:出现|包含|显示|露出)?|不(?:出现|包含|显示|露出|露))(?:任何)?(?:人物|人像|人脸|脸部|面部|脸|人)/g, ' ')
    .replace(/\b(?:no|without|exclude|excluding|avoid)\s*[-\s]*(?:any\s+)?(?:visible\s+|identifiable\s+)?(?:human\s+)?(?:face|faces|person|people|human|humans|character|characters|portrait|portraits)\b/g, ' ')
    .replace(/\b(?:do\s+not|don'?t)\s+(?:show|include|depict|render)\s+(?:any\s+)?(?:human\s+)?(?:face|faces|person|people|human|humans|character|characters|portrait|portraits)\b/g, ' ')
    .replace(/\bnot\s+(?:a\s+|an\s+|any\s+)?(?:portrait|person|human|character)\b/g, ' ');
}

function looksLikeFullPersonPrompt(text = '') {
  const t = stripNegatedPersonTerms(text);
  if (!t) return false;
  // “a couple of pillows / cups / colors” 里的 couple 只是数量短语，不代表情侣或两个人。
  // 先抹掉这种量词用法，再判断剩余的 couple；避免给纯场景图误套人物画风和人脸守则。
  const englishPersonText = t.replace(/\bcouples?\s+of\b/g, ' ');
  const chinesePersonPattern = /人物|人像|肖像|自拍|合照|证件照|半身照|半身像|全身|角色|少女|少年|美女|帅哥|男孩|女孩|男生|女生|男人|女人|女性|男性|正脸|侧脸|脸部|面部|五官|表情|笑容|发型|穿搭/;
  const englishPersonPattern = /\b(1girl|1boy|2girls|2boys|multiple girls|multiple boys|girl|boy|man|woman|women|men|male|female|guy|guys|dude|lady|gentleman|teenager|idol|person|people|portrait|selfie|character|anime|waifu|husbando|couple|couples|face|headshot)\b/;
  return chinesePersonPattern.test(t) || englishPersonPattern.test(englishPersonText);
}

/** 判断提示词是否明确是「完整人物 / 人像」，用于智能档分流到 NovelAI */
export function looksLikePersonPrompt(text = '') {
  const t = normalizePromptText(text);
  if (!t) return false;
  if (looksLikeBodyDetailPrompt(text) && !looksLikeFullPersonPrompt(text)) return false;
  return looksLikeFullPersonPrompt(text);
}

const SCENE_CHOICES = new Set(['novelai', 'realistic', 'smart']);

/**
 * 解析「聊天生图」当前的有效模式，供告知 AI 用何种提示词格式。
 * @returns {'novelai'|'realistic'|'smart'|''} 空串表示两个引擎都没启用（不可生图）
 */
export function resolveChatImageGenMode(config = {}) {
  const cfg = mergeConfig(config);
  if (cfg.usage?.chatImages !== true) return '';
  const naiOk = isNovelAiImageGenerationEnabled(cfg);
  const realOk = isRealisticImageGenerationEnabled(cfg);
  if (!naiOk && !realOk) return '';
  if (naiOk && !realOk) return 'novelai';
  if (!naiOk && realOk) return 'realistic';
  let choice = String(cfg.scenes?.chatImages || 'smart').trim();
  if (!SCENE_CHOICES.has(choice)) choice = 'smart';
  return choice;
}

/**
 * 聊天模型是否应输出真实生图事件。
 * 同一轮的提示词与落地必须共享这份快照，不能在请求前后各读一次设置后分别判断。
 */
export function resolveChatImageGenerationCapability(config = {}, prefs = {}) {
  const cfg = mergeConfig(config);
  const chatEnabled = prefs?.chatImageGenEnabled === true;
  const globalEnabled = cfg.usage?.chatImages === true;
  const novelAiEnabled = isNovelAiImageGenerationEnabled(cfg);
  const realisticEnabled = isRealisticImageGenerationEnabled(cfg);
  // 文字图 / 真实生图只由会话里的「允许 AI 生图」分流。
  // 全局用途开关与引擎配置只描述执行能力；缺配置时应让真实任务明确失败，
  // 不能在角色已经答应发图后静默伪装成文字图。
  const configuredMode = resolveChatImageGenMode({
    ...cfg,
    usage: { ...cfg.usage, chatImages: true },
  });
  const imageGenMode = chatEnabled ? (configuredMode || 'smart') : '';
  return {
    allowed: chatEnabled,
    chatEnabled,
    globalEnabled,
    engineEnabled: novelAiEnabled || realisticEnabled,
    novelAiEnabled,
    realisticEnabled,
    imageGenMode,
  };
}

/** 解析某个场景应使用的生图引擎；返回 'novelai' | 'realistic' | '' */
export function resolveImageProviderForScene(scene = '', config = {}, prompt = '', options = {}) {
  const cfg = mergeConfig(config);
  let choice = String(cfg.scenes?.[scene] || cfg.scenes?.chatImages || 'smart').trim();
  if (!SCENE_CHOICES.has(choice)) choice = 'smart';
  const naiOk = isNovelAiImageGenerationEnabled(cfg);
  const realOk = isRealisticImageGenerationEnabled(cfg);
  if (choice === 'novelai') return naiOk ? 'novelai' : (realOk ? 'realistic' : '');
  if (choice === 'realistic') return realOk ? 'realistic' : (naiOk ? 'novelai' : '');
  // smart：出现人物优先 NovelAI，其余优先兼容生图；不可用则回退另一个
  const peopleIntent = String(options.peopleIntent || '').trim();
  const wantNai = peopleIntent
    ? peopleIntent === 'portrait'
    : (options.forcePortrait === true
      || (options.portraitStyleAllowed !== false && looksLikePersonPrompt(prompt)));
  if (wantNai) return naiOk ? 'novelai' : (realOk ? 'realistic' : '');
  return realOk ? 'realistic' : (naiOk ? 'novelai' : '');
}

/**
 * 按场景配置选择引擎生图（聊天、封面等都可复用）。
 * options.providerOverride（'novelai'|'realistic'）可强制指定引擎，用于角色锁脸（如 seed 锁必须走 NovelAI）。
 * @returns {Promise<{ url: string, provider: 'novelai'|'realistic', raw?: any }>}
 */
export async function generateImageForScene(prompt, scene = '', options = {}) {
  const cfg = mergeConfig(options.config || await loadImageToolConfig());
  const naiOk = isNovelAiImageGenerationEnabled(cfg);
  const realOk = isRealisticImageGenerationEnabled(cfg);
  let provider = String(options.providerOverride || '').trim();
  if ((provider === 'novelai' && !naiOk) || (provider === 'realistic' && !realOk)) provider = '';
  if (!provider) provider = resolveImageProviderForScene(scene, cfg, prompt, options);
  if (!provider) {
    throw new Error('请先在「API 管理 › 生图」里启用 NovelAI 或兼容生图');
  }
  let nextOptions = options;
  if (
    scene === 'chatImages'
    && provider === 'realistic'
    && !options.peopleIntent
    && looksLikePersonPrompt(prompt)
    && (cfg.styles?.realisticPersonStyleId || String(cfg.realistic?.promptTemplate || '').trim())
  ) {
    nextOptions = { ...options, forcePortrait: true };
  }
  return runProviderImageOnce(provider, prompt, nextOptions, cfg);
}
