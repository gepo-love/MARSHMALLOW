import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { openChatRowSheet } from '../components/chat-row-sheet.js';
import { bindLongPress } from '../components/chat-bubble-menu.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { clearChatUnread, listBackstageChats, getChat, deleteChatWithData } from '../core/chat-store.js';
import {
  isChatStreaming,
  subscribeChatStreamSession,
  CHAT_STREAM_PREVIEW,
} from '../core/chat/chat-stream-session.js';
import {
  applyChatHubInsPageClasses,
  bindChatHubInsTabs,
  bindChatHubUserCard,
  buildChatHubInsChrome,
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

export default async function render(container) {
  const user = await ensureDefaultUser();
  const { hubInsChrome, windowTheme, seaTheme, chatPlatform = 'current' } = await loadChatHubInsContext();
  const platformSubpage = chatPlatform === 'qq' || chatPlatform === 'wechat';
  const chats = await listBackstageChats(user.id);
  const listRowClass = hubInsChrome ? 'chat-list-row chat-list-row--ins' : 'chat-list-row';
  const hubScrollClass = hubInsChrome ? 'chat-hub-scroll chat-hub-scroll--ins' : 'chat-hub-scroll scrapbook-scroll';

  applyChatHubInsPageClasses(container, {
    hubInsChrome,
    windowTheme,
    seaTheme,
    extraClasses: ['chat-backstage-page'],
  });

  const listRowsHtml = chats.length ? chats.map((chat) => {
    const title = chat.groupSettings?.name || '幕后会话';
    const preview = (isChatStreaming(chat.id) ? CHAT_STREAM_PREVIEW : String(chat.lastMessage || '暂无消息')).slice(0, 48);
    return `
        <button type="button" class="${listRowClass} ${isChatStreaming(chat.id) ? 'is-streaming' : ''}" data-chat-id="${esc(chat.id)}">
          <span class="chat-list-avatar is-backstage">${emptyIllustration('moon', 'chat-list-avatar-moon')}</span>
          <span class="chat-list-body">
            <span class="chat-list-title">${esc(title)}</span>
            <span class="chat-list-preview">${esc(preview)}</span>
          </span>
          <span class="chat-list-meta">
            <span class="chat-list-time">${esc(formatListTime(chat.lastActivity))}</span>
          </span>
        </button>
      `;
  }).join('') : `
        <div class="chat-empty${hubInsChrome ? ' chat-empty--ins' : ' scrapbook-empty'}">
          ${hubInsChrome ? '' : emptyIllustration('moon')}
          <div class="chat-empty-text">还没有群助手会话</div>
          <div class="chat-empty-hint">群聊幕后会话与 AI 群助手事件会出现在这里</div>
        </div>
      `;

  if (hubInsChrome) {
    container.innerHTML = `
      ${buildChatHubInsChrome({
        activeTab: 'backstage',
        user,
        chatPlatform,
        showUserCard: !platformSubpage,
        showTabs: !platformSubpage,
        pageTitle: platformSubpage ? '群助手' : '',
      })}
      <main class="${hubScrollClass}">${listRowsHtml}</main>
    `;
  } else {
    container.innerHTML = `
      <header class="navbar chat-hub-navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">秘密基地</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <nav class="chat-hub-tabs" aria-label="Chat 分区">
        <button type="button" class="chat-hub-tab" data-tab="messages">消息</button>
        <button type="button" class="chat-hub-tab" data-tab="moments">朋友圈</button>
        <button type="button" class="chat-hub-tab" data-tab="intercepts">陌生消息</button>
        <button type="button" class="chat-hub-tab is-active" data-tab="backstage">秘密基地</button>
      </nav>
      <main class="${hubScrollClass}">${listRowsHtml}</main>
    `;
  }

  container.querySelector('[data-back]')?.addEventListener('click', () => {
    if (platformSubpage) navigate('chat', {}, true);
    else back();
  });
  if (hubInsChrome) {
    bindChatHubInsTabs(container, 'backstage');
    bindChatHubUserCard(container, user, {
      onSlotChanged: async () => {
        if (container.isConnected) await render(container);
      },
    });
  } else {
    container.querySelectorAll('.chat-hub-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-tab');
        if (next === 'backstage') return;
        navigate(next === 'messages' ? 'chat' : next === 'moments' ? 'chat/moments' : 'chat/intercepts', {}, true);
      });
    });
  }
  container.querySelectorAll('[data-chat-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chatId = btn.getAttribute('data-chat-id');
      if (chatId) {
        void clearChatUnread(chatId).catch(() => {});
        navigate('chat/thread', { chatId });
      }
    });
    bindLongPress(btn, () => {
      const chatId = btn.getAttribute('data-chat-id');
      if (!chatId) return;
      const chat = chats.find((c) => c.id === chatId);
      const chatTitle = chat?.groupSettings?.name || '幕后会话';
      openChatRowSheet({
        chatTitle,
        actions: [
          {
            label: '删除会话',
            variant: 'danger',
            onClick: async () => {
              if (!window.confirm(`删除「${chatTitle}」？聊天记录与相关记忆会一并删除。`)) return;
              try {
                await deleteChatWithData(chatId, user.id);
                showToast('会话已删除');
                if (container.isConnected) await render(container);
              } catch (error) {
                showToast(`删除失败：${error?.message || error}`);
              }
            },
          },
        ],
      });
    }, 550);
  });

  subscribeChatStreamSession(async () => {
    if (!container.isConnected) return;
    for (const btn of container.querySelectorAll('[data-chat-id]')) {
      const id = btn.getAttribute('data-chat-id') || '';
      const previewEl = btn.querySelector('.chat-list-preview');
      if (!previewEl) continue;
      if (isChatStreaming(id)) {
        previewEl.textContent = CHAT_STREAM_PREVIEW;
        btn.classList.add('is-streaming');
        continue;
      }
      btn.classList.remove('is-streaming');
      const fresh = await getChat(id).catch(() => null);
      if (fresh) previewEl.textContent = String(fresh.lastMessage || '暂无消息').slice(0, 48);
    }
  });
}
