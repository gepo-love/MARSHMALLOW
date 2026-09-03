/**
 * APK 系统通知 / 桌宠点击 → 打开对应会话。
 * 必须独立于 companion-dock：dock 加载失败、refreshState 抛错、或未开桌面置顶时，
 * 仍要能消费 MainActivity 写入的 companionChatId，否则只是唤起 App、Keep-Alive 仍是旧空列表。
 */

import { consumePendingOverlayOpen, isOverlaySupported } from './native-companion-overlay.js';
import { navigate } from './router.js';

const PENDING_TTL_MS = 5 * 60_000;
const POLL_MS = 900;

let bound = false;
let inflight = false;
let pollTimer = 0;

/**
 * 陪伴浮窗仍需处理 poke / expand；会话跳转由本桥接独占，避免与 dock 双消费。
 * @param {{ chatId?: string, at?: number, poke?: boolean, expand?: boolean }} pending
 */
function emitCompanionPending(pending) {
  if (typeof window === 'undefined') return;
  if (!pending?.poke && !pending?.expand) return;
  window.dispatchEvent(new CustomEvent('marshmallow-pending-companion-open', {
    detail: {
      chatId: String(pending.chatId || ''),
      at: Number(pending.at) || 0,
      poke: pending.poke === true,
      expand: pending.expand === true,
    },
  }));
}

async function consumeAndOpenPendingNotification() {
  if (inflight || typeof document === 'undefined') return;
  if (!isOverlaySupported()) return;
  if (document.hidden) return;
  inflight = true;
  try {
    const pending = await consumePendingOverlayOpen();
    if (!pending?.at || Date.now() - pending.at > PENDING_TTL_MS) return;
    const chatId = String(pending.chatId || '').trim();
    if (pending.expand) {
      emitCompanionPending(pending);
      navigate('companion', {}, true);
      return;
    }
    if (chatId) {
      navigate('chat/thread', { chatId, entry: 'notify' }, true);
    }
    if (pending.poke) emitCompanionPending(pending);
  } catch (_) {
    /* ignore bridge errors */
  } finally {
    inflight = false;
  }
}

/** 启动 APK 通知深链桥接；网页 / iOS 上 isOverlaySupported 为 false，空跑。 */
export function initNativeNotificationOpenBridge() {
  if (bound || typeof document === 'undefined') return;
  bound = true;
  const run = () => { void consumeAndOpenPendingNotification(); };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) run();
  });
  window.addEventListener('marshmallow-app-foreground', run);
  window.addEventListener('marshmallow-native-resume', run);
  // SINGLE_TOP 下点通知时页面可能一直可见，visibilitychange 不会再响；轻量轮询兜底。
  if (isOverlaySupported() && !pollTimer) {
    pollTimer = window.setInterval(() => {
      if (!document.hidden) run();
    }, POLL_MS);
  }
  run();
}
