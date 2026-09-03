import {
  get,
  onStoreWrite,
  put,
  updateRecord,
} from './db.js';
import { listChatsForUser, listMessagesForChat } from './chat-store.js';
import { listActiveOfflineSessionsForChats } from './offline-session-store.js';
import { canPhoneCharacterIdsKnowEachOther } from './phone-social-eligibility.js';
import { getChatBlockedState, loadChatPrefs } from './chat-block-state.js';
import { listCharacterAliasAccountsForUser } from './alias-account-store.js';
import { isStrangerInterceptChat } from './stranger-thread-model.js';

export const ENSEMBLE_MODE_VERSION = 4;
export const ENSEMBLE_MODE_LABEL = '群像模式';

const MAX_EVENT_NODES = 16;
const MAX_THREADS_PER_NODE = 24;
const MAX_RESOURCES = 48;
const MAX_SITUATIONS = 32;
const MAX_SITUATION_RESERVATIONS = 32;
const MAX_RELATIONSHIP_STATES = 96;
const MAX_ROUND_EFFECTS = 48;
const RESOURCE_TTL_MS = 21 * 24 * 60 * 60 * 1000;
const EVENT_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const RESOLVED_SITUATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESOURCE_CLAIM_TIMEOUT_MS = 30 * 60 * 1000;
const SITUATION_RESERVATION_TTL_MS = 5 * 60 * 1000;
const RELATIONSHIP_EVIDENCE_LIMIT = 8;
const RELATIONSHIP_MOMENTUM_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const ensembleGraphMutationTails = new Map();
const ensembleModeConfigCache = new Map();
const ensembleModeConfigInFlight = new Map();
let ensembleModeConfigRevision = 0;

function clean(value = '', max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function cleanMultiline(value = '', max = 0) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return max > 0 ? text.slice(0, max) : text;
}

function uniqueIds(values = [], max = 40) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => clean(value, 240))
    .filter((value) => value && value !== 'system'))].slice(0, max);
}

function modeKey(userId = '') {
  return `ensembleMode_${clean(userId, 120) || 'guest'}`;
}

function graphKey(userId = '') {
  return `ensembleEventGraph_${clean(userId, 120) || 'guest'}`;
}

onStoreWrite('settings', (key) => {
  const normalizedKey = String(key || '');
  if (!normalizedKey) {
    ensembleModeConfigRevision += 1;
    ensembleModeConfigCache.clear();
    ensembleModeConfigInFlight.clear();
    return;
  }
  if (!normalizedKey.startsWith('ensembleMode_')) return;
  ensembleModeConfigRevision += 1;
  ensembleModeConfigCache.delete(normalizedKey);
  ensembleModeConfigInFlight.delete(normalizedKey);
});

function makeId(prefix = 'ens') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeEnsembleModeConfig(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    version: ENSEMBLE_MODE_VERSION,
    enabled: value.enabled === true,
    noticeSeenAt: Math.max(0, Number(value.noticeSeenAt || 0) || 0),
    enabledAt: Math.max(0, Number(value.enabledAt || 0) || 0),
    currentBackground: cleanMultiline(value.currentBackground, 2400),
    backgroundUpdatedAt: Math.max(0, Number(value.backgroundUpdatedAt || 0) || 0),
    updatedAt: Math.max(0, Number(value.updatedAt || 0) || 0),
  };
}

export async function loadEnsembleModeConfig(userId = '') {
  const key = modeKey(userId);
  if (ensembleModeConfigCache.has(key)) return ensembleModeConfigCache.get(key);
  if (ensembleModeConfigInFlight.has(key)) return ensembleModeConfigInFlight.get(key);
  const pending = (async () => {
    let value;
    let observedRevision;
    do {
      observedRevision = ensembleModeConfigRevision;
      const row = await get(key).catch(() => null);
      value = normalizeEnsembleModeConfig(row?.value);
    } while (observedRevision !== ensembleModeConfigRevision);
    ensembleModeConfigCache.set(key, value);
    return value;
  })()
    .finally(() => {
      if (ensembleModeConfigInFlight.get(key) === pending) ensembleModeConfigInFlight.delete(key);
    });
  ensembleModeConfigInFlight.set(key, pending);
  return pending;
}

export async function saveEnsembleModeConfig(userId = '', patch = {}) {
  const uid = clean(userId, 120);
  if (!uid) return normalizeEnsembleModeConfig();
  const previous = await loadEnsembleModeConfig(uid);
  const now = Date.now();
  const next = normalizeEnsembleModeConfig({
    ...previous,
    ...patch,
    enabledAt: patch.enabled === true && !previous.enabled
      ? now
      : (patch.enabled === false ? previous.enabledAt : previous.enabledAt),
    updatedAt: now,
  });
  await put({ key: modeKey(uid), value: next });
  return next;
}

export async function setEnsembleModeEnabled(userId = '', enabled = false, options = {}) {
  return saveEnsembleModeConfig(userId, {
    enabled: enabled === true,
    ...(options.noticeSeen === true ? { noticeSeenAt: Date.now() } : {}),
  });
}

export async function saveEnsembleCurrentBackground(userId = '', value = '') {
  return saveEnsembleModeConfig(userId, {
    currentBackground: cleanMultiline(value, 2400),
    backgroundUpdatedAt: Date.now(),
  });
}

export function buildEnsembleDirectorBlock(config = {}) {
  const normalized = normalizeEnsembleModeConfig(config);
  if (!normalized.enabled || !normalized.currentBackground) return '';
  return [
    '【用户设定 · 群像当前背景｜高优先级剧情指导】',
    normalized.currentBackground,
    '执行优先级：这是用户对当前事件背景、已发生进度与后续推进方向的明确设定。涉及剧情状态和推进目标时，以本段为准；若自动事件图、旧聊天摘要或旧状态与它冲突，以本段更新后的背景为准。',
    '本段描述的是世界层真值，不等于每个角色都知道全文。人物只能说出自己亲历、亲眼看见或被实际告知的部分；具体会如何理解、回应和行动，仍须服从人物设定、世界书、真实关系与知情边界。',
    '本段不能凭空建立认识关系，也不能让同一实体同时出现在两个地点。',
  ].join('\n');
}

function normalizeThread(raw = {}) {
  const createdAt = Math.max(0, Number(raw.createdAt || 0) || Date.now());
  return {
    id: clean(raw.id, 120) || makeId('ens_thread'),
    kind: clean(raw.kind, 32) || 'chat',
    chatId: clean(raw.chatId, 120),
    parentThreadId: clean(raw.parentThreadId, 120),
    actorIds: uniqueIds(raw.actorIds),
    knownBy: uniqueIds(raw.knownBy),
    summary: clean(raw.summary, 420),
    sourceRoundId: clean(raw.sourceRoundId, 120),
    status: ['active', 'paused', 'resolved'].includes(raw.status) ? raw.status : 'active',
    createdAt,
    updatedAt: Math.max(createdAt, Number(raw.updatedAt || 0) || createdAt),
  };
}

function normalizeNode(raw = {}) {
  const createdAt = Math.max(0, Number(raw.createdAt || 0) || Date.now());
  return {
    id: clean(raw.id, 120) || makeId('ens_event'),
    rootChatId: clean(raw.rootChatId, 120),
    kind: clean(raw.kind, 32) || 'conversation',
    title: clean(raw.title, 80),
    summary: clean(raw.summary, 520),
    actorIds: uniqueIds(raw.actorIds),
    chatIds: uniqueIds(raw.chatIds),
    status: ['active', 'paused', 'resolved'].includes(raw.status) ? raw.status : 'active',
    createdAt,
    updatedAt: Math.max(createdAt, Number(raw.updatedAt || 0) || createdAt),
    threads: (Array.isArray(raw.threads) ? raw.threads : [])
      .map(normalizeThread)
      .slice(-MAX_THREADS_PER_NODE),
  };
}

function normalizeResource(raw = {}, now = Date.now()) {
  const createdAt = Math.max(0, Number(raw.createdAt || 0) || Date.now());
  const claimedAt = Math.max(0, Number(raw.claimedAt || 0) || 0);
  const incomingStatus = ['queued', 'claimed', 'published', 'discarded'].includes(raw.status)
    ? raw.status
    : 'queued';
  const status = incomingStatus === 'claimed'
    && claimedAt > 0
    && now - claimedAt > RESOURCE_CLAIM_TIMEOUT_MS
    ? 'queued'
    : incomingStatus;
  return {
    id: clean(raw.id, 120) || makeId('ens_resource'),
    eventId: clean(raw.eventId, 120),
    threadId: clean(raw.threadId, 120),
    target: ['moments', 'weibo', 'forum'].includes(clean(raw.target).toLowerCase())
      ? clean(raw.target).toLowerCase()
      : 'moments',
    authorId: clean(raw.authorId, 240),
    brief: clean(raw.brief, 360),
    sourceChatId: clean(raw.sourceChatId, 120),
    sourceRoundId: clean(raw.sourceRoundId, 120),
    consumedByRoundId: clean(raw.consumedByRoundId, 120),
    status,
    createdAt,
    updatedAt: Math.max(createdAt, Number(raw.updatedAt || 0) || createdAt),
    claimedAt: status === 'queued' ? 0 : claimedAt,
    publishedAt: Math.max(0, Number(raw.publishedAt || 0) || 0),
  };
}

function normalizeIdentityState(raw = {}) {
  return {
    actorId: clean(raw.actorId, 240),
    aliasState: clean(raw.aliasState, 32),
    strangerState: clean(raw.strangerState, 32),
    chatId: clean(raw.chatId, 120),
    accountId: clean(raw.accountId, 160),
    reason: clean(raw.reason, 180),
    sourceRoundId: clean(raw.sourceRoundId, 120),
    updatedAt: Math.max(0, Number(raw.updatedAt || 0) || 0),
  };
}

function normalizeSituation(raw = {}, now = Date.now()) {
  const createdAt = Math.max(0, Number(raw.createdAt || raw.updatedAt || 0) || now);
  const updatedAt = Math.max(createdAt, Number(raw.updatedAt || 0) || createdAt);
  const expiresAt = Math.max(0, Number(raw.expiresAt || 0) || (updatedAt + (3 * 60 * 60 * 1000)));
  const requestedStatus = ['active', 'resolved'].includes(raw.status) ? raw.status : 'active';
  return {
    id: clean(raw.id, 120) || makeId('ens_situation'),
    actorIds: uniqueIds(raw.actorIds, 16),
    knownBy: uniqueIds(raw.knownBy, 24),
    place: clean(raw.place, 120),
    activity: clean(raw.activity, 180),
    visibility: ['participants', 'chat', 'known'].includes(clean(raw.visibility, 20))
      ? clean(raw.visibility, 20)
      : 'participants',
    privacy: ['private', 'shared', 'public'].includes(clean(raw.privacy, 20))
      ? clean(raw.privacy, 20)
      : 'private',
    physical: raw.physical !== false,
    communication: ['available', 'limited', 'unavailable'].includes(clean(raw.communication, 20))
      ? clean(raw.communication, 20)
      : 'limited',
    source: clean(raw.source, 32) || 'chat_state',
    sourceChatId: clean(raw.sourceChatId, 120),
    sourceRoundId: clean(raw.sourceRoundId, 120),
    status: requestedStatus === 'active' && expiresAt <= now ? 'resolved' : requestedStatus,
    createdAt,
    updatedAt,
    expiresAt,
  };
}

function normalizeSituationReservation(raw = {}, now = Date.now()) {
  const createdAt = Math.max(0, Number(raw.createdAt || 0) || now);
  const expiresAt = Math.max(createdAt, Number(raw.expiresAt || 0) || (createdAt + SITUATION_RESERVATION_TTL_MS));
  return {
    id: clean(raw.id, 120) || makeId('ens_reservation'),
    actorIds: uniqueIds(raw.actorIds, 16),
    knownBy: uniqueIds(raw.knownBy, 24),
    place: clean(raw.place, 120),
    activity: clean(raw.activity, 180),
    source: 'user_provisional',
    sourceChatId: clean(raw.sourceChatId, 120),
    sourceRoundId: clean(raw.sourceRoundId, 120),
    sourceMessageId: clean(raw.sourceMessageId, 120),
    status: expiresAt > now ? 'active' : 'resolved',
    visibility: 'participants',
    privacy: 'private',
    physical: true,
    communication: 'limited',
    provisional: true,
    createdAt,
    updatedAt: Math.max(createdAt, Number(raw.updatedAt || 0) || createdAt),
    expiresAt,
  };
}

function relationshipStateId(fromId = '', toId = '') {
  return `${clean(fromId, 240)}→${clean(toId, 240)}`;
}

function clampRelationScore(value = 0) {
  return Math.max(-100, Math.min(100, Math.round(Number(value) || 0)));
}

function decayedRelationshipScore(value = 0, updatedAt = 0, now = Date.now()) {
  const age = Math.max(0, Number(now || 0) - Number(updatedAt || 0));
  if (!age || !updatedAt) return clampRelationScore(value);
  const factor = 0.5 ** (age / RELATIONSHIP_MOMENTUM_HALF_LIFE_MS);
  return clampRelationScore(Number(value || 0) * factor);
}

function normalizeRelationshipEvidence(raw = {}) {
  return {
    summary: clean(raw.summary || raw.reason, 240),
    sourceChatId: clean(raw.sourceChatId, 120),
    sourceRoundId: clean(raw.sourceRoundId, 120),
    knownBy: uniqueIds(raw.knownBy, 24),
    at: Math.max(0, Number(raw.at || raw.timestamp || 0) || Date.now()),
  };
}

function normalizeRelationshipState(raw = {}) {
  const fromId = clean(raw.fromId || raw.from, 240);
  const toId = clean(raw.toId || raw.to, 240);
  return {
    id: relationshipStateId(fromId, toId),
    fromId,
    toId,
    warmth: clampRelationScore(raw.warmth),
    trust: clampRelationScore(raw.trust),
    tension: clampRelationScore(raw.tension),
    stance: clean(raw.stance, 280),
    knownBy: uniqueIds(raw.knownBy?.length ? raw.knownBy : [fromId], 24),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map(normalizeRelationshipEvidence)
      .filter((item) => item.summary)
      .slice(-RELATIONSHIP_EVIDENCE_LIMIT),
    sourceRoundId: clean(raw.sourceRoundId, 120),
    updatedAt: Math.max(0, Number(raw.updatedAt || 0) || 0),
  };
}

function normalizeRoundEffect(raw = {}, now = Date.now()) {
  const aiRoundId = clean(raw.aiRoundId, 120);
  const recordedAt = Math.max(0, Number(raw.recordedAt || 0) || now);
  const beforeNode = raw.beforeNode && typeof raw.beforeNode === 'object'
    ? normalizeNode(raw.beforeNode)
    : null;
  const resourceBefore = (Array.isArray(raw.resourceBefore) ? raw.resourceBefore : [])
    .map((item) => normalizeResource(item, now))
    .filter((item) => item.id);
  const identityBefore = (Array.isArray(raw.identityBefore) ? raw.identityBefore : [])
    .map((item) => ({
      actorId: clean(item?.actorId, 240),
      before: item?.before && typeof item.before === 'object'
        ? normalizeIdentityState(item.before)
        : null,
    }))
    .filter((item) => item.actorId);
  const situationBefore = (Array.isArray(raw.situationBefore) ? raw.situationBefore : [])
    .map((item) => normalizeSituation(item, now))
    .filter((item) => item.id);
  const relationshipBefore = (Array.isArray(raw.relationshipBefore) ? raw.relationshipBefore : [])
    .map((item) => ({
      id: clean(item?.id, 500),
      before: item?.before && typeof item.before === 'object'
        ? normalizeRelationshipState(item.before)
        : null,
    }))
    .filter((item) => item.id);
  return {
    aiRoundId,
    chatId: clean(raw.chatId, 120),
    nodeId: clean(raw.nodeId, 120),
    beforeNode,
    createdResourceIds: uniqueIds(raw.createdResourceIds, MAX_RESOURCES),
    resourceBefore,
    identityBefore,
    createdSituationIds: uniqueIds(raw.createdSituationIds, MAX_SITUATIONS),
    situationBefore,
    relationshipBefore,
    recordedAt,
  };
}

export function normalizeEnsembleGraph(raw = {}, userId = '', now = Date.now()) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const nodes = (Array.isArray(value.nodes) ? value.nodes : [])
    .map(normalizeNode)
    .filter((node) => node.rootChatId || node.chatIds.length)
    .filter((node) => node.status !== 'resolved' || now - node.updatedAt <= EVENT_IDLE_TTL_MS)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(-MAX_EVENT_NODES);
  const resources = (Array.isArray(value.resources) ? value.resources : [])
    .map((item) => normalizeResource(item, now))
    .filter((item) => item.status === 'published' || now - item.updatedAt <= RESOURCE_TTL_MS)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(-MAX_RESOURCES);
  const identityStates = Object.fromEntries(
    Object.entries(value.identityStates && typeof value.identityStates === 'object'
      ? value.identityStates
      : {})
      .map(([key, state]) => [clean(key, 240), normalizeIdentityState({ ...state, actorId: state?.actorId || key })])
      .filter(([key, state]) => key && state.actorId),
  );
  const situations = (Array.isArray(value.situations) ? value.situations : [])
    .map((item) => normalizeSituation(item, now))
    .filter((item) => item.actorIds.length >= 2)
    .filter((item) => item.status === 'active' || now - item.updatedAt <= RESOLVED_SITUATION_TTL_MS)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(-MAX_SITUATIONS);
  const situationReservations = (Array.isArray(value.situationReservations) ? value.situationReservations : [])
    .map((item) => normalizeSituationReservation(item, now))
    .filter((item) => item.status === 'active' && item.actorIds.length >= 2)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(-MAX_SITUATION_RESERVATIONS);
  const relationshipStates = Object.fromEntries(
    Object.values(value.relationshipStates && typeof value.relationshipStates === 'object'
      ? value.relationshipStates
      : {})
      .map(normalizeRelationshipState)
      .filter((item) => item.fromId && item.toId && item.fromId !== item.toId)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(-MAX_RELATIONSHIP_STATES)
      .map((item) => [item.id, item]),
  );
  const roundEffects = (Array.isArray(value.roundEffects) ? value.roundEffects : [])
    .map((item) => normalizeRoundEffect(item, now))
    .filter((item) => item.aiRoundId)
    .sort((a, b) => a.recordedAt - b.recordedAt)
    .slice(-MAX_ROUND_EFFECTS);
  return {
    version: ENSEMBLE_MODE_VERSION,
    userId: clean(userId || value.userId, 120),
    nodes,
    resources,
    identityStates,
    situations,
    situationReservations,
    relationshipStates,
    roundEffects,
    updatedAt: Math.max(0, Number(value.updatedAt || 0) || 0),
  };
}

export async function loadEnsembleGraph(userId = '') {
  const uid = clean(userId, 120);
  const row = await get(graphKey(uid)).catch(() => null);
  return normalizeEnsembleGraph(row?.value, uid);
}

export async function saveEnsembleGraph(userId = '', graph = {}) {
  const uid = clean(userId, 120);
  if (!uid) return normalizeEnsembleGraph({}, '');
  const next = normalizeEnsembleGraph({ ...graph, updatedAt: Date.now() }, uid);
  await put({ key: graphKey(uid), value: next });
  return next;
}

async function withEnsembleGraphMutation(userId = '', task) {
  const uid = clean(userId, 120);
  if (!uid || typeof task !== 'function') return null;
  const previous = ensembleGraphMutationTails.get(uid) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => task());
  const tail = run.then(() => undefined, () => undefined);
  ensembleGraphMutationTails.set(uid, tail);
  try {
    return await run;
  } finally {
    if (ensembleGraphMutationTails.get(uid) === tail) ensembleGraphMutationTails.delete(uid);
  }
}

function latestUserMessage(messages = []) {
  return [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message && !message.deleted && !message.recalled && message.senderId === 'user') || null;
}

export function inferProvisionalSituationFromUserMessage({ chat = null, messages = [] } = {}) {
  if (!chat?.id || chat.type === 'group' || !(chat.participants || []).includes('user')) return null;
  const characterId = (chat.participants || []).find((id) => id && id !== 'user');
  const message = latestUserMessage(messages);
  const text = clean(message?.content || message?.metadata?.text, 600);
  if (!characterId || !text) return null;
  // 只抢占已经明确发生的身体动作；愿望、询问、计划、假设和转述不能建立现实。
  if (/(?:想|打算|计划|待会|等会|以后|如果|假如|要不要|能不能|可以吗|梦见|听说|据说).{0,12}(?:亲|吻|抱|牵|搂|靠|贴|拉|推倒|坐到|躺到)/u.test(text)) return null;
  const action = text.match(/(?:亲(?:了|上|住|着)|吻(?:了|上|住|着)|抱(?:住|紧|着)|拥抱(?:了|着)|牵(?:住|起|着)|搂(?:住|紧|着)|拉(?:住|进|到)|推倒|贴(?:上|近|着)|靠(?:上|在|近)|坐到.{0,12}旁边|躺到.{0,12}旁边)/u);
  if (!action) return null;
  const placeMatch = text.match(/(?:在|进(?:了)?|到(?:了)?)([^，。！？\n]{1,20}?)(?:里|内|中|门口|旁边|床上|沙发上)/u);
  return {
    actorIds: ['user', characterId],
    knownBy: ['user', characterId],
    place: clean(placeMatch?.[1], 80),
    activity: clean(text, 120),
    sourceChatId: clean(chat.id, 120),
    sourceMessageId: clean(message?.id, 120),
  };
}

export async function reserveEnsembleSituationFromUserMessage({
  userId = '',
  chat = null,
  messages = [],
  aiRoundId = '',
} = {}) {
  const uid = clean(userId, 120);
  if (!uid) return null;
  const config = await loadEnsembleModeConfig(uid).catch(() => ({ enabled: false }));
  if (!config.enabled) return null;
  const inferred = inferProvisionalSituationFromUserMessage({ chat, messages });
  if (!inferred) return null;
  return withEnsembleGraphMutation(uid, async () => {
    const now = Date.now();
    const [graph, offlineLocks] = await Promise.all([
      loadEnsembleGraph(uid),
      currentPhysicalLocks(uid),
    ]);
    const conflicts = [
      ...graph.situations,
      ...graph.situationReservations,
      ...offlineLocks,
    ].filter((item) => item.status === 'active' && (!item.expiresAt || item.expiresAt > now))
      .filter((item) => clean(item.sourceChatId, 120) !== clean(chat.id, 120))
      .filter((item) => item.actorIds.some((id) => inferred.actorIds.includes(id)));
    if (conflicts.length) return { ok: false, reason: 'physical-conflict', conflict: conflicts[0] };
    const existing = graph.situationReservations.find((item) => (
      item.sourceChatId === inferred.sourceChatId
      && sameActorSet(item.actorIds, inferred.actorIds)
    ));
    const reservation = normalizeSituationReservation({
      ...(existing || {}),
      ...inferred,
      id: existing?.id,
      sourceRoundId: aiRoundId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      expiresAt: now + SITUATION_RESERVATION_TTL_MS,
    }, now);
    graph.situationReservations = [
      ...graph.situationReservations.filter((item) => item.id !== reservation.id),
      reservation,
    ].slice(-MAX_SITUATION_RESERVATIONS);
    await saveEnsembleGraph(uid, graph);
    return { ok: true, reservation };
  });
}

function cloneGraphValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameGraphValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function captureRoundEffect(beforeGraph, afterGraph, {
  aiRoundId = '',
  chatId = '',
  nodeId = '',
  recordedAt = Date.now(),
} = {}) {
  const roundId = clean(aiRoundId, 120);
  if (!roundId) return null;
  const beforeResources = new Map(beforeGraph.resources.map((item) => [item.id, item]));
  const beforeSituations = new Map(beforeGraph.situations.map((item) => [item.id, item]));
  const beforeIdentities = beforeGraph.identityStates || {};
  const beforeRelationships = beforeGraph.relationshipStates || {};
  return normalizeRoundEffect({
    aiRoundId: roundId,
    chatId,
    nodeId,
    beforeNode: beforeGraph.nodes.find((item) => item.id === nodeId) || null,
    createdResourceIds: afterGraph.resources
      .filter((item) => !beforeResources.has(item.id))
      .map((item) => item.id),
    resourceBefore: afterGraph.resources
      .filter((item) => beforeResources.has(item.id) && !sameGraphValue(beforeResources.get(item.id), item))
      .map((item) => beforeResources.get(item.id)),
    identityBefore: [...new Set([
      ...Object.keys(beforeIdentities),
      ...Object.keys(afterGraph.identityStates || {}),
    ])]
      .filter((actorId) => !sameGraphValue(beforeIdentities[actorId], afterGraph.identityStates?.[actorId]))
      .map((actorId) => ({
        actorId,
        before: beforeIdentities[actorId] || null,
      })),
    createdSituationIds: afterGraph.situations
      .filter((item) => !beforeSituations.has(item.id))
      .map((item) => item.id),
    situationBefore: afterGraph.situations
      .filter((item) => beforeSituations.has(item.id) && !sameGraphValue(beforeSituations.get(item.id), item))
      .map((item) => beforeSituations.get(item.id)),
    relationshipBefore: [...new Set([
      ...Object.keys(beforeRelationships),
      ...Object.keys(afterGraph.relationshipStates || {}),
    ])]
      .filter((id) => !sameGraphValue(beforeRelationships[id], afterGraph.relationshipStates?.[id]))
      .map((id) => ({ id, before: beforeRelationships[id] || null })),
    recordedAt,
  }, recordedAt);
}

function replaceById(list = [], restored = [], createdIds = []) {
  const created = new Set(uniqueIds(createdIds, 200));
  const restoreMap = new Map(restored.map((item) => [item.id, item]));
  const next = list
    .filter((item) => !created.has(item.id))
    .map((item) => restoreMap.has(item.id) ? restoreMap.get(item.id) : item);
  const present = new Set(next.map((item) => item.id));
  for (const item of restored) {
    if (!present.has(item.id)) next.push(item);
  }
  return next;
}

function rollbackRecordedRoundEffect(graph, effect) {
  if (effect.nodeId) {
    const index = graph.nodes.findIndex((item) => item.id === effect.nodeId);
    if (effect.beforeNode) {
      if (index >= 0) graph.nodes[index] = effect.beforeNode;
      else graph.nodes.push(effect.beforeNode);
    } else if (index >= 0) {
      graph.nodes.splice(index, 1);
    }
  }
  graph.resources = replaceById(
    graph.resources,
    effect.resourceBefore,
    effect.createdResourceIds,
  );
  graph.situations = replaceById(
    graph.situations,
    effect.situationBefore,
    effect.createdSituationIds,
  );
  for (const item of effect.relationshipBefore || []) {
    if (item.before) graph.relationshipStates[item.id] = item.before;
    else delete graph.relationshipStates[item.id];
  }
  for (const item of effect.identityBefore) {
    if (item.before) graph.identityStates[item.actorId] = item.before;
    else delete graph.identityStates[item.actorId];
  }
}

function rollbackLegacyRoundEffects(graph, roundIds = []) {
  const roots = new Set(uniqueIds(roundIds, 100));
  if (!roots.size) return;
  graph.nodes = graph.nodes.flatMap((node) => {
    if (!node.threads.some((thread) => roots.has(thread.sourceRoundId))) return [node];
    const threads = node.threads.filter((thread) => !roots.has(thread.sourceRoundId));
    if (!threads.length) return [];
    const newest = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return [normalizeNode({
      ...node,
      actorIds: uniqueIds(threads.flatMap((thread) => thread.actorIds)),
      chatIds: uniqueIds(threads.map((thread) => thread.chatId).filter(Boolean)),
      summary: newest?.summary || '',
      threads,
      updatedAt: newest?.updatedAt || node.updatedAt,
    })];
  });
  graph.resources = graph.resources
    .filter((item) => !roots.has(item.sourceRoundId))
    .map((item) => roots.has(item.consumedByRoundId)
      ? normalizeResource({
        ...item,
        status: 'queued',
        consumedByRoundId: '',
        claimedAt: 0,
        publishedAt: 0,
        updatedAt: item.createdAt,
      })
      : item);
  graph.situations = graph.situations.filter((item) => !roots.has(item.sourceRoundId));
  for (const [id, state] of Object.entries(graph.relationshipStates || {})) {
    if (roots.has(state.sourceRoundId)) delete graph.relationshipStates[id];
  }
  for (const [actorId, state] of Object.entries(graph.identityStates)) {
    if (roots.has(state.sourceRoundId)) delete graph.identityStates[actorId];
  }
}

export function rollbackEnsembleGraphForRounds(rawGraph = {}, aiRoundIds = [], now = Date.now()) {
  const roots = new Set(uniqueIds(Array.isArray(aiRoundIds) ? aiRoundIds : [aiRoundIds], 100));
  const graph = normalizeEnsembleGraph(rawGraph, rawGraph?.userId, now);
  if (!roots.size) return { graph, rolledBack: 0 };
  const matched = graph.roundEffects
    .filter((effect) => roots.has(effect.aiRoundId))
    .sort((a, b) => b.recordedAt - a.recordedAt);
  for (const effect of matched) rollbackRecordedRoundEffect(graph, effect);
  const matchedIds = new Set(matched.map((effect) => effect.aiRoundId));
  const legacyIds = [...roots].filter((roundId) => !matchedIds.has(roundId));
  rollbackLegacyRoundEffects(graph, legacyIds);
  graph.roundEffects = graph.roundEffects.filter((effect) => !roots.has(effect.aiRoundId));
  graph.updatedAt = now;
  return { graph, rolledBack: matched.length + legacyIds.length };
}

export async function rollbackEnsembleRounds(userId = '', aiRoundIds = []) {
  const uid = clean(userId, 120);
  const roots = uniqueIds(Array.isArray(aiRoundIds) ? aiRoundIds : [aiRoundIds], 100);
  if (!uid || !roots.length) return { backup: null, rolledBack: 0 };
  return withEnsembleGraphMutation(uid, async () => {
    const current = await loadEnsembleGraph(uid);
    const beforeGraph = cloneGraphValue(current);
    const result = rollbackEnsembleGraphForRounds(current, roots);
    const storedGraph = await saveEnsembleGraph(uid, result.graph);
    return {
      backup: {
        version: 2,
        beforeGraph,
        expectedGraph: cloneGraphValue(storedGraph),
      },
      rolledBack: result.rolledBack,
    };
  });
}

export async function restoreEnsembleGraphSnapshot(userId = '', snapshot = null) {
  const uid = clean(userId, 120);
  if (!uid || !snapshot || typeof snapshot !== 'object') return null;
  // 旧的裸快照没有“撤销后应处于什么状态”的 CAS 依据；失败恢复时宁可保留
  // 当前世界图，也不能用旧整图覆盖另一窗口刚完成的清理或剧情推进。
  if (
    snapshot.version !== 2
    || !snapshot.beforeGraph
    || !snapshot.expectedGraph
  ) return { restored: false, reason: 'unguarded-legacy-snapshot' };
  return withEnsembleGraphMutation(uid, async () => {
    let reason = 'graph-conflict';
    const key = graphKey(uid);
    const outcome = await updateRecord('settings', key, (row) => {
      const current = normalizeEnsembleGraph(row?.value, uid);
      const expected = normalizeEnsembleGraph(snapshot.expectedGraph, uid);
      if (!sameGraphValue(current, expected)) return undefined;
      reason = 'restored';
      return {
        key,
        value: normalizeEnsembleGraph({
          ...snapshot.beforeGraph,
          updatedAt: Date.now(),
        }, uid),
      };
    });
    return {
      restored: outcome?.updated === true,
      reason: outcome?.updated === true ? 'restored' : reason,
      graph: outcome?.updated === true ? outcome.record?.value : null,
    };
  });
}

export function pruneEnsembleGraphForCharacter(
  rawGraph = {},
  characterId = '',
  deletedChatIds = [],
  now = Date.now(),
) {
  const cid = clean(characterId, 240);
  const graph = normalizeEnsembleGraph(rawGraph, rawGraph?.userId, now);
  if (!cid) {
    return {
      graph,
      nodesRemoved: 0,
      threadsRemoved: 0,
      resourcesRemoved: 0,
      situationsRemoved: 0,
      relationshipStatesRemoved: 0,
      identityStatesRemoved: 0,
    };
  }
  const chatIds = new Set(uniqueIds(deletedChatIds, 120));
  const affectedNodeIds = new Set();
  const removedThreadIds = new Set();
  let threadsRemoved = 0;
  const nodes = [];
  for (const node of graph.nodes) {
    const nodeContentWasRelated = node.actorIds.includes(cid)
      || chatIds.has(node.rootChatId)
      || node.chatIds.some((id) => chatIds.has(id))
      || node.threads.some((thread) => (
        thread.actorIds.includes(cid)
        || chatIds.has(thread.chatId)
      ));
    if (nodeContentWasRelated) affectedNodeIds.add(node.id);
    const threads = node.threads
      .filter((thread) => {
        const remove = thread.actorIds.includes(cid) || chatIds.has(thread.chatId);
        if (remove) {
          removedThreadIds.add(thread.id);
          threadsRemoved += 1;
        }
        return !remove;
      })
      .map((thread) => normalizeThread({
        ...thread,
        knownBy: thread.knownBy.filter((id) => id !== cid),
      }));
    if (!threads.length) continue;
    const remainingChatIds = uniqueIds(threads.map((thread) => thread.chatId).filter(Boolean));
    const newestThread = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    nodes.push(normalizeNode({
      ...node,
      rootChatId: chatIds.has(node.rootChatId)
        ? (remainingChatIds[0] || '')
        : node.rootChatId,
      actorIds: uniqueIds(threads.flatMap((thread) => thread.actorIds).filter((id) => id !== cid)),
      chatIds: remainingChatIds,
      summary: nodeContentWasRelated ? (newestThread?.summary || '') : node.summary,
      threads,
    }));
  }
  const resources = graph.resources.filter((item) => (
    item.authorId !== cid
    && !chatIds.has(item.sourceChatId)
    && !affectedNodeIds.has(item.eventId)
    && !removedThreadIds.has(item.threadId)
  ));
  const situations = graph.situations
    .filter((item) => !item.actorIds.includes(cid) && !chatIds.has(item.sourceChatId))
    .map((item) => normalizeSituation({
      ...item,
      knownBy: item.knownBy.filter((id) => id !== cid),
    }, now));
  const situationReservations = graph.situationReservations
    .filter((item) => !item.actorIds.includes(cid) && !chatIds.has(item.sourceChatId));
  const relationshipStates = Object.fromEntries(
    Object.entries(graph.relationshipStates || {})
      .filter(([, state]) => state.fromId !== cid && state.toId !== cid),
  );
  const identityStates = Object.fromEntries(
    Object.entries(graph.identityStates)
      .filter(([key, state]) => key !== cid && state.actorId !== cid),
  );
  const roundEffects = graph.roundEffects.filter((effect) => {
    if (chatIds.has(effect.chatId)) return false;
    if (effect.beforeNode?.actorIds?.includes(cid)) return false;
    if (effect.beforeNode?.chatIds?.some((id) => chatIds.has(id))) return false;
    if (effect.identityBefore.some((item) => item.actorId === cid || item.before?.actorId === cid)) return false;
    if (effect.situationBefore.some((item) => (
      item.actorIds.includes(cid) || chatIds.has(item.sourceChatId)
    ))) return false;
    if ((effect.relationshipBefore || []).some((item) => (
      item.before?.fromId === cid || item.before?.toId === cid || item.id.includes(cid)
    ))) return false;
    if (effect.resourceBefore.some((item) => (
      item.authorId === cid || chatIds.has(item.sourceChatId)
    ))) return false;
    return true;
  });
  const nextGraph = normalizeEnsembleGraph({
    ...graph,
    nodes,
    resources,
    situations,
    situationReservations,
    relationshipStates,
    identityStates,
    roundEffects,
    updatedAt: now,
  }, graph.userId, now);
  return {
    graph: nextGraph,
    nodesRemoved: graph.nodes.length - nextGraph.nodes.length,
    threadsRemoved,
    resourcesRemoved: graph.resources.length - resources.length,
    situationsRemoved: graph.situations.length - situations.length,
    relationshipStatesRemoved: Object.keys(graph.relationshipStates || {}).length - Object.keys(relationshipStates).length,
    identityStatesRemoved: Object.keys(graph.identityStates).length - Object.keys(identityStates).length,
  };
}

export async function clearEnsembleCharacterData(userId = '', characterId = '', deletedChatIds = []) {
  const uid = clean(userId, 120);
  const cid = clean(characterId, 240);
  if (!uid || !cid) return null;
  return withEnsembleGraphMutation(uid, async () => {
    const current = await loadEnsembleGraph(uid);
    const result = pruneEnsembleGraphForCharacter(current, cid, deletedChatIds);
    result.graph = await saveEnsembleGraph(uid, result.graph);
    return result;
  });
}

function messageSummary(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted && !message.recalled)
    .filter((message) => message.senderId !== 'system' && message.type !== 'system')
    .slice(-6)
    .map((message) => {
      const who = clean(message.senderName || message.senderId, 40);
      const body = clean(message.content || message.metadata?.text, 120);
      return who && body ? `${who}：${body}` : '';
    })
    .filter(Boolean)
    .join(' / ')
    .slice(0, 520);
}

/**
 * 用户删除侧窗气泡后，用仍存在的原始消息重建对应事件分支。
 * 事件图是派生缓存，不能让已经删掉的 A↔D 对话继续以“D 亲历事实”回灌单聊。
 */
export async function reconcileEnsembleChatAfterMessageDeletion(userId = '', chatId = '') {
  const uid = clean(userId, 120);
  const cid = clean(chatId, 120);
  if (!uid || !cid) return { changed: false, reason: 'missing-context' };
  return withEnsembleGraphMutation(uid, async () => {
    const [graph, remainingMessages] = await Promise.all([
      loadEnsembleGraph(uid),
      listMessagesForChat(cid, 0).catch(() => []),
    ]);
    const summary = messageSummary(remainingMessages);
    let changed = false;
    const nextNodes = [];
    for (const node of graph.nodes) {
      const matching = node.threads.filter((thread) => thread.chatId === cid);
      if (!matching.length) {
        nextNodes.push(node);
        continue;
      }
      changed = true;
      if (summary) {
        node.threads = node.threads.map((thread) => (
          thread.chatId === cid ? { ...thread, summary, updatedAt: Date.now() } : thread
        ));
      } else {
        node.threads = node.threads.filter((thread) => thread.chatId !== cid);
        node.chatIds = node.chatIds.filter((id) => id !== cid);
        if (node.rootChatId === cid) node.summary = '';
      }
      if (node.threads.length) nextNodes.push(node);
    }
    graph.nodes = nextNodes;

    if (!summary) {
      const beforeResources = graph.resources.length;
      graph.resources = graph.resources.filter((item) => item.sourceChatId !== cid);
      changed = changed || graph.resources.length !== beforeResources;
      for (const [actorId, state] of Object.entries(graph.identityStates || {})) {
        if (state?.chatId !== cid) continue;
        delete graph.identityStates[actorId];
        changed = true;
      }
      const beforeSituations = graph.situations.length;
      const beforeReservations = graph.situationReservations.length;
      graph.situations = graph.situations.filter((item) => item.sourceChatId !== cid);
      graph.situationReservations = graph.situationReservations.filter((item) => item.sourceChatId !== cid);
      changed = changed
        || graph.situations.length !== beforeSituations
        || graph.situationReservations.length !== beforeReservations;
      for (const [stateId, state] of Object.entries(graph.relationshipStates || {})) {
        const evidence = (state.evidence || []).filter((item) => item.sourceChatId !== cid);
        if (evidence.length === (state.evidence || []).length) continue;
        changed = true;
        if (!evidence.length) delete graph.relationshipStates[stateId];
        else graph.relationshipStates[stateId] = { ...state, evidence };
      }
    }
    if (!changed) return { changed: false, reason: 'not-indexed' };
    await saveEnsembleGraph(uid, graph);
    return { changed: true, summary };
  });
}

function eventActorIds(event = {}) {
  return uniqueIds([
    event.from,
    event.actor,
    event.senderId,
    event.to,
    ...(Array.isArray(event.memberIds) ? event.memberIds : []),
    ...(Array.isArray(event.invitees) ? event.invitees : []),
    ...(Array.isArray(event.with) ? event.with : []),
    ...(Array.isArray(event.lines)
      ? event.lines.map((line) => line?.from || line?.actor || line?.senderId)
      : []),
  ].filter((id) => id && id !== 'user'));
}

function eventSummary(event = {}) {
  return clean(
    event.plot
    || event.brief
    || event.intent
    || (Array.isArray(event.lines)
      ? event.lines.map((line) => line?.body || line?.text || '').filter(Boolean).join(' / ')
      : ''),
    420,
  );
}

function briefAffinity(left = '', right = '') {
  const a = [...new Set(clean(left).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))];
  const b = [...new Set(clean(right).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))];
  if (!a.length || !b.length) return 0;
  const bSet = new Set(b);
  const overlap = a.filter((char) => bSet.has(char)).length;
  return overlap / Math.max(1, Math.min(a.length, b.length));
}

function findOrCreateNode(graph, chat = {}, now = Date.now()) {
  const rootChatId = clean(chat?.metadata?.parentChatId || chat?.id, 120);
  let node = graph.nodes
    .filter((item) => item.status === 'active')
    .find((item) => item.rootChatId === rootChatId || item.chatIds.includes(clean(chat?.id, 120)));
  if (node) return node;
  node = normalizeNode({
    id: makeId('ens_event'),
    rootChatId,
    kind: chat?.type === 'group' ? 'group_conversation' : 'private_conversation',
    title: clean(chat?.groupSettings?.name, 80),
    actorIds: (chat?.participants || []).filter((id) => id !== 'user'),
    chatIds: [chat?.id],
    createdAt: now,
    updatedAt: now,
  });
  graph.nodes.push(node);
  return node;
}

function upsertThread(node, raw = {}) {
  const incoming = normalizeThread(raw);
  const key = incoming.chatId
    ? `${incoming.kind}|${incoming.chatId}`
    : `${incoming.kind}|${incoming.actorIds.slice().sort().join('|')}`;
  let thread = node.threads.find((item) => {
    const itemKey = item.chatId
      ? `${item.kind}|${item.chatId}`
      : `${item.kind}|${item.actorIds.slice().sort().join('|')}`;
    return itemKey === key;
  });
  if (!thread) {
    node.threads.push(incoming);
    return incoming;
  }
  Object.assign(thread, {
    actorIds: uniqueIds([...thread.actorIds, ...incoming.actorIds]),
    knownBy: uniqueIds([...thread.knownBy, ...incoming.knownBy]),
    summary: incoming.summary || thread.summary,
    sourceRoundId: incoming.sourceRoundId || thread.sourceRoundId,
    status: incoming.status || thread.status,
    updatedAt: Math.max(thread.updatedAt, incoming.updatedAt),
  });
  return thread;
}

function updateIdentityStates(
  graph,
  events = [],
  chatId = '',
  now = Date.now(),
  defaultActorId = '',
  aiRoundId = '',
) {
  const map = {
    open_alias: { aliasState: '已提出开号意图' },
    alias_poke: { aliasState: '尝试使用马甲号' },
    stranger_block: { strangerState: '已拉黑' },
    stranger_unblock: { strangerState: '已解除拉黑' },
    stranger_friend: { strangerState: '已通过好友' },
    stranger_suspect: { strangerState: '已产生身份怀疑' },
  };
  for (const event of events) {
    const patch = map[event?.t];
    const actorId = clean(event?.from || event?.actor || event?.senderId || defaultActorId, 240);
    if (!patch || !actorId) continue;
    graph.identityStates[actorId] = normalizeIdentityState({
      ...(graph.identityStates[actorId] || {}),
      ...patch,
      actorId,
      chatId,
      accountId: event?.accountId || event?.aliasId,
      reason: event?.reason || event?.brief || event?.intent,
      sourceRoundId: aiRoundId,
      updatedAt: now,
    });
  }
}

function characterEntries(characters = {}) {
  if (Array.isArray(characters)) {
    return characters
      .map((character) => [clean(character?.id, 240), character])
      .filter(([id]) => id);
  }
  return Object.entries(characters && typeof characters === 'object' ? characters : {});
}

function resolveSituationActorId(value = '', characters = {}) {
  const wanted = clean(value, 240);
  if (!wanted) return '';
  if (wanted === 'user') return 'user';
  const lowered = wanted.toLocaleLowerCase();
  const matched = characterEntries(characters).find(([id, character]) => (
    [id, character?.id, character?.realName, character?.name, character?.customNickname]
      .map((item) => clean(item, 240).toLocaleLowerCase())
      .filter(Boolean)
      .includes(lowered)
  ));
  return clean(matched?.[0], 240);
}

function sameActorSet(left = [], right = []) {
  const a = uniqueIds(left).sort();
  const b = uniqueIds(right).sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

async function actorsMayShareSituation(actorIds = [], userId = '') {
  const characters = uniqueIds(actorIds).filter((id) => id !== 'user');
  for (let i = 0; i < characters.length; i += 1) {
    for (let j = i + 1; j < characters.length; j += 1) {
      const allowed = await canPhoneCharacterIdsKnowEachOther(characters[i], characters[j], userId).catch(() => false);
      if (allowed !== true) return false;
    }
  }
  return true;
}

async function updateSituationFacts({
  userId = '',
  graph,
  events = [],
  chat = null,
  characters = {},
  aiRoundId = '',
  now = Date.now(),
  physicalLocks = [],
} = {}) {
  const sourceChatId = clean(chat?.id, 120);
  const chatActorIds = uniqueIds(chat?.participants || [], 20);
  let changed = false;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.t !== 'situation') continue;
    const actorId = resolveSituationActorId(event.from || event.actor || event.senderId, characters);
    if (!actorId) continue;
    const companionIds = uniqueIds(event.with || [], 16)
      .map((id) => resolveSituationActorId(id, characters))
      .filter(Boolean);
    const requestedActors = uniqueIds([actorId, ...companionIds], 16);
    if (event.action === 'clear') {
      for (const situation of graph.situations) {
        if (situation.status !== 'active' || !situation.actorIds.includes(actorId)) continue;
        if (companionIds.length && !companionIds.every((id) => situation.actorIds.includes(id))) continue;
        situation.status = 'resolved';
        situation.updatedAt = now;
        changed = true;
      }
      continue;
    }
    if (requestedActors.length < 2 || !(await actorsMayShareSituation(requestedActors, userId))) continue;
    const overlappingPhysicalLock = physicalLocks.find((lock) => (
      requestedActors.some((id) => lock.actorIds.includes(id))
    ));
    if (overlappingPhysicalLock) continue;
    const overlapping = graph.situations.filter((situation) => (
      situation.status === 'active'
      && situation.actorIds.some((id) => requestedActors.includes(id))
    ));
    const exact = overlapping.find((situation) => sameActorSet(situation.actorIds, requestedActors));
    if (!exact && overlapping.some((situation) => situation.sourceChatId !== sourceChatId)) continue;
    for (const situation of overlapping) {
      if (situation !== exact && situation.sourceChatId === sourceChatId) {
        situation.status = 'resolved';
        situation.updatedAt = now;
      }
    }
    const explicitKnownBy = uniqueIds(event.knownBy || [], 24)
      .map((id) => resolveSituationActorId(id, characters))
      .filter(Boolean);
    const knownBy = uniqueIds([
      ...requestedActors,
      ...(event.visibility === 'chat' ? chatActorIds : []),
      ...explicitKnownBy,
    ], 24);
    const ttlMinutes = Math.max(5, Math.min(1440, Number(event.ttlMinutes) || 180));
    if (exact) {
      Object.assign(exact, {
        knownBy: uniqueIds([...exact.knownBy, ...knownBy], 24),
        place: clean(event.place, 120) || exact.place,
        activity: clean(event.activity, 180) || exact.activity,
        visibility: event.visibility || exact.visibility,
        privacy: event.visibility === 'chat' ? 'public' : (event.privacy || exact.privacy),
        communication: event.communication || exact.communication,
        sourceRoundId: clean(aiRoundId, 120) || exact.sourceRoundId,
        status: 'active',
        updatedAt: now,
        expiresAt: now + (ttlMinutes * 60 * 1000),
      });
    } else {
      graph.situations.push(normalizeSituation({
        actorIds: requestedActors,
        knownBy,
        place: event.place,
        activity: event.activity,
        visibility: event.visibility,
        privacy: event.visibility === 'chat' ? 'public' : event.privacy,
        communication: event.communication,
        source: 'chat_state',
        sourceChatId,
        sourceRoundId: aiRoundId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + (ttlMinutes * 60 * 1000),
      }, now));
    }
    changed = true;
  }
  if (changed) graph.situations = graph.situations.slice(-MAX_SITUATIONS);
  return changed;
}

function relationDeltaFromActivity(activity = '') {
  const text = clean(activity, 240);
  if (!text) return null;
  if (/(?:亲|吻|拥抱|抱住|牵手|依偎|告白|表白|约会|亲密)/u.test(text)) {
    return { warmth: 4, trust: 1, tension: -1, summary: `共同经历亲密进展：${text}` };
  }
  if (/(?:争吵|吵架|冷战|质问|冲突|推开|拒绝|分手|决裂)/u.test(text)) {
    return { warmth: -2, trust: -2, tension: 4, summary: `共同经历关系冲突：${text}` };
  }
  return null;
}

function applyRelationshipDelta(graph, {
  fromId = '',
  toId = '',
  warmth = 0,
  trust = 0,
  tension = 0,
  stance = '',
  reason = '',
  knownBy = [],
  sourceChatId = '',
  sourceRoundId = '',
  now = Date.now(),
} = {}) {
  const from = clean(fromId, 240);
  const to = clean(toId, 240);
  if (!from || !to || from === to) return false;
  const id = relationshipStateId(from, to);
  const previous = normalizeRelationshipState(graph.relationshipStates?.[id] || { fromId: from, toId: to });
  const evidenceSummary = clean(reason || stance, 240);
  graph.relationshipStates ||= {};
  graph.relationshipStates[id] = normalizeRelationshipState({
    ...previous,
    warmth: decayedRelationshipScore(previous.warmth, previous.updatedAt, now) + Number(warmth || 0),
    trust: decayedRelationshipScore(previous.trust, previous.updatedAt, now) + Number(trust || 0),
    tension: decayedRelationshipScore(previous.tension, previous.updatedAt, now) + Number(tension || 0),
    stance: clean(stance, 280) || previous.stance,
    knownBy: uniqueIds([...previous.knownBy, from, ...knownBy], 24),
    evidence: evidenceSummary
      ? [...previous.evidence, {
        summary: evidenceSummary,
        sourceChatId,
        sourceRoundId,
        knownBy: uniqueIds([from, ...knownBy], 24),
        at: now,
      }]
      : previous.evidence,
    sourceRoundId,
    updatedAt: now,
  });
  return true;
}

function updateRelationshipDynamics({
  graph,
  events = [],
  chat = null,
  characters = {},
  aiRoundId = '',
  now = Date.now(),
} = {}) {
  const chatActors = uniqueIds(chat?.participants || [], 20);
  const hasUser = chatActors.includes('user');
  const counterpartIds = chatActors.filter((id) => id !== 'user');
  let changed = false;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.t === 'state' && hasUser) {
      const actorId = resolveSituationActorId(event.from, characters);
      if (!actorId || !counterpartIds.includes(actorId)) continue;
      const shift = Math.max(-20, Math.min(20, Number(event.moodShift) || 0));
      const stance = clean(event.intent, 280);
      if (!shift && !stance) continue;
      changed = applyRelationshipDelta(graph, {
        fromId: actorId,
        toId: 'user',
        warmth: shift > 0 ? Math.min(3, Math.ceil(shift / 5)) : Math.max(-3, Math.floor(shift / 5)),
        trust: shift > 5 ? 1 : (shift < -5 ? -1 : 0),
        tension: shift < 0 ? Math.min(3, Math.ceil(Math.abs(shift) / 5)) : (shift > 5 ? -1 : 0),
        stance,
        reason: stance || `本轮情绪变化 ${shift > 0 ? '+' : ''}${shift}`,
        sourceChatId: chat?.id,
        sourceRoundId: aiRoundId,
        now,
      }) || changed;
      continue;
    }
    if (event?.t === 'memory_fact' && /relationship|关系|印象|边界|承诺/u.test(clean(event.factType, 80))) {
      const fromId = resolveSituationActorId(event.subject || event.from, characters);
      const toId = resolveSituationActorId(event.object, characters)
        || (fromId !== 'user' && hasUser ? 'user' : '');
      if (!fromId || !toId) continue;
      changed = applyRelationshipDelta(graph, {
        fromId,
        toId,
        stance: event.content,
        reason: event.evidence || event.content,
        knownBy: [resolveSituationActorId(event.from, characters)].filter(Boolean),
        sourceChatId: chat?.id,
        sourceRoundId: aiRoundId,
        now,
      }) || changed;
      continue;
    }
    if (event?.t === 'situation' && event.action !== 'clear') {
      const delta = relationDeltaFromActivity(event.activity);
      if (!delta) continue;
      const actors = uniqueIds([
        resolveSituationActorId(event.from, characters),
        ...(event.with || []).map((id) => resolveSituationActorId(id, characters)),
      ]).filter(Boolean);
      const nonUserActors = actors.filter((id) => id !== 'user');
      if (!actors.includes('user')) continue;
      for (const actorId of nonUserActors) {
        changed = applyRelationshipDelta(graph, {
          fromId: actorId,
          toId: 'user',
          ...delta,
          stance: delta.summary,
          knownBy: actors,
          sourceChatId: chat?.id,
          sourceRoundId: aiRoundId,
          now,
        }) || changed;
      }
    }
  }
  if (changed) {
    graph.relationshipStates = Object.fromEntries(
      Object.values(graph.relationshipStates)
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(-MAX_RELATIONSHIP_STATES)
        .map((item) => [item.id, item]),
    );
  }
  return changed;
}

async function recordEnsembleRoundUnlocked({
  userId = '',
  chat = null,
  aiRoundId = '',
  savedMessages = [],
  sideEffects = [],
  backstageSaved = [],
  characters = {},
} = {}) {
  const uid = clean(userId, 120);
  if (!uid || !chat?.id) return { ok: false, reason: 'missing-context' };
  const config = await loadEnsembleModeConfig(uid);
  if (!config.enabled) return { ok: false, reason: 'disabled' };

  const now = Date.now();
  const graph = await loadEnsembleGraph(uid);
  const graphBefore = cloneGraphValue(graph);
  const physicalLocks = [
    ...await currentPhysicalLocks(uid),
    ...graph.situationReservations.filter((item) => (
      item.status === 'active'
      && item.expiresAt > now
      && item.sourceChatId !== chat.id
    )),
  ];
  const node = findOrCreateNode(graph, chat, now);
  const sourceActorIds = uniqueIds((chat.participants || []).filter((id) => id !== 'user'));
  const mainThread = upsertThread(node, {
    id: `ens_thread_chat_${clean(chat.id, 100)}`,
    kind: chat.type === 'group' ? 'group' : 'private',
    chatId: chat.id,
    actorIds: sourceActorIds,
    knownBy: sourceActorIds,
    summary: messageSummary(savedMessages),
    sourceRoundId: aiRoundId,
    updatedAt: now,
  });
  const savedTargets = (Array.isArray(backstageSaved) ? backstageSaved : [])
    .map((item) => clean(item?.chatId, 120))
    .filter(Boolean);
  let targetCursor = 0;
  for (const event of Array.isArray(sideEffects) ? sideEffects : []) {
    if (!['peer_private', 'backstage', 'private_msg', 'chat_bundle'].includes(event?.t)) continue;
    const actors = eventActorIds(event);
    if (!actors.length) continue;
    let eligible = true;
    for (let i = 0; i < actors.length && eligible; i += 1) {
      for (let j = i + 1; j < actors.length; j += 1) {
        const result = await canPhoneCharacterIdsKnowEachOther(actors[i], actors[j], uid).catch(() => false);
        if (result === false) {
          eligible = false;
          break;
        }
      }
    }
    if (!eligible) continue;
    const targetChatId = clean(event.targetChatId, 120) || savedTargets[targetCursor] || '';
    if (targetChatId) targetCursor += 1;
    const thread = upsertThread(node, {
      kind: event.t,
      chatId: targetChatId,
      parentThreadId: mainThread.id,
      actorIds: actors,
      knownBy: actors,
      summary: eventSummary(event),
      sourceRoundId: aiRoundId,
      updatedAt: now,
    });
    node.actorIds = uniqueIds([...node.actorIds, ...actors]);
    node.chatIds = uniqueIds([...node.chatIds, targetChatId]);
    if (event?.t === 'private_msg') {
      thread.knownBy = uniqueIds([...thread.knownBy, 'user']);
    }
  }

  for (const event of Array.isArray(sideEffects) ? sideEffects : []) {
    if (event?.t !== 'social_post') continue;
    const authorId = clean(
      event.from
      || event.actor
      || (sourceActorIds.length === 1 ? sourceActorIds[0] : ''),
      240,
    );
    const brief = clean(event.brief || event.intent || event.body, 360);
    if (!authorId || !brief) continue;
    const target = clean(event.target).toLowerCase();
    const deferred = ['later', 'queue', 'defer'].includes(clean(event.timing).toLowerCase());
    if (!deferred) {
      const consumed = [...graph.resources]
        .reverse()
        .find((item) => (
          item.status === 'queued'
          && item.target === target
          && item.authorId === authorId
          && briefAffinity(item.brief, brief) >= 0.42
        ));
      if (consumed) {
        consumed.status = 'published';
        consumed.publishedAt = now;
        consumed.consumedByRoundId = aiRoundId;
        consumed.updatedAt = now;
      }
    }
    graph.resources.push(normalizeResource({
      eventId: node.id,
      threadId: mainThread.id,
      target,
      authorId,
      brief,
      sourceChatId: chat.id,
      sourceRoundId: aiRoundId,
      status: deferred ? 'queued' : 'published',
      publishedAt: deferred ? 0 : now,
      createdAt: now,
      updatedAt: now,
    }));
  }
  updateIdentityStates(
    graph,
    sideEffects,
    chat.id,
    now,
    sourceActorIds.length === 1 ? sourceActorIds[0] : '',
    aiRoundId,
  );
  const matchingReservations = graph.situationReservations.filter((item) => (
    item.status === 'active'
    && item.expiresAt > now
    && (item.sourceRoundId === aiRoundId || item.sourceChatId === chat.id)
  ));
  const reservationEvents = matchingReservations.map((item) => ({
    t: 'situation',
    action: 'set',
    from: item.actorIds.find((id) => id !== 'user') || item.actorIds[0],
    with: item.actorIds.filter((id) => id !== (item.actorIds.find((actorId) => actorId !== 'user') || item.actorIds[0])),
    knownBy: item.knownBy,
    visibility: 'participants',
    place: item.place,
    activity: item.activity,
    ttlMinutes: 180,
  }));
  await updateSituationFacts({
    userId: uid,
    graph,
    events: [...reservationEvents, ...sideEffects],
    chat,
    characters,
    aiRoundId,
    now,
    physicalLocks,
  });
  graph.situationReservations = graph.situationReservations.filter((item) => (
    !matchingReservations.some((reservation) => reservation.id === item.id)
  ));
  updateRelationshipDynamics({
    graph,
    events: [...reservationEvents, ...sideEffects],
    chat,
    characters,
    aiRoundId,
    now,
  });
  node.actorIds = uniqueIds([...node.actorIds, ...sourceActorIds]);
  node.chatIds = uniqueIds([...node.chatIds, chat.id, ...savedTargets]);
  node.summary = messageSummary(savedMessages) || node.summary;
  node.updatedAt = now;
  graph.nodes = graph.nodes.slice(-MAX_EVENT_NODES);
  graph.resources = graph.resources.slice(-MAX_RESOURCES);
  const roundEffect = captureRoundEffect(graphBefore, graph, {
    aiRoundId,
    chatId: chat.id,
    nodeId: node.id,
    recordedAt: now,
  });
  if (roundEffect) {
    graph.roundEffects = [
      ...graph.roundEffects.filter((item) => item.aiRoundId !== roundEffect.aiRoundId),
      roundEffect,
    ].slice(-MAX_ROUND_EFFECTS);
  }
  await saveEnsembleGraph(uid, graph);
  return { ok: true, eventId: node.id, threadId: mainThread.id };
}

export async function recordEnsembleRound(options = {}) {
  const uid = clean(options?.userId, 120);
  if (!uid) return { ok: false, reason: 'missing-context' };
  return withEnsembleGraphMutation(uid, () => recordEnsembleRoundUnlocked(options));
}

async function currentPhysicalLocks(userId = '') {
  const chats = await listChatsForUser(userId).catch(() => []);
  const sessions = await listActiveOfflineSessionsForChats(
    chats.slice(0, 80).map((chat) => chat?.id).filter(Boolean),
  ).catch(() => []);
  const locks = [];
  for (const session of sessions) {
    const activeMembers = Array.isArray(session.attendance?.members)
      ? session.attendance.members
        .filter((member) => member?.status === 'active')
        .map((member) => clean(member.characterId, 240))
        .filter(Boolean)
      : uniqueIds(session.participants).filter((id) => id !== 'user');
    const actorIds = uniqueIds(['user', ...activeMembers]);
    locks.push({
      id: `ens_offline_${clean(session.id || session.chatId, 100)}`,
      eventId: clean(session.id || session.chatId, 120),
      chatId: clean(session.chatId, 120),
      sourceChatId: clean(session.chatId, 120),
      source: 'offline',
      actorIds,
      knownBy: actorIds,
      place: clean(session.scene?.place, 120),
      activity: clean(session.scene?.goal || session.scene?.activityKind, 160),
      status: 'active',
      updatedAt: Number(session.updatedAt || session.startedAt || 0) || 0,
    });
  }
  return locks;
}

async function currentWorldSituations(userId = '', graph = null) {
  const [loadedGraph, locks] = await Promise.all([
    graph ? Promise.resolve(graph) : loadEnsembleGraph(userId),
    currentPhysicalLocks(userId),
  ]);
  const now = Date.now();
  const chatSituations = (loadedGraph?.situations || [])
    .filter((item) => item.status === 'active' && item.expiresAt > now)
    .filter((item) => !locks.some((lock) => (
      item.actorIds.some((id) => lock.actorIds.includes(id))
    )));
  const reservations = (loadedGraph?.situationReservations || [])
    .filter((item) => item.status === 'active' && item.expiresAt > now)
    .filter((item) => !locks.some((lock) => (
      item.actorIds.some((id) => lock.actorIds.includes(id))
    )))
    .filter((item) => !chatSituations.some((situation) => (
      situation.sourceChatId === item.sourceChatId
      && situation.actorIds.some((id) => item.actorIds.includes(id))
    )));
  return [...chatSituations, ...reservations, ...locks];
}

export function buildEnsembleActorOccupancyLedger(situations = []) {
  const byActor = new Map();
  for (const situation of Array.isArray(situations) ? situations : []) {
    if (situation?.status !== 'active' || situation.physical === false) continue;
    for (const actorId of uniqueIds(situation.actorIds || [])) {
      const current = byActor.get(actorId);
      if (current && Number(current.updatedAt || 0) > Number(situation.updatedAt || 0)) continue;
      byActor.set(actorId, {
        actorId,
        situationId: clean(situation.id, 120),
        sourceChatId: clean(situation.sourceChatId || situation.chatId, 120),
        place: clean(situation.place, 120),
        activity: clean(situation.activity, 180),
        knownBy: uniqueIds(situation.knownBy, 24),
        communication: situation.communication || 'limited',
        provisional: situation.provisional === true,
        updatedAt: Number(situation.updatedAt || 0) || 0,
      });
    }
  }
  return [...byActor.values()];
}

export function projectEnsembleSituationsForActors({
  situations = [],
  currentActorIds = [],
} = {}) {
  const actorIds = uniqueIds(currentActorIds).filter((id) => id !== 'user');
  const byActor = {};
  for (const viewerId of actorIds) {
    const exact = [];
    const opaqueByActor = new Map();
    for (const situation of Array.isArray(situations) ? situations : []) {
      if (situation?.status !== 'active') continue;
      const involved = situation.actorIds?.includes(viewerId);
      const informed = situation.knownBy?.includes(viewerId);
      if (involved || informed) {
        exact.push(situation);
        continue;
      }
      for (const unavailableActorId of uniqueIds(situation.actorIds || [])) {
        if (unavailableActorId === viewerId) continue;
        const existing = opaqueByActor.get(unavailableActorId);
        if (!existing || Number(existing.updatedAt || 0) < Number(situation.updatedAt || 0)) {
          // 故意不携带 situation id、同行者、地点或活动；否则多个 opaque 条目会泄露
          // “这些人正在同一事件里”的关联，只保留逐实体的不可同处约束。
          opaqueByActor.set(unavailableActorId, {
            unavailableActorId,
            communication: situation.communication || 'limited',
            updatedAt: situation.updatedAt || 0,
          });
        }
      }
    }
    byActor[viewerId] = { exact, opaque: [...opaqueByActor.values()] };
  }
  if (actorIds.length === 1) return { ...byActor[actorIds[0]], byActor };
  const exactById = new Map();
  const opaqueById = new Map();
  for (const view of Object.values(byActor)) {
    for (const item of view.exact) exactById.set(item.id, item);
    for (const item of view.opaque) opaqueById.set(item.unavailableActorId, item);
  }
  return { exact: [...exactById.values()], opaque: [...opaqueById.values()], byActor };
}

export async function filterEnsembleConflictingEvents({
  userId = '',
  chatId = '',
  events = [],
} = {}) {
  const list = Array.isArray(events) ? events : [];
  const uid = clean(userId, 120);
  const sourceChatId = clean(chatId, 120);
  if (!uid || !list.length) return { events: list, blocked: [] };
  const config = await loadEnsembleModeConfig(uid).catch(() => ({ enabled: false }));
  if (!config.enabled) return { events: list, blocked: [] };
  const situations = await currentWorldSituations(uid);
  if (!situations.length) return { events: list, blocked: [] };

  const blocked = [];
  const guarded = list.filter((event) => {
    const type = clean(event?.t, 40);
    // 公开短句不代表物理移动；只拦会建立实体到场或共同现实的事件。
    if (type !== 'offline_invite' && !(type === 'situation' && event.action !== 'clear')) return true;
    const actors = uniqueIds([
      ...eventActorIds(event),
      ...(type === 'offline_invite' ? ['user'] : []),
    ]);
    const conflict = situations.find((situation) => (
      clean(situation.sourceChatId || situation.chatId, 120) !== sourceChatId
      && actors.some((actorId) => situation.actorIds.includes(actorId))
    ));
    if (!conflict) return true;
    blocked.push({
      type,
      actorIds: actors,
      activeChatId: conflict.sourceChatId || conflict.chatId,
      place: conflict.place,
    });
    return false;
  });
  return { events: guarded, blocked };
}

async function currentCommunicationStates(userId = '', actorIds = []) {
  const wanted = new Set(uniqueIds(actorIds).filter((id) => id !== 'user'));
  if (!wanted.size) return [];
  const [chats, aliases] = await Promise.all([
    listChatsForUser(userId).catch(() => []),
    listCharacterAliasAccountsForUser(userId, { characterIds: wanted }).catch(() => []),
  ]);
  const byActor = new Map([...wanted].map((actorId) => [actorId, {
    actorId,
    aliasCount: aliases.filter((row) => row?.ownerId === actorId && row?.status === 'active').length,
    blockedByUser: false,
    strangerStates: [],
  }]));
  for (const chat of chats) {
    const participants = (chat?.participants || []).filter((id) => wanted.has(id));
    if (!participants.length) continue;
    if (isStrangerInterceptChat(chat)) {
      for (const actorId of participants) {
        const state = byActor.get(actorId);
        const friendship = clean(chat.metadata?.friendshipState, 32);
        const kind = clean(chat.metadata?.strangerKind || chat.metadata?.interceptKind || chat.metadata?.channelKind, 40);
        state.strangerStates.push({
          chatId: clean(chat.id, 120),
          friendship: friendship || 'stranger',
          kind,
        });
      }
      continue;
    }
    if (chat.type !== 'private' || !(chat.participants || []).includes('user')) continue;
    const prefs = await loadChatPrefs(chat.id).catch(() => ({}));
    if (!getChatBlockedState(chat, prefs).blocked) continue;
    for (const actorId of participants) byActor.get(actorId).blockedByUser = true;
  }
  return [...byActor.values()];
}

export async function buildEnsembleContextBlock({
  userId = '',
  chat = null,
  characters = {},
  excludeAiRoundIds = [],
} = {}) {
  const uid = clean(userId, 120);
  if (!uid || !chat?.id) return '';
  const config = await loadEnsembleModeConfig(uid);
  if (!config.enabled) return '';
  const storedGraph = await loadEnsembleGraph(uid);
  // 重 roll 的旧稿即使因为异常/迟到写入仍暂存在群像图里，也绝不能进入 replacement
  // 的提示词。这里只做内存投影，不改持久数据；正常的级联回滚仍负责真实清理。
  const excludedRoundIds = uniqueIds(
    Array.isArray(excludeAiRoundIds) ? excludeAiRoundIds : [excludeAiRoundIds],
    100,
  );
  const graph = excludedRoundIds.length
    ? rollbackEnsembleGraphForRounds(storedGraph, excludedRoundIds).graph
    : storedGraph;
  const currentActorIds = uniqueIds((chat.participants || []).filter((id) => id !== 'user'));
  const [situations, communicationStates] = await Promise.all([
    currentWorldSituations(uid, graph),
    currentCommunicationStates(uid, currentActorIds),
  ]);
  const liveSideThreadSummaries = new Map();
  const sideThreadKinds = new Set(['peer_private', 'backstage', 'private_msg', 'chat_bundle']);
  const resolveSideThread = async (thread) => {
    const threadChatId = clean(thread?.chatId, 120);
    if (!threadChatId || !sideThreadKinds.has(thread?.kind)) return thread;
    if (!liveSideThreadSummaries.has(threadChatId)) {
      liveSideThreadSummaries.set(threadChatId, listMessagesForChat(threadChatId, 12)
        .then((rows) => messageSummary(rows))
        .catch(() => null));
    }
    const liveSummary = await liveSideThreadSummaries.get(threadChatId);
    // null 代表读取失败，保留原缓存；空串代表源消息确实已经不存在。
    if (liveSummary === null) return thread;
    if (!liveSummary) return null;
    return liveSummary === thread.summary ? thread : { ...thread, summary: liveSummary };
  };
  const relevantNodes = [];
  for (const node of [...graph.nodes].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (node.status !== 'active') continue;
    const visibleThreadCandidates = node.threads
      .filter((thread) => thread.chatId === chat.id
        || thread.knownBy.some((id) => currentActorIds.includes(id)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6);
    const visibleThreads = (await Promise.all(visibleThreadCandidates.map(resolveSideThread)))
      .filter(Boolean);
    if (!node.chatIds.includes(chat.id) && !visibleThreads.length) continue;
    const mainThreadVisible = visibleThreads.some((thread) => (
      (thread.kind === 'group' || thread.kind === 'private')
      && (thread.chatId === chat.id || thread.knownBy.some((id) => currentActorIds.includes(id)))
    ));
    relevantNodes.push({ node, visibleThreads, mainThreadVisible });
    if (relevantNodes.length >= 5) break;
  }
  const nameOf = (id) => {
    if (id === 'user') return 'user';
    const row = characters?.[id];
    return clean(row?.realName || row?.name || row?.customNickname || id, 40);
  };
  const lines = [
    '【群像模式 · 当前事件协调】',
    '这里是跨窗口共享的当前状态，不是新剧情素材。人物设定、世界书、分组和关系网决定谁会行动；事件节点只负责对齐已经发生的事实。',
    '硬边界：未被关系网、角色关系、认识账本或“组内互识”放行的角色不得互相认识、点名、私聊、拉群或共享消息；不得为了制造群像强行让关系圈相交。',
  ];
  const projectedSituations = projectEnsembleSituationsForActors({
    situations,
    currentActorIds,
  });
  const situationViewEntries = currentActorIds.map((actorId) => [
    actorId,
    projectedSituations.byActor?.[actorId] || { exact: [], opaque: [] },
  ]);
  if (situationViewEntries.some(([, view]) => view.exact.length || view.opaque.length)) {
    lines.push(
      '当前现实状态（按角色私有投影；来自线下会话、用户刚明确完成的动作或聊天中已建立的事实，优先于日程、旧记录和模型猜测）：',
      '生成每名角色前只读取其名字下的投影。即使多名角色同处一个技术 prompt，也禁止互读其他角色的精确信息。',
    );
    for (const [viewerId, view] of situationViewEntries) {
      if (!view.exact.length && !view.opaque.length) continue;
      lines.push(`◆ 【仅 ${nameOf(viewerId)} 可用的现实投影】`);
      for (const situation of view.exact) {
        const communicationHint = situation.communication === 'unavailable'
          ? '当前不适合远程通信'
          : (situation.communication === 'limited' ? '可以异步通信，但不保证即时回应' : '仍可正常远程通信');
        lines.push(`- 已知事实：${situation.actorIds.map(nameOf).join('、')} 此刻同处${situation.place ? `「${situation.place}」` : '一场进行中的活动'}${situation.activity ? `，正在${situation.activity}` : ''}；${communicationHint}。不得把任何一人安排到第二个实体地点。`);
      }
      for (const item of view.opaque) {
        const communicationHint = item.communication === 'unavailable'
          ? '目前也不适合即时通信'
          : (item.communication === 'limited' ? '仍可异步收发消息，但不保证立即回应' : '仍可正常远程通信');
        lines.push(`- 仅知缺席：${nameOf(item.unavailableActorId)} 此刻不与 ${nameOf(viewerId)} 同处，去向、同行者和活动均未知；${communicationHint}。不得猜测、串联其他缺席者、点名同行者或据此质问。`);
      }
    }
  }
  const privateRelationshipStates = Object.values(graph.relationshipStates || {})
    .filter((state) => currentActorIds.includes(state.fromId))
    .filter((state) => state.knownBy.some((id) => currentActorIds.includes(id)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);
  if (privateRelationshipStates.length) {
    lines.push(
      '当前关系余波（按发言者隔离，不改写用户设置的基础关系）：',
      '每条只供箭头左侧角色决定自己的态度；同窗其他角色不能读取其私有立场或证据。数值只表示近期趋势，不是角色会说出口的量表。',
    );
    for (const state of privateRelationshipStates) {
      const warmth = decayedRelationshipScore(state.warmth, state.updatedAt);
      const trust = decayedRelationshipScore(state.trust, state.updatedAt);
      const tension = decayedRelationshipScore(state.tension, state.updatedAt);
      const latestEvidence = [...(state.evidence || [])]
        .reverse()
        .find((item) => item.knownBy.some((id) => currentActorIds.includes(id)));
      lines.push(`- ${nameOf(state.fromId)} → ${nameOf(state.toId)}：温度 ${warmth >= 0 ? '+' : ''}${warmth}，信任 ${trust >= 0 ? '+' : ''}${trust}，张力 ${tension >= 0 ? '+' : ''}${tension}${state.stance ? `；当前态度：${state.stance}` : ''}${latestEvidence?.summary ? `；依据：${latestEvidence.summary}` : ''}`);
    }
  }
  for (const item of relevantNodes) {
    const { node, visibleThreads, mainThreadVisible } = item;
    const visibleActorIds = uniqueIds(visibleThreads.flatMap((thread) => thread.actorIds));
    const actorLabel = visibleActorIds.map(nameOf).filter(Boolean).join('、');
    const nodeLabel = node.chatIds.includes(chat.id) ? (node.title || node.kind) : '关联事件';
    const visibleSummary = mainThreadVisible ? node.summary : '';
    lines.push(`事件 ${node.id}｜${nodeLabel}${actorLabel ? `｜相关：${actorLabel}` : ''}${visibleSummary ? `｜当前：${visibleSummary}` : ''}`);
    for (const thread of visibleThreads) {
      const knows = thread.knownBy.map(nameOf).filter(Boolean).join('、');
      lines.push(`  - 分支 ${thread.id}（${thread.kind}${thread.chatId === chat.id ? '·本窗' : ''}）${thread.summary || '仍在进行'}${knows ? `｜知情：${knows}` : ''}`);
    }
  }
  const queued = graph.resources
    .filter((item) => item.status === 'queued' && currentActorIds.includes(item.authorId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);
  if (queued.length) {
    lines.push('该人物尚未发布的动态素材（只是候选，不是必须发）：');
    for (const item of queued) lines.push(`- ${nameOf(item.authorId)} → ${item.target}：${item.brief}`);
  }
  const identities = currentActorIds
    .map((id) => graph.identityStates[id])
    .filter(Boolean)
    .slice(0, 6);
  if (identities.length) {
    lines.push('身份与拦截动态：');
    for (const state of identities) {
      const bits = [
        state.aliasState ? `马甲号 ${state.aliasState}` : '',
        state.strangerState ? `陌生关系 ${state.strangerState}` : '',
        state.reason,
      ].filter(Boolean);
      lines.push(`- ${nameOf(state.actorId)}：${bits.join('；')}`);
    }
  }
  const communicationLines = communicationStates
    .map((state) => {
      const bits = [
        state.aliasCount ? `有 ${state.aliasCount} 个启用中的马甲号` : '',
        state.blockedByUser ? '已被 user 拉黑，禁止主动送达与跨窗绕回' : '',
        ...state.strangerStates.slice(0, 3).map((item) => (
          `${item.kind ? `${item.kind}·` : ''}${item.friendship}`
        )),
      ].filter(Boolean);
      return bits.length ? `- ${nameOf(state.actorId)}：${bits.join('；')}` : '';
    })
    .filter(Boolean);
  if (communicationLines.length) {
    lines.push('当前通信与账号状态：', ...communicationLines);
  }
  lines.push(
    '跨窗分支必须继承当前事件与知情边界：角色可以去私聊别人、续另一个小群或把素材留给朋友圈/微博/论坛，但只能携带自己实际知道的部分。对方没看见、没人转述的事实仍然不知道。',
    '实体位置、拉黑、马甲身份、骚扰拦截和异地状态都是当前事实。若想说与事实冲突的话，只能明确表现为撒谎、玩笑、假设或误会，不能暗中改写真值。',
    '想发动态但此刻不适合发布时，可把 social_post 的 timing 写成 later；系统只存为候选，之后由人物主动动态或后续聊天决定是否使用。',
  );
  return lines.join('\n');
}

export async function claimEnsembleResource({
  userId = '',
  target = 'moments',
  preferredAuthorIds = [],
} = {}) {
  const uid = clean(userId, 120);
  return withEnsembleGraphMutation(uid, async () => {
    const graph = await loadEnsembleGraph(uid);
    const preferred = uniqueIds(preferredAuthorIds);
    const candidates = graph.resources
      .filter((item) => item.status === 'queued' && item.target === clean(target).toLowerCase())
      .filter((item) => !preferred.length || preferred.includes(item.authorId))
      .sort((a, b) => {
        const aPreferred = preferred.includes(a.authorId) ? 1 : 0;
        const bPreferred = preferred.includes(b.authorId) ? 1 : 0;
        return bPreferred - aPreferred || a.createdAt - b.createdAt;
      });
    const item = candidates[0];
    if (!item) return null;
    item.status = 'claimed';
    item.claimedAt = Date.now();
    item.updatedAt = item.claimedAt;
    await saveEnsembleGraph(uid, graph);
    return { ...item };
  });
}

export async function settleEnsembleResource(userId = '', resourceId = '', published = false) {
  const uid = clean(userId, 120);
  const id = clean(resourceId, 120);
  if (!uid || !id) return null;
  return withEnsembleGraphMutation(uid, async () => {
    const graph = await loadEnsembleGraph(uid);
    const item = graph.resources.find((row) => row.id === id);
    if (!item) return null;
    item.status = published ? 'published' : 'queued';
    item.publishedAt = published ? Date.now() : 0;
    item.claimedAt = published ? item.claimedAt : 0;
    item.updatedAt = Date.now();
    await saveEnsembleGraph(uid, graph);
    return { ...item };
  });
}
