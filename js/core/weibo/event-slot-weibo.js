/**
 * 线下快进 + 生成微博：推进虚拟时间、调用微博生成、转发 chatShares。
 */
import * as db from '../db.js';
import { resolveGenerationMaxTokens } from '../api.js';
import { chatJsonGeneration } from '../chat-json-generation.js';
import { advanceVirtualTime } from '../time-mode.js';
import { getVirtualNow, getVirtualTimePromptStamp } from '../virtual-time-shim.js';
import {
  buildWeiboAiSystemPrompt,
  collectRoleplayContextForSocialGeneration,
  normalizeWeiboBackgroundConfig,
} from '../context/build-weibo-context.js';
import { applyGeneratedChatShares } from '../chat/social-chat-relay.js';
import { normalizeGeneratedWeiboPostAuthor, normalizePostFromAi } from './weibo-post-utils.js';
import { appendWeiboGlobalContextBatch } from './weibo-memory-sync.js';
import { loadSocialLinkConfig, buildSocialLinkPromptHint } from '../chat/social-link-config.js';
import { resolveSocialAuthorLabel } from '../social-helpers.js';
import {
  applySocialPostImages,
  buildSocialImageGenPromptRules,
  resolveSocialImageGenMode,
} from '../social-image-generation.js';
import { listSocialVisibleCharacters } from '../social-character-scope.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
} from '../translation-utils.js';
import { loadWeiboMetaCompat } from './weibo-meta-store.js';

export const GENERIC_OFFLINE_FF_BACKGROUND =
  '【通用·线下时间跳跃】虚拟时间已向前推进；请结合当前角色关系与近期剧情，自然演绎这段时间里生活与关系的延续，不必绑定某一具体突发事件。';

function getWeiboOwnerUserId(userId) {
  return userId || 'guest';
}

function getWeiboMetaKey(userId) {
  return `weiboMeta_${getWeiboOwnerUserId(userId)}`;
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {object} opts.user
 * @param {string} [opts.backgroundEvent]
 * @param {number} opts.deltaMs
 * @param {string[]} [opts.focusCharacterIds]
 */
export async function runEventSlotWeiboFastForward(opts) {
  const { userId, user, backgroundEvent, deltaMs, focusCharacterIds = [] } = opts;
  if (!userId) throw new Error('缺少用户');
  const scopedCharacters = await listSocialVisibleCharacters(user, { excludeAnonNpc: true, userId });
  const scopedCharacterMap = new Map(scopedCharacters.map((row) => [String(row?.id || '').trim(), row]));
  const safeFocusCharacterIds = focusCharacterIds
    .map((id) => String(id || '').trim())
    .filter((id) => scopedCharacterMap.has(id));

  const bg = String(backgroundEvent || '').trim() || GENERIC_OFFLINE_FF_BACKGROUND;
  const isGeneric = bg === GENERIC_OFFLINE_FF_BACKGROUND || bg.includes('【通用·线下时间跳跃】');
  const delta = Math.max(0, Number(deltaMs) || 0);
  if (delta > 0) await advanceVirtualTime(userId, delta);

  const virtualNow = await getVirtualNow(userId, 0);
  const ownerUserId = getWeiboOwnerUserId(userId);
  const weiboMetaKey = getWeiboMetaKey(userId);
  const loadedMeta = await loadWeiboMetaCompat(userId);
  const meta = Object.keys(loadedMeta).length ? loadedMeta : {
    trending: [],
    news: [],
    followingIds: [],
    profiles: {},
    weiboWorldBookId: '',
    globalWeiboBatches: [],
  };
  meta.profiles = meta.profiles || {};
  const bgConfig = normalizeWeiboBackgroundConfig(meta);
  const roleplayCtx = await collectRoleplayContextForSocialGeneration(userId, '生活', {
    focusCharacterIds: safeFocusCharacterIds,
  });
  const systemPrompt = await buildWeiboAiSystemPrompt(user, '生活', {
    worldBookIds: bgConfig.worldBookIds,
    backgroundMode: bgConfig.backgroundMode,
    referenceNotes: [
      ...roleplayCtx.snippets,
      isGeneric ? `【线下快进·通用背景】${bg}` : `【线下快进·背景事件】${bg}`,
    ].join('\n'),
  });
  const relayHint = (roleplayCtx.relayGroupNames || []).length
    ? `用户存档中的群聊名称（chatShares 里 targetType 为 group 时 groupName 须与下列之一一致）:${roleplayCtx.relayGroupNames.join('、')}`
    : '用户当前无存档群聊：chatShares 请只用 targetType=private_user。';
  const socialHint = buildSocialLinkPromptHint(await loadSocialLinkConfig());
  const imageRules = buildSocialImageGenPromptRules(await resolveSocialImageGenMode('weiboImages'));
  const virtualStamp = await getVirtualTimePromptStamp(userId, virtualNow);
  const focusChars = safeFocusCharacterIds.map((id) => scopedCharacterMap.get(id)).filter(Boolean);
  const translationPrompt = buildJsonFieldTranslationPromptBlock(
    collectTranslationActors(focusChars),
    { fields: 'content / hotComments[].content', exampleField: 'content' },
  );
  const userMsg = [
    `当前虚拟时间:${virtualStamp}`,
    relayHint,
    socialHint,
    imageRules,
    translationPrompt,
    isGeneric
      ? `【背景】${bg}\n请据此生成与当前世界观一致的热搜、新闻与角色动态；可适度延续近期剧情氛围。`
      : `【必须围绕背景事件】${bg}`,
    '请生成精简微博生态 JSON：热搜 4～6 条、新闻简讯 2～4 条、posts 2～4 条（角色围绕上述背景发帖/吐槽/辟谣），并必须输出至少 1 条 chatShares，让角色把相关微博转发进用户的私聊或群聊并带口语对白 lines。',
    'chatShares.lines 重要：每条 string 已是目标私聊或群聊里的一条纯对白气泡，只写角色口语，一行一句。',
    'chatShares：forwarderId 用 posts 里出现的 authorId；targetType 用 group 时 groupName 须匹配用户群名。',
    'chatShares 使用 private_user 时唯一接收者是 user，lines 必须确实是在对用户说；不得把称呼或内容明显写给其他角色的消息投进用户私聊。',
    'hotComments 不得代替用户发言；每条须含 authorId、author、content，authorId 不得为 user 或当前用户 id；通讯录角色写真实 id，普通路人写 npc。',
    '纯图帖的 hotComments 必须结合 textImageCaption 或 imagePrompt 的画面评论，禁止把没有文案的正常图片帖说成“空白微博”。',
    '只输出 1 个 JSON 对象，字段 trending, news, posts, chatShares（数组）；posts 含 authorId, authorName, content, zh(外语才需要), tags, wantsImage, imageCharacterId, imagePrompt, textImageCaption, fans, reposts, comments, likes, visibility, hotComments（3条，含 authorId/author/content/zh）。',
    '有 imagePrompt 时必须填写 imageCharacterId：图中是本轮角色就写该角色真实 id，即使作者是粉丝、营销号或官号；无人、物件、风景或非角色人物写 none。该字段描述图中人物，不是作者。',
  ].filter(Boolean).join('\n');

  const genCap = await resolveGenerationMaxTokens();
  const { data: parsed } = await chatJsonGeneration({
    scope: 'event-slot-weibo',
    retryOnInvalid: false,
    messages: [
      { role: 'system', content: `${systemPrompt}\n\n只输出合法JSON，不要解释。` },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.88,
    maxTokens: genCap,
    validate: (value) => value && typeof value === 'object' && Array.isArray(value.posts),
  });
  meta.trending = Array.isArray(parsed.trending) ? parsed.trending.slice(0, 8) : [];
  meta.news = Array.isArray(parsed.news) ? parsed.news : [];
  const postsWithVisuals = await applySocialPostImages(parsed.posts || [], {
    scene: 'weiboImages',
    imageField: 'images',
    maxImages: 3,
  });
  const insertedPosts = [];
  const mentionActors = [
    ...scopedCharacters,
    ...postsWithVisuals.map((row) => ({ id: row?.authorId, authorName: row?.authorName })),
  ];
  for (const p of postsWithVisuals) {
    const normalized = normalizePostFromAi(p, {
      user,
      trustedCommentAuthorIds: safeFocusCharacterIds,
      trustedCommentAuthors: focusChars,
      mentionActors,
    });
    const author = normalizeGeneratedWeiboPostAuthor(p, {
      user,
      trustedAuthors: scopedCharacters,
    });
    const postTs = virtualNow - Math.floor(Math.random() * 3600000);
    const post = {
      id: `weibo_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      ownerUserId,
      authorId: author.authorId,
      authorName: author.authorName,
      avatar: null,
      content: normalized.content || '',
      tags: Array.isArray(p.tags) && p.tags.length ? p.tags : normalized.tags || [],
      images: (Array.isArray(p.images) ? p.images : []).filter(Boolean),
      imagePrompt: String(p.imagePrompt || '').trim(),
      imageCharacterId: (() => {
        const requestedId = String(p.imageCharacterId || p.imageSubjectId || '').trim();
        return scopedCharacterMap.has(requestedId) || requestedId === 'none' ? requestedId : '';
      })(),
      textImage: String(p.textImage || '').trim(),
      imageKind: p.imageKind === 'photo' || p.imageKind === 'textimg' ? p.imageKind : '',
      timestamp: postTs,
      reposts: normalized.reposts,
      comments: normalized.comments,
      likes: normalized.likes,
      fans: Number(p.fans || 0),
      metadata: {
        generatedByAi: true,
        generatedAuthorName: String(p.authorName || '').trim(),
        generationMode: 'event-slot',
        visibility: normalized.visibility,
        ...(normalized.contentTranslation ? { contentTranslation: normalized.contentTranslation } : {}),
      },
      commentList: normalized.hotComments.map((c) => ({
        authorId: c.authorId || '',
        author: resolveSocialAuthorLabel(c.author, { fallback: '热评用户' }),
        content: c.content,
        likes: c.likes,
        ...(c.translation ? { translation: c.translation } : {}),
        timestamp: virtualNow - Math.floor(Math.random() * 400000),
      })),
    };
    await db.put('weiboPosts', post);
    insertedPosts.push(post);
  }
  if (!insertedPosts.length) {
    const fallbackPost = {
      id: `weibo_${Date.now()}_fb`,
      ownerUserId,
      authorId: 'npc',
      authorName: '路人',
      avatar: null,
      content: `【与事件相关】${String(bg).slice(0, 120)}`,
      images: [],
      timestamp: virtualNow,
      reposts: 0,
      comments: 0,
      likes: 0,
      fans: 0,
      commentList: [],
    };
    await db.put('weiboPosts', fallbackPost);
    insertedPosts.push(fallbackPost);
  }
  await applyGeneratedChatShares({
    userId,
    chatShares: parsed.chatShares,
    relayItems: insertedPosts,
    virtualNow,
    relaySpec: {
      urlScheme: 'weibo',
      sourceLabel: '微博',
      lastMessagePreview: '[微博分享]',
      linkTitle: (post, fname) => `微博：${post.authorName || fname}`,
      linkDesc: (post) => post.content || '',
      extraLinkMetadata: () => ({ fromEventSlot: true }),
    },
  });
  appendWeiboGlobalContextBatch(meta, { trending: meta.trending, news: meta.news, posts: insertedPosts });
  await db.put('settings', { key: weiboMetaKey, value: meta });
  return { virtualNow, postCount: insertedPosts.length };
}
