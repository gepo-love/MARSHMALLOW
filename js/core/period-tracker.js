/**
 * 经期记录：本地私密数据。
 * 用户在日程表里记录开始日；开启「让 TA 记得关心」后，
 * 临近预测日期或经期中会向聊天注入一小段关心语境。
 */
import * as db from './db.js';
import { getNowForUser } from './time-mode.js';

const TRACKER_KEY = (userId) => `periodTracker_${String(userId || '').trim()}`;
const DAY_MS = 86400000;
const MAX_HISTORY = 12;
const REMIND_AHEAD_DAYS = 3;
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_REMINDER_LOG = 24;
const MAX_ACTIVE_DAY = 30;

function startOfDay(ts) {
  const d = new Date(Number(ts) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clampCycle(value) {
  const n = Math.round(Number(value) || 0);
  if (!Number.isFinite(n) || n <= 0) return 28;
  return Math.max(20, Math.min(45, n));
}

function clampPeriodDays(value) {
  const n = Math.round(Number(value) || 0);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.max(2, Math.min(10, n));
}

function cleanId(value) {
  return String(value || '').trim().slice(0, 160);
}

function normalizeActive(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const startDayTs = startOfDay(src.startDayTs);
  const characterId = cleanId(src.characterId);
  const chatId = cleanId(src.chatId);
  const recordedAt = Number(src.recordedAt) || 0;
  if (!startDayTs || !characterId || !chatId || !recordedAt) return null;
  return { startDayTs, characterId, chatId, recordedAt };
}

function normalizePending(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const dayTs = startOfDay(src.dayTs);
  const characterId = cleanId(src.characterId);
  const chatId = cleanId(src.chatId);
  const requestedAt = Number(src.requestedAt) || 0;
  const expiresAt = Number(src.expiresAt) || (requestedAt ? requestedAt + PENDING_TTL_MS : 0);
  if (!dayTs || !characterId || !chatId || !requestedAt || !expiresAt) return null;
  return { dayTs, characterId, chatId, requestedAt, expiresAt };
}

function normalizeReminderLog(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => {
      const src = item && typeof item === 'object' ? item : {};
      const key = cleanId(src.key);
      const at = Number(src.at) || 0;
      return key && at ? { key, at } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_REMINDER_LOG);
}

function normalizeReminderTargets(raw, legacyCharacterId = '', legacyChatId = '') {
  const source = Array.isArray(raw)
    ? raw
    : (cleanId(legacyCharacterId) ? [{ characterId: legacyCharacterId, chatId: legacyChatId }] : []);
  const seen = new Set();
  return source.map((item) => {
    const characterId = cleanId(item?.characterId || item?.id);
    const chatId = cleanId(item?.chatId);
    if (!characterId || seen.has(characterId)) return null;
    seen.add(characterId);
    return { characterId, chatId };
  }).filter(Boolean);
}

function addReminderTarget(targets, characterId, chatId) {
  const actor = cleanId(characterId);
  const sourceChat = cleanId(chatId);
  if (!actor) return normalizeReminderTargets(targets);
  return [
    ...normalizeReminderTargets(targets).filter((item) => item.characterId !== actor),
    { characterId: actor, chatId: sourceChat },
  ];
}

export function normalizePeriodTracker(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const history = (Array.isArray(src.history) ? src.history : [])
    .map((ts) => startOfDay(ts))
    .filter((ts, i, arr) => Number.isFinite(ts) && ts > 0 && arr.indexOf(ts) === i)
    .sort((a, b) => a - b)
    .slice(-MAX_HISTORY);
  const reminderTargets = normalizeReminderTargets(
    src.reminderTargets,
    src.reminderCharacterId,
    src.reminderChatId,
  );
  const firstReminder = reminderTargets[0] || null;
  return {
    remindAi: src.remindAi === true,
    cycleDays: clampCycle(src.cycleDays),
    periodDays: clampPeriodDays(src.periodDays),
    history,
    reminderTargets,
    // 保留首个对象的旧字段镜像，兼容尚未迁移的备份与外围读取。
    reminderCharacterId: firstReminder?.characterId || '',
    reminderChatId: firstReminder?.chatId || '',
    active: normalizeActive(src.active),
    pending: normalizePending(src.pending),
    reminderLog: normalizeReminderLog(src.reminderLog),
  };
}

export async function loadPeriodTracker(userId) {
  const id = String(userId || '').trim();
  if (!id) return normalizePeriodTracker();
  const row = await db.get(TRACKER_KEY(id)).catch(() => null);
  return normalizePeriodTracker(row?.value);
}

export async function savePeriodTracker(userId, patch = {}) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const prev = await loadPeriodTracker(id);
  const next = normalizePeriodTracker({ ...prev, ...patch });
  await db.put({ key: TRACKER_KEY(id), value: next });
  return next;
}

/** 日历手动选择一位或多位知情角色；目标变化后允许新目标收到本周期提醒。 */
export async function setPeriodReminderTargets(userId, targets = []) {
  const id = cleanId(userId);
  if (!id) return null;
  const prev = await loadPeriodTracker(id);
  const reminderTargets = normalizeReminderTargets(targets);
  const before = JSON.stringify(prev.reminderTargets);
  const after = JSON.stringify(reminderTargets);
  return savePeriodTracker(id, {
    reminderTargets,
    reminderLog: before === after ? prev.reminderLog : [],
  });
}

/** 聊天里明确提及时把当前角色加入知情范围，不覆盖用户手动选择的其他人。 */
export async function addPeriodReminderTarget(userId, { characterId, chatId } = {}) {
  const id = cleanId(userId);
  const actor = cleanId(characterId);
  if (!id || !actor) return null;
  const prev = await loadPeriodTracker(id);
  const reminderTargets = addReminderTarget(prev.reminderTargets, actor, chatId);
  return savePeriodTracker(id, { reminderTargets });
}

/** 记录某天为一次经期开始日；若与历史间隔合理会自动微调周期天数 */
export async function recordPeriodStart(userId, dayTs) {
  const id = String(userId || '').trim();
  const day = startOfDay(dayTs);
  if (!id || !day) return null;
  const prev = await loadPeriodTracker(id);
  const history = [...prev.history.filter((ts) => ts !== day), day].sort((a, b) => a - b).slice(-MAX_HISTORY);
  let cycleDays = prev.cycleDays;
  if (history.length >= 2) {
    const gaps = [];
    for (let i = 1; i < history.length; i += 1) {
      const gap = Math.round((history[i] - history[i - 1]) / DAY_MS);
      if (gap >= 20 && gap <= 45) gaps.push(gap);
    }
    if (gaps.length) {
      cycleDays = clampCycle(gaps.reduce((sum, g) => sum + g, 0) / gaps.length);
    }
  }
  return savePeriodTracker(id, { history, cycleDays });
}

function inferCycleDays(history, fallback = 28) {
  const gaps = [];
  for (let i = 1; i < history.length; i += 1) {
    const gap = Math.round((history[i] - history[i - 1]) / DAY_MS);
    if (gap >= 20 && gap <= 45) gaps.push(gap);
  }
  return gaps.length
    ? clampCycle(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length)
    : clampCycle(fallback);
}

/** 纯数据变换：纠正某次开始日，同时保留聊天记录来源与当前状态。 */
export function replacePeriodStartInTracker(tracker, oldDayTs, newDayTs) {
  const prev = normalizePeriodTracker(tracker);
  const oldDay = startOfDay(oldDayTs);
  const newDay = startOfDay(newDayTs);
  if (!oldDay || !newDay || !prev.history.includes(oldDay)) return prev;
  const history = [...prev.history.filter((ts) => ts !== oldDay && ts !== newDay), newDay]
    .sort((a, b) => a - b)
    .slice(-MAX_HISTORY);
  return normalizePeriodTracker({
    ...prev,
    history,
    cycleDays: inferCycleDays(history, prev.cycleDays),
    active: prev.active?.startDayTs === oldDay
      ? { ...prev.active, startDayTs: newDay }
      : prev.active,
  });
}

/** 将一条误记的经期开始日移动到正确日期。 */
export async function replacePeriodStart(userId, oldDayTs, newDayTs) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const prev = await loadPeriodTracker(id);
  const oldDay = startOfDay(oldDayTs);
  if (!prev.history.includes(oldDay)) return prev;
  const next = replacePeriodStartInTracker(prev, oldDay, newDayTs);
  await db.put({ key: TRACKER_KEY(id), value: next });
  return next;
}

/** 明确记录当前经期状态；状态不会按预计天数自动结束。 */
export async function setActivePeriod(userId, {
  dayInPeriod = 1,
  characterId,
  chatId,
  now = Date.now(),
} = {}) {
  const id = cleanId(userId);
  const actor = cleanId(characterId);
  const sourceChat = cleanId(chatId);
  const nowTs = Number(now) || Date.now();
  const dayNumber = Math.round(Number(dayInPeriod) || 0);
  if (!id || !actor || !sourceChat || dayNumber < 1 || dayNumber > MAX_ACTIVE_DAY) {
    return { ok: false, reason: 'invalid-active-period' };
  }
  const startDayTs = startOfDay(nowTs) - (dayNumber - 1) * DAY_MS;
  const recorded = await recordPeriodStart(id, startDayTs);
  const reminderTargets = addReminderTarget(recorded.reminderTargets, actor, sourceChat);
  const next = await savePeriodTracker(id, {
    ...recorded,
    remindAi: true,
    reminderTargets,
    active: {
      startDayTs,
      characterId: actor,
      chatId: sourceChat,
      recordedAt: nowTs,
    },
    pending: null,
  });
  return { ok: true, tracker: next, startDayTs, dayInPeriod: dayNumber };
}

/** 只有记录该状态的角色和会话能结束它。 */
export async function endActivePeriod(userId, { characterId, chatId } = {}) {
  const id = cleanId(userId);
  if (!id) return { ok: false, reason: 'missing-user' };
  const tracker = await loadPeriodTracker(id);
  if (!tracker.active) return { ok: false, reason: 'no-active-period' };
  if (tracker.active.characterId !== cleanId(characterId)
    || tracker.active.chatId !== cleanId(chatId)) {
    return { ok: false, reason: 'active-source-mismatch' };
  }
  const next = await savePeriodTracker(id, { active: null, pending: null });
  return { ok: true, tracker: next };
}

/** 角色提出记录后暂存，必须由用户下一轮明确确认才会写入历史。 */
export async function proposePeriodStart(userId, { dayTs, characterId, chatId, now = Date.now() } = {}) {
  const id = cleanId(userId);
  const day = startOfDay(dayTs);
  const actor = cleanId(characterId);
  const sourceChat = cleanId(chatId);
  const requestedAt = Number(now) || Date.now();
  // 允许按“现在是第几天”回推开始日；不接受未来日期或超过 30 天的模糊历史。
  const ageDays = Math.round((startOfDay(requestedAt) - day) / DAY_MS);
  if (!id || !day || !actor || !sourceChat || ageDays < 0 || ageDays >= MAX_ACTIVE_DAY) return null;
  return savePeriodTracker(id, {
    pending: {
      dayTs: day,
      characterId: actor,
      chatId: sourceChat,
      requestedAt,
      expiresAt: requestedAt + PENDING_TTL_MS,
    },
  });
}

export function isPeriodPendingActive(tracker, { characterId, chatId, now = Date.now() } = {}) {
  const pending = normalizePeriodTracker(tracker).pending;
  return !!pending
    && pending.expiresAt > (Number(now) || Date.now())
    && pending.characterId === cleanId(characterId)
    && pending.chatId === cleanId(chatId);
}

export async function confirmPeriodStart(userId, { characterId, chatId, now = Date.now() } = {}) {
  const id = cleanId(userId);
  if (!id) return { ok: false, reason: 'missing-user' };
  const tracker = await loadPeriodTracker(id);
  const pending = tracker.pending;
  const nowTs = Number(now) || Date.now();
  if (!pending || pending.expiresAt <= nowTs) {
    if (pending) await savePeriodTracker(id, { pending: null });
    return { ok: false, reason: 'no-pending-record' };
  }
  if (!isPeriodPendingActive(tracker, { characterId, chatId, now: nowTs })) {
    return { ok: false, reason: 'pending-source-mismatch' };
  }
  const recorded = await recordPeriodStart(id, pending.dayTs);
  const reminderTargets = addReminderTarget(recorded.reminderTargets, pending.characterId, pending.chatId);
  const next = await savePeriodTracker(id, {
    ...recorded,
    remindAi: true,
    reminderTargets,
    active: {
      startDayTs: pending.dayTs,
      characterId: pending.characterId,
      chatId: pending.chatId,
      recordedAt: nowTs,
    },
    pending: null,
  });
  return { ok: true, tracker: next, dayTs: pending.dayTs };
}

export async function declinePeriodStart(userId, { characterId, chatId } = {}) {
  const id = cleanId(userId);
  if (!id) return { ok: false, reason: 'missing-user' };
  const tracker = await loadPeriodTracker(id);
  const pending = tracker.pending;
  if (!pending) return { ok: false, reason: 'no-pending-record' };
  if (pending.characterId !== cleanId(characterId) || pending.chatId !== cleanId(chatId)) {
    return { ok: false, reason: 'pending-source-mismatch' };
  }
  await savePeriodTracker(id, { pending: null });
  return { ok: true };
}

export function periodReminderKey(status) {
  if (!status?.nextStart) return '';
  const cycleStart = status.phase === 'upcoming'
    ? status.nextStart
    : (status.predicted ? status.nextStart - 0 : status.nextStart);
  const phase = status.phase === 'upcoming' ? 'upcoming' : 'during';
  return `${phase}:${startOfDay(cycleStart)}`;
}

export function hasPeriodReminderBeenSent(tracker, key) {
  return !!key && normalizePeriodTracker(tracker).reminderLog.some((item) => item.key === key);
}

export async function markPeriodReminderSent(userId, key, at = Date.now()) {
  const id = cleanId(userId);
  const safeKey = cleanId(key);
  if (!id || !safeKey) return null;
  const tracker = await loadPeriodTracker(id);
  const reminderLog = [...tracker.reminderLog.filter((item) => item.key !== safeKey), { key: safeKey, at: Number(at) || Date.now() }];
  return savePeriodTracker(id, { reminderLog });
}

export async function buildPeriodPendingPromptBlock(userId, scope = {}, now = Date.now()) {
  const id = cleanId(userId);
  if (!id) return '';
  const tracker = await loadPeriodTracker(id);
  const pending = tracker.pending;
  if (!pending || pending.expiresAt <= (Number(now) || Date.now())) return '';
  if (pending.characterId !== cleanId(scope.characterId) || pending.chatId !== cleanId(scope.chatId)) return '';
  return [
    '【经期记录待确认】',
    '你此前询问是否将这次经期开始日记入日程，仍在等待用户明确答复。',
    '只有当用户在本轮或紧接着的回复里明确同意（如“好”“记吧”“可以”）时，才输出 period_confirm；拒绝、转移话题、含糊回应都不要记录。不要重复催问。',
  ].join('\n');
}

export async function removePeriodStart(userId, dayTs) {
  const id = String(userId || '').trim();
  const day = startOfDay(dayTs);
  if (!id || !day) return null;
  const prev = await loadPeriodTracker(id);
  return savePeriodTracker(id, {
    history: prev.history.filter((ts) => ts !== day),
    active: prev.active?.startDayTs === day ? null : prev.active,
  });
}

/**
 * 当前状态：
 * - during：正处于记录/预测的经期内（dayInPeriod 从 1 起）
 * - upcoming：距预测开始日还有 daysUntil 天
 * - none：无记录或距离尚远
 */
export function getPeriodStatus(tracker, now = Date.now()) {
  const t = normalizePeriodTracker(tracker);
  const today = startOfDay(now);
  if (t.active) {
    const dayInPeriod = Math.max(1, Math.round((today - t.active.startDayTs) / DAY_MS) + 1);
    return {
      phase: 'during',
      nextStart: t.active.startDayTs + t.cycleDays * DAY_MS,
      daysUntil: 0,
      dayInPeriod,
      active: true,
    };
  }
  const lastStart = t.history[t.history.length - 1] || 0;
  if (!lastStart) return { phase: 'none', nextStart: 0, daysUntil: 0, dayInPeriod: 0 };

  const sinceLast = Math.round((today - lastStart) / DAY_MS);
  if (sinceLast >= 0 && sinceLast < t.periodDays) {
    return { phase: 'during', nextStart: lastStart + t.cycleDays * DAY_MS, daysUntil: 0, dayInPeriod: sinceLast + 1 };
  }

  let nextStart = lastStart;
  while (nextStart <= today) nextStart += t.cycleDays * DAY_MS;
  const daysUntil = Math.round((nextStart - today) / DAY_MS);
  // 预测经期内（用户还没记录这次的开始日）
  const predictedStart = nextStart - t.cycleDays * DAY_MS;
  if (predictedStart > lastStart && today >= predictedStart && today < predictedStart + t.periodDays * DAY_MS) {
    return { phase: 'during', nextStart, daysUntil, dayInPeriod: Math.round((today - predictedStart) / DAY_MS) + 1, predicted: true };
  }
  return { phase: daysUntil <= REMIND_AHEAD_DAYS ? 'upcoming' : 'none', nextStart, daysUntil, dayInPeriod: 0 };
}

/** 供月历渲染：返回 Map<dayTs, 'recorded' | 'predicted'> */
export function buildPeriodDayMap(tracker, year, monthIndex) {
  const t = normalizePeriodTracker(tracker);
  const map = new Map();
  if (!t.history.length) return map;
  const monthStart = new Date(year, monthIndex, 1).getTime();
  const monthEnd = new Date(year, monthIndex + 1, 1).getTime();
  const mark = (startTs, kind) => {
    for (let i = 0; i < t.periodDays; i += 1) {
      const dayTs = startTs + i * DAY_MS;
      if (dayTs < monthStart || dayTs >= monthEnd) continue;
      if (kind === 'predicted' && map.get(dayTs) === 'recorded') continue;
      map.set(dayTs, kind);
    }
  };
  for (const ts of t.history) mark(ts, 'recorded');
  const lastStart = t.history[t.history.length - 1];
  // 往后标注两轮预测，覆盖用户翻到下个月的情况
  for (let round = 1; round <= 2; round += 1) {
    mark(lastStart + round * t.cycleDays * DAY_MS, 'predicted');
  }
  return map;
}

export function formatPeriodStatusLine(status) {
  if (!status || status.phase === 'none') return '';
  if (status.phase === 'during') {
    return status.predicted
      ? `按周期推算已进入经期第 ${status.dayInPeriod} 天`
      : `经期第 ${status.dayInPeriod} 天`;
  }
  return status.daysUntil <= 0 ? '预计今天开始' : `预计 ${status.daysUntil} 天后开始`;
}

function activeMatchesScope(tracker, scope = {}) {
  if (!tracker.active) return false;
  const partnerIds = Array.isArray(scope.partnerIds) ? scope.partnerIds.map(cleanId) : [];
  const chatId = cleanId(scope.chatId);
  return partnerIds.includes(tracker.active.characterId) && tracker.active.chatId === chatId;
}

/** 持续注入已确认的当前状态，不受时间感应开关影响。 */
export async function buildActivePeriodPromptBlock(userId, now = 0, scope = {}) {
  const id = cleanId(userId);
  if (!id) return '';
  const tracker = await loadPeriodTracker(id);
  if (!activeMatchesScope(tracker, scope)) return '';
  const nowTs = Number(now) || await getNowForUser(id).catch(() => Date.now());
  const status = getPeriodStatus(tracker, nowTs);
  return [
    '【用户当前经期状态】',
    `用户现在处于经期第 ${status.dayInPeriod} 天；这是你此前已经记录并持续知晓的状态，不是本轮刚得知的新消息。`,
    '除非用户明确说经期已经结束，否则必须继续记住该状态。用户明确表示结束时，输出 period_end；不要擅自按预计天数结束，也不要反复表现得像第一次听说。',
    '只在合适时机自然关心并优先承接当前话题。禁止医学诊断、说教、反复追问，禁止把用户当成不能工作、出门、运动或社交的人。',
  ].join('\n');
}

/** 注入聊天语境：仅在开启提醒、且临近或经期中时输出 */
export async function buildPeriodPromptBlock(userId, now = 0, scope = {}) {
  const id = String(userId || '').trim();
  if (!id) return '';
  const tracker = await loadPeriodTracker(id);
  if (!tracker.remindAi || !tracker.history.length) return '';
  const partnerIds = Array.isArray(scope.partnerIds) ? scope.partnerIds.map(cleanId) : [];
  const chatId = cleanId(scope.chatId);
  // 只向用户手动选择或在聊天中明确告知的角色共享；旧记录会迁移成单个目标。
  const target = tracker.reminderTargets.find((item) => (
    partnerIds.includes(item.characterId)
    && (!item.chatId || item.chatId === chatId)
  ));
  if (!target) return '';
  const nowTs = Number(now) || await getNowForUser(id).catch(() => Date.now());
  const status = getPeriodStatus(tracker, nowTs);
  // 记录它的当前角色由更完整的 active block 承接；用户手动选择的其他知情角色
  // 仍应获得当前状态，不能因记录来自另一条聊天而完全不知情。
  if (status.active && activeMatchesScope(tracker, scope)) return '';
  if (status.phase === 'none') return '';
  const line = status.phase === 'during'
    ? `用户现在大约处于经期第 ${status.dayInPeriod} 天。`
    : `用户的经期预计 ${status.daysUntil <= 0 ? '今天' : `${status.daysUntil} 天内`}开始。`;
  return [
    '【经期关心】',
    line,
    '这是用户自愿共享的私密信息：只在合适的时机自然关心一句并优先承接当前话题。禁止医学诊断、说教、反复追问，禁止把用户当成不能工作、出门、运动或社交的人；不要用“喝热水、少吃凉的、只能休息”之类刻板话术。',
  ].join('\n');
}
