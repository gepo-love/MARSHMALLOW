import {
  deleteRecord,
  getAllByIndex,
  getRecord,
  putRecord,
} from './db.js';
import {
  aliasBelongsTo,
  createAliasPublicSnapshot,
  normalizeAliasAccount,
  principalKey,
  validateAliasAccount,
} from './alias-account-model.js';
import { listChatsForUser, saveChat } from './chat-store.js';

const ALIAS_REVOCATION_KEY_PREFIX = 'aliasAccountRevocation_';

function aliasRevocationKey(accountId) {
  const id = String(accountId || '').trim();
  return id ? `${ALIAS_REVOCATION_KEY_PREFIX}${id}` : '';
}

/**
 * 用户明确删除过的马甲必须留下撤销标记。
 * 历史陌生会话仍可依靠 accountSnapshots 显示当时资料，但不能再据此补回账户或记忆。
 */
export async function getAliasAccountRevocation(accountId) {
  const key = aliasRevocationKey(accountId);
  if (!key) return null;
  const row = await getRecord('settings', key).catch(() => null);
  return row?.value && typeof row.value === 'object' ? row.value : null;
}

export async function isAliasAccountRevoked(accountId, {
  userId = '',
  ownerId = '',
} = {}) {
  const revoked = await getAliasAccountRevocation(accountId);
  if (!revoked) return false;
  const uid = String(userId || '').trim();
  const oid = String(ownerId || '').trim();
  if (uid && String(revoked.userId || '').trim() !== uid) return false;
  if (oid && String(revoked.ownerId || '').trim() !== oid) return false;
  return true;
}

async function syncAliasAccountSnapshots(account) {
  const chats = await listChatsForUser(account.userId).catch(() => []);
  const snapshot = createAliasPublicSnapshot(account);
  const affected = chats.filter((chat) => Object.values(chat.metadata?.accountIdentityMap || {}).includes(account.id));
  await Promise.all(affected.map(async (chat) => {
    chat.metadata = {
      ...chat.metadata,
      accountSnapshots: {
        ...(chat.metadata?.accountSnapshots || {}),
        [account.id]: snapshot,
      },
    };
    await saveChat(chat);
  }));
}

export async function getAliasAccount(accountId) {
  const id = String(accountId || '').trim();
  if (!id) return null;
  const row = await getRecord('aliasAccounts', id);
  return row ? normalizeAliasAccount(row) : null;
}

/**
 * @param {string} ownerType
 * @param {string} ownerId
 * @param {{ includeArchived?: boolean, userId?: string }} [options]
 *   userId：用户档位。角色马甲必须按档过滤，否则 A 档开的号会漏进 B 档列表/注入。
 */
export async function listAliasAccounts(ownerType, ownerId, options = {}) {
  const ownerKey = principalKey(ownerType, ownerId);
  if (!ownerKey) return [];
  const rows = await getAllByIndex('aliasAccounts', 'ownerKey', ownerKey);
  const uid = String(options.userId || '').trim();
  return rows
    .map((row) => normalizeAliasAccount(row))
    .filter((row) => options.includeArchived === true || row.status === 'active')
    // 有档位时严格匹配；无 userId 的旧脏数据不跨档展示，避免串号
    .filter((row) => !uid || String(row.userId || '').trim() === uid)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

/** 当前用户档位下全部角色马甲（可按角色 ID 集合过滤） */
export async function listCharacterAliasAccountsForUser(userId = '', options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const rows = await getAllByIndex('aliasAccounts', 'userId', uid);
  const allowOwners = options.characterIds instanceof Set
    ? options.characterIds
    : (Array.isArray(options.characterIds)
      ? new Set(options.characterIds.map((id) => String(id || '').trim()).filter(Boolean))
      : null);
  return rows
    .map((row) => normalizeAliasAccount(row))
    .filter((row) => row.ownerType === 'character')
    .filter((row) => options.includeArchived === true || row.status === 'active')
    .filter((row) => !allowOwners || allowOwners.has(row.ownerId))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function saveAliasAccount(input = {}, options = {}) {
  const checked = validateAliasAccount(input);
  if (!checked.ok) {
    const error = new Error(`马甲账户数据无效：${checked.errors.join(', ')}`);
    error.code = 'INVALID_ALIAS_ACCOUNT';
    error.details = checked.errors;
    throw error;
  }
  if (await isAliasAccountRevoked(checked.account.id) && options.restoreRevoked !== true) {
    const error = new Error('这个马甲已被删除，不能由聊天或历史快照自动恢复');
    error.code = 'ALIAS_ACCOUNT_REVOKED';
    throw error;
  }
  const existing = await getAliasAccount(checked.account.id).catch(() => null);
  if (existing && !aliasBelongsTo(existing, checked.account.ownerType, checked.account.ownerId)) {
    const error = new Error('不能把已有马甲改绑到另一个本体');
    error.code = 'ALIAS_OWNER_IMMUTABLE';
    throw error;
  }
  const account = normalizeAliasAccount({
    ...existing,
    ...checked.account,
    createdAt: existing?.createdAt || checked.account.createdAt,
    updatedAt: Date.now(),
  });
  await putRecord('aliasAccounts', account);
  await syncAliasAccountSnapshots(account);
  return account;
}

export async function archiveAliasAccount(accountId) {
  const existing = await getAliasAccount(accountId);
  if (!existing) return null;
  return saveAliasAccount({ ...existing, status: 'archived' });
}

/** 从马甲列表彻底移除；陌生会话仍保留当时的 accountSnapshots 前台资料。 */
export async function deleteAliasAccount(accountId) {
  const existing = await getAliasAccount(accountId);
  if (!existing) return false;
  const revocationKey = aliasRevocationKey(existing.id);
  await putRecord('settings', {
    key: revocationKey,
    value: {
      accountId: existing.id,
      userId: existing.userId,
      ownerType: existing.ownerType,
      ownerId: existing.ownerId,
      displayName: existing.displayName,
      revokedAt: Date.now(),
    },
    updatedAt: Date.now(),
  });
  await deleteRecord('aliasAccounts', existing.id);
  const { purgeAliasAccountMemory } = await import('./memory/memory-facts.js');
  await purgeAliasAccountMemory({
    userId: existing.userId,
    accountId: existing.id,
  });
  return true;
}

export async function deleteUnusedAliasAccount(accountId, { isReferenced } = {}) {
  const existing = await getAliasAccount(accountId);
  if (!existing) return false;
  if (typeof isReferenced === 'function' && await isReferenced(existing.id)) {
    await archiveAliasAccount(existing.id);
    return false;
  }
  await deleteRecord('aliasAccounts', existing.id);
  return true;
}
