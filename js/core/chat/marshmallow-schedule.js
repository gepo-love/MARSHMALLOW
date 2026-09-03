import { getCharacter } from '../character-store.js';
import { changeDailyLifePlanByCharacter } from '../character-daily-life.js';

function clean(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function getActorId(event = {}) {
  return clean(event.from || event.actor || event.senderId);
}

export async function applyMarshmallowScheduleEvents(events = [], options = {}) {
  const userId = clean(options.userId || options.userRow?.id);
  const sourceChat = options.sourceChat || null;
  const participants = new Set((sourceChat?.participants || []).map((id) => clean(id)).filter(Boolean));
  const items = (Array.isArray(events) ? events : []).filter((event) => event?.t === 'schedule_change');
  if (!items.length || !userId || !sourceChat) {
    return { handled: 0, skipped: items.length, errors: [] };
  }

  let handled = 0;
  let skipped = 0;
  const errors = [];
  const seenActors = new Set();

  for (const event of items) {
    const actorId = getActorId(event);
    if (!actorId || actorId === 'user' || !participants.has(actorId) || seenActors.has(actorId)) {
      skipped += 1;
      continue;
    }
    seenActors.add(actorId);
    if (handled >= 1) {
      skipped += 1;
      continue;
    }

    try {
      const character = options.characters?.[actorId] || await getCharacter(actorId);
      if (!character) {
        skipped += 1;
        continue;
      }
      await changeDailyLifePlanByCharacter({
        userId,
        characterId: actorId,
        character,
        user: options.userRow || null,
        blockId: clean(event.blockId || ''),
        reason: clean(event.reason || '聊天里临时改变安排'),
      });
      handled += 1;
    } catch (error) {
      skipped += 1;
      errors.push({
        actorId,
        message: clean(error?.message || error || 'schedule_change_failed').slice(0, 160),
      });
    }
  }

  return { handled, skipped, errors };
}
