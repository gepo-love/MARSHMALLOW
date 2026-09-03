import * as db from './db.js';
import {
  BROWSER_DOWNLOAD_RELEASE_DELAY_MS,
  canShareBlobFile,
  downloadBlob,
  downloadText,
  isAndroidDevice,
  isIOSDevice,
  pickWebSaveWritable,
  shareBlobFile,
} from './native-download.js';
import {
  importFullBackupStreaming,
  importBeautifyAssetsSupplementStreaming,
  importAssetBackupStreaming,
  shouldUseStreamingBackupImport,
  emitBackupImportProgress,
  normalizeBackupStoreRow,
  normalizeBackupSettingsRow,
  importBatchSizeForStore,
  isAssetSettingsKey,
  isAssetBackupFile,
  isMigrationPackageFile,
  shouldSkipBackupSettingsRow,
  buildReplaceStorePlan,
} from './backup-stream-import.js';
import { readJsonEntriesFromZip } from './regex-zip-import.js';
import {
  createExportOmissionTracker,
  trackSettingsExportRow,
  trackMusicExportRow,
  trackDerivedVectorExportRow,
  buildExportMeta,
  summarizeExportOmissions,
  formatExportOmissionHint,
} from './backup-export-meta.js';
import {
  extractCharacterAssetRow,
  mergeCharacterAssetRow,
} from './backup-character-assets.js';
import {
  extractUserAssetRow,
  mergeUserAssetRow,
  extractChatAssetRow,
  mergeChatAssetRow,
} from './backup-extra-assets.js';
import {
  appendMusicAssetJsonToWriter,
  appendSoundAssetJsonToWriter,
  mergeMusicAssetRow,
  mergeSoundAssetRow,
} from './backup-music-assets.js';
import { appendJsonValueToWriter } from './backup-json-stream.js';
import { beginNativeChunkedTextSave } from './native-file-export.js';
import { sha256Hex } from './backup-encryption.js';
import { migrateLegacyChatWallpaperAssets } from './chat-wallpaper-assets.js';
import { runStorageMaintenanceExclusive } from './storage-maintenance.js';
import {
  beginOpfsTempTarget,
  isOpfsCapabilityError,
  removeOpfsTempTarget,
  requiredOpfsTempError,
} from './opfs-temp.js';
import {
  REGION_BACKUP_FORMAT,
  REGION_BACKUP_VERSION,
  REGION_PART_TARGET_BYTES,
  createBackupRegionPartPlanner,
  getCoreBackupRegions,
  stripRegionBackupAssets,
  utf8ByteLength,
  validateRegionBackupManifest,
  summarizeRegionBackupPlan,
  formatRegionBackupPlanText,
  getRegionBackupRegionLabel,
} from './backup-regions.js';

const BACKUP_FORMAT = 'marshmallow-phone-backup';
export const MIGRATION_PACKAGE_FORMAT = 'marshmallow-machine-migration';
export const MIGRATION_PACKAGE_VERSION = 1;
export const BACKUP_PART_FORMAT = 'marshmallow-phone-backup-part';
export const BACKUP_ASSET_FORMAT = 'marshmallow-phone-backup-assets';
const BACKUP_VERSION = 1;
const EXPORT_BUFFER_FLUSH_CHARS = 512 * 1024;

function isNativeShell() {
  return typeof window !== 'undefined'
    && typeof window.Capacitor?.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform();
}

/** 分片导入的批次之间让一帧给渲染/输入，避免大批量写入把主线程连续占满导致假死。 */
function yieldToUi() {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function beginCriticalActivity(label) {
  const begin = globalThis.__mm_begin_critical_activity__;
  return typeof begin === 'function' ? begin(label) : () => {};
}

async function beginBackupExportActivity(label) {
  const releaseCritical = beginCriticalActivity('backup-export');
  const markRisk = globalThis.__mm_mark_risky_activity__;
  let riskToken = typeof markRisk === 'function'
    ? markRisk(label, { operation: 'backup-export', phase: 'waiting-background' })
    : '';
  let backgroundSettled = true;
  const waitForQuiet = globalThis.__mm_wait_for_background_quiet__;
  if (typeof waitForQuiet === 'function') {
    backgroundSettled = await waitForQuiet({ timeoutMs: 12000, pollMs: 150 }).catch(() => false);
  }
  const update = (detail = {}) => {
    if (typeof markRisk !== 'function') return;
    riskToken = markRisk(label, {
      operation: 'backup-export',
      backgroundSettled,
      ...detail,
    }) || riskToken;
  };
  update({ phase: 'start' });
  const release = () => {
    if (riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
    releaseCritical();
  };
  release.update = update;
  return release;
}

async function beginWebExportTarget(filename, mimeType) {
  if (isNativeShell()) return null;
  return pickWebSaveWritable(filename, { mimeType });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function timestampForFile(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('');
}

function createBackupId() {
  return `mm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function assertMigrationPackageFileEnvelope(file, packageId) {
  if (!file || Number(file.size || 0) <= 0 || typeof file.slice !== 'function') {
    throw new Error('搬家包临时文件为空，请重新导出');
  }
  const probeBytes = 96 * 1024;
  const head = await file.slice(0, Math.min(file.size, probeBytes)).text();
  const tailStart = Math.max(0, file.size - probeBytes);
  const tail = await file.slice(tailStart, file.size).text();
  const expectedFormat = `"format":"${MIGRATION_PACKAGE_FORMAT}"`;
  if (!head.trimStart().startsWith(`{${expectedFormat}`)) {
    throw new Error('搬家包文件头校验失败，已停止保存');
  }
  if (
    !tail.trimEnd().endsWith('}')
    || !tail.includes('"migrationManifest":')
    || !tail.includes(`"packageId":${JSON.stringify(packageId)}`)
    || !tail.includes('"complete":true')
  ) {
    throw new Error('搬家包完成标记校验失败，已停止保存');
  }
}

class JsonBlobWriter {
  constructor() {
    this.parts = [];
    this.buffer = '';
    this.bytes = 0;
    this.encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
    // 即使最终仍需组装 Blob，数据源也必须走短事务批次读取。否则聊天库变大后，
    // iOS 会让一个整表 cursor 长时间占住 IndexedDB，备份和聊天互相拖垮。
    this.isStreaming = true;
  }

  write(text) {
    if (!text) return;
    this.buffer += text;
    if (this.buffer.length >= EXPORT_BUFFER_FLUSH_CHARS) this.flush();
  }

  flush() {
    if (!this.buffer) return;
    // iOS 创建 Blob 时若 parts 仍是大量 UTF-16 字符串，会在统一转 UTF-8 的瞬间
    // 同时保留字符串与二进制副本。逐段预编码可把峰值摊开，避免大备份杀掉 WebKit 页进程。
    const part = this.encoder ? this.encoder.encode(this.buffer) : this.buffer;
    this.parts.push(part);
    this.bytes += typeof part === 'string' ? part.length : part.byteLength;
    this.buffer = '';
  }

  get shouldDrain() {
    return this.buffer.length >= EXPORT_BUFFER_FLUSH_CHARS;
  }

  async drain() {
    this.flush();
    await yieldToUi();
  }

  toBlob(type = 'application/json') {
    this.flush();
    return new Blob(this.parts, { type });
  }

  async writeToWritable(writable) {
    if (!writable) throw new Error('writable 不可用');
    this.flush();
    for (const part of this.parts) {
      await writable.write(part);
    }
    if (this.buffer) await writable.write(this.buffer);
    await writable.close();
    this.release();
  }

  release() {
    this.parts.length = 0;
    this.buffer = '';
    this.bytes = 0;
  }

  get sizeEstimate() {
    if (!this.buffer) return this.bytes;
    if (this.encoder) return this.bytes + this.encoder.encode(this.buffer).byteLength;
    return this.bytes + this.buffer.length;
  }
}

class JsonWritableWriter {
  constructor(writable) {
    this.writable = writable;
    this.buffer = '';
    this.bytes = 0;
    this.encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
    this.isStreaming = true;
    this.closed = false;
  }

  write(text) {
    if (text) this.buffer += text;
  }

  get shouldDrain() {
    return this.buffer.length >= EXPORT_BUFFER_FLUSH_CHARS;
  }

  async drain() {
    if (!this.buffer) return;
    const text = this.buffer;
    this.buffer = '';
    const part = this.encoder ? this.encoder.encode(text) : text;
    this.bytes += typeof part === 'string' ? part.length : part.byteLength;
    await this.writable.write(part);
  }

  async close() {
    if (this.closed) return;
    await this.drain();
    await this.writable.close();
    this.closed = true;
  }

  async abort() {
    if (this.closed) return;
    this.buffer = '';
    this.closed = true;
    try {
      await this.writable.abort();
    } catch {
      // Older WebKit builds may not implement abort.
    }
  }

  get sizeEstimate() {
    if (!this.buffer) return this.bytes;
    if (this.encoder) return this.bytes + this.encoder.encode(this.buffer).byteLength;
    return this.bytes + this.buffer.length;
  }
}

async function beginOpfsExportTarget(filename, { iosOnly = false, requiredLabel = '' } = {}) {
  if (iosOnly && !isIOSDevice()) return null;
  return beginOpfsTempTarget(filename, {
    required: !!requiredLabel,
    label: requiredLabel || '备份',
  });
}

async function removeOpfsExportTarget(target) {
  await removeOpfsTempTarget(target);
}

/**
 * 移动端 Web Share 必须在一次全新的用户点击里同步开始。备份整理会跨越大量
 * IndexedDB/OPFS await，不能在整理完成后直接 navigator.share；否则浏览器
 * 会因失去用户手势而拒绝。这里保留已经准备好的 File/Blob，交给 UI 的
 * 「保存到文件」按钮在下一次 click 中调用。
 */
function createDeferredBackupSave(blob, filename, cleanup = null, options = {}) {
  let disposed = false;
  let saved = false;
  const saveMimeType = String(options.mimeType || blob?.type || 'application/json');
  // OPFS getFile() 会根据扩展名返回空 MIME。iOS 分享空 MIME / 自定义
  // .mmmigrate 时可能降级成分享标题文本，保存出的文件便从“marshmallow…”
  // 开始而不是 JSON。slice 只创建同一份字节的类型化视图，不重新组装大文件。
  const saveBlob = blob?.type === saveMimeType
    ? blob
    : blob.slice(0, blob.size, saveMimeType);
  const dispose = () => {
    if (disposed) return Promise.resolve();
    disposed = true;
    return Promise.resolve(typeof cleanup === 'function' ? cleanup() : undefined)
      .catch(() => {});
  };
  const finishSave = (pending) => Promise.resolve(pending).then((result) => {
    saved = true;
    if (result?.method === 'browser') {
      // Android 下载管理器会在 click 返回后异步读取 OPFS-backed File。
      // Blob URL 释放后再删临时源，避免文件名存在但内容变成 0 B。
      setTimeout(() => { void dispose(); }, BROWSER_DOWNLOAD_RELEASE_DELAY_MS + 1000);
      return result;
    }
    return dispose().then(() => result);
  });
  return {
    requiresSaveGesture: true,
    supportsFileShare: canShareBlobFile(saveBlob, filename),
    filename,
    save() {
      if (disposed) return Promise.reject(new Error('这份临时数据包已释放，请重新整理'));
      // 不要把 downloadBlob 放进 Promise.then/额外 await：必须在 click 调用栈内
      // 立刻进入 navigator.share，才能保留移动端的 transient user activation。
      const pending = downloadBlob(saveBlob, filename, {
        mimeType: saveMimeType,
        directory: 'downloads',
      });
      return finishSave(pending);
    },
    share() {
      if (disposed) return Promise.reject(new Error('这份临时数据包已释放，请重新整理'));
      return finishSave(shareBlobFile(saveBlob, filename));
    },
    discard() {
      if (saved) return Promise.resolve();
      return dispose();
    },
  };
}

function assertBackupPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('备份文件格式不正确');
  if (payload.format !== BACKUP_FORMAT) throw new Error('不是棉花糖机完整备份');
  if (!payload.stores || typeof payload.stores !== 'object') throw new Error('备份文件缺少数据表');
}

/** 兼容急救页旧版导出的原始 JSON；缺失或曾跳过的表会在恢复时保留本机现有内容。 */
export function normalizeLegacyEmergencyBackupPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.__mmEmergencyBackup !== true) return payload;
  const sourceStores = payload.stores && typeof payload.stores === 'object' ? payload.stores : {};
  const stores = {};
  for (const [storeName, rows] of Object.entries(sourceStores)) {
    if (db.STORES[storeName] && Array.isArray(rows)) stores[storeName] = rows;
  }
  return {
    format: BACKUP_FORMAT,
    version: Number(payload.version) || BACKUP_VERSION,
    app: 'marshmallow-phone',
    exportedAt: payload.exportedAt || null,
    recoveryExport: {
      source: 'legacy-recovery-page',
      inventory: payload.inventory || null,
      skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
    },
    stores,
  };
}

function countIncomingBackupRows(stores = {}) {
  return Object.keys(db.STORES).reduce((sum, storeName) => {
    const rows = Array.isArray(stores[storeName]) ? stores[storeName].filter(Boolean) : [];
    return sum + rows.length;
  }, 0);
}

function countBackupPartRows(payload = {}) {
  const rows = Array.isArray(payload.rows) ? payload.rows.filter(Boolean) : [];
  if (!rows.length) return 0;
  if (payload.store === 'settings') {
    return rows.map((row) => normalizeBackupStoreRow('settings', row, {
      assetImport: payload.segment === 'assets',
    })).filter(Boolean).length;
  }
  return rows.length;
}

export function isBackupAssetPayload(payload) {
  return payload
    && typeof payload === 'object'
    && payload.format === BACKUP_ASSET_FORMAT
    && (Array.isArray(payload.rows)
      || Array.isArray(payload.characterAssets)
      || Array.isArray(payload.userAssets)
      || Array.isArray(payload.chatAssets)
      || Array.isArray(payload.beautifyAssets)
      || Array.isArray(payload.musicAssets)
      || Array.isArray(payload.soundAssets));
}

export function buildAssetBackupPayload({
  exportedAt = new Date().toISOString(),
  rows = [],
  characterAssets = [],
  userAssets = [],
  chatAssets = [],
  beautifyAssets = [],
  musicAssets = [],
  soundAssets = [],
} = {}) {
  return {
    format: BACKUP_ASSET_FORMAT,
    version: BACKUP_VERSION,
    app: 'marshmallow-phone',
    exportedAt,
    rows,
    characterAssets,
    userAssets,
    chatAssets,
    beautifyAssets,
    musicAssets,
    soundAssets,
    exportMeta: {
      includes: [
        'voiceAudioCache',
        'radioAudioBlob_*',
        'appearancePrefs',
        'characterPhone_*',
        'companionSettings_*',
        'character.avatar',
        'character.imageLock.refImageUrl',
        'character.showcaseImages',
        'user.avatar',
        'chat.groupSettings.wallpaper',
        'chat.groupSettings.avatar',
        'beautifyAssets',
        'musicTracks.audioBlob',
        'soundAssets.audioBlob',
      ],
      note: '资源包含 settings 大体积项、美化素材库、角色/用户头像、聊天壁纸、本地音乐、电台缓存与音频库；需与完整/分片备份配合使用',
    },
  };
}

function isBackupPartPayload(payload) {
  return payload
    && typeof payload === 'object'
    && payload.format === BACKUP_PART_FORMAT
    && typeof payload.store === 'string'
    && Array.isArray(payload.rows);
}

async function readFileAsText(file, options = {}) {
  const label = String(options.label || file?.name || '备份文件');
  const totalBytes = Number(file?.size || 0);
  emitBackupImportProgress({
    phase: 'read',
    label,
    bytesRead: 0,
    totalBytes,
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (ev) => {
      if (!ev || !ev.lengthComputable) return;
      emitBackupImportProgress({
        phase: 'read',
        label,
        bytesRead: Number(ev.loaded || 0),
        totalBytes: Number(ev.total || totalBytes || 0),
      });
    };
    reader.onload = () => {
      emitBackupImportProgress({
        phase: 'parse',
        label,
        bytesRead: totalBytes,
        totalBytes,
      });
      resolve(String(reader.result || ''));
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * 旧分片文件序列化时 format/store/segment/part 都排在体积巨大的 rows 数组前面，
 * 用正则先在文件头部拿排序用的元信息，不用对整份文件做一次 JSON.parse——
 * 分片导入本来是"全部文件读完解析完才开始写"，大文件多的时候内存峰值和卡顿都很明显，
 * 这一步只是为了排序，不需要先把所有 rows 都解析出来。
 */
function extractBackupPartHeaderFast(text) {
  if (typeof text !== 'string' || !text) return null;
  const head = text.slice(0, 2048);
  if (!head.includes(`"format":"${BACKUP_PART_FORMAT}"`)) return null;
  const storeMatch = /"store":"([^"]*)"/.exec(head);
  if (!storeMatch) return null;
  const segmentMatch = /"segment":"([^"]*)"/.exec(head);
  const partMatch = /"part":(\d+)/.exec(head);
  return {
    store: storeMatch[1],
    segment: segmentMatch ? segmentMatch[1] : 'core',
    part: partMatch ? Number(partMatch[1]) : 0,
  };
}

function comparePartHeaders(a, b, storeOrder) {
  const ia = storeOrder.indexOf(a.header.store);
  const ib = storeOrder.indexOf(b.header.store);
  if (ia !== ib) return ia - ib;
  const segA = String(a.header.segment || 'core');
  const segB = String(b.header.segment || 'core');
  if (segA !== segB) {
    if (segA === 'core') return -1;
    if (segB === 'core') return 1;
  }
  return Number(a.header.part || 0) - Number(b.header.part || 0);
}

/**
 * 分片备份导入的共用管线：接受 { name, readText() } 形式的文件源，既服务于用户直接选择的
 * 多个 .json 文件，也服务于 ZIP 内的分片条目（避免 ZIP 分片再套一层虚拟 File 重复读一遍文本）。
 *
 * 第一遍只做轻量头部识别用于排序，尽量不把所有分片的 rows 同时解析进内存；
 * 第二遍逐个文件真正 JSON.parse + 写库 + 丢弃，写完一个才读下一个，峰值内存约等于最大的单个分片。
 */
async function importBackupPartSources(sources, options = {}) {
  const list = [...sources].filter(Boolean);
  if (!list.length) throw new Error('未选择文件');

  const headers = [];
  for (const source of list) {
    const text = await source.readText();
    const fast = extractBackupPartHeaderFast(text);
    if (fast) {
      headers.push({ source, header: fast, cachedData: null });
      continue;
    }
    // 正则没识别出来时兜底整份 parse 一次，保证不会因为格式意外而漏掉有效分片。
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      continue;
    }
    if (!isBackupPartPayload(data)) continue;
    headers.push({
      source,
      header: { store: data.store, segment: data.segment || 'core', part: Number(data.part || 0) },
      cachedData: data,
    });
  }
  if (!headers.length) throw new Error('未找到有效的分片备份文件');

  if (options.mode !== 'merge') {
    let previewRows = 0;
    for (const entry of headers) {
      let data = entry.cachedData;
      if (!data) {
        const text = await entry.source.readText();
        try {
          data = JSON.parse(text);
        } catch (_) {
          throw new Error(`${entry.source.name || '分片'} 不是合法 JSON`);
        }
        entry.cachedData = data;
      }
      if (!isBackupPartPayload(data)) continue;
      previewRows += countBackupPartRows(data);
    }
    if (previewRows <= 0) {
      throw new Error('分片备份里没有可写入的数据，已中止导入以免清空现有数据');
    }
  }

  const storeOrder = Object.keys(db.STORES);
  headers.sort((a, b) => comparePartHeaders(a, b, storeOrder));
  const replacePlan = buildReplaceStorePlan(
    headers.map((entry) => entry.header?.store).filter((storeName) => db.STORES[storeName]),
    storeOrder,
  );

  db.setSuppressWriteNotify(true);
  const state = { clearedStores: new Set() };
  const counts = {};
  try {
    emitBackupImportProgress({ phase: 'start', totalFiles: headers.length, mode: options.mode || 'replace' });
    for (const entry of headers) {
      let data = entry.cachedData;
      if (!data) {
        const text = await entry.source.readText();
        try {
          data = JSON.parse(text);
        } catch (_) {
          throw new Error(`${entry.source.name || '分片'} 不是合法 JSON`);
        }
      }
      entry.cachedData = null;
      if (!isBackupPartPayload(data)) continue;
      const written = await importBackupPartPayload(data, options, state);
      counts[data.store] = (counts[data.store] || 0) + written;
      await yieldToUi();
    }
  } finally {
    db.setSuppressWriteNotify(false);
    db.flushWriteListeners();
  }
  emitBackupImportProgress({ phase: 'complete', counts, totalFiles: headers.length, mode: options.mode || 'replace' });
  return {
    mode: options.mode === 'merge' ? 'merge' : 'replace',
    counts,
    preservedMissingStores: options.mode === 'merge' ? [] : replacePlan.preserve,
  };
}

function normalizeExportRow(storeName, row, tracker, segment = null, options = {}) {
  if (!row) return null;
  // embedding 向量只由记忆、消息原文和世界书派生，恢复后会在后台重新索引。
  // 数百到数千维浮点数组写进 JSON 会让无图片的数据包也膨胀到 GB 级，
  // 同时制造很高的导出内存峰值；保留源数据即可完整恢复聊天效果。
  if (storeName === 'memoryVectors') {
    if (tracker) trackDerivedVectorExportRow(tracker, row);
    return null;
  }
  // 美化图片、组件及其素材 ID 正式归入资源包。旧备份仍可从 stores.beautifyAssets
  // 导入；新备份不再在数据包和资源包各复制一份大图。
  if (storeName === 'beautifyAssets' && (segment === 'core' || segment == null)) return null;
  if (storeName === 'characters' && segment === 'assets') {
    return extractCharacterAssetRow(row);
  }
  if (storeName === 'musicTracks') {
    const next = { ...row };
    delete next.audioBlob;
    if (tracker) trackMusicExportRow(tracker, row);
    return next;
  }
  if (storeName === 'soundAssets') {
    const next = { ...row };
    delete next.audioBlob;
    return next;
  }
  if (storeName !== 'settings') {
    let next = (segment === 'core' || segment == null)
      ? stripRegionBackupAssets(storeName, row)
      : row;
    // APK 网页截图是一次性识图中转，不属于用户聊天资产。即便识图失败或导出恰好
    // 发生在模型返回前，也不能把商品页截图塞进本地/迁移/GitHub 云备份。
    if (storeName === 'messages'
      && (next?.metadata?.screenshotFallback === true || next?.metadata?.enhancedBy === 'webview-snapshot')) {
      const metadata = { ...(next.metadata || {}) };
      metadata.images = (Array.isArray(metadata.images) ? metadata.images : [])
        .filter((url) => !/^data:image\//i.test(String(url || '')));
      ['coverUrl', 'imageUrl', 'image'].forEach((key) => {
        if (/^data:image\//i.test(String(metadata[key] || ''))) metadata[key] = '';
      });
      next = { ...next, metadata };
    }
    // 老聊天图片曾同时把同一份 Base64 放在 content 和 metadata.url。
    // 显示与导入都以 content 为主，搬家时去掉完全相同的副本即可无损减半。
    if (storeName === 'messages'
      && next?.type === 'image'
      && /^data:image\//i.test(String(next.content || ''))
      && String(next.content || '') === String(next.metadata?.url || '')) {
      next = {
        ...next,
        metadata: { ...(next.metadata || {}), url: '' },
      };
    }
    return next;
  }

  const key = String(row.key || '');
  const isAsset = isAssetSettingsKey(key);

  if (options.includeAssets === true && (segment === 'core' || segment == null)) {
    return isAsset
      ? normalizeBackupSettingsRow(row, { assetImport: true })
      : normalizeBackupSettingsRow(row, { forExport: true });
  }

  if (segment === 'assets') {
    if (!isAsset) return null;
    return { key, value: row.value };
  }

  if (segment === 'core' || segment == null) {
    if (isAsset || shouldSkipBackupSettingsRow(row)) {
      if (tracker && isAsset) trackSettingsExportRow(tracker, row, null);
      return null;
    }
    const normalized = normalizeBackupStoreRow(storeName, row, { forExport: true });
    if (tracker) trackSettingsExportRow(tracker, row, normalized);
    return normalized;
  }

  return null;
}

async function appendStoreRowsToWriter(writer, storeName, tracker, segment = null, options = {}) {
  writer.write(`${JSON.stringify(storeName)}:[`);
  let first = true;
  let rows = 0;
  const appendRow = async (row) => {
    const normalized = normalizeExportRow(storeName, row, tracker, segment, options);
    if (!normalized) return;
    writer.write(first ? '' : ',');
    await appendJsonValueToWriter(writer, normalized);
    first = false;
    rows += 1;
    if (writer.isStreaming && writer.shouldDrain) await writer.drain();
  };
  // iOS Safari 没有流式文件保存能力时也必须使用短事务。长游标事务在序列化
  // 大聊天库期间容易被 WebKit 的存储进程回收，随后让聊天和备份同时重连。
  const mediaHeavyStore = storeName === 'messages' || storeName === 'settings';
  await db.forEachStoreRecordBatched(storeName, appendRow, {
    // 自动安全备份会和当前页面共用 WebView renderer。重媒体表一次只克隆一条，
    // 其它表也收紧批次，避免几十 MB 的导出包在 IndexedDB 克隆阶段膨胀到数百 MB RSS。
    batchSize: writer.isStreaming ? (mediaHeavyStore ? 1 : 8) : (mediaHeavyStore ? 1 : 6),
    onBatch: yieldToUi,
  });
  writer.write(']');
  if (writer.isStreaming && writer.shouldDrain) await writer.drain();
  return rows;
}
async function appendMappedStoreArray(writer, propertyName, storeName, mapRow) {
  writer.write(`${JSON.stringify(propertyName)}:[`);
  let first = true;
  let rows = 0;
  const appendRow = async (row) => {
    const normalized = mapRow(row);
    if (!normalized) return;
    writer.write(first ? '' : ',');
    await appendJsonValueToWriter(writer, normalized);
    first = false;
    rows += 1;
    if (writer.isStreaming && writer.shouldDrain) await writer.drain();
  };
  await db.forEachStoreRecordBatched(storeName, appendRow, {
    batchSize: writer.isStreaming ? 12 : 8,
    onBatch: yieldToUi,
  });
  writer.write(']');
  if (writer.isStreaming && writer.shouldDrain) await writer.drain();
  return rows;
}

async function appendMusicAssetsToWriter(writer) {
  writer.write('"musicAssets":[');
  let first = true;
  let rows = 0;
  const appendRow = async (track) => {
    const written = await appendMusicAssetJsonToWriter(writer, track, {
      prefix: first ? '' : ',',
    });
    if (!written) return;
    first = false;
    rows += 1;
    // OPFS writer 会立刻把本首落盘并释放字符串；内存兜底也只保留 UTF-8
    // Uint8Array，不再同时滞留整首音频的 Blob、Data URL 与 JSON 三份副本。
    await writer.drain();
  };
  // 音频 Blob 一次只从 IndexedDB 取一首；批次大于 1 会让多首本地音乐在
  // WebKit 内存里同时存活，即使 JSON 本身已经流式写盘也仍可能杀掉页面。
  await db.forEachStoreRecordBatched('musicTracks', appendRow, {
    batchSize: 1,
    onBatch: yieldToUi,
  });
  writer.write(']');
  if (writer.shouldDrain) await writer.drain();
  return rows;
}

async function appendSoundAssetsToWriter(writer) {
  writer.write('"soundAssets":[');
  let first = true;
  let rows = 0;
  const appendRow = async (asset) => {
    const written = await appendSoundAssetJsonToWriter(writer, asset, {
      prefix: first ? '' : ',',
    });
    if (!written) return;
    first = false;
    rows += 1;
    await writer.drain();
  };
  await db.forEachStoreRecordBatched('soundAssets', appendRow, {
    batchSize: 1,
    onBatch: yieldToUi,
  });
  writer.write(']');
  if (writer.shouldDrain) await writer.drain();
  return rows;
}

async function writeRowsToDb(storeName, records, options = {}) {
  if (!records.length) return 0;
  const batchSize = importBatchSizeForStore(storeName);
  let written = 0;
  for (let i = 0; i < records.length; i += batchSize) {
    const chunk = records.slice(i, i + batchSize);
    await db.putMany(storeName, chunk, { batchSize: chunk.length });
    written += chunk.length;
    emitBackupImportProgress({
      phase: 'store',
      storeName,
      rows: written,
      totalRows: records.length,
      mode: options.mode || 'replace',
    });
    if (written < records.length) await yieldToUi();
  }
  return written;
}

async function buildFullBackupExport(writer = new JsonBlobWriter(), options = {}) {
  await migrateLegacyChatWallpaperAssets();
  const tracker = createExportOmissionTracker();
  const exportedAt = new Date().toISOString();
  writer.write('{');
  const migrationPackage = options.migrationPackage === true;
  writer.write(`"format":${JSON.stringify(migrationPackage ? MIGRATION_PACKAGE_FORMAT : BACKUP_FORMAT)},`);
  writer.write(`"version":${migrationPackage ? MIGRATION_PACKAGE_VERSION : BACKUP_VERSION},`);
  writer.write('"app":"marshmallow-phone",');
  writer.write(`"dbName":${JSON.stringify(db.DB_NAME)},`);
  writer.write(`"dbVersion":${db.DB_VERSION},`);
  writer.write(`"exportedAt":${JSON.stringify(exportedAt)},`);
  writer.write('"stores":{');
  const counts = {};
  let firstStore = true;
  for (const storeName of Object.keys(db.STORES)) {
    if (!firstStore) writer.write(',');
    firstStore = false;
    const segment = storeName === 'settings' ? 'core' : null;
    options.onRiskProgress?.({ phase: 'store-read', storeName });
    try {
      counts[storeName] = await appendStoreRowsToWriter(writer, storeName, tracker, segment);
    } catch (error) {
      options.onRiskProgress?.({
        phase: 'store-error',
        storeName,
        errorName: String(error?.name || ''),
        errorMessage: String(error?.message || error || '').slice(0, 240),
      });
      throw error;
    }
    options.onRiskProgress?.({
      phase: 'store-complete',
      storeName,
      rows: counts[storeName],
    });
    emitBackupImportProgress({ phase: 'export-store', storeName, rows: counts[storeName] });
  }
  writer.write('},');
  const exportMeta = buildExportMeta(tracker, { suggestAssetExport: true });
  writer.write(`"exportMeta":${JSON.stringify(exportMeta)}`);
  let migrationAssetCounts = {};
  let migrationAssetBytes = 0;
  if (migrationPackage) {
    const assetStartBytes = Number(writer.sizeEstimate || 0);
    writer.write(',"migrationAssets":{');
    migrationAssetCounts = await appendAssetCollectionsToWriter(writer, { allowEmpty: true });
    writer.write('},');
    migrationAssetBytes = Math.max(0, Number(writer.sizeEstimate || 0) - assetStartBytes);
    writer.write(`"migrationManifest":${JSON.stringify({
      version: MIGRATION_PACKAGE_VERSION,
      packageId: options.packageId || createBackupId(),
      sourceBuild: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
      sourceDatabaseVersion: db.DB_VERSION,
      exportedAt,
      counts,
      assetCounts: migrationAssetCounts,
      assetBytes: migrationAssetBytes,
      complete: true,
    })}`);
  }
  writer.write('}');
  return {
    writer,
    counts,
    exportedAt,
    exportMeta,
    omissions: summarizeExportOmissions(tracker),
    assetCounts: migrationAssetCounts,
    assetBytes: migrationAssetBytes,
  };
}

/**
 * 把完整数据包写入调用方提供的流式 writer，不在 WebView 内存中组装 Blob。
 * APK 原生安全备份使用这条路径，把每一小段 JSON 直接交给原生文件。
 */
export async function writeFullBackupToWriter(writer, options = {}) {
  if (!writer || typeof writer.write !== 'function' || typeof writer.drain !== 'function') {
    throw new Error('备份输出流不可用');
  }
  const releaseActivity = await beginBackupExportActivity('backup-data-build');
  try {
    const prepared = await buildFullBackupExport(writer, {
      ...options,
      onRiskProgress: releaseActivity.update,
    });
    await writer.drain();
    return prepared;
  } finally {
    releaseActivity();
  }
}

/**
 * 旧版 → 稳定版搬家文件。核心数据与资源补丁写在同一份完成标记 JSON 中：
 * APK 通过原生 MediaStore 小块落盘；桌面网页直接写文件；移动网页先流式写入 OPFS。
 */
export async function downloadMigrationPackage(options = {}) {
  const packageId = createBackupId();
  const native = isNativeShell();
  const mobileWeb = !native && (isIOSDevice() || isAndroidDevice());
  // 移动端文件管理器常不展示自定义 .mmmigrate 文档；Android 厂商
  // 浏览器还可能只在自己的下载记录中显示它。保留 .mmmigrate 识别段，
  // 同时追加标准 .json 扩展名与 MIME；导入仍按 format 内容识别。
  const filename = `marshmallow-move-${timestampForFile()}-${packageId.slice(-6)}.mmmigrate${mobileWeb ? '.json' : ''}`;
  const mimeType = mobileWeb ? 'application/json' : 'application/vnd.marshmallow.migration+json';
  // Android 的系统文件保存器可能在用户选定文件名后先创建 0 B 目标，随后
  // createWritable() 失败。若此时静默回退 OPFS，会留下空文件并再下载一份真包。
  // 手机网页统一先写 OPFS、完成校验后再由一次新手势保存，最终目录只出现一份文件。
  const webSaveTarget = native || mobileWeb
    ? null
    : await beginWebExportTarget(filename, mimeType);
  const opfsTarget = native || webSaveTarget
    ? null
    : await beginOpfsExportTarget(filename, {
      requiredLabel: mobileWeb ? '完整搬家导出' : '',
    });
  if (mobileWeb && !webSaveTarget && !opfsTarget) {
    throw new Error('无法建立低内存搬家导出通道，请改用电脑 Chrome / Edge 导出');
  }
  const writer = native
    ? await beginNativeChunkedTextSave({
      filename,
      mimeType,
      directory: 'downloads',
      onProgress: ({ bytes }) => options.onProgress?.({ phase: 'write', bytes }),
    })
    : (webSaveTarget?.writable || opfsTarget?.writable)
      ? new JsonWritableWriter(webSaveTarget?.writable || opfsTarget.writable)
      : new JsonBlobWriter();
  try {
    const prepared = await writeFullBackupToWriter(writer, {
      migrationPackage: true,
      packageId,
    });
    let saved;
    let blob = null;
    let bytes = Number(writer.sizeEstimate || 0);
    let sha256 = '';
    if (native) {
      saved = await writer.finish();
      bytes = Number(saved?.bytes || 0);
      sha256 = String(saved?.sha256 || '').trim().toLowerCase();
    } else if (webSaveTarget?.writable) {
      await writer.close();
      blob = await webSaveTarget.handle?.getFile?.();
      bytes = Number(blob?.size || bytes);
      saved = { method: 'browser-fs', filename, ok: true };
    } else if (opfsTarget) {
      await writer.close();
      blob = await opfsTarget.handle.getFile();
      bytes = blob.size;
      saved = createDeferredBackupSave(
        blob,
        filename,
        () => removeOpfsExportTarget(opfsTarget),
        { mimeType },
      );
    } else {
      blob = writer.toBlob('application/vnd.marshmallow.migration+json');
      bytes = blob.size;
      writer.release();
      saved = createDeferredBackupSave(blob, filename, null, { mimeType });
    }
    if (!sha256 && blob) {
      await assertMigrationPackageFileEnvelope(blob, packageId);
      sha256 = await sha256Hex(blob, {
        onProgress: ({ loadedBytes, totalBytes }) => options.onProgress?.({
          phase: 'checksum',
          loadedBytes,
          totalBytes,
          bytes,
        }),
      });
    }
    if (bytes <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('搬家包已写入但完整性凭据缺失，请勿使用该文件并重新导出');
    }
    options.onProgress?.({ phase: 'complete', bytes, sha256 });
    return {
      packageId,
      filename,
      bytes,
      sha256,
      counts: prepared.counts,
      assetCounts: prepared.assetCounts,
      assetBytes: prepared.assetBytes,
      exportedAt: prepared.exportedAt,
      saved,
    };
  } catch (error) {
    await writer.abort?.();
    await removeOpfsExportTarget(opfsTarget);
    throw error;
  }
}

/** 生成与手动导出完全相同的数据包，但不触发系统下载。 */
export async function createFullBackupBlob(options = {}) {
  const releaseActivity = await beginBackupExportActivity('backup-data-build');
  try {
    return await createFullBackupBlobInternal({
      ...options,
      onRiskProgress: releaseActivity.update,
    });
  } finally {
    releaseActivity();
  }
}
async function createFullBackupBlobInternal(options = {}) {
  const filename = `marshmallow-phone-backup-${timestampForFile()}.json`;
  if (options.preferFileBacked === true) {
    const target = await beginOpfsExportTarget(`cloud-${createBackupId()}-${filename}`, {
      requiredLabel: options.requireFileBacked === true ? '云备份数据' : '',
    });
    if (target) {
      const writer = new JsonWritableWriter(target.writable);
      try {
        const prepared = await buildFullBackupExport(writer, options);
        await writer.close();
        const blob = await target.handle.getFile();
        return {
          blob,
          filename,
          counts: prepared.counts,
          bytes: blob.size,
          exportedAt: prepared.exportedAt,
          exportMeta: prepared.exportMeta,
          omissions: prepared.omissions,
          cleanup: () => removeOpfsExportTarget(target),
        };
      } catch (err) {
        await writer.abort();
        await removeOpfsExportTarget(target);
        if (options.requireFileBacked === true) {
          throw requiredOpfsTempError('云备份数据', err);
        }
        console.warn('[backup] file-backed cloud data pack unavailable, falling back to memory', err);
      }
    }
    if (options.requireFileBacked === true) {
      throw requiredOpfsTempError('云备份数据');
    }
  }
  const prepared = await buildFullBackupExport(new JsonBlobWriter(), options);
  const blob = prepared.writer.toBlob('application/json;charset=utf-8');
  prepared.writer.release();
  return {
    blob,
    filename,
    counts: prepared.counts,
    bytes: blob.size,
    exportedAt: prepared.exportedAt,
    exportMeta: prepared.exportMeta,
    omissions: prepared.omissions,
  };
}

export async function downloadFullBackup(options = {}) {
  const releaseActivity = await beginBackupExportActivity('backup-data-download');
  try {
    return await downloadFullBackupInternal({
      ...options,
      onRiskProgress: releaseActivity.update,
    });
  } finally {
    releaseActivity();
  }
}

async function downloadFullBackupInternal(options = {}) {
  const filename = `marshmallow-phone-backup-${timestampForFile()}.json`;
  const nativeWriter = isNativeShell()
    ? await beginNativeChunkedTextSave({
      filename,
      mimeType: 'application/json',
      directory: 'downloads',
      onProgress: ({ bytes }) => options.onProgress?.({ phase: 'write', bytes }),
    })
    : null;
  const webSaveTarget = await beginWebExportTarget(filename, 'application/json');
  const deferWebSave = !isNativeShell() && (
    options.deferWebSave === true
      || (options.deferIOSSave === true && isIOSDevice())
  );
  const mobileOpfsTarget = webSaveTarget
    ? null
    : await beginOpfsExportTarget(filename, {
      iosOnly: !deferWebSave,
      requiredLabel: !isNativeShell() && isAndroidDevice() ? '数据包导出' : '',
    });
  const exportWriter = nativeWriter
    || (mobileOpfsTarget
      ? new JsonWritableWriter(mobileOpfsTarget.writable)
      : new JsonBlobWriter());
  let prepared;
  try {
    prepared = await buildFullBackupExport(exportWriter, options);
  } catch (err) {
    await nativeWriter?.abort?.();
    if (mobileOpfsTarget) await exportWriter.abort();
    await removeOpfsExportTarget(mobileOpfsTarget);
    throw err;
  }
  const { writer } = prepared;
  let saved;
  let bytes = writer.sizeEstimate;
  if (nativeWriter) {
    try {
      const result = await nativeWriter.finish();
      bytes = Number(result?.bytes || bytes);
      saved = { method: 'native', filename, ...result, ok: true };
    } catch (err) {
      await nativeWriter.abort?.();
      throw err;
    }
  } else if (webSaveTarget?.writable) {
    await writer.writeToWritable(webSaveTarget.writable);
    saved = { method: 'browser-fs', filename, ok: true };
  } else if (mobileOpfsTarget) {
    await writer.close();
    const file = await mobileOpfsTarget.handle.getFile();
    bytes = file.size;
    if (deferWebSave) {
      saved = createDeferredBackupSave(
        file,
        filename,
        () => removeOpfsExportTarget(mobileOpfsTarget),
      );
    } else {
      try {
        saved = await downloadBlob(file, filename, {
          mimeType: 'application/json',
          directory: 'downloads',
        });
      } finally {
        await removeOpfsExportTarget(mobileOpfsTarget);
      }
    }
  } else {
    const blob = writer.toBlob('application/json;charset=utf-8');
    bytes = blob.size;
    writer.release();
    saved = deferWebSave
      ? createDeferredBackupSave(blob, filename)
      : await downloadBlob(blob, filename, {
        mimeType: 'application/json',
        directory: 'downloads',
      });
  }
  return {
    counts: prepared.counts,
    bytes,
    exportedAt: prepared.exportedAt,
    saved,
    exportMeta: prepared.exportMeta,
    omissions: prepared.omissions,
  };
}
async function appendAssetCollectionsToWriter(writer, { allowEmpty = false } = {}) {
  const rows = await appendMappedStoreArray(
    writer,
    'rows',
    'settings',
    (row) => normalizeExportRow('settings', row, null, 'assets'),
  );
  writer.write(',');
  await yieldToUi();
  const characterAssets = await appendMappedStoreArray(
    writer,
    'characterAssets',
    'characters',
    extractCharacterAssetRow,
  );
  writer.write(',');
  await yieldToUi();
  const userAssets = await appendMappedStoreArray(
    writer,
    'userAssets',
    'users',
    extractUserAssetRow,
  );
  writer.write(',');
  await yieldToUi();
  const chatAssets = await appendMappedStoreArray(
    writer,
    'chatAssets',
    'chats',
    extractChatAssetRow,
  );
  writer.write(',');
  await yieldToUi();
  const beautifyAssets = await appendMappedStoreArray(
    writer,
    'beautifyAssets',
    'beautifyAssets',
    (row) => row,
  );
  writer.write(',');
  await yieldToUi();
  const musicAssets = await appendMusicAssetsToWriter(writer);
  writer.write(',');
  await yieldToUi();
  const soundAssets = await appendSoundAssetsToWriter(writer);
  if (!allowEmpty && !rows && !characterAssets && !userAssets && !chatAssets && !beautifyAssets && !musicAssets && !soundAssets) {
    throw new Error('没有可导出的资源包（语音缓存、壁纸、头像、聊天壁纸、本地音乐、音频库等）');
  }
  return {
    rows,
    characterAssets,
    userAssets,
    chatAssets,
    beautifyAssets,
    musicAssets,
    soundAssets,
  };
}

async function buildAssetBackupExport({ allowEmpty = false, writer = new JsonBlobWriter() } = {}) {
  const exportedAt = new Date().toISOString();
  writer.write('{');
  writer.write(`"format":${JSON.stringify(BACKUP_ASSET_FORMAT)},`);
  writer.write(`"version":${BACKUP_VERSION},`);
  writer.write('"app":"marshmallow-phone",');
  writer.write(`"exportedAt":${JSON.stringify(exportedAt)},`);
  const assets = await appendAssetCollectionsToWriter(writer, { allowEmpty });
  writer.write(',');
  writer.write(`"exportMeta":${JSON.stringify(buildAssetBackupPayload().exportMeta)}`);
  writer.write('}');
  return {
    writer,
    ...assets,
    exportedAt,
  };
}

/** 生成与手动导出完全相同的资源包，但不触发系统下载。 */
export async function createAssetBackupBlob(options = {}) {
  const releaseActivity = await beginBackupExportActivity('backup-assets-build');
  try {
    return await createAssetBackupBlobInternal(options);
  } finally {
    releaseActivity();
  }
}

async function createAssetBackupBlobInternal(options = {}) {
  const filename = `marshmallow-backup-assets-${timestampForFile()}.json`;
  if (options.preferFileBacked === true) {
    const target = await beginOpfsExportTarget(`cloud-${createBackupId()}-${filename}`, {
      requiredLabel: options.requireFileBacked === true ? '云备份资源' : '',
    });
    if (target) {
      const writer = new JsonWritableWriter(target.writable);
      try {
        const prepared = await buildAssetBackupExport({ allowEmpty: true, writer });
        await writer.close();
        const blob = await target.handle.getFile();
        return {
          blob,
          filename,
          rows: prepared.rows,
          characterAssets: prepared.characterAssets,
          userAssets: prepared.userAssets,
          chatAssets: prepared.chatAssets,
          beautifyAssets: prepared.beautifyAssets,
          musicAssets: prepared.musicAssets,
          soundAssets: prepared.soundAssets,
          empty: !prepared.rows
            && !prepared.characterAssets
            && !prepared.userAssets
            && !prepared.chatAssets
            && !prepared.beautifyAssets
            && !prepared.musicAssets
            && !prepared.soundAssets,
          bytes: blob.size,
          exportedAt: prepared.exportedAt,
          cleanup: () => removeOpfsExportTarget(target),
        };
      } catch (err) {
        await writer.abort();
        await removeOpfsExportTarget(target);
        if (options.requireFileBacked === true) {
          throw requiredOpfsTempError('云备份资源', err);
        }
        console.warn('[backup] file-backed cloud asset pack unavailable, falling back to memory', err);
      }
    }
    if (options.requireFileBacked === true) {
      throw requiredOpfsTempError('云备份资源');
    }
  }
  const prepared = await buildAssetBackupExport({ allowEmpty: true });
  const blob = prepared.writer.toBlob('application/json;charset=utf-8');
  prepared.writer.release();
  return {
    blob,
    filename,
    rows: prepared.rows,
    characterAssets: prepared.characterAssets,
    userAssets: prepared.userAssets,
    chatAssets: prepared.chatAssets,
    beautifyAssets: prepared.beautifyAssets,
    musicAssets: prepared.musicAssets,
    soundAssets: prepared.soundAssets,
    empty: !prepared.rows
      && !prepared.characterAssets
      && !prepared.userAssets
      && !prepared.chatAssets
      && !prepared.beautifyAssets
      && !prepared.musicAssets
      && !prepared.soundAssets,
    bytes: blob.size,
    exportedAt: prepared.exportedAt,
  };
}

export async function downloadAssetBackup(options = {}) {
  const releaseActivity = await beginBackupExportActivity('backup-assets-download');
  try {
    return await downloadAssetBackupInternal(options);
  } finally {
    releaseActivity();
  }
}

async function downloadAssetBackupInternal(options = {}) {
  const ts = timestampForFile();
  const filename = `marshmallow-backup-assets-${ts}.json`;
  const nativeWriter = isNativeShell()
    ? await beginNativeChunkedTextSave({
      filename,
      mimeType: 'application/json',
      directory: 'downloads',
      onProgress: ({ bytes }) => options.onProgress?.({ phase: 'write', bytes }),
    })
    : null;
  const webSaveTarget = await beginWebExportTarget(filename, 'application/json');
  const deferWebSave = !isNativeShell() && (
    options.deferWebSave === true
      || (options.deferIOSSave === true && isIOSDevice())
  );
  const mobileOpfsTarget = webSaveTarget
    ? null
    : await beginOpfsExportTarget(filename, {
      iosOnly: !deferWebSave,
      requiredLabel: !isNativeShell() && isAndroidDevice() ? '资源包导出' : '',
    });
  const exportWriter = nativeWriter
    || (mobileOpfsTarget
      ? new JsonWritableWriter(mobileOpfsTarget.writable)
      : new JsonBlobWriter());
  let prepared;
  try {
    prepared = await buildAssetBackupExport({ writer: exportWriter });
  } catch (err) {
    await nativeWriter?.abort?.();
    if (mobileOpfsTarget) await exportWriter.abort();
    await removeOpfsExportTarget(mobileOpfsTarget);
    throw err;
  }
  const { writer } = prepared;
  let saved;
  let bytes = writer.sizeEstimate;
  if (nativeWriter) {
    try {
      const result = await nativeWriter.finish();
      bytes = Number(result?.bytes || bytes);
      saved = { method: 'native', filename, ...result, ok: true };
    } catch (err) {
      await nativeWriter.abort?.();
      throw err;
    }
  } else if (webSaveTarget?.writable) {
    await writer.writeToWritable(webSaveTarget.writable);
    saved = { method: 'browser-fs', filename, ok: true };
  } else if (mobileOpfsTarget) {
    await writer.close();
    const file = await mobileOpfsTarget.handle.getFile();
    bytes = file.size;
    if (deferWebSave) {
      saved = createDeferredBackupSave(
        file,
        filename,
        () => removeOpfsExportTarget(mobileOpfsTarget),
      );
    } else {
      try {
        saved = await downloadBlob(file, filename, {
          mimeType: 'application/json',
          directory: 'downloads',
        });
      } finally {
        await removeOpfsExportTarget(mobileOpfsTarget);
      }
    }
  } else {
    const blob = writer.toBlob('application/json;charset=utf-8');
    bytes = blob.size;
    writer.release();
    saved = deferWebSave
      ? createDeferredBackupSave(blob, filename)
      : await downloadBlob(blob, filename, {
        mimeType: 'application/json',
        directory: 'downloads',
      });
  }
  return {
    rows: prepared.rows,
    characterAssets: prepared.characterAssets,
    userAssets: prepared.userAssets,
    chatAssets: prepared.chatAssets,
    musicAssets: prepared.musicAssets,
    soundAssets: prepared.soundAssets,
    bytes,
    exportedAt: prepared.exportedAt,
    saved,
  };
}

async function buildRegionBackupPlan({
  regionIds = null,
  partTargetBytes = REGION_PART_TARGET_BYTES,
} = {}) {
  const backupId = createBackupId();
  const exportedAt = new Date().toISOString();
  const allRegions = getCoreBackupRegions();
  const selected = Array.isArray(regionIds) && regionIds.length
    ? new Set(regionIds.map((id) => String(id || '').trim()).filter(Boolean))
    : null;
  const regions = selected
    ? allRegions.filter((region) => selected.has(region.id))
    : allRegions;
  if (!regions.length) throw new Error('未选择任何区域');
  const tracker = createExportOmissionTracker();
  const files = [];
  const counts = {};

  for (const region of regions) {
    const planner = createBackupRegionPartPlanner(partTargetBytes);
    let regionRows = 0;
    for (const storeName of region.stores) {
      const segment = storeName === 'settings' ? 'core' : null;
      await db.forEachStoreRecordBatched(storeName, (row, _index, _name, key) => {
        const normalized = normalizeExportRow(storeName, row, tracker, segment);
        if (!normalized) return;
        const clean = stripRegionBackupAssets(storeName, normalized);
        const bytes = utf8ByteLength(JSON.stringify({ store: storeName, row: clean })) + 1;
        planner.add(storeName, key, bytes);
        regionRows += 1;
      }, {
        batchSize: 12,
        onBatch: yieldToUi,
      });
    }
    const parts = planner.finish();
    if (!parts.length) parts.push({ ranges: [], bytes: 0, rows: 0 });
    counts[region.id] = regionRows;
    for (let i = 0; i < parts.length; i += 1) {
      files.push({
        name: `marshmallow-backup-${timestampForFile(new Date(exportedAt))}-${region.id}${parts.length > 1 ? `-part${String(i + 1).padStart(2, '0')}` : ''}.json`,
        region: region.id,
        regionLabel: region.label,
        part: i + 1,
        partsTotal: parts.length,
        rows: parts[i].rows,
        estimatedBytes: parts[i].bytes,
        ranges: parts[i].ranges,
      });
    }
  }
  return {
    backupId,
    exportedAt,
    files,
    counts,
    partTargetBytes,
    omissions: summarizeExportOmissions(tracker),
  };
}

async function prepareRegionBackupFile(plan, fileSpec, options = {}) {
  const allRegions = getCoreBackupRegions();
  const region = allRegions.find((item) => item.id === fileSpec.region);
  if (!region) throw new Error(`未知区域：${fileSpec.region}`);
  const tempName = `region-${plan.backupId}-${fileSpec.name}`;
  let opfsTarget = null;
  try {
    opfsTarget = await beginOpfsExportTarget(tempName, {
      requiredLabel: !isNativeShell() && isAndroidDevice() ? '区域备份' : '',
    });
  } catch (error) {
    if (options.allowMemoryFallback !== true || !isOpfsCapabilityError(error)) throw error;
    console.warn('[backup] OPFS unavailable; using one small in-memory rescue region', error);
  }
  const writer = opfsTarget ? new JsonWritableWriter(opfsTarget.writable) : new JsonBlobWriter();
  let rows = 0;
  try {
    writer.write('{');
    writer.write(`"format":${JSON.stringify(REGION_BACKUP_FORMAT)},`);
    writer.write(`"version":${REGION_BACKUP_VERSION},`);
    writer.write('"app":"marshmallow-phone",');
    writer.write(`"backupId":${JSON.stringify(plan.backupId)},`);
    writer.write(`"exportedAt":${JSON.stringify(plan.exportedAt)},`);
    writer.write(`"region":${JSON.stringify(fileSpec.region)},`);
    writer.write(`"regionLabel":${JSON.stringify(fileSpec.regionLabel)},`);
    writer.write(`"coreRegions":${JSON.stringify(allRegions.map((item) => item.id))},`);
    writer.write(`"part":${fileSpec.part},"partsTotal":${fileSpec.partsTotal},`);
    writer.write('"stores":{');
    for (let storeIndex = 0; storeIndex < region.stores.length; storeIndex += 1) {
      const storeName = region.stores[storeIndex];
      if (storeIndex) writer.write(',');
      writer.write(`${JSON.stringify(storeName)}:[`);
      let first = true;
      const ranges = (fileSpec.ranges || []).filter((range) => range.store === storeName);
      for (const range of ranges) {
        await db.forEachStoreRecordBatched(storeName, async (row) => {
          const segment = storeName === 'settings' ? 'core' : null;
          const normalized = normalizeExportRow(storeName, row, null, segment);
          if (!normalized) return;
          writer.write(first ? '' : ',');
          await appendJsonValueToWriter(writer, stripRegionBackupAssets(storeName, normalized));
          first = false;
          rows += 1;
          if (writer.shouldDrain) await writer.drain();
        }, {
          batchSize: 12,
          startKey: range.startKey,
          endKey: range.endKey,
          onBatch: yieldToUi,
        });
      }
      writer.write(']');
      if (writer.shouldDrain) await writer.drain();
    }
    writer.write('}}');
    if (rows !== Number(fileSpec.rows || 0)) {
      throw new Error('区域备份预检后数据发生变化，请重新开始导出');
    }
    if (opfsTarget) {
      await writer.close();
      return { file: await opfsTarget.handle.getFile(), opfsTarget };
    }
    const file = writer.toBlob('application/json;charset=utf-8');
    writer.release();
    return { file, opfsTarget: null };
  } catch (error) {
    await writer.abort?.();
    await removeOpfsExportTarget(opfsTarget);
    throw error;
  }
}

function selectRegionBackupPlan(preview, regionIds = null) {
  const selected = Array.isArray(regionIds) && regionIds.length
    ? new Set(regionIds.map((id) => String(id || '').trim()).filter(Boolean))
    : null;
  const specs = (preview.files || []).filter((file) => !selected || selected.has(file.region));
  const counts = Object.fromEntries(
    Object.entries(preview.counts || {}).filter(([regionId]) => !selected || selected.has(regionId)),
  );
  if (!specs.length) throw new Error('未选择任何区域');
  return { ...preview, files: specs, counts };
}

/**
 * Prepare independent region files. The caller saves each file from a distinct
 * click, which keeps iOS system sharing and Android browser downloads reliable.
 */
export async function previewRegionBackup(options = {}) {
  return buildRegionBackupPlan(options);
}

export async function downloadRegionBackup(options = {}) {
  const sourcePlan = options.preview?.files
    ? options.preview
    : await buildRegionBackupPlan(options);
  const prepared = selectRegionBackupPlan(sourcePlan, options.regionIds);
  const fileSpecs = prepared.files;
  const publicFiles = fileSpecs.map(({ ranges: _ranges, ...file }) => file);
  let index = 0;
  let ready = null;

  const prepareNext = async () => {
    if (ready || index >= fileSpecs.length) return ready;
    ready = await prepareRegionBackupFile(prepared, fileSpecs[index], {
      allowMemoryFallback: options.allowMemoryFallback === true,
    });
    return ready;
  };
  const discard = async () => {
    if (!ready) return;
    const current = ready;
    ready = null;
    await removeOpfsExportTarget(current.opfsTarget);
  };

  await prepareNext();
  return {
    ...prepared,
    files: publicFiles,
    prepareNext,
    discard,
    async next() {
      const file = publicFiles[index];
      if (!file || !ready) return null;
      const current = ready;
      const saved = await downloadBlob(current.file, file.name, {
        mimeType: 'application/json',
        directory: 'downloads',
      });
      ready = null;
      index += 1;
      if (current.opfsTarget) {
        if (saved?.method === 'browser') {
          setTimeout(() => {
            void removeOpfsExportTarget(current.opfsTarget);
          }, BROWSER_DOWNLOAD_RELEASE_DELAY_MS + 1000);
        } else {
          await removeOpfsExportTarget(current.opfsTarget);
        }
      }
      return {
        ...file,
        saved,
        completed: index,
        total: prepared.files.length,
        remaining: prepared.files.length - index,
      };
    },
  };
}

const ASSET_PATCH_BATCH_SIZE = 200;

/**
 * 资源补丁类分片（角色/用户/聊天的头像、壁纸等）导入。
 * 原来是逐条 getRecord → merge → putRecord，一条记录两次独立事务，角色/聊天多的时候非常慢；
 * 改成按批用同一个只读事务批量取 existing，再一次性 putMany 写回。
 */
async function importAssetPatchRows(storeName, rows, mergeFn, options = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return 0;
  const patchesById = new Map();
  for (const patch of list) {
    const id = String(patch?.id || '').trim();
    if (!id) continue;
    patchesById.set(id, patch);
  }
  const ids = [...patchesById.keys()];
  if (!ids.length) return 0;

  let written = 0;
  for (let i = 0; i < ids.length; i += ASSET_PATCH_BATCH_SIZE) {
    const idChunk = ids.slice(i, i + ASSET_PATCH_BATCH_SIZE);
    const existingChunk = await db.getMany(storeName, idChunk);
    const merged = [];
    for (let j = 0; j < idChunk.length; j += 1) {
      const existing = existingChunk[j];
      if (!existing) continue;
      const mergedRow = mergeFn(existing, patchesById.get(idChunk[j]));
      if (mergedRow) merged.push(mergedRow);
    }
    if (merged.length) {
      await db.putMany(storeName, merged, { batchSize: merged.length });
      written += merged.length;
    }
    emitBackupImportProgress({
      phase: 'store',
      storeName,
      rows: written,
      totalRows: ids.length,
      mode: options.mode || 'merge',
      assetPack: true,
    });
    await yieldToUi();
  }
  return written;
}

async function importCharacterAssetRows(rows, options = {}) {
  return importAssetPatchRows('characters', rows, mergeCharacterAssetRow, options);
}

async function importUserAssetRows(rows, options = {}) {
  return importAssetPatchRows('users', rows, mergeUserAssetRow, options);
}

async function importChatAssetRows(rows, options = {}) {
  return importAssetPatchRows('chats', rows, mergeChatAssetRow, options);
}

async function importMusicAssetRows(rows, options = {}) {
  return importAssetPatchRows('musicTracks', rows, mergeMusicAssetRow, options);
}

async function importSoundAssetRows(rows, options = {}) {
  return importAssetPatchRows('soundAssets', rows, mergeSoundAssetRow, options);
}

async function importBackupPartPayload(payload, options = {}, state = {}) {
  const mode = options.mode === 'merge' ? 'merge' : 'replace';
  const storeName = payload.store;
  if (payload.store === 'characters' && payload.segment === 'assets') {
    return importCharacterAssetRows(payload.rows, options);
  }
  if (!db.STORES[storeName]) return 0;
  const rawRows = Array.isArray(payload.rows) ? payload.rows.filter(Boolean) : [];
  const records = storeName === 'settings'
    ? rawRows.map((row) => normalizeBackupStoreRow(storeName, row, {
      assetImport: payload.segment === 'assets',
    })).filter(Boolean)
    : rawRows;
  if (mode === 'replace' && !state.clearedStores?.has(storeName)) {
    if (!state.clearedStores) state.clearedStores = new Set();
    await db.clearStore(storeName);
    state.clearedStores.add(storeName);
  }
  if (!records.length) return 0;
  return writeRowsToDb(storeName, records, options);
}

export async function importAssetBackupPayload(payload, options = {}) {
  if (!isBackupAssetPayload(payload)) {
    const detected = typeof payload?.format === 'string' ? payload.format : '未识别格式';
    throw new Error(`不是棉花糖机资源包（识别到：${detected}）`);
  }
  const rows = Array.isArray(payload.rows) ? payload.rows.filter(Boolean) : [];
  const characterAssets = Array.isArray(payload.characterAssets) ? payload.characterAssets.filter(Boolean) : [];
  const userAssets = Array.isArray(payload.userAssets) ? payload.userAssets.filter(Boolean) : [];
  const chatAssets = Array.isArray(payload.chatAssets) ? payload.chatAssets.filter(Boolean) : [];
  const beautifyAssets = Array.isArray(payload.beautifyAssets) ? payload.beautifyAssets.filter(Boolean) : [];
  const musicAssets = Array.isArray(payload.musicAssets) ? payload.musicAssets.filter(Boolean) : [];
  const soundAssets = Array.isArray(payload.soundAssets) ? payload.soundAssets.filter(Boolean) : [];
  if (!rows.length && !characterAssets.length && !userAssets.length && !chatAssets.length && !beautifyAssets.length && !musicAssets.length && !soundAssets.length) {
    throw new Error('资源包为空');
  }
  const records = rows.map((row) => normalizeBackupSettingsRow(row, { assetImport: true })).filter(Boolean);
  if (rows.length && !records.length && !characterAssets.length && !userAssets.length && !chatAssets.length && !beautifyAssets.length && !musicAssets.length && !soundAssets.length) {
    throw new Error('资源包内没有可写入的有效项（语音缓存、壁纸、头像、聊天壁纸、本地音乐、音频库等）');
  }
  emitBackupImportProgress({
    phase: 'start',
    mode: 'merge',
    assetPack: true,
    totalRows: records.length + characterAssets.length + userAssets.length + chatAssets.length + beautifyAssets.length + musicAssets.length + soundAssets.length,
  });
  db.setSuppressWriteNotify(true);
  try {
    let settingsWritten = 0;
    if (records.length) {
      settingsWritten = await writeRowsToDb('settings', records, { mode: 'merge' });
    }
    const charactersWritten = await importCharacterAssetRows(characterAssets, { mode: 'merge' });
    const usersWritten = await importUserAssetRows(userAssets, { mode: 'merge' });
    const chatsWritten = await importChatAssetRows(chatAssets, { mode: 'merge' });
    const beautifyAssetsWritten = await writeRowsToDb('beautifyAssets', beautifyAssets, { mode: 'merge' });
    const musicTracksWritten = await importMusicAssetRows(musicAssets, { mode: 'merge' });
    const soundAssetsWritten = await importSoundAssetRows(soundAssets, { mode: 'merge' });
    emitBackupImportProgress({
      phase: 'complete',
      counts: {
        settings: settingsWritten,
        characters: charactersWritten,
        users: usersWritten,
        chats: chatsWritten,
        beautifyAssets: beautifyAssetsWritten,
        musicTracks: musicTracksWritten,
        soundAssets: soundAssetsWritten,
      },
      mode: 'merge',
      assetPack: true,
    });
    return {
      mode: 'merge',
      counts: {
        settings: settingsWritten,
        characters: charactersWritten,
        users: usersWritten,
        chats: chatsWritten,
        beautifyAssets: beautifyAssetsWritten,
        musicTracks: musicTracksWritten,
        soundAssets: soundAssetsWritten,
      },
    };
  } finally {
    db.setSuppressWriteNotify(false);
    db.flushWriteListeners();
  }
}

export async function importBackupPartFiles(files, options = {}) {
  const sources = [...files].filter(Boolean).map((file) => ({
    name: file?.name,
    readText: () => readFileAsText(file),
  }));
  return importBackupPartSources(sources, options);
}

export async function importFullBackupPayload(payload, options = {}) {
  const normalizedPayload = normalizeLegacyEmergencyBackupPayload(payload);
  assertBackupPayload(normalizedPayload);
  const mode = options.mode === 'merge' ? 'merge' : 'replace';
  const subsetReplace = options.subsetReplace === true;
  const incoming = normalizedPayload.stores || {};
  const knownStoreNames = Object.keys(db.STORES);
  const storeNames = Object.keys(incoming)
    .filter((name) => db.STORES[name] && Array.isArray(incoming[name]));
  const replacePlan = buildReplaceStorePlan(storeNames, knownStoreNames);
  const explicitlyEmptyStores = new Set(
    storeNames.filter((storeName) => incoming[storeName].length === 0),
  );

  const prepared = {};
  for (const storeName of storeNames) {
    const rawRecords = Array.isArray(incoming[storeName]) ? incoming[storeName].filter(Boolean) : [];
    const records = storeName === 'settings'
      ? rawRecords.map((row) => normalizeBackupStoreRow(storeName, row)).filter(Boolean)
      : rawRecords;
    prepared[storeName] = records;
  }
  const totalRows = countIncomingBackupRows(prepared);

  if (mode === 'replace' && !subsetReplace && totalRows <= 0) {
    throw new Error('备份里没有可写入的数据，已中止导入以免清空现有数据');
  }
  if (subsetReplace && totalRows <= 0) {
    throw new Error('所选区域备份为空，已取消导入');
  }

  db.setSuppressWriteNotify(true);
  try {
    emitBackupImportProgress({ phase: 'start', mode, fastPath: true, subsetReplace });
    const counts = {};
    for (const storeName of storeNames) {
      const records = prepared[storeName] || [];
      counts[storeName] = records.length;
      if (!records.length && !explicitlyEmptyStores.has(storeName)) continue;
      emitBackupImportProgress({
        phase: 'store-start',
        storeName,
        rows: 0,
        totalRows: records.length,
        mode,
        fastPath: true,
      });
      if (mode === 'replace') {
        await db.clearStore(storeName);
      }
      if (records.length) await writeRowsToDb(storeName, records, { mode });
    }
    emitBackupImportProgress({ phase: 'complete', counts, mode, fastPath: true, subsetReplace });
    return {
      mode,
      counts,
      subsetReplace,
      preservedMissingStores: mode === 'replace' ? replacePlan.preserve : [],
    };
  } finally {
    db.setSuppressWriteNotify(false);
    db.flushWriteListeners();
  }
}

function isRegionBackupPayload(payload) {
  return payload
    && typeof payload === 'object'
    && payload.format === REGION_BACKUP_FORMAT
    && typeof payload.backupId === 'string'
    && typeof payload.region === 'string'
    && Array.isArray(payload.coreRegions)
    && payload.stores
    && typeof payload.stores === 'object';
}

async function readRegionBackupSources(files) {
  const sources = [];
  for (const file of [...files].filter(Boolean)) {
    if (/\.zip$/i.test(String(file?.name || ''))) {
      const entries = await readJsonEntriesFromZip(file);
      for (const entry of entries) sources.push({ name: entry.name, readText: () => Promise.resolve(entry.text) });
      continue;
    }
    sources.push({ name: file?.name, readText: () => readFileAsText(file) });
  }
  return sources;
}

export async function importRegionBackupFiles(files, options = {}) {
  const sources = await readRegionBackupSources(files);
  if (!sources.length) throw new Error('未选择区域备份文件');
  const payloads = [];
  for (const source of sources) {
    let payload;
    try {
      payload = JSON.parse(await source.readText());
    } catch (_) {
      throw new Error(`${source.name || '备份'} 不是合法 JSON`);
    }
    if (!isRegionBackupPayload(payload)) continue;
    payloads.push(payload);
  }
  if (!payloads.length) throw new Error('未找到有效的区域备份文件');
  const first = payloads[0];
  const manifest = {
    format: REGION_BACKUP_FORMAT,
    backupId: first.backupId,
    coreRegions: first.coreRegions,
  };
  let validation = validateRegionBackupManifest(manifest, payloads);
  if (!validation.ok) {
    validation = validateRegionBackupManifest(manifest, payloads, { allowPartial: true });
  }
  if (!validation.ok) {
    const problems = [...(validation.missing || []), ...(validation.invalid || [])];
    const suffix = problems.length ? `：${problems.join('、')}` : '';
    throw new Error(`区域备份不完整，已取消导入${suffix}`);
  }
  const partialImport = validation.partial === true;
  const uniqueParts = new Set();
  for (const payload of payloads) {
    if (payload.backupId !== first.backupId) throw new Error('选择了不同批次的区域备份，请只选择同一次导出的文件');
    const key = `${payload.region}:${payload.part || 1}`;
    if (uniqueParts.has(key)) throw new Error(`区域备份包含重复分片：${payload.region} ${payload.part || 1}`);
    uniqueParts.add(key);
  }

  const stores = {};
  for (const payload of payloads) {
    for (const [storeName, rows] of Object.entries(payload.stores || {})) {
      if (!db.STORES[storeName]) continue;
      if (!stores[storeName]) stores[storeName] = [];
      if (Array.isArray(rows)) stores[storeName].push(...rows);
    }
  }
  return importFullBackupPayload({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    stores,
  }, {
    ...options,
    mode: 'replace',
    subsetReplace: partialImport,
  });
}

export async function importFullBackupFiles(files, options = {}) {
  return runStorageMaintenanceExclusive('备份导入', async () => {
    const releaseActivity = beginCriticalActivity('backup-import');
    try {
      const result = await importFullBackupFilesInternal(files, options);
      return await finalizeImportedUserSlots(result, options);
    } finally {
      releaseActivity();
    }
  }, { ifAvailable: true });
}

export async function importBeautifyAssetsSupplement(file, options = {}) {
  return runStorageMaintenanceExclusive('美化资源续导', async () => {
    const releaseActivity = beginCriticalActivity('backup-import');
    try {
      return await importBeautifyAssetsSupplementStreaming(file, options);
    } finally {
      releaseActivity();
    }
  }, { ifAvailable: true });
}

async function finalizeImportedUserSlots(result, options = {}) {
  const effectiveMode = result?.mode || (options.mode === 'merge' ? 'merge' : 'replace');
  if (effectiveMode !== 'replace') return result;
  try {
    const mod = await import('./user-slot.js');
    const userSlots = await mod.reconcileUserSlotsAfterImport();
    return { ...result, userSlots };
  } catch (error) {
    throw new Error(`备份数据已写入，但档位索引修复失败：${error?.message || error}`);
  }
}

async function importFullBackupFilesInternal(files, options = {}) {
  const list = [...files].filter(Boolean);
  if (!list.length) throw new Error('未选择文件');
  if (list.length === 1) return importFullBackupFileInternal(list[0], options);
  const firstText = await readFileAsText(list[0]);
  let firstPayload = null;
  try {
    firstPayload = JSON.parse(firstText);
  } catch (_) {
    throw new Error('首个文件不是合法 JSON');
  }
  if (isRegionBackupPayload(firstPayload)) {
    return importRegionBackupFiles(list, options);
  }
  if (isBackupPartPayload(firstPayload)) {
    return importBackupPartFiles(list, options);
  }
  throw new Error('选择了多个文件，但不是分片备份格式；请一次只选一个完整备份，或选择全套分片文件');
}

export async function importFullBackupFile(file, options = {}) {
  return runStorageMaintenanceExclusive('备份导入', async () => {
    const releaseActivity = beginCriticalActivity('backup-import');
    try {
      const result = await importFullBackupFileInternal(file, options);
      return await finalizeImportedUserSlots(result, options);
    } finally {
      releaseActivity();
    }
  }, { ifAvailable: true });
}

async function importFullBackupFileInternal(file, options = {}) {
  const name = String(file?.name || '');
  const size = Number(file?.size || 0);
  const isLegacyEmergencyFile = /^marshmallow-emergency(?:-|\.|$)/i.test(name);
  if (!(size > 0)) {
    throw new Error('文件大小为 0，可能是云盘占位文件尚未下完，请先下载到本地再导入');
  }
  if (/\.zip$/i.test(name)) {
    const entries = await readJsonEntriesFromZip(file);
    if (!entries.length) throw new Error('ZIP 内未找到 JSON 分片');
    // 条目文本已经在内存里，直接喂给共用管线；不再套一层虚拟 File 再用 FileReader 读一遍。
    const sources = entries.map((entry) => ({
      name: entry.name,
      readText: () => Promise.resolve(entry.text),
    }));
    return importBackupPartSources(sources, options);
  }
  // 档位归档只包含一个档位的子集。无论用户从「完整搬家」还是
  // 「高级导入」选它，都必须强制合并，绝不能用子集替换整库。
  let slotArchiveFile = false;
  try {
    const probe = await file.slice(0, Math.min(size, 128 * 1024)).text();
    slotArchiveFile = /"slotArchive"\s*:/.test(probe);
  } catch (_) {}
  const effectiveOptions = slotArchiveFile ? { ...options, mode: 'merge' } : options;
  // iOS / Android 会把所有 JSON 强制交给低内存流式解析器；区域分区有自己的
  // 顶层格式，必须在这之前按内容分流，否则单独导入 identity 等小分区时会被
  // 完整备份解析器误报为“不是棉花糖机完整备份”。
  let regionBackupFile = false;
  try {
    const probe = await file.slice(0, Math.min(size, 96 * 1024)).text();
    regionBackupFile = /"format"\s*:\s*"marshmallow-phone-backup-region"/.test(probe);
  } catch (_) {}
  if (regionBackupFile) return importRegionBackupFiles([file], effectiveOptions);
  // 资源备份在移动端或体积较大时同样必须流式读取。先识别格式并固定使用合并
  // 语义，避免落入完整备份流式导入器后在文件末尾误报“没有可写入的数据表”。
  const assetPackageFile = !isLegacyEmergencyFile && await isAssetBackupFile(file);
  if (assetPackageFile) return importAssetBackupStreaming(file);
  // 系统分享、网盘或文件管理器可能把 .mmmigrate 改名为 .json 或去掉后缀。
  // 搬家包必须按内容识别并走“先完整预检、再替换”的流式路径，不能因文件名
  // 和体积较小就落入普通 JSON 导入，否则会误报“不是完整备份”。
  const migrationPackageFile = !isLegacyEmergencyFile && await isMigrationPackageFile(file);
  // 旧急救包使用另一套顶层标记，需先完整解析并转换；旧版最多导出 8000 条消息。
  if (!isLegacyEmergencyFile && (migrationPackageFile || shouldUseStreamingBackupImport(file))) {
    return importFullBackupStreaming(file, effectiveOptions);
  }
  const text = await readFileAsText(file);
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (_) {
    throw new Error('备份文件不是合法 JSON');
  }
  if (isBackupAssetPayload(payload)) {
    return importAssetBackupPayload(payload, effectiveOptions);
  }
  if (isBackupPartPayload(payload)) {
    return importBackupPartFiles([file], options);
  }
  if (isRegionBackupPayload(payload)) {
    return importRegionBackupFiles([file], options);
  }
  return importFullBackupPayload(payload, effectiveOptions);
}

export async function importAssetBackupFile(file) {
  if (shouldUseStreamingBackupImport(file)) {
    return importAssetBackupStreaming(file);
  }
  const text = await readFileAsText(file);
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (_) {
    throw new Error('资源包不是合法 JSON');
  }
  return importAssetBackupPayload(payload, { mode: 'merge' });
}

export {
  emitBackupImportProgress,
  shouldUseStreamingBackupImport,
  formatExportOmissionHint,
};
