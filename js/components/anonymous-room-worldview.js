import { AU_PRESETS } from '../data/au-presets.js';

function esc(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return esc(value).replace(/'/g, '&#39;');
}

function isWorldBookRoot(row = {}) {
  return !!row?.isBookRoot;
}

function formatWorldBookRootLabel(row = {}) {
  return String(row.name || row.title || row.id || '').trim();
}

export function renderAnonymousRoomWorldviewSection({
  worldBookOptions = [],
  initial = {},
} = {}) {
  const auPresetId = String(initial.auPresetId || '').trim();
  const worldBookId = String(initial.worldBookId || '').trim();
  const worldview = String(initial.worldview || '').trim();
  const wbRoots = (worldBookOptions || []).filter(isWorldBookRoot);
  return `
    <section class="anon-card anon-worldview-card">
      <div class="anon-section-title">世界观 / 设定（可选）</div>
      <label class="anon-form-field">
        <span>内置 AU 快填</span>
        <select class="form-input anon-world-au-preset">
          <option value="">不套用</option>
          ${AU_PRESETS.map((preset) => `
            <option value="${escAttr(preset.id)}" ${preset.id === auPresetId ? 'selected' : ''}>${esc(preset.name)}</option>
          `).join('')}
        </select>
      </label>
      <label class="anon-form-field">
        <span>绑定世界书</span>
        <select class="form-input anon-world-worldbook">
          <option value="">不绑定</option>
          ${wbRoots.map((wb) => `
            <option value="${escAttr(wb.id)}" ${wb.id === worldBookId ? 'selected' : ''}>${esc(formatWorldBookRootLabel(wb))}</option>
          `).join('')}
        </select>
      </label>
      <label class="anon-form-field">
        <span>补充说明</span>
        <textarea class="form-input anon-world-text" rows="3" placeholder="留空则为普通现代网友；选 AU 会自动填入，也可再改">${esc(worldview)}</textarea>
      </label>
    </section>`;
}

export function bindAnonymousRoomWorldview(root) {
  const auSelect = root?.querySelector('.anon-world-au-preset');
  const textarea = root?.querySelector('.anon-world-text');

  auSelect?.addEventListener('change', () => {
    const presetId = String(auSelect.value || '').trim();
    if (!presetId || !textarea) return;
    const preset = AU_PRESETS.find((item) => item.id === presetId);
    if (!preset?.worldBookOverlay) return;
    textarea.value = preset.worldBookOverlay;
  });

  return {
    readValues() {
      return {
        worldview: String(root?.querySelector('.anon-world-text')?.value || '').trim(),
        worldBookId: String(root?.querySelector('.anon-world-worldbook')?.value || '').trim(),
        auPresetId: String(root?.querySelector('.anon-world-au-preset')?.value || '').trim(),
      };
    },
  };
}
