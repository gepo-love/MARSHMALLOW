import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { isActiveWeiboPost } from '../core/weibo/weibo-post-store.js';
import { formatSocialCount, estimateCommentLike, simulatePostMetrics } from '../core/weibo/weibo-metrics.js';
import { cleanSocialDisplayText } from '../core/social-helpers.js';
import { icon } from '../components/svg-icons.js';
import { resolveAvatarUrl } from '../core/resolve-avatar-url.js';
import { isPrivateWeiboPost } from '../core/weibo/weibo-post-utils.js';

const TABS = { reposts: '转发', comments: '评论', likes: '赞' };

function e(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function compact(value = '', max = 120) {
  const clean = cleanSocialDisplayText(value).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function time(value) {
  return new Date(Number(value || Date.now())).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function uniqueActors(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const actorId = String(row?.authorId || row?.id || '').trim();
    const actorName = String(row?.authorName || row?.name || '').trim();
    const key = actorId && actorId !== 'npc' ? actorId : actorName;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function render(container, params = {}) {
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const ownerUserId = currentUserId || 'guest';
  const postId = String(params.postId || '').trim();
  const activeTab = TABS[params.tab] ? params.tab : 'comments';
  const [post, user] = await Promise.all([
    postId ? db.get('weiboPosts', postId) : null,
    currentUserId ? db.get('users', currentUserId) : null,
  ]);
  container.classList.add('weibo-page', 'weibo-interactions-page');
  if (!post || String(post.ownerUserId || '') !== ownerUserId || !isActiveWeiboPost(post)) {
    container.innerHTML = `<header class="weibo-appbar"><button type="button" class="weibo-appbar-btn wbint-back" aria-label="返回">${icon('back')}</button><div class="weibo-appbar-title"><strong>微博互动</strong></div><span class="weibo-appbar-btn"></span></header><div class="wbsearch-empty">微博已删除或不可见</div>`;
    container.querySelector('.wbint-back')?.addEventListener('click', () => back());
    return;
  }
  const privatePost = isPrivateWeiboPost(post);
  const comments = privatePost ? [] : (Array.isArray(post.commentList) ? post.commentList : []);
  const reposts = privatePost ? [] : (Array.isArray(post.repostList) ? post.repostList : []);
  const selfLiked = (post.metadata?.likedByUserIds || []).map(String).includes(String(currentUserId));
  const likeActors = privatePost ? [] : uniqueActors([
    ...(Array.isArray(post.metadata?.likeUsers) ? post.metadata.likeUsers : []),
    ...(selfLiked && user ? [{ authorId: currentUserId, authorName: user.weiboNickname || user.nickname || user.name || '我', isSelf: true }] : []),
  ]);
  const simulated = simulatePostMetrics(post);
  const counts = {
    reposts: Math.max(reposts.length, Number(post.reposts || 0), simulated.reposts),
    comments: Math.max(comments.length, Number(post.comments || 0), simulated.comments),
    likes: privatePost ? 0 : Math.max(likeActors.length, Number(post.likes || 0), simulated.likes),
  };

  let listHtml = '';
  if (activeTab === 'comments') {
    const commentIds = new Set(comments.map((item) => String(item.id || '')));
    listHtml = (await Promise.all(comments.map(async (comment) => `
      <button type="button" class="wbint-comment${comment.replyToCommentId && commentIds.has(String(comment.replyToCommentId)) ? ' is-child' : ''}" data-comment-id="${e(comment.id)}">
        <span class="wbsearch-avatar"><img src="${e(await resolveAvatarUrl(comment.authorId, comment.author, comment.avatar, 'weibo'))}" alt=""></span>
        <span class="wbint-copy"><strong>${e(comment.author || '微博用户')}${comment.replyTo ? `<i> 回复 ${e(comment.replyTo)}</i>` : ''}</strong><span>${e(compact(comment.content) || '图片评论')}</span><time>${e(time(comment.timestamp))}</time></span>
        <small>${icon('weiboLike')} ${formatSocialCount(estimateCommentLike(post, comment))}</small>
      </button>`))).join('');
  } else if (activeTab === 'reposts') {
    listHtml = (await Promise.all(reposts.map(async (item) => `
      <article class="wbint-comment" data-author-id="${e(item.authorId)}" data-author-name="${e(item.author)}">
        <button type="button" class="wbsearch-avatar" data-open-profile><img src="${e(await resolveAvatarUrl(item.authorId, item.author, item.avatar, 'weibo'))}" alt=""></button>
        <span class="wbint-copy"><strong>${e(item.author || '微博用户')}</strong><span>${e(compact(item.content) || '转发微博')}</span><time>${e(time(item.timestamp))}</time></span>
      </article>`))).join('');
  } else {
    listHtml = (await Promise.all(likeActors.map(async (item) => `
      <article class="wbsearch-user" data-author-id="${e(item.authorId || item.id)}" data-author-name="${e(item.authorName || item.name)}">
        <button type="button" class="wbsearch-avatar" data-open-profile><img src="${e(await resolveAvatarUrl(item.authorId || item.id, item.authorName || item.name, item.avatar, 'weibo'))}" alt=""></button>
        <button type="button" class="wbsearch-user-copy" data-open-profile><strong>${e(item.authorName || item.name || '微博用户')}</strong><span>${item.isSelf ? '我赞过这条微博' : '赞了这条微博'}</span></button>
      </article>`))).join('');
  }

  const postAvatar = await resolveAvatarUrl(post.authorId, post.authorName, post.avatar, 'weibo');

  container.innerHTML = `
    <header class="weibo-appbar wbint-appbar"><button type="button" class="weibo-appbar-btn wbint-back" aria-label="返回">${icon('back')}</button><span class="wbint-author-avatar"><img src="${e(postAvatar)}" alt=""></span><div class="weibo-appbar-title"><strong>${e(post.authorName || '微博用户')}</strong><span>${e(compact(post.content, 22) || '图片微博')}</span></div><button type="button" class="weibo-appbar-btn wbint-detail">原文</button></header>
    <div class="wbsearch-tabs wbint-tabs" role="tablist">${Object.entries(TABS).map(([key, label]) => `<button type="button" role="tab" data-tab="${key}" class="${activeTab === key ? 'is-active' : ''}" aria-selected="${activeTab === key}">${label} ${formatSocialCount(counts[key])}</button>`).join('')}</div>
    <div class="page-scroll wbint-scroll">${listHtml || `<div class="wbsearch-empty">暂无可查看的${TABS[activeTab]}记录</div>`}</div>
    <footer class="wbint-bottom-actions"><button type="button" data-bottom-tab="reposts">${icon('weiboRepost')}${formatSocialCount(counts.reposts)}</button><button type="button" data-bottom-tab="comments" class="is-active">${icon('weiboComment')}${formatSocialCount(counts.comments)}</button><button type="button" data-bottom-tab="likes">${icon('weiboLike')}${formatSocialCount(counts.likes)}</button></footer>`;

  container.querySelector('.wbint-back')?.addEventListener('click', () => back());
  container.querySelector('.wbint-detail')?.addEventListener('click', () => navigate('weibo-detail', { postId }));
  container.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => navigate('weibo-interactions', { postId, tab: button.dataset.tab })));
  container.querySelectorAll('[data-bottom-tab]').forEach((button) => button.addEventListener('click', () => navigate('weibo-interactions', { postId, tab: button.dataset.bottomTab })));
  container.querySelectorAll('[data-comment-id]').forEach((button) => button.addEventListener('click', () => navigate('weibo-detail', { postId, focusCommentId: button.dataset.commentId })));
  container.querySelectorAll('[data-open-profile]').forEach((button) => button.addEventListener('click', () => {
    const row = button.closest('[data-author-id]');
    navigate('weibo-profile', { authorId: row?.dataset.authorId || '', authorName: row?.dataset.authorName || '' });
  }));
}
