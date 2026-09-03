import { back, navigate, syncCurrentRoute } from '../core/router.js';
import * as db from '../core/db.js';
import { listWeiboDmThreads } from '../core/weibo/weibo-dm-store.js';
import { icon } from '../components/svg-icons.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import {
  listWeiboNotifications,
  markWeiboNotificationsRead,
} from '../core/weibo/weibo-notification-store.js';

function e(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function time(value) {
  return new Date(Number(value || Date.now())).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const TAB_LABELS = { comment: '评论与提及', like: '赞', follow: '关注', dm: '私信' };

export default async function render(container, params = {}) {
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const currentUserName = currentUserId ? String((await db.get('users', currentUserId))?.name || '') : '';
  const ownerUserId = params.ownerUserId || currentUserId || 'guest';
  const tab = ['comment', 'like', 'follow', 'dm'].includes(params.messageTab) ? params.messageTab : 'comment';
  const rows = tab === 'dm'
    ? await listWeiboDmThreads(ownerUserId, { profileKeys: [currentUserId, currentUserName, 'user'] })
    : await listWeiboNotifications(ownerUserId, { type: tab });
  if (tab !== 'dm') await markWeiboNotificationsRead(ownerUserId, tab);

  const items = tab === 'dm'
    ? rows.map((thread) => `<button type="button" class="wbmsg-row" data-dm-thread="${e(thread.id)}">
        <span class="wbmsg-avatar"><img src="${e(resolveDefaultAvatar('weibo'))}" alt=""></span>
        <span class="wbmsg-copy"><strong>${e(thread.counterpartName)}</strong><span>${e(thread.lastMessage || '图片')}</span></span>
        <time>${e(time(thread.updatedAt))}</time>${thread.unreadCount ? `<i>${Math.min(99, thread.unreadCount)}</i>` : ''}
      </button>`).join('')
    : rows.map((item) => `<button type="button" class="wbmsg-row" data-notification-post="${e(item.postId)}" data-notification-comment="${e(item.commentId)}" data-notification-actor-id="${e(item.actorId)}" data-notification-actor-name="${e(item.actorName)}" data-notification-type="${e(item.type)}">
        <span class="wbmsg-avatar"><img src="${e(resolveDefaultAvatar('weibo'))}" alt=""></span>
        <span class="wbmsg-copy"><strong>${e(item.actorName)}</strong><span>${e(item.type === 'follow' ? '关注了你' : item.type === 'like' ? '赞了你的微博' : item.content)}</span></span>
        <time>${e(time(item.timestamp))}</time>${item.readAt ? '' : '<i></i>'}
      </button>`).join('');

  container.classList.add('weibo-page', 'weibo-messages-page');
  container.innerHTML = `
    <header class="navbar"><button type="button" class="navbar-btn wbmsg-back" aria-label="返回">${icon('back')}</button><h1 class="navbar-title">消息</h1><span class="navbar-btn"></span></header>
    <div class="page-scroll wbmsg-scroll">
      <div class="wbmsg-tabs" role="tablist">${Object.entries(TAB_LABELS).map(([key, label]) => `<button type="button" role="tab" data-message-tab="${key}" class="${tab === key ? 'is-active' : ''}" aria-selected="${tab === key}">${label}</button>`).join('')}</div>
      <div class="wbmsg-list">${items || `<div class="wbmsg-empty">暂无${e(TAB_LABELS[tab])}消息</div>`}</div>
    </div>`;
  container.querySelector('.wbmsg-back')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-message-tab]').forEach((button) => button.addEventListener('click', () => {
    const nextParams = { ...params, messageTab: button.dataset.messageTab };
    syncCurrentRoute('weibo-messages', nextParams);
    void render(container, nextParams);
  }));
  container.querySelectorAll('[data-dm-thread]').forEach((button) => button.addEventListener('click', () => navigate('weibo-dm', { ownerUserId, isSelf: true, threadId: button.dataset.dmThread })));
  container.querySelectorAll('[data-notification-post]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.notificationType === 'follow') {
      navigate('weibo-profile', { authorId: button.dataset.notificationActorId, authorName: button.dataset.notificationActorName });
      return;
    }
    if (!button.dataset.notificationPost) return;
    navigate('weibo-detail', { postId: button.dataset.notificationPost, focusCommentId: button.dataset.notificationComment });
  }));
}
