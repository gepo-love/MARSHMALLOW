import { getNowForUser, getUserTimezone } from '../time-mode.js';
import { addUserMemo, MEMO_SOURCE_CHARACTER } from '../user-memos.js';
import { getZonedDateParts, timestampFromUserWallTime } from '../user-timezone.js';

const MAX_MEMOS_PER_ROUND = 3;
const MAX_HORIZON_MS = 366 * 86400000;

function clean(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 解析 AI 写的 at 时间，相对世界内当前时间 now：
 * - "YYYY-MM-DD HH:mm"（推荐格式，也接受 / 或 . 分隔、T 连接）
 * - "MM-DD HH:mm" → 就近的未来那一天
 * - "HH:mm" → 今天该时刻，已过则明天
 */
export function parseMemoAt(raw, now = Date.now(), timeZone = '') {
  const text = clean(raw).replace(/[T]/, ' ').replace(/[/.]/g, '-');
  if (!text) return NaN;

  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const ts = timestampFromUserWallTime({
      year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5],
    }, timeZone);
    return Number.isFinite(ts) ? ts : NaN;
  }
  m = text.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const base = getZonedDateParts(now, timeZone);
    let ts = timestampFromUserWallTime({
      year: base.year, month: +m[1], day: +m[2], hour: +m[3], minute: +m[4],
    }, timeZone);
    if (ts <= now) {
      ts = timestampFromUserWallTime({
        year: base.year + 1, month: +m[1], day: +m[2], hour: +m[3], minute: +m[4],
      }, timeZone);
    }
    return Number.isFinite(ts) ? ts : NaN;
  }
  m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const base = getZonedDateParts(now, timeZone);
    let dayProxy = new Date(base.year, base.month - 1, base.day);
    let ts = timestampFromUserWallTime({
      year: base.year, month: base.month, day: base.day, hour: +m[1], minute: +m[2],
    }, timeZone);
    if (ts <= now) {
      dayProxy.setDate(dayProxy.getDate() + 1);
      ts = timestampFromUserWallTime({
        year: dayProxy.getFullYear(),
        month: dayProxy.getMonth() + 1,
        day: dayProxy.getDate(),
        hour: +m[1],
        minute: +m[2],
      }, timeZone);
    }
    return Number.isFinite(ts) ? ts : NaN;
  }
  return NaN;
}

export async function applyMarshmallowMemoEvents(events = [], options = {}) {
  const userId = clean(options.userId || options.userRow?.id);
  const sourceChat = options.sourceChat || null;
  const participants = new Set((sourceChat?.participants || []).map((id) => clean(id)).filter(Boolean));
  const items = (Array.isArray(events) ? events : []).filter((event) => event?.t === 'memo');
  if (!items.length || !userId) {
    return { handled: 0, skipped: items.length, errors: [] };
  }

  const now = await getNowForUser(userId).catch(() => Date.now());
  const timeZone = await getUserTimezone(userId).catch(() => '');
  let handled = 0;
  let skipped = 0;
  const errors = [];

  for (const event of items) {
    if (handled >= MAX_MEMOS_PER_ROUND) {
      skipped += 1;
      continue;
    }
    const actorId = clean(event.from || event.actor || '');
    if (!actorId || actorId === 'user' || (participants.size && !participants.has(actorId))) {
      skipped += 1;
      continue;
    }
    const title = clean(event.title);
    const ts = parseMemoAt(event.at, now, timeZone);
    if (!title || !Number.isFinite(ts)) {
      skipped += 1;
      errors.push({ actorId, message: !title ? 'memo_missing_title' : `memo_bad_time:${clean(event.at).slice(0, 40)}` });
      continue;
    }
    if (ts <= now || ts - now > MAX_HORIZON_MS) {
      skipped += 1;
      errors.push({ actorId, message: 'memo_time_out_of_range' });
      continue;
    }
    try {
      await addUserMemo(userId, {
        ts,
        title,
        note: clean(event.note),
        source: MEMO_SOURCE_CHARACTER,
        characterId: actorId,
        chatId: clean(sourceChat?.id || options.sourceChatId || ''),
        remind: event.remind !== false,
      });
      handled += 1;
    } catch (error) {
      skipped += 1;
      errors.push({ actorId, message: clean(error?.message || error || 'memo_failed').slice(0, 160) });
    }
  }

  return { handled, skipped, errors };
}
