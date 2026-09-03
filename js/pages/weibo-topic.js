import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { getAllStickersFlat } from '../core/chat/sticker-resolve.js';
import {
  cleanSocialDisplayText,
  getSafeCharacterDisplayName,
  resolveSocialAuthorLabel,
} from '../core/social-helpers.js';
import {
  buildSocialPostDisplayParts,
  renderSocialPostImageStrip,
  bindWeiboImageLightbox,
} from '../components/social-sticker-picker.js';
import { resolveAvatarUrl } from '../core/resolve-avatar-url.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import { formatSocialCount } from '../core/weibo/weibo-metrics.js';
import { weiboTranslationSuffixHtml } from '../core/weibo/weibo-post-utils.js';
import { bindNarrationTranslationToggle } from '../core/narration-translation.js';
import { bindWeiboRichTextLinks } from '../components/weibo-rich-links.js';
import { listActiveWeiboPosts } from '../core/weibo/weibo-post-store.js';
import {
  checkInWeiboSuperTopic,
  getOrCreateWeiboSuperTopic,
  isWeiboSuperTopicFeaturedPost,
  normalizeWeiboTopicKey,
  saveWeiboSuperTopic,
  sortWeiboSuperTopicPosts,
  toggleWeiboSuperTopicFollow,
} from '../core/weibo/weibo-topic-store.js';

function escapeAttr(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ownerId(userId = '') {
  return userId || 'guest';
}

function metaKey(userId = '') {
  return `weiboMeta_${ownerId(userId)}`;
}

function trendTopicText(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    return String(item.topic || item.title || item.name || item.keyword || '').trim();
  }
  return '';
}

function displayTopicLabel(topic = '') {
  const key = normalizeWeiboTopicKey(topic);
  return key ? `#${key}#` : '超话';
}

function postMatchesTopic(post, topicKey) {
  if (!topicKey) return false;
  const blob = [
    post?.content,
    ...(Array.isArray(post?.tags) ? post.tags : []),
    post?.metadata?.superTopicKey,
    post?.metadata?.repostFrom?.content,
  ].filter(Boolean).join(' ').toLowerCase();
  return blob.includes(topicKey);
}

function isOfficialPost(post) {
  return String(post?.authorId || '') === 'platform_official'
    || /平台官方|官方账号|系统公告/.test(String(post?.authorName || ''));
}

function localTodayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function removeTopicFromTrending(trending, topicKey) {
  const list = Array.isArray(trending) ? trending : [];
  const next = list.filter((item) => normalizeWeiboTopicKey(trendTopicText(item)) !== topicKey);
  return { next, removed: next.length !== list.length };
}

async function renderTopicPost(post, stickerPool = []) {
  const display = buildSocialPostDisplayParts(cleanSocialDisplayText(post.content), post.images, stickerPool);
  const safeAuthorName = resolveSocialAuthorLabel(post.authorName, { fallback: '匿名用户' });
  const avatarUrl = await resolveAvatarUrl(post.authorId, safeAuthorName, post.avatar, 'weibo');
  const avatar = `<div class="weibo-topic-avatar"><img src="${escapeAttr(avatarUrl || resolveDefaultAvatar('weibo'))}" alt="" loading="lazy" decoding="async" /></div>`;
  const badges = [
    post?.metadata?.superTopicPinned ? '<span class="wb-super-badge is-pinned">置顶</span>' : '',
    isWeiboSuperTopicFeaturedPost(post) ? '<span class="wb-super-badge">精华</span>' : '',
    isOfficialPost(post) ? '<span class="wb-super-badge is-host">主持</span>' : '',
  ].filter(Boolean).join('');
  return `
    <article class="weibo-topic-post card-block" data-post-id="${escapeAttr(post.id)}">
      <div class="weibo-topic-post-head">
        <div class="weibo-topic-author-row">
          ${avatar}
          <button type="button" class="weibo-topic-author weibo-profile-link" data-author-id="${escapeAttr(post.authorId || '')}" data-author-name="${escapeAttr(safeAuthorName)}">
            ${escapeHtml(safeAuthorName)}${isOfficialPost(post) ? '<span class="weibo-v-badge">V</span>' : ''}
          </button>
          ${badges}
        </div>
        <span class="weibo-topic-time">${escapeHtml(formatTime(post.timestamp || 0))}</span>
      </div>
      <div class="weibo-topic-body social-richtext">${display.richTextHtml}</div>
      ${weiboTranslationSuffixHtml(post.content || '', post.metadata?.contentTranslation || post.contentTranslation || '')}
      ${renderSocialPostImageStrip(display.mergedImages, 'weibo', { stickerUrls: display.stickerImageUrls })}
      <div class="wb-super-post-metrics">
        <span>转发 ${formatSocialCount(post.reposts || 0)}</span>
        <span>评论 ${formatSocialCount(post.comments || 0)}</span>
        <span>赞 ${formatSocialCount(post.likes || 0)}</span>
      </div>
    </article>
  `;
}

async function renderPostList(posts = [], stickerPool = []) {
  const rows = [];
  for (const post of posts) rows.push(await renderTopicPost(post, stickerPool));
  return rows.join('');
}

export default async function render(container, params) {
  const topicKey = normalizeWeiboTopicKey(params?.topic || '');
  const label = displayTopicLabel(topicKey);
  const userIdRow = await db.get('settings', 'currentUserId');
  const userId = userIdRow?.value || '';
  const ownerUserId = ownerId(userId);
  const weiboMetaKey = metaKey(userId);
  const metaRow = await db.get('settings', weiboMetaKey);
  const meta = metaRow?.value && typeof metaRow.value === 'object' ? metaRow.value : { trending: [], news: [] };
  const trending = Array.isArray(meta.trending) ? meta.trending : [];
  const trendRank = trending.findIndex((item) => normalizeWeiboTopicKey(trendTopicText(item)) === topicKey);
  const relatedNews = (Array.isArray(meta.news) ? meta.news : [])
    .filter((item) => String(item?.title || item?.text || item || '').toLowerCase().includes(topicKey))
    .slice(0, 3);

  const allPosts = await listActiveWeiboPosts({ ownerUserId });
  const matched = allPosts.filter((post) => postMatchesTopic(post, topicKey));
  let superTopic = await getOrCreateWeiboSuperTopic(ownerUserId, topicKey, {
    postCount: matched.length,
    memberCount: Math.max(23, matched.length * 37 + 23),
  });
  if (superTopic.postCount !== matched.length) {
    superTopic = await saveWeiboSuperTopic(ownerUserId, topicKey, { postCount: matched.length });
  }
  const channelPosts = sortWeiboSuperTopicPosts(matched, superTopic.channel);
  const stickerPool = await getAllStickersFlat();
  const postCards = await renderPostList(channelPosts, stickerPool);
  const checkedIn = superTopic.lastCheckInDate === localTodayKey();
  const channelEmpty = superTopic.channel === 'featured' ? '还没有精华帖' : '还没有人发帖';

  container.classList.add('weibo-page', 'weibo-topic-page', 'weibo-super-topic-page');
  container.innerHTML = `
    <header class="navbar wb-super-navbar">
      <button type="button" class="navbar-btn wbt-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${escapeHtml(superTopic.name)}超话</h1>
      ${trendRank >= 0
        ? `<button type="button" class="navbar-btn wbt-remove-hot" aria-label="从热搜移除">${icon('more')}</button>`
        : '<span class="navbar-btn" aria-hidden="true"></span>'}
    </header>
    <div class="page-scroll weibo-topic-scroll wb-super-scroll">
      <section class="wb-super-hero">
        <div class="wb-super-cover${superTopic.cover ? ' has-image' : ''}" ${superTopic.cover ? `style="background-image:url('${escapeAttr(superTopic.cover)}')"` : ''}></div>
        <div class="wb-super-profile">
          <div class="wb-super-avatar">#</div>
          <div class="wb-super-identity">
            <h2>${escapeHtml(label)}超话</h2>
            <p>${escapeHtml(superTopic.description)}</p>
          </div>
          <button type="button" class="wb-super-follow${superTopic.following ? ' is-following' : ''}" data-wb-super-follow>${superTopic.following ? '已关注' : '关注'}</button>
        </div>
        <div class="wb-super-stats">
          <span><strong>${formatSocialCount(superTopic.memberCount)}</strong>成员</span>
          <span><strong>${formatSocialCount(matched.length)}</strong>帖子</span>
          <span><strong>${escapeHtml(superTopic.hostName)}</strong>主持人</span>
        </div>
        <div class="wb-super-actions">
          <button type="button" data-wb-super-checkin class="${checkedIn ? 'is-done' : ''}">${checkedIn ? `已签到 · 连续 ${superTopic.checkInStreak} 天` : '签到'}</button>
          <button type="button" data-wb-super-compose>发帖</button>
          <button type="button" data-wb-super-generate>生成新讨论</button>
        </div>
      </section>
      ${relatedNews.length && superTopic.channel === 'popular' ? `
        <section class="wb-super-news" aria-label="相关简讯">
          ${relatedNews.map((item) => `<span>${escapeHtml(item?.title || item?.text || item)}</span>`).join('')}
        </section>
      ` : ''}
      <div class="wb-super-tabs" role="tablist" aria-label="超话频道">
        <button type="button" role="tab" data-wb-super-channel="popular" aria-selected="${superTopic.channel === 'popular'}" class="${superTopic.channel === 'popular' ? 'is-active' : ''}">热门</button>
        <button type="button" role="tab" data-wb-super-channel="latest" aria-selected="${superTopic.channel === 'latest'}" class="${superTopic.channel === 'latest' ? 'is-active' : ''}">最新</button>
        <button type="button" role="tab" data-wb-super-channel="featured" aria-selected="${superTopic.channel === 'featured'}" class="${superTopic.channel === 'featured' ? 'is-active' : ''}">精华</button>
      </div>
      <section class="wb-super-feed">
        ${postCards || `<div class="wb-super-empty">${channelEmpty}</div>`}
      </section>
    </div>
  `;
  bindWeiboRichTextLinks(container);

  const queueWeiboHomeAction = async (key) => {
    const latestRow = await db.get('settings', weiboMetaKey);
    const latest = latestRow?.value && typeof latestRow.value === 'object' ? { ...latestRow.value } : {};
    latest[key] = { topic: topicKey, createdAt: Date.now() };
    await db.put('settings', { key: weiboMetaKey, value: latest });
    navigate('weibo');
  };

  container.querySelector('.wbt-back')?.addEventListener('click', () => back());
  container.querySelector('[data-wb-super-follow]')?.addEventListener('click', async () => {
    await toggleWeiboSuperTopicFollow(ownerUserId, topicKey);
    showToast(superTopic.following ? '已取消关注' : '已关注');
    await render(container, params);
  });
  container.querySelector('[data-wb-super-checkin]')?.addEventListener('click', async () => {
    const result = await checkInWeiboSuperTopic(ownerUserId, topicKey);
    showToast(result.checkedIn ? `签到成功，已连续 ${result.profile.checkInStreak} 天` : '今天已签到');
    if (result.checkedIn) await render(container, params);
  });
  container.querySelector('[data-wb-super-compose]')?.addEventListener('click', () => {
    void queueWeiboHomeAction('pendingWeiboComposer');
  });
  container.querySelector('[data-wb-super-generate]')?.addEventListener('click', () => {
    void queueWeiboHomeAction('pendingTopicGenerator');
  });
  container.querySelectorAll('[data-wb-super-channel]').forEach((button) => {
    button.addEventListener('click', async () => {
      const channel = String(button.dataset.wbSuperChannel || 'popular');
      if (channel === superTopic.channel) return;
      await saveWeiboSuperTopic(ownerUserId, topicKey, { channel });
      await render(container, params);
    });
  });
  container.querySelector('.wbt-remove-hot')?.addEventListener('click', async () => {
    if (!window.confirm(`从热搜榜移除「${label}」？超话和帖子会保留。`)) return;
    const latestRow = await db.get('settings', weiboMetaKey);
    const latest = latestRow?.value && typeof latestRow.value === 'object' ? { ...latestRow.value } : {};
    const result = removeTopicFromTrending(latest.trending, topicKey);
    latest.trending = result.next;
    await db.put('settings', { key: weiboMetaKey, value: latest });
    showToast(result.removed ? '已从热搜移除' : '该话题已不在热搜榜');
    await render(container, params);
  });
  container.querySelectorAll('.weibo-profile-link').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      navigate('weibo-profile', {
        authorId: button.dataset.authorId || '',
        authorName: resolveSocialAuthorLabel(
          getSafeCharacterDisplayName(button.dataset.authorId || button.dataset.authorName || '', { fallback: button.dataset.authorName || '用户' }),
          { fallback: '用户' },
        ),
      });
    });
  });
  container.querySelectorAll('.weibo-topic-post').forEach((article) => {
    article.addEventListener('click', (event) => {
      if (event.target.closest('button, .weibo-img-cell, [data-translation-toggle]')) return;
      if (article.dataset.postId) navigate('weibo-detail', { postId: article.dataset.postId });
    });
  });
  bindWeiboImageLightbox(container);
  bindNarrationTranslationToggle(container, {
    onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
  });
}
