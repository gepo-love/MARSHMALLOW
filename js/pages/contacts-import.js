import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { loadAppearancePrefs, getActiveTheme, applySettingsWallpaperPreview } from '../core/appearance-prefs.js';
import {
  parseBackupJson,
  importParsedBackup,
  IMPORT_GUIDE,
  CHARACTER_JSON_SCOPE_NOTE,
} from '../core/character-import.js';
import { getRoleTierLabel } from '../models/character.js';
import { triggerFileInput } from '../core/open-file-picker.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderGuide(title, steps) {
  return `
    <div class="contacts-guide">
      <div class="contacts-guide-title">${esc(title)}</div>
      <ol>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </div>
  `;
}

export default async function render(container) {
  const prefs = await loadAppearancePrefs();
  const { theme } = getActiveTheme(prefs);
  let parsed = null;
  let selected = new Set();

  container.className = 'page scrapbook-page contacts-page';
  applySettingsWallpaperPreview(container, theme);

  function renderList() {
    const listEl = container.querySelector('.contacts-import-list');
    const summaryEl = container.querySelector('.contacts-import-summary');
    if (!listEl) return;
    if (!parsed || !parsed.characters.length) {
      listEl.innerHTML = '';
      if (summaryEl) summaryEl.textContent = '';
      return;
    }
    if (summaryEl) {
      summaryEl.textContent = `识别到 ${parsed.characters.length} 位角色（本应用角色包）`;
    }
    listEl.innerHTML = parsed.characters.map((c) => {
      const id = String(c.id || '');
      const name = String(c.name || c.realName || id);
      const checked = selected.has(id) ? 'checked' : '';
      return `
        <label class="contacts-import-row">
          <input type="checkbox" data-import-id="${esc(id)}" ${checked}>
          <div>
            <div class="contacts-import-name">${esc(name)} · ${esc(getRoleTierLabel(c.roleTier || 'npc'))}</div>
            <div class="contacts-import-id">${esc(id)}</div>
          </div>
        </label>
      `;
    }).join('');
    listEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-import-id');
        if (!id) return;
        if (cb.checked) selected.add(id);
        else selected.delete(id);
      });
    });
  }

  function renderShell() {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn contacts-import-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">导入角色</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="contacts-import-scroll scrapbook-scroll">
        <p class="contacts-import-scope">${esc(CHARACTER_JSON_SCOPE_NOTE)}</p>
        ${renderGuide('导入本应用角色包', IMPORT_GUIDE.marshmallow)}

        <button type="button" class="btn btn-primary contacts-pick-file">选择角色包 JSON</button>
        <input type="file" accept=".json,application/json" class="contacts-file-input mm-file-input" hidden>

        <p class="contacts-import-summary contacts-stats"></p>
        <div class="contacts-import-list"></div>

        <div class="contacts-toolbar" style="margin-top:12px;">
          <button type="button" class="btn btn-outline contacts-select-all" disabled>全选</button>
          <button type="button" class="btn btn-soft contacts-select-none" disabled>全不选</button>
          <button type="button" class="btn btn-primary contacts-run-import" disabled>导入选中</button>
        </div>

        <p class="contacts-stats" style="margin-top:16px;">按角色或分组导出请使用通讯录里的「导出」。完整备份（含聊天记录等）请用设置里的导出/导入完整备份。</p>
      </main>
    `;

    container.querySelector('.contacts-import-back')?.addEventListener('click', () => back());
    const fileInput = container.querySelector('.contacts-file-input');
    container.querySelector('.contacts-pick-file')?.addEventListener('click', () => triggerFileInput(fileInput));
    fileInput?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        parsed = parseBackupJson(text);
        selected = new Set(parsed.characters.map((c) => c.id));
        renderList();
        container.querySelector('.contacts-select-all').disabled = false;
        container.querySelector('.contacts-select-none').disabled = false;
        container.querySelector('.contacts-run-import').disabled = false;
        showToast(`已读取 ${parsed.characters.length} 位角色`);
      } catch (err) {
        showToast(String((err && err.message) || err));
      }
      e.target.value = '';
    });

    container.querySelector('.contacts-select-all')?.addEventListener('click', () => {
      if (!parsed) return;
      selected = new Set(parsed.characters.map((c) => c.id));
      renderList();
    });
    container.querySelector('.contacts-select-none')?.addEventListener('click', () => {
      selected = new Set();
      renderList();
    });
    container.querySelector('.contacts-run-import')?.addEventListener('click', async () => {
      if (!parsed || !selected.size) {
        showToast('请先选择要导入的角色');
        return;
      }
      try {
        const result = await importParsedBackup(parsed, { selectedIds: selected, merge: true });
        showToast(`已导入 ${result.imported} 位`);
        navigate('contacts', {}, true);
      } catch (err) {
        showToast(String((err && err.message) || err));
      }
    });
  }

  renderShell();
}
