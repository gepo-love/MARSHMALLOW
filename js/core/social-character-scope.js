import { listCharacters } from './character-store.js';
import { getUserById, listUsersInSlot } from './user-slot.js';
import {
  hasActiveIdentityBinding,
  identityBindingSelectsCharacter,
} from '../models/user.js';

function clean(value = '') {
  return String(value || '').trim();
}

/**
 * 社交媒体属于 user 面具。已绑定身份时只取本面具绑定角色；未绑定时可用公共角色，
 * 但必须排除已经明确绑定给同槽位其它面具的角色，避免微博/朋友圈/论坛跨档串人。
 */
export async function listSocialVisibleCharacters(user = null, options = {}) {
  const userId = clean(user?.id || options.userId);
  if (!userId) return [];
  const effectiveUser = user?.id ? user : await getUserById(userId).catch(() => null);
  const rows = await listCharacters({
    excludeAnonNpc: options.excludeAnonNpc !== false,
    includeInternal: options.includeInternal === true,
    userId,
    identityScoped: true,
  }).catch(() => []);
  if (hasActiveIdentityBinding(effectiveUser?.identityBinding)) return rows;

  const siblings = await listUsersInSlot(userId).catch(() => []);
  const otherBindings = (Array.isArray(siblings) ? siblings : [])
    .filter((row) => clean(row?.id) !== userId && hasActiveIdentityBinding(row?.identityBinding))
    .map((row) => row.identityBinding);
  if (!otherBindings.length) return rows;
  return rows.filter((character) => !otherBindings.some((binding) => (
    identityBindingSelectsCharacter(binding, character)
  )));
}
