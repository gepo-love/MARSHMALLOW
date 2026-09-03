import { looksLikeRawParticipantId } from './chat/character-code-fallback.js';

export const FORUM_AUTHOR_SOURCE = Object.freeze({
  USER: 'user',
  GENERATED: 'generated',
});

function clean(value = '') {
  return String(value || '').trim();
}

function identityKey(value = '') {
  return clean(value).toLocaleLowerCase('zh-CN').replace(/[\s_\-./]+/g, '');
}

const GENERATED_FORUM_USER_RESERVED_LABELS = Object.freeze([
  'user',
  '用户',
  '用户本人',
  '当前用户',
  '我',
  '我本人',
  '本人',
]);

function generatedForumUserIdentityKeys(user = {}, extraNames = []) {
  return new Set([
    ...GENERATED_FORUM_USER_RESERVED_LABELS,
    user.id,
    user.name,
    user.nickname,
    user.customNickname,
    user.displayName,
    ...(Array.isArray(extraNames) ? extraNames : []),
  ].map(identityKey).filter(Boolean));
}

/** AI 生成内容里的 author/user 标记只代表越界输出，绝不能取得用户发言归属。 */
export function generatedForumAuthorClaimsCurrentUser(raw = {}, user = {}, options = {}) {
  const reserved = generatedForumUserIdentityKeys(user, options.forbiddenNames);
  const authorIds = [
    raw.authorId,
    raw.authorRoleId,
    raw.roleId,
    raw.characterId,
    raw.actorId,
    raw.forumActorId,
  ].map(clean).filter(Boolean);
  if (authorIds.some((authorId) => reserved.has(identityKey(authorId)))) return true;
  const displayName = clean(raw.authorName || raw.author || raw.name || raw.authorAlias || raw.alias || raw.nickname);
  return !!displayName && reserved.has(identityKey(displayName));
}

/** 论坛 AI 主帖与楼层共用的作者身份收口。 */
export function sanitizeGeneratedForumReplyAuthor(raw = {}, characters = {}, options = {}) {
  const requestedRoleId = clean(raw.authorRoleId || raw.roleId || raw.characterId || raw.authorId);
  const hasStrictRoleScope = options.strictRoleScope === true;
  const roleId = requestedRoleId && (!hasStrictRoleScope || characters[requestedRoleId])
    ? requestedRoleId
    : '';
  const rawForumActorId = clean(raw.forumActorId);
  const claimsUser = generatedForumAuthorClaimsCurrentUser(raw, options.user || {}, {
    forbiddenNames: options.forbiddenNames,
  });
  const reservedIds = generatedForumUserIdentityKeys(options.user || {}, options.forbiddenNames);
  const forumActorId = rawForumActorId && !reservedIds.has(identityKey(rawForumActorId))
    ? rawForumActorId
    : '';
  return {
    author: claimsUser
      ? '匿名'
      : (clean(raw.author || raw.authorName || raw.name || raw.authorAlias) || '匿名'),
    authorSource: FORUM_AUTHOR_SOURCE.GENERATED,
    authorRoleId: claimsUser ? '' : roleId,
    forumActorId: claimsUser ? '' : forumActorId,
  };
}

/** “仅角色”生成时，模型漏写或写错 authorRoleId 也不能把所选角色降级成路人。 */
export function enforceForumRoleScopedAuthor(raw = {}, characters = [], index = 0) {
  const scope = (Array.isArray(characters) ? characters : [])
    .filter((character) => character?.id && character.id !== 'user');
  if (!scope.length) return raw;
  const allowed = new Set(scope.map((character) => clean(character.id)));
  const requested = clean(raw?.authorRoleId || raw?.roleId || raw?.characterId || raw?.authorId);
  if (allowed.has(requested)) return raw;
  const fallback = scope[Math.max(0, Number(index) || 0) % scope.length];
  return {
    ...raw,
    authorId: clean(fallback.id),
    authorRoleId: clean(fallback.id),
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

/**
 * 新数据以 authorSource 为准；较新的手工帖会落 authorVestId / authorVestBadge，
 * 包括选择“本人”时的空字符串。更早的手工帖只存用户显示名，需传入当前用户兼容判断。
 */
export function resolveForumAuthorSource(raw = {}, user = {}) {
  const explicit = clean(raw.authorSource).toLowerCase();
  if (explicit === FORUM_AUTHOR_SOURCE.USER || explicit === FORUM_AUTHOR_SOURCE.GENERATED) {
    return explicit;
  }
  if (hasOwn(raw, 'authorVestId') || hasOwn(raw, 'authorVestBadge')) {
    return FORUM_AUTHOR_SOURCE.USER;
  }
  const hasRoleOwner = Boolean(clean(raw.authorRoleId || raw.roleId || raw.characterId || raw.authorId));
  const authorName = clean(raw.authorName || raw.author || raw.name).toLowerCase();
  const userNames = new Set([
    user.id,
    user.name,
    user.nickname,
    user.customNickname,
    user.displayName,
  ].map((value) => clean(value).toLowerCase()).filter(Boolean));
  if (!hasRoleOwner && authorName && userNames.has(authorName)) {
    return FORUM_AUTHOR_SOURCE.USER;
  }
  return FORUM_AUTHOR_SOURCE.GENERATED;
}

export function isUserAuthoredForumThread(raw = {}, user = {}) {
  return resolveForumAuthorSource(raw, user) === FORUM_AUTHOR_SOURCE.USER;
}

/** 用户自己创建的论坛马甲只代表客户端归属，不代表角色知道账号本体。 */
export function isPrivateForumVestAuthor(raw = {}, user = {}) {
  return isUserAuthoredForumThread(raw, user) && !!clean(raw.authorVestId);
}

export function buildForumPublicAliasBoundary(raw = {}, user = {}, options = {}) {
  if (!isPrivateForumVestAuthor(raw, user)) return '';
  const subject = clean(options.subject || '当前主帖作者') || '当前主帖作者';
  const publicName = clean(raw.authorName || raw.author || raw.name) || '该论坛账号';
  return [
    '【公开论坛账号隔离 · 最高优先级】',
    `${subject}在公开页面只显示为账号「${publicName}」。本轮没有提供该账号的本体映射，所有回复者只能把它当作陌生或仅凭论坛互动认识的公开账号。`,
    '不得用用户档案、真实姓名、普通私聊、私人记忆、关注/点赞记录或“与用户很熟”的关系进度，把这个公开账号认作用户；文风、经历、口头禅或话题相似也不能作为确认身份的证据。',
    '禁止写“我知道是你”“别装了”“你的小号/马甲”或直接使用用户真实称呼。只有当前公开帖子或楼层自己明确自曝并给出可核对证据时，才可依据那段公开内容讨论；模糊线索最多产生不指向具体本体的怀疑。',
  ].join('\n');
}

/**
 * 统一回复归属字段，并修复详情页旧版规范化曾写入的空马甲字段。
 * 那批数据同时丢失了 authorSource，只能退回作者名兼容判断来恢复归属。
 */
export function normalizeForumAuthorOwnership(raw = {}, user = {}) {
  const explicit = clean(raw.authorSource).toLowerCase();
  const hasVestId = hasOwn(raw, 'authorVestId');
  const hasVestBadge = hasOwn(raw, 'authorVestBadge');
  const hasEmptyVestMarkers = (hasVestId || hasVestBadge)
    && !clean(raw.authorVestId)
    && !clean(raw.authorVestBadge);

  let authorSource;
  if (explicit === FORUM_AUTHOR_SOURCE.USER || explicit === FORUM_AUTHOR_SOURCE.GENERATED) {
    authorSource = explicit;
  } else if (hasEmptyVestMarkers) {
    const legacy = { ...raw };
    delete legacy.authorVestId;
    delete legacy.authorVestBadge;
    authorSource = resolveForumAuthorSource(legacy, user);
  } else {
    authorSource = resolveForumAuthorSource(raw, user);
  }

  const ownership = { authorSource };
  if (authorSource === FORUM_AUTHOR_SOURCE.USER) {
    if (hasVestId) ownership.authorVestId = clean(raw.authorVestId);
    if (hasVestBadge) ownership.authorVestBadge = clean(raw.authorVestBadge);
  }
  return ownership;
}

function characterNames(character = {}, fallbackId = '') {
  return [
    character.id,
    character.name,
    character.realName,
    character.customNickname,
    ...(Array.isArray(character.aliases) ? character.aliases : []),
    fallbackId,
  ].map(clean).filter(Boolean);
}

export function resolveForumAuthorIdentity(raw = {}, characters = {}) {
  const authorName = clean(raw.authorName || raw.author || raw.name);
  const authorId = clean(raw.authorId);
  const rawRoleId = clean(raw.authorRoleId || raw.roleId || raw.characterId);
  const alias = clean(raw.authorAlias || raw.alias || raw.accountName || raw.nickname);

  const byId = rawRoleId && characters[rawRoleId] ? rawRoleId : '';
  const byAuthorId = authorId && characters[authorId] ? authorId : '';
  let roleId = byId || byAuthorId;
  let authorAlias = alias;

  if (roleId && authorName && !authorAlias) {
    const names = characterNames(characters[roleId], roleId);
    const hit = names.find((name) =>
      authorName === name
      || authorName.startsWith(`${name}-`)
      || authorName.startsWith(`${name}－`)
      || authorName.startsWith(`${name}_`)
      || authorName.startsWith(`${name}的小号`)
      || authorName.startsWith(`${name}小号`));
    if (hit) {
      authorAlias = authorName.slice(hit.length).replace(/^[-－_\s·]+/, '').trim() || authorName;
    }
  }

  if (!roleId && authorName) {
    for (const [id, ch] of Object.entries(characters || {})) {
      const names = characterNames(ch, id);
      const hit = names.find((name) =>
        authorName === name
        || authorName.startsWith(`${name}-`)
        || authorName.startsWith(`${name}－`)
        || authorName.startsWith(`${name}_`)
        || authorName.startsWith(`${name}的小号`)
        || authorName.startsWith(`${name}小号`));
      if (!hit) continue;
      roleId = id;
      const rest = authorName.slice(hit.length).replace(/^[-－_\s·]+/, '').trim();
      authorAlias = authorAlias || rest || authorName;
      break;
    }
  }

  return {
    authorName,
    authorId,
    authorRoleId: roleId,
    authorAlias: authorAlias || (roleId && authorName ? authorName : ''),
  };
}

export function normalizeForumThreadAuthor(raw = {}, characters = {}) {
  const ident = resolveForumAuthorIdentity(raw, characters);
  const fallbackAlias = ident.authorRoleId ? '论坛匿名' : '';
  const displayName = ident.authorAlias || ident.authorName;
  const safeDisplayName = looksLikeRawParticipantId(displayName) ? '论坛匿名' : displayName;
  return {
    authorName: safeDisplayName || fallbackAlias || '匿名',
    authorId: ident.authorId || ident.authorRoleId || '',
    authorRoleId: ident.authorRoleId || '',
    authorAlias: safeDisplayName || '',
  };
}

/**
 * 只用于 AI / 自动生成帖子：仅允许已知角色 id 归属，清掉用户马甲字段，
 * 并在展示名撞到当前用户身份时匿名化。
 */
export function sanitizeGeneratedForumAuthor(raw = {}, characters = {}, options = {}) {
  const normalized = normalizeForumThreadAuthor(raw, characters);
  const roleId = clean(normalized.authorRoleId);
  const requestedRoleId = clean(raw.authorRoleId || raw.roleId || raw.characterId || raw.authorId);
  // 模型即使越界输出了其它面具的角色 ID，也不能在清掉归属后继续保留其真名。
  const referencesOutOfScopeRole = !!requestedRoleId && !characters[requestedRoleId];
  const user = options.user || {};
  const displayName = clean(normalized.authorAlias || normalized.authorName);
  const claimsUser = generatedForumAuthorClaimsCurrentUser({
    ...raw,
    authorName: displayName,
    authorAlias: displayName,
  }, user, {
    forbiddenNames: [options.userId, ...(Array.isArray(options.forbiddenNames) ? options.forbiddenNames : [])],
  });
  const safeDisplayName = referencesOutOfScopeRole || claimsUser
    ? '匿名'
    : (displayName || '匿名');

  return {
    authorName: safeDisplayName,
    authorId: roleId,
    authorRoleId: roleId,
    authorAlias: roleId ? safeDisplayName : '',
    authorSource: FORUM_AUTHOR_SOURCE.GENERATED,
    authorVestId: '',
    authorVestBadge: '',
  };
}
