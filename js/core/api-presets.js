import * as db from './db.js';
import * as api from './api.js';
import { loadWebSearchConfig, saveWebSearchConfig } from './web-search-tools.js';
import { loadAmapConfig, saveAmapConfig } from './amap-tools.js';
import { loadImageToolConfig, saveImageToolConfig } from './image-generation-tools.js';
import { loadVoiceToolConfig, saveVoiceToolConfig } from './voice-tools.js';
import { loadEmbeddingConfig, saveEmbeddingConfig } from './embedding-tools.js';

export const API_PRESET_LIBRARY_KEY = 'apiPresetLibrary';
export const LEGACY_PROFILES_KEY = 'apiConfigProfiles';
export const API_SETTINGS_EXPORT_TYPE = 'marshmallow-phone.api-settings';
export const API_SETTINGS_EXPORT_VERSION = 2;

export const API_SECTIONS = [
  { id: 'main', label: '聊天模型' },
  { id: 'scene', label: '场景叙事' },
  { id: 'tool', label: '工具模型' },
  { id: 'embedding', label: '向量模型' },
  { id: 'search', label: '搜索' },
  { id: 'map', label: '地图' },
  { id: 'voice', label: '语音' },
  { id: 'image', label: '生图' },
];

const SECTION_IDS = API_SECTIONS.map((s) => s.id);

const EMPTY_LIBRARY = () => ({
  version: 2,
  sectionPresets: Object.fromEntries(SECTION_IDS.map((id) => [id, []])),
  comboPresets: [],
  activeComboId: '',
  activeSectionPresetIds: Object.fromEntries(SECTION_IDS.map((id) => [id, ''])),
});

function slugId(name = '', prefix = 'preset') {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '')
    .slice(0, 48);
  return base || `${prefix}-${Date.now()}`;
}

/**
 * API 预设属于用户主动保存的配置，不能像临时历史记录一样按条数静默淘汰。
 * 同 id / 同名仍视为覆盖，其余项目完整保留，最终只受浏览器实际存储空间约束。
 */
export function mergeApiPresetEntry(list = [], entry = {}) {
  return [
    entry,
    ...(Array.isArray(list) ? list : []).filter((item) => (
      item?.id !== entry?.id && item?.name !== entry?.name
    )),
  ];
}

function normalizeSectionPresets(input = {}) {
  const out = {};
  for (const id of SECTION_IDS) {
    out[id] = Array.isArray(input[id])
      ? input[id].filter((item) => item && item.id && item.name && item.value)
      : [];
  }
  return out;
}

function normalizeActiveSectionPresetIds(input = {}) {
  const out = Object.fromEntries(SECTION_IDS.map((id) => [id, '']));
  if (!input || typeof input !== 'object') return out;
  for (const id of SECTION_IDS) {
    out[id] = String(input[id] || '').trim();
  }
  return out;
}

function normalizeLibrary(raw) {
  const base = EMPTY_LIBRARY();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: 2,
    sectionPresets: normalizeSectionPresets(raw.sectionPresets),
    comboPresets: Array.isArray(raw.comboPresets)
      ? raw.comboPresets.filter((item) => item && item.id && item.name)
      : [],
    activeComboId: String(raw.activeComboId || ''),
    activeSectionPresetIds: normalizeActiveSectionPresetIds(raw.activeSectionPresetIds),
  };
}

async function migrateLegacyProfiles(library) {
  const row = await db.get('settings', LEGACY_PROFILES_KEY);
  const legacy = Array.isArray(row?.value) ? row.value : [];
  if (!legacy.length) return library;
  const next = normalizeLibrary(library);
  for (const item of legacy) {
    if (!item?.name) continue;
    const snapshot = item.value || item.config;
    if (!snapshot || typeof snapshot !== 'object') continue;
    const exists = next.comboPresets.some((c) => c.id === item.id || c.name === item.name);
    if (exists) continue;
    next.comboPresets.push({
      id: item.id || slugId(item.name, 'combo'),
      name: item.name,
      mode: 'snapshot',
      snapshot: {
        main: snapshot.main || {},
        scene: snapshot.scene || {},
        tool: snapshot.tool || {},
        embedding: snapshot.embedding || {},
        search: snapshot.webSearch || snapshot.search || {},
        map: snapshot.amap || snapshot.map || {},
        voice: snapshot.voiceTool || snapshot.voice || {},
        image: snapshot.imageTool || snapshot.image || {},
      },
      createdAt: item.createdAt || Date.now(),
      updatedAt: item.updatedAt || Date.now(),
    });
  }
  return next;
}

export async function loadPresetLibrary() {
  const row = await db.get('settings', API_PRESET_LIBRARY_KEY);
  let lib = normalizeLibrary(row?.value);
  if (!row?.value || row.value.version !== 2) {
    lib = await migrateLegacyProfiles(lib);
    await savePresetLibrary(lib);
  }
  return lib;
}

export async function savePresetLibrary(library) {
  const next = normalizeLibrary(library);
  await db.put({ key: API_PRESET_LIBRARY_KEY, value: next });
  return next;
}

export async function loadAllActiveConfigs() {
  const [main, scene, tool, embedding, search, map, image, voice] = await Promise.all([
    api.getConfig(),
    api.getSceneConfig(),
    api.getToolConfig(),
    loadEmbeddingConfig(),
    loadWebSearchConfig(),
    loadAmapConfig(),
    loadImageToolConfig(),
    loadVoiceToolConfig(),
  ]);
  return { main, scene, tool, embedding, search, map, image, voice };
}

export function buildSnapshotFromState(state = {}) {
  return {
    main: { ...(state.main || {}) },
    scene: { ...(state.scene || {}) },
    tool: { ...(state.tool || {}) },
    embedding: { ...(state.embedding || {}) },
    search: { ...(state.search || {}) },
    map: { ...(state.map || {}) },
    voice: { ...(state.voice || {}) },
    image: { ...(state.image || {}) },
  };
}

export async function applySnapshot(snapshot = {}) {
  const tasks = [];
  if (snapshot.main) tasks.push(api.saveConfig({ ...snapshot.main }));
  if (snapshot.scene) tasks.push(api.saveSceneConfig({ ...snapshot.scene }));
  if (snapshot.tool) tasks.push(api.saveToolConfig({ ...snapshot.tool }));
  if (snapshot.embedding) tasks.push(saveEmbeddingConfig({ ...snapshot.embedding }));
  if (snapshot.search) tasks.push(saveWebSearchConfig({ ...snapshot.search }));
  if (snapshot.map) tasks.push(saveAmapConfig({ ...snapshot.map }));
  if (snapshot.voice) tasks.push(saveVoiceToolConfig({ ...snapshot.voice }));
  if (snapshot.image) tasks.push(saveImageToolConfig({ ...snapshot.image }));
  await Promise.all(tasks);
}

export function getSectionValueFromState(state = {}, sectionId = '') {
  return state?.[sectionId] || {};
}

export async function saveSectionPreset(sectionId, name, value) {
  if (!SECTION_IDS.includes(sectionId)) throw new Error('未知 API 分类');
  const label = String(name || '').trim();
  if (!label) throw new Error('请填写预设名称');
  const lib = await loadPresetLibrary();
  const now = Date.now();
  const id = slugId(label, sectionId);
  const entry = {
    id,
    name: label,
    value: { ...(value || {}) },
    createdAt: now,
    updatedAt: now,
  };
  lib.sectionPresets[sectionId] = mergeApiPresetEntry(lib.sectionPresets[sectionId], entry);
  await savePresetLibrary(lib);
  return entry;
}

export function getActiveSectionPreset(library = {}, sectionId = '') {
  const presetId = String(library?.activeSectionPresetIds?.[sectionId] || '').trim();
  if (!presetId) return null;
  return (library.sectionPresets?.[sectionId] || []).find((item) => item.id === presetId) || null;
}

export function getActiveSectionPresetLabel(library = {}, sectionId = '') {
  const preset = getActiveSectionPreset(library, sectionId);
  return preset?.name || '';
}

function pickComparableSectionConfig(presetValue = {}, liveConfig = {}) {
  const keys = Object.keys(presetValue || {});
  if (!keys.length) return null;
  const a = {};
  const b = {};
  for (const key of keys) {
    a[key] = presetValue[key];
    b[key] = liveConfig?.[key];
  }
  return { a, b };
}

export function findMatchingSectionPreset(library = {}, sectionId = '', config = {}) {
  const presets = library.sectionPresets?.[sectionId] || [];
  for (const preset of presets) {
    const picked = pickComparableSectionConfig(preset.value, config);
    if (!picked) continue;
    if (JSON.stringify(picked.a) === JSON.stringify(picked.b)) return preset;
  }
  return null;
}

/** 解析某分类当前应对外展示的预设名（含组合引用、快照组合、自动匹配） */
export function resolveSectionActiveDisplay(library = {}, sectionId = '', config = {}) {
  const activeCombo = getActiveCombo(library);
  if (activeCombo?.mode === 'snapshot') {
    return { name: activeCombo.name, kind: 'combo-snapshot' };
  }
  if (activeCombo?.mode === 'reference') {
    const presetId = String(activeCombo.refs?.[sectionId] || '').trim();
    if (presetId) {
      const preset = (library.sectionPresets?.[sectionId] || []).find((item) => item.id === presetId);
      if (preset) return { name: preset.name, kind: 'combo-ref' };
    }
  }
  const activePreset = getActiveSectionPreset(library, sectionId);
  if (activePreset) return { name: activePreset.name, kind: 'preset' };
  const matched = findMatchingSectionPreset(library, sectionId, config);
  if (matched) return { name: matched.name, kind: 'matched' };
  if (sectionId === 'scene' && !config?.useCustom) {
    return { name: '跟随聊天模型', kind: 'scene-follow' };
  }
  const model = String(
    sectionId === 'voice' && config?.provider === 'fish'
      ? config?.fish?.model
      : config?.model,
  ).trim();
  if (model) return { name: model, kind: 'model' };
  return { name: '未绑定预设', kind: 'none' };
}

export async function syncSectionActivePreset(sectionId, config = {}, { clearCombo = true } = {}) {
  if (!SECTION_IDS.includes(sectionId)) return null;
  const lib = await loadPresetLibrary();
  const matched = findMatchingSectionPreset(lib, sectionId, config);
  lib.activeSectionPresetIds = normalizeActiveSectionPresetIds(lib.activeSectionPresetIds);
  lib.activeSectionPresetIds[sectionId] = matched?.id || '';
  if (clearCombo) lib.activeComboId = '';
  await savePresetLibrary(lib);
  return matched;
}

/**
 * 页面初始化时一次性校准全部分类的活动预设。
 * 旧实现由调用方并发执行 8 次 syncSectionActivePreset，导致同一份预设库被重复
 * 读取和完整写回；原生壳还会把这些写入逐条镜像到原生存储。这里统一成一次读、
 * 一次比对、最多一次写，顺便避免并发写覆盖其它分类刚算出的 active id。
 */
export async function syncAllSectionActivePresets(state = {}, { clearCombo = false } = {}) {
  const lib = await loadPresetLibrary();
  const nextActiveIds = normalizeActiveSectionPresetIds(lib.activeSectionPresetIds);
  let changed = false;

  for (const sectionId of SECTION_IDS) {
    const matched = findMatchingSectionPreset(lib, sectionId, state?.[sectionId] || {});
    const nextId = matched?.id || '';
    if (nextActiveIds[sectionId] === nextId) continue;
    nextActiveIds[sectionId] = nextId;
    changed = true;
  }

  if (clearCombo && lib.activeComboId) {
    lib.activeComboId = '';
    changed = true;
  }
  lib.activeSectionPresetIds = nextActiveIds;
  if (changed) await savePresetLibrary(lib);
  return lib;
}

export function getActiveCombo(library = {}) {
  const comboId = String(library?.activeComboId || '').trim();
  if (!comboId) return null;
  return (library.comboPresets || []).find((item) => item.id === comboId) || null;
}

async function markActiveSectionPreset(sectionId, presetId = '') {
  const lib = await loadPresetLibrary();
  lib.activeSectionPresetIds = normalizeActiveSectionPresetIds(lib.activeSectionPresetIds);
  lib.activeSectionPresetIds[sectionId] = String(presetId || '').trim();
  lib.activeComboId = '';
  await savePresetLibrary(lib);
}

async function clearActiveSectionPreset(sectionId) {
  const lib = await loadPresetLibrary();
  lib.activeSectionPresetIds = normalizeActiveSectionPresetIds(lib.activeSectionPresetIds);
  lib.activeSectionPresetIds[sectionId] = '';
  lib.activeComboId = '';
  await savePresetLibrary(lib);
}

export async function deleteSectionPreset(sectionId, presetId) {
  const lib = await loadPresetLibrary();
  lib.sectionPresets[sectionId] = (lib.sectionPresets[sectionId] || []).filter((item) => item.id !== presetId);
  if (lib.activeSectionPresetIds?.[sectionId] === presetId) {
    lib.activeSectionPresetIds[sectionId] = '';
  }
  await savePresetLibrary(lib);
}

export async function applySectionPreset(sectionId, presetId) {
  const lib = await loadPresetLibrary();
  const preset = (lib.sectionPresets[sectionId] || []).find((item) => item.id === presetId);
  if (!preset) throw new Error('预设不存在');
  const snapshot = { [sectionId]: preset.value };
  await applySnapshot(snapshot);
  lib.activeSectionPresetIds = normalizeActiveSectionPresetIds(lib.activeSectionPresetIds);
  lib.activeSectionPresetIds[sectionId] = String(presetId || '').trim();
  lib.activeComboId = '';
  await savePresetLibrary(lib);
  return preset;
}

/** 线下相遇、旅行 char、时光机等叙事场景 API；未单独配置时返回 null（跟随聊天模型） */
export async function resolveSceneApiConfig() {
  const scene = await api.getSceneConfig();
  if (!scene?.useCustom) return null;
  const main = await api.getConfig();
  return {
    ...main,
    ...scene,
    // 兼容消息形态是全局选择，不让旧版场景预设里的遗留字段暗中改变它。
    singleUserCompat: main.singleUserCompat === true,
  };
}

export async function clearSectionActivePreset(sectionId) {
  if (!SECTION_IDS.includes(sectionId)) return;
  await clearActiveSectionPreset(sectionId);
}

export async function setActiveSectionPreset(sectionId, presetId = '') {
  if (!SECTION_IDS.includes(sectionId)) return;
  await markActiveSectionPreset(sectionId, presetId);
}

/** 供快捷入口展示指定分类的 API 预设列表（名称 + 模型） */
export async function listApiSectionPresetOptions(sectionId) {
  if (!SECTION_IDS.includes(sectionId)) return [];
  const lib = await loadPresetLibrary();
  return (lib.sectionPresets[sectionId] || []).map((item) => ({
    id: item.id,
    name: item.name,
    model: String(item.value?.model || '').trim(),
  }));
}

/** 只读取某个已保存 API 档位供单次实验调用，不切换全局活动档位。 */
export async function resolveApiSectionPresetConfig(sectionId, presetId = '') {
  if (!SECTION_IDS.includes(sectionId)) return null;
  const id = String(presetId || '').trim();
  if (!id) return null;
  const lib = await loadPresetLibrary();
  const preset = (lib.sectionPresets?.[sectionId] || []).find((item) => String(item?.id || '') === id);
  return preset?.value ? { ...preset.value } : null;
}

/** 供聊天设置页展示可选的「聊天模型」预设列表（渠道 + 模型） */
export async function listMainApiPresetOptions() {
  return listApiSectionPresetOptions('main');
}

/** 单聊/群聊按 chatPrefs.mainApiPresetId 覆盖全局聊天模型；未选或预设已被删除时返回 null（跟随全局） */
export async function resolveChatMainApiOverride(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const { loadChatPrefs } = await import('./chat-block-state.js');
  const prefs = await loadChatPrefs(id).catch(() => ({}));
  const presetId = String(prefs?.mainApiPresetId || '').trim();
  if (!presetId) return null;
  const lib = await loadPresetLibrary();
  const preset = (lib.sectionPresets.main || []).find((item) => item.id === presetId);
  if (!preset?.value) return null;
  return { ...preset.value };
}

export async function saveComboPreset({ name, mode = 'reference', refs = {}, snapshot = null }) {
  const label = String(name || '').trim();
  if (!label) throw new Error('请填写组合名称');
  const lib = await loadPresetLibrary();
  const now = Date.now();
  const id = slugId(label, 'combo');
  const entry = {
    id,
    name: label,
    mode: mode === 'snapshot' ? 'snapshot' : 'reference',
    refs: {},
    snapshot: null,
    createdAt: now,
    updatedAt: now,
  };
  if (entry.mode === 'snapshot') {
    entry.snapshot = snapshot || buildSnapshotFromState(await loadAllActiveConfigs());
  } else {
    for (const sectionId of SECTION_IDS) {
      const ref = refs[sectionId];
      if (ref) entry.refs[sectionId] = String(ref);
    }
  }
  lib.comboPresets = mergeApiPresetEntry(lib.comboPresets, entry);
  lib.activeComboId = id;
  await savePresetLibrary(lib);
  return entry;
}

export async function deleteComboPreset(comboId) {
  const lib = await loadPresetLibrary();
  lib.comboPresets = lib.comboPresets.filter((item) => item.id !== comboId);
  if (lib.activeComboId === comboId) lib.activeComboId = '';
  await savePresetLibrary(lib);
}

export async function applyComboPreset(comboId) {
  const lib = await loadPresetLibrary();
  const combo = lib.comboPresets.find((item) => item.id === comboId);
  if (!combo) throw new Error('组合不存在');
  if (combo.mode === 'snapshot' && combo.snapshot) {
    await applySnapshot(combo.snapshot);
    lib.activeSectionPresetIds = normalizeActiveSectionPresetIds();
  } else {
    const snapshot = {};
    const nextActive = normalizeActiveSectionPresetIds();
    for (const sectionId of SECTION_IDS) {
      const presetId = combo.refs?.[sectionId];
      if (!presetId) {
        nextActive[sectionId] = '';
        continue;
      }
      const preset = (lib.sectionPresets[sectionId] || []).find((item) => item.id === presetId);
      if (preset?.value) {
        snapshot[sectionId] = preset.value;
        nextActive[sectionId] = presetId;
      }
    }
    if (!Object.keys(snapshot).length) throw new Error('组合未绑定任何分类预设');
    await applySnapshot(snapshot);
    lib.activeSectionPresetIds = nextActive;
  }
  lib.activeComboId = comboId;
  await savePresetLibrary(lib);
  return combo;
}

export function summarizeCombo(combo = {}, library = {}) {
  if (combo.mode === 'snapshot' && combo.snapshot) {
    const s = combo.snapshot;
    return [
      s.main?.model ? `聊天 ${s.main.model}` : '',
      s.scene?.useCustom && s.scene?.model ? `场景 ${s.scene.model}` : '',
      s.tool?.model ? `工具 ${s.tool.model}` : '',
      s.search?.enabled ? '搜索开' : '',
      s.map?.enabled ? '地图开' : '',
      s.voice?.enabled ? '语音开' : '',
      (s.image?.characterProvider !== 'off' || s.image?.realisticProvider !== 'off') ? '生图开' : '',
    ].filter(Boolean).join(' · ') || '完整快照';
  }
  const parts = [];
  for (const section of API_SECTIONS) {
    const presetId = combo.refs?.[section.id];
    if (!presetId) continue;
    const preset = (library.sectionPresets?.[section.id] || []).find((item) => item.id === presetId);
    if (preset) parts.push(`${section.label}:${preset.name}`);
  }
  return parts.join(' · ') || '引用组合（未绑定）';
}

export async function exportApiSettingsPayload(state) {
  const library = await loadPresetLibrary();
  return {
    type: API_SETTINGS_EXPORT_TYPE,
    version: API_SETTINGS_EXPORT_VERSION,
    exportedAt: Date.now(),
    warning: '包含 API Key 与服务地址，请只导入到可信设备。',
    active: buildSnapshotFromState(state),
    library,
  };
}

export async function importApiSettingsPayload(payload = {}) {
  if (payload?.type !== API_SETTINGS_EXPORT_TYPE) {
    throw new Error('不是棉花糖机 API 设置导出文件');
  }
  if (payload.active) await applySnapshot(payload.active);
  if (payload.library) await savePresetLibrary(payload.library);
  if (Array.isArray(payload.profiles)) {
    const lib = await loadPresetLibrary();
    for (const item of payload.profiles) {
      if (!item?.name || !item?.value) continue;
      lib.comboPresets.unshift({
        id: item.id || slugId(item.name, 'combo'),
        name: item.name,
        mode: 'snapshot',
        snapshot: {
          main: item.value.main || {},
          scene: item.value.scene || {},
          tool: item.value.tool || {},
          search: item.value.webSearch || item.value.search || {},
          map: item.value.amap || item.value.map || {},
          voice: item.value.voiceTool || item.value.voice || {},
          image: item.value.imageTool || item.value.image || {},
        },
        createdAt: item.createdAt || Date.now(),
        updatedAt: item.updatedAt || Date.now(),
      });
    }
    await savePresetLibrary(lib);
  }
}
