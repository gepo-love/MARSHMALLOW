import * as db from './db.js';

const RADIO_OPFS_PREFIX = 'mm-radio-audio-v1-';
const RADIO_CACHE_NAME = 'mm-radio-audio-v1';
const RADIO_IDB_PREFIX = 'radioAudioBlob_';
const BROWSER_SAFETY_BACKUP_NAMES = new Set([
  'marshmallow-browser-safety-a.mmmigrate.json',
  'marshmallow-browser-safety-b.mmmigrate.json',
]);

function isOpfsExportTempName(name = '') {
  const filename = String(name || '');
  return /^cloud-(?:mm-|encrypted-)/.test(filename)
    || /^region-/.test(filename)
    || /^marshmallow-(?:move|phone-backup|backup-assets)-/.test(filename);
}

function nativeFilePlugin() {
  return globalThis.Capacitor?.Plugins?.MarshmallowFileExport || null;
}

function updaterPlugin() {
  return globalThis.Capacitor?.Plugins?.CapacitorUpdater || null;
}

async function storageEstimate() {
  try {
    const result = await navigator.storage?.estimate?.();
    return {
      usage: Number(result?.usage || 0),
      quota: Number(result?.quota || 0),
      usageDetails: result?.usageDetails && typeof result.usageDetails === 'object'
        ? { ...result.usageDetails }
        : {},
    };
  } catch (_) {
    return { usage: 0, quota: 0, usageDetails: {} };
  }
}

async function opfsEntryInfo(handle) {
  if (!handle) return { bytes: 0, modifiedAt: 0 };
  if (handle.kind === 'file') {
    try {
      const file = await handle.getFile();
      return {
        bytes: Number(file?.size || 0),
        modifiedAt: Number(file?.lastModified || 0),
      };
    } catch (_) {
      return { bytes: 0, modifiedAt: 0 };
    }
  }
  if (handle.kind !== 'directory' || typeof handle.entries !== 'function') {
    return { bytes: 0, modifiedAt: 0 };
  }
  let total = 0;
  let modifiedAt = 0;
  try {
    for await (const [, child] of handle.entries()) {
      const info = await opfsEntryInfo(child);
      total += info.bytes;
      modifiedAt = Math.max(modifiedAt, info.modifiedAt);
    }
  } catch (_) {}
  return { bytes: total, modifiedAt };
}

async function inspectOpfs() {
  const empty = {
    totalBytes: 0,
    radioBytes: 0,
    safetyBackupBytes: 0,
    exportTempBytes: 0,
    otherBytes: 0,
    exportTempCount: 0,
  };
  if (typeof navigator.storage?.getDirectory !== 'function') return empty;
  try {
    const root = await navigator.storage.getDirectory();
    let totalBytes = 0;
    let radioBytes = 0;
    let safetyBackupBytes = 0;
    let exportTempBytes = 0;
    let exportTempCount = 0;
    for await (const [name, handle] of root.entries()) {
      const { bytes } = await opfsEntryInfo(handle);
      totalBytes += bytes;
      if (String(name).startsWith(RADIO_OPFS_PREFIX)) radioBytes += bytes;
      else if (BROWSER_SAFETY_BACKUP_NAMES.has(String(name))) safetyBackupBytes += bytes;
      else if (isOpfsExportTempName(name)) {
        exportTempBytes += bytes;
        exportTempCount += 1;
      }
    }
    return {
      totalBytes,
      radioBytes,
      safetyBackupBytes,
      exportTempBytes,
      otherBytes: Math.max(0, totalBytes - radioBytes - safetyBackupBytes - exportTempBytes),
      exportTempCount,
    };
  } catch (_) {
    return empty;
  }
}

async function inspectCacheStorage() {
  if (!globalThis.caches?.keys) return { totalBytes: 0, radioBytes: 0, names: [] };
  let totalBytes = 0;
  let radioBytes = 0;
  const names = [];
  try {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      let bytes = 0;
      for (const request of await cache.keys()) {
        try { bytes += Number((await (await cache.match(request))?.blob())?.size || 0); } catch (_) {}
      }
      names.push({ name, bytes });
      totalBytes += bytes;
      if (name === RADIO_CACHE_NAME) radioBytes += bytes;
    }
  } catch (_) {}
  return { totalBytes, radioBytes, names };
}

export async function inspectStorageDistribution() {
  const [estimate, opfs, cacheStorage] = await Promise.all([
    storageEstimate(),
    inspectOpfs(),
    inspectCacheStorage(),
  ]);
  const nativePlugin = nativeFilePlugin();
  let native = null;
  let nativeVault = null;
  if (typeof nativePlugin?.getAppStorageBreakdown === 'function') {
    try { native = await nativePlugin.getAppStorageBreakdown(); } catch (_) { native = null; }
  }
  const nativeData = globalThis.Capacitor?.Plugins?.MarshmallowNativeData;
  if (typeof nativeData?.getStatus === 'function') {
    try { nativeVault = await nativeData.getStatus(); } catch (_) { nativeVault = null; }
  }
  return {
    native: !!native?.ok,
    estimate,
    opfs,
    cacheStorage,
    ...(native || {}),
    inactiveVaultGenerationCount: Number(nativeVault?.inactiveGenerationCount || 0),
    canCleanNativeVault: typeof nativeData?.cleanInactiveGenerations === 'function',
    canFactoryReset: typeof nativePlugin?.resetApplicationData === 'function',
    measuredBytes: Number(native?.systemApproxBytes || estimate.usage || 0),
  };
}

export async function factoryResetApplicationData() {
  const native = nativeFilePlugin();
  if (typeof native?.resetApplicationData !== 'function') {
    throw new Error('当前版本暂不支持应用内恢复初始化，请更新 APK 后重试');
  }
  const result = await native.resetApplicationData();
  if (!result?.ok || !result?.accepted) throw new Error('系统未接受恢复初始化请求');
  return result;
}

async function clearRadioStorage() {
  let removed = 0;
  if (typeof navigator.storage?.getDirectory === 'function') {
    try {
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const [name] of root.entries()) {
        if (String(name).startsWith(RADIO_OPFS_PREFIX)) names.push(name);
      }
      for (const name of names) {
        try { await root.removeEntry(name, { recursive: true }); removed += 1; } catch (_) {}
      }
    } catch (_) {}
  }
  try { if (await caches.delete(RADIO_CACHE_NAME)) removed += 1; } catch (_) {}
  try {
    const keys = await db.getAllKeys('settings');
    for (const key of keys) {
      if (!String(key).startsWith(RADIO_IDB_PREFIX)) continue;
      await db.deleteRecord('settings', key);
      removed += 1;
    }
  } catch (_) {}
  return { ok: true, removed };
}

async function clearOpfsExportTemps() {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    throw new Error('当前环境不支持整理导出临时文件');
  }
  const root = await navigator.storage.getDirectory();
  const candidates = [];
  let freedBytes = 0;
  for await (const [name, handle] of root.entries()) {
    if (!isOpfsExportTempName(name)) continue;
    const info = await opfsEntryInfo(handle);
    candidates.push({ name, bytes: info.bytes });
  }
  let removed = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    try {
      await root.removeEntry(candidate.name, { recursive: true });
      removed += 1;
      freedBytes += candidate.bytes;
    } catch (_) {
      skipped += 1;
    }
  }
  return { ok: true, removed, skipped, freedBytes };
}

async function clearOldUpdateBundles() {
  const updater = updaterPlugin();
  let removed = 0;
  let skipped = 0;
  if (typeof updater?.list === 'function' && typeof updater?.delete === 'function') {
    const [listed, current, next] = await Promise.all([
      updater.list().catch(() => ({ bundles: [] })),
      updater.current?.().catch(() => null),
      updater.getNextBundle?.().catch(() => null),
    ]);
    const protectedIds = new Set([
      String(current?.bundle?.id || ''),
      String(next?.id || ''),
      'builtin',
    ].filter(Boolean));
    const candidates = (Array.isArray(listed?.bundles) ? listed.bundles : [])
      .filter((bundle) => !protectedIds.has(String(bundle?.id || '')))
      .sort((a, b) => String(b?.downloaded || '').localeCompare(String(a?.downloaded || '')));
    // 额外保留最近一份已下载包作为本地回退；原生插件还会拒绝删除正在保护的包。
    for (const bundle of candidates.slice(1)) {
      try { await updater.delete({ id: bundle.id }); removed += 1; } catch (_) { skipped += 1; }
    }
  }
  const native = nativeFilePlugin();
  if (typeof native?.cleanAppStorage === 'function') {
    const result = await native.cleanAppStorage({ category: 'update_temps' }).catch(() => null);
    removed += Number(result?.removed || 0);
  }
  return { ok: true, removed, skipped };
}

export async function cleanStorageCategory(category) {
  if (category === 'radio_cache') return clearRadioStorage();
  if (category === 'opfs_export_temps') return clearOpfsExportTemps();
  if (category === 'old_updates') return clearOldUpdateBundles();
  if (category === 'old_vault_generations') {
    const nativeData = globalThis.Capacitor?.Plugins?.MarshmallowNativeData;
    if (typeof nativeData?.cleanInactiveGenerations !== 'function') {
      throw new Error('当前版本不支持整理原生数据保险库');
    }
    return nativeData.cleanInactiveGenerations();
  }
  if (category === 'request_recovery') {
    const nativeHttp = globalThis.Capacitor?.Plugins?.MarshmallowHttp;
    if (typeof nativeHttp?.cleanFinishedRequestStates !== 'function') {
      throw new Error('当前版本不支持清理请求恢复缓存');
    }
    return nativeHttp.cleanFinishedRequestStates();
  }
  const native = nativeFilePlugin();
  if (typeof native?.cleanAppStorage !== 'function') {
    throw new Error('当前版本不支持清理这类存储');
  }
  if (category === 'cache') return native.cleanAppStorage({ category: 'cache' });
  if (category === 'old_safety_backups') {
    return native.cleanAppStorage({ category: 'old_safety_backups' });
  }
  throw new Error('未知的存储分类');
}
