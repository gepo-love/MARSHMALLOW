/**
 * 会话级连续心理状态（纯数据层）。
 *
 * 这里只负责 settings 持久化、作用域隔离、有界规范化、明确的状态迁移与
 * 重 roll 回退；生成链路只读取它的有界投影。可见心声 `state.inner` 不属于
 * 这里的事实源，也绝不能通过兼容迁移写入 runtime。
 */
import { get, onStoreWrite, put, remove, updateRecord } from '../db.js';

export const PSYCHOLOGICAL_CONTINUITY_VERSION = 1;
export const PSYCHOLOGICAL_CONTINUITY_KEY_PREFIX = 'chatPsychContinuityV1_';
export const PSYCHOLOGICAL_CONTINUITY_ROLLBACK_NONCE_FIELD = '__psychologicalRollbackNonce';

export const TOPIC_THREAD_STATUSES = Object.freeze(['active', 'cooling', 'closed']);
export const PSYCH_EPISODE_KINDS = Object.freeze(['emotion', 'belief', 'desire', 'inhibition']);
export const PSYCH_EPISODE_STATUSES = Object.freeze(['active', 'cooling', 'resolved']);
export const DISCLOSURE_STAGES = Object.freeze(['private', 'hinted', 'partial', 'said']);
export const DISCLOSURE_THREAD_STATUSES = Object.freeze(['open', 'snoozed', 'resolved', 'abandoned']);
export const DISCLOSURE_TRIGGERS = Object.freeze(['user_ask', 'character_later', 'similar_topic', 'none']);

const DISCLOSURE_RESOLVE_ACTS = new Set(['resolve-disclosure']);
const DISCLOSURE_ABANDON_ACTS = new Set(['boundary', 'decline-disclosure']);
const DISCLOSURE_SNOOZE_ACTS = new Set(['defer', 'defer-disclosure', 'snooze-disclosure']);
const TOPIC_MOVES = new Set(['continue', 'branch', 'close']);
const REPLY_EXPRESSION_DRIVES = new Set(['quiet', 'steady', 'engaged', 'overflowing']);
const EXPRESSION_CARRY_DRIVES = new Set(['engaged', 'overflowing']);

export const PSYCHOLOGICAL_CONTINUITY_CAPS = Object.freeze({
  topicThreads: 12,
  episodesPerCharacter: 6,
  disclosureThreadsPerCharacter: 8,
  sourceRefs: 6,
  relatedPsychThreadIds: 8,
  appliedDeliveryIds: 32,
  roundSnapshots: 12,
});

const DEFAULT_EPISODE_HALF_LIFE_MS = 24 * 60 * 60 * 1000;
const MAX_EPISODE_HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1000;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const readCache = new Map();
const updateQueues = new Map();

onStoreWrite('settings', (key) => {
  if (key === undefined) {
    readCache.clear();
    return;
  }
  const value = String(key || '');
  if (!value.startsWith(PSYCHOLOGICAL_CONTINUITY_KEY_PREFIX)) return;
  readCache.delete(value.slice(PSYCHOLOGICAL_CONTINUITY_KEY_PREFIX.length));
});

function cleanText(value, maxLength = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim();
}

function cleanId(value, maxLength = 120) {
  const id = cleanText(value, maxLength);
  return FORBIDDEN_OBJECT_KEYS.has(id) ? '' : id;
}

function clampNumber(value, min, max, fallback = min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clampInteger(value, min, max, fallback = min) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function timestamp(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function enumValue(value, allowed, fallback) {
  const normalized = cleanText(value, 40);
  return allowed.includes(normalized) ? normalized : fallback;
}

function uniqueStrings(values, limit, maxLength = 120) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanId(value, maxLength))
    .filter(Boolean))]
    .slice(0, limit);
}

function cloneData(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeScope(scope = {}) {
  return {
    userId: cleanId(scope.userId),
    chatId: cleanId(scope.chatId),
    participantIds: Array.isArray(scope.participantIds)
      ? new Set(scope.participantIds.map((id) => cleanId(id)).filter(Boolean))
      : null,
  };
}

function requireScope(scope = {}) {
  const normalized = normalizeScope(scope);
  if (!normalized.userId || !normalized.chatId) {
    throw new TypeError('psychological continuity requires userId and chatId');
  }
  return normalized;
}

function requireCharacterId(characterId, scope = null) {
  const id = cleanId(characterId);
  if (!id || id === 'user' || id === 'system') {
    throw new TypeError('psychological continuity requires a real characterId');
  }
  if (scope?.participantIds && !scope.participantIds.has(id)) {
    throw new RangeError('characterId is outside the supplied chat participant scope');
  }
  return id;
}

function hasStoredRuntime(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value)
    && (value.userId || value.chatId || value.topicRuntime || value.actors));
}

function storedScopeMatches(value, scope) {
  if (!hasStoredRuntime(value)) return true;
  return cleanId(value.userId) === scope.userId && cleanId(value.chatId) === scope.chatId;
}

export function psychologicalContinuityKey(chatId) {
  const id = cleanId(chatId);
  return id ? `${PSYCHOLOGICAL_CONTINUITY_KEY_PREFIX}${id}` : '';
}

function normalizeSourceRefs(value) {
  const seen = new Set();
  const output = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const source = typeof raw === 'string' ? { kind: 'other', id: raw } : raw;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const kind = cleanId(source.kind, 40) || 'other';
    const id = cleanId(source.id, 160);
    if (!id) continue;
    const key = `${kind}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ kind, id });
    if (output.length >= PSYCHOLOGICAL_CONTINUITY_CAPS.sourceRefs) break;
  }
  return output;
}

function mergeSourceRefs(left, right) {
  return normalizeSourceRefs([...(left || []), ...(right || [])]);
}

function normalizeTopicThread(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanId(raw.id);
  const summary = cleanText(raw.summary, 320);
  if (!id || !summary) return null;
  const status = enumValue(raw.status, TOPIC_THREAD_STATUSES, 'active');
  const openedAt = timestamp(raw.openedAt || raw.createdAt);
  const lastTouchedAt = timestamp(raw.lastTouchedAt || raw.updatedAt, openedAt);
  return {
    id,
    summary,
    status,
    userOutstanding: raw.userOutstanding === true,
    characterOutstanding: raw.characterOutstanding === true,
    relatedPsychThreadIds: uniqueStrings(
      raw.relatedPsychThreadIds,
      PSYCHOLOGICAL_CONTINUITY_CAPS.relatedPsychThreadIds,
    ),
    followupAttempts: clampInteger(raw.followupAttempts, 0, 3, 0),
    lastMove: cleanText(raw.lastMove, 120),
    openedAt,
    lastTouchedAt,
    closedAt: status === 'closed' ? timestamp(raw.closedAt, lastTouchedAt) : 0,
    sourceAiRoundId: cleanId(raw.sourceAiRoundId),
    lastDeliveryAiRoundId: cleanId(raw.lastDeliveryAiRoundId),
  };
}

function normalizeEpisode(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanId(raw.id);
  const content = cleanText(raw.content, 360);
  if (!id || !content) return null;
  const startedAt = timestamp(raw.startedAt || raw.createdAt);
  const updatedAt = timestamp(raw.updatedAt, startedAt);
  return {
    id,
    kind: enumValue(raw.kind, PSYCH_EPISODE_KINDS, 'emotion'),
    content,
    targetType: cleanId(raw.targetType, 40) || 'self',
    targetId: cleanId(raw.targetId),
    causeRef: cleanText(raw.causeRef, 200),
    intensity: clampNumber(raw.intensity, 0, 1, 0.5),
    confidence: clampNumber(raw.confidence, 0, 1, 0.5),
    status: enumValue(raw.status, PSYCH_EPISODE_STATUSES, 'active'),
    startedAt,
    updatedAt,
    halfLifeMs: clampInteger(
      raw.halfLifeMs,
      60 * 1000,
      MAX_EPISODE_HALF_LIFE_MS,
      DEFAULT_EPISODE_HALF_LIFE_MS,
    ),
    sourceRefs: normalizeSourceRefs(raw.sourceRefs),
    sourceAiRoundId: cleanId(raw.sourceAiRoundId),
  };
}

function normalizeDisclosureThread(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanId(raw.id);
  const proposition = cleanText(raw.proposition, 520);
  if (!id || !proposition) return null;
  let status = enumValue(raw.status, DISCLOSURE_THREAD_STATUSES, 'open');
  const disclosureStage = enumValue(raw.disclosureStage, DISCLOSURE_STAGES, 'private');
  if (disclosureStage === 'said' && (status === 'open' || status === 'snoozed')) status = 'resolved';
  const createdAt = timestamp(raw.createdAt);
  const lastAdvancedAt = timestamp(raw.lastAdvancedAt || raw.updatedAt, createdAt);
  const triggers = uniqueStrings(raw.triggers, 3, 40)
    .map((value) => enumValue(value, DISCLOSURE_TRIGGERS, ''))
    .filter(Boolean);
  const meaningfulTriggers = triggers.some((trigger) => trigger !== 'none')
    ? triggers.filter((trigger) => trigger !== 'none')
    : triggers;
  return {
    id,
    topicId: cleanId(raw.topicId),
    proposition,
    disclosureStage,
    triggers: meaningfulTriggers.length ? meaningfulTriggers : ['none'],
    status,
    confidence: clampNumber(raw.confidence, 0, 1, 0.75),
    attempts: clampInteger(raw.attempts, 0, 3, 0),
    createdAt,
    lastAdvancedAt,
    sourceRefs: normalizeSourceRefs(raw.sourceRefs),
    sourceAiRoundId: cleanId(raw.sourceAiRoundId),
    lastDeliveryAiRoundId: cleanId(raw.lastDeliveryAiRoundId),
    origin: enumValue(raw.origin, ['native', 'legacy_intent'], 'native'),
  };
}

function entityRecency(value) {
  return timestamp(value?.lastAdvancedAt || value?.lastTouchedAt || value?.updatedAt || value?.createdAt || value?.openedAt);
}

function capEntities(values, normalize, limit, priority) {
  const byId = new Map();
  for (const raw of Array.isArray(values) ? values : []) {
    const item = normalize(raw);
    if (!item) continue;
    const previous = byId.get(item.id);
    if (!previous || entityRecency(item) >= entityRecency(previous)) byId.set(item.id, item);
  }
  return [...byId.values()]
    .sort((left, right) => {
      const priorityDelta = priority(right) - priority(left);
      return priorityDelta || entityRecency(right) - entityRecency(left) || left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}

function topicPriority(thread) {
  return thread.status === 'active' ? 3 : thread.status === 'cooling' ? 2 : 1;
}

function episodePriority(episode) {
  return episode.status === 'active' ? 3 : episode.status === 'cooling' ? 2 : 1;
}

function disclosurePriority(thread) {
  return thread.status === 'open' ? 4 : thread.status === 'snoozed' ? 3 : 1;
}

function normalizeExpressionCarry(raw = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const drive = cleanId(value.drive, 40).toLowerCase();
  const sourceAiRoundId = cleanId(value.sourceAiRoundId);
  const minimumBeatCount = clampInteger(value.minimumBeatCount, 0, 12, 0);
  const minimumOwnedCount = clampInteger(value.minimumOwnedCount, 0, 12, 0);
  if (
    !EXPRESSION_CARRY_DRIVES.has(drive)
    || !sourceAiRoundId
    || minimumBeatCount < 1
    || minimumOwnedCount < 1
  ) return null;
  return {
    drive,
    minimumBeatCount,
    minimumOwnedCount,
    sourceAiRoundId,
    createdAt: timestamp(value.createdAt),
  };
}

function normalizeActorState(raw = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    episodes: capEntities(
      value.episodes,
      normalizeEpisode,
      PSYCHOLOGICAL_CONTINUITY_CAPS.episodesPerCharacter,
      episodePriority,
    ),
    disclosureThreads: capEntities(
      value.disclosureThreads,
      normalizeDisclosureThread,
      PSYCHOLOGICAL_CONTINUITY_CAPS.disclosureThreadsPerCharacter,
      disclosurePriority,
    ),
    legacyIntentFingerprint: cleanId(value.legacyIntentFingerprint, 80),
    legacyIntentSourceAiRoundId: cleanId(value.legacyIntentSourceAiRoundId),
    legacyIntentSyncedAt: timestamp(value.legacyIntentSyncedAt),
    // 只保留一张、由已验证可见收据产生的一次性续力。
    expressionCarry: normalizeExpressionCarry(value.expressionCarry),
    selfDisclosureDebt: clampInteger(value.selfDisclosureDebt, 0, 6, 0),
    lastConversationMove: cleanText(value.lastConversationMove, 120),
    lastDeliveryAt: timestamp(value.lastDeliveryAt),
    // 旧数据只有 lastDeliveryAiRoundId；把它收进新账本后继续保留镜像字段，
    // 既不会在升级后的第一次重放时重复结算，也兼容仍按 aiRoundId 调用的链路。
    appliedDeliveryIds: uniqueStrings([
      value.lastDeliveryAiRoundId,
      ...(Array.isArray(value.appliedDeliveryIds) ? value.appliedDeliveryIds : []),
    ], PSYCHOLOGICAL_CONTINUITY_CAPS.appliedDeliveryIds, 160),
    lastDeliveryAiRoundId: cleanId(value.lastDeliveryAiRoundId),
    updatedAt: timestamp(value.updatedAt),
  };
}

function emptyProjection(scope) {
  return {
    version: PSYCHOLOGICAL_CONTINUITY_VERSION,
    userId: scope.userId,
    chatId: scope.chatId,
    revision: 0,
    topicRuntime: { activeTopicId: '', threads: [] },
    actors: {},
    updatedAt: 0,
  };
}

function normalizeProjection(raw, scope, { filterParticipants = true } = {}) {
  const empty = emptyProjection(scope);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  if (!storedScopeMatches(raw, scope)) return empty;

  const topicSource = raw.topicRuntime && typeof raw.topicRuntime === 'object'
    ? raw.topicRuntime
    : {};
  const threads = capEntities(
    topicSource.threads,
    normalizeTopicThread,
    PSYCHOLOGICAL_CONTINUITY_CAPS.topicThreads,
    topicPriority,
  );
  const activeTopicId = cleanId(topicSource.activeTopicId);
  const activeExists = threads.some((thread) => thread.id === activeTopicId && thread.status === 'active');
  const actors = {};
  const actorSource = raw.actors && typeof raw.actors === 'object' && !Array.isArray(raw.actors)
    ? raw.actors
    : {};
  for (const [rawCharacterId, value] of Object.entries(actorSource)) {
    const characterId = cleanId(rawCharacterId);
    if (!characterId || characterId === 'user' || characterId === 'system') continue;
    if (filterParticipants && scope.participantIds && !scope.participantIds.has(characterId)) continue;
    actors[characterId] = normalizeActorState(value);
  }
  return {
    version: PSYCHOLOGICAL_CONTINUITY_VERSION,
    userId: scope.userId,
    chatId: scope.chatId,
    revision: clampInteger(raw.revision, 0, Number.MAX_SAFE_INTEGER, 0),
    topicRuntime: {
      activeTopicId: activeExists ? activeTopicId : '',
      threads,
    },
    actors,
    updatedAt: timestamp(raw.updatedAt),
  };
}

function projectionOf(runtime, scope) {
  return normalizeProjection(runtime, scope, { filterParticipants: false });
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

/**
 * 回滚 CAS 使用的完整内容指纹。这里保留规范化 runtime 的完整 canonical JSON，
 * 而不是短哈希，避免哈希碰撞让同 revision 的覆盖写入伪装成原状态。
 */
export function psychologicalContinuityFingerprint(raw, requestedScope = {}) {
  const scope = requireScope(requestedScope);
  const runtime = normalizePsychologicalContinuity(raw, {
    userId: scope.userId,
    chatId: scope.chatId,
  });
  return JSON.stringify(canonicalJsonValue(runtime));
}

function normalizeRoundSnapshots(value, scope) {
  const byRound = new Map();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const aiRoundId = cleanId(raw.aiRoundId);
    if (!aiRoundId || !raw.before || typeof raw.before !== 'object') continue;
    const item = {
      aiRoundId,
      recordedAt: timestamp(raw.recordedAt),
      revision: clampInteger(raw.revision, 0, Number.MAX_SAFE_INTEGER, 0),
      lastRevision: clampInteger(
        raw.lastRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        clampInteger(raw.revision, 0, Number.MAX_SAFE_INTEGER, 0),
      ),
      before: normalizeProjection(raw.before, scope, { filterParticipants: false }),
    };
    const previous = byRound.get(aiRoundId);
    if (!previous || item.revision >= previous.revision) byRound.set(aiRoundId, item);
  }
  return [...byRound.values()]
    .sort((left, right) => right.revision - left.revision || right.recordedAt - left.recordedAt)
    .slice(0, PSYCHOLOGICAL_CONTINUITY_CAPS.roundSnapshots);
}

/**
 * Normalize untrusted/imported runtime data and enforce the caller's user/chat/participant scope.
 * A stored row that claims another user or chat is returned as an empty runtime, never adopted.
 */
export function normalizePsychologicalContinuity(raw, requestedScope = {}) {
  const scope = requireScope(requestedScope);
  const projection = normalizeProjection(raw, scope);
  return {
    ...projection,
    roundSnapshots: storedScopeMatches(raw, scope)
      ? normalizeRoundSnapshots(raw?.roundSnapshots, scope)
      : [],
  };
}

async function readRawRuntime(chatId) {
  let pending = readCache.get(chatId);
  if (!pending) {
    pending = get(psychologicalContinuityKey(chatId))
      .then((row) => (row?.value && typeof row.value === 'object' ? row.value : null))
      .catch((error) => {
        readCache.delete(chatId);
        throw error;
      });
    readCache.set(chatId, pending);
  }
  return pending;
}

/** Load one chat runtime. participantIds, when provided, is a read-time visibility filter. */
export async function loadPsychologicalContinuity(requestedScope = {}) {
  const scope = requireScope(requestedScope);
  const raw = await readRawRuntime(scope.chatId);
  return normalizePsychologicalContinuity(raw, requestedScope);
}

function withChatUpdateQueue(chatId, task) {
  const previous = updateQueues.get(chatId) || Promise.resolve();
  const queued = previous.catch(() => {}).then(() => {
    const locks = globalThis.navigator?.locks;
    if (locks && typeof locks.request === 'function') {
      return locks.request(
        `marshmallow:psychological-continuity:${chatId}`,
        { mode: 'exclusive' },
        task,
      );
    }
    return task();
  });
  updateQueues.set(chatId, queued);
  return queued.finally(() => {
    if (updateQueues.get(chatId) === queued) updateQueues.delete(chatId);
  });
}

/** 给跨模块的 CAS 恢复路径复用同一 realm 队列与 Web Lock。 */
export function runPsychologicalContinuityExclusive(chatId, task) {
  const id = cleanId(chatId);
  if (!id || typeof task !== 'function') {
    throw new TypeError('psychological continuity exclusive task requires chatId and task');
  }
  return withChatUpdateQueue(id, task);
}

function comparableProjection(runtime, scope) {
  return JSON.stringify(projectionOf(runtime, scope));
}

/**
 * Atomically update a chat runtime. The updater receives a disposable draft and may mutate it
 * or return a replacement. Updates for the same chat are serialized and re-read inside the queue.
 */
export async function updatePsychologicalContinuity(requestedScope = {}, updater, options = {}) {
  const scope = requireScope(requestedScope);
  if (typeof updater !== 'function') throw new TypeError('psychological continuity updater must be a function');
  const now = timestamp(options.now, Date.now());
  const aiRoundId = cleanId(options.aiRoundId);
  return withChatUpdateQueue(scope.chatId, async () => {
    const row = await get(psychologicalContinuityKey(scope.chatId)).catch(() => null);
    const raw = row?.value && typeof row.value === 'object' ? row.value : null;
    if (!storedScopeMatches(raw, scope)) {
      throw new Error('psychological continuity scope mismatch');
    }
    // Storage writes preserve every actor in the chat. participantIds is only used to validate
    // explicit character operations; a partial roster must not prune other actors on save.
    const storageScope = { userId: scope.userId, chatId: scope.chatId };
    const current = normalizePsychologicalContinuity(raw, storageScope);
    const draft = cloneData(current);
    const returned = await updater(draft);
    const candidate = returned && typeof returned === 'object' ? returned : draft;
    let next = normalizePsychologicalContinuity(candidate, storageScope);
    if (comparableProjection(next, storageScope) === comparableProjection(current, storageScope)) {
      return current;
    }

    const existingSnapshotIndex = aiRoundId
      ? current.roundSnapshots.findIndex((snapshot) => snapshot.aiRoundId === aiRoundId)
      : -1;
    const existingSnapshot = existingSnapshotIndex >= 0
      ? current.roundSnapshots[existingSnapshotIndex]
      : null;
    const remainingSnapshots = next.roundSnapshots
      .filter((snapshot) => !aiRoundId || snapshot.aiRoundId !== aiRoundId);
    if (aiRoundId) {
      const remainsContiguous = !!(
        existingSnapshot
        && existingSnapshotIndex === 0
        && current.revision === Number(existingSnapshot.lastRevision || existingSnapshot.revision || 0)
      );
      remainingSnapshots.unshift(existingSnapshot
        ? {
          ...existingSnapshot,
          ...(remainsContiguous ? { lastRevision: current.revision + 1 } : {}),
        }
        : {
          aiRoundId,
          recordedAt: now,
          revision: current.revision + 1,
          lastRevision: current.revision + 1,
          before: projectionOf(current, storageScope),
        });
    }
    next = normalizePsychologicalContinuity({
      ...next,
      revision: current.revision + 1,
      updatedAt: now,
      roundSnapshots: remainingSnapshots,
    }, storageScope);
    await put({ key: psychologicalContinuityKey(scope.chatId), value: next });
    readCache.set(scope.chatId, Promise.resolve(next));
    return next;
  });
}

function allowedTransition(current, next, graph) {
  if (current === next) return true;
  return (graph[current] || []).includes(next);
}

const TOPIC_TRANSITIONS = Object.freeze({
  active: ['cooling', 'closed'],
  cooling: ['active', 'closed'],
  closed: [],
});
const EPISODE_TRANSITIONS = Object.freeze({
  active: ['cooling', 'resolved'],
  cooling: ['active', 'resolved'],
  resolved: [],
});
const DISCLOSURE_TRANSITIONS = Object.freeze({
  open: ['snoozed', 'resolved', 'abandoned'],
  snoozed: ['open', 'resolved', 'abandoned'],
  resolved: [],
  abandoned: [],
});

function stageIndex(stage) {
  return Math.max(0, DISCLOSURE_STAGES.indexOf(stage));
}

function ensureActor(runtime, characterId, now = 0) {
  if (!runtime.actors || typeof runtime.actors !== 'object') runtime.actors = {};
  if (!runtime.actors[characterId]) {
    runtime.actors[characterId] = normalizeActorState({ updatedAt: now });
  }
  return runtime.actors[characterId];
}

function coolOtherActiveTopics(runtime, activeTopicId, now) {
  runtime.topicRuntime.threads = runtime.topicRuntime.threads.map((thread) => (
    thread.id !== activeTopicId && thread.status === 'active'
      ? { ...thread, status: 'cooling', lastTouchedAt: now }
      : thread
  ));
}

function reconcileTopicOutstanding(runtime, topicId) {
  const id = cleanId(topicId);
  if (!id) return;
  const hasOpenDisclosure = Object.values(runtime.actors || {}).some((actor) => (
    (actor?.disclosureThreads || []).some((thread) => thread.topicId === id && thread.status === 'open')
  ));
  runtime.topicRuntime.threads = runtime.topicRuntime.threads.map((thread) => (
    thread.id === id ? { ...thread, characterOutstanding: hasOpenDisclosure } : thread
  ));
}

/** Create or patch a topic thread. A closed id is terminal; a restarted topic needs a new id. */
export async function upsertTopicThread(scope, input = {}, options = {}) {
  const id = cleanId(input.id);
  if (!id) throw new TypeError('topic thread id is required');
  const now = timestamp(options.now, Date.now());
  return updatePsychologicalContinuity(scope, (runtime) => {
    const index = runtime.topicRuntime.threads.findIndex((thread) => thread.id === id);
    const previous = index >= 0 ? runtime.topicRuntime.threads[index] : null;
    const candidate = normalizeTopicThread({
      ...(previous || {}),
      ...input,
      id,
      sourceAiRoundId: previous?.sourceAiRoundId || input.sourceAiRoundId || options.aiRoundId,
      openedAt: previous?.openedAt || input.openedAt || now,
      lastTouchedAt: input.lastTouchedAt || now,
    });
    if (!candidate) throw new TypeError('topic thread summary is required');
    if (previous && !allowedTransition(previous.status, candidate.status, TOPIC_TRANSITIONS)) {
      candidate.status = previous.status;
      candidate.closedAt = previous.closedAt;
    }
    if (index >= 0) runtime.topicRuntime.threads[index] = candidate;
    else runtime.topicRuntime.threads.push(candidate);
    if (candidate.status === 'active' && input.setActive !== false) {
      coolOtherActiveTopics(runtime, id, now);
      runtime.topicRuntime.activeTopicId = id;
    } else if (runtime.topicRuntime.activeTopicId === id && candidate.status !== 'active') {
      runtime.topicRuntime.activeTopicId = '';
    }
  }, { ...options, now });
}

export async function transitionTopicThread(scope, topicId, nextStatus, patch = {}, options = {}) {
  const id = cleanId(topicId);
  const status = enumValue(nextStatus, TOPIC_THREAD_STATUSES, '');
  if (!id || !status) throw new TypeError('valid topic id and status are required');
  const now = timestamp(options.now, Date.now());
  return updatePsychologicalContinuity(scope, (runtime) => {
    const index = runtime.topicRuntime.threads.findIndex((thread) => thread.id === id);
    if (index < 0) throw new Error('topic thread not found');
    const previous = runtime.topicRuntime.threads[index];
    if (!allowedTransition(previous.status, status, TOPIC_TRANSITIONS)) return;
    const next = normalizeTopicThread({
      ...previous,
      ...patch,
      id,
      status,
      openedAt: previous.openedAt,
      lastTouchedAt: now,
      closedAt: status === 'closed' ? now : 0,
      sourceAiRoundId: previous.sourceAiRoundId || patch.sourceAiRoundId || options.aiRoundId,
    });
    runtime.topicRuntime.threads[index] = next;
    if (status === 'active') {
      coolOtherActiveTopics(runtime, id, now);
      runtime.topicRuntime.activeTopicId = id;
    } else if (runtime.topicRuntime.activeTopicId === id) {
      runtime.topicRuntime.activeTopicId = '';
    }
  }, { ...options, now });
}

/** Create or patch one private psychological episode for one character. */
export async function upsertPsychEpisode(scope, characterId, input = {}, options = {}) {
  const normalizedScope = requireScope(scope);
  const actorId = requireCharacterId(characterId, normalizedScope);
  const id = cleanId(input.id);
  if (!id) throw new TypeError('psych episode id is required');
  const now = timestamp(options.now, Date.now());
  return updatePsychologicalContinuity(scope, (runtime) => {
    const actor = ensureActor(runtime, actorId, now);
    const index = actor.episodes.findIndex((episode) => episode.id === id);
    const previous = index >= 0 ? actor.episodes[index] : null;
    const candidate = normalizeEpisode({
      ...(previous || {}),
      ...input,
      id,
      sourceAiRoundId: previous?.sourceAiRoundId || input.sourceAiRoundId || options.aiRoundId,
      sourceRefs: mergeSourceRefs(previous?.sourceRefs, input.sourceRefs),
      startedAt: previous?.startedAt || input.startedAt || now,
      updatedAt: now,
    });
    if (!candidate) throw new TypeError('psych episode content is required');
    if (previous && !allowedTransition(previous.status, candidate.status, EPISODE_TRANSITIONS)) {
      candidate.status = previous.status;
    }
    if (index >= 0) actor.episodes[index] = candidate;
    else actor.episodes.push(candidate);
    actor.updatedAt = now;
  }, { ...options, now });
}

export async function transitionPsychEpisode(scope, characterId, episodeId, nextStatus, patch = {}, options = {}) {
  const normalizedScope = requireScope(scope);
  const actorId = requireCharacterId(characterId, normalizedScope);
  const id = cleanId(episodeId);
  const status = enumValue(nextStatus, PSYCH_EPISODE_STATUSES, '');
  if (!id || !status) throw new TypeError('valid episode id and status are required');
  const now = timestamp(options.now, Date.now());
  return updatePsychologicalContinuity(scope, (runtime) => {
    const actor = runtime.actors?.[actorId];
    const index = actor?.episodes?.findIndex((episode) => episode.id === id) ?? -1;
    if (index < 0) throw new Error('psych episode not found');
    const previous = actor.episodes[index];
    if (!allowedTransition(previous.status, status, EPISODE_TRANSITIONS)) return;
    actor.episodes[index] = normalizeEpisode({
      ...previous,
      ...patch,
      id,
      status,
      sourceRefs: mergeSourceRefs(previous.sourceRefs, patch.sourceRefs),
      startedAt: previous.startedAt,
      updatedAt: now,
    });
    actor.updatedAt = now;
  }, { ...options, now });
}

/** Create or patch a character-owned unsaid-content thread. */
export async function upsertDisclosureThread(scope, characterId, input = {}, options = {}) {
  const normalizedScope = requireScope(scope);
  const actorId = requireCharacterId(characterId, normalizedScope);
  const id = cleanId(input.id);
  if (!id) throw new TypeError('disclosure thread id is required');
  const now = timestamp(options.now, Date.now());
  return updatePsychologicalContinuity(scope, (runtime) => {
    const actor = ensureActor(runtime, actorId, now);
    const index = actor.disclosureThreads.findIndex((thread) => thread.id === id);
    const previous = index >= 0 ? actor.disclosureThreads[index] : null;
    const requestedStage = enumValue(input.disclosureStage, DISCLOSURE_STAGES, previous?.disclosureStage || 'private');
    const candidate = normalizeDisclosureThread({
      ...(previous || {}),
      ...input,
      id,
      sourceAiRoundId: previous?.sourceAiRoundId || input.sourceAiRoundId || options.aiRoundId,
      disclosureStage: previous && stageIndex(requestedStage) < stageIndex(previous.disclosureStage)
        ? previous.disclosureStage
        : requestedStage,
      sourceRefs: mergeSourceRefs(previous?.sourceRefs, input.sourceRefs),
      createdAt: previous?.createdAt || input.createdAt || now,
      lastAdvancedAt: now,
    });
    if (!candidate) throw new TypeError('disclosure proposition is required');
    if (previous && !allowedTransition(previous.status, candidate.status, DISCLOSURE_TRANSITIONS)) {
      candidate.status = previous.status;
    }
    if (index >= 0) actor.disclosureThreads[index] = candidate;
    else actor.disclosureThreads.push(candidate);
    actor.updatedAt = now;

    if (candidate.topicId) {
      runtime.topicRuntime.threads = runtime.topicRuntime.threads.map((topic) => (
        topic.id === candidate.topicId
          ? {
            ...topic,
            relatedPsychThreadIds: uniqueStrings(
              [...topic.relatedPsychThreadIds, candidate.id],
              PSYCHOLOGICAL_CONTINUITY_CAPS.relatedPsychThreadIds,
            ),
            lastTouchedAt: now,
          }
          : topic
      ));
      reconcileTopicOutstanding(runtime, candidate.topicId);
    }
  }, { ...options, now });
}

export async function transitionDisclosureThread(scope, characterId, threadId, nextStatus, patch = {}, options = {}) {
  const normalizedScope = requireScope(scope);
  const actorId = requireCharacterId(characterId, normalizedScope);
  const id = cleanId(threadId);
  const status = enumValue(nextStatus, DISCLOSURE_THREAD_STATUSES, '');
  if (!id || !status) throw new TypeError('valid disclosure id and status are required');
  const now = timestamp(options.now, Date.now());
  return updatePsychologicalContinuity(scope, (runtime) => {
    const actor = runtime.actors?.[actorId];
    const index = actor?.disclosureThreads?.findIndex((thread) => thread.id === id) ?? -1;
    if (index < 0) throw new Error('disclosure thread not found');
    const previous = actor.disclosureThreads[index];
    if (!allowedTransition(previous.status, status, DISCLOSURE_TRANSITIONS)) return;
    const requestedStage = enumValue(
      patch.disclosureStage,
      DISCLOSURE_STAGES,
      previous.disclosureStage,
    );
    const disclosureStage = stageIndex(requestedStage) < stageIndex(previous.disclosureStage)
      ? previous.disclosureStage
      : requestedStage;
    actor.disclosureThreads[index] = normalizeDisclosureThread({
      ...previous,
      ...patch,
      id,
      status,
      disclosureStage,
      attempts: clampInteger(
        Number(previous.attempts || 0) + Number(patch.attemptDelta || 0),
        0,
        3,
        previous.attempts,
      ),
      sourceRefs: mergeSourceRefs(previous.sourceRefs, patch.sourceRefs),
      createdAt: previous.createdAt,
      lastAdvancedAt: now,
    });
    actor.updatedAt = now;
    reconcileTopicOutstanding(runtime, previous.topicId);
  }, { ...options, now });
}

function stableHash(value = '') {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeLegacyTriggers(value) {
  const text = cleanText(value, 160);
  const matches = [];
  const candidates = [
    { pattern: /(?:user|用户|对方)\s*追问|追问/iu, value: 'user_ask' },
    { pattern: /(?:角色|自己|TA)?\s*稍后主动|主动接回/iu, value: 'character_later' },
    { pattern: /相似话题|类似话题/iu, value: 'similar_topic' },
  ];
  for (const candidate of candidates) {
    const match = candidate.pattern.exec(text);
    if (match) matches.push({ index: match.index, value: candidate.value });
  }
  return [...new Set(matches.sort((a, b) => a.index - b.index).map((item) => item.value))];
}

/** Parse only the explicit legacy pending format; ordinary per-round intent is deliberately ignored. */
export function parseLegacyPendingIntent(intent = '') {
  const value = cleanText(intent, 800);
  const match = value.match(/^待续\s*[:：]\s*(.+?)\s*[|｜]\s*触发\s*[:：]\s*(.+)$/u);
  if (!match) return null;
  const proposition = cleanText(match[1], 520);
  const triggers = normalizeLegacyTriggers(match[2]);
  if (!proposition || !triggers.length) return null;
  return {
    proposition,
    triggers,
    triggerText: cleanText(match[2], 160),
  };
}

function legacyFingerprint(characterId, state = {}) {
  const intent = cleanText(state.intent, 800);
  const aiRoundId = cleanId(state.aiRoundId);
  return stableHash(`${characterId}\u0000${aiRoundId}\u0000${intent}`);
}

/**
 * Lazily bridge an existing `state.intent` into the new typed runtime.
 * Only intent/round/timestamp are read. `state.inner` is intentionally unreachable here.
 */
export async function syncLegacyIntent(scope, characterId, characterState = {}, options = {}) {
  const normalizedScope = requireScope(scope);
  const actorId = requireCharacterId(characterId, normalizedScope);
  const intent = cleanText(characterState?.intent, 800);
  const parsed = parseLegacyPendingIntent(intent);
  const sourceAiRoundId = cleanId(characterState?.aiRoundId || options.aiRoundId);
  const now = timestamp(options.now || characterState?.updatedAt, Date.now());
  const fingerprint = legacyFingerprint(actorId, { intent, aiRoundId: sourceAiRoundId });
  const seed = stableHash(`${normalizedScope.chatId}\u0000${actorId}\u0000${sourceAiRoundId || fingerprint}\u0000${intent}`);
  const topicId = `legacy_topic_${seed}`;
  const disclosureId = `legacy_disclosure_${seed}`;

  return updatePsychologicalContinuity(scope, (runtime) => {
    const existingActor = runtime.actors?.[actorId];
    if (existingActor?.legacyIntentFingerprint === fingerprint) return;
    // 普通/空 intent 仍只是单轮盘算，不能凭“这一轮没重写待续格式”猜测旧线头
    // 已经失效、被说完或应该降温。只有正式 thread op 才能结束它；兼容桥在
    // 这里保持完全不动，避免结构化连续性再次退化成一两轮窗口。
    if (!parsed) return;
    const actor = ensureActor(runtime, actorId, now);

    const sameOpenThread = actor.disclosureThreads.find((thread) => (
      thread.origin === 'legacy_intent'
      && thread.status === 'open'
      && thread.proposition === parsed.proposition
    ));
    if (sameOpenThread) {
      sameOpenThread.triggers = parsed.triggers;
      sameOpenThread.lastAdvancedAt = now;
      actor.legacyIntentFingerprint = fingerprint;
      actor.legacyIntentSourceAiRoundId = sourceAiRoundId;
      actor.legacyIntentSyncedAt = now;
      actor.updatedAt = now;
      reconcileTopicOutstanding(runtime, sameOpenThread.topicId);
      return;
    }

    // A newer legacy intent replaces the old per-round agenda. Preserve old content as snoozed,
    // never guess that it was said/resolved merely because the legacy field changed or cleared.
    actor.disclosureThreads = actor.disclosureThreads.map((thread) => (
      thread.origin === 'legacy_intent' && thread.status === 'open'
        ? { ...thread, status: 'snoozed', lastAdvancedAt: now }
        : thread
    ));
    actor.legacyIntentFingerprint = fingerprint;
    actor.legacyIntentSourceAiRoundId = sourceAiRoundId;
    actor.legacyIntentSyncedAt = now;
    actor.updatedAt = now;

    const topic = normalizeTopicThread({
      id: topicId,
      summary: parsed.proposition,
      status: 'active',
      characterOutstanding: true,
      relatedPsychThreadIds: [disclosureId],
      openedAt: now,
      lastTouchedAt: now,
      lastMove: 'legacy-intent-import',
      sourceAiRoundId,
    });
    coolOtherActiveTopics(runtime, topicId, now);
    const topicIndex = runtime.topicRuntime.threads.findIndex((item) => item.id === topicId);
    if (topicIndex >= 0) runtime.topicRuntime.threads[topicIndex] = topic;
    else runtime.topicRuntime.threads.push(topic);
    runtime.topicRuntime.activeTopicId = topicId;

    const disclosure = normalizeDisclosureThread({
      id: disclosureId,
      topicId,
      proposition: parsed.proposition,
      disclosureStage: 'private',
      triggers: parsed.triggers,
      status: 'open',
      confidence: 0.75,
      attempts: 0,
      createdAt: now,
      lastAdvancedAt: now,
      sourceRefs: sourceAiRoundId ? [{ kind: 'state', id: sourceAiRoundId }] : [],
      sourceAiRoundId,
      origin: 'legacy_intent',
    });
    const disclosureIndex = actor.disclosureThreads.findIndex((item) => item.id === disclosureId);
    if (disclosureIndex >= 0) actor.disclosureThreads[disclosureIndex] = disclosure;
    else actor.disclosureThreads.push(disclosure);
    reconcileTopicOutstanding(runtime, topicId);
  }, { ...options, aiRoundId: sourceAiRoundId, now });
}

function compositionMetadataList(metadata, key) {
  return uniqueStrings(metadata?.[key], 24, 160);
}

function normalizeVisibleDeliveryRecords(metadata = {}) {
  const rawDeliveries = Array.isArray(metadata.replyCompositionDeliveries)
    ? metadata.replyCompositionDeliveries
    : [];
  if (rawDeliveries.length) {
    return rawDeliveries.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const refs = uniqueStrings(raw.refs, 24, 160);
      const refSet = new Set(refs);
      return {
        act: cleanId(raw.act, 60).toLowerCase() || 'other',
        refs,
        obligationRefs: uniqueStrings(raw.obligationRefs, 24, 160)
          .filter((ref) => refSet.has(ref)),
        ownedRefs: uniqueStrings(raw.ownedRefs, 24, 160)
          .filter((ref) => refSet.has(ref)),
      };
    }).filter(Boolean).slice(0, 24);
  }
  const refs = compositionMetadataList(metadata, 'replyCompositionRefs');
  const refSet = new Set(refs);
  const acts = compositionMetadataList(metadata, 'replyCompositionActs');
  const obligationRefs = compositionMetadataList(metadata, 'replyCompositionObligationRefs')
    .filter((ref) => refSet.has(ref));
  const ownedRefs = compositionMetadataList(metadata, 'replyCompositionOwnedRefs')
    .filter((ref) => refSet.has(ref));
  if (!refs.length && !acts.length) return [];
  return [{
    act: acts[0] || 'other',
    refs,
    obligationRefs,
    ownedRefs,
  }];
}

function hasVisibleMessageContent(message = {}) {
  if (message.deleted === true || message.metadata?.deliveryStatus === 'rejected') return false;
  const content = message.content ?? message.body ?? message.text;
  if (typeof content === 'string') return !!content.trim();
  return content !== undefined && content !== null;
}

function normalizeVisibleExpressionReceipt(metadata = {}) {
  if (!Object.prototype.hasOwnProperty.call(metadata, 'replyCompositionExpressionSatisfied')) {
    return null;
  }
  const satisfied = metadata.replyCompositionExpressionSatisfied;
  if (satisfied !== true && satisfied !== false) return null;
  const drive = cleanId(metadata.replyCompositionExpressionDrive, 40).toLowerCase();
  if (!REPLY_EXPRESSION_DRIVES.has(drive)) return null;
  return {
    drive,
    satisfied,
    drivers: uniqueStrings(
      metadata.replyCompositionExpressionDrivers,
      5,
      40,
    ).map((value) => value.toLowerCase()),
    minimumBeatCount: clampInteger(
      metadata.replyCompositionExpressionMinimumBeatCount,
      0,
      12,
      0,
    ),
    minimumOwnedCount: clampInteger(
      metadata.replyCompositionExpressionMinimumOwnedCount,
      0,
      12,
      0,
    ),
  };
}

function expressionReceiptFingerprint(receipt) {
  if (!receipt) return '';
  return [
    receipt.drive,
    receipt.satisfied ? '1' : '0',
    [...(receipt.drivers || [])].sort().join(','),
    receipt.minimumBeatCount,
    receipt.minimumOwnedCount,
  ].join(':');
}

function collectVisibleCompositionDeliveries(scope, messages = [], options = {}) {
  const requestedRoundId = cleanId(options.aiRoundId);
  const requestedDeliveryId = cleanId(options.deliveryId, 160);
  const byActor = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const metadata = message?.metadata && typeof message.metadata === 'object'
      ? message.metadata
      : {};
    if (Number(metadata.replyCompositionVersion || 0) !== 1 || !hasVisibleMessageContent(message)) continue;
    const actorId = cleanId(message.senderId || message.from || message.actor);
    if (!actorId || actorId === 'user' || actorId === 'system' || actorId === 'guidance') continue;
    if (scope.participantIds && !scope.participantIds.has(actorId)) continue;
    const records = normalizeVisibleDeliveryRecords(metadata);
    if (!records.length) continue;
    const metadataDeliveryId = cleanId(
      metadata.replyCompositionDeliveryId || metadata.psychologicalDeliveryId,
      160,
    );
    let bucket = byActor.get(actorId);
    if (!bucket) {
      bucket = {
        actorId,
        messageIds: new Set(),
        acts: new Set(),
        refs: new Set(),
        obligationRefs: new Set(),
        ownedRefs: new Set(),
        perOwnedRef: new Map(),
        topicMove: 'continue',
        aiRoundId: requestedRoundId || cleanId(metadata.aiRoundId),
        deliveryId: requestedDeliveryId || metadataDeliveryId,
        expressionReceipt: null,
        expressionReceiptFingerprint: '',
        expressionReceiptConflict: false,
      };
      byActor.set(actorId, bucket);
    }
    if (!bucket.aiRoundId) bucket.aiRoundId = requestedRoundId || cleanId(metadata.aiRoundId);
    if (!bucket.deliveryId) bucket.deliveryId = requestedDeliveryId || metadataDeliveryId;
    const messageId = cleanId(message.id, 160);
    if (messageId) bucket.messageIds.add(messageId);
    const topicMove = cleanId(metadata.replyCompositionTopicMove, 40).toLowerCase();
    if (TOPIC_MOVES.has(topicMove)) bucket.topicMove = topicMove;
    const expressionReceipt = normalizeVisibleExpressionReceipt(metadata);
    if (expressionReceipt) {
      const fingerprint = expressionReceiptFingerprint(expressionReceipt);
      if (!bucket.expressionReceipt) {
        bucket.expressionReceipt = expressionReceipt;
        bucket.expressionReceiptFingerprint = fingerprint;
      } else if (bucket.expressionReceiptFingerprint !== fingerprint) {
        // 一次可见交付应该共享同一张收据；冲突时不创建新续力。
        bucket.expressionReceiptConflict = true;
      }
    }
    for (const record of records) {
      bucket.acts.add(record.act);
      record.refs.forEach((ref) => bucket.refs.add(ref));
      record.obligationRefs.forEach((ref) => bucket.obligationRefs.add(ref));
      for (const ref of record.ownedRefs) {
        bucket.ownedRefs.add(ref);
        let delivery = bucket.perOwnedRef.get(ref);
        if (!delivery) {
          delivery = { acts: new Set(), messageIds: new Set() };
          bucket.perOwnedRef.set(ref, delivery);
        }
        delivery.acts.add(record.act);
        if (messageId) delivery.messageIds.add(messageId);
      }
    }
  }
  for (const bucket of byActor.values()) {
    if (!bucket.aiRoundId) {
      const ids = [...bucket.messageIds];
      if (ids.length) bucket.aiRoundId = `visible_${stableHash(ids.join('\u0000'))}`;
    }
    // 现有调用方只传 aiRoundId；在显式 deliveryId 全面接线前继续把 round id
    // 当作稳定交付 id。新调用方可在同一 round 中用不同 deliveryId 分别结算。
    if (!bucket.deliveryId) bucket.deliveryId = bucket.aiRoundId;
  }
  return byActor;
}

function applyExpressionCarryDelivery(actor, delivery, sourceAiRoundId, now) {
  const existing = normalizeExpressionCarry(actor.expressionCarry);
  const receipt = delivery.expressionReceiptConflict ? null : delivery.expressionReceipt;
  const closesTopic = delivery.topicMove === 'close';
  const explicitlySatisfied = receipt?.satisfied === true;
  if (closesTopic || explicitlySatisfied) {
    actor.expressionCarry = null;
    return;
  }

  // 旧续力只允许进入下一个不同 round 的生成；该 round 一旦有可见
  // 交付就算已消费，不会在同一次结算里用新的 underfill 永久刷新。
  if (existing && sourceAiRoundId && existing.sourceAiRoundId !== sourceAiRoundId) {
    actor.expressionCarry = null;
    return;
  }

  const underfilled = !!(
    !existing
    && receipt
    && EXPRESSION_CARRY_DRIVES.has(receipt.drive)
    && receipt.satisfied === false
    && receipt.minimumBeatCount > 0
    && receipt.minimumOwnedCount > 0
    && sourceAiRoundId
  );
  actor.expressionCarry = underfilled
    ? normalizeExpressionCarry({
      drive: receipt.drive,
      minimumBeatCount: receipt.minimumBeatCount,
      minimumOwnedCount: receipt.minimumOwnedCount,
      sourceAiRoundId,
      createdAt: now,
    })
    : existing;
}

/**
 * 把“真正落库的可见表达”归约回心理连续性。隐藏 inner/state 没有入口；
 * 只有经过回复组织校验并随可见消息保存的 refs 才能推进线头或偿还自我揭露欠账。
 * options.deliveryId / metadata.replyCompositionDeliveryId 是一次可见交付的稳定幂等键；
 * 旧调用未提供时继续回退到 aiRoundId。
 */
export async function applyVisibleReplyCompositionDelivery(scope, messages = [], options = {}) {
  const normalizedScope = requireScope(scope);
  const now = timestamp(options.now, Date.now());
  const deliveries = collectVisibleCompositionDeliveries(normalizedScope, messages, options);
  if (!deliveries.size) {
    return { applied: false, reason: 'no-visible-composition', actorIds: [] };
  }
  const sharedRoundId = cleanId(options.aiRoundId)
    || [...deliveries.values()].map((item) => item.aiRoundId).find(Boolean)
    || '';
  const appliedActorIds = [];
  const runtime = await updatePsychologicalContinuity(scope, (draft) => {
    for (const delivery of deliveries.values()) {
      const sourceAiRoundId = cleanId(delivery.aiRoundId || sharedRoundId);
      const deliveryId = cleanId(delivery.deliveryId || sourceAiRoundId, 160);
      if (!deliveryId) continue;
      const actor = ensureActor(draft, delivery.actorId, now);
      if (actor.appliedDeliveryIds.includes(deliveryId)) continue;

      applyExpressionCarryDelivery(actor, delivery, sourceAiRoundId, now);

      const touchedTopicIds = new Set();
      const advancedDisclosureThreadIds = new Set();
      for (let index = 0; index < actor.disclosureThreads.length; index += 1) {
        const thread = actor.disclosureThreads[index];
        const delivered = delivery.perOwnedRef.get(thread.id);
        if (!delivered || thread.status === 'resolved' || thread.status === 'abandoned') continue;
        const acts = delivered.acts;
        advancedDisclosureThreadIds.add(thread.id);
        let status = thread.status;
        let disclosureStage = thread.disclosureStage;
        let attempts = thread.attempts;
        if ([...acts].some((act) => DISCLOSURE_RESOLVE_ACTS.has(act))) {
          status = 'resolved';
          disclosureStage = 'said';
        } else if ([...acts].some((act) => DISCLOSURE_ABANDON_ACTS.has(act))) {
          status = 'abandoned';
        } else if ([...acts].some((act) => DISCLOSURE_SNOOZE_ACTS.has(act))) {
          status = 'snoozed';
          attempts = clampInteger(Number(thread.attempts || 0) + 1, 0, 3, thread.attempts);
        } else {
          status = 'open';
          if (stageIndex(disclosureStage) < stageIndex('partial')) disclosureStage = 'partial';
        }
        actor.disclosureThreads[index] = normalizeDisclosureThread({
          ...thread,
          status,
          disclosureStage,
          attempts,
          sourceRefs: mergeSourceRefs(
            [...delivered.messageIds].map((id) => ({ kind: 'message', id })),
            thread.sourceRefs,
          ),
          lastAdvancedAt: now,
          lastDeliveryAiRoundId: sourceAiRoundId || deliveryId,
        });
        if (thread.topicId) touchedTopicIds.add(thread.topicId);
      }

      const openDisclosureThreads = actor.disclosureThreads.filter((thread) => thread.status === 'open');
      const expressionReceipt = delivery.expressionReceiptConflict ? null : delivery.expressionReceipt;
      const missedConcreteContinuity = !!(
        openDisclosureThreads.length
        && EXPRESSION_CARRY_DRIVES.has(expressionReceipt?.drive)
        && expressionReceipt?.drivers?.includes('unfinished_thread')
        && advancedDisclosureThreadIds.size === 0
      );
      if (advancedDisclosureThreadIds.size > 0) {
        actor.selfDisclosureDebt = clampInteger(
          Number(actor.selfDisclosureDebt || 0) - 2,
          0,
          6,
          0,
        );
      } else if (missedConcreteContinuity) {
        // 只有模型明确判断“高表达欲来自仍未完的结构化线头”，却没有在可见
        // 回复中推进、暂缓或关掉它时，才留下防偷懒压力。普通短回复、手动
        // 气泡装配和泛化的生活/记忆联想都不欠“角色自有内容作业”。
        actor.selfDisclosureDebt = clampInteger(
          Number(actor.selfDisclosureDebt || 0) + 1,
          0,
          6,
          0,
        );
      } else if (!openDisclosureThreads.length) {
        // 旧版本可能在没有具体线头时积累了泛化欠账；让它随正常可见回合
        // 安静衰减，避免升级后继续常驻一份无来源的表达任务。
        actor.selfDisclosureDebt = clampInteger(
          Number(actor.selfDisclosureDebt || 0) - 1,
          0,
          6,
          0,
        );
      }
      actor.lastConversationMove = cleanText(
        `${delivery.topicMove}:${[...delivery.acts].slice(0, 4).join(',') || 'other'}`,
        120,
      );
      actor.lastDeliveryAt = now;
      actor.appliedDeliveryIds = uniqueStrings([
        deliveryId,
        ...(actor.appliedDeliveryIds || []),
      ], PSYCHOLOGICAL_CONTINUITY_CAPS.appliedDeliveryIds, 160);
      actor.lastDeliveryAiRoundId = sourceAiRoundId || deliveryId;
      actor.updatedAt = now;

      if (!touchedTopicIds.size && draft.topicRuntime.activeTopicId) {
        touchedTopicIds.add(draft.topicRuntime.activeTopicId);
      }
      draft.topicRuntime.threads = draft.topicRuntime.threads.map((topic) => {
        if (!touchedTopicIds.has(topic.id)) return topic;
        const shouldCool = delivery.topicMove === 'branch' || delivery.topicMove === 'close';
        return normalizeTopicThread({
          ...topic,
          status: shouldCool && topic.status === 'active' ? 'cooling' : topic.status,
          lastMove: `visible-${delivery.topicMove}`,
          lastTouchedAt: now,
          lastDeliveryAiRoundId: sourceAiRoundId || deliveryId,
        });
      });
      if (
        (delivery.topicMove === 'branch' || delivery.topicMove === 'close')
        && touchedTopicIds.has(draft.topicRuntime.activeTopicId)
      ) {
        draft.topicRuntime.activeTopicId = '';
      }
      touchedTopicIds.forEach((topicId) => reconcileTopicOutstanding(draft, topicId));
      appliedActorIds.push(delivery.actorId);
    }
  }, { ...options, aiRoundId: sharedRoundId, now });
  return {
    applied: appliedActorIds.length > 0,
    reason: appliedActorIds.length ? 'ok' : 'already-applied',
    actorIds: appliedActorIds,
    runtime,
  };
}

function effectiveEpisodeIntensity(episode, now) {
  if (episode.status === 'resolved') return 0;
  const age = Math.max(0, now - timestamp(episode.updatedAt || episode.startedAt, now));
  const halfLife = Math.max(60 * 1000, Number(episode.halfLifeMs) || DEFAULT_EPISODE_HALF_LIFE_MS);
  return clampNumber(episode.intensity * Math.pow(0.5, age / halfLife), 0, 1, 0);
}

/**
 * Select a small, role-private prompt projection. It returns structured data, not prose, and never
 * exposes snapshots, other actors, or any raw heart-voice history.
 */
export function selectPsychologicalContinuityForPrompt(runtime, characterId, options = {}) {
  const actorId = cleanId(characterId);
  const now = timestamp(options.now, Date.now());
  const disclosureLimit = clampInteger(options.limit, 0, 2, 1);
  const episodeLimit = clampInteger(options.episodeLimit, 0, 3, 2);
  const userId = cleanId(runtime?.userId);
  const chatId = cleanId(runtime?.chatId);
  if (!actorId || actorId === 'user' || actorId === 'system' || !userId || !chatId) {
    return { topic: null, disclosureThreads: [], episodes: [] };
  }
  const safeRuntime = normalizePsychologicalContinuity(runtime, { userId, chatId });
  const actor = safeRuntime.actors?.[actorId];
  if (!actor) return { topic: null, disclosureThreads: [], episodes: [] };
  const excludedRoundIds = new Set(
    (Array.isArray(options.excludeAiRoundIds) ? options.excludeAiRoundIds : [options.excludeAiRoundId])
      .map((value) => cleanId(value))
      .filter(Boolean),
  );
  const requestedTopicId = cleanId(options.topicId);
  const activeTopicId = requestedTopicId || cleanId(safeRuntime.topicRuntime.activeTopicId);
  const disclosureThreads = (actor.disclosureThreads || [])
    .filter((thread) => (
      thread.status === 'open'
      && !excludedRoundIds.has(cleanId(thread.sourceAiRoundId))
    ))
    .sort((left, right) => {
      const leftTopic = activeTopicId && left.topicId === activeTopicId ? 1 : 0;
      const rightTopic = activeTopicId && right.topicId === activeTopicId ? 1 : 0;
      return rightTopic - leftTopic || entityRecency(right) - entityRecency(left);
    })
    .slice(0, disclosureLimit)
    .map((thread) => cloneData(thread));
  const selectedTopicId = activeTopicId || cleanId(disclosureThreads[0]?.topicId);
  const topic = safeRuntime.topicRuntime.threads.find((item) => (
    item.id === selectedTopicId && item.status !== 'closed'
    && !excludedRoundIds.has(cleanId(item.sourceAiRoundId))
  )) || null;
  const episodes = (actor.episodes || [])
    .filter((episode) => (
      episode.status !== 'resolved'
      && !excludedRoundIds.has(cleanId(episode.sourceAiRoundId))
    ))
    .map((episode) => ({ ...episode, effectiveIntensity: effectiveEpisodeIntensity(episode, now) }))
    .filter((episode) => episode.effectiveIntensity >= 0.05)
    .sort((left, right) => right.effectiveIntensity - left.effectiveIntensity || entityRecency(right) - entityRecency(left))
    .slice(0, episodeLimit)
    .map((episode) => cloneData(episode));
  const expressionCarry = actor.expressionCarry
    && !excludedRoundIds.has(cleanId(actor.expressionCarry.sourceAiRoundId))
    ? cloneData(actor.expressionCarry)
    : null;
  return {
    topic: topic ? cloneData(topic) : null,
    disclosureThreads,
    episodes,
    ...(expressionCarry ? { expressionCarry } : {}),
    selfDisclosureDebt: actor.selfDisclosureDebt,
    lastConversationMove: actor.lastConversationMove,
    lastDeliveryAt: actor.lastDeliveryAt,
  };
}

function removeRoundOwnedPsychologicalEntities(runtime, roundId) {
  const removedDisclosureIds = new Set();
  let changed = false;
  for (const [actorId, actor] of Object.entries(runtime.actors || {})) {
    const nextEpisodes = (actor.episodes || []).filter((episode) => {
      const remove = cleanId(episode.sourceAiRoundId) === roundId;
      if (remove) changed = true;
      return !remove;
    });
    const nextDisclosures = (actor.disclosureThreads || []).filter((thread) => {
      const remove = cleanId(thread.sourceAiRoundId) === roundId;
      if (remove) {
        changed = true;
        removedDisclosureIds.add(thread.id);
      }
      return !remove;
    });
    const clearsLegacySource = cleanId(actor.legacyIntentSourceAiRoundId) === roundId;
    const clearsExpressionCarry = cleanId(actor.expressionCarry?.sourceAiRoundId) === roundId;
    if (clearsLegacySource) changed = true;
    if (clearsExpressionCarry) changed = true;
    const nextActor = {
      ...actor,
      episodes: nextEpisodes,
      disclosureThreads: nextDisclosures,
      legacyIntentFingerprint: clearsLegacySource ? '' : actor.legacyIntentFingerprint,
      legacyIntentSourceAiRoundId: clearsLegacySource ? '' : actor.legacyIntentSourceAiRoundId,
      legacyIntentSyncedAt: clearsLegacySource ? 0 : actor.legacyIntentSyncedAt,
      expressionCarry: clearsExpressionCarry ? null : actor.expressionCarry,
    };
    if (
      !nextActor.episodes.length
      && !nextActor.disclosureThreads.length
      && !nextActor.legacyIntentFingerprint
      && !nextActor.expressionCarry
    ) {
      delete runtime.actors[actorId];
    } else {
      runtime.actors[actorId] = nextActor;
    }
  }
  const removedTopicIds = new Set();
  runtime.topicRuntime.threads = runtime.topicRuntime.threads.filter((topic) => {
    const remove = cleanId(topic.sourceAiRoundId) === roundId;
    if (remove) {
      changed = true;
      removedTopicIds.add(topic.id);
    }
    return !remove;
  }).map((topic) => {
    const relatedPsychThreadIds = topic.relatedPsychThreadIds
      .filter((id) => !removedDisclosureIds.has(id));
    if (relatedPsychThreadIds.length !== topic.relatedPsychThreadIds.length) changed = true;
    const characterOutstanding = Object.values(runtime.actors || {}).some((actor) => (
      (actor?.disclosureThreads || []).some((thread) => (
        thread.topicId === topic.id && thread.status === 'open'
      ))
    ));
    return { ...topic, relatedPsychThreadIds, characterOutstanding };
  });
  if (removedTopicIds.has(runtime.topicRuntime.activeTopicId)) {
    runtime.topicRuntime.activeTopicId = '';
  }
  return changed;
}

/**
 * Rewind one AI round. A whole snapshot restore is used only when no later psychological write
 * exists; otherwise round-owned entities are removed surgically so later valid work survives.
 */
export async function rewindPsychologicalContinuityForAiRound(scope, aiRoundId, options = {}) {
  const normalizedScope = requireScope(scope);
  const roundId = cleanId(aiRoundId);
  if (!roundId) return { rewound: false, reason: 'missing-round-id' };
  const now = timestamp(options.now, Date.now());
  return withChatUpdateQueue(normalizedScope.chatId, async () => {
    const row = await get(psychologicalContinuityKey(normalizedScope.chatId)).catch(() => null);
    const raw = row?.value && typeof row.value === 'object' ? row.value : null;
    if (!storedScopeMatches(raw, normalizedScope)) {
      return { rewound: false, reason: 'scope-mismatch' };
    }
    const storageScope = { userId: normalizedScope.userId, chatId: normalizedScope.chatId };
    const current = normalizePsychologicalContinuity(raw, storageScope);
    const index = current.roundSnapshots.findIndex((snapshot) => snapshot.aiRoundId === roundId);
    const remaining = current.roundSnapshots.filter((snapshot) => snapshot.aiRoundId !== roundId);
    const snapshot = index >= 0 ? current.roundSnapshots[index] : null;
    const canRestoreWholeSnapshot = !!(
      snapshot
      && index === 0
      && current.revision === Number(snapshot.lastRevision || snapshot.revision || 0)
    );
    const candidate = canRestoreWholeSnapshot
      ? snapshot.before
      : cloneData(current);
    if (!canRestoreWholeSnapshot) {
      const removed = removeRoundOwnedPsychologicalEntities(candidate, roundId);
      if (!removed && !snapshot) return { rewound: false, reason: 'snapshot-missing' };
    }
    const restored = normalizePsychologicalContinuity({
      ...candidate,
      revision: current.revision + 1,
      updatedAt: now,
      roundSnapshots: remaining,
    }, storageScope);
    const rollbackNonce = cleanId(options.rollbackNonce, 160);
    await put({
      key: psychologicalContinuityKey(normalizedScope.chatId),
      value: rollbackNonce
        ? { ...restored, [PSYCHOLOGICAL_CONTINUITY_ROLLBACK_NONCE_FIELD]: rollbackNonce }
        : restored,
    });
    readCache.set(normalizedScope.chatId, Promise.resolve(restored));
    return {
      rewound: true,
      mode: canRestoreWholeSnapshot ? 'snapshot' : 'surgical',
      runtime: restored,
    };
  });
}

/**
 * 重 roll 专用的批量撤销：在同一 settings 事务里读取、撤销全部目标轮并写回，
 * 同时返回已经 seal 的失败恢复 token。这样不会在 capture→逐轮 rewind→seal 之间
 * 吞掉另一标签页的合法心理更新。
 */
export async function rewindPsychologicalContinuityForAiRoundsWithRollback(
  scope,
  aiRoundIds = [],
  options = {},
) {
  const normalizedScope = requireScope(scope);
  const roundIds = uniqueStrings(Array.isArray(aiRoundIds) ? aiRoundIds : [aiRoundIds], 32, 160);
  if (!roundIds.length) return { rewound: false, reason: 'missing-round-id', rollbackToken: null };
  const now = timestamp(options.now, Date.now());
  return withChatUpdateQueue(normalizedScope.chatId, async () => {
    const key = psychologicalContinuityKey(normalizedScope.chatId);
    const storageScope = { userId: normalizedScope.userId, chatId: normalizedScope.chatId };
    let rollbackToken = null;
    let storedRuntime = null;
    let failureReason = 'runtime-missing';
    const updated = await updateRecord('settings', key, (row) => {
      const raw = row?.value && typeof row.value === 'object' ? row.value : null;
      if (!raw) return undefined;
      if (!storedScopeMatches(raw, normalizedScope)) {
        failureReason = 'scope-mismatch';
        return undefined;
      }
      const current = normalizePsychologicalContinuity(raw, storageScope);
      let working = cloneData(current);
      let changed = false;
      const modes = [];
      // UI 收集 roundIds 时通常按消息旧→新；快照撤销必须反过来从最新轮开始，
      // 否则较新的 snapshot.before 会把刚 surgical 删除的旧轮实体重新带回来。
      const snapshotRank = new Map(
        current.roundSnapshots.map((snapshot, index) => [snapshot.aiRoundId, index]),
      );
      const inputRank = new Map(roundIds.map((roundId, index) => [roundId, index]));
      const orderedRoundIds = [...roundIds].sort((left, right) => {
        const leftSnapshotRank = snapshotRank.has(left) ? snapshotRank.get(left) : Number.MAX_SAFE_INTEGER;
        const rightSnapshotRank = snapshotRank.has(right) ? snapshotRank.get(right) : Number.MAX_SAFE_INTEGER;
        return leftSnapshotRank - rightSnapshotRank
          || Number(inputRank.get(right) || 0) - Number(inputRank.get(left) || 0);
      });
      for (const roundId of orderedRoundIds) {
        const index = working.roundSnapshots.findIndex((snapshot) => snapshot.aiRoundId === roundId);
        const snapshot = index >= 0 ? working.roundSnapshots[index] : null;
        const remaining = working.roundSnapshots.filter((item) => item.aiRoundId !== roundId);
        const canRestoreWholeSnapshot = !!(
          snapshot
          && index === 0
          && Number(working.revision || 0) === Number(snapshot.lastRevision || snapshot.revision || 0)
        );
        if (canRestoreWholeSnapshot) {
          working = normalizePsychologicalContinuity({
            ...snapshot.before,
            roundSnapshots: remaining,
          }, storageScope);
          changed = true;
          modes.push({ aiRoundId: roundId, mode: 'snapshot' });
          continue;
        }
        const candidate = cloneData(working);
        const removed = removeRoundOwnedPsychologicalEntities(candidate, roundId);
        if (!removed && !snapshot) continue;
        working = normalizePsychologicalContinuity({
          ...candidate,
          roundSnapshots: remaining,
        }, storageScope);
        changed = true;
        modes.push({ aiRoundId: roundId, mode: 'surgical' });
      }
      if (!changed) {
        failureReason = 'snapshot-missing';
        return undefined;
      }
      const operationId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `psych-reroll-${now}-${Math.random().toString(36).slice(2)}`;
      storedRuntime = normalizePsychologicalContinuity({
        ...working,
        revision: Number(current.revision || 0) + 1,
        updatedAt: now,
      }, storageScope);
      rollbackToken = {
        version: 1,
        operationId,
        userId: storageScope.userId,
        chatId: storageScope.chatId,
        before: current,
        beforeRevision: Number(current.revision || 0),
        expectedRevision: Number(storedRuntime.revision || 0),
        expectedFingerprint: psychologicalContinuityFingerprint(storedRuntime, storageScope),
        expectedNonce: operationId,
        rewindCount: modes.length,
        modes,
        safe: true,
        sealed: true,
      };
      return {
        key,
        value: {
          ...storedRuntime,
          [PSYCHOLOGICAL_CONTINUITY_ROLLBACK_NONCE_FIELD]: operationId,
        },
      };
    });
    if (updated?.updated !== true || !storedRuntime || !rollbackToken) {
      return { rewound: false, reason: failureReason, rollbackToken: null };
    }
    readCache.set(normalizedScope.chatId, Promise.resolve(storedRuntime));
    return {
      rewound: true,
      reason: 'rewound',
      runtime: storedRuntime,
      rollbackToken,
    };
  });
}

/** Remove the exact chat-scoped row. Intended for chat deletion/history reset hooks. */
export async function clearPsychologicalContinuityForChat(chatId) {
  const id = cleanId(chatId);
  if (!id) return false;
  return withChatUpdateQueue(id, async () => {
    readCache.delete(id);
    await remove(psychologicalContinuityKey(id)).catch(() => {});
    return true;
  });
}

/** Clear one actor without allowing old round snapshots to resurrect the removed private state. */
export async function clearPsychologicalContinuityForCharacter(scope, characterId, options = {}) {
  const normalizedScope = requireScope(scope);
  const actorId = requireCharacterId(characterId, normalizedScope);
  const now = timestamp(options.now, Date.now());
  return updatePsychologicalContinuity(scope, (runtime) => {
    const actor = runtime.actors?.[actorId];
    if (!actor) return;
    const disclosureIds = new Set((actor.disclosureThreads || []).map((thread) => thread.id));
    delete runtime.actors[actorId];
    const remainingActors = Object.values(runtime.actors);
    runtime.topicRuntime.threads = runtime.topicRuntime.threads.flatMap((thread) => {
      const removedActorRef = thread.relatedPsychThreadIds.some((id) => disclosureIds.has(id));
      const relatedPsychThreadIds = thread.relatedPsychThreadIds.filter((id) => !disclosureIds.has(id));
      const referencedByAnotherActor = remainingActors.some((otherActor) => (
        (otherActor?.disclosureThreads || []).some((item) => item.topicId === thread.id)
        || (otherActor?.episodes || []).some((episode) => (
          episode.targetType === 'topic' && episode.targetId === thread.id
        ))
      ));
      // legacy intent 会为角色私有线头创建同名 topic。清掉角色后，这种既没有
      // 用户待办、也没有其他角色引用的孤儿 topic 不能继续成为别人的 active topic。
      if (
        removedActorRef
        && relatedPsychThreadIds.length === 0
        && thread.userOutstanding !== true
        && !referencedByAnotherActor
      ) {
        return [];
      }
      return [{
        ...thread,
        relatedPsychThreadIds,
        characterOutstanding: remainingActors.some((otherActor) => (
          (otherActor?.disclosureThreads || []).some((item) => item.topicId === thread.id && item.status === 'open')
        )),
        lastTouchedAt: removedActorRef ? now : thread.lastTouchedAt,
      }];
    });
    if (!runtime.topicRuntime.threads.some((thread) => (
      thread.id === runtime.topicRuntime.activeTopicId && thread.status === 'active'
    ))) {
      runtime.topicRuntime.activeTopicId = '';
    }
    // A user-initiated destructive clear is a new baseline. Keeping snapshots would allow a later
    // message reroll to restore the actor that the user explicitly removed.
    runtime.roundSnapshots = [];
  }, { ...options, now, aiRoundId: '' });
}
