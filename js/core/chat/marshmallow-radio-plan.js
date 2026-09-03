import { getNowForUser, getUserTimezone } from '../time-mode.js';
import { parseMemoAt } from './marshmallow-memo.js';
import {
  createRadioPlan,
  findLatestActiveRadioPlan,
  updateRadioPlan,
} from '../radio-plans.js';

const MAX_EVENTS_PER_ROUND = 3;
const MAX_HORIZON_MS = 366 * 86400000;

function clean(value = '', max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function applyMarshmallowRadioPlanEvents(events = [], options = {}) {
  const userId = clean(options.userId || options.userRow?.id, 240);
  const sourceChat = options.sourceChat || null;
  const chatId = clean(sourceChat?.id || options.sourceChatId || '', 240);
  const participants = new Set((sourceChat?.participants || []).map((id) => clean(id, 240)).filter(Boolean));
  const items = (Array.isArray(events) ? events : []).filter((event) => event?.t === 'radio_plan');
  if (!items.length || !userId || !chatId || sourceChat?.type !== 'private') {
    return { handled: 0, skipped: items.length, errors: [] };
  }

  const now = await getNowForUser(userId).catch(() => Date.now());
  const timeZone = await getUserTimezone(userId).catch(() => '');
  let handled = 0;
  let skipped = 0;
  const errors = [];

  for (const event of items.slice(0, MAX_EVENTS_PER_ROUND)) {
    const characterId = clean(event.from || event.actor, 240);
    const operation = ['update', 'cancel'].includes(event.operation) ? event.operation : 'create';
    if (!characterId || characterId === 'user' || (participants.size && !participants.has(characterId))) {
      skipped += 1;
      continue;
    }
    try {
      const current = operation === 'create' ? null : await findLatestActiveRadioPlan(userId, { chatId, characterId });
      if (operation === 'cancel') {
        if (!current) {
          skipped += 1;
          continue;
        }
        await updateRadioPlan(userId, current.id, {
          status: 'cancelled',
          completedAt: Date.now(),
          leaseUntil: 0,
          retryAt: 0,
        });
        if (current.episodeId) {
          await import('../radio-episodes.js')
            .then((mod) => mod.deleteRadioEpisode?.(current.episodeId))
            .catch(() => {});
        }
        handled += 1;
        continue;
      }

      const parsedAt = event.at ? parseMemoAt(event.at, now, timeZone) : NaN;
      const dueAt = Number.isFinite(parsedAt) ? parsedAt : Number(current?.dueAt || 0);
      if (!dueAt || dueAt <= now || dueAt - now > MAX_HORIZON_MS) {
        skipped += 1;
        errors.push({ characterId, message: 'radio_plan_time_out_of_range' });
        continue;
      }
      const patch = {
        dueAt,
        topic: clean(event.topic, 1000) || current?.topic || '',
        note: clean(event.note, 800) || current?.note || '',
        type: clean(event.radioType || event.typeId || event.kind, 40) || current?.type || 'bedtime',
        minutes: Number(event.minutes || current?.minutes || 8),
        actionMode: clean(event.actionMode, 20) || current?.actionMode || 'hidden',
        ambientEnabled: event.ambientEnabled == null ? current?.ambientEnabled !== false : event.ambientEnabled !== false,
        status: 'pending',
        retryAt: 0,
        leaseUntil: 0,
        lastError: '',
        sourceAiRoundId: clean(options.aiRoundId, 120),
      };
      if (current) {
        await updateRadioPlan(userId, current.id, { ...patch, episodeId: '' });
        if (current.episodeId) {
          await import('../radio-episodes.js')
            .then((mod) => mod.deleteRadioEpisode?.(current.episodeId))
            .catch(() => {});
        }
      } else {
        await createRadioPlan(userId, { ...patch, characterId, chatId });
      }
      handled += 1;
    } catch (error) {
      skipped += 1;
      errors.push({ characterId, message: clean(error?.message || error || 'radio_plan_failed', 160) });
    }
  }
  skipped += Math.max(0, items.length - MAX_EVENTS_PER_ROUND);
  return { handled, skipped, errors };
}
