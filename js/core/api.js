import * as db from './db.js';
import {
  recordApiError,
  appendDebugEvent,
  makeCorrelationId,
  classifyErrorKind,
  recordApiRequestStat,
} from './debug-log.js';
import {
  acquireNetworkLease,
  getNativeHttpTransport,
  hasNativeHttp,
  isNativeAppShell as isNativeShellFromHttp,
  nativeHttpGet,
  nativeHttpPostJson,
  releaseNetworkLease,
  supportsNativeHttpRequestRecovery,
} from './native-http.js';
import {
  getGenerationRelayPrefs,
  isGenerationRelayEnabled,
  runGenerationRelayCompletion,
} from './generation-relay.js';
import { isOpaqueFetchError, makeOpaqueFetchError } from './network-error.js';
import { injectFrontSystemPrompt } from './front-system-prompt.js';

let _config = null;
let _toolConfig = null;
let _sceneConfig = null;

/** Capacitor App 内没有 Cloudflare Pages 的 /api 同源反代；相对 /api 只会打到本地壳并回 index.html。 */
function isNativeAppShell() {
  return isNativeShellFromHttp();
}

export const DEFAULT_CHAT_CONFIG = {
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.8,
  samplingMode: 'auto',
  maxTokens: 15000,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  customHeaders: {},
  endpointType: 'openai',
  /** 主 API 聊天类请求是否走 SSE 流式；关闭后一次性返回，部分中转更稳 */
  preferStream: true,
  /** 兼容旧备份字段；生成请求失败后不再自动重发 */
  retryOnFailure: false,
  /** OpenAI 兼容 reasoning_effort；空字符串表示不干预模型默认策略 */
  reasoningEffort: '',
  /** 兼容模式：只把 system 合并到首条 user；保留其余多轮 user / assistant 历史 */
  singleUserCompat: false,
  /** 结构化任务在首轮请求末尾追加 JSON 协议校验；不自动重试，不增加调用次数 */
  structureStrengthening: false,
  /** 后台提前拼接下一轮聊天上下文；可缩短回复前等待，但会增加本机 CPU、内存与存储压力 */
  contextPrewarmEnabled: false,
};

/** 线下相遇、旅行 char、时光机等叙事场景专用 API；默认跟随聊天模型 */
export const DEFAULT_SCENE_API_CONFIG = {
  useCustom: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.9,
  samplingMode: 'auto',
  maxTokens: 15000,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  customHeaders: {},
  endpointType: 'openai',
  preferStream: true,
  retryOnFailure: false,
  reasoningEffort: '',
};

export const DEFAULT_TOOL_API_CONFIG = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.25,
  samplingMode: 'auto',
  maxTokens: 15000,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  customHeaders: {},
  endpointType: 'openai',
  preferStream: false,
  /** 兼容旧备份字段；生成请求失败后不再自动重发 */
  retryOnFailure: false,
  /** 工具线路的结构化任务在首轮请求末尾追加 JSON 协议校验；不自动重试 */
  structureStrengthening: false,
  /** 生成结果缺少译文时，是否允许追加一次批量补译请求；必须由用户显式开启 */
  autoTranslationRepair: false,
  tasks: {
    chatSummary: true,
    memoryFacts: true,
    searchRefine: true,
    memeExplain: true,
    materialCompress: true,
    characterFill: true,
    translationRepair: true,
    capabilityRoute: true,
    offlineEditorialAudit: true,
  },
};

export function buildApiUrl(baseUrl, endpointPath) {
  const base = String(baseUrl || '').trim();
  if (!base) return `/api${endpointPath}`;
  if (/^https?:\/\//i.test(base)) return `${base.replace(/\/+$/, '')}${endpointPath}`;
  if (base.startsWith('/')) return `${base.replace(/\/+$/, '')}${endpointPath}`;
  return `/${base.replace(/^\/+/, '').replace(/\/+$/, '')}${endpointPath}`;
}

export async function getConfig() {
  if (_config) return _config;
  const saved = await db.get('settings', 'apiConfig');
  const stored = { ...(saved?.value || {}) };
  delete stored.geminiPreserveSystemRoles;
  _config = { ...DEFAULT_CHAT_CONFIG, ...stored };
  return _config;
}

export async function saveConfig(config) {
  const next = { ...(config || {}) };
  delete next.geminiPreserveSystemRoles;
  _config = { ...DEFAULT_CHAT_CONFIG, ...next };
  await db.put('settings', { key: 'apiConfig', value: _config });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('api-config-changed', { detail: { section: 'main', config: _config } }));
  }
}

export async function getToolConfig() {
  if (_toolConfig) return _toolConfig;
  const saved = await db.get('settings', 'toolApiConfig');
  const value = saved?.value || {};
  _toolConfig = {
    ...DEFAULT_TOOL_API_CONFIG,
    ...value,
    tasks: {
      ...DEFAULT_TOOL_API_CONFIG.tasks,
      ...(value.tasks || {}),
    },
  };
  return _toolConfig;
}

export async function getSceneConfig() {
  if (_sceneConfig) return _sceneConfig;
  const saved = await db.get('settings', 'sceneApiConfig');
  _sceneConfig = { ...DEFAULT_SCENE_API_CONFIG, ...(saved?.value || {}) };
  return _sceneConfig;
}

export async function saveSceneConfig(config) {
  _sceneConfig = { ...DEFAULT_SCENE_API_CONFIG, ...(config || {}) };
  await db.put('settings', { key: 'sceneApiConfig', value: _sceneConfig });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('api-config-changed', { detail: { section: 'scene', config: _sceneConfig } }));
  }
}

export async function saveToolConfig(config) {
  const next = {
    ...DEFAULT_TOOL_API_CONFIG,
    ...(config || {}),
    tasks: {
      ...DEFAULT_TOOL_API_CONFIG.tasks,
      ...(config?.tasks || {}),
    },
  };
  _toolConfig = next;
  await db.put('settings', { key: 'toolApiConfig', value: next });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('api-config-changed', { detail: { section: 'tool', config: next } }));
  }
}

/** 主 API：读取用户在设置里配置的 maxTokens，不做内置 floor/cap 截断；传入 overrideConfig 时优先取其 maxTokens */
export async function resolveGenerationMaxTokens(overrideConfig = null) {
  const overrideN = Number(overrideConfig?.maxTokens);
  if (Number.isFinite(overrideN) && overrideN > 0) return Math.floor(overrideN);
  const config = await getConfig();
  const n = Number(config.maxTokens);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_CHAT_CONFIG.maxTokens;
}

/** 工具 API：读取工具线路里配置的 maxTokens */
export async function resolveToolMaxTokens() {
  const config = await getToolConfig();
  const n = Number(config.maxTokens);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_TOOL_API_CONFIG.maxTokens;
}

export async function fetchModels() {
  const { models } = await fetchModelsWithError();
  return models;
}

export async function fetchToolModels() {
  const { models } = await fetchToolModelsWithError();
  return models;
}

export async function fetchModelsWithError() {
  const config = await getConfig();
  return fetchModelsForConfig(config);
}

export async function fetchToolModelsWithError() {
  const config = await getToolConfig();
  return fetchModelsForConfig(config);
}

export async function fetchSceneModelsWithError() {
  const scene = await getSceneConfig();
  const main = await getConfig();
  return fetchModelsForConfig(scene?.useCustom ? { ...main, ...scene } : main);
}

function isGoogleGeminiEndpoint(config = {}) {
  return String(config?.endpointType || '').trim().toLowerCase() === 'google_gemini';
}

function isAnthropicEndpoint(config = {}) {
  return String(config?.endpointType || '').trim().toLowerCase() === 'anthropic';
}

function normalizeGoogleGeminiBaseUrl(baseUrl = '') {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return 'https://generativelanguage.googleapis.com/v1beta';
  if (/\/v1(?:beta\d*|alpha\d*)?$/i.test(raw)) return raw;
  return `${raw}/v1beta`;
}

function normalizeGoogleModelName(model = '') {
  return String(model || '').trim().replace(/^models\//i, '');
}

export function buildGoogleGeminiModelsUrl(baseUrl = '') {
  return `${normalizeGoogleGeminiBaseUrl(baseUrl)}/models`;
}

export function buildGoogleGeminiContentUrl(baseUrl = '', model = '', { stream = false } = {}) {
  const modelName = normalizeGoogleModelName(model);
  if (!modelName) throw new Error('Google Gemini 原生协议需要填写模型名称。');
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `${normalizeGoogleGeminiBaseUrl(baseUrl)}/models/${encodeURIComponent(modelName)}:${action}`;
}

function normalizeAnthropicBaseUrl(baseUrl = '') {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return 'https://api.anthropic.com/v1';
  if (/\/v1\/messages$/i.test(raw)) return raw.replace(/\/messages$/i, '');
  if (/\/v1$/i.test(raw)) return raw;
  return `${raw}/v1`;
}

export function buildAnthropicMessagesUrl(baseUrl = '') {
  return `${normalizeAnthropicBaseUrl(baseUrl)}/messages`;
}

export function buildAnthropicModelsUrl(baseUrl = '') {
  return `${normalizeAnthropicBaseUrl(baseUrl)}/models`;
}

export async function fetchModelsForConfig(config) {
  const googleGemini = isGoogleGeminiEndpoint(config);
  const anthropic = isAnthropicEndpoint(config);
  const nativeProvider = googleGemini || anthropic;
  const primaryUrl = googleGemini
    ? buildGoogleGeminiModelsUrl(config.baseUrl)
    : anthropic
      ? buildAnthropicModelsUrl(config.baseUrl)
      : buildApiUrl(config.baseUrl, '/v1/models');
  const fallbackUrl = '/api/v1/models';
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    if (googleGemini) headers['x-goog-api-key'] = config.apiKey;
    else if (anthropic) headers['x-api-key'] = config.apiKey;
    else headers.Authorization = `Bearer ${config.apiKey}`;
  }
  if (anthropic) {
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  Object.assign(headers, config.customHeaders || {});

  const tryFetch = async (target) => {
    try {
      const res = (hasNativeHttp() && isAbsoluteHttpUrl(target))
        ? await nativeHttpGet(target, { headers })
        : await fetch(target, { headers });
      const data = await parseApiJsonResponse(res);
      if (googleGemini) {
        return (Array.isArray(data?.models) ? data.models : [])
          .filter((m) => !Array.isArray(m?.supportedGenerationMethods)
            || m.supportedGenerationMethods.includes('generateContent'))
          .map((m) => normalizeGoogleModelName(m?.name))
          .filter(Boolean)
          .sort();
      }
      return (data?.data || []).map((m) => m.id).sort();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error || '拉取失败'));
      err.usedUrl = err.usedUrl || target;
      err.requestMethod = err.requestMethod || 'GET';
      err.requestPath = err.requestPath || getSafeRequestPath(target);
      throw err;
    }
  };

  let lastError = '';
  try {
    const models = await tryFetch(primaryUrl);
    return { models, error: '' };
  } catch (e) {
    lastError = e?.message || String(e || '拉取失败');
    if (!nativeProvider && !isNativeAppShell() && fallbackUrl !== primaryUrl && shouldRetryViaApiProxy(primaryUrl, e)) {
      try {
        const models = await tryFetch(fallbackUrl);
        return { models, error: '' };
      } catch (fallbackErr) {
        lastError = fallbackErr?.message || lastError;
        console.error('Fetch models error (proxy fallback):', fallbackErr);
      }
    } else {
      console.error('Fetch models error:', e);
    }
  }
  return { models: [], error: lastError };
}

export function isStreamTransportError(err) {
  if (err?.streamIncomplete === true) return true;
  if (err?.code === 'opaque_network_error') return true;
  const m = String(err?.message || err || '');
  return err?.name === 'TypeError'
    || /Failed to fetch|NetworkError|Load failed|ERR_FAILED|network error|HTTP2|ERR_HTTP2|protocol error|连接在返回阶段断开|连接在返回中途断开|连接在等待响应|流式连接提前结束|网络连接中断/i.test(m);
}

export function getStreamPartialText(err) {
  return String(err?.partialText || '').trim();
}

export function canReplayGenerationApiRequest(generationTask = null) {
  return generationTask?.supportsServerIdempotency === true;
}

function inheritStreamErrorContext(target, source) {
  if (!target || !source) return target;
  for (const key of [
    'correlationId',
    'usedUrl',
    'requestModel',
    'requestStream',
    'streamStats',
    'timeoutStage',
    'abortReason',
    'requestElapsedMs',
    'upstreamMeta',
    'reasoningText',
  ]) {
    if (source[key] != null && target[key] == null) target[key] = source[key];
  }
  if (source.streamIncomplete === true) target.streamIncomplete = true;
  return target;
}

function wrapStreamTransportError(err, url = '') {
  const raw = String(err?.message || err || '');
  const partialText = getStreamPartialText(err);
  if (/HTTP2|ERR_HTTP2|protocol error/i.test(raw)) {
    const msg = '连接在返回阶段断开（HTTP/2 协议错误）。中转站可能已生成回复，但浏览器未收到完整响应；本轮未自动改用非流式重试，请点「重 roll」或更换线路。';
    const wrapped = new Error(msg);
    if (partialText) wrapped.partialText = partialText;
    wrapped.cause = err;
    return inheritStreamErrorContext(wrapped, err);
  }
  if (/network error/i.test(raw) && !/CORS|浏览器拦截/.test(raw)) {
    const msg = '网络连接中断。若中转站后台显示已成功，多为流式传输在末尾断开；本轮未自动改用非流式重试。';
    const wrapped = new Error(msg);
    if (partialText) wrapped.partialText = partialText;
    wrapped.cause = err;
    return inheritStreamErrorContext(wrapped, err);
  }
  const base = wrapNetworkError(err, url);
  if (partialText) base.partialText = partialText;
  return inheritStreamErrorContext(base, err);
}

function isDocumentHidden() {
  return typeof document !== 'undefined' && document.hidden === true;
}

function wrapNetworkError(err, url = '', { elapsedMs = 0 } = {}) {
  if (isOpaqueFetchError(err)) {
    // iOS PWA 切后台时常把进行中的 fetch 直接掐掉；这一条有页面状态证据，
    // 可以比浏览器笼统的 TypeError 给出更具体的判断。
    if (isDocumentHidden()) {
      const wrapped = new Error(
        '连接在返回中途断开。常见于切到后台后系统暂停了网页网络；中转侧可能已显示客户端断开。请回到前台后点「重 roll」。',
      );
      wrapped.streamIncomplete = true;
      wrapped.cause = err instanceof Error ? err : undefined;
      return wrapped;
    }
    return makeOpaqueFetchError(err, url, {
      label: '模型接口请求',
      elapsedMs,
      replayRisk: true,
      nativeHint: isNativeAppShell()
        ? '若这是 App 首次遇到该线路，下一次手动重试会优先使用原生网络通道。'
        : '反复出现时请检查线路，或改用已配置好的同源代理地址。',
    });
  }
  const raw = String(err?.message || err || '');
  return err instanceof Error ? err : new Error(raw || '网络请求失败');
}

function isAbsoluteHttpUrl(url = '') {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function getSafeRequestTarget(url = '') {
  const value = String(url || '').trim();
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value;
  }
}

function getSafeRequestPath(url = '') {
  const value = String(url || '').trim();
  try {
    const parsed = new URL(value, typeof location !== 'undefined' ? location.origin : 'https://local.invalid');
    return parsed.pathname || '/';
  } catch (_) {
    return value.split('?')[0].split('#')[0];
  }
}

function summarizeRequestAttempt(url, error) {
  const wrapped = error instanceof Error ? error : new Error(String(error || '网络请求失败'));
  return {
    target: getSafeRequestTarget(url),
    errorKind: classifyErrorKind(wrapped),
    message: String(wrapped.message || '网络请求失败').slice(0, 500),
  };
}

function attachRequestAttempts(error, attempts = [], primaryUrl = '') {
  const out = error instanceof Error ? error : new Error(String(error || '网络请求失败'));
  out.requestAttempts = attempts;
  out.usedUrl = out.usedUrl || primaryUrl || attempts[0]?.target || '';
  return out;
}

// Remembered per session: deployments without an /api reverse proxy return
// index.html for the fallback, so retrying it on every failure just adds noise.
let _apiProxyUnavailable = false;

function markApiProxyUnavailable(err) {
  const status = Number(err?.status || 0);
  // CF Pages 静态层对不存在的 POST /api/v1/chat/completions 常回 405 Method not allowed。
  if (status === 404 || status === 405) {
    _apiProxyUnavailable = true;
    return;
  }
  if (/网页而非 JSON|API错误 \(404\)|API错误 \(405\)|Method not allowed/i.test(String(err?.message || err || ''))) {
    _apiProxyUnavailable = true;
  }
}

function shouldRetryViaApiProxy(primaryUrl, err) {
  // APK/iOS 壳没有网页版那套 /api 反代；失败后改打相对路径只会拿到本地 index.html。
  if (isNativeAppShell()) return false;
  if (_apiProxyUnavailable) return false;
  // 切后台被系统掐网 ≠ CORS；再打同源 /api 只会在无反代部署上拿到 405，盖住真实断连。
  if (isDocumentHidden() || err?.streamIncomplete === true) return false;
  const fallbackUrl = '/api/v1/chat/completions';
  if (!isAbsoluteHttpUrl(primaryUrl) || primaryUrl === fallbackUrl) return false;
  const msg = String(err?.message || err || '');
  if (/连接在返回中途断开|连接在返回阶段断开|连接在等待响应|流式连接提前结束|网络连接中断|客户端断开/i.test(msg)) {
    return false;
  }
  return err?.replaySafe === true && err?.code === 'opaque_network_error';
}

function formatApiHttpError(status, text = '') {
  const body = String(text || '').trim();
  if (body.startsWith('<') || /<!DOCTYPE/i.test(body)) {
    const hint = isNativeAppShell()
      ? '（App 内没有网页版 /api 反代；请到 API 管理填写完整可直连的 https baseUrl，不要留空，也不要填成网站首页地址）'
      : (status === 404 || status === 200
        ? '（本地 serve -s 常把 /api 回退成 index.html，需配置真实 API 反代或换可直连的 baseUrl）'
        : '（网关/代理返回了 HTML 错误页）');
    return `API 返回了网页而非 JSON（HTTP ${status}）${hint}`;
  }
  if (body.length > 280) return `API错误 (${status}): ${body.slice(0, 280)}…`;
  return body ? `API错误 (${status}): ${body}` : `API错误 (${status})`;
}

function makeApiHttpError(status, text = '') {
  const err = new Error(formatApiHttpError(status, text));
  err.status = status;
  err.responseText = String(text || '');
  return err;
}

async function parseApiJsonResponse(res) {
  const text = await res.text();
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    if (!res.ok) throw makeApiHttpError(res.status, text);
    return null;
  }
  if (trimmed.startsWith('<') || /<!DOCTYPE/i.test(trimmed)) {
    throw makeApiHttpError(res.status || 502, trimmed);
  }
  let data = null;
  try {
    data = JSON.parse(trimmed);
  } catch (_) {
    if (!res.ok) throw makeApiHttpError(res.status, text);
    throw new Error(`API 响应不是合法 JSON：${trimmed.slice(0, 160)}`);
  }
  if (!res.ok) {
    const salvaged = extractCompletionText(data) || extractGeminiFallbackText(data);
    if (String(salvaged || '').trim()) {
      console.warn(`[api] HTTP ${res.status} returned completion JSON; using response body as compatibility fallback`);
      return data;
    }
    throw makeApiHttpError(res.status, text);
  }
  return data;
}

/**
 * APK 中 WebView 曾对该域名返回不透明网络错误。原因无法证明是 CORS；
 * 为避免同一个计费请求立即重放，只记录下来，让下一次用户主动请求走原生通道。
 */
const _webFetchFailedOrigins = new Set();

function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return ''; }
}

async function postJsonWithOptionalProxy(url, {
  headers,
  body,
  nativeBody = null,
  nativeUrl = '',
  proxyFallbackUrl = '/api/v1/chat/completions',
  signal,
  connectTimeout,
  readTimeout,
  correlationId = '',
  onNativeTransport = null,
  allowRequestReplay = true,
  preferNative = false,
  nativeStreamResponse = false,
  nativeRequestId = '',
  onNativeRequestStart = null,
  onRequestQueued = null,
}) {
  const fallbackUrl = String(proxyFallbackUrl || '');
  const startedAt = Date.now();
  let lastErr = null;
  const attempts = [];
  const targets = [url];
  if (allowRequestReplay && fallbackUrl && !isNativeAppShell() && isAbsoluteHttpUrl(url) && url !== fallbackUrl) {
    targets.push(fallbackUrl);
  }

  // 断连可能在回到前台后才 reject；用请求期间是否进过后台来区分「切后台掐网」与真 CORS。
  let sawBackgroundDuringRequest = isDocumentHidden();
  const onVisibilityForRequest = () => {
    if (isDocumentHidden()) sawBackgroundDuringRequest = true;
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityForRequest);
  }

  const nativeAvailable = hasNativeHttp();
  const viaNative = async (target) => {
    if (typeof onNativeTransport === 'function') onNativeTransport();
    const effectiveTarget = target === url && nativeUrl ? nativeUrl : target;
    const requestId = String(nativeRequestId || '').trim() || undefined;
    if (requestId && typeof onNativeRequestStart === 'function') {
      // The caller may need to durably record requestId/status-query capability before
      // Java can own the request. Await promises while preserving old synchronous hooks.
      await onNativeRequestStart(requestId, {
        supportsStatusQuery: supportsNativeHttpRequestRecovery(),
      });
    }
    const res = await nativeHttpPostJson(effectiveTarget, {
      headers,
      body: nativeBody || body,
      signal,
      connectTimeout,
      readTimeout,
      retryOnBackgroundDisconnect: allowRequestReplay === true,
      streamResponse: nativeStreamResponse === true,
      requestId,
      onRequestQueued,
    });
    return {
      res,
      usedUrl: effectiveTarget,
      viaNativeHttp: true,
      nativeHttpTransport: getNativeHttpTransport(),
    };
  };

  try {
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      try {
        // APK 流式请求继续走 WebView fetch，保留真 SSE；非流式从第一次请求起走
        // 原生 HTTP，避免上游已生成并计费、WebView 却在整包回传时丢失响应。
        // 已确认跨域失败的域名与切后台请求也继续优先原生通道。
        if (
          nativeAvailable
          && isAbsoluteHttpUrl(target)
          && (preferNative || _webFetchFailedOrigins.has(originOf(target)) || isDocumentHidden())
        ) {
          return await viaNative(target);
        }
        const res = await fetch(target, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
        // 同源代理不存在时 fetch「成功」拿到 404/405；若这是直连失败后的回退，
        // 绝不能把 405 当成最终错误（iOS 切后台断连时最容易踩中）。
        if (
          target === fallbackUrl
          && i > 0
          && lastErr
          && (res.status === 404 || res.status === 405)
        ) {
          const proxyErr = makeApiHttpError(res.status, res.status === 405 ? 'Method not allowed.' : '');
          markApiProxyUnavailable(proxyErr);
          attempts.push(summarizeRequestAttempt(target, proxyErr));
          const primary = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
          const combined = new Error(
            `${primary.message}\n（已跳过不可用的同源代理 /api，HTTP ${res.status}）`,
          );
          combined.cause = primary;
          combined.primaryError = attempts[0] || summarizeRequestAttempt(url, primary);
          combined.correlationId = correlationId;
          if (primary.streamIncomplete) combined.streamIncomplete = true;
          if (primary.partialText) combined.partialText = primary.partialText;
          throw attachRequestAttempts(combined, attempts, url);
        }
        return { res, usedUrl: target, viaNativeHttp: false, nativeHttpTransport: '' };
      } catch (e) {
        // 死代理 404/405 分支已整理过 attempts，直接抛出，避免再包一层。
        if (Array.isArray(e?.requestAttempts)) throw e;
        let effectiveErr = e;
        const userAborted = e?.name === 'AbortError' || signal?.aborted;
        const attemptElapsedMs = Date.now() - startedAt;
        const opaqueWebFailure = isOpaqueFetchError(e);
        if (nativeAvailable && isAbsoluteHttpUrl(target) && opaqueWebFailure && !userAborted) {
          _webFetchFailedOrigins.add(originOf(target));
        }
        if (allowRequestReplay && nativeAvailable && isAbsoluteHttpUrl(target) && opaqueWebFailure && !userAborted) {
          // 只有服务端明确支持幂等时，才允许把同一请求切到原生通道重放。
          try {
            const nativeResult = await viaNative(target);
            return nativeResult;
          } catch (nativeErr) {
            if (nativeErr?.name === 'AbortError') throw nativeErr;
            // 原生也失败：多半是网络本身不通；原生错误信息更具体，优先上报。
            effectiveErr = nativeErr;
          }
        }
        const wrapped = wrapErrForBackground(effectiveErr, target, sawBackgroundDuringRequest, attemptElapsedMs);
        if (allowRequestReplay && wrapped?.code === 'opaque_network_error') wrapped.replaySafe = true;
        attempts.push(summarizeRequestAttempt(target, wrapped));
        lastErr = wrapped;
        const hasMore = i < targets.length - 1;
        if (!hasMore || !shouldRetryViaApiProxy(url, wrapped)) {
          if (attempts.length > 1) {
            const primary = attempts[0];
            const fallback = attempts[attempts.length - 1];
            // 代理侧 405/404 说明部署根本没有 chat 反代；对外仍以直连失败为准。
            const fallbackIsDeadProxy = /API错误 \(404\)|API错误 \(405\)|Method not allowed/i.test(
              String(fallback?.message || ''),
            );
            const combined = new Error(
              fallbackIsDeadProxy
                ? `${primary.message}\n（已跳过不可用的同源代理 /api）`
                : `${primary.message}\n已额外尝试同源代理 ${fallback.target}，但也失败：${fallback.message}`,
            );
            combined.cause = wrapped;
            combined.primaryError = primary;
            combined.correlationId = correlationId;
            if (lastErr?.streamIncomplete || /连接在返回中途断开|流式连接提前结束/i.test(String(primary?.message || ''))) {
              combined.streamIncomplete = true;
            }
            throw attachRequestAttempts(combined, attempts, url);
          }
          wrapped.correlationId = correlationId;
          throw attachRequestAttempts(wrapped, attempts, url);
        }
      }
    }
    const fallback = lastErr || new Error('网络请求失败');
    fallback.correlationId = correlationId;
    throw attachRequestAttempts(fallback, attempts, url);
  } finally {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityForRequest);
    }
  }
}

function wrapErrForBackground(err, target, sawBackgroundDuringRequest, elapsedMs = 0) {
  if (!sawBackgroundDuringRequest) return wrapNetworkError(err, target, { elapsedMs });
  const raw = String(err?.message || err || '');
  const isCorsLike = err?.name === 'TypeError'
    && /Failed to fetch|NetworkError|Load failed|ERR_FAILED|network error/i.test(raw);
  if (!isCorsLike) return wrapNetworkError(err, target, { elapsedMs });
  const wrapped = new Error(
    '连接在返回中途断开。常见于切到后台后系统暂停了网页网络；中转侧可能已显示客户端断开。请回到前台后点「重 roll」。',
  );
  wrapped.streamIncomplete = true;
  wrapped.cause = err instanceof Error ? err : undefined;
  return wrapped;
}

function hasVisionImagesInMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).some((msg) =>
    Array.isArray(msg?.content) && msg.content.some((part) => part?.type === 'image_url'));
}

function stripVisionImagesFromMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((msg) => {
    if (!Array.isArray(msg?.content)) return msg;
    const hadImage = msg.content.some((part) => part?.type === 'image_url');
    const content = msg.content.filter((part) => part?.type !== 'image_url');
    if (hadImage) {
      content.push({
        type: 'text',
        text: '[本次接口未能接收图片像素。不要根据文件名、聊天主题或上下文猜测画面内容；需要谈及图片时，请明确说明当前看不到图片。]',
      });
    }
    return { ...msg, content };
  });
}

function isLikelyVisionUnsupportedError(err) {
  const text = String(err?.message || err || '');
  return /image_url|input_image|vision|multimodal|multi-modal|image input|unsupported.*image|does not support.*image|content.*array|invalid.*content|convert_request_failed|get file data failed|failed to download file/i.test(text);
}

async function chatWithConfiguredRetry(config, messages, options = {}) {
  const preparedMessages = await injectFrontSystemPrompt(messages);
  return chatWithConfig(config, preparedMessages, {
    ...options,
    auditContext: {
      ...(options.auditContext || {}),
    },
  });
}

export async function chat(messages, options = {}) {
  const base = await getConfig();
  const config = options.configOverride ? { ...base, ...options.configOverride } : base;
  const apiSection = options.auditContext?.apiSection === 'scene' ? 'scene' : 'main';
  return chatWithConfiguredRetry(config, messages, {
    ...options,
    auditContext: {
      ...(options.auditContext || {}),
      apiSection,
    },
  });
}

export async function resolveTaskApiConfig(task = '', options = {}) {
  const tool = await getToolConfig();
  const main = await getConfig();
  const taskKey = String(task || '').trim();
  const forceMainApi = options.forceMainApi === true;
  const toolTaskSelected = !forceMainApi
    && !!tool.enabled
    && !!tool.model
    && (!taskKey || tool.tasks?.[taskKey] !== false);
  const unsupportedToolModel = toolTaskSelected && taskKey === 'chatSummary'
    && isGeminiTextTaskModelUnsupported(tool.model);
  const canUseTool = toolTaskSelected && !unsupportedToolModel;
  return {
    config: canUseTool
      ? { ...tool, singleUserCompat: main.singleUserCompat === true }
      : main,
    apiSection: canUseTool ? 'tool' : 'main',
    taskKey,
    unsupportedToolModel,
    toolModel: tool.model,
  };
}

export async function chatForTask(messages, options = {}, task = '') {
  const route = await resolveTaskApiConfig(task, options);
  const { config, apiSection, taskKey, unsupportedToolModel, toolModel } = route;
  if (unsupportedToolModel) {
    appendDebugEvent({
      type: 'api_tool_model_skipped',
      level: 'warn',
      message: `工具模型 ${toolModel} 不适合文本总结，本次改用聊天模型`,
      requestModel: toolModel,
      context: { task: taskKey, apiSection: 'tool' },
    });
  }

  if (apiSection === 'tool') {
    return chatWithConfiguredRetry(config, messages, {
      ...(typeof options.stream === 'boolean' ? options : { ...options, stream: config.preferStream === true }),
      model: options.model || config.model,
      auditContext: {
        ...(options.auditContext || {}),
        apiSection: 'tool',
        operation: taskKey || options.auditContext?.operation || 'tool-task',
      },
    });
  }
  return chat(messages, {
    ...options,
    auditContext: {
      ...(options.auditContext || {}),
      operation: taskKey || options.auditContext?.operation || 'tool-task',
    },
  });
}

function normalizeApiAuditContext(value = {}) {
  const src = value && typeof value === 'object' ? value : {};
  const cleanList = (list = []) => (Array.isArray(list) ? list : [])
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 24);
  return {
    apiSection: String(src.apiSection || '').trim(),
    operation: String(src.operation || '').trim(),
    trigger: String(src.trigger || '').trim(),
    initiator: String(src.initiator || '').trim(),
    chatId: String(src.chatId || '').trim(),
    logicalRoundId: String(src.logicalRoundId || '').trim(),
    proactiveChannel: String(src.proactiveChannel || '').trim(),
    fallbackFrom: String(src.fallbackFrom || '').trim(),
    actorIds: cleanList(src.actorIds),
    actorNames: cleanList(src.actorNames),
  };
}

function isGeminiLikeModel(model = '') {
  return /gemini|google/i.test(String(model || ''));
}

const GEMINI_ASSISTANT_TAIL_CONTINUATION = '请根据以上上下文继续生成下一条回复。';

export function isGeminiTextTaskModelUnsupported(model = '') {
  const normalized = String(model || '').trim();
  return isGeminiLikeModel(normalized)
    && /(?:^|[-_.])(image|live|tts|embedding)(?:$|[-_.])/i.test(normalized);
}

export function resolveGoogleGeminiThinkingLevel(
  model = '',
  reasoningEffort = '',
  operation = '',
) {
  const normalizedModel = String(model || '').trim();
  if (!/^gemini-3(?:[.-]|$)/i.test(normalizedModel)) return '';
  const effort = String(reasoningEffort || '').trim().toLowerCase();
  if (['low', 'medium', 'high'].includes(effort)) return effort;
  if (effort === 'minimal' || effort === 'none') {
    return /(?:^|[-_.])pro(?:$|[-_.])/i.test(normalizedModel) ? 'low' : 'minimal';
  }
  return String(operation || '').trim() === 'chatSummary' ? 'low' : '';
}

function messagePartToPlainText(msg = {}) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => (typeof part === 'string' ? part : String(part?.text || part?.content || '')))
      .filter(Boolean)
      .join('\n');
  }
  return String(msg.content || '');
}

/**
 * Compatibility mode for relays that cannot accept a dedicated system role.
 * Only system/developer content is moved into the first user turn; the original
 * multi-turn user/assistant sequence remains intact.
 */
export function mergeSystemMessagesIntoFirstUser(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const systemParts = [];
  const dialogue = [];
  for (const msg of list) {
    const text = messagePartToPlainText(msg).trim();
    if (msg?.role === 'system' || msg?.role === 'developer') {
      if (text) systemParts.push(text);
    } else {
      dialogue.push(msg);
    }
  }
  if (!systemParts.length) return dialogue;
  const background = `[背景与设定]\n${systemParts.join('\n\n')}`;
  const firstUserIndex = dialogue.findIndex((message) => message?.role === 'user');
  if (firstUserIndex < 0) return [{ role: 'user', content: background }, ...dialogue];
  const firstUser = dialogue[firstUserIndex];
  const content = firstUser?.content;
  if (Array.isArray(content)) {
    dialogue[firstUserIndex] = {
      ...firstUser,
      content: [{ type: 'text', text: `${background}\n\n[当前用户消息]` }, ...content],
    };
  } else {
    const userText = String(content || '').trim();
    dialogue[firstUserIndex] = {
      ...firstUser,
      content: userText ? `${background}\n\n[当前用户消息]\n${userText}` : background,
    };
  }
  return dialogue;
}

/** 各家 OpenAI 兼容网关对 Gemini 等模型的参数/消息形态差异 */
export function sanitizeChatCompletionsBody(body = {}) {
  const model = String(body.model || '');
  const next = { ...body };
  if (isGeminiLikeModel(model)) {
    delete next.frequency_penalty;
    delete next.presence_penalty;
    delete next.max_completion_tokens;
    const normalizedMessages = Array.isArray(next.messages) ? [...next.messages] : [];
    if (String(normalizedMessages[normalizedMessages.length - 1]?.role || '').trim().toLowerCase() === 'assistant') {
      normalizedMessages.push({ role: 'user', content: GEMINI_ASSISTANT_TAIL_CONTINUATION });
    }
    next.messages = normalizedMessages;
  }
  return next;
}

export function normalizeSamplingMode(value = '') {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'temperature' || mode === 'top_p' ? mode : 'auto';
}

/**
 * 采样参数全局互斥：避免 Claude 及兼容中转在收到 temperature + top_p 时拒绝请求。
 * 自动模式下 Claude 不发两者，其他模型只发 Temperature；高级用户可明确二选一。
 */
export function resolveSamplingParameters(options = {}) {
  const mode = normalizeSamplingMode(options.samplingMode);
  const model = String(options.model || '').trim();
  const endpointType = String(options.endpointType || '').trim().toLowerCase();
  const claudeLike = endpointType === 'anthropic' || /claude/i.test(model);
  const effectiveMode = mode === 'auto' ? (claudeLike ? 'none' : 'temperature') : mode;
  const temperature = Number(options.temperature);
  const topP = Number(options.topP);
  if (effectiveMode === 'temperature' && Number.isFinite(temperature)) {
    return { temperature };
  }
  if (effectiveMode === 'top_p' && Number.isFinite(topP)) {
    return { top_p: topP };
  }
  return {};
}

function googlePartFromOpenAiPart(part) {
  if (typeof part === 'string') return part ? { text: part } : null;
  if (!part || typeof part !== 'object') return null;
  if (typeof part.text === 'string') return part.text ? { text: part.text } : null;
  if (typeof part.content === 'string') return part.content ? { text: part.content } : null;
  const imageUrl = typeof part.image_url === 'string'
    ? part.image_url
    : String(part.image_url?.url || part.url || '');
  if (!imageUrl) return null;
  const dataMatch = imageUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataMatch) {
    return { inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } };
  }
  const cleanUrl = imageUrl.split(/[?#]/)[0];
  const ext = cleanUrl.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
  const mimeType = ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
        : 'image/jpeg';
  return { fileData: { mimeType, fileUri: imageUrl } };
}

function googlePartsFromMessage(message = {}) {
  if (Array.isArray(message?.parts)) return message.parts.filter(Boolean);
  if (message?.functionResponse || message?.function_response) {
    return [{ functionResponse: message.functionResponse || message.function_response }];
  }
  const content = message?.content;
  if (Array.isArray(content)) return content.map(googlePartFromOpenAiPart).filter(Boolean);
  const text = messagePartToPlainText(message).trim();
  return text ? [{ text }] : [];
}

export function buildGoogleGeminiRequestBody(messages = [], options = {}) {
  const systemParts = [];
  const contents = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const parts = googlePartsFromMessage(message);
    if (!parts.length) continue;
    if (message?.role === 'system' || message?.role === 'developer') {
      systemParts.push(...parts.filter((part) => typeof part?.text === 'string'));
      continue;
    }
    const role = message?.role === 'assistant' || message?.role === 'model' ? 'model' : 'user';
    const previous = contents[contents.length - 1];
    if (previous?.role === role) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }
  if (contents[contents.length - 1]?.role === 'model') {
    contents.push({ role: 'user', parts: [{ text: GEMINI_ASSISTANT_TAIL_CONTINUATION }] });
  }
  const generationConfig = {};
  const temperature = Number(options.temperature);
  const topP = Number(options.topP);
  const maxOutputTokens = Number(options.maxOutputTokens);
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  if (Number.isFinite(topP)) generationConfig.topP = topP;
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    generationConfig.maxOutputTokens = Math.floor(maxOutputTokens);
  }
  const thinkingLevel = String(options.thinkingLevel || '').trim().toLowerCase();
  if (['minimal', 'low', 'medium', 'high'].includes(thinkingLevel)) {
    generationConfig.thinkingConfig = { thinkingLevel };
  }
  const body = { contents };
  if (systemParts.length) body.systemInstruction = { parts: systemParts };
  if (Array.isArray(options.tools) && options.tools.length) body.tools = options.tools;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return body;
}

function anthropicPartFromOpenAiPart(part) {
  if (typeof part === 'string') return part ? { type: 'text', text: part } : null;
  if (!part || typeof part !== 'object') return null;
  if (typeof part.text === 'string') return part.text ? { type: 'text', text: part.text } : null;
  if (typeof part.content === 'string') return part.content ? { type: 'text', text: part.content } : null;
  const imageUrl = typeof part.image_url === 'string'
    ? part.image_url
    : String(part.image_url?.url || part.url || '');
  if (!imageUrl) return null;
  const dataMatch = imageUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataMatch) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] },
    };
  }
  return { type: 'image', source: { type: 'url', url: imageUrl } };
}

function anthropicPartsFromMessage(message = {}) {
  if (message?.role === 'assistant' && Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'tool_use')) {
    return message.content.filter((part) => ['text', 'tool_use'].includes(String(part?.type || '')));
  }
  if (message?.role === 'user' && Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'tool_result')) {
    return message.content.filter((part) => ['text', 'tool_result'].includes(String(part?.type || '')));
  }
  if (Array.isArray(message?.content)) {
    return message.content.map(anthropicPartFromOpenAiPart).filter(Boolean);
  }
  const text = messagePartToPlainText(message).trim();
  return text ? [{ type: 'text', text }] : [];
}

export function buildAnthropicRequestBody(messages = [], options = {}) {
  const systemParts = [];
  const anthropicMessages = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const parts = anthropicPartsFromMessage(message);
    if (!parts.length) continue;
    if (message?.role === 'system' || message?.role === 'developer') {
      systemParts.push(...parts.filter((part) => part?.type === 'text').map((part) => part.text));
      continue;
    }
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const previous = anthropicMessages[anthropicMessages.length - 1];
    if (previous?.role === role) previous.content.push(...parts);
    else anthropicMessages.push({ role, content: parts });
  }
  const maxTokens = Number(options.maxTokens);
  const body = {
    model: String(options.model || '').trim(),
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.floor(maxTokens)
      : DEFAULT_CHAT_CONFIG.maxTokens,
    messages: anthropicMessages,
    stream: options.stream === true,
  };
  if (Array.isArray(options.tools) && options.tools.length) body.tools = options.tools;
  if (systemParts.length) body.system = systemParts.join('\n\n');
  Object.assign(body, resolveSamplingParameters({
    samplingMode: options.samplingMode,
    temperature: options.temperature,
    topP: options.topP,
    model: options.model,
    endpointType: 'anthropic',
  }));
  return body;
}

/** Combine caller signal with client-side timeouts; err.timeoutStage tells which fired. */
function createTimeoutSignal(baseSignal, { firstByteTimeoutMs, totalTimeoutMs } = {}) {
  const controller = new AbortController();
  let timeoutStage = '';
  const timers = [];
  const abortWith = (stage) => {
    timeoutStage = stage;
    try { controller.abort(); } catch (_) {}
  };
  if (Number(totalTimeoutMs) > 0) {
    timers.push(setTimeout(() => abortWith('total'), Number(totalTimeoutMs)));
  }
  let firstByteTimer = null;
  if (Number(firstByteTimeoutMs) > 0) {
    firstByteTimer = setTimeout(() => abortWith('first_byte'), Number(firstByteTimeoutMs));
    timers.push(firstByteTimer);
  }
  const onBaseAbort = () => { try { controller.abort(); } catch (_) {} };
  if (baseSignal) {
    if (baseSignal.aborted) onBaseAbort();
    else baseSignal.addEventListener?.('abort', onBaseAbort, { once: true });
  }
  return {
    signal: controller.signal,
    markFirstByte() {
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
    },
    cleanup() {
      timers.forEach((t) => clearTimeout(t));
      baseSignal?.removeEventListener?.('abort', onBaseAbort);
    },
    getTimeoutStage: () => timeoutStage,
    wasUserAbort: () => !!baseSignal?.aborted,
    getAbortReason: () => String(baseSignal?.marshmallowAbortReason || ''),
  };
}

/** Client-side hang guards; generous so slow thinking models are never cut off by default. */
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 900_000;
// finish_reason 是上游语义结束信号，不一定代表 SSE 字节已经全部到齐。部分兼容
// 中转会把它错误地挂在很早的 delta 上；正常收尾多等一会，明显残缺的协议前缀
// 则进入单独保护窗口，不能再把半个控制标记当完整回复返回。
const DEFAULT_STREAM_FINISH_GRACE_MS = 1_200;
const DEFAULT_SUSPICIOUS_FINISH_GRACE_MS = 30_000;

export async function chatWithConfig(config, messages, options = {}) {
  const googleGemini = isGoogleGeminiEndpoint(config);
  const anthropic = isAnthropicEndpoint(config);
  const nativeProvider = googleGemini || anthropic;
  const requestModel = options.model || config.model;
  const taskOperation = String(options.auditContext?.operation || '').trim();
  if (
    googleGemini
    && taskOperation === 'chatSummary'
    && isGeminiTextTaskModelUnsupported(requestModel)
  ) {
    const error = new Error(
      `聊天摘要不能使用 ${requestModel}；请选择 Gemini 文本模型，例如 gemini-3.1-flash-lite。`,
    );
    error.code = 'unsupported_text_task_model';
    throw error;
  }
  const wantStream = !!(options.stream ?? false);
  const url = googleGemini
    ? buildGoogleGeminiContentUrl(config.baseUrl, requestModel, { stream: wantStream })
    : anthropic
      ? buildAnthropicMessagesUrl(config.baseUrl)
      : buildApiUrl(config.baseUrl, '/v1/chat/completions');
  if (isNativeAppShell() && !isAbsoluteHttpUrl(url)) {
    throw new Error('App 内请在「API 管理」填写完整可直连的接口地址（https 公网，或 http://192.168.x.x 局域网中转）。当前为空或不是绝对地址，请求会打到本地页面而不是模型接口。');
  }
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    if (googleGemini) headers['x-goog-api-key'] = config.apiKey;
    else if (anthropic) headers['x-api-key'] = config.apiKey;
    else headers.Authorization = `Bearer ${config.apiKey}`;
  }
  if (anthropic) {
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  Object.assign(headers, config.customHeaders || {});
  const generationTask = options.generationTask && typeof options.generationTask === 'object'
    ? options.generationTask
    : null;
  const auditContext = normalizeApiAuditContext(options.auditContext);
  // 只有明确声明服务端支持幂等时才发送自定义头，避免第三方直连增加
  // CORS 预检负担，也不把“本地有稳定 ID”误当成“服务端会去重”。
  if (!nativeProvider && generationTask?.supportsServerIdempotency === true) {
    const idempotencyKey = String(generationTask.idempotencyKey || '').trim();
    const taskId = String(generationTask.taskId || '').trim();
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (taskId) headers['X-Marshmallow-Task-Id'] = taskId;
  }

  const omitMaxTokens = options.maxTokens === null || options.omitMaxTokens === true;
  let max_tokens = null;
  if (!omitMaxTokens) {
    const rawMax = options.maxTokens ?? config.maxTokens;
    max_tokens = Number(rawMax);
    if (!Number.isFinite(max_tokens) || max_tokens <= 0) {
      max_tokens = Number(config.maxTokens);
    }
    if (!Number.isFinite(max_tokens) || max_tokens <= 0) max_tokens = DEFAULT_CHAT_CONFIG.maxTokens;
    max_tokens = Math.floor(max_tokens);
  }

  const includesVision = hasVisionImagesInMessages(messages);

  const firstByteTimeoutMs = Number(options.firstByteTimeoutMs) > 0
    ? Number(options.firstByteTimeoutMs) : DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  const totalTimeoutMs = Number(options.totalTimeoutMs) > 0
    ? Number(options.totalTimeoutMs) : DEFAULT_TOTAL_TIMEOUT_MS;
  const streamIdleTimeoutMs = Number(options.streamIdleTimeoutMs) > 0
    ? Number(options.streamIdleTimeoutMs) : DEFAULT_STREAM_IDLE_TIMEOUT_MS;

  const runOnce = async (streamMode) => {
    // 网页/PWA 与 APK 都必须尊重各功能的 stream 设置。用户选择流式时，
    // 新版 APK 再由 MarshmallowHttp 在原生层持续读 SSE、落盘并交给 JS 解析。
    const requestedStream = !!streamMode;
    const nativeBufferedStream = requestedStream
      && options.nativeBufferedStream !== false
      && isNativeAppShell()
      && getNativeHttpTransport() === 'marshmallow-http';
    // nativeBufferedStream 只改变已开启流式时的收包位置，不能把非流式请求
    // 静默改成 SSE，否则 API 控制台与应用诊断都会显示为流式。
    let requestStream = requestedStream;
    // 页面是否可见只影响增量 UI，不得覆盖用户/会话预设的 stream 选择。
    // 网页/PWA 被系统冻结时可能延后消费分片；新版 APK 则由原生层持续缓冲 SSE。
    const requestUrl = googleGemini
      ? buildGoogleGeminiContentUrl(config.baseUrl, requestModel, { stream: requestStream })
      : url;
    const nativeAvailable = hasNativeHttp() && isAbsoluteHttpUrl(requestUrl);
    const correlationId = makeCorrelationId();
    const nativeRequestId = generationTask?.taskId
      ? `${generationTask.taskId}:${correlationId}`
      : `chat_native:${correlationId}`;
    const startedAt = Date.now();
    let sawPageHidden = isDocumentHidden();
    // 幂等线路（网页/PWA）：流式进行中切后台时，主动断开 SSE、按同一 Idempotency-Key
    // 改发非流式请求。挂起页面读不动流，中转常在客户端停止消费后掐掉连接；整包响应
    // 则能在后台由网络栈收完、回前台即拿全文。服务端凭幂等键去重，不会重复计费。
    // APK 有前台服务与网络租约护流，不做切换；非幂等线路为避免重复扣费也不切。
    // 生成请求只发一次。即使线路声明支持幂等，也不在切后台后自动改用
    // 非流式重发；避免第三方实现不完整时产生第二条计费记录。
    const armBackgroundStreamSwitch = false;
    let backgroundStreamSwitchTriggered = false;
    const streamSwitchController = armBackgroundStreamSwitch ? new AbortController() : null;
    const onRequestVisibilityChange = () => {
      if (!isDocumentHidden()) return;
      sawPageHidden = true;
      if (streamSwitchController && !backgroundStreamSwitchTriggered) {
        backgroundStreamSwitchTriggered = true;
        try { streamSwitchController.abort(); } catch (_) {}
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onRequestVisibilityChange);
    }
    // Non-stream completions only send headers after the whole reply is generated,
    // so a first-byte guard would kill legitimate slow generations; total cap only.
    const timeout = createTimeoutSignal(options.signal, {
      firstByteTimeoutMs: requestStream ? firstByteTimeoutMs : 0,
      totalTimeoutMs,
    });
    // 后台切换需要第二个中止源；只在武装时合并信号，平时不多挂监听。
    let requestSignal = timeout.signal;
    let cleanupStreamSwitchSignal = () => {};
    if (streamSwitchController) {
      const merged = new AbortController();
      const forwardAbort = () => { try { merged.abort(); } catch (_) {} };
      timeout.signal.addEventListener('abort', forwardAbort, { once: true });
      streamSwitchController.signal.addEventListener('abort', forwardAbort, { once: true });
      if (timeout.signal.aborted || streamSwitchController.signal.aborted) forwardAbort();
      requestSignal = merged.signal;
      cleanupStreamSwitchSignal = () => {
        timeout.signal.removeEventListener('abort', forwardAbort);
        streamSwitchController.signal.removeEventListener('abort', forwardAbort);
      };
    }
    const stat = {
      correlationId,
      usedUrl: requestUrl,
      model: '',
      requestStream,
      responseStream: requestStream,
      viaGenerationRelay: false,
      viaNativeHttp: false,
      nativeHttpTransport: '',
      viaProxyFallback: false,
      status: null,
      buildMs: Number.isFinite(Number(options.buildMs)) ? Number(options.buildMs) : null,
      audit: auditContext,
    };
    let ttfbMs = null;
    const streamStats = {};
    const publishRequestStat = (value = {}) => {
      const entry = { ...stat, ...value };
      try {
        if (typeof options.onRequestStat === 'function') options.onRequestStat(entry);
      } catch (_) {
        // Diagnostics callbacks must never break the request.
      }
      recordApiRequestStat(entry);
    };

    const finalizeError = (rawErr) => {
      let err = rawErr instanceof Error ? rawErr : new Error(String(rawErr?.message || rawErr || '请求失败'));
      const stage = timeout.getTimeoutStage();
      const abortLike = err?.name === 'AbortError' || /abort|请求已取消/i.test(String(err?.message || ''));
      if (stage && !timeout.wasUserAbort() && abortLike) {
        const wrapped = new Error(stage === 'first_byte'
          ? `等待接口响应超时（${Math.round(firstByteTimeoutMs / 1000)} 秒内无首字节）。多为中转排队、模型冷启动或网络不通，可稍后重试或换线路。`
          : `请求总时长超限（${Math.round(totalTimeoutMs / 60000)} 分钟），已中断等待。`);
        wrapped.timeoutStage = stage;
        wrapped.cause = err;
        if (err?.partialText) wrapped.partialText = err.partialText;
        err = wrapped;
      }
      if (timeout.wasUserAbort()) {
        err.abortReason = timeout.getAbortReason() || 'user';
      }
      err.correlationId = correlationId;
      err.usedUrl = err.usedUrl || stat.usedUrl || requestUrl;
      err.requestModel = err.requestModel || stat.model || '';
      err.requestStream = err.requestStream ?? stat.requestStream;
      err.streamStats = {
        ...streamStats,
        status: err?.status ?? stat.status,
        durationMs: Date.now() - startedAt,
        ttfbMs,
        sawPageHidden,
        viaNativeHttp: stat.viaNativeHttp,
        nativeHttpTransport: stat.nativeHttpTransport,
        nativeRequestId: String(err?.nativeRequestId || stat.nativeRequestId || nativeRequestId || ''),
        nativeTaskState: err?.nativeTaskState || null,
        nativeErrorCode: String(err?.nativeErrorCode || ''),
        nativeErrorMessage: String(err?.nativeErrorMessage || ''),
        viaProxyFallback: stat.viaProxyFallback,
      };
      return err;
    };

    // fetch 流式请求全程挂前台服务网络租约，切后台时系统尽量不掐网。
    // 走原生兜底通道时 Java 侧会另挂一份按请求 ID 配对的租约，互不误释放。
    const holdingNetworkLease = nativeAvailable
      ? await acquireNetworkLease({ timeoutMs: totalTimeoutMs + 60_000 })
      : false;

    try {
      const useSystemMergeCompat = (options.singleUserCompat ?? config.singleUserCompat) === true
        && !hasVisionImagesInMessages(messages);
      const requestedTemperature = options.temperature ?? config.temperature;
      const requestedTopP = options.topP ?? config.topP;
      const samplingMode = normalizeSamplingMode(options.samplingMode ?? config.samplingMode);
      const body = {
        model: requestModel,
        messages: useSystemMergeCompat ? mergeSystemMessagesIntoFirstUser(messages) : messages,
        ...resolveSamplingParameters({
          samplingMode,
          temperature: requestedTemperature,
          topP: requestedTopP,
          model: requestModel,
          endpointType: config.endpointType,
        }),
        frequency_penalty: options.frequencyPenalty ?? config.frequencyPenalty,
        presence_penalty: options.presencePenalty ?? config.presencePenalty,
        stream: requestStream,
      };
      if (Array.isArray(options.tools) && options.tools.length) body.tools = options.tools;
      if (options.toolChoice != null) body.tool_choice = options.toolChoice;
      if (max_tokens !== null) body.max_tokens = max_tokens;
      const reasoningEffort = String(options.reasoningEffort ?? config.reasoningEffort ?? '').trim();
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;
      const requestBody = googleGemini
        ? buildGoogleGeminiRequestBody(body.messages, {
          temperature: body.temperature,
          topP: body.top_p,
          maxOutputTokens: body.max_tokens,
          thinkingLevel: resolveGoogleGeminiThinkingLevel(
            requestModel,
            options.reasoningEffort ?? config.reasoningEffort,
            auditContext.operation,
          ),
          tools: body.tools,
        })
        : anthropic
          ? buildAnthropicRequestBody(body.messages, {
            model: requestModel,
            maxTokens: body.max_tokens,
            samplingMode,
            temperature: requestedTemperature,
            topP: requestedTopP,
            stream: requestStream,
            tools: body.tools,
          })
          : sanitizeChatCompletionsBody(body);
      stat.model = requestModel || '';
      const relayPrefs = getGenerationRelayPrefs();
      let transportResult;
      let responseStream = requestStream;
      if (!nativeProvider && generationTask && isGenerationRelayEnabled(relayPrefs)) {
        const relay = await runGenerationRelayCompletion(requestBody, {
          taskId: generationTask.taskId,
          idempotencyKey: generationTask.idempotencyKey,
          signal: timeout.signal,
          prefs: relayPrefs,
          // 跟随当前聊天/覆盖 API；Cloudflare 中继按任务使用，切换线路不必改 Worker。
          upstream: {
            url: requestUrl,
            apiKey: String(config.apiKey || '').trim(),
            customHeaders: config.customHeaders || {},
          },
          onJob: options.onRelayJob,
          onProgress: (progress) => {
            timeout.markFirstByte();
            options.onTransportProgress?.({ ...progress, transport: 'self-host-relay' });
          },
        });
        transportResult = {
          res: new Response(JSON.stringify(relay.result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
          usedUrl: `${relayPrefs.baseUrl}/jobs/${relay.remoteJobId}`,
          viaNativeHttp: false,
          nativeHttpTransport: 'self-host-relay',
        };
        // 中继已按 requestStream 调用上游，但给 App 的任务结果是合并后的 JSON。
        responseStream = false;
        stat.viaGenerationRelay = true;
      } else {
        transportResult = await postJsonWithOptionalProxy(requestUrl, {
          headers,
          body: requestBody,
          // 普通原生兜底仍改要非流式 JSON；新版 APK 文本补全通道则保留 SSE，
          // 由 Java 边收边落盘，不依赖 WebView 在后台持续执行 JS。
          nativeBody: requestStream && !googleGemini && !nativeBufferedStream
            ? { ...requestBody, stream: false }
            : null,
          nativeUrl: googleGemini && requestStream && !nativeBufferedStream
            ? buildGoogleGeminiContentUrl(config.baseUrl, requestModel, { stream: false })
            : '',
          proxyFallbackUrl: nativeProvider ? '' : '/api/v1/chat/completions',
          signal: requestSignal,
          // 非流式在模型生成完整包之前通常拿不到响应头；这里若仍沿用
          // 120 秒连接上限，会出现上游控制台已有正文、App 却先超时拿到 0 字符。
          // 流式保留连接阶段上限，非流式只由完整请求总时限兜底。
          connectTimeout: requestStream
            ? Math.min(firstByteTimeoutMs, 120_000)
            : totalTimeoutMs,
          readTimeout: totalTimeoutMs,
          correlationId,
          allowRequestReplay: false,
          preferNative: nativeBufferedStream || !requestStream,
          nativeStreamResponse: nativeBufferedStream,
          nativeRequestId,
          onNativeRequestStart: options.onNativeRequestStart,
          onRequestQueued: options.onNativeRequestQueued || options.onRequestQueued,
          // 原生非流式在整包生成完之前不会有任何字节，首字节看门狗必须停用。
          onNativeTransport: () => {
            // 原生调用可能在返回 transportResult 之前失败；必须在发起时就登记，
            // 否则超时诊断会把真实的原生 HTTP 误写成“浏览器直连流”。
            stat.viaNativeHttp = true;
            stat.nativeHttpTransport = getNativeHttpTransport();
            timeout.markFirstByte();
          },
        });
      }
      const {
        res,
        usedUrl,
        viaNativeHttp,
        nativeHttpTransport,
      } = transportResult;
      if (viaNativeHttp === true) {
        // 新版 APK 文本补全的原生通道返回的是已落盘完整 SSE，仍需走流协议解析。
        // 其它原生兜底才是非流式 JSON。
        if (!nativeBufferedStream) {
          requestStream = false;
          responseStream = false;
          stat.requestStream = false;
        }
        stat.nativeRequestId = String(res?.nativeRequestId || nativeRequestId || '');
        stat.recoveredFromNativeTaskState = res?.recoveredFromTaskState === true;
      }
      stat.usedUrl = usedUrl;
      stat.viaNativeHttp = viaNativeHttp === true;
      stat.nativeHttpTransport = nativeHttpTransport || '';
      stat.viaProxyFallback = usedUrl !== requestUrl;
      stat.status = res.status;
      stat.responseStream = responseStream;
      // Non-stream responses have no incremental first-byte signal.
      if (!responseStream) {
        ttfbMs = Date.now() - startedAt;
        timeout.markFirstByte();
      }
      const recordHttpError = (err) => {
        if (usedUrl === '/api/v1/chat/completions') markApiProxyUnavailable(err);
        err.usedUrl = usedUrl;
        err.requestModel = requestModel || '';
        err.requestStream = requestStream;
        err.requestMethod = 'POST';
        err.requestPath = getSafeRequestPath(usedUrl);
        err.correlationId = correlationId;
        recordApiError(err, {
          usedUrl,
          correlationId,
          durationMs: Date.now() - startedAt,
          requestModel: requestModel || '',
          requestStream,
          requestMethod: 'POST',
          requestPath: getSafeRequestPath(usedUrl),
          status: err.status || res.status,
          responseText: err.responseText || '',
        });
        err.apiErrorRecorded = true;
      };
      if (!res.ok) {
        try {
          await parseApiJsonResponse(res);
        } catch (err) {
          recordHttpError(err);
          throw err;
        }
      }
      if (responseStream) {
        const text = await readStream(res, {
          // 用户关闭“流式输出”时仅关闭前台逐字回调；原生层仍持续收包。
          onChunk: requestedStream ? options.onChunk : undefined,
          onRawSseFragment: options.onRawSseFragment,
          onTransportProgress: options.onTransportProgress,
          onFinishReason: options.onFinishReason,
          onCompletionMeta: options.onCompletionMeta,
          requestModel: requestModel || '',
          usedUrl,
          requestStream,
          correlationId,
          stats: streamStats,
          idleTimeoutMs: streamIdleTimeoutMs,
          onFirstByte: () => {
            if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
            timeout.markFirstByte();
          },
        });
        const streamTextLength = String(text || '').length;
        const streamErrorKind = !String(text || '').trim()
          ? (
            Number(streamStats.reasoningLength || 0) > 0
            || Number(streamStats.reasoningTokens || 0) > 0
              ? 'reasoning_only'
              : 'empty_content'
          )
          : (streamStats.finishReason === 'length' ? 'finish_length' : '');
        publishRequestStat({
          ...streamStats,
          ok: !streamErrorKind,
          durationMs: Date.now() - startedAt,
          ttfbMs,
          contentLength: streamTextLength,
          errorKind: streamErrorKind,
        });
        return text;
      }
      let data = null;
      try {
        data = await parseApiJsonResponse(res);
      } catch (err) {
        recordHttpError(err);
        throw err;
      }
      if (typeof options.onRawResponse === 'function') {
        try {
          options.onRawResponse(JSON.stringify(data ?? null), data);
        } catch (_) {
          // Diagnostics callbacks must never break the request.
        }
      }
      const completionMeta = buildCompletionMeta(data, requestModel || '');
      const finishReason = completionMeta.finishReason;
      if (finishReason && typeof options.onFinishReason === 'function') {
        options.onFinishReason(finishReason);
      }
      emitCompletionMeta(options, completionMeta);
      logUpstreamFinishLength(completionMeta, {
        requestModel: requestModel || '',
        requestStream,
        usedUrl,
        correlationId,
      });
      if (options.returnRawResponse === true) {
        publishRequestStat({
          ok: true,
          durationMs: Date.now() - startedAt,
          ttfbMs,
          finishReason,
          contentLength: JSON.stringify(data || null).length,
          errorKind: '',
        });
        return data;
      }
      let text = extractCompletionText(data);
      const reasoningLength = extractReasoningText(data).length;
      if (!String(text || '').trim()) {
        appendDebugEvent({
          type: 'api_empty_completion',
          level: 'warn',
          message: reasoningLength || Number(completionMeta.reasoningTokens || 0) > 0
            ? 'API 仅返回原生推理，未返回正文'
            : 'API 返回成功但未提取到正文',
          usedUrl,
          status: res.status,
          correlationId,
          requestModel: requestModel || '',
          requestStream,
          finishReason,
          reasoningLength,
          reasoningTokens: Number(completionMeta.reasoningTokens || 0),
          raw: JSON.stringify(data || null),
        });
      }
      const completionErrorKind = !String(text || '').trim()
        ? (
          reasoningLength > 0
          || Number(completionMeta.reasoningTokens || 0) > 0
            ? 'reasoning_only'
            : 'empty_content'
        )
        : (finishReason === 'length' ? 'finish_length' : '');
      publishRequestStat({
        ok: !completionErrorKind,
        durationMs: Date.now() - startedAt,
        ttfbMs,
        finishReason,
        contentLength: String(text || '').length,
        reasoningLength,
        reasoningTokens: Number(completionMeta.reasoningTokens || 0),
        errorKind: completionErrorKind,
      });
      // Buffered/non-stream paths still notify progressive UI once at completion.
      if (streamMode && typeof options.onChunk === 'function' && String(text || '').trim()) {
        options.onChunk(text);
      }
      return text;
    } catch (rawErr) {
      // 后台切换主动中止的流不算失败：抛出标记错误，由 chat() 立即改发非流式。
      if (backgroundStreamSwitchTriggered && !timeout.wasUserAbort() && !timeout.getTimeoutStage()) {
        appendDebugEvent({
          type: 'background_stream_switch',
          level: 'info',
          message: '生成期间页面切入后台：断开流式，按同一幂等键改发非流式请求',
          usedUrl: stat.usedUrl || url,
          correlationId,
          requestModel: stat.model || '',
        });
        publishRequestStat({
          ...streamStats,
          ok: false,
          durationMs: Date.now() - startedAt,
          ttfbMs,
          errorKind: 'background_stream_switch',
          errorMessage: '切后台改非流式重发',
        });
        const switchErr = new Error('页面切入后台，本轮已改用非流式接收重发');
        switchErr.backgroundStreamSwitch = true;
        switchErr.correlationId = correlationId;
        throw switchErr;
      }
      const err = finalizeError(rawErr);
      // 连接在收到 HTTP 响应头之前断开时，上方 recordHttpError 没有机会执行。
      // 单写 request_stat 会让用户的反馈包看起来像“根本没有 API 失败”。
      if (err.apiErrorRecorded !== true && !timeout.wasUserAbort()) {
        recordApiError(err, {
          usedUrl: err.usedUrl || stat.usedUrl || requestUrl,
          correlationId,
          durationMs: Date.now() - startedAt,
          requestModel: err.requestModel || stat.model || '',
          requestStream: err.requestStream ?? stat.requestStream,
          requestMethod: 'POST',
          requestPath: getSafeRequestPath(err.usedUrl || stat.usedUrl || requestUrl),
          status: err.status ?? stat.status,
          nativeRequestId: err.streamStats?.nativeRequestId || '',
          nativeTaskState: err.streamStats?.nativeTaskState || null,
          nativeErrorCode: err.streamStats?.nativeErrorCode || '',
          nativeErrorMessage: err.streamStats?.nativeErrorMessage || '',
        });
        err.apiErrorRecorded = true;
      }
      publishRequestStat({
        ...streamStats,
        ok: false,
        durationMs: Date.now() - startedAt,
        ttfbMs,
        errorKind: classifyErrorKind(err, {
          status: err?.status ?? stat.status,
          abortReason: err?.abortReason,
        }),
        errorMessage: err?.message || String(err),
      });
      throw err;
    } finally {
      if (holdingNetworkLease) releaseNetworkLease(holdingNetworkLease);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onRequestVisibilityChange);
      }
      cleanupStreamSwitchSignal();
      timeout.cleanup();
    }
  };

  if (!wantStream) {
    return runOnce(false);
  }
  try {
    return await runOnce(true);
  } catch (e) {
    if (getStreamPartialText(e).length >= 16) throw wrapStreamTransportError(e, url);
    throw wrapStreamTransportError(e, url);
  }
}

function completionReasoningTokens(usage = null) {
  if (!usage || typeof usage !== 'object') return 0;
  const candidates = [
    usage.reasoning_tokens,
    usage.reasoningTokens,
    usage.thoughtsTokenCount,
    usage.thoughts_token_count,
    usage.completion_tokens_details?.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
  ];
  for (const value of candidates) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return 0;
}

function buildCompletionMeta(json = {}, requestModel = '') {
  const choice = json?.choices?.[0] || {};
  const candidate = json?.candidates?.[0] || {};
  const promptFeedback = json?.promptFeedback || json?.prompt_feedback || {};
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const responsePartKinds = [...new Set(parts.map((part) => {
    if (part?.thought === true) return 'thought';
    if (typeof part?.text === 'string' || typeof part?.content === 'string') return 'text';
    if (part?.inlineData || part?.inline_data) return 'inline-data';
    if (part?.fileData || part?.file_data) return 'file-data';
    if (part?.functionCall || part?.function_call) return 'function-call';
    return 'other';
  }).filter(Boolean))];
  // Gemini-style payloads put the stop signal on candidates[0].finishReason.
  const geminiFinish = candidate.finishReason || candidate.finish_reason || '';
  const anthropicFinish = json?.stop_reason || json?.delta?.stop_reason || json?.message?.stop_reason || '';
  const rawFinishReason = String(choice.finish_reason || geminiFinish || anthropicFinish || '').trim();
  const finishReason = /^(MAX_TOKENS|max_tokens)$/i.test(rawFinishReason)
    ? 'length'
    : /^(STOP|end_turn|stop_sequence)$/i.test(rawFinishReason) ? 'stop' : rawFinishReason;
  const usage = json?.usage || json?.usageMetadata || json?.message?.usage || null;
  const reasoningText = extractReasoningText(json);
  return {
    finishReason,
    rawFinishReason,
    promptBlockReason: String(promptFeedback?.blockReason || promptFeedback?.block_reason || '').trim(),
    finishMessage: String(candidate?.finishMessage || candidate?.finish_message || '').trim(),
    safetyRatings: candidate?.safetyRatings || promptFeedback?.safetyRatings || [],
    responsePartKinds,
    usage,
    reasoningTokens: completionReasoningTokens(usage),
    reasoningText,
    model: String(json?.model || json?.modelVersion || json?.message?.model || '').trim(),
    id: String(json?.id || json?.message?.id || '').trim(),
    requestModel: String(requestModel || '').trim(),
  };
}

function emitCompletionMeta(options = {}, meta = {}) {
  if (typeof options.onCompletionMeta !== 'function') return;
  options.onCompletionMeta(meta);
}

function logUpstreamFinishLength(meta = {}, context = {}) {
  if (meta.finishReason !== 'length') return;
  appendDebugEvent({
    type: 'api_finish_length',
    level: 'warn',
    message: '上游 finish_reason=length，输出未完成',
    finishReason: meta.finishReason,
    requestModel: meta.requestModel || context.requestModel || '',
    responseModel: meta.model || '',
    responseId: meta.id || '',
    usage: meta.usage || null,
    requestStream: context.requestStream,
    usedUrl: context.usedUrl || '',
    correlationId: context.correlationId || '',
  });
}

/** 兼容各家 OpenAI 套壳返回字段差异 */
function extractVisibleContentValue(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => extractVisibleContentValue(part, depth + 1)).join('');
  }
  if (typeof value !== 'object') return '';
  const type = String(value.type || '').trim().toLowerCase();
  if (
    value.thought === true
    || ['reasoning', 'thinking', 'analysis', 'reasoning_text', 'thinking_text'].includes(type)
  ) {
    return '';
  }
  if (typeof value.text === 'string') return value.text;
  if (typeof value.text?.value === 'string') return value.text.value;
  if (typeof value.output_text === 'string') return value.output_text;
  if (typeof value.value === 'string' && ['output_text', 'text'].includes(type)) return value.value;
  if (Array.isArray(value.parts)) return extractVisibleContentValue(value.parts, depth + 1);
  if (value.content != null && value.content !== value) {
    return extractVisibleContentValue(value.content, depth + 1);
  }
  if (value.message != null && value.message !== value) {
    return extractVisibleContentValue(value.message, depth + 1);
  }
  return '';
}

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  return extractVisibleContentValue(message.content);
}

function extractCompletionText(data, depth = 0) {
  if (!data || depth > 4) return '';
  if (typeof data === 'string') return data;

  const choices = Array.isArray(data.choices) ? data.choices : [];
  for (const choice of choices) {
    const fromMessage = extractMessageText(choice?.message);
    if (fromMessage) return fromMessage;
    const fromDelta = extractVisibleContentValue(choice?.delta);
    if (fromDelta) return fromDelta;
    if (typeof choice?.text === 'string' && choice.text) return choice.text;
  }

  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const fromOutput = extractVisibleContentValue(data.output);
  if (fromOutput) return fromOutput;
  const fromResponse = extractVisibleContentValue(data.response);
  if (fromResponse) return fromResponse;
  if (typeof data.response === 'string' && data.response) return data.response;

  const anthropicText = extractAnthropicText(data);
  if (anthropicText) return anthropicText;
  const geminiText = extractGeminiFallbackText(data);
  if (geminiText) return geminiText;

  for (const wrapper of [data.data, data.result, data.response]) {
    if (!wrapper || wrapper === data) continue;
    const wrappedText = extractCompletionText(wrapper, depth + 1);
    if (wrappedText) return wrappedText;
  }
  return '';
}

function extractAnthropicText(data) {
  const parts = data?.content;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part?.type === 'text')
    .map((part) => String(part?.text || ''))
    .join('');
}

function extractGeminiFallbackText(data) {
  if (!data) return '';
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const text = extractVisibleContentValue(parts);
    if (text.trim()) return text;
  }
  return '';
}

function extractReasoningValue(value, depth = 0) {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => extractReasoningValue(part, depth + 1)).join('');
  }
  if (typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.text?.value === 'string') return value.text.value;
  if (typeof value.value === 'string') return value.value;
  if (value.content != null && value.content !== value) {
    return extractReasoningValue(value.content, depth + 1);
  }
  if (value.reasoning != null && value.reasoning !== value) {
    return extractReasoningValue(value.reasoning, depth + 1);
  }
  return '';
}

function extractReasoningText(data) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || choice.delta || {};
  const direct = message.reasoning_content ?? message.reasoning ?? message.reasoning_details;
  const directText = extractReasoningValue(direct);
  if (directText) return directText;
  if (data?.delta?.type === 'thinking_delta') {
    return String(data.delta.thinking || '');
  }
  if (Array.isArray(data?.content)) {
    return data.content
      .filter((part) => part?.type === 'thinking')
      .map((part) => extractReasoningValue(part?.thinking ?? part?.text ?? part))
      .join('');
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part?.thought === true)
    .map((part) => extractReasoningValue(part))
    .join('');
}

function extractStreamDeltaContent(choiceDelta) {
  const delta = choiceDelta || {};
  const content = extractVisibleContentValue(delta.content);
  if (content) return content;
  if (typeof delta.text === 'string') return delta.text;
  return '';
}

/**
 * 兼容把「截至当前的完整快照」塞进流式字段的中转。
 * 正常 SSE 每次给增量；少数兼容线路却会依次给 A、A+B。若仍直接 +=，
 * 页面和最终落库就会变成 A+A+B，看起来像思维草稿与正式答案都输出了一遍。
 */
export function mergeStreamText(previous = '', incoming = '') {
  const current = String(previous || '');
  const piece = String(incoming || '');
  if (!piece) return current;
  if (!current) return piece;
  // 短词或整句重复可能就是正常正文（“哈哈”“不要走”），不能做普通文本去重。
  // 只识别证据最强的累计快照：新片段更长，并完整包含当前已收正文作为前缀。
  if (current.length >= 8 && piece.length > current.length && piece.startsWith(current)) return piece;
  return current + piece;
}

/** 是否只收到了 `<<<CONTROL_MARKER>>>` 一类机器控制标记的残缺开头。 */
export function isIncompleteStreamControlPrefix(value = '') {
  const text = String(value || '').trim();
  if (!text || text.length > 80) return false;
  return !text.endsWith('>>>') && /^<{1,3}[A-Z0-9_-]*>{0,2}$/i.test(text);
}

export async function readStream(response, streamOptions = {}) {
  const onChunk = streamOptions.onChunk;
  const onRawSseFragment = typeof streamOptions.onRawSseFragment === 'function'
    ? streamOptions.onRawSseFragment
    : null;
  const onTransportProgress = typeof streamOptions.onTransportProgress === 'function'
    ? streamOptions.onTransportProgress
    : null;
  const onFinishReason = streamOptions.onFinishReason;
  const onCompletionMeta = streamOptions.onCompletionMeta;
  const onFirstByte = typeof streamOptions.onFirstByte === 'function' ? streamOptions.onFirstByte : null;
  const requestModel = streamOptions.requestModel || '';
  const correlationId = streamOptions.correlationId || '';
  const shouldLogDebug = streamOptions.suppressDebugLog !== true;
  const stats = streamOptions.stats && typeof streamOptions.stats === 'object' ? streamOptions.stats : {};
  const idleTimeoutMs = Number(streamOptions.idleTimeoutMs) > 0
    ? Number(streamOptions.idleTimeoutMs)
    : 0;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let fullReasoningText = '';
  let reasoningLength = 0;
  let sawDone = false;
  let sawFirstByte = false;
  let chunkCount = 0;
  let byteCount = 0;
  let badLines = 0;
  let badLineSample = '';
  let latestMeta = buildCompletionMeta({}, requestModel);
  let finishSignalContentLength = null;
  let suspiciousFinishSignal = false;

  const publishStats = () => {
    stats.chunkCount = chunkCount;
    stats.byteCount = byteCount;
    stats.badSseLines = badLines;
    stats.sawDone = sawDone;
    stats.finishReason = latestMeta.finishReason || '';
    stats.reasoningLength = reasoningLength;
    stats.reasoningTokens = Number(latestMeta.reasoningTokens || 0);
  };

  const publishMeta = (json = {}) => {
    const next = buildCompletionMeta(json, requestModel);
    const nextReasoningText = String(next.reasoningText || '');
    if (nextReasoningText) {
      if (!fullReasoningText || nextReasoningText.startsWith(fullReasoningText)) {
        fullReasoningText = nextReasoningText;
      } else if (!fullReasoningText.endsWith(nextReasoningText)) {
        fullReasoningText += nextReasoningText;
      }
      reasoningLength = fullReasoningText.length;
    }
    latestMeta = {
      ...latestMeta,
      ...next,
      // A later data line without finish_reason must not clear an earlier one.
      finishReason: next.finishReason || latestMeta.finishReason,
      rawFinishReason: next.rawFinishReason || latestMeta.rawFinishReason,
      usage: next.usage || latestMeta.usage,
      reasoningTokens: next.reasoningTokens || latestMeta.reasoningTokens,
      reasoningText: fullReasoningText,
      model: next.model || latestMeta.model,
      id: next.id || latestMeta.id,
      responsePartKinds: next.responsePartKinds?.length
        ? next.responsePartKinds
        : latestMeta.responsePartKinds,
    };
    if (latestMeta.finishReason && typeof onFinishReason === 'function') {
      onFinishReason(latestMeta.finishReason);
    }
    emitCompletionMeta({ onCompletionMeta }, latestMeta);
  };

  const attachStreamEvidence = (error) => {
    if (!error || typeof error !== 'object') return error;
    error.upstreamMeta = {
      ...latestMeta,
      reasoningText: fullReasoningText,
    };
    if (fullReasoningText) error.reasoningText = fullReasoningText;
    return error;
  };

  const handleDataPayload = (payload) => {
    const text = String(payload || '').trim();
    if (!text) return;
    if (text === '[DONE]') { sawDone = true; return; }
    try {
      const json = JSON.parse(text);
      const hadFinishReason = !!latestMeta.finishReason;
      publishMeta(json);
      const choice = json.choices?.[0] || {};
      const deltaText = extractStreamDeltaContent(choice.delta);
      const messageText = extractMessageText(choice.message);
      const choiceText = typeof choice.text === 'string' ? choice.text : '';
      const geminiText = extractGeminiFallbackText(json);
      const anthropicText = json?.delta?.type === 'text_delta'
        ? String(json.delta.text || '')
        : '';
      const responsesDelta = json?.type === 'response.output_text.delta'
        ? String(json.delta || '')
        : '';
      const compatibleText = json?.type === 'response.completed' && fullText
        ? ''
        : extractCompletionText(json);
      if (json?.type === 'message_stop') sawDone = true;
      const piece = deltaText || messageText || choiceText || geminiText || anthropicText
        || responsesDelta || compatibleText;
      if (piece) {
        const previousText = fullText;
        fullText = mergeStreamText(fullText, piece);
        const appended = fullText.startsWith(previousText)
          ? fullText.slice(previousText.length)
          : piece;
        if (onChunk && (appended || fullText !== previousText)) onChunk(appended, fullText);
      }
      if (!hadFinishReason && latestMeta.finishReason) {
        finishSignalContentLength = fullText.length;
        suspiciousFinishSignal = isIncompleteStreamControlPrefix(fullText);
      } else if (
        latestMeta.finishReason
        && finishSignalContentLength !== null
        && fullText.length > finishSignalContentLength
      ) {
        // finish_reason 之后仍有正文，说明该中转的结束信号不可信；后续继续等
        // 真正的 [DONE] / EOF，不能再套普通短宽限期。
        suspiciousFinishSignal = true;
      }
    } catch (e) {
      badLines += 1;
      if (!badLineSample) badLineSample = text.slice(0, 200);
    }
  };

  const handleLine = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    // Tolerate "data:" with or without space, and ignore SSE comments/other fields.
    if (/^data:/i.test(trimmed)) {
      handleDataPayload(trimmed.replace(/^data:\s*/i, ''));
      return;
    }
    if (/^(event|id|retry):/i.test(trimmed) || trimmed.startsWith(':')) return;
    // Some relays emit raw JSON lines without the SSE prefix.
    if (trimmed.startsWith('{')) handleDataPayload(trimmed);
  };

  try {
    while (true) {
      let idleTimer = null;
      let finishGraceTimer = null;
      const readPromise = reader.read();
      const regularFinishGraceMs = Math.max(
        50,
        Number(streamOptions.finishGraceMs) || DEFAULT_STREAM_FINISH_GRACE_MS,
      );
      const suspiciousFinishGraceMs = Math.max(
        regularFinishGraceMs,
        Number(streamOptions.suspiciousFinishGraceMs) || DEFAULT_SUSPICIOUS_FINISH_GRACE_MS,
      );
      const finishGraceMs = latestMeta.finishReason
        ? (suspiciousFinishSignal ? suspiciousFinishGraceMs : regularFinishGraceMs)
        : 0;
      const waiters = [readPromise];
      if (idleTimeoutMs > 0) {
        waiters.push(
          new Promise((_, reject) => {
            idleTimer = setTimeout(() => {
              const error = new Error(`流式连接超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到新数据，已停止等待。`);
              error.timeoutStage = 'idle';
              error.streamIncomplete = true;
              reject(error);
            }, idleTimeoutMs);
          }),
        );
      }
      if (finishGraceMs > 0) {
        waiters.push(new Promise((resolve) => {
          finishGraceTimer = setTimeout(() => resolve({ protocolGraceExpired: true }), finishGraceMs);
        }));
      }
      const next = await Promise.race(waiters).finally(() => {
        if (idleTimer) clearTimeout(idleTimer);
        if (finishGraceTimer) clearTimeout(finishGraceTimer);
      });
      if (next?.protocolGraceExpired) {
        if (suspiciousFinishSignal) {
          try { await reader.cancel('suspicious-finish-reason'); } catch (_) {}
          const error = new Error('上游过早发送了 finish_reason，流式正文仍像未写完的协议片段；本轮未按成功结果接收。');
          error.streamIncomplete = true;
          error.finishReason = latestMeta.finishReason || '';
          error.partialText = fullText;
          throw attachStreamEvidence(error);
        }
        // 部分兼容中转已经发出 finish_reason，却一直不关闭 SSE 连接，也不补 [DONE]。
        // 结束信号后的短暂宽限期只用于接收 usage / message_stop；超时后正文应正常收尾。
        try { await reader.cancel('finish-reason-received'); } catch (_) {}
        break;
      }
      const { done, value } = next;
      if (done) break;
      if (!sawFirstByte) {
        sawFirstByte = true;
        if (onFirstByte) onFirstByte();
      }
      chunkCount += 1;
      byteCount += value?.byteLength || 0;
      if (onTransportProgress) {
        try {
          onTransportProgress({
            chunkCount,
            byteCount,
            contentLength: fullText.length,
            reasoningLength,
          });
        } catch (_) {
          // UI progress reporting must not interrupt stream parsing.
        }
      }

      const rawFragment = decoder.decode(value, { stream: true });
      if (rawFragment && onRawSseFragment) {
        try {
          onRawSseFragment(rawFragment, {
            chunkCount,
            byteCount,
            contentLength: fullText.length,
          });
        } catch (_) {
          // Checkpoint persistence must never interrupt stream parsing.
        }
      }
      buffer += rawFragment;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
      if (sawDone) {
        // [DONE] / message_stop 已是协议完成信号，不再等待中转关闭底层连接。
        try { await reader.cancel('stream-done-received'); } catch (_) {}
        break;
      }
    }
    // Flush decoder state and any final line without trailing newline.
    const decoderTail = decoder.decode();
    if (decoderTail && onRawSseFragment) {
      try { onRawSseFragment(decoderTail, { chunkCount, byteCount, contentLength: fullText.length }); } catch (_) {}
    }
    buffer += decoderTail;
    if (buffer.trim()) handleLine(buffer);
    buffer = '';
  } catch (e) {
    if (e?.timeoutStage === 'idle') {
      try { await reader.cancel(e); } catch (_) {}
    }
    publishStats();
    const wrapped = attachStreamEvidence(wrapStreamTransportError(attachStreamEvidence(e)));
    if (fullText.trim().length >= 16) wrapped.partialText = fullText;
    throw wrapped;
  }
  publishStats();

  // Connection closed cleanly at TCP level but the SSE protocol never finished:
  // no [DONE], no finish_reason. Treat as a mid-stream drop instead of silent success.
  const protocolComplete = sawDone || !!latestMeta.finishReason;
  if (!protocolComplete) {
    if (shouldLogDebug) appendDebugEvent({
      type: 'api_stream_incomplete',
      level: 'warn',
      message: `流式响应结束但未收到 [DONE]/finish_reason（chunks=${chunkCount}, 正文 ${fullText.length} 字, 坏行 ${badLines}）`,
      usedUrl: streamOptions.usedUrl || '',
      correlationId,
      requestModel,
      requestStream: true,
      context: { chunkCount, byteCount, badLines, badLineSample, contentLength: fullText.length, reasoningLength },
    });
    // reader 正常返回 done 且正文为空，说明浏览器确实收到了一个“正常闭合但无正文”的
    // HTTP 响应。它可能缺少 SSE 结束标记，但不应伪装成网络断线；交给上层按
    // empty_content / reasoning_only 归到模型或中转输出，并保留原始分片供排查。
    if (!fullText.trim()) {
      stats.protocolIncomplete = true;
    } else {
      const err = new Error('流式连接在返回中途断开（未收到 [DONE] / finish_reason），回复可能不完整。');
      err.streamIncomplete = true;
      err.partialText = fullText;
      throw attachStreamEvidence(err);
    }
  }
  if (badLines > 0) {
    if (shouldLogDebug) appendDebugEvent({
      type: 'api_stream_bad_lines',
      level: 'warn',
      message: `流式响应中有 ${badLines} 行无法解析（已跳过）`,
      usedUrl: streamOptions.usedUrl || '',
      correlationId,
      requestModel,
      requestStream: true,
      raw: badLineSample,
    });
  }
  if (!fullText.trim()) {
    if (shouldLogDebug) appendDebugEvent({
      type: 'api_empty_completion',
      level: 'warn',
      message: reasoningLength > 0 || Number(latestMeta.reasoningTokens || 0) > 0
        ? 'API 流式仅返回推理内容，未返回正文'
        : 'API 流式返回成功但正文为空',
      usedUrl: streamOptions.usedUrl || '',
      correlationId,
      requestModel,
      requestStream: true,
      finishReason: latestMeta.finishReason || '',
      reasoningLength,
      reasoningTokens: Number(latestMeta.reasoningTokens || 0),
      context: { chunkCount, byteCount, badLines },
    });
  }
  logUpstreamFinishLength(latestMeta, {
    requestModel,
    requestStream: streamOptions.requestStream,
    usedUrl: streamOptions.usedUrl || '',
    correlationId,
  });
  return fullText;
}

export async function chatStream(messages, onChunk, options = {}) {
  return chat(messages, { ...options, stream: true, onChunk });
}

/**
 * Minimal completion probe. It never includes chat history or character data.
 * The returned stats describe the transport actually used (native may force
 * non-streaming even when the stream probe is requested).
 */
export async function runChatApiProbe({ stream = false, signal = null } = {}) {
  let requestStat = null;
  let completionMeta = {};
  let chunkCount = 0;
  try {
    const text = await chat([
      { role: 'user', content: 'Reply with exactly: OK' },
    ], {
      stream: stream === true,
      signal,
      temperature: 0,
      firstByteTimeoutMs: 45_000,
      totalTimeoutMs: 90_000,
      // 非流式探针需要真的验证整包兼容性，不应用 APK 的生产请求 SSE 保活策略。
      nativeBufferedStream: stream === true ? undefined : false,
      onChunk: () => { chunkCount += 1; },
      onCompletionMeta: (meta) => { completionMeta = { ...completionMeta, ...(meta || {}) }; },
      onRequestStat: (stat) => { requestStat = { ...(stat || {}) }; },
      auditContext: {
        operation: stream === true ? 'api-probe-stream' : 'api-probe-nonstream',
        trigger: 'api-manager-test',
        initiator: 'user',
      },
    });
    return {
      ok: !!String(text || '').trim(),
      requestedStream: stream === true,
      text: String(text || ''),
      chunkCount,
      completionMeta,
      ...(requestStat || {}),
    };
  } catch (error) {
    error.probeStat = requestStat;
    throw error;
  }
}

/** 读取主 API 是否优先流式（会话级 preset 覆盖可传 configOverride） */
export async function resolveChatPreferStream(overrideConfig = null) {
  if (overrideConfig != null && typeof overrideConfig.preferStream === 'boolean') {
    return overrideConfig.preferStream;
  }
  const config = await getConfig();
  return config.preferStream !== false;
}

/**
 * 主 API 补全：按「聊天模型」里的流式开关决定 stream。
 * options.stream 可强制 true/false；非流式时仍会调用一次 onChunk(全文, 全文) 便于 UI 收尾。
 */
export async function chatWithPreferredStream(messages, onChunk, options = {}) {
  let useStream = false;
  if (options.stream === true) useStream = true;
  else if (options.stream === false) useStream = false;
  else useStream = await resolveChatPreferStream(options.configOverride || null);

  if (useStream) {
    return chat(messages, {
      ...options,
      stream: true,
      onChunk: typeof onChunk === 'function' ? onChunk : undefined,
    });
  }
  const text = await chat(messages, { ...options, stream: false });
  if (typeof onChunk === 'function' && text) onChunk(text, text);
  return text;
}

/** 429 / 网关 / CORS / HTML 误响应等：重试通常无效，调用方宜退避 */
export function isTransientApiError(err) {
  if (err?.code === 'opaque_network_error' || err?.networkFailure === 'opaque') return true;
  const m = String(err?.message || err || '');
  return /API错误 \(429\)|no_available_account|API错误 \(503\)|API错误 \(504\)|Gateway Timeout|CORS|浏览器拦截|网页而非 JSON|不是合法 JSON|Failed to fetch|ERR_FAILED|HTTP2|protocol error|连接在返回阶段断开|连接在返回中途断开|连接在等待响应|流式连接提前结束|网络连接中断/i.test(m);
}
