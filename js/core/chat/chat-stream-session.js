/**
 * 跨页面的聊天 AI 生成会话：切换路由后仍保留「正在输入」与停止能力。
 */

import { reconcileGenerationTasks } from './generation-task-store.js';

const _sessions = new Map();
const _listeners = new Set();

/**
 * Lightweight pending records in localStorage. In-memory sessions die with the
 * process; these records let the next boot tell "generation was interrupted in
 * the background" apart from "nothing was running", and clean up chats stuck
 * on the "正在输入…" preview forever.
 */
const PENDING_STORE_KEY = 'mm_chat_stream_pending_v1';
const PENDING_MAX_AGE_MS = 20 * 60 * 1000;
const PENDING_TYPING_HEARTBEAT_MS = 4000;
const PENDING_TYPING_FRESH_MS = 15 * 1000;
const INTERRUPTED_AUTO_RETRY_COOLDOWN_MS = 3 * 60 * 1000;
const STREAM_OWNER_TAB_KEY = 'mm_chat_stream_owner_tab_v1';
export const CHAT_STREAM_INTERRUPTED_EVENT = 'marshmallow-chat-stream-interrupted';
let _pageTerminating = false;
let _pendingHeartbeatTimer = 0;

function randomOwnerToken() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch (_) {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function resolveOwnerTabId() {
  try {
    const existing = String(sessionStorage.getItem(STREAM_OWNER_TAB_KEY) || '').trim();
    if (existing) return existing;
    const created = `chat_tab_${randomOwnerToken()}`;
    sessionStorage.setItem(STREAM_OWNER_TAB_KEY, created);
    return created;
  } catch (_) {
    return `chat_tab_${randomOwnerToken()}`;
  }
}

const STREAM_OWNER_TAB_ID = resolveOwnerTabId();
const STREAM_OWNER_RUNTIME_ID = `chat_runtime_${randomOwnerToken()}`;

function readPendingMap() {
  try {
    const raw = localStorage.getItem(PENDING_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writePendingMap(map) {
  try {
    const keys = Object.keys(map || {});
    if (!keys.length) localStorage.removeItem(PENDING_STORE_KEY);
    else localStorage.setItem(PENDING_STORE_KEY, JSON.stringify(map));
    return true;
  } catch (_) {
    return false;
  }
}

function recordPendingStream(session) {
  if (_pageTerminating) return false;
  const map = readPendingMap();
  map[session.chatId] = {
    chatId: session.chatId,
    title: session.title,
    startedAt: session.startedAt,
    phase: String(session.phase || 'preparing'),
    attempt: Math.max(0, Number(session.attempt || 0)),
    dispatchStartedAt: Number(session.dispatchStartedAt || 0),
    requestStartedAt: Number(session.requestStartedAt || 0),
    taskId: String(session.taskId || ''),
    idempotencyKey: String(session.idempotencyKey || ''),
    remoteJobId: String(session.remoteJobId || ''),
    aiRoundId: String(session.aiRoundId || ''),
    intent: session.intent && typeof session.intent === 'object' ? session.intent : null,
    ownerTabId: STREAM_OWNER_TAB_ID,
    ownerRuntimeId: STREAM_OWNER_RUNTIME_ID,
    heartbeatAt: Date.now(),
  };
  return writePendingMap(map);
}

function isSafePreDispatchPending(entry = null) {
  if (!entry || typeof entry !== 'object') return false;
  const phase = String(entry.phase || 'preparing').trim();
  return (phase === 'preparing' || phase === 'ready')
    && Math.max(0, Number(entry.attempt || 0)) === 0
    && Number(entry.dispatchStartedAt || 0) <= 0
    && Number(entry.requestStartedAt || 0) <= 0
    && !!String(entry.taskId || '').trim()
    && !!String(entry.idempotencyKey || '').trim()
    && !!String(entry.aiRoundId || '').trim();
}

function syncPendingStreamHeartbeat() {
  if (_sessions.size > 0 && !_pendingHeartbeatTimer) {
    _pendingHeartbeatTimer = setInterval(() => {
      for (const session of _sessions.values()) recordPendingStream(session);
    }, PENDING_TYPING_HEARTBEAT_MS);
    _pendingHeartbeatTimer?.unref?.();
    return;
  }
  if (_sessions.size === 0 && _pendingHeartbeatTimer) {
    clearInterval(_pendingHeartbeatTimer);
    _pendingHeartbeatTimer = 0;
  }
}

export function clearPendingChatStream(chatId, {
  taskId = '',
  ownerRuntimeId = '',
} = {}) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  const map = readPendingMap();
  const row = map[id];
  if (!row) return false;
  const expectedTaskId = String(taskId || '').trim();
  const expectedOwnerId = String(ownerRuntimeId || '').trim();
  if (expectedTaskId && String(row.taskId || '').trim() !== expectedTaskId) return false;
  if (expectedOwnerId && String(row.ownerRuntimeId || '').trim() !== expectedOwnerId) return false;
  delete map[id];
  writePendingMap(map);
  return true;
}

/** Pending records with no live session: interrupted by process death or reload. */
export function listStalePendingChatStreams() {
  const map = readPendingMap();
  const now = Date.now();
  return Object.values(map).filter((entry) => (
    entry?.chatId
    // pagehide 会把所有请求阶段写成 tombstone。已提交阶段永不重放；但完整且
    // attempt=0 的 preflight 即使 sessionStorage 被 Android renderer 一并清掉，
    // 仍必须能从 localStorage 重新产出 notice，再由任务账本做最终安全核验。
    && (!entry.interruptedAt || isSafePreDispatchPending(entry))
    && !_sessions.has(entry.chatId)
    // 其它标签页仍在按 4 秒心跳更新时，它不是本页可恢复的“尸体”。同一标签页
    // reload 后 tab id 不变、runtime id 改变，仍可立即识别并恢复自己的 preflight。
    && !(
      String(entry.ownerRuntimeId || '').trim()
      && String(entry.ownerRuntimeId || '').trim() !== STREAM_OWNER_RUNTIME_ID
      && String(entry.ownerTabId || '').trim() !== STREAM_OWNER_TAB_ID
      && now - Number(entry.heartbeatAt || entry.startedAt || 0) <= PENDING_TYPING_FRESH_MS
    )
  ));
}

function markPendingStreamsInterrupted(entries = []) {
  const map = readPendingMap();
  const interruptedAt = Date.now();
  for (const entry of entries) {
    const chatId = String(entry?.chatId || '').trim();
    if (!chatId) continue;
    map[chatId] = {
      chatId,
      title: String(entry?.title || '').trim(),
      startedAt: Number(entry?.startedAt || 0) || interruptedAt,
      taskId: String(entry?.taskId || '').trim(),
      idempotencyKey: String(entry?.idempotencyKey || '').trim(),
      remoteJobId: String(entry?.remoteJobId || '').trim(),
      aiRoundId: String(entry?.aiRoundId || '').trim(),
      phase: String(entry?.phase || 'preparing'),
      attempt: Math.max(0, Number(entry?.attempt || 0)),
      dispatchStartedAt: Number(entry?.dispatchStartedAt || 0),
      requestStartedAt: Number(entry?.requestStartedAt || 0),
      intent: entry?.intent && typeof entry.intent === 'object' ? entry.intent : null,
      interruptedAt,
      blockAutoUntil: interruptedAt + INTERRUPTED_AUTO_RETRY_COOLDOWN_MS,
    };
  }
  writePendingMap(map);
}

/**
 * Startup cleanup: chats killed mid-generation keep "正在输入…" as their stored
 * preview. Recalculate previews and log what happened so users see a normal
 * chat list instead of a permanent typing state.
 */
const INTERRUPTED_NOTICE_KEY = 'mm_chat_stream_interrupted_v1';

function recordInterruptedNotices(entries = []) {
  try {
    const raw = sessionStorage.getItem(INTERRUPTED_NOTICE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    for (const entry of entries) {
      if (entry?.chatId) map[entry.chatId] = {
        startedAt: entry.startedAt || 0,
        phase: String(entry.phase || ''),
        attempt: Math.max(0, Number(entry.attempt || 0)),
        dispatchStartedAt: Number(entry.dispatchStartedAt || 0),
        requestStartedAt: Number(entry.requestStartedAt || 0),
        taskId: String(entry.taskId || '').trim(),
        idempotencyKey: String(entry.idempotencyKey || '').trim(),
        aiRoundId: String(entry.aiRoundId || '').trim(),
        intent: entry.intent && typeof entry.intent === 'object' ? entry.intent : null,
      };
    }
    sessionStorage.setItem(INTERRUPTED_NOTICE_KEY, JSON.stringify(map));
  } catch (_) { /* ignore */ }
}

/** One-shot notice for the chat page: last generation died with the process. */
export function takeInterruptedChatStreamNotice(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  try {
    const raw = sessionStorage.getItem(INTERRUPTED_NOTICE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    if (!map[id]) return null;
    const notice = map[id];
    delete map[id];
    if (Object.keys(map).length) sessionStorage.setItem(INTERRUPTED_NOTICE_KEY, JSON.stringify(map));
    else sessionStorage.removeItem(INTERRUPTED_NOTICE_KEY);
    return notice;
  } catch (_) {
    return null;
  }
}

export async function recoverStalePendingChatStreams() {
  const stale = listStalePendingChatStreams();
  const pendingRows = Object.values(readPendingMap());
  const now = Date.now();
  const externallyLiveTaskIds = pendingRows.filter((entry) => (
    entry?.taskId
    && !entry.interruptedAt
    && String(entry.ownerRuntimeId || '').trim()
    && String(entry.ownerRuntimeId || '').trim() !== STREAM_OWNER_RUNTIME_ID
    && String(entry.ownerTabId || '').trim() !== STREAM_OWNER_TAB_ID
    && now - Number(entry.heartbeatAt || entry.startedAt || 0) <= PENDING_TYPING_FRESH_MS
  )).map((entry) => entry.taskId);
  const reconciliation = await reconcileGenerationTasks({
    reason: 'lifecycle',
    liveTaskIds: [
      ..._sessions.values(),
      ...externallyLiveTaskIds.map((taskId) => ({ taskId })),
    ].map((session) => session?.taskId).filter(Boolean),
  }).catch(() => ({ checked: 0, changed: [] }));
  const reconciled = (reconciliation.changed || [])
    .filter((task) => task?.chatId)
    .map((task) => {
      const status = String(task.status || 'interrupted');
      const attempt = Math.max(0, Number(task.attemptCount || 0));
      const phase = status === 'preparing' || status === 'ready'
        ? status
        : status === 'dispatching'
          ? 'dispatching'
          : status === 'received'
            ? 'received'
            : ['running', 'remote-running'].includes(status)
              ? 'submitted'
              : 'interrupted';
      return {
        chatId: task.chatId,
        taskId: task.taskId,
        idempotencyKey: task.idempotencyKey,
        aiRoundId: task.aiRoundId,
        startedAt: task.startedAt,
        phase,
        attempt,
        dispatchStartedAt: attempt > 0 ? Number(task.dispatchStartedAt || task.updatedAt || 0) : 0,
        requestStartedAt: Number(task.requestStartedAt || 0),
        status,
        partialLength: String(task.partial || '').length,
      };
    });
  const entries = [
    ...stale,
    ...reconciled,
  ].filter((entry, index, list) => (
    list.findIndex((item) => item.chatId === entry.chatId) === index
  ));
  if (!entries.length) return { recovered: 0, reconciliation };
  recordInterruptedNotices(entries);
  // 不立刻删掉中断记录：iOS 页面虽已重载，上游请求仍可能继续生成并计费。
  // 留一个短期 tombstone，只挡真人感/后台自动接话；用户手动推进仍可明确接管。
  markPendingStreamsInterrupted(entries);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHAT_STREAM_INTERRUPTED_EVENT, {
      detail: {
        chatIds: entries.map((entry) => String(entry?.chatId || '')).filter(Boolean),
      },
    }));
  }
  for (const entry of entries) {
    try {
      const { recalcChatPreview } = await import('../chat-store.js');
      await recalcChatPreview(entry.chatId);
    } catch (_) { /* chat may be gone */ }
  }
  import('../debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
    type: 'chat_stream_interrupted',
    level: 'warn',
    message: `发现 ${entries.length} 个会话上次生成时连接已中断，已对账且未自动重发`,
    context: {
      chatIds: entries.map((e) => e.chatId),
      taskIds: reconciled.map((e) => e.taskId).filter(Boolean),
    },
  })).catch(() => {});
  return { recovered: entries.length, entries, reconciliation };
}

/** Keep the native foreground service alive only while something is generating. */
function syncGenerationKeepAlive() {
  const active = _sessions.size > 0;
  syncPendingStreamHeartbeat();
  if (typeof window !== 'undefined') {
    window.__mm_chat_generation_active__ = _sessions.size;
    window.dispatchEvent(new CustomEvent('marshmallow-generation-activity', {
      detail: { source: 'chat', active: _sessions.size },
    }));
  }
  import('../background-scheduler.js')
    .then((mod) => mod.setGenerationKeepAliveActive?.(active))
    .catch(() => {});
}

function notify() {
  for (const fn of _listeners) {
    try { fn(); } catch (_) { /* ignore */ }
  }
}

export function subscribeChatStreamSession(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

export function isChatStreaming(chatId) {
  return _sessions.has(String(chatId || '').trim());
}

/** Includes foreground generation running in another same-origin tab. */
export function isChatStreamPendingAnywhere(chatId, { includeInterrupted = true } = {}) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  if (_sessions.has(id)) return true;

  const pending = readPendingMap();
  const row = pending[id];
  if (!row) return false;

  if (row.interruptedAt) {
    if (isSafePreDispatchPending(row)) {
      const startedAt = Number(row.startedAt || row.interruptedAt || 0);
      if (startedAt > 0 && Date.now() - startedAt <= PENDING_MAX_AGE_MS) {
        return includeInterrupted;
      }
    }
    const stillBlockingReplay = Date.now() < Number(row.blockAutoUntil || 0);
    if (!stillBlockingReplay) {
      delete pending[id];
      writePendingMap(pending);
    }
    // tombstone 继续阻止后台自动重发，但列表 typing 只认真实活跃请求。
    return includeInterrupted && stillBlockingReplay;
  }

  const startedAt = Number(row.startedAt || 0);
  if (startedAt > 0 && Date.now() - startedAt <= PENDING_MAX_AGE_MS) return true;

  delete pending[id];
  writePendingMap(pending);
  return false;
}

/** Read-only lifecycle evidence for choosing whether an explicit retry needs a fresh identity. */
export function getPendingChatStreamRecord(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const row = readPendingMap()[id];
  return row && typeof row === 'object' ? { ...row } : null;
}

/** UI typing signal: unlike generation guards, interrupted tombstones are not active requests. */
export function isChatStreamTypingAnywhere(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  if (_sessions.has(id)) return true;
  const row = readPendingMap()[id];
  if (!row || row.interruptedAt) return false;
  const heartbeatAt = Number(row.heartbeatAt || row.startedAt || 0);
  return heartbeatAt > 0 && Date.now() - heartbeatAt <= PENDING_TYPING_FRESH_MS;
}

export function getChatStreamSession(chatId) {
  const id = String(chatId || '').trim();
  return id ? (_sessions.get(id) || null) : null;
}

/** Update lifecycle metadata without replacing the controller or generation lock. */
export function updateChatStreamSession(chatId, patch = {}) {
  const session = getChatStreamSession(chatId);
  if (!session || !patch || typeof patch !== 'object') return null;
  Object.assign(session, patch);
  recordPendingStream(session);
  notify();
  return session;
}

export function getActiveChatStreamSessions() {
  return [..._sessions.values()];
}

export function beginChatStreamSession(chatId, {
  title = '',
  abortController = null,
  taskId = '',
  idempotencyKey = '',
  aiRoundId = '',
  startedAt = Date.now(),
  intent = null,
  claimPending = false,
  requireDurable = false,
} = {}) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  if (claimPending && !_sessions.has(id)) {
    const pending = readPendingMap()[id];
    const heartbeatAt = Number(pending?.heartbeatAt || pending?.startedAt || 0);
    const foreignRuntime = String(pending?.ownerRuntimeId || '').trim();
    const foreignTab = String(pending?.ownerTabId || '').trim();
    const activelyOwnedElsewhere = pending
      && !pending.interruptedAt
      && heartbeatAt > 0
      && Date.now() - heartbeatAt <= PENDING_TYPING_FRESH_MS
      && foreignRuntime !== STREAM_OWNER_RUNTIME_ID
      && (!foreignTab || foreignTab !== STREAM_OWNER_TAB_ID);
    if (activelyOwnedElsewhere) return null;
  }
  const prev = _sessions.get(id);
  if (prev?.abortController && prev.abortController !== abortController) {
    try { prev.abortController.abort?.(); } catch (_) { /* ignore */ }
  }
  if (typeof prev?._releaseCriticalActivity === 'function') {
    try { prev._releaseCriticalActivity(); } catch (_) { /* ignore */ }
  }
  const releaseCriticalActivity = typeof globalThis.__mm_begin_critical_activity__ === 'function'
    ? globalThis.__mm_begin_critical_activity__('chat-generation')
    : null;
  const session = {
    chatId: id,
    title: String(title || '').trim(),
    abortController,
    taskId: String(taskId || '').trim(),
    idempotencyKey: String(idempotencyKey || '').trim(),
    aiRoundId: String(aiRoundId || '').trim(),
    startedAt: Number(startedAt || 0) || Date.now(),
    phase: 'preparing',
    attempt: 0,
    dispatchStartedAt: 0,
    requestStartedAt: 0,
    intent: intent && typeof intent === 'object' ? intent : null,
    _releaseCriticalActivity: releaseCriticalActivity,
  };
  const pendingRecorded = recordPendingStream(session);
  if (requireDurable && !pendingRecorded) {
    if (typeof releaseCriticalActivity === 'function') {
      try { releaseCriticalActivity(); } catch (_) { /* ignore */ }
    }
    return null;
  }
  _sessions.set(id, session);
  syncGenerationKeepAlive();
  notify();
  return session;
}

export function endChatStreamSession(chatId, { taskId = '' } = {}) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  const session = _sessions.get(id);
  const expectedTaskId = String(taskId || '').trim();
  if (expectedTaskId && String(session?.taskId || '').trim() !== expectedTaskId) return false;
  // 没有本 runtime 的 session 时，pending 可能属于另一标签页；不能用一次本地
  // no-op end 顺手清掉对方的耐久 guard。
  if (!session) return false;
  if (!_pageTerminating) {
    clearPendingChatStream(id, {
      taskId: expectedTaskId,
      ownerRuntimeId: session ? STREAM_OWNER_RUNTIME_ID : '',
    });
  }
  _sessions.delete(id);
  if (typeof session._releaseCriticalActivity === 'function') {
    try { session._releaseCriticalActivity(); } catch (_) { /* ignore */ }
  }
  syncGenerationKeepAlive();
  notify();
  return true;
}

export function abortChatStream(chatId) {
  const session = getChatStreamSession(chatId);
  if (!session) return false;
  try { session.abortController?.abort?.(); } catch (_) { /* ignore */ }
  return true;
}

export const CHAT_STREAM_PREVIEW = '正在输入…';

let _lifecycleReconcileInstalled = false;

function installGenerationTaskReconciliation() {
  if (_lifecycleReconcileInstalled || typeof window === 'undefined') return;
  _lifecycleReconcileInstalled = true;
  let reconcileInFlight = null;
  const reconcile = () => {
    _pageTerminating = false;
    if (reconcileInFlight) return reconcileInFlight;
    reconcileInFlight = recoverStalePendingChatStreams()
      .catch(() => {})
      .finally(() => { reconcileInFlight = null; });
    return reconcileInFlight;
  };
  window.addEventListener('pageshow', reconcile, { passive: true });
  window.addEventListener('online', reconcile, { passive: true });
  window.addEventListener('storage', (event) => {
    if (event?.key === PENDING_STORE_KEY) notify();
  });
  window.addEventListener('pagehide', (event) => {
    if (event?.persisted === true) return;
    _pageTerminating = true;
    const interrupted = [..._sessions.values()];
    // pagehide 主动写下 tombstone 后，startup stale 扫描会刻意跳过它；因此 notice
    // 必须在旧页面退出时同时落到 sessionStorage。否则正常 reload 恰好会让一条
    // 尚未 dispatch 的耐久 preflight 永远失去恢复入口。
    recordInterruptedNotices(interrupted);
    markPendingStreamsInterrupted(interrupted);
  }, { passive: true });
  // 模块首次加载也要立刻恢复。只等 pageshow 会出现路由先消费 notice、恢复逻辑
  // 随后才产出 notice 的竞态，当前聊天页因此永远看不到这次中断。
  Promise.resolve().then(reconcile);
}

installGenerationTaskReconciliation();
