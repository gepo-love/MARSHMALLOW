import { runChatAiTurn } from './marshmallow-turn-persist.js';
import { getChat, listMessagesForChat } from '../chat-store.js';
import { getCharacter } from '../character-store.js';
import { buildGapFillSceneMessage, buildRecentBeatSummary } from './thread-scene.js';
import { maybeHandleBusyAutoReply } from '../character-phone-proactive.js';
import { getUserDisplayName } from '../../models/user.js';
import { shouldSuppressAiDelivery } from '../chat-block-state.js';
import { isAnonymousChat } from '../chat-helpers.js';
import { isStrangerInterceptChat } from '../stranger-thread-model.js';
import { getAnonymousDisplayProfile } from '../anonymous-chat.js';
import { loadAnonymousSpaceUserProfile } from '../anonymous-space.js';
import { getAnonymousRuntimeCharacterById } from '../anonymous-character-pool.js';
import { isChatStreamPendingAnywhere } from './chat-stream-session.js';
import { isChatComposerBusy } from './chat-composer-guard.js';
import { getLightweightNpc } from '../lightweight-npc.js';
import { isAllMutedGroup } from '../../models/chat.js';
import {
  buildStatusOpportunityDirective,
  resolveStatusOpportunity,
} from './status-proactive-policy.js';
import { hasActiveVoiceCall } from './voice-call-guard.js';
import { getNowForUser } from '../time-mode.js';
import { acquireGenerationExecutionLock } from './generation-execution-lock.js';

const inFlightChats = new Set();
const inFlightControllers = new Map();
const inFlightHeartbeats = new Map();
const HEADLESS_STATE_PREFIX = 'mm_headless_reply_state_v1:';
const HEADLESS_ABORT_PREFIX = 'mm_headless_reply_abort_v1:';
const HEADLESS_STATE_TTL_MS = 20 * 1000;
const HEADLESS_HEARTBEAT_MS = 5000;
const CATCH_UP_GENERATION_WINDOW_MS = 45 * 1000;
const headlessInstanceId = `headless_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const remoteInFlightChats = new Map();
const visibleReplyChats = new Set();
const typingStartedChats = new Set();
let catchUpGenerationClaimedAt = 0;
const headlessChannel = typeof BroadcastChannel === 'function'
  ? new BroadcastChannel('marshmallow-headless-reply-v1')
  : null;
headlessChannel?.unref?.();

function isFreshConversationMessage(message = {}) {
  const senderId = String(message?.senderId || '').trim();
  return Boolean(
    message
    && senderId
    && senderId !== 'system'
    && String(message.type || '') !== 'system'
    && !message.deleted
    && !message.recalled
    && message.metadata?.aiPlaceholder !== true
  );
}

function conversationMessageIdentity(message = {}, index = 0) {
  const id = String(message?.id || '').trim();
  if (id) return `id:${id}`;
  return [
    'fallback',
    String(message?.senderId || ''),
    String(message?.type || ''),
    String(Number(message?.timestamp || 0) || 0),
    String(message?.content || '').slice(0, 120),
    String(index),
  ].join(':');
}

/** 后台请求开始后任一方又发过可见消息，原请求就已经缺少最新上下文。 */
export function hasConversationChangedSincePrepared(preparedMessages = [], currentMessages = []) {
  const prepared = (Array.isArray(preparedMessages) ? preparedMessages : [])
    .filter(isFreshConversationMessage);
  const current = (Array.isArray(currentMessages) ? currentMessages : [])
    .filter(isFreshConversationMessage);
  if (prepared.length !== current.length) return true;
  const preparedIds = new Set(prepared.map(conversationMessageIdentity));
  return current.some((message, index) => !preparedIds.has(conversationMessageIdentity(message, index)));
}

function stateStorageKey(chatId) {
  return `${HEADLESS_STATE_PREFIX}${encodeURIComponent(String(chatId || '').trim())}`;
}

function abortStorageKey(chatId) {
  return `${HEADLESS_ABORT_PREFIX}${encodeURIComponent(String(chatId || '').trim())}`;
}

function readStoredHeadlessState(chatId) {
  const id = String(chatId || '').trim();
  if (!id || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(stateStorageKey(id));
    const value = raw ? JSON.parse(raw) : null;
    if (!value?.running || Date.now() - Number(value.at || 0) > HEADLESS_STATE_TTL_MS) {
      if (raw) localStorage.removeItem(stateStorageKey(id));
      return null;
    }
    return value;
  } catch (_) {
    return null;
  }
}

function publishHeadlessState(chatId, running) {
  const id = String(chatId || '').trim();
  if (!id) return;
  const payload = {
    type: 'state',
    source: headlessInstanceId,
    chatId: id,
    running: running === true,
    visibleReply: running === true && visibleReplyChats.has(id),
    typingStarted: running === true && typingStartedChats.has(id),
    at: Date.now(),
  };
  try {
    if (typeof localStorage !== 'undefined') {
      if (payload.running) localStorage.setItem(stateStorageKey(id), JSON.stringify(payload));
      else localStorage.removeItem(stateStorageKey(id));
    }
  } catch (_) {}
  try { headlessChannel?.postMessage(payload); } catch (_) {}
}

function clearHeadlessReplyState(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  inFlightChats.delete(id);
  inFlightControllers.delete(id);
  const heartbeat = inFlightHeartbeats.get(id);
  if (heartbeat) clearInterval(heartbeat);
  inFlightHeartbeats.delete(id);
  remoteInFlightChats.delete(id);
  visibleReplyChats.delete(id);
  typingStartedChats.delete(id);
  publishHeadlessState(id, false);
  broadcastHeadlessReplyState(id, false);
}

function handleRemoteHeadlessState(payload = {}) {
  const id = String(payload.chatId || '').trim();
  if (!id || payload.source === headlessInstanceId) return;
  if (payload.running === true) {
    remoteInFlightChats.set(id, Number(payload.at || Date.now()));
    if (payload.visibleReply === true) visibleReplyChats.add(id);
    else visibleReplyChats.delete(id);
    if (payload.typingStarted === true) typingStartedChats.add(id);
    else typingStartedChats.delete(id);
  } else {
    remoteInFlightChats.delete(id);
    visibleReplyChats.delete(id);
    typingStartedChats.delete(id);
  }
  broadcastHeadlessReplyState(id, inFlightChats.has(id) || remoteInFlightChats.has(id));
}

headlessChannel?.addEventListener?.('message', (event) => {
  const payload = event?.data || {};
  const id = String(payload.chatId || '').trim();
  if (!id || payload.source === headlessInstanceId) return;
  if (payload.type === 'probe' && inFlightChats.has(id)) {
    publishHeadlessState(id, true);
    return;
  }
  if (payload.type === 'abort') {
    const controller = inFlightControllers.get(id);
    if (controller && !controller.signal.aborted) {
      try {
        controller.signal.marshmallowAbortReason = payload.abortReason || 'user';
        controller.abort();
      } catch (_) {}
    }
    clearHeadlessReplyState(id);
    return;
  }
  if (payload.type === 'state') handleRemoteHeadlessState(payload);
});

if (typeof window !== 'undefined') {
  window.addEventListener('chat-visible-ai-reply-persisted', (event) => {
    markHeadlessChatReplyVisible(event?.detail?.chatId || '');
  });
  window.addEventListener('storage', (event) => {
    const key = String(event?.key || '');
    if (key.startsWith(HEADLESS_STATE_PREFIX)) {
      const id = decodeURIComponent(key.slice(HEADLESS_STATE_PREFIX.length));
      let payload = null;
      try { payload = event.newValue ? JSON.parse(event.newValue) : null; } catch (_) {}
      handleRemoteHeadlessState(payload || { chatId: id, running: false, source: 'storage' });
      return;
    }
    if (key.startsWith(HEADLESS_ABORT_PREFIX) && event.newValue) {
      const id = decodeURIComponent(key.slice(HEADLESS_ABORT_PREFIX.length));
      const controller = inFlightControllers.get(id);
      try {
        const payload = JSON.parse(event.newValue);
        if (controller && !controller.signal.aborted) {
          controller.signal.marshmallowAbortReason = payload.abortReason || 'user';
          controller.abort();
        }
      } catch (_) {}
      clearHeadlessReplyState(id);
    }
  });
}

function broadcastHeadlessReplyState(chatId, running) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent('headless-chat-reply-state', {
      detail: {
        chatId,
        running: running === true,
        visibleReply: running === true && visibleReplyChats.has(String(chatId || '').trim()),
        typingStarted: running === true && typingStartedChats.has(String(chatId || '').trim()),
        at: Date.now(),
      },
    }));
  } catch (_) {}
}

export function isHeadlessChatReplyRunning(chatId = '') {
  const id = String(chatId || '').trim();
  if (!id) return false;
  if (inFlightChats.has(id)) return true;
  const remoteAt = Number(remoteInFlightChats.get(id) || 0);
  if (remoteAt && Date.now() - remoteAt <= HEADLESS_STATE_TTL_MS) return true;
  if (remoteAt) remoteInFlightChats.delete(id);
  const stored = readStoredHeadlessState(id);
  if (stored?.running) {
    remoteInFlightChats.set(id, Number(stored.at || Date.now()));
    return true;
  }
  try {
    headlessChannel?.postMessage({
      type: 'probe',
      source: headlessInstanceId,
      chatId: id,
      at: Date.now(),
    });
  } catch (_) {}
  return false;
}

export function isHeadlessChatReplyTyping(chatId = '') {
  const id = String(chatId || '').trim();
  if (!id || !isHeadlessChatReplyRunning(id) || visibleReplyChats.has(id)) return false;
  if (typingStartedChats.has(id)) return true;
  const stored = readStoredHeadlessState(id);
  return stored?.typingStarted === true && stored?.visibleReply !== true;
}

export function markHeadlessChatReplyTypingStarted(chatId = '') {
  const id = String(chatId || '').trim();
  if (!id || !isHeadlessChatReplyRunning(id) || visibleReplyChats.has(id)) return false;
  typingStartedChats.add(id);
  publishHeadlessState(id, true);
  broadcastHeadlessReplyState(id, true);
  return true;
}

export function markHeadlessChatReplyVisible(chatId = '') {
  const id = String(chatId || '').trim();
  if (!id || !isHeadlessChatReplyRunning(id)) return false;
  visibleReplyChats.add(id);
  publishHeadlessState(id, true);
  broadcastHeadlessReplyState(id, true);
  return true;
}

export function claimHeadlessChatReply(chatId = '') {
  const id = String(chatId || '').trim();
  if (!id || isHeadlessChatReplyRunning(id)) return null;
  visibleReplyChats.delete(id);
  typingStartedChats.delete(id);
  inFlightChats.add(id);
  publishHeadlessState(id, true);
  broadcastHeadlessReplyState(id, true);
  const heartbeat = setInterval(() => {
    if (inFlightChats.has(id)) publishHeadlessState(id, true);
  }, HEADLESS_HEARTBEAT_MS);
  heartbeat?.unref?.();
  inFlightHeartbeats.set(id, heartbeat);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    if (inFlightHeartbeats.get(id) === heartbeat) inFlightHeartbeats.delete(id);
    inFlightChats.delete(id);
    publishHeadlessState(id, false);
    broadcastHeadlessReplyState(id, false);
  };
}

export function abortHeadlessChatReply(chatId = '', abortReason = 'user') {
  const id = String(chatId || '').trim();
  if (!id) return false;
  const controller = inFlightControllers.get(id);
  let abortedLocal = false;
  if (controller && !controller.signal.aborted) {
    try {
      controller.signal.marshmallowAbortReason = abortReason;
      controller.abort();
      abortedLocal = true;
    } catch (_) {}
  }
  const wasRunning = abortedLocal || isHeadlessChatReplyRunning(id);
  if (!wasRunning) return false;
  const payload = {
    type: 'abort',
    source: headlessInstanceId,
    chatId: id,
    abortReason,
    at: Date.now(),
  };
  // Always notify sibling tabs/webviews: a local controller does not prove it is the only owner.
  try { headlessChannel?.postMessage(payload); } catch (_) {}
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(abortStorageKey(id), JSON.stringify(payload));
      localStorage.removeItem(abortStorageKey(id));
    }
  } catch (_) {}
  clearHeadlessReplyState(id);
  return true;
}

export async function waitForHeadlessChatReplyIdle(chatId = '', timeoutMs = 5000) {
  const id = String(chatId || '').trim();
  if (!id || !isHeadlessChatReplyRunning(id)) return true;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (!isHeadlessChatReplyRunning(id)) return true;
  }
  return !isHeadlessChatReplyRunning(id);
}

function claimCatchUpGeneration(reason = '') {
  if (!/^catch-up:/i.test(String(reason || ''))) return true;
  const now = Date.now();
  if (catchUpGenerationClaimedAt && now - catchUpGenerationClaimedAt < CATCH_UP_GENERATION_WINDOW_MS) {
    return false;
  }
  catchUpGenerationClaimedAt = now;
  return true;
}

export function resolveHeadlessCatchUpTiming(
  chat = null,
  reason = '',
  messages = [],
  worldNow = Date.now(),
  explicitBaseTimestamp = 0,
) {
  const isCatchUp = /^catch-up:/i.test(String(reason || ''));
  // 后台 catch-up 只是在 App 恢复后「现在」补执行一次生成；一轮里即使有多个气泡，
  // 也不能把它们均匀摊进整段离线历史，伪造成角色每隔数小时主动联系过一次。
  // 真正需要历史分布的“闲聊补充”由前台手动入口显式传 gapFillWindow，不走这里。
  const shouldFillGap = false;
  const nowTs = Number(worldNow || 0) || Date.now();
  return {
    isCatchUp,
    shouldFillGap,
    lastTs: 0,
    gapMs: 0,
    baseTimestamp: Number(explicitBaseTimestamp || 0) || nowTs,
    gapFillWindow: null,
  };
}

async function resolveProactivePermission(chat, user, options = {}) {
  const channel = String(options.proactiveChannel || '').trim();
  if (!channel) return { ok: true, actorId: '' };
  // 群聊“后台自动推进”有自己独立的会话开关，不属于某一个角色的主动总开关。
  if (options.proactivePermissionRequired === false) return { ok: true, actorId: '' };
  const actorId = String(
    options.onlySenderId
    || (chat?.participants || []).find((id) => id && id !== 'user')
    || '',
  ).trim();
  if (!actorId) return { ok: false, reason: 'missing-proactive-actor' };
  try {
    const { loadResolvedCharacterAutonomyPolicy } = await import('../character-autonomy-settings.js');
    const policy = await loadResolvedCharacterAutonomyPolicy(user?.id, actorId, chat?.id || '');
    return policy?.totalEnabled === true
      ? { ok: true, actorId, policy }
      : { ok: false, reason: 'proactive-disabled', actorId, policy };
  } catch (_) {
    // 主动消息是可选后台行为：设置读不到时宁可停发，不能绕过用户已经关闭的总开关。
    return { ok: false, reason: 'proactive-policy-unavailable', actorId };
  }
}

async function resolveOfflineReturnProactiveBridge(chat, user, messages = [], options = {}) {
  const channel = String(options.proactiveChannel || '').trim();
  if (!channel || options.offlineReturnBridge === true) return { mode: 'normal' };
  if (!chat?.id || !user?.id || chat.type === 'group' || isAnonymousChat(chat)) return { mode: 'normal' };
  const actorId = String(
    options.onlySenderId
    || (chat.participants || []).find((id) => id && id !== 'user')
    || '',
  ).trim();
  if (!actorId) return { mode: 'normal' };
  try {
    const [{ listOfflineDateArchives }, returnContext] = await Promise.all([
      import('../offline-date-archive.js'),
      import('../memory/offline-return-context.js'),
    ]);
    const archives = await listOfflineDateArchives(user.id, { characterId: actorId }).catch(() => []);
    const state = returnContext.resolveOfflineReturnProactiveState({
      archives,
      characterIds: [actorId],
      messages,
      now: Date.now(),
    });
    return {
      ...state,
      actorId,
      directive: state.mode === 'bridge'
        ? returnContext.buildOfflineReturnProactiveDirective()
        : '',
    };
  } catch (_) {
    // 返线上状态读取失败时仍由普通完整上下文兜底，不能让所有后台消息永久停摆。
    return { mode: 'normal', reason: 'offline-return-state-unavailable', actorId };
  }
}

/**
 * 构建后台回复所需的完整本地上下文，但不调用模型。
 * Cloudflare 定时协调器会在 App 活跃时提前编译请求；真正到点后仅由 Worker 调上游。
 */
export async function prepareHeadlessChatReply(chat, user, options = {}) {
  if (!chat?.id || !user?.id) return { ok: false, reason: 'missing-chat-or-user' };
  if (options.ignoreComposerBusy !== true && isChatComposerBusy(chat.id)) {
    return { ok: false, reason: 'composer-active' };
  }
  // 用户正在这个会话里手动推进/生成时，后台的定时/主动补聊不该再插一轮抢跑——
  // 否则前后台各生成一轮，上下文几乎没变，很容易复述出高度相似甚至一样的内容。
  if (isChatStreamPendingAnywhere(chat.id)) return { ok: false, reason: 'foreground-streaming' };
  const fresh = await getChat(chat.id);
  if (!fresh?.autoActive && options.allowInactive !== true) return { ok: false, reason: 'auto-disabled' };
  if (isAllMutedGroup(fresh)) return { ok: false, reason: 'all-muted' };
  // 漂流瓶等通道需要在拉黑状态下仍可生成（消息落库后仍会打拒收红叹号）。
  if (options.allowBlocked !== true) {
    const blocked = await shouldSuppressAiDelivery(fresh);
    if (blocked.blocked) return { ok: false, reason: blocked.reason || 'blocked-by-user', blocked: true };
  }
  const proactivePermission = await resolveProactivePermission(fresh, user, options);
  if (!proactivePermission.ok) {
    return { ok: false, skipped: true, reason: proactivePermission.reason || 'proactive-disabled' };
  }
  // 所有无用户新消息触发的后台通道统一经过线下门禁。各调度器仍保留自己的早期短路，
  // 这里负责兜住已经排队、跨入口或未来新增的主动任务，避免角色人在线下却又从线上冒泡。
  if (String(options.proactiveChannel || '').trim()) {
    const proactiveActorId = String(
      proactivePermission.actorId
      || options.onlySenderId
      || (fresh.participants || []).find((id) => id && id !== 'user')
      || '',
    ).trim();
    if (proactiveActorId) {
      try {
        const { isCharacterBusyInOfflineSession } = await import('../character-phone-proactive.js');
        if (await isCharacterBusyInOfflineSession(user.id, proactiveActorId)) {
          return { ok: false, skipped: true, reason: 'active-offline-session' };
        }
      } catch (_) { /* 线下状态读不到时仍交给调用方的投递门禁复核 */ }
    }
  }
  const { loadChatPrefs } = await import('../chat-block-state.js');
  const prefs = await loadChatPrefs(fresh.id).catch(() => ({}));
  if (prefs.guidanceMode === true) return { ok: false, reason: 'guidance-mode' };
  if (options.bypassHardOffline !== true) {
    try {
      const { isHardOfflineActiveForChat } = await import('./real-person-hard-offline.js');
      const hardOffline = await isHardOfflineActiveForChat(user.id, fresh, Date.now(), { prefs });
      if (hardOffline) {
        return {
          ok: false,
          skipped: true,
          reason: 'hard-offline-active',
          hardOfflineUntilAt: hardOffline.untilAt,
        };
      }
    } catch (_) { /* 完全下线状态读不到时不误伤普通后台回复 */ }
  }
  const messages = await listMessagesForChat(chat.id);
  // 通话是同一角色的前台实时会话。期间后台主动、追发、补聊都必须让路，
  // 否则会并行生成普通聊天气泡，还可能把通话上下文标签照抄给用户。
  if (hasActiveVoiceCall(messages)) {
    return { ok: false, skipped: true, reason: 'active-voice-call' };
  }
  const offlineReturnProactive = await resolveOfflineReturnProactiveBridge(fresh, user, messages, options);
  if (offlineReturnProactive.mode === 'defer') {
    return {
      ok: false,
      skipped: true,
      reason: offlineReturnProactive.reason || 'offline-return-proactive-cooldown',
      retryAt: Number(offlineReturnProactive.retryAt || 0) || 0,
      offlineReturnArchiveId: String(offlineReturnProactive.archiveId || ''),
    };
  }
  const isOfflineReturnBridge = offlineReturnProactive.mode === 'bridge';
  const offlineReturnBridgeDirective = isOfflineReturnBridge
    ? String(offlineReturnProactive.directive || '').trim()
    : '';
  const reason = String(options.reason || '').trim();
  let statusOpportunity = null;
  let statusOpportunityDirective = '';
  const statusActorId = (fresh.participants || []).find((id) => id && id !== 'user');
  if (reason && statusActorId && fresh.type !== 'group' && !isStrangerInterceptChat(fresh)) {
    try {
      const { loadResolvedCharacterAutonomyPolicy } = await import('../character-autonomy-settings.js');
      const { loadCharacterLiveState } = await import('../character-live-state.js');
      const policy = await loadResolvedCharacterAutonomyPolicy(user.id, statusActorId, fresh.id);
      const liveState = await loadCharacterLiveState(user.id, statusActorId).catch(() => null);
      const actorAllowsStatusText = liveState?.policy?.aiUpdatesAllowed !== false
        && liveState?.policy?.manualLocked !== true;
      const actorAllowsPresence = liveState?.policy?.presenceUpdatesAllowed !== false
        && liveState?.policy?.presenceManualLocked !== true;
      const chatAllowsStatusText = Object.prototype.hasOwnProperty.call(prefs, 'allowAiStatusTextUpdates')
        ? prefs.allowAiStatusTextUpdates !== false
        : prefs.allowAiStatusUpdates !== false;
      const chatAllowsPresence = Object.prototype.hasOwnProperty.call(prefs, 'allowAiPresenceUpdates')
        ? prefs.allowAiPresenceUpdates !== false
        : prefs.allowAiStatusUpdates !== false;
      if (
        policy?.realPersonMode?.enabled === true
        && ((chatAllowsStatusText && actorAllowsStatusText)
          || (chatAllowsPresence && actorAllowsPresence))
      ) {
        const liveStatusLine = liveState?.statusLine && typeof liveState.statusLine === 'object'
          ? liveState.statusLine
          : null;
        const liveStatusText = String(liveStatusLine?.text || '').trim();
        statusOpportunity = resolveStatusOpportunity({
          prefs: {
            ...prefs,
            // 角色级状态一旦可读就是唯一真源；空/过期不能再被旧会话文案回填。
            statusText: liveStatusLine ? liveStatusText : (prefs.statusText || ''),
            statusUpdatedAt: liveStatusLine && liveStatusText
              ? (Number(liveStatusLine.updatedAt || 0) || 0)
              : (liveStatusLine ? 0 : (Number(prefs.statusUpdatedAt || 0) || 0)),
            statusExpiredAt: liveStatusLine
              ? (Number(liveStatusLine.expiredAt || 0) || 0)
              : (Number(prefs.statusExpiredAt || 0) || 0),
          },
          realPersonMode: policy.realPersonMode,
          reason,
          now: Date.now(),
        });
        statusOpportunityDirective = buildStatusOpportunityDirective(statusOpportunity, {
          scheduleDriven: /schedule-proactive/i.test(reason),
        });
      }
    } catch (_) { /* 状态机会读取失败不阻塞后台回复 */ }
  }
  const worldNow = await getNowForUser(user.id);
  const {
    gapMs,
    baseTimestamp,
    gapFillWindow,
    shouldFillGap,
  } = resolveHeadlessCatchUpTiming(
    fresh,
    reason,
    messages,
    worldNow,
    options.baseTimestamp,
  );
  const gapExtraHint = shouldFillGap
    ? '这是 app 在后台期间自动补发的断档闲聊，不要提“系统/后台/自动”这类词，完全从角色视角自然发起。'
    : '';
  const characters = {};
  await Promise.all((fresh.participants || []).filter((id) => id && id !== 'user').map(async (id) => {
    characters[id] = await getCharacter(id, { userId: user.id });
    if (!characters[id]) {
      characters[id] = await getLightweightNpc(id, user.id).catch(() => null);
    }
    if (!characters[id] && isAnonymousChat(fresh)) {
      characters[id] = await getAnonymousRuntimeCharacterById(id).catch(() => null);
    }
  }));
  const missingParticipantIds = (fresh.participants || [])
    .filter((id) => id && id !== 'user' && !characters[id]);
  if (missingParticipantIds.length) {
    // 后台入口必须在生成前重新核验角色。角色删除与定时器/原生唤醒可能并发，
    // 旧会话即使因历史清理失败仍残留，也不能再靠 id 兜底成人设为空的“幽灵角色”。
    return {
      ok: false,
      reason: 'missing-character',
      missingParticipantIds,
    };
  }
  const anonymousChat = isAnonymousChat(fresh);
  const externalUserName = getUserDisplayName(user);
  const anonymousSpaceProfile = anonymousChat
    ? await loadAnonymousSpaceUserProfile(user.id).catch(() => null)
    : null;
  const anonymousUserName = anonymousChat
    ? String(getAnonymousDisplayProfile(fresh, 'user', {
      currentUserName: externalUserName,
      spaceProfile: anonymousSpaceProfile,
    })?.anonymousId || '').trim()
    : '';
  const currentUserName = anonymousChat
    ? (anonymousUserName && anonymousUserName !== externalUserName ? anonymousUserName : '匿名网友')
    : externalUserName;
  const resolveSenderName = async (id) => {
    if (id === 'user') return currentUserName;
    if (anonymousChat) {
      const profile = getAnonymousDisplayProfile(fresh, id, {
        currentUserName: externalUserName,
        spaceProfile: anonymousSpaceProfile,
      });
      if (profile?.anonymousId) return profile.anonymousId;
    }
    const c = characters[id];
    return String(c?.customNickname || c?.name || id);
  };
  let busyWakeDirective = '';
  let tagBusyFauxAutoReply = false;
  if (options.skipBusyAutoReply !== true) {
    const busyReply = await maybeHandleBusyAutoReply({
      chat: fresh,
      user,
      messages,
      characters,
      resolveSenderName,
      currentUserName,
      // prepare 期间上下文读取较多；系统留言落库前重新读取共享输入态。
      deliveryGuard: () => !isChatComposerBusy(fresh.id),
    });
    if (busyReply?.handled) return busyReply;
    // 忙碌被戳醒：这一轮走真实回复，带上「忙里偷闲冒头」的场景提示。
    if (busyReply?.breakThrough && busyReply.directive) {
      busyWakeDirective = busyReply.directive;
    }
    if (busyReply?.fauxAutoReply && busyReply.directive) {
      busyWakeDirective = [busyWakeDirective, busyReply.directive].filter(Boolean).join('\n\n');
      tagBusyFauxAutoReply = true;
    }
  }
  if (options.apiBudgetConsumed !== true && reason) {
    const actorId = (fresh.participants || []).find((id) => id && id !== 'user');
    if (actorId && fresh.type !== 'group') {
      try {
        const [{ loadResolvedCharacterAutonomyPolicy }, { consumeCharacterApiBudget }] = await Promise.all([
          import('../character-autonomy-settings.js'),
          import('../character-api-budget.js'),
        ]);
        const policy = await loadResolvedCharacterAutonomyPolicy(user.id, actorId, fresh.id);
        if (policy?.realPersonMode?.enabled === true) {
          const budget = await consumeCharacterApiBudget({
            userId: user.id,
            characterId: actorId,
            chatId: fresh.id,
            category: options.apiBudgetCategory || 'background_reply',
            policy,
          });
          if (!budget?.ok) return { ok: false, reason: budget?.reason || 'budget-unavailable' };
        }
      } catch (error) {
        console.warn('[headless-reply] budget check failed', error);
      }
    }
  }
  return {
    ok: true,
    prepared: {
      chat: fresh,
      chatId: fresh.id,
      user,
      userId: user.id,
      messages,
      characters,
      resolveSenderName,
      sceneDirective: isOfflineReturnBridge
        ? offlineReturnBridgeDirective
        : [
          options.sceneDirective || buildGapFillSceneMessage(fresh, currentUserName, {
            gapMs,
            extraHint: gapExtraHint,
            recentBeat: buildRecentBeatSummary(messages),
          }).content,
          busyWakeDirective,
          statusOpportunityDirective,
        ].filter(Boolean).join('\n\n'),
      baseTimestamp,
      gapFillWindow,
      aiRoundKind: String(options.aiRoundKind || (gapFillWindow ? 'gap' : 'advance')),
      aiRoundId: String(options.generationAiRoundId || options.aiRoundId || '').trim() || undefined,
      aiRoundCreatedAt: Number(options.aiRoundCreatedAt || 0) || undefined,
      generationTaskId: String(options.generationTaskId || '').trim(),
      generationIdempotencyKey: String(options.generationIdempotencyKey || '').trim(),
      sourceActionId: String(options.sourceActionId || '').trim(),
      generationAnchorMessageId: String(options.generationAnchorMessageId || '').trim(),
      generationAnchorTimestamp: Number(options.generationAnchorTimestamp || 0),
      phoneViewerId: String(options.phoneViewerId || ''),
      onlySenderId: String(options.onlySenderId || ''),
      preferStream: options.preferStream,
      maxTokens: options.maxTokens,
      signal: options.signal,
      deliveryGuard: async () => {
        if (options.ignoreComposerBusy !== true && isChatComposerBusy(chat.id)) {
          return { ok: false, reason: 'composer-active' };
        }
        const permission = await resolveProactivePermission(fresh, user, options);
        if (!permission.ok) {
          return { ok: false, reason: permission.reason || 'proactive-disabled' };
        }
        let currentMessages = null;
        try {
          currentMessages = await listMessagesForChat(fresh.id);
        } catch (_) {
          return { ok: false, reason: 'conversation-state-unavailable' };
        }
        if (hasConversationChangedSincePrepared(messages, currentMessages)) {
          return { ok: false, reason: 'conversation-message-collision' };
        }
        return { ok: true };
      },
      reason: String(options.reason || ''),
      proactiveChannel: String(options.proactiveChannel || ''),
      proactiveMotive: isOfflineReturnBridge
        ? 'offline-return'
        : String(options.proactiveMotive || ''),
      proactiveReservationId: String(options.proactiveReservationId || ''),
      offlineReturnBridge: isOfflineReturnBridge,
      offlineReturnArchiveId: isOfflineReturnBridge
        ? String(offlineReturnProactive.archiveId || '')
        : '',
      statusOpportunity,
      suppressVisibleMessages: options.suppressVisibleMessages === true,
      allowedSideEffectTypes: Array.isArray(options.allowedSideEffectTypes)
        ? [...options.allowedSideEffectTypes]
        : null,
      realPersonChase: options.realPersonChase === true
        || /chase-beat|real-person-chase/i.test(String(options.reason || '')),
      skipChaseAutoSchedule: options.skipChaseAutoSchedule === true,
      // prepare 里已处理过忙碌门禁 / 戳醒 / 假装自动回复时，避免 runChatAiTurn 再跑一遍被 already-replied 吃掉。
      skipBusyAutoReply: Boolean(busyWakeDirective) || tagBusyFauxAutoReply,
      tagBusyFauxAutoReply,
    },
  };
}

export async function runHeadlessChatReply(chat, user, options = {}) {
  const chatId = String(chat?.id || '').trim();
  const releaseClaim = claimHeadlessChatReply(chatId);
  if (!releaseClaim) {
    return {
      ok: false,
      reason: 'headless-in-flight',
      modelRequestAttempted: false,
      requestNotStarted: true,
    };
  }
  const executionLease = await acquireGenerationExecutionLock(chatId);
  if (!executionLease) {
    releaseClaim();
    return {
      ok: false,
      reason: 'headless-in-flight',
      modelRequestAttempted: false,
      requestNotStarted: true,
    };
  }
  const controller = new AbortController();
  inFlightControllers.set(chatId, controller);
  const externalSignal = options.signal;
  const relayExternalAbort = () => {
    try {
      controller.signal.marshmallowAbortReason = externalSignal?.marshmallowAbortReason || 'external';
      controller.abort();
    } catch (_) {}
  };
  if (externalSignal?.aborted) relayExternalAbort();
  else externalSignal?.addEventListener?.('abort', relayExternalAbort, { once: true });
  let proactiveReservation = null;
  let proactiveActorId = '';
  let modelRequestAttempted = false;
  let aiTurnEntered = false;
  try {
    const result = await prepareHeadlessChatReply(chat, user, {
      ...options,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    if (!result?.ok || !result.prepared) {
      if (options.proactiveChannel) {
        proactiveActorId = (chat?.participants || []).find((id) => id && id !== 'user') || '';
        const { recordProactiveOutcome } = await import('../character-proactive-usage.js');
        await recordProactiveOutcome({
          userId: user?.id,
          characterId: proactiveActorId,
          chatId,
          channel: options.proactiveChannel,
          // 还没发出模型请求就被配置、线下、角色缺失等门禁拦下，只是“未调用”，
          // 不能算 API 失败；否则用户会把正常暂缓误判成接口故障。
          status: 'skipped',
          reason: result?.reason || 'prepare-failed',
        }).catch(() => {});
      }
      return {
        ...result,
        skipped: true,
        modelRequestAttempted: false,
        requestNotStarted: true,
      };
    }
    // prepare 期间用户可能刚好在前台点了推进/重生成；发请求前再核验一次。
    if (options.ignoreComposerBusy !== true && isChatComposerBusy(chatId)) {
      return {
        ok: false,
        skipped: true,
        reason: 'composer-active',
        modelRequestAttempted: false,
        requestNotStarted: true,
      };
    }
    if (isChatStreamPendingAnywhere(chatId)) {
      return {
        ok: false,
        skipped: true,
        reason: 'foreground-streaming',
        modelRequestAttempted: false,
        requestNotStarted: true,
      };
    }
    if (options.bypassCatchUpGenerationCap !== true && !claimCatchUpGeneration(options.reason)) {
      return {
        ok: false,
        skipped: true,
        reason: 'catch-up-generation-cap',
        modelRequestAttempted: false,
        requestNotStarted: true,
      };
    }
    proactiveActorId = (result.prepared.chat?.participants || []).find((id) => id && id !== 'user') || '';
    if (options.proactiveChannel && proactiveActorId && options.proactiveQuotaRequired !== false) {
      const { reserveProactiveDelivery } = await import('../character-proactive-usage.js');
      proactiveReservation = await reserveProactiveDelivery({
        userId: user.id,
        characterId: proactiveActorId,
        chatId,
        channel: options.proactiveChannel,
        reason: options.reason || '',
        idempotencyKey: options.proactiveIdempotencyKey || '',
        requireTotalEnabled: options.proactivePermissionRequired !== false,
      });
      if (!proactiveReservation?.ok) {
        return {
          ok: false,
          skipped: true,
          reason: proactiveReservation?.reason || 'daily-limit-reached',
          retryAt: Number(proactiveReservation?.retryAt || 0) || 0,
          modelRequestAttempted: false,
          requestNotStarted: true,
        };
      }
      result.prepared.proactiveReservationId = proactiveReservation.reservationId;
    }
    if (controller.signal.aborted) {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    markHeadlessChatReplyTypingStarted(chatId);
    const preparedRequestStat = result.prepared.onRequestStat;
    // 从这里开始，异常若没有 request stat 就无法证明请求是否已经离开设备。
    // 这种 submitted_unknown 必须保守保留上层幂等 claim，不能自动再付费。
    aiTurnEntered = true;
    let generated = await runChatAiTurn({
      ...result.prepared,
      onRequestStat: (stat) => {
        modelRequestAttempted = true;
        if (typeof preparedRequestStat === 'function') preparedRequestStat(stat);
      },
    });
    if (
      options.proactiveChannel
      && generated?.reason === 'proactive-near-duplicate'
    ) {
      generated = {
        ...generated,
        ok: true,
        skipped: true,
        reason: 'proactive-duplicate-suppressed',
        duplicateSuppressed: true,
        terminal: true,
        messages: [],
        messageCount: 0,
      };
    }
    if (proactiveReservation?.ok) {
      const { settleProactiveDelivery } = await import('../character-proactive-usage.js');
      await settleProactiveDelivery({
        userId: user.id,
        characterId: proactiveActorId,
        reservationId: proactiveReservation.reservationId,
        ok: generated?.ok === true,
        skipped: generated?.skipped === true,
        reason: generated?.reason || '',
        messageCount: generated?.messageCount || generated?.messages?.length || 0,
        error: generated?.error || generated?.message || '',
        rawText: generated?.rawText || '',
        reasoningText: generated?.reasoningText || generated?.upstreamMeta?.reasoningText || '',
        responseText: generated?.responseText || '',
        finishReason: generated?.finishReason || generated?.upstreamMeta?.finishReason || '',
        requestModel: generated?.requestModel || generated?.upstreamMeta?.requestModel || '',
        requestStream: generated?.requestStream ?? generated?.upstreamMeta?.requestStream ?? null,
        statusCode: generated?.status || generated?.upstreamMeta?.status || 0,
      }).catch(() => {});
      proactiveReservation = null;
    }
    if (modelRequestAttempted || generated?.modelRequestAttempted === true) {
      return { ...generated, modelRequestAttempted: true };
    }
    // runChatAiTurn 正常返回且从未上报 request stat，说明它在自己的请求前门禁
    // （如 blocked / busy short-circuit）结束；这与抛异常后的未知提交状态不同。
    return {
      ...generated,
      modelRequestAttempted: false,
      requestNotStarted: true,
    };
  } catch (error) {
    if (proactiveReservation?.ok) {
      const { settleProactiveDelivery } = await import('../character-proactive-usage.js');
      await settleProactiveDelivery({
        userId: user?.id,
        characterId: proactiveActorId,
        reservationId: proactiveReservation.reservationId,
        ok: false,
        reason: error?.message || 'generation-failed',
        error: error?.message || String(error),
        rawText: error?.rawText || error?.rawResponse || '',
        reasoningText: error?.reasoningText || error?.upstreamMeta?.reasoningText || '',
        responseText: error?.responseText || '',
        finishReason: error?.finishReason || error?.upstreamMeta?.finishReason || '',
        requestModel: error?.requestModel || error?.upstreamMeta?.requestModel || '',
        requestStream: error?.requestStream ?? error?.upstreamMeta?.requestStream ?? null,
        statusCode: error?.status || error?.upstreamMeta?.status || 0,
      }).catch(() => {});
      proactiveReservation = null;
    }
    if (controller.signal.aborted) {
      const aborted = {
        ok: false,
        aborted: true,
        abortReason: controller.signal.marshmallowAbortReason || 'user',
        reason: 'aborted',
      };
      if (modelRequestAttempted) return { ...aborted, modelRequestAttempted: true };
      if (!aiTurnEntered) {
        return {
          ...aborted,
          modelRequestAttempted: false,
          requestNotStarted: true,
        };
      }
      return aborted;
    }
    if (!aiTurnEntered) {
      if (error && typeof error === 'object') {
        error.modelRequestAttempted = false;
        error.requestNotStarted = true;
        throw error;
      }
      const preflightError = new Error(String(error || 'headless preflight failed'));
      preflightError.modelRequestAttempted = false;
      preflightError.requestNotStarted = true;
      throw preflightError;
    }
    if (modelRequestAttempted && error && typeof error === 'object') {
      error.modelRequestAttempted = true;
    }
    throw error;
  } finally {
    externalSignal?.removeEventListener?.('abort', relayExternalAbort);
    if (inFlightControllers.get(chatId) === controller) inFlightControllers.delete(chatId);
    executionLease.release();
    releaseClaim();
  }
}
