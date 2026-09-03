import { listMomentPostsForUser } from './moments-store.js';
import { canCharacterSeeMomentPost } from './moments-visibility.js';
import { stripLeakedCharacterCodes } from '../chat/character-code-fallback.js';
import { getUserDisplayName } from '../../models/user.js';
import { resolveCharacterAiContextName } from '../../models/character.js';
import { getNowForUser, formatGapHint } from '../time-mode.js';
import { coerceMomentText, sanitizeMomentCommentText } from '../../models/moment-post.js';
import { resolveMomentInvolvedActorIds } from './moment-memory.js';

const MOMENTS_FEED_MAX_POSTS = 12;
/** Drop posts older than this from chat injection */
const MOMENTS_FEED_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;
/** Only within this window may the model treat a post as "just saw / very fresh" */
const MOMENTS_FEED_FRESH_MS = 36 * 60 * 60 * 1000;

function clip(text = '', max = 160) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function freshnessTag(gapMs = 0) {
  const gap = Math.max(0, Number(gapMs) || 0);
  if (gap <= 2 * 60 * 60 * 1000) return '刚发不久';
  if (gap <= MOMENTS_FEED_FRESH_MS) return '近一两天';
  if (gap <= 7 * 24 * 60 * 60 * 1000) return '近几天';
  return '较早';
}

function buildCharMap(characters = {}) {
  const map = new Map();
  for (const [id, row] of Object.entries(characters || {})) {
    if (id && row) map.set(String(id), row);
  }
  return map;
}

export function resolveMomentAuthorIdentity(post = {}, user = null, characters = {}) {
  const uid = String(user?.id || '').trim();
  const rawAuthorId = String(post.authorId || '').trim();
  const isUser = rawAuthorId === 'user' || (!!uid && rawAuthorId === uid);
  const authorId = isUser ? (uid || 'user') : (rawAuthorId || 'unknown');
  const rawName = isUser
    ? (getUserDisplayName(user) || '用户')
    : ((rawAuthorId ? resolveCharacterAiContextName(rawAuthorId, characters) : '')
      || String(post.authorName || '').trim());
  const fallbackName = isUser ? '用户' : '未知好友';
  const authorName = clip(stripLeakedCharacterCodes(rawName, { fallbackLabel: fallbackName }) || fallbackName, 40);
  return {
    authorType: isUser ? 'user' : (rawAuthorId ? 'character' : 'unknown'),
    authorId,
    authorName,
    isUser,
  };
}

export function formatMomentAuthorIdentityLine(post = {}, user = null, characters = {}) {
  const author = resolveMomentAuthorIdentity(post, user, characters);
  return `作者身份：authorType=${author.authorType}；authorId=${author.authorId}；authorName=${author.authorName}`;
}

function resolveActorLabel(actorId = '', name = '', characters = {}, user = null) {
  const id = String(actorId || '').trim();
  if (id === 'user' || id === String(user?.id || '').trim()) {
    return getUserDisplayName(user) || '用户';
  }
  const label = (id ? resolveCharacterAiContextName(id, characters) : '')
    || String(name || '').trim();
  return stripLeakedCharacterCodes(label, { fallbackLabel: '好友' }) || '好友';
}

export function postRelevantToChat(post = {}, partnerIds = [], charMap = null) {
  const partners = [...new Set((partnerIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!partners.length) return true;
  // 群聊使用一份共用 prompt；只要有一位成员不可见，就不能把动态灌给全群。
  return partners.every((id) => canCharacterSeeMomentPost(post, id, charMap));
}

function formatAudienceBoundary(post = {}, partnerIds = [], characters = {}, user = null) {
  const involved = new Set(resolveMomentInvolvedActorIds(post, user?.id || ''));
  const rows = [...new Set((partnerIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    .map((id) => `${resolveActorLabel(id, '', characters, user)}=${involved.has(id) ? '明确当事' : '仅看见/知情'}`);
  return rows.length ? `\n  关系边界：${rows.join('；')}` : '';
}

function formatPostBody(post = {}) {
  const imageCount = Array.isArray(post.images) ? post.images.filter(Boolean).length : 0;
  const imageHint = imageCount ? `（配图${imageCount}张）` : '';
  if (post.postKind === 'chat_share' && Array.isArray(post.chatShare?.lines) && post.chatShare.lines.length) {
    const title = clip(post.chatShare?.title || '聊天记录', 40);
    const excerpt = clip(post.chatShare.lines.slice(0, 2).map((line) => (
      typeof line === 'object' ? String(line?.text || line?.content || '') : String(line || '')
    )).filter(Boolean).join(' / '), 120);
    return `晒聊天「${title}」：${excerpt}${imageHint}`;
  }
  const body = clip(stripLeakedCharacterCodes(post.content || '', { fallbackLabel: '' }), 140);
  if (body) return `${body}${imageHint}`;
  if (imageCount) return `纯配图${imageCount}张`;
  return '';
}

function collectLikeLabels(post = {}, partnerIds = [], characters = {}, user = null) {
  const uid = String(user?.id || '').trim();
  const partnerSet = new Set((partnerIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const likeIds = [
    ...(Array.isArray(post.likesIds) ? post.likesIds : []),
    ...(Array.isArray(post.likes) ? post.likes.map((x) => (typeof x === 'string' ? '' : String(x?.id || x?.authorId || '').trim())) : []),
  ].map((id) => String(id || '').trim()).filter(Boolean);
  const out = [];
  for (const id of likeIds) {
    if (id === 'user' || id === uid) {
      out.push(getUserDisplayName(user) || '用户');
      continue;
    }
    if (partnerSet.has(id)) {
      out.push(resolveActorLabel(id, '', characters, user));
    }
  }
  return [...new Set(out)].slice(0, 4);
}

function collectCommentHints(post = {}, partnerIds = [], characters = {}, user = null) {
  const uid = String(user?.id || '').trim();
  const partnerSet = new Set((partnerIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  partnerSet.add('user');
  if (uid) partnerSet.add(uid);
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const hints = [];
  for (const comment of comments.slice(-6)) {
    const authorId = String(comment?.authorId || comment?.author || '').trim();
    if (!partnerSet.has(authorId) && authorId !== 'user' && authorId !== uid) continue;
    const who = resolveActorLabel(authorId, comment?.authorName, characters, user);
    const text = clip(sanitizeMomentCommentText(comment?.text || ''), 72);
    if (!text) continue;
    const replyTo = coerceMomentText(comment?.replyTo, { max: 48 });
    hints.push(replyTo ? `${who} 回复 ${replyTo}：${text}` : `${who}：${text}`);
    if (hints.length >= 3) break;
  }
  return hints;
}

function formatInteractionLine(post = {}, partnerIds = [], characters = {}, user = null) {
  const likes = collectLikeLabels(post, partnerIds, characters, user);
  const comments = collectCommentHints(post, partnerIds, characters, user);
  const bits = [];
  if (likes.length) bits.push(`赞：${likes.join('、')}`);
  if (comments.length) bits.push(...comments.map((line) => `评：${line}`));
  return bits.length ? `  互动：${bits.join('；')}` : '';
}

/**
 * 朋友圈公共动态块：注入聊天「过往与近况」时间线，思路对齐微博公共舆情块。
 * 按可见性过滤、带发布时间衰减，含赞/评摘要。
 */
export async function formatMomentsPublicFeedBlock(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return '';

  const partnerIds = [...new Set((options.partnerIds || [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const characters = options.characters || {};
  const user = options.user || null;
  const charMap = buildCharMap(characters);
  const requestedNow = Number(options.now || 0);
  const now = requestedNow > 0
    ? requestedNow
    : await getNowForUser(uid).catch(() => Date.now());
  const defaultMaxAgeMs = Math.max(1, Number(options.maxAgeMs) || MOMENTS_FEED_MAX_AGE_MS);
  const userPostMaxAgeMs = Math.max(1, Number(options.userPostMaxAgeMs) || defaultMaxAgeMs);

  const posts = (await listMomentPostsForUser(uid))
    .filter((post) => {
      const ts = Number(post?.timestamp || 0);
      const author = resolveMomentAuthorIdentity(post, user, characters);
      const maxAgeMs = author.isUser ? userPostMaxAgeMs : defaultMaxAgeMs;
      if (!ts || now - ts > maxAgeMs) return false;
      const body = formatPostBody(post);
      if (!body) return false;
      return postRelevantToChat(post, partnerIds, charMap);
    })
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, MOMENTS_FEED_MAX_POSTS);

  if (!posts.length) return '';

  const maxHours = Math.max(defaultMaxAgeMs, userPostMaxAgeMs) / (60 * 60 * 1000);
  const maxAgeLabel = maxHours >= 48 && Number.isInteger(maxHours / 24)
    ? `${maxHours / 24} 天内`
    : `${Math.round(maxHours)} 小时内`;
  let out = [
    `\n=== 来源：朋友圈公共动态（站内好友圈 · 按可见性 · 最近 ${maxAgeLabel}）===`,
    '说明：下列是角色与用户可能在好友圈里见过的动态。只是「可能知道」的社交背景，不代表本轮必须提起；多数时候完全不提也正常。',
    '时间语义（硬性）：每条动态的「发帖」已经结束，不是进行中的状态。禁止用进行时描述用户/角色「正在发这条圈」「正在经历正文里的事」；提起时用「前几天发过」「刷到你发过一条」这类完成时。',
    '标签含义：「刚发不久 / 近一两天」才接近刚刷到的新鲜感；「近几天 / 较早」只能当过往余波或回忆，不要复述成「刚刚发了」「你现在在…」。',
    '禁止连续多轮反复念叨同一条动态（除非人设本来就会盯着这件事）；心声同样适用。',
    '作者身份（硬性）：每条都有 authorType / authorId / authorName。只有 authorType=user 才是当前用户本人发布；character 和 unknown 都不是用户。不得因动态出现在用户的朋友圈页面，就认定由用户发布。',
    '用户发的圈：在场角色若可见，应知道用户发过相关内容，聊天时可自然承接，但不要像播报一样复述全文，也不要把旧圈当成用户此刻正在发生的事。',
    '亲历边界（硬性）：看见同一条朋友圈只代表各自知情，不代表这些角色一起经历了正文里的事。只有下方“关系边界”标为“明确当事”的角色，才可把它当成自己的经历；“仅看见/知情”的角色禁止把正文中的“你、他、我们、一起”自动解释成自己，也不得据此生成与用户的共同记忆。',
  ].join('\n');

  for (const post of posts) {
    const ts = Number(post.timestamp || 0);
    const gap = ts ? Math.max(0, now - ts) : 0;
    const gapLabel = gap ? formatGapHint(gap) : '刚刚';
    const freshTag = freshnessTag(gap);
    const authorIdentity = formatMomentAuthorIdentityLine(post, user, characters);
    const body = formatPostBody(post);
    const interaction = formatInteractionLine(post, partnerIds, characters, user);
    const audienceBoundary = formatAudienceBoundary(post, partnerIds, characters, user);
    out += `\n--- ${gapLabel}前 · ${freshTag} · 已发布 ---\n${authorIdentity}\n正文：${body}${interaction}${audienceBoundary}`;
  }

  return out;
}
