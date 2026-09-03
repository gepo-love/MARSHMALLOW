/** 中性 civic 节假日（按公历年份；春节等按常见放假日近似，非天文精确） */

function startOfDay(y, m, d) {
  return new Date(y, m, d, 0, 0, 0, 0).getTime();
}

function entry(title, y, month, day, dayCount, holidayType, hint = '') {
  return {
    title,
    at: startOfDay(y, month, day),
    dayCount: Math.max(1, Number(dayCount) || 1),
    holidayType,
    hint: hint || `当前处于${title}，节奏与平日不同，角色可自然提及假期安排。`,
  };
}

/** @param {number} year 公历年 */
export function getCivicHolidaysForYear(year) {
  const y = Number(year);
  if (!Number.isFinite(y) || y < 1970 || y > 2100) return [];
  return [
    entry('元旦假期', y, 0, 1, 3, 'newYear'),
    entry('春节假期', y, 1, 10, 6, 'springFestival', '春节前后走亲访友、拜年、居家团聚氛围更浓。'),
    entry('清明假期', y, 3, 4, 3, 'qingming'),
    entry('劳动节假期', y, 4, 1, 5, 'laborDay'),
    entry('端午假期', y, 5, 10, 3, 'duanwu'),
    entry('暑期', y, 6, 15, 31, 'summerBreak', '暑期活动范围可放宽，适合旅行、宅家、补觉与轻社交。'),
    entry('中秋假期', y, 8, 15, 3, 'midAutumn'),
    entry('国庆假期', y, 9, 1, 7, 'nationalDay'),
  ];
}

export function listHolidaysCoveringTimestamp(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return [];
  const y = new Date(t).getFullYear();
  const years = [y - 1, y, y + 1];
  const hits = [];
  for (const year of years) {
    for (const holiday of getCivicHolidaysForYear(year)) {
      const end = holiday.at + holiday.dayCount * 86400000;
      if (t >= holiday.at && t < end) hits.push(holiday);
    }
  }
  return hits;
}

export function getPrimaryHolidayAt(ts) {
  const hits = listHolidaysCoveringTimestamp(ts);
  if (!hits.length) return null;
  return hits.sort((a, b) => b.dayCount - a.dayCount)[0];
}
