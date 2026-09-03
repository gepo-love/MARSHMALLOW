import { get as dbGet, put as dbPut } from './db.js';

export const BACKGROUND_TASK_LEDGER_KEY = 'backgroundTaskLedger';

const LEADER_LOCK_NAME = 'marshmallow-background-scheduler';
const LEADER_LEASE_KEY = 'marshmallow-background-scheduler-lease';
const DEFAULT_LEASE_MS = 30_000;

let ledgerWriteQueue = Promise.resolve();

function cleanResult(result) {
  if (result == null) return null;
  if (typeof result !== 'object') return { value: String(result).slice(0, 160) };
  return {
    ok: result.ok !== false,
    skipped: result.skipped === true,
    reason: String(result.reason || '').slice(0, 160),
    processed: Number.isFinite(Number(result.processed)) ? Number(result.processed) : undefined,
    generated: result.generated === true,
    at: Date.now(),
  };
}

function normalizeLedger(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    updatedAt: Number(source.updatedAt || 0),
    tasks: source.tasks && typeof source.tasks === 'object' ? source.tasks : {},
    checkpoints: source.checkpoints && typeof source.checkpoints === 'object' ? source.checkpoints : {},
  };
}

export async function getBackgroundTaskLedger() {
  const row = await dbGet(BACKGROUND_TASK_LEDGER_KEY).catch(() => null);
  return normalizeLedger(row?.value);
}

function updateLedger(mutator) {
  const operation = ledgerWriteQueue.then(async () => {
    const ledger = await getBackgroundTaskLedger();
    const next = (await mutator(ledger)) || ledger;
    next.updatedAt = Date.now();
    await dbPut({ key: BACKGROUND_TASK_LEDGER_KEY, value: next });
    return next;
  });
  ledgerWriteQueue = operation.catch(() => {});
  return operation;
}

export async function recordBackgroundCheckpoint(name, detail = {}) {
  const key = String(name || '').trim();
  if (!key) return null;
  const ledger = await updateLedger((current) => {
    current.checkpoints[key] = {
      at: Date.now(),
      ...(detail && typeof detail === 'object' ? detail : {}),
    };
    return current;
  }).catch(() => null);
  return ledger?.checkpoints?.[key] || null;
}

/**
 * 主动任务的轻量持久化门闩。任务真正开始前写租约，结束后写下次到期时间和精简结果；
 * 页面被系统冻结或杀死时，短租约过期后下一实例可以安全补跑。
 */
export async function runPersistedBackgroundTask(taskId, runner, {
  intervalMs,
  leaseMs = Math.min(Math.max(Number(intervalMs) || DEFAULT_LEASE_MS, 15_000), 120_000),
  ownerId = '',
  force = false,
  reason = '',
} = {}) {
  const id = String(taskId || '').trim();
  if (!id || typeof runner !== 'function') return { ok: false, reason: 'invalid-task' };
  const now = Date.now();
  let acquired = false;
  let blockedReason = '';

  await updateLedger((ledger) => {
    const previous = ledger.tasks[id] || {};
    if (!force && Number(previous.nextDueAt || 0) > now) {
      blockedReason = 'not-due';
      return ledger;
    }
    if (Number(previous.leaseUntil || 0) > now) {
      blockedReason = 'leased';
      return ledger;
    }
    acquired = true;
    ledger.tasks[id] = {
      ...previous,
      lastAttemptAt: now,
      leaseUntil: now + leaseMs,
      leaseOwner: String(ownerId || ''),
      lastReason: String(reason || '').slice(0, 120),
    };
    return ledger;
  });

  if (!acquired) return { ok: false, skipped: true, reason: blockedReason || 'not-acquired' };

  let result;
  try {
    result = await runner();
  } catch (error) {
    result = { ok: false, reason: error?.message || String(error || 'failed') };
  }
  const finishedAt = Date.now();
  await updateLedger((ledger) => {
    const previous = ledger.tasks[id] || {};
    ledger.tasks[id] = {
      ...previous,
      leaseUntil: 0,
      leaseOwner: '',
      lastFinishedAt: finishedAt,
      nextDueAt: finishedAt + Math.max(1_000, Number(intervalMs) || 60_000),
      result: cleanResult(result),
    };
    return ledger;
  }).catch(() => {});
  return result;
}

function randomOwnerId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 同源多标签/PWA 实例选主：支持时只使用 Web Locks；不支持时才使用 localStorage 短租约。
 * 这样支持 Web Locks 的浏览器不会与 localStorage 回退路径各自选出一个 leader。
 */
export function createBackgroundLeaderElection({
  onChange,
  leaseMs = DEFAULT_LEASE_MS,
  retryMs = 5_000,
} = {}) {
  const ownerId = randomOwnerId();
  let stopped = false;
  let leader = false;
  let mode = 'pending';
  let retryTimer = 0;
  let renewTimer = 0;
  let releaseWebLock = null;

  const publish = (next, nextMode) => {
    const changed = leader !== next || mode !== nextMode;
    leader = next;
    mode = nextMode;
    if (changed && typeof onChange === 'function') onChange({ leader, mode, ownerId });
  };
  const retry = (fn) => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      fn();
    }, retryMs);
  };

  const attemptWebLock = async () => {
    if (stopped) return;
    try {
      await navigator.locks.request(LEADER_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock || stopped) {
          publish(false, 'web-lock-waiting');
          return;
        }
        publish(true, 'web-lock');
        await new Promise((resolve) => { releaseWebLock = resolve; });
        releaseWebLock = null;
      });
    } catch (_) {
      publish(false, 'web-lock-error');
    }
    if (!stopped) retry(attemptWebLock);
  };

  const readLease = () => {
    try {
      return JSON.parse(localStorage.getItem(LEADER_LEASE_KEY) || 'null') || {};
    } catch (_) {
      return {};
    }
  };
  const writeLease = (expiresAt) => {
    try {
      localStorage.setItem(LEADER_LEASE_KEY, JSON.stringify({ ownerId, expiresAt }));
      const verified = readLease();
      return verified.ownerId === ownerId && Number(verified.expiresAt || 0) === expiresAt;
    } catch (_) {
      return false;
    }
  };
  const attemptStorageLease = () => {
    if (stopped) return;
    const now = Date.now();
    const current = readLease();
    if (current.ownerId === ownerId || Number(current.expiresAt || 0) <= now) {
      const acquired = writeLease(now + leaseMs);
      publish(acquired, acquired ? 'storage-lease' : 'storage-waiting');
    } else {
      publish(false, 'storage-waiting');
    }
  };

  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    attemptWebLock();
  } else if (typeof localStorage !== 'undefined') {
    attemptStorageLease();
    renewTimer = setInterval(attemptStorageLease, Math.max(2_000, Math.floor(leaseMs / 3)));
  } else {
    // 单实例受限环境（例如旧 WebView 的隐私模式）无法共享租约，只能本页运行。
    publish(true, 'single-instance');
  }

  return {
    ownerId,
    isLeader: () => leader,
    mode: () => mode,
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (renewTimer) clearInterval(renewTimer);
      if (releaseWebLock) releaseWebLock();
      if (mode === 'storage-lease') {
        const current = readLease();
        if (current.ownerId === ownerId) {
          try { localStorage.removeItem(LEADER_LEASE_KEY); } catch (_) {}
        }
      }
      publish(false, 'stopped');
    },
  };
}
