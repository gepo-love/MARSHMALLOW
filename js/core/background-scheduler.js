import { isAllMutedGroup } from '../models/chat.js';
import { getChat, listChatsForUser, listMessagesForChat, saveChat } from './chat-store.js';
import { ensureDefaultUser, getUserById, listUsersInSlot } from './user-slot.js';
import { get as dbGet, put as dbPut } from './db.js';
import { runHeadlessChatReply } from './chat/headless-reply.js';
import { isChatStreaming } from './chat/chat-stream-session.js';
import { installReplyIntentOutboxRecovery } from './chat/reply-intent-outbox.js';
import { showToast } from '../components/toast.js';
import {
  CHARACTER_PHONE_PROACTIVE_CHECK_MS,
  runCharacterPhoneProactiveCheck,
} from './character-phone-proactive.js';
import {
  SHARE_IMPULSE_PROACTIVE_CHECK_MS,
  runShareImpulseProactiveCheck,
} from './share-impulse-proactive.js';
import { scanTravelCharNotifications } from './travel-char.js';
import {
  pruneAllExpiredCharacterPhoneSchedules,
  dateKeyFromTimestamp,
} from './character-phone-store.js';
// getPacingNowForUser：节奏钟，时间债追平期间不冻结（冷却/到期判断用）；getNowForUser：世界钟（日期键/时间戳用）。
import {
  getNowForUser,
  getPacingNowForUser,
  getTimeMode,
  TIME_MODE_VIRTUAL,
} from './time-mode.js';
import {
  notifyHeadlessChatIfEnabled,
  notifyBackgroundMessageIfEnabled,
  showMessageNotification,
} from './native-notifications.js';
import { runMemoProactiveCheck } from './chat/memo-proactive.js';
import { runRadioPlanCheck } from './chat/radio-plan-proactive.js';
import {
  PENDING_ACTION_CHECK_MS,
  runPendingChatActions,
} from './chat/pending-actions.js';
import {
  IDLE_CONTINUE_CHECK_MS,
  scanIdleContinueReplies,
} from './chat/idle-continue-reply.js';
import { runPeriodProactiveCheck } from './chat/period-proactive.js';
import {
  MEITUAN_COUPON_REMINDER_CHECK_MS,
  runMeituanCouponReminderCheck,
} from './meituan-coupon-reminder.js';
import {
  DRIFT_BOTTLE_PROACTIVE_CHECK_MS,
  getDriftBottleScanIntervalMs,
  runDriftBottleProactiveCheck,
} from './chat/drift-bottle-proactive.js';
import {
  MAILBOX_PROACTIVE_CHECK_MS,
  runMailboxProactiveCheck,
} from './mailbox-ai.js';
import { tickCompanion, initCompanionRuntime, COMPANION_TICK_MS } from './companion/companion-runtime.js';
import { getCharacter, listCharacters } from './character-store.js';
import {
  buildProactiveConversationDirective,
  planProactiveConversation,
} from './proactive-conversation-plan.js';
import { buildProactiveAntiRepeatDirective } from './chat-helpers.js';
import { listInterestEntries, loadInterestTrackingSettings } from './character-interest-table.js';
import { runDailyInterestRotationForCharacter } from './interest-search-orchestrator.js';
import { syncInterestProgressFromSchedule } from './interest-schedule-progress.js';
import { loadWebSearchConfig } from './web-search-tools.js';
import { loadSocialLinkConfig } from './social-link-tools.js';
import { checkUserSocialUpdates, loadUserSocialWatchSettings } from './user-social-watch.js';
import { loadCharacterPhoneAutoSettings, isDailyLifeAutoEnabled } from './character-phone-store.js';
import { ensureDailyLifePlan } from './character-daily-life.js';
import {
  DAILY_SCHEDULE_ATTEMPT_STATUS,
  DAILY_SCHEDULE_GEN_STATE_VERSION,
  beginDailyScheduleAttempt,
  isDailyScheduleAttemptEligible,
  normalizeDailyScheduleGenerationState,
  settleDailyScheduleFailure,
} from './background-daily-schedule-retry.js';
import {
  MOMENTS_AUTO_CHECK_MS,
  runMomentsAutoCheck,
  initMomentsPostChatTrigger,
} from './moments/moments-auto.js';
import {
  FORUM_AUTO_CHECK_MS,
  runForumAutoCheck,
} from './forum/forum-auto.js';
import { initUserMomentRealPersonFollowup } from './moments/user-moment-real-person.js';
import {
  USER_INTERCEPT_AUTO_CHECK_MS,
  runUserInterceptAutoCheck,
} from './user-intercept-auto.js';
import { isNativeShell } from './native-update-bridge.js';
import {
  hasCloudScheduledTask,
  isCloudScheduledBackgroundEnabled,
} from './generation-relay.js';
import { initNativeBackgroundWake } from './native-background-wake.js';
import { isUserRecentlyActive } from './user-activity.js';
import {
  CHARACTER_PHONE_CHAT_CHECK_MS,
  runCharacterPhoneChatSchedulerCheck,
} from './character-phone-chat-scheduler.js';
import {
  captureMediaGesture,
  waitForAudioCanPlay,
  isForegroundMediaActive,
  clearMediaSession,
  useAmbientAudioSession,
  useForegroundAudioSession,
} from './media-playback.js';
import {
  acquireCharacterAutonomyGuard,
  characterIdForAutonomyChat,
  isTemporaryAutonomySkipReason,
  loadResolvedCharacterAutonomyPolicy,
  releaseCharacterAutonomyGuard,
  resolveAutonomyTrigger,
} from './character-autonomy-settings.js';
import {
  buildFixedFallbackFailurePatch,
  clearFixedFallbackFailurePatch,
  getFixedFallbackFailureBackoff,
  isFixedFallbackRetryableFailure,
  isFixedFallbackTerminalFailure,
  isFixedFallbackChatEligible,
  selectDueFixedFallbackChats,
} from './fixed-fallback-policy.js';
import {
  createBackgroundLeaderElection,
  getBackgroundTaskLedger,
  recordBackgroundCheckpoint,
  runPersistedBackgroundTask,
} from './background-task-runtime.js';
import {
  backfillVectorSources,
  drainVectorBacklogBatches,
  getMemoryVectorIndexStats,
  MEMORY_VECTOR_BACKLOG_EVENT,
  publishMemoryVectorBacklogState,
} from './memory/memory-vectors.js';

export { markUserActivity } from './user-activity.js';

const KEEPALIVE_SETTINGS_KEY = 'backgroundKeepAlive';

async function listCurrentSlotBackgroundUsers() {
  const active = await ensureDefaultUser();
  const linked = await listUsersInSlot(active.id).catch(() => [active]);
  const byId = new Map((Array.isArray(linked) ? linked : [])
    .filter((user) => user?.id)
    .map((user) => [String(user.id), user]));
  byId.set(String(active.id), active);
  return [
    active,
    ...[...byId.values()].filter((user) => String(user.id) !== String(active.id)),
  ];
}

async function runForCurrentSlotUsers(run) {
  const users = await listCurrentSlotBackgroundUsers();
  const perUser = [];
  for (const user of users) {
    try {
      perUser.push({ userId: user.id, result: await run(user) });
    } catch (error) {
      perUser.push({ userId: user.id, result: { ok: false, reason: error?.message || String(error || 'failed') } });
    }
  }
  return {
    ok: perUser.every((entry) => entry.result?.ok !== false),
    processedUsers: perUser.length,
    perUser,
  };
}
// 保活开关涉及系统音轨，不能只依赖可能在 pagehide 时被中断的异步 IndexedDB 事务。
// shadow 永久保留最后一次用户意图，pending 在数据库写成功后删除。这样既能从中断
// 写入恢复，也能防止另一个旧标签页稍后用陈旧 IndexedDB 值把关闭状态重新覆盖。
const KEEPALIVE_PENDING_STORAGE_KEY = 'mm_background_keepalive_pending_v1';
const KEEPALIVE_SHADOW_STORAGE_KEY = 'mm_background_keepalive_shadow_v1';
const SCHEDULE_PRUNE_STATE_KEY = 'schedulePruneLastRun';
const INTEREST_ROTATION_STATE_KEY = 'interestRotationState';
const INTEREST_ROTATION_DEBUG_KEY = 'interestRotationDebugStatus';
const DAILY_SCHEDULE_GEN_STATE_KEY = 'dailyScheduleGenState';
const TRAVEL_CHAR_NOTIFY_CHECK_MS = 60 * 1000;
const MEMO_PROACTIVE_CHECK_MS = 60 * 1000;
const PERIOD_PROACTIVE_CHECK_MS = 60 * 60 * 1000;
/** 运行时扫描间隔；启动/用户改设置时由 getDriftBottleScanIntervalMs 刷新 */
let driftBottleCheckMs = DRIFT_BOTTLE_PROACTIVE_CHECK_MS;
const SCHEDULE_PRUNE_CHECK_MS = 60 * 60 * 1000;
// 「每天后台自动生成日程」探测频率：真正的生成一天只会成功一次（按 dateKey 状态去重），
// 这里只是「醒来看一眼今天有没有该开开关的角色还没生成」，没有才会真的调一次 AI。
const DAILY_SCHEDULE_GEN_CHECK_MS = 30 * 60 * 1000;
const INTEREST_ROTATION_CHECK_MS = 2 * 60 * 60 * 1000; // 每 2 小时探一次，具体轮转按「每个角色独立冷却」节流
const INTEREST_PROGRESS_SYNC_CHECK_MS = 15 * 60 * 1000;
// 每个角色各自独立算「离上次轮转够不够久」，不是全局一天只跑一次——之前是全局按天去重，
// 开了追踪的角色一起抢同一份"今天的名额"，角色一多有的排不上号、隔好几天才轮到一次。
// 现在每个角色的冷却时长按自己在兴趣页设置的 autoTrackIntervalHours 走（默认 12 小时），
// 这个常量只在设置读取失败时兜底用。
const INTEREST_ROTATION_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;
const INTEREST_ROTATION_MAX_PER_TICK = 6; // 单次探测最多同时处理几个角色，避免一次探测就把搜索接口打爆
// 只开「分享真实帖子精搜」没开「后台自动追踪」的角色，用更短的固定周期检查补货缺口——
// 不跟着 autoTrackIntervalHours（默认 12h，用户可能压根没调过）走，否则 shareDailyTarget
// 攒够要等好几天，跟用户设置的"每天最多分享几条"字面意思差太远。
const SHARE_ONLY_REFILL_INTERVAL_HOURS = 6;
// 「TA 关注你的小红书」本身就是单角色一天最多查一次（内部冷却在 checkUserSocialUpdates 里），
// 不需要贴兴趣轮转那么密的探测粒度，单独给一个更省电的间隔。
const USER_SOCIAL_WATCH_CHECK_MS = 6 * 60 * 60 * 1000;
const MEMORY_EMBED_BACKLOG_CHECK_MS = 15 * 60 * 1000;
const MEMORY_EMBED_WAKE_DEBOUNCE_MS = 1200;
// 向量积压只能在安静后台慢慢追，不能每 1.8 秒连续抢占移动端页面。
const MEMORY_EMBED_FOLLOWUP_MS = 30_000;
const CATCH_UP_COOLDOWN_MS = 45 * 1000;
const WORKER_HEARTBEAT_MS = 15 * 1000;
// 「仅生成期间」档：生成结束后音轨再保留一小段，覆盖落库、连锁触发的下一轮生成；
// 也用作生成开始前借手势预热音轨的武装窗口。
const GENERATION_KEEPALIVE_GRACE_MS = 45 * 1000;
// 手势解锁仍使用 media-playback.js 内置的短 WAV；真正后台循环改用 30 秒独立音轨，
// 避免 iOS 每 0.5 秒跨一次 loop 边界。音轨是 ±1 PCM 的近静音而非全零采样，
// 降低系统把纯数字静音识别为「无有效媒体」并主动挂起的概率。两者统一为 48kHz，
// 避免真实语音接管同一媒体会话时残留 8kHz 窄带输出管线。
const SILENT_KEEPALIVE_AUDIO_URL = new URL(
  '../../assets/audio/silent-keepalive.wav',
  import.meta.url,
).href;

const timers = new Map();
const deferredAutoChatTimers = new Map();
const inFlight = new Set();
const lastTriggered = new Map();
const AUTO_CHAT_DEFERRED_RETRY_MS = 4000;

let worker = null;
let workerUrl = '';
let keepAliveConfig = {
  enabled: false,
  keepAwake: false,
  silentAudio: false,
  silentAudioMode: 'generation',
  notifyOnAutoChat: false,
};
let keepAlivePersistQueue = Promise.resolve();
let keepAlivePersistRevision = 0;
let wakeLock = null;
let silentAudio = null;
let silentAudioGesture = null;
let silentAudioRetryTimer = 0;
let silentAudioWatchTimer = null;
let silentAudioStartPromise = null;
let silentAudioStartVersion = 0;
let silentKeepAliveSuspended = false;
let silentAudioPageSuspended = false;
/** stop/destroy 期间为 true，避免 pause/emptied 把刚拆掉的音轨又自动拉起。 */
let silentAudioIntentionalStop = false;
/** pagehide(非 bfcache) 后为 true，阻止随后的 visibilitychange 把音轨又拉起来。 */
let silentAudioPageUnloading = false;
/** 后台被系统反复 pause 时的退避：防止灵动岛/控制中心进度条来回闪。 */
let silentAudioPauseStrike = 0;
let silentAudioPauseStrikeResetTimer = 0;
let silentAudioCoolingUntil = 0;
let silentAudioProbeElement = null;
let silentAudioProbeTime = -1;
let silentAudioStalledChecks = 0;
const SILENT_AUDIO_WATCH_INTERVAL_MS = 12_000;
const SILENT_AUDIO_STALL_LIMIT = 2;
const SILENT_AUDIO_PROGRESS_EPSILON = 0.05;
const SILENT_AUDIO_HEALTH_STALE_MS = SILENT_AUDIO_WATCH_INTERVAL_MS * 3;
// 音量给一点点余量（而不是 0.001）：音轨只有 ±1 PCM 近静音，人耳听不出差别，
// 但更接近已验证可行的参考实现的取值，避免个别机型把过低音量判定为"等同静音/未播放"。
const SILENT_KEEPALIVE_VOLUME = 0.01;
// 最近一次确认「真的在播放」的时间点：系统媒体控制/通知栏图标在 iOS、Android 上都不保证
// 稳定显示，这个时间戳是给设置页展示的、独立于系统 UI 的自证据——只要它随时间持续前进，
// 就说明静音音频没有被系统悄悄掐断。
let silentAudioLastConfirmedAt = 0;
let silentAudioConfirmedPlayCount = 0;
let phoneTimer = null;
let phoneTickInFlight = false;
let phoneChatTimer = null;
let phoneChatTickInFlight = false;
let travelTimer = null;
let travelTickInFlight = false;
let memoTimer = null;
let memoTickInFlight = false;
let pendingActionTimer = null;
let pendingActionTickInFlight = false;
let idleContinueTimer = null;
let idleContinueTickInFlight = false;
let userInterceptTimer = null;
let periodTimer = null;
let periodTickInFlight = false;
let meituanCouponTimer = null;
let meituanCouponTickInFlight = false;
let mailboxProactiveTimer = null;
let mailboxProactiveTickInFlight = false;
let driftBottleTimer = null;
let driftBottleTickInFlight = false;
let schedulePruneTimer = null;
let schedulePruneInFlight = false;
let interestRotationTimer = null;
let interestRotationInFlight = false;
let interestProgressSyncTimer = null;
let interestProgressSyncInFlight = false;
let userSocialWatchTimer = null;
let userSocialWatchInFlight = false;
let shareImpulseProactiveTimer = null;
let shareImpulseProactiveInFlight = false;
let dailyScheduleGenTimer = null;
let dailyScheduleGenInFlight = false;
let momentsAutoTimer = null;
let forumAutoTimer = null;
let memoryEmbedTimer = null;
let memoryEmbedWakeTimer = 0;
let companionTickInFlight = false;
let catchUpInFlight = false;
let lastCatchUpAt = 0;
let initialized = false;
let nativeWakeBound = false;
let deferredCatchUpReason = '';
let deferredCatchUpTimer = 0;
let cloudScheduleRefreshTimer = 0;
let leaderElection = null;
let leaderActive = false;
let leaderMode = 'pending';
let workerLastHeartbeatAt = 0;
let workerLastTickAt = 0;
let lastCatchUpReason = '';
let lastCatchUpResult = null;
let lastLifecycleCheckpoint = null;

function isBackgroundLeader() {
  return !leaderElection || leaderActive;
}

function runTrackedBackgroundTask(taskId, intervalMs, reason, runner, options = {}) {
  if (!isBackgroundLeader()) {
    return Promise.resolve({ ok: false, skipped: true, reason: 'not-leader' });
  }
  return runPersistedBackgroundTask(taskId, runner, {
    intervalMs,
    ownerId: leaderElection?.ownerId || 'single-page',
    reason,
    ...options,
  });
}

function hasForegroundCriticalActivity() {
  const safety = globalThis.__mm_update_safety_state__ || {};
  return Number(safety.criticalCount || 0) > 0
    || Number(globalThis.__mm_chat_generation_active__ || 0) > 0
    || Number(globalThis.__mm_manual_generation_active__ || 0) > 0;
}

function shouldDeferHeavyBackgroundWork() {
  return generationSessionActive
    || hasForegroundCriticalActivity()
    || isUserRecentlyActive(12000);
}

function hasHeavyBackgroundWorkInFlight() {
  return inFlight.size > 0
    || phoneTickInFlight
    || phoneChatTickInFlight
    || travelTickInFlight
    || memoTickInFlight
    || pendingActionTickInFlight
    || idleContinueTickInFlight
    || periodTickInFlight
    || meituanCouponTickInFlight
    || mailboxProactiveTickInFlight
    || driftBottleTickInFlight
    || schedulePruneInFlight
    || interestRotationInFlight
    || interestProgressSyncInFlight
    || userSocialWatchInFlight
    || shareImpulseProactiveInFlight
    || dailyScheduleGenInFlight
    || companionTickInFlight
    || catchUpInFlight;
}

export async function waitForBackgroundWorkToSettle({
  timeoutMs = 12000,
  pollMs = 150,
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
  while (hasHeavyBackgroundWorkInFlight() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, Number(pollMs || 0))));
  }
  return !hasHeavyBackgroundWorkInFlight();
}

function scheduleDeferredCatchUp(reason = '') {
  if (typeof window === 'undefined') return;
  deferredCatchUpReason = String(reason || deferredCatchUpReason || 'deferred').trim() || 'deferred';
  if (deferredCatchUpTimer) return;
  deferredCatchUpTimer = window.setTimeout(() => {
    deferredCatchUpTimer = 0;
    const nextReason = deferredCatchUpReason;
    deferredCatchUpReason = '';
    if (shouldDeferHeavyBackgroundWork()) {
      scheduleDeferredCatchUp(nextReason);
      return;
    }
    catchUpBackgroundWork(nextReason).catch(() => {});
  }, 4000);
}

if (typeof globalThis !== 'undefined') {
  globalThis.__mm_wait_for_background_quiet__ = waitForBackgroundWorkToSettle;
}

function shouldRunBackgroundTick() {
  if (!isBackgroundLeader()) return false;
  if (typeof document === 'undefined') return true;
  if (!document.hidden) {
    // 前台定时器恰好撞上点按、滚动或输入时，不要在同一段主线程里启动整批
    // IndexedDB 扫描与模块解析。等用户安静后走统一 catch-up，既不丢到期任务，
    // 也避免按钮表现成“点了半天才有反应”。
    if (isUserRecentlyActive(4000)) {
      scheduleDeferredCatchUp('foreground-user-active');
      return false;
    }
    return true;
  }
  if (keepAliveConfig.enabled) return true;
  // APK 退后台时 JS 定时器会被系统挂起，靠原生 Alarm 补跑；这里对原生壳不再因 hidden 直接跳过。
  return isNativeShell();
}

function clearDeferredAutoChatRetry(chatId = '') {
  const id = String(chatId || '').trim();
  const retryTimer = deferredAutoChatTimers.get(id);
  if (retryTimer) window.clearTimeout(retryTimer);
  deferredAutoChatTimers.delete(id);
}

/**
 * 群聊自动推进到点时若正撞上用户操作/其它生成，只延后到用户安静后重试。
 * 不能直接等下一整个 autoInterval，否则 3 分钟档一次擦肩就会表现成 6 分钟甚至“没触发”。
 */
function scheduleDeferredAutoChatRetry(chatId = '', reason = '') {
  const id = String(chatId || '').trim();
  if (!id || typeof window === 'undefined' || deferredAutoChatTimers.has(id)) return;
  const retryTimer = window.setTimeout(() => {
    deferredAutoChatTimers.delete(id);
    // 已退到不允许本地后台运行的状态时交给回前台补跑；不绕过用户的保活设置。
    if (!shouldRunBackgroundTick()) return;
    if (shouldDeferHeavyBackgroundWork()) {
      scheduleDeferredAutoChatRetry(id, reason);
      return;
    }
    triggerAutoReply(id, `deferred:${String(reason || 'timer')}`).catch(() => {});
  }, AUTO_CHAT_DEFERRED_RETRY_MS);
  deferredAutoChatTimers.set(id, retryTimer);
}

function normalizeKeepAliveConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  // silentAudioMode 是后加的字段。旧版本里已经开着静音保活的用户按「常驻」迁移，
  // 保住他们后台自动消息的既有行为；其余默认「仅生成期间」——音轨只在生成时占用，
  // iOS 清后台后控制中心残留播放条的概率随暴露时长一起降下来。
  const silentAudioMode = src.silentAudioMode === 'always' || src.silentAudioMode === 'generation'
    ? src.silentAudioMode
    : (src.silentAudio === true ? 'always' : 'generation');
  return {
    enabled: src.enabled === true,
    keepAwake: src.keepAwake === true,
    silentAudio: src.silentAudio === true,
    silentAudioMode,
    notifyOnAutoChat: src.notifyOnAutoChat === true,
  };
}

function parseKeepAlivePendingSnapshot(raw = '') {
  try {
    const parsed = JSON.parse(String(raw || ''));
    if (!parsed || typeof parsed !== 'object' || !parsed.value || typeof parsed.value !== 'object') return null;
    return {
      id: String(parsed.id || '').trim(),
      value: normalizeKeepAliveConfig(parsed.value),
    };
  } catch (_) {
    return null;
  }
}

function readKeepAlivePendingSnapshot() {
  try {
    return parseKeepAlivePendingSnapshot(globalThis.localStorage?.getItem(KEEPALIVE_PENDING_STORAGE_KEY) || '');
  } catch (_) {
    return null;
  }
}

function readKeepAliveShadowSnapshot() {
  try {
    return parseKeepAlivePendingSnapshot(globalThis.localStorage?.getItem(KEEPALIVE_SHADOW_STORAGE_KEY) || '');
  } catch (_) {
    return null;
  }
}

function writeKeepAlivePendingSnapshot(value = {}, revision = 0) {
  try {
    const id = `${Date.now()}:${Number(revision || 0)}:${Math.random().toString(36).slice(2, 9)}`;
    const serialized = JSON.stringify({
      id,
      value: normalizeKeepAliveConfig(value),
    });
    // 先写长期 shadow；即使第二步 pending 因页面退出没来得及完成，最后意图仍不会丢。
    globalThis.localStorage?.setItem(KEEPALIVE_SHADOW_STORAGE_KEY, serialized);
    globalThis.localStorage?.setItem(KEEPALIVE_PENDING_STORAGE_KEY, serialized);
    return id;
  } catch (_) {
    return '';
  }
}

function clearKeepAlivePendingSnapshot(id = '') {
  if (!id) return;
  try {
    const current = readKeepAlivePendingSnapshot();
    if (current?.id === id) globalThis.localStorage?.removeItem(KEEPALIVE_PENDING_STORAGE_KEY);
  } catch (_) {
    // 无可用 localStorage 时仍以 IndexedDB 为准。
  }
}

async function persistKeepAliveConfig(patch = {}) {
  const nextPatch = patch && typeof patch === 'object' ? { ...patch } : {};
  const revision = ++keepAlivePersistRevision;
  // 先更新内存状态，让“关闭”立即阻断音轨；实际落盘必须串行，否则 iOS 上连续关两个
  // 开关时，两次并发 dbGet 都可能读到旧值，后完成的写入会把先关掉的开关重新带回 true。
  keepAliveConfig = normalizeKeepAliveConfig({ ...keepAliveConfig, ...nextPatch });
  const pendingId = writeKeepAlivePendingSnapshot(keepAliveConfig, revision);
  const write = keepAlivePersistQueue.then(async () => {
    // shadow 始终是所有页面最后一次明确操作的完整状态。旧标签页的排队写入即使晚到，
    // 也只会落这份最新快照，不会再把自己手里的旧 true 写回数据库。
    const shadow = readKeepAliveShadowSnapshot();
    const prevRaw = (await dbGet(KEEPALIVE_SETTINGS_KEY).catch(() => null))?.value || {};
    // 有 shadow 时它已经是包含所有开关的最新完整快照，不能再叠加本次可能已过时的 patch；
    // 没有 localStorage 时才回退到“数据库旧值 + 当前补丁”。
    const persisted = shadow?.value || normalizeKeepAliveConfig({
      ...normalizeKeepAliveConfig(prevRaw),
      ...nextPatch,
    });
    await dbPut({ key: KEEPALIVE_SETTINGS_KEY, value: persisted });
    clearKeepAlivePendingSnapshot(pendingId);
    return persisted;
  });
  keepAlivePersistQueue = write.catch(() => {});
  let persisted;
  try {
    persisted = await write;
  } catch (err) {
    // 同步日志已经落下时，保持用户刚刚选择的状态并等待下次读取补写；关闭音轨不应
    // 因一次瞬时 IDB 错误被撤销。localStorage 也不可用时才把错误交给调用方。
    if (!pendingId) throw err;
    console.warn('[background-scheduler] keepalive settings queued for recovery', err);
    return { ...keepAliveConfig };
  }
  // 新操作已经在等待时，不得用较早写入的结果覆盖它的即时状态。
  if (revision === keepAlivePersistRevision) keepAliveConfig = persisted;
  return { ...keepAliveConfig };
}

export async function getBackgroundKeepAliveSettings() {
  await keepAlivePersistQueue.catch(() => {});
  const row = await dbGet(KEEPALIVE_SETTINGS_KEY).catch(() => null);
  const pending = readKeepAlivePendingSnapshot();
  const shadow = readKeepAliveShadowSnapshot();
  keepAliveConfig = normalizeKeepAliveConfig(pending?.value || shadow?.value || row?.value || {});
  const stored = normalizeKeepAliveConfig(row?.value || {});
  const databaseNeedsRepair = JSON.stringify(stored) !== JSON.stringify(keepAliveConfig);
  if (pending || (shadow && databaseNeedsRepair)) {
    try {
      await dbPut({ key: KEEPALIVE_SETTINGS_KEY, value: keepAliveConfig });
      if (pending) clearKeepAlivePendingSnapshot(pending.id);
    } catch (err) {
      console.warn('[background-scheduler] keepalive settings recovery deferred', err);
    }
  }
  return { ...keepAliveConfig };
}

function nativeKeepAlivePlugin() {
  if (typeof window === 'undefined') return null;
  const plugins = window.Capacitor?.Plugins || {};
  return plugins.MarshmallowKeepAlive || plugins.GloryKeepAlive || null;
}

async function startNativeKeepAlive() {
  const plugin = nativeKeepAlivePlugin();
  if (!plugin?.start) return { ok: false, reason: 'no-native-bridge' };
  try {
    return await plugin.start({
      title: '棉花糖机后台活跃中',
      body: '主动消息会尽量保持运行，回到前台后会补跑遗漏任务。',
    });
  } catch (err) {
    console.warn('[background-scheduler] native keepalive start failed', err);
    return { ok: false, error: err?.message || String(err || '') };
  }
}

async function stopNativeKeepAlive() {
  const plugin = nativeKeepAlivePlugin();
  if (!plugin?.stop) return { ok: false, reason: 'no-native-bridge' };
  try {
    return await plugin.stop();
  } catch (err) {
    console.warn('[background-scheduler] native keepalive stop failed', err);
    return { ok: false, error: err?.message || String(err || '') };
  }
}

export async function getNativeKeepAliveStatus() {
  const plugin = nativeKeepAlivePlugin();
  if (!plugin?.getStatus) return { native: false };
  try {
    return await plugin.getStatus();
  } catch (err) {
    return { native: true, error: err?.message || String(err || '') };
  }
}

export async function openNativeBatterySettings() {
  const plugin = nativeKeepAlivePlugin();
  if (!plugin?.openBatterySettings) return { ok: false, reason: 'no-native-bridge' };
  return plugin.openBatterySettings();
}

async function requestWakeLock() {
  if (!keepAliveConfig.enabled || !keepAliveConfig.keepAwake) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (wakeLock || !navigator?.wakeLock?.request) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      if (keepAliveConfig.enabled && keepAliveConfig.keepAwake && !document.hidden) {
        requestWakeLock().catch(() => {});
      }
    });
  } catch (err) {
    console.warn('[background-scheduler] wake lock failed', err);
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try {
    await wakeLock.release();
  } catch (_) {
    // ignore
  }
  wakeLock = null;
}

function attachSilentAudioToDom(audio) {
  if (!audio || typeof document === 'undefined') return;
  let host = document.getElementById('marshmallow-silent-keepalive-audio');
  if (!host) {
    host = document.createElement('div');
    host.id = 'marshmallow-silent-keepalive-audio';
    host.setAttribute('aria-hidden', 'true');
    host.hidden = true;
    host.style.display = 'none';
    document.body.appendChild(host);
  }
  if (!audio.isConnected) host.appendChild(audio);
}

/** 设置页展示用：记一次「刚确认过是真的在播放」，独立于系统媒体控制/通知栏图标是否显示。 */
function markSilentAudioConfirmed() {
  silentAudioLastConfirmedAt = Date.now();
  silentAudioConfirmedPlayCount += 1;
  notifyKeepAliveRuntimeChanged();
}

function resetSilentAudioProgressProbe(audio = null) {
  silentAudioProbeElement = audio;
  silentAudioProbeTime = -1;
  silentAudioStalledChecks = 0;
}

/** paused=false 只能说明元素自认为在播；必须看到 currentTime 前进，才算系统输出管线仍存活。 */
function confirmSilentAudioProgress(audio) {
  if (!audio || audio.paused || audio.ended) return false;
  const currentTime = Number(audio.currentTime);
  if (!Number.isFinite(currentTime)) return false;
  if (silentAudioProbeElement !== audio || silentAudioProbeTime < 0) {
    silentAudioProbeElement = audio;
    silentAudioProbeTime = currentTime;
    silentAudioStalledChecks = 0;
    return false;
  }
  const moved = Math.abs(currentTime - silentAudioProbeTime) >= SILENT_AUDIO_PROGRESS_EPSILON;
  silentAudioProbeTime = currentTime;
  if (moved) {
    silentAudioStalledChecks = 0;
    markSilentAudioConfirmed();
    return true;
  }
  silentAudioStalledChecks += 1;
  return false;
}

function notifyKeepAliveRuntimeChanged() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent('marshmallow-keepalive-runtime-changed', {
      detail: getKeepAliveRuntimeStatus(),
    }));
  } catch (_) {
    // ignore
  }
}

function canScheduleSilentAudioResume() {
  return !!(
    isSilentAudioArmed()
    && !silentKeepAliveSuspended
    && !silentAudioPageSuspended
    && !silentAudioPageUnloading
    && !silentAudioIntentionalStop
    && !isForegroundMediaActive()
  );
}

function canAutoResumeSilentAudio() {
  return canScheduleSilentAudioResume() && Date.now() >= silentAudioCoolingUntil;
}

function noteSilentAudioInterrupted() {
  silentAudioPauseStrike += 1;
  if (silentAudioPauseStrikeResetTimer && typeof window !== 'undefined') {
    window.clearTimeout(silentAudioPauseStrikeResetTimer);
  }
  if (typeof window !== 'undefined') {
    silentAudioPauseStrikeResetTimer = window.setTimeout(() => {
      silentAudioPauseStrikeResetTimer = 0;
      silentAudioPauseStrike = 0;
    }, 30_000);
  }
  // 短时间被系统/控制中心反复打断：先彻底释放音轨冷却，避免灵动岛开开关关占死会话。
  if (silentAudioPauseStrike >= 3) {
    silentAudioCoolingUntil = Date.now() + 45_000;
    silentAudioPauseStrike = 0;
    stopSilentAudio({ destroy: true, clearSession: true });
    silentAudioIntentionalStop = false;
    scheduleSilentAudioRetry(45_000);
    return true;
  }
  return false;
}

function bindSilentAudioElementEvents(audio) {
  if (!audio || audio.dataset.keepAliveBound === '1') return;
  audio.dataset.keepAliveBound = '1';
  // 故意不在 pause 上立刻重试：iOS 控制中心/灵动岛的 pause 会直接打到 HTMLAudioElement，
  // 旧逻辑立刻 play 回去就会和系统抢会话，表现为进度条来回跳、清后台后仍占音轨。
  // 自愈只交给 watch 定时器与 ended/error 等真正中断事件。
  audio.addEventListener('pause', () => {
    notifyKeepAliveRuntimeChanged();
    if (!document.hidden || !canAutoResumeSilentAudio()) return;
    if (noteSilentAudioInterrupted()) return;
  });
  audio.addEventListener('ended', () => {
    if (!canAutoResumeSilentAudio()) return;
    scheduleSilentAudioRetry(800);
  });
  audio.addEventListener('stalled', () => {
    if (!canAutoResumeSilentAudio()) return;
    scheduleSilentAudioRetry(1500);
  });
  audio.addEventListener('error', () => {
    if (!canAutoResumeSilentAudio()) return;
    scheduleSilentAudioRetry(2500);
  });
  // emptied 常在我们自己 removeAttribute('src')/load() 时触发，绝不能当成「需要重拉」。
  audio.addEventListener('playing', () => {
    silentAudioPauseStrike = 0;
    resetSilentAudioProgressProbe(audio);
    updateSilentKeepAliveMediaSession(true);
    markSilentAudioConfirmed();
  });
}

function isSilentKeepAliveSrc(src) {
  const s = String(src || '');
  if (!s) return false;
  if (s === SILENT_KEEPALIVE_AUDIO_URL) return true;
  try {
    return new URL(s, SILENT_KEEPALIVE_AUDIO_URL).pathname.endsWith('/assets/audio/silent-keepalive.wav');
  } catch (_) {
    return /silent-keepalive\.wav(?:$|\?)/i.test(s);
  }
}

function configureSilentKeepAliveAudio(audio) {
  if (!audio) return audio;
  audio.dataset.marshmallowSilentKeepalive = '1';
  audio.loop = true;
  audio.preload = 'auto';
  audio.muted = false;
  audio.volume = SILENT_KEEPALIVE_VOLUME;
  audio.setAttribute('playsinline', 'true');
  audio.setAttribute('webkit-playsinline', 'true');
  // 用路径判断，避免 absolute/relative 或 ?v= 导致每次 configure 都 pause+reload 闪进度。
  if (!isSilentKeepAliveSrc(audio.src)) {
    try { audio.pause(); } catch (_) {}
    audio.src = SILENT_KEEPALIVE_AUDIO_URL;
  }
  attachSilentAudioToDom(audio);
  bindSilentAudioElementEvents(audio);
  return audio;
}

function consumeSilentAudioGesture() {
  const token = silentAudioGesture;
  silentAudioGesture = null;
  if (!token?.audio) return null;
  const audio = configureSilentKeepAliveAudio(token.audio);
  silentAudio = audio;
  return audio;
}

function clearSilentKeepAliveMediaSession() {
  if (isForegroundMediaActive()) return;
  clearMediaSession();
  // Media Session 与 iOS Audio Session 是两层状态。回到 ambient 才能保证短静音轨或
  // WebKit 残留会话不会继续以 playback 类型顶到灵动岛、暂停其它 App。
  useAmbientAudioSession();
}

function updateSilentKeepAliveMediaSession(active) {
  if (!active) {
    clearSilentKeepAliveMediaSession();
  }
  // 不再为静音保活注册 MediaSession。iOS 会把锁屏/控制中心的 pause 直接施加到底层
  // audio；旧实现随后又自动 retry，于是系统播放器和真实语音之间反复抢占，表现为
  // 「保活语音开开关关」，甚至页面被划掉后仍短暂残留。运行状态改由设置页自检展示。
}

function ensureSilentAudioElement() {
  if (silentAudio) return configureSilentKeepAliveAudio(silentAudio);
  const adopted = consumeSilentAudioGesture();
  if (adopted) return adopted;
  silentAudio = configureSilentKeepAliveAudio(new Audio(SILENT_KEEPALIVE_AUDIO_URL));
  return silentAudio;
}

function scheduleSilentAudioRetry(delay = 2000) {
  if (typeof window === 'undefined') return;
  if (!canScheduleSilentAudioResume()) return;
  if (silentAudioRetryTimer) return;
  const wait = Math.max(300, delay, silentAudioCoolingUntil - Date.now());
  silentAudioRetryTimer = window.setTimeout(() => {
    silentAudioRetryTimer = 0;
    if (!canAutoResumeSilentAudio()) {
      if (canScheduleSilentAudioResume()) scheduleSilentAudioRetry(500);
      return;
    }
    startSilentAudio().catch(() => {});
  }, wait);
}

function startSilentAudioWatch() {
  if (typeof window === 'undefined' || silentAudioWatchTimer) return;
  silentAudioWatchTimer = window.setInterval(() => {
    if (!isSilentAudioArmed()) {
      stopSilentAudioWatch();
      return;
    }
    if (isForegroundMediaActive()) {
      // 真实语音/音乐永远优先；watch 只负责保活轨自愈，不能与真实媒体争夺音频会话。
      if (silentAudio && !silentAudio.paused) stopSilentAudio({ destroy: true, clearSession: true });
      return;
    }
    if (Date.now() < silentAudioCoolingUntil) return;
    if (document.hidden && (!silentAudio || silentAudio.paused)) {
      // watch 是唯一的 pause 自愈路径；间隔拉长，避免和系统抢会话造成闪烁。
      startSilentAudio().catch(() => {});
      return;
    }
    if (!silentAudio || silentAudio.paused || silentAudio.ended) return;
    if (confirmSilentAudioProgress(silentAudio)) return;
    if (silentAudioStalledChecks < SILENT_AUDIO_STALL_LIMIT) return;
    // WebKit/部分 WebView 会留下 paused=false 但 currentTime 永远不动的“僵尸音轨”。
    // 彻底拆掉元素再重建，不能继续把它误报成运行中，也不能让它占着后续通话的输出管线。
    noteSilentAudioInterrupted();
    stopSilentAudio({ destroy: true, clearSession: true });
    silentAudioIntentionalStop = false;
    scheduleSilentAudioRetry(1500);
  }, SILENT_AUDIO_WATCH_INTERVAL_MS);
}

function stopSilentAudioWatch() {
  if (!silentAudioWatchTimer) return;
  clearInterval(silentAudioWatchTimer);
  silentAudioWatchTimer = null;
}

function useSilentKeepAliveAudioSession(mode = keepAliveConfig.silentAudioMode) {
  // iOS 只有 playback 会话能让显式开启的常驻静音轨继续在后台运行；仅生成期间仍用
  // ambient，避免普通生成或自动提示音无条件抢占其它 App 的音乐。
  if (mode === 'always') return useForegroundAudioSession();
  return useAmbientAudioSession();
}

function primeSilentAudioGesture(event, { mode = keepAliveConfig.silentAudioMode } = {}) {
  disposeSilentAudioGesture();
  if (!event) return;
  if (silentAudio && !silentAudio.paused && !silentAudio.ended) {
    // 模式切换或生成按钮可能在保活轨已经运行时再次进来。直接切换当前会话即可；
    // 若再创建一枚预热 Audio，旧轨会失去引用并继续占着 iOS 音频会话。
    useSilentKeepAliveAudioSession(mode);
    return;
  }
  if (silentAudio) destroySilentAudioElement(silentAudio);
  // 静音保活不是「真实前台媒体」；若登记进 foregroundMediaCount，关闭开关时
  // clearSilentKeepAliveMediaSession 会误以为仍有音乐在播而跳过释放。
  silentAudioGesture = captureMediaGesture(event, {
    trackAsForeground: false,
    audioSession: mode === 'always' ? 'playback' : 'ambient',
  });
  if (silentAudioGesture?.audio) {
    silentAudioGesture.audio.dataset.marshmallowSilentKeepalive = '1';
  }
}

function disposeSilentAudioGesture() {
  if (!silentAudioGesture) return;
  try { silentAudioGesture.dispose(); } catch (_) {}
  silentAudioGesture = null;
}

async function startSilentAudioUnlocked() {
  if (!keepAliveConfig.silentAudio || silentKeepAliveSuspended || silentAudioPageSuspended || silentAudioPageUnloading) return false;
  if (isForegroundMediaActive()) return false;
  if (Date.now() < silentAudioCoolingUntil) return false;
  // 仅记录偏好、尚未开「后台活跃」时也算成功，避免把勾选写回 false。
  if (!keepAliveConfig.enabled) return true;
  // 「仅生成期间」档空闲时同理：偏好成立但不占音轨，生成开始时再拉起。
  if (!isSilentAudioArmed()) return true;
  if (typeof Audio === 'undefined') return false;
  const startVersion = silentAudioStartVersion;
  silentAudioIntentionalStop = false;
  try {
    if (silentAudioGesture) {
      try { await silentAudioGesture.prime; } catch (_) {}
    }
    if (
      startVersion !== silentAudioStartVersion
      || !isSilentAudioArmed()
      || silentKeepAliveSuspended
      || silentAudioPageSuspended
      || isForegroundMediaActive()
      || Date.now() < silentAudioCoolingUntil
    ) return false;
    const audio = consumeSilentAudioGesture() || ensureSilentAudioElement();
    configureSilentKeepAliveAudio(audio);
    useSilentKeepAliveAudioSession();
    updateSilentKeepAliveMediaSession(true);
    await waitForAudioCanPlay(audio);
    if (
      startVersion !== silentAudioStartVersion
      || !isSilentAudioArmed()
      || silentKeepAliveSuspended
      || silentAudioPageSuspended
      || isForegroundMediaActive()
      || silentAudioIntentionalStop
    ) {
      silentAudioIntentionalStop = true;
      destroySilentAudioElement(audio);
      return false;
    }
    await audio.play();
    if (
      startVersion !== silentAudioStartVersion
      || !isSilentAudioArmed()
      || silentKeepAliveSuspended
      || silentAudioPageSuspended
      || isForegroundMediaActive()
      || silentAudioIntentionalStop
    ) {
      silentAudioIntentionalStop = true;
      destroySilentAudioElement(audio);
      return false;
    }
    silentAudio = audio;
    silentAudioIntentionalStop = false;
    if (!audio.paused) markSilentAudioConfirmed();
    startSilentAudioWatch();
    return !audio.paused;
  } catch (err) {
    if (
      startVersion !== silentAudioStartVersion
      || !isSilentAudioArmed()
      || silentAudioPageSuspended
      || silentAudioIntentionalStop
    ) {
      if (silentAudio) destroySilentAudioElement(silentAudio);
      return false;
    }
    console.warn('[background-scheduler] silent audio failed', err);
    scheduleSilentAudioRetry();
    return false;
  }
}

function startSilentAudio() {
  if (silentAudioStartPromise) return silentAudioStartPromise;
  silentAudioStartPromise = startSilentAudioUnlocked().finally(() => {
    silentAudioStartPromise = null;
  });
  return silentAudioStartPromise;
}

function destroySilentAudioElement(audio) {
  if (!audio) return;
  try {
    audio.loop = false;
    audio.muted = true;
    audio.volume = 0;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch (_) {
    // Ignore an element already detached by WebKit.
  }
  try {
    audio.remove();
  } catch (_) {
    // Ignore DOM cleanup failures during page shutdown.
  }
  if (silentAudio === audio) silentAudio = null;
  if (silentAudioProbeElement === audio) resetSilentAudioProgressProbe();
}

function stopSilentAudio({ destroy = false, clearSession = false } = {}) {
  silentAudioIntentionalStop = true;
  silentAudioStartVersion += 1;
  // startSilentAudioUnlocked 可能还卡在等待手势 prime。此时 silentAudio 尚未被接管，
  // 只停当前引用会漏掉那枚已播放的临时 Audio，随后异步恢复又会把它改成 loop。
  disposeSilentAudioGesture();
  stopSilentAudioWatch();
  if (silentAudioRetryTimer) {
    clearTimeout(silentAudioRetryTimer);
    silentAudioRetryTimer = 0;
  }
  if (destroy && typeof document !== 'undefined') {
    // 不只扫当前 host：手势预热音轨在被接管前可能尚未挂进 host，旧版本也可能
    // 留下脱离 host 的同源 audio。只按专用标记/专用文件清理，不碰语音和音乐。
    for (const audio of document.querySelectorAll('audio')) {
      if (
        audio.dataset?.marshmallowSilentKeepalive === '1'
        || isSilentKeepAliveSrc(audio.currentSrc || audio.src)
      ) {
        destroySilentAudioElement(audio);
      }
    }
  }
  if (!silentAudio) {
    if (clearSession || destroy) clearSilentKeepAliveMediaSession();
    notifyKeepAliveRuntimeChanged();
    return;
  }
  if (destroy) {
    destroySilentAudioElement(silentAudio);
  } else {
    try {
      silentAudio.pause();
      silentAudio.currentTime = 0;
    } catch (_) {
      // Ignore transient WebKit media teardown failures.
    }
  }
  if (clearSession || destroy) clearSilentKeepAliveMediaSession();
  notifyKeepAliveRuntimeChanged();
}

export function getKeepAliveRuntimeStatus() {
  const silentAudioElementPlaying = !!(silentAudio && !silentAudio.paused && !silentAudio.ended);
  const silentAudioRecentlyConfirmed = silentAudioLastConfirmedAt > 0
    && Date.now() - silentAudioLastConfirmedAt <= SILENT_AUDIO_HEALTH_STALE_MS;
  return {
    enabled: keepAliveConfig.enabled === true,
    silentAudioPreferred: keepAliveConfig.silentAudio === true,
    silentAudioMode: keepAliveConfig.silentAudioMode,
    silentAudioArmed: isSilentAudioArmed(),
    silentAudioActive: silentAudioElementPlaying && silentAudioRecentlyConfirmed,
    silentAudioStalled: silentAudioElementPlaying && !silentAudioRecentlyConfirmed,
    silentAudioSuspended: silentKeepAliveSuspended,
    silentAudioLastConfirmedAt,
    silentAudioConfirmedPlayCount,
    workerActive: !!worker,
    workerLastHeartbeatAt,
    workerLastTickAt,
    wakeLockActive: !!wakeLock,
    leaderActive,
    leaderMode,
    lastCatchUpAt,
    lastCatchUpReason,
    lastCatchUpResult,
    lastLifecycleCheckpoint,
  };
}

// Temporary foreground service scoped to an active generation. Users who never
// enabled permanent "后台活跃" still get their in-flight request protected when
// they press Home; the service stops as soon as no session is generating.
let generationKeepAliveStarted = false;
/** 是否有生成会话在跑：「仅生成期间」档的静音保活以此为武装依据。 */
let generationSessionActive = false;
/** 「仅生成期间」档的武装缓冲窗口：生成前手势预热 + 生成结束后的收尾期。 */
let generationKeepAliveGraceUntil = 0;
let generationKeepAliveStopTimer = 0;

/**
 * 静音保活当前是否应该持有音轨：「常驻」档开着就武装；「仅生成期间」档只在有生成会话
 * （含生成前的手势预热窗口与结束后的缓冲窗口）时武装，空闲时不占系统音频会话——
 * iOS 清后台后控制中心残留播放条的概率随音轨暴露时长一起下降。
 */
function isSilentAudioArmed() {
  if (!keepAliveConfig.enabled || !keepAliveConfig.silentAudio) return false;
  if (keepAliveConfig.silentAudioMode !== 'generation') return true;
  return generationSessionActive
    || generationKeepAliveStarted
    || Date.now() < generationKeepAliveGraceUntil;
}

function cancelGenerationScopedSilentAudioStop() {
  if (generationKeepAliveStopTimer && typeof window !== 'undefined') {
    window.clearTimeout(generationKeepAliveStopTimer);
  }
  generationKeepAliveStopTimer = 0;
}

/** 「仅生成期间」档：生成结束后留一段缓冲再拆音轨，链式的下一轮生成会取消本次拆除。 */
function scheduleGenerationScopedSilentAudioStop() {
  if (keepAliveConfig.silentAudioMode !== 'generation') return;
  if (typeof window === 'undefined') return;
  cancelGenerationScopedSilentAudioStop();
  generationKeepAliveGraceUntil = Date.now() + GENERATION_KEEPALIVE_GRACE_MS;
  generationKeepAliveStopTimer = window.setTimeout(() => {
    generationKeepAliveStopTimer = 0;
    if (isSilentAudioArmed()) return;
    stopSilentAudioWatch();
    stopSilentAudio({ destroy: true, clearSession: true });
  }, GENERATION_KEEPALIVE_GRACE_MS + 500);
}

export async function setGenerationKeepAliveActive(active) {
  generationSessionActive = !!active;
  if (active) cancelGenerationScopedSilentAudioStop();
  if (!isNativeShell()) {
    await getBackgroundKeepAliveSettings();
    // 网页/PWA 无原生前台服务；生成开始时再借一次静音轨，降低 iOS 立刻切后台被挂起的概率。
    if (active) {
      if (keepAliveConfig.enabled && keepAliveConfig.silentAudio) {
        await startSilentAudio().catch(() => false);
        if (typeof document !== 'undefined' && document.hidden) startSilentAudioWatch();
      }
    } else {
      scheduleGenerationScopedSilentAudioStop();
    }
    return;
  }
  await getBackgroundKeepAliveSettings();
  if (!active) scheduleGenerationScopedSilentAudioStop();
  if (active) {
    if (generationKeepAliveStarted || keepAliveConfig.enabled) return;
    const plugin = nativeKeepAlivePlugin();
    if (!plugin?.start) return;
    generationKeepAliveStarted = true;
    try {
      await plugin.start({
        title: '正在生成回复',
        body: '生成结束后会自动停止；切后台也会尽量跑完这一条。',
      });
    } catch (err) {
      generationKeepAliveStarted = false;
      console.warn('[background-scheduler] generation keepalive start failed', err);
    }
    return;
  }
  if (!generationKeepAliveStarted) return;
  generationKeepAliveStarted = false;
  // If the user enabled permanent keepalive meanwhile, the service now belongs to it.
  if (keepAliveConfig.enabled) return;
  await stopNativeKeepAlive().catch(() => {});
}

/**
 * 用户点「推进」等前台操作后可能立刻切后台：借这次点击手势把静音保活/唤醒锁再拉一把，
 * 尽量让进行中的 API 请求在后台继续跑完（不另开重试、不改请求内容）。
 */
export async function ensureKeepAliveDuringActiveGeneration({ event = null } = {}) {
  await getBackgroundKeepAliveSettings();
  if (!keepAliveConfig.enabled) return { ...keepAliveConfig, armed: false };
  // 音乐、语音等真实媒体正在播放时，连「手势预热」也不能创建。真正的保活启动虽然
  // 还会在 startSilentAudioUnlocked 内检查前台媒体，但 captureMediaGesture() 本身已经
  // 会短播一条静音 Audio；在 iOS/WebView 上这一步就足以抢走网易云的音频会话。
  if (
    keepAliveConfig.silentAudio
    && event
    && !silentKeepAliveSuspended
    && !isForegroundMediaActive()
  ) {
    primeSilentAudioGesture(event);
  }
  if (keepAliveConfig.silentAudioMode === 'generation') {
    // 生成即将开始：预先进入武装窗口，借这次点击手势把音轨立即拉起来。
    generationKeepAliveGraceUntil = Date.now() + GENERATION_KEEPALIVE_GRACE_MS;
  }
  refreshKeepAliveEnhancements();
  if (keepAliveConfig.silentAudio) {
    await startSilentAudio().catch(() => false);
    if (typeof document !== 'undefined' && document.hidden) startSilentAudioWatch();
  }
  if (keepAliveConfig.keepAwake) requestWakeLock().catch(() => {});
  return { ...keepAliveConfig, armed: true };
}

export function suspendSilentKeepAliveAudio() {
  silentKeepAliveSuspended = true;
  stopSilentAudio();
  notifyKeepAliveRuntimeChanged();
}

export function resumeSilentKeepAliveAudio() {
  if (!silentKeepAliveSuspended) return;
  silentKeepAliveSuspended = false;
  if (isSilentAudioArmed()) {
    startSilentAudio().catch(() => {});
    startSilentAudioWatch();
  }
  notifyKeepAliveRuntimeChanged();
}

function refreshKeepAliveEnhancements() {
  if (!keepAliveConfig.enabled) {
    releaseWakeLock().catch(() => {});
    stopSilentAudio({ destroy: true, clearSession: true });
    stopWorker();
    stopNativeKeepAlive().catch(() => {});
    return;
  }
  if (keepAliveConfig.keepAwake) requestWakeLock().catch(() => {});
  else releaseWakeLock().catch(() => {});
  if (isSilentAudioArmed()) {
    startSilentAudio().catch(() => {});
    startSilentAudioWatch();
  } else {
    // 含「仅生成期间」档空闲态：偏好保留，但不持有音轨。
    stopSilentAudio({ destroy: true, clearSession: true });
  }
  startNativeKeepAlive().catch(() => {});
  if (typeof document !== 'undefined' && document.hidden) startWorker();
}

export async function setBackgroundKeepAliveEnabled(on, { event = null } = {}) {
  if (on && keepAliveConfig.silentAudio) primeSilentAudioGesture(event);
  if (!on) {
    // 关闭必须先于 IndexedDB 写入立即生效。否则用户点完就划掉 PWA 时，WebKit 可能在
    // persist 的等待窗口里继续持有音频会话，而 pagehide 又不保证来得及执行。
    // 这里只关闭总开关并立即停掉当前音轨；静音保活是独立偏好，重新开启总开关时应恢复，
    // 不能因为临时停用后台任务就替用户取消已经选好的保活方式。
    keepAliveConfig = normalizeKeepAliveConfig({
      ...keepAliveConfig,
      enabled: false,
    });
    disposeSilentAudioGesture();
    refreshKeepAliveEnhancements();
  }
  await persistKeepAliveConfig({ enabled: !!on });
  refreshKeepAliveEnhancements();
  if (on) {
    await catchUpBackgroundWork('enable').catch(() => {});
  }
  return { ...keepAliveConfig };
}

export async function setKeepAwakeEnabled(on) {
  await persistKeepAliveConfig({ keepAwake: !!on });
  refreshKeepAliveEnhancements();
  return { ...keepAliveConfig };
}

export async function setSilentAudioMode(mode, { event = null } = {}) {
  const next = mode === 'always' ? 'always' : 'generation';
  if (next === 'always' && event) {
    silentAudioCoolingUntil = 0;
    silentAudioPauseStrike = 0;
    primeSilentAudioGesture(event, { mode: next });
  }
  await persistKeepAliveConfig({ silentAudioMode: next });
  refreshKeepAliveEnhancements();
  return { ...keepAliveConfig };
}

export async function setSilentAudioEnabled(on, { event = null } = {}) {
  if (on) {
    silentAudioCoolingUntil = 0;
    silentAudioPauseStrike = 0;
    primeSilentAudioGesture(event);
  } else {
    // 与总开关相同：先同步阻断重试和进行中的 play，再等待设置落盘。
    keepAliveConfig = normalizeKeepAliveConfig({ ...keepAliveConfig, silentAudio: false });
    disposeSilentAudioGesture();
    stopSilentAudio({ destroy: true, clearSession: true });
  }
  await persistKeepAliveConfig({ silentAudio: !!on });
  if (on) {
    await startSilentAudio();
  } else {
    stopSilentAudio({ destroy: true, clearSession: true });
  }
  refreshKeepAliveEnhancements();
  return {
    ...keepAliveConfig,
    silentAudioActive: !!(silentAudio && !silentAudio.paused && !silentAudio.ended),
  };
}

/**
 * 一键开启推荐保活组合：后台活跃 + 静音音频保活，在同一次点击手势里完成。
 * 逐项分开开关时，点到第二个开关手势可能已过期，iOS 音轨解锁会静默失败；
 * 这里先借手势解锁音频再落盘。静音档位维持现值（新用户默认「仅生成期间」）。
 */
export async function enableRecommendedBackgroundKeepAlive({ event = null } = {}) {
  silentAudioCoolingUntil = 0;
  silentAudioPauseStrike = 0;
  primeSilentAudioGesture(event);
  await persistKeepAliveConfig({ enabled: true, silentAudio: true });
  refreshKeepAliveEnhancements();
  await startSilentAudio().catch(() => false);
  await catchUpBackgroundWork('enable').catch(() => {});
  return {
    ...keepAliveConfig,
    silentAudioActive: !!(silentAudio && !silentAudio.paused && !silentAudio.ended),
  };
}

export async function setNotifyOnAutoChatEnabled(on) {
  if (!on) {
    await persistKeepAliveConfig({ notifyOnAutoChat: false });
    return { ...keepAliveConfig };
  }
  const { requestMessageNotificationPermission } = await import('./native-notifications.js');
  const granted = await requestMessageNotificationPermission().catch(() => false);
  await persistKeepAliveConfig({ notifyOnAutoChat: granted });
  return { ...keepAliveConfig, notifyOnAutoChat: granted };
}

export function unscheduleChat(chatId, { cancelCloud = true } = {}) {
  const id = String(chatId || '').trim();
  const t = timers.get(id);
  if (t) clearInterval(t);
  timers.delete(id);
  clearDeferredAutoChatRetry(id);
  lastTriggered.delete(id);
  if (worker) worker.postMessage({ type: 'unschedule', chatId: id });
  if (cancelCloud && id) {
    import('./cloud-background-coordinator.js')
      .then((mod) => mod.cancelCloudAutoChatSchedule?.(id))
      .catch(() => {});
  }
}

async function resolveFixedFallbackForChat(chat, userId = '') {
  const characterId = characterIdForAutonomyChat(chat);
  if (!characterId) {
    return {
      characterId: '',
      policy: {
        totalEnabled: chat?.autoActive === true,
        scheduleProactive: { enabled: false },
        fixedFallback: {
          enabled: chat?.autoActive === true,
          intervalMs: Math.max(60000, Number(chat?.autoInterval) || 300000),
          explicitEnabled: chat?.autoActive === true,
        },
      },
    };
  }
  const policy = await loadResolvedCharacterAutonomyPolicy(
    userId || chat?.userId,
    characterId,
    chat?.id,
  ).catch(() => null);
  return {
    characterId,
    policy: policy || {
      totalEnabled: chat?.autoActive === true,
      scheduleProactive: { enabled: false },
      fixedFallback: {
        enabled: chat?.autoActive === true,
        intervalMs: Math.max(60000, Number(chat?.autoInterval) || 300000),
        explicitEnabled: chat?.autoActive === true,
      },
    },
  };
}

const cloudAutoProbeAt = new Map();
const CLOUD_AUTO_PROBE_GAP_MS = 120_000;

async function triggerAutoReply(chatId, reason = 'timer') {
  const id = String(chatId || '').trim();
  const scheduledChat = await getChat(id).catch(() => null);
  if (scheduledChat && !isFixedFallbackChatEligible(scheduledChat)) {
    if (scheduledChat.autoActive === true) {
      await saveChat({ ...scheduledChat, autoActive: false }).catch(() => {});
    }
    unscheduleChat(id);
    return { ok: false, skipped: true, reason: 'ineligible-chat-channel' };
  }
  const modeUser = scheduledChat?.userId
    ? await getUserById(scheduledChat.userId).catch(() => null)
    : await ensureDefaultUser().catch(() => null);
  const virtualTime = modeUser?.id
    ? await getTimeMode(modeUser.id).catch(() => '') === TIME_MODE_VIRTUAL
    : false;
  // Cloudflare 协调器启用后，同一自动聊天优先由云计划执行；本地 timer/补跑先对账。
  // 若本地 revision 已失效（云端计划被取消/上传失败），交还本地生成，避免「占坑却永不发」。
  if (!virtualTime && isCloudScheduledBackgroundEnabled() && id && hasCloudScheduledTask(`chat-auto:${id}`)) {
    let cloudOwns = true;
    try {
      const mod = await import('./cloud-background-coordinator.js');
      await mod.reconcileCloudBackgroundEvents?.(`local-skip:${reason}`).catch(() => {});
      const now = Date.now();
      const lastProbe = Number(cloudAutoProbeAt.get(id) || 0);
      const forceProbe = /^catch-up:/i.test(String(reason || ''));
      if (forceProbe || now - lastProbe >= CLOUD_AUTO_PROBE_GAP_MS) {
        cloudAutoProbeAt.set(id, now);
        const probe = await mod.ensureCloudAutoChatOwnership?.(id);
        cloudOwns = probe?.owns === true;
      }
    } catch (_) {
      cloudOwns = hasCloudScheduledTask(`chat-auto:${id}`);
    }
    if (cloudOwns) {
      return { ok: false, skipped: true, reason: 'cloud-scheduled' };
    }
  }
  if (!id || inFlight.has(id)) return { ok: false, reason: 'in-flight' };
  // 前台正在手动推进/生成同一个会话时不要抢——避免前后台各出一轮、内容高度重复。
  if (isChatStreaming(id)) return { ok: false, reason: 'foreground-streaming' };
  const fixedGroupTick = scheduledChat?.type === 'group' && scheduledChat?.autoActive === true;
  // 群聊后台自动推进是独立固定打点：不读取用户近期操作或其它会话的生成状态。
  // 私聊旧固定兜底仍保留全局活跃避让，避免与真人感/主动行为抢请求。
  if (!fixedGroupTick && shouldDeferHeavyBackgroundWork() && !/^catch-up:/i.test(String(reason || ''))) {
    scheduleDeferredAutoChatRetry(id, reason);
    return { ok: false, reason: 'deferred-user-active' };
  }
  inFlight.add(id);
  let autonomyGuard = null;
  let autonomyGenerated = false;
  let modelRequestAttempted = false;
  try {
    const user = modeUser || await ensureDefaultUser();
    const chat = scheduledChat || await getChat(id);
    const resolved = await resolveFixedFallbackForChat(chat, user.id);
    const worldNow = await getNowForUser(user.id);
    let scheduleUsable = false;
    let scheduleTimeZone = '';
    if (resolved.characterId) {
      scheduleTimeZone = await import('./chat/chat-timezone.js')
        .then(({ resolveCharacterScheduleTimezone }) => (
          resolveCharacterScheduleTimezone(user.id, resolved.characterId)
        ))
        .catch(() => '');
    }
    if (resolved.characterId && resolved.policy.scheduleProactive?.enabled === true) {
      try {
        const {
          loadCharacterPhone,
          getDailyLifePlanForDate,
          pickCurrentPlanBlock,
          isPlanBlockActiveAt,
        } = await import('./character-phone-store.js');
        const phone = await loadCharacterPhone(user.id, resolved.characterId);
        const plan = getDailyLifePlanForDate(phone, dateKeyFromTimestamp(worldNow, scheduleTimeZone));
        const block = pickCurrentPlanBlock(plan, worldNow, scheduleTimeZone);
        scheduleUsable = Boolean(block && isPlanBlockActiveAt(block, worldNow, scheduleTimeZone));
      } catch (_) {
        scheduleUsable = false;
      }
    }
    const trigger = resolveAutonomyTrigger(resolved.policy, {
      scheduleUsable,
      fixedFallbackDue: true,
      now: worldNow,
      timeZone: scheduleTimeZone,
    });
    if (trigger.kind !== 'fixed-fallback') {
      // 静音时段等是临时条件：只跳过本轮，不能拆掉 interval timer，
      // 否则静音结束后或日程空窗时再也没人重新挂上固定间隔。
      if (isTemporaryAutonomySkipReason(trigger.reason)) {
        return { ok: false, skipped: true, reason: trigger.reason || 'temporarily-skipped' };
      }
      unscheduleChat(id);
      return { ok: false, reason: trigger.reason || 'auto-disabled' };
    }
    if (isAllMutedGroup(chat)) {
      return { ok: false, reason: 'all-muted' };
    }
    if (String(chat.userId || '') !== String(user.id || '')) {
      unscheduleChat(id);
      return { ok: false, reason: 'different-user' };
    }
    // 人就在线下对面：固定间隔兜底也让路。
    if (resolved.characterId) {
      try {
        const { isCharacterBusyInOfflineSession } = await import('./character-phone-proactive.js');
        if (await isCharacterBusyInOfflineSession(user.id, resolved.characterId)) {
          return { ok: false, skipped: true, reason: 'active-offline-session' };
        }
      } catch (_) { /* 线下态读不到时不阻塞 */ }
    }
    const interval = Math.max(60000, Number(resolved.policy.fixedFallback?.intervalMs) || 300000);
    const now = Date.now();
    const failureBackoff = getFixedFallbackFailureBackoff(chat, now);
    if (failureBackoff.active) {
      return {
        ok: false,
        skipped: true,
        reason: 'failure-backoff',
        retryAt: failureBackoff.retryAt,
      };
    }
    const last = Number(lastTriggered.get(id) || chat.autoLastTriggeredAt || 0);
    if (last && now - last < Math.max(30000, interval * 0.75)) {
      return { ok: false, reason: 'too-soon' };
    }
    autonomyGuard = acquireCharacterAutonomyGuard({
      userId: user.id,
      characterId: resolved.characterId,
      chatId: id,
    }, now);
    if (!autonomyGuard) return { ok: false, reason: 'autonomy-guard' };
    const [proactiveCharacter, proactiveRecent] = resolved.characterId
      ? await Promise.all([
        getCharacter(resolved.characterId, { userId: user.id }).catch(() => null),
        listMessagesForChat(id, 30).catch(() => []),
      ])
      : [null, []];
    const proactivePlan = planProactiveConversation({
      character: proactiveCharacter || { id: resolved.characterId },
      recentMessages: proactiveRecent,
      slotKey: `${id}:${Number(chat.autoLastTriggeredAt || 0)}:${now}`,
      hasScheduleMaterial: false,
      allowMemoryCallback: chat?.type !== 'group',
      busy: false,
      channel: 'fixed-fallback',
    });
    const antiRepeatDirective = buildProactiveAntiRepeatDirective(
      proactiveRecent,
      resolved.characterId,
    );
    const result = await runHeadlessChatReply(chat, user, {
      reason,
      proactiveChannel: 'fixed-fallback',
      proactivePermissionRequired: Boolean(resolved.characterId),
      ignoreComposerBusy: fixedGroupTick,
      skipBusyAutoReply: fixedGroupTick,
      // 恢复补跑由调度器自己限制为至多一次模型请求。群聊不再被此前的私聊补跑
      // 抢走全局名额，否则多群场景下会固定饿死排在后面的会话。
      bypassCatchUpGenerationCap: fixedGroupTick && /^catch-up:/i.test(String(reason || '')),
      proactiveMotive: proactivePlan.motive,
      proactiveIdempotencyKey: `${id}:${Number(chat.autoLastTriggeredAt || 0)}`,
      sceneDirective: [
        '[普通主动联系机会] 这是用户原有频率设置产生的一次主动机会，不是日程播报，也不因当前关系阶段减少次数。',
        buildProactiveConversationDirective(proactivePlan),
        antiRepeatDirective,
        '完整聊天上下文里即使有日程，也只用来判断此刻的生活背景；除非这轮动机明确是生活片段，否则不要把正在做什么、去了哪里写成默认话题。',
      ].filter(Boolean).join('\n\n'),
    });
    modelRequestAttempted = result?.modelRequestAttempted === true;
    autonomyGenerated = !!result?.ok;
    if (autonomyGenerated) {
      lastTriggered.set(id, now);
      const fresh = await getChat(id).catch(() => chat);
      await saveChat({
        ...fresh,
        autoLastTriggeredAt: now,
        ...clearFixedFallbackFailurePatch(),
      });
    } else {
      const failureReason = String(result?.reason || '');
      if (isFixedFallbackTerminalFailure(failureReason)) {
        // 角色/档位已经永久不存在时继续重试没有恢复可能。立即落盘关闭，
        // 否则旧 interval、Worker probe 和回前台补跑会在同一分钟反复制造 missing-character。
        const fresh = await getChat(id).catch(() => chat);
        if (fresh) {
          await saveChat({
            ...fresh,
            autoActive: false,
            ...clearFixedFallbackFailurePatch(),
          });
        }
        unscheduleChat(id);
      } else if (isFixedFallbackRetryableFailure(failureReason)) {
        const fresh = await getChat(id).catch(() => chat);
        await saveChat({
          ...fresh,
          ...buildFixedFallbackFailurePatch(fresh, failureReason, now),
        });
      }
    }
    await notifyHeadlessChatIfEnabled(chat, result, { reason }).catch(() => {});
    window.dispatchEvent?.(new CustomEvent('background-trigger', {
      detail: { chatId: id, result, generated: !!result?.ok, reason, at: Date.now() },
    }));
    return result;
  } catch (err) {
    console.warn('[background-scheduler]', id, err);
    return {
      ok: false,
      reason: err?.message || String(err || 'failed'),
      modelRequestAttempted: modelRequestAttempted || err?.modelRequestAttempted === true,
    };
  } finally {
    releaseCharacterAutonomyGuard(autonomyGuard, { generated: autonomyGenerated });
    inFlight.delete(id);
  }
}

/**
 * 手动推进/重 roll 等成功出一轮之后调用：把「后台自动推进」的计时锚点重置到刚才这一刻。
 * 不重置的话，后台定时器还是按它自己原来的固定节奏走，跟用户刚推进过完全脱节——
 * 场景没怎么变化时，隔几分钟后台又独立生成一轮，很容易复述出高度相似甚至一样的内容，
 * 表现成「连续发两轮一样的东西」。
 */
export async function markChatManuallyAdvanced(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  const now = Date.now();
  lastTriggered.set(id, now);
  try {
    const chat = await getChat(id);
    if (!chat?.autoActive) return;
    const updated = { ...chat, autoLastTriggeredAt: now };
    await saveChat(updated);
    await scheduleChat(updated);
  } catch (err) {
    console.warn('[background-scheduler] markChatManuallyAdvanced failed', err);
  }
}

export async function scheduleChat(chatRow) {
  const chatId = String(chatRow?.id || '').trim();
  if (!chatId) return;
  // 重挂本地 timer 时不要先异步删除云计划，避免 delete 晚于随后的 upsert 抵达。
  unscheduleChat(chatId, { cancelCloud: false });
  if (!isFixedFallbackChatEligible(chatRow)) {
    if (chatRow.autoActive === true) {
      await saveChat({ ...chatRow, autoActive: false }).catch(() => {});
    }
    import('./cloud-background-coordinator.js')
      .then((mod) => mod.cancelCloudAutoChatSchedule?.(chatId))
      .catch(() => {});
    return;
  }
  const resolved = await resolveFixedFallbackForChat(chatRow, chatRow?.userId);
  if (!resolved.policy.totalEnabled || !resolved.policy.fixedFallback?.enabled || isAllMutedGroup(chatRow)) {
    import('./cloud-background-coordinator.js')
      .then((mod) => mod.cancelCloudAutoChatSchedule?.(chatId))
      .catch(() => {});
    return;
  }
  const interval = Math.max(60000, Number(resolved.policy.fixedFallback.intervalMs) || 300000);
  const timer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerAutoReply(chatId, 'chat-interval').catch(() => {});
  }, interval);
  timers.set(chatId, timer);
  if (worker) worker.postMessage({ type: 'schedule', chatId, interval });
  import('./cloud-background-coordinator.js')
    .then(async (mod) => {
      const user = chatRow?.userId ? await getUserById(chatRow.userId).catch(() => null) : null;
      return mod.syncCloudAutoChatSchedule?.(chatRow, user);
    })
    .catch(() => {});
}

export async function resyncAllChatSchedules(userId) {
  const user = await getUserById(userId).catch(() => null);
  const chats = await listChatsForUser(userId);
  for (const chat of chats) {
    if (chat?.autoActive) await scheduleChat(chat);
    else unscheduleChat(chat.id);
  }
  // next_reply_delay / 闲置续聊同样镜像到云端一次性计划；
  // 轮次刚结束时强制重编译，让计划吃到本轮最新消息。
  if (isCloudScheduledBackgroundEnabled()) {
    await import('./cloud-background-coordinator.js')
      .then(async (mod) => {
        await mod.syncCloudDelayedReplySchedules?.(user, { force: true });
        await mod.syncCloudIdleContinueSchedules?.(user);
      })
      .catch(() => {});
  }
}

async function resyncCurrentSlotChatSchedules(activeUser = null) {
  const user = activeUser || await ensureDefaultUser();
  const linked = await listUsersInSlot(user.id).catch(() => [user]);
  const identities = linked.length ? linked : [user];
  if (isCloudScheduledBackgroundEnabled()) {
    await import('./cloud-background-coordinator.js')
      .then((mod) => mod.pruneCloudChatSchedulesOutsideUsers?.(identities.map((identity) => identity.id)))
      .catch(() => {});
  }
  for (const identity of identities) {
    await resyncAllChatSchedules(identity.id);
  }
}

async function triggerPhoneProactive(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:native-alarm/i.test(String(reason || ''))) {
    scheduleDeferredCatchUp(`phone:${reason}`);
    return { ok: false, reason: 'deferred-user-active' };
  }
  if (phoneTickInFlight) return { ok: false, reason: 'in-flight' };
  phoneTickInFlight = true;
  try {
    return await runForCurrentSlotUsers(async (user) => {
      const result = await runCharacterPhoneProactiveCheck({ user, reason });
      window.dispatchEvent?.(new CustomEvent('character-phone-proactive-tick', {
        detail: { userId: user.id, result, reason, at: Date.now() },
      }));
      return result;
    });
  } catch (err) {
    console.warn('[background-scheduler] character phone proactive failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    phoneTickInFlight = false;
  }
}

async function triggerTravelNotifications(reason = 'timer') {
  if (travelTickInFlight) return { ok: false, reason: 'in-flight' };
  travelTickInFlight = true;
  try {
    const user = await ensureDefaultUser();
    const result = await scanTravelCharNotifications({ userId: user.id, user });
    if (result?.created) {
      window.dispatchEvent?.(new CustomEvent('travel-char-notifications', {
        detail: { result, reason, at: Date.now() },
      }));
      if (typeof document !== 'undefined' && !document.hidden) {
        showToast(`旅行char有 ${result.created} 条新消息`);
      } else {
        await notifyBackgroundMessageIfEnabled({
          title: '旅行char',
          body: `有 ${result.created} 条新消息`,
          tag: 'travel-char-notify',
          requireHidden: false,
        }).catch(() => {});
      }
    }
    return { ok: true, ...result };
  } catch (err) {
    console.warn('[background-scheduler] travel char notify failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    travelTickInFlight = false;
  }
}

function startPhoneProactiveTimer() {
  if (phoneTimer) clearInterval(phoneTimer);
  phoneTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerPhoneProactive('phone-interval').catch(() => {});
  }, CHARACTER_PHONE_PROACTIVE_CHECK_MS);
}

function startPhoneChatTimer() {
  if (phoneChatTimer) clearInterval(phoneChatTimer);
  phoneChatTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerPhoneChatScheduler('phone-chat-interval').catch(() => {});
  }, CHARACTER_PHONE_CHAT_CHECK_MS);
}

async function triggerPhoneChatScheduler(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:/i.test(String(reason || ''))) {
    return { ok: false, reason: 'deferred-user-active' };
  }
  if (phoneChatTickInFlight) return { ok: false, reason: 'in-flight' };
  return runTrackedBackgroundTask('phoneChat', CHARACTER_PHONE_CHAT_CHECK_MS, reason, async () => {
    phoneChatTickInFlight = true;
    try {
      return await runForCurrentSlotUsers((user) => (
        runCharacterPhoneChatSchedulerCheck({ user, reason })
      ));
    } catch (err) {
      console.warn('[background-scheduler] phone chat scheduler failed', err);
      return { ok: false, reason: err?.message || String(err || 'failed') };
    } finally {
      phoneChatTickInFlight = false;
    }
  });
}

/**
 * 分享冲动专属主动消息：跟日程主动消息是两条独立通道，不依赖当前有没有活跃日程块——
 * 已读不回/分享间隔/随机窗口一旦激活且手里有素材，单独拉起一轮只谈分享的对话，
 * 不用等日程凑巧有空档、也不会被日程内容抢走模型的注意力。
 */
async function triggerShareImpulseProactive(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:native-alarm/i.test(String(reason || ''))) {
    return { ok: false, reason: 'deferred-user-active' };
  }
  if (shareImpulseProactiveInFlight) return { ok: false, reason: 'in-flight' };
  shareImpulseProactiveInFlight = true;
  try {
    return await runForCurrentSlotUsers((user) => (
      runShareImpulseProactiveCheck({ user, reason })
    ));
  } catch (err) {
    console.warn('[background-scheduler] share impulse proactive failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    shareImpulseProactiveInFlight = false;
  }
}

function startShareImpulseProactiveTimer() {
  if (shareImpulseProactiveTimer) clearInterval(shareImpulseProactiveTimer);
  shareImpulseProactiveTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerShareImpulseProactive('share-impulse-interval').catch(() => {});
  }, SHARE_IMPULSE_PROACTIVE_CHECK_MS);
}

async function triggerCompanionTick(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:native-alarm/i.test(String(reason || ''))) {
    return { ok: false, reason: 'deferred-user-active' };
  }
  if (companionTickInFlight) return { ok: false, reason: 'in-flight' };
  companionTickInFlight = true;
  try {
    return await tickCompanion(reason);
  } finally {
    companionTickInFlight = false;
  }
}

async function triggerMemoProactive(reason = 'timer') {
  if (memoTickInFlight) return { ok: false, reason: 'in-flight' };
  memoTickInFlight = true;
  try {
    return await runForCurrentSlotUsers(async (user) => {
      const pacingNow = await getPacingNowForUser(user.id);
      const result = await runMemoProactiveCheck(user, pacingNow, reason);
      const radioResult = await runRadioPlanCheck(user, pacingNow, reason);
      const sent = Array.isArray(result?.results) ? result.results.filter((item) => item?.generated) : [];
      const deliveredRadio = Array.isArray(radioResult?.results)
        ? radioResult.results.filter((item) => item?.generated)
        : [];
      if (sent.length || deliveredRadio.length) {
        window.dispatchEvent?.(new CustomEvent('background-trigger', {
          detail: { userId: user.id, result, radioResult, reason, at: Date.now(), source: deliveredRadio.length ? 'radio-plan' : 'memo' },
        }));
      }
      if (deliveredRadio.length) {
        const { bumpPersistedMessagesUnread, shouldNotifyForBackgroundReason } = await import('./native-notifications.js');
        for (const item of deliveredRadio) {
          if (item.message) await bumpPersistedMessagesUnread(item.chatId, [item.message]).catch(() => {});
          if (!shouldNotifyForBackgroundReason(reason, item.chatId)) continue;
          const character = await getCharacter(item.characterId, { userId: user.id }).catch(() => null);
          await notifyBackgroundMessageIfEnabled({
            title: character?.customNickname || character?.name || '角色电台',
            body: '约好的电台已经送到',
            chatId: item.chatId,
            tag: `radio-plan-${item.planId}`,
            icon: character?.avatar || '',
            requireHidden: false,
          }).catch(() => {});
        }
      }
      return { ...result, radioResult };
    });
  } catch (err) {
    console.warn('[background-scheduler] memo proactive failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    memoTickInFlight = false;
  }
}

function startMemoProactiveTimer() {
  if (memoTimer) clearInterval(memoTimer);
  memoTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerMemoProactive('memo-interval').catch(() => {});
  }, MEMO_PROACTIVE_CHECK_MS);
}

async function triggerMeituanCouponReminder(reason = 'timer') {
  if (meituanCouponTickInFlight) return { ok: false, reason: 'in-flight' };
  meituanCouponTickInFlight = true;
  try {
    return await runForCurrentSlotUsers(async (user) => {
      const result = await runMeituanCouponReminderCheck(user, Date.now(), reason);
      if (result?.generated) {
        window.dispatchEvent?.(new CustomEvent('background-trigger', {
          detail: {
            userId: user.id,
            chatId: result.chatId,
            result,
            generated: true,
            reason,
            at: Date.now(),
            source: 'meituan-coupon-reminder',
          },
        }));
      }
      return result;
    });
  } catch (err) {
    console.warn('[background-scheduler] meituan coupon reminder failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    meituanCouponTickInFlight = false;
  }
}

function startMeituanCouponReminderTimer() {
  if (meituanCouponTimer) clearInterval(meituanCouponTimer);
  meituanCouponTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerMeituanCouponReminder('meituan-coupon-interval').catch(() => {});
  }, MEITUAN_COUPON_REMINDER_CHECK_MS);
}

async function triggerPendingChatActions(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:/i.test(String(reason || ''))) {
    return { ok: false, reason: 'deferred-user-active' };
  }
  if (pendingActionTickInFlight) return { ok: false, reason: 'in-flight' };
  pendingActionTickInFlight = true;
  try {
    return await runForCurrentSlotUsers(async (user) => {
      const result = await runPendingChatActions(user, await getPacingNowForUser(user.id), reason);
      const generated = (result?.results || []).filter((item) => item?.ok);
      if (generated.length) {
        const chatIds = [...new Set(generated
          .map((item) => String(item?.chatId || item?.result?.messages?.[0]?.chatId || '').trim())
          .filter(Boolean))];
        // 待办可能一次处理多个会话：逐个广播，打开中的会话才能对上 chatId 刷顶栏/气泡。
        if (chatIds.length) {
          for (const id of chatIds) {
            window.dispatchEvent?.(new CustomEvent('background-trigger', {
              detail: { userId: user.id, chatId: id, result, generated: true, reason, at: Date.now(), source: 'pending-actions' },
            }));
          }
        } else {
          window.dispatchEvent?.(new CustomEvent('background-trigger', {
            detail: { userId: user.id, result, reason, at: Date.now(), source: 'pending-actions' },
          }));
        }
      }
      return result;
    });
  } catch (err) {
    console.warn('[background-scheduler] pending chat actions failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    pendingActionTickInFlight = false;
  }
}

function startPendingActionTimer() {
  if (pendingActionTimer) clearInterval(pendingActionTimer);
  pendingActionTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerPendingChatActions('pending-action-interval').catch(() => {});
  }, PENDING_ACTION_CHECK_MS);
}

async function triggerIdleContinue(reason = 'timer') {
  // 不因「用户还在 App 里」defer：本功能就是离开该会话后续聊，
  // 是否仍在前台由 evaluateIdleContinueDue 的 isViewingChatThread 判断。
  if (idleContinueTickInFlight) return { ok: false, reason: 'in-flight' };
  idleContinueTickInFlight = true;
  try {
    return await runForCurrentSlotUsers((user) => scanIdleContinueReplies(user, reason));
  } catch (err) {
    console.warn('[background-scheduler] idle continue failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    idleContinueTickInFlight = false;
  }
}

function startIdleContinueTimer() {
  if (idleContinueTimer) clearInterval(idleContinueTimer);
  idleContinueTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerIdleContinue('idle-continue-interval').catch(() => {});
  }, IDLE_CONTINUE_CHECK_MS);
}

function triggerTrackedUserInterceptAuto(reason = 'timer') {
  return runTrackedBackgroundTask(
    'userInterceptAuto',
    USER_INTERCEPT_AUTO_CHECK_MS,
    reason,
    () => runForCurrentSlotUsers((user) => runUserInterceptAutoCheck({ user })),
  );
}

function startUserInterceptAutoTimer() {
  if (userInterceptTimer) clearInterval(userInterceptTimer);
  userInterceptTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerTrackedUserInterceptAuto('user-intercept-interval').catch(() => {});
  }, USER_INTERCEPT_AUTO_CHECK_MS);
}

async function triggerPeriodProactive(reason = 'timer') {
  if (periodTickInFlight) return { ok: false, reason: 'in-flight' };
  periodTickInFlight = true;
  try {
    return await runForCurrentSlotUsers(async (user) => {
      const result = await runPeriodProactiveCheck(user, await getPacingNowForUser(user.id), reason);
      if (result?.generated) {
        window.dispatchEvent?.(new CustomEvent('background-trigger', {
          detail: { userId: user.id, result, reason, at: Date.now(), source: 'period' },
        }));
      }
      return result;
    });
  } catch (err) {
    console.warn('[background-scheduler] period proactive failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    periodTickInFlight = false;
  }
}

function startPeriodProactiveTimer() {
  if (periodTimer) clearInterval(periodTimer);
  periodTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerPeriodProactive('period-interval').catch(() => {});
  }, PERIOD_PROACTIVE_CHECK_MS);
}

async function triggerMailboxProactive(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:native-alarm/i.test(String(reason || ''))) {
    return { ok: false, reason: 'deferred-user-active' };
  }
  if (mailboxProactiveTickInFlight) return { ok: false, reason: 'in-flight' };
  mailboxProactiveTickInFlight = true;
  try {
    return await runForCurrentSlotUsers(async (user) => {
      const result = await runMailboxProactiveCheck({ user, now: await getNowForUser(user.id), reason });
      if (result?.generated) {
        window.dispatchEvent?.(new CustomEvent('background-trigger', {
          detail: { userId: user.id, result, reason, at: Date.now(), source: 'mailbox' },
        }));
      }
      return result;
    });
  } catch (err) {
    console.warn('[background-scheduler] mailbox proactive failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    mailboxProactiveTickInFlight = false;
  }
}

function startMailboxProactiveTimer() {
  if (mailboxProactiveTimer) clearInterval(mailboxProactiveTimer);
  mailboxProactiveTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerMailboxProactive('mailbox-interval').catch(() => {});
  }, MAILBOX_PROACTIVE_CHECK_MS);
}

async function triggerDriftBottleProactive(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:native-alarm/i.test(String(reason || ''))) {
    return { ok: false, reason: 'deferred-user-active' };
  }
  if (driftBottleTickInFlight) return { ok: false, reason: 'in-flight' };
  driftBottleTickInFlight = true;
  try {
    return await runForCurrentSlotUsers(async (user) => {
      const result = await runDriftBottleProactiveCheck({ user, reason });
      if (result?.fired) {
        window.dispatchEvent?.(new CustomEvent('background-trigger', {
          detail: { userId: user.id, result, reason, at: Date.now(), source: 'drift-bottle' },
        }));
      }
      return result;
    });
  } catch (err) {
    console.warn('[background-scheduler] drift bottle proactive failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    driftBottleTickInFlight = false;
  }
}

async function resolveDriftBottleCheckMs() {
  const users = await listCurrentSlotBackgroundUsers().catch(() => []);
  const intervals = await Promise.all(users.map((user) => (
    getDriftBottleScanIntervalMs(user.id).catch(() => DRIFT_BOTTLE_PROACTIVE_CHECK_MS)
  )));
  driftBottleCheckMs = intervals.length
    ? Math.min(...intervals)
    : DRIFT_BOTTLE_PROACTIVE_CHECK_MS;
  if (!Number.isFinite(driftBottleCheckMs) || driftBottleCheckMs < 60 * 1000) {
    driftBottleCheckMs = DRIFT_BOTTLE_PROACTIVE_CHECK_MS;
  }
  return driftBottleCheckMs;
}

async function startDriftBottleProactiveTimer() {
  const intervalMs = await resolveDriftBottleCheckMs();
  if (driftBottleTimer) clearInterval(driftBottleTimer);
  driftBottleTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerDriftBottleProactive('drift-bottle-interval').catch(() => {});
  }, intervalMs);
  // 后台 Worker 探针跟着用户设定的扫描间隔走
  worker?.postMessage?.({ type: 'probe', name: 'driftBottle', interval: intervalMs });
}

/** 聊天详情改「扫描间隔」后立刻重挂定时器，不必等重启。 */
export async function refreshDriftBottleScanTimer() {
  await startDriftBottleProactiveTimer();
}

function startTravelNotifyTimer() {
  if (travelTimer) clearInterval(travelTimer);
  travelTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerTravelNotifications('travel-interval').catch(() => {});
  }, TRAVEL_CHAR_NOTIFY_CHECK_MS);
}

async function triggerSchedulePrune(reason = 'timer', { force = false } = {}) {
  if (schedulePruneInFlight) return { ok: false, reason: 'in-flight' };
  schedulePruneInFlight = true;
  try {
    const user = await ensureDefaultUser();
    const now = await getNowForUser(user.id);
    const todayKey = dateKeyFromTimestamp(now);
    if (!todayKey) return { ok: false, reason: 'invalid-date-key' };
    const stateRow = await dbGet(SCHEDULE_PRUNE_STATE_KEY).catch(() => null);
    const lastKey = String(stateRow?.value?.dateKey || '').trim();
    if (!force && lastKey === todayKey) {
      return { ok: true, skipped: true, reason: 'already-ran-today', dateKey: todayKey };
    }
    const result = await pruneAllExpiredCharacterPhoneSchedules(user.id, todayKey);
    await dbPut({
      key: SCHEDULE_PRUNE_STATE_KEY,
      value: {
        dateKey: todayKey,
        at: Date.now(),
        reason,
        ...result,
      },
    });
    if (result.pruned > 0) {
      window.dispatchEvent?.(new CustomEvent('character-phone-schedule-pruned', {
        detail: { result, reason, at: Date.now() },
      }));
    }
    return { ok: true, dateKey: todayKey, ...result };
  } catch (err) {
    console.warn('[background-scheduler] schedule prune failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    schedulePruneInFlight = false;
  }
}

function startSchedulePruneTimer() {
  if (schedulePruneTimer) clearInterval(schedulePruneTimer);
  schedulePruneTimer = setInterval(() => {
    triggerSchedulePrune('daily-interval').catch(() => {});
  }, SCHEDULE_PRUNE_CHECK_MS);
}

/** 每次调用（不管跳过/失败/成功）都记一笔，供兴趣页显示「后台上次检查」，不用再靠猜排查。 */
async function recordInterestRotationDebug(reason, result, extra = {}) {
  await dbPut({
    key: INTEREST_ROTATION_DEBUG_KEY,
    value: {
      at: Date.now(),
      reason: String(reason || ''),
      ok: !!result?.ok,
      skipped: !!result?.skipped,
      resultReason: String(result?.reason || ''),
      processedCharacterIds: Array.isArray(extra.processedCharacterIds) ? extra.processedCharacterIds : [],
      perCharacter: extra.perCharacter || {},
    },
  }).catch(() => {});
}

export async function getInterestRotationDebugStatus() {
  const row = await dbGet(INTEREST_ROTATION_DEBUG_KEY).catch(() => null);
  return row?.value || null;
}

/**
 * 兴趣表轮转：默认所有角色都关闭，用户在兴趣页给某个角色打开「自动追踪」才会参与。
 * 每个角色独立计算冷却（按自己设置的 autoTrackIntervalHours，默认 12 小时一次），互不占用
 * 彼此名额；单次探测最多同时处理几个角色（默认 6 个）只是为了不一口气把搜索接口打爆，
 * 不是"全站一次只轮 6 个"的意思——只要开了追踪的角色数没有夸张到远超"探测频率 × 单次上限"，
 * 都会按各自的间隔正常轮到。
 * 每个角色一轮搜几个候选词由 autoTrackCandidatesPerRound 决定（默认 2）+ 至多一次母词裂变，
 * 结果沉淀进梗百科简报，聊天时被动注入 + 主动可聊都会用到。
 */
async function triggerInterestRotation(reason = 'timer', { force = false } = {}) {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:/i.test(String(reason || ''))) {
    const result = { ok: false, reason: 'deferred-user-active' };
    await recordInterestRotationDebug(reason, result);
    return result;
  }
  if (interestRotationInFlight) return { ok: false, reason: 'in-flight' };
  interestRotationInFlight = true;
  try {
    const [webCfg, socialCfg] = await Promise.all([
      loadWebSearchConfig().catch(() => null),
      loadSocialLinkConfig().catch(() => null),
    ]);
    const webOk = !!webCfg?.enabled;
    // 只要通用联网搜索和小红书/微博社媒精搜有一个能用就该跑：不少用户只配了社媒 key、没开通用
    // 联网搜索，「分享真实帖子精搜」走的正是社媒渠道兜底，之前卡死在这个开关上导致后台从不自动跑。
    const socialOk = !!(socialCfg?.enabled && socialCfg?.apiKey);
    if (!webOk && !socialOk) {
      const result = { ok: false, reason: 'search-not-configured' };
      await recordInterestRotationDebug(reason, result);
      return result;
    }
    const user = await ensureDefaultUser();
    const now = await getNowForUser(user.id);
    const stateRow = await dbGet(INTEREST_ROTATION_STATE_KEY).catch(() => null);
    const state = stateRow?.value || { lastAt: {} };
    const lastAt = state.lastAt || {};
    const characters = await listCharacters({ userId: user.id, excludeAnonNpc: true }).catch(() => []);
    const withInterests = [];
    const intervalMsByCharacter = {};
    for (const character of characters) {
      const entries = await listInterestEntries(user.id, character.id).catch(() => []);
      if (!entries.some((e) => e.status === 'active')) continue;
      const trackSettings = await loadInterestTrackingSettings(user.id, character.id).catch(() => ({ autoTrackEnabled: false }));
      // 关了「后台自动追踪」但开着「分享真实帖子精搜」的角色不能被这里的 continue 整个跳过——
      // 否则用户设的 shareDailyTarget（每天最多分享几条）永远等不到补货，形同虚设。
      // 这类角色不参与裂变/候选词搜索（runDailyInterestRotationForCharacter 里会按
      // autoTrackEnabled 单独把那部分跳过），只走更短周期的补货检查。
      const shareOnly = trackSettings.autoTrackEnabled === false && trackSettings.sharePostSearchEnabled === true;
      if (trackSettings.autoTrackEnabled === false && !shareOnly) continue;
      const intervalHours = shareOnly
        ? SHARE_ONLY_REFILL_INTERVAL_HOURS
        : (Number(trackSettings.autoTrackIntervalHours) > 0 ? Number(trackSettings.autoTrackIntervalHours) : 12);
      intervalMsByCharacter[character.id] = intervalHours * 60 * 60 * 1000;
      withInterests.push(character);
    }
    // 每个角色独立算冷却：没跑过 / 冷却已过才算「到点了」，冷却时长按角色自己设置的搜索间隔来，
    // 跟其他角色互不占用彼此的名额
    const due = withInterests.filter((c) => force || now - Number(lastAt[c.id] || 0) >= (intervalMsByCharacter[c.id] || INTEREST_ROTATION_MIN_INTERVAL_MS));
    if (!due.length) {
      const result = { ok: true, skipped: true, reason: 'nothing-due', trackedCount: withInterests.length };
      await recordInterestRotationDebug(reason, result);
      return result;
    }
    const ordered = due
      .slice()
      .sort((a, b) => Number(lastAt[a.id] || 0) - Number(lastAt[b.id] || 0))
      .slice(0, INTEREST_ROTATION_MAX_PER_TICK);

    const results = [];
    const perCharacter = {};
    for (const character of ordered) {
      try {
        const result = await runDailyInterestRotationForCharacter({ userId: user.id, characterId: character.id, character });
        results.push({ characterId: character.id, ...result });
        perCharacter[character.id] = {
          materials: Array.isArray(result?.materials) ? result.materials.length : 0,
          sharePosts: Array.isArray(result?.sharePosts) ? result.sharePosts.length : 0,
        };
      } catch (err) {
        console.warn('[background-scheduler] interest rotation failed for', character.id, err);
        perCharacter[character.id] = { error: err?.message || String(err || 'failed') };
      }
      lastAt[character.id] = Date.now();
    }
    await dbPut({ key: INTEREST_ROTATION_STATE_KEY, value: { lastAt } });
    const finalResult = { ok: true, processed: ordered.length, trackedCount: withInterests.length, results };
    await recordInterestRotationDebug(reason, finalResult, { processedCharacterIds: ordered.map((c) => c.id), perCharacter });
    return finalResult;
  } catch (err) {
    console.warn('[background-scheduler] interest rotation failed', err);
    const result = { ok: false, reason: err?.message || String(err || 'failed') };
    await recordInterestRotationDebug(reason, result);
    return result;
  } finally {
    interestRotationInFlight = false;
  }
}

function startInterestRotationTimer() {
  if (interestRotationTimer) clearInterval(interestRotationTimer);
  interestRotationTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerTrackedInterestRotation('interest-interval').catch(() => {});
  }, INTEREST_ROTATION_CHECK_MS);
}

/**
 * 日程步骤对兴趣进度的本地投影不依赖联网搜索，也不受「自动追踪」开关控制。
 * 每 15 分钟扫一次所有角色；事件带幂等指纹，多标签页/回前台重复执行不会重复记账。
 */
async function triggerInterestProgressSync(reason = 'timer') {
  if (interestProgressSyncInFlight) return { ok: false, reason: 'in-flight' };
  interestProgressSyncInFlight = true;
  try {
    const user = await ensureDefaultUser();
    const now = await getNowForUser(user.id);
    const characters = await listCharacters({ userId: user.id, excludeAnonNpc: true }).catch(() => []);
    let events = 0;
    for (const character of characters) {
      if (!character?.id) continue;
      const result = await syncInterestProgressFromSchedule({
        userId: user.id,
        characterId: character.id,
        now,
      }).catch(() => null);
      events += Number(result?.events || 0);
    }
    return { ok: true, reason, processed: characters.length, events };
  } catch (err) {
    console.warn('[background-scheduler] interest progress sync failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    interestProgressSyncInFlight = false;
  }
}

function startInterestProgressSyncTimer() {
  if (interestProgressSyncTimer) clearInterval(interestProgressSyncTimer);
  interestProgressSyncTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerInterestProgressSync('interest-progress-interval').catch(() => {});
  }, INTEREST_PROGRESS_SYNC_CHECK_MS);
}

/**
 * 「TA 关注你的小红书」定时探测：只有真正开了该功能的角色才会真的发请求
 * （checkUserSocialUpdates 内部按角色做冷却节流，约一天一次）；这里只是「醒来看看该不该查」，
 * 没到点就直接跳过、不产生网络请求，tick 本身开销可以忽略。
 */
async function triggerUserSocialWatch(reason = 'timer') {
  if (userSocialWatchInFlight) return { ok: false, reason: 'in-flight' };
  userSocialWatchInFlight = true;
  try {
    const user = await ensureDefaultUser();
    const characters = await listCharacters({ userId: user.id, excludeAnonNpc: true }).catch(() => []);
    const results = [];
    for (const character of characters) {
      const settings = await loadUserSocialWatchSettings(user.id, character.id).catch(() => null);
      if (!settings?.enabled) continue;
      try {
        const result = await checkUserSocialUpdates({ userId: user.id, characterId: character.id, manual: false });
        if (result?.added) results.push({ characterId: character.id, ...result });
      } catch (err) {
        console.warn('[background-scheduler] user social watch failed for', character.id, err);
      }
    }
    return { ok: true, processed: results.length, results };
  } catch (err) {
    console.warn('[background-scheduler] user social watch failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    userSocialWatchInFlight = false;
  }
}

function startUserSocialWatchTimer() {
  if (userSocialWatchTimer) clearInterval(userSocialWatchTimer);
  userSocialWatchTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerTrackedUserSocialWatch('user-social-interval').catch(() => {});
  }, USER_SOCIAL_WATCH_CHECK_MS);
}

function scheduleMemoryEmbedBacklog(reason = 'queue-changed', {
  delayMs = MEMORY_EMBED_WAKE_DEBOUNCE_MS,
  force = true,
} = {}) {
  if (typeof window === 'undefined') {
    return triggerMemoryEmbedBacklog(reason, { force });
  }
  if (memoryEmbedWakeTimer) window.clearTimeout(memoryEmbedWakeTimer);
  memoryEmbedWakeTimer = window.setTimeout(() => {
    memoryEmbedWakeTimer = 0;
    triggerMemoryEmbedBacklog(reason, { force }).catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
  return Promise.resolve({ ok: true, scheduled: true, reason });
}

export async function triggerMemoryEmbedBacklog(reason = 'timer', { force = false } = {}) {
  if (shouldDeferHeavyBackgroundWork()) {
    publishMemoryVectorBacklogState({
      phase: 'deferred',
      reason: 'user-active-or-generating',
      wake: false,
    });
    await scheduleMemoryEmbedBacklog('deferred', { delayMs: 4000, force: true });
    return { ok: false, reason: 'deferred-user-active-or-generating' };
  }
  const result = await runTrackedBackgroundTask(
    'memoryEmbedBacklog',
    MEMORY_EMBED_BACKLOG_CHECK_MS,
    reason,
    async () => {
      publishMemoryVectorBacklogState({ phase: 'working', reason, wake: false });
      let drain = await drainVectorBacklogBatches({ batchSize: 12, maxBatches: 1 });
      let backfill = { queued: 0, complete: true, skipped: true };
      // 先清已有队列，再发现下一页存量来源；不要每次都先塞 80 条、后取 16 条，
      // 否则 pending 会在回填期间持续增长，用户看到的仍像一个不会下降的数字。
      if (drain.ok !== false && !drain.skipped && !drain.hasMore) {
        backfill = await backfillVectorSources({ limit: 80 });
        if (Number(backfill.queued || 0) > 0) {
          const afterBackfill = await drainVectorBacklogBatches({ batchSize: 12, maxBatches: 1 });
          drain = {
            ...afterBackfill,
            processed: Number(drain.processed || 0) + Number(afterBackfill.processed || 0),
            batches: Number(drain.batches || 0) + Number(afterBackfill.batches || 0),
          };
        }
      }
      const stats = drain.stats || await getMemoryVectorIndexStats().catch(() => ({
        total: 0, ready: 0, pending: 0, failed: 0, superseded: 0,
      }));
      const hasMore = drain.reason !== 'disabled'
        && drain.ok !== false
        && (backfill.complete === false || Number(stats.pending || 0) > 0);
      return {
        ok: drain.ok !== false,
        reason: drain.reason || '',
        processed: Number(drain.processed || 0),
        backfill,
        drain,
        hasMore,
        nextRetryAt: Number(stats.nextRetryAt || 0),
      };
    },
    { leaseMs: 5 * 60 * 1000, force },
  );
  if (result?.hasMore) {
    await scheduleMemoryEmbedBacklog('backlog-followup', {
      delayMs: MEMORY_EMBED_FOLLOWUP_MS,
      force: true,
    });
  } else if (Number(result?.nextRetryAt || 0) > Date.now()) {
    await scheduleMemoryEmbedBacklog('retry-due', {
      delayMs: Math.min(
        MEMORY_EMBED_BACKLOG_CHECK_MS,
        Math.max(1000, Number(result.nextRetryAt) - Date.now()),
      ),
      force: true,
    });
  }
  return result;
}

function startMemoryEmbedBacklogTimer() {
  if (memoryEmbedTimer) clearInterval(memoryEmbedTimer);
  memoryEmbedTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerMemoryEmbedBacklog('memory-embed-interval').catch(() => {});
  }, MEMORY_EMBED_BACKLOG_CHECK_MS);
}

function dailyScheduleFailureHint(error) {
  const reason = String(error?.reason || '').trim();
  const status = Number(error?.status || 0) || 0;
  if (status === 401 || status === 403) return `API 鉴权失败（${status}）`;
  if (reason === 'empty-api-response') return '模型没有返回可用内容';
  if (reason === 'json-parse-failed') return '模型返回的日程格式不完整';
  if (reason === 'schedule-unverified-user-presence') return '模型凭空安排了用户参与，结果已拦截';
  if (reason === 'schedule-plot-repeated') return '模型生成了与近期重复的日程，结果已拦截';
  return String(error?.message || error || '生成失败')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

/**
 * 「每天后台自动生成日程」：成功按 dateKey 去重；失败按请求状态结算。
 * 只有明确 request_not_started 才会进入有界自动重试，所有可能已经提交的请求都等待用户处理，
 * 避免空回、格式失败或进程中断后在后台重复计费。
 */
async function triggerDailyScheduleGeneration(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:/i.test(String(reason || ''))) {
    return { ok: false, reason: 'deferred-user-active' };
  }
  if (dailyScheduleGenInFlight) return { ok: false, reason: 'in-flight' };
  dailyScheduleGenInFlight = true;
  try {
    const users = await listCurrentSlotBackgroundUsers();
    const perUser = [];
    for (const user of users) {
      const autoSettings = await loadCharacterPhoneAutoSettings(user.id).catch(() => null);
      const now = await getNowForUser(user.id);
      const todayKey = dateKeyFromTimestamp(now);
      const stateKey = `${DAILY_SCHEDULE_GEN_STATE_KEY}:${encodeURIComponent(user.id)}`;
      // 账本读失败不能伪装成“今天从未尝试”；否则一次 IndexedDB 瞬时错误就可能
      // 清掉已提交请求的保护门闩。没有记录时 dbGet 本身会返回 null。
      const stateRow = await dbGet(stateKey);
      const state = normalizeDailyScheduleGenerationState(stateRow?.value, {
        dateKey: todayKey,
        now: Date.now(),
      });
      const doneIds = new Set(state.doneCharacterIds);
      const attemptsByCharacter = { ...state.attemptsByCharacter };
      const persistState = () => dbPut({
        key: stateKey,
        value: {
          version: DAILY_SCHEDULE_GEN_STATE_VERSION,
          dateKey: todayKey,
          doneCharacterIds: [...doneIds],
          attemptsByCharacter,
        },
      });
      const characters = await listCharacters({
        userId: user.id,
        identityScoped: true,
        excludeAnonNpc: true,
      }).catch(() => []);
      const pending = characters.filter((c) => c?.id
        && isDailyLifeAutoEnabled(autoSettings, c.id)
        && !doneIds.has(c.id)
        && isDailyScheduleAttemptEligible(attemptsByCharacter[c.id], { now: Date.now() }));
      const results = [];
      for (const character of pending) {
        // 先把本轮记成 submitted_unknown 再请求。若 WebView 在请求途中被系统回收，
        // 下次启动会保守等待用户处理，而不会因为 catch 尚未来得及执行就再打一笔请求。
        const startedAttempt = beginDailyScheduleAttempt(attemptsByCharacter[character.id], {
          now: Date.now(),
        });
        attemptsByCharacter[character.id] = startedAttempt;
        await persistState();
        try {
          const result = await ensureDailyLifePlan({
            userId: user.id,
            characterId: character.id,
            character,
            user,
            force: false,
            timestamp: now,
            auditContext: {
              operation: 'daily-schedule-auto',
              trigger: String(reason || 'timer'),
              initiator: 'background',
              logicalRoundId: `daily-schedule:${user.id}:${character.id}:${todayKey}`,
              actorIds: [character.id],
              actorNames: [character.customNickname || character.name || character.id],
            },
          });
          if (!result?.plan?.blocks?.length) {
            const noPlanError = new Error('生成流程未返回可用日程');
            noPlanError.reason = 'daily-schedule-no-plan-result';
            if (typeof result?.modelRequestAttempted === 'boolean') {
              noPlanError.modelRequestAttempted = result.modelRequestAttempted;
            }
            throw noPlanError;
          }
          doneIds.add(character.id);
          delete attemptsByCharacter[character.id];
          results.push({ characterId: character.id, generated: !!result?.generated });
          await persistState();
        } catch (err) {
          console.warn('[background-scheduler] daily schedule gen failed for', user.id, character.id, err);
          const message = String(err?.message || err || '生成失败').slice(0, 500);
          const attempt = settleDailyScheduleFailure(startedAttempt, err, { now: Date.now() });
          attemptsByCharacter[character.id] = attempt;
          results.push({
            characterId: character.id,
            generated: false,
            error: message,
            requestState: attempt.requestState,
            retryStatus: attempt.status,
            nextEligibleAt: attempt.nextEligibleAt,
          });
          // 先落库再提醒；落库失败时不继续下一个模型请求，由外层结束本轮。
          await persistState();
          const characterName = String(character.customNickname || character.name || 'TA').trim() || 'TA';
          const retryPlanned = attempt.status === DAILY_SCHEDULE_ATTEMPT_STATUS.RETRY_COOLDOWN;
          const exhausted = attempt.status === DAILY_SCHEDULE_ATTEMPT_STATUS.EXHAUSTED;
          const title = '日程暂未生成';
          const body = retryPlanned
            ? `「${characterName}」的今日日程尚未开始生成，将在冷却后自动再试。${dailyScheduleFailureHint(err)}`
            : exhausted
              ? `「${characterName}」的日程在请求前连续失败，今日自动尝试已暂停。${dailyScheduleFailureHint(err)}`
              : `「${characterName}」的今日日程未生成。为避免重复计费，后台不会自动二次请求。${dailyScheduleFailureHint(err)}`;
          if (typeof document !== 'undefined' && !document.hidden) {
            showToast(retryPlanned ? body : `${body} 可稍后手动生成。`, 8000);
          } else {
            await showMessageNotification({
              title,
              body,
              tag: `daily-schedule-failed-${user.id}-${character.id}-${todayKey}`,
              data: { source: 'daily-schedule', userId: user.id, characterId: character.id },
              playSound: false,
            }).catch(() => {});
          }
        }
      }
      await persistState();
      perUser.push({ userId: user.id, dateKey: todayKey, processed: pending.length, results });
    }
    return { ok: true, processedUsers: perUser.length, perUser };
  } catch (err) {
    console.warn('[background-scheduler] daily schedule gen failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    dailyScheduleGenInFlight = false;
  }
}

function startDailyScheduleGenTimer() {
  if (dailyScheduleGenTimer) clearInterval(dailyScheduleGenTimer);
  dailyScheduleGenTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerTrackedDailySchedule('schedule-gen-interval').catch(() => {});
  }, DAILY_SCHEDULE_GEN_CHECK_MS);
}

// 朋友圈自动生成：真正的节流（间隔/每日上限）在 moments-auto 内部按状态判断，这里只管醒来探测
async function triggerMomentsAutoGen(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:/i.test(String(reason || ''))) {
    return { ok: false, reason: 'deferred-user-active' };
  }
  return runForCurrentSlotUsers((user) => runMomentsAutoCheck(reason, user));
}

function startMomentsAutoGenTimer() {
  if (momentsAutoTimer) clearInterval(momentsAutoTimer);
  momentsAutoTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerTrackedMoments('moments-auto-interval').catch(() => {});
  }, MOMENTS_AUTO_CHECK_MS);
}

// 论坛自动更新：实际间隔、每日上限和并发保护由 forum-auto 自己负责。
async function triggerForumAutoGen(reason = 'timer') {
  if (shouldDeferHeavyBackgroundWork() && !/^catch-up:/i.test(String(reason || ''))) {
    return { ok: false, reason: 'deferred-user-active' };
  }
  return runForCurrentSlotUsers((user) => runForumAutoCheck(reason, user));
}

function startForumAutoGenTimer() {
  if (forumAutoTimer) clearInterval(forumAutoTimer);
  forumAutoTimer = setInterval(() => {
    if (!shouldRunBackgroundTick()) return;
    triggerTrackedForum('forum-auto-interval').catch(() => {});
  }, FORUM_AUTO_CHECK_MS);
}

function triggerTrackedDailySchedule(reason) {
  return runTrackedBackgroundTask(
    'dailySchedule',
    DAILY_SCHEDULE_GEN_CHECK_MS,
    reason,
    () => triggerDailyScheduleGeneration(reason),
  );
}

function triggerTrackedMoments(reason) {
  return runTrackedBackgroundTask(
    'moments',
    MOMENTS_AUTO_CHECK_MS,
    reason,
    () => triggerMomentsAutoGen(reason),
  );
}

function triggerTrackedForum(reason) {
  return runTrackedBackgroundTask(
    'forum',
    FORUM_AUTO_CHECK_MS,
    reason,
    () => triggerForumAutoGen(reason),
  );
}

function triggerTrackedInterestRotation(reason) {
  return runTrackedBackgroundTask(
    'interestRotation',
    INTEREST_ROTATION_CHECK_MS,
    reason,
    () => triggerInterestRotation(reason),
  );
}

function triggerTrackedUserSocialWatch(reason) {
  return runTrackedBackgroundTask(
    'userSocialWatch',
    USER_SOCIAL_WATCH_CHECK_MS,
    reason,
    () => triggerUserSocialWatch(reason),
  );
}

async function catchUpBackgroundWork(reason = '') {
  const now = Date.now();
  if (!isBackgroundLeader()) return { ok: false, reason: 'not-leader' };
  if (shouldDeferHeavyBackgroundWork()) {
    scheduleDeferredCatchUp(reason || 'deferred');
    return { ok: false, reason: 'deferred-user-active' };
  }
  if (catchUpInFlight) return { ok: false, reason: 'catch-up-in-flight' };
  if (lastCatchUpAt && now - lastCatchUpAt < CATCH_UP_COOLDOWN_MS) {
    return { ok: false, reason: 'catch-up-cooldown' };
  }
  catchUpInFlight = true;
  lastCatchUpAt = now;
  lastCatchUpReason = String(reason || '');
  notifyKeepAliveRuntimeChanged();
  try {
    // 云端结果先落库（并弹通知），本地扫描才不会对同一件事重复生成；
    // 原生「云端到点」闹钟唤醒走的就是这条对账。
    if (isCloudScheduledBackgroundEnabled()) {
      await import('./cloud-background-coordinator.js')
        .then((mod) => mod.reconcileCloudBackgroundEvents?.(`catch-up:${reason}`))
        .catch(() => {});
    }
    await triggerPhoneProactive(`catch-up:${reason}`).catch(() => {});
    await triggerShareImpulseProactive(`catch-up:${reason}`).catch(() => {});
    await triggerMemoProactive(`catch-up:${reason}`).catch(() => {});
    await triggerMeituanCouponReminder(`catch-up:${reason}`).catch(() => {});
    await triggerPendingChatActions(`catch-up:${reason}`).catch(() => {});
    await triggerIdleContinue(`catch-up:${reason}`).catch(() => {});
    await triggerTrackedUserInterceptAuto(`catch-up:${reason}`).catch(() => {});
    await triggerPeriodProactive(`catch-up:${reason}`).catch(() => {});
    await triggerMailboxProactive(`catch-up:${reason}`).catch(() => {});
    await triggerDriftBottleProactive(`catch-up:${reason}`).catch(() => {});
    await triggerTravelNotifications(`catch-up:${reason}`).catch(() => {});
    await triggerSchedulePrune(`catch-up:${reason}`).catch(() => {});
    await triggerTrackedDailySchedule(`catch-up:${reason}`).catch(() => {});
    await triggerTrackedMoments(`catch-up:${reason}`).catch(() => {});
    await triggerTrackedForum(`catch-up:${reason}`).catch(() => {});
    await triggerTrackedInterestRotation(`catch-up:${reason}`).catch(() => {});
    await triggerTrackedUserSocialWatch(`catch-up:${reason}`).catch(() => {});
    await triggerCompanionTick(`catch-up:${reason}`).catch(() => {});
    await triggerPhoneChatScheduler(`catch-up:${reason}`).catch(() => {});
    const user = await ensureDefaultUser();
    await resyncCurrentSlotChatSchedules(user);
    const slotUsers = await listUsersInSlot(user.id).catch(() => [user]);
    const chats = (await Promise.all(slotUsers.map((identity) => (
      listChatsForUser(identity.id).catch(() => [])
    )))).flat();
    const due = selectDueFixedFallbackChats(chats, now);
    for (const chat of due) {
      const result = await triggerAutoReply(chat.id, `catch-up:${reason}`);
      // 静音、退避、云端接管等都还没有发起模型请求，继续寻找下一条可执行会话。
      // 一旦本轮成功或确实请求过模型就停止，避免恢复前台时集中生成多轮。
      if (result?.ok || result?.modelRequestAttempted === true) break;
    }
    lastCatchUpResult = { ok: true, reason: String(reason || ''), at: Date.now() };
    await recordBackgroundCheckpoint('catchUp', lastCatchUpResult).catch(() => {});
    return { ok: true, reason };
  } catch (err) {
    lastCatchUpResult = {
      ok: false,
      reason: err?.message || String(err || 'failed'),
      trigger: String(reason || ''),
      at: Date.now(),
    };
    await recordBackgroundCheckpoint('catchUp', lastCatchUpResult).catch(() => {});
    return lastCatchUpResult;
  } finally {
    catchUpInFlight = false;
    notifyKeepAliveRuntimeChanged();
  }
}

async function ensureNativeBackgroundWake() {
  if (!isNativeShell() || nativeWakeBound) return;
  nativeWakeBound = true;
  await initNativeBackgroundWake(
    (reason) => catchUpBackgroundWork(reason).catch(() => {}),
    { intervalMs: Math.min(CHARACTER_PHONE_PROACTIVE_CHECK_MS, 5 * 60_000) },
  ).catch(() => {});
}

function reconcileCloudBackground(reason = '') {
  import('./cloud-background-coordinator.js')
    .then((mod) => mod.reconcileCloudBackgroundEvents?.(reason))
    .catch(() => {});
}

function scheduleCloudPlanRefresh() {
  if (typeof window === 'undefined') return;
  if (cloudScheduleRefreshTimer) window.clearTimeout(cloudScheduleRefreshTimer);
  cloudScheduleRefreshTimer = window.setTimeout(() => {
    cloudScheduleRefreshTimer = 0;
    if (!isCloudScheduledBackgroundEnabled()) return;
    if (hasForegroundCriticalActivity() || isUserRecentlyActive(6000)) {
      scheduleCloudPlanRefresh();
      return;
    }
    ensureDefaultUser()
      .then((user) => resyncCurrentSlotChatSchedules(user))
      .catch(() => {});
  }, 2500);
}

function startWorker() {
  if (worker || !keepAliveConfig.enabled || !isBackgroundLeader() || typeof Worker === 'undefined') return;
  const code = `
    let timers = {};
    let probes = {};
    let heartbeatTimer = null;
    const startProbe = (name, interval) => {
      if (probes[name]) clearInterval(probes[name]);
      probes[name] = setInterval(
        () => self.postMessage({ type: 'probe', name, at: Date.now() }),
        Math.max(60000, interval || 60000),
      );
    };
    self.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'schedule') {
        if (timers[msg.chatId]) clearInterval(timers[msg.chatId]);
        timers[msg.chatId] = setInterval(() => self.postMessage({ type: 'chat', chatId: msg.chatId }), Math.max(60000, msg.interval || 300000));
      } else if (msg.type === 'unschedule') {
        if (timers[msg.chatId]) clearInterval(timers[msg.chatId]);
        delete timers[msg.chatId];
      } else if (msg.type === 'probe') {
        startProbe(String(msg.name || ''), Number(msg.interval) || 60000);
      } else if (msg.type === 'heartbeat') {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(
          () => self.postMessage({ type: 'heartbeat', at: Date.now() }),
          Math.max(5000, Number(msg.interval) || 15000),
        );
        self.postMessage({ type: 'heartbeat', at: Date.now() });
      } else if (msg.type === 'stop') {
        Object.values(timers).forEach(clearInterval);
        timers = {};
        Object.values(probes).forEach(clearInterval);
        probes = {};
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  workerUrl = URL.createObjectURL(blob);
  worker = new Worker(workerUrl);
  worker.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'heartbeat') {
      workerLastHeartbeatAt = Number(msg.at || Date.now());
      notifyKeepAliveRuntimeChanged();
      return;
    }
    if (!isBackgroundLeader()) return;
    if (msg.type === 'chat' && msg.chatId) {
      workerLastTickAt = Date.now();
      triggerAutoReply(msg.chatId, 'worker-hidden').catch(() => {});
      return;
    }
    if (msg.type !== 'probe') return;
    workerLastTickAt = Date.now();
    const probe = String(msg.name || '');
    if (probe === 'phone') triggerPhoneProactive('worker-hidden').catch(() => {});
    if (probe === 'phoneChat') triggerPhoneChatScheduler('worker-hidden').catch(() => {});
    if (probe === 'shareImpulse') triggerShareImpulseProactive('worker-hidden').catch(() => {});
    if (probe === 'travel') triggerTravelNotifications('worker-hidden').catch(() => {});
    if (probe === 'companion') triggerCompanionTick('worker-hidden').catch(() => {});
    if (probe === 'memo') triggerMemoProactive('worker-hidden').catch(() => {});
    if (probe === 'meituanCoupon') triggerMeituanCouponReminder('worker-hidden').catch(() => {});
    if (probe === 'pendingAction') triggerPendingChatActions('worker-hidden').catch(() => {});
    if (probe === 'period') triggerPeriodProactive('worker-hidden').catch(() => {});
    if (probe === 'mailbox') triggerMailboxProactive('worker-hidden').catch(() => {});
    if (probe === 'driftBottle') triggerDriftBottleProactive('worker-hidden').catch(() => {});
    if (probe === 'moments') triggerTrackedMoments('worker-hidden').catch(() => {});
    if (probe === 'forum') triggerTrackedForum('worker-hidden').catch(() => {});
    if (probe === 'dailySchedule') triggerTrackedDailySchedule('worker-hidden').catch(() => {});
    if (probe === 'interestRotation') triggerTrackedInterestRotation('worker-hidden').catch(() => {});
    if (probe === 'userSocialWatch') triggerTrackedUserSocialWatch('worker-hidden').catch(() => {});
    notifyKeepAliveRuntimeChanged();
  };
  for (const [chatId, timer] of timers.entries()) {
    const id = String(chatId || '');
    if (timer && id) {
      getChat(id).then((chat) => {
        if (chat?.autoActive && worker) {
          worker.postMessage({ type: 'schedule', chatId: id, interval: Math.max(60000, Number(chat.autoInterval) || 300000) });
        }
      }).catch(() => {});
    }
  }
  const probes = {
    phone: CHARACTER_PHONE_PROACTIVE_CHECK_MS,
    phoneChat: CHARACTER_PHONE_CHAT_CHECK_MS,
    shareImpulse: SHARE_IMPULSE_PROACTIVE_CHECK_MS,
    travel: TRAVEL_CHAR_NOTIFY_CHECK_MS,
    companion: COMPANION_TICK_MS,
    memo: MEMO_PROACTIVE_CHECK_MS,
    meituanCoupon: MEITUAN_COUPON_REMINDER_CHECK_MS,
    pendingAction: PENDING_ACTION_CHECK_MS,
    period: PERIOD_PROACTIVE_CHECK_MS,
    mailbox: MAILBOX_PROACTIVE_CHECK_MS,
    driftBottle: driftBottleCheckMs,
    moments: MOMENTS_AUTO_CHECK_MS,
    forum: FORUM_AUTO_CHECK_MS,
    dailySchedule: DAILY_SCHEDULE_GEN_CHECK_MS,
    interestRotation: INTEREST_ROTATION_CHECK_MS,
    userSocialWatch: USER_SOCIAL_WATCH_CHECK_MS,
  };
  Object.entries(probes).forEach(([name, interval]) => {
    worker?.postMessage({ type: 'probe', name, interval });
  });
  worker.postMessage({ type: 'heartbeat', interval: WORKER_HEARTBEAT_MS });
}

function stopWorker() {
  if (worker) {
    worker.postMessage({ type: 'stop' });
    worker.terminate();
    worker = null;
  }
  if (workerUrl) {
    URL.revokeObjectURL(workerUrl);
    workerUrl = '';
  }
}

function recordLifecycleCheckpoint(name, detail = {}) {
  lastLifecycleCheckpoint = {
    name: String(name || ''),
    at: Date.now(),
    ...(detail && typeof detail === 'object' ? detail : {}),
  };
  notifyKeepAliveRuntimeChanged();
  recordBackgroundCheckpoint('lifecycle', lastLifecycleCheckpoint).catch(() => {});
}

function ensureLeaderElection() {
  if (leaderElection) return;
  leaderElection = createBackgroundLeaderElection({
    onChange(state) {
      leaderActive = state.leader === true;
      leaderMode = String(state.mode || 'unknown');
      if (!leaderActive) {
        stopWorker();
      } else {
        if (typeof document !== 'undefined' && document.hidden && keepAliveConfig.enabled) startWorker();
        catchUpBackgroundWork('leader-acquired').catch(() => {});
      }
      notifyKeepAliveRuntimeChanged();
    },
  });
}

function bindLifecycle() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  window.addEventListener('storage', (event) => {
    if (event?.key !== KEEPALIVE_SHADOW_STORAGE_KEY || !event.newValue) return;
    const pending = parseKeepAlivePendingSnapshot(event.newValue);
    if (!pending) return;
    // 其它同源标签页/PWA 窗口关闭保活时，本页不能继续用旧内存状态占着系统音轨。
    keepAlivePersistRevision += 1;
    keepAliveConfig = pending.value;
    refreshKeepAliveEnhancements();
    notifyKeepAliveRuntimeChanged();
  });
  window.addEventListener('marshmallow-foreground-media-changed', (event) => {
    const active = event?.detail?.active === true || isForegroundMediaActive();
    if (active) {
      // iOS 的网页音频共用同一会话。真实语音/音乐一开始就彻底停掉静音保活，
      // 不能等系统把它 pause 后再由 watch 抢着重播。
      stopSilentAudio({ destroy: true, clearSession: true });
      return;
    }
    if (keepAliveConfig.enabled && keepAliveConfig.silentAudio && !silentKeepAliveSuspended) {
      // 上面的真实媒体接管会把当前静音轨标成“主动停止”；真实媒体释放后这次停止已经结束，
      // 必须先清掉标记，否则 scheduleSilentAudioRetry 会被 canAutoResumeSilentAudio 自己拦住。
      silentAudioIntentionalStop = false;
      // 队列语音的两段之间可能只有几十毫秒空档；延迟恢复，下一段若开始会取消本次重试。
      scheduleSilentAudioRetry(1200);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 若刚走 pagehide 卸载路径，不要在这里把音轨重新拉起（否则又占死系统会话）。
      if (silentAudioPageUnloading) return;
      silentAudioPageSuspended = false;
      if (keepAliveConfig.enabled) {
        startWorker();
        if (isSilentAudioArmed()) {
          startSilentAudio().catch(() => {});
          startSilentAudioWatch();
        }
      }
    } else {
      stopWorker();
      // 回前台扫掉宿主里残留的孤儿 audio，避免逻辑已停但系统 Now Playing 仍挂着。
      if (typeof document !== 'undefined') {
        const host = document.getElementById('marshmallow-silent-keepalive-audio');
        for (const el of host?.querySelectorAll?.('audio') || []) {
          if (el !== silentAudio) destroySilentAudioElement(el);
        }
      }
      refreshKeepAliveEnhancements();
      import('./chat/chat-stream-session.js')
        .then((mod) => mod.recoverStalePendingChatStreams?.())
        .catch(() => {});
      reconcileCloudBackground('visible');
      catchUpBackgroundWork('visible').catch(() => {});
      if (keepAliveConfig.enabled && keepAliveConfig.keepAwake) {
        requestWakeLock().catch(() => {});
      }
    }
  });
  document.addEventListener('freeze', () => {
    recordLifecycleCheckpoint('freeze', { hidden: !!document.hidden });
  });
  document.addEventListener('resume', () => {
    recordLifecycleCheckpoint('resume', { hidden: !!document.hidden });
    if (document.hidden && keepAliveConfig.enabled) startWorker();
    reconcileCloudBackground('resume');
    catchUpBackgroundWork('resume').catch(() => {});
  });
  window.addEventListener('online', () => {
    recordLifecycleCheckpoint('online', { hidden: !!document.hidden });
    reconcileCloudBackground('online');
    catchUpBackgroundWork('online').catch(() => {});
  });
  window.addEventListener('pageshow', () => {
    silentAudioPageUnloading = false;
    silentAudioPageSuspended = false;
    recordLifecycleCheckpoint('pageshow', { hidden: !!document.hidden });
    refreshKeepAliveEnhancements();
    reconcileCloudBackground('pageshow');
    catchUpBackgroundWork('pageshow').catch(() => {});
  });
  window.addEventListener('pagehide', (event) => {
    recordLifecycleCheckpoint('pagehide', { persisted: event?.persisted === true });
    // bfcache：页面还会回来，绝不能拆静音轨。
    if (event?.persisted) {
      silentAudioPageUnloading = false;
      return;
    }
    stopWorker();
    // iOS 划掉 PWA 时常走 pagehide(persisted=false) 且进程短暂挂起，近静音 loop
    // 会继续占着系统音轨/灵动岛，清后台也关不掉，所以这里必须拆轨（偏好保留）。
    // 生成中也不再例外：非 bfcache 的 pagehide 意味着页面即将销毁，页面里的
    // fetch 会跟着一起死，保留音轨救不回请求，只会多留一条残留播放条。
    silentAudioPageUnloading = true;
    silentAudioPageSuspended = true;
    stopSilentAudio({ destroy: true, clearSession: true });
  });
  const handleCurrentUserChanged = () => {
    for (const id of [...timers.keys()]) unscheduleChat(id);
    ensureDefaultUser().then((user) => resyncCurrentSlotChatSchedules(user)).catch(() => {});
  };
  window.addEventListener('current-user-changed', handleCurrentUserChanged);
  window.addEventListener('marshmallow-user-slot-changed', handleCurrentUserChanged);
  window.addEventListener('generation-relay-config-changed', () => {
    import('./cloud-background-coordinator.js')
      .then((mod) => mod.reconcileCloudBackgroundEvents?.('relay-config-changed'))
      .then(() => ensureDefaultUser())
      .then((user) => resyncCurrentSlotChatSchedules(user))
      .catch(() => {});
  });
  // API、角色/世界书编辑通常伴随路由落稳；聊天完成有独立事件。合并刷新后把最新
  // 本地提示词编译为新 revision，云端旧计划会被淘汰。
  window.addEventListener('api-config-changed', scheduleCloudPlanRefresh);
  window.addEventListener('meituan-coupon-reminder-changed', () => {
    triggerMeituanCouponReminder('settings-changed').catch(() => {});
  });
  window.addEventListener(MEMORY_VECTOR_BACKLOG_EVENT, (event) => {
    if (event?.detail?.wake !== true) return;
    scheduleMemoryEmbedBacklog(event.detail.reason || 'queue-changed', {
      delayMs: MEMORY_EMBED_WAKE_DEBOUNCE_MS,
      force: true,
    }).catch(() => {});
  });
  window.addEventListener('api-config-changed', (event) => {
    if (event?.detail?.section !== 'embedding') return;
    scheduleMemoryEmbedBacklog('embedding-config-changed', {
      delayMs: 200,
      force: true,
    }).catch(() => {});
  });
  window.addEventListener('marshmallow-ai-round-complete', scheduleCloudPlanRefresh);
  window.addEventListener('marshmallow-route-settled', scheduleCloudPlanRefresh);
}

export async function initBackgroundScheduler() {
  // Idempotent with app boot. Register here too because tests/embedded runtimes can
  // start the scheduler directly without evaluating the main app entry first.
  installReplyIntentOutboxRecovery({ reason: 'background-scheduler-init' });
  await getBackgroundKeepAliveSettings();
  bindLifecycle();
  ensureLeaderElection();
  const ledger = await getBackgroundTaskLedger().catch(() => null);
  const catchUpCheckpoint = ledger?.checkpoints?.catchUp;
  if (catchUpCheckpoint) {
    lastCatchUpAt = Number(catchUpCheckpoint.at || 0);
    lastCatchUpReason = String(catchUpCheckpoint.reason || '');
    lastCatchUpResult = catchUpCheckpoint;
  }
  lastLifecycleCheckpoint = ledger?.checkpoints?.lifecycle || null;
  await ensureNativeBackgroundWake();
  // Chats killed mid-generation keep a stale "正在输入…" preview; clean up first.
  import('./chat/chat-stream-session.js')
    .then((mod) => mod.recoverStalePendingChatStreams?.())
    .catch(() => {});
  // 必须先应用云端旧 revision 的结果，再用更新后的本地消息编译下一版计划；
  // 反过来会让刚完成的云任务被误判成 stale。
  await import('./cloud-background-coordinator.js')
    .then((mod) => mod.reconcileCloudBackgroundEvents?.('startup'))
    .catch(() => {});
  const user = await ensureDefaultUser();
  await resyncCurrentSlotChatSchedules(user);
  startPhoneProactiveTimer();
  startPhoneChatTimer();
  startShareImpulseProactiveTimer();
  startMemoProactiveTimer();
  startMeituanCouponReminderTimer();
  startPendingActionTimer();
  startIdleContinueTimer();
  startUserInterceptAutoTimer();
  startPeriodProactiveTimer();
  startMailboxProactiveTimer();
  await startDriftBottleProactiveTimer();
  startTravelNotifyTimer();
  startSchedulePruneTimer();
  startDailyScheduleGenTimer();
  startMomentsAutoGenTimer();
  startForumAutoGenTimer();
  initMomentsPostChatTrigger();
  initUserMomentRealPersonFollowup();
  startInterestRotationTimer();
  startInterestProgressSyncTimer();
  startUserSocialWatchTimer();
  startMemoryEmbedBacklogTimer();
  // 冷启动至少稳定两分钟后再看一次积压；恢复前台/pageshow 不再重复唤醒。
  // 新增向量仍可通过 MEMORY_VECTOR_BACKLOG_EVENT 唤醒，但会经过用户活跃避让。
  if (typeof window !== 'undefined') {
    scheduleMemoryEmbedBacklog('startup-deferred', { delayMs: 120_000, force: true }).catch(() => {});
  } else {
    triggerMemoryEmbedBacklog('startup', { force: true }).catch(() => {});
  }
  if (isBackgroundLeader()) {
    await triggerSchedulePrune('startup').catch(() => {});
    await triggerTrackedDailySchedule('startup').catch(() => {});
  }
  await initCompanionRuntime().catch(() => {});
  refreshKeepAliveEnhancements();
  catchUpBackgroundWork('startup').catch(() => {});
}
