import { enqueuePendingAction } from './pending-actions.js';
import { getPacingNowForUser } from '../time-mode.js';
import { recordCharacterPresence } from '../character-live-state.js';

const MIN_DELAY_MINUTES = 1;
const MAX_DELAY_MINUTES = 24 * 60;
// 回复可用性：短暂离开不动；离开一阵置 away；长时间离开置 offline。
// 到点按回复节奏钟恢复 online，不占用公开短句。
const STATUS_BRIDGE_MIN_MINUTES = 10;
const STATUS_BRIDGE_OFFLINE_MINUTES = 90;

function clean(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

export function normalizeNextReplyDelayEvent(event = {}, options = {}) {
  if (event?.t !== 'next_reply_delay') return null;
  const actorId = clean(event.from || event.actor);
  const participants = new Set((options.chat?.participants || []).map((id) => clean(id)).filter(Boolean));
  const minutes = Math.trunc(Number(event.minutes || event.delayMinutes || 0));
  if (!actorId || actorId === 'user' || (participants.size && !participants.has(actorId))) return null;
  if (!Number.isFinite(minutes) || minutes < MIN_DELAY_MINUTES || minutes > MAX_DELAY_MINUTES) return null;
  return {
    actorId,
    minutes,
    reason: clean(event.reason || event.topic, 300),
  };
}

export async function applyMarshmallowNextReplyDelayEvents(events = [], options = {}, overrides = {}) {
  const userId = clean(options.userId || options.user?.id);
  const chat = options.chat || options.sourceChat || null;
  const pacingNow = Math.trunc(Number(options.pacingNow || 0)) || await getPacingNowForUser(userId);
  const enabled = overrides.isEnabled
    ? await overrides.isEnabled(userId, chat)
    : await (async () => {
      try {
        const mod = await import('../character-autonomy-settings.js');
        const actorId = (chat?.participants || []).find((id) => id && id !== 'user');
        if (!actorId) return false;
        const policy = await mod.loadResolvedCharacterAutonomyPolicy?.(userId, actorId, chat?.id || '');
        return policy?.realPersonMode?.enabled === true;
      } catch (_) {
        return false;
      }
    })();
  const items = (Array.isArray(events) ? events : [])
    .map((event) => normalizeNextReplyDelayEvent(event, { chat }))
    .filter(Boolean);
  if (!userId || !chat?.id || !items.length || !enabled) {
    return { handled: 0, skipped: items.length, errors: [] };
  }

  const enqueue = overrides.enqueue || enqueuePendingAction;
  const errors = [];
  let handled = 0;
  let longestHandledMinutes = 0;
  for (const item of items.slice(0, 3)) {
    const result = await enqueue({
      userId,
      characterId: item.actorId,
      chatId: chat.id,
      kind: 'delayed_reply',
      dueAt: pacingNow + item.minutes * 60 * 1000,
      createdAt: pacingNow,
      dedupeKey: `next-reply:${chat.id}:${item.actorId}:${options.aiRoundId || pacingNow}`,
      payload: {
        reason: item.reason,
        sourceAiRoundId: clean(options.aiRoundId),
      },
    }).catch((error) => ({ ok: false, reason: clean(error?.message || error || 'enqueue-failed') }));
    if (result?.ok) {
      handled += 1;
      longestHandledMinutes = Math.max(longestHandledMinutes, item.minutes);
    } else {
      errors.push({ actorId: item.actorId, message: result?.reason || 'enqueue-failed' });
    }
  }
  // 「稍后回来」属于在线态，不再占用像个性签名一样的公开短句。
  if (handled > 0 && longestHandledMinutes >= STATUS_BRIDGE_MIN_MINUTES && options.hasStatusEvent !== true) {
    const offline = longestHandledMinutes >= STATUS_BRIDGE_OFFLINE_MINUTES;
    const actorIds = [...new Set(items.map((item) => item.actorId))];
    const recordPresence = overrides.recordPresence || recordCharacterPresence;
    await Promise.all(actorIds.map((actorId) => recordPresence(
      userId,
      actorId,
      offline ? 'offline' : 'away',
      {
        source: 'next_reply_delay',
        sourceChatId: chat.id,
        sourceRoundId: options.aiRoundId,
        updatedAt: pacingNow,
        expiresAt: pacingNow + longestHandledMinutes * 60 * 1000,
      },
    ).catch(() => null)));
  }
  return { handled, skipped: Math.max(0, items.length - handled), errors };
}
