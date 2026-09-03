import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import {
  REGEX_SURFACES,
  listRegexGroups,
  saveRegexGroups,
  importRegexGroup,
  importRegexGroupFromEntries,
  parseRegexImportEntries,
  labelForExecMode,
} from '../core/display-regex.js';
import { readRegexJsonEntriesFromFiles, stripNamePrefix } from '../core/regex-zip-import.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ruleHtml(group, rule) {
  const targetSet = new Set(rule.targets || []);
  const chips = REGEX_SURFACES.map((s) =>
    `<button type="button" class="rxg-chip ${targetSet.has(s.id) ? 'is-active' : ''}" data-target="${esc(s.id)}" data-grp="${esc(group.id)}" data-rule="${esc(rule.id)}" aria-pressed="${targetSet.has(s.id) ? 'true' : 'false'}"><span class="rxg-chip-check" aria-hidden="true">✓</span>${esc(s.label)}</button>`,
  ).join('');
  const editHint = rule.runOnEdit ? '<span class="rxg-rule-tag">编辑后重跑</span>' : '';
  return `
    <div class="rxg-rule ${rule.enabled ? '' : 'is-off'}" data-edit-rule data-grp="${esc(group.id)}" data-rule="${esc(rule.id)}" role="button" tabindex="0">
      <div class="rxg-rule-head">
        <label class="rxg-switch" data-stop>
          <input type="checkbox" data-rule-toggle data-grp="${esc(group.id)}" data-rule="${esc(rule.id)}" ${rule.enabled ? 'checked' : ''} />
          <strong>${esc(rule.name)}</strong>
        </label>
        ${editHint}
      </div>
      <div class="rxg-rule-body">
        <code class="rxg-find">/${esc(rule.find)}/${esc(rule.flags)}</code>
        <span class="rxg-arrow">→</span>
        <code class="rxg-replace">${rule.replace === '' ? '（删除）' : esc(rule.replace)}</code>
      </div>
      <div class="rxg-rule-meta">${esc(labelForExecMode(rule))}</div>
      <div class="rxg-targets" data-stop>
        <span class="rxg-targets-label">用途</span>
        ${chips}
      </div>
    </div>`;
}

function groupHtml(group) {
  return `
    <section class="scrapbook-card rxg-group ${group.enabled ? '' : 'is-off'}" data-group="${esc(group.id)}">
      <div class="rxg-group-head">
        <label class="rxg-switch rxg-group-switch">
          <input type="checkbox" data-group-toggle data-grp="${esc(group.id)}" ${group.enabled ? 'checked' : ''} />
          <strong>${esc(group.name)}</strong>
        </label>
        <span class="rxg-group-count">${(group.rules || []).length} 条</span>
        <button type="button" class="rxg-icon-btn" data-group-add="${esc(group.id)}" aria-label="新建规则">${icon('plus')}</button>
        <button type="button" class="rxg-del" data-group-del="${esc(group.id)}" aria-label="删除组">✕</button>
      </div>
      <div class="rxg-rules">
        ${(group.rules || []).length
    ? (group.rules || []).map((r) => ruleHtml(group, r)).join('')
    : '<div class="rxg-empty-inline">暂无规则，点 + 新建</div>'}
      </div>
    </section>`;
}

export default async function render(container) {
  let groups = await listRegexGroups();
  let importOpen = false;
  let importEntries = [];
  let importSelected = new Set();

  container.className = 'page scrapbook-page rxg-page';

  function findGroup(id) {
    return groups.find((g) => g.id === id) || null;
  }
  function findRule(gid, rid) {
    const g = findGroup(gid);
    return g ? (g.rules || []).find((r) => r.id === rid) || null : null;
  }

  async function persist() {
    groups = await saveRegexGroups(groups);
  }

  function renderImportPreview() {
    const box = container.querySelector('.rxg-import-preview');
    if (!box) return;
    if (!importEntries.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = `
      <div class="chat-details-section-title">预览 ${importEntries.length} 个文件</div>
      <div class="rxg-import-list">
        ${importEntries.map((entry, idx) => {
    const key = String(idx);
    const title = stripNamePrefix(entry.name) || entry.name;
    const checked = importSelected.has(key) ? 'checked' : '';
    return `
            <label class="rxg-import-row">
              <input type="checkbox" data-import-idx="${esc(key)}" ${checked} />
              <span>${esc(title)}</span>
            </label>`;
  }).join('')}
      </div>
      <div class="rxg-import-actions">
        <input type="text" class="form-input rxg-import-name" placeholder="组名（可留空）" maxlength="40" />
        <button type="button" class="btn btn-outline rxg-select-all">全选</button>
        <button type="button" class="btn btn-primary rxg-do-import">导入选中</button>
      </div>
    `;
    box.querySelectorAll('[data-import-idx]').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.getAttribute('data-import-idx');
        if (!key) return;
        if (el.checked) importSelected.add(key);
        else importSelected.delete(key);
      });
    });
    box.querySelector('.rxg-select-all')?.addEventListener('click', () => {
      importEntries.forEach((_, idx) => importSelected.add(String(idx)));
      renderImportPreview();
    });
    box.querySelector('.rxg-do-import')?.addEventListener('click', onImportSelected);
  }

  function paint() {
    const prevScroll = captureScrollerTop(container, '.rxg-scroll');
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">正则组</h1>
        <button type="button" class="navbar-btn rxg-import-toggle" aria-label="导入">${icon('plus')}</button>
      </header>
      <main class="rxg-scroll scrapbook-scroll">
        <p class="rxg-note">支持永久修改、仅显示与仅发给模型；可导入 JSON / ZIP，也可手动新建。</p>

        <section class="scrapbook-card rxg-import" ${importOpen ? '' : 'hidden'}>
          <div class="chat-details-section-title">导入正则</div>
          <p class="rxg-import-hint">选择 .json / .zip 文件，或粘贴 JSON 文本。</p>
          <div class="rxg-import-toolbar">
            <button type="button" class="btn btn-primary rxg-pick-file">选择文件</button>
            <button type="button" class="btn btn-outline rxg-new-group">手动新建</button>
            <input type="file" class="rxg-file-input" accept=".json,.zip,application/json,application/zip" multiple hidden />
          </div>
          <textarea class="form-input rxg-import-text" rows="4" placeholder="也可直接粘贴 JSON（单条或 {rules:[...]} 数组）"></textarea>
          <div class="rxg-import-actions">
            <input type="text" class="form-input rxg-import-name-paste" placeholder="组名（可留空）" maxlength="40" />
            <button type="button" class="btn btn-outline rxg-do-paste">粘贴导入</button>
          </div>
          <div class="rxg-import-preview" hidden></div>
        </section>

        <div class="rxg-list">
          ${groups.length ? groups.map((g) => groupHtml(g)).join('')
    : '<div class="rxg-empty">还没有正则组。可导入文件，或点右上角 + 展开导入区后手动新建。</div>'}
        </div>
      </main>
    `;
    restoreScrollerTop(container, '.rxg-scroll', prevScroll);
    bind();
    renderImportPreview();
  }

  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('.rxg-import-toggle')?.addEventListener('click', () => {
      importOpen = !importOpen;
      const box = container.querySelector('.rxg-import');
      if (box) box.hidden = !importOpen;
    });
    container.querySelector('.rxg-pick-file')?.addEventListener('click', () => {
      container.querySelector('.rxg-file-input')?.click();
    });
    container.querySelector('.rxg-file-input')?.addEventListener('change', onFilesPicked);
    container.querySelector('.rxg-do-paste')?.addEventListener('click', onPasteImport);
    container.querySelector('.rxg-new-group')?.addEventListener('click', () => {
      navigate('display-regex/edit', { gid: 'new', rid: 'new' });
    });

    container.querySelectorAll('[data-group-toggle]').forEach((el) => el.addEventListener('change', async () => {
      const g = findGroup(el.getAttribute('data-grp'));
      if (g) {
        g.enabled = el.checked;
        await persist();
        container.querySelector(`[data-group="${g.id}"]`)?.classList.toggle('is-off', !g.enabled);
      }
    }));
    container.querySelectorAll('[data-group-del]').forEach((el) => el.addEventListener('click', async () => {
      if (!window.confirm('删除这个正则组？')) return;
      groups = groups.filter((g) => g.id !== el.getAttribute('data-group-del'));
      await persist();
      paint();
    }));
    container.querySelectorAll('[data-group-add]').forEach((el) => el.addEventListener('click', () => {
      const gid = el.getAttribute('data-group-add');
      navigate('display-regex/edit', { gid, rid: 'new' });
    }));
    container.querySelectorAll('[data-edit-rule]').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-stop]')) return;
      navigate('display-regex/edit', {
        gid: el.getAttribute('data-grp'),
        rid: el.getAttribute('data-rule'),
      });
    }));
    container.querySelectorAll('[data-rule-toggle]').forEach((el) => el.addEventListener('change', async () => {
      const r = findRule(el.getAttribute('data-grp'), el.getAttribute('data-rule'));
      if (r) {
        r.enabled = el.checked;
        await persist();
        el.closest('.rxg-rule')?.classList.toggle('is-off', !r.enabled);
      }
    }));
    container.querySelectorAll('[data-target]').forEach((el) => el.addEventListener('click', async () => {
      const r = findRule(el.getAttribute('data-grp'), el.getAttribute('data-rule'));
      if (!r) return;
      const surface = el.getAttribute('data-target');
      const set = new Set(r.targets || []);
      if (set.has(surface)) set.delete(surface);
      else set.add(surface);
      r.targets = [...set];
      el.classList.toggle('is-active', set.has(surface));
      el.setAttribute('aria-pressed', set.has(surface) ? 'true' : 'false');
      await persist();
    }));
  }

  async function onFilesPicked(e) {
    const files = e.target?.files;
    if (!files?.length) return;
    try {
      importEntries = await readRegexJsonEntriesFromFiles(files);
      importSelected = new Set(importEntries.map((_, idx) => String(idx)));
      importOpen = true;
      const box = container.querySelector('.rxg-import');
      if (box) box.hidden = false;
      renderImportPreview();
      showToast(`已读取 ${importEntries.length} 个文件`);
    } catch (err) {
      showToast(`读取失败：${err?.message || err}`);
    } finally {
      e.target.value = '';
    }
  }

  async function onImportSelected() {
    const selected = importEntries.filter((_, idx) => importSelected.has(String(idx)));
    if (!selected.length) {
      showToast('请先勾选要导入的文件');
      return;
    }
    const name = String(container.querySelector('.rxg-import-name')?.value || '').trim();
    const btn = container.querySelector('.rxg-do-import');
    if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
    try {
      const preview = parseRegexImportEntries(selected, name);
      const group = await importRegexGroupFromEntries(selected, name || preview.name);
      groups = await listRegexGroups();
      importEntries = [];
      importSelected = new Set();
      importOpen = false;
      showToast(`已导入「${group.name}」· ${group.rules.length} 条`);
      paint();
    } catch (err) {
      showToast(`导入失败：${err?.message || err}`);
      if (btn) { btn.disabled = false; btn.textContent = '导入选中'; }
    }
  }

  async function onPasteImport() {
    const text = String(container.querySelector('.rxg-import-text')?.value || '').trim();
    const name = String(container.querySelector('.rxg-import-name-paste')?.value || '').trim();
    if (!text) { showToast('先粘贴 JSON'); return; }
    const btn = container.querySelector('.rxg-do-paste');
    if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
    try {
      const group = await importRegexGroup(text, name || '导入正则组');
      groups = await listRegexGroups();
      importOpen = false;
      showToast(`已导入「${group.name}」· ${group.rules.length} 条`);
      paint();
    } catch (err) {
      showToast(`导入失败：${err?.message || err}`);
      if (btn) { btn.disabled = false; btn.textContent = '粘贴导入'; }
    }
  }

  paint();
}
