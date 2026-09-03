import { icon } from './svg-icons.js';
import { listChatsForUser } from '../core/chat-store.js';
import { formatChatPickerLabelForChat } from '../core/social-helpers.js';
import { isUserPresentInChat } from '../core/chat-helpers.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openMergeForwardPicker({
  userId,
  currentChatId,
  resolveName,
  previewLines = [],
  title = '发给别人',
} = {}) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-container');
    if (!host) {
      resolve(null);
      return;
    }
    (async () => {
      const chats = (await listChatsForUser(userId))
        .filter((c) => c && c.id !== currentChatId)
        .filter((c) => isUserPresentInChat(c))
        .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
      const rows = await Promise.all(chats.slice(0, 40).map(async (c) => ({
        id: c.id,
        label: await formatChatPickerLabelForChat(c, resolveName),
      })));
      host.classList.add('active');
      host.innerHTML = `
        <div class="modal-overlay" data-mf-overlay>
          <div class="modal-sheet scrapbook-card mf-merge-sheet" role="dialog" aria-modal="true">
            <header class="modal-header">
              <h3>${esc(title)}</h3>
              <button type="button" class="navbar-btn modal-close-btn" data-mf-close aria-label="关闭">${icon('close')}</button>
            </header>
            <div class="modal-body">
              <div class="mf-preview">${previewLines.slice(0, 12).map((l) => `<div class="mf-preview-line">${esc(l)}</div>`).join('')}</div>
              <div class="mf-chat-list">
                ${rows.length ? rows.map((r) => `<button type="button" class="btn btn-outline btn-sm mf-pick-chat" data-cid="${esc(r.id)}">${esc(r.label)}</button>`).join('') : '<p class="text-hint">暂无其他会话</p>'}
              </div>
            </div>
          </div>
        </div>
      `;
      const close = (val = null) => {
        host.classList.remove('active');
        host.innerHTML = '';
        resolve(val);
      };
      host.querySelector('[data-mf-overlay]')?.addEventListener('click', () => close(null));
      host.querySelector('[data-mf-close]')?.addEventListener('click', () => close(null));
      host.querySelector('.mf-merge-sheet')?.addEventListener('click', (e) => e.stopPropagation());
      host.querySelectorAll('.mf-pick-chat').forEach((btn) => {
        btn.addEventListener('click', () => close({ mode: 'chat', chatId: btn.getAttribute('data-cid') }));
      });
    })();
  });
}
