/**
 * 一起旅行 · 独立模块的设置页（相遇模块）。
 *
 * 和「约会探索」的区别：约会探索是「聊着聊着见面了」的轻量延续，这里是专门开辟的、
 * 有仪式感的多天行程——目的地/天数/主题都值得认真填一下，沉浸阶段复用 offline-session.js
 * 的 beat feed 引擎（不重写叙事逻辑），只是打上 activityKind:'trip' 的标记走独立的视觉与节奏。
 */
import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { captureElementScrollState, restoreElementScrollState } from '../core/scroll-state.js';
import { listCharacters } from '../core/character-store.js';
import { saveChat } from '../core/chat-store.js';
import { getRoleTierLabel } from '../models/character.js';
import { collectOfflinePlaceMaterial } from '../core/offline-place-material.js';
import { loadAmapConfig } from '../core/amap-tools.js';
import { loadWebSearchConfig } from '../core/web-search-tools.js';
import { createSceneDraft, startOfflineSession, loadOfflineSession } from '../core/offline-session.js';
import { resolve_offline_chat_for_participants } from '../core/offline-chat-route.js';
import { planTogetherTripItinerary } from '../core/together-trip-itinerary.js';
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
import { bindCommitSearch } from '../components/search-field.js';
import {
  normalizeAnonMemoryInject,
  sceneMechanicsFieldsHtml,
  scenePresetBarHtml,
  readMechanicsFromInputs,
  applyMechanicsPresetToInputs,
  bindMechanicsCommonControls,
  refreshScenePresetSelect,
} from '../components/offline-scene-mechanics.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

const DRAFT_KEY = 'marshmallow:together-trip-draft';

const TRIP_THEMES = ['治愈海边', 'City Walk', '深度文化', '美食巡礼', '随性漫游'];

function loadTripDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  const [amapCfg, searchCfg, worldBookRows, scenePresetsRaw, presetOptionsRaw, lastPresetIdRaw] = await Promise.all([
    loadAmapConfig().catch(() => null),
    loadWebSearchConfig().catch(() => null),
    listAllWorldBookRows().catch(() => []),
    listOfflineScenePresets(user.id).catch(() => []),
    listOfflinePresetOptions().catch(() => []),
    getLastOfflineScenePresetId(user.id).catch(() => ''),
  ]);
  const placeLookupAvailable = !!(amapCfg?.enabled && amapCfg?.apiKey) || !!searchCfg?.enabled;
  const worldBookOptions = worldBookRows.filter((wb) => wb.isBookRoot).map((wb) => ({ id: wb.id, name: wb.name || wb.title || wb.id }));
  let scenePresets = scenePresetsRaw;
  let presetOptions = Array.isArray(presetOptionsRaw) ? presetOptionsRaw : [];
  let selectedPresetId = String(lastPresetIdRaw || '').trim();

  const characters = (await listCharacters({ excludeAnonNpc: true }))
    .filter((c) => c && c.id)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));

  // 只自动套用机制设置；目的地/开场等当场内容每次新开为空
  const draft = loadTripDraft();
  const seeded = resolveOfflineSceneMechanicsSeed({
    presets: scenePresets,
    lastPresetId: selectedPresetId,
    draft,
  });
  selectedPresetId = seeded.selectedPresetId;
  const mechanicsSeed = seeded.mechanicsSeed;
  if (!selectedPresetId && lastPresetIdRaw) {
    setLastOfflineScenePresetId(user.id, '').catch(() => {});
  }
  const seedIds = [String(params.characterId || '').trim(), ...(Array.isArray(draft.selectedIds) ? draft.selectedIds : [])]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  let selectedIds = seedIds.filter((id, idx) => seedIds.indexOf(id) === idx && characters.some((c) => c.id === id));
  if (!selectedIds.length && characters.length === 1) selectedIds = [characters[0].id];

  const state = {
    query: '',
    destination: '',
    durationDays: 3,
    theme: TRIP_THEMES[0],
    openingLine: '',
    anonMemoryInject: normalizeAnonMemoryInject(draft.anonMemoryInject),
    placeKeywords: '',
    placeMaterial: '',
    placeCandidates: [],
    placeLookupBusy: false,
  };
  let mechanicsBase = createSceneDraft(mechanicsSeed);
  let moreOpen = false;

  container.className = 'page scrapbook-page offline-date-page together-trip-page';

  /** 整页 paint 前必须写回机制字段，否则折叠/选人重绘会冲掉场景生图等设置。 */
  function syncMechanicsFromInputs() {
    if (!container.querySelector('.off-scene-auto-image') && !container.querySelector('.off-scene-wmin')) return;
    mechanicsBase = createSceneDraft({
      ...mechanicsBase,
      ...readMechanicsFromInputs(container, mechanicsBase),
    });
  }

  function syncStateFromInputs() {
    state.destination = String(container.querySelector('.tt-destination')?.value || '').trim();
    state.durationDays = Math.min(7, Math.max(1, Number(container.querySelector('.tt-duration')?.value) || 3));
    state.theme = String(container.querySelector('.tt-theme')?.value || TRIP_THEMES[0]);
    state.openingLine = String(container.querySelector('.tt-opening')?.value || '');
    state.anonMemoryInject = normalizeAnonMemoryInject(container.querySelector('.off-anon-memory-inject')?.value);
    state.placeKeywords = String(container.querySelector('.tt-place-keywords')?.value || '').trim();
    syncMechanicsFromInputs();
  }

  function saveDraft() {
    try {
      syncMechanicsFromInputs();
      // 草稿只记选人 + 机制/通用设置；目的地、开场白等当场内容不缓存
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        selectedIds,
        anonMemoryInject: state.anonMemoryInject,
        ...pickOfflineScenePresetFields(mechanicsBase),
      }));
    } catch (_) { /* localStorage 不可用时静默 */ }
  }

  function clearSceneContent() {
    state.destination = '';
    state.openingLine = '';
    state.placeKeywords = '';
    state.placeMaterial = '';
    state.placeCandidates = [];
  }

  async function onQueryPlace() {
    syncStateFromInputs();
    const btn = container.querySelector('.tt-query-place');
    if (btn) { btn.disabled = true; btn.textContent = '查询中…'; }
    state.placeLookupBusy = true;
    try {
      const result = await collectOfflinePlaceMaterial({
        place: state.destination,
        activity: state.theme,
        keywords: state.placeKeywords,
      });
      state.placeCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
      state.placeMaterial = String(result?.material || '').trim();
      saveDraft();
      if (!state.placeCandidates.length && !state.placeMaterial) {
        showToast('没查到相关信息，可以直接手动填目的地');
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

  function toggleSelected(id) {
    const cid = String(id || '').trim();
    if (!cid) return;
    if (selectedIds.includes(cid)) selectedIds = selectedIds.filter((x) => x !== cid);
    else selectedIds = [...selectedIds, cid];
    // 换人后目的地/开场白不再沿用上一人的当场内容
    clearSceneContent();
  }

  function paint() {
    const scrollState = captureElementScrollState(container, '.od-scroll');
    const q = state.query.trim().toLowerCase();
    const rows = q ? characters.filter((c) => searchText(c).includes(q)) : characters;
    const picked = selectedChars();
    const listHtml = characters.length
      ? rows.map((char) => {
        const active = selectedIds.includes(char.id) ? ' is-active' : '';
        const sub = [getRoleTierLabel(char.roleTier), char.customNickname || char.currentRole].filter(Boolean).join(' · ');
        return `
          <button type="button" class="od-char${active}" data-id="${esc(char.id)}">
            <span class="od-char-avatar">${characterAvatarHtml(char, { className: 'od-char-avatar-img' })}</span>
            <span class="od-char-body">
              <strong>${esc(char.name || '未命名')}</strong>
              <small>${esc(sub || '角色')}</small>
            </span>
            <span class="od-char-check" aria-hidden="true">${active ? '✓' : ''}</span>
          </button>
        `;
      }).join('')
      : `<div class="od-empty">${emptyIllustration('chat')}<div class="od-empty-text">通讯录还是空的</div></div>`;

    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">一起旅行</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="od-scroll scrapbook-scroll">
        <section class="od-panel">
          <div class="od-search">
            <button type="button" class="od-search-icon search-icon-submit" data-search-submit aria-label="搜索">${icon('search')}</button>
            <input type="search" class="od-search-input" placeholder="找一位角色，回车搜索" value="${esc(state.query)}" autocomplete="off">
          </div>
          <div class="od-char-list">${listHtml}</div>
        </section>

        <section class="scrapbook-card od-form tt-form">
          <div class="chat-details-section-title">${picked.length
            ? (picked.length === 1
              ? `和 ${esc(picked[0].customNickname || picked[0].name || 'TA')} 一起去旅行`
              : `一起旅行 · ${esc(picked.map((c) => c.customNickname || c.name || 'TA').join('、'))}`)
            : '选择同行的角色（可多选）'}</div>
          <label class="api-field">
            <span class="api-field-label">目的地（可留空，让TA帮你们决定）</span>
            <input type="text" class="form-input tt-destination" value="${esc(state.destination)}" placeholder="如：海边小城、临市古镇" maxlength="60" />
          </label>
          <label class="api-field">
            <span class="api-field-label">出行天数</span>
            <select class="form-input tt-duration">
              ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}" ${state.durationDays === d ? 'selected' : ''}>${d} 天</option>`).join('')}
            </select>
          </label>
          <div class="api-field">
            <span class="api-field-label">旅行主题</span>
            <select class="form-input tt-theme">
              ${TRIP_THEMES.map((t) => `<option value="${esc(t)}" ${state.theme === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </div>
          ${placeLookupAvailable ? `
          <div class="od-place-lookup">
            <label class="api-field">
              <span class="api-field-label">关键词（帮你们提前查目的地，可不填）</span>
              <input type="text" class="form-input tt-place-keywords" value="${esc(state.placeKeywords)}" placeholder="如：海边网红民宿" maxlength="60" />
            </label>
            <button type="button" class="btn btn-outline btn-sm tt-query-place" ${state.placeLookupBusy ? 'disabled' : ''}>${state.placeLookupBusy ? '查询中…' : '查一下目的地'}</button>
            ${state.placeCandidates.length ? `
              <div class="od-place-candidates">
                ${state.placeCandidates.map((c) => `<button type="button" class="od-place-candidate" data-place-pick="${esc(c.name)}"><strong>${esc(c.name)}</strong>${c.address ? `<small>${esc(c.address)}</small>` : ''}</button>`).join('')}
              </div>
            ` : ''}
            ${state.placeMaterial ? `<div class="od-place-material">${esc(state.placeMaterial)}</div>` : ''}
          </div>
          ` : ''}
          <label class="api-field">
            <span class="api-field-label">开场白（可选）</span>
            <textarea class="form-input tt-opening" rows="2" placeholder="留空由TA自然开口；也可以写下出发那一刻的画面">${esc(state.openingLine)}</textarea>
          </label>
          <button type="button" class="off-more-toggle" data-toggle-more>${moreOpen ? '收起更多设置 ▲' : '更多设置（视角 / 字数 / 生图……）▼'}</button>
          <div class="off-more-fields" ${moreOpen ? '' : 'hidden'}>
            ${scenePresetBarHtml(scenePresets, selectedPresetId)}
            ${sceneMechanicsFieldsHtml(mechanicsBase, state.anonMemoryInject, { worldBookOptions, presetOptions })}
          </div>
        </section>
      </main>
      <footer class="od-footer">
        <button type="button" class="btn btn-primary od-start" ${picked.length ? '' : 'disabled'}>出发</button>
      </footer>
    `;

    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    bindCommitSearch({
      input: container.querySelector('.od-search-input'),
      trigger: container.querySelector('[data-search-submit]'),
      onCommit: (value) => {
        syncStateFromInputs();
        state.query = value;
        paint();
      },
    });
    container.querySelector('.tt-form')?.addEventListener('input', () => {
      syncStateFromInputs();
      saveDraft();
    });
    container.querySelector('.tt-form')?.addEventListener('change', () => {
      syncStateFromInputs();
      saveDraft();
    });
    container.querySelectorAll('.od-char').forEach((row) => {
      row.addEventListener('click', () => {
        syncStateFromInputs();
        toggleSelected(row.getAttribute('data-id'));
        saveDraft();
        paint();
      });
    });
    container.querySelector('[data-toggle-more]')?.addEventListener('click', () => {
      syncStateFromInputs();
      saveDraft();
      const opening = !moreOpen;
      moreOpen = opening;
      if (opening) {
        Promise.all([
          listOfflinePresetOptions().catch(() => null),
          listOfflineScenePresets(user.id).catch(() => null),
        ]).then(([freshStyles, freshScenePresets]) => {
          if (Array.isArray(freshStyles)) presetOptions = freshStyles;
          if (Array.isArray(freshScenePresets)) scenePresets = freshScenePresets;
          if (moreOpen) paint();
        });
      }
      paint();
    });
    bindMechanicsCommonControls(container, {
      onApplyPreset: (id) => {
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
    container.querySelector('.od-start')?.addEventListener('click', onStart);
    container.querySelector('.tt-query-place')?.addEventListener('click', onQueryPlace);
    container.querySelectorAll('[data-place-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncStateFromInputs();
        state.destination = btn.getAttribute('data-place-pick') || state.destination;
        saveDraft();
        paint();
      });
    });
    restoreElementScrollState(container, '.od-scroll', scrollState);
  }

  async function onStart() {
    const picked = selectedChars();
    if (!picked.length) {
      showToast('请先选择同行的角色');
      return;
    }
    syncStateFromInputs();
    saveDraft();
    const btn = container.querySelector('.od-start');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '准备中...';
    }
    try {
      const group_name = picked.map((c) => c.customNickname || c.name || 'TA').join('、').slice(0, 30);
      const resolved = await resolve_offline_chat_for_participants({
        user_id: user.id,
        characters: picked,
        group_name,
        location: state.destination,
        encounter_label: state.destination || state.theme || '一起旅行',
      });
      const chat = resolved.chat;
      // Re-enter the unfinished route instead of replacing its progress.
      const existingSession = resolved.session || await loadOfflineSession(chat.id);
      if (existingSession) {
        showToast('继续上次未收纳的旅行');
        navigate('offline', { chatId: chat.id });
        return;
      }
      chat.metadata = {
        ...(chat.metadata || {}),
        anonymousMemoryInject: state.anonMemoryInject,
      };
      await saveChat(chat);
      const mech = readMechanicsFromInputs(container, mechanicsBase);
      // 多日行程才值得预生成完整攻略；单日出行走原来的纯即兴推进即可。
      let itinerary = null;
      if (state.durationDays > 1) {
        if (btn) btn.textContent = '规划行程中…';
        itinerary = await planTogetherTripItinerary({
          destination: state.destination,
          theme: state.theme,
          durationDays: state.durationDays,
          placeKeywords: state.placeKeywords,
          characters: picked,
          user,
        }).catch((err) => {
          console.warn('[together-trip] plan itinerary failed', err);
          return null;
        });
      }
      const scene = createSceneDraft({
        ...mech,
        openingLine: state.openingLine,
        place: itinerary?.destination || state.destination,
        goal: state.theme,
        tone: mech.tone || state.theme,
        activityKind: 'trip',
        durationDays: state.durationDays,
        dayIndex: 0,
        placeKeywords: state.placeKeywords,
        placeMaterial: state.placeMaterial,
        itinerary,
      });
      await startOfflineSession({
        chatId: chat.id,
        userId: user.id,
        scene,
        originSeed: {
          from: 'user',
          place: itinerary?.destination || state.destination,
          activity: state.theme,
          note: '',
          timeLabel: `${state.durationDays} 天行程`,
          routeSummary: itinerary?.routeSummary || '',
        },
      });
      navigate('offline', { chatId: chat.id, justStarted: '1' });
    } catch (err) {
      showToast(String(err?.message || err));
      if (btn) {
        btn.disabled = false;
        btn.textContent = '出发';
      }
    }
  }

  paint();
}
