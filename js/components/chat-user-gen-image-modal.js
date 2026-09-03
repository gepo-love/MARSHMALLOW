/**
 * 聊天工具区：用户自助填 prompt 生图，发送为普通图片（AI 侧识别为用户图片）。
 */
import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import {
  generateImageForScene,
  isNovelAiImageGenerationEnabled,
  isRealisticImageGenerationEnabled,
  loadImageToolConfig,
  persistGeneratedImageUrlLocally,
} from '../core/image-generation-tools.js';
import { upgradeMixedContentMediaUrl } from '../core/media-url.js';
import { mergeImageLockIntoOptions } from '../core/user-image-lock.js';
import {
  applyMultiActorImageLocks,
  buildLockableImageSubjectChoices,
  MAX_MULTI_IDENTITY_SUBJECTS,
} from '../core/multi-actor-image-lock.js';
import { getCurrentUser } from '../core/user-slot.js';
import { normalizeUserRecord } from '../models/user.js';


function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {{ onSend: Function, chat?: object, characters?: object }} options
 * @returns {Promise<boolean>} 是否成功发送
 */
export function openChatUserGenImageModal({ onSend, chat = null, characters = {} } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return Promise.resolve(false);

  return new Promise(async (resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(!!ok);
    };

    const cfg = await loadImageToolConfig().catch(() => ({}));
    const naiOk = isNovelAiImageGenerationEnabled(cfg);
    const realOk = isRealisticImageGenerationEnabled(cfg);
    if (!naiOk && !realOk) {
      showToast('请先在「API 管理 › 生图」启用 NovelAI 或兼容生图');
      resolve(false);
      return;
    }
    const user = normalizeUserRecord(await getCurrentUser().catch(() => null) || {});
    const subjectChoices = buildLockableImageSubjectChoices({
      user,
      participantIds: chat?.participants || [],
      characters,
    });

    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-ugen-overlay>
        <div class="modal-sheet scrapbook-card chat-ugen-sheet" role="dialog" aria-modal="true" data-ugen-sheet>
          <header class="modal-header">
            <h3>生图</h3>
            <button type="button" class="navbar-btn" data-ugen-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body chat-ugen-body" data-ime-scroll-region>
            <label class="api-field">
              <span class="api-field-label">提示词</span>
              <textarea class="form-input chat-ugen-prompt" rows="5" placeholder="描述你想生成的画面…"></textarea>
            </label>
            <label class="api-field">
              <span class="api-field-label">生图渠道</span>
              <select class="form-input chat-ugen-provider">
                <option value="auto" selected>跟随智能（按提示词分流）</option>
                ${naiOk ? '<option value="novelai">NovelAI</option>' : ''}
                ${realOk ? '<option value="realistic">兼容生图（仿真等）</option>' : ''}
              </select>
            </label>
            ${subjectChoices.length ? `
              <fieldset class="api-field chat-ugen-subjects">
                <legend class="api-field-label">画面人物（最多 ${MAX_MULTI_IDENTITY_SUBJECTS} 人）</legend>
                ${subjectChoices.map((item) => `
                  <label class="chat-details-row chat-details-toggle chat-ugen-lock-row">
                    <span>${esc(item.label)}</span>
                    <input type="checkbox" data-ugen-subject value="${esc(item.id)}" ${item.checked ? 'checked' : ''} />
                  </label>
                `).join('')}
              </fieldset>
            ` : ''}
            <p class="text-hint chat-ugen-hint">生成后按普通图片发送；角色侧会当成你发的图，不会识别成 AI 协议生图。</p>
            <div class="chat-ugen-preview is-empty" data-ugen-preview>
              <span>预览区</span>
            </div>
          </div>
          <footer class="modal-footer chat-ugen-footer">
            <button type="button" class="btn btn-outline" data-ugen-gen>${icon('sparkle')}生成</button>
            <button type="button" class="btn btn-primary" data-ugen-send disabled>发送到聊天</button>
          </footer>
        </div>
      </div>
    `;

    let lastUrl = '';
    let lastPrompt = '';
    let lastProvider = '';
    let previewToken = 0;

    const previewEl = host.querySelector('[data-ugen-preview]');
    const sendBtn = host.querySelector('[data-ugen-send]');
    const genBtn = host.querySelector('[data-ugen-gen]');
    const subjectInputs = [...host.querySelectorAll('[data-ugen-subject]')];

    const syncSubjectSelectionLimit = (changedInput = null) => {
      let selected = subjectInputs.filter((input) => input.checked);
      if (selected.length > MAX_MULTI_IDENTITY_SUBJECTS && changedInput) {
        changedInput.checked = false;
        showToast(`一张图最多锁定 ${MAX_MULTI_IDENTITY_SUBJECTS} 人`);
        selected = subjectInputs.filter((input) => input.checked);
      }
      const reachedLimit = selected.length >= MAX_MULTI_IDENTITY_SUBJECTS;
      subjectInputs.forEach((input) => {
        input.disabled = reachedLimit && !input.checked;
        input.closest('label')?.classList.toggle('is-disabled', input.disabled);
      });
    };
    subjectInputs.forEach((input) => {
      input.addEventListener('change', () => syncSubjectSelectionLimit(input));
    });
    syncSubjectSelectionLimit();

    const clearPreview = (hint = '预览区') => {
      lastUrl = '';
      if (!previewEl) return;
      previewEl.classList.add('is-empty');
      previewEl.classList.remove('is-broken');
      previewEl.innerHTML = `<span>${hint}</span>`;
      if (sendBtn) sendBtn.disabled = true;
    };

    const setPreviewBroken = (hint = '预览加载失败，请重试生成') => {
      lastUrl = '';
      if (!previewEl) return;
      previewEl.classList.add('is-empty', 'is-broken');
      previewEl.innerHTML = `<span>${hint}</span>`;
      if (sendBtn) sendBtn.disabled = true;
    };

    /** 仅接受可本地落库的 data URL；远程地址先升级 mixed-content 再交给 img 校验。 */
    const setPreview = (url, { onReady } = {}) => {
      const raw = String(url || '').trim();
      const token = ++previewToken;
      if (!raw) {
        clearPreview();
        return;
      }
      if (!previewEl) return;
      if (sendBtn) sendBtn.disabled = true;
      previewEl.classList.remove('is-empty', 'is-broken');
      previewEl.innerHTML = '';

      const displayUrl = upgradeMixedContentMediaUrl(raw) || raw;
      const img = document.createElement('img');
      img.alt = '生图预览';
      img.decoding = 'async';
      img.addEventListener('load', () => {
        if (token !== previewToken) return;
        lastUrl = raw;
        if (sendBtn) sendBtn.disabled = false;
        onReady?.();
      });
      img.addEventListener('error', () => {
        if (token !== previewToken) return;
        setPreviewBroken('预览加载失败，请重试生成');
        showToast('图片预览失败，请重试生成');
      });
      // 用 DOM 属性赋值，避免超长 data URL 塞进 innerHTML 在部分 WebView 裂图
      img.src = displayUrl;
      previewEl.appendChild(img);
    };

    host.querySelector('[data-ugen-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) finish(false);
    });
    host.querySelectorAll('[data-ugen-close]').forEach((btn) => {
      btn.addEventListener('click', () => finish(false));
    });

    genBtn?.addEventListener('click', async () => {
      const prompt = String(host.querySelector('.chat-ugen-prompt')?.value || '').trim();
      if (!prompt) {
        showToast('请先填写提示词');
        return;
      }
      const providerChoice = String(host.querySelector('.chat-ugen-provider')?.value || 'auto').trim();
      const selectedSubjectIds = [...host.querySelectorAll('[data-ugen-subject]:checked')]
        .map((input) => String(input.value || '').trim())
        .filter(Boolean);
      if (selectedSubjectIds.length > MAX_MULTI_IDENTITY_SUBJECTS) {
        showToast(`一张图最多锁定 ${MAX_MULTI_IDENTITY_SUBJECTS} 人`);
        return;
      }
      const useLock = selectedSubjectIds.length > 0;
      const prev = genBtn.innerHTML;
      genBtn.disabled = true;
      genBtn.textContent = '生成中…';
      if (sendBtn) sendBtn.disabled = true;
      clearPreview('生成中…');
      try {
        let locked = { prompt, providerOverride: '' };
        if (useLock) {
          locked = await applyMultiActorImageLocks(selectedSubjectIds, prompt, {
            forcePortrait: true,
            user,
            characters,
            allowedIds: new Set(['user', ...(chat?.participants || [])]),
          });
        }
        const providerOverride = providerChoice === 'auto'
          ? (locked.providerOverride || '')
          : providerChoice;
        const genOptions = mergeImageLockIntoOptions(locked, {
          providerOverride,
          forcePortrait: useLock || undefined,
        });
        if (locked.referenceSubjects?.length) genOptions.referenceSubjects = locked.referenceSubjects;
        if (locked.subjectIds?.length) genOptions.subjectIds = locked.subjectIds;
        if (providerChoice !== 'auto') {
          genOptions.providerOverride = providerChoice;
          genOptions.referenceProviderFallback = false;
        }
        const result = await generateImageForScene(locked.prompt || prompt, 'chatImages', genOptions);
        let url = String(result?.url || '').trim();
        if (!url) throw new Error('未拿到图片');
        // 必须落到本地 data URL：远程 http(s) 在 APK https 壳会 mixed-content 裂图，且易过期
        url = await persistGeneratedImageUrlLocally(url, { requireLocal: true });
        if (!/^data:image\//i.test(url)) {
          throw new Error('生成成功，但图片未能保存到本地，请重试');
        }
        lastPrompt = prompt;
        lastProvider = String(result?.provider || providerOverride || providerChoice || '');
        setPreview(url, { onReady: () => showToast('已生成，可发送到聊天') });
      } catch (err) {
        clearPreview();
        showToast(`生图失败：${String(err?.message || err).slice(0, 140)}`);
      } finally {
        genBtn.disabled = false;
        genBtn.innerHTML = prev;
      }
    });

    sendBtn?.addEventListener('click', async () => {
      if (!lastUrl || !/^data:image\//i.test(lastUrl)) {
        showToast('请先生成可预览的图片');
        return;
      }
      sendBtn.disabled = true;
      try {
        await onSend?.({ url: lastUrl, prompt: lastPrompt, provider: lastProvider });
        finish(true);
      } catch (err) {
        showToast(`发送失败：${String(err?.message || err).slice(0, 120)}`);
        sendBtn.disabled = false;
      }
    });
  });
}
