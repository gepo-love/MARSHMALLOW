import { isAnonymousChat } from '../chat-helpers.js';
import { isNoUserGroup, resolveUserTopicPolicy } from '../../models/chat.js';

// 跨窗联动「保底轮数」：到达该轮数就必须落地；过半后先软催。
export const DEFAULT_LINKAGE_NUDGE_EVERY = 5;
export const LINKAGE_NUDGE_EVERY_MIN = 2;
export const LINKAGE_NUDGE_EVERY_MAX = 30;
// 自定义联动节奏：每隔多少个 AI 回合开放一次完整联动机会。
export const DEFAULT_LINKAGE_MIN_INTERVAL_TURNS = 3;
export const LINKAGE_MIN_INTERVAL_TURNS_MIN = 1;
export const LINKAGE_MIN_INTERVAL_TURNS_MAX = 30;
export const LINKAGE_CADENCE_MODES = Object.freeze(['natural', 'custom']);
export const DEFAULT_LINKAGE_CADENCE_MODE = 'natural';
export const LINKAGE_ROUTE_BIASES = Object.freeze(['private', 'balanced', 'group']);
export const DEFAULT_LINKAGE_ROUTE_BIAS = 'balanced';
export const DEFAULT_LINKAGE_GROUP_PITY_EVERY = 3;
export const DEFAULT_LINKAGE_FRONTSTAGE_PITY_EVERY = 2;
export const DEFAULT_LINKAGE_BACKSTAGE_PITY_EVERY = 4;
export const DEFAULT_LINKAGE_FRONTSTAGE_GROUP_SHARE = 0.7;
export const DEFAULT_AI_GROUP_CREATION_COOLDOWN_TURNS = 12;
export const AI_GROUP_CREATION_COOLDOWN_TURNS_MIN = 0;
export const AI_GROUP_CREATION_COOLDOWN_TURNS_MAX = 100;
export const LINKAGE_GROUP_PITY_MIN = 1;
export const LINKAGE_GROUP_PITY_MAX = 10;
export const LINKAGE_ROUTE_HISTORY_LIMIT = 8;
export const USER_PRIVATE_ACTOR_HISTORY_LIMIT = 12;

const LINKAGE_GROUP_TARGETS = Object.freeze({
  private: 0.25,
  balanced: 0.5,
  group: 0.75,
});

export function resolveLinkageNudgeEvery(chat = {}) {
  const raw = Number(chat?.groupSettings?.linkageNudgeEvery);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LINKAGE_NUDGE_EVERY;
  return Math.max(LINKAGE_NUDGE_EVERY_MIN, Math.min(LINKAGE_NUDGE_EVERY_MAX, Math.round(raw)));
}

export function resolveLinkageMinIntervalTurns(chat = {}) {
  const raw = Number(chat?.groupSettings?.linkageMinIntervalTurns);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LINKAGE_MIN_INTERVAL_TURNS;
  return Math.max(
    LINKAGE_MIN_INTERVAL_TURNS_MIN,
    Math.min(LINKAGE_MIN_INTERVAL_TURNS_MAX, Math.round(raw)),
  );
}

export function resolveLinkageCadenceMode(chat = {}) {
  const raw = String(chat?.groupSettings?.linkageCadenceMode || '').trim().toLowerCase();
  return LINKAGE_CADENCE_MODES.includes(raw) ? raw : DEFAULT_LINKAGE_CADENCE_MODE;
}

export function resolveLinkageRouteBias(chat = {}) {
  const raw = String(chat?.groupSettings?.linkageRouteBias || '').trim().toLowerCase();
  return LINKAGE_ROUTE_BIASES.includes(raw) ? raw : DEFAULT_LINKAGE_ROUTE_BIAS;
}

export function resolveLinkageGroupPityEvery(chat = {}) {
  const raw = Number(chat?.groupSettings?.linkageGroupPityEvery);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LINKAGE_GROUP_PITY_EVERY;
  return Math.max(LINKAGE_GROUP_PITY_MIN, Math.min(LINKAGE_GROUP_PITY_MAX, Math.round(raw)));
}

export function normalizeLinkageRouteHistory(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const route = ['private', 'group', 'mixed'].includes(String(entry?.route || ''))
        ? String(entry.route)
        : '';
      return {
        route,
        at: Math.max(0, Number(entry?.at || 0) || 0),
        aiRoundId: String(entry?.aiRoundId || '').trim(),
        turn: Math.max(0, Math.round(Number(entry?.turn || 0) || 0)),
        ...(entry?.frontstageGroup === true ? { frontstageGroup: true } : {}),
        ...(entry?.backstageGroup === true ? { backstageGroup: true } : {}),
      };
    })
    .filter((entry) => entry.route)
    .slice(-LINKAGE_ROUTE_HISTORY_LIMIT);
}

export function getLinkageRouteHistory(chat = {}) {
  return normalizeLinkageRouteHistory(chat?.metadata?.linkageRouteHistory);
}

export function resolveAiGroupCreationCooldownTurns(chat = {}) {
  const raw = Number(chat?.groupSettings?.aiGroupCreationCooldownTurns);
  if (!Number.isFinite(raw)) return DEFAULT_AI_GROUP_CREATION_COOLDOWN_TURNS;
  return Math.max(
    AI_GROUP_CREATION_COOLDOWN_TURNS_MIN,
    Math.min(AI_GROUP_CREATION_COOLDOWN_TURNS_MAX, Math.round(raw)),
  );
}

export function resolveAiGroupCreationCooldownState(chat = {}) {
  const cooldownTurns = resolveAiGroupCreationCooldownTurns(chat);
  const nextTurn = resolveNextLinkageTurn(chat);
  const lastCreationTurn = Math.max(
    0,
    Math.round(Number(chat?.metadata?.linkageLastGroupCreationTurn || 0) || 0),
  );
  const turnsSinceLastCreation = lastCreationTurn > 0
    ? Math.max(0, nextTurn - lastCreationTurn)
    : null;
  const remainingTurns = cooldownTurns > 0 && turnsSinceLastCreation !== null
    ? Math.max(0, cooldownTurns - turnsSinceLastCreation)
    : 0;
  return {
    cooldownTurns,
    lastCreationTurn,
    turnsSinceLastCreation,
    remainingTurns,
    allowed: remainingTurns === 0,
  };
}

export function normalizeUserPrivateActorHistory(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => ({
      actorId: String(entry?.actorId || '').trim(),
      at: Math.max(0, Number(entry?.at || 0) || 0),
      turn: Math.max(0, Math.round(Number(entry?.turn || 0) || 0)),
      aiRoundId: String(entry?.aiRoundId || '').trim(),
    }))
    .filter((entry) => entry.actorId && entry.actorId !== 'user')
    .slice(-USER_PRIVATE_ACTOR_HISTORY_LIMIT);
}

export function getUserPrivateActorHistory(chat = {}) {
  return normalizeUserPrivateActorHistory(chat?.metadata?.linkageUserPrivateActorHistory);
}

export function appendUserPrivateActorHistory(chat = {}, actorIds = [], options = {}) {
  const uniqueActorIds = [...new Set((Array.isArray(actorIds) ? actorIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  if (!uniqueActorIds.length) return getUserPrivateActorHistory(chat);
  const at = Math.max(0, Number(options.at || Date.now()) || Date.now());
  const turn = Math.max(0, Math.round(Number(options.turn || 0) || 0));
  const aiRoundId = String(options.aiRoundId || '').trim();
  return normalizeUserPrivateActorHistory([
    ...getUserPrivateActorHistory(chat),
    ...uniqueActorIds.map((actorId) => ({ actorId, at, turn, aiRoundId })),
  ]);
}

/** 未在近期私信过 user 的成员排前；都出现过时，最久没私信的人排前。 */
export function rankPrivateLinkageIdsByRecency(chat = {}, candidateIds = []) {
  const candidates = [...new Set((Array.isArray(candidateIds) ? candidateIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const latestIndex = new Map();
  getUserPrivateActorHistory(chat).forEach((entry, index) => latestIndex.set(entry.actorId, index));
  return candidates
    .map((id, order) => ({ id, order, recentIndex: latestIndex.has(id) ? latestIndex.get(id) : -1 }))
    .sort((left, right) => left.recentIndex - right.recentIndex || left.order - right.order)
    .map((entry) => entry.id);
}

export function appendLinkageRouteHistory(chat = {}, route = '', options = {}) {
  const kind = ['private', 'group', 'mixed'].includes(String(route || '')) ? String(route) : '';
  if (!kind) return getLinkageRouteHistory(chat);
  const aiRoundId = String(options.aiRoundId || '').trim();
  const history = getLinkageRouteHistory(chat);
  if (aiRoundId && history.some((entry) => entry.aiRoundId === aiRoundId)) return history;
  return normalizeLinkageRouteHistory([
    ...history,
    {
      route: kind,
      at: Math.max(0, Number(options.at || Date.now()) || Date.now()),
      aiRoundId,
      turn: Math.max(0, Math.round(Number(options.turn || 0) || 0)),
      ...(options.frontstageGroup === true ? { frontstageGroup: true } : {}),
      ...(options.backstageGroup === true ? { backstageGroup: true } : {}),
    },
  ]);
}

export function resolveNextLinkageTurn(chat = {}) {
  const completed = Math.max(0, Math.round(Number(chat?.metadata?.linkageTurnCounter || 0) || 0));
  return completed + 1;
}

/**
 * 群成员单独私信 user 的保底按 AI 回合计数，不能复用普通跨窗的消息气泡计数：
 * 群聊一轮可能落很多条气泡，按气泡数会把「每 N 轮」误算成一轮内立即超期；
 * peer_private / backstage 也不能替 private_msg 销掉这条独立保底。
 */
export function resolveUserPrivateLinkageOverdue(chat = {}, nudgeEvery = DEFAULT_LINKAGE_NUDGE_EVERY) {
  const every = Math.max(
    LINKAGE_NUDGE_EVERY_MIN,
    Math.min(LINKAGE_NUDGE_EVERY_MAX, Math.round(Number(nudgeEvery) || DEFAULT_LINKAGE_NUDGE_EVERY)),
  );
  const nextTurn = resolveNextLinkageTurn(chat);
  const lastTurn = Math.max(
    0,
    Math.round(Number(chat?.metadata?.linkageLastUserPrivateTurn || 0) || 0),
  );
  const turnsSinceLast = lastTurn > 0
    ? Math.max(0, nextTurn - lastTurn)
    : nextTurn;
  const softAt = Math.max(2, Math.ceil(every / 2));
  if (turnsSinceLast >= every) return 'hard';
  if (turnsSinceLast >= softAt) return 'soft';
  return 'none';
}

export function resolveLinkageTurnOverdue(chat = {}, nudgeEvery = DEFAULT_LINKAGE_NUDGE_EVERY) {
  const every = Math.max(
    LINKAGE_NUDGE_EVERY_MIN,
    Math.min(LINKAGE_NUDGE_EVERY_MAX, Math.round(Number(nudgeEvery) || DEFAULT_LINKAGE_NUDGE_EVERY)),
  );
  const history = getLinkageRouteHistory(chat);
  const latest = history[history.length - 1];
  // 旧版台账没有 turn，只能由调用方暂时退回时间戳/消息数算法。
  if (latest && !latest.turn) return null;
  const nextTurn = resolveNextLinkageTurn(chat);
  const turnsSinceLast = latest?.turn
    ? Math.max(0, nextTurn - latest.turn)
    : nextTurn;
  const softAt = Math.max(2, Math.ceil(every / 2));
  if (turnsSinceLast >= every) return 'hard';
  if (turnsSinceLast >= softAt) return 'soft';
  return 'none';
}

/**
 * 当前即将生成的一轮是否为自定义节奏的开放轮。
 * 自然模式始终开放；自定义模式从上一次真正落地的联动起每 N 轮到期。
 * 到期轮若模型没有成功落地跨窗动作，不应消耗本次间隔，下一轮继续保持到期。
 */
export function resolveLinkageIntervalState(chat = {}) {
  const mode = resolveLinkageCadenceMode(chat);
  const intervalTurns = resolveLinkageMinIntervalTurns(chat);
  if (mode === 'natural' || intervalTurns <= 1) {
    return {
      mode,
      intervalTurns,
      allowed: true,
      remainingTurns: 0,
      turnsSinceLastOpportunity: null,
    };
  }
  const nextTurn = resolveNextLinkageTurn(chat);
  const lastOpportunityTurn = Math.max(
    0,
    Math.round(Number(chat?.metadata?.linkageLastOpportunityTurn || 0) || 0),
  );
  if (!lastOpportunityTurn) {
    return {
      mode,
      intervalTurns,
      allowed: true,
      remainingTurns: 0,
      turnsSinceLastOpportunity: null,
    };
  }
  const turnsSinceLastOpportunity = Math.max(0, nextTurn - lastOpportunityTurn);
  const remainingTurns = Math.max(0, intervalTurns - turnsSinceLastOpportunity);
  return {
    mode,
    intervalTurns,
    allowed: remainingTurns === 0,
    remainingTurns,
    turnsSinceLastOpportunity,
  };
}

export function shouldConsumeLinkageInterval(intervalState = {}, linkageRoute = '', options = {}) {
  if (options.requireUserPrivate === true && Number(options.userPrivateHandled || 0) <= 0) {
    return false;
  }
  return intervalState.mode === 'custom'
    && intervalState.allowed === true
    && ['private', 'group', 'mixed'].includes(String(linkageRoute || ''));
}

export function isCrossWindowLinkageEvent(event = {}) {
  if (['backstage', 'peer_private', 'private_msg'].includes(String(event?.t || ''))) return true;
  return event?.t === 'chat_bundle' && Boolean(event?.to);
}

export function filterCrossWindowLinkageEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => !isCrossWindowLinkageEvent(event));
}

export function summarizeLinkageRouteHistory(chat = {}) {
  const history = getLinkageRouteHistory(chat);
  let groupUnits = 0;
  let privateUnits = 0;
  let frontstageGroupUnits = 0;
  let backstageGroupUnits = 0;
  let consecutiveWithoutGroup = 0;
  let consecutiveWithoutFrontstageGroup = 0;
  let consecutiveWithoutBackstageGroup = 0;
  for (const entry of history) {
    if (entry.route === 'group') groupUnits += 1;
    else if (entry.route === 'private') privateUnits += 1;
    else {
      groupUnits += 1;
      privateUnits += 1;
    }
    if (entry.frontstageGroup === true) frontstageGroupUnits += 1;
    if (entry.backstageGroup === true) backstageGroupUnits += 1;
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].route === 'group' || history[index].route === 'mixed') break;
    consecutiveWithoutGroup += 1;
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].frontstageGroup === true) break;
    consecutiveWithoutFrontstageGroup += 1;
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].backstageGroup === true) break;
    consecutiveWithoutBackstageGroup += 1;
  }
  const totalUnits = groupUnits + privateUnits;
  const explicitGroupUnits = frontstageGroupUnits + backstageGroupUnits;
  return {
    history,
    groupUnits,
    privateUnits,
    groupShare: totalUnits ? groupUnits / totalUnits : 0.5,
    consecutiveWithoutGroup,
    frontstageGroupUnits,
    backstageGroupUnits,
    frontstageGroupShare: explicitGroupUnits
      ? frontstageGroupUnits / explicitGroupUnits
      : DEFAULT_LINKAGE_FRONTSTAGE_GROUP_SHARE,
    consecutiveWithoutFrontstageGroup,
    consecutiveWithoutBackstageGroup,
    lastAt: history.length ? Number(history[history.length - 1].at || 0) : 0,
  };
}

export function resolveLinkageRouteGuidance(chat = {}) {
  const bias = resolveLinkageRouteBias(chat);
  const pityEvery = resolveLinkageGroupPityEvery(chat);
  const summary = summarizeLinkageRouteHistory(chat);
  const targetGroupShare = LINKAGE_GROUP_TARGETS[bias] ?? LINKAGE_GROUP_TARGETS.balanced;
  const groupPityDue = summary.consecutiveWithoutGroup >= pityEvery;
  const frontstageGroupPityDue = summary.consecutiveWithoutFrontstageGroup
    >= DEFAULT_LINKAGE_FRONTSTAGE_PITY_EVERY;
  const backstageGroupPityDue = summary.consecutiveWithoutBackstageGroup
    >= DEFAULT_LINKAGE_BACKSTAGE_PITY_EVERY;
  const preferredRoute = groupPityDue
    ? 'group'
    : (Math.abs(summary.groupShare - targetGroupShare) < 0.08
      ? 'balanced'
      : (summary.groupShare < targetGroupShare ? 'group' : 'private'));
  return {
    ...summary,
    bias,
    pityEvery,
    targetGroupShare,
    groupPityDue,
    frontstageGroupPityDue,
    backstageGroupPityDue,
    targetFrontstageGroupShare: DEFAULT_LINKAGE_FRONTSTAGE_GROUP_SHARE,
    preferredGroupAudience: backstageGroupPityDue
      ? 'backstage'
      : (frontstageGroupPityDue
        || summary.frontstageGroupShare < DEFAULT_LINKAGE_FRONTSTAGE_GROUP_SHARE
        ? 'frontstage'
        : 'balanced'),
    preferredRoute,
  };
}

export function classifyLinkageAudienceOutcome(options = {}) {
  const backstageSaved = Array.isArray(options.backstageSaved) ? options.backstageSaved : [];
  const sendLogs = Array.isArray(options.sendLogs) ? options.sendLogs.map((line) => String(line || '').trim()) : [];
  const hasPrivate = Number(options.privateHandled || 0) > 0
    || backstageSaved.some((entry) => entry?.kind === 'peer_private')
    || sendLogs.some((line) => /^(?:私聊→|角色私聊)/.test(line));
  const hasFrontstageGroup = sendLogs.some((line) => (
    /^群聊「/.test(line)
    || /^建群（含用户/.test(line)
  ));
  const hasBackstageGroup = backstageSaved.some((entry) => entry?.kind === 'backstage')
    || sendLogs.some((line) => /^(?:幕后|建群（无用户|建群（复用幕后群)/.test(line));
  // 旧版本的无受众建群日志只能继续按“发生过群聊”兼容，不能反推成前台群并清掉前台保底。
  const hasLegacyUnscopedGroup = sendLogs.some((line) => /^建群「/.test(line));
  const hasGroup = hasFrontstageGroup || hasBackstageGroup || hasLegacyUnscopedGroup;
  return {
    route: hasPrivate && hasGroup ? 'mixed' : (hasGroup ? 'group' : (hasPrivate ? 'private' : '')),
    hasPrivate,
    hasFrontstageGroup,
    hasBackstageGroup,
  };
}

export function classifyLinkageRouteOutcome(options = {}) {
  return classifyLinkageAudienceOutcome(options).route;
}

export function resolveAllowPrivateSend(chat, prefs = {}) {
  if (isNoUserGroup(chat) && resolveUserTopicPolicy(chat) === 'off') return false;
  const groupSettings = chat?.groupSettings && typeof chat.groupSettings === 'object'
    ? chat.groupSettings
    : {};
  const hasChatSetting = Object.prototype.hasOwnProperty.call(groupSettings, 'allowPrivateLinkage');
  const hasLegacyPref = Object.prototype.hasOwnProperty.call(prefs, 'allowPrivateLinkage');
  // 当前详情页写入 groupSettings；它必须覆盖旧版本遗留在 chatPrefs 里的同名值，
  // 否则 UI 显示“已开启”，执行层却仍被一条不可见的旧 false 永久拦住。
  if (hasChatSetting) return groupSettings.allowPrivateLinkage === true;
  if (hasLegacyPref) return prefs.allowPrivateLinkage === true;
  if (isAnonymousChat(chat) && chat?.type === 'group') return true;
  // 旧的无 user 群没有显式字段，历史行为允许偶发私信；显式 false 始终优先。
  if (isNoUserGroup(chat)) return true;
  return false;
}

export function getInnerVoiceDisplayForMessage(msg = {}) {
  const inner = String(msg.metadata?.innerVoice || '').trim();
  const mood = String(msg.metadata?.mood || '').trim();
  const parts = [];
  if (inner) parts.push(`心声：${inner}`);
  if (mood) parts.push(`情绪：${mood}`);
  return parts.join('\n');
}

export function formatBubbleHiddenStateText(msg = {}) {
  const text = getInnerVoiceDisplayForMessage(msg);
  return text || '这条消息没有额外心声/状态信息。';
}

export function getPrivateLinkageIds(chat = {}, prefs = {}) {
  const fromPrefs = Array.isArray(prefs.privateLinkageIds) ? prefs.privateLinkageIds : [];
  if (fromPrefs.length) return fromPrefs.filter(Boolean);
  const fromGroup = Array.isArray(chat.groupSettings?.linkagePrivateMemberIds)
    ? chat.groupSettings.linkagePrivateMemberIds
    : [];
  return fromGroup.filter(Boolean);
}
