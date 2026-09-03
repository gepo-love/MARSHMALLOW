import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { AU_PRESETS } from '../data/au-presets.js';
import {
  AU_CATEGORY_ORDER,
  createAuEntry,
  loadAuConfigForUser,
  getSelectedAuScheme,
  getActiveAUEntriesFromConfig,
  saveAuConfigForUser,
  deleteAuScheme,
} from '../core/au-config.js';

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(s) {
  return esc(s);
}

let uiState = {
  category: AU_CATEGORY_ORDER[0],
  editingId: '',
};

let auManageMode = false;
let auSelectedIds = new Set();

function openModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {} };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet modal-sheet-tall" role="dialog" aria-modal="true" data-modal-sheet>
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

function buildSchemeList(config) {
  return (config.schemes || []).map((scheme) => {
    const selected = scheme.id === config.selectedSchemeId;
    return `
      <button type="button" class="au-scheme-card ${selected ? 'is-selected' : ''}" data-scheme-id="${escAttr(scheme.id)}">
        <strong>${esc(scheme.name)}</strong>
        <span class="text-hint">${scheme.entryIds.length} 条启用</span>
        ${selected ? '<span class="au-scheme-badge">当前</span>' : ''}
      </button>`;
  }).join('');
}

function buildCategoryNav(config, selectedScheme) {
  return AU_CATEGORY_ORDER.map((category) => {
    const count = config.entries.filter(
      (entry) => selectedScheme?.entryIds?.includes(entry.id) && entry.category === category,
    ).length;
    return `
      <button type="button" class="au-subview-tab ${category === uiState.category ? 'is-active' : ''}" data-category="${escAttr(category)}">
        ${esc(category)} <span class="text-hint">${count}</span>
      </button>`;
  }).join('');
}

function buildEntryList(config, selectedScheme, ctx = {}) {
  const { manageMode = false, selectedIds = new Set() } = ctx;
  const entries = config.entries
    .filter((entry) => entry.category === uiState.category)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));

  if (!entries.length) {
    return '<p class="text-hint au-empty-hint">该分类下暂无条目。可从下方「内置模板」添加，或新建自定义条目。</p>';
  }

  return entries.map((entry) => {
    const active = selectedScheme?.entryIds?.includes(entry.id);
    const isCustom = entry.kind !== 'preset';
    const selected = selectedIds.has(entry.id);

    if (manageMode && isCustom) {
      return `
        <div class="au-entry-row au-entry-row--manage scrapbook-list-item${selected ? ' is-selected' : ''}" data-entry-id="${escAttr(entry.id)}">
          <label class="wb-item-check" title="选择条目">
            <input type="checkbox" data-select-id="${escAttr(entry.id)}" ${selected ? 'checked' : ''} aria-label="选择 ${esc(entry.name)}" />
          </label>
          <button type="button" class="au-entry-body" data-select-toggle="${escAttr(entry.id)}">
            <span class="au-entry-title">
              <strong>${esc(entry.name)}</strong>
              ${entry.strongOverride ? '<span class="au-chip is-strong">强覆盖</span>' : ''}
              <span class="au-chip">自定义</span>
            </span>
            <span class="text-hint au-entry-preview">${esc((entry.content || '无内容').slice(0, 180))}</span>
          </button>
        </div>`;
    }

    if (manageMode) {
      return `
        <div class="au-entry-row au-entry-row--readonly scrapbook-list-item" data-entry-id="${escAttr(entry.id)}">
          <span class="au-entry-body">
            <span class="au-entry-title">
              <strong>${esc(entry.name)}</strong>
              ${entry.strongOverride ? '<span class="au-chip is-strong">强覆盖</span>' : ''}
              <span class="au-chip">内置</span>
            </span>
            <span class="text-hint au-entry-preview">${esc((entry.content || '无内容').slice(0, 180))}</span>
          </span>
        </div>`;
    }

    return `
      <label class="au-entry-row scrapbook-list-item">
        <input type="checkbox" class="au-entry-toggle" value="${escAttr(entry.id)}" ${active ? 'checked' : ''} />
        <span class="au-entry-body">
          <span class="au-entry-title">
            <strong>${esc(entry.name)}</strong>
            ${entry.strongOverride ? '<span class="au-chip is-strong">强覆盖</span>' : ''}
            <span class="au-chip">${entry.kind === 'preset' ? '内置' : '自定义'}</span>
          </span>
          <span class="text-hint au-entry-preview">${esc((entry.content || '无内容').slice(0, 180))}</span>
          ${entry.kind !== 'preset' ? `<button type="button" class="btn btn-soft btn-sm au-entry-edit" data-entry-id="${escAttr(entry.id)}">编辑</button>` : ''}
        </span>
      </label>`;
  }).join('');
}

function listManageableAuEntries(config) {
  return (config.entries || []).filter((entry) => entry.kind !== 'preset');
}

function renderAuManageBar(selectedCount = 0) {
  return `
    <div class="wb-manage-bar is-visible" role="toolbar" aria-label="批量管理自定义设定">
      <div class="wb-manage-meta">
        <span class="wb-manage-count">已选 ${selectedCount} 条</span>
        <button type="button" class="btn btn-xs btn-soft" data-select-all-entries>全选</button>
        <button type="button" class="btn btn-xs btn-soft" data-clear-selection ${selectedCount ? '' : 'disabled'}>清空</button>
      </div>
      <div class="wb-manage-actions">
        <button type="button" class="btn btn-sm is-danger" data-batch-delete ${selectedCount ? '' : 'disabled'}>删除${selectedCount ? ` (${selectedCount})` : ''}</button>
      </div>
    </div>
  `;
}

function buildPresetGallery(config) {
  return AU_PRESETS.map((preset) => {
    const entryId = `preset_${preset.id}`;
    const exists = config.entries.some((entry) => entry.id === entryId);
    return `
      <button type="button" class="au-preset-chip" data-preset-id="${escAttr(preset.id)}" ${exists ? 'disabled' : ''}>
        <span class="au-preset-icon">${esc(preset.icon || '✦')}</span>
        <span class="au-preset-name">${esc(preset.name)}</span>
      </button>`;
  }).join('');
}

function readEntryForm(root, existingEntry) {
  const name = String(root.querySelector('.au-form-name')?.value || '').trim();
  if (!name) {
    showToast('请填写条目名称');
    return null;
  }
  return createAuEntry({
    ...(existingEntry || {}),
    name,
    category: String(root.querySelector('.au-form-category')?.value || '补充设定'),
    content: String(root.querySelector('.au-form-content')?.value || '').trim(),
    strongOverride: true,
    kind: existingEntry?.kind === 'preset' ? 'preset' : 'custom',
  });
}

function openEntryEditor(entry, onSave) {
  const current = entry || createAuEntry({ category: uiState.category });
  const { close, root } = openModal(`
    <div class="modal-header">
      <h3>${entry ? '编辑条目' : '新建自定义条目'}</h3>
      <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">${icon('close')}</button>
    </div>
    <div class="modal-body">
      <label class="form-label">条目名称</label>
      <input class="form-input au-form-name" value="${escAttr(current.name === '未命名设定' ? '' : current.name)}" placeholder="例如：现代校园日常" />
      <label class="form-label" style="margin-top:10px;">分类</label>
      <select class="form-input au-form-category">
        ${AU_CATEGORY_ORDER.map((item) => `<option value="${escAttr(item)}" ${item === current.category ? 'selected' : ''}>${esc(item)}</option>`).join('')}
      </select>
      <label class="form-label" style="margin-top:10px;">正文</label>
      <textarea class="form-input au-form-content" rows="10" placeholder="写架空背景、附加规则、关系前提等…">${esc(current.content || '')}</textarea>
      <button type="button" class="btn btn-primary au-form-save" style="margin-top:14px;width:100%;">保存</button>
      ${entry && entry.kind !== 'preset' ? '<button type="button" class="btn btn-outline au-form-delete" style="margin-top:8px;width:100%;">删除条目</button>' : ''}
    </div>
  `);

  root.querySelector('.modal-close-btn')?.addEventListener('click', close);
  root.querySelector('.au-form-save')?.addEventListener('click', () => {
    const next = readEntryForm(root, current);
    if (!next) return;
    onSave(next);
    close();
  });
  root.querySelector('.au-form-delete')?.addEventListener('click', () => {
    if (!entry || !window.confirm('确定删除这条自定义设定？')) return;
    onSave(null);
    close();
  });
}

export default async function render(container) {
  let user = await ensureDefaultUser();
  let config = await loadAuConfigForUser(user);
  const selectedScheme = getSelectedAuScheme(config);
  const activeEntries = getActiveAUEntriesFromConfig(config);
  const strong = activeEntries.some((entry) => entry.strongOverride === true);

  const manageCtx = { manageMode: auManageMode, selectedIds: auSelectedIds };
  const selectedCount = auSelectedIds.size;
  const prevScrollTop = container.querySelector('.au-panel-scroll')?.scrollTop || 0;

  container.className = 'page scrapbook-page au-panel-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn au-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${auManageMode ? '管理设定' : '特殊设定'}</h1>
      <div class="wb-navbar-actions">
        ${auManageMode ? `
          <button type="button" class="navbar-btn wb-manage-done" data-manage-done>完成</button>
        ` : `
          <button type="button" class="navbar-btn" data-manage aria-label="批量管理">管理</button>
        `}
      </div>
    </header>
    <main class="scrapbook-scroll au-panel-scroll${auManageMode ? ' has-manage-bar' : ''}">
      ${auManageMode ? '' : `<section class="scrapbook-hero au-hero">
        <span class="scrapbook-tape tape-orange" aria-hidden="true"></span>
        <h2>架空 / 附加设定</h2>
        <p>勾选条目组成「方案」，用于聊天与社交生成时的附加设定。不含势力分配或角色映射，自由文本为主。</p>
        <p class="text-hint" style="margin-top:8px;">当前方案：${esc(selectedScheme?.name || '—')} · 启用 ${activeEntries.length} 条${strong ? ' · 含强覆盖条目' : ''}</p>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">方案</div>
        <div class="au-scheme-list">${buildSchemeList(config)}</div>
        <div class="au-scheme-actions">
          <input type="text" class="form-input au-scheme-name" value="${escAttr(selectedScheme?.name || '')}" placeholder="方案名称" />
          <button type="button" class="btn btn-outline btn-sm au-scheme-new">新建</button>
          <button type="button" class="btn btn-primary btn-sm au-scheme-save">保存名称</button>
          <button type="button" class="btn btn-outline btn-sm au-scheme-delete is-danger" ${config.schemes.length <= 1 ? 'disabled' : ''}>删除</button>
        </div>
      </section>`}

      <section class="settings-group">
        <div class="settings-group-title">分类条目</div>
        <div class="au-subview-tabs">${buildCategoryNav(config, selectedScheme)}</div>
        <div class="au-entry-list">${buildEntryList(config, selectedScheme, manageCtx)}</div>
        ${auManageMode ? '' : '<button type="button" class="btn btn-outline btn-sm au-entry-new" style="margin-top:10px;">+ 新建自定义条目</button>'}
      </section>

      ${auManageMode ? '' : `<section class="settings-group">
        <div class="settings-group-title">内置模板</div>
        <p class="text-hint" style="margin-bottom:10px;line-height:1.5;">点击添加到条目库（已添加的会置灰）。添加后在上方分类里勾选启用。</p>
        <div class="au-preset-gallery">${buildPresetGallery(config)}</div>
      </section>`}
    </main>
    ${auManageMode ? renderAuManageBar(selectedCount) : ''}
  `;

  async function persist(nextConfig) {
    config = await saveAuConfigForUser(user, nextConfig);
    showToast('已保存');
    await render(container);
  }

  function toggleAuSelection(id, force) {
    const entry = config.entries.find((item) => item.id === id);
    if (!entry || entry.kind === 'preset') return;
    if (force === true) auSelectedIds.add(id);
    else if (force === false) auSelectedIds.delete(id);
    else if (auSelectedIds.has(id)) auSelectedIds.delete(id);
    else auSelectedIds.add(id);
    render(container);
  }

  async function batchDeleteSelected() {
    const ids = [...auSelectedIds];
    if (!ids.length) {
      showToast('请先选择条目');
      return;
    }
    if (!window.confirm(`确定删除选中的 ${ids.length} 条自定义设定？此操作不可恢复。`)) return;
    const idSet = new Set(ids);
    config.entries = config.entries.filter((item) => !idSet.has(item.id));
    config.schemes.forEach((scheme) => {
      scheme.entryIds = scheme.entryIds.filter((id) => !idSet.has(id));
    });
    config.activeEntryIds = config.activeEntryIds.filter((id) => !idSet.has(id));
    auSelectedIds.clear();
    await persist(config);
  }

  container.querySelector('.au-back')?.addEventListener('click', () => back());

  container.querySelector('[data-manage]')?.addEventListener('click', () => {
    auManageMode = true;
    auSelectedIds = new Set();
    render(container);
  });
  container.querySelector('[data-manage-done]')?.addEventListener('click', () => {
    auManageMode = false;
    auSelectedIds.clear();
    render(container);
  });

  container.querySelector('[data-select-all-entries]')?.addEventListener('click', () => {
    listManageableAuEntries(config).forEach((entry) => auSelectedIds.add(entry.id));
    render(container);
  });
  container.querySelector('[data-clear-selection]')?.addEventListener('click', () => {
    auSelectedIds.clear();
    render(container);
  });
  container.querySelector('[data-batch-delete]')?.addEventListener('click', () => {
    batchDeleteSelected().catch((err) => showToast(err?.message || '删除失败', 4000));
  });

  container.querySelectorAll('[data-select-id]').forEach((input) => {
    input.addEventListener('change', () => {
      toggleAuSelection(input.getAttribute('data-select-id'), input.checked);
    });
  });
  container.querySelectorAll('[data-select-toggle]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      toggleAuSelection(btn.getAttribute('data-select-toggle'));
    });
  });

  container.querySelectorAll('[data-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.category = btn.getAttribute('data-category') || AU_CATEGORY_ORDER[0];
      render(container);
    });
  });

  if (!auManageMode) {

  container.querySelectorAll('[data-scheme-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      config.selectedSchemeId = btn.getAttribute('data-scheme-id');
      const scheme = getSelectedAuScheme(config);
      config.activeEntryIds = [...(scheme?.entryIds || [])];
      await persist(config);
    });
  });

  container.querySelector('.au-scheme-new')?.addEventListener('click', async () => {
    const id = `auscheme_${Date.now()}`;
    config.schemes.push({
      id,
      name: '新方案',
      entryIds: [],
      notes: '',
    });
    config.selectedSchemeId = id;
    config.activeEntryIds = [];
    await persist(config);
  });

  container.querySelector('.au-scheme-save')?.addEventListener('click', async () => {
    const scheme = getSelectedAuScheme(config);
    if (!scheme) return;
    scheme.name = String(container.querySelector('.au-scheme-name')?.value || '').trim() || scheme.name;
    await persist(config);
  });

  container.querySelector('.au-scheme-delete')?.addEventListener('click', async () => {
    const scheme = getSelectedAuScheme(config);
    if (!scheme) return;
    if (config.schemes.length <= 1) {
      showToast('至少保留一个方案');
      return;
    }
    const label = String(scheme.name || '当前方案').trim();
    if (!window.confirm(`确定删除方案「${label}」？条目库不会被删除，只是该方案的勾选组合会移除。`)) return;
    const result = deleteAuScheme(config, scheme.id);
    if (!result.ok) {
      showToast(result.reason === 'last-scheme' ? '至少保留一个方案' : '删除失败');
      return;
    }
    config = result.config;
    await persist(config);
  });

  container.querySelectorAll('.au-entry-toggle').forEach((input) => {
    input.addEventListener('change', async () => {
      const scheme = getSelectedAuScheme(config);
      if (!scheme) return;
      const id = input.value;
      const set = new Set(scheme.entryIds || []);
      if (input.checked) set.add(id);
      else set.delete(id);
      scheme.entryIds = [...set];
      config.activeEntryIds = [...scheme.entryIds];
      await persist(config);
    });
  });

  container.querySelector('.au-entry-new')?.addEventListener('click', () => {
    openEntryEditor(null, async (entry) => {
      if (!entry) return;
      config.entries.push(entry);
      const scheme = getSelectedAuScheme(config);
      if (scheme && !scheme.entryIds.includes(entry.id)) {
        scheme.entryIds.push(entry.id);
        config.activeEntryIds = [...scheme.entryIds];
      }
      await persist(config);
    });
  });

  container.querySelectorAll('.au-entry-edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const entry = config.entries.find((item) => item.id === btn.getAttribute('data-entry-id'));
      if (!entry) return;
      openEntryEditor(entry, async (next) => {
        if (next === null) {
          config.entries = config.entries.filter((item) => item.id !== entry.id);
          config.schemes.forEach((scheme) => {
            scheme.entryIds = scheme.entryIds.filter((id) => id !== entry.id);
          });
          config.activeEntryIds = config.activeEntryIds.filter((id) => id !== entry.id);
        } else {
          const idx = config.entries.findIndex((item) => item.id === entry.id);
          if (idx >= 0) config.entries[idx] = next;
        }
        await persist(config);
      });
    });
  });

  container.querySelectorAll('[data-preset-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const preset = AU_PRESETS.find((item) => item.id === btn.getAttribute('data-preset-id'));
      if (!preset) return;
      const entry = createAuEntry({
        id: `preset_${preset.id}`,
        name: preset.name,
        category: preset.category,
        kind: 'preset',
        content: preset.worldBookOverlay,
        strongOverride: preset.strongOverride === true,
        priority: preset.priority,
        sourcePresetId: preset.id,
      });
      if (!config.entries.some((item) => item.id === entry.id)) {
        config.entries.push(entry);
      }
      await persist(config);
    });
  });
  }

  const scrollEl = container.querySelector('.au-panel-scroll');
  if (scrollEl && prevScrollTop) scrollEl.scrollTop = prevScrollTop;
}
