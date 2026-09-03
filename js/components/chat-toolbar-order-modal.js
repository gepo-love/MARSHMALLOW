import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rowHtml(item = {}) {
  return `
    <div class="chat-tool-order-row" data-chat-tool-order-id="${esc(item.id)}">
      <button type="button" class="chat-tool-order-drag" data-chat-tool-drag aria-label="拖动 ${esc(item.label)}">⋮⋮</button>
      <span class="chat-tool-order-icon" aria-hidden="true">${item.iconHtml || ''}</span>
      <span class="chat-tool-order-label">${esc(item.label)}</span>
      <button type="button" class="chat-tool-order-first" data-chat-tool-first>置顶</button>
      <button type="button" class="chat-tool-order-step" data-chat-tool-up aria-label="上移 ${esc(item.label)}">↑</button>
      <button type="button" class="chat-tool-order-step" data-chat-tool-down aria-label="下移 ${esc(item.label)}">↓</button>
    </div>`;
}

export function openChatToolbarOrderModal({ items = [], defaultIds = [], onSave, onError } = {}) {
  const host = document.getElementById('modal-container');
  const visibleItems = Array.isArray(items) ? items.filter((item) => item?.id) : [];
  if (!host || !visibleItems.length) return;
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay chat-tool-order-overlay" data-chat-tool-order-overlay>
      <section class="modal-sheet scrapbook-card chat-tool-order-sheet" role="dialog" aria-modal="true" aria-labelledby="chat-tool-order-title">
        <header class="modal-header">
          <h3 id="chat-tool-order-title">工具排序</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-chat-tool-order-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body chat-tool-order-list" data-chat-tool-order-list>
          ${visibleItems.map(rowHtml).join('')}
        </div>
        <footer class="modal-footer chat-tool-order-footer">
          <button type="button" class="btn btn-soft" data-chat-tool-order-reset>恢复默认</button>
          <button type="button" class="btn btn-primary" data-chat-tool-order-save>保存</button>
        </footer>
      </section>
    </div>`;

  const list = host.querySelector('[data-chat-tool-order-list]');
  const overlay = host.querySelector('[data-chat-tool-order-overlay]');
  let dragState = null;
  let saving = false;

  const rows = () => Array.from(list?.querySelectorAll('[data-chat-tool-order-id]') || []);
  const syncControls = () => {
    const currentRows = rows();
    currentRows.forEach((row, index) => {
      const up = row.querySelector('[data-chat-tool-up]');
      const down = row.querySelector('[data-chat-tool-down]');
      const first = row.querySelector('[data-chat-tool-first]');
      if (up) up.disabled = index === 0;
      if (first) first.disabled = index === 0;
      if (down) down.disabled = index === currentRows.length - 1;
    });
  };
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  const moveRow = (row, direction) => {
    if (!row || !list) return;
    if (direction === 'first') list.prepend(row);
    else if (direction === 'up' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    else if (direction === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    syncControls();
    row.querySelector('[data-chat-tool-drag]')?.focus({ preventScroll: true });
  };

  overlay?.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  host.querySelector('[data-chat-tool-order-close]')?.addEventListener('click', close);
  host.querySelector('.chat-tool-order-sheet')?.addEventListener('click', (event) => event.stopPropagation());
  list?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-chat-tool-order-id]');
    if (!row) return;
    if (event.target.closest('[data-chat-tool-first]')) moveRow(row, 'first');
    else if (event.target.closest('[data-chat-tool-up]')) moveRow(row, 'up');
    else if (event.target.closest('[data-chat-tool-down]')) moveRow(row, 'down');
  });

  list?.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-chat-tool-drag]');
    const row = handle?.closest('[data-chat-tool-order-id]');
    if (!handle || !row) return;
    event.preventDefault();
    dragState = { row, handle, pointerId: event.pointerId };
    row.classList.add('is-dragging');
    try { handle.setPointerCapture(event.pointerId); } catch (_) {}
  });
  list?.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId || !list) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-chat-tool-order-id]');
    if (!target || target === dragState.row || !list.contains(target)) return;
    const before = event.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
    list.insertBefore(dragState.row, before ? target : target.nextElementSibling);
    syncControls();
  });
  const endDrag = (event) => {
    if (!dragState || (event && dragState.pointerId !== event.pointerId)) return;
    dragState.row.classList.remove('is-dragging');
    try { dragState.handle.releasePointerCapture(dragState.pointerId); } catch (_) {}
    dragState = null;
  };
  list?.addEventListener('pointerup', endDrag);
  list?.addEventListener('pointercancel', endDrag);

  host.querySelector('[data-chat-tool-order-reset]')?.addEventListener('click', () => {
    if (!list) return;
    const rowMap = new Map(rows().map((row) => [row.getAttribute('data-chat-tool-order-id'), row]));
    defaultIds.forEach((id) => {
      const row = rowMap.get(id);
      if (row) list.appendChild(row);
    });
    syncControls();
  });
  host.querySelector('[data-chat-tool-order-save]')?.addEventListener('click', async (event) => {
    if (saving) return;
    saving = true;
    event.currentTarget.disabled = true;
    try {
      await onSave?.(rows().map((row) => row.getAttribute('data-chat-tool-order-id') || '').filter(Boolean));
      close();
    } catch (error) {
      saving = false;
      event.currentTarget.disabled = false;
      onError?.(error);
    }
  });
  syncControls();
}
