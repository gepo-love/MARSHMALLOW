import {
  advanceVirtualTimeForMessages,
  getNowForUser,
  getUserTimezone,
  formatPromptTimeLine,
  buildVirtualTimeSnippet,
} from './time-mode.js';
import { listMessagesForChat, repairChatFutureTimestampDrift } from './chat-store.js';

export async function getVirtualNow(userId, offsetMs = 0) {
  const base = await getNowForUser(userId);
  return base + (Number(offsetMs) || 0);
}

export async function getVirtualTimePromptStamp(userId, ts) {
  const [t, timeZone] = await Promise.all([
    Number.isFinite(Number(ts)) ? Number(ts) : getNowForUser(userId),
    getUserTimezone(userId),
  ]);
  return formatPromptTimeLine(t, timeZone);
}

export async function nextChatMessageTimestamp(userId, chatId) {
  const now = await getNowForUser(userId);
  let msgs = await listMessagesForChat(chatId, 0);
  const repair = await repairChatFutureTimestampDrift(chatId, userId, {
    knownMessages: msgs,
    worldNow: now,
    allowVirtualRollback: true,
  });
  if (repair.repaired) msgs = await listMessagesForChat(chatId, 0);
  const last = msgs.filter((m) => m && !m.deleted && !m.recalled).slice(-1)[0];
  const lastTs = Number(last?.timestamp) || 0;
  const timestamp = Math.max(now, lastTs + 1000);
  // 转发、论坛/微博分享等入口不走聊天页的统一发送函数，需要在这里一并
  // 签发虚拟消息刻度；即使世界钟处于手动暂停，后续气泡也不会永远卡在同一分钟。
  await advanceVirtualTimeForMessages(userId, [timestamp]);
  return timestamp;
}

export async function getVirtualTimePromptForAi(userId, _fallbackTs) {
  const { getVirtualTimePromptForAi: core } = await import('./time-mode.js');
  return core(userId);
}

export { buildVirtualTimeSnippet };
