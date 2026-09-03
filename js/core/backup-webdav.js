import { isOpaqueFetchError, makeOpaqueFetchError } from './network-error.js';

function normalizeBaseUrl(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) throw new Error('WebDAV 地址需以 http:// 或 https:// 开头');
  return value.endsWith('/') ? value : `${value}/`;
}

function encodeBasic(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(bytes).toString('base64');
}

function requestUrl(config, remoteName = '') {
  const base = normalizeBaseUrl(config?.url);
  const parts = String(remoteName || '').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('WebDAV 文件名包含非法路径');
  const safePath = parts
    .map((part) => encodeURIComponent(part))
    .join('/');
  return safePath ? new URL(safePath, base).toString() : base;
}

function authHeaders(config, extra = {}) {
  const headers = new Headers(extra);
  const username = String(config?.username || '');
  const password = String(config?.password || '');
  if (username || password) headers.set('Authorization', `Basic ${encodeBasic(`${username}:${password}`)}`);
  return headers;
}

function friendlyNetworkError(error, url = '', elapsedMs = 0) {
  if (error?.name === 'AbortError') return new Error('WebDAV 请求超时');
  if (isOpaqueFetchError(error)) {
    return makeOpaqueFetchError(error, url, {
      label: 'WebDAV 请求',
      elapsedMs,
      replayRisk: false,
      nativeHint: '请检查地址、证书和网络；确认是跨域限制后再使用支持跨域的自建代理。',
    });
  }
  return error instanceof Error ? error : new Error('无法连接 WebDAV');
}

async function davFetch(config, remoteName, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config?.timeoutMs) || 30000);
  const url = requestUrl(config, remoteName);
  const startedAt = Date.now();
  try {
    return await fetch(url, {
      ...options,
      headers: authHeaders(config, options.headers),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    throw friendlyNetworkError(error, url, Date.now() - startedAt);
  } finally {
    clearTimeout(timeout);
  }
}

async function assertOk(response, action, allowed = []) {
  if (response.ok || allowed.includes(response.status)) return response;
  let detail = '';
  try { detail = (await response.text()).trim().slice(0, 240); } catch (_) { /* ignore */ }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`WebDAV ${action}失败：账号、密码或目录权限不正确`);
  }
  if (response.status === 404) throw new Error(`WebDAV ${action}失败：目录或文件不存在`);
  throw new Error(`WebDAV ${action}失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
}

async function responseToBlob(response, options = {}) {
  const hintedTotal = Math.max(
    0,
    Number(options.totalBytes)
      || Number(response.headers.get('Content-Length'))
      || 0,
  );
  options.onProgress?.({ loadedBytes: 0, totalBytes: hintedTotal });
  if (!response.body?.getReader) {
    const blob = await response.blob();
    options.onProgress?.({ loadedBytes: blob.size, totalBytes: hintedTotal || blob.size });
    return blob;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loadedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    chunks.push(value);
    loadedBytes += value.byteLength;
    options.onProgress?.({ loadedBytes, totalBytes: hintedTotal || loadedBytes });
  }
  const blob = new Blob(chunks, {
    type: response.headers.get('Content-Type') || 'application/octet-stream',
  });
  options.onProgress?.({ loadedBytes: blob.size, totalBytes: hintedTotal || blob.size });
  return blob;
}

export async function testWebDavConnection(config) {
  const response = await davFetch(config, '', {
    method: 'PROPFIND',
    headers: {
      Depth: '0',
      'Content-Type': 'application/xml;charset=utf-8',
    },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
  });
  await assertOk(response, '连通测试', [207]);
  return { ok: true, status: response.status };
}

function parseDavResponses(xmlText, baseUrl) {
  const items = [];
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    for (const node of doc.getElementsByTagNameNS('DAV:', 'response')) {
      const href = node.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent || '';
      const size = Number(node.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent || 0);
      const modified = node.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent || '';
      items.push({ href, name: decodeURIComponent(href.split('/').filter(Boolean).pop() || ''), size, modified });
    }
    return items;
  }
  const responses = xmlText.match(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi) || [];
  for (const block of responses) {
    const href = /<(?:\w+:)?href\b[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i.exec(block)?.[1] || '';
    const size = Number(/<(?:\w+:)?getcontentlength\b[^>]*>(\d+)<\/(?:\w+:)?getcontentlength>/i.exec(block)?.[1] || 0);
    const modified = /<(?:\w+:)?getlastmodified\b[^>]*>([\s\S]*?)<\/(?:\w+:)?getlastmodified>/i.exec(block)?.[1] || '';
    items.push({ href, name: decodeURIComponent(href.split('/').filter(Boolean).pop() || ''), size, modified });
  }
  const baseName = decodeURIComponent(new URL(baseUrl).pathname.split('/').filter(Boolean).pop() || '');
  return items.filter((item) => item.name !== baseName);
}

export async function listWebDavFiles(config) {
  const response = await davFetch(config, '', {
    method: 'PROPFIND',
    headers: {
      Depth: '1',
      'Content-Type': 'application/xml;charset=utf-8',
    },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
  });
  await assertOk(response, '列出文件', [207]);
  return parseDavResponses(await response.text(), requestUrl(config));
}

export async function putWebDavFile(
  config,
  remoteName,
  body,
  contentType = 'application/octet-stream',
  options = {},
) {
  const totalBytes = body instanceof Blob ? body.size : new Blob([body]).size;
  options.onProgress?.({ loadedBytes: 0, totalBytes });
  const response = await davFetch(config, remoteName, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  });
  await assertOk(response, '上传');
  options.onProgress?.({ loadedBytes: totalBytes, totalBytes });
  return { ok: true, status: response.status };
}

export async function getWebDavFile(config, remoteName, options = {}) {
  const response = await davFetch(config, remoteName, { method: 'GET' });
  await assertOk(response, '下载');
  return responseToBlob(response, options);
}

export async function getWebDavJson(config, remoteName) {
  const blob = await getWebDavFile(config, remoteName);
  try {
    return JSON.parse(await blob.text());
  } catch (_) {
    throw new Error(`云端清单不是合法 JSON：${remoteName}`);
  }
}

export async function deleteWebDavFile(config, remoteName, { missingOk = true, onProgress } = {}) {
  onProgress?.({ deleted: 0, total: 1, name: remoteName });
  const response = await davFetch(config, remoteName, { method: 'DELETE' });
  await assertOk(response, '删除', missingOk ? [404] : []);
  onProgress?.({ deleted: 1, total: 1, name: remoteName });
  return { ok: true, status: response.status };
}
