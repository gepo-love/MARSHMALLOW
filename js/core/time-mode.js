/**
 * 时间模式：现实同步 / 虚拟时间轴（按用户档位存档）
 */

import * as db from './db.js';
import { buildHolidayPromptBlock } from './civic-calendar.js';
import { resolveWorldIdForUser } from './world-scope.js';
import {
  getEffectiveUserTimezone,
  getZonedDateParts,
  normalizeUserTimezone,
  timestampFromUserWallTime,
} from './user-timezone.js';

export const TIME_MODE_REAL = 'real';
export const TIME_MODE_VIRTUAL = 'virtual';
export const TIME_SCHEDULE_CHANGED_EVENT = 'marshmallow-time-schedule-changed';

function scheduleSettingsKey(worldId) {
  return `timeScheduleWorld_${String(worldId || '').trim()}`;
}

function legacyScheduleSettingsKey(userId) {
  return `timeSchedule_${String(userId || '').trim()}`;
}

/**
 * ensureTimeSchedule 在一次发送/一轮 AI 回合里会被间接调用很多次（时间提示、节日提示、
 * 时间流逝提示、时间戳分配……），原来每次都单独 db.get 一次 IndexedDB，纯属重复劳动。
 * 这里加一层内存缓存；档位只会通过本文件内的 persistSchedule 修改，写入时同步更新缓存即可。
 */
const _scheduleCache = new Map();
const _userWorldIdCache = new Map();

db.onStoreWrite('users', () => {
  _userWorldIdCache.clear();
});

async function resolveScheduleScope(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return { userId: '', worldId: '' };
  let worldId = _userWorldIdCache.get(id);
  if (!worldId) {
    worldId = await resolveWorldIdForUser(id);
    _userWorldIdCache.set(id, worldId || id);
  }
  return { userId: id, worldId: worldId || id };
}

export function defaultVirtualAnchorTs(base = Date.now(), timeZone = '') {
  const p = getZonedDateParts(Number(base) || Date.now(), timeZone);
  return timestampFromUserWallTime({
    year: p.year,
    month: p.month,
    day: p.day,
    hour: 9,
  }, timeZone);
}

function normalizeScheduleRecord(raw = {}) {
  const v = raw && typeof raw === 'object' ? { ...raw } : {};
  const mode = String(v.timeMode || TIME_MODE_REAL).trim();
  v.timeMode = mode === TIME_MODE_VIRTUAL ? TIME_MODE_VIRTUAL : TIME_MODE_REAL;
  if (typeof v.anchorReal !== 'number') v.anchorReal = Date.now();
  if (typeof v.anchorVirtual !== 'number') v.anchorVirtual = defaultVirtualAnchorTs(v.anchorReal);
  if (typeof v.speed !== 'number' || !Number.isFinite(v.speed) || v.speed <= 0) v.speed = 1;
  if (typeof v.paused !== 'boolean') v.paused = false;
  if (typeof v.pauseOnBackground !== 'boolean') v.pauseOnBackground = false;
  v.pauseReason = v.paused && v.pauseReason === 'background' ? 'background' : (v.paused ? 'manual' : '');
  if (typeof v.aiTimeBlind !== 'boolean') v.aiTimeBlind = false;
  v.timezone = normalizeUserTimezone(v.timezone, '');
  // 时间债追平模式（reconverge）：剧情时间领先现实，世界钟停在剧情锚点上等现实自然追上；
  // 现实一旦追平就自动切回现实同步。期间新消息仍从锚点向前签发，时间戳永不倒挂。
  if (typeof v.reconverge !== 'boolean') v.reconverge = false;
  return v;
}

async function persistSchedule(userId, patch = {}) {
  const id = String(userId || '').trim();
  if (!id) return normalizeScheduleRecord(patch);
  const { worldId } = await resolveScheduleScope(id);
  const prev = await ensureTimeSchedule(id);
  const next = normalizeScheduleRecord({ ...prev, ...(patch || {}) });
  await db.put({ key: scheduleSettingsKey(worldId), value: next });
  _scheduleCache.set(worldId, next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(TIME_SCHEDULE_CHANGED_EVENT, {
      detail: { userId: id, worldId, schedule: next },
    }));
  }
  return next;
}

export async function ensureTimeSchedule(userId) {
  const id = String(userId || '').trim();
  if (!id) return normalizeScheduleRecord({});
  const { worldId } = await resolveScheduleScope(id);
  const cached = _scheduleCache.get(worldId);
  if (cached) return cached;
  const key = scheduleSettingsKey(worldId);
  const row = await db.get(key);
  // 旧版本按 userId 存时间表。同档身份首次升级时优先继承档位根身份，
  // 找不到再继承当前身份，之后统一写入 worldId 键。
  const legacyWorldRow = row?.value ? null : await db.get(legacyScheduleSettingsKey(worldId));
  const legacyUserRow = row?.value || legacyWorldRow?.value
    ? null
    : await db.get(legacyScheduleSettingsKey(id));
  const sourceValue = row?.value || legacyWorldRow?.value || legacyUserRow?.value;
  const normalized = normalizeScheduleRecord(sourceValue || { timeMode: TIME_MODE_REAL });
  if (!row?.value || JSON.stringify(row.value) !== JSON.stringify(normalized)) {
    await db.put({ key, value: normalized });
  }
  _scheduleCache.set(worldId, normalized);
  return normalized;
}

export async function getTimeMode(userId) {
  const schedule = await ensureTimeSchedule(userId);
  return schedule.timeMode === TIME_MODE_VIRTUAL ? TIME_MODE_VIRTUAL : TIME_MODE_REAL;
}

/** 空字符串表示跟随当前设备时区；返回值始终是可用的 IANA 时区。 */
export async function getUserTimezone(userId) {
  const schedule = await ensureTimeSchedule(userId);
  return getEffectiveUserTimezone(schedule.timezone);
}

export async function getUserTimezonePreference(userId) {
  const schedule = await ensureTimeSchedule(userId);
  return normalizeUserTimezone(schedule.timezone, '');
}

export async function setUserTimezone(userId, timeZone = '') {
  const id = String(userId || '').trim();
  if (!id) return null;
  const requested = String(timeZone || '').trim();
  const normalized = requested ? normalizeUserTimezone(requested, '') : '';
  if (requested && !normalized) throw new Error('无效时区');
  return persistSchedule(id, { timezone: normalized });
}

/** 是否对 AI 屏蔽时间感应（开启后不向上下文注入任何时间 / 节假日提示） */
export async function getAiTimeBlind(userId) {
  const schedule = await ensureTimeSchedule(userId);
  return !!schedule.aiTimeBlind;
}

export async function setAiTimeBlind(userId, on) {
  const id = String(userId || '').trim();
  if (!id) return null;
  return persistSchedule(id, { aiTimeBlind: !!on });
}

export async function getVirtualNow(userId) {
  return getNowForUser(userId);
}

/** 内存里已有时间档位时同步取时刻，避免发送前多等一次 IndexedDB */
export function peekNowForUser(userId) {
  const id = String(userId || '').trim();
  if (!id) return Date.now();
  const worldId = _userWorldIdCache.get(id) || id;
  const schedule = _scheduleCache.get(worldId);
  if (!schedule) return null;
  if (schedule.timeMode !== TIME_MODE_VIRTUAL) {
    return Date.now();
  }
  if (schedule.reconverge) {
    // 追平模式：现实没追上前世界钟停在剧情锚点；追上后即现实时刻（异步路径会顺手切回现实同步）
    return Math.max(Date.now(), Number(schedule.anchorVirtual) || 0);
  }
  if (schedule.paused) {
    return schedule.anchorVirtual;
  }
  const elapsed = Date.now() - schedule.anchorReal;
  return schedule.anchorVirtual + elapsed * schedule.speed;
}

/** 聊天时间戳 / AI 时间提示用的「当前时刻」 */
export async function getNowForUser(userId) {
  const schedule = await ensureTimeSchedule(userId);
  if (schedule.timeMode !== TIME_MODE_VIRTUAL) {
    return Date.now();
  }
  if (schedule.reconverge) {
    const target = Number(schedule.anchorVirtual) || 0;
    const realNow = Date.now();
    if (realNow >= target) {
      // 现实追平剧情：无缝切回现实同步。之后新消息时间戳 >= 追平点，永不倒挂。
      await persistSchedule(userId, {
        timeMode: TIME_MODE_REAL,
        reconverge: false,
        anchorVirtual: realNow,
        anchorReal: realNow,
        paused: false,
      });
      return realNow;
    }
    return target;
  }
  if (schedule.paused) {
    return schedule.anchorVirtual;
  }
  const elapsed = Date.now() - schedule.anchorReal;
  return schedule.anchorVirtual + elapsed * schedule.speed;
}

/**
 * 后台节奏钟：专供冷却、待办到期、主动消息间隔这类「节奏判断」使用的当前时刻。
 * 与 getNowForUser 唯一的区别在「时间债追平」期间：世界钟冻结在剧情锚点等现实追上，
 * 若节奏判断也跟着冻结，追平前（可能长达一整天）主动消息冷却永远不走、延时回复永远不到点，
 * 用户会整段收不到弹窗。这里让节奏钟从锚点起按现实速度继续前进。
 * 消息时间戳仍必须用 getNowForUser（保持时间线单调、不倒挂）。
 * 注意：追平完成瞬间节奏钟会回落到现实时刻，消费方比较间隔时要容忍「上次时刻在未来」（负差按已过期处理）。
 */
export async function getPacingNowForUser(userId) {
  const schedule = await ensureTimeSchedule(userId);
  if (schedule.timeMode === TIME_MODE_VIRTUAL && schedule.reconverge) {
    const target = Number(schedule.anchorVirtual) || 0;
    const realNow = Date.now();
    if (realNow < target) {
      const anchorReal = Number(schedule.anchorReal) || realNow;
      return target + Math.max(0, realNow - anchorReal);
    }
  }
  return getNowForUser(userId);
}

/**
 * 世界时间整段向前跳（线下收纳推进 / 日程表手动推进 / 跳转到）后调用：
 * 推进前还活着、推进后会被判「早已过期」的排队待办（延时回复、追发等）把过期时限顺延，
 * 让它们在推进后的下一轮扫描立即执行，而不是被静默丢弃。
 * 动态 import 避免 core/time-mode 与 chat/pending-actions 的静态循环依赖。
 */
async function rebasePendingActionsAfterTimeJump(userId, fromTs, toTs) {
  if (!(Number(toTs) > Number(fromTs))) return;
  try {
    const mod = await import('./chat/pending-actions.js');
    await mod.rebasePendingActionExpiryForTimeJump?.(userId, { fromTs, toTs });
  } catch (_) {
    // 待办模块加载失败不阻塞时间推进本身
  }
}

export async function setTimeMode(userId, mode) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const nextMode = String(mode) === TIME_MODE_REAL ? TIME_MODE_REAL : TIME_MODE_VIRTUAL;
  const prev = await ensureTimeSchedule(id);
  const nowReal = Date.now();
  // 时间债未追平时切回「现实同步」：不把世界钟回拨到剧情锚点之前——
  // 否则新消息时间戳会落在刚收纳的线下消息之前（时间倒挂）。保持追平档位，
  // getNowForUser 在现实追上锚点后会自动无缝切回现实同步；
  // 确要立即回拨的用户可用「跳转到」显式选择时刻。
  if (
    nextMode === TIME_MODE_REAL
    && prev.timeMode === TIME_MODE_VIRTUAL
    && prev.reconverge === true
    && Number(prev.anchorVirtual || 0) > nowReal
  ) {
    return prev;
  }
  let anchorVirtual = prev.anchorVirtual;
  if (nextMode === TIME_MODE_REAL) {
    anchorVirtual = nowReal;
  } else if (nextMode === TIME_MODE_VIRTUAL && prev.timeMode === TIME_MODE_REAL) {
    anchorVirtual = defaultVirtualAnchorTs(nowReal, getEffectiveUserTimezone(prev.timezone));
  }
  return persistSchedule(id, {
    timeMode: nextMode,
    anchorVirtual,
    anchorReal: nowReal,
    paused: false,
    pauseReason: '',
    reconverge: false,
  });
}

/** 手动暂停 / 继续世界时间。暂停只改变剧情钟，不改用户已选择的时区与其它设置。 */
export async function setVirtualTimePaused(userId, paused) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const shouldPause = paused === true;
  const schedule = await ensureTimeSchedule(id);
  if (shouldPause) {
    const now = await getNowForUser(id);
    return persistSchedule(id, {
      timeMode: TIME_MODE_VIRTUAL,
      anchorVirtual: now,
      anchorReal: Date.now(),
      paused: true,
      pauseReason: 'manual',
      reconverge: false,
    });
  }
  if (schedule.timeMode !== TIME_MODE_VIRTUAL || schedule.paused !== true) return schedule;
  return persistSchedule(id, {
    anchorVirtual: Number(schedule.anchorVirtual || 0) || Date.now(),
    anchorReal: Date.now(),
    paused: false,
    pauseReason: '',
  });
}

export async function setPauseTimeOnBackground(userId, enabled) {
  const id = String(userId || '').trim();
  if (!id) return null;
  return persistSchedule(id, { pauseOnBackground: enabled === true });
}

/** 根据页面可见性应用“切到后台时暂停”；手动暂停不会在回到前台时被误解除。 */
export async function syncTimePauseWithVisibility(userId, hidden) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const schedule = await ensureTimeSchedule(id);
  if (schedule.pauseOnBackground !== true || schedule.timeMode !== TIME_MODE_VIRTUAL) return schedule;
  if (hidden) {
    if (schedule.paused) return schedule;
    const now = await getNowForUser(id);
    return persistSchedule(id, {
      anchorVirtual: now,
      anchorReal: Date.now(),
      paused: true,
      pauseReason: 'background',
    });
  }
  if (!schedule.paused || schedule.pauseReason !== 'background') return schedule;
  return persistSchedule(id, {
    anchorReal: Date.now(),
    paused: false,
    pauseReason: '',
  });
}

let timeVisibilityPauseBound = false;
let timeVisibilityPauseQueue = Promise.resolve();

export function initTimeVisibilityPause() {
  if (timeVisibilityPauseBound || typeof document === 'undefined') return;
  timeVisibilityPauseBound = true;
  const sync = () => {
    timeVisibilityPauseQueue = timeVisibilityPauseQueue.catch(() => {}).then(async () => {
      const row = await db.get('currentUserId').catch(() => null);
      const userId = String(row?.value || '').trim();
      if (userId) await syncTimePauseWithVisibility(userId, document.hidden).catch(() => null);
    });
  };
  document.addEventListener('visibilitychange', sync);
  window.addEventListener?.('pageshow', sync);
  window.addEventListener?.('current-user-changed', sync);
  sync();
}

export async function setVirtualNow(userId, virtualTs) {
  const id = String(userId || '').trim();
  const next = Number(virtualTs || 0);
  if (!id || !Number.isFinite(next) || next <= 0) return null;
  const prevNow = await getNowForUser(id);
  const persisted = await persistSchedule(id, {
    timeMode: TIME_MODE_VIRTUAL,
    anchorVirtual: next,
    anchorReal: Date.now(),
    paused: false,
    pauseReason: '',
    reconverge: false,
  });
  await rebasePendingActionsAfterTimeJump(id, prevNow, next);
  return persisted;
}

export async function resetVirtualTimeAnchor(userId, anchorTs) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const anchor = Number.isFinite(Number(anchorTs)) ? Number(anchorTs) : defaultVirtualAnchorTs();
  return persistSchedule(id, {
    timeMode: TIME_MODE_VIRTUAL,
    anchorVirtual: anchor,
    anchorReal: Date.now(),
    paused: false,
    pauseReason: '',
    reconverge: false,
  });
}

export function formatPromptTimeLine(ts = Date.now(), timeZone = '') {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const zone = getEffectiveUserTimezone(timeZone);
  const p = getZonedDateParts(d.getTime(), zone);
  const wdNames = ['日', '一', '二', '三', '四', '五', '六'];
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(d);
  const wdIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const wd = wdNames[Math.max(0, wdIndex)];
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${p.year}年${p.month}月${p.day}日 星期${wd} ${hh}:${mm}`;
}

export function formatGapHint(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return '';
  const min = Math.round(n / 60000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟`;
  const hr = Math.round(n / 3600000);
  if (hr < 24) return `${hr} 小时`;
  const day = Math.round(n / 86400000);
  return `${day} 天`;
}

function timeSlotLabel(ts = Date.now(), timeZone = '') {
  const h = getZonedDateParts(ts, timeZone).hour;
  if (h < 5) return '深夜/凌晨';
  if (h < 9) return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚间';
  return '深夜/凌晨';
}

export async function buildVirtualTimeSnippet(userId, nowOverride = 0) {
  const requestedNow = Number(nowOverride || 0);
  const ts = Number.isFinite(requestedNow) && requestedNow > 0
    ? requestedNow
    : await getNowForUser(userId);
  const schedule = await ensureTimeSchedule(userId);
  const timeZone = getEffectiveUserTimezone(schedule.timezone);
  const mode = schedule.timeMode === TIME_MODE_VIRTUAL ? TIME_MODE_VIRTUAL : TIME_MODE_REAL;
  return {
    now: ts,
    line: formatPromptTimeLine(ts, timeZone),
    slot: timeSlotLabel(ts, timeZone),
    timeZone,
    timeMode: mode,
    reconverge: mode === TIME_MODE_VIRTUAL && schedule.reconverge === true,
  };
}

function buildTimeOfDayGuard(ts = Date.now(), timeZone = '') {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const hour = getZonedDateParts(d.getTime(), timeZone).hour;
  if (hour < 5) {
    return '当前处于凌晨/深夜：不要默认写「早安」、起床、冲早咖啡、上班通勤或白天安排；除非上下文明确通宵、早班、时差或刚睡醒，否则按半夜/睡前/熬夜/刚被消息碰醒的生活状态处理。';
  }
  if (hour < 11) {
    return '当前处于早晨/上午：可以自然出现早安、早餐、咖啡、通勤或刚开始一天，但仍要贴合角色日程与上下文。';
  }
  if (hour < 14) {
    return '当前处于中午/午后：不要写成刚起床的早晨，除非角色确实昼夜颠倒；可自然带午饭、午休、出门体感。';
  }
  if (hour < 18) {
    return '当前处于下午：不要写早安或刚开始一天；可自然带工作/上课间隙、下午茶、路上天气。';
  }
  return '当前处于晚上：不要写早安或白天通勤；可自然带晚饭、回家路上、夜间安排。';
}

/** 注入 assembleContext 的 [世界内时间] 长说明 */
export async function getVirtualTimePromptForAi(userId, nowOverride = 0) {
  if (await getAiTimeBlind(userId)) return '';
  const {
    now: ts,
    line,
    slot,
    timeMode,
    reconverge,
    timeZone,
  } = await buildVirtualTimeSnippet(userId, nowOverride);
  const realSync = timeMode === TIME_MODE_REAL;
  const iso = getZonedDateParts(ts, timeZone);
  const isoLike = `${iso.year}-${String(iso.month).padStart(2, '0')}-${String(iso.day).padStart(2, '0')} ${String(iso.hour).padStart(2, '0')}:${String(iso.minute).padStart(2, '0')}`;
  return `[世界内时间·剧情锚定${realSync ? '·现实同步' : ''}]
锚定：${line}
（刻度参考：${isoLike}；角色台词勿机械背诵本行数字）
感知要求：
1) ${realSync
    ? `当前已开启「现实时间同步」：上方锚点来自现实当前日期与用户所选时区（${timeZone}）的钟点，但进入剧情后仍视为故事世界内的现在；不要额外引用系统未提供的现实新闻、天气或现实事件。`
    : (reconverge
      ? '剧情时间因一次线下/快进而暂时领先现实，正处于「等现实自然追上」的阶段：以上方锚点为唯一权威；在追平前世界时间只随剧情缓慢流动，不要按现实日历臆断，也不要主动提及「时间领先/追平」这类系统概念。'
      : '这是存档中的「故事世界时钟」，与手机真实日期/时区无关；用户可在「日程表」推进或跳转虚拟时间，你必须以本锚点为唯一权威。')}
2) 「今天、明天、昨晚、上周、周末、刚下课、一会见面、午饭点、收工」等全部按该世界线理解，禁止按现实日历臆断剧情排期。
3) 聊天记录里每条消息的时间戳也在同一条虚拟时间轴上：越早的消息对应越早的虚拟时刻；不要用现实今天是星期几去硬套角色口中的星期几。
4) 描写熬夜、早起、迟到、摸鱼、食堂/店铺是否还开着等细节前，先对照钟点与星期；当前约「${slot}」，只作背景约束，避免把白天写成深夜收工、把深夜写成午饭闲聊。
5) 作息与场景：虚拟钟点只用于排除与当前锚点明显矛盾的行程、营业状态和生活细节，不直接规定本轮必须聊什么、做什么。
6) 「差一点、一点点、发晕一点」等仍是程度口语，不要误判为具体钟点（如凌晨一点）。`;
}

export async function buildTimePromptBlock(userId, nowOverride = 0) {
  if (await getAiTimeBlind(userId)) return '';
  const timeZone = await getUserTimezone(userId);
  const requestedNow = Number(nowOverride || 0);
  const now = Number.isFinite(requestedNow) && requestedNow > 0
    ? requestedNow
    : await getNowForUser(userId);
  const guard = buildTimeOfDayGuard(now, timeZone);
  const core = await getVirtualTimePromptForAi(userId, now);
  return guard ? `${core}\n${guard}` : core;
}

export async function buildTimeFlowPromptBlock(userId, messages = [], nowOverride = 0) {
  if (await getAiTimeBlind(userId)) return '';
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.deleted && !m.recalled && m.type !== 'system' && m.senderId !== 'system')
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const last = list[list.length - 1];
  if (!last?.timestamp || !userId) return '';
  const requestedNow = Number(nowOverride || 0);
  const nowTs = Number.isFinite(requestedNow) && requestedNow > 0
    ? requestedNow
    : await getNowForUser(userId);
  const delta = Number(nowTs || 0) - Number(last.timestamp || 0);
  if (!Number.isFinite(delta) || delta < 10 * 60 * 1000) return '';
  const staleRule = delta >= 24 * 60 * 60 * 1000
    ? '已经跨天或接近跨天：上一轮里的「马上去做」「等下见」「刚才要去」等短时动作默认已成为过去背景；不要继续执行旧待办。但未回答的关键问题、深谈、争执和关系后果不会仅因跨天自动解决。'
    : delta >= 6 * 60 * 60 * 1000
      ? '已经过去数小时：刚要出门/吃饭/洗澡/晚点回等短时状态默认已经自然结束或转场；本轮按当前时刻重新定位场景。上一轮的情绪峰值可以回落，但深谈、争执、误会或关系变化的余波不能凭空消失。'
      : delta >= 60 * 60 * 1000
        ? '已经过去一段较长时间：短时生活动作先判断为已结束或转场；对话内容则另行判断是否闭环。深谈、冲突、重要问题或明确承诺若没有后续收尾证据，仍保留其未完成感和关系后果；不必硬续原句，但不能当作没发生过。'
        : '只是短暂间隔：可以轻轻续接上一轮，但仍要对照当前时刻，不要把短时承诺无限延长。';
  return [
    '[时间流逝提示]',
    `从上一条消息到现在，在同一条「世界内时间轴」上已过去约 ${formatGapHint(delta)}。`,
    staleRule,
    '旧尾巴处理：短时动作与日程报备过期后只作过去背景；未闭环的深谈、争执、关系确认、重要问题和明确承诺保留其情绪与后果。用户本轮接续时自然承接；用户转向新话题时不必强行翻出，但不得自行宣布问题已解决。',
    '续接方式：如果需要承认中间空缺，用一句自然过渡即可，例如「刚忙完」「后来先去处理了下」「早上醒来才看到」；不要长篇补流水账，也不要连续查岗用户。',
  ].join('\n');
}

export async function buildTimeAndHolidayPromptBlock(userId, nowOverride = 0) {
  if (await getAiTimeBlind(userId)) return '';
  const parts = [];
  const requestedNow = Number(nowOverride || 0);
  const now = Number.isFinite(requestedNow) && requestedNow > 0
    ? requestedNow
    : await getNowForUser(userId);
  const timeBlock = await buildTimePromptBlock(userId, now);
  if (timeBlock) parts.push(timeBlock);
  const holidayBlock = await buildHolidayPromptBlock(userId, now);
  if (holidayBlock) parts.push(holidayBlock);
  return parts.join('\n\n');
}

/**
 * 推进虚拟时间（线下快进 / 时间流逝）。
 * @param {{ reconverge?: boolean }} [options]
 *   reconverge=true：时间债模式——剧情领先现实，现实自然追平后自动回到现实同步；
 *   不传则沿用当前档位（已在追平中就继续追平，经典虚拟保持经典）。
 */
export async function advanceVirtualTime(userId, deltaMs = 0, { reconverge } = {}) {
  const id = String(userId || '').trim();
  const delta = Math.max(0, Number(deltaMs) || 0);
  if (!id || !delta) return null;
  const schedule = await ensureTimeSchedule(id);
  const base = await getNowForUser(id);
  const nextVirtual = base + delta;
  const nextReconverge = typeof reconverge === 'boolean'
    ? reconverge
    : (schedule.timeMode === TIME_MODE_VIRTUAL && schedule.reconverge === true);
  await persistSchedule(id, {
    timeMode: TIME_MODE_VIRTUAL,
    anchorVirtual: nextVirtual,
    anchorReal: Date.now(),
    paused: schedule.paused === true,
    pauseReason: schedule.paused === true ? schedule.pauseReason : '',
    reconverge: nextReconverge,
  });
  await rebasePendingActionsAfterTimeJump(id, base, nextVirtual);
  return nextVirtual;
}

export async function allocateVirtualTimestamps(userId, count = 1, stepMs = 15000) {
  const c = Math.max(1, Number(count) || 1);
  const step = Math.max(1000, Number(stepMs) || 15000);
  const base = await getNowForUser(userId);
  const out = [];
  for (let i = 0; i < c; i += 1) out.push(base + i * step);
  const schedule = userId ? await ensureTimeSchedule(userId) : null;
  if (schedule?.timeMode === TIME_MODE_VIRTUAL && userId) {
    const nextAnchor = base + c * step;
    await persistSchedule(userId, {
      anchorVirtual: nextAnchor,
      anchorReal: Date.now(),
      paused: schedule.paused === true,
      pauseReason: schedule.paused === true ? schedule.pauseReason : '',
    });
  }
  return out;
}

/**
 * 一批实时聊天消息成功落库后，给剧情钟签发对应的消息刻度。
 * “暂停”只停止现实时间自动流逝；用户继续聊天时，气泡仍应逐步向前，
 * 否则整段对话会长期挤在同一分钟。这里只推进虚拟时间，现实同步模式不改钟。
 */
export async function advanceVirtualTimeForMessages(userId, timestamps = [], stepMs = 15000) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const rows = (Array.isArray(timestamps) ? timestamps : [timestamps])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!rows.length) return getNowForUser(id);
  const schedule = await ensureTimeSchedule(id);
  if (schedule.timeMode !== TIME_MODE_VIRTUAL) return getNowForUser(id);

  const step = Math.max(1000, Number(stepMs) || 15000);
  const current = await getNowForUser(id);
  const latestMessage = Math.max(...rows);
  const nextAnchor = Math.max(
    current + rows.length * step,
    latestMessage + step,
  );
  await persistSchedule(id, {
    anchorVirtual: nextAnchor,
    anchorReal: Date.now(),
    paused: schedule.paused === true,
    pauseReason: schedule.paused === true ? schedule.pauseReason : '',
  });
  return nextAnchor;
}

/**
 * 「闲聊补充/断档补发」专用：从正文关键词反推这条消息大致属于一天里的哪个时段，
 * 配合 createGapFillTimestampAllocator 把气泡分散落在断档区间里对应的时段，而不是全挤在触发那一刻。
 */
export function inferTimeSlotFromText(text = '') {
  const s = String(text || '');
  if (/凌晨|半夜|睡不着|失眠|熬夜到|刚睡醒/.test(s)) return 'late_night';
  if (/早上|早安|醒了|起床|晨跑|早饭|早餐|上午/.test(s)) return 'morning';
  if (/中午|午饭|午休|午间/.test(s)) return 'noon';
  if (/下午|午后/.test(s)) return 'afternoon';
  if (/傍晚|晚饭|晚上|收工|回家路上|下班/.test(s)) return 'evening';
  if (/睡前|夜里|今晚|晚安/.test(s)) return 'night';
  return '';
}

function dayWindowForSlot(anchorTs, slot = '') {
  const d = new Date(Number(anchorTs) || Date.now());
  const mk = (h, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  switch (String(slot || '')) {
    case 'late_night': return [mk(0), mk(5, 30)];
    case 'morning': return [mk(6), mk(11, 30)];
    case 'noon': return [mk(11, 30), mk(13, 30)];
    case 'afternoon': return [mk(13, 30), mk(18)];
    case 'evening': return [mk(18), mk(22, 30)];
    case 'night': return [mk(22, 30), mk(23, 59)];
    default: return null;
  }
}

/**
 * 把「断档区间」（上一条可见消息 -> 当前锚点）粗略切成 count 个带轻微抖动的时间点，
 * 作为落时间戳时的兜底序列（AI 没给出可识别时段时用这个）。
 */
export function planGapFillTimestamps(count = 1, { startTs = 0, endTs = Date.now() } = {}) {
  const c = Math.max(1, Number(count) || 1);
  const start = Number(startTs) || 0;
  const end = Number(endTs) || Date.now();
  if (!start || end <= start) {
    const out = [];
    let cursor = end;
    for (let i = 0; i < c; i += 1) { cursor += 1500; out.push(cursor); }
    return out;
  }
  const earliestOffset = Math.min(Math.max(2 * 60_000, (end - start) * 0.12), 20 * 60_000);
  const latestMargin = Math.min(Math.max(60_000, (end - start) * 0.06), 8 * 60_000);
  const rangeStart = start + earliestOffset;
  const rangeEnd = Math.max(rangeStart + 1000, end - latestMargin);
  const span = rangeEnd - rangeStart;
  const out = [];
  let cursor = start;
  for (let i = 0; i < c; i += 1) {
    const ratio = c === 1 ? 0.6 : i / (c - 1);
    const jitter = c === 1 ? 0 : Math.min(span * 0.04, 6 * 60_000) * Math.sin((i + 1) * 1.7);
    const raw = Math.round(rangeStart + span * ratio + jitter);
    cursor = Math.max(cursor + 1000, raw);
    out.push(cursor);
  }
  return out;
}

/**
 * 断档补发专用时间戳分配器：优先按事件正文/显式 timeSlot 反推的时段，在断档区间内对应的
 * 当天时间窗口里取一个点（同时段多条会依次错开，避免全部叠在同一分钟）；识别不出时段就退回
 * planGapFillTimestamps 算好的兜底序列，始终保证单调递增。
 */
export function createGapFillTimestampAllocator({ planned = [], startTs = 0, endTs = Date.now(), fallbackStepMs = 1500 } = {}) {
  const seq = (Array.isArray(planned) ? planned : []).map((ts) => Number(ts) || 0).filter((ts) => ts > 0);
  let seqIndex = 0;
  let fallbackCursor = seq[0] || Number(endTs) || Date.now();
  const nextFallback = () => {
    if (seqIndex < seq.length) {
      fallbackCursor = Math.max(fallbackCursor + 1, seq[seqIndex]);
      seqIndex += 1;
      return fallbackCursor;
    }
    fallbackCursor += Math.max(500, Number(fallbackStepMs) || 1500);
    return fallbackCursor;
  };
  const countBySlot = new Map();
  let cursor = Math.max(0, Number(startTs) || 0);
  return (event = null) => {
    const hintText = event && typeof event === 'object'
      ? String(event.body || event.text || event.content || '')
      : String(event || '');
    const slot = (event && typeof event === 'object' && event.timeSlot) || inferTimeSlotFromText(hintText);
    const win = slot ? dayWindowForSlot(endTs, slot) : null;
    if (win) {
      const [rawStart, rawEnd] = win;
      const lo = Math.max(Number(startTs || 0) + 1, rawStart);
      const hi = Math.min(Number(endTs || Date.now()) - 1, rawEnd);
      if (hi > lo) {
        const idx = countBySlot.get(slot) || 0;
        countBySlot.set(slot, idx + 1);
        const jitter = Math.sin((idx + 1) * 1.9) * Math.min(6 * 60_000, (hi - lo) * 0.08);
        const raw = Math.round(lo + (hi - lo) * ((idx + 1) / (idx + 2)) + jitter);
        cursor = Math.max(cursor + 1, raw);
        return cursor;
      }
    }
    cursor = Math.max(cursor + 1, nextFallback());
    return cursor;
  };
}
