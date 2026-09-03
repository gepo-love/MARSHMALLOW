import { chat as apiChat, resolveGenerationMaxTokens } from '../api.js';
import { createMemory } from '../../models/memory.js';
import { saveMemory } from '../chat-store.js';
import { getUserDisplayName } from '../../models/user.js';
import {
  buildWeiboAiSystemPrompt,
  getWeiboBackgroundConfigFromSettings,
} from '../context/build-weibo-context.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
  sanitizeAiTranslation,
} from '../translation-utils.js';
import { getNowForUser } from '../time-mode.js';
import { normalizeBoundStickerPackIdsFromRow } from '../sticker-store.js';
import { characterAllowsWeiboStickers } from './weibo-character-policy.js';
import { resolveWeiboCharacterPublicName } from './weibo-post-utils.js';
import {
  buildWeiboDmPublicCharacter,
  buildWeiboDmRelationshipBoundary,
} from './weibo-dm-boundary.js';

function extractJsonObject(raw = '') {
  const text = String(raw || '').trim();
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : '';
}

/**
 * 生成「角色本人」对一条粉丝私信的回复。使用独立 system 角色设定与 user 任务，
 * 接入完整角色卡 + 该角色与用户的关系摘要 + 一句仿聊天人设锚点的校准句，
 * 而不是套用微博广场内容那套通用规则——这是"角色在回私信"，不是"角色在发帖"。
 * @param {object} options
 * @param {object} options.character 角色对象（character-store 的 profile）
 * @param {object} options.user 当前用户档案
 * @param {object} options.dm 私信记录 { senderName, senderType, content }
 * @returns {Promise<{ content: string, translation?: string }>}
 */
export async function generateWeiboDmCharacterReply({ character, user, dm, thread = null, messages = [] }) {
  const charName = resolveWeiboCharacterPublicName(character, '角色');
  const stickerPackIds = normalizeBoundStickerPackIdsFromRow(character);
  const allowStickers = characterAllowsWeiboStickers(character) && stickerPackIds.length > 0;
  const publicCharacter = buildWeiboDmPublicCharacter(character, user?.id);
  const bgConfig = await getWeiboBackgroundConfigFromSettings(user?.id || '');
  const systemPrompt = await buildWeiboAiSystemPrompt(user, null, {
    worldBookIds: bgConfig.worldBookIds,
    backgroundMode: bgConfig.backgroundMode,
    referenceNotes: '',
    characters: publicCharacter ? [publicCharacter] : [],
    characterCardMode: 'full',
    allowStickers,
    stickerPackIds,
    passerbyIsolation: true,
  });
  const userName = getUserDisplayName(user);
  const translationActors = collectTranslationActors(character ? [character] : []);
  const wantsZh = translationActors.full.length > 0 || translationActors.mixed.length > 0;
  const translationPrompt = wantsZh
    ? buildJsonFieldTranslationPromptBlock(translationActors, {
      fields: 'content',
      exampleField: 'content',
    })
    : '';
  const prompt = [
    `你现在要以「${charName}」本人的身份，回复 TA 微博主页收到的一条粉丝私信——这是私信回复，不是发微博/发朋友圈，语境更私人、更即时，不需要照顾围观群众。`,
    `发信人：${dm?.senderName || '匿名网友'}（${dm?.senderType || '粉丝'}）`,
    `私信原文：${String(dm?.content || '').trim() || '（空）'}`,
    `回复前想一想「${charName} 收到这条私信会怎么回」，不要写成任何网红/博主都会发的通用客套话（如"谢谢支持""么么哒"这类无差别模板）；口吻、称呼、热情程度、要不要认真回全部以 TA 的人设为准——冷淡角色可以回得很短甚至阴阳怪气，粘人角色可以很热络，人设允许的话也可以选择不回应正题只回一个态度。`,
    `发信人不是 ${userName}（当前用户）本人，不要把这条私信当成用户在跟 TA 说话。`,
    buildWeiboDmRelationshipBoundary({
      messages,
      currentCounterpartName: thread?.counterpartName || dm?.senderName,
    }),
    translationPrompt,
    wantsZh
      ? '只输出一个合法 JSON 对象：{"content":"回复正文","zh":"外语才需要"}。不要加解释、不要包 Markdown。'
      : '只输出回复正文本身，不要加称呼语之外的解释、不要加引号包裹、不要输出JSON或Markdown。',
  ].filter(Boolean).join('\n\n');
  const genCap = await resolveGenerationMaxTokens();
  const raw = await apiChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.95, maxTokens: genCap },
  );
  const trimmed = String(raw || '').trim();
  if (wantsZh) {
    const json = extractJsonObject(trimmed);
    if (json) {
      try {
        const parsed = JSON.parse(json);
        const content = String(parsed?.content || parsed?.text || '').trim()
          .replace(/^["「『]|["」』]$/g, '')
          .trim();
        if (content) {
          const translation = sanitizeAiTranslation(content, parsed?.zh || parsed?.translation || '');
          return { content, ...(translation ? { translation } : {}) };
        }
      } catch (_) { /* fall through to plain text */ }
    }
  }
  const content = trimmed.replace(/^["「『]|["」』]$/g, '').trim();
  return { content };
}

function cleanDmLine(value = '', max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 根据整段微博私信历史生成“会话对方”的下一轮消息。
 * 与 generateWeiboDmCharacterReply 不同：后者是主页角色的代回草稿，
 * 这里生成的是粉丝、同行或商务联系人继续发来的消息。
 */
export async function generateWeiboDmCounterpartReplies({ user, character, thread, messages = [] }) {
  const profileName = cleanDmLine(thread?.profileName || character?.name || user?.name || '我', 60);
  const counterpartName = cleanDmLine(thread?.counterpartName || '对方', 60);
  const counterpartType = cleanDmLine(thread?.counterpartType || '微博用户', 40);
  const publicCharacter = buildWeiboDmPublicCharacter(character, user?.id);
  const bgConfig = await getWeiboBackgroundConfigFromSettings(user?.id || '');
  const systemPrompt = await buildWeiboAiSystemPrompt(user, '生活', {
    worldBookIds: bgConfig.worldBookIds,
    backgroundMode: bgConfig.backgroundMode,
    referenceNotes: '',
    characters: publicCharacter ? [publicCharacter] : [],
    characterCardMode: publicCharacter ? 'full' : 'compact',
    passerbyIsolation: true,
  });
  const history = (Array.isArray(messages) ? messages : [])
    .filter((message) => !message?.deletedAt)
    .slice(-24)
    .map((message) => {
      const speaker = message.direction === 'incoming' ? counterpartName : profileName;
      const body = cleanDmLine(message.content || (message.media?.length ? '[图片]' : message.sharedPostId ? '[分享微博]' : ''), 500);
      return body ? `${speaker}：${body}` : '';
    })
    .filter(Boolean)
    .join('\n');
  const userMessage = [
    `这是微博私信里的连续对话。请扮演会话对方「${counterpartName}」（身份：${counterpartType}），继续回复主页「${profileName}」。`,
    '对方不是当前用户，也不是主页角色。请根据已有私信逐渐形成并保持对方自己的立场、语气和目的；不要替主页一方说话，不要复述上一句，不要每轮重新自我介绍。',
    buildWeiboDmRelationshipBoundary({
      messages,
      currentCounterpartName: counterpartName,
    }),
    '回复可以是一条完整消息，也可以按真实聊天气口拆成 2～3 条短消息。只有外语正文才填写 zh，中文正文的 zh 留空。',
    `最近私信记录：\n${history || '（暂无历史，请由对方自然开启话题）'}`,
    '输出要求',
    '只输出合法 JSON：{"replies":[{"content":"消息正文","zh":"仅外语需要"}]}。replies 必须有 1～3 条，不要输出解释或 Markdown。',
  ].join('\n\n');
  const raw = await apiChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    { temperature: 0.92, maxTokens: await resolveGenerationMaxTokens() },
  );
  const trimmed = String(raw || '').trim();
  const json = extractJsonObject(trimmed);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const replies = (Array.isArray(parsed?.replies) ? parsed.replies : [])
        .slice(0, 3)
        .map((item) => {
          const content = cleanDmLine(item?.content || item?.text, 2000);
          const translation = sanitizeAiTranslation(content, item?.zh || item?.translation || '');
          return content ? { content, ...(translation ? { translation } : {}) } : null;
        })
        .filter(Boolean);
      if (replies.length) return replies;
    } catch (_) { /* fall through to plain text */ }
  }
  const content = cleanDmLine(trimmed.replace(/^['"「『]|['"」』]$/g, ''), 2000);
  if (!content) throw new Error('私信对方没有生成有效回复');
  return [{ content }];
}

function clipText(text = '', max = 160) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 让角色"知道"这件事：仿朋友圈 syncMomentPostMemory 的做法，往 memories 表写一条
 * characterId 索引的事件记忆（chatId 留空）。会被 build-layered-memory-context.js 的
 * sliceMemoriesForCharacter 自动捞进该角色之后任意私聊/群聊上下文，不需要额外接线。
 * @param {object} options
 * @param {string} options.characterId
 * @param {string} options.userId
 * @param {string} options.dmId 私信记录 id（用于生成幂等的记忆 id）
 * @param {string} options.replyId 本条回复 id
 * @param {string} options.fanName
 * @param {string} options.fanContent
 * @param {string} options.replyContent
 * @param {'user_as_char'|'char_ai'} options.replyBy
 */
export async function syncWeiboDmReplyAwareness({
  characterId, userId, dmId, replyId, fanName, fanContent, replyContent, replyBy,
}) {
  const cid = String(characterId || '').trim();
  const uid = String(userId || '').trim();
  if (!cid || !uid || !replyContent) return null;
  const fan = clipText(fanName || '一位粉丝', 40);
  const question = clipText(fanContent, 160);
  const answer = clipText(replyContent, 200);
  const worldNow = await getNowForUser(uid);
  const content = replyBy === 'user_as_char'
    ? `粉丝「${fan}」给你的微博发过私信："${question}"，user 帮你回复了："${answer}"`
    : `粉丝「${fan}」给你的微博发过私信："${question}"，你回复了："${answer}"`;
  const mem = createMemory({
    id: `mem_wbdm_${dmId || Date.now()}_${replyId || Math.random().toString(36).slice(2, 8)}`,
    userId: uid,
    chatId: '',
    characterId: cid,
    type: 'event',
    category: 'shared',
    content,
    importance: 'normal',
    timestamp: worldNow,
    source: 'weibo_dm',
  });
  await saveMemory(mem);
  return mem;
}
