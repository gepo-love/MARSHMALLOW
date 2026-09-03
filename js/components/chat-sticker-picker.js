import { icon } from './svg-icons.js';
import {
  getStickerPack,
  listStickerPackSummaries,
  listStickerPacks,
  upgradeStickerImageUrl,
} from '../core/sticker-store.js';
import {
  peekStickerThumbSrcMap,
  ensureStickerThumbs,
  applyStickerThumbToImgs,
  stickerDomDisplayFallback,
} from '../core/sticker-thumb-cache.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return esc(value).replace(/'/g, '&#39;');
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function stickerPickOnErrorAttr() {
  return "var fb=this.getAttribute('data-stk-fallback');if(fb&&this.getAttribute('src')!==fb){this.setAttribute('src',fb);return;}this.style.opacity='0.35'";
}

function renderStickerButtons(stickers, thumbSrcMap) {
  if (!stickers.length) return '<p class="text-hint chat-sticker-empty">没有匹配的表情</p>';
  return `<div class="chat-sticker-grid">${stickers.map((s) => {
    const fallback = stickerDomDisplayFallback(upgradeStickerImageUrl(s.url));
    const displaySrc = (s.id && thumbSrcMap?.get(s.id)) || fallback;
    const srcAttr = displaySrc ? ` src="${escAttr(displaySrc)}"` : '';
    const fallbackAttr = fallback ? ` data-stk-fallback="${escAttr(fallback)}"` : '';
    return `
    <button type="button" class="chat-sticker-pick" data-idx="${s.idx}" title="${escAttr(s.name)} · ${escAttr(s.packName || '未分组')}">
      <img${srcAttr} alt="${escAttr(s.name)}" data-stk-id="${escAttr(s.id || '')}"${fallbackAttr} loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="${stickerPickOnErrorAttr()}" />
      <span class="chat-sticker-pick-name">${esc(s.name)}</span>
    </button>`;
  }).join('')}</div>`;
}

function renderGroupTabs(groups, activeId) {
  if (groups.length < 2) return '';
  return `<div class="chat-sticker-tabs" data-sticker-tabs>${groups.map((g) => `
    <button type="button" class="chat-sticker-tab${g.id === activeId ? ' active' : ''}" data-group-id="${escAttr(g.id)}">${esc(g.name)}<span class="chat-sticker-tab-count">${g.count}</span></button>`).join('')}</div>`;
}
export const CHAT_STICKER_PICKER_RENDER_BATCH = 60;

export function stickerPickerVisibleRows(rows = [], limit = CHAT_STICKER_PICKER_RENDER_BATCH) {
  const safeLimit = Math.max(1, Number(limit) || CHAT_STICKER_PICKER_RENDER_BATCH);
  return (Array.isArray(rows) ? rows : []).slice(0, safeLimit);
}

export function stickerPickerPageRows(rows = [], page = 0, pageSize = CHAT_STICKER_PICKER_RENDER_BATCH) {
  const source = Array.isArray(rows) ? rows : [];
  const safePageSize = Math.max(1, Number(pageSize) || CHAT_STICKER_PICKER_RENDER_BATCH);
  const maxPage = Math.max(0, Math.ceil(source.length / safePageSize) - 1);
  const safePage = Math.min(maxPage, Math.max(0, Math.floor(Number(page) || 0)));
  const start = safePage * safePageSize;
  return {
    rows: source.slice(start, start + safePageSize),
    page: safePage,
    pageCount: Math.max(1, Math.ceil(source.length / safePageSize)),
    start,
    total: source.length,
  };
}

let stickerChoiceCache = { at: 0, rows: [] };

function flattenStickerPacks(packs = []) {
  const rows = [];
  for (const pack of packs) {
    const packId = String(pack?.id || '').trim() || `pack-${rows.length}`;
    for (const sticker of pack?.stickers || []) {
      const url = String(sticker?.url || '').trim();
      if (!url) continue;
      rows.push({
        idx: rows.length,
        id: String(sticker?.id || '').trim(),
        name: String(sticker?.name || pack?.name || '表情').trim(),
        url,
        packId,
        packName: String(pack?.name || '').trim() || '未分组',
      });
    }
  }
  return rows;
}

async function listChatStickerChoices() {
  const now = Date.now();
  if (stickerChoiceCache.rows.length && now - stickerChoiceCache.at < 15_000) {
    return stickerChoiceCache.rows;
  }
  const rows = flattenStickerPacks(await listStickerPacks());
  stickerChoiceCache = { at: now, rows };
  return rows;
}

export async function findChatStickerChoices(value, { limit = 6 } = {}) {
  const query = normalizeSearchText(value);
  if (!query) return [];
  const rows = await listChatStickerChoices();
  return rows
    .map((sticker) => {
      const name = normalizeSearchText(sticker.name);
      const pack = normalizeSearchText(sticker.packName);
      let score = 0;
      if (name === query) score = 100;
      else if (name.startsWith(query)) score = 80;
      else if (name.includes(query)) score = 65;
      else if (query.includes(name) && name.length >= 2) score = 55;
      else if (pack.includes(query)) score = 30;
      return { sticker, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.sticker.name.length - b.sticker.name.length)
    .slice(0, Math.max(1, Number(limit) || 6))
    .map((row) => row.sticker);
}

/**
 * @param {{ onPick?: (sticker: { id: string, name: string, url: string, packId: string, packName: string }) => void }} options
 */
export async function openChatStickerPicker({ onPick } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return null;
  // Paint a blocking first frame before touching IndexedDB or Cache Storage. This
  // gives immediate feedback and prevents a second tap from reaching the chat.
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-sticker-picker-overlay>
      <div class="modal-sheet scrapbook-card chat-sticker-picker-sheet is-loading" role="dialog" aria-modal="true" aria-busy="true">
        <header class="modal-header"><h3>选择表情</h3></header>
        <div class="modal-body chat-sticker-picker-body"><div class="chat-sticker-loading" aria-label="正在加载"></div></div>
      </div>
    </div>`;
  const summaries = await listStickerPackSummaries().catch((err) => {
    host.classList.remove('active');
    host.innerHTML = '';
    throw err;
  });
  const totalCount = summaries.reduce((sum, pack) => sum + Math.max(0, Number(pack.count || 0) || 0), 0);
  const groups = [
    { id: 'all', name: '全部', count: totalCount },
    ...summaries.map((pack) => ({ id: pack.id, name: pack.name, count: pack.count })),
  ];
  let activeGroupId = summaries.find((pack) => Number(pack.count || 0) > 0)?.id || 'all';
  let stickers = [];
  let currentPage = 0;
  let currentQuery = '';
  const thumbSrcMap = new Map();
  const warmedStickerKeys = new Set();

  return new Promise((resolve) => {

    host.innerHTML = `
      <div class="modal-overlay" data-sticker-picker-overlay>
        <div class="modal-sheet scrapbook-card chat-sticker-picker-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>选择表情</h3>
            <button type="button" class="navbar-btn" data-sticker-close aria-label="关闭">${icon('close')}</button>
          </header>
          ${totalCount ? `
          <div class="modal-body chat-sticker-picker-body">
            ${renderGroupTabs(groups, activeGroupId)}
            <label class="chat-sticker-search">
              ${icon('search')}
              <input type="search" class="chat-sticker-search-input" data-sticker-search placeholder="搜索当前分组" />
            </label>
            <div class="chat-sticker-picker-results" data-sticker-results>
              <div class="chat-sticker-loading" aria-label="正在加载"></div>
            </div>
          </div>
          ` : `
          <div class="modal-body chat-sticker-picker-body">
            <p class="text-hint">还没有表情。可到「表情包」导入分组。</p>
          </div>`}
        </div>
      </div>
    `;

    const close = (result = null) => {
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(result);
    };

    host.querySelector('[data-sticker-picker-overlay]')?.addEventListener('click', (e) => {
      if (e.target.matches('[data-sticker-picker-overlay]')) close(null);
    });
    host.querySelector('[data-sticker-close]')?.addEventListener('click', () => close(null));
    host.querySelector('.chat-sticker-picker-sheet')?.addEventListener('click', (e) => e.stopPropagation());
    const body = host.querySelector('[data-sticker-results]');
    const filteredRows = () => {
      if (!currentQuery) return stickers;
      return stickers.filter((sticker) => (
        normalizeSearchText(`${sticker.name || ''} ${sticker.packName || ''}`).includes(currentQuery)
      ));
    };
    const warmRows = (rows) => {
      const pending = rows.filter((sticker) => {
        const key = `${String(sticker?.id || '')}\n${String(sticker?.url || '')}`;
        if (warmedStickerKeys.has(key)) return false;
        warmedStickerKeys.add(key);
        return true;
      });
      if (!pending.length) return;
      peekStickerThumbSrcMap(pending).then((cached) => {
        cached.forEach((src, id) => {
          thumbSrcMap.set(id, src);
          applyStickerThumbToImgs(host, id, src);
        });
      }).catch(() => {});
      ensureStickerThumbs(pending, {
        onReady: (id, src) => {
          thumbSrcMap.set(id, src);
          applyStickerThumbToImgs(host, id, src);
        },
      }).catch(() => {});
    };
    const paintRows = () => {
      const filtered = filteredRows();
      const page = stickerPickerPageRows(filtered, currentPage);
      const visible = page.rows;
      currentPage = page.page;
      if (body) {
        body.innerHTML = `${renderStickerButtons(visible, thumbSrcMap)}${page.pageCount > 1
          ? `<div class="chat-sticker-pager" aria-label="表情分页">
              <button type="button" class="btn btn-sm btn-soft" data-sticker-page="prev" ${page.page <= 0 ? 'disabled' : ''}>上一页</button>
              <span>${page.start + 1}–${Math.min(page.start + visible.length, page.total)} / ${page.total}</span>
              <button type="button" class="btn btn-sm btn-soft" data-sticker-page="next" ${page.page >= page.pageCount - 1 ? 'disabled' : ''}>下一页</button>
            </div>`
          : ''}`;
      }
      warmRows(visible);
    };
    const loadActiveGroup = async () => {
      if (body) body.innerHTML = '<div class="chat-sticker-loading" aria-label="正在加载"></div>';
      if (activeGroupId === 'all') {
        stickers = flattenStickerPacks(await listStickerPacks());
        stickerChoiceCache = { at: Date.now(), rows: stickers };
      } else {
        const pack = await getStickerPack(activeGroupId);
        stickers = pack ? flattenStickerPacks([pack]) : [];
      }
      currentPage = 0;
      paintRows();
    };

    body?.addEventListener('click', (event) => {
      const pageButton = event.target.closest('[data-sticker-page]');
      if (pageButton) {
        currentPage += pageButton.getAttribute('data-sticker-page') === 'prev' ? -1 : 1;
        paintRows();
        body.scrollIntoView({ block: 'nearest' });
        return;
      }
      const button = event.target.closest('.chat-sticker-pick');
      if (!button) return;
      const picked = stickers[Number(button.getAttribute('data-idx'))];
      if (!picked) return;
      const result = {
        id: picked.id,
        name: picked.name,
        url: picked.url,
        packId: picked.packId,
        packName: picked.packName,
      };
      onPick?.(result);
      close(result);
    });

    host.querySelector('[data-sticker-search]')?.addEventListener('input', (e) => {
      currentQuery = normalizeSearchText(e.target.value);
      currentPage = 0;
      paintRows();
    });

    host.querySelector('[data-sticker-tabs]')?.addEventListener('click', async (e) => {
      const tabBtn = e.target.closest('.chat-sticker-tab');
      if (!tabBtn) return;
      activeGroupId = tabBtn.getAttribute('data-group-id') || 'all';
      host.querySelectorAll('.chat-sticker-tab').forEach((btn) => {
        btn.classList.toggle('active', btn === tabBtn);
      });
      currentQuery = '';
      const search = host.querySelector('[data-sticker-search]');
      if (search) search.value = '';
      await loadActiveGroup().catch(() => {
        if (body) body.innerHTML = '<p class="text-hint chat-sticker-empty">表情加载失败</p>';
      });
    });

    void loadActiveGroup().catch(() => {
      if (body) body.innerHTML = '<p class="text-hint chat-sticker-empty">表情加载失败</p>';
    });
  });
}
