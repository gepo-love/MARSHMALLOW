import { findTimezoneOptionLabel, listAllTimezoneOptions } from '../../data/timezone-options.js';
import { normalizeCityInput } from '../regional-weather.js';
import { getEffectiveWeatherCityForCharacter } from '../weather-location.js';
import { findPrivateChat } from '../chat-store.js';
import { loadChatPrefs } from '../chat-block-state.js';

/** 预设城市 → IANA 时区（与 regional-weather 城市表同步） */
const CITY_TIMEZONE = {
  北京: 'Asia/Shanghai',
  广州: 'Asia/Shanghai',
  杭州: 'Asia/Shanghai',
  青岛: 'Asia/Shanghai',
  昆明: 'Asia/Shanghai',
  南京: 'Asia/Shanghai',
  西安: 'Asia/Shanghai',
  上海: 'Asia/Shanghai',
  苏州: 'Asia/Shanghai',
  武汉: 'Asia/Shanghai',
  天津: 'Asia/Shanghai',
  成都: 'Asia/Shanghai',
  绵阳: 'Asia/Shanghai',
};

function getTimezoneForCityInput(input = '') {
  const normalized = normalizeCityInput(input);
  if (!normalized) return '';
  return String(CITY_TIMEZONE[normalized] || '').trim();
}

export function normalizeTimezoneId(value, fallback = '') {
  const tz = String(value || '').trim();
  if (!tz) return fallback;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch (_) {
    return fallback;
  }
}

export function resolveBrowserTimezone() {
  try {
    return normalizeTimezoneId(Intl.DateTimeFormat().resolvedOptions().timeZone, '');
  } catch (_) {
    return '';
  }
}

export function resolveUserTimezone(user = {}) {
  const fromPreference = normalizeTimezoneId(user?.timezone, '');
  if (fromPreference) return fromPreference;
  const fromCity = getTimezoneForCityInput(user?.realCityMap || user?.virtualCity || '');
  if (fromCity) return normalizeTimezoneId(fromCity, fromCity);
  return normalizeTimezoneId(resolveBrowserTimezone(), 'Asia/Shanghai');
}

export function resolveCharacterTimezone(prefs = {}, character = null) {
  const fromPrefs = normalizeTimezoneId(prefs?.characterTimezone, '');
  if (fromPrefs) return fromPrefs;
  if (!character) return '';
  const cityInfo = getEffectiveWeatherCityForCharacter(character);
  const fromCity = getTimezoneForCityInput(cityInfo.realCityMap || cityInfo.weatherCity || '');
  return normalizeTimezoneId(fromCity, '');
}

export function isTimezoneAware(prefs = {}, character = null) {
  return prefs?.timezoneEnabled === true && !!resolveCharacterTimezone(prefs, character);
}

/**
 * 注意：不要用 hour12:false + en-US。
 * Chromium / Android WebView 会按 h24 把午夜写成 hour=24，
 * Date.UTC(day, 24) 再进一天，时差会被多算约 24 小时（例如伦敦相对上海变成「慢 31 小时」）。
 * 统一用 hourCycle:'h23'，并把残留的 24 归一成 0。
 */
function timezoneFormatParts(date, timeZone, withSeconds = false) {
  const opts = {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  if (withSeconds) opts.second = '2-digit';
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(date);
  const map = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') map[type] = value;
  }
  const hour = Number(map.hour);
  map.hour = String(hour === 24 ? 0 : hour);
  return map;
}

export function getTimezoneOffsetMs(timeZone, date = new Date()) {
  const tz = normalizeTimezoneId(timeZone, '');
  if (!tz) return 0;
  const map = timezoneFormatParts(date, tz, true);
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second || 0),
  );
  return asUTC - date.getTime();
}

export function computeTimezoneDiffHours(userTimezone, characterTimezone, nowMs = Date.now()) {
  const userTz = normalizeTimezoneId(userTimezone, '');
  const charTz = normalizeTimezoneId(characterTimezone, '');
  if (!userTz || !charTz) return 0;
  const at = new Date(Number(nowMs) || Date.now());
  const diffMs = getTimezoneOffsetMs(charTz, at) - getTimezoneOffsetMs(userTz, at);
  return diffMs / 3600000;
}

export function formatTimezoneOffsetLabel(offsetHours = 0) {
  const raw = Number(offsetHours);
  if (!Number.isFinite(raw) || Math.abs(raw) < 1 / 120) return '无时差';
  const sign = raw > 0 ? '快' : '慢';
  const abs = Math.abs(raw);
  const whole = Math.floor(abs + 1e-9);
  const mins = Math.round((abs - whole) * 60);
  if (mins === 0) return `${sign} ${whole} 小时`;
  if (whole === 0) return `${sign} ${mins} 分钟`;
  return `${sign} ${whole} 小时 ${mins} 分钟`;
}

export function formatClockInTimezone(ts, timezone) {
  const tz = normalizeTimezoneId(timezone, '');
  if (!tz) return '';
  return new Date(Number(ts) || Date.now()).toLocaleString('zh-CN', {
    timeZone: tz,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function timezoneParts(ts, timeZone) {
  const tz = normalizeTimezoneId(timeZone, '');
  if (!tz) return null;
  const at = new Date(Number(ts) || Date.now());
  if (Number.isNaN(at.getTime())) return null;
  try {
    const map = timezoneFormatParts(at, tz, false);
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
    };
  } catch (_) {
    return null;
  }
}

/** 指定 IANA 时区下的日历日 YYYY-MM-DD；无效时区返回空串 */
export function dateKeyInTimezone(ts = Date.now(), timeZone = '') {
  const parts = timezoneParts(ts, timeZone);
  if (!parts || !parts.year || !parts.month || !parts.day) return '';
  const y = parts.year;
  const m = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 指定 IANA 时区下的当日分钟数 0–1439；无效时区返回 -1 */
export function minutesOfDayInTimezone(ts = Date.now(), timeZone = '') {
  const parts = timezoneParts(ts, timeZone);
  if (!parts || !Number.isFinite(parts.hour) || !Number.isFinite(parts.minute)) return -1;
  return Math.max(0, Math.min(1439, parts.hour * 60 + parts.minute));
}

/**
 * 角色手机日程用的当地时区：与聊天「启用时差」同源。
 * 读主私聊 prefs；未启用时差则返回空（日程继续按浏览器本地钟点）。
 */
export async function resolveCharacterScheduleTimezone(userId, characterId, character = null) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return '';
  try {
    const chat = await findPrivateChat(uid, cid);
    const prefs = chat?.id ? await loadChatPrefs(chat.id).catch(() => ({})) : {};
    if (!isTimezoneAware(prefs, character)) return '';
    return resolveCharacterTimezone(prefs, character);
  } catch (_) {
    return '';
  }
}

export function formatTimezoneDisplayName(timezoneId = '') {
  const tz = normalizeTimezoneId(timezoneId, '');
  if (!tz) return '';
  const label = findTimezoneOptionLabel(tz);
  return label === tz ? tz : `${label}（${tz}）`;
}

export function buildTimezoneContext(
  prefs = {},
  user = null,
  character = null,
  nowMs = Date.now(),
  options = {},
) {
  if (!isTimezoneAware(prefs, character)) return null;
  // AI 世界时钟以 timeScheduleWorld_<worldId>.timezone 为权威。调用方已经拿到该值时必须
  // 显式传入，避免 users.timezone 的兼容副本因旧备份/部分写入而与世界时间漂移。
  const userTimezone = normalizeTimezoneId(options?.userTimezone, '')
    || resolveUserTimezone(user);
  const characterTimezone = resolveCharacterTimezone(prefs, character);
  if (!characterTimezone) return null;
  const offsetHours = computeTimezoneDiffHours(userTimezone, characterTimezone, nowMs);
  return {
    userTimezone,
    characterTimezone,
    offsetHours,
    userClock: formatClockInTimezone(nowMs, userTimezone),
    charClock: formatClockInTimezone(nowMs, characterTimezone),
    diffLabel: formatTimezoneOffsetLabel(offsetHours),
    charTimezoneLabel: formatTimezoneDisplayName(characterTimezone),
    userTimezoneLabel: formatTimezoneDisplayName(userTimezone),
  };
}

export function buildTimezoneSelectOptions(selected = '') {
  const normalized = normalizeTimezoneId(selected, '');
  const known = new Set(listAllTimezoneOptions().map((opt) => opt.id));
  const options = listAllTimezoneOptions().map((opt) => ({
    ...opt,
    selected: opt.id === normalized,
  }));
  if (normalized && !known.has(normalized)) {
    options.unshift({
      id: normalized,
      label: normalized,
      group: '已保存',
      selected: true,
    });
  }
  return options;
}

export function buildTimezoneSettingsPreview(
  prefs = {},
  user = null,
  character = null,
  nowMs = Date.now(),
  options = {},
) {
  const ctx = buildTimezoneContext(prefs, user, character, nowMs, options);
  if (!ctx) return '';
  if (Math.abs(ctx.offsetHours) < 1 / 120) {
    return `与你同时区 · TA 当地 ${ctx.charClock}`;
  }
  return `相对你${ctx.diffLabel} · TA 当地 ${ctx.charClock}`;
}

export function buildTimezoneCharacterCardLine(
  prefs = {},
  user = null,
  character = null,
  nowMs = Date.now(),
  options = {},
) {
  const ctx = buildTimezoneContext(prefs, user, character, nowMs, options);
  if (!ctx) return '';
  return [
    `时差：TA 在 ${ctx.charTimezoneLabel}，你在 ${ctx.userTimezoneLabel}`,
    `当前相差 ${ctx.diffLabel}（TA 当地时间约 ${ctx.charClock}，你这边约 ${ctx.userClock}）`,
  ].join('；');
}

export function buildTimezonePromptBlock(
  prefs = {},
  user = null,
  userName = '用户',
  character = null,
  nowMs = Date.now(),
  options = {},
) {
  const ctx = buildTimezoneContext(prefs, user, character, nowMs, options);
  if (!ctx) return '';
  const name = String(userName || '用户').trim() || '用户';
  const aheadBehind = Math.abs(ctx.offsetHours) < 1 / 120
    ? `TA 与 ${name} 在同一时区（${ctx.charTimezoneLabel}）`
    : `TA 在 ${ctx.charTimezoneLabel}，比 ${name} 的 ${ctx.userTimezoneLabel} ${ctx.diffLabel}`;

  const lines = [
    `【时差设定】${aheadBehind}。这是长期设定，聊天全程有效；具体钟点会随夏令时等规则自动变化。`,
    `- 同一绝对时刻的两只墙钟：${name} 这边约 ${ctx.userClock}；TA 当地约 ${ctx.charClock}。两者都正确，不得混成同一个“现在几点”。`,
    `- TA 描述自己的作息、困意、早安/晚安或说“我这边几点”时按 TA 当地时间；描述 ${name} 的手机时间、说“你那边几点”或回应 ${name} 明确报出的钟点时按 ${name} 这边的时间。`,
    `- 未指明“谁那边”的时间表达先结合说话主体判断；若仍有歧义，使用“我这边 / 你那边”说清楚，禁止把 TA 当地时间说成双方共同时间。`,
  ];
  if (Math.abs(ctx.offsetHours) >= 1 / 120) {
    lines.push('- 可以自然流露时差感（「你那边应该还早吧」「我这边都快 midnight 了」），偶尔一句即可，不要每轮复述时差数字。');
    lines.push('- 用户深夜发消息时，TA 那边可能是白天或反之——反应要符合 TA 当地时段，而不是用户的屏幕时间。');
  }
  lines.push('- 不要把时差当成重逢盘问或「你怎么这个点还没睡」的抱怨理由，除非人设本来就这样。');
  return lines.join('\n');
}

export function buildTimezoneHeaderHint(
  prefs = {},
  user = null,
  character = null,
  nowMs = Date.now(),
  options = {},
) {
  const ctx = buildTimezoneContext(prefs, user, character, nowMs, options);
  if (!ctx) return '';
  if (Math.abs(ctx.offsetHours) < 1 / 120) return `TA 当地 ${ctx.charClock}`;
  return `时差 ${ctx.diffLabel} · TA 当地 ${ctx.charClock}`;
}
