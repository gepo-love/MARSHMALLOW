/**
 * 社媒相关 Worker 接口的统一请求入口。
 * APK 与 PWA 都应先经 Worker 代抓社媒页面。APK 优先使用 WebView/Chromium
 * 网络栈：实机上它与 PWA 一样可直连站点，而 Java HttpURLConnection 可能受
 * ROM DNS/IPv6 路由影响，反而出现「不开梯子连不上 Worker」。只有 WebView
 * 请求真的抛出网络/CORS 异常时，才退到原生 HTTP。
 */
import { isNativeShell } from './native-update-bridge.js';
import { getNativeAccessToken } from './native-license-heartbeat.js';
import { hasNativeHttp, nativeHttpGet, nativeHttpPostJson } from './native-http.js';

const WORKER_ORIGIN = '';

export function resolveSocialWorkerUrl(path = '') {
  const p = String(path || '').trim();
  if (!p) return WORKER_ORIGIN;
  if (/^https?:\/\//i.test(p)) return p;
  const normalized = p.startsWith('/') ? p : `/${p}`;
  return isNativeShell() ? `${WORKER_ORIGIN}${normalized}` : normalized;
}

export function socialWorkerAuthHeaders() {
  if (!isNativeShell()) return {};
  const token = getNativeAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * @param {string} pathOrUrl Worker 相对路径或绝对 URL
 * @param {{ method?: string, headers?: Record<string,string>, body?: any, signal?: AbortSignal, cache?: RequestCache }} [options]
 * @returns {Promise<Response>}
 */
export async function socialWorkerFetch(pathOrUrl, options = {}) {
  const url = resolveSocialWorkerUrl(pathOrUrl);
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    ...socialWorkerAuthHeaders(),
    ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
  };
  const signal = options.signal;

  const fetchInit = {
    method,
    headers,
    signal,
    cache: options.cache || 'no-store',
  };
  if (method !== 'GET' && options.body !== undefined) {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    fetchInit.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {});
  }

  const nativeFetch = async () => {
    if (method === 'GET') {
      return nativeHttpGet(url, {
        headers,
        signal,
        connectTimeout: 20_000,
        readTimeout: 45_000,
      });
    }
    return nativeHttpPostJson(url, {
      headers,
      body: options.body,
      signal,
      connectTimeout: 20_000,
      readTimeout: 90_000,
    });
  };

  if (isNativeShell()) {
    try {
      return await fetch(url, fetchInit);
    } catch (webError) {
      if (!hasNativeHttp()) throw webError;
      try {
        return await nativeFetch();
      } catch (nativeError) {
        if (nativeError && typeof nativeError === 'object') nativeError.webFetchError = webError;
        throw nativeError;
      }
    }
  }

  return fetch(url, fetchInit);
}
