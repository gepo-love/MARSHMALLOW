/**
 * 轮级角色心声/心情/状态 + 情绪波动值（按 chat 存档）
 * 由棉花糖协议 `state` 事件每轮写入一条；点击头像的只读状态栏与下一轮提示词都从这里读。
 */
import { get, put, remove, onStoreWrite } from '../db.js';
import { resolveCharacterAiContextName } from '../../models/character.js';
import {
  messageLikelyNeedsTranslationForProfile,
  sanitizeAiTranslation,
} from '../translation-utils.js';
import {
  CHARACTER_SCENE_FACT_TTL_MS,
  characterSceneSourcePriority,
  compareCharacterLiveDecisions,
  recordCharacterSceneFact,
} from '../character-live-state.js';
import {
  clearPsychologicalContinuityForCharacter,
  clearPsychologicalContinuityForChat,
  parseLegacyPendingIntent,
  syncLegacyIntent,
} from './psychological-continuity.js';

const KEY = (chatId) => `chatCharState_${String(chatId || '').trim()}`;
const HISTORY_KEY = (chatId) => `chatCharStateHistory_${String(chatId || '').trim()}`;
const roundStateApplyQueues = new Map();
const chatClearWatermarks = new Map();
const characterClearWatermarks = new Map();
const stateReadCache = new Map();
const historyReadCache = new Map();

function characterClearWatermarkKey(chatId, characterId) {
  return `${String(chatId || '').trim()}\u0000${String(characterId || '').trim()}`;
}

onStoreWrite('settings', (key) => {
  const value = String(key || '');
  if (key === undefined) {
    stateReadCache.clear();
    historyReadCache.clear();
    return;
  }
  if (value.startsWith('chatCharStateHistory_')) {
    historyReadCache.delete(value.slice('chatCharStateHistory_'.length));
    return;
  }
  if (!value.startsWith('chatCharState_') || value.startsWith('chatCharStateHistory_')) return;
  stateReadCache.delete(value.slice('chatCharState_'.length));
});
export const MOOD_BASELINE = 50;
const MOOD_MIN = 0;
const MOOD_MAX = 100;
const STATUS_MAX_LEN = 80;
const MOOD_MAX_LEN = 24;
const CUSTOM_STATE_FIELD_MAX = 16;
const CUSTOM_STATE_KEY_MAX_LEN = 40;
const CUSTOM_STATE_VALUE_MAX_LEN = 500;

const INNER_LABEL_RE = /^(?:心声|心聲|内心|內心|心理|心理活动|心理活動|inner|innerVoice)\s*[：:]/iu;

export function clampMoodValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return MOOD_BASELINE;
  return Math.max(MOOD_MIN, Math.min(MOOD_MAX, Math.round(n)));
}

/** 每轮：先向基线轻微回落，再叠加本轮波动增量（-20..20） */
export function nextMoodValue(prev, shift) {
  const base = Number.isFinite(Number(prev)) ? Number(prev) : MOOD_BASELINE;
  const decayed = base + (MOOD_BASELINE - base) * 0.2;
  const s = Math.max(-20, Math.min(20, Number(shift) || 0));
  return clampMoodValue(decayed + s);
}

export function moodValueLabel(v) {
  const n = clampMoodValue(v);
  if (n >= 80) return '很激动';
  if (n >= 62) return '有起伏';
  if (n >= 40) return '平稳';
  if (n >= 22) return '低落';
  return '很低';
}

function clipText(text, maxLen) {
  const raw = String(text || '').trim();
  if (!raw || raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen).trim()}…`;
}

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function unwrapMatchingOuterQuotes(text = '') {
  const value = String(text || '');
  if (value.includes('\n')) return value;
  const pairs = {
    '"': '"',
    "'": "'",
    '“': '”',
    '‘': '’',
  };
  const closing = pairs[value[0]];
  if (!closing || value.length < 2 || value[value.length - 1] !== closing) return value;
  return value.slice(1, -1);
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 清掉模型从提示词复读进可见心声的内部身份标签，如“用户小明”“真实用户「小明」”或裸 user。 */
export function sanitizeStateUserLabel(value, userName = '') {
  const text = String(value || '');
  const name = normalizeWhitespace(userName);
  if (!text) return text;
  const hasRealName = !!name && !/^(?:用户|user|我)$/iu.test(name);
  const naturalReference = hasRealName ? name : '对方';
  // user 是协议身份 id，不应出现在角色自然心声中。即使用户没有填写昵称，
  // 也用“对方”兜住，避免把内部协议占位符直接展示出来。
  let cleaned = text
    // 中文语境里顺手吃掉协议占位符两侧的分词空格，避免得到“小满 怎么”。
    .replace(/(^|[\u3400-\u9fff])\s*\buser\b\s*(?=$|[\u3400-\u9fff])/giu, `$1${naturalReference}`)
    .replace(/\buser\b/giu, naturalReference);
  if (hasRealName) {
    const escapedName = escapeRegExp(name);
    cleaned = cleaned.replace(
      new RegExp(`(?:真实用户|用户)\\s*[「『“"'（(]?\\s*${escapedName}\\s*[」』”"'）)]?`, 'giu'),
      name,
    );
  }
  // 只处理明显在指当前聊天对象的“用户”，保留“用户体验”等普通产品名词。
  cleaned = cleaned
    .replace(/用户(?=\s*(?:怎么|为什么|为何|是不是|会不会|能不能|要不要|还|又|已经|刚刚?|居然|竟然|说|问|回|回复|看|看到|听|知道|觉得|想|喜欢|讨厌|生气|难过|开心|不|没|也|都|真|太|呢|吗|吧|啊|呀|哦|嘛|的\s*(?:回复|消息|反应|想法|名字|昵称|动态|照片|语气|态度|问题|话)))/gu, () => naturalReference)
    .replace(/((?:给|跟|和|对|问|等|找|陪|让|哄|瞒|提醒|告诉|回复|联系|担心|喜欢|想念)\s*)用户/gu, (_match, prefix) => `${prefix}${naturalReference}`);
  return cleaned;
}

export function sanitizeInnerVoiceText(value, userName = '') {
  const cleaned = normalizeWhitespace(sanitizeStateUserLabel(value, userName))
    .split('\n')
    .map((line) => line.replace(INNER_LABEL_RE, '').trim())
    .join('\n')
    .trim();
  // AI 偶尔把整段心声额外包一层成对引号，可以安全解包；但不能单独删除
  // 开头或结尾引号，否则用户编辑首行引用内容时，左引号会在保存后凭空消失。
  return unwrapMatchingOuterQuotes(cleaned).trim();
}

export function sanitizeMoodText(value) {
  const text = normalizeWhitespace(value)
    .replace(/^(?:情绪|情緒|心情|mood)\s*[：:]/iu, '')
    .replace(/[，。！？!?；;\n].*$/u, '')
    .trim();
  return clipText(text, MOOD_MAX_LEN);
}

export function sanitizeIntentText(value, userName = '') {
  const text = normalizeWhitespace(sanitizeStateUserLabel(value, userName))
    .replace(/^(?:意图|意圖|盘算|盤算|心思|打算|intent|plan)\s*[：:]/iu, '')
    .replace(/\n+/g, ' ')
    .trim();
  // 心思卡片是用户可回看、可编辑的正文，不能在入库时截断。
  // 提示词侧如需控制长度，应在组装上下文时单独压缩，避免永久丢失原文。
  return text;
}

export function sanitizeStatusText(value, userName = '') {
  const text = normalizeWhitespace(sanitizeStateUserLabel(value, userName))
    .replace(/^(?:状态|狀態|当前状态|當前狀態|动作|動作|正在做什么|正在做什麼|status)\s*[：:]/iu, '')
    .replace(/\n+/g, ' ')
    .trim();
  return clipText(text, STATUS_MAX_LEN);
}

export function sanitizeCustomStateFields(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, CUSTOM_STATE_FIELD_MAX)) {
    const key = normalizeWhitespace(rawKey).slice(0, CUSTOM_STATE_KEY_MAX_LEN);
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    const text = normalizeWhitespace(
      rawValue && typeof rawValue === 'object'
        ? JSON.stringify(rawValue)
        : rawValue,
    ).slice(0, CUSTOM_STATE_VALUE_MAX_LEN);
    if (text) out[key] = text;
  }
  return out;
}

/**
 * 「心情」文字标签已从棉花糖协议的 state 事件里移除（现在只有 moodValue 数值），
 * 但旧档位残留的 mood 文本不会再被新一轮覆盖——读取时顺手清掉，
 * 否则会一直卡在协议改动前最后一次输出过 mood 的那轮文案，且不会再变。
 */
function stripStaleMood(raw) {
  let changed = false;
  const cleaned = {};
  for (const [charId, s] of Object.entries(raw)) {
    if (s && typeof s === 'object' && s.mood) {
      changed = true;
      cleaned[charId] = { ...s, mood: '' };
    } else {
      cleaned[charId] = s;
    }
  }
  return { cleaned, changed };
}

export async function loadChatCharState(chatId) {
  const cid = String(chatId || '').trim();
  if (!cid) return {};
  if (stateReadCache.has(cid)) return stateReadCache.get(cid);
  const pending = get(KEY(cid)).then(async (row) => {
    const raw = row?.value && typeof row.value === 'object' ? row.value : {};
    const { cleaned, changed } = stripStaleMood(raw);
    if (changed) await saveChatCharState(cid, cleaned).catch(() => {});
    return cleaned;
  }).catch((error) => {
    stateReadCache.delete(cid);
    throw error;
  });
  stateReadCache.set(cid, pending);
  return pending;
}

export async function saveChatCharState(chatId, state) {
  const cid = String(chatId || '').trim();
  const next = state || {};
  await put({ key: KEY(cid), value: next });
  stateReadCache.set(cid, Promise.resolve(next));
  return next;
}

/**
 * 旧版心声只按 chatId 存储，没有 userId。只有当真实会话记录明确属于
 * 当前档位时才兼容读取，避免仅凭一个同名 chatId 把另一档的残留放行。
 */
export async function canReadLegacyUnscopedChatState(chatId, userId) {
  const cid = String(chatId || '').trim();
  const uid = String(userId || '').trim();
  if (!cid || !uid) return false;
  const chatRow = await get('chats', cid).catch(() => null);
  return String(chatRow?.userId || '').trim() === uid;
}

export async function deleteChatCharState(chatId) {
  const cid = String(chatId || '').trim();
  if (!cid) return;
  return withRoundStateApplyQueue(cid, async () => {
    chatClearWatermarks.set(cid, Date.now());
    stateReadCache.delete(cid);
    historyReadCache.delete(cid);
    await remove(KEY(cid)).catch(() => {});
    await remove(HISTORY_KEY(cid)).catch(() => {});
    await clearPsychologicalContinuityForChat(cid).catch(() => {});
  });
}

function historyEntryId() {
  return `hv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function buildHistoryEntry(charId, snapshot, options = {}) {
  const inner = String(snapshot.inner || '').trim();
  const intent = String(snapshot.intent || '').trim();
  const mood = String(snapshot.mood || '').trim();
  const status = String(snapshot.status || '').trim();
  const custom = sanitizeCustomStateFields(snapshot.custom);
  if (!inner && !intent && !mood && !status && !Object.keys(custom).length) return null;
  return {
    id: historyEntryId(),
    charId: String(charId || '').trim(),
    inner,
    innerTranslation: String(snapshot.innerTranslation || '').trim(),
    intent,
    mood,
    status,
    statusTimelineAt: Number(snapshot.statusTimelineAt || 0) || 0,
    custom,
    moodValue: clampMoodValue(snapshot.moodValue),
    name: String(snapshot.name || charId || '').trim(),
    // 心声里的“对方”只在生成当时的前台用户身份下成立。记录这层绑定，
    // 避免用户切换昵称、匿名身份或马甲后把旧称呼重新喂给模型。
    userId: String(options.userId || snapshot.userId || '').trim(),
    userName: normalizeWhitespace(options.userName || snapshot.userName || ''),
    aiRoundId: String(options.aiRoundId || '').trim(),
    recordedAt: Number(options.recordedAt || Date.now()) || Date.now(),
  };
}

export async function loadChatCharStateHistory(chatId, charId, options = {}) {
  const cid = String(chatId || '').trim();
  const id = String(charId || '').trim();
  if (!cid || !id) return [];
  let pending = historyReadCache.get(cid);
  if (!pending) {
    pending = get(HISTORY_KEY(cid)).then((row) => (
      row?.value && typeof row.value === 'object' ? row.value : {}
    )).catch((error) => {
      historyReadCache.delete(cid);
      throw error;
    });
    historyReadCache.set(cid, pending);
  }
  const bucket = await pending;
  const list = Array.isArray(bucket[id]) ? bucket[id] : [];
  const sorted = list
    .filter((item) => item && typeof item === 'object')
    .slice()
    .sort((a, b) => (Number(b.recordedAt) || 0) - (Number(a.recordedAt) || 0));
  const expectedUserId = String(options.userId || '').trim();
  if (!expectedUserId) return sorted;
  const allowLegacyUnscoped = options.allowLegacyUnscoped === true
    || await canReadLegacyUnscopedChatState(cid, expectedUserId);
  return sorted.filter((entry) => {
    const storedUserId = String(entry?.userId || '').trim();
    return storedUserId === expectedUserId
      || (!storedUserId && allowLegacyUnscoped);
  });
}

function normalizedStateUserIdentity(value = '') {
  return normalizeWhitespace(value).toLocaleLowerCase();
}

/**
 * 只把同一前台用户身份生成的心声送回模型。
 * 旧记录没有身份标记，仍保留在历史页供用户查看，但不再作为生成依据；
 * 否则无法判断其中的姓名究竟是当前用户还是角色认识的第三人。
 */
export function filterCharStateHistoryForUser(entries = [], userName = '', userId = '', options = {}) {
  const expected = normalizedStateUserIdentity(userName);
  const expectedUserId = String(userId || '').trim();
  return (Array.isArray(entries) ? entries : []).filter((entry) => (
    entry
    && typeof entry === 'object'
    && (
      !expectedUserId
      || String(entry.userId || '').trim() === expectedUserId
      || (!String(entry.userId || '').trim() && options.allowLegacyUnscoped === true)
    )
    && normalizedStateUserIdentity(entry.userName) === expected
    && Object.prototype.hasOwnProperty.call(entry, 'userName')
  ));
}

/**
 * state 是旧的 chatId 级 settings 数据。生成链路必须再按稳定 userId 过滤，
 * 不能让当前心声/心思/状态绕开长期记忆的档位边界。
 */
export function filterChatCharStateForUser(state = {}, userId = '', options = {}) {
  const expectedUserId = String(userId || '').trim();
  const source = state && typeof state === 'object' ? state : {};
  if (!expectedUserId) return source;
  const allowLegacyUnscoped = options.allowLegacyUnscoped === true;
  const filtered = {};
  for (const [characterId, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== 'object') continue;
    const storedUserId = String(entry.userId || '').trim();
    if (storedUserId === expectedUserId || (!storedUserId && allowLegacyUnscoped)) {
      filtered[characterId] = entry;
    }
  }
  return filtered;
}

const STATE_RECALL_STOP_TOKENS = new Set([
  '对方', '用户', '角色', '自己', '现在', '这个', '那个', '还是', '已经', '没有',
  '觉得', '一下', '时候', '正在', '真的', '有点', '怎么', '什么', '然后', '可以',
]);

function stateRecallTokens(value) {
  const source = String(value || '').toLowerCase();
  const out = new Set();
  const words = source.match(/[a-z0-9_]{3,}/g) || [];
  words.forEach((word) => out.add(word));
  const runs = source.match(/[\u3400-\u9fff]{2,}/g) || [];
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i += 1) {
      const token = run.slice(i, i + 2);
      if (!STATE_RECALL_STOP_TOKENS.has(token)) out.add(token);
    }
  }
  return out;
}

/**
 * 从同一会话、同一角色的往期状态里挑少量主题相关记录。
 * 状态历史没有保存触发它的完整消息，因此这里只做保守词面匹配；无可靠命中就不注入。
 */
export function selectRelevantCharStateHistory(list = [], signal = '', options = {}) {
  const signalTokens = stateRecallTokens(signal);
  if (!signalTokens.size) return [];
  const excludedRoundIds = new Set(
    (Array.isArray(options.excludeAiRoundIds) ? options.excludeAiRoundIds : [options.excludeAiRoundId])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const limit = Math.max(1, Math.min(3, Number(options.limit) || 2));
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .slice(0, 80)
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') return null;
      if (excludedRoundIds.has(String(entry.aiRoundId || '').trim())) return null;
      const inner = sanitizeInnerVoiceText(entry.inner || '');
      const intent = sanitizeIntentText(entry.intent || '');
      const status = sanitizeStatusText(entry.status || '');
      const mood = sanitizeMoodText(entry.mood || '');
      const fingerprint = `${inner}\n${intent}\n${status}\n${mood}`.trim();
      if (!fingerprint || seen.has(fingerprint)) return null;
      seen.add(fingerprint);
      const entryTokens = stateRecallTokens(fingerprint);
      const overlap = [...entryTokens].filter((token) => signalTokens.has(token));
      if (!overlap.length) return null;
      return {
        ...entry,
        inner,
        intent,
        status,
        mood,
        recallScore: (overlap.length * 100) - Math.min(index, 60),
        recallTokens: overlap.slice(0, 6),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.recallScore - a.recallScore)
    .slice(0, limit);
}

function compactStateRecallText(value, maxLength = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
}

export function buildRelevantCharStateHistoryPromptBlock(entries = [], characterName = '角色') {
  const list = Array.isArray(entries) ? entries.filter(Boolean).slice(0, 3) : [];
  if (!list.length) return '';
  const name = String(characterName || '角色').trim() || '角色';
  const lines = list.map((entry) => {
    const recordedAt = Number(entry.recordedAt);
    const parsedDate = Number.isFinite(recordedAt) && recordedAt > 0 ? new Date(recordedAt) : null;
    const date = parsedDate && Number.isFinite(parsedDate.getTime())
      ? parsedDate.toISOString().slice(0, 10)
      : '日期未知';
    const parts = [];
    if (entry.inner) parts.push(`当时没说出口「${compactStateRecallText(entry.inner)}」`);
    if (entry.intent) parts.push(`当时盘算「${compactStateRecallText(entry.intent, 60)}」`);
    if (entry.status) parts.push(`当时在「${compactStateRecallText(entry.status, 60)}」`);
    return `- ${date}：${parts.join('；')}`;
  });
  return [
    `[${name}的往期相似状态 · 只供比较]`,
    ...lines,
    '这些记录不是当前事实，也不是要复刻的台词：只比较当时残留的情绪、念头与这次哪里不同。禁止照抄旧 inner/intent；旧 inner 即使写得像分析或决策日志，也只能提取其中仍成立的私人感受，不能继承它的组织结构。',
  ].join('\n');
}

export function buildRecentCharStateHistoryPromptBlock(entries = [], characterName = '角色', limit = 2, options = {}) {
  const excludedRoundIds = new Set(
    (Array.isArray(options.excludeAiRoundIds) ? options.excludeAiRoundIds : [options.excludeAiRoundId])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const max = Math.max(0, Math.min(8, Math.round(Number(limit) || 0)));
  if (!max) return '';
  const seen = new Set();
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => !excludedRoundIds.has(String(entry.aiRoundId || '').trim()))
    .map((entry) => ({
      ...entry,
      inner: sanitizeInnerVoiceText(entry.inner || ''),
      intent: sanitizeIntentText(entry.intent || ''),
      status: sanitizeStatusText(entry.status || ''),
      mood: sanitizeMoodText(entry.mood || ''),
      custom: sanitizeCustomStateFields(entry.custom),
    }))
    .filter((entry) => {
      const fingerprint = [
        entry.inner,
        entry.intent,
        entry.status,
        entry.mood,
        JSON.stringify(entry.custom),
      ].join('\n');
      if (!fingerprint.replace(/[{}\s]/g, '') || seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    })
    .slice(0, max);
  if (!list.length) return '';
  const name = String(characterName || '角色').trim() || '角色';
  const lines = list.map((entry) => {
    const parts = [];
    if (entry.inner) parts.push(`原心声「${compactStateRecallText(entry.inner, 220)}」`);
    if (entry.intent) parts.push(`心思「${compactStateRecallText(entry.intent, 80)}」`);
    if (entry.status) parts.push(`状态「${compactStateRecallText(entry.status, 80)}」`);
    if (Object.keys(entry.custom).length) {
      parts.push(`自定义字段 ${Object.entries(entry.custom).map(([key, value]) => `${key}「${compactStateRecallText(value, 80)}」`).join('，')}`);
    }
    return `- ${parts.join('；')}`;
  });
  return [
    `[${name}最近 ${list.length} 条原心声 · 连续性参考]`,
    ...lines,
    '这些是本会话此前真实保存的心声数据，不受当前 HTML/CSS 外观影响。只承接仍未消化的情绪、私人联想和具体心结，不继承旧心声的段落骨架；旧记录若像思路罗列、回复计划或决策摘要，本轮必须还原成角色当下真正会冒出的自然念头。不要照抄旧句，也不要把心声直接说给用户。',
  ].join('\n');
}

function normalizeEditableCharStatePatch(patch = {}, prev = {}) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(patch || {}, key);
  const inner = has('inner')
    ? sanitizeInnerVoiceText(patch.inner)
    : String(base.inner || '').trim();
  const innerTranslation = has('innerTranslation')
    ? (inner ? sanitizeAiTranslation(inner, patch.innerTranslation) : '')
    : (inner ? String(base.innerTranslation || '').trim() : '');
  const intent = has('intent')
    ? sanitizeIntentText(patch.intent)
    : String(base.intent || '').trim();
  const mood = has('mood')
    ? sanitizeMoodText(patch.mood)
    : String(base.mood || '').trim();
  const status = has('status')
    ? sanitizeStatusText(patch.status)
    : String(base.status || '').trim();
  const moodValue = has('moodValue')
    ? clampMoodValue(patch.moodValue)
    : clampMoodValue(base.moodValue);
  const custom = has('custom')
    ? sanitizeCustomStateFields(patch.custom)
    : sanitizeCustomStateFields(base.custom);
  return {
    inner,
    innerTranslation,
    intent,
    mood,
    status,
    moodValue,
    custom,
  };
}

/** 手动编辑某角色当前心声；若往期有同轮记录，一并同步 */
export async function updateChatCharCurrentState(chatId, charId, patch = {}) {
  const cid = String(chatId || '').trim();
  const id = String(charId || '').trim();
  if (!cid || !id) return null;
  const state = await loadChatCharState(cid);
  const prev = state[id] && typeof state[id] === 'object' ? state[id] : {};
  const fields = normalizeEditableCharStatePatch(patch, prev);
  const next = {
    ...prev,
    ...fields,
    name: String(prev.name || id).trim(),
    aiRoundId: String(prev.aiRoundId || '').trim(),
    updatedAt: Date.now(),
  };
  state[id] = next;
  await saveChatCharState(cid, state);

  const roundId = String(next.aiRoundId || '').trim();
  if (roundId) {
    const row = await get(HISTORY_KEY(cid));
    const bucket = row?.value && typeof row.value === 'object' ? { ...row.value } : {};
    const list = Array.isArray(bucket[id]) ? bucket[id].slice() : [];
    let historyChanged = false;
    bucket[id] = list.map((item) => {
      if (!item || String(item.aiRoundId || '').trim() !== roundId) return item;
      historyChanged = true;
      return {
        ...item,
        ...fields,
        name: String(item.name || next.name || id).trim(),
      };
    });
    if (historyChanged) await put({ key: HISTORY_KEY(cid), value: bucket });
  }
  return next;
}

/** 删除某角色的一条往期心声记录 */
export async function deleteCharStateHistoryEntry(chatId, charId, entryId) {
  const cid = String(chatId || '').trim();
  const id = String(charId || '').trim();
  const eid = String(entryId || '').trim();
  if (!cid || !id || !eid) return false;
  const row = await get(HISTORY_KEY(cid));
  const bucket = row?.value && typeof row.value === 'object' ? { ...row.value } : {};
  const prev = Array.isArray(bucket[id]) ? bucket[id] : [];
  const next = prev.filter((item) => item && String(item.id || '') !== eid);
  if (next.length === prev.length) return false;
  if (next.length) bucket[id] = next;
  else delete bucket[id];
  await put({ key: HISTORY_KEY(cid), value: bucket });
  return true;
}

/** 手动编辑某角色的一条往期心声；若对应本轮当前态，一并同步 */
export async function updateCharStateHistoryEntry(chatId, charId, entryId, patch = {}) {
  const cid = String(chatId || '').trim();
  const id = String(charId || '').trim();
  const eid = String(entryId || '').trim();
  if (!cid || !id || !eid) return null;
  const row = await get(HISTORY_KEY(cid));
  const bucket = row?.value && typeof row.value === 'object' ? { ...row.value } : {};
  const prev = Array.isArray(bucket[id]) ? bucket[id].slice() : [];
  const index = prev.findIndex((item) => item && String(item.id || '') === eid);
  if (index < 0) return null;
  const current = prev[index];
  const fields = normalizeEditableCharStatePatch(patch, current);
  const nextEntry = {
    ...current,
    ...fields,
    name: String(current.name || id).trim(),
  };
  prev[index] = nextEntry;
  bucket[id] = prev;
  await put({ key: HISTORY_KEY(cid), value: bucket });

  const roundId = String(nextEntry.aiRoundId || '').trim();
  if (roundId) {
    const state = await loadChatCharState(cid);
    const live = state[id];
    if (live && String(live.aiRoundId || '').trim() === roundId) {
      state[id] = {
        ...live,
        ...fields,
        name: String(live.name || nextEntry.name || id).trim(),
        updatedAt: Date.now(),
      };
      await saveChatCharState(cid, state);
    }
  }
  return nextEntry;
}

/** 清空某角色在当前会话的全部心声（当前状态 + 往期记录 + 结构化心理线头） */
export async function clearCharStateForCharacter(chatId, charId, options = {}) {
  const cid = String(chatId || '').trim();
  const id = String(charId || '').trim();
  if (!cid || !id) return false;
  return withRoundStateApplyQueue(cid, async () => {
    characterClearWatermarks.set(characterClearWatermarkKey(cid, id), Date.now());
    const state = await loadChatCharState(cid);
    if (state && Object.prototype.hasOwnProperty.call(state, id)) {
      const nextState = { ...state };
      delete nextState[id];
      await saveChatCharState(cid, nextState);
    }
    const row = await get(HISTORY_KEY(cid));
    const bucket = row?.value && typeof row.value === 'object' ? { ...row.value } : {};
    if (Object.prototype.hasOwnProperty.call(bucket, id)) {
      delete bucket[id];
      await put({ key: HISTORY_KEY(cid), value: bucket });
    }
    const explicitUserId = String(options.userId || '').trim();
    const chatRow = explicitUserId ? null : await get('chats', cid).catch(() => null);
    const userId = explicitUserId || String(chatRow?.userId || '').trim();
    if (userId) {
      // UI 只有在旧心声与结构化心理两边都完成清理后才能提示成功；
      // 心理层自身按 chat 串行，已在途的 delivery/state apply 会先完成再被清掉。
      await clearPsychologicalContinuityForCharacter({ userId, chatId: cid }, id);
    }
    return true;
  });
}

async function rewindCharStateForAiRoundsUnsafe(chatId, aiRoundIds) {
  const cid = String(chatId || '').trim();
  const roundIds = new Set((Array.isArray(aiRoundIds) ? aiRoundIds : [aiRoundIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  if (!cid || !roundIds.size) return false;
  const row = await get(HISTORY_KEY(cid));
  const bucket = row?.value && typeof row.value === 'object' ? { ...row.value } : {};
  let changed = false;
  Object.keys(bucket).forEach((charId) => {
    const prev = Array.isArray(bucket[charId]) ? bucket[charId] : [];
    const next = prev.filter((item) => item && !roundIds.has(String(item.aiRoundId || '').trim()));
    if (next.length !== prev.length) changed = true;
    if (next.length) bucket[charId] = next;
    else delete bucket[charId];
  });
  if (changed) await put({ key: HISTORY_KEY(cid), value: bucket });

  const state = await loadChatCharState(cid);
  if (!state || typeof state !== 'object') return changed;
  const nextState = { ...state };
  let stateChanged = false;
  for (const charId of Object.keys(nextState)) {
    const current = nextState[charId];
    if (!current || !roundIds.has(String(current.aiRoundId || '').trim())) continue;
    const previous = Array.isArray(bucket[charId]) ? bucket[charId][0] : null;
    if (previous) {
      nextState[charId] = {
        inner: String(previous.inner || ''),
        innerTranslation: String(previous.innerTranslation || ''),
        intent: String(previous.intent || ''),
        mood: String(previous.mood || ''),
        status: String(previous.status || ''),
        statusTimelineAt: Number(previous.statusTimelineAt || previous.recordedAt || 0) || 0,
        custom: sanitizeCustomStateFields(previous.custom),
        moodValue: clampMoodValue(previous.moodValue),
        name: String(previous.name || current.name || charId),
        userId: String(previous.userId || current.userId || '').trim(),
        userName: normalizeWhitespace(previous.userName || ''),
        aiRoundId: String(previous.aiRoundId || ''),
        updatedAt: Number(previous.recordedAt || Date.now()) || Date.now(),
      };
    } else {
      delete nextState[charId];
    }
    stateChanged = true;
  }
  if (stateChanged) await saveChatCharState(cid, nextState);
  return changed || stateChanged;
}

/** 重 Roll 与 state 写入共用同一队列，防止迟到的本轮心声在删除后复活。 */
export async function rewindCharStateForAiRounds(chatId, aiRoundIds = []) {
  const cid = String(chatId || '').trim();
  if (!cid) return false;
  return withRoundStateApplyQueue(cid, () => rewindCharStateForAiRoundsUnsafe(cid, aiRoundIds));
}

export async function rewindCharStateForAiRound(chatId, aiRoundId) {
  return rewindCharStateForAiRounds(chatId, [aiRoundId]);
}

export function paginateCharStateHistory(list = [], page = 1, pageSize = 5) {
  const src = Array.isArray(list) ? list : [];
  const size = Math.max(1, Math.min(20, Number(pageSize) || 5));
  const total = src.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.max(1, Math.min(totalPages, Number(page) || 1));
  const start = (safePage - 1) * size;
  return {
    items: src.slice(start, start + size),
    page: safePage,
    pageSize: size,
    total,
    totalPages,
  };
}

async function appendCharStateHistoryEntry(chatId, charId, entry) {
  const cid = String(chatId || '').trim();
  const id = String(charId || '').trim();
  if (!cid || !id || !entry) return;
  const row = await get(HISTORY_KEY(cid));
  const bucket = row?.value && typeof row.value === 'object' ? { ...row.value } : {};
  const prev = Array.isArray(bucket[id]) ? bucket[id].slice() : [];
  const last = prev[0];
  if (
    last
    && String(last.inner || '') === String(entry.inner || '')
    && String(last.innerTranslation || '') === String(entry.innerTranslation || '')
    && String(last.intent || '') === String(entry.intent || '')
    && String(last.mood || '') === String(entry.mood || '')
    && String(last.status || '') === String(entry.status || '')
    && Number(last.statusTimelineAt || 0) === Number(entry.statusTimelineAt || 0)
    && JSON.stringify(sanitizeCustomStateFields(last.custom)) === JSON.stringify(sanitizeCustomStateFields(entry.custom))
    && clampMoodValue(last.moodValue) === clampMoodValue(entry.moodValue)
    && String(last.userId || '') === String(entry.userId || '')
    && normalizedStateUserIdentity(last.userName) === normalizedStateUserIdentity(entry.userName)
    && String(last.aiRoundId || '') === String(entry.aiRoundId || '')
  ) {
    return;
  }
  prev.unshift(entry);
  // 往期心声是用户可回看的历史数据，不因模型上下文窗口而裁掉。
  // 注入条数由 build-chat-context 单独控制，默认读取最近 5 条。
  bucket[id] = prev;
  await put({ key: HISTORY_KEY(cid), value: bucket });
}

/**
 * 处理本轮棉花糖协议 `state` 事件，更新各角色的心声/心情/状态与情绪波动值
 */
function withRoundStateApplyQueue(chatId, task) {
  const previous = roundStateApplyQueues.get(chatId) || Promise.resolve();
  const queued = previous.catch(() => {}).then(task);
  roundStateApplyQueues.set(chatId, queued);
  return queued.finally(() => {
    if (roundStateApplyQueues.get(chatId) === queued) roundStateApplyQueues.delete(chatId);
  });
}

export async function applyRoundStateEvents(chatId, events = [], options = {}) {
  const cid = String(chatId || '').trim();
  if (!cid) return null;
  const list = (Array.isArray(events) ? events : []).filter((e) => e && e.t === 'state');
  if (!list.length) return null;
  return withRoundStateApplyQueue(cid, async () => {
    const state = await loadChatCharState(cid);
    const psychologySyncs = [];
    const resolveName = typeof options.resolveSenderName === 'function' ? options.resolveSenderName : null;
    const userId = String(options.userId || '').trim();
    const userName = String(options.userName || '').trim();
    const aiRoundId = String(options.aiRoundId || '').trim();
    const aiRoundCreatedAt = Number(options.aiRoundCreatedAt || 0);
    const timelineNow = Number(options.now || 0) || Date.now();
    const allowLegacyUnscoped = !!userId
      && await canReadLegacyUnscopedChatState(cid, userId);
    for (const [eventIndex, ev] of list.entries()) {
      const charId = String(ev.from || ev.actor || ev.senderId || '').trim();
      if (!charId || charId === 'user' || charId === 'system') continue;
      const destructiveClearAt = Math.max(
        Number(chatClearWatermarks.get(cid) || 0),
        Number(characterClearWatermarks.get(characterClearWatermarkKey(cid, charId)) || 0),
      );
      if (aiRoundCreatedAt > 0 && destructiveClearAt > 0 && aiRoundCreatedAt <= destructiveClearAt) {
        continue;
      }
      const storedPrev = state[charId] || {};
      const storedPrevUserId = String(storedPrev.userId || '').trim();
      // 同 chatId 的导入残留若来自另一档，不能把旧 mood/status/inner 当成本档上一轮。
      // 当 chats 表中的真实会话已明确属于本档时，旧版未写 userId 的心声也可安全继承。
      const prev = userId && storedPrevUserId !== userId && !(allowLegacyUnscoped && !storedPrevUserId)
        ? {}
        : storedPrev;
      const sceneSource = String(options.sceneSource || 'chat_state').trim() || 'chat_state';
      const incomingDecision = {
        decisionAt: aiRoundCreatedAt || Date.now(),
        decisionSequence: eventIndex,
        sourceRoundId: aiRoundId,
      };
      const currentDecision = {
        decisionAt: Number(prev.aiRoundCreatedAt || 0) || Number(prev.updatedAt || 0),
        decisionSequence: Number(prev.aiRoundSequence || 0),
        sourceRoundId: String(prev.aiRoundId || '').trim(),
      };
      const previousStatusTimelineAt = Number(
        prev.statusTimelineAt || prev.statusUpdatedAt || prev.updatedAt || 0,
      ) || 0;
      const previousSceneAge = timelineNow - previousStatusTimelineAt;
      const previousSceneActive = !!(
        prev.status
        && previousStatusTimelineAt > 0
        && previousSceneAge >= 0
        && previousSceneAge < CHARACTER_SCENE_FACT_TTL_MS
      );
      const status = sanitizeStatusText(ev.status || '', userName);
      const incomingPriority = characterSceneSourcePriority(sceneSource);
      const currentPriority = characterSceneSourcePriority(prev.sceneSource);
      // 场景来源优先级只仲裁本轮显式提交的 status。低优先级的后台回合即使
      // 不能覆盖仍活跃的前台场景，它产生的心声、盘算和情绪变化仍然有效。
      const sceneStatusBlocked = !!(
        status
        && previousSceneActive
        && incomingPriority < currentPriority
      );
      const higherPriorityScene = !!(
        status
        && previousSceneActive
        && incomingPriority > currentPriority
      );
      if (!higherPriorityScene && compareCharacterLiveDecisions(incomingDecision, currentDecision) < 0) continue;

      const inner = sanitizeInnerVoiceText(ev.inner || ev.innerVoice || '', userName);
      const translationProfile = options.characters?.[charId]?.translationProfile || {};
      const innerTranslation = inner && messageLikelyNeedsTranslationForProfile(inner, translationProfile)
        ? sanitizeAiTranslation(inner, ev.innerZh || ev.zh || '', {
          languageHint: translationProfile.language || translationProfile.dialectNote || '',
        })
        : '';
      const intent = sanitizeIntentText(ev.intent || '', userName);
      const mood = sanitizeMoodText(ev.mood || '');
      const custom = sanitizeCustomStateFields(ev.custom);
      const replaceEmptyInner = options.replaceEmptyInner === true && Object.keys(custom).length > 0;
      const acceptedStatus = status && !sceneStatusBlocked ? status : '';
      const next = {
        inner: inner || (replaceEmptyInner ? '' : (prev.inner || '')),
        innerTranslation: inner
          ? innerTranslation
          : (replaceEmptyInner ? '' : (prev.innerTranslation || '')),
        // Intent is per-round bookkeeping: a new state without intent means "no agenda this round".
        // Mood text tag is deprecated (protocol only emits moodShift now): never fall back to a
        // stale prior round's mood, or it would freeze on old text forever and never clear.
        intent,
        mood,
        status: acceptedStatus || prev.status || '',
        // status 跟世界时间线走，并且只在模型明确写出新场景时推进。
        // inner / intent / mood 的普通更新不能把数小时前的旧动作重新续期。
        statusTimelineAt: acceptedStatus ? timelineNow : previousStatusTimelineAt,
        custom,
        moodValue: nextMoodValue(prev.moodValue, ev.moodShift),
        name: resolveName ? await resolveName(charId) : (prev.name || charId),
        userId,
        userName,
        aiRoundId,
        aiRoundCreatedAt: incomingDecision.decisionAt,
        aiRoundSequence: eventIndex,
        // sceneSource 描述的是当前保存下来的 status 来源；若新 status 被场景
        // 优先级拒绝，必须与旧 status 一起保留，不能伪装成后台来源。
        sceneSource: acceptedStatus ? sceneSource : String(prev.sceneSource || '').trim(),
        updatedAt: Date.now(),
      };
      const historyEntry = buildHistoryEntry(charId, next, {
        aiRoundId: options.aiRoundId,
        recordedAt: next.updatedAt,
        userId,
        userName,
      });
      if (historyEntry) {
        await appendCharStateHistoryEntry(cid, charId, historyEntry);
      }
      state[charId] = next;
      if (options.userId) {
        psychologySyncs.push({ charId, state: next });
      }
      if (options.userId && options.persistCharacterLiveState !== false && acceptedStatus) {
        await recordCharacterSceneFact(options.userId, charId, {
          activity: acceptedStatus,
          updatedAt: Number(options.now || 0) || Date.now(),
          decisionAt: incomingDecision.decisionAt,
          decisionSequence: eventIndex,
          sourceChatId: cid,
          sourceRoundId: options.aiRoundId,
          source: sceneSource,
          allowScheduleOverride: options.allowScheduleOverride !== false,
          resumePresence: (Array.isArray(options.resumePresenceActorIds)
            ? options.resumePresenceActorIds
            : [])
            .some((actorId) => String(actorId || '').trim() === charId),
          // 普通 state.status 不修改日程本身；是否在 TTL 内临时显示在原计划之前，
          // 由角色级“当前场景临时覆盖日程”策略在读取时统一决定。
          explicitScheduleOverride: false,
        }).catch(() => null);
      }
    }
    await saveChatCharState(cid, state);
    // 旧协议只有自由文本 intent。第一阶段只把严格的“待续：…｜触发：…”
    // 迁成结构化线头；普通盘算与 raw inner 都不会进入连续心理运行时。
    // 心理层属于增强数据，写入失败不得让已经生成的可见聊天整轮落库失败。
    for (const item of psychologySyncs) {
      await syncLegacyIntent({
        userId: options.userId,
        chatId: cid,
      }, item.charId, item.state, {
        aiRoundId,
        now: item.state.updatedAt,
      }).catch((error) => {
        console.warn('[character-state] sync psychological continuity failed', error);
      });
    }
    return state;
  });
}

/** 注入下一轮提示词：上一轮各角色状态 + 情绪波动值，作连续性参考 */
export function buildCharStatePromptBlock(state = {}, participantIds = [], characters = {}, options = {}) {
  const ids = (Array.isArray(participantIds) ? participantIds : [])
    .filter((id) => id && id !== 'user' && id !== 'system');
  const excludedRoundIds = new Set(
    (Array.isArray(options.excludeAiRoundIds) ? options.excludeAiRoundIds : [options.excludeAiRoundId])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const requestedNow = Number(options.now || 0);
  const now = Number.isFinite(requestedNow) && requestedNow > 0 ? requestedNow : Date.now();
  const requestedStatusTtlMs = Number(options.statusTtlMs || 0);
  const statusTtlMs = Number.isFinite(requestedStatusTtlMs) && requestedStatusTtlMs > 0
    ? requestedStatusTtlMs
    : CHARACTER_SCENE_FACT_TTL_MS;
  const conversationTimeline = Array.isArray(options.conversationTimeline)
    ? options.conversationTimeline
    : [];
  const structuredPendingIntentActorIds = new Set(
    (Array.isArray(options.structuredPendingIntentActorIds)
      ? options.structuredPendingIntentActorIds
      : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const lines = [];
  let expiredStatusCount = 0;
  for (const id of ids) {
    const s = state[id];
    if (!s) continue;
    if (excludedRoundIds.size && excludedRoundIds.has(String(s.aiRoundId || '').trim())) continue;
    const parts = [];
    const rawIntent = sanitizeIntentText(s.intent || '');
    const intent = structuredPendingIntentActorIds.has(String(id))
      && parseLegacyPendingIntent(rawIntent)
      ? ''
      : compactStateRecallText(rawIntent, 240);
    const mood = sanitizeMoodText(s.mood || '');
    const status = sanitizeStatusText(s.status || '');
    const statusTimelineAt = Number(s.statusTimelineAt || s.statusUpdatedAt || s.updatedAt || 0) || 0;
    const continuityAt = resolveConversationSceneContinuityAt({
      statusTimelineAt,
      conversationTimeline,
      now,
      ttlMs: statusTtlMs,
    });
    const statusAge = now - continuityAt;
    const statusActive = !!(
      status
      && continuityAt > 0
      && statusAge >= 0
      && statusAge < statusTtlMs
    );
    const custom = sanitizeCustomStateFields(s.custom);
    if (intent) parts.push(`盘算「${intent}」`);
    if (mood) parts.push(`情绪「${mood}」`);
    if (statusActive) parts.push(`当前场景「${status}」`);
    else if (status) expiredStatusCount += 1;
    if (Object.keys(custom).length) {
      parts.push(`自定义状态 ${Object.entries(custom).map(([key, value]) => `${key}「${value}」`).join('，')}`);
    }
    parts.push(`情绪波动值 ${clampMoodValue(s.moodValue)}/100`);
    lines.push(`- ${resolveCharacterAiContextName(id, characters)}（id=${id}）：${parts.join('，')}`);
  }
  if (!lines.length) return '';
  return [
    '[角色当前状态 · 上一轮]',
    '以下是角色上一轮的盘算/状态与情绪波动值，仅供本轮走向参考；不要把旧 inner 句式或标点节奏带到本轮，也不要原样复述给用户：',
    ...lines,
    expiredStatusCount > 0
      ? '场景时效（硬性）：有上一轮场景已经超过约 45 分钟或不属于当前世界时刻，已从上方当前场景中移除。它只能算过去背景；即使没有生成日程，也必须按此刻、人设与最新消息重新判断 TA 在哪里、正在做什么，禁止从旧地点和旧动作原地续写。'
      : '',
    '身份边界（硬性）：每行状态只属于该行标出的角色 id。生成 state 时，from 必须与这条状态的 id 一致；禁止把甲的心声、盘算、地点或动作复制、改写或认领给乙。',
    '上一轮的盘算是自己留下的线头：还没兑现就顺着走；若 intent 标了“待续”且对方沿原话题直接追问，视为已经接住气口，本轮优先兑现写明的当前层，不得再次等一拍、复读同一种回避或换个问句把内容退回去。若仍不愿说，明确撤销待续并关题；若对方没有触发，可以按 intent 等待角色稍后主动、留到相似话题，或因关系/处境变化大方推翻。已经兑现、被打断或不合时宜的盘算也应更新——盘算是活的，不是强制剧情任务。',
    options.statePromptMode === 'custom'
      ? '本轮继续根据当前发生的事更新 state；上一轮自定义字段只是连续性参考，仍以本轮用户自定义要求为准。'
      : '本轮请在 state 事件里据当前发生的事更新 inner/intent/status，并给出合理 moodShift。inner 用该角色自己的口吻写此刻确实还在心里想的内容，围绕真正占住注意力的一处，按这个人原本的思维语法自然想下去；可以连贯，也可以简短。细腻来自人物经历、眼前处境、关系历史与情绪之间确有联系，不来自固定碎句、连续反问、自我否定或强造转念；只有真实发生转念时才转念，也不得凭空补微小习惯、旧事、物件或场景来假装具体。inner 不得复述隐藏整理、逐项解释回复依据或按“观察—判断—计划—边界”汇报思路；没有潜台词时可以很短。intent 才记录这一轮真正存在的预设、目标、待续内容或留给对方的气口；没有明确盘算就写真实状态，不要沿用上一轮硬凑试探、算计或关系推进，已经兑现或失效的盘算应推翻。moodShift 只衡量情绪变化幅度：普通寒暄、想念、被可爱到常为小幅变化，明确告白、冲突、亲密动作、重大误会才可能更大；数值大小不控制 inner 或 intent 的丰富度。status 是回消息时的真实场景：只有上方仍显示的“当前场景”才是连续性事实。现实只过去几秒或几分钟、用户也没触发转场时，应沿用地点和手头动作，不得为变化而突然跳走；旧场景超过约 45 分钟后已经失效，必须按届时日程或当前时刻重新判断，不能继续炒同一锅菜、洗同一场澡或做同一个短时动作。日程是角色原本打算做的事，不是每一轮都强制同步的脚本；抽空回复或几分钟插曲不改计划，但可见消息/旁白若已展开与当前日程地点或主活动不兼容的持续动作链，本轮必须用 schedule_change 改当前块，不能只演新场景却保留旧日程。无论是否有日程，长时间断档后都要生成符合此刻的新 status。inner/intent/status 都要像这个人，不要切换成占有欲狠话、通用恋爱模板或小说神态腔。',
  ].filter(Boolean).join('\n');
}

/**
 * 场景不应因为角色没有每轮重复同一句 state.status 就在剧情中途过期。
 * 只要从场景落点开始，可见消息之间一直没有断档超过 TTL，就用最后一条
 * 消息续上场景时钟。中间真的停聊后，新消息不能把旧场景“复活”。
 */
export function resolveConversationSceneContinuityAt({
  statusTimelineAt = 0,
  conversationTimeline = [],
  now = Date.now(),
  ttlMs = CHARACTER_SCENE_FACT_TTL_MS,
} = {}) {
  const startedAt = Number(statusTimelineAt || 0) || 0;
  const currentAt = Number(now || 0) || Date.now();
  const windowMs = Math.max(5 * 60 * 1000, Number(ttlMs || 0) || CHARACTER_SCENE_FACT_TTL_MS);
  if (!startedAt || startedAt > currentAt) return startedAt;
  let continuityAt = startedAt;
  const timeline = [...new Set((Array.isArray(conversationTimeline) ? conversationTimeline : [])
    .map((value) => Number(value || 0) || 0)
    .filter((value) => value >= startedAt && value <= currentAt))]
    .sort((a, b) => a - b);
  for (const messageAt of timeline) {
    if (messageAt - continuityAt >= windowMs) break;
    continuityAt = Math.max(continuityAt, messageAt);
  }
  return continuityAt;
}
