import { chat as apiChat, resolveGenerationMaxTokens } from '../api.js';
import { getCharacter } from '../character-store.js';
import { buildForumAiSystemPrompt, collectForumRoleplayHints } from '../context/build-forum-context.js';
import * as db from '../db.js';
import {
  sanitizeGeneratedForumAuthor,
  sanitizeGeneratedForumReplyAuthor,
} from '../forum-identity.js';
import { stripLeakedCharacterCodes } from '../chat/character-code-fallback.js';
import { getNowForUser } from '../time-mode.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
  sanitizeAiTranslation,
} from '../translation-utils.js';
import { normalizeBoundStickerPackIdsFromRow } from '../sticker-store.js';
import { socialIntentExplicitlyRequestsChatTranscript } from '../social-helpers.js';
import { loadForumMetaCompat } from './forum-meta-store.js';

const SAFE_DEFAULT_SECTION = Object.freeze({
  id: 'general',
  name: '闲聊',
  type: '闲聊',
  desc: '日常交流与随手分享。',
});

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

function parseIntentThread(raw = '') {
  const json = extractJsonObject(raw);
  if (!json) {
    const error = new Error('论坛单作者生成未返回 JSON');
    error.reason = String(raw || '').trim() ? 'json-parse-failed' : 'empty-api-response';
    throw error;
  }
  try {
    const parsed = JSON.parse(json);
    const row = Array.isArray(parsed?.threads) ? parsed.threads[0] : (parsed?.thread || parsed?.post || parsed);
    if (!row || typeof row !== 'object') throw new Error('missing thread');
    return row;
  } catch (cause) {
    const error = new Error('论坛单作者生成返回了无效 JSON');
    error.reason = 'json-parse-failed';
    error.rawText = String(raw || '').slice(0, 120000);
    error.cause = cause;
    throw error;
  }
}

function isWatchingSection(section = {}) {
  return clean(section.id) === 'watching_you' || clean(section.name).includes('我会一直看着你');
}

async function resolveIntentSection(userId, explicitSectionId = '') {
  const meta = await loadForumMetaCompat(userId);
  const sections = Array.isArray(meta.sections) ? meta.sections.filter((section) => section?.id) : [];
  if (explicitSectionId) {
    const explicit = sections.find((section) => clean(section.id) === clean(explicitSectionId));
    if (explicit) return explicit;
  }
  const active = sections.find((section) => clean(section.id) === clean(meta.activeSectionId));
  if (active && !isWatchingSection(active)) return active;
  return sections.find((section) => !isWatchingSection(section)) || SAFE_DEFAULT_SECTION;
}

function safeAlias(raw, character = {}, user = {}) {
  const candidate = stripLeakedCharacterCodes(
    clean(raw?.authorAlias || raw?.authorName || raw?.alias || raw?.nickname, 60),
    { fallbackLabel: '匿名观众' },
  ).trim();
  const forbidden = new Set([
    character.id,
    character.name,
    character.realName,
    character.customNickname,
    user?.id,
    user?.name,
    user?.nickname,
  ].map((value) => clean(value).toLowerCase()).filter(Boolean));
  if (!candidate || forbidden.has(candidate.toLowerCase())) return '匿名观众';
  return candidate;
}

function normalizeReplies(rows = [], now = 0, characters = {}, options = {}) {
  const stamp = Number(now) || Date.now();
  return (Array.isArray(rows) ? rows : [])
    .slice(0, 4)
    .map((reply) => {
      const content = stripLeakedCharacterCodes(clean(reply?.content || reply?.text, 300), { fallbackLabel: '匿名' });
      const translation = sanitizeAiTranslation(content, reply?.zh || reply?.translation || '');
      const identity = sanitizeGeneratedForumReplyAuthor(reply, characters, {
        ...options,
        strictRoleScope: true,
      });
      return {
        author: stripLeakedCharacterCodes(clean(identity.author, 60), { fallbackLabel: '匿名' }) || '匿名',
        content,
        timestamp: stamp,
        childReplies: [],
        authorSource: identity.authorSource,
        authorRoleId: identity.authorRoleId,
        forumActorId: identity.forumActorId,
        authorPersonality: clean(reply?.authorPersonality || reply?.authorProfile?.personality, 700),
        authorSpeechStyle: clean(reply?.authorSpeechStyle || reply?.authorProfile?.speechStyle, 500),
        authorBackground: clean(reply?.authorBackground || reply?.authorProfile?.background, 600),
        authorInterests: (Array.isArray(reply?.authorInterests) ? reply.authorInterests : reply?.authorProfile?.interests || [])
          .map((value) => clean(value, 40)).filter(Boolean).slice(0, 8),
        ...(translation ? { translation } : {}),
      };
    })
    .filter((reply) => reply.content);
}

export function normalizeForumIntentThread(raw = {}, {
  user = {},
  userId = '',
  authorId = '',
  character = {},
  section = SAFE_DEFAULT_SECTION,
  sourceChatId = '',
  now = 0,
} = {}) {
  const alias = safeAlias(raw, character, user);
  const author = sanitizeGeneratedForumAuthor({
    ...raw,
    authorName: alias,
    authorAlias: alias,
    authorId,
    authorRoleId: authorId,
  }, { [authorId]: character }, { user, userId });
  const title = stripLeakedCharacterCodes(clean(raw.title || raw.subject || '随手记', 100), { fallbackLabel: '随手记' });
  const content = stripLeakedCharacterCodes(clean(raw.content || raw.body || raw.text, 2000), { fallbackLabel: '匿名' });
  if (!content) return null;
  const stamp = Number(now) || Date.now();
  const contentTranslation = sanitizeAiTranslation(content, raw.zh || raw.translation || raw.contentTranslation || '');
  return {
    title: title || '随手记',
    content,
    authorName: alias,
    authorId: clean(authorId),
    authorRoleId: clean(author.authorRoleId) || clean(authorId),
    authorAlias: alias,
    authorSource: author.authorSource,
    topicSource: 'chat_intent',
    userId: clean(userId),
    sectionId: clean(section.id) || SAFE_DEFAULT_SECTION.id,
    replies: normalizeReplies(raw.replies || raw.comments, stamp, { [authorId]: character }, {
      user,
      forbiddenNames: [userId],
    }),
    ...(contentTranslation ? { contentTranslation } : {}),
    metadata: {
      sourceType: 'chat',
      sourceChatId: clean(sourceChatId),
      topicSource: 'chat_intent',
      ...(contentTranslation ? { contentTranslation } : {}),
    },
  };
}

export async function aiGenerateForumIntentThread({
  user,
  userId,
  authorId,
  brief,
  sourceChatId,
  recentMessages = [],
  sectionId = '',
  request = apiChat,
  loadCharacter = getCharacter,
} = {}) {
  const uid = clean(userId || user?.id);
  const aid = clean(authorId);
  if (!uid || !aid || aid === 'user' || aid === uid) throw new Error('论坛发帖角色不合法');
  const character = await loadCharacter(aid);
  if (!character?.id || clean(character.id) !== aid) throw new Error('论坛发帖角色不在当前通讯录');
  const stickerPackIds = normalizeBoundStickerPackIdsFromRow(character);
  const section = await resolveIntentSection(uid, clean(sectionId));
  const roleplay = await collectForumRoleplayHints(uid, {
    focusCharacterIds: [aid],
    strictFocus: true,
  });
  const sourceLines = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((message) => {
      const senderId = clean(message?.senderId || message?.from);
      return senderId === 'user' || senderId === aid;
    })
    .slice(-6)
    .map((message) => `${clean(message?.senderId || message?.from) === aid ? clean(character.name || character.realName || '角色') : '用户'}：${clean(message?.content || message?.text, 240)}`)
    .filter((line) => !line.endsWith('：'));
  const explicitChatShare = socialIntentExplicitlyRequestsChatTranscript(brief);
  const referenceNotes = [
    roleplay.relation?.length ? `【仅限发帖角色的关系摘要】\n${roleplay.relation.join('\n')}` : '',
    roleplay.snippets?.length ? `【仅限发帖角色的口吻片段 · 只学语气，不拿其中事件当正文主题】\n${roleplay.snippets.slice(0, 16).join('\n')}` : '',
    sourceLines.length ? `【触发动机背景 · 当前私聊不默认成为正文主题】\n${sourceLines.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const systemPrompt = await buildForumAiSystemPrompt(user, {
    worldBookIds: section?.worldBookIds || section?.worldBookId || [],
    auEntryIds: section?.auEntryIds || section?.auEntryId || [],
    referenceNotes,
    section,
    characters: [character],
    allowStickers: stickerPackIds.length > 0,
    stickerPackIds,
  });
  const realName = clean(character.name || character.realName || character.customNickname || aid, 80);
  const translationPrompt = buildJsonFieldTranslationPromptBlock(
    collectTranslationActors([character]),
    { fields: 'content / replies[].content', exampleField: 'content' },
  );
  const task = [
    `只生成一条由角色「${realName}」(${aid}) 使用伪装论坛 ID 发布的主帖。`,
    `发帖意图：${clean(brief, 300)}`,
    `版块：${clean(section.name || section.id)}（sectionId=${clean(section.id)}）。`,
    isWatchingSection(section)
      ? '该特殊版块是调用方明确指定的，可以按版块规则写。'
      : '不得把帖子改投到 watching_you / 我会一直看着你版块。',
    `authorRoleId 必须写成 ${aid}，authorId 必须写成 ${aid}；authorName 与 authorAlias 必须是同一个伪装 ID，不得使用真实角色名。`,
    '不得把当前用户、其他通讯录角色、路人或匿名 NPC 改成主帖作者。',
    'replies 若输出楼层，不得代替当前用户发言；回复者的 author/authorName/authorRoleId/forumActorId 均不得写 user、当前用户 id、当前用户显示名或用户论坛马甲名。',
    '只可使用上方该角色卡、该角色相关关系与当前私聊；其他用户档位、其他角色私聊与匿名窗口内容一律不可见。',
    '当前私聊只解释角色为什么此刻想发帖，不是默认要公开或复盘的内容。主帖应围绕 brief 展开角色自己的问题、观点、经历切面或公共讨论，不要总结“刚才用户说了什么”。',
    '本篇主话题来源固定为 chat_intent：微博公共素材只作为世界认知，不得抢占 brief 成为主帖主题。',
    explicitChatShare
      ? 'brief 明确要求公开聊天内容：只可谨慎转述 brief 指定的部分，不得补写私聊细节或虚构用户同意。'
      : 'brief 没有明确要求公开聊天记录或截图：不得引用、概括、截图式呈现与用户的对话；若情绪由私聊触发，只能转化为角色自己的匿名表达。',
    translationPrompt,
    '只输出一个合法 JSON 对象：{"thread":{"title":"标题","content":"正文","zh":"外语正文才需要","authorName":"伪装ID","authorAlias":"同一伪装ID","authorId":"固定角色id","authorRoleId":"固定角色id","replies":[]}}',
  ].filter(Boolean).join('\n');
  const maxTokens = await resolveGenerationMaxTokens();
  const raw = await request([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ], { temperature: 0.9, maxTokens });
  return normalizeForumIntentThread(parseIntentThread(raw), {
    user,
    userId: uid,
    authorId: aid,
    character,
    section,
    sourceChatId,
    now: await getNowForUser(uid),
  });
}
