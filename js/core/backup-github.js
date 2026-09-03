import { socialWorkerFetch } from './social-worker-client.js';
import { isOpaqueFetchError, makeOpaqueFetchError } from './network-error.js';
import {
  acquireNetworkLease,
  hasNativeHttp,
  nativeHttpRequest,
  releaseNetworkLease,
} from './native-http.js';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const BACKUP_DIR = 'marshmallow-backups';
const DEFAULT_REPO = 'marshmallow-cloud-backup';
const DIRECT_FILE_LIMIT = 512 * 1024;
const CHUNK_SIZE = 2 * 1024 * 1024;
// GitHub Contents API 要求 Base64 JSON。2 MB 分片在移动端 WebView / WebKit 里会同时
// 存在 Blob / ArrayBuffer / Base64 / JSON / fetch body 多份副本，上传大备份时
// 容易把 renderer 推过内存峰值。iOS / Android 单片收紧，桌面端保持原速度。
const MOBILE_CHUNK_SIZE = 512 * 1024;
const DOWNLOAD_CONCURRENCY = 3;
const DOWNLOAD_MAX_ATTEMPTS = 4;
const DOWNLOAD_RETRY_DELAY_MS = 700;
const MUTATION_RETRY_DELAY_MS = 500;

function cleanRepoName(value = '') {
  const name = String(value || DEFAULT_REPO).trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error('GitHub 备份仓库名无效');
  return name;
}

function encodePath(path = '') {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function assertGitHubConfig(config) {
  if (!String(config?.githubToken || '').trim()) throw new Error('请先连接 GitHub');
  if (!String(config?.githubOwner || '').trim()) throw new Error('GitHub 账号信息缺失，请重新连接');
  cleanRepoName(config?.githubRepo);
}

function githubHeaders(config, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${String(config?.githubToken || '').trim()}`,
    'X-GitHub-Api-Version': API_VERSION,
    ...extra,
  };
}

async function githubRequest(config, path, options = {}, allowed = []) {
  const url = /^https?:\/\//i.test(path) ? path : `${API_ROOT}${path}`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const { timeoutMs: requestTimeoutMs, ...fetchOptions } = options;
  const timeoutMs = Math.max(5_000, Number(requestTimeoutMs) || Number(config?.timeoutMs) || 30_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    const headers = githubHeaders(config, fetchOptions.headers);
    const signal = fetchOptions.signal || controller.signal;
    // APK 中的 WebView fetch 可能对 api.github.com 只返回无原因 TypeError。
    // JSON 元数据和上传改走原生 HTTP；原始密文下载仍保留字节安全的浏览器流。
    const rawResponse = String(headers.Accept || headers.accept || '').includes('application/vnd.github.raw');
    response = hasNativeHttp() && !rawResponse
      ? await nativeHttpRequest(url, {
        method: fetchOptions.method || 'GET',
        headers,
        body: fetchOptions.body,
        signal,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      })
      : await fetch(url, {
        ...fetchOptions,
        headers,
        signal,
        cache: 'no-store',
      });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`GitHub 请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络后重试`);
    }
    if (isOpaqueFetchError(error)) {
      throw makeOpaqueFetchError(error, url, {
        label: 'GitHub 请求',
        elapsedMs: Date.now() - startedAt,
        replayRisk: false,
        nativeHint: '请检查当前网络能否访问 GitHub；部分网络可能需要代理。',
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (response.ok || allowed.includes(response.status)) return response;
  let detail = '';
  try {
    const payload = await response.json();
    detail = String(payload?.message || '').slice(0, 240);
  } catch (_) {
    try { detail = (await response.text()).trim().slice(0, 240); } catch (_) { /* ignore */ }
  }
  let message = `GitHub 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`;
  if (response.status === 401) message = 'GitHub 授权已失效，请重新连接';
  if (response.status === 403) message = `GitHub 拒绝了操作${detail ? `：${detail}` : ''}`;
  if (response.status === 404) message = 'GitHub 备份仓库或文件不存在';
  const error = new Error(message);
  error.httpStatus = response.status;
  throw error;
}

async function readJsonResponse(response, fallback = 'GitHub 返回了无法识别的数据') {
  try {
    return await response.json();
  } catch (_) {
    throw new Error(fallback);
  }
}

async function callDeviceApi(path, body = {}) {
  const response = await socialWorkerFetch(`/api/github/device/${path}`, {
    method: 'POST',
    body,
  });
  const payload = await readJsonResponse(response, 'GitHub 授权服务返回了无法识别的数据');
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `GitHub 授权服务不可用（HTTP ${response.status}）`);
  }
  return payload;
}

export async function startGitHubDeviceAuthorization() {
  const payload = await callDeviceApi('start');
  if (!payload.deviceCode || !payload.userCode || !payload.verificationUri) {
    throw new Error('GitHub 授权服务缺少验证码');
  }
  return {
    deviceCode: String(payload.deviceCode),
    userCode: String(payload.userCode),
    verificationUri: String(payload.verificationUri),
    expiresIn: Math.max(60, Number(payload.expiresIn) || 900),
    interval: Math.max(5, Number(payload.interval) || 5),
  };
}

export async function pollGitHubDeviceAuthorization(deviceCode) {
  return callDeviceApi('poll', { deviceCode: String(deviceCode || '') });
}

export async function getGitHubUser(token) {
  const config = { githubToken: token };
  const response = await githubRequest(config, '/user');
  const user = await readJsonResponse(response);
  if (!user?.login) throw new Error('无法读取 GitHub 账号');
  return { login: String(user.login), id: Number(user.id) || 0 };
}

async function getRepository(config, { missingOk = false } = {}) {
  const owner = encodeURIComponent(String(config.githubOwner || ''));
  const repo = encodeURIComponent(cleanRepoName(config.githubRepo));
  const response = await githubRequest(config, `/repos/${owner}/${repo}`, {}, missingOk ? [404] : []);
  if (response.status === 404) return null;
  return readJsonResponse(response);
}

export async function ensureGitHubBackupRepository(config) {
  assertGitHubConfig(config);
  let repository = await getRepository(config, { missingOk: true });
  if (!repository) {
    const response = await githubRequest(config, '/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: cleanRepoName(config.githubRepo),
        description: '棉花糖机加密云备份',
        private: true,
        auto_init: true,
      }),
    });
    repository = await readJsonResponse(response);
  }
  if (repository.private !== true) throw new Error('GitHub 备份仓库必须设为私有');
  return {
    owner: String(repository.owner?.login || config.githubOwner),
    repo: String(repository.name || cleanRepoName(config.githubRepo)),
    branch: String(repository.default_branch || config.githubBranch || 'main'),
    url: String(repository.html_url || ''),
  };
}

export async function connectGitHubBackup(token, repo = DEFAULT_REPO) {
  const user = await getGitHubUser(token);
  const repository = await ensureGitHubBackupRepository({
    githubToken: token,
    githubOwner: user.login,
    githubRepo: repo,
  });
  return {
    githubToken: String(token),
    githubOwner: repository.owner,
    githubRepo: repository.repo,
    githubBranch: repository.branch,
    githubRepoUrl: repository.url,
  };
}

function contentApiPath(config, remoteName) {
  assertGitHubConfig(config);
  const owner = encodeURIComponent(String(config.githubOwner));
  const repo = encodeURIComponent(cleanRepoName(config.githubRepo));
  const remotePath = encodePath(`${BACKUP_DIR}/${remoteName}`);
  return `/repos/${owner}/${repo}/contents/${remotePath}`;
}

async function getContentMeta(config, remoteName) {
  const response = await githubRequest(config, contentApiPath(config, remoteName), {}, [404]);
  if (response.status === 404) return null;
  return readJsonResponse(response);
}

function bytesToBase64(bytes) {
  let out = '';
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + stride)));
  }
  return btoa(out);
}

function isMobileLowMemoryRuntime() {
  try {
    if (globalThis.Capacitor?.isNativePlatform?.() === true) return true;
  } catch (_) { /* ignore */ }
  const userAgent = String(globalThis.navigator?.userAgent || '');
  const platform = String(globalThis.navigator?.platform || '');
  const touchPoints = Number(globalThis.navigator?.maxTouchPoints || 0);
  return /Android|iPhone|iPad|iPod/i.test(userAgent)
    || (/Mac/i.test(platform) && touchPoints > 1);
}

function uploadChunkSize(options = {}) {
  const requested = Number(options.chunkSize);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.max(64 * 1024, Math.min(CHUNK_SIZE, Math.round(requested)));
  }
  return isMobileLowMemoryRuntime() ? MOBILE_CHUNK_SIZE : CHUNK_SIZE;
}

async function blobToBase64(blob) {
  // Chromium 的 FileReader 直接由 Blob 生成 data URL，避免 JS 堆再保留一份
  // 与原文等大的二进制字符串。Node/无 FileReader 环境保留原兜底。
  if (typeof FileReader === 'function') {
    const result = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('读取 GitHub 备份分片失败'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(blob);
    });
    const comma = result.indexOf(',');
    if (comma >= 0) return result.slice(comma + 1);
  }
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

async function bodyToBlob(body, contentType = 'application/octet-stream') {
  if (body instanceof Blob) return body;
  return new Blob([body], { type: contentType });
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
    options.onProgress?.({
      loadedBytes,
      totalBytes: hintedTotal || loadedBytes,
    });
  }
  const blob = new Blob(chunks, {
    type: response.headers.get('Content-Type') || 'application/octet-stream',
  });
  options.onProgress?.({ loadedBytes: blob.size, totalBytes: hintedTotal || blob.size });
  return blob;
}

async function putOneFile(config, remoteName, blob, message) {
  const content = await blobToBase64(blob);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const existing = await getContentMeta(config, remoteName);
      const payload = {
        message,
        content,
        branch: String(config.githubBranch || 'main'),
      };
      if (existing?.sha) payload.sha = existing.sha;
      await githubRequest(config, contentApiPath(config, remoteName), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // 移动网络上传 Base64 JSON 时 30 秒偏紧；单片允许更长时间，失败后仍按
        // 固定远端路径安全重试，不会生成第二份备份。
        timeoutMs: 90_000,
      });
      return;
    } catch (error) {
      lastError = error;
      const status = Number(error?.httpStatus || 0);
      const retryable = !status || status === 409 || status === 422 || status === 429 || status >= 500;
      if (!retryable || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, MUTATION_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError || new Error('GitHub 上传失败');
}

async function getOneFile(config, remoteName, {
  missingOk = false,
  onProgress,
  totalBytes,
  timeoutMs = 60_000,
} = {}) {
  const response = await githubRequest(config, contentApiPath(config, remoteName), {
    headers: { Accept: 'application/vnd.github.raw+json' },
    timeoutMs,
  }, missingOk ? [404] : []);
  if (response.status === 404) return null;
  return responseToBlob(response, { onProgress, totalBytes });
}

function isRetryableDownloadError(error) {
  const status = Number(error?.httpStatus || 0);
  return !status || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function waitForDownloadRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
}

async function getOneFileWithRetry(config, remoteName, options = {}) {
  const maxAttempts = Math.max(1, Math.min(6, Math.round(Number(options.maxAttempts) || DOWNLOAD_MAX_ATTEMPTS)));
  const expectedSize = Math.max(0, Number(options.expectedSize) || 0);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const blob = await getOneFile(config, remoteName, options);
      if (blob && expectedSize > 0 && blob.size !== expectedSize) {
        const error = new Error('GitHub 备份分片大小校验失败');
        error.retryable = true;
        throw error;
      }
      return blob;
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable === true || isRetryableDownloadError(error);
      if (!retryable || attempt >= maxAttempts) throw error;
      options.onRetry?.({
        name: remoteName,
        retry: attempt,
        retries: maxAttempts - 1,
        error,
      });
      await waitForDownloadRetry((Number(options.retryDelayMs) || DOWNLOAD_RETRY_DELAY_MS) * attempt);
    }
  }
  throw lastError || new Error('GitHub 下载失败');
}

async function deleteOneFile(config, remoteName, { missingOk = true } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      // 每次重试都重新取 SHA。另一个标签页、自动保留清理或上一次“服务端已成功但
      // 客户端断线”的请求，都可能让旧 SHA 立即失效。
      const existing = await getContentMeta(config, remoteName);
      if (!existing?.sha) {
        if (missingOk) return false;
        throw new Error('GitHub 备份文件不存在');
      }
      const response = await githubRequest(config, contentApiPath(config, remoteName), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Delete cloud backup file ${remoteName}`,
          sha: existing.sha,
          branch: String(config.githubBranch || 'main'),
        }),
      }, [404]);
      if (response.status === 404) {
        if (missingOk) return false;
        throw new Error('GitHub 备份文件不存在');
      }
      return true;
    } catch (error) {
      lastError = error;
      const status = Number(error?.httpStatus || 0);
      const retryable = !status || status === 409 || status === 422 || status === 429 || status >= 500;
      if (!retryable || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, MUTATION_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError || new Error('GitHub 删除失败');
}

function partsIndexName(remoteName) {
  return `${remoteName}.parts.json`;
}

function partName(remoteName, index) {
  const folder = String(remoteName).split('.')[0];
  return `${folder}/${remoteName}.part-${String(index + 1).padStart(4, '0')}`;
}

async function readPartsIndex(config, remoteName, options = {}) {
  const blob = await getOneFileWithRetry(config, partsIndexName(remoteName), {
    ...options,
    missingOk: true,
  });
  if (!blob) return null;
  let value;
  try { value = JSON.parse(await blob.text()); } catch (_) { throw new Error('GitHub 备份分片清单已损坏'); }
  if (value?.format !== 'marshmallow-github-parts'
    || value?.version !== 1
    || value?.name !== remoteName
    || !Array.isArray(value?.parts)
    || !value.parts.length) {
    throw new Error('GitHub 备份分片清单格式不受支持');
  }
  return value;
}

async function listOrphanParts(config, remoteName) {
  const folder = String(remoteName).split('.')[0];
  const response = await githubRequest(config, contentApiPath(config, folder), {}, [404]);
  if (response.status === 404) return [];
  const items = await readJsonResponse(response);
  if (!Array.isArray(items)) return [];
  const prefix = `${remoteName}.part-`;
  return items
    .filter((item) => item?.type === 'file' && String(item.name || '').startsWith(prefix))
    .map((item) => `${folder}/${String(item.name)}`);
}

export async function testGitHubConnection(config) {
  assertGitHubConfig(config);
  const repository = await getRepository(config);
  if (repository.private !== true) throw new Error('GitHub 备份仓库不是私有仓库');
  return { ok: true, repository };
}

export async function listGitHubFiles(config) {
  assertGitHubConfig(config);
  const response = await githubRequest(config, contentApiPath(config, ''), {}, [404]);
  if (response.status === 404) return [];
  const items = await readJsonResponse(response);
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item?.type === 'file')
    .map((item) => ({
      name: String(item.name || ''),
      size: Number(item.size) || 0,
      modified: '',
    }));
}

export async function putGitHubFile(
  config,
  remoteName,
  body,
  contentType = 'application/octet-stream',
  options = {},
) {
  const blob = await bodyToBlob(body, contentType);
  options.onProgress?.({ loadedBytes: 0, totalBytes: blob.size });
  if (blob.size <= DIRECT_FILE_LIMIT) {
    await putOneFile(config, remoteName, blob, `Update cloud backup file ${remoteName}`);
    options.onProgress?.({ loadedBytes: blob.size, totalBytes: blob.size });
    return { ok: true, chunks: 1 };
  }
  const parts = [];
  const chunkSize = uploadChunkSize(options);
  try {
    for (let offset = 0, index = 0; offset < blob.size; offset += chunkSize, index += 1) {
      const name = partName(remoteName, index);
      const chunk = blob.slice(offset, Math.min(blob.size, offset + chunkSize));
      await putOneFile(config, name, chunk, `Upload cloud backup part ${index + 1}`);
      parts.push({ name, size: chunk.size });
      options.onProgress?.({
        loadedBytes: Math.min(blob.size, offset + chunk.size),
        totalBytes: blob.size,
      });
      // 给旧 WebView 一个任务边界回收上一片的 Base64 / JSON 临时对象。
      if (isMobileLowMemoryRuntime()) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const index = {
      format: 'marshmallow-github-parts',
      version: 1,
      name: remoteName,
      size: blob.size,
      parts,
    };
    await putOneFile(
      config,
      partsIndexName(remoteName),
      new Blob([JSON.stringify(index)], { type: 'application/json' }),
      `Update cloud backup parts index ${remoteName}`,
    );
    options.onProgress?.({ loadedBytes: blob.size, totalBytes: blob.size });
    return { ok: true, chunks: parts.length };
  } catch (error) {
    for (const part of parts) await deleteOneFile(config, part.name, { missingOk: true }).catch(() => {});
    throw error;
  }
}

export async function getGitHubFile(config, remoteName, options = {}) {
  const hintedTotal = Math.max(0, Number(options.totalBytes) || 0);
  options.onProgress?.({ loadedBytes: 0, totalBytes: hintedTotal });
  const leaseId = isMobileLowMemoryRuntime()
    ? await acquireNetworkLease({ timeoutMs: 20 * 60_000 }).catch(() => false)
    : false;
  try {
    const retryOptions = {
      maxAttempts: options.maxAttempts,
      retryDelayMs: options.retryDelayMs,
      onRetry: options.onRetry,
    };
    const direct = await getOneFileWithRetry(config, remoteName, {
      ...retryOptions,
      missingOk: true,
      onProgress: options.onProgress,
      totalBytes: hintedTotal,
    });
    if (direct) return direct;
    const index = await readPartsIndex(config, remoteName, retryOptions);
    if (!index) throw new Error('GitHub 备份文件不存在');

    const totalBytes = Number(index.size) || hintedTotal || 0;
    const chunks = new Array(index.parts.length);
    const completedSizes = new Array(index.parts.length).fill(0);
    const inFlightHighWater = new Array(index.parts.length).fill(0);
    const concurrency = Math.max(
      1,
      Math.min(4, Math.round(Number(options.concurrency) || DOWNLOAD_CONCURRENCY), index.parts.length),
    );
    let nextIndex = 0;
    let stopped = false;
    let lastReported = 0;
    const reportCombinedProgress = () => {
      const observed = completedSizes.reduce((sum, value) => sum + value, 0)
        + inFlightHighWater.reduce((sum, value, index) => (
          completedSizes[index] > 0 ? sum : sum + value
        ), 0);
      lastReported = Math.max(lastReported, Math.min(totalBytes || observed, observed));
      options.onProgress?.({ loadedBytes: lastReported, totalBytes: totalBytes || lastReported });
    };
    const worker = async () => {
      while (!stopped) {
        const partIndex = nextIndex;
        nextIndex += 1;
        if (partIndex >= index.parts.length) return;
        const part = index.parts[partIndex];
        const expectedSize = Number(part.size) || 0;
        try {
          const blob = await getOneFileWithRetry(config, part.name, {
            ...retryOptions,
            expectedSize,
            totalBytes: expectedSize,
            onProgress: ({ loadedBytes }) => {
              inFlightHighWater[partIndex] = Math.max(
                inFlightHighWater[partIndex],
                Math.min(expectedSize || Number(loadedBytes) || 0, Number(loadedBytes) || 0),
              );
              reportCombinedProgress();
            },
            onRetry: (detail) => {
              options.onRetry?.({
                ...detail,
                partIndex,
                partTotal: index.parts.length,
                loadedBytes: lastReported,
                totalBytes,
              });
            },
          });
          chunks[partIndex] = blob;
          completedSizes[partIndex] = blob.size;
          inFlightHighWater[partIndex] = 0;
          reportCombinedProgress();
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const size = completedSizes.reduce((sum, value) => sum + value, 0);
    if (size !== Number(index.size)) throw new Error('GitHub 备份文件大小校验失败');
    options.onProgress?.({ loadedBytes: size, totalBytes: Number(index.size) || size });
    return new Blob(chunks, { type: 'application/octet-stream' });
  } finally {
    if (leaseId) releaseNetworkLease(leaseId);
  }
}

export async function getGitHubJson(config, remoteName) {
  const blob = await getGitHubFile(config, remoteName);
  try { return JSON.parse(await blob.text()); } catch (_) { throw new Error(`云端清单不是合法 JSON：${remoteName}`); }
}

export async function deleteGitHubFile(config, remoteName, { missingOk = true, onProgress } = {}) {
  onProgress?.({ deleted: 0, total: 1, name: remoteName });
  if (await deleteOneFile(config, remoteName, { missingOk: true })) {
    onProgress?.({ deleted: 1, total: 1, name: remoteName });
    return { ok: true };
  }
  const index = await readPartsIndex(config, remoteName);
  if (!index) {
    // 上传可能在写入 parts.json 前中断。此时页面上只有失败清单，分片目录却仍在；
    // 按固定命名规则枚举并删除，避免“记录删了但仓库空间没释放”。
    const orphanParts = await listOrphanParts(config, remoteName);
    for (let partIndex = 0; partIndex < orphanParts.length; partIndex += 1) {
      await deleteOneFile(config, orphanParts[partIndex], { missingOk: true });
      onProgress?.({ deleted: partIndex + 1, total: orphanParts.length, name: remoteName, part: partIndex + 1 });
    }
    if (missingOk || orphanParts.length) return { ok: true };
    throw new Error('GitHub 备份文件不存在');
  }
  const total = index.parts.length + 1;
  onProgress?.({ deleted: 0, total, name: remoteName });
  for (let partIndex = 0; partIndex < index.parts.length; partIndex += 1) {
    const part = index.parts[partIndex];
    await deleteOneFile(config, part.name, { missingOk: true });
    onProgress?.({ deleted: partIndex + 1, total, name: remoteName, part: partIndex + 1 });
  }
  await deleteOneFile(config, partsIndexName(remoteName), { missingOk: true });
  onProgress?.({ deleted: total, total, name: remoteName });
  return { ok: true };
}
