import { resolveGenerationMaxTokens } from './api.js';
import { chatJsonGeneration } from './chat-json-generation.js';
import { getCharacter, listCharacters } from './character-store.js';
import { listChatsForUser, listMessagesForChat } from './chat-store.js';
import { listMemoryFactsForContext } from './memory/memory-facts.js';
import { saveAliasAccount } from './alias-account-store.js';
import { isStrangerInterceptChat } from './stranger-thread-model.js';
import { loadCharacterBlockState } from './chat-block-state.js';
import { loadUserInterceptSettings } from './user-intercept-auto.js';
import { recordCharacterAliasAccountFact } from './memory/memory-facts.js';

function clean(value, max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

export function buildAliasAccountCharacterProfile(character = {}) {
  return {
    id: character.id,
    name: clean(character.realName || character.name, 80),
    gender: clean(character.gender),
    personality: clean(character.personality),
    speechStyle: clean(character.speechStyle),
    speechCorpus: clean(character.speechCorpus),
    promptCorpus: clean(character.promptCorpus),
    background: clean(character.background || character.backstory),
    currentRole: clean(character.currentRole),
    currentStatus: clean(character.currentStatus),
    userRelationStatus: clean(character.userRelationStatus || character.relationshipToUser),
    relationships: character.relationships && typeof character.relationships === 'object' ? character.relationships : {},
    notes: clean(character.notes),
  };
}

export async function generateCharacterAliasAccount({
  userId,
  characterId = '',
  intent = '',
  windowLabel = '',
  personaSeed = '',
  accountId = '',
  sourceChatId = '',
  sourceRecentMessages = [],
  signal,
  onProgress,
} = {}) {
  const uid = clean(userId);
  if (!uid) throw new Error('缺少用户档位');
  let cid = clean(characterId);
  const chats = await listChatsForUser(uid);
  const pool = (await listCharacters({ excludeAnonNpc: true, userId: uid, identityScoped: true }))
    .filter((row) => row?.id);
  const allowedCharacterIds = new Set(pool.map((row) => String(row.id)));
  if (!cid) {
    if (!pool.length) throw new Error('当前身份范围内还没有可开马甲的角色');
    cid = pool[Math.floor(Math.random() * pool.length)].id;
  } else if (!allowedCharacterIds.has(cid)) {
    throw new Error('只能为当前身份范围内的角色生成马甲');
  }
  const character = await getCharacter(cid, { userId: uid });
  if (!character) throw new Error('角色不存在');
  onProgress?.('正在读取角色近况…');
  const mainChat = chats.find((chat) => chat.type === 'private'
    && !isStrangerInterceptChat(chat)
    && (chat.participants || []).includes('user')
    && (chat.participants || []).includes(cid));
  const [recentMessages, facts, blockState, interceptSettings] = await Promise.all([
    mainChat ? listMessagesForChat(mainChat.id, 18).catch(() => []) : [],
    listMemoryFactsForContext({
      userId: uid,
      chat: mainChat || null,
      characterIds: [cid],
      limit: 10,
    }).catch(() => []),
    loadCharacterBlockState(cid, uid).catch(() => ({ blocked: false })),
    loadUserInterceptSettings(uid).catch(() => ({ preference: '' })),
  ]);
  const suppliedRecent = (Array.isArray(sourceRecentMessages) ? sourceRecentMessages : [])
    .filter((row) => !sourceChatId || String(row?.chatId || sourceChatId) === String(sourceChatId))
    .slice(-12);
  const payload = {
    character: buildAliasAccountCharacterProfile(character),
    recentChat: (suppliedRecent.length ? suppliedRecent : recentMessages.slice(-12)).map((row) => ({
      speaker: row.senderId === 'user' ? 'user' : 'character',
      text: clean(row.content, 180),
    })),
    memoryFacts: facts.map((row) => clean(row.content || row.summary, 180)).filter(Boolean),
    blockedByUser: blockState.blocked === true,
    blockReason: clean(blockState.blockReason, 160),
    userPreference: clean(interceptSettings.preference, 600),
    requestedIntent: clean(intent, 300),
    requestedWindowLabel: clean(windowLabel, 40),
    requestedPersonaSeed: clean(personaSeed, 1200),
  };
  onProgress?.('正在生成马甲…');
  const maxTokens = await resolveGenerationMaxTokens();
  const { data } = await chatJsonGeneration({
    scope: 'character-alias-account',
    messages: [{
      role: 'system',
      content: `为角色创建一个用于陌生私信的马甲账户。背景 JSON：\n${JSON.stringify(payload)}\n\n若 requestedIntent/requestedWindowLabel/requestedPersonaSeed 非空，它们是角色本轮明确提出的用途，必须完整承接、不得改成无关动机；可结合人设细化，但不能丢弃。\n\n马甲必须承载角色不愿放在大号上的感情与欲望，不能只是无聊换号聊天。优先从角色实际关系中选择：痴汉式窥伺、梦男/梦女幻想、黑粉式关注、暗恋树洞、试探用户对本人的爱、旁敲侧击、被拉黑后绕回、给大号暗中助攻，或故意勾引后因用户可能“背叛大号”而嫉妒破防。blockedByUser 与 userPreference 是重要依据。\n\n反差与人设必须同时成立：马甲可以比大号更直白、黏、阴暗、刻薄或脆弱，但要能从角色性格、经历、记忆和关系推导出来，不能套通用病娇模板。windowLabel 写 4～12 字用途标签（如「暗恋树洞」「拉黑后绕回」），用来和角色其它小号区分。personaOverlay 必须写清具体触发、见不得光的动机、与大号的反差依据，以及试探成功或失败后的心理后果。动机不够明确时宁可收敛成暗恋树洞或窥视账号，也不要生成随便搭话的小号。不要照抄匿名聊天室。\n\n要求：\n- handle 是本轮自行构思的公开账号 ID，要像真实社交账号，可含字母、数字、点或下划线；不要套固定词库或匿名昵称组合。\n- displayName、bio 是对方可见的公开资料，不得出现角色真名或直接暴露主号的信息。\n- avatarPrompt 描述这个马甲会使用的独立头像，不得照搬或绑定大号头像；可以是物件、风景、宠物、插画或不易识别的照片。\n- windowLabel 是本窗用途短标签；personaOverlay 是角色自己知道的内部动机与使用方式，不对用户显示。\n- 账户要像真实账号，不要写“我是小号”“测试账号”等自曝文案。\n- 只输出 JSON：{"handle":"","displayName":"","bio":"","avatarPrompt":"","windowLabel":"","personaOverlay":""}`,
    }, {
      role: 'user',
      content: '请按上述完整角色背景与明确用途生成本次马甲账户 JSON。',
    }],
    temperature: 0.9,
    maxTokens,
    signal,
    preferStream: true,
    onProgress,
    validate: (value) => !!clean(value?.displayName),
  });
  const account = await saveAliasAccount({
    id: clean(accountId, 180),
    ownerType: 'character',
    ownerId: cid,
    userId: uid,
    displayName: clean(data.displayName, 60),
    handle: clean(data.handle, 60),
    bio: clean(data.bio, 300),
    avatarPrompt: clean(data.avatarPrompt, 800),
    windowLabel: clean(data.windowLabel || windowLabel || intent, 40),
    personaOverlay: [
      clean(personaSeed || intent, 1200),
      clean(data.personaOverlay, 4000),
    ].filter((value, index, rows) => value && rows.indexOf(value) === index).join('\n').slice(0, 4000),
    createdBy: 'ai',
  });
  await recordCharacterAliasAccountFact({
    userId: uid,
    characterId: cid,
    accountId: account.id,
    displayName: account.displayName,
    handle: account.handle,
    motive: [account.windowLabel, account.personaOverlay].filter(Boolean).join(' · '),
    chatId: mainChat?.id || '',
  }).catch(() => null);
  return account;
}
