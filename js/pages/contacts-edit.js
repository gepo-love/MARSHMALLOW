import { back, navigate } from '../core/router.js';
import {
  parseCharacterDraftText,
  mergeCharacterDraft,
  applyCharacterToForm,
  aiFillCharacterDraft,
  summarizeDraftSource,
  buildAiFillReviewFields,
  draftFromSelectedFields,
  resolveCharacterAiRoute,
} from '../core/character-ai-fill.js';
import { openAiFillReviewModal } from '../components/ai-fill-review-modal.js';
import { icon } from '../components/svg-icons.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { describeImageSaveResult, saveImageSrc } from '../components/image-lightbox.js';
import { fileToOptimizedChatImageDataUrl } from '../core/chat/chat-image-utils.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../components/image-crop-modal.js';
import { showToast } from '../components/toast.js';
import {
  loadAppearancePrefs,
  getActiveTheme,
  applySettingsWallpaperPreview,
  isWindowHomeTheme,
  isSeaHomeTheme,
} from '../core/appearance-prefs.js';
import {
  getCharacter,
  saveCharacter,
  saveCharacterForUser,
  listCharacters,
} from '../core/character-store.js';
import { resolveActorDisplayLabel } from '../core/chat/character-code-fallback.js';
import { deleteCharacterCascade } from '../core/data-hygiene.js';
import { isCharacterVoiceTtsEnabled } from '../core/voice-tools.js';
import {
  createEmptyLifeProfile,
  createEmptyResidenceAnchor,
  createCharacterProfile,
  normalizeDialNumber,
  normalizeTranslationProfile,
  ROLE_TIERS,
} from '../models/character.js';
import { loadContactGroupsConfig } from '../core/contact-groups.js';
import { buildCharactersExportPayload, downloadSingleCharacterExport } from '../core/character-export.js';
import { shareToCommunityStore } from '../core/community-share-draft.js';
import {
  generateCharacterImage,
  optimizeImageDataUrlForNovelAiReference,
  persistGeneratedImageUrlLocally,
  isNovelAiImageGenerationEnabled,
  isRealisticImageGenerationEnabled,
  loadImageToolConfig,
} from '../core/image-generation-tools.js';
import { applyCharacterImageLock, resolveImageLockRefUrl } from '../core/character-image-lock.js';
import { listImageStylePresets } from '../core/image-style-presets.js';
import {
  CHARACTER_SECTIONS,
  LIFE_FIELDS,
  MAP_FIELDS,
  MAP_CITY_FIELDS,
} from '../data/character-field-meta.js';
import {
  CHARACTER_PROMPT_TAGS,
  CHARACTER_PROMPT_TAG_ORDER,
} from '../data/character-prompt-tags.js';
import {
  getEffectiveWeatherCityForCharacter,
  fetchWeatherForCity,
  summarizeWeatherForHint,
  summarizeWeatherDisplay,
  weatherSourceLabel,
} from '../core/weather-location.js';
import {
  amapExploreFromSeed,
  bucketPoiLabel,
} from '../core/amap-tools.js';
import {
  assessSpeechCorpusGuideDraft,
  hasSpeechCorpusGuideBlock,
  parseSpeechCorpusGuideBlock,
  replaceSpeechCorpusGuideBlock,
} from '../core/speech-corpus-guide.js';
import { draftSpeechCorpusWithAi } from '../core/speech-corpus-ai.js';
import {
  listAllWorldBookRows,
  listWorldBookRootOptions,
} from '../core/world-book-store.js';
import { getCurrentUser, getUserById } from '../core/user-slot.js';
import { upgradeMixedContentMediaUrl } from '../core/media-url.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function saveImageToDevice(src, button) {
  const url = String(src || '').trim();
  if (!url) {
    showToast('还没有可保存的图片');
    return;
  }
  const previousHtml = button?.innerHTML || '';
  if (button) {
    button.disabled = true;
    button.textContent = '保存中…';
  }
  try {
    const result = await saveImageSrc(url);
    showToast(describeImageSaveResult(result));
  } catch (err) {
    showToast(`保存失败：${String(err?.message || err).slice(0, 100)}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = previousHtml;
    }
  }
}

async function copyText(text = '') {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) {
    /* fall back */
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (_) {
    ok = false;
  }
  ta.remove();
  return ok;
}

function openAiRawResponseModal(rawText = '', { onUse } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const raw = String(rawText || '').trim();
  if (!raw) return;
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-ai-raw-overlay>
      <div class="modal-sheet scrapbook-card ai-fill-sheet ai-raw-sheet" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>AI 返回原文</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-ai-raw-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body ai-fill-body">
          <textarea class="form-input ai-raw-text" rows="12" readonly>${esc(raw)}</textarea>
        </div>
        <footer class="ai-fill-footer">
          <button type="button" class="btn btn-outline" data-ai-raw-copy>复制原文</button>
          <button type="button" class="btn btn-primary" data-ai-raw-use>放回输入框</button>
        </footer>
      </div>
    </div>
  `;
  const sheet = host.querySelector('.ai-raw-sheet');
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-ai-raw-overlay]')?.addEventListener('click', close);
  sheet?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-ai-raw-close]')?.addEventListener('click', close);
  host.querySelector('[data-ai-raw-copy]')?.addEventListener('click', async () => {
    showToast(await copyText(raw) ? '已复制返回原文' : '复制失败');
  });
  host.querySelector('[data-ai-raw-use]')?.addEventListener('click', () => {
    onUse?.(raw);
    close();
  });
}

function aiRouteLabel(route = {}) {
  const source = String(route.sourceLabel || (route.apiSection === 'tool' ? '工具模型' : '主模型')).trim();
  const model = String(route.model || '').trim();
  return model ? `${source} · ${model}` : source;
}

function aiFillDiagnosticRaw(error) {
  return String(
    error?.rawResponse
    || error?.responseText
    || error?.reasoningText
    || error?.upstreamMeta?.reasoningText
    || '',
  ).trim();
}

function openAiFillErrorModal(error, {
  onRetryMain,
  onShowRaw,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const err = error instanceof Error ? error : new Error(String(error || 'AI 补全失败'));
  const route = err.aiRoute || {};
  const routeText = aiRouteLabel(route);
  const requestMode = typeof route.requestStream === 'boolean'
    ? (route.requestStream ? '流式' : '非流式')
    : '';
  const correlationId = String(route.correlationId || err.correlationId || '').trim();
  const diagnosticRaw = aiFillDiagnosticRaw(err);
  const hasRaw = !!diagnosticRaw;
  const canRetryMain = typeof onRetryMain === 'function' && route.apiSection === 'tool';
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-ai-fill-error-overlay>
      <div class="modal-sheet scrapbook-card ai-fill-sheet ai-raw-sheet" role="dialog" aria-modal="true" aria-label="AI 补全失败">
        <header class="modal-header">
          <h3>AI 补全失败</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-ai-fill-error-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body ai-fill-body">
          <p class="ai-fill-subtitle">${esc(String(err.message || '请求失败'))}</p>
          <div class="settings-row-meta">${esc([routeText, requestMode].filter(Boolean).join(' · '))}</div>
          ${correlationId ? `<div class="settings-row-meta">请求编号：${esc(correlationId)}</div>` : ''}
        </div>
        <footer class="ai-fill-footer">
          ${hasRaw ? '<button type="button" class="btn btn-outline" data-ai-fill-error-raw>查看原文</button>' : ''}
          ${canRetryMain ? '<button type="button" class="btn btn-primary" data-ai-fill-retry-main>改用主模型重试</button>' : '<button type="button" class="btn btn-primary" data-ai-fill-error-close>关闭</button>'}
        </footer>
      </div>
    </div>
  `;
  const sheet = host.querySelector('.ai-raw-sheet');
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-ai-fill-error-overlay]')?.addEventListener('click', close);
  sheet?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelectorAll('[data-ai-fill-error-close]').forEach((button) => button.addEventListener('click', close));
  host.querySelector('[data-ai-fill-error-raw]')?.addEventListener('click', () => {
    close();
    onShowRaw?.(diagnosticRaw);
  });
  host.querySelector('[data-ai-fill-retry-main]')?.addEventListener('click', () => {
    close();
    onRetryMain?.();
  });
}

function openSpeechCorpusGuideModal(existing = '', {
  character = {},
  user = null,
  worldBookOptions = [],
  onApply,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const draft = parseSpeechCorpusGuideBlock(existing);
  const bookOptions = Array.isArray(worldBookOptions) ? worldBookOptions : [];
  const worldBookChoices = bookOptions.length
    ? bookOptions.map((book) => `
      <label class="contacts-corpus-worldbook-option">
        <input type="checkbox" value="${esc(book.id)}" data-corpus-worldbook>
        <span>${esc(book.name)}</span>
      </label>
    `).join('')
    : '<div class="contacts-corpus-worldbook-empty">暂无可选世界书</div>';
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay contacts-corpus-guide-overlay">
      <div class="modal-sheet contacts-corpus-guide-sheet" role="dialog" aria-modal="true" aria-labelledby="contacts-corpus-guide-title">
        <header class="modal-header">
          <div>
            <h3 id="contacts-corpus-guide-title">语料工作台</h3>
            <p>写 TA 会怎么反应，比罗列禁词更有效</p>
          </div>
          <button type="button" class="navbar-btn modal-close-btn" data-corpus-guide-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body contacts-corpus-guide-body" data-ime-scroll-region>
          <section class="contacts-corpus-ai-draft">
            <div class="contacts-corpus-ai-draft-head">
              <div>
                <strong>AI 起草</strong>
                <span>生成后可逐项修改，不会直接保存</span>
              </div>
              <button type="button" class="btn btn-primary" data-corpus-ai-draft>${icon('sparkle')}生成草稿</button>
            </div>
            <details class="contacts-corpus-worldbooks">
              <summary>
                <span>参考世界书</span>
                <em data-corpus-worldbook-summary>按当前绑定规则</em>
              </summary>
              <div class="contacts-corpus-worldbook-list">${worldBookChoices}</div>
              <p>不勾选时按角色绑定与启用规则读取；勾选后只读所选世界书。</p>
            </details>
          </section>
          <label class="contacts-corpus-guide-field">
            <span>节奏与标点</span>
            <textarea class="form-input" data-corpus-guide-key="rhythm" rows="3" maxlength="500" placeholder="如：日常一句或一个完整气口一条；解释时会用长句；句号少，停顿更常用空格">${esc(draft.rhythm)}</textarea>
          </label>
          <label class="contacts-corpus-guide-field">
            <span>情绪与分寸</span>
            <textarea class="form-input" data-corpus-guide-key="emotion" rows="3" maxlength="500" placeholder="如：耐心阈值高；遇到小事先确认情况，再给出简短反应，不轻易升级情绪">${esc(draft.emotion)}</textarea>
          </label>
          <label class="contacts-corpus-guide-field">
            <span>情境反应</span>
            <textarea class="form-input" data-corpus-guide-key="situations" rows="6" maxlength="1200" placeholder="每行一种：&#10;被调侃时 → 先顺着梗回一句，再轻轻反击&#10;对方低落时 → 不讲大道理，先问具体发生了什么">${esc(draft.situations)}</textarea>
          </label>
          <div class="contacts-corpus-situation-seeds" aria-label="添加常见情境">
            ${[
              ['被调侃时', '被调侃时 → '],
              ['快生气时', '快生气时 → '],
              ['不懂梗时', '不懂梗时 → '],
              ['对方低落时', '对方低落时 → '],
              ['关系越界时', '关系越界时 → '],
            ].map(([label, value]) => `<button type="button" data-corpus-situation="${esc(value)}">${esc(label)}</button>`).join('')}
          </div>
          <label class="contacts-corpus-guide-field">
            <span>梗与玩笑</span>
            <textarea class="form-input" data-corpus-guide-key="humor" rows="3" maxlength="500" placeholder="如：熟梗会直接接；陌生梗先接情绪或问一句来源，不会大惊小怪">${esc(draft.humor)}</textarea>
          </label>
          <label class="contacts-corpus-guide-field">
            <span>台词样本</span>
            <textarea class="form-input" data-corpus-guide-key="examples" rows="6" maxlength="1600" placeholder="每行一句。真实原话优先；AI 拟写后请手改到像 TA，保留自然的长短、停顿与标点">${esc(draft.examples)}</textarea>
          </label>
          <label class="contacts-corpus-guide-field">
            <span>连续气泡样本</span>
            <textarea class="form-input" data-corpus-guide-key="sequences" rows="8" maxlength="2400" placeholder="同一轮逐行写，每行就是一个气泡；不同回合空一行：&#10;你先说&#10;我听着&#10;&#10;不是&#10;你等会儿&#10;这事让我想想">${esc(draft.sequences)}</textarea>
          </label>
          <details class="contacts-corpus-guide-help">
            <summary>怎么写更有效</summary>
            <ul>
              <li>日常先写一句一气口；长串口语、书面句和标点再按 TA 的习惯补充。</li>
              <li>行为模式写成“什么情况下 → 会怎么做或怎么说”。</li>
              <li>真实原话保留自然瑕疵；AI 拟写的台词要手改后再用。</li>
              <li>连续气泡按真实发送边界换行，能直接教会 AI 哪里该拆成多条。</li>
            </ul>
          </details>
          <div class="contacts-corpus-guide-status" role="status" aria-live="polite"></div>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn btn-outline" data-corpus-guide-close>取消</button>
          <button type="button" class="btn btn-primary" data-corpus-guide-apply>写入语料库</button>
        </footer>
      </div>
    </div>`;

  let closed = false;
  let aiController = null;
  const close = () => {
    closed = true;
    aiController?.abort();
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelectorAll('[data-corpus-guide-close]').forEach((button) => button.addEventListener('click', close));
  host.querySelector('.contacts-corpus-guide-overlay')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) close();
  });
  const situationInput = host.querySelector('[data-corpus-guide-key="situations"]');
  host.querySelectorAll('[data-corpus-situation]').forEach((button) => {
    button.addEventListener('click', () => {
      const seed = String(button.getAttribute('data-corpus-situation') || '');
      if (!situationInput || !seed) return;
      const current = String(situationInput.value || '').trim();
      if (!current.split('\n').some((line) => line.trim().startsWith(seed.trim()))) {
        situationInput.value = [current, seed].filter(Boolean).join('\n');
      }
      situationInput.focus();
      situationInput.setSelectionRange(situationInput.value.length, situationInput.value.length);
    });
  });
  const collectGuideDraft = () => {
    const nextDraft = {};
    host.querySelectorAll('[data-corpus-guide-key]').forEach((field) => {
      nextDraft[field.getAttribute('data-corpus-guide-key')] = field.value;
    });
    return nextDraft;
  };
  const selectedWorldBookIds = () => [...host.querySelectorAll('[data-corpus-worldbook]:checked')]
    .map((input) => String(input.value || '').trim())
    .filter(Boolean);
  const refreshWorldBookSummary = () => {
    const summary = host.querySelector('[data-corpus-worldbook-summary]');
    if (!summary) return;
    const count = selectedWorldBookIds().length;
    summary.textContent = count ? `已选 ${count} 本` : '按当前绑定规则';
  };
  host.querySelectorAll('[data-corpus-worldbook]').forEach((input) => {
    input.addEventListener('change', refreshWorldBookSummary);
  });
  host.querySelector('[data-corpus-ai-draft]')?.addEventListener('click', async () => {
    const aiButton = host.querySelector('[data-corpus-ai-draft]');
    const applyButton = host.querySelector('[data-corpus-guide-apply]');
    const status = host.querySelector('.contacts-corpus-guide-status');
    if (!aiButton || aiButton.disabled) return;
    aiController = new AbortController();
    aiButton.disabled = true;
    if (applyButton) applyButton.disabled = true;
    aiButton.textContent = '起草中…';
    try {
      const result = await draftSpeechCorpusWithAi({
        character,
        user,
        worldBookIds: selectedWorldBookIds(),
        currentDraft: collectGuideDraft(),
        signal: aiController.signal,
        onProgress: (message) => {
          if (!closed && status) status.textContent = message;
        },
      });
      if (closed) return;
      Object.entries(result.draft).forEach(([key, value]) => {
        const field = host.querySelector(`[data-corpus-guide-key="${key}"]`);
        if (field) field.value = value;
      });
      if (status) {
        if (result.usedWorldBookMode === 'selected') {
          status.textContent = result.usedWorldBookContext
            ? `草稿已填入，并参考了所选 ${result.selectedBookCount} 本世界书；请修改后再写入。`
            : '所选世界书没有可用条目；草稿已按角色资料填入，请修改后再写入。';
        } else {
          status.textContent = result.usedWorldBookContext
            ? '草稿已填入，并按当前绑定规则参考世界书；请修改后再写入。'
            : '当前没有命中世界书；草稿已按角色资料填入，请修改后再写入。';
        }
      }
      showToast('AI 草稿已填入，请先检查和修改');
    } catch (error) {
      if (closed || error?.name === 'AbortError') return;
      const message = String(error?.message || error || '生成失败');
      if (status) status.textContent = message;
      showToast(message);
    } finally {
      aiController = null;
      if (!closed) {
        aiButton.disabled = false;
        if (applyButton) applyButton.disabled = false;
        aiButton.innerHTML = `${icon('sparkle')}生成草稿`;
      }
    }
  });
  host.querySelector('[data-corpus-guide-apply]')?.addEventListener('click', () => {
    const nextDraft = collectGuideDraft();
    const assessment = assessSpeechCorpusGuideDraft(nextDraft);
    const status = host.querySelector('.contacts-corpus-guide-status');
    if (!assessment.ready) {
      if (status) status.textContent = assessment.question;
      const first = [...host.querySelectorAll('[data-corpus-guide-key]')].find((field) => !field.value.trim());
      first?.focus();
      return;
    }
    const next = replaceSpeechCorpusGuideBlock(existing, nextDraft);
    if (typeof onApply === 'function') onApply(next, assessment);
    close();
  });

  const firstEmpty = [...host.querySelectorAll('[data-corpus-guide-key]')]
    .find((field) => !String(field.value || '').trim());
  firstEmpty?.focus();
}

/**
 * AI 描绘/生成预览结果弹窗。
 * options.onUseAvatar：设为头像；options.onUseRef 存在时额外显示「设为锁定参考图」按钮
 * （不改头像，只把这张测试结果单独存成生图锁定用的专属参考图，更准且不受头像变动影响）。
 */
function openCharacterDrawPreview(url, options = {}) {
  const { onUseAvatar, onUseRef } = typeof options === 'function' ? { onUseAvatar: options } : options;
  const host = document.getElementById('modal-container');
  if (!host) {
    onUseAvatar?.();
    return;
  }
  host.innerHTML = `
    <div class="modal-overlay" data-draw-overlay>
      <div class="modal-sheet scrapbook-card" role="dialog" aria-modal="true" style="max-width:360px;" data-draw-sheet>
        <div class="modal-header"><h3>AI 描绘结果</h3></div>
        <div class="modal-body" style="padding-top:0;">
          <img src="${esc(url)}" alt="角色描绘" style="width:100%;border-radius:12px;display:block;" />
        </div>
        <div class="modal-body" style="display:flex;flex-wrap:wrap;gap:8px;padding-top:0;">
          <button type="button" class="btn btn-primary btn-block" data-draw-use>设为头像</button>
          ${onUseRef ? '<button type="button" class="btn btn-soft btn-block" data-draw-use-ref>设为锁定参考图</button>' : ''}
          <button type="button" class="btn btn-outline btn-block" data-draw-save>${icon('download')}保存到本地</button>
          <button type="button" class="btn btn-outline btn-block" data-draw-close>关闭</button>
        </div>
      </div>
    </div>
  `;
  host.classList.add('active');
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-draw-overlay]')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  host.querySelector('[data-draw-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-draw-close]')?.addEventListener('click', close);
  host.querySelector('[data-draw-save]')?.addEventListener('click', (e) => {
    saveImageToDevice(url, e.currentTarget);
  });
  host.querySelector('[data-draw-use]')?.addEventListener('click', () => {
    onUseAvatar?.();
    close();
  });
  host.querySelector('[data-draw-use-ref]')?.addEventListener('click', () => {
    onUseRef?.();
    close();
  });
}

function renderHoles() {
  return `
    <div class="classbook-holes" aria-hidden="true">
      <span class="classbook-hole"></span>
      <span class="classbook-hole"></span>
      <span class="classbook-hole"></span>
    </div>
  `;
}

function field(label, inner, aiHint) {
  const ai = aiHint ? `<span class="contacts-field-ai">${esc(aiHint)}</span>` : '';
  return `
    <label class="contacts-field">
      <span class="contacts-field-label"><span>${esc(label)}</span>${ai}</span>
      ${inner}
    </label>
  `;
}

const IMAGE_LOCK_MODES = ['none', 'prompt', 'seed', 'reference'];

function renderImageStyleOptions(selectedId = '') {
  const current = String(selectedId || '').trim();
  const group = (label, presets) => (presets.length
    ? `<optgroup label="${esc(label)}">${presets.map((p) => `<option value="${esc(p.id)}" ${current === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>`
    : '');
  return [
    `<option value="" ${current ? '' : 'selected'}>跟随全局默认</option>`,
    group('兼容人物（gpt / gemini 等中转）', listImageStylePresets('realistic')),
    group('NovelAI 二次元', listImageStylePresets('novelai')),
  ].join('');
}

/** 参考图缩略区：显示当前锁定用的图（专属参考图优先，否则回落头像）+ 上传/清除 */
function renderLockRefBlock(char, mode = 'none') {
  const lock = char.imageLock || {};
  const refUrl = String(lock.refImageUrl || '').trim();
  const preview = refUrl || String(char.avatar || '').trim();
  return `
    <div class="contacts-lock-ref-row" data-lock-ref-row ${mode === 'reference' ? '' : 'hidden'}>
      <div class="contacts-lock-ref-preview" data-lock-ref-preview>${preview ? `<img src="${esc(preview)}" alt="锁定参考图">` : '<span>暂无参考图</span>'}</div>
      <div class="contacts-lock-ref-main">
        <div class="contacts-lock-ref-actions">
          <label class="btn btn-sm btn-outline contacts-lock-ref-upload">上传参考图<input type="file" accept="image/*" hidden class="contacts-lock-ref-file"></label>
          <button type="button" class="btn btn-sm btn-soft contacts-lock-ref-clear" data-lock-ref-clear ${refUrl ? '' : 'hidden'}>改用头像</button>
        </div>
        <span class="contacts-lock-ref-hint" data-lock-ref-hint>${refUrl ? '已设置专属参考图，头像换成别的也不受影响' : '暂用当前头像做参考图；头像变动会跟着变，建议上传或用下方「生成预览」的结果单独锁定一张更准的参考图'}</span>
      </div>
    </div>
  `;
}

function renderImageLock(char, naiEnabled = false, referenceEnabled = false) {
  const lock = char.imageLock || { mode: 'none', prompt: '', seed: '', refImageUrl: '' };
  const mode = IMAGE_LOCK_MODES.includes(lock.mode) ? lock.mode : 'none';
  const opt = (val, label, disabled) => `<option value="${val}" ${mode === val ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(label)}</option>`;
  const refNote = naiEnabled
    ? '参考图会用 NovelAI Vibe Transfer；换场景/换提示词也尽量贴近同一张脸/画风'
    : '参考图会用兼容生图 gpt-image 编辑接口（软锁脸，无 seed，效果因中转/模型而异）';
  return `
    <div class="contacts-lock" data-lock>
      <div class="contacts-lock-head">
        <span class="contacts-lock-title">生图锁定 · 锁人设</span>
        <select class="contacts-select contacts-lock-mode" data-lock-mode>
          ${opt('none', '不锁定', false)}
          ${opt('prompt', '提示词锁定（通用）', false)}
          ${opt('seed', `Seed 锁定（NovelAI）${naiEnabled ? '' : ' · 未配置'}`, !naiEnabled)}
          ${opt('reference', `参考图锁定${referenceEnabled ? '' : ' · 未配置'}`, !referenceEnabled)}
        </select>
      </div>
      <div class="contacts-lock-body" data-lock-body ${mode === 'none' ? 'hidden' : ''}>
        <textarea class="contacts-textarea contacts-lock-prompt" data-lock-prompt rows="3" placeholder="锁定的外观提示词（留空用上面的「生图外观描述」）" ${mode === 'reference' ? 'hidden' : ''}>${esc(lock.prompt || '')}</textarea>
        <div class="contacts-lock-seed-row" data-lock-seed-row ${mode === 'seed' ? '' : 'hidden'}>
          <input class="contacts-input contacts-lock-seed" data-lock-seed inputmode="numeric" placeholder="Seed（留空随机一次并记住）" value="${esc(lock.seed || '')}">
        </div>
        ${renderLockRefBlock(char, mode)}
        <div class="contacts-lock-actions">
          <button type="button" class="btn btn-sm btn-soft contacts-lock-gen" data-lock-gen>${icon('sparkle')}生成预览</button>
          <span class="contacts-lock-note" data-lock-note ${mode === 'reference' ? '' : 'hidden'}>${esc(refNote)}</span>
        </div>
      </div>
    </div>
  `;
}

const IDENTITY_PERSONA_SCALAR_KEYS = Object.freeze([
  'currentRole',
  'userRelationStatus',
  'promptCorpus',
  'commonEmotes',
  'personality',
  'speechStyle',
  'speechCorpus',
  'currentStatus',
]);

export function clearIdentityCharacterPersona(profile = {}) {
  return createCharacterProfile({
    ...profile,
    ...Object.fromEntries(IDENTITY_PERSONA_SCALAR_KEYS.map((key) => [key, ''])),
    promptTags: [],
    lifeProfile: createEmptyLifeProfile(),
    residenceAnchor: createEmptyResidenceAnchor(),
  });
}

function applyClearedIdentityPersonaToForm(profile, host) {
  if (!profile || !host) return;
  IDENTITY_PERSONA_SCALAR_KEYS.forEach((key) => {
    const fieldEl = host.querySelector(`[data-key="${key}"]`);
    if (fieldEl) fieldEl.value = profile[key] || '';
  });
  host.querySelectorAll('[data-prompt-tag]').forEach((fieldEl) => {
    fieldEl.checked = false;
  });
  ['lifeProfile', 'residenceAnchor'].forEach((prefix) => {
    host.querySelectorAll(`[data-nested^="${prefix}."]`).forEach((fieldEl) => {
      fieldEl.value = '';
    });
  });
}

function renderProfileSheet(char, naiEnabled = false, referenceEnabled = false, identityScope = false) {
  const avatarInner = characterAvatarHtml(char, { className: 'contacts-avatar-img' });
  return `
    <div class="classbook-page classbook-sheet is-active" data-sheet="cover">
      ${renderHoles()}
      <h2 class="classbook-sheet-title">角色资料</h2>
      <p class="classbook-sheet-sub">只需填写基础设定，其余字段可用 AI 补全</p>
      <div class="contacts-avatar-row">
        <div class="contacts-avatar-preview contacts-avatar-box">${avatarInner}</div>
        <div class="contacts-avatar-actions">
          <label class="btn btn-sm btn-outline contacts-avatar-upload">换头像<input type="file" accept="image/*" hidden class="contacts-avatar-file"></label>
          <button type="button" class="btn btn-sm btn-outline contacts-avatar-draw">${icon('image')}AI 描绘</button>
          <button type="button" class="btn btn-sm btn-outline contacts-avatar-save" ${char.avatar ? '' : 'hidden'}>${icon('download')}保存头像</button>
          <button type="button" class="btn btn-sm btn-soft contacts-avatar-clear">清除</button>
          <label class="btn btn-sm btn-outline contacts-doc-upload">上传文档<input type="file" accept=".txt,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden class="contacts-doc-file"></label>
        </div>
      </div>

      <div class="contacts-group-label">基本</div>
      ${field('备注名', `<input class="contacts-input" data-key="name" value="${esc(char.name)}" placeholder="通讯录里看到的名字">`)}
      ${field('真名', `<input class="contacts-input" data-key="realName" value="${esc(char.realName)}" placeholder="角色本名，可与备注名相同">`, '进 AI 角色卡')}
      ${field('别名', `<input class="contacts-input" data-key="aliases" value="${esc((char.aliases || []).join(' / '))}" placeholder="多个用 / 分隔">`, '进 AI 角色卡')}
      ${field('身份', `<input class="contacts-input" data-key="currentRole" value="${esc(char.currentRole)}" placeholder="职业、身份、一句话定位">`)}
      ${field('性别', `<input class="contacts-input" data-key="gender" value="${esc(char.gender || '')}" placeholder="如：男性、女性、非二元">`, '进 AI 角色卡')}
      ${field('第三人称代词', `<input class="contacts-input" data-key="pronouns" value="${esc(char.pronouns || '')}" placeholder="如：他、她、TA">`, '进 AI 角色卡')}
      ${field('与用户关系状态', `<input class="contacts-input" data-key="userRelationStatus" value="${esc(char.userRelationStatus || '')}" placeholder="如：刚认识、暧昧期、恋人、互相试探">`, '进 AI 角色卡')}

      <div class="contacts-group-label">
        <span>设定</span><span class="contacts-group-note">聊天与日程的核心</span>
        ${identityScope ? '<button type="button" class="contacts-persona-clear">清空当前档位人设</button>' : ''}
      </div>
      <div class="contacts-field contacts-corpus-field">
        <span class="contacts-field-label contacts-corpus-label">
          <span>整段设定</span>
          <button type="button" class="contacts-corpus-ai contacts-ai-fill-empty">${icon('sparkle')}根据设定补全字段</button>
        </span>
        <textarea class="contacts-textarea contacts-long-text" data-key="promptCorpus" rows="12" aria-label="整段设定" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="直接粘贴整段人物设定、角色卡、外貌、背景、关系、性格调色盘等">${esc(char.promptCorpus || '')}</textarea>
        <span class="contacts-corpus-guide">写好后可让 AI 补全空白资料；已填写的字段不会被改动。</span>
      </div>
      ${field('常用 Emoji / 颜文字', `<textarea class="contacts-textarea" data-key="commonEmotes" rows="2" placeholder="如：🥺 / 🤏 / (｡>﹏<｡) / _(:з」∠)_">${esc(char.commonEmotes || '')}</textarea>`, '自然少量使用')}
      ${field('生图外观描述', `<textarea class="contacts-textarea" data-key="appearancePrompt" rows="4" placeholder="外貌、发型、穿搭、气质，或角色专用生图提示词">${esc(char.appearancePrompt || '')}</textarea>`, '生图参考')}
      ${field('专属画风', `<select class="contacts-select" data-key="imageStyleId">${renderImageStyleOptions(char.imageStyleId)}</select>`, 'TA 的人物图用哪种画风/引擎')}
      <div class="contacts-lock-host">${renderImageLock(char, naiEnabled, referenceEnabled)}</div>
    </div>
  `;
}

const TRANSLATION_MODE_OPTIONS = [
  ['off', '不需要'],
  ['full', '主要讲外语 / 方言（整句气泡翻译）'],
  ['mixed', '日常中文，偶尔蹦外语/方言（就地括注翻译）'],
];

const TRANSLATION_LANGUAGE_OPTIONS = [
  ['', '由 AI 按人设判断'],
  ['英语', '英语'],
  ['日语', '日语'],
  ['韩语', '韩语'],
  ['法语', '法语'],
  ['德语', '德语'],
  ['西班牙语', '西班牙语'],
  ['葡萄牙语', '葡萄牙语'],
  ['意大利语', '意大利语'],
  ['俄语', '俄语'],
  ['阿拉伯语', '阿拉伯语'],
  ['泰语', '泰语'],
  ['越南语', '越南语'],
  ['印尼语', '印尼语'],
  ['土耳其语', '土耳其语'],
  ['荷兰语', '荷兰语'],
  ['粤语', '粤语（方言）'],
];

function renderStyleSheet(char) {
  const selectedTags = new Set(Array.isArray(char.promptTags) ? char.promptTags : []);
  const corpusText = String(char.speechCorpus || '').trim();
  const corpusStatus = corpusText
    ? `${corpusText.length} 字${hasSpeechCorpusGuideBlock(corpusText) ? ' · 已整理行为模式' : ' · 可继续补情境'}`
    : '尚未填写 · 建议先补两种情境';
  const tagOptions = CHARACTER_PROMPT_TAG_ORDER.map((id) => {
    const tag = CHARACTER_PROMPT_TAGS[id];
    if (!tag) return '';
    return `
      <label class="contacts-prompt-tag">
        <input type="checkbox" data-prompt-tag="${esc(id)}" ${selectedTags.has(id) ? 'checked' : ''} />
        <span>
          <strong>${esc(tag.label)}</strong>
          <small>${esc(tag.hint || '')}</small>
        </span>
      </label>
    `;
  }).join('');
  const translation = normalizeTranslationProfile(char.translationProfile);
  return `
    <div class="classbook-page classbook-sheet" data-sheet="style">
      ${renderHoles()}
      <h2 class="classbook-sheet-title">口吻与语料</h2>
      <p class="classbook-sheet-sub">规则写短，例子写具体</p>
      <div class="contacts-prompt-tags" role="group" aria-label="角色标签">
        ${tagOptions}
      </div>
      ${field('聊天气泡色', `<div class="user-space-color-row"><input type="color" class="contacts-bubble-color" value="${esc(char.bubbleColor || '#fffdf8')}"><input type="text" class="form-input contacts-bubble-text" data-key="bubbleColor" value="${esc(char.bubbleColor || '')}" placeholder="#fffdf8"></div>`)}
      ${field('性格底色', `<textarea class="contacts-textarea" data-key="personality" rows="5" placeholder="反差、弱点、行动逻辑；可留空由 AI 从角色资料补">${esc(char.personality || '')}</textarea>`, '注入角色卡')}
      ${field('说话风格', `<textarea class="contacts-textarea" data-key="speechStyle" rows="4" placeholder="稳定底线：用词、语速、熟人和陌生人的差异">${esc(char.speechStyle || '')}</textarea>`, '只写始终成立的短规则')}
      <section class="contacts-corpus-workbench">
        <div>
          <strong>语料工作台</strong>
          <span data-corpus-workbench-status>${esc(corpusStatus)}</span>
        </div>
        <button type="button" class="contacts-corpus-guide-open">${icon('sparkle')}AI 辅助填写</button>
      </section>
      ${field('语料库', `<textarea class="contacts-textarea" data-key="speechCorpus" rows="6" placeholder="贴 TA 的原话最管用：台词、聊天记录截选、你喜欢的对话片段；口头禅、情绪上头时的反应、绝对不会说的话…">${esc(char.speechCorpus || '')}</textarea>`, '口吻像不像 TA，最吃这里——几段原话胜过一切风格形容')}
      ${field('翻译', `<select class="contacts-select contacts-translation-mode" data-nested="translationProfile.mode">${renderOptions(TRANSLATION_MODE_OPTIONS, translation.mode)}</select>`, '语音朗读仍读原文，翻译只用于气泡显示')}
      ${field('语音场景', `
        <label class="contacts-toggle-row">
          <input type="checkbox" class="contacts-translation-voice-force" data-nested="translationProfile.forceForeignInVoice" ${translation.forceForeignInVoice ? 'checked' : ''}>
          <span>通话 / 视频通话 / 语音条 / 直播间台词一律改说所选外语 / 方言</span>
        </label>
      `, '不影响上面的日常文字设置；语音只读原文，中文靠点按翻译查看')}
      <div class="contacts-translation-sub contacts-translation-sub--full" ${(translation.mode === 'full' || translation.forceForeignInVoice) ? '' : 'hidden'}>
        ${field('主要外语 / 方言', `<select class="contacts-select" data-nested="translationProfile.language">${renderOptions(TRANSLATION_LANGUAGE_OPTIONS, translation.language)}</select>`)}
      </div>
      <div class="contacts-translation-sub contacts-translation-sub--mixed" ${translation.mode === 'mixed' ? '' : 'hidden'}>
        ${field('偶尔蹦的语言/方言', `<input class="contacts-input" data-nested="translationProfile.dialectNote" value="${esc(translation.dialectNote)}" placeholder="如：四川话 / 偶尔蹦英文单词，留空由 AI 判断">`)}
      </div>
    </div>
  `;
}

const VOICE_LANGUAGE_OPTIONS = [
  ['auto', '自动识别'],
  ['Chinese', '普通话'],
  ['Chinese,Yue', '粤语'],
  ['English', '英语'],
  ['Japanese', '日语'],
  ['Korean', '韩语'],
];

const VOICE_EMOTION_OPTIONS = [
  ['', '默认'],
  ['happy', '开心'],
  ['sad', '低落'],
  ['angry', '生气'],
  ['fearful', '紧张'],
  ['disgusted', '嫌弃'],
  ['surprised', '惊讶'],
  ['neutral', '平静'],
];

const VOICE_BREATH_SUPPLEMENT_OPTIONS = [
  ['standard', '标准 · 按旁白补足'],
  ['reduced', '少量 · 只补明显重喘'],
  ['off', '关闭 · 完全交给声线'],
];

const VIDEO_BACKGROUND_FIT_OPTIONS = [
  ['cover', '填充裁剪'],
  ['contain', '完整显示'],
  ['fill', '拉伸填满'],
];

const VIDEO_BACKGROUND_POSITION_OPTIONS = [
  ['center', '居中'],
  ['top', '顶部'],
  ['bottom', '底部'],
  ['left', '左侧'],
  ['right', '右侧'],
];

function normalizeVideoBackgroundFit(value = '') {
  const fit = String(value || '').trim().toLowerCase();
  return ['cover', 'contain', 'fill'].includes(fit) ? fit : 'cover';
}

function normalizeVideoBackgroundPosition(value = '') {
  const position = String(value || '').trim().toLowerCase();
  return ['center', 'top', 'bottom', 'left', 'right'].includes(position) ? position : 'center';
}

function renderOptions(options, current) {
  const value = String(current || '');
  return options.map(([id, label]) => `<option value="${esc(id)}" ${value === id ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

function renderVoiceSheet(char) {
  const voice = char.voiceProfile || {};
  const voiceTtsOn = isCharacterVoiceTtsEnabled(voice);
  const voiceProviderValue = Object.prototype.hasOwnProperty.call(voice, 'provider')
    ? voice.provider
    : (voice.voiceProvider || voice.voice_provider || '');
  const voiceProvider = ['minimax', 'fish'].includes(String(voiceProviderValue).trim().toLowerCase())
    ? String(voiceProviderValue).trim().toLowerCase()
    : '';
  const miniMaxVoiceId = String(voice.voiceId || voice.voice_id || '').trim();
  const fishReferenceId = String(voice.fishReferenceId || voice.fish_reference_id || '').trim();
  const legacyFishOnly = !!fishReferenceId && !miniMaxVoiceId;
  const fishSpeed = voice.fishSpeed ?? voice.fish_speed ?? (legacyFishOnly ? voice.speed : '');
  const fishVolume = voice.fishVolume ?? voice.fish_volume ?? '';
  const videoBackground = String(voice.videoBackground || voice.video_background || '').trim();
  const videoBackgroundFit = normalizeVideoBackgroundFit(voice.videoBackgroundFit || voice.video_background_fit);
  const videoBackgroundPosition = normalizeVideoBackgroundPosition(
    voice.videoBackgroundPosition || voice.video_background_position,
  );
  const videoStageDirections = voice.videoStageDirections === true || String(voice.videoStageDirections || '').trim() === 'true';
  return `
    <div class="classbook-page classbook-sheet" data-sheet="voice">
      ${renderHoles()}
      <h2 class="classbook-sheet-title">语音 / 视频</h2>
      <p class="classbook-sheet-sub">角色声线与视频通话人物背景</p>
      ${field('角色语音', `
        <label class="contacts-toggle-row">
          <input type="checkbox" data-nested="voiceProfile.enabled" value="true" ${voiceTtsOn ? 'checked' : ''}>
          <span>启用语音合成</span>
        </label>
      `, '未启用时该角色只用文字，不会弹出配置提示')}
      ${field('语音提供商', `<select class="contacts-select" data-nested="voiceProfile.provider">${renderOptions([
        ['', '跟随全局设置'],
        ['minimax', 'MiniMax'],
        ['fish', 'Fish Audio'],
      ], voiceProvider)}</select>`)}
      ${field('额外呼吸素材', `<select class="contacts-select" data-nested="voiceProfile.breathSupplementMode">${renderOptions(
        VOICE_BREATH_SUPPLEMENT_OPTIONS,
        voice.breathSupplementMode || 'standard',
      )}</select>`, '只控制音频库补足，不改变声线本身')}
      <div class="contacts-voice-provider-group">
        <h3 class="classbook-sheet-title">MiniMax</h3>
        ${field('声线 ID', `<input class="contacts-input" data-nested="voiceProfile.voiceId" value="${esc(miniMaxVoiceId)}" placeholder="voice_id / 克隆音色 ID">`)}
        ${field('语言增强', `<select class="contacts-select" data-nested="voiceProfile.languageBoost">${renderOptions(VOICE_LANGUAGE_OPTIONS, voice.languageBoost || voice.language_boost || 'auto')}</select>`)}
        <div class="contacts-voice-grid">
          ${field('语速', `<input class="contacts-input" type="number" min="0.5" max="2" step="0.05" data-nested="voiceProfile.speed" value="${esc(voice.speed ?? '')}" placeholder="1（默认）">`, '0.8 慢 · 1 默认 · 1.2 快')}
          ${field('音量', `<input class="contacts-input" type="number" min="0.1" max="10" step="0.1" data-nested="voiceProfile.vol" value="${esc(voice.vol ?? '')}" placeholder="1（默认）">`, '0.8 轻 · 1 默认 · 1.2 响')}
          ${field('音调', `<input class="contacts-input" type="number" min="-12" max="12" step="1" data-nested="voiceProfile.pitch" value="${esc(voice.pitch ?? '')}" placeholder="0（原声）">`, '-2 低沉 · 0 原声 · +2 明亮')}
          ${field('情绪', `<select class="contacts-select" data-nested="voiceProfile.emotion">${renderOptions(VOICE_EMOTION_OPTIONS, voice.emotion || '')}</select>`)}
        </div>
      </div>
      <div class="contacts-voice-provider-group">
        <h3 class="classbook-sheet-title">Fish Audio</h3>
        ${field('声线 ID', `<input class="contacts-input" data-nested="voiceProfile.fishReferenceId" value="${esc(fishReferenceId)}" placeholder="reference_id / 声音模型 ID">`)}
        <div class="contacts-voice-grid">
          ${field('语速', `<input class="contacts-input" type="number" min="0.5" max="2" step="0.05" data-nested="voiceProfile.fishSpeed" value="${esc(fishSpeed)}" placeholder="1（跟随全局）">`)}
          ${field('音量', `<input class="contacts-input" type="number" min="-20" max="20" step="1" data-nested="voiceProfile.fishVolume" value="${esc(fishVolume)}" placeholder="0（跟随全局）">`, 'dB：+3 更响 · 0 原始 · -3 更轻')}
          ${field('温度', `<input class="contacts-input" type="number" min="0" max="1" step="0.05" data-nested="voiceProfile.fishTemperature" value="${esc(voice.fishTemperature ?? '')}" placeholder="0.7（跟随全局）">`)}
          ${field('Top P', `<input class="contacts-input" type="number" min="0" max="1" step="0.05" data-nested="voiceProfile.fishTopP" value="${esc(voice.fishTopP ?? voice.fish_top_p ?? '')}" placeholder="0.7（跟随全局）">`)}
          ${field('情绪', `<select class="contacts-select" data-nested="voiceProfile.fishEmotion">${renderOptions(VOICE_EMOTION_OPTIONS, voice.fishEmotion || voice.fish_emotion || '')}</select>`)}
        </div>
        ${field('表演指导', `<input class="contacts-input" data-nested="voiceProfile.fishPerformanceDirection" value="${esc(voice.fishPerformanceDirection || '')}" placeholder="留空时跟随当前气泡">`)}
      </div>
      ${field('通话背景图', `
        <div class="contacts-video-bg-stack">
          <input class="contacts-input" data-nested="voiceProfile.videoBackground" value="${esc(videoBackground)}" placeholder="语音 / 视频通话共用；可上传本地图或粘贴图片 URL">
          <div class="contacts-video-bg-actions">
            <input id="contacts-video-bg-file" type="file" accept="image/*" class="contacts-video-bg-file">
            <label class="btn btn-sm btn-outline contacts-video-bg-upload" for="contacts-video-bg-file">上传本地图</label>
            <button type="button" class="btn btn-sm btn-soft contacts-video-bg-clear">清除</button>
          </div>
          <div class="contacts-video-bg-display">
            <label><span>显示方式</span><select class="contacts-select" data-nested="voiceProfile.videoBackgroundFit">${renderOptions(VIDEO_BACKGROUND_FIT_OPTIONS, videoBackgroundFit)}</select></label>
            <label><span>画面位置</span><select class="contacts-select" data-nested="voiceProfile.videoBackgroundPosition">${renderOptions(VIDEO_BACKGROUND_POSITION_OPTIONS, videoBackgroundPosition)}</select></label>
          </div>
          <div class="contacts-video-bg-preview ${videoBackground ? '' : 'is-empty'}" style="--contacts-video-bg-fit:${videoBackgroundFit};--contacts-video-bg-position:${videoBackgroundPosition};">${videoBackground ? `<img src="${esc(videoBackground)}" alt="">` : '<span>暂无背景</span>'}</div>
        </div>
      `, '视频通话封面 / 背景')}
      ${field('视频动作场景', `
        <label class="contacts-toggle-row">
          <input type="checkbox" data-nested="voiceProfile.videoStageDirections" value="true" ${videoStageDirections ? 'checked' : ''}>
          <span>允许 AI 在视频通话里写画面动作</span>
        </label>
      `, '动作会显示在画面里，不会读进语音')}
    </div>
  `;
}

function relationTargetLabel(rid, others = []) {
  const id = String(rid || '').trim();
  if (!id) return '选择对象…';
  const hit = others.find((o) => o.id === id);
  if (hit) {
    return resolveActorDisplayLabel(hit.name || hit.realName || hit.customNickname, {
      characters: { [id]: hit },
      fallback: '未命名角色',
    });
  }
  const charMap = Object.fromEntries(others.map((o) => [o.id, o]));
  return resolveActorDisplayLabel(id, { characters: charMap, fallback: '已删除角色' });
}

function buildRelationTargetOptions(others, charId, selectedId = '') {
  return others
    .filter((o) => o.id !== charId)
    .map((o) => {
      const label = relationTargetLabel(o.id, others);
      return `<option value="${esc(o.id)}"${o.id === selectedId ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

function renderRelationsSheet(char, others) {
  const entries = Object.entries(char.relationships || {});
  const othersById = new Map(others.map((o) => [o.id, o]));
  const list = entries.length
    ? entries.map(([rid, text]) => {
      const baseOptions = buildRelationTargetOptions(others, char.id, rid);
      const orphanOption = othersById.has(rid) || !rid
        ? ''
        : `<option value="${esc(rid)}" selected>${esc(relationTargetLabel(rid, others))}</option>`;
      return `
      <div class="contacts-rel-item" data-rel-id="${esc(rid)}">
        <div class="contacts-rel-row">
          <select class="contacts-select contacts-rel-target">
            <option value="">选择对象…</option>
            ${baseOptions}${orphanOption}
          </select>
          <button type="button" class="btn btn-sm btn-soft contacts-rel-remove">删</button>
        </div>
        <textarea class="contacts-textarea contacts-rel-text" rows="2" placeholder="关系描述，几个词也行">${esc(text)}</textarea>
      </div>
    `;
    }).join('')
    : '<p class="classbook-sheet-sub">还没有关系。可先建其他角色，或稍后再填。</p>';
  return `
    <div class="classbook-page classbook-sheet" data-sheet="relations">
      ${renderHoles()}
      <h2 class="classbook-sheet-title">关系网</h2>
      <p class="classbook-sheet-sub">聊天、社交、群聊生成都会用到</p>
      <div class="contacts-rel-list">${list}</div>
      <button type="button" class="btn btn-sm btn-outline contacts-rel-add">添加关系</button>
    </div>
  `;
}

function getLocationAnchors(char) {
  const profile = char.locationProfile && typeof char.locationProfile === 'object'
    ? char.locationProfile
    : {};
  return Array.isArray(profile.anchors) ? profile.anchors.filter(Boolean) : [];
}

function renderLocationAnchorList(char) {
  const anchors = getLocationAnchors(char).filter((a) => a.location || a.query || a.label);
  if (!anchors.length) {
    return '<div class="contacts-location-empty">还没有真实地点。可以先填一个城市和地标。</div>';
  }
  return anchors.slice(0, 10).map((anchor) => {
    const meta = [anchor.area, anchor.address].filter(Boolean).join(' · ');
    return `
      <div class="contacts-location-anchor">
        <strong>${esc(anchor.label || anchor.query || '地点')}</strong>
        ${meta ? `<span>${esc(meta)}</span>` : ''}
      </div>
    `;
  }).join('');
}

function renderLifeSheet(char, groups) {
  const anchor = char.residenceAnchor || {};
  const life = char.lifeProfile || {};
  const mapEnabled = char.locationProfile?.mapEnabled !== false;
  const groupOptions = (groups || []).map((g) => (
    `<option value="${esc(g.id)}" ${String(char.groupId || 'default') === g.id ? 'selected' : ''}>${esc(g.name)}</option>`
  )).join('');
  const cityFields = MAP_CITY_FIELDS.map((f) => field(
    f.label,
    `<input class="contacts-input" data-nested="residenceAnchor.${f.key}" value="${esc(anchor[f.key] || '')}" placeholder="${esc(f.placeholder || '')}">`,
    f.ai,
  )).join('');
  const mapFields = MAP_FIELDS.map((f) => {
    const val = anchor[f.key] || '';
    if (f.rows) {
      return field(f.label, `<textarea class="contacts-textarea" data-nested="residenceAnchor.${f.key}" rows="${f.rows}" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`);
    }
    return field(f.label, `<input class="contacts-input" data-nested="residenceAnchor.${f.key}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}">`);
  }).join('');
  const lifeFields = LIFE_FIELDS.map((f) => {
    const val = life[f.key] || '';
    return field(f.label, `<textarea class="contacts-textarea" data-nested="lifeProfile.${f.key}" rows="${f.rows || 2}" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`);
  }).join('');
  return `
    <div class="classbook-page classbook-sheet" data-sheet="life">
      ${renderHoles()}
      <h2 class="classbook-sheet-title">生活圈</h2>
      <p class="classbook-sheet-sub">城市与日常线索；也可由 AI 根据整段设定补全</p>
      ${field('分组', `<select class="contacts-select" data-key="groupId">${groupOptions}</select>`)}
      ${field('角色层级', `<select class="contacts-select" data-key="roleTier">${ROLE_TIERS.map((t) => `<option value="${esc(t.id)}" ${char.roleTier === t.id ? 'selected' : ''}>${esc(t.label)}（${esc(t.hint)}）</option>`).join('')}</select>`, '主陪伴用于陪伴位展示 · 常驻角色适合大群像')}
      ${field('拨号编号', `<input class="contacts-input" data-key="dialNumber" value="${esc(char.dialNumber || '')}" inputmode="numeric" pattern="[0-9]*" maxlength="12" placeholder="纯数字，如 101">`)}
      ${field('出生日期', `<input class="contacts-input" type="date" data-key="birthDate" value="${esc(char.birthDate || '')}">`)}
      ${field('当前状态', `<input class="contacts-input" data-key="currentStatus" value="${esc(char.currentStatus)}" placeholder="最近在忙什么">`)}
       ${field('本地备注', `<textarea class="contacts-textarea" data-key="notes" rows="3" placeholder="给自己看的备忘">${esc(char.notes)}</textarea>`)}
       ${cityFields}
       ${field('现实地图参照', `
         <label class="contacts-toggle-row">
           <input type="checkbox" data-nested="locationProfile.mapEnabled" ${mapEnabled ? 'checked' : ''}>
           <span>使用真实地点、路线与地图动态；关闭后仍会参考当地天气</span>
         </label>
       `, '不改变故事城市或角色设定')}
       ${mapFields}
      <div class="contacts-map-actions">
        <button type="button" class="btn btn-sm btn-primary contacts-map-search">搜索生活圈</button>
        <button type="button" class="btn btn-sm btn-outline contacts-weather-check">检测天气</button>
      </div>
      <div class="contacts-weather-status text-hint"></div>
      <div class="contacts-map-results" hidden></div>
      <div class="contacts-location-box">
        <div class="contacts-location-head">已收下的地点</div>
        <div class="contacts-location-anchors">${renderLocationAnchorList(char)}</div>
      </div>
      ${lifeFields}
    </div>
  `;
}

function collectForm(char, host) {
  const next = { ...char };
  const clonedNestedFields = new Set();
  host.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.getAttribute('data-key');
    if (key === 'aliases') {
      next.aliases = String(el.value || '')
        .split(/[/|、,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return;
    }
    if (key === 'dialNumber') {
      next.dialNumber = normalizeDialNumber(el.value);
      return;
    }
    if (key === 'bubbleColor') {
      const color = String(el.value || '').trim();
      next.bubbleColor = /^#[0-9a-f]{6}$/i.test(color) ? color : '';
      return;
    }
    next[key] = el.value;
  });
  next.promptTags = [...host.querySelectorAll('[data-prompt-tag]:checked')]
    .map((el) => String(el.getAttribute('data-prompt-tag') || '').trim())
    .filter(Boolean);
  host.querySelectorAll('[data-nested]').forEach((el) => {
    const path = el.getAttribute('data-nested').split('.');
    if (path.length !== 2) return;
    const [prefix, key] = path;
    if (!clonedNestedFields.has(prefix)) {
      next[prefix] = next[prefix] && typeof next[prefix] === 'object'
        ? { ...next[prefix] }
        : {};
      clonedNestedFields.add(prefix);
    }
    if (el.type === 'checkbox') {
      next[prefix][key] = !!el.checked;
    } else {
      let value = el.value;
      if (prefix === 'voiceProfile' && key === 'videoBackground') {
        value = upgradeMixedContentMediaUrl(value);
      }
      next[prefix][key] = value;
      // 旧版本使用下划线字段。若只把新字段清空，通话页的兼容读取会重新回退到
      // 旧背景，于是表现成“能替换、却删不掉”。在保存当前编辑值时一并完成迁移。
      if (prefix === 'voiceProfile') {
        const legacyKey = {
          videoBackground: 'video_background',
          videoBackgroundFit: 'video_background_fit',
          videoBackgroundPosition: 'video_background_position',
        }[key];
        if (legacyKey) delete next[prefix][legacyKey];
      }
    }
  });
  const residence = next.residenceAnchor && typeof next.residenceAnchor === 'object'
    ? next.residenceAnchor
    : {};
  const locationProfile = next.locationProfile && typeof next.locationProfile === 'object'
    ? { ...next.locationProfile }
    : {};
  const city = String(residence.realCityMap || residence.city || '').trim();
  if (city || residence.area) {
    locationProfile.mapEnabled = locationProfile.mapEnabled !== false;
    locationProfile.city = {
      ...(locationProfile.city && typeof locationProfile.city === 'object' ? locationProfile.city : {}),
      name: city,
    };
    locationProfile.region = String(residence.area || locationProfile.region || '').trim();
    next.locationProfile = locationProfile;
  }
  const relationships = {};
  host.querySelectorAll('.contacts-rel-item').forEach((item) => {
    const rid = String(item.querySelector('.contacts-rel-target')?.value || '').trim();
    const text = String(item.querySelector('.contacts-rel-text')?.value || '').trim();
    if (rid && text) relationships[rid] = text;
  });
  next.relationships = relationships;
  return createCharacterProfile(next);
}

export default async function render(container, params = {}) {
  const isNew = params.new === '1' || !params.id;
  const [prefs, existingBase, allCharsBase, groupConfig, imgCfg, activeUser, worldBookRows] = await Promise.all([
    loadAppearancePrefs(),
    isNew ? null : getCharacter(params.id),
    listCharacters({ excludeAnonNpc: true }),
    loadContactGroupsConfig(),
    loadImageToolConfig().catch(() => ({})),
    getCurrentUser().catch(() => null),
    listAllWorldBookRows().catch(() => []),
  ]);
  const requestedIdentityUserId = String(params.identityUserId || '').trim();
  const currentUser = requestedIdentityUserId
    && requestedIdentityUserId !== String(activeUser?.id || '')
    ? await getUserById(requestedIdentityUserId).catch(() => null)
    : activeUser;
  const identityRequested = String(params.scope || '') === 'identity';
  if (identityRequested && !currentUser?.id) {
    container.className = 'page scrapbook-page';
    container.innerHTML = `<header class="navbar"><button type="button" class="navbar-btn identity-scope-back" aria-label="返回">${icon('back')}</button><h1 class="navbar-title">编辑角色</h1><span class="navbar-btn" aria-hidden="true"></span></header><div class="placeholder-page"><div class="placeholder-text">目标档位已不可用，请返回后重新进入</div></div>`;
    container.querySelector('.identity-scope-back')?.addEventListener('click', () => back());
    return;
  }
  const identityScope = identityRequested;
  const [existing, allChars] = identityScope
    ? await Promise.all([
      isNew ? null : getCharacter(params.id, { userId: currentUser.id }),
      listCharacters({ excludeAnonNpc: true, userId: currentUser.id }),
    ])
    : [existingBase, allCharsBase];
  const naiEnabled = isNovelAiImageGenerationEnabled(imgCfg);
  const referenceEnabled = naiEnabled || isRealisticImageGenerationEnabled(imgCfg);
  if (!isNew && !existing) {
    container.className = 'page scrapbook-page';
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">找不到这位同学</div></div>';
    return;
  }

  let char = existing || createCharacterProfile({ isCustom: true, roleTier: 'main' });
  const active = getActiveTheme(prefs);
  const { theme } = active;
  const glassTheme = isWindowHomeTheme(active.id, theme) || isSeaHomeTheme(active.id, theme);
  const others = allChars.filter((c) => c.id !== char.id);

  container.className = `page scrapbook-page contacts-page${glassTheme ? ' contacts-edit--glass' : ''}`;
  applySettingsWallpaperPreview(container, theme);

  const sheets = [
    renderProfileSheet(char, naiEnabled, referenceEnabled, identityScope && !isNew),
    renderStyleSheet(char),
    renderLifeSheet(char, groupConfig.groups),
    renderRelationsSheet(char, others),
    renderVoiceSheet(char),
  ];

  const dots = CHARACTER_SECTIONS.map((s, i) => (
    `<button type="button" class="classbook-pager-dot ${i === 0 ? 'is-active' : ''}" data-page="${i}" aria-label="${esc(s.title)}"></button>`
  )).join('');

  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn contacts-edit-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${isNew ? '新建角色' : esc(char.name || '编辑')}</h1>
      <button type="button" class="navbar-btn contacts-edit-save" aria-label="保存">${icon('check')}</button>
    </header>
    <main class="contacts-edit-scroll scrapbook-scroll">
      <div class="classbook-flip">${sheets.join('')}</div>
      ${isNew ? '' : `
        <div class="contacts-danger-zone">
          <button type="button" class="btn btn-sm btn-outline contacts-export-one" title="仅用于本应用迁移">导出角色包</button>
          <button type="button" class="btn btn-sm btn-soft contacts-share-one">分享到应用商店</button>
          <p class="contacts-export-note">角色包 JSON 仅用于本应用迁移，不兼容其他平台角色卡。</p>
          ${identityScope ? '' : '<button type="button" class="btn btn-sm btn-soft contacts-delete">删除这一页</button>'}
        </div>
      `}
    </main>
    <footer class="classbook-pager">
      <button type="button" class="btn btn-sm btn-outline contacts-page-prev">上一页</button>
      <div class="classbook-pager-dots">${dots}</div>
      <span class="classbook-pager-label contacts-page-label">1 / ${CHARACTER_SECTIONS.length}</span>
      <button type="button" class="btn btn-sm btn-outline contacts-page-next">下一页</button>
    </footer>
  `;

  let pageIndex = 0;
  const sheetEls = () => [...container.querySelectorAll('.classbook-sheet')];
  const dotEls = () => [...container.querySelectorAll('.classbook-pager-dot')];
  const requestedSheet = String(params.sheet || '').trim();
  if (requestedSheet) {
    const hitIndex = CHARACTER_SECTIONS.findIndex((s) => String(s.id || '').trim() === requestedSheet);
    if (hitIndex >= 0) pageIndex = hitIndex;
  }

  function goPage(index) {
    const max = CHARACTER_SECTIONS.length - 1;
    pageIndex = Math.max(0, Math.min(max, index));
    sheetEls().forEach((el, i) => el.classList.toggle('is-active', i === pageIndex));
    dotEls().forEach((el, i) => el.classList.toggle('is-active', i === pageIndex));
    const label = container.querySelector('.contacts-page-label');
    if (label) label.textContent = `${pageIndex + 1} / ${CHARACTER_SECTIONS.length}`;
  }
  // iOS Safari 键盘打开时，直接点 fixed 页脚/页头按钮有时只会收键盘，
  // 合成层仍把本次 click 吞掉。触摸开始就提交当前输入焦点，让同一次点击继续落到按钮。
  container.addEventListener('touchstart', (event) => {
    if (!document.documentElement.classList.contains('ios-webkit')) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function' || !target.closest('button')) return;
    const activeField = document.activeElement;
    if (!activeField || !container.contains(activeField)) return;
    if (!activeField.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    try {
      activeField.blur();
    } catch (_) {}
  }, { capture: true, passive: true });

  // iOS 在 textarea 粘贴、全选或替换大段文本后，键盘/选区有时会吞掉紧接着的
  // 合成 click；只 blur 还不够，保存与返回必须在真实 touchend 上直接落一次。
  // preventDefault 会抑制随后那次合成 click，时间戳再兜住少数仍会补发 click 的 WebView。
  let lastCriticalTouchAt = 0;
  container.addEventListener('touchend', (event) => {
    if (!document.documentElement.classList.contains('ios-webkit')) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('.contacts-edit-save, .contacts-edit-back');
    if (!button || !container.contains(button)) return;
    lastCriticalTouchAt = Date.now();
    event.preventDefault();
    event.stopPropagation();
    const activeField = document.activeElement;
    if (activeField && container.contains(activeField)) {
      try { activeField.blur(); } catch (_) {}
    }
    window.setTimeout(() => {
      if (button.classList.contains('contacts-edit-save')) void persist();
      else back();
    }, 0);
  }, { capture: true, passive: false });



  container.querySelector('.contacts-page-prev')?.addEventListener('click', () => goPage(pageIndex - 1));
  container.querySelector('.contacts-page-next')?.addEventListener('click', () => goPage(pageIndex + 1));
  dotEls().forEach((dot) => {
    dot.addEventListener('click', () => goPage(Number(dot.getAttribute('data-page')) || 0));
  });
  goPage(pageIndex);

  const speechCorpusInput = container.querySelector('[data-key="speechCorpus"]');
  const refreshCorpusWorkbenchStatus = () => {
    const status = container.querySelector('[data-corpus-workbench-status]');
    if (!status) return;
    const value = String(speechCorpusInput?.value || '').trim();
    status.textContent = value
      ? `${value.length} 字${hasSpeechCorpusGuideBlock(value) ? ' · 已整理行为模式' : ' · 可继续补情境'}`
      : '尚未填写 · 建议先补两种情境';
  };
  speechCorpusInput?.addEventListener('input', refreshCorpusWorkbenchStatus);
  container.querySelector('.contacts-persona-clear')?.addEventListener('click', async () => {
    if (!identityScope || isNew || !char?.id || !currentUser?.id) return;
    if (!window.confirm(
      `确定清空「${char.name || '这个角色'}」在当前档位的人设？\n\n`
      + '会清空整段设定、身份、关系状态、性格、口吻、语料、当前状态和生活圈文字；姓名、头像、生图外观、声线、关系网与外层通讯录不会改变。',
    )) return;
    const button = container.querySelector('.contacts-persona-clear');
    if (button) button.disabled = true;
    try {
      const cleared = clearIdentityCharacterPersona(char);
      char = await saveCharacterForUser(currentUser.id, cleared, { forceOverride: true });
      applyClearedIdentityPersonaToForm(char, container);
      refreshCorpusWorkbenchStatus();
      showToast('已清空当前档位人设');
    } catch (err) {
      showToast(`清空失败：${String(err?.message || err)}`);
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  });
  container.querySelector('.contacts-corpus-guide-open')?.addEventListener('click', () => {
    const currentCharacter = collectForm(char, container);
    openSpeechCorpusGuideModal(String(speechCorpusInput?.value || ''), {
      character: currentCharacter,
      user: currentUser,
      worldBookOptions: listWorldBookRootOptions(
        worldBookRows.filter((row) => row?.system !== 'miniwiki'),
      ),
      onApply: (next) => {
        if (speechCorpusInput) speechCorpusInput.value = next;
        refreshCorpusWorkbenchStatus();
        showToast('已写入语料库，记得保存');
      },
    });
  });

  const avatarBox = container.querySelector('.contacts-avatar-box');
  const avatarFile = container.querySelector('.contacts-avatar-file');
  const avatarSaveBtn = container.querySelector('.contacts-avatar-save');
  const docFile = container.querySelector('.contacts-doc-file');
  const docUploadLabel = container.querySelector('.contacts-doc-upload');
  const syncAvatarSaveButton = () => {
    if (avatarSaveBtn) avatarSaveBtn.hidden = !String(char.avatar || '').trim();
  };
  container.querySelector('.contacts-avatar-upload')?.addEventListener('click', () => {
    // Safari 重选同一张图不会再触发 change；打开选择器前先清掉上次值。
    if (avatarFile) avatarFile.value = '';
  });
  docUploadLabel?.addEventListener('click', () => {
    if (docFile) docFile.value = '';
  });
  avatarFile?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const result = await fileToCroppedOptimizedAvatarDataUrl(file);
      if (!result) return;
      char.avatar = result.dataUrl;
      avatarBox.innerHTML = characterAvatarHtml(char, { className: 'contacts-avatar-img' });
      syncAvatarSaveButton();
      showToast('头像已更新，记得保存');
    } catch (err) {
      showToast(`上传失败：${(err && err.message) || err}`);
    } finally {
      // 取消裁剪或解码失败也要复位，让 iOS 可立即重选同一张。
      input.value = '';
    }
  });
  docFile?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    showToast('正在读取文档…', 1500);
    try {
      const build = (typeof window !== 'undefined' && window.__MARSHMALLOW_BUILD__)
        ? String(window.__MARSHMALLOW_BUILD__)
        : '';
      const { readCharacterDocumentFile } = await import(`../core/character-document-read.js?v=${encodeURIComponent(build)}`);
      const text = await readCharacterDocumentFile(file);
      applyDocumentText(text);
    } catch (err) {
      showToast(String((err && err.message) || err || '读取文档失败'));
    }
  });
  container.querySelector('.contacts-avatar-clear')?.addEventListener('click', () => {
    char.avatar = null;
    avatarBox.innerHTML = characterAvatarHtml(char, { className: 'contacts-avatar-img' });
    syncAvatarSaveButton();
    showToast('已清除头像');
  });
  avatarSaveBtn?.addEventListener('click', (e) => {
    saveImageToDevice(char.avatar, e.currentTarget);
  });
  const translationModeSelect = container.querySelector('.contacts-translation-mode');
  const translationVoiceForceCheckbox = container.querySelector('.contacts-translation-voice-force');
  const translationFullSub = container.querySelector('.contacts-translation-sub--full');
  const translationMixedSub = container.querySelector('.contacts-translation-sub--mixed');
  const syncTranslationSubVisibility = () => {
    const mode = translationModeSelect?.value || 'off';
    if (translationFullSub) translationFullSub.hidden = mode !== 'full' && !translationVoiceForceCheckbox?.checked;
    if (translationMixedSub) translationMixedSub.hidden = mode !== 'mixed';
  };
  translationModeSelect?.addEventListener('change', syncTranslationSubVisibility);
  translationVoiceForceCheckbox?.addEventListener('change', syncTranslationSubVisibility);
  const videoBgPreviewEl = container.querySelector('.contacts-video-bg-preview');
  const videoBgInputEl = container.querySelector('[data-nested="voiceProfile.videoBackground"]');
  const videoBgFitEl = container.querySelector('[data-nested="voiceProfile.videoBackgroundFit"]');
  const videoBgPositionEl = container.querySelector('[data-nested="voiceProfile.videoBackgroundPosition"]');
  const videoBgFile = container.querySelector('.contacts-video-bg-file');
  container.querySelector('.contacts-video-bg-upload')?.addEventListener('click', () => {
    // iOS 重选同一张背景图时仍要触发 change。
    if (videoBgFile) videoBgFile.value = '';
  });
  const syncVideoBackgroundPreview = () => {
    if (!videoBgPreviewEl) return;
    const next = upgradeMixedContentMediaUrl(videoBgInputEl?.value || '');
    if (videoBgInputEl && next !== videoBgInputEl.value.trim()) videoBgInputEl.value = next;
    videoBgPreviewEl.style.setProperty('--contacts-video-bg-fit', normalizeVideoBackgroundFit(videoBgFitEl?.value));
    videoBgPreviewEl.style.setProperty(
      '--contacts-video-bg-position',
      normalizeVideoBackgroundPosition(videoBgPositionEl?.value),
    );
    if (next) {
      videoBgPreviewEl.classList.remove('is-empty');
      videoBgPreviewEl.innerHTML = `<img src="${esc(next)}" alt="">`;
    } else {
      videoBgPreviewEl.classList.add('is-empty');
      videoBgPreviewEl.innerHTML = '<span>暂无背景</span>';
    }
  };
  container.querySelector('.contacts-video-bg-clear')?.addEventListener('click', () => {
    if (videoBgInputEl) videoBgInputEl.value = '';
    syncVideoBackgroundPreview();
    showToast('已清除通话背景');
  });
  videoBgFile?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const { dataUrl } = await fileToOptimizedChatImageDataUrl(file, { forcePortableFormat: true });
      if (videoBgInputEl) videoBgInputEl.value = dataUrl || '';
      syncVideoBackgroundPreview();
      showToast('通话背景已填入，记得保存');
    } catch (err) {
      showToast(`上传失败：${(err && err.message) || err}`);
    } finally {
      input.value = '';
    }
  });

  // 画风选择即时同步到草稿，「AI 描绘 / 生成预览」不用等保存就按所选画风出图
  const imageStyleSelect = container.querySelector('[data-key="imageStyleId"]');
  const syncImageStyleToChar = () => {
    if (imageStyleSelect) char.imageStyleId = String(imageStyleSelect.value || '').trim();
  };
  imageStyleSelect?.addEventListener('change', syncImageStyleToChar);

  const drawBtn = container.querySelector('.contacts-avatar-draw');
  drawBtn?.addEventListener('click', async () => {
    const appearance = String(container.querySelector('[data-key="appearancePrompt"]')?.value || '').trim();
    const nameNow = String(container.querySelector('[data-key="name"]')?.value || char.name || '').trim();
    const basePrompt = appearance || (nameNow ? `${nameNow}, anime character portrait, upper body` : '');
    if (!basePrompt) {
      showToast('请先填写「生图外观描述」再描绘');
      container.querySelector('[data-key="appearancePrompt"]')?.focus();
      return;
    }
    const prevHtml = drawBtn.innerHTML;
    drawBtn.disabled = true;
    drawBtn.textContent = '描绘中...';
    try {
      syncImageStyleToChar();
      const locked = await applyCharacterImageLock(char, basePrompt, { forcePortrait: true });
      const result = await generateCharacterImage(locked.prompt, {
        seed: locked.seed,
        refImageUrls: locked.refImageUrls,
        styleId: locked.styleId,
        providerOverride: locked.providerOverride,
      });
      if (result?.referenceSkipped) {
        showToast('参考图锁定未生效，已改纯文生图', 5000);
      }
      let url = String(result?.url || '');
      if (!url) throw new Error('未拿到图片数据');
      url = await persistGeneratedImageUrlLocally(url).catch(() => url);
      const storedPortraitUrl = await optimizeImageDataUrlForNovelAiReference(url).catch(() => url);
      openCharacterDrawPreview(url, {
        onUseAvatar: () => {
          char.avatar = storedPortraitUrl;
          avatarBox.innerHTML = characterAvatarHtml(char, { className: 'contacts-avatar-img' });
          syncAvatarSaveButton();
          showToast('已设为头像，记得保存');
        },
      });
    } catch (err) {
      showToast(`描绘失败：${String((err && err.message) || err).slice(0, 140)}`);
    } finally {
      drawBtn.disabled = false;
      drawBtn.innerHTML = prevHtml;
    }
  });

  // ── 生图锁定（锁 seed / 锁人设）──
  const lockHost = container.querySelector('.contacts-lock-host');
  const syncLockToChar = () => {
    const modeSel = lockHost?.querySelector('[data-lock-mode]');
    if (!modeSel) return;
    char.imageLock = {
      ...(char.imageLock || {}),
      mode: modeSel.value,
      prompt: lockHost.querySelector('[data-lock-prompt]')?.value || '',
      seed: (lockHost.querySelector('[data-lock-seed]')?.value || '').replace(/\D/g, ''),
    };
  };
  /** 刷新参考图缩略区（预览图 / 提示语 / 清除按钮），不用整块重新渲染 */
  const refreshLockRefUi = () => {
    const refRow = lockHost?.querySelector('[data-lock-ref-row]');
    if (!refRow) return;
    const refUrl = String(char.imageLock?.refImageUrl || '').trim();
    const preview = refUrl || String(char.avatar || '').trim();
    const previewEl = refRow.querySelector('[data-lock-ref-preview]');
    if (previewEl) previewEl.innerHTML = preview ? `<img src="${esc(preview)}" alt="锁定参考图">` : '<span>暂无参考图</span>';
    const hintEl = refRow.querySelector('[data-lock-ref-hint]');
    if (hintEl) {
      hintEl.textContent = refUrl
        ? '已设置专属参考图，头像换成别的也不受影响'
        : '暂用当前头像做参考图；头像变动会跟着变，建议上传或用下方「生成预览」的结果单独锁定一张更准的参考图';
    }
    const clearBtn = refRow.querySelector('[data-lock-ref-clear]');
    if (clearBtn) clearBtn.hidden = !refUrl;
  };
  if (lockHost) {
    const body = lockHost.querySelector('[data-lock-body]');
    const seedRow = lockHost.querySelector('[data-lock-seed-row]');
    lockHost.querySelector('[data-lock-mode]')?.addEventListener('change', (e) => {
      const mode = e.target.value;
      if (body) body.hidden = mode === 'none';
      if (seedRow) seedRow.hidden = mode !== 'seed';
      const promptField = lockHost.querySelector('[data-lock-prompt]');
      if (promptField) promptField.hidden = mode === 'reference';
      const refRow = lockHost.querySelector('[data-lock-ref-row]');
      if (refRow) refRow.hidden = mode !== 'reference';
      const note = lockHost.querySelector('[data-lock-note]');
      if (note) note.hidden = mode !== 'reference';
      syncLockToChar();
    });
    lockHost.querySelectorAll('[data-lock-prompt],[data-lock-seed]').forEach((el) => el.addEventListener('input', syncLockToChar));

    lockHost.querySelector('.contacts-lock-ref-file')?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const result = await fileToCroppedOptimizedAvatarDataUrl(file, { title: '裁剪参考图', shape: 'square' });
        if (!result) return;
        char.imageLock = { ...(char.imageLock || {}), refImageUrl: result.dataUrl };
        refreshLockRefUi();
        showToast('参考图已更新，记得保存');
      } catch (err) {
        showToast(`上传失败：${(err && err.message) || err}`);
      }
      e.target.value = '';
    });
    lockHost.querySelector('[data-lock-ref-clear]')?.addEventListener('click', () => {
      char.imageLock = { ...(char.imageLock || {}), refImageUrl: '' };
      refreshLockRefUi();
      showToast('已改用当前头像做参考图');
    });

    lockHost.querySelector('[data-lock-gen]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      syncLockToChar();
      const lock = char.imageLock || {};
      if (lock.mode === 'reference' && !resolveImageLockRefUrl(char)) {
        showToast('参考图锁定需要先上传参考图或设置一张头像');
        return;
      }
      const appearance = String(container.querySelector('[data-key="appearancePrompt"]')?.value || '').trim();
      const nameNow = String(container.querySelector('[data-key="name"]')?.value || char.name || '').trim();
      const fallbackPrompt = appearance || (nameNow ? `${nameNow}, anime character portrait, upper body` : '');
      const promptText = (lock.mode !== 'reference' ? (lock.prompt || '').trim() : '') || fallbackPrompt;
      if (!promptText) {
        showToast('先写「生图外观描述」或锁定提示词');
        return;
      }
      const prev = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = '生成中...';
      try {
        syncImageStyleToChar();
        const locked = await applyCharacterImageLock(char, promptText, { forcePortrait: true });
        const r = await generateCharacterImage(locked.prompt, {
          seed: locked.seed,
          refImageUrls: locked.refImageUrls,
          styleId: locked.styleId,
          providerOverride: locked.providerOverride,
        });
        if (r?.referenceSkipped) {
          showToast('参考图锁定未生效，已改纯文生图', 5000);
        }
        let url = String(r?.url || '');
        if (!url) throw new Error('未拿到图片数据');
        if (locked.seed != null) {
          const seedInput = lockHost.querySelector('[data-lock-seed]');
          if (seedInput && !seedInput.value) { seedInput.value = String(locked.seed); syncLockToChar(); }
        }
        url = await persistGeneratedImageUrlLocally(url).catch(() => url);
        const storedPortraitUrl = await optimizeImageDataUrlForNovelAiReference(url).catch(() => url);
        openCharacterDrawPreview(url, {
          onUseAvatar: () => {
            char.avatar = storedPortraitUrl;
            avatarBox.innerHTML = characterAvatarHtml(char, { className: 'contacts-avatar-img' });
            syncAvatarSaveButton();
            showToast('已设为头像，记得保存');
          },
          onUseRef: () => {
            char.imageLock = { ...(char.imageLock || {}), refImageUrl: storedPortraitUrl };
            refreshLockRefUi();
            showToast('已设为锁定参考图，记得保存');
          },
        });
      } catch (err) {
        showToast(`生成失败：${String((err && err.message) || err).slice(0, 140)}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = prev;
      }
    });
  }

  container.querySelector('.contacts-rel-add')?.addEventListener('click', () => {
    const list = container.querySelector('.contacts-rel-list');
    if (!list) return;
    const options = buildRelationTargetOptions(others, char.id);
    const item = document.createElement('div');
    item.className = 'contacts-rel-item';
    item.innerHTML = `
      <div class="contacts-rel-row">
        <select class="contacts-select contacts-rel-target">
          <option value="">选择对象…</option>
          ${options}
        </select>
        <button type="button" class="btn btn-sm btn-soft contacts-rel-remove">删</button>
      </div>
      <textarea class="contacts-textarea contacts-rel-text" rows="2" placeholder="关系描述"></textarea>
    `;
    list.appendChild(item);
    bindRelRemove(item);
  });

  function bindRelRemove(item) {
    item.querySelector('.contacts-rel-remove')?.addEventListener('click', () => item.remove());
  }
  container.querySelectorAll('.contacts-rel-item').forEach(bindRelRemove);

  function renderContactsWeatherStatus(extra = '') {
    const statusEl = container.querySelector('.contacts-weather-status');
    if (!statusEl) return;
    const info = getEffectiveWeatherCityForCharacter(collectForm(char, container));
    if (!info.weatherCity) {
      statusEl.textContent = extra || '填映射现实城市或所在城市后可检测';
      return;
    }
    const base = `当前使用：${info.weatherCity}（${info.source}）`;
    statusEl.textContent = extra ? `${base}；${extra}` : base;
  }

  function updateLocationAnchors() {
    const box = container.querySelector('.contacts-location-anchors');
    if (box) box.innerHTML = renderLocationAnchorList(char);
  }

  let latestMapExplore = null;

  function poiToLocationAnchor(poi, index) {
    const bucket = String(poi?.bucket || 'hangout').trim() || 'hangout';
    const idBase = String(poi?.id || poi?.location || poi?.name || `poi_${index + 1}`)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 48);
    return {
      id: `amap_${idBase || index + 1}`,
      kind: bucket,
      label: String(poi?.name || '').trim(),
      resolveMode: 'real_poi',
      area: String(poi?.businessArea || poi?.district || '').trim(),
      query: String(poi?.name || '').trim(),
      location: poi?.location || null,
      address: String(poi?.address || '').trim() || null,
      base: false,
      locked: true,
      confidence: 0.92,
      source: 'amap_explore',
    };
  }

  function renderMapExploreResults(result) {
    const host = container.querySelector('.contacts-map-results');
    if (!host) return;
    const pois = Array.isArray(result?.pois) ? result.pois.slice(0, 12) : [];
    host.hidden = false;
    if (!pois.length) {
      host.innerHTML = '<div class="contacts-map-empty">没有搜到可用地点，换个地标或商圈试试。</div>';
      return;
    }
    const rows = pois.map((poi, index) => {
      const meta = [poi.bucketLabel || bucketPoiLabel(poi.bucket), poi.businessArea || poi.district, poi.address]
        .filter(Boolean)
        .join(' · ');
      return `
        <label class="contacts-map-poi">
          <input type="checkbox" data-map-poi="${index}" ${index < 6 ? 'checked' : ''}>
          <span>
            <strong>${esc(poi.name)}</strong>
            <small>${esc(meta)}</small>
          </span>
        </label>
      `;
    }).join('');
    host.innerHTML = `
      <div class="contacts-map-result-head">真实地点候选</div>
      <div class="contacts-map-pois">${rows}</div>
      <button type="button" class="btn btn-sm btn-primary contacts-map-accept">收下选中地点</button>
    `;
  }

  async function searchMapLifeCircle() {
    const btn = container.querySelector('.contacts-map-search');
    const current = collectForm(char, container);
    if (current.locationProfile?.mapEnabled === false) {
      showToast('已关闭现实地图参照；天气仍可正常检测');
      return;
    }
    const anchor = current.residenceAnchor || {};
    const city = String(anchor.realCityMap || anchor.city || '').trim();
    const keywords = String(anchor.mapQuery || anchor.area || anchor.label || city || '').trim();
    if (!keywords) {
      showToast('先填现实城市或真实地点');
      container.querySelector('[data-nested="residenceAnchor.mapQuery"]')?.focus();
      return;
    }
    if (btn) btn.disabled = true;
    renderContactsWeatherStatus('正在搜索生活圈…');
    try {
      latestMapExplore = await amapExploreFromSeed({
        keywords,
        city,
        radius: 3000,
        maxResults: 8,
      });
      renderMapExploreResults(latestMapExplore);
      showToast('已找到附近真实地点');
    } catch (err) {
      const message = String((err && err.message) || err || '地图搜索失败');
      showToast(message);
      const host = container.querySelector('.contacts-map-results');
      if (host) {
        host.hidden = false;
        host.innerHTML = `<div class="contacts-map-empty">${esc(message)}</div>`;
      }
    } finally {
      renderContactsWeatherStatus();
      if (btn) btn.disabled = false;
    }
  }

  function acceptMapPois() {
    const pois = Array.isArray(latestMapExplore?.pois) ? latestMapExplore.pois : [];
    const selected = [...container.querySelectorAll('[data-map-poi]:checked')]
      .map((el) => pois[Number(el.getAttribute('data-map-poi'))])
      .filter(Boolean);
    if (!selected.length) {
      showToast('先勾选想收下的地点');
      return;
    }
    const current = collectForm(char, container);
    const profile = current.locationProfile && typeof current.locationProfile === 'object'
      ? { ...current.locationProfile }
      : {};
    const existingAnchors = Array.isArray(profile.anchors) ? profile.anchors.filter(Boolean) : [];
    const nextAnchors = [...existingAnchors];
    selected.map(poiToLocationAnchor).forEach((anchor) => {
      const hit = nextAnchors.some((item) => (
        String(item.id || '') === anchor.id
        || (anchor.location && String(item.location || '') === String(anchor.location))
      ));
      if (!hit) nextAnchors.push(anchor);
    });
    const residence = current.residenceAnchor || {};
    const city = String(residence.realCityMap || residence.city || '').trim();
    profile.mapEnabled = true;
    profile.mode = 'semi';
    profile.city = {
      ...(profile.city && typeof profile.city === 'object' ? profile.city : {}),
      name: city || latestMapExplore?.city || profile.city?.name || '',
      center: latestMapExplore?.center || profile.city?.center || null,
    };
    profile.region = String(residence.area || profile.region || '').trim();
    profile.anchors = nextAnchors;
    char = createCharacterProfile({ ...current, locationProfile: profile });
    updateLocationAnchors();
    showToast(`已收下 ${selected.length} 个真实地点，记得保存`);
  }

  container.querySelectorAll('[data-nested="residenceAnchor.city"], [data-nested="residenceAnchor.realCityMap"]')
    .forEach((el) => el.addEventListener('input', () => renderContactsWeatherStatus()));

  container.querySelector('.contacts-map-search')?.addEventListener('click', searchMapLifeCircle);
  container.querySelector('.contacts-map-results')?.addEventListener('click', (e) => {
    if (e.target.closest('.contacts-map-accept')) acceptMapPois();
  });

  container.querySelector('.contacts-weather-check')?.addEventListener('click', async () => {
    const btn = container.querySelector('.contacts-weather-check');
    const info = getEffectiveWeatherCityForCharacter(collectForm(char, container));
    if (!info.weatherCity) {
      showToast('请先填写映射现实城市或所在城市');
      renderContactsWeatherStatus();
      return;
    }
    if (btn) btn.disabled = true;
    renderContactsWeatherStatus('正在检测…');
    try {
      const weather = await fetchWeatherForCity(info.weatherCity);
      const hint = summarizeWeatherForHint(weather);
      const hintInput = container.querySelector('[data-nested="residenceAnchor.weatherHint"]');
      if (hintInput && hint) hintInput.value = hint.slice(0, 120);
      const sourceLabel = weatherSourceLabel(weather);
      renderContactsWeatherStatus(hint ? `${sourceLabel}：${summarizeWeatherDisplay(weather)}` : '已确认城市可用于天气');
      showToast(sourceLabel);
    } catch (err) {
      renderContactsWeatherStatus();
      showToast(String(err?.message || '天气检测失败'));
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  renderContactsWeatherStatus();

  const bubbleColorInput = container.querySelector('.contacts-bubble-color');
  const bubbleColorText = container.querySelector('.contacts-bubble-text');
  bubbleColorInput?.addEventListener('input', () => {
    if (bubbleColorText) bubbleColorText.value = bubbleColorInput.value;
  });
  bubbleColorText?.addEventListener('input', () => {
    const color = String(bubbleColorText.value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(color) && bubbleColorInput) {
      bubbleColorInput.value = color;
    }
  });
  videoBgInputEl?.addEventListener('input', syncVideoBackgroundPreview);
  videoBgFitEl?.addEventListener('change', syncVideoBackgroundPreview);
  videoBgPositionEl?.addEventListener('change', syncVideoBackgroundPreview);

  let saveInFlight = false;
  async function persist() {
    if (saveInFlight) {
      showToast('正在保存…', 1200);
      return;
    }
    const saveButton = container.querySelector('.contacts-edit-save');
    saveInFlight = true;
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.setAttribute('aria-busy', 'true');
      saveButton.setAttribute('aria-label', '保存中');
    }
    showToast('正在保存…', 1200);
    try {
      char = collectForm(char, container);
      if (char.dialNumber) {
        const dup = allChars.find((c) => (
          c.id !== char.id && normalizeDialNumber(c.dialNumber) === char.dialNumber
        ));
        if (dup) throw new Error(`编号 ${char.dialNumber} 已被「${dup.name || '其他角色'}」使用`);
      }
      // 保存只负责本地表单落库，绝不能暗中等待天气网络。天气提示由页面上的
      // 「检测天气」显式填写；否则接口慢或不可达会让人设编辑看起来整页卡死。
      char = identityScope && !isNew
        ? await saveCharacterForUser(currentUser.id, char, { forceOverride: true })
        : await saveCharacter(char);
      showToast(identityScope && !isNew ? '已保存到当前身份' : '已保存');
      if (isNew) navigate('contacts/edit', {
        id: char.id,
        ...(identityScope ? {
          scope: 'identity',
          identityUserId: String(currentUser.id),
        } : {}),
      }, true);
    } catch (err) {
      showToast(`保存失败：${String((err && err.message) || err)}`);
    } finally {
      saveInFlight = false;
      if (saveButton?.isConnected) {
        saveButton.disabled = false;
        saveButton.removeAttribute('aria-busy');
        saveButton.setAttribute('aria-label', '保存');
      }
    }
  }

  const quickfillToggle = container.querySelector('.contacts-quickfill-toggle');
  const quickfillBody = container.querySelector('.contacts-quickfill-body');
  const quickfillInput = container.querySelector('.contacts-quickfill-input');
  const quickfillParseBtn = container.querySelector('.contacts-quickfill-parse');
  const quickfillAiBtn = container.querySelector('.contacts-quickfill-ai');
  const aiFillEmptyBtn = container.querySelector('.contacts-ai-fill-empty');
  const aiFillRequestKey = [
    'contacts-edit',
    identityScope ? String(currentUser?.id || 'identity') : 'default',
    String(char.id || 'new'),
  ].join(':');
  let activeAiFillController = null;
  let pageDisposed = false;
  const setAiFillButtonsDisabled = (disabled) => {
    if (quickfillAiBtn?.isConnected) quickfillAiBtn.disabled = disabled;
    if (aiFillEmptyBtn?.isConnected) aiFillEmptyBtn.disabled = disabled;
  };
  const beginAiFillRequest = () => {
    if (activeAiFillController) {
      showToast('AI 正在补全，请等待当前请求结束');
      return null;
    }
    const controller = new AbortController();
    activeAiFillController = controller;
    setAiFillButtonsDisabled(true);
    return controller;
  };
  const finishAiFillRequest = (controller) => {
    if (activeAiFillController !== controller) return;
    activeAiFillController = null;
    if (!pageDisposed) setAiFillButtonsDisabled(false);
  };
  const onContactsEditDisposed = (event) => {
    if (event?.detail?.container !== container) return;
    pageDisposed = true;
    window.removeEventListener('marshmallow-route-disposed', onContactsEditDisposed);
    if (activeAiFillController?.signal) {
      activeAiFillController.signal.marshmallowAbortReason = 'route-disposed';
      activeAiFillController.abort();
    }
    activeAiFillController = null;
  };
  window.addEventListener('marshmallow-route-disposed', onContactsEditDisposed);

  quickfillToggle?.addEventListener('click', () => {
    const open = quickfillBody?.hasAttribute('hidden');
    if (open) {
      quickfillBody.removeAttribute('hidden');
      quickfillToggle.setAttribute('aria-expanded', 'true');
      quickfillToggle.classList.add('is-open');
    } else {
      quickfillBody.setAttribute('hidden', '');
      quickfillToggle.setAttribute('aria-expanded', 'false');
      quickfillToggle.classList.remove('is-open');
    }
  });

  // 每个人写卡的格式千奇百怪（<Char> 包裹、中英混标、缩进不一……），按标签智能拆字段
  // 很容易在某个格式上失配、把内容拆没了。上传文档统一走最笨也最稳的路：
  // 提取出的全文一律原样写进整段设定，不做智能拆分，交给 AI 在对话里自己理解卡结构。
  function applyDocumentText(text) {
    const raw = String(text || '').trim();
    if (!raw) {
      showToast('文档内容为空');
      return;
    }
    const corpusEl = container.querySelector('[data-key="promptCorpus"]');
    if (!corpusEl) {
      showToast('找不到整段设定输入框');
      return;
    }
    corpusEl.value = raw;
    char = collectForm(char, container);
    char.promptCorpus = raw;
    showToast(`已写入整段设定（${raw.length} 字），记得保存`);
    goPage(0);
    corpusEl.focus();
    try {
      corpusEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) {}
  }

  function applyDraftToEditor(draft, { onlyEmpty = false, source = '' } = {}) {
    const current = collectForm(char, container);
    const { profile, changed } = mergeCharacterDraft(current, draft, { onlyEmpty });
    char = profile;
    applyCharacterToForm(char, container, { esc, updateAvatar: true });
    if (!changed) {
      showToast(onlyEmpty ? '没有可补全的空白字段' : '未能识别可填入的字段');
      return false;
    }
    const label = source ? summarizeDraftSource(source) : '资料';
    showToast(`已从${label}填入 ${changed} 项，记得保存`);
    return true;
  }

  function reviewAndApplyAiDraft(draft, route = {}) {
    const current = collectForm(char, container);
    const fields = buildAiFillReviewFields(current, draft);
    if (!fields.length) {
      showToast('没有可补全的空白字段');
      return;
    }
    openAiFillReviewModal({
      fields,
      subtitle: `${aiRouteLabel(route)}生成；只列出你还没填的字段，已填内容不受影响。`,
      onConfirm: (entries) => {
        if (!entries.length) {
          showToast('没有勾选任何字段');
          return false;
        }
        return applyDraftToEditor(
          draftFromSelectedFields(entries),
          { onlyEmpty: true, source: 'ai' },
        );
      },
      onError: () => showToast('填入失败，请重试'),
    });
  }

  async function presentAiFillFailure(error, {
    retryWithMain,
    onUseRaw,
  } = {}) {
    const err = error instanceof Error ? error : new Error(String(error || 'AI 补全失败'));
    if (err.code === 'api-not-configured' && err.aiRoute?.apiSection !== 'tool') {
      showToast(err.message);
      navigate('settings/api');
      return;
    }
    const mainRoute = err.aiRoute?.apiSection === 'tool'
      ? await resolveCharacterAiRoute({ forceMainApi: true })
      : null;
    openAiFillErrorModal(err, {
      onRetryMain: mainRoute?.available ? retryWithMain : null,
      onShowRaw: (raw) => openAiRawResponseModal(raw, { onUse: onUseRaw }),
    });
  }

  quickfillParseBtn?.addEventListener('click', () => {
    const text = String(quickfillInput?.value || '').trim();
    if (!text) {
      showToast('请先粘贴内容');
      quickfillInput?.focus();
      return;
    }
    const { draft, source } = parseCharacterDraftText(text);
    if (!Object.keys(draft).length) {
      showToast('未能识别字段，可换「字段名：内容」格式，或直接粘贴简介');
      return;
    }
    applyDraftToEditor(draft, { onlyEmpty: false, source });
  });

  const runQuickfillAi = async ({ forceMainApi = false } = {}) => {
    const text = String(quickfillInput?.value || '').trim();
    if (!text) {
      showToast('请先粘贴简介或 JSON');
      quickfillInput?.focus();
      return;
    }
    const controller = beginAiFillRequest();
    if (!controller) return;
    const btn = quickfillAiBtn;
    const prevLabel = btn.textContent;
    try {
      const route = await resolveCharacterAiRoute({ forceMainApi });
      btn.textContent = `${route.sourceLabel}生成中…`;
      const current = collectForm(char, container);
      const { draft, recoveredFromPartial, route: actualRoute } = await aiFillCharacterDraft(text, current, {
        forceMainApi,
        requestKey: aiFillRequestKey,
        signal: controller.signal,
      });
      reviewAndApplyAiDraft(draft, actualRoute || route);
      if (recoveredFromPartial) showToast('连接中断，已救回收到的部分字段');
    } catch (err) {
      if (pageDisposed && (err?.name === 'AbortError' || err?.abortReason === 'route-disposed')) {
        return;
      }
      if (err?.code === 'ai-fill-no-empty-fields' || err?.code === 'ai-fill-no-source' || err?.code === 'ai-fill-in-progress') {
        showToast(String((err && err.message) || err));
      } else {
        await presentAiFillFailure(err, {
          retryWithMain: () => runQuickfillAi({ forceMainApi: true }),
          onUseRaw: (raw) => {
            if (!quickfillInput) return;
            quickfillInput.value = raw;
            quickfillInput.focus();
          },
        });
      }
    } finally {
      finishAiFillRequest(controller);
      if (!pageDisposed && btn?.isConnected) btn.textContent = prevLabel;
    }
  };

  quickfillAiBtn?.addEventListener('click', () => runQuickfillAi());

  const runAiFillEmpty = async ({ forceMainApi = false } = {}) => {
    const btn = aiFillEmptyBtn;
    const prevHtml = btn.innerHTML;
    const current = collectForm(char, container);
    const controller = beginAiFillRequest();
    if (!controller) return;
    try {
      const route = await resolveCharacterAiRoute({ forceMainApi });
      btn.innerHTML = `${icon('sparkle')}${route.sourceLabel}生成中…`;
      const { draft, recoveredFromPartial, route: actualRoute } = await aiFillCharacterDraft('', current, {
        forceMainApi,
        requestKey: aiFillRequestKey,
        signal: controller.signal,
      });
      reviewAndApplyAiDraft(draft, actualRoute || route);
      if (recoveredFromPartial) showToast('连接中断，已救回收到的部分字段');
    } catch (err) {
      if (pageDisposed && (err?.name === 'AbortError' || err?.abortReason === 'route-disposed')) {
        return;
      }
      if (err?.code === 'ai-fill-no-source') {
        showToast('先填一点角色资料');
        container.querySelector('[data-key="promptCorpus"]')?.focus();
      } else if (err?.code === 'ai-fill-no-empty-fields' || err?.code === 'ai-fill-in-progress') {
        showToast(String((err && err.message) || err));
      } else {
        await presentAiFillFailure(err, {
          retryWithMain: () => runAiFillEmpty({ forceMainApi: true }),
          onUseRaw: (raw) => {
            if (!quickfillInput) return;
            quickfillInput.value = raw;
            quickfillBody?.removeAttribute('hidden');
            quickfillToggle?.setAttribute('aria-expanded', 'true');
            quickfillToggle?.classList.add('is-open');
            quickfillInput.focus();
          },
        });
      }
    } finally {
      finishAiFillRequest(controller);
      if (!pageDisposed && btn?.isConnected) btn.innerHTML = prevHtml;
    }
  };

  aiFillEmptyBtn?.addEventListener('click', () => runAiFillEmpty());

  if (isNew) {
    quickfillBody?.removeAttribute('hidden');
    quickfillToggle?.setAttribute('aria-expanded', 'true');
    quickfillToggle?.classList.add('is-open');
  }

  const recentlyHandledCriticalTouch = () => Date.now() - lastCriticalTouchAt < 800;
  container.querySelector('.contacts-edit-save')?.addEventListener('click', () => {
    if (recentlyHandledCriticalTouch()) return;
    void persist();
  });
  container.querySelector('.contacts-edit-back')?.addEventListener('click', () => {
    if (recentlyHandledCriticalTouch()) return;
    back();
  });

  container.querySelector('.contacts-export-one')?.addEventListener('click', () => {
    try {
      const snapshot = collectForm(char, container);
      downloadSingleCharacterExport(snapshot);
      showToast('已导出角色包');
    } catch (err) {
      showToast(String((err && err.message) || err));
    }
  });
  container.querySelector('.contacts-share-one')?.addEventListener('click', async () => {
    try {
      const snapshot = collectForm(char, container);
      const payload = await buildCharactersExportPayload({ characters: [snapshot], includeGroups: false });
      shareToCommunityStore({
        source: payload,
        fileName: `character-${snapshot.name || '角色'}.json`,
        resourceType: 'character-card',
        title: snapshot.name || '角色卡',
        originLabel: '角色编辑',
      });
    } catch (err) {
      showToast(String(err?.message || err));
    }
  });

  container.querySelector('.contacts-delete')?.addEventListener('click', async () => {
    if (!char.id) return;
    if (!window.confirm(`确定删除「${char.name}」？TA 名下的私聊记录、记忆都会一起清掉，此操作不可撤销。`)) return;
    try {
      await deleteCharacterCascade(char.id);
      showToast('已删除');
      navigate('contacts', {}, true);
    } catch (err) {
      showToast(`删除失败：${err?.message || err}`);
    }
  });
}
