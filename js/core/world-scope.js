import * as db from './db.js';

/**
 * 世界作用域与身份作用域的唯一换算入口。
 * worldId 共享公共世界状态；userId 仍隔离身份人设、私聊与私人记忆。
 */
export function getUserWorldId(user = {}) {
  const id = String(user?.id || '').trim();
  return String(user?.worldId || user?.slotGroupId || id).trim() || id;
}

export async function resolveWorldIdForUser(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return '';
  const user = await db.getRecord('users', id).catch(() => null);
  return user ? getUserWorldId(user) : id;
}

export async function listWorldUsers(userIdOrWorldId = '') {
  const requested = String(userIdOrWorldId || '').trim();
  if (!requested) return [];
  const users = await db.getAllRecords('users').catch(() => []);
  const requestedUser = (Array.isArray(users) ? users : [])
    .find((user) => String(user?.id || '').trim() === requested);
  const worldId = requestedUser ? getUserWorldId(requestedUser) : requested;
  return (Array.isArray(users) ? users : []).filter((user) => getUserWorldId(user) === worldId);
}

export async function listWorldUserIds(userIdOrWorldId = '') {
  const users = await listWorldUsers(userIdOrWorldId);
  return users.map((user) => String(user?.id || '').trim()).filter(Boolean);
}
