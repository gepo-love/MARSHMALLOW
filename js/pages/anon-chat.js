import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { escAttr } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { openChatRowSheet } from '../components/chat-row-sheet.js';
import { bindLongPress } from '../components/chat-bubble-menu.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  clearChatMemories,
  deleteChatWithData,
  listAnonymousChatsForUser,
  toggleChatPinned,
} from '../core/chat-store.js';
import { loadAnonymousSpaceUserProfile, loadAnonymousSpaceState, saveUserSpaceProfile } from '../core/anonymous-space.js';
import { getAnonymousDisplayProfile, getAnonymousPrivateCounterpartId } from '../core/anonymous-chat.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import { isCyberConfessionChat } from '../core/anonymous-confession.js';
import { loadAnonymousContacts, removeAnonymousContact } from '../core/anonymous-contacts.js';
import { deleteRetainedAnonymousNpc } from '../core/anonymous-npc.js';
import { getUserDisplayName } from '../models/user.js';
import {
  isChatStreaming,
  subscribeChatStreamSession,
  CHAT_STREAM_PREVIEW,
} from '../core/chat/chat-stream-session.js';
import {
  ANON_ROOM_CAUTION_FULL,
  ANON_ROOM_CAUTION_TITLE,
  ANON_ROOM_NOTICE_ACK_KEY,
} from '../data/anonymous-room-notice.js';

function openAnonWallEditorModal({ photos = [], onSave } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  let items = Array.isArray(photos) ? [...photos] : [];

  const paint = () => {
    const grid = host.querySelector('.anon-wall-edit-grid');
    if (!grid) return;
    grid.innerHTML = items.length
      ? items.map((src, idx) => `
          <div class="anon-wall-edit-item">
            <img src="${escAttr(src)}" alt="" loading="lazy" decoding="async" />
            <button type="button" class="anon-wall-edit-remove" data-wall-remove="${idx}" aria-label="删除">×</button>
          </div>
        `).join('')
      : '<div class="anon-wall-edit-empty">还没有图片，点下方添加</div>';
    grid.querySelectorAll('[data-wall-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-wall-remove'));
        if (!Number.isFinite(idx)) return;
        items = items.filter((_, i) => i !== idx);
        paint();
      });
    });
  };

  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay anon-wall-edit-overlay" data-wall-edit-overlay>
      <div class="modal-sheet anon-modal-sheet anon-wall-edit-sheet" role="dialog" aria-modal="true" data-wall-edit-sheet>
        <header class="modal-header">
          <h3>装饰墙</h3>
          <button type="button" class="btn btn-sm btn-soft" data-wall-edit-close aria-label="关闭">关闭</button>
        </header>
        <div class="modal-body anon-wall-edit-body">
          <div class="anon-wall-edit-grid"></div>
          <button type="button" class="btn btn-outline btn-block anon-wall-edit-add" data-wall-add>添加图片</button>
          <input type="file" class="anon-wall-edit-upload" accept="image/*" multiple hidden />
          <button type="button" class="btn btn-primary btn-block anon-wall-edit-save" data-wall-save>保存</button>
        </div>
      </div>
    </div>
  `;
  paint();

  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };

  host.querySelector('[data-wall-edit-overlay]')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  host.querySelector('[data-wall-edit-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-wall-edit-close]')?.addEventListener('click', close);
  host.querySelector('[data-wall-add]')?.addEventListener('click', () => {
    host.querySelector('.anon-wall-edit-upload')?.click();
  });
  host.querySelector('.anon-wall-edit-upload')?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      const readers = await Promise.all(files.slice(0, 8 - items.length).map((file) => new Promise((resolve, reject) => {
        if (!/^image\//.test(file.type || '')) {
          reject(new Error('请选择图片'));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取失败'));
        reader.readAsDataURL(file);
      })));
      items = [...items, ...readers.filter((src) => String(src).startsWith('data:'))].slice(0, 8);
      paint();
    } catch (err) {
      showToast(err?.message || '上传失败');
    }
  });
  host.querySelector('[data-wall-save]')?.addEventListener('click', async () => {
    await onSave?.(items);
    close();
  });
}

function hasAckedAnonRoomNotice() {
  try {
    return localStorage.getItem(ANON_ROOM_NOTICE_ACK_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function markAnonRoomNoticeAcked() {
  try {
    localStorage.setItem(ANON_ROOM_NOTICE_ACK_KEY, '1');
  } catch (_) {}
}

/**
 * @param {{ force?: boolean }} [options]
 *   force=true：首次进入强制展示，倒计时 5 秒后才能点「我知道了」，不可点遮罩关闭。
 */
function openAnonRoomNoticeModal({ force = false } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const locked = !!force;
  host.innerHTML = `
    <div class="modal-overlay anon-notice-overlay${locked ? ' is-locked' : ''}" data-anon-notice-overlay>
      <div class="modal-sheet anon-modal-sheet anon-notice-sheet" role="dialog" aria-modal="true" data-anon-notice-sheet>
        <div class="modal-header">
          <h3>${esc(ANON_ROOM_CAUTION_TITLE)}</h3>
          ${locked ? '' : '<button type="button" class="btn btn-sm btn-soft" data-anon-notice-close aria-label="关闭">关闭</button>'}
        </div>
        <div class="modal-body anon-notice-body">${esc(ANON_ROOM_CAUTION_FULL)}</div>
        <div class="modal-footer anon-notice-footer">
          <button type="button" class="btn btn-primary anon-notice-ack" data-anon-notice-ack${locked ? ' disabled' : ''}>
            ${locked ? '我知道了（5）' : '我知道了'}
          </button>
        </div>
      </div>
    </div>
  `;
  host.classList.add('active');
  const ackBtn = host.querySelector('[data-anon-notice-ack]');
  let countdownTimer = 0;
  const close = () => {
    if (countdownTimer) window.clearInterval(countdownTimer);
    countdownTimer = 0;
    host.classList.remove('active');
    host.innerHTML = '';
  };
  const acknowledge = () => {
    if (ackBtn?.disabled) return;
    if (locked) markAnonRoomNoticeAcked();
    close();
  };
  host.querySelector('[data-anon-notice-overlay]')?.addEventListener('click', (e) => {
    if (locked) return;
    if (e.target === e.currentTarget) close();
  });
  host.querySelector('[data-anon-notice-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-anon-notice-close]')?.addEventListener('click', close);
  ackBtn?.addEventListener('click', acknowledge);
  if (locked && ackBtn) {
    let left = 5;
    countdownTimer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        window.clearInterval(countdownTimer);
        countdownTimer = 0;
        ackBtn.disabled = false;
        ackBtn.textContent = '我知道了';
        return;
      }
      ackBtn.textContent = `我知道了（${left}）`;
    }, 1000);
  }
}

function maybeOpenFirstAnonRoomNotice() {
  if (hasAckedAnonRoomNotice()) return;
  openAnonRoomNoticeModal({ force: true });
}

function esc(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function chatKindLabel(chat) {
  if (chat?.metadata?.isSeedRoom) return '种子房';
  if (chat?.metadata?.sourceAnonymousType === 'cyber_confession') return '告解';
  if (String(chat?.metadata?.anonymousRoomKind || '') === 'private') return '私聊';
  if (chat?.type === 'group') return '群聊';
  return '匿名';
}

function resolveTitle(chat, user, spaceProfile) {
  if (isCyberConfessionChat(chat)) {
    return String(chat.groupSettings?.name || '赛博告解室').trim();
  }
  if (chat.type === 'group') {
    return String(chat.groupSettings?.name || '匿名群').trim();
  }
  const counterpartId = getAnonymousPrivateCounterpartId(chat)
    || (chat.participants || []).find((p) => p && p !== 'user');
  const profile = getAnonymousDisplayProfile(chat, counterpartId, {
    currentUserName: getUserDisplayName(user),
    spaceProfile,
  });
  return profile?.anonymousId || '匿名会话';
}

function resolveHubRowVisual(chat, user, spaceProfile) {
  const title = resolveTitle(chat, user, spaceProfile);
  let avatar = '';
  if (chat.type === 'group') {
    avatar = String(chat.groupSettings?.avatar || '').trim();
  } else {
    const counterpartId = getAnonymousPrivateCounterpartId(chat)
      || (chat.participants || []).find((p) => p && p !== 'user');
    avatar = String(getAnonymousDisplayProfile(chat, counterpartId, {
      currentUserName: getUserDisplayName(user),
      spaceProfile,
    })?.avatar || '').trim();
  }
  return { title, avatar: avatar || resolveDefaultAvatar('anonymous') };
}

function hubCoverStyle(avatar = '', coverClass = '') {
  const av = String(avatar || '').trim();
  if (/^(data:image\/|https?:\/\/|assets\/|\.{0,2}\/|\/)/i.test(av)) {
    return `class="anon-hub-cover ${coverClass}" style="background-image:url(${escAttr(av)});background-size:cover;background-position:center"`;
  }
  return `class="anon-hub-cover ${coverClass}"`;
}

const TAB_LABELS = {
  rooms: '全部',
  group: '群聊',
  private: '私聊',
  contacts: '网友',
};

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  const anonSpaceProfile = await loadAnonymousSpaceUserProfile(user.id);
  const anonSpaceState = await loadAnonymousSpaceState(user.id, 'user');
  const wallPhotos = Array.isArray(anonSpaceState.profile?.wallPhotos) ? anonSpaceState.profile.wallPhotos : [];
  let activeTab = String(params.tab || 'rooms').trim();

  let chats = await listAnonymousChatsForUser(user.id);
  let contacts = await loadAnonymousContacts(user.id);
  let suppressOpenUntil = 0;
  let actionsOpen = false;

  function tabToFilter(tabKey = '') {
    const t = String(tabKey || '').trim();
    if (t === 'private') return 'private';
    if (t === 'group') return 'group';
    if (t === 'contacts') return 'contacts';
    return 'all';
  }

  let filter = tabToFilter(activeTab);

  container.className = 'page anon-page anon-hub-page';

  function shellHtml() {
    const handle = String(anonSpaceProfile.handle || '').trim() || '匿名网友';
    const decoCards = wallPhotos.length
      ? wallPhotos.slice(0, 3).map((src, i) => `<span class="anon-deco-card c${i + 1}" style="background-image:url(${escAttr(src)});background-size:cover;background-position:center"></span>`).join('')
      : '<span class="anon-deco-card c1"></span><span class="anon-deco-card c2"></span><span class="anon-deco-card c3"></span>';
    return `
      <div class="anon-hub">
        <div class="anon-hub-head">
          <button type="button" class="anon-hub-back" data-back aria-label="返回">${icon('back')}</button>
          <h2 class="anon-hub-title">Anonymous Chat</h2>
          <button type="button" class="anon-hub-icon-btn" data-anon-room-notice aria-label="须知">?</button>
        </div>
        <nav class="anon-hub-tabs" aria-label="匿名列表筛选">
          ${Object.entries(TAB_LABELS).map(([key, label]) => `
            <button type="button" class="anon-hub-tab ${filter === key || (filter === 'all' && key === 'rooms') ? 'is-active' : ''}" data-tab="${esc(key)}">${esc(label)}</button>
          `).join('')}
        </nav>
        <div class="anon-hub-scroll">
            <div class="anon-deco-wall" aria-hidden="true">
              <span class="anon-deco-label">Private works · ${esc(String(wallPhotos.length || chats.length || 0))}</span>
              ${decoCards}
              <button type="button" class="anon-deco-add" data-pick-wall aria-label="编辑装饰墙">+</button>
            </div>
          <div class="anon-hub-invite">
            <span><strong>${esc(handle)}</strong><small>底色网名 · 进房再换马甲</small></span>
            <button type="button" class="anon-hub-invite-btn" data-go-profile>编辑</button>
          </div>
          <div id="anon-list-panel"></div>
        </div>
      </div>
      <div class="anon-hub-dock">
        <button type="button" class="anon-hub-dock-btn is-active" aria-label="消息">${icon('message')}</button>
        <button type="button" class="anon-hub-dock-btn" data-go="match-single" aria-label="匹配">${icon('plus')}</button>
        <button type="button" class="anon-hub-dock-btn" data-go="space" aria-label="空间">${icon('select')}</button>
        <button type="button" class="anon-hub-dock-btn ${actionsOpen ? 'is-open' : ''}" data-anon-actions aria-label="更多" aria-expanded="${actionsOpen ? 'true' : 'false'}">${actionsOpen ? icon('close') : icon('more')}</button>
      </div>
      <div class="anon-hub-action-sheet ${actionsOpen ? 'is-open' : ''}" aria-hidden="${actionsOpen ? 'false' : 'true'}">
        <button type="button" class="anon-hub-action" data-go="match-group">${icon('select')}<span>随机群</span></button>
        <button type="button" class="anon-hub-action" data-go="room-create">${icon('plus')}<span>创建房间</span></button>
        <button type="button" class="anon-hub-action" data-go="wall">${icon('message')}<span>匿名墙</span></button>
        <button type="button" class="anon-hub-action" data-go="confession">${icon('hook')}<span>告解</span></button>
        <button type="button" class="anon-hub-action" data-go="streamer">${icon('sparkle')}<span>深夜主播</span></button>
      </div>
    `;
  }

  container.innerHTML = shellHtml();

  function syncTabUi() {
    container.querySelectorAll('[data-tab]').forEach((btn) => {
      const key = btn.getAttribute('data-tab') || '';
      const on = filter === key || (filter === 'all' && key === 'rooms');
      btn.classList.toggle('is-active', on);
    });
  }

  function replaceAnonChatTab(nextTab = 'rooms') {
    const t = String(nextTab || 'rooms').trim();
    if (t === activeTab) return;
    activeTab = t;
    filter = tabToFilter(activeTab);
    const sp = new URLSearchParams();
    if (activeTab && activeTab !== 'rooms') sp.set('tab', activeTab);
    const hash = sp.toString() ? `#anon-chat?${sp.toString()}` : '#anon-chat';
    window.history.replaceState({ path: 'anon-chat', params: { tab: activeTab } }, '', hash);
    syncTabUi();
    paintList();
  }

  async function paintList() {
    const panel = container.querySelector('#anon-list-panel');
    if (!panel) return;
    chats = await listAnonymousChatsForUser(user.id);
    contacts = await loadAnonymousContacts(user.id);

    if (filter === 'contacts') {
      panel.innerHTML = contacts.length ? `
        <p class="anon-hub-section-title">网友 <span>${esc(String(contacts.length))}</span></p>
        <div class="anon-hub-rows">
          ${contacts.map((c) => `
            <button type="button" class="anon-hub-row" data-private-id="${esc(c.privateChatId)}" data-actor-id="${esc(c.actorId)}">
              <span ${hubCoverStyle(c.avatar || resolveDefaultAvatar('anonymous'))}></span>
              <span class="anon-hub-row-body">
                <strong>${esc(c.anonymousId || '网友')}</strong>
                <small>${esc(c.networkSignature || '来自匿名房')}</small>
              </span>
              <span class="anon-hub-row-meta"><time>私聊</time></span>
            </button>
          `).join('')}
        </div>
      ` : '<div class="anon-empty">还没有保存的匿名网友</div>';
      panel.querySelectorAll('[data-private-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (Date.now() < suppressOpenUntil) return;
          const id = btn.getAttribute('data-private-id');
          if (id) navigate('chat/thread', { chatId: id, from: 'anon' });
          else showToast('尚未建立私聊窗口');
        });
        bindLongPress(btn, () => {
          suppressOpenUntil = Date.now() + 700;
          const actorId = btn.getAttribute('data-actor-id') || '';
          const row = contacts.find((c) => c.actorId === actorId);
          openChatRowSheet({
            chatTitle: row?.anonymousId || '匿名网友',
            actions: [
              {
                label: '删除匿名联系人',
                variant: 'danger',
                onClick: async () => {
                  if (!window.confirm('删除这个匿名联系人？不会删除已有聊天记录。')) return;
                  await removeAnonymousContact(user.id, actorId);
                  contacts = await loadAnonymousContacts(user.id);
                  showToast('已删除匿名联系人');
                  paintList();
                },
              },
              {
                label: '彻底删除匿名角色',
                variant: 'danger',
                onClick: async () => {
                  if (!window.confirm('彻底删除这位匿名网友？联系人、匿名空间、聊天记录和相关记忆都会被清掉，此操作不可撤销。')) return;
                  const result = await deleteRetainedAnonymousNpc(user.id, actorId);
                  if (!result?.deleted) {
                    showToast('该身份不是可删除的匿名路人');
                    return;
                  }
                  contacts = await loadAnonymousContacts(user.id);
                  showToast('已彻底删除匿名角色');
                  paintList();
                },
              },
            ],
          });
        });
      });
      return;
    }

    const filtered = chats.filter((chat) => {
      if (filter === 'group') return chat.type === 'group';
      if (filter === 'private') return chat.type !== 'group';
      return true;
    });

    panel.innerHTML = filtered.length ? `
      <p class="anon-hub-section-title">Rooms <span>${esc(String(filtered.length))}</span></p>
      <div class="anon-hub-rows">
        ${filtered.map((chat, idx) => {
          const { title, avatar } = resolveHubRowVisual(chat, user, anonSpaceProfile);
          const preview = isChatStreaming(chat.id)
            ? CHAT_STREAM_PREVIEW
            : (String(chat.lastMessage || '').trim() || '暂无消息');
          const coverClass = ['', 'is-alt', 'is-deep'][idx % 3];
          return `
            <button type="button" class="anon-hub-row" data-chat-id="${esc(chat.id)}">
              <span ${hubCoverStyle(avatar, coverClass)}></span>
              <span class="anon-hub-row-body">
                <strong>${esc(title)}</strong>
                <small>${esc(preview)}</small>
              </span>
              <span class="anon-hub-row-meta">
                <time>${esc(formatListTime(chat.lastActivity))}</time>
                <span class="anon-hub-tag">${esc(chatKindLabel(chat))}</span>
              </span>
            </button>
          `;
        }).join('')}
      </div>
    ` : '<div class="anon-empty">还没有匿名会话</div>';

    panel.querySelectorAll('[data-chat-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (Date.now() < suppressOpenUntil) return;
        navigate('chat/thread', { chatId: btn.getAttribute('data-chat-id'), from: 'anon' });
      });
      bindLongPress(btn, () => {
        suppressOpenUntil = Date.now() + 700;
        const chatId = btn.getAttribute('data-chat-id') || '';
        const row = chats.find((c) => c.id === chatId);
        if (!row) return;
        const title = resolveTitle(row, user, anonSpaceProfile);
        openChatRowSheet({
          chatTitle: title,
          actions: [
            {
              label: row.pinned ? '取消置顶' : '置顶会话',
              onClick: async () => {
                await toggleChatPinned(chatId);
                chats = await listAnonymousChatsForUser(user.id);
                paintList();
              },
            },
            {
              label: '清除本会话记忆',
              variant: 'danger',
              onClick: async () => {
                if (!window.confirm(`清除「${title}」的全部记忆条目？聊天记录会保留。`)) return;
                await clearChatMemories(chatId, user.id);
                showToast('记忆已清除');
              },
            },
            {
              label: '删除匿名会话',
              variant: 'danger',
              onClick: async () => {
                if (!window.confirm(`删除匿名会话「${title}」？聊天记录、相关记忆和本会话偏好会一并删除。`)) return;
                await deleteChatWithData(chatId, user.id);
                chats = await listAnonymousChatsForUser(user.id);
                showToast('已删除匿名会话');
                paintList();
              },
            },
          ],
        });
      });
    });
  }

  function bindShell() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-pick-wall]')?.addEventListener('click', () => {
      openAnonWallEditorModal({
        photos: wallPhotos,
        onSave: async (next) => {
          await saveUserSpaceProfile(user.id, { wallPhotos: next });
          showToast('已更新装饰墙');
          navigate('anon-chat', { tab: activeTab }, true);
        },
      });
    });
    container.querySelector('[data-go-profile]')?.addEventListener('click', () => navigate('anon/space'));
    container.querySelector('[data-anon-actions]')?.addEventListener('click', () => {
      actionsOpen = !actionsOpen;
      container.querySelector('.anon-hub-action-sheet')?.classList.toggle('is-open', actionsOpen);
      container.querySelector('[data-anon-actions]')?.classList.toggle('is-open', actionsOpen);
      const fab = container.querySelector('[data-anon-actions]');
      if (fab) {
        fab.setAttribute('aria-expanded', actionsOpen ? 'true' : 'false');
        fab.innerHTML = actionsOpen ? icon('close') : icon('more');
      }
      container.querySelector('.anon-hub-action-sheet')?.setAttribute('aria-hidden', actionsOpen ? 'false' : 'true');
    });
    container.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => replaceAnonChatTab(btn.getAttribute('data-tab')));
    });
    const goMap = {
      'match-single': () => navigate('anon/match'),
      'match-group': () => navigate('anon/match/group'),
      'room-create': () => navigate('anon/room/create'),
      wall: () => navigate('anon/wall'),
      confession: () => navigate('anon/confession'),
      space: () => navigate('anon/space'),
      streamer: () => navigate('anon/streamer'),
    };
    container.querySelectorAll('[data-go]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-go') || '';
        goMap[key]?.();
      });
    });
    container.querySelector('[data-anon-room-notice]')?.addEventListener('click', () => {
      openAnonRoomNoticeModal({ force: false });
    });
  }

  paintList();
  bindShell();
  maybeOpenFirstAnonRoomNotice();

  subscribeChatStreamSession(async () => {
    if (!container.isConnected || filter === 'contacts') return;
    chats = await listAnonymousChatsForUser(user.id);
    paintList();
  });
}
