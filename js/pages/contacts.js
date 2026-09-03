import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { bindSwipeActions } from '../components/swipe-actions.js';
import { showToast } from '../components/toast.js';
import * as db from '../core/db.js';
import { listCharacters, saveCharacter } from '../core/character-store.js';
import { normalizeDialNumber } from '../models/character.js';
import {
  hasActiveIdentityBinding,
  identityBindingSelectsCharacter,
  normalizeIdentityBinding,
} from '../models/user.js';
import {
  loadContactGroupsConfig,
  createContactGroup,
  renameContactGroup,
  deleteContactGroup,
  moveCharactersToGroup,
  getGroupLabel,
  resolveCharacterGroupId,
  setGroupCollapsed,
  setGroupMutualAcquaintance,
  ALL_GROUPS_FILTER,
  DEFAULT_GROUP_ID,
} from '../core/contact-groups.js';
import { loadContactFavorites, toggleContactFavorite } from '../core/contact-favorites.js';
import { ANON_NPC_GROUP_ID, isAnonymousNpcCharacter } from '../core/anonymous-npc.js';
import { ensureDefaultUser, getUserById } from '../core/user-slot.js';
import { ensurePrivateChat, listChatsForUser } from '../core/chat-store.js';
import { deleteCharacterCascade } from '../core/data-hygiene.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { openVoiceCallRecordModal } from '../components/voice-call-modal.js';
import { loadAppearancePrefs, getActiveTheme, isWindowHomeTheme, isSeaHomeTheme } from '../core/appearance-prefs.js';
import { bindCommitSearch } from '../components/search-field.js';
import { captureMediaGesture, storePendingMediaGesture } from '../core/media-playback.js';
import { listAllWorldBookRows, listWorldBookRootOptions } from '../core/world-book-store.js';
import { generateCharacterBatch } from '../core/profile-ai-generation.js';
import { openCharacterBatchGeneratorModal } from '../components/character-batch-generator-modal.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../components/image-crop-modal.js';
import {
  clearCustomDefaultAvatar,
  getCustomDefaultAvatar,
  getDefaultAvatarStyle,
  listDefaultAvatarStyles,
  setCustomDefaultAvatar,
  setDefaultAvatarStyle,
} from '../core/default-avatar.js';

/* ── 拨号 App 风格通讯录 ── */

const FAV_SECTION_ID = '__fav__';

const TABS = [
  { id: 'contacts', label: '通讯录', title: '通讯录', icon: 'tabContacts' },
  { id: 'network', label: '关系网', title: '人物关系网', icon: 'tabNetwork' },
  { id: 'recents', label: '最近', title: '通话记录', icon: 'tabClock' },
  { id: 'keypad', label: '拨号', title: '拨号', icon: 'tabKeypad' },
];

const DIAL_ICONS = {
  tabContacts: '<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.4" stroke="currentColor" stroke-width="2"/><path d="M3.5 19c0-3.1 2.6-5 5.5-5s5.5 1.9 5.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 14.4c2.2.5 3.5 1.9 3.5 4.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  tabNetwork: '<svg viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.4" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="7" r="2.4" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="18" r="2.4" stroke="currentColor" stroke-width="2"/><path d="M8.2 6.6l7.4.9M7.4 8l4 8M16.2 9l-3.6 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  tabClock: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="2"/><path d="M12 7.6V12l3 1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tabKeypad: '<svg viewBox="0 0 24 24" fill="none"><circle cx="7" cy="7" r="1.4" fill="currentColor"/><circle cx="12" cy="7" r="1.4" fill="currentColor"/><circle cx="17" cy="7" r="1.4" fill="currentColor"/><circle cx="7" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="17" cy="12" r="1.4" fill="currentColor"/><circle cx="7" cy="17" r="1.4" fill="currentColor"/><circle cx="12" cy="17" r="1.4" fill="currentColor"/><circle cx="17" cy="17" r="1.4" fill="currentColor"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none"><path d="M6.6 4.8c.6-.6 1.6-.5 2.2.2l1.4 1.7c.5.6.4 1.5-.2 2l-1 1a12 12 0 0 0 5.1 5.1l1-1c.5-.6 1.4-.7 2-.2l1.7 1.4c.7.6.8 1.6.2 2.2l-1.3 1.3c-1 .9-2.4 1-3.6.3a14 14 0 0 1-8.4-8.4c-.7-1.2-.6-2.6.3-3.6z" fill="currentColor"/></svg>',
  callIn: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 4.8c.6-.6 1.6-.5 2.2.2l1.3 1.6c.5.6.4 1.5-.2 2l-.9.9a12 12 0 0 0 5 5l.9-.9c.5-.6 1.4-.6 2-.2l1.6 1.3c.7.6.8 1.6.2 2.2l-1.2 1.2c-1 .9-2.3 1-3.5.3a14 14 0 0 1-8.2-8.2c-.7-1.2-.6-2.5.3-3.5z" fill="currentColor"/><path d="M14 4l5 5m0-5v5h-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  callOut: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 4.8c.6-.6 1.6-.5 2.2.2l1.3 1.6c.5.6.4 1.5-.2 2l-.9.9a12 12 0 0 0 5 5l.9-.9c.5-.6 1.4-.6 2-.2l1.6 1.3c.7.6.8 1.6.2 2.2l-1.2 1.2c-1 .9-2.3 1-3.5.3a14 14 0 0 1-8.2-8.2c-.7-1.2-.6-2.5.3-3.5z" fill="currentColor"/><path d="M19 4l-5 5m5-5v5h-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  backspace: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 10l4 4m0-4l-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  callPhone: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const KEYPAD_KEY_TONES = ['pink', 'blue', 'peach', 'blue', 'peach', 'pink', 'peach', 'pink', 'blue', 'pink', 'blue', 'peach'];

const DIALER_PAD_DECO = `
  <svg class="dialer-deco dialer-deco-star" viewBox="0 0 100 100" aria-hidden="true"><path d="M50 10 Q50 50 90 50 Q50 50 50 90 Q50 50 10 50 Q50 50 50 10" fill="#f1b98f"/></svg>
  <svg class="dialer-deco dialer-deco-cloud" viewBox="0 0 100 100" aria-hidden="true"><path d="M30 50 Q30 30 50 30 Q60 30 65 40 Q80 40 80 55 Q80 70 65 70 L35 70 Q20 70 20 55 Q20 50 30 50" fill="#dcedf6"/></svg>
`;

function dialIcon(name, className = '') {
  const svg = DIAL_ICONS[name] || DIAL_ICONS.tabContacts;
  const cls = ['dialer-glyph', className].filter(Boolean).join(' ');
  return `<span class="${cls}">${svg}</span>`;
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function charSearchText(char) {
  return [
    char.name,
    char.realName,
    char.customNickname,
    char.currentRole,
    char.dialNumber,
    ...(Array.isArray(char.aliases) ? char.aliases : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function charDialNumber(char) {
  return normalizeDialNumber(char.dialNumber);
}

function isDialDigitsOnly(value) {
  const raw = String(value || '').trim();
  return !!raw && /^[0-9*#+]+$/.test(raw);
}

function counterpartOfChat(chat) {
  if (!chat || chat.type === 'group') return '';
  const list = Array.isArray(chat.participants) ? chat.participants : [];
  if (!list.includes('user')) return '';
  return list.find((p) => p && p !== 'user') || '';
}

const CALL_STATE_META = {
  outgoing: { label: '已拨出', icon: 'callOut', miss: false },
  cancelled: { label: '已取消', icon: 'callOut', miss: true },
  active: { label: '通话中', icon: 'callIn', miss: false },
  ended: { label: '已接通', icon: 'callIn', miss: false },
  incoming: { label: '来电', icon: 'callIn', miss: false },
  declined: { label: '已拒接', icon: 'callIn', miss: true },
  missed: { label: '未接', icon: 'callIn', miss: true },
};

function relTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const now = Date.now();
  const diff = now - t;
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff < 60 * 1000) return '刚刚';
  const oneDay = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (t >= startOfToday) return hm;
  if (t >= startOfToday - oneDay) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

async function loadContactsData(user, { identityScope = false } = {}) {
  const [characters, groupConfig, favConfig] = await Promise.all([
    identityScope ? listCharacters({ userId: user.id }) : listCharacters(),
    loadContactGroupsConfig(),
    loadContactFavorites(),
  ]);
  const chats = await listChatsForUser(user.id).catch(() => []);
  const charById = new Map(characters.map((c) => [c.id, c]));
  return { characters, groupConfig, favConfig, chats, charById };
}

function hasExplicitIdentityScopeParams(params = {}) {
  return !!String(
    params.groupIds || params.groupId || params.characterIds || params.characterId || params.excludedCharacterIds || '',
  ).trim();
}

function scopeContactsData(data, user, params = {}) {
  if (String(params.scope || '') !== 'identity') return data;
  const binding = normalizeIdentityBinding(user?.identityBinding);
  const hasExplicitScope = hasExplicitIdentityScopeParams(params);
  if (!hasExplicitScope && !hasActiveIdentityBinding(binding)) return data;
  const requestedGroupIds = [...new Set([
    ...String(params.groupIds || '').split(','),
    params.groupId,
    ...binding.groupIds,
  ].map((id) => String(id || '').trim()).filter(Boolean))];
  const requestedCharacterIds = [...new Set([
    ...String(params.characterIds || '').split(','),
    params.characterId,
    ...binding.characterIds,
  ].map((id) => String(id || '').trim()).filter(Boolean))];
  const excludedCharacterIds = [...new Set([
    ...String(params.excludedCharacterIds || '').split(','),
    ...binding.excludedCharacterIds,
  ].map((id) => String(id || '').trim()).filter(Boolean))];
  // 失效的旧绑定也不能把通讯录筛成空白。
  if (!requestedGroupIds.length && !requestedCharacterIds.length) return data;
  const requestedBinding = normalizeIdentityBinding({
    groupIds: requestedGroupIds,
    characterIds: requestedCharacterIds,
    excludedCharacterIds,
  });
  const characters = (data.characters || []).filter((character) => {
    return identityBindingSelectsCharacter(requestedBinding, {
      ...character,
      groupId: resolveCharacterGroupId(character),
    });
  });
  const visibleIds = new Set(characters.map((character) => character.id));
  const chats = (data.chats || []).filter((chat) => (
    (chat?.participants || []).some((id) => visibleIds.has(id))
  ));
  return {
    ...data,
    characters,
    chats,
    charById: new Map(characters.map((character) => [character.id, character])),
  };
}

// 通话记录：扫描所有 voiceCall 消息，聊天记录多时这一步很贵——不在初始进页就做，
// 只有真的切到「最近」标签才按需扫一次，避免默认停在通讯录标签也要为它买单。
async function computeCallRecords(chats, charById) {
  let callRecords = [];
  try {
    const allMsgs = await db.getAllRecords('messages');
    const chatMap = new Map(chats.map((c) => [c.id, c]));
    const chatIds = new Set(chats.map((c) => c.id));
    const records = [];
    for (const m of (Array.isArray(allMsgs) ? allMsgs : [])) {
      if (!m || m.type !== 'voiceCall' || m.deleted) continue;
      if (!chatIds.has(m.chatId)) continue;
      const rec = (m.metadata && m.metadata.voiceCallRecord) || {};
      const chat = chatMap.get(m.chatId);
      const counterpartId = rec.counterpartId || counterpartOfChat(chat);
      const char = counterpartId ? charById.get(counterpartId) : null;
      const name = rec.counterpartName || char?.name || chat?.groupSettings?.name || '语音通话';
      const callState = String(rec.callState || m.metadata?.callState || m.metadata?.state || 'ended');
      records.push({
        id: m.id,
        chatId: m.chatId,
        counterpartId,
        char,
        name,
        ts: Number(rec.endedAt || rec.startedAt || m.timestamp || 0),
        callState,
        callMode: String(rec.callMode || m.metadata?.callMode || '').trim() === 'video' ? 'video' : 'voice',
        duration: rec.duration || m.metadata?.duration || '',
        record: m.metadata?.voiceCallRecord || {
          messageId: m.id,
          chatId: m.chatId,
          counterpartId,
          counterpartName: name,
          callState,
          callMode: String(m.metadata?.callMode || '').trim() === 'video' ? 'video' : 'voice',
          duration: m.metadata?.duration || '',
          durationMs: Number(m.metadata?.durationMs || 0) || 0,
          startedAt: m.metadata?.acceptedAt || m.timestamp || 0,
          transcript: String(m.metadata?.transcript || m.metadata?.callSummary || '').trim(),
          entries: Array.isArray(m.metadata?.callEntries)
            ? m.metadata.callEntries.map((entry) => ({ ...entry }))
            : [],
        },
      });
    }
    records.sort((a, b) => b.ts - a.ts);
    callRecords = records.slice(0, 80);
  } catch (_) {
    callRecords = [];
  }
  return callRecords;
}

export default async function render(container, params = {}) {
  const [currentUser, prefs] = await Promise.all([
    ensureDefaultUser(),
    loadAppearancePrefs().catch(() => null),
  ]);
  const requestedIdentityUserId = String(params.identityUserId || '').trim();
  const requestedIdentityUser = requestedIdentityUserId
    && requestedIdentityUserId !== String(currentUser?.id || '')
    ? await getUserById(requestedIdentityUserId).catch(() => null)
    : currentUser;
  const identityRequested = String(params.scope || '') === 'identity';
  if (identityRequested && !requestedIdentityUser?.id) {
    container.className = 'page scrapbook-page';
    container.innerHTML = `<header class="navbar"><button type="button" class="navbar-btn identity-scope-back" aria-label="返回">${icon('back')}</button><h1 class="navbar-title">档位通讯录</h1><span class="navbar-btn" aria-hidden="true"></span></header><div class="placeholder-page"><div class="placeholder-text">目标档位已不可用，请返回后重新进入</div></div>`;
    container.querySelector('.identity-scope-back')?.addEventListener('click', () => back());
    return;
  }
  const identityScope = identityRequested;
  let user = identityScope ? requestedIdentityUser : currentUser;
  const identityRouteParams = identityScope
    ? { scope: 'identity', identityUserId: String(user.id) }
    : {};
  let { characters, groupConfig, favConfig, chats, charById } = scopeContactsData(
    await loadContactsData(user, { identityScope }),
    user,
    params,
  );
  let callRecords = [];
  let callRecordsReady = false;
  let callRecordsLoading = null;
  let unbindContactSwipe = () => {};

  function ensureCallRecordsLoaded() {
    if (callRecordsReady || callRecordsLoading) return callRecordsLoading;
    callRecordsLoading = computeCallRecords(chats, charById).then((records) => {
      callRecords = records;
      callRecordsReady = true;
      callRecordsLoading = null;
      if (container.isConnected && state.tab === 'recents') paint(null, { preserveScroll: true });
    }).catch(() => { callRecordsLoading = null; });
    return callRecordsLoading;
  }

  let glassTheme = false;
  try {
    const active = getActiveTheme(prefs);
    glassTheme = isWindowHomeTheme(active.id, active.theme) || isSeaHomeTheme(active.id, active.theme);
  } catch (_) {
    glassTheme = false;
  }

  const requestedGroupId = String(params.groupId || '').trim();
  const initialGroupId = requestedGroupId
    && (groupConfig.groups || []).some((group) => group.id === requestedGroupId)
    ? requestedGroupId
    : ALL_GROUPS_FILTER;
  const state = {
    tab: 'contacts',
    query: '',
    keypadQuery: '',
    groupId: initialGroupId,
    favIds: new Set(favConfig.ids),
    collapsed: new Set(groupConfig.collapsedGroups || []),
    activeRail: '',
    manageMode: false,
    selectedIds: new Set(),
    sheet: null, // null | 'move' | 'groups' | 'avatars'
  };

  container.className = `page dialer-page contacts-page${glassTheme ? ' dialer-page--glass' : ''}`;

  function isPinned(charId) {
    return state.favIds.has(charId);
  }

  async function dialCharacter(charId) {
    const char = charById.get(charId);
    if (!char) return;
    try {
      const chat = await ensurePrivateChat(user.id, charId, char.name || '');
      navigate('chat/thread', { chatId: chat.id, entry: 'list' });
    } catch (err) {
      showToast(String((err && err.message) || err));
    }
  }

  async function startVoiceCallWithCharacter(charId) {
    const char = charById.get(charId);
    if (!char) return;
    try {
      const chat = await ensurePrivateChat(user.id, charId, char.name || '');
      navigate('chat/thread', {
        chatId: chat.id,
        startCall: '1',
        callNonce: String(Date.now()),
      });
    } catch (err) {
      showToast(String((err && err.message) || err));
    }
  }

  // ── 各标签内容 ──
  function renderContactRow(char) {
    const fav = isPinned(char.id);
    const selected = state.selectedIds.has(char.id);
    if (state.manageMode) {
      return `
        <div class="dialer-row dialer-row--select${selected ? ' is-selected' : ''}" data-select="${esc(char.id)}" role="button" tabindex="0" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${esc(char.name || '未命名')} · ${selected ? '取消选择' : '选择'}">
          <span class="dialer-row-check" aria-hidden="true">${selected ? icon('check') : ''}</span>
          <div class="dialer-row-avatar">${characterAvatarHtml(char, { className: 'dialer-avatar-img' })}</div>
          <div class="dialer-row-main dialer-row-main--name-only">
            <div class="dialer-row-name-line">
              <span class="dialer-row-name">${esc(char.name || '未命名')}</span>
            </div>
          </div>
        </div>
      `;
    }
    return `
      <div class="dialer-swipe-row" data-swipe-row>
        <div class="dialer-swipe-actions" data-swipe-actions>
          <button type="button" class="dialer-swipe-action is-call" data-call="${esc(char.id)}">${dialIcon('phone')}<span>拨号</span></button>
          <button type="button" class="dialer-swipe-action is-pin${fav ? ' is-on' : ''}" data-star="${esc(char.id)}"><span>${fav ? '取消置顶' : '置顶'}</span></button>
        </div>
        <div class="dialer-row dialer-swipe-content" data-swipe-content data-open="${esc(char.id)}" role="button" tabindex="0" aria-label="${esc(char.name || '未命名')} · 查看名片">
          <div class="dialer-row-avatar">${characterAvatarHtml(char, { className: 'dialer-avatar-img' })}</div>
          <div class="dialer-row-main dialer-row-main--name-only">
            <div class="dialer-row-name-line">
              <span class="dialer-row-name">${esc(char.name || '未命名')}</span>
            </div>
          </div>
          <button type="button" class="dialer-row-edit" data-edit="${esc(char.id)}" aria-label="编辑">${icon('edit')}</button>
        </div>
      </div>
    `;
  }

  function sortByName(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
  }

  function shortLabel(name) {
    const s = String(name || '').trim();
    return s ? s.slice(0, 1) : '·';
  }

  // 全部视图下的分区模型：置顶 + 各分组（排除匿名 NPC 组；管理模式也显示空分组）
  function visibleSections() {
    const favMembers = characters
      .filter((c) => !isAnonymousNpcCharacter(c) && state.favIds.has(c.id))
      .sort(sortByName);
    const groups = (groupConfig.groups || [])
      .filter((g) => g.id !== ANON_NPC_GROUP_ID)
      .map((g) => ({
        id: g.id,
        name: g.name,
        members: characters.filter((c) => resolveCharacterGroupId(c) === g.id).sort(sortByName),
      }))
      .filter((g) => state.manageMode || g.members.length);
    return { favMembers, groups };
  }

  function manageableGroups() {
    return (groupConfig.groups || []).filter((g) => g.id !== ANON_NPC_GROUP_ID);
  }

  function groupMemberCount(groupId) {
    return characters.filter((c) => resolveCharacterGroupId(c) === groupId).length;
  }

  // 右侧快捷分组滑条的锚点（≥2 个才显示）
  function railItems() {
    if (state.tab !== 'contacts' || state.query.trim() || state.groupId !== ALL_GROUPS_FILTER) return [];
    const { favMembers, groups } = visibleSections();
    const items = [];
    if (favMembers.length) items.push({ id: FAV_SECTION_ID, short: '顶', label: '置顶' });
    for (const g of groups) items.push({ id: g.id, short: shortLabel(g.name), label: g.name });
    return items.length > 1 ? items : [];
  }

  function renderCollapsibleSection(id, title, members, { fav = false } = {}) {
    const collapsed = state.collapsed.has(id);
    const rows = members.map((c) => renderContactRow(c)).join('');
    return `
      <section class="dialer-sec${collapsed ? ' is-collapsed' : ''}${fav ? ' is-fav' : ''}" data-section="${esc(id)}">
        <button type="button" class="dialer-sec-head" data-collapse="${esc(id)}" aria-expanded="${collapsed ? 'false' : 'true'}">
          <span class="dialer-sec-title">${esc(title)}<span class="dialer-sec-count">${members.length}</span></span>
          <span class="dialer-sec-chev">${dialIcon('chev')}</span>
        </button>
        <div class="dialer-sec-body"><div class="dialer-list">${rows}</div></div>
      </section>
    `;
  }

  function renderEmpty(text, sub, actionLabel) {
    return `
      <div class="dialer-empty">
        <div class="dialer-empty-art">${dialIcon('tabContacts')}</div>
        <div class="dialer-empty-text">${esc(text)}</div>
        ${sub ? `<p class="dialer-empty-sub">${esc(sub)}</p>` : ''}
        ${actionLabel ? `<button type="button" class="dialer-empty-btn dialer-new">${esc(actionLabel)}</button>` : ''}
      </div>
    `;
  }

  function renderContactsTab() {
    const q = state.query.trim().toLowerCase();
    const avatarStyles = listDefaultAvatarStyles();
    const selectedAvatarStyle = avatarStyles.find((item) => item.id === getDefaultAvatarStyle())
      || avatarStyles[0];
    const searchBar = `
      <div class="dialer-search-row">
        <div class="dialer-search">
          <button type="button" class="dialer-search-icon search-icon-submit" data-search-submit aria-label="搜索">${icon('search')}</button>
          <input type="search" class="dialer-search-input" placeholder="搜索角色名 / 别名，回车搜索" value="${esc(state.query)}" autocomplete="off" enterkeyhint="search">
          ${state.query ? '<button type="button" class="dialer-search-clear" aria-label="清空">×</button>' : ''}
        </div>
        <button type="button" class="dialer-default-avatar" aria-label="选择默认头像" title="默认头像：${esc(selectedAvatarStyle.label)}"><img src="${esc(selectedAvatarStyle.preview)}" alt=""></button>
      </div>
    `;
    const toolbar = identityScope
      ? `
      <div class="dialer-toolbar dialer-toolbar--identity">
        <button type="button" class="dialer-tool dialer-open-common">通用通讯录</button>
      </div>
    `
      : state.manageMode
      ? `
      <div class="dialer-batch-bar">
        <span class="dialer-batch-count">已选 ${state.selectedIds.size}</span>
        <button type="button" class="dialer-tool dialer-batch-move"${state.selectedIds.size ? '' : ' disabled'}>移到分组</button>
        <button type="button" class="dialer-tool dialer-tool--danger dialer-batch-delete"${state.selectedIds.size ? '' : ' disabled'}>删除</button>
        <button type="button" class="dialer-tool dialer-batch-groups">分组</button>
        <button type="button" class="dialer-tool dialer-batch-done">完成</button>
      </div>
    `
      : `
      <div class="dialer-toolbar">
        <button type="button" class="dialer-tool dialer-new">+ 新建</button>
        <button type="button" class="dialer-tool dialer-ai-batch">AI 批量</button>
        <button type="button" class="dialer-tool dialer-group-new">+ 分组</button>
        <button type="button" class="dialer-tool dialer-manage">管理</button>
        <button type="button" class="dialer-tool dialer-import">导入</button>
        <button type="button" class="dialer-tool dialer-export">导出</button>
      </div>
    `;

    if (q) {
      const searchPool = state.groupId === ANON_NPC_GROUP_ID
        ? characters
        : characters.filter((c) => !isAnonymousNpcCharacter(c));
      const results = searchPool.filter((c) => charSearchText(c).includes(q));
      const body = results.length
        ? `<div class="dialer-list">${results.map((c) => renderContactRow(c)).join('')}</div>`
        : renderEmpty('没有找到匹配的角色', '换个关键词试试，或新建一位角色。', state.manageMode ? '' : '新建一位');
      return `${searchBar}${toolbar}<div class="dialer-section-head">搜索结果 · ${results.length}</div>${body}`;
    }

    if (!characters.length) {
      return identityScope
        ? `${searchBar}${toolbar}${renderEmpty('当前身份还没有绑定通讯录', '回到 Chat 侧栏选择一个主 char 或角色分组。')}`
        : `${searchBar}${toolbar}${renderEmpty('通讯录还是空的', '新建一位角色，或导入本应用导出的角色包 JSON。', state.manageMode ? '' : '写第一位')}`;
    }

    // 置顶分区 + 可折叠分组（右侧滑条做快捷跳转，不再单设顶部分组 chips）
    const { favMembers, groups } = visibleSections();
    const parts = [];
    if (favMembers.length) {
      parts.push(renderCollapsibleSection(FAV_SECTION_ID, '置顶', favMembers, { fav: true }));
    }
    for (const g of groups) {
      parts.push(renderCollapsibleSection(g.id, g.name, g.members));
    }
    const sectionsHtml = parts.length
      ? `<div class="dialer-sections">${parts.join('')}</div>`
      : renderEmpty('还没有分组角色', '新建一位角色，或点「管理」批量移到分组。', state.manageMode ? '' : '写第一位');

    return `${searchBar}${toolbar}${sectionsHtml}`;
  }

  function renderSheet() {
    if (!state.sheet) return '';
    if (state.sheet === 'avatars') {
      const selected = getDefaultAvatarStyle();
      const avatarStyles = listDefaultAvatarStyles();
      const hasCustomAvatar = !!getCustomDefaultAvatar();
      return `
        <div class="dialer-sheet" role="dialog" aria-modal="true" aria-label="选择默认头像">
          <button type="button" class="dialer-sheet-backdrop" data-close-sheet aria-label="关闭"></button>
          <div class="dialer-sheet-panel dialer-avatar-sheet-panel">
            <div class="dialer-sheet-head">
              <h2 class="dialer-sheet-title">默认头像</h2>
              <button type="button" class="dialer-sheet-close" data-close-sheet aria-label="关闭">×</button>
            </div>
            <div class="dialer-avatar-options">
              ${avatarStyles.map((item) => `
                <button type="button" class="dialer-avatar-option${selected === item.id ? ' is-active' : ''}" data-default-avatar-style="${esc(item.id)}">
                  <img src="${esc(item.preview)}" alt="">
                  <span><strong>${esc(item.label)}</strong><small>${esc(item.description)}</small></span>
                  <i aria-hidden="true">${selected === item.id ? '✓' : ''}</i>
                </button>
              `).join('')}
            </div>
            <div class="dialer-avatar-upload-row">
              <label class="dialer-avatar-upload">
                ${hasCustomAvatar ? '替换我的图片' : '上传我的图片'}
                <input type="file" class="default-avatar-file-input" accept="image/*" data-default-avatar-file>
              </label>
              ${hasCustomAvatar ? '<button type="button" class="dialer-avatar-upload dialer-avatar-upload--danger" data-default-avatar-clear>删除自定义</button>' : ''}
            </div>
          </div>
        </div>
      `;
    }
    if (state.sheet === 'move') {
      const groups = manageableGroups();
      const rows = groups.map((g) => {
        const count = groupMemberCount(g.id);
        return `
          <button type="button" class="dialer-sheet-item" data-move-to="${esc(g.id)}">
            <span class="dialer-sheet-item-name">${esc(g.name)}</span>
            <span class="dialer-sheet-item-meta">${count} 人</span>
          </button>
        `;
      }).join('');
      return `
        <div class="dialer-sheet" role="dialog" aria-modal="true" aria-label="移到分组">
          <button type="button" class="dialer-sheet-backdrop" data-close-sheet aria-label="关闭"></button>
          <div class="dialer-sheet-panel">
            <div class="dialer-sheet-head">
              <h2 class="dialer-sheet-title">移到分组</h2>
              <button type="button" class="dialer-sheet-close" data-close-sheet aria-label="关闭">×</button>
            </div>
            <div class="dialer-sheet-list">${rows || '<div class="dialer-sheet-empty">暂无可用分组</div>'}</div>
          </div>
        </div>
      `;
    }
    if (state.sheet === 'groups') {
      const groups = manageableGroups();
      const rows = groups.map((g) => {
        const count = groupMemberCount(g.id);
        const canDelete = g.id !== DEFAULT_GROUP_ID;
        const mutual = canDelete && g.mutualAcquaintance === true;
        return `
          <div class="dialer-sheet-row">
            <div class="dialer-sheet-row-main">
              <span class="dialer-sheet-item-name">${esc(g.name)}</span>
              <span class="dialer-sheet-item-meta">${count} 人${canDelete ? '' : ' · 不可删'}</span>
            </div>
            <button type="button" class="dialer-sheet-edit" data-rename-group="${esc(g.id)}" aria-label="重命名 ${esc(g.name)}">${icon('edit')}</button>
            ${canDelete ? `
              <button type="button" class="dialer-sheet-action" data-toggle-mutual="${esc(g.id)}" aria-pressed="${mutual ? 'true' : 'false'}">
                ${mutual ? '组内互识' : '彼此独立'}
              </button>
            ` : ''}
            ${canDelete ? `<button type="button" class="dialer-sheet-delete" data-delete-group="${esc(g.id)}" aria-label="删除 ${esc(g.name)}">${icon('trash')}</button>` : ''}
          </div>
        `;
      }).join('');
      return `
        <div class="dialer-sheet" role="dialog" aria-modal="true" aria-label="管理分组">
          <button type="button" class="dialer-sheet-backdrop" data-close-sheet aria-label="关闭"></button>
          <div class="dialer-sheet-panel">
            <div class="dialer-sheet-head">
              <h2 class="dialer-sheet-title">管理分组</h2>
              <button type="button" class="dialer-sheet-close" data-close-sheet aria-label="关闭">×</button>
            </div>
            <div class="dialer-sheet-list">${rows || '<div class="dialer-sheet-empty">暂无分组</div>'}</div>
            <div class="dialer-sheet-foot">
              <button type="button" class="dialer-tool dialer-group-new">+ 新建分组</button>
            </div>
          </div>
        </div>
      `;
    }
    return '';
  }

  function renderNetworkTab() {
    return `
      <div class="dialer-empty dialer-net-coming">
        <div class="dialer-empty-art">${dialIcon('tabNetwork')}</div>
        <div class="dialer-empty-text">人物关系网</div>
        <p class="dialer-empty-sub">把角色和简单 NPC 连成全局关系网，建默认小群让绑定角色共享「秘密基地」后台记忆。功能正在搭建中。</p>
      </div>
    `;
  }

  function renderRecentsTab() {
    if (!callRecordsReady) {
      return renderEmpty('正在读取通话记录…', '');
    }
    if (!callRecords.length) {
      return renderEmpty('暂无通话记录', '在聊天里发起语音通话，记录会出现在这里。');
    }
    const rows = callRecords.map((r) => {
      const meta = CALL_STATE_META[r.callState] || CALL_STATE_META.ended;
      const avatar = r.char
        ? characterAvatarHtml(r.char, { className: 'dialer-avatar-img' })
        : `<span class="dialer-avatar-img is-fallback">${dialIcon('phone')}</span>`;
      const info = [meta.label, r.duration].filter(Boolean).join(' · ');
      return `
        <div class="dialer-row dialer-recent${meta.miss ? ' is-miss' : ''}" data-record="${esc(r.id)}">
          <div class="dialer-row-avatar">${avatar}</div>
          <div class="dialer-row-main">
            <div class="dialer-row-name">${esc(r.name)}</div>
            <div class="dialer-row-meta">
              <span class="dialer-recent-icon">${dialIcon(meta.icon)}</span>
              <span class="dialer-row-sub">${esc(info)}</span>
            </div>
          </div>
          <span class="dialer-recent-time">${esc(relTime(r.ts))}</span>
          ${r.counterpartId ? `<button type="button" class="dialer-row-call" data-call="${esc(r.counterpartId)}" aria-label="再次拨打">${dialIcon('phone')}</button>` : ''}
        </div>
      `;
    }).join('');
    return `<div class="dialer-section-head">通话记录 · ${callRecords.length}</div><div class="dialer-list">${rows}</div>`;
  }

  function keypadMatches() {
    const raw = state.keypadQuery;
    const trimmed = raw.trim();
    if (!trimmed) return [];

    const digits = normalizeDialNumber(trimmed);
    if (digits) {
      const byNumber = characters.filter((c) => {
        const dn = charDialNumber(c);
        return dn && dn.startsWith(digits);
      });
      if (byNumber.length) {
        return byNumber.sort((a, b) => {
          const da = charDialNumber(a);
          const db = charDialNumber(b);
          if (da === digits && db !== digits) return -1;
          if (db === digits && da !== digits) return 1;
          return da.length - db.length;
        });
      }
    }

    if (isDialDigitsOnly(trimmed)) return [];

    const q = trimmed.toLowerCase();
    return characters.filter((c) => charSearchText(c).includes(q));
  }

  function renderMatchChip(char) {
    const num = charDialNumber(char);
    return `
      <button type="button" class="dialer-dial-chip" data-dial="${esc(char.id)}">
        <span class="dialer-dial-chip-avatar">${characterAvatarHtml(char, { className: 'dialer-avatar-img' })}</span>
        <span class="dialer-dial-chip-name">${esc(char.name || '未命名')}</span>
        ${num ? `<span class="dialer-dial-chip-num">${esc(num)}</span>` : ''}
      </button>
    `;
  }

  /** 只刷新拨号盘匹配区 / 副标题 / 删除键，不重建读数输入框。 */
  function refreshKeypadChrome() {
    const q = state.keypadQuery;
    const trimmed = q.trim();
    const matches = keypadMatches();
    const digits = normalizeDialNumber(trimmed);
    const matchListClass = matches.length > 4 ? 'dialer-dial-matches is-wide' : 'dialer-dial-matches';
    const matchInner = matches.length
      ? matches.slice(0, 8).map((c) => renderMatchChip(c)).join('')
      : (trimmed ? '<div class="dialer-pad-match-empty">没有匹配的角色</div>' : '');
    const zone = container.querySelector('.dialer-pad-matchzone');
    if (zone) {
      zone.classList.toggle('has-results', !!matchInner);
      zone.innerHTML = matchInner ? `<div class="${matchListClass}">${matchInner}</div>` : '';
      zone.querySelectorAll('[data-dial]').forEach((el) => {
        el.addEventListener('click', () => {
          void dialCharacter(el.getAttribute('data-dial'));
        });
      });
    }
    const screen = container.querySelector('.dialer-pad-screen');
    if (screen) {
      const readoutSub = trimmed
        ? (digits && isDialDigitsOnly(trimmed) ? '匹配编号' : '匹配角色')
        : '';
      let sub = screen.querySelector('.dialer-pad-readout-sub');
      if (readoutSub) {
        if (!sub) {
          sub = document.createElement('div');
          sub.className = 'dialer-pad-readout-sub';
          screen.appendChild(sub);
        }
        sub.textContent = readoutSub;
      } else {
        sub?.remove();
      }
    }
    container.querySelector('.dialer-pad-back')?.classList.toggle('is-hidden', !trimmed);
    container.querySelector('.dialer-dial-call')?.classList.toggle('is-disabled', !matches.length);
  }

  function renderKeypadTab() {
    const q = state.keypadQuery;
    const trimmed = q.trim();
    const matches = keypadMatches();
    const digits = normalizeDialNumber(trimmed);
    const matchListClass = matches.length > 4 ? 'dialer-dial-matches is-wide' : 'dialer-dial-matches';
    const matchInner = matches.length
      ? matches.slice(0, 8).map((c) => renderMatchChip(c)).join('')
      : (trimmed ? '<div class="dialer-pad-match-empty">没有匹配的角色</div>' : '');

    const keys = [
      { n: '1', s: '' }, { n: '2', s: 'ABC' }, { n: '3', s: 'DEF' },
      { n: '4', s: 'GHI' }, { n: '5', s: 'JKL' }, { n: '6', s: 'MNO' },
      { n: '7', s: 'PQRS' }, { n: '8', s: 'TUV' }, { n: '9', s: 'WXYZ' },
      { n: '*', s: '' }, { n: '0', s: '+' }, { n: '#', s: '' },
    ];
    const keysHtml = keys.map((k, i) => `
      <button type="button" class="dialer-key dialer-key--${KEYPAD_KEY_TONES[i]}" data-key="${esc(k.n)}">
        <b>${esc(k.n)}</b>${k.s ? `<i>${esc(k.s)}</i>` : ''}
      </button>
    `).join('');

    const canCall = matches.length > 0;
    const readoutSub = trimmed
      ? (digits && isDialDigitsOnly(trimmed) ? '匹配编号' : '匹配角色')
      : '';
    return `
      <div class="dialer-pad">
        ${DIALER_PAD_DECO}
        <div class="dialer-pad-matchzone${matchInner ? ' has-results' : ''}">
          ${matchInner ? `<div class="${matchListClass}">${matchInner}</div>` : ''}
        </div>
        <div class="dialer-pad-lower">
          <div class="dialer-pad-screen">
            <input type="tel" class="dialer-pad-readout" placeholder=" " value="${esc(q)}" autocomplete="off" inputmode="tel">
            ${readoutSub ? `<div class="dialer-pad-readout-sub">${esc(readoutSub)}</div>` : ''}
          </div>
          <div class="dialer-keys">${keysHtml}</div>
          <div class="dialer-dial-callrow">
            <div class="dialer-dial-callrow-side" aria-hidden="true"></div>
            <button type="button" class="dialer-dial-call${canCall ? '' : ' is-disabled'}" aria-label="拨通">${dialIcon('callPhone')}</button>
            <button type="button" class="dialer-pad-back${trimmed ? '' : ' is-hidden'}" aria-label="删除">${dialIcon('backspace')}</button>
          </div>
        </div>
      </div>
    `;
  }

  function tabBody() {
    if (state.tab === 'network') return renderNetworkTab();
    if (state.tab === 'recents') return renderRecentsTab();
    if (state.tab === 'keypad') return renderKeypadTab();
    return renderContactsTab();
  }

  function renderRail() {
    const items = railItems();
    if (!items.length) return '';
    return `
      <div class="dialer-rail" aria-hidden="true">
        ${items.map((it) => `<button type="button" class="dialer-rail-item${state.activeRail === it.id ? ' is-active' : ''}" data-rail="${esc(it.id)}" title="${esc(it.label)}" tabindex="-1">${esc(it.short)}</button>`).join('')}
      </div>
    `;
  }

  function paint(focusSelector, options = {}) {
    unbindContactSwipe();
    unbindContactSwipe = () => {};
    const preserveScroll = options.preserveScroll === true
      || (options.preserveScroll !== false && state.tab === 'keypad' && !focusSelector);
    const prevBody = preserveScroll ? container.querySelector('.dialer-body') : null;
    const scrollTop = prevBody ? prevBody.scrollTop : 0;

    const activeMeta = TABS.find((t) => t.id === state.tab) || TABS[0];
    const pageTitle = identityScope && state.tab === 'contacts' ? '档位通讯录' : activeMeta.title;
    const railHtml = renderRail();
    container.innerHTML = `
      <header class="navbar dialer-navbar">
        <button type="button" class="navbar-btn dialer-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${esc(pageTitle)}</h1>
        ${identityScope
          ? '<span class="navbar-btn" aria-hidden="true"></span>'
          : `<button type="button" class="navbar-btn dialer-add" aria-label="新建角色">${icon('plus')}</button>`}
      </header>
      <main class="dialer-body${railHtml ? ' has-rail' : ''}" data-tab="${esc(state.tab)}">${tabBody()}</main>
      ${railHtml}
      ${state.tab === 'contacts' ? renderSheet() : ''}
      <nav class="dialer-tabbar" aria-label="拨号导航">
        ${TABS.map((t) => `
          <button type="button" class="dialer-tab${state.tab === t.id ? ' is-active' : ''}" data-tab="${esc(t.id)}">
            ${dialIcon(t.icon)}
            <span class="dialer-tab-label">${esc(t.label)}</span>
          </button>
        `).join('')}
      </nav>
    `;
    bindEvents();

    if (preserveScroll) {
      const body = container.querySelector('.dialer-body');
      if (body) body.scrollTop = scrollTop;
    }

    if (focusSelector) {
      const el = container.querySelector(focusSelector);
      if (el) {
        try {
          el.focus({ preventScroll: true });
        } catch (_) {
          el.focus();
        }
        // 不要用 value='' 再赋回：iOS 中文输入法组合态会被打断，表现为字母重复、无法上屏。
      }
    }
  }

  function setRailActive(id) {
    state.activeRail = id || '';
    container.querySelectorAll('.dialer-rail-item').forEach((el) => {
      el.classList.toggle('is-active', el.getAttribute('data-rail') === state.activeRail);
    });
  }

  function scrollToSection(id) {
    const body = container.querySelector('.dialer-body');
    if (!body || !id) return;
    const el = body.querySelector(`[data-section="${id}"]`);
    if (!el) return;
    const top = body.scrollTop + (el.getBoundingClientRect().top - body.getBoundingClientRect().top) - 6;
    body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    setRailActive(id);
  }

  function syncRailToScroll() {
    const body = container.querySelector('.dialer-body');
    if (!body) return;
    const secs = [...body.querySelectorAll('[data-section]')];
    if (!secs.length) return;
    const bodyTop = body.getBoundingClientRect().top;
    let current = secs[0].getAttribute('data-section');
    for (const s of secs) {
      if (s.getBoundingClientRect().top - bodyTop <= 12) current = s.getAttribute('data-section');
      else break;
    }
    if (current !== state.activeRail) setRailActive(current);
  }

  function bindRail() {
    const rail = container.querySelector('.dialer-rail');
    if (!rail) return;
    const pickFromPoint = (clientY) => {
      const el = document.elementFromPoint(rail.getBoundingClientRect().left + rail.offsetWidth / 2, clientY);
      const item = el && el.closest ? el.closest('.dialer-rail-item') : null;
      return item ? item.getAttribute('data-rail') : '';
    };
    let dragging = false;
    const onMove = (clientY) => {
      const id = pickFromPoint(clientY);
      if (id && id !== state.activeRail) scrollToSection(id);
    };
    rail.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { rail.setPointerCapture(e.pointerId); } catch (_) {}
      const id = e.target.closest?.('.dialer-rail-item')?.getAttribute('data-rail');
      if (id) scrollToSection(id);
      e.preventDefault();
    });
    rail.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      onMove(e.clientY);
      e.preventDefault();
    });
    const stop = (e) => {
      dragging = false;
      try { rail.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    rail.addEventListener('pointerup', stop);
    rail.addEventListener('pointercancel', stop);

    const body = container.querySelector('.dialer-body');
    if (body) {
      body.addEventListener('scroll', syncRailToScroll, { passive: true });
      syncRailToScroll();
    }
  }

  function bindEvents() {
    container.querySelector('.dialer-back')?.addEventListener('click', () => back());
    container.querySelector('.dialer-add')?.addEventListener('click', () => navigate('contacts/edit', { new: '1' }));
    container.querySelector('.dialer-default-avatar')?.addEventListener('click', () => {
      state.sheet = 'avatars';
      paint(null, { preserveScroll: true });
    });
    container.querySelectorAll('[data-default-avatar-style]').forEach((button) => {
      button.addEventListener('click', () => {
        const styleId = setDefaultAvatarStyle(button.getAttribute('data-default-avatar-style'));
        const label = listDefaultAvatarStyles().find((item) => item.id === styleId)?.label || '原款';
        state.sheet = null;
        paint(null, { preserveScroll: true });
        showToast(`默认头像已切换为「${label}」`);
      });
    });
    const defaultAvatarFile = container.querySelector('[data-default-avatar-file]');
    defaultAvatarFile?.addEventListener('change', async () => {
      const file = defaultAvatarFile.files?.[0];
      if (!file) return;
      try {
        const result = await fileToCroppedOptimizedAvatarDataUrl(file, {
          title: '裁剪默认头像',
          outputMaxEdge: 512,
        });
        if (!result?.dataUrl) return;
        setCustomDefaultAvatar(result.dataUrl);
        state.sheet = null;
        paint(null, { preserveScroll: true });
        showToast('已使用上传图片作为默认头像');
      } catch (error) {
        showToast(error?.message || '默认头像处理失败');
      }
    });
    container.querySelector('[data-default-avatar-clear]')?.addEventListener('click', () => {
      clearCustomDefaultAvatar();
      state.sheet = null;
      paint(null, { preserveScroll: true });
      showToast('已删除自定义默认头像');
    });

    container.querySelectorAll('.dialer-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-tab');
        if (id === 'network') {
          navigate('relationship/network', identityRouteParams);
          return;
        }
        if (id && id !== state.tab) {
          state.tab = id;
          state.manageMode = false;
          state.selectedIds = new Set();
          state.sheet = null;
          if (id === 'recents') void ensureCallRecordsLoaded();
          paint();
        }
      });
    });

    // 管理模式：点选角色
    container.querySelectorAll('[data-select]').forEach((el) => {
      const toggle = (e) => {
        e.preventDefault();
        const id = el.getAttribute('data-select');
        if (!id) return;
        if (state.selectedIds.has(id)) state.selectedIds.delete(id);
        else state.selectedIds.add(id);
        paint(null, { preserveScroll: true });
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle(e);
        }
      });
    });

    // 通讯录行：点击展开名片展示页
    container.querySelectorAll('[data-open]').forEach((el) => {
      const openCard = (e) => {
        if (e.target.closest('[data-star]') || e.target.closest('[data-edit]') || e.target.closest('[data-call]')) return;
        navigate('contacts/card', {
          id: el.getAttribute('data-open'),
          ...identityRouteParams,
        });
      };
      el.addEventListener('click', openCard);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openCard(e);
        }
      });
    });

    // 拨号盘匹配项：直接进聊天
    container.querySelectorAll('[data-dial]').forEach((el) => {
      el.addEventListener('click', () => {
        void dialCharacter(el.getAttribute('data-dial'));
      });
    });
    container.querySelectorAll('[data-call]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        storePendingMediaGesture(captureMediaGesture(e));
        void startVoiceCallWithCharacter(btn.getAttribute('data-call'));
      });
    });
    container.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate('contacts/edit', {
          id: btn.getAttribute('data-edit'),
          ...identityRouteParams,
        });
      });
    });
    container.querySelectorAll('[data-star]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-star');
        const next = await toggleContactFavorite(id);
        state.favIds = new Set(next.ids);
        paint(null, { preserveScroll: true });
      });
    });
    if (!state.manageMode && state.tab === 'contacts') {
      unbindContactSwipe = bindSwipeActions(container.querySelector('.dialer-body'), {
        rowSelector: '.dialer-swipe-row',
      });
    }

    // 分组折叠
    container.querySelectorAll('[data-collapse]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-collapse');
        if (!id) return;
        const willCollapse = !state.collapsed.has(id);
        if (willCollapse) state.collapsed.add(id);
        else state.collapsed.delete(id);
        if (id !== FAV_SECTION_ID) void setGroupCollapsed(id, willCollapse).catch(() => {});
        paint(null, { preserveScroll: true });
      });
    });

    // 右侧快捷分组滑条
    bindRail();

    // 通话记录点击
    container.querySelectorAll('[data-record]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-call]')) return;
        const id = row.getAttribute('data-record');
        const rec = callRecords.find((r) => r.id === id);
        if (!rec) return;
        openVoiceCallRecordModal(rec.record || {
          counterpartName: rec.name,
          callState: rec.callState,
          callMode: rec.callMode,
          duration: rec.duration,
          startedAt: rec.ts,
          endedAt: rec.ts,
        });
      });
    });

    // 通讯录搜索：回车/清空才重绘，打字过程绝不重建输入框（否则 iOS IME 会重复字母、打不出中文）
    bindCommitSearch({
      input: container.querySelector('.dialer-search-input'),
      trigger: container.querySelector('[data-search-submit]'),
      onCommit: (value) => {
        const next = String(value || '');
        if (next === state.query) return;
        state.query = next;
        paint(null, { preserveScroll: true });
      },
    });
    container.querySelector('.dialer-search-clear')?.addEventListener('click', () => {
      state.query = '';
      paint(null, { preserveScroll: true });
    });

    // 拨号盘读数：只刷新匹配区，不重建输入框
    const padInput = container.querySelector('.dialer-pad-readout');
    if (padInput) {
      padInput.addEventListener('input', () => {
        const cleaned = String(padInput.value || '').replace(/[^\d*#+]/g, '');
        if (cleaned !== padInput.value) padInput.value = cleaned;
        state.keypadQuery = cleaned;
        refreshKeypadChrome();
      });
    }
    container.querySelector('.dialer-pad-back')?.addEventListener('mousedown', (e) => e.preventDefault());
    container.querySelector('.dialer-pad-back')?.addEventListener('click', () => {
      state.keypadQuery = state.keypadQuery.slice(0, -1);
      const input = container.querySelector('.dialer-pad-readout');
      if (input) input.value = state.keypadQuery;
      refreshKeypadChrome();
    });
    container.querySelectorAll('.dialer-key').forEach((key) => {
      key.addEventListener('mousedown', (e) => e.preventDefault());
      key.addEventListener('click', () => {
        const val = key.getAttribute('data-key') || '';
        if (!val) return;
        if (state.keypadQuery.length >= 15) return;
        state.keypadQuery += val;
        const input = container.querySelector('.dialer-pad-readout');
        if (input) input.value = state.keypadQuery;
        refreshKeypadChrome();
      });
    });
    container.querySelector('.dialer-dial-call')?.addEventListener('click', () => {
      const matches = keypadMatches();
      if (!matches.length) {
        showToast('先输入角色名，或收藏几位常聊的角色');
        return;
      }
      void startVoiceCallWithCharacter(matches[0].id);
    });

    // 新建分组
    async function createGroupFromPrompt() {
      const name = window.prompt('新建分组名称');
      if (!name) return;
      try {
        const mutualAcquaintance = window.confirm('组内角色默认彼此认识吗？\n\n选择“取消”时，角色只会通过关系网或剧情推进认识。');
        const created = await createContactGroup(name, { mutualAcquaintance });
        groupConfig = await loadContactGroupsConfig();
        showToast(`已创建「${created.name}」`);
        paint(null, { preserveScroll: true });
      } catch (err) {
        showToast(String((err && err.message) || err));
      }
    }

    container.querySelectorAll('.dialer-group-new').forEach((btn) => {
      btn.addEventListener('click', () => { void createGroupFromPrompt(); });
    });

    container.querySelector('.dialer-ai-batch')?.addEventListener('click', async () => {
      const worldBookRows = await listAllWorldBookRows().catch(() => []);
      openCharacterBatchGeneratorModal({
        groups: manageableGroups(),
        worldBooks: listWorldBookRootOptions(worldBookRows),
        characters: characters.filter((character) => !isAnonymousNpcCharacter(character)),
        defaultGroupId: state.groupId !== ALL_GROUPS_FILTER ? state.groupId : DEFAULT_GROUP_ID,
        onGenerate: async (config) => {
          // 通讯录是 Keep-Alive 页面。复制/切换档位后，页面闭包里的 user 可能仍是
          // 首次进入时的旧对象；每次真正请求前重读当前档位，避免 AI 吃到旧 User 人设。
          const activeUser = identityScope
            ? await getUserById(requestedIdentityUserId).catch(() => user)
            : await ensureDefaultUser();
          user = activeUser || user;
          return generateCharacterBatch({
            ...config,
            user,
            existingCharacters: characters,
            relatedCharacters: characters.filter((character) => config.relatedCharacterIds.includes(character.id)),
          });
        },
        onSave: async (drafts, config) => {
          let targetGroupId = config.groupId || DEFAULT_GROUP_ID;
          const newGroupName = String(config.newGroupName || '').trim();
          if (newGroupName) {
            const created = await createContactGroup(newGroupName);
            targetGroupId = created.id;
          }
          for (const draft of drafts) {
            await saveCharacter({ ...draft, groupId: targetGroupId });
          }
          const fresh = await loadContactsData(user);
          characters = fresh.characters;
          groupConfig = fresh.groupConfig;
          favConfig = fresh.favConfig;
          chats = fresh.chats;
          charById = fresh.charById;
          state.favIds = new Set(favConfig.ids);
          paint(null, { preserveScroll: true });
          showToast(`已生成并保存 ${drafts.length} 位角色`);
        },
        onError: (error) => showToast(String(error?.message || error)),
      });
    });

    container.querySelectorAll('[data-rename-group]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const groupId = btn.getAttribute('data-rename-group');
        const group = (groupConfig.groups || []).find((row) => row.id === groupId);
        if (!group) return;
        const name = window.prompt('修改分组名称', group.name || '');
        if (name == null) return;
        try {
          const renamed = await renameContactGroup(groupId, name);
          groupConfig = await loadContactGroupsConfig();
          showToast(`已重命名为「${renamed.name}」`);
          paint(null, { preserveScroll: true });
        } catch (err) {
          showToast(String((err && err.message) || err));
        }
      });
    });

    container.querySelectorAll('[data-toggle-mutual]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const groupId = btn.getAttribute('data-toggle-mutual');
        const group = (groupConfig.groups || []).find((row) => row.id === groupId);
        if (!group) return;
        try {
          await setGroupMutualAcquaintance(groupId, group.mutualAcquaintance !== true);
          groupConfig = await loadContactGroupsConfig();
          showToast(group.mutualAcquaintance === true ? '已改为彼此独立' : '已开启组内互识');
          paint(null, { preserveScroll: true });
        } catch (err) {
          showToast(String((err && err.message) || err));
        }
      });
    });

    container.querySelector('.dialer-manage')?.addEventListener('click', () => {
      state.manageMode = true;
      state.selectedIds = new Set();
      state.sheet = null;
      paint(null, { preserveScroll: true });
    });
    container.querySelector('.dialer-batch-done')?.addEventListener('click', () => {
      state.manageMode = false;
      state.selectedIds = new Set();
      state.sheet = null;
      paint(null, { preserveScroll: true });
    });
    container.querySelector('.dialer-batch-move')?.addEventListener('click', () => {
      if (!state.selectedIds.size) {
        showToast('请先选择角色');
        return;
      }
      state.sheet = 'move';
      paint(null, { preserveScroll: true });
    });
    container.querySelector('.dialer-batch-delete')?.addEventListener('click', async () => {
      const ids = [...state.selectedIds].filter(Boolean);
      if (!ids.length) {
        showToast('请先选择角色');
        return;
      }
      const names = ids
        .map((id) => String(charById.get(id)?.name || charById.get(id)?.customNickname || '').trim())
        .filter(Boolean);
      const preview = names.slice(0, 3).join('、');
      const more = names.length > 3 ? ` 等 ${ids.length} 位` : (ids.length > 1 ? `（共 ${ids.length} 位）` : '');
      const label = preview ? `「${preview}」${more}` : `已选的 ${ids.length} 位角色`;
      if (!window.confirm(`确定删除${label}？TA 名下的私聊记录、记忆都会一起清掉，此操作不可撤销。`)) return;
      const btn = container.querySelector('.dialer-batch-delete');
      if (btn) btn.disabled = true;
      try {
        for (const id of ids) {
          await deleteCharacterCascade(id);
        }
        const fresh = await loadContactsData(user);
        characters = fresh.characters;
        groupConfig = fresh.groupConfig;
        favConfig = fresh.favConfig;
        charById = fresh.charById;
        state.favIds = new Set(favConfig.ids);
        state.selectedIds = new Set();
        state.sheet = null;
        showToast(ids.length > 1 ? `已删除 ${ids.length} 位角色` : '已删除');
        paint(null, { preserveScroll: true });
      } catch (err) {
        showToast(`删除失败：${err?.message || err}`);
        if (btn) btn.disabled = false;
      }
    });
    container.querySelector('.dialer-batch-groups')?.addEventListener('click', () => {
      state.sheet = 'groups';
      paint(null, { preserveScroll: true });
    });

    container.querySelectorAll('[data-close-sheet]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sheet = null;
        paint(null, { preserveScroll: true });
      });
    });

    container.querySelectorAll('[data-move-to]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const groupId = btn.getAttribute('data-move-to');
        if (!groupId || !state.selectedIds.size) return;
        const label = getGroupLabel(groupConfig, groupId);
        try {
          const moved = await moveCharactersToGroup([...state.selectedIds], groupId);
          const fresh = await loadContactsData(user);
          characters = fresh.characters;
          groupConfig = fresh.groupConfig;
          favConfig = fresh.favConfig;
          charById = fresh.charById;
          state.favIds = new Set(favConfig.ids);
          state.selectedIds = new Set();
          state.sheet = null;
          showToast(moved ? `已将 ${moved} 位移到「${label}」` : '所选角色已在该分组');
          paint(null, { preserveScroll: true });
        } catch (err) {
          showToast(String((err && err.message) || err));
        }
      });
    });

    container.querySelectorAll('[data-delete-group]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const groupId = btn.getAttribute('data-delete-group');
        if (!groupId || groupId === DEFAULT_GROUP_ID) return;
        const group = (groupConfig.groups || []).find((g) => g.id === groupId);
        const name = group?.name || '该分组';
        const count = groupMemberCount(groupId);
        const ok = window.confirm(
          count
            ? `删除分组「${name}」？组内 ${count} 位角色会回到「默认」。`
            : `删除分组「${name}」？`,
        );
        if (!ok) return;
        try {
          const result = await deleteContactGroup(groupId);
          const fresh = await loadContactsData(user);
          characters = fresh.characters;
          groupConfig = fresh.groupConfig;
          favConfig = fresh.favConfig;
          charById = fresh.charById;
          state.favIds = new Set(favConfig.ids);
          state.collapsed.delete(groupId);
          showToast(
            result.moved
              ? `已删除「${result.name}」，${result.moved} 位角色已回到默认`
              : `已删除「${result.name}」`,
          );
          paint(null, { preserveScroll: true });
        } catch (err) {
          showToast(String((err && err.message) || err));
        }
      });
    });

    // 工具栏
    container.querySelectorAll('.dialer-new').forEach((btn) => {
      btn.addEventListener('click', () => navigate('contacts/edit', { new: '1' }));
    });
    container.querySelector('.dialer-open-common')?.addEventListener('click', () => {
      navigate('contacts');
    });
    container.querySelector('.dialer-import')?.addEventListener('click', () => navigate('contacts/import'));
    container.querySelector('.dialer-export')?.addEventListener('click', () => navigate('contacts/export'));
  }

  // 通讯录默认走 Keep-Alive 秒开，回来时角色头像/昵称/分组可能已经改过，
  // 恢复时把数据整体重取一遍再重绘，避免看到编辑前的旧列表。
  // 通话记录扫描很贵，这里不跟着重扫；只有停在「最近」标签时才重新按需拉一次。
  async function reloadAndRepaint() {
    try {
      const activeUser = identityScope
        ? await getUserById(requestedIdentityUserId).catch(() => user)
        : await ensureDefaultUser();
      user = activeUser || user;
      const fresh = scopeContactsData(await loadContactsData(user, { identityScope }), user, params);
      characters = fresh.characters;
      groupConfig = fresh.groupConfig;
      favConfig = fresh.favConfig;
      chats = fresh.chats;
      charById = fresh.charById;
      state.favIds = new Set(favConfig.ids);
      state.collapsed = new Set(groupConfig.collapsedGroups || []);
      if (state.tab === 'recents') {
        callRecordsReady = false;
        void ensureCallRecordsLoaded();
      }
      if (container.isConnected) paint(null, { preserveScroll: true });
    } catch (_) { /* 保底：拿旧数据也比空白强 */ }
  }

  window.addEventListener('marshmallow-route-activated', (ev) => {
    const detail = ev.detail || {};
    if (!detail.resumed || detail.container !== container || detail.path !== 'contacts') return;
    void reloadAndRepaint();
  });

  paint();
}
