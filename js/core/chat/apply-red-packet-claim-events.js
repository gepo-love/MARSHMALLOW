import { saveMessage } from '../chat-store.js';
import * as db from '../db.js';
import { createMessage } from '../../models/chat.js';
import { getNowForUser } from '../time-mode.js';
import { performRedPacketClaim, seedLuckySplitsIfNeeded } from './red-packet-claims.js';
import { resolveTargetRef } from '../marshmallow-protocol.js';

async function resolveNameAsync(resolveName, id) {
  if (typeof resolveName !== 'function') return String(id || '');
  const value = resolveName(id);
  if (value && typeof value.then === 'function') return String((await value) || id || '');
  return String(value || id || '');
}

/**
 * 处理 AI 协议 redpacket_claim 副作用：更新红包消息 metadata + 写入系统通知。
 *
 * 同轮多条 claim 必须串行，且每次基于上一笔更新后的红包消息；
 * 否则后序 claim 仍从旧 metadata 起步，会互相覆盖或校验失败，只剩第一个人。
 */
export async function applyRedPacketClaimEvents(events = [], {
  chatId = '',
  messages = [],
  userId = '',
  resolveName = (id) => id,
  aiRoundId = '',
} = {}) {
  const saved = [];
  if (!chatId || !Array.isArray(events) || !events.length) return saved;

  /** 可变池：resolveTargetRef 读这里；成功领取后就地替换为最新红包 */
  const pool = Array.isArray(messages) ? messages : [];
  /** @type {Map<string, object>} */
  const liveById = new Map();
  for (const m of pool) {
    if (m?.id && m.type === 'redpacket') liveById.set(m.id, m);
  }

  const baseTs = await getNowForUser(userId);

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event?.t !== 'redpacket_claim') continue;
    const claimerId = String(event.from || event.actor || '').trim();
    if (!claimerId || claimerId === 'system') continue;

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
    if (!targetMsg || targetMsg.type !== 'redpacket') continue;

    // messages 是生成开始时的快照。期间用户可能已经领取，或其它后台角色刚写入
    // 了记录；领取前必须重新读取当前值，避免用旧 metadata 把新记录覆盖掉。
    const persistedTarget = await db.getRecord('messages', String(targetMsg.id)).catch(() => null);
    if (persistedTarget?.type === 'redpacket') targetMsg = persistedTarget;

    const claimerName = await resolveNameAsync(resolveName, claimerId);
    let seeded = seedLuckySplitsIfNeeded(targetMsg);
    // 首次 seed 的份数要落库，避免同轮后序 claim 又按空 splits 重新切一份
    if (seeded !== targetMsg) {
      const prevSplits = targetMsg.metadata?.luckySplits;
      const nextSplits = seeded.metadata?.luckySplits;
      const newlySeeded = (!Array.isArray(prevSplits) || !prevSplits.length)
        && Array.isArray(nextSplits) && nextSplits.length;
      if (newlySeeded) {
        await saveMessage(seeded);
        liveById.set(seeded.id, seeded);
        const seedIdx = pool.findIndex((m) => m?.id === seeded.id);
        if (seedIdx >= 0) pool[seedIdx] = seeded;
      }
    }

    const senderName = (await resolveNameAsync(resolveName, seeded.senderId))
      || seeded.senderName
      || seeded.senderId
      || '';
    const result = performRedPacketClaim(seeded, {
      claimerId,
      claimerName,
      amount: event.amount || event.grab || '',
      senderName,
    });
    if (!result.ok) continue;

    const nextMeta = { ...(seeded.metadata || {}), ...(result.patch || {}) };
    const updated = { ...seeded, metadata: nextMeta };
    await saveMessage(updated);
    liveById.set(updated.id, updated);
    const idx = pool.findIndex((m) => m?.id === updated.id);
    if (idx >= 0) pool[idx] = updated;

    const sys = createMessage({
      chatId,
      senderId: 'system',
      senderName: '系统',
      type: 'system',
      content: result.systemText,
      timestamp: baseTs + i,
      metadata: {
        financeEvent: 'redpacket_grabbed',
        amount: result.got,
        claimerId,
        claimerName,
        sourceFinanceMessageId: updated.id,
        aiGenerated: true,
        aiRoundId,
      },
    });
    await saveMessage(sys);
    saved.push({ message: updated, system: sys });
  }
  return saved;
}
