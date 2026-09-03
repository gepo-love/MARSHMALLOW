export const ALIAS_OWNER_TYPES = Object.freeze(['character', 'user']);
export const ALIAS_CREATED_BY = Object.freeze(['user', 'ai']);
export const ALIAS_ACCOUNT_STATUSES = Object.freeze(['active', 'archived']);

const OWNER_TYPE_SET = new Set(ALIAS_OWNER_TYPES);
const CREATED_BY_SET = new Set(ALIAS_CREATED_BY);
const STATUS_SET = new Set(ALIAS_ACCOUNT_STATUSES);

function clean(value, max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function timestamp(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function principalKey(ownerType, ownerId) {
  const type = clean(ownerType).toLowerCase();
  const id = clean(ownerId);
  if (!OWNER_TYPE_SET.has(type) || !id || id.includes(':')) return '';
  return `${type}:${id}`;
}

export function parsePrincipalKey(value) {
  const raw = clean(value);
  const splitAt = raw.indexOf(':');
  if (splitAt <= 0) return null;
  const ownerType = raw.slice(0, splitAt);
  const ownerId = raw.slice(splitAt + 1);
  if (!OWNER_TYPE_SET.has(ownerType) || !ownerId) return null;
  return { ownerType, ownerId, key: `${ownerType}:${ownerId}` };
}

export function normalizeAliasAccount(input = {}, options = {}) {
  const now = timestamp(options.now, Date.now());
  const ownerType = clean(input.ownerType).toLowerCase();
  const ownerId = clean(input.ownerId, 160);
  const key = principalKey(ownerType, ownerId);
  const id = clean(input.id, 180) || `alias_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = timestamp(input.createdAt, now);
  const createdBy = CREATED_BY_SET.has(input.createdBy) ? input.createdBy : 'user';
  const status = STATUS_SET.has(input.status) ? input.status : 'active';

  return {
    id,
    ownerType,
    ownerId,
    ownerKey: key,
    userId: clean(input.userId, 160),
    displayName: clean(input.displayName, 60),
    handle: clean(input.handle, 60),
    avatar: clean(input.avatar),
    avatarPrompt: clean(input.avatarPrompt, 800),
    bio: clean(input.bio, 300),
    /** 本窗用途短标签（如「暗恋树洞」「拉黑后绕回」），供列表区分与高优注入 */
    windowLabel: clean(input.windowLabel, 40),
    personaOverlay: clean(input.personaOverlay, 4000),
    createdBy,
    status,
    createdAt,
    updatedAt: Math.max(createdAt, timestamp(input.updatedAt, now)),
  };
}

export function validateAliasAccount(input = {}) {
  const account = normalizeAliasAccount(input);
  const errors = [];
  if (!account.id) errors.push('missing-id');
  if (!OWNER_TYPE_SET.has(account.ownerType)) errors.push('invalid-owner-type');
  if (!account.ownerId) errors.push('missing-owner-id');
  if (!account.ownerKey) errors.push('invalid-owner-key');
  if (!account.userId) errors.push('missing-user-id');
  if (!account.displayName) errors.push('missing-display-name');
  if (account.id === account.ownerId || parsePrincipalKey(account.ownerId)) errors.push('alias-owner-not-principal');
  return { ok: errors.length === 0, errors, account };
}

export function aliasBelongsTo(account, ownerType, ownerId) {
  if (!account) return false;
  return clean(account.ownerKey) === principalKey(ownerType, ownerId);
}

export function normalizeAccountIdentityMap(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const [rawKey, rawAccountId] of Object.entries(source)) {
    const principal = parsePrincipalKey(rawKey);
    const accountId = clean(rawAccountId, 180);
    if (principal && accountId) output[principal.key] = accountId;
  }
  return output;
}

export function resolveFrontstageAccountId(identityMap, ownerType, ownerId) {
  return normalizeAccountIdentityMap(identityMap)[principalKey(ownerType, ownerId)] || '';
}

export function createAliasPublicSnapshot(account = {}) {
  const normalized = normalizeAliasAccount(account);
  return {
    accountId: normalized.id,
    displayName: normalized.displayName,
    handle: normalized.handle,
    avatar: normalized.avatar,
    bio: normalized.bio,
  };
}

/** 合并转发只携带前台账户线索；不把 character:/user: 本体键塞进卡片。 */
export function resolveSanitizedForwardAliasSource(chat = {}, senderId = '', userId = '') {
  if (String(chat?.metadata?.channelKind || '') !== 'stranger_intercept') return null;
  const id = clean(senderId, 180);
  const key = id === 'user'
    ? principalKey('user', userId)
    : principalKey('character', id);
  const accountId = clean(chat?.metadata?.accountIdentityMap?.[key], 180);
  // 旧陌生窗若缺少账号映射，也必须去掉本体 senderId；用仅限该线程的匿名来源键
  // 保住认知硬墙，不能因为迁移数据不完整就退回角色大名。
  if (!accountId) {
    const threadId = clean(chat?.id, 180) || 'unknown';
    return {
      accountId: `stranger_thread:${threadId}:${id === 'user' ? 'self' : 'peer'}`,
      sourceChannel: 'stranger',
      frontstageLabel: '陌生账号',
    };
  }
  const snapshot = chat?.metadata?.accountSnapshots?.[accountId] || {};
  const displayName = clean(snapshot.displayName, 60);
  const handle = clean(snapshot.handle, 60).replace(/^@+/, '');
  return {
    accountId,
    sourceChannel: 'stranger',
    frontstageLabel: displayName || (handle ? `@${handle}` : '') || '陌生账号',
  };
}

export function sanitizeForwardedAliasItem(item = {}, source = null) {
  if (!source?.accountId) return item;
  return {
    ...item,
    senderId: `alias_account:${clean(source.accountId, 180)}`,
    senderName: clean(source.frontstageLabel || item.senderName, 60) || '前台账户',
    sourceAliasAccountId: clean(source.accountId, 180),
    sourceChannel: 'stranger',
    frontstageLabel: clean(source.frontstageLabel, 60),
  };
}
