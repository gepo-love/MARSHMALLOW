export const STATUS_ACTIVITY_LEVELS = Object.freeze(['quiet', 'natural', 'active']);
export const DEFAULT_STATUS_ACTIVITY_LEVEL = 'natural';

const STATUS_ACTIVITY_RULES = Object.freeze({
  quiet: Object.freeze({
    minCooldownMs: 4 * 60 * 60 * 1000,
    dailyLimit: 2,
    pityMisses: 4,
    staleMs: 12 * 60 * 60 * 1000,
    emptyRefillMs: 90 * 60 * 1000,
  }),
  natural: Object.freeze({
    minCooldownMs: 2 * 60 * 60 * 1000,
    dailyLimit: 4,
    pityMisses: 3,
    staleMs: 6 * 60 * 60 * 1000,
    emptyRefillMs: 30 * 60 * 1000,
  }),
  active: Object.freeze({
    minCooldownMs: 60 * 60 * 1000,
    dailyLimit: 6,
    pityMisses: 2,
    staleMs: 3 * 60 * 60 * 1000,
    emptyRefillMs: 10 * 60 * 1000,
  }),
});

function dayKey(timestamp = Date.now()) {
  const date = new Date(Number(timestamp) || Date.now());
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function normalizeStatusActivityLevel(value = '') {
  const level = String(value || '').trim().toLowerCase();
  return STATUS_ACTIVITY_LEVELS.includes(level) ? level : DEFAULT_STATUS_ACTIVITY_LEVEL;
}

export function resolveStatusActivityRule(realPersonMode = {}) {
  const level = normalizeStatusActivityLevel(realPersonMode?.statusActivityLevel);
  return { level, ...STATUS_ACTIVITY_RULES[level] };
}

export function isStatusOpportunityReason(reason = '') {
  return /schedule-proactive|real-person-chase-beat|real-person-social|real-person-user-moment|idle-continue/i
    .test(String(reason || ''));
}

export function resolveStatusOpportunity({
  prefs = {},
  realPersonMode = {},
  reason = '',
  now = Date.now(),
} = {}) {
  const timestamp = Number(now) || Date.now();
  const rule = resolveStatusActivityRule(realPersonMode);
  const today = dayKey(timestamp);
  const count = prefs.statusActivityDay === today
    ? Math.max(0, Number(prefs.statusActivityCount || 0) || 0)
    : 0;
  const misses = Math.max(0, Number(prefs.statusOpportunityMisses || 0) || 0);
  const statusUpdatedAt = Math.max(0, Number(prefs.statusUpdatedAt || 0) || 0);
  const statusExpiredAt = Math.max(0, Number(prefs.statusExpiredAt || 0) || 0);
  const opportunityStartedAt = Math.max(0, Number(prefs.statusOpportunityStartedAt || 0) || 0);
  const freshnessAnchor = statusUpdatedAt || statusExpiredAt || opportunityStartedAt || timestamp;
  const staleForMs = Math.max(0, timestamp - freshnessAnchor);
  const reasonEligible = isStatusOpportunityReason(reason);
  const emptyStatus = !String(prefs.statusText || '').trim();
  const emptyAnchor = statusExpiredAt || statusUpdatedAt || opportunityStartedAt;
  const emptyRefillReady = emptyStatus && (
    !emptyAnchor || timestamp - emptyAnchor >= rule.emptyRefillMs
  );
  const cooldownReady = emptyStatus
    ? emptyRefillReady
    : (!statusUpdatedAt || timestamp - statusUpdatedAt >= rule.minCooldownMs);
  const dailyReady = count < rule.dailyLimit;
  const pityDue = misses >= rule.pityMisses;
  const staleDue = staleForMs >= rule.staleMs && emptyStatus;
  const bootstrapDue = emptyStatus && emptyRefillReady;
  return {
    ...rule,
    eligible: reasonEligible && cooldownReady && dailyReady,
    forceConsider: reasonEligible && cooldownReady && dailyReady && (bootstrapDue || pityDue || staleDue),
    reasonEligible,
    cooldownReady,
    dailyReady,
    pityDue,
    staleDue,
    bootstrapDue,
    emptyStatus,
    emptyRefillReady,
    misses,
    count,
    today,
    staleForMs,
    now: timestamp,
  };
}

export function buildStatusOpportunityDirective(opportunity = {}, options = {}) {
  if (!opportunity?.eligible) return '';
  const scheduleHint = options.scheduleDriven === true
    ? '日程只提供生活素材，不要求把时段切换、地点或正在做的事逐段抄到顶栏。'
    : '结合这段等待里的心情与表达欲判断，不要为了刷存在感机械换词。';
  if (opportunity.bootstrapDue) {
    return [
      '【顶栏状态机会 · 暂无状态】角色目前没有公开短句，本轮优先自然补一条。',
      scheduleHint,
      '写角色此刻真会公开的一句吐槽、念头、情绪或生活感，不要写成地点、活动播报或日程摘要。除非角色按人设明确不使用公开状态，否则本轮输出 status；禁止用“在线”“忙碌中”这类功能标签凑数。',
      '只要本轮输出 status，就必须同时正常输出可见 msg；气泡数量服从本轮主动动机与表达形状或用户明确设置，不得因为顺手改状态就把整轮压成一条。禁止只有 status/story、没有气泡，也不要把 statusText 原样复制成 msg。',
    ].join('\n');
  }
  if (opportunity.forceConsider) {
    return [
      '【顶栏状态机会 · 已积压】顶栏状态已经较久没有自然更新，本轮必须认真判断一次。',
      scheduleHint,
      '这是没有发生明确转场时的额外刷新机会；场景转场的联动更新不受这里的活跃度冷却限制。顶栏不是活动记录：若角色此刻确实想公开一句新的吐槽、念头或情绪就输出 status，没有新表达就保持，禁止复读旧状态或只换同义词。',
      '只要本轮输出 status，就必须同时正常输出可见 msg；气泡数量服从本轮主动动机与表达形状或用户明确设置，不得因为顺手改状态就把整轮压成一条。禁止只有 status/story、没有气泡，也不要把 statusText 原样复制成 msg。',
    ].join('\n');
  }
  return [
    '【顶栏状态机会】这是一轮适合顺手检查顶栏状态的后台生活节点。',
    scheduleHint,
    '这是没有发生明确转场时的额外刷新机会；场景转场应另行联动更新。顶栏不是活动记录，角色此刻真想公开一句新的吐槽、念头、情绪或生活感时才输出 status；没有新表达就保持。',
    '只要本轮输出 status，就必须同时正常输出可见 msg；气泡数量服从本轮主动动机与表达形状或用户明确设置，不得因为顺手改状态就把整轮压成一条。禁止只有 status/story、没有气泡，也不要把 statusText 原样复制成 msg。',
  ].join('\n');
}

export function buildStatusOpportunityResultPatch({
  prefs = {},
  opportunity = null,
  statusHandled = false,
  now = Date.now(),
} = {}) {
  const timestamp = Number(now) || Date.now();
  const today = dayKey(timestamp);
  const previousCount = prefs.statusActivityDay === today
    ? Math.max(0, Number(prefs.statusActivityCount || 0) || 0)
    : 0;
  if (statusHandled) {
    return {
      statusOpportunityMisses: 0,
      statusLastOpportunityAt: timestamp,
      statusOpportunityStartedAt: Number(prefs.statusOpportunityStartedAt || 0) || timestamp,
      statusActivityDay: today,
      statusActivityCount: previousCount + 1,
    };
  }
  if (!opportunity?.eligible) return {};
  return {
    statusOpportunityMisses: Math.max(0, Number(prefs.statusOpportunityMisses || 0) || 0) + 1,
    statusLastOpportunityAt: timestamp,
    statusOpportunityStartedAt: Number(prefs.statusOpportunityStartedAt || 0) || timestamp,
    statusActivityDay: today,
    statusActivityCount: previousCount,
  };
}
