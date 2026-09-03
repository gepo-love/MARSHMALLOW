import {
  dateKeyInUserTimezone,
  getZonedDateParts,
  timestampFromUserWallTime,
} from './user-timezone.js';

function positiveTimestamp(value, fallback = 0) {
  const timestamp = Number(value || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

/** 线下收纳只能推进固定虚拟时间线；现实同步与等待现实追平都禁止推进。 */
export function canAdvanceOfflineSettlementTime(schedule = {}) {
  return String(schedule?.timeMode || '') === 'virtual' && schedule?.reconverge !== true;
}

function nextMorningTimestamp(worldNow, timeZone = '') {
  const current = getZonedDateParts(worldNow, timeZone);
  const nextDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1, 8));
  return timestampFromUserWallTime({
    year: nextDay.getUTCFullYear(),
    month: nextDay.getUTCMonth() + 1,
    day: nextDay.getUTCDate(),
    hour: 8,
  }, timeZone);
}

/**
 * 线下收纳的时长选项表示“从本场开始算到总时长”，不是从点击收纳起追加。
 * 返回 0 代表不推进。
 */
export function resolveOfflineSettlementTarget({
  startedAtWorld = 0,
  worldNow = Date.now(),
  selection = '',
  customHours = 0,
  timeZone = '',
} = {}) {
  const now = positiveTimestamp(worldNow, Date.now());
  const start = positiveTimestamp(startedAtWorld, now);
  const raw = String(selection || '').trim();
  if (!raw) return 0;
  if (raw === 'next-morning') return nextMorningTimestamp(now, timeZone);
  if (raw === 'custom') {
    const hours = Math.max(0.5, Number(customHours || 0) || 0);
    return start + hours * 3600000;
  }
  const duration = Math.max(0, Number(raw) || 0);
  return duration > 0 ? start + duration : 0;
}

export function describeOfflineSettlementTiming({
  startedAtWorld = 0,
  worldNow = Date.now(),
  targetTs = 0,
  timeZone = '',
} = {}) {
  const now = positiveTimestamp(worldNow, Date.now());
  const start = positiveTimestamp(startedAtWorld, now);
  const target = positiveTimestamp(targetTs, 0);
  const willAdvance = target > now;
  return {
    startTs: start,
    worldNow: now,
    targetTs: target,
    deltaMs: willAdvance ? target - now : 0,
    willAdvance,
    crossesStartDay: !!target
      && dateKeyInUserTimezone(start, timeZone) !== dateKeyInUserTimezone(target, timeZone),
    crossesCurrentDay: !!target
      && dateKeyInUserTimezone(now, timeZone) !== dateKeyInUserTimezone(target, timeZone),
  };
}
