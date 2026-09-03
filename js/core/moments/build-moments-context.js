import { getCharacter } from '../character-store.js';
import { listSocialVisibleCharacters } from '../social-character-scope.js';
import { listMemoriesForUser, listChatsForUser } from '../chat-store.js';
import {
  listMemoryFactsForContext,
  resolveEffectiveTemporalState,
} from '../memory/memory-facts.js';
import { listMomentPostsForUser } from './moments-store.js';
import { getCharacterPromptTagSnippets } from '../../data/character-prompt-tags.js';
import {
  getUserDisplayName,
  formatUserSignatureStatusContextLines,
  formatUserWorldBackgroundContext,
} from '../../models/user.js';
import { getCharacterAiContextName, normalizeTranslationProfile } from '../../models/character.js';
import { translationProfileBrief } from '../translation-utils.js';
import { isEligibleMomentsChatSource } from './moments-actors.js';
import { buildCharacterGenderRuleLine, buildCharacterGenderRulesBlock } from '../social-helpers.js';
import { buildGenderPronounRuleLine } from '../identity-gender.js';
import {
  buildSocialStoryContinuityBlockFromSnapshot,
  loadSocialStoryContinuitySnapshot,
} from '../memory/social-story-continuity.js';

function cleanBlock(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export const MOMENTS_VOICE_RULES = [
  '[口吻与防串人设 · 硬性规则]',
  '1. 每条动态正文必须完全符合「发圈作者」的人物设定与说话风格，不得写成其他角色的语气。',
  '2. 每条评论必须完全符合该条评论 author 对应角色的人物设定；评论是朋友圈短评（一两句口语），不是私聊长回复。',
  '3. 禁止串人设：不得把 A 的口癖、称呼、性格套到 B 身上；不得用用户口吻代角色发言。',
  '4. 同一批互动里，不同角色的评论要有明显区分度；宁可简短也要像「这个人」会说的话。',
  '5. 点赞只需填 id，无需文字；评论 text 里不要写「角色名：」前缀。',
  '6. 正文和评论提及任何角色时，必须按角色 id 对照性别与代词硬表；禁止根据姓名、职业、性格或外观自行判断性别。',
].join('\n');

export const MOMENTS_CONTENT_RULES = [
  '[朋友圈正文 · 写什么]',
  '【视角与称呼方向】每条 content 都是该条 posts[].author 本人发出的文字；正文中的「我」只等于 author，id=user 的用户不是「我」。',
  '聊天素材统一写成「A（id=…）→ B（id=…）：台词」，含义是 A 对 B 说这句话。称呼和绰号必须保持此方向：A 叫 B「小骗子」不能改写成 A 被叫「小骗子」。方向不确定时不要引用该称呼。',
  '每条动态由三样东西共同决定：该条的场景指令（若有）、发圈者的人物设定、人物关系图。场景指令给的是「发生了什么、涉及谁、意图是什么」——表达方式、句式、语气完全按发圈者本人的人设来写，禁止套模板。',
  '没有场景指令的条目就是普通生活切片：吐槽、碎碎念、随手一拍、似说非说、神秘文案都行，无图纯文字完全正常；但生活切片也要长在这个角色真实的日子上（职业、兴趣、最近发生的事），不要写谁发都成立的通用文案。',
  '朋友圈不是新闻播报也不是日记摘要：可以只说一半、可以阴阳怪气、可以凡尔赛、可以发疯文学、可以就一个标点或 emoji；让读的人「品」出言外之意比把话说全更像真人。',
  '表情请直接写 Unicode emoji（如 😭😂🤦），不要写微信/QQ 方括号码（禁止 [大哭][捂脸][笑哭] 这类）。用户导入的表情包另用 stickerNames / [表情包:名称]。',
  '禁止把近期私聊内容整句照抄成正文；同一件事在一批里最多被两条动态涉及（隔空呼应场景除外的独立条目不要扎堆聊同一件旧事）。',
  '【用户事实边界】涉及用户的具体经历、原话、近况、关系进展或与谁发生过什么，只能来自用户档案、专属聊天、记忆、角色设定或本轮明确的场景指令；禁止为朋友圈氛围自行编出用户没做过的事、没说过的话、约定、争吵或第三者情节。没有来源时可以写角色自身的感受/猜测，但不能当作事实；仅当用户当前明确授权虚构该事件时例外。',
].join('\n');

export const MOMENTS_COMMENT_STYLE_RULES = [
  '[评论区 · 风格]',
  '评论区的主旋律是损友互动，不是彩虹屁：拆台、接梗、阴阳怪气、看热闹不嫌事大、被 cue 的第三人喊冤，比「哈哈哈真棒」有生命力得多。',
  '同一条动态下面，贴主不需要把每条外部评论都回复一遍：只挑最值得接的 0～2 条回（comments.author 写发圈者 id，replyTo 写被回复者称呼），其余评论自然晾着。是否回、回谁、回几句由贴主性格和具体评论决定；禁止形成「每条评论后固定跟一条贴主回复」的机械队形。',
  '鼓励用 replyTo 形成追问/回怼链：发圈者本人可以回不止一条，评论者之间也可以互相接话，两三个来回的小型对线完全正常。',
  '可以玩梗：自造 hashtag（#某某情感破裂#）、@别人起哄配对、复读别人刚说的话、故意曲解正文、用正文里的字反过来怼作者。',
  '评论里的表情同样用 Unicode emoji（😭😂），不要写 [捂脸][大哭]；也可偶尔用 [表情包:名称]（须在表情包库内）。',
  '每个评论者的发言必须贴自己人设：毒舌的毒舌、老实人认真回复被玩、长辈式发言画风格格不入也是笑点；同一个人在不同楼里口吻要一致。',
  '不是每条动态都要热闹：冷门角色发的圈可以只有一两个赞、零星一条评论甚至没人理，这种落差本身就真实。',
].join('\n');

/** 朋友圈中的「某人」如指用户，必须以这张真实用户档案为锚；不请求天气，避免社交生成为此额外联网。 */
export function buildMomentsUserProfileBlock(user = null) {
  if (!user) return '';
  const label = getUserDisplayName(user);
  const clip = (value, max = 240) => cleanBlock(value).slice(0, max);
  const rawName = clip(user.name, 80);
  const rawNick = clip(user.nickname, 80);
  const parts = [`[用户档案 · ${label} · 固定 id=user]`];
  const worldBackground = formatUserWorldBackgroundContext(user, { maxLength: 3000 });
  if (worldBackground) parts.push(worldBackground);
  parts.push(`性别与代词硬约束：${buildGenderPronounRuleLine(user, `用户「${label}」`)}`);
  if (rawName && rawNick && rawName !== rawNick) parts.push(`姓名：${rawName}`);
  parts.push(`对话称呼：${label}（角色对用户说话或提到用户时使用；这不是角色自己的名字或外号）`);
  parts.push(...formatUserSignatureStatusContextLines(user, {
    clean: cleanBlock,
    signatureMax: 160,
    statusMax: 160,
  }));
  if (user.birthday) parts.push(`生日：${clip(user.birthday, 80)}`);
  if (user.virtualCity) parts.push(`所在城市：${clip(user.virtualCity, 80)}`);
  if (user.myPlaceLabel) parts.push(`常住/落脚地点：${clip(user.myPlaceLabel, 120)}`);
  if (user.hobbies) parts.push(`兴趣：${clip(user.hobbies, 300)}`);
  if (user.dislikes) parts.push(`雷点：${clip(user.dislikes, 300)}`);
  if (user.persona) parts.push(`人物设定：${clip(user.persona, 600)}`);
  if (user.appearancePrompt) parts.push(`外观：${clip(user.appearancePrompt, 300)}`);
  parts.push('可用法：角色若在正文里用「某人 / 那个人」含蓄指代用户，指的只能是此处 id=user 的用户，且内容必须与这张档案、专属聊天或记忆之一相符；禁止把「某人」写成另一个凭空存在的人。');
  return parts.join('\n');
}

export function buildMomentsSourceGroundingBlock({
  count = 3,
  hasChatLogs = false,
  hasMemory = false,
  hasLifeMaterial = false,
  hasAmbientMaterial = false,
  userName = '用户',
  intentDriven = false,
  chatShareRequested = false,
} = {}) {
  const n = Math.max(1, Number(count) || 3);
  const budget = [];
  if (intentDriven) {
    budget.push('- 本轮是角色主动发帖：当前私聊只解释角色为何此刻想公开表达，不默认成为正文主题，也不要求 sourceType=chat。');
    budget.push(chatShareRequested
      ? '- 角色已明确想公开聊天记录，可以使用 postKind=chat_share，但只能选取提供的真实消息编号。'
      : '- 角色没有明确要求公开聊天记录：必须使用 postKind=text，chatShareSourceLineIds 与 chatShareLines 均留空；优先写角色自己的近况、想法、兴趣或公共观察。');
  } else if (hasChatLogs) {
    budget.push(`- 至少 1 条必须扎根于作者自己的真实聊天；涉及用户时，用户只等于「${userName}」（id=user）。不能拿记忆或自由发挥替代这一条聊天素材。`);
  } else if (hasMemory) {
    budget.push(`- 当前没有可用聊天摘录，至少 1 条可扎根于作者自己的明确记忆；涉及用户时，用户只等于「${userName}」（id=user）。`);
  }
  if (hasLifeMaterial && n >= 2) {
    budget.push('- 至少 1 条可用角色近期真实生活素材（日程/旅行归来/线下档案/真实刷到内容），但只能使用该作者名下的素材。');
  }
  if (hasAmbientMaterial) {
    budget.push('- 站内微博公共话题最多 1 条；没有明确提供的标题/话题就不要自创新闻或链接。');
  }
  budget.push('- 其余可写 free_daily：只写当下低风险生活切片或情绪，不得凭空增加已发生的事件、聊天记录、新闻、具体地点或新人物。');
  return [
    '[素材落地 · 硬性来源约束]',
    '每条 post 必须填写 sourceType：chat | memory | life | relationship | ambient | free_daily。sourceType 只是内部溯源字段，不要写进正文。',
    ...budget,
    '「关系图/角色卡/世界书」可以决定动机、口吻与世界常识，但不能单独证明某件近期事件已经发生；没有聊天、记忆或生活素材佐证时，禁止把脑补写成既成事实。',
    `「某人 / 那个人」可以用来含蓄指代 id=user 的用户「${userName}」，但只能在用户档案、专属聊天或记忆能对应上时使用；不得用来凭空造人。若指其他角色，只能是关系图或聊天里真实存在的人。`,
    '只有明确要“晒聊天”的内容才使用 postKind=chat_share；sourceType=chat 只表示灵感来自聊天，不等于要展示聊天记录。晒聊天若涉及用户，必须用 chatShareSourceLineIds 选择该作者专属聊天事实里标出的真实消息编号；展示内容会由程序原样回填，禁止自行复述或改写用户原话。没有合适编号就改写为普通 text。若明确不涉及用户，也可以按角色卡/关系网合理虚构一段日常聊天，但参与者不得冒充用户或影射用户。',
  ].join('\n');
}

export const MOMENTS_MEMORY_ISOLATION_RULES = [
  '[记忆与聊天 · 角色隔离 · 硬性]',
  '每个角色只能使用 ownerId 与自己 author id 完全相同的「专属记忆/专属聊天片段」；禁止把 A 的私聊内容、A 的记忆当成 B 也知道的事。',
  '标为「仅知情/听说」的事实只能影响角色的反应，不能写成该角色自己说过、做过、在场经历过，尤其不能改写成该角色与用户的共同回忆。',
  '未标注 id 的「共同」记忆仅当该条会话确实有多方参与时才可参考；否则视为不可共享。',
  '发圈正文与评论不得引用其他角色专属聊天里的私密细节，除非该角色与发圈者确实有那条会话。',
].join('\n');

export const MOMENTS_CHAT_CONTINUITY_RULES = [
  '[近期聊天连续性 · 硬性事实]',
  '各角色专属聊天块按会话内从旧到新排列，越靠后的消息越新；这些消息是已经发生的事实，不只是口吻示例。',
  '正文或评论一旦碰到聊天里同一件具体事情（决定、约定、正在做什么、吃什么、去哪里、关系进展），必须承接最新状态；禁止像没聊过一样另提互斥方案，也禁止把旧状态覆盖新决定。',
  '私聊隐私限制的是“能否公开说出细节”，不是让角色失忆：不适合公开时可以含蓄评论或换个角度，但仍不得说出与已知事实相冲突的话。',
  '每个角色只能承接自己参与过的聊天，禁止把别人的专属聊天当成自己的记忆。',
].join('\n');

export async function buildMomentsTimeSituationBlock(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return '';
  const {
    getNowForUser,
    getAiTimeBlind,
    getUserTimezone,
    formatPromptTimeLine,
  } = await import('../time-mode.js');
  const { zonedDateProxy } = await import('../user-timezone.js');
  if (await getAiTimeBlind(uid)) return '';
  const [ts, timeZone] = await Promise.all([getNowForUser(uid), getUserTimezone(uid)]);
  const d = zonedDateProxy(ts, timeZone);
  const hour = d.getHours();
  const day = d.getDay();
  const isWeekday = day >= 1 && day <= 5;
  const isWorkHours = hour >= 9 && hour <= 18;
  const isLateNight = hour >= 23 || hour < 5;
  const lines = [
    '[时刻情境 · 对照当前时间]',
    `当前：${formatPromptTimeLine(ts, timeZone)}。`,
  ];
  if (isWeekday && isWorkHours) {
    lines.push('工作日白天：可写摸鱼、划水、午休、通勤、开会摸鱼发圈；评论区可能出现同事、上司（尤其 hiddenFromIds 漏填时）。');
  } else if (isWeekday && !isWorkHours && hour >= 6) {
    lines.push('工作日非工时段：下班路上、加班、夜宵、躺平；评论节奏比白天松。');
  } else if (!isWeekday) {
    lines.push('周末/假日：更生活化、可睡懒觉、出门玩；少写上班摸鱼除非人设是加班党。');
  }
  if (isLateNight) {
    lines.push('深夜/凌晨：适合 emo、神秘文案、网抑云；角色可能刻意 hiddenFromIds 屏蔽长辈/上司/家人——也可能忘了，导致评论区被当场抓获。');
  }
  return lines.join('\n');
}

/**
 * 朋友圈作者各自的当地钟点。绝对时刻仍来自同一条用户世界线，但生活语义按作者私聊里
 * 开启的时差设置换算，避免用户晚上八点时把当地凌晨三点的角色写成正在下班。
 */
export async function buildMomentsActorLocalTimeBlock(userId, actorIds = [], charactersMap = new Map()) {
  const uid = String(userId || '').trim();
  const ids = [...new Set((actorIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!uid || !ids.length) return '';
  const { getNowForUser, getUserTimezone } = await import('../time-mode.js');
  const {
    formatClockInTimezone,
    resolveCharacterScheduleTimezone,
  } = await import('../chat/chat-timezone.js');
  const nowTs = await getNowForUser(uid).catch(() => Date.now());
  const userTimeZone = await getUserTimezone(uid).catch(() => '');
  const rows = await Promise.all(ids.map(async (id) => {
    const character = charactersMap?.get?.(id) || null;
    const characterTimeZone = await resolveCharacterScheduleTimezone(uid, id, character).catch(() => '');
    const timeZone = characterTimeZone || userTimeZone;
    const clock = formatClockInTimezone(nowTs, timeZone);
    if (!clock) return '';
    const name = getCharacterAiContextName(character, id) || id;
    return `- ${name}（id=${id}）：当地此刻 ${clock}（${timeZone}）`;
  }));
  const lines = rows.filter(Boolean);
  if (!lines.length) return '';
  return [
    '[发圈作者当地时间 · 高优先级]',
    ...lines,
    '每条动态的作息、昼夜、上下班、是否已经睡着，必须按该条 author 自己的当地此刻判断；不得把用户手机钟点或其他作者的时区套给TA。时间戳仍是同一绝对时刻，不代表所有人墙上钟点相同。',
  ].join('\n');
}

export async function buildMomentsWorldBookBlock(user, hintText = '', { characterIds = [] } = {}) {
  const { buildWorldBookContextBlock } = await import('../world-book-store.js');
  const blob = String(hintText || '').trim();
  // characterIds 必传：绑定到具体角色的世界书靠它激活，不传的话那些书整本被过滤，
  // 表现成「朋友圈生成完全不读世界书」。
  return buildWorldBookContextBlock(user, blob, {
    worldBookMode: 'full',
    characterIds: (characterIds || []).filter(Boolean),
  }).catch(() => '');
}

/**
 * 人物关系图：角色卡登记关系 + 通讯录关系网页连线，注入朋友圈生成 prompt。
 * 这是修罗场/隔空喊话/暗搓搓炫耀等剧情内容的底层动机来源——此前这些数据只用来
 * 限制「谁能评论谁」，从没作为文本给过模型，模型根本不知道谁和谁是什么关系。
 */
export async function buildMomentsRelationshipBlock({
  userId = '',
  charMap,
  actorIds = [],
  userName = '我',
  maxLines = 22,
} = {}) {
  const ids = new Set((actorIds || []).map((x) => String(x || '').trim()).filter(Boolean));
  if (!ids.size || !charMap?.size) return '';
  const lines = [];
  const seen = new Set();
  const nameOf = (id) => {
    if (id === 'user') return String(userName || '我').trim() || '我';
    const c = charMap.get(id);
    return c ? String(c.customNickname || c.name || '').trim() : '';
  };

  // 角色卡登记的两两关系：本批 actor 作为任意一端都算相关
  for (const [cid, ch] of charMap.entries()) {
    if (!ch?.relationships || typeof ch.relationships !== 'object') continue;
    for (const [rid, rel] of Object.entries(ch.relationships)) {
      if (!ids.has(cid) && !ids.has(rid)) continue;
      const label = cleanBlock(rel).slice(0, 40);
      if (!label) continue;
      const aName = nameOf(cid);
      const bName = nameOf(rid);
      if (!aName || !bName) continue;
      const key = `${cid}>${rid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${aName} 眼中的 ${bName}：${label}`);
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }

  // 关系网页手动标注的连线（含 user 与 NPC 节点）
  try {
    const { loadRelationshipNetwork, collectGlobalRelationshipNetworkLines } = await import('../relationship-network.js');
    const net = await loadRelationshipNetwork(userId);
    const characters = Object.fromEntries(charMap);
    const netLines = collectGlobalRelationshipNetworkLines(net, {
      partnerIds: [...ids],
      characters,
      userName,
      maxEdges: Math.max(4, maxLines - lines.length),
    });
    for (const line of netLines) {
      lines.push(`- ${line}`);
      if (lines.length >= maxLines + 8) break;
    }
  } catch {
    /* ignore */
  }

  // 剧情推进中自动识别的关系变化。
  try {
    const { loadAcquaintanceLedger } = await import('../acquaintance-ledger.js');
    const ledger = await loadAcquaintanceLedger();
    for (const entry of ledger.entries || []) {
      if (!ids.has(entry.a) || !ids.has(entry.b)) continue;
      const aName = nameOf(entry.a);
      const bName = nameOf(entry.b);
      if (!aName || !bName) continue;
      lines.push(`- ${aName} 与 ${bName}：${entry.label || (entry.level === 'familiar' ? '逐渐熟悉' : '刚认识')}`);
      if (lines.length >= maxLines + 8) break;
    }
  } catch {
    /* ignore */
  }

  if (!lines.length) return '';
  return [
    '[人物关系图 · 发圈与评论的底层动机]',
    ...lines,
    '以上关系是这批朋友圈的人际暗流：谁看谁不顺眼、谁在较劲、谁暗恋谁、谁和谁穿一条裤子，决定谁会阴阳怪气、谁会拆台起哄、谁会隔空回应。写正文和评论时让这些关系自然渗出来，但禁止把关系标签本身当台词念出来（不要写「作为你的情敌」这种话）。',
  ].join('\n');
}

export async function buildMomentsMemoryBlockPerCharacter(userId, actorIds = [], opts = {}) {
  const ids = [...new Set((actorIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return '';
  const uid = String(userId || '').trim();
  const sharedData = opts.sharedData || await loadMomentsMemorySharedData(uid);
  const chunks = [];
  // 低内存 WebView 下不要同时为十几个角色复制整份记忆/聊天数组；共享只读快照并逐个整理。
  for (const id of ids) {
    const block = await buildMomentsMemoryBlock(uid, [id], { ...opts, sharedData });
    if (block) {
      chunks.push([
        `[${id} 专属记忆 · 仅 ownerId=${id} 可用]`,
        '其他发圈作者、评论者和路人不得读取；“仅知情/听说”不得改写为本人和用户共同亲历。',
        block,
      ].join('\n'));
    }
  }
  return chunks.join('\n\n');
}

export function formatMomentFactLine(fact, nameMap = new Map(), ownerId = '') {
  const entityLabel = (entityId, entityName) => {
    const id = String(entityId || '').trim();
    const name = cleanBlock(entityName)
      || (id === 'user' ? '用户' : nameMap.get(id))
      || id
      || '相关人物';
    return id ? `${name}（id=${id}）` : name;
  };
  const content = cleanBlock(fact?.content || '').slice(0, 140);
  if (!content) return '';
  const subject = entityLabel(fact?.subjectId, fact?.subjectName);
  const hasObject = !!String(fact?.objectId || fact?.objectName || '').trim();
  const object = hasObject ? entityLabel(fact?.objectId, fact?.objectName) : '';
  const type = cleanBlock(fact?.factType || 'status');
  const temporalState = resolveEffectiveTemporalState(fact);
  const temporalLabel = {
    planned: '未来计划｜尚未发生',
    ongoing: '进行中｜可自然承接',
    completed: '已结束｜只作背景，禁止重启',
    evergreen: '常驻事实',
  }[temporalState] || '时间状态未知';
  const cid = String(ownerId || '').trim();
  const knownBy = fact?.knownBy && typeof fact.knownBy === 'object' ? fact.knownBy : {};
  const level = knownBy[cid];
  const involved = !!cid && (
    String(fact?.subjectId || '').trim() === cid
    || String(fact?.objectId || '').trim() === cid
    || level === true
    || ['involved', 'shared'].includes(String(level || ''))
  );
  const knowledge = cid
    ? (involved ? `ownerId=${cid}｜当事/亲历` : `ownerId=${cid}｜仅知情/听说，禁止写成自己的经历`)
    : '归属未指定';
  return `- [${type}｜${temporalLabel}｜${knowledge}] 主体=${subject}${object ? `｜对象=${object}` : ''}：${content}`;
}

export async function buildMomentsTimeFreshnessBlock(userId, recentPosts = []) {
  const uid = String(userId || '').trim();
  if (!uid) return '';
  const {
    formatPromptTimeLine,
    formatGapHint,
    getNowForUser,
    getAiTimeBlind,
    getUserTimezone,
  } = await import('../time-mode.js');
  if (await getAiTimeBlind(uid)) return '';
  const [nowTs, timeZone] = await Promise.all([getNowForUser(uid), getUserTimezone(uid)]);
  const nowLine = formatPromptTimeLine(nowTs, timeZone);
  const staleHints = (Array.isArray(recentPosts) ? recentPosts : [])
    .slice(0, 8)
    .map((p) => {
      const delta = nowTs - Number(p.timestamp || 0);
      if (!Number.isFinite(delta) || delta < 2 * 24 * 60 * 60 * 1000) return '';
      const gap = formatGapHint(delta);
      const body = cleanBlock(p?.content || '').slice(0, 24);
      return body ? `「${body}…」约 ${gap} 前` : `一条旧动态约 ${gap} 前`;
    })
    .filter(Boolean)
    .slice(0, 4);
  return [
    '[朋友圈时刻 · 必须是现在]',
    `本批新生成的动态发生在：${nowLine}。正文按此时刻写当下生活/状态/神秘文案，勿把数天前的聊天或旧梗当成刚发生的事。`,
    staleHints.length
      ? `下列是较早的旧动态（仅供避免重复，勿复述为刚发生）：${staleHints.join('；')}`
      : '',
  ].filter(Boolean).join('\n');
}

export function buildMomentsCharacterCard(character, characterId = '') {
  if (!character) return '';
  const id = cleanBlock(characterId || character.id);
  const name = getCharacterAiContextName(character, id);
  const parts = [`【角色设定 · ${name} · id=${id}】`];
  parts.push(`性别与代词：${buildCharacterGenderRuleLine(character, id).replace(/^[-]\s*/, '')}`);
  if (character.currentRole) parts.push(`身份/关系：${cleanBlock(character.currentRole)}`);
  if (character.userRelationStatus) parts.push(`与用户关系：${cleanBlock(character.userRelationStatus)}`);
  if (character.personality) parts.push(`性格：${cleanBlock(character.personality)}`);
  if (character.speechStyle) parts.push(`说话风格：${cleanBlock(character.speechStyle)}`);
  if (character.commonEmotes) parts.push(`常用表情：${cleanBlock(character.commonEmotes)}`);
  if (character.appearancePrompt) parts.push(`生图外观（人物配图必须保留）：${cleanBlock(character.appearancePrompt).slice(0, 500)}`);
  const translation = translationProfileBrief(character.translationProfile);
  if (translation?.mode === 'full') {
    parts.push(`翻译：主要讲${translation.language || '设定里的外语'}（发圈正文与评论写外语原文，另给 zh 中文翻译）`);
  } else if (translation?.mode === 'mixed') {
    parts.push(`翻译：日常中文，偶尔蹦${translation.dialectNote || '外语/方言'}（蹦词时另给 zh）`);
  }
  const tagSnippets = getCharacterPromptTagSnippets(character.promptTags || []);
  if (tagSnippets.length) {
    parts.push(`说话标签：\n${tagSnippets.map((s) => cleanBlock(s).slice(0, 280)).join('\n')}`);
  }
  if (character.promptCorpus) parts.push(`角色资料（完整）：${cleanBlock(character.promptCorpus)}`);
  if (character.speechCorpus) parts.push(`语料库（完整）：${cleanBlock(character.speechCorpus)}`);
  if (character.notes) parts.push(`备注：${cleanBlock(character.notes)}`);
  return parts.join('\n');
}

/** Collect translation actors among moments participants for prompt injection. */
export function collectMomentsTranslationActors(charactersMap, actorIds = []) {
  const ids = [...new Set((actorIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  const list = [];
  for (const id of ids) {
    const character = charactersMap?.get?.(id);
    if (!character) continue;
    const profile = normalizeTranslationProfile(character.translationProfile);
    if (profile.mode !== 'full' && profile.mode !== 'mixed') continue;
    list.push({
      id,
      name: getCharacterAiContextName(character, id),
      translationProfile: character.translationProfile,
    });
  }
  return list;
}

export async function loadCharactersMap(actorIds = [], userId = '') {
  const ids = [...new Set((actorIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const all = await listSocialVisibleCharacters(null, { userId, excludeAnonNpc: false });
  for (const c of all) {
    if (c?.id && ids.includes(c.id)) map.set(c.id, c);
  }
  for (const id of ids) {
    if (!map.has(id)) {
      const c = await getCharacter(id, { userId }).catch(() => null);
      if (c?.id) map.set(c.id, c);
    }
  }
  return map;
}

export function buildMomentsCharacterCardsBlock(charactersMap, actorIds = []) {
  const ids = [...new Set((actorIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  const characters = ids.map((id) => charactersMap.get(id)).filter(Boolean);
  const cards = ids
    .map((id) => buildMomentsCharacterCard(charactersMap.get(id), id))
    .filter(Boolean);
  if (!cards.length) return '';
  return ['[人物设定 · 参与角色]', buildCharacterGenderRulesBlock(characters), ...cards].join('\n\n');
}

async function loadMomentsMemorySharedData(userId = '') {
  const uid = String(userId || '').trim();
  if (!uid) return { memories: [], chats: [], characters: [], posts: [], storyContinuity: null };
  const [memories, chats, characters, posts, storyContinuity] = await Promise.all([
    listMemoriesForUser(uid),
    listChatsForUser(uid).catch(() => []),
    listSocialVisibleCharacters(null, { userId: uid, excludeAnonNpc: false }).catch(() => []),
    listMomentPostsForUser(uid).catch(() => []),
    loadSocialStoryContinuitySnapshot(uid).catch(() => ({ userId: uid, events: [], sharedKnowledge: [] })),
  ]);
  return { memories, chats, characters, posts, storyContinuity };
}

export async function buildMomentsMemoryBlock(userId, actorIds = [], opts = {}) {
  const memoryLimit = Math.max(0, Number(opts.memoryLimit ?? 8) || 0);
  const factLimit = Math.max(0, Number(opts.factLimit ?? 8) || 0);
  const uid = String(userId || '').trim();
  if (!uid) return '';
  const idSet = new Set((actorIds || []).map((x) => String(x || '').trim()).filter(Boolean));
  if (idSet.size > 1) {
    const sharedData = opts.sharedData || await loadMomentsMemorySharedData(uid);
    const packets = [];
    for (const cid of idSet) {
      const block = await buildMomentsMemoryBlock(uid, [cid], {
        memoryLimit,
        factLimit,
        sharedData,
      });
      if (block) {
        packets.push([
          `[${cid} 专属记忆 · 仅 ownerId=${cid} 可用]`,
          '其他发圈作者、评论者和路人不得读取；“仅知情/听说”不得改写为本人和用户共同亲历。',
          block,
        ].join('\n'));
      }
    }
    return packets.join('\n\n');
  }
  const sharedData = opts.sharedData || await loadMomentsMemorySharedData(uid);
  const onlyActorId = [...idSet][0] || '';
  const memLines = [];
  // listMemoriesForUser 已按 timestamp 倒序；先取新摘要，避免旧剧情把刚发生的聊天盖过去。
  const mems = sharedData.memories || [];
  // 没打 characterId 标的"全局摘要"记忆是挂在某一次具体会话下的（比如某个角色私聊的整段摘要），
  // 不代表真的人人共享；只有这个会话本身就有当前这批 actor 参与时，才算得上"共同"，
  // 否则会把某个角色私聊的摘要当成公共记忆，串到完全不相关的角色生成上下文里。
  let relevantChatIds = null;
  const chats = sharedData.chats || [];
  const isolatedChatIds = new Set(
    (Array.isArray(chats) ? chats : [])
      .filter((chat) => !isEligibleMomentsChatSource(chat))
      .map((c) => String(c?.id || '').trim())
      .filter(Boolean),
  );
  if (idSet.size) {
    relevantChatIds = new Set(
      (Array.isArray(chats) ? chats : [])
        .filter(isEligibleMomentsChatSource)
        .filter((c) => (Array.isArray(c?.participants) ? c.participants : [])
          .some((p) => idSet.has(String(p || '').trim())))
        .map((c) => c.id),
    );
  }
  for (const m of mems) {
    if (memLines.length >= memoryLimit) break;
    const memoryChatId = String(m?.chatId || '').trim();
    if (memoryChatId && isolatedChatIds.has(memoryChatId)) continue;
    if (memoryChatId && relevantChatIds && !relevantChatIds.has(memoryChatId)) continue;
    const cid = String(m?.characterId || '').trim();
    if (cid) {
      if (!idSet.has(cid)) continue;
    } else if (relevantChatIds && !relevantChatIds.has(memoryChatId)) {
      continue;
    }
    const body = cleanBlock(m?.content || '').slice(0, 140);
    if (!body) continue;
    const tag = cid ? `[ownerId=${cid}]` : `[ownerId=${onlyActorId || 'unknown'}｜来源窗口共享]`;
    const ts = Number(m?.timestamp || m?.updatedAt || m?.createdAt || 0);
    const stamp = ts ? `（${new Date(ts).toLocaleDateString('zh-CN')}）` : '';
    memLines.push(`- ${tag}${stamp} ${body}`);
  }
  const facts = await listMemoryFactsForContext({
    userId: uid,
    characterIds: [...idSet],
    limit: factLimit,
  });
  const factCharacters = sharedData.characters || [];
  const factNameMap = new Map((factCharacters || []).map((character) => [
    String(character?.id || '').trim(),
    getCharacterAiContextName(character, character?.id),
  ]));
  const factLines = facts
    .filter((f) => String(f?.scope || '').trim() !== 'account_alias')
    .filter((f) => {
      const sourceIds = [f?.sourceChatId, f?.chatId]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      if (sourceIds.some((sourceId) => isolatedChatIds.has(sourceId))) return false;
      // listMemoryFactsForContext 已按 subject/object/knownBy 对当前 owner 做过知情过滤。
      // 这里不能再要求来源 chat 的固定 participants 含 owner：角色可能只在主线剧情卡中临时出场，
      // 其事实属于本人，却不属于该角色的旧私聊窗口；二次过滤会让社交生成退回旧关系阶段。
      return true;
    })
    .map((f) => formatMomentFactLine(f, factNameMap, onlyActorId))
    .filter(Boolean);
  const userPostLines = [];
  try {
    const posts = sharedData.posts || [];
    for (const p of posts) {
      if (userPostLines.length >= 4) break;
      if (String(p?.authorId || '') !== uid) continue;
      const body = cleanBlock(p?.content || '').slice(0, 80);
      const imgCount = (Array.isArray(p?.images) ? p.images : []).filter(Boolean).length;
      const imgHint = imgCount ? `（配图${imgCount}张）` : '';
      if (!body && !imgCount) continue;
      userPostLines.push(`- [用户动态] ${body || '纯配图'}${imgHint}`);
    }
  } catch {
    /* ignore */
  }
  const chunks = [];
  const storyContinuityBlock = onlyActorId
    ? buildSocialStoryContinuityBlockFromSnapshot(
      sharedData.storyContinuity || {},
      [onlyActorId],
      { limitPerActor: Math.max(0, Number(opts.eventLimit ?? 5) || 0) },
    )
    : '';
  if (storyContinuityBlock) chunks.push(storyContinuityBlock);
  if (memLines.length) chunks.push(`记忆摘录：\n${memLines.join('\n')}`);
  if (factLines.length) {
    chunks.push([
      '事实碎片（主体是事实/称呼的发起或归属者，对象是承受者；不得互换）：',
      ...factLines,
    ].join('\n'));
  }
  if (userPostLines.length) chunks.push(`近期用户朋友圈：\n${userPostLines.join('\n')}`);
  return chunks.length ? chunks.join('\n\n') : '';
}
