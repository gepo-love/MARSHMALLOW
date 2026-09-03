import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { bindSwipeActions } from '../components/swipe-actions.js';
import { showToast } from '../components/toast.js';
import {
  loadPresetRecord,
  savePresetRecord,
  truncatePresetPreview,
  saveCollapsedPresetCategories,
  deletePresetBundle,
  deletePresetRecords,
  setPresetBundleMode,
  normalizePresetMode,
  createCustomPresetId,
  saveChatInjectList,
  listOnlineBuiltinPresets,
  listOfflineBuiltinPresets,
  listSocialSurfaceBuiltinPresets,
  loadPresetsPageSnapshot,
  invalidatePresetsPageSnapshot,
  toggleBuiltinPresetEnabled,
  importPresetFromDocumentText,
  saveOfflineThinkingOverride,
  clearOfflineThinkingOverride,
} from '../core/preset-store.js';
import { importDocumentBaseName, isImportDocumentFile, readCharacterDocumentFile } from '../core/character-document-read.js';
import {
  buildPresetPackage,
  preparePresetPackageImport,
  safePresetFilename,
} from '../core/preset-package.js';
import { describeDownloadResult, downloadJson } from '../core/native-download.js';
import { PROMPTS, PROMPT_CATEGORIES, OFFLINE_PRESET_GROUPS } from '../data/prompts.js';
import { shareToCommunityStore } from '../core/community-share-draft.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MODE_LABELS = { both: '通用', online: '线上', offline: '线下' };
const OFFLINE_THINKING_BUILTIN_ID = 'narrative_director_preflight';
const OFFLINE_THINKING_STARTER = [
  '1. 本轮只选一个主要叙事目的，说清要发生的具体变化。',
  '2. 核对在场人物的已知关系、当前情绪和行为边界。',
  '3. 只选当前视角人物会注意、且会影响动作或判断的一处细节。',
  '4. 检查时间线和上一轮动作，不重复、不跳转。',
  '5. 确认收尾留下一个可继续的动作、反应或未完成事。',
].join('\n');

/** 首次未保存折叠偏好时，三个内置大组默认收起，首屏只画标题行 */
const DEFAULT_COLLAPSED_KEYS = new Set([
  'builtin_online',
  'builtin_offline_style',
  'builtin_offline_function',
  'builtin_offline_model',
  'builtin_offline_check',
  'builtin_social',
]);

function modeSegHtml(active, attrs = '') {
  const m = normalizePresetMode(active);
  return `<div class="preset-mode-seg" ${attrs}>
    ${['both', 'online', 'offline'].map((id) =>
      `<button type="button" class="preset-mode-btn ${id === m ? 'is-active' : ''}" data-mode-val="${id}">${MODE_LABELS[id]}</button>`).join('')}
  </div>`;
}

function isDeletablePreset(id) {
  return id && !PROMPTS[id];
}

function renderPresetCard(preset, enabledSet, ctx = {}) {
  const { manageMode = false, selectedIds = new Set() } = ctx;
  const preview = preset.preview != null ? preset.preview : truncatePresetPreview(preset.content);
  const on = enabledSet instanceof Set ? enabledSet.has(preset.id) : false;
  const deletable = isDeletablePreset(preset.id);
  const selected = selectedIds.has(preset.id);
  const checkHtml = manageMode && deletable
    ? `<label class="wb-item-check" title="选择预设">
        <input type="checkbox" data-select-id="${esc(preset.id)}" ${selected ? 'checked' : ''} aria-label="选择 ${esc(preset.name || '预设')}" />
      </label>`
    : '';
  const titleAttrs = manageMode && deletable
    ? `data-select-toggle="${esc(preset.id)}"`
    : `data-edit-id="${esc(preset.id)}"`;
  const toggleHtml = manageMode
    ? ''
    : `<label class="wb-toggle" title="启用（注入对话）">
        <input type="checkbox" data-enable-id="${esc(preset.id)}" ${on ? 'checked' : ''} />
        <span class="wb-toggle-ui"></span>
      </label>`;
  const card = `
    <article class="preset-card scrapbook-card ${on ? '' : 'is-off'}${manageMode && deletable ? ' preset-card--manage' : ''}${selected ? ' is-selected' : ''}" data-preset-id="${esc(preset.id)}">
      ${checkHtml}
      <div class="preset-card-inner">
        <div class="preset-card-head">
          <button type="button" class="preset-card-title" ${titleAttrs}>${esc(preset.name || preset.id)}</button>
          ${toggleHtml}
        </div>
        <p class="preset-card-preview">${esc(preview)}</p>
      </div>
    </article>
  `;
  if (manageMode || !deletable) return card;
  return `
    <div class="library-swipe-row preset-swipe-row" data-swipe-row data-preset-id="${esc(preset.id)}">
      <div class="library-swipe-actions" data-swipe-actions>
        <button type="button" class="library-swipe-action is-danger" data-preset-delete="${esc(preset.id)}" aria-label="删除预设 ${esc(preset.name || preset.id)}">删除</button>
      </div>
      <div class="library-swipe-content" data-swipe-content>
        ${card}
      </div>
    </div>
  `;
}

/** 内置锁定卡片：只显示条目名 + 开关，不展示正文，也不可编辑。 */
function renderLockedBuiltinCard(preset, disabledSet, ctx = {}) {
  const { manageMode = false, offlineThinkingOverride = null } = ctx;
  const on = !(disabledSet instanceof Set && disabledSet.has(preset.id));
  const isThinking = preset.id === OFFLINE_THINKING_BUILTIN_ID;
  const toggleHtml = manageMode
    ? ''
    : `<label class="wb-toggle" title="启用（注入生成）">
        <input type="checkbox" data-toggle-builtin="${esc(preset.id)}" ${on ? 'checked' : ''} />
        <span class="wb-toggle-ui"></span>
      </label>`;
  return `
    <article class="preset-card preset-card--locked scrapbook-card ${on ? '' : 'is-off'}" data-preset-id="${esc(preset.id)}">
      <div class="preset-card-head">
        <span class="preset-card-title preset-card-title--static">
          <span>${esc(preset.name || preset.id)}</span>
          ${preset.badge ? `<small class="preset-card-badge">${esc(preset.badge)}</small>` : ''}
          ${isThinking && offlineThinkingOverride ? '<small class="preset-card-badge">自定义</small>' : ''}
        </span>
        ${isThinking && !manageMode ? `<button type="button" class="preset-thinking-edit" data-edit-offline-thinking>${offlineThinkingOverride ? '编辑' : '自定义'}</button>` : ''}
        ${toggleHtml}
      </div>
    </article>
  `;
}

function renderLockedBuiltinSection({
  key, title, hint, presets, disabledSet, collapsed = false, ctx = {},
}) {
  return `
    <section class="preset-category" data-category="${esc(key)}">
      <button type="button" class="preset-category-head scrapbook-card" data-collapse-cat="${esc(key)}" aria-expanded="${collapsed ? 'false' : 'true'}">
        <span class="preset-category-text">
          <strong>${esc(title)}</strong>
          <small>${esc(hint)} · ${presets.length} 条</small>
        </span>
        <span class="preset-chevron ${collapsed ? 'is-collapsed' : ''}">${icon('chevronDown')}</span>
      </button>
      <div class="preset-category-body" ${collapsed ? 'hidden' : ''}>
        ${collapsed ? '' : (presets.length ? presets.map((p) => renderLockedBuiltinCard(p, disabledSet, ctx)).join('') : '<div class="wb-empty-inline">暂无</div>')}
      </div>
    </section>
  `;
}

function renderCategorySection(category, presets, enabledSet, collapsed = false, ctx = {}) {
  const meta = PROMPT_CATEGORIES[category] || { label: category, icon: '📝', hint: '' };
  return `
    <section class="preset-category" data-category="${esc(category)}">
      <button type="button" class="preset-category-head scrapbook-card" data-collapse-cat="${esc(category)}" aria-expanded="${collapsed ? 'false' : 'true'}">
        <span class="preset-category-text">
          <strong>${esc(meta.label || category)}</strong>
          <small>${esc(meta.hint || '')} · ${presets.length} 条</small>
        </span>
        <span class="preset-chevron ${collapsed ? 'is-collapsed' : ''}">${icon('chevronDown')}</span>
      </button>
      <div class="preset-category-body" ${collapsed ? 'hidden' : ''}>
        ${collapsed ? '' : (presets.length ? presets.map((p) => renderPresetCard(p, enabledSet, ctx)).join('') : `
          <div class="wb-empty-inline">还没有预设</div>
        `)}
      </div>
    </section>
  `;
}

function renderCustomSection(bundles, standalone, enabledSet, collapsed = false, ctx = {}) {
  const { manageMode = false } = ctx;
  const meta = PROMPT_CATEGORIES.custom || { label: '自定义', icon: '📝', hint: '' };
  const total = standalone.length + bundles.reduce((s, b) => s + b.presets.length, 0);
  return `
    <section class="preset-category" data-category="custom">
      <button type="button" class="preset-category-head scrapbook-card" data-collapse-cat="custom" aria-expanded="${collapsed ? 'false' : 'true'}">
        <span class="preset-category-text">
          <strong>${esc(meta.label || '自定义')}</strong>
          <small>${esc(meta.hint || '')} · ${total} 条</small>
        </span>
        <span class="preset-chevron ${collapsed ? 'is-collapsed' : ''}">${icon('chevronDown')}</span>
      </button>
      <div class="preset-category-body" ${collapsed ? 'hidden' : ''}>
        ${collapsed ? '' : `${bundles.map((b) => `
          <div class="preset-bundle" data-bundle="${esc(b.id)}">
            ${manageMode ? `
              <div class="preset-bundle-head">
                <strong>${esc(b.name)}</strong>
                <span class="preset-bundle-count">${b.presets.length} 条</span>
              </div>
            ` : `
              <div class="library-swipe-row preset-bundle-swipe" data-swipe-row>
                <div class="library-swipe-actions" data-swipe-actions>
                  <button type="button" class="library-swipe-action is-danger" data-bundle-delete="${esc(b.id)}" aria-label="删除整组 ${esc(b.name)}">删除整组</button>
                </div>
                <div class="library-swipe-content" data-swipe-content>
                  <div class="preset-bundle-head">
                    <strong>${esc(b.name)}</strong>
                    <span class="preset-bundle-count">${b.presets.length} 条</span>
                    <button type="button" class="btn btn-sm btn-soft" data-bundle-export="${esc(b.id)}">导出</button>
                    <button type="button" class="btn btn-sm btn-outline" data-bundle-share="${esc(b.id)}" title="分享到应用商店">分享</button>
                  </div>
                </div>
              </div>
            `}
            ${manageMode ? '' : `<div class="preset-bundle-mode">
              <span class="preset-bundle-mode-label">整组生效于</span>
              ${modeSegHtml(b.mode, `data-bundle-mode="${esc(b.id)}"`)}
            </div>`}
            ${b.presets.map((p) => renderPresetCard(p, enabledSet, ctx)).join('')}
          </div>
        `).join('')}${standalone.map((p) => renderPresetCard(p, enabledSet, ctx)).join('')}${total ? '' : '<div class="wb-empty-inline">还没有预设</div>'}
        ${manageMode ? '' : '<button type="button" class="btn btn-sm btn-soft preset-add-custom">+ 自定义预设</button>'}`}
      </div>
    </section>
  `;
}

function listManageablePresets(grouped, customBundles, customStandalone) {
  const ids = [];
  Object.values(grouped || {}).forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((p) => {
      if (isDeletablePreset(p.id)) ids.push(p.id);
    });
  });
  (customBundles || []).forEach((b) => {
    (b.presets || []).forEach((p) => {
      if (isDeletablePreset(p.id)) ids.push(p.id);
    });
  });
  (customStandalone || []).forEach((p) => {
    if (isDeletablePreset(p.id)) ids.push(p.id);
  });
  return ids;
}

function renderPresetManageBar(selectedCount = 0) {
  return `
    <div class="wb-manage-bar is-visible" role="toolbar" aria-label="批量管理预设">
      <div class="wb-manage-meta">
        <span class="wb-manage-count">已选 ${selectedCount} 条</span>
        <button type="button" class="btn btn-xs btn-soft" data-select-all-presets>全选</button>
        <button type="button" class="btn btn-xs btn-soft" data-clear-selection ${selectedCount ? '' : 'disabled'}>清空</button>
      </div>
      <div class="wb-manage-actions">
        <button type="button" class="btn btn-sm is-danger" data-batch-delete ${selectedCount ? '' : 'disabled'}>删除${selectedCount ? ` (${selectedCount})` : ''}</button>
      </div>
    </div>
  `;
}

export default async function render(container) {
  container.className = 'page scrapbook-page presets-page';

  function paintShell() {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">预设</h1>
        <div class="wb-navbar-actions">
          <button type="button" class="navbar-btn" data-add-custom aria-label="新建" disabled>${icon('plus')}</button>
        </div>
      </header>
      <main class="preset-scroll scrapbook-scroll preset-scroll--loading" aria-busy="true"></main>`;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
  }

  paintShell();
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  const snapshot = await loadPresetsPageSnapshot();
  let grouped = snapshot.grouped;
  let custom = snapshot.custom;
  let collapsedSet = snapshot.collapsedSet;
  let collapsedPrefsInitialized = snapshot.collapsedPrefsInitialized === true;
  let enabledSet = snapshot.enabledSet;
  let disabledBuiltinSet = snapshot.disabledBuiltinSet;
  let offlineThinkingOverride = snapshot.offlineThinkingOverride;
  let editing = null;
  let manageMode = false;
  let selectedIds = new Set();
  let unbindSwipe = () => {};
  const onlineBuiltins = listOnlineBuiltinPresets();
  const offlineBuiltins = listOfflineBuiltinPresets();
  const socialBuiltins = listSocialSurfaceBuiltinPresets();
  const offlineBuiltinGroups = Object.entries(OFFLINE_PRESET_GROUPS).map(([id, meta]) => ({
    id,
    ...meta,
    presets: offlineBuiltins
      .filter((preset) => preset.offlineGroup === id)
      .sort((a, b) => Number(a.offlineOrder || 999) - Number(b.offlineOrder || 999)),
  }));

  const categoryOrder = ['chat', 'style', 'narrative', 'relationship', 'social', 'custom'];

  function isCategoryCollapsed(key) {
    if (collapsedSet.has(key)) return true;
    if (!collapsedPrefsInitialized && DEFAULT_COLLAPSED_KEYS.has(key)) return true;
    return false;
  }

  async function reload() {
    invalidatePresetsPageSnapshot();
    const next = await loadPresetsPageSnapshot();
    grouped = next.grouped;
    custom = next.custom;
    enabledSet = next.enabledSet;
    disabledBuiltinSet = next.disabledBuiltinSet;
    offlineThinkingOverride = next.offlineThinkingOverride;
    collapsedSet = next.collapsedSet;
    collapsedPrefsInitialized = next.collapsedPrefsInitialized === true;
    paint();
  }

  function paint() {
    unbindSwipe();
    unbindSwipe = () => {};
    const prevScrollTop = container.querySelector('.preset-scroll')?.scrollTop || 0;
    const visibleGrouped = {};
    Object.entries(grouped || {}).forEach(([cat, list]) => {
      visibleGrouped[cat] = (Array.isArray(list) ? list : []).filter((p) => !PROMPTS[p.id]);
    });
    const manageCtx = { manageMode, selectedIds, offlineThinkingOverride };
    const selectedCount = selectedIds.size;
    const editingThinking = editing?.editorKind === 'offlineThinking';
    const editingPersisted = !editingThinking && !!editing?.id
      && listManageablePresets(visibleGrouped, custom.bundles, custom.standalone).includes(editing.id);
    const sections = [
      renderLockedBuiltinSection({
        key: 'builtin_online',
        title: '线上聊天',
        hint: '用于线上聊天',
        presets: onlineBuiltins,
        disabledSet: disabledBuiltinSet,
        collapsed: isCategoryCollapsed('builtin_online'),
        ctx: manageCtx,
      }),
      ...offlineBuiltinGroups
        .filter((group) => group.presets.length)
        .map((group) => renderLockedBuiltinSection({
          key: `builtin_offline_${group.id}`,
          title: group.label,
          hint: group.hint,
          presets: group.presets,
          disabledSet: disabledBuiltinSet,
          collapsed: isCategoryCollapsed(`builtin_offline_${group.id}`),
          ctx: manageCtx,
        })),
      renderLockedBuiltinSection({
        key: 'builtin_social',
        title: '社交媒体',
        hint: '用于对应社交页面',
        presets: socialBuiltins,
        disabledSet: disabledBuiltinSet,
        collapsed: isCategoryCollapsed('builtin_social'),
        ctx: manageCtx,
      }),
      ...categoryOrder
        .filter((cat) => cat === 'custom' || visibleGrouped[cat]?.length)
        .map((cat) => (cat === 'custom'
          ? renderCustomSection(custom.bundles, custom.standalone, enabledSet, isCategoryCollapsed('custom'), manageCtx)
          : renderCategorySection(cat, visibleGrouped[cat] || [], enabledSet, isCategoryCollapsed(cat), manageCtx))),
    ].join('');

    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${manageMode ? '管理预设' : '预设'}</h1>
        <div class="wb-navbar-actions">
          ${manageMode ? `
            <button type="button" class="navbar-btn wb-manage-done" data-manage-done>完成</button>
          ` : `
            <input type="file" class="preset-import-input" accept=".json,application/json,.txt,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden />
            <button type="button" class="navbar-btn" data-manage aria-label="批量管理">管理</button>
            <button type="button" class="navbar-btn" data-import-preset aria-label="导入">${icon('folder')}</button>
            <button type="button" class="navbar-btn" data-add-custom aria-label="新建">${icon('plus')}</button>
          `}
        </div>
      </header>
      <main class="preset-scroll scrapbook-scroll${manageMode ? ' has-manage-bar' : ''}">
        ${sections}
      </main>
      ${manageMode ? renderPresetManageBar(selectedCount) : ''}
      <aside class="wb-sheet preset-sheet ${editing ? 'is-open' : ''}" aria-hidden="${editing ? 'false' : 'true'}">
        <div class="wb-sheet-backdrop" data-close-sheet></div>
        <div class="wb-sheet-panel scrapbook-card">
          <header class="wb-sheet-head">
            <h2>${editingThinking ? '自定义线下思维链' : (editingPersisted ? '编辑预设' : '新建预设')}</h2>
            <button type="button" class="navbar-btn" data-close-sheet aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="wb-sheet-body">
            ${editingThinking ? `
            <div class="preset-thinking-track" aria-label="生成格式">
              <span>逐项推演</span><i aria-hidden="true"></i><span>完整正文</span>
            </div>
            <details class="preset-thinking-guide">
              <summary>怎么写更稳</summary>
              <div>一行写一个“检查动作”，按真实顺序排列；说清要判断什么，不要在模板里预写某一轮的答案。保存时会自动补齐推演边界、逐项执行和“推演后必须输出正文”约束。</div>
            </details>
            <label class="wb-field preset-thinking-field">
              <span>推演步骤</span>
              <textarea class="form-input preset-thinking-steps" rows="12" maxlength="6000" placeholder="1. 先检查……\n2. 再判断……\n3. 最后确认……">${esc(editing?.steps || '')}</textarea>
            </label>
            ` : `
            <label class="wb-field">
              <span>名称</span>
              <input type="text" class="form-input preset-input-name" value="${esc(editing?.name || '')}" maxlength="48" />
            </label>
            <label class="wb-field">
              <span>分类</span>
              <select class="form-input preset-input-category">
                ${Object.entries(PROMPT_CATEGORIES).map(([id, meta]) => `
                  <option value="${esc(id)}" ${editing?.category === id ? 'selected' : ''}>${esc(meta.label)}</option>
                `).join('')}
              </select>
            </label>
            <label class="wb-field">
              <span>生效模式</span>
              ${modeSegHtml(editing?.mode, 'data-edit-mode')}
            </label>
            <label class="wb-field">
              <span>正文</span>
              <textarea class="form-input preset-input-content" rows="12">${esc(editing?.content || '')}</textarea>
            </label>
            `}
          </div>
          <footer class="wb-sheet-foot">
            ${editingThinking && offlineThinkingOverride ? '<button type="button" class="btn btn-outline" data-reset-offline-thinking>恢复内置</button>' : (editingPersisted ? '<button type="button" class="btn btn-outline" data-copy-preset>复制条目</button>' : '')}
            ${!editingThinking && editingPersisted ? '<button type="button" class="btn btn-outline" data-export-preset>导出文件</button><button type="button" class="btn btn-soft" data-share-preset title="分享到应用商店">分享</button>' : ''}
            <button type="button" class="btn btn-primary" ${editingThinking ? 'data-save-offline-thinking' : 'data-save-preset'}>${editingThinking ? '保存并启用' : '保存'}</button>
          </footer>
        </div>
      </aside>
    `;

    bindEvents();
    if (!manageMode) {
      unbindSwipe = bindSwipeActions(container.querySelector('.preset-scroll'));
    }
    const scrollEl = container.querySelector('.preset-scroll');
    if (scrollEl && prevScrollTop) {
      const restoreScrollTop = () => {
        if (!scrollEl.isConnected) return;
        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        scrollEl.scrollTop = Math.min(prevScrollTop, maxScrollTop);
      };
      restoreScrollTop();
      // iOS 在折叠后要等一帧才会提交新的 scrollHeight；再次钳制可避免
      // 旧的越界 scrollTop 把新滚动区卡在不可拖动状态。
      requestAnimationFrame(restoreScrollTop);
    }
    if (editing) {
      window.setTimeout(() => {
        const firstInput = container.querySelector(editingThinking ? '.preset-thinking-steps' : '.preset-input-name');
        if (!firstInput?.isConnected) return;
        try { firstInput.focus({ preventScroll: true }); } catch (_) {
          try { firstInput.focus(); } catch (__) {}
        }
      }, 220);
    }
  }

  function openEditor(preset) {
    editing = preset ? { ...preset } : {
      id: createCustomPresetId(),
      name: '',
      category: 'custom',
      content: '',
    };
    paint();
  }

  function openOfflineThinkingEditor() {
    editing = {
      editorKind: 'offlineThinking',
      steps: offlineThinkingOverride?.steps || OFFLINE_THINKING_STARTER,
    };
    paint();
  }

  function toggleSelection(id, force) {
    if (!isDeletablePreset(id)) return;
    if (force === true) selectedIds.add(id);
    else if (force === false) selectedIds.delete(id);
    else if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    paint();
  }

  async function batchDeleteSelected() {
    const ids = [...selectedIds];
    if (!ids.length) {
      showToast('请先选择预设');
      return;
    }
    if (!window.confirm(`确定删除选中的 ${ids.length} 条预设？此操作不可恢复。`)) return;
    const n = await deletePresetRecords(ids);
    selectedIds.clear();
    showToast(`已删除 ${n} 条`);
    await reload();
  }

  function bindEvents() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());

    container.querySelector('[data-manage]')?.addEventListener('click', () => {
      manageMode = true;
      selectedIds = new Set();
      editing = null;
      paint();
    });
    container.querySelector('[data-manage-done]')?.addEventListener('click', () => {
      manageMode = false;
      selectedIds.clear();
      paint();
    });

    container.querySelector('[data-select-all-presets]')?.addEventListener('click', () => {
      const visibleGrouped = {};
      Object.entries(grouped || {}).forEach(([cat, list]) => {
        visibleGrouped[cat] = (Array.isArray(list) ? list : []).filter((p) => !PROMPTS[p.id]);
      });
      listManageablePresets(visibleGrouped, custom.bundles, custom.standalone).forEach((id) => selectedIds.add(id));
      paint();
    });
    container.querySelector('[data-clear-selection]')?.addEventListener('click', () => {
      selectedIds.clear();
      paint();
    });
    container.querySelector('[data-batch-delete]')?.addEventListener('click', () => {
      batchDeleteSelected().catch((err) => showToast(err?.message || '删除失败', 4000));
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

    container.querySelectorAll('[data-collapse-cat]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cat = btn.getAttribute('data-collapse-cat');
        const wasCollapsed = isCategoryCollapsed(cat);
        if (!collapsedPrefsInitialized) {
          collapsedSet = new Set(DEFAULT_COLLAPSED_KEYS);
          collapsedPrefsInitialized = true;
        }
        if (wasCollapsed) collapsedSet.delete(cat);
        else collapsedSet.add(cat);
        await saveCollapsedPresetCategories([...collapsedSet]);
        paint();
      });
    });

    container.querySelectorAll('[data-edit-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (manageMode) return;
        const id = btn.getAttribute('data-edit-id');
        if (PROMPTS[id]) {
          showToast('内置内容不可编辑');
          return;
        }
        const rec = await loadPresetRecord(id);
        if (rec) openEditor(rec);
      });
    });

    container.querySelector('[data-edit-offline-thinking]')?.addEventListener('click', openOfflineThinkingEditor);

    container.querySelectorAll('[data-bundle-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('删除这整组导入的预设？')) return;
        const n = await deletePresetBundle(btn.getAttribute('data-bundle-delete'));
        showToast(`已删除 ${n} 条`);
        await reload();
      });
    });

    container.querySelectorAll('[data-bundle-export]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const bundleId = btn.getAttribute('data-bundle-export');
        const bundle = custom.bundles.find((item) => item.id === bundleId);
        if (!bundle) return;
        try {
          const records = (await Promise.all(bundle.presets.map((preset) => loadPresetRecord(preset.id)))).filter(Boolean);
          const pkg = buildPresetPackage(records, { kind: 'bundle', name: bundle.name });
          const result = await downloadJson(pkg, safePresetFilename(pkg.name));
          showToast(describeDownloadResult(result));
        } catch (err) {
          showToast(err?.message || '导出失败', 4000);
        }
      });
    });
    container.querySelectorAll('[data-bundle-share]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const bundle = custom.bundles.find((item) => item.id === btn.getAttribute('data-bundle-share'));
        if (!bundle) return;
        try {
          const records = (await Promise.all(bundle.presets.map((preset) => loadPresetRecord(preset.id)))).filter(Boolean);
          const pkg = buildPresetPackage(records, { kind: 'bundle', name: bundle.name });
          shareToCommunityStore({ source: pkg, fileName: safePresetFilename(pkg.name), resourceType: 'preset', title: pkg.name, originLabel: '预设分组' });
        } catch (err) {
          showToast(err?.message || '无法分享', 4000);
        }
      });
    });

    container.querySelectorAll('[data-preset-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-preset-delete');
        if (!isDeletablePreset(id)) return;
        if (!window.confirm('确定删除该预设？此操作不可恢复。')) return;
        const n = await deletePresetRecords([id]);
        showToast(n ? '已删除' : '未找到该预设');
        await reload();
      });
    });

    container.querySelectorAll('[data-enable-id]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-enable-id');
        if (input.checked) enabledSet.add(id); else enabledSet.delete(id);
        await saveChatInjectList([...enabledSet]);
        input.closest('.preset-card')?.classList.toggle('is-off', !input.checked);
      });
    });

    container.querySelectorAll('[data-toggle-builtin]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-toggle-builtin');
        disabledBuiltinSet = await toggleBuiltinPresetEnabled(id, input.checked);
        input.closest('.preset-card')?.classList.toggle('is-off', !input.checked);
      });
    });

    container.querySelectorAll('[data-bundle-mode] .preset-mode-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const seg = btn.closest('[data-bundle-mode]');
        const bundleId = seg?.getAttribute('data-bundle-mode');
        await setPresetBundleMode(bundleId, btn.getAttribute('data-mode-val'));
        showToast(`整组已设为「${btn.textContent}」`);
        await reload();
      });
    });

    container.querySelectorAll('[data-edit-mode] .preset-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const seg = btn.closest('[data-edit-mode]');
        seg?.querySelectorAll('.preset-mode-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
        if (editing) editing.mode = btn.getAttribute('data-mode-val');
      });
    });

    container.querySelectorAll('[data-add-custom], .preset-add-custom').forEach((btn) => {
      btn.addEventListener('click', () => openEditor(null));
    });

    const presetImportInput = container.querySelector('.preset-import-input');
    container.querySelector('[data-import-preset]')?.addEventListener('click', () => {
      presetImportInput?.click();
    });
    presetImportInput?.addEventListener('change', async () => {
      const file = presetImportInput.files?.[0];
      if (!file) return;
      try {
        if (/\.json$/i.test(file.name || '')) {
          const prepared = preparePresetPackageImport(JSON.parse(await file.text()));
          for (const record of prepared.presets) await savePresetRecord(record);
          showToast(prepared.kind === 'bundle'
            ? `已导入「${prepared.name}」· ${prepared.presets.length} 条`
            : `已导入「${prepared.name}」`);
          await reload();
          return;
        }
        if (!isImportDocumentFile(file)) {
          throw new Error('预设支持 JSON、TXT 或 DOCX 文件');
        }
        const baseName = importDocumentBaseName(file.name);
        const text = await readCharacterDocumentFile(file);
        const result = await importPresetFromDocumentText(text, { name: baseName, itemName: baseName });
        showToast(`已导入「${result.bundleName}」· ${result.imported} 条`);
        await reload();
      } catch (err) {
        showToast(err?.message || '导入失败', 4000);
      } finally {
        presetImportInput.value = '';
      }
    });

    container.querySelectorAll('[data-close-sheet]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editing = null;
        paint();
      });
    });

    container.querySelector('[data-copy-preset]')?.addEventListener('click', () => {
      if (!editing) return;
      editing = {
        ...editing,
        id: createCustomPresetId(),
        name: `${editing.name || '未命名'}（副本）`,
        bundleId: '',
        bundleName: '',
      };
      paint();
    });

    container.querySelector('[data-export-preset]')?.addEventListener('click', async () => {
      if (!editing?.id) return;
      try {
        const record = await loadPresetRecord(editing.id);
        if (!record || PROMPTS[record.id]) throw new Error('请先保存这条自定义预设');
        const pkg = buildPresetPackage([record], { kind: 'preset', name: record.name });
        const result = await downloadJson(pkg, safePresetFilename(pkg.name));
        showToast(describeDownloadResult(result));
      } catch (err) {
        showToast(err?.message || '导出失败', 4000);
      }
    });
    container.querySelector('[data-share-preset]')?.addEventListener('click', async () => {
      if (!editing?.id) return;
      try {
        const record = await loadPresetRecord(editing.id);
        if (!record || PROMPTS[record.id]) throw new Error('请先保存这条自定义预设');
        const pkg = buildPresetPackage([record], { kind: 'preset', name: record.name });
        shareToCommunityStore({ source: pkg, fileName: safePresetFilename(pkg.name), resourceType: 'preset', title: pkg.name, originLabel: '预设' });
      } catch (err) {
        showToast(err?.message || '无法分享', 4000);
      }
    });

    container.querySelector('[data-save-preset]')?.addEventListener('click', async () => {
      if (!editing) return;
      const name = String(container.querySelector('.preset-input-name')?.value || '').trim();
      const category = String(container.querySelector('.preset-input-category')?.value || 'custom');
      const content = String(container.querySelector('.preset-input-content')?.value || '').trim();
      if (!name || !content) {
        showToast('请填写名称和正文');
        return;
      }
      const modeBtn = container.querySelector('[data-edit-mode] .preset-mode-btn.is-active');
      const mode = normalizePresetMode(modeBtn?.getAttribute('data-mode-val') || editing.mode);
      await savePresetRecord({ ...editing, name, category, content, mode });
      editing = null;
      showToast('已保存');
      await reload();
    });

    container.querySelector('[data-save-offline-thinking]')?.addEventListener('click', async () => {
      const steps = String(container.querySelector('.preset-thinking-steps')?.value || '').trim();
      try {
        await saveOfflineThinkingOverride(steps);
        disabledBuiltinSet = await toggleBuiltinPresetEnabled(OFFLINE_THINKING_BUILTIN_ID, true);
        editing = null;
        showToast('自定义线下思维链已启用');
        await reload();
      } catch (err) {
        showToast(err?.message || '保存失败', 4000);
      }
    });

    container.querySelector('[data-reset-offline-thinking]')?.addEventListener('click', async () => {
      await clearOfflineThinkingOverride();
      editing = null;
      showToast('已恢复内置思维链');
      await reload();
    });
  }

  paint();

  // Keep-Alive 恢复时 DOM 与内存状态已是最新，无需整页 reload
}
