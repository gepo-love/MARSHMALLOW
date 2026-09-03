/**
 * 社交页（朋友圈 / 微博 / 论坛）正文：支持 [表情包:名]；列表展示时从正文剥离已解析标签，与上传照片一并走底部图区。
 */
import { expandStickerTagsInBubbleText } from '../core/social-helpers.js';
import {
  normalizeStickerBracketText,
  resolveStickerUrlByExactName,
  resolveStickerUrlByKeyword,
} from '../core/chat/sticker-resolve.js';
import { renderCategorizedStickerPickerInto } from './categorized-sticker-picker.js';
import { textImageBubbleHtml } from '../core/chat/card-render.js';
import { openImageLightbox } from './image-lightbox.js';
import { openChatCardModal } from './chat-interactive-modals.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanStickerRemovalSpacing(text = '') {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function collectSocialStickerTagNames(content = '', stickerPool = []) {
  const raw = normalizeStickerBracketText(String(content ?? ''));
  const pool = Array.isArray(stickerPool) ? stickerPool : [];
  const names = [];
  const re = /\[(?:表情包|贴纸)[:：]\s*([^\]]+)\]|\[([^\]\r\n]{1,80})\]/g;
  raw.replace(re, (_full, explicitName, bareName) => {
    const name = String(explicitName || bareName || '').trim();
    if (explicitName || resolveStickerUrlByExactName(name, pool)) names.push(name);
    return _full;
  });
  return [...new Set(names.filter(Boolean))];
}

/** 标题、摘要等纯文本位置不得露出表情包协议标记。 */
export function stripSocialStickerMarkers(content = '', stickerPool = []) {
  const raw = normalizeStickerBracketText(String(content ?? ''));
  const pool = Array.isArray(stickerPool) ? stickerPool : [];
  const re = /\[(?:表情包|贴纸)[:：]\s*([^\]]+)\]|\[([^\]\r\n]{1,80})\]/g;
  const stripped = raw.replace(re, (full, explicitName, bareName) => {
    if (explicitName) return '';
    return resolveStickerUrlByExactName(String(bareName || '').trim(), pool) ? '' : full;
  });
  return cleanStickerRemovalSpacing(stripped);
}

/** 译文只翻正文，不复述或翻译表情包名称。 */
export function stripSocialStickerTranslationArtifacts(source = '', translation = '', stickerPool = []) {
  const names = collectSocialStickerTagNames(source, stickerPool);
  let cleaned = stripSocialStickerMarkers(translation, stickerPool)
    .replace(/(?:^|\n)\s*(?:表情包|贴纸)\s*[:：]\s*[^\n]+\s*(?=\n|$)/giu, '\n');
  const knownNames = names.length
    ? (Array.isArray(stickerPool) ? stickerPool : []).map((row) => String(row?.name || '').trim()).filter(Boolean)
    : [];
  for (const name of [...new Set([...names, ...knownNames])]) {
    const escaped = escapeRegex(name);
    cleaned = cleaned
      .replace(new RegExp(`(?:^|\\n)\\s*(?:表情包|贴纸)?\\s*[:：]?\\s*${escaped}\\s*(?=\\n|$)`, 'giu'), '\n')
      .replace(new RegExp(`\\s*[（(]?(?:表情包|贴纸)\\s*[:：]?\\s*${escaped}[）)]?\\s*$`, 'iu'), '');
  }
  return cleanStickerRemovalSpacing(cleaned);
}

/**
 * @param {string} raw
 * @param {Array<{ url?: string, name?: string }>} stickerPool
 */
export function renderSocialRichText(raw, stickerPool) {
  return expandStickerTagsInBubbleText(raw ?? '', stickerPool || [], escapeHtml, escapeAttr);
}

/**
 * 主楼发布：将正文中的 `[表情包:名]` 解析为本地表情 URL，用于并入 images（与上传照片同一套九宫格展示）。
 * 已解析的标签从正文移除，避免与图片区重复渲染；无法解析的标签保留在正文。
 */
export function extractStickerTagsToImageUrls(content, stickerPool) {
  const raw = normalizeStickerBracketText(String(content ?? ''));
  const pool = Array.isArray(stickerPool) ? stickerPool : [];
  if (!raw || !pool.length) return { text: raw, imageUrls: [] };
  const imageUrls = [];
  const re = /\[(?:表情包|贴纸)[:：]\s*([^\]]+)\]|\[([^\]\r\n]{1,80})\]/g;
  const stripped = raw.replace(re, (full, explicitName, bareName) => {
    const kw = String(explicitName || bareName || '').trim();
    const r = explicitName
      ? resolveStickerUrlByKeyword(kw, pool, { fallbackToAll: false })
      : resolveStickerUrlByExactName(kw, pool);
    if (r?.url) {
      imageUrls.push(r.url);
      return '';
    }
    return full;
  });
  const text = stripped
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, imageUrls };
}

/**
 * 楼层/评论：把夹在句子中间的 `[表情包:]` / `[贴纸:]` 挪到全文末尾，
 * 避免「水蜜[表情包]桃头像」被表情拆成两截。
 */
export function moveInlineStickerTagsToEnd(content = '', stickerPool = []) {
  const raw = normalizeStickerBracketText(String(content ?? ''));
  if (!raw) return raw;
  const pool = Array.isArray(stickerPool) ? stickerPool : [];
  const tags = [];
  const re = /\[(?:表情包|贴纸)[:：]\s*([^\]]+)\]|\[([^\]\r\n]{1,80})\]/g;
  const without = raw.replace(re, (full, explicitName, bareName) => {
    if (!explicitName && !resolveStickerUrlByExactName(bareName, pool)) return full;
    tags.push(full);
    return '';
  });
  if (!tags.length) return raw;
  const cleaned = without
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!cleaned) return tags.join('\n');
  return `${cleaned}\n${tags.join('\n')}`;
}

/** 合并上传图与表情图 URL，去重，保持顺序 */
export function mergeSocialPostImageUrls(existing, stickerUrls) {
  const out = [...(Array.isArray(existing) ? existing : [])];
  const seen = new Set(out);
  for (const u of stickerUrls || []) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * 主贴展示：正文去掉可解析的 `[表情包:]` 后走富文本；图片 URL = 原 images + 表情图，供底部九宫格。
 * @param {{ inlineStickers?: boolean }} [options] 楼层/评论等短内容用 inlineStickers，避免表情进固定方格被 cover 裁切。
 */
export function buildSocialPostDisplayParts(rawContent, images, stickerPool, options = {}) {
  const pool = Array.isArray(stickerPool) ? stickerPool : [];
  const inlineStickers = !!options.inlineStickers;
  const raw = String(rawContent ?? '');
  const baseImages = Array.isArray(images) ? images : [];

  if (inlineStickers) {
    const reordered = moveInlineStickerTagsToEnd(raw, pool);
    return {
      richTextHtml: renderSocialRichText(reordered, pool),
      mergedImages: baseImages,
      stickerImageUrls: [],
      textPlain: reordered,
    };
  }

  const { text, imageUrls } = extractStickerTagsToImageUrls(raw, pool);
  const mergedImages = mergeSocialPostImageUrls(baseImages, imageUrls);
  return {
    richTextHtml: renderSocialRichText(text, pool),
    mergedImages,
    stickerImageUrls: imageUrls,
    textPlain: text,
  };
}

/** 微博 / 朋友圈 / 论坛 底部图片区（与各自现有 cell 类名一致） */
export function renderSocialPostImageStrip(images, variant = 'weibo', options = {}) {
  const arr = Array.isArray(images) ? images.filter(Boolean).map(String) : [];
  if (!arr.length) return '';
  const stickerUrlSet = new Set(
    (Array.isArray(options.stickerUrls) ? options.stickerUrls : []).filter(Boolean).map(String),
  );
  const slice = arr.slice(0, 9);
  const count = slice.length;
  const cellClass =
    variant === 'moment' ? 'moment-img-cell' : variant === 'forum' ? 'forum-img-cell' : 'weibo-img-cell';
  let wrapClass =
    variant === 'moment'
      ? 'moment-images social-post-media-strip'
      : variant === 'forum'
        ? 'forum-thread-images social-post-media-strip'
        : 'weibo-images social-post-media-strip';
  if (variant === 'weibo') {
    const gridClass = count === 1 ? 'is-single' : count === 4 ? 'is-four' : 'is-grid';
    wrapClass = `${wrapClass} ${gridClass}`;
  }
  const cells = slice
    .map((src, idx) => {
      const stickerCls = stickerUrlSet.has(src) ? ' is-sticker' : '';
      const dataIdx = variant === 'weibo' ? ` data-weibo-image-idx="${idx}"` : '';
      return `<div class="${cellClass}${stickerCls}"><img src="${escapeAttr(src)}" alt="" loading="lazy" decoding="async"${dataIdx} /></div>`;
    })
    .join('');
  return `<div class="${wrapClass}">${cells}</div>`;
}

/** 社交页配图：真图走 lightbox，文字图走完整详情弹层。 */
export function bindSocialPostMediaInteractions(root) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('.weibo-img-cell img, .forum-img-cell img').forEach((img) => {
    img.classList.add('is-progressive');
    if (img.complete) img.classList.add('is-loaded');
    else img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
    if (img.dataset.lightboxBound === '1') return;
    img.dataset.lightboxBound = '1';
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const src = String(img.getAttribute('src') || '').trim();
      if (!src) return;
      openImageLightbox(src);
    });
  });

  root.querySelectorAll('[data-social-textimg]').forEach((card) => {
    if (card.dataset.textimgBound === '1') return;
    card.dataset.textimgBound = '1';
    const openDetail = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const content = String(card.getAttribute('data-social-textimg-content') || '').trim();
      if (!content) return;
      openChatCardModal({ type: 'textimg', content });
    };
    card.addEventListener('click', openDetail);
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      openDetail(e);
    });
  });
}

/** 兼容旧调用名。 */
export function bindWeiboImageLightbox(root) {
  bindSocialPostMediaInteractions(root);
}

/** 未开生图或生图失败时的文字图预览（微博 / 论坛等） */
export function renderSocialTextImageBlock(textImage, escFn = escapeHtml, options = {}) {
  const raw = String(textImage || '').trim();
  if (!raw) return '';
  const bubble = textImageBubbleHtml({ type: 'textimg', content: raw }, escFn, { insCard: true });
  if (options.interactive) {
    return `<div class="social-textimg-wrap social-textimg-open" role="button" tabindex="0" aria-label="查看文字图" data-social-textimg data-social-textimg-content="${escapeAttr(raw)}">${bubble}</div>`;
  }
  return `<div class="social-textimg-wrap">${bubble}</div>`;
}

/** 配图区：真图九宫格 + 文字图兜底 */
export function renderSocialPostMediaBlock(post = {}, mergedImages = [], variant = 'weibo', options = {}) {
  const imgs = renderSocialPostImageStrip(mergedImages, variant, options);
  const hasPhoto = Array.isArray(mergedImages) && mergedImages.filter(Boolean).length > 0;
  const textImg = (!hasPhoto && post?.imageKind === 'textimg' && post?.textImage)
    ? renderSocialTextImageBlock(post.textImage, escapeHtml, { interactive: variant === 'weibo' || variant === 'forum' })
    : '';
  return `${textImg}${imgs}`;
}

/**
 * 在输入框后挂载「表情包」按钮与网格；点击表情插入 `[表情包:显示名]`
 * @param {ParentNode} root
 * @param {string} textareaSelector
 * @returns {() => void}
 */
export function mountStickerPickerAfterTextarea(root, textareaSelector) {
  const ta = root.querySelector(textareaSelector);
  if (!ta) return () => {};
  if (ta.nextElementSibling?.classList?.contains('social-sticker-wrap')) {
    return () => {};
  }

  const wrap = document.createElement('div');
  wrap.className = 'social-sticker-wrap';
  ta.insertAdjacentElement('afterend', wrap);
  wrap.innerHTML = `
    <button type="button" class="btn btn-outline btn-sm social-sticker-toggle" style="margin-top:6px;" title="插入后发布时与上传照片相同，进入主楼图片区展示">表情包</button>
    <div class="social-sticker-grid chat-sticker-picker" style="display:none;"></div>
  `;
  const toggle = wrap.querySelector('.social-sticker-toggle');
  const grid = wrap.querySelector('.social-sticker-grid');

  toggle.addEventListener('click', async () => {
    const open = grid.style.display === 'none';
    if (!open) {
      grid.style.display = 'none';
      return;
    }
    grid.style.display = 'flex';
    grid.style.flexDirection = 'column';
    grid.style.marginTop = '8px';
    grid.dataset.built = '1';
    const built = await renderCategorizedStickerPickerInto(grid, {
      onPick: (item) => {
        const name = item.name || '表情';
        const insert = `[表情包:${name}]`;
        const el = ta;
        const start = typeof el.selectionStart === 'number' ? el.selectionStart : String(el.value || '').length;
        const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
        const v = String(el.value || '');
        el.value = `${v.slice(0, start)}${insert}${v.slice(end)}`;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        const pos = start + insert.length;
        if (typeof el.setSelectionRange === 'function') {
          el.focus();
          el.setSelectionRange(pos, pos);
        }
        grid.style.display = 'none';
      },
    });
    if (!built) grid.style.display = 'none';
  });

  return () => {
    wrap.remove();
  };
}
