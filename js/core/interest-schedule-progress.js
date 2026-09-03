/**
 * 兴趣进度 × 日程执行投影
 *
 * 日程是未来计划，不能在生成时直接改兴趣存档。这里只消费角色当地时间已经走到的
 * flowStep，把步骤携带的结构化 interestProgress 事件幂等写回兴趣表。
 *
 * 旧日程没有结构化事件时，只在已到时的步骤/已结束的 block 中精确命中 nextGoal，
 * 做一次保守迁移：走到目标就更新 stage，明确“完成/看完/通关”才划掉目标。
 */

import {
  applyInterestProgressPatch,
  listInterestEntries,
} from './character-interest-table.js';
import {
  isRetiredPlanBlock,
  loadCharacterPhone,
  parseTimeRangeEndMinutes,
  parseTimeRangeStartMinutes,
} from './character-phone-store.js';
import {
  dateKeyInTimezone,
  minutesOfDayInTimezone,
  resolveCharacterScheduleTimezone,
} from './chat/chat-timezone.js';

function clean(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function dateOrdinal(dateKey = '') {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return Number.NaN;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
}

function parseClockMinutes(value = '') {
  const match = String(value || '').match(/(\d{1,2})[:：](\d{2})/);
  if (!match) return -1;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return -1;
  return hour * 60 + minute;
}

function eventMinuteInPlanDay(block = {}, step = null) {
  const blockStart = parseTimeRangeStartMinutes(block.timeRange);
  const blockEndRaw = parseTimeRangeEndMinutes(block.timeRange);
  const crossesMidnight = blockStart >= 0 && blockEndRaw >= 0 && blockEndRaw < blockStart;
  if (step) {
    const clock = parseClockMinutes(step.at);
    if (clock >= 0) return crossesMidnight && clock < blockStart ? clock + 1440 : clock;
    if (Number.isFinite(Number(step.offsetMinutes)) && blockStart >= 0) {
      return blockStart + Math.max(0, Number(step.offsetMinutes));
    }
  }
  if (blockEndRaw < 0) return -1;
  return crossesMidnight ? blockEndRaw + 1440 : blockEndRaw;
}

function relativeNowMinutes(planDateKey, now, timeZone) {
  const planDay = dateOrdinal(planDateKey);
  const currentDateKey = dateKeyInTimezone(now, timeZone);
  const currentDay = dateOrdinal(currentDateKey);
  if (!Number.isFinite(planDay) || !Number.isFinite(currentDay)) return -1;
  return (currentDay - planDay) * 1440 + minutesOfDayInTimezone(now, timeZone);
}

function eventIsDue(plan, block, step, now, timeZone) {
  const eventMinute = eventMinuteInPlanDay(block, step);
  if (eventMinute < 0) return false;
  return relativeNowMinutes(plan.dateKey, now, timeZone) >= eventMinute;
}

function normalizeExplicitEvent(raw = {}, entryById) {
  const entryId = clean(raw.entryId, 80);
  const entry = entryById.get(entryId);
  if (!entry?.progress) return null;
  const patch = {
    stage: clean(raw.stage, 40),
    completedGoal: clean(raw.completedGoal, 60),
    newGoal: clean(raw.newGoal, 60),
    humanMoment: clean(raw.humanMoment, 80),
  };
  if (!Object.values(patch).some(Boolean)) return null;
  return { entry, patch };
}

const COMPLETION_RE = /(?:已经|终于|刚刚|顺利|彻底)?(?:看完|读完|学完|研究完|练完|玩完|做完|追完|完成|通关|搞定|收尾|结束)/u;
const NOT_COMPLETED_RE = /(?:快要?|准备|打算|计划|想要?|还没|尚未|没能|差点).{0,10}(?:看完|读完|学完|研究完|练完|玩完|做完|追完|完成|通关|搞定|收尾|结束)/u;

function inferLegacyEvent(text, entries) {
  const source = clean(text, 500);
  if (!source) return null;
  const matches = [];
  for (const entry of entries) {
    for (const goal of entry.progress?.nextGoals || []) {
      const normalizedGoal = clean(goal, 60);
      if (normalizedGoal && source.includes(normalizedGoal)) {
        matches.push({ entry, goal: normalizedGoal });
      }
    }
  }
  matches.sort((a, b) => b.goal.length - a.goal.length);
  const hit = matches[0];
  if (!hit) return null;
  const completed = COMPLETION_RE.test(source) && !NOT_COMPLETED_RE.test(source);
  return {
    entry: hit.entry,
    patch: {
      stage: hit.goal,
      completedGoal: completed ? hit.goal : '',
      newGoal: '',
      humanMoment: '',
    },
  };
}

function eventSourceRef(plan, block, step, entryId, kind) {
  return clean([
    'schedule',
    plan.id || plan.dateKey,
    block.id || block.timeRange,
    step?.id || 'block-end',
    entryId,
    kind,
  ].join(':'), 160);
}

/**
 * 纯函数：收集此刻已经发生、可以安全写回的兴趣进度事件。
 */
export function collectDueInterestScheduleEvents({
  entries = [],
  phone = null,
  now = Date.now(),
  timeZone = '',
} = {}) {
  const activeEntries = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.status === 'active' && entry?.progress);
  if (!activeEntries.length) return [];
  const entryById = new Map(activeEntries.map((entry) => [String(entry.id), entry]));
  const plans = (Array.isArray(phone?.dailyLifePlans) ? phone.dailyLifePlans : [])
    .filter((plan) => plan?.dateKey && relativeNowMinutes(plan.dateKey, now, timeZone) >= 0)
    .sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey))
      || Number(a.generatedAt || 0) - Number(b.generatedAt || 0));
  const events = [];

  for (const plan of plans) {
    for (const block of (Array.isArray(plan.blocks) ? plan.blocks : [])) {
      if (!block || isRetiredPlanBlock(block)) continue;
      const steps = Array.isArray(block.flowSteps) ? block.flowSteps : [];
      let blockHasDueEvent = false;
      for (const step of steps) {
        if (!eventIsDue(plan, block, step, now, timeZone)) continue;
        const explicit = normalizeExplicitEvent(step?.interestProgress || {}, entryById);
        const inferred = explicit || inferLegacyEvent([
          step?.action,
          step?.shareCandidate,
        ].filter(Boolean).join(' '), activeEntries);
        if (!inferred) continue;
        blockHasDueEvent = true;
        const sourceRef = eventSourceRef(
          plan,
          block,
          step,
          inferred.entry.id,
          explicit ? 'explicit' : 'legacy-step',
        );
        if (inferred.entry.progress.appliedRefs?.includes(sourceRef)) continue;
        events.push({
          entryId: inferred.entry.id,
          patch: {
            ...inferred.patch,
            sourceRef,
          },
          dateKey: plan.dateKey,
          dueMinute: eventMinuteInPlanDay(block, step),
        });
      }

      // 旧日程有时只在 block 正文写了下一目标，flowSteps 没重复。只在整个 block 已结束后
      // 兜底一次，绝不把尚未发生的未来 narrative 当成已完成事实。
      if (!blockHasDueEvent && eventIsDue(plan, block, null, now, timeZone)) {
        const inferred = inferLegacyEvent([
          block.activity,
          block.narrative,
        ].filter(Boolean).join(' '), activeEntries);
        if (inferred) {
          const sourceRef = eventSourceRef(plan, block, null, inferred.entry.id, 'legacy-block');
          if (inferred.entry.progress.appliedRefs?.includes(sourceRef)) continue;
          events.push({
            entryId: inferred.entry.id,
            patch: {
              ...inferred.patch,
              sourceRef,
            },
            dateKey: plan.dateKey,
            dueMinute: eventMinuteInPlanDay(block, null),
          });
        }
      }
    }
  }

  return events.sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey))
    || a.dueMinute - b.dueMinute);
}

export async function syncInterestProgressFromSchedule({
  userId,
  characterId,
  phone = null,
  now = Date.now(),
  timeZone = null,
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return { ok: false, reason: 'missing-scope', events: 0 };
  const [entries, currentPhone, resolvedTimeZone] = await Promise.all([
    listInterestEntries(uid, cid).catch(() => []),
    phone ? Promise.resolve(phone) : loadCharacterPhone(uid, cid).catch(() => null),
    timeZone == null
      ? resolveCharacterScheduleTimezone(uid, cid).catch(() => '')
      : Promise.resolve(String(timeZone || '')),
  ]);
  const events = collectDueInterestScheduleEvents({
    entries,
    phone: currentPhone,
    now,
    timeZone: resolvedTimeZone,
  });
  let applied = 0;
  for (const event of events) {
    const updated = await applyInterestProgressPatch(uid, cid, event.entryId, event.patch).catch(() => null);
    if (updated) applied += 1;
  }
  return { ok: true, events: events.length, applied };
}
