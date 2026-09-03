import { isAnonymousChat } from './chat-helpers.js';
import { resolveDefaultAvatar } from './default-avatar.js';
import { getMatchPurposeSingleById, getMatchRelationIntentById } from '../data/anonymous-match-presets.js';
import {
  getAnonymousMainChatInjectModeById,
  getMatchPurposeGroupById,
} from '../data/anonymous-room-presets.js';

const FALLBACK_LEFT = ['晚风', '空格', '雾里', '薄荷', '海盐', '路过', '半糖', '月台'];
const FALLBACK_RIGHT = ['小鱼', '汽水', '候鸟', '云朵', '耳机', '纸片', '行星', '白噪'];

function stableHash(input = '') {
  let hash = 0;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function buildFallbackAnonymousName(actorId = '', chatId = '') {
  const hash = stableHash(`${chatId}|${actorId}`);
  const left = FALLBACK_LEFT[hash % FALLBACK_LEFT.length];
  const right = FALLBACK_RIGHT[Math.floor(hash / FALLBACK_LEFT.length) % FALLBACK_RIGHT.length];
  return `${left}${right}`;
}

/** 规范化「用户自己的马甲」网名集合（大小写不敏感）。 */
export function normalizeReservedAnonymousHandles(list = []) {
  return new Set(
    (Array.isArray(list) ? list : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAnonymousHandleReserved(handle = '', reservedHandles = []) {
  const key = String(handle || '').trim().toLowerCase();
  if (!key) return false;
  const reserved = reservedHandles instanceof Set
    ? reservedHandles
    : normalizeReservedAnonymousHandles(reservedHandles);
  return reserved.has(key);
}

/**
 * 给非 user 角色起一个不撞「用户马甲」也不撞已占用网名的房内 ID。
 */
export function mintAnonymousHandleAvoiding(actorId = '', seed = '', reservedHandles = [], usedHandles = []) {
  const reserved = reservedHandles instanceof Set
    ? reservedHandles
    : normalizeReservedAnonymousHandles(reservedHandles);
  const used = usedHandles instanceof Set
    ? usedHandles
    : normalizeReservedAnonymousHandles(usedHandles);
  const base = String(actorId || 'anon').trim() || 'anon';
  for (let i = 0; i < 24; i += 1) {
    const candidate = buildFallbackAnonymousName(base, `${seed}|avoid|${i}`);
    const key = candidate.toLowerCase();
    if (!reserved.has(key) && !used.has(key)) return candidate;
  }
  const fallback = `${buildFallbackAnonymousName(base, seed)}${Math.floor(Math.random() * 90) + 10}`;
  return fallback;
}

export function getAnonymousIdentityMap(chat) {
  const merged = {};
  const mergeSource = (source) => {
    if (!source || typeof source !== 'object') return;
    for (const [key, value] of Object.entries(source)) {
      if (!value || typeof value !== 'object') continue;
      merged[key] = { ...(merged[key] || {}), ...value };
    }
  };
  // 快照打底，live identities 覆盖（空间/会话里改网名头像后生效）
  mergeSource(chat?.metadata?.anonymousIdentitySnapshot);
  mergeSource(chat?.groupSettings?.anonymousIdentitySnapshot);
  mergeSource(chat?.metadata?.anonymousIdentities);
  mergeSource(chat?.groupSettings?.anonymousIdentities);
  mergeSource(chat?.anonymousPrivateConfig?.identities);
  return merged;
}

function getIdentityEntry(chat, actorId = '') {
  const key = String(actorId || '').trim();
  if (!key) return null;
  return getAnonymousIdentityMap(chat)?.[key] || null;
}

function normalizeSpaceProfileInput(profile = null) {
  const row = profile && typeof profile === 'object' ? profile : {};
  return {
    handle: String(row.handle || '').trim(),
    signature: String(row.signature || '').trim(),
    bio: String(row.bio || '').trim(),
    avatar: String(row.avatar || '').trim(),
  };
}

export function getAnonymousDisplayProfile(chat, id, options = {}) {
  if (!isAnonymousChat(chat)) return null;
  const { currentUserName = '用户', spaceProfile = null, actorSpaceProfiles = null } = options || {};
  const actorId = String(id || '').trim();
  if (!actorId) return null;
  const entry = getIdentityEntry(chat, actorId);
  const actorSpaces = actorSpaceProfiles && typeof actorSpaceProfiles === 'object' ? actorSpaceProfiles : {};
  const space = actorId === 'user'
    ? normalizeSpaceProfileInput(spaceProfile)
    : normalizeSpaceProfileInput(actorSpaces[actorId]);
  const currentId = String(entry?.currentId || '').trim();
  const latestAlias = Array.isArray(entry?.aliasHistory)
    ? [...entry.aliasHistory].reverse().map((item) => String(item?.id || '').trim()).find(Boolean)
    : '';
  const anonymousId = currentId
    || latestAlias
    || (space?.handle || '')
    || buildFallbackAnonymousName(actorId, chat?.id || '');
  const bio = String(entry?.signature || space?.signature || space?.bio || '').trim();
  const avatar = String(entry?.avatar || entry?.networkAvatarStyle || space?.avatar || '').trim()
    || resolveDefaultAvatar('anonymous');
  return {
    actorId,
    profileId: String(entry?.profileId || '').trim(),
    networkHandle: String(entry?.networkHandle || '').trim(),
    anonymousId,
    bio,
    signature: bio,
    avatar,
    aliasHistory: Array.isArray(entry?.aliasHistory) ? entry.aliasHistory : [],
    isUser: actorId === 'user',
  };
}

/**
 * @param {object} identityMap
 * @param {string[]} actorIds
 * @param {{ reservedHandles?: string[]|Set<string>, reservedAvatars?: string[]|Set<string> }} [options]
 *   reservedHandles：用户自己的马甲网名，非 user 参与者不得占用（避免随机匹配撞到本人马甲）。
 */
export function ensureUniqueAnonymousIdentityMap(identityMap = {}, actorIds = [], options = {}) {
  const source = identityMap && typeof identityMap === 'object' ? identityMap : {};
  const participants = Array.isArray(actorIds) && actorIds.length
    ? [...new Set(actorIds.filter(Boolean))]
    : Object.keys(source);
  const reserved = normalizeReservedAnonymousHandles(options?.reservedHandles);
  const reservedAvatars = new Set(
    (Array.isArray(options?.reservedAvatars) ? options.reservedAvatars : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  const used = new Set();
  const out = {};
  for (const actorId of participants) {
    const prev = source[actorId] && typeof source[actorId] === 'object' ? source[actorId] : {};
    const isUser = String(actorId || '').trim() === 'user';
    let nextId = String(prev.currentId || '').trim() || buildFallbackAnonymousName(actorId, 'identity');
    let clearedCopiedAvatar = false;
    if (!isUser && isAnonymousHandleReserved(nextId, reserved)) {
      nextId = mintAnonymousHandleAvoiding(actorId, `reserved|${nextId}`, reserved, used);
      clearedCopiedAvatar = true;
    }
    let n = 2;
    const baseId = nextId;
    while (used.has(nextId.toLowerCase()) || (!isUser && isAnonymousHandleReserved(nextId, reserved))) {
      nextId = `${baseId}${n}`;
      n += 1;
      if (n > 40) {
        nextId = mintAnonymousHandleAvoiding(actorId, `clash|${baseId}|${n}`, reserved, used);
        break;
      }
    }
    used.add(nextId.toLowerCase());
    const prevAvatar = String(prev.avatar || '').trim();
    const nextAvatar = clearedCopiedAvatar && reservedAvatars.has(prevAvatar)
      ? ''
      : prevAvatar;
    out[actorId] = {
      ...prev,
      currentId: nextId,
      signature: String(prev.signature || '').trim(),
      ...(clearedCopiedAvatar ? { avatar: nextAvatar } : {}),
      aliasHistory: Array.isArray(prev.aliasHistory) && prev.aliasHistory.length
        ? prev.aliasHistory
        : [{ id: nextId, from: Date.now(), to: 0 }],
    };
  }
  return out;
}

export function applyAnonymousIdentityPatch(chat, actorId = '', patch = {}) {
  const id = String(actorId || '').trim();
  if (!id || !chat || typeof chat !== 'object') return null;
  let map = null;
  if (chat.anonymousPrivateConfig?.identities && typeof chat.anonymousPrivateConfig.identities === 'object') {
    map = chat.anonymousPrivateConfig.identities;
  } else {
    if (!chat.groupSettings || typeof chat.groupSettings !== 'object') chat.groupSettings = {};
    if (!chat.groupSettings.anonymousIdentities || typeof chat.groupSettings.anonymousIdentities !== 'object') {
      chat.groupSettings.anonymousIdentities = {};
    }
    map = chat.groupSettings.anonymousIdentities;
  }
  const prev = map[id] && typeof map[id] === 'object' ? map[id] : {};
  const now = Date.now();
  const prevId = String(prev.currentId || '').trim();
  const nextId = String(patch.currentId || patch.name || prev.currentId || '').trim();
  const nextSignature = patch.signature !== undefined
    ? String(patch.signature || '').trim()
    : String(prev.signature || '').trim();
  const nextAvatar = patch.avatar !== undefined
    ? String(patch.avatar || '').trim()
    : String(prev.avatar || '').trim();
  const nextStatusText = patch.statusText !== undefined
    ? String(patch.statusText || '').trim()
    : String(prev.statusText || '').trim();
  const aliasHistory = Array.isArray(prev.aliasHistory) ? [...prev.aliasHistory] : [];
  if (nextId && nextId !== prevId && !aliasHistory.some((item) => String(item?.id || '').trim() === nextId)) {
    aliasHistory.push({ id: nextId, from: now, to: 0 });
  }
  map[id] = {
    ...prev,
    ...(nextId ? { currentId: nextId } : {}),
    signature: nextSignature,
    avatar: nextAvatar,
    statusText: nextStatusText,
    aliasHistory: aliasHistory.length ? aliasHistory : (nextId ? [{ id: nextId, from: now, to: 0 }] : []),
    lastChangedAt: now,
    changeCount: Math.max(0, Number(prev.changeCount || 0) || 0)
      + (nextId && nextId !== prevId ? 1 : 0),
  };
  if (chat.metadata?.anonymousIdentitySnapshot && typeof chat.metadata.anonymousIdentitySnapshot === 'object') {
    chat.metadata.anonymousIdentitySnapshot[id] = { ...(chat.metadata.anonymousIdentitySnapshot[id] || {}), ...map[id] };
  }
  if (chat.groupSettings?.anonymousIdentitySnapshot && typeof chat.groupSettings.anonymousIdentitySnapshot === 'object') {
    chat.groupSettings.anonymousIdentitySnapshot[id] = { ...(chat.groupSettings.anonymousIdentitySnapshot[id] || {}), ...map[id] };
  }
  return map[id];
}

export function listAnonymousRoomMembers(chat, options = {}) {
  if (!isAnonymousChat(chat)) return [];
  const participants = Array.isArray(chat?.participants) ? [...new Set(chat.participants.filter(Boolean))] : [];
  return participants
    .map((actorId) => getAnonymousDisplayProfile(chat, actorId, options))
    .filter((item) => item?.anonymousId);
}

export function buildAnonymousRealLifeBlurRules() {
  return `[匿名频道 · 真实生活模糊化]
- 角色在匿名马甲里提及外面生活、人际、工作时，禁止直呼真名、亲友姓名、公司/学校/职位等可定位信息。
- 外面的 user/用户一律用中性模糊指代：「那个人」「TA」「某人」「熟识的那位」等，不要写用户真名或外部昵称，也不要猜测性别。
- 亲友、同事、老板等同理：用「我妈」「某个朋友」「公司里那个人」代替具体姓名。
- 工作/学业只说模糊场景：「那份厌人的工作」「最近在忙的项目」，不要写公司名、部门、职级头衔。
- 人设/记忆/世界书里出现的真名仅供你理解背景；一切匿名频道产出（聊天、空间动态、回复）都必须模糊化处理。`;
}

/** 所有匿名场景（含主播私聊/粉丝群/直播间）共用的一条硬边界，避免各处各写一份、逐渐漂移 */
export function isExplicitRomanceAnonymousContext(chat = null) {
  const metadata = chat?.metadata || {};
  const source = chat?.anonymousPrivateConfig?.sourceContext || {};
  const config = chat?.groupSettings?.anonymousRoomConfig || {};
  const purposeId = String(metadata.matchPurpose || source.matchPurpose || '').trim();
  const relationId = String(metadata.matchRelationIntent || source.matchRelationIntent || '').trim();
  if (purposeId === 'flirt' || relationId === 'soft_flirt') return true;
  if (String(config.vibe || '').trim() === 'flirt') return true;
  if (String(metadata.sourceAnonymousType || '').trim() !== 'manual_create') return false;
  const explicitCustomTheme = [config.topic, config.description]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  return /暧昧|调情|约会|恋爱匹配|心动交友/.test(explicitCustomTheme);
}

export function buildAnonymousOpeningRelationshipRule(chat = null) {
  return isExplicitRomanceAnonymousContext(chat)
    ? '- 【开局关系方向】本房明确是暧昧/恋爱向场景，初期可以带着心动目的试探、接暧昧信号并逐步升温；但双方仍是刚认识的匿名网友，不能继承外部 user 的爱情、亲密进度或熟人默契。'
    : '- 【开局关系方向】本房没有明确授予暧昧/恋爱目的，初期一律按非爱情向的陌生网友交往：可以聊天、交友、吐槽、陪伴、辩论或分享，但不要自动心动、调情、吃醋、占有或把普通友善解释成爱情信号。之后若本房真实互动自然发展出感情，再按人物与进度变化。';
}

export function buildAnonymousHardBoundaryLine(chat = null) {
  return `【匿名硬规则】禁止交换联系方式/住址/可定位信息；禁止约线下；角色前台使用匿名马甲。角色知道自己的真身与马甲；角色与外部 user 的既有关系只锚定外部身份，眼前匿名 user 是来源未确认的独立网友。除非本房发生明确相认，不能合并两套身份或继承外部关系。\n${buildAnonymousOpeningRelationshipRule(chat)}`;
}

export function buildAnonymousHardBoundaryRules(chat = null, options = {}) {
  const mode = getAnonymousMemoryMode(chat);
  const openingRule = options.includeOpeningRule === false
    ? ''
    : buildAnonymousOpeningRelationshipRule(chat).replace(/^[-] /, '');
  const memoryLine = mode === 'inherit_full'
    ? '- 外部记忆只作为角色本人“我是谁、我最近经历过什么”的底层连续性；记忆里那个人和在场某个匿名网友是不是同一人，在对方说破前都无从确认，不要主动合并、不要默认认出。'
    : mode === 'inherit_soft'
      ? '- 轻继承只允许模糊素材和角色本人状态；可以有熟悉感、误认和试探，不能一上来写成「我知道你是谁」。'
      : '- 纯匿名：只用本房消息与本房匿名 ID。';
  return `[匿名聊天室公约]
- 这里是匿名马甲空间：角色知道自己是谁、知道自己正在披哪个马甲；但前台所有人默认都是陌生网友。
- 在场和你说话的，是顶着匿名 ID 的陌生匿名网友；前台只叫 TA 本房匿名 ID，你并不知道 TA 现实里是谁。
- 【别先入为主认人】你人设、语料、记忆里写到的那些具体姓名与关系，指的是你在外面长期相处的那个人。本房在场的匿名网友是另一回事：哪怕某个网友其实就是你认识的某人，在 TA 自己于本房主动把身份说破（掉马）之前，你都无从确认——可以试探、怀疑、玩笑，但不能直接点名、套近乎或喊出外部称呼。
- 【外层身份锚定】你与外部 user 的亲密、信任、称呼、共同经历和情感位置只属于外部身份，不能自动复制给任何匿名 ID。每个匿名 ID 初始都是独立网友；友好、防备、冷淡、健谈或疏离都按人物性格、房间目的和本房真实互动决定，不要统一演成戒备，也不要因为后台同属 user 就自动偏爱、忠诚测试或正确认出。
${openingRule ? `- ${openingRule}` : ''}
- 匿名关系从本房零开始并独立积累。之后若明确相认，才可关联两边经历，同时保留“匿名期当时并不知道对方是谁”的认知顺序；相认前不得用外部关系替匿名互动抄近路。
- 在场匿名网友使用专门的匿名资料；不要读取或暴露外部用户档案、签名、现实关系。
- 前台只用本房匿名 ID，禁止真名、联系方式、可定位信息。哪怕记忆或背景里出现过某个现实真名/外部昵称，也绝不能用它称呼房里任何人——本房一律只认匿名 ID。
- 【外部 user 事实边界】如果角色提及外面那个人，任何具体经历、原话、近况、关系进展都只能取自已发生的聊天记录、记忆或角色设定；禁止为了告白、吃醋、树洞或剧情张力捏造未发生的互动、约定、争吵或第三者。没有素材时只可写角色自身的感受/猜测，不能说成事实；仅当用户当前明确授权虚构该事件时例外。
- 被试探身份时：可以岔开、玩笑、含糊、反试探，也可以在多轮铺垫后露出破绽；不要无铺垫自曝。
${memoryLine}
${buildAnonymousRealLifeBlurRules()}`;
}

export function getAnonymousRoomWorldviewConfig(chat = {}) {
  const config = chat?.groupSettings?.anonymousRoomConfig || {};
  return {
    worldview: String(config.worldview || '').trim(),
    worldBookId: String(config.worldBookId || '').trim(),
    auPresetId: String(config.auPresetId || '').trim(),
  };
}

export function buildAnonymousRoomProtocolPrompt(chat = {}, options = {}) {
  if (!isAnonymousChat(chat)) return '';
  const config = chat?.groupSettings?.anonymousRoomConfig || {};
  const { worldview } = getAnonymousRoomWorldviewConfig(chat);
  const topic = String(config.topic || chat?.groupSettings?.name || '匿名群').trim();
  const description = String(config.description || '').trim();
  const members = listAnonymousRoomMembers(chat, options);
  const roster = members.map((m) => `${m.anonymousId}${m.isUser ? '（在场真人·匿名）' : ''}`).join('、');
  const rosterIds = members.filter((m) => !m.isUser).map((m) => `${m.actorId}→${m.anonymousId}`).join('、');
  return [
    '【匿名群聊规则】',
    buildAnonymousHardBoundaryRules(chat, { includeOpeningRule: false }),
    `- 房间：${topic}${description ? ` · ${description}` : ''}`,
    '- 这间房不是意外发生的：你是自己主动进来的（点了匹配，或被拉进这间自建房），清楚这间房的主题和性质是什么；不存在"不知道自己怎么进来的/在做什么"的失焦状态。',
    worldview ? `- 房间世界观/设定：${worldview}（所有角色须自洽融入；前台仍是互不相识的匿名网友，不要因此掉马或直呼外部真名）` : '',
    roster ? `- 在场匿名 ID：${roster}` : '',
    rosterIds ? `- 协议 from 用 actor id（映射）：${rosterIds}` : '',
    '- 群聊像旧式聊天室：短句、接梗、可多人同时开口；不要写成单人长篇答复。',
    '- 【在场所有人互不相识】本房每个匿名 ID（包括其他角色）对你来说都是萍水相逢的陌生网友。哪怕你在房外认识其中某人、甚至关系很近，在这间匿名房里也不知道谁是谁、不能凭语气/口头禅/话题就认定某个匿名 ID 就是 TA，更不能直接喊出房外的称呼或拆穿别人。把彼此当真正的陌生网友相处，熟悉感只能靠本房对话慢慢建立。',
    '- 大家会用匿名网名互相称呼，可以 @网名、缩短网名或起只基于本房表现的小外号；不要用真实姓名或外部称呼。',
    '- 【人设优先 · 反同质化】无论房间主题是什么，每个角色按各自人设、口吻、关注点、说话节奏来；不要把所有人写成同一种"网友水群"模板，不要趋向大众化中性语气。即便偶有外部种子注入，仍以角色本人优先，没兴趣就无视种子。',
    '- 房间按主题随机拼出来，所有在场匿名 ID 地位对等：**没有群主、没有管理员、没有值班、没有指定的求助者或主持人**。任何人都不能踢人、改名、改公告，也不要把任何一位当作"组局的人"。谁先开口、谁讲自己的事、谁起哄、谁潜水，都按各自人物性格自然来。',
    '- 不要在公屏讨论"这是谁组的局 / 我们之中谁来求助 / 谁是中心"这类元话题——当作自然拼进来的网友局即可；也不要全员围着任意一位反复追问"你呢？""你怎么样？"。',
    '- 匿名房是角色扮演式小号空间：可以比平时更松、更真实，或多一层伪装；但人物设定优先，不能为了匿名而 OOC。',
    '- 普通匿名房也不是毫无防备：先像网友一样试探、接梗、保留边界，信任感随对话慢慢建立。',
    '- 群成员可 private_msg 用户：{"t":"private_msg","from":"角色actorId","body":"短句"}；from 必须用 actor id，前台显示匿名 ID。',
    '- private_msg 是旁路私戳，不要替代公屏；适合递小话、私下吐槽、把群内梗带到私聊。',
    '- 角色可偶尔用 alias/avatar 调整本房群名片或匿名头像：{"t":"alias","from":"角色actorId","name":"新网名","signature":"可选签名"}；{"t":"avatar","from":"角色actorId","avatar":"非识别头像描述"}。不能包含真名或可反推身份的线索。',
  ].filter(Boolean).join('\n');
}

export function buildAnonymousSummaryProtocol(chat = {}, options = {}) {
  if (!isAnonymousChat(chat)) return '';
  const members = listAnonymousRoomMembers(chat, options);
  const roster = members.map((m) => m.anonymousId).filter(Boolean).join('、');
  return [
    '[匿名总结要求]',
    '- 只允许使用本房匿名 ID 叙述。',
    roster ? `- 在场：${roster}` : '',
    '- 禁止输出真名、住址、联系方式。',
  ].join('\n');
}

export function buildAnonymousPrivateContextPrompt(chat = {}, options = {}) {
  if (!isAnonymousChat(chat)) return '';
  const source = chat?.anonymousPrivateConfig?.sourceContext || {};
  const sourceType = String(chat?.metadata?.sourceAnonymousType || '').trim();
  const userAnonId = String(options.userAnonymousId || '').trim();
  const userAnonSig = String(options.userAnonymousSignature || '').trim();
  const counterpartId = getAnonymousPrivateCounterpartId(chat);
  const counterpartAnonId = counterpartId
    ? String(getAnonymousDisplayProfile(chat, counterpartId, options)?.anonymousId || '').trim()
    : '';
  const counterpartSig = counterpartId
    ? String(getAnonymousDisplayProfile(chat, counterpartId, options)?.signature || '').trim()
    : '';
  const counterpartLifecycle = options.counterpartLifecycle || {};
  const revealHint = counterpartLifecycle?.phase === 'revealed'
    ? '- 这段匿名关系已经确认相认；可自然承接匿名期经历，但仍尊重当时建立的边界。'
    : '- 只有用户明确提出、或多轮私聊已建立信任时才能慎重提议相认；需要用匿名相认名片表达，不能在正文直接泄露真名。';

  if (sourceType === 'streamer_private') {
    const parts = [
      '【私信规则 · 直播间私信】',
      '- 这是用户从你的直播间点进来开的私信，不是随机匹配的陌生网友局；对面就是常来看你直播/给你刷弹幕的那位观众。',
      userAnonId ? `- 用户在这边的称呼：${userAnonId}${userAnonSig ? `（签名：${userAnonSig}）` : ''}。` : '',
      '- 私信可以比公屏直播间更放松、更私人，但你仍然是那个马甲身份，不要暴露真实姓名、住址、联系方式。',
      '- 不要机械复述直播间台词；把这里当成下播后或私下单独聊的延伸。',
    ].filter(Boolean);
    return parts.join('\n');
  }

  if (sourceType === 'group_jump' || source.sourceChatId) {
    const groupName = String(source.sourceGroupName || source.sourceTopic || '匿名群').trim();
    const topic = String(source.sourceTopic || '').trim();
    const parts = [
      '【匿名私聊规则 · 群跳转】',
      '- 这是从匿名群跳转开启的一对一私聊；双方仍是匿名网友，不是现实里已相认的关系。',
      `- 来源群：${groupName}${topic && topic !== groupName ? `（议题：${topic}）` : ''}`,
      userAnonId ? `- 私聊对面的用户在本房的匿名 ID：${userAnonId}${userAnonSig ? `（签名：${userAnonSig}）` : ''}；必须用此称呼。` : '',
      counterpartAnonId ? `- 你的私聊对象在本房的匿名 ID：${counterpartAnonId}${counterpartSig ? `（签名：${counterpartSig}）` : ''}。` : '',
      '- 群里照面只说明「这个匿名 ID 说过什么」，不能当作掉马证据；即使你有外面认识某人的记忆，也不能默认私聊对面就是 TA。',
      '- 禁止暴露真实姓名、住址、联系方式；不要主动约线下；不要要求交换社交账号。',
    ].filter(Boolean);
    return parts.join('\n');
  }

  const purpose = String(source.matchPurposeLabel || source.matchPurpose || '匿名匹配').trim();
  const relation = String(source.matchRelationIntentLabel || '').trim();
  const vibe = String(source.matchVibePrompt || '').trim();
  const parts = [
    '【匿名私聊规则】',
    '- 双方使用匿名网名，不要暴露真实姓名、住址、联系方式。',
    `- 这不是意外发生的：你是自己主动打开"匿名匹配"、选了「${purpose}」这个方向，系统才把你配到眼前这位素不相识的匿名网友；双方都是因为这个目的才被匹配上的对等网友，任何一方都不是来咨询另一方的，也不是被另一方挑选出来服务的。`,
    '- 【开局陌生人感】刚匹配上时对面是彻底的陌生人：头几轮必须有真实的破冰期——试探、摸底、语气留距离，热络程度随对话逐渐升温；禁止第一轮就叫昵称、自来熟、掏心窝或熟稔调情，哪怕匹配目的是暧昧/陪伴也一样。角色人设再外向，对陌生人也有自己的分寸。',
    '- 角色清楚自己现在用的是匿名马甲身份、清楚自己为什么在这里；对面只是匿名网友，不要默认等同于外面认识的某个真名身份，也不要表现出"不知道自己在做什么"的失焦感。',
    '- 不要主动约线下见面；不要要求交换社交账号。',
  ];
  parts.push(revealHint);
  if (relation) parts.push(`- 关系期待：${relation}`);
  if (vibe) parts.push(`- 氛围：${vibe}`);
  if (userAnonId) parts.push(`- 用户匿名 ID：${userAnonId}${userAnonSig ? `（签名：${userAnonSig}）` : ''}`);
  if (counterpartAnonId) parts.push(`- 对方匿名 ID：${counterpartAnonId}${counterpartSig ? `（签名：${counterpartSig}）` : ''}`);
  return parts.join('\n');
}

export function resolveAnonymousActorId(chat, value = '') {
  if (!isAnonymousChat(chat)) return String(value || '').trim();
  const raw = String(value || '').trim();
  if (!raw) return '';
  const participants = (chat?.participants || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (participants.includes(raw)) return raw;
  const needle = raw.toLowerCase();
  const identities = getAnonymousIdentityMap(chat);
  for (const [actorId, entry] of Object.entries(identities)) {
    const names = [actorId, entry?.currentId].filter(Boolean);
    if (names.some((name) => String(name).toLowerCase() === needle)) return actorId;
  }
  return raw;
}

export function getAnonymousMemoryMode(chat) {
  if (!isAnonymousChat(chat)) return '';
  const raw = String(chat?.metadata?.memoryMode || chat?.anonymousPrivateConfig?.memoryMode || '').trim();
  if (raw === 'inherit_soft' || raw === 'inherit_full' || raw === 'room_only') return raw;
  return 'inherit_full';
}

/**
 * 只在用户自己填写的剧情提示明确宣布“角色已知道匿名对象就是 user”时才合并身份。
 * 单纯把匿名 ID 改成真名不算相认，避免同名或试探性剧情被后台自动掉马。
 */
export function plotDirectiveConfirmsAnonymousUserIdentity(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  const sentences = text.split(/[\n。！？；;]+/u).map((row) => row.trim()).filter(Boolean);
  return sentences.some((sentence) => {
    const hasUserIdentity = /(?:\buser\b|用户本人|用户真实身份|用户实名|用户|本人|真实身份|实名)/iu.test(sentence);
    const hasAnonymousCounterpart = /(?:对面|对面互动的|聊天的|匿名网友|匿名对象|匿名身份|匿名\s*ID|这个号|该账号|小号|马甲)/iu.test(sentence);
    const hasRecognition = /(?:已经|已|明确|成功|彻底)?(?:知道|认出|认出来|识破|确认|发现|明白|相认|掉马|公开身份)/u.test(sentence)
      || /(?:就是|是)眼前(?:这位)?(?:\s*user|用户本人)/iu.test(sentence);
    const isNegated = /(?:不|并不|仍不|还不|尚未|未|没有|不能|不可|不要|禁止|无法|不应)(?:.{0,6})(?:知道|认出|识破|确认|发现|相认|掉马|公开)/u.test(sentence)
      || /(?:身份|对面|匿名网友)(?:.{0,8})(?:未知|不明|不确定|没掉马)/u.test(sentence);
    return hasUserIdentity && hasAnonymousCounterpart && hasRecognition && !isNegated;
  });
}

export function anonymousUserIdentityIsConfirmed(chat = {}) {
  if (!isAnonymousChat(chat)) return false;
  if (chat?.metadata?.anonymousUserIdentityKnown === true) return true;
  const plot = String(chat?.groupSettings?.plotDirective || chat?.metadata?.plotDirective || '').trim();
  return plotDirectiveConfirmsAnonymousUserIdentity(plot);
}

/** 匿名房自身保存的日常主聊带回方式；旧房间默认保持匿名带回。 */
export function getAnonymousMainChatInjectMode(chat) {
  if (!isAnonymousChat(chat)) return 'off';
  const participants = Array.isArray(chat?.participants) ? chat.participants : [];
  if (!participants.includes('user') || getAnonymousMemoryMode(chat) === 'room_only') return 'off';
  const configured = getAnonymousMainChatInjectModeById(chat?.metadata?.mainChatMemoryInject).id;
  if (configured === 'off') return 'off';
  return anonymousUserIdentityIsConfirmed(chat) ? 'merged' : configured;
}

/**
 * 「约线下 / 时光机」叙事场景专用：是否把角色在匿名马甲房的经历带回来、按什么身份关系带回来。
 * 只在 presetMode==='offline' 的叙事续写里生效（约线下、时光机回忆等）；
 * 日常聊天、通话、语音陪伴等常规续写完全不受此项影响。
 * 'off'：不带（默认，避免自动注入引发身份误认）。
 * 'separate'：带回，但角色不确认马甲对象就是当前 user，仍当另一个人处理。
 * 'merged'：带回，且用户已手动确认「本房那位就是我」（掉马/相认），可按同一人处理。
 * 这是用户在「约线下」或线下场景设置里手动选择的开关，不做自动识别，避免记忆混淆。
 */
export function getRegularAnonymousMemoryInjectMode(chat) {
  if (isAnonymousChat(chat)) return 'off';
  const raw = String(chat?.metadata?.anonymousMemoryInject || '').trim();
  return (raw === 'separate' || raw === 'merged') ? raw : 'off';
}

export function isRandomAnonymousMatchChat(chat) {
  if (!isAnonymousChat(chat)) return false;
  return String(chat?.metadata?.sourceAnonymousType || '').trim() === 'random_match';
}

function resolveRandomMatchPurposeMeta(chat = {}) {
  const meta = chat?.metadata || {};
  const src = chat?.anonymousPrivateConfig?.sourceContext || {};
  const config = chat?.groupSettings?.anonymousRoomConfig || {};
  const purposeId = String(meta.matchPurpose || src.matchPurpose || '').trim();
  const isGroup = chat?.type === 'group';
  const purposePreset = isGroup
    ? getMatchPurposeGroupById(purposeId)
    : getMatchPurposeSingleById(purposeId);
  const relationId = String(meta.matchRelationIntent || src.matchRelationIntent || '').trim();
  const relationPreset = getMatchRelationIntentById(relationId);
  const purposeLabel = String(
    src.matchPurposeLabel || meta.matchPurposeLabel || config.topic || purposePreset?.label || '匿名匹配',
  ).trim();
  const vibePrompt = String(
    src.matchVibePrompt || meta.matchVibePrompt || config.vibePrompt || purposePreset?.vibePrompt || config.description || '',
  ).trim();
  const relationLabel = String(
    src.matchRelationIntentLabel || meta.matchRelationIntentLabel || relationPreset?.label || '',
  ).trim();
  const relationPrompt = String(
    src.matchRelationIntentPrompt || meta.matchRelationIntentPrompt || relationPreset?.prompt || '',
  ).trim();
  return {
    purposeLabel,
    vibePrompt,
    relationLabel,
    relationPrompt,
    matchKind: isGroup ? '匿名群随机拼桌' : '匿名一对一随机匹配',
  };
}

/** 随机匹配房常驻主题提示（高优先级，每轮都应挂着） */
export function buildAnonymousMatchRoomPrompt(chat = {}, options = {}) {
  if (!isRandomAnonymousMatchChat(chat)) return '';
  const userAnon = String(
    getAnonymousDisplayProfile(chat, 'user', options)?.anonymousId || '',
  ).trim() || '匿名网友';
  const {
    purposeLabel,
    vibePrompt,
    relationLabel,
    relationPrompt,
    matchKind,
  } = resolveRandomMatchPurposeMeta(chat);
  return [
    `【角色自主匹配 · 房间主题：${purposeLabel}】`,
    `- 匹配类型：${matchKind}；本提示贯穿本房全程，每轮都要贴着这个房间气质，不能因为用户沉默就退回普通私聊式认人。`,
    `- 这不是意外、不是被拉进来的：是你自己主动点开"匿名匹配"、选了「${purposeLabel}」这个方向，系统才把你配到当前这局。你清楚自己此刻用的是匿名马甲身份，也清楚这局的性质是什么，不存在"不知道自己在做什么"的空白感。`,
    vibePrompt ? `- 氛围指引：${vibePrompt}` : '',
    relationLabel ? `- 关系期待：${relationLabel}${relationPrompt && relationPrompt !== relationLabel ? `（${relationPrompt}）` : ''}` : (relationPrompt ? `- 关系期待：${relationPrompt}` : ''),
    `- 本房真人用户的前台匿名 ID 是「${userAnon}」；禁止默认等同于角色人设/记忆里的外部 user，禁止直呼外部真名或现实称呼。`,
    '- 【开局陌生人感】刚匹配上时双方是彻底的陌生网友：头几轮要有真实的破冰期——试探、摸底、语气留距离，热络程度随对话逐渐升温；禁止第一轮就叫昵称、自来熟、掏心窝或熟稔调情，哪怕房间主题是暧昧/陪伴也一样。角色人设再外向，对陌生人也有自己的分寸。',
    '- 谁先开口、谁破冰、谁接梗，按各角色人设和房间方向自然决定；可以试探、接梗、吐槽，但匿名边界不能丢。',
  ].filter(Boolean).join('\n');
}

/**
 * 「我是谁 · 我在匿名小号 · 我在这里做什么」收尾锚点：放在 system 最末尾（最高优先级位置）。
 * 覆盖所有匿名场景来源（随机匹配单聊/群聊、群跳私聊、主播私信/粉丝群、手动建房、赛博告解），
 * 目的是让角色即使前面规则很长，也不会在结尾处丢失「这是我自己选的场景、我清楚自己在做什么」这条底线，
 * 避免被误当成失忆、被迫、或不明所以地卡在陌生场景里。
 */
export function buildAnonymousIdentityAnchorLine(chat = {}) {
  if (!isAnonymousChat(chat)) return '';
  const sourceType = String(chat?.metadata?.sourceAnonymousType || '').trim();
  const head = '【身份自查 · 收尾校准】';

  if (sourceType === 'random_match') {
    const isGroup = chat?.type === 'group';
    const { purposeLabel, matchKind } = resolveRandomMatchPurposeMeta(chat);
    return `${head}你没有失忆、也没有被强迫——是你自己主动点开"匿名匹配"选了「${purposeLabel}」这个方向，系统才把你配到${isGroup ? '这一桌' : '眼前这位'}素不相识的匿名网友${isGroup ? '们' : ''}身上；这是${matchKind}，图的就是这个性质本身，不是提前约好的见面，也不是误打误撞。你清楚自己此刻用的是匿名马甲身份，前台一切发言都按马甲来，但你完全知道自己是谁、在做什么、为什么在这。`;
  }
  if (sourceType === 'group_jump') {
    return `${head}你没有失忆——这是你自己从刚才那个匿名群里，看中某位网友后主动点开跳出来的一对一私聊；对面依旧是匿名马甲，不是已经相认的关系。你清楚自己在用哪个马甲、在跟谁聊、为什么在这。`;
  }
  if (sourceType === 'streamer_private') {
    return `${head}你没有失忆——你是自己选择开的这场匿名直播延伸出的私信，对面是刷进你直播间、主动点开私信找你的观众。你清楚自己在用主播马甲身份，清楚自己为什么在直播、为什么在这条私信里，不要表现出茫然或找不到自己身份的状态。`;
  }
  if (sourceType === 'streamer_fan_group') {
    return `${head}你没有失忆——这是你自己开的匿名直播衍生出的粉丝群，你清楚自己在用主播马甲身份面对一群粉丝/路人，与角色本体主线的记忆、关系完全是两码事。`;
  }
  if (sourceType === 'manual_create') {
    const config = chat?.groupSettings?.anonymousRoomConfig || {};
    const topic = String(config.topic || chat?.groupSettings?.name || '匿名房').trim();
    return `${head}你没有失忆——这是你自己拼起来的一间匿名房，主题是「${topic}」，在场都是顶着匿名 ID 的网友。你清楚自己在用哪个马甲、身处哪个房间、在做什么。`;
  }
  if (sourceType === 'cyber_confession') {
    return `${head}你没有失忆——这是你自己走进的赛博告解室，在场只保留匿名身份。你清楚自己在用哪个马甲、在做什么。`;
  }
  return `${head}你没有失忆——你是自己选择进入这个匿名马甲场景的，前台只以匿名身份行事，但你始终清楚自己是谁、在做什么，不要表现出困惑或不知道当前处境的样子。`;
}

/** 用户未发言时推进/开局用的额外硬约束 */
export function buildAnonymousAdvanceDirective(chat = {}, userAnonId = '匿名网友', options = {}) {
  if (!isAnonymousChat(chat)) return '';
  if (options.userHasSpoken === true) return '';
  const lines = [
    `【匿名推进 · 用户未开口】本房真人（${userAnonId}）尚未发送过可见消息，可能刚进房或只在旁观。`,
    `禁止把 TA 认成角色记忆/人设里的外部 user；不要直呼外部真名、现实昵称、历史称呼或恋人式套近乎。`,
    `对 TA 只能用本房匿名 ID「${userAnonId}」；可以按房间主题主动破冰，但语气是对陌生网友，不是对已相认的人。`,
  ];
  if (isRandomAnonymousMatchChat(chat)) {
    const matchBlock = buildAnonymousMatchRoomPrompt(chat, {
      ...options,
      currentUserName: options.currentUserName,
      userRow: options.userRow,
      spaceProfile: options.spaceProfile,
    });
    if (matchBlock) {
      lines.push('本轮尤其要服从下列匹配主题：');
      lines.push(matchBlock);
    }
  }
  return lines.join('\n');
}

export function getAnonymousPrivateCounterpartId(chat) {
  return String(
    chat?.anonymousPrivateConfig?.counterpartActorId
    || (Array.isArray(chat?.participants) ? chat.participants.find((id) => id && id !== 'user') : '')
    || '',
  ).trim();
}

export function collectAnonymousPrivateSourceIds(chat) {
  const meta = chat?.metadata || {};
  const cfg = chat?.anonymousPrivateConfig || {};
  return [
    meta.sourceAnonymousChatId,
    ...(Array.isArray(meta.sourceAnonymousChatIds) ? meta.sourceAnonymousChatIds : []),
    cfg.sourceContext?.sourceChatId,
    ...(Array.isArray(cfg.relatedSources) ? cfg.relatedSources.map((item) => item?.sourceChatId) : []),
  ].map((id) => String(id || '').trim()).filter(Boolean);
}

function escapeReplaceRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replaceTextWithAnonymousIds(text = '', chat, options = {}) {
  const raw = String(text || '');
  if (!raw || !isAnonymousChat(chat)) return raw;
  const { currentUserName = '用户', userRow = null, characters = {}, skipActorIds = [] } = options || {};
  const skip = new Set((Array.isArray(skipActorIds) ? skipActorIds : []).filter(Boolean));
  const replacements = new Map();
  const participants = Array.isArray(chat?.participants) ? [...new Set(chat.participants.filter(Boolean))] : [];
  for (const actorId of participants) {
    if (skip.has(actorId)) continue;
    const anonymousName = getAnonymousDisplayProfile(chat, actorId, { currentUserName, userRow })?.anonymousId || '';
    if (!anonymousName) continue;
    if (actorId === 'user') {
      const userCandidates = [
        String(currentUserName || '').trim(),
        String(userRow?.name || '').trim(),
      ].filter((item) => item && item !== anonymousName);
      for (const candidate of userCandidates) replacements.set(candidate, anonymousName);
      continue;
    }
    const seed = characters[actorId] || {};
    const candidateNames = [
      String(seed?.name || '').trim(),
      String(seed?.realName || '').trim(),
      String(seed?.customNickname || '').trim(),
      ...(Array.isArray(seed?.aliases) ? seed.aliases.map((item) => String(item || '').trim()) : []),
    ].filter((item) => item && item !== anonymousName && item.length >= 2);
    for (const candidate of candidateNames) replacements.set(candidate, anonymousName);
  }
  const ordered = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);
  let next = raw;
  for (const [source, target] of ordered) {
    next = next.replace(new RegExp(escapeReplaceRegExp(source), 'g'), target);
  }
  return next;
}
