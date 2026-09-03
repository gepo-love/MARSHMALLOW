import { getNowForUser } from '../time-mode.js';
import {
  proposePeriodStart,
  confirmPeriodStart,
  declinePeriodStart,
  setActivePeriod,
  endActivePeriod,
} from '../period-tracker.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

function parseDay(raw = '') {
  const match = clean(raw).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return NaN;
  const ts = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : NaN;
}

/**
 * 经期事件只作用于当前私聊角色。period_set 在用户明确说来了/第几天时静默写入；
 * period_end 仅在用户明确表示结束后清除。offer/confirm/decline 仅兼容旧待确认。
 */
export async function applyMarshmallowPeriodEvents(events = [], options = {}) {
  const userId = clean(options.userId || options.userRow?.id);
  const chat = options.sourceChat || null;
  const chatId = clean(chat?.id || options.sourceChatId);
  const participants = new Set((chat?.participants || []).map(clean).filter(Boolean));
  const items = (Array.isArray(events) ? events : [])
    .filter((event) => ['period_offer', 'period_confirm', 'period_decline', 'period_set', 'period_end'].includes(event?.t));
  if (!userId || !chatId || !items.length) return { handled: 0, skipped: items.length, errors: [] };

  const errors = [];
  let handled = 0;
  let skipped = 0;
  const now = await getNowForUser(userId).catch(() => Date.now());
  const hasOffer = items.some((event) => event.t === 'period_offer');
  const hasConfirm = items.some((event) => event.t === 'period_confirm');
  if (hasOffer && hasConfirm) {
    return { handled: 0, skipped: items.length, errors: [{ message: 'period_offer_and_confirm_same_round' }] };
  }

  for (const event of items.slice(0, 1)) {
    const actorId = clean(event.from || event.actor);
    if (!actorId || actorId === 'user' || (participants.size && !participants.has(actorId))) {
      skipped += 1;
      errors.push({ actorId, message: 'period_actor_not_in_chat' });
      continue;
    }
    try {
      if (event.t === 'period_offer') {
        const dayTs = parseDay(event.day);
        const tracker = await proposePeriodStart(userId, { dayTs, characterId: actorId, chatId, now });
        if (!tracker) throw new Error('period_offer_invalid_day');
        handled += 1;
      } else if (event.t === 'period_set') {
        const result = await setActivePeriod(userId, {
          dayInPeriod: event.dayInPeriod,
          characterId: actorId,
          chatId,
          now,
        });
        if (!result.ok) throw new Error(result.reason || 'period_set_failed');
        handled += 1;
      } else if (event.t === 'period_end') {
        const result = await endActivePeriod(userId, { characterId: actorId, chatId });
        if (!result.ok) throw new Error(result.reason || 'period_end_failed');
        handled += 1;
      } else if (event.t === 'period_confirm') {
        const result = await confirmPeriodStart(userId, { characterId: actorId, chatId, now });
        if (!result.ok) throw new Error(result.reason || 'period_confirm_failed');
        handled += 1;
      } else {
        const result = await declinePeriodStart(userId, { characterId: actorId, chatId });
        if (!result.ok) throw new Error(result.reason || 'period_decline_failed');
        handled += 1;
      }
    } catch (error) {
      skipped += 1;
      errors.push({ actorId, message: clean(error?.message || error || 'period_event_failed').slice(0, 160) });
    }
  }
  return { handled, skipped, errors };
}
