/**
 * IndexedDB / 本地存储「持久化」申请与配额探测。
 * 浏览器在存储紧张时可能清掉「非持久」站点的数据；persist() 可降低被自动清理的概率（非 100% 保证）。
 * iOS Safari 标签页另有约 7 天无交互清库策略；加到主屏幕的 PWA 不受该条限制。
 */
import { get as dbGet, put as dbPut } from './db.js';
import { isIOSDevice } from './native-download.js';
import { isStandalonePwa } from './pwa-install.js';

const STORAGE_STATE_KEY = 'storagePersistenceState';

function hasStorageManager() {
  return typeof navigator !== 'undefined'
    && navigator.storage
    && typeof navigator.storage.persist === 'function';
}

export async function getStoragePersistenceStatus() {
  const saved = (await dbGet(STORAGE_STATE_KEY).catch(() => null))?.value || {};
  let persisted = null;
  let quota = null;
  let usage = null;
  if (hasStorageManager()) {
    try {
      if (typeof navigator.storage.persisted === 'function') {
        persisted = await navigator.storage.persisted();
      }
    } catch (_) {}
    try {
      if (typeof navigator.storage.estimate === 'function') {
        const est = await navigator.storage.estimate();
        quota = Number(est?.quota || 0) || null;
        usage = Number(est?.usage || 0) || null;
      }
    } catch (_) {}
  }
  const ios = isIOSDevice();
  const standalone = isStandalonePwa();
  return {
    supported: hasStorageManager(),
    persisted: persisted === true,
    unknown: persisted === null,
    quota,
    usage,
    ios,
    standalone,
    /** iOS 标签页即使 persist() 返回 true，仍可能被 7 天策略清库 */
    atRiskOfPeriodicEviction: ios && !standalone,
    lastRequestedAt: Number(saved.lastRequestedAt || 0) || 0,
    lastGranted: saved.lastGranted === true,
    lastError: String(saved.lastError || ''),
  };
}

export function describeStorageProtectionLabel(status = {}) {
  if (!status.supported) return '浏览器不支持';
  if (status.atRiskOfPeriodicEviction) {
    return status.persisted
      ? '已申请 · iOS 建议用主屏幕'
      : '未持久化 · iOS 建议用主屏幕';
  }
  return status.persisted ? '已申请持久化' : '未持久化（可能被系统清理）';
}

export async function requestStoragePersistence({ silent = false } = {}) {
  if (!hasStorageManager()) {
    const status = await getStoragePersistenceStatus();
    return { ...status, ok: false, reason: 'unsupported' };
  }
  let granted = false;
  let error = '';
  try {
    if (typeof navigator.storage.persisted === 'function') {
      granted = await navigator.storage.persisted();
    }
    if (!granted) {
      granted = await navigator.storage.persist();
    }
  } catch (err) {
    error = err?.message || String(err || 'persist failed');
  }
  await dbPut({
    key: STORAGE_STATE_KEY,
    value: {
      lastRequestedAt: Date.now(),
      lastGranted: granted === true,
      lastError: error,
    },
  }).catch(() => {});
  const status = await getStoragePersistenceStatus();
  if (!silent && typeof window !== 'undefined') {
    try {
      window.__mmlog?.('info', `storage.persist ${granted ? 'granted' : 'denied'}${error ? ` (${error})` : ''}`);
    } catch (_) {}
  }
  return { ...status, ok: granted === true, reason: granted ? 'granted' : (error || 'denied') };
}

/** 启动后静默申请一次；已持久化则跳过 */
export async function ensureStoragePersistenceOnBoot() {
  const status = await getStoragePersistenceStatus();
  if (status.persisted && !status.atRiskOfPeriodicEviction) return status;
  // iOS 标签页即使已 persisted，也再申请一次无害；真正防清库仍靠主屏幕 / 备份。
  return requestStoragePersistence({ silent: true });
}

export function formatStorageBytes(n) {
  const num = Number(n || 0);
  if (!num) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
