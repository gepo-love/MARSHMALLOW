import { get as dbGet, put as dbPut, getRecord } from '../db.js';
import {
  bumpChatUnread,
  getChat,
  listMessagesForChat,
  previewFromMessage,
  saveMessage,
  updateChatPreview,
} from '../chat-store.js';
import { getCharacter } from '../character-store.js';
import {
  isHeadlessChatReplyRunning,
  runHeadlessChatReply,
} from './headless-reply.js';
import {
  classifyGenerationTaskRecovery,
  getGenerationTaskStrict,
  isGenerationTaskTerminal,
  makeGenerationTaskIdentity,
  queryGenerationTaskStatus,
  saveGenerationTask,
} from './generation-task-store.js';
import { applyGeneratedChatShares } from './social-chat-relay.js';
import { createMessage } from '../../models/chat.js';
import {
  getNowForUser,
  getTimeMode,
  TIME_MODE_VIRTUAL,
} from '../time-mode.js';
import {
  buildRealPersonReplyFreshnessBlock,
  getUnansweredRealUserMessage,
  isAutomaticGenerationAnchorStopped,
} from './marshmallow-presence.js';
import { isChatComposerBusy } from './chat-composer-guard.js';
import { evaluateChatComposerActivity } from './idle-continue-reply.js';
import { recordChatContinuityIncident } from './continuity-repair.js';

export const PENDING_ACTION_CHECK_MS = 60 * 1000;
export const PENDING_ACTION_EXPIRE_MS = 3 * 60 * 60 * 1000;

const MAX_ACTIONS_PER_TICK = 3;
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
const VALID_KINDS = new Set([
  'delayed_reply',
  'real_person_reply',
  'social_followup',
  'share_followup',
  'chase_beat',
  'cold_follow_up',
  'interaction_invite',
  'life_glimpse',
]);
const PENDING_CHAT_CANCELLATIONS_KEY = 'mmPendingChatCancellationsV1';
const PENDING_CHAT_CANCELLATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const inFlightUsers = new Set();
const mutationLocks = new Map();
const pendingChatCancellations = new Map();

function clean(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function settingKey(userId) {
  return `chatPendingActions:${clean(userId)}`;
}

function pendingChatCancellationKey(userId, chatId) {
  const uid = clean(userId);
  const cid = clean(chatId);
  return uid && cid ? `${uid}\n${cid}` : '';
}

function readStoredPendingChatCancellations(now = Date.now()) {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_CHAT_CANCELLATIONS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => (
      Number(value || 0) > 0
      && now - Number(value) <= PENDING_CHAT_CANCELLATION_RETENTION_MS
    )));
  } catch (_) {
    return {};
  }
}

/**
 * 先同步登记“本会话现有待办全部取消”，再异步删 IndexedDB。
 * runPendingChatActions 会在同一批每个任务启动前检查这里，避免当前任务中止后，
 * 仍在用户级 mutation lock 内的第 2、3 个已领取任务马上接力生成。
 */
export function requestPendingChatActionCancellation(userId, chatId, at = Date.now()) {
  const key = pendingChatCancellationKey(userId, chatId);
  if (!key) return false;
  const requestedAt = Math.max(1, Number(at) || Date.now());
  pendingChatCancellations.set(key, requestedAt);
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = readStoredPendingChatCancellations(requestedAt);
      stored[key] = requestedAt;
      localStorage.setItem(PENDING_CHAT_CANCELLATIONS_KEY, JSON.stringify(stored));
    } catch (_) {}
  }
  return true;
}

function clearPendingChatActionCancellation(userId, chatId) {
  const key = pendingChatCancellationKey(userId, chatId);
  if (!key) return false;
  pendingChatCancellations.delete(key);
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = readStoredPendingChatCancellations();
      delete stored[key];
      localStorage.setItem(PENDING_CHAT_CANCELLATIONS_KEY, JSON.stringify(stored));
    } catch (_) {}
  }
  return true;
}

export function isPendingChatActionCancellationRequested(action = {}) {
  const key = pendingChatCancellationKey(action.userId, action.chatId);
  if (!key) return false;
  const storedAt = Number(readStoredPendingChatCancellations()[key] || 0);
  const requestedAt = Math.max(Number(pendingChatCancellations.get(key) || 0), storedAt);
  if (!requestedAt) return false;
  pendingChatCancellations.set(key, requestedAt);
  return true;
}

async function withUserMutation(userId, task) {
  const key = clean(userId);
  const previous = mutationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  mutationLocks.set(key, queued);
  await previous;
  try {
    const webLocks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (typeof webLocks?.request === 'function') {
      return await webLocks.request(
        `marshmallow:pending-actions:${key}`,
        { mode: 'exclusive' },
        () => task(),
      );
    }
    return await task();
  } finally {
    release();
    if (mutationLocks.get(key) === queued) mutationLocks.delete(key);
  }
}

function actionId(input = {}) {
  const seed = [
    clean(input.userId),
    clean(input.characterId),
    clean(input.chatId),
    clean(input.kind),
    Number(input.dueAt || 0),
    clean(input.dedupeKey),
  ].join('|');
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `pending_${(hash >>> 0).toString(36)}`;
}

export function normalizePendingAction(input = {}, now = Date.now()) {
  const userId = clean(input.userId);
  const characterId = clean(input.characterId);
  const chatId = clean(input.chatId);
  const kind = clean(input.kind);
  const dueAt = Math.trunc(Number(input.dueAt || 0));
  if (!userId || !characterId || !chatId || !VALID_KINDS.has(kind) || !Number.isFinite(dueAt) || dueAt <= 0) {
    return null;
  }
  return {
    id: clean(input.id) || actionId({ ...input, userId, characterId, chatId, kind, dueAt }),
    userId,
    characterId,
    chatId,
    kind,
    dueAt,
    createdAt: Math.trunc(Number(input.createdAt || now)) || now,
    expiresAt: Math.trunc(Number(input.expiresAt || (dueAt + PENDING_ACTION_EXPIRE_MS))),
    payload: input.payload && typeof input.payload === 'object' ? { ...input.payload } : {},
    dedupeKey: clean(input.dedupeKey, 160),
    attempts: Math.max(0, Math.trunc(Number(input.attempts || 0))),
    claimedAt: Math.max(0, Math.trunc(Number(input.claimedAt || 0))),
    lastError: clean(input.lastError, 180),
  };
}

function hasPendingGenerationIdentity(action = {}) {
  return Boolean(
    clean(action.payload?.generationTaskId)
    && clean(action.payload?.generationIdempotencyKey)
    && clean(action.payload?.generationAiRoundId)
  );
}

/** Add a stable identity once, before the claimed action can enter context construction. */
export function ensurePendingActionGenerationIdentity(input = {}) {
  const action = normalizePendingAction(input);
  if (!action || hasPendingGenerationIdentity(action)) return action;
  const existingTaskId = clean(action.payload?.generationTaskId);
  const existingIdempotencyKey = clean(action.payload?.generationIdempotencyKey);
  // Never splice half of a legacy identity into a new pair: taskId and
  // idempotencyKey must describe the same upstream request for their whole life.
  const preserveExistingPair = Boolean(existingTaskId && existingIdempotencyKey);
  const identity = preserveExistingPair
    ? { taskId: existingTaskId, idempotencyKey: existingIdempotencyKey }
    : makeGenerationTaskIdentity();
  const taskId = identity.taskId;
  const idempotencyKey = identity.idempotencyKey;
  const taskToken = taskId.replace(/^chat_task_/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-48);
  return {
    ...action,
    payload: {
      ...(action.payload || {}),
      generationTaskId: taskId,
      generationIdempotencyKey: idempotencyKey,
      generationAiRoundId: (preserveExistingPair && clean(action.payload?.generationAiRoundId))
        || `round_pending_${taskToken || action.id}`,
    },
  };
}

function pendingActionGenerationOptions(action = {}) {
  return {
    generationTaskId: clean(action.payload?.generationTaskId),
    generationIdempotencyKey: clean(action.payload?.generationIdempotencyKey),
    generationAiRoundId: clean(action.payload?.generationAiRoundId),
    sourceActionId: clean(action.id),
    generationAnchorMessageId: clean(action.payload?.anchorMessageId),
    generationAnchorTimestamp: Number(action.payload?.anchorTimestamp || 0),
  };
}

/**
 * Decide what a fresh process may do with an action whose old executor died.
 * Legacy actions without an identity retain the old claim timeout; they provide no proof either way.
 */
export function planPendingGenerationClaimRecovery(action, task, {
  now = Date.now(),
  active = false,
} = {}) {
  const current = normalizePendingAction(action, now);
  if (!current) return { decision: 'unchanged', action: current };
  if (!hasPendingGenerationIdentity(current)) return { decision: 'legacy-wait', action: current };
  if (active) return { decision: 'active', action: current };

  const disposition = classifyGenerationTaskRecovery(task);
  if (disposition === 'missing' || disposition === 'safe-pre-dispatch') {
    if (!current.claimedAt) return { decision: 'unchanged', action: current };
    return {
      decision: 'retry-safe',
      action: {
        ...current,
        dueAt: Math.min(Number(current.dueAt || now), now),
        claimedAt: 0,
        lastError: 'generation-preflight-interrupted',
      },
    };
  }
  if (disposition === 'query-only') {
    return {
      decision: 'query-only',
      action: {
        ...current,
        claimedAt: now,
        lastError: 'generation-status-query-pending',
      },
    };
  }
  const completed = String(task?.status || '') === 'completed';
  return {
    decision: completed ? 'already-completed' : 'outcome-unknown',
    action: null,
    terminal: {
      actionId: current.id,
      kind: current.kind,
      chatId: current.chatId,
      ok: false,
      terminal: true,
      modelRequestAttempted: Number(task?.attemptCount || 0) > 0,
      reason: completed ? 'generation-already-completed' : 'generation-outcome-unknown',
      generationTaskId: clean(current.payload?.generationTaskId),
      generationTaskStatus: clean(task?.status || 'missing'),
    },
  };
}

async function recoverClaimedPendingGenerationActions(actions = [], now = Date.now(), overrides = {}) {
  const readTask = overrides.getGenerationTask || getGenerationTaskStrict;
  const queryTask = overrides.queryGenerationTaskStatus || queryGenerationTaskStatus;
  const checkActive = overrides.isHeadlessChatReplyRunning || isHeadlessChatReplyRunning;
  const rows = (Array.isArray(actions) ? actions : [])
    .map((item) => normalizePendingAction(item, now))
    .filter(Boolean);
  const plans = await Promise.all(rows.map(async (action) => {
    const dueForExecution = Number(action.dueAt || 0) <= now;
    if ((!action.claimedAt && !dueForExecution) || !hasPendingGenerationIdentity(action)) {
      return { decision: 'unchanged', action };
    }
    const active = checkActive(action.chatId) === true;
    if (active) return planPendingGenerationClaimRecovery(action, null, { now, active: true });
    let task;
    try {
      task = await readTask(action.payload.generationTaskId);
    } catch (_) {
      return {
        decision: 'ledger-unavailable',
        action: {
          ...action,
          dueAt: Math.max(now + PENDING_ACTION_CHECK_MS, Number(action.dueAt || 0)),
          claimedAt: 0,
          lastError: 'generation-ledger-unavailable',
        },
      };
    }
    if (classifyGenerationTaskRecovery(task) === 'query-only') {
      let remote;
      try {
        remote = await queryTask(task);
      } catch (_) {
        // A transient status-query failure is not evidence for either replay or
        // completion. Keep the ticket claimed briefly and query again later.
        return planPendingGenerationClaimRecovery(action, task, { now, active });
      }
      if (remote?.supported !== true) {
        return planPendingGenerationClaimRecovery(action, {
          ...task,
          transport: { ...(task.transport || {}), supportsStatusQuery: false },
        }, { now, active });
      }
      const remoteStatus = String(remote?.status || '').toLowerCase();
      if (remoteStatus === 'pending' || remoteStatus === 'running') {
        return planPendingGenerationClaimRecovery(action, task, { now, active });
      }
      if (remoteStatus === 'completed') {
        const partial = String(remote?.partial ?? task?.partial ?? '').trim();
        if (partial) {
          return {
            decision: 'recover-completed',
            action: {
              ...action,
              dueAt: Math.min(Number(action.dueAt || now), now),
              claimedAt: 0,
              lastError: 'generation-result-recovered',
            },
            task: { ...task, status: 'received', partial },
            remoteResult: { ...remote, partial },
          };
        }
        return planPendingGenerationClaimRecovery(action, {
          ...task,
          status: 'failed',
        }, { now, active });
      }
      // A failed/not-found/unknown remote result is terminal for automatic work:
      // none of those states proves that a fresh third-party charge is safe.
      return planPendingGenerationClaimRecovery(action, {
        ...task,
        status: remoteStatus === 'failed' ? 'failed' : 'interrupted',
        reconciliation: {
          checkedAt: now,
          remoteStatus: remoteStatus || 'unknown',
        },
      }, { now, active });
    }
    return planPendingGenerationClaimRecovery(action, task, { now, active });
  }));
  const terminal = plans.map((plan) => plan.terminal).filter(Boolean);
  const completedResults = new Map(plans
    .filter((plan) => plan.decision === 'recover-completed' && plan.action?.id)
    .map((plan) => [plan.action.id, {
      task: plan.task,
      remote: plan.remoteResult,
    }]));
  const recovered = plans.filter((plan) => plan.decision === 'retry-safe').length;
  const changed = plans.some((plan) => !['unchanged', 'legacy-wait', 'active'].includes(plan.decision));
  if (terminal.some((row) => row.reason === 'generation-outcome-unknown')) {
    void import('../debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
      type: 'pending_generation_outcome_unknown',
      level: 'warn',
      message: '自动回复在请求派发边界后中断，已停止自动重发',
      context: { tasks: terminal.filter((row) => row.reason === 'generation-outcome-unknown') },
    })).catch(() => {});
  }
  return {
    actions: plans.map((plan) => plan.action).filter(Boolean),
    terminal,
    recovered,
    completedResults,
    changed,
  };
}

export function resolvePendingActionProactiveChannel(kind = '') {
  const value = clean(kind);
  if (value === 'real_person_reply' || value === 'life_glimpse') return '';
  if (value === 'delayed_reply') return 'delayed-reply';
  if (value === 'interaction_invite') return 'interaction-invite';
  return 'pending-action';
}

export function pendingActionRequiresProactivePermission(kind = '') {
  // real_person_reply 是对用户新消息的接话；delayed_reply 是角色已经明确登记的
  // “稍后回来”承诺不依赖普通主动消息总开关；互动邀约由会话里的独立开关授权；
  // life_glimpse 是用户单独授权的生活叙事，不冒充普通主动聊天；它会独立调用
  // 一次模型，但仍只受角色级 opt-in 与真人感等待门禁约束。
  return !['real_person_reply', 'delayed_reply', 'interaction_invite', 'life_glimpse'].includes(clean(kind));
}

async function readActions(userId) {
  // Every caller that mutates this collection performs read-modify-write. A read
  // failure is not an empty list: treating it as one can overwrite every ticket.
  const row = await dbGet(settingKey(userId));
  const list = Array.isArray(row?.value?.actions) ? row.value.actions : [];
  return list.map((item) => normalizePendingAction(item)).filter(Boolean);
}

async function writeActions(userId, actions) {
  await dbPut({
    key: settingKey(userId),
    value: {
      version: 1,
      updatedAt: Date.now(),
      actions: (Array.isArray(actions) ? actions : []).map((item) => normalizePendingAction(item)).filter(Boolean),
    },
  });
}

function stablePersistenceValue(value) {
  if (Array.isArray(value)) return value.map((item) => stablePersistenceValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, stablePersistenceValue(value[key])]));
}

function pendingActionPersistenceMatches(actual, expected) {
  const left = normalizePendingAction(actual);
  const right = normalizePendingAction(expected);
  if (!left || !right || left.id !== right.id) return false;
  return JSON.stringify(stablePersistenceValue(left.payload || {}))
    === JSON.stringify(stablePersistenceValue(right.payload || {}));
}

async function confirmPendingActionPersisted(userId, expected, read = readActions) {
  const stored = await read(userId);
  const persisted = (Array.isArray(stored) ? stored : [])
    .find((item) => pendingActionPersistenceMatches(item, expected));
  if (persisted) return normalizePendingAction(persisted);
  const error = new Error('待办回复写入后未能从本地账本确认');
  error.code = 'pending-action-write-unconfirmed';
  throw error;
}

export async function listPendingActions(userId) {
  if (!clean(userId)) return [];
  return readActions(userId);
}

export async function enqueuePendingAction(input = {}) {
  const action = ensurePendingActionGenerationIdentity(input);
  if (!action) return { ok: false, reason: 'invalid-action' };
  return withUserMutation(action.userId, async () => {
    // 新待办只有拿到用户级锁后才解除旧停止闸门；若提前解除，上一批尚在锁内的
    // 第 2、3 条任务会趁新 enqueue 排队期间重新启动。
    clearPendingChatActionCancellation(action.userId, action.chatId);
    const actions = await readActions(action.userId);
    const duplicate = actions.find((item) => item.id === action.id
      || (action.dedupeKey && item.dedupeKey === action.dedupeKey));
    if (duplicate) return { ok: true, action: duplicate, reused: true };
    actions.push(action);
    actions.sort((left, right) => left.dueAt - right.dueAt);
    await writeActions(action.userId, actions);
    return { ok: true, action };
  });
}

/**
 * 用户刚发言后的真人感接话票必须在离页前落库。按聊天与角色原子替换旧锚点，
 * 并拒绝较早的异步排程覆盖已经登记的新消息锚点。
 */
export function planRealPersonReplyActionUpsert(actions = [], input = {}) {
  const action = normalizePendingAction({ ...input, kind: 'real_person_reply' });
  if (!action) return { ok: false, reason: 'invalid-action', actions: [...actions] };
  const list = (Array.isArray(actions) ? actions : []).map((item) => normalizePendingAction(item)).filter(Boolean);
  const sameScope = (item) => (
    item.kind === 'real_person_reply'
    && item.chatId === action.chatId
    && item.characterId === action.characterId
  );
  const incomingAnchorTs = Number(action.payload?.anchorTimestamp || 0);
  const newer = list.find((item) => (
    sameScope(item)
    && Number(item.payload?.anchorTimestamp || 0) > incomingAnchorTs
  ));
  if (newer) return { ok: true, actions: list, action: newer, reused: true, newer: true };

  const duplicate = list.find((item) => (
    sameScope(item)
    && String(item.payload?.anchorMessageId || '') === String(action.payload?.anchorMessageId || '')
    && Number(item.payload?.anchorTimestamp || 0) === incomingAnchorTs
  ));
  if (duplicate) return { ok: true, actions: list, action: duplicate, reused: true };

  const next = list.filter((item) => (
    !sameScope(item)
    && !(
      item.kind === 'life_glimpse'
      && item.chatId === action.chatId
      && item.characterId === action.characterId
      && Number(item.payload?.anchorTimestamp || 0) < incomingAnchorTs
    )
  ));
  next.push(action);
  next.sort((left, right) => left.dueAt - right.dueAt);
  return { ok: true, actions: next, action };
}

export async function upsertRealPersonReplyAction(input = {}, overrides = {}) {
  const action = ensurePendingActionGenerationIdentity({ ...input, kind: 'real_person_reply' });
  if (!action) return { ok: false, reason: 'invalid-action' };
  return withUserMutation(action.userId, async () => {
    const read = overrides.readActions || readActions;
    const write = overrides.writeActions || writeActions;
    const readTask = overrides.getGenerationTask || getGenerationTaskStrict;
    try {
      const task = await readTask(action.payload?.generationTaskId);
      if (isGenerationTaskTerminal(task)) {
        return { ok: false, reason: 'generation-task-terminal', terminal: true };
      }
    } catch (_) {
      return { ok: false, reason: 'generation-ledger-unavailable' };
    }
    const existing = await read(action.userId);
    const plan = planRealPersonReplyActionUpsert(existing, action);
    if (!plan.ok) return plan;
    if (plan.reused) {
      clearPendingChatActionCancellation(action.userId, action.chatId);
      return plan;
    }
    await write(action.userId, plan.actions);
    const persisted = await confirmPendingActionPersisted(action.userId, plan.action, read);
    clearPendingChatActionCancellation(action.userId, action.chatId);
    return { ...plan, action: persisted };
  });
}

/**
 * 等待中的生活侧面与真实接话共用同一份持久待办，但 episode 独立：同一条
 * unanswered user message + character 只保留最早排下的一张；新用户消息会淘汰
 * 同会话旧锚点，旧卡不会在后来补出来。
 */
export function planLifeGlimpseActionUpsert(actions = [], input = {}) {
  const action = normalizePendingAction({ ...input, kind: 'life_glimpse' });
  if (!action) return { ok: false, reason: 'invalid-action', actions: [...actions] };
  const list = (Array.isArray(actions) ? actions : []).map((item) => normalizePendingAction(item)).filter(Boolean);
  const sameScope = (item) => (
    item.kind === 'life_glimpse'
    && item.chatId === action.chatId
    && item.characterId === action.characterId
  );
  const incomingAnchorTs = Number(action.payload?.anchorTimestamp || 0);
  const newer = list.find((item) => (
    sameScope(item)
    && Number(item.payload?.anchorTimestamp || 0) > incomingAnchorTs
  ));
  if (newer) return { ok: true, actions: list, action: newer, reused: true, newer: true };
  const duplicate = list.find((item) => (
    sameScope(item)
    && String(item.payload?.anchorMessageId || '') === String(action.payload?.anchorMessageId || '')
    && Number(item.payload?.anchorTimestamp || 0) === incomingAnchorTs
  ));
  if (duplicate) return { ok: true, actions: list, action: duplicate, reused: true };
  const next = list.filter((item) => !sameScope(item));
  next.push(action);
  next.sort((left, right) => left.dueAt - right.dueAt);
  return { ok: true, actions: next, action };
}

async function findPersistedLifeGlimpseEpisode(action, lifeModule = null) {
  const life = lifeModule || await import('./life-glimpse.js');
  const episodeId = life.lifeGlimpseEpisodeId({
    chatId: action.chatId,
    characterId: action.characterId,
    relatedUserMessageId: clean(action.payload?.anchorMessageId),
  });
  const messageId = life.lifeGlimpseMessageId(action.chatId, episodeId);
  if (!messageId) return null;
  const message = await getRecord('messages', messageId);
  return message?.metadata?.storyKind === 'life_glimpse'
    && String(message.metadata?.episodeId || '') === episodeId
    ? message
    : null;
}

export async function upsertLifeGlimpseAction(input = {}) {
  const action = ensurePendingActionGenerationIdentity({ ...input, kind: 'life_glimpse' });
  if (!action) return { ok: false, reason: 'invalid-action' };
  const life = await import('./life-glimpse.js');
  const persisted = await findPersistedLifeGlimpseEpisode(action, life);
  if (persisted) return { ok: true, reused: true, delivered: true, card: persisted, action: null };
  const settings = await life.loadLifeGlimpseSettings(action.userId, action.characterId);
  if (settings?.enabled !== true || settings?.aiStoryCardsEnabled !== true) {
    return { ok: false, reason: 'life-glimpse-disabled' };
  }
  return withUserMutation(action.userId, async () => {
    // 不清除 chat cancellation tombstone：用户若刚点过停止，同一条消息的侧面票
    // 也必须随之作废；下一条真实用户消息会由 real_person_reply upsert 正常开新轮。
    const plan = planLifeGlimpseActionUpsert(await readActions(action.userId), action);
    if (!plan.ok || plan.reused) return plan;
    await writeActions(action.userId, plan.actions);
    return plan;
  });
}

/**
 * 云端镜像只承载「每个 (chat, actor) 最早到点的一条延时回复」；
 * 后续同角色的排队待办等这条消费掉之后再上传。
 */
export function selectEarliestDelayedReplyActions(actions = []) {
  const map = new Map();
  for (const row of Array.isArray(actions) ? actions : []) {
    const action = normalizePendingAction(row);
    if (!action || action.kind !== 'delayed_reply') continue;
    const key = `chat-delay:${action.chatId}:${action.characterId}`;
    const prev = map.get(key);
    if (!prev || action.dueAt < prev.dueAt) map.set(key, action);
  }
  return map;
}

export async function cancelPendingActions(userId, predicate = null) {
  return withUserMutation(userId, async () => {
    const actions = await readActions(userId);
    const keep = typeof predicate === 'function' ? actions.filter((item) => !predicate(item)) : [];
    await writeActions(userId, keep);
    return { ok: true, removed: actions.length - keep.length };
  });
}

/**
 * 世界时间整段向前跳（线下收纳推进 / 手动推进 / 跳转到）时，由 time-mode 调用：
 * 跳跃前还活着（expiresAt > fromTs）、跳跃后会被判过期（expiresAt <= toTs）的待办，
 * 把过期时限顺延到新时刻之后，保住这批已排队的延时回复/追发——
 * 它们的 dueAt 已落在新时刻之前，下一轮扫描会立即到点执行并正常弹通知，
 * 而不是被当成「早已过期」静默丢弃。真正过期的（expiresAt <= fromTs）不复活。
 */
export async function rebasePendingActionExpiryForTimeJump(userId, { fromTs = 0, toTs = 0 } = {}) {
  const uid = clean(userId);
  const from = Math.trunc(Number(fromTs) || 0);
  const to = Math.trunc(Number(toTs) || 0);
  if (!uid || from <= 0 || to <= from) return { ok: false, reason: 'invalid-jump' };
  return withUserMutation(uid, async () => {
    const actions = await readActions(uid);
    let rebased = 0;
    const next = actions.map((action) => {
      if (!(action.expiresAt > from && action.expiresAt <= to)) return action;
      const window = Math.max(60 * 1000, (action.expiresAt - action.dueAt) || PENDING_ACTION_EXPIRE_MS);
      rebased += 1;
      return { ...action, expiresAt: to + window, claimedAt: 0 };
    });
    if (rebased) await writeActions(uid, next);
    return { ok: true, rebased };
  });
}

export function selectDuePendingActions(actions = [], now = Date.now(), limit = MAX_ACTIONS_PER_TICK) {
  const expired = [];
  const due = [];
  const waiting = [];
  for (const row of Array.isArray(actions) ? actions : []) {
    const action = normalizePendingAction(row, now);
    if (!action) continue;
    if (action.expiresAt > 0 && now > action.expiresAt) {
      expired.push(action);
      continue;
    }
    // claimedAt 在未来（时间债追平完成后节奏钟回落）视为失效 claim，不再阻塞执行。
    const claimActive = action.claimedAt > 0 && now >= action.claimedAt && now - action.claimedAt < CLAIM_TIMEOUT_MS;
    if (action.dueAt <= now && !claimActive && due.length < Math.max(1, Number(limit || 1))) {
      due.push(action);
    } else {
      waiting.push(action);
    }
  }
  return { due, expired, waiting };
}

export function buildDelayedDirective(action, character) {
  const name = clean(character?.customNickname || character?.name || 'TA');
  const preparedScene = clean(action.payload?.sceneDirective, 4000);
  if (preparedScene) {
    return [
      preparedScene,
      '这是之前查证/准备完成后延时接回的回复。现在自然带着结果继续聊天，不要提后台调度、预算或延时事件。',
    ].join('\n');
  }
  const topic = clean(action.payload?.topic || action.payload?.reason, 300);
  const prior = clean(action.payload?.priorShareSummary, 300);
  if (action.kind === 'share_followup') {
    return [
      `[稍后续聊] ${name}先前分享过一条内容，对方还没有回复。`,
      prior ? `上次内容：${prior}` : '',
      '按你的人格、表达欲和当下日程自然续聊；可以轻轻接回，也可以延伸原话题、补充自己的看法与联想，或关心对方在忙什么，不强制高信息量或推进剧情。条数交给【回复节奏 · 错落】；不要再发新链接，不要责怪、催促或连续追问。',
    ].filter(Boolean).join('\n');
  }
  return [
    `[延时回复到点] ${name}之前决定稍后再回复，现在可以继续这段对话。`,
    topic ? `要接回的事项：${topic}` : '',
    '这是你已经让对方等你的明确回来承诺，不是一次可被普通日程静默取消的随机主动消息。除非存在完全下线、线下见面等系统已明确拦截的硬事实，到点至少发一条把承诺接住；若当前日程刚跨进睡眠段，把它理解为你还没真正睡着、或临睡前回来交代一句，不能直接无声判定为“已经睡着”，也不要只因睡眠日程再次延后。',
    '离开的这段时间你在过自己的生活：忙手头的事、刷到什么、顺路遇到什么都可能发生，回来时可以自然带一嘴（不编造具体可查证的细节）。没事找事也合法：带一句自己的小事，或连发几张表情包顶一下。这段时间攒下真实分享欲的话，也可以先发一条社交动态（上文能力目录里有 social_post 时）再回来接话，不为发而发。',
    '结合当前日程和最近聊天自然回复；正忙或在路上会影响回复时机、媒介和语气，轻反应、短语音或表情都可以成立；角色还有话时也不要为了显得忙而截断。条数与分条统一服从【回复节奏 · 错落】。不要提系统、定时器、后台或“延时事件”。如果此刻确实不适合开口，可以明确延后。',
  ].filter(Boolean).join('\n');
}

async function notifyPendingDelivery(chat, character, result, reason = '') {
  if (!chat?.id || !character || !result?.ok) return;
  try {
    const {
      bumpPersistedMessagesUnread,
      notifyCharacterSentMessageIfEnabled,
      shouldNotifyForBackgroundReason,
    } = await import('../native-notifications.js');
    if (!shouldNotifyForBackgroundReason(reason, chat.id)) return;
    await bumpPersistedMessagesUnread(chat.id, result.messages).catch(() => {});
    await notifyCharacterSentMessageIfEnabled({
      characterName: character.customNickname || character.name || '',
      chatId: chat.id,
      tag: `pending-action-${character.id}`,
      messages: result.messages,
      requireHidden: false,
      avatar: character.avatar || '',
    }).catch(() => {});
  } catch (_) {}
}

async function persistRecoveredPendingGeneration(action, recovered = {}, context = {}) {
  const rawText = String(recovered?.remote?.partial ?? recovered?.task?.partial ?? '').trim();
  if (!rawText) return { ok: false, reason: 'recovered-result-empty', terminal: true };
  const [chat, character, recent] = await Promise.all([
    getChat(action.chatId),
    getCharacter(action.characterId, { userId: action.userId }),
    listMessagesForChat(action.chatId, 200).catch(() => []),
  ]);
  if (!chat || !character) return { ok: false, reason: 'chat-or-character-missing', terminal: true };
  try {
    const { persistMarshmallowTurn } = await import('./ai-round.js');
    const task = recovered.task || {};
    const aiRoundId = clean(task.aiRoundId || action.payload?.generationAiRoundId);
    const persisted = await persistMarshmallowTurn(rawText, {
      chat,
      chatId: action.chatId,
      aiRoundId,
      aiRoundCreatedAt: Number(task.startedAt || 0) || Date.now(),
      rerollRootId: aiRoundId,
      aiRoundKind: 'recovered-background-result',
      messages: recent,
      user: context.user || null,
      userId: action.userId,
      characters: { [character.id]: character },
      currentActorId: action.characterId,
      currentUserName: clean(context.user?.name || context.user?.nickname) || '用户',
      resolveSenderName: async (id) => (
        id === 'user'
          ? (clean(context.user?.name || context.user?.nickname) || '用户')
          : (id === character.id ? (character.customNickname || character.name || id) : id)
      ),
      allowOpenTail: true,
      skipExistingAiRoundCleanup: false,
      reason: 'recovered-background-result',
    });
    if (!persisted?.ok) {
      const failureReason = clean(
        persisted?.error || persisted?.reason || 'recovered-result-persist-failed',
        180,
      );
      await saveGenerationTask({
        ...task,
        taskId: clean(task.taskId || action.payload?.generationTaskId),
        status: 'failed',
        partial: rawText,
        completedAt: Date.now(),
        error: {
          kind: 'recovered-result-persist-failed',
          message: failureReason,
        },
      }).catch(() => null);
      return {
        ok: false,
        reason: failureReason,
        terminal: true,
        modelRequestAttempted: true,
      };
    }
    await saveGenerationTask({
      ...task,
      status: 'completed',
      partial: rawText,
      completedAt: Date.now(),
      persistedMessageCount: Number(persisted.messageCount || persisted.messages?.length || 0),
      error: null,
    }).catch(() => null);
    await notifyPendingDelivery(chat, character, persisted, context.reason || 'recovered-background-result');
    return { ok: true, result: persisted, recoveredCompletedResult: true };
  } catch (error) {
    const failureReason = clean(error?.message || error || 'recovered-result-persist-failed', 180);
    const task = recovered.task || {};
    await saveGenerationTask({
      ...task,
      taskId: clean(task.taskId || action.payload?.generationTaskId),
      status: 'failed',
      partial: rawText,
      completedAt: Date.now(),
      error: {
        kind: 'recovered-result-persist-failed',
        message: failureReason,
      },
    }).catch(() => null);
    return {
      ok: false,
      reason: failureReason,
      terminal: true,
      modelRequestAttempted: true,
    };
  }
}

async function loadSocialItem(action) {
  const target = clean(action.payload?.target).toLowerCase();
  const postId = clean(action.payload?.postId);
  if (!postId) return null;
  if (target === 'moments' || target === 'user_moment') {
    const { getMomentPost } = await import('../moments/moments-store.js');
    return getMomentPost(postId);
  }
  if (target === 'weibo') return getRecord('weiboPosts', postId);
  if (target === 'forum') return getRecord('forumThreads', postId);
  return null;
}

function socialRelaySpec(target) {
  if (target === 'weibo') {
    return {
      urlScheme: 'weibo',
      sourceLabel: '微博',
      lastMessagePreview: '[微博分享]',
      linkTitle: (item) => clean(item?.authorName || '微博动态', 48),
      linkDesc: (item) => clean(item?.content, 80),
    };
  }
  if (target === 'forum') {
    return {
      urlScheme: 'forum',
      sourceLabel: '论坛',
      lastMessagePreview: '[论坛分享]',
      linkTitle: (item) => clean(item?.title || '论坛帖子', 48),
      linkDesc: (item) => clean(item?.content, 80),
    };
  }
  return null;
}

async function executeSocialFollowup(action, context = {}) {
  const target = clean(action.payload?.target).toLowerCase();
  const item = await loadSocialItem(action);
  if (!item) return { ok: false, reason: 'social-item-missing' };
  if (target === 'user_moment') {
    const [chat, character] = await Promise.all([
      getChat(action.chatId),
      getCharacter(action.characterId, { userId: action.userId }),
    ]);
    if (!chat || !character || (chat.userId && clean(chat.userId) !== action.userId)) {
      return { ok: false, reason: 'chat-or-character-missing', terminal: true };
    }
    const { getCharacterProactiveUsageStatus } = await import('../character-proactive-usage.js');
    const usage = await getCharacterProactiveUsageStatus(action.userId, action.characterId).catch(() => null);
    if (usage && usage.remaining <= 0) {
      return { ok: false, reason: 'daily-limit-reached' };
    }
    const { buildMomentChatBundleMetadata } = await import('../moments/moments-store.js');
    const timestamp = await getNowForUser(action.userId);
    const bundle = createMessage({
      chatId: chat.id,
      senderId: action.characterId,
      senderName: character.customNickname || character.name || '',
      type: 'chatBundle',
      content: `[朋友圈] ${item.authorName || '你'}`,
      timestamp,
      metadata: {
        ...buildMomentChatBundleMetadata(item),
        momentPostId: item.id,
        fromRealPersonMode: true,
      },
    });
    await saveMessage(bundle);
    await updateChatPreview(chat.id, previewFromMessage(bundle), timestamp);
    await bumpChatUnread(chat.id, 1).catch(() => {});
    const { consumeCharacterApiBudget } = await import('../character-api-budget.js');
    const budget = await consumeCharacterApiBudget({
      userId: action.userId,
      characterId: action.characterId,
      chatId: action.chatId,
      category: 'background_reply',
    });
    if (budget?.ok) {
      const result = await runHeadlessChatReply(chat, context.user, {
        allowInactive: true,
        skipBusyAutoReply: true,
        apiBudgetConsumed: true,
        reason: 'real-person-user-moment-forward',
        proactiveChannel: 'user-moment-followup',
        proactiveIdempotencyKey: action.id,
        ...pendingActionGenerationOptions(action),
        sceneDirective: [
          '你刚把用户自己发布的朋友圈转回你们的私聊。',
          `动态内容：${clean(item.content, 260)}`,
          '按你的人格、关系距离和当前日程自然评论、接梗、关心或延展话题；具体消息数量与分条服从【回复节奏 · 错落】。不要说系统替你转发，也不要假装这条朋友圈是你发的。',
        ].join('\n'),
      }).catch(() => null);
      await notifyPendingDelivery(chat, character, result, context.reason);
    }
    return { ok: true };
  }
  if (target === 'moments') {
    // 朋友圈没有内部 URL 卡片；先补互动，聊天回流由一次自然的延时回复承接。
    const chat = await getChat(action.chatId);
    const character = await getCharacter(action.characterId, { userId: action.userId });
    if (!chat || !character) return { ok: false, reason: 'chat-or-character-missing' };
    const { consumeCharacterApiBudget } = await import('../character-api-budget.js');
    const reactionBudget = await consumeCharacterApiBudget({
      userId: action.userId,
      characterId: action.characterId,
      chatId: action.chatId,
      category: 'social_reactions',
    });
    if (reactionBudget?.ok && context.user) {
      try {
        const [{ aiFillMomentReactions }, { putMomentPost }] = await Promise.all([
          import('../moments/moments-ai.js'),
          import('../moments/moments-store.js'),
        ]);
        const reactions = await aiFillMomentReactions({
          user: context.user,
          post: item,
          interactionMode: 'auto',
        });
        Object.assign(item, reactions || {});
        await putMomentPost(item, action.userId);
      } catch (_) {
        // 补互动失败不阻断稍后回到聊天；预算按已发生的真实 API 尝试保留。
      }
    }
    const budget = await consumeCharacterApiBudget({
      userId: action.userId,
      characterId: action.characterId,
      chatId: action.chatId,
      category: 'background_reply',
    });
    if (!budget?.ok) return { ok: false, reason: budget?.reason || 'budget-unavailable' };
    const result = await runHeadlessChatReply(chat, context.user, {
      allowInactive: true,
      skipBusyAutoReply: true,
      apiBudgetConsumed: true,
      reason: 'real-person-social-followup',
      proactiveChannel: 'social-followup',
      proactiveIdempotencyKey: action.id,
      ...pendingActionGenerationOptions(action),
      sceneDirective: `你之前发了一条朋友圈：「${clean(item.content, 220)}」。现在按人格自然回到聊天里提起它或分享后续，不要说“系统提醒”。`,
    });
    await notifyPendingDelivery(chat, character, result, context.reason);
    return result?.ok ? { ok: true, result } : { ok: false, reason: result?.reason || 'headless-failed' };
  }
  const relaySpec = socialRelaySpec(target);
  if (!relaySpec) return { ok: false, reason: 'unsupported-social-target' };
  await applyGeneratedChatShares({
    userId: action.userId,
    chatShares: [{
      forwarderId: action.characterId,
      targetType: 'private_user',
      postIndex: 0,
      lines: [],
    }],
    relayItems: [item],
    virtualNow: Date.now(),
    relaySpec,
  });
  const chat = await getChat(action.chatId);
  if (chat) {
    const { consumeCharacterApiBudget } = await import('../character-api-budget.js');
    const budget = await consumeCharacterApiBudget({
      userId: action.userId,
      characterId: action.characterId,
      chatId: action.chatId,
      category: 'background_reply',
    });
    if (budget?.ok) {
      const result = await runHeadlessChatReply(chat, context.user, {
        allowInactive: true,
        skipBusyAutoReply: true,
        apiBudgetConsumed: true,
        reason: 'real-person-social-relay-comment',
        proactiveChannel: 'social-followup',
        proactiveIdempotencyKey: action.id,
        ...pendingActionGenerationOptions(action),
        sceneDirective: [
          `你刚把自己发布的${target === 'weibo' ? '微博' : '论坛帖子'}转给了对方。`,
          `内容是：${clean(item.content || item.title, 260)}`,
          '按你的人格和当前情绪解释为什么转来、继续话题并交出自己的反应；具体消息数量与分条服从【回复节奏 · 错落】。不要复述系统提示，不要再次发送链接。',
        ].join('\n'),
      }).catch(() => null);
      const character = await getCharacter(action.characterId, { userId: action.userId });
      await notifyPendingDelivery(chat, character, result, context.reason);
    }
  }
  return { ok: true };
}

async function defaultExecutor(action, context = {}) {
  if (action.kind === 'life_glimpse') {
    const { executePendingLifeGlimpseAction } = await import('./life-glimpse.js');
    try {
      return await executePendingLifeGlimpseAction(action, context);
    } catch (error) {
      return {
        ok: false,
        reason: error?.modelRequestAttempted === true
          ? 'life-glimpse-generation-unknown'
          : 'life-glimpse-storage-unavailable',
        retryable: error?.modelRequestAttempted !== true,
        terminal: error?.modelRequestAttempted === true,
        retryAt: Number(context.now || 0) + PENDING_ACTION_CHECK_MS,
        error: clean(error?.message || error, 180),
        modelRequestAttempted: error?.modelRequestAttempted === true,
      };
    }
  }
  let interactionPrefs = null;
  if (action.kind === 'interaction_invite') {
    try {
      const [{ loadChatPrefs }, { normalizeChatInteractionSession }] = await Promise.all([
        import('../chat-block-state.js'),
        import('../chat-interactions.js'),
      ]);
      interactionPrefs = await loadChatPrefs(action.chatId);
      if (interactionPrefs?.interactionProactiveEnabled !== true) {
        return { ok: false, reason: 'interaction-proactive-disabled', terminal: true };
      }
      if (normalizeChatInteractionSession(interactionPrefs.interactionSession)) {
        return { ok: false, reason: 'interaction-already-active', terminal: true };
      }
      if (interactionPrefs?.interactionDraft?.plan) {
        return { ok: false, reason: 'interaction-draft-pending', terminal: true };
      }
    } catch (_) {
      return { ok: false, reason: 'interaction-permission-unavailable' };
    }
  } else if (pendingActionRequiresProactivePermission(action.kind)) {
    try {
      const { loadResolvedCharacterAutonomyPolicy } = await import('../character-autonomy-settings.js');
      const policy = await loadResolvedCharacterAutonomyPolicy(
        action.userId,
        action.characterId,
        action.chatId,
      );
      if (policy?.totalEnabled !== true) {
        return { ok: false, reason: 'proactive-disabled', terminal: true };
      }
    } catch (_) {
      return { ok: false, reason: 'proactive-policy-unavailable' };
    }
  }
  if (action.kind === 'social_followup') return executeSocialFollowup(action, context);
  if (action.kind === 'chase_beat') {
    // 真人感后台追发拍：校验、预算与场景词都在专属模块里，动态引入避免核心链路成环。
    const { executeChaseBeatAction } = await import('./real-person-chase-beat.js');
    return executeChaseBeatAction(action, context);
  }
  if (action.kind === 'cold_follow_up') {
    // 真人感冷场破冰：追发拍收线后隔大半天的「重新想起你」，与追发拍共用校验链。
    const { executeColdFollowUpAction } = await import('./real-person-chase-beat.js');
    return executeColdFollowUpAction(action, context);
  }
  if (action.kind === 'delayed_reply') {
    // 该延时回复已镜像到 Cloudflare 定时：到点由云端生成，本地只轮询对账，
    // 避免前后台各生成一轮。对账若发现云端失败/作废会清掉 revision，本地重试接管。
    try {
      const { isCloudScheduledBackgroundEnabled, hasCloudScheduledTask } = await import('../generation-relay.js');
      const virtualTime = await getTimeMode(action.userId) === TIME_MODE_VIRTUAL;
      if (
        !virtualTime
        && isCloudScheduledBackgroundEnabled()
        && hasCloudScheduledTask(`chat-delay:${action.chatId}:${action.characterId}`)
      ) {
        // 不能 await：对账成功会 cancelPendingActions，与当前执行持同一把用户级锁。
        import('../cloud-background-coordinator.js')
          .then((mod) => mod.reconcileCloudBackgroundEvents?.('delayed-reply-poll'))
          .catch(() => {});
        return { ok: false, reason: 'cloud-scheduled' };
      }
    } catch (_) {}
  }
  const [chat, character] = await Promise.all([
    getChat(action.chatId),
    getCharacter(action.characterId, { userId: action.userId }),
  ]);
  if (!chat || !character) return { ok: false, reason: 'chat-or-character-missing', terminal: true };
  if (chat.userId && clean(chat.userId) !== action.userId) {
    return { ok: false, reason: 'user-slot-mismatch', terminal: true };
  }
  if (!(chat.participants || []).includes(action.characterId)) {
    return { ok: false, reason: 'character-not-in-chat', terminal: true };
  }
  let recent = [];
  if (action.kind === 'real_person_reply' || action.kind === 'interaction_invite') {
    // 前台计时器会避开输入框；持久化待办也必须做同一道检查，否则后台分钟扫描
    // 可能越过前台焦点门禁，直接让会话进入“正在输入”并锁住用户的草稿/表情入口。
    const liveComposerBusy = isChatComposerBusy(action.chatId);
    const composerGate = evaluateChatComposerActivity(action.chatId, {
      settleMs: Number(action.payload?.composeSettleMs || 0) || 2500,
    });
    if (liveComposerBusy || composerGate.blocked) {
      return {
        ok: false,
        reason: 'compose-active',
        retryAt: composerGate.retryAt || (Date.now() + 2500),
      };
    }
    if (action.kind === 'real_person_reply') {
      try {
        const { loadResolvedCharacterAutonomyPolicy } = await import('../character-autonomy-settings.js');
        const policy = await loadResolvedCharacterAutonomyPolicy(
          action.userId,
          action.characterId,
          action.chatId,
        );
        if (policy?.realPersonMode?.enabled !== true) return { ok: false, reason: 'real-person-disabled', terminal: true };
      } catch (_) {
        // 权限读取失败时保守延期；不能把“不知道是否开启”降级成允许自动调用。
        return { ok: false, reason: 'real-person-policy-unavailable' };
      }
      recent = await listMessagesForChat(action.chatId, 80).catch(() => []);
      const unanswered = getUnansweredRealUserMessage(recent);
      const anchorId = clean(action.payload?.anchorMessageId);
      const anchorTimestamp = Number(action.payload?.anchorTimestamp || 0);
      if (!unanswered
        || (anchorId && String(unanswered.id || '') !== anchorId)
        || Number(unanswered.timestamp || 0) !== anchorTimestamp) {
        return { ok: false, reason: 'user-message-already-answered', terminal: true };
      }
      try {
        const { loadChatPrefs } = await import('../chat-block-state.js');
        if (isAutomaticGenerationAnchorStopped(await loadChatPrefs(action.chatId), unanswered)) {
          return { ok: false, reason: 'user-stopped', terminal: true };
        }
      } catch (_) {}
      try {
        const { isHardOfflineActiveForChat } = await import('./real-person-hard-offline.js');
        if (await isHardOfflineActiveForChat(action.userId, chat)) {
          return { ok: false, reason: 'hard-offline' };
        }
      } catch (_) { /* 状态读不到时沿用普通回复 */ }
    }
  }
  // 人就在线下对面：延时回复/社交跟进等待办主动消息让路（不 terminal，线下结束后可再发）。
  try {
    const { isCharacterBusyInOfflineSession } = await import('../character-phone-proactive.js');
    if (await isCharacterBusyInOfflineSession(action.userId, action.characterId)) {
      return { ok: false, reason: 'active-offline-session' };
    }
  } catch (_) { /* 线下态读不到时不阻塞 */ }
  const isRealPersonReply = action.kind === 'real_person_reply';
  const isCommittedDelayedReply = action.kind === 'delayed_reply';
  const isInteractionInvite = action.kind === 'interaction_invite';
  if (!isRealPersonReply && !isInteractionInvite) {
    const { consumeCharacterApiBudget } = await import('../character-api-budget.js');
    const budget = await consumeCharacterApiBudget({
      userId: action.userId,
      characterId: action.characterId,
      chatId: action.chatId,
      category: 'background_reply',
    });
    if (!budget?.ok) return {
      ok: false,
      reason: budget?.reason || 'budget-unavailable',
      terminal: budget?.reason === 'real-person-disabled',
    };
  }
  let interactionSession = null;
  let interactionSceneDirective = '';
  if (isInteractionInvite) {
    try {
      const [{ loadChatPrefs, patchChatPrefs }, interaction] = await Promise.all([
        import('../chat-block-state.js'),
        import('../chat-interactions.js'),
      ]);
      interactionPrefs = await loadChatPrefs(action.chatId);
      if (interactionPrefs?.interactionProactiveEnabled !== true) {
        return { ok: false, reason: 'interaction-proactive-disabled', terminal: true };
      }
      if (interaction.normalizeChatInteractionSession(interactionPrefs.interactionSession)) {
        return { ok: false, reason: 'interaction-already-active', terminal: true };
      }
      if (interactionPrefs?.interactionDraft?.plan) {
        return { ok: false, reason: 'interaction-draft-pending', terminal: true };
      }
      const idea = clean(action.payload?.idea, 500);
      interactionSession = interaction.createChatInteractionSession({
        decision: 'propose',
        title: clean(action.payload?.title, 48) || '一起聊聊',
        intent: idea,
        opener: clean(action.payload?.note, 320),
        questions: idea ? [idea] : [],
        rules: ['双方都可以问、答、追问或跳过，不按固定顺序推进。'],
        followUp: '根据对方的真实回应自然深入、换题或停下。',
      }, { source: 'proactive' });
      interactionSceneDirective = interaction.buildChatInteractionDirective(interactionSession, { opening: true });
      await patchChatPrefs(action.chatId, { interactionSession });
    } catch (_) {
      return { ok: false, reason: 'interaction-session-unavailable' };
    }
  }
  const result = await runHeadlessChatReply(chat, context.user, {
    allowInactive: true,
    skipBusyAutoReply: !isRealPersonReply,
    apiBudgetConsumed: !isRealPersonReply,
    reason: isInteractionInvite ? 'interaction-invite' : `real-person-${action.kind}`,
    // 对用户刚发消息的正常接话不是「主动开口」，不能消耗角色每日主动次数；
    // 否则当天主动行为用满后，真人感普通回复也会被 daily-limit-reached 静默截停。
    proactiveChannel: resolvePendingActionProactiveChannel(action.kind),
    proactivePermissionRequired: isInteractionInvite ? false : !isCommittedDelayedReply,
    proactiveQuotaRequired: !isCommittedDelayedReply,
    proactiveIdempotencyKey: action.id,
    ...pendingActionGenerationOptions(action),
    sceneDirective: isInteractionInvite
      ? interactionSceneDirective
      : isRealPersonReply
      ? [
        '这是对方刚才真实发来的消息，现在按你的人格、关系和当前日程自然接话。',
        buildRealPersonReplyFreshnessBlock(recent),
        action.payload?.scheduleBusy
          ? `你刚才正忙${clean(action.payload?.scheduleActivity, 80) ? `（${clean(action.payload.scheduleActivity, 80)}）` : ''}，所以隔了一会儿才看到；不用解释后台机制。`
          : '',
        '只回应真实聊天内容，不要把代发、自动代答、场景提示或通话记录当成对方的新发言。',
      ].filter(Boolean).join('\n')
      : buildDelayedDirective(action, character),
  });
  if (interactionSession) {
    try {
      const { loadChatPrefs, patchChatPrefs } = await import('../chat-block-state.js');
      const latestPrefs = await loadChatPrefs(action.chatId);
      const active = latestPrefs?.interactionSession;
      if (active?.id === interactionSession.id) {
        const delivered = result?.ok === true
          && !result?.busyGate
          && !result?.silentBusy
          && (Array.isArray(result?.messages) ? result.messages.length > 0 : true);
        await patchChatPrefs(action.chatId, {
          interactionSession: delivered
            ? { ...active, openingPending: false, updatedAt: Date.now() }
            : null,
        });
      }
    } catch (_) {}
  }
  await notifyPendingDelivery(chat, character, result, context.reason);
  if (result?.aborted && result?.abortReason === 'user') {
    return { ok: false, reason: 'user-aborted', terminal: true };
  }
  if (isRealPersonReply && result?.busyGate === true && result?.skipped === true) {
    // 系统自动回复/忙碌静默只是暂时挡刀，不能把真实接话待办标成完成。
    const gateReason = String(result.reason || '');
    return {
      ok: false,
      reason: /offline|sleep/i.test(gateReason) ? 'soft-offline' : 'schedule-busy',
      busyGateReason: gateReason,
    };
  }
  return result?.ok
    ? { ok: true, result }
    : {
      ok: false,
      reason: result?.reason || 'headless-failed',
      // 模型请求一旦真正发出，无论空回、断流、格式错误还是本地落库失败，
      // 都终止本条自动待办；是否再次付费必须交给用户手动决定。
      terminal: result?.modelRequestAttempted === true,
      modelRequestAttempted: result?.modelRequestAttempted === true,
    };
}

export async function runPendingChatActions(user, now = Date.now(), reason = '', overrides = {}) {
  const userId = clean(user?.id);
  if (!userId) return { ok: false, reason: 'missing-user' };
  if (inFlightUsers.has(userId)) return { ok: false, reason: 'in-flight' };
  inFlightUsers.add(userId);
  try {
    const read = overrides.readActions || readActions;
    const write = overrides.writeActions || writeActions;
    const execute = overrides.execute || defaultExecutor;
    const persistRecoveredGeneration = overrides.persistRecoveredGenerationResult
      || persistRecoveredPendingGeneration;
    // 用户级锁只保护待办账本的 read-modify-write。上下文构建和模型请求可能持续
    // 数十秒，若把它们也包在锁里，普通发送写真人感票据会一直等；生成过程中再次
    // enqueue（例如 need_search 延时回来）还会重入同一把非重入锁并永久互等。
    const claimState = await withUserMutation(userId, async () => {
      const storedActions = await read(userId);
      const recovery = await recoverClaimedPendingGenerationActions(storedActions, now, overrides);
      const actions = recovery.actions;
      if (recovery.changed) await write(userId, actions);
      const { due, expired, waiting } = selectDuePendingActions(actions, now);
      const preparedDue = due.map((action) => ensurePendingActionGenerationIdentity(action)).filter(Boolean);
      const missedDelayedReplies = expired.filter((action) => action.kind === 'delayed_reply');
      const preparedDueById = new Map(preparedDue.map((item) => [item.id, item]));
      const claimed = actions.map((item) => preparedDueById.has(item.id)
        ? { ...preparedDueById.get(item.id), claimedAt: now }
        : item);
      if (preparedDue.length || expired.length) {
        await write(userId, claimed.filter((item) => !expired.some((row) => row.id === item.id)));
      }
      return {
        actions,
        preparedDue,
        expired,
        waiting,
        missedDelayedReplies,
        recovery,
      };
    });

    const {
      actions,
      preparedDue,
      expired,
      missedDelayedReplies,
      recovery,
    } = claimState;
    if (missedDelayedReplies.length) {
      await Promise.all(missedDelayedReplies.map((action) => recordChatContinuityIncident({
        userId: action.userId,
        chatId: action.chatId,
        characterId: action.characterId,
        kind: 'delayed_reply_missed',
        reason: action.lastError || 'pending-action-expired',
        sourceId: action.id,
        expectedAction: clean(action.payload?.reason || '按之前说好的时间回来接着聊', 240),
        observedFact: '角色已经让用户等自己，但直到这条待办过期仍没有成功回来',
        occurredAt: Number(action.dueAt || action.createdAt || now) || now,
      }).catch(() => null)));
    }

      const results = [...recovery.terminal];
      const completedIds = new Set();
      const retryRows = [];
      const derivedLifeGlimpseRows = [];
      for (const action of preparedDue) {
        if (isPendingChatActionCancellationRequested(action)) {
          results.push({
            actionId: action.id,
            kind: action.kind,
            chatId: action.chatId,
            ok: false,
            reason: 'user-cancelled',
            terminal: true,
          });
          completedIds.add(action.id);
          continue;
        }
        try {
          const recoveredCompleted = recovery.completedResults?.get(action.id) || null;
          const result = recoveredCompleted
            ? await persistRecoveredGeneration(action, recoveredCompleted, { user, now, reason })
            : await execute(action, { user, now, reason });
          results.push({ actionId: action.id, kind: action.kind, chatId: action.chatId, ...result });
          if (
            action.kind === 'real_person_reply'
            && (result?.reason === 'schedule-busy' || result?.reason === 'soft-offline')
          ) {
            try {
              const life = await import('./life-glimpse.js');
              const waitingReason = clean(result?.busyGateReason || result?.reason, 40);
              const delivered = await findPersistedLifeGlimpseEpisode(action, life);
              if (
                life.isLifeGlimpseWaitReason(waitingReason)
                && !delivered
              ) {
                const settings = await life.loadLifeGlimpseSettings(action.userId, action.characterId);
                if (settings?.enabled === true && settings?.aiStoryCardsEnabled === true) {
                  const dueAt = now + life.LIFE_GLIMPSE_WAIT_DELAY_MS;
                  const plan = planLifeGlimpseActionUpsert(
                    [...actions, ...preparedDue, ...derivedLifeGlimpseRows],
                    {
                      userId: action.userId,
                      characterId: action.characterId,
                      chatId: action.chatId,
                      dueAt,
                      createdAt: now,
                      expiresAt: Math.max(dueAt + 10 * 60 * 1000, Number(action.expiresAt || 0)),
                      dedupeKey: `life-glimpse:${action.chatId}:${clean(action.payload?.anchorMessageId)}`,
                      payload: {
                        anchorMessageId: clean(action.payload?.anchorMessageId),
                        anchorTimestamp: Number(action.payload?.anchorTimestamp || 0),
                        waitingReason,
                        replyDeferredUntil: result.reason === 'schedule-busy'
                          ? now + 5 * 60 * 1000
                          : now + 30 * 60 * 1000,
                      },
                    },
                  );
                  if (plan.ok && !plan.reused && plan.action) {
                    derivedLifeGlimpseRows.push(plan.action);
                  }
                }
              }
            } catch (_) { /* 开关暂时读不到时不落侧面票，也不影响真实接话继续等待。 */ }
          }
          if (result?.ok || result?.terminal) {
            completedIds.add(action.id);
          } else if (result?.retryable === true) {
            // 请求开始前的 settings/messages/native cache 瞬态读取失败可保票；
            // 一旦模型请求发生，执行器会标 terminal，禁止后台自动二次计费。
            retryRows.push({
              ...action,
              claimedAt: 0,
              dueAt: Math.max(now + 500, Number(result?.retryAt || 0) || now + PENDING_ACTION_CHECK_MS),
              lastError: clean(result?.reason || 'retryable', 180),
            });
          } else if (result?.reason === 'cloud-scheduled') {
            // 云端镜像仍在排队：不算失败重试，等对账把它消费掉；expiresAt 兜底。
            retryRows.push({
              ...action,
              claimedAt: 0,
              dueAt: now + 5 * 60 * 1000,
              lastError: 'cloud-scheduled',
            });
          } else if (
            result?.reason === 'budget-exhausted'
            || result?.reason === 'mute-hours'
            || result?.reason === 'hard-offline'
            || result?.reason === 'soft-offline'
            || result?.reason === 'schedule-busy'
            || result?.reason === 'active-offline-session'
            || result?.reason === 'cooldown'
          ) {
            // 预算、冷却、静音、完全下线或线下见面都是环境条件，不是执行失败：不烧 attempts。
            // 冷却精确等到 retryAt；日程忙碌五分钟后复查，其它环境条件半小时后再试，直到 expiresAt 自然过期。
            retryRows.push({
              ...action,
              claimedAt: 0,
              dueAt: result?.reason === 'cooldown' && Number(result?.retryAt || 0) > now
                ? Number(result.retryAt)
                : result?.reason === 'schedule-busy'
                  ? now + 5 * 60 * 1000
                  : now + 30 * 60 * 1000,
              lastError: clean(result.reason, 40),
            });
          } else if (result?.reason === 'compose-active') {
            // 有草稿时定期复查；只是刚操作过则精确等到静默窗结束，不因残留焦点拖几分钟。
            retryRows.push({
              ...action,
              claimedAt: 0,
              dueAt: Math.max(now + 500, Number(result?.retryAt || 0) || now + 30 * 1000),
              lastError: 'compose-active',
            });
          } else {
            retryRows.push({
              ...action,
              attempts: action.attempts + 1,
              claimedAt: 0,
              dueAt: now + Math.min(30 * 60 * 1000, Math.max(60 * 1000, (action.attempts + 1) * 5 * 60 * 1000)),
              lastError: clean(result?.reason || 'failed', 180),
            });
          }
        } catch (error) {
          const modelRequestAttempted = error?.modelRequestAttempted === true;
          results.push({
            actionId: action.id,
            kind: action.kind,
            ok: false,
            reason: clean(error?.message || error || 'failed'),
            terminal: modelRequestAttempted,
            modelRequestAttempted,
          });
          if (modelRequestAttempted) {
            completedIds.add(action.id);
          } else {
            retryRows.push({
              ...action,
              attempts: action.attempts + 1,
              claimedAt: 0,
              dueAt: now + 5 * 60 * 1000,
              lastError: clean(error?.message || error || 'failed', 180),
            });
          }
        }
      }
      const retryById = new Map(retryRows
        .filter((item) => item.kind === 'life_glimpse' || item.attempts < 3)
        .map((item) => [item.id, item]));
      const preparedIds = new Set(preparedDue.map((item) => item.id));
      await withUserMutation(userId, async () => {
        // 执行期间其它页面可以正常加入新票；结算必须基于最新账本只替换本轮 claim，
        // 不能把领取时的 waiting 快照整表写回并覆盖新消息。
        let finalRows = (await read(userId)).flatMap((item) => {
          if (!preparedIds.has(item.id)) return [item];
          if (completedIds.has(item.id) || isPendingChatActionCancellationRequested(item)) return [];
          const retry = retryById.get(item.id);
          return retry ? [retry] : [];
        });
        for (const derived of derivedLifeGlimpseRows) {
          const plan = planLifeGlimpseActionUpsert(finalRows, derived);
          if (plan.ok) finalRows = plan.actions;
        }
        finalRows = finalRows
          .filter((item, index, list) => list.findIndex((row) => row.id === item.id) === index)
          .filter((item) => !isPendingChatActionCancellationRequested(item))
          .sort((left, right) => left.dueAt - right.dueAt);
        await write(userId, finalRows);
      });
      return {
        ok: true,
        processed: preparedDue.length,
        expired: expired.length,
        recoveredPreDispatch: recovery.recovered,
        results,
      };
  } finally {
    inFlightUsers.delete(userId);
  }
}
