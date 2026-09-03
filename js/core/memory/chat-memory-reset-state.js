import * as db from '../db.js';

function clean(value = '') {
  return String(value || '').trim();
}

export function chatMemoryResetStateKey(chatId = '') {
  const id = clean(chatId);
  return id ? `chatMemoryReset:${encodeURIComponent(id)}` : '';
}

export async function loadChatMemoryResetToken(chatId = '') {
  const key = chatMemoryResetStateKey(chatId);
  if (!key) return '';
  const row = await db.getRecord('settings', key).catch(() => null);
  return clean(row?.value?.token);
}

/** 让清除动作开始前已经在途的摘要失效，禁止它在删除完成后把旧记忆写回来。 */
export async function markChatMemoryReset(chatId = '') {
  const key = chatMemoryResetStateKey(chatId);
  if (!key) return null;
  const now = Date.now();
  const value = {
    version: 1,
    chatId: clean(chatId),
    resetAt: now,
    token: `${now}_${Math.random().toString(36).slice(2, 10)}`,
  };
  await db.putRecord('settings', { key, value, updatedAt: now });
  return value;
}
