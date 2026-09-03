/**
 * 表情包缩略图本地缓存（Cache Storage）。
 * 仅供管理页 / 选择器展示；发送、解析、聊天气泡仍用 sticker.url。
 * 不进 IndexedDB，故不影响备份体积；CORS 不允许读像素的外链会静默跳过。
 */

import { upgradeStickerImageUrl } from './sticker-store.js';

const CACHE_NAME = 'mm-sticker-thumbs-v3';
const LEGACY_CACHE_NAMES = ['mm-sticker-thumbs-v1', 'mm-sticker-thumbs-v2'];
const THUMB_MAX_EDGE = 192;
const THUMB_QUALITY = 0.72;
const ENSURE_CONCURRENCY = 3;
const CACHE_OPERATION_TIMEOUT_MS = 800;
let legacyCleanupStarted = false;

/** @type {Map<string, { objectUrl: string, sourceUrl: string }>} */
const memById = new Map();
/** @type {Map<string, { objectUrl: string, ids: Set<string> }>} */
const memBySource = new Map();
/** @type {Map<string, Promise<string|null>>} */
const inflight = new Map();
/** @type {Map<string, Promise<Blob|null>>} */
const thumbBlobInflight = new Map();
const thumbJobQueue = [];
let activeThumbJobs = 0;
/** sourceUrl 级失败标记，避免反复打不可缓存的外链 */
const uncacheableKeys = new Set();

function stickerIdOf(sticker) {
  return String(sticker?.id || '').trim();
}

function stickerUrlOf(sticker) {
  return String(sticker?.url || '').trim();
}

export function isInlineStickerImageUrl(value = '') {
  return /^data:image\//i.test(String(value || '').trim());
}

/** 透明底格式不能写成 JPEG，否则透明像素会在部分浏览器里变成黑色。 */
export function stickerThumbOutputMime(sourceBlob) {
  const type = String(sourceBlob?.type || '').trim().toLowerCase();
  return /^image\/(?:png|webp|gif|avif|svg\+xml)$/.test(type)
    ? 'image/png'
    : 'image/jpeg';
}

/**
 * Cache Storage 响应头不能保存几 MB 的 data URL。用固定长度指纹校验源图是否变化，
 * 避免本地上传表情因超长 X-Source-Url 响应头在 iOS 上写缓存失败。
 */
export function stickerSourceFingerprint(value = '') {
  const source = String(value || '').trim();
  const length = source.length;
  if (!length) return '0-0';
  const sample = length <= 384
    ? source
    : `${source.slice(0, 128)}${source.slice(Math.max(0, Math.floor(length / 2) - 64), Math.floor(length / 2) + 64)}${source.slice(-128)}`;
  let hash = 2166136261;
  for (let i = 0; i < sample.length; i += 1) {
    hash ^= sample.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * 外链可直接作为展示失败回退；本地 data URL 只留在 IndexedDB/内存对象，
 * 不复制进 src、data-fallback 等 DOM 属性。
 */
export function stickerDomDisplayFallback(value = '') {
  const source = upgradeStickerImageUrl(String(value || '').trim());
  return isInlineStickerImageUrl(source) ? '' : source;
}

function cacheRequestUrl(id) {
  return `https://mm-sticker-thumb.local/${encodeURIComponent(id)}`;
}

function uncacheableKey(id, url) {
  return `${id}\n${url}`;
}

function settleWithin(promise, fallback = null, timeoutMs = CACHE_OPERATION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    Promise.resolve(promise).then(finish, () => finish(fallback));
  });
}

async function openThumbCache() {
  if (typeof caches === 'undefined') return null;
  try {
    // iOS PWA / 部分 Android WebView 的 Cache Storage 偶尔既不成功也不报错。
    // 缩略图只是加速层，不能让它把表情管理页和选择器永久卡在空白首帧。
    const cache = await settleWithin(caches.open(CACHE_NAME));
    if (!cache) return null;
    if (!legacyCleanupStarted) {
      legacyCleanupStarted = true;
      Promise.all(LEGACY_CACHE_NAMES.map((name) => caches.delete(name).catch(() => false))).catch(() => {});
    }
    return cache;
  } catch (_) {
    return null;
  }
}

function revokeObjectUrl(value) {
  if (!value) return;
  try {
    URL.revokeObjectURL(value);
  } catch (_) {}
}

function revokeMem(id) {
  const hit = memById.get(id);
  if (!hit) return;
  memById.delete(id);
  const sourceHit = memBySource.get(hit.sourceUrl);
  if (!sourceHit) {
    revokeObjectUrl(hit.objectUrl);
    return;
  }
  sourceHit.ids.delete(id);
  if (!sourceHit.ids.size) {
    memBySource.delete(hit.sourceUrl);
    revokeObjectUrl(sourceHit.objectUrl);
  }
}

function rememberObjectUrl(id, sourceUrl, objectUrl) {
  const prev = memById.get(id);
  if (prev?.sourceUrl !== sourceUrl) revokeMem(id);

  const shared = memBySource.get(sourceUrl);
  if (shared) {
    shared.ids.add(id);
    memById.set(id, { objectUrl: shared.objectUrl, sourceUrl });
    if (objectUrl !== shared.objectUrl) revokeObjectUrl(objectUrl);
    return shared.objectUrl;
  }

  memBySource.set(sourceUrl, { objectUrl, ids: new Set([id]) });
  memById.set(id, { objectUrl, sourceUrl });
  return objectUrl;
}

function thumbConcurrency() {
  if (typeof navigator === 'undefined') return 2;
  const ua = String(navigator.userAgent || '');
  const ios = /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1);
  return ios ? 1 : 2;
}

function drainThumbJobQueue() {
  const limit = thumbConcurrency();
  while (activeThumbJobs < limit && thumbJobQueue.length) {
    const job = thumbJobQueue.shift();
    activeThumbJobs += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeThumbJobs = Math.max(0, activeThumbJobs - 1);
        drainThumbJobQueue();
      });
  }
}

function enqueueThumbJob(task) {
  return new Promise((resolve, reject) => {
    thumbJobQueue.push({ task, resolve, reject });
    drainThumbJobQueue();
  });
}

function generateThumbBlobOnce(sourceUrl, sourceBlob) {
  const key = stickerSourceFingerprint(sourceUrl);
  const existing = thumbBlobInflight.get(key);
  if (existing) return existing;
  const task = enqueueThumbJob(() => blobToThumbBlob(sourceBlob))
    .catch(() => null)
    .finally(() => thumbBlobInflight.delete(key));
  thumbBlobInflight.set(key, task);
  return task;
}

async function readCachedThumbObjectUrl(id, sourceUrl) {
  const mem = memById.get(id);
  if (mem && mem.sourceUrl === sourceUrl) return mem.objectUrl;

  const cache = await openThumbCache();
  if (!cache) return '';
  let matched = null;
  try {
    matched = await settleWithin(cache.match(cacheRequestUrl(id)));
  } catch (_) {
    return '';
  }
  if (!matched) return '';
  const storedKey = String(matched.headers.get('X-Source-Key') || '').trim();
  if (!storedKey || storedKey !== stickerSourceFingerprint(sourceUrl)) {
    await settleWithin(cache.delete(cacheRequestUrl(id)), false);
    revokeMem(id);
    return '';
  }
  try {
    const blob = await settleWithin(matched.blob());
    if (!blob || !blob.size) return '';
    return rememberObjectUrl(id, sourceUrl, URL.createObjectURL(blob));
  } catch (_) {
    return '';
  }
}

export function dataImageUrlToBlob(value = '') {
  const source = String(value || '').trim();
  const commaAt = source.indexOf(',');
  if (!isInlineStickerImageUrl(source) || commaAt < 0) {
    throw new Error('invalid_data_image');
  }
  const meta = source.slice(5, commaAt);
  const payload = source.slice(commaAt + 1);
  const mime = String(meta.split(';')[0] || 'image/png').trim() || 'image/png';
  const bytes = /;base64(?:;|$)/i.test(meta)
    ? (() => {
      const binary = atob(payload.replace(/\s+/g, ''));
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
      return out;
    })()
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new Blob([bytes], { type: mime });
}

async function loadSourceBlob(url) {
  const src = upgradeStickerImageUrl(url);
  if (isInlineStickerImageUrl(src)) {
    return dataImageUrlToBlob(src);
  }
  if (/^blob:/i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error('data_fetch_failed');
    return res.blob();
  }
  try {
    const res = await fetch(src, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
    if (res.ok) {
      const ct = String(res.headers.get('content-type') || '');
      if (!ct || /^image\//i.test(ct) || /octet-stream/i.test(ct)) {
        return await res.blob();
      }
    }
  } catch (_) {}

  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const finish = (blob, err) => {
      if (settled) return;
      settled = true;
      if (blob) resolve(blob);
      else reject(err || new Error('cors_image_failed'));
    };
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, img.naturalWidth || img.width || 1);
        canvas.height = Math.max(1, img.naturalHeight || img.height || 1);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(null, new Error('no_canvas'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) finish(blob);
          else finish(null, new Error('tainted_or_empty'));
        }, 'image/png');
      } catch (err) {
        finish(null, err);
      }
    };
    img.onerror = () => finish(null, new Error('img_error'));
    img.src = src;
  });
}

async function blobToThumbBlob(sourceBlob) {
  const outputMime = stickerThumbOutputMime(sourceBlob);
  let bitmap = null;
  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(sourceBlob);
    }
  } catch (_) {
    bitmap = null;
  }

  const draw = (width, height, paint) => {
    const maxEdge = Math.max(width, height) || 1;
    const scale = Math.min(1, THUMB_MAX_EDGE / maxEdge);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no_canvas');
    paint(ctx, w, h);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('thumb_empty'))),
        outputMime,
        outputMime === 'image/jpeg' ? THUMB_QUALITY : undefined,
      );
    });
  };

  if (bitmap) {
    try {
      return await draw(bitmap.width, bitmap.height, (ctx, w, h) => {
        ctx.drawImage(bitmap, 0, 0, w, h);
      });
    } finally {
      try { bitmap.close(); } catch (_) {}
    }
  }

  const objectUrl = URL.createObjectURL(sourceBlob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('thumb_img'));
      el.src = objectUrl;
    });
    return await draw(
      img.naturalWidth || img.width || 1,
      img.naturalHeight || img.height || 1,
      (ctx, w, h) => { ctx.drawImage(img, 0, 0, w, h); },
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function writeThumbToCache(id, sourceUrl, thumbBlob) {
  const cache = await openThumbCache();
  if (cache) {
    try {
      const headers = new Headers({
        'Content-Type': thumbBlob.type || 'image/jpeg',
        'X-Source-Key': stickerSourceFingerprint(sourceUrl),
        'X-Cached-At': String(Date.now()),
      });
      await settleWithin(
        cache.put(cacheRequestUrl(id), new Response(thumbBlob, { headers })),
        false,
      );
    } catch (_) {
      // Cache Storage 丢连接或配额不足时仍返回本次会话可用的 object URL。
    }
  }
  return rememberObjectUrl(id, sourceUrl, URL.createObjectURL(thumbBlob));
}

/**
 * 只读已有缩略图（内存 / Cache），不触发网络生成。
 * @returns {Promise<Map<string, string>>} stickerId -> displaySrc
 */
export async function peekStickerThumbSrcMap(stickers = []) {
  const map = new Map();
  const list = Array.isArray(stickers) ? stickers : [];
  await Promise.all(list.map(async (sticker) => {
    const id = stickerIdOf(sticker);
    const url = stickerUrlOf(sticker);
    if (!id || !url) return;
    const cached = await readCachedThumbObjectUrl(id, url);
    if (cached) map.set(id, cached);
  }));
  return map;
}

/**
 * 展示用 src：有缩略图用缩略图，否则回退原 URL（不改 sticker.url）。
 */
export async function resolveStickerDisplaySrc(sticker) {
  const id = stickerIdOf(sticker);
  const url = stickerUrlOf(sticker);
  if (!url) return '';
  const displayUrl = upgradeStickerImageUrl(url);
  if (!id) return displayUrl;
  const cached = await readCachedThumbObjectUrl(id, url);
  return cached || displayUrl;
}

/**
 * 尽力生成并写入缩略图；失败则返回 null（调用方继续用原 URL）。
 * @returns {Promise<string|null>} object URL or null
 */
export async function ensureStickerThumb(sticker, options = {}) {
  const id = stickerIdOf(sticker);
  const url = stickerUrlOf(sticker);
  if (!id || !url) return null;
  const inlineImage = isInlineStickerImageUrl(url);
  if (typeof caches === 'undefined' && !inlineImage) return null;

  const failKey = uncacheableKey(id, url);
  if (uncacheableKeys.has(failKey)) return null;

  const existing = await readCachedThumbObjectUrl(id, url);
  if (existing) return existing;

  const inflightKey = failKey;
  if (inflight.has(inflightKey)) return inflight.get(inflightKey);

  const task = (async () => {
    try {
      const sourceBlob = await loadSourceBlob(url);
      if (!sourceBlob || !sourceBlob.size) {
        uncacheableKeys.add(failKey);
        return null;
      }
      if (inlineImage) {
        // 本地上传图优先立刻交给浏览器显示。旧链路必须等 createImageBitmap、
        // canvas 和 Cache Storage 全部走完才给 <img> src；任一步在 WebView
        // 挂起，页面就会永久空白。缩略图改为后台尽力生成，不再阻塞首帧。
        const displaySrc = rememberObjectUrl(id, url, URL.createObjectURL(sourceBlob));
        if (options.generateThumb === false) return displaySrc;
        void generateThumbBlobOnce(url, sourceBlob)
          .then(async (thumbBlob) => {
            if (!thumbBlob) return;
            const cache = await openThumbCache();
            if (!cache) return;
            const headers = new Headers({
              'Content-Type': thumbBlob.type || 'image/jpeg',
              'X-Source-Key': stickerSourceFingerprint(url),
              'X-Cached-At': String(Date.now()),
            });
            await settleWithin(
              cache.put(cacheRequestUrl(id), new Response(thumbBlob, { headers })),
              false,
            );
          })
          .catch(() => {});
        return displaySrc;
      }
      let thumbBlob = null;
      try {
        thumbBlob = await blobToThumbBlob(sourceBlob);
      } catch (_) {
        throw _;
      }
      return await writeThumbToCache(id, url, thumbBlob);
    } catch (_) {
      uncacheableKeys.add(failKey);
      return null;
    } finally {
      inflight.delete(inflightKey);
    }
  })();

  inflight.set(inflightKey, task);
  return task;
}

/**
 * @param {Array<{ id?: string, url?: string }>} stickers
 * @param {{ onReady?: (id: string, displaySrc: string) => void, concurrency?: number }} [options]
 */
export async function ensureStickerThumbs(stickers = [], options = {}) {
  const list = (Array.isArray(stickers) ? stickers : []).filter((s) => stickerIdOf(s) && stickerUrlOf(s));
  if (!list.length) return;
  const onReady = typeof options.onReady === 'function' ? options.onReady : null;
  const concurrency = Math.max(1, Math.min(6, Number(options.concurrency) || ENSURE_CONCURRENCY));

  for (let i = 0; i < list.length; i += concurrency) {
    const chunk = list.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (sticker) => {
      const id = stickerIdOf(sticker);
      const src = await ensureStickerThumb(sticker);
      if (src && onReady) onReady(id, src);
    }));
  }
}

export async function deleteStickerThumbs(ids = []) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!list.length) return;
  for (const id of list) {
    revokeMem(id);
    for (const key of [...uncacheableKeys]) {
      if (key.startsWith(`${id}\n`)) uncacheableKeys.delete(key);
    }
  }
  const cache = await openThumbCache();
  if (!cache) return;
  await Promise.all(list.map((id) => cache.delete(cacheRequestUrl(id)).catch(() => false)));
}

/** 清理不在有效 id 集合内的孤儿缩略图 */
export async function pruneStickerThumbs(validIds = []) {
  const valid = new Set([...validIds].map((x) => String(x || '').trim()).filter(Boolean));
  const cache = await openThumbCache();
  if (!cache) return;
  const keys = await cache.keys();
  const prefix = 'https://mm-sticker-thumb.local/';
  for (const req of keys) {
    const href = String(req?.url || '');
    if (!href.startsWith(prefix)) continue;
    let id = '';
    try {
      id = decodeURIComponent(href.slice(prefix.length));
    } catch (_) {
      id = href.slice(prefix.length);
    }
    if (id && !valid.has(id)) {
      await cache.delete(req).catch(() => false);
      revokeMem(id);
    }
  }
}

export async function clearAllStickerThumbs() {
  for (const id of [...memById.keys()]) revokeMem(id);
  memBySource.clear();
  uncacheableKeys.clear();
  inflight.clear();
  if (typeof caches === 'undefined') return;
  try {
    await Promise.all([CACHE_NAME, ...LEGACY_CACHE_NAMES].map((name) => caches.delete(name)));
  } catch (_) {}
}

/** 把已就绪的缩略图写回页面上的 img[data-stk-id] */
export function applyStickerThumbToImgs(root, id, displaySrc) {
  const sid = String(id || '').trim();
  const src = String(displaySrc || '').trim();
  if (!root || !sid || !src) return;
  root.querySelectorAll('img[data-stk-id]').forEach((img) => {
    if (img.getAttribute('data-stk-id') !== sid) return;
    if (img.getAttribute('src') === src) return;
    img.classList.remove('is-broken');
    img.style.removeProperty('opacity');
    if (img.nextElementSibling?.classList?.contains('stk-thumb-broken')) {
      img.nextElementSibling.hidden = true;
    }
    img.setAttribute('src', src);
  });
}
