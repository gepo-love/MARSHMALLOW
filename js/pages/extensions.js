import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { openLinkPreview } from '../components/link-preview-sheet.js';
import { downloadJson } from '../core/native-download.js';
import { shareToCommunityStore } from '../core/community-share-draft.js';
import {
  DEFAULT_HTML_EXTENSION_TEMPLATE,
  buildHtmlExtensionsExport,
  createHtmlExtensionSnapshot,
  deleteHtmlExtension,
  hydrateHtmlExtensionHosts,
  htmlExtensionTemplateFields,
  listHtmlExtensions,
  normalizeHtmlExtension,
  parseHtmlExtensionsImport,
  saveHtmlExtensions,
  upsertHtmlExtension,
} from '../core/html-extensions.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function targetLabel(item = {}) {
  const targets = Array.isArray(item.targets) ? item.targets : [];
  if (targets.includes('chat') && targets.includes('offline')) return '线上 + 线下';
  if (targets.includes('offline')) return '线下';
  return '线上';
}

function triggerLabel(item = {}) {
  if (item.triggerMode === 'required') return '每轮输出';
  if (item.triggerMode === 'always') return '每轮可用';
  return item.keywords?.length ? item.keywords.join(' · ') : '未设置触发词';
}

function extensionRowHtml(item = {}) {
  return `
    <article class="ext-item${item.enabled ? '' : ' is-off'}" data-extension-row="${esc(item.id)}">
      <button type="button" class="ext-item-main" data-edit-extension="${esc(item.id)}">
        <span class="ext-item-name">${esc(item.name)}</span>
        <span class="ext-item-trigger">${esc(triggerLabel(item))}</span>
        <span class="ext-item-target">${esc(targetLabel(item))}</span>
      </button>
      <label class="ext-switch" aria-label="${item.enabled ? '停用' : '启用'}${esc(item.name)}">
        <input type="checkbox" data-toggle-extension="${esc(item.id)}" ${item.enabled ? 'checked' : ''} />
        <span></span>
      </label>
    </article>`;
}

function editorHtml(item = {}) {
  const targets = new Set(item.targets || []);
  return `
    <div class="modal-overlay ext-editor-overlay" data-editor-close>
      <section class="modal-sheet ext-editor" role="dialog" aria-modal="true" aria-label="编辑 HTML 组件">
        <header class="ext-editor-head">
          <button type="button" class="navbar-btn" data-editor-close aria-label="关闭">${icon('back')}</button>
          <h2>${item.id ? '编辑组件' : '新建组件'}</h2>
          <button type="button" class="ext-editor-save">保存</button>
        </header>
        <div class="ext-editor-scroll" data-ime-scroll-region>
          <label class="api-field">
            <span class="api-field-label">名称</span>
            <input class="form-input ext-name" value="${esc(item.name || '')}" maxlength="50" />
          </label>
          <div class="api-field">
            <span class="api-field-label">作用于</span>
            <div class="ext-targets">
              <label><input type="checkbox" value="chat" ${targets.has('chat') ? 'checked' : ''} />线上聊天</label>
              <label><input type="checkbox" value="offline" ${targets.has('offline') ? 'checked' : ''} />线下场景</label>
            </div>
          </div>
          <label class="api-field">
            <span class="api-field-label">触发方式</span>
            <select class="form-input ext-trigger-mode">
              <option value="keywords" ${item.triggerMode === 'keywords' ? 'selected' : ''}>命中关键词</option>
              <option value="always" ${item.triggerMode === 'always' ? 'selected' : ''}>每轮可用</option>
              <option value="required" ${item.triggerMode === 'required' ? 'selected' : ''}>每轮输出</option>
            </select>
          </label>
          <label class="api-field ext-keyword-field">
            <span class="api-field-label">关键词</span>
            <input class="form-input ext-keywords" value="${esc((item.keywords || []).join('，'))}" placeholder="如：信件，日记，查看清单" />
          </label>
          <label class="api-field">
            <span class="api-field-label">内容规则</span>
            <textarea class="form-input ext-prompt" rows="3" maxlength="2000" placeholder="告诉 AI 何时使用、组件正文应写什么">${esc(item.prompt || '')}</textarea>
          </label>
          <label class="api-field">
            <span class="ext-template-label"><span class="api-field-label">HTML / CSS 模板</span><button type="button" data-extension-support>支持范围</button></span>
            <textarea class="form-input ext-template" rows="12" spellcheck="false">${esc(item.sourceTemplateHtml || item.templateHtml || DEFAULT_HTML_EXTENSION_TEMPLATE)}</textarea>
          </label>
          <div class="ext-placeholder-line"><code>{{title}}</code><code>{{content}}</code><code>{{任意字段}}</code><code>{{name}} = 角色名</code></div>
          <div class="api-field-hint">按钮支持 data-action="toggle" / "dialog" / "link"；弹窗标题与正文分别写在 data-title、data-content。</div>
          <section class="ext-preview">
            <span class="api-field-label">预览</span>
            <div data-html-extension-host="preview"></div>
          </section>
          ${item.id ? '<button type="button" class="ext-delete">删除这个组件</button>' : ''}
        </div>
      </section>
    </div>`;
}

function sharePickerHtml(items = [], selectedIds = new Set()) {
  return `
    <div class="modal-overlay ext-share-overlay" data-share-close>
      <section class="modal-sheet ext-share-sheet" role="dialog" aria-modal="true" aria-label="选择要分享的 HTML 组件">
        <header class="ext-share-head">
          <h2>选择组件</h2>
          <button type="button" data-share-close aria-label="关闭">×</button>
        </header>
        <div class="ext-share-list">
          ${items.map((item) => `
            <label>
              <input type="checkbox" data-share-extension="${esc(item.id)}" ${selectedIds.has(item.id) ? 'checked' : ''} />
              <span><strong>${esc(item.name)}</strong><small>${esc(targetLabel(item))}</small></span>
            </label>`).join('')}
        </div>
        <footer class="ext-share-footer">
          <button type="button" data-share-all>${selectedIds.size === items.length ? '取消全选' : '全选'}</button>
          <button type="button" class="is-primary" data-share-confirm ${selectedIds.size ? '' : 'disabled'}>分享 ${selectedIds.size} 个</button>
        </footer>
      </section>
    </div>`;
}

export default async function render(container) {
  let items = await listHtmlExtensions();
  let editing = null;
  let sharing = false;
  let shareSelection = new Set();
  container.className = 'page ext-page';

  function paint() {
    container.innerHTML = `
      <header class="navbar ext-navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">扩展库</h1>
        <button type="button" class="navbar-btn" data-new-extension aria-label="新建组件">${icon('plus')}</button>
      </header>
      <main class="ext-scroll">
        <button type="button" class="ext-rule-entry">
          <span><strong>文本规则</strong><small>剪除、替换与显示范围</small></span>
          <span>${icon('chevron')}</span>
        </button>
        <div class="ext-section-head">
          <h2>HTML 组件</h2>
          <span>${items.length}</span>
          <div class="ext-section-actions">
            <button type="button" data-import-extensions>导入</button>
            <button type="button" data-export-extensions ${items.length ? '' : 'disabled'}>导出</button>
            <button type="button" data-share-extensions title="分享到应用商店" ${items.length ? '' : 'disabled'}>分享</button>
          </div>
          <input type="file" data-import-extensions-file accept=".json,application/json" hidden />
        </div>
        <div class="ext-list">
          ${items.length ? items.map(extensionRowHtml).join('') : `
            <button type="button" class="ext-empty" data-new-extension>
              <strong>还没有组件</strong>
              <span>新建一个关键词触发的小剧场或展开卡片</span>
            </button>`}
        </div>
      </main>
      ${editing ? editorHtml(editing) : ''}
      ${sharing ? sharePickerHtml(items, shareSelection) : ''}`;
    bind();
    hydratePreview();
  }

  function readEditor() {
    const sheet = container.querySelector('.ext-editor');
    if (!sheet) return null;
    const targets = [...sheet.querySelectorAll('.ext-targets input:checked')].map((el) => el.value);
    return normalizeHtmlExtension({
      ...editing,
      name: sheet.querySelector('.ext-name')?.value,
      targets,
      triggerMode: sheet.querySelector('.ext-trigger-mode')?.value,
      keywords: sheet.querySelector('.ext-keywords')?.value,
      prompt: sheet.querySelector('.ext-prompt')?.value,
      sourceTemplateHtml: sheet.querySelector('.ext-template')?.value,
      enabled: editing?.enabled !== false,
    });
  }

  function hydratePreview() {
    if (!editing) return;
    const draft = readEditor() || editing;
    const snapshot = createHtmlExtensionSnapshot(draft, {
      title: '一封没有寄出的信',
      content: '点击标题展开后，这段内容才会出现。',
      name: '林屿',
      fields: Object.fromEntries(htmlExtensionTemplateFields(draft.templateHtml)
        .filter((key) => !['title', 'content', 'name'].includes(key))
        .map((key) => [key, `${key}示例`])),
    });
    if (snapshot) {
      hydrateHtmlExtensionHosts(container, { preview: snapshot }, {
        onOpenLink: (url, linkOptions) => openLinkPreview(url, linkOptions),
      });
    }
  }

  function openEditor(item = null) {
    editing = item
      ? normalizeHtmlExtension(item)
      : normalizeHtmlExtension({
        id: '',
        name: '展开卡片',
        targets: ['chat', 'offline'],
        triggerMode: 'keywords',
        templateHtml: DEFAULT_HTML_EXTENSION_TEMPLATE,
      });
    if (!item) editing.id = '';
    paint();
    container.querySelector('.ext-name')?.focus();
  }

  async function saveEditor() {
    const draft = readEditor();
    if (!draft?.name) return;
    if (!draft.targets.length) {
      showToast('至少选择一个作用范围');
      return;
    }
    if (draft.triggerMode === 'keywords' && !draft.keywords.length) {
      showToast('请填写至少一个触发词');
      return;
    }
    const saved = await upsertHtmlExtension({
      ...draft,
      id: editing?.id || undefined,
    });
    items = await listHtmlExtensions();
    editing = null;
    paint();
    showToast(saved.sourceTemplateHtml === saved.templateHtml
      ? `已保存「${saved.name}」`
      : `已完整保存「${saved.name}」源码；预览已安全忽略不支持的内容`);
  }

  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('.ext-rule-entry')?.addEventListener('click', () => navigate('display-regex'));
    container.querySelectorAll('[data-new-extension]').forEach((button) => {
      button.addEventListener('click', () => openEditor());
    });
    const importInput = container.querySelector('[data-import-extensions-file]');
    container.querySelector('[data-import-extensions]')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (!file) return;
      try {
        if (file.size > 4 * 1024 * 1024) throw new Error('导入文件不能超过 4 MB');
        const imported = parseHtmlExtensionsImport(await file.text());
        const importedIds = new Set(imported.map((item) => item.id));
        items = await saveHtmlExtensions([
          ...imported,
          ...items.filter((item) => !importedIds.has(item.id)),
        ]);
        paint();
        showToast(`已导入 ${imported.length} 个 HTML 组件`);
      } catch (error) {
        showToast(error?.message || '导入失败');
      }
    });
    container.querySelector('[data-export-extensions]')?.addEventListener('click', async () => {
      if (!items.length) return;
      try {
        await downloadJson(
          buildHtmlExtensionsExport(items),
          `marshmallow-html-components-${Date.now()}.json`,
        );
        showToast(`已导出 ${items.length} 个 HTML 组件`);
      } catch (error) {
        showToast(error?.message || '导出失败');
      }
    });
    container.querySelector('[data-share-extensions]')?.addEventListener('click', () => {
      if (!items.length) return;
      shareSelection = new Set(items.map((item) => item.id));
      sharing = true;
      paint();
    });
    container.querySelectorAll('[data-share-close]').forEach((button) => {
      button.addEventListener('click', (event) => {
        if (event.target !== button && button.classList.contains('ext-share-overlay')) return;
        sharing = false;
        shareSelection = new Set();
        paint();
      });
    });
    container.querySelector('.ext-share-sheet')?.addEventListener('click', (event) => event.stopPropagation());
    container.querySelectorAll('[data-share-extension]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.checked) shareSelection.add(input.getAttribute('data-share-extension'));
        else shareSelection.delete(input.getAttribute('data-share-extension'));
        paint();
      });
    });
    container.querySelector('[data-share-all]')?.addEventListener('click', () => {
      shareSelection = shareSelection.size === items.length
        ? new Set()
        : new Set(items.map((item) => item.id));
      paint();
    });
    container.querySelector('[data-share-confirm]')?.addEventListener('click', () => {
      const selectedItems = items.filter((item) => shareSelection.has(item.id));
      if (!selectedItems.length) return;
      try {
        shareToCommunityStore({
          source: buildHtmlExtensionsExport(selectedItems),
          fileName: 'marshmallow-html-components.json',
          resourceType: 'html-component',
          title: selectedItems.length === 1
            ? (selectedItems[0].name || 'HTML 组件')
            : `HTML 组件合集（${selectedItems.length}个）`,
          originLabel: '扩展库',
        });
      } catch (error) {
        showToast(error?.message || '无法分享');
      }
    });
    container.querySelectorAll('[data-edit-extension]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = items.find((row) => row.id === button.getAttribute('data-edit-extension'));
        if (item) openEditor(item);
      });
    });
    container.querySelectorAll('[data-toggle-extension]').forEach((input) => {
      input.addEventListener('change', async () => {
        const item = items.find((row) => row.id === input.getAttribute('data-toggle-extension'));
        if (!item) return;
        await upsertHtmlExtension({ ...item, enabled: input.checked });
        items = await listHtmlExtensions();
        paint();
      });
    });
    container.querySelectorAll('[data-editor-close]').forEach((button) => {
      button.addEventListener('click', (event) => {
        if (event.target !== button && button.classList.contains('ext-editor-overlay')) return;
        editing = null;
        paint();
      });
    });
    container.querySelector('.ext-editor')?.addEventListener('click', (event) => event.stopPropagation());
    container.querySelector('[data-extension-support]')?.addEventListener('click', () => navigate('tutorial', { section: 'extensions' }));
    container.querySelector('.ext-editor-save')?.addEventListener('click', () => saveEditor());
    container.querySelector('.ext-trigger-mode')?.addEventListener('change', (event) => {
      const field = container.querySelector('.ext-keyword-field');
      if (field) field.hidden = event.target.value !== 'keywords';
      hydratePreview();
    });
    container.querySelectorAll('.ext-name,.ext-template').forEach((input) => {
      input.addEventListener('input', hydratePreview);
    });
    container.querySelector('.ext-delete')?.addEventListener('click', async () => {
      if (!editing?.id || !window.confirm(`删除「${editing.name}」？`)) return;
      items = await deleteHtmlExtension(editing.id);
      editing = null;
      paint();
      showToast('已删除');
    });
    const keywordField = container.querySelector('.ext-keyword-field');
    if (keywordField && editing?.triggerMode !== 'keywords') keywordField.hidden = true;
  }

  paint();
}
