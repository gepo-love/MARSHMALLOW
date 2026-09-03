import { getUserDisplayName, getWeiboDisplayName } from '../models/user.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

function isCurrentUserId(value, user = {}) {
  const id = clean(value);
  if (!id) return false;
  return /^user$/i.test(id) || id === clean(user?.id);
}

export function buildCurrentUserCommentAliases(user = {}) {
  return new Set([
    getUserDisplayName(user),
    getWeiboDisplayName(user),
    user?.weiboNickname,
    user?.nickname,
    user?.name,
  ].map(clean).filter(Boolean));
}

/**
 * 已落库评论是否明确由当前用户亲自发送。
 * 展示名不参与判断，避免同名 NPC 或缺 id 的 AI 评论被误认成用户。
 * 「旅行者」仅用于兼容早期微博里明确代表用户的固定旧标记。
 */
export function isExplicitCurrentUserComment(comment = {}, user = {}, {
  legacyUserLabels = [],
} = {}) {
  const authorId = clean(comment?.authorId || comment?.actorId);
  if (authorId) return isCurrentUserId(authorId, user);
  const author = clean(comment?.author || comment?.authorName);
  return !!author && new Set((legacyUserLabels || []).map(clean).filter(Boolean)).has(author);
}

/**
 * AI 新生成的评论是否在冒充当前用户。
 * 有明确的非用户 authorId 时以 id 为准，允许同名角色；缺 id 时才用用户名集合兜底拦截。
 */
export function aiCommentClaimsCurrentUser(comment = {}, user = {}, {
  trustedNonUserIds = [],
} = {}) {
  const authorId = clean(comment?.authorId || comment?.actorId);
  if (authorId && isCurrentUserId(authorId, user)) return true;
  const author = clean(comment?.author || comment?.authorName);
  if (!author || !buildCurrentUserCommentAliases(user).has(author)) return false;
  // 只有业务层提供的真实角色白名单才能证明这是同名 NPC；模型自报 id 不可信。
  const trusted = trustedNonUserIds instanceof Set
    ? trustedNonUserIds
    : new Set((trustedNonUserIds || []).map(clean).filter(Boolean));
  return !authorId || !trusted.has(authorId);
}

export function filterAiGeneratedComments(comments = [], user = {}, {
  allowedAuthorIds = [],
  trustedNonUserIds = [],
} = {}) {
  const allowed = allowedAuthorIds instanceof Set
    ? allowedAuthorIds
    : new Set((allowedAuthorIds || []).map(clean).filter(Boolean));
  return (Array.isArray(comments) ? comments : []).filter((comment) => {
    const authorId = clean(comment?.authorId || comment?.actorId);
    const content = clean(comment?.content ?? comment?.text);
    return content
      && (!allowed.size || allowed.has(authorId))
      && !aiCommentClaimsCurrentUser(comment, user, { trustedNonUserIds });
  });
}
