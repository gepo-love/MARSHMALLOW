import * as db from '../db.js';
import { PROMPTS } from '../../data/prompts.js';
import { buildTimeAndHolidayPromptBlock } from '../time-mode.js';
import { buildWorldBookContextBlock } from '../world-book-store.js';
import { buildPresetFragmentContext } from '../preset-store.js';
import {
  getUserChatsForRelay,
  resolveChatParticipantName,
} from '../chat/social-chat-relay.js';
import {
  buildSocialHardRulesPrompt,
  buildSocialNarrativeGuidancePrompt,
  buildSocialFormatGuidancePrompt,
  buildSocialCharacterCardsBlock,
} from '../social-helpers.js';
import { listSocialVisibleCharacters } from '../social-character-scope.js';
import { buildAuPromptBlock } from '../au-config.js';
import {
  getWeiboDisplayName,
  formatUserSignatureStatusContextLines,
  formatUserWorldBackgroundContext,
} from '../../models/user.js';
import { isAnonymousChat } from '../chat-helpers.js';
import { collectGlobalRelationshipNetworkLines, loadRelationshipNetwork } from '../relationship-network.js';
import { filterNonGuidanceMessages } from '../guidance-memory.js';
import { buildSocialAcquaintancePromptBlock } from '../social-acquaintance-context.js';
import { buildGenderPronounRuleLine } from '../identity-gender.js';
import { buildMomentsMemoryBlock } from '../moments/build-moments-context.js';
import { loadWeiboMetaCompat } from '../weibo/weibo-meta-store.js';
import { SOCIAL_RELATIONSHIP_TONE_RULES } from '../social-relationship-tone.js';

export const SOCIAL_CHAT_CONTINUITY_RULES = [
  '[近期聊天时间线 · 最高优先级]',
  '各会话的私有片段已按时间从旧到新排列，同时包含用户与角色的发言；越靠后的状态越新。',
  '若近期聊天与旧摘要、旧记忆或旧计划冲突，以近期聊天最后确认的状态为准；旧状态只能作为已经发生过的背景，不得重启。',
  '同一件事若已经完成、取消或被新决定替代，禁止再发“正准备去做”“还在做”或与之互斥的当下状态。',
  '私聊隐私只限制是否能在公开平台说出细节，不代表角色失忆；不适合公开时应换角度或不提，仍不得违背最新事实。',
].join('\n');

function buildUserCardBlock(user) {
  if (!user) return '';
  const parts = [`【${getWeiboDisplayName(user)}】`];
  const worldBackground = formatUserWorldBackgroundContext(user, { maxLength: 3000 });
  if (worldBackground) parts.push(worldBackground);
  parts.push(`性别与代词硬约束：${buildGenderPronounRuleLine(user, `用户「${getWeiboDisplayName(user)}」`)}`);
  parts.push(...formatUserSignatureStatusContextLines(user, {
    clean: (value) => String(value || '').trim(),
    signatureMax: 200,
    statusMax: 120,
  }));
  if (user.persona) parts.push(`人物设定：${String(user.persona).trim()}`);
  if (user.hobbies) parts.push(`兴趣：${String(user.hobbies).trim()}`);
  const weiboId = String(user.weiboId || '').trim();
  if (weiboId) parts.push(`微博ID：${weiboId}`);
  if (user.weiboBio) parts.push(`微博简介：${String(user.weiboBio).trim()}`);
  return parts.join('\n');
}

/**
 * 微博背景配置归一化：兼容旧版单值 weiboWorldBookId，统一成
 * { backgroundMode: 'modern'|'custom', worldBookIds: string[] }。
 * custom 且 worldBookIds 非空时，生成会只用这些世界书约束背景；否则按 modern 走当代现实生活默认。
 */
export function normalizeWeiboBackgroundConfig(meta = {}) {
  const idsRaw = Array.isArray(meta?.weiboWorldBookIds)
    ? meta.weiboWorldBookIds
    : (meta?.weiboWorldBookId ? [meta.weiboWorldBookId] : []);
  const worldBookIds = [...new Set(idsRaw.map((id) => String(id || '').trim()).filter(Boolean))];
  const backgroundMode = meta?.weiboBackgroundMode === 'custom' || (worldBookIds.length && !meta?.weiboBackgroundMode)
    ? 'custom'
    : 'modern';
  return { backgroundMode, worldBookIds };
}

export async function getWeiboBackgroundConfigFromSettings(userId) {
  const meta = await loadWeiboMetaCompat(userId);
  return normalizeWeiboBackgroundConfig(meta);
}

/**
 * @param {object} options
 * @param {string[]} [options.worldBookIds] 用户在「首次生成前选背景」里多选绑定的世界书（整本 id）。
 * @param {'modern'|'custom'} [options.backgroundMode] modern=默认当代现实生活兜底；
 *   custom=用户已明确选了世界书，只用这些书约束背景，不再叠加全局启用的其它世界书，减少跑偏。
 * @param {Array} [options.characters] 需要注入完整/精简角色卡的通讯录角色列表（不传则不注入角色卡，
 *   仅靠后续的社交硬规则兜底——建议调用方总是传，否则模型只能凭空猜角色人设）。
 * @param {'full'|'compact'} [options.characterCardMode] 角色卡注入模式，见 buildSocialCharacterCardsBlock。
 */
export async function buildWeiboAiSystemPrompt(user, _season, options = {}) {
  const { worldBookIds = [], referenceNotes = '', backgroundMode = 'modern', characters = [], characterCardMode = 'compact' } = options;
  const passerbyIsolation = options.passerbyIsolation === true;
  const boundIds = (Array.isArray(worldBookIds) ? worldBookIds : []).map((id) => String(id || '').trim()).filter(Boolean);
  const isCustomBackground = backgroundMode === 'custom' && boundIds.length > 0;
  const parts = [];
  const wbBlock = await buildWorldBookContextBlock(user, String(referenceNotes || ''), {
    worldBookMode: 'full',
    ...(isCustomBackground ? { onlyBookIds: boundIds } : {}),
  });
  if (wbBlock) parts.push(wbBlock);
  if (user && !passerbyIsolation) {
    parts.push(buildUserCardBlock(user));
  } else if (user) {
    parts.push([
      '【当前微博公开账号】',
      `显示名：${getWeiboDisplayName(user)}`,
      String(user.weiboId || '').trim() ? `微博ID：${String(user.weiboId).trim()}` : '',
      String(user.weiboBio || '').trim() ? `公开简介：${String(user.weiboBio).trim()}` : '',
      '本轮只生成微博游客评论：不得读取或推断该账号背后的私人档案、私聊、记忆、关系与未公开近况。',
    ].filter(Boolean).join('\n'));
  } else {
    parts.push('（未选择用户档案：无个人用户卡；上列为当前启用的世界书条目）');
  }
  if (user) {
    const auBlock = buildAuPromptBlock(user);
    if (auBlock) parts.push(auBlock);
  }
  const characterCardsBlock = buildSocialCharacterCardsBlock(characters, { mode: characterCardMode });
  if (characterCardsBlock) parts.push(characterCardsBlock);
  const acquaintanceBlock = await buildSocialAcquaintancePromptBlock(characters, user?.id);
  if (acquaintanceBlock) parts.push(acquaintanceBlock);
  parts.push(
    '[社交生成·私有上下文分区]\n'
    + '带有「私有片段｜仅 ownerIds=... 可用」的聊天、记忆或近况，不是角色池的公共背景。每条微博、评论、私信或转发只能读取其作者 id 位于 ownerIds 中的私有片段；路人、营销号以及 ownerIds 之外的角色一律不知道。'
    + '素材写到某人、用户或另一角色，只说明该素材的内容涉及他们，不会自动扩大知情范围；禁止把 A 的私聊或回忆改写成 B 与用户共同经历过的事。'
    + '若某类输出只有作者昵称、没有可核对的结构化作者 id（例如普通路人热评），该输出不得引用任何私有片段，只能使用公开正文、公共舆情和角色卡口吻。',
  );
  parts.push(SOCIAL_CHAT_CONTINUITY_RULES);
  parts.push(SOCIAL_RELATIONSHIP_TONE_RULES);
  const presetBlock = await buildPresetFragmentContext('online');
  if (presetBlock) parts.push(presetBlock);
  const wfSetting = await db.get('settings', 'preset_weibo_forum');
  if (wfSetting?.value?.content) {
    parts.push(wfSetting.value.content);
  } else if (PROMPTS.weibo_forum?.content) {
    parts.push(PROMPTS.weibo_forum.content);
  } else if (PROMPTS.social_feed_generic?.content) {
    parts.push(PROMPTS.social_feed_generic.content);
  }
  if (String(referenceNotes || '').trim()) {
    parts.push(`[微博生成补充参考]\n${String(referenceNotes).trim()}`);
  }
  const timeBlock = user?.id ? await buildTimeAndHolidayPromptBlock(user.id) : '';
  if (timeBlock) parts.push(timeBlock);
  parts.push(
    '[微博/朋友圈生成·时间表达]\n'
    + '一切「何时发生」以上方当前时间为准。发帖、转发、评论中的「刚、昨晚、几小时前、本周」等都必须按该虚拟/现实时间理解；禁止按随意编造的日期节点写剧情。',
  );
  parts.push(
    isCustomBackground
      ? '[微博/朋友圈生成·世界观锚点]\n'
        + '这条规则对热搜、路人/营销号/大V号、官方账号等无角色卡约束的内容同样生效，不只是角色本人发的动态。\n'
        + '用户已经明确绑定了上方的世界书作为本档案的背景设定，请严格贴着这些世界书写，不要再引入与之无关的另一套架空世界观；世界书没覆盖到的边角信息，可结合角色卡本身写明的背景/职业合理补全，但不要脱离世界书自创新体系。'
      : '[微博/朋友圈生成·世界观锚点]\n'
        + '这条规则对热搜、路人/营销号/大V号、官方账号等无角色卡约束的内容同样生效，不只是角色本人发的动态。\n'
        + '背景设定按以下优先级取用：①上方已加载的世界书条目 ②当前 AU 设定 ③角色卡本身写明的特殊背景或职业。\n'
        + '以上都没有相关设定时，默认贴着当前虚拟时间下的当代现实生活写：普通城市、常见行业、真实社会议题、正常的网络热梗和八卦；不要凭空编出赛博朋克、社会分层积分、虚构货币、超能力、系统流穿越这类整套架空世界观——哪怕是路人爆料、营销号猎奇、热搜话题也不例外。角色本人发的内容仍要贴合其人设与已有聊天记录里的近况/新闻。',
  );
  parts.push(buildSocialHardRulesPrompt(user));
  parts.push(buildSocialFormatGuidancePrompt('weibo'));
  parts.push(await buildSocialNarrativeGuidancePrompt({
    allowStickers: options.allowStickers !== false,
    stickerPackIds: options.stickerPackIds,
  }));
  return parts.filter(Boolean).join('\n\n---\n\n');
}

/**
 * options.strictFocus：微博/朋友圈这类多角色共享的社交广场默认要广撒网（其他角色的关系网、聊天片段
 * 都是合理的世界背景）；但像匿名空间这种「只属于一个角色的个人主页」场景，混进不相关角色的关系网/
 * 聊天片段容易被 AI 当成这个角色自己的信息写出来（串人设/串记忆），此时应传 true 严格只保留聚焦角色自己的。
 */
export async function collectRoleplayContextForSocialGeneration(userId, _season, options = {}) {
  const focusIds = [...new Set((options.focusCharacterIds || []).filter(Boolean))];
  const strictFocus = options.strictFocus === true && focusIds.length > 0;
  const allChats = (await getUserChatsForRelay(userId))
    .filter((chat) => !(options.excludeAnonymous === true && isAnonymousChat(chat)));
  const charMap = new Map();
  const characters = {};
  const storedChars = await listSocialVisibleCharacters(null, { excludeAnonNpc: true, userId });
  for (const c of storedChars) {
    charMap.set(c.id, c);
    characters[c.id] = c;
  }
  const chats = allChats.filter((chat) => (chat?.participants || [])
    .some((id) => charMap.has(String(id || '').trim())));
  const relationLines = [];
  for (const ch of charMap.values()) {
    if (!ch?.id || !ch.relationships) continue;
    if (strictFocus && !focusIds.includes(ch.id)) continue;
    const pairs = Object.entries(ch.relationships).slice(0, 3);
    if (!pairs.length) continue;
    const desc = pairs
      .map(([rid, rel]) => {
        const target = charMap.get(rid);
        if (!target) return '';
        return `${target.name || target.id}:${String(rel || '').slice(0, 18)}`;
      })
      .filter(Boolean)
      .join('；');
    if (!desc) continue;
    relationLines.push(`[关系视角 ownerId=${ch.id}] ${ch.name || ch.id}=>${desc}`);
    if (relationLines.length >= 14) break;
  }
  const relationshipNet = await loadRelationshipNetwork(userId).catch(() => null);
  if (relationshipNet?.circles?.length) {
    const globalFocusIds = strictFocus && focusIds.length
      ? focusIds
      : [...charMap.keys()];
    const globalLines = collectGlobalRelationshipNetworkLines(relationshipNet, {
      partnerIds: globalFocusIds,
      characters,
      userName: '我',
      maxEdges: 12,
      linePrefix: '[全局关系网]',
    });
    for (const line of globalLines) {
      relationLines.push(line);
      if (relationLines.length >= 24) break;
    }
  }
  const snippets = [];
  const chatHasFocus = (chat) =>
    focusIds.length && Array.isArray(chat?.participants) && focusIds.some((id) => chat.participants.includes(id));

  async function pullSnippetsFromChat(chat, maxMsgs) {
    const participantSet = new Set(Array.isArray(chat?.participants)
      ? chat.participants.filter((id) => id === 'user' || charMap.has(String(id || '').trim()))
      : []);
    const privateAudienceIds = [...participantSet]
      .filter((id) => id && id !== 'user' && charMap.has(id) && (!strictFocus || focusIds.includes(id)));
    if (!privateAudienceIds.length) return;
    const msgs = filterNonGuidanceMessages(await db.getAllByIndex('messages', 'chatId', chat.id));
    const latest = selectRecentSocialChatMessages(msgs, {
      participantIds: [...participantSet],
      maxMessages: maxMsgs,
    });
    for (const m of latest) {
      const name = (await resolveChatParticipantName(m.senderId, { userId })) || m.senderName || m.senderId;
      snippets.push(formatSocialPrivateSnippet({
        audienceIds: privateAudienceIds,
        speakerId: m.senderId,
        speakerName: name,
        content: m.content,
        timestamp: m.timestamp,
      }));
      if (snippets.length >= 22) return;
    }
  }

  if (focusIds.length) {
    const focused = chats.filter((c) => chatHasFocus(c));
    const rest = strictFocus ? [] : chats.filter((c) => !focused.includes(c));
    const ordered = [...focused, ...rest];
    for (const chat of ordered.slice(0, 14)) {
      const n = chatHasFocus(chat) ? 6 : 2;
      await pullSnippetsFromChat(chat, n);
      if (snippets.length >= 22) break;
    }
  } else {
    for (const chat of chats.slice(0, 10)) {
      await pullSnippetsFromChat(chat, 2);
      if (snippets.length >= 18) break;
    }
  }
  // 微博、朋友圈与私信共用这个收集器。以前这里只拿最近聊天，
  // 旧对话被摘要成 memories / memoryFacts 后就会从社交生成中消失。
  // 沿用朋友圈已验证的分角色知情边界，并用较小限额避免多角色批次膨胀。
  if (focusIds.length) {
    const memoryBlock = await buildMomentsMemoryBlock(userId, focusIds, {
      memoryLimit: 3,
      factLimit: 4,
      eventLimit: 3,
    }).catch(() => '');
    if (memoryBlock) snippets.push(`[${strictFocus ? '本轮角色' : '社交角色'}长期记忆｜按 ownerId 严格分区]\n${memoryBlock}`);
  }
  const relayGroupNames = chats
    .filter((c) => c.type === 'group' && (c.participants || []).includes('user'))
    .map((c) => String(c.groupSettings?.name || '').trim())
    .filter(Boolean)
    .slice(0, 16);
  return { relationLines, snippets, relayGroupNames };
}

/**
 * 社交广场会在同一轮里生成多个角色。每条私聊摘录都必须携带可见角色集合，
 * 不能只写说话者名字后把整批素材交给模型自行猜归属。
 */
export function formatSocialPrivateSnippet({
  audienceIds = [],
  speakerId = '',
  speakerName = '',
  content = '',
  timestamp = 0,
} = {}) {
  const owners = [...new Set((Array.isArray(audienceIds) ? audienceIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const body = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!owners.length || !body) return '';
  const sid = String(speakerId || '').trim();
  const name = String(speakerName || sid || '角色').trim();
  const ts = Number(timestamp || 0);
  const stamp = ts > 0 && Number.isFinite(ts) ? `｜time=${new Date(ts).toISOString()}` : '';
  return `[私有片段｜仅 ownerIds=${owners.join(',')} 可用｜speakerId=${sid || 'unknown'} ${name}${stamp}] ${body}`;
}

/**
 * 微博/朋友圈的近期聊天不能只拿角色台词：用户的“已经吃完了”往往才是
 * 关闭旧计划的决定性事实。先取最新窗口，再按旧→新返回，使模型能正确识别状态覆盖。
 */
export function selectRecentSocialChatMessages(messages = [], {
  participantIds = [],
  maxMessages = 6,
} = {}) {
  const participantSet = new Set((Array.isArray(participantIds) ? participantIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  const cap = Math.max(1, Number(maxMessages) || 1);
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      if (!message || message.deleted || message.recalled || message.type !== 'text') return false;
      if (!String(message.content || '').trim()) return false;
      const senderId = String(message.senderId || '').trim();
      return !senderId || participantSet.size === 0 || participantSet.has(senderId);
    })
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .slice(-cap);
}
