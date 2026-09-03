/**
 * 线下沉浸「叙事机制设置」共享字段：视角/人称/字数/轮数/走向选项/生图/语音/上下文深度/
 * 自动总结/世界书文风绑定/匿名马甲记忆。
 *
 * 这组字段和「去哪儿/一起做什么/开场白」这类内容型字段不同——内容每次现场填，
 * 机制设置才适合做成命名预设反复套用（含生图画风 / 每轮自动出图 / 风格备注等）。
 * 进页时会自动套用用户上一次使用的命名预设。
 */
import {
  OFFLINE_SCENE_STYLES,
  DEFAULT_OFFLINE_SCENE_STYLE_ID,
  normalizeOfflineSceneImageGenMode,
} from '../core/offline-scene-image-config.js';
import { REGULAR_ANONYMOUS_MEMORY_INJECT_MODES } from '../data/anonymous-room-presets.js';
import { normalizeWorldBookIds } from '../core/world-book-store.js';
import {
  normalizePersonForPerspective,
  PERSON_LABELS,
  PERSPECTIVE_LABELS,
} from '../core/narration-perspective.js';
import {
  OFFLINE_EXPERIENCE_AUDIO,
  isOfflineAudioExperience,
  offlineExperienceModeOf,
} from '../core/offline-experience-mode.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function percentValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : fallback;
}

export function normalizeAnonMemoryInject(value = '') {
  const raw = String(value || '').trim();
  return REGULAR_ANONYMOUS_MEMORY_INJECT_MODES.some((m) => m.id === raw) ? raw : 'off';
}

export function anonMemoryInjectFieldHtml(value = 'off') {
  const mode = normalizeAnonMemoryInject(value);
  return `
    <label class="api-field">
      <span class="api-field-label">匿名马甲记忆</span>
      <select class="form-input off-anon-memory-inject">
        ${REGULAR_ANONYMOUS_MEMORY_INJECT_MODES.map((m) => `<option value="${esc(m.id)}" ${mode === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
      </select>
    </label>`;
}

export function imageStyleOptionsHtml(selected) {
  return Object.entries(OFFLINE_SCENE_STYLES)
    .map(([id, s]) => `<option value="${esc(id)}" ${id === (selected || DEFAULT_OFFLINE_SCENE_STYLE_ID) ? 'selected' : ''}>${esc(s.label)}</option>`)
    .join('');
}

export function segBtns(options, active) {
  return options.map(([val, label]) =>
    `<button type="button" class="off-seg-btn ${val === active ? 'is-active' : ''}" data-val="${val}">${esc(label)}</button>`,
  ).join('');
}

/** 世界书多选：兼容旧数据里单个 worldBookId 字符串。 */
export { normalizeWorldBookIds };

/** 文风预设多选：兼容旧数据里单个 presetStyleId 字符串。 */
export function normalizePresetStyleIds(source = {}) {
  const raw = Array.isArray(source?.presetStyleIds)
    ? source.presetStyleIds
    : (source?.presetStyleId ? [source.presetStyleId] : []);
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

export function segVal(root, name, def) {
  const hit = root.querySelector(`.off-seg[data-seg="${name}"] .off-seg-btn.is-active`);
  return hit ? hit.getAttribute('data-val') : def;
}

export function setSegActive(root, name, val) {
  const group = root.querySelector(`.off-seg[data-seg="${name}"]`);
  if (!group) return;
  group.querySelectorAll('.off-seg-btn').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-val') === val));
}

export function bindSegs(root) {
  root.querySelectorAll('.off-seg').forEach((group) => {
    group.querySelectorAll('.off-seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.off-seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
        syncPerspectivePersonControls(root);
      });
    });
  });
  syncPerspectivePersonControls(root);
}

function syncPerspectivePersonControls(root) {
  const perspective = segVal(root, 'perspective', 'user');
  const person = segVal(root, 'person', 'second');
  const firstPersonBtn = root.querySelector('.off-seg[data-seg="person"] .off-seg-btn[data-val="first"]');
  if (perspective === 'character' && person === 'first') {
    setSegActive(root, 'person', 'second');
  }
  if (firstPersonBtn) {
    firstPersonBtn.disabled = perspective === 'character';
    firstPersonBtn.title = perspective === 'character'
      ? '角色第一视角中，角色说「我」、用户称为「你」'
      : '';
  }
}

/** 机制字段：默认折叠展示，不管哪个页面调用都保持同一套取值范围与文案。 */
export function sceneMechanicsFieldsHtml(scene = {}, anonMemoryInject = 'off', extras = {}) {
  const {
    worldBookOptions = [],
    presetOptions = [],
    showEncounterModes = false,
    showAnonMemoryInject = true,
    showPerBeatDigest = true,
    userPresent = true,
  } = extras;
  const audioExperience = isOfflineAudioExperience(scene);
  const perspective = scene.perspective || 'user';
  const person = normalizePersonForPerspective(perspective, scene.person || 'second');
  return `
    <label class="api-field">
      <span class="api-field-label">语气 / 氛围</span>
      <input type="text" class="form-input off-scene-tone" value="${esc(scene.tone || '日常推进')}" placeholder="如：日常、暧昧、治愈" maxlength="40" />
    </label>
    ${audioExperience || !userPresent ? '' : `<div class="api-field">
      <span class="api-field-label">视角</span>
      <div class="off-seg" data-seg="perspective">
        ${segBtns(PERSPECTIVE_LABELS, perspective)}
      </div>
    </div>
    <div class="api-field">
      <span class="api-field-label">用户在正文中的称呼</span>
      <div class="off-seg" data-seg="person">
        ${segBtns(PERSON_LABELS, person)}
      </div>
    </div>`}
    <div class="off-num-row">
      <label class="api-field off-num">
        <span class="api-field-label">单轮字数下限</span>
        <input type="number" class="form-input off-scene-wmin" value="${scene.wordMin || 200}" min="30" step="50" />
      </label>
      <label class="api-field off-num">
        <span class="api-field-label">上限</span>
        <input type="number" class="form-input off-scene-wmax" value="${scene.wordMax || 500}" min="60" step="50" />
      </label>
      <label class="api-field off-num">
        <span class="api-field-label">参考轮数</span>
        <input type="number" class="form-input off-scene-rounds" value="${scene.rounds || 6}" min="1" max="500" />
      </label>
    </div>
    ${!audioExperience && showEncounterModes && userPresent ? `
    <div class="off-settings-divider">相遇 · 输入模式（可组合）</div>
    <div class="off-encounter-modes">
      <label class="off-mode-toggle">
        <input type="checkbox" class="off-scene-dialogue-mode" ${scene.dialogueMode ? 'checked' : ''} />
        <span><strong>对话模式</strong><small>你的输入默认是已经说出口的话，TA 直接承接</small></span>
      </label>
      <label class="off-mode-toggle">
        <input type="checkbox" class="off-scene-no-paraphrase" ${scene.noParaphrase !== false ? 'checked' : ''} />
        <span><strong>防转述</strong><small>不复述你的发言，从角色下一拍反应开始</small></span>
      </label>
      <label class="off-mode-toggle">
        <input type="checkbox" class="off-scene-director-mode" ${scene.directorMode ? 'checked' : ''} />
        <span><strong>导演模式</strong><small>把简短输入当场景指导；是否扮演你由防抢话决定</small></span>
      </label>
    </div>` : ''}
    ${audioExperience ? `
    <div class="off-settings-divider">音声画面</div>
    <div class="api-field">
      <span class="api-field-label">画面布局</span>
      <div class="off-seg" data-seg="audioSceneLayout">
        ${segBtns([['portrait', '竖屏'], ['landscape', '横屏']], scene.audioSceneLayout === 'landscape' ? 'landscape' : 'portrait')}
      </div>
    </div>
    <div class="off-settings-divider">舞台音效</div>
    <label class="off-toggle-row">
      <input type="checkbox" class="off-scene-stage-sound" ${scene.audioStageSoundEnabled !== false ? 'checked' : ''} />
      <span>舞台音效</span>
    </label>
    <div class="off-audio-stage-mix">
      <label class="off-audio-stage-range">
        <span>动作音量 <output class="off-scene-stage-action-output">${percentValue(scene.audioStageActionVolume, 58)}%</output></span>
        <input type="range" class="off-scene-stage-action-volume" min="0" max="100" step="1" value="${percentValue(scene.audioStageActionVolume, 58)}" />
      </label>
      <label class="off-audio-stage-range">
        <span>背景音量 <output class="off-scene-stage-background-output">${percentValue(scene.audioStageBackgroundVolume, 20)}%</output></span>
        <input type="range" class="off-scene-stage-background-volume" min="0" max="100" step="1" value="${percentValue(scene.audioStageBackgroundVolume, 20)}" />
      </label>
    </div>` : `<label class="off-toggle-row">
      <input type="checkbox" class="off-scene-optioncards" ${scene.optionCards ? 'checked' : ''} />
      <span>文末给推进选项（ABC 快捷走向）</span>
    </label>
    ${userPresent ? `<label class="off-toggle-row">
      <input type="checkbox" class="off-scene-block-user-speech" ${scene.blockUserSpeech !== false ? 'checked' : ''} />
      <span>防抢话：禁止 AI 扮演用户，正文只写角色反应</span>
    </label>` : ''}
    <label class="off-toggle-row">
      <input type="checkbox" class="off-scene-inner-voice" ${scene.innerVoiceEnabled ? 'checked' : ''} />
      <span>显示角色心声（每轮生成，点击正文中的心声标记查看）</span>
    </label>
    <label class="off-toggle-row">
      <input type="checkbox" class="off-scene-natural-ensemble" ${scene.naturalEnsemble ? 'checked' : ''} />
      <span>自然群像：按剧情聚焦角色，不逐个点名</span>
    </label>`}

    <div class="off-settings-divider">场景生图</div>
    <label class="api-field">
      <span class="api-field-label">生图引擎</span>
      <select class="form-input off-scene-image-gen-mode">
        <option value="" ${normalizeOfflineSceneImageGenMode(scene.imageGenMode) === '' ? 'selected' : ''}>跟随 API 管理中的线下默认</option>
        <option value="smart" ${normalizeOfflineSceneImageGenMode(scene.imageGenMode) === 'smart' ? 'selected' : ''}>智能选择</option>
        <option value="novelai" ${normalizeOfflineSceneImageGenMode(scene.imageGenMode) === 'novelai' ? 'selected' : ''}>NovelAI</option>
        <option value="realistic" ${normalizeOfflineSceneImageGenMode(scene.imageGenMode) === 'realistic' ? 'selected' : ''}>兼容生图</option>
      </select>
    </label>
    <label class="off-toggle-row">
      <input type="checkbox" class="off-scene-auto-image" ${scene.autoImagePerBeat ? 'checked' : ''} />
      <span>每轮自动生成一张场景图（开启后每轮结束自动出图，不用再手动点；会消耗生图额度）</span>
    </label>
    <div class="api-field">
      <span class="api-field-label">画风（可选，不选则跟随下方风格备注 / 角色外观）</span>
      <select class="form-input off-scene-image-style">${imageStyleOptionsHtml(scene.imageStyleId)}</select>
    </div>
    <label class="api-field">
      <span class="api-field-label">固定风格 / 主体备注（可选，每轮都会带上，不会替换当轮画面内容）</span>
      <textarea class="form-input off-scene-image-prompt" rows="2" placeholder="如：温暖复古滤镜、总是带点粒子光斑；不填则只按画风 + 当轮剧情出图">${esc(scene.imagePromptTemplate || '')}</textarea>
    </label>

    <div class="off-settings-divider">语音 / 上下文 / 自动总结</div>
    <label class="off-toggle-row">
      <input type="checkbox" class="off-scene-tts" ${scene.ttsEnabled ? 'checked' : ''} />
      <span>${audioExperience ? '自动生成角色语音' : '为本轮角色对白生成语音'}</span>
    </label>
    <div class="off-num-row">
      <label class="api-field off-num">
        <span class="api-field-label">完整上文轮数（更早内容用小结）</span>
        <input type="number" class="form-input off-scene-context-depth" value="${scene.contextDepth || 12}" min="2" max="60" />
      </label>
      <label class="api-field off-num">
        <span class="api-field-label">每几轮自动小结一次（0=仅超窗兜底）</span>
        <input type="number" class="form-input off-scene-auto-summary" value="${scene.autoSummaryEvery == null ? 6 : scene.autoSummaryEvery}" min="0" max="100" />
      </label>
    </div>
    ${showPerBeatDigest ? `<label class="off-toggle-row">
      <input type="checkbox" class="off-scene-per-beat-digest" ${scene.perBeatDigestEnabled ? 'checked' : ''} />
      <span>每轮生成隐藏摘要（高字数长篇可开启）</span>
    </label>` : ''}

    <div class="off-settings-divider">世界书 / 文风绑定</div>
    <div class="api-field">
      <span class="api-field-label">只用这些世界书（可多选，留空＝按默认规则）</span>
      <select class="form-input off-scene-worldbook" multiple size="5">
        ${worldBookOptions.map((wb) => `<option value="${esc(wb.id)}" ${normalizeWorldBookIds(scene).includes(wb.id) ? 'selected' : ''}>${esc(wb.name || wb.id)}</option>`).join('')}
      </select>
      <p class="off-field-hint">不选＝不限定，按默认规则走；Ctrl/Cmd 点击可多选。</p>
    </div>
    <div class="api-field">
      <span class="api-field-label">只用这些文风预设（可多选，留空＝跟随预设页开关默认全部注入）</span>
      <select class="form-input off-scene-preset-style" multiple size="4">
        ${presetOptions.map((p) => `<option value="${esc(p.id)}" ${normalizePresetStyleIds(scene).includes(p.id) ? 'selected' : ''}>${esc(p.name || p.id)}</option>`).join('')}
      </select>
      <p class="off-field-hint">不选＝不限定，按默认开关走；Ctrl/Cmd 点击可多选叠加，比如同时选「现代白描」+「阴雨天」。</p>
    </div>

    ${showAnonMemoryInject ? anonMemoryInjectFieldHtml(anonMemoryInject) : ''}`;
}

export function scenePresetBarHtml(presets = [], selectedId = '') {
  const selected = String(selectedId || '').trim();
  return `
    <div class="off-preset-bar">
      <select class="form-input off-preset-select">
        <option value="">用预设…</option>
        ${presets.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-outline btn-sm off-preset-save" data-preset-save="update">保存到所选</button>
      <button type="button" class="btn btn-outline btn-sm off-preset-save-as" data-preset-save="new">另存为</button>
      <button type="button" class="btn btn-outline btn-sm off-preset-delete" ${presets.length ? '' : 'disabled'}>删除所选</button>
    </div>`;
}

/**
 * 存/删命名机制预设后，只刷新预设条下拉本身，不做整页重绘。
 * 整页重绘会用页面里那份「初始快照」重新渲染机制字段区，把用户刚编辑但还没提交的其它设置冲掉；
 * 这里只替换 select 的 options，不影响表单其余部分。
 */
export function refreshScenePresetSelect(root, presets = [], selectedId = '') {
  const sel = root?.querySelector?.('.off-preset-select');
  if (sel) {
    sel.innerHTML = `<option value="">用预设…</option>${presets.map((p) => `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  }
  const delBtn = root?.querySelector?.('.off-preset-delete');
  if (delBtn) delBtn.disabled = !presets.length;
}

/** 读取机制字段（不含地点/同行者/一起做什么这类内容型字段，由各页面自己拼） */
export function readMechanicsFromInputs(root, base = {}) {
  const checkedOrBase = (selector, key, fallback = false) => {
    const el = root.querySelector(selector);
    if (el) return !!el.checked;
    return base[key] === undefined ? fallback : !!base[key];
  };
  const experienceMode = offlineExperienceModeOf(base);
  const audioSceneEnabled = experienceMode === OFFLINE_EXPERIENCE_AUDIO;
  const perspective = audioSceneEnabled
    ? 'user'
    : segVal(root, 'perspective', base.perspective || 'user');
  const person = normalizePersonForPerspective(
    perspective,
    audioSceneEnabled ? 'second' : segVal(root, 'person', base.person || 'second'),
  );
  return {
    tone: root.querySelector('.off-scene-tone')?.value,
    perspective,
    person,
    wordMin: root.querySelector('.off-scene-wmin')?.value,
    wordMax: root.querySelector('.off-scene-wmax')?.value,
    rounds: root.querySelector('.off-scene-rounds')?.value,
    optionCards: audioSceneEnabled || checkedOrBase('.off-scene-optioncards', 'optionCards', false),
    blockUserSpeech: audioSceneEnabled || checkedOrBase('.off-scene-block-user-speech', 'blockUserSpeech', true),
    innerVoiceEnabled: audioSceneEnabled ? false : checkedOrBase('.off-scene-inner-voice', 'innerVoiceEnabled', true),
    naturalEnsemble: !audioSceneEnabled && checkedOrBase('.off-scene-natural-ensemble', 'naturalEnsemble', false),
    // 表单保存后才能区分“旧版本落库的默认 false”和用户主动关闭。
    innerVoicePreferenceTouched: root.querySelector('.off-scene-inner-voice')
      ? true
      : base.innerVoicePreferenceTouched === true,
    dialogueMode: audioSceneEnabled || checkedOrBase('.off-scene-dialogue-mode', 'dialogueMode', false),
    noParaphrase: audioSceneEnabled || checkedOrBase('.off-scene-no-paraphrase', 'noParaphrase', true),
    directorMode: audioSceneEnabled ? false : checkedOrBase('.off-scene-director-mode', 'directorMode', false),
    experienceMode,
    audioSceneEnabled,
    audioSceneLayout: segVal(root, 'audioSceneLayout', base.audioSceneLayout === 'landscape' ? 'landscape' : 'portrait'),
    audioStageSoundEnabled: checkedOrBase('.off-scene-stage-sound', 'audioStageSoundEnabled', true),
    audioStageActionVolume: root.querySelector('.off-scene-stage-action-volume')?.value ?? base.audioStageActionVolume,
    audioStageBackgroundVolume: root.querySelector('.off-scene-stage-background-volume')?.value ?? base.audioStageBackgroundVolume,
    imageGenMode: normalizeOfflineSceneImageGenMode(
      root.querySelector('.off-scene-image-gen-mode')?.value ?? base.imageGenMode,
    ),
    imageStyleId: root.querySelector('.off-scene-image-style')?.value || base.imageStyleId,
    autoImagePerBeat: !!root.querySelector('.off-scene-auto-image')?.checked,
    imagePromptTemplate: root.querySelector('.off-scene-image-prompt')?.value ?? base.imagePromptTemplate,
    ttsEnabled: checkedOrBase('.off-scene-tts', 'ttsEnabled', audioSceneEnabled),
    contextDepth: root.querySelector('.off-scene-context-depth')?.value ?? base.contextDepth,
    autoSummaryEvery: root.querySelector('.off-scene-auto-summary')?.value ?? base.autoSummaryEvery,
    perBeatDigestEnabled: checkedOrBase('.off-scene-per-beat-digest', 'perBeatDigestEnabled', false),
    worldBookIds: (() => {
      const sel = root.querySelector('.off-scene-worldbook');
      if (!sel) return normalizeWorldBookIds(base);
      return [...sel.selectedOptions].map((o) => String(o.value || '').trim()).filter(Boolean);
    })(),
    presetStyleIds: (() => {
      const sel = root.querySelector('.off-scene-preset-style');
      if (!sel) return normalizePresetStyleIds(base);
      return [...sel.selectedOptions].map((o) => String(o.value || '').trim()).filter(Boolean);
    })(),
  };
}

export function applyMechanicsPresetToInputs(root, preset) {
  if (!preset) return;
  const setVal = (sel, val) => { const el = root.querySelector(sel); if (el && val !== undefined && val !== null) el.value = val; };
  const setChecked = (sel, val) => { const el = root.querySelector(sel); if (el) el.checked = !!val; };
  if (preset.tone !== undefined) setVal('.off-scene-tone', preset.tone);
  setVal('.off-scene-wmin', preset.wordMin);
  setVal('.off-scene-wmax', preset.wordMax);
  setVal('.off-scene-rounds', preset.rounds);
  setChecked('.off-scene-optioncards', preset.optionCards);
  if (preset.blockUserSpeech !== undefined) setChecked('.off-scene-block-user-speech', preset.blockUserSpeech);
  if (preset.innerVoiceEnabled !== undefined) setChecked('.off-scene-inner-voice', preset.innerVoiceEnabled);
  if (preset.naturalEnsemble !== undefined) setChecked('.off-scene-natural-ensemble', preset.naturalEnsemble);
  if (preset.dialogueMode !== undefined) setChecked('.off-scene-dialogue-mode', preset.dialogueMode);
  if (preset.noParaphrase !== undefined) setChecked('.off-scene-no-paraphrase', preset.noParaphrase);
  if (preset.directorMode !== undefined) setChecked('.off-scene-director-mode', preset.directorMode);
  if (preset.audioSceneLayout) setSegActive(root, 'audioSceneLayout', preset.audioSceneLayout);
  if (preset.audioStageSoundEnabled !== undefined) setChecked('.off-scene-stage-sound', preset.audioStageSoundEnabled);
  setVal('.off-scene-stage-action-volume', preset.audioStageActionVolume);
  setVal('.off-scene-stage-background-volume', preset.audioStageBackgroundVolume);
  if (preset.perspective) setSegActive(root, 'perspective', preset.perspective);
  if (preset.person) {
    setSegActive(
      root,
      'person',
      normalizePersonForPerspective(preset.perspective || segVal(root, 'perspective', 'user'), preset.person),
    );
  }
  if (preset.imageGenMode !== undefined) {
    setVal('.off-scene-image-gen-mode', normalizeOfflineSceneImageGenMode(preset.imageGenMode));
  }
  setVal('.off-scene-image-style', preset.imageStyleId);
  setChecked('.off-scene-auto-image', preset.autoImagePerBeat);
  if (preset.imagePromptTemplate !== undefined) setVal('.off-scene-image-prompt', preset.imagePromptTemplate);
  setChecked('.off-scene-tts', preset.ttsEnabled);
  setVal('.off-scene-context-depth', preset.contextDepth);
  setVal('.off-scene-auto-summary', preset.autoSummaryEvery);
  if (preset.perBeatDigestEnabled !== undefined) setChecked('.off-scene-per-beat-digest', preset.perBeatDigestEnabled);
  const wbSel = root.querySelector('.off-scene-worldbook');
  if (wbSel) {
    const picked = new Set(normalizeWorldBookIds(preset));
    [...wbSel.options].forEach((o) => { o.selected = picked.has(o.value); });
  }
  const styleSel = root.querySelector('.off-scene-preset-style');
  if (styleSel) {
    const pickedStyles = new Set(normalizePresetStyleIds(preset));
    [...styleSel.options].forEach((o) => { o.selected = pickedStyles.has(o.value); });
  }
  syncAudioStageSoundControls(root);
  syncPerspectivePersonControls(root);
}

function syncAudioStageSoundControls(root) {
  const enabled = root.querySelector('.off-scene-stage-sound');
  const rows = [
    ['.off-scene-stage-action-volume', '.off-scene-stage-action-output'],
    ['.off-scene-stage-background-volume', '.off-scene-stage-background-output'],
  ];
  for (const [inputSelector, outputSelector] of rows) {
    const input = root.querySelector(inputSelector);
    const output = root.querySelector(outputSelector);
    if (!input) continue;
    input.disabled = enabled ? !enabled.checked : false;
    if (output) output.textContent = `${percentValue(input.value, 0)}%`;
  }
  root.querySelector('.off-audio-stage-mix')?.classList.toggle('is-disabled', enabled ? !enabled.checked : false);
}

/** 机制字段 + 预设条上，不依赖具体页面业务逻辑的通用交互（折叠、下拉应用预设）。 */
export function bindMechanicsCommonControls(root, { onApplyPreset } = {}) {
  bindSegs(root);
  root.querySelector('.off-scene-stage-sound')?.addEventListener('change', () => syncAudioStageSoundControls(root));
  root.querySelectorAll('.off-scene-stage-action-volume, .off-scene-stage-background-volume').forEach((input) => {
    input.addEventListener('input', () => syncAudioStageSoundControls(root));
  });
  syncAudioStageSoundControls(root);
  root.querySelector('.off-preset-select')?.addEventListener('change', (e) => {
    if (typeof onApplyPreset === 'function') onApplyPreset(e.target.value);
  });
}
