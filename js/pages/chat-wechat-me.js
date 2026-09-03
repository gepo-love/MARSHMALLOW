import { navigate } from '../core/router.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { getUserDisplayName } from '../models/user.js';
import {
  applyChatHubInsPageClasses,
  bindChatHubUserCard,
  bindChatHubInsTabs,
  buildChatHubInsChrome,
  loadChatHubInsContext,
} from '../core/chat/chat-hub-ins-chrome.js';
import { getMany } from '../core/db.js';
import { wechatGlyph } from '../core/chat/wechat-shell.js';

function esc(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function row(iconName, tone, label, route) {
  return `<button type="button" class="wechat-menu-row" data-wechat-route="${route}"><span class="wechat-menu-icon is-${tone}">${wechatGlyph(iconName)}</span><strong>${label}</strong><span class="wechat-row-chevron">${wechatGlyph('chevron')}</span></button>`;
}

function backgroundOpacity(value, fallback = 40) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function cssBackgroundImage(dataUrl = '') {
  const value = String(dataUrl || '').trim();
  if (!value) return 'none';
  return `url("${value.replace(/["\\\n\r\f]/g, '\\$&')}")`;
}

export default async function render(container) {
  const [user, hubContext] = await Promise.all([ensureDefaultUser(), loadChatHubInsContext()]);
  if (hubContext.chatPlatform !== 'wechat') {
    navigate('chat', {}, true);
    return;
  }
  const identityAppearance = user?.identityAppearance && typeof user.identityAppearance === 'object'
    ? user.identityAppearance
    : {};
  const sidebarBackgroundAssetId = String(identityAppearance.chatSidebarBackgroundAssetId || '');
  const [sidebarBackgroundAsset] = await getMany('beautifyAssets', [sidebarBackgroundAssetId]).catch(() => []);
  const hasSidebarBackground = !!(
    sidebarBackgroundAsset
    && sidebarBackgroundAsset.id === sidebarBackgroundAssetId
    && sidebarBackgroundAsset.dataUrl
  );
  const name = getUserDisplayName(user);
  const avatar = user.avatar
    ? `<img src="${esc(user.avatar)}" alt="" />`
    : `<span>${esc(name.slice(0, 1))}</span>`;
  const wechatId = String(user.wechatId || user.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'marshmallow';
  applyChatHubInsPageClasses(container, {
    ...hubContext,
    chatPlatform: 'wechat',
    extraClasses: [
      'wechat-shell-page',
      'wechat-me-page',
      hasSidebarBackground ? 'has-chat-sidebar-background' : '',
    ].filter(Boolean),
  });
  container.style.setProperty(
    '--chat-sidebar-custom-image',
    cssBackgroundImage(hasSidebarBackground ? sidebarBackgroundAsset.dataUrl : ''),
  );
  container.style.setProperty(
    '--chat-sidebar-custom-opacity',
    String(backgroundOpacity(identityAppearance.chatSidebarBackgroundOpacity) / 100),
  );
  container.style.setProperty(
    '--chat-sidebar-custom-overlay',
    `rgba(255, 255, 255, ${1 - (backgroundOpacity(identityAppearance.chatSidebarBackgroundOpacity) / 100)})`,
  );
  container.innerHTML = `
    ${buildChatHubInsChrome({ activeTab: 'me', chatPlatform: 'wechat', showUserCard: true, user, pageTitle: '' })}
    <main class="wechat-shell-scroll wechat-menu-scroll wechat-me-scroll">
      <button type="button" class="wechat-me-profile" data-wechat-route="__identity_drawer__" aria-haspopup="dialog">
        <span class="wechat-me-avatar">${avatar}</span>
        <span class="wechat-me-copy"><strong>${esc(name)}</strong><small>微信号：${esc(wechatId)}</small><small>${esc(user.statusText || user.signature || '')}</small></span>
        <span class="wechat-me-qr" aria-hidden="true">▦</span><span class="wechat-row-chevron">${wechatGlyph('chevron')}</span>
      </button>
      <section class="wechat-menu-group">${row('services', 'green', '服务', 'chat/wechat-feature?feature=services')}</section>
      <section class="wechat-menu-group">${row('favorite', 'orange', '收藏', 'memory')}${row('moments', 'blue', '朋友圈', 'chat/moments')}${row('cards', 'cyan', '卡包', 'chat/wechat-feature?feature=cards')}${row('sticker', 'yellow', '表情', 'stickers')}</section>
      <section class="wechat-menu-group">${row('settings', 'blue', '设置', 'settings')}</section>
    </main>
  `;
  const identityDrawerHost = container.querySelector('.chat-hub-user-card-wrap');
  if (identityDrawerHost) container.append(identityDrawerHost);
  bindChatHubInsTabs(container, 'me');
  bindChatHubUserCard(container, user, {
    onSlotChanged: async () => render(container),
  });
  container.querySelectorAll('[data-wechat-route]').forEach((button) => button.addEventListener('click', () => {
    const route = button.getAttribute('data-wechat-route');
    if (route === '__identity_drawer__') {
      container.querySelector('[data-hub-user-drawer-open]')?.click();
      return;
    }
    if (route?.startsWith('chat/wechat-feature?feature=')) {
      navigate('chat/wechat-feature', { feature: route.slice(route.indexOf('=') + 1) });
      return;
    }
    navigate(route);
  }));
}
