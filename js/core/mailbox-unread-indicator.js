import { onStoreWrite } from './db.js';

const MAILBOX_CHANGED_EVENT = 'mailbox-changed';

function cleanAriaLabel(button) {
  return String(button.getAttribute('aria-label') || '邮箱')
    .replace(/，\d+\+? 封未读邮件$/, '');
}

export function paintMailboxUnread(container, count) {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  container?.querySelectorAll?.('[data-app-id="mailbox"]').forEach((button) => {
    const iconHost = button.querySelector('.ic') || button;
    const old = button.querySelector('.mailbox-unread-badge');
    if (!safeCount) {
      old?.remove();
      button.setAttribute('aria-label', cleanAriaLabel(button));
      return;
    }
    const text = safeCount > 99 ? '99+' : String(safeCount);
    if (old) old.textContent = text;
    else {
      const badgeClass = button.querySelector('.ic') ? 'sea-app-badge' : 'app-badge';
      iconHost.insertAdjacentHTML(
        'beforeend',
        `<span class="${badgeClass} mailbox-unread-badge" aria-hidden="true">${text}</span>`,
      );
    }
    button.setAttribute('aria-label', `${cleanAriaLabel(button)}，${text} 封未读邮件`);
  });
}

export function bindMailboxUnreadIndicator(container, userId, registerCleanup = () => {}) {
  const id = String(userId || '').trim();
  if (!id) return () => {};
  let timer = 0;
  let refreshSequence = 0;
  let disposed = false;

  const refresh = async () => {
    if (disposed || !container?.isConnected) return;
    const sequence = ++refreshSequence;
    const { countUnreadMailboxMessages } = await import('./mailbox-store.js');
    const count = await countUnreadMailboxMessages(id).catch(() => 0);
    if (disposed || !container?.isConnected || sequence !== refreshSequence) return;
    paintMailboxUnread(container, count);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { refresh().catch(() => {}); }, 25);
  };
  const onMailboxChanged = (event) => {
    const changedUserId = String(event?.detail?.userId || '').trim();
    if (changedUserId && changedUserId !== id) return;
    schedule();
  };
  const offSettings = onStoreWrite('settings', (key) => {
    if (String(key || '') === `mailbox_${id}`) schedule();
  });
  const onRouteActivated = (event) => {
    if (event?.detail?.container === container && event.detail.path === 'home') schedule();
  };
  globalThis.addEventListener?.(MAILBOX_CHANGED_EVENT, onMailboxChanged);
  globalThis.addEventListener?.('marshmallow-route-activated', onRouteActivated);

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    offSettings();
    globalThis.removeEventListener?.(MAILBOX_CHANGED_EVENT, onMailboxChanged);
    globalThis.removeEventListener?.('marshmallow-route-activated', onRouteActivated);
  };
  registerCleanup(container, cleanup);
  refresh().catch(() => {});
  return cleanup;
}
