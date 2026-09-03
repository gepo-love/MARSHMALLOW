import * as db from './db.js';
import { getCharacter } from './character-store.js';
import { currentRoute, currentRouteParams } from './router.js';
import { playMessageNotifySoundIfEnabled } from './message-notify-audio.js';
import { previewFromMessage, isPreviewCandidateMessage } from './chat-helpers.js';
import { appendDebugEvent } from './debug-log.js';

const NOTIFICATION_DEDUPE_STATE_KEY = 'notificationDedupeState';
const KEEPALIVE_SETTINGS_KEY = 'backgroundKeepAlive';
const DEFAULT_ICON = 'assets/icons/icon-192.png';
const SERVICE_WORKER_READY_TIMEOUT_MS = 2500;
const SW_REPAIR_UNTIL_KEY = '__mm_sw_repair_until__';

function nativePlugin() {
  if (typeof window === 'undefined') return null;
  const plugins = window.Capacitor?.Plugins || {};
  return plugins.MarshmallowNotification || plugins.GloryNotification || null;
}

function resolveNotificationIcon(icon = '') {
  const raw = String(icon || '').trim();
  if (raw) return raw;
  if (typeof window === 'undefined') return DEFAULT_ICON;
  try {
    return new URL(DEFAULT_ICON, window.location.href).href;
  } catch (_) {
    return DEFAULT_ICON;
  }
}

function playNotificationSound(chatId = '', transport = '') {
  void playMessageNotifySoundIfEnabled()
    .then((result) => {
      if (result?.ok || result?.reason === 'disabled') return;
      appendDebugEvent({
        type: 'message_notify_sound_failed',
        level: 'warn',
        message: `消息提示音未播放：${String(result?.reason || 'play_failed')}`,
        context: {
          chatId: String(chatId || ''),
          transport: String(transport || ''),
          reason: String(result?.reason || 'play_failed'),
        },
      });
    })
    .catch((error) => {
      appendDebugEvent({
        type: 'message_notify_sound_failed',
        level: 'warn',
        message: `消息提示音播放异常：${String(error?.message || error || 'unknown')}`,
        context: { chatId: String(chatId || ''), transport: String(transport || '') },
      });
    });
}

export function hasNativeNotificationBridge() {
  return !!nativePlugin()?.notify;
}

/** 当前是否正在看指定会话的聊天页（前台可见且路由就是该 chat/thread） */
export function isViewingChatThread(chatId = '') {
  const id = String(chatId || '').trim();
  if (!id) return false;
  if (typeof document !== 'undefined' && document.hidden) return false;
  if (currentRoute() !== 'chat/thread') return false;
  return String(currentRouteParams()?.chatId || '').trim() === id;
}

/**
 * 后台主动消息该不该弹通知。
 * - catch-up: 补跑一律放行（页面刚变可见时补跑，不能只看 document.hidden）
 * - 传入 chatId：不在该会话聊天页（含后台、主屏、列表、其它会话）就通知
 * - 未传 chatId：退化为仅 document.hidden
 */
export function shouldNotifyForBackgroundReason(reason = '', chatId = '') {
  if (/^catch-up:/i.test(String(reason || ''))) return true;
  const id = String(chatId || '').trim();
  if (id) return !isViewingChatThread(id);
  if (typeof document === 'undefined') return true;
  return !!document.hidden;
}

export async function requestMessageNotificationPermission() {
  const plugin = nativePlugin();
  if (plugin?.requestPermission) {
    const result = await plugin.requestPermission().catch(() => null);
    return result?.granted === true;
  }
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export async function hasMessageNotificationPermission() {
  const plugin = nativePlugin();
  if (plugin?.hasPermission) {
    const result = await plugin.hasPermission().catch(() => null);
    return result?.granted === true;
  }
  return 'Notification' in window && Notification.permission === 'granted';
}

function isServiceWorkerRepairCooldown() {
  try {
    return Number(globalThis.localStorage?.getItem(SW_REPAIR_UNTIL_KEY) || 0) > Date.now();
  } catch (_) {
    return false;
  }
}

async function resolveNotificationServiceWorker(timeoutMs = SERVICE_WORKER_READY_TIMEOUT_MS) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { registration: null, reason: 'service-worker-unsupported' };
  }

  const current = await navigator.serviceWorker.getRegistration?.().catch(() => null);
  if (current?.showNotification) {
    return { registration: current, reason: '' };
  }
  if (isServiceWorkerRepairCooldown()) {
    return { registration: null, reason: 'service-worker-repair-cooldown' };
  }

  let timer = 0;
  try {
    const ensureServiceWorker = globalThis.__mm_ensure_full_service_worker__;
    if (typeof ensureServiceWorker === 'function') {
      await ensureServiceWorker().catch(() => null);
    }
    const ready = navigator.serviceWorker.ready;
    const registration = await Promise.race([
      ready,
      new Promise((resolve) => {
        timer = globalThis.setTimeout(() => resolve(null), Math.max(100, Number(timeoutMs) || 0));
      }),
    ]);
    if (registration?.showNotification) {
      return { registration, reason: '' };
    }
    return { registration: null, reason: 'service-worker-not-ready' };
  } catch (err) {
    return {
      registration: null,
      reason: 'service-worker-ready-failed',
      error: err?.message || String(err || ''),
    };
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}

/**
 * 只检查通知投递通道，不实际弹通知。iOS PWA 必须依赖可用的 Service Worker。
 */
export async function inspectMessageNotificationDelivery({ timeoutMs = SERVICE_WORKER_READY_TIMEOUT_MS } = {}) {
  if (nativePlugin()?.notify) return { ok: true, channel: 'native' };
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return { ok: false, reason: 'notification-unsupported', permissionRequired: true };
  }
  if (Notification.permission !== 'granted') {
    return {
      ok: false,
      reason: `permission-${Notification.permission || 'default'}`,
      permissionRequired: true,
    };
  }
  const sw = await resolveNotificationServiceWorker(timeoutMs);
  if (sw.registration) return { ok: true, channel: 'service-worker' };
  return { ok: false, reason: sw.reason, error: sw.error || '', needsGuide: true };
}

async function isBackgroundNotifyEnabled() {
  const row = await db.get(KEEPALIVE_SETTINGS_KEY).catch(() => null);
  return row?.value?.notifyOnAutoChat === true;
}

async function shouldDedupeNotification(dedupeKey) {
  const dedupeRow = await db.get(NOTIFICATION_DEDUPE_STATE_KEY).catch(() => null);
  const dedupe = dedupeRow?.value && typeof dedupeRow.value === 'object' ? dedupeRow.value : {};
  return (
    String(dedupe.lastKey || '') === dedupeKey
    && Number(dedupe.lastAt || 0) > Date.now() - 90_000
  );
}

async function rememberNotificationDedupe(dedupeKey) {
  await db.put({
    key: NOTIFICATION_DEDUPE_STATE_KEY,
    value: { lastKey: dedupeKey, lastAt: Date.now() },
  }).catch(() => null);
}

async function showWebPlatformNotification(title, options = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return { ok: false, permissionRequired: true };
  }
  const icon = resolveNotificationIcon(options.icon);
  const payload = {
    body: options.body || '',
    tag: options.tag || 'marshmallow-message',
    silent: false,
    data: options.data || {},
    icon,
    // badge 是状态栏用的单色小图标，头像塞进去反而会糊；badge 固定用默认应用图标。
    badge: options.badge || resolveNotificationIcon(''),
  };
  const sw = await resolveNotificationServiceWorker();
  if (sw.registration) {
    try {
      await sw.registration.showNotification(title, payload);
      return { ok: true, channel: 'service-worker' };
    } catch (err) {
      sw.reason = 'service-worker-notification-failed';
      sw.error = err?.message || String(err || '');
    }
  }
  try {
    new Notification(title, payload);
    return { ok: true, channel: 'window' };
  } catch (err) {
    return {
      ok: false,
      reason: sw.reason || 'window-notification-failed',
      error: sw.error || err?.message || String(err || ''),
      needsGuide: true,
    };
  }
}

/** 群聊：`xx群聊有新消息`（群名已以「群聊」结尾时不重复拼接） */
export function formatGroupChatNotification(groupName = '') {
  const name = String(groupName || '').trim() || '群聊';
  const label = /群聊$/u.test(name) ? name : `${name}群聊`;
  return {
    title: `${label}有新消息`,
    body: '',
  };
}

/**
 * 普通角色气泡：只保留一行 `角色名：内容…`，不另写正文（避免标题与正文重复）。
 * @deprecated count 批处理文案已废弃，保留兼容旧调用
 */
export function formatCharacterSentNotification(characterName = '', { content = '', count = 1 } = {}) {
  const name = String(characterName || '').trim() || 'TA';
  const text = String(content || '').trim();
  if (text) {
    return {
      title: `${name}：${text}`.slice(0, 120),
      body: '',
    };
  }
  // 无正文时不再写「共 N 条」
  return {
    title: `${name}：有新消息`,
    body: '',
  };
}

export function resolveChatNotifyGroupName(chat) {
  if (!chat || chat.type !== 'group') return '';
  return String(chat.groupSettings?.name || chat.title || chat.name || '').trim() || '群聊';
}

export function isGroupChatForNotify(chat) {
  return !!chat && chat.type === 'group';
}

export async function resolveChatNotifyCharacterInfo(chat) {
  if (!chat) return { name: 'TA', avatar: '' };
  if (isGroupChatForNotify(chat)) {
    const groupName = resolveChatNotifyGroupName(chat);
    const avatar = String(chat.groupSettings?.avatar || '').trim();
    return { name: groupName, avatar };
  }
  const participants = Array.isArray(chat.participants) ? chat.participants : [];
  const partnerId = participants.find((p) => p && p !== 'user');
  if (partnerId) {
    // 情头等角色自主头像保存在当前用户的 characterOverrides 中。
    // 后台通知也必须带会话所属档位读取，否则会退回角色库里的旧头像。
    const row = await getCharacter(partnerId, { userId: chat.userId }).catch(() => null);
    const name = String(row?.customNickname || row?.name || '').trim();
    if (name) return { name, avatar: String(row?.avatar || '') };
  }
  const title = String(chat.title || chat.name || '').trim();
  return { name: title || 'TA', avatar: '' };
}

export async function resolveChatNotifyCharacterName(chat) {
  return (await resolveChatNotifyCharacterInfo(chat)).name;
}

function collectNotifyBubbles(messages, { characterName = '' } = {}) {
  const fallbackName = String(characterName || '').trim() || 'TA';
  const list = Array.isArray(messages) ? messages : [];
  const bubbles = [];
  for (const msg of list) {
    if (!isPreviewCandidateMessage(msg)) continue;
    if (String(msg.senderId || '') === 'user') continue;
    const name = String(msg.senderName || fallbackName).trim() || fallbackName;
    const content = previewFromMessage(msg) || String(msg.content || '').trim();
    // 任务状态、空壳消息或尚未补齐正文的媒体占位不能生成「TA：有新消息」。
    // 通知与红点都应指向一条已经落库、点进去确实看得到的内容。
    if (!String(content || '').trim()) continue;
    bubbles.push({
      name,
      content,
      id: String(msg.id || ''),
    });
  }
  return bubbles;
}

function isPersistedNotifyMessageVisible(message, chatId = '') {
  if (!message || message.deleted || message.recalled) return false;
  if (String(message.chatId || '').trim() !== String(chatId || '').trim()) return false;
  if (message.metadata?.deliveryBlockedByUser === true) return false;
  if (String(message.metadata?.deliveryStatus || '').trim() === 'rejected') return false;
  if (!isPreviewCandidateMessage(message) || String(message.senderId || '') === 'user') return false;
  return !!String(previewFromMessage(message) || message.content || '').trim();
}

/**
 * 通知正文必须以 IndexedDB 当前仍可见的消息为准，不能直接信任生成函数返回的内存对象。
 * 同一 AI 回合可能在文字落库后继续执行撤回/拒收等副作用；旧实现仍会把这些已不可见
 * 的文字逐条弹成通知，用户点进去、甚至退出重进都找不到，表现为「消息被吞了」。
 */
async function loadPersistedNotifyMessages(messages, chatId = '') {
  const source = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (!source.length) return { checked: false, messages: [] };
  const id = String(chatId || '').trim();
  if (!id) return { checked: true, messages: [] };
  const rows = await Promise.all(source.map(async (message) => {
    const messageId = String(message?.id || '').trim();
    if (!messageId) return null;
    return db.getRecord('messages', messageId).catch(() => null);
  }));
  const visible = rows.filter((message) => isPersistedNotifyMessageVisible(message, id));
  if (!visible.length) {
    appendDebugEvent({
      type: 'message_notification_suppressed',
      level: 'warn',
      message: '通知对应消息已不在会话中，已拦截幽灵通知',
      context: {
        chatId: id,
        expectedMessageIds: source.map((message) => String(message?.id || '')).filter(Boolean),
        persistedStates: rows.map((message) => ({
          id: String(message?.id || ''),
          chatId: String(message?.chatId || ''),
          missing: !message,
          deleted: message?.deleted === true,
          recalled: message?.recalled === true,
          deliveryStatus: String(message?.metadata?.deliveryStatus || ''),
        })),
      },
    }).catch(() => {});
  }
  return { checked: true, messages: visible };
}

/** 只有已落库且当前可见的角色气泡才可以形成会话未读。 */
export async function bumpPersistedMessagesUnread(chatId = '', messages = []) {
  const id = String(chatId || '').trim();
  const persisted = await loadPersistedNotifyMessages(messages, id);
  if (!id || !persisted.checked || !persisted.messages.length) {
    return { ok: false, reason: 'messages-not-visible', count: 0, messages: [] };
  }
  try {
    const { bumpChatUnread } = await import('./chat-store.js');
    await bumpChatUnread(id, persisted.messages.length);
  } catch (_) {
    return { ok: false, reason: 'unread-update-failed', count: 0, messages: persisted.messages };
  }
  return {
    ok: true,
    count: persisted.messages.length,
    messages: persisted.messages,
  };
}

/**
 * 普通角色消息：每个气泡一条通知，文案为「角色名：内容…」。
 * 必须传入已经落库且能提取正文的消息；任务状态变化不得降级成「有新消息」。
 */
export async function notifyCharacterSentMessageIfEnabled({
  characterName = '',
  chatId = '',
  tag = '',
  count = 1,
  messages = null,
  requireHidden = true,
  avatar = '',
} = {}) {
  const baseTag = tag || `character-msg-${chatId || characterName || 'unknown'}`;
  const persisted = await loadPersistedNotifyMessages(messages, chatId);
  // 调用方明确给了本轮消息，但回读后已经不存在/撤回/拒收时，不得退化成「有新消息」。
  if (persisted.checked && !persisted.messages.length) {
    return { ok: false, reason: 'messages-not-visible', notifiedCount: 0 };
  }
  const bubbles = collectNotifyBubbles(
    persisted.checked ? persisted.messages : messages,
    { characterName },
  );
  if (!bubbles.length) {
    return { ok: false, reason: 'empty-message-content', notifiedCount: 0 };
  }
  const items = bubbles;

  let last = { ok: false, reason: 'empty' };
  let playedSound = false;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const { title, body } = formatCharacterSentNotification(item.name, { content: item.content });
    const itemTag = items.length > 1
      ? `${baseTag}-${item.id || i}`
      : baseTag;
    last = await notifyBackgroundMessageIfEnabled({
      title,
      body,
      chatId: String(chatId || ''),
      tag: itemTag,
      requireHidden,
      icon: avatar,
      playSound: !playedSound,
    });
    if (last?.ok && last?.reason !== 'deduped') playedSound = true;
  }
  return { ...last, notifiedCount: items.length };
}

/** 群聊：单条「xx群聊有新消息」 */
export async function notifyGroupChatMessageIfEnabled({
  groupName = '',
  chatId = '',
  tag = '',
  requireHidden = true,
  avatar = '',
} = {}) {
  const { title, body } = formatGroupChatNotification(groupName);
  return notifyBackgroundMessageIfEnabled({
    title,
    body,
    chatId: String(chatId || ''),
    tag: tag || `group-msg-${chatId || groupName || 'unknown'}`,
    requireHidden,
    icon: avatar,
  });
}

export async function showMessageNotification({
  title = '新消息',
  body = '有新回复',
  chatId = '',
  tag = '',
  icon = '',
  data = {},
  skipDedupe = false,
  playSound = true,
} = {}) {
  const cleanTitle = String(title || '新消息');
  // 允许显式空 body（群聊标题已含完整语义时）
  const cleanBody = body == null ? '有新回复' : String(body);
  const cleanTag = String(tag || chatId || 'marshmallow-message');
  const dedupeKey = `${cleanTag}|${cleanTitle}|${cleanBody}`;

  if (!skipDedupe && await shouldDedupeNotification(dedupeKey)) {
    return { ok: true, reason: 'deduped' };
  }

  const plugin = nativePlugin();
  if (plugin?.notify) {
    const result = await plugin.notify({
      title: cleanTitle,
      body: cleanBody,
      chatId: String(chatId || ''),
      tag: cleanTag,
      avatar: String(icon || '').trim().startsWith('data:image/') ? icon : '',
    }).catch((err) => ({ ok: false, error: err?.message || String(err || '') }));
    if (result?.ok) {
      if (!skipDedupe) await rememberNotificationDedupe(dedupeKey);
      if (playSound) playNotificationSound(chatId, 'native');
      return result;
    }
    if (result?.permissionRequired) return result;
  }

  const webResult = await showWebPlatformNotification(cleanTitle, {
    body: cleanBody,
    tag: cleanTag,
    icon: resolveNotificationIcon(icon),
    // Service Worker 的 notificationclick 只依赖这个稳定字段深链到 chat/thread。
    data: { ...data, chatId: String(chatId || data?.chatId || '') },
  });
  if (webResult?.ok) {
    if (!skipDedupe) await rememberNotificationDedupe(dedupeKey);
    if (playSound) playNotificationSound(chatId, 'web');
  }
  return webResult;
}

export async function notifyBackgroundMessageIfEnabled({
  title = '新消息',
  body = '有新回复',
  chatId = '',
  tag = '',
  icon = '',
  data = {},
  requireHidden = true,
  playSound = true,
} = {}) {
  if (requireHidden && typeof document !== 'undefined' && !document.hidden) {
    return { ok: false, reason: 'visible' };
  }
  if (!(await isBackgroundNotifyEnabled())) {
    return { ok: false, reason: 'disabled' };
  }
  return showMessageNotification({
    title,
    body,
    chatId,
    tag,
    icon,
    data,
    playSound,
  });
}

export async function notifyHeadlessChatIfEnabled(chat, result, options = {}) {
  const chatId = String(chat?.id || '');
  if (!shouldNotifyForBackgroundReason(options.reason, chatId)) {
    return { ok: false, reason: 'viewing-chat' };
  }
  const info = await resolveChatNotifyCharacterInfo(chat);
  const notificationMessages = Array.isArray(result?.messages) && result.messages.length
    ? result.messages
    : (result?.message ? [result.message] : []);
  // busy-reply 的 already-replied / cooldown 也会返回 ok:true + handled:true，
  // 但没有产生任何新气泡；旧逻辑会因此伪造一条「有新消息」通知。
  if (result?.ok && !notificationMessages.length) {
    return { ok: false, reason: 'no-new-messages' };
  }
  const persisted = result?.ok
    ? await loadPersistedNotifyMessages(notificationMessages, chatId)
    : { checked: false, messages: [] };
  if (result?.ok && persisted.checked && !persisted.messages.length) {
    return { ok: false, reason: 'messages-not-visible', notifiedCount: 0 };
  }
  const visibleMessages = persisted.checked ? persisted.messages : notificationMessages;
  const messageCount = visibleMessages.length;
  // 自动闲聊原先不 bump unread；Keep-Alive 复进时没有未读标记就不会钉底，最新消息会停在屏外。
  // 必须先从 IndexedDB 回读到可见气泡再加未读，避免生成结果未落库却先出现红点。
  if (result?.ok && chatId && messageCount > 0) {
    try {
      const { bumpChatUnread } = await import('./chat-store.js');
      await bumpChatUnread(chatId, messageCount);
    } catch (_) {}
  }

  if (result?.ok && isGroupChatForNotify(chat)) {
    return notifyGroupChatMessageIfEnabled({
      groupName: info.name,
      chatId,
      tag: `auto-chat-${chatId || 'unknown'}`,
      requireHidden: false,
      avatar: info.avatar,
    });
  }

  const overrideName = String(options.characterName || '').trim();
  const characterName = overrideName || info.name;
  if (result?.ok) {
    return notifyCharacterSentMessageIfEnabled({
      characterName,
      chatId,
      tag: `auto-chat-${chatId || 'unknown'}`,
      messages: visibleMessages,
      count: messageCount,
      requireHidden: false,
      avatar: info.avatar,
    });
  }
  // 失败/跳过（额度用尽、角色缺失等）不发系统通知：旧逻辑会用「有新消息」标题
  // 配上 missing-character / budget-exhausted 这类内部 reason，误导用户。
  return { ok: false, reason: String(result?.reason || 'failed'), notified: false };
}
