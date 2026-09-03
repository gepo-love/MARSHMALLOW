function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openSlotNameModal({ title = '档位名称', value = '', confirmText = '确定' } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(result);
    };

    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-slot-name-overlay>
        <section class="modal-sheet scrapbook-card" role="dialog" aria-modal="true" aria-labelledby="slot-name-title" style="max-width:420px;">
          <header class="modal-header"><h3 id="slot-name-title">${esc(title)}</h3></header>
          <div class="modal-body">
            <label class="api-field">
              <span class="api-field-label">名称</span>
              <input type="text" class="form-input" data-slot-name-input maxlength="80" value="${esc(value)}" autocomplete="off">
            </label>
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn btn-outline" data-slot-name-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-slot-name-confirm>${esc(confirmText)}</button>
          </footer>
        </section>
      </div>`;
    host.classList.add('active');

    const input = host.querySelector('[data-slot-name-input]');
    const submit = () => {
      const name = String(input?.value || '').trim();
      if (!name) {
        input?.focus({ preventScroll: true });
        return;
      }
      finish(name);
    };
    host.querySelector('[data-slot-name-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) finish(null);
    });
    host.querySelector('[data-slot-name-cancel]')?.addEventListener('click', () => finish(null));
    host.querySelector('[data-slot-name-confirm]')?.addEventListener('click', submit);
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      }
    });
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      input?.select();
    });
  });
}
