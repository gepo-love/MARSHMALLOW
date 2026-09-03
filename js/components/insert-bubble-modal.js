import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import { normalizeVoiceDurationLabel } from '../core/chat/card-render.js';
import { fileToOptimizedChatImageDataUrl } from '../core/chat/chat-image-utils.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function buildSenderSelectOptions({
  isGroupChat,
  groupMembers = [],
  partnerId = '',
  partnerName = '',
  currentUserName = '我',
}) {
  const opts = [
    { value: 'inherit', label: '继承该条消息发送者' },
    { value: 'user', label: `我（${currentUserName}）` },
    { value: 'system', label: '系统（system）' },
  ];
  if (isGroupChat) {
    for (const m of groupMembers) {
      const id = String(m?.id || '').trim();
      if (!id || id === 'user' || id === 'system') continue;
      opts.push({ value: `id:${id}`, label: String(m?.name || id).trim() || id });
    }
  } else {
    const pid = String(partnerId || '').trim();
    if (pid && pid !== 'user' && pid !== 'system') {
      opts.push({ value: `id:${pid}`, label: String(partnerName || pid).trim() || pid });
    }
  }
  return opts;
}

function resolveSenderFromMode(senderMode, anchorMsg, currentUserName, nameById = {}) {
  const mode = String(senderMode || 'inherit');
  if (mode === 'inherit') {
    const sid = String(anchorMsg?.senderId || 'user').trim() || 'user';
    return { senderId: sid, senderName: String(anchorMsg?.senderName || nameById[sid] || '').trim() };
  }
  if (mode === 'user') {
    return { senderId: 'user', senderName: String(currentUserName || '用户').trim() || '用户' };
  }
  if (mode === 'system') {
    return { senderId: 'system', senderName: '' };
  }
  if (mode.startsWith('id:')) {
    const senderId = mode.slice(3);
    return { senderId, senderName: String(nameById[senderId] || '').trim() };
  }
  return { senderId: 'user', senderName: String(currentUserName || '用户').trim() || '用户' };
}

/**
 * @returns {Promise<object|null>} message payload without id/timestamp
 */
export function openInsertBubbleAfterModal(options = {}) {
  const {
    anchorMsg,
    chatId,
    isGroupChat = false,
    groupMembers = [],
    partnerId = '',
    partnerName = '',
    currentUserName = '我',
    includeGroupExtras = false,
    variant = '',
  } = options;
  const isAnon = variant === 'anon';
  const sheetClass = isAnon
    ? 'modal-sheet modal-sheet-tall anon-modal-sheet'
    : 'modal-sheet modal-sheet-tall';

  const nameById = {};
  for (const m of groupMembers) {
    if (m?.id) nameById[m.id] = m.name || m.id;
  }
  if (partnerId) nameById[partnerId] = partnerName || partnerId;

  const senderOptions = buildSenderSelectOptions({
    isGroupChat,
    groupMembers,
    partnerId,
    partnerName,
    currentUserName,
  });

  const typeOptions = [
    { value: 'text', label: '文本消息' },
    { value: 'narration', label: '旁白' },
    { value: 'image', label: '图片消息' },
    { value: 'voice', label: '语音消息' },
    { value: 'system', label: '系统消息' },
    { value: 'textimg', label: '文字图' },
  ];
  if (includeGroupExtras) {
    typeOptions.push({ value: 'dice', label: '骰子' });
  }

  return new Promise((resolve) => {
    const host = document.getElementById('modal-container');
    if (!host) {
      resolve(null);
      return;
    }

    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-insert-bubble-overlay>
        <div class="${sheetClass}" role="dialog" aria-modal="true">
          <div class="modal-header">
            <h3>插入后续气泡</h3>
            <button type="button" class="navbar-btn ib-close" aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="modal-body">
            <div class="text-hint insert-bubble-hint">将插入到当前选中消息后，时间戳自动顺延</div>
            <label class="form-label">消息类型</label>
            <select class="form-input ib-type">
              ${typeOptions.map((o) => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`).join('')}
            </select>
            <label class="form-label insert-bubble-label ib-sender-label">发言人</label>
            <select class="form-input ib-sender">
              ${senderOptions.map((o) => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`).join('')}
            </select>
            <div class="ib-fields insert-bubble-fields"></div>
            <button type="button" class="btn btn-primary ib-save insert-bubble-save">插入</button>
          </div>
        </div>
      </div>
    `;

    const close = (result = null) => {
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(result);
    };

    const typeEl = host.querySelector('.ib-type');
    const senderEl = host.querySelector('.ib-sender');
    const senderLabelEl = host.querySelector('.ib-sender-label');
    const fieldsEl = host.querySelector('.ib-fields');
    let imageDataUrl = '';

    const renderFields = () => {
      const t = String(typeEl?.value || 'text');
      if (!fieldsEl) return;
      const isNarration = t === 'narration';
      if (senderEl) senderEl.hidden = isNarration;
      if (senderLabelEl) senderLabelEl.hidden = isNarration;
      if (t === 'voice') {
        fieldsEl.innerHTML = `
          <label class="form-label insert-bubble-label">语音转写</label>
          <textarea class="form-input ib-content" rows="3" placeholder="说出口的内容"></textarea>
          <label class="form-label insert-bubble-label">时长</label>
          <input type="text" class="form-input ib-duration" value="0:05" />
        `;
        return;
      }
      if (t === 'image') {
        fieldsEl.innerHTML = `
          <label class="form-label insert-bubble-label">图片</label>
          <input type="file" class="ib-image-input" accept="image/*" />
        `;
        fieldsEl.querySelector('.ib-image-input')?.addEventListener('change', async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            imageDataUrl = String((await fileToOptimizedChatImageDataUrl(file))?.dataUrl || '');
          } catch (error) {
            imageDataUrl = '';
            showToast(error?.message || '图片压缩失败');
          }
        });
        return;
      }
      if (t === 'dice') {
        fieldsEl.innerHTML = `
          <label class="form-label insert-bubble-label">面数</label>
          <input type="number" class="form-input ib-sides" min="2" max="100" value="6" />
          <label class="form-label insert-bubble-label">点数（留空随机）</label>
          <input type="number" class="form-input ib-result" min="1" />
        `;
        return;
      }
      const placeholder = t === 'textimg'
        ? '大段文字内容'
        : t === 'narration'
          ? '描述场景、动作或角色状态'
        : t === 'system'
          ? '系统提示内容'
          : '消息正文';
      fieldsEl.innerHTML = `
        <label class="form-label insert-bubble-label">内容</label>
        <textarea class="form-input ib-content" rows="${t === 'textimg' ? 6 : 4}" placeholder="${escapeAttr(placeholder)}">${t === 'text' ? escapeHtml(String(anchorMsg?.content || '')) : ''}</textarea>
      `;
    };

    host.querySelector('.ib-close')?.addEventListener('click', () => close(null));
    host.querySelector('[data-insert-bubble-overlay]')?.addEventListener('click', (e) => {
      if (e.target.matches('[data-insert-bubble-overlay]')) close(null);
    });
    typeEl?.addEventListener('change', renderFields);
    renderFields();

    host.querySelector('.ib-save')?.addEventListener('click', () => {
      const t = String(typeEl?.value || 'text');
      const sender = resolveSenderFromMode(senderEl?.value, anchorMsg, currentUserName, nameById);
      const base = { chatId, senderId: sender.senderId, senderName: sender.senderName };

      if (t === 'narration') {
        const content = String(fieldsEl?.querySelector('.ib-content')?.value || '').trim();
        if (!content) return;
        close({
          ...base,
          senderId: 'system',
          senderName: '旁白',
          type: 'system',
          content,
          metadata: { narratorBeat: true, userInserted: true },
        });
        return;
      }
      if (t === 'system') {
        const content = String(fieldsEl?.querySelector('.ib-content')?.value || '').trim();
        if (!content) return;
        close({ ...base, senderId: 'system', senderName: '', type: 'system', content });
        return;
      }
      if (t === 'image') {
        if (!imageDataUrl) return;
        close({ ...base, type: 'image', content: imageDataUrl, metadata: { compressedLocalImage: true } });
        return;
      }
      if (t === 'voice') {
        const text = String(fieldsEl?.querySelector('.ib-content')?.value || '').trim();
        const duration = normalizeVoiceDurationLabel(fieldsEl?.querySelector('.ib-duration')?.value, 5);
        close({
          ...base,
          type: 'voice',
          content: '[语音消息]',
          metadata: { text, duration },
        });
        return;
      }
      if (t === 'dice') {
        const sides = Math.max(2, Number(fieldsEl?.querySelector('.ib-sides')?.value) || 6);
        let result = Number(fieldsEl?.querySelector('.ib-result')?.value);
        if (!Number.isFinite(result) || result < 1 || result > sides) {
          result = 1 + Math.floor(Math.random() * sides);
        }
        close({
          ...base,
          type: 'dice',
          content: String(result),
          metadata: { sides, result },
        });
        return;
      }
      const content = String(fieldsEl?.querySelector('.ib-content')?.value || '').trim();
      if (!content) return;
      if (t === 'textimg') {
        close({ ...base, type: 'textimg', content, metadata: { caption: content, text: content } });
        return;
      }
      close({ ...base, type: 'text', content });
    });
  });
}
