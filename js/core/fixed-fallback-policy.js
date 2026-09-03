const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;

export function isFixedFallbackRetryableFailure(reason = '') {
  return /api-|stream|network|timeout|empty-result|upstream|fetch|generation-failed/i.test(
    String(reason || ''),
  );
}

export function isFixedFallbackTerminalFailure(reason = '') {
  return /^(?:missing-character|missing-chat|different-user)$/i.test(String(reason || '').trim());
}

export function fixedFallbackFailureBackoffMs(failureCount = 1) {
  const count = Math.max(1, Math.trunc(Number(failureCount) || 1));
  return Math.min(
    FAILURE_BACKOFF_MAX_MS,
    FAILURE_BACKOFF_BASE_MS * (2 ** Math.min(10, count - 1)),
  );
}

export function getFixedFallbackFailureBackoff(chat = {}, now = Date.now()) {
  const failureAt = Math.max(0, Number(chat?.autoLastFailureAt || 0) || 0);
  const failureCount = Math.max(0, Math.trunc(Number(chat?.autoFailureCount || 0) || 0));
  if (!failureAt || !failureCount) {
    return { active: false, failureAt: 0, failureCount: 0, retryAt: 0, remainingMs: 0 };
  }
  const retryAt = failureAt + fixedFallbackFailureBackoffMs(failureCount);
  return {
    active: retryAt > now,
    failureAt,
    failureCount,
    retryAt,
    remainingMs: Math.max(0, retryAt - now),
  };
}

export function buildFixedFallbackFailurePatch(chat = {}, reason = '', now = Date.now()) {
  const previousAt = Math.max(0, Number(chat?.autoLastFailureAt || 0) || 0);
  const previousCount = Math.max(0, Math.trunc(Number(chat?.autoFailureCount || 0) || 0));
  const stillInFailureSeries = previousAt > 0
    && now - previousAt <= FAILURE_BACKOFF_MAX_MS * 2;
  return {
    autoLastFailureAt: now,
    autoFailureCount: stillInFailureSeries ? previousCount + 1 : 1,
    autoLastFailureReason: String(reason || 'failed').slice(0, 80),
  };
}

export function clearFixedFallbackFailurePatch() {
  return {
    autoLastFailureAt: 0,
    autoFailureCount: 0,
    autoLastFailureReason: '',
  };
}

/**
 * 固定间隔主动推进只属于正常主私聊与群聊。
 * 陌生/马甲窗有独立的投递链路，复用角色 ID 不代表它能承接本体主动消息。
 */
export function isFixedFallbackChatEligible(chat = {}) {
  return String(chat?.metadata?.channelKind || '') !== 'stranger_intercept'
    && chat?.metadata?.firstEncounterPending !== true;
}

export function selectDueFixedFallbackChats(chats = [], now = Date.now()) {
  return (Array.isArray(chats) ? chats : [])
    .filter((chat) => chat?.autoActive === true)
    .filter((chat) => isFixedFallbackChatEligible(chat))
    .filter((chat) => (
      now - Number(chat.autoLastTriggeredAt || 0)
      >= Math.max(60000, Number(chat.autoInterval) || 300000)
    ))
    .sort((left, right) => (
      Number(left.autoLastTriggeredAt || 0) - Number(right.autoLastTriggeredAt || 0)
      || Number(left.lastActivity || 0) - Number(right.lastActivity || 0)
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
}
