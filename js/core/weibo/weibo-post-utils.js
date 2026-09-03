import { stripLeakedCharacterCodes } from '../chat/character-code-fallback.js';
import {
  messageLikelyNeedsTranslation,
  sanitizeAiTranslation,
} from '../translation-utils.js';
import { aiCommentClaimsCurrentUser } from '../social-comment-identity.js';
import { getCharacterAiContextName } from '../../models/character.js';

const VIS_OK = new Set(['public', 'fans_only', 'private']);

function weiboActorAliases(character = {}) {
  return [
    character.id,
    character.name,
    character.realName,
    character.customNickname,
    character.weiboName,
    character.weiboNickname,
    ...(Array.isArray(character.aliases) ? character.aliases : []),
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function weiboActorAliasKey(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/^[@＠]+/, '')
    .replace(/[\s_.\-/·]+/g, '')
    .trim()
    .toLowerCase();
}

function generatedWeiboUserAliases(user = {}) {
  return [
    'user',
    '用户',
    '我',
    '我自己',
    '旅行者',
    user.id,
    user.name,
    user.nickname,
    user.preferredCallName,
    user.conversationName,
    user.weiboNickname,
    user.weiboId,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
}

function generatedNpcAuthorId(name = '') {
  const source = String(name || '微博网友');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `npc_${(hash >>> 0).toString(36)}`;
}

/** 微博公开称呼：平台昵称优先；没有单独昵称时用真名，通讯录备注只作最后兜底。 */
export function resolveWeiboCharacterPublicName(actor = {}, fallback = '') {
  const source = actor && typeof actor === 'object' ? actor : {};
  const characterName = source.realName || source.name
    ? getCharacterAiContextName(source, fallback || source.id || source.authorId)
    : '';
  return String(
    source.weiboNickname
    || source.weiboName
    || characterName
    || source.authorName
    || fallback
    || '',
  ).trim().replace(/^[@＠]+/, '');
}

function weiboMentionActorName(actor = {}) {
  return resolveWeiboCharacterPublicName(actor);
}

/**
 * 模型能看到稳定角色 id，偶尔会直接写成 @char_xxx。ID 只用于内部路由，
 * 微博正文和评论统一换成公开昵称；按 id 长度倒序，避免前缀相同的 id 抢先替换。
 */
export function replaceWeiboActorIdMentions(value = '', actors = []) {
  let text = String(value || '');
  const rows = (Array.isArray(actors) ? actors : [])
    .map((actor) => ({
      id: String(actor?.id || actor?.authorId || '').trim().replace(/^[@＠]+/, ''),
      name: weiboMentionActorName(actor || {}),
    }))
    .filter((row) => row.id && row.name && row.id !== row.name && !/^(?:npc|user)$/i.test(row.id))
    .sort((left, right) => right.id.length - left.id.length);
  const seen = new Set();
  for (const row of rows) {
    const key = row.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const escaped = row.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`([@＠])${escaped}(?![\\p{L}\\p{N}_-])`, 'giu'), `@${row.name}`);
  }
  return text;
}

/**
 * 自动生成微博的主作者必须来自可信角色、路人或平台账号，绝不能回落成当前用户。
 * 模型只写角色名、漏写 id 时，会按本轮可信角色的精确别名补回真实 id。
 */
export function normalizeGeneratedWeiboPostAuthor(item = {}, {
  user = null,
  trustedAuthors = [],
} = {}) {
  const source = item && typeof item === 'object' ? item : {};
  const rawId = String(source.authorId || source.actorId || '').trim();
  const rawName = stripLeakedCharacterCodes(
    String(source.authorName || source.author || '').trim(),
    { fallbackLabel: '微博网友' },
  ).trim();
  const characters = Array.isArray(trustedAuthors) ? trustedAuthors.filter((row) => row?.id) : [];
  const byId = characters.find((row) => String(row.id || '').trim() === rawId) || null;
  const rawNameKey = weiboActorAliasKey(rawName);
  const byName = rawNameKey
    ? characters.find((row) => weiboActorAliases(row).some((alias) => weiboActorAliasKey(alias) === rawNameKey)) || null
    : null;
  const matched = byId || byName;
  if (matched) {
    return {
      authorId: String(matched.id || '').trim(),
      authorName: resolveWeiboCharacterPublicName(matched, rawName || matched.id),
      ...(String(matched.avatar || '').trim() ? { avatar: String(matched.avatar).trim() } : {}),
    };
  }

  const userAliases = new Set(generatedWeiboUserAliases(user));
  const claimsUser = userAliases.has(rawId.toLowerCase()) || userAliases.has(rawName.toLowerCase());
  const isPlatform = /^(platform_|official)/i.test(rawId);
  if (isPlatform && !claimsUser) {
    return {
      authorId: rawId,
      authorName: rawName || '平台官方',
    };
  }

  const npcName = claimsUser ? '微博网友' : (rawName || (!/^user$/i.test(rawId) ? rawId : '') || '微博网友');
  return {
    authorId: generatedNpcAuthorId(npcName),
    authorName: npcName,
  };
}

/** 只修复有生成标记的旧微博，避免把用户手动发布的微博改成 NPC。 */
export function repairGeneratedWeiboPostAuthor(post = {}, options = {}) {
  const metadata = post?.metadata && typeof post.metadata === 'object' ? post.metadata : {};
  const isGenerated = metadata.generatedByAi === true
    || !!metadata.generationBatchId
    || !!metadata.generationMode;
  if (!isGenerated) return { changed: false, post };
  const author = normalizeGeneratedWeiboPostAuthor(post, options);
  const changed = author.authorId !== String(post?.authorId || '').trim()
    || author.authorName !== String(post?.authorName || '').trim()
    || (Object.prototype.hasOwnProperty.call(author, 'avatar')
      && author.avatar !== String(post?.avatar || '').trim());
  return changed ? { changed: true, post: { ...post, ...author } } : { changed: false, post };
}

/** 进入微博时顺手修复旧存档里已经落下的 @内部ID，手动发布内容不改。 */
export function repairGeneratedWeiboActorMentions(post = {}, actors = []) {
  const metadata = post?.metadata && typeof post.metadata === 'object' ? post.metadata : {};
  const isGenerated = metadata.generatedByAi === true
    || !!metadata.generationBatchId
    || !!metadata.generationMode;
  if (!isGenerated) return { changed: false, post };
  let changed = false;
  const repair = (value) => {
    const before = String(value || '');
    const after = replaceWeiboActorIdMentions(before, actors);
    if (after !== before) changed = true;
    return after;
  };
  const commentList = (Array.isArray(post.commentList) ? post.commentList : []).map((comment) => ({
    ...comment,
    content: repair(comment?.content),
  }));
  const nextMetadata = { ...metadata };
  if (metadata.repostFrom && typeof metadata.repostFrom === 'object') {
    nextMetadata.repostFrom = {
      ...metadata.repostFrom,
      content: repair(metadata.repostFrom.content),
    };
  }
  const next = {
    ...post,
    content: repair(post.content),
    commentList,
    metadata: nextMetadata,
  };
  return changed ? { changed: true, post: next } : { changed: false, post };
}

function matchTrustedWeiboActor({ authorId = '', authorName = '' } = {}, trustedAuthors = []) {
  const characters = Array.isArray(trustedAuthors) ? trustedAuthors.filter((row) => row?.id) : [];
  const rawId = String(authorId || '').trim();
  const rawNameKey = weiboActorAliasKey(authorName);
  return characters.find((row) => String(row.id || '').trim() === rawId)
    || (rawNameKey
      ? characters.find((row) => weiboActorAliases(row).some((alias) => weiboActorAliasKey(alias) === rawNameKey))
      : null)
    || null;
}

/**
 * AI 声称转发通讯录角色时，必须引用该角色真实存在的原帖。
 * 路人、媒体等站外/虚构来源仍可保留，避免把普通剧情转发一并误删。
 */
export function resolveGeneratedWeiboRepostMeta(repostFrom = {}, {
  existingPosts = [],
  trustedAuthors = [],
} = {}) {
  const source = repostFrom && typeof repostFrom === 'object' ? repostFrom : {};
  const rawAuthorId = String(source.authorId || source.repostFromAuthorId || '').trim();
  const rawAuthorName = stripLeakedCharacterCodes(
    String(source.authorName || source.repostFromAuthorName || '').trim(),
    { fallbackLabel: '原作者' },
  ).trim();
  if (!rawAuthorId && !rawAuthorName) return null;

  const trustedActor = matchTrustedWeiboActor({
    authorId: rawAuthorId,
    authorName: rawAuthorName,
  }, trustedAuthors);
  const rawPostId = String(source.postId || source.repostFromPostId || '').trim();
  const rawContent = stripLeakedCharacterCodes(
    String(source.content || source.repostFromContent || source.repostComment || '').trim(),
    { fallbackLabel: '原文' },
  ).trim();
  if (!trustedActor) {
    return {
      authorId: rawAuthorId,
      authorName: rawAuthorName,
      postId: rawPostId,
      content: rawContent,
    };
  }

  if (!rawPostId) return null;
  const candidates = Array.isArray(existingPosts) ? existingPosts : [];
  const sourcePost = candidates.find((post) => {
    if (String(post?.id || '').trim() !== rawPostId) return false;
    if (post?.status === 'failed' || post?.status === 'deleted' || Number(post?.deletedAt || 0) > 0) return false;
    if (isPrivateWeiboPost(post)) return false;
    return matchTrustedWeiboActor({
      authorId: post?.authorId,
      authorName: post?.authorName,
    }, [trustedActor]) !== null;
  }) || null;
  if (!sourcePost) return null;

  return {
    authorId: String(sourcePost.authorId || trustedActor.id || '').trim(),
    authorName: String(
      sourcePost.authorName
      || resolveWeiboCharacterPublicName(trustedActor)
      || rawAuthorName
      || trustedActor.id,
    ).trim(),
    postId: String(sourcePost.id || '').trim(),
    content: String(sourcePost.content || '').trim() || '（原文无文字）',
  };
}

/** 展示旧存档时移除 AI 生成但无法落到真实角色原帖的幽灵转发。 */
export function repairGeneratedWeiboRepostGrounding(post = {}, options = {}) {
  const metadata = post?.metadata && typeof post.metadata === 'object' ? post.metadata : {};
  const isGenerated = metadata.generatedByAi === true
    || !!metadata.generationBatchId
    || !!metadata.generationMode;
  if (!isGenerated || !metadata.repostFrom) return { changed: false, post };

  const resolved = resolveGeneratedWeiboRepostMeta(metadata.repostFrom, options);
  const current = metadata.repostFrom && typeof metadata.repostFrom === 'object'
    ? metadata.repostFrom
    : {};
  const same = resolved
    && ['authorId', 'authorName', 'postId', 'content']
      .every((key) => String(resolved[key] || '') === String(current[key] || ''));
  if (same) return { changed: false, post };

  const nextMetadata = { ...metadata };
  if (resolved) nextMetadata.repostFrom = resolved;
  else delete nextMetadata.repostFrom;
  return { changed: true, post: { ...post, metadata: nextMetadata } };
}

function weiboCommentActorAliases(character = {}) {
  return weiboActorAliases(character);
}

/**
 * 模型漏写 authorId、或把真实角色误标成 npc 时，只按本轮可信角色表中的精确称呼修复。
 * 已有明确的 user / 其它非 npc id 不按昵称猜测，避免同名路人抢占用户或其它身份。
 */
export function normalizeWeiboCommentAuthor(comment = {}, trustedAuthors = [], {
  coerceUnknownToNpc = false,
  protectedAuthorIds = [],
} = {}) {
  const source = comment && typeof comment === 'object' ? comment : {};
  const authorId = String(source.authorId || source.actorId || '').trim();
  const author = String(source.author || source.authorName || '').trim();
  const characters = Array.isArray(trustedAuthors) ? trustedAuthors.filter((row) => row?.id) : [];
  let matched = characters.find((row) => String(row.id || '').trim() === authorId) || null;
  if (!matched && (!authorId || /^npc$/i.test(authorId)) && author) {
    matched = characters.find((row) => weiboCommentActorAliases(row).includes(author)) || null;
  }
  if (!matched) {
    const protectedIds = new Set((protectedAuthorIds || []).map((value) => String(value || '').trim()).filter(Boolean));
    const claimsProtectedIdentity = /^user$/i.test(authorId) || protectedIds.has(authorId);
    // 补评论模型偶尔会把普通路人的昵称误填进 authorId，或直接漏写 authorId。
    // 评论业务只接受本轮可信角色与 npc；将其它非用户身份收束为 npc，避免整批静默过滤。
    if (coerceUnknownToNpc && !claimsProtectedIdentity && !/^npc$/i.test(authorId)) {
      return { ...source, authorId: 'npc', author };
    }
    return { ...source, authorId, author };
  }
  return {
    ...source,
    authorId: String(matched.id || '').trim(),
    author: resolveWeiboCharacterPublicName(matched, author || matched.id),
  };
}

/** 兼容旧存档中采用软删除标记、但尚未从数组移除的评论。 */
export function isActiveWeiboComment(comment = null) {
  return !!comment
    && comment.deleted !== true
    && comment.status !== 'deleted'
    && !Number(comment.deletedAt || 0);
}

export function repairWeiboPostCommentIdentities(post = {}, trustedAuthors = []) {
  const comments = Array.isArray(post?.commentList) ? post.commentList : [];
  let changed = false;
  const commentList = comments.map((comment) => {
    const normalized = normalizeWeiboCommentAuthor(comment, trustedAuthors);
    if (normalized.authorId !== String(comment?.authorId || '').trim()
      || normalized.author !== String(comment?.author || '').trim()) changed = true;
    return normalized;
  });
  return changed ? { changed: true, post: { ...post, commentList } } : { changed: false, post };
}

export function selectWeiboPreviewComments(comments = [], limit = 2) {
  const rows = Array.isArray(comments) ? comments : [];
  const count = Math.max(1, Math.trunc(Number(limit) || 2));
  const start = Math.max(0, rows.length - count);
  return rows.slice(start).map((comment, offset) => ({
    comment,
    index: start + offset,
  }));
}

/**
 * 给补评论模型的帖子摘要。纯图微博不能只传空 content，否则模型只能
 * 把它理解成“空白微博”。生成图优先用落库的文字图说明，其次用 imagePrompt；
 * 用户手动上传且无说明时，至少明确告知这是图片帖，禁止误评为空白。
 */
export function formatWeiboPostForCommentPrompt(post = {}) {
  const content = String(post?.content || '').replace(/\s+/g, ' ').trim();
  const textImage = String(post?.textImage || post?.textImageCaption || '').trim();
  const imagePrompt = String(post?.imagePrompt || '').replace(/\s+/g, ' ').trim();
  const imageCount = (Array.isArray(post?.images) ? post.images : []).filter(Boolean).length;
  const hasVisual = imageCount > 0 || !!textImage || !!imagePrompt || post?.imageKind === 'textimg';
  const lines = [`正文:${content || (hasVisual ? '（无文案的纯图微博）' : '（无正文）')}`];
  if (textImage) lines.push(`配图画面说明:${textImage.replace(/\s*\n\s*/g, ' / ').slice(0, 480)}`);
  else if (imagePrompt) lines.push(`配图画面提示:${imagePrompt.slice(0, 480)}`);
  else if (imageCount) lines.push(`配图:${imageCount}张（无可用画面说明）`);
  if (hasVisual) lines.push('评论规则:这是正常的图片帖；有画面说明时必须结合画面评论，禁止说“空白微博”、“什么都没发”或催促配文。');
  return lines.join('\n');
}

/**
 * 规范化 AI 输出的单条微博字段（主时间线生成、话题生成、个人主页生成共用）
 */
export function normalizePostFromAi(item = {}, {
  user = null,
  trustedCommentAuthorIds = [],
  trustedCommentAuthors = [],
  mentionActors = trustedCommentAuthors,
  hotCommentLimit = 12,
} = {}) {
  const content = stripLeakedCharacterCodes(
    replaceWeiboActorIdMentions(String(item.content || ''), mentionActors),
    { fallbackLabel: '某位用户' },
  ).trim();
  const contentTranslation = sanitizeAiTranslation(
    content,
    item.zh || item.translation || item.contentTranslation || '',
  );
  const hotComments = Array.isArray(item.hotComments)
    ? item.hotComments.map((rawComment) => {
        const c = normalizeWeiboCommentAuthor(rawComment, trustedCommentAuthors);
        const cContent = stripLeakedCharacterCodes(
          replaceWeiboActorIdMentions(String(c.content || ''), mentionActors),
          { fallbackLabel: '某位用户' },
        ).trim();
        const translation = sanitizeAiTranslation(cContent, c.zh || c.translation || '');
        return {
          authorId: String(c.authorId || '').trim(),
          author: stripLeakedCharacterCodes(String(c.author || '吃瓜网友'), { fallbackLabel: '吃瓜网友' }),
          content: cContent,
          likes: Number(c.likes || 0),
          ...(translation ? { translation } : {}),
        };
      })
        .filter((x) => x.content && (!user || !aiCommentClaimsCurrentUser(x, user, {
          trustedNonUserIds: [
            ...(trustedCommentAuthorIds || []),
            ...(trustedCommentAuthors || []).map((row) => String(row?.id || '').trim()).filter(Boolean),
          ],
        })))
        .slice(0, Math.max(0, Math.min(24, Number(hotCommentLimit) || 0)))
    : [];
  const safeTags = Array.isArray(item.tags)
    ? item.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 4)
    : [];
  const rawVis = String(item.visibility ?? item.vis ?? 'public').trim();
  const visibility = VIS_OK.has(rawVis) ? rawVis : 'public';
  const privatePost = visibility === 'private';
  return {
    content,
    tags: safeTags,
    repostFromAuthorId: String(item.repostFromAuthorId || '').trim(),
    repostFromAuthorName: stripLeakedCharacterCodes(String(item.repostFromAuthorName || ''), { fallbackLabel: '原作者' }).trim(),
    repostFromPostId: String(item.repostFromPostId || '').trim(),
    repostFromContent: stripLeakedCharacterCodes(replaceWeiboActorIdMentions(
      String(item.repostFromContent || item.repostOriginalContent || ''),
      mentionActors,
    ), { fallbackLabel: '原文' }).trim(),
    repostComment: stripLeakedCharacterCodes(replaceWeiboActorIdMentions(
      String(item.repostComment || ''),
      mentionActors,
    ), { fallbackLabel: '某位用户' }).trim(),
    reposts: privatePost ? 0 : Math.max(0, Number(item.reposts || 0)),
    comments: privatePost ? 0 : Math.max(0, Number(item.comments || 0), hotComments.length),
    likes: privatePost ? 0 : Math.max(0, Number(item.likes || 0)),
    hotComments: privatePost ? [] : hotComments,
    visibility,
    ...(contentTranslation ? { contentTranslation } : {}),
  };
}

/** 兼容新旧存档中的可见性字段。 */
export function getWeiboPostVisibility(postOrMetadata = {}) {
  const source = postOrMetadata && typeof postOrMetadata === 'object' ? postOrMetadata : {};
  const metadata = source.metadata && typeof source.metadata === 'object' ? source.metadata : source;
  const raw = String(metadata.visibility ?? source.visibility ?? 'public').trim();
  return VIS_OK.has(raw) ? raw : 'public';
}

export function isPrivateWeiboPost(post = {}) {
  return getWeiboPostVisibility(post) === 'private';
}

/**
 * 校验批量微博引用的角色生活素材归属。未引用生活素材的普通帖子不受影响；
 * 引用时，可信角色只能写自己的经历，路人/官号必须明确把素材主人作为报道对象。
 */
export function validateGeneratedWeiboLifeSource(item = {}, {
  authorId = '',
  trustedAuthorIds = [],
} = {}) {
  const sourceType = String(item?.sourceType || item?.lifeSourceType || 'free').trim().toLowerCase();
  if (sourceType !== 'life') return { ok: true, sourceType: sourceType || 'free' };
  const ownerId = String(item?.lifeSourceOwnerId || '').trim();
  const subjectCharacterId = String(item?.subjectCharacterId || '').trim();
  const trustedValues = Array.isArray(trustedAuthorIds)
    ? trustedAuthorIds
    : (trustedAuthorIds instanceof Set ? [...trustedAuthorIds] : []);
  const trusted = new Set(trustedValues.map((value) => String(value || '').trim()).filter(Boolean));
  const resolvedAuthorId = String(authorId || item?.authorId || '').trim();
  if (!ownerId || !trusted.has(ownerId)) return { ok: false, reason: 'missing-life-owner' };
  if (trusted.has(resolvedAuthorId) && resolvedAuthorId !== ownerId) {
    return { ok: false, reason: 'cross-character-life-source' };
  }
  if (!trusted.has(resolvedAuthorId) && subjectCharacterId !== ownerId) {
    return { ok: false, reason: 'missing-life-subject' };
  }
  return { ok: true, sourceType: 'life', ownerId, subjectCharacterId: subjectCharacterId || ownerId };
}

/** 前台展示用可见性角标文案 */
export function weiboVisibilityLabel(meta) {
  const v = getWeiboPostVisibility(meta);
  if (v === 'fans_only') return '粉丝可见';
  if (v === 'private') return '仅自己可见';
  return '';
}

function escapeWeiboHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 正文/评论旁的翻译按钮 + 折叠译文（对齐论坛/朋友圈） */
export function weiboTranslationSuffixHtml(source = '', translation = '') {
  const src = String(source || '').trim();
  if (!src) return '';
  const sanitized = sanitizeAiTranslation(src, translation);
  if (!sanitized && !messageLikelyNeedsTranslation(src)) return '';
  const escAttr = (v) => escapeWeiboHtml(v).replace(/"/g, '&quot;');
  return `<button type="button" class="chat-bubble-translate-btn weibo-translate-btn" data-translation-toggle data-translation-source="${escAttr(src)}" aria-expanded="false">翻译</button><div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-divider"></div><div class="chat-bubble-translation-text">${escapeWeiboHtml(sanitized || '')}</div></div>`;
}
