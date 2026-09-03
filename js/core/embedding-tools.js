import * as db from './db.js';
import { buildApiUrl } from './api.js';
import { hasNativeHttp, nativeHttpPostJson } from './native-http.js';

export const EMBEDDING_CONFIG_KEY = 'embeddingApiConfig';

export const DEFAULT_EMBEDDING_CONFIG = Object.freeze({
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  dimensions: 0,
});

let cachedConfig = null;

function normalizeConfig(value = {}) {
  const dimensions = Math.max(0, Math.floor(Number(value?.dimensions) || 0));
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(value || {}),
    enabled: value?.enabled === true,
    baseUrl: String(value?.baseUrl || '').trim(),
    apiKey: String(value?.apiKey || '').trim(),
    model: String(value?.model || '').trim(),
    dimensions,
  };
}

export async function loadEmbeddingConfig() {
  if (cachedConfig) return { ...cachedConfig };
  const row = await db.get('settings', EMBEDDING_CONFIG_KEY);
  cachedConfig = normalizeConfig(row?.value || {});
  return { ...cachedConfig };
}

export async function saveEmbeddingConfig(config = {}) {
  cachedConfig = normalizeConfig(config);
  await db.put('settings', { key: EMBEDDING_CONFIG_KEY, value: cachedConfig });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('api-config-changed', {
      detail: { section: 'embedding', config: cachedConfig },
    }));
  }
  return { ...cachedConfig };
}

export function isEmbeddingEnabled(config = {}) {
  const value = normalizeConfig(config);
  return value.enabled && !!value.model && (!!value.baseUrl || typeof window !== 'undefined');
}

export function isRerankerModelName(model = '') {
  return /rerank/i.test(String(model || '').trim());
}

export function filterEmbeddingModelNames(models = []) {
  const candidates = [...new Set(
    (Array.isArray(models) ? models : [])
      .map((model) => String(model || '').trim())
      .filter(Boolean)
      .filter((model) => !isRerankerModelName(model)),
  )];
  const likelyEmbedding = candidates.filter((model) =>
    /(embedding|(?:^|[/_.-])embed(?:$|[/_.-])|bge[-_/]|bce[-_/]|gte[-_/]|e5[-_/])/i.test(model));
  // 私有中转可能使用自定义模型名；只有识别到明确的 embedding 型号时才收紧为白名单。
  return (likelyEmbedding.length ? likelyEmbedding : candidates)
    .sort((left, right) => left.localeCompare(right));
}

export function cosineSimilarity(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

/** 稳定、轻量的内容指纹；只用于陈旧检测，不用于安全校验。 */
export function contentHash(value = '') {
  const text = String(value || '').replace(/\r\n?/g, '\n').trim();
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function parseEmbeddings(payload, expectedCount) {
  const rows = Array.isArray(payload?.data) ? payload.data.slice() : [];
  rows.sort((a, b) => Number(a?.index || 0) - Number(b?.index || 0));
  const vectors = rows.map((row) => Array.isArray(row?.embedding)
    ? row.embedding.map(Number).filter(Number.isFinite)
    : []);
  if (vectors.length !== expectedCount || vectors.some((vector) => !vector.length)) {
    throw new Error('向量接口返回的数据数量或格式不正确');
  }
  return vectors;
}

function isVoyageEmbeddingApi(baseUrl = '') {
  try {
    return new URL(String(baseUrl || '').trim()).hostname.toLowerCase() === 'api.voyageai.com';
  } catch (_) {
    return false;
  }
}

function embeddingTimeoutError(timeoutMs) {
  const error = new Error(`向量请求超时（${Math.max(1, Math.round(timeoutMs))}ms）`);
  error.name = 'TimeoutError';
  error.timeoutStage = 'embedding';
  return error;
}

/**
 * 给可选向量查询设置真正的 JS 截止时间。
 * 旧版 CapacitorHttp 不能中途取消原生调用，所以仍需 Promise.race 让聊天主链按时返回；
 * 新版 MarshmallowHttp / Web fetch 同时接收 AbortSignal，会实际断开底层请求。
 */
async function withEmbeddingDeadline(taskFactory, externalSignal, timeoutMs = 0) {
  const limit = Math.max(0, Number(timeoutMs) || 0);
  if (!limit && !externalSignal) return taskFactory(undefined);
  if (externalSignal?.aborted) {
    const error = new Error('请求已取消');
    error.name = 'AbortError';
    throw error;
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const signal = controller?.signal || externalSignal;
  let timedOut = false;
  let timer = 0;
  let rejectExternalAbort = null;
  const abortFromOutside = () => {
    controller?.abort();
    if (rejectExternalAbort) {
      const error = new Error('请求已取消');
      error.name = 'AbortError';
      rejectExternalAbort(error);
      rejectExternalAbort = null;
    }
  };
  const aborted = externalSignal
    ? new Promise((_, reject) => {
      rejectExternalAbort = reject;
    })
    : null;
  externalSignal?.addEventListener?.('abort', abortFromOutside, { once: true });
  const request = Promise.resolve().then(() => taskFactory(signal));
  const timeout = limit > 0
    ? new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        reject(embeddingTimeoutError(limit));
      }, limit);
    })
    : null;

  try {
    return await Promise.race([request, timeout, aborted].filter(Boolean));
  } catch (error) {
    if (timedOut) throw embeddingTimeoutError(limit);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    rejectExternalAbort = null;
    externalSignal?.removeEventListener?.('abort', abortFromOutside);
  }
}

/** Embedding 是非流式整包请求；APK 直接走原生 HTTP，避免先被 WebView CORS/DNS 白白拖住。 */
async function postEmbedding(url, headers, body, signal, timeoutMs = 0) {
  if (hasNativeHttp()) {
    return nativeHttpPostJson(url, {
      headers,
      body,
      signal,
      connectTimeout: timeoutMs > 0 ? timeoutMs : 15_000,
      readTimeout: timeoutMs > 0 ? timeoutMs : 30_000,
    });
  }
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

export async function requestEmbedding(input, options = {}) {
  const values = (Array.isArray(input) ? input : [input])
    .map((value) => String(value || '').trim());
  if (!values.length || values.some((value) => !value)) throw new Error('向量文本不能为空');
  const config = normalizeConfig(options.config || await loadEmbeddingConfig());
  if (!isEmbeddingEnabled(config)) throw new Error('请先启用并填写向量模型');
  if (isRerankerModelName(config.model)) {
    throw new Error('当前选择的是 Reranker 重排序模型，不能用于向量接口；请选择名称包含 Embedding 的模型');
  }

  const body = { model: config.model, input: values };
  if (config.dimensions > 0) {
    // Voyage 与 OpenAI 兼容同一 embeddings 路径和响应结构，但维度参数名不同。
    if (isVoyageEmbeddingApi(config.baseUrl)) body.output_dimension = config.dimensions;
    else body.dimensions = config.dimensions;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  const response = await withEmbeddingDeadline(
    (signal) => postEmbedding(
      buildApiUrl(config.baseUrl, '/v1/embeddings'),
      headers,
      body,
      signal,
      timeoutMs,
    ),
    options.signal,
    timeoutMs,
  );
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.error?.message || payload?.message || '';
    } catch (_) {}
    throw new Error(detail || `向量接口请求失败（HTTP ${response.status}）`);
  }
  const vectors = parseEmbeddings(await response.json(), values.length);
  return Array.isArray(input) ? vectors : vectors[0];
}

export async function testEmbeddingConnection(config = null) {
  const startedAt = Date.now();
  const vector = await requestEmbedding('棉花糖机向量连接测试', {
    ...(config ? { config } : {}),
    timeoutMs: 20_000,
  });
  return {
    ok: true,
    dimensions: vector.length,
    durationMs: Date.now() - startedAt,
  };
}
