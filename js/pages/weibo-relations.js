import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { listActiveWeiboPosts } from '../core/weibo/weibo-post-store.js';
import { listWeiboNotifications } from '../core/weibo/weibo-notification-store.js';
import { buildWeiboDiscoveryIndex } from '../core/weibo/weibo-discovery-service.js';
import { formatSocialCount } from '../core/weibo/weibo-metrics.js';
import { icon } from '../components/svg-icons.js';
import { resolveAvatarUrl } from '../core/resolve-avatar-url.js';

function e(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function render(container, params = {}) {
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const ownerUserId = currentUserId || 'guest';
  const metaKey = `weiboMeta_${ownerUserId}`;
  const [user, metaRow, posts, followEvents] = await Promise.all([
    currentUserId ? db.get('users', currentUserId) : null,
    db.get('settings', metaKey),
    listActiveWeiboPosts({ ownerUserId }),
    listWeiboNotifications(ownerUserId, { type: 'follow' }),
  ]);
  const meta = metaRow?.value || { profiles: {}, followingIds: [] };
  meta.profiles ||= {};
  meta.followingIds ||= [];
  const index = buildWeiboDiscoveryIndex({ posts, meta, currentUser: user });
  const activeTab = params.tab === 'followers' ? 'followers' : 'following';
  const byKey = new Map(index.profiles.flatMap((profile) => [
    [String(profile.key), profile],
    [String(profile.authorId || ''), profile],
    [String(profile.authorName || ''), profile],
  ]));
  const followingSet = new Set(meta.followingIds.map(String));
  const following = [...followingSet].map((key) => byKey.get(key) || {
    key,
    authorId: key,
    authorName: meta.profiles?.[key]?.name || key,
    bio: meta.profiles?.[key]?.bio || '',
    fans: Number(meta.profiles?.[key]?.fans || 0),
  });
  const followerMap = new Map();
  for (const item of followEvents) {
    const key = String(item.actorId || item.actorName || '');
    if (!key || followerMap.has(key)) continue;
    followerMap.set(key, byKey.get(key) || {
      key,
      authorId: item.actorId || '',
      authorName: item.actorName || '微博用户',
      bio: '',
      fans: 0,
    });
  }
  const rows = activeTab === 'following' ? following : [...followerMap.values()];
  const rowsHtml = (await Promise.all(rows.map(async (profile) => {
    const isFollowing = followingSet.has(String(profile.key)) || followingSet.has(String(profile.authorId));
    const avatar = await resolveAvatarUrl(profile.authorId, profile.authorName, profile.avatar, 'weibo');
    return `<article class="wbsearch-user" data-profile-key="${e(profile.key)}" data-author-id="${e(profile.authorId)}" data-author-name="${e(profile.authorName)}">
      <button type="button" class="wbsearch-avatar" data-open-profile><img src="${e(avatar)}" alt=""></button>
      <button type="button" class="wbsearch-user-copy" data-open-profile><strong>${e(profile.authorName)}</strong><span>${e(profile.bio || `粉丝 ${formatSocialCount(profile.fans || 0)}`)}</span></button>
      <button type="button" class="wbsearch-follow${isFollowing ? ' is-following' : ''}" data-follow>${isFollowing ? '已关注' : '关注'}</button>
    </article>`;
  }))).join('');

  container.classList.add('weibo-page', 'weibo-relations-page');
  container.innerHTML = `
    <header class="weibo-appbar"><button type="button" class="weibo-appbar-btn wbrel-back" aria-label="返回">${icon('back')}</button><div class="weibo-appbar-title"><strong>${e(user?.weiboNickname || user?.nickname || user?.name || '我')}</strong><span>关系</span></div><span class="weibo-appbar-btn" aria-hidden="true"></span></header>
    <div class="wbsearch-tabs wbrel-tabs" role="tablist">
      <button type="button" role="tab" data-tab="following" class="${activeTab === 'following' ? 'is-active' : ''}" aria-selected="${activeTab === 'following'}">关注 ${following.length}</button>
      <button type="button" role="tab" data-tab="followers" class="${activeTab === 'followers' ? 'is-active' : ''}" aria-selected="${activeTab === 'followers'}">粉丝 ${followerMap.size}</button>
    </div>
    <div class="page-scroll wbsearch-scroll"><section class="wbrel-list">${rowsHtml || `<div class="wbsearch-empty">暂无${activeTab === 'following' ? '关注' : '粉丝'}记录</div>`}</section></div>`;

  container.querySelector('.wbrel-back')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => navigate('weibo-relations', { tab: button.dataset.tab })));
  container.querySelectorAll('[data-open-profile]').forEach((button) => button.addEventListener('click', () => {
    const row = button.closest('[data-profile-key]');
    navigate('weibo-profile', { authorId: row?.dataset.authorId || '', authorName: row?.dataset.authorName || '' });
  }));
  container.querySelectorAll('[data-follow]').forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('[data-profile-key]');
    const key = String(row?.dataset.profileKey || row?.dataset.authorId || '').trim();
    if (!key) return;
    const set = new Set(meta.followingIds.map(String));
    if (set.has(key)) set.delete(key); else set.add(key);
    meta.followingIds = [...set];
    await db.put('settings', { key: metaKey, value: meta });
    await render(container, params);
  }));
}
