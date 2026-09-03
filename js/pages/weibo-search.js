import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { listActiveWeiboPosts } from '../core/weibo/weibo-post-store.js';
import { buildWeiboDiscoveryIndex, searchWeiboDiscovery } from '../core/weibo/weibo-discovery-service.js';
import { formatSocialCount } from '../core/weibo/weibo-metrics.js';
import { isPrivateWeiboPost } from '../core/weibo/weibo-post-utils.js';
import { icon } from '../components/svg-icons.js';
import { resolveAvatarUrl } from '../core/resolve-avatar-url.js';

const TABS = { all: '综合', users: '用户', posts: '微博', topics: '话题/超话' };

function e(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function excerpt(value = '', max = 100) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export default async function render(container, params = {}) {
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const ownerUserId = currentUserId || 'guest';
  const metaKey = `weiboMeta_${ownerUserId}`;
  const [user, metaRow, posts] = await Promise.all([
    currentUserId ? db.get('users', currentUserId) : null,
    db.get('settings', metaKey),
    listActiveWeiboPosts({ ownerUserId }),
  ]);
  const meta = metaRow?.value || { profiles: {}, followingIds: [] };
  meta.profiles ||= {};
  meta.followingIds ||= [];
  const query = String(params.q || '').trim();
  const activeTab = TABS[params.tab] ? params.tab : 'all';
  const index = buildWeiboDiscoveryIndex({ posts, meta, currentUser: user });
  const results = searchWeiboDiscovery(index, query);

  const userRows = (await Promise.all(results.profiles.map(async (profile) => {
    const avatar = await resolveAvatarUrl(profile.authorId, profile.authorName, profile.avatar, 'weibo');
    return `
    <article class="wbsearch-user" data-profile-key="${e(profile.key)}">
      <button type="button" class="wbsearch-avatar" data-open-profile><img src="${e(avatar)}" alt=""></button>
      <button type="button" class="wbsearch-user-copy" data-open-profile>
        <strong>${e(profile.authorName)}</strong>
        <span>${e(profile.bio || `${profile.postCount} 条微博 · 粉丝 ${formatSocialCount(profile.fans)}`)}</span>
      </button>
      ${profile.isSelf ? '' : `<button type="button" class="wbsearch-follow${profile.following ? ' is-following' : ''}" data-follow>${profile.following ? '已关注' : '关注'}</button>`}
    </article>`;
  }))).join('');
  const postRows = results.posts.map((post) => `
    <button type="button" class="wbsearch-post" data-post-id="${e(post.id)}">
      <span><strong>${e(post.authorName || '微博用户')}</strong><time>${e(new Date(post.timestamp || Date.now()).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }))}</time></span>
      <p>${e(excerpt(post.content) || '图片微博')}</p>
      <small>评论 ${formatSocialCount(isPrivateWeiboPost(post) ? 0 : (post.comments || post.commentList?.length || 0))} · 赞 ${formatSocialCount(isPrivateWeiboPost(post) ? 0 : (post.likes || 0))}</small>
    </button>`).join('');
  const topicRows = results.topics.map((topic) => `
    <button type="button" class="wbsearch-topic" data-topic="${e(topic.label)}">
      <span>#</span><strong>#${e(topic.label)}#</strong><small>${topic.postCount} 条微博</small>
    </button>`).join('');
  const sections = [];
  if ((activeTab === 'all' || activeTab === 'users') && userRows) sections.push(`<section><h2>用户</h2>${userRows}</section>`);
  if ((activeTab === 'all' || activeTab === 'posts') && postRows) sections.push(`<section><h2>微博</h2>${postRows}</section>`);
  if ((activeTab === 'all' || activeTab === 'topics') && topicRows) sections.push(`<section><h2>话题/超话</h2>${topicRows}</section>`);
  const trendLabels = (meta.trending || []).map((item) => String(typeof item === 'string' ? item : item?.topic || item?.title || item?.name || '')
    .replace(/^#+|#+$/g, '').trim()).filter(Boolean);
  const discoveryPosts = (await Promise.all(index.posts.slice(0, 4).map(async (post) => `<button type="button" class="wbdiscover-post" data-post-id="${e(post.id)}">
    <span class="wbdiscover-post-avatar"><img src="${e(await resolveAvatarUrl(post.authorId, post.authorName, post.avatar, 'weibo'))}" alt=""></span>
    <span><strong>${e(post.authorName || '微博用户')}</strong><small>${e(excerpt(post.content, 72) || '图片微博')}</small></span>
  </button>`))).join('');
  const discoveryHtml = `
    <div class="wbdiscover-hero">
      <form class="weibo-searchbar wbsearch-form wbdiscover-search">
        <input type="search" class="weibo-search-input" name="q" placeholder="搜你想看的" aria-label="微博搜索" />
        <button type="submit" class="weibo-search-btn">搜索</button>
      </form>
    </div>
    <div class="page-scroll wbdiscover-scroll">
      <section class="wbdiscover-hot-card">
        <div class="wbdiscover-section-head"><strong>微博热搜</strong><span><button type="button" data-discover-generate>生成</button><button type="button" data-open-hot-rank>热搜榜 ›</button></span></div>
        <div class="wbdiscover-hot-grid">${trendLabels.slice(0, 10).map((label, index) => `<button type="button" data-topic="${e(label)}"><span>${e(label)}</span>${index === 0 ? '<i>爆</i>' : index < 3 ? '<i>热</i>' : ''}</button>`).join('') || '<div class="wbdiscover-empty">暂无热搜，刷新微博后会出现在这里</div>'}</div>
        <button type="button" class="wbdiscover-more" data-open-hot-rank>更多热搜 ›</button>
      </section>
      <button type="button" class="wbdiscover-banner" data-open-hot-rank><span>微博热搜</span><strong>发现此刻正在发生</strong><i>查看完整榜单</i></button>
      <div class="wbdiscover-categories"><button class="is-active">热点</button><button>星品</button><button>热转</button><button>发布</button><button>指数</button></div>
      <section class="wbdiscover-feed">${discoveryPosts || '<div class="wbdiscover-empty">还没有可发现的微博</div>'}</section>
    </div>
    <nav class="weibo-tabbar" aria-label="微博导航">
      <button type="button" data-discover-nav="home">${icon('lucideHouse')}<span class="weibo-tabbar-label">首页</span></button>
      <button type="button" class="is-active">${icon('lucideCompass')}<span class="weibo-tabbar-label">发现</span></button>
      <button type="button" class="weibo-tabbar-compose" data-discover-nav="compose" aria-label="发布微博">${icon('lucidePlus')}</button>
      <button type="button" data-discover-nav="message">${icon('lucideMessage')}<span class="weibo-tabbar-label">消息</span></button>
      <button type="button" data-discover-nav="me">${icon('lucideUser')}<span class="weibo-tabbar-label">我</span></button>
    </nav>`;

  container.classList.add('weibo-page', 'weibo-search-page');
  container.innerHTML = query ? `
    <header class="weibo-appbar wbsearch-head">
      <button type="button" class="weibo-appbar-btn wbsearch-back" aria-label="返回">${icon('back')}</button>
      <form class="weibo-searchbar wbsearch-form">
        <input type="search" class="weibo-search-input" name="q" value="${e(query)}" placeholder="搜用户、微博、话题" aria-label="微博搜索" />
        <button type="submit" class="weibo-search-btn">搜索</button>
      </form>
    </header>
    <div class="wbsearch-tabs" role="tablist">
      ${Object.entries(TABS).map(([key, label]) => `<button type="button" role="tab" data-tab="${key}" class="${activeTab === key ? 'is-active' : ''}" aria-selected="${activeTab === key}">${label}</button>`).join('')}
    </div>
    <div class="page-scroll wbsearch-scroll">
      ${sections.join('') || '<div class="wbsearch-empty">没有找到相关内容</div>'}
    </div>` : discoveryHtml;

  container.querySelector('.wbsearch-back')?.addEventListener('click', () => back());
  container.querySelector('.wbsearch-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = String(new FormData(event.currentTarget).get('q') || '').trim();
    navigate('weibo-search', { q, tab: activeTab });
  });
  container.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    navigate('weibo-search', { q: query, tab: button.dataset.tab });
  }));
  container.querySelectorAll('[data-open-profile]').forEach((button) => button.addEventListener('click', () => {
    const row = button.closest('[data-profile-key]');
    const profile = index.profiles.find((item) => item.key === row?.dataset.profileKey);
    if (profile) navigate('weibo-profile', { authorId: profile.authorId, authorName: profile.authorName });
  }));
  container.querySelectorAll('[data-follow]').forEach((button) => button.addEventListener('click', async () => {
    const key = button.closest('[data-profile-key]')?.dataset.profileKey;
    if (!key) return;
    const set = new Set(meta.followingIds.map(String));
    if (set.has(key)) set.delete(key); else set.add(key);
    meta.followingIds = [...set];
    await db.put('settings', { key: metaKey, value: meta });
    await render(container, params);
  }));
  container.querySelectorAll('[data-post-id]').forEach((button) => button.addEventListener('click', () => navigate('weibo-detail', { postId: button.dataset.postId })));
  container.querySelectorAll('[data-topic]').forEach((button) => button.addEventListener('click', () => navigate('weibo-topic', { topic: button.dataset.topic })));
  container.querySelectorAll('[data-open-hot-rank]').forEach((button) => button.addEventListener('click', () => navigate('weibo-hot-rank')));
  container.querySelector('[data-discover-generate]')?.addEventListener('click', () => navigate('weibo', {
    panel: 'topics',
    topicGeneratorReturn: 'discover',
  }, true));
  container.querySelector('[data-discover-nav="home"]')?.addEventListener('click', () => back());
  container.querySelector('[data-discover-nav="message"]')?.addEventListener('click', () => navigate('weibo-messages', { ownerUserId }, true));
  container.querySelector('[data-discover-nav="me"]')?.addEventListener('click', () => navigate('weibo-profile', { authorId: currentUserId, authorName: user?.weiboNickname || user?.nickname || user?.name || '我' }, true));
  container.querySelector('[data-discover-nav="compose"]')?.addEventListener('click', async () => {
    meta.pendingWeiboComposer = { topic: '', createdAt: Date.now() };
    await db.put('settings', { key: metaKey, value: meta });
    navigate('weibo', {}, true);
  });
}
