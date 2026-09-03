import * as db from './db.js';
import { getCivicHolidaysForYear, getPrimaryHolidayAt } from '../data/civic-holidays.js';

const HOLIDAY_PROMPT_KEY = (userId) => `holidayPromptEnabled_${String(userId || '').trim()}`;

export function startOfDayTs(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDaysTs(ts, days) {
  return Number(ts) + Number(days) * 86400000;
}

export async function getHolidayPromptEnabled(userId) {
  const id = String(userId || '').trim();
  if (!id) return true;
  const row = await db.get(HOLIDAY_PROMPT_KEY(id));
  if (row?.value === false) return false;
  return true;
}

export async function setHolidayPromptEnabled(userId, enabled) {
  const id = String(userId || '').trim();
  if (!id) return false;
  await db.put({ key: HOLIDAY_PROMPT_KEY(id), value: !!enabled });
  return !!enabled;
}

export function buildHolidayPromptLine(ts = Date.now()) {
  const holiday = getPrimaryHolidayAt(ts);
  if (!holiday) return '';
  return holiday.hint || `当前是${holiday.title}，角色可自然提及假期氛围。`;
}

export async function buildHolidayPromptBlock(userId, ts = Date.now()) {
  const enabled = await getHolidayPromptEnabled(userId);
  if (!enabled) return '';
  const line = buildHolidayPromptLine(ts);
  if (!line) return '';
  const holiday = getPrimaryHolidayAt(ts);
  const title = holiday?.title ? `（${holiday.title}）` : '';
  return [
    '【节假日语境】',
    `${line}${title}`,
    '可影响角色对出行、宅家、聚会、营业时间的判断；不要写成仍在普通工作日通勤。',
  ].join('\n');
}

export function buildMonthHolidayMap(year, monthIndex) {
  const map = new Map();
  const holidays = getCivicHolidaysForYear(year);
  for (const holiday of holidays) {
    for (let i = 0; i < holiday.dayCount; i += 1) {
      const dayTs = addDaysTs(holiday.at, i);
      const d = new Date(dayTs);
      if (d.getFullYear() !== year || d.getMonth() !== monthIndex) continue;
      map.set(dayTs, holiday);
    }
  }
  return map;
}

export function buildCalendarMonthCells(year, monthIndex, focusTs = Date.now()) {
  const first = new Date(year, monthIndex, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const holidayMap = buildMonthHolidayMap(year, monthIndex);
  const focusDay = startOfDayTs(focusTs);
  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const ts = startOfDayTs(new Date(year, monthIndex, day).getTime());
    const holiday = holidayMap.get(ts) || null;
    cells.push({
      day,
      ts,
      isToday: ts === focusDay,
      isHoliday: !!holiday,
      holidayTitle: holiday?.title || '',
    });
  }
  return cells;
}

export function listUpcomingHolidays(ts = Date.now(), limit = 4) {
  const y = new Date(ts).getFullYear();
  const all = [...getCivicHolidaysForYear(y), ...getCivicHolidaysForYear(y + 1)]
    .filter((h) => h.at >= startOfDayTs(ts))
    .sort((a, b) => a.at - b.at);
  return all.slice(0, Math.max(1, limit));
}

export function formatHolidayRange(holiday) {
  if (!holiday) return '';
  const d = new Date(holiday.at);
  const start = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (holiday.dayCount <= 1) return `${start} · ${holiday.title}`;
  const end = new Date(addDaysTs(holiday.at, holiday.dayCount - 1));
  return `${start}—${end.getMonth() + 1}月${end.getDate()}日 · ${holiday.title}`;
}
