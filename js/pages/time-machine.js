import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { getUserDisplayName } from '../models/user.js';
import { listCharacters, getCharacter } from '../core/character-store.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { showCutscene } from '../components/encounter-cutscene.js';
import { primeDisplayRegex, applyDisplayRegex } from '../core/display-regex.js';
import {
  DEFAULT_TIME_MACHINE_IMAGE_STYLE,
  TIME_MACHINE_THEMES,
  getThemeLabel,
  generateTimeMachineFragment,
  generateTimeMachineIllustration,
  collectTimeMachineFragment,
} from '../core/time-machine.js';
import { loadSavedWordRange, saveWordRangePrefs } from '../core/narration-settings.js';
import { openShareCardModal } from '../components/share-card-export.js';
import { updateNarrationEntry } from '../core/narration-archive.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { listOfflineScenePresets, saveOfflineScenePreset, deleteOfflineScenePreset, getLastOfflineScenePresetId, setLastOfflineScenePresetId, pickOfflineScenePresetFields } from '../core/offline-scene-presets.js';
import { scenePresetBarHtml, bindMechanicsCommonControls } from '../components/offline-scene-mechanics.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  await primeDisplayRegex();
  const all = await listCharacters({ excludeAnonNpc: true });
  const characters = (all || []).filter((c) => c && c.id);

  let selectedId = String(params.character || '').trim();
  if (selectedId && !characters.some((c) => c.id === selectedId)) selectedId = '';
  if (!selectedId && characters.length === 1) selectedId = characters[0].id;

  let viewpoint = 'observe';
  let themeId = 'childhood';
  let customTheme = '';
  let fragment = null;
  let busy = false;
  let imageBusy = false;
  let autoImageEnabled = (() => {
    try {
      return localStorage.getItem('timeMachineAutoImage') === '1';
    } catch (_) {
      return false;
    }
  })();
  const savedWordRange = await loadSavedWordRange(200, 500);
  let wordMin = savedWordRange.wordMin;
  let wordMax = savedWordRange.wordMax;
  let scenePresets = await listOfflineScenePresets(user.id).catch(() => []);
  let selectedPresetId = await getLastOfflineScenePresetId(user.id).catch(() => '');
  const lastPreset = selectedPresetId
    ? scenePresets.find((p) => p.id === selectedPresetId)
    : null;
  if (lastPreset) {
    const min = Number(lastPreset.wordMin);
    const max = Number(lastPreset.wordMax);
    if (Number.isFinite(min)) wordMin = Math.max(30, Math.round(min));
    if (Number.isFinite(max)) wordMax = Math.max(wordMin + 30, Math.round(max));
  } else {
    selectedPresetId = '';
  }
  let imageStylePrompt = (() => {
    try {
      return localStorage.getItem('timeMachineImageStylePrompt') || DEFAULT_TIME_MACHINE_IMAGE_STYLE;
    } catch (_) {
      return DEFAULT_TIME_MACHINE_IMAGE_STYLE;
    }
  })();

  container.className = 'page scrapbook-page time-machine-page';

  /** 预设条只对时光机通用的字段生效：字数区间；轮数/视角绑定/世界书等线下专属字段在这里不适用。 */
  function applyPresetWordRange(preset) {
    if (!preset) return;
    const min = Number(preset.wordMin);
    const max = Number(preset.wordMax);
    if (Number.isFinite(min)) wordMin = Math.max(30, Math.round(min));
    if (Number.isFinite(max)) wordMax = Math.max(wordMin + 30, Math.round(max));
    const minEl = container.querySelector('.tm-wmin');
    const maxEl = container.querySelector('.tm-wmax');
    if (minEl) minEl.value = wordMin;
    if (maxEl) maxEl.value = wordMax;
  }

  function selectedCharacter() {
    return characters.find((c) => c.id === selectedId) || null;
  }

  function chooserHtml() {
    if (!characters.length) {
      return '<div class="tm-no-char">还没有角色，先去通讯录创建一个吧。</div>';
    }
    return `
      <div class="tm-chooser">
        ${characters.map((c) => `
          <button type="button" class="tm-char ${c.id === selectedId ? 'is-active' : ''}" data-char="${esc(c.id)}">
            ${characterAvatarHtml(c, { className: 'tm-char-avatar' })}
            <span class="tm-char-name">${esc(c.customNickname || c.name || '角色')}</span>
          </button>
        `).join('')}
      </div>`;
  }

  function themeChipsHtml() {
    return TIME_MACHINE_THEMES.map((t) => `
      <button type="button" class="tm-chip ${t.id === themeId ? 'is-active' : ''}" data-theme="${t.id}">${esc(t.label)}</button>
    `).join('');
  }

  function resultHtml() {
    if (!fragment) {
      return '<div class="tm-result-empty">选好对象与主题，点「展开这段过往」。</div>';
    }
    const joined = (fragment.paragraphs || []).map((p) => String(p || '')).join('\n\n');
    const cleaned = applyDisplayRegex(joined, 'timemachine');
    const paras = cleaned
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${esc(p)}</p>`).join('');
    const ownerLabel = esc(fragment.characterName || 'TA');
    return `
      <article class="tm-polaroid">
        <div class="tm-polaroid-photo">
          ${fragment.image
            ? `<img src="${esc(fragment.image)}" alt="">`
            : `<span class="tm-polaroid-icon-hint">${fragment.imageLoading ? '画图中…' : (fragment.iconHint ? esc(fragment.iconHint) : '生图位')}</span>`}
        </div>
        <div class="tm-polaroid-caption">
          <div class="tm-polaroid-title">${esc(fragment.title)}</div>
          <div class="tm-polaroid-meta">${esc(fragment.themeLabel)} · ${fragment.viewpoint === 'cocreate' ? '一起创造' : '旁观回顾'} · ${ownerLabel}</div>
          <div class="tm-polaroid-body">${paras}</div>
        </div>
      </article>
      <div class="tm-result-actions">
        <button type="button" class="btn btn-outline tm-edit-text">编辑</button>
        <button type="button" class="btn btn-outline tm-reroll">换一段</button>
        <button type="button" class="btn btn-outline tm-illustrate" ${imageBusy ? 'disabled' : ''}>${fragment.imageLoading ? '画图中…' : (fragment.image ? '重画插画' : '生成插画')}</button>
        <button type="button" class="btn btn-outline tm-share-card">小卡</button>
        <button type="button" class="btn btn-primary tm-collect" data-owner="${esc(fragment.characterId || '')}">收进收藏</button>
      </div>`;
  }

  function renderStreamingFragment(preview = {}, character) {
    const resultEl = container.querySelector('.tm-result');
    if (!resultEl) return;
    const ownerLabel = character?.customNickname || character?.name || '角色';
    const pending = !(preview.paragraphs || []).length;
    fragment = {
      title: preview.title || getThemeLabel(themeId, customTheme),
      summary: preview.summary || '',
      paragraphs: preview.paragraphs?.length ? preview.paragraphs : ['正在写下这段过往…'],
      body: preview.body || '',
      iconHint: preview.iconHint || '',
      themeId,
      themeLabel: getThemeLabel(themeId, customTheme),
      viewpoint,
      characterId: character?.id || selectedId,
      characterName: ownerLabel,
      streaming: true,
    };
    resultEl.innerHTML = resultHtml();
    resultEl.querySelector('.tm-polaroid')?.classList.add('is-streaming');
    if (pending) resultEl.querySelector('.tm-polaroid-body')?.classList.add('is-pending');
    resultEl.querySelector('.tm-result-actions')?.remove();
  }

  function paint() {
    const prevScroll = captureScrollerTop(container, '.tm-scroll');
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">时光机</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="tm-scroll">
        <section class="scrapbook-card tm-setup">
          <div class="chat-details-section-title">看谁的过往</div>
          ${chooserHtml()}

          <div class="chat-details-section-title">视角</div>
          <div class="tm-segmented">
            <button type="button" class="tm-seg ${viewpoint === 'observe' ? 'is-active' : ''}" data-vp="observe">旁观回顾</button>
            <button type="button" class="tm-seg ${viewpoint === 'cocreate' ? 'is-active' : ''}" data-vp="cocreate">一起创造</button>
          </div>

          <div class="chat-details-section-title">引子</div>
          <div class="tm-chips">${themeChipsHtml()}</div>
          <input type="text" class="form-input tm-custom" placeholder="自定义主题或补充（如：一次搬家、养过的猫）" value="${esc(customTheme)}" ${themeId === 'custom' ? '' : 'hidden'} />

          <div class="chat-details-section-title">篇幅（字数由你定）</div>
          ${scenePresetBarHtml(scenePresets, selectedPresetId)}
          <div class="off-num-row">
            <label class="api-field off-num">
              <span class="api-field-label">字数下限</span>
              <input type="number" class="form-input tm-wmin" value="${wordMin}" min="30" step="50" />
            </label>
            <label class="api-field off-num">
              <span class="api-field-label">字数上限</span>
              <input type="number" class="form-input tm-wmax" value="${wordMax}" min="60" step="50" />
            </label>
          </div>

          <div class="chat-details-section-title">插画关键词</div>
          <textarea class="form-input tm-image-style" rows="4" placeholder="留空使用默认淡彩卡通水彩风">${esc(imageStylePrompt)}</textarea>

          <div class="tm-generate-row">
            <button type="button" class="btn btn-primary tm-generate">展开这段过往 ▷</button>
            <label class="tm-auto-image">
              <input type="checkbox" class="tm-auto-image-input" ${autoImageEnabled ? 'checked' : ''} />
              <span>同步生图</span>
            </label>
          </div>
        </section>

        <section class="tm-result">${resultHtml()}</section>
      </main>
    `;
    restoreScrollerTop(container, '.tm-scroll', prevScroll);
    bind();
  }

  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelectorAll('[data-char]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextId = btn.getAttribute('data-char');
        if (fragment?.characterId && nextId !== fragment.characterId) {
          fragment = null;
          showToast('已切换角色，请重新生成这段过往');
        }
        selectedId = nextId;
        paint();
      });
    });
    container.querySelectorAll('[data-vp]').forEach((btn) => {
      btn.addEventListener('click', () => {
        viewpoint = btn.getAttribute('data-vp');
        container.querySelectorAll('[data-vp]').forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    });
    container.querySelectorAll('[data-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        themeId = btn.getAttribute('data-theme');
        container.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('is-active', b === btn));
        const custom = container.querySelector('.tm-custom');
        if (custom) custom.hidden = themeId !== 'custom';
      });
    });
    container.querySelector('.tm-custom')?.addEventListener('input', (e) => {
      customTheme = e.target.value;
    });
    container.querySelector('.tm-wmin')?.addEventListener('input', (e) => {
      wordMin = Math.max(30, Number(e.target.value) || 0);
    });
    container.querySelector('.tm-wmax')?.addEventListener('input', (e) => {
      wordMax = Math.max(60, Number(e.target.value) || 0);
    });
    container.querySelector('.tm-image-style')?.addEventListener('input', (e) => {
      imageStylePrompt = String(e.target.value || '');
      try { localStorage.setItem('timeMachineImageStylePrompt', imageStylePrompt); } catch (_) { /* ignore */ }
    });
    container.querySelector('.tm-auto-image-input')?.addEventListener('change', (e) => {
      autoImageEnabled = Boolean(e.target.checked);
      try { localStorage.setItem('timeMachineAutoImage', autoImageEnabled ? '1' : '0'); } catch (_) { /* ignore */ }
    });
    bindMechanicsCommonControls(container, {
      onApplyPreset: (id) => {
        const preset = scenePresets.find((p) => p.id === id);
        if (preset) {
          selectedPresetId = preset.id;
          applyPresetWordRange(preset);
          setLastOfflineScenePresetId(user.id, preset.id).catch(() => {});
        } else {
          selectedPresetId = '';
        }
      },
    });
    container.querySelector('.off-preset-save')?.addEventListener('click', () => {
      openTextEditorModal({
        title: '存为新预设',
        value: '',
        multiline: false,
        placeholder: '给这组设置起个名字',
        confirmLabel: '保存',
        onSave: async (name) => {
          if (!name) { showToast('名字不能为空'); return; }
          const saved = await saveOfflineScenePreset(user.id, {
            name,
            ...pickOfflineScenePresetFields({ wordMin, wordMax }),
          });
          selectedPresetId = saved.id;
          scenePresets = await listOfflineScenePresets(user.id);
          showToast('已保存预设');
          paint();
        },
      });
    });
    container.querySelector('.off-preset-delete')?.addEventListener('click', async () => {
      const id = container.querySelector('.off-preset-select')?.value;
      if (!id) { showToast('先选一个预设'); return; }
      await deleteOfflineScenePreset(user.id, id);
      selectedPresetId = '';
      scenePresets = await listOfflineScenePresets(user.id);
      showToast('已删除预设');
      paint();
    });
    container.querySelector('.tm-generate')?.addEventListener('click', onGenerate);
    container.querySelector('.tm-edit-text')?.addEventListener('click', onEditText);
    container.querySelector('.tm-reroll')?.addEventListener('click', onGenerate);
    container.querySelector('.tm-illustrate')?.addEventListener('click', onGenerateImage);
    container.querySelector('.tm-share-card')?.addEventListener('click', onShareCard);
    container.querySelector('.tm-collect')?.addEventListener('click', onCollect);
  }

  async function onGenerate() {
    if (busy) return;
    const character = selectedCharacter();
    if (!character) { showToast('先选一个角色'); return; }
    if (themeId === 'custom') {
      customTheme = String(container.querySelector('.tm-custom')?.value || '').trim();
    }
    await saveWordRangePrefs({ wordMin, wordMax });
    busy = true;
    const genBtn = container.querySelector('.tm-generate');
    const rerollBtn = container.querySelector('.tm-reroll');
    let generated = false;
    let lastStreamPaint = 0;
    let lastStreamLength = 0;
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = '展开中…'; }
    if (rerollBtn) { rerollBtn.disabled = true; rerollBtn.textContent = '生成中…'; }
    const cut = showCutscene('candy', viewpoint === 'cocreate' ? '正在编织这段过往…' : '正在拆开这段过往…');
    let cutClosed = false;
    const closeCut = (duration) => {
      if (cutClosed) return;
      cutClosed = true;
      void cut.close(duration);
    };
    const cutTimer = setTimeout(() => closeCut(), 700);
    try {
      renderStreamingFragment({}, character);
      container.querySelector('.tm-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      fragment = await generateTimeMachineFragment({
        character,
        characterId: character.id,
        viewpoint,
        themeId,
        customTheme,
        userName: getUserDisplayName(user),
        user,
        userId: user.id,
        wordMin,
        wordMax,
        onChunk: (fullText, preview) => {
          closeCut();
          const now = Date.now();
          const len = String(fullText || '').length;
          if (now - lastStreamPaint < 120 && len - lastStreamLength < 24) return;
          lastStreamPaint = now;
          lastStreamLength = len;
          renderStreamingFragment(preview, character);
        },
      });
      fragment.characterId = character.id;
      fragment.characterName = character.customNickname || character.name || fragment.characterName || '角色';
      await persistFragmentSnapshot({ quiet: true });
      generated = true;
      closeCut();
      const resultEl = container.querySelector('.tm-result');
      if (resultEl) resultEl.innerHTML = resultHtml();
      bind();
      container.querySelector('.tm-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      if (!cutClosed) {
        cutClosed = true;
        await cut.close(0);
      }
      fragment = null;
      const resultEl = container.querySelector('.tm-result');
      if (resultEl) resultEl.innerHTML = resultHtml();
      bind();
      showToast(`失败：${e?.message || e}`);
    } finally {
      clearTimeout(cutTimer);
      busy = false;
      const g = container.querySelector('.tm-generate');
      if (g) { g.disabled = false; g.textContent = '展开这段过往 ▷'; }
      const r = container.querySelector('.tm-reroll');
      if (r) { r.disabled = false; r.textContent = '换一段'; }
      if (generated && autoImageEnabled) {
        void onGenerateImage({ auto: true });
      }
    }
  }

  async function onGenerateImage(options = {}) {
    if (!fragment || busy || imageBusy) return;
    const character = fragment.characterId ? await getCharacter(fragment.characterId).catch(() => null) : selectedCharacter();
    const targetKey = [fragment.characterId, fragment.title, fragment.body || (fragment.paragraphs || []).join('\n')].join('|');
    const isCurrentTarget = () => (
      fragment
      && [fragment.characterId, fragment.title, fragment.body || (fragment.paragraphs || []).join('\n')].join('|') === targetKey
    );
    imageBusy = true;
    fragment = { ...fragment, imageLoading: true };
    const resultEl = container.querySelector('.tm-result');
    if (resultEl) resultEl.innerHTML = resultHtml();
    bind();
    const btn = container.querySelector('.tm-illustrate');
    if (btn) { btn.disabled = true; btn.textContent = '画图中…'; }
    try {
      const result = await generateTimeMachineIllustration({
        fragment,
        character,
        stylePrompt: imageStylePrompt,
        onImage: (image) => {
          if (!isCurrentTarget()) return;
          fragment = { ...fragment, image };
          const resultEl = container.querySelector('.tm-result');
          if (resultEl) resultEl.innerHTML = resultHtml();
          bind();
        },
      });
      if (isCurrentTarget()) {
        fragment = { ...fragment, ...result, imageLoading: false };
        await persistFragmentSnapshot({ quiet: true });
        const doneEl = container.querySelector('.tm-result');
        if (doneEl) doneEl.innerHTML = resultHtml();
        bind();
        showToast(options.auto ? '过往和插画已生成' : '插画已生成');
      }
    } catch (e) {
      if (isCurrentTarget()) {
        fragment = { ...fragment, imageLoading: false };
        const failEl = container.querySelector('.tm-result');
        if (failEl) failEl.innerHTML = resultHtml();
        bind();
      }
      showToast(`生图失败：${e?.message || e}`);
    } finally {
      imageBusy = false;
      if (isCurrentTarget()) {
        fragment = { ...fragment, imageLoading: false };
        const finalEl = container.querySelector('.tm-result');
        if (finalEl) finalEl.innerHTML = resultHtml();
        bind();
      }
    }
  }

  function onEditText() {
    if (!fragment || fragment.streaming) return;
    const current = fragment.body || (fragment.paragraphs || []).join('\n\n');
    openTextEditorModal({
      title: '编辑这段过往',
      value: current,
      placeholder: '修改后保存将覆盖当前文本',
      confirmLabel: '保存',
      onSave: async (next) => {
        if (!next) { showToast('内容不能为空'); return; }
        const paragraphs = next.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
        fragment = {
          ...fragment,
          body: next,
          paragraphs: paragraphs.length ? paragraphs : [next],
        };
        const resultEl = container.querySelector('.tm-result');
        if (resultEl) resultEl.innerHTML = resultHtml();
        bind();
        await persistFragmentSnapshot({ quiet: true });
        showToast('已保存');
      },
    });
  }

  function onShareCard() {
    if (!fragment) return;
    openShareCardModal({
      title: fragment.title || '时光机',
      subtitle: [fragment.characterName, fragment.themeLabel, fragment.viewpoint === 'cocreate' ? '一起创造' : '旁观回顾'].filter(Boolean).join(' · '),
      fullText: fragment.body || (fragment.paragraphs || []).join('\n'),
      image: fragment.image || '',
      imageHint: fragment.iconHint || '时光机',
      footer: '时光机 · 棉花糖机',
      filenameBase: `time-machine-${fragment.title || Date.now()}`,
    });
  }

  async function onCollect() {
    if (!fragment) return;
    const ownerId = String(fragment.characterId || '').trim();
    if (!ownerId) {
      showToast('这段回忆缺少归属角色，请重新生成');
      return;
    }
    const btn = container.querySelector('.tm-collect');
    if (btn) { btn.disabled = true; btn.textContent = '收纳中…'; }
    try {
      await persistFragmentSnapshot({ quiet: false });
      const ownerName = fragment.characterName || 'TA';
      showToast(fragment.viewpoint === 'cocreate'
        ? `已收进收藏，并记进与 ${ownerName} 的共同回忆`
        : `已收进 ${ownerName} 的收藏册`);
      navigate('his-space', { character: ownerId });
    } catch (e) {
      showToast(`失败：${e?.message || e}`);
      if (btn) { btn.disabled = false; btn.textContent = '收进收藏'; }
    }
  }

  async function persistFragmentSnapshot(options = {}) {
    try {
      if (!fragment) return null;
      const ownerId = String(fragment.characterId || selectedId || '').trim();
      if (!ownerId) return null;
      const saved = await collectTimeMachineFragment({ userId: user.id, characterId: ownerId, fragment });
      fragment = { ...fragment, collectibleId: saved.id };
      if (fragment.narrationArchiveId && (fragment.image || fragment.imagePrompt)) {
        await updateNarrationEntry(fragment.narrationArchiveId, {
          image: fragment.image || '',
          imagePrompt: fragment.imagePrompt || '',
          meta: { collectibleId: saved.id },
        });
      }
      return saved;
    } catch (e) {
      if (options.quiet !== false) {
        console.warn('[time-machine] autosave failed:', e);
        return null;
      }
      throw e;
    }
  }

  paint();
}
