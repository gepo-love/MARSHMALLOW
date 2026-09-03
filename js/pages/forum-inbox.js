import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { icon } from '../components/svg-icons.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import { listForumVests, loadForumProfile } from '../core/forum-vests.js';
import {
  buildForumInboxSnapshot,
  collectForumNotifications,
  markForumInboxSnapshotRead,
} from '../core/forum/forum-inbox-state.js';

export { collectForumNotifications };

function e(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function t(timestamp = 0) {
  return new Date(timestamp || Date.now()).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadThreads(userId = '') {
  try {
    return await db.getAllByIndex('forumThreads', 'userId', userId);
  } catch (_) {
    return (await db.getAllRecords('forumThreads')).filter((row) => row?.userId === userId);
  }
}

export default async function render(container) {
  const user = await ensureDefaultUser();
  const userId = user?.id || '';
  const [threads, forumProfile, vests] = await Promise.all([
    loadThreads(userId),
    loadForumProfile(userId, user),
    listForumVests(userId),
  ]);
  const snapshot = await buildForumInboxSnapshot({ user, threads, forumProfile, vests });
  const { notifications, privateChats } = snapshot;
  const unreadChatIds = new Set(snapshot.unreadChatIds);
  const unreadReplyKeys = new Set(snapshot.unreadReplyKeys);

  container.className = 'page forum-profile-page forum-inbox-page';
  container.innerHTML = `
    <header class="navbar forum-navbar forum-profile-navbar">
      <button type="button" class="forum-nav-icon" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">论坛收件箱</h1>
      <span class="forum-nav-icon" aria-hidden="true"></span>
    </header>
    <main class="page-scroll forum-profile-scroll">
      <section class="forum-profile-section forum-inbox-section">
        <div class="forum-profile-section-head"><h3>私信</h3><span>${privateChats.length}</span></div>
        <div class="forum-inbox-list">
          ${privateChats.map((chat) => `
            <button type="button" class="forum-inbox-row${unreadChatIds.has(chat.id) ? ' is-unread' : ''}" data-chat-id="${e(chat.id)}">
              <span class="forum-inbox-avatar"><img src="${e(resolveDefaultAvatar('forum'))}" alt=""></span>
              <span class="forum-inbox-copy">
                <strong>${e(chat.metadata?.sourceForumDisplayName || '论坛网友')}</strong>
                <span>${e(chat.lastMessage || '还没有消息')}</span>
              </span>
              <time>${e(t(chat.lastActivity || chat.createdAt))}</time>
            </button>
          `).join('') || '<div class="forum-profile-empty">还没有论坛私信</div>'}
        </div>
      </section>
      <section class="forum-profile-section forum-inbox-section">
        <div class="forum-profile-section-head"><h3>回复我的</h3><span>${notifications.length}</span></div>
        <div class="forum-inbox-list">
          ${notifications.slice(0, 80).map((row) => `
            <button type="button" class="forum-inbox-row${unreadReplyKeys.has(row.key) ? ' is-unread' : ''}" data-thread-id="${e(row.threadId)}">
              <span class="forum-inbox-avatar"><img src="${e(resolveDefaultAvatar('forum'))}" alt=""></span>
              <span class="forum-inbox-copy">
                <strong>${e(row.author)} · ${e(row.threadTitle)}</strong>
                <span>${e(String(row.content || '').replace(/\s+/g, ' ').slice(0, 90))}</span>
              </span>
              <time>${e(t(row.timestamp))}</time>
            </button>
          `).join('') || '<div class="forum-profile-empty">还没有新互动</div>'}
        </div>
      </section>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-chat-id]').forEach((button) => {
    button.addEventListener('click', () => navigate('chat/thread', {
      chatId: button.getAttribute('data-chat-id') || '',
      from: 'forum',
    }));
  });
  container.querySelectorAll('[data-thread-id]').forEach((button) => {
    button.addEventListener('click', () => navigate('forum-detail', {
      threadId: button.getAttribute('data-thread-id') || '',
    }));
  });
  await markForumInboxSnapshotRead(userId, snapshot);
}
