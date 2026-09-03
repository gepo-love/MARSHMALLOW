/**
 * 闲置片刻后自动续聊：
 * 用户发完消息后，从「不再点输入框」开始计时；到点且仍在等回复时自动回一轮。
 * 本地保活/回前台补跑都能触发；有 Cloudflare 中继时额外镜像成一次性云计划。
 */

import { patchChatPrefs, loadChatPrefs } from '../chat-block-state.js';
import { getChat, listChatsForUser, listMessagesForChat } from '../chat-store.js';
import { isAllMutedGroup } from '../../models/chat.js';
import { isChatStreaming } from './chat-stream-session.js';
import { runHeadlessChatReply } from './headless-reply.js';
import { notifyHeadlessChatIfEnabled } from '../native-notifications.js';
import {
  getPacingNowForUser,
  getTimeMode,
  TIME_MODE_VIRTUAL,
} from '../time-mode.js';
import {
  acquireCharacterAutonomyGuard,
  characterIdForAutonomyChat,
  isCharacterAutonomyMutedNow,
  loadResolvedCharacterAutonomyPolicy,
  releaseCharacterAutonomyGuard,
} from '../character-autonomy-settings.js';

export const IDLE_CONTINUE_MIN_MINUTES = 1;
// 与会话自动推进间隔一致：最多一天，不再卡死在 30 分钟。
export const IDLE_CONTINUE_MAX_MINUTES = 24 * 60;
export const IDLE_CONTINUE_DEFAULT_MINUTES = 3;
export const IDLE_CONTINUE_CHECK_MS = 30 * 1000;

const COMPOSER_STATE_KEY = 'mmIdleContinueComposerV1';
const SUPPRESSED_ANCHOR_KEY = 'mmIdleContinueSuppressedAnchorV1';
const inFlight = new Set();
// focused 只对当前 JS 生命周期有效。localStorage 用来保留 idleSince，但不能让
// App 被杀前的焦点状态在重启后继续挡住后台续聊。
const runtimeActiveComposers = new Set();

function clean(value) {
  return String(value ?? '').trim();
}

function readComposerStateMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPOSER_STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeComposerStateMap(map) {
  try {
    localStorage.setItem(COMPOSER_STATE_KEY, JSON.stringify(map || {}));
  } catch (_) {}
}

function readSuppressedAnchorMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SUPPRESSED_ANCHOR_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeSuppressedAnchorMap(map) {
  try {
    localStorage.setItem(SUPPRESSED_ANCHOR_KEY, JSON.stringify(map || {}));
  } catch (_) {}
}

function isIdleContinueAnchorSuppressed(chatId, anchor = {}) {
  const id = clean(chatId);
  if (!id) return false;
  const row = readSuppressedAnchorMap()[id];
  if (!row || typeof row !== 'object') return false;
  const messageId = clean(anchor.messageId);
  if (messageId && clean(row.messageId) === messageId) return true;
  return !messageId
    && Number(anchor.messageTs || 0) > 0
    && Number(row.messageTs || 0) === Number(anchor.messageTs || 0);
}

/**
 * 用户亲手停止自动生成后，当前这条用户消息不再重新武装闲置续聊。
 * 下一条新消息会产生新的锚点，因此无需额外“恢复”开关。
 */
export function suppressIdleContinueForCurrentAnchor(chatId, messages = [], at = Date.now()) {
  const id = clean(chatId);
  const last = lastVisibleChatMessage(messages);
  if (!id || !last || String(last.senderId || '') !== 'user') return false;
  const map = readSuppressedAnchorMap();
  map[id] = {
    messageId: clean(last.id),
    messageTs: Number(last.timestamp || 0) || 0,
    at: Math.max(0, Number(at) || Date.now()),
  };
  writeSuppressedAnchorMap(map);
  return true;
}

/** 正在点输入框：暂停计时，并记录最近一次真实输入活动。 */
export function markChatComposerActive(chatId, options = {}) {
  const id = clean(chatId);
  if (!id) return;
  runtimeActiveComposers.add(id);
  const map = readComposerStateMap();
  const prev = map[id] && typeof map[id] === 'object' ? map[id] : {};
  const now = Math.max(0, Number(options.activityAt || 0) || Date.now());
  map[id] = {
    focused: true,
    idleSince: 0,
    activityAt: now,
    hasDraft: typeof options.hasDraft === 'boolean'
      ? options.hasDraft
      : prev.hasDraft === true,
    updatedAt: now,
  };
  writeComposerStateMap(map);
}

/** 更新草稿占用态，但不凭一次脚本赋值把已经失焦的输入框重新标成 focused。 */
export function markChatComposerDraft(chatId, hasDraft, at = Date.now()) {
  const id = clean(chatId);
  if (!id) return;
  const map = readComposerStateMap();
  const prev = map[id] && typeof map[id] === 'object' ? map[id] : {};
  const now = Math.max(0, Number(at) || Date.now());
  const focused = prev.focused === true && runtimeActiveComposers.has(id);
  map[id] = {
    focused,
    idleSince: focused ? 0 : Math.max(0, Number(prev.idleSince || 0) || 0),
    activityAt: now,
    hasDraft: hasDraft === true,
    updatedAt: now,
  };
  writeComposerStateMap(map);
}

/**
 * 不再点输入（失焦 / 离开会话 / 退后台）：从此刻开始计时。
 */
export function markChatComposerIdle(chatId, at = Date.now()) {
  const id = clean(chatId);
  if (!id) return;
  runtimeActiveComposers.delete(id);
  const map = readComposerStateMap();
  const prev = map[id] && typeof map[id] === 'object' ? map[id] : {};
  // 已在 idle 且时间更早的，保留更早锚点，避免短暂 focusout 抖动把计时推后。
  const prevIdle = Number(prev.idleSince || 0);
  const nextIdle = prev.focused === true || !prevIdle
    ? Math.max(0, Number(at) || Date.now())
    : Math.min(prevIdle, Math.max(0, Number(at) || Date.now()));
  map[id] = {
    focused: false,
    idleSince: nextIdle,
    activityAt: Math.max(0, Number(prev.activityAt || prev.updatedAt || 0) || 0),
    hasDraft: prev.hasDraft === true,
    updatedAt: Date.now(),
  };
  writeComposerStateMap(map);
}

/**
 * 软键盘真正收起：从这一刻重新计算“停止输入”等待，而不是沿用发送消息时的旧时间。
 * 单独建入口，避免普通 focusout 抖动反复把计时往后推。
 */
export function markChatComposerKeyboardDismissed(chatId, at = Date.now()) {
  const id = clean(chatId);
  if (!id) return;
  const now = Math.max(0, Number(at) || Date.now());
  runtimeActiveComposers.delete(id);
  const map = readComposerStateMap();
  const prev = map[id] && typeof map[id] === 'object' ? map[id] : {};
  map[id] = {
    focused: false,
    idleSince: now,
    activityAt: now,
    hasDraft: prev.hasDraft === true,
    updatedAt: now,
  };
  writeComposerStateMap(map);
}

export function getChatComposerState(chatId) {
  const id = clean(chatId);
  const row = readComposerStateMap()[id];
  if (!row || typeof row !== 'object') {
    return { focused: false, idleSince: 0, activityAt: 0, hasDraft: false };
  }
  return {
    focused: row.focused === true && runtimeActiveComposers.has(id),
    idleSince: Math.max(0, Number(row.idleSince || 0) || 0),
    activityAt: Math.max(0, Number(row.activityAt || row.updatedAt || 0) || 0),
    hasDraft: row.hasDraft === true,
  };
}

export function isChatComposerActive(chatId) {
  return getChatComposerState(chatId).focused === true;
}

/**
 * 真人感待办只避让「有草稿」或最近仍在操作的输入框。
 * 移动端 WebView 偶尔会残留焦点/键盘状态，不能因此永久挡住已到点的回复。
 */
export function evaluateChatComposerActivityState(state = {}, options = {}) {
  const now = Math.max(0, Number(options.now || 0) || Date.now());
  const settleMs = Math.max(200, Number(options.settleMs || 0) || 2500);
  if (state?.hasDraft === true) {
    return {
      blocked: true,
      reason: 'draft',
      retryAt: now + 30 * 1000,
    };
  }
  const activityAt = Math.max(0, Number(state?.activityAt || 0) || 0);
  const retryAt = activityAt + settleMs;
  // Android 收起键盘后运行期 focused 也可能残留；只避让最近确有输入活动的窗口。
  if (activityAt > 0 && now < retryAt) {
    return {
      blocked: true,
      reason: 'recent-activity',
      retryAt,
    };
  }
  return { blocked: false, reason: '', retryAt: 0 };
}

export function evaluateChatComposerActivity(chatId, options = {}) {
  return evaluateChatComposerActivityState(getChatComposerState(chatId), options);
}

export function normalizeIdleContinueSettings(input = {}) {
  const enabled = input.idleContinueEnabled === true || input.enabled === true;
  let minutes = Math.trunc(Number(
    input.idleContinueMinutes != null ? input.idleContinueMinutes : input.minutes,
  ));
  if (!Number.isFinite(minutes)) minutes = IDLE_CONTINUE_DEFAULT_MINUTES;
  minutes = Math.max(IDLE_CONTINUE_MIN_MINUTES, Math.min(IDLE_CONTINUE_MAX_MINUTES, minutes));
  return { enabled, minutes, intervalMs: minutes * 60_000 };
}

export async function loadIdleContinueSettings(chatId) {
  const prefs = await loadChatPrefs(chatId).catch(() => ({}));
  return normalizeIdleContinueSettings(prefs);
}

// 真人感隐式续聊的分钟数：跟回复频率档走，而不是共用固定默认值。
const IMPLICIT_IDLE_MINUTES_BY_FREQUENCY = { high: 2, normal: 4, low: 8 };

/**
 * 有效闲置续聊设置：真人感开着的私聊隐式生效，不需要用户再开一个开关。
 * 分钟数跟回复频率档走；TA 自己登记过 next_reply_delay（有未到点的
 * 延时回复待办）时整条续聊让位，不抢跑 TA 自己定的节奏。
 */
export async function resolveEffectiveIdleContinueSettings(chat, userId) {
  const settings = await loadIdleContinueSettings(chat?.id).catch(() => normalizeIdleContinueSettings({}));
  if (!chat || chat.type === 'group' || !userId) return settings;
  const characterId = characterIdForAutonomyChat(chat);
  if (!characterId) return settings;
  let policy = null;
  try {
    policy = await loadResolvedCharacterAutonomyPolicy(userId, characterId, chat.id);
  } catch (_) {
    return { ...settings, enabled: false, proactivePolicyUnavailable: true };
  }
  if (policy?.totalEnabled !== true) {
    return { ...settings, enabled: false, proactiveDisabled: true };
  }
  if (policy?.realPersonMode?.enabled !== true) return settings;
  // TA 已经说了什么时候回来：延时回复待办会按 TA 定的时间接上，续聊不插队。
  try {
    const { listPendingActions } = await import('./pending-actions.js');
    const now = await getPacingNowForUser(userId);
    const hasOwnPlan = (await listPendingActions(userId)).some((action) => (
      action.kind === 'delayed_reply'
      && action.chatId === chat.id
      && Number(action.expiresAt || 0) > now
    ));
    if (hasOwnPlan) {
      return { ...settings, enabled: false, deferredToDelayedReply: true };
    }
  } catch (_) { /* 待办读不到时不阻塞续聊 */ }
  if (settings.enabled) return settings;
  const freq = String(policy?.realPersonMode?.frequencyPreset || 'normal');
  const minutes = IMPLICIT_IDLE_MINUTES_BY_FREQUENCY[freq] || IMPLICIT_IDLE_MINUTES_BY_FREQUENCY.normal;
  return {
    ...normalizeIdleContinueSettings({ enabled: true, minutes }),
    implicitRealPerson: true,
  };
}

export async function saveIdleContinueSettings(chatId, patch = {}) {
  const current = await loadIdleContinueSettings(chatId);
  const next = normalizeIdleContinueSettings({
    idleContinueEnabled: patch.enabled == null ? current.enabled : patch.enabled === true,
    idleContinueMinutes: patch.minutes == null ? current.minutes : patch.minutes,
  });
  await patchChatPrefs(chatId, {
    idleContinueEnabled: next.enabled,
    idleContinueMinutes: next.minutes,
  });
  return next;
}

/** 最近一条可见聊天消息；系统/已删/已撤回不算。 */
export function lastVisibleChatMessage(messages = []) {
  let latest = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.deleted || message.recalled) continue;
    if (String(message.senderId || '') === 'system') continue;
    if (String(message.type || '') === 'system') continue;
    const ts = Number(message.timestamp || 0);
    if (!ts) continue;
    if (!latest || ts >= Number(latest.timestamp || 0)) latest = message;
  }
  return latest;
}

export function messageRealCreatedAt(message = {}) {
  const explicit = Number(
    message?.createdAt
    || message?.metadata?.createdAtReal
    || message?.metadata?.aiRoundCreatedAt
    || 0,
  );
  if (explicit > 0) return explicit;
  const matched = String(message?.id || '').match(/^msg_(\d{10,})_/);
  const fromId = Number(matched?.[1] || 0);
  return fromId > 0 ? fromId : 0;
}

/**
 * 计时锚点：最后一条是用户消息，且已从「停止点输入」开始 idle。
 * allowMessageFallback：进程被杀等没记下 idleSince 时，用用户消息时间兜底（补跑用）。
 */
export function resolveIdleContinueAnchor(messages = [], chatId = '', options = {}) {
  const last = lastVisibleChatMessage(messages);
  if (!last || String(last.senderId || '') !== 'user') return null;
  const messageTs = Number(last.timestamp || 0) || 0;
  if (!messageTs) return null;
  const messageRealTs = messageRealCreatedAt(last);
  const composer = getChatComposerState(chatId);
  let armAt = Number(composer.idleSince || 0) || 0;
  // 停止输入若早于这条用户消息，说明之后又发过话，应以消息后的 idle 为准；
  // 尚未记下 idle 时，补跑才回退到消息时间。
  if (armAt && messageRealTs && armAt < messageRealTs) armAt = 0;
  if (!armAt && options.allowMessageFallback === true) armAt = messageRealTs;
  if (!armAt) return null;
  return {
    messageId: clean(last.id),
    messageTs,
    messageRealTs,
    timestamp: armAt,
  };
}

export function evaluateIdleContinueDue({
  settings,
  messages,
  chatId,
  now = Date.now(),
  allowMessageFallback = false,
} = {}) {
  const normalized = normalizeIdleContinueSettings(settings || {});
  if (!normalized.enabled) return { due: false, reason: 'disabled' };
  if (isChatComposerActive(chatId)) {
    return { due: false, reason: 'composer-active' };
  }
  const anchor = resolveIdleContinueAnchor(messages, chatId, { allowMessageFallback });
  if (!anchor?.timestamp) {
    return { due: false, reason: 'not-armed' };
  }
  if (isIdleContinueAnchorSuppressed(chatId, anchor)) {
    return { due: false, reason: 'user-stopped' };
  }
  const dueAt = anchor.timestamp + normalized.intervalMs;
  if (now < dueAt) return { due: false, reason: 'too-soon', dueAt, anchor };
  if (isChatStreaming(chatId)) return { due: false, reason: 'streaming', dueAt, anchor };
  return { due: true, dueAt, anchor, settings: normalized };
}

export async function runIdleContinueForChat(chatId, user, reason = 'idle-continue') {
  const id = clean(chatId);
  if (!id || !user?.id) return { ok: false, reason: 'missing-chat-or-user' };
  if (inFlight.has(id)) return { ok: false, reason: 'in-flight' };

  // 有云端闲置计划时本地不并发生成，只触发对账。
  try {
    const { isCloudScheduledBackgroundEnabled, hasCloudScheduledTask } = await import('../generation-relay.js');
    const virtualTime = await getTimeMode(user.id) === TIME_MODE_VIRTUAL;
    if (!virtualTime && isCloudScheduledBackgroundEnabled() && hasCloudScheduledTask(`chat-idle:${id}`)) {
      import('../cloud-background-coordinator.js')
        .then((mod) => mod.reconcileCloudBackgroundEvents?.(`idle-continue:${reason}`))
        .catch(() => {});
      return { ok: false, skipped: true, reason: 'cloud-scheduled' };
    }
  } catch (_) {}

  inFlight.add(id);
  let autonomyGuard = null;
  try {
    const [chat, messages] = await Promise.all([
      getChat(id),
      listMessagesForChat(id),
    ]);
    if (!chat) return { ok: false, reason: 'chat-missing' };
    const settings = await resolveEffectiveIdleContinueSettings(chat, user.id);
    if (String(chat.userId || '') && String(chat.userId) !== String(user.id)) {
      return { ok: false, reason: 'user-slot-mismatch' };
    }
    if (isAllMutedGroup(chat)) return { ok: false, reason: 'all-muted' };
    const characterId = characterIdForAutonomyChat(chat);
    const now = Date.now();
    if (characterId) {
      try {
        const { resolveCharacterAutonomousMessageBlock } = await import('../character-phone-proactive.js');
        const block = await resolveCharacterAutonomousMessageBlock(user.id, characterId, id, now);
        if (block?.blocked) {
          return { ok: false, skipped: true, reason: block.reason || 'soft-offline' };
        }
      } catch (_) { /* 统一门禁读不到时沿用后续硬下线/静音校验 */ }
    }
    try {
      const { isHardOfflineActiveForChat, maybeRunHardOfflinePeek } = await import('./real-person-hard-offline.js');
      const hardOffline = await isHardOfflineActiveForChat(user.id, chat, now);
      if (hardOffline) {
        await maybeRunHardOfflinePeek(chat, user, { now }).catch(() => {});
        return { ok: false, skipped: true, reason: 'hard-offline-active' };
      }
    } catch (_) { /* 完全下线状态读不到时沿用普通闲置续聊 */ }
    if (characterId && await isCharacterAutonomyMutedNow(user.id, characterId, now)) {
      return { ok: false, skipped: true, reason: 'mute-hours' };
    }
    // 人就在线下对面：暂停闲置续聊（含真人感隐式续聊）。
    if (characterId) {
      try {
        const { isCharacterBusyInOfflineSession } = await import('../character-phone-proactive.js');
        if (await isCharacterBusyInOfflineSession(user.id, characterId)) {
          return { ok: false, skipped: true, reason: 'active-offline-session' };
        }
      } catch (_) { /* 线下态读不到时不阻塞续聊 */ }
    }
    const verdict = evaluateIdleContinueDue({
      settings,
      messages,
      chatId: id,
      now,
      // 本地持久状态可能因崩溃/系统杀进程漏掉 blur；只要当前运行时确认
      // 输入框并未激活，就允许按最后一条用户消息兜底武装。
      allowMessageFallback: true,
    });
    if (!verdict.due) return { ok: false, skipped: true, reason: verdict.reason };

    autonomyGuard = acquireCharacterAutonomyGuard({
      userId: user.id,
      characterId,
      chatId: id,
    });
    if (!autonomyGuard) return { ok: false, skipped: true, reason: 'autonomy-guard' };

    let result;
    try {
      result = await runHeadlessChatReply(chat, user, {
        allowInactive: true,
        // 闲置续聊是主动开口；睡眠、勿扰与忙碌日程必须在请求前拦截。
        // 保留 headless 二次门禁，避免状态恰好在上面的预检后发生变化。
        skipBusyAutoReply: false,
        reason: `idle-continue:${reason}`,
        proactiveChannel: 'idle-continue',
        proactiveIdempotencyKey: `${id}:${verdict.anchorTs || verdict.lastUserAt || ''}`,
        sceneDirective: settings.implicitRealPerson
          ? [
            '对方发过消息后你隔了一小会儿才看到手机，现在按你的人格自然接上话。',
            '离开的这一会儿你在过自己的生活：忙手头的事、刷动态、在别的地方说话都可能发生，想带就自然带一嘴，不编造具体可查证的细节。',
            '这是回来接话不是汇报回合：闲聊为主，不强制高信息量或推进剧情，也不必反问、催促或报备自己在干什么；轻反应可以成立，有想接住、补充或岔开的内容也可以自然继续，信息密度、媒介和分条交给【回复节奏 · 错落】与人物语料。',
            '不要提系统、定时器、后台或“自动回复”；也不要责怪对方没立刻回。',
          ].join('\n')
          : [
            '对方刚才发过消息后停了一小会儿，现在按你的人格自然接上话。',
            '不要提系统、定时器、后台或“自动回复”；也不要责怪对方没立刻回。',
          ].join('\n'),
      });
    } finally {
      releaseCharacterAutonomyGuard(autonomyGuard, { generated: !!result?.ok });
      autonomyGuard = null;
    }
    if (result?.ok) {
      await notifyHeadlessChatIfEnabled(chat, result, {
        reason: 'idle-continue',
      }).catch(() => {});
      window.dispatchEvent?.(new CustomEvent('background-trigger', {
        detail: {
          chatId: id,
          result,
          generated: true,
          reason: 'idle-continue',
          at: Date.now(),
        },
      }));
    }
    return result?.ok
      ? { ok: true, result, anchor: verdict.anchor }
      : { ok: false, reason: result?.reason || 'headless-failed' };
  } finally {
    if (autonomyGuard) releaseCharacterAutonomyGuard(autonomyGuard, { generated: false });
    inFlight.delete(id);
  }
}

/** 扫描当前用户开启了闲置续聊的会话，触发到期的几条。 */
export async function scanIdleContinueReplies(user, reason = 'timer', { limit = 3 } = {}) {
  if (!user?.id) return { ok: false, reason: 'missing-user', triggered: 0 };
  const chats = await listChatsForUser(user.id).catch(() => []);
  const results = [];
  let triggered = 0;
  for (const chat of chats) {
    if (triggered >= Math.max(1, Number(limit) || 1)) break;
    if (!chat?.id || chat.type === 'group') continue;
    const settings = await resolveEffectiveIdleContinueSettings(chat, user.id).catch(() => null);
    if (!settings?.enabled) continue;
    const messages = await listMessagesForChat(chat.id).catch(() => []);
    const verdict = evaluateIdleContinueDue({
      settings,
      messages,
      chatId: chat.id,
      allowMessageFallback: true,
    });
    if (!verdict.due) continue;
    const result = await runIdleContinueForChat(chat.id, user, reason).catch((error) => ({
      ok: false,
      reason: error?.message || String(error),
    }));
    results.push({ chatId: chat.id, ...result });
    if (result?.ok) triggered += 1;
  }
  return { ok: true, triggered, results };
}
