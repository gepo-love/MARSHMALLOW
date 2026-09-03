import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { captureElementScrollState, restoreElementScrollState } from '../core/scroll-state.js';
import { listCharacters } from '../core/character-store.js';
import { saveChat, getChat } from '../core/chat-store.js';
import { getRoleTierLabel } from '../models/character.js';
import {
  ALL_GROUPS_FILTER,
  loadContactGroupsConfig,
  resolveCharacterGroupId,
} from '../core/contact-groups.js';
import { createSceneDraft } from '../core/offline-scene-draft.js';
import { loadOfflineSession, offlineSessionHasProgress } from '../core/offline-session-store.js';
import { resolve_offline_chat_for_participants } from '../core/offline-chat-route.js';
import { listAllWorldBookRows } from '../core/world-book-store.js';
import { listOfflinePresetOptions } from '../core/preset-store.js';
import {
  listOfflineScenePresets,
  saveOfflineScenePreset,
  deleteOfflineScenePreset,
  getLastOfflineScenePresetId,
  setLastOfflineScenePresetId,
  pickOfflineScenePresetFields,
  resolveOfflineSceneMechanicsSeed,
} from '../core/offline-scene-presets.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import {
  normalizeAnonMemoryInject,
  anonMemoryInjectFieldHtml,
  sceneMechanicsFieldsHtml,
  scenePresetBarHtml,
  readMechanicsFromInputs,
  applyMechanicsPresetToInputs,
  bindMechanicsCommonControls,
  refreshScenePresetSelect,
} from '../components/offline-scene-mechanics.js';
import {
  OFFLINE_EXPERIENCE_AUDIO,
  OFFLINE_EXPERIENCE_NORMAL,
} from '../core/offline-experience-mode.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formValue(root, selector) {
  return String(root.querySelector(selector)?.value || '').trim();
}

function searchText(char) {
  return [
    char.name,
    char.realName,
    char.customNickname,
    char.currentRole,
    ...(Array.isArray(char.aliases) ? char.aliases : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function draftKey(experienceMode) {
  return experienceMode === OFFLINE_EXPERIENCE_AUDIO
    ? 'marshmallow:offline-audio-date-draft'
    : 'marshmallow:offline-date-draft';
}

function loadDateDraft(experienceMode) {
  try {
    const raw = localStorage.getItem(draftKey(experienceMode));
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}

export default async function render(container, params = {}) {
  const experienceMode = params.experienceMode === OFFLINE_EXPERIENCE_AUDIO
    ? OFFLINE_EXPERIENCE_AUDIO
    : OFFLINE_EXPERIENCE_NORMAL;
  const audioExperience = experienceMode === OFFLINE_EXPERIENCE_AUDIO;
  const existingChatId = String(params.chatId || '').trim();
  // 首屏只等选人必需的数据。地图、世界书与预设都属于折叠设置，放到首次
  // paint 之后补齐，避免进页时长时间停在路由的「加载中」。
  const [user, existingChat, allCharactersRaw] = await Promise.all([
    ensureDefaultUser(),
    existingChatId ? getChat(existingChatId).catch(() => null) : Promise.resolve(null),
    listCharacters({ excludeAnonNpc: true }),
  ]);
  const existingParticipantIds = existingChat
    ? (existingChat.participants || []).filter((id) => id && id !== 'user')
    : [];
  let placeLookupAvailable = false;
  let worldBookOptions = [];
  let scenePresets = [];
  let presetOptions = [];
  let selectedPresetId = '';
  let contactGroups = { groups: [{ id: 'default', name: '默认' }] };

  const allCharacters = allCharactersRaw
    .filter((c) => c && c.id)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  // 从群聊进入时只在群成员中挑本场同行者；从私聊进入时开放整个通讯录，
  // 让用户能在保留当前角色的基础上继续加人，直接建立多人线下。
  const characters = existingChat && (existingChat.type === 'group' || audioExperience)
    ? existingParticipantIds
      .map((id) => allCharacters.find((c) => c.id === id))
      .filter(Boolean)
    : allCharacters;

  // 只自动套用机制设置（草稿 + 上次命名预设）；开场白/地点等当场内容每次新开为空
  const draft = loadDateDraft(experienceMode);
  const seeded = resolveOfflineSceneMechanicsSeed({
    presets: scenePresets,
    lastPresetId: selectedPresetId,
    draft,
  });
  selectedPresetId = seeded.selectedPresetId;
  // 命名预设由普通线下与音声线下共用；普通线下默认保存 ttsEnabled=false。
  // 首次进入音声页、尚无音声专属草稿时，不能让这个跨模式值覆盖音声默认，
  // 否则整幕对白虽能正常切割，却根本不会进入语音合成分支。
  const mechanicsSeed = audioExperience
    && !Object.prototype.hasOwnProperty.call(draft, 'ttsEnabled')
    ? { ...seeded.mechanicsSeed, ttsEnabled: true }
    : seeded.mechanicsSeed;
  let includeUser = audioExperience
    ? true
    : (existingChat ? (existingChat.participants || []).includes('user') : draft.includeUser !== false);
  const draftIds = Array.isArray(draft.selectedIds)
    ? draft.selectedIds
    : (draft.selectedId ? [draft.selectedId] : []);
  const seedIds = (existingChat
    ? existingParticipantIds
    : [String(params.characterId || '').trim(), ...draftIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  let selectedIds = seedIds.filter((id, idx) => seedIds.indexOf(id) === idx && characters.some((c) => c.id === id));
  if (!selectedIds.length && characters.length === 1) selectedIds = [characters[0].id];

  const state = {
    query: '',
    pickerOpen: false,
    pickerGroupId: ALL_GROUPS_FILTER,
    openingLine: '',
    place: '',
    activity: '',
    timeLabel: '',
    tone: String(mechanicsSeed.tone || ''),
    anonMemoryInject: normalizeAnonMemoryInject(draft.anonMemoryInject),
    placeKeywords: '',
    placeMaterial: '',
    placeCandidates: [],
    placeLookupBusy: false,
  };
  function mechanicsForPresence(base = {}) {
    return createSceneDraft({
      ...base,
      experienceMode,
      ...(!includeUser ? {
        experienceMode: OFFLINE_EXPERIENCE_NORMAL,
        perspective: 'omniscient',
        person: 'third',
        dialogueMode: false,
        directorMode: true,
        blockUserSpeech: false,
      } : {}),
    });
  }

  let mechanicsBase = mechanicsForPresence(mechanicsSeed);
  let moreOpen = false;
  let mechanicsTouched = false;
  let optionalDataPromise = null;
  let starting = false;

  container.className = `page scrapbook-page offline-date-page${audioExperience ? ' offline-audio-date-page' : ''}`;

  /** 整页 paint 前必须把机制字段写回 mechanicsBase，否则折叠/选人重绘会冲掉场景生图等设置。 */
  function syncMechanicsFromInputs() {
    if (!container.querySelector('.off-scene-auto-image') && !container.querySelector('.off-scene-wmin')) return;
    mechanicsBase = createSceneDraft({
      ...mechanicsBase,
      ...readMechanicsFromInputs(container, mechanicsBase),
    });
  }

  function syncStateFromInputs() {
    state.openingLine = String(container.querySelector('.od-opening')?.value || '');
    state.place = formValue(container, '.od-place');
    state.activity = formValue(container, '.od-activity');
    state.tone = formValue(container, '.off-scene-tone') || state.tone;
    state.anonMemoryInject = normalizeAnonMemoryInject(container.querySelector('.off-anon-memory-inject')?.value);
    syncMechanicsFromInputs();
  }

  function saveDraft() {
    try {
      syncMechanicsFromInputs();
      // 草稿只记选人 + 机制/通用设置；开场白、地点、活动等当场内容不缓存
      localStorage.setItem(draftKey(experienceMode), JSON.stringify({
        selectedIds,
        includeUser,
        tone: mechanicsBase.tone || state.tone,
        anonMemoryInject: state.anonMemoryInject,
        ...pickOfflineScenePresetFields(mechanicsBase),
      }));
    } catch (_) { /* localStorage 不可用时静默 */ }
  }

  function clearSceneContent() {
    state.openingLine = '';
    state.place = '';
    state.activity = '';
    state.timeLabel = '';
    state.placeKeywords = '';
    state.placeMaterial = '';
    state.placeCandidates = [];
  }

  async function onQueryPlace() {
    syncStateFromInputs();
    const btn = container.querySelector('.od-query-place');
    if (btn) { btn.disabled = true; btn.textContent = '查询中…'; }
    state.placeLookupBusy = true;
    try {
      const { collectOfflinePlaceMaterial } = await import('../core/offline-place-material.js');
      const result = await collectOfflinePlaceMaterial({
        place: state.place,
        activity: state.activity,
        keywords: state.place,
      });
      state.placeCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
      state.placeMaterial = String(result?.material || '').trim();
      saveDraft();
      if (!state.placeCandidates.length && !state.placeMaterial) {
        showToast('没查到相关信息，可以直接手动填地点');
      }
    } catch (err) {
      showToast(`查询失败：${err?.message || err}`);
    } finally {
      state.placeLookupBusy = false;
      paint();
    }
  }

  function selectedChars() {
    return selectedIds.map((id) => characters.find((c) => c.id === id)).filter(Boolean);
  }

  function characterLabel(char) {
    return char?.customNickname || char?.name || '未命名';
  }

  function availableGroups() {
    const counts = new Map();
    characters.forEach((char) => {
      const groupId = resolveCharacterGroupId(char);
      counts.set(groupId, (counts.get(groupId) || 0) + 1);
    });
    return (contactGroups?.groups || [])
      .filter((group) => counts.has(group.id))
      .map((group) => ({ ...group, count: counts.get(group.id) || 0 }));
  }

  function pickerResultsHtml() {
    const q = state.query.trim().toLowerCase();
    const groups = availableGroups();
    const groupNameById = new Map(groups.map((group) => [group.id, group.name]));
    const filtered = characters.filter((char) => {
      if (state.pickerGroupId !== ALL_GROUPS_FILTER
        && resolveCharacterGroupId(char) !== state.pickerGroupId) return false;
      return !q || searchText(char).includes(q);
    });
    if (!filtered.length) {
      return `<div class="od-picker-empty">${q ? '没有匹配角色' : '这个分组里还没有角色'}</div>`;
    }
    const buckets = new Map();
    filtered.forEach((char) => {
      const groupId = resolveCharacterGroupId(char);
      if (!buckets.has(groupId)) buckets.set(groupId, []);
      buckets.get(groupId).push(char);
    });
    return [...buckets.entries()].map(([groupId, rows]) => `
      <section class="od-picker-group" aria-label="${esc(groupNameById.get(groupId) || '默认')}分组">
        ${state.pickerGroupId === ALL_GROUPS_FILTER ? `<div class="od-picker-group-title"><span>${esc(groupNameById.get(groupId) || '默认')}</span><small>${rows.length}</small></div>` : ''}
        ${rows.map((char) => {
          const active = selectedIds.includes(char.id);
          const sub = [getRoleTierLabel(char.roleTier), char.currentRole].filter(Boolean).join(' · ');
          return `
            <button type="button" class="od-picker-option${active ? ' is-active' : ''}" data-picker-id="${esc(char.id)}" role="checkbox" aria-checked="${active ? 'true' : 'false'}">
              <span class="od-char-avatar">${characterAvatarHtml(char, { className: 'od-char-avatar-img' })}</span>
              <span class="od-char-body">
                <strong>${esc(characterLabel(char))}</strong>
                <small>${esc(sub || groupNameById.get(groupId) || '角色')}</small>
              </span>
              <span class="od-picker-check" aria-hidden="true">${active ? '✓' : ''}</span>
            </button>`;
        }).join('')}
      </section>`).join('');
  }

  function selectedChipsHtml(picked) {
    if (!picked.length) return '';
    return `<div class="od-selected" aria-label="已选角色">
      ${picked.map((char) => `
        <span class="od-selected-chip">
          <span class="od-selected-avatar">${characterAvatarHtml(char, { className: 'od-selected-avatar-img' })}</span>
          <span>${esc(characterLabel(char))}</span>
          <button type="button" data-remove-picker-id="${esc(char.id)}" aria-label="移除${esc(characterLabel(char))}">×</button>
        </span>`).join('')}
    </div>`;
  }

  function toggleSelected(id) {
    const cid = String(id || '').trim();
    if (!cid) return;
    if (selectedIds.includes(cid)) selectedIds = selectedIds.filter((x) => x !== cid);
    else selectedIds = audioExperience ? [cid] : [...selectedIds, cid];
    // 换人后开场白/地点不再沿用上一人的当场内容
    clearSceneContent();
  }

  function setIncludeUser(next) {
    if (audioExperience || existingChat) return;
    includeUser = next !== false;
    mechanicsBase = mechanicsForPresence(mechanicsBase);
  }

  function moreSettingsHtml() {
    return `
      <div class="off-more-fields" ${moreOpen ? '' : 'hidden'}>
        ${scenePresetBarHtml(scenePresets, selectedPresetId)}
        ${sceneMechanicsFieldsHtml(mechanicsBase, state.anonMemoryInject, {
          worldBookOptions,
          presetOptions,
          showEncounterModes: !audioExperience,
          userPresent: includeUser,
        })}
      </div>`;
  }

  function hydrateOptionalData() {
    if (optionalDataPromise) return optionalDataPromise;
    if (!container.classList.contains('offline-date-page')) return Promise.resolve();
    optionalDataPromise = Promise.all([
      import('../core/amap-tools.js').then((mod) => mod.loadAmapConfig()).catch(() => null),
      import('../core/web-search-tools.js').then((mod) => mod.loadWebSearchConfig()).catch(() => null),
      listAllWorldBookRows().catch(() => []),
      listOfflineScenePresets(user.id).catch(() => []),
      listOfflinePresetOptions().catch(() => []),
      getLastOfflineScenePresetId(user.id).catch(() => ''),
      loadContactGroupsConfig().catch(() => ({ groups: [{ id: 'default', name: '默认' }] })),
    ]).then(([amapCfg, searchCfg, worldBookRows, freshScenePresets, freshPresetOptions, lastPresetId, freshContactGroups]) => {
      placeLookupAvailable = !!(amapCfg?.enabled && amapCfg?.apiKey) || !!searchCfg?.enabled;
      worldBookOptions = worldBookRows
        .filter((wb) => wb.isBookRoot)
        .map((wb) => ({ id: wb.id, name: wb.name || wb.title || wb.id }));
      scenePresets = Array.isArray(freshScenePresets) ? freshScenePresets : [];
      presetOptions = Array.isArray(freshPresetOptions) ? freshPresetOptions : [];
      contactGroups = freshContactGroups || contactGroups;
      if (!container.classList.contains('offline-date-page')) return;
      // 重绘前先收住用户可能已经输入的开场与地点；此时读取旧机制值不会覆盖下面的预设补全。
      syncStateFromInputs();

      if (!mechanicsTouched) {
        const hydratedSeed = resolveOfflineSceneMechanicsSeed({
          presets: scenePresets,
          lastPresetId,
          draft,
        });
        selectedPresetId = hydratedSeed.selectedPresetId;
        const hydratedMechanics = audioExperience
          && !Object.prototype.hasOwnProperty.call(draft, 'ttsEnabled')
          ? { ...hydratedSeed.mechanicsSeed, ttsEnabled: true }
          : hydratedSeed.mechanicsSeed;
        mechanicsBase = mechanicsForPresence(hydratedMechanics);
      }
      if (!selectedPresetId && lastPresetId) {
        setLastOfflineScenePresetId(user.id, '').catch(() => {});
      }
      if (!starting) paint();
    });
    return optionalDataPromise;
  }

  function paint({ pickerFocusId = '' } = {}) {
    const scrollState = captureElementScrollState(container, '.od-scroll');
    const pickerScrollState = captureElementScrollState(container, '.od-picker-results', 0);
    const picked = selectedChars();
    const groups = availableGroups();
    const observerMode = !includeUser;
    const headerTitle = picked.length
      ? (picked.length === 1
        ? (audioExperience
          ? `和 ${esc(picked[0].customNickname || picked[0].name || 'TA')} 开一场音声线下`
          : `${observerMode ? '旁观' : '和'} ${esc(picked[0].customNickname || picked[0].name || 'TA')} ${observerMode ? '的线下' : '约一场线下'}`)
        : `${observerMode ? '旁观线下' : '多人线下'} · ${esc(picked.map((c) => c.customNickname || c.name || 'TA').join('、'))}`)
      : (audioExperience ? '选择一名角色' : '选择角色（可多选发起多人线下）');
    const canStart = audioExperience
      ? picked.length === 1
      : picked.length >= 1;

    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${audioExperience ? '音声线下' : '约线下'}</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="od-scroll scrapbook-scroll">
        <section class="od-panel">
          ${characters.length ? `
            ${selectedChipsHtml(picked)}
            <button type="button" class="od-picker-trigger" aria-expanded="${state.pickerOpen ? 'true' : 'false'}">
              <span>${picked.length ? `已选 ${picked.length} 人` : (audioExperience ? '选择一名角色' : '选择同行角色')}</span>
              <span class="od-picker-trigger-icon" aria-hidden="true">⌄</span>
            </button>
            <div class="od-picker-dropdown" ${state.pickerOpen ? '' : 'hidden'}>
              <div class="od-picker-tools">
                <label class="od-search">
                  <span class="od-search-icon" aria-hidden="true">${icon('search')}</span>
                  <input type="search" class="od-search-input" placeholder="搜索角色" value="${esc(state.query)}" autocomplete="off" aria-label="搜索角色">
                </label>
                <select class="od-picker-group-select" aria-label="按分组筛选">
                  <option value="${ALL_GROUPS_FILTER}" ${state.pickerGroupId === ALL_GROUPS_FILTER ? 'selected' : ''}>全部分组 · ${characters.length}</option>
                  ${groups.map((group) => `<option value="${esc(group.id)}" ${state.pickerGroupId === group.id ? 'selected' : ''}>${esc(group.name)} · ${group.count}</option>`).join('')}
                </select>
              </div>
              <div class="od-picker-results">${pickerResultsHtml()}</div>
              <button type="button" class="od-picker-done">选好了</button>
            </div>`
            : `<div class="od-empty">${emptyIllustration('chat')}<div class="od-empty-text">通讯录还是空的</div></div>`}
        </section>

        <section class="scrapbook-card od-form">
          <div class="chat-details-section-title">${headerTitle}</div>
          ${!audioExperience && !existingChat ? `
          <label class="off-mode-toggle od-presence-toggle">
            <input type="checkbox" class="od-user-present" ${includeUser ? 'checked' : ''} />
            <span><strong>我会在场</strong><small>关闭后只旁观角色互动</small></span>
          </label>` : ''}
          <label class="api-field">
            <span class="api-field-label">本场开场安排（可选）</span>
            <textarea class="form-input od-opening" rows="3" placeholder="写一句开场白，或简要安排本场从哪里、什么情节开始；留空则自然承接">${esc(state.openingLine)}</textarea>
          </label>
          <label class="api-field">
            <span class="api-field-label">去哪儿（可选）</span>
            <input type="text" class="form-input od-place" value="${esc(state.place)}" placeholder="如：江边的旧书店" maxlength="60" />
          </label>
          <label class="api-field">
            <span class="api-field-label">一起做什么（可选）</span>
            <input type="text" class="form-input od-activity" value="${esc(state.activity)}" placeholder="如：逛逛书、喝杯热的" maxlength="80" />
          </label>
          ${placeLookupAvailable ? `
          <div class="od-place-lookup">
            <button type="button" class="btn btn-outline btn-sm od-query-place" ${state.placeLookupBusy ? 'disabled' : ''}>${state.placeLookupBusy ? '查询中…' : '按地点查附近'}</button>
            ${state.placeCandidates.length ? `
              <div class="od-place-candidates">
                ${state.placeCandidates.map((c) => `<button type="button" class="od-place-candidate" data-place-pick="${esc(c.name)}"><strong>${esc(c.name)}</strong>${c.address ? `<small>${esc(c.address)}</small>` : ''}</button>`).join('')}
              </div>
            ` : ''}
            ${state.placeMaterial ? `<div class="od-place-material">${esc(state.placeMaterial)}</div>` : ''}
          </div>
          ` : ''}
          <button type="button" class="off-more-toggle" data-toggle-more>${moreOpen ? '收起设置 ▲' : (audioExperience ? '音声设置（画面 / 生图 / 文风…）▼' : '叙事设置（视角 / 字数 / 文风…）▼')}</button>
          ${moreSettingsHtml()}
        </section>
      </main>
      <footer class="od-footer">
        <button type="button" class="btn btn-primary od-start" ${canStart ? '' : 'disabled'}>${audioExperience ? '开始音声线下' : (observerMode
          ? `开始旁观线下${picked.length ? `（${picked.length}人）` : ''}`
          : (picked.length > 1 ? `进入多人线下（${picked.length + 1}人）` : '开始线下'))}</button>
        <button type="button" class="btn btn-outline od-start-direct" ${canStart ? '' : 'disabled'}>直接进入 · 承接聊天</button>
      </footer>
    `;

    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('.od-picker-trigger')?.addEventListener('click', () => {
      syncStateFromInputs();
      state.pickerOpen = !state.pickerOpen;
      paint();
      if (state.pickerOpen) container.querySelector('.od-search-input')?.focus({ preventScroll: true });
    });
    container.querySelector('.od-picker-done')?.addEventListener('click', () => {
      syncStateFromInputs();
      state.pickerOpen = false;
      paint();
    });
    container.querySelector('.od-search-input')?.addEventListener('input', (event) => {
      state.query = String(event.currentTarget?.value || '');
      const results = container.querySelector('.od-picker-results');
      if (results) results.innerHTML = pickerResultsHtml();
    });
    container.querySelector('.od-picker-group-select')?.addEventListener('change', (event) => {
      state.pickerGroupId = String(event.currentTarget?.value || ALL_GROUPS_FILTER);
      const results = container.querySelector('.od-picker-results');
      if (results) results.innerHTML = pickerResultsHtml();
    });
    container.querySelector('.od-picker-dropdown')?.addEventListener('click', (event) => {
      const row = event.target.closest('[data-picker-id]');
      if (!row) return;
      const pickerId = row.getAttribute('data-picker-id') || '';
      syncStateFromInputs();
      toggleSelected(pickerId);
      saveDraft();
      paint({ pickerFocusId: pickerId });
    });
    container.querySelectorAll('[data-remove-picker-id]').forEach((button) => {
      button.addEventListener('click', () => {
        syncStateFromInputs();
        toggleSelected(button.getAttribute('data-remove-picker-id'));
        saveDraft();
        paint();
      });
    });
    container.querySelector('.od-form')?.addEventListener('input', (event) => {
      if (event.target?.closest?.('.off-more-fields')) mechanicsTouched = true;
      syncStateFromInputs();
      saveDraft();
    });
    container.querySelector('.od-form')?.addEventListener('change', (event) => {
      if (event.target?.closest?.('.off-more-fields')) mechanicsTouched = true;
      syncStateFromInputs();
      saveDraft();
    });
    container.querySelector('.od-user-present')?.addEventListener('change', (event) => {
      syncStateFromInputs();
      setIncludeUser(event.currentTarget?.checked === true);
      saveDraft();
      paint();
    });
    container.querySelector('[data-toggle-more]')?.addEventListener('click', () => {
      syncStateFromInputs();
      saveDraft();
      const opening = !moreOpen;
      moreOpen = opening;
      if (opening) hydrateOptionalData();
      paint();
    });
    bindMechanicsCommonControls(container, {
      onApplyPreset: (id) => {
        mechanicsTouched = true;
        const preset = scenePresets.find((p) => p.id === id);
        if (preset) {
          selectedPresetId = preset.id;
          applyMechanicsPresetToInputs(container, preset);
          syncMechanicsFromInputs();
          saveDraft();
          setLastOfflineScenePresetId(user.id, preset.id).catch(() => {});
        } else {
          selectedPresetId = '';
        }
      },
    });
    const savePresetFromForm = async ({ asNew = false } = {}) => {
      syncMechanicsFromInputs();
      const currentId = container.querySelector('.off-preset-select')?.value || selectedPresetId;
      const current = scenePresets.find((p) => p.id === currentId);
      if (!asNew && current) {
        const saved = await saveOfflineScenePreset(user.id, {
          id: current.id,
          name: current.name,
          ...pickOfflineScenePresetFields(mechanicsBase),
        });
        selectedPresetId = saved.id;
        scenePresets = await listOfflineScenePresets(user.id);
        refreshScenePresetSelect(container, scenePresets, saved.id);
        showToast('已覆盖所选预设');
        return;
      }
      openTextEditorModal({
        title: '另存为新预设',
        value: current?.name || '',
        multiline: false,
        placeholder: '给这组设置起个名字',
        confirmLabel: '保存',
        onSave: async (name) => {
          if (!name) { showToast('名字不能为空'); return; }
          syncMechanicsFromInputs();
          const saved = await saveOfflineScenePreset(user.id, {
            name,
            ...pickOfflineScenePresetFields(mechanicsBase),
          });
          selectedPresetId = saved.id;
          scenePresets = await listOfflineScenePresets(user.id);
          refreshScenePresetSelect(container, scenePresets, saved.id);
          showToast('已保存预设');
        },
      });
    };
    container.querySelector('.off-preset-save')?.addEventListener('click', () => {
      const currentId = container.querySelector('.off-preset-select')?.value || selectedPresetId;
      if (!currentId) {
        showToast('先选一个预设，或点「另存为」');
        return;
      }
      savePresetFromForm({ asNew: false });
    });
    container.querySelector('.off-preset-save-as')?.addEventListener('click', () => {
      savePresetFromForm({ asNew: true });
    });
    container.querySelector('.off-preset-delete')?.addEventListener('click', async () => {
      const id = container.querySelector('.off-preset-select')?.value;
      if (!id) { showToast('先选一个预设'); return; }
      await deleteOfflineScenePreset(user.id, id);
      selectedPresetId = '';
      scenePresets = await listOfflineScenePresets(user.id);
      refreshScenePresetSelect(container, scenePresets);
      showToast('已删除预设');
    });
    container.querySelector('.od-start')?.addEventListener('click', () => onStart({ direct: false }));
    container.querySelector('.od-start-direct')?.addEventListener('click', () => onStart({ direct: true }));
    container.querySelector('.od-query-place')?.addEventListener('click', onQueryPlace);
    container.querySelectorAll('[data-place-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncStateFromInputs();
        state.place = btn.getAttribute('data-place-pick') || state.place;
        saveDraft();
        paint();
      });
    });
    restoreElementScrollState(container, '.od-scroll', scrollState);
    restoreElementScrollState(container, '.od-picker-results', pickerScrollState);
    if (pickerFocusId) {
      requestAnimationFrame(() => {
        const option = [...container.querySelectorAll('[data-picker-id]')]
          .find((row) => row.getAttribute('data-picker-id') === pickerFocusId);
        option?.focus({ preventScroll: true });
      });
    }
  }

  async function onStart({ direct = false } = {}) {
    const picked = selectedChars();
    if (!picked.length) {
      showToast('请先选择角色');
      return;
    }
    if (audioExperience && picked.length !== 1) {
      showToast('音声线下初版只支持一名角色');
      return;
    }
    syncStateFromInputs();
    saveDraft();
    const btn = container.querySelector(direct ? '.od-start-direct' : '.od-start');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '准备中...';
    }
    starting = true;
    try {
      // 若用户在首屏刚出现时就点开始，只在按钮的准备阶段等完预设补全，
      // 不让后台重绘替换掉正在工作的按钮或漏用上次场景设置。
      await hydrateOptionalData();
      let chat = existingChat;
      let existingSession = null;
      if (!chat) {
        const group_name = picked.map((c) => c.customNickname || c.name || 'TA').join('、').slice(0, 30);
        const resolved = await resolve_offline_chat_for_participants({
          user_id: user.id,
          characters: picked,
          group_name,
          location: state.place,
          encounter_label: state.place || state.activity || '线下相遇',
          include_user: includeUser,
        });
        chat = resolved.chat;
        existingSession = resolved.session;
      }
      // Re-enter the unfinished route instead of replacing its progress.
      if (!existingSession) existingSession = await loadOfflineSession(chat.id);
      if (offlineSessionHasProgress(existingSession)) {
        showToast('继续上次未收纳的线下');
        navigate('offline', { chatId: chat.id });
        return;
      }
      chat.metadata = {
        ...(chat.metadata || {}),
        anonymousMemoryInject: state.anonMemoryInject,
      };
      await saveChat(chat);
      const mech = mechanicsForPresence(readMechanicsFromInputs(container, mechanicsBase));
      const autoCompanions = picked.length > 1
        ? picked.map((c) => c.customNickname || c.name || 'TA').join('、')
        : '';
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const scene = createSceneDraft({
        ...mech,
        experienceMode,
        openingLine: state.openingLine,
        place: state.place,
        goal: state.activity,
        companions: autoCompanions,
        placeMaterial: state.placeMaterial,
      });
      const { startOfflineSession } = await import('../core/offline-session.js');
      await startOfflineSession({
        chatId: chat.id,
        userId: user.id,
        userPresent: includeUser,
        participantIds: picked.map((c) => c.id),
        scene,
        originSeed: {
          // 点击“直接进入”就始终承接线上聊天；地点 / 活动若有填写，只作为落地约束，
          // 不能因为恢复了上次表单内容而悄悄退化成普通线下开场。
          from: !includeUser ? 'observer' : (direct ? 'direct' : 'user'),
          place: state.place,
          activity: state.activity,
          note: '',
          companions: autoCompanions,
          timeLabel: `今天 ${hm}`,
        },
      });
      navigate('offline', { chatId: chat.id, justStarted: '1' });
    } catch (err) {
      starting = false;
      showToast(String(err?.message || err));
      if (btn) {
        btn.disabled = false;
        btn.textContent = direct ? '直接进入 · 承接聊天' : (audioExperience ? '开始音声线下' : '开始线下');
      }
    }
  }

  paint();
  // 高级数据即使用户不展开设置也在首屏后预热；下一步操作无需再等。
  requestAnimationFrame(() => hydrateOptionalData());
}
