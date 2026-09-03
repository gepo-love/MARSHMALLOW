/**
 * 真人感·后台追发拍（chase beat）
 *
 * 老追发只活在聊天页的前台定时器里：切后台、关 App 就哑了。
 * 这里把「下一拍要不要追」登记成 pending action，由本地保活扫描 / 回前台补跑执行，
 * 等待回复的空白时间因此长出内容：
 * - 每一拍是情绪渐进的一格：轻顶 → 起伏 → 收线放下手机；
 * - 「整轮不发消息、只留下动作痕迹（改状态、发动态、点赞评论、备忘录、跨窗吐槽）」是一等产出；
 * - 下一拍要不要有，由这一拍执行完后的最新状态重新决定（persist 端统一调度）。
 *
 * 防双发依赖执行时校验而不是取消簿记：
 * 拍到点时只要发现有比登记时更新的可见消息（无论哪边发的），这拍就自动作废——
 * 更新的那一轮已经在自己的 persist 里重排过新拍了。
 */

import { getChat, listMessagesForChat } from '../chat-store.js';
import { getCharacter } from '../character-store.js';
import {
  loadChatPrefsFresh,
  updateChatPrefsAtomic,
} from '../chat-block-state.js';
import {
  cancelPendingActions,
  enqueuePendingAction,
  listPendingActions,
} from './pending-actions.js';
import { runHeadlessChatReply } from './headless-reply.js';
import { getChatComposerState } from './idle-continue-reply.js';
import {
  normalizeWaitMoodEvent,
  isAutomaticGenerationAnchorStopped,
  resolveActiveWaitMood,
  resolveChaseMinIntervalMs,
  WAIT_MOOD_MULTIPLIER,
} from './marshmallow-presence.js';
import { isAnonymousChat } from '../chat-helpers.js';
import { isStrangerInterceptChat } from '../stranger-thread-model.js';
import { getUserDisplayName } from '../../models/user.js';
import { getNowForUser, getPacingNowForUser } from '../time-mode.js';
import { resolveCharacterScheduleTimezone } from './chat-timezone.js';
import { buildRealPersonChaseNoveltyDirective } from './thread-scene.js';
import { loadChatCharState } from './character-state.js';
import {
  loadPsychologicalContinuity,
  parseLegacyPendingIntent,
} from './psychological-continuity.js';

export const MAX_CHASE_BEATS = 3;
export const MIN_CHASE_BEAT_ROUNDS = 0;
export const MAX_CHASE_BEAT_ROUNDS = 5;
const chaseGenerationLocks = new Set();

/** 同一 user/chat/character 的前台追发与后台票共用一把跨标签页生成锁。 */
export async function withRealPersonChaseGenerationLock(scope = {}, task) {
  if (typeof task !== 'function') throw new TypeError('chase generation lock requires a task');
  const userId = clean(scope.userId);
  const chatId = clean(scope.chatId);
  const characterId = clean(scope.characterId);
  if (!userId || !chatId || !characterId) return { acquired: false, reason: 'invalid-scope' };
  const localKey = `${userId}:${chatId}:${characterId}`;
  const run = async () => {
    if (chaseGenerationLocks.has(localKey)) return { acquired: false, reason: 'local-busy' };
    chaseGenerationLocks.add(localKey);
    try {
      return { acquired: true, value: await task() };
    } finally {
      chaseGenerationLocks.delete(localKey);
    }
  };
  const locks = globalThis.navigator?.locks;
  if (locks && typeof locks.request === 'function') {
    return locks.request(
      `marshmallow:real-person-chase:${localKey}`,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => (lock ? run() : { acquired: false, reason: 'cross-tab-busy' }),
    );
  }
  return run();
}

export function normalizeChaseBeatMaxRounds(value, fallback = MAX_CHASE_BEATS) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return Math.max(MIN_CHASE_BEAT_ROUNDS, Math.min(MAX_CHASE_BEAT_ROUNDS, fallback));
  return Math.max(MIN_CHASE_BEAT_ROUNDS, Math.min(MAX_CHASE_BEAT_ROUNDS, n));
}

export function resolveChaseBeatMaxRounds(prefs = {}) {
  return normalizeChaseBeatMaxRounds(prefs?.chaseBeatMaxRounds, MAX_CHASE_BEATS);
}

// 各拍距离「上一次有人说话」的等待区间（毫秒）。前台定时器管的是分钟级快追，
// 这里接的是它够不到的后半场，所以从第一拍起就比前台的基线慢半拍。
const BEAT_DELAY_RANGES_MS = [
  [8 * 60 * 1000, 15 * 60 * 1000],
  [20 * 60 * 1000, 45 * 60 * 1000],
  [60 * 60 * 1000, 120 * 60 * 1000],
];
const FREQUENCY_MULTIPLIER = { high: 0.6, normal: 1, low: 1.6 };
// 拍的等待可以很长，默认 3 小时的待办过期兜不住最后一拍，单独放宽。
const CHASE_BEAT_EXPIRE_MS = 12 * 60 * 60 * 1000;
const SUPERSEDED_EPSILON_MS = 1500;
const CHASE_GENERATION_CLAIM_FIELDS = Object.freeze({
  chase_beat: 'chaseBeatGenerationClaim',
  cold_follow_up: 'coldFollowUpGenerationClaim',
});

// 冷场破冰：追发拍收线之后，人不会从此永久沉默——隔大半天到一两天会重新想起对方。
// 每段沉默（同一锚点）最多两次：第一次像「睡一觉起来想起你」，第二次隔得更久、更淡；
// 之后才真正把主动权还给用户。
const COLD_FOLLOW_UP_DELAY_RANGES_MS = [
  [6 * 60 * 60 * 1000, 16 * 60 * 60 * 1000],
  [26 * 60 * 60 * 1000, 48 * 60 * 60 * 1000],
];
export const MAX_COLD_FOLLOW_UPS = COLD_FOLLOW_UP_DELAY_RANGES_MS.length;
// 到点时可能整晚没开 App：过期窗放一整天，回前台补跑还能接住。
const COLD_FOLLOW_UP_EXPIRE_MS = 24 * 60 * 60 * 1000;

function clean(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

export function computeChaseBeatDelayMs(beatIndex = 0, frequencyPreset = 'normal', random = Math.random, {
  waitMood = '',
  minIntervalMs = 0,
} = {}) {
  const index = Math.max(0, Math.min(BEAT_DELAY_RANGES_MS.length - 1, Math.trunc(Number(beatIndex) || 0)));
  const [min, max] = BEAT_DELAY_RANGES_MS[index];
  const multiplier = FREQUENCY_MULTIPLIER[String(frequencyPreset || 'normal')] || 1;
  const moodMult = WAIT_MOOD_MULTIPLIER[String(waitMood || '')] || 1;
  const floor = Math.max(0, Math.trunc(Number(minIntervalMs) || 0));
  return Math.round(Math.max((min + random() * (max - min)) * multiplier * moodMult, floor));
}

export function computeColdFollowUpDelayMs(followUpIndex = 0, frequencyPreset = 'normal', random = Math.random, {
  minIntervalMs = 0,
} = {}) {
  const index = Math.max(0, Math.min(COLD_FOLLOW_UP_DELAY_RANGES_MS.length - 1, Math.trunc(Number(followUpIndex) || 0)));
  const [min, max] = COLD_FOLLOW_UP_DELAY_RANGES_MS[index];
  const multiplier = FREQUENCY_MULTIPLIER[String(frequencyPreset || 'normal')] || 1;
  const floor = Math.max(0, Math.trunc(Number(minIntervalMs) || 0));
  return Math.round(Math.max((min + random() * (max - min)) * multiplier, floor));
}

/** 同一段沉默里已经破冰过几次：锚点（最后一条用户消息）一变就从 0 重来。 */
export function resolveColdFollowUpDone(prefs = {}, anchorTs = 0) {
  const state = prefs?.coldFollowUpState;
  if (!state || typeof state !== 'object') return 0;
  if (Number(state.anchorTs || 0) !== Number(anchorTs || 0)) return 0;
  return Math.max(0, Math.trunc(Number(state.done || 0)) || 0);
}

function lastVisibleMessage(messages = []) {
  let latest = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.deleted || message.recalled) continue;
    if (String(message.senderId || '') === 'system') continue;
    if (String(message.type || '') === 'system' || String(message.type || '') === 'storyCard') continue;
    const ts = Number(message.timestamp || 0);
    if (!ts) continue;
    if (!latest || ts >= Number(latest.timestamp || 0)) latest = message;
  }
  return latest;
}

function lastUserMessageTs(messages = []) {
  let latest = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.deleted || message.recalled) continue;
    if (String(message.senderId || '') !== 'user') continue;
    latest = Math.max(latest, Number(message.timestamp || 0) || 0);
  }
  return latest;
}

/** 同一段沉默里已经追过几拍：锚点（最后一条用户消息）一变就从 0 重来。 */
export function resolveChaseBeatDone(prefs = {}, anchorTs = 0) {
  const state = prefs?.chaseBeatState;
  if (!state || typeof state !== 'object') return 0;
  if (Number(state.anchorTs || 0) !== Number(anchorTs || 0)) return 0;
  return Math.max(0, Math.trunc(Number(state.done || 0)) || 0);
}

/**
 * 软合并：沉默期间日程/延时/分享跟进等「外源主动开口」也算消耗一拍情绪额度。
 * 已经是追发拍自己记账的不重复加；本轮没有角色可见消息也不加。
 * 只有「本轮开始前就已经在等用户」才算外源开口——用户刚说完、TA 正常接话不算。
 */
export function resolveSoftMergedChaseBeatDone({
  done = 0,
  wasAlreadyWaiting = false,
  hasCharVisibleOpening = false,
  alreadyCredited = false,
  maxBeats = MAX_CHASE_BEATS,
} = {}) {
  const base = Math.max(0, Math.trunc(Number(done) || 0));
  const cap = normalizeChaseBeatMaxRounds(maxBeats, MAX_CHASE_BEATS);
  if (!wasAlreadyWaiting || !hasCharVisibleOpening || alreadyCredited) return base;
  return Math.min(cap, base + 1);
}

function isCharacterVisibleMessage(message) {
  if (!message || message.deleted || message.recalled) return false;
  const senderId = String(message.senderId || '');
  if (!senderId || senderId === 'user' || senderId === 'system') return false;
  const type = String(message.type || '');
  if (type === 'system' || type === 'storyCard') return false;
  return true;
}

const CHASE_OPEN_COMPOSITION_ACTS = new Set([
  'ask',
  'question',
  'follow-up',
  'followup',
  'invite',
  'invitation',
  'prompt',
  'probe',
  'check-in',
  'checkin',
  'request',
  'propose',
  'proposal',
  'tease',
  'hook',
  'defer',
  'deferred',
  'promise',
  'continue-later',
  'callback',
]);

const CHASE_OPEN_COMPOSITION_REF = /(?:^|-)(?:pending|follow-?up|later|deferred|unsaid|unfinished|open-loop|hook|continuation|next-beat|owed|promise|callback)(?:-|$)/u;

function compositionToken(value = '') {
  return clean(value, 120).toLowerCase().replace(/[\s_:]+/g, '-');
}

function compositionList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => compositionToken(item))
    .filter(Boolean))];
}

function hasReplyCompositionMetadata(message) {
  const metadata = message?.metadata;
  return !!(
    metadata
    && Number(metadata.replyCompositionVersion || 0) === 1
    && clean(metadata.replyCompositionTopicMove)
  );
}

/**
 * 三拍只接明确留下的会话线头。文本问号与沉默时长不是资格信号：
 * - 新回复组织收据必须明确留下 ask / invite / defer 等开放动作，或 pending / later 等待续 ref；
 * - 旧协议只接受严格的「待续：…｜触发：…」，且必须允许角色稍后主动。
 */
export function resolveChaseBeatThreadEligibility({
  messages = [],
  characterId = '',
  legacyIntent = '',
} = {}) {
  const actorId = clean(characterId);
  const anchorTs = lastUserMessageTs(messages);
  const characterMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => (
      isCharacterVisibleMessage(message)
      && (!actorId || clean(message.senderId) === actorId)
      && Number(message.timestamp || 0) >= anchorTs
    ))
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
  const latestComposition = [...characterMessages].reverse().find(hasReplyCompositionMetadata) || null;
  if (latestComposition) {
    const roundId = clean(latestComposition.metadata?.aiRoundId);
    const compositionMessages = roundId
      ? characterMessages.filter((message) => (
        hasReplyCompositionMetadata(message)
        && clean(message.metadata?.aiRoundId) === roundId
      ))
      : [latestComposition];
    const topicMove = compositionToken(latestComposition.metadata?.replyCompositionTopicMove || '');
    const acts = compositionList(compositionMessages.flatMap((message) => (
      message.metadata?.replyCompositionActs || []
    )));
    const refs = compositionList(compositionMessages.flatMap((message) => (
      message.metadata?.replyCompositionRefs || []
    )));
    if (topicMove !== 'close') {
      const openAct = acts.find((act) => CHASE_OPEN_COMPOSITION_ACTS.has(act));
      if (openAct) {
        return { eligible: true, source: 'reply-composition-act', topicMove, act: openAct, acts, refs };
      }
      const openRef = refs.find((ref) => CHASE_OPEN_COMPOSITION_REF.test(ref));
      if (openRef) {
        return { eligible: true, source: 'reply-composition-ref', topicMove, ref: openRef, acts, refs };
      }
    }
  }

  const pending = parseLegacyPendingIntent(legacyIntent);
  if (pending?.triggers?.includes('character_later')) {
    return {
      eligible: true,
      source: 'legacy-pending-intent',
      proposition: pending.proposition,
      triggers: pending.triggers,
    };
  }
  return { eligible: false, source: 'none' };
}

export async function resolveStoredChaseBeatThreadEligibility({
  userId = '',
  chatId = '',
  characterId = '',
  messages = [],
} = {}) {
  const composition = resolveChaseBeatThreadEligibility({ messages, characterId });
  if (composition.eligible) return composition;
  const uid = clean(userId);
  const cid = clean(chatId);
  const actorId = clean(characterId);
  if (uid && cid && actorId) {
    const runtime = await loadPsychologicalContinuity({
      userId: uid,
      chatId: cid,
      participantIds: [actorId],
    }).catch(() => null);
    const openThread = (runtime?.actors?.[actorId]?.disclosureThreads || []).find((thread) => (
      thread?.status === 'open'
      && Array.isArray(thread.triggers)
      && thread.triggers.includes('character_later')
    ));
    if (openThread) {
      return {
        eligible: true,
        source: 'psychological-open-thread',
        threadId: clean(openThread.id),
        topicId: clean(openThread.topicId),
      };
    }
  }
  const state = await loadChatCharState(chatId).catch(() => ({}));
  return resolveChaseBeatThreadEligibility({
    messages,
    characterId,
    legacyIntent: state?.[characterId]?.intent || '',
  });
}

export function isChaseBeatAlreadyCreditedRound({ reason = '', realPersonChase = false, chaseBeatAlreadyCredited = false } = {}) {
  if (chaseBeatAlreadyCredited === true || realPersonChase === true) return true;
  return /chase-beat|real-person-chase/i.test(String(reason || ''));
}

export function isChaseBeatEligibleChat(chat) {
  if (!chat || chat.type !== 'private') return false;
  const participants = Array.isArray(chat.participants) ? chat.participants : [];
  if (!participants.includes('user')) return false;
  if (participants.filter((id) => id && id !== 'user').length !== 1) return false;
  if (isAnonymousChat(chat) || isStrangerInterceptChat(chat)) return false;
  if (String(chat.metadata?.phoneChannel || '').trim()) return false;
  return true;
}

/**
 * 一轮成功落库后调用（persist 端）：这轮说完仍在等用户时，把下一拍登记成待办。
 * 用户回话、TA 自己登记了延时、拍数用完时反过来清掉挂着的拍。
 * 沉默期间若是日程/延时等外源主动开口，软合并进情绪拍号，不假装没发生过。
 */
export async function maybeScheduleChaseBeatAfterRound({
  chat,
  userId,
  prefs = {},
  priorMessages = [],
  savedMessages = [],
  sideEffects = [],
  reason = '',
  realPersonChase = false,
  chaseBeatAlreadyCredited = false,
  now = 0,
} = {}) {
  const uid = clean(userId);
  if (!uid || !isChaseBeatEligibleChat(chat)) return { ok: false, reason: 'ineligible-chat' };
  now = Number(now || 0) || await getPacingNowForUser(uid);
  // 后台执行器、前台页面与另一个标签页可能共用同一段沉默。
  // 排下一拍前直接读落库账本，不让调用方的 realm-local prefs 缓存回退拍号。
  const persistedPrefs = await loadChatPrefsFresh(chat.id).catch(() => null);
  prefs = persistedPrefs ? { ...(prefs || {}), ...persistedPrefs } : (prefs || {});
  if (prefs?.guidanceMode === true) return { ok: false, reason: 'guidance-mode' };
  const characterId = (chat.participants || []).find((id) => id && id !== 'user');
  const prior = Array.isArray(priorMessages) ? priorMessages : [];
  const saved = Array.isArray(savedMessages) ? savedMessages : [];
  const all = [...prior, ...saved];
  const lastVisible = lastVisibleMessage(all);
  const priorLast = lastVisibleMessage(prior);

  // 任何新一轮的重新排期都同时接管破冰票：旧的追发拍与冷场破冰一并作废重排。
  const cancelBeats = () => cancelPendingActions(uid, (action) => (
    (action.kind === 'chase_beat' || action.kind === 'cold_follow_up') && action.chatId === chat.id
  )).catch(() => {});

  // 这轮以用户发言收尾（或整轮没可见消息）：沉默不成立，清拍等常规接话。
  if (!lastVisible || String(lastVisible.senderId || '') === 'user') {
    await cancelBeats();
    return { ok: false, reason: 'not-waiting-on-user' };
  }
  // TA 自己登记了「稍后回来」：延时回复接管续场，拍让位（延时到点那轮会重新评估）。
  const hasDelay = (Array.isArray(sideEffects) ? sideEffects : []).some((e) => e?.t === 'next_reply_delay');
  if (hasDelay) {
    await cancelBeats();
    return { ok: false, reason: 'delayed-reply-owns' };
  }

  const maxBeats = resolveChaseBeatMaxRounds(prefs);
  if (maxBeats <= 0) {
    await cancelBeats();
    return { ok: false, reason: 'chase-disabled', done: 0 };
  }

  const threadEligibility = await resolveStoredChaseBeatThreadEligibility({
    userId: uid,
    chatId: chat.id,
    characterId,
    messages: all,
  });
  if (!threadEligibility.eligible) {
    await cancelBeats();
    return { ok: false, reason: 'no-open-thread' };
  }

  let policy = null;
  try {
    const { loadResolvedCharacterAutonomyPolicy } = await import('../character-autonomy-settings.js');
    policy = await loadResolvedCharacterAutonomyPolicy(uid, characterId, chat.id);
  } catch (_) { /* 策略读不到时不排拍 */ }
  if (policy?.realPersonMode?.enabled !== true) {
    await cancelBeats();
    return { ok: false, reason: 'real-person-disabled' };
  }
  if (policy?.totalEnabled !== true) {
    await cancelBeats();
    return { ok: false, reason: 'proactive-disabled' };
  }

  const anchorTs = lastUserMessageTs(all);
  const ledgerDone = resolveChaseBeatDone(prefs, anchorTs);
  const wasAlreadyWaiting = !!(priorLast && String(priorLast.senderId || '') !== 'user');
  const hasCharVisibleOpening = saved.some((message) => isCharacterVisibleMessage(message));
  const alreadyCredited = isChaseBeatAlreadyCreditedRound({
    reason,
    realPersonChase,
    chaseBeatAlreadyCredited,
  });
  const done = resolveSoftMergedChaseBeatDone({
    done: ledgerDone,
    wasAlreadyWaiting,
    hasCharVisibleOpening,
    alreadyCredited,
    maxBeats,
  });
  // 外源开口把拍号往前拨了：写回账本，后面的拍和前台计数共用同一本。
  if (done !== ledgerDone) {
    await updateChatPrefsAtomic(chat.id, (current) => {
      const currentDone = resolveChaseBeatDone(current, anchorTs);
      const mergedDone = Math.max(currentDone, done);
      if (mergedDone === currentDone) return undefined;
      return {
        ...current,
        chaseBeatState: { anchorTs, done: mergedDone, updatedAt: now },
      };
    }).catch(() => {});
  }
  // 等待情绪：优先取本轮刚声明的 wait_mood，其次取同一段沉默里早前落库的声明。
  const roundMood = (Array.isArray(sideEffects) ? sideEffects : [])
    .map((event) => normalizeWaitMoodEvent(event, { chat }))
    .filter(Boolean)
    .pop();
  const waitMood = roundMood?.level || resolveActiveWaitMood(prefs, anchorTs);
  const minIntervalMs = resolveChaseMinIntervalMs(prefs);

  if (done >= maxBeats) {
    // 追发收线不等于永久沉默：隔大半天再排一次冷场破冰，让 TA 有「重新想起你」的通道。
    await cancelBeats();
    const coldFollowUp = await maybeScheduleColdFollowUp({
      uid,
      chat,
      characterId,
      prefs,
      anchorTs,
      lastCharTs: Number(lastVisible.timestamp || 0) || 0,
      frequencyPreset: policy?.realPersonMode?.frequencyPreset,
      minIntervalMs,
      now,
    });
    return {
      ok: false,
      reason: 'beats-exhausted',
      done,
      softMerged: done !== ledgerDone,
      coldFollowUp,
    };
  }

  // 排队中的延时回复也算 TA 自己的安排（比如 share_back 的稍后分享），不抢跑。
  try {
    const pending = await listPendingActions(uid);
    const hasOwnPlan = pending.some((action) => (
      action.kind === 'delayed_reply'
      && action.chatId === chat.id
      && Number(action.expiresAt || 0) > now
    ));
    if (hasOwnPlan) {
      await cancelBeats();
      return { ok: false, reason: 'delayed-reply-owns', done };
    }
  } catch (_) { /* 待办读不到时照常排拍 */ }

  const delay = computeChaseBeatDelayMs(done, policy?.realPersonMode?.frequencyPreset, Math.random, {
    waitMood,
    minIntervalMs,
  });
  const dueAt = now + delay;
  await cancelBeats();
  const result = await enqueuePendingAction({
    userId: uid,
    characterId,
    chatId: chat.id,
    kind: 'chase_beat',
    dueAt,
    createdAt: now,
    expiresAt: dueAt + CHASE_BEAT_EXPIRE_MS,
    dedupeKey: `chase-beat:${chat.id}:${anchorTs}:${done}`,
    payload: {
      beatIndex: done,
      anchorTs,
      lastCharTs: Number(lastVisible.timestamp || 0) || 0,
    },
  });
  return result?.ok
    ? { ok: true, action: result.action, beatIndex: done, softMerged: done !== ledgerDone }
    : { ok: false, reason: result?.reason || 'enqueue-failed', done };
}

/** 追发拍收线后排一次冷场破冰；同一段沉默最多 MAX_COLD_FOLLOW_UPS 次。 */
async function maybeScheduleColdFollowUp({
  uid,
  chat,
  characterId,
  prefs = {},
  anchorTs = 0,
  lastCharTs = 0,
  frequencyPreset = 'normal',
  minIntervalMs = 0,
  now = Date.now(),
} = {}) {
  const coldDone = resolveColdFollowUpDone(prefs, anchorTs);
  if (coldDone >= MAX_COLD_FOLLOW_UPS) {
    return { ok: false, reason: 'cold-follow-ups-exhausted', done: coldDone };
  }
  const delay = computeColdFollowUpDelayMs(coldDone, frequencyPreset, Math.random, { minIntervalMs });
  const dueAt = now + delay;
  // 排破冰失败不应影响本轮 persist 收尾：吞掉存储异常，下一轮还有机会重排。
  const result = await enqueuePendingAction({
    userId: uid,
    characterId,
    chatId: chat.id,
    kind: 'cold_follow_up',
    dueAt,
    createdAt: now,
    expiresAt: dueAt + COLD_FOLLOW_UP_EXPIRE_MS,
    dedupeKey: `cold-follow-up:${chat.id}:${anchorTs}:${coldDone}`,
    payload: {
      followUpIndex: coldDone,
      anchorTs,
      lastCharTs,
    },
  }).catch(() => null);
  return result?.ok
    ? { ok: true, action: result.action, followUpIndex: coldDone }
    : { ok: false, reason: result?.reason || 'enqueue-failed', done: coldDone };
}

/** 前台追发/用户开口时的手动清拍入口（chat-thread 用）：追发拍与冷场破冰一并清掉。 */
export async function cancelChaseBeatsForChat(userId, chatId) {
  const uid = clean(userId);
  const id = clean(chatId);
  if (!uid || !id) return { ok: false, removed: 0 };
  return cancelPendingActions(uid, (action) => (
    (action.kind === 'chase_beat' || action.kind === 'cold_follow_up') && action.chatId === id
  )).catch(() => ({ ok: false, removed: 0 }));
}

export function buildChaseBeatDirective({ beatIndex = 0, userName = '对方', silenceMinutes = 0, statusStoryMode = false } = {}) {
  const name = clean(userName, 24) || '对方';
  const silence = silenceMinutes >= 60
    ? `大约 ${Math.round(silenceMinutes / 60)} 小时`
    : `大约 ${Math.max(1, Math.round(silenceMinutes))} 分钟`;
  const shared = [
    `[等待间隙 · 第 ${beatIndex + 1} 拍] ${name} 已经${silence}没回你上一轮的消息。你没在干等——这段时间你在过自己的生活。这一轮由你自己决定做什么，不要替 ${name} 发言，也不要提系统、定时器或“后台”。`,
    buildRealPersonChaseNoveltyDirective(),
    silenceMinutes < 60
      ? `这只是分钟级的暂时没回，不是 ${name} 睡着或失去意识的证据。若 ${name} 刚说在加班、工作或忙别的事，默认仍在忙；禁止无据写成睡着、昏睡、贴在桌上或倒在键盘上，也不要围绕这种猜测追问。`
      : '',
    '你可以改一句顶栏状态、发条动态、给谁点赞评论（刷到用户在你朋友圈的留言必须用 social_react 评论接住）、备忘录记一笔、去别的窗口跟别人说话（包括吐槽对方不回消息），让这段沉默里确实发生过事。若用了 status，也要按人物与【回复节奏 · 错落】判断当前对话里是否有真实内容要交代、分享或找补；不要只为完成状态动作而生成空话。真正完全下线期间的“扫一眼”由系统另行硬静默。',
    statusStoryMode
      ? '本会话开着状态小剧场：若这拍确实换了场景、开始或结束一件事、忙完，或准备去做别的，先在 state.status 写真实场景，并用 status 同步 online / away / busy / offline 与一句符合新处境的公开心情；顶栏不要照抄活动。同一场景仍在持续就保持，不要每拍硬换。只要因有效转场输出 status，就必须在同一个 status 事件附 story，写具体现场、连续动作、感官细节和一个没说出口的念头；禁止只改状态漏掉小剧场。'
      : '',
  ];
  if (beatIndex <= 0) {
    return [
      ...shared,
      '第一拍还轻：表情包、拍一拍或短语音也要表达新的情绪方向/动作；若开口说正文，就带来沉默期间刚发生/刚看到的一件具体小事，或让自己的情绪、行动、决定真正向前变一格。不得引用旧句补半句、续写旧承诺或换词再问。没有真实增量就只留真实状态/行动变化或什么都不做。',
      '不指责对方不回消息（除非人设和关系真的会）；沉稳寡言影响措辞、动作和追人动机，不在本模块里预设消息条数。',
    ].filter(Boolean).join('\n');
  }
  if (beatIndex === 1) {
    return [
      ...shared,
      '第二拍开始有起伏：按人设让情绪自然走——有点在意、自嘲、故作若无其事、继续分享，或转头忙自己的事都合法。若再次开口，必须带来新的内容或情绪变化；若把注意力挪开，就用真实行动或状态体现，不用空消息凑追发。',
      '若要开口，承接自己上一条的情绪且要有方向性变化（例如期待→自嘲收住、担心→决定先去忙），不得只把原情绪加重；不复述、不连环追问。也可以登记 next_reply_delay 把话题留到晚点自己接回。',
    ].filter(Boolean).join('\n');
  }
  return [
    ...shared,
    '第三拍该收线了：绝大多数人设此刻会放下手机——整轮不发 msg，改一句状态、留个痕迹、或干脆什么都不做，让沉默留在那里。这不是冷战，是普通人的一天在继续。',
    '若人设确实会收个尾，可以发一条很淡的收场（类似「好吧你忙」的意思，用你自己的话），发完就真的不再追；只有人设真的会夺命连环 call 才继续，多数角色不该走到那一步。',
  ].filter(Boolean).join('\n');
}

export function buildColdFollowUpDirective({ followUpIndex = 0, userName = '对方', silenceHours = 0, statusStoryMode = false } = {}) {
  const name = clean(userName, 24) || '对方';
  const silence = silenceHours >= 24
    ? `大约 ${Math.round(silenceHours / 24)} 天`
    : `大约 ${Math.max(1, Math.round(silenceHours))} 小时`;
  const shared = [
    `[冷场重启 · 第 ${followUpIndex + 1} 次] 你们已经${silence}没说话了，上一段话题自然冷掉了。你不是在追问，而是过了自己的一段生活之后重新想起 ${name}。不要替 ${name} 发言，不要提系统、定时器或“后台”。`,
    buildRealPersonChaseNoveltyDirective(),
    '重新开口就开新话头：讲你这段时间真实经历的一件小事（刚做完的、刚看到的、突然想到的），或顺手分享一样东西。不要复读没被回复的旧消息，不要一上来就问「怎么不理我」，也不要委屈质问——上段沉默已经翻篇了。',
    statusStoryMode
      ? '本会话开着状态小剧场：这段时间若真实场景已经变化，先在 state.status 落实新处境，再用 status 更新在线态与一句符合新处境的公开心情；只要输出 status，就必须在同一事件附 story 展开这次转场，禁止状态变了却漏掉小剧场。'
      : '',
  ];
  if (followUpIndex <= 0) {
    return [
      ...shared,
      '第一次破冰像睡一觉起来想起对方：一到三条自然短消息，轻松、不翻旧账；按人设可以直接讲事、丢一张图/表情包，或懒散地起个新话头。',
    ].filter(Boolean).join('\n');
  }
  return [
    ...shared,
    '第二次破冰更淡：对方上次破冰也没接话，多数人设此刻只会淡淡留一句或分享个不用回的东西（链接、歌、照片式的一句话），发完就继续过自己的日子，不追问、不设问句结尾。',
  ].filter(Boolean).join('\n');
}

async function notifyBeatDelivery(chat, character, result, reason = '') {
  if (!chat?.id || !character || !result?.ok || !Number(result.messageCount || 0)) return;
  try {
    const {
      bumpPersistedMessagesUnread,
      notifyCharacterSentMessageIfEnabled,
      shouldNotifyForBackgroundReason,
    } = await import('../native-notifications.js');
    if (!shouldNotifyForBackgroundReason(reason, chat.id)) return;
    await bumpPersistedMessagesUnread(chat.id, result.messages).catch(() => {});
    await notifyCharacterSentMessageIfEnabled({
      characterName: character.customNickname || character.name || '',
      chatId: chat.id,
      tag: `chase-beat-${character.id}`,
      messages: result.messages,
      requireHidden: false,
      avatar: character.avatar || '',
    }).catch(() => {});
  } catch (_) {}
}

/**
 * 追发拍与冷场破冰到点时共用的全套现实校验：
 * 会话/角色还在、用户没开口、票没被更新一轮取代、没在打字、策略还开着、
 * 不在静音/线下/延时接管里、预算可用。返回 { blocked } 或 { chat, character, prefs, lastVisible }。
 */
async function prepareWaitingTicket(action) {
  const [chat, character] = await Promise.all([
    getChat(action.chatId),
    getCharacter(action.characterId, { userId: action.userId }),
  ]);
  if (!chat || !character) return { blocked: { ok: false, reason: 'chat-or-character-missing', terminal: true } };
  if (chat.userId && clean(chat.userId) !== action.userId) {
    return { blocked: { ok: false, reason: 'user-slot-mismatch', terminal: true } };
  }
  if (!isChaseBeatEligibleChat(chat) || !(chat.participants || []).includes(action.characterId)) {
    return { blocked: { ok: false, reason: 'ineligible-chat', terminal: true } };
  }
  let prefs = await loadChatPrefsFresh(chat.id).catch(() => ({}));
  try {
    const { loadChatPrefsWithExpiredStatus } = await import('../status-ttl.js');
    prefs = await loadChatPrefsWithExpiredStatus(chat.id, { fresh: true });
  } catch (_) { /* 过期清理不可用时沿用原 prefs */ }
  if (prefs.guidanceMode === true) return { blocked: { ok: true, skipped: 'guidance-mode' } };
  try {
    const {
      hasAuthoritativeCharacterPresence,
      loadCharacterLiveState,
    } = await import('../character-live-state.js');
    const liveState = await loadCharacterLiveState(action.userId, action.characterId, {
      presenceNow: Date.now(),
    });
    const presence = hasAuthoritativeCharacterPresence(liveState?.presence)
      ? String(liveState.presence.state || 'online')
      : (prefs.presenceState === 'offline' ? 'offline' : 'online');
    if (presence !== 'online') {
      return { blocked: { ok: false, reason: 'soft-offline' } };
    }
  } catch (_) { /* 在线态门禁读不到时沿用后续现实校验 */ }

  const maxBeats = resolveChaseBeatMaxRounds(prefs);
  if (maxBeats <= 0) {
    return { blocked: { ok: false, reason: 'chase-disabled', terminal: true } };
  }
  if (
    action.kind === 'chase_beat'
    && Math.max(0, Math.trunc(Number(action.payload?.beatIndex || 0))) >= maxBeats
  ) {
    return { blocked: { ok: false, reason: 'chase-limit-reduced', terminal: true } };
  }
  const actionAnchorTs = Number(action.payload?.anchorTs || 0) || 0;
  if (action.kind === 'chase_beat') {
    const beatIndex = Math.max(0, Math.trunc(Number(action.payload?.beatIndex || 0)) || 0);
    if (beatIndex < resolveChaseBeatDone(prefs, actionAnchorTs)) {
      return { blocked: { ok: true, skipped: 'beat-already-attempted', terminal: true } };
    }
    const claim = prefs?.[CHASE_GENERATION_CLAIM_FIELDS.chase_beat];
    if (
      Number(claim?.anchorTs || 0) === actionAnchorTs
    ) {
      return { blocked: { ok: true, skipped: 'beat-generation-claimed', terminal: true } };
    }
  }
  if (action.kind === 'cold_follow_up') {
    const followUpIndex = Math.max(0, Math.trunc(Number(action.payload?.followUpIndex || 0)) || 0);
    if (followUpIndex < resolveColdFollowUpDone(prefs, actionAnchorTs)) {
      return { blocked: { ok: true, skipped: 'follow-up-already-attempted', terminal: true } };
    }
    const claim = prefs?.[CHASE_GENERATION_CLAIM_FIELDS.cold_follow_up];
    if (
      Number(claim?.anchorTs || 0) === actionAnchorTs
    ) {
      return { blocked: { ok: true, skipped: 'follow-up-generation-claimed', terminal: true } };
    }
  }

  const messages = await listMessagesForChat(chat.id).catch(() => []);
  const lastVisible = lastVisibleMessage(messages);
  // 用户已经开口：这段沉默结束，票作废（常规接话流程接管）。
  if (!lastVisible || String(lastVisible.senderId || '') === 'user') {
    return { blocked: { ok: true, skipped: 'user-replied' } };
  }
  if (isAutomaticGenerationAnchorStopped(prefs, lastVisible)) {
    return { blocked: { ok: false, reason: 'user-stopped', terminal: true } };
  }
  // 登记之后又有过新的可见消息（前台追发、延时回复、日程问候都算）：
  // 那一轮的 persist 已经重排过新票，这张旧票直接作废。
  const payloadLastCharTs = Number(action.payload?.lastCharTs || 0) || 0;
  if (payloadLastCharTs && Number(lastVisible.timestamp || 0) > payloadLastCharTs + SUPERSEDED_EPSILON_MS) {
    return { blocked: { ok: true, skipped: 'superseded' } };
  }
  if (action.kind === 'chase_beat') {
    const threadEligibility = await resolveStoredChaseBeatThreadEligibility({
      userId: action.userId,
      chatId: chat.id,
      characterId: action.characterId,
      messages,
    });
    if (!threadEligibility.eligible) {
      // 没有线头时在请求前终结旧票；不消耗 API，也不自动重试成一次空追发。
      return { blocked: { ok: true, skipped: 'no-open-thread' } };
    }
  }
  // 用户正在输入框里打字：马上要开口了，稍等一会儿再看。
  const composer = getChatComposerState(chat.id);
  if (composer.focused) return { blocked: { ok: false, reason: 'compose-active' } };

  try {
    const { loadResolvedCharacterAutonomyPolicy, isAutonomyMuteHourActive } = await import('../character-autonomy-settings.js');
    const policy = await loadResolvedCharacterAutonomyPolicy(action.userId, action.characterId, chat.id);
    if (policy?.realPersonMode?.enabled !== true) return { blocked: { ok: true, skipped: 'real-person-disabled' } };
    if (policy?.totalEnabled !== true) {
      return { blocked: { ok: false, reason: 'proactive-disabled', terminal: true } };
    }
    const [worldNow, timeZone] = await Promise.all([
      getNowForUser(action.userId),
      resolveCharacterScheduleTimezone(action.userId, action.characterId, character).catch(() => ''),
    ]);
    if (isAutonomyMuteHourActive({ muteHours: policy?.muteHours }, worldNow, timeZone)) {
      return { blocked: { ok: false, reason: 'mute-hours' } };
    }
  } catch (_) { /* 策略读不到时保守放行 */ }
  try {
    const {
      isCharacterBusyInOfflineSession,
      resolveCharacterReplySchedulePacing,
    } = await import('../character-phone-proactive.js');
    if (await isCharacterBusyInOfflineSession(action.userId, action.characterId)) {
      return { blocked: { ok: false, reason: 'active-offline-session' } };
    }
    const schedulePacing = await resolveCharacterReplySchedulePacing(
      action.userId,
      action.characterId,
      await getNowForUser(action.userId),
    );
    if (schedulePacing?.busy === true) {
      return { blocked: { ok: false, reason: 'schedule-busy' } };
    }
  } catch (_) { /* 线下态读不到时不阻塞 */ }
  // TA 自己排了延时回复：到点那轮会接上，不抢跑。
  try {
    const pending = await listPendingActions(action.userId);
    const pacingNow = await getPacingNowForUser(action.userId);
    const hasOwnPlan = pending.some((row) => (
      row.kind === 'delayed_reply'
      && row.chatId === chat.id
      && Number(row.expiresAt || 0) > pacingNow
    ));
    if (hasOwnPlan) return { blocked: { ok: true, skipped: 'delayed-reply-owns' } };
  } catch (_) { /* 待办读不到时照常执行 */ }

  const { consumeCharacterApiBudget } = await import('../character-api-budget.js');
  const budget = await consumeCharacterApiBudget({
    userId: action.userId,
    characterId: action.characterId,
    chatId: chat.id,
    category: 'background_reply',
  });
  if (!budget?.ok) {
    return {
      blocked: {
        ok: false,
        reason: budget?.reason || 'budget-unavailable',
        terminal: budget?.reason === 'real-person-disabled',
      },
    };
  }
  return { chat, character, prefs, lastVisible };
}

function resolveBeatDoneForKind(kind, prefs, anchorTs) {
  return kind === 'cold_follow_up'
    ? resolveColdFollowUpDone(prefs, anchorTs)
    : resolveChaseBeatDone(prefs, anchorTs);
}

/**
 * 在真正派发模型请求前抢占「同一段沉默的同一拍」。Web Lock 是快速门禁，
 * 这个落库 claim 才是不支持 navigator.locks 或多 realm 缓存失效时的最后防线。
 * claim 不会自动过期：页面在 dispatch 边界崩溃时无法证明请求未提交，宁可放弃
 * 这一拍，也不自动二次计费。只有调用方明确拿到 request_not_started 才能释放。
 */
export async function claimRealPersonBeatGeneration({
  chatId,
  kind = 'chase_beat',
  anchorTs = 0,
  index = 0,
  actionId = '',
  now = Date.now(),
} = {}) {
  const field = CHASE_GENERATION_CLAIM_FIELDS[kind];
  const normalizedChatId = clean(chatId);
  const normalizedAnchorTs = Number(anchorTs || 0) || 0;
  const normalizedIndex = Math.max(0, Math.trunc(Number(index || 0)) || 0);
  const normalizedActionId = clean(actionId) || `${kind}:${normalizedChatId}:${normalizedAnchorTs}:${normalizedIndex}`;
  if (!field || !normalizedChatId || !normalizedAnchorTs) {
    return { acquired: false, reason: 'invalid-generation-claim' };
  }
  let reason = 'generation-claimed';
  const result = await updateChatPrefsAtomic(normalizedChatId, (current) => {
    const done = resolveBeatDoneForKind(kind, current, normalizedAnchorTs);
    if (normalizedIndex < done) {
      reason = 'beat-already-attempted';
      return undefined;
    }
    const existing = current?.[field];
    // 同一段沉默只允许一个未决生成。前一拍 commit / 明确 request_not_started
    // release 后字段会被删除；在此之前更高拍也不能覆盖 claim 并并行付费。
    if (Number(existing?.anchorTs || 0) === normalizedAnchorTs) {
      reason = 'generation-claimed';
      return undefined;
    }
    reason = 'claimed';
    return {
      ...current,
      [field]: {
        anchorTs: normalizedAnchorTs,
        index: normalizedIndex,
        actionId: normalizedActionId,
        claimedAt: Number(now) || Date.now(),
      },
    };
  });
  return {
    acquired: result.updated === true,
    reason: result.updated === true ? 'claimed' : reason,
    claim: result.updated === true ? result.value?.[field] || null : null,
  };
}

export async function releaseRealPersonBeatGenerationClaim({
  chatId,
  kind = 'chase_beat',
  anchorTs = 0,
  index = 0,
  actionId = '',
} = {}) {
  const field = CHASE_GENERATION_CLAIM_FIELDS[kind];
  const normalizedChatId = clean(chatId);
  const normalizedAnchorTs = Number(anchorTs || 0) || 0;
  const normalizedIndex = Math.max(0, Math.trunc(Number(index || 0)) || 0);
  const normalizedActionId = clean(actionId);
  if (!field || !normalizedChatId || !normalizedAnchorTs || !normalizedActionId) return false;
  const result = await updateChatPrefsAtomic(normalizedChatId, (current) => {
    const existing = current?.[field];
    if (
      Number(existing?.anchorTs || 0) !== normalizedAnchorTs
      || Math.max(0, Math.trunc(Number(existing?.index || 0)) || 0) !== normalizedIndex
      || clean(existing?.actionId) !== normalizedActionId
    ) return undefined;
    const next = { ...current };
    delete next[field];
    return next;
  });
  return result.updated === true;
}

export async function commitRealPersonBeatGenerationAttempt({
  chatId,
  kind = 'chase_beat',
  anchorTs = 0,
  index = 0,
  actionId = '',
  now = Date.now(),
} = {}) {
  const field = CHASE_GENERATION_CLAIM_FIELDS[kind];
  const stateField = kind === 'cold_follow_up' ? 'coldFollowUpState' : 'chaseBeatState';
  const normalizedChatId = clean(chatId);
  const normalizedAnchorTs = Number(anchorTs || 0) || 0;
  const normalizedIndex = Math.max(0, Math.trunc(Number(index || 0)) || 0);
  const normalizedActionId = clean(actionId);
  if (!field || !normalizedChatId || !normalizedAnchorTs) {
    return { committed: false, reason: 'invalid-generation-claim', done: -1 };
  }
  const result = await updateChatPrefsAtomic(normalizedChatId, (current) => {
    const done = Math.max(
      resolveBeatDoneForKind(kind, current, normalizedAnchorTs),
      normalizedIndex + 1,
    );
    const next = {
      ...current,
      [stateField]: {
        anchorTs: normalizedAnchorTs,
        done,
        updatedAt: Number(now) || Date.now(),
      },
    };
    const claim = current?.[field];
    if (
      Number(claim?.anchorTs || 0) === normalizedAnchorTs
      && Math.max(0, Math.trunc(Number(claim?.index || 0)) || 0) === normalizedIndex
      && (!normalizedActionId || clean(claim?.actionId) === normalizedActionId)
    ) delete next[field];
    return next;
  });
  return {
    committed: result.updated === true,
    reason: result.updated === true ? 'committed' : 'commit-failed',
    done: resolveBeatDoneForKind(kind, result.value, normalizedAnchorTs),
    prefs: result.value,
  };
}

async function commitChaseAttempt(chatId, anchorTs, beatIndex, actionId = '') {
  const result = await commitRealPersonBeatGenerationAttempt({
    chatId,
    kind: 'chase_beat',
    anchorTs,
    index: beatIndex,
    actionId,
  });
  return result.committed ? result.done : -1;
}

async function commitColdFollowUpAttempt(chatId, anchorTs, followUpIndex, actionId = '') {
  const result = await commitRealPersonBeatGenerationAttempt({
    chatId,
    kind: 'cold_follow_up',
    anchorTs,
    index: followUpIndex,
    actionId,
  });
  return result.committed ? result.done : -1;
}

function scheduleNextChaseAfterCommittedAttempt({ action, chat, now }) {
  Promise.resolve().then(async () => {
    const [freshPrefs, latestMessages] = await Promise.all([
      loadChatPrefsFresh(chat.id).catch(() => ({})),
      listMessagesForChat(chat.id).catch(() => []),
    ]);
    return maybeScheduleChaseBeatAfterRound({
      chat,
      userId: action.userId,
      prefs: freshPrefs,
      priorMessages: latestMessages,
      savedMessages: [],
      reason: 'real-person-chase-beat',
      realPersonChase: true,
      chaseBeatAlreadyCredited: true,
      now,
    });
  }).catch((error) => {
    console.warn('[real-person-chase] next beat schedule failed', error);
  });
}

/** pending-actions 执行器入口：到点先做全套现实校验，再让这一拍真的发生。 */
async function executeChaseBeatActionClaimed(action, context = {}) {
  const prepared = await prepareWaitingTicket(action);
  if (prepared.blocked) return prepared.blocked;
  const { chat, character, prefs, lastVisible } = prepared;
  const { getCharacterProactiveUsageStatus, recordProactiveOutcome } = await import('../character-proactive-usage.js');
  const proactiveUsage = await getCharacterProactiveUsageStatus(action.userId, action.characterId).catch(() => null);
  if (proactiveUsage && proactiveUsage.remaining <= 0) {
    await recordProactiveOutcome({
      userId: action.userId,
      characterId: action.characterId,
      chatId: chat.id,
      channel: 'chase-beat',
      status: 'skipped',
      reason: 'daily-limit-reached',
    }).catch(() => {});
    return { ok: false, skipped: true, reason: 'daily-limit-reached' };
  }

  const beatIndex = Math.max(0, Math.trunc(Number(action.payload?.beatIndex || 0)) || 0);
  const anchorTs = Number(action.payload?.anchorTs || 0) || 0;
  const pacingNow = Number(context.now || 0) || await getPacingNowForUser(action.userId);
  const silenceMinutes = Math.max(1, Math.round((pacingNow - Number(action.createdAt || pacingNow)) / 60000));
  const userName = clean(getUserDisplayName(context.user), 24) || '对方';
  const runReply = typeof context.runHeadlessChatReply === 'function'
    ? context.runHeadlessChatReply
    : runHeadlessChatReply;
  const actionId = clean(action.id) || `chase:${chat.id}:${anchorTs}:${beatIndex}`;
  const generationClaim = await claimRealPersonBeatGeneration({
    chatId: chat.id,
    kind: 'chase_beat',
    anchorTs,
    index: beatIndex,
    actionId,
  }).catch(() => ({ acquired: false, reason: 'generation-claim-unavailable' }));
  if (!generationClaim.acquired) {
    return {
      ok: true,
      skipped: generationClaim.reason || 'beat-generation-claimed',
      terminal: true,
      modelRequestAttempted: false,
    };
  }
  let result = null;
  try {
    result = await runReply(chat, context.user, {
      allowInactive: true,
      skipBusyAutoReply: true,
      apiBudgetConsumed: true,
      reason: 'real-person-chase-beat',
      proactiveChannel: 'chase-beat',
      proactiveIdempotencyKey: action.id,
      realPersonChase: true,
      skipChaseAutoSchedule: true,
      sceneDirective: buildChaseBeatDirective({
        beatIndex,
        userName,
        silenceMinutes,
        statusStoryMode: false,
      }),
    });
  } catch (error) {
    const modelRequestAttempted = error?.modelRequestAttempted === true;
    if (modelRequestAttempted) {
      await commitChaseAttempt(chat.id, anchorTs, beatIndex, actionId).catch(() => {});
    } else if (error?.requestNotStarted === true || error?.modelRequestAttempted === false) {
      await releaseRealPersonBeatGenerationClaim({
        chatId: chat.id,
        kind: 'chase_beat',
        anchorTs,
        index: beatIndex,
        actionId,
      }).catch(() => {});
    }
    const submittedUnknown = !modelRequestAttempted
      && error?.requestNotStarted !== true
      && error?.modelRequestAttempted !== false;
    return {
      ok: false,
      reason: clean(error?.message || error || 'headless-failed', 180),
      modelRequestAttempted,
      submittedUnknown,
      terminal: modelRequestAttempted || submittedUnknown,
    };
  }
  const modelRequestAttempted = result?.modelRequestAttempted === true;
  if (!result?.ok || !modelRequestAttempted) {
    if (modelRequestAttempted) {
      await commitChaseAttempt(chat.id, anchorTs, beatIndex, actionId).catch(() => {});
    } else if (result?.modelRequestAttempted === false) {
      await releaseRealPersonBeatGenerationClaim({
        chatId: chat.id,
        kind: 'chase_beat',
        anchorTs,
        index: beatIndex,
        actionId,
      }).catch(() => {});
    }
    const submittedUnknown = !modelRequestAttempted && result?.modelRequestAttempted !== false;
    return {
      ok: false,
      reason: result?.reason || (modelRequestAttempted ? 'headless-failed' : 'generation-not-attempted'),
      retryAt: Number(result?.retryAt || 0) || 0,
      modelRequestAttempted,
      submittedUnknown,
      terminal: modelRequestAttempted || submittedUnknown,
    };
  }
  // 一次模型尝试就是一拍；可见消息数量只决定通知与主动配额，不能让空回再次付费。
  const committedDone = await commitChaseAttempt(chat.id, anchorTs, beatIndex, actionId).catch(() => -1);
  await notifyBeatDelivery(chat, character, result, context.reason);
  if (committedDone < 0) {
    // 请求已付费，账本写失败也不能让 pending runner 自动重试；同时不排下一拍，
    // 避免在旧 done 上继续生成。
    return {
      ok: false,
      reason: 'attempt-ledger-write-failed',
      modelRequestAttempted: true,
      terminal: true,
      result,
    };
  }
  scheduleNextChaseAfterCommittedAttempt({ action, chat, now: pacingNow });
  return { ok: true, result, beatIndex, silent: !Number(result.messageCount || 0) };
}

export async function executeChaseBeatAction(action, context = {}) {
  const claim = await withRealPersonChaseGenerationLock({
    userId: action?.userId,
    chatId: action?.chatId,
    characterId: action?.characterId,
  }, () => executeChaseBeatActionClaimed(action, context));
  if (!claim.acquired) {
    return {
      ok: false,
      reason: 'chase-generation-busy',
      retryAt: Date.now() + 1500,
      modelRequestAttempted: false,
    };
  }
  return claim.value;
}

/** pending-actions 执行器入口：冷场破冰到点，校验通过后让 TA 重新开口。 */
async function executeColdFollowUpActionClaimed(action, context = {}) {
  const prepared = await prepareWaitingTicket(action);
  if (prepared.blocked) return prepared.blocked;
  const { chat, character, prefs, lastVisible } = prepared;
  const { getCharacterProactiveUsageStatus, recordProactiveOutcome } = await import('../character-proactive-usage.js');
  const proactiveUsage = await getCharacterProactiveUsageStatus(action.userId, action.characterId).catch(() => null);
  if (proactiveUsage && proactiveUsage.remaining <= 0) {
    await recordProactiveOutcome({
      userId: action.userId,
      characterId: action.characterId,
      chatId: chat.id,
      channel: 'cold-follow-up',
      status: 'skipped',
      reason: 'daily-limit-reached',
    }).catch(() => {});
    return { ok: false, skipped: true, reason: 'daily-limit-reached' };
  }

  const followUpIndex = Math.max(0, Math.trunc(Number(action.payload?.followUpIndex || 0)) || 0);
  const anchorTs = Number(action.payload?.anchorTs || 0) || 0;
  const pacingNow = Number(context.now || 0) || await getPacingNowForUser(action.userId);
  const silenceHours = Math.max(1, Math.round((pacingNow - Number(action.createdAt || pacingNow)) / 3600000));
  const userName = clean(getUserDisplayName(context.user), 24) || '对方';
  const runReply = typeof context.runHeadlessChatReply === 'function'
    ? context.runHeadlessChatReply
    : runHeadlessChatReply;
  const actionId = clean(action.id) || `cold:${chat.id}:${anchorTs}:${followUpIndex}`;
  const generationClaim = await claimRealPersonBeatGeneration({
    chatId: chat.id,
    kind: 'cold_follow_up',
    anchorTs,
    index: followUpIndex,
    actionId,
  }).catch(() => ({ acquired: false, reason: 'generation-claim-unavailable' }));
  if (!generationClaim.acquired) {
    return {
      ok: true,
      skipped: generationClaim.reason || 'follow-up-generation-claimed',
      terminal: true,
      modelRequestAttempted: false,
    };
  }
  let result = null;
  try {
    result = await runReply(chat, context.user, {
      allowInactive: true,
      skipBusyAutoReply: true,
      apiBudgetConsumed: true,
      reason: 'real-person-cold-follow-up',
      proactiveChannel: 'cold-follow-up',
      proactiveIdempotencyKey: action.id,
      skipChaseAutoSchedule: true,
      sceneDirective: buildColdFollowUpDirective({
        followUpIndex,
        userName,
        silenceHours,
        statusStoryMode: false,
      }),
    });
  } catch (error) {
    const modelRequestAttempted = error?.modelRequestAttempted === true;
    if (modelRequestAttempted) {
      await commitColdFollowUpAttempt(chat.id, anchorTs, followUpIndex, actionId).catch(() => {});
    } else if (error?.requestNotStarted === true || error?.modelRequestAttempted === false) {
      await releaseRealPersonBeatGenerationClaim({
        chatId: chat.id,
        kind: 'cold_follow_up',
        anchorTs,
        index: followUpIndex,
        actionId,
      }).catch(() => {});
    }
    const submittedUnknown = !modelRequestAttempted
      && error?.requestNotStarted !== true
      && error?.modelRequestAttempted !== false;
    return {
      ok: false,
      reason: clean(error?.message || error || 'headless-failed', 180),
      modelRequestAttempted,
      submittedUnknown,
      terminal: modelRequestAttempted || submittedUnknown,
    };
  }
  const modelRequestAttempted = result?.modelRequestAttempted === true;
  if (!result?.ok || !modelRequestAttempted) {
    if (modelRequestAttempted) {
      await commitColdFollowUpAttempt(chat.id, anchorTs, followUpIndex, actionId).catch(() => {});
    } else if (result?.modelRequestAttempted === false) {
      await releaseRealPersonBeatGenerationClaim({
        chatId: chat.id,
        kind: 'cold_follow_up',
        anchorTs,
        index: followUpIndex,
        actionId,
      }).catch(() => {});
    }
    const submittedUnknown = !modelRequestAttempted && result?.modelRequestAttempted !== false;
    return {
      ok: false,
      reason: result?.reason || (modelRequestAttempted ? 'headless-failed' : 'generation-not-attempted'),
      retryAt: Number(result?.retryAt || 0) || 0,
      modelRequestAttempted,
      submittedUnknown,
      terminal: modelRequestAttempted || submittedUnknown,
    };
  }
  const committedDone = await commitColdFollowUpAttempt(
    chat.id,
    anchorTs,
    followUpIndex,
    actionId,
  ).catch(() => -1);
  await notifyBeatDelivery(chat, character, result, context.reason);
  if (committedDone < 0) {
    return {
      ok: false,
      reason: 'attempt-ledger-write-failed',
      modelRequestAttempted: true,
      terminal: true,
      result,
    };
  }
  return { ok: true, result, followUpIndex, silent: !Number(result.messageCount || 0) };
}

export async function executeColdFollowUpAction(action, context = {}) {
  const claim = await withRealPersonChaseGenerationLock({
    userId: action?.userId,
    chatId: action?.chatId,
    characterId: action?.characterId,
  }, () => executeColdFollowUpActionClaimed(action, context));
  if (!claim.acquired) {
    return {
      ok: false,
      reason: 'cold-follow-up-generation-busy',
      retryAt: Date.now() + 1500,
      modelRequestAttempted: false,
    };
  }
  return claim.value;
}
