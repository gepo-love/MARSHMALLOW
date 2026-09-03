/**
 * 长篇叙事生成租约。
 *
 * 页面级 isAdvancing 只能防住同一个 render 闭包里的连点。路由重挂载、同源多标签页
 * 或旧页面仍在收流时，必须在真正调用模型的核心层再按业务会话互斥。
 */

const ACTIVE_LEASES = new Map();
const ACTIVE_ABORT_CONTROLLERS = new Map();
const STORAGE_PREFIX = 'mmNarrationGenerationLeaseV1:';
const ABORT_STORAGE_PREFIX = 'mmNarrationGenerationAbortV1:';
const TAB_ID_KEY = 'mmNarrationGenerationTabIdV1';
const STORAGE_STALE_MS = 10 * 60 * 1000;
const ABORT_REQUEST_STALE_MS = 60 * 1000;
const FORCE_RELEASE_AFTER_ABORT_MS = 2500;
const HEARTBEAT_MS = 5000;

function clean(value) {
  return String(value || '').trim();
}

function leaseKey(scope, sessionId) {
  const safeScope = clean(scope) || 'narration';
  const safeId = clean(sessionId);
  return safeId ? `${safeScope}:${safeId}` : '';
}

function storageKey(key) {
  return `${STORAGE_PREFIX}${key}`;
}

function abortStorageKey(key) {
  return `${ABORT_STORAGE_PREFIX}${key}`;
}

function makeToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `lease_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function currentTabId() {
  try {
    const existing = clean(globalThis.sessionStorage?.getItem(TAB_ID_KEY));
    if (existing) return existing;
    const created = makeToken();
    globalThis.sessionStorage?.setItem(TAB_ID_KEY, created);
    return created;
  } catch (_) {
    return makeToken();
  }
}

const CURRENT_TAB_ID = currentTabId();

function currentDocumentWasReloaded() {
  try {
    const entry = globalThis.performance?.getEntriesByType?.('navigation')?.[0];
    if (entry?.type) return entry.type === 'reload';
    return Number(globalThis.performance?.navigation?.type) === 1;
  } catch (_) {
    return false;
  }
}

const DOCUMENT_WAS_RELOADED = currentDocumentWasReloaded();

function isSingleDocumentRuntime() {
  try {
    const capacitor = globalThis.Capacitor;
    const nativeSingleView = capacitor?.isNativePlatform?.() === true
      || ['android', 'ios'].includes(String(capacitor?.getPlatform?.() || '').toLowerCase());
    if (nativeSingleView) return true;

    // iOS / Android 主屏 PWA 被系统回收后，sessionStorage 可能重新创建，但移动端
    // 同一个安装实例没有仍在运行的第二窗口。此时旧 tabId 只能来自已销毁文档。
    const navigator = globalThis.navigator;
    const mobile = navigator?.userAgentData?.mobile === true
      || /Android|iPhone|iPad|iPod|Mobile/i.test(String(navigator?.userAgent || ''));
    const standalone = navigator?.standalone === true
      || globalThis.matchMedia?.('(display-mode: standalone)')?.matches === true;
    return mobile && standalone;
  } catch (_) {
    return false;
  }
}

function readStoredLease(key) {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(key));
    if (!raw) return null;
    const row = JSON.parse(raw);
    const updatedAt = Number(row?.updatedAt || 0);
    if (!row?.token || !updatedAt || Date.now() - updatedAt > STORAGE_STALE_MS) {
      globalThis.localStorage?.removeItem(storageKey(key));
      return null;
    }
    return row;
  } catch (_) {
    return null;
  }
}

function writeStoredLease(key, token) {
  try {
    globalThis.localStorage?.setItem(storageKey(key), JSON.stringify({
      token,
      tabId: CURRENT_TAB_ID,
      updatedAt: Date.now(),
    }));
  } catch (_) {}
}

function clearStoredLease(key, token) {
  try {
    const row = readStoredLease(key);
    if (!row || row.token === token) globalThis.localStorage?.removeItem(storageKey(key));
  } catch (_) {}
}

function readAbortRequest(key) {
  try {
    const requestKey = abortStorageKey(key);
    const raw = globalThis.localStorage?.getItem(requestKey);
    if (!raw) return null;
    const row = JSON.parse(raw);
    const requestedAt = Number(row?.at || 0);
    if (!requestedAt || Date.now() - requestedAt > ABORT_REQUEST_STALE_MS) {
      globalThis.localStorage?.removeItem(requestKey);
      return null;
    }
    return row;
  } catch (_) {
    return null;
  }
}

function clearAbortRequest(key, token = '') {
  try {
    const row = readAbortRequest(key);
    if (!row || !token || !row.leaseToken || row.leaseToken === token) {
      globalThis.localStorage?.removeItem(abortStorageKey(key));
    }
  } catch (_) {}
}

function notify(key, active) {
  try {
    globalThis.window?.dispatchEvent(new CustomEvent('marshmallow-narration-generation-state', {
      detail: { key, active: active === true },
    }));
  } catch (_) {}
}

export function narrationGenerationLeaseKey(scope, sessionId) {
  return leaseKey(scope, sessionId);
}

function abortRegisteredControllers(key, reason = 'user-stop') {
  const rows = ACTIVE_ABORT_CONTROLLERS.get(key);
  if (!rows?.size) return 0;
  let aborted = 0;
  for (const controller of rows) {
    if (!controller?.signal?.aborted && typeof controller?.abort === 'function') {
      controller.abort(reason);
      aborted += 1;
    }
  }
  return aborted;
}

export function registerNarrationGenerationAbortController(scope, sessionId, controller) {
  const key = leaseKey(scope, sessionId);
  if (!key || typeof controller?.abort !== 'function') return () => {};
  const rows = ACTIVE_ABORT_CONTROLLERS.get(key) || new Set();
  rows.add(controller);
  ACTIVE_ABORT_CONTROLLERS.set(key, rows);
  return () => {
    const current = ACTIVE_ABORT_CONTROLLERS.get(key);
    current?.delete(controller);
    if (!current?.size) ACTIVE_ABORT_CONTROLLERS.delete(key);
  };
}

export function requestNarrationGenerationAbort(scope, sessionId, reason = 'user-stop') {
  const key = leaseKey(scope, sessionId);
  if (!key) return false;
  const localCount = abortRegisteredControllers(key, reason);
  const storedLease = readStoredLease(key);
  let notifiedOwner = false;
  try {
    const storage = globalThis.localStorage;
    if (typeof storage?.setItem === 'function' && (storedLease || localCount > 0)) {
      // 保留一小段时间而不是 set 后立即 remove：被冻结的后台页恢复时仍能读到停止请求，
      // 心跳也会主动轮询它，避免只依赖一次容易丢失的 storage 事件。
      storage.setItem(abortStorageKey(key), JSON.stringify({
        requestId: makeToken(),
        reason,
        at: Date.now(),
        leaseToken: clean(storedLease?.token),
      }));
      notifiedOwner = true;
    }
  } catch (_) {}
  return localCount > 0 || notifiedOwner;
}

/**
 * 只有当前文档实际持有租约、租约属于同一标签页，或运行在单 WebView 原生壳时，
 * 才允许在用户明确停止后强制回收。网页端另一标签页的真实请求仍保持互斥。
 */
export function canForceReleaseNarrationGenerationLease(scope, sessionId) {
  const key = leaseKey(scope, sessionId);
  if (!key) return false;
  if (ACTIVE_LEASES.has(key)) return true;
  const stored = readStoredLease(key);
  if (!stored) return true;
  const abortRequest = readAbortRequest(key);
  const abortTargetsStoredLease = !!abortRequest && (
    !abortRequest.leaseToken || abortRequest.leaseToken === stored.token
  );
  const abortGraceElapsed = abortTargetsStoredLease
    && Date.now() - Number(abortRequest.at || 0) >= FORCE_RELEASE_AFTER_ABORT_MS;
  return !!(
    (stored.tabId && stored.tabId === CURRENT_TAB_ID)
    || (!stored.tabId && DOCUMENT_WAS_RELOADED)
    || isSingleDocumentRuntime()
    // 用户已经明确停止且给持有页留足了响应时间后，允许接管残留租约。
    // 停止请求按 lease token 定向，旧页面稍后恢复也会先收到 abort，不会误伤下一轮。
    || abortGraceElapsed
  );
}

export async function forceReleaseNarrationGenerationLease(scope, sessionId, reason = 'user-stop-timeout') {
  const key = leaseKey(scope, sessionId);
  if (!key || !canForceReleaseNarrationGenerationLease(scope, sessionId)) return false;
  abortRegisteredControllers(key, reason);
  const entry = ACTIVE_LEASES.get(key);
  if (typeof entry?.release === 'function') {
    await entry.release();
    return true;
  }
  const stored = readStoredLease(key);
  if (stored) {
    clearStoredLease(key, stored.token);
  }
  notify(key, false);
  return true;
}

try {
  globalThis.window?.addEventListener?.('storage', (event) => {
    const storageEventKey = clean(event?.key);
    if (storageEventKey.startsWith(ABORT_STORAGE_PREFIX) && event?.newValue) {
      const key = storageEventKey.slice(ABORT_STORAGE_PREFIX.length);
      let request = null;
      try { request = JSON.parse(event.newValue); } catch (_) {}
      const active = ACTIVE_LEASES.get(key);
      if (!request?.leaseToken || !active?.token || request.leaseToken === active.token) {
        abortRegisteredControllers(key, clean(request?.reason) || 'user-stop');
      }
      return;
    }
    if (storageEventKey.startsWith(STORAGE_PREFIX) && !event?.newValue) {
      notify(storageEventKey.slice(STORAGE_PREFIX.length), false);
    }
  });
} catch (_) {}

function releaseDocumentLeases(reason = 'pagehide') {
  for (const [key, entry] of ACTIVE_LEASES) {
    abortRegisteredControllers(key, reason);
    // release() 在第一个 await 前同步清掉 localStorage，因此 pagehide 阶段也可靠。
    try { void entry?.release?.(); } catch (_) {}
  }
}

try {
  globalThis.window?.addEventListener?.('pagehide', (event) => {
    // 进入 bfcache 的文档之后还可能原样恢复，不能把仍在暂停中的任务当成已销毁。
    if (event?.persisted === true) return;
    releaseDocumentLeases('pagehide');
  });
} catch (_) {}

export function isNarrationGenerationActive(scope, sessionId) {
  const key = leaseKey(scope, sessionId);
  if (!key) return false;
  return ACTIVE_LEASES.has(key) || !!readStoredLease(key);
}

/**
 * 页面恢复时使用的活跃态核验。
 *
 * APK 同一时刻只有一个 WebView 文档。若页面重新加载后内存租约已经消失，旧文档
 * 留在 localStorage 的心跳不可能仍代表一条可回调当前页面的请求；继续相信它只会
 * 让 inFlight 永久卡在“生成中”。网页端仍保留 localStorage / Web Locks 的跨标签页
 * 互斥语义，不能因为当前标签页没有内存租约就误放行另一标签页的真实生成。
 */
export function reconcileNarrationGenerationActivity(scope, sessionId) {
  const key = leaseKey(scope, sessionId);
  if (!key) return false;
  if (ACTIVE_LEASES.has(key)) return true;
  const stored = readStoredLease(key);
  if (!stored) return false;
  // sessionStorage 的 tab id 会跨刷新保留、不同标签页隔离。内存租约已消失但 tab id
  // 仍相同，说明请求属于刷新前的旧文档，不可能再回调当前页面，立即回收。
  if (
    (stored.tabId && stored.tabId === CURRENT_TAB_ID)
    || (!stored.tabId && DOCUMENT_WAS_RELOADED)
  ) {
    clearStoredLease(key, stored.token);
    notify(key, false);
    return false;
  }
  if (!isSingleDocumentRuntime()) return true;
  clearStoredLease(key, stored.token);
  notify(key, false);
  return false;
}

/**
 * 优先用 Web Locks 做跨标签页互斥；不支持时退回进程内 Map + 带心跳的 localStorage。
 * @returns {Promise<{acquired:boolean,key:string,release:Function}>}
 */
export async function acquireNarrationGenerationLease(scope, sessionId) {
  const key = leaseKey(scope, sessionId);
  if (!key || ACTIVE_LEASES.has(key)) {
    return { acquired: false, key, release() {} };
  }

  const token = makeToken();
  let releaseNativeLock = null;
  let nativeLockTask = null;
  const lockManager = globalThis.navigator?.locks;
  if (lockManager?.request) {
    let decide;
    const decision = new Promise((resolve) => { decide = resolve; });
    const held = new Promise((resolve) => { releaseNativeLock = resolve; });
    nativeLockTask = lockManager.request(`marshmallow:${key}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      decide(!!lock);
      if (lock) await held;
    }).catch(() => decide(false));
    if (!(await decision)) {
      releaseNativeLock = null;
      return { acquired: false, key, release() {} };
    }
  } else {
    if (readStoredLease(key)) return { acquired: false, key, release() {} };
    writeStoredLease(key, token);
    if (readStoredLease(key)?.token !== token) {
      return { acquired: false, key, release() {} };
    }
  }

  // 已确认拿到互斥权后，上一轮留下的停止标记不能污染新租约。
  clearAbortRequest(key);
  writeStoredLease(key, token);
  const heartbeat = globalThis.setInterval?.(() => {
    const active = ACTIVE_LEASES.get(key);
    if (active?.token !== token) return;
    const storedLease = readStoredLease(key);
    // 其它页面在用户明确停止后可能已撤销这枚租约。旧持有页恢复时必须自停，
    // 不能由下一次心跳把已清掉的 localStorage 记录重新写活。
    if (!storedLease || storedLease.token !== token) {
      abortRegisteredControllers(key, 'lease-revoked');
      try { void active.release?.(); } catch (_) {}
      return;
    }
    const abortRequest = readAbortRequest(key);
    if (
      abortRequest
      && (!abortRequest.leaseToken || abortRequest.leaseToken === token)
    ) {
      abortRegisteredControllers(key, clean(abortRequest.reason) || 'user-stop');
    }
    writeStoredLease(key, token);
  }, HEARTBEAT_MS);
  const entry = { token, heartbeat, released: false, releasePromise: null };
  ACTIVE_LEASES.set(key, entry);
  notify(key, true);

  const release = () => {
    if (entry.releasePromise) return entry.releasePromise;
    entry.releasePromise = (async () => {
      entry.released = true;
      if (entry.heartbeat) globalThis.clearInterval?.(entry.heartbeat);
      if (ACTIVE_LEASES.get(key)?.token === token) ACTIVE_LEASES.delete(key);
      clearStoredLease(key, token);
      clearAbortRequest(key, token);
      releaseNativeLock?.();
      await nativeLockTask?.catch(() => {});
      notify(key, false);
    })();
    return entry.releasePromise;
  };
  entry.release = release;
  return { acquired: true, key, token, release };
}

export function narrationGenerationInFlightError() {
  const error = new Error('这段内容仍在生成，请等待当前请求完成');
  error.reason = 'generation-in-flight';
  return error;
}
