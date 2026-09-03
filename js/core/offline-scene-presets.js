/**
 * 线下「叙事设置」命名预设：视角/人称/字数/轮数/生图/语音/上下文等机制参数。
 * 地点、一起做什么、开场白等内容每次现场填，不进预设，也不进页草稿自动带回。
 */
import * as db from './db.js';

function storeKey(userId) {
  return `offlineScenePresets_${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function lastSelectedKey(userId) {
  return `offlineScenePresetLast_${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function genId() {
  return `osp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 会写入命名预设的机制字段（不含地点/开场/同行者等会话内容）。 */
export const OFFLINE_SCENE_PRESET_FIELDS = [
  'tone',
  'wordMin', 'wordMax', 'rounds', 'optionCards', 'blockUserSpeech', 'innerVoiceEnabled',
  'innerVoicePreferenceTouched', 'naturalEnsemble',
  'dialogueMode', 'noParaphrase', 'directorMode', 'perspective', 'person',
  'audioSceneLayout', 'audioStageSoundEnabled', 'audioStageActionVolume', 'audioStageBackgroundVolume',
  'imageGenMode', 'imageStyleId', 'autoImagePerBeat', 'imagePromptTemplate', 'ttsEnabled', 'contextDepth',
  'autoSummaryEvery', 'perBeatDigestEnabled', 'worldBookIds', 'presetStyleIds',
];

const PRESET_FIELDS = OFFLINE_SCENE_PRESET_FIELDS;

/** 从任意对象挑出可存进命名预设的机制字段（跳过 undefined）。 */
export function pickOfflineScenePresetFields(source = {}) {
  const fields = {};
  for (const key of PRESET_FIELDS) {
    if (source?.[key] !== undefined) fields[key] = source[key];
  }
  return fields;
}

/**
 * 进页套用顺序：草稿里已有的机制参数优先；缺口再用「上次使用的命名预设」补齐。
 * 地点/开场等当场内容不进命名预设，也不从草稿自动带回（换人/新开应清空）。
 * @returns {{ selectedPresetId: string, lastPreset: object|null, mechanicsSeed: object }}
 */
export function resolveOfflineSceneMechanicsSeed({
  presets = [],
  lastPresetId = '',
  draft = {},
} = {}) {
  const draftObj = draft && typeof draft === 'object' ? draft : {};
  const draftMechanics = pickOfflineScenePresetFields(draftObj);
  const selectedPresetId = String(lastPresetId || '').trim();
  const lastPreset = selectedPresetId
    ? (presets.find((p) => p && p.id === selectedPresetId) || null)
    : null;
  if (lastPreset) {
    return {
      selectedPresetId: lastPreset.id,
      lastPreset,
      // 预设打底 → 草稿机制覆盖：改完字数/生图等不必再点「保存到所选」也能下次沿用。
      mechanicsSeed: {
        ...pickOfflineScenePresetFields(lastPreset),
        ...draftMechanics,
      },
    };
  }
  return {
    selectedPresetId: '',
    lastPreset: null,
    mechanicsSeed: draftMechanics,
  };
}

export async function listOfflineScenePresets(userId) {
  const row = await db.get('settings', storeKey(userId));
  const list = Array.isArray(row?.value) ? row.value : [];
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getLastOfflineScenePresetId(userId) {
  const row = await db.get('settings', lastSelectedKey(userId)).catch(() => null);
  return String(row?.value || '').trim();
}

/** 自动建场入口使用：读取上次选中的命名预设机制；无有效预设时返回空对象。 */
export async function loadLastOfflineScenePresetFields(userId) {
  const [presets, presetId] = await Promise.all([
    listOfflineScenePresets(userId).catch(() => []),
    getLastOfflineScenePresetId(userId).catch(() => ''),
  ]);
  const preset = presetId ? presets.find((item) => item?.id === presetId) : null;
  return preset ? pickOfflineScenePresetFields(preset) : {};
}

export async function setLastOfflineScenePresetId(userId, presetId = '') {
  const id = String(presetId || '').trim();
  await db.put('settings', { key: lastSelectedKey(userId), value: id });
  return id;
}

export async function saveOfflineScenePreset(userId, preset = {}) {
  const list = await listOfflineScenePresets(userId);
  const id = String(preset.id || '').trim() || genId();
  const prev = list.find((p) => p.id === id) || {};
  const name = String(preset.name || prev.name || '').trim().slice(0, 30) || '未命名预设';
  // 覆盖保存时只写入本次显式带上的字段，其余机制字段沿用旧预设，避免时光机只存字数时冲掉生图画风等。
  const fields = { ...pickOfflineScenePresetFields(prev), ...pickOfflineScenePresetFields(preset) };
  const next = { id, name, ...fields, updatedAt: Date.now() };
  const merged = [next, ...list.filter((p) => p.id !== id)].slice(0, 40);
  await db.put('settings', { key: storeKey(userId), value: merged });
  await setLastOfflineScenePresetId(userId, id).catch(() => {});
  return next;
}

export async function deleteOfflineScenePreset(userId, presetId) {
  const id = String(presetId || '').trim();
  const list = await listOfflineScenePresets(userId);
  const next = list.filter((p) => p.id !== id);
  await db.put('settings', { key: storeKey(userId), value: next });
  const last = await getLastOfflineScenePresetId(userId).catch(() => '');
  if (last === id) await setLastOfflineScenePresetId(userId, '').catch(() => {});
  return next;
}
