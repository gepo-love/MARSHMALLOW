// 大体积完整备份的流式导入：按块读文件、逐条解析 JSON 数组，避免整文件 readAsText + JSON.parse 导致 Android WebView OOM 闪退。
// 备份格式见 backup.js（format: marshmallow-phone-backup，数据在 stores 对象内）。

import * as db from './db.js';
import { mergeCharacterAssetRow } from './backup-character-assets.js';
import {
  mergeUserAssetRow,
  mergeChatAssetRow,
} from './backup-extra-assets.js';
import {
  mergeMusicAssetRow,
  mergeSoundAssetRow,
} from './backup-music-assets.js';
import { reviveBackupBlobValues } from './backup-json-stream.js';
import {
  abortNativeReplaceImport,
  isNativeDataStoreEnabled,
  rebuildIndexedDbCacheIfNeeded,
  rebuildIndexedDbCacheFromStaging,
  resumeNativeReplaceImport,
} from './native-data-store.js';

const BACKUP_FORMAT = 'marshmallow-phone-backup';
const BACKUP_ASSET_FORMAT = 'marshmallow-phone-backup-assets';
const MIGRATION_PACKAGE_FORMAT = 'marshmallow-machine-migration';
export const STREAM_IMPORT_THRESHOLD_BYTES = 24 * 1024 * 1024;
/** 网页端超过此体积才走字符流式解析；170MB 级应直接 JSON.parse，避免十分钟级假死。 */
/** 网页端超过该体积走流式导入；过低会增加小备份开销，过高则大备份整文件读入时像“没反应”。 */
export const WEB_STREAM_IMPORT_THRESHOLD_BYTES = 48 * 1024 * 1024;
const MIGRATION_PROBE_BYTES = 96 * 1024;
const DEFAULT_BATCH_SIZE = 120;
const WEB_STORE_BATCH = {
  settings: 32,
  messages: 24,
  memories: 48,
  memoryFacts: 64,
  eventMemories: 40,
  momentsPosts: 40,
  weiboPosts: 40,
  collectibles: 48,
  streamerRecordings: 32,
};
/** 单条 JSON 超过此大小（常见于 messages 里的 base64 图片）必须立刻写入，不能攒批。 */
const LARGE_RECORD_RAW_BYTES = 96 * 1024;
const FILE_CHUNK_BYTES = 512 * 1024;
// 移动端不要直接采用 Blob.stream() 交给我们的任意块大小。部分 WebKit / WebView
// 会一次交付数 MB，解码后的 UTF-16 字符串与底层 Uint8Array 同时存活，搬家包在
// 核心数据段约 30% 处就可能把渲染进程顶掉。固定 slice 上限让峰值可预测。
const FILE_CHUNK_BYTES_NATIVE = 128 * 1024;
const READER_COOPERATIVE_YIELD_BYTES = 512 * 1024;
const NATIVE_YIELD_MS = 14;
const NATIVE_HEAVY_YIELD_EVERY = 24;
const MIGRATION_LEASE_TIMEOUT_MS = 10 * 60 * 1000;
const MIGRATION_LEASE_RENEW_MS = 7 * 60 * 1000;

const HEAVY_STORE_BATCH = {
  settings: 2,
  // 超过 96KB 的媒体记录仍会立即单独冲刷；普通文本消息可以安全合批，
  // 显著减少十万级聊天搬家时的原生桥调用和 IndexedDB 事务数量。
  messages: 32,
  memories: 12,
  memoryFacts: 16,
  eventMemories: 12,
  momentsPosts: 8,
  weiboPosts: 8,
  collectibles: 12,
  streamerRecordings: 8,
  // 兼容旧完整备份中的 stores.beautifyAssets；单项可能内嵌多张 Base64。
  beautifyAssets: 1,
};

/** settings 里可重建的缓存 / 日志 / 历史标记，导入跳过、导出也不打包。 */
const SETTINGS_SKIP_EXACT = new Set([
  'voiceAudioCacheIndex',
  'debugLogEvents',
  'searchCallLog',
  'mcpCredentials',
  'meituanCredentials',
  'capabilityGrants',
  'shoppingCheckoutLinksV1',
  'shoppingPendingSharesV1',
  // 音效轻量目录可由 soundAssets 重建，不能让旧备份覆盖成过期索引。
  'soundAssetCatalogV1',
]);
const SETTINGS_SKIP_PREFIXES = [
  'voiceAudioCache_',
  'userRelationDeltaApplied_',
  'userRelationCustomApplied_',
  'userRelationDeltaLog_',
  'aiDebugSnapshot_',
  '__mm_ai_round_artifacts_v1__:',
  'mcpCapabilityContinuation_v1:',
  // 安装实例内的可恢复执行账本，不是角色/会话内容。跨设备复制会把旧的
  // wall wake、lease 与取消代次带到新安装，因此所有内容/云/安全备份都必须排除。
  'lifeTaskRuntime:v1:',
];

function uniqueKnownStoreNames(names = []) {
  return [...new Set(
    (Array.isArray(names) ? names : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean),
  )];
}

/** 旧备份未声明的新数据表必须保留；只有显式出现的表才参与 replace。 */
export function buildReplaceStorePlan(presentStoreNames = [], knownStoreNames = []) {
  const known = uniqueKnownStoreNames(knownStoreNames);
  const present = new Set(uniqueKnownStoreNames(presentStoreNames));
  return {
    replace: known.filter((name) => present.has(name)),
    preserve: known.filter((name) => !present.has(name)),
  };
}
// 与下方 STREAM_IMPORT_KEEP_DATA_URL_MAX_CHARS 保持一致的量级：只裁掉真正超大的内嵌字符串，
// 压缩后的正常照片（几十~几百 KB，聊天图上限约 1.2MB）不应在导出这一步就被静默清空。
const SETTINGS_LARGE_STRING_BYTES = 1_700_000;
const SETTINGS_MAX_RAW_BYTES = 14 * 1024 * 1024;
const RAW_JSON_CHUNK_CHARS = 16384;
// 美化组件可能把多张 Base64 图片直接嵌进 CSS / HTML。即使文件本身按 128KB
// 流式读取，若仍为单条记录组装几十 MB 字符串，移动端渲染进程依旧会被杀。
// 普通图片字段会由 STREAM_IMPORT_KEEP_DATA_URL_MAX_CHARS 单独处理；这里拦的是
// 无法安全逐字段恢复的异常巨型组件记录。
const CONSTRAINED_BEAUTIFY_RAW_MAX_CHARS = 2 * 1024 * 1024;
// iOS / Android 的 IndexedDB 实现可能在连续写入大量中型 Base64 时长期保留内部
// 序列化缓冲。单条都不超限仍可能在几百项后被系统杀进程，因此给可选美化资源
// 再设一个整段预算；主数据和后续资源继续恢复，缺少的美化图可日后单独补导。
const CONSTRAINED_BEAUTIFY_TOTAL_MAX_CHARS = 64 * 1024 * 1024;
const CONSTRAINED_BEAUTIFY_SUPPLEMENT_MAX_CHARS = 24 * 1024 * 1024;
const IOS_BEAUTIFY_SUPPLEMENT_MAX_CHARS = 8 * 1024 * 1024;
const MAX_SKIPPED_ASSET_DETAILS = 80;

class ChunkedStringBuilder {
  constructor(maxChars = 0) {
    this.parts = [];
    this.buffer = '';
    this.length = 0;
    this.maxChars = Math.max(0, Number(maxChars) || 0);
    this.overflowed = false;
  }

  append(value) {
    let text = String(value ?? '');
    if (this.maxChars > 0) {
      const remaining = this.maxChars - this.length;
      if (remaining <= 0) {
        if (text) this.overflowed = true;
        return;
      }
      if (text.length > remaining) {
        text = text.slice(0, remaining);
        this.overflowed = true;
      }
    }
    this.length += text.length;
    this.buffer += text;
    if (this.buffer.length >= RAW_JSON_CHUNK_CHARS) {
      this.parts.push(this.buffer);
      this.buffer = '';
    }
  }

  toString() {
    if (this.buffer) {
      this.parts.push(this.buffer);
      this.buffer = '';
    }
    if (!this.parts.length) return '';
    return this.parts.length === 1 ? this.parts[0] : this.parts.join('');
  }
}

function shrinkLargeJsonStrings(raw) {
  // 流式读取阶段已跳过 data:image/audio/video 巨型字符串；这里不再用复杂正则，避免 Maximum call stack size exceeded。
  return raw;
}

function peekSettingsKeyFromRaw(raw) {
  const m = String(raw || '').match(/"key"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch (_) {
    return m[1];
  }
}

export function isAssetSettingsKey(key) {
  const k = String(key || '');
  if (k === 'appearancePrefs' || k === 'voiceAudioCacheIndex') return true;
  if (k.startsWith('voiceAudioCache_') || k.startsWith('radioAudioBlob_') || k.startsWith('characterPhone_')) return true;
  if (k.startsWith('companionSettings_')) return true;
  return false;
}

export function shouldSkipBackupSettingsKey(key) {
  const k = String(key || '');
  if (!k) return true;
  if (isAssetSettingsKey(k)) return true;
  if (SETTINGS_SKIP_EXACT.has(k)) return true;
  return SETTINGS_SKIP_PREFIXES.some((prefix) => k.startsWith(prefix));
}

function parseStoreRowFromRaw(storeName, raw) {
  if (storeName === 'settings') {
    const settingsKey = peekSettingsKeyFromRaw(raw);
    if (shouldSkipBackupSettingsKey(settingsKey)) {
      return { row: null, skipped: true, settingsKey, skippedKnown: true };
    }
    if (raw.length > SETTINGS_MAX_RAW_BYTES) {
      return { row: null, skipped: true, settingsKey, skippedOversized: true };
    }
    try {
      const parsed = JSON.parse(raw);
      return { row: normalizeBackupSettingsRow(parsed), skipped: false };
    } catch (err) {
      return { row: null, skipped: true, settingsKey, error: err?.message || String(err) };
    }
  }
  let prepared = raw;
  if (raw.length >= LARGE_RECORD_RAW_BYTES) {
    prepared = shrinkLargeJsonStrings(raw);
  }
  try {
    const parsed = JSON.parse(prepared);
    return { row: normalizeBackupStoreRow(storeName, parsed), skipped: false };
  } catch (err) {
    throw new Error(`${storeName} 记录解析失败：${err?.message || err}`);
  }
}

export function shouldSkipBackupSettingsRow(row, options = {}) {
  if (options.assetImport) return false;
  return shouldSkipBackupSettingsKey(row?.key);
}

export function normalizeBackupSettingsRow(row, { forExport = false, assetImport = false } = {}) {
  if (!row || typeof row !== 'object') return null;
  const key = String(row.key || '').trim();
  if (!key) return null;

  if (assetImport) {
    if (!isAssetSettingsKey(key)) return null;
    return { key, value: reviveBackupBlobValues(row.value) };
  }

  if (shouldSkipBackupSettingsRow(row)) return null;
  let value = row.value;
  if (forExport) {
    value = stripLargeEmbeddedStrings(value);
    return { key, value };
  }
  if (key === 'appearancePrefs' || key.startsWith('characterPhone_')) {
    value = stripLargeEmbeddedStrings(value);
  }
  return { key, value: reviveBackupBlobValues(value) };
}

function stripStringField(value, limit = SETTINGS_LARGE_STRING_BYTES) {
  if (value.length <= limit) return value;
  if (/^data:(image|audio|video)\//i.test(value) || /^blob:/i.test(value)) return '';
  return value.slice(0, limit);
}

function stripLargeEmbeddedStrings(value, limit = SETTINGS_LARGE_STRING_BYTES) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? stripStringField(value, limit) : value;
  }
  const stack = [{ src: value, out: Array.isArray(value) ? [] : {} }];
  const root = stack[0].out;
  while (stack.length) {
    const { src, out } = stack.pop();
    if (Array.isArray(src)) {
      for (let i = 0; i < src.length; i += 1) {
        const item = src[i];
        if (item !== null && typeof item === 'object') {
          const child = Array.isArray(item) ? [] : {};
          out[i] = child;
          stack.push({ src: item, out: child });
        } else {
          out[i] = typeof item === 'string' ? stripStringField(item, limit) : item;
        }
      }
      continue;
    }
    for (const [k, v] of Object.entries(src)) {
      if (v !== null && typeof v === 'object') {
        const child = Array.isArray(v) ? [] : {};
        out[k] = child;
        stack.push({ src: v, out: child });
      } else {
        out[k] = typeof v === 'string' ? stripStringField(v, limit) : v;
      }
    }
  }
  return root;
}

export function normalizeBackupStoreRow(storeName, row, options = {}) {
  if (!row || typeof row !== 'object') return null;
  if (storeName === 'settings') return normalizeBackupSettingsRow(row, options);
  const revived = reviveBackupBlobValues(row);
  if (storeName === 'messages'
    && revived?.type === 'image'
    && /^data:image\//i.test(String(revived.content || ''))
    && String(revived.content || '') === String(revived.metadata?.url || '')) {
    return {
      ...revived,
      metadata: { ...(revived.metadata || {}), url: '' },
    };
  }
  return revived;
}

export function emitBackupImportProgress(detail) {
  try {
    globalThis.dispatchEvent(new CustomEvent('marshmallow-backup-import-progress', { detail }));
  } catch (_) {}
}

function isNativeShell() {
  return typeof window !== 'undefined'
    && typeof window.Capacitor?.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform();
}

async function acquireMigrationImportLease() {
  if (!isNativeShell()) return { release() {} };
  const keepAlive = globalThis.Capacitor?.Plugins?.MarshmallowKeepAlive;
  if (typeof keepAlive?.acquireTemporaryLease !== 'function') return { release() {} };
  const leaseId = `migration-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const renew = () => keepAlive.acquireTemporaryLease({
    leaseId,
    timeoutMs: MIGRATION_LEASE_TIMEOUT_MS,
    title: '正在搬入本地数据',
    body: '请保持应用开启，完成前不要清理后台。',
  }).catch(() => null);
  await renew();
  const timer = globalThis.setInterval?.(renew, MIGRATION_LEASE_RENEW_MS) || 0;
  return {
    release() {
      if (timer) globalThis.clearInterval?.(timer);
      keepAlive.completeBackgroundWake?.({ leaseId }).catch(() => {});
    },
  };
}
export function isIOSWebKitRuntime() {
  if (typeof navigator === 'undefined') return false;
  const ua = String(navigator.userAgent || '');
  const platform = String(navigator.platform || '');
  return /iPad|iPhone|iPod/i.test(ua)
    || (platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1);
}

function isAndroidWebRuntime() {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(String(navigator.userAgent || ''));
}

function isConstrainedImportRuntime() {
  // Edge / Chrome 普通网页同样运行在移动端渲染进程里，并不会因为没有 Capacitor
  // 外壳就拥有桌面级内存。截图中的 Edge 崩溃正是此前漏掉这条分支。
  return isNativeShell() || isIOSWebKitRuntime() || isAndroidWebRuntime();
}

function yieldToMainThread(extraMs = 0) {
  if (!isConstrainedImportRuntime()) return Promise.resolve();
  const delay = NATIVE_YIELD_MS + Math.max(0, Number(extraMs) || 0);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function batchSizeForStore(storeName) {
  if (isConstrainedImportRuntime()) {
    if (HEAVY_STORE_BATCH[storeName] != null) return HEAVY_STORE_BATCH[storeName];
    return 40;
  }
  if (WEB_STORE_BATCH[storeName] != null) return WEB_STORE_BATCH[storeName];
  return DEFAULT_BATCH_SIZE;
}

export function importBatchSizeForStore(storeName) {
  return batchSizeForStore(storeName);
}

/**
 * 统一的分块文本读取器：优先 file.stream()；Android WebView 若无 stream 则 file.slice 分段读。
 */
export function shouldReadBackupFileAsStream(file, constrainedRuntime = isConstrainedImportRuntime()) {
  if (typeof file?.stream !== 'function') return false;
  // 普通 File/Blob 在移动端仍用固定大小的 slice，避免 WebView 一次交付过大块。
  // 原生安全备份是只有 stream() 的分块数据源，不能在 Android 上强制调用 slice()。
  return !constrainedRuntime || typeof file?.slice !== 'function';
}

class ChunkedFileTextReader {
  constructor(file) {
    this.file = file;
    this.constrainedRuntime = isConstrainedImportRuntime();
    this.useStream = shouldReadBackupFileAsStream(file, this.constrainedRuntime);
    this.decoder = new TextDecoder('utf-8');
    this.buffer = '';
    this.offset = 0;
    this.bytesRead = 0;
    this.nextCooperativeYieldAt = READER_COOPERATIVE_YIELD_BYTES;
    this.done = false;
    this.chunkBytes = isConstrainedImportRuntime() ? FILE_CHUNK_BYTES_NATIVE : FILE_CHUNK_BYTES;
    if (this.useStream) {
      this.streamReader = file.stream().getReader();
      this.slicePos = 0;
    } else {
      this.slicePos = 0;
    }
  }

  async fill() {
    while (!this.done && this.offset >= this.buffer.length) {
      if (this.offset > 0) {
        this.buffer = this.buffer.slice(this.offset);
        this.offset = 0;
      }
      if (this.useStream) {
        const chunk = await this.streamReader.read();
        if (chunk.done) {
          const tail = this.decoder.decode();
          if (tail) this.buffer += tail;
          this.done = true;
          break;
        }
        this.bytesRead += chunk.value?.byteLength || 0;
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
      } else {
        if (this.slicePos >= this.file.size) {
          this.done = true;
          break;
        }
        const end = Math.min(this.slicePos + this.chunkBytes, this.file.size);
        const slice = this.file.slice(this.slicePos, end);
        const ab = await slice.arrayBuffer();
        this.slicePos = end;
        this.bytesRead += ab.byteLength;
        this.buffer += this.decoder.decode(ab, { stream: end < this.file.size });
      }
      // await 一个已经完成的 Promise 只会切到微任务队列，连续扫描大 JSON 时页面仍
      // 得不到渲染机会。每读约 512KB 主动交还一次事件循环，避免系统把页面判为卡死。
      if (this.constrainedRuntime && this.bytesRead >= this.nextCooperativeYieldAt) {
        this.nextCooperativeYieldAt = this.bytesRead + READER_COOPERATIVE_YIELD_BYTES;
        await yieldToMainThread();
      }
    }
    return this.offset < this.buffer.length;
  }

  async peek() {
    const ok = await this.fill();
    return ok ? this.buffer[this.offset] : '';
  }

  takeCharSync() {
    if (this.offset < this.buffer.length) return this.buffer[this.offset++];
    return null;
  }

  async takeChar() {
    const sync = this.takeCharSync();
    if (sync !== null) return sync;
    const ok = await this.fill();
    if (!ok) return '';
    return this.buffer[this.offset++];
  }

  async next() {
    return this.takeChar();
  }

  async startsWithAtCursor(text) {
    await this.fill();
    return this.buffer.startsWith(text, this.offset);
  }
}

async function isLargeDataUrlStringAhead(reader) {
  return (await reader.startsWithAtCursor('data:image/'))
    || (await reader.startsWithAtCursor('data:audio/'))
    || (await reader.startsWithAtCursor('data:video/'));
}

// 之前这里只要看到 data:image/audio/video 开头就整段丢弃，不管字符串实际大小——
// 结果是聊天图片、朋友圈配图、角色头像等正常尺寸的照片在安卓端导入完整备份时全部被清空。
// 现在改成只有真的超大（远超普通压缩后照片体积）的媒体字符串才丢，正常图片原样保留。
// 聊天图片压缩目标是 900KB 原始字节，base64 后 ≈1.2MB 字符；这里留出余量，
// 确保压缩后的正常聊天图/朋友圈图/头像都能整段保留，只丢真正异常超大的历史图。
const STREAM_IMPORT_KEEP_DATA_URL_MAX_CHARS = 1_700_000; // 约 1.24MB 解码后

/** 读一段已确认以 data:image|audio|video 开头的带引号字符串：不超限原样保留，超限才丢弃换成 ""。 */
async function readCappedDataUrlString(reader, maxKeepChars = STREAM_IMPORT_KEEP_DATA_URL_MAX_CHARS) {
  const builder = new ChunkedStringBuilder();
  builder.append('"');
  let length = 1;
  let overflowed = false;
  let escaped = false;
  while (true) {
    let ch = reader.takeCharSync();
    if (ch === null) ch = await reader.takeChar();
    if (!ch) throw new Error('备份 JSON 字符串未结束');
    if (!overflowed) {
      builder.append(ch);
      length += 1;
      if (length > maxKeepChars) overflowed = true;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') break;
  }
  return { raw: overflowed ? '""' : builder.toString(), overflowed };
}

async function skipJsonWhitespace(reader) {
  while (true) {
    let ch = reader.takeCharSync();
    if (ch === null) {
      const ok = await reader.fill();
      if (!ok) return;
      ch = reader.takeCharSync();
      if (ch === null) return;
    }
    if (!/\s/.test(ch)) {
      reader.offset -= 1;
      return;
    }
  }
}

async function expectJsonChar(reader, expected) {
  await skipJsonWhitespace(reader);
  const ch = await reader.takeChar();
  if (ch !== expected) throw new Error(`备份 JSON 结构异常：期待 ${expected}，实际 ${ch || '文件结尾'}`);
}

async function readJsonString(reader) {
  await skipJsonWhitespace(reader);
  const first = await reader.takeChar();
  if (first !== '"') throw new Error('备份 JSON 结构异常：期待字符串键');
  const parts = ['"'];
  while (true) {
    const ch = await reader.takeChar();
    if (!ch) throw new Error('备份 JSON 字符串未结束');
    parts.push(ch);
    if (ch === '\\') {
      const escaped = await reader.takeChar();
      if (!escaped) throw new Error('备份 JSON 转义字符未结束');
      parts.push(escaped);
      continue;
    }
    if (ch === '"') break;
  }
  return JSON.parse(parts.join(''));
}

async function readRawJsonValueMeta(reader, options = {}) {
  await skipJsonWhitespace(reader);
  const first = await reader.takeChar();
  if (!first) throw new Error('备份 JSON 结构异常：值为空');
  const builder = new ChunkedStringBuilder(options.maxChars);
  let mediaOverflowed = false;
  builder.append(first);
  if (first === '"') {
    while (true) {
      let ch = reader.takeCharSync();
      if (ch === null) ch = await reader.takeChar();
      if (!ch) throw new Error('备份 JSON 字符串未结束');
      builder.append(ch);
      if (ch === '\\') {
        let escaped = reader.takeCharSync();
        if (escaped === null) escaped = await reader.takeChar();
        if (!escaped) throw new Error('备份 JSON 转义字符未结束');
        builder.append(escaped);
        continue;
      }
      if (ch === '"') break;
    }
    return { raw: builder.toString(), overflowed: builder.overflowed, mediaOverflowed };
  }
  if (first === '{' || first === '[') {
    let depth = 1;
    let inString = false;
    let escaped = false;
    while (depth > 0) {
      let ch = reader.takeCharSync();
      if (ch === null) ch = await reader.takeChar();
      if (!ch) throw new Error('备份 JSON 对象或数组未结束');
      if (!inString && ch === '"') {
        if (await isLargeDataUrlStringAhead(reader)) {
          const capped = await readCappedDataUrlString(reader);
          builder.append(capped.raw);
          mediaOverflowed = mediaOverflowed || capped.overflowed;
          continue;
        }
        inString = true;
        builder.append(ch);
        continue;
      }
      builder.append(ch);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '[') depth += 1;
      else if (ch === ']') depth -= 1;
    }
    return { raw: builder.toString(), overflowed: builder.overflowed, mediaOverflowed };
  }
  while (true) {
    const ch = await reader.peek();
    if (!ch || ch === ',' || ch === '}' || ch === ']' || /\s/.test(ch)) break;
    builder.append(await reader.takeChar());
  }
  return { raw: builder.toString().trim(), overflowed: builder.overflowed, mediaOverflowed };
}

async function readRawJsonValue(reader) {
  return (await readRawJsonValueMeta(reader)).raw;
}

async function skipJsonValue(reader) {
  await skipJsonWhitespace(reader);
  const first = await reader.peek();
  if (!first) return;

  if (first === '"') {
    await reader.takeChar();
    let escaped = false;
    while (true) {
      let ch = reader.takeCharSync();
      if (ch === null) ch = await reader.takeChar();
      if (!ch) throw new Error('备份 JSON 字符串未结束');
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') break;
    }
    return;
  }

  if (first === '{' || first === '[') {
    let depth = 1;
    let inString = false;
    let escaped = false;
    await reader.takeChar();
    while (depth > 0) {
      let ch = reader.takeCharSync();
      if (ch === null) ch = await reader.takeChar();
      if (!ch) throw new Error('备份 JSON 对象或数组未结束');
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') depth -= 1;
    }
    return;
  }

  while (true) {
    const ch = await reader.peek();
    if (!ch || ch === ',' || ch === '}' || ch === ']' || /\s/.test(ch)) break;
    await reader.takeChar();
  }
}
async function flushStoreBatch(storeName, batch, state, reader, progressExtra = {}) {
  if (!batch.length) return;
  const count = batch.length;
  if (!state.validateOnly) {
    if (count === 1) {
      await db.putRecord(storeName, batch[0]);
    } else {
      const writeBatchSize = Math.min(count, batchSizeForStore(storeName));
      await db.putMany(storeName, batch, { batchSize: writeBatchSize });
    }
  }
  state.rowCounts[storeName] += count;
  batch.length = 0;
  emitBackupImportProgress({
    phase: state.validateOnly ? 'preflight-store' : 'store',
    storeName,
    rows: state.rowCounts[storeName],
    bytesRead: reader.bytesRead,
    totalBytes: reader.file.size,
    ...progressExtra,
  });
  await yieldToMainThread();
}

async function parseStoreArray(reader, storeName, state) {
  if (state.importedStores.has(storeName)) {
    await skipJsonValue(reader);
    return;
  }
  state.importedStores.add(storeName);
  state.rowCounts[storeName] = 0;
  const batchLimit = batchSizeForStore(storeName);
  await expectJsonChar(reader, '[');
  const batch = [];
  await skipJsonWhitespace(reader);
  if ((await reader.peek()) === ']') {
    await reader.takeChar();
    if (state.mode === 'replace') state.emptyStores.add(storeName);
    return;
  }
  let rowIndex = 0;
  let storeCleared = false;
  const constrainedBeautify = storeName === 'beautifyAssets' && isConstrainedImportRuntime();
  let beautifyRestoredRows = 0;
  if (constrainedBeautify && !state.validateOnly && state.mode === 'replace') {
    // 旧完整备份把美化素材放在 stores 中。即使 iOS 为保护主数据而跳过
    // 整段资源，也要落实 replace 语义，不能让本机旧素材混进恢复结果。
    await db.clearStore(storeName);
    state.clearedStores.add(storeName);
    storeCleared = true;
    await yieldToMainThread();
  }
  while (true) {
    if (state.validateOnly) {
      // 搬家预检只需要确认 JSON 边界并核对清单条数。旧实现仍为每条记录组装完整
      // 字符串再 JSON.parse，导致网页端在真正写入前先承受一遍完整内存峰值。
      await skipJsonValue(reader);
      rowIndex += 1;
      state.rowCounts[storeName] = rowIndex;
      if (rowIndex % batchLimit === 0) {
        emitBackupImportProgress({
          phase: 'preflight-store',
          storeName,
          rows: rowIndex,
          bytesRead: reader.bytesRead,
          totalBytes: reader.file.size,
        });
        await yieldToMainThread();
      }
      await skipJsonWhitespace(reader);
      const sep = await reader.takeChar();
      if (sep === ',') continue;
      if (sep === ']') break;
      throw new Error(`备份 JSON 结构异常：${storeName} 表数组分隔符错误`);
    }
    if (constrainedBeautify && rowIndex < Number(state.beautifyStartIndex || 0)) {
      await skipJsonValue(reader);
      rowIndex += 1;
      await skipJsonWhitespace(reader);
      const sep = await reader.takeChar();
      if (sep === ',') continue;
      if (sep === ']') break;
      throw new Error(`备份 JSON 结构异常：${storeName} 表数组分隔符错误`);
    }
    const configuredBeautifyBudget = Number(state.beautifyBudgetChars);
    const beautifyBudget = Number.isFinite(configuredBeautifyBudget)
      ? Math.max(0, configuredBeautifyBudget)
      : CONSTRAINED_BEAUTIFY_TOTAL_MAX_CHARS;
    if (constrainedBeautify
      && Number(state.beautifyProcessedChars || 0) >= beautifyBudget) {
      if (state.beautifyResumeIndex == null) state.beautifyResumeIndex = rowIndex;
      await skipJsonValue(reader);
      rowIndex += 1;
      state.beautifySkippedRows = Number(state.beautifySkippedRows || 0) + 1;
      if (!state.beautifyRecoverySkipNoted) {
        state.beautifyRecoverySkipNoted = true;
        recordSkippedAsset(
          state,
          'beautifyAssets',
          '其余美化资源',
          beautifyBudget === 0
            ? 'iOS 已优先恢复主数据，美化资源可在备份与迁移页分批补导'
            : '移动端美化资源已达到本轮安全恢复上限，其余项目可分批补导',
        );
      }
      if (rowIndex % 12 === 0) await yieldToMainThread();
      await skipJsonWhitespace(reader);
      const sep = await reader.takeChar();
      if (sep === ',') continue;
      if (sep === ']') break;
      throw new Error(`备份 JSON 结构异常：${storeName} 表数组分隔符错误`);
    }
    const rawResult = constrainedBeautify
      ? await readRawJsonValueMeta(reader, { maxChars: CONSTRAINED_BEAUTIFY_RAW_MAX_CHARS })
      : { raw: await readRawJsonValue(reader), overflowed: false, mediaOverflowed: false };
    const raw = rawResult.raw;
    if (constrainedBeautify) {
      state.beautifyProcessedChars = Number(state.beautifyProcessedChars || 0) + raw.length;
    }
    rowIndex += 1;
    let beautifySkipped = null;
    if (constrainedBeautify && rawResult.overflowed) {
      beautifySkipped = { id: `第 ${rowIndex} 项`, reason: '单项美化资源过大，移动端已跳过以避免导入闪退' };
    } else if (constrainedBeautify && rawResult.mediaOverflowed) {
      beautifySkipped = { id: `第 ${rowIndex} 项`, reason: '单张美化图片超过移动端安全恢复上限，已跳过' };
    }
    const parsed = beautifySkipped
      ? { row: null, skipped: true }
      : parseStoreRowFromRaw(storeName, raw);
    let row = parsed.row;
    if (parsed.skipped && storeName === 'settings') {
      state.settingsSkipped = (state.settingsSkipped || 0) + 1;
      if (parsed.skippedKnown) {
        state.settingsKnownSkipped = (state.settingsKnownSkipped || 0) + 1;
      } else if (parsed.skippedOversized) {
        state.settingsOversizedSkipped = (state.settingsOversizedSkipped || 0) + 1;
        if (!Array.isArray(state.settingsOversizedKeys)) state.settingsOversizedKeys = [];
        state.settingsOversizedKeys.push(parsed.settingsKey || '未知设置项');
      }
      emitBackupImportProgress({
        phase: state.validateOnly ? 'preflight-store' : 'store',
        storeName,
        rows: state.rowCounts[storeName] || 0,
        bytesRead: reader.bytesRead,
        totalBytes: reader.file.size,
        settingsKey: parsed.settingsKey || peekSettingsKeyFromRaw(raw),
        skipped: true,
      });
      if (isConstrainedImportRuntime()) await yieldToMainThread(16);
    } else if (beautifySkipped) {
      recordSkippedAsset(state, 'beautifyAssets', beautifySkipped.id, beautifySkipped.reason);
    } else if (row && typeof row === 'object') {
      if (!state.validateOnly && state.mode === 'replace' && !storeCleared) {
        await db.clearStore(storeName);
        state.clearedStores.add(storeName);
        storeCleared = true;
        await yieldToMainThread();
      }
      batch.push(row);
      if (constrainedBeautify) beautifyRestoredRows += 1;
    } else if (storeName !== 'settings') {
      throw new Error(`${storeName} 第 ${state.rowCounts[storeName] + batch.length + 1} 条记录无效`);
    }
    const largeRecord = raw.length >= LARGE_RECORD_RAW_BYTES;
    if (batch.length >= batchLimit || largeRecord) {
      const progressExtra = (storeName === 'settings' && row?.key)
        ? { settingsKey: String(row.key) }
        : {};
      await flushStoreBatch(storeName, batch, state, reader, progressExtra);
    }
    if (isConstrainedImportRuntime() && (storeName === 'settings' || storeName === 'messages') && rowIndex % NATIVE_HEAVY_YIELD_EVERY === 0) {
      await yieldToMainThread(storeName === 'settings' ? 48 : 24);
    }
    await skipJsonWhitespace(reader);
    const sep = await reader.takeChar();
    if (sep === ',') continue;
    if (sep === ']') break;
    throw new Error(`备份 JSON 结构异常：${storeName} 表数组分隔符错误`);
  }
  await flushStoreBatch(storeName, batch, state, reader);
  if (constrainedBeautify) {
    state.assetCounts.beautifyAssets = rowIndex;
    state.restoredAssetCounts.beautifyAssets = beautifyRestoredRows;
  }
  if (!state.validateOnly) await db.checkpointNativeReplaceImport();
  emitBackupImportProgress({
    phase: state.validateOnly ? 'preflight-store-complete' : 'store-complete',
    storeName,
    rows: state.rowCounts[storeName] || 0,
    bytesRead: reader.bytesRead,
    totalBytes: reader.file.size,
  });
}

/**
 * 搬家清单记录的是包内数组条数。导入器主动过滤的缓存项，以及为避免移动端
 * OOM 而跳过的超大单条设置，仍然是结构完整、已被扫描到的清单记录；不能拿
 * “实际写入条数”误判整个搬家包损坏。解析失败的设置不计入，仍会阻止导入。
 */
export function migrationManifestScannedStoreCount(storeName, state = {}) {
  const written = Number(state?.rowCounts?.[storeName] || 0);
  if (storeName !== 'settings') return written;
  return written
    + Number(state.settingsKnownSkipped || 0)
    + Number(state.settingsOversizedSkipped || 0);
}

const MIGRATION_ASSET_TARGETS = Object.freeze({
  rows: { storeName: 'settings' },
  characterAssets: { storeName: 'characters', merge: mergeCharacterAssetRow },
  userAssets: { storeName: 'users', merge: mergeUserAssetRow },
  chatAssets: { storeName: 'chats', merge: mergeChatAssetRow },
  beautifyAssets: { storeName: 'beautifyAssets', direct: true },
  musicAssets: { storeName: 'musicTracks', merge: mergeMusicAssetRow },
  soundAssets: { storeName: 'soundAssets', merge: mergeSoundAssetRow },
});

function recordSkippedAsset(state, assetName, id, reason) {
  if (state.skippedAssets.length < MAX_SKIPPED_ASSET_DETAILS) {
    state.skippedAssets.push({ assetName, id, reason });
    return;
  }
  if (state.skippedAssetOverflowNoted) return;
  state.skippedAssetOverflowNoted = true;
  state.skippedAssets.push({
    assetName: 'resource',
    id: '其它未恢复资源',
    reason: '未恢复项较多，已合并显示',
  });
}

async function parseMigrationAssetArray(reader, assetName, state) {
  const target = MIGRATION_ASSET_TARGETS[assetName];
  if (!target) {
    await skipJsonValue(reader);
    return;
  }
  if (state.completedAssets?.has(assetName)) {
    await skipJsonValue(reader);
    return;
  }
  state.assetCounts[assetName] = 0;
  state.restoredAssetCounts[assetName] = 0;
  await expectJsonChar(reader, '[');
  await skipJsonWhitespace(reader);
  if ((await reader.peek()) === ']') {
    await reader.takeChar();
    return;
  }
  if (!state.validateOnly
    && target.direct
    && state.mode === 'replace'
    && !state.clearedStores.has(target.storeName)) {
    // 新搬家包把美化素材从核心数据段迁到资源段。即使第一项因体积异常需要
    // 跳过，也必须先落实 replace 语义，不能混入本机旧素材冒充恢复成功。
    await db.clearStore(target.storeName);
    state.clearedStores.add(target.storeName);
    state.emptyStores.delete(target.storeName);
    await yieldToMainThread();
  }
  let rowIndex = 0;
  while (true) {
    if (state.validateOnly) {
      // 资源预检同样只计数。尤其本地音乐的 base64 单条可达数十 MB，预检阶段
      // 不应创建完整 raw 字符串和 patch 对象。
      await skipJsonValue(reader);
      rowIndex += 1;
      state.assetCounts[assetName] = rowIndex;
      state.restoredAssetCounts[assetName] = rowIndex;
      emitBackupImportProgress({
        phase: 'preflight-store',
        storeName: `assets/${assetName}`,
        rows: rowIndex,
        bytesRead: reader.bytesRead,
        totalBytes: reader.file.size,
      });
      await yieldToMainThread();
      await skipJsonWhitespace(reader);
      const sep = await reader.takeChar();
      if (sep === ',') continue;
      if (sep === ']') break;
      throw new Error(`搬家包资源 ${assetName} 数组分隔符错误`);
    }
    if (assetName === 'beautifyAssets' && rowIndex < Number(state.beautifyStartIndex || 0)) {
      await skipJsonValue(reader);
      rowIndex += 1;
      state.assetCounts[assetName] += 1;
      await skipJsonWhitespace(reader);
      const sep = await reader.takeChar();
      if (sep === ',') continue;
      if (sep === ']') break;
      throw new Error(`搬家包资源 ${assetName} 数组分隔符错误`);
    }
    const configuredBeautifyBudget = Number(state.beautifyBudgetChars);
    const beautifyBudget = Number.isFinite(configuredBeautifyBudget)
      ? Math.max(0, configuredBeautifyBudget)
      : CONSTRAINED_BEAUTIFY_TOTAL_MAX_CHARS;
    const skipBeautifyForRecovery = assetName === 'beautifyAssets'
      && (state.skipBeautifyAssets
        || (isConstrainedImportRuntime()
          && Number(state.beautifyProcessedChars || 0) >= beautifyBudget));
    if (skipBeautifyForRecovery) {
      if (state.beautifyResumeIndex == null) state.beautifyResumeIndex = rowIndex;
      await skipJsonValue(reader);
      rowIndex += 1;
      state.beautifySkippedRows += 1;
      state.assetCounts[assetName] += 1;
      if (!state.beautifyRecoverySkipNoted) {
        state.beautifyRecoverySkipNoted = true;
        recordSkippedAsset(
          state,
          assetName,
          state.skipBeautifyAssets ? '本次美化资源' : '其余美化资源',
          state.skipBeautifyAssets
            ? '上次导入在美化资源处中断，本次已优先恢复主数据'
            : (beautifyBudget === 0
              ? 'iOS 已优先恢复主数据，美化资源可在备份与迁移页分批补导'
              : '移动端美化资源已达到安全恢复上限，其余项目可分批补导'),
        );
      }
      if (rowIndex % 12 === 0) {
        emitBackupImportProgress({
          phase: 'store',
          storeName: `assets/${assetName}`,
          rows: state.assetCounts[assetName],
          restored: state.restoredAssetCounts[assetName],
          skipped: true,
          bytesRead: reader.bytesRead,
          totalBytes: reader.file.size,
        });
        await yieldToMainThread();
      }
      await skipJsonWhitespace(reader);
      const sep = await reader.takeChar();
      if (sep === ',') continue;
      if (sep === ']') break;
      throw new Error(`搬家包资源 ${assetName} 数组分隔符错误`);
    }
    let skipped = null;
    const rawResult = await readRawJsonValueMeta(reader, {
      maxChars: assetName === 'beautifyAssets' && isConstrainedImportRuntime()
        ? CONSTRAINED_BEAUTIFY_RAW_MAX_CHARS
        : 0,
    });
    if (assetName === 'beautifyAssets' && isConstrainedImportRuntime()) {
      state.beautifyProcessedChars = Number(state.beautifyProcessedChars || 0) + rawResult.raw.length;
    }
    let patch = null;
    if (rawResult.overflowed) {
      const idMatch = rawResult.raw.match(/"id"\s*:\s*"((?:\\.|[^"\\])*)"/);
      let id = `第 ${rowIndex + 1} 项`;
      if (idMatch) {
        try { id = JSON.parse(`"${idMatch[1]}"`); } catch (_) { id = idMatch[1]; }
      }
      skipped = { id, reason: '单项美化资源过大，移动端已跳过以避免导入闪退' };
    } else {
      try {
        patch = JSON.parse(rawResult.raw);
      } catch (error) {
        throw new Error(`搬家包资源 ${assetName} 解析失败：${error?.message || error}`);
      }
      if (assetName === 'beautifyAssets' && rawResult.mediaOverflowed) {
        skipped = {
          id: String(patch?.id || `第 ${rowIndex + 1} 项`),
          reason: '单张美化图片超过移动端安全恢复上限，已跳过',
        };
      }
    }
    if (!skipped && assetName === 'rows') {
      const row = normalizeBackupSettingsRow(patch, { assetImport: true });
      if (!row) skipped = { id: String(patch?.key || '未知设置项'), reason: '设置资源无法还原' };
      if (!state.validateOnly && row) await db.putRecord('settings', row);
    } else if (!skipped) {
      const id = String(patch?.id || '').trim();
      if (!id) {
        skipped = { id: '缺少 ID', reason: '资源记录缺少 ID' };
      } else if (!state.validateOnly) {
        const existing = await db.getRecord(target.storeName, id);
        // 新版音效补丁携带完整轻量元数据，可在旧搬家包核心段遗漏主记录时自建；
        // 其它资源仍要求先有核心记录，避免静默生成残缺角色或会话。
        if (!existing && !target.direct && assetName !== 'soundAssets') {
          skipped = { id, reason: '找不到对应主记录' };
        } else {
          const merged = target.direct ? patch : target.merge(existing, patch);
          if (!merged) skipped = { id, reason: '音频或媒体内容无法解码' };
          else await db.putRecord(target.storeName, merged);
        }
      }
    }
    rowIndex += 1;
    state.assetCounts[assetName] += 1;
    if (skipped) {
      recordSkippedAsset(state, assetName, skipped.id, skipped.reason);
    } else {
      state.restoredAssetCounts[assetName] += 1;
    }
    emitBackupImportProgress({
      phase: state.validateOnly ? 'preflight-store' : 'store',
      storeName: `assets/${assetName}`,
      rows: state.assetCounts[assetName],
      restored: state.restoredAssetCounts[assetName],
      skipped: state.skippedAssets.length,
      bytesRead: reader.bytesRead,
      totalBytes: reader.file.size,
    });
    await yieldToMainThread();
    await skipJsonWhitespace(reader);
    const sep = await reader.takeChar();
    if (sep === ',') continue;
    if (sep === ']') break;
    throw new Error(`搬家包资源 ${assetName} 数组分隔符错误`);
  }
  if (!state.validateOnly) await db.checkpointNativeReplaceImport();
  emitBackupImportProgress({
    phase: state.validateOnly ? 'preflight-asset-complete' : 'asset-complete',
    assetName,
    storeName: `assets/${assetName}`,
    rows: state.assetCounts[assetName] || 0,
    restored: state.restoredAssetCounts[assetName] || 0,
    skippedAssets: state.skippedAssets.filter((item) => item.assetName === assetName),
    bytesRead: reader.bytesRead,
    totalBytes: reader.file.size,
  });
}

async function parseBackupObject(reader, path, state) {
  await expectJsonChar(reader, '{');
  await skipJsonWhitespace(reader);
  if ((await reader.peek()) === '}') {
    await reader.takeChar();
    return;
  }
  const storeNames = state.storeNames;
  while (true) {
    const key = await readJsonString(reader);
    await expectJsonChar(reader, ':');
    await skipJsonWhitespace(reader);
    const next = await reader.peek();
    const atRoot = path.length === 0;
    const insideStores = path.length === 1 && path[0] === 'stores';
    const insideMigrationAssets = path.length === 1 && path[0] === 'migrationAssets';

    if (atRoot && key === 'format') {
      const raw = await readRawJsonValue(reader);
      const format = JSON.parse(raw);
      if (format !== BACKUP_FORMAT && format !== MIGRATION_PACKAGE_FORMAT && format !== BACKUP_ASSET_FORMAT) {
        throw new Error('不是棉花糖机完整备份、资源包或搬家包');
      }
      state.formatVerified = true;
      state.migrationPackage = format === MIGRATION_PACKAGE_FORMAT;
      state.assetPackage = format === BACKUP_ASSET_FORMAT;
    } else if (atRoot && key === 'stores' && next === '{') {
      await parseBackupObject(reader, ['stores'], state);
    } else if (atRoot && key === 'migrationAssets' && next === '{') {
      await parseBackupObject(reader, ['migrationAssets'], state);
    } else if (atRoot && key === 'migrationManifest') {
      const raw = await readRawJsonValue(reader);
      try {
        state.migrationManifest = JSON.parse(raw);
      } catch (error) {
        throw new Error(`搬家包完成清单解析失败：${error?.message || error}`);
      }
    } else if (insideStores
      && next === '['
      && (storeNames.has(key) || (state.onlyBeautifyAssets && key === 'beautifyAssets'))) {
      emitBackupImportProgress({
        phase: state.validateOnly ? 'preflight-store-start' : 'store-start',
        storeName: key,
        bytesRead: reader.bytesRead,
        totalBytes: reader.file.size,
      });
      await parseStoreArray(reader, key, state);
    } else if (insideMigrationAssets && next === '[') {
      if (state.onlyBeautifyAssets && key !== 'beautifyAssets') await skipJsonValue(reader);
      else await parseMigrationAssetArray(reader, key, state);
    } else if (atRoot && state.assetPackage && next === '[' && MIGRATION_ASSET_TARGETS[key]) {
      if (state.onlyBeautifyAssets && key !== 'beautifyAssets') await skipJsonValue(reader);
      else await parseMigrationAssetArray(reader, key, state);
    } else {
      await skipJsonValue(reader);
    }
    await skipJsonWhitespace(reader);
    const sep = await reader.takeChar();
    if (sep === ',') continue;
    if (sep === '}') break;
    throw new Error('备份 JSON 结构异常：对象分隔符错误');
  }
}

/**
 * @param {File} file
 * @param {{ mode?: 'replace'|'merge' }} options
 */
export async function importFullBackupStreaming(file, options = {}) {
  const migrationPackageFile = await isMigrationPackageFile(file);
  const mode = options.mode === 'merge' ? 'merge' : 'replace';
  const nativeAtomicReplace = migrationPackageFile
    && mode === 'replace'
    && await isNativeDataStoreEnabled().catch(() => false);
  if (migrationPackageFile && options.__migrationPreflightDone !== true && nativeAtomicReplace) {
    // .next 有可回滚的原生暂存代，不必为了“坏包不覆盖旧数据”把 GB 级文件完整
    // 解析两遍。先硬链接保留旧代，单遍解析写入暂存代；只有文件尾清单通过后激活。
    const migrationLease = await acquireMigrationImportLease();
    try {
      return await importFullBackupStreaming(file, {
        ...options,
        __migrationPreflightDone: true,
        __nativeAtomicSinglePass: true,
      });
    } finally {
      migrationLease.release();
    }
  }
  if (migrationPackageFile && options.__migrationPreflightDone !== true) {
    const migrationLease = await acquireMigrationImportLease();
    emitBackupImportProgress({
      phase: 'preflight',
      bytesRead: 0,
      totalBytes: Number(file?.size || 0),
      mode: options.mode === 'merge' ? 'merge' : 'replace',
    });
    try {
      const preflight = await importFullBackupStreaming(file, {
        ...options,
        __migrationPreflightDone: true,
        __validateOnly: true,
      });
      return await importFullBackupStreaming(file, {
        ...options,
        __migrationPreflightDone: true,
        __validateOnly: false,
        __migrationPreflight: preflight,
      });
    } finally {
      migrationLease.release();
    }
  }
  const reader = new ChunkedFileTextReader(file);
  const resumeCheckpoint = options.__resumeCheckpoint || null;
  const state = {
    mode,
    importedStores: new Set(resumeCheckpoint?.completedStores || []),
    clearedStores: new Set(),
    emptyStores: new Set(),
    rowCounts: { ...(resumeCheckpoint?.storeCounts || {}) },
    storeNames: new Set(Object.keys(db.STORES)),
    formatVerified: false,
    migrationPackage: false,
    assetPackage: false,
    migrationManifest: null,
    assetCounts: { ...(resumeCheckpoint?.assetCounts || {}) },
    restoredAssetCounts: { ...(resumeCheckpoint?.restoredAssetCounts || {}) },
    skippedAssets: [...(resumeCheckpoint?.skippedAssets || [])],
    completedAssets: new Set(resumeCheckpoint?.completedAssets || []),
    validateOnly: options.__validateOnly === true,
    skipBeautifyAssets: options.__skipBeautifyAssets === true,
    beautifyProcessedChars: 0,
    beautifyStartIndex: 0,
    // iOS WebKit 在主数据刚完成大量 IndexedDB 写入后继续灌入 Base64 美化图，
    // 很容易被系统按内存压力终止。主导入先完整恢复业务数据，资源留给小批补导。
    beautifyBudgetChars: isIOSWebKitRuntime() ? 0 : CONSTRAINED_BEAUTIFY_TOTAL_MAX_CHARS,
    beautifyResumeIndex: null,
    beautifySkippedRows: 0,
    onlyBeautifyAssets: false,
    beautifyRecoverySkipNoted: false,
    skippedAssetOverflowNoted: false,
  };

  emitBackupImportProgress({
    phase: state.validateOnly ? 'preflight' : 'start',
    bytesRead: 0,
    totalBytes: file.size,
    mode,
  });

  let nativeReplaceStage = null;
  if (migrationPackageFile && mode === 'replace' && !state.validateOnly) {
    if (resumeCheckpoint?.generation) {
      nativeReplaceStage = await resumeNativeReplaceImport(resumeCheckpoint.generation);
      if (nativeReplaceStage) {
        emitBackupImportProgress({
          phase: 'native-stage-resume',
          generation: nativeReplaceStage.generation,
          bytesRead: 0,
          totalBytes: file.size,
        });
        await rebuildIndexedDbCacheFromStaging(nativeReplaceStage.generation);
      }
    }
    if (!nativeReplaceStage) {
      state.importedStores.clear();
      state.rowCounts = {};
      state.completedAssets.clear();
      state.assetCounts = {};
      state.restoredAssetCounts = {};
      state.skippedAssets = [];
      await abortNativeReplaceImport().catch(() => {});
      nativeReplaceStage = await db.beginNativeReplaceImport({
        // 单遍模式事先不知道文件缺少哪些新表，因此先以硬链接保留全部旧表；
        // parseStoreArray 遇到包内表时会清掉暂存代对应表，再写入导入内容。
        preserveStores: options.__nativeAtomicSinglePass
          ? Object.keys(db.STORES)
          : (options.__migrationPreflight?.preservedMissingStores || []),
      });
      emitBackupImportProgress({
        phase: 'native-stage',
        generation: nativeReplaceStage?.generation || 0,
        resetCheckpoint: true,
        bytesRead: 0,
        totalBytes: file.size,
      });
    }
  }
  if (!state.validateOnly) db.setSuppressWriteNotify(true);
  try {
    await parseBackupObject(reader, [], state);

    if (!state.formatVerified && !state.importedStores.size) {
      throw new Error('未识别到可导入的备份数据，请确认是本应用导出的完整备份 JSON');
    }
    if (!state.importedStores.size) {
      throw new Error('备份里没有可写入的数据表');
    }

    if (state.migrationPackage) {
      const manifest = state.migrationManifest;
      if (!manifest || manifest.complete !== true || Number(manifest.version) !== 1) {
        throw new Error('搬家包没有完整写完，已停止导入');
      }
      for (const [storeName, expected] of Object.entries(manifest.counts || {})) {
        if (!state.importedStores.has(storeName)) continue;
        if (migrationManifestScannedStoreCount(storeName, state) !== Number(expected || 0)) {
          throw new Error(`搬家包 ${storeName} 计数不一致，已停止导入`);
        }
      }
      for (const [assetName, expected] of Object.entries(manifest.assetCounts || {})) {
        if (Number(state.assetCounts[assetName] || 0) !== Number(expected || 0)) {
          throw new Error(`搬家包资源 ${assetName} 计数不一致，已停止导入`);
        }
      }
    }

    if (mode === 'replace') {
      const importedRows = Object.values(state.rowCounts || {}).reduce((sum, n) => sum + Number(n || 0), 0);
      if (importedRows <= 0) {
        throw new Error('备份里没有可写入的数据，已中止导入以免清空现有数据');
      }
      // 显式空数组表示备份时该表确实为空；缺失键则通常意味着旧版备份不认识新表，
      // 必须保留本机数据，不能把“缺失”误当成“空”。
      for (const storeName of state.emptyStores) {
        if (state.clearedStores.has(storeName)) continue;
        if (!state.validateOnly) await db.clearStore(storeName);
        state.clearedStores.add(storeName);
        if (!state.validateOnly) await yieldToMainThread();
      }
    }
    if (nativeReplaceStage) {
      // 搬家包的资源段会在主数据段之后补写 settings（壁纸等）并合并角色、用户、
      // 聊天资源。原生暂存代必须与最终 IndexedDB 缓存逐表一致，不能只拿主数据段
      // 的 rowCounts 校验，否则合法 .mmmigrate 会被误报 settings 计数不一致。
      const finalStoreCounts = {};
      for (const storeName of Object.keys(db.STORES)) {
        finalStoreCounts[storeName] = await db.countRecords(storeName);
      }
      await db.commitNativeReplaceImport(finalStoreCounts);
      nativeReplaceStage = null;
    }
  } catch (error) {
    if (nativeReplaceStage) {
      await db.abortNativeReplaceImport().catch((abortError) => {
        console.error('[backup-stream-import] 原生搬家暂存回滚失败', abortError);
      });
      nativeReplaceStage = null;
      if (options.__nativeAtomicSinglePass) {
        // 解析期间 IndexedDB 只是新暂存代的工作缓存。失败后必须立即从仍然有效的
        // 旧原生代回建，不能让用户在本次会话继续看到半份导入数据。
        await rebuildIndexedDbCacheIfNeeded().catch((rebuildError) => {
          console.error('[backup-stream-import] 搬家回滚后网页缓存回建失败', rebuildError);
        });
      }
    }
    throw error;
  } finally {
    if (!state.validateOnly) {
      db.setSuppressWriteNotify(false);
      db.flushWriteListeners();
    }
  }

  emitBackupImportProgress({
    phase: state.validateOnly ? 'preflight-complete' : 'complete',
    stores: [...state.importedStores],
    rowCounts: state.rowCounts,
    bytesRead: reader.bytesRead,
    totalBytes: file.size,
    mode,
  });

  const replacePlan = buildReplaceStorePlan(
    [...state.importedStores],
    Object.keys(db.STORES),
  );
  return {
    mode,
    counts: state.rowCounts,
    migrationPackage: state.migrationPackage,
    assetCounts: state.assetCounts,
    restoredAssetCounts: state.restoredAssetCounts,
    skippedAssets: state.skippedAssets,
    beautifyResumeIndex: state.beautifyResumeIndex,
    beautifySkippedRows: state.beautifySkippedRows,
    skippedSettings: {
      known: Number(state.settingsKnownSkipped || 0),
      oversized: Number(state.settingsOversizedSkipped || 0),
      oversizedKeys: [...(state.settingsOversizedKeys || [])],
    },
    preservedMissingStores: mode === 'replace' ? replacePlan.preserve : [],
  };
}

/**
 * 从完整搬家包中只补写 beautifyAssets。每轮有独立的小预算，调用方保存
 * nextIndex 并让用户重新选择同一文件即可续导；不会再次替换聊天等主数据。
 */
export async function importBeautifyAssetsSupplementStreaming(file, options = {}) {
  if (!file || Number(file.size || 0) <= 0) throw new Error('请选择原来的完整搬家包或数据包');
  const reader = new ChunkedFileTextReader(file);
  const startIndex = Math.max(0, Number(options.startIndex || 0) || 0);
  const state = {
    mode: 'merge',
    importedStores: new Set(),
    clearedStores: new Set(),
    emptyStores: new Set(),
    rowCounts: {},
    storeNames: new Set(),
    formatVerified: false,
    migrationPackage: false,
    assetPackage: false,
    migrationManifest: null,
    assetCounts: {},
    restoredAssetCounts: {},
    skippedAssets: [],
    completedAssets: new Set(),
    validateOnly: false,
    skipBeautifyAssets: false,
    beautifyProcessedChars: 0,
    beautifyStartIndex: startIndex,
    beautifyBudgetChars: Math.max(
      1,
      Number(options.__budgetChars || 0)
        || (isIOSWebKitRuntime()
          ? IOS_BEAUTIFY_SUPPLEMENT_MAX_CHARS
          : CONSTRAINED_BEAUTIFY_SUPPLEMENT_MAX_CHARS),
    ),
    beautifyResumeIndex: null,
    beautifySkippedRows: 0,
    beautifyRecoverySkipNoted: false,
    skippedAssetOverflowNoted: false,
    onlyBeautifyAssets: true,
  };
  db.setSuppressWriteNotify(true);
  try {
    await parseBackupObject(reader, [], state);
  } finally {
    db.setSuppressWriteNotify(false);
    db.flushWriteListeners();
  }
  if (!state.formatVerified) {
    throw new Error('请选择原来的完整搬家包或数据包');
  }
  const totalRows = Number(state.assetCounts.beautifyAssets || 0);
  const restoredRows = Number(state.restoredAssetCounts.beautifyAssets || 0);
  return {
    startIndex,
    nextIndex: state.beautifyResumeIndex,
    totalRows,
    restoredRows,
    complete: state.beautifyResumeIndex == null,
    skippedAssets: state.skippedAssets,
  };
}

/** 大资源包按数组逐条合并，避免 100MB 级文件 readAsText + JSON.parse 的瞬时内存峰值。 */
export async function importAssetBackupStreaming(file) {
  const reader = new ChunkedFileTextReader(file);
  const state = {
    mode: 'merge',
    importedStores: new Set(),
    clearedStores: new Set(),
    emptyStores: new Set(),
    rowCounts: {},
    storeNames: new Set(Object.keys(db.STORES)),
    formatVerified: false,
    migrationPackage: false,
    assetPackage: false,
    migrationManifest: null,
    assetCounts: {},
    restoredAssetCounts: {},
    skippedAssets: [],
    completedAssets: new Set(),
    validateOnly: false,
    skipBeautifyAssets: false,
    beautifyProcessedChars: 0,
    beautifyStartIndex: 0,
    beautifyBudgetChars: isIOSWebKitRuntime()
      ? IOS_BEAUTIFY_SUPPLEMENT_MAX_CHARS
      : CONSTRAINED_BEAUTIFY_TOTAL_MAX_CHARS,
    beautifyResumeIndex: null,
    beautifySkippedRows: 0,
    onlyBeautifyAssets: false,
    beautifyRecoverySkipNoted: false,
    skippedAssetOverflowNoted: false,
  };
  emitBackupImportProgress({
    phase: 'start',
    storeName: 'assets',
    bytesRead: 0,
    totalBytes: file.size,
    mode: 'merge',
  });
  db.setSuppressWriteNotify(true);
  try {
    await parseBackupObject(reader, [], state);
    if (!state.formatVerified || !state.assetPackage) {
      throw new Error('不是棉花糖机资源包');
    }
  } finally {
    db.setSuppressWriteNotify(false);
    db.flushWriteListeners();
  }
  emitBackupImportProgress({
    phase: 'complete',
    storeName: 'assets',
    assetCounts: state.assetCounts,
    bytesRead: reader.bytesRead,
    totalBytes: file.size,
    mode: 'merge',
  });
  return {
    mode: 'merge',
    assets: state.assetCounts,
    restoredAssets: state.restoredAssetCounts,
    assetCounts: state.assetCounts,
    restoredAssetCounts: state.restoredAssetCounts,
    skippedAssets: state.skippedAssets,
    beautifyResumeIndex: state.beautifyResumeIndex,
    beautifySkippedRows: state.beautifySkippedRows,
    streamed: true,
  };
}

export function shouldUseStreamingBackupImport(file) {
  const size = Number(file?.size || 0);
  if (size <= 0) return false;
  if (/\.(?:mmmigrate|bin)$/i.test(String(file?.name || ''))) return true;
  if (isConstrainedImportRuntime()) return true;
  return size >= WEB_STREAM_IMPORT_THRESHOLD_BYTES;
}

export async function isMigrationPackageFile(file) {
  if (/\.mmmigrate$/i.test(String(file?.name || ''))) return true;
  if (!file || Number(file.size || 0) <= 0 || typeof file.slice !== 'function') return false;
  try {
    const prefixBlob = file.slice(0, Math.min(Number(file.size || 0), MIGRATION_PROBE_BYTES));
    const prefix = typeof prefixBlob.text === 'function'
      ? await prefixBlob.text()
      : new TextDecoder('utf-8').decode(await prefixBlob.arrayBuffer());
    return /"format"\s*:\s*"marshmallow-machine-migration"/.test(prefix);
  } catch (_) {
    return false;
  }
}

/**
 * 资源包也可能大到必须走字符流式解析。高级导入会把所有单文件交给完整备份
 * 入口，因此要在通用的“大文件即完整备份”分支之前按内容识别资源包。
 */
export async function isAssetBackupFile(file) {
  if (!file || Number(file.size || 0) <= 0 || typeof file.slice !== 'function') return false;
  try {
    const prefixBlob = file.slice(0, Math.min(Number(file.size || 0), MIGRATION_PROBE_BYTES));
    const prefix = typeof prefixBlob.text === 'function'
      ? await prefixBlob.text()
      : new TextDecoder('utf-8').decode(await prefixBlob.arrayBuffer());
    return /"format"\s*:\s*"marshmallow-phone-backup-assets"/.test(prefix);
  } catch (_) {
    return false;
  }
}
