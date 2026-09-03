import { resolveGenerationMaxTokens } from './api.js';
import { chatJsonGeneration } from './chat-json-generation.js';
import { listCharacters } from './character-store.js';
import { get, put } from './db.js';
import { listChatsForUser, listMessagesForChat } from './chat-store.js';
import { isAnonymousChat } from './chat-helpers.js';
import { ensureLightweightNpc } from './lightweight-npc.js';
import { listMemoryFactsForContext } from './memory/memory-facts.js';
import {
  isCharacterAliasBlockedByUser,
  isStrangerInterceptChat,
} from './stranger-thread-model.js';
import { persistAliasContactEvent } from './chat/marshmallow-alias-contact.js';
import { ensureDefaultUser } from './user-slot.js';
import { loadCharacterBlockState } from './chat-block-state.js';
import {
  getAliasAccount,
  listCharacterAliasAccountsForUser,
} from './alias-account-store.js';

const STATE_KEY_PREFIX = 'userInterceptAuto:';
export const USER_INTERCEPT_AUTO_CHECK_MS = 60 * 60 * 1000;
export const DEFAULT_USER_INTERCEPT_SETTINGS = Object.freeze({
  enabled: false,
  intervalHours: 72,
  batchSize: 2,
  /** 来源构成：旧档位会按原来的两个开关迁移到对应模式 */
  sourceMode: 'character',
  /** 角色马甲的新旧策略：balanced 会在可行时兼顾续旧与开新 */
  aliasStrategy: 'balanced',
  /** 关闭普通陌生来信时，仅允许已有角色开马甲 */
  charactersOnly: true,
  /** 与普通陌生来信独立：允许生成纠缠、越界搭讪等陌生骚扰 */
  allowStrangerHarassment: false,
  preference: '',
  activeAccountId: '',
  preferredCharacterIds: Object.freeze([]),
});
const INTERCEPT_CONTEXT_BOUNDARY_RULES = [
  '【小号窗口连续性·最高优先级】',
  '- privateContext.contextMode=alias_thread_continuity 时，recentChat 才是当前这个马甲线程的历史，可以自然续聊。',
  '- privateContext.contextMode=motive_only 时，这是一个全新的独立陌生窗口；memoryFacts 只用于决定角色为什么开小号、试探什么与采用什么语气，不是当前窗口的上一轮对话。',
  '- motive_only 下禁止直接回答、接续或复述大号私聊与其它窗口的话；禁止使用“继续刚才”“你刚说”“还是那个话题”等把新窗口伪装成旧窗口延续的表达。',
  '- 匿名聊天室、其它马甲窗口和其它角色的原文均不属于当前窗口；不得自行补回或混写。',
].join('\n');
let inFlight = false;
const USER_INTERCEPT_SOURCE_MODES = new Set([
  'character',
  'character_stranger',
  'character_harass',
  'mixed',
  'stranger',
  'harass',
]);
const USER_INTERCEPT_ALIAS_STRATEGIES = new Set(['balanced', 'reuse', 'new']);

function clean(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

export function normalizePreferredCharacterIds(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const id = clean(raw, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 48) break;
  }
  return out;
}

export function normalizeUserInterceptSourceMode(value = '', legacy = {}) {
  const mode = clean(value, 40);
  if (USER_INTERCEPT_SOURCE_MODES.has(mode)) return mode;
  const ordinary = legacy.charactersOnly === false;
  const harassment = legacy.allowStrangerHarassment === true;
  if (ordinary && harassment) return 'mixed';
  if (ordinary) return 'character_stranger';
  if (harassment) return 'character_harass';
  return DEFAULT_USER_INTERCEPT_SETTINGS.sourceMode;
}

export function normalizeUserInterceptAliasStrategy(value = '') {
  const strategy = clean(value, 40);
  return USER_INTERCEPT_ALIAS_STRATEGIES.has(strategy)
    ? strategy
    : DEFAULT_USER_INTERCEPT_SETTINGS.aliasStrategy;
}

function clippedJson(value, max = 0) {
  if (!value || typeof value !== 'object') return '';
  try {
    return clean(JSON.stringify(value), max);
  } catch (_) {
    return '';
  }
}

export function buildUserInterceptCharacterProfile(row = {}) {
  return {
    id: row.id,
    name: clean(row.realName || row.name, 60),
    currentRole: clean(row.currentRole),
    currentStatus: clean(row.currentStatus),
    userRelationStatus: clean(
      row.userRelationStatus
      || row.relationshipToUser
      || row.userRelationship,
    ),
    gender: clean(row.gender),
    relationships: clippedJson(row.relationships),
    personality: clean(row.personality),
    speechStyle: clean(row.speechStyle),
    speechCorpus: clean(row.speechCorpus),
    promptCorpus: clean(row.promptCorpus),
    background: clean(row.background || row.backstory),
    notes: clean(row.notes),
  };
}

function profileAliasForPrompt(row = {}, continuity = null) {
  return {
    id: clean(row.id, 180),
    characterId: clean(row.ownerId, 160),
    displayName: clean(row.displayName, 60),
    handle: clean(row.handle, 60),
    bio: clean(row.bio, 200),
    windowLabel: clean(row.windowLabel, 40),
    createdBy: clean(row.createdBy, 20),
    hasAvatar: Boolean(clean(row.avatar)),
    ...(continuity ? { continuity } : {}),
  };
}

export function isInterceptMainContextChat(chat, characterId = '') {
  if (!chat || chat.type !== 'private' || isAnonymousChat(chat) || isStrangerInterceptChat(chat)) {
    return false;
  }
  const cid = clean(characterId, 160);
  const participants = (Array.isArray(chat.participants) ? chat.participants : [])
    .map((id) => clean(id, 160))
    .filter(Boolean);
  if (!participants.includes('user')) return false;
  return cid ? participants.includes(cid) : participants.some((id) => id !== 'user');
}

export function findInterceptMainContextChat(chats = [], characterId = '', preferredChatId = '') {
  const cid = clean(characterId, 160);
  if (!cid) return null;
  const rows = (Array.isArray(chats) ? chats : [])
    .filter((chat) => isInterceptMainContextChat(chat, cid))
    .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0));
  const preferred = clean(preferredChatId, 180);
  return (preferred ? rows.find((chat) => clean(chat.id, 180) === preferred) : null)
    || rows[0]
    || null;
}

export function findInterceptAliasThread(chats = [], characterId = '', accountId = '') {
  const cid = clean(characterId, 160);
  const aid = clean(accountId, 180);
  if (!cid || !aid) return null;
  return (Array.isArray(chats) ? chats : [])
    .filter((chat) => (
      isStrangerInterceptChat(chat)
      && (Array.isArray(chat.participants) ? chat.participants : []).some((id) => clean(id, 160) === cid)
      && Object.entries(chat.metadata?.accountIdentityMap || {}).some(([key, value]) => (
        key === `character:${cid}` && clean(value, 180) === aid
      ))
    ))
    .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0))[0] || null;
}

function isAnonymousInterceptFact(row = {}) {
  return Boolean(
    clean(row.anonymousRoomId, 180)
    || clean(row.scope, 80).toLowerCase().includes('anon'),
  );
}

export function buildInterceptPrivateContext({
  characterId = '',
  facts = [],
  recent = [],
  sourceChat = null,
  accountId = '',
} = {}) {
  const cid = clean(characterId, 160);
  if (!cid) {
    return {
      ownerId: '',
      contextMode: 'motive_only',
      source: { kind: 'none', chatId: '', usage: 'motive_only' },
      memoryFacts: [],
      recentChat: [],
    };
  }
  const aid = clean(accountId, 180);
  const aliasThread = aid ? findInterceptAliasThread([sourceChat], cid, aid) : null;
  const mainChat = isInterceptMainContextChat(sourceChat, cid) ? sourceChat : null;
  const contextMode = aliasThread ? 'alias_thread_continuity' : 'motive_only';
  const sourceKind = aliasThread ? 'current_alias_thread' : (mainChat ? 'main_private_background' : 'none');
  const memoryFacts = (Array.isArray(facts) ? facts : [])
    .filter((row) => {
      if (!row || isAnonymousInterceptFact(row)) return false;
      const scope = clean(row.scope, 80);
      if (scope !== 'account_alias') return true;
      return Boolean(aliasThread && aid && clean(row.accountId, 180) === aid);
    })
    .slice(0, 10)
    .map((row) => {
      const knownBy = row?.knownBy && typeof row.knownBy === 'object' ? row.knownBy : {};
      const level = knownBy[cid];
      const involved = row?.subjectId === cid
        || row?.objectId === cid
        || level === true
        || ['involved', 'shared'].includes(String(level || ''));
      return {
        knowledge: involved ? 'involved' : 'known_only',
        subjectId: clean(row?.subjectId, 160),
        objectId: clean(row?.objectId, 160),
        content: clean(row?.content || row?.summary, 180),
      };
    })
    .filter((row) => row.content);
  const recentChat = aliasThread
    ? (Array.isArray(recent) ? recent : []).slice(-12).map((row) => ({
      from: row.senderId === 'user' ? 'user' : clean(row.senderId, 160),
      text: clean(row.content, 160),
    })).filter((row) => row.text)
    : [];
  const mainChatRecent = mainChat
    ? (Array.isArray(recent) ? recent : []).slice(-10).map((row) => ({
      from: row.senderId === 'user' ? 'user' : clean(row.senderId, 160),
      text: clean(row.content, 220),
    })).filter((row) => row.text)
    : [];
  return {
    ownerId: cid,
    contextMode,
    source: {
      kind: sourceKind,
      chatId: clean((aliasThread || mainChat)?.id, 180),
      usage: aliasThread ? 'continue_this_alias_thread_only' : 'motive_only_never_continue',
    },
    memoryFacts,
    recentChat,
    mainChatRecent,
  };
}

/** 当前用户档位里已有主私聊的角色（不含陌生/马甲窗）——禁止把别的档位角色投进来 */
export function collectSlotPrivatePartnerIds(chats = []) {
  const ids = new Set();
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!isInterceptMainContextChat(chat)) continue;
    const parts = Array.isArray(chat.participants) ? chat.participants : [];
    for (const id of parts) {
      const cid = clean(id);
      if (cid && cid !== 'user') ids.add(cid);
    }
  }
  return ids;
}

/** 旧马甲窗最后仍停在角色发言时，视为正在等 user 回应。 */
export function isInterceptAliasAwaitingUserReply(messages = []) {
  const visible = (Array.isArray(messages) ? messages : []).filter((row) => (
    row
    && !row.deleted
    && !row.recalled
    && String(row.senderId || '') !== 'system'
    && String(row.type || '') !== 'system'
  ));
  if (!visible.length) return false;
  return clean(visible[visible.length - 1]?.senderId, 160) !== 'user';
}

function intentMatchKey(value = '') {
  return clean(value, 240).toLowerCase().replace(/[\s_\-—–·，。！？；：、|/\\()[\]{}「」『』“”'"`]+/gu, '');
}

function intentBigrams(value = '') {
  const text = intentMatchKey(value);
  const out = new Set();
  for (let index = 0; index < text.length - 1; index += 1) out.add(text.slice(index, index + 2));
  return out;
}

function intentTopicSimilarity(left = '', right = '') {
  const a = intentBigrams(left);
  const b = intentBigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** 同角色已有未回复窗口时，只拦截同用途/同动机的新开窗；不同话题仍可另开马甲。 */
export function resolvePendingInterceptAliasId(source = {}, aliasesForCharacter = [], options = {}) {
  const continuityById = options.continuityById instanceof Map
    ? options.continuityById
    : new Map(Object.entries(options.continuityById || {}));
  const blockedAccountIds = options.blockedAccountIds instanceof Set
    ? options.blockedAccountIds
    : new Set(Array.isArray(options.blockedAccountIds) ? options.blockedAccountIds : []);
  const motiveKind = intentMatchKey(source?.motiveKind);
  const windowLabel = intentMatchKey(source?.windowLabel);
  const topic = clean([source?.triggerEvidence, source?.motive, source?.contrastLogic].filter(Boolean).join('；'), 600);
  if (!motiveKind && !windowLabel) return '';
  const ranked = (Array.isArray(aliasesForCharacter) ? aliasesForCharacter : [])
    .map((alias) => {
      const id = clean(alias?.id, 180);
      const continuity = continuityById.get(id);
      if (!id || blockedAccountIds.has(id) || continuity?.awaitingUserReply !== true) return null;
      const aliasLabel = intentMatchKey(alias?.windowLabel);
      const aliasMotive = intentMatchKey(alias?.personaOverlay);
      const topicSimilarity = intentTopicSimilarity(topic, alias?.personaOverlay);
      const labelSimilarity = intentTopicSimilarity(windowLabel, aliasLabel);
      let score = 0;
      const sameKind = Boolean(motiveKind && aliasMotive.includes(motiveKind));
      if (topic) {
        // motiveKind 只是大类；具体触发/话题也相近才算重复，避免两个不同树洞话题被硬并窗。
        if (sameKind && topicSimilarity >= 0.2) score += 5;
        if (windowLabel && aliasLabel === windowLabel && topicSimilarity >= 0.2) score += 4;
        else if (labelSimilarity >= 0.5 && topicSimilarity >= 0.2) score += 2;
      } else {
        // 旧数据缺少具体触发时只接受明确一致的用途标签，不拿宽泛 motiveKind 猜。
        if (windowLabel && aliasLabel === windowLabel) score += 4;
      }
      return score >= 4
        ? { id, score, lastActivity: Number(continuity?.lastActivity || alias?.updatedAt || 0) }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.lastActivity - a.lastActivity);
  return ranked[0]?.id || '';
}

/** 已有马甲时优先复用：显式 accountId > 唯一用户自定义号 > 唯一 active 号 */
export function resolveInterceptReuseAccountId(source = {}, aliasesForCharacter = [], options = {}) {
  const strategy = normalizeUserInterceptAliasStrategy(options.strategy);
  const blockedAccountIds = options.blockedAccountIds instanceof Set
    ? options.blockedAccountIds
    : new Set(Array.isArray(options.blockedAccountIds) ? options.blockedAccountIds : []);
  const accountMode = clean(source?.accountMode, 20).toLowerCase();
  if (strategy === 'new') return '';
  const explicit = clean(source?.accountId || source?.reuseAccountId, 180);
  const list = Array.isArray(aliasesForCharacter) ? aliasesForCharacter : [];
  if (explicit && list.some((row) => clean(row?.id) === explicit)) return explicit;
  const pendingSameIntent = resolvePendingInterceptAliasId(source, list, {
    continuityById: options.continuityById,
    blockedAccountIds,
  });
  if (pendingSameIntent) return pendingSameIntent;
  if (accountMode === 'new') return '';
  // 模型已经给出完整新号资料时，accountId 留空就是明确的新建意图，不能再被“唯一旧号”兜底吞掉。
  const publicAccount = source?.account && typeof source.account === 'object' ? source.account : {};
  const intendsNewAccount = clean(publicAccount.handle, 60)
    && clean(publicAccount.displayName, 60)
    && (clean(publicAccount.avatarPrompt, 800) || clean(publicAccount.avatar));
  if (intendsNewAccount) return '';
  if (strategy === 'reuse' && list.length) {
    const userMade = list.filter((row) => clean(row?.createdBy) === 'user');
    return clean((userMade[0] || list[0])?.id, 180);
  }
  // 均衡模式不能把已被用户拦截的唯一旧号静默兜底成“继续投递”；
  // 模型若明确填写该 accountId，仍允许留下带红叹号的失败尝试。
  const reusable = list.filter((row) => !blockedAccountIds.has(clean(row?.id)));
  const userMade = reusable.filter((row) => clean(row?.createdBy) === 'user');
  if (userMade.length === 1) return clean(userMade[0].id, 180);
  if (reusable.length === 1) return clean(reusable[0].id, 180);
  return '';
}

export function resolveUserInterceptSourcePolicy(settings = {}) {
  const sourceMode = normalizeUserInterceptSourceMode(settings.sourceMode, settings);
  const allowCharacterSources = ['character', 'character_stranger', 'character_harass', 'mixed', 'harass'].includes(sourceMode);
  const allowStrangerMessages = ['character_stranger', 'mixed', 'stranger'].includes(sourceMode);
  const allowStrangerHarassment = ['character_harass', 'mixed', 'harass'].includes(sourceMode);
  const allowedNpcSourceTypes = [
    ...(allowStrangerMessages ? ['stranger', 'ad', 'scam'] : []),
    ...(allowStrangerHarassment ? ['harass'] : []),
  ];
  return {
    sourceMode,
    allowCharacterSources,
    allowStrangerMessages,
    allowStrangerHarassment,
    allowedNpcSourceTypes,
  };
}

async function loadState(userId) {
  const row = await get(`userInterceptAuto:${userId}`).catch(() => null);
  return row?.value && typeof row.value === 'object' ? row.value : {};
}

export async function loadUserInterceptSettings(userId = '') {
  const state = await loadState(clean(userId));
  const sourceMode = normalizeUserInterceptSourceMode(state.sourceMode, state);
  return {
    enabled: state.enabled === true,
    intervalHours: Math.max(6, Math.min(720, Number(state.intervalHours || DEFAULT_USER_INTERCEPT_SETTINGS.intervalHours) || DEFAULT_USER_INTERCEPT_SETTINGS.intervalHours)),
    batchSize: Math.max(1, Math.min(5, Number(state.batchSize || DEFAULT_USER_INTERCEPT_SETTINGS.batchSize) || DEFAULT_USER_INTERCEPT_SETTINGS.batchSize)),
    sourceMode,
    aliasStrategy: normalizeUserInterceptAliasStrategy(state.aliasStrategy),
    // 缺省按默认 true：旧档位未写过字段时仍保持纯角色马甲
    charactersOnly: !['character_stranger', 'mixed', 'stranger'].includes(sourceMode),
    allowStrangerHarassment: ['character_harass', 'mixed', 'harass'].includes(sourceMode),
    preference: clean(state.preference, 600),
    activeAccountId: clean(state.activeAccountId, 180),
    preferredCharacterIds: normalizePreferredCharacterIds(state.preferredCharacterIds),
    lastGeneratedAt: Number(state.lastGeneratedAt || 0) || 0,
    lastCount: Number(state.lastCount || 0) || 0,
  };
}

export async function saveUserInterceptSettings(userId = '', patch = {}) {
  const uid = clean(userId);
  const previous = await loadUserInterceptSettings(uid);
  const next = {
    ...previous,
    ...(Object.prototype.hasOwnProperty.call(patch, 'enabled') ? { enabled: patch.enabled === true } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'intervalHours') ? { intervalHours: Math.max(6, Math.min(720, Number(patch.intervalHours) || 72)) } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'batchSize') ? { batchSize: Math.max(1, Math.min(5, Number(patch.batchSize) || 2)) } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'sourceMode')
      ? { sourceMode: normalizeUserInterceptSourceMode(patch.sourceMode, previous) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'aliasStrategy')
      ? { aliasStrategy: normalizeUserInterceptAliasStrategy(patch.aliasStrategy) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'charactersOnly') ? { charactersOnly: patch.charactersOnly === true } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'allowStrangerHarassment')
      ? { allowStrangerHarassment: patch.allowStrangerHarassment === true }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'preference') ? { preference: clean(patch.preference, 600) } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'activeAccountId') ? { activeAccountId: clean(patch.activeAccountId, 180) } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'preferredCharacterIds')
      ? { preferredCharacterIds: normalizePreferredCharacterIds(patch.preferredCharacterIds) }
      : {}),
  };
  // 新界面用 sourceMode；同时写回旧开关，供旧版客户端和备份兼容读取。
  const hasLegacySourcePatch = Object.prototype.hasOwnProperty.call(patch, 'charactersOnly')
    || Object.prototype.hasOwnProperty.call(patch, 'allowStrangerHarassment');
  const normalizedMode = normalizeUserInterceptSourceMode(
    Object.prototype.hasOwnProperty.call(patch, 'sourceMode') || !hasLegacySourcePatch
      ? next.sourceMode
      : '',
    next,
  );
  next.sourceMode = normalizedMode;
  next.charactersOnly = !['character_stranger', 'mixed', 'stranger'].includes(normalizedMode);
  next.allowStrangerHarassment = ['character_harass', 'mixed', 'harass'].includes(normalizedMode);
  await saveState(uid, next);
  return next;
}

async function saveState(userId, patch = {}) {
  const previous = await loadState(userId);
  await put({ key: `${STATE_KEY_PREFIX}${userId}`, value: { ...previous, ...patch } });
}

async function generateMessagesForExistingAlias({
  user,
  alias,
  character,
  privateContext,
  ownerMainContext,
  preference,
  signal,
  sourceChatId,
  batchId,
}) {
  const userProfile = {
    name: clean(user.name || user.nickname || user.displayName, 60),
    persona: clean(user.personality || user.persona || user.bio || user.description, 1000),
    notes: clean(user.notes, 500),
  };
  const payload = {
    user: userProfile,
    character: buildUserInterceptCharacterProfile(character || { id: alias.ownerId }),
    alias: {
      id: alias.id,
      displayName: clean(alias.displayName, 60),
      handle: clean(alias.handle, 60),
      bio: clean(alias.bio, 300),
      windowLabel: clean(alias.windowLabel, 40),
      personaOverlay: clean(alias.personaOverlay, 1200),
    },
    privateContext: privateContext || {
      ownerId: clean(alias.ownerId, 160),
      contextMode: 'motive_only',
      source: { kind: 'none', chatId: '', usage: 'motive_only' },
      memoryFacts: [],
      recentChat: [],
    },
    ownerMainContext: ownerMainContext || {
      ownerId: clean(alias.ownerId, 160),
      contextMode: 'motive_only',
      source: { kind: 'none', chatId: '', usage: 'motive_only' },
      memoryFacts: [],
      recentChat: [],
      mainChatRecent: [],
    },
    contextBoundaryRules: INTERCEPT_CONTEXT_BOUNDARY_RULES,
    userPreference: clean(preference, 600),
  };
  const maxTokens = await resolveGenerationMaxTokens();
  const { data } = await chatJsonGeneration({
    scope: 'user-intercept-alias-reuse',
    messages: [{
      role: 'system',
      content: `用已有角色马甲账户给用户发一批陌生消息。背景 JSON：\n${JSON.stringify(payload)}\n\n硬规则：\n- 必须沿用 alias 的公开身份（昵称/账号/简介/用途），不得改号、不得自曝是小号。\n- privateContext.blockedByUser=true 表示用户已拦截这个马甲号；本次只能作为被拒收的失败尝试并显示红色感叹号，禁止写成用户实际收到了，也不能在这个“指定旧号”任务里擅自换新号。\n- privateContext.recentChat 是本马甲窗自己的历史，必须直接承接，不得重开场或另编本轮为何出现的借口。\n- ownerMainContext 是同一角色主私聊里的内部关系背景，可影响此刻的想念、压抑、黏人、阴暗或抱怨，但不得把主窗原话伪装成本窗上一句，也不得用只有大号身份才知道的方式主动掉马。\n- privateContext 与 ownerMainContext 只属于 ownerId 对应角色；known_only 只表示该角色听说/看见，禁止写成自己和用户亲历。\n- 语气与动机承接 personaOverlay、windowLabel、角色完整设定和本窗历史；不要把所有续写都写成“试探反应”。黏人可以直接多说、树洞可以继续倾诉、阴暗可以继续窥看或自我辩解，具体走向由人设和已有内容决定。\n- 生成 1～4 条短气泡；不要替用户发言，不要编造用户已经做过的事。\n- state.inner 是角色本人第一人称脑内短段（1～4 句），intent ≤30 字，status 是发消息时的场景；禁止把动机分析原文塞进 inner。\n- motive 写第三人称内部分析，只供系统决策。\n- 只输出 JSON：{"windowLabel":"沿用原标签","motiveKind":"","triggerEvidence":"来自本窗或主窗背景的真实触发","evidenceRefs":["privateContext.recentChat[0]"],"contrastLogic":"","motive":"","state":{"inner":"","intent":"","status":"","moodShift":0},"messages":[{"body":"","zh":"外语时才填"}]}`,
    }, {
      role: 'user',
      content: '请承接上述完整角色、主窗与马甲窗上下文，用指定旧号生成本轮消息 JSON。',
    }],
    temperature: 0.9,
    maxTokens,
    signal,
    preferStream: true,
    validate: (value) => Array.isArray(value?.messages),
  });
  const state = data?.state && typeof data.state === 'object' ? data.state : {};
  return persistAliasContactEvent({
    from: alias.ownerId,
    accountId: alias.id,
    sourceIndex: 0,
    windowLabel: clean(data?.windowLabel || alias.windowLabel, 40),
    motive: clean([data?.motiveKind, data?.triggerEvidence, data?.contrastLogic, data?.motive, alias.personaOverlay].filter(Boolean).join('；'), 1200),
    state: {
      inner: clean(state.inner, 400),
      intent: clean(state.intent, 60),
      status: clean(state.status, 80),
      moodShift: Number(state.moodShift) || 0,
    },
    messages: Array.isArray(data?.messages) ? data.messages : [],
  }, {
    userId: clean(user?.id),
    sourceChatId: sourceChatId || 'ambient-intercepts',
    aiRoundId: batchId,
    reuseAccountId: alias.id,
  });
}

export async function generateUserInterceptBatch({
  user,
  sourceChatId = '',
  signal,
  settings: suppliedSettings = null,
  forceCharacterIds = null,
  forceAliasId = '',
} = {}) {
  const uid = clean(user?.id);
  if (!uid) throw new Error('缺少用户档位');
  const forcedAliasId = clean(forceAliasId, 180);
  const forcedCharacterIds = normalizePreferredCharacterIds(forceCharacterIds);
  const [allCharacters, chats, settings] = await Promise.all([
    listCharacters({ excludeAnonNpc: true, userId: uid, identityScoped: true }).catch(() => []),
    listChatsForUser(uid).catch(() => []),
    suppliedSettings || loadUserInterceptSettings(uid),
  ]);
  const characterById = new Map((Array.isArray(allCharacters) ? allCharacters : []).map((row) => [String(row.id), row]));
  const batchId = `ambient_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (forcedAliasId) {
    const alias = await getAliasAccount(forcedAliasId).catch(() => null);
    if (!alias || alias.ownerType !== 'character' || alias.status !== 'active' || clean(alias.userId) !== uid) {
      throw new Error('马甲不可用或不属于当前档位');
    }
    if (!clean(alias.displayName, 60) || !clean(alias.handle, 60)) {
      throw new Error('请先完善该马甲的昵称与账号 ID');
    }
    if (!clean(alias.avatar) && !clean(alias.avatarPrompt, 800)) {
      throw new Error('请先为该马甲设置头像');
    }
    const forcedCharacter = characterById.get(String(alias.ownerId));
    if (!forcedCharacter) {
      throw new Error('该马甲角色不属于当前面具');
    }
    const aliasThread = findInterceptAliasThread(chats, alias.ownerId, alias.id);
    const mainChat = findInterceptMainContextChat(chats, alias.ownerId, sourceChatId);
    const contextChat = aliasThread || mainChat;
    const [recent, ownerFacts, mainFacts, mainRecent] = await Promise.all([
      aliasThread ? listMessagesForChat(aliasThread.id, 16).catch(() => []) : [],
      contextChat ? listMemoryFactsForContext({
        userId: uid,
        chat: contextChat,
        characterIds: [alias.ownerId],
        limit: 10,
      }).catch(() => []) : [],
      mainChat ? listMemoryFactsForContext({
        userId: uid,
        chat: mainChat,
        characterIds: [alias.ownerId],
        limit: 12,
      }).catch(() => []) : [],
      mainChat ? listMessagesForChat(mainChat.id, 12).catch(() => []) : [],
    ]);
    const saved = await generateMessagesForExistingAlias({
      user,
      alias,
      character: forcedCharacter,
      privateContext: {
        ...buildInterceptPrivateContext({
          characterId: alias.ownerId,
          facts: ownerFacts,
          recent,
          sourceChat: contextChat,
          accountId: alias.id,
        }),
        friendshipState: clean(aliasThread?.metadata?.friendshipState, 30),
        blockedByUser: isCharacterAliasBlockedByUser(aliasThread),
      },
      ownerMainContext: buildInterceptPrivateContext({
        characterId: alias.ownerId,
        facts: mainFacts,
        recent: mainRecent,
        sourceChat: mainChat,
      }),
      preference: settings.preference,
      signal,
      sourceChatId: sourceChatId || 'ambient-intercepts',
      batchId,
    });
    return saved ? [{ ...saved, sourceType: 'character' }] : [];
  }

  const preferredIds = normalizePreferredCharacterIds(
    forcedCharacterIds.length ? forcedCharacterIds : settings.preferredCharacterIds,
  );
  const allowedPreferredIds = preferredIds.filter((id) => characterById.has(String(id)));
  // 只允许当前身份下可选择的正式联系人；匿名路人 NPC 与初遇草稿不能反向混入角色马甲池。
  // 旧设置若曾误存路人 ID，直接忽略这些失效偏好，避免把当前正式角色池筛成空集。
  // 是否已有主私聊不再影响角色能否开马甲；无主窗时使用人设、关系字段与已有记忆决定动机。
  let characters = (Array.isArray(allCharacters) ? allCharacters : [])
    .filter((row) => row?.id);
  if (allowedPreferredIds.length) {
    const allow = new Set(allowedPreferredIds);
    characters = characters.filter((row) => allow.has(String(row.id)));
  }
  if (forcedCharacterIds.length && allowedPreferredIds.length !== preferredIds.length) {
    throw new Error('所选角色不在当前身份范围内，无法生成陌生消息');
  }
  characters = characters.slice(0, 24);

  const privateContextRows = await Promise.all(characters.map(async (row) => {
    const mainChat = findInterceptMainContextChat(chats, row.id, sourceChatId);
    const [facts, recent] = await Promise.all([
      listMemoryFactsForContext({
        userId: uid,
        chat: mainChat,
        characterIds: [row.id],
        limit: 12,
      }).catch(() => []),
      mainChat ? listMessagesForChat(mainChat.id, 12).catch(() => []) : [],
    ]);
    return [
      String(row.id),
      buildInterceptPrivateContext({
        characterId: row.id,
        facts,
        recent,
        sourceChat: mainChat,
      }),
    ];
  }));
  const privateContextByCharacter = new Map(privateContextRows);

  const existingAliases = await listCharacterAliasAccountsForUser(uid, {
    characterIds: new Set(characters.map((row) => String(row.id))),
  }).catch(() => []);
  const aliasesByCharacter = new Map();
  for (const row of existingAliases) {
    const key = clean(row.ownerId);
    if (!key) continue;
    const list = aliasesByCharacter.get(key) || [];
    list.push(row);
    aliasesByCharacter.set(key, list);
  }
  const aliasContinuityRows = await Promise.all(existingAliases.slice(0, 40).map(async (alias) => {
    const thread = findInterceptAliasThread(chats, alias.ownerId, alias.id);
    if (!thread) return [alias.id, null];
    const [recent, facts] = await Promise.all([
      listMessagesForChat(thread.id, 14).catch(() => []),
      listMemoryFactsForContext({
        userId: uid,
        chat: thread,
        characterIds: [alias.ownerId],
        limit: 10,
      }).catch(() => []),
    ]);
    return [
      alias.id,
      {
        ...buildInterceptPrivateContext({
          characterId: alias.ownerId,
          accountId: alias.id,
          sourceChat: thread,
          recent,
          facts,
        }),
        friendshipState: clean(thread.metadata?.friendshipState, 30),
        blockedByUser: isCharacterAliasBlockedByUser(thread),
        blockedAt: Math.max(0, Number(thread.metadata?.friendshipBlockedAt) || 0),
        awaitingUserReply: isInterceptAliasAwaitingUserReply(recent),
        lastActivity: Number(thread.lastActivity || 0),
      },
    ];
  }));
  const aliasContinuityById = new Map(aliasContinuityRows);
  const blockedAliasIds = new Set(aliasContinuityRows
    .filter(([, continuity]) => continuity?.blockedByUser === true)
    .map(([accountId]) => accountId));

  const blockStates = await Promise.all(characters.map(async (row) => ({
    characterId: row.id,
    ...(await loadCharacterBlockState(row.id, uid).catch(() => ({ blocked: false }))),
  })));
  const blockedById = new Map(blockStates.map((row) => [row.characterId, row]));
  const existing = chats.filter(isStrangerInterceptChat).slice(0, 10).map((row) => ({
    title: clean(row.lastMessage, 80),
    accountNames: Object.values(row.metadata?.accountSnapshots || {}).map((item) => clean(item?.displayName, 40)).filter(Boolean),
  }));
  const userProfile = {
    name: clean(user.name || user.nickname || user.displayName, 60),
    persona: clean(user.personality || user.persona || user.bio || user.description, 1000),
    notes: clean(user.notes, 500),
  };
  const batchSize = forcedCharacterIds.length === 1 ? 1 : settings.batchSize;
  const aliasStrategy = normalizeUserInterceptAliasStrategy(settings.aliasStrategy);
  const payload = {
    user: userProfile,
    characters: characters.map((row) => ({
      ...buildUserInterceptCharacterProfile(row),
      blockedByUser: blockedById.get(row.id)?.blocked === true,
      blockReason: clean(blockedById.get(row.id)?.blockReason, 160),
      existingAliases: (aliasesByCharacter.get(String(row.id)) || []).slice(0, 8)
        .map((alias) => profileAliasForPrompt(alias, aliasContinuityById.get(alias.id))),
      privateContext: privateContextByCharacter.get(String(row.id)) || {
        ownerId: String(row.id),
        contextMode: 'motive_only',
        source: { kind: 'none', chatId: '', usage: 'motive_only' },
        memoryFacts: [],
        recentChat: [],
        mainChatRecent: [],
      },
    })),
    existing,
    existingAliases: existingAliases.slice(0, 40)
      .map((alias) => profileAliasForPrompt(alias, aliasContinuityById.get(alias.id))),
    contextBoundaryRules: INTERCEPT_CONTEXT_BOUNDARY_RULES,
    userPreference: settings.preference,
    sourceMode: forcedCharacterIds.length
      ? 'character'
      : resolveUserInterceptSourcePolicy(settings).sourceMode,
    aliasStrategy,
    forcedCharacterIds,
    slotNote: 'characters 已按当前用户身份范围筛选：有身份绑定时仅含绑定角色/分组，无绑定时为通讯录全员；不得引用名单外角色。',
  };
  const {
    sourceMode,
    allowCharacterSources,
    allowStrangerHarassment,
    allowedNpcSourceTypes,
  } = resolveUserInterceptSourcePolicy(settings);
  const effectiveSourceMode = forcedCharacterIds.length ? 'character' : sourceMode;
  const effectiveNpcSourceTypes = forcedCharacterIds.length ? [] : allowedNpcSourceTypes;
  const allowedSourceTypes = [
    ...(allowCharacterSources || forcedCharacterIds.length ? ['character'] : []),
    ...effectiveNpcSourceTypes,
  ];
  const sourceMixRuleByMode = {
    character: `正好生成 ${batchSize} 个角色马甲来源，禁止原创 NPC。`,
    character_stranger: batchSize === 1
      ? '正好生成 1 个普通陌生人来源（stranger|ad|scam），本轮不要角色马甲。'
      : `正好生成 ${batchSize} 个来源，至少 1 个 character、至少 1 个 stranger|ad|scam。`,
    character_harass: `正好生成 ${batchSize} 个来源，可在 character 与 harass 中按人设和关系选择；character 可以带骚扰、纠缠或越界动机，harass 只表示原创陌生骚扰者。`,
    mixed: `正好生成 ${batchSize} 个来源，在 character|stranger|ad|scam|harass 中按当前上下文选择，不机械凑齐类型。character 可以具有骚扰动机。`,
    stranger: `正好生成 ${batchSize} 个普通陌生人来源，只能使用 stranger|ad|scam，禁止 character 与 harass。`,
    harass: `正好生成 ${batchSize} 个骚扰性质来源：真实角色用 sourceType=character，原创陌生骚扰者用 sourceType=harass；禁止 stranger|ad|scam。`,
  };
  const sourceMixRule = [
    sourceMixRuleByMode[effectiveSourceMode] || sourceMixRuleByMode.character,
    '数量是精确目标，不是上限；不要少生成，也不要超出。',
    allowStrangerHarassment
      ? '骚扰性质可来自真实角色或原创陌生人：真实角色仍写 sourceType=character，并由该角色人设、关系与上下文决定纠缠、越界搭讪、恶意挑衅、阴阳怪气、前任绕回或狂热关注；原创陌生骚扰者才写 sourceType=harass。可以令人不适，但禁止暴力威胁、勒索、开盒、现实定位与人身伤害。'
      : '',
    'character 的 motiveKind 允许 harassment：分手后纠缠、越界控制、反复换号、恶意挑衅或其它符合该角色人设与关系的骚扰都仍属于 character，不得为了写骚扰把真实角色替换成原创 NPC。动机必须由该角色自己的资料、关系、记忆或近期上下文推出；没有聊天历史时也可直接依据人设与关系状态决定。',
    'sourceMode 是来源硬约束，优先于 userPreference。',
  ].filter(Boolean).join(' ');
  const aliasStrategyRule = aliasStrategy === 'new'
    ? '- 本轮 character 来源只创建新马甲：accountMode 必须是 new、accountId 必须留空，并完整填写 account。即使已有旧号也不得复用。'
    : (aliasStrategy === 'reuse'
      ? '- 本轮 character 来源只续写已有马甲：accountMode 必须是 reuse，并填写该角色 existingAliases 中真实 accountId；没有旧号的角色不要选。若 continuity.blockedByUser=true，这次消息会被拒收并显示红色感叹号，不能假装已送达。'
      : `- 本轮 character 来源采用新旧均衡：同一未被拦截旧号的用途与本轮动机仍一致时续写；尤其 continuity.awaitingUserReply=true 代表角色已经发出消息、user 尚未回复，同角色同动机必须续旧窗，不得换昵称头像再开一个同意图窗口。动机或话题明显不同，或旧号 continuity.blockedByUser=true 且角色确有绕回动机时，才可以新建。不要为了凑“新旧均衡”强制开新号；accountMode 必须明确写 reuse 或 new。`);
  const forcedRule = forcedCharacterIds.length
    ? `- forcedCharacterIds 非空时，每个来源的 characterId 必须从该列表选取。\n`
    : '';
  const npcRules = effectiveNpcSourceTypes.length
    ? `- 非 character 来源只能使用 ${effectiveNpcSourceTypes.join('|')}，且必须带 npcProfile；禁止输出未开启的陌生来源类型。sourceType 只区分幕后身份来源，不限制 character 的动机；角色可以因自身关系与人设表现为骚扰或纠缠。\n`
    : '- 禁止 stranger/ad/scam/harass 与 npcProfile；不得编造名单外角色或原创陌生人。\n';
  const sourceTypeSchema = `"${allowedSourceTypes.join('|')}"`;
  const maxTokens = await resolveGenerationMaxTokens();
  const { data } = await chatJsonGeneration({
    scope: 'user-intercept-auto',
    messages: [{
      role: 'system',
      content: `根据用户当前人设、角色关系、记忆和近期聊天，生成一批独立于普通聊天频率的陌生消息。背景 JSON：\n${JSON.stringify(payload)}\n\n${sourceMixRule}\n\n【角色私有上下文分区·最高优先级】\n- characters[].privateContext 只属于同一项 character.id；生成某个 character 来源时，只能读取该角色自己嵌套的 privateContext，绝对禁止读取数组中其他角色的资料。\n- privateContext.memoryFacts 与 mainChatRecent 是该角色在主私聊里的真实关系背景。它们可以触发想念、压抑、窥伺、抱怨、树洞倾诉或绕路联系，但不是当前马甲窗的上一轮对白；禁止把主窗措辞直接接成“你刚才说”。\n- existingAliases[].continuity.contextMode=alias_thread_continuity 时，其中 recentChat 才是该账号自己的历史。选择复用该 accountId 时必须直接承接这段历史，不得重新发明开场理由。\n- existingAliases[].continuity.blockedByUser=true 表示用户只拦截了这个公开马甲号，不等于拉黑角色本体或该角色的其它账号。继续复用此号只能形成拒收失败记录；角色若仍想绕回来，可以创建全新马甲。\n- 新马甲是完全独立的前台陌生身份：即使幕后仍是同一角色，对外也必须假装初次联系，不得提旧号、被拦截、换号、以前说过的话或“又找到你了”；新窗只能从零积累公开关系。\n- privateContext.memoryFacts[].knowledge=known_only 只表示该角色听说/看见，禁止改写成该角色与用户共同亲历；只有 involved 才能作为本人经历。\n- user 档案是公共基础资料，但涉及用户做过什么、说过什么、与谁发生过什么，仍必须来自当前来源角色自己的 privateContext。\n\n角色开马甲的成立条件：\n- 必须从 characters 名单里选，不得编造名单外角色 ID。\n${forcedRule}${aliasStrategyRule}\n- 先完整服从 character 的 promptCorpus、personality、speechCorpus、speechStyle、userRelationStatus、relationships、currentRole/currentStatus，再决定动机；不能先套“试探感情”模板再往角色身上贴。\n- motiveKind 从 sticky_affection|secret_treehole|dark_observation|jealous_test|blocked_return|blackfan|seduction|aid_main|resentment 中选择最贴人物的一种。jealous_test 只是其中一种，一批最多出现一次；没有具体人物证据时禁止人人都写成旁敲侧击。\n- blocked_return 既可以是被用户拉黑的大号绕回，也可以是某个旧马甲被拦截后另开新号；另开时 accountMode 必须是 new，并严格遵守“新号对外假装不认识”的身份墙。\n- 黏糊暗恋不等于试探：sticky_affection 可以是忍不住反复想起、借陌生身份多说软话、没人回应也继续絮叨、分享只敢放在小号的细节；secret_treehole 可以像默认用户看不到的倾诉。阴暗也不等于威胁：dark_observation 可以是过度关注、记住细节、克制不住地窥看与自我辩解。选择哪一种必须由该角色资料和真实关系背景决定。\n- 用户未填写明确恋爱关系不等于只能生成试探；可依据人物性格、主窗实际互动与记忆生成单向暗恋、依恋或压抑欲望。但不得凭空宣称双方已经恋爱、接吻、同居或做过其它未提供的共同经历。\n- 若用陌生身份勾引，必须保留双向心理后果：成功会因“用户可能背叛大号”而嫉妒、破防或自食其果；失败也会暴露失落、庆幸或更深的执念。\n- 反差必须有心理依据：公开大号越克制，小号可以更直白、更黏、更阴暗或更刻薄，但仍要能从角色原本人设、经历和关系中推导出来，不能换成另一个通用病娇。\n- blockedByUser=true 的角色是高优先候选，但仍要结合拉黑原因和人设决定是绕回、窥视、赌气还是不出现。\n- 每个 character 来源都填写 windowLabel、motiveKind、triggerEvidence 与 evidenceRefs。triggerEvidence 必须概括背景 JSON 里真实存在的事实；evidenceRefs 至少引用一个可核对来源，如 memoryFacts[n]、mainChatRecent[n]、character.personality、character.userRelationStatus 或 existingAliases[id].continuity。不得编造背景里不存在的“最近发生了某事”当借口。\n\n其它规则：\n- userPreference 是用户对本功能的明确偏好；与 sourceMode 冲突时以 sourceMode 为准。\n- 不要照抄匿名聊天室结构，不要替用户发言，不要编造用户已经做过的事。\n- 新建号时 handle、displayName、bio、avatarPrompt 必须独立生成，不得沿用大号或任何旧马甲的头像、昵称、账号、简介和固定话术，不得自曝是小号；复用时 account 留空。\n- 每个来源生成 1～4 条短气泡。黏人、树洞或情绪溢出的角色可以连发到 3～4 条，不要为了“短”把所有角色压成一句试探问话。\n${npcRules}- 避开 existing 中已有账号和重复话术；复用马甲时则沿着 continuity 续写，不重新自我介绍。\n- 每个来源必须额外写 state：inner 是角色本人第一人称脑内短段（1～4 句，口吻贴近 messages 气泡），intent 一句小心思（≤30 字），status 是发消息时的真实场景。intent 不得批量写成“试探对方反应”；没有试探时如实写“忍不住想多说两句”“只敢在这里承认”“想看一眼但不愿露面”等人物化意图。\n- motive 字段写第三人称内部分析，只供系统决策，不会当心声展示。\n- 只输出 JSON：{"sources":[{"sourceType":${sourceTypeSchema},"characterId":"character 时必填","accountMode":"character 时必填 reuse|new","accountId":"reuse 时填 existingAliases.id，new 时留空","npcProfile":{"name":"非 character 时必填","personality":"","speechStyle":""},"account":{"handle":"new 时必填","displayName":"new 时必填","bio":"","avatarPrompt":"new 时必填"},"windowLabel":"用途短标签","motiveKind":"固定枚举","triggerEvidence":"来自背景的具体触发","evidenceRefs":["memoryFacts[0]"],"contrastLogic":"反差如何仍符合人设","motive":"内部动机与后续心理","state":{"inner":"第一人称脑内短段","intent":"一句小心思","status":"发消息时的场景","moodShift":0},"messages":[{"body":"","zh":"外语时才填"}]}]}`,
    }, {
      role: 'user',
      content: '请按上述完整角色私有上下文与用户偏好生成本轮陌生消息 JSON。',
    }],
    temperature: 0.9,
    maxTokens,
    signal,
    preferStream: true,
    validate: (value) => Array.isArray(value?.sources),
  });
  const characterIds = new Set(characters.map((row) => row.id));
  const aliasById = new Map(existingAliases.map((row) => [row.id, row]));
  const allowedNpcTypes = new Set(effectiveNpcSourceTypes);
  const results = [];
  for (const [index, source] of (Array.isArray(data?.sources) ? data.sources : []).slice(0, batchSize).entries()) {
    let actorId = clean(source?.characterId);
    const sourceType = clean(source?.sourceType).toLowerCase();
    if (sourceType === 'character' && !allowedSourceTypes.includes('character')) continue;
    if (sourceType !== 'character' || !characterIds.has(actorId)) {
      // 模型即使越过提示词，也只能落库用户明确开启的陌生来源类型
      if (!allowedNpcTypes.has(sourceType)) continue;
      const npc = await ensureLightweightNpc({
        name: clean(source?.npcProfile?.name || source?.account?.displayName || '陌生人', 24),
        sourceChatId: 'user-intercepts',
        note: `陌生消息 · ${sourceType || 'stranger'}`,
        personality: clean(source?.npcProfile?.personality || source?.motive, 280),
        speechStyle: clean(source?.npcProfile?.speechStyle, 120),
        userId: uid,
        userName: userProfile.name,
      });
      if (!npc?.id) continue;
      actorId = npc.id;
    }
    const state = source?.state && typeof source.state === 'object' ? source.state : {};
    const reuseAccountId = resolveInterceptReuseAccountId(
      source,
      aliasesByCharacter.get(actorId) || [],
      { strategy: aliasStrategy, blockedAccountIds: blockedAliasIds, continuityById: aliasContinuityById },
    );
    const reuseAlias = reuseAccountId ? aliasById.get(reuseAccountId) : null;
    const saved = await persistAliasContactEvent({
      ...source,
      from: actorId,
      accountId: reuseAccountId || undefined,
      sourceIndex: index,
      windowLabel: clean(source?.windowLabel || reuseAlias?.windowLabel, 40),
      motive: clean([source?.motiveKind, source?.triggerEvidence, source?.contrastLogic, source?.motive, reuseAlias?.personaOverlay].filter(Boolean).join('；'), 1200),
      state: {
        inner: clean(state.inner || source?.inner, 400),
        intent: clean(state.intent || source?.intent, 60),
        status: clean(state.status || source?.status, 80),
        moodShift: Number(state.moodShift) || 0,
      },
    }, {
      userId: uid,
      sourceChatId: sourceChatId || 'ambient-intercepts',
      aiRoundId: batchId,
      reuseAccountId: reuseAccountId || undefined,
    });
    if (saved) {
      results.push({ ...saved, sourceType: sourceType || 'stranger' });
      // 同一批次后面的来源也要看见刚创建且尚未获 user 回复的窗口，避免一批内重复开同意图小号。
      if (sourceType === 'character' && saved.accountId) {
        const batchAlias = {
          id: saved.accountId,
          ownerId: actorId,
          createdBy: 'ai',
          windowLabel: clean(source?.windowLabel || source?.motiveKind, 40),
          personaOverlay: clean([source?.motiveKind, source?.triggerEvidence, source?.motive].filter(Boolean).join('；'), 1200),
          updatedAt: Date.now(),
        };
        const actorAliases = aliasesByCharacter.get(actorId) || [];
        if (!actorAliases.some((row) => row.id === batchAlias.id)) actorAliases.push(batchAlias);
        aliasesByCharacter.set(actorId, actorAliases);
        aliasById.set(batchAlias.id, batchAlias);
        aliasContinuityById.set(batchAlias.id, {
          awaitingUserReply: true,
          blockedByUser: false,
          lastActivity: Date.now(),
        });
      }
    }
  }
  return results;
}

export async function maybeGenerateUserIntercepts({
  sourceChatId = '',
  force = false,
  forceCharacterIds = null,
  forceAliasId = '',
  user: suppliedUser = null,
} = {}) {
  if (inFlight) return { ok: false, reason: 'in-flight' };
  const user = suppliedUser || await ensureDefaultUser();
  const settings = await loadUserInterceptSettings(user.id);
  const now = Date.now();
  if (!force && !settings.enabled) return { ok: false, reason: 'disabled' };
  if (!force && now - Number(settings.lastGeneratedAt || 0) < settings.intervalHours * 60 * 60 * 1000) return { ok: false, reason: 'interval' };
  const chats = await listChatsForUser(user.id).catch(() => []);
  const sourceChat = chats.find((row) => row.id === sourceChatId);
  if (sourceChat && isStrangerInterceptChat(sourceChat)) return { ok: false, reason: 'stranger-thread' };
  if (sourceChat && isAnonymousChat(sourceChat)) return { ok: false, reason: 'anonymous-thread' };
  inFlight = true;
  try {
    const results = await generateUserInterceptBatch({
      user,
      sourceChatId,
      settings,
      forceCharacterIds,
      forceAliasId,
    });
    if (results.length) await saveState(user.id, { lastGeneratedAt: Date.now(), lastCount: results.length });
    return { ok: results.length > 0, results };
  } finally {
    inFlight = false;
  }
}

export async function runUserInterceptAutoCheck({ user = null } = {}) {
  return maybeGenerateUserIntercepts({ force: false, user });
}
