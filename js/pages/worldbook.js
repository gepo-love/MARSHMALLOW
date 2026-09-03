import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { emptyIllustration } from '../components/scrapbook-illustrations.js';
import { bindSwipeActions } from '../components/swipe-actions.js';
import { showToast } from '../components/toast.js';
import {
  listAllWorldBookRows,
  buildWorldBookTree,
  listWorldBookCollections,
  saveWorldBookEntry,
  moveWorldBookItems,
  moveWorldBookGroup,
  deleteWorldBookEntry,
  deleteWorldBookEntryCascade,
  importWorldBookEntries,
  getCollapsedWorldBookIds,
  toggleCollapsedId,
  truncateWorldBookPreview,
  getWorldBookVectorManagementStatus,
  queueWorldBookVectorIndex,
  saveWorldBookVectorManagementEnabled,
} from '../core/world-book-store.js';
import { loadFrontSystemPrompt, saveFrontSystemPrompt } from '../core/front-system-prompt.js';
import { importWorldBookFromDocumentText } from '../core/world-book-import.js';
import {
  buildWorldBookPackage,
  prepareWorldBookPackageImport,
  safeWorldBookFilename,
} from '../core/world-book-package.js';
import { describeDownloadResult, downloadJson } from '../core/native-download.js';
import { importDocumentBaseName, isImportDocumentFile, readCharacterDocumentFile } from '../core/character-document-read.js';
import { createWorldBookEntry, WORLD_BOOK_CATEGORIES, WORLD_BOOK_PRIORITIES } from '../models/worldbook.js';
import { DEFAULT_BOOK_ID, WORLD_BOOKS } from '../data/world-books.js';
import { listCharacters } from '../core/character-store.js';
import { loadContactGroupsConfig } from '../core/contact-groups.js';
import { loadRelationshipNetwork } from '../core/relationship-network.js';
import { isEmbeddingEnabled, loadEmbeddingConfig } from '../core/embedding-tools.js';
import { shareToCommunityStore } from '../core/community-share-draft.js';

const IMPORT_COLLECTION_ID = 'wb_collection_imported_documents';
const IMPORT_COLLECTION_NAME = '文档导入';

/** 首帧先画页面结构，避免 IndexedDB 与向量统计期间落入通用「加载中」。 */
function renderWorldBookSkeleton(container) {
  if (container.firstElementChild) return;
  container.className = 'page scrapbook-page worldbook-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" aria-label="返回" disabled>${icon('back')}</button>
      <h1 class="navbar-title">世界书</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="wb-scroll scrapbook-scroll" aria-busy="true">
      <div class="page-skeleton" aria-hidden="true">
        <span class="sk-block sk-bar" style="width:46%"></span>
        <span class="sk-block" style="height:84px"></span>
        <span class="sk-block" style="height:84px"></span>
        <span class="sk-block sk-bar" style="width:34%"></span>
      </div>
    </main>`;
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getEntryKind(entry) {
  if (!entry) return 'item';
  if (entry.isCollection) return 'collection';
  if (entry.isBookRoot) return 'book';
  if (entry.kind === 'group') return 'group';
  return 'item';
}

function deleteConfirmText(kind) {
  if (kind === 'collection') return '确定删除该分组？组内世界书会保留并移到“未分组”。';
  if (kind === 'book') return '确定删除整本世界书及其下全部分组与条目？此操作不可恢复。';
  if (kind === 'group') return '确定删除该分组及其下全部条目？此操作不可恢复。';
  return '确定删除该条目？此操作不可恢复。';
}

function sheetTitle(entry, persisted) {
  const kind = getEntryKind(entry);
  const prefix = persisted ? '编辑' : '新建';
  if (kind === 'collection') return `${prefix}分组`;
  if (kind === 'book') return `${prefix}世界书`;
  if (kind === 'group') return `${prefix}分组`;
  return `${prefix}条目`;
}

function isBuiltinEntry(entry) {
  return !!entry?.id && WORLD_BOOKS.some((seed) => seed.id === entry.id);
}

function visibleWorldBookEntries(entries = []) {
  const visible = (Array.isArray(entries) ? entries : []).filter((entry) => !isBuiltinEntry(entry));
  const visibleIds = new Set(visible.map((entry) => entry.id));
  return visible.map((entry) => {
    const next = { ...entry };
    if (next.bookId && !visibleIds.has(next.bookId)) next.bookId = '';
    if (next.collectionId && !visibleIds.has(next.collectionId)) next.collectionId = '';
    if (next.groupId && !visibleIds.has(next.groupId)) next.groupId = '';
    if (next.parentGroupId && !visibleIds.has(next.parentGroupId)) next.parentGroupId = '';
    return next;
  });
}

function entryBadges(entry) {
  const tags = [];
  if (entry.priority === 'core') tags.push('核心');
  if (entry.priority === 'hint') tags.push('参考');
  if (entry.constant) tags.push('常驻');
  if (entry.selective) tags.push('关键词');
  if (!entry.enabled) tags.push('已关');
  return tags.map((t) => `<span class="wb-tag">${esc(t)}</span>`).join('');
}

function bookBadges(book) {
  const tags = [];
  if (book.scope === 'character') {
    const count = Array.isArray(book.characterIds) ? book.characterIds.length : 0;
    tags.push(count ? `人物×${count}` : '人物绑定');
  } else if (book.scope === 'group') {
    tags.push('分组绑定');
  } else {
    tags.push('全局');
  }
  if (book.enabled === false) tags.push('已关');
  return tags.map((t) => `<span class="wb-tag">${esc(t)}</span>`).join('');
}

function renderSwipeAction(id, label) {
  return `
    <div class="library-swipe-actions" data-swipe-actions>
      <button type="button" class="library-swipe-action is-danger" data-delete-id="${esc(id)}" aria-label="删除${esc(label)}">删除</button>
    </div>
  `;
}

function renderItemRow(entry, ctx = {}) {
  const { manageMode = false, selectedIds = new Set() } = ctx;
  const isItem = getEntryKind(entry) === 'item';
  const preview = truncateWorldBookPreview(entry.content);
  const selected = selectedIds.has(entry.id);
  const checkHtml = manageMode && isItem
    ? `<label class="wb-item-check" title="选择条目">
        <input type="checkbox" data-select-id="${esc(entry.id)}" ${selected ? 'checked' : ''} aria-label="选择 ${esc(entry.name || '条目')}" />
      </label>`
    : '';
  const mainAttrs = manageMode && isItem
    ? `data-select-toggle="${esc(entry.id)}"`
    : `data-edit-id="${esc(entry.id)}"`;
  const toggleHtml = manageMode && isItem
    ? ''
    : `<label class="wb-toggle" title="启用">
        <input type="checkbox" data-enable-id="${esc(entry.id)}" ${entry.enabled !== false ? 'checked' : ''} aria-label="启用 ${esc(entry.name || '条目')}" />
        <span class="wb-toggle-ui"></span>
      </label>`;
  if (manageMode) return `
    <div class="wb-item-row is-manage${selected ? ' is-selected' : ''}${entry.enabled === false ? ' is-off' : ''}" data-entry-id="${esc(entry.id)}">
      ${checkHtml}
      <button type="button" class="wb-item-main" ${mainAttrs}>
        <span class="wb-item-name">${esc(entry.name || '未命名')}</span>
        <span class="wb-item-preview">${esc(preview)}</span>
        <span class="wb-item-tags">${entryBadges(entry)}</span>
      </button>
      ${toggleHtml}
    </div>
  `;
  return `
    <div class="wb-item-row library-swipe-row${selected ? ' is-selected' : ''}${entry.enabled === false ? ' is-off' : ''}" data-swipe-row data-entry-id="${esc(entry.id)}">
      ${renderSwipeAction(entry.id, `条目 ${entry.name || '未命名'}`)}
      <div class="library-swipe-content wb-item-content" data-swipe-content>
        <button type="button" class="wb-item-main" ${mainAttrs}>
          <span class="wb-item-name">${esc(entry.name || '未命名')}</span>
          <span class="wb-item-preview">${esc(preview)}</span>
          <span class="wb-item-tags">${entryBadges(entry)}</span>
        </button>
        ${toggleHtml}
      </div>
    </div>
  `;
}

function renderGroupNode(group, items, collapsedSet, ctx = {}) {
  const collapsed = collapsedSet.has(group.id);
  const head = `
    <div class="wb-group-head-row">
      <button type="button" class="wb-group-title-btn" data-edit-id="${esc(group.id)}">
        <span class="wb-group-title">${esc(group.name || '分组')}</span>
      </button>
      <span class="wb-group-count">${items.length} 条</span>
      ${ctx.manageMode ? '' : `<label class="wb-toggle wb-group-enable" title="启用分组">
        <input type="checkbox" data-enable-id="${esc(group.id)}" ${group.enabled !== false ? 'checked' : ''} aria-label="启用分组 ${esc(group.name || '分组')}" />
        <span class="wb-toggle-ui"></span>
      </label>`}
      <button type="button" class="wb-group-toggle" data-collapse-id="${esc(group.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? '展开' : '收起'}分组">
        <span class="wb-chevron ${collapsed ? 'is-collapsed' : ''}">${icon('chevronDown')}</span>
      </button>
    </div>
  `;
  return `
    <section class="wb-group scrapbook-card${collapsed ? ' is-collapsed' : ''}" data-group-id="${esc(group.id)}">
      ${ctx.manageMode ? head : `
        <div class="library-swipe-row wb-head-swipe" data-swipe-row>
          ${renderSwipeAction(group.id, `分组 ${group.name || '未命名'}`)}
          <div class="library-swipe-content" data-swipe-content>${head}</div>
        </div>
      `}
      <div class="wb-group-body" ${collapsed ? 'hidden' : ''}>
        ${items.length ? items.map((item) => renderItemRow(item, ctx)).join('') : `<div class="wb-empty-inline">暂无条目</div>`}
        ${ctx.manageMode ? '' : `<button type="button" class="btn btn-sm btn-soft wb-add-item" data-add-item-group="${esc(group.id)}" data-add-item-book="${esc(group.bookId || group.parentGroupId || DEFAULT_BOOK_ID)}">+ 条目</button>`}
      </div>
    </section>
  `;
}

function renderBookNode(node, collapsedSet, ctx = {}) {
  const { book, directItems, groups } = node;
  if (book.id === '_orphan') {
    return `
      <section class="wb-book">
        ${directItems.map((item) => renderItemRow(item, ctx)).join('')}
        ${groups.map(({ group, items }) => renderGroupNode(group, items, collapsedSet, ctx)).join('')}
      </section>
    `;
  }
  const collapsed = collapsedSet.has(book.id);
  const head = `
    <div class="wb-book-head">
      <button type="button" class="wb-book-title-btn" data-edit-id="${esc(book.id)}">
        <span class="wb-book-title">${esc(book.name || '世界书')}</span>
        <span class="wb-book-tags">${bookBadges(book)}</span>
      </button>
      ${ctx.manageMode ? '' : `<label class="wb-toggle" title="全局启用">
        <input type="checkbox" data-enable-id="${esc(book.id)}" ${book.enabled !== false ? 'checked' : ''} aria-label="全局启用 ${esc(book.name || '世界书')}" />
        <span class="wb-toggle-ui"></span>
      </label>`}
      <button type="button" class="wb-book-toggle" data-collapse-id="${esc(book.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? '展开' : '收起'}世界书">
        <span class="wb-chevron ${collapsed ? 'is-collapsed' : ''}">${icon('chevronDown')}</span>
      </button>
    </div>
  `;
  return `
    <section class="wb-book scrapbook-card${collapsed ? ' is-collapsed' : ''}" data-book-id="${esc(book.id)}">
      ${ctx.manageMode ? head : `
        <div class="library-swipe-row wb-head-swipe" data-swipe-row>
          ${renderSwipeAction(book.id, `世界书 ${book.name || '未命名'}`)}
          <div class="library-swipe-content" data-swipe-content>${head}</div>
        </div>
      `}
      <div class="wb-book-body" ${collapsed ? 'hidden' : ''}>
        ${directItems.length ? `<div class="wb-direct-items">${directItems.map((item) => renderItemRow(item, ctx)).join('')}</div>` : ''}
        ${groups.map(({ group, items }) => renderGroupNode(group, items, collapsedSet, ctx)).join('')}
        ${ctx.manageMode ? '' : `<div class="wb-book-actions">
          <button type="button" class="btn btn-sm btn-soft" data-add-group-book="${esc(book.id)}">+ 分组</button>
          <button type="button" class="btn btn-sm btn-soft" data-add-item-book="${esc(book.id)}">+ 条目</button>
        </div>`}
      </div>
    </section>
  `;
}

function renderCollectionNode(collection, bookNodes, collapsedSet, ctx = {}) {
  const collapsed = collapsedSet.has(collection.id);
  const head = `
    <div class="wb-collection-head">
      <button type="button" class="wb-collection-title-btn" data-edit-id="${esc(collection.id)}">
        <span class="wb-collection-mark" aria-hidden="true"></span>
        <span class="wb-collection-title">${esc(collection.name || '分组')}</span>
      </button>
      <span class="wb-collection-count">${bookNodes.length} 本</span>
      ${ctx.manageMode ? '' : `<button type="button" class="wb-collection-rename" data-edit-id="${esc(collection.id)}" aria-label="重命名 ${esc(collection.name || '分组')}">${icon('edit')}</button>`}
      ${ctx.manageMode ? '' : `<label class="wb-toggle wb-collection-enable" title="整组启用">
        <input type="checkbox" data-enable-id="${esc(collection.id)}" ${collection.enabled !== false ? 'checked' : ''} aria-label="整组启用 ${esc(collection.name || '分组')}" />
        <span class="wb-toggle-ui"></span>
      </label>`}
      <button type="button" class="wb-book-toggle" data-collapse-id="${esc(collection.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? '展开' : '收起'}分组">
        <span class="wb-chevron ${collapsed ? 'is-collapsed' : ''}">${icon('chevronDown')}</span>
      </button>
    </div>
  `;
  return `
    <section class="wb-collection${collapsed ? ' is-collapsed' : ''}${collection.enabled === false ? ' is-off' : ''}" data-collection-id="${esc(collection.id)}">
      ${ctx.manageMode ? head : `
        <div class="library-swipe-row wb-collection-swipe" data-swipe-row>
          ${renderSwipeAction(collection.id, `分组 ${collection.name || '未命名'}`)}
          <div class="library-swipe-content" data-swipe-content>${head}</div>
        </div>
      `}
      <div class="wb-collection-body" ${collapsed ? 'hidden' : ''}>
        ${bookNodes.length
    ? bookNodes.map((node) => renderBookNode(node, collapsedSet, ctx)).join('')
    : '<div class="wb-empty-inline">暂无世界书</div>'}
      </div>
    </section>
  `;
}

function renderWorldBookLibrary(tree, collections, collapsedSet, ctx = {}) {
  const collectionIds = new Set(collections.map((collection) => collection.id));
  const grouped = collections.map((collection) => ({
    collection,
    books: tree.filter((node) => node.book.collectionId === collection.id),
  }));
  const ungrouped = tree.filter((node) => !node.book.collectionId || !collectionIds.has(node.book.collectionId));
  return `
    ${grouped.map(({ collection, books }) => renderCollectionNode(collection, books, collapsedSet, ctx)).join('')}
    ${ungrouped.length && collections.length ? `
      <section class="wb-ungrouped">
        <div class="wb-ungrouped-head"><span>未分组</span><small>${ungrouped.length} 本</small></div>
        <div class="wb-ungrouped-body">${ungrouped.map((node) => renderBookNode(node, collapsedSet, ctx)).join('')}</div>
      </section>
    ` : ungrouped.map((node) => renderBookNode(node, collapsedSet, ctx)).join('')}
  `;
}

function listManageableItems(entryList = []) {
  return visibleWorldBookEntries(entryList).filter((entry) => getEntryKind(entry) === 'item');
}

function renderManageBar(selectedCount = 0, canMove = false) {
  const priorityOptions = Object.entries(WORLD_BOOK_PRIORITIES).map(([id, meta]) => (
    `<option value="${esc(id)}">${esc(meta.label)}</option>`
  )).join('');
  return `
    <div class="wb-manage-bar is-visible" role="toolbar" aria-label="批量管理条目">
      <div class="wb-manage-meta">
        <span class="wb-manage-count">已选 ${selectedCount} 条</span>
        <button type="button" class="btn btn-xs btn-soft" data-select-all-items>全选</button>
        <button type="button" class="btn btn-xs btn-soft" data-clear-selection ${selectedCount ? '' : 'disabled'}>清空</button>
      </div>
      <div class="wb-manage-actions">
        <button type="button" class="btn btn-sm btn-primary" data-open-item-move ${selectedCount && canMove ? '' : 'disabled'}>移动</button>
        <label class="wb-manage-priority">
          <span>优先级</span>
          <select class="form-input wb-manage-priority-select">${priorityOptions}</select>
        </label>
        <button type="button" class="btn btn-sm btn-primary" data-apply-priority ${selectedCount ? '' : 'disabled'}>应用</button>
        <button type="button" class="btn btn-sm btn-outline is-danger" data-batch-delete ${selectedCount ? '' : 'disabled'}>删除</button>
      </div>
    </div>
  `;
}

function renderVectorManagerSheet(status = {}, embeddingConfig = {}) {
  const embeddingReady = isEmbeddingEnabled(embeddingConfig);
  const enabled = status.enabled === true;
  const ready = Math.max(0, Number(status.ready || 0));
  const pending = Math.max(0, Number(status.pending || 0));
  const failed = Math.max(0, Number(status.failed || 0));
  const passages = Math.max(0, Number(status.passages || 0));
  const progressMax = Math.max(1, passages, ready + pending + failed);
  const stateLabel = !embeddingReady
    ? '向量模型未启用'
    : (!enabled
      ? '未启用'
      : (failed ? '部分索引失败' : (pending ? '正在建立索引' : '索引已就绪')));
  return `
    <aside class="wb-sheet wb-vector-sheet is-open" aria-hidden="false">
      <div class="wb-sheet-backdrop" data-close-vector-manager></div>
      <div class="wb-sheet-panel scrapbook-card">
        <header class="wb-sheet-head">
          <h2>向量管理</h2>
          <button type="button" class="navbar-btn" data-close-vector-manager aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="wb-sheet-body">
          <label class="wb-vector-toggle-row">
            <span>向量管理世界书</span>
            <input type="checkbox" data-worldbook-vector-enabled ${enabled ? 'checked' : ''} />
          </label>
          <div class="wb-vector-state" role="status" aria-live="polite">
            <div class="wb-vector-state-head">
              <strong>${esc(stateLabel)}</strong>
              <span>${ready}/${passages} 段</span>
            </div>
            <progress max="${progressMax}" value="${Math.min(progressMax, ready)}" aria-label="世界书向量索引进度"></progress>
          </div>
          <dl class="wb-vector-counts">
            <div><dt>已索引</dt><dd>${ready}</dd></div>
            <div><dt>待处理</dt><dd>${pending}</dd></div>
            <div><dt>失败</dt><dd>${failed}</dd></div>
          </dl>
          ${embeddingReady ? '' : '<button type="button" class="btn btn-outline" data-open-embedding-settings>打开 API 管理</button>'}
        </div>
        <footer class="wb-sheet-foot">
          <button type="button" class="btn btn-outline" data-refresh-vector-status>刷新</button>
          <button type="button" class="btn btn-primary" data-rebuild-worldbook-vectors ${enabled && embeddingReady ? '' : 'disabled'}>重建索引</button>
        </footer>
      </div>
    </aside>
  `;
}

function renderGroupBookField(entry, books = []) {
  const currentBookId = String(entry?.bookId || entry?.parentGroupId || '').trim();
  return `
    <label class="wb-field">
      <span>所属世界书</span>
      <select class="form-input wb-input-parent-book">
        ${books.map((book) => `
          <option value="${esc(book.id)}" ${currentBookId === book.id ? 'selected' : ''}>${esc(book.name || '未命名世界书')}</option>
        `).join('')}
      </select>
    </label>
  `;
}

function renderItemMoveSheet(books = [], entries = [], selectedCount = 0, targetBookId = '') {
  const activeBookId = books.some((book) => book.id === targetBookId)
    ? targetBookId
    : String(books[0]?.id || '');
  const groups = entries.filter((entry) => (
    entry?.kind === 'group'
    && !entry.isBookRoot
    && !entry.isCollection
    && String(entry.bookId || entry.parentGroupId || '') === activeBookId
  ));
  return `
    <aside class="wb-sheet wb-item-move-sheet is-open" aria-hidden="false">
      <div class="wb-sheet-backdrop" data-close-item-move></div>
      <div class="wb-sheet-panel scrapbook-card">
        <header class="wb-sheet-head">
          <h2>移动 ${selectedCount} 条条目</h2>
          <button type="button" class="navbar-btn" data-close-item-move aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="wb-sheet-body">
          <label class="wb-field">
            <span>目标世界书</span>
            <select class="form-input wb-item-move-book">
              ${books.map((book) => `
                <option value="${esc(book.id)}" ${activeBookId === book.id ? 'selected' : ''}>${esc(book.name || '未命名世界书')}</option>
              `).join('')}
            </select>
          </label>
          <label class="wb-field">
            <span>条目分组</span>
            <select class="form-input wb-item-move-group">
              <option value="">直接放在世界书下</option>
              ${groups.map((group) => `<option value="${esc(group.id)}">${esc(group.name || '未命名分组')}</option>`).join('')}
            </select>
          </label>
        </div>
        <footer class="wb-sheet-foot">
          <button type="button" class="btn btn-outline" data-close-item-move>取消</button>
          <button type="button" class="btn btn-primary" data-confirm-item-move ${activeBookId ? '' : 'disabled'}>移动</button>
        </footer>
      </div>
    </aside>
  `;
}

function renderBookBindingField(entry, characters = [], bindableGroups = []) {
  const selected = new Set(Array.isArray(entry?.characterIds) ? entry.characterIds : []);
  const options = characters.length ? characters.map((char) => {
    const label = String(char.name || char.realName || char.id || '').trim() || '未命名';
    return `
    <label class="wb-character-check">
      <input type="checkbox" data-wb-character-id="${esc(char.id)}" ${selected.has(char.id) ? 'checked' : ''} />
      <span>${esc(label)}</span>
    </label>
  `;
  }).join('') : '<p class="wb-sheet-note">暂无角色</p>';
  const selectedGroup = `${entry?.groupType || ''}:${entry?.groupRefId || ''}`;
  const groupOptions = bindableGroups.length
    ? bindableGroups.map((g) => `<option value="${esc(g.value)}" ${selectedGroup === g.value ? 'selected' : ''}>${esc(g.label)}</option>`).join('')
    : '<option value="">（还没有分组或关系圈）</option>';
  return `
    <label class="wb-field">
      <span>生效范围</span>
      <select class="form-input wb-input-scope">
        <option value="global" ${!['character', 'group'].includes(entry?.scope) ? 'selected' : ''}>全局（开关控制是否默认注入）</option>
        <option value="character" ${entry?.scope === 'character' ? 'selected' : ''}>绑定人物（仅选中角色会话生效）</option>
        <option value="group" ${entry?.scope === 'group' ? 'selected' : ''}>绑定分组 / 关系圈（成员会话生效）</option>
      </select>
    </label>
    <div class="wb-character-bindings" data-wb-character-bindings ${entry?.scope === 'character' ? '' : 'hidden'}>
      ${options}
    </div>
    <label class="wb-field" data-wb-group-binding ${entry?.scope === 'group' ? '' : 'hidden'}>
      <span>选择分组</span>
      <select class="form-input wb-input-group">${groupOptions}</select>
    </label>
    <p class="wb-sheet-note">人物与分组绑定不受全局开关限制。</p>
  `;
}

function renderSheetBody(entry, characters = [], bindableGroups = [], collections = [], books = []) {
  const kind = getEntryKind(entry);
  if (kind === 'item') {
    return `
      <label class="wb-field">
        <span>名称</span>
        <input type="text" class="form-input wb-input-name" value="${esc(entry?.name || '')}" maxlength="60" />
      </label>
      <label class="wb-field">
        <span>分类</span>
        <select class="form-input wb-input-category">
          ${Object.entries(WORLD_BOOK_CATEGORIES).map(([id, meta]) => `
            <option value="${esc(id)}" ${entry?.category === id ? 'selected' : ''}>${esc(meta.label)}</option>
          `).join('')}
        </select>
      </label>
      <label class="wb-field wb-field-row">
        <span><input type="checkbox" class="wb-input-constant" ${entry?.constant ? 'checked' : ''} /> 常驻生效</span>
        <span><input type="checkbox" class="wb-input-selective" ${entry?.selective ? 'checked' : ''} /> 关键词触发</span>
      </label>
      <label class="wb-field">
        <span>关键词（逗号分隔）</span>
        <input type="text" class="form-input wb-input-keys" value="${esc((entry?.keys || []).join('，'))}" placeholder="例如：生气，冷战" />
      </label>
      <label class="wb-field">
        <span>优先级</span>
        <select class="form-input wb-input-priority">
          ${Object.entries(WORLD_BOOK_PRIORITIES).map(([id, meta]) => `
            <option value="${esc(id)}" ${(entry?.priority || 'normal') === id ? 'selected' : ''}>${esc(meta.label)} · ${esc(meta.hint)}</option>
          `).join('')}
        </select>
      </label>
      <label class="wb-field">
        <span>正文</span>
        <textarea class="form-input wb-input-content" rows="10">${esc(entry?.content || '')}</textarea>
      </label>
    `;
  }

  const placeholder = kind === 'book' ? '例如：角色设定库' : (kind === 'collection' ? '例如：主线设定' : '例如：基础规则');
  if (kind === 'book') {
    return `
      <label class="wb-field">
        <span>名称</span>
        <input type="text" class="form-input wb-input-name" value="${esc(entry?.name || '')}" maxlength="60" placeholder="${esc(placeholder)}" />
      </label>
      <label class="wb-field">
        <span>收纳分组</span>
        <select class="form-input wb-input-collection">
          <option value="">未分组</option>
          ${collections.map((collection) => `
            <option value="${esc(collection.id)}" ${entry?.collectionId === collection.id ? 'selected' : ''}>${esc(collection.name || '未命名分组')}</option>
          `).join('')}
        </select>
      </label>
      ${renderBookBindingField(entry, characters, bindableGroups)}
    `;
  }
  return `
    <label class="wb-field">
      <span>名称</span>
      <input type="text" class="form-input wb-input-name" value="${esc(entry?.name || '')}" maxlength="60" placeholder="${esc(placeholder)}" />
    </label>
    ${kind === 'group' ? renderGroupBookField(entry, books) : ''}
  `;
}

export default async function render(container) {
  renderWorldBookSkeleton(container);
  let [entries, characters, contactGroupsConfig, relationshipNet, embeddingConfig, frontSystemPrompt] = await Promise.all([
    listAllWorldBookRows(),
    listCharacters({ excludeAnonNpc: true }),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadRelationshipNetwork().catch(() => ({ circles: [] })),
    loadEmbeddingConfig().catch(() => ({})),
    loadFrontSystemPrompt().catch(() => ''),
  ]);
  let [vectorStatus, collapsedSet] = await Promise.all([
    getWorldBookVectorManagementStatus(entries),
    getCollapsedWorldBookIds(),
  ]);
  let editing = null;
  let manageMode = false;
  let selectedIds = new Set();
  let actionMenuOpen = false;
  let pendingImportFiles = [];
  let itemMoveOpen = false;
  let itemMoveBookId = '';
  let vectorManagerOpen = false;
  let frontPromptOpen = false;
  let unbindSwipe = () => {};

  function bindableGroups() {
    return [
      ...(contactGroupsConfig.groups || []).map((g) => ({ value: `contact:${g.id}`, label: `通讯录 · ${g.name}` })),
      ...(relationshipNet.circles || []).map((c) => ({ value: `relationship:${c.id}`, label: `关系圈 · ${c.name}` })),
    ];
  }

  container.className = 'page scrapbook-page worldbook-page';

  async function reload() {
    const [nextEntries, nextCharacters, nextEmbeddingConfig] = await Promise.all([
      listAllWorldBookRows(),
      listCharacters({ excludeAnonNpc: true }),
      loadEmbeddingConfig().catch(() => ({})),
    ]);
    const nextVectorStatus = await getWorldBookVectorManagementStatus(nextEntries);
    entries = nextEntries;
    characters = nextCharacters;
    vectorStatus = nextVectorStatus;
    embeddingConfig = nextEmbeddingConfig;
    paint();
  }

  function isPersisted(entry) {
    return !!entry?.id && entries.some((e) => e.id === entry.id);
  }

  function paint() {
    unbindSwipe();
    unbindSwipe = () => {};
    const prevScrollTop = container.querySelector('.wb-scroll')?.scrollTop || 0;
    const visibleEntries = visibleWorldBookEntries(entries);
    const tree = buildWorldBookTree(visibleEntries);
    const collections = listWorldBookCollections(visibleEntries);
    const books = visibleEntries.filter((entry) => entry.isBookRoot && !entry.isCollection);
    if (itemMoveOpen && !books.some((book) => book.id === itemMoveBookId)) {
      itemMoveBookId = String(books[0]?.id || '');
    }
    const persisted = isPersisted(editing);
    const manageCtx = { manageMode, selectedIds };
    const selectedCount = selectedIds.size;
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${manageMode ? '管理条目' : '世界书'}</h1>
        <div class="wb-navbar-actions">
          ${manageMode ? `
            <button type="button" class="navbar-btn wb-manage-done" data-manage-done>完成</button>
          ` : `
            <input type="file" class="wb-import-input" accept=".json,application/json,.txt,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple hidden />
            <button type="button" class="navbar-btn" data-vector-manager aria-label="向量管理">${icon('database')}</button>
            <button type="button" class="navbar-btn" data-manage aria-label="批量管理">管理</button>
            <button type="button" class="navbar-btn" data-library-menu aria-label="添加">${icon('plus')}</button>
          `}
        </div>
      </header>
      <main class="wb-scroll scrapbook-scroll${manageMode ? ' has-manage-bar' : ''}">
        ${tree.length || collections.length ? renderWorldBookLibrary(tree, collections, collapsedSet, manageCtx) : `
          <div class="chat-empty scrapbook-empty">
            ${emptyIllustration('book')}
            <div class="chat-empty-text">还没有设定条目</div>
            ${manageMode ? '' : '<button type="button" class="btn btn-primary" data-library-menu>导入或新建</button>'}
          </div>
        `}
      </main>
      ${manageMode ? renderManageBar(selectedCount, books.length > 0) : ''}
      <aside class="wb-action-sheet ${actionMenuOpen ? 'is-open' : ''}" aria-hidden="${actionMenuOpen ? 'false' : 'true'}">
        <button type="button" class="wb-action-backdrop" data-close-actions aria-label="关闭"></button>
        <div class="wb-action-panel">
          <button type="button" class="wb-action-row" data-import>${icon('folder')}<span>导入文件</span></button>
          <button type="button" class="wb-action-row" data-front-system-prompt><span class="wb-action-text-icon">前</span><span>全局前置系统提示词</span></button>
          <button type="button" class="wb-action-row" data-add-book>${icon('plus')}<span>新建世界书</span></button>
          <button type="button" class="wb-action-row" data-add-collection>${icon('folder')}<span>新建分组</span></button>
          <button type="button" class="wb-action-row" data-miniwiki><span class="wb-action-text-icon">梗</span><span>梗百科</span></button>
        </div>
      </aside>
      <aside class="wb-sheet ${editing ? 'is-open' : ''}" aria-hidden="${editing ? 'false' : 'true'}">
        <div class="wb-sheet-backdrop" data-close-sheet></div>
        <div class="wb-sheet-panel scrapbook-card">
          <header class="wb-sheet-head">
            <h2>${esc(sheetTitle(editing, persisted))}</h2>
            <button type="button" class="navbar-btn" data-close-sheet aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="wb-sheet-body" data-ime-scroll-region>
            ${editing ? renderSheetBody(editing, characters, bindableGroups(), collections, books) : ''}
          </div>
          <footer class="wb-sheet-foot">
            ${persisted && editing && !isBuiltinEntry(editing) ? '<button type="button" class="btn btn-outline is-danger wb-sheet-delete" data-sheet-delete>删除</button>' : ''}
            ${persisted && getEntryKind(editing) === 'item' ? '<button type="button" class="btn btn-outline" title="复制条目" data-copy-entry>复制条目</button>' : ''}
            ${persisted && editing && !isBuiltinEntry(editing) ? `<button type="button" class="btn btn-outline" data-export-entry title="导出文件">导出</button><button type="button" class="btn btn-soft wb-share-entry" data-share-entry aria-label="分享到应用商店" title="分享到应用商店">${icon('share')}</button>` : ''}
            <button type="button" class="btn btn-primary" data-save-entry>保存</button>
          </footer>
        </div>
      </aside>
      ${itemMoveOpen ? renderItemMoveSheet(books, visibleEntries, selectedCount, itemMoveBookId) : ''}
      ${vectorManagerOpen ? renderVectorManagerSheet(vectorStatus, embeddingConfig) : ''}
      ${frontPromptOpen ? `<aside class="wb-sheet is-open" aria-hidden="false">
        <div class="wb-sheet-backdrop" data-close-front-system-prompt></div>
        <div class="wb-sheet-panel scrapbook-card">
          <header class="wb-sheet-head">
            <h2>全局前置系统提示词</h2>
            <button type="button" class="navbar-btn" data-close-front-system-prompt aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="wb-sheet-body" data-ime-scroll-region>
            <label class="wb-field">
              <span>提示词</span>
              <textarea class="form-input wb-front-system-prompt" rows="12" maxlength="20000" placeholder="填写需要优先注入的系统提示词">${esc(frontSystemPrompt)}</textarea>
            </label>
            <div class="wb-sheet-note">用于所有内容文本生成，包括聊天、线下、番外和工具 API。</div>
          </div>
          <footer class="wb-sheet-foot">
            <button type="button" class="btn btn-primary" data-save-front-system-prompt>保存</button>
          </footer>
        </div>
      </aside>` : ''}
      ${pendingImportFiles.length ? `<aside class="wb-sheet wb-import-sheet is-open" aria-hidden="false">
        <div class="wb-sheet-backdrop" data-close-import></div>
        <div class="wb-sheet-panel scrapbook-card">
          <header class="wb-sheet-head">
            <h2>导入世界书</h2>
            <button type="button" class="navbar-btn" data-close-import aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="wb-sheet-body">
            <div class="wb-import-summary">已选择 ${pendingImportFiles.length} 个文档</div>
            <label class="wb-field">
              <span>导入到</span>
              <select class="form-input wb-import-collection">
                <option value="">未分组</option>
                <option value="${IMPORT_COLLECTION_ID}">${esc(entries.find((row) => row.isCollection && row.id === IMPORT_COLLECTION_ID)?.name || IMPORT_COLLECTION_NAME)}</option>
                ${collections.filter((collection) => collection.id !== IMPORT_COLLECTION_ID).map((collection) => `
                  <option value="${esc(collection.id)}">${esc(collection.name || '未命名分组')}</option>
                `).join('')}
              </select>
            </label>
          </div>
          <footer class="wb-sheet-foot">
            <button type="button" class="btn btn-outline" data-close-import>取消</button>
            <button type="button" class="btn btn-primary" data-confirm-import>导入</button>
          </footer>
        </div>
      </aside>` : ''}
    `;

    bindEvents();
    if (!manageMode) {
      unbindSwipe = bindSwipeActions(container.querySelector('.wb-scroll'));
    }
    const scrollEl = container.querySelector('.wb-scroll');
    if (scrollEl && prevScrollTop) scrollEl.scrollTop = prevScrollTop;
    if (editing) {
      const sheetBody = container.querySelector('.wb-sheet-body');
      if (sheetBody) sheetBody.scrollTop = 0;
      // 等抽屉抬起后再聚焦，避免键盘抢高度时把名称栏滚出可视区，看起来像「空心」表单
      window.setTimeout(() => {
        const nameInput = container.querySelector('.wb-input-name');
        if (!nameInput || !nameInput.isConnected) return;
        try { nameInput.focus({ preventScroll: true }); } catch (_) {
          try { nameInput.focus(); } catch (__) {}
        }
        if (sheetBody) sheetBody.scrollTop = 0;
      }, 220);
    }
  }

  function openEditor(entry) {
    editing = entry ? { ...entry } : createWorldBookEntry({
      kind: 'item',
      category: 'custom',
    });
    paint();
  }

  async function confirmAndDelete(entry) {
    if (!entry?.id) return false;
    const kind = getEntryKind(entry);
    if (!window.confirm(deleteConfirmText(kind))) return false;
    let count = 0;
    if (kind === 'collection') {
      const books = entries.filter((row) => row.isBookRoot && row.collectionId === entry.id);
      for (const book of books) {
        await saveWorldBookEntry({ ...book, collectionId: '' });
      }
      await deleteWorldBookEntry(entry.id);
      count = 1;
    } else {
      count = await deleteWorldBookEntryCascade(entry.id, entries);
    }
    if (editing?.id === entry.id) editing = null;
    selectedIds.delete(entry.id);
    showToast(count > 1 ? `已删除 ${count} 项` : '已删除');
    await reload();
    return true;
  }

  function toggleSelection(id, force = null) {
    const key = String(id || '').trim();
    if (!key) return;
    const entry = entries.find((e) => e.id === key);
    if (!entry || getEntryKind(entry) !== 'item') return;
    if (force === true) selectedIds.add(key);
    else if (force === false) selectedIds.delete(key);
    else if (selectedIds.has(key)) selectedIds.delete(key);
    else selectedIds.add(key);
    paint();
  }

  async function applyBatchPriority() {
    const priority = String(container.querySelector('.wb-manage-priority-select')?.value || 'normal').trim();
    const ids = [...selectedIds];
    if (!ids.length) {
      showToast('请先选择条目');
      return;
    }
    await Promise.all(ids.map(async (id) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry || getEntryKind(entry) !== 'item') return;
      await saveWorldBookEntry({ ...entry, priority });
    }));
    showToast(`已更新 ${ids.length} 条优先级`);
    selectedIds.clear();
    await reload();
  }

  async function batchDeleteSelected() {
    const ids = [...selectedIds];
    if (!ids.length) {
      showToast('请先选择条目');
      return;
    }
    if (!window.confirm(`确定删除选中的 ${ids.length} 条条目？此操作不可恢复。`)) return;
    for (const id of ids) {
      await deleteWorldBookEntry(id);
    }
    selectedIds.clear();
    showToast(`已删除 ${ids.length} 条`);
    await reload();
  }

  async function moveSelectedItems() {
    const ids = [...selectedIds];
    if (!ids.length) {
      showToast('请先选择条目');
      return;
    }
    const bookId = String(container.querySelector('.wb-item-move-book')?.value || '').trim();
    const groupId = String(container.querySelector('.wb-item-move-group')?.value || '').trim();
    const rows = await moveWorldBookItems(ids, { bookId, groupId });
    itemMoveOpen = false;
    itemMoveBookId = '';
    selectedIds.clear();
    showToast(`已移动 ${rows.length} 条`);
    await reload();
  }

  function bindEvents() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-miniwiki]')?.addEventListener('click', () => navigate('mini-wiki'));
    container.querySelector('[data-vector-manager]')?.addEventListener('click', async () => {
      try {
        [vectorStatus, embeddingConfig] = await Promise.all([
          getWorldBookVectorManagementStatus(),
          loadEmbeddingConfig().catch(() => ({})),
        ]);
      } catch (error) {
        showToast(error?.message || '向量状态读取失败');
      }
      vectorManagerOpen = true;
      actionMenuOpen = false;
      paint();
    });
    container.querySelector('[data-front-system-prompt]')?.addEventListener('click', () => {
      frontPromptOpen = true;
      actionMenuOpen = false;
      paint();
    });
    container.querySelectorAll('[data-close-front-system-prompt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        frontPromptOpen = false;
        paint();
      });
    });
    container.querySelector('[data-save-front-system-prompt]')?.addEventListener('click', async () => {
      const field = container.querySelector('.wb-front-system-prompt');
      const next = String(field?.value || '').trim();
      try {
        frontSystemPrompt = await saveFrontSystemPrompt(next);
        frontPromptOpen = false;
        showToast(frontSystemPrompt ? '前置系统提示词已保存' : '前置系统提示词已清空');
        paint();
      } catch (error) {
        showToast(error?.message || '前置系统提示词保存失败');
      }
    });
    container.querySelectorAll('[data-close-vector-manager]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vectorManagerOpen = false;
        paint();
      });
    });
    container.querySelector('[data-open-embedding-settings]')?.addEventListener('click', () => {
      vectorManagerOpen = false;
      navigate('settings/api');
    });
    container.querySelector('[data-refresh-vector-status]')?.addEventListener('click', async () => {
      try {
        [vectorStatus, embeddingConfig] = await Promise.all([
          getWorldBookVectorManagementStatus(),
          loadEmbeddingConfig().catch(() => ({})),
        ]);
      } catch (error) {
        showToast(error?.message || '向量状态刷新失败');
      }
      paint();
    });
    container.querySelector('[data-worldbook-vector-enabled]')?.addEventListener('change', async (event) => {
      const enabled = event.currentTarget.checked;
      event.currentTarget.disabled = true;
      try {
        await saveWorldBookVectorManagementEnabled(enabled);
        if (enabled) {
          await queueWorldBookVectorIndex();
          showToast('已启用世界书向量管理');
        } else {
          showToast('已关闭世界书向量管理');
        }
      } catch (error) {
        showToast(error?.message || '世界书向量设置保存失败');
      }
      vectorStatus = await getWorldBookVectorManagementStatus().catch(() => ({
        ...vectorStatus,
        enabled,
      }));
      paint();
    });
    container.querySelector('[data-rebuild-worldbook-vectors]')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        const result = await queueWorldBookVectorIndex({ force: true });
        showToast(result.passages ? `已提交 ${result.passages} 个索引分段` : '暂无可索引内容');
      } catch (error) {
        showToast(error?.message || '世界书索引提交失败');
      }
      vectorStatus = await getWorldBookVectorManagementStatus().catch(() => vectorStatus);
      paint();
    });
    container.querySelectorAll('[data-library-menu]').forEach((btn) => {
      btn.addEventListener('click', () => {
        actionMenuOpen = true;
        paint();
      });
    });
    container.querySelector('[data-close-actions]')?.addEventListener('click', () => {
      actionMenuOpen = false;
      paint();
    });

    container.querySelector('[data-manage]')?.addEventListener('click', () => {
      manageMode = true;
      selectedIds = new Set();
      editing = null;
      paint();
    });
    container.querySelector('[data-manage-done]')?.addEventListener('click', () => {
      manageMode = false;
      itemMoveOpen = false;
      itemMoveBookId = '';
      selectedIds.clear();
      paint();
    });

    container.querySelector('[data-select-all-items]')?.addEventListener('click', () => {
      listManageableItems(entries).forEach((item) => selectedIds.add(item.id));
      paint();
    });
    container.querySelector('[data-clear-selection]')?.addEventListener('click', () => {
      selectedIds.clear();
      paint();
    });
    container.querySelector('[data-apply-priority]')?.addEventListener('click', () => {
      applyBatchPriority().catch((err) => showToast(err?.message || '更新失败', 4000));
    });
    container.querySelector('[data-batch-delete]')?.addEventListener('click', () => {
      batchDeleteSelected().catch((err) => showToast(err?.message || '删除失败', 4000));
    });
    container.querySelector('[data-open-item-move]')?.addEventListener('click', () => {
      const books = visibleWorldBookEntries(entries)
        .filter((entry) => entry.isBookRoot && !entry.isCollection);
      if (!selectedIds.size) {
        showToast('请先选择条目');
        return;
      }
      if (!books.length) {
        showToast('请先新建一个世界书');
        return;
      }
      itemMoveBookId = String(books[0].id || '');
      itemMoveOpen = true;
      paint();
    });
    container.querySelectorAll('[data-close-item-move]').forEach((btn) => {
      btn.addEventListener('click', () => {
        itemMoveOpen = false;
        itemMoveBookId = '';
        paint();
      });
    });
    container.querySelector('.wb-item-move-book')?.addEventListener('change', (ev) => {
      itemMoveBookId = String(ev.target.value || '').trim();
      paint();
    });
    container.querySelector('[data-confirm-item-move]')?.addEventListener('click', () => {
      moveSelectedItems().catch((err) => showToast(err?.message || '移动失败', 4000));
    });

    container.querySelectorAll('[data-select-id]').forEach((input) => {
      input.addEventListener('change', () => {
        toggleSelection(input.getAttribute('data-select-id'), input.checked);
      });
    });
    container.querySelectorAll('[data-select-toggle]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        toggleSelection(btn.getAttribute('data-select-toggle'));
      });
    });

    container.querySelectorAll('[data-collapse-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-collapse-id');
        collapsedSet = await toggleCollapsedId(id, collapsedSet);
        paint();
      });
    });

    container.querySelectorAll('[data-edit-id]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (manageMode) return;
        const id = btn.getAttribute('data-edit-id');
        const entry = entries.find((e) => e.id === id);
        if (entry) openEditor(entry);
      });
    });

    container.querySelectorAll('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = btn.getAttribute('data-delete-id');
        const entry = entries.find((e) => e.id === id);
        if (entry) await confirmAndDelete(entry);
      });
    });
    container.querySelector('[data-sheet-delete]')?.addEventListener('click', async () => {
      if (editing) await confirmAndDelete(editing);
    });
    container.querySelector('[data-copy-entry]')?.addEventListener('click', () => {
      if (!editing || getEntryKind(editing) !== 'item') return;
      editing = createWorldBookEntry({
        ...editing,
        id: '',
        name: `${editing.name || '未命名'}（副本）`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      paint();
    });
    container.querySelector('[data-export-entry]')?.addEventListener('click', async () => {
      if (!editing || !isPersisted(editing) || isBuiltinEntry(editing)) return;
      try {
        const pkg = buildWorldBookPackage(entries, editing.id);
        const result = await downloadJson(pkg, safeWorldBookFilename(pkg.name));
        showToast(describeDownloadResult(result));
      } catch (err) {
        showToast(err?.message || '导出失败', 4000);
      }
    });
    container.querySelector('[data-share-entry]')?.addEventListener('click', () => {
      if (!editing || !isPersisted(editing) || isBuiltinEntry(editing)) return;
      try {
        const pkg = buildWorldBookPackage(entries, editing.id);
        shareToCommunityStore({
          source: pkg,
          fileName: safeWorldBookFilename(pkg.name),
          resourceType: 'worldbook',
          title: pkg.name,
          originLabel: '世界书',
        });
      } catch (err) {
        showToast(err?.message || '无法分享', 4000);
      }
    });

    container.querySelectorAll('[data-enable-id]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-enable-id');
        const entry = entries.find((e) => e.id === id);
        if (!entry) return;
        await saveWorldBookEntry({ ...entry, enabled: input.checked });
        await reload();
      });
    });

    container.querySelector('.wb-input-scope')?.addEventListener('change', (ev) => {
      const charTarget = container.querySelector('[data-wb-character-bindings]');
      if (charTarget) charTarget.hidden = ev.target.value !== 'character';
      const groupTarget = container.querySelector('[data-wb-group-binding]');
      if (groupTarget) groupTarget.hidden = ev.target.value !== 'group';
    });

    const fileInput = container.querySelector('.wb-import-input');
    container.querySelectorAll('[data-import]').forEach((btn) => {
      btn.addEventListener('click', () => {
        actionMenuOpen = false;
        container.querySelector('.wb-action-sheet')?.classList.remove('is-open');
        fileInput?.click();
      });
    });
    fileInput?.addEventListener('change', async () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = '';
      if (!files.length) return;
      const jsonFiles = files.filter((file) => /\.json$/i.test(file.name || ''));
      const documentFiles = files.filter((file) => !/\.json$/i.test(file.name || ''));
      const invalid = documentFiles.find((file) => !isImportDocumentFile(file));
      if (invalid) {
        showToast('世界书支持 JSON、TXT 或 DOCX 文件', 4000);
        return;
      }
      try {
        let imported = 0;
        for (const file of jsonFiles) {
          const source = JSON.parse(await file.text());
          const prepared = prepareWorldBookPackageImport(source);
          imported += await importWorldBookEntries(prepared.entries);
        }
        if (imported) {
          showToast(`已导入 ${imported} 条世界书内容`);
          await reload();
        }
      } catch (err) {
        showToast(err?.message || '世界书 JSON 导入失败', 4000);
        return;
      }
      pendingImportFiles = documentFiles;
      paint();
    });
    container.querySelectorAll('[data-close-import]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingImportFiles = [];
        paint();
      });
    });
    container.querySelector('[data-confirm-import]')?.addEventListener('click', async (ev) => {
      const files = [...pendingImportFiles];
      if (!files.length) return;
      const targetId = String(container.querySelector('.wb-import-collection')?.value || '').trim();
      const button = ev.currentTarget;
      button.disabled = true;
      try {
        let targetName = '未分组';
        if (targetId === IMPORT_COLLECTION_ID) {
          let importCollection = entries.find((row) => row.isCollection && row.id === IMPORT_COLLECTION_ID);
          if (!importCollection) {
            importCollection = createWorldBookEntry({
              id: IMPORT_COLLECTION_ID,
              kind: 'group',
              isCollection: true,
              name: IMPORT_COLLECTION_NAME,
              category: 'custom',
              position: 0,
            });
            await saveWorldBookEntry(importCollection);
          }
          targetName = importCollection.name || IMPORT_COLLECTION_NAME;
        } else if (targetId) {
          const collection = entries.find((row) => row.isCollection && row.id === targetId);
          if (!collection) throw new Error('目标分组不存在，请重新选择');
          targetName = collection.name || '未命名分组';
        }
        const importedEntries = [];
        const stamp = Date.now();
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          const text = await readCharacterDocumentFile(file);
          const baseName = importDocumentBaseName(file.name);
          const result = importWorldBookFromDocumentText(text, {
            sourceName: baseName,
            itemName: baseName,
            collectionId: targetId,
            batchId: `${stamp}_${index}_${Math.random().toString(36).slice(2, 6)}`,
          });
          importedEntries.push(...result.entries);
        }
        await importWorldBookEntries(importedEntries);
        pendingImportFiles = [];
        showToast(files.length > 1
          ? `已将 ${files.length} 本导入到“${targetName}”`
          : `已导入到“${targetName}”`);
        await reload();
      } catch (err) {
        button.disabled = false;
        showToast(err?.message || '导入失败', 4000);
      }
    });

    container.querySelectorAll('[data-add-book]').forEach((btn) => {
      btn.addEventListener('click', () => {
        actionMenuOpen = false;
        const id = `wb_book_${Date.now()}`;
        openEditor(createWorldBookEntry({
          id,
          kind: 'group',
          isBookRoot: true,
          name: '',
          category: 'custom',
          position: 999,
        }));
      });
    });

    container.querySelectorAll('[data-add-collection]').forEach((btn) => {
      btn.addEventListener('click', () => {
        actionMenuOpen = false;
        openEditor(createWorldBookEntry({
          id: `wb_collection_${Date.now()}`,
          kind: 'group',
          isCollection: true,
          name: '',
          category: 'custom',
          position: 999,
        }));
      });
    });

    container.querySelectorAll('[data-add-group-book]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bookId = btn.getAttribute('data-add-group-book');
        openEditor(createWorldBookEntry({
          id: `wb_grp_${Date.now()}`,
          kind: 'group',
          name: '',
          bookId,
          parentGroupId: bookId,
          category: 'custom',
        }));
      });
    });

    container.querySelectorAll('[data-add-item-book]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bookId = btn.getAttribute('data-add-item-book');
        openEditor(createWorldBookEntry({ kind: 'item', bookId, category: 'custom' }));
      });
    });

    container.querySelectorAll('[data-add-item-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const groupId = btn.getAttribute('data-add-item-group');
        const bookId = btn.getAttribute('data-add-item-book');
        openEditor(createWorldBookEntry({ kind: 'item', bookId, groupId, category: 'custom' }));
      });
    });

    container.querySelectorAll('[data-close-sheet]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editing = null;
        paint();
      });
    });

    container.querySelector('[data-save-entry]')?.addEventListener('click', async () => {
      if (!editing) return;
      const name = String(container.querySelector('.wb-input-name')?.value || '').trim();
      if (!name) {
        showToast('请填写名称');
        return;
      }

      const persisted = isPersisted(editing);
      try {
        const kind = getEntryKind(editing);
        if (kind === 'item') {
          const category = String(container.querySelector('.wb-input-category')?.value || 'custom');
          const constant = !!container.querySelector('.wb-input-constant')?.checked;
          const selective = !!container.querySelector('.wb-input-selective')?.checked;
          const priority = String(container.querySelector('.wb-input-priority')?.value || 'normal');
          const keysRaw = String(container.querySelector('.wb-input-keys')?.value || '');
          const keys = keysRaw.split(/[,，]/).map((k) => k.trim()).filter(Boolean);
          const contentInput = container.querySelector('.wb-input-content');
          const content = contentInput ? String(contentInput.value || '') : String(editing.content || '');
          await saveWorldBookEntry({
            ...editing,
            name,
            category,
            constant,
            selective,
            priority,
            keys,
            content,
            kind: 'item',
          });
        } else if (kind === 'collection') {
          await saveWorldBookEntry({
            ...editing,
            name,
            kind: 'group',
            isCollection: true,
            isBookRoot: false,
          });
          collapsedSet.delete(editing.id);
        } else if (kind === 'book') {
          const rawScope = String(container.querySelector('.wb-input-scope')?.value || 'global');
          const scope = ['character', 'group'].includes(rawScope) ? rawScope : 'global';
          const characterIds = scope === 'character'
            ? [...container.querySelectorAll('[data-wb-character-id]:checked')]
              .map((el) => String(el.getAttribute('data-wb-character-id') || '').trim())
              .filter(Boolean)
            : [];
          let groupType = '';
          let groupRefId = '';
          if (scope === 'group') {
            const [type, ...rest] = String(container.querySelector('.wb-input-group')?.value || '').split(':');
            groupType = ['contact', 'relationship'].includes(type) ? type : '';
            groupRefId = rest.join(':');
            if (!groupType || !groupRefId) {
              showToast('请选择一个分组');
              return;
            }
          }
          await saveWorldBookEntry({
            ...editing,
            name,
            kind: 'group',
            isBookRoot: true,
            collectionId: String(container.querySelector('.wb-input-collection')?.value || '').trim(),
            scope,
            characterIds,
            groupType,
            groupRefId,
          });
          collapsedSet.delete(editing.id);
        } else {
          const targetBookId = String(container.querySelector('.wb-input-parent-book')?.value || '').trim();
          if (!targetBookId) {
            showToast('请选择所属世界书');
            return;
          }
          if (persisted) {
            await moveWorldBookGroup(editing.id, targetBookId, { name });
          } else {
            await saveWorldBookEntry({
              ...editing,
              name,
              kind: 'group',
              isBookRoot: false,
              bookId: targetBookId,
              groupId: targetBookId,
              parentGroupId: targetBookId,
            });
          }
          collapsedSet.delete(editing.id);
        }

        editing = null;
        showToast('已保存');
        await reload();
      } catch (error) {
        console.error('[worldbook] 保存失败', error);
        showToast(`保存失败：${error?.message || '请稍后重试'}`);
      }
    });

  }

  paint();
}
