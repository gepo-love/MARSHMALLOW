import { icon } from '../../components/svg-icons.js';
import { GEN_IMAGE_HINT } from '../../components/generation-busy.js';
import {
  coerceMomentChatLine,
  coerceMomentText,
  momentChatShareLineText,
  momentChatShareLineTranslation,
  sanitizeMomentCommentText,
} from '../../models/moment-post.js';
import { buildActorOptionsHtml } from './moments-actors.js';
import { textImageBubbleHtml } from '../chat/card-render.js';
import { momentVisibilityLabel } from './moments-visibility.js';
import { renderMomentTextWithStickers } from './moments-stickers.js';
import { normalizeSocialImagePrompt } from '../social-image-generation.js';
import { stripLeakedCharacterCodes, looksLikeRawParticipantId } from '../chat/character-code-fallback.js';
import {
  messageLikelyNeedsTranslation,
  sanitizeAiTranslation,
} from '../translation-utils.js';

const MOMENT_HEART_SVG = `
  <svg class="moment-heart-svg" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 20.2S4 15.6 4 9.6C4 6.8 5.9 5 8.4 5c1.6 0 2.9.8 3.6 2 0.7-1.2 2-2 3.6-2C18.1 5 20 6.8 20 9.6c0 6-8 10.6-8 10.6Z"/>
  </svg>
`;

const QQ_MOMENT_LIKE_SVG = `<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M8 25H4V12h4v13Zm3 0V12l4-9c2 0 3 1.4 2.4 3.4L16 11h6.5c1.8 0 2.8 1.5 2.4 3.1l-2 8.2A3.5 3.5 0 0 1 19.5 25H11Z"/></svg>`;
const QQ_MOMENT_COMMENT_SVG = `<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 5h20v15H13l-6 5v-5H4V5Z"/></svg>`;
const QQ_MOMENT_SHARE_SVG = `<svg viewBox="0 0 28 28" aria-hidden="true"><path d="m17 4 8 7-8 7v-4c-7.5 0-11 3.5-14 9 1-9 5.5-14 14-14V4Z"/></svg>`;

export function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMomentTime(ts) {
  const n = Number(ts || 0);
  if (!n) return '';
  return new Date(n).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderMomentImageRetryActions(idx = 0, message = '图片已失效') {
  return `
    <div class="moment-image-broken" hidden>
      <span>${esc(message)}</span>
      <div class="moment-image-broken-actions">
        <button type="button" data-moment-image-reroll data-moment-image-idx="${idx}">重 roll</button>
        <button type="button" data-moment-image-edit-reroll data-moment-image-idx="${idx}">改提示词重 roll</button>
      </div>
    </div>
  `;
}

function renderMomentImages(post = {}) {
  const rawImagePrompt = String(post?.imagePrompt || '').trim();
  const imagePrompt = normalizeSocialImagePrompt(post?.imagePrompt);
  const images = post?.images;
  const list = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, 9);
  const stickers = (Array.isArray(post?.stickerImages) ? post.stickerImages : [])
    .map((item) => (typeof item === 'string'
      ? { url: item, name: '' }
      : { url: String(item?.url || '').trim(), name: String(item?.name || '').trim() }))
    .filter((item) => item.url)
    .slice(0, 6);
  const photoHtml = list.length
    ? (() => {
      const count = list.length;
      const gridClass = count === 1 ? 'is-single' : count === 4 ? 'is-four' : 'is-grid';
      return `
    <div class="moment-images ${gridClass}">
      ${list.map((src, idx) => `
        <div class="moment-image-cell">
          <img src="${esc(src)}" alt="" loading="lazy" decoding="async" data-moment-image-idx="${idx}"
            onerror="this.hidden=true;var b=this.nextElementSibling;if(b){b.hidden=false;this.parentElement.classList.add('is-broken')}" />
          ${renderMomentImageRetryActions(idx)}
        </div>
      `).join('')}
    </div>`;
    })()
    : '';
  const stickerHtml = stickers.length
    ? (() => {
      const count = stickers.length;
      const gridClass = count === 1 ? 'is-single' : count === 4 ? 'is-four' : 'is-grid';
      return `<div class="moment-sticker-row ${gridClass}">${stickers.map((item) => `
        <span class="moment-sticker-chip" title="${esc(item.name || '表情包')}">
          <img src="${esc(item.url)}" alt="${esc(item.name || '表情包')}" loading="lazy" decoding="async" referrerpolicy="no-referrer"
            onerror="this.closest('.moment-sticker-chip')?.remove()" />
        </span>`).join('')}</div>`;
    })()
    : '';

  if (photoHtml || stickerHtml) return `${photoHtml}${stickerHtml}`;

  if (post?.imageKind === 'textimg' && post?.textImage) {
    const bubble = textImageBubbleHtml({ type: 'textimg', content: post.textImage }, esc, { insCard: true });
    const retryHtml = imagePrompt
      ? `<div class="moment-image-retry-wrap">
          <span>真实配图未生成，当前显示文字图</span>
          <div class="moment-image-broken-actions">
            <button type="button" data-moment-image-reroll data-moment-image-idx="0">重 roll</button>
            <button type="button" data-moment-image-edit-reroll data-moment-image-idx="0">改提示词重 roll</button>
          </div>
        </div>`
      : (rawImagePrompt
        ? `<div class="moment-image-retry-wrap">
            <span>原提示词无效，请修改后重画</span>
            <div class="moment-image-broken-actions">
              <button type="button" data-moment-image-edit-reroll data-moment-image-idx="0">改提示词重 roll</button>
            </div>
          </div>`
        : '');
    return `<div class="moment-textimg">
      <button type="button" class="moment-textimg-btn" data-moment-textimg aria-label="查看文字图">${bubble}</button>
      ${retryHtml}
    </div>`;
  }
  if (imagePrompt) {
    return `
      <div class="moment-image-missing">
        <span>配图生成失败</span>
        <div class="moment-image-broken-actions">
          <button type="button" data-moment-image-reroll data-moment-image-idx="0">重 roll</button>
          <button type="button" data-moment-image-edit-reroll data-moment-image-idx="0">改提示词重 roll</button>
        </div>
      </div>
    `;
  }
  if (rawImagePrompt) {
    return `
      <div class="moment-image-missing">
        <span>原提示词无效，请修改后重画</span>
        <div class="moment-image-broken-actions">
          <button type="button" data-moment-image-edit-reroll data-moment-image-idx="0">改提示词重 roll</button>
        </div>
      </div>
    `;
  }
  return '';
}

export function renderMomentChatShareBlock(chatShare, ctx = {}) {
  if (!chatShare || !Array.isArray(chatShare.lines) || !chatShare.lines.length) return '';
  const title = coerceMomentText(chatShare.title || '聊天记录', { max: 40 }) || '聊天记录';
  const rows = chatShare.lines.map((line) => {
    const text = momentChatShareLineText(line) || coerceMomentChatLine(line);
    if (!text) return '';
    const cleaned = cleanMomentText(text, ctx);
    const translation = momentChatShareLineTranslation(line);
    return `<div class="moment-chat-share-line">${esc(cleaned)}${momentTranslationSuffixHtml(cleaned, translation)}</div>`;
  }).filter(Boolean);
  if (!rows.length) return '';
  return `
    <div class="moment-chat-share scrapbook-panel">
      <div class="moment-chat-share-title">${esc(title)}</div>
      <div class="moment-chat-share-lines">${rows.join('')}</div>
    </div>
  `;
}

function commentAuthorKey(comment = {}) {
  return String(comment.author || comment.authorName || comment.authorId || '好友').trim() || '好友';
}

/** 点赞项可能是展示名，也可能是残留的内部 id —— 统一解成真名。 */
function resolveLikeDisplayName(entry, ctx = {}) {
  const nameMap = ctx.nameMap;
  const raw = typeof entry === 'string'
    ? String(entry || '').trim()
    : String(entry?.name || entry?.authorName || entry?.authorId || entry?.id || '').trim();
  if (!raw) return '好友';
  if (nameMap?.has?.(raw)) {
    const mapped = String(nameMap.get(raw) || '').trim();
    if (mapped) return cleanMomentText(mapped, ctx) || '好友';
  }
  // 对象带了 id 字段时再查一次
  const id = typeof entry === 'object' ? String(entry?.authorId || entry?.id || '').trim() : '';
  if (id && nameMap?.has?.(id)) {
    const mapped = String(nameMap.get(id) || '').trim();
    if (mapped) return cleanMomentText(mapped, ctx) || '好友';
  }
  const cleaned = cleanMomentText(raw, { ...ctx, fallbackLabel: '好友' });
  if (!cleaned || looksLikeRawParticipantId(cleaned) || /^phone-contact:/i.test(cleaned)) return '好友';
  return cleaned;
}

/**
 * AI 生成的评论/点赞/回复对象名有时会漏解析，把内部 id（char_xxx/npc_xxx/字面 user）
 * 原样落库或直接抄进正文——这里渲染前统一按当前昵称兜底扫一遍，解不出来才保留原文。
 */
function cleanMomentText(text, ctx = {}) {
  return stripLeakedCharacterCodes(coerceMomentText(text), {
    nameMap: ctx.nameMap,
    user: ctx.user,
    fallbackLabel: ctx.fallbackLabel || '',
  });
}

function momentTranslationSuffixHtml(source = '', translation = '') {
  const src = String(source || '').trim();
  if (!src) return '';
  const sanitized = sanitizeAiTranslation(src, translation);
  if (!sanitized && !messageLikelyNeedsTranslation(src)) return '';
  const show = sanitized || '';
  const escAttr = (v) => esc(v).replace(/"/g, '&quot;');
  return `<button type="button" class="chat-bubble-translate-btn moment-translate-btn" data-translation-toggle data-translation-source="${escAttr(src)}" aria-expanded="false">翻译</button><div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-divider"></div><div class="chat-bubble-translation-text">${esc(show)}</div></div>`;
}

function renderCommentsBlock(post, actorOptionsHtml, ctx = {}) {
  const stickerPool = ctx.stickerPool || [];
  const escAttr = (v) => esc(v).replace(/"/g, '&quot;');
  const likes = Array.isArray(post.likes) ? post.likes : [];
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const hasContent = likes.length || comments.length;
  const likeNames = likes
    .map((x) => resolveLikeDisplayName(x, ctx))
    .filter(Boolean)
    .join('、');
  const likeLine = likes.length
    ? `<div class="moment-likes-line"><span class="moment-like-icon">${MOMENT_HEART_SVG}</span>${esc(likeNames)}</div>`
    : '';
  const commentLines = comments.map((c, idx) => {
    const whoRaw = commentAuthorKey(c);
    const whoId = String(c?.authorId || '').trim();
    const whoResolved = (whoId && ctx.nameMap?.get?.(whoId))
      || (ctx.nameMap?.get?.(whoRaw))
      || whoRaw;
    const who = esc(cleanMomentText(whoResolved, { ...ctx, fallbackLabel: '好友' }) || '好友');
    // 渲染时再收敛一次历史数据里的换行/缩进；即使旧 CSS 被缓存成 pre-wrap，
    // 也不会再把每条评论撑出数行空白。
    const cleanCommentText = sanitizeMomentCommentText(cleanMomentText(c?.text || '', ctx));
    const text = renderMomentTextWithStickers(cleanCommentText, stickerPool, esc, escAttr);
    const replyToLabel = c?.replyTo ? cleanMomentText(c.replyTo, ctx) : '';
    const replyTo = replyToLabel ? `<span class="moment-comment-reply"> 回复 ${esc(replyToLabel)}</span>` : '';
    const commentTranslation = momentTranslationSuffixHtml(c?.text || '', c?.translation || '');
    // 按钮内不能有换行/缩进：white-space:pre-wrap 会保留它们，iOS 上表现为空行、首行缩进、换行顶格错乱
    return `
      <div class="moment-comment-row">
        <div class="moment-comment-main">
          <button type="button" class="moment-comment-line" data-comment-idx="${idx}" aria-expanded="false"><strong>${who}</strong>${replyTo}：${text}</button>
          ${commentTranslation}
        </div>
        <div class="moment-comment-actions" aria-hidden="true">
          <button type="button" class="moment-comment-action moment-comment-reply-btn" data-comment-idx="${idx}">回复</button>
          <button type="button" class="moment-comment-action moment-comment-del" data-comment-idx="${idx}">删除</button>
        </div>
      </div>
    `;
  }).join('');
  const currentUserName = String(ctx.user?.name || ctx.user?.nickname || '我').trim() || '我';
  const currentUserAvatar = ctx.user?.avatar
    ? `<img src="${escAttr(ctx.user.avatar)}" alt="" />`
    : `<span>${esc(currentUserName.slice(0, 1))}</span>`;

  return `
    <div class="moment-comments ${hasContent ? 'has-content' : 'is-idle'}">
      ${likeLine}
      ${commentLines}
      <button type="button" class="moment-comment-prompt moment-quick-comment"><span class="moment-comment-prompt-avatar">${currentUserAvatar}</span><span>说点什么吧…</span></button>
      <div class="moment-comment-compose">
        ${actorOptionsHtml ? `<select class="form-input moment-actor-select" title="互动身份">${actorOptionsHtml}</select>` : ''}
        <input type="text" class="form-input moment-comment-input" placeholder="写评论…" />
        <button type="button" class="btn btn-primary btn-sm moment-comment-send">发送</button>
      </div>
    </div>
  `;
}

export function resolveMomentPostAvatar(post, avatarMap) {
  const authorId = String(post?.authorId || '').trim();
  // 优先用当前角色/联系人头像，避免帖子写入时的旧快照把换头挡掉
  if (authorId && avatarMap) {
    const live = String(avatarMap.get(authorId) || '').trim();
    if (live) return live;
  }
  return String(post?.avatar || post?.authorAvatar || '').trim();
}

export function renderMomentPostCard(post, ctx = {}) {
  const nameMap = ctx.nameMap || new Map();
  const displayName = cleanMomentText(nameMap.get(post.authorId) || post.authorName || 'TA', { ...ctx, nameMap });
  const actorOptionsHtml = buildActorOptionsHtml(ctx.actors || [], ctx.user?.id);
  const avatarUrl = resolveMomentPostAvatar(post, ctx.avatarMap);
  const avatarHtml = avatarUrl
    ? `<img src="${esc(avatarUrl)}" alt="" class="moment-post-avatar-img" />`
    : `<span class="moment-post-avatar-letter">${esc(displayName.slice(0, 1))}</span>`;

  const visLabel = momentVisibilityLabel(post, ctx.groupNameMap || new Map());
  const escAttr = (v) => esc(v).replace(/"/g, '&quot;');
  const bodyHtml = renderMomentTextWithStickers(cleanMomentText(post.content || '', { ...ctx, nameMap }), ctx.stickerPool || [], esc, escAttr)
    .replace(/\n/g, '<br>');
  const contentTranslation = momentTranslationSuffixHtml(
    post.content || '',
    post.metadata?.contentTranslation || post.contentTranslation || '',
  );
  const visHtml = visLabel
    ? `<span class="moment-post-vis">${esc(visLabel)}</span>`
    : '';
  const quickLiked = (post.likesIds || []).includes(String(ctx.user?.id || ''));

  return `
    <article class="moment-post scrapbook-card" data-moment-id="${esc(post.id)}">
      <header class="moment-post-head">
        <button type="button" class="moment-post-avatar" data-author-id="${esc(post.authorId)}">${avatarHtml}</button>
        <button type="button" class="moment-post-name" data-author-id="${esc(post.authorId)}">${esc(displayName)}</button>
      </header>
      <div class="moment-post-body"><div class="moment-post-text">${bodyHtml}</div>${contentTranslation}</div>
      ${renderMomentChatShareBlock(post.chatShare, { ...ctx, nameMap })}
      ${renderMomentImages(post)}
      <div class="moment-post-meta">
        <span class="moment-post-time">${esc(formatMomentTime(post.timestamp))}</span>
        ${visHtml}
        <div class="moment-post-quick-actions">
          <button type="button" class="moment-quick-like${quickLiked ? ' is-active' : ''}" aria-label="赞" aria-pressed="${quickLiked ? 'true' : 'false'}">${QQ_MOMENT_LIKE_SVG}</button>
          <button type="button" class="moment-quick-comment" aria-label="评论">${QQ_MOMENT_COMMENT_SVG}</button>
          <button type="button" class="moment-quick-share" aria-label="转发">${QQ_MOMENT_SHARE_SVG}</button>
        </div>
        <button type="button" class="moment-post-more" aria-label="赞 · 评论 · 更多">${icon('more')}</button>
      </div>
      ${renderCommentsBlock(post, actorOptionsHtml, ctx)}
    </article>
  `;
}

export function renderMomentsHeader(user, prefs = {}) {
  const name = String(user?.name || user?.nickname || '我').trim();
  const avatar = user?.avatar
    ? `<img src="${esc(user.avatar)}" alt="" class="moments-cover-avatar-img" />`
    : `<span class="moments-cover-avatar-letter">${esc(name.slice(0, 1))}</span>`;
  const coverStyle = prefs.coverImage ? ` style="background-image:url('${esc(prefs.coverImage)}')"` : '';
  return `
    <section class="moments-cover scrapbook-card"${coverStyle}>
      <button type="button" class="moments-cover-edit btn btn-soft btn-sm" data-moments-cover>换封面</button>
      <div class="moments-cover-avatar">${avatar}</div>
      <div class="moments-cover-name">${esc(name)}</div>
    </section>
  `;
}

export function setMomentsBusy(container, on, message = '', options = {}) {
  const el = container?.querySelector?.('.moments-busy-overlay');
  const tx = el?.querySelector?.('.moments-busy-text');
  let hintEl = el?.querySelector?.('.moments-busy-hint');
  if (el && !hintEl) {
    hintEl = document.createElement('div');
    hintEl.className = 'moments-busy-hint app-busy-hint';
    hintEl.hidden = true;
    el.appendChild(hintEl);
  }
  if (el) {
    el.classList.toggle('is-visible', !!on);
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
  if (tx && message) tx.textContent = message;
  if (hintEl) {
    const hint = options.imageGen ? GEN_IMAGE_HINT : (options.hint || '');
    hintEl.textContent = hint;
    hintEl.hidden = !hint;
  }
  container?.querySelectorAll?.('[data-moments-busy-lock]').forEach((btn) => {
    btn.disabled = !!on;
    btn.classList.toggle('is-loading', !!on);
    if (on) btn.classList.add('is-gen-locked');
    else btn.classList.remove('is-gen-locked');
  });
}
