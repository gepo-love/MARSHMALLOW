import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readDataId(el) {
  return String(el?.getAttribute?.('data-id') ?? el?.dataset?.id ?? '');
}

export function collectAiFillReviewEntries(checks = [], valueControls = []) {
  const valueById = new Map(
    Array.from(valueControls).map((control) => [readDataId(control), control]),
  );
  const entries = [];
  Array.from(checks).forEach((cb) => {
    if (!cb?.checked) return;
    const id = readDataId(cb);
    const value = String(valueById.get(id)?.value || '').trim();
    if (!value) return;
    entries.push({ id, value });
  });
  return entries;
}

/**
 * AI 补全预览：列出 AI 给「空白字段」准备的内容，逐项勾选 / 编辑后再填入。
 * fields: [{ id, label, value, multiline }]
 * onConfirm(entries): entries = [{ id, value }]（仅勾选且非空的项，value 为用户编辑后的文本）
 */
export function openAiFillReviewModal({
  title = 'AI 补全预览',
  subtitle = '只列出你还没填的字段，勾选并可编辑后再填入；已填内容不受影响。',
  fields = [],
  confirmLabel = '填入勾选项',
  onConfirm,
  onError,
  onClosed,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  if (!Array.isArray(fields) || !fields.length) return;
  host.classList.add('active');

  const rows = fields.map((f, i) => {
    const idAttr = esc(String(f.id ?? i));
    const control = f.multiline
      ? `<textarea class="form-input ai-fill-value" data-id="${idAttr}" rows="${Math.min(8, Math.max(2, Math.ceil(String(f.value || '').length / 28)))}" placeholder="留空则不填此项">${esc(f.value)}</textarea>`
      : `<input type="text" class="form-input ai-fill-value" data-id="${idAttr}" value="${esc(f.value)}" placeholder="留空则不填此项" />`;
    return `
      <div class="ai-fill-field" data-field-id="${idAttr}">
        <label class="ai-fill-field-head">
          <input type="checkbox" class="ai-fill-check" data-id="${idAttr}" checked />
          <span class="ai-fill-field-label">${esc(f.label || f.id || '')}</span>
        </label>
        ${control}
      </div>`;
  }).join('');

  host.innerHTML = `
    <div class="modal-overlay" data-ai-fill-overlay>
      <form class="modal-sheet scrapbook-card ai-fill-sheet" role="dialog" aria-modal="true" data-ai-fill-form>
        <header class="modal-header">
          <h3>${esc(title)}</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-ai-fill-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body ai-fill-body">
          <p class="ai-fill-subtitle">${esc(subtitle)}</p>
          <div class="ai-fill-toolbar">
            <span class="ai-fill-count" data-ai-fill-count></span>
            <button type="button" class="ai-fill-toggle-all" data-ai-fill-toggle-all>全不选</button>
          </div>
          <div class="ai-fill-list">${rows}</div>
        </div>
        <footer class="ai-fill-footer">
          <button type="button" class="btn btn-outline ai-fill-cancel" data-ai-fill-close>取消</button>
          <button type="submit" class="btn btn-primary ai-fill-confirm">${esc(confirmLabel)}</button>
        </footer>
      </form>
    </div>
  `;

  const sheet = host.querySelector('.ai-fill-sheet');
  const checks = Array.from(host.querySelectorAll('.ai-fill-check'));
  const valueControls = Array.from(host.querySelectorAll('.ai-fill-value'));
  const countEl = host.querySelector('[data-ai-fill-count]');
  const toggleAllBtn = host.querySelector('[data-ai-fill-toggle-all]');
  const confirmBtn = host.querySelector('.ai-fill-confirm');
  let confirming = false;

  const updateCount = () => {
    const checked = checks.filter((c) => c.checked).length;
    if (countEl) countEl.textContent = `已选 ${checked} / ${checks.length} 项`;
    if (toggleAllBtn) toggleAllBtn.textContent = checked === checks.length ? '全不选' : '全选';
  };

  const syncRowState = (cb) => {
    const row = cb.closest('.ai-fill-field');
    if (row) row.classList.toggle('is-off', !cb.checked);
  };

  checks.forEach((cb) => {
    syncRowState(cb);
    cb.addEventListener('change', () => {
      syncRowState(cb);
      updateCount();
    });
  });
  updateCount();

  toggleAllBtn?.addEventListener('click', () => {
    const turnOn = checks.some((c) => !c.checked);
    checks.forEach((c) => {
      c.checked = turnOn;
      syncRowState(c);
    });
    updateCount();
  });

  const close = (notifyClosed = true) => {
    host.classList.remove('active');
    host.innerHTML = '';
    if (notifyClosed) onClosed?.();
  };

  host.querySelector('[data-ai-fill-overlay]')?.addEventListener('click', () => close());
  sheet?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelectorAll('[data-ai-fill-close]').forEach((btn) => {
    btn.addEventListener('click', () => close());
  });

  sheet?.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (confirming) return;

    const active = document.activeElement;
    if (active && sheet.contains(active) && active.classList?.contains('ai-fill-value')) {
      active.blur();
    }
    const entries = collectAiFillReviewEntries(checks, valueControls);

    confirming = true;
    if (confirmBtn) confirmBtn.disabled = true;
    try {
      const applied = await onConfirm?.(entries);
      if (applied === false) return;
      close(false);
    } catch (error) {
      console.error('[ai-fill] apply review entries failed', error);
      onError?.(error);
    } finally {
      confirming = false;
      if (confirmBtn?.isConnected) confirmBtn.disabled = false;
    }
  });
}
