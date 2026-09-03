import * as db from './db.js';

const OPFS_PREFIX = 'mm-radio-audio-v1-';
const CACHE_NAME = 'mm-radio-audio-v1';
const IDB_PREFIX = 'radioAudioBlob_';

function clean(value = '', max = 240) {
  return String(value || '').trim().slice(0, max);
}

function hashText(value = '', seed = 2166136261) {
  let hash = seed >>> 0;
  const source = String(value || '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function radioAudioCacheKey(episodeId = '', chapterId = '') {
  const source = `${clean(episodeId)}\0${clean(chapterId)}`;
  return `${hashText(source)}${hashText(source, 3339675911)}`;
}

function cacheRequest(key = '') {
  return new Request(`https://mm.local/__radio_audio_cache__/${encodeURIComponent(key)}`);
}

async function writeOpfs(key, blob) {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return null;
  const root = await storage.getDirectory();
  const handle = await root.getFileHandle(`${OPFS_PREFIX}${key}`, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return 'opfs';
}

async function readOpfs(key) {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return null;
  const root = await storage.getDirectory();
  const handle = await root.getFileHandle(`${OPFS_PREFIX}${key}`);
  const file = await handle.getFile();
  return file?.size ? file : null;
}

async function deleteOpfs(key) {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return;
  const root = await storage.getDirectory();
  await root.removeEntry(`${OPFS_PREFIX}${key}`);
}

async function writeCacheStorage(key, blob) {
  if (!globalThis.caches?.open || typeof Request === 'undefined' || typeof Response === 'undefined') return null;
  const cache = await globalThis.caches.open(CACHE_NAME);
  await cache.put(cacheRequest(key), new Response(blob, {
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
  }));
  return 'cache-storage';
}

async function readCacheStorage(key) {
  if (!globalThis.caches?.open || typeof Request === 'undefined') return null;
  const cache = await globalThis.caches.open(CACHE_NAME);
  const response = await cache.match(cacheRequest(key));
  if (!response?.ok) return null;
  const blob = await response.blob();
  return blob?.size ? blob : null;
}

async function deleteCacheStorage(key) {
  if (!globalThis.caches?.open || typeof Request === 'undefined') return;
  const cache = await globalThis.caches.open(CACHE_NAME);
  await cache.delete(cacheRequest(key));
}

async function writeIndexedDb(key, blob, episodeId, chapterId) {
  await db.putRecord('settings', {
    key: `${IDB_PREFIX}${key}`,
    value: { episodeId, chapterId, blob },
    updatedAt: Date.now(),
  });
  return 'indexeddb';
}

async function readIndexedDb(key) {
  const stored = await db.getRecord('settings', `${IDB_PREFIX}${key}`).catch(() => null);
  return stored?.value?.blob instanceof Blob && stored.value.blob.size ? stored.value.blob : null;
}

async function deleteIndexedDb(key) {
  await db.deleteRecord('settings', `${IDB_PREFIX}${key}`).catch(() => {});
}

export async function writeRadioAudioCache(episodeId = '', chapterId = '', blob = null) {
  if (!(blob instanceof Blob) || !blob.size) return null;
  const key = radioAudioCacheKey(episodeId, chapterId);
  const writers = [
    () => writeOpfs(key, blob),
    () => writeCacheStorage(key, blob),
    () => writeIndexedDb(key, blob, clean(episodeId), clean(chapterId)),
  ];
  for (const write of writers) {
    try {
      const backend = await write();
      if (backend) return {
        key,
        backend,
        type: clean(blob.type || 'application/octet-stream', 80),
        size: blob.size,
      };
    } catch (_) { /* try the next local backend */ }
  }
  return null;
}

export async function readRadioAudioCache(meta = null) {
  const key = clean(meta?.key, 80);
  if (!key) return null;
  const readers = {
    opfs: () => readOpfs(key),
    'cache-storage': () => readCacheStorage(key),
    indexeddb: () => readIndexedDb(key),
  };
  const order = [clean(meta?.backend, 40), 'opfs', 'cache-storage', 'indexeddb']
    .filter((name, index, rows) => readers[name] && rows.indexOf(name) === index);
  for (const name of order) {
    try {
      const blob = await readers[name]();
      if (blob?.size) {
        if (blob.type || !meta?.type) return blob;
        return new Blob([blob], { type: clean(meta.type, 80) });
      }
    } catch (_) { /* try another backend */ }
  }
  return null;
}

export async function deleteRadioAudioCache(meta = null) {
  const key = clean(meta?.key, 80);
  if (!key) return;
  await Promise.allSettled([
    deleteOpfs(key),
    deleteCacheStorage(key),
    deleteIndexedDb(key),
  ]);
}
