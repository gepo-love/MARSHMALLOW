import { icon } from './svg-icons.js';
import { resolveVoiceEventDuration } from '../core/chat/card-render.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openTextEditorModal({
  title = '编辑',
  value = '',
  placeholder = '',
  multiline = true,
  centered = false,
  confirmLabel = '保存',
  variant = '',
  details = [],
  onSave,
  onClosed,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  const isAnon = variant === 'anon';
  const sheetClass = isAnon ? 'modal-sheet anon-modal-sheet text-editor-sheet text-editor-sheet--anon' : 'modal-sheet scrapbook-card text-editor-sheet';
  const inputTag = multiline
    ? `<textarea class="form-input text-editor-input" rows="8" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input type="text" class="form-input text-editor-input" value="${esc(value)}" placeholder="${esc(placeholder)}" />`;
  const detailsHtml = (Array.isArray(details) ? details : [])
    .filter((item) => String(item?.content || '').trim())
    .map((item) => `
      <details class="text-editor-details" ${item.open === true ? 'open' : ''}>
        <summary>${esc(item.summary || '附加记录')}</summary>
        <pre>${esc(item.content)}</pre>
      </details>`)
    .join('');
  host.innerHTML = `
    <div class="modal-overlay text-editor-overlay${centered ? ' modal-sheet-center' : ''}" data-text-editor-overlay>
      <div class="${sheetClass}" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>${esc(title)}</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-text-editor-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body" data-ime-scroll-region>
          ${detailsHtml}
          ${inputTag}
          <button type="button" class="btn btn-primary text-editor-save">${esc(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `;
  const input = host.querySelector('.text-editor-input');
  const close = (notifyClosed = true) => {
    host.classList.remove('active');
    host.innerHTML = '';
    if (notifyClosed) onClosed?.();
  };
  host.querySelector('[data-text-editor-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-text-editor-close]')?.addEventListener('click', close);
  host.querySelector('.text-editor-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('.text-editor-save')?.addEventListener('click', async () => {
    const next = String(input?.value || '').trim();
    close(false);
    await onSave?.(next);
  });
  // 同步聚焦保留 iOS 的点击手势授权；preventScroll 避免键盘先按旧布局强行滚页。
  try { input?.focus({ preventScroll: true }); } catch (_) { input?.focus(); }
  requestAnimationFrame(() => {
    if (input?.isConnected && document.activeElement === input) {
      input.scrollIntoView({ block: 'nearest' });
    }
  });
}

/**
 * 语音消息编辑：转写 + 可自定义时长（支持 5、12秒、0:08 等）
 */
export function openVoiceMessageModal({
  title = '语音消息',
  text = '',
  duration = '0:05',
  transcriptPlaceholder = '转写文字（可选）',
  durationPlaceholder = '如 5、12秒、0:08',
  confirmLabel = '发送',
  variant = '',
  autoDurationFromText = false,
  onSave,
  onClosed,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  const isAnon = variant === 'anon';
  const sheetClass = isAnon
    ? 'modal-sheet anon-modal-sheet text-editor-sheet text-editor-sheet--anon'
    : 'modal-sheet scrapbook-card text-editor-sheet';
  host.innerHTML = `
    <div class="modal-overlay" data-voice-message-overlay>
      <div class="${sheetClass}" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>${esc(title)}</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-voice-message-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body">
          <label class="form-label">语音转写</label>
          <textarea class="form-input voice-message-text" rows="5" placeholder="${esc(transcriptPlaceholder)}">${esc(text)}</textarea>
          ${autoDurationFromText
    ? '<p class="text-hint voice-message-duration-hint">时长将按文字长度自动估算</p>'
    : `<label class="form-label">时长</label>
          <input type="text" class="form-input voice-message-duration" value="${esc(duration)}" placeholder="${esc(durationPlaceholder)}" inputmode="decimal" />`}
          <button type="button" class="btn btn-primary voice-message-save">${esc(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `;
  const textEl = host.querySelector('.voice-message-text');
  const durationEl = host.querySelector('.voice-message-duration');
  const close = (notifyClosed = true) => {
    host.classList.remove('active');
    host.innerHTML = '';
    if (notifyClosed) onClosed?.();
  };
  host.querySelector('[data-voice-message-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-voice-message-close]')?.addEventListener('click', close);
  host.querySelector('.text-editor-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('.voice-message-save')?.addEventListener('click', async () => {
    const nextText = String(textEl?.value || '').trim();
    const nextDuration = autoDurationFromText
      ? resolveVoiceEventDuration({}, nextText)
      : String(durationEl?.value || '').trim();
    close(false);
    await onSave?.({ text: nextText, duration: nextDuration });
  });
  textEl?.focus();
}
