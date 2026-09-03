import * as db from './db.js';
import { importFullBackupFiles, writeFullBackupToWriter } from './backup.js';

const SLOT_FILES = [
  'marshmallow-browser-safety-a.mmmigrate.json',
  'marshmallow-browser-safety-b.mmmigrate.json',
];
const META_KEY = '__mm_browser_safety_backup_v1__';
const MIN_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const BOOT_BACKUP_DELAY_MS = 15 * 1000;
const WRITE_QUIET_DELAY_MS = 2 * 60 * 1000;
const BUSY_RETRY_DELAY_MS = 60 * 1000;
const FAILED_RETRY_DELAY_MS = 15 * 60 * 1000;
const STREAM_BUFFER_CHARS = 96 * 1024;
const MAX_AUTOMATIC_BACKUP_BYTES = 512 * 1024 * 1024;
const CRITICAL_STORES = ['characters', 'chats', 'messages', 'users', 'settings'];

let installed = false;
let running = false;
let dirty = true;
let timer = 0;
let removeWriteListeners = [];

function isNativeShell() {
  try {
    if (window.Capacitor?.isNativePlatform?.()) return true;
    return String(window.Capacitor?.getPlatform?.() || '').toLowerCase() !== 'web';
  } catch (_) {
    return false;
  }
}

export function supportsBrowserSafetyBackup() {
  return typeof window !== 'undefined'
    && !isNativeShell()
    && !!navigator.storage
    && typeof navigator.storage.getDirectory === 'function';
}

function readMeta() {
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeMeta(meta) {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta || {})); } catch (_) {}
}

async function readCriticalInventory() {
  const entries = await Promise.all(CRITICAL_STORES.map(async (storeName) => [
    storeName,
    Number(await db.countRecords(storeName)) || 0,
  ]));
  return Object.fromEntries(entries);
}

function criticalRecordCount(counts = {}) {
  return CRITICAL_STORES.reduce((sum, name) => sum + Number(counts[name] || 0), 0);
}

function hasMeaningfulUserData(counts = {}) {
  return Number(counts.characters || 0) > 0
    || Number(counts.chats || 0) > 0
    || Number(counts.messages || 0) > 0;
}

function isSuspiciousShrink(currentCount, previousCount) {
  const current = Number(currentCount || 0);
  const previous = Number(previousCount || 0);
  return previous >= 20 && current < Math.max(3, Math.floor(previous * 0.35));
}

function isBusy() {
  if (typeof document !== 'undefined' && document.hidden) return true;
  const safety = globalThis.__mm_update_safety_state__;
  if (Number(safety?.criticalCount || 0) > 0) return true;
  if (Number(globalThis.__mm_chat_generation_active__ || 0) > 0) return true;
  if (Number(globalThis.__mm_manual_generation_active__ || 0) > 0) return true;
  return false;
}

class OpfsSafetyBackupWriter {
  constructor(writable) {
    this.writable = writable;
    this.buffer = '';
    this.bytes = 0;
    this.sizeEstimate = 0;
    this.encoder = new TextEncoder();
    this.isStreaming = true;
  }

  write(text) {
    if (!text) return;
    this.buffer += text;
    this.sizeEstimate += String(text).length;
  }

  get shouldDrain() {
    return this.buffer.length >= STREAM_BUFFER_CHARS;
  }

  async drain() {
    if (!this.buffer) return;
    const text = this.buffer;
    this.buffer = '';
    const bytes = this.encoder.encode(text);
    this.bytes += bytes.byteLength;
    if (this.bytes > MAX_AUTOMATIC_BACKUP_BYTES) {
      throw new Error('浏览器安全快照超过大小上限');
    }
    await this.writable.write(bytes);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async close() {
    await this.drain();
    await this.writable.close();
  }

  release() {
    this.buffer = '';
  }
}

async function inspectSlot(root, filename, meta = {}) {
  try {
    const handle = await root.getFileHandle(filename);
    const file = await handle.getFile();
    if (!file || file.size < 128) return null;
    const head = await file.slice(0, Math.min(file.size, 1024)).text();
    const tail = await file.slice(Math.max(0, file.size - 8192), file.size).text();
    if (!head.includes('marshmallow-migration-package') || !tail.includes('"complete":true')) {
      return null;
    }
    const savedMeta = meta?.slots?.[filename] || {};
    return {
      filename,
      bytes: Number(file.size || 0),
      createdAt: Number(savedMeta.createdAt || file.lastModified || 0),
      build: String(savedMeta.build || ''),
      recordCount: Number(savedMeta.recordCount || 0),
      counts: savedMeta.counts || {},
      handle,
      file,
      verifiedEnvelope: true,
    };
  } catch (_) {
    return null;
  }
}

export async function getBrowserSafetyBackupStatus() {
  if (!supportsBrowserSafetyBackup()) {
    return { ok: false, supported: false, available: false, backups: [] };
  }
  const root = await navigator.storage.getDirectory();
  const meta = readMeta();
  const backups = (await Promise.all(SLOT_FILES.map((name) => inspectSlot(root, name, meta))))
    .filter(Boolean)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return {
    ok: true,
    supported: true,
    available: backups.length > 0,
    latest: backups[0] || null,
    backups,
  };
}

async function streamBackupToInactiveSlot(counts, recordCount, previousStatus) {
  const activeName = previousStatus?.latest?.filename || '';
  const filename = SLOT_FILES.find((name) => name !== activeName) || SLOT_FILES[0];
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  const writer = new OpfsSafetyBackupWriter(writable);
  const packageId = `browser_safety_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  try {
    const prepared = await writeFullBackupToWriter(writer, {
      migrationPackage: true,
      packageId,
    });
    await writer.close();
    const file = await handle.getFile();
    const inspected = await inspectSlot(root, filename, {
      slots: { [filename]: { createdAt: Date.now() } },
    });
    if (!inspected || file.size <= 0) throw new Error('浏览器安全快照完整性检查失败');
    return { filename, file, prepared, bytes: file.size, recordCount };
  } catch (error) {
    try { await writable.abort(); } catch (_) {}
    try { await root.removeEntry(filename); } catch (_) {}
    throw error;
  } finally {
    writer.release();
  }
}

export async function createBrowserSafetyBackup({ force = false } = {}) {
  if (!supportsBrowserSafetyBackup()) {
    return { ok: false, supported: false, reason: 'unsupported' };
  }
  if (running) return { ok: false, supported: true, reason: 'running' };
  running = true;
  try {
    const [status, counts] = await Promise.all([
      getBrowserSafetyBackupStatus(),
      readCriticalInventory(),
    ]);
    const latest = status.latest || null;
    const age = Date.now() - Number(latest?.createdAt || 0);
    const currentCount = criticalRecordCount(counts);
    const currentBuild = String(globalThis.__MARSHMALLOW_BUILD__ || '');
    // 更新前已经强制写过快照时，新构建启动后不要因为 build 不同立刻再写一遍
    // 几十到几百 MB 的同一份数据；浏览器快照格式由模块自身版本控制。
    if (!force && latest && age >= 0 && age < MIN_BACKUP_INTERVAL_MS) {
      return { ok: true, skipped: true, reason: 'fresh', latest };
    }
    if (!hasMeaningfulUserData(counts)) {
      return { ok: true, skipped: true, reason: 'no-meaningful-data', counts };
    }
    if (!force && latest && isSuspiciousShrink(currentCount, latest.recordCount)) {
      return { ok: false, skipped: true, reason: 'suspicious-shrink', counts, latest };
    }
    try { await navigator.storage.persist?.(); } catch (_) {}
    const streamed = await streamBackupToInactiveSlot(counts, currentCount, status);
    const createdAt = Date.now();
    const meta = readMeta();
    meta.version = 1;
    meta.active = streamed.filename;
    meta.slots = meta.slots && typeof meta.slots === 'object' ? meta.slots : {};
    meta.slots[streamed.filename] = {
      createdAt,
      bytes: streamed.bytes,
      build: currentBuild,
      databaseVersion: db.DB_VERSION,
      recordCount: currentCount,
      counts: streamed.prepared.counts,
    };
    writeMeta(meta);
    dirty = false;
    try {
      globalThis.__mmlog?.('info', `browser safety backup saved ${streamed.filename} ${streamed.bytes} bytes`);
    } catch (_) {}
    return {
      ok: true,
      supported: true,
      saved: meta.slots[streamed.filename],
      filename: streamed.filename,
      counts: streamed.prepared.counts,
      recordCount: currentCount,
    };
  } finally {
    running = false;
  }
}

export async function restoreBrowserSafetyBackup(filename = '', options = {}) {
  const status = await getBrowserSafetyBackupStatus();
  const selected = status.backups.find((entry) => entry.filename === filename)
    || status.latest;
  if (!selected?.file || !selected.verifiedEnvelope) {
    throw new Error('没有找到完整的浏览器安全快照');
  }
  const mode = options.mode === 'merge' ? 'merge' : 'replace';
  const rebuiltCorruptDatabase = mode === 'replace' && options.rebuildDatabase !== false;
  if (rebuiltCorruptDatabase) await db.resetIndexedDbForVerifiedRestore();
  const result = await importFullBackupFiles([selected.file], { mode });
  dirty = true;
  return { ok: true, file: selected.file, result, rebuiltCorruptDatabase };
}

function scheduleAutomaticBackup(delayMs) {
  if (!installed || !supportsBrowserSafetyBackup()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = 0;
    if (isBusy()) {
      scheduleAutomaticBackup(BUSY_RETRY_DELAY_MS);
      return;
    }
    try {
      const result = await createBrowserSafetyBackup();
      if (result?.reason === 'fresh') {
        const latestAt = Number(result.latest?.createdAt || Date.now());
        scheduleAutomaticBackup(Math.max(
          WRITE_QUIET_DELAY_MS,
          MIN_BACKUP_INTERVAL_MS - (Date.now() - latestAt),
        ));
      } else if (dirty) {
        scheduleAutomaticBackup(MIN_BACKUP_INTERVAL_MS);
      }
    } catch (error) {
      try {
        globalThis.__mmlog?.('warn', `browser safety backup failed: ${error?.message || error}`);
      } catch (_) {}
      scheduleAutomaticBackup(FAILED_RETRY_DELAY_MS);
    }
  }, Math.max(1000, Number(delayMs || 0)));
}

export function installBrowserSafetyBackupScheduler() {
  if (installed || !supportsBrowserSafetyBackup()) return false;
  installed = true;
  removeWriteListeners = Object.keys(db.STORES).map((storeName) => db.onStoreWrite(storeName, () => {
    dirty = true;
    if (!timer) scheduleAutomaticBackup(WRITE_QUIET_DELAY_MS);
  }));
  scheduleAutomaticBackup(BOOT_BACKUP_DELAY_MS);
  return true;
}

export function stopBrowserSafetyBackupScheduler() {
  installed = false;
  if (timer) clearTimeout(timer);
  timer = 0;
  for (const remove of removeWriteListeners) {
    try { remove(); } catch (_) {}
  }
  removeWriteListeners = [];
}
