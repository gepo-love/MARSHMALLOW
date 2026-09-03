import {
  back,
  navigate,
  navigateDismissing,
  invalidateKeepAlive,
  invalidateOfflinePresenceKeepAlive,
} from '../core/router.js';
import { consumeRoutePrefetchData, prefetchRoute } from '../core/route-prefetch.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import { isOversizedAvatarDataUrl } from '../core/avatar-compaction.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser, listUsersInSlot } from '../core/user-slot.js';
import { captureElementScrollState, restoreElementScrollState } from '../core/scroll-state.js';
import { clearChatUnread, collapseDuplicateEmptyPrivateChats, createGroupChat, ensurePrivateChat, listInboxChatsForUser, listBackstageChats, listMessagesForChat, recalcChatPreview, sortChatsForInbox, toggleChatPinned, deleteChatWithData } from '../core/chat-store.js';
import { loadOfflineSession, offlineSessionKey } from '../core/offline-session-store.js';
import { restoreArchivedOfflinePrivateChats } from '../core/offline-chat-isolation.js';
import { openChatRowSheet } from '../components/chat-row-sheet.js';
import { bindLongPress } from '../components/chat-bubble-menu.js';
import { bindSwipeActions } from '../components/swipe-actions.js';
import { getCharacter, listCharacters } from '../core/character-store.js';
import { get, getMany, onStoreWrite } from '../core/db.js';
import { getRoleTierLabel } from '../models/character.js';
import { getUserDisplayName } from '../models/user.js';
import { resolveActorDisplayLabel } from '../core/chat/character-code-fallback.js';
import { isAnonymousChat } from '../core/chat-helpers.js';
import { getAnonymousDisplayProfile } from '../core/anonymous-chat.js';
import {
  isChatStreamTypingAnywhere,
  subscribeChatStreamSession,
  CHAT_STREAM_PREVIEW,
} from '../core/chat/chat-stream-session.js';
import { isHeadlessChatReplyTyping } from '../core/chat/headless-reply.js';
import { getCloudChatTypingHint } from '../core/cloud-background-coordinator.js';
import {
  ALL_GROUPS_FILTER,
  filterCharactersByGroup,
  loadContactGroupsConfig,
  resolveCharacterGroupId,
} from '../core/contact-groups.js';
import {
  applyChatHubInsPageClasses,
  bindChatHubInsTabs,
  bindChatHubUserCard,
  buildChatHubInsChrome,
  chatHubInsToolbarIcon,
  loadChatHubInsContext,
} from '../core/chat/chat-hub-ins-chrome.js';
import { bindCommitSearch } from '../components/search-field.js';
import {
  isStrangerInterceptChat,
  resolveStrangerThreadUserAccountId,
  visibleIdentityFor,
} from '../core/stranger-thread-model.js';
import { principalKey } from '../core/alias-account-model.js';
import { hasUnreadMoments } from '../core/moments/moments-store.js';
import { saveUserInterceptSettings } from '../core/user-intercept-auto.js';
import { wechatGlyph } from '../core/chat/wechat-shell.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function chatHubBackgroundOpacity(value, fallback = 40) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function cssBackgroundImage(dataUrl = '') {
  const value = String(dataUrl || '').trim();
  if (!value) return 'none';
  return `url("${value.replace(/["\\\n\r\f]/g, '\\$&')}")`;
}

const ENCOUNTER_GROUPS_COLLAPSED_KEY = 'marshmallow:chat-encounter-groups-collapsed';

function readEncounterGroupsCollapsed() {
  try {
    return localStorage.getItem(ENCOUNTER_GROUPS_COLLAPSED_KEY) !== '0';
  } catch (_) {
    return true;
  }
}

function writeEncounterGroupsCollapsed(collapsed) {
  try {
    localStorage.setItem(ENCOUNTER_GROUPS_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch (_) { /* 当前会话内的状态仍然有效 */ }
}

function formatListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `昨天 ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function inboxAvatarLetterHtml(letter) {
  const ch = String(letter || '?').slice(0, 1);
  return `<span class="chat-list-avatar-letter">${esc(ch)}</span>`;
}

function linkedQqAccountAvatarHtml() {
  return `
    <span class="chat-linked-account-glyph" aria-hidden="true">
      <svg viewBox="0 0 48 48" focusable="false">
        <circle cx="24" cy="24" r="24" fill="#12b7f5"/>
        <circle cx="20" cy="18" r="6.5" fill="#fff"/>
        <path d="M8.5 37c1.2-7.7 5.4-11.6 11.5-11.6S30.3 29.3 31.5 37H8.5Z" fill="#fff"/>
        <circle cx="32.5" cy="20.5" r="4.4" fill="#fff" opacity=".92"/>
        <path d="M29.8 27.1c5.4-.2 8.7 3 9.7 8.8h-6.2c-.4-3.7-1.6-6.6-3.5-8.8Z" fill="#fff" opacity=".92"/>
      </svg>
    </span>`;
}

function groupAssistantAvatarHtml() {
  return `
    <span class="chat-group-assistant-glyph" aria-hidden="true">
      <svg viewBox="0 0 48 48" focusable="false">
        <path d="M10 12.5h25.5a4.5 4.5 0 014.5 4.5v14a4.5 4.5 0 01-4.5 4.5H22l-6.5 4v-4H10A4.5 4.5 0 015.5 31V17a4.5 4.5 0 014.5-4.5Z" fill="#fff"/>
        <rect x="12" y="19" width="17" height="3" rx="1.5" fill="#ffad18"/>
        <rect x="12" y="25" width="13" height="3" rx="1.5" fill="#ffad18"/>
        <circle cx="36" cy="35.5" r="7.5" fill="#fff"/>
        <rect x="32.5" y="34.2" width="7" height="2.6" rx="1.3" fill="#ffad18"/>
      </svg>
    </span>`;
}

function renderInboxAvatar(chat, title, partner) {
  if (chat?.type === 'group') {
    const url = String(chat.groupSettings?.avatar || '').trim();
    // 群头像多为历史遗留的未压缩大图，聊天列表一多就会拖慢整页渲染；超大的先按无头像显示。
    if (url && !isOversizedAvatarDataUrl(url)) {
      return `<img src="${esc(url)}" alt="" class="chat-list-avatar-img" loading="lazy" decoding="async" />`;
    }
    return inboxAvatarLetterHtml(chat.groupSettings?.name || title || '群');
  }
  if (isAnonymousChat(chat)) {
    const counterpartId = chat.anonymousPrivateConfig?.counterpartActorId
      || (chat.participants || []).find((p) => p && p !== 'user')
      || chat.id;
    const profile = getAnonymousDisplayProfile(chat, counterpartId);
    const avatar = profile?.avatar || resolveDefaultAvatar('anonymous');
    return `<img src="${esc(avatar)}" alt="" class="chat-list-avatar-img" loading="lazy" decoding="async" />`;
  }
  if (isStrangerInterceptChat(chat)) {
    const partnerId = (chat.participants || []).find((p) => p && p !== 'user') || '';
    const accountId = chat.metadata?.accountIdentityMap?.[principalKey('character', partnerId)] || '';
    const snapshot = accountId ? chat.metadata?.accountSnapshots?.[accountId] : null;
    if (snapshot?.avatar) return `<img src="${esc(snapshot.avatar)}" alt="" class="chat-list-avatar-img" loading="lazy" decoding="async" />`;
    if (snapshot?.displayName) return `<img src="${esc(resolveDefaultAvatar('chat'))}" alt="" class="chat-list-avatar-img" loading="lazy" decoding="async" />`;
  }
  if (partner) {
    return characterAvatarHtml(partner, { className: 'chat-list-avatar-img' });
  }
  return `<img src="${esc(resolveDefaultAvatar('chat'))}" alt="" class="chat-list-avatar-img" loading="lazy" decoding="async" />`;
}

async function resolveChatTitle(chat, user = null, {
  characterById = null,
  prefsByChatId = null,
} = {}) {
  if (isStrangerInterceptChat(chat)) {
    const counterpartId = (chat.participants || []).find((p) => p && p !== 'user') || '';
    const key = principalKey('character', counterpartId);
    const identity = visibleIdentityFor(chat.metadata, key, {});
    if (identity?.displayName) return identity.displayName;
  }
  if (isAnonymousChat(chat)) {
    const counterpartId = chat.anonymousPrivateConfig?.counterpartActorId
      || (chat.participants || []).find((p) => p && p !== 'user');
    const profile = getAnonymousDisplayProfile(chat, counterpartId, { currentUserName: getUserDisplayName(user), userRow: user });
    if (profile?.anonymousId) return profile.anonymousId;
  }
  if (chat.type === 'group') {
    const name = String(chat.groupSettings?.name || '').trim();
    if (name) return name;
    return '群聊';
  }
  const partnerId = (chat.participants || []).find((p) => p && p !== 'user');
  if (!partnerId) return '私聊';
  const prefsRow = prefsByChatId instanceof Map
    ? prefsByChatId.get(chat.id)
    : await get(`chatPrefs_${chat.id}`).catch(() => null);
  const remarkName = String(prefsRow?.value?.remarkName || '').trim();
  if (remarkName) return remarkName;
  const char = characterById instanceof Map
    ? characterById.get(partnerId)
    : await getCharacter(partnerId, { userId: user?.id });
  return resolveActorDisplayLabel(char?.name || char?.customNickname || partnerId, {
    user,
    characters: char ? { [partnerId]: char } : {},
    fallback: '私聊',
  });
}

function renderContactRow(char) {
  const sub = [getRoleTierLabel(char.roleTier), char.customNickname].filter(Boolean).join(' · ');
  return `
    <button type="button" class="chat-pick-row chat-new-contact-row" data-id="${esc(char.id)}">
      <span class="chat-pick-avatar">${characterAvatarHtml(char, { className: 'chat-pick-avatar-img' })}</span>
      <span class="chat-pick-body">
        <strong>${esc(char.name)}</strong>
        <small>${esc(sub || '角色')}</small>
      </span>
      <span class="chat-pick-go" aria-hidden="true">${icon('chevron')}</span>
    </button>
  `;
}

function characterSearchText(char) {
  return [
    char?.id,
    char?.name,
    char?.realName,
    char?.customNickname,
    char?.currentRole,
    char?.notes,
    getRoleTierLabel(char?.roleTier),
    ...(Array.isArray(char?.aliases) ? char.aliases : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function filterCharactersForPicker(chars, groupId, query) {
  const q = String(query || '').trim().toLowerCase();
  let rows = filterCharactersByGroup(chars, groupId);
  if (q) rows = rows.filter((c) => characterSearchText(c).includes(q));
  return rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
}

function buildGroupCounts(chars, config) {
  const counts = new Map();
  counts.set(ALL_GROUPS_FILTER, chars.length);
  for (const g of config?.groups || []) {
    counts.set(g.id, chars.filter((c) => resolveCharacterGroupId(c) === g.id).length);
  }
  return counts;
}

function renderGroupFilterChips(config, activeGroupId, countsByGroup) {
  const chips = [{ id: ALL_GROUPS_FILTER, name: '全部' }, ...(config?.groups || [])];
  return chips.map((g) => {
    const active = activeGroupId === g.id ? ' is-active' : '';
    const count = countsByGroup.get(g.id) ?? 0;
    return `<button type="button" class="chat-new-group-chip${active}" data-group-id="${esc(g.id)}">${esc(g.name)}<span class="chat-new-group-chip-count">${count}</span></button>`;
  }).join('');
}

function memberDisplayName(chars, id, fallback = '成员') {
  const c = chars.find((x) => x.id === id);
  return resolveActorDisplayLabel(c?.customNickname || c?.name || id, {
    characters: c ? { [id]: c } : {},
    fallback,
  });
}

function renderSelectedMemberChips(chars, selected) {
  const ids = [...selected];
  if (!ids.length) {
    return '<span class="text-hint chat-new-selected-empty">还没有选人</span>';
  }
  return ids.map((id) => {
    const name = memberDisplayName(chars, id);
    return `<button type="button" class="chat-new-selected-chip" data-remove-id="${esc(id)}" title="点击移除"><span>${esc(name)}</span><b>×</b></button>`;
  }).join('');
}

function renderMemberSummary(chars, selected) {
  const ids = [...selected];
  const names = ids.map((id) => memberDisplayName(chars, id));
  const preview = names.length
    ? (names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 人` : names.join('、'))
    : '还没有选人，点击选择成员';
  const avatarsHtml = ids.slice(0, 5).map((id) => {
    const c = chars.find((x) => x.id === id);
    return `<span>${c ? characterAvatarHtml(c, { className: 'chat-pick-avatar-img' }) : ''}</span>`;
  }).join('');
  return `
    <button type="button" class="chat-new-member-summary">
      <span class="chat-new-member-summary-avatars">${avatarsHtml}</span>
      <span class="chat-new-member-summary-text">${esc(preview)}</span>
      <span class="chat-new-member-summary-chevron" aria-hidden="true">${icon('chevron')}</span>
    </button>
  `;
}

function renderGroupRow(char, selected, groupConfig) {
  const sub = [getRoleTierLabel(char.roleTier), char.customNickname].filter(Boolean).join(' · ');
  const groupName = (groupConfig?.groups || []).find((g) => g.id === resolveCharacterGroupId(char))?.name || '';
  const checked = selected.has(char.id) ? ' checked' : '';
  return `
    <button type="button" class="chat-pick-row chat-new-group-row ${selected.has(char.id) ? 'is-selected' : ''}" data-id="${esc(char.id)}">
      <span class="chat-pick-avatar">${characterAvatarHtml(char, { className: 'chat-pick-avatar-img' })}</span>
      <span class="chat-pick-body">
        <strong>${esc(char.name)}</strong>
        <small>${esc([groupName, sub].filter(Boolean).join(' · ') || '角色')}</small>
      </span>
      <input type="checkbox" class="chat-pick-check" data-id="${esc(char.id)}"${checked} aria-label="选择 ${esc(char.name)}" />
    </button>
  `;
}

export default async function render(container, params = {}) {
  const tab = String(params.tab || 'messages').trim();
  const shoppingDraft = String(params.shoppingDraft || '').trim().slice(0, 600);
  const shoppingShare = String(params.shoppingShare || '').trim().slice(0, 120);
  let offlineChatId = String(params.offlineChatId || '').trim();
  if (tab === 'moments') {
    navigate('chat/moments', {}, true);
    return;
  }
  if (tab === 'backstage') {
    navigate('chat/backstage', {}, true);
    return;
  }

  // 先画出顶栏骨架，避免等会话/主题数据期间整页空白。
  container.className = 'page chat-hub-page scrapbook-page';
  container.innerHTML = `
    <header class="navbar chat-hub-navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">Chat</h1>
      <button type="button" class="navbar-btn" aria-label="新建聊天" disabled>${icon('plus')}</button>
    </header>
    <main class="chat-hub-scroll scrapbook-scroll" aria-busy="true">
      <div class="page-skeleton chat-hub-skeleton" aria-hidden="true">
        <span class="sk-block sk-bar" style="width:55%"></span>
        <span class="sk-block sk-bar" style="width:40%"></span>
        <span class="sk-block sk-bar" style="width:62%"></span>
      </div>
    </main>
  `;
  container.querySelector('[data-back]')?.addEventListener('click', () => back());

  const prefetchedDataPromise = consumeRoutePrefetchData('chat') || Promise.resolve(null);
  const userPromise = prefetchedDataPromise.then((snapshot) => snapshot?.user || ensureDefaultUser());
  const user = await userPromise;
  const identityAppearance = user?.identityAppearance && typeof user.identityAppearance === 'object'
    ? user.identityAppearance
    : {};
  const hubBackgroundAssetId = String(identityAppearance.chatHubBackgroundAssetId || '');
  const sidebarBackgroundAssetId = String(identityAppearance.chatSidebarBackgroundAssetId || '');
  const customBackgroundsPromise = getMany('beautifyAssets', [
    hubBackgroundAssetId,
    sidebarBackgroundAssetId,
  ]).catch(() => []);
  const initialInboxPromise = prefetchedDataPromise.then((snapshot) => (
    snapshot?.inboxChats || listInboxChatsForUser(user.id)
  ));
  const [offlineSession, insContext, initialInboxChats, initialBackstageChats, initialLinkedUsers, initialMomentsUnread, customBackgrounds] = await Promise.all([
    offlineChatId ? loadOfflineSession(offlineChatId).catch(() => null) : Promise.resolve(null),
    loadChatHubInsContext(),
    initialInboxPromise,
    listBackstageChats(user.id).catch(() => []),
    listUsersInSlot(user.id).catch(() => [user]),
    hasUnreadMoments(user.id).catch(() => false),
    customBackgroundsPromise,
  ]);
  if (offlineChatId && (offlineSession?.status !== 'active' || !offlineSession.phoneSideTrip)) {
    offlineChatId = '';
  }
  async function reconcileOfflinePresenceBar() {
    const targetId = String(offlineChatId || '').trim();
    if (!targetId) return false;
    let latest;
    try {
      latest = await loadOfflineSession(targetId);
    } catch (_) {
      return true;
    }
    if (latest?.status === 'active' && latest.phoneSideTrip) return true;
    if (offlineChatId !== targetId) return false;
    offlineChatId = '';
    container.querySelector('[data-return-offline]')?.remove();
    return false;
  }
  const { hubInsChrome, windowTheme, seaTheme, chatPlatform = 'current' } = insContext;
  const hubBackgroundAsset = customBackgrounds?.[0]?.id === hubBackgroundAssetId
    ? customBackgrounds[0]
    : null;
  const sidebarBackgroundAsset = customBackgrounds?.[1]?.id === sidebarBackgroundAssetId
    ? customBackgrounds[1]
    : null;
  const hubBackgroundOpacity = chatHubBackgroundOpacity(identityAppearance.chatHubBackgroundOpacity);
  const sidebarBackgroundOpacity = chatHubBackgroundOpacity(identityAppearance.chatSidebarBackgroundOpacity);
  let backstageChats = Array.isArray(initialBackstageChats) ? initialBackstageChats : [];
  let linkedUsers = Array.isArray(initialLinkedUsers) && initialLinkedUsers.length ? initialLinkedUsers : [user];
  let momentsUnread = initialMomentsUnread === true;
  let previewRefreshScheduled = false;
  let previewRefreshRunning = false;
  let previewRefreshRevision = 0;
  let previewRefreshScheduleToken = 0;
  let previewRefreshHandle = 0;
  let previewMaintenancePending = false;
  let inboxRefreshScheduled = false;
  let inboxRefreshRevision = 0;
  async function loadVisibleInboxChats() {
    const [inboxChats, nextBackstageChats] = await Promise.all([
      listInboxChatsForUser(user.id),
      listBackstageChats(user.id),
    ]);
    backstageChats = Array.isArray(nextBackstageChats) ? nextBackstageChats : [];
    const pendingInvites = await Promise.all(backstageChats.map(async (chat) => {
      const messages = await listMessagesForChat(chat.id, 50).catch(() => []);
      return messages.some((message) => (
        message
        && !message.deleted
        && message.type === 'groupInviteUser'
        && String(message.metadata?.status || 'pending') === 'pending'
      )) ? chat : null;
    }));
    const merged = new Map();
    for (const chat of [...inboxChats, ...pendingInvites.filter(Boolean)]) {
      if (chat && !isAnonymousChat(chat)) merged.set(chat.id, chat);
    }
    return [...merged.values()];
  }

  let chats = sortChatsForInbox((initialInboxChats || []).filter((chat) => !isAnonymousChat(chat)));
  let charById = new Map();

  async function isChatTyping(chatId = '') {
    const id = String(chatId || '').trim();
    if (!id) return false;
    if (isChatStreamTypingAnywhere(id) || isHeadlessChatReplyTyping(id)) return true;
    const cloud = await getCloudChatTypingHint(id).catch(() => null);
    return cloud?.typing === true;
  }

  async function buildRows(sourceChats = chats) {
    const [chars, prefsRows] = await Promise.all([
      listCharacters({ userId: user.id }),
      getMany('settings', sourceChats.map((chat) => `chatPrefs_${chat.id}`)).catch(() => []),
    ]);
    charById = new Map(chars.map((c) => [c.id, c]));
    const prefsByChatId = new Map(sourceChats.map((chat, index) => [chat.id, prefsRows[index] || null]));
    return Promise.all(sourceChats.map(async (chat) => {
      const groupStatePromise = chat.type === 'group'
        ? Promise.all([
          chat.metadata?.encounterOrigin === true
            ? loadOfflineSession(chat.id).catch(() => null)
            : Promise.resolve(null),
          listMessagesForChat(chat.id, 120).catch(() => []),
        ])
        : Promise.resolve([null, []]);
      const [title, streaming, [session, groupMessages]] = await Promise.all([
        resolveChatTitle(chat, user, { characterById: charById, prefsByChatId }),
        isChatTyping(chat.id),
        groupStatePromise,
      ]);
      let preview = streaming
        ? CHAT_STREAM_PREVIEW
        : (String(chat.lastMessage || '').trim() || '暂无消息');
      const unread = Math.max(0, Number(chat.unread) || 0);
      let partner = null;
      if (chat.type !== 'group') {
        const partnerId = (chat.participants || []).find((p) => p && p !== 'user');
        if (partnerId) partner = charById.get(partnerId) || null;
      }
      let encounterActive = false;
      let pendingJoin = false;
      if (chat.type === 'group') {
        encounterActive = chat.metadata?.encounterOrigin === true && !!session;
        pendingJoin = groupMessages.some((message) => {
          const isJoinRequest = message?.type === 'groupInviteUser';
          const status = String(message?.metadata?.status || 'pending');
          return isJoinRequest && status === 'pending';
        });
        if (pendingJoin && !(chat.participants || []).includes('user')) preview = '邀请你加入群聊';
      }
      return { chat, title, preview, partner, unread, streaming, encounterActive, pendingJoin };
    }));
  }

  let rows = await buildRows(chats);
  let typingRefreshSeq = 0;
  let encounterGroupsCollapsed = readEncounterGroupsCollapsed();

  function findLatestInterceptRow(sourceRows = rows) {
    return [...sourceRows]
      .filter((row) => isStrangerInterceptChat(row.chat))
      .sort((a, b) => Number(b?.chat?.lastActivity || 0) - Number(a?.chat?.lastActivity || 0))[0] || null;
  }

  let modalOpen = false;
  let modalView = 'pick';
  let groupStep = 'pick';
  let characters = [];
  let groupConfig = { groups: [] };
  let charactersLoaded = false;
  let groupSelected = new Set();
  let groupName = '';
  let includeSelf = true;
  let ownerId = 'user';
  let privateSearchQuery = '';
  let groupSearchQuery = '';
  let activeGroupFilter = ALL_GROUPS_FILTER;

  function syncPageClasses() {
    applyChatHubInsPageClasses(container, {
      hubInsChrome,
      windowTheme,
      seaTheme,
      chatPlatform,
      extraClasses: [
        modalOpen ? 'is-modal-open' : '',
        hubBackgroundAsset ? 'has-chat-hub-list-background' : '',
        sidebarBackgroundAsset ? 'has-chat-sidebar-background' : '',
      ].filter(Boolean),
    });
    const listBase = chatPlatform === 'wechat'
      ? '245, 245, 245'
      : (chatPlatform === 'qq' ? '246, 247, 250' : '255, 255, 255');
    container.style.setProperty('--chat-hub-list-custom-image', cssBackgroundImage(hubBackgroundAsset?.dataUrl));
    container.style.setProperty(
      '--chat-hub-list-custom-overlay',
      `rgba(${listBase}, ${1 - (hubBackgroundOpacity / 100)})`,
    );
    container.style.setProperty('--chat-sidebar-custom-image', cssBackgroundImage(sidebarBackgroundAsset?.dataUrl));
    container.style.setProperty(
      '--chat-sidebar-custom-opacity',
      String(sidebarBackgroundOpacity / 100),
    );
    container.style.setProperty(
      '--chat-sidebar-custom-overlay',
      `rgba(255, 255, 255, ${1 - (sidebarBackgroundOpacity / 100)})`,
    );
  }

  syncPageClasses();

  async function loadCharacters({ force = false } = {}) {
    if (charactersLoaded && !force) return characters;
    const [chars, config] = await Promise.all([
      listCharacters({ excludeAnonNpc: true, userId: user.id }),
      loadContactGroupsConfig(),
    ]);
    characters = chars.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
    groupConfig = config;
    charactersLoaded = true;
    return characters;
  }

  function renderPrivateDynamicBody() {
    const filteredChars = filterCharactersForPicker(characters, activeGroupFilter, privateSearchQuery);
    const countsByGroup = buildGroupCounts(characters, groupConfig);
    const pickList = filteredChars.length
      ? filteredChars.map(renderContactRow).join('')
      : `<div class="chat-new-empty">${privateSearchQuery || activeGroupFilter !== ALL_GROUPS_FILTER ? '没有匹配角色，可换分组或清空搜索' : '通讯录还是空的，先去写一位角色吧'}</div>`;
    return `
      <div class="chat-new-group-chip-bar">${renderGroupFilterChips(groupConfig, activeGroupFilter, countsByGroup)}</div>
      <div class="chat-new-modal-list">${pickList}</div>
    `;
  }

  function paintPrivateDynamic() {
    const el = container.querySelector('.chat-new-private-dynamic');
    if (!el) { paint(); return; }
    const listScrollState = captureElementScrollState(container, '.chat-new-modal-list');
    el.innerHTML = renderPrivateDynamicBody();
    bindPrivateDynamic();
    restoreElementScrollState(container, '.chat-new-modal-list', listScrollState);
  }

  function bindPrivateDynamic() {
    container.querySelector('.chat-new-private-dynamic .chat-new-group-chip-bar')?.addEventListener('click', (e) => {
      const chip = e.target?.closest?.('.chat-new-group-chip');
      if (!chip) return;
      activeGroupFilter = String(chip.getAttribute('data-group-id') || ALL_GROUPS_FILTER);
      paintPrivateDynamic();
    });
    bindPrivateRows();
  }

  // 群聊挑选里随搜索/筛选/勾选变化的部分（筛选条+已选+列表+底部按钮），单独抽成一段
  // 好在打字/切筛选/勾人时只重绘这一块，不动上面的搜索框本身——避免整页 innerHTML 重建
  // 把输入框销毁重建、移动端抢焦点导致键盘闪一下甚至收起。
  function renderGroupDynamicBody() {
    const list = characters;
    const filteredGroupChars = filterCharactersForPicker(list, activeGroupFilter, groupSearchQuery);
    const countsByGroup = buildGroupCounts(list, groupConfig);
    const groupList = filteredGroupChars.length
      ? filteredGroupChars.map((char) => renderGroupRow(char, groupSelected, groupConfig)).join('')
      : `<div class="chat-new-empty">${groupSearchQuery || activeGroupFilter !== ALL_GROUPS_FILTER ? '没有匹配角色，可换分组或清空搜索' : '通讯录还是空的，先去写一位角色吧'}</div>`;
    const canProceed = groupSelected.size >= 1;
    return `
      <div class="chat-new-group-chip-bar">${renderGroupFilterChips(groupConfig, activeGroupFilter, countsByGroup)}</div>
      <div class="chat-new-selected-wrap">
        <div class="chat-new-selected-title">已选 ${groupSelected.size}</div>
        <div class="chat-new-selected-list">${renderSelectedMemberChips(list, groupSelected)}</div>
      </div>
      <div class="chat-new-modal-list">${groupList}</div>
      <footer class="chat-new-modal-foot">
        <span class="chat-pick-count">已选 ${groupSelected.size} 人</span>
        <button type="button" class="btn btn-primary btn-sm chat-new-group-next" ${canProceed ? '' : 'disabled'}>下一步</button>
      </footer>
    `;
  }

  function paintGroupDynamic() {
    const el = container.querySelector('.chat-new-group-dynamic');
    if (!el) { paint(); return; }
    const listScrollState = captureElementScrollState(container, '.chat-new-modal-list');
    el.innerHTML = renderGroupDynamicBody();
    bindGroupDynamic();
    restoreElementScrollState(container, '.chat-new-modal-list', listScrollState);
  }

  function bindGroupDynamic() {
    container.querySelector('.chat-new-group-chip-bar')?.addEventListener('click', (e) => {
      const chip = e.target?.closest?.('.chat-new-group-chip');
      if (!chip) return;
      activeGroupFilter = String(chip.getAttribute('data-group-id') || ALL_GROUPS_FILTER);
      paintGroupDynamic();
    });
    container.querySelector('.chat-new-selected-list')?.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('.chat-new-selected-chip');
      if (!btn) return;
      const id = String(btn.getAttribute('data-remove-id') || '').trim();
      if (!id) return;
      groupSelected.delete(id);
      paintGroupDynamic();
    });
    container.querySelectorAll('.chat-new-group-row').forEach((row) => {
      row.addEventListener('click', () => {
        const id = String(row.getAttribute('data-id') || '').trim();
        if (!id) return;
        if (groupSelected.has(id)) groupSelected.delete(id);
        else groupSelected.add(id);
        paintGroupDynamic();
      });
    });
    container.querySelector('.chat-new-group-next')?.addEventListener('click', () => {
      if (groupSelected.size < 1) {
        showToast('请至少选择 1 位角色');
        return;
      }
      groupStep = 'settings';
      paint();
    });
  }

  function renderModal() {
    if (!modalOpen) return '';
    const modalCardClass = hubInsChrome
      ? 'chat-new-modal-card chat-new-modal-card--ins'
      : 'chat-new-modal-card scrapbook-panel';
    const list = characters;

    if (modalView === 'group') {
      if (ownerId !== 'user' && !groupSelected.has(ownerId)) ownerId = includeSelf ? 'user' : ([...groupSelected][0] || '');
      if (!includeSelf && ownerId === 'user') ownerId = [...groupSelected][0] || '';

      if (groupStep === 'settings') {
        const ownerOptions = [
          ...(includeSelf ? [{ id: 'user', name: '我' }] : []),
          ...[...groupSelected].map((id) => {
            const c = list.find((x) => x.id === id);
            return { id, name: memberDisplayName(list, id, '成员') };
          }),
        ];
        const minSelected = includeSelf ? 1 : 2;
        const canCreateGroup = groupSelected.size >= minSelected;
        return `
          <div class="chat-new-modal" role="dialog" aria-modal="true" aria-label="群聊设置">
            <button type="button" class="chat-new-modal-backdrop" aria-label="关闭"></button>
            <div class="${modalCardClass}">
              <header class="chat-new-modal-head">
                <button type="button" class="btn btn-outline btn-xs chat-new-group-settings-back">返回</button>
                <h3>群聊设置</h3>
                <button type="button" class="btn btn-outline btn-xs chat-new-modal-close">关闭</button>
              </header>
              <div class="chat-new-settings-body">
                ${renderMemberSummary(list, groupSelected)}
                <label class="api-field">
                  <span class="api-field-label">群名称（可选）</span>
                  <input type="text" class="form-input chat-new-group-name" value="${esc(groupName)}" placeholder="例如：日常闲聊" />
                </label>
                <label class="chat-new-toggle-row">
                  <span>
                    <strong>包含我自己</strong>
                    <small>关闭后为旁观群：你不入群，只看角色互动</small>
                  </span>
                  <input type="checkbox" class="chat-new-include-self" ${includeSelf ? 'checked' : ''} />
                </label>
                ${ownerOptions.length ? `
                <label class="api-field">
                  <span class="api-field-label">群主</span>
                  <select class="form-input chat-new-owner-select">
                    ${ownerOptions.map((o) => `<option value="${esc(o.id)}" ${ownerId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
                  </select>
                </label>
                ` : ''}
              </div>
              <footer class="chat-new-modal-foot">
                <span class="chat-pick-count">已选 ${groupSelected.size} 人</span>
                <button type="button" class="btn btn-primary btn-sm chat-new-group-create" ${canCreateGroup ? '' : 'disabled'}>创建群聊</button>
              </footer>
            </div>
          </div>
        `;
      }

      return `
        <div class="chat-new-modal" role="dialog" aria-modal="true" aria-label="选择群成员">
          <button type="button" class="chat-new-modal-backdrop" aria-label="关闭"></button>
          <div class="${modalCardClass}">
            <header class="chat-new-modal-head">
              <button type="button" class="btn btn-outline btn-xs chat-new-modal-back">返回</button>
              <h3>选择成员</h3>
              <button type="button" class="btn btn-outline btn-xs chat-new-modal-close">关闭</button>
            </header>
            <div class="chat-new-search-wrap">
              <div class="chat-new-search-bar">
                <input type="search" class="form-input chat-new-group-search" value="${esc(groupSearchQuery)}" placeholder="搜索名字 / 昵称 / 别名 / 备注，回车搜索" />
                <button type="button" class="search-icon-submit chat-new-search-btn" data-group-search-submit aria-label="搜索">${icon('search')}</button>
              </div>
            </div>
            <div class="chat-new-group-dynamic">${renderGroupDynamicBody()}</div>
          </div>
        </div>
      `;
    }

    return `
      <div class="chat-new-modal" role="dialog" aria-modal="true" aria-label="开始聊天">
        <button type="button" class="chat-new-modal-backdrop" aria-label="关闭"></button>
        <div class="${modalCardClass}">
          <header class="chat-new-modal-head">
            <h3>开始聊天</h3>
            <button type="button" class="btn btn-outline btn-xs chat-new-modal-close">关闭</button>
          </header>
          <button type="button" class="btn btn-soft btn-sm chat-new-open-group">${icon('plus')}创建群聊</button>
          <div class="chat-new-search-wrap">
            <div class="chat-new-search-bar">
              <input type="search" class="form-input chat-new-private-search" value="${esc(privateSearchQuery)}" placeholder="搜索名字 / 昵称 / 别名 / 备注，回车搜索" />
              <button type="button" class="search-icon-submit chat-new-search-btn" data-private-search-submit aria-label="搜索">${icon('search')}</button>
            </div>
          </div>
          <div class="chat-new-group-dynamic chat-new-private-dynamic">${renderPrivateDynamicBody()}</div>
        </div>
      </div>
    `;
  }

  function paint() {
    syncPageClasses();
    const hubScrollState = captureElementScrollState(container, '.chat-hub-scroll');
    const modalScrollState = captureElementScrollState(container, '.chat-new-modal-list');
    const hubTabsClass = hubInsChrome ? 'chat-hub-tabs chat-hub-tabs--ins' : 'chat-hub-tabs';
    const hubScrollClass = hubInsChrome ? 'chat-hub-scroll chat-hub-scroll--ins' : 'chat-hub-scroll scrapbook-scroll';
    const listRowClass = hubInsChrome ? 'chat-list-row chat-list-row--ins' : 'chat-list-row';
    const tabsHtml = `
        <button type="button" class="chat-hub-tab is-active" data-tab="messages">消息</button>
        <button type="button" class="chat-hub-tab" data-tab="moments">朋友圈</button>
        <button type="button" class="chat-hub-tab" data-tab="intercepts">陌生消息</button>
        <button type="button" class="chat-hub-tab" data-tab="backstage">秘密基地</button>
      `;
    const renderChatRow = ({ chat, title, preview, partner, unread, streaming }) => {
      const searchText = esc(`${title} ${preview}`);
      const rowButton = `
        <button type="button" class="${listRowClass} ${chat.pinned ? 'is-pinned' : ''} ${streaming ? 'is-streaming' : ''}" data-chat-id="${esc(chat.id)}"${chatPlatform === 'qq' ? '' : ` data-chat-search-text="${searchText}"`}>
          <span class="chat-list-avatar">${renderInboxAvatar(chat, title, partner)}</span>
          <span class="chat-list-body">
            <span class="chat-list-title">${hubInsChrome ? '' : (chat.pinned ? '📌 ' : '')}${esc(title)}</span>
            <span class="chat-list-preview">${esc(preview.slice(0, 48))}</span>
          </span>
          <span class="chat-list-meta">
            ${hubInsChrome && chat.pinned ? `<span class="chat-list-pin-mark" aria-label="已置顶">${icon('pin')}</span>` : ''}
            ${unread ? `<span class="chat-list-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
            <span class="chat-list-time">${esc(formatListTime(chat.lastActivity))}</span>
          </span>
        </button>
      `;
      if (chatPlatform !== 'qq' && chatPlatform !== 'wechat') return rowButton;
      return `
        <div class="chat-list-swipe-row${chat.pinned ? ' is-pinned' : ''}" data-swipe-row data-chat-search-text="${searchText}">
          <div class="chat-list-swipe-actions" data-swipe-actions aria-label="会话操作">
            <button type="button" class="chat-list-swipe-action is-pin" data-chat-swipe-pin data-swipe-chat-id="${esc(chat.id)}">${chat.pinned ? '取消置顶' : '置顶'}</button>
            <button type="button" class="chat-list-swipe-action is-delete" data-chat-swipe-delete data-swipe-chat-id="${esc(chat.id)}">删除</button>
          </div>
          <div class="chat-list-swipe-content" data-swipe-content>${rowButton}</div>
        </div>
      `;
    };
    const renderAggregateRow = ({ kind, title, preview, unread = 0, lastActivity = 0 }) => `
      <button type="button" class="${listRowClass} chat-list-row--aggregate" data-chat-aggregate="${esc(kind)}" data-chat-search-text="${esc(`${title} ${preview}`)}">
        <span class="chat-list-avatar chat-list-avatar--aggregate is-${esc(kind)}">${kind === 'groups' ? groupAssistantAvatarHtml() : icon('roleSay')}</span>
        <span class="chat-list-body">
          <span class="chat-list-title">${esc(title)}</span>
          <span class="chat-list-preview">${esc(preview || '暂无新消息')}</span>
        </span>
        <span class="chat-list-meta">
          ${unread ? `<span class="chat-list-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
          <span class="chat-list-time">${esc(formatListTime(lastActivity))}</span>
        </span>
      </button>
    `;
    const renderLinkedAccountRow = ({ preview, lastActivity = 0 }) => `
      <button type="button" class="${listRowClass} chat-list-row--linked" data-open-linked-accounts data-chat-search-text="${esc(`我的关联 QQ 账号 ${preview}`)}">
        <span class="chat-list-avatar chat-list-avatar--linked">${linkedQqAccountAvatarHtml()}</span>
        <span class="chat-list-body">
          <span class="chat-list-title">我的关联 QQ 账号</span>
          <span class="chat-list-preview">${esc(preview)}</span>
        </span>
        <span class="chat-list-meta">
          <span class="chat-list-time">${esc(formatListTime(lastActivity))}</span>
        </span>
      </button>
    `;
    const interceptRows = rows.filter((row) => isStrangerInterceptChat(row.chat));
    const interceptIds = new Set(interceptRows.map((row) => row.chat.id));
    const encounterRows = rows.filter((row) => {
      if (row.chat?.metadata?.encounterOrigin !== true) return false;
      if (String(row.chat.metadata?.encounterInboxPolicy || '') === 'chat') return false;
      return !row.encounterActive && !row.pendingJoin && !row.unread;
    });
    const encounterIds = new Set(encounterRows.map((row) => row.chat.id));
    const mainRows = rows.filter((row) => !encounterIds.has(row.chat.id) && !interceptIds.has(row.chat.id));
    const encounterSectionHtml = encounterRows.length ? `
      <section class="chat-encounter-groups${encounterGroupsCollapsed ? ' is-collapsed' : ''}">
        <button type="button" class="chat-encounter-groups-toggle" data-toggle-encounter-groups aria-expanded="${encounterGroupsCollapsed ? 'false' : 'true'}">
          <span>相遇小群</span>
          <small>${encounterRows.length}</small>
          <span class="chat-encounter-groups-caret" aria-hidden="true">⌄</span>
        </button>
        <div class="chat-encounter-groups-list" ${encounterGroupsCollapsed ? 'hidden' : ''}>
          ${encounterRows.map(renderChatRow).join('')}
        </div>
      </section>` : '';
    const mainRowsHtml = mainRows.length ? mainRows.map(renderChatRow).join('') : (chatPlatform === 'wechat' ? '' : `
      <div class="chat-empty${hubInsChrome ? ' chat-empty--ins' : ' scrapbook-empty'}">
        ${hubInsChrome ? '' : emptyIllustration('chat')}
        <div class="chat-empty-text">还没有普通会话</div>
        <div class="chat-empty-hint">点击右上角 + 选一位角色开始聊</div>
      </div>`);
    const latestBackstage = [...backstageChats].sort((a, b) => Number(b?.lastActivity || 0) - Number(a?.lastActivity || 0))[0] || null;
    const backstageUnread = backstageChats.reduce((sum, chat) => sum + Math.max(0, Number(chat?.unread || 0) || 0), 0);
    const latestIntercept = findLatestInterceptRow(interceptRows);
    const interceptUnread = interceptRows.reduce((sum, row) => sum + Math.max(0, Number(row?.unread || 0) || 0), 0);
    const orderedLinkedUsers = [...linkedUsers].sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
    const latestLinkedUser = orderedLinkedUsers[0] || user;
    const linkedAccountPreview = String(latestLinkedUser?.statusText || latestLinkedUser?.signature || '').trim()
      || (orderedLinkedUsers.length > 1
        ? `${orderedLinkedUsers.length} 个关联账号`
        : `${getUserDisplayName(latestLinkedUser)} · 当前账号`);
    const qqEntries = chatPlatform === 'qq' ? [
      ...[...mainRows, ...encounterRows].map((row) => ({
        kind: 'chat',
        lastActivity: Number(row?.chat?.lastActivity || 0) || 0,
        pinned: row?.chat?.pinned === true,
        row,
      })),
      {
        kind: 'linked',
        lastActivity: Number(latestLinkedUser?.updatedAt || latestLinkedUser?.createdAt || 0) || 0,
        pinned: false,
      },
      {
        kind: 'groups',
        lastActivity: Number(latestBackstage?.lastActivity || 0) || 0,
        pinned: false,
      },
      {
        kind: 'strangers',
        lastActivity: Number(latestIntercept?.chat?.lastActivity || 0) || 0,
        pinned: false,
      },
    ].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Number(b.lastActivity || 0) - Number(a.lastActivity || 0);
    }) : [];
    const qqRowsHtml = qqEntries.map((entry) => {
      if (entry.kind === 'chat') return renderChatRow(entry.row);
      if (entry.kind === 'linked') return renderLinkedAccountRow({
        preview: linkedAccountPreview,
        lastActivity: entry.lastActivity,
      });
      if (entry.kind === 'groups') return renderAggregateRow({
        kind: 'groups',
        title: '群助手',
        preview: latestBackstage
          ? `${latestBackstage.groupSettings?.name || '群聊'}：${latestBackstage.lastMessage || '暂无消息'}`
          : '集中查看群聊幕后会话',
        unread: backstageUnread,
        lastActivity: entry.lastActivity,
      });
      return renderAggregateRow({
        kind: 'strangers',
        title: '小号与陌生消息',
        preview: latestIntercept?.preview || '查看角色小号与陌生会话',
        unread: interceptUnread,
        lastActivity: entry.lastActivity,
      });
    }).join('');
    const platformAggregateRowsHtml = chatPlatform === 'wechat' ? `
      ${renderAggregateRow({
        kind: 'groups',
        title: '群助手',
        preview: latestBackstage
          ? `${latestBackstage.groupSettings?.name || '群聊'}：${latestBackstage.lastMessage || '暂无消息'}`
          : '集中查看群聊幕后会话',
        unread: backstageUnread,
        lastActivity: Number(latestBackstage?.lastActivity || 0) || 0,
      })}
      ${renderAggregateRow({
        kind: 'strangers',
        title: '小号与陌生消息',
        preview: latestIntercept?.preview || '查看角色小号与陌生会话',
        unread: interceptUnread,
        lastActivity: Number(latestIntercept?.chat?.lastActivity || 0) || 0,
      })}
    ` : '';
    const listRowsHtml = `
      ${chatPlatform === 'qq' ? qqRowsHtml : mainRowsHtml}
      ${chatPlatform === 'qq' ? '' : encounterSectionHtml}
      ${platformAggregateRowsHtml}
    `;
    const offlineReturnHtml = offlineChatId ? `
      <button type="button" class="chat-offline-return" data-return-offline>
        <span class="chat-offline-return-dot" aria-hidden="true"></span>
        <span>正在线下</span>
        <strong>返回现场</strong>
      </button>` : '';
    if (hubInsChrome) {
      container.innerHTML = `
        ${buildChatHubInsChrome({
          activeTab: 'messages',
          user,
          chatPlatform,
          showSearch: chatPlatform === 'qq' || chatPlatform === 'wechat',
          momentsUnread,
          toolbarActionsHtml: chatPlatform === 'wechat'
            ? `<button type="button" class="chat-hub-icon-btn chat-hub-wechat-search" aria-label="搜索">${wechatGlyph('search')}</button><button type="button" class="chat-hub-icon-btn chat-hub-new" aria-label="新建聊天">${wechatGlyph('plus')}</button>`
            : `${chatPlatform === 'current' ? chatHubInsToolbarIcon('chat-hub-aliases', '马甲', 'roleSay') : ''}${chatHubInsToolbarIcon('chat-hub-new', '新建聊天', 'plus')}`,
        })}
        ${offlineReturnHtml}
        <main class="${hubScrollClass}">
          ${listRowsHtml}
        </main>
        ${modalOpen ? renderModal() : ''}
      `;
    } else {
      const hubHead = `
      <header class="navbar chat-hub-navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">Chat</h1>
        <button type="button" class="navbar-btn chat-hub-aliases" aria-label="马甲">${icon('roleSay')}</button>
        <button type="button" class="navbar-btn chat-hub-new" aria-label="新建聊天">${icon('plus')}</button>
      </header>
    `;
      container.innerHTML = `
      ${hubHead}
      <nav class="${hubTabsClass}" aria-label="Chat 分区">${tabsHtml}</nav>
      ${offlineReturnHtml}
      <main class="${hubScrollClass}">
        ${listRowsHtml}
      </main>
      ${modalOpen ? renderModal() : ''}
    `;
    }

    bindStatic();
    if (modalOpen) bindModal();
    restoreElementScrollState(container, '.chat-hub-scroll', hubScrollState);
    restoreElementScrollState(container, '.chat-new-modal-list', modalScrollState);
  }

  function schedulePreviewRefresh({ immediate = false, performMaintenance = false } = {}) {
    previewRefreshRevision += 1;
    previewMaintenancePending ||= performMaintenance;
    if (previewRefreshRunning) return;
    // 页面初次进入时可能已经排了 idle 对账。复挂、消息写入等即时刷新必须能
    // 抢占这份尚未开始的任务，不能被一个长时间不执行的 idle 标记挡住。
    if (previewRefreshScheduled) {
      if (!immediate) return;
      previewRefreshScheduleToken += 1;
      if (previewRefreshHandle && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(previewRefreshHandle);
      } else if (previewRefreshHandle) {
        window.clearTimeout(previewRefreshHandle);
      }
      previewRefreshHandle = 0;
      previewRefreshScheduled = false;
    }
    const scheduleToken = ++previewRefreshScheduleToken;
    const run = async () => {
      if (scheduleToken !== previewRefreshScheduleToken) return;
      previewRefreshScheduled = false;
      previewRefreshHandle = 0;
      if (previewRefreshRunning) return;
      previewRefreshRunning = true;
      let observedRevision = -1;
      try {
        while (container.isConnected && observedRevision !== previewRefreshRevision) {
          observedRevision = previewRefreshRevision;
          const shouldMaintain = previewMaintenancePending;
          previewMaintenancePending = false;
          if (shouldMaintain) {
            const restoredPrivateChatIds = await restoreArchivedOfflinePrivateChats(user.id, chats).catch(() => []);
            restoredPrivateChatIds.forEach((restoredChatId) => {
              invalidateKeepAlive('chat/thread', { chatId: restoredChatId });
            });
            await collapseDuplicateEmptyPrivateChats(user.id).catch(() => []);
          }
          const inbox = await loadVisibleInboxChats();
          await Promise.all(inbox.map((chat) => {
            if (rows.find((row) => row.chat.id === chat.id)?.streaming) return null;
            return recalcChatPreview(chat.id).catch(() => null);
          }));
          const fresh = sortChatsForInbox(await loadVisibleInboxChats());
          rows = await buildRows(fresh);
          if (container.isConnected) paint();
        }
      } finally {
        previewRefreshRunning = false;
        if (container.isConnected && observedRevision !== previewRefreshRevision) {
          schedulePreviewRefresh({ immediate: true });
        }
      }
    };
    // 恢复页面/角色头像昵称变更后想尽快看到结果，不等 idle 回调（最长 1.2s 的可感知延迟）。
    if (immediate) {
      previewRefreshScheduled = true;
      Promise.resolve().then(() => { run().catch(() => null); });
    } else if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      previewRefreshScheduled = true;
      previewRefreshHandle = window.requestIdleCallback(() => { run().catch(() => null); }, { timeout: 1200 });
    } else {
      previewRefreshScheduled = true;
      previewRefreshHandle = window.setTimeout(() => { run().catch(() => null); }, 180);
    }
  }

  function scheduleInboxRefresh() {
    inboxRefreshRevision += 1;
    if (inboxRefreshScheduled) return;
    inboxRefreshScheduled = true;
    Promise.resolve().then(async () => {
      try {
        let observedRevision = -1;
        while (container.isConnected && observedRevision !== inboxRefreshRevision) {
          observedRevision = inboxRefreshRevision;
          const fresh = sortChatsForInbox(await loadVisibleInboxChats());
          rows = await buildRows(fresh);
          if (container.isConnected) paint();
        }
      } finally {
        inboxRefreshScheduled = false;
        if (container.isConnected && inboxRefreshRevision > 0) {
          const settledRevision = inboxRefreshRevision;
          Promise.resolve().then(() => {
            if (!inboxRefreshScheduled && inboxRefreshRevision !== settledRevision) scheduleInboxRefresh();
          });
        }
      }
    }).catch(() => {
      inboxRefreshScheduled = false;
    });
  }

  function closeModal() {
    modalOpen = false;
    modalView = 'pick';
    groupStep = 'pick';
    groupSelected = new Set();
    groupName = '';
    includeSelf = true;
    ownerId = 'user';
    privateSearchQuery = '';
    groupSearchQuery = '';
    activeGroupFilter = ALL_GROUPS_FILTER;
    paint();
  }

  async function openModal() {
    modalOpen = true;
    modalView = 'pick';
    groupStep = 'pick';
    privateSearchQuery = '';
    groupSearchQuery = '';
    activeGroupFilter = ALL_GROUPS_FILTER;
    await loadCharacters({ force: true });
    paint();
  }

  function bindStatic() {
    const refreshRowsAfterAction = async () => {
      const fresh = sortChatsForInbox(await loadVisibleInboxChats());
      rows = await buildRows(fresh);
      if (container.isConnected) paint();
    };
    const togglePinnedRow = async (chatId, wasPinned) => {
      await toggleChatPinned(chatId);
      showToast(wasPinned ? '已取消置顶' : '已置顶');
      await refreshRowsAfterAction();
    };
    const deleteChatRow = async (chatId) => {
      await deleteChatWithData(chatId, user.id);
      invalidateKeepAlive('chat/thread', { chatId });
      showToast('会话已删除');
      await refreshRowsAfterAction();
    };
    const inboxSearch = container.querySelector('[data-chat-hub-search]');
    container.querySelector('.chat-hub-wechat-search')?.addEventListener('click', () => {
      const shell = inboxSearch?.closest('.chat-hub-platform-search');
      if (!shell || !inboxSearch) return;
      shell.hidden = !shell.hidden;
      if (!shell.hidden) inboxSearch.focus({ preventScroll: true });
      else {
        inboxSearch.value = '';
        inboxSearch.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    inboxSearch?.addEventListener('input', () => {
      const query = String(inboxSearch.value || '').trim().toLocaleLowerCase('zh-CN');
      container.querySelectorAll('[data-chat-search-text]').forEach((row) => {
        const haystack = String(row.getAttribute('data-chat-search-text') || '').toLocaleLowerCase('zh-CN');
        row.hidden = !!query && !haystack.includes(query);
      });
    });
    container.querySelector('.chat-hub-aliases')?.addEventListener('click', () => navigate('chat/aliases'));
    container.querySelector('[data-open-linked-accounts]')?.addEventListener('click', () => {
      container.querySelector('[data-hub-user-drawer-open]')?.click();
    });
    container.querySelector('[data-chat-aggregate="groups"]')?.addEventListener('click', () => navigate('chat/backstage'));
    container.querySelector('[data-chat-aggregate="strangers"]')?.addEventListener('click', async () => {
      // 聚合入口统计所有用户身份；打开时同步到最新一封实际投递的身份，
      // 但路由本身不能再等待或依赖旧档里的身份映射，否则一笔异常映射就会把整次点击吞掉。
      let targetAccountId = '';
      try {
        const latestIntercept = findLatestInterceptRow();
        targetAccountId = resolveStrangerThreadUserAccountId(latestIntercept?.chat, user.id);
      } catch (_) {}
      if (targetAccountId) {
        await saveUserInterceptSettings(user.id, { activeAccountId: targetAccountId }).catch(() => {});
        // 已缓存的陌生消息页可能仍停留在旧身份；只在目标身份改变时丢弃旧页。
        invalidateKeepAlive('chat/intercepts');
      }
      navigate('chat/intercepts', targetAccountId ? { accountId: targetAccountId } : {}, true);
    });
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-return-offline]')?.addEventListener('click', () => {
      invalidateKeepAlive('offline', { chatId: offlineChatId });
      invalidateOfflinePresenceKeepAlive(offlineChatId);
      navigateDismissing('offline', { chatId: offlineChatId }, {
        dismissPaths: ['chat', 'chat/thread', 'chat/details'],
        matchChatId: false,
      });
    });
    container.querySelector('.chat-hub-new')?.addEventListener('click', () => {
      openModal().catch((err) => showToast(String(err?.message || err)));
    });
    container.querySelector('[data-toggle-encounter-groups]')?.addEventListener('click', () => {
      encounterGroupsCollapsed = !encounterGroupsCollapsed;
      writeEncounterGroupsCollapsed(encounterGroupsCollapsed);
      paint();
    });
    if (hubInsChrome) {
      bindChatHubInsTabs(container, 'messages');
      bindChatHubUserCard(container, user, {
        onSlotChanged: async () => {
          const [freshInbox, freshMomentsUnread] = await Promise.all([
            loadVisibleInboxChats(),
            hasUnreadMoments(user.id).catch(() => false),
          ]);
          const fresh = sortChatsForInbox(freshInbox);
          momentsUnread = freshMomentsUnread === true;
          rows = await buildRows(fresh);
          if (container.isConnected) paint();
        },
      });
    } else {
      container.querySelectorAll('.chat-hub-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          const next = btn.getAttribute('data-tab');
          if (next === 'messages') return;
          navigate(next === 'moments' ? 'chat/moments' : next === 'intercepts' ? 'chat/intercepts' : 'chat/backstage', {}, true);
        });
      });
    }
    if (chatPlatform === 'qq' || chatPlatform === 'wechat') {
      const swipeRoot = container.querySelector('.chat-hub-scroll');
      bindSwipeActions(swipeRoot, { threshold: 34 });
      swipeRoot?.querySelectorAll('[data-chat-swipe-pin]').forEach((btn) => {
        btn.addEventListener('click', async (event) => {
          event.stopPropagation();
          const chatId = btn.getAttribute('data-swipe-chat-id');
          const row = rows.find((item) => item.chat.id === chatId);
          if (!chatId || !row) return;
          await togglePinnedRow(chatId, !!row.chat.pinned);
        });
      });
      swipeRoot?.querySelectorAll('[data-chat-swipe-delete]').forEach((btn) => {
        btn.addEventListener('click', async (event) => {
          event.stopPropagation();
          const chatId = btn.getAttribute('data-swipe-chat-id');
          const row = rows.find((item) => item.chat.id === chatId);
          if (!chatId || !row) return;
          if (!window.confirm(`删除「${row.title}」？聊天记录与相关记忆会一并删除。`)) return;
          await deleteChatRow(chatId);
        });
      });
    }
    container.querySelectorAll('[data-chat-id]').forEach((btn) => {
      btn.addEventListener('pointerdown', () => {
        const chatId = String(btn.getAttribute('data-chat-id') || '').trim();
        if (chatId) prefetchRoute('chat/thread', { chatId });
      });
      btn.addEventListener('click', () => {
        const chatId = btn.getAttribute('data-chat-id');
        const row = rows.find((r) => r.chat.id === chatId);
        if (row && isAnonymousChat(row.chat)) {
          showToast('匿名会话请从匿名聊天室进入');
          rows = rows.filter((r) => !isAnonymousChat(r.chat));
          paint();
          return;
        }
        if (chatId) {
          if (row?.unread) {
            row.unread = 0;
            row.chat.unread = 0;
            btn.querySelector('.chat-list-unread')?.remove();
            void clearChatUnread(chatId).catch(() => scheduleInboxRefresh());
          }
          if (offlineChatId) invalidateKeepAlive('chat/thread', { chatId });
          if (shoppingDraft || shoppingShare) invalidateKeepAlive('chat/thread', { chatId });
          navigate('chat/thread', {
            chatId,
            entry: 'list',
            ...(shoppingDraft ? { draft: shoppingDraft } : {}),
            ...(shoppingShare ? { shoppingShare } : {}),
            ...(offlineChatId ? { offlineChatId } : {}),
          });
        }
      });
      bindLongPress(btn, () => {
        const chatId = btn.getAttribute('data-chat-id');
        const row = rows.find((r) => r.chat.id === chatId);
        if (!row) return;
        openChatRowSheet({
          chatTitle: row.title,
          pinned: !!row.chat.pinned,
          onTogglePin: async () => {
            await togglePinnedRow(chatId, !!row.chat.pinned);
          },
          onDelete: async () => {
            await deleteChatRow(chatId);
          },
        });
      }, 550);
    });
  }

  function bindModal() {
    container.querySelector('.chat-new-modal-backdrop')?.addEventListener('click', closeModal);
    container.querySelector('.chat-new-modal-close')?.addEventListener('click', closeModal);
    container.querySelector('.chat-new-open-group')?.addEventListener('click', () => {
      modalView = 'group';
      groupStep = 'pick';
      paint();
    });
    container.querySelector('.chat-new-modal-back')?.addEventListener('click', () => {
      modalView = 'pick';
      groupStep = 'pick';
      paint();
    });
    container.querySelector('.chat-new-group-settings-back')?.addEventListener('click', () => {
      groupStep = 'pick';
      paint();
    });
    container.querySelector('.chat-new-member-summary')?.addEventListener('click', () => {
      groupStep = 'pick';
      paint();
    });

    container.querySelector('.chat-new-group-name')?.addEventListener('input', (e) => {
      groupName = String(e.target.value || '');
    });
    container.querySelector('.chat-new-include-self')?.addEventListener('change', (e) => {
      includeSelf = !!e.target.checked;
      if (!includeSelf && ownerId === 'user') ownerId = [...groupSelected][0] || '';
      if (includeSelf && !ownerId) ownerId = 'user';
      paint();
    });
    container.querySelector('.chat-new-owner-select')?.addEventListener('change', (e) => {
      ownerId = String(e.target.value || '').trim() || (includeSelf ? 'user' : '');
    });
    container.querySelector('.chat-new-group-create')?.addEventListener('click', async () => {
      const minSelected = includeSelf ? 1 : 2;
      if (groupSelected.size < minSelected) {
        showToast(includeSelf ? '请至少选择 1 位角色' : '旁观群聊至少选择 2 位角色');
        return;
      }
      try {
        const chat = await createGroupChat(user.id, [...groupSelected], groupName, { includeSelf, ownerId });
        closeModal();
        navigate('chat/thread', { chatId: chat.id, entry: 'list' });
      } catch (err) {
        showToast(String(err?.message || err));
      }
    });
    bindCommitSearch({
      input: container.querySelector('.chat-new-private-search'),
      trigger: container.querySelector('[data-private-search-submit]'),
      onCommit: (value) => {
        privateSearchQuery = value;
        paintPrivateDynamic();
      },
    });
    bindCommitSearch({
      input: container.querySelector('.chat-new-group-search'),
      trigger: container.querySelector('[data-group-search-submit]'),
      onCommit: (value) => {
        groupSearchQuery = value;
        paintGroupDynamic();
      },
    });
    if (modalView === 'group' && groupStep === 'pick') bindGroupDynamic();
    if (modalView === 'pick') bindPrivateDynamic();
  }

  function bindPrivateRows() {
    container.querySelectorAll('.chat-new-contact-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const id = String(row.getAttribute('data-id') || '').trim();
        if (!id) return;
        const char = characters.find((c) => c.id === id);
        try {
          const chat = await ensurePrivateChat(user.id, id, char?.name || '');
          closeModal();
          if (shoppingDraft || shoppingShare) invalidateKeepAlive('chat/thread', { chatId: chat.id });
          navigate('chat/thread', { chatId: chat.id, entry: 'list', ...(shoppingDraft ? { draft: shoppingDraft } : {}), ...(shoppingShare ? { shoppingShare } : {}) });
        } catch (err) {
          showToast(String(err?.message || err));
        }
      });
    });
  }

  paint();
  container.querySelector('main')?.removeAttribute('aria-busy');
  // 空会话去重、线下归档恢复、秘密基地邀请与预览校准都属于维护/补充信息，
  // 合并为首屏后的同一轮 idle 对账，避免两套任务重复读取并重画聊天列表。
  schedulePreviewRefresh({ performMaintenance: true });

  subscribeChatStreamSession(async () => {
    if (!container.isConnected) return;
    typingRefreshSeq += 1;
    const fresh = sortChatsForInbox(await loadVisibleInboxChats());
    rows = await buildRows(fresh);
    const scroll = container.querySelector('.chat-hub-scroll');
    if (!scroll) return;
    for (const row of rows) {
      const btn = scroll.querySelector(`[data-chat-id="${CSS.escape(row.chat.id)}"]`);
      if (!btn) continue;
      const previewEl = btn.querySelector('.chat-list-preview');
      if (previewEl) previewEl.textContent = row.preview.slice(0, 48);
      btn.classList.toggle('is-streaming', !!row.streaming);
    }
  });

  async function refreshTypingRows() {
    if (!container.isConnected) return;
    const scroll = container.querySelector('.chat-hub-scroll');
    if (!scroll) return;
    const seq = ++typingRefreshSeq;
    const snapshot = rows.map((row) => ({ chatId: row.chat.id }));
    const states = await Promise.all(snapshot.map(async ({ chatId }) => ({
      chatId,
      typing: await isChatTyping(chatId),
    })));
    if (seq !== typingRefreshSeq || !container.isConnected) return;
    states.forEach(({ chatId, typing }) => {
      const row = rows.find((candidate) => candidate.chat.id === chatId);
      if (!row) return;
      if (typing === row.streaming) return;
      row.streaming = typing;
      row.preview = typing
        ? CHAT_STREAM_PREVIEW
        : (String(row.chat.lastMessage || '').trim() || '暂无消息');
      const btn = scroll.querySelector(`[data-chat-id="${CSS.escape(row.chat.id)}"]`);
      if (!btn) return;
      btn.classList.toggle('is-streaming', typing);
      const previewEl = btn.querySelector('.chat-list-preview');
      if (previewEl) previewEl.textContent = row.preview.slice(0, 48);
    });
  }

  window.addEventListener('headless-chat-reply-state', () => {
    if (!container.isConnected) return;
    void refreshTypingRows();
  });

  // 云端生成没有本页内存事件；列表存活期间轻量复核。多数会话没有云端 revision，
  // getCloudChatTypingHint 会本地快速返回，不会逐行请求远端。
  const scheduleTypingRefresh = () => {
    setTimeout(async () => {
      if (!container.isConnected) return;
      await refreshTypingRows().catch(() => {});
      scheduleTypingRefresh();
    }, 4000);
  };
  scheduleTypingRefresh();

  window.addEventListener('marshmallow-route-activated', (ev) => {
    const detail = ev.detail || {};
    if (!detail.resumed || detail.container !== container || detail.path !== 'chat') return;
    void reconcileOfflinePresenceBar();
    schedulePreviewRefresh({ immediate: true });
    void refreshTypingRows();
  });

  // 头像/备注在通讯录、聊天详情页改完回列表时，头像和标题不用等到下次整页刷新才更新。
  onStoreWrite('characters', () => {
    if (!container.isConnected) return;
    charactersLoaded = false;
    if (modalOpen) {
      loadCharacters({ force: true })
        .then(() => { if (container.isConnected && modalOpen) paint(); })
        .catch(() => null);
    }
    schedulePreviewRefresh({ immediate: true });
  });
  onStoreWrite('chats', () => {
    if (!container.isConnected) return;
    scheduleInboxRefresh();
  });
  // 消息先耐久落库、会话预览随后更新。直接监听 messages 并主动校准预览，
  // 避免 chats 写入排队或后台任务结束事件晚到时列表一直停在旧消息。
  onStoreWrite('messages', () => {
    if (!container.isConnected) return;
    schedulePreviewRefresh({ immediate: true });
  });
  onStoreWrite('settings', (key) => {
    if (!container.isConnected) return;
    if (offlineChatId && String(key || '') === offlineSessionKey(offlineChatId)) {
      void reconcileOfflinePresenceBar();
      return;
    }
    if (!String(key || '').startsWith('chatPrefs_')) return;
    schedulePreviewRefresh({ immediate: true });
  });
}
