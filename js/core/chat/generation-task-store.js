import { get, put, remove } from '../db.js';

const TASK_INDEX_KEY = 'chatGenerationTaskIndex_v1';
const TASK_KEY_PREFIX = 'chatGenerationTask_v1_';
const ACTIVE_STATUSES = new Set([
  'pending',
  'preparing',
  'ready',
  'dispatching',
  'running',
  'remote-running',
  'received',
]);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const PRE_DISPATCH_STATUSES = new Set(['preparing', 'ready']);
const QUERYABLE_DISPATCH_STATUSES = new Set(['dispatching', 'running', 'remote-running', 'received']);
const DEFAULT_CHECKPOINT_INTERVAL_MS = 800;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_TASKS = 60;

let _statusQuery = null;
const _liveTaskIds = new Set();
// “当前活跃”与“已经确认在恢复索引中”不是同一件事：task record 写成功但 index
// 写失败时仍要允许下一次 checkpoint 修复索引，不能因任务活跃就永久跳过核验。
const _indexedTaskIds = new Set();
let _taskIndexMutation = Promise.resolve();

function taskStorageKey(taskId) {
  return `${TASK_KEY_PREFIX}${String(taskId || '').trim()}`;
}

function randomToken() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch (_) {}
  const rand = Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${rand}`;
}

export function makeGenerationTaskIdentity() {
  const token = randomToken();
  return {
    taskId: `chat_task_${token}`,
    idempotencyKey: `chat_idem_${token}`,
  };
}

export function summarizeGenerationPrompt(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let textChars = 0;
  let imageCount = 0;
  for (const message of list) {
    const role = String(message?.role || 'unknown');
    roles[role] = Number(roles[role] || 0) + 1;
    if (typeof message?.content === 'string') {
      textChars += message.content.length;
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url') imageCount += 1;
      else textChars += String(part?.text || part?.content || '').length;
    }
  }
  return {
    messageCount: list.length,
    roles,
    textChars,
    imageCount,
  };
}

export function describeGenerationTransport({
  baseUrl = '',
  stream = false,
  supportsServerIdempotency = false,
  supportsStatusQuery = false,
} = {}) {
  const value = String(baseUrl || '').trim();
  const absolute = /^https?:\/\//i.test(value);
  let endpoint = value;
  try {
    if (absolute) {
      const parsed = new URL(value);
      endpoint = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    }
  } catch (_) {}
  return {
    kind: absolute ? 'direct-third-party' : 'same-origin-relay',
    endpoint,
    stream: stream === true,
    supportsServerIdempotency: supportsServerIdempotency === true,
    supportsStatusQuery: supportsStatusQuery === true,
  };
}

export function canAutoRetryGenerationTask(task) {
  return task?.transport?.supportsServerIdempotency === true;
}

/**
 * Only these records prove that no model request has crossed the dispatch boundary.
 * Anything else is deliberately treated as unknown unless the transport can be queried.
 */
export function isGenerationTaskSafePreDispatch(task) {
  return Boolean(
    task?.taskId
    && PRE_DISPATCH_STATUSES.has(String(task.status || ''))
    && Number(task.attemptCount || 0) === 0
  );
}

export function classifyGenerationTaskRecovery(task) {
  if (!task?.taskId) return 'missing';
  if (isGenerationTaskSafePreDispatch(task)) return 'safe-pre-dispatch';
  const status = String(task.status || '');
  if (
    QUERYABLE_DISPATCH_STATUSES.has(status)
    && task.transport?.supportsStatusQuery === true
  ) return 'query-only';
  if (TERMINAL_STATUSES.has(status)) return 'terminal';
  return 'outcome-unknown';
}

async function readTaskIndex() {
  const row = await get(TASK_INDEX_KEY).catch(() => null);
  return Array.isArray(row?.value) ? row.value.filter(Boolean) : [];
}

async function writeTaskIndex(ids = []) {
  const unique = [...new Set(ids.filter(Boolean))];
  await put({ key: TASK_INDEX_KEY, value: unique });
}

function serializeTaskIndexMutation(mutate) {
  const operation = _taskIndexMutation
    .catch(() => {})
    .then(async () => {
      const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
      if (typeof locks?.request === 'function') {
        return locks.request(
          'marshmallow:generation-task-index',
          { mode: 'exclusive' },
          () => mutate(),
        );
      }
      return mutate();
    });
  // Reject the affected caller without poisoning later index repairs.
  _taskIndexMutation = operation.catch(() => {});
  return operation;
}

function ensureTaskIndexed(taskId) {
  return serializeTaskIndexMutation(async () => {
    // This read is intentionally strict. Treating a failed read as an empty index
    // can erase every task another generation already registered.
    const row = await get(TASK_INDEX_KEY);
    const ids = Array.isArray(row?.value) ? row.value.filter(Boolean) : [];
    if (!ids.includes(taskId)) await writeTaskIndex([...ids, taskId]);
    _indexedTaskIds.add(taskId);
  });
}

export async function saveGenerationTask(task) {
  if (!task?.taskId) return null;
  const alreadyIndexedInThisRun = _indexedTaskIds.has(task.taskId);
  const next = {
    ...task,
    updatedAt: Number(task.updatedAt || 0) || Date.now(),
  };
  await put({ key: taskStorageKey(next.taskId), value: next });
  // create/load 时已经确认过索引；流式检查点只覆盖同一 task key，不必每 800ms
  // 再读一次索引。终态或独立 save 仍走保守核验。
  if (!alreadyIndexedInThisRun) {
    await ensureTaskIndexed(next.taskId);
  }
  return next;
}

export async function getGenerationTaskStrict(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return null;
  const row = await get(taskStorageKey(id));
  return row?.value && typeof row.value === 'object' ? row.value : null;
}

export async function getGenerationTask(taskId) {
  return getGenerationTaskStrict(taskId).catch(() => null);
}

export async function listGenerationTasks() {
  const ids = await readTaskIndex();
  ids.forEach((id) => _indexedTaskIds.add(id));
  const rows = await Promise.all(ids.map((id) => getGenerationTask(id)));
  return rows.filter(Boolean);
}

export async function pruneGenerationTasks({
  now = Date.now(),
  maxTasks = MAX_RETAINED_TASKS,
} = {}) {
  const tasks = await listGenerationTasks();
  const ordered = [...tasks].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const removeIds = ordered
    .filter((task, index) => (
      TERMINAL_STATUSES.has(String(task?.status || ''))
      && (
        index >= Math.max(10, Number(maxTasks) || MAX_RETAINED_TASKS)
        || now - Number(task.updatedAt || task.startedAt || 0) > TERMINAL_RETENTION_MS
      )
    ))
    .map((task) => task.taskId);
  if (!removeIds.length) return { removed: 0 };
  await Promise.all(removeIds.map((id) => remove(taskStorageKey(id)).catch(() => {})));
  await serializeTaskIndexMutation(async () => {
    const row = await get(TASK_INDEX_KEY);
    const currentIds = Array.isArray(row?.value) ? row.value.filter(Boolean) : [];
    await writeTaskIndex(currentIds.filter((id) => !removeIds.includes(id)));
  });
  removeIds.forEach((id) => _indexedTaskIds.delete(id));
  return { removed: removeIds.length };
}

export async function createGenerationTask({
  taskId,
  idempotencyKey,
  chatId,
  aiRoundId = '',
  sourceActionId = '',
  anchorMessageId = '',
  anchorTimestamp = 0,
  startedAt = Date.now(),
  transport = {},
  promptSummary = {},
  status = 'preparing',
} = {}) {
  const identity = taskId && idempotencyKey
    ? { taskId, idempotencyKey }
    : makeGenerationTaskIdentity();
  const previous = await getGenerationTaskStrict(identity.taskId);
  if (previous) {
    if (
      String(previous.idempotencyKey || '').trim()
      && String(previous.idempotencyKey || '').trim() !== String(identity.idempotencyKey || '').trim()
    ) {
      throw new Error('生成任务身份冲突，已停止复用旧请求');
    }
    // A task row can survive while its recovery index write did not. Re-saving here
    // repairs the index before a resumed action is allowed to continue.
    const repaired = await saveGenerationTask({
      ...previous,
      sourceActionId: String(previous.sourceActionId || sourceActionId || '').trim(),
      anchorMessageId: String(previous.anchorMessageId || anchorMessageId || '').trim(),
      anchorTimestamp: Number(previous.anchorTimestamp || anchorTimestamp || 0),
    });
    // Do not trust the in-memory cache when explicitly resuming an existing task:
    // another tab or a failed prune may have replaced the shared index meanwhile.
    await ensureTaskIndexed(repaired.taskId);
    _liveTaskIds.add(repaired.taskId);
    return repaired;
  }
  const now = Date.now();
  const created = await saveGenerationTask({
    version: 1,
    taskId: identity.taskId,
    idempotencyKey: identity.idempotencyKey,
    chatId: String(chatId || '').trim(),
    aiRoundId: String(aiRoundId || '').trim(),
    sourceActionId: String(sourceActionId || '').trim(),
    anchorMessageId: String(anchorMessageId || '').trim(),
    anchorTimestamp: Number(anchorTimestamp || 0),
    startedAt: Number(startedAt || 0) || now,
    updatedAt: now,
    transport: { ...(transport || {}) },
    promptSummary: { ...(promptSummary || {}) },
    status: String(status || 'preparing'),
    attemptCount: 0,
    partial: '',
    sseFragments: [],
    error: null,
  });
  _liveTaskIds.add(created.taskId);
  return created;
}

function mergeTaskPatch(task, patch = {}) {
  const next = {
    ...task,
    ...patch,
    updatedAt: Date.now(),
  };
  if (patch.transport) next.transport = { ...(task.transport || {}), ...patch.transport };
  if (patch.error === undefined) next.error = task.error ?? null;
  return next;
}

export function createGenerationTaskCheckpointWriter(initialTask, {
  intervalMs = DEFAULT_CHECKPOINT_INTERVAL_MS,
  persist = saveGenerationTask,
} = {}) {
  if (!initialTask?.taskId) {
    return {
      checkpoint() {},
      appendSseFragment() {},
      async flush() { return null; },
      getTask() { return null; },
    };
  }
  let task = { ...initialTask, sseFragments: [...(initialTask.sseFragments || [])] };
  let timer = null;
  let revision = 0;
  let settledRevision = 0;
  let strictRevision = 0;
  let inFlight = null;

  const startPump = () => {
    if (inFlight) return inFlight;
    if (settledRevision >= revision) return Promise.resolve(task);
    // 原生主库较慢时，旧实现会把每个 800ms 快照都追加到 FIFO；完整 partial
    // 是累积态，中间覆盖没有独立价值。这里只允许一笔在途写，期间发生的更新
    // 合并成下一份最新快照。
    inFlight = (async () => {
      let saved = task;
      while (settledRevision < revision) {
        const snapshotRevision = revision;
        const snapshot = {
          ...task,
          sseFragments: [...(task.sseFragments || [])],
          updatedAt: Date.now(),
        };
        try {
          saved = await persist(snapshot) || snapshot;
        } catch (error) {
          // Preparing/ready/dispatching are safety boundaries. Their callers opt into
          // strict persistence so an unavailable ledger stops before any API request.
          if (settledRevision < strictRevision) throw error;
          // 任务账本是可靠性增强，单次检查点失败不能反过来中断生成。
          saved = snapshot;
        }
        settledRevision = Math.max(settledRevision, snapshotRevision);
      }
      return saved;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const drainTo = async (targetRevision) => {
    // startPump 的旧 Promise 可能正处于“循环已退出、finally 尚未清空 inFlight”的
    // 微任务缝隙。循环核验 revision 屏障，保证 terminal flush 不会误等旧 Promise
    // 后直接返回、却把最后状态留在内存里。
    while (settledRevision < targetRevision) {
      await startPump();
    }
    return task;
  };

  const schedule = () => {
    if (timer != null) return;
    timer = setTimeout(() => {
      timer = null;
      void drainTo(revision);
    }, Math.max(0, Number(intervalMs) || 0));
  };

  return {
    checkpoint(patch = {}, { immediate = false, strict = false } = {}) {
      task = mergeTaskPatch(task, patch);
      if (TERMINAL_STATUSES.has(task.status)) _liveTaskIds.delete(task.taskId);
      else _liveTaskIds.add(task.taskId);
      revision += 1;
      if (strict) strictRevision = Math.max(strictRevision, revision);
      if (immediate) {
        if (timer != null) clearTimeout(timer);
        timer = null;
        return drainTo(revision);
      }
      schedule();
      return Promise.resolve(task);
    },
    appendSseFragment(fragment, patch = {}) {
      const text = String(fragment || '');
      if (text) {
        if (!Array.isArray(task.sseFragments)) task.sseFragments = [];
        task.sseFragments.push(text);
      }
      task = mergeTaskPatch(task, patch);
      revision += 1;
      schedule();
    },
    async flush(patch = null) {
      if (patch) task = mergeTaskPatch(task, patch);
      if (TERMINAL_STATUSES.has(task.status)) _liveTaskIds.delete(task.taskId);
      else _liveTaskIds.add(task.taskId);
      if (patch) revision += 1;
      if (timer != null) clearTimeout(timer);
      timer = null;
      await drainTo(revision);
      return task;
    },
    getTask() {
      return task;
    },
  };
}

export function registerGenerationTaskStatusQuery(queryFn) {
  _statusQuery = typeof queryFn === 'function' ? queryFn : null;
  return () => {
    if (_statusQuery === queryFn) _statusQuery = null;
  };
}

export async function queryGenerationTaskStatus(task) {
  if (!task?.transport?.supportsStatusQuery || typeof _statusQuery !== 'function') {
    return { supported: false, status: 'unknown' };
  }
  const result = await _statusQuery({
    taskId: task.taskId,
    idempotencyKey: task.idempotencyKey,
    chatId: task.chatId,
    transport: task.transport,
  });
  return { supported: true, ...(result || {}) };
}

export async function reconcileGenerationTasks({
  reason = 'startup',
  liveTaskIds = [],
} = {}) {
  const live = new Set((Array.isArray(liveTaskIds) ? liveTaskIds : []).filter(Boolean));
  for (const taskId of _liveTaskIds) live.add(taskId);
  const tasks = await listGenerationTasks();
  const changed = [];
  for (const task of tasks) {
    if (!ACTIVE_STATUSES.has(task.status) || live.has(task.taskId)) continue;
    // Context construction is entirely local. A preparing/ready task with no attempt
    // cannot have reached an upstream API, so leave it resumable for its pending action.
    if (isGenerationTaskSafePreDispatch(task)) continue;
    let next = task;
    if (task.transport?.supportsStatusQuery === true && typeof _statusQuery === 'function') {
      try {
        const remote = await queryGenerationTaskStatus(task);
        if (remote.status === 'running' || remote.status === 'pending') {
          next = mergeTaskPatch(task, {
            status: 'remote-running',
            reconciliation: { reason, checkedAt: Date.now(), remoteStatus: remote.status },
          });
        } else if (remote.status === 'completed') {
          next = mergeTaskPatch(task, {
            // 完整结果已经取回，保持 received 让 pending-action 恢复器执行纯本地
            // 落库；不能先终结任务并把已付费正文只留在错误日志里。
            status: 'received',
            partial: String(remote.partial ?? task.partial ?? ''),
            ...(Array.isArray(remote.sseFragments) ? { sseFragments: remote.sseFragments } : {}),
            error: null,
            reconciliation: { reason, checkedAt: Date.now(), remoteStatus: 'completed' },
          });
        } else {
          next = mergeTaskPatch(task, {
            status: 'interrupted',
            error: remote.error || { kind: 'remote-unavailable', message: '中继未确认任务结果' },
            reconciliation: { reason, checkedAt: Date.now(), remoteStatus: remote.status || 'unknown' },
          });
        }
      } catch (error) {
        next = mergeTaskPatch(task, {
          // 一次查询失败不是远端失败证据。保留可查询状态，下一次前台/定时对账重试。
          status: task.status,
          reconciliation: { reason, checkedAt: Date.now(), remoteStatus: 'query-failed' },
        });
      }
    } else {
      next = mergeTaskPatch(task, {
        status: 'interrupted',
        error: {
          kind: task.status === 'received' ? 'client-persist-interrupted' : 'client-disconnected',
          message: task.status === 'received'
            ? '回复已接收，但客户端在完成聊天落库前退出；已保留完整检查点且未自动重发。'
            : '客户端恢复时发现任务没有活动连接；未向第三方自动重发。',
        },
        reconciliation: { reason, checkedAt: Date.now(), remoteStatus: 'unknown' },
      });
    }
    if (next !== task) {
      await saveGenerationTask(next).catch(() => {});
      changed.push(next);
    }
  }
  await pruneGenerationTasks().catch(() => {});
  return { checked: tasks.length, changed };
}

export function isGenerationTaskTerminal(task) {
  return TERMINAL_STATUSES.has(String(task?.status || ''));
}
