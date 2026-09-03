import { get as dbGet, put as dbPut } from '../db.js';

const NON_REPLY_MESSAGE_TYPES = new Set(['system', 'voiceCall']);

export function isVisibleConversationMessage(message) {
  if (!message || message.deleted || message.recalled) return false;
  if (String(message.senderId || '') === 'system') return false;
  if (NON_REPLY_MESSAGE_TYPES.has(String(message.type || ''))) return false;
  if (message.metadata?.sceneGuide || message.metadata?.narratorBeat) return false;
  return true;
}

/** 只认用户本人实际发出的消息；代发、线下代答、生成消息和通话卡都不触发真人感回复。 */
export function isRealUserMessage(message) {
  if (!isVisibleConversationMessage(message) || String(message.senderId || '') !== 'user') return false;
  const metadata = message.metadata || {};
  return !metadata.userComposedAsCharacter
    && !metadata.offlineAutoReply
    && !metadata.phoneAutoReply
    && !metadata.aiGenerated;
}

export function isCharacterConversationMessage(message) {
  return isVisibleConversationMessage(message)
    && String(message.senderId || '') !== 'user'
    && !message.metadata?.userComposedAsCharacter;
}

export function getLastVisibleConversationMessage(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (isRealUserMessage(message) || isCharacterConversationMessage(message)) return message;
  }
  return null;
}

/**
 * 返回仍未被角色消息接住的最新真人用户消息。
 * 时间戳必须严格晚于最后角色消息，避免仅凭数组尾项把旧消息重新排程。
 */
export function getUnansweredRealUserMessage(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  let lastUser = null;
  let lastCharacter = null;
  for (const message of list) {
    if (isRealUserMessage(message)) lastUser = message;
    else if (isCharacterConversationMessage(message)) lastCharacter = message;
  }
  if (!lastUser) return null;
  const userTs = Number(lastUser.timestamp || 0);
  const characterTs = Number(lastCharacter?.timestamp || 0);
  if (!Number.isFinite(userTs) || userTs <= 0) return null;
  if (lastCharacter && (!Number.isFinite(characterTs) || userTs <= characterTs)) return null;
  return lastUser;
}

export function countTrailingRealUserMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  let count = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (isRealUserMessage(message)) {
      count += 1;
      continue;
    }
    if (isCharacterConversationMessage(message)) break;
  }
  return count;
}

function compactReplyAnchorText(message = {}, limit = 180) {
  const text = String(message?.metadata?.text || message?.content || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return `[${String(message?.type || '消息')}]`;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 真人感计时器只决定何时回复，不决定回复哪一条。把当前连续未回应批次重贴在
 * 请求尾部，防止长串用户消息里模型仍盯着最早启动计时器的那条。
 */
export function buildRealPersonReplyFreshnessBlock(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const trailing = [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (isRealUserMessage(message)) {
      trailing.unshift(message);
      continue;
    }
    if (isCharacterConversationMessage(message)) break;
  }
  if (!trailing.length) return '';
  const latest = trailing[trailing.length - 1];
  return [
    '【真人感接话落点 · 当前未回应批次】',
    trailing.length > 1
      ? `等待期间用户连续发来了 ${trailing.length} 条消息；它们共同组成当前待回应内容，计时器最早被哪一条触发不代表只回复哪一条。`
      : '当前只有 1 条尚未回应的用户消息。',
    `最新一条（本轮回复落点）：${compactReplyAnchorText(latest)}`,
    '优先接住最新意图，再按重要性补接前面仍需回应的内容；禁止跳回较早消息并把它误当成“刚才”。',
  ].join('\n');
}

// presence 守屏窗口：真人感模式下角色声明「这段时间我守在手机边」，
// 窗口内用户一发消息，前端会在短暂防抖后自动推进一轮（抢话）。
export const PRESENCE_WATCH_MIN_MINUTES = 1;
export const PRESENCE_WATCH_MAX_MINUTES = 30;
export const PRESENCE_MAX_GRABS_PER_WINDOW = 3;

// TA 登记过「稍后回来」（next_reply_delay）时接话默认让路；
// 但用户连发达到这个条数就把 TA 震回来：取消定点、当场接话。
export const REAL_PERSON_DELAY_BREAKTHROUGH_BURST = 5;

/**
 * 普通真人感只有明确 online 才能走即时接话。
 * away / busy / offline 都先交给忙碌门禁，保留持久回复票等待状态松动。
 */
export function isRealPersonReplyVisiblyBusy({
  visibleStatusBusy = false,
  presenceState = 'online',
} = {}) {
  return visibleStatusBusy === true || String(presenceState || 'online') !== 'online';
}

export function isManualPresenceReplyBlocked({
  presenceState = 'online',
  presenceSource = '',
} = {}) {
  return String(presenceSource || '') === 'manual'
    && ['busy', 'offline'].includes(String(presenceState || 'online'));
}

/**
 * 真人感基础接话延迟：在线正常聊天固定使用「无输入等待」。
 * 回复频率、守屏、冷启动与用户连发不改变这一基础值；忙碌/离线是否回应
 * 由到点后的忙碌门禁判断，连发只用于突破该门禁。
 */
export function computeRealPersonReplyDelayMs({
  minDelayMs = 2500,
} = {}) {
  const configured = Math.trunc(Number(minDelayMs));
  return Number.isFinite(configured) && configured > 0 ? configured : 2500;
}

// 等待情绪（wait_mood）：AI 每轮可声明「这轮说完在不在等回音」，
// 追发间隔按它在频率档划定的范围内伸缩；声明缺失或过期时按 normal（＝现状）走。
export const WAIT_MOOD_MULTIPLIER = { eager: 0.6, normal: 1, cool: 1.8 };

export function normalizeWaitMoodLevel(value) {
  const level = clean(value).toLowerCase();
  if (['eager', 'high', 'urgent', 'waiting'].includes(level)) return 'eager';
  if (['cool', 'calm', 'low', 'chill', 'idle'].includes(level)) return 'cool';
  return 'normal';
}

export function normalizeWaitMoodEvent(event = {}, options = {}) {
  if (event?.t !== 'wait_mood') return null;
  const actorId = clean(event.from || event.actor);
  const participants = new Set((options.chat?.participants || []).map((id) => clean(id)).filter(Boolean));
  if (!actorId || actorId === 'user' || (participants.size && !participants.has(actorId))) return null;
  return {
    actorId,
    level: normalizeWaitMoodLevel(event.level || event.mood),
    reason: clean(event.reason, 200),
  };
}

/** 真人感开着时把本轮声明的等待情绪落进 chat prefs；一轮多条取最后一条。 */
export async function applyMarshmallowWaitMoodEvents(events = [], options = {}, overrides = {}) {
  const userId = clean(options.userId || options.user?.id);
  const chat = options.chat || options.sourceChat || null;
  const now = Math.trunc(Number(options.now || Date.now()));
  const items = (Array.isArray(events) ? events : [])
    .map((event) => normalizeWaitMoodEvent(event, { chat }))
    .filter(Boolean);
  if (!userId || !chat?.id || !items.length) {
    return { handled: 0, skipped: items.length, errors: [] };
  }
  const enabled = overrides.isEnabled
    ? await overrides.isEnabled(userId, chat)
    : await (async () => {
      try {
        const mod = await import('../character-autonomy-settings.js');
        const actorId = (chat?.participants || []).find((id) => id && id !== 'user');
        if (!actorId) return false;
        const policy = await mod.loadResolvedCharacterAutonomyPolicy?.(userId, actorId, chat?.id || '');
        return policy?.realPersonMode?.enabled === true;
      } catch (_) {
        return false;
      }
    })();
  if (!enabled) return { handled: 0, skipped: items.length, errors: [] };
  const item = items[items.length - 1];
  try {
    const patch = overrides.patchPrefs
      || (await import('../chat-block-state.js')).patchChatPrefs;
    await patch(chat.id, {
      waitMoodState: {
        level: item.level,
        reason: item.reason,
        updatedAt: now,
        aiRoundId: clean(options.aiRoundId),
      },
    });
  } catch (error) {
    return { handled: 0, skipped: items.length, errors: [{ message: clean(error?.message || error || 'wait-mood-save-failed') }] };
  }
  return { handled: 1, skipped: Math.max(0, items.length - 1), errors: [] };
}

/** 声明只对「当前这段沉默」有效：锚点（最后一条用户消息）之后声明的才算。 */
export function resolveActiveWaitMood(prefs = {}, anchorTs = 0) {
  const state = prefs?.waitMoodState;
  if (!state || typeof state !== 'object') return '';
  const updatedAt = Number(state.updatedAt || 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  if (updatedAt < Number(anchorTs || 0)) return '';
  return normalizeWaitMoodLevel(state.level);
}

// 用户自设的追发最短间隔（分钟）：所有追发/顶一下的硬下限兜底。
// 旧版曾把 0 解释为“不额外设限”，会让高频 + eager + 守屏叠加后缩到几十秒；
// 现在缺失、非法和非正数都回到安全默认，关闭追发改由 chaseBeatMaxRounds=0 明确表达。
export const CHASE_MIN_INTERVAL_MAX_MINUTES = 1440;
export const DEFAULT_CHASE_MIN_INTERVAL_MINUTES = 20;

export function isAutomaticGenerationAnchorStopped(prefs = {}, message = {}) {
  const stopped = prefs?.automaticGenerationStoppedAnchor;
  if (!stopped || typeof stopped !== 'object' || !message) return false;
  const messageId = String(message.id || '').trim();
  if (messageId && String(stopped.messageId || '').trim() === messageId) return true;
  return !messageId
    && Number(message.timestamp || 0) > 0
    && Number(stopped.messageTimestamp || 0) === Number(message.timestamp || 0);
}

export function resolveChaseMinIntervalMs(prefs = {}) {
  const minutes = Math.trunc(Number(prefs?.chaseMinIntervalMinutes));
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return DEFAULT_CHASE_MIN_INTERVAL_MINUTES * 60 * 1000;
  }
  return Math.min(CHASE_MIN_INTERVAL_MAX_MINUTES, minutes) * 60 * 1000;
}

// 追发（已读不回连续调用）：用户没回话时 AI 再开口的等待时长。
// 扳机从强到弱：守屏（模型登记的「我在等回应」）> 热聊突断（刚才明明你来我往）
// > 问句收尾 > 保底（TA 说完话没人接，等几分钟也会自己看情况顶一下，
// 场景词里保留 TA 选择沉默的权利）。同一段沉默最多追 2 次，第二次明显拖长；
// 用户一说话就重置。
export const REAL_PERSON_MAX_CHASES_PER_SILENCE = 2;
const CHASE_PRESENCE_RANGE_MS = [45_000, 150_000];
const CHASE_RAPID_RANGE_MS = [90_000, 240_000];
const CHASE_QUESTION_RANGE_MS = [180_000, 360_000];
const CHASE_BASELINE_RANGE_MS = [240_000, 480_000];
const CHASE_SECOND_MULTIPLIER = 1.6;
// 前台追发也吃频率档：低频角色不该一两分钟就顶一下。
const CHASE_FREQUENCY_MULTIPLIER = { high: 0.7, normal: 1, low: 1.8 };

export function computeRealPersonChaseDelayMs({
  presenceActive = false,
  rapidExchange = false,
  endsWithQuestion = false,
  chaseCount = 0,
  maxChases = REAL_PERSON_MAX_CHASES_PER_SILENCE,
  frequencyPreset = 'normal',
  waitMood = '',
  minIntervalMs = 0,
  random = Math.random,
} = {}) {
  const done = Math.max(0, Math.trunc(Number(chaseCount) || 0));
  const configuredMax = Number(maxChases);
  const cap = Number.isFinite(configuredMax)
    ? Math.max(0, Math.trunc(configuredMax))
    : REAL_PERSON_MAX_CHASES_PER_SILENCE;
  if (done >= cap) return null;
  const range = presenceActive
    ? CHASE_PRESENCE_RANGE_MS
    : (rapidExchange
      ? CHASE_RAPID_RANGE_MS
      : (endsWithQuestion ? CHASE_QUESTION_RANGE_MS : CHASE_BASELINE_RANGE_MS));
  const base = range[0] + random() * (range[1] - range[0]);
  const freqMult = CHASE_FREQUENCY_MULTIPLIER[String(frequencyPreset || 'normal')] || 1;
  const moodMult = WAIT_MOOD_MULTIPLIER[String(waitMood || '')] || 1;
  const delay = base * freqMult * moodMult * (done > 0 ? CHASE_SECOND_MULTIPLIER : 1);
  const floor = Math.max(0, Math.trunc(Number(minIntervalMs) || 0));
  return Math.round(Math.max(delay, floor));
}

/**
 * 热聊检测：最近几条可见消息里双方你来我往、间隔都很短，说明对话正热。
 * 模型忘了登记守屏、上一轮也不是问句时，热聊突然沉默同样值得追一下——
 * 这是不额外花 API 调用的本地兜底扳机。消息用相对时间差判断，不依赖系统时钟。
 */
export function detectRapidExchange(messages = [], {
  windowSize = 10,
  maxGapMs = 3 * 60 * 1000,
  minQuickTurns = 3,
} = {}) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((message) => isRealUserMessage(message) || isCharacterConversationMessage(message))
    .slice(-Math.max(2, windowSize));
  let quickTurns = 0;
  let userCount = 0;
  let aiCount = 0;
  for (let i = 0; i < list.length; i += 1) {
    const cur = list[i];
    if (!cur) continue;
    if (isRealUserMessage(cur)) userCount += 1;
    else aiCount += 1;
    if (i === 0) continue;
    const prev = list[i - 1];
    const prevIsUser = isRealUserMessage(prev);
    const curIsUser = isRealUserMessage(cur);
    if (prevIsUser === curIsUser) continue;
    const gap = Number(cur.timestamp || 0) - Number(prev?.timestamp || 0);
    if (Number.isFinite(gap) && gap >= 0 && gap <= maxGapMs) quickTurns += 1;
  }
  return userCount >= 2 && aiCount >= 2 && quickTurns >= minQuickTurns;
}

function clean(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function settingKey(userId, chatId) {
  return `chatPresenceWatch:${clean(userId)}:${clean(chatId)}`;
}

export function normalizePresenceEvent(event = {}, options = {}) {
  if (event?.t !== 'presence') return null;
  const actorId = clean(event.from || event.actor);
  const participants = new Set((options.chat?.participants || []).map((id) => clean(id)).filter(Boolean));
  const rawMinutes = Math.trunc(Number(event.minutes || event.windowMinutes || 0));
  if (!actorId || actorId === 'user' || (participants.size && !participants.has(actorId))) return null;
  if (!Number.isFinite(rawMinutes) || rawMinutes < PRESENCE_WATCH_MIN_MINUTES) return null;
  return {
    actorId,
    minutes: Math.min(rawMinutes, PRESENCE_WATCH_MAX_MINUTES),
    reason: clean(event.reason || event.topic, 300),
  };
}

export async function applyMarshmallowPresenceEvents(events = [], options = {}, overrides = {}) {
  const userId = clean(options.userId || options.user?.id);
  const chat = options.chat || options.sourceChat || null;
  const now = Math.trunc(Number(options.now || Date.now()));
  const enabled = overrides.isEnabled
    ? await overrides.isEnabled(userId, chat)
    : await (async () => {
      try {
        const mod = await import('../character-autonomy-settings.js');
        const actorId = (chat?.participants || []).find((id) => id && id !== 'user');
        if (!actorId) return false;
        const policy = await mod.loadResolvedCharacterAutonomyPolicy?.(userId, actorId, chat?.id || '');
        return policy?.realPersonMode?.enabled === true;
      } catch (_) {
        return false;
      }
    })();
  const items = (Array.isArray(events) ? events : [])
    .map((event) => normalizePresenceEvent(event, { chat }))
    .filter(Boolean);
  if (!userId || !chat?.id || !items.length || !enabled) {
    return { handled: 0, skipped: items.length, errors: [] };
  }
  // 一轮最多生效一个窗口；取分钟数最大的那条。
  const item = items.reduce((best, cur) => (cur.minutes > best.minutes ? cur : best), items[0]);
  const record = {
    key: settingKey(userId, chat.id),
    value: {
      version: 1,
      actorId: item.actorId,
      chatId: clean(chat.id),
      reason: item.reason,
      createdAt: now,
      expiresAt: now + item.minutes * 60 * 1000,
      grabsUsed: 0,
      maxGrabs: PRESENCE_MAX_GRABS_PER_WINDOW,
      sourceAiRoundId: clean(options.aiRoundId),
    },
  };
  const save = overrides.save || dbPut;
  try {
    await save(record);
  } catch (error) {
    return { handled: 0, skipped: items.length, errors: [{ message: clean(error?.message || error || 'presence-save-failed') }] };
  }
  return { handled: 1, skipped: Math.max(0, items.length - 1), errors: [] };
}

export async function loadPresenceWatch(userId, chatId, overrides = {}) {
  if (!clean(userId) || !clean(chatId)) return null;
  const read = overrides.read || dbGet;
  const row = await read(settingKey(userId, chatId)).catch(() => null);
  const value = row?.value;
  if (!value) return null;
  const expiresAt = Number(value.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const grabsUsed = Math.max(0, Number(value.grabsUsed) || 0);
  const maxGrabs = Math.max(1, Number(value.maxGrabs) || PRESENCE_MAX_GRABS_PER_WINDOW);
  if (grabsUsed >= maxGrabs) return null;
  return { ...value, grabsUsed, maxGrabs };
}

// 占用一次抢话额度；返回 true 表示这次自动推进被允许。
export async function consumePresenceGrab(userId, chatId, overrides = {}) {
  const watch = await loadPresenceWatch(userId, chatId, overrides);
  if (!watch) return false;
  const save = overrides.save || dbPut;
  try {
    await save({
      key: settingKey(userId, chatId),
      value: { ...watch, grabsUsed: watch.grabsUsed + 1 },
    });
  } catch (_) {
    return false;
  }
  return true;
}
