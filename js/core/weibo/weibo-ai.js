import { chat as apiChat, resolveGenerationMaxTokens } from '../api.js';
import { getCharacter } from '../character-store.js';
import {
  buildWeiboAiSystemPrompt,
  collectRoleplayContextForSocialGeneration,
  getWeiboBackgroundConfigFromSettings,
} from '../context/build-weibo-context.js';
import { normalizePostFromAi, resolveWeiboCharacterPublicName } from './weibo-post-utils.js';
import { getNowForUser } from '../time-mode.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
} from '../translation-utils.js';
import { normalizeBoundStickerPackIdsFromRow } from '../sticker-store.js';
import { socialIntentExplicitlyRequestsChatTranscript } from '../social-helpers.js';
import {
  applyWeiboCharacterStickerPolicy,
  characterAllowsWeiboStickers,
} from './weibo-character-policy.js';

function clean(value = '', max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function extractJsonObject(raw = '') {
  const text = String(raw || '').trim();
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : '';
}

function parseIntentPost(raw = '') {
  const json = extractJsonObject(raw);
  if (!json) {
    const error = new Error('微博单作者生成未返回 JSON');
    error.reason = String(raw || '').trim() ? 'json-parse-failed' : 'empty-api-response';
    throw error;
  }
  try {
    const parsed = JSON.parse(json);
    const row = Array.isArray(parsed?.posts) ? parsed.posts[0] : (parsed?.post || parsed);
    if (!row || typeof row !== 'object') throw new Error('missing post');
    return row;
  } catch (cause) {
    const error = new Error('微博单作者生成返回了无效 JSON');
    error.reason = 'json-parse-failed';
    error.rawText = String(raw || '').slice(0, 120000);
    error.cause = cause;
    throw error;
  }
}

export function normalizeWeiboIntentPost(raw = {}, {
  user = null,
  userId = '',
  authorId = '',
  authorName = '',
  trustedCommentAuthors = [],
  sourceChatId = '',
  now = 0,
} = {}) {
  const normalized = normalizePostFromAi(raw, {
    user,
    trustedCommentAuthorIds: [authorId],
    trustedCommentAuthors,
    mentionActors: [
      ...trustedCommentAuthors,
      { id: authorId, authorName },
    ],
  });
  if (!normalized.content) return null;
  const stamp = Number(now) || Date.now();
  return {
    authorId: clean(authorId),
    authorName: clean(authorName, 80) || '匿名用户',
    content: normalized.content,
    tags: normalized.tags,
    images: [],
    reposts: normalized.reposts,
    comments: normalized.comments,
    likes: normalized.likes,
    fans: Math.max(0, Number(raw.fans || 0)),
    commentList: normalized.hotComments.map((comment) => ({
      ...comment,
      timestamp: stamp,
    })),
    repostList: [],
    metadata: {
      visibility: normalized.visibility,
      sourceType: 'chat',
      sourceChatId: clean(sourceChatId),
      ownerUserId: clean(userId),
      ...(normalized.contentTranslation ? { contentTranslation: normalized.contentTranslation } : {}),
    },
  };
}

export async function aiGenerateWeiboIntentPost({
  user,
  userId,
  authorId,
  brief,
  sourceChatId,
  recentMessages = [],
  request = apiChat,
  loadCharacter = getCharacter,
} = {}) {
  const uid = clean(userId || user?.id);
  const aid = clean(authorId);
  if (!uid || !aid || aid === 'user' || aid === uid) throw new Error('微博发帖角色不合法');
  const character = await loadCharacter(aid);
  if (!character?.id || clean(character.id) !== aid) throw new Error('微博发帖角色不在当前通讯录');
  const authorName = clean(resolveWeiboCharacterPublicName(character, aid), 80);
  const stickerPackIds = normalizeBoundStickerPackIdsFromRow(character);
  const allowWeiboStickers = characterAllowsWeiboStickers(character) && stickerPackIds.length > 0;
  const roleplay = await collectRoleplayContextForSocialGeneration(uid, null, {
    focusCharacterIds: [aid],
    strictFocus: true,
  });
  const sourceLines = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((message) => {
      const senderId = clean(message?.senderId || message?.from);
      return senderId === 'user' || senderId === aid;
    })
    .slice(-6)
    .map((message) => `${clean(message?.senderId || message?.from) === aid ? authorName : '用户'}：${clean(message?.content || message?.text, 240)}`)
    .filter((line) => !line.endsWith('：'));
  const background = await getWeiboBackgroundConfigFromSettings(uid);
  const explicitChatShare = socialIntentExplicitlyRequestsChatTranscript(brief);
  const referenceNotes = [
    roleplay.relationLines?.length ? `【仅限${authorName}的关系摘要】\n${roleplay.relationLines.join('\n')}` : '',
    roleplay.snippets?.length ? `【仅限${authorName}的口吻片段 · 只学语气，不拿其中事件当正文主题】\n${roleplay.snippets.slice(0, 16).join('\n')}` : '',
    sourceLines.length ? `【触发动机背景 · 当前私聊不默认成为正文主题】\n${sourceLines.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const systemPrompt = await buildWeiboAiSystemPrompt(user, null, {
    worldBookIds: background.worldBookIds,
    backgroundMode: background.backgroundMode,
    referenceNotes,
    characters: [character],
    characterCardMode: 'full',
    allowStickers: allowWeiboStickers,
    stickerPackIds,
  });
  const translationPrompt = buildJsonFieldTranslationPromptBlock(
    collectTranslationActors([character]),
    { fields: 'content / hotComments[].content', exampleField: 'content' },
  );
  const task = [
    `只生成一条由角色「${authorName}」(${aid}) 本人发布的微博。`,
    `发帖意图：${clean(brief, 300)}`,
    '这是单作者任务：不得改成用户本人、其他通讯录角色、路人、官号或营销号发帖。',
    `authorId 必须写成 ${aid}；authorName 必须写成 ${authorName}。即使模型想换作者也不允许。`,
    '只可使用上方该角色卡、该角色相关关系与当前私聊；不要借用其他角色的私聊、记忆或秘密。',
    '当前私聊只解释角色为什么此刻想发微博，不是默认要公开或复盘的内容。正文应围绕 brief 写角色自己的观点、近况、兴趣或公共观察，不要总结“刚才用户说了什么”。',
    explicitChatShare
      ? 'brief 明确要求公开聊天内容：只可谨慎转述 brief 指定的部分，不得补写私聊细节或虚构用户同意。'
      : 'brief 没有明确要求公开聊天记录或截图：不得引用、概括、截图式呈现与用户的对话；若情绪由私聊触发，只能转化为角色自己的含蓄表达。',
    '不得把当前用户当作者，不得声称用户发布、代发或授权发布。',
    translationPrompt,
    '热评不得代替用户发言；hotComments[].authorId 不得为 user 或当前用户 id。通讯录角色写真实 id，普通路人写 npc。',
    '若 visibility=private，reposts、comments、likes 必须全为 0，hotComments 必须为 []；其他可见性才可生成互动。',
    '只输出一个合法 JSON 对象：{"post":{"authorId":"固定角色id","authorName":"固定角色名","content":"正文","zh":"外语才需要","tags":[],"reposts":0,"comments":0,"likes":0,"visibility":"public|fans_only|private","hotComments":[{"authorId":"角色真实id或npc","author":"路人","content":"评论","zh":"外语才需要","likes":0}]}}',
  ].filter(Boolean).join('\n');
  const maxTokens = await resolveGenerationMaxTokens();
  const raw = await request([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ], { temperature: 0.9, maxTokens });
  const parsedPost = applyWeiboCharacterStickerPolicy([parseIntentPost(raw)], [character])[0];
  return normalizeWeiboIntentPost(parsedPost, {
    user,
    userId: uid,
    authorId: aid,
    authorName,
    trustedCommentAuthors: [character],
    sourceChatId,
    now: await getNowForUser(uid),
  });
}
