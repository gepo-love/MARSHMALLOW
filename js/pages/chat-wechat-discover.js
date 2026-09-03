import { navigate } from '../core/router.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { hasUnreadMoments } from '../core/moments/moments-store.js';
import {
  applyChatHubInsPageClasses,
  bindChatHubInsTabs,
  buildChatHubInsChrome,
  loadChatHubInsContext,
} from '../core/chat/chat-hub-ins-chrome.js';
import { wechatGlyph } from '../core/chat/wechat-shell.js';

function row(iconName, tone, label, route, { dot = false } = {}) {
  return `<button type="button" class="wechat-menu-row" data-wechat-route="${route}"><span class="wechat-menu-icon is-${tone}">${wechatGlyph(iconName)}</span><strong>${label}</strong>${dot ? '<i class="wechat-menu-dot" aria-label="有新动态"></i>' : ''}<span class="wechat-row-chevron">${wechatGlyph('chevron')}</span></button>`;
}

export default async function render(container) {
  const [user, hubContext] = await Promise.all([ensureDefaultUser(), loadChatHubInsContext()]);
  if (hubContext.chatPlatform !== 'wechat') {
    navigate('chat', {}, true);
    return;
  }
  const unread = await hasUnreadMoments(user.id).catch(() => false);
  applyChatHubInsPageClasses(container, { ...hubContext, chatPlatform: 'wechat', extraClasses: ['wechat-shell-page', 'wechat-discover-page'] });
  container.innerHTML = `
    ${buildChatHubInsChrome({ activeTab: 'discover', chatPlatform: 'wechat', showUserCard: false, pageTitle: '发现' })}
    <main class="wechat-shell-scroll wechat-menu-scroll">
      <section class="wechat-menu-group">${row('moments', 'green', '朋友圈', 'chat/moments', { dot: unread })}</section>
      <section class="wechat-menu-group">${row('channels', 'orange', '视频号', 'chat/wechat-feature?feature=channels')}${row('scan', 'blue', '扫一扫', 'chat/wechat-feature?feature=scan')}${row('look', 'yellow', '看一看', 'chat/wechat-feature?feature=look')}${row('search-page', 'blue', '搜一搜', 'chat/wechat-feature?feature=search')}</section>
      <section class="wechat-menu-group">${row('channels', 'red', '直播和附近', 'chat/wechat-feature?feature=live')}${row('mini', 'purple', '小程序', 'chat/wechat-feature?feature=mini')}</section>
    </main>
  `;
  bindChatHubInsTabs(container, 'discover');
  container.querySelectorAll('[data-wechat-route]').forEach((button) => button.addEventListener('click', () => {
    const route = button.getAttribute('data-wechat-route');
    if (route?.startsWith('chat/wechat-feature?feature=')) {
      navigate('chat/wechat-feature', { feature: route.slice(route.indexOf('=') + 1) });
      return;
    }
    navigate(route);
  }));
}
