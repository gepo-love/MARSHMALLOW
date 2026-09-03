import { back, invalidateKeepAlive, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { ensureDefaultUser, getCurrentUserId } from '../core/user-slot.js';
import { normalizeMomentPost } from '../models/moment-post.js';
import {
  listMomentPostsForUser,
  listMomentPostsForAuthor,
  loadMomentsPrefs,
  saveMomentsPrefs,
  markMomentsSeen,
  loadAuthorMomentsProfile,
  saveAuthorMomentsProfile,
  allocMomentTimestamp,
  putMomentPost,
  ensureMomentsOwnershipHygiene,
  confirmMomentPostsForUser,
  sortMomentPostsForFeed,
} from '../core/moments/moments-store.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import {
  buildMomentsActors,
  sampleActorIds,
} from '../core/moments/moments-actors.js';
import {
  aiGenerateMomentsFeedBatch,
  aiFillMomentReactions,
  shouldBackfillMoment,
} from '../core/moments/moments-ai.js';
import {
  esc,
  renderMomentPostCard,
  renderMomentsHeader,
  setMomentsBusy,
} from '../core/moments/moments-ui.js';
import { openMomentsComposeModal } from '../components/moments-compose-modal.js';
import { openMomentsGenImageModal } from '../components/moments-gen-image-modal.js';
import { openMomentsSettingsModal } from '../components/moments-settings-modal.js';
import { pickGenerationScope } from '../components/generation-scope-picker.js';
import { isSocialImageGenEnabled } from '../core/social-image-generation.js';
import { bindMomentPostInteractions } from '../components/moments-interactions.js';
import { openFilePicker } from '../core/open-file-picker.js';
import { fileToCroppedCompressedDataUrl, IMAGE_CROP_PRESETS } from '../components/image-crop-modal.js';
import { getCharacter } from '../core/character-store.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { loadContactGroupsConfig } from '../core/contact-groups.js';
import {
  applyChatHubInsPageClasses,
  bindChatHubInsTabs,
  bindChatHubUserCard,
  buildChatHubInsChrome,
  chatHubInsToolbarIcon,
  loadChatHubInsContext,
} from '../core/chat/chat-hub-ins-chrome.js';
import { loadFlatStickerPool } from '../core/moments/moments-stickers.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import { getChatPlatformCopy } from '../core/chat/chat-platform-copy.js';
import { wechatGlyph } from '../core/chat/wechat-shell.js';
import { onStoreWrite } from '../core/db.js';

// 朋友圈专用设置入口：用最克制的三点，不复用全站设置图标。
const MOMENTS_SETTINGS_SVG = `
  <svg class="moments-settings-svg" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="6" cy="9" r="1.7"/>
    <circle cx="12" cy="9" r="1.7"/>
    <circle cx="18" cy="9" r="1.7"/>
  </svg>
`;

const MOMENTS_GENERATION_MARKER_PREFIX = 'momentsGenerationInFlight:';
const MOMENTS_INTERRUPTION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MOMENTS_FEED_PAGE_SIZE = 12;
const activeMomentsGenerationTokens = new Set();

function momentsGenerationMarkerKey(userId = '') {
  return `${MOMENTS_GENERATION_MARKER_PREFIX}${String(userId || 'guest').trim() || 'guest'}`;
}

function writeMomentsGenerationMarker(userId, token, stage = '') {
  try {
    localStorage.setItem(momentsGenerationMarkerKey(userId), JSON.stringify({
      token,
      stage: String(stage || '正在准备生成').trim().slice(0, 80),
      startedAt: Date.now(),
    }));
  } catch (_) { /* 存储不可用时仍允许生成 */ }
}

function updateMomentsGenerationMarker(userId, token, stage = '') {
  try {
    const key = momentsGenerationMarkerKey(userId);
    const current = JSON.parse(localStorage.getItem(key) || 'null');
    if (current?.token !== token) return;
    localStorage.setItem(key, JSON.stringify({
      ...current,
      stage: String(stage || current.stage || '').trim().slice(0, 80),
      updatedAt: Date.now(),
    }));
  } catch (_) { /* ignore */ }
}

function beginMomentsGeneration(userId, stage = '') {
  const token = `moments_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  activeMomentsGenerationTokens.add(token);
  writeMomentsGenerationMarker(userId, token, stage);
  return token;
}

function finishMomentsGeneration(userId, token) {
  activeMomentsGenerationTokens.delete(token);
  try {
    const key = momentsGenerationMarkerKey(userId);
    const current = JSON.parse(localStorage.getItem(key) || 'null');
    if (!current || current.token === token) localStorage.removeItem(key);
  } catch (_) { /* ignore */ }
}

function reportInterruptedMomentsGeneration(userId) {
  if (activeMomentsGenerationTokens.size) return;
  let marker = null;
  try {
    const key = momentsGenerationMarkerKey(userId);
    marker = JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.removeItem(key);
  } catch (_) {
    return;
  }
  if (!marker?.token) return;
  const age = Date.now() - Number(marker.updatedAt || marker.startedAt || 0);
  if (!Number.isFinite(age) || age < 0 || age > MOMENTS_INTERRUPTION_MAX_AGE_MS) return;
  const stage = String(marker.stage || '生成过程中').trim();
  showGenerationErrorReport({
    scope: '朋友圈 / 页面中断恢复',
    title: '朋友圈生成被页面重载中断',
    message: `上次生成停在“${stage}”，页面或 WebView 在完成前被重新加载。`,
    detail: '这通常是旧版 APK WebView 内存压力、系统回收渲染进程或页面意外刷新导致；本轮没有写入不完整内容。',
  });
  showToast('上次朋友圈生成被页面重载中断，请重试');
}

function momentsSettingsButtonHtml({ hubIns = false, label = '朋友圈' } = {}) {
  const classes = hubIns
    ? 'chat-hub-icon-btn moments-toolbar-btn moments-settings-btn'
    : 'navbar-btn moments-toolbar-btn moments-settings-btn';
  const settingsIcon = label === 'QQ空间'
    ? icon('settings', 'moments-settings-svg qq-space-settings-svg')
    : MOMENTS_SETTINGS_SVG;
  return `<button type="button" class="${classes}" data-moments-settings aria-label="${esc(label)}设置"><span class="svg-icon moments-settings-icon">${settingsIcon}</span></button>`;
}

function qqSpaceIcon(name = '') {
  const common = 'class="qq-space-shortcut-svg" viewBox="0 0 32 32" aria-hidden="true"';
  if (name === 'say') return `<svg ${common}><path d="M6 5.5h20v15H15l-6 5v-5H6v-15Z"/><circle cx="11" cy="13" r="1"/><circle cx="16" cy="13" r="1"/><circle cx="21" cy="13" r="1"/></svg>`;
  if (name === 'log') return `<svg ${common}><rect x="8" y="4.5" width="16" height="23" rx="3"/><path d="M12 4.5v8l4-2.6 4 2.6v-8"/></svg>`;
  if (name === 'album') return `<svg ${common}><rect x="5" y="6" width="22" height="20" rx="3"/><circle cx="12" cy="12" r="2"/><path d="m7.5 23 6.2-6 4.2 3.7 3.2-3 3.4 3.7"/></svg>`;
  if (name === 'message') return `<svg ${common}><path d="M7 9h18v15H7z"/><path d="M10 9V6h12v3M11 16h10M11 20h7"/></svg>`;
  return `<svg ${common}><path d="M7 10h18M7 16h18M7 22h18"/></svg>`;
}

function qqSpaceVisitorStats(user, { postCount = 0, friendCount = 0 } = {}) {
  const key = String(user?.id || user?.name || user?.nickname || 'guest');
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const stable = hash >>> 0;
  const activityFloor = Math.max(0, Number(postCount) || 0) * 7 + Math.max(0, Number(friendCount) || 0) * 3;
  return {
    total: Math.max(37 + (stable % 963), activityFloor),
    today: 1 + ((stable >>> 8) + Math.max(0, Number(postCount) || 0)) % 8,
  };
}

function renderQqSpaceHome(user, prefs = {}, { postCount = 0, friendCount = 0 } = {}) {
  const name = String(user?.name || user?.nickname || '我').trim() || '我';
  const avatar = user?.avatar
    ? `<img src="${esc(user.avatar)}" alt="" class="qq-space-avatar-img" />`
    : `<span class="qq-space-avatar-letter">${esc(name.slice(0, 1))}</span>`;
  const coverStyle = prefs.coverImage ? ` style="background-image:url('${esc(prefs.coverImage)}')"` : '';
  const visitors = qqSpaceVisitorStats(user, { postCount, friendCount });
  const shortcuts = [
    ['say', '说说', 'data-moments-compose'],
    ['log', '日志', 'data-qq-space-feed'],
    ['album', '相册', 'data-qq-space-photos'],
    ['message', '留言', 'data-qq-space-comments'],
    ['more', '更多', 'data-moments-settings'],
  ];
  return `
    <section class="qq-space-home">
      <button type="button" class="qq-space-cover${prefs.coverImage ? ' has-image' : ''}" data-moments-cover aria-label="更换空间封面"${coverStyle}>
      </button>
      <div class="qq-space-profile">
        <span class="qq-space-avatar">${avatar}</span>
        <div class="qq-space-profile-copy">
          <h1>${esc(name)}</h1>
          <p>访客总量 ${visitors.total} · 今日访客 +${visitors.today}</p>
        </div>
      </div>
      <nav class="qq-space-shortcuts" aria-label="空间功能">
        ${shortcuts.map(([key, label, attr]) => `<button type="button" ${attr}>${qqSpaceIcon(key)}<span>${label}</span></button>`).join('')}
      </nav>
      <div class="qq-space-compose-panel">
        <button type="button" class="qq-space-compose-entry" data-moments-compose>
          <span class="qq-space-compose-avatar">${avatar}</span>
          <span class="qq-space-compose-placeholder">分享新鲜事…</span>
          <span class="qq-space-compose-tool" aria-hidden="true">${qqSpaceIcon('album')}</span>
        </button>
        <button type="button" class="qq-space-ai-entry" data-moments-ai-gen data-moments-busy-lock aria-label="AI 生成 QQ 空间动态">
          ${icon('sparkle')}
        </button>
      </div>
    </section>
  `;
}

function renderWechatMomentsHome(user, prefs = {}) {
  const name = String(user?.name || user?.nickname || '我').trim() || '我';
  const avatar = user?.avatar
    ? `<img src="${esc(user.avatar)}" alt="" class="wechat-moments-avatar-img" />`
    : `<span class="wechat-moments-avatar-letter">${esc(name.slice(0, 1))}</span>`;
  const coverStyle = prefs.coverImage ? ` style="background-image:url('${esc(prefs.coverImage)}')"` : '';
  return `
    <section class="wechat-moments-hero${prefs.coverImage ? ' has-image' : ''}">
      <button type="button" class="wechat-moments-cover" data-moments-cover aria-label="更换朋友圈封面"${coverStyle}></button>
      <div class="wechat-moments-profile">
        <strong>${esc(name)}</strong>
        <span class="wechat-moments-avatar">${avatar}</span>
      </div>
    </section>
  `;
}

function buildFeedContext(posts, user, actors, nameMap, avatarMap) {
  const map = new Map(posts.map((p) => [p.id, p]));
  return {
    user,
    actors,
    nameMap,
    avatarMap,
    getPost: (id) => map.get(id) || null,
    setPost: (post) => {
      if (post?.id) map.set(post.id, post);
      return post;
    },
    onOpenProfile: (authorId) => navigate('moments/profile', { characterId: authorId }),
  };
}

async function assertMomentsSlotStillCurrent(userId) {
  if (String(await getCurrentUserId() || '').trim() !== String(userId || '').trim()) {
    throw new Error('生成期间已切换用户档位，本轮结果未写入');
  }
}

async function readBackGeneratedMoments(userId, insertedPosts = []) {
  return confirmMomentPostsForUser(userId, insertedPosts);
}

async function renderMomentsFeedShell(container, options = {}) {
  const perfStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let perfLastAt = perfStartedAt;
  const perfPhases = {};
  const markPerfPhase = (name) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    perfPhases[name] = Math.max(0, Math.round(now - perfLastAt));
    perfLastAt = now;
  };
  const renderSeq = Math.max(0, Number(container.dataset.momentsRenderSeq || 0) || 0) + 1;
  container.dataset.momentsRenderSeq = String(renderSeq);
  const user = options.user || await ensureDefaultUser();
  markPerfPhase('user');
  const userId = String(user?.id || '').trim();
  const feedLimit = Math.max(
    MOMENTS_FEED_PAGE_SIZE,
    Number(options.feedLimit || MOMENTS_FEED_PAGE_SIZE) || MOMENTS_FEED_PAGE_SIZE,
  );
  reportInterruptedMomentsGeneration(userId);
  const hygieneTask = ensureMomentsOwnershipHygiene().catch(() => 0);
  const supportTask = Promise.all([
    options.hubInsContext || loadChatHubInsContext(),
    loadMomentsPrefs(userId),
    buildMomentsActors(user),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
  ]);
  // 历史归属修复必须早于动态查询，但页面主题、角色、分组和表情资源可以同步准备。
  const postsTask = hygieneTask.then(() => (
    options.authorFilter
      ? listMomentPostsForAuthor(userId, options.authorFilter)
      : listMomentPostsForUser(userId, {
        limit: feedLimit + 1,
        requiredIds: (Array.isArray(options.promotedPosts) ? options.promotedPosts : [])
          .map((post) => post?.id)
          .filter(Boolean),
      })
  ));
  const [[hubContext, prefs, actorData, groupsConfig], loadedRows] = await Promise.all([
    supportTask,
    postsTask,
  ]);
  markPerfPhase('data');
  const hasEarlierPosts = !options.authorFilter && loadedRows.length > feedLimit;
  const loadedPosts = hasEarlierPosts ? loadedRows.slice(0, feedLimit) : loadedRows;
  const needsStickerPool = loadedPosts.some((post) => {
    const texts = [post?.content, ...(Array.isArray(post?.comments)
      ? post.comments.map((comment) => comment?.content || comment?.text || '')
      : [])];
    return texts.some((text) => /(?:\[表情包|\[贴纸|(?:表情包|贴纸)\s*[：:])/.test(String(text || '')));
  });
  const stickerPool = needsStickerPool ? await loadFlatStickerPool().catch(() => []) : [];
  markPerfPhase('stickers');
  const { hubInsChrome, windowTheme, seaTheme, chatPlatform } = hubContext;
  const platformCopy = getChatPlatformCopy(chatPlatform);
  const { actors, nameMap, avatarMap, characterIds, characters: slotCharacters } = actorData;
  const groupNameMap = new Map((groupsConfig.groups || []).map((g) => [g.id, g.name]));

  const promotedPosts = (Array.isArray(options.promotedPosts) ? options.promotedPosts : [])
    .filter((post) => String(post?.userId || post?.ownerUserId || '').trim() === userId);
  const promotedIds = promotedPosts.map((post) => post.id).filter(Boolean);
  let posts = loadedPosts;
  if (promotedPosts.length) {
    const merged = new Map(posts.map((post) => [post.id, post]));
    for (const post of promotedPosts) {
      if (!options.authorFilter || String(post.authorId || '').trim() === String(options.authorFilter)) {
        merged.set(post.id, post);
      }
    }
    // 恢复备份或回拨世界时间后，旧动态可能带着比当前更晚的时间戳。
    // 本批刚生成的记录必须先出现在顶部，不能只让访问量/条数变化、正文仍停在旧内容。
    posts = sortMomentPostsForFeed([...merged.values()], promotedIds);
  }
  posts = posts.map((p) => normalizeMomentPost(p));

  const showHubTabs = options.showHubTabs !== false;
  const showFab = options.showFab !== false;
  const showAiToolbar = options.showAiToolbar !== false;
  const pageTitle = options.pageTitle || platformCopy.momentsName;
  const profileAuthorId = String(options.profileAuthorId || '').trim();
  const qqSpaceHome = chatPlatform === 'qq' && !options.profileMode;
  const wechatMomentsHome = chatPlatform === 'wechat' && !options.profileMode;
  if (qqSpaceHome || wechatMomentsHome) {
    const newestTimestamp = posts.reduce((latest, post) => Math.max(latest, Number(post?.timestamp || 0) || 0), 0);
    const seenPrefs = await markMomentsSeen(userId, Math.max(Date.now(), newestTimestamp)).catch(() => null);
    if (seenPrefs) invalidateKeepAlive('chat');
  }
  const qqSpaceHomeHtml = qqSpaceHome
    ? renderQqSpaceHome(user, prefs, { postCount: posts.length, friendCount: actors.length })
    : '';

  let profileHeroHtml = options.profileHeroHtml || '';
  let authorProfile = null;
  if (options.profileMode && profileAuthorId) {
    const character = await getCharacter(profileAuthorId);
    const displayName = String(character?.customNickname || character?.name || nameMap.get(profileAuthorId) || 'TA').trim() || 'TA';
    authorProfile = await loadAuthorMomentsProfile(userId, profileAuthorId);
    const coverStyle = authorProfile.cover
      ? ` style="background-image:url('${esc(authorProfile.cover)}')"`
      : '';
    const signature = authorProfile.signature || '写句签名';
    profileHeroHtml = `
      <section class="moments-profile-hero scrapbook-card">
        <button type="button" class="moments-profile-cover${authorProfile.cover ? ' has-image' : ''}" data-moments-profile-cover${coverStyle} aria-label="设置背景图"></button>
        <div class="moments-profile-avatar">
          ${character ? characterAvatarHtml(character, { className: 'moments-profile-avatar-img' }) : `<span>${esc(displayName.slice(0, 1))}</span>`}
        </div>
        <h2 class="moments-profile-name">${esc(displayName)}</h2>
        <button type="button" class="moments-profile-sign${authorProfile.signature ? '' : ' is-empty'}" data-moments-profile-sign>${esc(signature)}</button>
      </section>
    `;
  }

  const scrollClass = hubInsChrome ? 'moments-scroll chat-hub-scroll--ins' : 'moments-scroll scrapbook-scroll';
  const emptyWrapClass = hubInsChrome ? 'chat-empty chat-empty--ins' : 'chat-empty scrapbook-empty';

  const feedHtml = posts.length
    ? posts.map((post) => renderMomentPostCard({
      ...post,
      authorName: nameMap.get(post.authorId) || post.authorName,
    }, { user, actors, nameMap, avatarMap, groupNameMap, stickerPool })).join('')
    : `
      <div class="${emptyWrapClass}">
        ${hubInsChrome ? '' : emptyIllustration(options.profileMode ? 'memory' : 'camera')}
        <div class="chat-empty-text">${options.emptyText || '还没有动态'}</div>
        <div class="chat-empty-hint">${options.emptyHint || (qqSpaceHome ? '点击“分享新鲜事”发布，或让 AI 生成角色动态' : wechatMomentsHome ? '点右上角相机发布或生成动态' : '点右下角发布，或让 AI 生成角色动态')}</div>
      </div>
    `;
  const loadEarlierHtml = hasEarlierPosts
    ? '<button type="button" class="moments-load-more" data-moments-load-more>加载更早动态</button>'
    : '';

  applyChatHubInsPageClasses(container, {
    hubInsChrome,
    windowTheme,
    seaTheme,
    chatPlatform,
    baseClass: hubInsChrome ? 'chat-hub-page' : 'moments-page',
    extraClasses: [
      hubInsChrome ? 'moments-page' : '',
      options.profileMode ? 'moments-profile-page' : '',
    ].filter(Boolean),
  });

  let headerHtml = '';
  if (wechatMomentsHome) {
    headerHtml = `
      <header class="wechat-moments-topbar">
        <button type="button" class="wechat-moments-topbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1>朋友圈</h1>
        <button type="button" class="wechat-moments-topbar-btn" data-moments-compose aria-label="发布动态">${wechatGlyph('camera')}</button>
      </header>
    `;
  } else if (hubInsChrome && showHubTabs) {
    const toolbarActions = qqSpaceHome
      ? ''
      : showAiToolbar
        ? `${chatHubInsToolbarIcon('moments-toolbar-btn', '生成动态并补旧动态互动', 'sparkle', { 'data-moments-ai-gen': '', 'data-moments-busy-lock': '' })} ${momentsSettingsButtonHtml({ hubIns: true, label: platformCopy.momentsName })}`
        : (profileAuthorId
          ? chatHubInsToolbarIcon('moments-toolbar-btn', `补 TA 的${platformCopy.momentsName}`, 'sparkle', { 'data-moments-profile-gen': '', 'data-moments-busy-lock': '' })
          : '');
    headerHtml = buildChatHubInsChrome({
      activeTab: 'moments',
      chatPlatform,
      user,
      toolbarActionsHtml: toolbarActions,
      showUserCard: !options.profileMode && !qqSpaceHome,
      showTabs: showHubTabs,
      pageTitle: options.profileMode ? pageTitle : '',
    });
  } else if (hubInsChrome && options.profileMode) {
    headerHtml = buildChatHubInsChrome({
      activeTab: 'moments',
      chatPlatform,
      toolbarActionsHtml: profileAuthorId
        ? chatHubInsToolbarIcon('moments-toolbar-btn', `补 TA 的${platformCopy.momentsName}`, 'sparkle', { 'data-moments-profile-gen': '', 'data-moments-busy-lock': '' })
        : '',
      showUserCard: false,
      showTabs: false,
      pageTitle,
    });
  } else {
    headerHtml = `
    <header class="navbar chat-hub-navbar moments-navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${esc(pageTitle)}</h1>
      <div class="moments-navbar-actions">
        ${showAiToolbar ? `
          <button type="button" class="navbar-btn moments-toolbar-btn" data-moments-ai-gen data-moments-busy-lock aria-label="生成动态并补旧动态互动">${icon('sparkle')}</button>
          ${momentsSettingsButtonHtml({ label: platformCopy.momentsName })}
        ` : (profileAuthorId
    ? `<button type="button" class="navbar-btn moments-toolbar-btn" data-moments-profile-gen data-moments-busy-lock aria-label="补 TA 的${esc(platformCopy.momentsName)}">${icon('sparkle')}</button>`
    : '<span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>')}
      </div>
    </header>
    ${showHubTabs ? `
      <nav class="chat-hub-tabs" aria-label="Chat 分区">
        <button type="button" class="chat-hub-tab" data-tab="messages">消息</button>
        <button type="button" class="chat-hub-tab is-active" data-tab="moments">${esc(platformCopy.momentsFeedName)}</button>
        <button type="button" class="chat-hub-tab" data-tab="intercepts">陌生消息</button>
        <button type="button" class="chat-hub-tab" data-tab="backstage">秘密基地</button>
      </nav>
    ` : ''}
    `;
  }

  // 点赞/评论等 onRefresh 会整页 innerHTML 重绘；先记下滚动位置，避免弹回顶部。
  const prevScroll = captureScrollerTop(container, '.moments-scroll');

  // 较早发起的异步刷新不能在生成完成后回来覆盖新列表。
  if (Number(container.dataset.momentsRenderSeq || 0) !== renderSeq) return null;
  container.innerHTML = `
    ${headerHtml}
    <main class="${scrollClass}">
      ${wechatMomentsHome ? '<div class="wechat-pull-refresh" aria-live="polite">下拉刷新</div>' : ''}
      ${options.profileMode ? profileHeroHtml : (qqSpaceHome ? qqSpaceHomeHtml : wechatMomentsHome ? renderWechatMomentsHome(user, prefs) : (hubInsChrome ? '' : renderMomentsHeader(user, prefs)))}
      <section class="moments-feed">${feedHtml}${loadEarlierHtml}</section>
    </main>
    ${showFab && !qqSpaceHome && !wechatMomentsHome ? `<button type="button" class="moments-fab" aria-label="发布动态">${icon('plus')}</button>` : ''}
    <div class="moments-busy-overlay" aria-hidden="true">
      <div class="moments-busy-spinner"></div>
      <div class="moments-busy-text">正在处理…</div>
    </div>
  `;
  markPerfPhase('dom');
  restoreScrollerTop(container, '.moments-scroll', prevScroll);

  const refresh = async (refreshOptions = {}) => {
    await renderMomentsFeedShell(container, {
      ...options,
      ...refreshOptions,
      hubInsContext: { hubInsChrome, windowTheme, seaTheme, chatPlatform },
    });
  };

  // 自动生成、聊天意图发圈可能在朋友圈页面停留期间完成。事件携带本批已回读记录，
  // 直接提升进下一次渲染，既即时显示，也绕开恢复旧备份后短暂失效的 userId 索引。
  if (typeof container.__momentsAutoRefreshCleanup === 'function') {
    container.__momentsAutoRefreshCleanup();
  }
  const onAutoGenerated = (event) => {
    const detail = event?.detail || {};
    if (String(detail.userId || '').trim() !== userId) return;
    const promoted = (Array.isArray(detail.posts) ? detail.posts : [])
      .map((post) => normalizeMomentPost(post))
      .filter((post) => String(post.userId || post.ownerUserId || '').trim() === userId);
    Promise.resolve(refresh({ promotedPosts: promoted })).catch((error) => {
      console.warn('[moments] auto-generated refresh failed', error);
    });
  };
  // 整页重绘会反复进入本函数。写入队列必须挂在路由容器上跨重绘保留，
  // 否则旧监听器正在刷新时新监听器又收到下一条，两个 renderSeq 互相抢占后仍可能漏末次赞评。
  let momentsStoreRuntime = container.__momentsStoreRefreshRuntime;
  if (momentsStoreRuntime && momentsStoreRuntime.userId !== userId) {
    momentsStoreRuntime.cleanup?.();
    momentsStoreRuntime = null;
  }
  if (!momentsStoreRuntime) {
    momentsStoreRuntime = {
      userId,
      refresh,
      running: false,
      pending: false,
      disposed: false,
      promotedPosts: new Map(),
    };
    const runtime = momentsStoreRuntime;
    const drainMomentsStoreRefresh = async () => {
      if (runtime.running || runtime.disposed) return;
      runtime.running = true;
      try {
        while (container.isConnected && !runtime.disposed && runtime.pending) {
          runtime.pending = false;
          const promotedPosts = [...runtime.promotedPosts.values()];
          runtime.promotedPosts.clear();
          // IndexedDB 的索引快照在旧 WebView / 数据库进程刚恢复时可能仍是旧值。
          // 写入通知已经带着事务提交后的完整记录，直接提升进本轮渲染，不能再只靠索引回查。
          await runtime.refresh(promotedPosts.length ? { promotedPosts } : {});
        }
      } catch (error) {
        console.warn('[moments] store refresh failed', error);
      } finally {
        runtime.running = false;
        // 刷新期间若又完成一次写入，必须再排一轮；不能像单个 queued 布尔值那样吞掉末次赞评。
        if (container.isConnected && !runtime.disposed && runtime.pending) {
          Promise.resolve().then(drainMomentsStoreRefresh);
        }
      }
    };
    const stopMomentsStoreRefresh = onStoreWrite('momentsPosts', (_key, detail = {}) => {
      if (!container.isConnected || runtime.disposed) return;
      const writtenPost = detail?.record ? normalizeMomentPost(detail.record) : null;
      const writtenUserId = String(writtenPost?.userId || writtenPost?.ownerUserId || '').trim();
      if (writtenUserId && writtenUserId !== runtime.userId) return;
      if (writtenPost?.id) runtime.promotedPosts.set(writtenPost.id, writtenPost);
      runtime.pending = true;
      Promise.resolve().then(drainMomentsStoreRefresh);
    });
    const onMomentsStoreRouteDisposed = (event) => {
      if (event?.detail?.container === container) runtime.cleanup?.();
    };
    runtime.cleanup = () => {
      if (runtime.disposed) return;
      runtime.disposed = true;
      stopMomentsStoreRefresh();
      window.removeEventListener('marshmallow-route-disposed', onMomentsStoreRouteDisposed);
      runtime.promotedPosts.clear();
      if (container.__momentsStoreRefreshRuntime === runtime) {
        delete container.__momentsStoreRefreshRuntime;
      }
    };
    window.addEventListener('marshmallow-route-disposed', onMomentsStoreRouteDisposed);
    container.__momentsStoreRefreshRuntime = runtime;
  } else {
    momentsStoreRuntime.refresh = refresh;
  }
  const onRouteDisposed = (event) => {
    if (event?.detail?.container === container) container.__momentsAutoRefreshCleanup?.();
  };
  const cleanupAutoRefresh = () => {
    window.removeEventListener('moments-auto-generated', onAutoGenerated);
    window.removeEventListener('marshmallow-route-disposed', onRouteDisposed);
    if (container.__momentsAutoRefreshCleanup === cleanupAutoRefresh) {
      delete container.__momentsAutoRefreshCleanup;
    }
  };
  container.__momentsAutoRefreshCleanup = cleanupAutoRefresh;
  window.addEventListener('moments-auto-generated', onAutoGenerated);
  window.addEventListener('marshmallow-route-disposed', onRouteDisposed);

  const ctx = buildFeedContext(posts, user, actors, nameMap, avatarMap);
  ctx.onRefresh = refresh;
  ctx.commentLevel = prefs.autoGen?.reactionCommentLevel;
  const interactionContext = {
    ...ctx,
    setBusy: (on, msg, opts) => setMomentsBusy(container, on, msg, opts),
  };

  async function prependPublishedMoment(post) {
    const feed = container.querySelector('.moments-feed');
    if (!feed || !post?.id) return refresh({ promotedPosts: [post] });
    ctx.setPost(post);
    const stage = document.createElement('div');
    stage.innerHTML = renderMomentPostCard({
      ...post,
      authorName: nameMap.get(post.authorId) || post.authorName,
    }, { user, actors, nameMap, avatarMap, groupNameMap, stickerPool });
    const article = stage.querySelector('.moment-post');
    if (!article) return refresh({ promotedPosts: [post] });
    await bindMomentPostInteractions(stage, interactionContext);
    feed.querySelector('.chat-empty, .scrapbook-empty')?.remove();
    feed.prepend(article);
  }

  if (wechatMomentsHome) {
    const scroller = container.querySelector('.moments-scroll');
    const indicator = container.querySelector('.wechat-pull-refresh');
    let pull = null;
    scroller?.addEventListener('touchstart', (event) => {
      const touch = event.touches?.[0];
      if (!touch || scroller.scrollTop > 0 || event.touches.length !== 1) {
        pull = null;
        return;
      }
      pull = { x: touch.clientX, y: touch.clientY, distance: 0, vertical: false };
    }, { passive: true });
    scroller?.addEventListener('touchmove', (event) => {
      if (!pull || !event.touches?.length) return;
      const touch = event.touches[0];
      const dx = touch.clientX - pull.x;
      const dy = touch.clientY - pull.y;
      if (!pull.vertical) {
        if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
        if (dy <= 0 || Math.abs(dy) <= Math.abs(dx)) {
          pull = null;
          return;
        }
        pull.vertical = true;
      }
      pull.distance = Math.min(96, Math.max(0, dy));
      indicator?.classList.toggle('is-pulling', pull.distance >= 18);
      if (indicator) indicator.textContent = pull.distance >= 64 ? '松开刷新' : '下拉刷新';
    }, { passive: true });
    const finishPull = async () => {
      if (!pull) return;
      const shouldRefresh = pull.vertical && pull.distance >= 64;
      pull = null;
      if (!indicator) return;
      if (!shouldRefresh) {
        indicator.classList.remove('is-pulling');
        indicator.textContent = '下拉刷新';
        return;
      }
      indicator.classList.remove('is-pulling');
      indicator.classList.add('is-refreshing');
      indicator.textContent = '正在刷新';
      try {
        await refresh();
      } catch (error) {
        indicator.classList.remove('is-refreshing');
        indicator.textContent = '下拉刷新';
        showToast(error?.message || '刷新失败');
      }
    };
    scroller?.addEventListener('touchend', finishPull, { passive: true });
    scroller?.addEventListener('touchcancel', () => {
      pull = null;
      indicator?.classList.remove('is-pulling');
      if (indicator) indicator.textContent = '下拉刷新';
    }, { passive: true });
  }

  container.querySelector('[data-back]')?.addEventListener('click', () => back());

  container.querySelector('[data-moments-load-more]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '正在加载…';
    try {
      await refresh({ feedLimit: feedLimit + MOMENTS_FEED_PAGE_SIZE });
    } catch (error) {
      button.disabled = false;
      button.textContent = '加载更早动态';
      showToast(error?.message || '加载失败');
    }
  });

  if (hubInsChrome && showHubTabs && !wechatMomentsHome) {
    bindChatHubInsTabs(container, 'moments');
    if (!options.profileMode) {
      bindChatHubUserCard(container, user, {
        onSlotChanged: async () => {
          await refresh();
        },
      });
    }
  } else {
    container.querySelectorAll('.chat-hub-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-tab');
        if (next === 'moments') return;
        navigate(next === 'messages' ? 'chat' : next === 'intercepts' ? 'chat/intercepts' : 'chat/backstage', {}, true);
      });
    });
  }

  container.querySelector('[data-moments-cover]')?.addEventListener('click', () => {
    openFilePicker({
      accept: 'image/*',
      onChange: async (files) => {
        const file = files?.[0];
        if (!file) return;
        try {
          const coverPreset = chatPlatform === 'wechat' ? IMAGE_CROP_PRESETS.wechatCover : IMAGE_CROP_PRESETS.cover;
          const coverImage = await fileToCroppedCompressedDataUrl(file, coverPreset);
          if (!coverImage) return;
          await saveMomentsPrefs(userId, { coverImage });
          await refresh();
        } catch (err) {
          showToast(err?.message || '封面设置失败');
        }
      },
    });
  });

  container.querySelector('[data-moments-profile-cover]')?.addEventListener('click', () => {
    if (!profileAuthorId) return;
    openFilePicker({
      accept: 'image/*',
      onChange: async (files) => {
        const file = files?.[0];
        if (!file) return;
        try {
          const cover = await fileToCroppedCompressedDataUrl(file, IMAGE_CROP_PRESETS.cover);
          if (!cover) return;
          await saveAuthorMomentsProfile(userId, profileAuthorId, { cover });
          await refresh();
        } catch (err) {
          showToast(err?.message || '背景图设置失败');
        }
      },
    });
  });

  container.querySelector('[data-moments-profile-sign]')?.addEventListener('click', () => {
    if (!profileAuthorId) return;
    openTextEditorModal({
      title: '签名',
      value: authorProfile?.signature || '',
      placeholder: '写句签名',
      multiline: false,
      onSave: async (text) => {
        await saveAuthorMomentsProfile(userId, profileAuthorId, { signature: String(text || '').trim() });
        await refresh();
      },
    });
  });

  container.querySelector('[data-moments-profile-gen]')?.addEventListener('click', async () => {
    if (!profileAuthorId) return;
    const genEnabled = await isSocialImageGenEnabled('momentsImages');
    const imageOptions = await openMomentsGenImageModal({
      genEnabled,
      title: '生成选项',
      cacheKey: 'momentsGenerationOptions',
    });
    if (!imageOptions) return;
    const reactionIds = sampleActorIds(characterIds.filter((id) => id !== profileAuthorId), 12);
    const generationToken = beginMomentsGeneration(userId, `正在补 ${pageTitle}`);
    setMomentsBusy(container, true, `正在补 ${pageTitle} …`);
    try {
      let total = 0;
      const insertedPosts = [];
      const rounds = prefs.autoGen?.manualPostCount || 3;
      for (let i = 0; i < rounds; i += 1) {
        setMomentsBusy(container, true, `正在生成第 ${i + 1}/${rounds} 条…`);
        const generated = await aiGenerateMomentsFeedBatch({
          user,
          authorIds: [profileAuthorId],
          reactionIds,
          count: 1,
          commentLevel: prefs.autoGen?.reactionCommentLevel,
          imageOptions,
          onProgress: (msg) => {
            updateMomentsGenerationMarker(userId, generationToken, msg);
            setMomentsBusy(container, true, msg, { imageGen: /配图/.test(String(msg || '')) });
          },
        });
        if (!generated.length) continue;
        await assertMomentsSlotStillCurrent(userId);
        const ts = await allocMomentTimestamp(userId);
        const inserted = await putMomentPost({
          id: `moment_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
          userId,
          timestamp: ts,
          visibility: 'all',
          ...generated[0],
        }, userId);
        insertedPosts.push(inserted);
        total += 1;
      }
      if (!total) {
        showGenerationErrorReport({
          scope: `${platformCopy.momentsName} / 角色主页生成`,
          title: `角色${platformCopy.momentsName}生成空回`,
          message: '本轮没有生成出可用动态，请打开报错详情查看原因',
          detail: 'aiGenerateMomentsFeedBatch 多轮返回空。',
        });
        showToast('本轮没有生成出可用动态');
        return;
      }
      const confirmedPosts = await readBackGeneratedMoments(userId, insertedPosts);
      await refresh({ promotedPosts: confirmedPosts });
      showToast(`已补 ${confirmedPosts.length} 条动态`);
    } catch (err) {
      showGenerationErrorReport(generationErrorFromCatch(err, {
        scope: `${platformCopy.momentsName} / 角色主页生成`,
        title: `角色${platformCopy.momentsName}生成失败`,
      }));
      showToast(err?.message || '生成失败');
    } finally {
      finishMomentsGeneration(userId, generationToken);
      setMomentsBusy(container, false);
    }
  });

  container.querySelectorAll('.moments-fab, [data-moments-compose]').forEach((trigger) => trigger.addEventListener('click', () => {
    openMomentsComposeModal({
      user,
      actors,
      enableAi: wechatMomentsHome && showAiToolbar,
      onGenerate: () => runMomentsAiGeneration(),
      onOpenAiSettings: () => openMomentsGenerationSettings(),
      onPublish: async (draft) => {
        await assertMomentsSlotStillCurrent(userId);
        const ts = await allocMomentTimestamp(userId);
        const post = normalizeMomentPost({ ...draft, userId, timestamp: ts });
        await putMomentPost(post, userId);
        await prependPublishedMoment(post);
        if (prefs.autoGen?.autoReactAfterPublish === false) {
          showToast('已发布');
          return;
        }
        showToast('已发布，正在回复评论…');
        // “主要发帖人”只控制谁自动发帖，不能顺带把用户动态的互动池缩成同一批人。
        // 评论仍从当前档位的完整角色范围里按真实社交关系筛选。
        const reactionActorIds = characterIds;
        if (!reactionActorIds.length) return;
        setMomentsBusy(container, true, '正在回复评论…');
        try {
          const result = await runBackfillForPosts([post], { actorIds: reactionActorIds });
          if (result.done) await refresh();
        } catch (err) {
          showToast(`评论回复失败：${err?.message || '请稍后重试'}`);
        } finally {
          setMomentsBusy(container, false);
        }
      },
    }).catch((err) => {
      console.warn('[moments] compose modal failed', err);
      showToast('打开发布页失败，请重试');
    });
  }));

  const scrollSpaceTarget = (selector, emptyMessage = '') => {
    const target = container.querySelector(selector);
    if (!target) {
      if (emptyMessage) showToast(emptyMessage);
      return;
    }
    target.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };
  container.querySelector('[data-qq-space-feed]')?.addEventListener('click', () => scrollSpaceTarget('.moments-feed'));
  container.querySelector('[data-qq-space-photos]')?.addEventListener('click', () => scrollSpaceTarget('.moment-post:has(.moment-images, .moment-textimg)', '还没有照片动态'));
  container.querySelector('[data-qq-space-comments]')?.addEventListener('click', () => scrollSpaceTarget('.moment-comments.has-content', '还没有留言'));

  // 补互动核心：对给定的动态列表逐条调 AI 补赞/评论，不做「是否已完整」判断——
  // 判断是否需要补是用户在选择器里自己决定的，这里只管执行。
  const runBackfillForPosts = async (targets, { onProgress, actorIds: preferredActorIds = null } = {}) => {
    if (!targets.length) return { done: 0, attempted: 0 };
    let done = 0;
    let skippedNoPool = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const post = targets[i];
      onProgress?.(`补全第 ${i + 1}/${targets.length} 条评论…`);
      const authorId = String(post.authorId || '').trim();
      const baseActorIds = Array.isArray(preferredActorIds) ? preferredActorIds : characterIds;
      const actorIds = authorId && authorId !== userId
        ? baseActorIds
        : sampleActorIds(baseActorIds, 10);
      try {
        const patch = await aiFillMomentReactions({
          user,
          post,
          actorIds,
          commentLevel: prefs.autoGen?.reactionCommentLevel,
        });
        if (patch) {
          await assertMomentsSlotStillCurrent(userId);
          await putMomentPost({ ...post, ...patch }, userId);
          done += 1;
        }
      } catch (err) {
        if (err?.code === 'moments-no-reaction-candidates') skippedNoPool += 1;
      }
    }
    return { done, attempted: targets.length, skippedNoPool };
  };

  // AI 生成动态后顺便给互动稀薄的旧动态补几条：静默按阈值挑选即可，不打断主流程
  const backfillExistingMoments = async (targetPosts, { limit = 5, onProgress } = {}) => {
    const targets = targetPosts.filter(shouldBackfillMoment).slice(0, limit);
    if (!targets.length) return 0;
    const { done } = await runBackfillForPosts(targets, { onProgress });
    return done;
  };

  async function runMomentsAiGeneration() {
    if (!characterIds.length) {
      showToast(`当前档位还没有可${platformCopy.postVerb}的角色`);
      return;
    }
    const pickedScope = await pickGenerationScope({
      scopeKey: 'moments-manual',
      characters: slotCharacters,
      title: `本轮${platformCopy.momentsName}角色`,
    });
    if (!pickedScope) return;
    const scopedIds = pickedScope.characters.map((row) => row.id);
    if (!scopedIds.length) {
      showToast('所选范围里没有角色');
      return;
    }
    const genEnabled = await isSocialImageGenEnabled('momentsImages');
    const imageOptions = await openMomentsGenImageModal({
      genEnabled,
      title: '生成选项',
      cacheKey: 'momentsGenerationOptions',
    });
    if (!imageOptions) return;
    const generationToken = beginMomentsGeneration(userId, '正在生成动态');
    setMomentsBusy(container, true, '正在生成动态…', { imageGen: true });
    try {
      const generated = await aiGenerateMomentsFeedBatch({
        user,
        authorIds: scopedIds,
        reactionIds: scopedIds,
        count: prefs.autoGen?.manualPostCount || 3,
        commentLevel: prefs.autoGen?.reactionCommentLevel,
        imageOptions,
        onProgress: (msg) => {
          updateMomentsGenerationMarker(userId, generationToken, msg);
          setMomentsBusy(container, true, msg, { imageGen: /配图/.test(String(msg || '')) });
        },
      });
      if (!generated.length) {
        showGenerationErrorReport({
          scope: `${platformCopy.momentsName} / 动态生成`,
          title: `${platformCopy.momentsName}生成空回`,
          message: '本轮没有生成出可用动态，请打开报错详情查看原因',
          detail: 'aiGenerateMomentsFeedBatch 返回空数组。',
        });
        showToast('本轮没有生成出可用动态');
        return;
      }
      await assertMomentsSlotStillCurrent(userId);
      const insertedPosts = [];
      for (let i = 0; i < generated.length; i += 1) {
        await assertMomentsSlotStillCurrent(userId);
        const writeStage = `写入第 ${i + 1}/${generated.length} 条`;
        updateMomentsGenerationMarker(userId, generationToken, writeStage);
        setMomentsBusy(container, true, `${writeStage}…`, { imageGen: true });
        const ts = await allocMomentTimestamp(userId);
        const inserted = await putMomentPost({
          id: `moment_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
          userId,
          timestamp: ts,
          visibility: 'all',
          ...generated[i],
        }, userId);
        insertedPosts.push(inserted);
      }
      // 顺便给之前互动不足的旧动态（包括 user 自己发的）补几条评论/赞
      const backfilled = await backfillExistingMoments(posts, {
        limit: 3,
        onProgress: (msg) => {
          updateMomentsGenerationMarker(userId, generationToken, msg);
          setMomentsBusy(container, true, msg, { imageGen: /配图/.test(String(msg || '')) });
        },
      }).catch(() => 0);
      const confirmedPosts = await readBackGeneratedMoments(userId, insertedPosts);
      await refresh({ promotedPosts: confirmedPosts });
      showToast(backfilled ? `已生成 ${confirmedPosts.length} 条动态，补全 ${backfilled} 条旧评论` : `已生成 ${confirmedPosts.length} 条动态`);
    } catch (err) {
      showGenerationErrorReport(generationErrorFromCatch(err, {
        scope: `${platformCopy.momentsName} / 动态生成`,
        title: `${platformCopy.momentsName}生成失败`,
      }));
      showToast(err?.message || '生成失败');
    } finally {
      finishMomentsGeneration(userId, generationToken);
      setMomentsBusy(container, false);
    }
  }

  container.querySelector('[data-moments-ai-gen]')?.addEventListener('click', runMomentsAiGeneration);

  async function openMomentsGenerationSettings() {
    const freshPrefs = await loadMomentsPrefs(userId);
    const result = await openMomentsSettingsModal({
      prefs: freshPrefs,
      characters: characterIds.map((id) => ({ id, name: nameMap.get(id) || id })),
      platform: chatPlatform,
    });
    if (!result) return;
    await saveMomentsPrefs(userId, result);
    showToast('已保存');
  }

  container.querySelector('[data-moments-settings]')?.addEventListener('click', openMomentsGenerationSettings);

  await bindMomentPostInteractions(container, interactionContext);
  markPerfPhase('bindings');
  const perfTotalMs = Math.max(0, Math.round(perfLastAt - perfStartedAt));
  if (perfTotalMs >= 180) {
    console.debug('[route-perf] chat/moments', { totalMs: perfTotalMs, phases: perfPhases, posts: posts.length });
    import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
      type: 'route_phase_timing',
      level: 'info',
      message: `Route phases: chat/moments (${perfTotalMs}ms)`,
      context: { path: 'chat/moments', totalMs: perfTotalMs, phases: perfPhases, posts: posts.length },
    })).catch(() => {});
  }

  return { user, refresh };
}

export default async function render(container) {
  await renderMomentsFeedShell(container, {
    showHubTabs: true,
    showFab: true,
    showAiToolbar: true,
  });
}

/** 角色 scoped · 他的朋友圈主页 */
export async function renderCharacterMomentsProfile(container, params = {}) {
  const user = await ensureDefaultUser();
  const hubInsContext = await loadChatHubInsContext();
  const platformCopy = getChatPlatformCopy(hubInsContext.chatPlatform);
  const characterId = String(params.characterId || '').trim();
  const character = characterId ? await getCharacter(characterId) : null;
  const displayName = String(character?.customNickname || character?.name || 'TA').trim() || 'TA';

  await renderMomentsFeedShell(container, {
    user,
    authorFilter: characterId,
    profileAuthorId: characterId,
    pageTitle: platformCopy.profileTitle(displayName),
    hubInsContext,
    profileMode: true,
    showHubTabs: false,
    showFab: false,
    showAiToolbar: false,
    emptyText: '还没有 TA 的动态',
    emptyHint: `点右上角补 TA 的动态，或在${platformCopy.momentsName}生成`,
  });
}
