import * as db from '../db.js';
import { saveMessage, recalcChatPreview } from '../chat-store.js';
import { getMessageCopyText } from '../chat-helpers.js';
import { createMessage } from '../../models/chat.js';
import { getNowForUser } from '../time-mode.js';
import { RECALL_BLOCKED_TYPES } from '../marshmallow-protocol.js';

async function resolveNameAsync(resolveName, id) {
  if (typeof resolveName !== 'function') return String(id || '');
  const value = resolveName(id);
  if (value && typeof value.then === 'function') return String((await value) || id || '');
  return String(value || id || '');
}

// Deterministic FNV-1a hash, mirrors the user-side recall observer roll.
function recallHash(input = '') {
  let h = 2166136261;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function recallMessageContent(msg = {}) {
  const copied = getMessageCopyText(msg);
  if (copied) return copied;
  const md = msg.metadata || {};
  if (msg.type === 'image') return md.caption || md.prompt || '[图片]';
  if (msg.type === 'sticker') return md.label || md.name || '[表情]';
  if (msg.type === 'voice') return md.text || md.transcript || '[语音]';
  if (msg.type === 'link') return md.title || msg.content || '[链接]';
  return String(msg.content || `[${msg.type || '消息'}]`).trim();
}

async function buildRecallObservers(msg, { chat, resolveName, currentUserName }) {
  const senderId = String(msg.senderId || '').trim();
  const isGroup = chat?.type === 'group';
  const ids = (chat?.participants || [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'system' && id !== senderId);
  const rows = [];
  for (const id of ids) {
    rows.push({
      id,
      name: id === 'user'
        ? String(currentUserName || '用户')
        : await resolveNameAsync(resolveName, id),
      seen: (recallHash(`${msg.id}|${id}|recall`) % 100) < (isGroup ? 54 : 62),
    });
  }
  if (isGroup && rows.length > 1) {
    if (rows.every((r) => r.seen)) rows[rows.length - 1].seen = false;
    if (rows.every((r) => !r.seen)) rows[0].seen = true;
  }
  return rows;
}

/**
 * Apply AI-protocol recall events: mark the target message as recalled and
 * insert a system recall notice right after it, matching the user-side flow.
 * @returns {Promise<Array<{message: object, notice: object}>>}
 */
export async function applyMarshmallowRecallEvents(events = [], {
  chatId = '',
  chat = null,
  messages = [],
  userId = '',
  resolveName = (id) => id,
  currentUserName = '用户',
  aiRoundId = '',
} = {}) {
  const saved = [];
  if (!chatId || !Array.isArray(events) || !events.length) return saved;

  const pool = Array.isArray(messages) ? messages : [];
  const at = await getNowForUser(userId);

  for (const event of events) {
    if (String(event?.t || '') !== 'recall') continue;
    const actorId = String(event.from || event.actor || '').trim();
    const targetId = String(event.targetId || '').trim();
    if (!actorId || actorId === 'user' || actorId === 'system' || !targetId) continue;

    let msg = pool.find((m) => m?.id === targetId) || null;
    if (!msg) msg = await db.getRecord('messages', targetId).catch(() => null);
    if (!msg || msg.recalled || msg.deleted) continue;
    if (String(msg.senderId || '') !== actorId) continue;
    if (RECALL_BLOCKED_TYPES.has(String(msg.type || ''))) continue;

    const senderName = await resolveNameAsync(resolveName, actorId);
    const observers = await buildRecallObservers(msg, { chat, resolveName, currentUserName });
    // Keep the notice anchored right after the original message position.
    const noticeTs = Number(msg.timestamp || at) + 1;
    const notice = createMessage({
      chatId,
      senderId: 'system',
      senderName: '系统',
      type: 'system',
      content: `${senderName}撤回了一条消息`,
      timestamp: noticeTs,
      metadata: {
        recallNotice: true,
        recalledMessageId: msg.id,
        recalledSenderId: msg.senderId,
        recalledSenderName: senderName,
        recalledType: msg.type || 'text',
        recalledContent: recallMessageContent(msg),
        recallSeenBy: observers,
        recalledAt: at,
        aiGenerated: true,
        ...(aiRoundId ? { aiRoundId } : {}),
      },
    });
    const next = {
      ...msg,
      recalled: true,
      metadata: {
        ...(msg.metadata || {}),
        recalledAt: at,
        recallNoticeId: notice.id,
        recallSeenBy: observers,
        // Marks this recall as AI-applied so reroll can restore the message.
        ...(aiRoundId ? { recalledByAiRoundId: aiRoundId } : {}),
      },
    };
    await saveMessage(next);
    await saveMessage(notice);
    const idx = pool.findIndex((m) => m?.id === next.id);
    if (idx >= 0) pool[idx] = next;
    saved.push({ message: next, notice });
  }
  if (saved.length) await recalcChatPreview(chatId).catch(() => {});
  return saved;
}

/**
 * Reroll rollback: restore messages recalled by this AI round and delete the
 * matching recall notices (system notices survive the generic round delete).
 * @returns {Promise<number>} number of restored messages
 */
export async function undoRecallsForAiRound(chatId, aiRoundId) {
  const cid = String(chatId || '').trim();
  const rid = String(aiRoundId || '').trim();
  if (!cid || !rid) return 0;

  const all = await db.getAllByIndex('messages', 'chatId', cid);
  const noticeIds = [];
  let restored = 0;
  for (const msg of all) {
    if (!msg) continue;
    if (msg.metadata?.recallNotice && msg.metadata?.aiRoundId === rid) {
      noticeIds.push(msg.id);
      continue;
    }
    if (msg.recalled && msg.metadata?.recalledByAiRoundId === rid) {
      // Same-round messages are deleted by the round rollback itself; restoring
      // them here would race with that delete and resurrect the bubble.
      if (msg.metadata?.aiRoundId === rid) continue;
      const metadata = { ...(msg.metadata || {}) };
      delete metadata.recalledAt;
      delete metadata.recallNoticeId;
      delete metadata.recallSeenBy;
      delete metadata.recalledByAiRoundId;
      await saveMessage({ ...msg, recalled: false, metadata });
      restored += 1;
    }
  }
  if (noticeIds.length) await db.deleteMany('messages', noticeIds);
  return restored;
}
