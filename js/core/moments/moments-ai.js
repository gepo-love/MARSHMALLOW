import { resolveGenerationMaxTokens } from '../api.js';
import { chatJsonGeneration } from '../chat-json-generation.js';
import { buildTimeAndHolidayPromptBlock, getNowForUser } from '../time-mode.js';
import { buildSurfacePresetBlock } from '../preset-store.js';
import {
  buildSocialFormatGuidancePrompt,
  socialIntentExplicitlyRequestsChatTranscript,
} from '../social-helpers.js';
import {
  coerceMomentChatLine,
  coerceMomentText,
  momentChatShareLineText,
  normalizeMomentComment,
  normalizeMomentChatShareLine,
  sanitizeMomentCommentText,
} from '../../models/moment-post.js';
import { buildImageUrlVisionParts } from '../chat/vision-context.js';
import {
  buildActorNameMap,
  collectPerAuthorChatEvidenceBlocks,
  collectPerAuthorChatLogBlocks,
  buildMomentsActors,
} from './moments-actors.js';
import {
  listMomentPostsForUser,
  loadMomentsPrefs,
} from './moments-store.js';
import { sampleMomentsReactionCommentCount } from './moments-comment-frequency.js';
import {
  applySocialPostImages,
  buildSocialImageGenPromptRules,
  normalizeSocialImagePrompt,
  resolveSocialImageGenMode,
} from '../social-image-generation.js';
import {
  MOMENTS_VOICE_RULES,
  MOMENTS_CONTENT_RULES,
  MOMENTS_COMMENT_STYLE_RULES,
  MOMENTS_MEMORY_ISOLATION_RULES,
  MOMENTS_CHAT_CONTINUITY_RULES,
  buildMomentsUserProfileBlock,
  buildMomentsSourceGroundingBlock,
  buildMomentsActorLocalTimeBlock,
  buildMomentsTimeFreshnessBlock,
  buildMomentsTimeSituationBlock,
  buildMomentsWorldBookBlock,
  buildMomentsRelationshipBlock,
  buildMomentsMemoryBlockPerCharacter,
  loadCharactersMap,
  buildMomentsCharacterCardsBlock,
  collectMomentsTranslationActors,
} from './build-moments-context.js';
import {
  buildJsonFieldTranslationPromptBlock,
  sanitizeAiTranslation,
} from '../translation-utils.js';
import {
  planMomentsScenarioBatch,
  formatScenarioDirectiveBlock,
  loadScenarioHistory,
  recordScenarioHistory,
} from './moments-scenarios.js';
import { getUserDisplayName } from '../../models/user.js';
import { getChatPlatformCopy } from '../chat/chat-platform-copy.js';
import {
  applyPhoneLightActorsToNameMap,
  buildMomentsReactionMapWithPhone,
  buildMomentsSocialCircleContext,
  formatMomentsReactionPoolBlock,
  formatPhoneLightContactsPromptBlock,
  mergePhoneLightActorsIntoCharacterMap,
  MOMENTS_NO_REACTION_CANDIDATES_MESSAGE,
  resolveMomentsReactionCandidates,
  isPhoneLightContactId,
  limitMomentsReactionMap,
} from './moments-social-circle.js';
import {
  buildMomentsVisibilityPromptBlock,
  canCharacterSeeMomentPost,
  filterMomentViewerIds,
  normalizeMomentVisibility,
} from './moments-visibility.js';
import { loadContactGroupsConfig } from '../contact-groups.js';
import {
  applyMomentPostStickers,
  buildMomentsStickerPromptBlock,
  loadFlatStickerPool,
} from './moments-stickers.js';
import { buildLifeMaterialBlock, buildAmbientWeiboMaterialBlock } from '../social-life-material.js';
import { stripLeakedCharacterCodes } from '../chat/character-code-fallback.js';
import { isExplicitCurrentUserComment } from '../social-comment-identity.js';
import {
  hasNegativeSocialRelationship,
  SOCIAL_RELATIONSHIP_TONE_RULES,
} from '../social-relationship-tone.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

export async function withMomentsPreparationTimeout(task, label = '整理上下文', timeoutMs = 30000) {
  let timer = 0;
  const waitMs = Math.max(1000, Number(timeoutMs) || 30000);
  try {
    return await Promise.race([
      Promise.resolve(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label}超时，请减少本轮角色数量后重试`);
          error.code = 'moments-context-timeout';
          error.stage = label;
          reject(error);
        }, waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把评论作者字段（id 或昵称）解析成可校验的 actor id */
function resolveMomentActorId(raw, names, allowedIds = []) {
  const key = clean(raw);
  if (!key) return '';
  const allow = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);
  if (allow.has(key) || names?.has?.(key)) return key;
  if (!names?.entries) return key;
  for (const [id, name] of names.entries()) {
    if (String(name || '').trim() === key && (!allow.size || allow.has(id))) return id;
  }
  for (const [id, name] of names.entries()) {
    if (String(name || '').trim() === key) return id;
  }
  return key;
}

/**
 * 自动补互动是一批同时到达的新留言，不能让本批评论互相引用并伪装成已经发生的来回。
 * 只有调用前真实存在于楼内的评论作者可以成为自动回复目标；手动补互动仍允许续写小对话。
 */
export function groundAutoMomentReplyTargets(comments = [], existingComments = [], {
  interactionMode = 'auto',
  names = new Map(),
} = {}) {
  const rows = Array.isArray(comments) ? comments : [];
  if (interactionMode === 'manual') return rows;
  const allowedTargets = new Set();
  for (const comment of (Array.isArray(existingComments) ? existingComments : [])) {
    const author = coerceMomentText(comment?.author || '', { max: 24 });
    const authorId = String(comment?.authorId || '').trim();
    const resolvedName = authorId ? coerceMomentText(names?.get?.(authorId) || '', { max: 24 }) : '';
    if (author) allowedTargets.add(author);
    if (authorId) allowedTargets.add(authorId);
    if (resolvedName) allowedTargets.add(resolvedName);
  }
  return rows.map((comment) => {
    const replyTo = coerceMomentText(comment?.replyTo || '', { max: 24 });
    if (!replyTo || allowedTargets.has(replyTo)) return comment;
    return { ...comment, replyTo: '' };
  });
}

const MOMENT_SOURCE_TYPES = new Set(['chat', 'memory', 'life', 'relationship', 'ambient', 'free_daily']);

function extractJsonBlock(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const objStart = body.indexOf('{');
  const arrStart = body.indexOf('[');
  let start = -1;
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) start = objStart;
  else if (arrStart >= 0) start = arrStart;
  if (start < 0) return '';
  const isArray = body[start] === '[';
  const end = isArray ? body.lastIndexOf(']') : body.lastIndexOf('}');
  if (end <= start) return '';
  return body.slice(start, end + 1).trim();
}

function parseJsonLoose(raw) {
  const text = String(raw || '').trim();
  const block = extractJsonBlock(text);
  if (!block) {
    const err = new Error('模型返回中未找到 JSON');
    err.reason = text ? 'json-parse-failed' : 'empty-api-response';
    err.rawText = text;
    throw err;
  }
  try {
    return JSON.parse(block);
  } catch (parseErr) {
    const err = new Error('模型未返回有效 JSON');
    err.reason = 'json-parse-failed';
    err.rawText = text;
    err.cause = parseErr;
    throw err;
  }
}

async function buildMomentsAiSystem(user, extra = '', { worldBookHint = '', characterIds = [] } = {}) {
  const platformCopy = getChatPlatformCopy();
  const timeBlock = user?.id ? await buildTimeAndHolidayPromptBlock(user.id) : '';
  const presetBlock = await buildSurfacePresetBlock('moments').catch(() => '');
  const wbBlock = await buildMomentsWorldBookBlock(user, worldBookHint, { characterIds });
  const chunks = [
    `你是棉花糖机里的${platformCopy.momentsPromptName}内容生成助手。只输出严格 JSON，不要 Markdown 解释，不要代码块。`,
    `禁止职业联赛、战队、赛季档等专业同人设定；内容应生活化、口语化，像真实${platformCopy.momentsPromptName}。`,
    MOMENTS_VOICE_RULES,
    MOMENTS_MEMORY_ISOLATION_RULES,
    SOCIAL_RELATIONSHIP_TONE_RULES,
    buildSocialFormatGuidancePrompt('moments'),
    presetBlock,
    wbBlock,
    timeBlock,
    extra,
  ].filter(Boolean);
  return chunks
    .map((chunk) => platformCopy.isQq
      ? String(chunk).replaceAll('朋友圈', 'QQ空间').replaceAll('发圈', '发动态')
      : chunk)
    .join('\n\n');
}

export function resolveGeneratedMomentAuthor(rawValue, allowedAuthorIds = [], names = new Map()) {
  const rawAuthor = String(rawValue || '').trim();
  if (!rawAuthor) return '';
  return allowedAuthorIds.find((id) => id === rawAuthor || names.get(id) === rawAuthor) || '';
}

export function resolveGroundedMomentChatShare(p, evidence = [], { required = false } = {}) {
  const rawIds = Array.isArray(p?.chatShareSourceLineIds)
    ? p.chatShareSourceLineIds
    : (Array.isArray(p?.chatShare?.sourceLineIds) ? p.chatShare.sourceLineIds : []);
  const requestedIds = [...new Set(rawIds.map((id) => clean(id)).filter(Boolean))].slice(0, 8);
  const evidenceMap = new Map(
    (Array.isArray(evidence) ? evidence : [])
      .map((row) => [clean(row?.sourceId), normalizeMomentChatShareLine(row?.text)])
      .filter(([id, text]) => id && text),
  );
  const groundedLines = requestedIds.map((id) => evidenceMap.get(id)).filter(Boolean);
  if (requestedIds.length) {
    // 只要模型声称引用真实消息，就必须所有编号都有效；不能夹带自写对白。
    if (groundedLines.length !== requestedIds.length) return null;
    return groundedLines;
  }
  if (required) return null;
  const rawLines = Array.isArray(p?.chatShareLines)
    ? p.chatShareLines
    : (Array.isArray(p?.chatShare?.lines) ? p.chatShare.lines : []);
  return rawLines.map((line) => normalizeMomentChatShareLine(line)).filter(Boolean).slice(0, 8);
}

function chatShareAppearsUserRelated(p, userName = '') {
  const lines = Array.isArray(p?.chatShareLines)
    ? p.chatShareLines
    : (Array.isArray(p?.chatShare?.lines) ? p.chatShare.lines : []);
  const blob = [
    p?.content,
    p?.chatShareTitle,
    p?.chatShare?.title,
    ...lines.map((line) => momentChatShareLineText(line) || coerceMomentChatLine(line)),
  ].map((value) => clean(value)).filter(Boolean).join('\n');
  if (/(?:id\s*=\s*user|用户[：:（(]|和用户|对用户)/i.test(blob)) return true;
  const label = clean(userName);
  return !!label && blob.includes(label);
}

function normalizeFeedItem(p, authorIds, reactionMap, names, avatars, charMap, options = {}) {
  const pool = new Set(authorIds);
  const rawAuthor = String(p?.author || p?.authorId || '').trim();
  const authorId = resolveGeneratedMomentAuthor(rawAuthor, authorIds, names);
  if (!authorId || !pool.has(authorId)) return null;
  const reactions = new Set(reactionMap.get(authorId) || []);
  const sourceTypeRaw = clean(p?.sourceType || p?.source_type).toLowerCase();
  const sourceType = MOMENT_SOURCE_TYPES.has(sourceTypeRaw) ? sourceTypeRaw : 'free_daily';
  const visibilityFields = normalizeMomentVisibility(p);
  const visibilityDraft = { ...visibilityFields };
  const canSee = (id) => canCharacterSeeMomentPost(visibilityDraft, id, charMap);

  let postKind = 'text';
  const rawKind = String(p?.postKind || p?.kind || 'text').toLowerCase();
  if (options?.allowChatShare !== false && (rawKind === 'chat_share' || rawKind === 'chatshare')) {
    postKind = 'chat_share';
  }

  let content = coerceMomentText(p?.content);
  const scenario = clean(options?.scenario);
  const requiresGroundedChat = postKind === 'chat_share' && (
    sourceType === 'chat'
    || scenario === 'user_related'
    || chatShareAppearsUserRelated(p, options?.userName)
  );
  const lines = postKind === 'chat_share'
    ? resolveGroundedMomentChatShare(p, options?.chatEvidence, { required: requiresGroundedChat })
    : [];
  if (postKind === 'chat_share' && lines === null) return null;
  if (postKind === 'chat_share' && !lines.length && !content) return null;
  if (postKind === 'text' && !content) return null;
  if (content.length > 280) content = content.slice(0, 280);

  const title = coerceMomentText(
    p?.chatShareTitle || p?.shareTitle || p?.chatShare?.title || '聊天记录',
    { max: 40 },
  ) || '聊天记录';
  const chatShare = postKind === 'chat_share'
    ? { title, lines: lines.length ? lines : [content || '（摘录）'] }
    : null;

  const likeIds = (Array.isArray(p?.likes) ? p.likes : [])
    .map((x) => String(x || '').trim())
    .filter((id) => reactions.has(id) && canSee(id))
    .slice(0, 6);
  const uniqLikes = [...new Set(likeIds)];

  const commentAllow = new Set([...reactions, authorId]);
  const comments = (Array.isArray(p?.comments) ? p.comments : [])
    .map((c) => {
      const aid = resolveMomentActorId(c?.authorId || c?.author, names, commentAllow);
      const normalizedComment = normalizeMomentComment(c);
      const replyToRaw = coerceMomentText(normalizedComment?.replyTo || '', { max: 24 });
      // 贴主可直接评论/回复；互动池成员须可见。原先要求贴主必须带 replyTo，漏字段会被整条丢掉。
      const isAuthorComment = !!aid && aid === authorId;
      if (!isAuthorComment && (!reactions.has(aid) || !canSee(aid))) return null;
      const text = sanitizeMomentCommentText(stripLeakedCharacterCodes(
        normalizedComment?.text || '',
        { nameMap: names, userName: options?.userName, fallbackLabel: '好友' },
      ));
      if (!text) return null;
      const translation = sanitizeAiTranslation(text, normalizedComment?.translation || '');
      // author 字段是给 UI 直接显示的，解不出昵称时绝不能落库成内部 id，
      // 落库成 "好友" 好过让用户在朋友圈里刷到一串 char_xxx。
      const replyToId = resolveMomentActorId(replyToRaw, names, commentAllow);
      const replyTo = names.get(replyToId)
        || names.get(replyToRaw)
        || stripLeakedCharacterCodes(replyToRaw, {
          nameMap: names,
          userName: options?.userName,
          fallbackLabel: '好友',
        });
      return {
        author: names.get(aid) || '好友',
        authorId: aid,
        text,
        replyTo,
        ...(translation ? { translation } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 7);

  const contentTranslation = sanitizeAiTranslation(content, p?.zh || p?.translation || '');
  const rawImagePrompt = clean(p?.imagePrompt || p?.image_prompt);
  const imagePrompt = normalizeSocialImagePrompt(rawImagePrompt);
  const imageCharacterId = clean(p?.imageCharacterId || p?.imageSubjectId)
    || (rawImagePrompt && !imagePrompt ? 'none' : '');

  return {
    authorId,
    authorName: names.get(authorId) || 'TA',
    avatar: String(avatars?.get(authorId) || '').trim(),
    content: postKind === 'chat_share' ? (content || '分享一则聊天') : content,
    postKind,
    chatShare,
    likes: uniqLikes.map((id) => names.get(id) || '好友'),
    likesIds: uniqLikes,
    comments,
    wantsImage: p?.wantsImage === true || !!imagePrompt,
    imageCharacterId,
    imagePrompt,
    textImageCaption: clean(p?.textImageCaption || p?.textImage || p?.text_image),
    ...visibilityFields,
    stickerNames: (Array.isArray(p?.stickerNames) ? p.stickerNames : [])
      .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3),
    metadata: {
      ...(typeof p?.metadata === 'object' ? p.metadata : {}),
      sourceType,
      ...(contentTranslation ? { contentTranslation } : {}),
      ...(clean(p?.visibilityNote) ? { visibilityNote: clean(p.visibilityNote).slice(0, 120) } : {}),
    },
  };
}

export async function aiGenerateMomentsFeedBatch({
  user,
  authorIds = [],
  reactionIds = [],
  count = 3,
  commentCount = null,
  commentLevel = 'high',
  onProgress,
  imageOptions = null,
  mix = null,
  intentSeed = '',
  sourceRecentMessages = [],
  sourceChatId = '',
} = {}) {
  if (!user?.id || !authorIds.length) return [];
  const platformCopy = getChatPlatformCopy();
  const { avatarMap, characterIds: slotCharacterIds } = await buildMomentsActors(user);
  const circleCtx = await buildMomentsSocialCircleContext(user.id);
  const scopedCharacterIds = new Set(circleCtx.charMap.keys());
  authorIds = [...new Set(authorIds
    .map((id) => String(id || '').trim())
    .filter((id) => scopedCharacterIds.has(id)))];
  reactionIds = [...new Set((reactionIds || [])
    .map((id) => String(id || '').trim())
    .filter((id) => scopedCharacterIds.has(id)))];
  if (!authorIds.length) return [];
  const explicitIntent = clean(intentSeed).slice(0, 300);
  const explicitChatShare = socialIntentExplicitlyRequestsChatTranscript(explicitIntent);
  const pickCount = explicitIntent
    ? 1
    : Math.min(Math.max(1, Number(count) || 3), authorIds.length, 5);
  const requestedCommentCount = commentCount == null
    ? sampleMomentsReactionCommentCount(commentLevel)
    : Math.min(8, Math.max(0, Math.round(Number(commentCount) || 0)));
  const allowedReactionIds = new Set((reactionIds || []).filter(Boolean));
  const defaultReactionIds = new Set([
    ...slotCharacterIds,
    ...authorIds,
  ]);
  const allCharacterIds = allowedReactionIds.size
    ? [...circleCtx.charMap.keys()].filter((id) => allowedReactionIds.has(id))
    : [...circleCtx.charMap.keys()].filter((id) => defaultReactionIds.has(id));
  const userName = getUserDisplayName(user);

  // 场景抽签：作者与「这条发什么戏」由 JS 加权决定，模型只负责按人设演
  const prefs = await loadMomentsPrefs(user.id).catch(() => null);
  const effectiveMix = mix || prefs?.genMix || undefined;
  const scenarioHistory = await loadScenarioHistory(user.id).catch(() => []);
  const poolNames = await buildActorNameMap([...new Set(authorIds)], user.id);
  const plan = explicitIntent
    ? {
      authors: authorIds.slice(0, 1),
      assignments: [],
      historyPatch: { types: [], pairs: [] },
    }
    : planMomentsScenarioBatch({
      candidateIds: authorIds,
      pickCount,
      charMap: circleCtx.charMap,
      relationshipNet: circleCtx.relationshipNet,
      names: poolNames,
      userName,
      mix: effectiveMix,
      history: scenarioHistory,
    });
  const authors = plan.authors.length ? plan.authors : authorIds.slice(0, pickCount);
  const reactionData = await buildMomentsReactionMapWithPhone(
    user.id,
    authors,
    allCharacterIds,
    circleCtx,
  );
  const reactionMap = limitMomentsReactionMap(reactionData.reactionMap, authors);
  const reactionIdsFlat = [...new Set([...reactionMap.values()].flat())];
  const lightActors = reactionData.lightActors.filter((actor) => reactionIdsFlat.includes(actor.id));
  const names = await buildActorNameMap(
    [...new Set([...authorIds, ...authors, ...reactionIdsFlat])]
      .filter((id) => !isPhoneLightContactId(id)),
    user.id,
  );
  applyPhoneLightActorsToNameMap(names, lightActors);

  onProgress?.('正在整理人物设定与记忆…');
  const contextActorIds = [...new Set([...authors, ...reactionIdsFlat])];
  const rosterActorIds = contextActorIds.filter((id) => !isPhoneLightContactId(id));
  const charactersMap = mergePhoneLightActorsIntoCharacterMap(
    await withMomentsPreparationTimeout(
      loadCharactersMap(rosterActorIds, user.id),
      '读取人物设定',
    ),
    lightActors,
  );
  const characterCards = buildMomentsCharacterCardsBlock(charactersMap, contextActorIds);
  const phoneContactsBlock = formatPhoneLightContactsPromptBlock(lightActors);
  const translationPrompt = buildJsonFieldTranslationPromptBlock(
    collectMomentsTranslationActors(charactersMap, contextActorIds),
    { fields: 'content / comments[].text / chatShareLines[].text', exampleField: 'content' },
  );
  const userProfileBlock = buildMomentsUserProfileBlock(user);
  const relationshipBlock = await buildMomentsRelationshipBlock({
    userId: user.id,
    charMap: circleCtx.charMap,
    actorIds: rosterActorIds,
    userName,
  }).catch(() => '');
  const scenarioBlock = formatScenarioDirectiveBlock(plan, poolNames);
  onProgress?.('正在读取近期聊天…');
  const {
    block: chatLogs,
    evidenceByAuthor: chatEvidenceByAuthor,
    dialoguePresentationAuthorIds,
  } = await withMomentsPreparationTimeout(
    collectPerAuthorChatEvidenceBlocks(user.id, authors, {
      messagesPerChat: 20,
      userName,
    }),
    '读取近期聊天',
  );
  onProgress?.('正在读取角色记忆…');
  const memoryHint = await withMomentsPreparationTimeout(
    buildMomentsMemoryBlockPerCharacter(user.id, rosterActorIds, {
      memoryLimit: 10,
      factLimit: 8,
    }),
    '读取角色记忆',
    45000,
  );
  // 零散生活素材：发圈作者们的日程主题/旅行归来/真实刷到过的内容（角色筛过、带时效标注），
  // 以及 48 小时内的站内微博公共话题——让朋友圈长在角色真实过的日子上，而不是每次凭空编生活。
  const lifeMaterialBlock = await buildLifeMaterialBlock(
    user.id,
    authors.map((id) => ({ id, name: names.get(id) })),
    { now: await getNowForUser(user.id).catch(() => Date.now()) },
  ).catch(() => '');
  const ambientWeiboBlock = await buildAmbientWeiboMaterialBlock(user.id).catch(() => '');
  const sourceGroundingBlock = buildMomentsSourceGroundingBlock({
    count: pickCount,
    hasChatLogs: !!chatLogs && (!explicitIntent || explicitChatShare),
    hasMemory: !!memoryHint,
    hasLifeMaterial: !!lifeMaterialBlock,
    hasAmbientMaterial: !!ambientWeiboBlock,
    userName,
    intentDriven: !!explicitIntent,
    chatShareRequested: explicitChatShare,
  });
  const recent = (await listMomentPostsForUser(user.id)).slice(0, 10);
  const recentDigest = recent.length
    ? recent.map((p) => `- ${p.authorName}：${String(p.content || '').slice(0, 60)}`).join('\n')
    : '暂无';
  const timeFreshness = await buildMomentsTimeFreshnessBlock(user.id, recent);
  const timeSituation = await buildMomentsTimeSituationBlock(user.id);
  const actorLocalTime = await buildMomentsActorLocalTimeBlock(user.id, authors, charactersMap);
  const reactionPoolBlock = formatMomentsReactionPoolBlock(authors, names, reactionMap);
  const groupsConfig = await loadContactGroupsConfig().catch(() => ({ groups: [] }));
  const groupLabels = (groupsConfig.groups || []).map((g) => `${g.id}:${g.name}`);
  const visibilityBlock = buildMomentsVisibilityPromptBlock(groupLabels, authors);

  const authorPool = authors.map((id) => `${id}:${names.get(id)}`).join('；');
  const intentRecent = (Array.isArray(sourceRecentMessages) ? sourceRecentMessages : [])
    .slice(-4)
    .map((message) => {
      const speaker = String(message?.senderId || '') === user.id || String(message?.senderId || '') === 'user'
        ? userName
        : (names.get(String(message?.senderId || '')) || String(message?.senderName || '角色').trim() || '角色');
      const body = clean(message?.content).slice(0, 180);
      return body ? `${speaker}：${body}` : '';
    })
    .filter(Boolean)
    .join('\n');
  const explicitIntentBlock = explicitIntent
    ? [
      '[本轮角色主动发圈 · 最高优先级]',
      `发圈作者固定为 ${authors[0] || authorIds[0]}，只生成 1 条；角色想发的核心：${explicitIntent}`,
      sourceChatId ? `来源私聊：${String(sourceChatId).slice(0, 180)}（只用于事实追溯，不写入正文）` : '',
      intentRecent ? `本轮来源私聊近期片段（只解释发帖动机，不默认成为正文主题）：\n${intentRecent}` : '',
      '当前私聊是“为什么此刻想发”的触发背景，不是默认要公开的内容；围绕 brief 提炼角色自己的公开表达，不要总结刚才聊了什么。',
      explicitChatShare
        ? 'brief 明确要求公开聊天记录：允许使用 postKind=chat_share，但只能引用提供的真实消息编号，不得补写或改写对白。'
        : 'brief 没有明确要求公开聊天记录：postKind 必须为 text，chatShareSourceLineIds=[]，chatShareLines=[]；正文优先写角色自己的近况、念头、兴趣或公共观察，可以含蓄带出情绪，但不得复述、概括或截图式呈现与用户的对话。',
    ].filter(Boolean).join('\n')
    : '';
  const dialoguePresentationBlock = dialoguePresentationAuthorIds.size
    ? [
      '[对话表现素材 · 媒介边界 · 硬性]',
      `以下作者的聊天素材包含“对话表现模式”会话：${[...dialoguePresentationAuthorIds].join('、')}。气泡只是台词排版，不携带“现场”或“手机”结论。`,
      '先读素材判断双方位置：明确已经见面、同处一地、一起做事，才可写「当面/刚才在旁边说」；明确双方分开、正在网聊或真实使用手机，才可写「手机上/隔着屏幕/发消息」。若素材没有给出位置与媒介证据，朋友圈必须保持中性，只写「刚才说过/聊到/某人嘴硬」，既不要补「当面」，也不要补「手机上说、别拿着手机、手机那头」等手机动作。UI 里的气泡绝不能单独作为剧情证据。',
    ].join('\n')
    : '';

  onProgress?.(`正在生成${platformCopy.momentsPromptName}…`);
  const imageGenMode = await resolveSocialImageGenMode('momentsImages');
  const normalizedImageOptions = {
    allowLifePhoto: imageOptions?.allowLifePhoto !== false,
    allowPersonPhoto: !!imageOptions?.allowPersonPhoto,
    allowTextImage: imageOptions?.allowTextImage !== false,
    allowStickers: imageOptions?.allowStickers !== false,
    stickerPackIds: Array.isArray(imageOptions?.stickerPackIds)
      ? [...new Set(imageOptions.stickerPackIds.map((id) => String(id || '').trim()).filter(Boolean))]
      : null,
    imageStyleId: String(imageOptions?.imageStyleId || '').trim(),
  };
  const stickerPool = normalizedImageOptions.allowStickers
    ? await loadFlatStickerPool(normalizedImageOptions.stickerPackIds).catch(() => [])
    : [];
  const stickerBlock = normalizedImageOptions.allowStickers
    ? buildMomentsStickerPromptBlock(stickerPool)
    : '';
  const imageRules = buildSocialImageGenPromptRules(imageGenMode, {
    imageOptions: normalizedImageOptions,
    allowStickers: normalizedImageOptions.allowStickers,
    surface: 'moments',
  });
  const wantsImageHint = '多数 wantsImage:false；约两三成 wantsImage:true（可纯文字、文字图或生图，按配图规则）';
  const genMaxTokens = await resolveGenerationMaxTokens();
  const worldBookHint = [authorPool, recentDigest, characterCards].filter(Boolean).join('\n');
  const system = await buildMomentsAiSystem(user, [
    `[任务] 一次生成多条独立${platformCopy.momentsPromptName}（非对话剧本）。`,
    explicitIntentBlock,
    scenarioBlock,
    MOMENTS_CONTENT_RULES,
    MOMENTS_COMMENT_STYLE_RULES,
    MOMENTS_CHAT_CONTINUITY_RULES,
    sourceGroundingBlock,
    timeFreshness,
    timeSituation,
    actorLocalTime,
    dialoguePresentationBlock,
    scenarioBlock
      ? `本批共 ${pickCount} 条，作者与顺序严格按上方场景指令执行，作者互不重复。作者名单：${authorPool}`
      : `发圈作者须从下列 id 中选，${pickCount} 条作者互不重复：${authorPool}`,
    reactionPoolBlock,
    phoneContactsBlock || '',
    visibilityBlock,
    stickerBlock,
    '禁止替用户发圈（author 不得等于用户 id）。',
    '每条动态的 content 必须贴合该条 author 的人物设定；每条评论必须贴合该条 comment.author 的人物设定。',
    `每条动态的 comments 必须恰好生成 ${requestedCommentCount} 条；没有合适互动时也要保持人物口吻自然，不要用重复句凑数。`,
    'comments.author 通常从该条互动圈 id 中选；发圈者本人 id 也允许出现在 comments 中，但只能用于回复楼里别人，必须填写 replyTo。贴主在同一条动态里最多挑 0～2 条值得接的话回复，禁止逐条全回、禁止每条外部评论后机械跟一条贴主回复。',
    translationPrompt || '',
    imageRules,
    userProfileBlock,
    relationshipBlock || '',
    characterCards || '',
    (!explicitIntent || explicitChatShare) && chatLogs
      ? `[该作者专属聊天事实 · 高优先级素材 · 每行均为「发言者 → 对象：台词」]\n${chatLogs}`
      : '',
    memoryHint || '',
    lifeMaterialBlock,
    ambientWeiboBlock,
    `近期已有动态（避免重复话题，勿把旧帖当刚发生）：\n${recentDigest}`,
    'postKind=chat_share 只用于明确“晒聊天”的内容；sourceType=chat 或 user_related 只表示灵感/关系来源，普通 text 不需要聊天编号。晒真实聊天时禁止自行重写 chatShareLines：只能把上方真实消息编号填入 chatShareSourceLineIds，程序会按编号回填原文；没有合适编号就改成普通 text。普通批量生成中只有 chat_expose 场景可主动选择 chat_share。只有完全不涉及用户的虚构角色间聊天才可直接填写 chatShareLines。',
    'chatShareLines 每项优先写「称呼：对白」字符串；若该行是外语人设发言，可写 {"text":"称呼：对白","zh":"中文译文"}。禁止输出 speaker/from 对象字段。',
    '有 imagePrompt 时填写 imageCharacterId：配图主体是角色池成员就写图中角色 id（不一定等于发帖作者）；无人、物件、风景或非角色人物写 none。',
    `JSON schema: {"posts":[{"author":"角色id","sourceType":"chat|memory|life|relationship|ambient|free_daily","postKind":"text|chat_share","content":"正文","zh":"外语/方言正文才需要的中文翻译","visibility":"all|groups","visibleGroupIds":["group_default"],"hiddenFromIds":["角色id"],"visibilityNote":"可选","stickerNames":["表情包名"],"wantsImage":false,"imageCharacterId":"图中角色id；无人/物件/风景/非角色人物写none","imagePrompt":"具体英文画面描述；无生图则留空，绝不能写none","textImageCaption":"","chatShareTitle":"","chatShareSourceLineIds":["真实消息编号"],"chatShareLines":["仅限完全不涉及用户的虚构角色间聊天",{"text":"称呼：外语对白","zh":"称呼：中文译文"}],"likes":["id"],"comments":[{"author":"互动角色id；贴主回复时写本条发圈者id","text":"评论或贴主回复，禁止在正文里写 @user 或任何人的内部 id，要提到谁就直接写TA的称呼","zh":"外语评论才需要","replyTo":"回复对象的称呼（不是 id）；贴主回复必须填写"}]}]}（${wantsImageHint}）`,
  ].filter(Boolean).join('\n\n'), { worldBookHint, characterIds: rosterActorIds });

  const generated = await chatJsonGeneration({
    scope: 'moments-posts',
    retryOnInvalid: false,
    messages: [
    { role: 'system', content: system },
    { role: 'user', content: `请生成 ${pickCount} 条${platformCopy.momentsPromptName} JSON。` },
    ],
    // 朋友圈会重述聊天与记忆事实；弱模型在高温下更容易翻转称呼施受关系。
    temperature: 0.75,
    maxTokens: genMaxTokens,
    parse: parseJsonLoose,
    validate: (value) => (
      (Array.isArray(value?.posts) && value.posts.length > 0)
      || (Array.isArray(value) && value.length > 0)
    ),
  });
  const parsed = generated.data;
  const rows = Array.isArray(parsed?.posts) ? parsed.posts : (Array.isArray(parsed) ? parsed : []);
  const scenarioByAuthor = new Map((plan.assignments || []).map((a) => [a.authorId, a.type]));
  const out = [];
  const used = new Set();
  for (const row of rows) {
    // 场景计划决定优先作者与顺序；用户手选范围才是身份合法性的边界。
    const rawAuthor = String(row?.author || row?.authorId || '').trim();
    const resolvedAuthor = resolveGeneratedMomentAuthor(rawAuthor, authorIds, names);
    const scenario = scenarioByAuthor.get(resolvedAuthor) || '';
    const item = normalizeFeedItem(
      row,
      authorIds,
      reactionMap,
      names,
      avatarMap,
      circleCtx.charMap,
      {
        scenario,
        userName,
        chatEvidence: chatEvidenceByAuthor.get(resolvedAuthor) || [],
        allowChatShare: !explicitIntent || explicitChatShare,
      },
    );
    if (!item || used.has(item.authorId)) continue;
    used.add(item.authorId);
    if (scenario) item.metadata = { ...(item.metadata || {}), scenario };
    out.push(item);
    if (out.length >= pickCount) break;
  }
  if (!out.length) {
    const error = new Error(`模型返回了 ${rows.length} 条数据，但没有可用的${platformCopy.momentsPromptName}`);
    error.reason = 'validation-failed';
    error.rawText = generated.raw;
    error.rejected = [{
      reason: `${platformCopy.momentsName}作者不在用户选择范围内，或动态正文缺少必需字段`,
      returnedCount: rows.length,
      acceptedCount: 0,
    }];
    throw error;
  }
  // 隔空呼应等场景依赖「谁先发」，按抽签时定的作者顺序落库
  const orderedAuthors = [...authors, ...authorIds.filter((id) => !authors.includes(id))];
  const orderOf = new Map(orderedAuthors.map((id, i) => [id, i]));
  out.sort((a, b) => (orderOf.get(a.authorId) ?? 99) - (orderOf.get(b.authorId) ?? 99));
  recordScenarioHistory(user.id, plan.historyPatch).catch(() => {});
  onProgress?.('正在生成配图…');
  const processed = out.map((item) => {
    const limited = {
      ...item,
      comments: (Array.isArray(item.comments) ? item.comments : []).slice(0, requestedCommentCount),
    };
    if (!normalizedImageOptions.allowLifePhoto) {
      return { ...limited, imagePrompt: '' };
    }
    if (!normalizedImageOptions.allowPersonPhoto && limited.imagePrompt
      && /\b(selfie|portrait|face|1girl|1boy)\b/i.test(limited.imagePrompt)) {
      return { ...limited, imagePrompt: '' };
    }
    return limited;
  });
  const maxImages = (normalizedImageOptions.allowLifePhoto || normalizedImageOptions.allowTextImage)
    ? Math.min(pickCount, 3)
    : 0;
  const withImages = await applySocialPostImages(processed, {
    scene: 'momentsImages',
    imageField: 'images',
    maxImages,
    imageOptions: normalizedImageOptions,
  });
  if (!normalizedImageOptions.allowStickers || !stickerPool.length) return withImages;
  return withImages.map((item) => applyMomentPostStickers(item, stickerPool));
}

export async function aiFillMomentReactions({
  user,
  post,
  actorIds = [],
  interactionMode = 'auto',
  phoneOwnerId = '',
  extraLightActors = [],
  commentCount = null,
  commentLevel = 'high',
} = {}) {
  if (!user?.id || !post) {
    const err = new Error('缺少动态');
    err.code = 'moments-fill-invalid';
    throw err;
  }
  const requestedCommentCount = commentCount == null
    ? sampleMomentsReactionCommentCount(commentLevel)
    : Math.min(8, Math.max(0, Math.round(Number(commentCount) || 0)));
  const platformCopy = getChatPlatformCopy();
  const postAuthorId = String(post.authorId || '').trim();
  const circleCtx = await buildMomentsSocialCircleContext(user.id);
  const rosterIds = (actorIds || []).length
    ? actorIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [...circleCtx.charMap.keys()];

  const ownerForPhone = String(
    phoneOwnerId
    || post.phoneOwnerId
    || post.metadata?.phoneOwnerId
    || '',
  ).trim();
  const phoneLookupId = ownerForPhone
    || (!isPhoneLightContactId(postAuthorId) ? postAuthorId : '');

  let lightActors = [];
  let candidateIds = [];
  if (postAuthorId && postAuthorId !== user.id) {
    if (phoneLookupId) {
      const resolved = await resolveMomentsReactionCandidates(
        user.id,
        phoneLookupId,
        rosterIds,
        circleCtx,
      );
      if (postAuthorId === phoneLookupId) {
        candidateIds = resolved.candidateIds;
        lightActors = resolved.lightActors;
      } else {
        // 轻量联系人发的帖：手机主人 + 通讯录其他人可互动
        const ownerCanReact = circleCtx.charMap.has(phoneLookupId) ? [phoneLookupId] : [];
        candidateIds = [...new Set([
          ...ownerCanReact,
          ...resolved.candidateIds.filter((id) => id !== postAuthorId),
          ...resolved.lightActors.map((a) => a.id).filter((id) => id !== postAuthorId),
        ])];
        lightActors = resolved.lightActors.filter((a) => a.id !== postAuthorId);
      }
    } else {
      candidateIds = rosterIds.filter((id) => id && id !== user.id && id !== postAuthorId);
    }
  } else {
    candidateIds = rosterIds.filter((id) => id && id !== user.id && id !== postAuthorId);
  }

  for (const actor of extraLightActors || []) {
    const id = String(actor?.id || '').trim();
    if (!id || id === postAuthorId || id === user.id) continue;
    if (!candidateIds.includes(id)) candidateIds.push(id);
    if (!lightActors.some((item) => item.id === id)) {
      lightActors.push({
        id,
        name: String(actor.name || '联系人').trim() || '联系人',
        avatar: String(actor.avatar || '').trim(),
        category: String(actor.category || 'other').trim() || 'other',
        note: String(actor.note || '').trim(),
        persona: actor.personaCapsule || actor.persona || {},
        translationProfile: actor.translationProfile || {},
        kind: 'phone-contact',
        ownerId: phoneLookupId || ownerForPhone || '',
      });
    }
  }

  const scopedActorIds = filterMomentViewerIds(post, candidateIds, circleCtx.charMap);
  if (!scopedActorIds.length) {
    const err = new Error(MOMENTS_NO_REACTION_CANDIDATES_MESSAGE);
    err.code = 'moments-no-reaction-candidates';
    throw err;
  }

  const rosterScopedIds = scopedActorIds.filter((id) => !isPhoneLightContactId(id));
  const names = await buildActorNameMap([
    ...rosterScopedIds,
    ...(postAuthorId && !isPhoneLightContactId(postAuthorId) ? [postAuthorId] : []),
  ], user.id);
  applyPhoneLightActorsToNameMap(names, lightActors);
  const actorLines = scopedActorIds.map((id) => `${id}:${names.get(id)}`).join('；');
  const existingComments = Array.isArray(post.comments) ? post.comments : [];
  const history = existingComments
    .map((c) => {
      const normalized = normalizeMomentComment(c);
      if (!normalized) return '';
      return `${c.author || c.authorId}${normalized.replyTo ? ` 回复 ${normalized.replyTo}` : ''}：${normalized.text}`;
    })
    .filter(Boolean)
    .join('\n');
  const existingCommenterIds = new Set(
    existingComments.map((c) => String(c?.authorId || '').trim()).filter(Boolean),
  );
  const freshActorIds = scopedActorIds.filter((id) => !existingCommenterIds.has(id));
  const userDisplayName = getUserDisplayName(user);
  const hasUserComment = existingComments.some((c) => isExplicitCurrentUserComment(c, user));
  const replyUserBlock = hasUserComment && requestedCommentCount > 0
    ? [
      '[回复用户 · 硬性]',
      `用户「${userDisplayName}」已经在楼里评论：本次新增 comments 中至少一条必须 replyTo 填「${userDisplayName}」，内容要接住用户原话，禁止无视用户发言。`,
    ].join('\n')
    : '';
  const manualInteractionBlock = interactionMode === 'manual' && requestedCommentCount > 0
    ? [
      '[手动补互动 · 硬性]',
      '这是用户主动点「AI 补互动」续写评论区，不要复述、替换或改写已有楼层，只在后面增加新互动。',
      freshActorIds.length
        ? `必须至少引入一位尚未在本楼出现的新角色或手机联系人，新人候选 id：${freshActorIds.join('、')}。`
        : '候选角色都已出现过，可以不强塞新人。',
      hasUserComment
        ? '（回复用户要求见上方硬性条款；也可另加角色间互相接话。）'
        : '至少生成一条带 replyTo 的角色间回复；可以由已有角色互相接话，也可以让另一位角色回复本次新加入者。',
      '优先形成一小段有来有回的楼层关系，而不是再铺一排互不相干的一次性留言。',
    ].join('\n')
    : (interactionMode === 'manual'
      ? '[手动补互动 · 本轮抽签] 本轮评论数为 0，只补 1～5 个点赞；comments 必须返回空数组。'
      : '');
  const automaticInteractionBlock = interactionMode !== 'manual' && requestedCommentCount > 0
    ? [
      '[自动补互动 · 时序硬规则]',
      '本次 comments 是同一批同时新增的留言，不是已经发生过的对话剧本。',
      existingComments.length
        ? 'replyTo 只能填写「已有评论」中真实出现过的作者称呼；禁止回复本批新生成的另一条 comments。'
        : '当前没有已有评论，本次所有 comments 都必须是独立首层留言，replyTo 必须留空。',
      '禁止一次生成“角色先评论—另一个角色马上回复—前者再接话”的完整来回；后续真实补互动再决定是否接话。',
    ].join('\n')
    : (interactionMode !== 'manual'
      ? '[自动补互动 · 本轮抽签] 本轮评论数为 0，只补 1～5 个点赞；comments 必须返回空数组。'
      : '');

  const contextActorIds = [...new Set([
    ...scopedActorIds,
    ...(postAuthorId && postAuthorId !== user.id ? [postAuthorId] : []),
  ])];
  const rosterContextIds = contextActorIds.filter((id) => !isPhoneLightContactId(id));
  const charactersMap = mergePhoneLightActorsIntoCharacterMap(
    await loadCharactersMap(rosterContextIds, user.id),
    lightActors,
  );
  const characterCards = buildMomentsCharacterCardsBlock(charactersMap, contextActorIds);
  const translationPrompt = buildJsonFieldTranslationPromptBlock(
    collectMomentsTranslationActors(charactersMap, contextActorIds),
    { fields: 'comments[].text', exampleField: 'text' },
  );
  const phoneContactsBlock = formatPhoneLightContactsPromptBlock(
    lightActors.filter((actor) => scopedActorIds.includes(actor.id)),
    post.authorName || names.get(postAuthorId) || '',
  );
  const userProfileBlock = buildMomentsUserProfileBlock(user);
  const relationshipBlock = await buildMomentsRelationshipBlock({
    userId: user.id,
    charMap: circleCtx.charMap,
    actorIds: rosterContextIds,
    userName: getUserDisplayName(user),
  }).catch(() => '');
  const memoryHint = await withMomentsPreparationTimeout(
    buildMomentsMemoryBlockPerCharacter(user.id, rosterContextIds, {
      memoryLimit: 8,
      factLimit: 6,
    }),
    '读取评论角色记忆',
    45000,
  );
  const chatLogs = postAuthorId && !isPhoneLightContactId(postAuthorId)
    ? await collectPerAuthorChatLogBlocks(user.id, [postAuthorId], {
      messagesPerChat: 20,
      userName: getUserDisplayName(user),
    })
    : '';
  // 评论者也要带上各自与用户的近期聊天：否则评论像失忆路人，接不住刚聊过的事
  const commenterLogIds = rosterScopedIds
    .filter((id) => id !== postAuthorId)
    .slice(0, 4);
  const commenterLogs = commenterLogIds.length
    ? await collectPerAuthorChatLogBlocks(user.id, commenterLogIds, {
      messagesPerChat: 12,
      userName: getUserDisplayName(user),
    }).catch(() => '')
    : '';
  const reactionPoolBlock = postAuthorId && postAuthorId !== user.id
    ? formatMomentsReactionPoolBlock([postAuthorId], names, new Map([[postAuthorId, scopedActorIds]]))
    : '';

  const system = await buildMomentsAiSystem(user, [
    `[任务] 为单条${platformCopy.momentsPromptName}补点赞与评论，只输出 JSON。`,
    MOMENTS_MEMORY_ISOLATION_RULES,
    MOMENTS_CHAT_CONTINUITY_RULES,
    MOMENTS_COMMENT_STYLE_RULES,
    `发圈人 id=${postAuthorId || '未知'}，姓名：${post.authorName || '好友'}。评论者不得模仿发圈人口吻，须各自保持本人设定。`,
    reactionPoolBlock || `候选点赞/评论 author：${actorLines}`,
    phoneContactsBlock || '',
    `likes 只能使用互动候选 id；comments 除互动候选外，还允许发圈人 id=${postAuthorId || '未知'} 作为贴主回复，但贴主回复必须填写 replyTo。`,
    '禁止替用户点赞/评论（不得使用 user、当前用户 id 或用户姓名）；用户身份只允许作为 replyTo 的被回复对象，绝不能出现在 likes 或 comments.authorId。',
    '每条评论 text 必须是对应 author 角色本人会说的话，禁止串人设、禁止用户口吻。',
    translationPrompt || '',
    replyUserBlock,
    manualInteractionBlock,
    automaticInteractionBlock,
    userProfileBlock,
    relationshipBlock || '',
    characterCards || '',
    memoryHint || '',
    chatLogs
      ? `[高优先级 · 发圈人专属近期聊天事实 · 禁止混用]\n${chatLogs}`
      : '',
    commenterLogs
      ? `[高优先级 · 评论者各自的近期聊天事实 · 分角色使用，禁止串给他人]\n评论必须承接各自与用户刚聊过的决定、计划和当前状态；可以不公开私聊细节，但不得失忆或改口成互斥事实。\n${commenterLogs}`
      : '',
    'JSON: {"likes":["互动候选id"],"comments":[{"authorId":"互动候选id；贴主回复时写发圈人id","text":"评论或贴主回复，禁止在正文里写 @user 或任何人的内部 id","zh":"外语评论才需要的完整中文翻译","replyTo":"回复对象称呼；贴主回复必须填写"}]}',
  ].filter(Boolean).join('\n\n'), {
    worldBookHint: `${post.authorName}\n${post.content || ''}`,
    characterIds: rosterContextIds,
  });

  const shareExtra = post.postKind === 'chat_share' && post.chatShare?.lines
    ? `\n晒聊天：\n${post.chatShare.lines.slice(0, 5).map((line) => momentChatShareLineText(line) || coerceMomentChatLine(line)).filter(Boolean).join('\n')}`
    : '';

  const imageUrls = (Array.isArray(post.images) ? post.images : []).filter(Boolean);
  const imageHint = imageUrls.length ? `\n配图：共 ${imageUrls.length} 张` : '';
  const bodyText = String(post.content || '').trim();
  const bodyLine = bodyText
    ? `正文：${bodyText.slice(0, 280)}`
    : (imageUrls.length ? '正文：（无文字，以配图为主）' : '正文：（空）');

  const userTextLines = [
    `发圈人：${post.authorName}`,
    `${bodyLine}${shareExtra}${imageHint}`,
    history ? `已有评论：\n${history}` : '已有评论：无',
    interactionMode === 'manual'
      ? `本轮随机结果：续写恰好 ${requestedCommentCount} 条楼层消息与 1～5 个点赞，严格满足「手动补互动」要求。${hasUserComment && requestedCommentCount > 0 ? `必须含至少一条 replyTo「${userDisplayName}」。` : ''}`
      : `本轮随机结果：生成恰好 ${requestedCommentCount} 条楼层消息与 1～5 个点赞；贴主要不要回复按TA的性格与楼内内容判断，不要求每次都回。${hasUserComment && requestedCommentCount > 0 ? `楼内已有用户评论：必须含至少一条 replyTo「${userDisplayName}」。` : ''}`,
  ];

  let userContent = userTextLines.join('\n');
  if (imageUrls.length) {
    const visionParts = await buildImageUrlVisionParts(imageUrls, {
      max: 3,
      prefix: '朋友圈配图',
    });
    if (visionParts.length) {
      userContent = [
        { type: 'text', text: userTextLines.join('\n') },
        ...visionParts,
      ];
    }
  }

  const commentAllow = new Set([...scopedActorIds, postAuthorId]);
  const reactionMaxTokens = await resolveGenerationMaxTokens();
  const { data: parsed } = await chatJsonGeneration({
    scope: 'moments-reactions',
    retryOnInvalid: false,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: userContent,
      },
    ],
    temperature: 0.85,
    maxTokens: reactionMaxTokens,
    parse: parseJsonLoose,
    validate: (value) => value && typeof value === 'object',
  });
  const likeIds = (Array.isArray(parsed?.likes) ? parsed.likes : [])
    .map((x) => String(x || '').trim())
    .filter((id) => scopedActorIds.includes(id))
    .filter((id) => !hasNegativeSocialRelationship(
      charactersMap.get(id),
      charactersMap.get(postAuthorId),
    ))
    .slice(0, 5);
  const uniqLikes = [...new Set(likeIds)];
  const comments = (Array.isArray(parsed?.comments) ? parsed.comments : [])
    .map((c) => {
      const aid = resolveMomentActorId(c?.authorId || c?.author, names, commentAllow);
      const normalizedComment = normalizeMomentComment(c);
      const replyToRaw = coerceMomentText(normalizedComment?.replyTo || '', { max: 24 });
      const isAuthorComment = !!aid && postAuthorId !== user.id && aid === postAuthorId;
      if (!isAuthorComment && !scopedActorIds.includes(aid)) return null;
      const text = sanitizeMomentCommentText(stripLeakedCharacterCodes(
        normalizedComment?.text || '',
        { nameMap: names, userName: userDisplayName, fallbackLabel: '好友' },
      ));
      if (!text) return null;
      const translation = sanitizeAiTranslation(text, normalizedComment?.translation || '');
      const replyToId = resolveMomentActorId(replyToRaw, names, commentAllow);
      const replyTo = names.get(replyToId)
        || names.get(replyToRaw)
        || stripLeakedCharacterCodes(replyToRaw, {
          nameMap: names,
          userName: userDisplayName,
          fallbackLabel: '好友',
        });
      return {
        author: names.get(aid) || '好友',
        authorId: aid,
        text,
        replyTo,
        ...(translation ? { translation } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, requestedCommentCount);
  const groundedComments = groundAutoMomentReplyTargets(comments, existingComments, {
    interactionMode,
    names,
  });

  return {
    likes: uniqLikes.map((id) => names.get(id) || '好友'),
    likesIds: uniqLikes,
    comments: [...existingComments, ...groundedComments],
  };
}

export function shouldBackfillMoment(post) {
  const likes = Array.isArray(post?.likes) ? post.likes.length : 0;
  const comments = Array.isArray(post?.comments) ? post.comments : [];
  const authorId = String(post?.authorId || '').trim();
  const ownerId = String(post?.userId || '').trim();
  const isUserPost = authorId && authorId === ownerId;
  const hasAuthorReply = !!authorId && comments.some((c) => (
    String(c?.authorId || '').trim() === authorId && String(c?.replyTo || '').trim()
  ));
  // 用户已评论但无人 replyTo 用户时，优先进入补互动。
  if (ownerId) {
    const userComments = comments.filter((c) => String(c?.authorId || '').trim() === ownerId);
    if (userComments.length) {
      const userNames = new Set(userComments.map((c) => String(c.author || '').trim()).filter(Boolean));
      const repliedToUser = comments.some((c) => {
        if (String(c?.authorId || '').trim() === ownerId) return false;
        return userNames.has(String(c?.replyTo || '').trim());
      });
      if (!repliedToUser) return true;
    }
  }
  // 旧动态即使已有几条外部评论，只要贴主一直没回，也应进入补互动候选。
  if (!isUserPost && comments.length >= 2 && !hasAuthorReply) return true;
  return likes + comments.length < 2;
}
