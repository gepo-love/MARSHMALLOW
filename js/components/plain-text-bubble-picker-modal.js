import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 掉格式原文只能由用户逐条确认后写进聊天；取消返回 null。
 * @returns {Promise<string[]|null>}
 */
export function openPlainTextBubblePickerModal({ parts = [] } = {}) {
  const host = document.getElementById('modal-container');
  const candidates = (Array.isArray(parts) ? parts : [])
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!host || !candidates.length) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(value);
    };

    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center plain-bubble-picker-overlay" data-plain-bubble-overlay>
        <div class="modal-sheet modal-sheet-tall plain-bubble-picker-sheet" role="dialog" aria-modal="true" aria-labelledby="plain-bubble-picker-title">
          <header class="modal-header">
            <h3 id="plain-bubble-picker-title">选择要填入的气泡</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-plain-bubble-cancel aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body plain-bubble-picker-body">
            <div class="plain-bubble-picker-list">
              ${candidates.map((part, index) => `
                <div class="plain-bubble-picker-row">
                  <input type="checkbox" class="plain-bubble-picker-check" data-plain-bubble-index="${index}" aria-label="选择第 ${index + 1} 条气泡" />
                  <textarea class="plain-bubble-picker-text" data-plain-bubble-text="${index}" rows="2" maxlength="4000">${esc(part)}</textarea>
                </div>
              `).join('')}
            </div>
          </div>
          <footer class="modal-footer plain-bubble-picker-footer">
            <span class="plain-bubble-picker-count" data-plain-bubble-count>已选 0 条</span>
            <button type="button" class="btn btn-outline" data-plain-bubble-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-plain-bubble-save disabled>填入</button>
          </footer>
        </div>
      </div>
    `;

    const selectedValues = () => Array.from(host.querySelectorAll('.plain-bubble-picker-check:checked'))
      .map((input) => {
        const index = String(input.dataset.plainBubbleIndex || '');
        return String(host.querySelector(`[data-plain-bubble-text="${index}"]`)?.value || '').trim();
      })
      .filter(Boolean);

    const syncCount = () => {
      const count = selectedValues().length;
      const label = host.querySelector('[data-plain-bubble-count]');
      const save = host.querySelector('[data-plain-bubble-save]');
      if (label) label.textContent = `已选 ${count} 条`;
      if (save) save.disabled = count === 0;
    };

    host.querySelector('[data-plain-bubble-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) finish(null);
    });
    host.querySelectorAll('[data-plain-bubble-cancel]').forEach((button) => {
      button.addEventListener('click', () => finish(null));
    });
    host.querySelectorAll('.plain-bubble-picker-check').forEach((input) => {
      input.addEventListener('change', syncCount);
    });
    host.querySelectorAll('.plain-bubble-picker-text').forEach((textarea) => {
      textarea.addEventListener('input', syncCount);
    });
    host.querySelector('[data-plain-bubble-save]')?.addEventListener('click', () => {
      const selected = selectedValues();
      if (selected.length) finish(selected);
    });
  });
}
