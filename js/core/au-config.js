import { AU_PRESETS } from '../data/au-presets.js';
import * as db from './db.js';

export const AU_CATEGORY_ORDER = ['基础规则', '特殊身份', '世界背景', '关系设定', '补充设定'];

const MARSHMALLOW_AU_VERSION = 3;
const AU_RESOURCE_LIBRARY_KEY = 'auResourceLibrary:v1';
const AU_WORLD_CONFIG_PREFIX = 'auWorldConfig:v1:';
const AU_SCOPE_MIGRATION_KEY = 'auResourceScopeMigration:v1';
let auScopeMigrationPromise = null;

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeAuCategory(category, fallback = '补充设定') {
  const value = String(category || '').trim();
  return AU_CATEGORY_ORDER.includes(value) ? value : (value || fallback);
}

export function createAuEntry(input = {}) {
  return {
    id: String(input.id || '').trim() || makeId('au'),
    name: String(input.name || '').trim() || '未命名设定',
    category: normalizeAuCategory(input.category),
    kind: String(input.kind || 'custom').trim() || 'custom',
    content: String(input.content || '').trim(),
    enabled: input.enabled !== false,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
    // 特殊设定统一作为强覆盖层：只覆盖冲突的身份、世界背景与规则，
    // 人物性格、口吻和关系底色仍由角色卡提供。
    strongOverride: true,
    sourcePresetId: input.sourcePresetId ? String(input.sourcePresetId) : '',
  };
}

function createScheme(input = {}) {
  return {
    id: String(input.id || '').trim() || makeId('auscheme'),
    name: String(input.name || '').trim() || '默认方案',
    entryIds: Array.isArray(input.entryIds) ? [...new Set(input.entryIds.filter(Boolean))] : [],
    notes: String(input.notes || '').trim(),
  };
}

function createPresetEntries() {
  return AU_PRESETS.map((preset) => createAuEntry({
    id: `preset_${preset.id}`,
    name: preset.name,
    category: normalizeAuCategory(preset.category, '世界背景'),
    kind: 'preset',
    content: preset.worldBookOverlay,
    enabled: true,
    priority: Number.isFinite(Number(preset.priority)) ? preset.priority : 10,
    strongOverride: preset.strongOverride === true,
    sourcePresetId: preset.id,
  }));
}

function buildLegacyEntries(user) {
  const entries = createPresetEntries();
  const activeEntryIds = [];
  const addActive = (id) => {
    if (id && !activeEntryIds.includes(id)) activeEntryIds.push(id);
  };

  const presetId = String(user?.auPreset || '').trim();
  if (presetId && presetId !== 'au-custom') {
    const hit = entries.find((item) => item.id === `preset_${presetId}` || item.sourcePresetId === presetId);
    if (hit) addActive(hit.id);
  }

  const customText = String(user?.auCustom || '').trim();
  if (customText) {
    entries.push(createAuEntry({
      id: 'legacy_custom',
      name: '自定义补充设定',
      category: '补充设定',
      kind: 'custom',
      content: customText,
      enabled: true,
      priority: 50,
    }));
    addActive('legacy_custom');
  }

  return { entries, activeEntryIds };
}

function stripLegacyFactionFields(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const next = { ...raw };
  delete next.factionConfigs;
  delete next.characterMappings;
  delete next.effectiveFactionConfigId;
  if (Array.isArray(next.schemes)) {
    next.schemes = next.schemes.map((scheme) => {
      const s = { ...scheme };
      delete s.factionConfigId;
      return s;
    });
  }
  return next;
}

export function normalizeAuConfig(user) {
  const raw = stripLegacyFactionFields(user?.auConfig && typeof user.auConfig === 'object' ? user.auConfig : {});
  const legacyBase = buildLegacyEntries(user);
  const seen = new Set();
  const entries = [];

  const addEntry = (entry) => {
    if (!entry?.id || seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(createAuEntry(entry));
  };

  const sourceEntries = Array.isArray(raw.entries) && raw.entries.length ? raw.entries : legacyBase.entries;
  sourceEntries.forEach(addEntry);
  legacyBase.entries.forEach(addEntry);

  const activeEntryIds = [...new Set(
    (Array.isArray(raw.activeEntryIds) && raw.activeEntryIds.length ? raw.activeEntryIds : legacyBase.activeEntryIds)
      .filter((id) => entries.some((entry) => entry.id === id)),
  )];

  let schemes = Array.isArray(raw.schemes) && raw.schemes.length
    ? raw.schemes.map((scheme) => createScheme(scheme)).map((scheme) => ({
      ...scheme,
      entryIds: scheme.entryIds.filter((id) => entries.some((entry) => entry.id === id)),
    }))
    : [];

  if (!schemes.length) {
    schemes.push(createScheme({
      id: 'scheme_default',
      name: '当前方案',
      entryIds: activeEntryIds.length ? activeEntryIds : [],
    }));
  }

  const selectedSchemeId = schemes.some((scheme) => scheme.id === raw.selectedSchemeId)
    ? raw.selectedSchemeId
    : schemes[0].id;
  const selectedScheme = schemes.find((scheme) => scheme.id === selectedSchemeId) || schemes[0];
  const effectiveActiveEntryIds = [...new Set(
    (selectedScheme.entryIds?.length ? selectedScheme.entryIds : activeEntryIds)
      .filter((id) => entries.some((entry) => entry.id === id)),
  )];

  return {
    version: MARSHMALLOW_AU_VERSION,
    entries,
    activeEntryIds: effectiveActiveEntryIds,
    schemes,
    selectedSchemeId: selectedScheme.id,
  };
}

export function getSelectedAuScheme(config) {
  return config?.schemes?.find((scheme) => scheme.id === config?.selectedSchemeId) || config?.schemes?.[0] || null;
}

/**
 * 删除方案；至少保留一个方案。若删的是当前方案，自动切到剩余的第一个。
 */
export function deleteAuScheme(config, schemeId) {
  const id = String(schemeId || '').trim();
  if (!id || !config) return { ok: false, reason: 'missing' };
  const schemes = Array.isArray(config.schemes) ? config.schemes : [];
  if (schemes.length <= 1) return { ok: false, reason: 'last-scheme' };
  if (!schemes.some((scheme) => scheme.id === id)) return { ok: false, reason: 'not-found' };

  const nextSchemes = schemes.filter((scheme) => scheme.id !== id);
  const selectedScheme = id === config.selectedSchemeId
    ? nextSchemes[0]
    : (nextSchemes.find((scheme) => scheme.id === config.selectedSchemeId) || nextSchemes[0]);

  return {
    ok: true,
    config: {
      ...config,
      schemes: nextSchemes,
      selectedSchemeId: selectedScheme.id,
      activeEntryIds: [...(selectedScheme.entryIds || [])],
    },
  };
}

export function getActiveAUEntries(user) {
  const config = normalizeAuConfig(user);
  const activeSet = new Set(config.activeEntryIds);
  return config.entries
    .filter((entry) => entry.enabled !== false && activeSet.has(entry.id))
    .sort((a, b) => (a.priority || 0) - (b.priority || 0) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
}

export function hasStrongAU(user) {
  return getActiveAUEntries(user).some((entry) => entry.strongOverride === true);
}

/** 注入 chatDirectives / 社交生成 · 不单独建 registry 层 */
export function buildAuPromptBlock(user) {
  const entries = getActiveAUEntries(user);
  if (!entries.length) return '';

  const parts = [
    '【特殊设定·强覆盖】以下为用户当前启用的架空/附加规则，优先级高于默认世界观与角色卡中的默认身份、职业、生理及社会规则；冲突部分必须以特殊设定为准。保留角色原有性格、口吻、关系与情感底色，并在此基础上按特殊设定重新解释人物；不要把角色强行拉回默认语境。',
  ];

  entries.forEach((entry) => {
    if (!entry.content) return;
    parts.push(`[${entry.category}｜${entry.name}]\n${entry.content}`);
  });

  return parts.join('\n\n');
}

export function serializeAuConfigForUser(config) {
  return {
    version: MARSHMALLOW_AU_VERSION,
    entries: (config.entries || []).map((entry) => createAuEntry(entry)),
    activeEntryIds: [...new Set(config.activeEntryIds || [])],
    schemes: (config.schemes || []).map((scheme) => createScheme(scheme)),
    selectedSchemeId: String(config.selectedSchemeId || ''),
  };
}

function auWorldId(user = {}) {
  return String(user?.worldId || user?.slotGroupId || user?.id || '').trim();
}

function entryFingerprint(entry = {}) {
  return [entry.kind, entry.category, entry.name, entry.content]
    .map((value) => String(value || '').trim())
    .join('\u241f');
}

function mergeAuEntries(sources = []) {
  const entries = [];
  const byFingerprint = new Map();
  const usedIds = new Set();
  const idMaps = [];
  sources.forEach((source) => {
    const idMap = new Map();
    (source?.entries || []).forEach((raw) => {
      const entry = createAuEntry(raw);
      const fingerprint = entryFingerprint(entry);
      let target = byFingerprint.get(fingerprint);
      if (!target) {
        let id = entry.id;
        if (usedIds.has(id)) id = `${id}_${Math.random().toString(36).slice(2, 7)}`;
        target = { ...entry, id };
        entries.push(target);
        usedIds.add(id);
        byFingerprint.set(fingerprint, target);
      }
      idMap.set(entry.id, target.id);
    });
    idMaps.push(idMap);
  });
  return { entries, idMaps };
}

function remapAuWorldConfig(config = {}, idMap = new Map()) {
  const remapIds = (ids = []) => [...new Set((ids || [])
    .map((id) => idMap.get(String(id || '')) || String(id || ''))
    .filter(Boolean))];
  return {
    version: MARSHMALLOW_AU_VERSION,
    activeEntryIds: remapIds(config.activeEntryIds),
    schemes: (config.schemes || []).map((scheme) => ({
      ...createScheme(scheme),
      entryIds: remapIds(scheme.entryIds),
    })),
    selectedSchemeId: String(config.selectedSchemeId || ''),
  };
}

function mergeAuWorldConfigs(current = null, incoming = null) {
  if (!current) return incoming;
  if (!incoming) return current;
  const schemes = [...(current.schemes || [])];
  incoming.schemes?.forEach((scheme) => {
    const hit = schemes.find((item) => item.id === scheme.id);
    if (hit) hit.entryIds = [...new Set([...(hit.entryIds || []), ...(scheme.entryIds || [])])];
    else schemes.push(scheme);
  });
  return {
    version: MARSHMALLOW_AU_VERSION,
    schemes,
    selectedSchemeId: current.selectedSchemeId || incoming.selectedSchemeId || schemes[0]?.id || '',
    activeEntryIds: [...new Set([...(current.activeEntryIds || []), ...(incoming.activeEntryIds || [])])],
  };
}

async function ensureAuResourceScopeMigration() {
  const migrated = await db.getRecord('settings', AU_SCOPE_MIGRATION_KEY).catch(() => null);
  if (migrated?.value?.done === true) return;
  if (auScopeMigrationPromise) return auScopeMigrationPromise;
  auScopeMigrationPromise = (async () => {
    const [users, existingLibraryRow, settingsRows] = await Promise.all([
      db.getAllRecords('users').catch(() => []),
      db.getRecord('settings', AU_RESOURCE_LIBRARY_KEY).catch(() => null),
      db.getAllRecords('settings').catch(() => []),
    ]);
    const configs = users.map((user) => normalizeAuConfig(user));
    const merged = mergeAuEntries([
      { entries: Array.isArray(existingLibraryRow?.value?.entries) ? existingLibraryRow.value.entries : [] },
      ...configs,
    ]);
    const worlds = new Map();
    settingsRows.forEach((row) => {
      const key = String(row?.key || '');
      if (!key.startsWith(AU_WORLD_CONFIG_PREFIX) || !row?.value) return;
      const worldId = key.slice(AU_WORLD_CONFIG_PREFIX.length);
      if (worldId) worlds.set(worldId, remapAuWorldConfig(row.value));
    });
    users.forEach((user, index) => {
      const worldId = auWorldId(user);
      if (!worldId) return;
      const worldConfig = remapAuWorldConfig(configs[index], merged.idMaps[index + 1]);
      worlds.set(worldId, mergeAuWorldConfigs(worlds.get(worldId), worldConfig));
    });
    await db.putRecord('settings', {
      key: AU_RESOURCE_LIBRARY_KEY,
      value: { version: MARSHMALLOW_AU_VERSION, entries: merged.entries },
      updatedAt: Date.now(),
    });
    await Promise.all([...worlds.entries()].map(([worldId, value]) => db.putRecord('settings', {
      key: `${AU_WORLD_CONFIG_PREFIX}${worldId}`,
      value,
      updatedAt: Date.now(),
    })));
    await db.putRecord('settings', {
      key: AU_SCOPE_MIGRATION_KEY,
      value: { done: true, migratedAt: Date.now() },
      updatedAt: Date.now(),
    });
  })().finally(() => { auScopeMigrationPromise = null; });
  return auScopeMigrationPromise;
}

function composeStoredAuConfig(library = {}, world = {}) {
  return normalizeAuConfig({
    auConfig: {
      version: MARSHMALLOW_AU_VERSION,
      entries: Array.isArray(library.entries) ? library.entries : [],
      schemes: Array.isArray(world.schemes) ? world.schemes : [],
      activeEntryIds: Array.isArray(world.activeEntryIds) ? world.activeEntryIds : [],
      selectedSchemeId: String(world.selectedSchemeId || ''),
    },
  });
}

/** 全局条目资源 + 当前 worldId 的方案与启用状态。 */
export async function loadAuConfigForUser(user = {}) {
  await ensureAuResourceScopeMigration();
  const worldId = auWorldId(user);
  const [libraryRow, worldRow] = await Promise.all([
    db.getRecord('settings', AU_RESOURCE_LIBRARY_KEY).catch(() => null),
    worldId ? db.getRecord('settings', `${AU_WORLD_CONFIG_PREFIX}${worldId}`).catch(() => null) : null,
  ]);
  if (worldRow?.value) return composeStoredAuConfig(libraryRow?.value, worldRow.value);

  // 新建世界线可能携带旧 user.auConfig；首次读取时只继承其方案/启用状态，
  // 条目正文仍以全局资源库为准。
  const legacy = normalizeAuConfig(user);
  const merged = mergeAuEntries([
    { entries: Array.isArray(libraryRow?.value?.entries) ? libraryRow.value.entries : [] },
    legacy,
  ]);
  const worldConfig = remapAuWorldConfig(legacy, merged.idMaps[1]);
  await db.putRecord('settings', {
    key: AU_RESOURCE_LIBRARY_KEY,
    value: { version: MARSHMALLOW_AU_VERSION, entries: merged.entries },
    updatedAt: Date.now(),
  });
  if (worldId) {
    await db.putRecord('settings', {
      key: `${AU_WORLD_CONFIG_PREFIX}${worldId}`,
      value: worldConfig,
      updatedAt: Date.now(),
    });
  }
  return composeStoredAuConfig({ entries: merged.entries }, worldConfig);
}

export async function saveAuConfigForUser(user = {}, config = {}) {
  await ensureAuResourceScopeMigration();
  const normalized = normalizeAuConfig({ auConfig: serializeAuConfigForUser(config) });
  const worldId = auWorldId(user);
  if (!worldId) throw new Error('缺少档位世界标识');
  await Promise.all([
    db.putRecord('settings', {
      key: AU_RESOURCE_LIBRARY_KEY,
      value: { version: MARSHMALLOW_AU_VERSION, entries: normalized.entries },
      updatedAt: Date.now(),
    }),
    db.putRecord('settings', {
      key: `${AU_WORLD_CONFIG_PREFIX}${worldId}`,
      value: remapAuWorldConfig(normalized),
      updatedAt: Date.now(),
    }),
  ]);
  return loadAuConfigForUser(user);
}

export function getActiveAUEntriesFromConfig(config = {}) {
  const activeSet = new Set(config.activeEntryIds || []);
  return (config.entries || [])
    .filter((entry) => entry.enabled !== false && activeSet.has(entry.id))
    .sort((a, b) => (a.priority || 0) - (b.priority || 0) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
}

export function buildAuPromptBlockFromConfig(config = {}) {
  const entries = getActiveAUEntriesFromConfig(config);
  if (!entries.length) return '';
  return [
    '【特殊设定·强覆盖】以下为用户当前启用的架空/附加规则，优先级高于默认世界观与角色卡中的默认身份、职业、生理及社会规则；冲突部分必须以特殊设定为准。保留角色原有性格、口吻、关系与情感底色，并在此基础上按特殊设定重新解释人物；不要把角色强行拉回默认语境。',
    ...entries.filter((entry) => entry.content).map((entry) => `[${entry.category}｜${entry.name}]\n${entry.content}`),
  ].join('\n\n');
}
