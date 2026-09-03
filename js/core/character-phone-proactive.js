import { createMessage } from '../models/chat.js';
import { getCharacterAiContextName } from '../models/character.js';
import { getCharacter } from './character-store.js';
import { ensureDefaultUser, getUserById } from './user-slot.js';
import { get as dbGet, put as dbPut } from './db.js';
import {
  ensurePrivateChat,
  listChatsForUser,
  listMessagesForChat,
  saveMessage,
  updateChatPreview,
  previewFromMessage,
  bumpChatUnread,
  clampLiveMessageTimestamp,
} from './chat-store.js';
import {
  computeCharacterSelfAbsenceGapMs,
  buildSelfAbsenceDirective,
  buildProactiveAntiRepeatDirective,
  getReplyContentPreview,
} from './chat-helpers.js';
import { getNowForUser, getPacingNowForUser } from './time-mode.js';
import {
  dateKeyFromTimestamp,
  getDailyLifePlanForDate,
  getScheduleProactiveSettings,
  isDailyLifeAutoEnabled,
  loadCharacterPhoneAutoSettings,
  listCharacterPhonesForUser,
  loadCharacterPhone,
  markTriggerWindowUsed,
  minutesOfDayFromTimestamp,
  pickCurrentFlowStep,
  pickCurrentTriggerWindow,
  pruneExpiredDailyLifePlans,
  saveCharacterPhone,
  formatRouteModeLabel,
  resolveActiveDailyLifePlanBlock,
} from './character-phone-store.js';
import { ensureDailyLifePlan } from './character-daily-life.js';
import { resolveCharacterScheduleTimezone } from './chat/chat-timezone.js';
import {
  loadCharacterRuntimeState,
  resolveEffectiveCharacterState,
} from './character-effective-state.js';
import {
  hasAuthoritativeCharacterPresence,
  loadCharacterLiveState,
} from './character-live-state.js';
import { shouldSuppressAiDelivery } from './chat-block-state.js';
import {
  buildProactiveConversationDirective,
  planProactiveConversation,
} from './proactive-conversation-plan.js';
import { loadOfflineSession } from './offline-session-store.js';
import {
  acquireCharacterAutonomyGuard,
  isAutonomyMuteHourActive,
  loadResolvedCharacterAutonomyPolicy,
  releaseCharacterAutonomyGuard,
} from './character-autonomy-settings.js';
import {
  countTrailingRealUserMessages,
  getUnansweredRealUserMessage,
  isManualPresenceReplyBlocked,
  isCharacterConversationMessage,
  isRealPersonReplyVisiblyBusy,
  isRealUserMessage,
  REAL_PERSON_DELAY_BREAKTHROUGH_BURST,
} from './chat/marshmallow-presence.js';

// 日程触发点常精确到分钟；10 分钟一轮容易错过「刚到点」的体感，改成 2 分钟扫一次。
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const BUSY_REPLY_GAP_MS = 3 * 60 * 1000;
/** 连发条数 + 时间加权达标才震回真回（约 6 连发，或 4 连发 + 8 分钟）。 */
export const BUSY_BREAKTHROUGH_SCORE = 6;
const BUSY_BREAKTHROUGH_TIME_BUCKET_MINUTES = 4;
/** 戳醒后抽空窗口：默认约 18 分钟，再回到自动回复循环。 */
export const BUSY_SPARSE_WINDOW_MS = 18 * 60 * 1000;
const PROACTIVE_LOCK_TTL_MS = 2 * 60 * 1000;
const RECENT_PROACTIVE_GUARD_MS = 2 * 60 * 1000;
const RECENT_TOPIC_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const GENERIC_TOPIC_WORDS = new Set([
  '一个', '一些', '一下', '事情', '东西', '今天', '刚刚', '刚才', '现在', '正在',
  '已经', '然后', '时候', '这里', '那里', '这个', '那个', '可以', '还是', '就是',
  '有点', '自己', '看到', '做完', '突然', '想起', '分享', '聊聊', '顺手', '准备',
  'about', 'after', 'before', 'just', 'share', 'something', 'today',
]);
const HAN_TOPIC_EDGE_PARTICLES = new Set('的一了是在和与把被就也都又很还着过到从为'.split(''));

let _running = false;
// 每轮对所有角色手机逐个评估（闸门都在单角色内部：开关、slot、冷却、锁），
// 不做全局轮转、也不截断名单；只限制单轮真正走到生成的次数，防止同一时刻多角色齐发烧 API。
const MAX_GENERATIONS_PER_TICK = 3;
const MAX_GENERATIONS_PER_CATCH_UP = 1;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function slotKeyFromTimestamp(ts = Date.now(), dailyCount = 1, timeZone = '') {
  const count = Math.max(1, Math.floor(Number(dailyCount) || 1));
  const minutes = minutesOfDayFromTimestamp(ts, timeZone);
  const slot = Math.min(count - 1, Math.floor(minutes / (1440 / count)));
  return `${dateKeyFromTimestamp(ts, timeZone)}|slot${slot + 1}`;
}

function proactiveGapMs(settings = {}) {
  return Math.max(0, Math.min(240, Math.floor(Number(settings.minGapMinutes ?? 20) || 0))) * 60 * 1000;
}

function appendRunHistory(settings = {}, entry = {}) {
  return [
    {
      at: Number(entry.at || Date.now()) || Date.now(),
      dateKey: clean(entry.dateKey || '', 20),
      slotKey: clean(entry.slotKey || '', 80),
      blockId: clean(entry.blockId || '', 80),
      triggerId: clean(entry.triggerId || '', 80),
      status: entry.status === 'ok' ? 'ok' : 'failed',
      reason: clean(entry.reason || '', 120),
      messageCount: Math.max(0, Math.min(20, Number(entry.messageCount || 0) || 0)),
      // 与“是否真的发出消息”分开记录。模型请求一旦发出，即使最后只有
      // state/status 或空结果，同一 slot 也不能在后续 tick 再次计费重试。
      generationAttempted: entry.generationAttempted === true,
    },
    ...asArray(settings.runHistory),
  ].slice(0, 80);
}

export function scheduleProactiveVisibleMessages(result = {}) {
  return asArray(result?.messages).filter((message) => isCharacterConversationMessage(message));
}

export function scheduleProactiveLifeGlimpseCards(result = {}) {
  return asArray(result?.cards).filter((card) => (
    card?.metadata?.storyKind === 'life_glimpse'
    && card?.metadata?.consumesProactiveSlot === true
    && card?.metadata?.proactiveChannel === 'schedule'
  ));
}

export function shouldUseScheduleProactiveLifeGlimpse({
  motivePlan = null,
  lifeGlimpseSettings = null,
  autonomyPolicy = null,
} = {}) {
  return motivePlan?.motive === 'life-fragment'
    && lifeGlimpseSettings?.enabled === true
    && lifeGlimpseSettings?.aiStoryCardsEnabled === true
    && autonomyPolicy?.realPersonMode?.enabled === true;
}

export function classifyScheduleProactiveGenerationResult(result = {}) {
  const visibleMessages = scheduleProactiveVisibleMessages(result);
  const lifeGlimpseCards = scheduleProactiveLifeGlimpseCards(result);
  const messageCount = visibleMessages.length;
  const cardCount = lifeGlimpseCards.length;
  const bridgedOfflineReturn = result?.offlineReturnBridge === true;
  const sent = result?.ok === true && !bridgedOfflineReturn && (messageCount > 0 || cardCount > 0);
  const reason = sent
    ? (cardCount > 0 && messageCount === 0 ? 'life-glimpse' : 'sent')
    : (bridgedOfflineReturn
      ? 'deferred-after-offline-return'
      : (result?.ok === true ? 'empty-visible' : clean(result?.reason || 'failed', 80)));
  return {
    sent,
    bridgedOfflineReturn,
    visibleMessages,
    lifeGlimpseCards,
    messageCount,
    cardCount,
    reason,
    generationAttempted: result?.modelRequestAttempted === true,
    resultStatus: sent
      ? 'ok'
      : (bridgedOfflineReturn
        ? 'skipped'
        : (result?.ok === true ? 'failed' : (result?.skipped === true ? 'skipped' : 'failed'))),
  };
}

export function hasScheduleProactiveGenerationAttempt(settings = {}, dateKey = '', slotKey = '') {
  const day = String(dateKey || '').trim();
  const slot = String(slotKey || '').trim();
  if (!day || !slot) return false;
  return asArray(settings?.runHistory).some((entry) => (
    entry?.generationAttempted === true
    && String(entry.dateKey || '') === day
    && String(entry.slotKey || '') === slot
  ));
}

export function applyScheduleProactiveGenerationOutcome({
  phone,
  settings = {},
  result = {},
  triggeredKeys = [],
  dateKey = '',
  slotKey = '',
  block = null,
  trigger = null,
  now = Date.now(),
  pacingNow = now,
} = {}) {
  const outcome = classifyScheduleProactiveGenerationResult(result);
  const nextTriggeredKeys = [...new Set(asArray(triggeredKeys).map((key) => String(key || '').trim()).filter(Boolean))];
  let nextPhone = phone;
  if (outcome.sent) {
    if (!nextTriggeredKeys.includes(slotKey)) nextTriggeredKeys.push(slotKey);
    if (trigger?.id && block?.id) {
      nextPhone = markTriggerWindowUsed(nextPhone, {
        dateKey,
        blockId: block.id,
        triggerId: trigger.id,
        usedAt: now,
      });
    }
  }
  const nextSettings = {
    ...settings,
    lastRunDate: dateKey,
    triggeredKeys: nextTriggeredKeys,
    // 只有真实可见角色消息才推进可见主动冷却；空结果不是一次“已发送”。
    lastTriggeredAt: outcome.sent
      ? pacingNow
      : Number(settings.lastTriggeredAt || 0),
    lastStatus: outcome.sent
      ? 'ok'
      : (outcome.bridgedOfflineReturn ? 'offline-return-bridge' : outcome.reason),
    runningSlotKey: '',
    runningAt: 0,
    runHistory: appendRunHistory(settings, {
      at: now,
      dateKey,
      slotKey,
      blockId: block?.id || '',
      triggerId: trigger?.id || '',
      status: outcome.sent ? 'ok' : outcome.resultStatus,
      reason: outcome.reason,
      messageCount: outcome.messageCount,
      generationAttempted: outcome.generationAttempted,
    }),
  };
  return { ...outcome, phone: nextPhone, settings: nextSettings };
}

export async function saveScheduleProactiveRuntimeState(phone, settings = {}) {
  const normalizedSettings = getScheduleProactiveSettings({ scheduleProactiveSettings: settings });
  const saved = await saveCharacterPhone({
    ...phone,
    scheduleProactiveSettings: normalizedSettings,
  });
  try {
    const { saveCharacterPhoneAutomationRuntime } = await import('./character-phone-automation-store.js');
    await saveCharacterPhoneAutomationRuntime(saved.userId, saved.characterId, {
      scheduleProactive: {
        lastRunDate: normalizedSettings.lastRunDate,
        triggeredKeys: normalizedSettings.triggeredKeys,
        lastTriggeredAt: normalizedSettings.lastTriggeredAt,
        lastStatus: normalizedSettings.lastStatus,
        runningSlotKey: normalizedSettings.runningSlotKey,
        runningAt: normalizedSettings.runningAt,
        runHistory: normalizedSettings.runHistory,
      },
    });
  } catch (_) { /* legacy phone store remains authoritative if the mirror is unavailable */ }
  return saved;
}

async function loadScheduleProactiveRuntimeMirror(userId, characterId) {
  try {
    const { loadCharacterPhoneAutomationRuntime } = await import('./character-phone-automation-store.js');
    const runtime = await loadCharacterPhoneAutomationRuntime(userId, characterId);
    return runtime?.scheduleProactive || null;
  } catch (_) {
    return null;
  }
}

function proactiveLockKey(userId = '', characterId = '', slotKey = '') {
  return `characterPhoneProactiveLock_${encodeURIComponent(String(userId || '').trim())}_${encodeURIComponent(String(characterId || '').trim())}_${encodeURIComponent(String(slotKey || '').trim())}`;
}

async function acquireProactiveSlotLock({ userId = '', characterId = '', slotKey = '', now = Date.now() } = {}) {
  const key = proactiveLockKey(userId, characterId, slotKey);
  if (!userId || !characterId || !slotKey) return { ok: false, reason: 'missing-lock-key' };
  const prev = await dbGet(key).catch(() => null);
  const value = prev?.value && typeof prev.value === 'object' ? prev.value : null;
  if (value?.expiresAt && Number(value.expiresAt) > now) {
    return { ok: false, reason: 'slot-lock-active' };
  }
  const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await dbPut({
    key,
    value: {
      token,
      userId,
      characterId,
      slotKey,
      acquiredAt: now,
      expiresAt: now + PROACTIVE_LOCK_TTL_MS,
    },
  });
  return { ok: true, key, token };
}

async function completeProactiveSlotLock(lock, patch = {}) {
  if (!lock?.key) return;
  await dbPut({
    key: lock.key,
    value: {
      token: lock.token || '',
      completedAt: Date.now(),
      expiresAt: Date.now() + 10 * 1000,
      ...(patch || {}),
    },
  }).catch(() => {});
}

function slotKeyFromSchedule({
  ts = Date.now(), dailyCount = 1, block = null, step = null, trigger = null, timeZone = '',
} = {}) {
  const dateKey = dateKeyFromTimestamp(ts, timeZone);
  const blockId = clean(block?.id || '', 40);
  const triggerId = clean(trigger?.id || '', 40);
  const stepId = clean(step?.id || '', 40);
  if (blockId && triggerId) return `${dateKey}|${blockId}|trigger:${triggerId}`;
  if (blockId && stepId) return `${dateKey}|${blockId}|${stepId}`;
  if (blockId) return `${dateKey}|${blockId}`;
  return slotKeyFromTimestamp(ts, dailyCount, timeZone);
}

function blockSummary(block = {}, currentStep = null, currentTrigger = null) {
  if (!block) return null;
  return {
    timeRange: clean(block.timeRange || '', 32),
    anchor: clean(block.anchor || '', 60),
    placeName: clean(block.placeName || '', 80),
    city: clean(block.city || '', 40),
    activity: clean(block.activity || '', 120),
    mood: clean(block.mood || '', 40),
    busy: resolveScheduleBlockBusyState(block, currentStep),
    environment: asArray(block.environment).map((x) => clean(x, 48)).filter(Boolean).slice(0, 4),
    choices: asArray(block.choices).map((x) => clean(x, 48)).filter(Boolean).slice(0, 4),
    shareCandidates: asArray(block.shareCandidates).map((x) => clean(x, 100)).filter(Boolean).slice(0, 4),
    routeHint: block.routeHint && typeof block.routeHint === 'object'
      ? {
        origin: clean(block.routeHint.origin || '', 80),
        destination: clean(block.routeHint.destination || '', 80),
        mode: formatRouteModeLabel(block.routeHint.mode || ''),
        durationText: clean(block.routeHint.durationText || '', 40),
      }
      : null,
    currentStep: currentStep
      ? {
        at: clean(currentStep.at || '', 24),
        action: clean(currentStep.action || '', 120),
        placeName: clean(currentStep.placeName || '', 80),
        transit: clean(currentStep.transit || '', 60),
        busy: currentStep.busy === true,
        shareCandidate: clean(currentStep.shareCandidate || '', 120),
      }
      : null,
    currentTrigger: currentTrigger
      ? {
        at: clean(currentTrigger.at || '', 24),
        reason: clean(currentTrigger.reason || '', 100),
        shareHint: clean(currentTrigger.shareHint || '', 120),
      }
      : null,
  };
}

function meaningfulTopicWords(value = '') {
  const text = clean(value, 240).toLocaleLowerCase();
  if (!text) return [];
  const keep = (word = '') => {
    const normalized = String(word || '').replace(/[^\p{L}\p{N}]+/gu, '').trim();
    if (!normalized || GENERIC_TOPIC_WORDS.has(normalized)) return '';
    if (/^[\p{Script=Han}]+$/u.test(normalized)) return normalized.length >= 2 ? normalized : '';
    return normalized.length >= 3 ? normalized : '';
  };
  const hanGrams = [...text.matchAll(/[\p{Script=Han}]+/gu)]
    .flatMap(([part]) => {
      const grams = [];
      for (let i = 0; i < part.length - 1; i += 1) {
        const gram = part.slice(i, i + 2);
        if (GENERIC_TOPIC_WORDS.has(gram)) continue;
        if (HAN_TOPIC_EDGE_PARTICLES.has(gram[0]) || HAN_TOPIC_EDGE_PARTICLES.has(gram[1])) continue;
        grams.push(gram);
      }
      return grams;
    });
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    return [...new Set([
      ...[...segmenter.segment(text)]
      .filter((part) => part.isWordLike)
      .map((part) => keep(part.segment))
      .filter(Boolean),
      ...hanGrams,
    ])];
  }
  return [...new Set([
    ...text
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap((part) => {
      if (!/^[\p{Script=Han}]+$/u.test(part) || part.length <= 4) return [keep(part)];
      const grams = [];
      for (let size = 2; size <= Math.min(4, part.length); size += 1) {
        for (let i = 0; i <= part.length - size; i += 1) grams.push(keep(part.slice(i, i + size)));
      }
      return grams;
    })
    .filter(Boolean),
    ...hanGrams,
  ])];
}

function recentConversationText(messages = [], now = Date.now()) {
  return asArray(messages)
    .filter((message) => {
      if (!message || message.deleted || message.recalled) return false;
      if (String(message.senderId || '') === 'system' || message.type === 'system') return false;
      const timestamp = Number(message.timestamp || 0) || 0;
      return timestamp > 0 && timestamp <= now && now - timestamp <= RECENT_TOPIC_LOOKBACK_MS;
    })
    .map((message) => getReplyContentPreview(message).toLocaleLowerCase())
    .filter(Boolean)
    .join('\n');
}

export function isScheduleMaterialRecentlyDiscussed(material = '', messages = [], now = Date.now()) {
  const conversation = recentConversationText(messages, now);
  if (!conversation) return false;
  return meaningfulTopicWords(material).some((word) => conversation.includes(word));
}

function hasSuccessfulBlockRun(settings = {}, dateKey = '', blockId = '') {
  const id = String(blockId || '').trim();
  if (!id) return false;
  return asArray(settings.runHistory).some((entry) => (
    entry?.status === 'ok'
    && String(entry.dateKey || '') === String(dateKey || '')
    && String(entry.blockId || '') === id
  ));
}

export function buildScheduleDirective({
  character,
  plan,
  block,
  currentStep,
  currentTrigger,
  slotKey,
  settings,
  recentMessages = [],
  now = Date.now(),
  timeZone = '',
  motivePlan = null,
}) {
  const name = getCharacterAiContextName(character);
  const summary = blockSummary(block, currentStep, currentTrigger);
  const dateKey = dateKeyFromTimestamp(now, timeZone);
  const blockAlreadyUsed = hasSuccessfulBlockRun(settings, dateKey, block?.id);
  const sourceCandidates = [
    ...(summary?.currentTrigger?.shareHint ? [summary.currentTrigger.shareHint] : []),
    ...(summary?.currentStep?.shareCandidate ? [summary.currentStep.shareCandidate] : []),
    ...(blockAlreadyUsed ? [] : (summary?.shareCandidates || [])),
  ];
  const freshCandidates = [...new Set(sourceCandidates)]
    .filter((item) => !isScheduleMaterialRecentlyDiscussed(item, recentMessages, now))
    .slice(0, 4);
  const hiddenCandidateCount = sourceCandidates.length - freshCandidates.length;
  const visibleSummary = summary
    ? {
      ...summary,
      shareCandidates: blockAlreadyUsed
        ? []
        : asArray(summary.shareCandidates).filter((item) => freshCandidates.includes(item)),
      currentStep: summary.currentStep
        ? {
          ...summary.currentStep,
          shareCandidate: freshCandidates.includes(summary.currentStep.shareCandidate)
            ? summary.currentStep.shareCandidate
            : '',
        }
        : null,
      currentTrigger: summary.currentTrigger
        ? {
          ...summary.currentTrigger,
          shareHint: freshCandidates.includes(summary.currentTrigger.shareHint)
            ? summary.currentTrigger.shareHint
            : '',
        }
        : null,
    }
    : null;
  const shares = freshCandidates.length
    ? freshCandidates.map((item) => `- ${item}`).join('\n')
    : '- 当前没有未聊过的日程素材；不要从 activity、anchor、reason 等字段换皮复述旧话题。';
  const materialState = hiddenCandidateCount > 0 || blockAlreadyUsed
    ? '部分素材因最近已经聊过，或同一日程时段此前已主动分享过而被移除。'
    : '以下素材仅是可选参考，不是本轮必须完成的话题。';
  const resolvedMotive = motivePlan || planProactiveConversation({
    character,
    recentMessages,
    slotKey,
    hasScheduleMaterial: freshCandidates.length > 0,
    busy: summary?.busy === true,
    channel: 'schedule',
  });
  const lifeFragment = resolvedMotive.motive === 'life-fragment';
  const quietScene = visibleSummary
    ? {
      activity: visibleSummary.activity,
      mood: visibleSummary.mood,
      busy: visibleSummary.busy,
      currentStep: visibleSummary.currentStep
        ? {
          action: visibleSummary.currentStep.action,
          placeName: visibleSummary.currentStep.placeName,
          busy: visibleSummary.currentStep.busy,
        }
        : null,
    }
    : null;
  const scheduleMaterialBlock = lifeFragment
    ? [
      `当天主题：${clean(plan?.dayTheme || '') || '日常'}`,
      `当前时段（只作场景背景）：${visibleSummary ? JSON.stringify(visibleSummary, null, 2) : '无'}`,
      `素材状态：${materialState}`,
      `可分享素材：\n${shares}`,
    ].join('\n')
    : [
      `当前可用性背景：${quietScene ? JSON.stringify(quietScene) : '无'}`,
      '本轮动机不是日程分享：以上背景只决定此刻是否忙、口吻、媒介与回复时机，不能在这里预设少量消息；禁止默认把 activity、步骤、地点或当天主题拿来当聊天话题。',
    ].join('\n');
  return `[主动聊天机会]
触发原因：${name} 到达一次主动联系机会 ${slotKey}；这次机会沿用原主动配额，不因关系阶段减少次数。
完整的私聊上下文、世界内时间、消息时间差、记忆和角色状态已经由普通聊天上下文提供。
${scheduleMaterialBlock}

${buildProactiveConversationDirective(resolvedMotive)}

写法：
- 第一优先级是承接私聊上文：如果最近的话题还有自然延续空间，就顺着聊下去，不要为了迁就日程强行换题。
- 如果用户有明确没被回应的问题、求助或邀约，必须先接住；「用户很久没说话」本身不算未接事项，禁止用查岗式开场。
- 朋友圈和旧动态只能按真实时间理解，不把几天前的内容写成此刻正在发生。
- 只有 motive=life-fragment 时才可从可分享素材选一件；其它动机不得把日程字段换皮成话题。
- 被移除或最近聊过的内容不得改写重提；不要写成长旁白或系统播报。
- 当前 busy=true 时，忙碌只影响回复时机、媒介和语气；轻反应、语音或表情都可以成立，有话时也可以沿自然气口继续。分条交给【回复节奏 · 错落】；不调用工具或编造用户回复。`;
}

/**
 * 忙碌自动回复发出后，用户又连发了几条（中间没有 TA 的真实回复）。
 * - 返回 >=0：从最近一条「系统」phoneAutoReply 之后的用户条数（手打假装自动回复会跳过，不打断计数）
 * - 返回 -1：最近一条角色可见消息是真实回复（或尚无自动回复）——需要重新武装自动回复循环
 */
export function countUserPokesSinceBusyAutoReply(messages = [], characterId = '') {
  let pokes = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.deleted || m.recalled) continue;
    const senderId = String(m.senderId || '');
    if (senderId === 'system' || String(m.type || '') === 'system') continue;
    if (isRealUserMessage(m)) {
      pokes += 1;
      continue;
    }
    if (senderId === String(characterId)) {
      // 手打假装自动回复：继续往前数，不重置、不当真回。
      if (m.metadata?.busyFauxAutoReply) continue;
      if (m.metadata?.phoneAutoReply) return pokes;
    }
    if (isCharacterConversationMessage(m)) return -1;
  }
  return -1;
}

/** 从最近一次真实角色回复后累计用户气泡；手打假自动回复不清零累计。 */
export function countUserPokesSinceLastRealReply(messages = [], characterId = '') {
  let pokes = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.deleted || message.recalled) continue;
    if (isRealUserMessage(message)) {
      pokes += 1;
      continue;
    }
    const senderId = String(message.senderId || '');
    if (senderId === 'system' || String(message.type || '') === 'system') continue;
    if (senderId === String(characterId) && message.metadata?.busyFauxAutoReply) continue;
    if (isCharacterConversationMessage(message)) break;
  }
  return pokes;
}

/** 顶栏文案像忙碌/勿扰/开会等——即使仍显示「在线」也应进门禁。 */
export function isBusyLikeStatusText(statusText = '') {
  return /勿扰|别吵|免打扰|开会|会议|上课|工作中|忙碌|在忙|稍后|洗澡|睡觉|午休|休息|补觉|路上|通勤|赶路|飞行|静音/.test(
    String(statusText || '').trim(),
  );
}

export function isSleepLikeStatusText(statusText = '') {
  return /睡觉|睡了|睡着|睡死|晚安|午休|休息|补觉|梦里|不看手机/.test(
    String(statusText || '').trim(),
  );
}

/** 当前步骤比整段日程更精确；睡眠仍是不可被步骤 false 覆盖的硬状态。 */
export function resolveScheduleBlockBusyState(block = null, currentStep = null) {
  if (!block) return false;
  if (block.isSleep === true) return true;
  if (currentStep && typeof currentStep === 'object') return currentStep.busy === true;
  return block.busy === true;
}

export function resolveSoftBusyReplyGate({
  pokes = 0,
  sleeping = false,
} = {}) {
  const count = Math.max(0, Math.trunc(Number(pokes) || 0));
  if (count >= REAL_PERSON_DELAY_BREAKTHROUGH_BURST) return 'breakthrough';
  if (!sleeping && count >= 2 && count % 2 === 0) return 'faux';
  return 'silent';
}

/** 忙碌系统自动回复是明确 opt-in；未配置、加载失败或仅开真人感都不启用。 */
export function isBusySystemAutoReplyEnabled(policy = {}) {
  return policy?.realPersonMode?.enabled === true
    && policy?.realPersonMode?.systemAutoReplyEnabled === true;
}

/** 连发条数 + 距上次自动回复的分钟数加权。 */
export function computeBusyBreakthroughScore({
  pokes = 0,
  minutesSinceAutoReply = 0,
} = {}) {
  const pokeCount = Math.max(0, Math.trunc(Number(pokes) || 0));
  const minutes = Math.max(0, Number(minutesSinceAutoReply) || 0);
  return pokeCount + Math.floor(minutes / BUSY_BREAKTHROUGH_TIME_BUCKET_MINUTES);
}

function busyBreakThroughDirective(block = {}, activityHint = '') {
  const activity = clean(activityHint || block.activity || block.anchor || '手头的事', 40);
  return [
    `【被戳出来了】你本来在忙（${activity}），刚才只发了条自动回复，但对方连着敲了好几条，你还是抽空看了眼手机、先冒头回应。`,
    '按人设自然接话：说明在忙、无奈、被逗笑都行；忙碌影响回复时机、媒介和语气，轻轻冒头也可以成立，但不预设少量气泡。有话时沿自然气口继续，没空打字时可以改用语音。',
    '本轮必须自己决定后续节奏，三选一写进事件：',
    '1) 仍很忙：维持顶栏 status，并用 auto_reply 重新登记文案（可改口，且文案不要照抄顶栏状态），忙完再说；',
    '2) 抽空回：登记 next_reply_delay 约 15～20 分钟，有消息隔一阵再回，不要秒回；',
    '3) 收工：用 status 改回在线/清空忙碌文案，并用 auto_reply {"clear":true} 取消自动回复。',
    '不要提系统、自动回复机制或后台。',
  ].join('\n');
}

/** 系统挡刀循环里穿插：角色手打一条措辞不同的短假装自动回复。 */
function busyFauxAutoReplyDirective({
  registeredText = '',
  statusText = '',
  systemAutoReplyEnabled = true,
} = {}) {
  const registered = clean(registeredText, 80);
  const status = clean(statusText, 40);
  return [
    systemAutoReplyEnabled
      ? '【假装自动回复】你仍在忙，系统里也挂着自动回复挡刀。'
      : '【手打假自动回复】你仍在忙；系统自动回复没有开启，这一条必须是你本人抽空手打的。',
    systemAutoReplyEnabled && registered ? `系统登记的自动回复是「${registered}」——本轮不要复读同款。` : '',
    status ? `顶栏状态是「${status}」，自动回复正文必须和它不是同一句。` : '',
    '像真人忙时抽空回应：措辞要新鲜，带点人设脾气；可以只是一个完整的轻反应，有话也可以沿自然气口继续。媒介与分条按【回复节奏 · 错落】决定，不在这里限定一条或半句。',
    systemAutoReplyEnabled
      ? '忙碌状态仍应成立，不要工具；可顺手微调 auto_reply 文案，或维持原样。'
      : '忙碌状态仍应成立，不要工具，也不要登记 auto_reply；保持当前忙碌/离线状态。',
    '不要向用户解释这是假装或系统机制。',
  ].filter(Boolean).join('\n');
}

function softBusyBreakThroughDirective({
  statusText = '',
  sleeping = false,
  systemAutoReplyEnabled = false,
} = {}) {
  const status = clean(statusText, 40) || (sleeping ? '已经休息/离线' : '正在忙');
  return [
    `【连续消息把你叫出来了】你原本${status}，前几条都没有回复；对方连续发了多条后，你才${sleeping ? '短暂醒来/拿到手机' : '抽空看了一眼'}。`,
    '按人设回应真正重要的内容，忙碌影响语气、媒介和回复时机，不在这里预设“短、慢”或一两个点。文字、语音、表情如何组合以及消息数量，统一服从【回复节奏 · 错落】。',
    '若仍要离开，保持离线/忙碌状态并登记 next_reply_delay；若确实恢复在线，再主动清掉或更新 status。',
    systemAutoReplyEnabled
      ? '需要后续由系统挡刀时可登记 auto_reply，文案不要照抄顶栏状态。'
      : '系统自动回复没有开启：不要登记 auto_reply；若想呈现自动回复感，只能由你本人按真实表达欲手打不同措辞的消息。',
    '不要提系统、门禁、累计气泡或后台。',
  ].join('\n');
}

/** 是否在本轮用「手打假装自动回复」替代系统弹窗 / 静默。 */
export function shouldMixFauxBusyAutoReply({
  pokes = 0,
  rearmCycle = false,
  hasEmittedAutoReply = false,
} = {}) {
  if (rearmCycle || !hasEmittedAutoReply) return false;
  const n = Math.max(0, Math.trunc(Number(pokes) || 0));
  // 第 2、4… 次连戳穿插手打；第 1、3… 次仍走系统弹窗或冷却静默。
  return n >= 2 && n % 2 === 0;
}

function countTrailingUserPokes(messages = []) {
  return countTrailingRealUserMessages(messages);
}

function isPrivateUserChat(chat) {
  return chat?.type !== 'group'
    && asArray(chat?.participants).includes('user')
    && asArray(chat?.participants).some((id) => id && id !== 'user');
}

function privatePartnerId(chat) {
  return asArray(chat?.participants).find((id) => id && id !== 'user') || '';
}

function getLiveBlockAutoReply(block, now) {
  const autoReply = block?.autoReply && typeof block.autoReply === 'object'
    ? block.autoReply
    : null;
  if (!autoReply?.text) return null;
  const expireAt = Number(autoReply.expireAt || 0) || 0;
  if (expireAt && now > expireAt) return null;
  return autoReply;
}

function getLiveSessionAutoReply(phone, now) {
  const autoReply = phone?.sessionAutoReply && typeof phone.sessionAutoReply === 'object'
    ? phone.sessionAutoReply
    : null;
  if (!autoReply?.text) return null;
  const expireAt = Number(autoReply.expireAt || 0) || 0;
  if (expireAt && now > expireAt) return null;
  return autoReply;
}

/** 给真人感接话提供轻量日程门槛；读不到日程时按普通节奏，不阻断回复。 */
export async function resolveCharacterReplySchedulePacing(userId = '', characterId = '', now = Date.now(), options = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return { busy: false, activity: '' };
  try {
    const [phone, timeZone, runtimeState, liveState] = await Promise.all([
      loadCharacterPhone(uid, cid),
      resolveCharacterScheduleTimezone(uid, cid).catch(() => ''),
      loadCharacterRuntimeState(uid, cid, { now }).catch(() => null),
      loadCharacterLiveState(uid, cid, { now, presenceNow: Date.now() }).catch(() => null),
    ]);
    const { block } = resolveActiveDailyLifePlanBlock(phone, now, timeZone);
    const currentStep = block ? pickCurrentFlowStep(block, now, timeZone) : null;
    const effective = resolveEffectiveCharacterState({
      runtimeState,
      sceneFact: liveState?.sceneFact || null,
      scheduleBlock: block,
      allowSceneScheduleOverride: liveState?.policy?.sceneScheduleOverrideAllowed !== false,
      now,
    });
    const activeConversation = isActiveConversationScene(effective, options.chatId);
    return {
      busy: activeConversation
        ? false
        : (effective.scheduleOverridden
        ? isBusyLikeStatusText(effective.activity)
        : resolveScheduleBlockBusyState(block, currentStep)),
      activity: clean(
        effective.scheduleOverridden
          ? effective.activity
          : (currentStep?.action || effective.activity || block?.anchor || ''),
        80,
      ),
      stepId: String(currentStep?.id || ''),
      activeConversation,
      source: effective.source,
      sourceChatId: effective.sourceChatId || '',
    };
  } catch (_) {
    return { busy: false, activity: '' };
  }
}

export function scheduleProactiveRealityBlockReason({
  block = null,
  liveState = null,
  effectiveState = null,
} = {}) {
  const hasPresence = hasAuthoritativeCharacterPresence(liveState?.presence);
  if (hasPresence && String(liveState?.presence?.state || 'online') === 'offline') return 'soft-offline';
  if (effectiveState?.source === 'scene') return 'recent-chat-scene';
  if (effectiveState?.scheduleOverridden) return 'runtime-state-overrides-schedule';
  if (block?.isSleep === true) return 'schedule-sleep';
  return '';
}

export function isActiveConversationScene(effectiveState = null, chatId = '') {
  const id = String(chatId || '').trim();
  return !!(
    id
    && effectiveState?.source === 'scene'
    && effectiveState?.availability !== 'offline'
    && String(effectiveState?.sourceChatId || '').trim() === id
  );
}

/**
 * 主动开口的统一现实门禁。与“用户发消息后是否能把 TA 叫醒”分开：
 * 这里只用于追发、闲置续聊、冷场破冰等没有新用户消息的任务。
 */
export async function resolveCharacterAutonomousMessageBlock(
  userId = '',
  characterId = '',
  chatId = '',
  now = Date.now(),
) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const threadId = String(chatId || '').trim();
  if (!uid || !cid) return { blocked: false, reason: '' };

  if (threadId) {
    try {
      const liveState = await loadCharacterLiveState(uid, cid, {
        now,
        presenceNow: Date.now(),
      });
      const presence = hasAuthoritativeCharacterPresence(liveState?.presence)
        ? String(liveState.presence.state || 'online')
        : 'online';
      if (presence !== 'online') {
        return { blocked: true, reason: 'soft-offline', presence, liveState };
      }
    } catch (_) { /* 在线态读不到时继续核验日程与线下会话 */ }
  }

  const schedule = await resolveCharacterReplySchedulePacing(uid, cid, now).catch(() => null);
  if (schedule?.busy === true) {
    return { blocked: true, reason: 'schedule-busy', schedule };
  }
  if (await isCharacterBusyInOfflineSession(uid, cid).catch(() => false)) {
    return { blocked: true, reason: 'active-offline-session' };
  }
  return { blocked: false, reason: '' };
}

/** 日程主动是否应让路给忙碌自动回复 / 抽空窗口。 */
export function shouldSkipScheduleProactiveForBusy(phone = {}, now = Date.now(), options = {}) {
  // 用户关闭「系统自动回复」后，旧 sessionAutoReply / sparse 状态不得继续压住日程主动。
  if (options.systemAutoReplyEnabled === false) return false;
  const state = phone?.busyAutoReplyState || {};
  if (Number(state.sparseUntil || 0) > now) return true;
  if (getLiveSessionAutoReply(phone, now)) return true;
  if (Number(state.lastRepliedAt || 0) > 0
    && now - Number(state.lastRepliedAt || 0) < RECENT_PROACTIVE_GUARD_MS) {
    return true;
  }
  return false;
}

async function hasRecentCharacterAiMessage(chatId = '', characterId = '', now = Date.now()) {
  if (!chatId || !characterId) return false;
  const recent = await listMessagesForChat(chatId, 12).catch(() => []);
  return asArray(recent).some((msg) => (
    msg
    && !msg.deleted
    && !msg.recalled
    && String(msg.senderId || '') === String(characterId || '')
    && msg.metadata?.aiGenerated
    && now - Number(msg.timestamp || 0) >= 0
    && now - Number(msg.timestamp || 0) < RECENT_PROACTIVE_GUARD_MS
  ));
}

export async function maybeHandleBusyAutoReply(options = {}) {
  const { chat, user, messages = [], resolveSenderName, chatPrefs: prefsIn } = options;
  if (!isPrivateUserChat(chat) || !user?.id) return null;
  const last = getUnansweredRealUserMessage(messages);
  if (!last) return null;

  const characterId = privatePartnerId(chat);
  if (!characterId) return null;
  const autonomyPolicy = await loadResolvedCharacterAutonomyPolicy(
    user.id,
    characterId,
    chat.id,
  ).catch(() => null);
  if (autonomyPolicy?.realPersonMode?.enabled !== true) return null;
  const systemAutoReplyEnabled = isBusySystemAutoReplyEnabled(autonomyPolicy);
  const now = await getNowForUser(user.id);
  const timeZone = await resolveCharacterScheduleTimezone(user.id, characterId).catch(() => '');
  const dateKey = dateKeyFromTimestamp(now, timeZone);
  let phone = await loadCharacterPhone(user.id, characterId);
  const pruned = pruneExpiredDailyLifePlans(phone, dateKey);
  if (pruned.removed) phone = await saveCharacterPhone(pruned.phone);
  const { block } = resolveActiveDailyLifePlanBlock(phone, now, timeZone);
  const currentStep = block ? pickCurrentFlowStep(block, now, timeZone) : null;

  let chatPrefs = prefsIn && typeof prefsIn === 'object' ? prefsIn : null;
  if (!chatPrefs && chat?.id) {
    try {
      const { loadChatPrefsWithExpiredStatus } = await import('./status-ttl.js');
      chatPrefs = await loadChatPrefsWithExpiredStatus(chat.id);
    } catch (_) {
      chatPrefs = {};
    }
  }
  const [liveState, runtimeState] = await Promise.all([
    loadCharacterLiveState(user.id, characterId, {
      now,
      presenceNow: Date.now(),
    }).catch(() => null),
    loadCharacterRuntimeState(user.id, characterId, { now }).catch(() => null),
  ]);
  const hasLivePresence = hasAuthoritativeCharacterPresence(liveState?.presence);
  const presenceState = hasLivePresence
    ? String(liveState?.presence?.state || 'online')
    : (chatPrefs?.presenceState === 'offline' ? 'offline' : 'online');
  const presenceSource = String(liveState?.presence?.source || '');
  const manualPresence = presenceSource === 'manual';
  const presenceOffline = presenceState === 'offline';
  const statusText = clean(
    liveState?.statusLine?.text || chatPrefs?.statusText || '',
    40,
  );
  const statusBusyLike = isRealPersonReplyVisiblyBusy({
    visibleStatusBusy: liveState?.statusLine?.source === 'manual'
      ? false
      : isBusyLikeStatusText(statusText),
    presenceState: manualPresence ? 'online' : presenceState,
  });
  const effectiveState = resolveEffectiveCharacterState({
    runtimeState,
    sceneFact: liveState?.sceneFact || null,
    scheduleBlock: block,
    allowSceneScheduleOverride: liveState?.policy?.sceneScheduleOverrideAllowed !== false,
    now,
  });
  const phoneScheduleBusy = resolveScheduleBlockBusyState(block, currentStep);
  const replyScheduleBusy = manualPresence ? false : phoneScheduleBusy;
  if (isManualPresenceReplyBlocked({ presenceState, presenceSource })) {
    return {
      ok: true,
      handled: true,
      reason: presenceState === 'offline' ? 'manual-offline' : 'manual-busy',
      busyGate: true,
    };
  }
  // 同一会话里仍有效的临时场景就是此刻已经发生的现实：角色已经在争吵、谈话或处理
  // 当前事件时，不能再被较早生成的后台忙碌/睡眠日程压回“连发多条才回复”。
  // 用户手动忙碌/离线仍在上方保持最高优先级；明确的 away / busy / offline
  // 在线态也不能被旧的同会话场景误判成“仍守着屏幕”。
  if ((!hasLivePresence || presenceState === 'online') && isActiveConversationScene(effectiveState, chat.id)) return null;
  const scheduleBusy = effectiveState.scheduleOverridden
    ? isBusyLikeStatusText(effectiveState.activity)
    : replyScheduleBusy;
  const scheduleActivity = currentStep?.action || block?.activity || block?.anchor || '';
  const sceneActivity = clean(
    effectiveState.scheduleOverridden
      ? effectiveState.activity
      : (scheduleBusy
        ? scheduleActivity
        : (liveState?.sceneFact?.activity || scheduleActivity)),
    80,
  );
  const sessionReply = getLiveSessionAutoReply(phone, now);
  const blockReply = getLiveBlockAutoReply(block, now);
  const configuredAutoReply = sessionReply || blockReply;
  const savedAutoReply = systemAutoReplyEnabled && !manualPresence ? configuredAutoReply : null;
  const gated = Boolean(savedAutoReply?.text);
  if (!gated) {
    // 忙碌门禁跟角色手机里的当前日程步骤走；模型回合产生的隐藏运行时活动
    // 只影响回复内容与语气，不能在手机日程未写忙碌时静默截停后续轮次。
    if (!statusBusyLike && !replyScheduleBusy) return null;
    const pokes = countUserPokesSinceLastRealReply(messages, characterId);
    const sleeping = presenceOffline
      || (!manualPresence && block?.isSleep === true)
      || isSleepLikeStatusText(statusText || sceneActivity);
    const softGate = resolveSoftBusyReplyGate({ pokes, sleeping });
    if (softGate === 'breakthrough') {
      return {
        ok: true,
        handled: false,
        breakThrough: true,
        busyGate: true,
        directive: softBusyBreakThroughDirective({
          statusText: sceneActivity,
          sleeping,
          systemAutoReplyEnabled,
        }),
      };
    }
    // 睡眠/离线前几条一律静默；普通忙碌可在偶数次连敲时本人手打一句假自动回复。
    if (softGate === 'faux') {
      return {
        ok: true,
        handled: false,
        fauxAutoReply: true,
        busyGate: true,
        directive: busyFauxAutoReplyDirective({
          statusText: sceneActivity,
          systemAutoReplyEnabled,
        }),
      };
    }
    return { ok: true, handled: true, reason: sleeping ? 'soft-offline-waiting' : 'busy-waiting', busyGate: true };
  }

  const state = phone.busyAutoReplyState || {};
  const sparseUntil = Number(state.sparseUntil || 0) || 0;
  if (sparseUntil > now) {
    // 抽空窗口内：已有真实回复则静默等待窗口结束；尚未真回则放行本轮（戳醒回合）。
    const hadRealSinceSparse = asArray(messages).some((m) => (
      m
      && !m.deleted
      && !m.recalled
      && String(m.senderId || '') === String(characterId)
      && !m.metadata?.phoneAutoReply
      && !m.metadata?.busyFauxAutoReply
      && Number(m.timestamp || 0) >= Number(state.sparseStartedAt || 0)
    ));
    if (hadRealSinceSparse) {
      return { ok: true, handled: true, reason: 'sparse-window', busyGate: true };
    }
    return null;
  }

  // 连发计数：从「最近一条系统自动回复」往后数用户气泡。
  // pokes === -1：最近角色消息是真回 → 状态仍有效时重新武装，再弹自动回复开新一轮循环。
  let pokes = countUserPokesSinceBusyAutoReply(messages, characterId);
  let rearmCycle = false;
  if (pokes < 0) {
    const trailing = Math.max(1, countTrailingUserPokes(messages));
    let lastChar = null;
    for (let i = asArray(messages).length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.deleted || m.recalled) continue;
      const senderId = String(m.senderId || '');
      if (senderId === 'user' || senderId === 'system' || String(m.type || '') === 'system') continue;
      lastChar = m;
      break;
    }
    if (lastChar && !lastChar.metadata?.phoneAutoReply && !lastChar.metadata?.busyFauxAutoReply && trailing === 1) {
      rearmCycle = true;
      pokes = 1;
    } else {
      pokes = trailing;
    }
  }

  const lastAutoAt = Number(state.lastRepliedAt || savedAutoReply?.setAt || 0) || 0;
  const minutesSince = (!rearmCycle && lastAutoAt > 0)
    ? Math.max(0, (now - lastAutoAt) / 60000)
    : 0;
  const score = computeBusyBreakthroughScore({
    pokes: Math.max(pokes, 0),
    minutesSinceAutoReply: minutesSince,
  });
  const hasEmittedAutoReply = !rearmCycle && (
    asArray(messages).some((m) => (
      m && !m.deleted && String(m.senderId || '') === String(characterId) && m.metadata?.phoneAutoReply
      && !m.metadata?.busyFauxAutoReply
    ))
    || Number(state.lastRepliedAt || 0) > 0
  );

  if (hasEmittedAutoReply && score >= BUSY_BREAKTHROUGH_SCORE) {
    await saveCharacterPhone({
      ...phone,
      busyAutoReplyState: {
        ...state,
        sparseUntil: now + BUSY_SPARSE_WINDOW_MS,
        sparseStartedAt: now,
        wokeKey: '',
      },
    });
    return {
      ok: true,
      handled: false,
      breakThrough: true,
      busyGate: true,
      directive: busyBreakThroughDirective(
        block || {},
        statusBusyLike ? (sceneActivity || '离线/忙') : '',
      ),
    };
  }

  if (!rearmCycle && state.lastUserMessageId === last.id) {
    return { ok: true, handled: true, reason: 'already-replied', busyGate: true };
  }

  const mixFaux = shouldMixFauxBusyAutoReply({
    pokes,
    rearmCycle,
    hasEmittedAutoReply,
  });

  // 冷却窗内：默认静默累戳；偶数戳改手打假装自动回复，与系统弹窗穿插。
  if (!rearmCycle
    && Number(state.lastRepliedAt || 0)
    && now - Number(state.lastRepliedAt || 0) < BUSY_REPLY_GAP_MS) {
    if (mixFaux) {
      await saveCharacterPhone({
        ...phone,
        busyAutoReplyState: {
          ...state,
          lastUserMessageId: last.id,
          lastRepliedAt: now,
        },
      });
      return {
        ok: true,
        handled: false,
        fauxAutoReply: true,
        busyGate: true,
        directive: busyFauxAutoReplyDirective({
          registeredText: savedAutoReply.text,
          statusText: sceneActivity,
        }),
      };
    }
    return { ok: true, handled: true, reason: 'busy-reply-cooldown', busyGate: true };
  }

  // 冷却外本该再弹系统文案时，偶数戳改为手打假装自动回复。
  if (mixFaux) {
    await saveCharacterPhone({
      ...phone,
      busyAutoReplyState: {
        ...state,
        lastUserMessageId: last.id,
        lastRepliedAt: now,
        autoReplySetAt: Number(savedAutoReply.setAt || 0) || 0,
        sparseUntil: 0,
        sparseStartedAt: 0,
        wokeKey: '',
      },
    });
    return {
      ok: true,
      handled: false,
      fauxAutoReply: true,
      busyGate: true,
      directive: busyFauxAutoReplyDirective({
        registeredText: savedAutoReply.text,
        statusText: sceneActivity,
      }),
    };
  }

  const autoReply = savedAutoReply;

  const senderName = typeof resolveSenderName === 'function'
    ? await resolveSenderName(characterId)
    : characterId;
  // 调用方可能在上面的设置、日程和在线态读取期间发生了新输入。
  // 系统自动回复一旦落库就已对用户可见，因此在创建消息前读取实时门禁，
  // 不沿用函数入口处的“无人输入”快照。
  if (typeof options.deliveryGuard === 'function') {
    let deliveryAllowed = false;
    try {
      deliveryAllowed = (await options.deliveryGuard({
        chatId: chat.id,
        characterId,
        anchorMessageId: last.id,
      })) !== false;
    } catch (_) {
      deliveryAllowed = false;
    }
    if (!deliveryAllowed) {
      return {
        ok: false,
        handled: false,
        skipped: true,
        reason: 'composer-active',
        busyGate: true,
      };
    }
  }
  const msg = createMessage({
    chatId: chat.id,
    senderId: characterId,
    senderName,
    type: 'text',
    content: autoReply.text,
    timestamp: clampLiveMessageTimestamp(messages, now + 900),
    metadata: {
      phoneAutoReply: true,
      ...(autoReply.translation ? { translation: autoReply.translation } : {}),
      autoReplyLabel: autoReply.label || '系统自动回复',
      autoReplySource: autoReply.source || '',
      generatedBy: 'character-phone-busy-auto-reply',
      blockId: block?.id || '',
      dateKey,
    },
  });
  await saveMessage(msg);
  await updateChatPreview(chat.id, previewFromMessage(msg), msg.timestamp);
  if (typeof document !== 'undefined' && document.hidden) {
    await bumpChatUnread(chat.id, 1).catch(() => {});
  }
  await saveCharacterPhone({
    ...phone,
    sessionAutoReply: phone.sessionAutoReply?.text ? phone.sessionAutoReply : autoReply,
    busyAutoReplyState: {
      blockId: block?.id || '',
      lastUserMessageId: last.id,
      lastRepliedAt: now,
      autoReplySetAt: Number(autoReply.setAt || 0) || 0,
      sparseUntil: 0,
      sparseStartedAt: 0,
      wokeKey: '',
    },
  });
  return {
    ok: true,
    handled: true,
    message: msg,
    reason: 'busy-auto-reply',
    busyGate: true,
    rearmed: rearmCycle,
  };
}

/**
 * 用户当前的线下状态：
 * - busyIds：有「进行中且未收纳」线下的角色集合——这些角色此刻正和用户线下见面，
 *   不应该再按日程给用户发主动消息（人就在对面）。总结收纳清掉 session 后自然恢复。
 * - active：用户最近一场进行中的线下（session + chat），供其他角色的主动消息触发赴约自动回复。
 */
export async function collectOfflineState(userId) {
  const busyIds = new Set();
  let active = null;
  const chats = await listChatsForUser(userId).catch(() => []);
  for (const chat of chats) {
    const session = await loadOfflineSession(chat.id).catch(() => null);
    if (session?.status !== 'active') continue;
    const participants = activeOfflineBusyCharacterIds(session, chat);
    if (!participants.length) continue;
    for (const id of participants) busyIds.add(id);
    if (!active || Number(session.updatedAt || 0) > Number(active.session.updatedAt || 0)) {
      active = { session, chat };
    }
  }
  return { busyIds, active };
}

/**
 * 进行中线下的真实在场角色。新会话以 attendance 为准；旧会话依次回退到
 * session.participants / 来源聊天成员，避免临时入场者或身份迁移后被主动消息门禁漏掉。
 */
export function activeOfflineBusyCharacterIds(session = null, chat = null) {
  if (!session || session.status !== 'active') return [];
  const attendance = Array.isArray(session?.attendance?.members)
    ? session.attendance.members
      .filter((member) => member?.status === 'active')
      .map((member) => member?.characterId || member?.id)
    : [];
  const fallback = attendance.length
    ? attendance
    : (Array.isArray(session.participants) && session.participants.length
      ? session.participants
      : asArray(chat?.participants));
  const sessionUserId = String(session.userId || '').trim();
  return [...new Set(fallback
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== sessionUserId))];
}

/** 该角色是否正与用户处于「进行中且未收纳」的线下——主动消息（含真人感追发）应让路。 */
export async function isCharacterBusyInOfflineSession(userId, characterId) {
  const id = String(characterId || '').trim();
  if (!userId || !id) return false;
  const { busyIds } = await collectOfflineState(userId).catch(() => ({ busyIds: new Set() }));
  return busyIds.has(id);
}

async function runForPhone(user, rawPhone, now, reason = '', offlineState = null, pacingNow = now) {
  const offlineBusyIds = offlineState?.busyIds || null;
  const characterId = String(rawPhone?.characterId || '').trim();
  if (!characterId) return { skipped: true, reason: 'missing-character' };
  const legacySettings = getScheduleProactiveSettings(rawPhone);
  const autonomy = await loadResolvedCharacterAutonomyPolicy(user.id, characterId, '', {
    phone: rawPhone,
  }).catch(() => null);
  const settings = {
    ...legacySettings,
    ...(autonomy?.scheduleProactive || {}),
  };
  if ((autonomy && !autonomy.totalEnabled) || !settings.enabled || settings.dailyCount <= 0) {
    return { characterId, skipped: true, reason: 'disabled' };
  }
  const character = await getCharacter(characterId).catch(() => null);
  if (!character) return { characterId, skipped: true, reason: 'missing-character-record' };
  const timeZone = await resolveCharacterScheduleTimezone(user.id, characterId, character).catch(() => '');
  if (isAutonomyMuteHourActive(autonomy || {}, now, timeZone)) {
    return { characterId, skipped: true, reason: 'mute-hours' };
  }
  // 用户正和这个角色进行一场未收纳的线下：暂停日程主动消息，不占当日次数与时段。
  if (offlineBusyIds?.has(characterId)) {
    return { characterId, skipped: true, reason: 'active-offline-session' };
  }
  if (shouldSkipScheduleProactiveForBusy(rawPhone, now, {
    systemAutoReplyEnabled: isBusySystemAutoReplyEnabled(autonomy || {}),
  })) {
    return { characterId, skipped: true, reason: 'busy-auto-reply-active' };
  }

  const today = dateKeyFromTimestamp(now, timeZone);
  const triggeredKeys = settings.lastRunDate === today ? [...settings.triggeredKeys] : [];
  const minGapMs = proactiveGapMs(settings);
  // 负差（lastTriggeredAt 落在 now 之后，如时间债追平完成后节奏钟回落）按冷却已过处理，不永久卡死。
  const sinceLastTrigger = pacingNow - Number(settings.lastTriggeredAt || 0);
  if (settings.lastTriggeredAt && minGapMs > 0 && sinceLastTrigger >= 0 && sinceLastTrigger < minGapMs) {
    return { characterId, skipped: true, reason: 'cooldown' };
  }

  let phone = await loadCharacterPhone(user.id, characterId);
  const pruned = pruneExpiredDailyLifePlans(phone, today);
  if (pruned.removed) phone = await saveCharacterPhone(pruned.phone);
  let plan = getDailyLifePlanForDate(phone, today);
  if (!plan?.blocks?.length) {
    // 「生活主动消息」不应该越权替用户决定要不要生成日程——今天没日程时，
    // 只有角色手机里「每天后台自动生成日程」开着才补一次；关着就跳过这次主动消息，
    // 不要偷偷把日程生成出来（这是之前「明明关了开关，日程还是会自动更新」的根因）。
    const autoSettings = await loadCharacterPhoneAutoSettings(user.id).catch(() => null);
    if (!isDailyLifeAutoEnabled(autoSettings, characterId)) {
      return { characterId, skipped: true, reason: 'missing-plan-auto-disabled' };
    }
    const generated = await ensureDailyLifePlan({
      userId: user.id,
      characterId,
      character,
      user,
      force: false,
      timestamp: now,
    }).catch(() => null);
    phone = generated?.phone || await loadCharacterPhone(user.id, characterId);
    plan = generated?.plan || getDailyLifePlanForDate(phone, today);
  }
  if (!plan?.blocks?.length) return { characterId, skipped: true, reason: 'missing-plan' };

  const { block } = resolveActiveDailyLifePlanBlock(phone, now, timeZone);
  if (!block) {
    return { characterId, skipped: true, reason: 'no-active-block' };
  }
  const [runtimeState, liveState] = await Promise.all([
    loadCharacterRuntimeState(user.id, characterId, { now }).catch(() => null),
    loadCharacterLiveState(user.id, characterId, { now, presenceNow: Date.now() }).catch(() => null),
  ]);
  const effectiveState = resolveEffectiveCharacterState({
    runtimeState,
    sceneFact: liveState?.sceneFact || null,
    scheduleBlock: block,
    allowSceneScheduleOverride: liveState?.policy?.sceneScheduleOverrideAllowed !== false,
    now,
  });
  const realityBlockReason = scheduleProactiveRealityBlockReason({ block, liveState, effectiveState });
  if (realityBlockReason) {
    return {
      characterId,
      skipped: true,
      reason: realityBlockReason,
      activity: effectiveState.activity,
    };
  }
  const currentStep = pickCurrentFlowStep(block, now, timeZone);
  const currentTrigger = pickCurrentTriggerWindow(block, now, timeZone);
  const slotKey = slotKeyFromSchedule({
    ts: now,
    dailyCount: settings.dailyCount,
    timeZone,
    block,
    step: currentStep,
    trigger: currentTrigger,
  });
  if (triggeredKeys.includes(slotKey)) {
    return { characterId, skipped: true, reason: 'slot-used' };
  }
  const mirroredRuntime = await loadScheduleProactiveRuntimeMirror(user.id, characterId);
  if (
    hasScheduleProactiveGenerationAttempt(settings, today, slotKey)
    || hasScheduleProactiveGenerationAttempt(mirroredRuntime, today, slotKey)
  ) {
    return { characterId, skipped: true, reason: 'slot-generation-attempted' };
  }
  if (settings.runningSlotKey === slotKey && Number(settings.runningAt || 0) && pacingNow - Number(settings.runningAt || 0) < PROACTIVE_LOCK_TTL_MS) {
    return { characterId, skipped: true, reason: 'slot-running' };
  }
  const lock = await acquireProactiveSlotLock({
    userId: user.id,
    characterId,
    slotKey,
    now: Date.now(),
  });
  if (!lock.ok) {
    return { characterId, skipped: true, reason: lock.reason || 'slot-locked' };
  }
  const liveCharacter = await getCharacter(characterId).catch(() => null);
  if (!liveCharacter) {
    await completeProactiveSlotLock(lock, { status: 'skipped', reason: 'character-deleted' });
    return { characterId, skipped: true, reason: 'character-deleted' };
  }
  const chat = await ensurePrivateChat(user.id, characterId, character.customNickname || character.name || '');
  const blocked = await shouldSuppressAiDelivery(chat);
  if (blocked.blocked) {
    await completeProactiveSlotLock(lock, { status: 'skipped', reason: 'blocked-by-user' });
    return { characterId, skipped: true, reason: 'blocked-by-user' };
  }
  if (await hasRecentCharacterAiMessage(chat.id, characterId, now)) {
    await completeProactiveSlotLock(lock, { status: 'skipped', reason: 'recent-ai-message' });
    return { characterId, skipped: true, reason: 'recent-ai-message' };
  }
  const autonomyGuard = acquireCharacterAutonomyGuard({
    userId: user.id,
    characterId,
    chatId: chat.id,
  }, now);
  if (!autonomyGuard) {
    await completeProactiveSlotLock(lock, { status: 'skipped', reason: 'autonomy-guard' });
    return { characterId, skipped: true, reason: 'autonomy-guard' };
  }
  const recentForDirective = await listMessagesForChat(chat.id, 30).catch(() => []);
  let lifeModule = null;
  let lifeGlimpseSettings = null;
  if (autonomy?.realPersonMode?.enabled === true) {
    try {
      lifeModule = await import('./chat/life-glimpse.js');
      lifeGlimpseSettings = await lifeModule.loadLifeGlimpseSettings(user.id, characterId);
    } catch (_) {
      lifeModule = null;
      lifeGlimpseSettings = null;
    }
  }
  const motivePlan = planProactiveConversation({
    character,
    recentMessages: recentForDirective,
    slotKey,
    hasScheduleMaterial: Boolean(
      currentTrigger?.shareHint
      || currentStep?.shareCandidate
      || asArray(block?.shareCandidates).length
      || (lifeGlimpseSettings?.enabled === true && lifeGlimpseSettings?.aiStoryCardsEnabled === true)
    ),
    busy: resolveScheduleBlockBusyState(block, currentStep),
    channel: 'schedule',
  });
  let directive = buildScheduleDirective({
    character,
    plan,
    block,
    currentStep,
    currentTrigger,
    slotKey,
    settings,
    recentMessages: recentForDirective,
    now,
    timeZone,
    motivePlan,
  });
  const selfGapMs = computeCharacterSelfAbsenceGapMs(recentForDirective, characterId, now);
  const selfAbsenceDirective = buildSelfAbsenceDirective(selfGapMs);
  if (selfAbsenceDirective) directive = `${directive}\n\n${selfAbsenceDirective}`;
  const antiRepeatDirective = buildProactiveAntiRepeatDirective(recentForDirective, characterId);
  if (antiRepeatDirective) directive = `${directive}\n\n${antiRepeatDirective}`;
  // Settings may have changed while schedule/context material was being prepared.
  // Re-read immediately before exposing a running state or starting the model request.
  const latestAutonomy = await loadResolvedCharacterAutonomyPolicy(
    user.id,
    characterId,
    chat.id,
  ).catch(() => null);
  if (latestAutonomy && (
    latestAutonomy.totalEnabled !== true
    || latestAutonomy.scheduleProactive?.enabled !== true
  )) {
    releaseCharacterAutonomyGuard(autonomyGuard, { generated: false, now });
    await completeProactiveSlotLock(lock, { status: 'skipped', reason: 'disabled-before-request' });
    return { characterId, skipped: true, reason: 'disabled-before-request' };
  }
  phone = await saveScheduleProactiveRuntimeState(phone, {
    ...settings,
    lastRunDate: today,
    lastStatus: 'running',
    runningSlotKey: slotKey,
    runningAt: pacingNow,
  });

  const generationReason = /^catch-up:/i.test(String(reason || ''))
    ? `${String(reason)}:schedule-proactive`
    : 'schedule-proactive';
  let result;
  if (lifeModule && shouldUseScheduleProactiveLifeGlimpse({
    motivePlan,
    lifeGlimpseSettings,
    autonomyPolicy: latestAutonomy || autonomy,
  })) {
    const usage = await import('./character-proactive-usage.js');
    const reservation = await usage.reserveProactiveDelivery({
      userId: user.id,
      characterId,
      chatId: chat.id,
      channel: 'schedule',
      reason: generationReason,
      idempotencyKey: slotKey,
      policy: latestAutonomy || autonomy,
    });
    if (!reservation?.ok) {
      result = {
        ok: false,
        skipped: true,
        reason: reservation?.reason || 'daily-limit-reached',
        retryAt: Number(reservation?.retryAt || 0) || 0,
        modelRequestAttempted: false,
      };
    } else {
      const activity = clean(
        currentStep?.action || effectiveState.activity || block?.activity || block?.anchor || '',
        120,
      );
      const place = clean(currentStep?.place || block?.place || '', 100);
      const fact = {
        source: 'schedule',
        activity,
        place,
        occurredAt: now,
        occurredAtClockDomain: 'world',
        sourceFactIds: [`schedule-proactive:${encodeURIComponent(characterId)}:${encodeURIComponent(today)}:${encodeURIComponent(slotKey)}:${encodeURIComponent(String(block?.id || 'block'))}`],
        sourceRevision: String(plan?.revision || plan?.updatedAt || today),
      };
      result = await lifeModule.generateScheduledAiLifeGlimpse({
        userId: user.id,
        chat,
        user,
        character,
        messages: recentForDirective,
        currentContext: { timeZone },
        fact,
        occurredAt: now,
        scheduleSlotKey: slotKey,
        proactiveIdempotencyKey: slotKey,
      }).catch((err) => ({
        ok: false,
        reason: err?.message || String(err || 'failed'),
        modelRequestAttempted: err?.modelRequestAttempted === true,
      }));
      await usage.settleProactiveDelivery({
        userId: user.id,
        characterId,
        reservationId: reservation.reservationId,
        ok: result?.ok === true,
        skipped: result?.skipped === true,
        reason: result?.reason || '',
        // 生活侧面不是聊天气泡，但明确占用一次主动轮。
        messageCount: result?.ok === true && result?.card ? 1 : 0,
      }).catch(() => {});
    }
  } else {
    const { runHeadlessChatReply } = await import('./chat/headless-reply.js');
    result = await runHeadlessChatReply(chat, user, {
      allowInactive: true,
      sceneDirective: directive,
      skipBusyAutoReply: true,
      reason: generationReason,
      proactiveChannel: 'schedule',
      proactiveMotive: motivePlan.motive,
      proactiveIdempotencyKey: slotKey,
    }).catch((err) => ({
      ok: false,
      reason: err?.message || String(err || 'failed'),
      modelRequestAttempted: err?.modelRequestAttempted === true,
    }));
  }
  releaseCharacterAutonomyGuard(autonomyGuard, {
    generated: result?.modelRequestAttempted === true,
    now,
  });

  phone = await loadCharacterPhone(user.id, characterId);
  const nextSettings = getScheduleProactiveSettings(phone);
  const outcome = applyScheduleProactiveGenerationOutcome({
    phone,
    settings: nextSettings,
    result,
    triggeredKeys,
    dateKey: today,
    slotKey,
    block,
    trigger: currentTrigger,
    now,
    pacingNow,
  });
  phone = await saveScheduleProactiveRuntimeState(outcome.phone, outcome.settings);
  await completeProactiveSlotLock(lock, outcome.sent
    ? { status: 'ok' }
    : { status: outcome.resultStatus, reason: outcome.reason });
  if (outcome.sent && outcome.messageCount > 0) {
    const {
      bumpPersistedMessagesUnread,
      notifyCharacterSentMessageIfEnabled,
      shouldNotifyForBackgroundReason,
    } = await import('./native-notifications.js');
    if (shouldNotifyForBackgroundReason(reason, chat.id)) {
      await bumpPersistedMessagesUnread(chat.id, outcome.visibleMessages).catch(() => {});
      await notifyCharacterSentMessageIfEnabled({
        characterName: getCharacterAiContextName(character) || character?.name || '',
        chatId: chat.id,
        tag: `schedule-proactive-${characterId}`,
        messages: outcome.visibleMessages,
        requireHidden: false,
        avatar: character?.avatar || '',
      }).catch(() => {});
    }
    // 用户正在别处线下：这条主动消息可能撞上赴约自动回复（固定文案 / 同行代答），
    // 同一次后台执行里补完「user 回复 → 对方反应」的小回合，并折进线下时间线。
    if (offlineState?.active) {
      try {
        const { maybeRunOfflineAutoReply } = await import('./offline-auto-reply.js');
        await maybeRunOfflineAutoReply({
          user,
          chat,
          characterId,
          incomingMessages: outcome.visibleMessages,
          activeOffline: offlineState.active,
        });
      } catch (err) {
        console.warn('[character-phone-proactive] offline auto reply failed', err);
      }
    }
  }
  if (outcome.cardCount > 0 && typeof window !== 'undefined') {
    window.dispatchEvent?.(new CustomEvent('background-trigger', {
      detail: {
        userId: user.id,
        chatId: chat.id,
        result,
        generated: true,
        reason: generationReason,
        source: 'schedule-life-glimpse',
        at: Date.now(),
      },
    }));
  }
  return {
    characterId,
    chatId: chat.id,
    generated: outcome.generationAttempted,
    generationAttempted: outcome.generationAttempted,
    sent: outcome.sent,
    failed: outcome.resultStatus === 'failed',
    skipped: outcome.resultStatus === 'skipped',
    reason: outcome.reason,
    visibleMessageCount: outcome.messageCount,
    cardCount: outcome.cardCount,
    lifeGlimpseGenerated: outcome.cardCount > 0,
    result,
  };
}

export async function runCharacterPhoneProactiveCheck({ user: suppliedUser = null, userId = '', reason = '' } = {}) {
  if (_running) return { ok: false, reason: 'in-flight' };
  _running = true;
  try {
    const requestedUserId = String(userId || suppliedUser?.id || '').trim();
    const user = suppliedUser
      || (requestedUserId ? await getUserById(requestedUserId) : null)
      || await ensureDefaultUser();
    if (!user?.id) return { ok: false, reason: 'missing-user' };
    // 日程日期与时段跟世界钟一致；冷却使用节奏钟，避免时间债追平期间被冻结。
    const [now, pacingNow] = await Promise.all([
      getNowForUser(user.id),
      getPacingNowForUser(user.id),
    ]);
    const phones = await listCharacterPhonesForUser(user.id);
    const isCatchUp = /^catch-up:/i.test(String(reason || ''));
    const isNativeWake = /native-alarm/i.test(String(reason || ''));
    // 回前台补跑一次只放行一条生成（限突发 API），常规轮最多 3 条；
    // 到上限后剩余角色本轮不再评估，2 分钟后的下一轮会再照顾到（slot 未消耗）。
    const generationCap = isCatchUp && !isNativeWake
      ? MAX_GENERATIONS_PER_CATCH_UP
      : MAX_GENERATIONS_PER_TICK;
    const offlineState = await collectOfflineState(user.id).catch(() => ({ busyIds: new Set(), active: null }));
    const results = [];
    let generatedCount = 0;
    for (const phone of phones) {
      if (generatedCount >= generationCap) {
        results.push({
          characterId: String(phone?.characterId || '').trim(),
          skipped: true,
          reason: 'tick-generation-cap',
        });
        continue;
      }
      const result = await runForPhone(user, phone, now, reason, offlineState, pacingNow);
      if (result?.generated) generatedCount += 1;
      results.push(result);
      if (result?.skipped && result?.characterId && result?.reason) {
        import('./character-proactive-usage.js')
          .then((mod) => mod.recordProactiveOutcome?.({
            userId: user.id,
            characterId: result.characterId,
            channel: 'schedule',
            status: 'skipped',
            reason: result.reason,
            now,
          }))
          .catch(() => {});
      }
    }
    return { ok: true, reason, dateKey: dateKeyFromTimestamp(now), results };
  } finally {
    _running = false;
  }
}

export { CHECK_INTERVAL_MS as CHARACTER_PHONE_PROACTIVE_CHECK_MS };
