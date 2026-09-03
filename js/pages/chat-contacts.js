import { navigate } from '../core/router.js';
import { showToast } from '../components/toast.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters } from '../core/character-store.js';
import { listInboxChatsForUser } from '../core/chat-store.js';
import {
  getGroupLabel,
  loadContactGroupsConfig,
  resolveCharacterGroupId,
} from '../core/contact-groups.js';
import { hasActiveIdentityBinding, identityBindingSelectsCharacter } from '../models/user.js';
import { listPhoneContacts } from '../core/character-phone-contacts.js';
import { ensureLightweightNpc, listLightweightNpcs } from '../core/lightweight-npc.js';
import { syncPhoneContactConversationMemory } from '../core/phone-contact-memory.js';
import { get, put } from '../core/db.js';
import { getChat, saveChat } from '../core/chat-store.js';
import { ensureStrangerThread, updateStrangerFriendship } from '../core/stranger-thread-store.js';
import { isStrangerInterceptChat } from '../core/stranger-thread-model.js';
import {
  loadQqContactApplications,
  upsertQqContactApplication,
} from '../core/qq-contact-applications.js';
import { resolveQqContactApplication } from '../core/qq-contact-application-response.js';
import { hasUnreadMoments } from '../core/moments/moments-store.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../components/image-crop-modal.js';
import {
  clearCustomDefaultAvatar,
  getCustomDefaultAvatar,
  getDefaultAvatarStyle,
  listDefaultAvatarStyles,
  resolveDefaultAvatar,
  setCustomDefaultAvatar,
  setDefaultAvatarStyle,
} from '../core/default-avatar.js';
import {
  applyChatHubInsPageClasses,
  bindChatHubInsTabs,
  bindChatHubUserCard,
  buildChatHubInsChrome,
  identityContactRouteParams,
  loadChatHubInsContext,
} from '../core/chat/chat-hub-ins-chrome.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clean(value) {
  return String(value || '').trim();
}

function openGlobalModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {}, root: null };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet qq-default-avatar-sheet" role="dialog" aria-modal="true" aria-label="选择默认头像" data-modal-sheet>
        ${innerHtml}
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  return { close, root: host };
}

function searchText(...values) {
  return values.flat(Infinity).map((value) => clean(value)).filter(Boolean).join(' ').toLowerCase();
}

function scopeCharactersForIdentity(characters, user) {
  const rows = Array.isArray(characters) ? characters : [];
  const binding = user?.identityBinding && typeof user.identityBinding === 'object'
    ? user.identityBinding
    : {};
  if (!hasActiveIdentityBinding(binding)) return rows;
  return rows.filter((character) => identityBindingSelectsCharacter(binding, {
    ...character,
    groupId: resolveCharacterGroupId(character),
  }));
}

function characterName(character) {
  return clean(character?.customNickname || character?.name || character?.realName) || '未命名联系人';
}

function characterSubtitle(character, groupConfig) {
  const role = clean(character?.currentRole || character?.role || character?.statusText);
  const group = getGroupLabel(groupConfig, resolveCharacterGroupId(character));
  return ['在线', role || group].filter(Boolean).join(' · ');
}

function qqGroupLabel(groupConfig, groupId) {
  const label = clean(getGroupLabel(groupConfig, groupId));
  return !label || label === '默认' ? '我的好友' : label;
}

function suggestionAvatarHtml(item) {
  const avatar = clean(item?.avatar || item?.avatarUrl);
  if (avatar) {
    return `<img src="${esc(avatar)}" alt="" width="52" height="52" decoding="async" />`;
  }
  return `<img src="${esc(resolveDefaultAvatar('chat'))}" alt="" width="52" height="52" decoding="async" />`;
}

function dismissedKey(userId) {
  return `qqContactDismissed_${clean(userId) || 'guest'}`;
}

async function loadDismissed(userId) {
  const row = await get(dismissedKey(userId)).catch(() => null);
  return new Set((Array.isArray(row?.value) ? row.value : []).map(clean).filter(Boolean));
}

async function saveDismissed(userId, ids) {
  const value = [...ids].map(clean).filter(Boolean).slice(-240);
  await put({ key: dismissedKey(userId), value });
}

function makeSuggestion(sourceKind, sourceId, item, subtitle, ownerId = '') {
  const id = `${sourceKind}:${clean(sourceId)}`;
  return {
    id,
    sourceKind,
    sourceId: clean(sourceId),
    ownerId: clean(ownerId),
    name: clean(item?.customNickname || item?.nickname || item?.name) || '新的联系人',
    avatar: clean(item?.avatar || item?.avatarUrl),
    subtitle: clean(subtitle),
  };
}

async function buildSuggestions(user, allCharacters, scopedCharacters, groupConfig) {
  const scopedIds = new Set(scopedCharacters.map((character) => clean(character.id)));
  const byKey = new Map();
  const add = (item) => {
    if (!item?.id || byKey.has(item.id)) return;
    byKey.set(item.id, item);
  };

  for (const character of allCharacters) {
    if (scopedIds.has(clean(character.id))) continue;
    add(makeSuggestion(
      'character',
      character.id,
      character,
      `${qqGroupLabel(groupConfig, resolveCharacterGroupId(character))} · 共同联系人`,
    ));
  }

  const phoneOwners = (scopedCharacters.length ? scopedCharacters : allCharacters).slice(0, 16);
  const phoneLists = await Promise.all(phoneOwners.map(async (owner) => ({
    owner,
    contacts: await listPhoneContacts(user.id, owner.id).catch(() => []),
  })));
  for (const { owner, contacts } of phoneLists) {
    for (const contact of contacts) {
      const linkedId = clean(contact?.linkedCharacterId);
      if (linkedId && scopedIds.has(linkedId)) continue;
      const sourceId = clean(contact?.id || linkedId);
      if (!sourceId) continue;
      const item = makeSuggestion(
        'phone',
        `${owner.id}:${sourceId}`,
        contact,
        `${characterName(owner)}的通讯录`,
        owner.id,
      );
      item.contactId = sourceId;
      item.ownerName = characterName(owner);
      if (linkedId && byKey.has(`character:${linkedId}`)) continue;
      add(item);
    }
  }

  const npcs = await listLightweightNpcs(user.id).catch(() => []);
  for (const npc of npcs) {
    const npcId = clean(npc?.id);
    if (!npcId || scopedIds.has(npcId)) continue;
    add(makeSuggestion('network', npcId, npc, '关系网 · 可能有共同好友'));
  }
  return [...byKey.values()].slice(0, 36);
}

async function resolveSuggestionCharacter(user, suggestion) {
  if (suggestion.sourceKind !== 'phone') {
    return { characterId: suggestion.sourceId, phoneOwnerId: '', phoneContactId: '' };
  }
  const contacts = await listPhoneContacts(user.id, suggestion.ownerId).catch(() => []);
  const contactId = clean(suggestion.contactId)
    || clean(suggestion.sourceId).slice(`${suggestion.ownerId}:`.length);
  const contact = contacts.find((row) => clean(row?.id) === contactId);
  if (!contact) throw new Error('这位联系人已经不在推荐来源里');
  if (clean(contact.linkedCharacterId)) {
    return {
      characterId: clean(contact.linkedCharacterId),
      phoneOwnerId: suggestion.ownerId,
      phoneContactId: contact.id,
      phoneContact: contact,
    };
  }
  const capsule = contact.personaCapsule || {};
  const capsuleTraits = Array.isArray(capsule.traits)
    ? capsule.traits.map((item) => clean(item)).filter(Boolean).join('、')
    : clean(capsule.traits);
  const identityNote = [
    clean(capsule.summary),
    capsuleTraits ? `性格：${capsuleTraits}` : '',
    clean(capsule.relationship) ? `与角色的关系：${clean(capsule.relationship)}` : '',
    clean(capsule.boundary) ? `相处边界：${clean(capsule.boundary)}` : '',
    clean(contact.note),
  ].filter(Boolean).join('\n');
  const npc = await ensureLightweightNpc({
    userId: user.id,
    name: contact.name || suggestion.name,
    avatar: contact.avatar || suggestion.avatar,
    note: identityNote || suggestion.subtitle,
    personality: capsule.summary || capsuleTraits || contact.note || '',
    speechStyle: capsule.speechStyle || '',
    translationProfile: contact.translationProfile,
  });
  if (!npc?.id) throw new Error('无法建立这位联系人的陌生身份');
  return {
    characterId: npc.id,
    phoneOwnerId: suggestion.ownerId,
    phoneContactId: contact.id,
    phoneContact: contact,
  };
}

async function startSuggestionApplication(user, suggestion) {
  const resolved = await resolveSuggestionCharacter(user, suggestion);
  const phoneMemory = resolved.phoneContact
    ? await syncPhoneContactConversationMemory({
      userId: user.id,
      ownerId: resolved.phoneOwnerId,
      ownerName: suggestion.ownerName,
      contact: resolved.phoneContact,
      targetCharacterId: resolved.characterId,
    }).catch((error) => {
      console.warn('[qq-contact-application] phone contact memory sync failed', error);
      return { chunks: 0, messages: 0, promptBlock: '' };
    })
    : { chunks: 0, messages: 0, promptBlock: '' };
  let chat = await ensureStrangerThread({
    userId: user.id,
    characterId: resolved.characterId,
    initiatorType: 'user',
    friendshipState: 'requested',
  });
  if (chat.metadata?.friendshipState === 'accepted') {
    throw new Error('这位联系人已经是好友');
  }
  if (chat.metadata?.friendshipState !== 'requested') {
    chat = await updateStrangerFriendship(chat.id, 'requested', { at: Date.now() });
  }
  chat.metadata = {
    ...(chat.metadata || {}),
    contactApplication: {
      id: suggestion.id,
      sourceKind: suggestion.sourceKind,
      sourceId: suggestion.sourceId,
      phoneOwnerId: resolved.phoneOwnerId,
      phoneContactId: resolved.phoneContactId,
      phoneMemoryChunks: phoneMemory.chunks,
      phoneMemoryMessages: phoneMemory.messages,
      name: suggestion.name,
      avatar: suggestion.avatar,
      status: 'pending',
      responseState: 'queued',
      responseAttemptCount: 0,
      createdAt: Date.now(),
    },
  };
  await saveChat(chat);
  const rows = await upsertQqContactApplication(user.id, {
    ...suggestion,
    characterId: resolved.characterId,
    chatId: chat.id,
    status: 'pending',
    createdAt: Date.now(),
  });
  void resolveQqContactApplication(chat, user, {
    phoneMemoryPromptBlock: phoneMemory.promptBlock,
  }).catch((error) => {
    console.warn('[qq-contact-application] response failed', error);
  });
  return { chat, rows };
}

async function repairPendingApplicationThreads(user, applications = []) {
  let rows = Array.isArray(applications) ? applications : [];
  for (const application of rows.filter((item) => item?.status === 'pending')) {
    let chat = application.chatId
      ? await getChat(application.chatId).catch(() => null)
      : null;
    let characterId = clean(application.characterId);
    let phoneOwnerId = clean(application.ownerId);
    let phoneContactId = clean(application.contactId);
    if (!isStrangerInterceptChat(chat)) {
      try {
        const resolved = characterId
          ? { characterId, phoneOwnerId, phoneContactId }
          : await resolveSuggestionCharacter(user, application);
        characterId = clean(resolved.characterId);
        phoneOwnerId = clean(resolved.phoneOwnerId || phoneOwnerId);
        phoneContactId = clean(resolved.phoneContactId || phoneContactId);
        if (!characterId) continue;
        chat = await ensureStrangerThread({
          userId: user.id,
          characterId,
          initiatorType: 'user',
          friendshipState: 'requested',
        });
      } catch (error) {
        console.warn('[qq-contact-application] pending thread repair failed', error);
        continue;
      }
    }
    let friendshipState = clean(chat.metadata?.friendshipState) || 'requested';
    if (['stranger', 'intercepted'].includes(friendshipState)) {
      chat = await updateStrangerFriendship(chat.id, 'requested', {
        at: Number(application.createdAt) || Date.now(),
        reason: '修复历史好友申请会话',
      }).catch(() => chat);
      friendshipState = clean(chat.metadata?.friendshipState) || friendshipState;
    }
    const storedStatus = clean(chat.metadata?.contactApplication?.status);
    const status = friendshipState === 'accepted'
      ? 'accepted'
      : (storedStatus === 'declined' ? 'declined' : 'pending');
    chat.metadata = {
      ...(chat.metadata || {}),
      contactApplication: {
        ...(chat.metadata?.contactApplication || {}),
        id: application.id,
        sourceKind: application.sourceKind,
        sourceId: application.sourceId,
        phoneOwnerId,
        phoneContactId,
        name: application.name,
        avatar: application.avatar,
        status,
        createdAt: Number(application.createdAt) || Date.now(),
      },
    };
    await saveChat(chat);
    rows = await upsertQqContactApplication(user.id, {
      ...application,
      characterId,
      chatId: chat.id,
      status,
    });
  }
  return rows;
}

function contactRowHtml(character, groupConfig) {
  const name = characterName(character);
  return `
    <button type="button" class="qq-contact-row" data-qq-contact-id="${esc(character.id)}" data-search-text="${esc(searchText(name, character.realName, character.aliases, characterSubtitle(character, groupConfig)))}">
      <span class="qq-contact-avatar">${characterAvatarHtml(character, { className: 'qq-contact-avatar-img' })}</span>
      <span class="qq-contact-copy">
        <strong>${esc(name)}</strong>
        <small>${esc(characterSubtitle(character, groupConfig))}</small>
      </span>
    </button>
  `;
}

function groupChatRowHtml(chat) {
  const title = clean(chat?.name || chat?.title || chat?.metadata?.title) || '群聊';
  const preview = clean(chat?.lastMessage) || `${Math.max(0, (chat?.participants || []).length - 1)} 位成员`;
  return `
    <button type="button" class="qq-contact-row" data-qq-group-chat-id="${esc(chat.id)}" data-search-text="${esc(searchText(title, preview))}">
      <span class="qq-contact-avatar qq-contact-avatar--group" aria-hidden="true">群</span>
      <span class="qq-contact-copy"><strong>${esc(title)}</strong><small>${esc(preview)}</small></span>
    </button>
  `;
}

function suggestionRowHtml(item, pendingIds) {
  const pending = pendingIds.has(item.id);
  return `
    <article class="qq-known-row" data-search-text="${esc(searchText(item.name, item.subtitle))}">
      <span class="qq-known-avatar">${suggestionAvatarHtml(item)}</span>
      <span class="qq-known-copy"><strong>${esc(item.name)}</strong><small>${esc(item.subtitle)}</small></span>
      <button type="button" class="qq-known-add${pending ? ' is-pending' : ''}" data-qq-apply="${esc(item.id)}" ${pending ? 'disabled' : ''}>${pending ? '已申请' : '添加'}</button>
      <button type="button" class="qq-known-dismiss" data-qq-dismiss="${esc(item.id)}" aria-label="不再推荐 ${esc(item.name)}">×</button>
    </article>
  `;
}

function topToolbarHtml() {
  return `
    <div class="qq-contacts-topbar">
      <span class="qq-contacts-topbar-spacer" aria-hidden="true"></span>
      <strong>联系人</strong>
      <button type="button" class="qq-contacts-add" data-qq-add aria-label="添加联系人">
        <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="13" cy="9" r="5"/><path d="M4.5 27c.6-6 3.4-9 8.5-9 2.2 0 4 .6 5.4 1.8"/><path d="M24 17v10M19 22h10"/></svg>
      </button>
    </div>
  `;
}

export default async function render(container) {
  const perfStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let perfLastAt = perfStartedAt;
  const perfPhases = {};
  const markPerfPhase = (name) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    perfPhases[name] = Math.max(0, Math.round(now - perfLastAt));
    perfLastAt = now;
  };
  const renderSeq = Math.max(0, Number(container.dataset.contactsRenderSeq || 0) || 0) + 1;
  container.dataset.contactsRenderSeq = String(renderSeq);
  const [user, hubContext] = await Promise.all([
    ensureDefaultUser(),
    loadChatHubInsContext(),
  ]);
  markPerfPhase('userTheme');
  const identityRouteParams = identityContactRouteParams(user);
  if (hubContext.chatPlatform !== 'qq') {
    navigate('contacts', identityRouteParams, true);
    return;
  }

  const [allCharacters, groupConfig, chats, applications, dismissed] = await Promise.all([
    listCharacters({ userId: user.id, excludeAnonNpc: true }),
    loadContactGroupsConfig(),
    listInboxChatsForUser(user.id).catch(() => []),
    loadQqContactApplications(user.id),
    loadDismissed(user.id),
  ]);
  markPerfPhase('data');
  const scopedCharacters = scopeCharactersForIdentity(allCharacters, user);
  const scopedIds = new Set(scopedCharacters.map((character) => clean(character.id)));
  let momentsUnread = false;
  let suggestions = [];
  let pendingApplications = applications;
  const groupChats = chats.filter((chat) => (
    chat?.type === 'group'
    && (!hasActiveIdentityBinding(user.identityBinding)
      || (chat.participants || []).some((id) => scopedIds.has(clean(id))))
  ));
  const state = {
    listTab: 'groups',
    showApplications: false,
    showAllSuggestions: false,
    collapsedGroups: new Set(),
  };

  function rosterHtml() {
    if (state.listTab === 'groupChats') {
      return groupChats.length
        ? groupChats.map(groupChatRowHtml).join('')
        : '<div class="qq-contacts-empty">当前身份还没有群聊</div>';
    }
    if (!scopedCharacters.length) {
      return '<div class="qq-contacts-empty">当前身份还没有绑定联系人</div>';
    }
    if (state.listTab === 'friends') {
      return scopedCharacters.map((character) => contactRowHtml(character, groupConfig)).join('');
    }
    const grouped = new Map();
    for (const character of scopedCharacters) {
      const groupId = resolveCharacterGroupId(character);
      if (!grouped.has(groupId)) grouped.set(groupId, []);
      grouped.get(groupId).push(character);
    }
    return [...grouped.entries()].map(([groupId, rows]) => {
      const collapsed = state.collapsedGroups.has(groupId);
      return `
        <section class="qq-contact-group" data-qq-group="${esc(groupId)}">
          <button type="button" class="qq-contact-group-head" data-qq-group-toggle="${esc(groupId)}" aria-expanded="${collapsed ? 'false' : 'true'}">
            <span aria-hidden="true">${collapsed ? '▸' : '▾'}</span>
            <strong>${esc(qqGroupLabel(groupConfig, groupId))}</strong>
            <small>${rows.length}/${rows.length}</small>
          </button>
          <div class="qq-contact-group-list" ${collapsed ? 'hidden' : ''}>${rows.map((character) => contactRowHtml(character, groupConfig)).join('')}</div>
        </section>
      `;
    }).join('');
  }

  function applicationsHtml() {
    if (!state.showApplications || !pendingApplications.length) return '';
    return `
      <div class="qq-contact-applications">
        ${pendingApplications.map((item) => `
          <div class="qq-contact-application-row">
            <span class="qq-known-avatar">${suggestionAvatarHtml(item)}</span>
            <span><strong>${esc(item.name)}</strong><small>${item.status === 'accepted' ? '已成为好友' : item.status === 'declined' ? '对方暂未通过' : '等待对方回应'}</small></span>
            ${item.chatId ? `<button type="button" class="qq-known-add" data-qq-application-chat="${esc(item.chatId)}">查看</button>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  function paint({ preserveSearch = false, preserveScroll = false } = {}) {
    const oldSearch = preserveSearch ? clean(container.querySelector('[data-chat-hub-search]')?.value) : '';
    const oldScrollTop = preserveScroll
      ? Math.max(0, Number(container.querySelector('.qq-contacts-scroll')?.scrollTop || 0) || 0)
      : 0;
    applyChatHubInsPageClasses(container, {
      hubInsChrome: hubContext.hubInsChrome,
      windowTheme: hubContext.windowTheme,
      seaTheme: hubContext.seaTheme,
      chatPlatform: 'qq',
      extraClasses: ['qq-contacts-page'],
    });
    const pendingIds = new Set(pendingApplications.filter((item) => item.status === 'pending').map((item) => item.id));
    const pendingCount = pendingIds.size;
    const visibleSuggestions = suggestions.slice(0, state.showAllSuggestions ? 8 : 2);
    const avatarStyles = listDefaultAvatarStyles();
    const selectedAvatarStyle = avatarStyles.find((item) => item.id === getDefaultAvatarStyle())
      || avatarStyles[0];
    container.innerHTML = `
      ${buildChatHubInsChrome({
        activeTab: 'contacts',
        user,
        chatPlatform: 'qq',
        showSearch: true,
        momentsUnread,
        toolbarActionsHtml: topToolbarHtml(),
      })}
      <main class="qq-contacts-scroll">
        ${visibleSuggestions.length ? `
          <section class="qq-known-section" data-qq-known-section>
            <button type="button" class="qq-known-title" data-qq-expand><span>可能想认识的人</span><span aria-hidden="true">›</span></button>
            <div class="qq-known-list">${visibleSuggestions.map((item) => suggestionRowHtml(item, pendingIds)).join('')}</div>
          </section>
        ` : ''}
        <section class="qq-contact-shortcuts">
          <button type="button" data-default-avatar-picker>
            <span class="qq-default-avatar-entry"><img src="${esc(selectedAvatarStyle.preview)}" alt=""><span><strong>默认头像</strong><small>${esc(selectedAvatarStyle.label)}</small></span></span>
            <span><b aria-hidden="true">›</b></span>
          </button>
          <button type="button" data-qq-applications aria-expanded="${state.showApplications ? 'true' : 'false'}">
            <span>新朋友</span>
            <span>${pendingCount ? `${pendingCount} 个待回应` : ''}<b aria-hidden="true">›</b></span>
          </button>
          ${applicationsHtml()}
        </section>
        <section class="qq-contact-roster">
          <nav class="qq-contact-roster-tabs" aria-label="联系人分类">
            <button type="button" data-qq-list-tab="groups" class="${state.listTab === 'groups' ? 'is-active' : ''}">分组</button>
            <button type="button" data-qq-list-tab="friends" class="${state.listTab === 'friends' ? 'is-active' : ''}">好友</button>
            <button type="button" data-qq-list-tab="groupChats" class="${state.listTab === 'groupChats' ? 'is-active' : ''}">群聊</button>
          </nav>
          <div class="qq-contact-roster-body">${rosterHtml()}</div>
        </section>
      </main>
    `;
    const input = container.querySelector('[data-chat-hub-search]');
    if (input) {
      input.setAttribute('aria-label', '搜索联系人');
      if (oldSearch) input.value = oldSearch;
    }
    bind();
    if (oldSearch) applySearch(oldSearch);
    if (preserveScroll) {
      const scroller = container.querySelector('.qq-contacts-scroll');
      if (scroller) scroller.scrollTop = oldScrollTop;
    }
  }

  function applySearch(value) {
    const query = clean(value).toLowerCase();
    container.querySelectorAll('[data-search-text]').forEach((row) => {
      row.hidden = !!query && !clean(row.getAttribute('data-search-text')).includes(query);
    });
    container.classList.toggle('is-contact-searching', !!query);
  }

  function bind() {
    bindChatHubInsTabs(container, 'contacts');
    bindChatHubUserCard(container, user, {
      onSlotChanged: async () => render(container),
    });
    container.querySelector('[data-chat-hub-search]')?.addEventListener('input', (event) => {
      applySearch(event.currentTarget.value);
    });
    container.querySelector('[data-default-avatar-picker]')?.addEventListener('click', () => {
      const selected = getDefaultAvatarStyle();
      const avatarStyles = listDefaultAvatarStyles();
      const hasCustomAvatar = !!getCustomDefaultAvatar();
      const { close, root } = openGlobalModal(`
        <div class="modal-header"><h3>默认头像</h3><button type="button" class="navbar-btn" data-default-avatar-close aria-label="关闭">×</button></div>
        <div class="modal-body qq-default-avatar-options">
          ${avatarStyles.map((item) => `
            <button type="button" class="qq-default-avatar-option${selected === item.id ? ' is-active' : ''}" data-default-avatar-style="${esc(item.id)}">
              <img src="${esc(item.preview)}" alt="">
              <span><strong>${esc(item.label)}</strong><small>${esc(item.description)}</small></span>
              <i aria-hidden="true">${selected === item.id ? '✓' : ''}</i>
            </button>
          `).join('')}
          <div class="qq-default-avatar-upload-row">
            <label class="qq-default-avatar-upload">
              ${hasCustomAvatar ? '替换我的图片' : '上传我的图片'}
              <input type="file" class="default-avatar-file-input" accept="image/*" data-default-avatar-file>
            </label>
            ${hasCustomAvatar ? '<button type="button" class="qq-default-avatar-upload qq-default-avatar-upload--danger" data-default-avatar-clear>删除自定义</button>' : ''}
          </div>
        </div>
      `);
      root?.querySelector('[data-default-avatar-close]')?.addEventListener('click', close);
      root?.querySelectorAll('[data-default-avatar-style]').forEach((button) => {
        button.addEventListener('click', () => {
          const styleId = setDefaultAvatarStyle(button.getAttribute('data-default-avatar-style'));
          const label = listDefaultAvatarStyles().find((item) => item.id === styleId)?.label || '原款';
          close();
          paint({ preserveSearch: true, preserveScroll: true });
          showToast(`默认头像已切换为「${label}」`);
        });
      });
      const defaultAvatarFile = root?.querySelector('[data-default-avatar-file]');
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
          close();
          paint({ preserveSearch: true, preserveScroll: true });
          showToast('已使用上传图片作为默认头像');
        } catch (error) {
          showToast(error?.message || '默认头像处理失败');
        }
      });
      root?.querySelector('[data-default-avatar-clear]')?.addEventListener('click', () => {
        clearCustomDefaultAvatar();
        close();
        paint({ preserveSearch: true, preserveScroll: true });
        showToast('已删除自定义默认头像');
      });
    });
    container.querySelectorAll('[data-qq-expand], [data-qq-add]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!suggestions.length) {
          showToast('暂时没有新的联系人推荐');
          return;
        }
        state.showAllSuggestions = true;
        paint({ preserveSearch: true });
        container.querySelector('[data-qq-known-section]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    container.querySelectorAll('[data-qq-list-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        state.listTab = clean(button.getAttribute('data-qq-list-tab')) || 'groups';
        paint({ preserveSearch: true });
      });
    });
    container.querySelectorAll('[data-qq-group-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const groupId = clean(button.getAttribute('data-qq-group-toggle'));
        if (state.collapsedGroups.has(groupId)) state.collapsedGroups.delete(groupId);
        else state.collapsedGroups.add(groupId);
        paint({ preserveSearch: true });
      });
    });
    container.querySelectorAll('[data-qq-contact-id]').forEach((button) => {
      button.addEventListener('click', () => navigate('contacts/card', {
        id: button.getAttribute('data-qq-contact-id'),
        ...identityRouteParams,
      }));
    });
    container.querySelectorAll('[data-qq-group-chat-id]').forEach((button) => {
      button.addEventListener('click', () => navigate('chat/thread', { chatId: button.getAttribute('data-qq-group-chat-id') }));
    });
    container.querySelector('[data-qq-applications]')?.addEventListener('click', () => {
      state.showApplications = !state.showApplications;
      paint({ preserveSearch: true });
    });
    container.querySelectorAll('[data-qq-application-chat]').forEach((button) => {
      button.addEventListener('click', () => navigate('chat/thread', { chatId: button.dataset.qqApplicationChat }));
    });
    container.querySelectorAll('[data-qq-apply]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = clean(button.getAttribute('data-qq-apply'));
        const suggestion = suggestions.find((item) => item.id === id);
        if (!suggestion || pendingApplications.some((item) => item.id === id && item.status === 'pending')) return;
        button.disabled = true;
        try {
          const result = await startSuggestionApplication(user, suggestion);
          pendingApplications = result.rows;
          showToast('好友申请已发送，已进入陌生消息');
          navigate('chat/thread', { chatId: result.chat.id });
        } catch (error) {
          button.disabled = false;
          showToast(error?.message || '好友申请发送失败');
        }
      });
    });
    container.querySelectorAll('[data-qq-dismiss]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = clean(button.getAttribute('data-qq-dismiss'));
        dismissed.add(id);
        suggestions = suggestions.filter((item) => item.id !== id);
        await saveDismissed(user.id, dismissed).catch(() => null);
        paint({ preserveSearch: true });
      });
    });
  }

  paint();
  markPerfPhase('dom');
  const perfTotalMs = Math.max(0, Math.round(perfLastAt - perfStartedAt));
  if (perfTotalMs >= 180) {
    console.debug('[route-perf] chat/contacts', {
      totalMs: perfTotalMs,
      phases: perfPhases,
      characters: scopedCharacters.length,
      chats: chats.length,
    });
    import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
      type: 'route_phase_timing',
      level: 'info',
      message: `Route phases: chat/contacts (${perfTotalMs}ms)`,
      context: {
        path: 'chat/contacts',
        totalMs: perfTotalMs,
        phases: perfPhases,
        characters: scopedCharacters.length,
        chats: chats.length,
      },
    })).catch(() => {});
  }

  // 通讯录推荐会读取多台角色手机，历史申请修复还可能写库；它们不应挡住联系人首屏。
  // 未读红点同样只属于辅助状态，先展示名单，再在本轮页面仍有效时安静补齐。
  void Promise.all([
    buildSuggestions(user, allCharacters, scopedCharacters, groupConfig)
      .then((rows) => rows.filter((item) => !dismissed.has(item.id)))
      .catch(() => []),
    repairPendingApplicationThreads(user, applications).catch(() => applications),
    hasUnreadMoments(user.id).catch(() => false),
  ]).then(([nextSuggestions, nextApplications, nextMomentsUnread]) => {
    if (Number(container.dataset.contactsRenderSeq || 0) !== renderSeq) return;
    suggestions = nextSuggestions;
    pendingApplications = nextApplications;
    momentsUnread = nextMomentsUnread;
    paint({ preserveSearch: true, preserveScroll: true });
  }).catch((error) => {
    console.warn('[chat-contacts] deferred enrichment failed', error);
  });
}
