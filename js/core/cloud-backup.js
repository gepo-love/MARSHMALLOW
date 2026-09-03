import {
  createFullBackupBlob,
  createAssetBackupBlob,
  importFullBackupFile,
  importAssetBackupFile,
} from './backup.js';
import { encryptBackupBlob, decryptBackupBlob, sha256Hex } from './backup-encryption.js';
import { isAndroidDevice, isIOSDevice } from './native-download.js';
import { inspectRestoredBeautifyAssetReferences } from './backup-asset-integrity.js';
import {
  testWebDavConnection,
  listWebDavFiles,
  putWebDavFile,
  getWebDavFile,
  getWebDavJson,
  deleteWebDavFile,
} from './backup-webdav.js';
import {
  testGitHubConnection,
  listGitHubFiles,
  putGitHubFile,
  getGitHubFile,
  getGitHubJson,
  deleteGitHubFile,
} from './backup-github.js';

export const CLOUD_BACKUP_MANIFEST_FORMAT = 'marshmallow-webdav-backup-manifest';
export const CLOUD_BACKUP_MANIFEST_VERSION = 1;
const PREFS_KEY = 'marshmallowCloudBackupPrefsV1';
const AUTO_LOCK_KEY = 'marshmallowCloudBackupAutoLockV1';
const CLOUD_OPERATION_LOCK_NAME = 'marshmallow-cloud-backup-write-v1';
const AUTO_LOCK_TTL_MS = 30 * 60 * 1000;
const AUTO_LOCK_HEARTBEAT_MS = 60 * 1000;
const AUTO_FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000;
const AUTO_USER_IDLE_REQUIRED_MS = 2 * 60 * 1000;
const AUTO_BACKGROUND_QUIET_TIMEOUT_MS = 30 * 1000;
const STALE_INCOMPLETE_BACKUP_MS = 24 * 60 * 60 * 1000;
const LEGACY_CLOUD_ID_PREFIX = 'mmcloud';
const NEXT_CLOUD_ID_PREFIX = 'mmcloudnext';

let cloudOperationTail = Promise.resolve();

const DEFAULT_PREFS = Object.freeze({
  provider: 'github',
  url: '',
  username: '',
  password: '',
  githubToken: '',
  githubOwner: '',
  githubRepo: 'marshmallow-cloud-backup',
  githubBranch: 'main',
  githubRepoUrl: '',
  encryptionPassword: '',
  autoEnabled: false,
  intervalHours: 24,
  retention: 5,
  lastBackupAt: '',
  lastAutoAttemptAt: '',
});

function storage() {
  try { return globalThis.localStorage; } catch (_) { return null; }
}

function normalizePrefs(value = {}) {
  const provider = value.provider === 'webdav' || (!value.provider && String(value.url || '').trim())
    ? 'webdav'
    : 'github';
  return {
    provider,
    url: String(value.url || '').trim(),
    username: String(value.username || ''),
    password: String(value.password || ''),
    githubToken: String(value.githubToken || ''),
    githubOwner: String(value.githubOwner || '').trim(),
    githubRepo: String(value.githubRepo || 'marshmallow-cloud-backup').trim(),
    githubBranch: String(value.githubBranch || 'main').trim(),
    githubRepoUrl: String(value.githubRepoUrl || '').trim(),
    encryptionPassword: String(value.encryptionPassword || ''),
    autoEnabled: value.autoEnabled === true,
    intervalHours: Math.max(6, Math.min(168, Number(value.intervalHours) || 24)),
    retention: Math.max(1, Math.min(30, Math.round(Number(value.retention) || 5))),
    lastBackupAt: String(value.lastBackupAt || ''),
    lastAutoAttemptAt: String(value.lastAutoAttemptAt || ''),
  };
}

async function runCloudOperation(task) {
  const run = cloudOperationTail
    .catch(() => {})
    .then(async () => {
      const locks = globalThis.navigator?.locks;
      if (typeof locks?.request === 'function') {
        return locks.request(CLOUD_OPERATION_LOCK_NAME, { mode: 'exclusive' }, task);
      }
      return task();
    });
  cloudOperationTail = run.catch(() => {});
  return run;
}

function readAutomaticLock() {
  const raw = String(storage()?.getItem(AUTO_LOCK_KEY) || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const touchedAt = Number(parsed?.touchedAt || parsed?.createdAt || 0);
    if (!touchedAt) return null;
    return { owner: String(parsed?.owner || 'legacy'), touchedAt };
  } catch (_) {
    const touchedAt = Number(raw || 0);
    return touchedAt ? { owner: 'legacy', touchedAt } : null;
  }
}

function acquireAutomaticLock() {
  const existing = readAutomaticLock();
  if (existing && Date.now() - existing.touchedAt < AUTO_LOCK_TTL_MS) return null;
  const owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  storage()?.setItem(AUTO_LOCK_KEY, JSON.stringify({ owner, createdAt: Date.now(), touchedAt: Date.now() }));
  return owner;
}

function touchAutomaticLock(owner) {
  const existing = readAutomaticLock();
  if (!existing || existing.owner !== owner) return false;
  storage()?.setItem(AUTO_LOCK_KEY, JSON.stringify({ owner, touchedAt: Date.now() }));
  return true;
}

function releaseAutomaticLock(owner) {
  const existing = readAutomaticLock();
  if (existing?.owner === owner) storage()?.removeItem(AUTO_LOCK_KEY);
}

export function getCloudBackupPrefs() {
  try {
    return normalizePrefs({ ...DEFAULT_PREFS, ...JSON.parse(storage()?.getItem(PREFS_KEY) || '{}') });
  } catch (_) {
    return normalizePrefs(DEFAULT_PREFS);
  }
}

export function saveCloudBackupPrefs(patch = {}) {
  const next = normalizePrefs({ ...getCloudBackupPrefs(), ...patch });
  storage()?.setItem(PREFS_KEY, JSON.stringify(next));
  return next;
}

function assertRemoteConfig(config) {
  if (config?.provider === 'webdav') {
    if (!String(config?.url || '').trim()) throw new Error('请填写 WebDAV 地址');
    return;
  }
  if (!String(config?.githubToken || '').trim()) throw new Error('请先连接 GitHub');
}

function assertConfig(config) {
  assertRemoteConfig(config);
  if (!String(config?.encryptionPassword || '')) throw new Error('请填写云备份加密密码');
}

async function cloudBackupIdPrefix() {
  try {
    const plugin = globalThis.Capacitor?.Plugins?.MarshmallowNativeData;
    const status = await plugin?.getStatus?.();
    if (status?.enabled === true && status?.appId === 'com.marshmallow.machine.next') {
      return NEXT_CLOUD_ID_PREFIX;
    }
  } catch (_) {}
  return LEGACY_CLOUD_ID_PREFIX;
}

function backupId(prefix, date = new Date()) {
  return `${prefix}-${date.toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

function manifestName(id) {
  return `${id}.manifest.json`;
}

function encryptedName(id, kind) {
  return `${id}.${kind}.mme`;
}

function isNativeShell() {
  try {
    return typeof window !== 'undefined'
      && typeof window.Capacitor?.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform();
  } catch (_) {
    return false;
  }
}

function requiresLowMemoryFileBacking() {
  return isNativeShell() || isAndroidDevice() || isIOSDevice();
}

function automaticCloudBackupBusy(now = Date.now()) {
  if (typeof document !== 'undefined' && document.hidden) return true;
  const safety = globalThis.__mm_update_safety_state__ || {};
  if (Number(safety.criticalCount || 0) > 0) return true;
  const lastInteractionAt = Number(safety.lastInteractionAt || 0);
  if (lastInteractionAt > 0 && now - lastInteractionAt < AUTO_USER_IDLE_REQUIRED_MS) return true;
  if (Number(globalThis.__mm_chat_generation_active__ || 0) > 0) return true;
  if (Number(globalThis.__mm_manual_generation_active__ || 0) > 0) return true;
  if (typeof document !== 'undefined' && document.querySelector(
    '.page--route-loading, .page[data-route-render-state="pending"], [aria-busy="true"], .generation-activity.is-running',
  )) return true;
  return false;
}

async function automaticCloudBackupReady() {
  if (automaticCloudBackupBusy()) return false;
  const waitForQuiet = globalThis.__mm_wait_for_background_quiet__;
  if (typeof waitForQuiet === 'function') {
    const quiet = await waitForQuiet({
      timeoutMs: AUTO_BACKGROUND_QUIET_TIMEOUT_MS,
      pollMs: 250,
    }).catch(() => false);
    if (!quiet) return false;
  }
  return !automaticCloudBackupBusy();
}

function asFile(blob, name) {
  if (typeof File === 'function') {
    return new File([blob], name, { type: 'application/json', lastModified: Date.now() });
  }
  blob.name = name;
  return blob;
}

function validateManifest(manifest) {
  if (manifest?.format !== CLOUD_BACKUP_MANIFEST_FORMAT
    || manifest?.version !== CLOUD_BACKUP_MANIFEST_VERSION
    || !/^(?:mmcloud|mmcloudnext)-[a-z0-9-]+$/i.test(String(manifest?.id || ''))
    || !Array.isArray(manifest?.files)) {
    throw new Error('云端备份清单格式不受支持');
  }
  const kinds = new Set();
  for (const file of manifest.files) {
    if (!['data', 'assets'].includes(file?.kind)
      || kinds.has(file.kind)
      || file.name !== encryptedName(manifest.id, file.kind)
      || !/^[a-f0-9]{64}$/i.test(String(file.sha256 || ''))
      || !Number.isSafeInteger(Number(file.plaintextSize))
      || Number(file.plaintextSize) < 0
      || !Number.isSafeInteger(Number(file.encryptedSize))
      || Number(file.encryptedSize) <= 0) {
      throw new Error('云端备份清单文件项无效');
    }
    kinds.add(file.kind);
  }
  if (manifest.complete && (!kinds.has('data') || !kinds.has('assets'))) {
    throw new Error('云端备份清单缺少数据包或资源包');
  }
  return manifest;
}

export async function testCloudBackupConnection(config = getCloudBackupPrefs()) {
  assertRemoteConfig(config);
  return config.provider === 'webdav'
    ? testWebDavConnection(config)
    : testGitHubConnection(config);
}

function remoteAdapter(config) {
  if (config?.provider === 'webdav') {
    return {
      listFiles: listWebDavFiles,
      putFile: putWebDavFile,
      getFile: getWebDavFile,
      getJson: getWebDavJson,
      deleteFile: deleteWebDavFile,
    };
  }
  return {
    listFiles: listGitHubFiles,
    putFile: putGitHubFile,
    getFile: getGitHubFile,
    getJson: getGitHubJson,
    deleteFile: deleteGitHubFile,
  };
}

export async function listCloudBackups(config = getCloudBackupPrefs()) {
  assertRemoteConfig(config);
  const remote = remoteAdapter(config);
  const idPrefix = await cloudBackupIdPrefix();
  const manifestPattern = new RegExp(`^${idPrefix}-[a-z0-9-]+\\.manifest\\.json$`, 'i');
  const files = await remote.listFiles(config);
  const names = files
    .map((item) => item.name)
    .filter((name) => manifestPattern.test(name));
  const manifests = [];
  for (const name of names) {
    try {
      const manifest = validateManifest(await remote.getJson(config, name));
      manifests.push(manifest);
    } catch (error) {
      manifests.push({
        id: name.replace(/\.manifest\.json$/i, ''),
        format: CLOUD_BACKUP_MANIFEST_FORMAT,
        version: CLOUD_BACKUP_MANIFEST_VERSION,
        createdAt: '',
        complete: false,
        status: 'invalid',
        error: String(error?.message || error),
        files: [],
      });
    }
  }
  return manifests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function prepareEncryptedFile(id, kind, prepared, passphrase, onProgress) {
  const sha256 = await sha256Hex(prepared.blob, {
    onProgress: ({ loadedBytes, totalBytes }) => onProgress?.({
      phase: 'checksum',
      kind,
      loadedBytes,
      totalBytes,
    }),
  });
  const encrypted = await encryptBackupBlob(prepared.blob, passphrase, {
    preferFileBacked: true,
    requireFileBacked: requiresLowMemoryFileBacking(),
    onProgress: ({ loadedBytes, totalBytes }) => onProgress?.({
      phase: 'encrypt',
      kind,
      loadedBytes,
      totalBytes,
    }),
  });
  return {
    kind,
    name: encryptedName(id, kind),
    originalName: prepared.filename,
    plaintextSize: prepared.blob.size,
    encryptedSize: encrypted.blob.size,
    sha256,
    empty: prepared.empty === true,
    encryptedBlob: encrypted.blob,
    encryptedCleanup: encrypted.cleanup,
    fileBacked: encrypted.fileBacked === true,
  };
}

async function prepareAndUploadFile({
  id,
  kind,
  createPack,
  passphrase,
  config,
  remote,
  manifest,
  manifestRemoteName,
  index,
  total,
  onProgress,
}) {
  onProgress?.({ phase: 'export', kind, index, total });
  let prepared = await createPack();
  let encryptedFile;
  try {
    encryptedFile = await prepareEncryptedFile(
      id,
      kind,
      prepared,
      passphrase,
      (progress) => onProgress?.({ ...progress, index, total }),
    );
  } finally {
    // 支持 OPFS 时，明文包写在临时文件中；加密完立即删除。即使降级为内存 Blob，
    // 这里也尽早放掉引用，避免与后续资源包同时驻留。
    if (typeof prepared?.cleanup === 'function') {
      await prepared.cleanup().catch(() => {});
    }
    prepared = null;
  }
  const {
    encryptedBlob,
    encryptedCleanup,
    fileBacked: _fileBacked,
    ...publicFile
  } = encryptedFile;
  try {
    manifest.files.push(publicFile);
    await remote.putFile(
      config,
      manifestRemoteName,
      JSON.stringify(manifest),
      'application/json;charset=utf-8',
    );
    onProgress?.({ phase: 'upload', kind, index, total });
    await remote.putFile(
      config,
      encryptedFile.name,
      encryptedBlob,
      'application/octet-stream',
      {
        onProgress: ({ loadedBytes, totalBytes }) => onProgress?.({
          phase: 'upload',
          kind,
          index,
          total,
          loadedBytes,
          totalBytes,
        }),
      },
    );
    return publicFile;
  } finally {
    if (typeof encryptedCleanup === 'function') await encryptedCleanup().catch(() => {});
    encryptedFile = null;
  }
}

async function createCloudBackupNow(config = getCloudBackupPrefs(), options = {}) {
  const releaseCritical = typeof globalThis.__mm_begin_critical_activity__ === 'function'
    ? globalThis.__mm_begin_critical_activity__('cloud-backup')
    : () => {};
  let riskToken = globalThis.__mm_mark_risky_activity__?.('cloud-backup', { phase: 'start' });
  const reportProgress = (progress = {}) => {
    riskToken = globalThis.__mm_mark_risky_activity__?.('cloud-backup', progress) || riskToken;
    options.onProgress?.(progress);
  };
  try {
    assertConfig(config);
    const remote = remoteAdapter(config);
    const id = backupId(await cloudBackupIdPrefix());
    const createdAt = new Date().toISOString();
    const manifest = {
      format: CLOUD_BACKUP_MANIFEST_FORMAT,
      version: CLOUD_BACKUP_MANIFEST_VERSION,
      id,
      createdAt,
      completedAt: '',
      complete: false,
      status: 'uploading',
      files: [],
    };
    const name = manifestName(id);
    await remote.putFile(config, name, JSON.stringify(manifest), 'application/json;charset=utf-8');
    try {
      const packs = [
        ['data', () => createFullBackupBlob({
          preferFileBacked: true,
          requireFileBacked: requiresLowMemoryFileBacking(),
        })],
        ['assets', () => createAssetBackupBlob({
          preferFileBacked: true,
          requireFileBacked: requiresLowMemoryFileBacking(),
        })],
      ];
      for (let index = 0; index < packs.length; index += 1) {
        const [kind, createPack] = packs[index];
        await prepareAndUploadFile({
          id,
          kind,
          createPack,
          passphrase: config.encryptionPassword,
          config,
          remote,
          manifest,
          manifestRemoteName: name,
          index,
          total: packs.length,
          onProgress: reportProgress,
        });
      }
      manifest.complete = true;
      manifest.status = 'complete';
      manifest.completedAt = new Date().toISOString();
      await remote.putFile(config, name, JSON.stringify(manifest), 'application/json;charset=utf-8');
    } catch (error) {
      manifest.status = 'failed';
      manifest.error = String(error?.message || error).slice(0, 240);
      await remote.putFile(config, name, JSON.stringify(manifest), 'application/json;charset=utf-8').catch(() => {});
      throw error;
    }
    saveCloudBackupPrefs({ lastBackupAt: manifest.completedAt });
    const cleanupErrors = await enforceCloudBackupRetentionNow(config, config.retention).catch((error) => [String(error?.message || error)]);
    return { manifest, cleanupErrors };
  } finally {
    if (riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
    releaseCritical();
  }
}

export async function createCloudBackup(config = getCloudBackupPrefs(), options = {}) {
  return runCloudOperation(() => createCloudBackupNow(config, options));
}

async function restoreCloudBackupNow(manifestOrId, config = getCloudBackupPrefs(), options = {}) {
  let riskToken = globalThis.__mm_mark_risky_activity__?.('cloud-restore', { phase: 'start' });
  const reportProgress = (progress = {}) => {
    riskToken = globalThis.__mm_mark_risky_activity__?.('cloud-restore', progress) || riskToken;
    options.onProgress?.(progress);
  };
  try {
    assertConfig(config);
    const remote = remoteAdapter(config);
    const manifest = validateManifest(typeof manifestOrId === 'string'
      ? await remote.getJson(config, manifestName(manifestOrId))
      : manifestOrId);
    if (!manifest.complete || manifest.status !== 'complete') throw new Error('该云备份未完整上传，不能恢复');

    // 数据包必须先完成“下载 → 解密 → 校验 → 导入 → 释放”，之后才处理资源包。
    // 旧实现把两份明文 Blob 同时留在 WebView；百兆级备份恢复时会再次制造 OOM 峰值。
    const entries = manifest.files
      .filter((entry) => ['data', 'assets'].includes(entry?.kind))
      .sort((a, b) => (a.kind === 'data' ? -1 : 1) - (b.kind === 'data' ? -1 : 1));
    let dataResult = null;
    let assetResult = null;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      let encrypted = null;
      let decrypted = null;
      let onImportProgress = null;
      try {
        reportProgress({ phase: 'download', kind: entry.kind, index, total: entries.length });
        encrypted = await remote.getFile(config, entry.name, {
          totalBytes: Number(entry.encryptedSize) || 0,
          onProgress: ({ loadedBytes, totalBytes }) => reportProgress({
            phase: 'download',
            kind: entry.kind,
            index,
            total: entries.length,
            loadedBytes,
            totalBytes,
          }),
          onRetry: ({ retry, retries, loadedBytes, totalBytes }) => reportProgress({
            phase: 'download-retry',
            kind: entry.kind,
            index,
            total: entries.length,
            retry,
            retries,
            loadedBytes,
            totalBytes: totalBytes || Number(entry.encryptedSize) || 0,
          }),
        });
        if (encrypted.size !== Number(entry.encryptedSize)) throw new Error(`${entry.kind} 密文大小校验失败`);
        reportProgress({ phase: 'decrypt', kind: entry.kind, index, total: entries.length });
        decrypted = await decryptBackupBlob(encrypted, config.encryptionPassword, {
          preferFileBacked: true,
          requireFileBacked: requiresLowMemoryFileBacking(),
          onProgress: ({ loadedBytes, totalBytes }) => reportProgress({
            phase: 'decrypt',
            kind: entry.kind,
            index,
            total: entries.length,
            loadedBytes,
            totalBytes,
          }),
        });
        encrypted = null;
        if (decrypted.blob.size !== Number(entry.plaintextSize)) throw new Error(`${entry.kind} 文件大小校验失败`);
        const actualHash = await sha256Hex(decrypted.blob, {
          onProgress: ({ loadedBytes, totalBytes }) => reportProgress({
            phase: 'restore-checksum',
            kind: entry.kind,
            index,
            total: entries.length,
            loadedBytes,
            totalBytes,
          }),
        });
        if (actualHash !== entry.sha256) throw new Error(`${entry.kind} SHA-256 校验失败`);

        reportProgress({ phase: 'import', importPhase: 'start', kind: entry.kind, index, total: entries.length });
        onImportProgress = (event) => {
          const detail = event?.detail || {};
          reportProgress({
            ...detail,
            phase: 'import',
            importPhase: String(detail.phase || ''),
            kind: entry.kind,
            index,
            total: entries.length,
          });
        };
        globalThis.addEventListener?.('marshmallow-backup-import-progress', onImportProgress);
        const file = asFile(decrypted.blob, entry.originalName);
        if (entry.kind === 'data') {
          dataResult = await importFullBackupFile(file, { mode: 'replace' });
        } else if (!entry.empty) {
          assetResult = await importAssetBackupFile(file);
        }
        reportProgress({ phase: 'package-complete', kind: entry.kind, index, total: entries.length });
      } finally {
        if (onImportProgress) {
          globalThis.removeEventListener?.('marshmallow-backup-import-progress', onImportProgress);
        }
        if (typeof decrypted?.cleanup === 'function') await decrypted.cleanup().catch(() => {});
        encrypted = null;
        decrypted = null;
      }
    }
    if (!dataResult) throw new Error('云备份缺少数据包');
    const assetIntegrity = await inspectRestoredBeautifyAssetReferences();
    return { manifest, dataResult, assetResult, assetIntegrity };
  } finally {
    if (riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
  }
}

export async function restoreCloudBackup(manifestOrId, config = getCloudBackupPrefs(), options = {}) {
  return runCloudOperation(() => restoreCloudBackupNow(manifestOrId, config, options));
}

async function deleteCloudBackupNow(manifestOrId, config = getCloudBackupPrefs(), options = {}) {
  assertRemoteConfig(config);
  const remote = remoteAdapter(config);
  const report = (detail = {}) => options.onProgress?.({ phase: 'delete', ...detail });
  let manifest;
  if (typeof manifestOrId === 'string') {
    try {
      report({ stage: 'manifest-read', id: manifestOrId });
      manifest = validateManifest(await remote.getJson(config, manifestName(manifestOrId)));
    } catch (_) {
      if (!/^(?:mmcloud|mmcloudnext)-[a-z0-9-]+$/i.test(manifestOrId)) throw new Error('云备份编号无效');
      const fallbackNames = [
        encryptedName(manifestOrId, 'data'),
        encryptedName(manifestOrId, 'assets'),
      ];
      for (let index = 0; index < fallbackNames.length; index += 1) {
        const name = fallbackNames[index];
        report({ stage: 'file', id: manifestOrId, name, index, total: fallbackNames.length + 1 });
        await remote.deleteFile(config, name, {
          onProgress: (progress) => report({
            stage: 'part',
            id: manifestOrId,
            name,
            index,
            total: fallbackNames.length + 1,
            partDeleted: Number(progress?.deleted || 0),
            partTotal: Number(progress?.total || 0),
          }),
        }).catch(() => {});
      }
      report({ stage: 'manifest', id: manifestOrId, index: fallbackNames.length, total: fallbackNames.length + 1 });
      await remote.deleteFile(config, manifestName(manifestOrId));
      report({ stage: 'complete', id: manifestOrId, index: fallbackNames.length + 1, total: fallbackNames.length + 1 });
      return { ok: true, id: manifestOrId };
    }
  } else {
    manifest = validateManifest(manifestOrId);
  }
  const files = (manifest.files || []).filter((file) => file?.name);
  const total = files.length + 1;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    report({ stage: 'file', id: manifest.id, name: file.name, kind: file.kind, index, total });
    await remote.deleteFile(config, file.name, {
      onProgress: (progress) => report({
        stage: 'part',
        id: manifest.id,
        name: file.name,
        kind: file.kind,
        index,
        total,
        partDeleted: Number(progress?.deleted || 0),
        partTotal: Number(progress?.total || 0),
      }),
    });
  }
  report({ stage: 'manifest', id: manifest.id, index: files.length, total });
  await remote.deleteFile(config, manifestName(manifest.id));
  report({ stage: 'complete', id: manifest.id, index: total, total });
  return { ok: true, id: manifest.id };
}

export async function deleteCloudBackup(manifestOrId, config = getCloudBackupPrefs(), options = {}) {
  return runCloudOperation(() => deleteCloudBackupNow(manifestOrId, config, options));
}

async function enforceCloudBackupRetentionNow(config = getCloudBackupPrefs(), retention = config.retention) {
  const keep = Math.max(1, Math.min(30, Math.round(Number(retention) || 5)));
  const backups = await listCloudBackups(config);
  const errors = [];
  const staleBefore = Date.now() - STALE_INCOMPLETE_BACKUP_MS;
  const staleIncomplete = backups.filter((item) => {
    if (item.complete && item.status === 'complete') return false;
    const createdAt = Date.parse(item.createdAt || '');
    return createdAt > 0 && createdAt < staleBefore;
  });
  for (const stale of staleIncomplete) {
    try {
      await deleteCloudBackupNow(stale, config);
    } catch (error) {
      errors.push(`${stale.id}：${error?.message || error}`);
    }
  }
  const completed = backups.filter((item) => item.complete && item.status === 'complete');
  for (const old of completed.slice(keep)) {
    try {
      await deleteCloudBackupNow(old, config);
    } catch (error) {
      errors.push(`${old.id}：${error?.message || error}`);
    }
  }
  return errors;
}

export async function enforceCloudBackupRetention(config = getCloudBackupPrefs(), retention = config.retention) {
  return runCloudOperation(() => enforceCloudBackupRetentionNow(config, retention));
}

export async function runAutomaticCloudBackupIfDue(options = {}) {
  let config = getCloudBackupPrefs();
  const remoteReady = config.provider === 'webdav' ? !!config.url : !!config.githubToken;
  if (!config.autoEnabled || !remoteReady || !config.encryptionPassword) return { ran: false, reason: 'disabled' };
  const last = Date.parse(config.lastBackupAt || '') || 0;
  if (Date.now() - last < config.intervalHours * 60 * 60 * 1000) return { ran: false, reason: 'not-due' };
  const lastAttempt = Date.parse(config.lastAutoAttemptAt || '') || 0;
  if (lastAttempt && Date.now() - lastAttempt < AUTO_FAILURE_BACKOFF_MS) return { ran: false, reason: 'backoff' };
  const lockOwner = acquireAutomaticLock();
  if (!lockOwner) return { ran: false, reason: 'locked' };
  const heartbeat = globalThis.setInterval?.(() => touchAutomaticLock(lockOwner), AUTO_LOCK_HEARTBEAT_MS);
  try {
    return await runCloudOperation(async () => {
      // 排队期间可能已有手动备份完成；真正开始前重新判断，避免紧接着再传一份。
      config = getCloudBackupPrefs();
      const latestRemoteReady = config.provider === 'webdav' ? !!config.url : !!config.githubToken;
      if (!config.autoEnabled || !latestRemoteReady || !config.encryptionPassword) return { ran: false, reason: 'disabled' };
      const latest = Date.parse(config.lastBackupAt || '') || 0;
      if (Date.now() - latest < config.intervalHours * 60 * 60 * 1000) return { ran: false, reason: 'not-due' };
      const latestAttempt = Date.parse(config.lastAutoAttemptAt || '') || 0;
      if (latestAttempt && Date.now() - latestAttempt < AUTO_FAILURE_BACKOFF_MS) return { ran: false, reason: 'backoff' };
      // 自动云备份宁可稍后再试，也不能与原生/浏览器安全快照、后台补任务、生成或
      // 用户刚开始的操作叠在一起。重任务窗口不干净时不记失败退避，由启动层稍后重排。
      if (!await automaticCloudBackupReady()) return { ran: false, reason: 'busy' };
      saveCloudBackupPrefs({ lastAutoAttemptAt: new Date().toISOString() });
      const result = await createCloudBackupNow(config, options);
      return { ran: true, ...result };
    });
  } finally {
    if (heartbeat) globalThis.clearInterval?.(heartbeat);
    releaseAutomaticLock(lockOwner);
  }
}
