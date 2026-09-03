/**
 * 用户自有 Cloudflare 的后台任务协调器。
 *
 * App 活跃时使用本地完整提示词链编译未来任务；Worker 到点只负责调用模型。
 * 结果回到前台后仍由本地棉花糖协议解析器落库，避免服务端复制业务规则。
 */

import {
  acknowledgeGenerationRelayEvent,
  cancelGenerationRelaySchedule,
  getGenerationRelayPrefs,
  isGenerationRelayEnabled,
  listGenerationRelayEvents,
  listGenerationRelaySchedules,
  upsertGenerationRelaySchedule,
} from './generation-relay.js';
import {
  buildApiUrl,
  mergeSystemMessagesIntoFirstUser,
  getConfig,
  resolveGenerationMaxTokens,
  sanitizeChatCompletionsBody,
} from './api.js';
import { resolveChatMainApiOverride } from './api-presets.js';
import { buildChatContext } from './context/build-chat-context.js';
import { prepareHeadlessChatReply } from './chat/headless-reply.js';
import { persistMarshmallowTurn } from './chat/marshmallow-turn-persist.js';
import {
  buildDelayedDirective,
  cancelPendingActions,
  listPendingActions,
  selectEarliestDelayedReplyActions,
} from './chat/pending-actions.js';
import {
  evaluateIdleContinueDue,
  resolveEffectiveIdleContinueSettings,
} from './chat/idle-continue-reply.js';
import { getChat, listChatsForUser, listMessagesForChat, saveChat } from './chat-store.js';
import { getCharacter } from './character-store.js';
import { buildProactiveAntiRepeatDirective } from './chat-helpers.js';
import {
  buildProactiveConversationDirective,
  planProactiveConversation,
} from './proactive-conversation-plan.js';
import { ensureDefaultUser, getUserById, listUsersInSlot } from './user-slot.js';
import {
  dateKeyFromTimestamp,
  getDailyLifePlanForDate,
  isPlanBlockActiveAt,
  loadCharacterPhone,
  pickCurrentPlanBlock,
} from './character-phone-store.js';
import { resolveCharacterScheduleTimezone } from './chat/chat-timezone.js';
import {
  getNowForUser,
  getTimeMode,
  TIME_MODE_VIRTUAL,
} from './time-mode.js';
import { isAllMutedGroup } from '../models/chat.js';
import { notifyHeadlessChatIfEnabled } from './native-notifications.js';
import { isChatComposerBusy } from './chat/chat-composer-guard.js';
import {
  acquireCharacterAutonomyGuard,
  characterIdForAutonomyChat,
  isCharacterAutonomyMutedNow,
  isTemporaryAutonomySkipReason,
  loadResolvedCharacterAutonomyPolicy,
  releaseCharacterAutonomyGuard,
  resolveAutonomyTrigger,
} from './character-autonomy-settings.js';
import { isFixedFallbackChatEligible } from './fixed-fallback-policy.js';

const EVENT_CURSOR_KEY = 'mmCloudBackgroundEventCursorV1';
const EVENT_CURSOR_SCOPE_OWNER_KEY = 'mmCloudBackgroundEventCursorScopeOwnerV2';
const SCHEDULE_REVISIONS_KEY = 'mmCloudBackgroundScheduleRevisionsV1';
const CANCELLED_CHAT_GENERATIONS_KEY = 'mmCloudCancelledChatGenerationsV1';
const MIN_SCHEDULE_LEAD_MS = 60_000;
const CLOUD_TYPING_SNAPSHOT_TTL_MS = 1500;
const CLOUD_TYPING_ACTIVE_MAX_AGE_MS = 10 * 60_000;
let cloudTypingScheduleSnapshot = { at: 0, schedules: [], promise: null };

async function listCloudTypingSchedules() {
  const now = Date.now();
  if (now - cloudTypingScheduleSnapshot.at < CLOUD_TYPING_SNAPSHOT_TTL_MS) {
    return cloudTypingScheduleSnapshot.schedules;
  }
  if (cloudTypingScheduleSnapshot.promise) return cloudTypingScheduleSnapshot.promise;
  const promise = listGenerationRelaySchedules()
    .then((page) => {
      const schedules = Array.isArray(page?.schedules) ? page.schedules : [];
      cloudTypingScheduleSnapshot = { at: Date.now(), schedules, promise: null };
      return schedules;
    })
    .catch(() => {
      cloudTypingScheduleSnapshot.promise = null;
      return null;
    });
  cloudTypingScheduleSnapshot.promise = promise;
  return promise;
}

function cancelledChatGenerations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CANCELLED_CHAT_GENERATIONS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function rememberCancelledChatGeneration(chatId, reason = 'user') {
  const id = String(chatId || '').trim();
  if (!id) return 0;
  const map = cancelledChatGenerations();
  const at = Date.now();
  map[id] = { at, reason: String(reason || 'user') };
  try { localStorage.setItem(CANCELLED_CHAT_GENERATIONS_KEY, JSON.stringify(map)); } catch (_) {}
  return at;
}

function cloudEventWasCancelled(chatId, event = {}) {
  const id = String(chatId || '').trim();
  const cancelledAt = Number(cancelledChatGenerations()[id]?.at || 0);
  if (!id || !cancelledAt) return false;
  const eventAt = Number(event?.revision || 0)
    || Date.parse(String(event?.scheduledFor || event?.createdAt || ''))
    || 0;
  // 老 Worker 事件可能没有时间字段；只在近期取消窗口内保守拦截，避免永久吞掉后续新计划。
  if (!eventAt) return Date.now() - cancelledAt < 5 * 60 * 1000;
  return eventAt <= cancelledAt + 1000;
}

async function isVirtualTimeUser(userId = '') {
  return (await getTimeMode(userId).catch(() => 'real')) === TIME_MODE_VIRTUAL;
}

async function cancelCloudSchedulesByPrefixes(prefixes = []) {
  const wanted = (Array.isArray(prefixes) ? prefixes : []).map(String).filter(Boolean);
  if (!wanted.length) return 0;
  const taskKeys = new Set(
    Object.keys(scheduleRevisions()).filter((key) => wanted.some((prefix) => key.startsWith(prefix))),
  );
  if (cloudRelayReady()) {
    const remote = await listGenerationRelaySchedules().catch(() => ({ schedules: [] }));
    for (const schedule of remote?.schedules || []) {
      const key = String(schedule?.taskKey || '');
      if (wanted.some((prefix) => key.startsWith(prefix))) taskKeys.add(key);
    }
  }
  for (const taskKey of taskKeys) {
    forgetScheduleRevision(taskKey);
    if (cloudRelayReady()) await cancelGenerationRelaySchedule(taskKey).catch(() => {});
  }
  return taskKeys.size;
}

export async function pruneCloudChatSchedulesOutsideUsers(userIds = []) {
  const allowed = new Set((Array.isArray(userIds) ? userIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  if (!allowed.size) return { ok: false, skipped: true, reason: 'missing-users' };
  let cancelled = 0;
  for (const taskKey of Object.keys(scheduleRevisions())) {
    const key = String(taskKey || '');
    let chatId = '';
    if (key.startsWith('chat-auto:')) chatId = key.replace(/^chat-auto:/, '').trim();
    else if (key.startsWith('chat-idle:')) chatId = key.replace(/^chat-idle:/, '').trim();
    else if (key.startsWith('chat-delay:')) {
      const body = key.replace(/^chat-delay:/, '');
      const splitAt = body.lastIndexOf(':');
      chatId = splitAt > 0 ? body.slice(0, splitAt).trim() : '';
    }
    if (!chatId) continue;
    const chat = await getChat(chatId).catch(() => null);
    if (chat?.userId && allowed.has(String(chat.userId))) continue;
    forgetScheduleRevision(key);
    await cancelGenerationRelaySchedule(key).catch(() => {});
    cancelled += 1;
  }
  return { ok: true, cancelled };
}

async function resolveCloudAutoPolicy(chat, userId) {
  const characterId = characterIdForAutonomyChat(chat);
  if (!characterId) {
    return {
      characterId: '',
      policy: {
        totalEnabled: chat?.autoActive === true,
        scheduleProactive: { enabled: false },
        fixedFallback: {
          enabled: chat?.autoActive === true,
          intervalMs: Math.max(60_000, Number(chat?.autoInterval) || 300_000),
          explicitEnabled: chat?.autoActive === true,
        },
      },
    };
  }
  const policy = await loadResolvedCharacterAutonomyPolicy(userId, characterId, chat?.id).catch(() => null);
  return {
    characterId,
    policy: policy || {
      totalEnabled: chat?.autoActive === true,
      scheduleProactive: { enabled: false },
      fixedFallback: {
        enabled: chat?.autoActive === true,
        intervalMs: Math.max(60_000, Number(chat?.autoInterval) || 300_000),
        explicitEnabled: chat?.autoActive === true,
      },
    },
  };
}

function cloudRelayReady() {
  const prefs = getGenerationRelayPrefs();
  return isGenerationRelayEnabled(prefs) && prefs.kind === 'cloudflare-workers';
}

export function resolveCloudEventCursorScopeId(user = null) {
  return String(user?.worldId || user?.slotGroupId || user?.id || '').trim();
}

export function cloudEventCursorStorageKey(scopeId = '') {
  const scope = String(scopeId || '').trim();
  return scope ? `${EVENT_CURSOR_KEY}:${encodeURIComponent(scope)}` : EVENT_CURSOR_KEY;
}

function eventCursor(scopeId = '') {
  try {
    const scope = String(scopeId || '').trim();
    if (!scope) return Math.max(0, Number(localStorage.getItem(EVENT_CURSOR_KEY)) || 0);
    const scopedKey = cloudEventCursorStorageKey(scope);
    const scopedValue = localStorage.getItem(scopedKey);
    if (scopedValue !== null) return Math.max(0, Number(scopedValue) || 0);

    // V1 只有安装级全局游标。升级时只把它交给当时活跃的档位；其它档位从 0
    // 补扫，并凭稳定 aiRoundId 幂等，避免全局游标曾越过它们的未应用事件。
    const migrationOwner = String(localStorage.getItem(EVENT_CURSOR_SCOPE_OWNER_KEY) || '').trim();
    if (!migrationOwner) {
      localStorage.setItem(EVENT_CURSOR_SCOPE_OWNER_KEY, scope);
      return Math.max(0, Number(localStorage.getItem(EVENT_CURSOR_KEY)) || 0);
    }
    if (migrationOwner === scope) {
      return Math.max(0, Number(localStorage.getItem(EVENT_CURSOR_KEY)) || 0);
    }
    return 0;
  } catch (_) {
    return 0;
  }
}

function saveEventCursor(value, scopeId = '') {
  try {
    const normalized = String(Math.max(0, Number(value) || 0));
    const scope = String(scopeId || '').trim();
    localStorage.setItem(cloudEventCursorStorageKey(scope), normalized);
    if (!scope || String(localStorage.getItem(EVENT_CURSOR_SCOPE_OWNER_KEY) || '').trim() === scope) {
      localStorage.setItem(EVENT_CURSOR_KEY, normalized);
    }
  } catch (_) {}
}

const RETRYABLE_CLOUD_APPLY_REASONS = new Set([
  'api-not-ready',
  'autonomy-guard',
  'catch-up-generation-cap',
  'chat-generation-in-flight',
  'composer-active',
  'foreground-streaming',
  'generation-in-flight',
  'headless-in-flight',
  'input-active',
  'input-busy',
  'local-apply-failed',
  'missing-event-user',
  'prepare-failed',
]);

export function classifyCloudEventApplyResult(result = {}) {
  if (result?.ok === true) {
    return { outcome: 'applied', retryable: false, definitive: true };
  }
  const reason = String(result?.reason || '').trim().toLowerCase();
  const retryable = result?.retryable === true
    || result?.failureClass === 'retryable-local-apply'
    || RETRYABLE_CLOUD_APPLY_REASONS.has(reason)
    || /(?:indexeddb|database|storage|transaction|temporar|timeout|quota.*write|write.*fail)/i.test(reason);
  return {
    outcome: retryable ? 'retryable-local-apply' : 'definitive-discard',
    retryable,
    definitive: !retryable,
  };
}

export function resolveCloudEventDisposition({ event = null, result = null, foreignSlot = false } = {}) {
  if (event?.appliedAt) {
    return { outcome: 'already-acknowledged', acknowledge: false, blocksCursor: false };
  }
  if (foreignSlot) {
    return { outcome: 'foreign-slot', acknowledge: false, blocksCursor: false };
  }
  const classification = classifyCloudEventApplyResult(result || {});
  return {
    ...classification,
    acknowledge: !classification.retryable,
    blocksCursor: classification.retryable,
  };
}

function scheduleRevisions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCHEDULE_REVISIONS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function rememberScheduleRevision(taskKey, revision) {
  try {
    const map = scheduleRevisions();
    map[String(taskKey)] = Math.max(Number(map[String(taskKey)] || 0), Number(revision) || 0);
    localStorage.setItem(SCHEDULE_REVISIONS_KEY, JSON.stringify(map));
  } catch (_) {}
}

function forgetScheduleRevision(taskKey) {
  try {
    const map = scheduleRevisions();
    delete map[String(taskKey)];
    localStorage.setItem(SCHEDULE_REVISIONS_KEY, JSON.stringify(map));
  } catch (_) {}
  trackScheduleRunAt(taskKey, 0);
}

// —— APK 云端到点唤醒：Worker 推不动被杀的原生壳（WebView 无 Web Push、未接 FCM），
// 但每个云端计划的 runAt 我们自己知道。把最早的到点时间镜像成一个原生精确闹钟，
// 到点后闹钟唤醒 JS 跑 catch-up 对账，云端生成的消息落库后由本地通知弹出真实内容。
// 网页/PWA 走 Web Push，这条链路只在原生壳生效（scheduleNativeExactWake 自带能力检测）。
const NATIVE_CLOUD_WAKE_ALARM_ID = 'cloud-schedule-due';
// runAt 是 Worker cron 扫到的时间（分钟粒度）+ 生成耗时，闹钟晚两分钟再叫，提高一次命中率。
const NATIVE_CLOUD_WAKE_BUFFER_MS = 2 * 60_000;
const nativeWakeRunAts = new Map();
let nativeWakeSyncQueued = false;

function trackScheduleRunAt(taskKey, runAt) {
  const key = String(taskKey || '');
  if (!key) return;
  if (Number(runAt) > 0) nativeWakeRunAts.set(key, Number(runAt));
  else if (!nativeWakeRunAts.delete(key)) return;
  if (nativeWakeSyncQueued) return;
  nativeWakeSyncQueued = true;
  // 同一轮全量对齐会连环 track；合并到微任务末尾只重排一次闹钟。
  Promise.resolve().then(() => {
    nativeWakeSyncQueued = false;
    return syncNativeCloudWakeAlarm();
  }).catch(() => {});
}

async function syncNativeCloudWakeAlarm() {
  try {
    const {
      isNativeBackgroundWakeSupported,
      scheduleNativeExactWake,
      cancelNativeExactWake,
    } = await import('./native-background-wake.js');
    if (!isNativeBackgroundWakeSupported()) return;
    const now = Date.now();
    let earliest = 0;
    for (const [key, runAt] of nativeWakeRunAts) {
      if (runAt <= now - 10 * 60_000) {
        nativeWakeRunAts.delete(key);
        continue;
      }
      if (!earliest || runAt < earliest) earliest = runAt;
    }
    if (!earliest) {
      await cancelNativeExactWake(NATIVE_CLOUD_WAKE_ALARM_ID);
      return;
    }
    await scheduleNativeExactWake(
      NATIVE_CLOUD_WAKE_ALARM_ID,
      Math.max(now + 30_000, earliest + NATIVE_CLOUD_WAKE_BUFFER_MS),
    );
  } catch (_) { /* 闹钟排不上时仍有 15 分钟周期补跑与回前台对账兜底 */ }
}

export function hasCloudAutoChatSchedule(chatId) {
  const id = String(chatId || '').trim();
  return !!(id && cloudRelayReady() && scheduleRevisions()[`chat-auto:${id}`]);
}

/**
 * 当前会话是否有云端任务正在排队/生成（用于聊天窗「正在输入」）。
 * 依据 Worker /schedules 的 lastJobStatus 与本地 revision 记忆。
 */
export async function getCloudChatTypingHint(chatId) {
  const id = String(chatId || '').trim();
  if (!id || !cloudRelayReady()) return { typing: false, reason: 'disabled' };
  const revisions = scheduleRevisions();
  let relatedKeys = Object.keys(revisions).filter((key) => (
    key === `chat-auto:${id}`
    || key === `chat-idle:${id}`
    || key.startsWith(`chat-delay:${id}:`)
  ));
  if (!relatedKeys.length) return { typing: false, reason: 'no-schedule' };
  const idleTaskKey = `chat-idle:${id}`;
  if (relatedKeys.includes(idleTaskKey)) {
    try {
      const [chat, user] = await Promise.all([getChat(id), ensureDefaultUser()]);
      const characterId = characterIdForAutonomyChat(chat);
      if (chat && characterId) {
        const { resolveCharacterAutonomousMessageBlock } = await import('./character-phone-proactive.js');
        const block = await resolveCharacterAutonomousMessageBlock(
          user.id,
          characterId,
          id,
          await getNowForUser(user.id),
        );
        if (block?.blocked) {
          forgetScheduleRevision(idleTaskKey);
          await cancelGenerationRelaySchedule(idleTaskKey).catch(() => {});
          relatedKeys = relatedKeys.filter((key) => key !== idleTaskKey);
        }
      }
    } catch (_) { /* 实时门禁读不到时仍以远端任务状态为准 */ }
  }
  if (!relatedKeys.length) return { typing: false, reason: 'blocked-schedule-cancelled' };
  let schedules = [];
  try {
    schedules = await listCloudTypingSchedules();
    if (!schedules) return { typing: false, reason: 'list-failed' };
  } catch (_) {
    return { typing: false, reason: 'list-failed' };
  }
  const now = Date.now();
  for (const schedule of schedules) {
    const taskKey = String(schedule.taskKey || '');
    if (!relatedKeys.includes(taskKey)) continue;
    const status = String(schedule.lastJobStatus || '');
    if (status === 'queued' || status === 'running') {
      const activeAt = Date.parse(schedule.lastRunAt || schedule.updatedAt || schedule.runAt || '') || 0;
      if (!activeAt || now - activeAt <= CLOUD_TYPING_ACTIVE_MAX_AGE_MS) {
        return { typing: true, reason: status, taskKey, taskType: schedule.taskType || '' };
      }
    }
    // 刚到点且 Worker 尚未领取时，短暂显示正在输入。失败/取消的旧任务以及已经
    // 过期很久的计划都不是活跃生成，不能让列表永久停在“正在输入”。
    const runAt = Date.parse(schedule.runAt || '') || 0;
    const waitingForClaim = !status || status === 'pending' || status === 'scheduled';
    if (
      schedule.enabled !== false
      && waitingForClaim
      && runAt
      && runAt <= now + 15_000
      && runAt >= now - 2 * 60_000
    ) {
      return { typing: true, reason: 'due', taskKey, taskType: schedule.taskType || '' };
    }
  }
  return { typing: false, reason: 'idle' };
}

function completionText(result) {
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || '').join('');
  }
  return '';
}

function absoluteEndpoint(baseUrl) {
  const url = buildApiUrl(baseUrl, '/v1/chat/completions');
  return /^https?:\/\//i.test(url) ? url : '';
}

async function isCurrentScheduleUsable(userId, characterId, policy = {}) {
  if (!characterId || policy.scheduleProactive?.enabled !== true) return false;
  try {
    const worldNow = await getNowForUser(userId);
    const timeZone = await resolveCharacterScheduleTimezone(userId, characterId).catch(() => '');
    const phone = await loadCharacterPhone(userId, characterId);
    const plan = getDailyLifePlanForDate(phone, dateKeyFromTimestamp(worldNow, timeZone));
    const block = pickCurrentPlanBlock(plan, worldNow, timeZone);
    return Boolean(block && isPlanBlockActiveAt(block, worldNow, timeZone));
  } catch (_) {
    return false;
  }
}

async function compileChatRequest(chat, user, options = {}) {
  const fixedGroupTick = chat?.type === 'group' && chat?.autoActive === true;
  const preparedResult = await prepareHeadlessChatReply(chat, user, {
    reason: 'cloud-scheduled',
    skipBusyAutoReply: true,
    ignoreComposerBusy: fixedGroupTick,
    allowInactive: options.allowInactive === true,
    ...(options.sceneDirective ? { sceneDirective: options.sceneDirective } : {}),
    // 编译会随每轮对话反复发生，预算只在结果真正落库时结算一次。
    apiBudgetConsumed: true,
  });
  if (!preparedResult?.ok || !preparedResult.prepared) {
    return { ok: false, reason: preparedResult?.reason || 'prepare-failed' };
  }
  const prepared = preparedResult.prepared;
  const built = await buildChatContext({
    chat: prepared.chat,
    user: prepared.user,
    userId: prepared.userId,
    messages: prepared.messages,
    characters: prepared.characters,
    sceneDirective: prepared.sceneDirective,
    contextNow: Number(options.contextNow || 0) || undefined,
  });
  const [mainConfig, override] = await Promise.all([
    getConfig(),
    resolveChatMainApiOverride(chat.id).catch(() => null),
  ]);
  const config = { ...mainConfig, ...(override || {}) };
  const url = absoluteEndpoint(config.baseUrl);
  if (!url || !config.apiKey || !config.model) {
    return { ok: false, reason: 'api-not-ready' };
  }
  const maxTokens = await resolveGenerationMaxTokens(override || null);
  const useSystemMergeCompat = config.singleUserCompat === true;
  const request = sanitizeChatCompletionsBody({
    model: config.model,
    messages: useSystemMergeCompat ? mergeSystemMessagesIntoFirstUser(built.messages) : built.messages,
    temperature: config.temperature,
    top_p: config.topP,
    frequency_penalty: config.frequencyPenalty,
    presence_penalty: config.presencePenalty,
    max_tokens: maxTokens,
    ...(String(config.reasoningEffort || '').trim()
      ? { reasoning_effort: String(config.reasoningEffort).trim() }
      : {}),
    stream: config.preferStream !== false,
  });
  return {
    ok: true,
    request,
    upstream: {
      url,
      apiKey: config.apiKey,
      customHeaders: config.customHeaders || {},
    },
  };
}

async function persistCloudProactiveTurn({
  rawText,
  prepared,
  userId,
  characterId,
  chatId,
  channel,
  motive = '',
  event,
  timestamp,
  aiRoundId,
  ignoreComposerBusy = false,
  requirePolicy = true,
  reserveQuota = true,
}) {
  const deliveryGuard = async () => {
    if (!ignoreComposerBusy && isChatComposerBusy(chatId)) {
      return { ok: false, reason: 'composer-active' };
    }
    if (cloudEventWasCancelled(chatId, event)) return { ok: false, reason: 'cloud-generation-cancelled' };
    if (requirePolicy) {
      const policy = await loadResolvedCharacterAutonomyPolicy(userId, characterId, chatId).catch(() => null);
      if (policy?.totalEnabled !== true) return { ok: false, reason: 'proactive-disabled' };
    }
    return { ok: true };
  };
  const initialGate = await deliveryGuard();
  if (!initialGate.ok) return { ...initialGate, skipped: true };
  const { reserveProactiveDelivery, settleProactiveDelivery } = await import('./character-proactive-usage.js');
  const reservation = reserveQuota
    ? await reserveProactiveDelivery({
      userId,
      characterId,
      chatId,
      channel,
      reason: 'cloud-result',
      idempotencyKey: String(event?.id || event?.taskKey || aiRoundId),
      requireTotalEnabled: requirePolicy,
    })
    : null;
  if (reserveQuota && !reservation?.ok) {
    return { ok: false, skipped: true, reason: reservation?.reason || 'daily-limit-reached' };
  }
  let result;
  try {
    result = await persistMarshmallowTurn(rawText, {
      ...prepared,
      proactiveChannel: channel,
      proactiveMotive: motive,
      proactiveReservationId: reservation?.reservationId || '',
      aiRoundId,
      rerollRootId: aiRoundId,
      aiRoundCreatedAt: timestamp,
      aiRoundKind: 'advance',
      baseTimestamp: timestamp,
      allowOpenTail: true,
      deliveryGuard,
    });
    if (reservation?.reservationId) {
      await settleProactiveDelivery({
        userId,
        characterId,
        reservationId: reservation.reservationId,
        ok: result?.ok === true,
        skipped: result?.skipped === true,
        reason: result?.reason || '',
        messageCount: result?.messageCount || result?.messages?.length || 0,
      });
    }
    return result;
  } catch (error) {
    if (reservation?.reservationId) {
      await settleProactiveDelivery({
        userId,
        characterId,
        reservationId: reservation.reservationId,
        ok: false,
        reason: error?.message || 'cloud-persist-failed',
      }).catch(() => {});
    }
    throw error;
  }
}

/**
 * 编译/替换某个聊天的云端自动推进计划。
 * 同一 taskKey 使用单调 revision，旧上下文即使还在队列中也不会覆盖新计划。
 */
export async function syncCloudAutoChatSchedule(chatRow, userRow = null) {
  const chatId = String(chatRow?.id || '').trim();
  if (!chatId) return { ok: false, skipped: true, reason: 'missing-chat' };
  const taskKey = `chat-auto:${chatId}`;
  if (!isFixedFallbackChatEligible(chatRow)) {
    forgetScheduleRevision(taskKey);
    if (chatRow.autoActive === true) {
      await saveChat({ ...chatRow, autoActive: false }).catch(() => {});
    }
    if (cloudRelayReady()) await cancelGenerationRelaySchedule(taskKey).catch(() => {});
    return { ok: false, skipped: true, reason: 'ineligible-chat-channel' };
  }
  const user = userRow || await ensureDefaultUser();
  if (await isVirtualTimeUser(user.id)) {
    forgetScheduleRevision(taskKey);
    if (cloudRelayReady()) await cancelGenerationRelaySchedule(taskKey).catch(() => {});
    return { ok: false, skipped: true, reason: 'virtual-time-local-only' };
  }
  const resolved = await resolveCloudAutoPolicy(chatRow, user.id);
  const scheduleUsable = await isCurrentScheduleUsable(user.id, resolved.characterId, resolved.policy);
  const [worldNow, timeZone] = await Promise.all([
    getNowForUser(user.id),
    resolved.characterId
      ? resolveCharacterScheduleTimezone(user.id, resolved.characterId).catch(() => '')
      : Promise.resolve(''),
  ]);
  const trigger = resolveAutonomyTrigger(resolved.policy, {
    scheduleUsable,
    fixedFallbackDue: true,
    now: worldNow,
    timeZone,
  });
  if (!cloudRelayReady() || trigger.kind !== 'fixed-fallback' || isAllMutedGroup(chatRow)) {
    // 临时跳过（例如静音）也要清掉本地 revision，否则本地 timer 会以为云端还在托管而永久空转。
    forgetScheduleRevision(taskKey);
    if (cloudRelayReady()) {
      await cancelGenerationRelaySchedule(taskKey).catch(() => {});
    }
    return {
      ok: false,
      skipped: true,
      reason: trigger.reason || (isAllMutedGroup(chatRow) ? 'all-muted' : 'disabled'),
      temporary: isTemporaryAutonomySkipReason(trigger.reason),
    };
  }
  const { getCharacterProactiveUsageStatus } = await import('./character-proactive-usage.js');
  const usage = await getCharacterProactiveUsageStatus(user.id, resolved.characterId).catch(() => null);
  if (usage && usage.remaining <= 0) {
    forgetScheduleRevision(taskKey);
    await cancelGenerationRelaySchedule(taskKey).catch(() => {});
    return { ok: false, skipped: true, reason: 'daily-limit-reached' };
  }
  const [proactiveCharacter, proactiveRecent] = await Promise.all([
    getCharacter(resolved.characterId).catch(() => null),
    listMessagesForChat(chatId, 30).catch(() => []),
  ]);
  const proactivePlan = planProactiveConversation({
    character: proactiveCharacter || { id: resolved.characterId },
    recentMessages: proactiveRecent,
    slotKey: taskKey,
    hasScheduleMaterial: false,
    allowMemoryCallback: chatRow?.type !== 'group',
    busy: false,
    channel: 'fixed-fallback',
  });
  const antiRepeatDirective = buildProactiveAntiRepeatDirective(
    proactiveRecent,
    resolved.characterId,
  );
  const intervalMs = Math.max(60_000, Number(resolved.policy.fixedFallback?.intervalMs) || 300_000);
  const anchor = Number(chatRow.autoLastTriggeredAt || 0);
  const runAt = Math.max(
    Date.now() + MIN_SCHEDULE_LEAD_MS,
    anchor > 0 ? anchor + intervalMs : Date.now() + intervalMs,
  );
  const compiled = await compileChatRequest(chatRow, user, {
    contextNow: runAt,
    sceneDirective: [
      '[普通主动联系机会] 这是用户原有频率设置产生的一次主动机会，不是日程播报，也不因当前关系阶段减少次数。',
      buildProactiveConversationDirective(proactivePlan),
      antiRepeatDirective,
      '日程只用于判断生活背景；除非动机明确是生活片段，否则不要把正在做什么、去了哪里写成默认话题。',
    ].filter(Boolean).join('\n\n'),
  });
  if (!compiled.ok) {
    // 编译失败时保留旧 revision：远端可能仍有上一版计划在跑，清掉会让本地抢跑造成双发。
    return compiled;
  }
  const revision = Date.now();
  let result;
  try {
    result = await upsertGenerationRelaySchedule({
      taskKey,
      taskType: 'chat-auto',
      revision,
      runAt,
      // 固定间隔只决定下一次预约时刻，不能让中继拿同一份冻结上下文自行循环。
      // 本次结果由客户端确认并写进聊天后，再基于最新对话上传下一次一次性计划。
      intervalMs: null,
      request: compiled.request,
      upstream: compiled.upstream,
      // 定时计划可能排队较久；到点后仍给模型最多 15 分钟完成。
      requestTtlSeconds: 900,
      resultTtlSeconds: 7 * 24 * 60 * 60,
    });
  } catch (error) {
    // 上传失败同样不 forget：旧计划可能还在；由 ensureCloudAutoChatOwnership 探测后交还。
    return { ok: false, reason: error?.message || String(error || 'upsert-failed') };
  }
  if (result?.ok === false || result?.error) {
    return result?.ok === false ? result : { ok: false, ...(result || {}), reason: 'upsert-rejected' };
  }
  rememberScheduleRevision(taskKey, revision);
  trackScheduleRunAt(taskKey, runAt);
  return result?.ok === false ? result : { ok: true, ...(result || {}) };
}

/**
 * 本地 timer 跳过前探测：云端是否仍真正托管该 chat-auto。
 * 本地有 revision 但远端已无启用计划时，清掉占坑并交还本地生成。
 */
export async function ensureCloudAutoChatOwnership(chatId) {
  const id = String(chatId || '').trim();
  const taskKey = `chat-auto:${id}`;
  if (!id || !cloudRelayReady()) {
    forgetScheduleRevision(taskKey);
    return { owns: false, reason: 'disabled' };
  }
  if (!scheduleRevisions()[taskKey]) {
    return { owns: false, reason: 'no-local-revision' };
  }
  let schedules = [];
  try {
    const page = await listGenerationRelaySchedules();
    schedules = page.schedules || [];
  } catch (_) {
    // 列计划失败时保守交还本地，避免「连不上中继却永远跳过」。
    forgetScheduleRevision(taskKey);
    return { owns: false, reason: 'list-failed' };
  }
  const hit = schedules.find((item) => String(item?.taskKey || '') === taskKey);
  const lastJobStatus = String(hit?.lastJobStatus || '');
  if (
    hit
    && (
      hit.enabled !== false
      || lastJobStatus === 'queued'
      || lastJobStatus === 'running'
      || lastJobStatus === 'succeeded'
    )
  ) {
    return {
      owns: true,
      reason: hit.enabled !== false ? 'cloud-enabled' : `cloud-${lastJobStatus}`,
      runAt: hit.runAt || null,
    };
  }
  forgetScheduleRevision(taskKey);
  return { owns: false, reason: hit ? 'cloud-disabled' : 'cloud-missing' };
}

export async function cancelCloudAutoChatSchedule(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return { ok: false, skipped: true };
  const taskKey = `chat-auto:${id}`;
  forgetScheduleRevision(taskKey);
  if (!cloudRelayReady()) return { ok: false, skipped: true };
  return cancelGenerationRelaySchedule(taskKey);
}

/** 删除会话时一并撤销该会话的固定推进、闲置续聊和延时回复云计划。 */
export async function cancelCloudChatSchedules(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return { ok: false, skipped: true };
  const known = scheduleRevisions();
  const taskKeys = new Set(Object.keys(known).filter((key) => (
    key === `chat-auto:${id}`
    || key === `chat-idle:${id}`
    || key.startsWith(`chat-delay:${id}:`)
  )));
  taskKeys.add(`chat-auto:${id}`);
  taskKeys.add(`chat-idle:${id}`);
  // 停止必须先在本机生效，不能等中继列表/删除请求返回后才清掉「正在输入」归属。
  // 否则中继网络异常时，用户会看到终止按钮一直无效。
  for (const taskKey of taskKeys) forgetScheduleRevision(taskKey);
  const cancellations = cloudRelayReady()
    ? [...taskKeys].map((taskKey) => (
      cancelGenerationRelaySchedule(taskKey).catch(() => ({ ok: false }))
    ))
    : [];
  if (cloudRelayReady()) {
    const remote = await listGenerationRelaySchedules().catch(() => ({ schedules: [] }));
    for (const schedule of remote?.schedules || []) {
      const key = String(schedule?.taskKey || '');
      if (key.startsWith(`chat-delay:${id}:`)) {
        if (!taskKeys.has(key)) {
          taskKeys.add(key);
          forgetScheduleRevision(key);
          cancellations.push(
            cancelGenerationRelaySchedule(key).catch(() => ({ ok: false })),
          );
        }
      }
    }
  }
  if (cancellations.length) await Promise.allSettled(cancellations);
  return { ok: true, cancelled: taskKeys.size };
}

/** 停止按钮/用户开始输入：先立撤销标记，再取消尚未完成的云计划。 */
export async function cancelCloudChatGeneration(chatId, reason = 'user') {
  const id = String(chatId || '').trim();
  if (!id) return { ok: false, skipped: true, reason: 'missing-chat' };
  rememberCancelledChatGeneration(id, reason);
  if (typeof window !== 'undefined') {
    window.dispatchEvent?.(new CustomEvent('cloud-chat-generation-cancelled', {
      detail: { chatId: id, reason: String(reason || 'user'), at: Date.now() },
    }));
  }
  const result = await cancelCloudChatSchedules(id).catch(() => ({ ok: false, cancelled: 0 }));
  return { ok: true, cancelled: Number(result?.cancelled || 0) };
}

/** 编译时间点之后用户又发过消息 → 云端结果没看到新消息，必须作废。 */
export function hasUserMessageAfter(messages = [], sinceTs = 0) {
  const since = Number(sinceTs) || 0;
  if (!since) return false;
  return (Array.isArray(messages) ? messages : []).some((message) => (
    message
    && !message.deleted
    && String(message.senderId || '') === 'user'
    && Number(message.timestamp || 0) > since
  ));
}

/** 固定间隔主动消息使用冻结请求；编译后任一方又说过话，旧请求就已经缺失上下文。 */
export function hasConversationMessageAfter(messages = [], sinceTs = 0) {
  const since = Number(sinceTs) || 0;
  if (!since) return false;
  return (Array.isArray(messages) ? messages : []).some((message) => {
    const senderId = String(message?.senderId || '').trim();
    return message
      && !message.deleted
      && !message.recalled
      && senderId
      && senderId !== 'system'
      && senderId !== 'guidance'
      && Number(message.timestamp || 0) > since;
  });
}

/**
 * 把本地待办里的延时回复（next_reply_delay 登记的 delayed_reply）镜像成云端一次性计划。
 * 本地待办队列是唯一事实源：这里做全量对齐——没有对应待办的 chat-delay 计划一律取消。
 */
const lastDelayedSyncByUser = new Map();

export async function syncCloudDelayedReplySchedules(userRow = null, options = {}) {
  if (!cloudRelayReady()) return { ok: false, skipped: true, reason: 'disabled' };
  const user = userRow || await ensureDefaultUser();
  const ownedChats = await listChatsForUser(user.id).catch(() => []);
  const ownsDelayTask = (taskKey) => ownedChats.some((chat) => (
    String(taskKey || '').startsWith(`chat-delay:${chat.id}:`)
  ));
  if (await isVirtualTimeUser(user.id)) {
    let cancelled = 0;
    for (const taskKey of Object.keys(scheduleRevisions())) {
      if (!ownsDelayTask(taskKey)) continue;
      forgetScheduleRevision(taskKey);
      await cancelGenerationRelaySchedule(taskKey).catch(() => {});
      cancelled += 1;
    }
    return { ok: false, skipped: true, reason: 'virtual-time-local-only', cancelled };
  }
  const actions = await listPendingActions(user.id).catch(() => []);
  const wanted = selectEarliestDelayedReplyActions(actions);
  // 可见性抖动会高频触发对账；待办集合没变化时 60 秒内不重复编译上传。
  // force 用于聊天轮次完成后强制携带最新上下文重编译。
  const signature = [...wanted.entries()]
    .map(([key, action]) => `${key}@${action.dueAt}`)
    .sort()
    .join('|');
  const now = Date.now();
  const lastSync = lastDelayedSyncByUser.get(user.id) || { at: 0, signature: '' };
  if (
    options.force !== true
    && signature === lastSync.signature
    && now - lastSync.at < 60_000
  ) {
    return { ok: true, skipped: true, reason: 'throttled', tracked: wanted.size };
  }
  lastDelayedSyncByUser.set(user.id, { at: now, signature });
  const known = scheduleRevisions();
  let uploaded = 0;
  for (const taskKey of Object.keys(known)) {
    if (ownsDelayTask(taskKey) && !wanted.has(taskKey)) {
      forgetScheduleRevision(taskKey);
      await cancelGenerationRelaySchedule(taskKey).catch(() => {});
    }
  }
  for (const [taskKey, action] of wanted) {
    const [chat, character] = await Promise.all([
      getChat(action.chatId).catch(() => null),
      getCharacter(action.characterId).catch(() => null),
    ]);
    if (!chat || !character || isAllMutedGroup(chat)) continue;
    const policy = await loadResolvedCharacterAutonomyPolicy(
      user.id,
      action.characterId,
      action.chatId,
    ).catch(() => null);
    if (policy?.realPersonMode?.enabled !== true) {
      forgetScheduleRevision(taskKey);
      await cancelGenerationRelaySchedule(taskKey).catch(() => {});
      continue;
    }
    const revision = Date.now();
    const runAt = Math.max(Date.now() + MIN_SCHEDULE_LEAD_MS, action.dueAt);
    const compiled = await compileChatRequest(chat, user, {
      allowInactive: true,
      contextNow: runAt,
      sceneDirective: buildDelayedDirective(action, character),
    }).catch(() => null);
    if (!compiled?.ok) continue;
    const result = await upsertGenerationRelaySchedule({
      taskKey,
      taskType: 'delayed-reply',
      revision,
      runAt,
      intervalMs: null,
      request: compiled.request,
      upstream: compiled.upstream,
      requestTtlSeconds: 900,
      resultTtlSeconds: 7 * 24 * 60 * 60,
    }).catch(() => null);
    if (result?.ok !== false) {
      rememberScheduleRevision(taskKey, revision);
      trackScheduleRunAt(taskKey, runAt);
      uploaded += 1;
    }
  }
  return { ok: true, uploaded, tracked: wanted.size };
}

async function applyDelayedReplyEvent(event, user) {
  if (await isVirtualTimeUser(user.id)) {
    return { ok: false, skipped: true, reason: 'virtual-time-local-only' };
  }
  const rawKey = String(event?.taskKey || '');
  const body = rawKey.replace(/^chat-delay:/, '');
  const splitAt = body.lastIndexOf(':');
  const chatId = splitAt > 0 ? body.slice(0, splitAt).trim() : '';
  const actorId = splitAt > 0 ? body.slice(splitAt + 1).trim() : '';
  if (!chatId || !actorId) return { ok: false, reason: 'bad-task-key' };
  const latestRevision = Number(scheduleRevisions()[rawKey] || 0);
  if (latestRevision && Number(event.revision || 0) < latestRevision) {
    return { ok: false, skipped: true, reason: 'stale-revision' };
  }
  // 一次性计划：无论落库成功、作废还是失败，云端这条都已终结；
  // 清掉本地 revision 记忆，让本地待办重新接管（成功路径下待办会被取消）。
  forgetScheduleRevision(rawKey);
  if (event.status !== 'succeeded' || !event.result) {
    return { ok: false, reason: event?.error?.message || event.status || 'failed' };
  }
  const chat = await getChat(chatId);
  if (!chat || !(chat.participants || []).includes(actorId) || isAllMutedGroup(chat)) {
    return { ok: false, reason: 'chat-no-longer-active' };
  }
  const policy = await loadResolvedCharacterAutonomyPolicy(user.id, actorId, chatId);
  if (policy?.realPersonMode?.enabled !== true) {
    return { ok: false, reason: 'real-person-disabled' };
  }
  try {
    const { isCharacterBusyInOfflineSession } = await import('./character-phone-proactive.js');
    if (await isCharacterBusyInOfflineSession(user.id, actorId)) {
      return { ok: false, skipped: true, reason: 'active-offline-session' };
    }
  } catch (_) { /* 线下态读不到时不阻塞落库 */ }
  const existing = await listMessagesForChat(chatId);
  // 撞车防护：编译之后用户又说了话，云端这条回复看不到新消息，直接作废。
  // 本地待办仍在队列里，会用包含新消息的全新上下文重新生成。
  if (hasUserMessageAfter(existing, Number(event.revision || 0))) {
    return { ok: false, skipped: true, reason: 'user-message-collision' };
  }
  const rawText = completionText(event.result).trim();
  if (!rawText) return { ok: false, reason: 'empty-result' };
  const aiRoundId = `cloud_${String(event.id || '').replace(/[^\w-]/g, '')}`;
  if (existing.some((message) => message?.metadata?.aiRoundId === aiRoundId)) {
    return { ok: true, skipped: true, reason: 'already-applied' };
  }
  const preparedResult = await prepareHeadlessChatReply(chat, user, {
    reason: 'cloud-result',
    skipBusyAutoReply: true,
    allowInactive: true,
    baseTimestamp: event.scheduledFor ? Date.parse(event.scheduledFor) : Date.now(),
  });
  if (!preparedResult?.ok || !preparedResult.prepared) {
    return { ok: false, reason: preparedResult?.reason || 'prepare-failed' };
  }
  const timestamp = event.scheduledFor ? Date.parse(event.scheduledFor) : Date.now();
  const autonomyGuard = acquireCharacterAutonomyGuard({
    userId: user.id,
    characterId: actorId,
    chatId,
  });
  if (!autonomyGuard) return { ok: false, skipped: true, reason: 'autonomy-guard' };
  let result;
  try {
    result = await persistCloudProactiveTurn({
      rawText,
      prepared: preparedResult.prepared,
      userId: user.id,
      characterId: actorId,
      chatId,
      channel: 'delayed-reply',
      event,
      timestamp,
      aiRoundId,
      requirePolicy: false,
      reserveQuota: false,
    });
  } finally {
    releaseCharacterAutonomyGuard(autonomyGuard, { generated: !!result?.ok });
  }
  if (!result?.ok) return result;
  // 云端这条已经把「稍后回来」兑现了，同角色排队中的本地延时待办一并出清，
  // 避免几分钟后本地再独立生成一轮几乎相同的回复。
  await cancelPendingActions(user.id, (action) => (
    action.kind === 'delayed_reply'
    && action.chatId === chatId
    && action.characterId === actorId
  )).catch(() => {});
  await notifyHeadlessChatIfEnabled(chat, result, {
    reason: 'cloud-scheduled',
  }).catch(() => {});
  window.dispatchEvent?.(new CustomEvent('background-trigger', {
    detail: {
      chatId,
      result,
      generated: true,
      reason: 'cloud-scheduled',
      at: Date.now(),
    },
  }));
  return result;
}

async function applyChatAutoEvent(event, user) {
  if (await isVirtualTimeUser(user.id)) {
    return { ok: false, skipped: true, reason: 'virtual-time-local-only' };
  }
  const chatId = String(event?.taskKey || '').replace(/^chat-auto:/, '').trim();
  if (!chatId) return { ok: false, reason: 'missing-chat-id' };
  const taskKey = String(event.taskKey || '');
  const eventRevision = Number(event.revision || 0);
  const latestRevision = Number(scheduleRevisions()[taskKey] || 0);
  if (latestRevision && eventRevision < latestRevision) {
    return { ok: false, skipped: true, reason: 'stale-revision' };
  }
  const chat = await getChat(chatId);
  const resolved = chat ? await resolveCloudAutoPolicy(chat, user.id) : null;
  const scheduleUsable = resolved
    ? await isCurrentScheduleUsable(user.id, resolved.characterId, resolved.policy)
    : false;
  const [worldNow, timeZone] = await Promise.all([
    getNowForUser(user.id),
    resolved?.characterId
      ? resolveCharacterScheduleTimezone(user.id, resolved.characterId).catch(() => '')
      : Promise.resolve(''),
  ]);
  const trigger = resolved ? resolveAutonomyTrigger(resolved.policy, {
    scheduleUsable,
    fixedFallbackDue: true,
    now: worldNow,
    timeZone,
  }) : { kind: 'none' };
  if (!chat || !isFixedFallbackChatEligible(chat) || trigger.kind !== 'fixed-fallback' || isAllMutedGroup(chat)) {
    return { ok: false, reason: 'chat-no-longer-active' };
  }
  if (event.status !== 'succeeded' || !event.result) {
    return { ok: false, reason: event?.error?.message || event.status || 'failed' };
  }
  const rawText = completionText(event.result).trim();
  if (!rawText) return { ok: false, reason: 'empty-result' };
  const fixedGroupTick = chat.type === 'group' && chat.autoActive === true;
  const deliveryActorId = resolved?.characterId
    || (chat.participants || []).find((id) => id && id !== 'user')
    || '';
  const preparedResult = await prepareHeadlessChatReply(chat, user, {
    reason: 'cloud-result',
    skipBusyAutoReply: true,
    ignoreComposerBusy: fixedGroupTick,
    allowInactive: false,
    baseTimestamp: event.scheduledFor ? Date.parse(event.scheduledFor) : Date.now(),
  });
  if (!preparedResult?.ok || !preparedResult.prepared) {
    return { ok: false, reason: preparedResult?.reason || 'prepare-failed' };
  }
  const timestamp = event.scheduledFor ? Date.parse(event.scheduledFor) : Date.now();
  const aiRoundId = `cloud_${String(event.id || '').replace(/[^\w-]/g, '')}`;
  const existing = await listMessagesForChat(chatId);
  if (existing.some((message) => message?.metadata?.aiRoundId === aiRoundId)) {
    rememberScheduleRevision(taskKey, Math.max(latestRevision, eventRevision + 1));
    return { ok: true, skipped: true, reason: 'already-applied' };
  }
  // 撞车防护：这版计划编译后任一方又发过可见消息，冻结结果都缺了新上下文。
  // 只检查用户会漏掉其它主动通道先落库的角色消息，随后旧结果就会把旧话题近似重放。
  if (hasConversationMessageAfter(existing, Number(event.revision || 0))) {
    return { ok: false, skipped: true, reason: 'conversation-message-collision' };
  }
  const [proactiveCharacter, proactiveRecent] = await Promise.all([
    getCharacter(deliveryActorId).catch(() => null),
    Promise.resolve(existing.slice(-30)),
  ]);
  const proactivePlan = planProactiveConversation({
    character: proactiveCharacter || { id: resolved?.characterId },
    recentMessages: proactiveRecent,
    slotKey: event?.taskKey || chatId,
    hasScheduleMaterial: false,
    allowMemoryCallback: chat?.type !== 'group',
    busy: false,
    channel: 'fixed-fallback',
  });
  const autonomyGuard = acquireCharacterAutonomyGuard({
    userId: user.id,
    characterId: resolved?.characterId,
    chatId,
  });
  if (!autonomyGuard) return { ok: false, skipped: true, reason: 'autonomy-guard' };
  let result;
  try {
    result = await persistCloudProactiveTurn({
      rawText,
      prepared: preparedResult.prepared,
      userId: user.id,
      characterId: deliveryActorId,
      chatId,
      channel: 'fixed-fallback',
      motive: proactivePlan.motive,
      event,
      timestamp,
      aiRoundId,
      ignoreComposerBusy: fixedGroupTick,
      requirePolicy: !fixedGroupTick,
    });
  } finally {
    releaseCharacterAutonomyGuard(autonomyGuard, { generated: !!result?.ok });
  }
  if (!result?.ok) return result;
  // 一个 revision 的请求正文是在计划创建时冻结的；同 revision 后续周期看不到
  // 前一轮已经发出的消息。首条成功结果落库后立刻抬高本地 revision 水位，
  // 让本批及跨页残留结果全部按 stale-revision 丢弃，再由对账尾部基于最新聊天重编译。
  rememberScheduleRevision(taskKey, Math.max(latestRevision, eventRevision + 1));
  const now = Date.now();
  const fresh = await getChat(chatId).catch(() => chat);
  await saveChat({
    ...fresh,
    autoLastTriggeredAt: Math.max(
      Number(fresh?.autoLastTriggeredAt || 0),
      timestamp || now,
    ),
  });
  await notifyHeadlessChatIfEnabled(chat, result, {
    reason: 'cloud-scheduled',
  }).catch(() => {});
  window.dispatchEvent?.(new CustomEvent('background-trigger', {
    detail: {
      chatId,
      result,
      generated: true,
      reason: 'cloud-scheduled',
      at: now,
    },
  }));
  return result;
}

/**
 * 闲置续聊：对开启了设置、且最后一条是用户消息的私聊，上传一次性云计划。
 * 没有待触发锚点的 chat-idle 计划一律取消。
 */
export async function syncCloudIdleContinueSchedules(userRow = null) {
  if (!cloudRelayReady()) return { ok: false, skipped: true, reason: 'disabled' };
  const user = userRow || await ensureDefaultUser();
  const chats = await listChatsForUser(user.id).catch(() => []);
  const ownedChatIds = new Set(chats.map((chat) => String(chat?.id || '')).filter(Boolean));
  if (await isVirtualTimeUser(user.id)) {
    let cancelled = 0;
    for (const taskKey of Object.keys(scheduleRevisions())) {
      const chatId = String(taskKey || '').replace(/^chat-idle:/, '').trim();
      if (!taskKey.startsWith('chat-idle:') || !ownedChatIds.has(chatId)) continue;
      forgetScheduleRevision(taskKey);
      await cancelGenerationRelaySchedule(taskKey).catch(() => {});
      cancelled += 1;
    }
    return { ok: false, skipped: true, reason: 'virtual-time-local-only', cancelled };
  }
  const worldNow = await getNowForUser(user.id);
  const wanted = new Map();
  for (const chat of chats) {
    if (!chat?.id || chat.type === 'group' || isAllMutedGroup(chat)) continue;
    const settings = await resolveEffectiveIdleContinueSettings(chat, user.id).catch(() => null);
    if (!settings?.enabled) continue;
    const characterId = characterIdForAutonomyChat(chat);
    if (characterId) {
      const timeZone = await resolveCharacterScheduleTimezone(user.id, characterId).catch(() => '');
      if (await isCharacterAutonomyMutedNow(user.id, characterId, worldNow, { timeZone })) continue;
      try {
        const { resolveCharacterAutonomousMessageBlock } = await import('./character-phone-proactive.js');
        const block = await resolveCharacterAutonomousMessageBlock(
          user.id,
          characterId,
          chat.id,
          worldNow,
        );
        if (block?.blocked) continue;
      } catch (_) { /* 门禁读不到时不阻断其它会话的排程同步 */ }
    }
    const messages = await listMessagesForChat(chat.id).catch(() => []);
    const verdict = evaluateIdleContinueDue({
      settings,
      messages,
      chatId: chat.id,
      // 云端排程：若尚未记下「停止输入」时刻，用用户消息时间先占位；
      // 真正回前台对账时仍会再校验 composer 状态与撞车。
      allowMessageFallback: true,
    });
    // 只要还在等用户回复，就排计划；已回复则不上传。
    if (!verdict.anchor?.timestamp) continue;
    const dueAt = Number(verdict.dueAt) || (verdict.anchor.timestamp + settings.intervalMs);
    wanted.set(`chat-idle:${chat.id}`, {
      chat,
      dueAt,
      sceneDirective: [
        '对方刚才发过消息后停了一小会儿，现在按你的人格自然接上话。',
        '不要提系统、定时器、后台或“自动回复”；也不要责怪对方没立刻回。',
      ].join('\n'),
    });
  }
  const known = scheduleRevisions();
  let uploaded = 0;
  const { getCharacterProactiveUsageStatus } = await import('./character-proactive-usage.js');
  for (const taskKey of Object.keys(known)) {
    const chatId = String(taskKey || '').replace(/^chat-idle:/, '').trim();
    if (taskKey.startsWith('chat-idle:') && ownedChatIds.has(chatId) && !wanted.has(taskKey)) {
      forgetScheduleRevision(taskKey);
      await cancelGenerationRelaySchedule(taskKey).catch(() => {});
    }
  }
  for (const [taskKey, item] of wanted) {
    const characterId = characterIdForAutonomyChat(item.chat);
    const usage = characterId
      ? await getCharacterProactiveUsageStatus(user.id, characterId).catch(() => null)
      : null;
    if (usage && usage.remaining <= 0) {
      forgetScheduleRevision(taskKey);
      await cancelGenerationRelaySchedule(taskKey).catch(() => {});
      continue;
    }
    const revision = Date.now();
    const runAt = Math.max(Date.now() + MIN_SCHEDULE_LEAD_MS, item.dueAt);
    const compiled = await compileChatRequest(item.chat, user, {
      allowInactive: true,
      contextNow: runAt,
      sceneDirective: item.sceneDirective,
    }).catch(() => null);
    if (!compiled?.ok) continue;
    const result = await upsertGenerationRelaySchedule({
      taskKey,
      taskType: 'idle-continue',
      revision,
      runAt,
      intervalMs: null,
      request: compiled.request,
      upstream: compiled.upstream,
      requestTtlSeconds: 900,
      resultTtlSeconds: 7 * 24 * 60 * 60,
    }).catch(() => null);
    if (result?.ok !== false) {
      rememberScheduleRevision(taskKey, revision);
      trackScheduleRunAt(taskKey, runAt);
      uploaded += 1;
    }
  }
  return { ok: true, uploaded, tracked: wanted.size };
}

async function applyIdleContinueEvent(event, user) {
  if (await isVirtualTimeUser(user.id)) {
    return { ok: false, skipped: true, reason: 'virtual-time-local-only' };
  }
  const chatId = String(event?.taskKey || '').replace(/^chat-idle:/, '').trim();
  if (!chatId) return { ok: false, reason: 'missing-chat-id' };
  const latestRevision = Number(scheduleRevisions()[String(event.taskKey)] || 0);
  if (latestRevision && Number(event.revision || 0) < latestRevision) {
    return { ok: false, skipped: true, reason: 'stale-revision' };
  }
  forgetScheduleRevision(String(event.taskKey));
  if (event.status !== 'succeeded' || !event.result) {
    return { ok: false, reason: event?.error?.message || event.status || 'failed' };
  }
  const chat = await getChat(chatId);
  const settings = chat ? await resolveEffectiveIdleContinueSettings(chat, user.id) : null;
  if (!chat || !settings?.enabled || isAllMutedGroup(chat)) {
    return { ok: false, reason: 'chat-no-longer-active' };
  }
  const characterId = characterIdForAutonomyChat(chat);
  if (characterId) {
    const [worldNow, timeZone] = await Promise.all([
      getNowForUser(user.id),
      resolveCharacterScheduleTimezone(user.id, characterId).catch(() => ''),
    ]);
    if (await isCharacterAutonomyMutedNow(user.id, characterId, worldNow, { timeZone })) {
      return { ok: false, skipped: true, reason: 'mute-hours' };
    }
    try {
      const { resolveCharacterAutonomousMessageBlock } = await import('./character-phone-proactive.js');
      const block = await resolveCharacterAutonomousMessageBlock(
        user.id,
        characterId,
        chat.id,
        worldNow,
      );
      if (block?.blocked) {
        return { ok: false, skipped: true, reason: block.reason || 'soft-offline' };
      }
    } catch (_) { /* 门禁读不到时沿用后续线下会话校验 */ }
  }
  if (characterId) {
    try {
      const { isCharacterBusyInOfflineSession } = await import('./character-phone-proactive.js');
      if (await isCharacterBusyInOfflineSession(user.id, characterId)) {
        return { ok: false, skipped: true, reason: 'active-offline-session' };
      }
    } catch (_) { /* 线下态读不到时不阻塞落库 */ }
  }
  const existing = await listMessagesForChat(chatId);
  if (hasUserMessageAfter(existing, Number(event.revision || 0))) {
    return { ok: false, skipped: true, reason: 'user-message-collision' };
  }
  // 落库前最后一条若已不是用户消息，说明本地/别处已经回过了。
  const stillWaiting = evaluateIdleContinueDue({
    settings,
    messages: existing,
    chatId,
    allowMessageFallback: true,
  });
  if (!stillWaiting.anchor) {
    return { ok: false, skipped: true, reason: 'already-replied' };
  }
  const rawText = completionText(event.result).trim();
  if (!rawText) return { ok: false, reason: 'empty-result' };
  const aiRoundId = `cloud_${String(event.id || '').replace(/[^\w-]/g, '')}`;
  if (existing.some((message) => message?.metadata?.aiRoundId === aiRoundId)) {
    return { ok: true, skipped: true, reason: 'already-applied' };
  }
  const preparedResult = await prepareHeadlessChatReply(chat, user, {
    reason: 'cloud-result',
    skipBusyAutoReply: false,
    allowInactive: true,
    baseTimestamp: event.scheduledFor ? Date.parse(event.scheduledFor) : Date.now(),
  });
  if (!preparedResult?.ok || !preparedResult.prepared) {
    return { ok: false, reason: preparedResult?.reason || 'prepare-failed' };
  }
  const timestamp = event.scheduledFor ? Date.parse(event.scheduledFor) : Date.now();
  const autonomyGuard = acquireCharacterAutonomyGuard({
    userId: user.id,
    characterId: characterIdForAutonomyChat(chat),
    chatId,
  });
  if (!autonomyGuard) return { ok: false, skipped: true, reason: 'autonomy-guard' };
  let result;
  try {
    result = await persistCloudProactiveTurn({
      rawText,
      prepared: preparedResult.prepared,
      userId: user.id,
      characterId,
      chatId,
      channel: 'idle-continue',
      event,
      timestamp,
      aiRoundId,
    });
  } finally {
    releaseCharacterAutonomyGuard(autonomyGuard, { generated: !!result?.ok });
  }
  if (!result?.ok) return result;
  await notifyHeadlessChatIfEnabled(chat, result, {
    reason: 'cloud-scheduled',
  }).catch(() => {});
  window.dispatchEvent?.(new CustomEvent('background-trigger', {
    detail: {
      chatId,
      result,
      generated: true,
      reason: 'idle-continue',
      at: Date.now(),
    },
  }));
  return result;
}

/** 拉取 Worker 已完成任务并使用本地协议幂等落库。 */
export async function reconcileCloudBackgroundEvents(reason = 'foreground') {
  if (!cloudRelayReady()) return { ok: false, skipped: true, reason: 'disabled' };
  const activeUser = await ensureDefaultUser();
  const activeSlotUsers = await listUsersInSlot(activeUser.id);
  const activeSlotUserIds = new Set(activeSlotUsers.map((user) => String(user?.id || '')).filter(Boolean));
  const cursorScopeId = resolveCloudEventCursorScopeId(activeUser);
  const cursorBefore = eventCursor(cursorScopeId);
  const page = await listGenerationRelayEvents({ after: cursorBefore });
  const applied = [];
  const refreshChatIds = new Set();
  let cursorBlocked = false;
  for (const event of page.events || []) {
    if (event.appliedAt) {
      applied.push({
        id: event.id,
        taskType: event.taskType,
        ok: true,
        skipped: true,
        reason: 'already-acknowledged',
        disposition: 'already-acknowledged',
      });
      continue;
    }
    const rawTaskKey = String(event.taskKey || '');
    let eventChatId = '';
    if (event.taskType === 'chat-auto') {
      eventChatId = rawTaskKey.replace(/^chat-auto:/, '').trim();
    } else if (event.taskType === 'idle-continue') {
      eventChatId = rawTaskKey.replace(/^chat-idle:/, '').trim();
    } else if (event.taskType === 'delayed-reply') {
      const body = rawTaskKey.replace(/^chat-delay:/, '');
      const splitAt = body.lastIndexOf(':');
      eventChatId = splitAt > 0 ? body.slice(0, splitAt).trim() : '';
    }
    let eventChat = null;
    if (eventChatId) {
      try {
        eventChat = await getChat(eventChatId);
      } catch (error) {
        cursorBlocked = true;
        applied.push({
          id: event.id,
          taskType: event.taskType,
          ok: false,
          retryable: true,
          failureClass: 'retryable-local-apply',
          reason: 'local-apply-failed',
          detail: String(error?.message || error || '').slice(0, 240),
          disposition: 'retryable-local-apply',
        });
        continue;
      }
    }
    if (eventChatId && !eventChat) {
      // 这里只能确定“当前本地库暂时看不到目标会话”，不能区分用户已删除、
      // 数据库尚未恢复或同一中继令牌来自另一安装。没有 durable tombstone 前
      // 不替潜在目标设备 ACK；Worker 结果留到 TTL，也不会重新调用模型。
      cursorBlocked = true;
      applied.push({
        id: event.id,
        taskType: event.taskType,
        ok: false,
        retryable: true,
        failureClass: 'retryable-local-apply',
        reason: 'unresolved-event-scope',
        disposition: 'retryable-local-apply',
      });
      continue;
    }
    if (eventChat?.userId && !activeSlotUserIds.has(String(eventChat.userId))) {
      // 游标按档位隔离：当前档位可以越过这条，但绝不能替另一档 ACK。
      // 切换到目标档位后，它会用自己的游标重新拉取并应用同一 Worker 结果。
      applied.push({
        id: event.id,
        taskType: event.taskType,
        ok: false,
        skipped: true,
        deferred: true,
        reason: 'inactive-user-slot',
        disposition: 'foreign-slot',
      });
      continue;
    }
    const user = eventChat?.userId ? await getUserById(eventChat.userId) : activeUser;
    if (!user) {
      cursorBlocked = true;
      applied.push({
        id: event.id,
        taskType: event.taskType,
        ok: false,
        retryable: true,
        failureClass: 'retryable-local-apply',
        reason: 'missing-event-user',
        disposition: 'retryable-local-apply',
      });
      continue;
    }
    let result = { ok: false, reason: 'unsupported-task-type' };
    try {
      if (event.taskType === 'chat-auto') {
        result = await applyChatAutoEvent(event, user);
        const chatId = String(event.taskKey || '').replace(/^chat-auto:/, '').trim();
        if (chatId) refreshChatIds.add(chatId);
      } else if (event.taskType === 'delayed-reply') {
        result = await applyDelayedReplyEvent(event, user);
      } else if (event.taskType === 'idle-continue') {
        result = await applyIdleContinueEvent(event, user);
      }
    } catch (error) {
      result = {
        ok: false,
        retryable: true,
        failureClass: 'retryable-local-apply',
        reason: 'local-apply-failed',
        detail: String(error?.message || error || '').slice(0, 240),
      };
    }
    const disposition = resolveCloudEventDisposition({ event, result });
    let ackFailed = false;
    if (disposition.acknowledge) {
      try {
        await acknowledgeGenerationRelayEvent(event.id);
      } catch (error) {
        ackFailed = true;
        cursorBlocked = true;
        result = {
          ...result,
          retryable: true,
          failureClass: 'retryable-local-apply',
          reason: 'ack-failed',
          detail: String(error?.message || error || '').slice(0, 240),
        };
      }
    } else if (disposition.blocksCursor) {
      cursorBlocked = true;
    }
    applied.push({
      id: event.id,
      taskType: event.taskType,
      ...result,
      disposition: ackFailed ? 'ack-retry' : disposition.outcome,
    });
  }
  if (!cursorBlocked) saveEventCursor(page.cursor, cursorScopeId);
  // 一页内同一旧 revision 可能积了多条结果；首条成功结果会立即抬高 revision 水位，
  // 后续同批结果按 stale 丢弃。全部确认后，再用只包含首条的新对话编译下一次计划。
  for (const chatId of refreshChatIds) {
    const chat = await getChat(chatId).catch(() => null);
    if (chat) {
      const scheduleUser = await getUserById(chat.userId).catch(() => null) || activeUser;
      const synced = await syncCloudAutoChatSchedule(chat, scheduleUser).catch(() => null);
      if (!synced?.ok) forgetScheduleRevision(`chat-auto:${chatId}`);
    }
  }
  // 延时回复计划全量对齐：已消费/作废的取消，仍在排队的用最新上下文重编译。
  await syncCloudDelayedReplySchedules(activeUser).catch(() => {});
  await syncCloudIdleContinueSchedules(activeUser).catch(() => {});
  return {
    ok: true,
    reason,
    checked: page.events?.length || 0,
    applied,
    retryPending: cursorBlocked,
    cursorAdvanced: !cursorBlocked,
  };
}
