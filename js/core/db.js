import {
  abortNativeReplaceImport,
  beginNativeReplaceImport,
  checkpointNativeReplaceImport,
  commitNativeReplaceImport,
  isNativeDataStoreEnabled,
  markNativeCacheCommit,
  markNativeCacheRebuildRequired,
  markNativeDatabaseRecreationDetected,
  mirrorNativeClear,
  mirrorNativeDelete,
  mirrorNativeDeleteMany,
  mirrorNativePut,
  mirrorNativePutMany,
  rebuildIndexedDbCacheIfNeeded,
  runNativeWriteExclusive,
  shouldAllowNativeDatabaseRecreation,
  verifyNativeIndexedDbCacheCurrent,
} from './native-data-store.js';
import { runStorageMaintenanceExclusive } from './storage-maintenance.js';

const DB_NAME = 'MarshmallowPhoneDB';
// v20 曾只为测试中的电台临时加表，导致旧 APK 无法通过 OTA 安全升级。
// 电台已改用现有 settings 表；逻辑版本回到 APK 兼容的 v19。若网页端已短暂
// 打开过 v20，openConnection 会无版本号兼容打开，绝不删除或降级现有数据库。
const DB_VERSION = 19;

const STORES = {
  settings: { keyPath: 'key' },
  users: { keyPath: 'id', indices: ['name'] },
  characters: { keyPath: 'id', indices: ['name', 'roleTier'] },
  aliasAccounts: { keyPath: 'id', indices: ['ownerKey', 'ownerType', 'ownerId', 'userId', 'updatedAt'] },
  chats: { keyPath: 'id', indices: ['userId', 'lastActivity', 'type'] },
  messages: { keyPath: 'id', indices: ['chatId', 'timestamp', 'senderId', { name: 'chatId_timestamp', keyPath: ['chatId', 'timestamp'] }] },
  memories: { keyPath: 'id', indices: ['chatId', 'characterId', 'userId', 'timestamp'] },
  memoryFacts: { keyPath: 'id', indices: ['userId', 'chatId', 'subjectId', 'updatedAt'] },
  eventMemories: { keyPath: 'id', indices: ['userId', 'timestamp'] },
  memoryVectors: { keyPath: 'id', indices: ['sourceId', 'namespace', 'userId', 'status', 'updatedAt'] },
  sharedEventKnowledge: { keyPath: 'id', indices: ['chatId', 'userId', 'timestamp'] },
  momentsPosts: { keyPath: 'id', indices: ['authorId', 'userId', 'timestamp'] },
  weiboPosts: { keyPath: 'id', indices: ['authorId', 'timestamp'] },
  forumThreads: { keyPath: 'id', indices: ['userId', 'sectionId'] },
  worldBooks: { keyPath: 'id', indices: ['category', 'userId', 'bookId', 'groupId'] },
  stickerPacks: { keyPath: 'id', indices: ['name'] },
  collectibles: { keyPath: 'id', indices: ['userId', 'characterId', 'ownership', 'timestamp'] },
  auStories: { keyPath: 'id', indices: ['userId', 'characterId', 'updatedAt'] },
  musicTracks: { keyPath: 'id', indices: ['ownerId', 'source', 'updatedAt'] },
  soundAssets: { keyPath: 'id', indices: ['ownerId', 'category', 'updatedAt'] },
  musicPlaylists: { keyPath: 'id', indices: ['ownerId', 'ownerType', 'updatedAt'] },
  musicPosts: { keyPath: 'id', indices: ['authorId', 'trackId', 'updatedAt'] },
  streamerChannels: { keyPath: 'id', indices: ['userId', 'sourceType', 'updatedAt'] },
  streamerFanState: { keyPath: 'id', indices: ['userId', 'channelId'] },
  streamerLedger: { keyPath: 'userId' },
  streamerRecordings: { keyPath: 'id', indices: ['channelId', 'userId', 'endedAt'] },
  beautifyAssets: { keyPath: 'id', indices: ['type', 'name', 'updatedAt'] },
};

// 华为 / 鸿蒙从主屏 PWA 冷启动时，浏览器存储进程唤醒可能明显慢于普通标签页。
// 18 秒会在连接最终成功前先把整次启动判死；放宽后仍保留明确超时，而不是无限等待。
const IDB_OPEN_TIMEOUT_MS = 45000;
const IDB_AUTO_RELOAD_GUARD_KEY = '__mm_idb_auto_reload_at__';
const IDB_AUTO_RELOAD_COOLDOWN_MS = 120000;
const IDB_LAST_TRANSIENT_EVENT_KEY = '__mm_idb_last_transient_event__';
const KNOWN_DATABASE_MARKER_KEY = '__mm_known_nonempty_database__';
const IDB_DATA_LOSS_EVENT_KEY = '__mm_idb_data_loss_event__';
const IDB_DELETE_JOURNAL_KEY = '__mm_idb_delete_journal_v1__';
const IDB_MAINTENANCE_CHANNEL = 'marshmallow-idb-maintenance-v1';
const IDB_UNEXPECTED_RECREATION_RETRY_DELAYS_MS = [180, 650, 1600];

let _db = null;
let _openPromise = null;
let _transientRecoveryPromise = null;
let _criticalOperationQueue = Promise.resolve();
let _idbRecoveryAttempted = false;
let _recoveryUiPromise = null;
let _unexpectedRecreationNavigationScheduled = false;
let _unexpectedRecreationProbeCount = 0;
const _errorConnections = new WeakMap();
const _dbClientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let _maintenanceChannel = null;

function rememberDeleteJournal(detail = {}) {
  try {
    const previous = JSON.parse(globalThis.localStorage?.getItem(IDB_DELETE_JOURNAL_KEY) || 'null') || {};
    globalThis.localStorage?.setItem(IDB_DELETE_JOURNAL_KEY, JSON.stringify({
      ...previous,
      ...detail,
      clientId: _dbClientId,
      build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
      href: String(globalThis.location?.href || ''),
      updatedAt: Date.now(),
    }));
  } catch (_) {}
}

function installMaintenanceChannel() {
  if (
    _maintenanceChannel
    || typeof globalThis.window === 'undefined'
    || typeof globalThis.BroadcastChannel !== 'function'
  ) return;
  try {
    _maintenanceChannel = new globalThis.BroadcastChannel(IDB_MAINTENANCE_CHANNEL);
    _maintenanceChannel.addEventListener('message', (event) => {
      const detail = event?.data || {};
      if (detail.type !== 'close-connections' || detail.clientId === _dbClientId) return;
      invalidateConnection();
      _openPromise = null;
      try {
        _maintenanceChannel.postMessage({
          type: 'connections-closed',
          requestId: detail.requestId,
          clientId: _dbClientId,
        });
      } catch (_) {}
    });
  } catch (_) {
    _maintenanceChannel = null;
  }
}

installMaintenanceChannel();

function readKnownDatabaseMarker() {
  try {
    const raw = globalThis.localStorage?.getItem(KNOWN_DATABASE_MARKER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function isUnexpectedDatabaseRecreation(oldVersion, marker = readKnownDatabaseMarker()) {
  return Number(oldVersion || 0) === 0 && !!marker;
}

function unexpectedDatabaseRecreationError(marker = null) {
  const error = new Error(
    '检测到当前打开位置以前保存过数据，但本地数据库暂时被浏览器当作全新数据库打开。'
    + '应用已停止创建空库，并会先复核存储进程；请勿卸载或清除应用/网站数据。',
  );
  error.name = 'MarshmallowUnexpectedDatabaseRecreationError';
  error.marker = marker;
  return error;
}

function navigateToUnexpectedDatabaseRecovery() {
  if (_unexpectedRecreationNavigationScheduled) return true;
  try {
    const location = globalThis.location;
    const path = String(location?.pathname || '');
    if (!location?.replace || /\/recovery(?:\.html)?\/?$/i.test(path)) return false;
    _unexpectedRecreationNavigationScheduled = true;
    const build = encodeURIComponent(String(globalThis.__MARSHMALLOW_BUILD__ || ''));
    setTimeout(() => {
      location.replace(`recovery.html?reason=unexpected-database-recreation${build ? `&build=${build}` : ''}`);
    }, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function rememberIndexedDbDataLossEvent(event, marker, {
  blockedUnexpectedCreation = false,
  unexpectedRecreation = false,
  confirmed = false,
} = {}) {
  const dataLoss = String(event?.dataLoss || '');
  const dataLossMessage = String(event?.dataLossMessage || '');
  if (!unexpectedRecreation && (!dataLoss || dataLoss === 'none') && !dataLossMessage) return;
  try {
    let previous = null;
    try {
      previous = JSON.parse(globalThis.localStorage?.getItem(IDB_DATA_LOSS_EVENT_KEY) || 'null');
    } catch (_) {}
    let lastDelete = null;
    try {
      lastDelete = JSON.parse(globalThis.localStorage?.getItem(IDB_DELETE_JOURNAL_KEY) || 'null');
    } catch (_) {}
    globalThis.localStorage?.setItem(IDB_DATA_LOSS_EVENT_KEY, JSON.stringify({
      detectedAt: Date.now(),
      build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
      oldVersion: Number(event?.oldVersion || 0),
      newVersion: Number(event?.newVersion || DB_VERSION),
      dataLoss: dataLoss || 'unknown',
      dataLossMessage,
      blockedUnexpectedCreation: blockedUnexpectedCreation === true,
      confirmed: confirmed === true,
      firstDetectedAt: Number(previous?.firstDetectedAt || previous?.detectedAt || Date.now()),
      detectionCount: Math.max(1, Number(previous?.detectionCount || 0) + 1),
      continuedAfterUnexpectedCreation: unexpectedRecreation === true
        && blockedUnexpectedCreation !== true,
      knownDatabase: marker || null,
      lastDelete: lastDelete || null,
    }));
  } catch (_) {}
}

function markUnexpectedDatabaseRecreationConfirmed() {
  try {
    const previous = JSON.parse(globalThis.localStorage?.getItem(IDB_DATA_LOSS_EVENT_KEY) || 'null');
    if (!previous || typeof previous !== 'object') return;
    globalThis.localStorage?.setItem(IDB_DATA_LOSS_EVENT_KEY, JSON.stringify({
      ...previous,
      confirmed: true,
      confirmedAt: Date.now(),
      confirmationAttempts: _unexpectedRecreationProbeCount,
    }));
  } catch (_) {}
}

function clearResolvedUnexpectedDatabaseRecreation() {
  if (_unexpectedRecreationProbeCount <= 0) return;
  try {
    const previous = JSON.parse(globalThis.localStorage?.getItem(IDB_DATA_LOSS_EVENT_KEY) || 'null');
    if (previous?.blockedUnexpectedCreation === true) {
      globalThis.localStorage?.removeItem(IDB_DATA_LOSS_EVENT_KEY);
    }
  } catch (_) {}
  _unexpectedRecreationProbeCount = 0;
}

function invalidateConnection(expectedDb = null) {
  const target = expectedDb || _db;
  if (!target) return;
  try { target.close(); } catch (_) {}
  if (_db === target) _db = null;
}

function rememberErrorConnection(error, db) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || !db) return;
  try { _errorConnections.set(error, db); } catch (_) {}
}

function getErrorConnection(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null;
  try { return _errorConnections.get(error) || null; } catch (_) { return null; }
}

function indexedDbCriticalActivitySnapshot() {
  const safety = globalThis.__mm_update_safety_state__ || {};
  const criticalCount = Number(safety.criticalCount || 0);
  const chatGenerationCount = Number(globalThis.__mm_chat_generation_active__ || 0);
  const manualGenerationCount = Number(globalThis.__mm_manual_generation_active__ || 0);
  let riskyActivity = null;
  try {
    riskyActivity = JSON.parse(globalThis.localStorage?.getItem('__mm_risky_activity__') || 'null');
  } catch (_) {}
  return {
    active: criticalCount > 0 || chatGenerationCount > 0 || manualGenerationCount > 0,
    criticalCount,
    chatGenerationCount,
    manualGenerationCount,
    labels: safety.labels && typeof safety.labels === 'object' ? { ...safety.labels } : {},
    riskyActivity: riskyActivity && typeof riskyActivity === 'object' ? riskyActivity : null,
  };
}

export function shouldDeferIndexedDbAutoReload() {
  return indexedDbCriticalActivitySnapshot().active;
}

export function isIosWebKitRuntime(navigatorLike = globalThis.navigator) {
  const userAgent = String(navigatorLike?.userAgent || '');
  const platform = String(navigatorLike?.platform || '');
  const touchPoints = Number(navigatorLike?.maxTouchPoints || 0);
  return /iPhone|iPad|iPod/i.test(userAgent)
    || (/Mac/i.test(platform) && touchPoints > 1);
}

function rememberIndexedDbTransientEvent(error, activity, autoReloadBlocked, blockedReason = '') {
  try {
    globalThis.localStorage?.setItem(IDB_LAST_TRANSIENT_EVENT_KEY, JSON.stringify({
      detectedAt: Date.now(),
      build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
      name: String(error?.name || ''),
      message: String(error?.message || error || '').slice(0, 500),
      autoReloadBlocked: autoReloadBlocked === true,
      blockedReason: String(blockedReason || ''),
      activity,
    }));
  } catch (_) {}
}

function scheduleReloadForBrokenIndexedDb(error) {
  if (typeof globalThis.location?.reload !== 'function') return false;
  const activity = indexedDbCriticalActivitySnapshot();
  const iosWebKit = isIosWebKitRuntime();
  if (activity.active || iosWebKit) {
    const blockedReason = iosWebKit ? 'ios-webkit' : 'critical-activity';
    rememberIndexedDbTransientEvent(error, activity, true, blockedReason);
    console.warn(
      iosWebKit
        ? '[MarshmallowPhoneDB] iOS 数据库重连失败；已禁止自动整页刷新并把错误交还当前任务:'
        : '[MarshmallowPhoneDB] 关键操作期间数据库重连失败；已阻止整页刷新并把错误交还当前任务:',
      error?.name,
      error?.message,
    );
    return false;
  }
  rememberIndexedDbTransientEvent(error, activity, false, '');
  let lastReloadAt = 0;
  try {
    const guardStorage = globalThis.sessionStorage;
    if (!guardStorage) return false;
    lastReloadAt = Number(guardStorage.getItem(IDB_AUTO_RELOAD_GUARD_KEY) || 0);
    if (lastReloadAt > Date.now() - IDB_AUTO_RELOAD_COOLDOWN_MS) return false;
    guardStorage.setItem(IDB_AUTO_RELOAD_GUARD_KEY, String(Date.now()));
  } catch (_) {
    // 没有可靠的跨 reload 防循环标记时宁可把错误交给界面，也不自动刷新。
    return false;
  }
  console.warn(
    '[MarshmallowPhoneDB] WebKit 数据库进程重连失败，将整页刷新一次以重建 IDBFactory:',
    error?.name,
    error?.message,
  );
  globalThis.setTimeout(() => globalThis.location.reload(), 120);
  return true;
}

export function isIndexedDbTransientError(e) {
  if (!e) return false;
  const name = String(e.name || '');
  const msg = String(e.message || '');
  return (
    /connection is closing|connection has been lost|connection to (?:the )?indexed database server lost|database has been closed|database connection (?:has been )?lost/i.test(msg)
    || (name === 'UnknownError' && /indexed\s*database|database server|connection/i.test(msg))
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transactionError(tx, fallback = 'IndexedDB transaction aborted') {
  return tx?.error || new Error(fallback);
}

async function verifyConnection(db) {
  if (!db) throw new Error('Database not open');
  await new Promise((resolve, reject) => {
    let settled = false;
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get('__mm_idb_connection_probe__');
    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(req.error || transactionError(tx));
    };
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = () => {
      if (settled) return;
      settled = true;
      reject(transactionError(tx));
    };
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      reject(transactionError(tx));
    };
  });
  return db;
}

/**
 * iOS 会在内存压力或前后台切换时重启 WebKit 的数据库进程。所有并发事务必须共用
 * 同一条重连通道；否则每个失败事务都会 close/open，一条刚恢复的连接又会被另一条
 * 旧事务关掉，最终表现为聊天、备份和页面一起闪烁。
 */
async function recoverTransientConnection(failedConnection = null) {
  if (_transientRecoveryPromise) return _transientRecoveryPromise;
  const recovery = (async () => {
    const retryDelays = [120, 350, 800, 1600, 3000, 5000];
    let lastError = null;
    let connectionToReplace = failedConnection || _db;

    // 旧事务的错误可能晚于另一条事务的重连结果到达。此时只验证当前新连接，
    // 绝不能因为旧连接报错而把已经恢复的连接再次 close。
    if (failedConnection && _db && failedConnection !== _db) {
      const currentConnection = _db;
      invalidateConnection(failedConnection);
      try {
        return await verifyConnection(currentConnection);
      } catch (error) {
        lastError = error;
        connectionToReplace = currentConnection;
      }
    }

    invalidateConnection(connectionToReplace);
    for (const waitMs of retryDelays) {
      await delay(waitMs);
      let candidate = null;
      try {
        candidate = await openConnection();
        return await verifyConnection(candidate);
      } catch (error) {
        lastError = error;
        // 只作废本轮实际验证失败的连接；并发恢复出的其它连接不受影响。
        invalidateConnection(candidate);
        if (!isIndexedDbTransientError(error) && error?.name !== 'InvalidStateError') throw error;
      }
    }
    throw lastError || new Error('IndexedDB reconnect failed');
  })();
  _transientRecoveryPromise = recovery;
  try {
    return await recovery;
  } finally {
    if (_transientRecoveryPromise === recovery) _transientRecoveryPromise = null;
  }
}

/**
 * 写入通知：上层 store（角色/档位/分组等）用它做内存缓存失效。
 * 所有 IndexedDB 写入都走本文件，因此在这里统一广播即可覆盖任何写路径
 * （包括备份恢复、clearStore、绕过业务 store 的直接 putRecord）。
 */
const _writeListeners = new Map();
let _suppressWriteNotify = false;

export function setSuppressWriteNotify(suppress) {
  _suppressWriteNotify = !!suppress;
}

export function flushWriteListeners() {
  notifyAllStoresWritten();
}

export function onStoreWrite(storeName, fn) {
  if (typeof fn !== 'function') return () => {};
  if (!_writeListeners.has(storeName)) _writeListeners.set(storeName, new Set());
  _writeListeners.get(storeName).add(fn);
  return () => _writeListeners.get(storeName)?.delete(fn);
}

function notifyWrite(storeName, key, detail = undefined) {
  if (_suppressWriteNotify) return;
  const fns = _writeListeners.get(storeName);
  if (!fns) return;
  for (const fn of fns) {
    try { fn(key, detail); } catch (_) {}
  }
}

function notifyAllStoresWritten() {
  for (const storeName of _writeListeners.keys()) notifyWrite(storeName, undefined);
}

function isIndexedDbFatalError(e) {
  if (!e) return false;
  if (isIndexedDbTransientError(e)) return false;
  const name = String(e.name || '');
  // 一键修复兼容期内，InvalidStateError 常见于 SW/缓存刚卸掉后的瞬时态，
  // 不应直接把用户推到「清空本地库」弹窗。
  if (name === 'InvalidStateError') {
    try {
      const until = Number(globalThis.localStorage?.getItem('__mm_sw_repair_until__') || 0);
      if (until > Date.now()) return false;
    } catch (_) {}
  }
  if (name === 'NotReadableError' || name === 'NotFoundError') return true;
  if (name === 'InvalidStateError') return true;
  const msg = String(e.message || '');
  if (/irrecoverable|missing file|Data lost/i.test(msg)) return true;
  return false;
}

function waitForUserRecoveryChoice(err) {
  if (_recoveryUiPromise) return _recoveryUiPromise;
  _recoveryUiPromise = new Promise((resolve) => {
    const finish = (choice) => {
      _recoveryUiPromise = null;
      resolve(choice);
    };
    globalThis.dispatchEvent(new CustomEvent('marshmallow-idb-needs-recovery', {
      detail: {
        error: err,
        resolve: finish,
      },
    }));
  });
  return _recoveryUiPromise;
}

async function requestPeerConnectionsClose(requestId) {
  installMaintenanceChannel();
  invalidateConnection();
  _openPromise = null;
  if (!_maintenanceChannel) return;
  try {
    _maintenanceChannel.postMessage({
      type: 'close-connections',
      requestId,
      clientId: _dbClientId,
    });
  } catch (_) {}
  // 给其它同源标签页 / PWA 一个 versionchange 之前主动收口事务的窗口。
  await delay(450);
}

async function hardResetIndexedDb(reason = 'verified-restore') {
  return runStorageMaintenanceExclusive('本地库重建', async () => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    rememberDeleteJournal({
      requestId,
      reason: String(reason || 'unknown'),
      status: 'preparing',
      startedAt: Date.now(),
    });
    await requestPeerConnectionsClose(requestId);
    rememberDeleteJournal({ requestId, status: 'deleting' });
    try {
      await new Promise((resolve, reject) => {
        const del = indexedDB.deleteDatabase(DB_NAME);
        del.onsuccess = () => resolve();
        del.onerror = () => reject(del.error || new Error('IndexedDB delete failed'));
        del.onblocked = () => {
          rememberDeleteJournal({ requestId, status: 'blocked' });
          try {
            globalThis.dispatchEvent?.(new CustomEvent('marshmallow-idb-delete-blocked', {
              detail: { requestId, reason: String(reason || '') },
            }));
          } catch (_) {}
        };
      });
      rememberDeleteJournal({ requestId, status: 'deleted' });
      // 走到这里时旧 backing store 已经被明确删除。继续保留“旧库曾非空”标记
      // 会让下面合法的 v0 -> 当前版本建库再次被空库保护中止。
      try {
        globalThis.localStorage?.removeItem(KNOWN_DATABASE_MARKER_KEY);
        globalThis.localStorage?.removeItem(IDB_DATA_LOSS_EVENT_KEY);
      } catch (_) {}
      await openConnection();
      notifyAllStoresWritten();
      rememberDeleteJournal({ requestId, status: 'rebuilt', completedAt: Date.now() });
    } catch (error) {
      rememberDeleteJournal({
        requestId,
        status: 'failed',
        name: String(error?.name || ''),
        message: String(error?.message || error || '').slice(0, 500),
      });
      throw error;
    }
  }, { ifAvailable: true });
}

/**
 * 仅供已通过外部备份完整性校验的恢复流程使用。调用方必须先验证备份，再在
 * backing store 已损坏、无法写入时重建主库；普通启动和一键修复不得调用。
 */
export async function resetIndexedDbForVerifiedRestore() {
  await hardResetIndexedDb('verified-backup-restore');
  return true;
}

export async function trySalvageDumpStores() {
  const dump = {};
  try {
    const dbInst = await new Promise((resolve, reject) => {
      let retriedNewerDatabase = false;
      const attach = (req) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          if (!retriedNewerDatabase && req.error?.name === 'VersionError') {
            retriedNewerDatabase = true;
            attach(indexedDB.open(DB_NAME));
            return;
          }
          reject(req.error);
        };
      };
      attach(indexedDB.open(DB_NAME, DB_VERSION));
    });
    const names = [...dbInst.objectStoreNames];
    for (const name of names) {
      try {
        const rows = await new Promise((resolve, reject) => {
          const tx = dbInst.transaction(name, 'readonly');
          const r = tx.objectStore(name).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        dump[name] = rows;
      } catch (sub) {
        dump[name] = { __readError: String(sub?.message || sub) };
      }
    }
    dbInst.close();
    return { ok: true, dump };
  } catch (e) {
    return { ok: false, error: e, dump };
  }
}

async function withIdbRecovery(fn) {
  const maxAttempts = 4;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (
        e?.name === 'MarshmallowUnexpectedDatabaseRecreationError'
        && attempt < IDB_UNEXPECTED_RECREATION_RETRY_DELAYS_MS.length
      ) {
        // WebKit / 部分 Android WebView 在存储进程刚唤醒或崩溃重启时，偶尔会把
        // 已有库短暂报告成 v0。始终中止这次建库，但先在当前页面原地复核，不能
        // 因一次瞬时结果立刻跳急救页并形成“空库”循环。
        await delay(IDB_UNEXPECTED_RECREATION_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (isIndexedDbTransientError(e) || (e?.name === 'InvalidStateError' && attempt < maxAttempts - 1)) {
        try {
          await recoverTransientConnection(getErrorConnection(e));
        } catch (recoveryError) {
          lastError = recoveryError;
          break;
        }
        continue;
      }
      break;
    }
  }
  const e = lastError;
  // 多次复核后仍是“旧数据痕迹仍在、IndexedDB 文件却从 v0 开始”。各页面继续
  // 重试只会刷出相同报错；统一进入不加载主程序的急救页，再按当前环境恢复。
  if (e?.name === 'MarshmallowUnexpectedDatabaseRecreationError') {
    markUnexpectedDatabaseRecreationConfirmed();
    navigateToUnexpectedDatabaseRecovery();
    throw e;
  }
  // 某些浏览器在存储进程崩溃后会把当前页面的 IDBFactory 留在失效代理上。
  // iOS 禁止自动刷新，避免把 WebKit 进程终止和应用自救刷新混在一起；其它平台
  // 空闲期仍只允许自动整页恢复一次，并用 sessionStorage 防止刷新循环。
  if (isIndexedDbTransientError(e) && scheduleReloadForBrokenIndexedDb(e)) {
    await delay(3000);
  }
  if (!_idbRecoveryAttempted && isIndexedDbFatalError(e)) {
    const choice = await waitForUserRecoveryChoice(e);
    if (choice === 'reload') {
      globalThis.location.reload();
      return new Promise(() => {});
    }
    if (choice === 'reset') {
      _idbRecoveryAttempted = true;
      console.warn('[MarshmallowPhoneDB] 用户确认后重建本地库:', e?.name, e?.message);
      try {
        const nativeEnabled = await isNativeDataStoreEnabled().catch(() => false);
        await hardResetIndexedDb('user-confirmed-fatal-recovery');
        if (nativeEnabled) {
          markNativeCacheRebuildRequired('user-confirmed-fatal-recovery');
          const nativeStore = await import('./native-data-store.js');
          await nativeStore.rebuildIndexedDbCacheIfNeeded();
        }
        globalThis.dispatchEvent(new CustomEvent('marshmallow-idb-recovered', { detail: { userInitiated: true } }));
      } catch (resetErr) {
        console.error('[MarshmallowPhoneDB] 重置失败', resetErr);
        throw e;
      }
      return await fn();
    }
    throw e;
  }
  throw e;
}

async function runWithDb(fn) {
  const execute = () => withIdbRecovery(async () => {
    const connection = await openConnection();
    try {
      return await fn(connection);
    } catch (error) {
      rememberErrorConnection(error, connection);
      throw error;
    }
  });
  const activity = indexedDbCriticalActivitySnapshot();
  const isIosWebKit = isIosWebKitRuntime();
  if (!activity.active || !isIosWebKit) return execute();

  // iOS 在聊天生成或备份期间同时创建多条 IndexedDB 事务，容易先压断独立的
  // 数据库存储进程。关键阶段改为单通道排队；普通浏览与后台空闲期仍保留原并发。
  const previous = _criticalOperationQueue.catch(() => {});
  let release;
  _criticalOperationQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await execute();
  } finally {
    release();
  }
}

function createIndexIfMissing(store, spec) {
  const name = typeof spec === 'string' ? spec : spec?.name;
  const keyPath = typeof spec === 'string' ? spec : spec?.keyPath;
  if (!name || !keyPath || store.indexNames.contains(name)) return;
  store.createIndex(name, keyPath, { unique: false });
}

function runUpgrade(db, e) {
  for (const [name, cfg] of Object.entries(STORES)) {
    if (!db.objectStoreNames.contains(name)) {
      const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
      if (cfg.indices) {
        for (const idx of cfg.indices) createIndexIfMissing(store, idx);
      }
    }
  }
  if (e?.target?.transaction) {
    for (const [name, cfg] of Object.entries(STORES)) {
      if (!db.objectStoreNames.contains(name)) continue;
      const store = e.target.transaction.objectStore(name);
      if (!cfg.indices) continue;
      for (const idx of cfg.indices) createIndexIfMissing(store, idx);
    }
  }
}

function openConnection() {
  // 不要为每一次真实读写先创建“探活事务”。它无法保证随后仍存活，却会让聊天
  // 落库平白多出一到两个事务；连接真失效时由真实事务抛错并进入共享重连即可。
  if (_db) return Promise.resolve(_db);
  if (_openPromise) return _openPromise;

  _openPromise = (async () => {
    let abandoned = false;
    let blockedRecreationError = null;
    const nativeRecreationAllowed = await shouldAllowNativeDatabaseRecreation();
    const attempt = new Promise((resolve, reject) => {
      let retriedNewerDatabase = false;
      const attach = (req) => {
      req.onupgradeneeded = (e) => {
        const marker = readKnownDatabaseMarker();
        const unexpectedRecreation = isUnexpectedDatabaseRecreation(e.oldVersion, marker);
        if (unexpectedRecreation && !nativeRecreationAllowed) {
          // localStorage 仍记得旧库，IndexedDB 却从 v0 开始，说明当前存储源已经
          // 丢失或换成了空库。此时建表、补档或继续写入都会覆盖故障现场，并让用户
          // 误以为原数据被业务代码清空；中止 versionchange，交给急救页恢复旁路备份。
          blockedRecreationError = unexpectedDatabaseRecreationError(marker);
          _unexpectedRecreationProbeCount += 1;
          rememberIndexedDbDataLossEvent(e, marker, {
            blockedUnexpectedCreation: true,
            unexpectedRecreation: true,
            confirmed: false,
          });
          try { e.target.transaction.abort(); } catch (_) {}
          return;
        }
        rememberIndexedDbDataLossEvent(e, marker, nativeRecreationAllowed && unexpectedRecreation
          ? { unexpectedRecreation: true, restoredFromNativeVault: true }
          : undefined);
        if (nativeRecreationAllowed && unexpectedRecreation) {
          markNativeDatabaseRecreationDetected();
        }
        runUpgrade(e.target.result, e);
      };
      req.onsuccess = (e) => {
        const openedDb = e.target.result;
        // iOS 上 open() 偶尔会在超时后才成功。超时调用方已经开始下一轮重连，
        // 晚到连接不能再覆盖新连接，否则两条连接会互相触发关闭/重试。
        if (abandoned) {
          try { openedDb.close(); } catch (_) {}
          return;
        }
        _db = openedDb;
        clearResolvedUnexpectedDatabaseRecreation();
        openedDb.onclose = () => {
          if (_db === openedDb) _db = null;
        };
        openedDb.onversionchange = () => {
          console.warn('[MarshmallowPhoneDB] 检测到其它标签页升级/重建本地库，本页连接已关闭，请刷新。');
          invalidateConnection(openedDb);
        };
        resolve(openedDb);
      };
      req.onerror = () => {
        if (!retriedNewerDatabase && req.error?.name === 'VersionError') {
          retriedNewerDatabase = true;
          attach(indexedDB.open(DB_NAME));
          return;
        }
        reject(
          blockedRecreationError
          || req.error
          || new Error('IndexedDB 打开失败'),
        );
      };
      req.onblocked = () => {
        console.warn('[MarshmallowPhoneDB] indexedDB.open 被阻塞：请关闭本站其他标签页后刷新。');
      };
      };
      attach(indexedDB.open(DB_NAME, DB_VERSION));
    });
    let timeoutId = 0;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        abandoned = true;
        reject(new Error(
          '本地数据库（IndexedDB）打开超时。请关闭本站其他标签页后刷新；仍失败请检查手机存储空间，或打开 /recovery 一键修复（只清启动缓存，不会删聊天）。',
        ));
      }, IDB_OPEN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      _openPromise = null;
    }
  })();

  return _openPromise;
}

export function open() {
  return runWithDb(async (connection) => connection);
}

function assertStore(storeName) {
  if (!STORES[storeName]) throw new Error(`Unknown store: ${storeName}`);
}

function objectStore(storeName, mode) {
  if (!_db) {
    if (typeof DOMException === 'function') {
      throw new DOMException('Database not open', 'InvalidStateError');
    }
    const error = new Error('Database not open');
    error.name = 'InvalidStateError';
    throw error;
  }
  assertStore(storeName);
  const tx = _db.transaction(storeName, mode);
  return tx.objectStore(storeName);
}

function promisifyRequest(req, options = {}) {
  const waitForTransaction = options.waitForTransaction === true;
  return new Promise((resolve, reject) => {
    let requestResult;
    let requestSucceeded = false;
    req.onsuccess = () => {
      requestResult = req.result;
      requestSucceeded = true;
      if (!waitForTransaction || !req.transaction) resolve(requestResult);
    };
    req.onerror = () => reject(req.error);
    if (waitForTransaction && req.transaction) {
      const tx = req.transaction;
      tx.oncomplete = () => {
        if (requestSucceeded) resolve(requestResult);
      };
      tx.onerror = () => reject(tx.error || req.error);
      tx.onabort = () => reject(
        tx.error
        || req.error
        || new DOMException('IndexedDB transaction aborted', 'AbortError'),
      );
    }
  });
}

function preserveNativeCommitAfterCacheFailure(storeName, operation, fallbackResult, error) {
  markNativeCacheRebuildRequired(`${operation}:${storeName}`, error);
  try {
    globalThis.__mmlog?.(
      'warn',
      `原生主库已提交，IndexedDB 缓存写入失败，等待回建：${operation}:${storeName} `
        + `${error?.name || 'Error'} ${error?.message || error || ''}`,
    );
  } catch (_) {}
  return fallbackResult;
}

async function retryIndexedDbCacheWrite(writeIndexedDb, firstError) {
  const failedConnection = _db;
  if (
    isIndexedDbTransientError(firstError)
    || firstError?.name === 'InvalidStateError'
    || firstError?.name === 'AbortError'
  ) {
    await recoverTransientConnection(failedConnection);
  } else {
    // 即使不是连接错误，也给被并发事务短暂中止的写入一次全新事务机会。
    await delay(60);
  }
  return writeIndexedDb();
}

async function finishIndexedDbCacheWriteAfterNativeCommit({
  storeName,
  operation,
  fallbackResult,
  nativeResult,
  writeIndexedDb,
}) {
  try {
    const result = await writeIndexedDb();
    markNativeCacheCommit(nativeResult);
    return result;
  } catch (firstError) {
    try {
      const result = await retryIndexedDbCacheWrite(writeIndexedDb, firstError);
      markNativeCacheCommit(nativeResult);
      return result;
    } catch (retryError) {
      return preserveNativeCommitAfterCacheFailure(
        storeName,
        operation,
        fallbackResult,
        retryError,
      );
    }
  }
}

function nativeWritePriority(storeName, key = '') {
  if (storeName !== 'settings') return 'foreground';
  const normalizedKey = String(key || '');
  return normalizedKey === 'currentUserId'
    || normalizedKey === 'chatGenerationTaskIndex_v1'
    || normalizedKey.startsWith('chatGenerationTask_v1_')
    ? 'foreground'
    : 'background';
}

async function writeWithNativePut(storeName, key, record, writeIndexedDb) {
  if (!(await isNativeDataStoreEnabled())) return writeIndexedDb();
  return runNativeWriteExclusive(async () => {
    const nativeResult = await mirrorNativePut(storeName, key, record);
    return finishIndexedDbCacheWriteAfterNativeCommit({
      storeName, operation: 'put', fallbackResult: key, nativeResult, writeIndexedDb,
    });
  }, { priority: nativeWritePriority(storeName, key) });
}

async function writeWithNativeDelete(storeName, key, writeIndexedDb) {
  if (!(await isNativeDataStoreEnabled())) return writeIndexedDb();
  return runNativeWriteExclusive(async () => {
    const nativeResult = await mirrorNativeDelete(storeName, key);
    return finishIndexedDbCacheWriteAfterNativeCommit({
      storeName, operation: 'delete', fallbackResult: undefined, nativeResult, writeIndexedDb,
    });
  }, { priority: nativeWritePriority(storeName, key) });
}

async function writeWithNativeClear(storeName, writeIndexedDb) {
  if (!(await isNativeDataStoreEnabled())) return writeIndexedDb();
  return runNativeWriteExclusive(async () => {
    const nativeResult = await mirrorNativeClear(storeName);
    return finishIndexedDbCacheWriteAfterNativeCommit({
      storeName, operation: 'clear', fallbackResult: undefined, nativeResult, writeIndexedDb,
    });
  }, { priority: nativeWritePriority(storeName) });
}

/** settings: get(key) 或 get('settings', key)；其它 store: get(store, id) */
export async function get(a, b) {
  return runWithDb(async () => {
    if (b !== undefined) {
      if (a === 'settings') {
        return promisifyRequest(objectStore('settings', 'readonly').get(b));
      }
      return promisifyRequest(objectStore(a, 'readonly').get(b));
    }
    return promisifyRequest(objectStore('settings', 'readonly').get(a));
  });
}

/** settings: put({key,value}) 或 put('settings', {key,value})；其它 store: put(store, record) */
export async function put(a, b) {
  return runWithDb(async () => {
    if (b !== undefined) {
      const storeName = a === 'settings' ? 'settings' : a;
      const key = b?.[STORES[storeName]?.keyPath];
      return writeWithNativePut(storeName, key, b, async () => {
        const result = await promisifyRequest(objectStore(storeName, 'readwrite').put(b), { waitForTransaction: true });
        notifyWrite(storeName, key, { operation: 'put', record: b });
        return result;
      });
    }
    return writeWithNativePut('settings', a?.key, a, async () => {
      const result = await promisifyRequest(objectStore('settings', 'readwrite').put(a), { waitForTransaction: true });
      notifyWrite('settings', a?.key, { operation: 'put', record: a });
      return result;
    });
  });
}

/**
 * 仅供“IndexedDB 作为原生主库缓存”的自身元数据使用。
 * 这类记录描述的是当前网页缓存，不属于业务数据，不能再镜像回原生主库，
 * 否则写入完成序号本身又会推进原生序号，形成永远追不上的循环。
 */
export async function getCacheOnlySetting(key) {
  const cacheKey = String(key || '').trim();
  if (!cacheKey) return null;
  return runWithDb(async () => (
    promisifyRequest(objectStore('settings', 'readonly').get(cacheKey))
  ));
}

export async function putCacheOnlySetting(key, value) {
  const cacheKey = String(key || '').trim();
  if (!cacheKey) return null;
  return runWithDb(async () => {
    const record = { key: cacheKey, value };
    const result = await promisifyRequest(
      objectStore('settings', 'readwrite').put(record),
      { waitForTransaction: true },
    );
    notifyWrite('settings', cacheKey, { operation: 'put', record });
    return result;
  });
}

export async function remove(key) {
  return runWithDb(async () => {
    return writeWithNativeDelete('settings', key, async () => {
      const result = await promisifyRequest(objectStore('settings', 'readwrite').delete(key), { waitForTransaction: true });
      notifyWrite('settings', key, { operation: 'delete' });
      return result;
    });
  });
}

export async function getRecord(storeName, id) {
  return runWithDb(async () => promisifyRequest(objectStore(storeName, 'readonly').get(id)));
}

export async function putRecord(storeName, record) {
  return runWithDb(async () => {
    const key = record?.[STORES[storeName]?.keyPath];
    return writeWithNativePut(storeName, key, record, async () => {
      const result = await promisifyRequest(objectStore(storeName, 'readwrite').put(record), { waitForTransaction: true });
      notifyWrite(storeName, key, { operation: 'put', record });
      return result;
    });
  });
}

/**
 * 在同一个读写事务里读取并按最新值更新记录，避免后台维护任务把较早读取的整条记录写回，
 * 覆盖用户刚刚完成的编辑。updater 返回 null/undefined 表示跳过写入。
 */
export async function updateRecord(storeName, id, updater, options = {}) {
  if (typeof updater !== 'function') throw new TypeError('updater must be a function');
  if (await isNativeDataStoreEnabled()) {
    return runNativeWriteExclusive(async () => runWithDb(async () => {
      if (options?.requireCurrentNativeCache === true) {
        const coherence = await verifyNativeIndexedDbCacheCurrent().catch(() => ({
          current: false,
          reason: 'native-cache-check-failed',
        }));
        if (coherence?.current !== true) {
          return {
            updated: false,
            conflict: true,
            reason: coherence?.reason || 'native-cache-not-current',
            record: null,
          };
        }
      }
      const current = await promisifyRequest(objectStore(storeName, 'readonly').get(id));
      const next = updater(current);
      if (next === null || next === undefined) return { updated: false, record: current };
      const nativeResult = await mirrorNativePut(storeName, id, next);
      const writeIndexedDb = async () => {
        await promisifyRequest(objectStore(storeName, 'readwrite').put(next), { waitForTransaction: true });
        notifyWrite(storeName, id, { operation: 'update', record: next });
        return { updated: true, record: next };
      };
      return finishIndexedDbCacheWriteAfterNativeCommit({
        storeName,
        operation: 'update',
        fallbackResult: { updated: true, record: next, cacheRebuildRequired: true },
        nativeResult,
        writeIndexedDb,
      });
    }), { priority: nativeWritePriority(storeName, id) });
  }
  return runWithDb(async () => new Promise((resolve, reject) => {
    assertStore(storeName);
    const tx = _db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.get(id);
    let updated = false;
    let record;

    request.onsuccess = () => {
      try {
        const next = updater(request.result);
        if (next === null || next === undefined) {
          record = request.result;
          return;
        }
        record = next;
        updated = true;
        store.put(next);
      } catch (err) {
        try { tx.abort(); } catch (_) {}
        reject(err);
      }
    };
    tx.oncomplete = () => {
      if (updated) notifyWrite(storeName, id, { operation: 'update', record });
      resolve({ updated, record });
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  }));
}

export async function deleteRecord(storeName, id) {
  return runWithDb(async () => {
    return writeWithNativeDelete(storeName, id, async () => {
      const result = await promisifyRequest(objectStore(storeName, 'readwrite').delete(id), { waitForTransaction: true });
      notifyWrite(storeName, id, { operation: 'delete' });
      return result;
    });
  });
}

export async function getAllRecords(storeName) {
  return runWithDb(async () => promisifyRequest(objectStore(storeName, 'readonly').getAll()));
}

/**
 * Read only records whose primary key starts with `prefix`.
 *
 * `settings` is a shared key/value store and may contain large media payloads. Callers that
 * only need one logical namespace must not clone the entire store into the JS heap first.
 */
export async function getAllByKeyPrefix(storeName, prefix = '', options = {}) {
  const startKey = String(prefix || '');
  if (!startKey) return getAllRecords(storeName);
  const rows = [];
  const limit = Math.max(0, Number(options.limit || 0) || 0);
  await forEachStoreRecordBatched(storeName, (row) => {
    rows.push(row);
    if (limit && rows.length >= limit) return false;
    return true;
  }, {
    startKey,
    endKey: `${startKey}\uffff`,
    batchSize: Math.max(1, Math.min(100, Number(options.batchSize || 32) || 32)),
  });
  return rows;
}

export async function countRecords(storeName) {
  if (!STORES[storeName]) throw new Error(`Unknown store: ${storeName}`);
  return runWithDb(async () => promisifyRequest(objectStore(storeName, 'readonly').count()));
}

/** Read primary keys without cloning record values (notably large Blob payloads). */
export async function getAllKeys(storeName) {
  return runWithDb(async () => promisifyRequest(objectStore(storeName, 'readonly').getAllKeys()));
}

/** 批量按 id 读取，复用同一个只读事务，避免逐条 get 各开一个事务的往返开销。 */
export async function getMany(storeName, ids = []) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return [];
  return runWithDb(async () => new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const results = new Array(list.length);
    list.forEach((id, idx) => {
      const req = store.get(id);
      req.onsuccess = () => { results[idx] = req.result; };
    });
    tx.oncomplete = () => resolve(results);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(transactionError(tx));
  }));
}

function normalizeGuardedMessageRestoreInput(messages = [], scopes = []) {
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.id && message?.chatId);
  const scopeByChatId = new Map();
  for (const raw of Array.isArray(scopes) ? scopes : []) {
    const chatId = String(raw?.chatId || '').trim();
    const userId = String(raw?.userId || '').trim();
    const resetStateKey = String(raw?.resetStateKey || '').trim();
    if (!chatId || !userId || !resetStateKey) continue;
    scopeByChatId.set(chatId, {
      chatId,
      userId,
      resetStateKey,
      createdAt: Number(raw?.createdAt || 0),
      memoryResetToken: String(raw?.memoryResetToken || '').trim(),
    });
  }
  return { rows, scopes: [...scopeByChatId.values()] };
}

async function guardedMessageRestoreStorageMode() {
  try {
    return await isNativeDataStoreEnabled()
      ? { supported: true, mode: 'native-primary', reason: 'native-primary' }
      : { supported: true, mode: 'indexeddb', reason: 'indexeddb' };
  } catch (_) {
    // 无法确认主库模式时不能假定 IndexedDB 是权威数据源；宁可在删除旧轮前停下。
    return { supported: false, reason: 'storage-mode-unavailable' };
  }
}

/**
 * 在同一个 IndexedDB 快照里捕获待重 roll 消息及其会话代次。
 * 原生主库由单顶层 WebView 的 native write queue 串行化；优先追平全库缓存，但
 * 全库无关记录落后时仍可捕获当前会话的逐项快照。搬家暂存期与缺少原生批量写
 * 能力时必须在删除前停下。
 */
export async function captureGuardedMessageRestore(messages = [], scopeRequests = []) {
  const input = normalizeGuardedMessageRestoreInput(messages, scopeRequests);
  const storageMode = await guardedMessageRestoreStorageMode();
  if (!storageMode.supported) {
    return {
      ...storageMode,
      messages: [],
      scopes: [],
      skippedMessageIds: input.rows.map((message) => String(message.id)),
    };
  }
  if (!input.rows.length) {
    return { supported: true, captured: true, reason: 'empty', messages: [], scopes: [], skippedMessageIds: [] };
  }

  const captureIndexedDbSnapshot = () => runWithDb(async () => new Promise((resolve, reject) => {
    const tx = _db.transaction(['chats', 'settings', 'messages'], 'readonly');
    const chatsStore = tx.objectStore('chats');
    const settingsStore = tx.objectStore('settings');
    const messagesStore = tx.objectStore('messages');
    const scopeByChatId = new Map(input.scopes.map((scope) => [scope.chatId, scope]));
    const capturedChats = new Map();
    const capturedResetRows = new Map();
    const capturedMessages = new Map();
    let settled = false;

    for (const scope of input.scopes) {
      const chatRequest = chatsStore.get(scope.chatId);
      chatRequest.onsuccess = () => capturedChats.set(scope.chatId, chatRequest.result);
      const resetRequest = settingsStore.get(scope.resetStateKey);
      resetRequest.onsuccess = () => capturedResetRows.set(scope.chatId, resetRequest.result);
    }
    for (const message of input.rows) {
      const request = messagesStore.get(message.id);
      request.onsuccess = () => capturedMessages.set(String(message.id), request.result);
    }

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      const validScopes = [];
      const validChatIds = new Set();
      const invalidChatIds = new Set();
      for (const requested of input.scopes) {
        const chat = capturedChats.get(requested.chatId);
        const ownerId = String(chat?.userId || '').trim();
        if (!chat || ownerId !== requested.userId) {
          invalidChatIds.add(requested.chatId);
          continue;
        }
        const resetRow = capturedResetRows.get(requested.chatId);
        const scope = {
          ...requested,
          createdAt: Number(chat.createdAt || 0),
          memoryResetToken: String(resetRow?.value?.token || '').trim(),
        };
        validScopes.push(scope);
        validChatIds.add(scope.chatId);
      }

      const captured = [];
      const skippedMessageIds = [];
      for (const requested of input.rows) {
        const current = capturedMessages.get(String(requested.id));
        const chatId = String(current?.chatId || '').trim();
        if (!current || chatId !== String(requested.chatId || '').trim() || !validChatIds.has(chatId)) {
          skippedMessageIds.push(String(requested.id));
          if (chatId && !scopeByChatId.has(chatId)) invalidChatIds.add(chatId);
          continue;
        }
        captured.push(current);
      }
      resolve({
        supported: true,
        captured: skippedMessageIds.length === 0 && invalidChatIds.size === 0,
        reason: skippedMessageIds.length || invalidChatIds.size ? 'scope-or-message-missing' : 'captured',
        messages: captured,
        scopes: validScopes,
        skippedMessageIds,
        invalidChatIds: [...invalidChatIds],
      });
    };
    tx.onerror = () => {
      if (settled) return;
      settled = true;
      reject(tx.error || new Error('IndexedDB guarded capture failed'));
    };
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      reject(transactionError(tx));
    };
  }));
  if (storageMode.mode !== 'native-primary') return captureIndexedDbSnapshot();
  return runNativeWriteExclusive(async () => {
    let coherence = await verifyNativeIndexedDbCacheCurrent();
    if (
      coherence?.current !== true
      && [
        'cache-rebuild-required',
        'journal-repair-required',
        'cache-sequence-behind',
      ].includes(String(coherence?.reason || ''))
    ) {
      // 正常业务写入会先落原生主库、再更新 IndexedDB 镜像；旧 WebView 被系统
      // 暂停在两步之间时，镜像可能只短暂落后一小段。重 roll 原先在这里直接失败，
      // 并被 UI 误报成“其他窗口变化”。在同一原生写锁内先尝试日志增量追平，
      // 再重新验证水位；完整重建仍只允许冷启动执行，绝不放松恢复快照的安全门。
      await rebuildIndexedDbCacheIfNeeded({ allowFullRebuild: false }).catch(() => null);
      coherence = await verifyNativeIndexedDbCacheCurrent();
    }
    if (coherence?.current !== true && coherence?.reason === 'native-staging-active') {
      return {
        supported: false,
        captured: false,
        reason: 'native-staging-active',
        messages: [],
        scopes: [],
        skippedMessageIds: input.rows.map((message) => String(message.id)),
      };
    }
    if (input.rows.length > 1 && coherence?.status?.activeBatchPut !== true) {
      return {
        supported: false,
        captured: false,
        reason: 'native-batch-put-unavailable',
        messages: [],
        scopes: [],
        skippedMessageIds: input.rows.map((message) => String(message.id)),
      };
    }
    const snapshot = await captureIndexedDbSnapshot();
    return {
      ...snapshot,
      mode: 'native-primary',
      nativeCacheCurrent: coherence?.current === true,
      nativeCacheReason: coherence?.reason || '',
    };
  }, { priority: 'foreground' });
}

function sameStoredRecord(left, right) {
  try {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  } catch (_) {
    return false;
  }
}

async function validateGuardedRestoreSnapshot(input) {
  return runWithDb(async () => new Promise((resolve, reject) => {
    const tx = _db.transaction(['chats', 'settings', 'messages'], 'readonly');
    const chatsStore = tx.objectStore('chats');
    const settingsStore = tx.objectStore('settings');
    const messagesStore = tx.objectStore('messages');
    const chats = new Map();
    const resetRows = new Map();
    const currentMessages = new Map();
    const totalReads = (input.scopes.length * 2) + input.rows.length;
    let completedReads = 0;
    let outcome = { valid: false, reason: 'transaction-incomplete' };
    let settled = false;

    const finishReads = () => {
      completedReads += 1;
      if (completedReads !== totalReads) return;
      for (const scope of input.scopes) {
        const chat = chats.get(scope.chatId);
        if (!chat) {
          outcome = { valid: false, reason: 'chat-missing', chatId: scope.chatId };
          return;
        }
        if (String(chat.userId || '').trim() !== scope.userId) {
          outcome = { valid: false, reason: 'user-mismatch', chatId: scope.chatId };
          return;
        }
        if (Number(chat.createdAt || 0) !== Number(scope.createdAt || 0)) {
          outcome = { valid: false, reason: 'chat-instance-changed', chatId: scope.chatId };
          return;
        }
        const token = String(resetRows.get(scope.chatId)?.value?.token || '').trim();
        if (token !== scope.memoryResetToken) {
          outcome = { valid: false, reason: 'memory-reset-changed', chatId: scope.chatId };
          return;
        }
      }
      for (const message of input.rows) {
        const current = currentMessages.get(String(message.id));
        if (current && !sameStoredRecord(current, message)) {
          outcome = { valid: false, reason: 'message-conflict', messageId: String(message.id) };
          return;
        }
      }
      outcome = { valid: true, reason: 'valid' };
    };

    for (const scope of input.scopes) {
      const chatRequest = chatsStore.get(scope.chatId);
      chatRequest.onsuccess = () => {
        chats.set(scope.chatId, chatRequest.result);
        finishReads();
      };
      const resetRequest = settingsStore.get(scope.resetStateKey);
      resetRequest.onsuccess = () => {
        resetRows.set(scope.chatId, resetRequest.result);
        finishReads();
      };
    }
    for (const message of input.rows) {
      const request = messagesStore.get(message.id);
      request.onsuccess = () => {
        currentMessages.set(String(message.id), request.result);
        finishReads();
      };
    }
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    tx.onerror = () => {
      if (settled) return;
      settled = true;
      reject(tx.error || new Error('IndexedDB guarded validation failed'));
    };
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      reject(transactionError(tx));
    };
  }));
}

/**
 * 重 roll 失败恢复的唯一消息写入口。会话存在性、档位归属、实例 createdAt、
 * memory-reset token 与全部 message put 必须属于同一多 store 事务；任一冲突时零写入。
 */
export async function restoreGuardedMessages(messages = [], scopes = []) {
  const input = normalizeGuardedMessageRestoreInput(messages, scopes);
  const storageMode = await guardedMessageRestoreStorageMode();
  if (!storageMode.supported) {
    return { ...storageMode, restored: false, count: 0 };
  }
  if (!input.rows.length) {
    return { supported: true, restored: true, reason: 'empty', count: 0 };
  }
  const scopeByChatId = new Map(input.scopes.map((scope) => [scope.chatId, scope]));
  if (scopeByChatId.size === 0 || input.rows.some((message) => (
    !scopeByChatId.has(String(message.chatId || '').trim())
  ))) {
    return { supported: true, restored: false, reason: 'missing-scope', count: 0 };
  }

  const restoreIndexedDb = () => runWithDb(async () => new Promise((resolve, reject) => {
    const tx = _db.transaction(['chats', 'settings', 'messages'], 'readwrite');
    const chatsStore = tx.objectStore('chats');
    const settingsStore = tx.objectStore('settings');
    const messagesStore = tx.objectStore('messages');
    const chats = new Map();
    const resetRows = new Map();
    const currentMessages = new Map();
    const totalReads = (input.scopes.length * 2) + input.rows.length;
    let completedReads = 0;
    let result = { supported: true, restored: false, reason: 'transaction-incomplete', count: 0 };
    let failed = false;

    const finishReads = () => {
      completedReads += 1;
      if (failed || completedReads !== totalReads) return;
      for (const scope of input.scopes) {
        const chat = chats.get(scope.chatId);
        if (!chat) {
          result = { supported: true, restored: false, reason: 'chat-missing', chatId: scope.chatId, count: 0 };
          return;
        }
        if (String(chat.userId || '').trim() !== scope.userId) {
          result = { supported: true, restored: false, reason: 'user-mismatch', chatId: scope.chatId, count: 0 };
          return;
        }
        if (Number(chat.createdAt || 0) !== Number(scope.createdAt || 0)) {
          result = { supported: true, restored: false, reason: 'chat-instance-changed', chatId: scope.chatId, count: 0 };
          return;
        }
        const currentToken = String(resetRows.get(scope.chatId)?.value?.token || '').trim();
        if (currentToken !== scope.memoryResetToken) {
          result = { supported: true, restored: false, reason: 'memory-reset-changed', chatId: scope.chatId, count: 0 };
          return;
        }
      }
      for (const message of input.rows) {
        const current = currentMessages.get(String(message.id));
        if (current && !sameStoredRecord(current, message)) {
          result = { supported: true, restored: false, reason: 'message-conflict', messageId: String(message.id), count: 0 };
          return;
        }
      }
      for (const message of input.rows) {
        if (!currentMessages.get(String(message.id))) messagesStore.put(message);
      }
      result = {
        supported: true,
        restored: true,
        reason: 'restored',
        count: input.rows.length,
      };
    };

    for (const scope of input.scopes) {
      const chatRequest = chatsStore.get(scope.chatId);
      chatRequest.onsuccess = () => {
        chats.set(scope.chatId, chatRequest.result);
        finishReads();
      };
      const resetRequest = settingsStore.get(scope.resetStateKey);
      resetRequest.onsuccess = () => {
        resetRows.set(scope.chatId, resetRequest.result);
        finishReads();
      };
    }
    for (const message of input.rows) {
      const request = messagesStore.get(message.id);
      request.onsuccess = () => {
        currentMessages.set(String(message.id), request.result);
        finishReads();
      };
    }

    tx.oncomplete = () => {
      if (result.restored) {
        for (const message of input.rows) {
          notifyWrite('messages', message.id, { operation: 'guarded-restore', record: message });
        }
      }
      resolve(result);
    };
    tx.onerror = () => {
      if (failed) return;
      failed = true;
      reject(tx.error || new Error('IndexedDB guarded restore failed'));
    };
    tx.onabort = () => {
      if (failed) return;
      failed = true;
      reject(transactionError(tx));
    };
  }));

  if (storageMode.mode !== 'native-primary') return restoreIndexedDb();
  return runNativeWriteExclusive(async () => {
    const coherence = await verifyNativeIndexedDbCacheCurrent();
    // APK 只有一个顶层 WebView。全库缓存水位落后可能来自任意无关资源，不能因此
    // 禁用当前会话的重 roll；下面仍会逐项核对 chat owner、实例代、reset token
    // 与目标消息冲突，并在同一原生写锁内先批量恢复主库、再补当前缓存。
    if (coherence?.current !== true && coherence?.reason === 'native-staging-active') {
      return {
        supported: false,
        restored: false,
        reason: 'native-staging-active',
        count: 0,
      };
    }
    if (input.rows.length > 1 && coherence?.status?.activeBatchPut !== true) {
      return { supported: false, restored: false, reason: 'native-batch-put-unavailable', count: 0 };
    }
    const validation = await validateGuardedRestoreSnapshot(input);
    if (!validation.valid) {
      return { supported: true, restored: false, reason: validation.reason, count: 0 };
    }

    const nativeResult = await mirrorNativePutMany('messages', STORES.messages.keyPath, input.rows);
    try {
      const cacheResult = await restoreIndexedDb();
      if (cacheResult.restored !== true) {
        const error = new Error(`native restore cache guard diverged: ${cacheResult.reason || 'unknown'}`);
        markNativeCacheRebuildRequired('guarded-reroll-restore-diverged', error);
        return {
          supported: true,
          restored: true,
          reason: 'native-restored-cache-rebuild-required',
          count: input.rows.length,
          cacheRebuildRequired: true,
        };
      }
      markNativeCacheCommit(nativeResult);
      return { ...cacheResult, mode: 'native-primary' };
    } catch (error) {
      markNativeCacheRebuildRequired('guarded-reroll-restore-cache-failed', error);
      return {
        supported: true,
        restored: true,
        reason: 'native-restored-cache-rebuild-required',
        count: input.rows.length,
        cacheRebuildRequired: true,
      };
    }
  }, { priority: 'foreground' });
}

export async function getAllByIndex(storeName, indexName, value) {
  return runWithDb(async () => {
    const store = objectStore(storeName, 'readonly');
    if (!store.indexNames.contains(indexName)) {
      throw new Error(`Unknown index: ${storeName}.${indexName}`);
    }
    return promisifyRequest(store.index(indexName).getAll(value));
  });
}

/** 按索引值只读取命中记录的主键，用于批量删除时避免克隆大记录正文。 */
export async function getPrimaryKeysByIndex(storeName, indexName, value) {
  return runWithDb(async () => {
    const store = objectStore(storeName, 'readonly');
    if (!store.indexNames.contains(indexName)) {
      throw new Error(`Unknown index: ${storeName}.${indexName}`);
    }
    return promisifyRequest(store.index(indexName).getAllKeys(value));
  });
}

/**
 * 只读取索引里的不同键，不把整张大表载入内存。
 * 主要用于急救扫描：users 表丢失后，从仍存在的业务表找回孤立 userId。
 */
export async function getDistinctIndexKeys(storeName, indexName, options = {}) {
  return runWithDb(async () => {
    const store = objectStore(storeName, 'readonly');
    if (!store.indexNames.contains(indexName)) {
      throw new Error(`Unknown index: ${storeName}.${indexName}`);
    }
    const idx = store.index(indexName);
    const limit = Math.max(1, Math.min(500, Number(options.limit || 100) || 100));
    return new Promise((resolve, reject) => {
      const out = [];
      const req = idx.openKeyCursor(null, 'nextunique');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cursor.key);
        cursor.continue();
      };
      req.onerror = () => reject(req.error || new Error(`读取 ${storeName}.${indexName} 索引失败`));
    });
  });
}

export async function getAllByIndexRange(storeName, indexName, lower, upper, options = {}) {
  return runWithDb(async () => {
    const store = objectStore(storeName, 'readonly');
    if (!store.indexNames.contains(indexName)) {
      throw new Error(`Unknown index: ${storeName}.${indexName}`);
    }
    const idx = store.index(indexName);
    const lowerSet = lower !== undefined && lower !== null;
    const upperSet = upper !== undefined && upper !== null;
    let range = null;
    if (lowerSet && upperSet) {
      range = IDBKeyRange.bound(lower, upper, !!options.lowerOpen, !!options.upperOpen);
    } else if (lowerSet) {
      range = IDBKeyRange.lowerBound(lower, !!options.lowerOpen);
    } else if (upperSet) {
      range = IDBKeyRange.upperBound(upper, !!options.upperOpen);
    }
    const limit = Math.max(0, Number(options.limit || 0) || 0);
    const direction = options.direction === 'prev' ? 'prev' : 'next';
    const mapRecord = typeof options.mapRecord === 'function' ? options.mapRecord : null;
    const filterRecord = typeof options.filterRecord === 'function' ? options.filterRecord : null;
    if (!limit && direction === 'next' && !mapRecord && !filterRecord) return promisifyRequest(idx.getAll(range));
    return new Promise((resolve, reject) => {
      const out = [];
      const req = idx.openCursor(range, direction);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || (limit && out.length >= limit)) {
          resolve(out);
          return;
        }
        try {
          if (!filterRecord || filterRecord(cursor.value)) {
            out.push(mapRecord ? mapRecord(cursor.value) : cursor.value);
          }
        } catch (err) {
          reject(err);
          return;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * 只读取索引键，不克隆记录正文。日期导航等只关心时间戳的场景必须走这里，
 * 否则一张 data URL 原图也会随着 cursor.value 被完整搬进内存。
 */
export async function getIndexKeysRange(storeName, indexName, lower, upper, options = {}) {
  return runWithDb(async () => {
    const store = objectStore(storeName, 'readonly');
    if (!store.indexNames.contains(indexName)) {
      throw new Error(`Unknown index: ${storeName}.${indexName}`);
    }
    const idx = store.index(indexName);
    const lowerSet = lower !== undefined && lower !== null;
    const upperSet = upper !== undefined && upper !== null;
    let range = null;
    if (lowerSet && upperSet) {
      range = IDBKeyRange.bound(lower, upper, !!options.lowerOpen, !!options.upperOpen);
    } else if (lowerSet) {
      range = IDBKeyRange.lowerBound(lower, !!options.lowerOpen);
    } else if (upperSet) {
      range = IDBKeyRange.upperBound(upper, !!options.upperOpen);
    }
    const limit = Math.max(0, Number(options.limit || 0) || 0);
    const direction = options.direction === 'prev' ? 'prev' : 'next';
    return new Promise((resolve, reject) => {
      const out = [];
      const req = idx.openKeyCursor(range, direction);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || (limit && out.length >= limit)) {
          resolve(out);
          return;
        }
        out.push(cursor.key);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/** 按索引顺序找到第一条满足条件的记录，避免为一次定位读取整段历史。 */
export async function findFirstByIndexRange(storeName, indexName, lower, upper, options = {}) {
  return runWithDb(async () => {
    const store = objectStore(storeName, 'readonly');
    if (!store.indexNames.contains(indexName)) {
      throw new Error(`Unknown index: ${storeName}.${indexName}`);
    }
    const idx = store.index(indexName);
    const lowerSet = lower !== undefined && lower !== null;
    const upperSet = upper !== undefined && upper !== null;
    let range = null;
    if (lowerSet && upperSet) {
      range = IDBKeyRange.bound(lower, upper, !!options.lowerOpen, !!options.upperOpen);
    } else if (lowerSet) {
      range = IDBKeyRange.lowerBound(lower, !!options.lowerOpen);
    } else if (upperSet) {
      range = IDBKeyRange.upperBound(upper, !!options.upperOpen);
    }
    const direction = options.direction === 'prev' ? 'prev' : 'next';
    const predicate = typeof options.predicate === 'function' ? options.predicate : () => true;
    return new Promise((resolve, reject) => {
      const req = idx.openCursor(range, direction);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(null);
          return;
        }
        try {
          if (predicate(cursor.value)) {
            resolve(cursor.value);
            return;
          }
        } catch (error) {
          reject(error);
          return;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

export async function forEachStoreRecord(storeName, callback) {
  assertStore(storeName);
  return runWithDb(async () => new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.openCursor();
    let rows = 0;
    let failed = false;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || failed) return;
      try {
        const stop = callback(cursor.value, rows, storeName);
        rows += 1;
        if (stop === false) {
          failed = true;
          reject(new Error('forEachStoreRecord aborted'));
          return;
        }
        cursor.continue();
      } catch (err) {
        failed = true;
        reject(err);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => {
      if (!failed) resolve(rows);
    };
    tx.onerror = () => {
      if (!failed) reject(tx.error);
    };
    tx.onabort = () => {
      if (!failed) {
        failed = true;
        reject(transactionError(tx));
      }
    };
  }));
}

/** Traverse a large store in short transactions so an async consumer can drain between batches. */
export async function forEachStoreRecordBatched(storeName, callback, options = {}) {
  assertStore(storeName);
  const batchSize = Math.max(1, Number(options.batchSize || 32) || 32);
  const onBatch = typeof options.onBatch === 'function' ? options.onBatch : null;
  const hasStartKey = Object.prototype.hasOwnProperty.call(options, 'startKey');
  const hasEndKey = Object.prototype.hasOwnProperty.call(options, 'endKey');
  const endKey = options.endKey;
  let resumeKey = hasStartKey ? options.startKey : undefined;
  let includeResumeKey = hasStartKey;
  let rows = 0;
  let done = false;

  while (!done) {
    const batch = await runWithDb(async () => new Promise((resolve, reject) => {
      const tx = _db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      let range;
      if (resumeKey === undefined) {
        range = hasEndKey ? IDBKeyRange.upperBound(endKey) : undefined;
      } else if (hasEndKey) {
        range = IDBKeyRange.bound(resumeKey, endKey, !includeResumeKey, false);
      } else {
        range = IDBKeyRange.lowerBound(resumeKey, !includeResumeKey);
      }
      const req = store.openCursor(range);
      const records = [];
      let nextResumeKey = resumeKey;
      let exhausted = false;
      let failed = false;

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          exhausted = true;
          return;
        }
        records.push({ key: cursor.key, value: cursor.value });
        nextResumeKey = cursor.key;
        if (records.length < batchSize) cursor.continue();
      };
      req.onerror = () => {
        failed = true;
        reject(req.error);
      };
      tx.oncomplete = () => {
        const reachedEnd = hasEndKey
          && nextResumeKey !== undefined
          && indexedDB.cmp(nextResumeKey, endKey) === 0;
        if (!failed) resolve({ records, exhausted: exhausted || reachedEnd, nextResumeKey });
      };
      tx.onerror = () => {
        if (!failed) {
          failed = true;
          reject(transactionError(tx));
        }
      };
      tx.onabort = () => {
        if (!failed) {
          failed = true;
          reject(transactionError(tx));
        }
      };
    }));

    resumeKey = batch.nextResumeKey;
    includeResumeKey = false;
    done = batch.exhausted;
    if (!batch.records.length) break;
    for (const record of batch.records) {
      const stop = await callback(record.value, rows, storeName, record.key);
      rows += 1;
      if (stop === false) return rows;
    }
    if (onBatch) await onBatch({ storeName, rows });
  }

  return rows;
}
export async function deleteMany(storeName, ids = []) {
  const list = Array.isArray(ids) ? ids.filter((id) => id !== undefined && id !== null) : [];
  if (!list.length) return 0;
  return runWithDb(async () => {
    const writeIndexedDb = () => new Promise((resolve, reject) => {
      const tx = _db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (let i = 0; i < list.length; i += 1) store.delete(list[i]);
      tx.oncomplete = () => {
        notifyWrite(storeName, undefined);
        resolve(list.length);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(transactionError(tx));
    });
    if (!(await isNativeDataStoreEnabled())) return writeIndexedDb();
    return runNativeWriteExclusive(async () => {
      const nativeResult = await mirrorNativeDeleteMany(storeName, list);
      return finishIndexedDbCacheWriteAfterNativeCommit({
        storeName,
        operation: 'delete-many',
        fallbackResult: list.length,
        nativeResult,
        writeIndexedDb,
      });
    }, { priority: nativeWritePriority(storeName) });
  });
}

export async function putMany(storeName, records = [], options = {}) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return 0;
  const batchSize = Math.max(0, Number(options.batchSize) || 0);
  if (batchSize > 0 && list.length > batchSize) {
    let total = 0;
    for (let i = 0; i < list.length; i += batchSize) {
      total += await putMany(storeName, list.slice(i, i + batchSize));
    }
    return total;
  }
  return runWithDb(async () => {
    const writeIndexedDb = () => new Promise((resolve, reject) => {
      const tx = _db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (let i = 0; i < list.length; i += 1) store.put(list[i]);
      tx.oncomplete = () => {
        notifyWrite(storeName, undefined);
        resolve(list.length);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(transactionError(tx));
    });
    if (!(await isNativeDataStoreEnabled())) return writeIndexedDb();
    return runNativeWriteExclusive(async () => {
      const nativeResult = await mirrorNativePutMany(
        storeName,
        STORES[storeName]?.keyPath,
        list,
      );
      return finishIndexedDbCacheWriteAfterNativeCommit({
        storeName,
        operation: 'put-many',
        fallbackResult: list.length,
        nativeResult,
        writeIndexedDb,
      });
    }, { priority: nativeWritePriority(storeName) });
  });
}

export async function clearStore(storeName) {
  return runWithDb(async () => {
    return writeWithNativeClear(storeName, async () => {
      const result = await promisifyRequest(objectStore(storeName, 'readwrite').clear(), { waitForTransaction: true });
      notifyWrite(storeName, undefined);
      return result;
    });
  });
}

export {
  abortNativeReplaceImport,
  beginNativeReplaceImport,
  checkpointNativeReplaceImport,
  commitNativeReplaceImport,
  STORES,
  DB_NAME,
  DB_VERSION,
};
