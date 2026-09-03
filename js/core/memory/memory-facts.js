import * as db from '../db.js';
import { listCharacters } from '../character-store.js';
import {
  createMemoryFact,
  MEMORY_FACT_SCOPES,
  normalizeMemoryFactCanonicalKey,
  normalizeMemoryFactType,
  splitMemoryFactContent,
} from '../../models/memory-fact.js';
import { isAnonymousChat } from '../chat-helpers.js';
import { resolveAnonymousActorId } from '../anonymous-chat.js';
import { lexicalTimelineSimilarity } from './unified-event-timeline.js';
import { canStrangerChatShareMemory, isStrangerInterceptChat } from '../stranger-thread-model.js';
import { principalKey } from '../alias-account-model.js';
import {
  getUserDisplayName,
  isUserPlaceholderLabel,
  normalizeUserFacingLabel,
  normalizeUserRecord,
} from '../../models/user.js';
import { isAliasAccountRevoked } from '../alias-account-store.js';
import { deleteVectorSources, enqueueVectorSource } from './memory-vectors.js';
import { shouldSuppressDeletedMemory } from './memory-deletion-guard.js';

export const MEMORY_FACT_BLOCK_OPEN = '【记忆:结构化表格】';

// 与 models/memory-fact.js 保持一致；放在 core 层导出，供分层记忆等模块使用，
// 避免直接依赖 model 文件的具名导出（本地 SW 缓存偶发 model 偏旧时模块加载失败）。
const DEFAULT_TEMPORAL_STATE_BY_FACT_TYPE = {
  promise: 'ongoing',
  status: 'ongoing',
  preference: 'evergreen',
  relationship_impression: 'evergreen',
  secret: 'evergreen',
  topic_affinity: 'evergreen',
  boundary: 'evergreen',
  group_meme: 'evergreen',
  character_evolution_signal: 'evergreen',
  alias_awareness: 'evergreen',
  alias_window_digest: 'evergreen',
};

export const ALIAS_AWARENESS_LEVELS = Object.freeze([
  'suspects',
  'knows_account',
  'knows_purpose',
]);
export const ALIAS_AWARENESS_SOURCES = Object.freeze([
  'consulted',
  'told',
  'observed',
  'forwarded',
]);

const ALIAS_AWARENESS_LEVEL_RANK = Object.freeze({
  suspects: 1,
  knows_account: 2,
  knows_purpose: 3,
});

function cleanAliasField(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeAliasAwareness(input = {}) {
  const level = cleanAliasField(input.awarenessLevel || input.level, 32);
  const source = cleanAliasField(input.provenance?.source || input.source, 32);
  return {
    accountId: cleanAliasField(input.accountId),
    awareCharacterId: cleanAliasField(input.awareCharacterId || input.characterId),
    awarenessLevel: ALIAS_AWARENESS_LEVELS.includes(level) ? level : '',
    confidence: Math.max(0, Math.min(1, Number(input.confidence)
      || (level === 'suspects' ? 0.55 : level === 'knows_account' ? 0.9 : 1))),
    provenance: {
      source: ALIAS_AWARENESS_SOURCES.includes(source) ? source : '',
      sourceChatId: cleanAliasField(input.provenance?.sourceChatId || input.sourceChatId),
      note: cleanAliasField(input.provenance?.note || input.note, 240),
    },
  };
}

export function formatAliasAwarenessRecap(record = {}, account = {}) {
  const row = normalizeAliasAwareness(record);
  if (!row.accountId || !row.awareCharacterId || !row.awarenessLevel || !row.provenance.source) return '';
  const label = cleanAliasField(account.displayName || record.subjectName || '该前台账户', 60);
  const levelText = {
    suspects: '仅怀疑它与熟人有关，尚未确认',
    knows_account: '知道它对应熟人的另一个账户，但不知道完整用途',
    knows_purpose: '知道它对应熟人的账户，也知道其使用目的',
  }[row.awarenessLevel];
  const sourceText = {
    consulted: '经私下询问得知',
    told: '由当事人明确告知',
    observed: '由亲眼观察/直接证据得知',
    forwarded: '从转发记录中得知',
  }[row.provenance.source];
  return `${label}：${levelText}；来源：${sourceText}${row.provenance.note ? `（${row.provenance.note}）` : ''}；置信度 ${Math.round(row.confidence * 100)}%。`;
}

export function buildAliasForwardCognitionBlock({
  sources = [],
  awareness = [],
} = {}) {
  const sourceRows = Array.isArray(sources) ? sources : [];
  if (!sourceRows.length) return '';
  const byAccount = new Map((Array.isArray(awareness) ? awareness : [])
    .map((row) => [String(row.accountId || ''), normalizeAliasAwareness(row)]));
  const lines = sourceRows.map((source) => {
    const accountId = cleanAliasField(source.accountId);
    const label = cleanAliasField(source.frontstageLabel || '前台账户', 60);
    const row = byAccount.get(accountId);
    if (!row?.awarenessLevel) {
      return `- 「${label}」：按独立前台身份理解。只有文本本身确有依据时，才可说措辞/风格似曾相识；绝不能断言或暗示已确认真实身份。`;
    }
    if (row.awarenessLevel === 'suspects') {
      return `- 「${label}」：你只有怀疑，可以试探或表达不确定的熟悉感，不能确认身份。${formatAliasAwarenessRecap(row, { displayName: label })}`;
    }
    return `- 「${label}」：只按账本已知层级反应。${formatAliasAwarenessRecap(row, { displayName: label })}`;
  });
  return [
    '【转发记录·前台身份认知硬墙】',
    '以下内容是用户转来的聊天记录；卡片内显示名是当时的前台身份，不是本体姓名。不得仅凭模型猜测、语气或关系感直接认出本体。',
    ...lines,
  ].join('\n');
}

export function buildDeterministicAliasDigest(messages = [], {
  accountId = '',
  chatId = '',
  frontstageLabel = '马甲',
  maxLines = 3,
} = {}) {
  const threadId = cleanAliasField(chatId);
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted && message.senderId !== 'system')
    // accountId 是摘要归属键；内容边界按 chatId，但不得把该窗原话搬进其它记忆区。
    .filter((message) => !threadId || String(message.chatId || '') === threadId)
    .slice(-12);
  if (!rows.length) return '';
  const participants = [...new Set(rows
    .map((message) => cleanAliasField(
      message.senderName || (message.senderId === 'user' ? '对方' : frontstageLabel),
      32,
    ))
    .filter(Boolean))]
    .slice(0, Math.max(2, Math.min(3, Number(maxLines) || 3)));
  const kinds = [];
  if (rows.some((message) => /[?？]/u.test(String(message.content || '')))) kinds.push('有提问');
  if (rows.some((message) => ['image', 'photo', 'sticker'].includes(String(message.type || '')))) kinds.push('有图片或表情');
  if (rows.some((message) => ['audio', 'voice'].includes(String(message.type || '')))) kinds.push('有语音');
  const latestMessage = rows[rows.length - 1];
  const latestSpeaker = cleanAliasField(
    latestMessage?.senderName || (latestMessage?.senderId === 'user' ? '对方' : frontstageLabel),
    32,
  );
  return [
    `该独立身份窗口最近有 ${rows.length} 条有效往来。`,
    participants.length ? `参与身份：${participants.join('、')}。` : '',
    latestSpeaker ? `最近一次由「${latestSpeaker}」发言。` : '',
    kinds.length ? `互动特征：${kinds.join('、')}。` : '',
    '具体措辞只保留在原线程，不复制到其它记忆或身份窗口。',
  ].filter(Boolean).join('\n').slice(0, 600);
}

export function buildAliasInventoryDigestBlock(accounts = [], digests = [], {
  currentAccountId = '',
} = {}) {
  const digestByAccount = new Map((Array.isArray(digests) ? digests : [])
    .map((row) => [String(row.accountId || ''), row]));
  const lines = (Array.isArray(accounts) ? accounts : []).map((account) => {
    const digest = digestByAccount.get(String(account.id || ''));
    const purpose = cleanAliasField(account.windowLabel || account.personaOverlay, 80);
    const recent = cleanAliasField(digest?.digest || digest?.content, 240);
    return `- ${cleanAliasField(account.displayName || '未命名马甲', 60)}${purpose ? `｜用途：${purpose}` : ''}${recent ? `｜最近摘要：${recent}` : ''}`;
  });
  if (!lines.length) return '';
  return [
    '【你私下拥有的马甲清单】',
    ...lines,
    currentAccountId
      ? '这是幕后清单级认知。其它窗口摘要不得当成本窗口已经发生的连续剧情，也不得向外暴露或据此掉马。'
      : '这些是你的私有账户与各自窗口摘要，不是公开资料。',
  ].join('\n');
}

function normalizeTemporalStateForRead(raw) {
  const val = String(raw || '').trim();
  return ['planned', 'ongoing', 'completed', 'evergreen'].includes(val) ? val : '';
}

function defaultTemporalStateForRead(factType) {
  return DEFAULT_TEMPORAL_STATE_BY_FACT_TYPE[String(factType || '').trim()] || 'evergreen';
}

/** Moments / public feed posts are finished events, never "still happening". */
function isMomentPublicFeedFact(fact = {}) {
  if (String(fact?.scope || '').trim() === 'public_feed') return true;
  if (String(fact?.id || '').startsWith('mf_moment_')) return true;
  if (String(fact?.evidence || '').includes('朋友圈')) return true;
  const tags = Array.isArray(fact?.tags) ? fact.tags : [];
  return tags.includes('朋友圈');
}

function startOfLocalDay(timestamp = Date.now()) {
  const date = new Date(Number(timestamp || Date.now()));
  if (Number.isNaN(date.getTime())) return 0;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 从“将于 8 月 10 日入职”一类事实中恢复原计划日期，供旧数据跨日校准。 */
export function resolveMemoryFactTargetDate(fact = {}) {
  const text = String(fact?.content || '').trim();
  const match = text.match(/(?:(20\d{2})\s*[年\/-]\s*)?(1[0-2]|0?[1-9])\s*[月\/-]\s*(3[01]|[12]\d|0?[1-9])\s*(?:日|号)?/u);
  if (!match) return 0;
  const sourceTime = Number(fact?.updatedAt || fact?.createdAt || fact?.timestamp || 0);
  const sourceDate = new Date(sourceTime || Date.now());
  let year = Number(match[1] || sourceDate.getFullYear());
  const month = Number(match[2]);
  const day = Number(match[3]);
  let target = new Date(year, month - 1, day).getTime();
  if (!match[1] && sourceTime && target < startOfLocalDay(sourceTime) - 180 * 24 * 60 * 60 * 1000) {
    year += 1;
    target = new Date(year, month - 1, day).getTime();
  }
  const parsed = new Date(target);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return 0;
  return target;
}

export function resolveEffectiveTemporalState(fact, now = Date.now()) {
  // Heal legacy moment facts that were stored as status→ongoing ("进行中").
  if (isMomentPublicFeedFact(fact)) return 'completed';
  const state = normalizeTemporalStateForRead(fact?.temporalState) || defaultTemporalStateForRead(fact?.factType);
  if (['ongoing', 'planned'].includes(state)
    && Number(fact?.expiresAt || 0) > 0
    && Number(fact.expiresAt) < Number(now)) {
    return 'completed';
  }
  const factType = normalizeMemoryFactType(fact?.factType);
  const targetDate = resolveMemoryFactTargetDate(fact);
  const hasFutureDateLanguage = /(?:将于|将在|计划|预计|预定|定于|届时|正式入职|报到|到岗)/u.test(String(fact?.content || ''));
  if (['ongoing', 'planned'].includes(state)
    && ['promise', 'status'].includes(factType)
    && targetDate > 0
    && (state === 'planned' || hasFutureDateLanguage)
    && startOfLocalDay(now) > startOfLocalDay(targetDate)) {
    return 'completed';
  }
  const sourceTime = Number(fact?.updatedAt || fact?.createdAt || 0);
  if (state === 'ongoing'
    && ['promise', 'status'].includes(factType)
    && /(?:今天|今日|今早|今晚|今夜)/u.test(String(fact?.content || ''))
    && sourceTime > 0) {
    const sourceDate = new Date(sourceTime);
    const currentDate = new Date(Number(now || Date.now()));
    if (sourceDate.getFullYear() !== currentDate.getFullYear()
      || sourceDate.getMonth() !== currentDate.getMonth()
      || sourceDate.getDate() !== currentDate.getDate()) return 'completed';
  }
  return state;
}

const MEMORY_FACT_BLOCK_RE =
  /【\s*记忆\s*[:：]\s*结构化表格\s*】([\s\S]*?)(?=【\s*\/\s*记忆\s*】|$)/g;

function tryParseJsonLoose(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const firstArr = raw.match(/\[[\s\S]*\]/);
  if (firstArr) {
    try {
      return JSON.parse(firstArr[0]);
    } catch (_) {}
  }
  const firstObj = raw.match(/\{[\s\S]*\}/);
  if (firstObj) {
    try {
      return JSON.parse(firstObj[0]);
    } catch (_) {}
  }
  return null;
}

export function parseMemoryFactBlock(rawText = '') {
  const text = String(rawText || '');
  const found = [];
  let m;
  const re = new RegExp(MEMORY_FACT_BLOCK_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const body = String(m[1] || '').trim();
    if (!body) continue;
    const parsed = tryParseJsonLoose(body);
    if (!parsed) continue;
    if (Array.isArray(parsed)) found.push(...parsed);
    else found.push(parsed);
  }
  return found.filter((x) => x && typeof x === 'object');
}

function hasExplicitEmptyMemoryFactBlock(rawText = '') {
  const text = String(rawText || '');
  let match;
  const re = new RegExp(MEMORY_FACT_BLOCK_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    const parsed = tryParseJsonLoose(String(match[1] || '').trim());
    if (Array.isArray(parsed) && parsed.length === 0) return true;
  }
  return false;
}

export function stripMemoryFactBlocks(text = '') {
  return String(text || '')
    .replace(new RegExp(MEMORY_FACT_BLOCK_RE.source, 'g'), '')
    .replace(/【\s*记忆\s*[:：]\s*结构化表格\s*】/g, '')
    .replace(/【\s*\/\s*记忆\s*】/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 把「用户/我」这类占位 + 用户当前档位的真实昵称/姓名都指向 'user'，否则角色用用户
// 真实昵称提到用户本人时（比如"N喜欢……"），这个名字在角色表里查不到，就会被当成
// 一个陌生「人物」误建出一个不存在的角色记忆馆。
async function buildStoredCharacterNameMap(userId = '') {
  const out = new Map();
  out.set('user', 'user');
  out.set('用户', 'user');
  out.set('我', 'user');
  out.set('匿名用户', 'user');
  out.set('匿名网友', 'user');
  const uid = String(userId || '').trim();
  if (uid) {
    const userRow = await db.getRecord('users', uid).catch(() => null);
    if (userRow) {
      const user = normalizeUserRecord(userRow);
      for (const label of [user.name, user.nickname]) {
        const trimmed = String(label || '').trim();
        if (trimmed && trimmed !== '用户' && trimmed !== '我') out.set(trimmed, 'user');
      }
    }
  }
  const chars = await listCharacters({ excludeAnonNpc: true });
  for (const c of chars) {
    const names = [c.id, c.name, c.realName, c.customNickname, ...(Array.isArray(c.aliases) ? c.aliases : [])]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    for (const name of names) out.set(name, c.id);
  }
  return out;
}

/**
 * 把结构化事实里的人名字段解析成内部 id。
 * 解析不出来（既不是占位称呼，也不在已知角色/用户名单里）时故意返回空字符串，而不是
 * 把原始文本本身当成 id 兜底——那样会把 LLM 写错/写混的人名（曾用名、外号、甚至幻觉出
 * 的一句话）直接变成一个凭空捏造的"角色"，污染记忆馆角色列表（真实角色 id 见
 * memory-scope.js#realCharacterIdSet）。解析不出来的名字依然保留在 subjectName/objectName
 * 里用于展示，只是不会被当成可归属的角色 id。
 */
export function resolveEntityId(rawName = '', chat = null, nameMap = new Map()) {
  const name = String(rawName || '').trim();
  if (!name) return '';
  if (name === 'user' || name === '用户' || name === '我' || name === '匿名用户' || name === '匿名网友') return 'user';
  if (chat && isAnonymousChat(chat)) {
    const anon = resolveAnonymousActorId(chat, name);
    if (anon) return anon;
  }
  // 轻量 NPC / 手机联系人不一定在 characters 表，但当前会话参与者里的精确 id 仍是可信身份。
  const chatActorId = (Array.isArray(chat?.participants) ? chat.participants : [])
    .map((id) => String(id || '').trim())
    .find((id) => id && id !== 'user' && id === name);
  if (chatActorId) return chatActorId;
  return nameMap.get(name) || '';
}

function normalizeKnownBy(raw, chat = null, nameMap = new Map()) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = resolveEntityId(k, chat, nameMap);
    if (!id) continue;
    out[id] = String(v || '').trim() || 'known';
  }
  return out;
}

function inferScope(chat, fact = {}) {
  const raw = String(fact.scope || '').trim();
  if (raw) return raw;
  if (isAnonymousChat(chat)) {
    if (chat?.type === 'private') return MEMORY_FACT_SCOPES.anonymous_private;
    return MEMORY_FACT_SCOPES.anonymous_room;
  }
  if (isStrangerInterceptChat(chat)) return MEMORY_FACT_SCOPES.account_alias;
  return MEMORY_FACT_SCOPES.normal_chat;
}

function linkedKeysForStrangerChat(chat, {
  subjectId = '',
  objectId = '',
} = {}) {
  if (!isStrangerInterceptChat(chat)) return [];
  return [...new Set([
    ...Object.keys(chat.metadata?.accountIdentityMap || {})
      .filter((key) => String(key).startsWith('character:') && String(chat.metadata.accountIdentityMap[key] || '').trim()),
    ...(Array.isArray(chat.participants) ? chat.participants : [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== 'user')
      .map((id) => principalKey('character', id)),
    subjectId && subjectId !== 'user' ? principalKey('character', subjectId) : '',
    objectId && objectId !== 'user' ? principalKey('character', objectId) : '',
  ].filter(Boolean))];
}

function normalizeFactEntityNames({
  subjectId = '',
  subjectName = '',
  objectId = '',
  objectName = '',
  userDisplayName = '用户',
  preserveUserAliasName = false,
} = {}) {
  const display = String(userDisplayName || '用户').trim() || '用户';
  let subject = String(subjectName || '').trim();
  let object = String(objectName || '').trim();
  if (!preserveUserAliasName && (subjectId === 'user' || isUserPlaceholderLabel(subject))) {
    subject = normalizeUserFacingLabel(subject, display);
  }
  if (!preserveUserAliasName && (objectId === 'user' || isUserPlaceholderLabel(object))) {
    object = normalizeUserFacingLabel(object, display);
  }
  return { subjectName: subject, objectName: object };
}

function dedupSourceChatId(fact = {}) {
  const chatId = String(fact.chatId || '').trim();
  const sourceChatId = String(fact.sourceChatId || '').trim();
  // 普通聊天的实时提取会把当前 chatId 同时写进 sourceChatId；总结提取只写 chatId。
  // 两者表示的是同一来源，不应因此拆成两条。匿名跳转等真正的跨窗来源仍保留。
  return sourceChatId && sourceChatId !== chatId ? sourceChatId : '';
}

function buildDedupKey(fact) {
  const text = String(fact.content || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return [
    fact.userId,
    fact.scope,
    fact.chatId,
    dedupSourceChatId(fact),
    fact.subjectId,
    fact.objectId,
    normalizeMemoryFactType(fact.factType),
    text,
  ].join('|');
}

function buildCanonicalDedupKey(fact) {
  const canonicalKey = normalizeMemoryFactCanonicalKey(fact?.canonicalKey || fact?.memoryKey);
  if (!canonicalKey) return '';
  return [
    fact.userId,
    fact.scope,
    fact.chatId,
    dedupSourceChatId(fact),
    fact.subjectId,
    fact.objectId,
    normalizeMemoryFactType(fact.factType),
    canonicalKey,
  ].join('|');
}

function stableMemoryFactHash(value = '') {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function mergeEvolutionEvidence(...groups) {
  const bySource = new Map();
  for (const item of groups.flat()) {
    const sourceKey = String(item?.sourceKey || '').trim();
    const at = Number(item?.at || 0) || 0;
    if (!sourceKey || at <= 0) continue;
    bySource.set(sourceKey, { sourceKey, at });
  }
  return [...bySource.values()].sort((left, right) => left.at - right.at).slice(-20);
}

export function buildMemoryFactExtractionId({
  userId = '',
  chatId = '',
  sourceKey = '',
  canonicalKey = '',
  index = 0,
} = {}) {
  const source = String(sourceKey || '').trim();
  if (!source) return '';
  const canonical = normalizeMemoryFactCanonicalKey(canonicalKey);
  const slot = canonical ? `key:${canonical}` : `index:${Math.max(0, Math.trunc(Number(index) || 0))}`;
  const sourceHash = stableMemoryFactHash(`${userId}|${chatId}|${source}`);
  return `mf_extract_${sourceHash}_${stableMemoryFactHash(slot)}`;
}

async function upsertSingleMemoryFact(payload = {}) {
  const uid = String(payload.userId || '').trim();
  let userDisplayName = '用户';
  if (uid) {
    const userRow = await db.getRecord('users', uid).catch(() => null);
    userDisplayName = getUserDisplayName(normalizeUserRecord(userRow || {}));
  }
  const names = normalizeFactEntityNames({
    subjectId: String(payload.subjectId || '').trim(),
    subjectName: String(payload.subjectName || '').trim(),
    objectId: String(payload.objectId || '').trim(),
    objectName: String(payload.objectName || '').trim(),
    userDisplayName,
    preserveUserAliasName: String(payload.scope || '').trim() === MEMORY_FACT_SCOPES.account_alias,
  });
  const fact = createMemoryFact({ ...payload, ...names });
  if (fact.factType === 'alias_awareness') {
    const awareness = normalizeAliasAwareness(fact);
    if (!awareness.accountId || !awareness.awareCharacterId
      || !awareness.awarenessLevel || !awareness.provenance.source) {
      return null;
    }
  }
  const isPublicFeed = String(fact.scope || '').trim() === 'public_feed'
    || String(fact.id || '').startsWith('mf_moment_');
  // public_feed moments are cross-chat; empty chatId is intentional.
  if (!fact.userId || !fact.content) return null;
  if (!fact.chatId && !isPublicFeed) return null;
  if (await shouldSuppressDeletedMemory('memoryFacts', fact)) return null;
  const all = await db.getAllByIndex('memoryFacts', 'userId', fact.userId);
  const key = buildDedupKey(fact);
  const canonicalKey = buildCanonicalDedupKey(fact);
  const existingById = fact.id
    ? (Array.isArray(all) ? all : []).find((row) => String(row?.id || '') === fact.id)
    : null;
  const existingByCanonicalKey = canonicalKey
    ? (Array.isArray(all) ? all : []).find((row) => buildCanonicalDedupKey(row) === canonicalKey)
    : null;
  const existing = existingById
    || existingByCanonicalKey
    || (Array.isArray(all) ? all : []).find((row) => buildDedupKey(row) === key);
  if (existing) {
    // 朋友圈可见范围、@ 角色和来源聊天都可能在编辑后变化。
    // public_feed 必须用本次完整账本覆盖，不能 merge 后留下已被屏蔽角色的旧知情权。
    const publicFeedIdentity = isPublicFeed ? {
      chatId: fact.chatId,
      sourceChatId: fact.sourceChatId,
      subjectId: fact.subjectId,
      subjectName: fact.subjectName,
      objectId: fact.objectId,
      objectName: fact.objectName,
      knownBy: fact.knownBy,
      provenance: fact.provenance,
    } : {};
    const next = createMemoryFact({
      ...existing,
      ...publicFeedIdentity,
      evidence: fact.evidence || existing.evidence,
      confidence: Math.max(Number(existing.confidence || 0), Number(fact.confidence || 0)),
      visibility: fact.visibility || existing.visibility,
      knownBy: isPublicFeed
        ? fact.knownBy
        : { ...(existing.knownBy || {}), ...(fact.knownBy || {}) },
      tags: [...new Set([...(existing.tags || []), ...(fact.tags || [])])].slice(0, 12),
      sourceMessageIds: [...new Set([...(existing.sourceMessageIds || []), ...(fact.sourceMessageIds || [])])].slice(0, 20),
      linkedPrincipalKeys: [...new Set([
        ...(Array.isArray(existing.linkedPrincipalKeys) ? existing.linkedPrincipalKeys : []),
        ...(Array.isArray(fact.linkedPrincipalKeys) ? fact.linkedPrincipalKeys : []),
      ])].slice(0, 8),
      principalType: fact.principalType || existing.principalType,
      principalId: fact.principalId || existing.principalId,
      accountId: fact.accountId || existing.accountId,
      awareCharacterId: fact.awareCharacterId || existing.awareCharacterId,
      awarenessLevel: fact.awarenessLevel || existing.awarenessLevel,
      provenance: fact.provenance || existing.provenance,
      ownerId: fact.ownerId || existing.ownerId,
      windowLabel: fact.windowLabel || existing.windowLabel,
      digest: fact.digest || existing.digest,
      revealState: fact.revealState || existing.revealState,
      // Prefer explicit new temporalState (moments force completed); else keep prior.
      // Same-event re-mention: latest temporalState wins (e.g. promise ongoing → completed).
      temporalState: fact.temporalState || existing.temporalState,
      expiresAt: Number(fact.expiresAt || existing.expiresAt || 0) || 0,
      scope: fact.scope || existing.scope,
      canonicalKey: fact.canonicalKey || existing.canonicalKey,
      content: fact.content || existing.content,
      subjectId: fact.subjectId || existing.subjectId,
      subjectName: fact.subjectName || existing.subjectName,
      extractionSourceKeys: [...new Set([
        ...(Array.isArray(existing.extractionSourceKeys) ? existing.extractionSourceKeys : []),
        ...(Array.isArray(fact.extractionSourceKeys) ? fact.extractionSourceKeys : []),
      ])].slice(0, 12),
      evidenceTimestamps: [...new Set([
        ...(Array.isArray(existing.evidenceTimestamps) ? existing.evidenceTimestamps : []),
        ...(Array.isArray(fact.evidenceTimestamps) ? fact.evidenceTimestamps : []),
      ].map((value) => Number(value) || 0).filter((value) => value > 0))]
        .sort((a, b) => a - b)
        .slice(-20),
      evolutionEvidence: mergeEvolutionEvidence(
        Array.isArray(existing.evolutionEvidence) ? existing.evolutionEvidence : [],
        Array.isArray(fact.evolutionEvidence) ? fact.evolutionEvidence : [],
      ),
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    });
    await db.putRecord('memoryFacts', next);
    enqueueVectorSource('fact', next).catch(() => {});
    return next;
  }
  await db.putRecord('memoryFacts', fact);
  enqueueVectorSource('fact', fact).catch(() => {});
  return fact;
}

export async function upsertMemoryFacts(payload = {}) {
  const parts = splitMemoryFactContent(payload.content);
  if (!parts.length) return [];
  const baseId = String(payload.id || '').trim();
  const saved = [];
  for (let index = 0; index < parts.length; index += 1) {
    const id = baseId
      ? (index === 0 ? baseId : `${baseId}__part_${index + 1}`)
      : '';
    const row = await upsertSingleMemoryFact({
      ...payload,
      ...(id ? { id } : {}),
      content: parts[index],
    });
    if (row) saved.push(row);
  }
  return saved;
}

/**
 * 保持旧调用方的单条返回值契约；长内容会完整拆成多条落库，并返回第一条。
 */
export async function upsertMemoryFact(payload = {}) {
  const saved = await upsertMemoryFacts(payload);
  return saved[0] || null;
}

/** Phase 4 可直接调用：按 user-slot + account + 知情角色唯一 upsert。 */
export async function upsertAliasAwareness({
  userId = '',
  accountId = '',
  awareCharacterId = '',
  awarenessLevel = '',
  confidence,
  provenance = null,
  ownerId = '',
  accountLabel = '',
} = {}) {
  const uid = cleanAliasField(userId);
  const normalized = normalizeAliasAwareness({
    accountId,
    awareCharacterId,
    awarenessLevel,
    confidence,
    provenance,
  });
  if (!uid || !normalized.accountId || !normalized.awareCharacterId
    || !normalized.awarenessLevel || !normalized.provenance.source) {
    throw new Error('马甲知情记录缺少 userId/accountId/知情角色/层级或 provenance');
  }
  if (await isAliasAccountRevoked(normalized.accountId, { userId: uid })) return null;
  const all = await db.getAllByIndex('memoryFacts', 'userId', uid);
  const existing = (Array.isArray(all) ? all : []).find((fact) => (
    fact?.factType === 'alias_awareness'
    && String(fact.accountId || '') === normalized.accountId
    && String(fact.awareCharacterId || '') === normalized.awareCharacterId
  ));
  const prior = normalizeAliasAwareness(existing || {});
  const nextLevel = (ALIAS_AWARENESS_LEVEL_RANK[prior.awarenessLevel] || 0)
    > (ALIAS_AWARENESS_LEVEL_RANK[normalized.awarenessLevel] || 0)
    ? prior.awarenessLevel
    : normalized.awarenessLevel;
  const nextProvenance = nextLevel === prior.awarenessLevel && existing?.provenance
    ? existing.provenance
    : normalized.provenance;
  const label = cleanAliasField(accountLabel || existing?.subjectName || '前台账户', 60);
  const fact = await upsertMemoryFact({
    id: existing?.id || `mf_alias_awareness_${encodeURIComponent(normalized.accountId)}_${encodeURIComponent(normalized.awareCharacterId)}`,
    userId: uid,
    chatId: nextProvenance.sourceChatId || `alias_awareness_${normalized.accountId}`,
    sourceChatId: nextProvenance.sourceChatId,
    scope: MEMORY_FACT_SCOPES.account_alias,
    subjectId: normalized.awareCharacterId,
    subjectName: label,
    factType: 'alias_awareness',
    content: formatAliasAwarenessRecap({
      ...normalized,
      awarenessLevel: nextLevel,
      provenance: nextProvenance,
    }, { displayName: label }),
    evidence: nextProvenance.note || '马甲知情账本',
    confidence: Math.max(Number(existing?.confidence || 0), normalized.confidence),
    visibility: 'private',
    knownBy: { [normalized.awareCharacterId]: true },
    accountId: normalized.accountId,
    awareCharacterId: normalized.awareCharacterId,
    awarenessLevel: nextLevel,
    provenance: nextProvenance,
    ownerId: cleanAliasField(ownerId || existing?.ownerId),
    principalType: 'character',
    principalId: normalized.awareCharacterId,
    linkedPrincipalKeys: [principalKey('character', normalized.awareCharacterId)],
    tags: ['马甲知情', nextLevel],
    temporalState: 'evergreen',
  });
  return fact;
}

export async function listAliasAwareness({
  userId = '',
  awareCharacterId = '',
  accountId = '',
} = {}) {
  const uid = cleanAliasField(userId);
  if (!uid) return [];
  const rows = await db.getAllByIndex('memoryFacts', 'userId', uid);
  return filterAliasAwarenessRows(rows, { userId: uid, awareCharacterId, accountId });
}

export function filterAliasAwarenessRows(rows = [], {
  userId = '',
  awareCharacterId = '',
  accountId = '',
} = {}) {
  const uid = cleanAliasField(userId);
  return (Array.isArray(rows) ? rows : [])
    .filter((fact) => !uid || String(fact.userId || '') === uid)
    .filter((fact) => fact?.factType === 'alias_awareness')
    .filter((fact) => !awareCharacterId || String(fact.awareCharacterId || '') === String(awareCharacterId))
    .filter((fact) => !accountId || String(fact.accountId || '') === String(accountId))
    .filter((fact) => normalizeAliasAwareness(fact).provenance.source)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function recordAliasWindowDigest({
  userId = '',
  ownerId = '',
  accountId = '',
  chatId = '',
  displayName = '',
  windowLabel = '',
  digest = '',
} = {}) {
  const uid = cleanAliasField(userId);
  const cid = cleanAliasField(ownerId);
  const aid = cleanAliasField(accountId);
  const threadId = cleanAliasField(chatId);
  const compact = String(digest || '').trim().slice(0, 600);
  if (!uid || !cid || !aid || !threadId || !compact) return null;
  if (await isAliasAccountRevoked(aid, { userId: uid, ownerId: cid })) return null;
  return upsertMemoryFact({
    id: `mf_alias_digest_${encodeURIComponent(uid)}_${encodeURIComponent(cid)}_${encodeURIComponent(aid)}_${encodeURIComponent(threadId)}`,
    userId: uid,
    chatId: threadId,
    sourceChatId: threadId,
    scope: MEMORY_FACT_SCOPES.account_alias,
    subjectId: cid,
    subjectName: cleanAliasField(displayName || '马甲', 60),
    factType: 'alias_window_digest',
    content: compact,
    evidence: '仅由该马甲窗口近期消息生成的无原文结构摘要',
    confidence: 1,
    visibility: 'private',
    knownBy: { [cid]: true },
    principalType: 'character',
    principalId: cid,
    ownerId: cid,
    accountId: aid,
    windowLabel: cleanAliasField(windowLabel, 40),
    digest: compact,
    linkedPrincipalKeys: [principalKey('character', cid)],
    tags: ['马甲', '窗口摘要', '私有清单'],
    temporalState: 'evergreen',
  });
}

export async function listAliasWindowDigests({ userId = '', ownerId = '' } = {}) {
  const uid = cleanAliasField(userId);
  const cid = cleanAliasField(ownerId);
  if (!uid || !cid) return [];
  const rows = await db.getAllByIndex('memoryFacts', 'userId', uid);
  return filterAliasWindowDigestRows(rows, { userId: uid, ownerId: cid });
}

export function filterAliasWindowDigestRows(rows = [], { userId = '', ownerId = '' } = {}) {
  const uid = cleanAliasField(userId);
  const cid = cleanAliasField(ownerId);
  return (Array.isArray(rows) ? rows : [])
    .filter((fact) => !uid || String(fact.userId || '') === uid)
    .filter((fact) => fact?.factType === 'alias_window_digest' && String(fact.ownerId || fact.principalId || '') === cid)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

/** 角色开/用自己的马甲时写入，供主会话召回「我有这个小号」。 */
export async function recordCharacterAliasAccountFact({
  userId = '',
  characterId = '',
  accountId = '',
  displayName = '',
  handle = '',
  motive = '',
  chatId = '',
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const aid = String(accountId || '').trim();
  if (!uid || !cid || !aid) return null;
  if (await isAliasAccountRevoked(aid, { userId: uid, ownerId: cid })) return null;
  const name = String(displayName || '陌生账号').trim().slice(0, 60) || '陌生账号';
  const handleText = String(handle || '').trim().slice(0, 60);
  const motiveText = String(motive || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const content = [
    `我私下拥有社交马甲「${name}」${handleText ? `（ID/账号：${handleText}）` : ''}。`,
    motiveText ? `开号动机：${motiveText}` : '',
  ].filter(Boolean).join('');
  const fact = await upsertMemoryFact({
    id: `mf_alias_self_${aid}`,
    userId: uid,
    chatId: String(chatId || '').trim() || `alias_self_${aid}`,
    sourceChatId: String(chatId || '').trim(),
    scope: MEMORY_FACT_SCOPES.account_alias,
    subjectId: cid,
    subjectName: name,
    factType: '马甲身份',
    content,
    evidence: '角色主动开立/使用社交马甲',
    confidence: 1,
    visibility: 'private',
    knownBy: { [cid]: true },
    principalType: 'character',
    principalId: cid,
    accountId: aid,
    revealState: 'hidden',
    linkedPrincipalKeys: [principalKey('character', cid)],
    tags: ['马甲', '小号', '私下身份'],
    temporalState: 'evergreen',
  });
  // 本体对自己账户的知情永远存在；旧账户补事实时也会自动修复这条账本记录。
  await upsertAliasAwareness({
    userId: uid,
    accountId: aid,
    awareCharacterId: cid,
    awarenessLevel: 'knows_purpose',
    confidence: 1,
    provenance: {
      source: 'observed',
      sourceChatId: String(chatId || '').trim(),
      note: '该角色亲自创建或使用此账户',
    },
    ownerId: cid,
    accountLabel: name,
  });
  return fact;
}

export async function recordUserAliasContactFact({
  userId = '',
  chatId = '',
  accountId = '',
  aliasName = '',
  characterId = '',
  messageId = '',
  messageText = '',
  blocked = false,
  blockedAttemptCount = 0,
  blockReason = '',
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const aid = String(accountId || '').trim();
  const threadId = String(chatId || '').trim();
  if (!uid || !cid || !aid || !threadId) return null;
  const displayName = String(aliasName || '陌生账号').trim().slice(0, 60) || '陌生账号';
  const attempts = Math.max(0, Number(blockedAttemptCount) || 0);
  const excerpt = String(messageText || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const content = blocked
    ? `角色已拉黑陌生账号“${displayName}”${blockReason ? `，原因：${String(blockReason).trim().slice(0, 120)}` : ''}${attempts ? `；拉黑后另有 ${attempts} 次发送尝试被系统拒收，正文不可见` : ''}。`
    : `陌生账号“${displayName}”曾主动联系并发来：“${excerpt}”。`;
  if (!blocked && !excerpt) return null;
  return upsertMemoryFact({
    id: blocked ? `mf_alias_block_${threadId}` : `mf_alias_msg_${String(messageId || Date.now()).trim()}`,
    userId: uid,
    chatId: threadId,
    sourceChatId: threadId,
    scope: MEMORY_FACT_SCOPES.account_alias,
    subjectId: 'user',
    subjectName: displayName,
    factType: blocked ? '陌生账号拦截' : '陌生账号接触',
    content,
    evidence: blocked ? '角色在陌生消息线程中执行拉黑' : '该陌生账号已送达的聊天消息',
    confidence: 1,
    visibility: 'private',
    knownBy: { [cid]: true },
    principalType: 'user',
    principalId: uid,
    accountId: aid,
    revealState: 'hidden',
    linkedPrincipalKeys: [`character:${cid}`],
    tags: blocked ? ['陌生账号', '骚扰', '已拉黑'] : ['陌生账号', '话术样本'],
    sourceMessageIds: messageId ? [String(messageId)] : [],
  });
}

export async function persistMemoryFactsFromRaw({
  rawText = '',
  userId = '',
  chat = null,
  defaultChatId = '',
  sourceKey = '',
  defaultEvidenceAt = 0,
} = {}) {
  const uid = String(userId || '').trim();
  const chatId = String(chat?.id || defaultChatId || '').trim();
  if (!uid || !chatId) return { stored: 0 };
  const parsed = parseMemoryFactBlock(rawText);
  const extractionKey = String(sourceKey || '').trim();
  if (!parsed.length && !(extractionKey && hasExplicitEmptyMemoryFactBlock(rawText))) {
    return { stored: 0 };
  }
  const nameMap = await buildStoredCharacterNameMap(uid);
  const userRow = await db.getRecord('users', uid).catch(() => null);
  const userDisplayName = getUserDisplayName(normalizeUserRecord(userRow || {}));
  let stored = 0;
  let removed = 0;
  const activeIds = new Set();
  for (let itemIndex = 0; itemIndex < parsed.length; itemIndex += 1) {
    const item = parsed[itemIndex];
    const content = String(item.content || item.fact || item.summary || '').trim();
    if (!content) continue;
    // subjectId/objectId 同样来自模型输出，不能因为字段名叫 id 就直接信任。
    // 旧逻辑会把模型写进这里的人名、乱码或一句话原样落库，继而在记忆馆生成幽灵角色。
    const subjectId = resolveEntityId(String(item.subjectId || '').trim(), chat, nameMap)
      || resolveEntityId(
      String(item.subjectName || item.subject || '').trim(),
      chat,
      nameMap,
    );
    const objectId = resolveEntityId(String(item.objectId || '').trim(), chat, nameMap)
      || resolveEntityId(
      String(item.objectName || item.object || '').trim(),
      chat,
      nameMap,
    );
    const names = normalizeFactEntityNames({
      subjectId,
      subjectName: String(item.subjectName || item.subject || '').trim(),
      objectId,
      objectName: String(item.objectName || item.object || '').trim(),
      userDisplayName,
    });
    const sourceChatId = String(
      item.sourceChatId
      || chat?.metadata?.sourceAnonymousChatId
      || chat?.anonymousPrivateConfig?.sourceContext?.sourceChatId
      || '',
    ).trim();
    const scope = inferScope(chat, item);
    const aliasLinked = scope === MEMORY_FACT_SCOPES.account_alias
      ? linkedKeysForStrangerChat(chat, { subjectId, objectId })
      : [];
    const canonicalKey = normalizeMemoryFactCanonicalKey(item.canonicalKey || item.memoryKey);
    const extractionId = buildMemoryFactExtractionId({
      userId: uid,
      chatId,
      sourceKey: extractionKey,
      canonicalKey,
      index: itemIndex,
    });
    const saved = await upsertMemoryFact({
      ...item,
      ...(extractionId ? { id: extractionId } : {}),
      userId: uid,
      chatId,
      sourceChatId,
      scope,
      subjectId,
      subjectName: names.subjectName,
      objectId,
      objectName: names.objectName,
      canonicalKey,
      content,
      knownBy: normalizeKnownBy(item.knownBy, chat, nameMap),
      extractionSourceKeys: extractionKey ? [extractionKey] : [],
      evidenceTimestamps: normalizeMemoryFactType(item.factType) === 'character_evolution_signal'
        ? [Number(item.evidenceAt || defaultEvidenceAt || 0)].filter((value) => value > 0)
        : [],
      evolutionEvidence: normalizeMemoryFactType(item.factType) === 'character_evolution_signal'
        && extractionKey
        && Number(item.evidenceAt || defaultEvidenceAt || 0) > 0
        ? [{ sourceKey: extractionKey, at: Number(item.evidenceAt || defaultEvidenceAt) }]
        : [],
      anonymousRoomId: String(item.anonymousRoomId || chat?.metadata?.anonymousRoomId || '').trim(),
      ...(aliasLinked.length ? {
        linkedPrincipalKeys: [...new Set([
          ...(Array.isArray(item.linkedPrincipalKeys) ? item.linkedPrincipalKeys : []),
          ...aliasLinked,
        ])],
      } : {}),
      updatedAt: Date.now(),
    });
    if (saved) {
      stored += 1;
      activeIds.add(saved.id);
    }
  }

  if (extractionKey) {
    const allFacts = await db.getAllByIndex('memoryFacts', 'userId', uid);
    const staleFacts = (Array.isArray(allFacts) ? allFacts : []).filter((fact) => (
      Array.isArray(fact?.extractionSourceKeys)
      && fact.extractionSourceKeys.includes(extractionKey)
      && !activeIds.has(fact.id)
    ));
    const deleteIds = [];
    const updateRows = [];
    for (const fact of staleFacts) {
      const nextKeys = fact.extractionSourceKeys.filter((key) => key !== extractionKey);
      if (!nextKeys.length && String(fact.id || '').startsWith('mf_extract_')) {
        deleteIds.push(fact.id);
      } else {
        const hadEvolutionEvidence = Array.isArray(fact.evolutionEvidence) && fact.evolutionEvidence.length > 0;
        const evolutionEvidence = (Array.isArray(fact.evolutionEvidence) ? fact.evolutionEvidence : [])
          .filter((item) => String(item?.sourceKey || '').trim() !== extractionKey);
        updateRows.push({
          ...fact,
          extractionSourceKeys: nextKeys,
          evolutionEvidence,
          evidenceTimestamps: hadEvolutionEvidence
            ? evolutionEvidence.map((item) => Number(item.at || 0)).filter((value) => value > 0)
            : (Array.isArray(fact.evidenceTimestamps) ? fact.evidenceTimestamps : []),
          updatedAt: Date.now(),
        });
      }
    }
    if (updateRows.length) await db.putMany('memoryFacts', updateRows);
    if (deleteIds.length) {
      await db.deleteMany('memoryFacts', deleteIds);
      await deleteVectorSources('fact', deleteIds).catch(() => {});
      removed = deleteIds.length;
    }
  }
  return { stored, removed };
}

function factTouchesCharacters(fact, characterIds = []) {
  const ids = new Set((characterIds || []).filter(Boolean));
  if (!ids.size) return true;
  if (ids.has(fact.subjectId) || ids.has(fact.objectId)) return true;
  const kb = fact.knownBy && typeof fact.knownBy === 'object' ? fact.knownBy : {};
  return [...ids].some((id) => kb[id] && kb[id] !== 'none');
}

function factKnownByAllCharacters(fact, characterIds = []) {
  const ids = (characterIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length <= 1) return factTouchesCharacters(fact, ids);
  const knownBy = fact?.knownBy && typeof fact.knownBy === 'object' ? fact.knownBy : {};
  return ids.every((id) => {
    const level = knownBy[id];
    return level === true || ['heard', 'known', 'involved', 'shared'].includes(String(level || ''));
  });
}

function isAliasIdentityInventoryFact(fact = {}) {
  const id = String(fact?.id || '');
  const type = String(fact?.factType || '').trim();
  return id.startsWith('mf_alias_self_')
    || type === '马甲身份'
    || type === 'alias_window_digest';
}

function resolveCurrentAliasAccountId(chat = null, options = {}) {
  const explicit = String(options.currentAccountId || '').trim();
  if (explicit) return explicit;
  if (!isStrangerInterceptChat(chat)) return '';
  const map = chat?.metadata?.accountIdentityMap || {};
  const characterIds = (options.characterIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  for (const cid of characterIds) {
    const aid = String(map[`character:${cid}`] || '').trim();
    if (aid) return aid;
  }
  return Object.values(map).map((id) => String(id || '').trim()).find(Boolean) || '';
}

function factAllowedInContext(fact, options = {}) {
  const { chat = null, characterIds = [], extraChatIds = [], sharedChatIds = [] } = options;
  if (!fact?.content) return false;
  if (String(fact.scope || '').trim() === 'public_feed') {
    return factTouchesCharacters(fact, characterIds);
  }
  if (String(fact.scope || '').trim() === MEMORY_FACT_SCOPES.account_alias) {
    const linked = new Set(Array.isArray(fact.linkedPrincipalKeys) ? fact.linkedPrincipalKeys : []);
    const ownerIds = (characterIds || []).map((id) => String(id || '').trim()).filter(Boolean);
    const factAccountId = String(fact.accountId || '').trim();
    const currentAccountId = resolveCurrentAliasAccountId(chat, options);
    const chatId = String(chat?.id || '').trim();

    // 马甲窗硬墙：只放行本窗 accountId / 本 chatId，禁止多小号记忆互串
    if (currentAccountId || isStrangerInterceptChat(chat)) {
      // 同一主人可看见其它号的清单/摘要，但只能以专用格式作为幕后库存，绝不当作本窗连续记忆。
      if (isAliasIdentityInventoryFact(fact)
        && ownerIds.includes(String(fact.ownerId || fact.principalId || '').trim())) {
        return true;
      }
      if (factAccountId && currentAccountId && factAccountId !== currentAccountId) return false;
      if (chatId && (fact.chatId === chatId || fact.sourceChatId === chatId)) return true;
      if (factAccountId && factAccountId === currentAccountId && isAliasIdentityInventoryFact(fact)) {
        return factTouchesCharacters(fact, characterIds);
      }
      return false;
    }

    // 主会话：只放行「身份清单」级事实；对话剧情不跨窗灌入，防串号幻觉
    if (!isAliasIdentityInventoryFact(fact)) return false;
    if (ownerIds.some((id) => linked.has(`character:${id}`))) {
      return factTouchesCharacters(fact, characterIds);
    }
    if (
      String(fact.principalType || '').trim() === 'character'
      && ownerIds.includes(String(fact.principalId || '').trim())
    ) {
      return true;
    }
    return false;
  }
  const chatId = String(chat?.id || '').trim();
  const extraSet = new Set((Array.isArray(extraChatIds) ? extraChatIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  const sharedSet = new Set((Array.isArray(sharedChatIds) ? sharedChatIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (sharedSet.has(String(fact.chatId || '').trim()) || sharedSet.has(String(fact.sourceChatId || '').trim())) {
    return true;
  }
  if (extraSet.has(String(fact.chatId || '').trim()) || extraSet.has(String(fact.sourceChatId || '').trim())) {
    return factKnownByAllCharacters(fact, characterIds);
  }
  // 没有具体会话上下文时（朋友圈/匿名空间等跨会话聚合生成场景），必须按 characterIds 过滤，
  // 否则会把用户名下所有角色的事实碎片一股脑塞给当前这一个角色，造成"串记忆"。
  if (!chatId) return factTouchesCharacters(fact, characterIds);
  if (fact.chatId === chatId) {
    const audience = (characterIds || []).map((id) => String(id || '').trim()).filter(Boolean);
    const knownBy = fact?.knownBy && typeof fact.knownBy === 'object' ? fact.knownBy : {};
    // 群 prompt 共用：有显式知情账本时只放行全员共同已知；无账本的旧群公屏事实保留兼容。
    if (chat?.type === 'group' && audience.length > 1 && Object.keys(knownBy).length) {
      return factKnownByAllCharacters(fact, audience);
    }
    return true;
  }
  const sourceChatId = String(
    chat?.metadata?.sourceAnonymousChatId
    || chat?.anonymousPrivateConfig?.sourceContext?.sourceChatId
    || '',
  ).trim();
  if (sourceChatId && (fact.chatId === sourceChatId || fact.sourceChatId === sourceChatId)) return true;
  if (isAnonymousChat(chat) && chat?.type === 'group' && fact.sourceChatId === chatId) {
    return factTouchesCharacters(fact, characterIds);
  }
  return false;
}

export async function listMemoryFactsForContext({
  userId = '',
  chat = null,
  characterIds = [],
  extraChatIds = [],
  sharedChatIds = [],
  limit = 12,
  queryText = '',
  semanticScore = lexicalTimelineSimilarity,
  minimumRelevance = 0,
  now = Date.now(),
} = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const allRows = await db.getAllByIndex('memoryFacts', 'userId', uid);
  const all = await filterAndPruneOrphanedAliasFacts(allRows, uid);
  const cap = Math.max(0, Math.min(30, Number(limit) || 0));
  if (!cap) return [];
  const query = String(queryText || '').trim();
  const ownerIds = (characterIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  const currentAccountId = resolveCurrentAliasAccountId(chat, { characterIds });
  const baseAllowed = (Array.isArray(all) ? all : [])
    .filter((fact) => factAllowedInContext(fact, {
      chat,
      characterIds,
      extraChatIds,
      sharedChatIds,
      currentAccountId,
    }));
  const baseIds = new Set(baseAllowed.map((fact) => fact.id));
  // 兼容旧数据：仅在「当前马甲窗」内，把同 chatId 的早期 account_alias 孤儿事实补回来
  let ownerRecallExtra = [];
  if (ownerIds.length && (currentAccountId || isStrangerInterceptChat(chat))) {
    const orphans = (Array.isArray(all) ? all : []).filter((fact) => (
      !baseIds.has(fact?.id)
      && String(fact?.scope || '').trim() === MEMORY_FACT_SCOPES.account_alias
      && String(fact?.chatId || '').trim()
    ));
    if (orphans.length) {
      const chatIds = [...new Set(orphans.map((fact) => String(fact.chatId || '').trim()).filter(Boolean))];
      const sourceChats = await Promise.all(chatIds.map((id) => db.getRecord('chats', id).catch(() => null)));
      const allowedChatIds = new Set(
        sourceChats
          .filter((row) => row?.id && canStrangerChatShareMemory(row, {
            ownerCharacterIds: ownerIds,
            currentAccountId,
          }))
          .map((row) => String(row.id || '').trim())
          .filter(Boolean),
      );
      ownerRecallExtra = orphans.filter((fact) => allowedChatIds.has(String(fact.chatId || '').trim()));
    }
  }
  const allowedRows = [...baseAllowed, ...ownerRecallExtra]
    .filter((fact) => fact && !fact.vectorSupersededBy);
  const recentIds = new Set([...allowedRows]
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
    .slice(0, 2)
    .map((fact) => String(fact.id || '')));
  const floor = Math.max(0, Math.min(1, Number(minimumRelevance) || 0));
  const selected = allowedRows
    .map((fact) => {
      const vectorText = [
        fact.content,
        fact.evidence,
        ...(Array.isArray(fact.tags) ? fact.tags : []),
      ].filter(Boolean).join(' ');
      return {
        fact,
        vectorText,
        relevance: query ? semanticScore(query, vectorText) : 0,
      };
    })
    .filter(({ fact, relevance, vectorText }) => {
      if (!floor || !query) return true;
      if (typeof semanticScore.hasVector === 'function' && !semanticScore.hasVector(vectorText)) return true;
      if (relevance >= floor || recentIds.has(String(fact.id || ''))) return true;
      return ['ongoing', 'planned'].includes(resolveEffectiveTemporalState(fact, now));
    })
    .sort((a, b) => b.relevance - a.relevance
      || (b.fact.updatedAt || 0) - (a.fact.updatedAt || 0))
    .slice(0, cap)
    .map((row) => row.fact);
  return Promise.all(selected.map(async (fact) => {
    if (String(fact.scope || '').trim() !== MEMORY_FACT_SCOPES.account_alias || !fact.accountId) return fact;
    const account = await db.getRecord('aliasAccounts', fact.accountId).catch(() => null);
    if (!account?.displayName) return fact;
    return {
      ...fact,
      ...(fact.subjectId === 'user' ? { subjectName: String(account.displayName).trim().slice(0, 80) } : {}),
      ...(fact.objectId === 'user' ? { objectName: String(account.displayName).trim().slice(0, 80) } : {}),
    };
  }));
}

export async function listMemoryFactsForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  await compactDuplicateMemoryFactsForUser(uid);
  const rows = await db.getAllByIndex('memoryFacts', 'userId', uid);
  const liveRows = await filterAndPruneOrphanedAliasFacts(rows, uid);
  return liveRows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function isManualMemoryFact(row = {}) {
  return String(row.evidence || '').includes('手动')
    || (Array.isArray(row.tags) && row.tags.some((tag) => String(tag || '').includes('手动')));
}

function mergeDuplicateMemoryFact(existing, incoming) {
  const existingManual = isManualMemoryFact(existing);
  const incomingManual = isManualMemoryFact(incoming);
  const incomingIsNewer = Number(incoming.updatedAt || incoming.createdAt || 0)
    >= Number(existing.updatedAt || existing.createdAt || 0);
  const preferred = incomingManual && !existingManual
    ? incoming
    : ((!existingManual && incomingIsNewer) ? incoming : existing);
  return createMemoryFact({
    ...existing,
    factType: normalizeMemoryFactType(existing.factType || incoming.factType),
    canonicalKey: existing.canonicalKey || incoming.canonicalKey,
    content: preferred.content || existing.content || incoming.content,
    evidence: preferred.evidence || existing.evidence || incoming.evidence,
    confidence: Math.max(Number(existing.confidence || 0), Number(incoming.confidence || 0)),
    visibility: preferred.visibility || existing.visibility || incoming.visibility,
    knownBy: { ...(existing.knownBy || {}), ...(incoming.knownBy || {}) },
    tags: [...new Set([...(existing.tags || []), ...(incoming.tags || [])])].slice(0, 12),
    sourceMessageIds: [...new Set([
      ...(existing.sourceMessageIds || []),
      ...(incoming.sourceMessageIds || []),
    ])].slice(0, 20),
    extractionSourceKeys: [...new Set([
      ...(existing.extractionSourceKeys || []),
      ...(incoming.extractionSourceKeys || []),
    ])].slice(0, 12),
    linkedPrincipalKeys: [...new Set([
      ...(existing.linkedPrincipalKeys || []),
      ...(incoming.linkedPrincipalKeys || []),
    ])].slice(0, 8),
    temporalState: preferred.temporalState || existing.temporalState || incoming.temporalState,
    expiresAt: Number(preferred.expiresAt || existing.expiresAt || incoming.expiresAt || 0) || 0,
    createdAt: Math.min(
      Number(existing.createdAt || Date.now()),
      Number(incoming.createdAt || Date.now()),
    ),
    updatedAt: Math.max(
      Number(existing.updatedAt || existing.createdAt || 0),
      Number(incoming.updatedAt || incoming.createdAt || 0),
    ) || Date.now(),
  });
}

/**
 * 兼容旧版双写数据：实时 memory_fact 曾把当前 chatId 重复写入 sourceChatId，
 * 且 factType 使用中文；总结提取则使用空 sourceChatId + 英文类型，导致同一事实成双。
 * 读取记忆馆时做幂等合并，保留手写内容、知情范围与全部提取来源。
 */
export async function compactDuplicateMemoryFactsForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return { merged: 0, normalized: 0 };
  const rows = await db.getAllByIndex('memoryFacts', 'userId', uid);
  if (!Array.isArray(rows) || !rows.length) return { merged: 0, normalized: 0 };

  const ordered = [...rows].sort((left, right) => (
    Number(isManualMemoryFact(right)) - Number(isManualMemoryFact(left))
    || Number(left.createdAt || 0) - Number(right.createdAt || 0)
  ));
  const byIdentity = new Map();
  const survivors = new Map();
  const changedIds = new Set();
  const duplicateIds = [];
  let normalized = 0;

  for (const original of ordered) {
    const normalizedType = normalizeMemoryFactType(original.factType);
    const row = normalizedType === original.factType
      ? original
      : { ...original, factType: normalizedType };
    if (row !== original) {
      normalized += 1;
      changedIds.add(String(row.id || ''));
    }
    const exactKey = `exact:${buildDedupKey(row)}`;
    const canonicalKey = buildCanonicalDedupKey(row);
    const identityKeys = [canonicalKey ? `canonical:${canonicalKey}` : '', exactKey].filter(Boolean);
    const survivorId = identityKeys.map((key) => byIdentity.get(key)).find(Boolean);
    if (!survivorId) {
      survivors.set(row.id, row);
      identityKeys.forEach((key) => byIdentity.set(key, row.id));
      continue;
    }

    const existing = survivors.get(survivorId);
    if (!existing || existing.id === row.id) continue;
    const merged = mergeDuplicateMemoryFact(existing, row);
    survivors.set(survivorId, merged);
    changedIds.add(survivorId);
    duplicateIds.push(row.id);
    identityKeys.forEach((key) => byIdentity.set(key, survivorId));
    const mergedCanonical = buildCanonicalDedupKey(merged);
    byIdentity.set(`exact:${buildDedupKey(merged)}`, survivorId);
    if (mergedCanonical) byIdentity.set(`canonical:${mergedCanonical}`, survivorId);
  }

  const updates = [...changedIds]
    .map((id) => survivors.get(id))
    .filter(Boolean);
  if (updates.length) {
    await db.putMany('memoryFacts', updates);
    updates.forEach((row) => enqueueVectorSource('fact', row).catch(() => {}));
  }
  if (duplicateIds.length) {
    await db.deleteMany('memoryFacts', duplicateIds);
    await deleteVectorSources('fact', duplicateIds);
  }
  return { merged: duplicateIds.length, normalized };
}

export async function deleteMemoryFactsForChat(chatId, userId) {
  const id = String(chatId || '').trim();
  const uid = String(userId || '').trim();
  if (!id || !uid) return 0;
  const rows = await db.getAllByIndex('memoryFacts', 'userId', uid);
  const matched = (Array.isArray(rows) ? rows : []).filter((row) => row?.chatId === id || row?.sourceChatId === id);
  for (const row of matched) {
    if (row?.id) await db.deleteRecord('memoryFacts', row.id);
  }
  return matched.length;
}

/**
 * 删除马甲时级联清掉该身份的事实、知情账本、窗口摘要及对应向量。
 * 只按结构化 accountId / 固定身份事实主键匹配，不用名称模糊删，避免误伤同名角色记忆。
 */
export async function purgeAliasAccountMemory({
  userId = '',
  accountId = '',
} = {}) {
  const uid = String(userId || '').trim();
  const aid = String(accountId || '').trim();
  if (!uid || !aid) return 0;
  const rows = await db.getAllByIndex('memoryFacts', 'userId', uid);
  const identityFactId = `mf_alias_self_${aid}`;
  const matched = (Array.isArray(rows) ? rows : []).filter((row) => (
    String(row?.accountId || '').trim() === aid
    || String(row?.id || '').trim() === identityFactId
  ));
  const sourceIds = matched.map((row) => String(row?.id || '').trim()).filter(Boolean);
  for (const id of sourceIds) {
    await db.deleteRecord('memoryFacts', id);
  }
  await deleteVectorSources('fact', sourceIds);
  return sourceIds.length;
}

async function filterAndPruneOrphanedAliasFacts(rows = [], userId = '') {
  const uid = String(userId || '').trim();
  const list = Array.isArray(rows) ? rows : [];
  const accountScoped = list.filter((row) => (
    String(row?.scope || '').trim() === MEMORY_FACT_SCOPES.account_alias
    && String(row?.accountId || '').trim()
  ));
  if (!uid || !accountScoped.length) return list;
  const accounts = await db.getAllByIndex('aliasAccounts', 'userId', uid).catch(() => []);
  const liveIds = new Set((Array.isArray(accounts) ? accounts : [])
    .map((row) => String(row?.id || '').trim())
    .filter(Boolean));
  const stale = accountScoped.filter((row) => !liveIds.has(String(row.accountId || '').trim()));
  if (!stale.length) return list;
  const staleIds = stale.map((row) => String(row?.id || '').trim()).filter(Boolean);
  await Promise.all(staleIds.map((id) => db.deleteRecord('memoryFacts', id)));
  await deleteVectorSources('fact', staleIds);
  const staleSet = new Set(staleIds);
  return list.filter((row) => !staleSet.has(String(row?.id || '').trim()));
}
