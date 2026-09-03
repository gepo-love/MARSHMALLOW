import { back, navigate } from '../core/router.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters } from '../core/character-store.js';
import { listInboxChatsForUser } from '../core/chat-store.js';
import { loadContactGroupsConfig, resolveCharacterGroupId } from '../core/contact-groups.js';
import { hasActiveIdentityBinding, identityBindingSelectsCharacter } from '../models/user.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import {
  applyChatHubInsPageClasses,
  buildChatHubInsChrome,
  identityContactRouteParams,
  loadChatHubInsContext,
} from '../core/chat/chat-hub-ins-chrome.js';
import { wechatGlyph } from '../core/chat/wechat-shell.js';

const FEATURE_META = Object.freeze({
  new: { title: '新的朋友', kind: 'contacts' },
  'only-chat': { title: '仅聊天的朋友', kind: 'only-chat' },
  groups: { title: '群聊', kind: 'groups' },
  tags: { title: '标签', kind: 'tags' },
  official: { title: '公众号', kind: 'empty', empty: '还没有关注的公众号' },
  service: { title: '服务号', kind: 'empty', empty: '还没有服务号消息' },
  channels: { title: '视频号', kind: 'empty', empty: '还没有视频号内容' },
  scan: { title: '扫一扫', kind: 'scan' },
  look: { title: '看一看', kind: 'empty', empty: '还没有推荐内容' },
  search: { title: '搜一搜', kind: 'search' },
  live: { title: '直播和附近', kind: 'empty', empty: '还没有直播内容' },
  mini: { title: '小程序', kind: 'mini' },
  services: { title: '服务', kind: 'empty', empty: '还没有可用服务' },
  cards: { title: '卡包', kind: 'empty', empty: '还没有卡券' },
});

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clean(value = '') {
  return String(value || '').trim();
}

function scopedCharacters(rows, user) {
  const binding = user?.identityBinding || {};
  if (!hasActiveIdentityBinding(binding)) return rows;
  return rows.filter((row) => identityBindingSelectsCharacter(binding, {
    ...row,
    groupId: resolveCharacterGroupId(row),
  }));
}

function characterName(character) {
  return clean(character?.customNickname || character?.name || character?.realName) || '未命名联系人';
}

function chatTitle(chat) {
  return clean(chat?.groupSettings?.name || chat?.customName || chat?.title || chat?.name) || '群聊';
}

function chatPreview(chat) {
  return clean(chat?.lastMessagePreview || chat?.preview || chat?.lastMessage?.content || chat?.lastMessage?.text) || '暂无新消息';
}

function contactRow(character, { searchable = false } = {}) {
  const name = characterName(character);
  return `
    <button type="button" class="wechat-feature-row" data-wechat-contact="${esc(character.id)}"${searchable ? ` data-search-text="${esc(name.toLowerCase())}"` : ''}>
      <span class="wechat-feature-avatar">${characterAvatarHtml(character, { className: 'wechat-feature-avatar-img' })}</span>
      <span class="wechat-feature-copy"><strong>${esc(name)}</strong></span>
      <span class="wechat-row-chevron">${wechatGlyph('chevron')}</span>
    </button>
  `;
}

function chatRow(chat, { searchable = false } = {}) {
  const title = chatTitle(chat);
  const preview = chatPreview(chat);
  return `
    <button type="button" class="wechat-feature-row" data-wechat-chat="${esc(chat.id)}"${searchable ? ` data-search-text="${esc(`${title} ${preview}`.toLowerCase())}"` : ''}>
      <span class="wechat-feature-avatar is-group">${wechatGlyph('group')}</span>
      <span class="wechat-feature-copy"><strong>${esc(title)}</strong><small>${esc(preview)}</small></span>
      <span class="wechat-row-chevron">${wechatGlyph('chevron')}</span>
    </button>
  `;
}

function emptyState(text) {
  return `<div class="wechat-feature-empty"><span>${wechatGlyph('chats')}</span><strong>${esc(text)}</strong></div>`;
}

function renderContacts(characters) {
  return `
    <section class="wechat-feature-action-group">
      <button type="button" class="wechat-feature-row" data-wechat-route="contacts/import">
        <span class="wechat-feature-square is-orange">${wechatGlyph('new-friend')}</span>
        <span class="wechat-feature-copy"><strong>添加朋友</strong></span>
        <span class="wechat-row-chevron">${wechatGlyph('chevron')}</span>
      </button>
    </section>
    <section class="wechat-feature-section">
      ${characters.length ? characters.map((character) => contactRow(character)).join('') : emptyState('还没有联系人')}
    </section>
  `;
}

function renderGroups(chats) {
  const groups = chats.filter((chat) => chat?.type === 'group');
  return `<section class="wechat-feature-section">${groups.length ? groups.map((chat) => chatRow(chat)).join('') : emptyState('还没有群聊')}</section>`;
}

function renderTags(characters, groupConfig) {
  const groups = Array.isArray(groupConfig?.groups) ? groupConfig.groups : [];
  return groups.length ? groups.map((group) => {
    const members = characters.filter((character) => resolveCharacterGroupId(character) === group.id);
    return `
      <section class="wechat-feature-section wechat-feature-tag-group">
        <h2>${esc(group.name)} <small>${members.length}</small></h2>
        ${members.length ? members.map((character) => contactRow(character)).join('') : '<p class="wechat-feature-tag-empty">暂无联系人</p>'}
      </section>
    `;
  }).join('') : emptyState('还没有标签');
}

function renderSearch(characters, chats) {
  const searchableChats = chats.filter((chat) => chat?.type === 'group' || chat?.type === 'private');
  return `
    <label class="wechat-feature-search">${wechatGlyph('search')}<input type="search" data-wechat-feature-search placeholder="搜索联系人和聊天" aria-label="搜索联系人和聊天" /></label>
    <section class="wechat-feature-section wechat-feature-results" data-wechat-feature-results>
      ${characters.map((character) => contactRow(character, { searchable: true })).join('')}
      ${searchableChats.map((chat) => chatRow(chat, { searchable: true })).join('')}
      <div class="wechat-feature-search-hint" data-wechat-search-hint>输入关键词开始搜索</div>
    </section>
  `;
}

function renderScan() {
  return `
    <div class="wechat-scan-stage" aria-label="扫码取景框">
      <div class="wechat-scan-frame"><i></i><i></i><i></i><i></i><span></span></div>
      <strong>将二维码放入框内</strong>
    </div>
  `;
}

function renderMiniPrograms() {
  return `
    <section class="wechat-game-placeholder">
      <div class="wechat-game-mark">${wechatGlyph('mini')}</div>
      <h2>小游戏中心</h2>
      <p>未来会在这里进入棉花糖机小游戏。</p>
      <div class="wechat-game-slots" aria-label="未来小游戏">
        <span><i>01</i><strong>互动小游戏</strong></span>
        <span><i>02</i><strong>双人挑战</strong></span>
        <span><i>03</i><strong>剧情小游戏</strong></span>
      </div>
      <small>敬请期待</small>
    </section>
  `;
}

function renderBody(meta, characters, chats, groupConfig) {
  if (meta.kind === 'contacts') return renderContacts(characters);
  if (meta.kind === 'only-chat') return emptyState('还没有仅聊天的朋友');
  if (meta.kind === 'groups') return renderGroups(chats);
  if (meta.kind === 'tags') return renderTags(characters, groupConfig);
  if (meta.kind === 'search') return renderSearch(characters, chats);
  if (meta.kind === 'scan') return renderScan();
  if (meta.kind === 'mini') return renderMiniPrograms();
  return emptyState(meta.empty || '暂无内容');
}

export default async function render(container, params = {}) {
  const feature = clean(params.feature);
  const meta = FEATURE_META[feature] || { title: '微信', kind: 'empty', empty: '暂无内容' };
  const [user, hubContext] = await Promise.all([ensureDefaultUser(), loadChatHubInsContext()]);
  if (hubContext.chatPlatform !== 'wechat') {
    navigate('chat', {}, true);
    return;
  }
  const [allCharacters, chats, groupConfig] = await Promise.all([
    listCharacters({ userId: user.id, excludeAnonNpc: true }).catch(() => []),
    listInboxChatsForUser(user.id).catch(() => []),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
  ]);
  const characters = scopedCharacters(allCharacters, user)
    .sort((a, b) => characterName(a).localeCompare(characterName(b), 'zh-CN'));

  applyChatHubInsPageClasses(container, {
    ...hubContext,
    chatPlatform: 'wechat',
    extraClasses: ['wechat-shell-page', 'wechat-feature-page', `wechat-feature-page--${feature || 'empty'}`],
  });
  container.innerHTML = `
    ${buildChatHubInsChrome({
      activeTab: '',
      chatPlatform: 'wechat',
      showUserCard: false,
      showTabs: false,
      pageTitle: meta.title,
    })}
    <main class="wechat-shell-scroll wechat-feature-scroll">
      ${renderBody(meta, characters, chats, groupConfig)}
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-wechat-route]').forEach((button) => button.addEventListener('click', () => {
    navigate(button.getAttribute('data-wechat-route'));
  }));
  container.querySelectorAll('[data-wechat-contact]').forEach((button) => button.addEventListener('click', () => {
    navigate('contacts/card', {
      id: button.getAttribute('data-wechat-contact'),
      ...identityContactRouteParams(user),
    });
  }));
  container.querySelectorAll('[data-wechat-chat]').forEach((button) => button.addEventListener('click', () => {
    navigate('chat/thread', { chatId: button.getAttribute('data-wechat-chat'), entry: 'list' });
  }));

  const searchInput = container.querySelector('[data-wechat-feature-search]');
  const searchRows = [...container.querySelectorAll('[data-search-text]')];
  const searchHint = container.querySelector('[data-wechat-search-hint]');
  searchInput?.addEventListener('input', () => {
    const query = clean(searchInput.value).toLowerCase();
    let visible = 0;
    searchRows.forEach((row) => {
      const match = !!query && clean(row.getAttribute('data-search-text')).includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    });
    if (searchHint) searchHint.textContent = query ? (visible ? '' : '没有找到相关结果') : '输入关键词开始搜索';
  });
  if (searchRows.length) searchRows.forEach((row) => { row.hidden = true; });
}
