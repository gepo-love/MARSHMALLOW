import { icon } from '../../components/svg-icons.js';
import { openTextEditorModal } from '../../components/text-editor-modal.js';
import { showToast } from '../../components/toast.js';
import {
  getUserDisplayName,
  hasActiveIdentityBinding,
  normalizeIdentityBinding,
} from '../../models/user.js';
import { navigate } from '../router.js';
import {
  getActiveTheme,
  isSeaHomeTheme,
  isWindowHomeTheme,
  loadAppearancePrefs,
  getChatHubInsContextSync,
  normalizeChatPlatform,
  setChatPlatform,
} from '../appearance-prefs.js';
import {
  createLinkedUser,
  deleteUserIdentity,
  getCurrentUser,
  listUsersInSlot,
  saveUserRecord,
  setCurrentUserId,
} from '../user-slot.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../../components/image-crop-modal.js';
import { get, put } from '../db.js';
import {
  ENSEMBLE_MODE_LABEL,
  loadEnsembleModeConfig,
  saveEnsembleCurrentBackground,
  setEnsembleModeEnabled,
} from '../ensemble-mode.js';
import { openEnsembleModeNotice } from '../../components/ensemble-mode-notice.js';
import { wechatGlyph } from './wechat-shell.js';
import { resolveDefaultAvatar } from '../default-avatar.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanProfileEventText(value = '', max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function appendUserProfileChangeEvents(userId = '', events = []) {
  const uid = String(userId || '').trim();
  const list = Array.isArray(events) ? events.filter((event) => event?.text) : [];
  if (!uid || !list.length) return;
  const key = `userProfileChangeEvents_${uid}`;
  const row = await get(key).catch(() => null);
  const current = Array.isArray(row?.value) ? row.value : [];
  await put({ key, value: [...current, ...list].slice(-80) });
}

export async function loadChatHubInsContext() {
  const cached = getChatHubInsContextSync();
  if (cached) return cached;
  const appearancePrefs = await loadAppearancePrefs();
  const activeAppearance = getActiveTheme(appearancePrefs);
  const windowTheme = isWindowHomeTheme(activeAppearance.id, activeAppearance.theme);
  const seaTheme = isSeaHomeTheme(activeAppearance.id, activeAppearance.theme);
  const chatPlatform = normalizeChatPlatform(appearancePrefs.chatPlatform);
  const hubInsChrome = true;
  return { hubInsChrome, windowTheme, seaTheme, chatPlatform, appearancePrefs, activeAppearance };
}

export function applyChatHubInsPageClasses(container, {
  hubInsChrome,
  windowTheme,
  seaTheme,
  baseClass = 'chat-hub-page',
  extraClasses = [],
  chatPlatform = document.documentElement.dataset.chatPlatform || 'current',
} = {}) {
  const platform = normalizeChatPlatform(chatPlatform);
  container.className = [
    'page',
    baseClass,
    hubInsChrome ? `${baseClass}--ins` : 'scrapbook-page',
    windowTheme ? `${baseClass}--window` : '',
    seaTheme ? `${baseClass}--sea` : '',
    platform === 'wechat' ? `${baseClass}--wechat` : '',
    platform === 'qq' ? `${baseClass}--qq` : '',
    ...extraClasses,
  ].filter(Boolean).join(' ');

  const pageContainer = container.closest('#page-container') || document.getElementById('page-container');
  if (pageContainer && pageContainer.dataset.shell !== 'anon') {
    if (hubInsChrome) pageContainer.dataset.shell = 'chat-ins';
    else if (pageContainer.dataset.shell === 'chat-ins') delete pageContainer.dataset.shell;
  }
}

export function buildChatHubTabsHtml(activeTab, chatPlatform = 'current', options = {}) {
  const platform = normalizeChatPlatform(chatPlatform);
  const tabs = platform === 'wechat'
    ? [
        ['messages', '微信', 'message'],
        ['contacts', '通讯录', 'roleSay'],
        ['discover', '发现', 'select'],
        ['me', '我', 'folder'],
      ]
    : platform === 'qq'
      ? [
          ['messages', '消息', 'message'],
          ['contacts', '联系人', 'roleSay'],
          ['moments', '动态', 'select'],
        ]
      : [
          ['messages', '消息', 'message'],
          ['moments', '朋友圈', 'select'],
          ['intercepts', '陌生消息', 'roleSay'],
          ['backstage', '秘密基地', 'folder'],
        ];
  return tabs.map(([id, label, iconName]) => (
    `<button type="button" class="chat-hub-tab${id === activeTab ? ' is-active' : ''}" data-tab="${id}">${platform === 'current' ? '' : platformTabIcon(platform, id, iconName, options)}<span>${label}</span></button>`
  )).join('');
}

function platformTabIcon(platform, id, fallbackIconName, options = {}) {
  if (platform === 'wechat') {
    const glyph = id === 'messages'
      ? 'chats'
      : id === 'contacts'
        ? 'contacts'
        : id === 'discover'
          ? 'discover'
          : 'me';
    return wechatGlyph(glyph, `chat-hub-tab-icon chat-hub-tab-icon--wechat-${glyph}`);
  }
  if (platform !== 'qq') return icon(fallbackIconName, 'chat-hub-tab-icon');
  if (id === 'messages') {
    return `<svg class="chat-hub-tab-icon chat-hub-tab-icon--qq-message" viewBox="0 0 32 32" aria-hidden="true"><path d="M6.2 6.2h15.6a5.7 5.7 0 0 1 5.7 5.7v5a5.7 5.7 0 0 1-5.7 5.7h-8.2l-6.2 4 .8-4.3a5.7 5.7 0 0 1-5.3-5.7v-4.7a5.7 5.7 0 0 1 3.3-5.7Z" fill="currentColor"/><circle cx="10.4" cy="14.3" r="1.25" fill="#fff"/><circle cx="15.4" cy="14.3" r="1.25" fill="#fff"/><circle cx="20.4" cy="14.3" r="1.25" fill="#fff"/></svg>`;
  }
  if (id === 'contacts') {
    return `<svg class="chat-hub-tab-icon chat-hub-tab-icon--qq-contacts" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="8.8" r="4.8"/><path d="M7.7 27.2c.6-5.6 3.4-8.4 8.3-8.4s7.7 2.8 8.3 8.4H7.7Z"/></svg>`;
  }
  const unreadDot = options.momentsUnread === true
    ? '<circle class="qq-dynamics-dot" cx="26.2" cy="5.8" r="3.2"/>'
    : '';
  return `<svg class="chat-hub-tab-icon chat-hub-tab-icon--qq-dynamics" viewBox="0 0 32 32" aria-hidden="true"><path d="M23.9 8.7A10.8 10.8 0 1 1 8.4 7.4"/><path d="M18.3 5a10.8 10.8 0 0 1 3.2 1.2"/><path class="qq-dynamics-star" d="M25.5 2.9v5.2M22.9 5.5h5.2"/>${unreadDot}</svg>`;
}

function orderSlotsWithActiveFirst(slots, activeUserId) {
  if (!activeUserId || !slots.length) return slots;
  const active = slots.find((slot) => slot.id === activeUserId);
  if (!active) return slots;
  return [active, ...slots.filter((slot) => slot.id !== activeUserId)];
}

function renderSmallUserAvatar(user, className = '') {
  if (user?.avatar) {
    return `<img src="${esc(user.avatar)}" alt="" class="${className}" decoding="async" />`;
  }
  return `<img src="${esc(resolveDefaultAvatar('chat'))}" alt="" class="${className} is-fallback" decoding="async" />`;
}

function bindingFallbackLabel(user) {
  const binding = normalizeIdentityBinding(user?.identityBinding);
  const count = binding.groupIds.length + binding.characterIds.length;
  if (count) return `已绑定 ${count} 项范围`;
  return '全员模式';
}

function userHeaderSummary(user, platform = 'current') {
  if (normalizeChatPlatform(platform) !== 'qq') return bindingFallbackLabel(user);
  return String(user?.statusText || user?.signature || '').trim() || '在线';
}

function getBindingGroupIds(binding = {}) {
  return normalizeIdentityBinding(binding).groupIds;
}

export function identityContactRouteParams(user = {}) {
  const binding = user?.identityBinding && typeof user.identityBinding === 'object'
    ? normalizeIdentityBinding(user.identityBinding)
    : {};
  return {
    scope: 'identity',
    ...(user?.id ? { identityUserId: String(user.id) } : {}),
    ...(binding.groupIds?.length ? { groupIds: binding.groupIds.join(',') } : {}),
    ...(binding.characterIds?.length ? { characterIds: binding.characterIds.join(',') } : {}),
    ...(binding.excludedCharacterIds?.length ? { excludedCharacterIds: binding.excludedCharacterIds.join(',') } : {}),
  };
}

function buildUserHubSlotMenuItems(slots, activeUserId, {
  unreadByUserId = new Map(),
  bindingLabelByUserId = new Map(),
} = {}) {
  const ordered = orderSlotsWithActiveFirst(slots, activeUserId);
  if (!ordered.length) {
    return '<p class="chat-hub-user-slot-menu-empty">还没有关联身份</p>';
  }
  return ordered.map((slot) => {
    const active = slot.id === activeUserId;
    const label = getUserDisplayName(slot);
    const sub = bindingLabelByUserId.get(slot.id) || bindingFallbackLabel(slot);
    const unread = Math.max(0, Number(unreadByUserId.get(slot.id) || 0) || 0);
    return `
      <div class="chat-hub-user-slot-row${active ? ' is-active' : ''}">
      <button type="button" class="chat-hub-user-slot-item${active ? ' is-active' : ''}" data-hub-user-slot-option data-slot-id="${esc(slot.id)}" role="menuitemradio" aria-checked="${active ? 'true' : 'false'}">
        <span class="chat-hub-user-slot-avatar">${renderSmallUserAvatar(slot, 'chat-hub-user-slot-avatar-media')}</span>
        <span class="chat-hub-user-slot-item-text">
          <strong>${esc(label)}</strong>
          <small>${esc(sub)}</small>
        </span>
        ${unread ? `<span class="chat-hub-user-slot-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
        <span class="chat-hub-user-slot-check" aria-hidden="true">${icon('check')}</span>
      </button>
      <button type="button" class="chat-hub-user-slot-delete" data-hub-user-slot-delete="${esc(slot.id)}" aria-label="删除身份 ${esc(label)}">${icon('trash')}</button>
      </div>
    `;
  }).join('');
}

function buildUserHubCard(user, { platform = 'current' } = {}) {
  const displayName = getUserDisplayName(user);
  const signature = String(user?.signature || '').trim() || '写一句个性签名';
  const status = String(user?.statusText || '').trim() || '写点此刻状态';
  const avatarHtml = `<img src="${esc(user?.avatar || resolveDefaultAvatar('chat'))}" alt="" class="chat-hub-user-card-avatar-img" width="52" height="52" decoding="async" />`;
  return `
    <div class="chat-hub-user-card-wrap">
      <button type="button" class="chat-hub-user-card" data-hub-user-drawer-open aria-label="打开身份侧栏" aria-haspopup="dialog" aria-expanded="false">
        <span class="chat-hub-user-card-avatar" aria-hidden="true">
          <span class="chat-hub-user-card-avatar-visual" data-hub-user-avatar-visual>${avatarHtml}</span>
        </span>
        <div class="chat-hub-user-card-body">
          <span class="chat-hub-user-card-mark" aria-hidden="true"></span>
          <div class="chat-hub-user-card-lines">
            <strong class="chat-hub-user-card-name" data-hub-user-name>${esc(displayName)}</strong>
            <small class="chat-hub-user-card-binding" data-hub-header-summary>${esc(userHeaderSummary(user, platform))}</small>
          </div>
        </div>
        <span class="chat-hub-user-card-slot-chevron" aria-hidden="true">${icon('chevron')}</span>
      </button>

      <div class="chat-hub-user-drawer-layer" data-hub-user-drawer hidden>
        <button type="button" class="chat-hub-user-drawer-backdrop" data-hub-user-drawer-close aria-label="关闭身份侧栏"></button>
        <aside class="chat-hub-user-drawer" role="dialog" aria-modal="true" aria-label="身份与功能">
          <header class="chat-hub-user-drawer-head">
            <button type="button" class="chat-hub-user-drawer-close" data-hub-user-drawer-close aria-label="关闭">${icon('close')}</button>
            <label class="chat-hub-user-drawer-avatar" data-hub-user-avatar aria-label="更换头像">
              <span class="chat-hub-user-card-avatar-visual" data-hub-user-avatar-visual>${avatarHtml}</span>
              <input type="file" accept="image/*" data-hub-user-avatar-file hidden>
            </label>
            <div class="chat-hub-user-drawer-profile">
              <button type="button" class="chat-hub-user-drawer-name" data-hub-user-slot-edit>
                <strong data-hub-user-name>${esc(displayName)}</strong>
                <span>${icon('chevron')}</span>
              </button>
              <button type="button" class="chat-hub-user-card-line chat-hub-user-card-sign${user?.signature ? '' : ' is-empty'}" data-hub-user-signature>${esc(signature)}</button>
              <button type="button" class="chat-hub-user-card-line chat-hub-user-card-status${user?.statusText ? '' : ' is-empty'}" data-hub-user-status>${esc(status)}</button>
            </div>
          </header>

          <div class="chat-hub-user-drawer-scroll">
            <section class="chat-hub-user-drawer-section">
              <div class="chat-hub-user-drawer-section-head">
                <span>关联身份</span>
                <span class="chat-hub-user-drawer-section-actions">
                  <button type="button" data-hub-user-create>新建身份</button>
                  <button type="button" data-hub-user-slot-manage>档位</button>
                </span>
              </div>
              <div class="chat-hub-user-slot-menu-list" data-hub-user-slot-list role="menu" aria-label="切换关联身份"></div>
            </section>

            <section class="chat-hub-user-drawer-section chat-hub-user-drawer-offline" data-hub-offline-section hidden>
              <div class="chat-hub-user-drawer-section-head">
                <span>未完成线下</span>
                <button type="button" data-hub-offline-all>全部</button>
              </div>
              <div class="chat-hub-user-drawer-offline-list" data-hub-offline-list></div>
            </section>

            <nav class="chat-hub-user-drawer-nav" aria-label="当前身份功能">
              <button type="button" data-hub-binding-open>
                <span class="chat-hub-user-drawer-nav-icon">${icon('link')}</span>
                <span><strong>角色绑定</strong><small data-hub-binding-summary>${esc(bindingFallbackLabel(user))}</small></span>
                <span class="chat-hub-user-drawer-nav-chevron">${icon('chevron')}</span>
              </button>
              <button type="button" data-hub-route="contacts">
                <span class="chat-hub-user-drawer-nav-icon">${icon('folder')}</span>
                <span><strong>通讯录</strong></span>
                <span class="chat-hub-user-drawer-nav-chevron">${icon('chevron')}</span>
              </button>
              <button type="button" data-hub-route="relationship/network">
                <span class="chat-hub-user-drawer-nav-icon">${icon('select')}</span>
                <span><strong>关系网</strong></span>
                <span class="chat-hub-user-drawer-nav-chevron">${icon('chevron')}</span>
              </button>
              ${platform === 'qq' ? `<button type="button" data-hub-route="chat/intercepts">
                <span class="chat-hub-user-drawer-nav-icon">${icon('shield')}</span>
                <span><strong>骚扰拦截</strong></span>
                <span class="chat-hub-user-drawer-nav-chevron">${icon('chevron')}</span>
              </button>` : ''}
              <button type="button" data-hub-route="chat/aliases">
                <span class="chat-hub-user-drawer-nav-icon">${icon('roleSay')}</span>
                <span><strong>我的马甲与小号</strong></span>
                <span class="chat-hub-user-drawer-nav-chevron">${icon('chevron')}</span>
              </button>
              <button type="button" data-hub-route="identity/appearance">
                <span class="chat-hub-user-drawer-nav-icon">${icon('palette')}</span>
                <span><strong>本身份装扮</strong><small>消息预设、壁纸与首页背景</small></span>
                <span class="chat-hub-user-drawer-nav-chevron">${icon('chevron')}</span>
              </button>
              <button type="button" data-hub-chat-platform-open>
                <span class="chat-hub-user-drawer-nav-icon">${icon('message')}</span>
                <span><strong>聊天外观</strong><small data-hub-chat-platform-summary>原有样式</small></span>
                <span class="chat-hub-user-drawer-nav-chevron">${icon('chevron')}</span>
              </button>
            </nav>

            <section class="chat-hub-user-drawer-section chat-hub-user-drawer-ensemble">
              <button type="button" class="chat-hub-ensemble-toggle" data-hub-ensemble-toggle role="switch" aria-checked="false">
                <span class="chat-hub-ensemble-toggle-text">
                  <strong>${ENSEMBLE_MODE_LABEL}</strong>
                  <small>当前身份的群像联动</small>
                </span>
                <span class="chat-hub-ensemble-switch" aria-hidden="true"><span></span></span>
              </button>
              <button type="button" class="chat-hub-ensemble-background" data-hub-ensemble-background hidden>
                <span class="chat-hub-ensemble-toggle-text">
                  <strong>当前背景</strong>
                  <small data-hub-ensemble-background-summary>未填写 · 点击设置</small>
                </span>
                <span class="chat-hub-ensemble-background-chevron" aria-hidden="true">›</span>
              </button>
            </section>
          </div>

          <footer class="chat-hub-user-drawer-foot">
            ${platform === 'qq' ? `<button type="button" data-hub-route="home">
              ${icon('home')}<span>主页</span>
            </button>` : ''}
            <button type="button" data-hub-route="user-space">
              ${icon('database')}<span>${esc(user?.slotName || '档位与备份')}</span>
            </button>
            <button type="button" data-hub-route="settings">
              ${icon('settings')}<span>设置</span>
            </button>
          </footer>
        </aside>
      </div>

      <div class="chat-hub-binding-layer" data-hub-binding-layer hidden>
        <button type="button" class="chat-hub-binding-backdrop" data-hub-binding-close aria-label="关闭绑定设置"></button>
        <section class="chat-hub-binding-sheet" role="dialog" aria-modal="true" aria-label="角色绑定">
          <header>
            <h2>角色绑定</h2>
            <button type="button" data-hub-binding-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="chat-hub-binding-options" data-hub-binding-options></div>
          <footer>
            <button type="button" class="chat-hub-binding-save" data-hub-binding-save>保存</button>
          </footer>
        </section>
      </div>

      <div class="chat-platform-layer" data-hub-chat-platform-layer hidden>
        <button type="button" class="chat-platform-backdrop" data-hub-chat-platform-close aria-label="关闭聊天外观"></button>
        <section class="chat-platform-sheet" role="dialog" aria-modal="true" aria-label="聊天外观">
          <header><h2>聊天外观</h2><button type="button" data-hub-chat-platform-close aria-label="关闭">${icon('close')}</button></header>
          <div class="chat-platform-sheet-options" role="radiogroup" aria-label="全局聊天外观">
            <button type="button" data-hub-chat-platform-option="current" role="radio">原有样式</button>
            <button type="button" data-hub-chat-platform-option="wechat" role="radio" aria-label="微信"><span class="chat-platform-sheet-label">微信<small>原生四栏与朋友圈</small></span></button>
            <button type="button" data-hub-chat-platform-option="qq" role="radio" aria-label="QQ"><span class="chat-platform-sheet-label">QQ<small>原生消息、联系人与空间</small></span></button>
          </div>
        </section>
      </div>
    </div>
  `;
}

export function buildChatHubInsChrome({
  activeTab = 'messages',
  toolbarActionsHtml = '',
  user = null,
  showUserCard = true,
  showTabs = true,
  showSearch = false,
  pageTitle = '',
  momentsUnread = false,
  chatPlatform = document.documentElement.dataset.chatPlatform || 'current',
} = {}) {
  const platform = normalizeChatPlatform(chatPlatform);
  const titleHtml = pageTitle
    ? `<h1 class="chat-hub-ins-page-title">${esc(pageTitle)}</h1>`
    : '';
  const tabsHtml = showTabs
    ? `<nav class="chat-hub-tabs chat-hub-tabs--ins chat-hub-tabs--${platform}" aria-label="Chat 分区">${buildChatHubTabsHtml(activeTab, platform, { momentsUnread })}</nav>`
    : '';
  const userCardHtml = showUserCard && user ? buildUserHubCard(user, { platform }) : '';
  const platformTitle = !pageTitle && platform === 'wechat'
    ? '<h1 class="chat-hub-platform-title">微信</h1>'
    : '';
  const leadingControl = !pageTitle && platform === 'wechat'
    ? '<button type="button" class="chat-hub-wechat-home" data-hub-route="home" aria-label="返回主页"><span aria-hidden="true">•••</span></button>'
    : `<button type="button" class="chat-hub-back" data-back aria-label="返回">${icon('back')}</button>`;
  const searchHtml = showSearch && platform !== 'current'
    ? `<label class="chat-hub-platform-search chat-hub-platform-search--${platform}"${platform === 'wechat' ? ' hidden' : ''}>${wechatGlyph('search')}<input type="search" data-chat-hub-search placeholder="搜索" aria-label="搜索消息" /></label>`
    : '';
  return `
    <header class="chat-hub-ins-chrome chat-hub-ins-chrome--${platform}">
      <div class="chat-hub-toolbar">
        ${leadingControl}
        ${platformTitle}
        <div class="chat-hub-toolbar-actions">${toolbarActionsHtml}</div>
      </div>
      ${userCardHtml}
      ${searchHtml}
      ${titleHtml}
      ${tabsHtml}
    </header>
  `;
}

function renderUserCardAvatarMarkup(user) {
  return `<img src="${esc(user?.avatar || resolveDefaultAvatar('chat'))}" alt="" class="chat-hub-user-card-avatar-img" width="52" height="52" decoding="async" />`;
}

function updateUserCardAvatarVisual(container, user) {
  container.querySelectorAll('[data-hub-user-avatar-visual]').forEach((visual) => {
    visual.innerHTML = renderUserCardAvatarMarkup(user);
  });
}

function updateUserHubCardDom(container, user) {
  if (!container || !user) return;
  updateUserCardAvatarVisual(container, user);
  container.querySelectorAll('[data-hub-user-name]').forEach((el) => {
    el.textContent = getUserDisplayName(user);
  });
  container.querySelectorAll('[data-hub-header-summary]').forEach((el) => {
    el.textContent = userHeaderSummary(user, document.documentElement.dataset.chatPlatform);
  });

  const signatureBtn = container.querySelector('[data-hub-user-signature]');
  const signatureText = String(user.signature || '').trim();
  if (signatureBtn) {
    signatureBtn.textContent = signatureText || '写一句个性签名';
    signatureBtn.classList.toggle('is-empty', !signatureText);
  }

  const statusBtn = container.querySelector('[data-hub-user-status]');
  const statusText = String(user.statusText || '').trim();
  if (statusBtn) {
    statusBtn.textContent = statusText || '写点此刻状态';
    statusBtn.classList.toggle('is-empty', !statusText);
  }
}

function bindChatHubUserSlotMenu(container, user, { onUpdated, onSlotChanged } = {}) {
  const triggers = [...container.querySelectorAll('[data-hub-user-drawer-open]')];
  const trigger = triggers[0];
  const layer = container.querySelector('[data-hub-user-drawer]');
  const drawer = container.querySelector('.chat-hub-user-drawer');
  const list = container.querySelector('[data-hub-user-slot-list]');
  const editBtn = container.querySelector('[data-hub-user-slot-edit]');
  const createBtn = container.querySelector('[data-hub-user-create]');
  const slotManageBtn = container.querySelector('[data-hub-user-slot-manage]');
  const ensembleBtn = container.querySelector('[data-hub-ensemble-toggle]');
  const ensembleBackgroundBtn = container.querySelector('[data-hub-ensemble-background]');
  const ensembleBackgroundSummary = container.querySelector('[data-hub-ensemble-background-summary]');
  const bindingLayer = container.querySelector('[data-hub-binding-layer]');
  const bindingOptions = container.querySelector('[data-hub-binding-options]');
  const bindingSave = container.querySelector('[data-hub-binding-save]');
  const platformLayer = container.querySelector('[data-hub-chat-platform-layer]');
  const platformSummary = container.querySelector('[data-hub-chat-platform-summary]');
  const offlineSection = container.querySelector('[data-hub-offline-section]');
  const offlineList = container.querySelector('[data-hub-offline-list]');
  if (!trigger || !layer || !drawer || !list) return;

  const restoreDrawerOpen = container.dataset.hubUserDrawerOpen === 'true';
  let drawerOpen = false;
  let closeTimer = 0;
  let openFrame = 0;
  let directory = null;
  let pendingBinding = normalizeIdentityBinding(user?.identityBinding);
  let swipeStartX = 0;

  const bindingLabel = (profile = user) => {
    const binding = normalizeIdentityBinding(profile?.identityBinding);
    if (binding.groupIds.length || binding.characterIds.length) {
      const selectedIds = directory?.characters?.filter((character) => {
        if (binding.excludedCharacterIds.includes(character.id)) return false;
        return binding.characterIds.includes(character.id)
          || binding.groupIds.includes(directory.groupIdByCharacter.get(character.id));
      }).map((character) => character.id) || [];
      if (selectedIds.length) return `已选 ${selectedIds.length} 位角色`;
      return '已设置角色范围';
    }
    return '全员模式';
  };

  const updateBindingSummary = () => {
    const text = bindingLabel(user);
    container.querySelectorAll('[data-hub-binding-summary]').forEach((el) => {
      el.textContent = text;
    });
  };

  const loadDirectory = async ({ force = false } = {}) => {
    if (directory && !force) return directory;
    const [{ listCharacters }, { loadContactGroupsConfig, resolveCharacterGroupId }] = await Promise.all([
      import('../character-store.js'),
      import('../contact-groups.js'),
    ]);
    const [characters, groupConfig] = await Promise.all([
      listCharacters({ excludeAnonNpc: true, userId: user?.id }).catch(() => []),
      loadContactGroupsConfig().catch(() => ({ groups: [] })),
    ]);
    const groupById = new Map((groupConfig.groups || []).map((group) => [group.id, group]));
    const groupCounts = new Map();
    for (const character of characters) {
      const groupId = resolveCharacterGroupId(character);
      groupCounts.set(groupId, Number(groupCounts.get(groupId) || 0) + 1);
    }
    directory = {
      characters,
      groupConfig,
      groupById,
      groupCounts,
      groupIdByCharacter: new Map(characters.map((character) => [
        character.id,
        resolveCharacterGroupId(character),
      ])),
      characterById: new Map(characters.map((character) => [character.id, character])),
    };
    updateBindingSummary();
    return directory;
  };

  const setDrawerOpen = (open, { immediate = false, focus = true } = {}) => {
    drawerOpen = open === true;
    container.dataset.hubUserDrawerOpen = drawerOpen ? 'true' : 'false';
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = 0;
    }
    if (openFrame) {
      window.cancelAnimationFrame(openFrame);
      openFrame = 0;
    }
    triggers.forEach((button) => button.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false'));
    if (drawerOpen) {
      layer.hidden = false;
      document.documentElement.classList.add('chat-hub-drawer-open');
      document.addEventListener('keydown', onEscape, true);
      if (immediate) {
        layer.classList.add('is-open');
      } else {
        openFrame = window.requestAnimationFrame(() => {
          openFrame = 0;
          if (drawerOpen && !layer.hidden && layer.isConnected) layer.classList.add('is-open');
        });
      }
      if (focus) drawer.querySelector('[data-hub-user-drawer-close]')?.focus({ preventScroll: true });
      return;
    }
    layer.classList.remove('is-open');
    document.documentElement.classList.remove('chat-hub-drawer-open');
    document.removeEventListener('keydown', onEscape, true);
    closeTimer = window.setTimeout(() => {
      if (!drawerOpen) layer.hidden = true;
    }, 210);
  };

  const platformLabel = (value) => value === 'wechat' ? '微信' : value === 'qq' ? 'QQ' : '原有样式';
  const platformSummaryLabel = (value) => value === 'wechat' ? '微信 · 原生四栏与朋友圈' : value === 'qq' ? 'QQ · 消息、联系人与空间' : '原有样式';
  const syncPlatformPicker = () => {
    const active = normalizeChatPlatform(document.documentElement.dataset.chatPlatform);
    if (platformSummary) platformSummary.textContent = platformSummaryLabel(active);
    platformLayer?.querySelectorAll('[data-hub-chat-platform-option]').forEach((button) => {
      const selected = button.getAttribute('data-hub-chat-platform-option') === active;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
  };

  const onEscape = (ev) => {
    if (ev.key !== 'Escape') return;
    if (bindingLayer && !bindingLayer.hidden) {
      bindingLayer.hidden = true;
      return;
    }
    setDrawerOpen(false);
  };

  const refreshSlotList = async () => {
    const [slots, dir, chatStore] = await Promise.all([
      listUsersInSlot(user?.id),
      loadDirectory(),
      import('../chat-store.js'),
    ]);
    const unreadByUserId = new Map();
    await Promise.all(slots.map(async (slot) => {
      const chats = await chatStore.listChatsForUser(slot.id).catch(() => []);
      unreadByUserId.set(slot.id, chats.reduce((sum, chat) => (
        sum + Math.max(0, Number(chat?.unread || 0) || 0)
      ), 0));
    }));
    const bindingLabelByUserId = new Map(slots.map((slot) => {
      return [slot.id, bindingLabel(slot)];
    }));
    list.innerHTML = buildUserHubSlotMenuItems(slots, user?.id, {
      unreadByUserId,
      bindingLabelByUserId,
    });
    list.querySelectorAll('[data-hub-user-slot-option]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = btn.getAttribute('data-slot-id');
        if (!id || id === user?.id) {
          setDrawerOpen(false);
          return;
        }
        try {
          await setCurrentUserId(id);
          const next = await getCurrentUser();
          if (!next) throw new Error('身份不存在');
          Object.assign(user, next);
          directory = null;
          updateUserHubCardDom(container, next);
          updateBindingSummary();
          setDrawerOpen(false);
          showToast('已切换身份');
          onUpdated?.(next);
          await onSlotChanged?.(next);
        } catch (err) {
          showToast(String(err?.message || err));
        }
      });
    });
    list.querySelectorAll('[data-hub-user-slot-delete]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = String(btn.getAttribute('data-hub-user-slot-delete') || '').trim();
        const target = slots.find((slot) => slot.id === id);
        if (!id || !target) return;
        const deletedActiveIdentity = id === user?.id;
        const label = getUserDisplayName(target);
        if (!window.confirm(`删除身份「${label}」及其聊天、记忆和独立设置？此操作不可恢复。`)) return;
        btn.disabled = true;
        try {
          await deleteUserIdentity(id);
          const next = await getCurrentUser();
          if (!next) throw new Error('删除后没有可用身份');
          Object.assign(user, next);
          directory = null;
          updateUserHubCardDom(container, next);
          updateBindingSummary();
          showToast('身份及其记录已删除');
          await refreshSlotList();
          onUpdated?.(next);
          if (deletedActiveIdentity) await onSlotChanged?.(next);
        } catch (err) {
          showToast(String(err?.message || err));
          if (btn.isConnected) btn.disabled = false;
        }
      });
    });
  };

  const refreshEnsembleToggle = async () => {
    if (!ensembleBtn) return;
    const config = await loadEnsembleModeConfig(user?.id).catch(() => ({ enabled: false }));
    ensembleBtn.classList.toggle('is-active', config.enabled === true);
    ensembleBtn.setAttribute('aria-checked', config.enabled === true ? 'true' : 'false');
    if (ensembleBackgroundBtn) ensembleBackgroundBtn.hidden = config.enabled !== true;
    if (ensembleBackgroundSummary) {
      const background = String(config.currentBackground || '').replace(/\s+/g, ' ').trim();
      ensembleBackgroundSummary.textContent = background
        ? background.slice(0, 42)
        : '未填写 · 点击设置';
    }
  };

  const refreshOfflineSessions = async () => {
    if (!offlineSection || !offlineList) return;
    const [{ listActiveOfflineSessionsForUser }, dir] = await Promise.all([
      import('../offline-session.js'),
      loadDirectory(),
    ]);
    const active = await listActiveOfflineSessionsForUser(user?.id).catch(() => []);
    offlineSection.hidden = !active.length;
    if (!active.length) {
      offlineList.innerHTML = '';
      return;
    }
    offlineList.innerHTML = active.slice(0, 4).map(({ chat, session }) => {
      const participantIds = (chat?.participants || []).filter((id) => id && id !== 'user');
      const participantNames = participantIds.map((id) => {
        const character = dir.characterById.get(id);
        return character?.customNickname || character?.name || '';
      }).filter(Boolean);
      const title = chat?.type === 'group'
        ? (chat.groupSettings?.name || participantNames.join('、') || '多人线下')
        : `与 ${participantNames[0] || 'TA'} 的线下`;
      const place = String(session?.scene?.place || session?.scene?.goal || '').trim();
      return `
        <button type="button" class="chat-hub-user-drawer-offline-item" data-hub-offline-chat="${esc(chat.id)}">
          <span class="chat-hub-user-drawer-offline-dot" aria-hidden="true"></span>
          <span><strong>${esc(title)}</strong>${place ? `<small>${esc(place)}</small>` : ''}</span>
          <span class="chat-hub-user-drawer-nav-chevron">${icon('chevron')}</span>
        </button>
      `;
    }).join('');
    offlineList.querySelectorAll('[data-hub-offline-chat]').forEach((button) => {
      button.addEventListener('click', () => {
        const chatId = String(button.getAttribute('data-hub-offline-chat') || '').trim();
        if (!chatId) return;
        setDrawerOpen(false);
        navigate('offline', { chatId });
      });
    });
  };

  const renderBindingOptions = async () => {
    if (!bindingOptions) return;
    const dir = await loadDirectory({ force: true });
    pendingBinding = normalizeIdentityBinding(pendingBinding);
    const selectedGroupIds = new Set(pendingBinding.groupIds);
    const explicitCharacterIds = new Set(pendingBinding.characterIds);
    const excludedCharacterIds = new Set(pendingBinding.excludedCharacterIds);
    const characterIsSelected = (character) => !excludedCharacterIds.has(character.id)
      && (explicitCharacterIds.has(character.id)
        || selectedGroupIds.has(dir.groupIdByCharacter.get(character.id)));
    const option = ({ type = '', targetId = '', title, detail = '', active = false }) => {
      return `
        <button type="button" class="chat-hub-binding-option${active ? ' is-active' : ''}" data-binding-type="${esc(type)}" data-binding-target="${esc(targetId)}" aria-pressed="${active ? 'true' : 'false'}">
          <span><strong>${esc(title)}</strong>${detail ? `<small>${esc(detail)}</small>` : ''}</span>
          <span class="chat-hub-binding-option-check">${icon('check')}</span>
        </button>
      `;
    };
    const groups = (dir.groupConfig.groups || [])
      .filter((group) => group?.id && group.id !== 'anon_npc')
      .map((group) => option({
        type: 'group',
        targetId: group.id,
        title: group.name || '未命名分组',
        detail: `${Number(dir.groupCounts.get(group.id) || 0)} 位角色`,
        active: selectedGroupIds.has(group.id),
      })).join('');
    const characters = dir.characters.map((character) => option({
      type: 'character',
      targetId: character.id,
      title: character.customNickname || character.name || '未命名角色',
      detail: dir.groupById.get(dir.groupIdByCharacter.get(character.id))?.name || '未分组',
      active: characterIsSelected(character),
    })).join('');
    bindingOptions.innerHTML = `
      <div class="chat-hub-binding-group">
        ${option({ title: '暂不绑定', active: !hasActiveIdentityBinding(pendingBinding) })}
      </div>
      ${groups ? `<div class="chat-hub-binding-group"><h3>角色分组 · 可多选</h3>${groups}</div>` : ''}
      ${characters ? `<div class="chat-hub-binding-group"><h3>角色 · 可多选</h3>${characters}</div>` : ''}
    `;
    bindingOptions.querySelectorAll('[data-binding-type]').forEach((button) => {
      button.addEventListener('click', () => {
        const type = String(button.getAttribute('data-binding-type') || '');
        const targetId = String(button.getAttribute('data-binding-target') || '');
        if (type === 'group') {
          const groupIds = new Set(pendingBinding.groupIds);
          const excluded = new Set(pendingBinding.excludedCharacterIds);
          if (groupIds.has(targetId)) groupIds.delete(targetId);
          else {
            groupIds.add(targetId);
            for (const character of dir.characters) {
              if (dir.groupIdByCharacter.get(character.id) === targetId) excluded.delete(character.id);
            }
          }
          pendingBinding = normalizeIdentityBinding({
            groupIds: [...groupIds],
            characterIds: pendingBinding.characterIds,
            excludedCharacterIds: [...excluded],
          });
        } else if (type === 'character') {
          const characterIds = new Set(pendingBinding.characterIds);
          const excluded = new Set(pendingBinding.excludedCharacterIds);
          const includedByGroup = selectedGroupIds.has(dir.groupIdByCharacter.get(targetId));
          const selected = characterIds.has(targetId) || (includedByGroup && !excluded.has(targetId));
          if (includedByGroup) {
            characterIds.delete(targetId);
            if (selected) excluded.add(targetId);
            else excluded.delete(targetId);
          } else {
            excluded.delete(targetId);
            if (characterIds.has(targetId)) characterIds.delete(targetId);
            else characterIds.add(targetId);
          }
          pendingBinding = normalizeIdentityBinding({
            groupIds: pendingBinding.groupIds,
            characterIds: [...characterIds],
            excludedCharacterIds: [...excluded],
          });
        } else {
          pendingBinding = normalizeIdentityBinding({});
        }
        void renderBindingOptions();
      });
    });
  };

  triggers.forEach((button) => button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (drawerOpen) {
      setDrawerOpen(false);
      return;
    }
    setDrawerOpen(true);
    Promise.all([
      refreshSlotList(),
      refreshEnsembleToggle(),
      refreshOfflineSessions(),
    ]).catch(() => {});
  }));

  layer.querySelectorAll('[data-hub-user-drawer-close]').forEach((button) => {
    button.addEventListener('click', () => setDrawerOpen(false));
  });
  drawer.addEventListener('touchstart', (ev) => {
    swipeStartX = Number(ev.touches?.[0]?.clientX || 0);
  }, { passive: true });
  drawer.addEventListener('touchend', (ev) => {
    const endX = Number(ev.changedTouches?.[0]?.clientX || 0);
    if (swipeStartX && endX - swipeStartX < -56) setDrawerOpen(false);
    swipeStartX = 0;
  }, { passive: true });

  ensembleBtn?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const config = await loadEnsembleModeConfig(user?.id).catch(() => ({ enabled: false, noticeSeenAt: 0 }));
    let nextEnabled = config.enabled !== true;
    let noticeSeen = config.noticeSeenAt > 0;
    if (nextEnabled && !noticeSeen) {
      setDrawerOpen(false);
      const confirmed = await openEnsembleModeNotice();
      if (!confirmed) return;
      noticeSeen = true;
    }
    const next = await setEnsembleModeEnabled(user?.id, nextEnabled, { noticeSeen }).catch(() => null);
    if (!next) {
      showToast('群像模式设置保存失败');
      return;
    }
    ensembleBtn.classList.toggle('is-active', next.enabled === true);
    ensembleBtn.setAttribute('aria-checked', next.enabled === true ? 'true' : 'false');
    if (ensembleBackgroundBtn) ensembleBackgroundBtn.hidden = next.enabled !== true;
    showToast(next.enabled ? '群像模式已开启' : '群像模式已关闭');
  });

  ensembleBackgroundBtn?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const config = await loadEnsembleModeConfig(user?.id).catch(() => ({ currentBackground: '' }));
    setDrawerOpen(false);
    openTextEditorModal({
      title: '群像模式 · 当前背景',
      value: config.currentBackground || '',
      placeholder: '写明当前事件、各角色所在位置、已经发生的进度，以及接下来希望推进的方向。',
      multiline: true,
      onSave: async (value) => {
        const next = await saveEnsembleCurrentBackground(user?.id, value).catch(() => null);
        if (!next) {
          showToast('当前背景保存失败');
          return;
        }
        const background = String(next.currentBackground || '').replace(/\s+/g, ' ').trim();
        if (ensembleBackgroundSummary) {
          ensembleBackgroundSummary.textContent = background
            ? background.slice(0, 42)
            : '未填写 · 点击设置';
        }
        showToast(background ? '当前背景已更新' : '当前背景已清空');
      },
    });
  });

  editBtn?.addEventListener('click', () => {
    setDrawerOpen(false);
    navigate('user-space/edit');
  });
  slotManageBtn?.addEventListener('click', () => {
    setDrawerOpen(false);
    navigate('user-space');
  });
  createBtn?.addEventListener('click', () => {
    setDrawerOpen(false);
    openTextEditorModal({
      title: '新建身份',
      value: '',
      placeholder: '身份名称',
      multiline: false,
      onSave: async (value) => {
        const name = String(value || '').trim();
        if (!name) {
          showToast('请填写身份名称');
          return;
        }
        try {
          const created = await createLinkedUser(user?.id, name);
          await setCurrentUserId(created.id);
          Object.assign(user, created);
          showToast(`已新建并切换到「${name}」`);
          onUpdated?.(created);
          await onSlotChanged?.(created);
        } catch (err) {
          showToast(String(err?.message || err));
        }
      },
    });
  });

  container.querySelector('[data-hub-binding-open]')?.addEventListener('click', () => {
    if (!bindingLayer) return;
    pendingBinding = normalizeIdentityBinding(user?.identityBinding);
    bindingLayer.hidden = false;
    void renderBindingOptions();
  });
  container.querySelectorAll('[data-hub-binding-close]').forEach((button) => {
    button.addEventListener('click', () => {
      if (bindingLayer) bindingLayer.hidden = true;
    });
  });
  container.querySelector('[data-hub-chat-platform-open]')?.addEventListener('click', () => {
    setDrawerOpen(false);
    syncPlatformPicker();
    if (platformLayer) platformLayer.hidden = false;
  });
  container.querySelectorAll('[data-hub-chat-platform-close]').forEach((button) => {
    button.addEventListener('click', () => {
      if (platformLayer) platformLayer.hidden = true;
    });
  });
  platformLayer?.querySelectorAll('[data-hub-chat-platform-option]').forEach((button) => {
    button.addEventListener('click', async () => {
      const next = normalizeChatPlatform(button.getAttribute('data-hub-chat-platform-option'));
      button.disabled = true;
      try {
        await setChatPlatform(next);
        if (platformLayer) platformLayer.hidden = true;
        showToast(`已切换为${platformLabel(next)}聊天外观`);
        navigate('chat', {}, true);
      } catch (error) {
        showToast(error?.message || '聊天外观切换失败');
        if (button.isConnected) button.disabled = false;
      }
    });
  });
  syncPlatformPicker();
  bindingSave?.addEventListener('click', async () => {
    const next = await saveUserRecord({ ...user, identityBinding: pendingBinding }).catch(() => null);
    if (!next) {
      showToast('角色绑定保存失败');
      return;
    }
    Object.assign(user, next);
    updateBindingSummary();
    if (bindingLayer) bindingLayer.hidden = true;
    await refreshSlotList().catch(() => {});
    onUpdated?.(next);
    showToast(next.identityBinding?.type ? '角色绑定已更新' : '已取消角色绑定');
  });

  container.querySelectorAll('[data-hub-route]').forEach((button) => {
    button.addEventListener('click', () => {
      const path = String(button.getAttribute('data-hub-route') || '').trim();
      if (!path) return;
      const binding = user?.identityBinding || {};
      const hasIdentityBinding = hasActiveIdentityBinding(binding);
      let params = {};
      if (path === 'contacts') {
        params = identityContactRouteParams(user);
      } else if (path === 'relationship/network' && hasIdentityBinding) {
        params = { scope: 'identity' };
      }
      setDrawerOpen(false);
      navigate(path, params, path === 'home');
    });
  });
  container.querySelector('[data-hub-offline-all]')?.addEventListener('click', () => {
    setDrawerOpen(false);
    navigate('encounter/date-log');
  });

  drawer.addEventListener('touchmove', (ev) => {
    ev.stopPropagation();
  }, { passive: true });

  // Chat 列表和联系人页会在后台数据补齐时整页重绘。侧栏状态留在稳定的
  // 页面容器上，重绑新 DOM 时同步恢复，避免用户刚打开就被异步 paint 关掉。
  if (restoreDrawerOpen) {
    setDrawerOpen(true, { immediate: true, focus: false });
    Promise.all([
      refreshSlotList(),
      refreshEnsembleToggle(),
      refreshOfflineSessions(),
    ]).catch(() => {});
  }
}

export function bindChatHubUserCard(container, user, { onUpdated, onSlotChanged } = {}) {
  if (!container || !user) return;

  const drawerLayer = container.querySelector('[data-hub-user-drawer]');
  if (drawerLayer?.dataset.hubUserCardBound === 'true') return;
  if (drawerLayer) drawerLayer.dataset.hubUserCardBound = 'true';

  container.querySelector('[data-hub-user-avatar-file]')?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const result = await fileToCroppedOptimizedAvatarDataUrl(file);
      if (!result) return;
      const next = await saveUserRecord({ ...user, avatar: result.dataUrl });
      Object.assign(user, next);
      updateUserCardAvatarVisual(container, next);
      onUpdated?.(next);
    } catch (err) {
      showToast(err?.message || '头像更新失败');
    }
  });

  const bindTextField = (selector, field, title, placeholder, multiline = true) => {
    container.querySelector(selector)?.addEventListener('click', () => {
      openTextEditorModal({
        title,
        value: String(user[field] || ''),
        placeholder,
        multiline,
        onSave: async (val) => {
          const before = String(user[field] || '').trim();
          const after = String(val || '').trim();
          const next = await saveUserRecord({ ...user, [field]: after });
          Object.assign(user, next);
          const btn = container.querySelector(selector);
          const text = String(next[field] || '').trim() || placeholder;
          if (btn) {
            btn.textContent = text;
            btn.classList.toggle('is-empty', !String(next[field] || '').trim());
          }
          if (before !== after && (field === 'signature' || field === 'statusText')) {
            const event = field === 'signature'
              ? {
                id: `profile_signature_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                type: 'signature',
                text: after
                  ? `用户刚换了个性签名：${cleanProfileEventText(after, 180)}`
                  : '用户刚清空了个性签名。',
                createdAt: Date.now(),
                seenChatIds: [],
              }
              : {
                id: `profile_status_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                type: 'status',
                text: after
                  ? `用户刚更新了此刻状态：${cleanProfileEventText(after, 120)}`
                  : '用户刚清空了此刻状态。',
                createdAt: Date.now(),
                seenChatIds: [],
              };
            await appendUserProfileChangeEvents(next.id, [event]).catch(() => {});
          }
          onUpdated?.(next);
        },
      });
    });
  };

  bindTextField('[data-hub-user-signature]', 'signature', '个性签名', '写一句个性签名', true);
  bindTextField('[data-hub-user-status]', 'statusText', '此刻状态', '写点此刻状态', false);
  bindChatHubUserSlotMenu(container, user, { onUpdated, onSlotChanged });
}

export function bindChatHubInsTabs(container, activeTab) {
  container.querySelectorAll('.chat-hub-tab').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.getAttribute('data-tab');
      if (!next || next === activeTab) return;
      if (next === 'messages') navigate('chat', {}, true);
      else if (next === 'contacts') {
        const platform = String(document.documentElement.dataset.chatPlatform || '').trim();
        const user = await getCurrentUser().catch(() => null);
        navigate(
          platform === 'qq' ? 'chat/contacts' : platform === 'wechat' ? 'chat/wechat-contacts' : 'contacts',
          identityContactRouteParams(user),
          platform !== 'current',
        );
      }
      else if (next === 'discover') navigate('chat/wechat-discover', {}, true);
      else if (next === 'me') navigate('chat/wechat-me', {}, true);
      else if (next === 'moments') navigate('chat/moments', {}, true);
      else if (next === 'intercepts') navigate('chat/intercepts', {}, true);
      else navigate('chat/backstage', {}, true);
    });
  });
}

export function chatHubInsToolbarIcon(className, label, iconName, extraAttrs = {}) {
  const attrs = Object.entries(extraAttrs)
    .map(([key, value]) => (value === '' ? key : `${key}="${value}"`))
    .join(' ');
  return `<button type="button" class="chat-hub-icon-btn ${className}" aria-label="${label}"${attrs ? ` ${attrs}` : ''}>${icon(iconName)}</button>`;
}
