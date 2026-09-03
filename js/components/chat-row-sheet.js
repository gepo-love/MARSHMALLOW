import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openChatRowSheet({
  chatTitle = '会话',
  pinned = false,
  onTogglePin,
  onDelete,
  onClosed,
  actions,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  const customActions = Array.isArray(actions) ? actions.filter((a) => a && a.label) : [];
  const actionHtml = customActions.length
    ? customActions.map((a, idx) => {
      const danger = a.variant === 'danger' ? ' is-danger' : '';
      return `<button type="button" class="btn btn-outline${danger} chat-row-custom" data-chat-row-custom="${idx}">${esc(a.label)}</button>`;
    }).join('')
    : `
          <button type="button" class="btn btn-outline chat-row-pin">${pinned ? '取消置顶' : '置顶会话'}</button>
          <button type="button" class="btn btn-outline is-danger chat-row-del">删除会话</button>
        `;
  host.innerHTML = `
    <div class="modal-overlay" data-chat-row-overlay>
      <div class="modal-sheet scrapbook-card chat-row-sheet" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>${esc(chatTitle)}</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-chat-row-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body chat-row-sheet-body">
          ${actionHtml}
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
    onClosed?.();
  };
  host.querySelector('[data-chat-row-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-chat-row-close]')?.addEventListener('click', close);
  host.querySelector('.chat-row-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('.chat-row-pin')?.addEventListener('click', async () => {
    await onTogglePin?.();
    close();
  });
  host.querySelector('.chat-row-del')?.addEventListener('click', async () => {
    if (!window.confirm(`删除「${chatTitle}」？聊天记录与相关记忆会一并删除。`)) return;
    await onDelete?.();
    close();
  });
  host.querySelectorAll('.chat-row-custom').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.getAttribute('data-chat-row-custom'));
      const action = customActions[idx];
      if (!action) return;
      close();
      await action.onClick?.();
    });
  });
}
