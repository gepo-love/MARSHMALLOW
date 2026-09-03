import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 通用单选/多选底部选项表。
 * @returns {Promise<string|string[]|null>}
 */
export function openOptionPicker({
  title = '请选择',
  items = [],
  multiple = false,
  preselected = [],
  confirmLabel = '确认',
} = {}) {
  const list = (Array.isArray(items) ? items : [])
    .map((x) => ({
      id: String(x?.id ?? ''),
      label: String(x?.label ?? x?.name ?? x?.id ?? '').trim(),
    }))
    .filter((x) => x.id !== '' && x.label);
  if (!list.length) return Promise.resolve(multiple ? [] : null);

  return new Promise((resolve) => {
    const host = document.getElementById('modal-container');
    if (!host) {
      resolve(multiple ? [] : null);
      return;
    }
    const selected = new Set(
      (Array.isArray(preselected) ? preselected : [preselected])
        .map((x) => String(x ?? ''))
        .filter((x) => x !== ''),
    );
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-option-picker-overlay>
        <div class="modal-sheet scrapbook-card option-picker-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>${esc(title)}</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-option-picker-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body option-picker-body">
            ${list.map((opt) => `
              <button type="button" class="btn btn-outline option-picker-item ${selected.has(opt.id) ? 'is-selected' : ''}" data-pick-id="${esc(opt.id)}" aria-pressed="${selected.has(opt.id) ? 'true' : 'false'}">
                <span>${esc(opt.label)}</span><span class="option-picker-check" aria-hidden="true">✓</span>
              </button>`).join('')}
          </div>
          ${multiple ? `<footer class="modal-footer option-picker-foot">
            <button type="button" class="btn" data-op-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-op-confirm>${esc(confirmLabel)}</button>
          </footer>` : ''}
        </div>
      </div>
    `;
    const close = (value) => {
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(value);
    };
    host.querySelector('.option-picker-sheet')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-option-picker-overlay]')?.addEventListener('click', () => close(multiple ? null : null));
    host.querySelector('[data-option-picker-close]')?.addEventListener('click', () => close(multiple ? null : null));
    host.querySelector('[data-op-cancel]')?.addEventListener('click', () => close(null));
    host.querySelector('[data-op-confirm]')?.addEventListener('click', () => close([...selected]));
    host.querySelectorAll('.option-picker-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-pick-id');
        if (!id) return;
        if (multiple) {
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          btn.classList.toggle('is-selected', selected.has(id));
          btn.setAttribute('aria-pressed', selected.has(id) ? 'true' : 'false');
          return;
        }
        close(id);
      });
    });
  });
}
