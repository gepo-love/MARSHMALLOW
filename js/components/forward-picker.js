import { icon } from './svg-icons.js';
import { listChatsForUser } from '../core/chat-store.js';
import { isAnonymousChat, isUserPresentInChat } from '../core/chat-helpers.js';
import { formatChatPickerLabelForChat } from '../core/social-helpers.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openForwardPicker({
  userId,
  currentChatId,
  resolveName,
  title = '转发到',
  includeAnonymous = true,
  emptyText = '暂无其他会话',
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
        // 转发是用户动作，只能投递到用户本人参与的现有联系人/群聊。
        // 角色手机的 peer_private / NPC 窗也共用 chats 表，不能混进来。
        .filter((c) => isUserPresentInChat(c))
        .filter((c) => includeAnonymous || !isAnonymousChat(c))
        .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
      const rows = await Promise.all(chats.slice(0, 40).map(async (c) => ({
        id: c.id,
        label: await formatChatPickerLabelForChat(c, resolveName),
      })));
      host.classList.add('active');
      host.innerHTML = `
        <div class="modal-overlay" data-fwd-overlay>
          <div class="modal-sheet scrapbook-card mf-merge-sheet" role="dialog" aria-modal="true">
            <header class="modal-header">
              <h3>${esc(title)}</h3>
              <button type="button" class="navbar-btn modal-close-btn" data-fwd-close aria-label="关闭">${icon('close')}</button>
            </header>
            <div class="modal-body">
              <div class="mf-chat-list">
                ${rows.length ? rows.map((r) => `<button type="button" class="btn btn-outline btn-sm mf-pick-chat" data-cid="${esc(r.id)}">${esc(r.label)}</button>`).join('') : `<p class="text-hint">${esc(emptyText)}</p>`}
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
      host.querySelector('[data-fwd-overlay]')?.addEventListener('click', () => close(null));
      host.querySelector('[data-fwd-close]')?.addEventListener('click', () => close(null));
      host.querySelector('.mf-merge-sheet')?.addEventListener('click', (e) => e.stopPropagation());
      host.querySelectorAll('.mf-pick-chat').forEach((btn) => {
        btn.addEventListener('click', () => close({ chatId: btn.getAttribute('data-cid') }));
      });
    })();
  });
}
