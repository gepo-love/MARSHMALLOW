import { get, getAllRecords, put } from './db.js';
import {
  clearCharacterRuntimeScheduleOverride,
  clearCharacterRuntimeTopStatus,
  recordCharacterRuntimeState,
  topStatusCanOverrideSchedule,
} from './character-effective-state.js';

const KEY = (userId, characterId) => (
  `characterLiveState_${String(userId || '').trim()}_${String(characterId || '').trim()}`
);
const liveStateMutationQueues = new Map();

export const CHARACTER_LIVE_STATE_UPDATED_EVENT = 'marshmallow-character-live-state-updated';
export const CHARACTER_STATUS_LINE_MAX = 40;
export const CHARACTER_STATUS_LINE_TTL_MS = 45 * 60 * 1000;
export const CHARACTER_PRESENCE_TTL_MS = 45 * 60 * 1000;
const CHARACTER_OFFLINE_PRESENCE_TTL_MS = 8 * 60 * 60 * 1000;
export const CHARACTER_SCENE_FACT_TTL_MS = 45 * 60 * 1000;

const SCENE_SOURCE_PRIORITY = Object.freeze({
  schedule_proactive_state: 1,
  background_proactive_state: 2,
  chat_state: 3,
  foreground_chat_state: 3,
});

function notifyCharacterLiveStateUpdated(state = null) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || !window.CustomEvent) return;
  window.dispatchEvent(new window.CustomEvent(CHARACTER_LIVE_STATE_UPDATED_EVENT, {
    detail: {
      userId: String(state?.userId || '').trim(),
      characterId: String(state?.characterId || '').trim(),
      updatedAt: Number(state?.updatedAt || Date.now()) || Date.now(),
    },
  }));
}

function clean(value = '', max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const NON_AUTHORITATIVE_PRESENCE_SOURCES = new Set([
  'expired',
  'reroll_cleared',
  'cleared_chat',
  'scene_fact',
  'scene_fact_resumed',
]);

/**
 * 只有明确写入的在线态才是角色当前事实。
 * 过期、重 Roll/清聊天留下的墓碑，以及由普通场景描述推断出的在线态，
 * 都只表示“此前的值已失效”，不能反过来压住仍在生效的日程。
 */
export function hasAuthoritativeCharacterPresence(presence = null) {
  if (!presence || typeof presence !== 'object') return false;
  const source = clean(presence.source, 40);
  if (!timestamp(presence.updatedAt) && !source) return false;
  return !NON_AUTHORITATIVE_PRESENCE_SOURCES.has(source);
}

function timestamp(value, fallback = 0) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function decisionSequence(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

export function compareCharacterLiveDecisions(incoming = {}, current = {}) {
  const incomingAt = timestamp(incoming.decisionAt, timestamp(incoming.updatedAt));
  const currentAt = timestamp(current.decisionAt, timestamp(current.updatedAt));
  if (incomingAt !== currentAt) return incomingAt > currentAt ? 1 : -1;

  const incomingRoundId = clean(incoming.sourceRoundId || incoming.decisionRoundId, 120);
  const currentRoundId = clean(current.sourceRoundId || current.decisionRoundId, 120);
  if (incomingRoundId && currentRoundId && incomingRoundId === currentRoundId) {
    const incomingSequence = decisionSequence(incoming.decisionSequence);
    const currentSequence = decisionSequence(current.decisionSequence);
    if (incomingSequence !== currentSequence) return incomingSequence > currentSequence ? 1 : -1;
    return 0;
  }
  if (incomingRoundId !== currentRoundId) return incomingRoundId > currentRoundId ? 1 : -1;
  return 0;
}

export function characterSceneSourcePriority(source = '') {
  return SCENE_SOURCE_PRIORITY[clean(source, 40)] || 2;
}

function withCharacterLiveStateMutation(userId, characterId, task) {
  const key = KEY(userId, characterId);
  const previous = liveStateMutationQueues.get(key) || Promise.resolve();
  const queued = previous.catch(() => {}).then(task);
  liveStateMutationQueues.set(key, queued);
  return queued.finally(() => {
    if (liveStateMutationQueues.get(key) === queued) liveStateMutationQueues.delete(key);
  });
}

export function normalizeCharacterPresence(value = '') {
  const state = clean(value, 20).toLowerCase();
  return ['online', 'away', 'busy', 'offline'].includes(state) ? state : 'online';
}

export function normalizeCharacterStatusLine(value = '') {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[【】[\]<>]/g, '')
    .trim()
    .slice(0, CHARACTER_STATUS_LINE_MAX);
}

export function createDefaultCharacterLiveState(userId = '', characterId = '') {
  return {
    version: 1,
    userId: clean(userId, 120),
    characterId: clean(characterId, 120),
    policy: {
      aiUpdatesAllowed: true,
      manualLocked: false,
      presenceUpdatesAllowed: true,
      presenceManualLocked: false,
      sceneScheduleOverrideAllowed: true,
      updatedAt: 0,
    },
    statusLine: {
      text: '',
      source: '',
      updatedAt: 0,
      decisionAt: 0,
      decisionSequence: 0,
      expiresAt: 0,
      expiredAt: 0,
      sourceChatId: '',
      sourceRoundId: '',
    },
    presence: {
      state: 'online',
      source: '',
      updatedAt: 0,
      decisionAt: 0,
      decisionSequence: 0,
      expiresAt: 0,
      sourceChatId: '',
      sourceRoundId: '',
    },
    sceneFact: {
      activity: '',
      place: '',
      availability: 'online',
      scheduleOverride: false,
      source: '',
      updatedAt: 0,
      decisionAt: 0,
      decisionSequence: 0,
      expiresAt: 0,
      sourceChatId: '',
      sourceRoundId: '',
    },
    updatedAt: 0,
  };
}

export function normalizeCharacterLiveState(value = {}, options = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const fallback = createDefaultCharacterLiveState(options.userId, options.characterId);
  const policy = source.policy && typeof source.policy === 'object' ? source.policy : {};
  const statusLine = source.statusLine && typeof source.statusLine === 'object' ? source.statusLine : {};
  const presence = source.presence && typeof source.presence === 'object' ? source.presence : {};
  const sceneFact = source.sceneFact && typeof source.sceneFact === 'object' ? source.sceneFact : {};
  return {
    version: 1,
    userId: clean(source.userId || fallback.userId, 120),
    characterId: clean(source.characterId || fallback.characterId, 120),
    policy: {
      aiUpdatesAllowed: policy.aiUpdatesAllowed !== false,
      manualLocked: policy.manualLocked === true,
      presenceUpdatesAllowed: Object.prototype.hasOwnProperty.call(policy, 'presenceUpdatesAllowed')
        ? policy.presenceUpdatesAllowed !== false
        : (policy.aiUpdatesAllowed !== false && policy.manualLocked !== true),
      presenceManualLocked: Object.prototype.hasOwnProperty.call(policy, 'presenceManualLocked')
        ? policy.presenceManualLocked === true
        : policy.manualLocked === true,
      sceneScheduleOverrideAllowed: policy.sceneScheduleOverrideAllowed !== false,
      updatedAt: timestamp(policy.updatedAt),
    },
    statusLine: {
      text: normalizeCharacterStatusLine(statusLine.text),
      source: clean(statusLine.source, 40),
      updatedAt: timestamp(statusLine.updatedAt),
      decisionAt: timestamp(statusLine.decisionAt, timestamp(statusLine.updatedAt)),
      decisionSequence: decisionSequence(statusLine.decisionSequence),
      expiresAt: timestamp(statusLine.expiresAt),
      expiredAt: timestamp(statusLine.expiredAt),
      sourceChatId: clean(statusLine.sourceChatId, 120),
      sourceRoundId: clean(statusLine.sourceRoundId, 120),
    },
    presence: {
      state: normalizeCharacterPresence(presence.state),
      source: clean(presence.source, 40),
      updatedAt: timestamp(presence.updatedAt),
      decisionAt: timestamp(presence.decisionAt, timestamp(presence.updatedAt)),
      decisionSequence: decisionSequence(presence.decisionSequence),
      expiresAt: timestamp(presence.expiresAt),
      sourceChatId: clean(presence.sourceChatId, 120),
      sourceRoundId: clean(presence.sourceRoundId, 120),
    },
    sceneFact: {
      activity: clean(sceneFact.activity, 100),
      place: clean(sceneFact.place, 100),
      availability: normalizeCharacterPresence(sceneFact.availability),
      scheduleOverride: sceneFact.scheduleOverride === true,
      source: clean(sceneFact.source, 40),
      updatedAt: timestamp(sceneFact.updatedAt),
      // 场景 updatedAt 跟故事钟，不能拿它冒充请求先后；旧数据先视作没有因果水位。
      decisionAt: timestamp(sceneFact.decisionAt),
      decisionSequence: decisionSequence(sceneFact.decisionSequence),
      expiresAt: timestamp(sceneFact.expiresAt),
      sourceChatId: clean(sceneFact.sourceChatId, 120),
      sourceRoundId: clean(sceneFact.sourceRoundId, 120),
    },
    updatedAt: timestamp(source.updatedAt),
  };
}

export function expireCharacterLiveState(value = {}, now = Date.now(), options = {}) {
  const state = normalizeCharacterLiveState(value);
  const timestampNow = timestamp(now, Date.now());
  // 公开短句和在线态都是现实中的手机状态，不能被暂停/回拨的故事钟冻住。
  const statusNow = timestamp(options.statusNow, Date.now());
  const presenceNow = timestamp(options.presenceNow, Date.now());
  let changed = false;
  const next = { ...state };
  const legacyStatusCanExpire = state.statusLine.source !== 'manual';
  const legacyStatusExpiresAt = (
    state.statusLine.text
    && legacyStatusCanExpire
    && !state.statusLine.expiresAt
  )
    ? (state.statusLine.updatedAt
      ? state.statusLine.updatedAt + CHARACTER_STATUS_LINE_TTL_MS
      : statusNow)
    : 0;
  const statusExpiresAt = state.statusLine.expiresAt || legacyStatusExpiresAt;
  if (statusExpiresAt && statusExpiresAt <= statusNow) {
    next.statusLine = {
      ...state.statusLine,
      text: '',
      source: 'expired',
      expiresAt: 0,
      expiredAt: statusNow,
    };
    changed = true;
  } else if (legacyStatusExpiresAt) {
    // 修复旧版已经写入但漏掉 TTL（含漏掉 source）的角色级状态。
    next.statusLine = {
      ...state.statusLine,
      expiresAt: legacyStatusExpiresAt,
    };
    changed = true;
  }
  const legacyPresenceCanExpire = state.presence.source !== 'manual'
    && state.presence.source !== 'hard_offline';
  const legacyPresenceExpiresAt = (
    state.presence.state !== 'online'
    && legacyPresenceCanExpire
    && !state.presence.expiresAt
  )
    ? (state.presence.updatedAt ? state.presence.updatedAt + (
      state.presence.state === 'offline'
        ? CHARACTER_OFFLINE_PRESENCE_TTL_MS
        : CHARACTER_PRESENCE_TTL_MS
    ) : presenceNow)
    : 0;
  const presenceExpiresAt = state.presence.expiresAt || legacyPresenceExpiresAt;
  if (presenceExpiresAt && presenceExpiresAt <= presenceNow) {
    next.presence = {
      ...state.presence,
      state: 'online',
      source: 'expired',
      expiresAt: 0,
    };
    changed = true;
  } else if (legacyPresenceExpiresAt) {
    // 旧版角色级 busy / away / offline 可能漏写 TTL 或来源，导致顶栏永久卡住。
    next.presence = {
      ...state.presence,
      expiresAt: legacyPresenceExpiresAt,
    };
    changed = true;
  }
  const legacySceneExpiresAt = (
    state.sceneFact.activity
    && !state.sceneFact.expiresAt
    && state.sceneFact.updatedAt
  )
    ? state.sceneFact.updatedAt + CHARACTER_SCENE_FACT_TTL_MS
    : 0;
  const sceneExpiresAt = state.sceneFact.expiresAt || legacySceneExpiresAt;
  if (sceneExpiresAt && sceneExpiresAt <= timestampNow) {
    next.sceneFact = {
      ...state.sceneFact,
      activity: '',
      place: '',
      availability: 'online',
      scheduleOverride: false,
      source: 'expired',
      expiresAt: 0,
    };
    changed = true;
  } else if (legacySceneExpiresAt) {
    next.sceneFact = {
      ...state.sceneFact,
      expiresAt: legacySceneExpiresAt,
    };
    changed = true;
  }
  return { state: next, changed };
}

async function saveCharacterLiveState(userId, characterId, value) {
  const state = normalizeCharacterLiveState(value, { userId, characterId });
  state.updatedAt = Date.now();
  await put({ key: KEY(userId, characterId), value: state });
  notifyCharacterLiveStateUpdated(state);
  return state;
}

async function loadCharacterLiveStateUnlocked(userId, characterId, options = {}) {
  const uid = clean(userId, 120);
  const cid = clean(characterId, 120);
  if (!uid || !cid) return createDefaultCharacterLiveState(uid, cid);
  const row = await get(KEY(uid, cid)).catch(() => null);
  const current = normalizeCharacterLiveState(row?.value, { userId: uid, characterId: cid });
  const expired = expireCharacterLiveState(current, options.now, {
    statusNow: options.statusNow,
    presenceNow: options.presenceNow,
  });
  if (expired.changed) return saveCharacterLiveState(uid, cid, expired.state);
  return expired.state;
}

export async function loadCharacterLiveState(userId, characterId, options = {}) {
  const uid = clean(userId, 120);
  const cid = clean(characterId, 120);
  if (!uid || !cid) return createDefaultCharacterLiveState(uid, cid);
  return withCharacterLiveStateMutation(uid, cid, () => (
    loadCharacterLiveStateUnlocked(uid, cid, options)
  ));
}

/**
 * 清掉由指定聊天产生的角色级瞬时状态。
 * 用户手动锁定的公开状态与角色级权限属于设置，不随聊天记录一起删除。
 */
export async function clearCharacterLiveStateForChat(userId, characterId, chatId, options = {}) {
  const uid = clean(userId, 120);
  const cid = clean(characterId, 120);
  const sourceChatId = clean(chatId, 120);
  if (!uid || !cid || !sourceChatId) return createDefaultCharacterLiveState(uid, cid);
  return withCharacterLiveStateMutation(uid, cid, async () => {
    const current = await loadCharacterLiveStateUnlocked(uid, cid);
    const clearManual = options.clearManual === true;
    const clearStatus = current.statusLine.sourceChatId === sourceChatId
      && (clearManual || current.statusLine.source !== 'manual');
    const clearPresence = current.presence.sourceChatId === sourceChatId;
    const clearScene = current.sceneFact.sourceChatId === sourceChatId;
    if (!clearStatus && !clearPresence && !clearScene) return current;

    const clearedAt = Date.now();
    const decision = {
      decisionAt: clearedAt,
      decisionSequence: 0,
      sourceRoundId: `clear-chat:${sourceChatId}`,
    };
    const next = await saveCharacterLiveState(uid, cid, {
      ...current,
      ...(clearStatus ? {
        statusLine: {
          ...current.statusLine,
          text: '',
          source: 'cleared_chat',
          updatedAt: clearedAt,
          ...decision,
          expiresAt: 0,
          expiredAt: clearedAt,
          sourceChatId: '',
        },
      } : {}),
      ...(clearPresence ? {
        presence: {
          ...current.presence,
          state: 'online',
          source: 'cleared_chat',
          updatedAt: clearedAt,
          ...decision,
          expiresAt: 0,
          sourceChatId: '',
        },
      } : {}),
      ...(clearScene ? {
        sceneFact: {
          ...current.sceneFact,
          activity: '',
          place: '',
          availability: 'online',
          scheduleOverride: false,
          source: 'cleared_chat',
          updatedAt: clearedAt,
          ...decision,
          expiresAt: 0,
          sourceChatId: '',
        },
      } : {}),
    });
    if (clearStatus) await clearCharacterRuntimeTopStatus(uid, cid).catch(() => null);
    if (clearScene) {
      await clearCharacterRuntimeScheduleOverride(uid, cid, { chatId: sourceChatId }).catch(() => null);
    }
    return next;
  });
}

function rerollClearedComponent(component = {}, kind = '', markerId = '', clearedAt = Date.now()) {
  const base = {
    ...component,
    source: 'reroll_cleared',
    updatedAt: clearedAt,
    decisionAt: clearedAt,
    decisionSequence: 0,
    expiresAt: 0,
    sourceChatId: '',
    sourceRoundId: markerId,
  };
  if (kind === 'statusLine') {
    return { ...base, text: '', expiredAt: clearedAt };
  }
  if (kind === 'presence') return { ...base, state: 'online' };
  return {
    ...base,
    activity: '',
    place: '',
    availability: 'online',
    scheduleOverride: false,
  };
}

/**
 * 重 Roll 在生成新稿前撤销旧轮写入的角色级公开状态、在线态和场景事实。
 * 返回带标记的快照；若新稿失败，只恢复仍停留在该标记上的字段，绝不覆盖生成期间的手动修改。
 */
export async function rollbackCharacterLiveStatesForAiRounds(userId, roundIds = []) {
  const uid = clean(userId, 120);
  const roots = new Set((Array.isArray(roundIds) ? roundIds : [roundIds])
    .map((value) => clean(value, 120))
    .filter(Boolean));
  if (!uid || !roots.size) return { userId: uid, markerId: '', states: [] };
  const markerId = `reroll-clear:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  const rows = await getAllRecords('settings').catch(() => []);
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.key || '').startsWith(`characterLiveState_${uid}_`))
    .map((row) => normalizeCharacterLiveState(row?.value))
    .filter((state) => state.userId === uid && state.characterId);
  const states = [];
  for (const candidate of candidates) {
    const characterId = candidate.characterId;
    await withCharacterLiveStateMutation(uid, characterId, async () => {
      const current = await loadCharacterLiveStateUnlocked(uid, characterId);
      const matched = {
        statusLine: roots.has(clean(current.statusLine?.sourceRoundId, 120)),
        presence: roots.has(clean(current.presence?.sourceRoundId, 120)),
        sceneFact: roots.has(clean(current.sceneFact?.sourceRoundId, 120)),
      };
      if (!matched.statusLine && !matched.presence && !matched.sceneFact) return;
      const clearedAt = Date.now();
      states.push({
        characterId,
        markerId,
        statusLine: matched.statusLine ? { ...current.statusLine } : null,
        presence: matched.presence ? { ...current.presence } : null,
        sceneFact: matched.sceneFact ? { ...current.sceneFact } : null,
      });
      await saveCharacterLiveState(uid, characterId, {
        ...current,
        ...(matched.statusLine ? {
          statusLine: rerollClearedComponent(current.statusLine, 'statusLine', markerId, clearedAt),
        } : {}),
        ...(matched.presence ? {
          presence: rerollClearedComponent(current.presence, 'presence', markerId, clearedAt),
        } : {}),
        ...(matched.sceneFact ? {
          sceneFact: rerollClearedComponent(current.sceneFact, 'sceneFact', markerId, clearedAt),
        } : {}),
      });
      if (matched.statusLine) await clearCharacterRuntimeTopStatus(uid, characterId).catch(() => null);
      if (matched.sceneFact) {
        await clearCharacterRuntimeScheduleOverride(uid, characterId, {
          chatId: current.sceneFact?.sourceChatId || '',
        }).catch(() => null);
      }
    });
  }
  return { userId: uid, markerId, states };
}

export async function restoreCharacterLiveStateRoundRollback(snapshot = null) {
  const uid = clean(snapshot?.userId, 120);
  const markerId = clean(snapshot?.markerId, 120);
  const states = Array.isArray(snapshot?.states) ? snapshot.states : [];
  if (!uid || !markerId || !states.length) return 0;
  let restored = 0;
  for (const backup of states) {
    const characterId = clean(backup?.characterId, 120);
    if (!characterId) continue;
    await withCharacterLiveStateMutation(uid, characterId, async () => {
      const current = await loadCharacterLiveStateUnlocked(uid, characterId);
      const canRestore = (kind) => (
        backup?.[kind]
        && current?.[kind]?.source === 'reroll_cleared'
        && clean(current[kind].sourceRoundId, 120) === markerId
      );
      const restoreStatus = canRestore('statusLine');
      const restorePresence = canRestore('presence');
      const restoreScene = canRestore('sceneFact');
      if (!restoreStatus && !restorePresence && !restoreScene) return;
      await saveCharacterLiveState(uid, characterId, {
        ...current,
        ...(restoreStatus ? { statusLine: backup.statusLine } : {}),
        ...(restorePresence ? { presence: backup.presence } : {}),
        ...(restoreScene ? { sceneFact: backup.sceneFact } : {}),
      });
      if (restoreStatus) await clearCharacterRuntimeTopStatus(uid, characterId).catch(() => null);
      if (restoreScene) {
        if (backup.sceneFact?.scheduleOverride === true) {
          await recordCharacterRuntimeState(uid, characterId, {
            activity: backup.sceneFact.activity || '',
            presenceState: backup.sceneFact.availability || 'online',
            scheduleOverride: true,
            source: backup.sceneFact.source || 'chat_state',
            chatId: backup.sceneFact.sourceChatId || '',
            updatedAt: backup.sceneFact.updatedAt || Date.now(),
            expiresAt: backup.sceneFact.expiresAt || 0,
          }).catch(() => null);
        } else {
          await clearCharacterRuntimeScheduleOverride(uid, characterId, {
            chatId: backup.sceneFact?.sourceChatId || '',
          }).catch(() => null);
        }
      }
      restored += 1;
    });
  }
  return restored;
}

export async function setCharacterStatusPolicy(userId, characterId, patch = {}) {
  return withCharacterLiveStateMutation(userId, characterId, async () => {
    const current = await loadCharacterLiveStateUnlocked(userId, characterId);
    const updatedAt = Date.now();
    return saveCharacterLiveState(userId, characterId, {
      ...current,
      policy: {
        ...current.policy,
        ...(Object.prototype.hasOwnProperty.call(patch, 'aiUpdatesAllowed')
          ? { aiUpdatesAllowed: patch.aiUpdatesAllowed !== false }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'manualLocked')
          ? { manualLocked: patch.manualLocked === true }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'presenceUpdatesAllowed')
          ? { presenceUpdatesAllowed: patch.presenceUpdatesAllowed !== false }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'presenceManualLocked')
          ? { presenceManualLocked: patch.presenceManualLocked === true }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'sceneScheduleOverrideAllowed')
          ? { sceneScheduleOverrideAllowed: patch.sceneScheduleOverrideAllowed !== false }
          : {}),
        updatedAt,
      },
    });
  });
}

export async function setManualCharacterStatusLine(userId, characterId, text = '', options = {}) {
  return withCharacterLiveStateMutation(userId, characterId, async () => {
    const current = await loadCharacterLiveStateUnlocked(userId, characterId);
    const updatedAt = Date.now();
    const lockAiUpdates = options.lockAiUpdates !== false;
    const next = await saveCharacterLiveState(userId, characterId, {
      ...current,
      policy: {
        ...current.policy,
        aiUpdatesAllowed: !lockAiUpdates,
        manualLocked: lockAiUpdates,
        updatedAt,
      },
      statusLine: {
        text: normalizeCharacterStatusLine(text),
        source: 'manual',
        updatedAt,
        decisionAt: updatedAt,
        decisionSequence: 0,
        expiresAt: 0,
        expiredAt: 0,
        sourceChatId: clean(options.sourceChatId, 120),
        sourceRoundId: 'manual',
      },
    });
    await clearCharacterRuntimeTopStatus(userId, characterId).catch(() => null);
    return next;
  });
}

export async function setManualCharacterStatus(userId, characterId, patch = {}, options = {}) {
  return withCharacterLiveStateMutation(userId, characterId, async () => {
    const current = await loadCharacterLiveStateUnlocked(userId, characterId);
    const updatedAt = Date.now();
    const sourceChatId = clean(options.sourceChatId, 120);
    const lockAiUpdates = options.lockAiUpdates !== false;
    const lockPresenceUpdates = Object.prototype.hasOwnProperty.call(options, 'lockPresenceUpdates')
      ? options.lockPresenceUpdates !== false
      : lockAiUpdates;
    const next = await saveCharacterLiveState(userId, characterId, {
      ...current,
      policy: {
        ...current.policy,
        aiUpdatesAllowed: !lockAiUpdates,
        manualLocked: lockAiUpdates,
        presenceUpdatesAllowed: !lockPresenceUpdates,
        presenceManualLocked: lockPresenceUpdates,
        updatedAt,
      },
      statusLine: {
        text: normalizeCharacterStatusLine(patch.text),
        source: 'manual',
        updatedAt,
        decisionAt: updatedAt,
        decisionSequence: 0,
        expiresAt: 0,
        expiredAt: 0,
        sourceChatId,
        sourceRoundId: 'manual',
      },
      presence: {
        state: normalizeCharacterPresence(patch.presenceState),
        source: 'manual',
        updatedAt,
        decisionAt: updatedAt,
        decisionSequence: 0,
        expiresAt: 0,
        sourceChatId,
        sourceRoundId: 'manual',
      },
    });
    await clearCharacterRuntimeTopStatus(userId, characterId).catch(() => null);
    return next;
  });
}

export async function clearManualCharacterStatusLine(userId, characterId, options = {}) {
  return setManualCharacterStatusLine(userId, characterId, '', options);
}

export async function applyAiCharacterStatusLine(userId, characterId, patch = {}) {
  return withCharacterLiveStateMutation(userId, characterId, async () => {
    const current = await loadCharacterLiveStateUnlocked(userId, characterId);
    const textAllowed = current.policy.aiUpdatesAllowed !== false
      && current.policy.manualLocked !== true;
    const presenceAllowed = current.policy.presenceUpdatesAllowed !== false
      && current.policy.presenceManualLocked !== true;
    if (!textAllowed && !presenceAllowed) {
      return { accepted: false, changed: false, reason: 'manual-locked', state: current };
    }
    const updatedAt = timestamp(patch.updatedAt, Date.now());
    const sourceChatId = clean(patch.sourceChatId, 120);
    const sourceRoundId = clean(patch.sourceRoundId, 120);
    const sceneSource = clean(patch.sceneSource, 40) || 'chat_state';
    const decision = {
      decisionAt: timestamp(patch.decisionAt, updatedAt),
      decisionSequence: decisionSequence(patch.decisionSequence),
      sourceRoundId,
    };
    const currentSceneActive = !!(
      current.sceneFact?.activity
      && (!timestamp(current.sceneFact.expiresAt) || timestamp(current.sceneFact.expiresAt) > updatedAt)
    );
    if (
      currentSceneActive
      && characterSceneSourcePriority(sceneSource) < characterSceneSourcePriority(current.sceneFact?.source)
    ) {
      return { accepted: false, changed: false, reason: 'foreground-scene-active', state: current };
    }
    if (
      decision.decisionAt < timestamp(current.policy.updatedAt)
      || (textAllowed && compareCharacterLiveDecisions(decision, current.statusLine) < 0)
      || (presenceAllowed && compareCharacterLiveDecisions(decision, current.presence) < 0)
    ) {
      return { accepted: false, changed: false, reason: 'stale-round', state: current };
    }

    const text = textAllowed
      ? normalizeCharacterStatusLine(patch.text)
      : current.statusLine.text;
    const presenceState = presenceAllowed
      ? normalizeCharacterPresence(patch.presenceState)
      : current.presence.state;
    const statusExpiresAt = timestamp(patch.statusExpiresAt);
    const presenceExpiresAt = timestamp(patch.presenceExpiresAt);
    if (text === current.statusLine.text && presenceState === current.presence.state) {
      const advancesDecision = (
        (textAllowed && compareCharacterLiveDecisions(decision, current.statusLine) > 0)
        || (presenceAllowed && compareCharacterLiveDecisions(decision, current.presence) > 0)
      );
      if (!advancesDecision) {
        // 原样复读既不算更新，也不能刷新 TTL，否则短状态会被每轮无限续命。
        return { accepted: true, changed: false, reason: 'unchanged', state: current };
      }
      const next = await saveCharacterLiveState(userId, characterId, {
        ...current,
        ...(textAllowed ? { statusLine: {
          ...current.statusLine,
          ...decision,
          sourceRoundId,
        } } : {}),
        ...(presenceAllowed ? { presence: {
          ...current.presence,
          ...decision,
          sourceRoundId,
        } } : {}),
      });
      return { accepted: true, changed: false, reason: 'unchanged', state: next };
    }

    const textChanged = textAllowed && text !== current.statusLine.text;
    const presenceChanged = presenceAllowed && presenceState !== current.presence.state;
    const next = await saveCharacterLiveState(userId, characterId, {
      ...current,
      ...(textAllowed ? { statusLine: {
        text,
        source: 'ai',
        updatedAt,
        ...decision,
        expiresAt: statusExpiresAt,
        expiredAt: 0,
        sourceChatId,
        sourceRoundId,
      } } : {}),
      ...(presenceAllowed ? { presence: {
        state: presenceState,
        source: 'ai',
        updatedAt,
        ...decision,
        expiresAt: presenceExpiresAt,
        sourceChatId,
        sourceRoundId,
      } } : {}),
    });
    return {
      accepted: true,
      changed: true,
      appliedText: textAllowed,
      appliedPresence: presenceAllowed,
      textChanged,
      presenceChanged,
      reason: 'updated',
      state: next,
    };
  });
}

export async function recordCharacterPresence(userId, characterId, presenceState = 'online', options = {}) {
  return withCharacterLiveStateMutation(userId, characterId, async () => {
    const current = await loadCharacterLiveStateUnlocked(userId, characterId);
    const updatedAt = timestamp(options.updatedAt, Date.now());
    const decision = {
      decisionAt: timestamp(options.decisionAt, updatedAt),
      decisionSequence: decisionSequence(options.decisionSequence),
      sourceRoundId: clean(options.sourceRoundId, 120),
    };
    if (compareCharacterLiveDecisions(decision, current.presence) < 0) return current;
    const nextState = normalizeCharacterPresence(presenceState);
    if (
      current.presence.state === nextState
      && Number(current.presence.expiresAt || 0) === timestamp(options.expiresAt)
      && compareCharacterLiveDecisions(decision, current.presence) === 0
    ) {
      return current;
    }
    return saveCharacterLiveState(userId, characterId, {
      ...current,
      presence: {
        state: nextState,
        source: clean(options.source, 40) || 'system',
        updatedAt,
        ...decision,
        expiresAt: timestamp(options.expiresAt),
        sourceChatId: clean(options.sourceChatId, 120),
        sourceRoundId: decision.sourceRoundId,
      },
    });
  });
}

function inferAvailability(activity = '') {
  const text = clean(activity, 120);
  if (/睡|关机|没信号|断网|飞行模式|完全离线/.test(text)) return 'offline';
  if (/开会|上课|考试|工作中|忙|加班|训练|开车|洗澡|看电影|演出/.test(text)) return 'busy';
  if (/路上|通勤|赶路|排队|吃饭|做饭|收拾/.test(text)) return 'away';
  return 'online';
}

export async function recordCharacterSceneFact(userId, characterId, patch = {}) {
  return withCharacterLiveStateMutation(userId, characterId, async () => {
    const updatedAt = timestamp(patch.updatedAt, Date.now());
    const current = await loadCharacterLiveStateUnlocked(userId, characterId, {
      now: updatedAt,
      presenceNow: Date.now(),
    });
    const sourceRoundId = clean(patch.sourceRoundId, 120);
    const source = clean(patch.source, 40) || 'chat_state';
    const decision = {
      decisionAt: timestamp(patch.decisionAt, updatedAt),
      decisionSequence: decisionSequence(patch.decisionSequence),
      sourceRoundId,
    };
    const currentSceneActive = !!(
      current.sceneFact?.activity
      && (!timestamp(current.sceneFact.expiresAt) || timestamp(current.sceneFact.expiresAt) > updatedAt)
    );
    const incomingPriority = characterSceneSourcePriority(source);
    const currentPriority = characterSceneSourcePriority(current.sceneFact?.source);
    // 活跃聊天里的现实优先于后台主动轮。后台日程仍作为计划保留，等临时场景
    // 到期后自然恢复；不能因为后台请求稍晚发起，就把用户正在经历的场景顶掉。
    if (currentSceneActive && incomingPriority < currentPriority) return current;
    const higherPriorityScene = currentSceneActive && incomingPriority > currentPriority;
    if (
      decision.decisionAt < timestamp(current.policy.updatedAt)
      || (!higherPriorityScene && compareCharacterLiveDecisions(decision, current.sceneFact) < 0)
    ) {
      return current;
    }

    const activity = clean(patch.activity, 100);
    const place = clean(patch.place, 100);
    const ttlMs = Math.max(5 * 60 * 1000, timestamp(patch.ttlMs, CHARACTER_SCENE_FACT_TTL_MS));
    const sourceChatId = clean(patch.sourceChatId, 120);
    const availability = patch.availability
      ? normalizeCharacterPresence(patch.availability)
      : inferAvailability(activity);
    // state.status 只是这一轮回消息时的场景快照，不能凭一句活动描述改写当前日程。
    // 真正的临时改安排应由 schedule_change 修改计划；其他现实链路若确需覆盖，
    // 必须显式声明 explicitScheduleOverride，避免模型自由发挥反过来压住日程。
    const explicitScheduleOverride = patch.explicitScheduleOverride === true;
    const scheduleOverride = explicitScheduleOverride
      && current.policy.sceneScheduleOverrideAllowed !== false
      && patch.allowScheduleOverride !== false
      && topStatusCanOverrideSchedule(activity, 'state-scene-fact');
    const foregroundScene = source === 'chat_state' || source === 'foreground_chat_state';
    const protectedPresenceSource = current.presence?.source === 'hard_offline'
      || (current.presence?.source === 'manual' && current.policy.presenceManualLocked === true);
    // 同一轮若已经有独立 status 事件，它对在线态的表达比 state.status 推断更明确。
    // 两类副作用并行落库时，后完成的场景写入不能把明确的 busy / offline 又推回 online。
    const sameRoundExplicitPresence = current.presence?.source === 'ai'
      && sourceRoundId
      && clean(current.presence?.sourceRoundId, 120) === sourceRoundId;
    const sceneResumesPresence = !!(
      patch.resumePresence === true
      && foregroundScene
      && activity
      && availability !== 'offline'
      && !sameRoundExplicitPresence
      && current.policy.presenceUpdatesAllowed !== false
      && current.policy.presenceManualLocked !== true
      && !protectedPresenceSource
      && current.presence?.state !== availability
      && compareCharacterLiveDecisions(decision, current.presence) >= 0
    );
    const next = await saveCharacterLiveState(userId, characterId, {
      ...current,
      ...(sceneResumesPresence ? {
        // 调用方已经确认该角色在本轮发出了可见消息时，旧的 AI 离线/忙碌或延迟回来状态
        // 才被现实推翻。单独的 state.status 只是场景描述，不能自行暗改显式在线态。
        // 即使模型漏发独立 status 事件，也要让在线态随最新临时场景恢复；手动与硬下线除外。
        presence: {
          state: availability,
          source: 'scene_fact',
          updatedAt,
          ...decision,
          expiresAt: updatedAt + ttlMs,
          sourceChatId,
          sourceRoundId,
        },
        ...(current.statusLine?.text && current.statusLine?.source !== 'manual' ? {
          statusLine: {
            ...current.statusLine,
            text: '',
            source: 'scene_fact_resumed',
            updatedAt,
            ...decision,
            expiresAt: 0,
            expiredAt: updatedAt,
            sourceChatId,
            sourceRoundId,
          },
        } : {}),
      } : {}),
      sceneFact: {
        activity,
        place,
        availability,
        scheduleOverride,
        source,
        updatedAt,
        ...decision,
        expiresAt: activity || place ? updatedAt + ttlMs : 0,
        sourceChatId,
        sourceRoundId,
      },
    });
    await recordCharacterRuntimeState(userId, characterId, {
      activity,
      presenceState: availability,
      scheduleOverride,
      source: explicitScheduleOverride ? 'scene_fact_explicit' : 'scene_fact',
      chatId: sourceChatId,
      updatedAt,
      ttlMs,
    }).catch(() => null);
    return next;
  });
}
