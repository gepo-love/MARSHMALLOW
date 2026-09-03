import { saveMessage } from '../chat-store.js';
import * as db from '../db.js';
import { getNowForUser } from '../time-mode.js';
import { resolveTargetRef } from '../marshmallow-protocol.js';
import { createMessage } from '../../models/chat.js';

async function resolveNameAsync(resolveName, id) {
  if (typeof resolveName !== 'function') return String(id || '');
  const value = resolveName(id);
  if (value && typeof value.then === 'function') return String((await value) || id || '');
  return String(value || id || '');
}

function isPendingTransfer(msg = {}) {
  if (!msg || msg.type !== 'transfer') return false;
  const st = String(msg.metadata?.transferState || 'pending').trim();
  return st === 'pending' || !st;
}

export function createTransferReceiptMessage(transfer = {}, {
  actorId = '',
  actorName = '',
  timestamp = Date.now(),
  aiRoundId = '',
} = {}) {
  const sourceId = String(transfer?.id || '').trim();
  const resolvedActorId = String(actorId || '').trim();
  if (!sourceId || !resolvedActorId) return null;
  return createMessage({
    id: `transfer_receipt_${sourceId}_${resolvedActorId}`,
    chatId: String(transfer.chatId || ''),
    senderId: resolvedActorId,
    senderName: String(actorName || resolvedActorId),
    type: 'transferReceipt',
    content: '已收款',
    timestamp,
    metadata: {
      financeEvent: 'transfer_accepted',
      sourceFinanceMessageId: sourceId,
      amount: String(transfer.metadata?.amount ?? transfer.content ?? ''),
      transferNote: String(transfer.metadata?.transferNote || transfer.metadata?.note || ''),
      transferState: 'accepted',
      transferResolvedById: resolvedActorId,
      transferResolvedByName: String(actorName || resolvedActorId),
      ...(aiRoundId ? { aiRoundId, aiGenerated: true } : {}),
    },
  });
}

/**
 * 处理 AI 协议 transfer_accept / transfer_return：更新原转账卡状态。
 * 成功收款时由收款方追加一张结构化小回执卡，不再写突兀的系统文字。
 * 同轮多条按顺序串行，避免后序事件读到旧 metadata。
 */
export async function applyTransferEvents(events = [], {
  chatId = '',
  messages = [],
  userId = '',
  resolveName = (id) => id,
  aiRoundId = '',
} = {}) {
  const saved = [];
  if (!chatId || !Array.isArray(events) || !events.length) return saved;

  const pool = Array.isArray(messages) ? messages : [];
  /** @type {Map<string, object>} */
  const liveById = new Map();
  for (const m of pool) {
    if (m?.id && m.type === 'transfer') liveById.set(m.id, m);
  }

  const baseTs = await getNowForUser(userId);

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const kind = String(event?.t || '').trim();
    if (kind !== 'transfer_accept' && kind !== 'transfer_return') continue;

    const actorId = String(event.from || event.actor || '').trim();
    if (!actorId || actorId === 'system' || actorId === 'user') continue;

    let targetMsg = null;
    const targetRef = event.target || event.messageId || event.message || event.ref;
    if (targetRef) {
      targetMsg = resolveTargetRef(targetRef, pool, []);
    }
    if (!targetMsg && event.messageId) {
      targetMsg = await db.getRecord('messages', String(event.messageId)).catch(() => null);
    }
    if (targetMsg?.id && liveById.has(targetMsg.id)) {
      targetMsg = liveById.get(targetMsg.id);
    }
    if (!isPendingTransfer(targetMsg)) continue;
    if (String(targetMsg.senderId || '') === actorId) continue;

    const actorName = await resolveNameAsync(resolveName, actorId);
    const nextState = kind === 'transfer_return' ? 'returned' : 'accepted';
    const updated = {
      ...targetMsg,
      metadata: {
        ...(targetMsg.metadata || {}),
        transferState: nextState,
        transferResolvedById: actorId,
        transferResolvedByName: actorName,
        transferResolvedAt: baseTs + i,
      },
    };
    await saveMessage(updated);
    liveById.set(updated.id, updated);
    const idx = pool.findIndex((m) => m?.id === updated.id);
    if (idx >= 0) pool[idx] = updated;

    let receipt = null;
    if (nextState === 'accepted') {
      receipt = createTransferReceiptMessage(updated, {
        actorId,
        actorName,
        timestamp: baseTs + i + 1,
        aiRoundId,
      });
      if (receipt) await saveMessage(receipt);
    }
    saved.push({ message: updated, receipt, system: null });
  }
  return saved;
}
