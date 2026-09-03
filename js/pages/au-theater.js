import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { beginLongTaskNotice } from '../core/long-task-notifications.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { saveOfflineFavorite } from '../core/message-favorites.js';
import { downloadTextFile } from '../core/appearance-theme-export.js';
import {
  ensureDefaultUser,
  createUserSlotFromIdentity,
  setCurrentUserId,
} from '../core/user-slot.js';
import { openSlotNameModal } from '../components/slot-name-modal.js';
import { listCharacters, getCharacter } from '../core/character-store.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showCutscene } from '../components/encounter-cutscene.js';
import { primeDisplayRegex, applyDisplayRegex } from '../core/display-regex.js';
import { sanitizeNarrationOutput, splitNarrationParagraphs } from '../core/narration-sanitize.js';
import {
  listAuPresets,
  listAuStories,
  getAuStory,
  createAuStory,
  runAuBeat,
  continueAuBeat,
  summarizeAuStory,
  shareAuStoryToCharacters,
  auStoryCharacterIds,
  auStoryCharacterNames,
  auStoryIncludesUser,
  deleteAuStory,
  canReviseLastAuBeat,
  listAuRerollVersions,
  selectAuRerollVersion,
  restoreAuRevision,
  applyAuExternalRevision,
  buildAuCharacterProfileText,
  deleteAuBeat,
  saveAuStory,
  getAuStoryMechanics,
  updateAuStoryMechanics,
  generateAuBeatImage,
  resolveAuBeatImagePrompt,
  clearAuBeatImage,
  missingAuCharacterStateIds,
  supplementAuCharacterStates,
  buildAuWorldBackground,
} from '../core/au-theater.js';
import { loadSavedWordRange, saveWordRangePrefs } from '../core/narration-settings.js';
import { openShareCardModal } from '../components/share-card-export.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { openImageLightbox } from '../components/image-lightbox.js';
import { openCharStatePopover } from '../components/char-state-popover.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import { normalizeAuConfig } from '../core/au-config.js';
import {
  beatActionsHtml,
  bindOfflineBeatDelete,
  openOfflineBeatActionLayer,
} from '../components/offline-beat-ui.js';
import { renderNarrationTextWithTranslations, bindNarrationTranslationToggle } from '../core/narration-translation.js';
import {
  listOfflineScenePresets,
  saveOfflineScenePreset,
  deleteOfflineScenePreset,
  getLastOfflineScenePresetId,
  setLastOfflineScenePresetId,
  pickOfflineScenePresetFields,
} from '../core/offline-scene-presets.js';
import { listAllWorldBookRows } from '../core/world-book-store.js';
import { runNarrativeExpertConsultation } from '../core/expert-consultation.js';
import {
  listApiSectionPresetOptions,
  resolveApiSectionPresetConfig,
} from '../core/api-presets.js';
import { listOfflinePresetOptions } from '../core/preset-store.js';
import {
  sceneMechanicsFieldsHtml,
  scenePresetBarHtml,
  readMechanicsFromInputs,
  applyMechanicsPresetToInputs,
  bindMechanicsCommonControls,
  refreshScenePresetSelect,
} from '../components/offline-scene-mechanics.js';
import {
  OFFLINE_STYLE_DEFAULTS,
  loadOfflineStylePrefs,
  normalizeOfflineStylePrefs,
  prepareOfflineStyleCss,
  resolveOfflineInnerVoiceCard,
  saveOfflineStylePrefs,
} from '../core/offline-appearance.js';
import { offlineCharacterStateHistory } from '../core/offline-character-states.js';
import {
  ensureOfflineBranching,
  addOfflineBookmark,
  deleteOfflineBookmark,
  getOfflineForkEligibility,
  forkOfflineBranch,
  switchOfflineBranch,
  renameOfflineBranch,
  deleteOfflineBranch,
} from '../core/offline-branch-snapshot.js';
import { findPrivateChat } from '../core/chat-store.js';
import {
  isNarrationGenerationActive,
  narrationGenerationLeaseKey,
  reconcileNarrationGenerationActivity,
  registerNarrationGenerationAbortController,
  requestNarrationGenerationAbort,
  canForceReleaseNarrationGenerationLease,
  forceReleaseNarrationGenerationLease,
} from '../core/narration-generation-lease.js';
import {
  loadInnerVoiceCardPresets,
  parseInnerVoiceCardImportText,
  presetToCard,
} from '../core/chat/inner-voice-style.js';
import { openOfflineStyleManager } from '../components/offline-style-manager.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reportAuGenerationError(error, title = '番外推进失败') {
  const report = generationErrorFromCatch(error, {
    scope: '番外剧场',
    title,
    rawText: error?.rawText || error?.rawResponse || '',
  });
  showGenerationErrorReport(report);
  showToast(`失败：${String(report.message || error?.message || error || '生成失败').slice(0, 120)}`);
  return report;
}

function auReasoningHtml(reasoningText = '') {
  const text = String(reasoningText || '').trim();
  if (!text) return '';
  return `<details class="offline-reasoning">
    <summary><i aria-hidden="true"></i><span>模型思考</span></summary>
    <pre>${esc(text)}</pre>
  </details>`;
}

function applyAuStylePrefs(container, prefs = {}) {
  const normalized = normalizeOfflineStylePrefs(prefs);
  container.dataset.osBg = normalized.bg;
  container.dataset.osFont = normalized.font;
  container.dataset.osAnchor = normalized.anchor ? 'on' : 'off';
  container.dataset.osTimelineNav = normalized.timelineNav ? 'on' : 'off';
  container.dataset.osReasoning = normalized.showReasoning ? 'on' : 'off';
  container.style.setProperty('--os-body-size', `${normalized.size}px`);
  container.style.setProperty('--os-leading', String(normalized.leading));
  container.style.setProperty('--os-measure', normalized.measure === 'wide' ? '100%' : '42em');
  if (normalized.textColor) container.style.setProperty('--os-body-ink', normalized.textColor);
  else container.style.removeProperty('--os-body-ink');
  if (normalized.bgImage) {
    container.dataset.osHasBg = '1';
    container.style.setProperty('--os-bg-image', `url("${normalized.bgImage}")`);
    const veilRgb = normalized.bg === 'dusk' ? '25, 26, 29' : '255, 255, 255';
    container.style.setProperty('--os-veil', `rgba(${veilRgb}, ${normalized.veil})`);
  } else {
    delete container.dataset.osHasBg;
    container.style.removeProperty('--os-bg-image');
    container.style.removeProperty('--os-veil');
  }
  let style = document.getElementById('os-custom-css');
  if (!style) {
    style = document.createElement('style');
    style.id = 'os-custom-css';
    document.head.appendChild(style);
  }
  style.media = document.documentElement.classList.contains('beautify-safe-mode') ? 'not all' : 'all';
  style.textContent = prepareOfflineStyleCss(normalized.css || '');
}

const AU_HISTORY_FOLD_KEEP = 30;

function auBeatFooterHtml(beat, {
  latest = false,
  image = false,
  hasImage = false,
  clearImage = false,
  continuation = false,
  bookmark = false,
  fork = false,
  favorite = false,
} = {}) {
  const beatId = String(beat?.id || '');
  const beatIdAttr = esc(beatId);
  return `
    <footer class="os-beat-footer">
      <div class="os-beat-meta">
        <span class="os-beat-rule" aria-hidden="true"></span>
        <button type="button" class="os-beat-menu" data-beat-menu="${beatIdAttr}" aria-label="本段操作" aria-expanded="false" title="本段操作">${icon('more')}</button>
      </div>
      ${latest ? `
        <span class="os-beat-quick-actions" aria-label="本轮快捷操作">
          ${continuation ? `<button type="button" data-beat-continue="${beatIdAttr}">续写本层</button>` : ''}
          <button type="button" data-beat-reroll="${beatIdAttr}">重 roll</button>
          <button type="button" data-beat-revise="${beatIdAttr}">指导重修</button>
          <button type="button" data-beat-audit-reroll="${beatIdAttr}">补审重写</button>
          <button type="button" data-beat-expert="${beatIdAttr}">专家会诊 <small>测试中</small></button>
        </span>` : ''}
      ${beatActionsHtml(beatId, {
        hidden: true,
        image,
        hasImage,
        clearImage,
        continuation: latest && continuation,
        supplementalAudit: latest,
        expertConsultation: latest,
        bookmark,
        fork,
        favorite,
      })}
    </footer>`;
}

function beatsHtml(session, view = {}) {
  if (!session?.beats?.length) {
    return '<div class="offline-empty">点「推进」开始这段番外。</div>';
  }
  const allBeats = session.beats;
  const historyExpanded = view.historyExpanded === true || view.manageMode === true;
  const hiddenCount = historyExpanded ? 0 : Math.max(0, allBeats.length - AU_HISTORY_FOLD_KEEP);
  const visibleBeats = hiddenCount ? allBeats.slice(hiddenCount) : allBeats;
  const selectedBeats = view.selectedBeats instanceof Set ? view.selectedBeats : new Set();
  const pick = (beat) => view.manageMode === true
    ? `<label class="os-beat-pick"><input type="checkbox" data-beat-pick="${esc(beat.id)}" ${selectedBeats.has(beat.id) ? 'checked' : ''} aria-label="选中这条"></label>`
    : '';
  const lastNarration = [...allBeats].reverse().find((beat) => beat?.role === 'narration');
  const expectedThoughtIds = getAuStoryMechanics(session).innerVoiceEnabled
    ? auStoryCharacterIds(session)
    : [];
  const rows = visibleBeats.map((b) => {
    if (b.role === 'directive') {
      return `<div class="offline-beat offline-beat--directive" data-beat-id="${esc(b.id)}">
        ${pick(b)}<span>${auStoryIncludesUser(session) ? '你的方向' : '导演方向'}</span><p>${esc(b.text)}</p>
        ${auBeatFooterHtml(b)}
      </div>`;
    }
    const cleaned = applyDisplayRegex(sanitizeNarrationOutput(b.text || ''), 'autheater');
    const paras = splitNarrationParagraphs(cleaned);
    const states = b.characterStates && typeof b.characterStates === 'object'
      ? Object.entries(b.characterStates)
      : [];
    const image = b.image?.url
      ? `<div class="offline-beat-image">
          <img src="${esc(b.image.url)}" alt="番外场景图" loading="lazy" data-beat-image-view="${esc(b.id)}" />
          ${b.image.warning ? `<p class="offline-beat-image-warning">${esc(b.image.warning)}</p>` : ''}
        </div>`
      : (b.image?.error
        ? `<div class="offline-beat-image offline-beat-image--error">
            <p>场景图未生成：${esc(b.image.error)}</p>
            <button type="button" class="btn btn-outline btn-sm" data-beat-image="${esc(b.id)}">重试生图</button>
          </div>`
        : '');
    const voiceLines = (Array.isArray(b.voiceLines) ? b.voiceLines : [])
      .filter((line) => line?.audio?.dataUrl);
    const audio = voiceLines.length
      ? `<div class="offline-beat-voice-lines">${voiceLines.map((line) => `
          <div class="offline-beat-voice-line">
            <span>${esc(line.actorName || '角色')}</span>
            <audio class="offline-beat-audio" controls preload="none" src="${esc(line.audio.dataUrl)}"></audio>
          </div>
        `).join('')}</div>`
      : '';
    const missingThoughtIds = b.id === lastNarration?.id
      ? missingAuCharacterStateIds(b, expectedThoughtIds)
      : [];
    const thoughtButtons = states.map(([characterId, state]) => (
      `<button type="button" class="os-beat-thought" data-au-thought="${esc(characterId)}" data-thought-beat="${esc(b.id)}">${esc(state?.name || 'TA')} · 心声</button>`
    )).join('');
    const supplementButton = missingThoughtIds.length
      ? `<button type="button" class="os-beat-thought" data-au-thought-supplement="${esc(b.id)}">补全心声（缺 ${missingThoughtIds.length}）</button>`
      : '';
    const thoughts = thoughtButtons || supplementButton
      ? `<span class="os-beat-thoughts">${thoughtButtons}${supplementButton}</span>`
      : '';
    return `<div class="offline-beat offline-beat--narration" data-beat-id="${esc(b.id)}">
      ${pick(b)}${paras.map((p) => `<p>${renderNarrationTextWithTranslations(p)}</p>`).join('') || `<p>${renderNarrationTextWithTranslations(cleaned)}</p>`}
      ${auReasoningHtml(b.reasoningText)}${image}${audio}${thoughts}
      ${auBeatFooterHtml(b, {
        latest: b.id === lastNarration?.id,
        continuation: b.id === lastNarration?.id && b.continuationPending === true,
        bookmark: true,
        fork: true,
        favorite: true,
        image: true,
        hasImage: !!b.image?.url,
        clearImage: !!b.image,
      })}
    </div>`;
  }).join('');
  return `${hiddenCount ? `<button type="button" class="os-history-toggle" data-history-expand>展开更早的 ${hiddenCount} 条</button>` : ''}${rows}`;
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  await primeDisplayRegex();
  const all = await listCharacters({ excludeAnonNpc: true, userId: user.id });
  const characters = (all || []).filter((c) => c && c.id);
  const worldBookOptions = (await listAllWorldBookRows().catch(() => []))
    .filter((wb) => wb.isBookRoot)
    .map((wb) => ({ id: wb.id, name: wb.name || wb.title || wb.id }));
  let presetOptions = await listOfflinePresetOptions().catch(() => []);
  let scenePresets = await listOfflineScenePresets(user.id).catch(() => []);
  let selectedPresetId = await getLastOfflineScenePresetId(user.id).catch(() => '');
  if (selectedPresetId && !scenePresets.some((preset) => preset.id === selectedPresetId)) selectedPresetId = '';
  const presets = listAuPresets();
  const customEntries = (normalizeAuConfig(user).entries || [])
    // 排除内置 preset 的镜像条目（auConfig 默认会把 8 个内置主题也塞进 entries），否则与上面的内置主题重复
    .filter((e) => e && e.name && e.content && e.kind !== 'preset' && !e.sourcePresetId)
    .map((e) => ({
      key: `cfg:${e.id}`,
      name: e.name,
      icon: '🧩',
      kind: 'custom',
      overlay: e.content,
      strongOverride: e.strongOverride === true,
    }));
  const themes = [
    ...presets.map((p) => ({ key: p.id, name: p.name, icon: p.icon, kind: 'preset', presetId: p.id })),
    ...customEntries,
    { key: '__free__', name: '现填自定义', icon: '✏️', kind: 'free' },
  ];

  let session = null;
  let optionsCollapsed = false;
  let historyExpanded = false;
  let manageMode = false;
  let selectedBeats = new Set();
  let beatEditBound = false;
  let closeBeatActionLayer = null;
  let thoughtSupplementInFlight = false;
  let unbindBeatDelete = null;
  let isAdvancing = false;
  let advanceAbortController = null;
  let directivePersistTimer = null;
  let directivePersistDirty = false;
  let directivePersistError = '';
  let directivePersistChain = Promise.resolve();
  if (params.id) {
    session = await getAuStory(String(params.id).trim(), user.id);
  }
  if (session) isAdvancing = reconcileNarrationGenerationActivity('au', session.id);
  const initialCharId = String(params.character || '').trim();
  let selectedCharIds = initialCharId && characters.some((c) => c.id === initialCharId)
    ? [initialCharId]
    : [];
  if (!selectedCharIds.length && characters.length === 1) selectedCharIds = [characters[0].id];
  let castMode = String(params.cast || '').trim() === 'multi' ? 'multi' : 'single';
  let userInStory = String(params.user || '').trim().toLowerCase() !== 'off';
  let selectedThemeKey = themes[0]?.key || '';
  const savedWordRange = await loadSavedWordRange(200, 400);
  const selectedPreset = scenePresets.find((preset) => preset.id === selectedPresetId);
  let mechanicsDraft = getAuStoryMechanics({
    mechanics: {
      wordMin: savedWordRange.wordMin,
      wordMax: savedWordRange.wordMax,
      ...(selectedPreset || {}),
    },
  });
  let stylePrefs = await loadOfflineStylePrefs(user.id).catch(() => ({}));
  // 创建表单草稿（重绘时保留）
  const draft = {
    title: '',
    plot: '',
    relationships: '',
    customName: '',
    customOverlay: '',
  };

  function resolveThemeForCreate() {
    const t = themes.find((x) => x.key === selectedThemeKey) || themes[0];
    if (!t) return { name: '自定义番外' };
    if (t.kind === 'preset') return { presetId: t.presetId };
    if (t.kind === 'custom') return { name: t.name, overlay: t.overlay, strongOverride: t.strongOverride };
    return {
      name: String(draft.customName || '').trim() || '自定义番外',
      overlay: String(draft.customOverlay || '').trim(),
    };
  }

  function syncDraftFromInputs() {
    draft.title = String(container.querySelector('.au-title')?.value || '').trim();
    draft.plot = String(container.querySelector('.au-plot')?.value || '').trim();
    draft.relationships = String(container.querySelector('.au-rel')?.value || '').trim();
    draft.customName = String(container.querySelector('.au-custom-name')?.value || '').trim();
    draft.customOverlay = String(container.querySelector('.au-custom-overlay')?.value || '').trim();
    mechanicsDraft = readAuMechanics(container, mechanicsDraft);
  }

  function readAuMechanics(root, base = {}) {
    const mechanics = readMechanicsFromInputs(root, base);
    return getAuStoryMechanics({
      mechanics: {
        ...base,
        ...mechanics,
        autoInnerVoiceRepair: root.querySelector('.au-auto-inner-repair')?.checked === true,
        guidancePrompt: root.querySelector('.au-guidance')?.value ?? base.guidancePrompt,
      },
    });
  }

  function mechanicsFields(mechanics, userPresent = userInStory) {
    return `${sceneMechanicsFieldsHtml(mechanics, 'off', {
      worldBookOptions,
      presetOptions,
      showEncounterModes: true,
      showAnonMemoryInject: false,
      showPerBeatDigest: false,
      userPresent,
    })}<label class="api-field"><span class="api-field-label">缺失心声</span><span class="api-toggle"><input type="checkbox" class="au-auto-inner-repair" ${mechanics.autoInnerVoiceRepair === true ? 'checked' : ''}><span>自动补全</span></span><small>默认关闭；开启后正文漏掉心声时会额外调用一次场景模型。</small></label>`;
  }

  function bindPresetControls(root, getBase, onApply = null) {
    bindMechanicsCommonControls(root, {
      onApplyPreset: (id) => {
        const preset = scenePresets.find((item) => item.id === id);
        if (!preset) {
          selectedPresetId = '';
          return;
        }
        selectedPresetId = preset.id;
        applyMechanicsPresetToInputs(root, preset);
        setLastOfflineScenePresetId(user.id, preset.id).catch(() => {});
        if (typeof onApply === 'function') onApply(readAuMechanics(root, getBase()));
      },
    });
    root.querySelector('.off-preset-save')?.addEventListener('click', () => {
      const id = root.querySelector('.off-preset-select')?.value;
      const current = scenePresets.find((item) => item.id === id);
      if (!current) {
        showToast('先选一个预设，或点「另存为」');
        return;
      }
      const fields = pickOfflineScenePresetFields(readAuMechanics(root, getBase()));
      saveOfflineScenePreset(user.id, { id: current.id, name: current.name, ...fields })
        .then(async (saved) => {
          scenePresets = await listOfflineScenePresets(user.id);
          selectedPresetId = saved.id;
          refreshScenePresetSelect(root, scenePresets, saved.id);
          showToast('已覆盖所选预设');
        })
        .catch((error) => showToast(`保存失败：${error?.message || error}`));
    });
    root.querySelector('.off-preset-save-as')?.addEventListener('click', () => {
      const id = root.querySelector('.off-preset-select')?.value;
      const current = scenePresets.find((item) => item.id === id);
      openTextEditorModal({
        title: '另存为新预设',
        value: current?.name || '',
        multiline: false,
        placeholder: '给这组叙事设置起个名字',
        confirmLabel: '保存',
        onSave: async (name) => {
          if (!name) {
            showToast('名字不能为空');
            return;
          }
          const fields = pickOfflineScenePresetFields(readAuMechanics(root, getBase()));
          const saved = await saveOfflineScenePreset(user.id, { name, ...fields });
          scenePresets = await listOfflineScenePresets(user.id);
          selectedPresetId = saved.id;
          refreshScenePresetSelect(root, scenePresets, saved.id);
          showToast('已保存预设');
        },
      });
    });
    root.querySelector('.off-preset-delete')?.addEventListener('click', async () => {
      const id = root.querySelector('.off-preset-select')?.value;
      if (!id) {
        showToast('先选一个预设');
        return;
      }
      await deleteOfflineScenePreset(user.id, id);
      scenePresets = await listOfflineScenePresets(user.id);
      selectedPresetId = '';
      refreshScenePresetSelect(root, scenePresets, '');
      showToast('已删除预设');
    });
  }

  container.className = 'page scrapbook-page offline-page offline-session-page au-theater-page';
  applyAuStylePrefs(container, stylePrefs);

  function characterById(id) {
    return characters.find((c) => c.id === id) || null;
  }

  function sessionActorNames(target = session) {
    const names = auStoryCharacterNames(target || {});
    return auStoryCharacterIds(target || {}).map((id) => names[id] || id);
  }

  function beatsView() {
    return { historyExpanded, manageMode, selectedBeats };
  }

  function renderBeats() {
    const beatsEl = container.querySelector('.offline-beats');
    if (!beatsEl) return;
    closeBeatActionLayer?.();
    closeBeatActionLayer = null;
    beatsEl.classList.toggle('is-managing', manageMode);
    beatsEl.innerHTML = beatsHtml(session, beatsView());
    bindNarrationTranslationToggle(beatsEl, { onFailed: () => showToast('翻译暂时不可用，请稍后再试') });
    bindRenderedHistoryControls(beatsEl);
    syncTimelineNavigator();
  }

  function timelineNavigatorHtml() {
    return `
      <nav class="os-timeline-nav" aria-label="楼层导航">
        <button type="button" class="os-timeline-nav-button is-top" data-timeline-nav="top" aria-label="一键回顶" title="一键回顶">${icon('chevronDown')}</button>
        <button type="button" class="os-timeline-nav-button is-prev" data-timeline-nav="prev" aria-label="查看上一楼" title="查看上一楼">${icon('chevronDown')}</button>
        <button type="button" class="os-timeline-nav-button is-next" data-timeline-nav="next" aria-label="查看下一楼" title="查看下一楼">${icon('chevronDown')}</button>
        <button type="button" class="os-timeline-nav-button is-bottom" data-timeline-nav="bottom" aria-label="一键置底" title="一键置底">${icon('chevronDown')}</button>
      </nav>`;
  }

  function timelineRows() {
    return [...container.querySelectorAll('.offline-beat[data-beat-id]')];
  }

  function currentTimelineIndex(rows = timelineRows()) {
    const scroller = container.querySelector('.au-session-scroll');
    if (!scroller || !rows.length) return -1;
    const viewport = scroller.getBoundingClientRect();
    const center = viewport.top + (scroller.clientHeight / 2);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    rows.forEach((row, index) => {
      const rect = row.getBoundingClientRect();
      const distance = Math.abs((rect.top + (rect.height / 2)) - center);
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });
    return bestIndex;
  }

  function revealTimelineRow(row) {
    if (!row) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  }

  function syncTimelineNavigator() {
    const nav = container.querySelector('.os-timeline-nav');
    const scroller = container.querySelector('.au-session-scroll');
    if (!nav || !scroller) return;
    const rows = timelineRows();
    const index = currentTimelineIndex(rows);
    const atTop = scroller.scrollTop <= 4;
    const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 4;
    const setDisabled = (action, disabled) => {
      const button = nav.querySelector(`[data-timeline-nav="${action}"]`);
      if (button) button.disabled = !!disabled;
    };
    setDisabled('top', atTop);
    setDisabled('prev', index <= 0);
    setDisabled('next', !rows.length || index >= rows.length - 1);
    setDisabled('bottom', atBottom);
  }

  function bindTimelineNavigator() {
    const nav = container.querySelector('.os-timeline-nav');
    const scroller = container.querySelector('.au-session-scroll');
    if (!nav || !scroller) return;
    let frame = 0;
    let idleTimer = 0;
    const wake = () => {
      nav.classList.remove('is-idle');
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        if (!nav.matches(':hover') && !nav.querySelector(':focus-visible')) nav.classList.add('is-idle');
      }, 1400);
    };
    scroller.addEventListener('scroll', () => {
      wake();
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        syncTimelineNavigator();
      });
    }, { passive: true });
    nav.addEventListener('pointerenter', wake);
    nav.addEventListener('focusin', wake);
    nav.querySelectorAll('[data-timeline-nav]').forEach((button) => {
      button.addEventListener('click', () => {
        wake();
        const action = button.getAttribute('data-timeline-nav');
        const rows = timelineRows();
        const index = currentTimelineIndex(rows);
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const behavior = reduced ? 'auto' : 'smooth';
        if (action === 'top') scroller.scrollTo({ top: 0, behavior });
        else if (action === 'bottom') scroller.scrollTo({ top: scroller.scrollHeight, behavior });
        else if (action === 'prev') revealTimelineRow(rows[Math.max(0, index - 1)]);
        else if (action === 'next') revealTimelineRow(rows[Math.min(rows.length - 1, index + 1)]);
      });
    });
    syncTimelineNavigator();
    wake();
  }

  function setManageMode(on) {
    manageMode = !!on;
    if (!manageMode) selectedBeats = new Set();
    renderBeats();
    const bar = container.querySelector('.os-manage-bar');
    if (bar) bar.hidden = !manageMode;
    syncManageBar();
  }

  function syncManageBar() {
    const count = container.querySelector('.os-manage-count');
    if (count) count.textContent = `已选 ${selectedBeats.size} 条`;
    const disabled = !selectedBeats.size;
    const del = container.querySelector('[data-manage-delete]');
    const favorite = container.querySelector('[data-manage-favorite]');
    if (del) del.disabled = disabled;
    if (favorite) favorite.disabled = disabled;
  }

  function favoriteAuBeats(rows, title = '收藏番外片段') {
    if (!rows.length) { showToast('请先选择片段'); return; }
    openTextEditorModal({
      title,
      placeholder: '备注（可不填）',
      confirmLabel: '收藏',
      onSave: async (note) => {
        await saveOfflineFavorite({
          userId: user.id,
          session,
          beats: rows,
          characterIds: auStoryCharacterIds(session),
          title: session.title || session.auName || '番外收藏',
          note,
        });
        setManageMode(false);
        showToast('已收藏到参与角色的记忆馆');
      },
    });
  }

  async function deleteManagedBeats() {
    if (!selectedBeats.size || !window.confirm(`删除所选的 ${selectedBeats.size} 条番外记录？`)) return;
    const ids = [...selectedBeats];
    for (const id of ids.reverse()) deleteAuBeat(session, id);
    selectedBeats = new Set();
    await saveAuStory(session);
    renderBeats();
    syncManageBar();
    renderOptionsFromSession();
    showToast('已删除所选记录');
  }

  function bindHistoryManagement() {
    bindRenderedHistoryControls(container.querySelector('.offline-beats'));
    container.querySelector('[data-manage-all]')?.addEventListener('click', () => {
      selectedBeats = new Set((session?.beats || []).map((beat) => beat?.id).filter(Boolean));
      renderBeats();
      syncManageBar();
    });
    container.querySelector('[data-manage-favorite]')?.addEventListener('click', () => {
      favoriteAuBeats((session?.beats || []).filter((beat) => selectedBeats.has(beat.id)), `收藏 ${selectedBeats.size} 条番外片段`);
    });
    container.querySelector('[data-manage-delete]')?.addEventListener('click', deleteManagedBeats);
    container.querySelector('[data-manage-done]')?.addEventListener('click', () => setManageMode(false));
  }

  function bindRenderedHistoryControls(root) {
    if (!root) return;
    root.querySelector('[data-history-expand]')?.addEventListener('click', () => {
      historyExpanded = true;
      renderBeats();
    });
    root.querySelectorAll('[data-beat-pick]').forEach((input) => input.addEventListener('change', () => {
      const id = input.getAttribute('data-beat-pick');
      if (input.checked) selectedBeats.add(id);
      else selectedBeats.delete(id);
      syncManageBar();
    }));
  }

  function exportAuStoryText() {
    if (!session) return;
    const actors = sessionActorNames().join('、');
    const body = (session.beats || []).map((beat) => {
      if (beat.role === 'directive') return `${auStoryIncludesUser(session) ? '方向' : '导演方向'}：${beat.text || ''}`;
      return String(beat.text || '');
    }).filter(Boolean).join('\n\n');
    const text = [`# ${session.title || session.auName || '番外'}`, actors ? `参与角色：${actors}` : '', session.auName ? `番外世界：${session.auName}` : '', '', body].filter((line, index) => line || index === 3).join('\n');
    downloadTextFile(text, `番外-${session.title || session.auName || session.id}.txt`);
    showToast('番外全文已导出');
  }

  function setDirectiveDraft(value, { persist = true } = {}) {
    if (!session) return;
    session.uiState = {
      ...(session.uiState || {}),
      directiveDraft: String(value || ''),
    };
    if (!persist) return;
    directivePersistDirty = true;
    if (directivePersistTimer) clearTimeout(directivePersistTimer);
    directivePersistTimer = setTimeout(() => {
      directivePersistTimer = null;
      void flushDirectiveDraft().catch((error) => {
        directivePersistError = String(error?.message || error || '未知错误');
        console.warn('[au-theater] directive draft save failed', error);
      });
    }, 400);
  }

  function captureDirectiveDraft() {
    if (!session) return;
    const input = container.querySelector('.offline-directive');
    if (input) setDirectiveDraft(input.value);
  }

  function flushDirectiveDraft() {
    if (directivePersistTimer) {
      clearTimeout(directivePersistTimer);
      directivePersistTimer = null;
    }
    if (!session || !directivePersistDirty) return directivePersistChain;
    const target = session;
    directivePersistDirty = false;
    directivePersistChain = directivePersistChain
      .catch(() => {})
      .then(() => saveAuStory(target))
      .then((saved) => {
        directivePersistError = '';
        return saved;
      })
      .catch((error) => {
        if (session === target) directivePersistDirty = true;
        throw error;
      });
    return directivePersistChain;
  }

  /* ---------- 列表 + 新建 ---------- */
  async function paintList() {
    const prevScroll = captureScrollerTop(container, '.au-scroll');
    const stories = await listAuStories(user.id);
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">番外剧场</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="au-scroll">
        <section class="scrapbook-card au-new">
          <div class="chat-details-section-title">开一场番外</div>
          <p class="au-isolate-note">番外是平行脑洞，不写进真实记忆；分享时会分别发到参与角色的私聊。</p>
          ${characters.length ? `
            <div class="tm-segmented" role="radiogroup" aria-label="番外参与模式">
              <button type="button" class="tm-seg ${castMode === 'single' ? 'is-active' : ''}" data-au-cast-mode="single" role="radio" aria-checked="${castMode === 'single' ? 'true' : 'false'}">单人番外</button>
              <button type="button" class="tm-seg ${castMode === 'multi' ? 'is-active' : ''}" data-au-cast-mode="multi" role="radio" aria-checked="${castMode === 'multi' ? 'true' : 'false'}">多人番外</button>
            </div>
            <div class="tm-segmented" role="radiogroup" aria-label="用户是否参与番外">
              <button type="button" class="tm-seg ${userInStory ? 'is-active' : ''}" data-au-user-mode="on" role="radio" aria-checked="${userInStory ? 'true' : 'false'}">用户参与</button>
              <button type="button" class="tm-seg ${userInStory ? '' : 'is-active'}" data-au-user-mode="off" role="radio" aria-checked="${userInStory ? 'false' : 'true'}">无用户</button>
            </div>
            <div class="chat-details-section-title" data-au-cast-label>${castMode === 'multi' ? `选择角色 · 已选 ${selectedCharIds.length} 位` : '选择角色'}</div>
            <div class="tm-chooser">
              ${characters.map((c) => `
                <button type="button" class="tm-char ${selectedCharIds.includes(c.id) ? 'is-active' : ''}" data-char="${esc(c.id)}" aria-pressed="${selectedCharIds.includes(c.id) ? 'true' : 'false'}">
                  ${characterAvatarHtml(c, { className: 'tm-char-avatar' })}
                  <span class="tm-char-name">${esc(c.customNickname || c.name || '角色')}</span>
                </button>
              `).join('')}
            </div>
            <div class="chat-details-section-title">番外主题</div>
            <div class="tm-chips au-preset-chips">
              ${themes.map((t) => `<button type="button" class="tm-chip ${t.key === selectedThemeKey ? 'is-active' : ''}" data-au="${esc(t.key)}">${esc(t.icon)} ${esc(t.name)}</button>`).join('')}
            </div>
            <div class="au-custom-theme" ${selectedThemeKey === '__free__' ? '' : 'hidden'}>
              <label class="api-field">
                <span class="api-field-label">自定义主题名</span>
                <input type="text" class="form-input au-custom-name" value="${esc(draft.customName)}" placeholder="如：废土电台、深海歌剧院" maxlength="24" />
              </label>
              <label class="api-field">
                <span class="api-field-label">自定义世界设定</span>
                <textarea class="form-input au-custom-overlay" rows="3" placeholder="描述这个番外世界的背景、规则与基调">${esc(draft.customOverlay)}</textarea>
              </label>
            </div>
            <label class="api-field">
              <span class="api-field-label">标题（可留空，收尾会自动生成）</span>
              <input type="text" class="form-input au-title" value="${esc(draft.title)}" placeholder="给这场番外起个名字" maxlength="30" />
            </label>
            <label class="api-field">
              <span class="api-field-label">大概剧情（可留空）</span>
              <textarea class="form-input au-plot" rows="2" placeholder="想发生的走向、关键事件或想看的桥段">${esc(draft.plot)}</textarea>
            </label>
            <label class="api-field">
              <span class="api-field-label">人物关系（可留空）</span>
              <textarea class="form-input au-rel" rows="2" placeholder="如：青梅竹马、宿敌、师徒、契约伙伴">${esc(draft.relationships)}</textarea>
            </label>
            <details class="au-mechanics-details">
              <summary>叙事设置与功能预设</summary>
              <div class="au-mechanics-body">
                ${scenePresetBarHtml(scenePresets, selectedPresetId)}
                ${mechanicsFields(mechanicsDraft)}
                <label class="api-field">
                  <span class="api-field-label">本场写作指导（可留空）</span>
                  <textarea class="form-input au-guidance" rows="3" placeholder="只作用于这场番外">${esc(mechanicsDraft.guidancePrompt || '')}</textarea>
                </label>
              </div>
            </details>
            <button type="button" class="btn btn-primary au-start">进入番外 ▷</button>
          ` : '<div class="tm-no-char">还没有角色，先去通讯录创建一个吧。</div>'}
        </section>

        <section class="au-list-section">
          <div class="space-section-title">我的番外</div>
          ${stories.length ? `
            <div class="au-list">
              ${stories.map((s) => `
                <div class="au-list-row" data-open="${esc(s.id)}">
                  <span class="au-list-body">
                    <strong>${esc(s.title || s.auName)}</strong>
                    <small>${esc(sessionActorNames(s).join('、'))} · ${esc(s.auName)}${auStoryIncludesUser(s) ? '' : ' · 无用户'}${s.status === 'finished' ? ' · 已收尾' : ''} · ${esc(s.summary || `${s.beats?.length || 0} 段`)}</small>
                  </span>
                  <button type="button" class="au-row-del" data-del="${esc(s.id)}" aria-label="删除">✕</button>
                </div>
              `).join('')}
            </div>
          ` : `<div class="space-empty">${emptyIllustration('moon', 'space-empty-art')}<div class="space-empty-text">还没有番外。挑个角色和设定，开一场吧。</div></div>`}
        </section>
      </main>
    `;
    restoreScrollerTop(container, '.au-scroll', prevScroll);
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    const refreshCastSelectionUi = () => {
      container.querySelectorAll('[data-au-cast-mode]').forEach((button) => {
        const active = button.getAttribute('data-au-cast-mode') === castMode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', active ? 'true' : 'false');
      });
      const label = container.querySelector('[data-au-cast-label]');
      if (label) label.textContent = castMode === 'multi'
        ? `选择角色 · 已选 ${selectedCharIds.length} 位`
        : '选择角色';
      container.querySelectorAll('[data-char]').forEach((button) => {
        const active = selectedCharIds.includes(button.getAttribute('data-char'));
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      container.querySelectorAll('[data-au-user-mode]').forEach((button) => {
        const active = (button.getAttribute('data-au-user-mode') !== 'off') === userInStory;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    };
    container.querySelectorAll('[data-au-cast-mode]').forEach((button) => button.addEventListener('click', () => {
      const nextMode = button.getAttribute('data-au-cast-mode') === 'multi' ? 'multi' : 'single';
      if (nextMode === castMode) return;
      castMode = nextMode;
      if (castMode === 'single' && selectedCharIds.length > 1) {
        selectedCharIds = selectedCharIds.slice(0, 1);
      }
      refreshCastSelectionUi();
    }));
    container.querySelectorAll('[data-au-user-mode]').forEach((button) => button.addEventListener('click', () => {
      syncDraftFromInputs();
      userInStory = button.getAttribute('data-au-user-mode') !== 'off';
      void paintList();
    }));
    container.querySelectorAll('[data-char]').forEach((b) => b.addEventListener('click', () => {
      const id = b.getAttribute('data-char');
      selectedCharIds = castMode === 'single'
        ? [id]
        : (selectedCharIds.includes(id)
          ? selectedCharIds.filter((item) => item !== id)
          : [...selectedCharIds, id]);
      refreshCastSelectionUi();
    }));
    container.querySelectorAll('[data-au]').forEach((b) => b.addEventListener('click', () => {
      syncDraftFromInputs();
      selectedThemeKey = b.getAttribute('data-au');
      container.querySelectorAll('[data-au]').forEach((x) => x.classList.toggle('is-active', x === b));
      const customPanel = container.querySelector('.au-custom-theme');
      if (customPanel) customPanel.hidden = selectedThemeKey !== '__free__';
    }));
    bindPresetControls(container, () => mechanicsDraft);
    container.querySelector('.au-start')?.addEventListener('click', onStart);
    container.querySelectorAll('[data-open]').forEach((row) => row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-del]')) return;
      session = await getAuStory(row.getAttribute('data-open'), user.id);
      if (session) paintSession();
    }));
    container.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm('删除这场番外？')) return;
      await deleteAuStory(b.getAttribute('data-del'));
      showToast('已删除');
      paintList();
    }));
  }

  async function onStart() {
    const selectedCharacters = selectedCharIds.map(characterById).filter(Boolean);
    if (!selectedCharacters.length) { showToast('至少选择一个角色'); return; }
    if (castMode === 'multi' && selectedCharacters.length < 2) {
      showToast('多人番外至少选择两个角色');
      return;
    }
    syncDraftFromInputs();
    const theme = resolveThemeForCreate();
    if (selectedThemeKey === '__free__' && !theme.overlay) {
      showToast('先写一点自定义世界设定');
      container.querySelector('.au-custom-overlay')?.focus();
      return;
    }
    await saveWordRangePrefs(mechanicsDraft);
    const btn = container.querySelector('.au-start');
    if (btn) { btn.disabled = true; btn.textContent = '准备中…'; }
    try {
      session = await createAuStory({
        userId: user.id,
        userInStory,
        characters: selectedCharacters,
        theme,
        title: draft.title,
        plot: draft.plot,
        relationships: draft.relationships,
        mechanics: mechanicsDraft,
      });
      paintSession();
      await onAdvance();
    } catch (e) {
      showToast(`失败：${e?.message || e}`);
      if (btn) { btn.disabled = false; btn.textContent = '进入番外 ▷'; }
    }
  }

  /* ---------- 沉浸态 ---------- */
  function paintSession() {
    closeBeatActionLayer?.();
    closeBeatActionLayer = null;
    const prevScroll = captureScrollerTop(container, '.au-session-scroll');
    const actorNames = sessionActorNames();
    const actorNamesText = actorNames.join('、') || session.characterName || '角色';
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back-list aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">番外 · ${esc(session.auName)}</h1>
        <div class="offline-navbar-actions">
          <button type="button" class="navbar-btn" data-open-settings aria-label="叙事设置">${icon('menu')}</button>
          <button type="button" class="navbar-btn au-share-btn" aria-label="分享给参与角色">分享</button>
        </div>
      </header>
      <main class="offline-scroll au-session-scroll">
        <section class="scrapbook-card au-banner">
          <span class="au-banner-name">${esc(actorNamesText)}</span>
          <span class="au-banner-tag">${esc(session.auName)} · 平行脑洞${auStoryIncludesUser(session) ? '' : ' · 无用户'}</span>
        </section>
        <section class="offline-beats${manageMode ? ' is-managing' : ''}">${beatsHtml(session, beatsView())}</section>
      </main>
      ${timelineNavigatorHtml()}
      <div class="os-manage-bar" ${manageMode ? '' : 'hidden'}>
        <span class="os-manage-count">已选 ${selectedBeats.size} 条</span>
        <button type="button" class="os-manage-btn" data-manage-all>全选</button>
        <button type="button" class="os-manage-btn" data-manage-favorite>收藏所选</button>
        <button type="button" class="os-manage-btn os-manage-btn--danger" data-manage-delete>删除所选</button>
        <button type="button" class="os-manage-btn" data-manage-done>完成</button>
      </div>
      <div class="offline-options" hidden></div>
      <div class="offline-tools" hidden>
        <button type="button" class="offline-tool" data-tool="options">${icon('sparkle')}<span>走向选项</span><em class="offline-tool-state">${getAuStoryMechanics(session).optionCards ? '开' : '关'}</em></button>
        <button type="button" class="offline-tool" data-tool="reroll">${icon('reroll')}<span>重 roll 上一轮</span></button>
        ${(() => {
          const last = [...(session.beats || [])].reverse().find((beat) => beat?.role === 'narration');
          const count = last ? listAuRerollVersions(session, last.id).versions.length : 0;
          return count > 1 ? `<button type="button" class="offline-tool" data-tool="versions">${icon('time')}<span>本轮版本</span><em class="offline-tool-state">${count}</em></button>` : '';
        })()}
        <button type="button" class="offline-tool" data-tool="guidance">${icon('book')}<span>写作指导</span><em class="offline-tool-state">${getAuStoryMechanics(session).guidancePrompt ? '本场' : '未启用'}</em></button>
        <button type="button" class="offline-tool" data-tool="story">${icon('edit')}<span>番外设定</span></button>
        <button type="button" class="offline-tool" data-tool="cast">${icon('plus')}<span>参与角色</span><em class="offline-tool-state">${auStoryCharacterIds(session).length}</em></button>
        <button type="button" class="offline-tool" data-tool="innerVoice">${icon('sparkle')}<span>心声方案</span><em class="offline-tool-state">${stylePrefs.innerVoiceCardSource === 'custom' ? '独立' : '随会话'}</em></button>
        <button type="button" class="offline-tool" data-tool="routes">${icon('menu')}<span>路线与节点</span><em class="offline-tool-state">${ensureOfflineBranching(session).branches.length}</em></button>
        <button type="button" class="offline-tool" data-tool="worldline">${icon('plus')}<span>转为新世界线</span>${session.promotedWorldIds?.length ? '<em class="offline-tool-state">已创建</em>' : ''}</button>
        <button type="button" class="offline-tool" data-tool="manage">${icon('select')}<span>管理历史</span></button>
        <button type="button" class="offline-tool" data-tool="export">${icon('download')}<span>导出全文</span></button>
        <button type="button" class="offline-tool" data-tool="beautify">${icon('palette')}<span>美化界面</span></button>
        <button type="button" class="offline-tool" data-tool="card">${icon('sparkle')}<span>生成小卡</span></button>
        <button type="button" class="offline-tool" data-tool="finish">${icon('check')}<span>收尾摘要</span></button>
      </div>
      <footer class="offline-bar">
        <button type="button" class="offline-plus" aria-label="工具栏">${icon('plus')}</button>
        <div class="offline-input-wrap">
          <input type="text" class="form-input offline-directive" value="${esc(session.uiState?.directiveDraft || '')}" placeholder="${auStoryIncludesUser(session) ? '给个方向（可留空，直接推进）' : '给个导演方向（可留空）'}" />
          <button type="button" class="offline-expand" aria-label="展开大输入框">${icon('expand')}</button>
        </div>
        <button type="button" id="offline-generation-action" class="btn btn-primary offline-advance ${isAdvancing ? 'offline-stop-primary' : ''}" aria-label="${isAdvancing ? '终止 AI 输出' : '推进'}">${isAdvancing ? `${icon('stop')}<span class="offline-primary-action-label">停止</span>` : icon('advance')}</button>
      </footer>
    `;
    restoreScrollerTop(container, '.au-session-scroll', prevScroll);
    container.querySelector('[data-back-list]')?.addEventListener('click', () => {
      captureDirectiveDraft();
      void flushDirectiveDraft().catch(() => {});
      session = null;
      paintList();
    });
    container.querySelector('[data-open-settings]')?.addEventListener('click', openSettingsSheet);
    container.querySelector('.au-share-btn')?.addEventListener('click', onShare);
    container.querySelector('.offline-advance')?.addEventListener('click', () => {
      if (isAdvancing) onStopAdvance();
      else onAdvance();
    });
    container.querySelector('.offline-expand')?.addEventListener('click', openExpandEditor);
    const toolsEl = container.querySelector('.offline-tools');
    container.querySelector('.offline-plus')?.addEventListener('click', () => {
      if (!toolsEl) return;
      toolsEl.hidden = !toolsEl.hidden;
      const timelineNav = container.querySelector('.os-timeline-nav');
      if (timelineNav) timelineNav.hidden = !toolsEl.hidden;
    });
    container.querySelectorAll('.offline-tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (toolsEl) toolsEl.hidden = true;
        const timelineNav = container.querySelector('.os-timeline-nav');
        if (timelineNav) timelineNav.hidden = false;
        const tool = btn.getAttribute('data-tool');
        if (tool === 'reroll') onReroll();
        else if (tool === 'versions') openRerollVersionsSheet();
        else if (tool === 'card') onShareCard();
        else if (tool === 'finish') onFinish();
        else if (tool === 'options') toggleOptionCards();
        else if (tool === 'guidance') openGuidanceEditor();
        else if (tool === 'story') openStorySetupSheet();
        else if (tool === 'cast') openCastManager();
        else if (tool === 'innerVoice') openInnerVoiceStyleSheet();
        else if (tool === 'routes') openRoutesSheet();
        else if (tool === 'worldline') onPromoteToWorldline();
        else if (tool === 'manage') setManageMode(true);
        else if (tool === 'export') exportAuStoryText();
        else if (tool === 'beautify') openStyleManager();
      });
    });
    const directiveInput = container.querySelector('.offline-directive');
    directiveInput?.addEventListener('input', (event) => {
      setDirectiveDraft(event.target?.value || '');
    });
    directiveInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onAdvance();
    });
    scrollBottom();
    renderOptionsFromSession();
    bindBeatEdits();
    bindBeatDeleteHandler();
    bindNarrationTranslationToggle(container, {
      onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
    });
    bindTimelineNavigator();
    bindHistoryManagement();
  }

  async function openStyleManager() {
    await openOfflineStyleManager({
      container,
      prefs: stylePrefs,
      defaults: OFFLINE_STYLE_DEFAULTS,
      onPreview: (draft) => applyAuStylePrefs(container, draft),
      onSave: async (draft) => {
        stylePrefs = await saveOfflineStylePrefs(user.id, draft);
        applyAuStylePrefs(container, stylePrefs);
      },
    });
  }

  async function onPromoteToWorldline() {
    if (!session || isAdvancing) return;
    if (session.promotedWorldIds?.length && !window.confirm('这场番外已经创建过新世界线。仍要再建一个独立档位吗？')) return;
    captureDirectiveDraft();
    await flushDirectiveDraft().catch(() => {});
    const baseName = String(session.title || session.auName || '番外').trim().slice(0, 70);
    const slotName = await openSlotNameModal({
      title: '新建世界线',
      value: `${baseName} · 世界线`,
      confirmText: '创建',
    });
    if (!slotName) return;
    const worldBackground = buildAuWorldBackground(session);
    if (!worldBackground) {
      showToast('这场番外还没有可转入的设定或剧情');
      return;
    }
    try {
      const created = await createUserSlotFromIdentity(user.id, slotName, { worldBackground });
      session.promotedWorldIds = [...new Set([
        ...(Array.isArray(session.promotedWorldIds) ? session.promotedWorldIds : []),
        created.worldId,
      ])];
      session.promotedAt = Date.now();
      await saveAuStory(session);
      await setCurrentUserId(created.id);
      showToast('已创建新世界线');
      navigate('user-space');
    } catch (error) {
      showToast(`创建失败：${error?.message || error}`);
    }
  }

  function closeSettingsSheet() {
    container.querySelector('.offline-settings-sheet')?.remove();
  }

  async function openSettingsSheet() {
    if (!session) return;
    closeSettingsSheet();
    const [freshStyles, freshPresets] = await Promise.all([
      listOfflinePresetOptions().catch(() => null),
      listOfflineScenePresets(user.id).catch(() => null),
    ]);
    if (Array.isArray(freshStyles)) presetOptions = freshStyles;
    if (Array.isArray(freshPresets)) scenePresets = freshPresets;
    const mechanics = getAuStoryMechanics(session);
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-settings-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-label="番外叙事设置">
        <header class="offline-settings-sheet-head">
          <h2>叙事设置</h2>
          <button type="button" class="navbar-btn" data-settings-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="offline-settings-sheet-body">
          ${scenePresetBarHtml(scenePresets, selectedPresetId)}
          ${mechanicsFields(mechanics, auStoryIncludesUser(session))}
          <label class="api-field">
            <span class="api-field-label">本场写作指导（可留空）</span>
            <textarea class="form-input au-guidance" rows="4" placeholder="例如节奏、文风、希望保留或避免的写法">${esc(mechanics.guidancePrompt || '')}</textarea>
          </label>
        </div>
        <footer class="offline-settings-sheet-foot">
          <button type="button" class="btn btn-primary" data-settings-save>保存设置</button>
        </footer>
      </div>`;
    container.appendChild(sheet);
    bindPresetControls(sheet, () => getAuStoryMechanics(session));
    sheet.querySelectorAll('[data-settings-close]').forEach((button) => {
      button.addEventListener('click', closeSettingsSheet);
    });
    sheet.querySelector('[data-settings-save]')?.addEventListener('click', async () => {
      const next = readAuMechanics(sheet, getAuStoryMechanics(session));
      await updateAuStoryMechanics(session, next);
      await saveWordRangePrefs(next);
      closeSettingsSheet();
      paintSession();
      showToast('番外叙事设置已保存');
    });
  }

  function openGuidanceEditor() {
    if (!session) return;
    const mechanics = getAuStoryMechanics(session);
    openTextEditorModal({
      title: '本场写作指导',
      value: mechanics.guidancePrompt || '',
      placeholder: '例如：放慢节奏，多写环境互动；不要快速推进关系。',
      confirmLabel: '保存',
      onSave: async (guidancePrompt) => {
        await updateAuStoryMechanics(session, { guidancePrompt });
        const state = container.querySelector('.offline-tool[data-tool="guidance"] .offline-tool-state');
        if (state) state.textContent = String(guidancePrompt || '').trim() ? '本场' : '未启用';
        showToast(String(guidancePrompt || '').trim() ? '写作指导已启用' : '写作指导已清空');
      },
    });
  }

  function openStorySetupSheet() {
    if (!session || isAdvancing) return;
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-story-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-label="编辑番外设定">
        <header class="offline-settings-sheet-head"><h2>番外设定</h2><button type="button" class="navbar-btn" data-story-close aria-label="关闭">${icon('close')}</button></header>
        <div class="offline-settings-sheet-body">
          <label class="api-field"><span class="api-field-label">标题</span><input class="form-input" data-story-title value="${esc(session.title || '')}" maxlength="30"></label>
          <label class="api-field"><span class="api-field-label">番外世界</span><input class="form-input" data-story-name value="${esc(session.auName || '')}" maxlength="30"></label>
          <label class="api-field"><span class="api-field-label">世界设定</span><textarea class="form-input" data-story-overlay rows="5">${esc(session.auOverlay || '')}</textarea></label>
          <label class="api-field"><span class="api-field-label">剧情走向</span><textarea class="form-input" data-story-plot rows="3">${esc(session.plot || '')}</textarea></label>
          <label class="api-field"><span class="api-field-label">人物关系</span><textarea class="form-input" data-story-rel rows="3">${esc(session.relationships || '')}</textarea></label>
        </div>
        <footer class="offline-settings-sheet-foot"><button type="button" class="btn btn-primary" data-story-save>保存</button></footer>
      </div>`;
    container.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelectorAll('[data-story-close]').forEach((node) => node.addEventListener('click', close));
    sheet.querySelector('[data-story-save]')?.addEventListener('click', async () => {
      session.title = String(sheet.querySelector('[data-story-title]')?.value || '').trim();
      session.auName = String(sheet.querySelector('[data-story-name]')?.value || '').trim() || '自定义番外';
      session.auOverlay = String(sheet.querySelector('[data-story-overlay]')?.value || '').trim();
      session.plot = String(sheet.querySelector('[data-story-plot]')?.value || '').trim();
      session.relationships = String(sheet.querySelector('[data-story-rel]')?.value || '').trim();
      await saveAuStory(session);
      close();
      paintSession();
      showToast('番外设定已保存');
    });
  }

  function openCastManager() {
    if (!session || isAdvancing) return;
    const picked = new Set(auStoryCharacterIds(session));
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-cast-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-label="管理番外参与角色">
        <header class="offline-settings-sheet-head"><h2>参与角色</h2><button type="button" class="navbar-btn" data-cast-close aria-label="关闭">${icon('close')}</button></header>
        <div class="offline-settings-sheet-body offline-add-participant-list">
          ${characters.map((character) => `<label class="offline-add-participant-row"><input type="checkbox" data-cast-id="${esc(character.id)}" ${picked.has(character.id) ? 'checked' : ''}><span>${esc(character.customNickname || character.name || '角色')}</span></label>`).join('')}
        </div>
        <footer class="offline-settings-sheet-foot"><button type="button" class="btn btn-primary" data-cast-save>保存</button></footer>
      </div>`;
    container.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelectorAll('[data-cast-close]').forEach((node) => node.addEventListener('click', close));
    sheet.querySelector('[data-cast-save]')?.addEventListener('click', async () => {
      const ids = [...sheet.querySelectorAll('[data-cast-id]:checked')].map((node) => node.getAttribute('data-cast-id')).filter(Boolean);
      if (!ids.length) { showToast('至少保留一位参与角色'); return; }
      session.characterIds = ids;
      session.characterNames = Object.fromEntries(ids.map((id) => {
        const character = characterById(id);
        return [id, String(character?.customNickname || character?.name || session.characterNames?.[id] || id)];
      }));
      session.characterId = ids[0];
      session.characterName = session.characterNames[ids[0]];
      await saveAuStory(session);
      close();
      paintSession();
      showToast('参与角色已更新');
    });
  }

  async function openInnerVoiceStyleSheet() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    const presets = await loadInnerVoiceCardPresets().catch(() => []);
    const currentSource = stylePrefs.innerVoiceCardSource === 'custom' ? 'custom' : 'chat';
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-au-voice-overlay>
        <div class="modal-sheet scrapbook-card text-editor-sheet" role="dialog" aria-modal="true" aria-label="番外心声方案">
          <header class="modal-header">
            <h3>心声方案</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-au-voice-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body">
            <label class="api-field">
              <span class="api-field-label">番外心声卡片</span>
              <select class="form-input" data-au-voice-select>
                <option value="chat" ${currentSource === 'chat' ? 'selected' : ''}>沿用每位角色的关联会话</option>
                ${currentSource === 'custom'
                  ? `<option value="custom" selected>${esc(stylePrefs.innerVoiceCardName || '当前独立方案')}</option>`
                  : ''}
                ${presets.map((preset) => `<option value="preset:${esc(preset.id)}">${esc(preset.name)}</option>`).join('')}
              </select>
            </label>
            <button type="button" class="btn btn-outline" data-au-voice-import>导入方案</button>
            <input type="file" accept=".json,.txt,application/json,text/plain" data-au-voice-file hidden />
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn btn-primary" data-au-voice-save>保存</button>
          </footer>
        </div>
      </div>`;
    const draft = { ...stylePrefs };
    const select = host.querySelector('[data-au-voice-select]');
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    const setCustomOption = (label) => {
      let option = select?.querySelector('option[value="custom"]');
      if (!option && select) {
        option = document.createElement('option');
        option.value = 'custom';
        select.insertBefore(option, select.options[1] || null);
      }
      if (option) option.textContent = label || '当前独立方案';
      if (select) select.value = 'custom';
    };
    select?.addEventListener('change', () => {
      const value = String(select.value || 'chat');
      if (value === 'chat') {
        draft.innerVoiceCardSource = 'chat';
        draft.innerVoiceCardName = '';
        draft.innerVoiceCard = null;
        return;
      }
      if (value === 'custom') return;
      const preset = presets.find((row) => row.id === value.replace(/^preset:/, ''));
      if (!preset) return;
      draft.innerVoiceCardSource = 'custom';
      draft.innerVoiceCardName = preset.name;
      draft.innerVoiceCard = presetToCard(preset);
      setCustomOption(preset.name);
    });
    const fileInput = host.querySelector('[data-au-voice-file]');
    host.querySelector('[data-au-voice-import]')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        draft.innerVoiceCard = parseInnerVoiceCardImportText(await file.text(), 'diary');
        draft.innerVoiceCardSource = 'custom';
        draft.innerVoiceCardName = String(file.name || '导入的心声方案')
          .replace(/\.(?:json|txt)$/i, '')
          .slice(0, 40);
        setCustomOption(draft.innerVoiceCardName);
      } catch (error) {
        showToast(`导入失败：${error?.message || error}`);
      }
    });
    host.querySelector('[data-au-voice-save]')?.addEventListener('click', async () => {
      try {
        const value = String(select?.value || 'chat');
        if (value === 'chat') {
          draft.innerVoiceCardSource = 'chat';
          draft.innerVoiceCardName = '';
          draft.innerVoiceCard = null;
        }
        stylePrefs = await saveOfflineStylePrefs(user.id, draft);
        close();
        paintSession();
        showToast(stylePrefs.innerVoiceCardSource === 'custom' ? '番外已使用独立心声方案' : '番外心声将沿用每位角色的关联会话');
      } catch (error) {
        showToast(`保存失败：${error?.message || error}`);
      }
    });
    host.querySelector('[data-au-voice-close]')?.addEventListener('click', close);
    host.querySelector('[data-au-voice-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close();
    });
  }

  function bindBeatDeleteHandler() {
    if (unbindBeatDelete) unbindBeatDelete();
    unbindBeatDelete = bindOfflineBeatDelete(container, {
      onDelete: onDeleteBeat,
    });
  }

  async function onDeleteBeat(beatId) {
    if (!session || !beatId) return;
    const beat = session.beats.find((b) => b.id === beatId);
    if (!beat) return;
    const label = beat.role === 'directive' ? '你的方向' : '这段叙事';
    if (!window.confirm(`删除这条${label}？`)) return;
    const { ok } = deleteAuBeat(session, beatId);
    if (!ok) { showToast('无法删除'); return; }
    await saveAuStory(session);
    renderBeats();
    renderOptionsFromSession();
    showToast('已删除');
  }

  async function openAuThought(beatId, characterId) {
    const beat = session?.beats?.find((row) => row?.id === beatId);
    const state = beat?.characterStates?.[characterId];
    if (!state) return;
    const character = characterById(characterId)
      || await getCharacter(characterId, { userId: user.id }).catch(() => null);
    const linkedChat = await findPrivateChat(user.id, characterId).catch(() => null);
    const patchState = async (targetBeatId, patch = {}) => {
      const target = session?.beats?.find((row) => row?.id === targetBeatId);
      if (!target?.characterStates?.[characterId]) return null;
      const previous = target.characterStates[characterId];
      const next = {
        ...previous,
        ...patch,
        inner: String(patch.inner ?? previous.inner ?? '').trim(),
        innerTranslation: String(patch.innerTranslation ?? previous.innerTranslation ?? '').trim(),
        intent: String(patch.intent ?? previous.intent ?? '').trim(),
        mood: String(patch.mood ?? previous.mood ?? '').trim(),
        status: String(patch.status ?? previous.status ?? '').trim(),
        recordedAt: Number(previous.recordedAt || target.ts || Date.now()) || Date.now(),
      };
      target.characterStates = { ...target.characterStates, [characterId]: next };
      await saveAuStory(session);
      return next;
    };
    const history = offlineCharacterStateHistory(session, characterId, beatId);
    openCharStatePopover({
      name: state.name || character?.customNickname || character?.name || 'TA',
      inner: state.inner || '',
      innerTranslation: state.innerTranslation || '',
      intent: state.intent || '',
      mood: state.mood || '',
      status: state.status || '',
      moodValue: state.moodValue,
      characterId,
      avatarUrl: character?.avatar || '',
      card: resolveOfflineInnerVoiceCard(stylePrefs, linkedChat, 'diary'),
      historyItems: history,
      historyDeletable: false,
      onSaveCurrent: (patch) => patchState(beatId, patch),
      onSaveHistory: async (entryId, patch) => {
        const entry = history.find((row) => String(row?.id || '') === String(entryId || ''));
        return entry?.beatId ? patchState(entry.beatId, patch) : null;
      },
    });
  }

  async function onSupplementAuThoughts(beatId) {
    if (!session || isAdvancing || thoughtSupplementInFlight) return;
    thoughtSupplementInFlight = true;
    const actorCharacters = (await Promise.all(auStoryCharacterIds(session).map(async (id) => (
      characterById(id) || getCharacter(id, { userId: user.id }).catch(() => null)
    )))).filter(Boolean);
    const button = [...container.querySelectorAll('[data-au-thought-supplement]')]
      .find((item) => item.getAttribute('data-au-thought-supplement') === String(beatId || ''));
    if (button) button.disabled = true;
    try {
      const result = await supplementAuCharacterStates({
        session,
        characters: actorCharacters,
        user,
        beatId,
      });
      renderBeats();
      showToast(result.addedIds.length ? `已补回 ${result.addedIds.length} 条心声` : '心声已经完整');
    } catch (error) {
      if (button) button.disabled = false;
      showToast(`补全失败：${error?.message || error}`);
    } finally {
      thoughtSupplementInFlight = false;
    }
  }

  function onViewBeatImage(beatId) {
    const beat = session?.beats?.find((row) => row?.id === beatId);
    if (!beat?.image?.url) return;
    openImageLightbox(beat.image.url, {
      save: { filename: `au-theater-${beatId}.png` },
      onEditPrompt: () => onGenerateBeatImage(beatId),
      onReroll: async () => {
        await generateAuBeatImage({ session, user, beatId });
        renderBeats();
        return session.beats.find((row) => row?.id === beatId)?.image?.url || '';
      },
    });
  }

  async function onClearBeatImage(beatId) {
    const beat = session?.beats?.find((row) => row?.id === beatId);
    if (!beat?.image) return;
    if (!window.confirm(beat.image.url ? '删除这张场景图？' : '清除这条生图失败记录？')) return;
    await clearAuBeatImage(session, beatId);
    renderBeats();
    showToast('图片记录已清除');
  }

  function onGenerateBeatImage(beatId) {
    const beat = session?.beats?.find((row) => row?.id === beatId);
    if (!beat) return;
    const currentPrompt = resolveAuBeatImagePrompt(beat);
    openTextEditorModal({
      title: currentPrompt ? '编辑场景图提示词' : '生成场景图',
      value: currentPrompt,
      placeholder: '描述想要的画面；留空会按番外设定和本轮内容重新组织',
      confirmLabel: beat.image?.url ? '重新生成' : '生成',
      onSave: async (promptOverride) => {
        const notice = beginLongTaskNotice({
          title: '番外场景图已生成',
          body: '新画面已经准备好了',
          tag: `au-image-${session.id}-${beatId}`,
          isStillViewing: () => container.isConnected,
        });
        try {
          await generateAuBeatImage({ session, user, beatId, promptOverride });
          void notice.complete();
          renderBeats();
          showToast('已生成场景图');
        } catch (error) {
          notice.cancel();
          showToast(`失败：${error?.message || error}`);
        }
      },
    });
  }

  function bindBeatEdits() {
    if (beatEditBound) return;
    beatEditBound = true;
    if (typeof container.__mmAuBeatEditHandler === 'function') {
      container.removeEventListener('click', container.__mmAuBeatEditHandler);
    }
    const beatEditHandler = (e) => {
      const menu = e.target.closest('[data-beat-menu]');
      if (menu && container.contains(menu)) {
        const footer = menu.closest('.os-beat-footer');
        const actions = footer?.querySelector('.offline-beat-actions');
        if (!actions) return;
        if (menu.getAttribute('aria-expanded') === 'true') {
          closeBeatActionLayer?.({ restoreFocus: true });
          closeBeatActionLayer = null;
          return;
        }
        closeBeatActionLayer?.();
        closeBeatActionLayer = openOfflineBeatActionLayer(menu, actions, { themeSource: container });
        return;
      }
      const supplement = e.target.closest('[data-au-thought-supplement]');
      if (supplement && container.contains(supplement)) {
        onSupplementAuThoughts(supplement.getAttribute('data-au-thought-supplement'));
        return;
      }
      const thought = e.target.closest('[data-au-thought]');
      if (thought && container.contains(thought)) {
        openAuThought(
          thought.getAttribute('data-thought-beat'),
          thought.getAttribute('data-au-thought'),
        ).catch(() => showToast('心声暂时无法打开'));
        return;
      }
      const reroll = e.target.closest('[data-beat-reroll]');
      if (reroll && container.contains(reroll)) {
        onReroll();
        return;
      }
      const audit = e.target.closest('[data-beat-audit-reroll]');
      if (audit && container.contains(audit)) {
        onSupplementalAuditReroll(audit.getAttribute('data-beat-audit-reroll'));
        return;
      }
      const expert = e.target.closest('[data-beat-expert]');
      if (expert && container.contains(expert)) {
        openExpertConsultationSheet(expert.getAttribute('data-beat-expert'));
        return;
      }
      const continuation = e.target.closest('[data-beat-continue]');
      if (continuation && container.contains(continuation)) {
        onContinueBeat(continuation.getAttribute('data-beat-continue'));
        return;
      }
      const bookmark = e.target.closest('[data-beat-bookmark]');
      if (bookmark && container.contains(bookmark)) {
        openBookmarkEditor(bookmark.getAttribute('data-beat-bookmark'));
        return;
      }
      const fork = e.target.closest('[data-beat-fork]');
      if (fork && container.contains(fork)) {
        openForkEditor(fork.getAttribute('data-beat-fork'));
        return;
      }
      const favorite = e.target.closest('[data-beat-favorite]');
      if (favorite && container.contains(favorite)) {
        const beat = session?.beats?.find((row) => row?.id === favorite.getAttribute('data-beat-favorite'));
        if (beat) favoriteAuBeats([beat], '收藏番外片段');
        return;
      }
      const revise = e.target.closest('[data-beat-revise]');
      if (revise && container.contains(revise)) {
        openGuidedRevision(revise.getAttribute('data-beat-revise'));
        return;
      }
      const imageView = e.target.closest('[data-beat-image-view]');
      if (imageView && container.contains(imageView)) {
        onViewBeatImage(imageView.getAttribute('data-beat-image-view'));
        return;
      }
      const imageClear = e.target.closest('[data-beat-image-clear]');
      if (imageClear && container.contains(imageClear)) {
        onClearBeatImage(imageClear.getAttribute('data-beat-image-clear'));
        return;
      }
      const imageButton = e.target.closest('[data-beat-image]');
      if (imageButton && container.contains(imageButton)) {
        onGenerateBeatImage(imageButton.getAttribute('data-beat-image'));
        return;
      }
      const btn = e.target.closest('[data-beat-edit]');
      if (!btn || !container.contains(btn)) return;
      const beatId = btn.getAttribute('data-beat-edit');
      const beat = session?.beats?.find((b) => b.id === beatId);
      if (!beat || (beat.role !== 'narration' && beat.role !== 'directive')) return;
      openTextEditorModal({
        title: beat.role === 'directive' ? '编辑你的方向' : '编辑本轮叙事',
        value: beat.text || '',
        placeholder: beat.role === 'directive' ? '修改后保存将覆盖这一轮你给的方向' : '修改后保存将覆盖本轮文本',
        confirmLabel: '保存',
        onSave: async (next) => {
          if (beat.role !== 'directive' && !next) { showToast('内容不能为空'); return; }
          beat.text = next;
          await saveAuStory(session);
          renderBeats();
          showToast('已保存');
        },
      });
    };
    container.__mmAuBeatEditHandler = beatEditHandler;
    container.addEventListener('click', beatEditHandler);
  }

  async function toggleOptionCards() {
    if (!session) return;
    const next = !getAuStoryMechanics(session).optionCards;
    await updateAuStoryMechanics(session, { optionCards: next });
    const state = container.querySelector('.offline-tool[data-tool="options"] .offline-tool-state');
    if (state) state.textContent = next ? '开' : '关';
    if (!next) renderOptions([]);
    else { showToast('已开启：下一轮推进会在文末附走向选项'); renderOptionsFromSession(); }
  }

  function renderOptionsFromSession() {
    if (!getAuStoryMechanics(session || {}).optionCards) { renderOptions([]); return; }
    const lastNarration = [...(session.beats || [])].reverse().find((b) => b.role === 'narration');
    renderOptions(Array.isArray(lastNarration?.options) ? lastNarration.options : []);
  }

  function openExpandEditor() {
    const input = container.querySelector('.offline-directive');
    openTextEditorModal({
      title: '本轮方向',
      value: input?.value || '',
      placeholder: '写下这一轮想发生什么（可长文本）',
      confirmLabel: '填入',
      onSave: (next) => {
        if (input) input.value = next;
        setDirectiveDraft(next);
      },
    });
  }

  function renderOptions(list, { pending = false } = {}) {
    const box = container.querySelector('.offline-options');
    if (!box) return;
    if (!Array.isArray(list) || !list.length) {
      if (pending) {
        box.hidden = false;
        box.innerHTML = `
          <div class="offline-options-head">
            <span class="offline-options-title">正在生成走向…</span>
          </div>
          <div class="offline-options-pending" aria-live="polite">
            <i></i><i></i><i></i>
          </div>`;
        return;
      }
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const letters = ['A', 'B', 'C', 'D'];
    box.hidden = false;
    box.innerHTML = `
      <div class="offline-options-head">
        <span class="offline-options-title">${pending ? '正在生成走向…' : '走向选项（可选）'}</span>
        <button type="button" class="offline-options-collapse">${optionsCollapsed ? '展开' : '收起'}</button>
      </div>
      <div class="offline-options-list" ${optionsCollapsed ? 'hidden' : ''}>
        ${list.map((opt, i) => `<button type="button" class="offline-option-chip" data-opt="${esc(opt)}" ${pending ? 'disabled' : ''}><b>${letters[i] || '·'}</b><span>${esc(applyDisplayRegex(opt, 'autheater'))}</span></button>`).join('')}
      </div>`;
    box.querySelector('.offline-options-collapse')?.addEventListener('click', () => {
      optionsCollapsed = !optionsCollapsed;
      const listEl = box.querySelector('.offline-options-list');
      const btn = box.querySelector('.offline-options-collapse');
      if (listEl) listEl.hidden = optionsCollapsed;
      if (btn) btn.textContent = optionsCollapsed ? '展开' : '收起';
    });
    box.querySelectorAll('[data-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (pending || isAdvancing) return;
        const input = container.querySelector('.offline-directive');
        if (input) input.value = btn.getAttribute('data-opt') || '';
        setDirectiveDraft(input?.value || '');
        renderOptions([]);
        onAdvance();
      });
    });
  }

  function openGuidedRevision(beatId) {
    if (!session || isAdvancing || !canReviseLastAuBeat(session, beatId)) {
      showToast('只能重修当前最后一层番外');
      return;
    }
    openTextEditorModal({
      title: '指导重修',
      value: '',
      placeholder: '写清楚这一版哪里不对、希望怎样重写',
      confirmLabel: '按要求重写',
      onSave: async (requirement) => {
        const body = String(requirement || '').trim();
        if (!body) { showToast('请写下这次想怎么改'); return; }
        await onAdvance({ revision: { beatId, requirement: body } });
      },
    });
  }

  async function onSupplementalAuditReroll(beatId) {
    if (!session || isAdvancing || !canReviseLastAuBeat(session, beatId)) {
      showToast('只能补审当前最后一层');
      return;
    }
    showToast('正在逐句补审并重写本层…');
    await onAdvance({
      revision: {
        beatId,
        requirement: '逐句补审当前旧稿：清除重复转述、空泛八股、突兀跳时、人物口吻串位与物理动作矛盾；保留既有事实和剧情落点，重写为自然完整的同一时间点版本。',
      },
    });
  }

  async function onContinueBeat(beatId) {
    if (!session || isAdvancing) return;
    const actorCharacters = auStoryCharacterIds(session).map(characterById).filter(Boolean);
    isAdvancing = true;
    const controller = new AbortController();
    advanceAbortController = controller;
    try {
      await continueAuBeat({ session, user, characters: actorCharacters, beatId, signal: controller.signal });
      renderBeats();
      scrollBottom();
      showToast('已从断点续写本层');
    } catch (error) {
      if (!controller.signal.aborted) reportAuGenerationError(error, '番外续写失败');
    } finally {
      isAdvancing = false;
      advanceAbortController = null;
      paintSession();
    }
  }

  async function openExpertConsultationSheet(beatId) {
    if (!session || isAdvancing || !canReviseLastAuBeat(session, beatId)) {
      showToast('只能会诊当前最后一层');
      return;
    }
    const [mainPresets, sceneApiPresets] = await Promise.all([
      listApiSectionPresetOptions('main').catch(() => []),
      listApiSectionPresetOptions('scene').catch(() => []),
    ]);
    const choices = [
      ...mainPresets.map((row) => ({ ...row, section: 'main', group: '聊天模型' })),
      ...sceneApiPresets.map((row) => ({ ...row, section: 'scene', group: '场景叙事' })),
    ];
    if (!choices.length) { showToast('请先在 API 管理保存一个聊天或场景叙事档位'); return; }
    const target = session.beats.find((beat) => beat?.id === beatId);
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet os-expert-consultation-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-expert-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-label="番外专家会诊">
        <header class="offline-settings-sheet-head"><h2>专家会诊</h2><button type="button" class="navbar-btn" data-expert-close aria-label="关闭">${icon('close')}</button></header>
        <div class="offline-settings-sheet-body">
          <label class="api-field"><span class="api-field-label">会诊模型档位</span><select class="form-input" data-expert-preset>${choices.map((row) => `<option value="${esc(`${row.section}:${row.id}`)}">${esc(row.group)} · ${esc(row.name)}${row.model ? ` · ${esc(row.model)}` : ''}</option>`).join('')}</select></label>
          <label class="api-field"><span class="api-field-label">希望保留</span><textarea class="form-input" rows="3" data-expert-preserve placeholder="例如剧情落点、情感浓度和生活细节"></textarea></label>
          <label class="api-field"><span class="api-field-label">希望改善</span><textarea class="form-input" rows="3" data-expert-improve placeholder="例如动作连贯、口吻克制和节奏"></textarea></label>
          <div role="status" data-expert-status></div>
        </div>
        <footer class="offline-settings-sheet-foot"><button type="button" class="btn btn-primary" data-expert-run>生成替代版本</button></footer>
      </div>`;
    container.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelectorAll('[data-expert-close]').forEach((node) => node.addEventListener('click', close));
    sheet.querySelector('[data-expert-run]')?.addEventListener('click', async (event) => {
      const preserve = String(sheet.querySelector('[data-expert-preserve]')?.value || '').trim();
      const improve = String(sheet.querySelector('[data-expert-improve]')?.value || '').trim();
      if (!preserve || !improve) { showToast('请写清希望保留和改善的部分'); return; }
      const selected = String(sheet.querySelector('[data-expert-preset]')?.value || '');
      const split = selected.indexOf(':');
      const status = sheet.querySelector('[data-expert-status]');
      event.currentTarget.disabled = true;
      if (status) status.textContent = '专家正在阅读番外设定与原稿…';
      try {
        const actorProfiles = auStoryCharacterIds(session).map((id) => {
          const character = characterById(id);
          return `【${session.characterNames?.[id] || character?.name || id}】\n${buildAuCharacterProfileText(character, { includeUser: auStoryIncludesUser(session) })}`;
        }).join('\n\n');
        const referenceContext = [session.auOverlay, session.plot, session.relationships, actorProfiles].filter(Boolean).join('\n\n');
        const configOverride = await resolveApiSectionPresetConfig(selected.slice(0, split), selected.slice(split + 1));
        const result = await runNarrativeExpertConsultation({
          sampleText: target.text,
          referenceContext,
          preserveFlavor: preserve,
          introduceFlavor: improve,
          configOverride,
          onProgress: () => { if (status) status.textContent = '专家正在重写正文…'; },
        });
        const rewritten = sanitizeNarrationOutput(result.rewrite || '').trim();
        const applied = applyAuExternalRevision(session, beatId, rewritten, `专家会诊；保留：${preserve}；改善：${improve}`);
        if (!applied.ok) throw new Error('当前末层已经变化，未覆盖原稿');
        await saveAuStory(session);
        close();
        paintSession();
        showToast('已采用专家版本');
      } catch (error) {
        if (status) status.textContent = `会诊失败：${error?.message || error}`;
        event.currentTarget.disabled = false;
      }
    });
  }

  function openBookmarkEditor(beatId) {
    const beat = session?.beats?.find((row) => row?.id === beatId && row.role === 'narration');
    if (!beat) return;
    const existing = (session.bookmarks || []).find((row) => row.beatId === beatId);
    const floor = session.beats.slice(0, session.beats.indexOf(beat) + 1)
      .filter((row) => row?.role === 'narration').length;
    openTextEditorModal({
      title: existing ? '重命名节点' : '存为节点',
      value: existing?.name || `第 ${floor} 楼`,
      multiline: false,
      placeholder: '节点名称',
      confirmLabel: '保存',
      onSave: async (name) => {
        if (!String(name || '').trim()) { showToast('名字不能为空'); return; }
        const saved = addOfflineBookmark(session, beatId, name);
        if (!saved.ok) { showToast('找不到这个楼层'); return; }
        await saveAuStory(session);
        showToast(existing ? '节点已重命名' : '已存为节点');
      },
    });
  }

  function openForkEditor(beatId) {
    if (!session || isAdvancing) return;
    const eligibility = getOfflineForkEligibility(session, beatId);
    if (!eligibility.ok) { showToast(eligibility.message || '这里不能另开路线'); return; }
    const branching = ensureOfflineBranching(session);
    openTextEditorModal({
      title: '从这里另开路线',
      value: `路线 ${branching.branches.length + 1}`,
      multiline: false,
      placeholder: '路线名称',
      confirmLabel: '另开路线',
      onSave: async (name) => {
        const result = await forkOfflineBranch(session, beatId, name);
        if (!result.ok) { showToast(result.message || '另开路线失败'); return; }
        await saveAuStory(session);
        paintSession();
        showToast(`已切换到「${result.branch.name}」`);
      },
    });
  }

  function revealBeat(beatId) {
    window.requestAnimationFrame(() => {
      const row = [...container.querySelectorAll('.offline-beat[data-beat-id]')]
        .find((node) => node.getAttribute('data-beat-id') === String(beatId || ''));
      revealTimelineRow(row);
    });
  }

  function openRoutesSheet() {
    if (!session || isAdvancing) return;
    const branching = ensureOfflineBranching(session);
    const activeId = branching.activeBranchId;
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet os-routes-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-routes-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-label="番外路线与节点">
        <header class="offline-settings-sheet-head"><h2>路线与节点</h2><button type="button" class="navbar-btn" data-routes-close aria-label="关闭">${icon('close')}</button></header>
        <div class="offline-settings-sheet-body">
          <section class="os-route-group"><h3>路线</h3><div class="os-route-list">
            ${branching.branches.map((branch) => `<article class="os-route-row${branch.id === activeId ? ' is-active' : ''}"><button type="button" class="os-route-main" data-route-switch="${esc(branch.id)}" ${branch.id === activeId ? 'disabled' : ''}><strong>${esc(branch.name)}</strong><small>${branch.isMain ? '主干' : '分支'}${branch.id === activeId ? ' · 当前' : ''}</small></button><button type="button" class="os-route-icon-btn" data-route-rename="${esc(branch.id)}">改名</button>${branch.id !== activeId ? `<button type="button" class="os-route-icon-btn is-danger" data-route-delete="${esc(branch.id)}">删除</button>` : ''}</article>`).join('')}
          </div></section>
          <section class="os-route-group"><h3>节点</h3><div class="os-bookmark-list">
            ${(session.bookmarks || []).map((bookmark) => `<article class="os-bookmark-row"><button type="button" data-bookmark-jump="${esc(bookmark.beatId)}"><strong>${esc(bookmark.name)}</strong><small>第 ${Number(bookmark.floor || 0)} 楼</small></button><button type="button" class="os-route-icon-btn" data-bookmark-rename="${esc(bookmark.beatId)}">改名</button><button type="button" class="os-route-icon-btn is-danger" data-bookmark-delete="${esc(bookmark.id)}">删除</button></article>`).join('') || '<div class="os-route-empty">可在任意叙事楼层存为节点</div>'}
          </div></section>
        </div>
      </div>`;
    container.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelectorAll('[data-routes-close]').forEach((node) => node.addEventListener('click', close));
    sheet.querySelectorAll('[data-route-switch]').forEach((button) => button.addEventListener('click', async () => {
      const result = await switchOfflineBranch(session, button.getAttribute('data-route-switch'));
      if (!result.ok) { showToast(result.message || '路线切换失败'); return; }
      await saveAuStory(session);
      close();
      paintSession();
      showToast(`已切换到「${result.branch?.name || '路线'}」`);
    }));
    sheet.querySelectorAll('[data-route-rename]').forEach((button) => button.addEventListener('click', () => {
      const id = button.getAttribute('data-route-rename');
      const row = branching.branches.find((branch) => branch.id === id);
      openTextEditorModal({ title: '路线改名', value: row?.name || '', multiline: false, confirmLabel: '保存', onSave: async (name) => {
        await renameOfflineBranch(session, id, name);
        await saveAuStory(session);
        close();
        openRoutesSheet();
      } });
    }));
    sheet.querySelectorAll('[data-route-delete]').forEach((button) => button.addEventListener('click', async () => {
      if (!window.confirm('删除这条未采用路线？')) return;
      const result = await deleteOfflineBranch(session, button.getAttribute('data-route-delete'));
      if (!result.ok) { showToast('当前路线不能删除'); return; }
      await saveAuStory(session);
      close();
      openRoutesSheet();
    }));
    sheet.querySelectorAll('[data-bookmark-jump]').forEach((button) => button.addEventListener('click', () => {
      const id = button.getAttribute('data-bookmark-jump');
      close();
      revealBeat(id);
    }));
    sheet.querySelectorAll('[data-bookmark-rename]').forEach((button) => button.addEventListener('click', () => {
      close();
      openBookmarkEditor(button.getAttribute('data-bookmark-rename'));
    }));
    sheet.querySelectorAll('[data-bookmark-delete]').forEach((button) => button.addEventListener('click', async () => {
      deleteOfflineBookmark(session, button.getAttribute('data-bookmark-delete'));
      await saveAuStory(session);
      close();
      openRoutesSheet();
    }));
  }

  function openRerollVersionsSheet() {
    if (!session || isAdvancing) return;
    const lastBeat = [...(session.beats || [])].reverse().find((beat) => beat?.role === 'narration');
    if (!lastBeat) return;
    const set = listAuRerollVersions(session, lastBeat.id);
    const revisions = (session.revisions || []).filter((row) => row?.beatId === lastBeat.id && row?.originalBeat);
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet os-reroll-versions-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-versions-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-label="选择本轮版本">
        <header class="offline-settings-sheet-head"><h2>本轮版本</h2><button type="button" class="navbar-btn" data-versions-close aria-label="关闭">${icon('close')}</button></header>
        <div class="offline-settings-sheet-body os-reroll-version-list">
          ${set.versions.map((version, index) => {
            const active = version.id === set.activeVersionId;
            const text = String(version.beat?.text || '').trim();
            return `<article class="os-reroll-version${active ? ' is-active' : ''}"><header><strong>${esc(version.label || `版本 ${index + 1}`)}</strong>${active ? '<span>当前采用</span>' : ''}</header><p>${esc(text.slice(0, 220))}${text.length > 220 ? '…' : ''}</p><button type="button" class="btn btn-outline btn-sm" data-select-au-version="${esc(version.id)}" ${active ? 'disabled' : ''}>${active ? '已采用' : '采用此版'}</button></article>`;
          }).join('') || '<div class="os-route-empty">重 roll 成功后会在这里保留版本</div>'}
          ${revisions.length ? `<button type="button" class="btn btn-outline btn-block" data-restore-au-revision="${esc(revisions[revisions.length - 1].id)}">恢复最近一次重修前的版本</button>` : ''}
        </div>
      </div>`;
    container.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelectorAll('[data-versions-close]').forEach((node) => node.addEventListener('click', close));
    sheet.querySelectorAll('[data-select-au-version]').forEach((button) => button.addEventListener('click', async () => {
      const selected = selectAuRerollVersion(session, lastBeat.id, button.getAttribute('data-select-au-version'));
      if (!selected.ok) { showToast('这个版本已不能切换'); return; }
      await saveAuStory(session);
      close();
      paintSession();
      showToast('已切换本轮版本');
    }));
    sheet.querySelector('[data-restore-au-revision]')?.addEventListener('click', async (event) => {
      const restored = restoreAuRevision(session, event.currentTarget.getAttribute('data-restore-au-revision'));
      if (!restored.ok) { showToast('这个修订版本已不能恢复'); return; }
      await saveAuStory(session);
      close();
      paintSession();
      showToast('已恢复重修前的版本');
    });
  }

  async function onReroll() {
    if (!session || isAdvancing) return;
    const lastBeat = (session.beats || [])[session.beats.length - 1];
    if (!lastBeat || lastBeat.role !== 'narration') {
      showToast('还没有可重 roll 的轮次');
      return;
    }
    showToast('正在重写本轮，上一版会保留…');
    await onAdvance({
      revision: {
        beatId: lastBeat.id,
        requirement: '重新生成当前这一层，保持此前已经发生的上文不变；不要沿用上一版的措辞、动作编排和段落结构。',
      },
    });
  }

  function scrollBottom() {
    const s = container.querySelector('.offline-scroll');
    if (s) s.scrollTop = s.scrollHeight;
  }

  function renderStreamInto(el, fullText) {
    const cleaned = applyDisplayRegex(sanitizeNarrationOutput(fullText), 'autheater');
    const paras = splitNarrationParagraphs(cleaned);
    el.innerHTML = paras.map((p) => `<p>${renderNarrationTextWithTranslations(p)}</p>`).join('')
      || (cleaned ? `<p>${renderNarrationTextWithTranslations(cleaned)}</p>` : '<p>正在写下这段番外…</p>');
  }

  async function onStopAdvance() {
    if (!isAdvancing || !session) return;
    const advBtn = container.querySelector('.offline-advance');
    if (advBtn) {
      advBtn.disabled = true;
      const label = advBtn.querySelector('.offline-primary-action-label');
      if (label) label.textContent = '正在停止…';
    }
    const requested = requestNarrationGenerationAbort('au', session.id, 'user-stop');
    if (!requested && advanceAbortController && !advanceAbortController.signal.aborted) {
      advanceAbortController.abort('user-stop');
    } else if (!requested && !advanceAbortController) {
      window.setTimeout(async () => {
        if (!session || !canForceReleaseNarrationGenerationLease('au', session.id)) return;
        const released = await forceReleaseNarrationGenerationLease('au', session.id, 'user-stop-timeout');
        if (!released) return;
        isAdvancing = false;
        paintSession();
        showToast('已解除残留的生成状态，可以继续推进');
      }, 4200);
    }
  }

  async function onAdvance({ revision = null } = {}) {
    if (!session || isAdvancing) return;
    if (String(session.userId || '') !== String(user.id || '')) {
      showToast('这场番外不属于当前档位，已阻止继续写入');
      return;
    }
    if (session.status === 'finished') {
      if (!window.confirm('这场番外已经收尾。继续推进会重新打开它，确定继续？')) return;
      session.status = 'active';
      delete session.finishedAt;
      await saveAuStory(session);
    }
    const actorIds = auStoryCharacterIds(session);
    const actorCharacters = (await Promise.all(actorIds.map(async (id) => (
      characterById(id) || getCharacter(id, { userId: user.id }).catch(() => null)
    )))).filter(Boolean);
    const input = container.querySelector('.offline-directive');
    const advBtn = container.querySelector('.offline-advance');
    const finishBtn = container.querySelector('.offline-tool[data-tool="finish"]');
    const shareBtn = container.querySelector('.au-share-btn');
    const revisionBeatIndex = revision
      ? session.beats.findIndex((beat) => beat?.id === revision.beatId && beat?.role === 'narration')
      : -1;
    const revisionDirective = revisionBeatIndex > 0 && session.beats[revisionBeatIndex - 1]?.role === 'directive'
      ? String(session.beats[revisionBeatIndex - 1].text || '').trim()
      : '';
    const directive = revision ? revisionDirective : String(input?.value || '').trim();
    const narrationCount = session.beats.filter((b) => b.role === 'narration').length;
    if (!revision && narrationCount > 0 && !directive) {
      if (!window.confirm('还没写本轮方向。\n\n确定从已有剧情末尾衔接续写？（不会回到开场）')) return;
    }
    if (!revision) {
      setDirectiveDraft(input?.value || '');
      try {
        await flushDirectiveDraft();
        directivePersistError = '';
      } catch (error) {
        directivePersistError = String(error?.message || error || '未知错误');
        showToast('本轮方向暂未保存，请稍后重试');
        return;
      }
    }
    isAdvancing = true;
    advanceAbortController = new AbortController();
    const runAbortController = advanceAbortController;
    const unregisterAdvanceAbort = registerNarrationGenerationAbortController(
      'au',
      session.id,
      runAbortController,
    );
    if (advBtn) {
      advBtn.disabled = false;
      advBtn.classList.add('is-loading', 'offline-stop-primary');
      advBtn.setAttribute('aria-label', '终止 AI 输出');
      advBtn.innerHTML = `${icon('stop')}<span class="offline-primary-action-label">停止</span>`;
    }
    if (finishBtn) finishBtn.disabled = true;
    if (shareBtn) shareBtn.disabled = true;
    if (input) input.disabled = true;
    renderOptions([]);
    const cut = showCutscene('connect', '正在推进这场番外…');
    let cutClosed = false;
    const closeCut = (duration) => {
      if (cutClosed) return;
      cutClosed = true;
      void cut.close(duration);
    };
    let streamEl = null;
    let directiveEl = null;
    let joinedExistingGeneration = false;
    const ensureStreamEl = () => {
      if (streamEl) return streamEl;
      const beatsEl = container.querySelector('.offline-beats');
      if (!beatsEl) return null;
      beatsEl.querySelector('.offline-empty')?.remove();
      if (directive && !revision) {
        directiveEl = document.createElement('div');
        directiveEl.className = 'offline-beat offline-beat--directive';
        directiveEl.innerHTML = `<span>${auStoryIncludesUser(session) ? '你的方向' : '导演方向'}</span><p>${esc(directive)}</p>`;
        beatsEl.appendChild(directiveEl);
      }
      streamEl = document.createElement('div');
      streamEl.className = 'offline-beat offline-beat--narration is-streaming';
      streamEl.innerHTML = '<p>正在写下这段番外…</p>';
      beatsEl.appendChild(streamEl);
      return streamEl;
    };
    ensureStreamEl();
    scrollBottom();
    const cutTimer = setTimeout(() => closeCut(), 650);
    const onChunk = (fullText, meta = {}) => {
      closeCut();
      const el = ensureStreamEl();
      if (!el) return;
      renderStreamInto(el, fullText);
      if (meta.optionsStarted) {
        renderOptions(Array.isArray(meta.options) ? meta.options : [], { pending: true });
      }
      scrollBottom();
    };
    const onBeatReady = (beat, meta = {}) => {
      if (!beat?.text) return;
      if (meta.phase === 'text' || meta.phase === 'content' || meta.phase === 'complete') {
        const el = ensureStreamEl();
        if (el) {
          renderStreamInto(el, beat.text);
          el.classList.remove('is-streaming');
        }
        renderOptions(Array.isArray(beat.options) ? beat.options : []);
      }
      if (meta.phase === 'content' && input && !revision) {
        input.value = '';
        input.disabled = false;
        setDirectiveDraft('', { persist: false });
      }
      scrollBottom();
    };
    const onReasoning = (reasoningText) => {
      const el = ensureStreamEl();
      if (!el || !reasoningText) return;
      const existing = el.querySelector('.offline-reasoning');
      if (existing) existing.remove();
      el.insertAdjacentHTML('afterbegin', auReasoningHtml(reasoningText));
    };
    try {
      await runAuBeat({
        session,
        characters: actorCharacters,
        character: actorCharacters[0] || null,
        user,
        directive,
        revision,
        onChunk,
        onBeatReady,
        onReasoning,
        signal: runAbortController.signal,
      });
      closeCut();
      if (input && !revision) input.value = '';
      renderBeats();
      scrollBottom();
      renderOptionsFromSession();
    } catch (e) {
      if (!cutClosed) {
        cutClosed = true;
        await cut.close(0);
      }
      streamEl?.remove();
      directiveEl?.remove();
      if (e?.reason === 'generation-in-flight') {
        joinedExistingGeneration = true;
        showToast('当前一幕仍在生成，已阻止重复调用');
      } else if (runAbortController.signal.aborted) {
        const latest = await getAuStory(session.id, user.id).catch(() => null);
        if (latest) session = latest;
        renderBeats();
        renderOptionsFromSession();
        showToast('已停止输出，已经完成的正文会保留');
      } else {
        reportAuGenerationError(e);
      }
    } finally {
      clearTimeout(cutTimer);
      unregisterAdvanceAbort();
      isAdvancing = joinedExistingGeneration
        && isNarrationGenerationActive('au', session?.id);
      if (advanceAbortController === runAbortController) advanceAbortController = null;
      if (advBtn) {
        advBtn.disabled = false;
        advBtn.classList.remove('is-loading');
        advBtn.classList.toggle('offline-stop-primary', isAdvancing);
        advBtn.setAttribute('aria-label', isAdvancing ? '终止 AI 输出' : '推进');
        advBtn.innerHTML = isAdvancing
          ? `${icon('stop')}<span class="offline-primary-action-label">停止</span>`
          : icon('advance');
      }
      if (finishBtn) finishBtn.disabled = isAdvancing;
      if (shareBtn) shareBtn.disabled = isAdvancing;
      // 不自动 focus，避免手机端推进后弹软键盘
      if (input) input.disabled = isAdvancing;
    }
  }

  async function onFinish() {
    if (!session) return;
    if (isAdvancing || isNarrationGenerationActive('au', session.id)) {
      showToast('当前一幕仍在生成，请完成后再收尾');
      return;
    }
    const btn = container.querySelector('.au-finish');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    try {
      const { title } = await summarizeAuStory({ session, finish: true });
      showToast(`已收尾：${title}`);
    } catch (e) {
      showToast(`失败：${e?.message || e}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '收尾摘要'; }
    }
  }

  async function onShare() {
    if (!session) return;
    if (isAdvancing || isNarrationGenerationActive('au', session.id)) {
      showToast('当前一幕仍在生成，请完成后再分享');
      return;
    }
    if (!session.summary) {
      try { await summarizeAuStory({ session }); } catch (_) { /* still allow share with raw */ }
    }
    const actorNames = sessionActorNames();
    if (!window.confirm(`把这段番外作为脑洞分别分享给 ${actorNames.join('、')}？`)) return;
    try {
      const chats = await shareAuStoryToCharacters({ session, user });
      if (chats.length === 1) {
        showToast('已分享到私聊');
        navigate('chat/thread', { chatId: chats[0].id });
      } else {
        showToast(`已分别分享到 ${chats.length} 个私聊`);
      }
    } catch (e) {
      showToast(`失败：${e?.message || e}`);
    }
  }

  function onShareCard() {
    if (!session) return;
    if (isAdvancing || isNarrationGenerationActive('au', session.id)) {
      showToast('当前一幕仍在生成，请完成后再生成小卡');
      return;
    }
    const actorNamesText = sessionActorNames().join('、');
    const narration = (session.beats || [])
      .filter((b) => b.role !== 'directive')
      .map((b) => String(b.text || '').trim())
      .filter(Boolean)
      .join('\n\n');
    openShareCardModal({
      title: session.title || session.auName || '番外剧场',
      subtitle: [actorNamesText, session.auName, '平行脑洞'].filter(Boolean).join(' · '),
      fullText: narration || session.summary || '这场番外还在继续。',
      imageHint: actorNamesText || '番外',
      footer: '番外剧场 · 棉花糖机',
      filenameBase: `au-theater-${session.title || session.id || Date.now()}`,
    });
  }

  const onNarrationGenerationState = async (event) => {
    const currentKey = narrationGenerationLeaseKey('au', session?.id);
    if (!currentKey || event?.detail?.key !== currentKey || event?.detail?.active !== false) return;
    if (!container.isConnected) {
      window.removeEventListener('marshmallow-narration-generation-state', onNarrationGenerationState);
      return;
    }
    captureDirectiveDraft();
    await flushDirectiveDraft().catch(() => {});
    const latest = await getAuStory(session.id, user.id).catch(() => null);
    if (!latest) return;
    session = latest;
    isAdvancing = false;
    paintSession();
  };
  window.addEventListener('marshmallow-narration-generation-state', onNarrationGenerationState);

  const persistDirectiveOnBackground = () => {
    if (!container.isConnected || !session) return;
    captureDirectiveDraft();
    void flushDirectiveDraft().catch((error) => {
      directivePersistError = String(error?.message || error || '未知错误');
      console.warn('[au-theater] background draft save failed', error);
    });
  };
  const onVisibilityChange = () => {
    if (!container.isConnected) return;
    if (document.visibilityState === 'hidden') {
      persistDirectiveOnBackground();
    } else if (directivePersistError) {
      directivePersistError = '';
      showToast('本轮方向暂未保存，请保持页面打开后再试');
    }
  };
  const onPageHide = () => persistDirectiveOnBackground();
  const onRouteDisposed = (event) => {
    if (event?.detail?.container !== container) return;
    captureDirectiveDraft();
    void flushDirectiveDraft().catch(() => {});
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('marshmallow-narration-generation-state', onNarrationGenerationState);
    window.removeEventListener('marshmallow-route-disposed', onRouteDisposed);
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('marshmallow-route-disposed', onRouteDisposed);

  if (session) paintSession();
  else paintList();
}
