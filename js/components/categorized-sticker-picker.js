/**
 * 按表情包分类（pack）展示选择器，供私聊/群聊/社交/插入气泡等复用。
 */
import { listStickerPacks } from '../core/sticker-store.js';
import { sanitizeStickerDisplayName } from '../core/sticker-store.js';
import {
  peekStickerThumbSrcMap,
  ensureStickerThumbs,
  applyStickerThumbToImgs,
  stickerDomDisplayFallback,
} from '../core/sticker-thumb-cache.js';
import { showToast } from './toast.js';

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

export async function loadSortedStickerPacks() {
  const packs = await listStickerPacks();
  return [...packs].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
}

export function stickerPacksHaveStickers(packs) {
  return (Array.isArray(packs) ? packs : []).some((p) => (p.stickers || []).length > 0);
}

/**
 * 在容器内渲染「分类 tab + 表情网格」。
 * @param {HTMLElement} container
 * @param {{ onPick: (item: { url: string, name: string, packName: string, packId: string }) => void, showLabels?: boolean }} options
 * @returns {Promise<boolean>} 是否有可展示的表情
 */
export async function renderCategorizedStickerPickerInto(container, { onPick, showLabels = true } = {}) {
  if (!container || typeof onPick !== 'function') return false;
  const packs = await loadSortedStickerPacks();
  if (!stickerPacksHaveStickers(packs)) {
    showToast('还没有表情包，请先在表情包管理里导入');
    return false;
  }

  let selectedPackId = packs.find((p) => (p.stickers || []).length)?.id || packs[0]?.id;
  const allStickers = packs.flatMap((p) => p.stickers || []);
  const thumbSrcMap = await peekStickerThumbSrcMap(allStickers).catch(() => new Map());

  container.classList.add('chat-sticker-picker', 'chat-sticker-picker--categorized');
  container.innerHTML = `
    <div class="stk-cat-tabs preset-tab-row" style="flex-shrink:0;overflow-x:auto;"></div>
    <div class="stk-cat-grid"></div>
  `;
  const tabsEl = container.querySelector('.stk-cat-tabs');
  const gridEl = container.querySelector('.stk-cat-grid');

  const paint = () => {
    tabsEl.innerHTML = packs
      .map((p) => {
        const n = (p.stickers || []).length;
        const active = p.id === selectedPackId ? ' active' : '';
        const disabled = n ? '' : ' disabled';
        return `<button type="button" class="preset-tab stk-cat-tab${active}" data-pack-id="${escapeAttr(p.id)}"${disabled}>${escapeHtml(p.name || '未命名')}${n ? ` (${n})` : ''}</button>`;
      })
      .join('');

    const pack = packs.find((p) => p.id === selectedPackId) || packs[0];
    const stickers = pack?.stickers || [];
    const packName = String(pack?.name || '').trim();
    const packId = String(pack?.id || '').trim();

    if (!stickers.length) {
      gridEl.innerHTML = '<div class="text-hint" style="padding:12px;text-align:center;">该分类暂无表情</div>';
    } else {
      gridEl.innerHTML = stickers
        .map((s, index) => {
          const disp = sanitizeStickerDisplayName(s.name || '表情包');
          const url = String(s.url || '').trim();
          const sid = String(s.id || '').trim();
          const fallback = stickerDomDisplayFallback(url);
          const displaySrc = (sid && thumbSrcMap.get(sid)) || fallback;
          const srcAttr = displaySrc ? ` src="${escapeAttr(displaySrc)}"` : '';
          const fallbackAttr = fallback ? ` data-stk-fallback="${escapeAttr(fallback)}"` : '';
          const labelHtml = showLabels
            ? `<span class="stk-pick-label" title="${escapeAttr(disp)}">${escapeHtml(disp)}</span>`
            : '';
          return `<button type="button" class="stk-pick" data-sticker-index="${index}"><img class="stk-pick-img"${srcAttr} alt="${escapeAttr(disp)}" data-stk-id="${escapeAttr(sid)}"${fallbackAttr} loading="lazy" decoding="async" />${labelHtml}</button>`;
        })
        .join('');
    }

    tabsEl.querySelectorAll('.stk-cat-tab:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedPackId = String(btn.getAttribute('data-pack-id') || '');
        paint();
      });
    });

    gridEl.querySelectorAll('.stk-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sticker = stickers[Number(btn.getAttribute('data-sticker-index'))];
        if (!sticker) return;
        onPick({
          url: String(sticker.url || ''),
          name: sanitizeStickerDisplayName(sticker.name || '表情包'),
          packName,
          packId,
        });
      });
    });
  };

  paint();
  ensureStickerThumbs(allStickers, {
    onReady: (id, src) => {
      thumbSrcMap.set(id, src);
      applyStickerThumbToImgs(container, id, src);
    },
  }).catch(() => {});
  return true;
}
