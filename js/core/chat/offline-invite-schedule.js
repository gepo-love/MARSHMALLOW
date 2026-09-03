/**
 * 线下邀约一旦成立（角色已到场，或用户点了「接受/进入」），就应该顶掉角色当天日程里
 * 对应时间段原有的安排——而不是只当作聊天记录里的一句软提示。
 * 这里负责把 timeLabel 这种自然语言粗略解析成 dateKey，再把邀约写成一个 locked 的日程 block，
 * 覆盖掉那个时间段里原来 AI 生成的安排。
 */
import {
  loadCharacterPhone,
  saveCharacterPhone,
  getDailyLifePlanForDate,
  normalizeDailyLifePlan,
  normalizeDailyLifeBlock,
  upsertDailyLifePlan,
  dateKeyFromTimestamp,
  parseTimeRangeStartMinutes,
  parseTimeRangeEndMinutes,
  upsertOfflineScheduleOverride,
  removeOfflineScheduleOverrides,
} from '../character-phone-store.js';

const WEEKDAY_INDEX = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function addDays(baseTs, days) {
  const d = new Date(baseTs);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * 把「这周六下午」「明天晚上」「后天」之类的粗略中文时间说法解析成 dateKey。
 * 解析不出明确日期就返回空字符串——调用方应放弃硬覆盖，只保留原有的软上下文提示。
 */
export function resolveOfflineInviteDateKey(timeLabel = '', nowTs = Date.now()) {
  const text = String(timeLabel || '').trim();
  if (!text) return '';

  const mdMatch = text.match(/(\d{1,2})[月.\/-](\d{1,2})日?/);
  if (mdMatch) {
    const month = Number(mdMatch[1]);
    const day = Number(mdMatch[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const now = new Date(nowTs);
      let year = now.getFullYear();
      let candidate = new Date(year, month - 1, day);
      if (candidate.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) {
        candidate = new Date(year + 1, month - 1, day);
      }
      if (!Number.isNaN(candidate.getTime())) return dateKeyFromTimestamp(candidate.getTime());
    }
  }

  if (/大后天/.test(text)) return dateKeyFromTimestamp(addDays(nowTs, 3));
  if (/后天/.test(text)) return dateKeyFromTimestamp(addDays(nowTs, 2));
  if (/明[天早晚儿]/.test(text)) return dateKeyFromTimestamp(addDays(nowTs, 1));
  if (/今[天晚早儿]|此刻|现在|马上|一会|待会|这就/.test(text)) return dateKeyFromTimestamp(nowTs);

  const weekdayMatch = text.match(/(下下|下|这|本)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (weekdayMatch) {
    const prefix = weekdayMatch[1] || '';
    const targetDow = WEEKDAY_INDEX[weekdayMatch[2]];
    const currentDow = new Date(nowTs).getDay();
    let diff = (targetDow - currentDow + 7) % 7;
    if (prefix === '下下') diff += 14;
    else if (prefix === '下') diff += 7;
    return dateKeyFromTimestamp(addDays(nowTs, diff));
  }

  if (/周末/.test(text)) {
    const currentDow = new Date(nowTs).getDay();
    if (currentDow === 0 || currentDow === 6) return dateKeyFromTimestamp(nowTs);
    return dateKeyFromTimestamp(addDays(nowTs, 6 - currentDow));
  }
  if (/下周|下星期|下礼拜/.test(text)) return dateKeyFromTimestamp(addDays(nowTs, 7));

  return '';
}

export function blocksOverlap(rangeA = '', rangeB = '') {
  const aStart = parseTimeRangeStartMinutes(rangeA);
  const bStart = parseTimeRangeStartMinutes(rangeB);
  if (aStart < 0 || bStart < 0) return false;
  const aEndRaw = parseTimeRangeEndMinutes(rangeA);
  const bEndRaw = parseTimeRangeEndMinutes(rangeB);
  const aEnd = aEndRaw < aStart ? aEndRaw + 1440 : aEndRaw;
  const bEnd = bEndRaw < bStart ? bEndRaw + 1440 : bEndRaw;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 把邀约写成一个 locked 的日程 block，覆盖掉当天原来在这个时间段的安排。
 * 只在那一天的日程「已经真实生成过」时才动手覆盖——如果那天还没排过日程（比如约在很久之后的
 * 周六），提前塞一个只有这一个 block 的「假日程」会让日程生成器误以为那天已经排好、以后跳过生成，
 * 导致那天其它时段永远空着。还没排到的日子先靠软上下文（recentChatContext 里的邀约详情）让
 * AI 生成时自己带上；等那天真正排过日程后，用户接受时会再次触发这里，到时候才真正覆盖。
 */
export async function applyOfflineInviteScheduleOverride({
  userId,
  characterId,
  dateKey,
  timeLabel = '',
  activity = '',
  place = '',
  note = '',
  toUserPlace = false,
  sourceId = '',
  immediate = false,
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const dk = String(dateKey || '').trim();
  if (!uid || !cid || !dk) return null;

  const phone = await loadCharacterPhone(uid, cid).catch(() => null);
  if (!phone) return null;

  const existingPlan = getDailyLifePlanForDate(phone, dk);
  if (!immediate && !existingPlan?.blocks?.length) return null;
  const timeRange = String(timeLabel || '').trim() || (immediate ? '此刻' : '待定时间');
  const placeName = String(place || '').trim() || (toUserPlace ? '用户那边' : '');

  const block = normalizeDailyLifeBlock({
    id: `block_offline_invite_${String(sourceId || Date.now())}`,
    timeRange,
    anchor: placeName,
    placeName,
    activity: activity || '和用户见面',
    narrative: note || '',
    busy: true,
    status: immediate ? 'active' : 'planned',
    locked: true,
    origin: 'offline_invite',
    updatedBy: 'offline_invite',
    sourceRefs: sourceId ? [String(sourceId)] : [],
  }, 0);
  if (!block) return null;

  const keptBlocks = (existingPlan?.blocks || []).filter((b) => !blocksOverlap(b.timeRange, block.timeRange));
  const mergedBlocks = [...keptBlocks, block].sort((a, b) => {
    const sa = parseTimeRangeStartMinutes(a.timeRange);
    const sb = parseTimeRangeStartMinutes(b.timeRange);
    return (sa < 0 ? 9999 : sa) - (sb < 0 ? 9999 : sb);
  });

  const plan = normalizeDailyLifePlan({
    ...(existingPlan || {}),
    dateKey: dk,
    blocks: mergedBlocks,
  }, { characterId: cid, dateKey: dk });

  const nextPhone = upsertDailyLifePlan(phone, plan);
  await saveCharacterPhone(nextPhone);
  return plan;
}

function hmLabel(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 把一段 [startTs, endTs] 的世界内时间拆成逐日片段（跨天按天切），供收纳后覆盖日程用。
 * 返回 [{ dateKey, timeRange }]；片段过短会被拉到至少 15 分钟，保证重叠判定与显示都稳定。
 */
export function splitWorldSpanIntoDailyRanges(startTs, endTs, { maxDays = 14 } = {}) {
  let start = Number(startTs || 0);
  let end = Number(endTs || 0);
  if (!Number.isFinite(start) || start <= 0) return [];
  if (!Number.isFinite(end) || end < start) end = start;
  const MIN_SPAN_MS = 15 * 60 * 1000;
  if (end - start < MIN_SPAN_MS) end = start + MIN_SPAN_MS;
  const out = [];
  let cursor = start;
  for (let i = 0; i < maxDays && cursor < end; i += 1) {
    const day = new Date(cursor);
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const segEnd = Math.min(end, dayEnd);
    const isLastSegment = segEnd >= end;
    out.push({
      dateKey: dateKeyFromTimestamp(cursor),
      timeRange: `${cursor === start ? hmLabel(cursor) : '00:00'}-${isLastSegment ? hmLabel(segEnd) : '23:59'}`,
    });
    cursor = dayEnd;
  }
  return out;
}

/**
 * 线下会话进行中使用独立覆盖层占住角色时间，不依赖当天完整日程是否已经生成。
 * 每次推进可用同一 sourceId 延长区间；正式总结会移除 active 层并写入最终 done 区间。
 */
export async function applyOfflineActiveScheduleOverride({
  userId,
  characterId,
  startTs,
  endTs,
  place = '',
  activity = '',
  sourceId = '',
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const sid = String(sourceId || '').trim();
  if (!uid || !cid || !sid) return [];
  const segments = splitWorldSpanIntoDailyRanges(startTs, endTs);
  if (!segments.length) return [];
  let phone = await loadCharacterPhone(uid, cid).catch(() => null);
  if (!phone) return [];
  phone = removeOfflineScheduleOverrides(phone, { sourceId: sid });
  const applied = [];
  for (const seg of segments) {
    const block = normalizeDailyLifeBlock({
      id: `block_offline_active_${sid}_${seg.dateKey}`,
      timeRange: seg.timeRange,
      anchor: String(place || '').trim(),
      placeName: String(place || '').trim(),
      activity: String(activity || '').trim() || '和用户线下见面',
      narrative: '',
      statusLabel: '线下会面进行中',
      busy: true,
      status: 'active',
      locked: true,
      origin: 'offline_active',
      updatedBy: 'offline_active',
      sourceRefs: [sid],
    }, 0);
    if (!block) continue;
    phone = upsertOfflineScheduleOverride(phone, {
      dateKey: seg.dateKey,
      sourceId: sid,
      phase: 'active',
      block,
    });
    applied.push(block);
  }
  if (applied.length) await saveCharacterPhone(phone);
  return applied;
}

/**
 * 线下收纳后：把这段线下真实发生的时间写回该角色当天日程，覆盖掉原有时间段里 AI 排的安排。
 * 独立覆盖层不依赖当天日程是否已生成；跨天逐日拆分，后续生成完整日程时仍以线下事实为准。
 */
export async function applyOfflineSummaryScheduleOverride({
  userId,
  characterId,
  startTs,
  endTs,
  summary = '',
  place = '',
  activity = '',
  sourceId = '',
  replaceSourceId = '',
  eventContext = null,
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return [];
  const segments = splitWorldSpanIntoDailyRanges(startTs, endTs);
  if (!segments.length) return [];

  const phone = await loadCharacterPhone(uid, cid).catch(() => null);
  if (!phone) return [];

  let nextPhone = removeOfflineScheduleOverrides(phone, {
    sourceId: String(replaceSourceId || sourceId || '').trim(),
  });
  const context = eventContext && typeof eventContext === 'object' ? eventContext : {};
  const detailNarrative = [
    String(summary || '').trim(),
    (context.quotes || []).length
      ? `关键对话：${context.quotes.map((quote) => `${quote?.speaker || '角色'}：“${quote?.line || ''}”`).join('；')}`
      : '',
    (context.relationshipShifts || []).length
      ? `关系变化：${context.relationshipShifts.join('；')}`
      : '',
    (context.hooks || []).length ? `后续：${context.hooks.join('；')}` : '',
  ].filter(Boolean).join('\n').slice(0, 900);
  const applied = [];
  for (const seg of segments) {
    const block = normalizeDailyLifeBlock({
      id: `block_offline_summary_${String(sourceId || Date.now())}_${seg.dateKey}`,
      timeRange: seg.timeRange,
      anchor: String(place || '').trim(),
      placeName: String(place || '').trim(),
      activity: String(activity || '').trim() || '和用户线下见面',
      narrative: detailNarrative,
      busy: true,
      status: 'done',
      locked: true,
      origin: 'offline_summary',
      updatedBy: 'offline_summary',
      sourceRefs: sourceId ? [String(sourceId)] : [],
      eventContext: {
        ...context,
        archiveId: String(context.archiveId || sourceId || '').trim(),
        summary: String(context.summary || summary || '').trim(),
      },
    }, 0);
    if (!block) continue;
    nextPhone = upsertOfflineScheduleOverride(nextPhone, {
      dateKey: seg.dateKey,
      sourceId: String(sourceId || replaceSourceId || Date.now()),
      phase: 'done',
      block,
    });
    applied.push(block);
  }
  if (applied.length) await saveCharacterPhone(nextPhone);
  return applied;
}

/**
 * 从一条 offlineInvite 消息推出日程覆盖：arrived 视为「就是现在」；否则尝试解析 timeLabel。
 * 解析不出具体日期时返回 null，不做硬覆盖（软上下文提示已经在日程生成 recentChatContext 里覆盖了）。
 */
export async function applyOfflineInviteScheduleFromMessage({
  userId,
  characterId,
  message,
  nowTs = Date.now(),
} = {}) {
  const md = message?.metadata || {};
  const arrived = md.arrived === true;
  const dateKey = arrived ? dateKeyFromTimestamp(nowTs) : resolveOfflineInviteDateKey(md.timeLabel, nowTs);
  if (!dateKey) return null;
  return applyOfflineInviteScheduleOverride({
    userId,
    characterId,
    dateKey,
    timeLabel: arrived ? '此刻' : md.timeLabel,
    activity: md.activity,
    place: md.place,
    note: md.note,
    toUserPlace: md.toUserPlace === true,
    sourceId: message?.id,
    immediate: arrived,
  }).catch(() => null);
}
