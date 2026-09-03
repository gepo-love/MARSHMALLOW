import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import {
  getCharacter,
  listCharacters,
  saveCharacterForUser,
} from '../core/character-store.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  listStickerPacks,
  saveStickerPack,
  deleteStickerPack,
  createStickerPack,
  getCollapsedPackIds,
  saveCollapsedPackIds,
  filterImportableStickerLines,
  sanitizeStickerDisplayName,
  normalizeStickerItemName,
  normalizeBoundStickerPackIdsFromRow,
  newStickerItemId,
  upgradeStickerImageUrl,
} from '../core/sticker-store.js';
import { invalidateStickerPacksCache } from '../core/chat/sticker-resolve.js';
import {
  peekStickerThumbSrcMap,
  ensureStickerThumbs,
  deleteStickerThumbs,
  pruneStickerThumbs,
  applyStickerThumbToImgs,
  stickerDomDisplayFallback,
} from '../core/sticker-thumb-cache.js';
import { bindCommitSearch } from '../components/search-field.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function defaultStickerNameFromFile(file) {
  const base = String(file?.name || '').replace(/\.[^.]+$/, '').trim();
  return sanitizeStickerDisplayName(base) || '表情';
}

function renderUploadNamingRows(drafts = []) {
  return `<div class="stk-upload-list">${drafts.map((row, i) => `
    <div class="stk-upload-row" data-upload-idx="${i}">
      <div class="stk-upload-thumb"><img src="${esc(row.url)}" alt="" decoding="async" /></div>
      <label class="stk-upload-field">
        <span class="stk-upload-label">名称</span>
        <input type="text" class="form-input stk-upload-name" maxlength="48" value="${esc(row.name)}" placeholder="例如：无语" />
      </label>
    </div>
  `).join('')}</div>`;
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function buildStickerImportToast({ added = 0, failed = [], invalidLines = 0 } = {}) {
  const parts = [];
  if (added > 0) parts.push(`已导入 ${added} 个`);
  if (failed.length) {
    const names = failed.slice(0, 3).map((f) => f.name || '表情').join('、');
    const suffix = failed.length > 3 ? ` 等 ${failed.length} 个` : '';
    parts.push(`${failed.length} 个 URL 无法加载：${names}${suffix}`);
  }
  if (invalidLines > 0) parts.push(`${invalidLines} 行格式无效`);
  if (!parts.length) return '没有有效行';
  return parts.join('；');
}

/** 文档/粘贴文本 → 导入行：保留「名称：URL」，同行多链拆开 */
function extractStickerImportLinesFromText(text = '') {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const urls = trimmed.match(/https?:\/\/[^\s<>"']+/gi);
    if (urls && urls.length > 1) {
      const prefix = trimmed.slice(0, trimmed.indexOf(urls[0])).replace(/[：:\s]+$/u, '').trim();
      urls.forEach((url, i) => {
        const clean = url.replace(/[)\].,;，。]+$/g, '');
        out.push(i === 0 && prefix ? `${prefix}：${clean}` : clean);
      });
      continue;
    }
    out.push(trimmed);
  }
  return out;
}

async function readStickerImportDocumentText(file) {
  if (!file) throw new Error('未选择文件');
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  if (/\.(txt|md|csv|log)$/i.test(name) || type === 'text/plain' || type === 'text/markdown' || type === 'text/csv') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取文档失败'));
      reader.readAsText(file, 'UTF-8');
    });
  }
  const build = (typeof window !== 'undefined' && window.__MARSHMALLOW_BUILD__)
    ? String(window.__MARSHMALLOW_BUILD__)
    : '';
  const { readCharacterDocumentFile } = await import(`../core/character-document-read.js?v=${encodeURIComponent(build)}`);
  return readCharacterDocumentFile(file);
}

function stickerThumbOnErrorAttr() {
  return "var fb=this.getAttribute('data-stk-fallback');if(fb&&this.getAttribute('src')!==fb){this.setAttribute('src',fb);return;}this.classList.add('is-broken');this.nextElementSibling&&(this.nextElementSibling.hidden=false)";
}

function renderStickerCell(sticker, manageMode, selected, displaySrc = '') {
  const name = sanitizeStickerDisplayName(sticker.name);
  const url = upgradeStickerImageUrl(String(sticker.url || '').trim());
  const fallback = stickerDomDisplayFallback(url);
  const src = upgradeStickerImageUrl(String(displaySrc || fallback).trim() || fallback);
  const srcAttr = src ? ` src="${esc(src)}"` : '';
  const fallbackAttr = fallback ? ` data-stk-fallback="${esc(fallback)}"` : '';
  return `
    <div class="stk-cell ${selected ? 'is-selected' : ''}" data-sid="${esc(sticker.id)}">
      <div class="stk-thumb">
        <img${srcAttr} alt="${esc(name)}" data-stk-id="${esc(sticker.id)}"${fallbackAttr} loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="${stickerThumbOnErrorAttr()}" />
        <span class="stk-thumb-broken" hidden>未加载</span>
        ${manageMode ? `<span class="stk-check">${selected ? '✓' : ''}</span>` : ''}
      </div>
      <div class="stk-caption">${esc(name)}</div>
    </div>
  `;
}

function buildBoundCountMap(characters = [], packs = []) {
  const validPackIds = new Set((packs || []).map((p) => String(p.id || '')).filter(Boolean));
  const map = new Map();
  for (const c of characters || []) {
    for (const id of normalizeBoundStickerPackIdsFromRow(c)) {
      if (!validPackIds.has(id)) continue;
      map.set(id, (map.get(id) || 0) + 1);
    }
  }
  return map;
}

function sortCharactersForBind(chars = [], packId = '') {
  return [...chars].sort((a, b) => {
    const aBound = normalizeBoundStickerPackIdsFromRow(a).includes(packId);
    const bBound = normalizeBoundStickerPackIdsFromRow(b).includes(packId);
    if (aBound !== bBound) return aBound ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });
}

function renderBindListHtml(chars = [], packId = '') {
  const sorted = sortCharactersForBind(chars, packId);
  const boundCount = sorted.filter((c) => normalizeBoundStickerPackIdsFromRow(c).includes(packId)).length;
  const rows = sorted.map((c) => {
    const checked = normalizeBoundStickerPackIdsFromRow(c).includes(packId);
    return `
      <label class="stk-bind-row ${checked ? 'is-bound' : ''}">
        <input type="checkbox" data-char-id="${esc(c.id)}" ${checked ? 'checked' : ''} />
        <span>${esc(c.name || c.id)}</span>
      </label>
    `;
  }).join('');
  return {
    boundCount,
    html: `
      <p class="wb-hint">勾选角色可使用该分组；未勾选不注入。</p>
      <p class="stk-bind-summary" data-bind-summary>已绑 ${boundCount} 人</p>
      <div class="stk-bind-list">
        ${rows || '<div class="wb-empty-inline">请先在通讯录添加角色</div>'}
      </div>
    `,
  };
}

function updateBindSummary(root) {
  const list = root?.querySelector('.stk-bind-list');
  const summary = root?.querySelector('[data-bind-summary]');
  if (!list || !summary) return;
  const boxes = list.querySelectorAll('input[data-char-id]');
  let n = 0;
  boxes.forEach((box) => {
    const row = box.closest('.stk-bind-row');
    if (box.checked) {
      n += 1;
      row?.classList.add('is-bound');
    } else {
      row?.classList.remove('is-bound');
    }
  });
  summary.textContent = `已绑 ${n} 人`;
}

function getVisiblePackRows(packs, query) {
  const q = normalizeSearchText(query);
  if (!q) return (packs || []).map((pack) => ({ pack, stickers: pack.stickers || [] }));
  return (packs || [])
    .map((pack) => {
      const all = pack.stickers || [];
      const packName = normalizeSearchText(pack.name);
      const packMatched = packName.includes(q);
      const stickers = packMatched
        ? all
        : all.filter((s) => normalizeSearchText(`${s.name || ''} ${pack.name || ''}`).includes(q));
      return stickers.length ? { pack, stickers } : null;
    })
    .filter(Boolean);
}

export const STICKER_MANAGEMENT_RENDER_BATCH = 120;

export function stickerRowsForManagement(stickers = [], { collapsed = false, limit = STICKER_MANAGEMENT_RENDER_BATCH } = {}) {
  if (collapsed) return [];
  const rows = Array.isArray(stickers) ? stickers : [];
  const safeLimit = Math.max(1, Number(limit) || STICKER_MANAGEMENT_RENDER_BATCH);
  return rows.slice(0, safeLimit);
}

function renderPackSection(pack, collapsedSet, manageMode, selectedSet, boundCountMap, visibleStickers = null, searchActive = false, thumbSrcMap = null, renderLimit = STICKER_MANAGEMENT_RENDER_BATCH) {
  const collapsed = !searchActive && collapsedSet.has(pack.id);
  const allStickers = pack.stickers || [];
  const stickers = visibleStickers || allStickers;
  const renderedStickers = stickerRowsForManagement(stickers, { collapsed, limit: renderLimit });
  const boundCount = boundCountMap?.get(pack.id) || 0;
  const countText = searchActive && stickers.length !== allStickers.length
    ? `${stickers.length}/${allStickers.length} 个`
    : `${allStickers.length} 个`;
  const emptyPack = allStickers.length === 0;
  return `
    <section class="stk-pack scrapbook-card" data-pack-id="${esc(pack.id)}">
      <div class="stk-pack-head">
        <button type="button" class="stk-pack-toggle" data-collapse-pack="${esc(pack.id)}" aria-expanded="${collapsed ? 'false' : 'true'}">
          <span class="stk-chevron ${collapsed ? 'is-collapsed' : ''}">${icon('chevron')}</span>
          <span class="stk-pack-name">${esc(pack.name || '未命名')}</span>
          <span class="stk-pack-count">${esc(countText)}</span>
        </button>
        <div class="stk-pack-head-actions">
          <button type="button" class="btn btn-sm btn-soft stk-pack-bind" data-bind-pack="${esc(pack.id)}" title="角色绑定">${boundCount ? `已绑 ${boundCount}` : '绑定'}</button>
          <button type="button" class="btn btn-sm btn-soft" data-rename-pack="${esc(pack.id)}">改名</button>
          ${emptyPack || manageMode
    ? `<button type="button" class="btn btn-sm ${emptyPack ? 'is-danger' : 'btn-soft'}" data-delete-pack="${esc(pack.id)}" title="${emptyPack ? '删除空分组' : '删除分组'}">${emptyPack ? '删除' : '删组'}</button>`
    : ''}
        </div>
      </div>
      <div class="stk-pack-body" ${collapsed ? 'hidden' : ''}>
        ${renderedStickers.length
    ? `<div class="stk-grid">${renderedStickers.map((s) => renderStickerCell(s, manageMode, selectedSet.has(s.id), thumbSrcMap?.get(s.id) || '')).join('')}</div>`
    : `<div class="wb-empty-inline">还没有表情，可 URL 导入、文档导入或上传图片</div>`}
        <div class="stk-pack-actions">
          ${renderedStickers.length < stickers.length ? `<button type="button" class="btn btn-sm btn-soft" data-load-more-stickers="${esc(pack.id)}">继续显示（${renderedStickers.length}/${stickers.length}）</button>` : ''}
          <button type="button" class="btn btn-sm btn-soft" data-url-import="${esc(pack.id)}">URL 导入</button>
          <button type="button" class="btn btn-sm btn-soft" data-doc-import="${esc(pack.id)}">文档导入</button>
          <button type="button" class="btn btn-sm btn-soft" data-upload="${esc(pack.id)}">上传图片</button>
        </div>
      </div>
    </section>
  `;
}

export default async function render(container) {
  const user = await ensureDefaultUser();
  let packs = await listStickerPacks();
  let characters = await listCharacters({ excludeAnonNpc: true, userId: user.id });
  let collapsedSet = await getCollapsedPackIds();
  let manageMode = false;
  let selectedSet = new Set();
  let activePackId = packs[0]?.id || '';
  let sheetMode = null;
  let searchQuery = '';
  const visibleStickerLimits = new Map();
  let collapseSaveChain = Promise.resolve();

  function findStickerById(stickerId = '') {
    const sid = String(stickerId || '').trim();
    if (!sid) return { pack: null, sticker: null };
    for (const pack of packs) {
      const sticker = (pack.stickers || []).find((item) => item.id === sid);
      if (sticker) return { pack, sticker };
    }
    return { pack: null, sticker: null };
  }

  container.className = 'page scrapbook-page stickers-page';

  async function reload() {
    packs = await listStickerPacks();
    characters = await listCharacters({ excludeAnonNpc: true, userId: user.id });
    if (activePackId && !packs.find((p) => p.id === activePackId)) {
      activePackId = packs[0]?.id || '';
    }
    const allIds = [];
    for (const pack of packs) {
      for (const s of pack.stickers || []) {
        if (s?.id) allIds.push(s.id);
      }
    }
    pruneStickerThumbs(allIds).catch(() => {});
    await paint();
  }

  function currentPack(id = activePackId) {
    return packs.find((p) => p.id === id) || null;
  }

  function warmVisibleThumbs(stickers = []) {
    ensureStickerThumbs(stickers, {
      onReady: (id, src) => applyStickerThumbToImgs(container, id, src),
    }).catch(() => {});
  }

  async function paint() {
    const prevScroller = container.querySelector('.stk-scroll');
    const prevScrollTop = prevScroller ? prevScroller.scrollTop : 0;
    const boundCountMap = buildBoundCountMap(characters, packs);
    const visiblePackRows = getVisiblePackRows(packs, searchQuery);
    const searchActive = !!normalizeSearchText(searchQuery);
    const renderedPackRows = visiblePackRows.map(({ pack, stickers }) => {
      const renderLimit = visibleStickerLimits.get(pack.id) || STICKER_MANAGEMENT_RENDER_BATCH;
      const collapsed = !searchActive && collapsedSet.has(pack.id);
      return {
        pack,
        stickers,
        renderLimit,
        renderedStickers: stickerRowsForManagement(stickers, { collapsed, limit: renderLimit }),
      };
    });
    const visibleStickers = renderedPackRows.flatMap(({ renderedStickers }) => renderedStickers);
    const visibleIds = visibleStickers.map((s) => s.id).filter(Boolean);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
    const selectAllLabel = allVisibleSelected ? '取消全选' : '全选';
    const thumbSrcMap = await peekStickerThumbSrcMap(visibleStickers).catch(() => new Map());
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">表情包</h1>
        <div class="wb-navbar-actions">
          <button type="button" class="navbar-btn" data-new-pack aria-label="新建">${icon('plus')}</button>
        </div>
      </header>
      <main class="stk-scroll scrapbook-scroll">
        <p class="wb-hint scrapbook-hint">未绑定角色不会注入表情包；点分组右侧绑定。</p>
        ${packs.length ? `
          <label class="stk-search">
            <button type="button" class="stk-search-submit" data-search-submit aria-label="搜索">${icon('search')}</button>
            <input type="search" class="stk-search-input" data-sticker-search placeholder="搜索表情或分组，回车搜索" value="${esc(searchQuery)}" enterkeyhint="search" />
          </label>
        ` : ''}
        ${packs.length
    ? (visiblePackRows.length
      ? renderedPackRows.map(({ pack, stickers, renderLimit }) => renderPackSection(pack, collapsedSet, manageMode, selectedSet, boundCountMap, stickers, searchActive, thumbSrcMap, renderLimit)).join('')
      : '<div class="wb-empty-inline">没有匹配的表情</div>')
    : `
          <div class="chat-empty scrapbook-empty">
            ${emptyIllustration('sticker')}
            <div class="chat-empty-text">还没有表情包分组</div>
            <button type="button" class="btn btn-primary" data-new-pack>新建分组</button>
          </div>
        `}
      </main>
      ${packs.length ? `
      <footer class="stk-footer">
        <button type="button" class="btn btn-sm btn-soft" data-toggle-manage>${manageMode ? '完成' : '管理'}</button>
        ${manageMode ? `
          <button type="button" class="btn btn-sm btn-soft" data-select-all>${esc(selectAllLabel)}</button>
        ` : ''}
        ${manageMode && selectedSet.size ? `
          <button type="button" class="btn btn-sm btn-soft" data-move-selected>移动(${selectedSet.size})</button>
          ${selectedSet.size === 1 ? `<button type="button" class="btn btn-sm btn-soft" data-rename-selected>重命名</button>` : ''}
          <button type="button" class="btn btn-sm is-danger" data-delete-selected>删除(${selectedSet.size})</button>
        ` : ''}
      </footer>
      ` : ''}
      <input type="file" class="stk-file-input" accept=".jpg,.jpeg,.png,.gif,.webp" multiple hidden />
      <input type="file" class="stk-doc-input" accept=".txt,.md,.csv,.log,.docx,text/plain,text/markdown,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden />
      <aside class="wb-sheet stk-sheet ${sheetMode ? 'is-open' : ''}">
        <div class="wb-sheet-backdrop" data-close-sheet></div>
        <div class="wb-sheet-panel scrapbook-card" data-sheet-panel></div>
      </aside>
    `;
    bindEvents();
    if (prevScrollTop) {
      const nextScroller = container.querySelector('.stk-scroll');
      if (nextScroller) nextScroller.scrollTop = prevScrollTop;
    }
    warmVisibleThumbs(visibleStickers);
  }

  function openSheet(title, bodyHtml, footHtml = '') {
    sheetMode = title;
    const panel = container.querySelector('[data-sheet-panel]');
    if (!panel) return;
    container.querySelector('.stk-sheet')?.classList.add('is-open');
    panel.innerHTML = `
      <header class="wb-sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="navbar-btn" data-close-sheet aria-label="关闭">${icon('close')}</button>
      </header>
      <div class="wb-sheet-body">${bodyHtml}</div>
      ${footHtml ? `<footer class="wb-sheet-foot">${footHtml}</footer>` : ''}
    `;
    panel.querySelector('[data-close-sheet]')?.addEventListener('click', closeSheet);
    container.querySelector('.wb-sheet-backdrop')?.addEventListener('click', closeSheet);
  }

  function closeSheet() {
    sheetMode = null;
    container.querySelector('.stk-sheet')?.classList.remove('is-open');
  }

  async function importUrlLinesIntoPack(pack, lines, confirmBtn) {
    if (!pack || !confirmBtn) return;
    const prevLabel = confirmBtn.textContent;
    confirmBtn.disabled = true;
    confirmBtn.textContent = '校验中…';
    try {
      const { importable, failed, invalidLines } = await filterImportableStickerLines(lines, {
        onProgress: ({ completed, total }) => {
          confirmBtn.textContent = `校验 ${completed}/${total}`;
        },
      });
      const added = [];
      for (let i = 0; i < importable.length; i += 1) {
        const row = importable[i];
        const item = { id: newStickerItemId(Date.now() + i), ...row };
        pack.stickers.push(item);
        added.push(item);
      }
      if (added.length) {
        await saveStickerPack(pack);
        invalidateStickerPacksCache();
      }
      closeSheet();
      await reload();
      showToast(buildStickerImportToast({
        added: added.length,
        failed,
        invalidLines,
      }), failed.length ? 4500 : 2800);
    } catch (err) {
      showToast(String(err?.message || err || '导入失败'), 3500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = prevLabel;
    }
  }

  function openUploadNamingSheet(drafts = [], pack) {
    if (!pack || !drafts.length) return;
    const countLabel = drafts.length > 1 ? `（${drafts.length} 张）` : '';
    openSheet(`命名并上传${countLabel}`, `
      <p class="wb-hint">确认名称后入库；聊天会按名称匹配。</p>
      ${renderUploadNamingRows(drafts)}
    `, `<button type="button" class="btn btn-primary" data-confirm-upload>上传</button>`);
    const firstInput = container.querySelector('.stk-upload-name');
    firstInput?.focus();
    firstInput?.select?.();
    container.querySelector('[data-confirm-upload]')?.addEventListener('click', async () => {
      const confirmBtn = container.querySelector('[data-confirm-upload]');
      const rows = container.querySelectorAll('.stk-upload-row');
      const nextStickers = [];
      try {
        for (const row of rows) {
          const idx = Number(row.getAttribute('data-upload-idx'));
          const draft = drafts[idx];
          if (!draft?.url) continue;
          const input = row.querySelector('.stk-upload-name');
          const name = normalizeStickerItemName(input?.value || draft.name);
          nextStickers.push({
            id: newStickerItemId(Date.now() + nextStickers.length),
            name,
            url: draft.url,
          });
        }
      } catch (err) {
        showToast(String(err?.message || err));
        return;
      }
      if (!nextStickers.length) {
        showToast('没有可上传的表情');
        return;
      }
      const prevLabel = confirmBtn?.textContent;
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '上传中…';
      }
      try {
        for (const sticker of nextStickers) pack.stickers.push(sticker);
        await saveStickerPack(pack);
        invalidateStickerPacksCache();
        ensureStickerThumbs(nextStickers).catch(() => {});
        sheetMode = null;
        container.querySelector('.stk-sheet')?.classList.remove('is-open');
        await reload();
        showToast(`已上传 ${nextStickers.length} 个`);
      } catch (err) {
        showToast(String(err?.message || err || '上传失败'), 3500);
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = prevLabel || '上传';
        }
      }
    });
  }

  function bindEvents() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    const searchInput = container.querySelector('[data-sticker-search]');
    // 回车/清空才重绘：打字时重建整页 + focus/setSelectionRange 会打断 iOS 中文输入法
    bindCommitSearch({
      input: searchInput,
      trigger: container.querySelector('[data-search-submit]'),
      onCommit: (value) => {
        const next = String(value || '');
        if (next === searchQuery) return;
        searchQuery = next;
        void paint();
      },
    });
    container.querySelectorAll('[data-new-pack]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openSheet('新建分组', `
          <label class="wb-field">
            <span>分组名称</span>
            <input type="text" class="form-input stk-new-name" placeholder="例如：常用" maxlength="32" />
          </label>
        `, `<button type="button" class="btn btn-primary" data-confirm-new-pack>创建</button>`);
        container.querySelector('[data-confirm-new-pack]')?.addEventListener('click', async () => {
          const name = String(container.querySelector('.stk-new-name')?.value || '').trim() || '新分组';
          const pack = createStickerPack({ name });
          await saveStickerPack(pack);
          collapsedSet.delete(pack.id);
          activePackId = pack.id;
          closeSheet();
          await reload();
          showToast('分组已创建');
        });
      });
    });

    container.querySelectorAll('[data-collapse-pack]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = String(btn.getAttribute('data-collapse-pack') || '').trim();
        if (!id) return;
        const collapsing = !collapsedSet.has(id);
        if (collapsing) collapsedSet.add(id);
        else collapsedSet.delete(id);

        btn.setAttribute('aria-expanded', String(!collapsing));
        btn.querySelector('.stk-chevron')?.classList.toggle('is-collapsed', collapsing);
        const body = btn.closest('[data-pack-id]')?.querySelector('.stk-pack-body');
        if (body) body.hidden = collapsing;

        const snapshot = [...collapsedSet];
        collapseSaveChain = collapseSaveChain
          .then(() => saveCollapsedPackIds(snapshot))
          .catch(() => showToast('分组收起状态保存失败', 2500));

        if (collapsing) {
          // 先即时收起，再在下一帧释放图片节点；不等待 IndexedDB，也不重绘整页。
          requestAnimationFrame(() => {
            if (body?.isConnected && collapsedSet.has(id)) body.replaceChildren();
          });
        } else {
          void paint();
        }
      });
    });

    container.querySelectorAll('[data-load-more-stickers]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const packId = String(btn.getAttribute('data-load-more-stickers') || '').trim();
        if (!packId) return;
        const current = visibleStickerLimits.get(packId) || STICKER_MANAGEMENT_RENDER_BATCH;
        visibleStickerLimits.set(packId, current + STICKER_MANAGEMENT_RENDER_BATCH);
        void paint();
      });
    });

    container.querySelectorAll('[data-rename-pack]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pack = currentPack(btn.getAttribute('data-rename-pack'));
        if (!pack) return;
        const currentName = String(pack.name || '').trim() || '未命名';
        openSheet('重命名分组', `
          <label class="wb-field">
            <span>分组名称</span>
            <input type="text" class="form-input stk-rename-pack-input" maxlength="32" value="${esc(currentName)}" />
          </label>
        `, `<button type="button" class="btn btn-primary" data-confirm-rename-pack>保存</button>`);
        const input = container.querySelector('.stk-rename-pack-input');
        input?.focus();
        input?.select?.();
        container.querySelector('[data-confirm-rename-pack]')?.addEventListener('click', async () => {
          const nextName = String(container.querySelector('.stk-rename-pack-input')?.value || '').trim();
          if (!nextName) {
            showToast('请输入分组名称');
            return;
          }
          if (nextName === currentName) {
            closeSheet();
            return;
          }
          pack.name = nextName.slice(0, 32);
          await saveStickerPack(pack);
          invalidateStickerPacksCache();
          closeSheet();
          await reload();
          showToast('分组已改名');
        });
      });
    });

    container.querySelectorAll('[data-delete-pack]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pack = currentPack(btn.getAttribute('data-delete-pack'));
        if (!pack) return;
        const count = (pack.stickers || []).length;
        const doDelete = async () => {
          const removedIds = (pack.stickers || []).map((s) => s.id).filter(Boolean);
          await deleteStickerPack(pack.id);
          if (removedIds.length) await deleteStickerThumbs(removedIds);
          collapsedSet.delete(pack.id);
          if (activePackId === pack.id) activePackId = '';
          selectedSet.clear();
          invalidateStickerPacksCache();
          sheetMode = null;
          container.querySelector('.stk-sheet')?.classList.remove('is-open');
          await reload();
          showToast(count ? `已删除分组及 ${count} 个表情` : '已删除空分组');
        };
        if (!count) {
          void doDelete();
          return;
        }
        openSheet('删除分组', `
          <p class="wb-hint">将删除「${esc(pack.name || '未命名')}」及其中的 ${count} 个表情，此操作不可恢复。</p>
        `, `<button type="button" class="btn is-danger" data-confirm-delete-pack>删除分组</button>`);
        container.querySelector('[data-confirm-delete-pack]')?.addEventListener('click', () => {
          void doDelete();
        });
      });
    });

    container.querySelectorAll('[data-url-import]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activePackId = btn.getAttribute('data-url-import') || activePackId;
        openSheet('批量 URL 导入', `
          <p class="wb-hint">每行：表情名 + 冒号 + URL；也支持单独一行 URL。导入前会校验图片能否加载，非直链或图床拦截的地址将跳过。</p>
          <textarea class="form-input stk-url-ta" rows="10" placeholder="我真没招了：https://…"></textarea>
        `, `<button type="button" class="btn btn-primary" data-confirm-url-import>导入</button>`);
        container.querySelector('[data-confirm-url-import]')?.addEventListener('click', async () => {
          const pack = currentPack();
          const confirmBtn = container.querySelector('[data-confirm-url-import]');
          if (!pack || !confirmBtn) return;
          const raw = String(container.querySelector('.stk-url-ta')?.value || '');
          const lines = extractStickerImportLinesFromText(raw);
          if (!lines.length) {
            showToast('请输入至少一行');
            return;
          }
          await importUrlLinesIntoPack(pack, lines, confirmBtn);
        });
      });
    });

    const docInput = container.querySelector('.stk-doc-input');
    container.querySelectorAll('[data-doc-import]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activePackId = btn.getAttribute('data-doc-import') || activePackId;
        if (docInput) docInput.value = '';
        docInput?.click();
      });
    });
    docInput?.addEventListener('change', async () => {
      const pack = currentPack();
      const file = docInput.files?.[0];
      docInput.value = '';
      if (!pack || !file) return;
      try {
        showToast('正在读取文档…', 1500);
        const text = await readStickerImportDocumentText(file);
        const lines = extractStickerImportLinesFromText(text);
        if (!lines.length) {
          showToast('文档里没有可用的 URL');
          return;
        }
        openSheet('文档导入预览', `
          <p class="wb-hint">已从「${esc(file.name)}」解析出 ${lines.length} 行，确认后校验并导入。</p>
          <textarea class="form-input stk-url-ta" rows="10">${esc(lines.join('\n'))}</textarea>
        `, `<button type="button" class="btn btn-primary" data-confirm-doc-import>导入</button>`);
        container.querySelector('[data-confirm-doc-import]')?.addEventListener('click', async () => {
          const confirmBtn = container.querySelector('[data-confirm-doc-import]');
          const edited = extractStickerImportLinesFromText(String(container.querySelector('.stk-url-ta')?.value || ''));
          if (!edited.length) {
            showToast('请保留至少一行 URL');
            return;
          }
          await importUrlLinesIntoPack(pack, edited, confirmBtn);
        });
      } catch (err) {
        showToast(String(err?.message || err || '文档读取失败'), 3500);
      }
    });

    const fileInput = container.querySelector('.stk-file-input');
    container.querySelectorAll('[data-upload]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activePackId = btn.getAttribute('data-upload') || activePackId;
        fileInput?.click();
      });
    });
    fileInput?.addEventListener('change', async () => {
      const pack = currentPack();
      const files = fileInput.files ? [...fileInput.files] : [];
      fileInput.value = '';
      if (!pack || !files.length) return;
      const drafts = [];
      for (const file of files) {
        try {
          const url = await fileToDataUrl(file);
          drafts.push({
            url,
            name: defaultStickerNameFromFile(file),
          });
        } catch (_) {}
      }
      if (!drafts.length) {
        showToast('图片读取失败');
        return;
      }
      openUploadNamingSheet(drafts, pack);
    });

    container.querySelectorAll('.stk-cell').forEach((cell) => {
      cell.addEventListener('click', async () => {
        const sid = cell.getAttribute('data-sid');
        const packEl = cell.closest('[data-pack-id]');
        const pack = currentPack(packEl?.getAttribute('data-pack-id'));
        const sticker = pack?.stickers?.find((s) => s.id === sid);
        if (!sticker) return;
        if (manageMode) {
          if (selectedSet.has(sid)) selectedSet.delete(sid);
          else selectedSet.add(sid);
          void paint();
          return;
        }
        try {
          await navigator.clipboard.writeText(sticker.url);
          showToast('图片 URL 已复制');
        } catch (_) {
          showToast('复制失败', 2500);
        }
      });
    });

    container.querySelector('[data-toggle-manage]')?.addEventListener('click', () => {
      manageMode = !manageMode;
      if (!manageMode) selectedSet.clear();
      void paint();
    });

    container.querySelector('[data-select-all]')?.addEventListener('click', () => {
      const rows = getVisiblePackRows(packs, searchQuery);
      const ids = rows.flatMap(({ stickers }) => (stickers || []).map((s) => s.id).filter(Boolean));
      if (!ids.length) {
        showToast('当前没有可全选的表情');
        return;
      }
      const allSelected = ids.every((id) => selectedSet.has(id));
      if (allSelected) {
        ids.forEach((id) => selectedSet.delete(id));
      } else {
        ids.forEach((id) => selectedSet.add(id));
      }
      void paint();
    });

    container.querySelector('[data-delete-selected]')?.addEventListener('click', async () => {
      if (!selectedSet.size) return;
      const removedIds = [...selectedSet];
      for (const pack of packs) {
        const before = pack.stickers.length;
        pack.stickers = pack.stickers.filter((s) => !selectedSet.has(s.id));
        if (pack.stickers.length !== before) await saveStickerPack(pack);
      }
      selectedSet.clear();
      manageMode = false;
      await deleteStickerThumbs(removedIds);
      invalidateStickerPacksCache();
      await reload();
      showToast('已删除选中表情');
    });

    container.querySelector('[data-rename-selected]')?.addEventListener('click', () => {
      const sid = [...selectedSet][0];
      const { pack, sticker } = findStickerById(sid);
      if (!pack || !sticker) return;
      const currentName = sanitizeStickerDisplayName(sticker.name);
      openSheet('重命名表情', `
        <label class="wb-field">
          <span>表情名称</span>
          <input type="text" class="form-input stk-rename-input" maxlength="48" value="${esc(currentName)}" />
        </label>
        <p class="wb-hint">角色发 [表情包:名称] 时需与这里一致。改名后聊天记录里已写入的旧名称不会自动更新。</p>
      `, `<button type="button" class="btn btn-primary" data-confirm-rename>保存</button>`);
      container.querySelector('[data-confirm-rename]')?.addEventListener('click', async () => {
        try {
          const nextName = normalizeStickerItemName(container.querySelector('.stk-rename-input')?.value);
          if (nextName === currentName) {
            closeSheet();
            return;
          }
          sticker.name = nextName;
          await saveStickerPack(pack);
          invalidateStickerPacksCache();
          selectedSet.clear();
          manageMode = false;
          closeSheet();
          await reload();
          showToast('已重命名');
        } catch (err) {
          showToast(String(err?.message || err));
        }
      });
    });

    container.querySelector('[data-move-selected]')?.addEventListener('click', () => {
      const others = packs.filter((p) => (p.stickers || []).some((s) => selectedSet.has(s.id)));
      if (!others.length) return;
      const fromPack = others[0];
      openSheet('移动到分组', `
        <label class="wb-field">
          <span>目标分组</span>
          <select class="form-input stk-move-target">
            ${packs.filter((p) => p.id !== fromPack.id).map((p) => `
              <option value="${esc(p.id)}">${esc(p.name)}（${(p.stickers || []).length}）</option>
            `).join('')}
          </select>
        </label>
      `, `<button type="button" class="btn btn-primary" data-confirm-move>移动</button>`);
      container.querySelector('[data-confirm-move]')?.addEventListener('click', async () => {
        const targetId = container.querySelector('.stk-move-target')?.value;
        const target = currentPack(targetId);
        if (!target) return;
        let moved = 0;
        const removedIds = [];
        const created = [];
        for (const pack of packs) {
          const moving = pack.stickers.filter((s) => selectedSet.has(s.id));
          if (!moving.length) continue;
          pack.stickers = pack.stickers.filter((s) => !selectedSet.has(s.id));
          for (const s of moving) {
            removedIds.push(s.id);
            const next = { ...s, id: newStickerItemId(Date.now() + moved) };
            target.stickers.push(next);
            created.push(next);
            moved += 1;
          }
          await saveStickerPack(pack);
        }
        await saveStickerPack(target);
        await deleteStickerThumbs(removedIds);
        ensureStickerThumbs(created).catch(() => {});
        selectedSet.clear();
        manageMode = false;
        closeSheet();
        await reload();
        showToast(moved ? `已移动 ${moved} 个` : '未移动');
      });
    });

    container.querySelectorAll('[data-bind-pack]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const packId = btn.getAttribute('data-bind-pack');
        const pack = currentPack(packId);
        if (!pack) return;
        characters = await listCharacters({ excludeAnonNpc: true, userId: user.id });
        const { html: bindBody } = renderBindListHtml(characters, packId);
        openSheet(`绑定 · ${pack.name}`, bindBody, `<button type="button" class="btn btn-primary" data-confirm-bind>保存</button>`);
        const panel = container.querySelector('[data-sheet-panel]');
        panel?.querySelectorAll('.stk-bind-list input[data-char-id]').forEach((box) => {
          box.addEventListener('change', () => updateBindSummary(panel));
        });
        container.querySelector('[data-confirm-bind]')?.addEventListener('click', async () => {
          const saveBtn = container.querySelector('[data-confirm-bind]');
          const boxes = container.querySelectorAll('.stk-bind-list input[data-char-id]');
          const originalById = new Map(characters.map((character) => [
            String(character.id || ''),
            normalizeBoundStickerPackIdsFromRow(character).includes(packId),
          ]));
          const changes = [...boxes].filter((box) => {
            const charId = String(box.getAttribute('data-char-id') || '');
            return charId && box.checked !== originalById.get(charId);
          });
          if (!changes.length) {
            closeSheet();
            return;
          }
          const previousLabel = saveBtn?.textContent || '保存';
          if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = '保存中…';
          }
          try {
            for (const box of changes) {
              const charId = String(box.getAttribute('data-char-id') || '');
              const row = await getCharacter(charId, { userId: user.id });
              if (!row) continue;
              let ids = normalizeBoundStickerPackIdsFromRow(row);
              if (box.checked) {
                if (!ids.includes(packId)) ids.push(packId);
              } else {
                ids = ids.filter((x) => x !== packId);
              }
              const next = { ...row, id: charId };
              delete next.boundStickerPackId;
              if (ids.length) next.boundStickerPackIds = ids;
              else delete next.boundStickerPackIds;
              await saveCharacterForUser(user.id, next, { forceOverride: true });
            }
            characters = await listCharacters({ excludeAnonNpc: true, userId: user.id });
            closeSheet();
            showToast('绑定已保存');
            // 保存结果与页面刷新分离，避免刷新缩略图偶发失败时误报“绑定保存失败”。
            void paint().catch((error) => {
              console.warn('[stickers] binding saved but repaint failed', error);
            });
          } catch (error) {
            showToast(String(error?.message || error || '绑定保存失败'), 3500);
            if (saveBtn) {
              saveBtn.disabled = false;
              saveBtn.textContent = previousLabel;
            }
          }
        });
      });
    });
  }

  void paint();
}
