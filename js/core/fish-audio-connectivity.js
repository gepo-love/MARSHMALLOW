import {
  getNativeHttpTransport,
  hasNativeHttp,
  isNativeAppShell,
  nativeHttpGet,
} from './native-http.js';

export const FISH_AUDIO_OFFICIAL_ENDPOINT = 'https://api.fish.audio';
export const FISH_AUDIO_OFFICIAL_SITE_URL = 'https://fish.audio/';
export const FISH_AUDIO_API_KEYS_URL = 'https://fish.audio/app/api-keys/';

export function isKnownUnofficialFishAudioSite(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const hostname = new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'fishaudio.org' || hostname.endsWith('.fishaudio.org');
  } catch (_) {
    return /(^|[/:.])fishaudio\.org([/:?#]|$)/i.test(raw);
  }
}

export function normalizeFishAudioEndpoint(value = '') {
  const endpoint = String(value || '').trim() || FISH_AUDIO_OFFICIAL_ENDPOINT;
  return endpoint.replace(/\/+$/, '');
}

export function getFishAudioBaseEndpoint(value = '') {
  return normalizeFishAudioEndpoint(value).replace(/\/v1\/tts$/i, '');
}

export function buildFishAudioConnectivityRequest({ endpoint = '', apiKey = '' } = {}) {
  if (isKnownUnofficialFishAudioSite(endpoint)) {
    throw new Error('fishaudio.org 不是 Fish Audio 官方站。请使用官方接口 https://api.fish.audio');
  }
  const baseEndpoint = getFishAudioBaseEndpoint(endpoint);
  const key = String(apiKey || '').trim();
  return {
    url: `${baseEndpoint}/model?page_size=1&page_number=1&self=true`,
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    hasApiKey: !!key,
  };
}

function transportLabel(nativeTransport = '') {
  if (nativeTransport === 'marshmallow-http') return 'APK 原生网络';
  if (nativeTransport === 'capacitor-http') return 'APK 原生网络';
  return '浏览器网络';
}

function makeHttpError(status, hasApiKey) {
  if ((status === 401 || status === 403) && hasApiKey) {
    return `线路已到达，但 API Key 鉴权失败（HTTP ${status}）`;
  }
  if (status === 402) {
    return '线路已到达，但 Fish Audio 账户余额或套餐不可用（HTTP 402）';
  }
  if (status === 404) {
    return '线路已到达，但当前接口地址没有提供 Fish 模型查询路径（HTTP 404）';
  }
  return `线路已到达，但接口返回 HTTP ${status}`;
}

/**
 * 只请求模型列表，不调用 TTS，不会生成音频或产生语音合成费用。
 * fetchImpl / nativeGet / nativeCapability 仅用于无网络的单元测试。
 */
export async function testFishAudioConnectivity({
  endpoint = '',
  apiKey = '',
  timeoutMs = 15_000,
  fetchImpl = null,
  nativeGet = nativeHttpGet,
  nativeCapability = null,
} = {}) {
  const request = buildFishAudioConnectivityRequest({ endpoint, apiKey });
  const nativeAvailable = nativeCapability == null
    ? isNativeAppShell() && hasNativeHttp()
    : !!nativeCapability;
  const nativeTransport = nativeAvailable ? (getNativeHttpTransport() || 'native-http') : '';
  const transport = transportLabel(nativeTransport);
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1_000, Number(timeoutMs) || 15_000));

  try {
    const response = nativeAvailable
      ? await nativeGet(request.url, {
        headers: request.headers,
        signal: controller.signal,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      })
      : await (fetchImpl || globalThis.fetch)(request.url, {
        method: 'GET',
        headers: request.headers,
        signal: controller.signal,
        cache: 'no-store',
      });
    const durationMs = Date.now() - startedAt;
    const status = Number(response?.status || 0);

    if (response?.ok) {
      return {
        ok: true,
        reachable: true,
        authVerified: request.hasApiKey,
        status,
        durationMs,
        transport,
        url: request.url,
      };
    }

    if (!request.hasApiKey && (status === 401 || status === 403)) {
      return {
        ok: true,
        reachable: true,
        authVerified: false,
        status,
        durationMs,
        transport,
        url: request.url,
      };
    }

    const error = new Error(makeHttpError(status, request.hasApiKey));
    error.status = status;
    error.durationMs = durationMs;
    error.transport = transport;
    throw error;
  } catch (err) {
    if (err?.transport) throw err;
    const durationMs = Date.now() - startedAt;
    const message = timedOut
      ? `连接 Fish Audio 超时（${Math.round(timeoutMs / 1000)} 秒）`
      : String(err?.message || err || '未知网络错误');
    const error = new Error(message);
    error.name = timedOut ? 'TimeoutError' : (err?.name || 'Error');
    error.durationMs = durationMs;
    error.transport = transport;
    error.cause = err;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
