import { navigate, back, currentRoute, syncCurrentRoute } from '../core/router.js';
import { listSocialVisibleCharacters } from '../core/social-character-scope.js';
import * as db from '../core/db.js';
import { createMessage } from '../models/chat.js';
import { resolveGenerationMaxTokens } from '../core/api.js';
import { chatJsonGeneration } from '../core/chat-json-generation.js';
import { showActionToast, showToast } from '../components/toast.js';
import { icon } from '../components/svg-icons.js';
import { bindWeiboRichTextLinks } from '../components/weibo-rich-links.js';
import { openWeiboComposerSheet } from '../components/weibo-composer.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import {
  buildWeiboAiSystemPrompt,
  collectRoleplayContextForSocialGeneration,
  normalizeWeiboBackgroundConfig,
} from '../core/context/build-weibo-context.js';
import { listAllWorldBookRows, listWorldBookRootOptions } from '../core/world-book-store.js';
import { getVirtualNow, getVirtualTimePromptStamp, nextChatMessageTimestamp } from '../core/virtual-time-shim.js';
import {
  getUserChatsForRelay,
  applyGeneratedChatShares,
} from '../core/chat/social-chat-relay.js';
import { loadSocialLinkConfig, buildSocialLinkPromptHint, maybeBuildChatSocialLinkPrompt } from '../core/chat/social-link-config.js';
import { resolveAvatarUrl, resolveWeiboUserAvatar } from '../core/resolve-avatar-url.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import { getAllStickersFlat } from '../core/chat/sticker-resolve.js';
import { stripLeakedCharacterCodes } from '../core/chat/character-code-fallback.js';
import { isUserPresentInChat } from '../core/chat-helpers.js';
import { formatChatPickerLabelForChat, resolveChatParticipantName, getSafeCharacterDisplayName } from '../core/social-helpers.js';
import { getWeiboDisplayName } from '../models/user.js';
import { saveUserRecord } from '../core/user-slot.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../components/image-crop-modal.js';
import { setButtonLoading, setGenerationActivity } from '../components/generation-busy.js';
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
import {
  formatSocialCount,
  hashCode,
  seededNoise,
  simulatePostMetrics,
  estimateCommentLike,
} from '../core/weibo/weibo-metrics.js';
import {
  normalizePostFromAi,
  normalizeGeneratedWeiboPostAuthor,
  normalizeWeiboCommentAuthor,
  repairGeneratedWeiboPostAuthor,
  repairGeneratedWeiboActorMentions,
  repairGeneratedWeiboRepostGrounding,
  repairWeiboPostCommentIdentities,
  resolveGeneratedWeiboRepostMeta,
  resolveWeiboCharacterPublicName,
  selectWeiboPreviewComments,
  formatWeiboPostForCommentPrompt,
  isActiveWeiboComment,
  isPrivateWeiboPost,
  validateGeneratedWeiboLifeSource,
  weiboVisibilityLabel,
  weiboTranslationSuffixHtml,
} from '../core/weibo/weibo-post-utils.js';
import { saveWeiboRepost } from '../core/weibo/weibo-repost-store.js';
import { appendWeiboGlobalContextBatch, replaceWeiboPostInGlobalBatches } from '../core/weibo/weibo-memory-sync.js';
import { loadWeiboMetaCompat } from '../core/weibo/weibo-meta-store.js';
import {
  finalizeExpiredWeiboPostDeletions,
  finalizeWeiboPostDeletion,
  isActiveWeiboPost,
  restoreWeiboPost,
  softDeleteWeiboPost,
  WEIBO_DELETE_UNDO_MS,
} from '../core/weibo/weibo-post-store.js';
import { getWeiboHotTopicSnapshot } from '../core/weibo/weibo-hot-topics.js';
import {
  appendWeiboFeedBatch,
  buildWeiboFeedPage,
  createWeiboGenerationBatch,
  filterNovelWeiboCandidates,
  normalizeWeiboFeedChannel,
  resolvePendingWeiboPostIds,
  sortWeiboFeedPosts,
} from '../core/weibo/weibo-feed-service.js';
import { getOrCreateWeiboSuperTopic, normalizeWeiboTopicKey } from '../core/weibo/weibo-topic-store.js';
import { appendWeiboDmIncoming, clearWeiboDmData, listWeiboDmThreads } from '../core/weibo/weibo-dm-store.js';
import {
  appendWeiboCommentNotifications,
  appendWeiboNotification,
  clearWeiboNotificationData,
  getWeiboNotificationUnreadCounts,
  removeWeiboCommentNotification,
} from '../core/weibo/weibo-notification-store.js';
import { buildLifeMaterialBlock } from '../core/social-life-material.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
  sanitizeAiTranslation,
} from '../core/translation-utils.js';
import { bindNarrationTranslationToggle } from '../core/narration-translation.js';
import {
  renderSocialRichText,
  mountStickerPickerAfterTextarea,
  extractStickerTagsToImageUrls,
  mergeSocialPostImageUrls,
  buildSocialPostDisplayParts,
  renderSocialPostImageStrip,
  renderSocialPostMediaBlock,
  bindWeiboImageLightbox,
} from '../components/social-sticker-picker.js';
import {
  applySocialPostImages,
  buildSocialImageGenPromptRules,
  isSocialImageGenEnabled,
  normalizeMomentsImageOptions,
  resolveSocialImageGenMode,
} from '../core/social-image-generation.js';
import {
  loadCachedMomentsImageOptions,
  openMomentsGenImageModal,
} from '../components/moments-gen-image-modal.js';
import { buildMomentsStickerPromptBlock } from '../core/moments/moments-stickers.js';
import {
  filterAiGeneratedComments,
  isExplicitCurrentUserComment,
} from '../core/social-comment-identity.js';
import {
  applyWeiboCharacterStickerPolicy,
  buildWeiboCharacterStickerPolicyBlock,
} from '../core/weibo/weibo-character-policy.js';
import { hasNegativeSocialRelationship } from '../core/social-relationship-tone.js';
import { buildWeiboDmRelationshipBoundary } from '../core/weibo/weibo-dm-boundary.js';

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function clampGenerationCount(value, fallback, min = 1, max = 12) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function formatMentionName(name) {
  const n = String(name || '').trim();
  if (!n) return '@匿名用户';
  return n.startsWith('@') ? n : `@${n}`;
}

function safeWeiboActorLabel(value, fallback = '匿名用户') {
  const raw = String(value || '').trim();
  return stripLeakedCharacterCodes(raw, { fallbackLabel: fallback }).trim() || fallback;
}

/** 旧版评论/转发曾写入「旅行者」，展示时还原成当前用户名。 */
function resolveWeiboSelfAuthorLabel(author, user, fallback = '匿名用户') {
  const raw = String(author || '').trim();
  if (raw === '旅行者') return getWeiboDisplayName(user) || fallback;
  return safeWeiboActorLabel(raw, fallback);
}

function weiboSelfAuthorName(user) {
  return getWeiboDisplayName(user);
}

/** 识别评论是否为当前用户亲自发言；展示名不再作为身份依据，避免同名 NPC 被误判。 */
function isWeiboUserComment(comment, user) {
  return isExplicitCurrentUserComment(comment, user, { legacyUserLabels: ['旅行者'] });
}

function buildWeiboUserComment(user, content, timestamp, extra = {}) {
  return {
    id: `wbc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    author: weiboSelfAuthorName(user),
    authorId: String(user?.id || '').trim(),
    content,
    timestamp,
    likes: 0,
    ...extra,
  };
}

function safeWeiboDisplayText(value) {
  return stripLeakedCharacterCodes(String(value || ''), { fallbackLabel: '某位用户' });
}

function ensureWeiboStylesheet(container) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function' || !container) return;
  if (!document.getElementById('weibo-critical-style')) {
    const critical = document.createElement('style');
    critical.id = 'weibo-critical-style';
    critical.textContent = `
      .weibo-page{--wb-orange:#ff8200;--wb-ink:#1d2129;--wb-muted:#939aa5;--wb-line:#edf0f2;--wb-canvas:#f2f3f5;position:relative;display:flex;min-height:100%;flex-direction:column;overflow:hidden;background:var(--wb-canvas);color:var(--wb-ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
      .weibo-page button{font-family:inherit}
      .weibo-appbar{position:relative;z-index:20;display:grid;min-height:calc(56px + var(--safe-top));grid-template-columns:48px minmax(0,1fr) 48px;align-items:end;padding:var(--safe-top) 10px 0;border-bottom:1px solid #eee;background:rgba(255,255,255,.98)}
      .weibo-appbar-btn{display:grid;width:40px;height:40px;place-items:center;padding:0;border:0;background:transparent;box-shadow:none;color:#242424}
      .weibo-appbar-btn svg{width:22px;height:22px}
      .wb-home-back{align-self:center;justify-self:start;border-radius:0}
      .wb-home-switch{grid-column:2;height:56px;display:flex;align-items:stretch;justify-self:center;gap:24px}
      .wb-home-switch button{position:relative;border:0;padding:0 2px;background:none;color:#929292;font-size:17px}
      .wb-home-switch button.is-active{color:#191919;font-weight:750}
      .wb-home-switch button.is-active::after{content:'';position:absolute;right:2px;bottom:5px;left:2px;height:4px;border-radius:4px;background:linear-gradient(90deg,#ffb500,#ff7c00)}
      .weibo-appbar-actions{grid-column:3;display:grid;width:48px;height:56px;place-items:center;justify-self:end}
      .weibo-feed{min-height:0;flex:1;overflow-y:auto;padding:0 0 calc(72px + var(--safe-bottom));background:var(--wb-canvas);-webkit-overflow-scrolling:touch}
      .weibo-pull-refresh{display:flex;height:0;align-items:center;justify-content:center;gap:8px;overflow:hidden;color:var(--wb-muted);font-size:11px}
      .weibo-feed-body{position:relative;margin-top:8px;padding:0 0 calc(68px + var(--safe-bottom,0px));background:transparent}
      .weibo-post.card-block{box-sizing:border-box;margin:8px 0 0;border:0;border-radius:0;padding:15px 14px 0;background:#fff;box-shadow:none}
      .weibo-post-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
      .weibo-avatar{width:43px;height:43px;flex:0 0 43px;display:grid;place-items:center;overflow:hidden;border-radius:50%;background:#fff0e3}
      .weibo-avatar img{width:100%;height:100%;object-fit:cover}
      .weibo-post-headtext{min-width:0;flex:1}.weibo-post-name{color:#e76f00;font-size:16px;font-weight:650}.weibo-post-meta{margin-top:4px;color:#969696;font-size:12px}
      .weibo-post-content{margin-top:10px;color:#191919;font-size:15px;line-height:1.58;white-space:pre-wrap;word-break:break-word}
      .weibo-images{display:grid;max-width:320px;gap:4px;margin-top:10px}.weibo-images.is-single{grid-template-columns:1fr;max-width:min(100%,280px)}.weibo-images.is-four{grid-template-columns:repeat(2,1fr);max-width:260px}.weibo-images.is-grid{grid-template-columns:repeat(3,1fr)}
      .weibo-img-cell{min-width:0;overflow:hidden;border-radius:4px}.weibo-img-cell img{display:block;width:100%;height:100%;object-fit:cover}.weibo-images.is-single .weibo-img-cell img{height:auto;max-height:420px;object-fit:contain}
      .weibo-actions{display:grid;min-height:48px;grid-template-columns:repeat(5,minmax(0,1fr));margin:12px -14px 0;padding:0 8px;border-top:1px solid var(--wb-line)}
      .weibo-action-btn{display:flex;min-width:0;overflow:hidden;align-items:center;justify-content:center;gap:4px;border:0;background:transparent;color:#626262;font-size:11px;line-height:1;overflow-wrap:normal;white-space:nowrap;word-break:keep-all}.weibo-action-btn svg{width:20px;height:20px;flex:none}.weibo-action-btn>span:not(.svg-icon){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .weibo-tabbar{position:absolute;z-index:30;right:0;bottom:0;left:0;display:grid;height:calc(64px + var(--safe-bottom,0px));min-height:calc(64px + var(--safe-bottom,0px));grid-template-columns:repeat(5,1fr);align-items:start;padding:6px 5px var(--safe-bottom,0px);box-sizing:border-box;border-top:1px solid #e8e8e8;background:rgba(255,255,255,.98)}
      .weibo-tabbar>button{display:grid;height:52px;grid-template-rows:25px 14px;align-content:center;justify-items:center;row-gap:5px;padding:0;border:0;background:transparent;color:#222;font-size:10px}.weibo-tabbar>button.is-active{color:var(--wb-orange)}
      .weibo-tabbar>button svg{width:25px;height:25px}.weibo-tabbar>.weibo-tabbar-compose{display:grid!important;width:43px;height:43px;align-self:center;justify-self:center;place-items:center!important;gap:0;padding:0!important;border-radius:13px;background:linear-gradient(145deg,#ff9e20,#ff7600);color:#fff;line-height:0}.weibo-tabbar>.weibo-tabbar-compose .svg-icon{width:22px;height:22px;align-self:center;justify-self:center;margin:0;transform:none}
    `;
    document.head.appendChild(critical);
  }
  container.classList.add('weibo-page');
  if (getComputedStyle(container).getPropertyValue('--weibo-style-ready').trim() === '1') return;
  if (document.getElementById('weibo-runtime-style-recovery')) return;
  const link = document.createElement('link');
  link.id = 'weibo-runtime-style-recovery';
  link.rel = 'stylesheet';
  const build = String(globalThis.__MARSHMALLOW_BUILD__ || Date.now());
  link.href = `css/weibo.css?v=${encodeURIComponent(build)}&recover=1`;
  document.head.appendChild(link);
}

async function pickWeiboImageOptions() {
  const genEnabled = await isSocialImageGenEnabled('weiboImages');
  return openMomentsGenImageModal({
    genEnabled,
    title: '微博生成选项',
    cacheKey: 'weiboGenerationOptions',
  });
}

function profileKeyForPost(post) {
  return String(post?.authorId || post?.authorName || '匿名用户');
}

function likedByMeInWeibo(post, user) {
  const uid = String(user?.id || '').trim();
  const uname = String(user?.name || '').trim();
  const list = Array.isArray(post?.metadata?.likedByUserIds) ? post.metadata.likedByUserIds : [];
  return list.includes(uid) || (!!uname && list.includes(uname));
}

async function pushWeiboDm({ ownerUserId, receiverKey, senderName, senderType, content, timestamp, translation }) {
  const body = safeWeiboDisplayText(content).trim();
  const zh = sanitizeAiTranslation(body, translation || '');
  await appendWeiboDmIncoming({
    ownerUserId,
    profileKey: receiverKey,
    profileName: receiverKey,
    senderName: safeWeiboActorLabel(senderName, '匿名用户'),
    senderType: String(senderType || '粉丝'),
    content: body,
    timestamp: Number(timestamp || Date.now()),
    translation: zh,
  });
}

async function getCurrentUserId() {
  const row = await db.get('settings', 'currentUserId');
  return row?.value ?? null;
}

async function getCurrentUser() {
  const uid = await getCurrentUserId();
  if (!uid) return null;
  return db.get('users', uid);
}

function getWeiboOwnerUserId(userId) {
  return userId || 'guest';
}

function getWeiboMetaKey(userId) {
  return `weiboMeta_${getWeiboOwnerUserId(userId)}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function openGlobalModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {} };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet>
        ${innerHtml}
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  return { close, root: host };
}

function renderHotCommentBlock(post, stickerPool, user = null) {
  const list = Array.isArray(post?.commentList) ? post.commentList : [];
  if (!list.length) return '';
  const previewRows = selectWeiboPreviewComments(list, 2);
  const total = Math.max(list.length, Number(post?.comments || 0));
  return `
    <div class="weibo-hot-comments">
      <div class="weibo-hot-title">最新评论</div>
      ${previewRows.map(({ comment, index }) => {
        const disp = buildSocialPostDisplayParts(safeWeiboDisplayText(comment.content), [], stickerPool);
        const likeCount = Math.max(
          Number(comment?.likes || 0),
          Math.floor(16 + seededNoise(hashCode(`${post?.id || ''}_comment_${index}`), 0, 4200)),
        );
        return `<div class="weibo-hot-item-wrap" data-weibo-comment-post-id="${escapeAttr(post?.id || '')}" data-weibo-comment-index="${index}">
          <div class="weibo-hot-item">
            <span class="weibo-hot-author">${escapeHtml(resolveWeiboSelfAuthorLabel(comment.author, user, '评论用户'))}</span>
            <span class="weibo-hot-content social-richtext">${disp.richTextHtml}</span>
            <span class="weibo-hot-like">${formatSocialCount(likeCount)}</span>
          </div>
          ${weiboTranslationSuffixHtml(comment.content || '', comment.translation || '')}
          ${renderSocialPostImageStrip(disp.mergedImages, 'weibo', { stickerUrls: disp.stickerImageUrls })}
        </div>`;
      }).join('')}
      <button type="button" class="weibo-hot-more" data-act="comment">查看全部${formatSocialCount(total)}条评论 ></button>
    </div>
  `;
}

const getUserChats = getUserChatsForRelay;

async function collectRoleplayContextForWeibo(userId, season, options = {}) {
  return collectRoleplayContextForSocialGeneration(userId, season, options);
}

function pickRandom(list) {
  if (!list?.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fenceMatch ? fenceMatch[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1).trim();
}

/** 热搜/新闻条目标签里混入的引号、逗号等 */
function cleanTopicCell(s) {
  let t = String(s ?? '').trim();
  t = t.replace(/^[\s\["'`「【\[]+/, '');
  t = t.replace(/[\s"',」】\],]+$/g, '');
  t = t.replace(/^"+|"+$/g, '');
  t = t.replace(/,$/, '').trim();
  return t;
}

function normalizeWeiboPayloadObject(obj) {
  const base = obj && typeof obj === 'object' ? obj : {};
  const trending = Array.isArray(base.trending) ? base.trending.map(cleanTopicCell).filter(Boolean) : [];
  const news = Array.isArray(base.news) ? base.news.map(cleanTopicCell).filter(Boolean) : [];
  return { ...base, trending, news };
}

export function mergeWeiboTrending(nextItems = [], currentItems = [], limit = 12) {
  const merged = [];
  const seen = new Set();
  for (const item of [...nextItems, ...currentItems]) {
    const raw = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? String(item.topic || item.title || item.name || item.keyword || '').trim()
        : '';
    const label = String(raw || '').replace(/^#+|#+$/g, '').trim();
    const key = normalizeWeiboTopicKey(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    merged.push(`#${label}#`);
    if (merged.length >= limit) break;
  }
  return merged;
}

function formatHotSnapshotForPrompt(snapshot) {
  const topics = Array.isArray(snapshot?.topics) ? snapshot.topics : [];
  if (!topics.length) return '';
  const now = Date.now();
  return topics.slice(0, 8).map((item, idx) => {
    // 时效标注：热搜是易腐品，模型需要知道每条是几小时前抓的才能决定"当下正热"还是"余温"的写法
    const ageHours = item.fetchedAt ? Math.max(0, Math.round((now - item.fetchedAt) / 3600000)) : null;
    const ageLabel = ageHours === null ? '' : (ageHours <= 1 ? '刚抓取' : `${ageHours}小时前抓取`);
    const parts = [
      `${idx + 1}. ${item.tag || `#${String(item.keyword || '').replace(/^#|#$/g, '')}#`}`,
      item.category ? `分区:${item.category}` : '',
      ageLabel ? `时效:${ageLabel}` : '',
      item.summary ? `摘要:${String(item.summary).replace(/\s+/g, ' ').slice(0, 180)}` : '',
    ].filter(Boolean);
    return parts.join(' ');
  }).join('\n');
}

/** 近几轮⚡生成已经用过的站内热搜话题：新一轮别再原样端出来（半真半假也会腻）。 */
function collectRecentUsedTrending(meta) {
  const batches = Array.isArray(meta?.globalWeiboBatches) ? meta.globalWeiboBatches : [];
  return [...new Set(batches.flatMap((b) => b?.trending || []))].slice(0, 12);
}

function buildRealHotFallbackPayload(snapshot) {
  const topics = Array.isArray(snapshot?.topics) ? snapshot.topics : [];
  return {
    trending: topics.slice(0, 6).map((item) => item.tag || `#${String(item.keyword || '').replace(/^#|#$/g, '')}#`),
    news: topics
      .filter((item) => String(item.summary || '').trim())
      .slice(0, 4)
      .map((item) => `${item.keyword}：${String(item.summary || '').replace(/\s+/g, ' ').slice(0, 90)}`),
  };
}

async function parseWeiboJsonOnce(raw) {
  const text = String(raw || '').trim();
  const first = extractJsonObject(text);
  if (!first) {
    const err = new Error('模型返回中未找到JSON对象');
    err.rawText = text;
    err.reason = text ? 'json-parse-failed' : 'empty-api-response';
    throw err;
  }
  try {
    return normalizeWeiboPayloadObject(JSON.parse(first));
  } catch (cause) {
    const err = new Error('模型返回的 JSON 格式不正确，本次未自动修复');
    err.rawText = text;
    err.reason = 'json-parse-failed';
    err.cause = cause;
    throw err;
  }
}

function parseWeiboTextFallback(raw) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const out = { trending: [], news: [], posts: [] };
  let mode = '';
  for (const line of lines) {
    if (/热搜|trending/i.test(line)) {
      mode = 'trending';
      continue;
    }
    if (/新闻|news/i.test(line)) {
      mode = 'news';
      continue;
    }
    if (/微博|posts?|动态/i.test(line)) {
      mode = 'posts';
      continue;
    }
    if (mode === 'trending') {
      const item = cleanTopicCell(line.replace(/^[#\-\d\.\)\s]+/, '').trim());
      if (item) out.trending.push(item);
      continue;
    }
    if (mode === 'news') {
      const item = cleanTopicCell(line.replace(/^[#\-\d\.\)\s]+/, '').trim());
      if (item) out.news.push(item);
      continue;
    }
    if (mode === 'posts') {
      // 支持：角色甲：内容 / [角色甲] 内容 / 作者-内容
      const m = line.match(/^(?:\[(.+?)\]|(.+?))[：:\-]\s*(.+)$/);
      if (m) {
        const authorName = (m[1] || m[2] || '').trim();
        const content = (m[3] || '').trim();
        if (content) out.posts.push({ authorId: authorName, authorName: authorName || '匿名用户', content, fans: 0 });
      } else {
        const content = line.replace(/^[#\-\d\.\)\s]+/, '').trim();
        if (content) out.posts.push({ authorId: 'npc', authorName: '匿名用户', content, fans: 0 });
      }
    }
  }
  return out;
}

async function parseWeiboPayload(raw) {
  const t = String(raw || '').trim();
  if (!t.includes('{')) {
    const fb = parseWeiboTextFallback(raw);
    if ((fb.posts || []).length || (fb.trending || []).length) return normalizeWeiboPayloadObject(fb);
  }
  try {
    return await parseWeiboJsonOnce(raw);
  } catch (_) {
    return normalizeWeiboPayloadObject(parseWeiboTextFallback(raw));
  }
}

export default async function render(container, params = {}) {
  const prevScroll = captureScrollerTop(container, '.weibo-feed');
  const previousFeedChannel = String(container.dataset.weiboFeedChannel || '');
  if (!container.querySelector('.weibo-feed')) {
    container.classList.add('weibo-page');
    container.innerHTML = `<div class="weibo-feed-skeleton" aria-label="正在加载微博"><i></i><i></i><i></i></div>`;
  }
  const user = await getCurrentUser();
  const ownerUserId = getWeiboOwnerUserId(user?.id || '');
  const weiboMetaKey = getWeiboMetaKey(user?.id || '');
  const weiboPostScopeKey = `weibo-posts:${ownerUserId || 'guest'}`;
  const weiboCommentScopeKey = `weibo-comments:${ownerUserId || 'guest'}`;
  const season = '生活';
  await finalizeExpiredWeiboPostDeletions({ ownerUserId });
  let allWeiboPosts = await db.getAllRecords('weiboPosts');
  const legacyPosts = allWeiboPosts.filter((p) => !p?.ownerUserId);
  if (legacyPosts.length) {
    // 旧数据没有 ownerUserId 时，统一归档到 guest，避免“当前打开哪个档位就被迁移到哪个档位”。
    const legacyIds = new Set(legacyPosts.map((post) => post.id));
    allWeiboPosts = allWeiboPosts.map((post) => (
      legacyIds.has(post.id) ? { ...post, ownerUserId: 'guest' } : post
    ));
    await Promise.all(legacyPosts.map((post) => (
      db.put('weiboPosts', { ...post, ownerUserId: 'guest' })
    )));
  }
  let posts = allWeiboPosts
    .filter((p) => (p?.ownerUserId || '') === ownerUserId && isActiveWeiboPost(p))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  if (user?.id && posts.some((post) => (
    (Array.isArray(post?.commentList) && post.commentList.length)
    || post?.metadata?.generatedByAi === true
    || post?.metadata?.generationBatchId
    || post?.metadata?.generationMode
  ))) {
    const knownCharacters = await listSocialVisibleCharacters(user, {
      excludeAnonNpc: true,
      userId: user.id,
    }).catch(() => []);
    const identityResults = posts.map((post) => {
      const authorResult = repairGeneratedWeiboPostAuthor(post, {
        user,
        trustedAuthors: knownCharacters,
      });
      const commentResult = repairWeiboPostCommentIdentities(authorResult.post, knownCharacters);
      return {
        changed: authorResult.changed || commentResult.changed,
        post: commentResult.post,
      };
    });
    const identityPosts = identityResults.map((result) => result.post);
    const mentionActors = [
      ...knownCharacters,
      ...identityPosts.map((post) => ({ id: post.authorId, authorName: post.authorName })),
    ];
    const repairedPosts = identityResults.map((identityResult) => {
      const repostResult = repairGeneratedWeiboRepostGrounding(identityResult.post, {
        existingPosts: identityPosts,
        trustedAuthors: knownCharacters,
      });
      const mentionResult = repairGeneratedWeiboActorMentions(repostResult.post, mentionActors);
      return {
        changed: identityResult.changed || repostResult.changed || mentionResult.changed,
        post: mentionResult.post,
      };
    });
    const changed = repairedPosts.filter((result) => result.changed).map((result) => result.post);
    if (changed.length) await Promise.all(changed.map((post) => db.put('weiboPosts', post)));
    posts = repairedPosts.map((result) => result.post);
  }
  const loadedMeta = await loadWeiboMetaCompat(user?.id || '');
  const meta = Object.keys(loadedMeta).length ? loadedMeta : {
    trending: [],
    news: [],
    followingIds: [],
    profiles: {},
    weiboWorldBookIds: [],
    weiboBackgroundMode: 'modern',
    weiboBackgroundConfigured: false,
    homeBg: '',
    autoWeiboRelayRipple: false,
    globalWeiboBatches: [],
  };
  meta.profiles = meta.profiles || {};
  const feedChannel = normalizeWeiboFeedChannel(meta.feedChannel);
  const feedChannelLabel = feedChannel === 'following' ? '关注' : (feedChannel === 'latest' ? '最新' : '推荐');
  const followingIds = new Set((meta.followingIds || []).map(String));
  const promotedPostIds = resolvePendingWeiboPostIds(meta);
  const feedPosts = sortWeiboFeedPosts(posts, feedChannel, {
    followingIds,
    userId: user?.id || '',
    promotedIds: promotedPostIds,
  });
  const savedPagination = meta.feedPagination?.[feedChannel] || {};
  const feedPage = buildWeiboFeedPage(feedPosts, {
    pageSize: 12,
    visibleCount: savedPagination.visibleCount,
  });
  const feedVisiblePosts = feedPage.items;
  const savedFeedTop = Math.max(0, Number(meta.feedScrollPositions?.[feedChannel] || 0));
  const restoreFeedTop = previousFeedChannel === feedChannel ? prevScroll : savedFeedTop;
  {
    const bgConfig = normalizeWeiboBackgroundConfig(meta);
    meta.weiboWorldBookIds = bgConfig.worldBookIds;
    meta.weiboBackgroundMode = bgConfig.backgroundMode;
    if (meta.weiboBackgroundConfigured === undefined) {
      meta.weiboBackgroundConfigured = bgConfig.worldBookIds.length > 0;
    }
  }
  meta.generationPostCount = clampGenerationCount(meta.generationPostCount, 8, 1, 10);
  meta.refreshPostCount = clampGenerationCount(meta.refreshPostCount, 4, 1, 8);
  meta.initialCommentCount = clampGenerationCount(meta.initialCommentCount, 3, 0, 8);
  meta.commentGenerationCount = clampGenerationCount(meta.commentGenerationCount, 4, 1, 12);
  meta.autoCommentAfterPublish = meta.autoCommentAfterPublish !== false;
  const [notificationUnread, dmThreadsForUnread] = await Promise.all([
    getWeiboNotificationUnreadCounts(ownerUserId),
    listWeiboDmThreads(ownerUserId, {
      profileKeys: [user?.id, user?.name, 'user'],
    }),
  ]);
  const messageUnreadCount = Number(notificationUnread.total || 0)
    + dmThreadsForUnread.reduce((sum, thread) => sum + Number(thread.unreadCount || 0), 0);
  const stickerPool = await getAllStickersFlat();
  const storyProfileMap = new Map();
  for (const post of posts) {
    const key = String(post.authorId || post.authorName || '').trim();
    if (!key || storyProfileMap.has(key)) continue;
    storyProfileMap.set(key, { key, authorId: post.authorId || '', authorName: safeWeiboActorLabel(post.authorName, '微博用户'), avatar: post.avatar || '' });
    if (storyProfileMap.size >= 9) break;
  }
  const storyProfiles = await Promise.all([...storyProfileMap.values()].map(async (profile) => ({
    ...profile,
    avatarUrl: await resolveAvatarUrl(profile.authorId, profile.authorName, profile.avatar, 'weibo'),
  })));
  const storyRailHtml = storyProfiles.length ? `<section class="wb-story-rail" aria-label="关注动态">
    ${storyProfiles.map((profile, index) => `<button type="button" class="wb-story-item weibo-profile-link" data-author-id="${escapeAttr(profile.authorId)}" data-author-name="${escapeAttr(profile.authorName)}">
      <span class="wb-story-ring"><img src="${escapeAttr(profile.avatarUrl || resolveDefaultAvatar('weibo'))}" alt="" loading="lazy" decoding="async" />${index < 4 ? '<i>直播中</i>' : ''}</span>
      <small>${escapeHtml(profile.authorName)}</small>
    </button>`).join('')}
  </section>` : '';

  const normalizeTrendTopic = (item) => {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') {
      return String(item.topic || item.title || item.name || item.keyword || '').trim();
    }
    return '';
  };
  const trendHtml = `
    <section class="weibo-hot-panel" aria-label="微博热搜">
      <div class="weibo-hot-head">
        <strong>微博热搜</strong>
        <span>${season}</span>
      </div>
      <div class="weibo-hot-grid">
        ${(meta.trending || []).slice(0, 6).map((x, i) => {
          const topic = normalizeTrendTopic(x);
          const topicKey = normalizeWeiboTopicKey(topic);
          const topicPosts = posts.filter((post) => (
            String(post.content || '').toLowerCase().includes(topicKey)
            || (post.tags || []).some((tag) => normalizeWeiboTopicKey(tag) === topicKey)
          ));
          const peak = topicPosts.reduce((max, post) => Math.max(max, Number(post.likes || 0) + Number(post.comments || 0) * 2 + Number(post.reposts || 0) * 2), 0);
          const recentTrend = Date.now() - Number(meta.trendingUpdatedAt || 0) < 30 * 60 * 1000;
          const mark = topicPosts.length >= 5 || peak >= 5000 ? '爆' : (topicPosts.length >= 2 || peak >= 500 ? '热' : (recentTrend && i < 2 ? '新' : ''));
          return `<div class="weibo-hot-row"><span class="weibo-hot-rank${i < 3 ? ' is-top' : ''}">${i + 1}</span><button type="button" class="weibo-trend-link" data-topic="${escapeAttr(topic)}">${escapeHtml(topic)}</button>${mark ? `<i data-mark="${mark}">${mark}</i>` : ''}</div>`;
        }).join('') || '<div class="weibo-hot-empty">暂无热搜</div>'}
      </div>
      ${(meta.news || []).length ? `<div class="weibo-news-ticker">${(meta.news || []).slice(0, 3).map((n) => `<span>${escapeHtml(typeof n === 'string' ? n : String(n?.title || n?.text || ''))}</span>`).join('')}</div>` : ''}
    </section>
  `;
  const adHtml = `
    <aside class="weibo-native-ad">
      <span>广告</span><strong>生活好物推荐</strong><small>手账贴纸与暖色周边限时折扣</small>
    </aside>`;

  let listHtml = `<div class="placeholder-page" style="padding:48px 16px;min-height:auto;"><div class="placeholder-text">${feedChannel === 'following' ? '关注的人还没有新微博' : '还没有微博动态'}</div></div>`;
  if (feedVisiblePosts.length) {
    const chunks = [];
    for (const p of feedVisiblePosts) {
      const postDisp = buildSocialPostDisplayParts(safeWeiboDisplayText(p.content), p.images, stickerPool);
      const safeAuthorName = resolveWeiboSelfAuthorLabel(p.authorName, user, '匿名用户');
      const name = escapeHtml(safeAuthorName);
      const timeMeta = formatTime(p.timestamp || 0);
      const avatarUrl = await resolveAvatarUrl(p.authorId, safeAuthorName, p.avatar, 'weibo');
      const avatar = `<img src="${escapeAttr(avatarUrl || resolveDefaultAvatar('weibo'))}" alt="" class="weibo-avatar-img" />`;
      const profile = meta.profiles?.[p.authorId || p.authorName] || {};
      const postProfileKey = String(p.authorId || p.authorName || '');
      const postIsSelf = String(p.authorId || '') === String(user?.id || '');
      const postIsFollowing = followingIds.has(postProfileKey);
      const fans = profile.fans || p.fans || 0;
      const sim = simulatePostMetrics(p);
      const privatePost = isPrivateWeiboPost(p);
      const liked = likedByMeInWeibo(p, user);
      const visLab = weiboVisibilityLabel(p.metadata);
      const visHtml = visLab
        ? `<div class="weibo-post-vis"><span class="weibo-vis-badge">${escapeHtml(visLab)}</span></div>`
        : '';
      const repostMeta = p?.metadata?.repostFrom;
      const repostBlock = repostMeta
        ? `<div class="weibo-repost-origin" style="margin-top:8px;padding:8px 10px;border-radius:10px;background:#f7fbff;border:1px solid #d8e8fa;">
            <div style="font-size:12px;color:#6f8cab;">转发 ${escapeHtml(formatMentionName(safeWeiboActorLabel(getSafeCharacterDisplayName(repostMeta.authorId || repostMeta.authorName || '', { fallback: repostMeta.authorName || '原作者' }), '原作者')))}</div>
            <div style="margin-top:4px;line-height:1.5;">${escapeHtml(safeWeiboDisplayText(repostMeta.content || '（原文不可见）').slice(0, 120))}</div>
          </div>`
        : '';
      chunks.push(`
        <article class="weibo-post card-block" data-post-id="${escapeAttr(p.id)}">
          <header class="weibo-post-header">
            <button type="button" class="weibo-avatar weibo-profile-link" data-author-id="${escapeAttr(p.authorId || '')}" data-author-name="${escapeAttr(safeAuthorName)}" aria-label="作者主页">${avatar}</button>
            <div class="weibo-post-headtext">
              <button type="button" class="weibo-post-name weibo-profile-link" data-author-id="${escapeAttr(p.authorId || '')}" data-author-name="${escapeAttr(safeAuthorName)}">${name}<span class="weibo-v-badge">V</span></button>
              <div class="weibo-post-meta">${escapeHtml(timeMeta)}${p.metadata?.editedAt ? ' · 已编辑' : ''} · 粉丝 ${escapeHtml(formatSocialCount(fans))}</div>
              ${visHtml}
            </div>
            ${postIsSelf
              ? `<button type="button" class="wb-card-edit" data-act="edit" aria-label="编辑微博">${icon('edit')}</button>`
              : `<button type="button" class="wb-card-follow${postIsFollowing ? ' is-following' : ''}" data-follow-profile="${escapeAttr(postProfileKey)}">${postIsFollowing ? '已关注' : '+关注'}</button>`}
          </header>
          ${repostBlock}
          <div class="weibo-post-content social-richtext">${postDisp.richTextHtml}</div>
          ${weiboTranslationSuffixHtml(p.content || '', p.metadata?.contentTranslation || p.contentTranslation || '')}
          ${renderSocialPostMediaBlock(p, postDisp.mergedImages, 'weibo', { stickerUrls: postDisp.stickerImageUrls })}
          ${privatePost ? '' : renderHotCommentBlock({ ...p, comments: sim.comments }, stickerPool, user)}
          <div class="weibo-actions">
            <button type="button" class="weibo-action-btn is-mini" data-act="repost" aria-label="转发" ${privatePost ? 'disabled' : ''}>${icon('weiboRepost', 'weibo-act-svg')}<span>${formatSocialCount(sim.reposts)}</span></button>
            <button type="button" class="weibo-action-btn is-mini" data-act="comment" aria-label="评论" ${privatePost ? 'disabled' : ''}>${icon('weiboComment', 'weibo-act-svg')}<span>${formatSocialCount(sim.comments)}</span></button>
            <button type="button" class="weibo-action-btn is-mini ${liked ? 'is-liked' : ''}" data-act="like" aria-label="点赞" ${privatePost ? 'disabled' : ''}>${icon('weiboLike', 'weibo-act-svg')}<span>${formatSocialCount(sim.likes)}</span></button>
            <button type="button" class="weibo-action-btn is-mini" data-act="share" aria-label="分享" ${privatePost ? 'disabled' : ''}>${icon('send', 'weibo-act-svg')}<span>分享</span></button>
            <button type="button" class="weibo-action-btn is-mini icon-only danger" data-act="delete" aria-label="删除">${icon('trash', 'weibo-act-svg')}</button>
          </div>
        </article>`);
    }
    listHtml = chunks.join('');
  }

  container.classList.add('weibo-page');
  ensureWeiboStylesheet(container);
  container.innerHTML = `
    <header class="weibo-appbar wb-home-appbar">
      <button type="button" class="weibo-appbar-btn weibo-back wb-home-back" aria-label="返回">${icon('back')}</button>
      <div class="wb-home-switch" role="tablist" aria-label="首页频道">
        <button type="button" role="tab" data-wb-feed-channel="latest" class="${feedChannel === 'latest' ? 'is-active' : ''}" aria-selected="${feedChannel === 'latest'}">最新</button>
        <button type="button" role="tab" data-wb-feed-channel="recommended" class="${feedChannel === 'recommended' ? 'is-active' : ''}" aria-selected="${feedChannel === 'recommended'}">推荐</button>
        <button type="button" role="tab" data-wb-feed-channel="following" class="${feedChannel === 'following' ? 'is-active' : ''}" aria-selected="${feedChannel === 'following'}">关注</button>
      </div>
      <div class="weibo-appbar-actions">
        <button type="button" class="weibo-appbar-btn weibo-config wb-home-settings" data-gen-busy-lock aria-label="微博设置">${icon('lucideEllipsis')}</button>
      </div>
    </header>
    <div class="generation-activity weibo-generation-activity" data-weibo-generation-activity role="status" aria-live="polite" hidden></div>
    ${Number(meta.pendingNewPostCount || 0) && Date.now() - Number(meta.pendingNewPostAt || 0) < 10 * 60 * 1000 ? `<button type="button" class="weibo-new-posts-hint">有 ${Number(meta.pendingNewPostCount)} 条新微博</button>` : ''}
    <div class="page-scroll weibo-feed${meta.homeBg ? ' has-bg' : ''}" style="${meta.homeBg ? `background-image:url('${escapeAttr(meta.homeBg)}');background-size:cover;background-position:center top;` : ''}">
      <div class="weibo-pull-refresh" data-weibo-pull-refresh aria-live="polite"><span></span><strong>下拉刷新</strong></div>
      ${storyRailHtml}
      <div class="weibo-feed-body">
        ${listHtml}
        ${feedPage.hasMore ? `<button type="button" class="weibo-feed-load-more" data-wb-feed-load-more>加载更多</button>` : ''}
      </div>
    </div>
    <button type="button" class="weibo-back-to-top" aria-label="回到顶部" hidden>${icon('chevron')}</button>
    <nav class="weibo-tabbar" aria-label="微博导航">
      <button type="button" class="is-active" data-wb-tab="home">${icon('lucideHouse')}<span class="weibo-tabbar-label">首页</span></button>
      <button type="button" data-wb-tab="hot">${icon('lucideCompass')}<span class="weibo-tabbar-label">发现</span></button>
      <button type="button" class="weibo-tabbar-compose weibo-compose" data-gen-busy-lock aria-label="发布微博">${icon('lucidePlus')}</button>
      <button type="button" data-wb-tab="message">${icon('lucideMessage')}<span class="weibo-tabbar-label">消息</span>${messageUnreadCount ? `<i class="weibo-nav-badge">${Math.min(99, messageUnreadCount)}</i>` : ''}</button>
      <button type="button" data-wb-tab="me">${icon('lucideUser')}<span class="weibo-tabbar-label">我</span></button>
    </nav>
  `;
  container.dataset.weiboFeedChannel = feedChannel;
  bindWeiboRichTextLinks(container);
  restoreScrollerTop(container, '.weibo-feed', restoreFeedTop);
  const feedScroll = container.querySelector('.weibo-feed');
  const backTopButton = container.querySelector('.weibo-back-to-top');
  const syncBackTop = () => { if (backTopButton) backTopButton.hidden = Number(feedScroll?.scrollTop || 0) < 560; };
  feedScroll?.addEventListener('scroll', syncBackTop, { passive: true });
  syncBackTop();
  backTopButton?.addEventListener('click', () => feedScroll?.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  container.querySelector('.weibo-new-posts-hint')?.addEventListener('click', async () => {
    feedScroll?.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    meta.pendingNewPostCount = 0;
    await db.put('settings', { key: weiboMetaKey, value: meta });
    container.querySelector('.weibo-new-posts-hint')?.remove();
  });
  async function persistCommentTranslation(translation, { button } = {}) {
    const commentHost = button?.closest('[data-weibo-comment-post-id][data-weibo-comment-index]');
    const postId = String(commentHost?.getAttribute('data-weibo-comment-post-id') || '').trim();
    const commentIndex = Number(commentHost?.getAttribute('data-weibo-comment-index'));
    if (!postId || !Number.isInteger(commentIndex) || commentIndex < 0) return;
    const storedPost = await db.get('weiboPosts', postId);
    const commentList = Array.isArray(storedPost?.commentList) ? storedPost.commentList : [];
    if (!storedPost || !commentList[commentIndex]) return;
    commentList[commentIndex] = { ...commentList[commentIndex], translation };
    storedPost.commentList = commentList;
    await db.put('weiboPosts', storedPost);
  }

  bindNarrationTranslationToggle(container, {
    onRepaired: persistCommentTranslation,
    onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
  });

  container.querySelector('.weibo-back')?.addEventListener('click', () => back());
  function goToMyWeiboHome() {
    if (!user) return;
    navigate('weibo-profile', {
      authorId: user.id || '',
      authorName: weiboSelfAuthorName(user),
      from: 'me',
    });
  }

  container.querySelector('[data-wb-tab="hot"]')?.addEventListener('click', () => {
    navigate('weibo-search', { q: container.querySelector('.weibo-search-input')?.value || '' });
  });
  container.querySelector('[data-wb-tab="message"]')?.addEventListener('click', () => {
    navigate('weibo-messages', {
      ownerUserId,
    });
  });
  container.querySelector('[data-wb-tab="me"]')?.addEventListener('click', goToMyWeiboHome);
  container.querySelectorAll('.wb-story-item').forEach((button) => button.addEventListener('click', () => {
    navigate('weibo-profile', { authorId: button.dataset.authorId || '', authorName: button.dataset.authorName || '微博用户' });
  }));
  async function persistWeiboFeedView(update) {
    const latestRow = await db.get('settings', weiboMetaKey).catch(() => null);
    const nextMeta = { ...meta, ...(latestRow?.value || {}) };
    update(nextMeta);
    await db.put('settings', { key: weiboMetaKey, value: nextMeta });
    Object.assign(meta, nextMeta);
  }

  container.querySelectorAll('[data-wb-feed-channel]').forEach((button) => {
    button.addEventListener('click', async () => {
      const nextChannel = normalizeWeiboFeedChannel(button.dataset.wbFeedChannel);
      if (nextChannel === feedChannel) return;
      const currentTop = Math.max(0, Number(container.querySelector('.weibo-feed')?.scrollTop || 0));
      await persistWeiboFeedView((state) => {
        state.feedChannel = nextChannel;
        state.feedScrollPositions = {
          ...(state.feedScrollPositions || {}),
          [feedChannel]: currentTop,
        };
        state.feedPagination = {
          ...(state.feedPagination || {}),
          [feedChannel]: {
            visibleCount: feedPage.visibleCount,
            cursor: feedPage.cursor,
            hasMore: feedPage.hasMore,
          },
        };
      });
      await render(container);
    });
  });

  function weiboBackgroundSummaryText() {
    return meta.weiboBackgroundMode === 'custom' && meta.weiboWorldBookIds.length
      ? `已绑定 ${meta.weiboWorldBookIds.length} 本世界书`
      : '现代都市日常';
  }

  async function openWeiboBackgroundModal() {
    const wbRows = await listAllWorldBookRows().catch(() => []);
    const bookOptions = listWorldBookRootOptions(wbRows);
    return new Promise((resolve) => {
      const selectedIds = new Set(meta.weiboWorldBookIds || []);
      const { close, root } = openGlobalModal(`
        <div class="modal-header"><h3>选一下微博的背景</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
        <div class="modal-body">
          <p class="text-hint" style="font-size:12px;line-height:1.6;margin:0 0 10px;">决定生成的微博世界观基调，保存后会一直沿用，随时可以回设置里重新选。</p>
          <label class="form-label" style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;">
            <input type="radio" name="wb-bg-mode" class="wb-bg-mode-radio" value="modern" ${meta.weiboBackgroundMode !== 'custom' ? 'checked' : ''} style="margin-top:3px;" />
            <span><strong>现代都市日常</strong><br/><span style="font-size:12px;color:var(--text-hint);">按当代现实生活写，仍会结合角色人设、已绑定的世界书与近期聊天记录背景。</span></span>
          </label>
          <label class="form-label" style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;margin-top:10px;">
            <input type="radio" name="wb-bg-mode" class="wb-bg-mode-radio" value="custom" ${meta.weiboBackgroundMode === 'custom' ? 'checked' : ''} style="margin-top:3px;" />
            <span><strong>绑定世界书</strong><br/><span style="font-size:12px;color:var(--text-hint);">只用下面勾选的世界书约束背景，不再混入其它设定，省得生成跑偏。</span></span>
          </label>
          <div class="wb-bg-worldbook-wrap" style="margin-top:8px;${meta.weiboBackgroundMode === 'custom' ? '' : 'display:none;'}">
            <select class="form-input wb-bg-worldbook-select" multiple size="5">
              ${bookOptions.length
                ? bookOptions.map((wb) => `<option value="${escapeAttr(wb.id)}" ${selectedIds.has(wb.id) ? 'selected' : ''}>${escapeHtml(wb.name)}</option>`).join('')
                : '<option disabled>暂无世界书，先去「世界书」页建一个</option>'}
            </select>
          </div>
          <button type="button" class="btn btn-primary wb-bg-save" style="margin-top:14px;width:100%;">保存</button>
        </div>
      `);
      const wrap = root.querySelector('.wb-bg-worldbook-wrap');
      root.querySelectorAll('.wb-bg-mode-radio').forEach((r) => {
        r.addEventListener('change', () => {
          if (wrap) wrap.style.display = r.value === 'custom' && r.checked ? '' : 'none';
        });
      });
      const finish = (result) => { close(); resolve(result); };
      root.querySelector('.modal-close-btn')?.addEventListener('click', () => finish(null));
      root.querySelector('.wb-bg-save')?.addEventListener('click', async () => {
        const mode = root.querySelector('.wb-bg-mode-radio:checked')?.value === 'custom' ? 'custom' : 'modern';
        const ids = mode === 'custom'
          ? [...root.querySelectorAll('.wb-bg-worldbook-select option:checked')].map((o) => o.value).filter(Boolean)
          : [];
        meta.weiboBackgroundMode = mode;
        meta.weiboWorldBookIds = ids;
        meta.weiboBackgroundConfigured = true;
        await db.put('settings', { key: weiboMetaKey, value: meta });
        finish({ mode, ids });
      });
    });
  }

  async function ensureWeiboBackgroundConfig() {
    if (meta.weiboBackgroundConfigured) return true;
    const result = await openWeiboBackgroundModal();
    return !!result;
  }

  async function clearWeiboProfileContent() {
    if (!window.confirm('确定清空这个档位生成的全部微博内容吗？热搜、动态、评论、私信都会清掉，此操作不可恢复；账号资料与背景设置不受影响。')) return;
    const all = await db.getAllRecords('weiboPosts');
    const mine = all.filter((p) => (p?.ownerUserId || '') === ownerUserId);
    for (const p of mine) {
      await finalizeWeiboPostDeletion(p.id, p, { force: true }).catch(() => {});
    }
    const dmPrefix = `weiboDmBox_${ownerUserId}_`;
    const settingsRows = await db.getAllRecords('settings');
    const dmKeys = settingsRows
      .map((row) => row?.key)
      .filter((key) => typeof key === 'string' && key.startsWith(dmPrefix));
    for (const key of dmKeys) {
      await db.remove(key);
    }
    await clearWeiboDmData(ownerUserId);
    await clearWeiboNotificationData(ownerUserId);
    meta.trending = [];
    meta.news = [];
    meta.globalWeiboBatches = [];
    await db.put('settings', { key: weiboMetaKey, value: meta });
    showToast(`已清空 ${mine.length} 条微博记录`);
    await render(container);
  }

  function openWeiboConfigModal(draft = null) {
    const selfName = weiboSelfAuthorName(user);
    const selfFans = draft?.fans != null
      ? String(draft.fans)
      : (user?.weiboFans != null && Number.isFinite(Number(user.weiboFans))
        ? String(Math.round(Number(user.weiboFans)))
        : '');
    const selfBio = draft?.bio != null ? String(draft.bio) : String(user?.weiboBio || '').trim();
    const selfWeiboId = draft?.weiboId != null ? String(draft.weiboId) : String(user?.weiboId || '').trim();
    const selfWeiboNickname = draft?.weiboNickname != null
      ? String(draft.weiboNickname)
      : String(user?.weiboNickname || '').trim();
    const selfAvatarUrl = resolveWeiboUserAvatar(user);
    let pendingAvatar = draft?.pendingAvatar != null ? String(draft.pendingAvatar || '') : selfAvatarUrl;
    let clearAvatar = draft?.clearAvatar === true;
    let avatarTouched = draft?.avatarTouched === true;

    const avatarPreviewHtml = pendingAvatar
      ? `<img src="${escapeAttr(pendingAvatar)}" alt="" class="weibo-avatar-img" style="width:56px;height:56px;border-radius:50%;object-fit:cover;" />`
      : `<img src="${escapeAttr(resolveDefaultAvatar('weibo'))}" alt="" class="weibo-avatar-img" style="width:56px;height:56px;border-radius:50%;object-fit:cover;" />`;

    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>微博设置</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body wb-config-body">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-outline wb-quick-home">我的主页</button>
          <button type="button" class="btn btn-sm btn-outline wb-quick-posts">生成新帖</button>
          <button type="button" class="btn btn-sm btn-outline wb-quick-topics">热搜与超话</button>
          <button type="button" class="btn btn-sm btn-outline wb-quick-scope">生成角色范围</button>
          <button type="button" class="btn btn-sm btn-outline wb-quick-comment-scope">评论参与角色</button>
        </div>

        <div class="form-label" style="margin-top:16px;">我的主页</div>
        <div style="display:flex;gap:12px;align-items:center;margin-top:8px;">
          <button type="button" class="wb-self-avatar-preview" aria-label="更换头像" style="border:0;background:transparent;padding:0;cursor:pointer;">${avatarPreviewHtml}</button>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <button type="button" class="btn btn-sm btn-outline wb-self-avatar-pick">更换头像</button>
            <button type="button" class="btn btn-sm btn-outline wb-self-avatar-clear">清除头像</button>
          </div>
          <input type="file" class="wb-self-avatar-file" accept="image/*" hidden />
        </div>
        <label class="form-label" style="margin-top:10px;">微博显示名</label>
        <input class="form-input wb-self-weibo-nickname" value="${escapeAttr(selfWeiboNickname)}" maxlength="40" placeholder="留空则用个人昵称（${escapeAttr(selfName)}）" />
        <label class="form-label" style="margin-top:10px;">微博 ID</label>
        <input class="form-input wb-self-weibo-id" value="${escapeAttr(selfWeiboId)}" maxlength="60" placeholder="UID（可选，用于识别本人链接）" />
        <label class="form-label" style="margin-top:10px;">粉丝数</label>
        <input type="number" class="form-input wb-self-fans" min="0" step="1" value="${escapeAttr(selfFans)}" placeholder="留空则不固定" />
        <label class="form-label" style="margin-top:10px;">简介</label>
        <textarea class="form-input wb-self-bio" rows="3" maxlength="300" placeholder="微博简介">${escapeHtml(selfBio)}</textarea>
        <label class="form-label" style="margin-top:10px;">主页背景图</label>
        <input type="file" class="wb-home-bg-file" accept="image/*" />

        <div class="wb-bg-summary" style="margin-top:10px;padding:10px 12px;border:1px solid #e0d3a8;border-radius:10px;background:#fffaf0;">
          <div style="font-size:12px;color:#6f5a3a;">当前背景：<strong>${escapeHtml(weiboBackgroundSummaryText())}</strong></div>
          <button type="button" class="btn btn-sm btn-outline wb-bg-reselect" style="margin-top:6px;">重新选择背景</button>
        </div>
        <div class="form-label" style="margin-top:16px;">生成数量</div>
        <label class="api-field">
          <span class="api-field-label">生成新帖</span>
          <select class="form-input wb-generation-post-count">${[3, 4, 5, 6, 8, 10].map((n) => `<option value="${n}" ${n === meta.generationPostCount ? 'selected' : ''}>${n} 条</option>`).join('')}</select>
        </label>
        <label class="api-field">
          <span class="api-field-label">下拉刷新</span>
          <select class="form-input wb-refresh-post-count">${[1, 2, 3, 4, 5, 6, 8].map((n) => `<option value="${n}" ${n === meta.refreshPostCount ? 'selected' : ''}>${n} 条</option>`).join('')}</select>
        </label>
        <label class="api-field">
          <span class="api-field-label">每条初始热评</span>
          <select class="form-input wb-initial-comment-count">${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === meta.initialCommentCount ? 'selected' : ''}>${n} 条</option>`).join('')}</select>
        </label>
        <label class="api-field">
          <span class="api-field-label">每次补评论</span>
          <select class="form-input wb-comment-generation-count">${[2, 3, 4, 5, 6, 8, 10, 12].map((n) => `<option value="${n}" ${n === meta.commentGenerationCount ? 'selected' : ''}>${n} 条</option>`).join('')}</select>
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>发布后自动补评论</span>
          <input type="checkbox" class="wb-auto-comment-publish" ${meta.autoCommentAfterPublish ? 'checked' : ''} />
        </label>
        <label class="form-label" style="margin-top:10px;display:flex;align-items:flex-start;gap:8px;cursor:pointer;">
          <input type="checkbox" class="wb-auto-relay" style="margin-top:3px;" ${(draft?.autoRelay != null ? !!draft.autoRelay : !!meta.autoWeiboRelayRipple) ? 'checked' : ''} />
          <span style="font-size:13px;line-height:1.45;">${icon('zap')} 生成结束后再调用一次模型，按<strong>通讯录里的私聊/群聊</strong>定向写 chatShares（约 3 名转发角色、私聊+群混合）；风格与<strong>聊天续写里的社交互动偏好</strong>同源。与主生成里「第一轮自愿写 chatShares」不同：主生成由<strong>倾向强度</strong>引导是否填链接，本项是<strong>定向补推</strong>（多耗一次 API）</span>
        </label>

        <details style="margin-top:16px;">
          <summary class="form-label" style="cursor:pointer;">其它账号资料（角色）</summary>
          <input class="form-input wb-profile-key" placeholder="角色ID或名字" style="margin-top:8px;" value="${escapeAttr(draft?.profileKey || '')}" />
          <input class="form-input wb-profile-fans" placeholder="粉丝数" style="margin-top:8px;" value="${escapeAttr(draft?.profileFans || '')}" />
          <textarea class="form-input wb-profile-bio" rows="2" placeholder="简介" style="margin-top:8px;">${escapeHtml(draft?.profileBio || '')}</textarea>
        </details>

        <div class="form-label" style="margin-top:20px;">数据管理</div>
        <button type="button" class="btn btn-outline wb-clear-history" style="margin-top:6px;width:100%;color:#c94b4b;border-color:#e8b7b7;">清空这个档位的微博生成内容</button>
      </div>
      <div class="wb-config-footer">
        <button type="button" class="btn btn-primary wb-profile-save" style="width:100%;">保存</button>
      </div>
    `);
    root.querySelector('[data-modal-sheet]')?.classList.add('wb-config-sheet');

    const paintAvatarPreview = () => {
      const host = root.querySelector('.wb-self-avatar-preview');
      if (!host) return;
      host.innerHTML = pendingAvatar
        ? `<img src="${escapeAttr(pendingAvatar)}" alt="" class="weibo-avatar-img" style="width:56px;height:56px;border-radius:50%;object-fit:cover;" />`
          : `<img src="${escapeAttr(resolveDefaultAvatar('weibo'))}" alt="" class="weibo-avatar-img" style="width:56px;height:56px;border-radius:50%;object-fit:cover;" />`;
    };

    const readDraft = () => ({
      weiboNickname: (root.querySelector('.wb-self-weibo-nickname')?.value || '').trim(),
      weiboId: (root.querySelector('.wb-self-weibo-id')?.value || '').trim(),
      fans: (root.querySelector('.wb-self-fans')?.value || '').trim(),
      bio: (root.querySelector('.wb-self-bio')?.value || '').trim(),
      autoRelay: !!root.querySelector('.wb-auto-relay')?.checked,
      profileKey: (root.querySelector('.wb-profile-key')?.value || '').trim(),
      profileFans: (root.querySelector('.wb-profile-fans')?.value || '').trim(),
      profileBio: (root.querySelector('.wb-profile-bio')?.value || '').trim(),
      pendingAvatar,
      clearAvatar,
      avatarTouched,
    });

    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.wb-quick-home')?.addEventListener('click', () => {
      close();
      goToMyWeiboHome();
    });
    root.querySelector('.wb-quick-posts')?.addEventListener('click', () => {
      close();
      runGenerateNewPosts();
    });
    root.querySelector('.wb-quick-topics')?.addEventListener('click', () => {
      close();
      openWeiboTopicGenerator();
    });
    root.querySelector('.wb-quick-scope')?.addEventListener('click', async () => {
      const snapshot = readDraft();
      close();
      const availableCharacters = await listSocialVisibleCharacters(user, { excludeAnonNpc: true });
      const picked = await pickGenerationScope({
        scopeKey: weiboPostScopeKey,
        fallbackScopeKey: 'weibo-posts',
        characters: availableCharacters,
        title: '微博生成角色范围',
      });
      if (picked) showToast('已保存微博生成角色范围，下拉刷新也会沿用');
      openWeiboConfigModal(snapshot);
    });
    root.querySelector('.wb-quick-comment-scope')?.addEventListener('click', async () => {
      const snapshot = readDraft();
      close();
      const availableCharacters = await listSocialVisibleCharacters(user, { excludeAnonNpc: true });
      const picked = await pickGenerationScope({
        scopeKey: weiboCommentScopeKey,
        characters: availableCharacters,
        title: '微博评论参与角色',
        allowPassersbyOnly: true,
        passersbyLabel: '只用微博游客',
        defaultMode: 'passersby',
      });
      if (picked) showToast('已保存当前档位的微博评论参与范围');
      openWeiboConfigModal(snapshot);
    });
    root.querySelector('.wb-bg-reselect')?.addEventListener('click', async () => {
      const snapshot = readDraft();
      const result = await openWeiboBackgroundModal();
      if (result) showToast('已更新背景设置');
      openWeiboConfigModal(snapshot);
    });

    const avatarFile = root.querySelector('.wb-self-avatar-file');
    const pickAvatar = () => avatarFile?.click();
    root.querySelector('.wb-self-avatar-preview')?.addEventListener('click', pickAvatar);
    root.querySelector('.wb-self-avatar-pick')?.addEventListener('click', pickAvatar);
    root.querySelector('.wb-self-avatar-clear')?.addEventListener('click', () => {
      pendingAvatar = '';
      clearAvatar = true;
      avatarTouched = true;
      if (avatarFile) avatarFile.value = '';
      paintAvatarPreview();
    });
    avatarFile?.addEventListener('change', async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const result = await fileToCroppedOptimizedAvatarDataUrl(file);
        if (!result?.dataUrl) return;
        pendingAvatar = result.dataUrl;
        clearAvatar = false;
        avatarTouched = true;
        paintAvatarPreview();
      } catch (err) {
        showToast(String(err?.message || err || '头像处理失败'));
      } finally {
        ev.target.value = '';
      }
    });

    root.querySelector('.wb-profile-save')?.addEventListener('click', async () => {
      try {
        meta.autoWeiboRelayRipple = !!root.querySelector('.wb-auto-relay')?.checked;
        meta.generationPostCount = clampGenerationCount(root.querySelector('.wb-generation-post-count')?.value, 8, 1, 10);
        meta.refreshPostCount = clampGenerationCount(root.querySelector('.wb-refresh-post-count')?.value, 4, 1, 8);
        meta.initialCommentCount = clampGenerationCount(root.querySelector('.wb-initial-comment-count')?.value, 3, 0, 8);
        meta.commentGenerationCount = clampGenerationCount(root.querySelector('.wb-comment-generation-count')?.value, 4, 1, 12);
        meta.autoCommentAfterPublish = !!root.querySelector('.wb-auto-comment-publish')?.checked;
        const bgFile = root.querySelector('.wb-home-bg-file')?.files?.[0];
        if (bgFile) {
          try {
            meta.homeBg = await fileToDataUrl(bgFile);
          } catch (_) {
            showToast('主页背景读取失败');
          }
        }

        if (user?.id) {
          const weiboNickname = (root.querySelector('.wb-self-weibo-nickname')?.value || '').trim();
          const weiboId = (root.querySelector('.wb-self-weibo-id')?.value || '').trim();
          const fansStr = (root.querySelector('.wb-self-fans')?.value || '').trim();
          const bio = (root.querySelector('.wb-self-bio')?.value || '').trim();
          const nextUser = {
            ...user,
            // 微博显示名 / 微博 ID 只写各自字段，不改个人昵称 nickname
            weiboNickname,
            weiboId,
            weiboBio: bio,
            weiboFans: fansStr === '' ? null : Math.max(0, Number(fansStr) || 0),
          };
          if (avatarTouched) {
            nextUser.weiboAvatarConfigured = true;
            nextUser.weiboAvatar = clearAvatar ? '' : pendingAvatar;
          }
          const saved = await saveUserRecord(nextUser);
          Object.assign(user, saved);

          const profileKey = String(saved.id || '').trim();
          if (profileKey) {
            meta.profiles = meta.profiles || {};
            meta.profiles[profileKey] = {
              ...(meta.profiles[profileKey] || {}),
              fans: saved.weiboFans != null ? saved.weiboFans : (meta.profiles[profileKey]?.fans ?? 0),
              bio: saved.weiboBio || bio,
            };
          }
        }

        const key = (root.querySelector('.wb-profile-key')?.value || '').trim();
        if (key) {
          const fans = Number(root.querySelector('.wb-profile-fans')?.value || '0');
          const bio = (root.querySelector('.wb-profile-bio')?.value || '').trim();
          meta.profiles = meta.profiles || {};
          meta.profiles[key] = { ...(meta.profiles[key] || {}), fans, bio };
        }

        await db.put('settings', { key: weiboMetaKey, value: meta });
        showToast('已保存');
        close();
        await render(container);
      } catch (err) {
        showToast(String(err?.message || err || '保存失败'));
      }
    });
    root.querySelector('.wb-clear-history')?.addEventListener('click', async () => {
      close();
      await clearWeiboProfileContent();
    });
  }

  container.querySelector('.weibo-config')?.addEventListener('click', () => {
    openWeiboConfigModal();
  });

  const generationStateKey = `weibo:${ownerUserId || 'guest'}`;
  const generationRenderToken = `weibo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  container.dataset.manualGenerationRender = generationRenderToken;
  const isCurrentWeiboRender = () => (
    container.isConnected
    && container.dataset.page === 'weibo'
    && container.dataset.manualGenerationRender === generationRenderToken
  );
  const topicGeneratorReturnRoute = params.topicGeneratorReturn === 'discover'
    ? 'weibo-search'
    : (params.topicGeneratorReturn === 'hot-rank' ? 'weibo-hot-rank' : '');
  let stopGenerationState = () => {};
  let generationStateInitialized = false;
  stopGenerationState = subscribeManualGeneration(generationStateKey, (state) => {
    if (!container.isConnected
      || container.dataset.page !== 'weibo'
      || container.dataset.manualGenerationRender !== generationRenderToken) {
      stopGenerationState();
      return;
    }
    const hasFreshNewPostHint = state?.status === 'success'
      && Number(meta.pendingNewPostCount || 0) > 0
      && Date.now() - Number(meta.pendingNewPostAt || 0) < 10 * 60 * 1000;
    // 完成态会短暂保留，供任务结束当刻刷新当前页面；重新进入微博时不应再次
    // 把上一轮的完成卡当成新的生成界面弹出。
    const completedBeforeThisRender = !generationStateInitialized && state?.status === 'success';
    setGenerationActivity(
      container.querySelector('[data-weibo-generation-activity]'),
      hasFreshNewPostHint || completedBeforeThisRender ? null : state,
    );
    const btnRefresh = container.querySelector('.weibo-refresh');
    if (btnRefresh) setButtonLoading(btnRefresh, state?.status === 'running', { label: '生成中…' });
    if (generationStateInitialized && state?.status === 'success') {
      container.dataset.manualGenerationRender = `${generationRenderToken}-refreshing`;
      stopGenerationState();
      void render(container);
      return;
    }
    generationStateInitialized = true;
  });

  const setWeiboBusy = (on, options = {}) => {
    const message = options.message || (options.imageGen ? '正在生成微博动态与配图' : '正在生成热搜与微博动态');
    if (on) updateManualGeneration(generationStateKey, message, {
      hint: options.hint || (options.imageGen
        ? '内容与配图会在后台继续生成，可以先去其他页面'
        : '可以先去其他页面，稍后回来查看结果'),
    });
    const btnRefresh = container.querySelector('.weibo-refresh');
    if (btnRefresh) {
      if (on) setButtonLoading(btnRefresh, true, { label: '生成中…' });
      else setButtonLoading(btnRefresh, false);
    }
  };

  function pickThreeRelayActors(insertedPosts, chats) {
    const ids = [];
    const fromPosts = [
      ...new Set(insertedPosts.map((p) => String(p.authorId || '').trim()).filter((x) => x && x !== 'user' && x !== 'npc')),
    ];
    for (const id of fromPosts) {
      if (ids.length >= 3) break;
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length < 3) {
      for (const c of chats || []) {
        if (c.type !== 'private') continue;
        const oid = (c.participants || []).find((p) => p && p !== 'user');
        if (oid && !ids.includes(oid)) ids.push(oid);
        if (ids.length >= 3) break;
      }
    }
    return ids.slice(0, 3);
  }

  async function buildWeiboChatRelaySystemPrompt() {
    const cfg = await loadSocialLinkConfig();
    const chatAligned = await maybeBuildChatSocialLinkPrompt();
    const hint = buildSocialLinkPromptHint(cfg);
    return [
      '你是与本应用「私聊/群聊续写」共用同一套跨窗联动规则的助手；下列段落与聊天窗口的社交联动规则一致，须一并遵守。',
      chatAligned,
      hint,
      '【任务】只输出一个合法 JSON 对象，顶层键 chatShares，数组长度 2～3。',
      '每条含：postIndex、forwarderId、targetType（private_user|private_character|group）、targetId（仅角色私聊）、groupName（仅群）、lines（1～3 条）、可选用 wrongSend、wrongGroupName、recallLink。',
      'forwarderId 必须来自用户消息中给出的「本轮须担任转发者的角色 id」列表；台词须紧扣对应 postIndex 的动态与本轮热搜/简讯。',
      '目标必须逐字照抄用户消息中的可用落点：private_user 的对话对象是 user；private_character 必须同时照抄该行 targetId，台词应对该角色说；不得把角色私聊改投给 user。',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  async function buildWeiboRelayUserMessage(insertedPosts, snapshot, chats, actors) {
    const privLines = [];
    for (const c of chats.filter((x) => x.type === 'private' && (x.participants || []).includes('user'))) {
      const oid = (c.participants || []).find((p) => p && p !== 'user');
      if (!oid) continue;
      const nm = await resolveChatParticipantName(oid, { userId: user.id });
      privLines.push(`- user 与 ${nm}（forwarderId=${oid} → targetType=private_user）`);
    }
    const peerLines = [];
    for (const c of chats.filter((x) => x.type === 'private' && !(x.participants || []).includes('user'))) {
      const ids = [...new Set((c.participants || []).filter((p) => p && p !== 'user'))];
      if (ids.length !== 2) continue;
      const [leftName, rightName] = await Promise.all(ids.map((id) => (
        resolveChatParticipantName(id, { userId: user.id })
      )));
      peerLines.push(`- ${leftName}（forwarderId=${ids[0]}）→ ${rightName}（targetType=private_character, targetId=${ids[1]}）`);
      peerLines.push(`- ${rightName}（forwarderId=${ids[1]}）→ ${leftName}（targetType=private_character, targetId=${ids[0]}）`);
    }
    const grpLines = chats
      .filter((x) => x.type === 'group')
      .map((x) => String(x.groupSettings?.name || '').trim())
      .filter(Boolean)
      .slice(0, 16)
      .map((n) => `- 「${n}」`);
    const actorLabels = await Promise.all(actors.map(async (id) => `${id}（${await resolveChatParticipantName(id, { userId: user.id })}）`));
    const postLines = insertedPosts.slice(0, 10).map((p, i) => {
      const tx = String(p.content || '').replace(/\s+/g, ' ').slice(0, 100);
      return `${i}. postIndex=${i} authorId=${p.authorId || ''} authorName=${p.authorName || ''} ${tx}`;
    });
    return [
      '【本轮公共舆情】',
      `热搜：${(snapshot.trending || []).slice(0, 8).join('、') || '（无）'}`,
      `简讯：${(snapshot.news || []).slice(0, 5).join('；') || '（无）'}`,
      '【通讯录中可选的转发落点 · 须与存档一致】',
      '私聊：',
      privLines.length ? privLines.join('\n') : '（无存档私聊）',
      '角色之间已有的私聊：',
      peerLines.length ? peerLines.slice(0, 20).join('\n') : '（无角色私聊）',
      '群聊：',
      grpLines.length ? grpLines.join('\n') : '（无存档群聊）',
      `【本轮须担任 forwarder 的角色（${actors.length} 人，forwarderId 只能从中取）】`,
      actorLabels.join('、'),
      '【动态 · postIndex 为下标】',
      ...postLines,
      '请输出 JSON。从上表真实存在的落点中选 2～3 条；若同时存在用户私聊与群聊，至少各一条。角色私聊只有剧情和台词明确适合该接收角色时才选，选中后不得改成 private_user。',
    ].join('\n');
  }

  async function runWeiboRelayRippleFollowUp(insertedPosts, snapshot, virtualNow) {
    if (!meta.autoWeiboRelayRipple || !user?.id || !insertedPosts?.length) return;
    const chats = await getUserChatsForRelay(user.id);
    const actors = pickThreeRelayActors(insertedPosts, chats);
    if (!actors.length) return;
    const userMsg = await buildWeiboRelayUserMessage(insertedPosts, snapshot, chats, actors);
    try {
      const sys = await buildWeiboChatRelaySystemPrompt();
      const cap = await resolveGenerationMaxTokens();
      const generated = await chatJsonGeneration({
        scope: 'weibo-relay-ripple',
        retryOnInvalid: false,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
        temperature: 0.88,
        maxTokens: cap,
        validate: (value) => Array.isArray(value?.chatShares),
      });
      const parsed = generated.data;
      const shares = parsed?.chatShares;
      if (!Array.isArray(shares) || !shares.length) return;
      await applyGeneratedChatShares({
        userId: user.id,
        chatShares: shares,
        relayItems: insertedPosts,
        virtualNow,
        relaySpec: {
          urlScheme: 'weibo',
          sourceLabel: '微博',
          lastMessagePreview: '[微博分享]',
          linkTitle: (post, fname) => `微博：${post.authorName || fname}`,
          linkDesc: (post) => post.content || '',
          extraLinkMetadata: () => ({ fromWeiboRelay: true, relayRipple: true }),
        },
      });
      showToast('已按通讯录定向推送微博转发');
    } catch (e) {
      console.warn('runWeiboRelayRippleFollowUp', e);
      showGenerationErrorReport(generationErrorFromCatch(e, {
        scope: '微博 / 定向转发',
        title: '微博转发生成失败',
      }));
    }
  }

  const persistGeneratedPayload = async (parsed, virtualNow, opts = {}) => {
    const latestMetaRow = await db.get('settings', weiboMetaKey).catch(() => null);
    if (latestMetaRow?.value && typeof latestMetaRow.value === 'object') {
      Object.assign(meta, latestMetaRow.value);
    }
    const topicHint = String(opts.topicHint || '').trim();
    const topicKey = normalizeWeiboTopicKey(topicHint);
    const topicTag = topicKey ? `#${topicKey}#` : '';
    const imageOptions = opts.imageOptions || null;
    const allowedCharacterIds = new Set((opts.allowedCharacterIds || []).map(String));
    const allowedCharacters = Array.isArray(opts.allowedCharacters) ? opts.allowedCharacters : [];
    const realHotFallback = buildRealHotFallbackPayload(opts.realHotSnapshot || null);
    const incomingTrending = mergeWeiboTrending(
      (parsed.trending || []).slice(0, 6),
      realHotFallback.trending,
      6,
    );
    // 生成新微博只把本轮话题提到榜首，不再清空原有榜单；完整换榜仍由
    // “刷新热搜榜”负责。榜单最多保留 12 条，避免长期无限增长。
    meta.trending = mergeWeiboTrending(incomingTrending, meta.trending, 12);
    if (topicHint && !meta.trending.some((x) => x.includes(topicHint))) {
      meta.trending = mergeWeiboTrending([topicHint], meta.trending, 12);
    }
    meta.news = (parsed.news || []).length ? parsed.news : realHotFallback.news;
    meta.profiles = meta.profiles || {};
    let inserted = 0;
    const insertedPosts = [];
    const genEnabled = await isSocialImageGenEnabled('weiboImages');
    const normalizedImageOptions = imageOptions
      ? {
        ...normalizeMomentsImageOptions(imageOptions, genEnabled),
        imageStyleId: String(imageOptions.imageStyleId || '').trim(),
      }
      : null;
    const existingPosts = (await db.getAllRecords('weiboPosts'))
      .filter((post) => post.ownerUserId === ownerUserId && isActiveWeiboPost(post));
    const repostTrustedAuthors = await listSocialVisibleCharacters(user, {
      excludeAnonNpc: true,
      userId: user?.id,
    }).catch(() => allowedCharacters);
    const novel = filterNovelWeiboCandidates(
      Array.isArray(parsed.posts) ? parsed.posts : [],
      existingPosts,
      { limit: opts.maxPosts || 99 },
    );
    let postsForVisual = applyWeiboCharacterStickerPolicy(novel.posts, allowedCharacters);
    if (normalizedImageOptions && !normalizedImageOptions.allowLifePhoto) {
      postsForVisual = postsForVisual.map((p) => ({ ...p, imagePrompt: '' }));
    }
    if (normalizedImageOptions && !normalizedImageOptions.allowPersonPhoto) {
      postsForVisual = postsForVisual.map((p) => (
        p?.imagePrompt && /\b(selfie|portrait|face|1girl|1boy)\b/i.test(String(p.imagePrompt))
          ? { ...p, imagePrompt: '' }
          : p
      ));
    }
    const maxImages = normalizedImageOptions
      ? ((normalizedImageOptions.allowLifePhoto || normalizedImageOptions.allowTextImage) ? 4 : 0)
      : 4;
    const postsWithVisuals = await applySocialPostImages(postsForVisual, {
      scene: 'weiboImages',
      imageField: 'images',
      maxImages,
      ...(normalizedImageOptions ? { imageOptions: normalizedImageOptions } : {}),
    });
    const mentionActors = [
      ...allowedCharacters,
      ...postsWithVisuals.map((row) => ({ id: row?.authorId, authorName: row?.authorName })),
    ];
    for (const p of postsWithVisuals) {
      const normalized = normalizePostFromAi(p, {
        user,
        trustedCommentAuthorIds: allowedCharacterIds,
        trustedCommentAuthors: allowedCharacters,
        mentionActors,
        hotCommentLimit: meta.initialCommentCount,
      });
      const author = normalizeGeneratedWeiboPostAuthor(p, {
        user,
        trustedAuthors: allowedCharacters,
      });
      const lifeGrounding = validateGeneratedWeiboLifeSource(p, {
        authorId: author.authorId,
        trustedAuthorIds: allowedCharacterIds,
      });
      if (!lifeGrounding.ok) continue;
      // 同批生成按模型返回顺序稳定落在时间线上，每条间隔一分钟；不再随机
      // 打散到过去一小时，避免刚生成的新帖夹进旧帖中间。
      const postTs = virtualNow - insertedPosts.length * 60_000;
      const repostFromMeta = resolveGeneratedWeiboRepostMeta({
        authorId: normalized.repostFromAuthorId,
        authorName: normalized.repostFromAuthorName,
        postId: normalized.repostFromPostId,
        content: normalized.repostFromContent || normalized.repostComment,
      }, {
        existingPosts: [...existingPosts, ...insertedPosts],
        trustedAuthors: repostTrustedAuthors,
      });
      if ((normalized.repostFromAuthorId || normalized.repostFromAuthorName) && !repostFromMeta) {
        // 整条内容的叙事前提就是一条并不存在的角色原帖；只摘掉转发卡仍会留下
        // “转发了某角色”这样的假正文，因此本条不落库，让下一次生成自然补齐。
        continue;
      }
      const post = {
        id: 'weibo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        ownerUserId,
        authorId: author.authorId,
        authorName: author.authorName,
        avatar: author.avatar || null,
        content: normalized.content || '',
        tags: [...new Set([
          ...(Array.isArray(p.tags) && p.tags.length ? p.tags : (normalized.tags || [])),
          ...(topicTag ? [topicTag] : []),
        ].filter(Boolean))],
        images: (Array.isArray(p.images) ? p.images : []).filter(Boolean),
        imagePrompt: String(p.imagePrompt || '').trim(),
        imageCharacterId: String(p.imageCharacterId || p.imageSubjectId || '').trim(),
        textImage: String(p.textImage || '').trim(),
        imageKind: p.imageKind === 'photo' || p.imageKind === 'textimg' ? p.imageKind : '',
        timestamp: postTs,
        reposts: normalized.reposts,
        comments: normalized.comments,
        likes: normalized.likes,
        fans: Number(p.fans || 0),
        metadata: {
          generatedByAi: true,
          generatedAuthorName: String(p.authorName || '').trim(),
          sourceType: lifeGrounding.sourceType || 'free',
          ...(lifeGrounding.sourceType === 'life' ? {
            lifeSourceOwnerId: lifeGrounding.ownerId,
            subjectCharacterId: lifeGrounding.subjectCharacterId,
          } : {}),
          ...(repostFromMeta ? { repostFrom: repostFromMeta } : {}),
          visibility: normalized.visibility,
          ...(topicKey ? { superTopicKey: topicKey } : {}),
          ...(opts.batch?.id ? {
            generationBatchId: opts.batch.id,
            generationMode: opts.batch.mode,
          } : {}),
          ...(normalized.contentTranslation ? { contentTranslation: normalized.contentTranslation } : {}),
        },
        commentList: normalized.hotComments.slice(0, meta.initialCommentCount).map((c) => ({
          id: `wbc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          authorId: c.authorId || '',
          author: safeWeiboActorLabel(c.author, '热评用户'),
          content: c.content,
          likes: c.likes,
          ...(c.translation ? { translation: c.translation } : {}),
          timestamp: virtualNow - Math.floor(Math.random() * 400000),
        })),
      };
      const hasVisiblePostPayload = !!post.content
        || post.images.length > 0
        || !!post.textImage
        || !!repostFromMeta;
      if (!hasVisiblePostPayload) continue;
      if (post.authorId) meta.profiles[post.authorId] = { ...(meta.profiles[post.authorId] || {}), fans: Number(post.fans || 0) + seededNoise(hashCode(post.authorId), 0.1, 0.9) };
      await db.put('weiboPosts', post);
      insertedPosts.push(post);
      inserted += 1;
    }
    await applyGeneratedChatShares({
      userId: user?.id || '',
      chatShares: parsed.chatShares,
      relayItems: insertedPosts,
      virtualNow,
      relaySpec: {
        urlScheme: 'weibo',
        sourceLabel: '微博',
        lastMessagePreview: '[微博分享]',
        linkTitle: (post, fname) => `微博：${post.authorName || fname}`,
        linkDesc: (post) => post.content || '',
        extraLinkMetadata: () => ({ fromWeiboRelay: true }),
      },
    });
    const dms = Array.isArray(parsed?.dms) ? parsed.dms : [];
    for (const dm of dms.slice(0, 10)) {
      const receiverKey = String(dm?.receiverKey || '').trim();
      const fallbackReceiver = profileKeyForPost(pickRandom(insertedPosts) || {});
      const targetKey = receiverKey || fallbackReceiver || (user?.id || user?.name || 'user');
      await pushWeiboDm({
        ownerUserId,
        receiverKey: targetKey,
        senderName: String(dm?.senderName || '路人粉'),
        senderType: String(dm?.senderType || '粉丝'),
        content: String(dm?.content || '').trim(),
        translation: dm?.zh || dm?.translation || '',
        timestamp: virtualNow - Math.floor(Math.random() * 1800_000),
      });
    }
    if (!inserted) {
      const error = new Error('模型有返回，但没有生成可用的微博帖子');
      error.reason = 'validation-failed';
      throw error;
    }
    const generatedTrending = [...(meta.trending || [])];
    const generatedNews = [...(meta.news || [])];
    const generatedProfiles = { ...(meta.profiles || {}) };
    const latestBeforeSave = await db.get('settings', weiboMetaKey).catch(() => null);
    if (latestBeforeSave?.value && typeof latestBeforeSave.value === 'object') {
      Object.assign(meta, latestBeforeSave.value);
      meta.profiles = { ...(latestBeforeSave.value.profiles || {}), ...generatedProfiles };
    }
    meta.trending = generatedTrending;
    meta.news = generatedNews;
    meta.trendingUpdatedAt = Date.now();
    meta.pendingNewPostCount = inserted;
    meta.pendingNewPostAt = Date.now();
    if (opts.batch) appendWeiboFeedBatch(meta, opts.batch, insertedPosts, { duplicateCount: novel.duplicateCount });
    appendWeiboGlobalContextBatch(meta, { trending: meta.trending, news: meta.news, posts: insertedPosts });
    await db.put('settings', { key: weiboMetaKey, value: meta });
    await runWeiboRelayRippleFollowUp(insertedPosts, { trending: meta.trending, news: meta.news }, virtualNow);
    return inserted;
  };

  async function runGenerateNewPosts(options = {}) {
    const refreshMode = options.mode === 'refresh';
    const requestedCount = refreshMode ? meta.refreshPostCount : meta.generationPostCount;
    if (isManualGenerationRunning(generationStateKey)) {
      showToast('微博已有生成任务正在进行');
      return { ok: false, busy: true, inserted: 0 };
    }
    if (!(await ensureWeiboBackgroundConfig())) return { ok: false, cancelled: true, inserted: 0 };
    const imageOptions = refreshMode
      ? loadCachedMomentsImageOptions('weiboGenerationOptions')
      : await pickWeiboImageOptions();
    if (!imageOptions) return { ok: false, cancelled: true, inserted: 0 };
    const availableCharacters = await listSocialVisibleCharacters(user, { excludeAnonNpc: true });
    const pickedScope = refreshMode
      ? await resolveSavedGenerationScope({
        scopeKey: weiboPostScopeKey,
        fallbackScopeKey: 'weibo-posts',
        characters: availableCharacters,
      })
      : await pickGenerationScope({
        scopeKey: weiboPostScopeKey,
        fallbackScopeKey: 'weibo-posts',
        characters: availableCharacters,
        title: '本轮微博角色',
      });
    if (!pickedScope) return { ok: false, cancelled: true, inserted: 0 };
    const poolChars = pickedScope.characters.slice(0, 18);
    if (!poolChars.length) {
      showToast('所选范围里没有角色');
      return { ok: false, inserted: 0 };
    }
    const roleplayCtx = await collectRoleplayContextForWeibo(user?.id || '', season, {
      focusCharacterIds: poolChars.map((row) => row.id),
      strictFocus: true,
    });
    const refChars = poolChars.map((c) => c.name).join('、');
    const virtualNow = await getVirtualNow(user?.id || '', 0);
    const generationBatch = createWeiboGenerationBatch({
      mode: refreshMode ? 'refresh' : 'full',
      requestedCount,
    });
    const virtualStamp = await getVirtualTimePromptStamp(user?.id || '', virtualNow);
    const realHotSnapshot = await getWeiboHotTopicSnapshot({
      limit: 8,
      refresh: true,
      enrichSummaryLimit: 2,
    }).catch(() => null);
    const realHotPrompt = formatHotSnapshotForPrompt(realHotSnapshot);
    const recentUsedTrending = collectRecentUsedTrending(meta);
    // 角色近期真实动向（日程/旅行/刷到过的内容）：取前几个角色注入，让站内微博能长出
    // "路人偶遇""狗仔拍到""本人发疯文学"这类贴着角色真实生活的内容，而不是每轮凭空编
    const lifeMaterialBlock = await buildLifeMaterialBlock(
      user?.id || '',
      poolChars.slice(0, 6).map((c) => ({ id: c.id, name: c.name })),
      { title: '角色近期真实动向（可改写成站内微博素材）' },
    ).catch(() => '');
    const recentPosts = (await db.getAllRecords('weiboPosts'))
      .filter((p) => p.ownerUserId === ownerUserId && isActiveWeiboPost(p))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 16);
    const recentPostDigest = recentPosts.length
      ? recentPosts.map((p) => `- [postId=${p.id}] [authorId=${p.authorId || ''}] [visibility=${p.metadata?.visibility || 'public'}] ${p.authorName || '某人'}：${String(p.content || '').replace(/\s+/g, ' ').slice(0, 80)}`).join('\n')
      : '暂无历史微博';
    const systemPrompt = await buildWeiboAiSystemPrompt(user, season, {
      worldBookIds: meta.weiboWorldBookIds || [],
      backgroundMode: meta.weiboBackgroundMode,
      referenceNotes: roleplayCtx.snippets.join('\n'),
      characters: poolChars,
      characterCardMode: 'compact',
      allowStickers: imageOptions.allowStickers !== false,
    });
    const relayHint = (roleplayCtx.relayGroupNames || []).length
      ? `用户存档中的群聊名称（chatShares 里 targetType 为 group 时 groupName 须与下列之一一致或明显包含关系）:${roleplayCtx.relayGroupNames.join('、')}`
      : '用户当前无存档群聊：chatShares 请只用 targetType=private_user（角色与用户的私聊转发），不要写 group。';
    const socialHint = buildSocialLinkPromptHint(await loadSocialLinkConfig());
    const imageGenMode = await resolveSocialImageGenMode('weiboImages');
    const imageRules = buildSocialImageGenPromptRules(imageGenMode, {
      surface: 'weibo',
      imageOptions,
      allowStickers: imageOptions.allowStickers !== false,
    });
    const stickerPool = imageOptions.allowStickers !== false
      ? await getAllStickersFlat().catch(() => [])
      : [];
    const stickerBlock = imageOptions.allowStickers !== false
      ? buildMomentsStickerPromptBlock(stickerPool)
      : '【表情包】本次不要写 [表情包:名称]。';
    const translationPrompt = buildJsonFieldTranslationPromptBlock(
      collectTranslationActors(poolChars),
      { fields: 'content / hotComments[].content', exampleField: 'content' },
    );
    const prompt = [
      `当前虚拟时间:${virtualStamp}`,
      `用户:${weiboSelfAuthorName(user)}，角色池:${refChars}`,
      '【本轮角色范围】角色池之外的通讯录角色不得作为作者、评论者、私信发送者或被点名提及；普通路人账号不受此限制。',
      relayHint,
      socialHint,
      roleplayCtx.relationLines.length ? `关系摘要:\n${roleplayCtx.relationLines.join('\n')}` : '关系摘要:暂无',
      buildWeiboCharacterStickerPolicyBlock(poolChars),
      realHotPrompt
        ? [
          `真实微博热搜种子（来自 Tavily 抓取缓存，带时效标注）：\n${realHotPrompt}`,
          '改写规则（半真半假的分寸）：',
          '- 事件骨架保留（发生了什么事、公众大概什么反应），细节允许模糊或按本世界世界观改写；不要逐字复刻新闻通稿，不要声称已核实具体数据/伤亡/金额。',
          '- 涉及真实明星/艺人/企业的词条：保留"事件类型"（塌房/官宣/新作/争议），把主体替换成本世界的对应人物或虚化处理（"某顶流""某厂"），不要让真实人名和本世界角色同框互动。',
          '- 时效标注是"几小时前抓的"：刚抓取的写成正在发酵（词条+爆/热），偏旧的写成余温（讨论降温、二创和杂谈为主），不要把旧闻写成刚爆。',
        ].join('\n')
        : '真实微博热搜种子：当前未取到或未配置 Tavily，请自行生成符合本世界的站内热搜。',
      recentUsedTrending.length
        ? `近几轮站内已经用过的热搜话题（不要再原样出现，同一事件想续写就写"后续/反转/回应"角度）：${recentUsedTrending.join('、')}`
        : '',
      lifeMaterialBlock,
      lifeMaterialBlock
        ? '角色动向的用法：使用任一生活素材必须写 sourceType=life、lifeSourceOwnerId 和 subjectCharacterId，并严格遵守素材块的 ownerId；不用生活素材则写 sourceType=free 且归属字段留空。知名人士的真实动向可变成狗仔/路人帖；素人动向只能由本人发或熟人评论。旅行归来只能回顾。'
        : '',
      `近期已有微博（避免重复话题、重复措辞、重复角度）：\n${recentPostDigest}`,
      imageRules,
      stickerBlock,
      translationPrompt,
      '请生成更贴近真实微博公共生态的内容：允许新闻感、争议感、官号口吻、路人讨论、营销号切角、生活类碎片、站内转发链并存；不要把整页都写成熟人朋友圈。',
      '内容可含：日常碎片、抽奖/转发抽奖、品牌官博、周边种草、兴趣圈讨论等；可转发生活类博主、抽奖博、活动官号并写一句转发语。',
      '可适当包含平台官方账号（authorId=platform_official, authorName=平台官方）发布的公告、活动说明或辟谣声明。',
      realHotPrompt
        ? '热搜只要6条，均用 #xxx# 形式；至少3条应由上面的真实热搜种子按上述改写规则融入本世界，另外可补本世界里的绯闻、知情人爆料、路人拍到、站内活动。不要直接泄露聊天原文。'
        : '热搜只要6条，均用 #xxx# 形式。可含绯闻/知情人爆料/路人拍到/现实新闻影子，但不要直接泄露聊天原文。',
      '帖子不要全部围绕用户；角色行为应符合人设，口吻差异明显。可以出现微博站内转发链（带@），但 @ 后必须写公开昵称，禁止把 authorId、角色 ID 或 npc_xxx 当作昵称展示。评论区可以混合熟人串场、路人围观、官号口吻、营销号切角与普通网友即时反应，不要全都写成熟人互损。',
      '【角色转发来源】若 repostFromAuthorId / repostFromAuthorName 指向角色池中的通讯录角色，必须从“近期已有微博”选择该角色真实存在且非 private 的 postId，原样填写 repostFromPostId，并把该原帖正文填入 repostFromContent；没有可用原帖就把所有 repostFrom* 字段留空，绝不能凭空编造该角色发过微博。路人、媒体或站外来源不受此 postId 约束。',
      '【纯图帖评论】当 content 为空而 wantsImage 为 true 时，hotComments 必须结合 textImageCaption 或 imagePrompt 里的画面内容评论；这是正常图片帖，禁止说“空白微博”、“什么都没发”或催促配文。',
      'posts[].authorId 不得为 user、不得与当前用户档案 id 相同；禁止生成「用户本人发的」原创微博（用户发微博须在本界面亲自操作）。',
      '【配图主体】每条有 imagePrompt 的帖子都必须填写 imageCharacterId：画面描绘角色池中的某个角色（包括营销号偷拍、粉丝拍摄、官号物料）就写该角色真实 id；画面无人、仅物件/风景或人物不是角色池成员则写 none。imageCharacterId 表示图中人物，不是帖子作者。',
      refreshMode
        ? `这是日常增量刷新：posts 恰好生成 ${requestedCount} 条，必须换新角度，不得复述近期已有微博；每条带齐 reposts、comments、likes 三个正整数与恰好 ${meta.initialCommentCount} 条 hotComments。`
        : `一次生成尽量多一点：posts 至少 5 条，建议 6～8 条；每条微博必须带齐 reposts、comments、likes 三个正整数（与剧情热度一致），且 hotComments 恰好 ${meta.initialCommentCount} 条，每条含 authorId、author、content、likes。热评不得代替用户发言；通讯录角色写真实 id，普通路人写 npc。热评既可来自熟人串场，也可来自路人、粉黑大战、官号下回复、营销号受众，不要只有一种评论生态。`,
      `【数量覆盖】本轮 posts 必须恰好 ${requestedCount} 条，每条 hotComments 必须恰好 ${meta.initialCommentCount} 条；本行优先于上方兼容描述。`,
      '在全部 posts 中可掺入 0～2 条 visibility 为 fans_only（粉丝可见）或 private（仅自己可见）的微博，其余为 public；粉见/仅自己可见要在剧情上合理（如抱怨、树洞、试发）。',
      'private 微博不会被其他账号看见或互动：其 reposts、comments、likes 必须全为 0，hotComments 必须为 []；上方热评数量规则只适用于 public 与 fans_only。',
      refreshMode
        ? '可随本次动态生成 0-2 条相关微博私信；没有自然触发点就返回空数组。'
        : '并生成 3-6 条微博私信，收件人可为任意作者或用户本人，发送者身份可为粉丝/黑子/梦女/同行/营销号/广告商。',
      buildWeiboDmRelationshipBoundary(),
      meta.autoWeiboRelayRipple
        ? 'chatShares：本轮请输出空数组 []（你已在设置中开启「生成后定向补推」，转发进聊天由第二次调用按通讯录完成；与「设置→chatShares 倾向」不同：后者只影响第一轮是否自愿写 chatShares，本项为定向补推）。'
        : 'chatShares：默认必须输出空数组 []。仅当剧情明确需要「把某条微博转进聊天」时再填 1～2 条（勿为凑数输出）；倾向受「设置→社交互动倾向」影响。forwarderId 优先选用本批 posts 里已出现的 authorId。字段含义：postIndex 对应 posts 下标；private_user 或 group+真实群名；lines 为口语对白；可 wrongSend+wrongGroupName；可 recallLink:true。private_user 的唯一接收者是 user，台词不得称呼或明显写给另一个角色；若内容本应发给别的角色，本轮不要生成该 chatShare。',
      '必须只输出1个JSON对象，不允许解释。',
      'JSON Schema:',
      '【评论身份字段覆盖】hotComments 每一项都必须显式填写 authorId；通讯录角色写角色真实 id，普通网友写 npc。即使后面的兼容示例漏字段，也不得省略 authorId。',
      '【生活素材归属字段覆盖】posts 每项必须显式填写 sourceType（free|life）、lifeSourceOwnerId、subjectCharacterId；只有实际使用上方生活素材时才可写 life。',
      '{"trending":["#话题#"],"news":["简讯"],"posts":[{"authorId":"id","authorName":"name","content":"text","sourceType":"free|life","lifeSourceOwnerId":"","subjectCharacterId":"","zh":"外语才需要","tags":["#tag#"],"wantsImage":true,"imagePrompt":"street food stall, night lights","textImageCaption":"路边摊\\n铁板上滋滋作响的烤串\\n塑料凳子上放着半瓶汽水","fans":12345.6,"reposts":120,"comments":88,"likes":640,"visibility":"public|fans_only|private","repostFromAuthorId":"可空","repostFromAuthorName":"可空","repostFromPostId":"可空","repostFromContent":"原帖正文，可空","repostComment":"兼容字段，可空","hotComments":[{"authorId":"npc","author":"路人A","content":"评论","zh":"外语才需要","likes":99}]}],"dms":[{"receiverKey":"authorId或用户名","senderName":"昵称","senderType":"粉丝|黑子|梦女|梦男|同行|营销号|广告商","content":"私信内容","zh":"外语才需要"}],"chatShares":[]}',
    ].filter(Boolean).join('\n');
    const genCap = await resolveGenerationMaxTokens();
    if (!beginManualGeneration(generationStateKey, {
      kind: refreshMode ? 'refresh' : 'posts',
      message: refreshMode ? '正在刷新微博…' : '正在生成热搜与微博动态…',
    })) {
      showToast('微博已有生成任务正在进行');
      return { ok: false, busy: true, inserted: 0 };
    }
    setWeiboBusy(true, {
      imageGen: true,
      message: refreshMode ? '正在刷新微博' : '正在生成微博动态与配图',
      hint: refreshMode ? '新内容生成中，可以先浏览当前信息流' : '',
    });
    if (!refreshMode) showToast(`开始生成（max_tokens≈${genCap}）…`);
    let lastApiRaw = '';
    try {
      const userMessage = [
        prompt,
        '输出要求',
        '只输出合法JSON对象，不要解释，不要输出Markdown代码块。',
      ].join('\n\n');
      const generated = await chatJsonGeneration({
        scope: 'weibo-posts',
        retryOnInvalid: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.9,
        maxTokens: genCap,
        parse: (raw) => {
          const extracted = extractJsonObject(raw);
          if (!extracted) return null;
          try {
            return normalizeWeiboPayloadObject(JSON.parse(extracted));
          } catch (_) {
            return null;
          }
        },
        validate: (value) => value && typeof value === 'object' && Array.isArray(value.posts) && value.posts.length > 0,
      });
      lastApiRaw = generated.raw;
      if (!lastApiRaw.trim()) {
        throw new Error('接口返回内容为空，请检查模型是否把结果放在非 message.content 字段，或增大 max_tokens');
      }
      if (lastApiRaw.trim() === prompt.trim()) {
        throw new Error('接口返回疑似回显请求内容，请检查API地址/模型/鉴权');
      }
      const parsed = generated.data;
      const inserted = await persistGeneratedPayload(parsed, virtualNow, {
        realHotSnapshot,
        imageOptions,
        batch: generationBatch,
        maxPosts: requestedCount,
        allowedCharacterIds: poolChars.map((row) => row.id),
        allowedCharacters: poolChars,
      });
      finishManualGeneration(generationStateKey, {
        message: inserted > 0 ? `有 ${inserted} 条新微博` : '暂时没有新微博',
      });
      if (isCurrentWeiboRender()) {
        stopGenerationState();
        await render(container);
        if (refreshMode) {
          container.querySelector('.weibo-feed')?.scrollTo({ top: 0, behavior: 'auto' });
        }
      }
      if (inserted <= 0) showToast('暂时没有新微博');
      return { ok: true, inserted, batchId: generationBatch.id };
    } catch (e) {
      if (isCurrentWeiboRender()) {
        showGenerationErrorReport(generationErrorFromCatch(e, {
          scope: '微博 / 新帖生成',
          title: '微博生成失败',
          rawText: lastApiRaw,
        }));
      }
      finishManualGeneration(generationStateKey, {
        ok: false,
        message: `微博生成失败：${e?.message || '未知错误'}`,
      });
      showToast(`微博生成失败：${e?.message || '未知错误'}`);
      return { ok: false, error: e, inserted: 0 };
    } finally {
      setWeiboBusy(false);
    }
  }

  async function runGenerateHotTopicsOnly() {
    if (isManualGenerationRunning(generationStateKey)) {
      showToast('微博已有生成任务正在进行');
      return { ok: false, busy: true };
    }
    if (!(await ensureWeiboBackgroundConfig())) return { ok: false, cancelled: true };
    const virtualNow = await getVirtualNow(user?.id || '', 0);
    const virtualStamp = await getVirtualTimePromptStamp(user?.id || '', virtualNow);
    const realHotSnapshot = await getWeiboHotTopicSnapshot({
      limit: 12,
      refresh: true,
      enrichSummaryLimit: 3,
    }).catch(() => null);
    const realHotPrompt = formatHotSnapshotForPrompt(realHotSnapshot);
    const recentUsedTrending = collectRecentUsedTrending(meta);
    const systemPrompt = await buildWeiboAiSystemPrompt(user, season, {
      worldBookIds: meta.weiboWorldBookIds || [],
      backgroundMode: meta.weiboBackgroundMode,
      characters: [],
      characterCardMode: 'compact',
    });
    const taskPrompt = [
      `当前虚拟时间：${virtualStamp}`,
      '只刷新微博站内热搜榜和简讯，不生成微博帖子、评论、私信或聊天分享。',
      realHotPrompt
        ? `真实热搜种子（结合当前世界观改写，不照抄新闻通稿）：\n${realHotPrompt}`
        : '当前没有可用的真实热搜种子，请结合世界观生成可信的站内热点。',
      recentUsedTrending.length
        ? `近期已经出现过的话题：${recentUsedTrending.join('、')}。避免原样重复；同一事件应改成后续、回应或反转角度。`
        : '',
      '生成 10～12 条热搜，兼顾社会、文娱、生活、同城和本世界事件；每条使用 #话题# 格式。另生成 3～5 条一句话简讯。',
      '只输出合法 JSON：{"trending":["#话题#"],"news":["简讯"]}。不要输出解释或 Markdown。',
    ].filter(Boolean).join('\n\n');
    if (!beginManualGeneration(generationStateKey, {
      kind: 'hot-topics',
      message: '正在刷新热搜榜…',
    })) {
      showToast('微博已有生成任务正在进行');
      return { ok: false, busy: true };
    }
    setWeiboBusy(true, { message: '正在刷新热搜榜', hint: '只更新热搜与简讯' });
    let lastHotRaw = '';
    try {
      const generated = await chatJsonGeneration({
        scope: 'weibo-hot-topics',
        retryOnInvalid: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: taskPrompt },
        ],
        temperature: 0.88,
        parse: (raw) => {
          const extracted = extractJsonObject(raw);
          if (!extracted) return null;
          try { return JSON.parse(extracted); } catch (_) { return null; }
        },
        validate: (value) => value && Array.isArray(value.trending) && value.trending.length > 0,
      });
      lastHotRaw = generated.raw;
      const trending = [...new Set((generated.data.trending || [])
        .map((item) => String(item || '').replace(/^#+|#+$/g, '').trim())
        .filter(Boolean))]
        .slice(0, 12)
        .map((item) => `#${item}#`);
      const news = (generated.data.news || [])
        .map((item) => String(item?.title || item?.text || item || '').trim())
        .filter(Boolean)
        .slice(0, 5);
      if (!trending.length) throw new Error('模型没有生成可用热搜');
      const latestRow = await db.get('settings', weiboMetaKey).catch(() => null);
      const latest = latestRow?.value && typeof latestRow.value === 'object' ? { ...latestRow.value } : { ...meta };
      latest.trending = trending;
      latest.news = news;
      latest.trendingUpdatedAt = Date.now();
      appendWeiboGlobalContextBatch(latest, { trending, news, posts: [] });
      Object.assign(meta, latest);
      await db.put('settings', { key: weiboMetaKey, value: latest });
      finishManualGeneration(generationStateKey, { message: `热搜榜已更新 ${trending.length} 条` });
      showToast(`热搜榜已更新 ${trending.length} 条`);
      if (isCurrentWeiboRender()) {
        stopGenerationState();
        await render(container);
      }
      return { ok: true, count: trending.length };
    } catch (error) {
      if (isCurrentWeiboRender()) {
        showGenerationErrorReport(generationErrorFromCatch(error, {
          scope: '微博 / 热搜生成',
          title: '热搜生成失败',
          rawText: lastHotRaw,
        }));
      }
      finishManualGeneration(generationStateKey, {
        ok: false,
        message: `热搜生成失败：${error?.message || '未知错误'}`,
      });
      showToast(`热搜生成失败：${error?.message || '未知错误'}`);
      return { ok: false, error };
    } finally {
      setWeiboBusy(false);
    }
  }

  const openWeiboComposer = async (initialTopic = '') => {
    await openWeiboComposerSheet({
      ownerUserId,
      initialTopic,
      onPublish: async ({ text: raw, topic, visibility, media, textImage }) => {
        const pool = await getAllStickersFlat();
        const { text, imageUrls } = extractStickerTagsToImageUrls(raw, pool);
        const uploadedImages = (media || []).map((item) => item.url).filter(Boolean);
        const textImageContent = String(textImage || '').trim();
        if (!text && !textImageContent && !imageUrls.length && !uploadedImages.length) throw new Error('没有可发布的内容');
        const nowTs = await getVirtualNow(user?.id || '', 0);
        const post = {
          id: 'weibo_' + Date.now(),
          ownerUserId,
          authorId: user?.id || 'guest',
          authorName: weiboSelfAuthorName(user),
          avatar: resolveWeiboUserAvatar(user) || null,
          content: text,
          images: mergeSocialPostImageUrls(uploadedImages, imageUrls),
          textImage: uploadedImages.length || imageUrls.length ? '' : textImageContent,
          imageKind: uploadedImages.length || imageUrls.length ? 'photo' : (textImageContent ? 'textimg' : ''),
          mediaIds: (media || []).map((item) => item.id).filter(Boolean),
          tags: topic ? [`#${topic}#`] : [],
          source: 'user',
          status: 'active',
          createdAt: nowTs,
          timestamp: nowTs,
          reposts: 0,
          comments: 0,
          likes: 0,
          metadata: {
            visibility: visibility || 'public',
            generatedMedia: (media || [])
              .filter((item) => item.source === 'generated')
              .map((item) => ({ id: item.id, prompt: item.prompt || '', provider: item.provider || '' })),
          },
        };
        await db.put('weiboPosts', post);
        appendWeiboGlobalContextBatch(meta, { trending: meta.trending || [], news: meta.news || [], posts: [post] });
        await db.put('settings', { key: weiboMetaKey, value: meta });
        await render(container);
        if (meta.autoCommentAfterPublish) {
          setTimeout(() => {
            void runGenerateComments({ postIds: [post.id], automatic: true });
          }, 0);
        }
        return post;
      },
    });
  };
  container.querySelectorAll('.weibo-compose').forEach((button) => {
    button.addEventListener('click', () => void openWeiboComposer(''));
  });

  function openCommentPostPicker() {
    if (!posts.length) {
      showToast('暂无可补评论的微博');
      return;
    }
    const selectablePosts = posts.slice(0, 30);
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>选择要补评论的微博</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body wb-comment-pick-body">
        <div class="wb-comment-pick-list">
          ${selectablePosts.map((post) => {
            const author = resolveWeiboSelfAuthorLabel(post.authorName, user, '匿名用户');
            const excerpt = safeWeiboDisplayText(post.content || '（无文字内容）').replace(/\s+/g, ' ').slice(0, 72);
            const count = Array.isArray(post.commentList) ? post.commentList.length : 0;
            return `
              <label class="wb-comment-pick-row">
                <input type="checkbox" class="wb-comment-pick-check" value="${escapeAttr(post.id)}" />
                <span class="wb-comment-pick-copy">
                  <strong>${escapeHtml(author)}</strong>
                  <span>${escapeHtml(excerpt)}</span>
                  <small>${count} 条已有评论</small>
                </span>
              </label>
            `;
          }).join('')}
        </div>
        <button type="button" class="btn btn-primary wb-comment-pick-submit" disabled>为所选微博补评论</button>
      </div>
    `);
    root.querySelector('[data-modal-sheet]')?.classList.add('wb-comment-pick-sheet');
    const checks = [...root.querySelectorAll('.wb-comment-pick-check')];
    const submit = root.querySelector('.wb-comment-pick-submit');
    const syncSubmit = () => {
      const count = checks.filter((input) => input.checked).length;
      if (!submit) return;
      submit.disabled = count === 0;
      submit.textContent = count ? `为所选 ${count} 条微博补评论` : '为所选微博补评论';
    };
    checks.forEach((input) => input.addEventListener('change', syncSubmit));
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    submit?.addEventListener('click', () => {
      const postIds = checks.filter((input) => input.checked).map((input) => input.value);
      if (!postIds.length) return;
      close();
      runGenerateComments({ postIds });
    });
  }

  async function runGenerateComments({ postIds = [], automatic = false } = {}) {
    if (isManualGenerationRunning(generationStateKey)) {
      showToast('微博已有生成任务正在进行');
      return;
    }
    if (!automatic && !(await ensureWeiboBackgroundConfig())) return;
    const ownedActivePosts = (await db.getAllRecords('weiboPosts'))
      .filter((p) => p.ownerUserId === ownerUserId && isActiveWeiboPost(p))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const selectedIds = new Set((Array.isArray(postIds) ? postIds : []).map(String).filter(Boolean));
    if (selectedIds.size && ownedActivePosts.some((post) => selectedIds.has(String(post.id)) && isPrivateWeiboPost(post))) {
      showToast('仅自己可见的微博不能补评论');
      return;
    }
    const allPosts = ownedActivePosts.filter((post) => !isPrivateWeiboPost(post));
    if (!allPosts.length) {
      showToast('暂无可补评论的微博');
      return;
    }
    const candidatePosts = selectedIds.size
      ? allPosts.filter((post) => selectedIds.has(String(post.id)))
      : allPosts.slice(0, 8);
    const userLabelForPick = weiboSelfAuthorName(user);
    const needsReplyToUser = (p) => {
      const list = Array.isArray(p.commentList) ? p.commentList : [];
      const userCs = list.filter((c) => isWeiboUserComment(c, user));
      if (!userCs.length) return false;
      return !list.some((c) => (
        !isWeiboUserComment(c, user)
        && String(c.replyTo || '').trim() === userLabelForPick
      ));
    };
    const targetPosts = candidatePosts.filter((p) => {
      if (selectedIds.size) return true;
      const n = Array.isArray(p.commentList) ? p.commentList.length : 0;
      return n < 6 || needsReplyToUser(p);
    });
    if (!targetPosts.length) {
      showToast(selectedIds.size ? '没有找到所选微博' : '最近微博的评论已经比较完整');
      return;
    }
    const availableCharacters = await listSocialVisibleCharacters(user, { excludeAnonNpc: true });
    const pickedScope = automatic
      ? await resolveSavedGenerationScope({
        scopeKey: weiboCommentScopeKey,
        characters: availableCharacters,
        allowPassersbyOnly: true,
        defaultMode: 'passersby',
      })
      : await pickGenerationScope({
        scopeKey: weiboCommentScopeKey,
        characters: availableCharacters,
        title: '本轮评论角色',
        allowPassersbyOnly: true,
        passersbyLabel: '只用微博游客',
        defaultMode: 'passersby',
      });
    if (!pickedScope) return;
    const commentPoolChars = pickedScope.characters.slice(0, 18);
    const passersbyOnly = pickedScope.scope?.mode === 'passersby';
    if (!commentPoolChars.length && !passersbyOnly) {
      showToast('所选范围里没有角色');
      return;
    }
    const progressText = targetPosts.length === 1
      ? (automatic ? '正在回复评论…' : '正在为这条微博补评论…')
      : `正在为所选 ${targetPosts.length} 条微博补评论…`;
    if (!beginManualGeneration(generationStateKey, {
      kind: 'comments',
      message: progressText,
    })) {
      showToast('微博已有生成任务正在进行');
      return;
    }
    setWeiboBusy(true, { message: progressText });
    showToast(progressText);
    try {
      const roleplayCtx = passersbyOnly
        ? { snippets: [] }
        : await collectRoleplayContextForWeibo(user?.id || '', season, {
          focusCharacterIds: commentPoolChars.map((row) => row.id),
          strictFocus: true,
        });
      const systemPrompt = await buildWeiboAiSystemPrompt(user, season, {
        worldBookIds: meta.weiboWorldBookIds || [],
        backgroundMode: meta.weiboBackgroundMode,
        referenceNotes: roleplayCtx.snippets.join('\n'),
        characters: commentPoolChars,
        characterCardMode: 'compact',
        passerbyIsolation: passersbyOnly,
      });
      const virtualNow = await getVirtualNow(user?.id || '', 0);
      const virtualStamp = await getVirtualTimePromptStamp(user?.id || '', virtualNow);
      const userLabel = weiboSelfAuthorName(user);
      const prompt = [
        `当前虚拟时间:${virtualStamp}`,
        '【昼夜硬约束】评论、问候、用餐、通勤和“刚才/今晚/早上”等时间判断只能依据上述当前虚拟时间；不要因为这是新发微博就默认成早上。正文不需要时间信息时，不要自行补一个时段。',
        targetPosts.length === 1
          ? '请为以下这条微博补评论，保持微博公共平台评论生态：可混合熟人串场、路人围观、粉黑大战、官号下回复与短促即时反应。'
          : '请为以下多条微博一次性补评论，保持微博公共平台评论生态：可混合熟人串场、路人围观、粉黑大战、官号下回复与短促即时反应。',
        passersbyOnly
          ? '【本轮角色范围】只允许微博游客、普通网友与临时路人账号出场；不得使用任何通讯录角色，也不得引用角色私聊、记忆或关系进度。'
          : `【本轮角色范围】通讯录角色只允许使用：${commentPoolChars.map((row) => `${row.id}:${resolveWeiboCharacterPublicName(row, row.id)}`).join('、')}。范围外角色不得出现；普通路人账号仍可出现。`,
        '要求：评论尽量短，像接梗、互损、反问、楼中楼；不要写成长篇点评；不同帖子之间不要重复同一句梗。',
        '不要代替用户发言；用户身份只允许出现在 replyTo 中作为被回复对象。comments[].authorId 不得为 user 或当前用户 id，author 不得为用户显示名。',
        `【回复用户 · 硬性】若某帖「现有评论」里已有用户「${userLabel}」的发言，该帖补充的 comments 中至少一条必须填写 replyTo:"${userLabel}"，内容要接住用户原话，禁止无视。`,
        buildJsonFieldTranslationPromptBlock(
          collectTranslationActors(commentPoolChars),
          { fields: 'comments[].content', exampleField: 'content' },
        ),
        ...targetPosts.map((post, idx) => {
          const currentList = (Array.isArray(post.commentList) ? post.commentList : [])
            .filter(isActiveWeiboComment);
          const needed = meta.commentGenerationCount;
          const passerbyMinimum = passersbyOnly ? needed : Math.max(1, Math.ceil(needed / 2));
          const userComments = currentList.filter((c) => isWeiboUserComment(c, user));
          const hasUser = userComments.length > 0;
          return [
            `帖子索引:${idx}`,
            `postId:${post.id}`,
            `作者:${post.authorName || '某人'}`,
            formatWeiboPostForCommentPrompt(post),
            `现有评论:${currentList.length ? currentList.map((c) => `${c.author}${c.authorId ? `(${c.authorId})` : ''}${c.replyTo ? ` 回复 ${c.replyTo}` : ''}：${c.content}`).join(' / ') : '暂无'}`,
            hasUser
              ? `含用户评论:是（用户原话：${userComments.map((c) => c.content).join(' / ')}）→ 补充评论须至少一条 replyTo="${userLabel}"`
              : '含用户评论:否',
            `补充条数:${needed}`,
            `路人最低数量:${passerbyMinimum}（这些评论的 authorId 必须写 npc；其余评论才可使用允许范围内的通讯录角色）`,
          ].join('\n');
        }),
        '只输出一个 JSON 对象：{"commentPatches":[{"postId":"...","comments":[{"authorId":"通讯录角色写真实id；普通路人写npc","author":"名字","content":"评论","zh":"外语才需要","likes":12,"likedPost":true,"replyTo":"可选，回复对象称呼"}]}]}。likedPost 表示该评论者是否同时赞了原微博。',
      ].filter(Boolean).join('\n\n');
      const commentGenCap = await resolveGenerationMaxTokens();
      const commentUserMessage = [
        prompt,
        '输出要求',
        '只输出合法JSON，不要解释。',
      ].join('\n\n');
      const trustedCommentAuthorIds = new Set(commentPoolChars.map((row) => String(row.id || '').trim()).filter(Boolean));
      const allowedCommentAuthorIds = new Set([...trustedCommentAuthorIds, 'npc']);
      const commentPatchMeetsQuota = (value) => {
        const patches = Array.isArray(value?.commentPatches) ? value.commentPatches : [];
        if (!patches.length) return false;
        return targetPosts.every((post, postIndex) => {
          const positional = patches[postIndex];
          const patch = patches.find((row) => String(row?.postId || '').trim() === String(post.id || '').trim())
            || (!String(positional?.postId || '').trim() ? positional : null);
          const comments = Array.isArray(patch?.comments) ? patch.comments : [];
          const needed = meta.commentGenerationCount;
          const passerbyMinimum = passersbyOnly ? needed : Math.max(1, Math.ceil(needed / 2));
          const passerbyCount = comments.filter((comment) => /^npc(?:_|$)/i.test(String(comment?.authorId || '').trim())).length;
          return comments.length >= needed && passerbyCount >= passerbyMinimum;
        });
      };
      const generated = await chatJsonGeneration({
        scope: 'weibo-batch-comments',
        retryOnInvalid: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: commentUserMessage },
        ],
        temperature: 0.95,
        maxTokens: commentGenCap,
        validate: commentPatchMeetsQuota,
        describeValidationError: () => '模型返回的评论数量不足，或没有按要求保留微博游客评论',
      });
      const patches = generated.data.commentPatches;
      const patchMap = new Map((Array.isArray(patches) ? patches : []).map((p) => [String(p?.postId || '').trim(), p]));
      let updatedPostCount = 0;
      let appendedCommentCount = 0;
      for (const [postIndex, post] of targetPosts.entries()) {
        // 单帖生成时兼容模型漏回 postId；多帖时只按顺序接住同位置且未写 postId 的 patch。
        const positionalPatch = Array.isArray(patches) ? patches[postIndex] : null;
        const patch = patchMap.get(String(post.id || '').trim())
          || (!String(positionalPatch?.postId || '').trim() ? positionalPatch : null);
        if (!patch) continue;
        // 模型生成期间帖子可能被编辑为私密，或产生了新的用户评论。落库前
        // 重读并校验最新记录，避免泄漏互动和用旧快照覆盖并发修改。
        const livePost = await db.get('weiboPosts', post.id);
        if (!livePost || livePost.ownerUserId !== ownerUserId || !isActiveWeiboPost(livePost) || isPrivateWeiboPost(livePost)) continue;
        const currentList = (Array.isArray(livePost.commentList) ? livePost.commentList : [])
          .filter(isActiveWeiboComment);
        const policyComments = applyWeiboCharacterStickerPolicy([{
          authorId: 'npc',
          hotComments: Array.isArray(patch.comments) ? patch.comments : [],
        }], commentPoolChars)[0]?.hotComments || [];
        const normalizedCandidates = policyComments.length
          ? policyComments.map((c) => {
              const content = String(c?.content || '').trim();
              const translation = sanitizeAiTranslation(content, c?.zh || c?.translation || '');
              return normalizeWeiboCommentAuthor({
                id: String(c?.id || '').trim() || `wbc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                authorId: String(c?.authorId || '').trim(),
                author: safeWeiboActorLabel(c?.author, '路人'),
                content,
                likes: Number(c?.likes || 0) || 0,
                likedPost: c?.likedPost === true,
                replyTo: String(c?.replyTo || '').trim().slice(0, 40),
                timestamp: virtualNow,
                ...(translation ? { translation } : {}),
              }, commentPoolChars, {
                coerceUnknownToNpc: true,
                protectedAuthorIds: [user?.id],
              });
            })
          : [];
        const normalized = filterAiGeneratedComments(normalizedCandidates, user, {
          allowedAuthorIds: allowedCommentAuthorIds,
          trustedNonUserIds: trustedCommentAuthorIds,
        }).slice(0, meta.commentGenerationCount).map((comment) => {
          const commenter = availableCharacters.find((row) => String(row?.id || '') === String(comment.authorId || ''));
          const postAuthor = availableCharacters.find((row) => String(row?.id || '') === String(post.authorId || ''));
          const relationshipSafeComment = hasNegativeSocialRelationship(commenter, postAuthor)
            ? { ...comment, likedPost: false }
            : comment;
          const replyName = String(comment.replyTo || '').trim();
          if (!replyName) return relationshipSafeComment;
          const parent = [...currentList].reverse().find((row) => String(row?.author || '').trim() === replyName);
          return parent?.id
            ? { ...relationshipSafeComment, replyToCommentId: parent.id }
            : relationshipSafeComment;
        });
        if (!normalized.length) continue;
        livePost.commentList = [...currentList.map((comment, index) => (
          comment?.id ? comment : { ...comment, id: `wbc_legacy_${livePost.id}_${index}` }
        )), ...normalized];
        livePost.comments = livePost.commentList.length;
        livePost.metadata ||= {};
        const knownLikeUsers = Array.isArray(livePost.metadata.likeUsers) ? livePost.metadata.likeUsers : [];
        const likeUserKey = (row) => {
          const actorId = String(row?.authorId || '').trim();
          const actorName = String(row?.authorName || row?.author || '').trim();
          return actorId && actorId !== 'npc' ? actorId : actorName;
        };
        const likeUserMap = new Map(knownLikeUsers.map((row) => [likeUserKey(row), row]));
        for (const comment of normalized.filter((row) => row.likedPost)) {
          const key = likeUserKey(comment);
          if (key) likeUserMap.set(key, { authorId: comment.authorId || '', authorName: comment.author || '微博用户', timestamp: comment.timestamp });
        }
        livePost.metadata.likeUsers = [...likeUserMap.values()];
        await db.put('weiboPosts', livePost);
        await appendWeiboCommentNotifications({ ownerUserId, user, post: livePost, comments: normalized });
        if (String(livePost.authorId || '') === String(user?.id || '')) {
          for (const comment of normalized.filter((row) => row.likedPost)) {
            await appendWeiboNotification(ownerUserId, {
              type: 'like',
              actorId: comment.authorId,
              actorName: comment.author,
              content: '赞了你的微博',
              postId: livePost.id,
              timestamp: comment.timestamp,
            });
          }
        }
        updatedPostCount += 1;
        appendedCommentCount += normalized.length;
      }
      if (!appendedCommentCount) {
        throw new Error('模型没有返回可写入的评论，请重试');
      }
      finishManualGeneration(generationStateKey, {
        message: updatedPostCount === 1
          ? `已补充 ${appendedCommentCount} 条评论`
          : `已为 ${updatedPostCount} 条微博补充 ${appendedCommentCount} 条评论`,
      });
      if (isCurrentWeiboRender()) {
        stopGenerationState();
        await render(container);
      }
      showToast(updatedPostCount === 1
        ? `已补充 ${appendedCommentCount} 条评论`
        : `已为 ${updatedPostCount} 条微博补充 ${appendedCommentCount} 条评论`);
    } catch (e) {
      if (isCurrentWeiboRender()) {
        showGenerationErrorReport(generationErrorFromCatch(e, {
          scope: '微博 / 评论生成',
          title: '微博评论生成失败',
        }));
      }
      finishManualGeneration(generationStateKey, {
        ok: false,
        message: `补评论失败：${e?.message || '未知错误'}`,
      });
      showToast(`补评论失败：${e?.message || '未知错误'}`);
    } finally {
      setWeiboBusy(false);
    }
  }

  const runIncrementalRefresh = async () => runGenerateNewPosts({ mode: 'refresh' });
  container.querySelector('.weibo-refresh')?.addEventListener('click', runIncrementalRefresh);

  const feedScroller = container.querySelector('.weibo-feed');
  let feedScrollSaveTimer = 0;
  feedScroller?.addEventListener('scroll', () => {
    const top = Math.max(0, Number(feedScroller.scrollTop || 0));
    clearTimeout(feedScrollSaveTimer);
    feedScrollSaveTimer = setTimeout(() => {
      void persistWeiboFeedView((state) => {
        state.feedScrollPositions = {
          ...(state.feedScrollPositions || {}),
          [feedChannel]: top,
        };
      });
    }, 220);
  }, { passive: true });

  const loadMoreButton = container.querySelector('[data-wb-feed-load-more]');
  let loadingMore = false;
  const loadMoreFeed = async () => {
    if (loadingMore || !feedPage.hasMore) return;
    loadingMore = true;
    if (loadMoreButton) {
      loadMoreButton.disabled = true;
      loadMoreButton.textContent = '加载中…';
    }
    try {
      await persistWeiboFeedView((state) => {
        state.feedPagination = {
          ...(state.feedPagination || {}),
          [feedChannel]: {
            visibleCount: feedPage.nextVisibleCount,
            cursor: feedPage.cursor,
            hasMore: feedPage.hasMore,
          },
        };
        state.feedScrollPositions = {
          ...(state.feedScrollPositions || {}),
          [feedChannel]: Math.max(0, Number(feedScroller?.scrollTop || 0)),
        };
      });
      await render(container);
    } catch (error) {
      console.warn('[weibo] load more failed', error);
      loadingMore = false;
      if (loadMoreButton) {
        loadMoreButton.disabled = false;
        loadMoreButton.textContent = '重试加载';
      }
      showToast('加载失败，请重试');
    }
  };
  loadMoreButton?.addEventListener('click', loadMoreFeed);
  if (loadMoreButton && feedScroller && typeof IntersectionObserver === 'function') {
    const loadMoreObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      loadMoreObserver.disconnect();
      void loadMoreFeed();
    }, { root: feedScroller, rootMargin: '0px 0px 180px', threshold: 0.01 });
    loadMoreObserver.observe(loadMoreButton);
  }

  const pullIndicator = container.querySelector('[data-weibo-pull-refresh]');
  const pullCopy = pullIndicator?.querySelector('strong');
  let pullState = null;
  const resetPullIndicator = (delay = 0) => {
    const reset = () => {
      pullIndicator?.classList.remove('is-pulling', 'is-armed', 'is-refreshing', 'is-done', 'is-error');
      pullIndicator?.style.removeProperty('--wb-pull-distance');
      if (pullCopy) pullCopy.textContent = '下拉刷新';
    };
    if (delay) setTimeout(reset, delay);
    else reset();
  };
  feedScroller?.addEventListener('touchstart', (event) => {
    const touch = event.touches?.[0];
    if (!touch || event.touches.length !== 1 || feedScroller.scrollTop > 0 || isManualGenerationRunning(generationStateKey)) {
      pullState = null;
      return;
    }
    pullState = { x: touch.clientX, y: touch.clientY, distance: 0, vertical: false };
  }, { passive: true });
  feedScroller?.addEventListener('touchmove', (event) => {
    if (!pullState || !event.touches?.length) return;
    const touch = event.touches[0];
    const dx = touch.clientX - pullState.x;
    const dy = touch.clientY - pullState.y;
    if (!pullState.vertical) {
      if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
      if (dy <= 0 || Math.abs(dy) <= Math.abs(dx)) {
        pullState = null;
        return;
      }
      pullState.vertical = true;
    }
    event.preventDefault();
    pullState.distance = Math.min(96, Math.max(0, dy * 0.55));
    const armed = pullState.distance >= 72;
    pullIndicator?.classList.add('is-pulling');
    pullIndicator?.classList.toggle('is-armed', armed);
    pullIndicator?.style.setProperty('--wb-pull-distance', `${pullState.distance}px`);
    if (pullCopy) pullCopy.textContent = armed ? '松开刷新' : '继续下拉';
  }, { passive: false });
  const finishPullRefresh = async () => {
    if (!pullState) return;
    const shouldRefresh = pullState.vertical && pullState.distance >= 72;
    pullState = null;
    if (!shouldRefresh) {
      resetPullIndicator();
      return;
    }
    pullIndicator?.classList.remove('is-pulling', 'is-armed');
    pullIndicator?.classList.add('is-refreshing');
    if (pullCopy) pullCopy.textContent = '正在刷新';
    const result = await runIncrementalRefresh();
    if (!pullIndicator?.isConnected) return;
    pullIndicator.classList.remove('is-refreshing');
    pullIndicator.classList.add(result?.ok ? 'is-done' : 'is-error');
    if (pullCopy) pullCopy.textContent = result?.ok ? `更新了 ${result.inserted} 条微博` : (result?.cancelled ? '已取消刷新' : '刷新失败');
    resetPullIndicator(1600);
  };
  feedScroller?.addEventListener('touchend', finishPullRefresh, { passive: true });
  feedScroller?.addEventListener('touchcancel', () => {
    pullState = null;
    resetPullIndicator();
  }, { passive: true });
  container.querySelector('.weibo-pick-comments')?.addEventListener('click', openCommentPostPicker);
  if (params.panel === 'settings') queueMicrotask(() => openWeiboConfigModal());
  if (params.panel === 'comments') queueMicrotask(() => openCommentPostPicker());

  function openWeiboTopicGenerator(initialTopic = '') {
    const q = String(initialTopic || '').replace(/^#+|#+$/g, '').trim();
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>热搜与超话</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body wb-topic-generator-body" data-ime-scroll-region>
        <button type="button" class="wb-hot-refresh-only">${icon('sparkle')}<span><strong>刷新热搜榜</strong><small>只生成热搜与简讯</small></span>${icon('chevron')}</button>
        <div class="form-label wb-topic-generator-label">指定话题</div>
        <input class="form-input wb-topic-title" placeholder="话题关键词（如：聚会被偶遇）" value="${escapeAttr(q)}" />
        <input class="form-input wb-topic-roles" style="margin-top:8px;" placeholder="相关角色（可选，用顿号或逗号分隔）" />
        <textarea class="form-input wb-topic-main" rows="5" style="margin-top:8px;" placeholder="主要内容：事件经过、争议点、你希望出现的官号发言/澄清方向"></textarea>
        <button type="button" class="btn btn-outline wb-topic-open-page" style="margin-top:12px;width:100%;">打开超话</button>
        <button type="button" class="btn btn-primary wb-topic-generate" style="margin-top:8px;width:100%;">生成一批新讨论</button>
      </div>
    `);
    root?.querySelector('[data-modal-sheet]')?.classList.add('wb-topic-generator-sheet', 'modal-sheet-tall');
    const closeTopicGenerator = () => {
      close();
      if (topicGeneratorReturnRoute && currentRoute() === 'weibo') {
        navigate(topicGeneratorReturnRoute, {}, true);
      }
    };
    root.querySelector('.modal-close-btn')?.addEventListener('click', closeTopicGenerator);
    root.querySelector('.wb-hot-refresh-only')?.addEventListener('click', async () => {
      close();
      if (topicGeneratorReturnRoute && currentRoute() === 'weibo') {
        navigate(topicGeneratorReturnRoute, {}, true);
      }
      const result = await runGenerateHotTopicsOnly();
      // 生成期间用户仍停留在来源页时刷新榜单；若已经去了别处，不能把人强行拉回来。
      if (result?.ok && topicGeneratorReturnRoute && currentRoute() === topicGeneratorReturnRoute) {
        navigate(topicGeneratorReturnRoute, {}, true);
      }
    });
    root.querySelector('.wb-topic-open-page')?.addEventListener('click', () => {
      const topic = (root.querySelector('.wb-topic-title')?.value || '').trim();
      if (!topic) {
        showToast('请先填写话题关键词');
        return;
      }
      close();
      navigate('weibo-topic', { topic });
    });
    root.querySelector('.wb-topic-generate')?.addEventListener('click', async () => {
      const topic = (root.querySelector('.wb-topic-title')?.value || '').trim();
      const roles = (root.querySelector('.wb-topic-roles')?.value || '').trim();
      const main = (root.querySelector('.wb-topic-main')?.value || '').trim();
      if (!topic && !main) {
        showToast('请至少填写话题或主要内容');
        return;
      }
      if (isManualGenerationRunning(generationStateKey)) {
        showToast('微博已有生成任务正在进行');
        return;
      }
      close();
      if (!(await ensureWeiboBackgroundConfig())) return;
      const imageOptions = await pickWeiboImageOptions();
      if (!imageOptions) return;
      const pickedScope = await pickGenerationScope({
        scopeKey: 'weibo-topic',
        characters: await listSocialVisibleCharacters(user, { excludeAnonNpc: true }),
        title: '本轮话题角色',
      });
      if (!pickedScope) return;
      const topicPoolChars = pickedScope.characters.slice(0, 18);
      if (!topicPoolChars.length) {
        showToast('所选范围里没有角色');
        return;
      }
      const roleplayCtx = await collectRoleplayContextForWeibo(user?.id || '', season, {
        focusCharacterIds: topicPoolChars.map((row) => row.id),
        strictFocus: true,
      });
      const refChars = topicPoolChars.map((c) => c.name).join('、');
      const virtualNow = await getVirtualNow(user?.id || '', 0);
      const virtualStamp = await getVirtualTimePromptStamp(user?.id || '', virtualNow);
      const topicKey = normalizeWeiboTopicKey(topic);
      const superTopicProfile = topicKey
        ? await getOrCreateWeiboSuperTopic(ownerUserId, topicKey, {
          postCount: posts.filter((post) => (
            Array.isArray(post.tags) && post.tags.some((tag) => normalizeWeiboTopicKey(tag) === topicKey)
          )).length,
        })
        : null;
      const recentTopicAuthors = topicKey
        ? [...new Set(posts
          .filter((post) => (
            String(post.content || '').toLowerCase().includes(topicKey)
            || (Array.isArray(post.tags) && post.tags.some((tag) => normalizeWeiboTopicKey(tag) === topicKey))
          ))
          .slice(0, 12)
          .map((post) => post.authorName)
          .filter(Boolean))]
        : [];
      const systemPrompt = await buildWeiboAiSystemPrompt(user, season, {
        worldBookIds: meta.weiboWorldBookIds || [],
        backgroundMode: meta.weiboBackgroundMode,
        referenceNotes: roleplayCtx.snippets.join('\n'),
        characters: topicPoolChars,
        characterCardMode: 'compact',
        allowStickers: imageOptions.allowStickers !== false,
      });
      const relayHintTopic = (roleplayCtx.relayGroupNames || []).length
        ? `用户存档群名（chatShares 用 group 时 groupName 须匹配）:${roleplayCtx.relayGroupNames.join('、')}`
        : '用户无存档群聊：chatShares 仅用 private_user。';
      const socialHintTopic = buildSocialLinkPromptHint(await loadSocialLinkConfig());
      const imageGenModeTopic = await resolveSocialImageGenMode('weiboImages');
      const imageRulesTopic = buildSocialImageGenPromptRules(imageGenModeTopic, {
        surface: 'weibo',
        imageOptions,
        allowStickers: imageOptions.allowStickers !== false,
      });
      const stickerPoolTopic = imageOptions.allowStickers !== false
        ? await getAllStickersFlat().catch(() => [])
        : [];
      const stickerBlockTopic = imageOptions.allowStickers !== false
        ? buildMomentsStickerPromptBlock(stickerPoolTopic)
        : '【表情包】本次不要写 [表情包:名称]。';
      const translationPromptTopic = buildJsonFieldTranslationPromptBlock(
        collectTranslationActors(topicPoolChars),
        { fields: 'content / hotComments[].content', exampleField: 'content' },
      );
      const prompt = [
        `当前虚拟时间:${virtualStamp}`,
        `用户:${weiboSelfAuthorName(user)}，角色池:${refChars}`,
        `指定话题:${topic || '（未填）'}`,
        `相关角色:${roles || '（AI自行判断）'}`,
        `主要内容:${main || '（AI自行扩展）'}`,
        superTopicProfile
          ? `超话资料:名称=${superTopicProfile.name}；简介=${superTopicProfile.description}；主持人=${superTopicProfile.hostName}；已有帖子=${superTopicProfile.postCount}。`
          : '',
        recentTopicAuthors.length
          ? `近期活跃账号:${recentTopicAuthors.join('、')}。优先复用这些账号并保持原有语气，只补少量新成员。`
          : '尚无稳定活跃成员，请建立一组可在后续批次复用的普通账号。',
        relayHintTopic,
        socialHintTopic,
        imageRulesTopic,
        stickerBlockTopic,
        translationPromptTopic,
        `【本轮角色范围】通讯录角色只允许使用：${topicPoolChars.map((row) => `${row.id}:${resolveWeiboCharacterPublicName(row, row.id)}`).join('、')}。范围外角色不得出现；普通路人账号仍可出现。`,
        roleplayCtx.relationLines.length ? `关系摘要:\n${roleplayCtx.relationLines.join('\n')}` : '关系摘要:暂无',
        buildWeiboCharacterStickerPolicyBlock(topicPoolChars),
        '围绕该指定超话生成一批增量内容：普通讨论、求助、安利、签到、争议与主持公告混合；不要每条都写成官宣或新闻。',
        `每条 posts 须含 reposts、comments、likes；public/fans_only 恰好 ${meta.initialCommentCount} 条 hotComments（含 authorId、author、content、点赞），private 必须三项互动为 0 且 hotComments=[]。热评不得代替用户发言，通讯录角色写真实 id，普通路人写 npc；可含生活/抽奖/品牌官博/活动动态等转发语；可掺 0～2 条 visibility 为 fans_only 或 private。`,
        '【纯图帖评论】content 为空但有配图时，hotComments 要结合 textImageCaption 或 imagePrompt 的画面评论，禁止把正常图片帖说成“空白微博”或“什么都没发”。',
        'posts[].authorId 不得为 user 或当前用户 id；禁止生成用户本人发的原创微博。',
        '【配图主体】每条有 imagePrompt 的帖子都必须填写 imageCharacterId：营销号、粉丝、官号拍到或发布角色画面时写图中角色的真实 id；无人/物件/风景或非角色池人物写 none。不要把帖子作者 id 当成图中人物 id。',
        '转发是微博站内转发，不是聊天分享；可多层转发并附评论，形成链路。',
        '请生成几条微博私信（粉丝/黑子/梦男梦女/同行/营销号/广告商）。',
        buildWeiboDmRelationshipBoundary(),
        meta.autoWeiboRelayRipple
          ? 'chatShares：本轮请输出 []（已开启生成后定向补推时同主生成页说明）。'
          : 'chatShares：默认 []；仅剧情需要时再 1～2 条；倾向受「设置→社交互动倾向」影响（规则同主生成页）。private_user 的唯一接收者是 user，不得把写给其他角色的台词塞进用户私聊。',
        '只输出1个JSON对象，不允许解释。',
        'JSON Schema:',
        '【评论身份字段覆盖】hotComments 每一项都必须显式填写 authorId；通讯录角色写角色真实 id，普通网友写 npc。即使后面的兼容示例漏字段，也不得省略 authorId。',
        '{"trending":["#话题#"],"news":["简讯"],"posts":[{"authorId":"id","authorName":"name","content":"text","zh":"外语才需要","tags":["#tag#"],"wantsImage":true,"imagePrompt":"street food stall, night lights","textImageCaption":"路边摊\\n铁板上滋滋作响的烤串\\n塑料凳子上放着半瓶汽水","fans":12345.6,"reposts":120,"comments":88,"likes":640,"visibility":"public|fans_only|private","repostFromAuthorId":"可空","repostFromAuthorName":"可空","repostFromPostId":"可空","repostComment":"可空","hotComments":[{"author":"路人A","content":"评论","zh":"外语才需要","likes":99},{"author":"B","content":"…","likes":12},{"author":"C","content":"…","likes":5}]}],"dms":[{"receiverKey":"authorId或用户名","senderName":"昵称","senderType":"粉丝|黑子|梦女|梦男|同行|营销号|广告商","content":"私信内容","zh":"外语才需要"}],"chatShares":[]}',
      ].filter(Boolean).join('\n');
      const genCap = await resolveGenerationMaxTokens();
      if (!beginManualGeneration(generationStateKey, {
        kind: 'topic',
        message: `正在生成话题「${topic || '指定内容'}」…`,
      })) {
        showToast('微博已有生成任务正在进行');
        return;
      }
      setWeiboBusy(true, { imageGen: true });
      showToast('正在生成指定话题微博…');
      let lastTopicRaw = '';
      try {
        const topicUserMessage = [
          prompt,
          '输出要求',
          '只输出合法JSON，不要解释。',
        ].join('\n\n');
        const generated = await chatJsonGeneration({
          scope: 'weibo-topic',
          retryOnInvalid: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: topicUserMessage },
          ],
          temperature: 0.92,
          maxTokens: genCap,
          parse: (raw) => {
            const extracted = extractJsonObject(raw);
            if (!extracted) return null;
            try {
              return normalizeWeiboPayloadObject(JSON.parse(extracted));
            } catch (_) {
              return null;
            }
          },
          validate: (value) => value && typeof value === 'object' && Array.isArray(value.posts) && value.posts.length > 0,
        });
        lastTopicRaw = generated.raw;
        const parsed = generated.data;
        const inserted = await persistGeneratedPayload(parsed, virtualNow, {
          topicHint: topic,
          imageOptions,
          allowedCharacterIds: topicPoolChars.map((row) => row.id),
          allowedCharacters: topicPoolChars,
        });
        finishManualGeneration(generationStateKey, {
          message: `话题「${topic || '指定内容'}」已生成，新增 ${inserted} 条`,
        });
        showToast(`话题页生成完成（新增${inserted}条）`);
        if (topic && isCurrentWeiboRender()) {
          stopGenerationState();
          navigate('weibo-topic', { topic });
        }
      } catch (err) {
        if (isCurrentWeiboRender()) {
          showGenerationErrorReport(generationErrorFromCatch(err, {
            scope: '微博 / 话题页生成',
            title: '话题生成失败',
            rawText: lastTopicRaw,
          }));
        }
        finishManualGeneration(generationStateKey, {
          ok: false,
          message: `话题生成失败：${err?.message || '未知错误'}`,
        });
        showToast(`话题生成失败：${err?.message || '未知错误'}`);
      } finally {
        setWeiboBusy(false);
      }
    });
  }

  async function takePendingWeiboAction(key) {
    const latestRow = await db.get('settings', weiboMetaKey).catch(() => null);
    const latest = latestRow?.value && typeof latestRow.value === 'object' ? { ...latestRow.value } : {};
    const pending = latest[key] && typeof latest[key] === 'object' ? { ...latest[key] } : null;
    if (!pending) return null;
    delete latest[key];
    await db.put('settings', { key: weiboMetaKey, value: latest });
    if (Date.now() - Number(pending.createdAt || 0) > 120000) return null;
    return pending;
  }

  const pendingComposer = await takePendingWeiboAction('pendingWeiboComposer');
  const pendingTopicGenerator = pendingComposer ? null : await takePendingWeiboAction('pendingTopicGenerator');
  const runWhenModalFree = (action, attempt = 0) => {
    const modalHost = document.getElementById('modal-container');
    if (modalHost?.classList.contains('active') && attempt < 80) {
      setTimeout(() => runWhenModalFree(action, attempt + 1), 250);
      return;
    }
    action();
  };
  // 必须等 runWhenModalFree 初始化后再排微任务；render 中间存在 await，提前排队会在
  // 函数声明到达前执行，最终只留下微博首页而打不开热搜生成面板。
  if (params.panel === 'topics') {
    const { panel: _consumedPanel, ...restParams } = params;
    syncCurrentRoute('weibo', restParams);
    queueMicrotask(() => runWhenModalFree(() => openWeiboTopicGenerator()));
  }
  if (pendingComposer?.topic) {
    setTimeout(() => runWhenModalFree(() => void openWeiboComposer(pendingComposer.topic)), 0);
  } else if (pendingTopicGenerator?.topic) {
    setTimeout(() => runWhenModalFree(() => openWeiboTopicGenerator(pendingTopicGenerator.topic)), 0);
  }

  container.querySelectorAll('.weibo-trend-link').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const topic = btn.getAttribute('data-topic') || '';
      if (topic) navigate('weibo-topic', { topic });
    });
  });

  container.querySelectorAll('.weibo-post').forEach((postEl) => {
    postEl.querySelectorAll('.weibo-profile-link').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate('weibo-profile', {
          authorId: btn.dataset.authorId || '',
          authorName: btn.dataset.authorName || '用户',
        });
      });
    });
    postEl.addEventListener('click', (e) => {
      if (e.target.closest('button, .weibo-img-cell, [data-translation-toggle]')) return;
      navigate('weibo-detail', { postId: postEl.dataset.postId });
    });
    postEl.querySelector('[data-follow-profile]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      const key = event.currentTarget.dataset.followProfile;
      const set = new Set((meta.followingIds || []).map(String));
      if (set.has(key)) set.delete(key); else set.add(key);
      meta.followingIds = [...set];
      await db.put('settings', { key: weiboMetaKey, value: meta });
      await render(container);
    });
    postEl.querySelector('[data-act="edit"]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      const post = posts.find((item) => item.id === postEl.dataset.postId);
      if (!post || String(post.authorId || '') !== String(user?.id || '')) return;
      await openWeiboComposerSheet({
        ownerUserId,
        initialPost: post,
        onPublish: async ({ text: raw, topic, visibility, media, textImage }) => {
          const current = await db.get('weiboPosts', post.id);
          if (!current || String(current.authorId || '') !== String(user?.id || '')) throw new Error('只能编辑本人发布的微博');
          const pool = await getAllStickersFlat();
          const { text, imageUrls } = extractStickerTagsToImageUrls(raw, pool);
          const uploadedImages = (media || []).map((item) => item.url).filter(Boolean);
          const textImageContent = String(textImage || '').trim();
          if (!text && !textImageContent && !imageUrls.length && !uploadedImages.length) throw new Error('微博内容不能为空');
          const updatedAt = await getVirtualNow(user?.id || '', 0);
          const updated = {
            ...current,
            content: text,
            images: mergeSocialPostImageUrls(uploadedImages, imageUrls),
            textImage: uploadedImages.length || imageUrls.length ? '' : textImageContent,
            imageKind: uploadedImages.length || imageUrls.length ? 'photo' : (textImageContent ? 'textimg' : ''),
            mediaIds: (media || []).map((item) => item.id).filter(Boolean),
            tags: topic ? [`#${topic}#`] : [],
            updatedAt,
            metadata: {
              ...(current.metadata || {}),
              visibility: visibility || 'public',
              editedAt: updatedAt,
              generatedMedia: (media || [])
                .filter((item) => item.source === 'generated')
                .map((item) => ({ id: item.id, prompt: item.prompt || '', provider: item.provider || '' })),
            },
          };
          await db.put('weiboPosts', updated);
          const replaced = replaceWeiboPostInGlobalBatches(meta.globalWeiboBatches, updated);
          if (replaced.changed) {
            meta.globalWeiboBatches = replaced.batches;
            await db.put('settings', { key: weiboMetaKey, value: meta });
          }
          await render(container);
          return updated;
        },
      });
    });
    postEl.querySelectorAll('[data-act="comment"]').forEach((commentButton) => {
      commentButton.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post) return;
      if (isPrivateWeiboPost(post)) {
        showToast('仅自己可见的微博不开放互动');
        return;
      }
      const simModal = simulatePostMetrics(post);
      const list = post.commentList || [];
      const commentRows = await Promise.all(
        list.map(async (c, idx) => {
          const cd = buildSocialPostDisplayParts(safeWeiboDisplayText(c.content), [], stickerPool, { inlineStickers: true });
          const nameStr = resolveWeiboSelfAuthorLabel(c.author, user, '匿名');
          const commentAuthorId = String(c.authorId || '').trim();
          const url = await resolveAvatarUrl(commentAuthorId, nameStr, null, 'weibo');
          const av = `<div class="weibo-comment-avatar"><img src="${escapeAttr(url || resolveDefaultAvatar('weibo'))}" alt="" loading="lazy" decoding="async" /></div>`;
          const replyHtml = c.replyTo
            ? `<span class="weibo-comment-reply">回复 ${escapeHtml(String(c.replyTo).trim())}</span>`
            : '';
          const commentTranslation = weiboTranslationSuffixHtml(c.content || '', c.translation || '');
          return `<div class="weibo-comment-row" data-weibo-comment-post-id="${escapeAttr(post.id)}" data-weibo-comment-index="${idx}">${av}<div class="weibo-comment-main"><div class="weibo-comment-author">${escapeHtml(nameStr)}${replyHtml}</div><div class="weibo-comment-text social-richtext">${cd.richTextHtml}</div>${commentTranslation}${renderSocialPostImageStrip(cd.mergedImages, 'weibo')}</div><div class="weibo-comment-row-actions"><div class="weibo-comment-like">${formatSocialCount(estimateCommentLike(post, c))}</div><button type="button" class="weibo-comment-del-btn wb-comment-del" data-comment-idx="${idx}" aria-label="删除评论">${icon('trash', 'weibo-act-svg')}</button></div></div>`;
        }),
      );
      const { close, root } = openGlobalModal(`
        <div class="modal-header"><h3>评论</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
        <div class="modal-body weibo-comment-modal-body">
          <div class="weibo-comment-modal-tools">
            <div class="weibo-comment-modal-stats text-hint">转发 ${formatSocialCount(simModal.reposts)} · 评论 ${formatSocialCount(simModal.comments)} · 点赞 ${formatSocialCount(simModal.likes)}</div>
            <button type="button" class="weibo-comment-ai-fill" data-gen-busy-lock>AI 补评论</button>
          </div>
          <div class="weibo-comment-sheet">${commentRows.length ? commentRows.join('') : '<div class="text-hint">暂无评论</div>'}</div>
          <div class="weibo-comment-composer">
            <textarea class="form-input wb-comment" rows="2" placeholder="写评论..."></textarea>
            <button type="button" class="btn btn-primary wb-comment-send">发送</button>
          </div>
        </div>
      `);
      root.querySelector('[data-modal-sheet]')?.classList.add('weibo-comment-modal-sheet');
      root.querySelector('.modal-close-btn')?.addEventListener('click', close);
      mountStickerPickerAfterTextarea(root, '.wb-comment');
      bindWeiboImageLightbox(root);
      bindNarrationTranslationToggle(root.querySelector('[data-modal-sheet]'), {
        onRepaired: persistCommentTranslation,
        onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
      });
      root.querySelector('.weibo-comment-ai-fill')?.addEventListener('click', () => {
        close();
        runGenerateComments({ postIds: [post.id] });
      });
      root.querySelectorAll('.wb-comment-del').forEach((delBtn) => {
        delBtn.addEventListener('click', async () => {
          const idx = Number(delBtn.getAttribute('data-comment-idx'));
          if (!Number.isInteger(idx) || idx < 0) return;
          if (!confirm('确认删除这条评论吗？')) return;
          const currentPost = await db.get('weiboPosts', post.id);
          if (!currentPost) return;
          const comments = Array.isArray(currentPost.commentList) ? currentPost.commentList : [];
          if (idx >= comments.length) return;
          const [deletedComment] = comments.splice(idx, 1);
          currentPost.commentList = comments;
          currentPost.comments = comments.length;
          await db.put('weiboPosts', currentPost);
          if (deletedComment?.id) {
            await removeWeiboCommentNotification(ownerUserId, {
              postId: currentPost.id,
              commentId: deletedComment.id,
            });
          }
          close();
          await render(container);
        });
      });
      root.querySelector('.wb-comment-send')?.addEventListener('click', async () => {
        const text = (root.querySelector('.wb-comment')?.value || '').trim();
        if (!text) return;
        const livePost = await db.get('weiboPosts', post.id);
        if (!isActiveWeiboPost(livePost)) {
          close();
          showToast('这条微博已删除');
          await render(container);
          return;
        }
        const nowTs = await getVirtualNow(user?.id || '', 0);
        livePost.commentList = [
          ...(Array.isArray(livePost.commentList) ? livePost.commentList : []).filter(isActiveWeiboComment),
          buildWeiboUserComment(user, text, nowTs),
        ];
        livePost.comments = livePost.commentList.length;
        await db.put('weiboPosts', livePost);
        close();
        await render(container);
      });
      });
    });
    postEl.querySelector('[data-act="repost"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post) return;
      if (isPrivateWeiboPost(post)) {
        showToast('仅自己可见的微博不能转发');
        return;
      }
      const rawText = window.prompt('转发并评论（可空）', '');
      if (rawText === null) return;
      const txt = String(rawText).trim();
      const nowTs = await getVirtualNow(user?.id || '', 0);
      await saveWeiboRepost({
        sourcePost: post,
        ownerUserId,
        authorId: user?.id || 'guest',
        authorName: weiboSelfAuthorName(user),
        avatar: resolveWeiboUserAvatar(user) || null,
        comment: txt,
        timestamp: nowTs,
      });
      await render(container);
    });
    postEl.querySelector('[data-act="like"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post || !user) return;
      if (isPrivateWeiboPost(post)) return;
      post.metadata = post.metadata || {};
      const uid = String(user.id || '').trim();
      const uname = String(user.name || '').trim();
      const likedBy = new Set(Array.isArray(post.metadata.likedByUserIds) ? post.metadata.likedByUserIds : []);
      const hasLiked = likedBy.has(uid) || (!!uname && likedBy.has(uname));
      if (hasLiked) {
        likedBy.delete(uid);
        if (uname) likedBy.delete(uname);
        post.likes = Math.max(0, Number(post.likes || 0) - 1);
      } else {
        if (uid) likedBy.add(uid);
        else if (uname) likedBy.add(uname);
        post.likes = Math.max(0, Number(post.likes || 0)) + 1;
      }
      post.metadata.likedByUserIds = [...likedBy];
      await db.put('weiboPosts', post);
      await render(container);
    });
    postEl.querySelector('[data-act="share"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post || !user?.id) return;
      if (isPrivateWeiboPost(post)) return;
      const allChats = await db.getAllByIndex('chats', 'userId', user.id);
      const userChats = (allChats || []).filter((chat) => isUserPresentInChat(chat));
      const shareRows = await Promise.all(
        userChats.slice(0, 24).map(async (c) => {
          const lab = await formatChatPickerLabelForChat(c, resolveChatParticipantName);
          return `<button type="button" class="btn btn-outline btn-block wb-share-chat" data-cid="${escapeAttr(c.id)}">${escapeHtml(lab)}</button>`;
        }),
      );
      const { close, root } = openGlobalModal(`
        <div class="modal-header"><h3>分享至聊天</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
        <div class="modal-body wb-share-body">
          <div class="wb-share-list">
            ${shareRows.join('') || '<div class="text-hint">暂无聊天窗口</div>'}
          </div>
        </div>
      `);
      root.querySelector('[data-modal-sheet]')?.classList.add('wb-share-sheet');
      root.querySelector('.modal-close-btn')?.addEventListener('click', close);
      root.querySelectorAll('.wb-share-chat').forEach((el) => {
        el.addEventListener('click', async () => {
          const chatId = el.getAttribute('data-cid') || '';
          const target = userChats.find((c) => c.id === chatId);
          if (!target || !isUserPresentInChat(target)) {
            showToast('该窗口不支持用户转发');
            return;
          }
          const ts = await nextChatMessageTimestamp(user.id, target.id);
          const msg = createMessage({
            chatId: target.id,
            senderId: 'user',
            type: 'link',
            content: `weibo://${post.id}`,
            metadata: {
              title: `微博分享 · ${safeWeiboActorLabel(post.authorName, '匿名用户')}`,
              desc: safeWeiboDisplayText(post.content).slice(0, 80) || '查看微博',
              descFull: safeWeiboDisplayText(post.content).slice(0, 1600) || '查看微博',
              url: `weibo://${post.id}`,
              source: '微博',
              platformId: 'weibo',
              socialAuthorCharacterId: String(post.authorId || '').trim(),
              author: {
                id: String(post.authorId || '').trim(),
                name: safeWeiboActorLabel(post.authorName, '匿名用户'),
              },
              isOwnPost: [user.id, user.name, 'user']
                .map((value) => String(value || '').trim())
                .filter(Boolean)
                .includes(String(post.authorId || '').trim()),
              tags: Array.isArray(post.tags) ? post.tags.slice(0, 8) : [],
              images: Array.isArray(post.images) ? post.images.slice(0, 9) : [],
              comments: Array.isArray(post.commentList)
                ? post.commentList.slice(0, 3).map((comment) => ({
                  author: String(comment.author || '').trim(),
                  text: String(comment.content || '').trim(),
                })).filter((comment) => comment.text)
                : [],
            },
            timestamp: ts,
          });
          await db.put('messages', msg);
          target.lastMessage = '[微博分享]';
          target.lastActivity = ts;
          await db.put('chats', target);
          close();
          showToast('已分享至聊天');
        });
      });
    });
    postEl.querySelector('[data-act="delete"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const post = posts.find((p) => p.id === postEl.dataset.postId);
      if (!post) return;
      if (!confirm('确认删除这条微博吗？')) return;
      await softDeleteWeiboPost(post.id);
      await render(container);
      showActionToast('微博已删除', {
        label: '撤销',
        duration: WEIBO_DELETE_UNDO_MS,
        onAction: async () => {
          await restoreWeiboPost(post.id);
          showToast('已恢复');
          if (container.isConnected && container.dataset.page === 'weibo') await render(container);
        },
        onExpire: () => {
          void finalizeWeiboPostDeletion(post.id, post).catch(() => {});
        },
        onError: () => showToast('恢复失败，请稍后再试'),
      });
    });
  });

  bindWeiboImageLightbox(container);
  void navigate;
}
