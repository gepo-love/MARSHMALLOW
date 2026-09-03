import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { createMessage } from '../models/chat.js';
import { resolveGenerationMaxTokens } from '../core/api.js';
import { chatJsonGeneration } from '../core/chat-json-generation.js';
import { showToast } from '../components/toast.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { openForumLongImageExport } from '../components/forum-long-image-export.js';
import { icon } from '../components/svg-icons.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { openForwardPicker } from '../components/forward-picker.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import { getVirtualNow, nextChatMessageTimestamp } from '../core/virtual-time-shim.js';
import { buildForumAiSystemPrompt } from '../core/context/build-forum-context.js';
import { getAllStickersFlat } from '../core/chat/sticker-resolve.js';
import { stripLeakedCharacterCodes } from '../core/chat/character-code-fallback.js';
import { saveMessage, updateChatPreview } from '../core/chat-store.js';
import { isAnonymousChat, isUserPresentInChat } from '../core/chat-helpers.js';
import {
  buildSocialPostDisplayParts,
  mountStickerPickerAfterTextarea,
  renderSocialPostMediaBlock,
  renderSocialPostImageStrip,
  bindSocialPostMediaInteractions,
  stripSocialStickerMarkers,
  stripSocialStickerTranslationArtifacts,
} from '../components/social-sticker-picker.js';
import { setButtonLoading, setGenStatus, setGenerationActivity } from '../components/generation-busy.js';
import {
  beginManualGeneration,
  finishManualGeneration,
  isManualGenerationRunning,
  subscribeManualGeneration,
  updateManualGeneration,
} from '../core/manual-generation-state.js';
import {
  pickGenerationScope,
  resolveSavedGenerationScope,
} from '../components/generation-scope-picker.js';
import { listForumVisibleCharacters } from '../core/forum/forum-character-scope.js';
import { loadForumMetaCompat, saveForumMetaCompat } from '../core/forum/forum-meta-store.js';
import { normalizeForumAutoPrefs } from '../core/forum/forum-auto.js';
import {
  listForumVests,
  resolveVestIdentity,
  resolveSelfDisplayName,
  buildVestSelectOptionsHtml,
  getForumVestById,
  loadForumProfile,
} from '../core/forum-vests.js';
import { getUserDisplayName } from '../models/user.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
  messageLikelyNeedsTranslation,
  sanitizeAiTranslation,
} from '../core/translation-utils.js';
import { bindNarrationTranslationToggle } from '../core/narration-translation.js';
import {
  buildForumPublicAliasBoundary,
  isPrivateForumVestAuthor,
  normalizeForumAuthorOwnership,
  sanitizeGeneratedForumReplyAuthor,
} from '../core/forum-identity.js';
import {
  applyForumGenerationActorPlanBestEffort,
  materializeForumActors,
  resolveForumActor,
} from '../core/forum/forum-actors.js';
import {
  loadForumEngagement,
  toggleForumThreadEngagement,
} from '../core/forum/forum-engagement.js';

// 自动补评论可能在另一轮论坛生成尚未结束时触发。按帖子去重排队，
// 避免用户连续发言时丢掉触发，也避免同一楼层被重复补两轮。
const queuedAutomaticReplyThreads = new Set();

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

function safeForumActorLabel(value, fallback = '论坛匿名') {
  const raw = String(value || '').trim();
  return stripLeakedCharacterCodes(raw, { fallbackLabel: fallback }).trim() || fallback;
}

function safeForumDisplayText(value) {
  return stripLeakedCharacterCodes(String(value || ''), { fallbackLabel: '论坛匿名' });
}

function formatTime(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function forumTranslationSuffixHtml(source = '', translation = '', stickerPool = [], target = '') {
  const src = stripSocialStickerMarkers(source, stickerPool);
  if (!src) return '';
  const translationWithoutStickers = stripSocialStickerTranslationArtifacts(source, translation, stickerPool);
  const sanitized = sanitizeAiTranslation(src, translationWithoutStickers);
  if (!sanitized && !messageLikelyNeedsTranslation(src)) return '';
  const escAttr = (v) => esc(v).replace(/"/g, '&quot;');
  return `<button type="button" class="chat-bubble-translate-btn forum-translate-btn" data-translation-toggle data-translation-source="${escAttr(src)}" data-forum-translation-target="${escAttr(target)}" aria-expanded="false">翻译</button><div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-divider"></div><div class="chat-bubble-translation-text">${esc(sanitized || '')}</div></div>`;
}

export function cacheForumTranslation(thread = {}, target = '', source = '', translation = '', stickerPool = []) {
  const src = String(source || '').trim();
  const zh = sanitizeAiTranslation(src, translation);
  if (!src || !zh) return false;
  if (target === 'thread') {
    const currentSource = stripSocialStickerMarkers(safeForumDisplayText(thread.content), stickerPool).trim();
    if (currentSource !== src) return false;
    thread.contentTranslation = zh;
    return true;
  }
  const match = String(target || '').match(/^reply:(\d+)(?::child:(\d+))?$/);
  if (!match) return false;
  const reply = thread.replies?.[Number(match[1])];
  const row = match[2] == null ? reply : reply?.childReplies?.[Number(match[2])];
  const currentSource = stripSocialStickerMarkers(safeForumDisplayText(row?.content), stickerPool).trim();
  if (!row || currentSource !== src) return false;
  row.translation = zh;
  return true;
}

function extractJsonObject(raw = '') {
  const body = String(raw || '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return body.slice(start, end + 1).trim();
}

function parseForumDetailJson(raw) {
  const first = extractJsonObject(raw);
  if (!first) return null;
  try {
    return JSON.parse(first);
  } catch (_) { return null; }
}

async function loadForumMetaRow(userId) {
  return loadForumMetaCompat(userId);
}

async function loadForumSection(userId, sectionId) {
  const meta = await loadForumMetaRow(userId);
  const sections = Array.isArray(meta.sections) ? meta.sections : [];
  return sections.find((s) => s.id === sectionId) || null;
}

async function saveForumMetaLastVest(userId, vestId) {
  const meta = await loadForumMetaRow(userId);
  meta.lastVestId = vestId;
  await saveForumMetaCompat(userId, meta);
}

function parseReplyPrefix(content = '') {
  const text = String(content || '').trim();
  const patterns = [
    /^\[回复\s*#?(\d+)\s*[:：]\s*["“「]?([^"”」\]]*)["”」]?\]\s*([\s\S]*)$/u,
    /^\[回复\s+([^:：\]]+)\s*[:：]\s*["“「]?([^"”」\]]*)["”」]?\]\s*([\s\S]*)$/u,
    /^回复\s*#?(\d+)\s*[:：]\s*([\s\S]*)$/u,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const target = String(m[1] || '').trim();
    const quote = String(m[2] || '').trim();
    const rest = String(m[3] || '').trim();
    return {
      target,
      quote,
      content: rest || quote || text,
    };
  }
  return null;
}

export function normalizeReplyRows(rows = [], timestamp = Date.now(), user = {}) {
  const top = [];
  const pendingChildren = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const parsed = parseReplyPrefix(raw?.content || '');
    const replyToFloor = Number(raw?.replyToFloor || raw?.parentFloor || raw?.floor || 0) || 0;
    const fromPrefixFloor = parsed && /^\d+$/.test(parsed.target) ? Number(parsed.target) : 0;
    const targetFloor = replyToFloor || fromPrefixFloor;
    const ownership = normalizeForumAuthorOwnership(raw, user);
    const generatedIdentity = ownership.authorSource === 'generated'
      ? sanitizeGeneratedForumReplyAuthor(raw, {}, { user })
      : null;
    const item = {
      author: safeForumActorLabel(generatedIdentity?.author || raw?.author || raw?.authorName, '匿名'),
      content: parsed?.content || raw?.content || '',
      timestamp: raw?.timestamp || timestamp,
      childReplies: normalizeReplyRows(raw?.childReplies, timestamp, user),
      replyToAuthor: (() => {
        const target = raw?.replyToAuthor || (parsed && !/^\d+$/.test(parsed.target) ? parsed.target : '');
        return target ? safeForumActorLabel(target, '匿名') : '';
      })(),
      replyToQuote: String(raw?.replyToQuote || parsed?.quote || '').trim(),
      authorRoleId: generatedIdentity?.authorRoleId ?? String(raw?.authorRoleId || raw?.roleId || raw?.characterId || '').trim(),
      forumActorId: generatedIdentity?.forumActorId ?? String(raw?.forumActorId || '').trim(),
      authorPersonality: String(raw?.authorPersonality || raw?.authorProfile?.personality || '').trim(),
      authorSpeechStyle: String(raw?.authorSpeechStyle || raw?.authorProfile?.speechStyle || '').trim(),
      authorBackground: String(raw?.authorBackground || raw?.authorProfile?.background || '').trim(),
      authorInterests: (Array.isArray(raw?.authorInterests) ? raw.authorInterests : raw?.authorProfile?.interests || [])
        .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 8),
      forumIdentityKind: String(raw?.forumIdentityKind || '').trim(),
      ...ownership,
    };
    const translation = sanitizeAiTranslation(
      item.content,
      raw?.zh || raw?.translation || '',
    );
    if (translation) item.translation = translation;
    if (targetFloor > 0) {
      pendingChildren.push({ floor: targetFloor, item });
    } else {
      top.push(item);
    }
  }
  for (const child of pendingChildren) {
    const parent = top[child.floor - 1];
    if (parent) {
      if (!child.item.replyToAuthor) child.item.replyToAuthor = String(parent.author || '').trim();
      parent.childReplies = [...(parent.childReplies || []), child.item];
    } else {
      top.push(child.item);
    }
  }
  return top.filter((r) => String(r.content || '').trim());
}

export function listForumReplyTargets(rows = []) {
  const targets = [];
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const floor = index + 1;
    targets.push({
      floor,
      label: `#${floor}`,
      author: safeForumActorLabel(row?.author, '匿名'),
      content: String(row?.content || '').trim(),
      timestamp: Number(row?.timestamp || 0),
      isChild: false,
      row,
    });
    for (const [childIndex, child] of (Array.isArray(row?.childReplies) ? row.childReplies : []).entries()) {
      targets.push({
        floor,
        label: `#${floor}.${childIndex + 1}`,
        author: safeForumActorLabel(child?.author, '匿名'),
        content: String(child?.content || '').trim(),
        timestamp: Number(child?.timestamp || row?.timestamp || 0),
        isChild: true,
        row: child,
      });
    }
  }
  return targets.filter((target) => target.content);
}

export function resolveGeneratedReplyTargets(rows = [], existingReplies = [], preferredTarget = null) {
  const prepared = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
  const existingTopCount = Array.isArray(existingReplies) ? existingReplies.length : 0;
  const topFloorByBatchIndex = new Map();
  let nextFloor = existingTopCount;

  if (preferredTarget?.floor > 0) {
    const targetAuthor = String(preferredTarget.author || '').trim();
    const alreadyTargetsPreferred = prepared.some((row) => {
      if (Number(row?.replyToFloor || row?.parentFloor || 0) !== preferredTarget.floor) return false;
      if (!preferredTarget.isChild) return true;
      return String(row?.replyToAuthor || '').trim() === targetAuthor;
    });
    if (!alreadyTargetsPreferred) {
      const fallback = prepared.find((row) => !Number(row?.replyToFloor || row?.parentFloor || 0)
        && !Number(row?.replyToNewIndex || row?.replyToBatchIndex || 0));
      if (fallback) {
        fallback.replyToFloor = preferredTarget.floor;
        fallback.replyToAuthor = targetAuthor;
        fallback.replyToQuote = String(preferredTarget.content || '').trim().slice(0, 120);
      }
    }
  }

  prepared.forEach((row, index) => {
    const absoluteFloor = Number(row?.replyToFloor || row?.parentFloor || 0) || 0;
    const batchTarget = Number(row?.replyToNewIndex || row?.replyToBatchIndex || 0) || 0;
    if (!absoluteFloor && !batchTarget) {
      nextFloor += 1;
      topFloorByBatchIndex.set(index + 1, nextFloor);
    }
  });

  prepared.forEach((row) => {
    const batchTarget = Number(row?.replyToNewIndex || row?.replyToBatchIndex || 0) || 0;
    if (batchTarget > 0) {
      const targetRow = prepared[batchTarget - 1];
      const targetFloor = topFloorByBatchIndex.get(batchTarget)
        || Number(targetRow?.replyToFloor || targetRow?.parentFloor || 0)
        || 0;
      if (targetFloor > 0) {
        row.replyToFloor = targetFloor;
        row.replyToAuthor = row.replyToAuthor || targetRow?.author || targetRow?.authorName || '';
        row.replyToQuote = row.replyToQuote || String(targetRow?.content || targetRow?.text || '').trim().slice(0, 120);
      }
    }
    delete row.replyToNewIndex;
    delete row.replyToBatchIndex;
  });

  return prepared;
}

function forumDetailSignature(thread = {}) {
  const replies = Array.isArray(thread.replies) ? thread.replies : [];
  const replyBits = replies.map((r) => [
    r.author || '',
    String(r.content || '').slice(0, 120),
    r.timestamp || 0,
    Array.isArray(r.childReplies) ? r.childReplies.length : 0,
  ].join(':')).join('|');
  return [
    thread.id || '',
    thread.timestamp || 0,
    thread.title || '',
    String(thread.content || '').slice(0, 160),
    Array.isArray(thread.images) ? thread.images.length : 0,
    replies.length,
    replyBits,
  ].join('::');
}

/**
 * 后台轮询刷新、回复发帖都靠整页重渲染来反映最新数据，container.innerHTML
 * 重建会把 .forum-detail-scroll 的位置清零——刷个新回复列表就弹回顶部很打断阅读。
 */
async function rerenderKeepScroll(container, params) {
  const scroller = container.querySelector('.forum-detail-scroll');
  const top = scroller ? scroller.scrollTop : 0;
  await render(container, params);
  const nextScroller = container.querySelector('.forum-detail-scroll');
  if (nextScroller) nextScroller.scrollTop = top;
}

async function rerenderAtForumFloor(container, params, floor) {
  await render(container, params);
  const target = container.querySelector(`[data-forum-floor="${Number(floor) || 0}"]`);
  if (!target) return;
  target.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
  target.classList.add('is-reply-return-target');
  window.setTimeout(() => target.classList.remove('is-reply-return-target'), 1400);
}

async function rerenderAtForumReply(container, params, timestamp, fallbackFloor) {
  await render(container, params);
  const target = container.querySelector(`[data-forum-reply-ts="${Number(timestamp) || 0}"]`)
    || container.querySelector(`[data-forum-floor="${Number(fallbackFloor) || 0}"]`);
  if (!target) return;
  target.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
  target.classList.add('is-reply-return-target');
  window.setTimeout(() => target.classList.remove('is-reply-return-target'), 1400);
}

export default async function render(container, params) {
  const shouldAutoReply = params?.autoReplies === '1';
  if (params) params.autoReplies = '';
  const threadId = params?.threadId || params?.id;
  const user = await ensureDefaultUser();
  const uid = user?.id || null;
  const forumProfile = await loadForumProfile(uid, user);
  const forumIdentityUser = { ...user, nickname: forumProfile.displayName };
  let thread = threadId ? await db.get('forumThreads', threadId) : null;

  if (!thread) {
    container.className = 'page';
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">帖子不存在</div></div>';
    return;
  }
  if (thread.userId != null && thread.userId !== uid) {
    container.className = 'page';
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">该帖子属于其他用户档案，请切换档案后查看</div></div>';
    return;
  }
  const engagement = await loadForumEngagement(uid);
  const liked = engagement.likedThreads.some((row) => row.threadId === thread.id);
  const favorited = engagement.favoriteThreads.some((row) => row.threadId === thread.id);

  const replies = normalizeReplyRows(
    Array.isArray(thread.replies) ? thread.replies : [],
    thread.timestamp || Date.now(),
    forumIdentityUser,
  );
  if (JSON.stringify(replies) !== JSON.stringify(thread.replies || [])) {
    thread.replies = replies;
    await db.put('forumThreads', thread);
  } else {
    thread.replies = replies;
  }
  const refreshToken = `forum_detail_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  container.dataset.forumDetailRefreshToken = refreshToken;
  let lastThreadSignature = forumDetailSignature(thread);
  let refreshInFlight = false;
  const stopAutoRefresh = () => {
    clearInterval(refreshTimer);
    window.removeEventListener('focus', onWindowFocus);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
  const ensureStillActive = () => {
    if (
      !container.isConnected
      || container.dataset.page !== 'forum-detail'
      || container.dataset.forumDetailRefreshToken !== refreshToken
    ) {
      stopAutoRefresh();
      return false;
    }
    return true;
  };
  async function reloadThreadFromStore() {
    if (refreshInFlight || !ensureStillActive()) return;
    refreshInFlight = true;
    try {
      const latest = threadId ? await db.get('forumThreads', threadId) : null;
      if (!latest) {
        await rerenderKeepScroll(container, params);
        return;
      }
      const normalizedLatestReplies = normalizeReplyRows(
        Array.isArray(latest.replies) ? latest.replies : [],
        latest.timestamp || Date.now(),
        forumIdentityUser,
      );
      const normalizedLatest = { ...latest, replies: normalizedLatestReplies };
      const sig = forumDetailSignature(normalizedLatest);
      if (sig === lastThreadSignature) return;
      lastThreadSignature = sig;
      thread = normalizedLatest;
      await rerenderKeepScroll(container, params);
    } finally {
      refreshInFlight = false;
    }
  }
  const onWindowFocus = () => reloadThreadFromStore();
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') reloadThreadFromStore();
  };
  const refreshTimer = setInterval(() => {
    reloadThreadFromStore();
  }, 4500);
  window.addEventListener('focus', onWindowFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);

  const forumMetaForVest = await loadForumMetaRow(uid);
  const forumGenerationPrefs = normalizeForumAutoPrefs(
    forumMetaForVest.forumAuto || {},
    forumMetaForVest.sections || [],
  );
  const vests = uid ? await listForumVests(uid) : [];
  const stickerPool = await getAllStickersFlat();
  await materializeForumActors({
    userId: uid,
    user: forumIdentityUser,
    forbiddenNames: vests.map((vest) => vest.displayId),
    threads: [thread],
    useStickerAvatars: forumGenerationPrefs.passerbyStickerAvatars === true,
    stickerPool,
  });
  const forumActorIds = new Set();
  const collectActorIds = (rows = []) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const actorId = String(row?.forumActorId || row?.authorRoleId || '').trim();
      if (actorId) forumActorIds.add(actorId);
      collectActorIds(row?.childReplies);
    }
  };
  const mainActorId = String(thread.forumActorId || thread.authorRoleId || '').trim();
  if (mainActorId) forumActorIds.add(mainActorId);
  collectActorIds(replies);
  const forumActors = new Map((await Promise.all([...forumActorIds].map(async (actorId) => (
    [actorId, await resolveForumActor(actorId)]
  )))).filter(([, actor]) => actor));
  const actorChip = (row, fallback = '论坛匿名') => {
    const label = safeForumActorLabel(row?.authorName || row?.author || fallback, fallback);
    const actorId = String(row?.forumActorId || row?.authorRoleId || '').trim();
    const actor = actorId ? forumActors.get(actorId) : null;
    if (!actorId || !actor || row?.forumIdentityKind === 'user') return `<span>${esc(label)}</span>`;
    const avatar = String(actor.avatar || '').trim();
    return `<button type="button" class="forum-actor-chip" data-forum-actor="${escAttr(actorId)}" data-forum-actor-name="${escAttr(label)}">
      <span class="forum-actor-chip-avatar"><img src="${escAttr(avatar || resolveDefaultAvatar('forum'))}" alt=""></span>
      <span>${esc(label)}</span>
    </button>`;
  };
  const mainContent = safeForumDisplayText(thread.content);
  const mainDisp = buildSocialPostDisplayParts(mainContent, thread.images || [], stickerPool);
  const mainTranslation = forumTranslationSuffixHtml(
    mainContent,
    thread.contentTranslation || thread.translation || thread.metadata?.contentTranslation || '',
    stickerPool,
    'thread',
  );
  const mainTitle = stripSocialStickerMarkers(safeForumDisplayText(thread.title || ''), stickerPool) || '无标题';

  container.className = 'page forum-detail-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">帖子</h1>
      <button type="button" class="navbar-btn" data-delete-thread aria-label="删除">${icon('trash')}</button>
      <button type="button" class="navbar-btn" data-share aria-label="转发">${icon('link')}</button>
      <button type="button" class="navbar-btn" data-export-long-image aria-label="导出长图">${icon('download')}</button>
    </header>
    <div class="generation-activity forum-generation-activity" data-forum-generation-activity role="status" aria-live="polite" hidden></div>
    <main class="forum-detail-scroll">
      <article class="forum-detail-hero">
        <h2 class="forum-detail-title">${esc(mainTitle)}</h2>
        <div class="forum-detail-meta">${actorChip(thread, '论坛匿名')}${thread.authorVestBadge ? `<span class="forum-author-badge">${esc(thread.authorVestBadge)}</span>` : ''}<span>· ${esc(formatTime(thread.timestamp))}</span></div>
        <div class="forum-detail-content social-richtext">${mainDisp.richTextHtml}</div>
        ${mainTranslation}
        ${renderSocialPostMediaBlock(thread, mainDisp.mergedImages, 'forum', { stickerUrls: mainDisp.stickerImageUrls })}
        <div class="forum-detail-engagement">
          <button type="button" class="forum-engagement-btn${liked ? ' is-active' : ''}" data-forum-like aria-pressed="${liked}">${icon('weiboLike')}<span class="forum-engagement-label">${liked ? '已点赞' : '点赞'}</span></button>
          <button type="button" class="forum-engagement-btn${favorited ? ' is-active' : ''}" data-forum-favorite aria-pressed="${favorited}">${icon('book')}<span class="forum-engagement-label">${favorited ? '已收藏' : '收藏'}</span></button>
        </div>
      </article>
      <section class="forum-replies-block">
        <div class="forum-replies-head">楼层回复 · ${replies.length}</div>
        ${replies.length ? replies.map((r, i) => {
          const floor = i + 1;
          const replyAuthor = safeForumActorLabel(r.author, '匿名');
          const isAnon = /匿名|小号/i.test(replyAuthor);
          const replyContent = safeForumDisplayText(r.content);
          const rDisp = buildSocialPostDisplayParts(replyContent, [], stickerPool, { inlineStickers: true });
          const replyTranslation = forumTranslationSuffixHtml(replyContent, r.translation || '', stickerPool, `reply:${i}`);
          const sub = (r.childReplies || [])
            .map((cr, childIndex) => {
              const childContent = safeForumDisplayText(cr.content);
              const crDisp = buildSocialPostDisplayParts(childContent, [], stickerPool, { inlineStickers: true });
              const childAuthor = safeForumActorLabel(cr.author, '匿名');
              const crTarget = safeForumActorLabel(cr.replyToAuthor || replyAuthor, '匿名');
              const childTranslation = forumTranslationSuffixHtml(childContent, cr.translation || '', stickerPool, `reply:${i}:child:${childIndex}`);
              return `
                <div class="forum-reply-child" data-forum-reply-ts="${Number(cr.timestamp) || 0}">
                  <div class="forum-reply-meta">${actorChip(cr, childAuthor)}${cr.authorVestBadge ? `<span class="forum-author-badge">${esc(cr.authorVestBadge)}</span>` : ''} <span class="forum-reply-to">回复 @${esc(crTarget)}</span></div>
                  <div class="social-richtext forum-reply-body">${crDisp.richTextHtml}</div>
                  ${childTranslation}
                  ${renderSocialPostImageStrip(crDisp.mergedImages, 'forum')}
                  <div class="forum-reply-foot">
                    <button type="button" class="forum-reply-btn" data-reply-floor="${floor}" data-reply-author="${esc(childAuthor)}">回复</button>
                    <button type="button" class="forum-reply-edit" data-edit-reply="${i}" data-edit-child="${childIndex}" aria-label="编辑这条回复">${icon('edit')}</button>
                    <button type="button" class="forum-reply-delete" data-delete-reply="${i}" data-delete-child="${childIndex}" aria-label="删除这条回复">${icon('trash')}</button>
                  </div>
                </div>`;
            })
            .join('');
          return `
            <div class="forum-reply-card" data-forum-floor="${floor}" data-forum-reply-ts="${Number(r.timestamp) || 0}">
              <div class="forum-reply-floor">#${floor}${isAnon ? ' · 匿名' : ''}</div>
              <div class="forum-reply-meta">${actorChip(r, replyAuthor)}${r.authorVestBadge ? `<span class="forum-author-badge">${esc(r.authorVestBadge)}</span>` : ''}<span>· ${esc(formatTime(r.timestamp))}</span></div>
              <div class="social-richtext forum-reply-body">${rDisp.richTextHtml}</div>
              ${replyTranslation}
              ${renderSocialPostImageStrip(rDisp.mergedImages, 'forum')}
              <div class="forum-reply-foot">
                <button type="button" class="forum-reply-btn" data-reply-floor="${floor}" data-reply-author="${esc(replyAuthor)}">回复</button>
                <button type="button" class="forum-reply-edit" data-edit-reply="${i}" aria-label="编辑这条评论">${icon('edit')}</button>
                <button type="button" class="forum-reply-delete" data-delete-reply="${i}" aria-label="删除这条评论">${icon('trash')}</button>
              </div>
              ${sub}
            </div>`;
        }).join('') : '<div class="forum-empty"><div class="forum-empty-icon">💬</div><div>暂无回复，来抢沙发吧</div></div>'}
      </section>
      <div class="forum-compose-card">
        <div class="forum-compose-label">写回复</div>
        <div class="forum-reply-target" data-reply-target hidden>
          <span class="forum-reply-target-text" data-reply-target-text></span>
          <button type="button" class="forum-reply-target-cancel" data-reply-target-cancel aria-label="取消回复">✕</button>
        </div>
        <select class="form-input fd-reply-vest">${buildVestSelectOptionsHtml(vests, forumIdentityUser, forumMetaForVest.lastVestId || '')}</select>
        <textarea class="form-input fd-reply-input" rows="3" placeholder="写下回复…"></textarea>
        <div class="forum-reply-actions">
          <button type="button" class="btn btn-outline fd-ai-replies">AI 补评论</button>
          <button type="button" class="btn btn-primary fd-reply-send">发送回复</button>
        </div>
        <div class="forum-gen-status" data-forum-detail-status role="status" hidden></div>
      </div>
    </main>
  `;

  mountStickerPickerAfterTextarea(container, '.fd-reply-input');
  bindSocialPostMediaInteractions(container);
  container.querySelectorAll('[data-forum-actor]').forEach((button) => {
    button.addEventListener('click', () => {
      navigate('forum-actor-profile', {
        actorId: button.getAttribute('data-forum-actor') || '',
        displayName: button.getAttribute('data-forum-actor-name') || '',
      });
    });
  });
  bindNarrationTranslationToggle(container, {
    onRepaired: async (translation, { button, sourceText }) => {
      const target = String(button?.getAttribute('data-forum-translation-target') || '').trim();
      if (!target) return;
      const latest = await db.get('forumThreads', thread.id).catch(() => null);
      if (!latest || !cacheForumTranslation(latest, target, sourceText, translation, stickerPool)) return;
      await db.put('forumThreads', latest);
      cacheForumTranslation(thread, target, sourceText, translation, stickerPool);
      lastThreadSignature = forumDetailSignature(thread);
    },
    onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
  });
  const generationStateKey = `forum:${uid || 'guest'}`;
  const automaticReplyQueueKey = `${uid || 'guest'}:${thread.id}`;
  let queuedAutomaticReplyTimer = 0;
  const scheduleQueuedAutomaticReply = () => {
    if (
      queuedAutomaticReplyTimer
      || !queuedAutomaticReplyThreads.has(automaticReplyQueueKey)
      || isManualGenerationRunning(generationStateKey)
    ) return;
    queuedAutomaticReplyTimer = window.setTimeout(() => {
      queuedAutomaticReplyTimer = 0;
      if (!ensureStillActive() || isManualGenerationRunning(generationStateKey)) return;
      const button = container.querySelector('.fd-ai-replies');
      if (!button || !queuedAutomaticReplyThreads.delete(automaticReplyQueueKey)) return;
      button.dispatchEvent(new CustomEvent('click', { detail: { automatic: true } }));
    }, 0);
  };
  let stopGenerationState = () => {};
  stopGenerationState = subscribeManualGeneration(generationStateKey, (state) => {
    if (!ensureStillActive()) {
      stopGenerationState();
      return;
    }
    setGenerationActivity(container.querySelector('[data-forum-generation-activity]'), state);
    if (state?.status === 'success') void reloadThreadFromStore();
    if (state?.status && state.status !== 'running') scheduleQueuedAutomaticReply();
  });
  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  const bindThreadEngagement = (selector, kind, activeText, inactiveText) => {
    container.querySelector(selector)?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await toggleForumThreadEngagement(uid, thread, kind);
        button.classList.toggle('is-active', result.active);
        button.setAttribute('aria-pressed', String(result.active));
        const label = button.querySelector('.forum-engagement-label');
        if (label) label.textContent = result.active ? activeText : inactiveText;
      } catch (error) {
        showToast(String(error?.message || '操作失败'));
      } finally {
        button.disabled = false;
      }
    });
  };
  bindThreadEngagement('[data-forum-like]', 'like', '已点赞', '点赞');
  bindThreadEngagement('[data-forum-favorite]', 'favorite', '已收藏', '收藏');

  let pendingReplyTarget = null;
  const replyTargetEl = container.querySelector('[data-reply-target]');
  const replyTargetTextEl = container.querySelector('[data-reply-target-text]');
  const replyInputEl = container.querySelector('.fd-reply-input');
  function setReplyTarget(target) {
    pendingReplyTarget = target;
    if (!replyTargetEl) return;
    if (target) {
      if (replyTargetTextEl) replyTargetTextEl.textContent = `回复 @${target.author}`;
      replyTargetEl.hidden = false;
      replyInputEl?.focus();
    } else {
      replyTargetEl.hidden = true;
    }
  }
  container.querySelectorAll('[data-reply-floor]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const floor = Number(btn.getAttribute('data-reply-floor')) || 0;
      const author = String(btn.getAttribute('data-reply-author') || '').trim() || '匿名';
      if (!floor) return;
      setReplyTarget({ floor, author });
    });
  });
  container.querySelector('[data-reply-target-cancel]')?.addEventListener('click', () => setReplyTarget(null));

  container.querySelector('[data-delete-thread]')?.addEventListener('click', async () => {
    if (!window.confirm('删除这篇帖子？')) return;
    await db.deleteRecord('forumThreads', thread.id);
    showToast('帖子已删除');
    back();
  });

  container.querySelectorAll('[data-delete-reply]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('删除这条评论？')) return;
      const replyIndex = Number(button.getAttribute('data-delete-reply'));
      const childAttr = button.getAttribute('data-delete-child');
      const latest = await db.get('forumThreads', thread.id).catch(() => null);
      if (!latest || !Array.isArray(latest.replies) || !Number.isInteger(replyIndex)) {
        showToast('评论已不存在');
        return;
      }
      if (childAttr == null) {
        latest.replies.splice(replyIndex, 1);
      } else {
        const childIndex = Number(childAttr);
        const children = latest.replies[replyIndex]?.childReplies;
        if (!Array.isArray(children) || !Number.isInteger(childIndex)) {
          showToast('回复已不存在');
          return;
        }
        children.splice(childIndex, 1);
      }
      await db.put('forumThreads', latest);
      thread = latest;
      lastThreadSignature = forumDetailSignature(latest);
      await rerenderKeepScroll(container, params);
      showToast('评论已删除');
    });
  });

  container.querySelectorAll('[data-edit-reply]').forEach((button) => {
    button.addEventListener('click', () => {
      const replyIndex = Number(button.getAttribute('data-edit-reply'));
      const childAttr = button.getAttribute('data-edit-child');
      const source = childAttr == null
        ? replies[replyIndex]
        : replies[replyIndex]?.childReplies?.[Number(childAttr)];
      if (!source || !Number.isInteger(replyIndex)) {
        showToast('评论已不存在');
        return;
      }
      openTextEditorModal({
        title: childAttr == null ? '编辑评论' : '编辑回复',
        value: source.content || '',
        placeholder: '写下回复…',
        onSave: async (content) => {
          const nextContent = String(content || '').trim();
          if (!nextContent) {
            showToast('回复内容不能为空');
            return;
          }
          const latest = await db.get('forumThreads', thread.id).catch(() => null);
          const target = childAttr == null
            ? latest?.replies?.[replyIndex]
            : latest?.replies?.[replyIndex]?.childReplies?.[Number(childAttr)];
          if (!target) {
            showToast('评论已不存在');
            return;
          }
          target.content = nextContent;
          target.editedAt = Date.now();
          delete target.translation;
          delete target.zh;
          await db.put('forumThreads', latest);
          thread = latest;
          lastThreadSignature = forumDetailSignature(latest);
          await rerenderKeepScroll(container, params);
          showToast('评论已更新');
        },
      });
    });
  });

  container.querySelector('[data-export-long-image]')?.addEventListener('click', () => {
    openForumLongImageExport({
      title: mainTitle,
      author: safeForumActorLabel(thread.authorName || thread.author, '论坛匿名'),
      time: formatTime(thread.timestamp),
      content: stripSocialStickerMarkers(mainContent, stickerPool),
      images: mainDisp.mergedImages,
      replies: replies.map((reply) => ({
        ...reply,
        content: stripSocialStickerMarkers(safeForumDisplayText(reply.content), stickerPool),
        time: formatTime(reply.timestamp),
        childReplies: (reply.childReplies || []).map((child) => ({
          ...child,
          content: stripSocialStickerMarkers(safeForumDisplayText(child.content), stickerPool),
          time: formatTime(child.timestamp),
        })),
      })),
    });
  });

  container.querySelector('[data-share]')?.addEventListener('click', async () => {
    if (!uid) {
      showToast('请先选择用户档案');
      return;
    }
    const dest = await openForwardPicker({
      userId: uid,
      title: '转发帖子到聊天',
      includeAnonymous: false,
      emptyText: '暂无可转发的普通会话',
    });
    if (!dest?.chatId) {
      showToast('未选择聊天');
      return;
    }
    const destChat = await db.getRecord('chats', dest.chatId).catch(() => null);
    if (!destChat || !isUserPresentInChat(destChat) || isAnonymousChat(destChat)) {
      showToast('论坛分享只能转发到普通聊天');
      return;
    }
    const tsLink = await nextChatMessageTimestamp(uid, dest.chatId);
    const linkMsg = createMessage({
      chatId: dest.chatId,
      senderId: 'user',
      type: 'link',
      content: `forum://${thread.id}`,
      timestamp: tsLink,
      metadata: {
        title: `论坛：${mainTitle}`,
        desc: (thread.content || '').slice(0, 80),
        url: `forum://${thread.id}`,
        source: '论坛',
        forumThreadId: thread.id,
        forumAuthorName: thread.authorName || '',
        forumAuthorId: thread.authorId || '',
        forumAuthorRoleId: thread.authorRoleId || '',
        forumAuthorAlias: thread.authorAlias || '',
      },
    });
    await saveMessage(linkMsg);
    await updateChatPreview(dest.chatId, '[论坛分享]', tsLink);
    showToast('已转发到聊天');
  });

  container.querySelector('.fd-reply-send')?.addEventListener('click', async () => {
    if (!uid) {
      showToast('请先选择用户档案后再回复');
      return;
    }
    const text = (container.querySelector('.fd-reply-input')?.value || '').trim();
    if (!text) return;
    const vestId = (container.querySelector('.fd-reply-vest')?.value || '').trim();
    const vest = vestId ? await getForumVestById(uid, vestId) : null;
    const identity = resolveVestIdentity(vest, forumIdentityUser);
    const nowTs = await getVirtualNow(uid, 0);
    const newRow = pendingReplyTarget
      ? {
        author: identity.authorName,
        authorVestId: identity.authorVestId,
        authorVestBadge: identity.authorVestBadge,
        authorSource: 'user',
        content: text,
        timestamp: nowTs,
        childReplies: [],
        replyToFloor: pendingReplyTarget.floor,
        replyToAuthor: pendingReplyTarget.author,
      }
      : {
        author: identity.authorName,
        authorVestId: identity.authorVestId,
        authorVestBadge: identity.authorVestBadge,
        authorSource: 'user',
        content: text,
        timestamp: nowTs,
        childReplies: [],
      };
    thread.replies = normalizeReplyRows([...replies, newRow], nowTs, forumIdentityUser);
    const returnFloor = pendingReplyTarget?.floor || thread.replies.length;
    await db.put('forumThreads', thread);
    await saveForumMetaLastVest(uid, identity.authorVestId);
    if (forumGenerationPrefs.enrichReplies !== false && params) params.autoReplies = '1';
    await rerenderAtForumReply(container, params, nowTs, returnFloor);
    showToast(forumGenerationPrefs.enrichReplies !== false ? '回复已发送，正在回复评论…' : '回复已发送');
  });

  container.querySelector('.fd-ai-replies')?.addEventListener('click', async (event) => {
    const automatic = event?.detail?.automatic === true;
    if (!uid) {
      showToast('请先选择用户档案');
      return;
    }
    if (isManualGenerationRunning(generationStateKey)) {
      if (automatic) {
        queuedAutomaticReplyThreads.add(automaticReplyQueueKey);
        showToast('已排队，当前生成结束后会继续回复');
      } else {
        showToast('论坛已有生成任务正在进行');
      }
      return;
    }
    const replyCount = forumGenerationPrefs.replyGenerationCount;
    const allowStickers = forumGenerationPrefs.allowStickers !== false;
    const availableCharacters = await listForumVisibleCharacters(user, { excludeAnonNpc: true });
    const pickedScope = automatic
      ? await resolveSavedGenerationScope({
        scopeKey: 'forum-replies',
        characters: availableCharacters,
        allowPassersbyOnly: true,
      })
      : await pickGenerationScope({
        scopeKey: 'forum-replies',
        characters: availableCharacters,
        title: '本轮回复角色',
        allowPassersbyOnly: true,
        passersbyLabel: '只用论坛路人',
      });
    if (!pickedScope) return;
    const scopedCharacters = pickedScope.characters.slice(0, 24);
    const passersbyOnly = pickedScope.scope?.mode === 'passersby';
    if (!scopedCharacters.length && !passersbyOnly) {
      showToast('所选范围里没有角色');
      return;
    }
    const scopedCharacterMap = Object.fromEntries(scopedCharacters
      .filter((character) => character?.id)
      .map((character) => [String(character.id), character]));
    const btn = container.querySelector('.fd-ai-replies');
    const status = container.querySelector('[data-forum-detail-status]');
    const setStatus = (text, opts = {}) => {
      setGenStatus(status, text, opts);
      if (text) updateManualGeneration(generationStateKey, text);
    };
    if (!beginManualGeneration(generationStateKey, {
      kind: 'replies',
      message: automatic ? '正在回复评论…' : `正在为「${mainTitle}」补评论…`,
    })) {
      showToast('论坛已有生成任务正在进行');
      return;
    }
    setButtonLoading(btn, true);
    let lastRaw = '';
    try {
      setStatus(automatic ? '正在回复评论…' : '正在准备上下文…');
      const section = await loadForumSection(uid, thread.sectionId || '');
      const userLabel = forumProfile.displayName || getUserDisplayName(user) || resolveSelfDisplayName(user);
      const selfAliases = new Set(
        [userLabel, resolveSelfDisplayName(user), user?.nickname, user?.name]
          .map((x) => String(x || '').trim())
          .filter(Boolean),
      );
      const userVestIds = new Set(
        (await listForumVests(uid).catch(() => [])).map((v) => String(v?.id || '').trim()).filter(Boolean),
      );
      const isUserFloor = (r) => {
        if (r?.authorSource === 'user') return true;
        if (r?.authorSource === 'generated') return false;
        const vid = String(r?.authorVestId || '').trim();
        if (vid) return userVestIds.has(vid);
        return selfAliases.has(String(r?.author || '').trim());
      };
      const replyTargets = listForumReplyTargets(replies);
      const history = replyTargets
        .slice(-16)
        .map((target) => `${target.label} ${target.author}${target.isChild ? '（楼中楼）' : ''}：${target.content}`)
        .join('\n');
      const ownedFloors = replyTargets
        .filter((target) => isUserFloor(target.row))
        .map((target) => ({
          ...target,
          privateVest: isPrivateForumVestAuthor(target.row, forumIdentityUser),
        }))
        .sort((a, b) => b.timestamp - a.timestamp);
      const preferredOwnedFloor = ownedFloors[0] || null;
      const threadAliasBoundary = buildForumPublicAliasBoundary(thread, forumIdentityUser);
      const publicAliasIsolation = !!threadAliasBoundary || ownedFloors.some((row) => row.privateVest);
      const systemPrompt = await buildForumAiSystemPrompt(user, {
        worldBookIds: section?.worldBookIds || section?.worldBookId || [],
        auEntryIds: section?.auEntryIds || [],
        section,
        referenceNotes: [
          section?.desc ? `板块描述要求：${section.desc}` : '',
          `当前帖子公开作者：${thread.authorName || '匿名'}`,
          threadAliasBoundary,
          `当前帖子标题：${mainTitle}`,
          `当前帖子正文：${thread.content || ''}`,
        ].filter(Boolean).join('\n'),
        characters: scopedCharacters,
        allowStickers,
        publicAliasIsolation,
        passerbyIsolation: !scopedCharacters.length,
      });
      const task = [
        `任务：为论坛帖子「${mainTitle}」补充 ${replyCount} 条楼层回复。`,
        threadAliasBoundary,
        section ? `所属板块：${section.name || ''} / ${section.type || ''}` : '',
        section?.desc ? `板块描述要求：${section.desc}` : '',
        history ? `已有回复：\n${history}` : '已有回复：暂无',
        passersbyOnly
          ? '【本轮角色范围】只允许普通论坛路人和常驻路人池出场；不得使用通讯录角色。'
          : `【本轮角色范围】通讯录角色只允许使用：${scopedCharacters.map((row) => `${row.id}:${row.name}`).join('、')}。范围外角色不得出现；普通匿名路人仍可出现。`,
        buildJsonFieldTranslationPromptBlock(
          collectTranslationActors(scopedCharacters),
          { fields: 'replies[].content', exampleField: 'content' },
        ),
        '不要代替 user 发言；author 不得为 user 或当前用户显示名。',
        ownedFloors.length
          ? [
            '[回复已有公开楼层 · 硬性]',
            `以下公开发言可回复：${ownedFloors.map((f) => `${f.label} ${f.author}${f.privateVest ? '（公开账号，本体未知）' : '（用户公开身份）'}：${f.content.slice(0, 80)}`).join('；')}`,
            `本次至少一条回复必须接住最新的 ${preferredOwnedFloor.label}。写 replyToFloor=${preferredOwnedFloor.floor}、replyToAuthor="${preferredOwnedFloor.author}"，内容要回应其公开原话，禁止无视。`,
            ownedFloors.some((row) => row.privateVest)
              ? '标成“公开账号，本体未知”的楼层不得称为用户发言，也不得与用户档案、私聊或真实身份关联。'
              : '',
          ].join('\n')
          : '',
        '强制强调角色人设、关系和口吻，不要为了论坛感写成统一吐槽腔，不要 OOC。',
        forumGenerationPrefs.multiNpcInteraction !== false
          ? '允许多个角色与 NPC 自然接话，但不要为了热闹机械堆满楼层。'
          : '本次只补一个主要回复者的楼层，不要生成多人围攻式互动。',
        allowStickers
          ? '楼层可带 [表情包:名称]（放在整段文字末尾）；名称须与本地表情包一致。'
          : '本次不要在楼层里写 [表情包:名称]。',
        '普通楼层用 {"author":"回复者","content":"回复正文","zh":"外语回复才需要"}。',
        '如果要回复某一层，使用 replyToFloor 数字字段，例如 {"author":"回复者","replyToFloor":1,"content":"回复正文","zh":"外语回复才需要"}。',
        '如果回复楼中楼，replyToFloor 写它所属的顶层楼号，并同时填写 replyToAuthor 为实际被回复者。',
        'replyToFloor 只用于引用“已有回复”里显示的真实页面楼层。如果本批第 3 条要回复本批第 1 条，必须填写 replyToNewIndex:1，不要猜页面楼层号，也不要同时填写 replyToFloor；该数字是本次 replies 数组中的 1 开始序号。',
        '禁止把「[回复 XXX: ...]」写进 content；引用关系必须放 replyToFloor。',
        '角色回复须填写 authorRoleId。路人新旧比例遵守上文路人池规则：复用旧路人必须填写池中 forumActorId；新路人留空 forumActorId，并填写 authorPersonality、authorSpeechStyle、authorBackground、authorInterests。',
        '只输出 JSON：{"replies":[{"author":"普通楼层作者","content":"回复正文"},{"author":"回复已有楼层者","replyToFloor":1,"replyToAuthor":"实际被回复者","content":"回复正文"},{"author":"回复本批新评论者","replyToNewIndex":1,"content":"回复正文"}]}。角色与路人身份字段、外语 zh 字段按上述规则附加。',
      ].filter(Boolean).join('\n');
      setStatus('正在补评论…');
      const genCap = await resolveGenerationMaxTokens();
      const generated = await chatJsonGeneration({
        scope: 'forum-replies',
        retryOnInvalid: false,
        messages: [{
          role: 'user',
          content: [
            '背景设定与论坛规则',
            systemPrompt,
            '本次任务',
            task,
            '输出要求：只输出一个合法 JSON 对象，不要附加解释。',
          ].join('\n\n'),
        }],
        temperature: 0.9,
        maxTokens: genCap,
        parse: parseForumDetailJson,
        validate: (value) => Array.isArray(value?.replies) && value.replies.length > 0,
      });
      lastRaw = generated.raw;
      const parsed = generated.data;
      setStatus('正在写入评论…');
      const nowTs = await getVirtualNow(uid, 0);
      const rows = Array.isArray(parsed.replies) ? parsed.replies.slice(0, replyCount) : [];
      if (!rows.length) throw new Error('没有生成可用回复');
      const forbiddenGeneratedNames = [
        forumProfile.displayName,
        uid,
        user?.name,
        user?.nickname,
        ...vests.map((vest) => vest.displayId),
      ].map((value) => String(value || '').trim()).filter(Boolean);
      const latestThread = await db.get('forumThreads', thread.id).catch(() => null);
      const latestReplies = normalizeReplyRows(
        Array.isArray(latestThread?.replies) ? latestThread.replies : replies,
        latestThread?.timestamp || thread.timestamp || nowTs,
        forumIdentityUser,
      );
      thread = latestThread || thread;
      const preparedRows = resolveGeneratedReplyTargets(rows, latestReplies, preferredOwnedFloor);
      thread.replies = normalizeReplyRows([
        ...latestReplies,
        ...preparedRows.map((r) => {
          const identity = sanitizeGeneratedForumReplyAuthor(r, scopedCharacterMap, {
            user: forumIdentityUser,
            forbiddenNames: forbiddenGeneratedNames,
            strictRoleScope: true,
          });
          return {
            author: identity.author,
            content: r.content || '',
            authorSource: identity.authorSource,
            authorRoleId: identity.authorRoleId,
            forumActorId: identity.forumActorId,
            authorPersonality: r.authorPersonality || r.authorProfile?.personality || '',
            authorSpeechStyle: r.authorSpeechStyle || r.authorProfile?.speechStyle || '',
            authorBackground: r.authorBackground || r.authorProfile?.background || '',
            authorInterests: Array.isArray(r.authorInterests) ? r.authorInterests : r.authorProfile?.interests || [],
            replyToFloor: r.replyToFloor || r.parentFloor || 0,
            replyToAuthor: r.replyToAuthor || '',
            replyToQuote: r.replyToQuote || '',
            timestamp: nowTs,
            childReplies: [],
            zh: r.zh || r.translation || '',
          };
        }).filter((r) => r.content),
      ], nowTs, forumIdentityUser);
      await db.put('forumThreads', thread);
      const generatedKeys = new Set(preparedRows.map((row) => {
        const rawAuthor = String(row.author || '').trim();
        const storedAuthor = sanitizeGeneratedForumReplyAuthor(row, scopedCharacterMap, {
          user: forumIdentityUser,
          forbiddenNames: forbiddenGeneratedNames,
          strictRoleScope: true,
        }).author;
        return `${storedAuthor}\u0000${String(row.content || '').trim()}`;
      }));
      const appendedReplies = listForumReplyTargets(thread.replies)
        .filter((target) => target.timestamp === nowTs
          && generatedKeys.has(`${String(target.author || '').trim()}\u0000${String(target.content || '').trim()}`))
        .map((target) => target.row);
      const actorMergeTargets = appendedReplies.map((row) => ({
        row,
        timestamp: Number(row?.timestamp || 0),
        content: String(row?.content || '').trim(),
        author: String(row?.author || '').trim(),
      }));
      const firstPrepared = preparedRows[0] || {};
      const firstNewTopFloor = latestReplies.length + 1;
      const returnFloor = preferredOwnedFloor?.floor
        || Number(firstPrepared.replyToFloor || firstPrepared.parentFloor || 0)
        || firstNewTopFloor;
      finishManualGeneration(generationStateKey, {
        message: `已为「${mainTitle}」补充 ${rows.length} 条评论`,
      });
      showToast('已补评论');
      void applyForumGenerationActorPlanBestEffort({
        userId: uid,
        user: forumIdentityUser,
        forbiddenNames: forbiddenGeneratedNames,
        roots: appendedReplies,
        knownCharacterIds: scopedCharacters.map((character) => character.id),
      }).then((actorPlan) => {
        if (!actorPlan.ok) {
          console.warn('[forum-detail] 楼层身份整理未完成，评论已正常保存', actorPlan.error || 'timeout');
          return;
        }
        void (async () => {
          const newestThread = await db.get('forumThreads', thread.id).catch(() => null);
          if (!newestThread) return;
          const newestRows = listForumReplyTargets(newestThread.replies).map((target) => target.row);
          for (const target of actorMergeTargets) {
            const current = newestRows.find((row) => Number(row?.timestamp || 0) === target.timestamp
              && String(row?.content || '').trim() === target.content
              && String(row?.author || '').trim() === target.author);
            if (!current) continue;
            for (const key of [
              'author', 'authorName', 'authorAlias', 'authorRoleId', 'forumActorId',
              'authorPersonality', 'authorSpeechStyle', 'authorBackground', 'authorInterests',
            ]) {
              if (target.row[key] !== undefined) current[key] = target.row[key];
            }
          }
          await db.put('forumThreads', newestThread);
        })().catch((error) => console.warn('[forum-detail] 楼层身份回写失败', error));
      }).catch((error) => console.warn('[forum-detail] 楼层身份整理异常，评论已正常保存', error));
      await rerenderAtForumFloor(container, params, returnFloor);
    } catch (err) {
      // 手动生成期间帖子可能被 4.5 秒自动刷新重绘；旧闭包此时虽然已经失活，
      // 但错误报告是挂在 body 上的全局卡片，不能因此只剩一句“JSON 损坏” Toast。
      const stillActive = ensureStillActive();
      if (!automatic || stillActive) {
        showGenerationErrorReport(generationErrorFromCatch(err, {
          scope: '论坛 / 楼层生成',
          title: '论坛评论生成失败',
          rawText: err?.rawText || err?.rawResponse || lastRaw,
        }));
      }
      finishManualGeneration(generationStateKey, {
        ok: false,
        message: `补评论失败：${err?.message || '未知错误'}`,
      });
      showToast(`补评论失败：${err?.message || '未知错误'}`);
      setStatus(`补评论失败：${err?.message || '未知错误'}`);
    } finally {
      setButtonLoading(btn, false);
    }
  });

  if (shouldAutoReply && forumGenerationPrefs.enrichReplies !== false) {
    queuedAutomaticReplyThreads.add(automaticReplyQueueKey);
  }
  // 返回帖子时也接回尚未执行的队列；终态记录过期不应让这轮永久遗失。
  scheduleQueuedAutomaticReply();
}
