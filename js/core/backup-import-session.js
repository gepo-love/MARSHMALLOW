const SESSION_KEY = '__mm_backup_import_session_v1__';
const SKIPPED_NOTICE_KEY = '__mm_backup_import_skipped_v1__';
const BEAUTIFY_SUPPLEMENT_KEY = '__mm_beautify_supplement_v1__';

function readRaw() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(SESSION_KEY) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function write(value) {
  try { globalThis.localStorage?.setItem(SESSION_KEY, JSON.stringify(value)); } catch (_) {}
  return value;
}

function notifyFailure(value) {
  try {
    globalThis.dispatchEvent?.(new CustomEvent('marshmallow-backup-import-failed', { detail: value }));
  } catch (_) {}
}

export function backupImportFileIdentity(file) {
  return {
    name: String(file?.name || ''),
    size: Number(file?.size || 0),
    lastModified: Number(file?.lastModified || 0),
  };
}

export async function fingerprintBackupImportFile(file) {
  if (!file || typeof file.slice !== 'function' || !globalThis.crypto?.subtle) return '';
  const span = 128 * 1024;
  const size = Number(file.size || 0);
  if (size <= 0) return '';
  const head = new Uint8Array(await file.slice(0, Math.min(span, size)).arrayBuffer());
  const tailStart = Math.max(head.byteLength, size - span);
  const tail = tailStart < size
    ? new Uint8Array(await file.slice(tailStart, size).arrayBuffer())
    : new Uint8Array();
  const sizeBytes = new TextEncoder().encode(String(size));
  const combined = new Uint8Array(head.byteLength + tail.byteLength + sizeBytes.byteLength);
  combined.set(head, 0);
  combined.set(tail, head.byteLength);
  combined.set(sizeBytes, head.byteLength + tail.byteLength);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', combined));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function startBackupImportSession(file, resumeCheckpoint = null, fingerprint = '') {
  return write({
    version: 1,
    status: 'active',
    file: { ...backupImportFileIdentity(file), fingerprint: String(fingerprint || '') },
    startedAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'start',
    generation: Number(resumeCheckpoint?.generation || 0),
    completedStores: [...(resumeCheckpoint?.completedStores || [])],
    storeCounts: { ...(resumeCheckpoint?.storeCounts || {}) },
    completedAssets: [...(resumeCheckpoint?.completedAssets || [])],
    assetCounts: { ...(resumeCheckpoint?.assetCounts || {}) },
    restoredAssetCounts: { ...(resumeCheckpoint?.restoredAssetCounts || {}) },
    skippedAssets: [...(resumeCheckpoint?.skippedAssets || [])],
  });
}

export function updateBackupImportSession(progress = {}) {
  const current = readRaw();
  if (!current || !['active', 'interrupted'].includes(current.status)) return null;
  const next = {
    ...current,
    status: 'active',
    updatedAt: Date.now(),
    phase: String(progress.phase || current.phase || ''),
    storeName: String(progress.storeName || current.storeName || ''),
    rows: Number(progress.rows || 0),
    bytesRead: Number(progress.bytesRead || 0),
    totalBytes: Number(progress.totalBytes || current.totalBytes || 0),
  };
  if (Number(progress.generation || 0) > 0) next.generation = Number(progress.generation);
  if (progress.resetCheckpoint === true) {
    next.completedStores = [];
    next.storeCounts = {};
    next.completedAssets = [];
    next.assetCounts = {};
    next.restoredAssetCounts = {};
    next.skippedAssets = [];
  }
  if (progress.phase === 'store-complete' && progress.storeName) {
    next.completedStores = [...new Set([...(next.completedStores || []), String(progress.storeName)])];
    next.storeCounts = { ...(next.storeCounts || {}), [progress.storeName]: Number(progress.rows || 0) };
  }
  if (progress.phase === 'asset-complete' && progress.assetName) {
    next.completedAssets = [...new Set([...(next.completedAssets || []), String(progress.assetName)])];
    next.assetCounts = { ...(next.assetCounts || {}), [progress.assetName]: Number(progress.rows || 0) };
    next.restoredAssetCounts = {
      ...(next.restoredAssetCounts || {}),
      [progress.assetName]: Number(progress.restored || 0),
    };
    const otherSkipped = (next.skippedAssets || []).filter((item) => item.assetName !== progress.assetName);
    next.skippedAssets = [...otherSkipped, ...(progress.skippedAssets || [])];
  }
  return write(next);
}

export function finishBackupImportSession() {
  try { globalThis.localStorage?.removeItem(SESSION_KEY); } catch (_) {}
}

export function saveBackupImportSkippedNotice(items = [], file = null) {
  const skipped = (Array.isArray(items) ? items : []).map((item) => ({
    assetName: String(item?.assetName || 'resource'),
    id: String(item?.id || '未知项目'),
    reason: String(item?.reason || '无法还原'),
  }));
  if (!skipped.length) {
    try { globalThis.localStorage?.removeItem(SKIPPED_NOTICE_KEY); } catch (_) {}
    return null;
  }
  const notice = {
    completedAt: Date.now(),
    file: backupImportFileIdentity(file),
    skipped,
  };
  try { globalThis.localStorage?.setItem(SKIPPED_NOTICE_KEY, JSON.stringify(notice)); } catch (_) {}
  return notice;
}

export function getBackupImportSkippedNotice() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(SKIPPED_NOTICE_KEY) || 'null');
    return value && Array.isArray(value.skipped) && value.skipped.length ? value : null;
  } catch {
    return null;
  }
}

export function acknowledgeBackupImportSkippedNotice() {
  try { globalThis.localStorage?.removeItem(SKIPPED_NOTICE_KEY); } catch (_) {}
}

export function failBackupImportSession(error) {
  const current = readRaw();
  if (!current) return null;
  const next = write({
    ...current,
    status: 'failed',
    updatedAt: Date.now(),
    error: String(error?.message || error || '导入失败').slice(0, 600),
  });
  notifyFailure(next);
  return next;
}

export function markBackupImportInterruptedOnBoot() {
  const current = readRaw();
  if (!current || current.status !== 'active') return current;
  return write({ ...current, status: 'interrupted', interruptedAt: Date.now(), updatedAt: Date.now() });
}

export function getBackupImportSession() {
  return readRaw();
}

export function acknowledgeBackupImportNotice() {
  const current = readRaw();
  if (!current) return null;
  return write({ ...current, noticeAcknowledgedAt: Date.now() });
}

export function matchesBackupImportSessionFile(session, file, fingerprint = '') {
  if (!session?.file) return false;
  const actual = backupImportFileIdentity(file);
  return !!fingerprint
    && String(session.file.fingerprint || '') === String(fingerprint)
    && actual.size > 0
    && actual.size === Number(session.file.size || 0)
    && actual.name === String(session.file.name || '')
    && (!actual.lastModified || !session.file.lastModified
      || actual.lastModified === Number(session.file.lastModified));
}

export function saveBeautifySupplementSession(file, fingerprint = '', progress = {}) {
  const nextIndex = Math.max(0, Number(progress.nextIndex || 0) || 0);
  const value = {
    version: 1,
    status: 'pending',
    file: { ...backupImportFileIdentity(file), fingerprint: String(fingerprint || '') },
    nextIndex,
    totalRows: Math.max(nextIndex, Number(progress.totalRows || 0) || 0),
    restoredRows: Math.max(0, Number(progress.restoredRows || 0) || 0),
    updatedAt: Date.now(),
  };
  try { globalThis.localStorage?.setItem(BEAUTIFY_SUPPLEMENT_KEY, JSON.stringify(value)); } catch (_) {}
  return value;
}

export function getBeautifySupplementSession() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(BEAUTIFY_SUPPLEMENT_KEY) || 'null');
    return value?.status === 'pending' ? value : null;
  } catch {
    return null;
  }
}

export function matchesBeautifySupplementFile(session, file, fingerprint = '') {
  return matchesBackupImportSessionFile(session, file, fingerprint);
}

export function finishBeautifySupplementSession() {
  try { globalThis.localStorage?.removeItem(BEAUTIFY_SUPPLEMENT_KEY); } catch (_) {}
}

export function backupImportResumeCheckpoint(session) {
  if (!session || !['interrupted', 'failed'].includes(session.status)) return null;
  const generation = Number(session.generation || 0);
  if (generation <= 0) return null;
  return {
    generation,
    completedStores: [...(session.completedStores || [])],
    storeCounts: { ...(session.storeCounts || {}) },
    completedAssets: [...(session.completedAssets || [])],
    assetCounts: { ...(session.assetCounts || {}) },
    restoredAssetCounts: { ...(session.restoredAssetCounts || {}) },
    skippedAssets: [...(session.skippedAssets || [])],
  };
}
