import { onStoreWrite } from './db.js';

export function totalChatUnread(chats = []) {
  return (Array.isArray(chats) ? chats : [])
    .reduce((total, chat) => total + Math.max(0, Math.floor(Number(chat?.unread) || 0)), 0);
}

export async function getChatUnreadTotal(userId) {
  const { listInboxChatsForUser } = await import('./chat-store.js');
  const chats = await listInboxChatsForUser(userId);
  return totalChatUnread(chats);
}

function cleanAriaLabel(button) {
  return String(button.getAttribute('aria-label') || '聊天')
    .replace(/，\d+\+? 条未读消息$/, '');
}

function paintChatUnread(container, count) {
  container.querySelectorAll('[data-app-id="chat"]').forEach((button) => {
    const iconHost = button.querySelector('.ic') || button;
    const old = button.querySelector('.chat-unread-badge');
    const safeCount = Math.max(0, Math.floor(Number(count) || 0));
    if (!safeCount) {
      old?.remove();
      button.setAttribute('aria-label', cleanAriaLabel(button));
      return;
    }
    const text = safeCount > 99 ? '99+' : String(safeCount);
    if (old) old.textContent = text;
    else {
      const badgeClass = button.querySelector('.ic') ? 'sea-app-badge' : 'app-badge';
      iconHost.insertAdjacentHTML('beforeend', `<span class="${badgeClass} chat-unread-badge" aria-hidden="true">${text}</span>`);
    }
    button.setAttribute('aria-label', `${cleanAriaLabel(button)}，${text} 条未读消息`);
  });
}

export function bindChatUnreadIndicator(container, userId, registerCleanup = () => {}) {
  const id = String(userId || '').trim();
  if (!id) return () => {};
  let timer = 0;
  let disposed = false;

  const refresh = async () => {
    if (disposed || !container?.isConnected) return;
    const count = await getChatUnreadTotal(id).catch(() => 0);
    if (!disposed && container?.isConnected) paintChatUnread(container, count);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { refresh().catch(() => {}); }, 50);
  };
  const offChats = onStoreWrite('chats', schedule);
  const offSettings = onStoreWrite('settings', (key) => {
    if (String(key || '').startsWith('chatPrefs_')) schedule();
  });
  const onRouteActivated = (event) => {
    if (event?.detail?.container === container && event.detail.path === 'home') schedule();
  };
  globalThis.addEventListener?.('marshmallow-route-activated', onRouteActivated);

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    offChats();
    offSettings();
    globalThis.removeEventListener?.('marshmallow-route-activated', onRouteActivated);
  };
  registerCleanup(container, cleanup);
  refresh().catch(() => {});
  return cleanup;
}
