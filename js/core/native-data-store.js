import {
  appendJsonValueToWriter,
  reviveBackupBlobValues,
} from './backup-json-stream.js';

const ENABLED_APP_ID = 'com.marshmallow.machine.next';
const CACHE_SEQUENCE_KEY = '__mm_native_cache_sequence_v1__';
const CACHE_META_KEY = '__mm_native_cache_meta_v2__';
const FORCE_REBUILD_KEY = '__mm_native_force_rebuild_v1__';
const IMPORT_PENDING_KEY = '__mm_native_import_pending_v1__';
const CACHE_FAILURE_KEY = '__mm_native_cache_failure_v1__';
const JOURNAL_REPAIR_FAILURE_KEY = '__mm_native_journal_repair_failure_v1__';
const CACHE_REBUILD_IN_PROGRESS_KEY = '__mm_native_cache_rebuild_in_progress_v1__';
const DIRECT_PAYLOAD_BYTES = 160 * 1024;
const TRANSFER_CHUNK_BYTES = 256 * 1024;
const BATCH_PAYLOAD_BYTES = 384 * 1024;
const BATCH_RECORDS = 48;
// 华为 WebView 114 在同一记录连续回传第二段较大 Base64 时，可能把 Promise
// resolve 成空结果。32KB 对应约 43KB Base64；只影响少数大记录，普通记录仍是
// 一次读取。失败重试还会继续减半，避免原尺寸重复撞同一个桥接边界。
const READ_CHUNK_BYTES = 32 * 1024;
const READ_CHUNK_MIN_BYTES = 8 * 1024;
const READ_CHUNK_MAX_ATTEMPTS = 3;
const READ_CHUNK_TIMEOUT_MS = 20_000;
// 美化图片单条允许 4MB 原图，转为 data URL 后 JSON 会超过 5MB。
// 旧华为 WebView 无法可靠完成同一插件方法的第二次分块回调，因此在受控上限内
// 由原生一次返回 UTF-8，并由原生计算原始字节校验，避免 JS 再复制一份大 Uint8Array。
const DIRECT_TEXT_READ_BYTES = 8 * 1024 * 1024;
const CACHE_REBUILD_BATCH_RECORDS = 32;
const CACHE_REBUILD_BATCH_BYTES = 4 * 1024 * 1024;
const SMALL_JOURNAL_GAP_LIMIT = 128;
const JOURNAL_REPAIR_RETRY_DELAYS = [0, 120, 400];

let cachedCapability;
let statusPromise = null;
let mirrorSuppressed = false;
let stagingGeneration = 0;
let nativeWriteRunning = false;
const nativeWriteForegroundQueue = [];
const nativeWriteBackgroundQueue = [];
let nativeForegroundBurst = 0;
let recreationNeedsRebuild = false;
let pendingCacheMeta = null;
let cacheMetaFlushTimer = 0;
let cacheMetaFlushPromise = Promise.resolve();
let deferredJournalRepairTimer = 0;
let deferredJournalRepairRunning = false;

function plugin() {
  return globalThis.Capacitor?.Plugins?.MarshmallowNativeData || null;
}

function isNativeRuntime() {
  try {
    // Capacitor 原生桥只由顶层 App 使用。美化工作室的同源 iframe 会继承
    // window.Capacitor，但子 frame 中的插件 Promise 在部分 WebView 里不会回调。
    if (globalThis.top !== globalThis.self) return false;
    return !!(
      globalThis.Capacitor
      && typeof globalThis.Capacitor.isNativePlatform === 'function'
      && globalThis.Capacitor.isNativePlatform()
    );
  } catch (_) {
    return false;
  }
}

function storageGet(key) {
  try { return globalThis.localStorage?.getItem(key) || ''; } catch (_) { return ''; }
}

function storageSet(key, value) {
  try { globalThis.localStorage?.setItem(key, String(value)); } catch (_) {}
}

function storageRemove(key) {
  try { globalThis.localStorage?.removeItem(key); } catch (_) {}
}

function toNativeRecordKey(value) {
  const json = JSON.stringify(value);
  if (!json || json.length > 2048) throw new Error('原生主库记录键无效');
  return json;
}

function bytesToBase64(bytes) {
  let binary = '';
  const step = 24 * 1024;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function invalidateStatus() {
  statusPromise = null;
}

export async function getNativeDataStatus({ fresh = false } = {}) {
  if (!isNativeRuntime()) {
    return { ok: true, enabled: false, recordCount: 0, lastSequence: 0 };
  }
  if (!fresh && statusPromise) return statusPromise;
  const p = plugin();
  if (!p?.getStatus) {
    return { ok: true, enabled: false, recordCount: 0, lastSequence: 0 };
  }
  const pending = Promise.resolve(p.getStatus()).then((status) => {
    const normalized = {
      ...(status || {}),
      enabled: status?.enabled === true && String(status?.appId || '') === ENABLED_APP_ID,
      activeGeneration: Number(status?.activeGeneration || 0),
      stagingGeneration: Number(status?.stagingGeneration || 0),
      recordCount: Number(status?.recordCount || 0),
      lastSequence: Number(status?.lastSequence || 0),
      storeCounts: status?.storeCounts && typeof status.storeCounts === 'object'
        ? { ...status.storeCounts }
        : {},
    };
    cachedCapability = normalized.enabled;
    return normalized;
  }).catch((error) => {
    statusPromise = null;
    throw error;
  });
  statusPromise = pending;
  return pending;
}

export async function isNativeDataStoreEnabled() {
  if (cachedCapability === false) return false;
  const status = await getNativeDataStatus();
  return status.enabled === true;
}

export function isNativeMirrorSuppressed() {
  return mirrorSuppressed;
}

export function setNativeMirrorSuppressed(value) {
  mirrorSuppressed = value === true;
}

function drainNativeWriteQueue() {
  if (nativeWriteRunning) return;
  const shouldYieldToBackground = nativeForegroundBurst >= 8 && nativeWriteBackgroundQueue.length > 0;
  const job = shouldYieldToBackground
    ? nativeWriteBackgroundQueue.shift()
    : (nativeWriteForegroundQueue.shift() || nativeWriteBackgroundQueue.shift());
  if (!job) return;
  nativeForegroundBurst = job.priority === 'foreground' ? nativeForegroundBurst + 1 : 0;
  nativeWriteRunning = true;
  Promise.resolve()
    .then(job.task)
    .then(job.resolve, job.reject)
    .finally(() => {
      nativeWriteRunning = false;
      queueMicrotask(drainNativeWriteQueue);
    });
}

export async function runNativeWriteExclusive(task, { priority = 'background' } = {}) {
  if (!(await isNativeDataStoreEnabled())) return task();
  return new Promise((resolve, reject) => {
    const queue = priority === 'foreground'
      ? nativeWriteForegroundQueue
      : nativeWriteBackgroundQueue;
    queue.push({ task, resolve, reject, priority });
    drainNativeWriteQueue();
  });
}

async function writeLargeRecord(p, storeName, recordKey, bytes, generation) {
  const sessionId = `native_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await p.beginRecordWrite({ sessionId, storeName, recordKey, generation });
  try {
    for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES);
      await p.appendRecordBase64({ sessionId, base64: bytesToBase64(chunk) });
      if (offset > 0 && offset % (TRANSFER_CHUNK_BYTES * 4) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return await p.finishRecordWrite({ sessionId });
  } catch (error) {
    await p.abortRecordWrite?.({ sessionId }).catch(() => {});
    throw error;
  }
}

function containsBlob(value, seen = new Set()) {
  if (value instanceof Blob) return true;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some((item) => containsBlob(item, seen));
    return Object.keys(value).some((key) => containsBlob(value[key], seen));
  } finally {
    seen.delete(value);
  }
}

async function writeRecordWithBlobs(p, storeName, recordKey, record, generation) {
  const sessionId = `native_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await p.beginRecordWrite({ sessionId, storeName, recordKey, generation });
  const encoder = new TextEncoder();
  let bufferedBytes = 0;
  let chunks = [];
  const writer = {
    shouldDrain: false,
    write(value) {
      const bytes = encoder.encode(String(value));
      if (!bytes.byteLength) return;
      chunks.push(bytes);
      bufferedBytes += bytes.byteLength;
      this.shouldDrain = bufferedBytes >= TRANSFER_CHUNK_BYTES;
    },
    async drain() {
      if (!bufferedBytes) return;
      const merged = new Uint8Array(bufferedBytes);
      let cursor = 0;
      for (const chunk of chunks) {
        merged.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
      chunks = [];
      bufferedBytes = 0;
      this.shouldDrain = false;
      await p.appendRecordBase64({ sessionId, base64: bytesToBase64(merged) });
    },
  };
  try {
    await appendJsonValueToWriter(writer, record);
    await writer.drain();
    return await p.finishRecordWrite({ sessionId });
  } catch (error) {
    await p.abortRecordWrite?.({ sessionId }).catch(() => {});
    throw error;
  }
}

export async function mirrorNativePut(storeName, key, record) {
  if (mirrorSuppressed || !(await isNativeDataStoreEnabled())) return null;
  const p = plugin();
  const recordKey = toNativeRecordKey(key);
  if (containsBlob(record)) {
    const result = await writeRecordWithBlobs(
      p,
      storeName,
      recordKey,
      record,
      Number(stagingGeneration || 0),
    );
    invalidateStatus();
    return result || null;
  }
  let payload;
  try {
    payload = JSON.stringify(record);
  } catch (error) {
    throw new Error(`原生主库无法序列化 ${storeName}：${error?.message || error}`);
  }
  if (!payload) throw new Error(`原生主库拒绝空记录：${storeName}`);
  const bytes = new TextEncoder().encode(payload);
  const generation = Number(stagingGeneration || 0);
  const result = bytes.byteLength <= DIRECT_PAYLOAD_BYTES
    ? await p.putRecord({ storeName, recordKey, payload, generation })
    : await writeLargeRecord(p, storeName, recordKey, bytes, generation);
  invalidateStatus();
  return result || null;
}

export async function mirrorNativePutMany(storeName, keyPath, records = []) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length || mirrorSuppressed || !(await isNativeDataStoreEnabled())) return null;
  const p = plugin();
  const nativeStatus = await getNativeDataStatus();
  // 旧 APK 已暴露 putRecords，但该版本只允许搬家暂存代；网页热更新必须等待
  // 原生明确声明 activeBatchPut，在线写否则继续走兼容的逐条入口。
  const canBatchThisGeneration = typeof p?.putRecords === 'function'
    && (stagingGeneration > 0 || nativeStatus?.activeBatchPut === true);
  if (!canBatchThisGeneration) {
    let result = null;
    for (const record of list) result = await mirrorNativePut(storeName, record?.[keyPath], record);
    return result;
  }

  // 在线代与搬家暂存代都可以把小 JSON 合并为一次桥调用。
  // 原生层仍会逐文件 fsync 在线记录，只合并 SQLite 索引与日志事务。
  const generation = Number(stagingGeneration || 0);
  let pending = [];
  let pendingBytes = 0;
  let lastResult = null;
  const flush = async () => {
    if (!pending.length) return;
    lastResult = await p.putRecords({ storeName, generation, records: pending });
    invalidateStatus();
    pending = [];
    pendingBytes = 0;
  };

  for (const record of list) {
    if (containsBlob(record)) {
      await flush();
      lastResult = await mirrorNativePut(storeName, record?.[keyPath], record);
      continue;
    }
    let payload;
    try {
      payload = JSON.stringify(record);
    } catch (error) {
      throw new Error(`原生主库无法序列化 ${storeName}：${error?.message || error}`);
    }
    if (!payload) throw new Error(`原生主库拒绝空记录：${storeName}`);
    const payloadBytes = new TextEncoder().encode(payload).byteLength;
    if (payloadBytes > DIRECT_PAYLOAD_BYTES) {
      await flush();
      lastResult = await mirrorNativePut(storeName, record?.[keyPath], record);
      continue;
    }
    if (pending.length && (
      pending.length >= BATCH_RECORDS
      || pendingBytes + payloadBytes > BATCH_PAYLOAD_BYTES
    )) await flush();
    pending.push({ recordKey: toNativeRecordKey(record?.[keyPath]), payload });
    pendingBytes += payloadBytes;
  }
  await flush();
  invalidateStatus();
  return lastResult;
}

export async function mirrorNativeDelete(storeName, key) {
  if (mirrorSuppressed || !(await isNativeDataStoreEnabled())) return null;
  const result = await plugin().deleteRecord({
    storeName,
    recordKey: toNativeRecordKey(key),
    generation: Number(stagingGeneration || 0),
  });
  invalidateStatus();
  return result || null;
}

export async function mirrorNativeDeleteMany(storeName, keys = []) {
  const list = Array.isArray(keys)
    ? keys.filter((key) => key !== undefined && key !== null)
    : [];
  if (!list.length || mirrorSuppressed || !(await isNativeDataStoreEnabled())) return null;
  const p = plugin();
  const nativeStatus = await getNativeDataStatus();
  if (typeof p?.deleteRecords !== 'function' || nativeStatus?.activeBatchDelete !== true) {
    let result = null;
    for (const key of list) result = await mirrorNativeDelete(storeName, key);
    return result;
  }
  let lastResult = null;
  for (let index = 0; index < list.length; index += 512) {
    lastResult = await p.deleteRecords({
      storeName,
      recordKeys: list.slice(index, index + 512).map(toNativeRecordKey),
      generation: Number(stagingGeneration || 0),
    });
  }
  invalidateStatus();
  return lastResult || null;
}

export async function mirrorNativeClear(storeName) {
  if (mirrorSuppressed || !(await isNativeDataStoreEnabled())) return null;
  const result = await plugin().clearStore({
    storeName,
    generation: Number(stagingGeneration || 0),
  });
  invalidateStatus();
  return result || null;
}

async function writeIndexedDbCacheMeta({ sequence = 0, generation = 0, reason = 'commit' } = {}) {
  const nextSequence = Number(sequence || 0);
  if (nextSequence <= 0) return false;
  try {
    const db = await import('./db.js');
    await db.putCacheOnlySetting(CACHE_META_KEY, {
      sequence: nextSequence,
      generation: Number(generation || 0),
      reason: String(reason || 'commit'),
      completedAt: Date.now(),
      build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
    });
    return true;
  } catch (error) {
    try { console.warn('[native-data] 无法写入缓存完成元数据', error); } catch (_) {}
    return false;
  }
}

async function readIndexedDbCacheMeta() {
  try {
    const db = await import('./db.js');
    const row = await db.getCacheOnlySetting(CACHE_META_KEY);
    const value = row?.value;
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function scheduleIndexedDbCacheMeta(meta = {}) {
  pendingCacheMeta = { ...(pendingCacheMeta || {}), ...meta };
  if (cacheMetaFlushTimer) return;
  cacheMetaFlushTimer = setTimeout(() => {
    cacheMetaFlushTimer = 0;
    const next = pendingCacheMeta;
    pendingCacheMeta = null;
    cacheMetaFlushPromise = cacheMetaFlushPromise
      .catch(() => {})
      .then(() => writeIndexedDbCacheMeta(next));
  }, 0);
}

async function flushIndexedDbCacheMeta() {
  if (cacheMetaFlushTimer) {
    clearTimeout(cacheMetaFlushTimer);
    cacheMetaFlushTimer = 0;
  }
  const next = pendingCacheMeta;
  pendingCacheMeta = null;
  if (next) {
    cacheMetaFlushPromise = cacheMetaFlushPromise
      .catch(() => {})
      .then(() => writeIndexedDbCacheMeta(next));
  }
  await cacheMetaFlushPromise;
}

/**
 * 需要用 IndexedDB 缓存做原生主库写入前置 CAS 时，先证明缓存已追到主库最新序号。
 * FORCE_REBUILD / 日志修复失败 / 搬家暂存期任一存在，都不能把缓存读当成权威事实。
 */
export async function verifyNativeIndexedDbCacheCurrent() {
  if (!(await isNativeDataStoreEnabled())) {
    return { current: true, reason: 'native-disabled', status: null, cacheMeta: null };
  }
  await flushIndexedDbCacheMeta();
  const [status, cacheMeta] = await Promise.all([
    getNativeDataStatus({ fresh: true }),
    readIndexedDbCacheMeta(),
  ]);
  if (storageGet(FORCE_REBUILD_KEY)) {
    return { current: false, reason: 'cache-rebuild-required', status, cacheMeta };
  }
  if (storageGet(JOURNAL_REPAIR_FAILURE_KEY)) {
    return { current: false, reason: 'journal-repair-required', status, cacheMeta };
  }
  if (Number(status?.stagingGeneration || 0) > 0 || stagingGeneration > 0) {
    return { current: false, reason: 'native-staging-active', status, cacheMeta };
  }
  const nativeSequence = Number(status?.lastSequence || 0);
  const cacheSequence = Number(cacheMeta?.sequence || 0);
  if (nativeSequence > 0 && cacheSequence !== nativeSequence) {
    return { current: false, reason: 'cache-sequence-behind', status, cacheMeta };
  }
  return { current: true, reason: 'current', status, cacheMeta };
}

function installCacheMetaLifecycleFlush() {
  if (
    typeof window === 'undefined'
    || typeof document === 'undefined'
    || window.__mmNativeCacheMetaFlushInstalled
  ) return;
  window.__mmNativeCacheMetaFlushInstalled = true;
  const flush = () => { void flushIndexedDbCacheMeta(); };
  window.addEventListener('pagehide', flush, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush();
  }, { capture: true });
}

installCacheMetaLifecycleFlush();

export function markNativeCacheCommit(result) {
  if (!result || stagingGeneration > 0) return;
  const sequence = Number(result.sequence || 0);
  if (sequence <= 0) return;
  // 一旦出现过缓存写入缺口，后续成功写入不能把完成序号越过缺口；否则启动时
  // 会误以为缓存完整。待增量日志补齐后再一次性推进到主库最新序号。
  if (storageGet(FORCE_REBUILD_KEY) || storageGet(JOURNAL_REPAIR_FAILURE_KEY)) return;
  storageSet(CACHE_SEQUENCE_KEY, sequence);
  scheduleIndexedDbCacheMeta({
    sequence,
    generation: Number(result.generation || 0),
    reason: 'business-write',
  });
}

export function markNativeCacheRebuildRequired(reason = '', error = null) {
  const detectedAt = Date.now();
  storageSet(FORCE_REBUILD_KEY, detectedAt);
  storageSet(CACHE_FAILURE_KEY, JSON.stringify({
    detectedAt,
    reason: String(reason || 'indexeddb-cache-write-failed'),
    name: String(error?.name || ''),
    message: String(error?.message || error || '').slice(0, 500),
    build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
  }));
  try {
    globalThis.dispatchEvent?.(new CustomEvent('marshmallow-native-cache-needs-rebuild', {
      detail: { reason: String(reason || ''), error },
    }));
  } catch (_) {}
}

export async function shouldAllowNativeDatabaseRecreation() {
  try {
    const status = await getNativeDataStatus({ fresh: true });
    // 这里仅回答“若稍后真的收到 oldVersion=0，是否有原生主库可恢复”。
    // 不能在普通 indexedDB.open 前就置重建标记，否则每次正常启动都会被误判为重建。
    return status.enabled === true && status.recordCount > 0;
  } catch (error) {
    console.warn('[native-data] 无法确认原生主库状态，保留旧空库保护', error);
    return false;
  }
}

export function markNativeDatabaseRecreationDetected() {
  recreationNeedsRebuild = true;
}

export async function beginNativeReplaceImport(options = {}) {
  if (!(await isNativeDataStoreEnabled())) return null;
  if (stagingGeneration > 0) throw new Error('已有原生搬家暂存事务正在进行');
  const preserveStores = Array.isArray(options.preserveStores)
    ? [...new Set(options.preserveStores.map((name) => String(name || '').trim()).filter(Boolean))]
    : [];
  const result = await plugin().beginReplaceImport({ preserveStores });
  const generation = Number(result?.generation || 0);
  if (generation <= 0) throw new Error('原生主库没有返回有效暂存代');
  stagingGeneration = generation;
  storageSet(IMPORT_PENDING_KEY, JSON.stringify({ generation, startedAt: Date.now() }));
  invalidateStatus();
  return { generation };
}

export async function resumeNativeReplaceImport(generation) {
  const requested = Number(generation || 0);
  if (requested <= 0 || !(await isNativeDataStoreEnabled())) return null;
  const status = await getNativeDataStatus({ fresh: true });
  if (status.stagingGeneration !== requested) return null;
  stagingGeneration = requested;
  storageSet(IMPORT_PENDING_KEY, JSON.stringify({ generation: requested, resumedAt: Date.now() }));
  invalidateStatus();
  return { generation: requested, resumed: true };
}

export async function checkpointNativeReplaceImport() {
  if (stagingGeneration <= 0 || !(await isNativeDataStoreEnabled())) return null;
  const p = plugin();
  if (typeof p?.checkpointReplaceImport !== 'function') return null;
  return p.checkpointReplaceImport({ generation: stagingGeneration });
}

export async function commitNativeReplaceImport(expectedCounts = {}) {
  if (stagingGeneration <= 0) return null;
  const generation = stagingGeneration;
  const result = await plugin().commitReplaceImport({ generation, expectedCounts });
  stagingGeneration = 0;
  storageRemove(IMPORT_PENDING_KEY);
  storageRemove(FORCE_REBUILD_KEY);
  invalidateStatus();
  markNativeCacheCommit(result);
  await flushIndexedDbCacheMeta();
  return result || null;
}

export async function abortNativeReplaceImport() {
  let generation = stagingGeneration || (() => {
    try { return Number(JSON.parse(storageGet(IMPORT_PENDING_KEY) || 'null')?.generation || 0); } catch (_) { return 0; }
  })();
  if (generation <= 0 && await isNativeDataStoreEnabled()) {
    generation = Number((await getNativeDataStatus({ fresh: true }))?.stagingGeneration || 0);
  }
  stagingGeneration = 0;
  storageRemove(IMPORT_PENDING_KEY);
  storageSet(FORCE_REBUILD_KEY, Date.now());
  if (generation > 0 && await isNativeDataStoreEnabled()) {
    await plugin().abortReplaceImport({ generation }).catch(() => {});
  }
  invalidateStatus();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export async function readNativeChunkWithRetry(p, request, expectedBytes) {
  let lastError = null;
  for (let attempt = 1; attempt <= READ_CHUNK_MAX_ATTEMPTS; attempt += 1) {
    const attemptLength = Math.max(
      READ_CHUNK_MIN_BYTES,
      Math.floor(Number(request.length || READ_CHUNK_BYTES) / (2 ** (attempt - 1))),
    );
    const attemptRequest = { ...request, length: attemptLength };
    try {
      let timeoutId = 0;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('原生主库分块读取超时')), READ_CHUNK_TIMEOUT_MS);
      });
      let result;
      try {
        result = await Promise.race([p.readRecordChunk(attemptRequest), timeout]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
      const bytes = base64ToBytes(result?.base64 || '');
      const nextOffset = Number(result?.nextOffset || 0);
      const resultOffset = Number(result?.offset ?? request.offset);
      if (bytes.byteLength
        && resultOffset === request.offset
        && nextOffset === request.offset + bytes.byteLength) {
        return { result, bytes, nextOffset };
      }
      lastError = new Error(
        `原生主库分块没有前进（${request.offset}/${expectedBytes}，请求 ${attemptLength}）`,
      );
    } catch (error) {
      lastError = error;
    }
    if (attempt < READ_CHUNK_MAX_ATTEMPTS) await wait(60 * attempt);
  }
  throw new Error(
    `原生主库读取停滞（${request.offset}/${expectedBytes}）：${lastError?.message || lastError || '未知原因'}`,
  );
}

function updateNativeCacheRebuildProgress(detail = {}) {
  const previous = globalThis.__MARSHMALLOW_LONG_BOOT_TASK__?.kind === 'native-cache-rebuild'
    ? globalThis.__MARSHMALLOW_LONG_BOOT_TASK__
    : null;
  const progress = {
    kind: 'native-cache-rebuild',
    label: '正在从原生主库恢复本地缓存',
    updatedAt: Date.now(),
    ...(previous?.reason ? { reason: previous.reason } : {}),
    ...detail,
  };
  globalThis.__MARSHMALLOW_LONG_BOOT_TASK__ = progress;
  try {
    globalThis.dispatchEvent?.(new CustomEvent('marshmallow-native-cache-rebuild-progress', {
      detail: progress,
    }));
  } catch (_) {}
}

function clearNativeCacheRebuildProgress() {
  if (globalThis.__MARSHMALLOW_LONG_BOOT_TASK__?.kind === 'native-cache-rebuild') {
    delete globalThis.__MARSHMALLOW_LONG_BOOT_TASK__;
  }
}

async function readNativeRecordPayload(descriptor, onChunk = null) {
  const p = plugin();
  const expectedBytes = Number(descriptor?.bytes || 0);
  if (!descriptor?.fileName || expectedBytes <= 0) throw new Error('原生主库记录描述不完整');
  if (expectedBytes <= DIRECT_TEXT_READ_BYTES && typeof p?.readRecordText === 'function') {
    const result = await p.readRecordText({ fileName: String(descriptor.fileName) });
    const text = String(result?.text ?? '');
    const actualBytes = Number(result?.bytes || 0);
    if (actualBytes !== expectedBytes) {
      throw new Error(`原生主库文本长度不一致（${actualBytes}/${expectedBytes}）`);
    }
    if (descriptor?.checksum && String(result?.checksum || '') !== String(descriptor.checksum)) {
      throw new Error(`原生主库记录校验失败：${descriptor.storeName || 'unknown'}`);
    }
    onChunk?.({ offset: expectedBytes, expectedBytes });
    return reviveBackupBlobValues(JSON.parse(text));
  }
  const chunks = [];
  let total = 0;
  let offset = 0;
  while (offset < expectedBytes) {
    const request = {
      fileName: String(descriptor.fileName),
      offset,
      length: READ_CHUNK_BYTES,
    };
    const { bytes, nextOffset } = await readNativeChunkWithRetry(p, request, expectedBytes);
    chunks.push(bytes);
    total += bytes.byteLength;
    offset = nextOffset;
    onChunk?.({ offset, expectedBytes });
  }
  if (total !== expectedBytes) throw new Error(`原生主库记录长度不一致（${total}/${expectedBytes}）`);
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  if (descriptor?.checksum && globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', merged);
    const actual = bytesToHex(new Uint8Array(digest));
    if (actual !== String(descriptor.checksum)) {
      throw new Error(`原生主库记录校验失败：${descriptor.storeName || 'unknown'}`);
    }
  }
  return reviveBackupBlobValues(JSON.parse(new TextDecoder().decode(merged)));
}

function cachedSequence() {
  return Number(storageGet(CACHE_SEQUENCE_KEY) || 0);
}

function forceRebuildRequested() {
  return recreationNeedsRebuild
    || !!storageGet(FORCE_REBUILD_KEY)
    || !!storageGet(IMPORT_PENDING_KEY)
    || !!storageGet(CACHE_REBUILD_IN_PROGRESS_KEY);
}

function decodedNativeRecordKey(descriptor) {
  try { return JSON.parse(String(descriptor?.recordKey || '')); } catch (_) { return ''; }
}

function isOptionalNativeCacheRecord(storeName, descriptor) {
  if (storeName === 'soundAssets' || storeName === 'musicTracks' || storeName === 'beautifyAssets') return true;
  if (storeName !== 'settings') return false;
  const key = String(decodedNativeRecordKey(descriptor) || '');
  return key === 'voiceAudioCacheIndex'
    || key.startsWith('voiceAudioCache_')
    || key.startsWith('radioAudioBlob_')
    || key.startsWith('callLineVoice_');
}

async function rebuildIndexedDbCacheFromGeneration(status, generation, {
  completeRecovery = true,
  triggerReason = '',
} = {}) {
  const targetGeneration = Number(generation || 0);
  if (targetGeneration <= 0) throw new Error('原生主库恢复代无效');
  const db = await import('./db.js');
  setNativeMirrorSuppressed(true);
  let rebuildCheckpoint = null;
  if (completeRecovery) {
    try {
      rebuildCheckpoint = JSON.parse(storageGet(CACHE_REBUILD_IN_PROGRESS_KEY) || 'null');
    } catch (_) {
      rebuildCheckpoint = null;
    }
  }
  const canResume = !!(
    rebuildCheckpoint
    && Number(rebuildCheckpoint.generation) === targetGeneration
    && rebuildCheckpoint.phase === 'copying'
  );
  let afterStore = canResume ? String(rebuildCheckpoint.afterStore || '') : '';
  let afterKey = canResume ? String(rebuildCheckpoint.afterKey || '') : '';
  let restored = canResume ? Math.max(0, Number(rebuildCheckpoint.restored || 0)) : 0;
  updateNativeCacheRebuildProgress({
    restored,
    total: status.recordCount,
    phase: canResume ? 'resume' : 'prepare',
    reason: String(triggerReason || ''),
  });
  try {
    if (!canResume) {
      if (completeRecovery) storageSet(CACHE_REBUILD_IN_PROGRESS_KEY, JSON.stringify({
        generation: targetGeneration,
        phase: 'clearing',
        startedAt: Date.now(),
      }));
      for (const storeName of Object.keys(db.STORES)) await db.clearStore(storeName);
      if (completeRecovery) storageSet(CACHE_REBUILD_IN_PROGRESS_KEY, JSON.stringify({
        generation: targetGeneration,
        phase: 'copying',
        afterStore: '',
        afterKey: '',
        restored: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }));
    }
    let pendingStore = '';
    let pendingRecords = [];
    let pendingBytes = 0;
    const skippedRecords = [];
    const flushCacheBatch = async () => {
      if (!pendingStore || !pendingRecords.length) return;
      const count = pendingRecords.length;
      await db.putMany(pendingStore, pendingRecords);
      restored += count;
      pendingStore = '';
      pendingRecords = [];
      pendingBytes = 0;
      updateNativeCacheRebuildProgress({
        restored,
        total: status.recordCount,
        phase: 'write-cache',
      });
      await wait(0);
    };
    while (true) {
      const page = await plugin().listRecordsPage({
        generation: targetGeneration,
        afterStore,
        afterKey,
        limit: 64,
      });
      const records = Array.isArray(page?.records) ? page.records : [];
      for (const descriptor of records) {
        const storeName = String(descriptor?.storeName || '');
        if (!db.STORES[storeName]) continue;
        if (pendingStore && pendingStore !== storeName) await flushCacheBatch();
        if (!pendingStore) pendingStore = storeName;
        let record;
        try {
          record = await readNativeRecordPayload(descriptor, ({ offset, expectedBytes }) => {
            updateNativeCacheRebuildProgress({
              restored,
              total: status.recordCount,
              phase: 'read-native',
              storeName,
              recordKey: String(descriptor?.recordKey || ''),
              recordBytesRead: offset,
              recordBytes: expectedBytes,
            });
          });
        } catch (error) {
          if (isOptionalNativeCacheRecord(storeName, descriptor)) {
            skippedRecords.push({
              storeName,
              recordKey: String(decodedNativeRecordKey(descriptor) || descriptor?.recordKey || 'unknown'),
              reason: String(error?.message || error || '原生记录无法读取'),
            });
            updateNativeCacheRebuildProgress({
              restored,
              total: status.recordCount,
              phase: 'skip-optional-record',
              storeName,
              recordKey: String(descriptor?.recordKey || ''),
              skipped: skippedRecords.length,
            });
            continue;
          }
          throw new Error(
            `原生主库记录读取失败 ${storeName}/${String(descriptor?.recordKey || 'unknown')}：${error?.message || error}`,
          );
        }
        pendingRecords.push(record);
        pendingBytes += Number(descriptor?.bytes || 0);
        if (
          pendingRecords.length >= CACHE_REBUILD_BATCH_RECORDS
          || pendingBytes >= CACHE_REBUILD_BATCH_BYTES
        ) {
          await flushCacheBatch();
        }
      }
      // 每页完整写入后才推进断点。若 WebView 在页内被系统回收，下次只会幂等地
      // 重放这一页，不再清空并从数万条记录的开头重来。
      await flushCacheBatch();
      const pageDone = !!page?.done || !records.length;
      const nextStore = String(page?.nextStore || '');
      const nextKey = String(page?.nextKey || '');
      if (completeRecovery) storageSet(CACHE_REBUILD_IN_PROGRESS_KEY, JSON.stringify({
        generation: targetGeneration,
        phase: 'copying',
        afterStore: nextStore,
        afterKey: nextKey,
        restored,
        startedAt: Number(rebuildCheckpoint?.startedAt || Date.now()),
        updatedAt: Date.now(),
      }));
      if (pageDone) break;
      afterStore = nextStore;
      afterKey = nextKey;
    }
    if (completeRecovery) {
      storageSet(CACHE_SEQUENCE_KEY, status.lastSequence);
      await writeIndexedDbCacheMeta({
        sequence: status.lastSequence,
        generation: targetGeneration,
        reason: 'full-rebuild',
      });
      storageRemove(FORCE_REBUILD_KEY);
      storageRemove(IMPORT_PENDING_KEY);
      storageRemove(CACHE_FAILURE_KEY);
      storageRemove(CACHE_REBUILD_IN_PROGRESS_KEY);
      recreationNeedsRebuild = false;
    }
    globalThis.dispatchEvent?.(new CustomEvent('marshmallow-native-cache-rebuilt', {
      detail: { restored, generation: targetGeneration },
    }));
    return { rebuilt: true, restored, skippedRecords, status };
  } catch (error) {
    storageSet(FORCE_REBUILD_KEY, Date.now());
    throw error;
  } finally {
    clearNativeCacheRebuildProgress();
    setNativeMirrorSuppressed(false);
  }
}

async function indexedDbCacheLooksSubstantiallyIncomplete(status) {
  const nativeCounts = status?.storeCounts && typeof status.storeCounts === 'object'
    ? status.storeCounts
    : {};
  const nativeTotal = Object.values(nativeCounts)
    .reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
  if (nativeTotal < 100) return false;
  try {
    const db = await import('./db.js');
    const counts = await Promise.all(Object.keys(db.STORES).map((storeName) => db.countRecords(storeName)));
    const cacheTotal = counts.reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
    return cacheTotal < nativeTotal * 0.9;
  } catch (error) {
    console.warn('[native-data] 无法核对缓存记录数，保守执行完整恢复', error);
    return true;
  }
}

async function repairIndexedDbCacheFromJournal(status, generation, fromSequence) {
  const p = plugin();
  if (typeof p?.listJournalPage !== 'function') return null;
  const targetGeneration = Number(generation || 0);
  let sequence = Number(fromSequence || 0);
  if (targetGeneration <= 0 || sequence <= 0) return null;
  const db = await import('./db.js');
  let repaired = 0;
  const skippedRecords = [];
  setNativeMirrorSuppressed(true);
  updateNativeCacheRebuildProgress({
    restored: sequence,
    total: status.lastSequence,
    phase: 'repair-cache',
    reason: `增量修复：网页 ${sequence} / 原生 ${status.lastSequence}`,
  });
  try {
    while (sequence < status.lastSequence) {
      const page = await p.listJournalPage({
        generation: targetGeneration,
        afterSequence: sequence,
        limit: 64,
      });
      const changes = Array.isArray(page?.changes) ? page.changes : [];
      if (!changes.length) throw new Error(`原生变更日志不连续：${sequence} / ${status.lastSequence}`);
      for (const change of changes) {
        const nextSequence = Number(change?.sequence || 0);
        if (nextSequence <= sequence) throw new Error('原生变更日志序号没有前进');
        const storeName = String(change?.storeName || '');
        const operation = String(change?.operation || '');
        if (db.STORES[storeName]) {
          if (operation === 'clear') {
            await db.clearStore(storeName);
          } else if (operation === 'delete') {
            await db.deleteRecord(storeName, decodedNativeRecordKey(change));
          } else if (operation === 'put') {
            if (!change?.fileName) {
              // 同一键在日志后续已经被删除时，旧 put 对应的当前文件不存在；后续
              // delete 会给出最终状态，因此这里无需重读一个已经淘汰的历史版本。
              sequence = nextSequence;
              continue;
            }
            try {
              const record = await readNativeRecordPayload(change);
              await db.putRecord(storeName, record);
            } catch (error) {
              if (!isOptionalNativeCacheRecord(storeName, change)) throw error;
              skippedRecords.push({
                storeName,
                recordKey: String(decodedNativeRecordKey(change) || change?.recordKey || 'unknown'),
                reason: String(error?.message || error || '可选缓存记录无法读取'),
              });
            }
          }
        }
        sequence = nextSequence;
        repaired += 1;
      }
      updateNativeCacheRebuildProgress({
        restored: sequence,
        total: status.lastSequence,
        phase: 'repair-cache',
      });
      await wait(0);
    }
    await writeIndexedDbCacheMeta({
      sequence: status.lastSequence,
      generation: targetGeneration,
      reason: 'journal-repair',
    });
    storageSet(CACHE_SEQUENCE_KEY, status.lastSequence);
    storageRemove(FORCE_REBUILD_KEY);
    storageRemove(CACHE_FAILURE_KEY);
    storageRemove(JOURNAL_REPAIR_FAILURE_KEY);
    globalThis.dispatchEvent?.(new CustomEvent('marshmallow-native-cache-repaired', {
      detail: { repaired, generation: targetGeneration, skippedRecords },
    }));
    return { rebuilt: false, repaired: true, restored: repaired, skippedRecords, status };
  } finally {
    clearNativeCacheRebuildProgress();
    setNativeMirrorSuppressed(false);
  }
}

function rememberJournalRepairFailure(error, status, fromSequence) {
  const detail = {
    detectedAt: Date.now(),
    fromSequence: Number(fromSequence || 0),
    toSequence: Number(status?.lastSequence || 0),
    generation: Number(status?.activeGeneration || 0),
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || '增量缓存修复失败').slice(0, 800),
  };
  storageSet(JOURNAL_REPAIR_FAILURE_KEY, JSON.stringify(detail));
  try {
    globalThis.__mmlog?.(
      'warn',
      `原生缓存增量修复失败（${detail.fromSequence}/${detail.toSequence}）：${detail.message}`,
    );
  } catch (_) {}
  return detail;
}

async function repairIndexedDbCacheFromJournalWithRetry(status, generation, fromSequence) {
  let lastError = null;
  for (const delayMs of JOURNAL_REPAIR_RETRY_DELAYS) {
    if (delayMs > 0) await wait(delayMs);
    try {
      const repaired = await repairIndexedDbCacheFromJournal(status, generation, fromSequence);
      if (repaired) return repaired;
      lastError = new Error('当前原生桥未提供增量缓存修复接口');
    } catch (error) {
      lastError = error;
      console.warn('[native-data] 增量缓存修复重试失败', error);
    }
  }
  throw lastError || new Error('增量缓存修复失败');
}

function scheduleDeferredJournalRepair(fromSequence) {
  if (deferredJournalRepairTimer || deferredJournalRepairRunning) return;
  deferredJournalRepairTimer = globalThis.setTimeout?.(async () => {
    deferredJournalRepairTimer = 0;
    deferredJournalRepairRunning = true;
    try {
      const latest = await getNativeDataStatus({ fresh: true });
      const sequence = Math.max(Number(fromSequence || 0), cachedSequence());
      if (
        latest.enabled
        && sequence > 0
        && sequence < latest.lastSequence
      ) {
        await repairIndexedDbCacheFromJournalWithRetry(
          latest,
          latest.activeGeneration,
          sequence,
        );
      }
    } catch (error) {
      rememberJournalRepairFailure(error, await getNativeDataStatus({ fresh: true }).catch(() => null), fromSequence);
    } finally {
      deferredJournalRepairRunning = false;
    }
  }, 2500) || 0;
}

export async function rebuildIndexedDbCacheIfNeeded(options = {}) {
  const allowFullRebuild = options.allowFullRebuild !== false;
  const status = await getNativeDataStatus({ fresh: true });
  if (!status.enabled || status.recordCount <= 0) return { rebuilt: false, reason: 'empty-native-vault' };
  const cacheMeta = await readIndexedDbCacheMeta();
  const metaSequence = Number(cacheMeta?.sequence || 0);
  const metaGeneration = Number(cacheMeta?.generation || 0);
  const metaCurrent = metaSequence === status.lastSequence
    && (metaGeneration <= 0 || metaGeneration === status.activeGeneration);
  if (
    metaCurrent
    && !recreationNeedsRebuild
  ) {
    // 完成元数据位于 IndexedDB 自身；它与原生代、序号完全一致，说明缓存已经完整。
    // APK 覆盖或系统回收可能恰好发生在“写完成元数据”与“删除旁路标记”之间，
    // 此时旁路标记已经过期，必须由缓存自身证明清理，不能再重复全量恢复。
    storageSet(CACHE_SEQUENCE_KEY, status.lastSequence);
    storageRemove(FORCE_REBUILD_KEY);
    storageRemove(IMPORT_PENDING_KEY);
    storageRemove(CACHE_FAILURE_KEY);
    storageRemove(JOURNAL_REPAIR_FAILURE_KEY);
    storageRemove(CACHE_REBUILD_IN_PROGRESS_KEY);
    return { rebuilt: false, reason: 'cache-meta-current', status };
  }
  const forceFlags = {
    recreation: recreationNeedsRebuild,
    failedWrite: !!storageGet(FORCE_REBUILD_KEY),
    pendingImport: !!storageGet(IMPORT_PENDING_KEY),
    interruptedRebuild: !!storageGet(CACHE_REBUILD_IN_PROGRESS_KEY),
  };
  // IndexedDB 中的缓存元数据采用空闲合并写；进程在这次小写入前退出时，旁路序号
  // 可能比元数据新。旁路序号只会在业务记录成功写入 IndexedDB 后推进，因此取两者
  // 的较大值不会掩盖缓存缺口，反而避免把一次延迟落盘误判成全库失配。
  const sidecarSequence = cachedSequence();
  const localSequence = Math.max(metaSequence, sidecarSequence);
  const generationMatches = metaGeneration <= 0 || metaGeneration === status.activeGeneration;
  const cacheSubstantiallyIncomplete = forceFlags.failedWrite
    ? await indexedDbCacheLooksSubstantiallyIncomplete(status)
    : false;
  let requiresBlockingFullRebuild = forceFlags.recreation
    || forceFlags.pendingImport
    || forceFlags.interruptedRebuild
    || cacheSubstantiallyIncomplete;
  if (
    !forceFlags.recreation
    && !forceFlags.pendingImport
    && !forceFlags.interruptedRebuild
    && !cacheSubstantiallyIncomplete
    && generationMatches
    && localSequence > 0
    && localSequence < status.lastSequence
  ) {
    try {
      const repaired = await repairIndexedDbCacheFromJournalWithRetry(
        status,
        status.activeGeneration,
        localSequence,
      );
      if (repaired) return repaired;
    } catch (error) {
      const failure = rememberJournalRepairFailure(error, status, localSequence);
      const gap = status.lastSequence - localSequence;
      if (!requiresBlockingFullRebuild) {
        requiresBlockingFullRebuild = await indexedDbCacheLooksSubstantiallyIncomplete(status);
      }
      // 极小序号差通常只是退出瞬间最后一笔缓存元数据尚未落盘，或旧 WebView
      // 的一次桥接回调抖动。此时让用户先进入应用并在空闲期重试，不能为了 1 条
      // 记录直接阻塞式扫描、重写数万条。主数据仍安全保存在原生主库。
      if (!requiresBlockingFullRebuild && gap > 0) {
        scheduleDeferredJournalRepair(localSequence);
        return {
          rebuilt: false,
          repairDeferred: true,
          reason: gap <= SMALL_JOURNAL_GAP_LIMIT
            ? 'small-journal-gap-deferred'
            : 'journal-repair-deferred-with-intact-cache',
          gap,
          failure,
          status,
        };
      }
      console.warn('[native-data] 增量缓存修复失败，回落到完整重建', error);
    }
  }
  const force = Object.values(forceFlags).some(Boolean);
  if (!force && cachedSequence() === status.lastSequence) {
    await writeIndexedDbCacheMeta({
      sequence: status.lastSequence,
      generation: status.activeGeneration,
      reason: 'legacy-sequence-migrated',
    });
    return { rebuilt: false, reason: 'cache-current', status };
  }
  const triggerReason = force
    ? `强制标记：${[
        forceFlags.recreation ? '数据库重建' : '',
        forceFlags.failedWrite ? '缓存写入失败' : '',
        forceFlags.pendingImport ? '导入未完成' : '',
        forceFlags.interruptedRebuild ? '上次缓存恢复未完成' : '',
        cacheSubstantiallyIncomplete ? '缓存记录明显不完整' : '',
      ].filter(Boolean).join('、')}；网页 ${metaSequence || localSequence || 0} / 原生 ${status.lastSequence}`
    : `缓存序号不一致：网页 ${metaSequence || localSequence || 0} / 原生 ${status.lastSequence}`;
  if (!allowFullRebuild) {
    // 运行中的页面只允许增量补齐。完整重建会先清空 IndexedDB，既会劫持当前页面，
    // 也可能被一次导航或 WebView 回收打断；保留原生主库和待修复标记，交给下次
    // 冷启动执行可续传的完整恢复。
    return {
      rebuilt: false,
      fullRebuildDeferred: true,
      reason: 'full-rebuild-deferred-until-restart',
      triggerReason,
      status,
    };
  }
  return rebuildIndexedDbCacheFromGeneration(status, status.activeGeneration, { triggerReason });
}

export async function rebuildIndexedDbCacheFromStaging(generation) {
  const status = await getNativeDataStatus({ fresh: true });
  const target = Number(generation || 0);
  if (!status.enabled || target <= 0 || status.stagingGeneration !== target) {
    throw new Error('上次搬家暂存数据已不存在，需重新导入');
  }
  return rebuildIndexedDbCacheFromGeneration(status, target, { completeRecovery: false });
}

export const NATIVE_DATA_STORE_APP_ID = ENABLED_APP_ID;
