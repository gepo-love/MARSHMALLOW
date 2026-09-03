/** 用户世界时钟使用的 IANA 时区工具。时间戳始终保存为绝对时刻，仅显示与录入按时区换算。 */

export function normalizeUserTimezone(value, fallback = '') {
  const timeZone = String(value || '').trim();
  if (!timeZone) return fallback;
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch (_) {
    return fallback;
  }
}

export function getBrowserTimezone() {
  try {
    return normalizeUserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Shanghai');
  } catch (_) {
    return 'Asia/Shanghai';
  }
}

export function getEffectiveUserTimezone(preference = '') {
  return normalizeUserTimezone(preference, '') || getBrowserTimezone();
}

export function getZonedDateParts(ts = Date.now(), timeZone = '') {
  const zone = getEffectiveUserTimezone(timeZone);
  const date = new Date(Number(ts) || Date.now());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const hour = Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function dateKeyInUserTimezone(ts = Date.now(), timeZone = '') {
  const p = getZonedDateParts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 把绝对时间戳显示为用户世界时区中的 24 小时制钟点。 */
export function formatZonedClock(ts = Date.now(), timeZone = '') {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '';
  const p = getZonedDateParts(value, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function getTimezoneOffsetMs(timeZone = '', ts = Date.now()) {
  const date = new Date(Number(ts) || Date.now());
  const p = getZonedDateParts(date.getTime(), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/**
 * 把指定时区里的墙上时间换成绝对时间戳。二次校正可覆盖大多数夏令时边界；
 * 若遇到不存在的跳时钟点，Intl 会自然归到该时区下一个合法时刻。
 */
export function timestampFromUserWallTime({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
} = {}, timeZone = '') {
  const zone = getEffectiveUserTimezone(timeZone);
  const wallUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const first = wallUtc - getTimezoneOffsetMs(zone, wallUtc);
  const corrected = wallUtc - getTimezoneOffsetMs(zone, first);
  const firstParts = getZonedDateParts(first, zone);
  const correctedParts = getZonedDateParts(corrected, zone);
  const firstWall = Date.UTC(
    firstParts.year, firstParts.month - 1, firstParts.day,
    firstParts.hour, firstParts.minute, firstParts.second,
  );
  const correctedWall = Date.UTC(
    correctedParts.year, correctedParts.month - 1, correctedParts.day,
    correctedParts.hour, correctedParts.minute, correctedParts.second,
  );
  if (correctedWall === wallUtc) return corrected;
  if (firstWall === wallUtc) return first;
  // 夏令时向前跳时，用户可能输入不存在的 02:xx；归到同日下一个合法墙上时刻。
  if (firstWall > wallUtc && correctedWall < wallUtc) return first;
  return Math.abs(firstWall - wallUtc) <= Math.abs(correctedWall - wallUtc) ? first : corrected;
}

/** 供现有本地 Date 日历组件使用的“墙上时间代理”，不应作为绝对时间存库。 */
export function zonedDateProxy(ts = Date.now(), timeZone = '') {
  const p = getZonedDateParts(ts, timeZone);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
}
