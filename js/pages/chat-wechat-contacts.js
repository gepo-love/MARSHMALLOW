import { navigate } from '../core/router.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters } from '../core/character-store.js';
import { listInboxChatsForUser } from '../core/chat-store.js';
import { resolveCharacterGroupId } from '../core/contact-groups.js';
import { hasActiveIdentityBinding, identityBindingSelectsCharacter } from '../models/user.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import {
  applyChatHubInsPageClasses,
  bindChatHubInsTabs,
  buildChatHubInsChrome,
  identityContactRouteParams,
  loadChatHubInsContext,
} from '../core/chat/chat-hub-ins-chrome.js';
import { wechatGlyph } from '../core/chat/wechat-shell.js';

function esc(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function displayName(character) {
  return clean(character?.customNickname || character?.name || character?.realName) || '未命名联系人';
}

const PINYIN_BOUNDARIES = [
  ['A', '阿'], ['B', '八'], ['C', '嚓'], ['D', '咑'], ['E', '妸'], ['F', '发'], ['G', '旮'],
  ['H', '铪'], ['J', '丌'], ['K', '咔'], ['L', '垃'], ['M', '妈'], ['N', '拿'], ['O', '噢'],
  ['P', '啪'], ['Q', '期'], ['R', '然'], ['S', '撒'], ['T', '塌'], ['W', '挖'], ['X', '昔'],
  ['Y', '压'], ['Z', '匝'],
];
const WECHAT_INDEX_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
const pinyinCollator = typeof Intl?.Collator === 'function'
  ? new Intl.Collator('zh-CN-u-co-pinyin')
  : null;

function initialOf(name) {
  const first = clean(name).charAt(0).toUpperCase();
  if (/^[A-Z]$/.test(first)) return first;
  if (!pinyinCollator || !/[\u3400-\u9fff]/.test(first)) return '#';
  for (let index = PINYIN_BOUNDARIES.length - 1; index >= 0; index -= 1) {
    const [letter, boundary] = PINYIN_BOUNDARIES[index];
    if (pinyinCollator.compare(first, boundary) >= 0) return letter;
  }
  return '#';
}

function shortcut(iconName, tone, label, action) {
  return `<button type="button" class="wechat-directory-row wechat-directory-shortcut" data-wechat-directory-action="${esc(action)}"><span class="wechat-directory-icon is-${tone}">${wechatGlyph(iconName)}</span><strong>${esc(label)}</strong><span class="wechat-row-chevron">${wechatGlyph('chevron')}</span></button>`;
}

export default async function render(container) {
  const [user, hubContext] = await Promise.all([ensureDefaultUser(), loadChatHubInsContext()]);
  const identityRouteParams = identityContactRouteParams(user);
  if (hubContext.chatPlatform !== 'wechat') {
    navigate(hubContext.chatPlatform === 'qq' ? 'chat/contacts' : 'contacts', identityRouteParams, true);
    return;
  }

  const [allCharacters, chats] = await Promise.all([
    listCharacters({ userId: user.id, excludeAnonNpc: true }),
    listInboxChatsForUser(user.id).catch(() => []),
  ]);
  const characters = scopedCharacters(allCharacters, user).sort((a, b) => displayName(a).localeCompare(displayName(b), 'zh-CN'));
  const grouped = new Map();
  for (const character of characters) {
    const initial = initialOf(displayName(character));
    if (!grouped.has(initial)) grouped.set(initial, []);
    grouped.get(initial).push(character);
  }
  const initials = [...grouped.keys()].sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
  const groupChats = chats.filter((chat) => chat?.type === 'group').length;

  applyChatHubInsPageClasses(container, {
    ...hubContext,
    chatPlatform: 'wechat',
    extraClasses: ['wechat-shell-page', 'wechat-directory-page'],
  });
  container.innerHTML = `
    ${buildChatHubInsChrome({
      activeTab: 'contacts',
      chatPlatform: 'wechat',
      showUserCard: false,
      pageTitle: '通讯录',
      toolbarActionsHtml: `<button type="button" class="chat-hub-icon-btn" data-wechat-directory-search aria-label="搜索联系人">${wechatGlyph('search')}</button><button type="button" class="chat-hub-icon-btn" data-wechat-directory-add aria-label="添加朋友">${wechatGlyph('plus')}</button>`,
    })}
    <main class="wechat-shell-scroll wechat-directory-scroll">
      <label class="wechat-directory-search" hidden>${wechatGlyph('search')}<input type="search" placeholder="搜索" aria-label="搜索联系人" /></label>
      <section class="wechat-directory-shortcuts">
        ${shortcut('new-friend', 'orange', '新的朋友', 'new')}
        ${shortcut('only-chat', 'orange', '仅聊天的朋友', 'only-chat')}
        ${shortcut('group', 'green', `群聊${groupChats ? `（${groupChats}）` : ''}`, 'groups')}
        ${shortcut('tag', 'blue', '标签', 'tags')}
        ${shortcut('official', 'blue', '公众号', 'official')}
        ${shortcut('service', 'cyan', '服务号', 'service')}
      </section>
      <div class="wechat-directory-contacts">
        ${initials.length ? initials.map((initial) => `
          <section class="wechat-directory-group" data-wechat-letter="${esc(initial)}">
            <h2>${esc(initial)}</h2>
            ${grouped.get(initial).map((character) => `
              <button type="button" class="wechat-directory-row" data-wechat-contact="${esc(character.id)}" data-search-text="${esc(displayName(character).toLowerCase())}">
                <span class="wechat-directory-avatar">${characterAvatarHtml(character, { className: 'wechat-directory-avatar-img' })}</span>
                <strong>${esc(displayName(character))}</strong>
              </button>
            `).join('')}
          </section>
        `).join('') : '<div class="wechat-directory-empty">还没有联系人</div>'}
      </div>
      ${initials.length ? `<nav class="wechat-directory-index" aria-label="通讯录索引"><button type="button" data-wechat-index="top">↑</button><button type="button" data-wechat-index="top">☆</button>${WECHAT_INDEX_LETTERS.map((initial) => `<button type="button" data-wechat-index="${esc(initial)}">${esc(initial)}</button>`).join('')}</nav>` : ''}
    </main>
  `;

  bindChatHubInsTabs(container, 'contacts');
  const searchShell = container.querySelector('.wechat-directory-search');
  const searchInput = searchShell?.querySelector('input');
  container.querySelector('[data-wechat-directory-search]')?.addEventListener('click', () => {
    if (!searchShell || !searchInput) return;
    searchShell.hidden = !searchShell.hidden;
    if (!searchShell.hidden) searchInput.focus({ preventScroll: true });
    else {
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  searchInput?.addEventListener('input', () => {
    const query = clean(searchInput.value).toLowerCase();
    container.querySelectorAll('[data-search-text]').forEach((row) => {
      row.hidden = !!query && !clean(row.getAttribute('data-search-text')).includes(query);
    });
    container.querySelectorAll('.wechat-directory-group').forEach((section) => {
      section.hidden = !!query && !section.querySelector('[data-search-text]:not([hidden])');
    });
  });
  container.querySelector('[data-wechat-directory-add]')?.addEventListener('click', () => navigate('contacts/import'));
  container.querySelectorAll('[data-wechat-contact]').forEach((row) => row.addEventListener('click', () => navigate('contacts/card', {
    id: row.getAttribute('data-wechat-contact'),
    ...identityRouteParams,
  })));
  const scrollToIndex = (letter, smooth = false) => {
    const target = letter === 'top' ? container.querySelector('.wechat-directory-scroll') : container.querySelector(`[data-wechat-letter="${CSS.escape(letter)}"]`);
    target?.scrollIntoView({
      behavior: smooth && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto',
      block: 'start',
    });
  };
  container.querySelectorAll('[data-wechat-index]').forEach((button) => button.addEventListener('click', () => {
    scrollToIndex(button.getAttribute('data-wechat-index'), true);
  }));
  const indexRail = container.querySelector('.wechat-directory-index');
  let indexTracking = false;
  let lastIndex = '';
  const pickIndexAt = (x, y) => {
    const button = document.elementFromPoint(x, y)?.closest?.('[data-wechat-index]');
    if (!button || !indexRail?.contains(button)) return;
    const letter = button.getAttribute('data-wechat-index');
    if (!letter || letter === lastIndex) return;
    lastIndex = letter;
    scrollToIndex(letter, false);
  };
  indexRail?.addEventListener('touchstart', (event) => {
    const touch = event.touches?.[0];
    if (!touch) return;
    indexTracking = true;
    lastIndex = '';
    pickIndexAt(touch.clientX, touch.clientY);
  }, { passive: true });
  indexRail?.addEventListener('touchmove', (event) => {
    if (!indexTracking) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    event.preventDefault();
    pickIndexAt(touch.clientX, touch.clientY);
  }, { passive: false });
  const stopIndexTracking = () => {
    indexTracking = false;
    lastIndex = '';
  };
  indexRail?.addEventListener('touchend', stopIndexTracking, { passive: true });
  indexRail?.addEventListener('touchcancel', stopIndexTracking, { passive: true });
  container.querySelectorAll('[data-wechat-directory-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.getAttribute('data-wechat-directory-action');
    if (['new', 'only-chat', 'groups', 'tags', 'official', 'service'].includes(action)) {
      navigate('chat/wechat-feature', { feature: action });
    }
    else showToast('暂不可用');
  }));
}
