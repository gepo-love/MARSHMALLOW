import * as db from '../db.js';
import { saveMessage } from '../chat-store.js';

/**
 * Increment an emoji reaction on a message (stored in metadata.reactions).
 * @param {string} messageId
 * @param {string} emoji
 * @param {{ aiRoundId?: string, byUser?: boolean }} [options]
 * @returns {Promise<object|null>} updated message or null if missing
 */
export async function applyEmojiReactionToMessage(messageId, emoji, options = {}) {
  const id = String(messageId || '').trim();
  const em = String(emoji || '').trim();
  if (!id || !em) return null;

  const msg = await db.getRecord('messages', id);
  if (!msg || msg.deleted || msg.recalled) return null;

  const aiRoundId = String(options.aiRoundId || '').trim();
  const metadata = { ...(msg.metadata || {}) };
  const reactions = { ...(metadata.reactions || {}) };
  reactions[em] = Math.max(0, Number(reactions[em] || 0)) + 1;
  metadata.reactions = reactions;

  if (aiRoundId) {
    const byRound = { ...(metadata.reactionsByAiRound || {}) };
    const roundRx = { ...(byRound[aiRoundId] || {}) };
    roundRx[em] = Math.max(0, Number(roundRx[em] || 0)) + 1;
    byRound[aiRoundId] = roundRx;
    metadata.reactionsByAiRound = byRound;
  } else if (options.byUser) {
    const byUser = { ...(metadata.reactionsByUser || {}) };
    byUser[em] = Math.max(0, Number(byUser[em] || 0)) + 1;
    metadata.reactionsByUser = byUser;
  }

  const next = { ...msg, metadata };
  await saveMessage(next);
  return next;
}

/**
 * Remove one user-applied emoji reaction from a message.
 * @param {string} messageId
 * @param {string} emoji
 * @returns {Promise<object|null>}
 */
export async function removeUserEmojiReactionFromMessage(messageId, emoji) {
  const id = String(messageId || '').trim();
  const em = String(emoji || '').trim();
  if (!id || !em) return null;

  const msg = await db.getRecord('messages', id);
  if (!msg || msg.deleted || msg.recalled) return null;

  const metadata = { ...(msg.metadata || {}) };
  const byUser = { ...(metadata.reactionsByUser || {}) };
  const userCount = Math.max(0, Number(byUser[em] || 0));
  if (!userCount) return null;

  const nextUserCount = userCount - 1;
  if (nextUserCount > 0) byUser[em] = nextUserCount;
  else delete byUser[em];
  if (Object.keys(byUser).length) metadata.reactionsByUser = byUser;
  else delete metadata.reactionsByUser;

  const reactions = { ...(metadata.reactions || {}) };
  const nextCount = Math.max(0, Number(reactions[em] || 0) - 1);
  if (nextCount > 0) reactions[em] = nextCount;
  else delete reactions[em];
  if (Object.keys(reactions).length) metadata.reactions = reactions;
  else delete metadata.reactions;

  const next = { ...msg, metadata };
  await saveMessage(next);
  return next;
}

/**
 * Remove emoji reactions that were applied by a specific AI round (for reroll).
 * @param {string} chatId
 * @param {string} aiRoundId
 * @returns {Promise<number>} number of messages updated
 */
export async function undoEmojiReactionsForAiRound(chatId, aiRoundId) {
  const cid = String(chatId || '').trim();
  const rid = String(aiRoundId || '').trim();
  if (!cid || !rid) return 0;

  const all = await db.getAllByIndex('messages', 'chatId', cid);
  let changed = 0;
  for (const msg of all) {
    if (!msg || msg.deleted || msg.recalled) continue;
    const roundRx = msg.metadata?.reactionsByAiRound?.[rid];
    if (!roundRx || typeof roundRx !== 'object') continue;

    const metadata = { ...(msg.metadata || {}) };
    const reactions = { ...(metadata.reactions || {}) };
    for (const [em, count] of Object.entries(roundRx)) {
      const n = Math.max(0, Number(count) || 0);
      if (!n) continue;
      const next = Math.max(0, Number(reactions[em] || 0) - n);
      if (next > 0) reactions[em] = next;
      else delete reactions[em];
    }

    if (Object.keys(reactions).length) metadata.reactions = reactions;
    else delete metadata.reactions;

    const byRound = { ...(metadata.reactionsByAiRound || {}) };
    delete byRound[rid];
    if (Object.keys(byRound).length) metadata.reactionsByAiRound = byRound;
    else delete metadata.reactionsByAiRound;

    await saveMessage({ ...msg, metadata });
    changed += 1;
  }
  return changed;
}
