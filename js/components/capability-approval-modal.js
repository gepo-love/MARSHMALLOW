import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return error;
}

function argumentPreview(args = {}) {
  const query = String(args?.query || '').replace(/\s+/g, ' ').trim();
  if (query) return query.slice(0, 160);
  const rows = Object.entries(args && typeof args === 'object' ? args : {})
    .slice(0, 4)
    .map(([key, value]) => `${key}：${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return rows.join('\n').slice(0, 280) || '使用当前对话提供的信息';
}

export function openCapabilityApprovalModal(request = {}, options = {}) {
  const host = document.getElementById('modal-container');
  if (!host || (host.classList.contains('active') && host.childElementCount > 0)) {
    return Promise.resolve({ approved: false, reason: 'modal_unavailable' });
  }
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal));

  const actorName = String(request.context?.actorName || '').trim() || 'TA';
  const toolName = String(request.capability?.name || '').trim() || '外部工具';
  const providerName = String(request.provider?.metadata?.label || '').trim();
  const isSearch = request.capability?.id === 'search.web';
  const isMcp = request.provider?.type === 'mcp';
  const canRemember = isMcp && request.capability?.rememberApproval === true;
  const detail = argumentPreview(request.arguments);
  const previousFocus = document.activeElement;

  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center capability-approval-overlay" data-capability-approval-overlay>
      <section class="modal-sheet capability-approval-sheet" role="dialog" aria-modal="true" aria-labelledby="capability-approval-title">
        <div class="capability-approval-body">
          <span class="capability-approval-kicker">${esc(isSearch ? '联网搜索' : `${providerName || 'MCP 工具'}${isMcp ? ' · 尚未人工实测' : ''}`)}</span>
          <h3 id="capability-approval-title">${esc(actorName)} 想使用「${esc(toolName)}」</h3>
          <div class="capability-approval-query">
            ${icon(isSearch ? 'search' : 'zap', 'capability-approval-icon')}
            <span>${esc(detail)}</span>
          </div>
          ${canRemember ? `
            <label class="capability-approval-remember">
              <input type="checkbox" data-capability-remember />
              <span>以后允许这个只读工具</span>
            </label>` : ''}
        </div>
        <footer class="capability-approval-actions">
          <button type="button" class="btn capability-approval-cancel" data-capability-decline>暂不</button>
          <button type="button" class="btn capability-approval-confirm" data-capability-approve>${isSearch ? '允许搜索' : '允许这次'}</button>
        </footer>
      </section>
    </div>
  `;

  return new Promise((resolve, reject) => {
    let settled = false;
    const sheet = host.querySelector('.capability-approval-sheet');
    const approveButton = host.querySelector('[data-capability-approve]');
    const rememberInput = host.querySelector('[data-capability-remember]');
    const focusable = Array.from(host.querySelectorAll('button:not([disabled]), input:not([disabled])'));

    const cleanup = () => {
      document.removeEventListener('keydown', onKeyDown, true);
      options.signal?.removeEventListener?.('abort', onAbort);
      host.innerHTML = '';
      host.classList.remove('active');
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(options.signal));
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish({ approved: false, reason: 'dismissed' });
        return;
      }
      if (event.key !== 'Tab' || focusable.length < 2) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    host.querySelector('[data-capability-decline]')?.addEventListener('click', () => {
      finish({ approved: false, reason: 'declined' });
    });
    rememberInput?.addEventListener('change', () => {
      if (approveButton) approveButton.textContent = rememberInput.checked ? '允许并记住' : '允许这次';
    });
    approveButton?.addEventListener('click', () => finish({
      approved: true,
      remember: canRemember && rememberInput?.checked === true,
    }));
    host.querySelector('[data-capability-approval-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) finish({ approved: false, reason: 'dismissed' });
    });
    sheet?.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('keydown', onKeyDown, true);
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    requestAnimationFrame(() => approveButton?.focus?.({ preventScroll: true }));
  });
}
