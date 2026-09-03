import { icon } from './svg-icons.js';
import { bindCommitSearch } from './search-field.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generic participant picker sheet (send-as role, @ mention, invite, etc.).
 *
 * @param {object} options
 * @param {string} [options.title]
 * @param {Array<{ id: string, name?: string, label?: string }>} options.items
 * @param {boolean} [options.searchable] 显示搜索框，按名称过滤
 * @param {boolean} [options.multiple] 多选模式：返回 string[]，单选模式返回 string|null
 * @param {string[]} [options.preselected] 多选模式预勾选
 * @param {string} [options.confirmLabel]
 * @param {boolean} [options.editableNames] Allow editing names in a multi-select list.
 * @param {(id: string, name: string) => void} [options.onNameChange]
 * @param {boolean} [options.editableRemarks] Allow editing display-only phone remarks.
 * @param {(id: string, remark: string) => void} [options.onRemarkChange]
 * @returns {Promise<string|string[]|null>} 单选返回 id 或 null；多选返回 id[] 或 null
 */
export function openParticipantPicker({
  title = '请选择',
  items = [],
  searchable = false,
  multiple = false,
  preselected = [],
  confirmLabel = '确认',
  editableNames = false,
  onNameChange = null,
  editableRemarks = false,
  onRemarkChange = null,
} = {}) {
  const list = (Array.isArray(items) ? items : [])
    .map((x) => ({
      id: String(x?.id ?? '').trim(),
      name: String(x?.name ?? x?.label ?? '').trim() || String(x?.id ?? '').trim(),
      remark: String(x?.remark ?? '').trim(),
      detail: String(x?.detail ?? '').trim(),
    }))
    .filter((x) => x.id);
  if (!list.length) return Promise.resolve(multiple ? [] : null);

  return new Promise((resolve) => {
    const host = document.getElementById('modal-container');
    if (!host) {
      resolve(multiple ? [] : null);
      return;
    }
    const selected = new Set((Array.isArray(preselected) ? preselected : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean));
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-participant-picker-overlay>
        <div class="modal-sheet scrapbook-card participant-picker-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>${esc(title)}</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-participant-picker-close aria-label="关闭">${icon('back')}</button>
          </header>
          ${searchable ? `<div class="participant-picker-search"><div class="participant-picker-search-bar"><input type="search" class="form-input" data-pp-search placeholder="搜索名称，回车搜索" /><button type="button" class="search-icon-submit chat-new-search-btn" data-pp-search-submit aria-label="搜索">${icon('search')}</button></div></div>` : ''}
          <div class="modal-body participant-picker-body">
            ${list.map((opt) => editableNames && multiple ? `
              <div class="participant-picker-item participant-picker-editable ${selected.has(opt.id) ? 'is-selected' : ''}" data-pick-id="${esc(opt.id)}" data-pick-name="${esc(opt.name)}">
                <button type="button" class="participant-picker-toggle" aria-label="选择 ${esc(opt.name)}" aria-pressed="${selected.has(opt.id) ? 'true' : 'false'}"><span>✓</span></button>
                <span class="participant-picker-edit-fields">
                  <input type="text" class="form-input participant-picker-name-input" value="${esc(opt.name)}" maxlength="40" aria-label="联系人姓名">
                  ${editableRemarks ? `<input type="text" class="form-input participant-picker-remark-input" value="${esc(opt.remark)}" maxlength="40" aria-label="手机备注" placeholder="备注（可选）">` : ''}
                  ${opt.detail ? `<small>${esc(opt.detail)}</small>` : ''}
                </span>
              </div>` : `
              <button type="button" class="btn btn-outline participant-picker-item ${multiple && selected.has(opt.id) ? 'is-selected' : ''}" data-pick-id="${esc(opt.id)}" data-pick-name="${esc(opt.name)}">
                ${esc(opt.name)}
              </button>`).join('')}
          </div>
          ${multiple ? `<footer class="modal-footer participant-picker-foot">
            <button type="button" class="btn" data-pp-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-pp-confirm>${esc(confirmLabel)}<span data-pp-count></span></button>
          </footer>` : ''}
        </div>
      </div>
    `;
    const close = (value) => {
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(value);
    };
    const countEl = host.querySelector('[data-pp-count]');
    const syncCount = () => {
      if (countEl) countEl.textContent = selected.size ? `（${selected.size}）` : '';
    };
    syncCount();
    host.querySelector('.participant-picker-sheet')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-participant-picker-overlay]')?.addEventListener('click', () => close(multiple ? null : null));
    host.querySelector('[data-participant-picker-close]')?.addEventListener('click', () => close(multiple ? null : null));

    if (searchable) {
      bindCommitSearch({
        input: host.querySelector('[data-pp-search]'),
        trigger: host.querySelector('[data-pp-search-submit]'),
        onCommit: (value) => {
          const q = value.trim().toLowerCase();
          host.querySelectorAll('.participant-picker-item').forEach((btn) => {
            const name = String(btn.getAttribute('data-pick-name') || '').toLowerCase();
            btn.style.display = !q || name.includes(q) ? '' : 'none';
          });
        },
      });
    }

    host.querySelectorAll('.participant-picker-item').forEach((btn) => {
      const toggle = btn.querySelector('.participant-picker-toggle') || btn;
      toggle.addEventListener('click', () => {
        const id = String(btn.getAttribute('data-pick-id') || '');
        if (!multiple) { close(id); return; }
        if (selected.has(id)) {
          selected.delete(id);
          btn.classList.remove('is-selected');
        } else {
          selected.add(id);
          btn.classList.add('is-selected');
        }
        toggle.setAttribute('aria-pressed', selected.has(id) ? 'true' : 'false');
        syncCount();
      });
      const input = btn.querySelector('.participant-picker-name-input');
      input?.addEventListener('input', () => {
        const id = String(btn.getAttribute('data-pick-id') || '');
        const name = String(input.value || '').trim();
        btn.setAttribute('data-pick-name', name);
        if (typeof onNameChange === 'function') onNameChange(id, name);
      });
      const remarkInput = btn.querySelector('.participant-picker-remark-input');
      remarkInput?.addEventListener('input', () => {
        const id = String(btn.getAttribute('data-pick-id') || '');
        if (typeof onRemarkChange === 'function') onRemarkChange(id, String(remarkInput.value || '').trim());
      });
    });

    if (multiple) {
      host.querySelector('[data-pp-cancel]')?.addEventListener('click', () => close(null));
      host.querySelector('[data-pp-confirm]')?.addEventListener('click', () => {
        if (editableNames) {
          const invalid = [...host.querySelectorAll('.participant-picker-editable')]
            .find((row) => selected.has(String(row.getAttribute('data-pick-id') || ''))
              && !String(row.querySelector('.participant-picker-name-input')?.value || '').trim());
          if (invalid) {
            const input = invalid.querySelector('.participant-picker-name-input');
            input?.setCustomValidity('请填写姓名');
            input?.reportValidity();
            input?.addEventListener('input', () => input.setCustomValidity(''), { once: true });
            return;
          }
        }
        close([...selected]);
      });
    }
  });
}

/** Glory-compatible alias. */
export const openChatParticipantPicker = openParticipantPicker;
