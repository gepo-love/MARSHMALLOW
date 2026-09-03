import { showToast } from './toast.js';
import { icon } from './svg-icons.js';
import { openImageLightbox } from './image-lightbox.js';
import { mountStickerPickerAfterTextarea } from './social-sticker-picker.js';
import { fileToOptimizedChatImageDataUrl } from '../core/chat/chat-image-utils.js';
import {
  generateImageForScene,
  persistGeneratedImageUrlLocally,
} from '../core/image-generation-tools.js';
import {
  appendWeiboComposerMedia,
  clearWeiboComposerDraft,
  hasWeiboComposerDraftContent,
  loadWeiboComposerDraft,
  moveWeiboComposerMedia,
  normalizeWeiboComposerDraft,
  removeWeiboComposerMedia,
  saveWeiboComposerDraft,
  WEIBO_COMPOSER_MAX_MEDIA,
  WEIBO_COMPOSER_MAX_TEXT,
} from '../core/weibo/weibo-composer-store.js';

function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mediaId() {
  return `wb_media_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function openWeiboComposerSheet({ ownerUserId = 'guest', initialTopic = '', initialPost = null, onPublish } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return false;

  const editing = !!initialPost?.id;
  const generatedMedia = Array.isArray(initialPost?.metadata?.generatedMedia) ? initialPost.metadata.generatedMedia : [];
  const mediaIds = Array.isArray(initialPost?.mediaIds) ? initialPost.mediaIds : [];
  let draft = editing
    ? normalizeWeiboComposerDraft({
      id: `wb_edit_${initialPost.id}`,
      text: initialPost.content || '',
      textImage: initialPost.imageKind === 'textimg' ? (initialPost.textImage || '') : '',
      topic: String(initialPost.tags?.[0] || '').replace(/^#+|#+$/g, ''),
      visibility: initialPost.metadata?.visibility || 'public',
      media: (Array.isArray(initialPost.images)
        ? (mediaIds.length ? initialPost.images.slice(0, mediaIds.length) : initialPost.images)
        : []).map((url, index) => {
        const id = mediaIds[index] || `wb_edit_media_${index}`;
        const generated = generatedMedia.find((item) => String(item?.id || '') === String(id));
        return {
          id,
          url,
          source: generated ? 'generated' : 'local',
          prompt: generated?.prompt || '',
          provider: generated?.provider || '',
          status: 'ready',
        };
      }),
    }, ownerUserId)
    : await loadWeiboComposerDraft(ownerUserId).catch(() => null);
  if (!draft) return false;
  if (!draft.topic && initialTopic) {
    draft.topic = String(initialTopic).trim().replace(/^#+|#+$/g, '').slice(0, 80);
  }
  let saveTimer = 0;
  let publishing = false;
  let generating = false;
  let processingFiles = false;

  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay wb-compose-overlay" data-wb-compose-overlay>
      <section class="modal-sheet wb-compose-sheet" role="dialog" aria-modal="true" aria-label="${editing ? '编辑微博' : '发微博'}">
        <header class="wb-compose-header">
          <button type="button" class="wb-compose-cancel" data-wb-compose-close>取消</button>
          <strong>${editing ? '编辑微博' : '发微博'}</strong>
          <button type="button" class="wb-compose-publish" data-wb-compose-publish>${editing ? '保存' : '发布'}</button>
        </header>
        <div class="wb-compose-body">
          <textarea class="wb-compose-text" maxlength="${WEIBO_COMPOSER_MAX_TEXT}" placeholder="分享新鲜事…">${escapeHtml(draft.text)}</textarea>
          <div class="wb-compose-count" data-wb-compose-count></div>
          <div class="wb-compose-media-grid" data-wb-compose-media></div>
          <section class="wb-compose-textimg" data-wb-compose-textimg ${draft.textImage ? '' : 'hidden'}>
            <div class="wb-compose-gen-head"><strong>文字图</strong><button type="button" data-wb-textimg-clear>清除</button></div>
            <textarea class="wb-compose-textimg-input" rows="5" maxlength="1200" placeholder="写下图片里要展示的文字…">${escapeHtml(draft.textImage)}</textarea>
          </section>
          <div class="wb-compose-fields">
            <label>
              <span>话题</span>
              <input type="text" class="wb-compose-topic" maxlength="80" placeholder="可选" value="${escapeHtml(draft.topic)}" />
            </label>
            <label>
              <span>谁可以看</span>
              <select class="wb-compose-visibility">
                <option value="public" ${draft.visibility === 'public' ? 'selected' : ''}>公开</option>
                <option value="fans_only" ${draft.visibility === 'fans_only' ? 'selected' : ''}>粉丝可见</option>
                <option value="private" ${draft.visibility === 'private' ? 'selected' : ''}>仅自己可见</option>
              </select>
            </label>
          </div>
          <section class="wb-compose-gen" data-wb-compose-gen hidden>
            <div class="wb-compose-gen-head"><strong>生成配图</strong><button type="button" data-wb-gen-use-text>根据正文</button></div>
            <textarea class="wb-compose-gen-prompt" rows="3" placeholder="描述想生成的画面…"></textarea>
            <div class="wb-compose-gen-preview" data-wb-gen-preview></div>
            <div class="wb-compose-gen-actions">
              <button type="button" data-wb-gen-run>生成候选图</button>
              <button type="button" class="is-primary" data-wb-gen-add disabled>加入配图</button>
            </div>
          </section>
        </div>
        <footer class="wb-compose-toolbar">
          <button type="button" class="wb-compose-tool" data-wb-compose-pick-image>${icon('image')}<span>上传图片</span></button>
          <input type="file" accept="image/*" multiple data-wb-compose-files hidden aria-hidden="true" tabindex="-1" />
          <button type="button" class="wb-compose-tool" data-wb-compose-open-gen>${icon('sparkle')}<span>生成图片</span></button>
          <button type="button" class="wb-compose-tool" data-wb-compose-open-textimg><span>文字图</span></button>
          <span data-wb-compose-media-count></span>
        </footer>
      </section>
    </div>
  `;

  const sheet = host.querySelector('.wb-compose-sheet');
  const textInput = host.querySelector('.wb-compose-text');
  const topicInput = host.querySelector('.wb-compose-topic');
  const visibilityInput = host.querySelector('.wb-compose-visibility');
  const publishButton = host.querySelector('[data-wb-compose-publish]');
  const mediaGrid = host.querySelector('[data-wb-compose-media]');
  const mediaCount = host.querySelector('[data-wb-compose-media-count]');
  const count = host.querySelector('[data-wb-compose-count]');
  const genPanel = host.querySelector('[data-wb-compose-gen]');
  const genPrompt = host.querySelector('.wb-compose-gen-prompt');
  const genPreview = host.querySelector('[data-wb-gen-preview]');
  const genRunButton = host.querySelector('[data-wb-gen-run]');
  const genAddButton = host.querySelector('[data-wb-gen-add]');
  const textImagePanel = host.querySelector('[data-wb-compose-textimg]');
  const textImageInput = host.querySelector('.wb-compose-textimg-input');

  sheet?.classList.add('modal-sheet-tall');
  mountStickerPickerAfterTextarea(host, '.wb-compose-text');

  const syncDraftFromFields = () => {
    draft.text = String(textInput?.value || '').slice(0, WEIBO_COMPOSER_MAX_TEXT);
    draft.textImage = String(textImageInput?.value || '').slice(0, 1200);
    draft.topic = String(topicInput?.value || '').trim().replace(/^#+|#+$/g, '').slice(0, 80);
    draft.visibility = String(visibilityInput?.value || 'public');
    draft.updatedAt = Date.now();
  };

  const persistDraft = async () => {
    syncDraftFromFields();
    if (editing) return draft;
    draft = await saveWeiboComposerDraft(draft, ownerUserId);
    return draft;
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void persistDraft().catch((error) => console.warn('[weibo] composer draft save failed', error));
    }, 320);
  };

  const updateTextState = () => {
    const length = String(textInput?.value || '').length;
    if (count) count.textContent = `${length}/${WEIBO_COMPOSER_MAX_TEXT}`;
    if (publishButton) publishButton.disabled = publishing
      || generating
      || processingFiles
      || (!String(textInput?.value || '').trim() && !String(textImageInput?.value || '').trim() && !draft.media.length);
  };

  const bindPreviewSources = () => {
    host.querySelectorAll('[data-wb-media-preview]').forEach((img) => {
      const item = draft.media.find((row) => row.id === img.dataset.wbMediaPreview);
      if (item?.url) img.src = item.url;
    });
  };

  const renderMedia = () => {
    if (!mediaGrid) return;
    mediaGrid.hidden = draft.media.length === 0;
    mediaGrid.innerHTML = draft.media.map((item, index) => `
      <div class="wb-compose-media-item" data-wb-media-id="${escapeHtml(item.id)}">
        <button type="button" class="wb-compose-media-preview" aria-label="预览第 ${index + 1} 张图片"><img alt="" data-wb-media-preview="${escapeHtml(item.id)}" /></button>
        <button type="button" class="wb-compose-media-remove" data-wb-media-remove aria-label="删除第 ${index + 1} 张图片">×</button>
        <div class="wb-compose-media-order">
          <button type="button" data-wb-media-move="-1" ${index === 0 ? 'disabled' : ''} aria-label="前移">‹</button>
          <button type="button" data-wb-media-move="1" ${index === draft.media.length - 1 ? 'disabled' : ''} aria-label="后移">›</button>
        </div>
      </div>
    `).join('');
    bindPreviewSources();
    if (mediaCount) mediaCount.textContent = `${draft.media.length}/${WEIBO_COMPOSER_MAX_MEDIA}`;
    mediaGrid.querySelectorAll('[data-wb-media-id]').forEach((itemEl) => {
      const id = itemEl.dataset.wbMediaId;
      itemEl.querySelector('.wb-compose-media-preview')?.addEventListener('click', () => {
        const item = draft.media.find((row) => row.id === id);
        if (item?.url) openImageLightbox(item.url);
      });
      itemEl.querySelector('[data-wb-media-remove]')?.addEventListener('click', () => {
        draft = removeWeiboComposerMedia(draft, id);
        renderMedia();
        updateTextState();
        scheduleSave();
      });
      itemEl.querySelectorAll('[data-wb-media-move]').forEach((button) => {
        button.addEventListener('click', () => {
          draft = moveWeiboComposerMedia(draft, id, Number(button.dataset.wbMediaMove || 0));
          renderMedia();
          scheduleSave();
        });
      });
    });
  };

  const renderCandidate = (status = '') => {
    if (!genPreview) return;
    const candidate = draft.generatedCandidate;
    genPreview.classList.toggle('has-image', !!candidate?.url);
    genPreview.innerHTML = candidate?.url
      ? '<button type="button" aria-label="预览候选图片"><img alt="生图候选" data-wb-gen-candidate /></button>'
      : `<span>${escapeHtml(status || '生成后可预览并加入九宫格')}</span>`;
    const image = genPreview.querySelector('[data-wb-gen-candidate]');
    if (image && candidate?.url) image.src = candidate.url;
    genPreview.querySelector('button')?.addEventListener('click', () => {
      if (candidate?.url) openImageLightbox(candidate.url);
    });
    if (genAddButton) genAddButton.disabled = !candidate?.url || draft.media.length >= WEIBO_COMPOSER_MAX_MEDIA;
  };

  const finish = () => {
    clearTimeout(saveTimer);
    host.classList.remove('active');
    host.innerHTML = '';
  };

  const closeWithDraft = async () => {
    if (publishing || generating || processingFiles) {
      showToast(generating ? '配图生成中，完成后即可退出' : '正在处理，请稍候');
      return;
    }
    await persistDraft().catch(() => {});
    const saved = hasWeiboComposerDraftContent(draft);
    finish();
    if (!editing && saved) showToast('已保存草稿');
  };

  textInput?.addEventListener('input', () => {
    updateTextState();
    scheduleSave();
  });
  textImageInput?.addEventListener('input', () => {
    updateTextState();
    scheduleSave();
  });
  topicInput?.addEventListener('input', scheduleSave);
  visibilityInput?.addEventListener('change', scheduleSave);
  host.querySelectorAll('[data-wb-compose-close]').forEach((button) => button.addEventListener('click', closeWithDraft));
  host.querySelector('[data-wb-compose-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) void closeWithDraft();
  });

  host.querySelector('[data-wb-compose-files]')?.addEventListener('change', async (event) => {
    const input = event.currentTarget;
    const files = [...(input.files || [])];
    input.value = '';
    const available = WEIBO_COMPOSER_MAX_MEDIA - draft.media.length;
    if (!files.length || available <= 0) {
      if (available <= 0) showToast('最多可以发 9 张图片');
      return;
    }
    processingFiles = true;
    updateTextState();
    input.disabled = true;
    if (mediaCount) mediaCount.textContent = '处理中…';
    const additions = [];
    let failed = 0;
    for (const file of files.slice(0, available)) {
      try {
        const result = await fileToOptimizedChatImageDataUrl(file, { forcePortableFormat: true });
        additions.push({ id: mediaId(), url: result.dataUrl, source: 'local', status: 'ready', createdAt: Date.now() });
      } catch (_) {
        failed += 1;
      }
    }
    draft = appendWeiboComposerMedia(draft, additions);
    processingFiles = false;
    input.disabled = false;
    renderMedia();
    updateTextState();
    await persistDraft().catch(() => {});
    if (failed) showToast(`${failed} 张图片读取失败`);
  });

  host.querySelector('[data-wb-compose-pick-image]')?.addEventListener('click', () => {
    host.querySelector('[data-wb-compose-files]')?.click();
  });

  host.querySelector('[data-wb-compose-open-gen]')?.addEventListener('click', () => {
    genPanel.hidden = !genPanel.hidden;
    if (!genPanel.hidden) genPrompt?.focus();
  });
  host.querySelector('[data-wb-compose-open-textimg]')?.addEventListener('click', () => {
    textImagePanel.hidden = !textImagePanel.hidden;
    if (!textImagePanel.hidden) textImageInput?.focus();
  });
  host.querySelector('[data-wb-textimg-clear]')?.addEventListener('click', () => {
    if (textImageInput) textImageInput.value = '';
    draft.textImage = '';
    textImagePanel.hidden = true;
    updateTextState();
    scheduleSave();
  });
  host.querySelector('[data-wb-gen-use-text]')?.addEventListener('click', () => {
    const body = String(textInput?.value || '').trim();
    if (!body) {
      showToast('请先写点正文');
      return;
    }
    genPrompt.value = `自然生活摄影，画面呼应这段微博：${body.slice(0, 500)}`;
  });
  genRunButton?.addEventListener('click', async () => {
    if (generating) return;
    const prompt = String(genPrompt?.value || '').trim()
      || String(textInput?.value || '').trim();
    if (!prompt) {
      showToast('请先填写正文或画面描述');
      return;
    }
    generating = true;
    draft.generatedCandidate = null;
    genRunButton.disabled = true;
    genRunButton.textContent = '生成中…';
    if (genAddButton) genAddButton.disabled = true;
    updateTextState();
    renderCandidate('正在生成候选图…');
    try {
      const result = await generateImageForScene(prompt, 'weiboImages', { aspect: 'square' });
      const url = await persistGeneratedImageUrlLocally(result?.url || '', {
        requireLocal: true,
        optimizeForStorage: true,
      });
      if (!/^data:image\//i.test(url)) throw new Error('生成图片未能保存到本地');
      draft.generatedCandidate = {
        id: mediaId(),
        url,
        source: 'generated',
        status: 'ready',
        prompt,
        provider: String(result?.provider || ''),
        createdAt: Date.now(),
      };
      renderCandidate();
      await persistDraft().catch(() => {});
    } catch (error) {
      draft.generatedCandidate = null;
      renderCandidate(`生图失败：${String(error?.message || error).slice(0, 90)}`);
      showToast(`生图失败：${String(error?.message || error).slice(0, 100)}`);
    } finally {
      generating = false;
      genRunButton.disabled = false;
      genRunButton.textContent = '重新生成';
      updateTextState();
    }
  });
  genAddButton?.addEventListener('click', async () => {
    if (!draft.generatedCandidate?.url) return;
    if (draft.media.length >= WEIBO_COMPOSER_MAX_MEDIA) {
      showToast('最多可以发 9 张图片');
      return;
    }
    draft = appendWeiboComposerMedia(draft, [draft.generatedCandidate]);
    draft.generatedCandidate = null;
    renderMedia();
    renderCandidate();
    updateTextState();
    await persistDraft().catch(() => {});
  });

  publishButton?.addEventListener('click', async () => {
    if (publishing) return;
    syncDraftFromFields();
    if (!draft.text.trim() && !draft.textImage.trim() && !draft.media.length) {
      showToast('写点内容或选择图片后再发布');
      return;
    }
    publishing = true;
    publishButton.disabled = true;
    publishButton.textContent = editing ? '保存中…' : '发布中…';
    try {
      await onPublish?.({
        text: draft.text,
        topic: draft.topic,
        visibility: draft.visibility,
        textImage: draft.textImage,
        media: draft.media.map((item) => ({ ...item })),
      });
      if (!editing) await clearWeiboComposerDraft(ownerUserId);
      finish();
      showToast(editing ? '修改已保存' : '已发布');
    } catch (error) {
      publishing = false;
      publishButton.disabled = false;
      publishButton.textContent = editing ? '重试保存' : '重试发布';
      await persistDraft().catch(() => {});
      showToast(`发布失败：${String(error?.message || error).slice(0, 100)}`);
    }
  });

  renderMedia();
  renderCandidate();
  updateTextState();
  textInput?.focus({ preventScroll: true });
  return true;
}
