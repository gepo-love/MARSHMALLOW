import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { bindLongPress } from '../components/chat-bubble-menu.js';
import { openChatRowSheet } from '../components/chat-row-sheet.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { clearChatUnread, deleteChatWithData } from '../core/chat-store.js';
import { onStoreWrite } from '../core/db.js';
import { listUserInterceptThreads } from '../core/stranger-thread-store.js';
import { principalKey } from '../core/alias-account-model.js';
import { listAliasAccounts, listCharacterAliasAccountsForUser } from '../core/alias-account-store.js';
import { isStrangerInterceptChat } from '../core/stranger-thread-model.js';
import { listCharacters } from '../core/character-store.js';
import { deleteQqContactApplicationsForThread } from '../core/qq-contact-applications.js';
import {
  loadUserInterceptSettings,
  maybeGenerateUserIntercepts,
  saveUserInterceptSettings,
} from '../core/user-intercept-auto.js';
import {
  applyChatHubInsPageClasses,
  bindChatHubInsTabs,
  bindChatHubUserCard,
  buildChatHubInsChrome,
  chatHubInsToolbarIcon,
  loadChatHubInsContext,
} from '../core/chat/chat-hub-ins-chrome.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatListTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function accountProfile(chat, characterMap = new Map()) {
  const characterId = (chat.participants || []).find((id) => id && id !== 'user') || '';
  const accountId = chat.metadata?.accountIdentityMap?.[principalKey('character', characterId)] || '';
  if (accountId) return chat.metadata?.accountSnapshots?.[accountId] || null;
  const character = characterMap.get(characterId);
  if (character) return {
    displayName: character.name || character.realName || '已拉黑角色',
    avatar: character.avatar || '',
    handle: '',
  };
  const application = chat.metadata?.contactApplication;
  return application ? {
    displayName: application.name || '申请中的联系人',
    avatar: application.avatar || '',
    handle: '',
  } : null;
}

export default async function renderChatIntercepts(container, params = {}) {
  container.__chatInterceptUnreadCleanup?.();
  const user = await ensureDefaultUser();
  const [{ hubInsChrome, windowTheme, seaTheme, chatPlatform = 'current' }, characters, settings, userAccounts, characterAliases] = await Promise.all([
    loadChatHubInsContext(),
    listCharacters({ excludeAnonNpc: true, userId: user.id, identityScoped: true }).catch(() => []),
    loadUserInterceptSettings(user.id),
    listAliasAccounts('user', user.id).catch(() => []),
    listCharacterAliasAccountsForUser(user.id).catch(() => []),
  ]);
  const platformSubpage = chatPlatform === 'qq' || chatPlatform === 'wechat';
  const hasRequestedAccount = Object.prototype.hasOwnProperty.call(params, 'accountId');
  const requestedAccountId = String(params.accountId || '').trim();
  const requestedAccountValid = !requestedAccountId
    || userAccounts.some((account) => account.id === requestedAccountId);
  const storedAccountId = userAccounts.some((account) => account.id === settings.activeAccountId)
    ? settings.activeAccountId
    : '';
  const activeAccountId = hasRequestedAccount && requestedAccountValid
    ? requestedAccountId
    : storedAccountId;
  if (settings.activeAccountId !== activeAccountId) {
    void saveUserInterceptSettings(user.id, { activeAccountId }).catch(() => {});
  }
  const chats = await listUserInterceptThreads(user.id, { userAccountId: activeAccountId });
  if (!container.isConnected) return;
  const characterMap = new Map(characters.map((row) => [row.id, row]));
  const partnerCharacters = characters.filter((row) => row?.id);
  const visibleCharacterAliases = characterAliases.filter((row) => characterMap.has(row.ownerId));
  const preferredSet = new Set(settings.preferredCharacterIds || []);
  const rowClass = hubInsChrome ? 'chat-list-row chat-list-row--ins' : 'chat-list-row';
  const scrollClass = hubInsChrome ? 'chat-hub-scroll chat-hub-scroll--ins' : 'chat-hub-scroll scrapbook-scroll';

  applyChatHubInsPageClasses(container, {
    hubInsChrome,
    windowTheme,
    seaTheme,
    extraClasses: ['chat-intercepts-page'],
  });

  const currentIdentity = activeAccountId
    ? userAccounts.find((account) => account.id === activeAccountId)
    : {
      id: '',
      displayName: user.name || user.nickname || user.displayName || '我',
      handle: '',
      avatar: user.avatar || '',
    };
  const identityName = String(currentIdentity?.displayName || '我');
  const identityAvatar = currentIdentity?.avatar
    ? `<img src="${esc(currentIdentity.avatar)}" alt="" loading="lazy" decoding="async" />`
    : `<span>${esc(identityName.slice(0, 1))}</span>`;
  const identitySwitchHtml = `
    <button type="button" class="chat-intercept-identity-switch" data-intercept-identity-open>
      <span class="chat-intercept-identity-avatar">${identityAvatar}</span>
      <span class="chat-intercept-identity-copy"><strong>${esc(identityName)}</strong>${currentIdentity?.handle ? `<small>@${esc(currentIdentity.handle)}</small>` : '<small>本体</small>'}</span>
      <span class="chat-intercept-identity-chevron" aria-hidden="true">${icon('chevronDown')}</span>
    </button>`;

  const rowsHtml = chats.length ? chats.map((chat) => {
    const profile = accountProfile(chat, characterMap);
    const blockedMain = !isStrangerInterceptChat(chat);
    const contactApplication = chat.metadata?.contactApplication || null;
    const title = String(profile?.displayName || '陌生账号');
    const handle = String(profile?.handle || '').trim();
    const avatar = profile?.avatar
      ? `<img src="${esc(profile.avatar)}" alt="" class="chat-list-avatar-img" loading="lazy" decoding="async" />`
      : `<span class="chat-list-avatar-letter">${esc(title.slice(0, 1))}</span>`;
    return `
      <button type="button" class="${rowClass}" data-chat-id="${esc(chat.id)}">
        <span class="chat-list-avatar">${avatar}</span>
        <span class="chat-list-body">
          <span class="chat-list-title">${esc(title)}${blockedMain ? '<small class="chat-intercept-kind">已拉黑</small>' : contactApplication ? '<small class="chat-intercept-kind">好友申请</small>' : ''}</span>
          <span class="chat-list-preview">${esc(String(chat.lastMessage || handle || (contactApplication ? '好友申请已发送 · 等待回应' : '陌生消息')).slice(0, 48))}</span>
        </span>
        <span class="chat-list-meta">
          ${chat.unread ? `<span class="chat-list-unread">${chat.unread > 99 ? '99+' : chat.unread}</span>` : ''}
          <span class="chat-list-time">${esc(formatListTime(chat.lastActivity))}</span>
        </span>
      </button>`;
  }).join('') : `
    <div class="chat-empty${hubInsChrome ? ' chat-empty--ins' : ' scrapbook-empty'}">
      <div class="chat-empty-text">还没有角色小号或陌生消息</div>
      <div class="chat-empty-hint">角色的小号来信会集中出现在这里</div>
    </div>`;

  const preferredCharsHtml = partnerCharacters.length
    ? `<div class="chat-intercept-preferred-list">${partnerCharacters.map((row) => {
      const id = String(row.id);
      const name = String(row.name || row.realName || id);
      return `<label class="chat-intercept-preferred-item"><input type="checkbox" name="preferredCharacterIds" value="${esc(id)}" ${preferredSet.has(id) ? 'checked' : ''}><span>${esc(name)}</span></label>`;
    }).join('')}</div>`
    : '<div class="chat-intercept-preferred-empty">当前身份范围内暂无角色</div>';

  const settingsSheetHtml = `
    <div class="modal-overlay chat-intercept-settings-overlay" data-intercept-settings-close hidden>
      <section class="chat-intercept-settings-sheet" role="dialog" aria-modal="true" aria-label="生成设置">
        <header><h2>生成设置</h2><button type="button" data-intercept-settings-close aria-label="关闭">${icon('close')}</button></header>
        <form data-intercept-settings-form>
          <label><span>自动生成</span><input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''}></label>
          <label><span>来源构成</span><select name="sourceMode" class="form-input">
            ${[
              ['character', '仅角色马甲'],
              ['character_stranger', '角色 + 普通陌生人'],
              ['character_harass', '角色 + 骚扰'],
              ['mixed', '角色 + 陌生人 + 骚扰'],
              ['stranger', '仅普通陌生人'],
              ['harass', '仅骚扰'],
            ].map(([value, label]) => `<option value="${value}" ${settings.sourceMode === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select></label>
          <label><span>马甲新旧</span><select name="aliasStrategy" class="form-input">
            ${[
              ['balanced', '新旧均衡'],
              ['reuse', '只续旧窗'],
              ['new', '只建新窗'],
            ].map(([value, label]) => `<option value="${value}" ${settings.aliasStrategy === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select></label>
          <label><span>生成间隔</span><select name="intervalHours" class="form-input">
            ${[[12, '12 小时'], [24, '1 天'], [48, '2 天'], [72, '3 天'], [168, '7 天'], [336, '14 天']].map(([value, label]) => `<option value="${value}" ${Number(settings.intervalHours) === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select></label>
          <label><span>本轮来源数</span><select name="batchSize" class="form-input">
            ${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${Number(settings.batchSize) === value ? 'selected' : ''}>${value}</option>`).join('')}
          </select></label>
          <label class="is-wide"><span>小号偏好</span><input name="preference" class="form-input" maxlength="600" value="${esc(settings.preference)}" placeholder="暗恋树洞、感情试探、黑粉…"></label>
          <div class="is-wide chat-intercept-preferred-field">
            <span>优先角色</span>
            ${preferredCharsHtml}
          </div>
          <button type="submit" class="chat-intercept-settings-save">保存</button>
        </form>
      </section>
    </div>`;

  const identityOptions = [{
    id: '',
    displayName: user.name || user.nickname || user.displayName || '我',
    handle: '',
    avatar: user.avatar || '',
  }, ...userAccounts];
  const identitySheetHtml = `
    <div class="modal-overlay chat-intercept-identity-overlay" data-intercept-identity-close hidden>
      <section class="chat-intercept-identity-sheet" role="dialog" aria-modal="true" aria-label="切换身份">
        <header><h2>切换身份</h2><button type="button" data-intercept-identity-close aria-label="关闭">${icon('close')}</button></header>
        <div class="chat-intercept-identity-list">
          ${identityOptions.map((account) => {
            const name = String(account.displayName || '我');
            const avatar = account.avatar
              ? `<img src="${esc(account.avatar)}" alt="" loading="lazy" decoding="async" />`
              : `<span>${esc(name.slice(0, 1))}</span>`;
            return `<button type="button" class="chat-intercept-identity-option${account.id === activeAccountId ? ' is-active' : ''}" data-intercept-account-id="${esc(account.id)}">
              <span class="chat-intercept-identity-avatar">${avatar}</span>
              <span><strong>${esc(name)}</strong><small>${account.id ? (account.handle ? `@${esc(account.handle)}` : '马甲') : '本体'}</small></span>
              ${account.id === activeAccountId ? icon('check') : ''}
            </button>`;
          }).join('')}
        </div>
        <button type="button" class="chat-intercept-manage-link" data-intercept-aliases>管理马甲</button>
      </section>
    </div>`;

  const characterPickHtml = partnerCharacters.length
    ? partnerCharacters.map((row) => {
      const name = String(row.name || row.realName || row.id);
      return `<button type="button" class="chat-intercept-source-option" data-intercept-pick-character="${esc(row.id)}"><strong>${esc(name)}</strong></button>`;
    }).join('')
    : '<div class="chat-intercept-source-empty">当前身份范围内暂无角色</div>';
  const aliasPickHtml = visibleCharacterAliases.length
    ? visibleCharacterAliases.map((row) => {
      const ownerName = characterMap.get(row.ownerId)?.name || characterMap.get(row.ownerId)?.realName || '角色';
      const name = String(row.displayName || '马甲');
      const meta = [row.windowLabel, row.handle ? `@${row.handle}` : '', ownerName].filter(Boolean).join(' · ');
      return `<button type="button" class="chat-intercept-source-option" data-intercept-pick-alias="${esc(row.id)}"><strong>${esc(name)}</strong><small>${esc(meta)}</small></button>`;
    }).join('')
    : '<div class="chat-intercept-source-empty">还没有角色马甲</div>';

  const generateSheetHtml = `
    <div class="modal-overlay chat-intercept-generate-overlay" data-intercept-generate-close hidden>
      <section class="chat-intercept-generate-sheet" role="dialog" aria-modal="true" aria-label="补一轮来源">
        <header><h2>补一轮</h2><button type="button" data-intercept-generate-close aria-label="关闭">${icon('close')}</button></header>
        <div class="chat-intercept-source-modes" role="tablist" aria-label="来源">
          <button type="button" class="is-active" data-intercept-source-mode="auto">自动挑选</button>
          <button type="button" data-intercept-source-mode="character">指定角色</button>
          <button type="button" data-intercept-source-mode="alias">指定马甲</button>
        </div>
        <div class="chat-intercept-source-panel" data-intercept-source-panel="auto">
          <button type="button" class="chat-intercept-source-primary" data-intercept-pick-auto>开始生成</button>
        </div>
        <div class="chat-intercept-source-panel" data-intercept-source-panel="character" hidden>
          <div class="chat-intercept-source-list">${characterPickHtml}</div>
        </div>
        <div class="chat-intercept-source-panel" data-intercept-source-panel="alias" hidden>
          <div class="chat-intercept-source-list">${aliasPickHtml}</div>
        </div>
      </section>
    </div>`;

  const insToolbar = [
    chatHubInsToolbarIcon('chat-intercept-generate-icon', '补一轮陌生消息', 'sparkle', { 'data-intercept-generate': '' }),
    chatHubInsToolbarIcon('chat-intercept-new-icon', '新建聊天', 'plus', { 'data-intercept-new': '' }),
    chatHubInsToolbarIcon('chat-intercept-settings-icon', '生成设置', 'settings', { 'data-intercept-settings-open': '' }),
  ].join('');

  if (hubInsChrome) {
    container.innerHTML = `${buildChatHubInsChrome({
      activeTab: 'intercepts',
      user,
      chatPlatform,
      toolbarActionsHtml: insToolbar,
      showUserCard: !platformSubpage,
      showTabs: !platformSubpage,
      pageTitle: platformSubpage ? '小号与陌生消息' : '',
    })}<main class="${scrollClass}">${identitySwitchHtml}${rowsHtml}</main>${settingsSheetHtml}${identitySheetHtml}${generateSheetHtml}`;
  } else {
    container.innerHTML = `
      <header class="navbar chat-hub-navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">小号与陌生消息</h1>
        <div class="chat-intercept-navbar-actions">
          <button type="button" class="navbar-btn" data-intercept-generate aria-label="补一轮陌生消息">${icon('sparkle')}</button>
          <button type="button" class="navbar-btn" data-intercept-new aria-label="新建聊天">${icon('plus')}</button>
          <button type="button" class="navbar-btn" data-intercept-settings-open aria-label="生成设置">${icon('settings')}</button>
        </div>
      </header>
      <nav class="chat-hub-tabs" aria-label="Chat 分区">
        <button type="button" class="chat-hub-tab" data-tab="messages">消息</button>
        <button type="button" class="chat-hub-tab" data-tab="moments">朋友圈</button>
        <button type="button" class="chat-hub-tab is-active" data-tab="intercepts">陌生消息</button>
        <button type="button" class="chat-hub-tab" data-tab="backstage">秘密基地</button>
      </nav>
      <main class="${scrollClass}">${identitySwitchHtml}${rowsHtml}</main>
      ${settingsSheetHtml}${identitySheetHtml}${generateSheetHtml}`;
  }

  const generateButton = container.querySelector('[data-intercept-generate]');
  const generateOverlay = container.querySelector('.chat-intercept-generate-overlay');

  async function runGenerate(options = {}) {
    if (generateButton) {
      generateButton.disabled = true;
      generateButton.classList.add('is-generating');
      generateButton.setAttribute('aria-label', '正在生成陌生消息');
    }
    if (generateOverlay) generateOverlay.hidden = true;
    showToast('正在生成…', 1200);
    try {
      const result = await maybeGenerateUserIntercepts({ force: true, ...options });
      if (!result?.ok) throw new Error(result?.reason === 'in-flight' ? '正在生成中，请稍候' : '这一轮没有生成出有效消息');
      showToast(`已补 ${result.results.length} 个来源`);
      if (container.isConnected) await renderChatIntercepts(container);
    } catch (error) {
      showToast(error?.message || '生成失败');
      if (generateButton?.isConnected) {
        generateButton.disabled = false;
        generateButton.classList.remove('is-generating');
        generateButton.setAttribute('aria-label', '补一轮陌生消息');
      }
    }
  }

  container.querySelector('[data-back]')?.addEventListener('click', () => {
    if (platformSubpage) navigate('chat', {}, true);
    else back();
  });
  container.querySelector('[data-intercept-new]')?.addEventListener('click', () => navigate('chat/pick', {
    mode: 'alias-private',
    userAccountId: activeAccountId,
  }));
  container.querySelectorAll('[data-intercept-aliases]').forEach((button) => button.addEventListener('click', () => navigate('chat/aliases', { ownerType: 'user' })));
  const identityOverlay = container.querySelector('.chat-intercept-identity-overlay');
  container.querySelector('[data-intercept-identity-open]')?.addEventListener('click', () => {
    if (identityOverlay) identityOverlay.hidden = false;
  });
  container.querySelectorAll('[data-intercept-identity-close]').forEach((element) => {
    element.addEventListener('click', (event) => {
      if (event.currentTarget === identityOverlay && event.target !== identityOverlay) return;
      if (identityOverlay) identityOverlay.hidden = true;
    });
  });
  container.querySelectorAll('[data-intercept-account-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      await saveUserInterceptSettings(user.id, { activeAccountId: button.dataset.interceptAccountId || '' });
      if (container.isConnected) await renderChatIntercepts(container);
    });
  });
  const settingsOverlay = container.querySelector('.chat-intercept-settings-overlay');
  container.querySelector('[data-intercept-settings-open]')?.addEventListener('click', () => {
    if (settingsOverlay) settingsOverlay.hidden = false;
  });
  container.querySelectorAll('[data-intercept-settings-close]').forEach((element) => {
    element.addEventListener('click', (event) => {
      if (event.currentTarget === settingsOverlay && event.target !== settingsOverlay) return;
      if (settingsOverlay) settingsOverlay.hidden = true;
    });
  });
  generateButton?.addEventListener('click', () => {
    if (generateOverlay) generateOverlay.hidden = false;
  });
  container.querySelectorAll('[data-intercept-generate-close]').forEach((element) => {
    element.addEventListener('click', (event) => {
      if (event.currentTarget === generateOverlay && event.target !== generateOverlay) return;
      if (generateOverlay) generateOverlay.hidden = true;
    });
  });
  container.querySelectorAll('[data-intercept-source-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.interceptSourceMode || 'auto';
      container.querySelectorAll('[data-intercept-source-mode]').forEach((row) => {
        row.classList.toggle('is-active', row === button);
      });
      container.querySelectorAll('[data-intercept-source-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.interceptSourcePanel !== mode;
      });
    });
  });
  container.querySelector('[data-intercept-pick-auto]')?.addEventListener('click', () => runGenerate());
  container.querySelectorAll('[data-intercept-pick-character]').forEach((button) => {
    button.addEventListener('click', () => runGenerate({ forceCharacterIds: [button.dataset.interceptPickCharacter] }));
  });
  container.querySelectorAll('[data-intercept-pick-alias]').forEach((button) => {
    button.addEventListener('click', () => runGenerate({ forceAliasId: button.dataset.interceptPickAlias }));
  });
  container.querySelector('[data-intercept-settings-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await saveUserInterceptSettings(user.id, {
      enabled: data.get('enabled') === 'on',
      sourceMode: data.get('sourceMode'),
      aliasStrategy: data.get('aliasStrategy'),
      intervalHours: data.get('intervalHours'),
      batchSize: data.get('batchSize'),
      preference: data.get('preference'),
      preferredCharacterIds: data.getAll('preferredCharacterIds'),
    });
    if (settingsOverlay) settingsOverlay.hidden = true;
    showToast('已保存');
  });
  if (hubInsChrome) {
    bindChatHubInsTabs(container, 'intercepts');
    bindChatHubUserCard(container, user, { onSlotChanged: async () => container.isConnected && renderChatIntercepts(container) });
  } else {
    container.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab;
        if (tab === 'intercepts') return;
        navigate(tab === 'messages' ? 'chat' : `chat/${tab}`, {}, true);
      });
    });
  }
  container.querySelectorAll('[data-chat-id]').forEach((button) => {
    const chatId = button.dataset.chatId;
    button.addEventListener('click', () => {
      button.querySelector('.chat-list-unread')?.remove();
      void clearChatUnread(chatId).catch(() => {});
      navigate('chat/thread', { chatId });
    });
    bindLongPress(button, () => openChatRowSheet({
      chatTitle: accountProfile(chats.find((chat) => chat.id === chatId), characterMap)?.displayName || '陌生账号',
      actions: [{
        label: '删除会话',
        variant: 'danger',
        onClick: async () => {
          if (!window.confirm('删除这条陌生会话？聊天记录与相关记忆会一并删除。')) return;
          const targetChat = chats.find((chat) => chat.id === chatId) || null;
          const applicationId = String(targetChat?.metadata?.contactApplication?.id || '').trim();
          // 好友申请另存在 settings；若只删聊天，QQ 通讯录下次会按残留申请修复并重建会话。
          await deleteQqContactApplicationsForThread(user.id, { chatId, applicationId });
          await deleteChatWithData(chatId, user.id);
          const remaining = await listUserInterceptThreads(user.id, { userAccountId: activeAccountId });
          if (remaining.some((chat) => chat.id === chatId)) {
            throw new Error('陌生会话删除后仍可回读，请重试');
          }
          showToast('会话已删除');
          if (container.isConnected) await renderChatIntercepts(container);
        },
      }],
    }), 550);
  });

  let unreadRefreshScheduled = false;
  let unreadRefreshDirty = false;
  const refreshUnreadRows = async () => {
    if (!container.isConnected) return;
    const freshChats = await listUserInterceptThreads(user.id, { userAccountId: activeAccountId });
    if (!container.isConnected) return;
    const currentIds = chats.map((chat) => chat.id).sort().join('\n');
    const freshIds = freshChats.map((chat) => chat.id).sort().join('\n');
    if (currentIds !== freshIds) {
      await renderChatIntercepts(container, params);
      return;
    }
    const freshById = new Map(freshChats.map((chat) => [chat.id, chat]));
    container.querySelectorAll('[data-chat-id]').forEach((button) => {
      const fresh = freshById.get(button.dataset.chatId);
      if (!fresh) return;
      const meta = button.querySelector('.chat-list-meta');
      const badge = meta?.querySelector('.chat-list-unread');
      const unread = Math.max(0, Math.floor(Number(fresh.unread) || 0));
      if (unread) {
        const text = unread > 99 ? '99+' : String(unread);
        if (badge) badge.textContent = text;
        else meta?.insertAdjacentHTML('afterbegin', `<span class="chat-list-unread">${text}</span>`);
      } else {
        badge?.remove();
      }
      const preview = button.querySelector('.chat-list-preview');
      if (preview) preview.textContent = String(fresh.lastMessage || '陌生消息').slice(0, 48);
      const time = button.querySelector('.chat-list-time');
      if (time) time.textContent = formatListTime(fresh.lastActivity);
    });
  };
  const scheduleUnreadRefresh = () => {
    unreadRefreshDirty = true;
    if (unreadRefreshScheduled) return;
    unreadRefreshScheduled = true;
    Promise.resolve().then(async () => {
      try {
        while (unreadRefreshDirty && container.isConnected) {
          unreadRefreshDirty = false;
          await refreshUnreadRows();
        }
      } finally {
        unreadRefreshScheduled = false;
      }
    }).catch(() => { unreadRefreshScheduled = false; });
  };
  const offChats = onStoreWrite('chats', scheduleUnreadRefresh);
  const onRouteActivated = (event) => {
    const detail = event?.detail || {};
    if (detail.container === container && detail.path === 'chat/intercepts') scheduleUnreadRefresh();
  };
  const onRouteDisposed = (event) => {
    if (event?.detail?.container === container) container.__chatInterceptUnreadCleanup?.();
  };
  const cleanupUnreadRefresh = () => {
    offChats();
    window.removeEventListener('marshmallow-route-activated', onRouteActivated);
    window.removeEventListener('marshmallow-route-disposed', onRouteDisposed);
    if (container.__chatInterceptUnreadCleanup === cleanupUnreadRefresh) {
      delete container.__chatInterceptUnreadCleanup;
    }
  };
  container.__chatInterceptUnreadCleanup = cleanupUnreadRefresh;
  window.addEventListener('marshmallow-route-activated', onRouteActivated);
  window.addEventListener('marshmallow-route-disposed', onRouteDisposed);
}
