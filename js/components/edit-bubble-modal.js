import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import { listStickerPacks } from '../core/sticker-store.js';
import { normalizeVoiceDurationLabel } from '../core/chat/card-render.js';
import { fileToOptimizedChatImageDataUrl } from '../core/chat/chat-image-utils.js';
import { bindVoteOptionEditor, voteOptionEditorHtml } from './vote-editor-modal.js';
import {
  peekStickerThumbSrcMap,
  ensureStickerThumbs,
  applyStickerThumbToImgs,
  stickerDomDisplayFallback,
} from '../core/sticker-thumb-cache.js';

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

const TYPE_LABELS = {
  text: '文本消息',
  textimg: '文字图',
  system: '系统消息',
  voice: '语音消息',
  image: '图片消息',
  sticker: '表情包',
  dice: '骰子',
  vote: '投票',
  storyCard: '线上小剧场',
};

export function buildStoryCardEditPatch(message = {}, draft = {}, editedAt = Date.now()) {
  const msg = message && typeof message === 'object' ? message : {};
  const metadata = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
  const content = String(draft.content || '').trim();
  if (!content) throw new Error('小剧场正文不能为空');
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  const title = String(draft.title || '').trim() || String(metadata.title || '小剧场').trim() || '小剧场';
  const summary = String(draft.summary || '').replace(/\s+/g, ' ').trim()
    || String(paragraphs[0] || content).replace(/\s+/g, ' ').trim().slice(0, 100);
  const isLifeGlimpse = metadata.storyKind === 'life_glimpse' || metadata.lifeGlimpse === true;
  const digest = isLifeGlimpse
    ? content.replace(/\s+/g, ' ').trim().slice(0, 320)
    : summary;
  return {
    content,
    metadata: {
      ...metadata,
      title,
      summary,
      fullText: content,
      paragraphs,
      digest,
      keyDialogues: [],
      followupHook: '',
      manualOverride: true,
      manuallyEditedAt: Number(editedAt) || Date.now(),
      generationStatus: 'complete',
      generationNotice: '',
      generationFailureReason: '',
      generationFailureKind: '',
    },
  };
}

/**
 * @returns {Promise<object|null>} 更新后的 content / metadata / type 字段；取消为 null
 */
export function openEditBubbleModal(message = {}, options = {}) {
  const msg = message && typeof message === 'object' ? message : {};
  const isNarration = msg.metadata?.narratorBeat === true;
  const variant = String(options.variant || '').trim();
  const isAnon = variant === 'anon';
  const sheetClass = isAnon
    ? 'modal-sheet modal-sheet-tall anon-modal-sheet'
    : 'modal-sheet modal-sheet-tall scrapbook-card';
  const type = String(msg.type || 'text').trim() || 'text';
  const isLifeGlimpse = type === 'storyCard'
    && (msg.metadata?.storyKind === 'life_glimpse' || msg.metadata?.lifeGlimpse === true);
  const existingTranslation = String(msg.metadata?.translation || '').trim();
  const editsTranslation = !!existingTranslation && (type === 'text' || type === 'voice');
  if (type === 'system' && msg.senderId !== 'system') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const host = document.getElementById('modal-container');
    if (!host) {
      resolve(null);
      return;
    }

    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-edit-bubble-overlay>
        <div class="${sheetClass}" role="dialog" aria-modal="true" data-edit-bubble-sheet>
          <div class="modal-header">
            <h3>${isNarration ? '编辑旁白' : (isLifeGlimpse ? '编辑生活侧面' : '编辑气泡')}</h3>
            <button type="button" class="navbar-btn eb-close" aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="modal-body">
            <div class="edit-bubble-type-pill">${escapeHtml(isNarration ? '旁白' : (isLifeGlimpse ? '生活侧面' : (TYPE_LABELS[type] || type)))}</div>
            <div class="text-hint edit-bubble-hint">修改后仅更新本条消息，不会触发 AI 重生成</div>
            <div class="eb-fields edit-bubble-fields"></div>
            <button type="button" class="btn btn-primary eb-save edit-bubble-save">保存</button>
          </div>
        </div>
      </div>
    `;

    const close = (result = null) => {
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(result);
    };

    const fieldsEl = host.querySelector('.eb-fields');
    let voteOptionEditor = null;
    let imageDataUrl = String(msg.content || msg.metadata?.url || '').trim();
    let stickerPick = {
      url: String(msg.metadata?.url || msg.content || '').trim(),
      name: String(msg.metadata?.stickerName || msg.metadata?.sticker || '表情包').trim(),
      packName: String(msg.metadata?.packName || '').trim(),
    };

    const renderFields = async () => {
      if (!fieldsEl) return;
      const md = msg.metadata || {};

      if (type === 'storyCard') {
        fieldsEl.innerHTML = `
          <label class="form-label edit-bubble-label">标题</label>
          <input class="form-input eb-story-title" value="${escapeAttr(String(md.title || '小剧场'))}" maxlength="80" />
          <label class="form-label edit-bubble-label">摘要</label>
          <textarea class="form-input eb-story-summary" rows="3" placeholder="留空时从正文自动提取">${escapeHtml(String(md.summary || ''))}</textarea>
          <label class="form-label edit-bubble-label">正文</label>
          <textarea class="form-input eb-story-content" rows="12">${escapeHtml(String(md.fullText || msg.content || ''))}</textarea>
        `;
        return;
      }

      if (type === 'sticker') {
        const packs = await listStickerPacks();
        const stickers = [];
        for (const pack of packs) {
          for (const s of pack.stickers || []) {
            const url = String(s?.url || '').trim();
            if (!url) continue;
            stickers.push({
              id: String(s?.id || '').trim(),
              name: String(s?.name || pack.name || '表情').trim(),
              url,
              packName: String(pack.name || '').trim(),
            });
          }
        }
        const thumbSrcMap = await peekStickerThumbSrcMap(stickers).catch(() => new Map());
        fieldsEl.innerHTML = `
          <label class="form-label edit-bubble-label">选择表情包（可更换）</label>
          <div class="eb-sticker-picker-host" style="max-height:min(38vh,240px);overflow:auto;">
            ${stickers.length
    ? `<div class="chat-sticker-grid">${stickers.map((s, i) => {
      const fallback = stickerDomDisplayFallback(s.url);
      const displaySrc = (s.id && thumbSrcMap.get(s.id)) || fallback;
      const srcAttr = displaySrc ? ` src="${escapeAttr(displaySrc)}"` : '';
      const fallbackAttr = fallback ? ` data-stk-fallback="${escapeAttr(fallback)}"` : '';
      return `
                <button type="button" class="chat-sticker-pick" data-idx="${i}" title="${escapeAttr(s.name)}">
                  <img${srcAttr} alt="${escapeAttr(s.name)}" data-stk-id="${escapeAttr(s.id)}"${fallbackAttr} loading="lazy" decoding="async" />
                </button>`;
    }).join('')}</div>`
    : '<p class="text-hint">还没有表情，可到贴纸管理导入。</p>'}
          </div>
          <div class="eb-sticker-picked text-hint" style="margin-top:6px;font-size:12px;">${stickerPick.url ? `当前：${escapeHtml(stickerPick.name || '表情包')}` : '尚未选择'}</div>
          <label class="form-label edit-bubble-label">附带文字（可空）</label>
          <input class="form-input eb-sticker-caption" value="${escapeAttr(String(md.inlineText || ''))}" placeholder="可选" />
        `;
        const pickedEl = fieldsEl.querySelector('.eb-sticker-picked');
        fieldsEl.querySelectorAll('.chat-sticker-pick').forEach((btn) => {
          btn.addEventListener('click', () => {
            const idx = Number(btn.getAttribute('data-idx'));
            const item = stickers[idx];
            if (!item) return;
            stickerPick = { url: item.url, name: item.name, packName: item.packName || '' };
            if (pickedEl) pickedEl.textContent = `当前：${item.name || '表情包'}`;
          });
        });
        ensureStickerThumbs(stickers, {
          onReady: (id, src) => applyStickerThumbToImgs(fieldsEl, id, src),
        }).catch(() => {});
        return;
      }

      if (type === 'image') {
        fieldsEl.innerHTML = `
          <label class="form-label edit-bubble-label">更换图片（可选）</label>
          <input type="file" class="eb-image-file" accept="image/jpeg,image/png,image/gif,image/webp" style="width:100%;" />
          <div class="eb-image-preview" style="margin-top:8px;${imageDataUrl ? '' : 'display:none;'}">
            ${imageDataUrl ? `<img src="${escapeAttr(imageDataUrl)}" alt="预览" style="max-width:100%;max-height:160px;border-radius:8px;object-fit:contain;" />` : ''}
          </div>
        `;
        const fileInput = fieldsEl.querySelector('.eb-image-file');
        const preview = fieldsEl.querySelector('.eb-image-preview');
        fileInput?.addEventListener('change', async () => {
          const file = fileInput.files?.[0];
          if (!file) return;
          try {
            imageDataUrl = String((await fileToOptimizedChatImageDataUrl(file))?.dataUrl || '');
            if (preview) {
              preview.style.display = imageDataUrl ? 'block' : 'none';
              preview.innerHTML = imageDataUrl
                ? `<img src="${escapeAttr(imageDataUrl)}" alt="预览" style="max-width:100%;max-height:160px;border-radius:8px;object-fit:contain;" />`
                : '';
            }
          } catch (_) {
            showToast('图片读取失败');
          }
          fileInput.value = '';
        });
        return;
      }

      if (type === 'voice') {
        fieldsEl.innerHTML = `
          <label class="form-label edit-bubble-label">${editsTranslation ? '原文（语音转写）' : '语音转写'}</label>
          <textarea class="form-input eb-content" rows="5">${escapeHtml(String(md.text || '').trim())}</textarea>
          ${editsTranslation ? `
          <label class="form-label edit-bubble-label">翻译</label>
          <textarea class="form-input eb-translation" rows="5">${escapeHtml(existingTranslation)}</textarea>` : ''}
          <label class="form-label edit-bubble-label">时长</label>
          <input class="form-input eb-duration" value="${escapeAttr(String(md.duration || '0:05'))}" />
        `;
        return;
      }

      if (type === 'dice') {
        fieldsEl.innerHTML = `
          <label class="form-label edit-bubble-label">面数</label>
          <input type="number" class="form-input eb-sides" min="2" max="100" value="${escapeAttr(String(md.sides || 6))}" />
          <label class="form-label edit-bubble-label">点数</label>
          <input type="number" class="form-input eb-result" min="1" value="${escapeAttr(String(md.result || msg.content || 1))}" />
        `;
        return;
      }

      if (type === 'vote') {
        const opts = Array.isArray(md.voteOptions)
          ? md.voteOptions
          : (Array.isArray(md.options) ? md.options : []);
        fieldsEl.innerHTML = `
          <label class="form-label edit-bubble-label">投票标题</label>
          <input class="form-input eb-vote-title" value="${escapeAttr(String(md.voteTitle || md.title || msg.content || ''))}" />
          <div class="form-label edit-bubble-label vote-option-heading">选项</div>
          ${voteOptionEditorHtml(opts)}
        `;
        return;
      }

      const placeholder = type === 'textimg' ? '文字图内容' : isNarration ? '旁白' : type === 'system' ? '系统提示' : '消息正文';
      fieldsEl.innerHTML = `
        <label class="form-label edit-bubble-label">${editsTranslation ? '原文' : (isNarration ? '旁白' : '内容')}</label>
        <textarea class="form-input eb-content" rows="${type === 'textimg' ? 8 : 6}">${escapeHtml(String(msg.content || ''))}</textarea>
        ${editsTranslation ? `
        <label class="form-label edit-bubble-label">翻译</label>
        <textarea class="form-input eb-translation" rows="6">${escapeHtml(existingTranslation)}</textarea>` : ''}
      `;
      if (type === 'textimg') {
        fieldsEl.querySelector('.eb-content')?.setAttribute('placeholder', placeholder);
      }
    };

    void renderFields().then(() => {
      if (type === 'vote') voteOptionEditor = bindVoteOptionEditor(host);
    });

    host.querySelector('[data-edit-bubble-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-edit-bubble-overlay]')?.addEventListener('click', () => close(null));
    host.querySelector('.eb-close')?.addEventListener('click', () => close(null));

    host.querySelector('.eb-save')?.addEventListener('click', () => {
      if (type === 'storyCard') {
        try {
          close(buildStoryCardEditPatch(msg, {
            title: host.querySelector('.eb-story-title')?.value,
            summary: host.querySelector('.eb-story-summary')?.value,
            content: host.querySelector('.eb-story-content')?.value,
          }));
        } catch (error) {
          showToast(error?.message || '小剧场正文不能为空');
        }
        return;
      }

      if (type === 'sticker') {
        if (!stickerPick.url) {
          showToast('请选择表情包');
          return;
        }
        const caption = String(host.querySelector('.eb-sticker-caption')?.value || '').trim();
        close({
          type: 'sticker',
          content: stickerPick.url,
          metadata: {
            ...(msg.metadata || {}),
            stickerName: stickerPick.name,
            url: stickerPick.url,
            packName: stickerPick.packName || '',
            inlineText: caption,
          },
        });
        return;
      }

      if (type === 'image') {
        if (!imageDataUrl) {
          showToast('请保留或上传图片');
          return;
        }
        close({
          type: 'image',
          content: imageDataUrl,
          metadata: { ...(msg.metadata || {}), url: '', compressedLocalImage: true },
        });
        return;
      }

      if (type === 'voice') {
        const text = String(host.querySelector('.eb-content')?.value || '').trim();
        const duration = normalizeVoiceDurationLabel(host.querySelector('.eb-duration')?.value, 5);
        const metadata = { ...(msg.metadata || {}), text, duration };
        if (editsTranslation) {
          const translation = String(host.querySelector('.eb-translation')?.value || '').trim();
          if (translation) metadata.translation = translation;
          else delete metadata.translation;
          delete metadata.translationRepaired;
        }
        close({
          type: 'voice',
          content: '[语音消息]',
          metadata,
        });
        return;
      }

      if (type === 'dice') {
        const sides = Math.max(2, Math.min(100, Number(host.querySelector('.eb-sides')?.value) || 6));
        const result = Math.max(1, Math.min(sides, Number(host.querySelector('.eb-result')?.value) || 1));
        close({
          type: 'dice',
          content: String(result),
          metadata: { ...(msg.metadata || {}), sides, result },
        });
        return;
      }

      if (type === 'vote') {
        const title = String(host.querySelector('.eb-vote-title')?.value || '').trim();
        const voteOptions = voteOptionEditor?.values() || [];
        if (!title || voteOptions.length < 2) {
          showToast('投票需要标题和至少两个选项');
          return;
        }
        const metadata = {
          ...(msg.metadata || {}),
          title,
          voteTitle: title,
          voteOptions,
        };
        delete metadata.options;
        close({
          type: 'vote',
          content: title,
          metadata,
        });
        return;
      }

      const content = String(host.querySelector('.eb-content')?.value || '').trim();
      if (!content && type !== 'text') {
        showToast('内容不能为空');
        return;
      }
      const metadata = type === 'textimg'
        ? { ...(msg.metadata || {}), caption: content, text: content }
        : { ...(msg.metadata || {}) };
      if (editsTranslation) {
        const translation = String(host.querySelector('.eb-translation')?.value || '').trim();
        if (translation) metadata.translation = translation;
        else delete metadata.translation;
        delete metadata.translationRepaired;
      }
      close({
        type,
        content,
        metadata,
      });
    });
  });
}
