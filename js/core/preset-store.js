import * as db from './db.js';
import {
  PROMPTS,
  PROMPT_CATEGORIES,
  DEFAULT_CHAT_INJECT_IDS,
} from '../data/prompts.js';
import { PROMPT_PROFILES, normalizePromptProfile } from './prompt-profile.js';

export const CHAT_INJECT_LIST_KEY = 'preset_chat_inject_ids';
const COLLAPSED_KEY = 'presetCollapsedCategories';
const BUILTIN_DISABLED_KEY = 'preset_builtin_disabled_ids';
const BUILTIN_DEFAULT_OFF_SEEDED_KEY = 'preset_builtin_default_off_seeded';
const BUILTIN_DEFAULT_ON_20260731_KEY = 'preset_builtin_default_on_20260731';
const BUILTIN_LIVED_WARMTH_DEFAULT_ON_20260815_KEY = 'preset_builtin_lived_warmth_default_on_20260815';
const OFFLINE_THINKING_OVERRIDE_KEY = 'preset_offline_thinking_override';
const OFFLINE_THINKING_BUILTIN_ID = 'narrative_director_preflight';
export const MAX_OFFLINE_THINKING_STEPS_LENGTH = 6000;
const OFFLINE_FAST_FORWARD_PRESET_IDS_PREFIX = 'offlineFastForwardPresetIds_';
export const OFFLINE_DEFAULT_ON_PRESET_IDS = Object.freeze([
  'narrative_ensemble_underflow',
  'style_direct_concrete',
  'relationship_equal_footing',
  'narrative_persona_brake',
  'narrative_director_preflight',
  'style_plain_modern',
  'style_lived_warmth',
]);
/** settings 里同样以 preset_ 开头、但不是预设正文的元数据键（误进列表会变成空白选项） */
const PRESET_META_KEYS = new Set([
  CHAT_INJECT_LIST_KEY,
  BUILTIN_DISABLED_KEY,
  BUILTIN_DEFAULT_OFF_SEEDED_KEY,
  BUILTIN_DEFAULT_ON_20260731_KEY,
  BUILTIN_LIVED_WARMTH_DEFAULT_ON_20260815_KEY,
  OFFLINE_THINKING_OVERRIDE_KEY,
]);
const DEPRECATED_PRESET_IDS = new Set([
  'reply_breath_recommended',
  'narrative_continuity',
  'archetype_mature_senior',
  'archetype_taciturn_precise',
  'archetype_gentle_soft',
  'archetype_playful_tease',
  'behavioral_patch',
  'shared_emotional_mode',
]);
const PRESET_CONTEXT_CACHE_LIMIT = 24;
const _presetContextCache = new Map();
const _presetContextInFlight = new Map();
let _presetContextRevision = 0;

async function loadPresetSettingsRows() {
  const [presetRows, metaRows] = await Promise.all([
    db.getAllByKeyPrefix('settings', 'preset_', { batchSize: 32 }),
    db.getMany('settings', [
      COLLAPSED_KEY,
      BUILTIN_DISABLED_KEY,
      BUILTIN_DEFAULT_OFF_SEEDED_KEY,
      BUILTIN_DEFAULT_ON_20260731_KEY,
      BUILTIN_LIVED_WARMTH_DEFAULT_ON_20260815_KEY,
      OFFLINE_THINKING_OVERRIDE_KEY,
    ]),
  ]);
  const merged = new Map();
  for (const row of [...presetRows, ...metaRows]) {
    if (row?.key != null) merged.set(String(row.key), row);
  }
  return [...merged.values()];
}

export function presetKey(id) {
  return `preset_${String(id || '').trim()}`;
}

function isPresetSettingsMetaKey(key) {
  return PRESET_META_KEYS.has(String(key || ''));
}

/** 从 settings.key 取出真实预设 id；元数据键返回空串 */
function presetIdFromSettingsKey(key) {
  const k = String(key || '');
  if (!k.startsWith('preset_') || isPresetSettingsMetaKey(k)) return '';
  const id = k.slice('preset_'.length).trim();
  if (!id || DEPRECATED_PRESET_IDS.has(id)) return '';
  return id;
}

/** 存盘值是否像一条预设记录（排除 inject 清单等数组） */
function isPresetRecordValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.content === 'string'
    || (typeof value.name === 'string' && (value.id != null || value.category != null));
}

function presetDisplayName(rec, fallbackId = '') {
  const id = String(rec?.id || fallbackId || '').trim();
  const builtin = id ? PROMPTS[id] : null;
  return String(builtin?.name || rec?.name || rec?.bundleName || id || '').trim() || id;
}

export async function seedPresetsIfEmpty() {
  const rows = await loadPresetSettingsRows();
  const hasAny = (Array.isArray(rows) ? rows : []).some((r) => !!presetIdFromSettingsKey(r.key));
  if (hasAny) return rows;
  for (const p of Object.values(PROMPTS)) {
    await db.put('settings', {
      key: presetKey(p.id),
      value: { id: p.id, name: p.name, category: p.category, content: p.content, mode: p.mode },
    });
  }
  await db.put('settings', { key: CHAT_INJECT_LIST_KEY, value: [...DEFAULT_CHAT_INJECT_IDS] });
  return loadPresetSettingsRows();
}

export async function loadChatInjectList() {
  const row = await db.get(CHAT_INJECT_LIST_KEY);
  const v = row?.value;
  const list = Array.isArray(v)
    ? v.map((x) => String(x)).filter((id) => id && !DEPRECATED_PRESET_IDS.has(id))
    : [];
  if (!list.length) return [...DEFAULT_CHAT_INJECT_IDS];
  return [...new Set(list)];
}

export async function saveChatInjectList(list) {
  const clean = [...new Set((Array.isArray(list) ? list : [])
    .map((x) => String(x))
    .filter((id) => id && !DEPRECATED_PRESET_IDS.has(id)))];
  await db.put('settings', { key: CHAT_INJECT_LIST_KEY, value: clean });
  return clean;
}

/**
 * 用户只编辑“要检查什么”；边界标记和正文兜底由程序统一包装，
 * 避免手工模板少标记、多标记或让思考块吞掉正文。
 */
export function normalizeOfflineThinkingSteps(value = '') {
  return String(value || '')
    .replace(/<<<\/?(?:THINKING|END_THINKING)>>>/gi, '')
    .replace(/^\s*(?:正文|最终正文|最终输出)\s*[:：]\s*$/gim, '')
    .trim()
    .slice(0, MAX_OFFLINE_THINKING_STEPS_LENGTH);
}

export function buildOfflineThinkingPrompt(steps = '') {
  const clean = normalizeOfflineThinkingSteps(steps);
  if (!clean) return '';
  return [
    '[线下思维链 · 自定义推演]',
    '每次线下叙事成稿前，必须按顺序逐项完成下列检查，不得跳项、合并或只复述标题。',
    '格式硬约束：只输出一对完整边界，不加 Markdown 代码围栏，不在边界外泄露分析。如果接口有原生 reasoning/thinking 通道，在该通道内完成同样的逐项检查；否则严格使用下列边界：',
    '<<<THINKING>>>',
    clean,
    '<<<END_THINKING>>>',
    '关闭边界后立即输出完整中文叙事正文。思考块不能代替正文；正文不得重复推演步骤、标题或结论。',
  ].join('\n');
}

export async function loadOfflineThinkingOverride() {
  const row = await db.get(OFFLINE_THINKING_OVERRIDE_KEY).catch(() => null);
  const steps = normalizeOfflineThinkingSteps(row?.value?.steps ?? row?.value);
  return steps ? { steps, updatedAt: Number(row?.value?.updatedAt || 0) || 0 } : null;
}

export async function saveOfflineThinkingOverride(steps = '') {
  const clean = normalizeOfflineThinkingSteps(steps);
  if (!clean) throw new Error('请至少写一个推演步骤');
  const value = { steps: clean, updatedAt: Date.now() };
  await db.put('settings', { key: OFFLINE_THINKING_OVERRIDE_KEY, value });
  invalidatePresetsPageSnapshot();
  return value;
}

export async function clearOfflineThinkingOverride() {
  await db.put('settings', { key: OFFLINE_THINKING_OVERRIDE_KEY, value: null });
  invalidatePresetsPageSnapshot();
}

/**
 * 内置预设四层可见性：
 * 1. alwaysOn（线上黑箱）：online_chat_core / group_liveliness。
 *    用户看不到也关不掉，始终按 mode 注入，只受 excludeIds 影响。
 * 2. 线上内置可开关（onlineToggle）：接梗玩笑/降噪/报备接法/多点拆气泡/接话有重点/
 *    认真深谈/知识联想/生活维度扩展/平等互动/反说教等
 *    活人感条目。预设页只显示条目名，用户能开关，不能看正文；一般默认注入，
 *    用「关闭清单」记录例外。带 defaultOff 的模型专项纠偏条目默认关闭、需用户手动开启。
 * 3. 线下内置（mode='offline' 且无 surface）：预设页只显示条目名，用户能开关，不能看正文；
 *    默认全部注入（开关记录的是「关闭」而非「开启」，新增条目自动默认开启）。
 *    带 defaultOff 的条目例外：首次出现时自动写进关闭清单，即默认关闭、需用户手动开启（如可选叠加的文风）。
 * 4. 社交媒体内置（带 surface 字段）：朋友圈/隔空喊话/匿名空间各自专属，用户能开关，不能看正文，
 *    只注入到对应生成，同样默认开启、用「关闭清单」记录例外。
 */
export function listOnlineBuiltinPresets() {
  return Object.values(PROMPTS).filter((p) => p.onlineToggle && !p.alwaysOn && !p.surface);
}

export function listOfflineBuiltinPresets() {
  return Object.values(PROMPTS).filter((p) => p.mode === 'offline' && !p.surface);
}

/**
 * 线下场景「只用这些文风预设」下拉的完整候选：内置线下预设 + 用户在预设页新建/导入的
 * 自定义预设中 mode 为 offline/both 的条目。之前这里只列内置的，导致自定义预设选不到。
 */
export async function listOfflinePresetOptions() {
  const builtins = listOfflineBuiltinPresets().map((p) => ({
    id: p.id,
    name: presetDisplayName(p, p.id),
  }));
  const ids = await listAllPresetIds();
  const customIds = ids.filter((id) => !PROMPTS[id]);
  const records = (await Promise.all(customIds.map((id) => loadPresetRecord(id))))
    .filter((r) => r && isPresetRecordValue(r));
  const customs = records
    .filter((r) => presetModeMatches(r, 'offline'))
    .map((r) => {
      const id = String(r.id || '').trim();
      return id ? { id, name: presetDisplayName(r, id) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  return [...builtins, ...customs];
}

function offlineFastForwardPresetIdsKey(userId = '') {
  return `${OFFLINE_FAST_FORWARD_PRESET_IDS_PREFIX}${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function normalizeOfflineFastForwardPresetIds(ids = [], availableIds = null) {
  const available = Array.isArray(availableIds)
    ? new Set(availableIds.map((id) => String(id || '').trim()).filter(Boolean))
    : null;
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && (!available || available.has(id))))];
}

/** 聊天工具栏「线下小剧场」上次勾选的文风，按当前用户档位记忆。 */
export async function loadOfflineFastForwardPresetIds(userId = '', availableIds = null) {
  const row = await db.get('settings', offlineFastForwardPresetIdsKey(userId)).catch(() => null);
  return normalizeOfflineFastForwardPresetIds(row?.value, availableIds);
}

export async function saveOfflineFastForwardPresetIds(userId = '', ids = [], availableIds = null) {
  const value = normalizeOfflineFastForwardPresetIds(ids, availableIds);
  await db.put('settings', { key: offlineFastForwardPresetIdsKey(userId), value });
  return value;
}

export function listSocialSurfaceBuiltinPresets() {
  return Object.values(PROMPTS).filter((p) => !!p.surface);
}

export async function loadDisabledBuiltinPresetIds() {
  const row = await db.get(BUILTIN_DISABLED_KEY);
  const disabled = new Set((Array.isArray(row?.value) ? row.value : []).map((x) => String(x)).filter(Boolean));
  // defaultOff 的内置条目首次出现时写进关闭清单（只写一次；之后用户开关照常走关闭清单）。
  const seededRow = await db.get(BUILTIN_DEFAULT_OFF_SEEDED_KEY);
  const seeded = new Set((Array.isArray(seededRow?.value) ? seededRow.value : []).map((x) => String(x)).filter(Boolean));
  const pending = Object.values(PROMPTS).filter((p) => p.defaultOff && !seeded.has(p.id));
  let disabledChanged = false;
  let seededChanged = false;
  if (pending.length) {
    for (const p of pending) {
      if (!disabled.has(p.id)) disabledChanged = true;
      disabled.add(p.id);
      seeded.add(p.id);
      seededChanged = true;
    }
  }
  // 旧版本曾把白描与四个纠偏条目默认关闭。只迁移一次，之后仍尊重用户手动开关。
  const defaultOnMigratedRow = await db.get(BUILTIN_DEFAULT_ON_20260731_KEY);
  const needsDefaultOnMigration = defaultOnMigratedRow?.value !== true;
  if (needsDefaultOnMigration) {
    for (const id of OFFLINE_DEFAULT_ON_PRESET_IDS) {
      if (disabled.delete(id)) disabledChanged = true;
    }
  }
  const livedWarmthMigratedRow = await db.get(BUILTIN_LIVED_WARMTH_DEFAULT_ON_20260815_KEY);
  const needsLivedWarmthMigration = livedWarmthMigratedRow?.value !== true;
  if (needsLivedWarmthMigration && disabled.delete('style_lived_warmth')) disabledChanged = true;
  if (disabledChanged) await db.put('settings', { key: BUILTIN_DISABLED_KEY, value: [...disabled] });
  if (seededChanged) await db.put('settings', { key: BUILTIN_DEFAULT_OFF_SEEDED_KEY, value: [...seeded] });
  if (needsDefaultOnMigration) {
    await db.put('settings', { key: BUILTIN_DEFAULT_ON_20260731_KEY, value: true });
  }
  if (needsLivedWarmthMigration) {
    await db.put('settings', { key: BUILTIN_LIVED_WARMTH_DEFAULT_ON_20260815_KEY, value: true });
  }
  return disabled;
}

/** 预设页首屏快照：一次读 settings 表，避免 listPresetsGrouped + listCustomPresetBundles 各扫 N 遍 db.get */
let _pageSnapshotPromise = null;
let _snapshotBuilding = false;

const PRESET_PAGE_SETTINGS_KEYS = new Set([
  CHAT_INJECT_LIST_KEY,
  COLLAPSED_KEY,
  BUILTIN_DISABLED_KEY,
  BUILTIN_DEFAULT_OFF_SEEDED_KEY,
  BUILTIN_DEFAULT_ON_20260731_KEY,
  BUILTIN_LIVED_WARMTH_DEFAULT_ON_20260815_KEY,
]);

function isPresetPageSettingsKey(key) {
  const k = String(key || '');
  if (!k) return true;
  if (k.startsWith('preset_') || isPresetSettingsMetaKey(k)) return true;
  return PRESET_PAGE_SETTINGS_KEYS.has(k);
}

db.onStoreWrite('settings', (key) => {
  if (!isPresetPageSettingsKey(key)) return;
  if (!_snapshotBuilding) _pageSnapshotPromise = null;
  _presetContextRevision += 1;
  _presetContextCache.clear();
});

export function invalidatePresetsPageSnapshot() {
  _pageSnapshotPromise = null;
}

function settingsMapFromRows(rows) {
  const map = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r?.key != null) map.set(String(r.key), r.value);
  }
  return map;
}

/** 列表 UI 用轻量记录：不带整段正文，避免把 PROMPTS 里的大段 content 复制进内存再拼 HTML */
function presetListRecordFromMap(map, id) {
  const cleanId = String(id || '').trim();
  if (!cleanId || DEPRECATED_PRESET_IDS.has(cleanId)) return null;
  if (isPresetSettingsMetaKey(presetKey(cleanId))) return null;
  const stored = map.get(presetKey(cleanId));
  if (isPresetRecordValue(stored)) {
    const isBuiltin = !!PROMPTS[cleanId];
    const def = PROMPTS[cleanId];
    return {
      id: cleanId,
      name: presetDisplayName(stored, cleanId),
      category: stored.category || def?.category,
      mode: stored.mode ?? def?.mode,
      bundleId: stored.bundleId,
      bundleName: stored.bundleName,
      bundleOrder: stored.bundleOrder,
      order: stored.order,
      preview: isBuiltin ? '' : truncatePresetPreview(stored.content),
    };
  }
  const def = PROMPTS[cleanId];
  if (!def) return null;
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    mode: def.mode,
    preview: '',
  };
}

async function resolveDisabledBuiltinSetFromMap(map) {
  const disabled = new Set(
    (Array.isArray(map.get(BUILTIN_DISABLED_KEY)) ? map.get(BUILTIN_DISABLED_KEY) : [])
      .map((x) => String(x))
      .filter(Boolean),
  );
  const seeded = new Set(
    (Array.isArray(map.get(BUILTIN_DEFAULT_OFF_SEEDED_KEY)) ? map.get(BUILTIN_DEFAULT_OFF_SEEDED_KEY) : [])
      .map((x) => String(x))
      .filter(Boolean),
  );
  const pending = Object.values(PROMPTS).filter((p) => p.defaultOff && !seeded.has(p.id));
  let disabledChanged = false;
  let seededChanged = false;
  for (const p of pending) {
    if (!disabled.has(p.id)) disabledChanged = true;
    disabled.add(p.id);
    seeded.add(p.id);
    seededChanged = true;
  }
  const needsDefaultOnMigration = map.get(BUILTIN_DEFAULT_ON_20260731_KEY) !== true;
  if (needsDefaultOnMigration) {
    for (const id of OFFLINE_DEFAULT_ON_PRESET_IDS) {
      if (disabled.delete(id)) disabledChanged = true;
    }
  }
  const needsLivedWarmthMigration = map.get(BUILTIN_LIVED_WARMTH_DEFAULT_ON_20260815_KEY) !== true;
  if (needsLivedWarmthMigration && disabled.delete('style_lived_warmth')) disabledChanged = true;
  if (!disabledChanged && !seededChanged && !needsDefaultOnMigration && !needsLivedWarmthMigration) return disabled;
  _snapshotBuilding = true;
  try {
    if (disabledChanged) {
      await db.put('settings', { key: BUILTIN_DISABLED_KEY, value: [...disabled] });
      map.set(BUILTIN_DISABLED_KEY, [...disabled]);
    }
    if (seededChanged) {
      await db.put('settings', { key: BUILTIN_DEFAULT_OFF_SEEDED_KEY, value: [...seeded] });
      map.set(BUILTIN_DEFAULT_OFF_SEEDED_KEY, [...seeded]);
    }
    if (needsDefaultOnMigration) {
      await db.put('settings', { key: BUILTIN_DEFAULT_ON_20260731_KEY, value: true });
      map.set(BUILTIN_DEFAULT_ON_20260731_KEY, true);
    }
    if (needsLivedWarmthMigration) {
      await db.put('settings', { key: BUILTIN_LIVED_WARMTH_DEFAULT_ON_20260815_KEY, value: true });
      map.set(BUILTIN_LIVED_WARMTH_DEFAULT_ON_20260815_KEY, true);
    }
  } finally {
    _snapshotBuilding = false;
  }
  return disabled;
}

function buildGroupedPresets(records) {
  const byCategory = {};
  for (const cat of Object.keys(PROMPT_CATEGORIES)) byCategory[cat] = [];
  byCategory.custom = byCategory.custom || [];
  for (const rec of records) {
    const cat = rec.category === 'custom' || !PROMPT_CATEGORIES[rec.category]
      ? (String(rec.id || '').startsWith('custom_') ? 'custom' : (rec.category || 'custom'))
      : rec.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(rec);
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  }
  return byCategory;
}

function buildCustomPresetBundlesFromRecords(records) {
  const custom = records.filter((r) => !PROMPTS[r.id] && (r.category === 'custom' || String(r.id).startsWith('custom_')));
  const bundleMap = new Map();
  const standalone = [];
  for (const r of custom) {
    if (r.bundleId) {
      if (!bundleMap.has(r.bundleId)) {
        bundleMap.set(r.bundleId, {
          id: r.bundleId,
          name: r.bundleName || '导入预设',
          order: Number(r.bundleOrder) || 0,
          mode: normalizePresetMode(r.mode),
          presets: [],
        });
      }
      bundleMap.get(r.bundleId).presets.push(r);
    } else {
      standalone.push(r);
    }
  }
  const bundles = [...bundleMap.values()].sort((a, b) => a.order - b.order);
  bundles.forEach((b) => b.presets.sort((a, c) => (Number(a.order) || 0) - (Number(c.order) || 0)));
  standalone.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  return { bundles, standalone };
}

export async function loadPresetsPageSnapshot() {
  if (!_pageSnapshotPromise) {
    _pageSnapshotPromise = (async () => {
      const rows = await seedPresetsIfEmpty();
      const map = settingsMapFromRows(Array.isArray(rows) ? rows : []);
      const disabledBuiltinSet = await resolveDisabledBuiltinSetFromMap(map);
      const ids = new Set();
      for (const key of map.keys()) {
        const id = presetIdFromSettingsKey(key);
        if (id) ids.add(id);
      }
      for (const id of Object.keys(PROMPTS)) ids.add(id);
      const records = [...ids]
        .map((id) => presetListRecordFromMap(map, id))
        .filter(Boolean);
      const collapsedRaw = map.get(COLLAPSED_KEY);
      const collapsedSet = new Set(
        (Array.isArray(collapsedRaw) ? collapsedRaw : []).map((x) => String(x)).filter(Boolean),
      );
      const injectRaw = map.get(CHAT_INJECT_LIST_KEY);
      const injectList = Array.isArray(injectRaw)
        ? injectRaw.map((x) => String(x)).filter((id) => id && !DEPRECATED_PRESET_IDS.has(id))
        : [];
      const enabledSet = new Set(
        injectList.length ? [...new Set(injectList)] : [...DEFAULT_CHAT_INJECT_IDS],
      );
      const offlineThinkingRaw = map.get(OFFLINE_THINKING_OVERRIDE_KEY);
      const offlineThinkingSteps = normalizeOfflineThinkingSteps(
        offlineThinkingRaw?.steps ?? offlineThinkingRaw,
      );
      return {
        grouped: buildGroupedPresets(records),
        custom: buildCustomPresetBundlesFromRecords(records),
        collapsedSet,
        collapsedPrefsInitialized: map.has(COLLAPSED_KEY),
        enabledSet,
        disabledBuiltinSet,
        offlineThinkingOverride: offlineThinkingSteps
          ? {
            steps: offlineThinkingSteps,
            updatedAt: Number(offlineThinkingRaw?.updatedAt || 0) || 0,
          }
          : null,
      };
    })().catch((err) => {
      _pageSnapshotPromise = null;
      throw err;
    });
  }
  return _pageSnapshotPromise;
}

export async function saveDisabledBuiltinPresetIds(idsIterable) {
  const clean = [...new Set([...(idsIterable || [])].map((x) => String(x)).filter(Boolean))];
  await db.put('settings', { key: BUILTIN_DISABLED_KEY, value: clean });
  return clean;
}

export async function toggleBuiltinPresetEnabled(id, enabled) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return loadDisabledBuiltinPresetIds();
  const disabled = await loadDisabledBuiltinPresetIds();
  if (enabled) disabled.delete(cleanId); else disabled.add(cleanId);
  await saveDisabledBuiltinPresetIds(disabled);
  return disabled;
}

/** 社交媒体内置预设：只注入到 surface 对应的那一种生成（朋友圈/隔空喊话/匿名空间）。 */
export async function buildSurfacePresetBlock(surface) {
  const wanted = String(surface || '').trim();
  if (!wanted) return '';
  const disabled = await loadDisabledBuiltinPresetIds();
  const parts = listSocialSurfaceBuiltinPresets()
    .filter((p) => p.surface === wanted && !disabled.has(p.id))
    .map((p) => String(p.content || '').trim())
    .filter(Boolean);
  return parts.join('\n\n');
}

export async function loadPresetRecord(id) {
  const cleanId = String(id || '').trim();
  if (!cleanId || isPresetSettingsMetaKey(presetKey(cleanId))) return null;
  // 内置预设不可编辑，代码里的当前版本才是真值；不能让首次安装时写入 DB 的旧标题/旧正文
  // 永久盖住后续升级，否则重命名、纠错和压缩提示词只会对新用户生效。
  const def = PROMPTS[cleanId];
  if (def) return { ...def };
  const row = await db.get(presetKey(cleanId));
  if (isPresetRecordValue(row?.value)) {
    const stored = row.value;
    return {
      ...stored,
      id: String(stored.id || cleanId).trim() || cleanId,
      name: presetDisplayName(stored, cleanId),
      mode: normalizePresetMode(stored.mode),
      category: stored.category || 'custom',
    };
  }
  return null;
}

export async function savePresetRecord(record) {
  const id = String(record?.id || '').trim();
  if (!id) throw new Error('preset id required');
  if (PROMPTS[id]) throw new Error('内置预设不可编辑');
  const name = String(record?.name || '').trim() || id;
  const mode = normalizePresetMode(record?.mode);
  const next = { ...record, id, name, mode };
  await db.put('settings', { key: presetKey(id), value: next });
  invalidatePresetsPageSnapshot();
  return next;
}

export async function saveAndEnablePresetRecord(record) {
  const saved = await savePresetRecord(record);
  const inject = await loadChatInjectList();
  if (!inject.includes(saved.id)) await saveChatInjectList([...inject, saved.id]);
  return saved;
}

export async function listAllPresetIds() {
  await seedPresetsIfEmpty();
  const rows = await db.getAllByKeyPrefix('settings', 'preset_', { batchSize: 32 });
  const fromDb = new Set();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const id = presetIdFromSettingsKey(r.key);
    if (id) fromDb.add(id);
  }
  for (const id of Object.keys(PROMPTS)) fromDb.add(id);
  return [...fromDb].filter((id) => id && !DEPRECATED_PRESET_IDS.has(id));
}

export async function listPresetsGrouped() {
  const ids = await listAllPresetIds();
  const records = await Promise.all(ids.map((id) => loadPresetRecord(id)));
  const byCategory = {};
  for (const cat of Object.keys(PROMPT_CATEGORIES)) byCategory[cat] = [];
  byCategory.custom = byCategory.custom || [];

  for (const rec of records.filter(Boolean)) {
    const cat = rec.category === 'custom' || !PROMPT_CATEGORIES[rec.category]
      ? (String(rec.id || '').startsWith('custom_') ? 'custom' : (rec.category || 'custom'))
      : rec.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(rec);
  }

  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  }
  return byCategory;
}

export const PRESET_MODES = ['both', 'online', 'offline'];

export function normalizePresetMode(mode) {
  return PRESET_MODES.includes(mode) ? mode : 'both';
}

/** 记录的模式（线上/线下/通用）是否在当前取用模式下生效。 */
function presetModeMatches(rec, wanted) {
  const m = normalizePresetMode(rec?.mode);
  if (m === 'both' || !wanted) return true;
  return m === wanted;
}

/**
 * @param {'online'|'offline'} mode 取用场景：线上=普通聊天/微博/论坛；线下=相遇（线下沉浸/时光机/番外）。
 */
async function buildPresetFragmentContextUncached(mode = 'online', options = {}) {
  const excludeIds = new Set(
    (Array.isArray(options.excludeIds) ? options.excludeIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  // 「只用这个」反向开关（如线下场景绑定单个预设文风）：非空时只注入命中的预设，跳过其余默认开启的预设。
  const onlyIds = new Set(
    (Array.isArray(options.onlyIds) ? options.onlyIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const deferIds = new Set(
    (Array.isArray(options.deferIds) ? options.deferIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  // 未传数组时沿用预设页的全局开关；传入数组（包括空数组）时，线上内置可开关
  // 条目改用当前会话的独立绑定。alwaysOn 安全底线与自定义/导入预设不受影响。
  const onlineBuiltinIds = Array.isArray(options.onlineBuiltinIds)
    ? new Set(options.onlineBuiltinIds.map((id) => String(id || '').trim()).filter(Boolean))
    : null;

  const alwaysOnParts = [];
  const toggleParts = [];
  const customParts = [];
  const deferredParts = [];
  const profile = normalizePromptProfile(options.promptProfile)
    || (options.lightweightPromptEnabled === true ? PROMPT_PROFILES.LIGHTWEIGHT : PROMPT_PROFILES.FULL);
  const builtinContent = (preset) => String(
    profile === PROMPT_PROFILES.V2
      ? (preset?.v2Content || preset?.lightweightContent || preset?.content || '')
      : profile === PROMPT_PROFILES.LIGHTWEIGHT
        ? (preset?.lightweightContent || preset?.content || '')
        : (preset?.content || ''),
  ).trim();
  const trackActiveId = (id) => {
    const cleanId = String(id || '').trim();
    if (!cleanId || !Array.isArray(options.outActiveIds) || options.outActiveIds.includes(cleanId)) return;
    options.outActiveIds.push(cleanId);
  };

  // 线上黑箱：始终注入，不进任何开关清单，不对用户展示，也不受 onlyIds 收窄（安全网/合规底线不能被局内设置关掉）。
  for (const p of Object.values(PROMPTS)) {
    if (!p.alwaysOn || excludeIds.has(p.id)) continue;
    if (!presetModeMatches(p, mode)) continue;
    const content = builtinContent(p);
    if (content) {
      alwaysOnParts.push(content);
      trackActiveId(p.id);
    }
  }

  // 线上内置可开关：默认注入线上场景，用户在预设页只能开关不能看正文（关闭清单记例外）。
  if (mode !== 'offline') {
    const disabled = onlineBuiltinIds ? null : await loadDisabledBuiltinPresetIds();
    for (const p of listOnlineBuiltinPresets()) {
      if (excludeIds.has(p.id)) continue;
      if (!presetModeMatches(p, mode)) continue;
      if (onlyIds.size) {
        if (!onlyIds.has(p.id)) continue;
      } else if (onlineBuiltinIds ? !onlineBuiltinIds.has(p.id) : disabled.has(p.id)) continue;
      const content = builtinContent(p);
      if (content) {
        toggleParts.push(content);
        trackActiveId(p.id);
      }
    }
  }

  // 线下内置：只在线下场景注入，默认全开（defaultOff 条目默认关），用户只能在预设页开关（看不到正文）。
  // onlyIds 非空 = 局内明确指定「只用这个」，视为显式选择，无视预设页开关状态。
  if (mode === 'offline') {
    const disabled = await loadDisabledBuiltinPresetIds();
    const thinkingOverride = await loadOfflineThinkingOverride();
    for (const p of listOfflineBuiltinPresets()) {
      if (excludeIds.has(p.id)) continue;
      if (onlyIds.size) {
        if (!onlyIds.has(p.id)) continue;
      } else if (disabled.has(p.id)) continue;
      const content = p.id === OFFLINE_THINKING_BUILTIN_ID && thinkingOverride?.steps
        ? buildOfflineThinkingPrompt(thinkingOverride.steps)
        : builtinContent(p);
      if (content) {
        if (deferIds.has(p.id)) {
          deferredParts.push({ id: p.id, label: p.name || '生成前检查', text: content });
        } else {
          toggleParts.push(content);
        }
        trackActiveId(p.id);
      }
    }
  }

  // 自定义 / 导入预设：沿用旧的「注入清单」开关（不含内置条目，内置已在上面单独处理）。
  // 之前这里有 slice(0, 24)：截断发生在按 mode 过滤之前，注入清单一旦超过 24 个（线上+线下+通用混在
  // 同一份清单里，导入包一多就很容易破 24），排在后面的条目无论是否勾选、是否匹配当前 mode 都会被
  // 直接跳过，且开关切换前后 token 完全不变——这正是「开了却读不到」的根因，故去掉硬上限。
  const injectIds = await loadChatInjectList();
  for (const id of new Set(injectIds)) {
    if (excludeIds.has(id) || PROMPTS[id]) continue;
    if (onlyIds.size && !onlyIds.has(id)) continue;
    const rec = await loadPresetRecord(id);
    if (!presetModeMatches(rec, mode)) continue;
    const content = String(rec?.content || '').trim();
    if (content) {
      customParts.push(content);
      trackActiveId(id);
    }
  }

  const parts = [...alwaysOnParts, ...toggleParts, ...customParts];
  if (Array.isArray(options.outDeferredParts) && deferredParts.length) {
    options.outDeferredParts.push(...deferredParts);
  }
  if (Array.isArray(options.outBreakdown)) {
    if (alwaysOnParts.length) {
      options.outBreakdown.push({
        id: 'preset_always',
        label: '内置常驻',
        text: alwaysOnParts.join('\n\n'),
      });
    }
    if (toggleParts.length) {
      options.outBreakdown.push({
        id: 'preset_toggle',
        label: mode === 'offline' ? '线下可开关内置' : '线上可开关内置',
        text: toggleParts.join('\n\n'),
      });
    }
    if (customParts.length) {
      options.outBreakdown.push({
        id: 'preset_custom',
        label: '自定义/导入',
        text: customParts.join('\n\n'),
      });
    }
  }
  if (!parts.length) return '';
  return `【叙事预设】\n${parts.join('\n\n')}`;
}

function presetContextCacheKey(mode = 'online', options = {}) {
  const normalizedList = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))].sort();
  return JSON.stringify({
    mode: String(mode || 'online'),
    excludeIds: normalizedList(options.excludeIds),
    onlyIds: normalizedList(options.onlyIds),
    deferIds: normalizedList(options.deferIds),
    onlineBuiltinIds: Array.isArray(options.onlineBuiltinIds)
      ? normalizedList(options.onlineBuiltinIds)
      : null,
    promptProfile: normalizePromptProfile(options.promptProfile),
    lightweightPromptEnabled: options.lightweightPromptEnabled === true,
  });
}

function replayPresetContextOutputs(cached, options = {}) {
  if (Array.isArray(options.outActiveIds)) {
    for (const id of cached.activeIds || []) {
      if (!options.outActiveIds.includes(id)) options.outActiveIds.push(id);
    }
  }
  if (Array.isArray(options.outDeferredParts) && cached.deferredParts?.length) {
    options.outDeferredParts.push(...cached.deferredParts.map((item) => ({ ...item })));
  }
  if (Array.isArray(options.outBreakdown) && cached.breakdown?.length) {
    options.outBreakdown.push(...cached.breakdown.map((item) => ({ ...item })));
  }
}

/**
 * 预设正文与聊天窗口、当前消息无关；按预设 revision 物化一次后，聊天、论坛、
 * 微博及多个角色窗口共享。只有开关、注入清单或自定义正文变化时才整体换代。
 */
export async function buildPresetFragmentContext(mode = 'online', options = {}) {
  const key = presetContextCacheKey(mode, options);
  const cached = _presetContextCache.get(key);
  if (cached) {
    _presetContextCache.delete(key);
    _presetContextCache.set(key, cached);
    replayPresetContextOutputs(cached, options);
    return cached.block;
  }
  const existing = _presetContextInFlight.get(key);
  if (existing) {
    const shared = await existing;
    replayPresetContextOutputs(shared, options);
    return shared.block;
  }
  const revision = _presetContextRevision;
  const promise = (async () => {
    const activeIds = [];
    const deferredParts = [];
    const breakdown = [];
    const block = await buildPresetFragmentContextUncached(mode, {
      ...options,
      outActiveIds: activeIds,
      outDeferredParts: deferredParts,
      outBreakdown: breakdown,
    });
    return { block, activeIds, deferredParts, breakdown, revision };
  })();
  _presetContextInFlight.set(key, promise);
  try {
    const built = await promise;
    if (revision !== _presetContextRevision) {
      return buildPresetFragmentContext(mode, options);
    }
    _presetContextCache.set(key, built);
    while (_presetContextCache.size > PRESET_CONTEXT_CACHE_LIMIT) {
      _presetContextCache.delete(_presetContextCache.keys().next().value);
    }
    replayPresetContextOutputs(built, options);
    return built.block;
  } finally {
    if (_presetContextInFlight.get(key) === promise) _presetContextInFlight.delete(key);
  }
}

export async function getCollapsedPresetCategories() {
  const row = await db.get(COLLAPSED_KEY);
  const list = Array.isArray(row?.value) ? row.value : [];
  return new Set(list.map((x) => String(x)).filter(Boolean));
}

export async function saveCollapsedPresetCategories(ids = []) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)).filter(Boolean))];
  await db.put({ key: COLLAPSED_KEY, value: clean });
}

export async function togglePresetCategoryCollapsed(category, collapsedSet) {
  const key = String(category || '').trim();
  const next = new Set(collapsedSet);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  await saveCollapsedPresetCategories([...next]);
  return next;
}

export function truncatePresetPreview(text = '', max = 72) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** 单个 txt / docx：整份文档 → 一组预设 + 一条正文 */
export async function importPresetFromDocumentText(text, options = {}) {
  const content = String(text || '').trim();
  if (!content) throw new Error('文档内容为空');
  const bundleId = `bundle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const bundleName = String(options.name || '导入预设').trim() || '导入预设';
  const itemName = String(options.itemName || bundleName).trim() || bundleName;
  const bundleOrder = Date.now();
  await savePresetRecord({
    id: `custom_${bundleId}_1`,
    name: itemName,
    category: 'custom',
    content,
    source: 'import',
    bundleId,
    bundleName,
    bundleOrder,
    order: 1,
    mode: 'both',
  });
  return { imported: 1, bundleId, bundleName };
}

/** 自定义分类下：按 bundle 聚合（保序），未归组的为 standalone。 */
export async function listCustomPresetBundles() {
  const ids = await listAllPresetIds();
  const records = (await Promise.all(ids.map((id) => loadPresetRecord(id)))).filter(Boolean);
  const custom = records.filter((r) => !PROMPTS[r.id] && (r.category === 'custom' || String(r.id).startsWith('custom_')));

  const bundleMap = new Map();
  const standalone = [];
  for (const r of custom) {
    if (r.bundleId) {
      if (!bundleMap.has(r.bundleId)) {
        bundleMap.set(r.bundleId, {
          id: r.bundleId,
          name: r.bundleName || '导入预设',
          order: Number(r.bundleOrder) || 0,
          mode: normalizePresetMode(r.mode),
          presets: [],
        });
      }
      bundleMap.get(r.bundleId).presets.push(r);
    } else {
      standalone.push(r);
    }
  }
  const bundles = [...bundleMap.values()].sort((a, b) => a.order - b.order);
  bundles.forEach((b) => b.presets.sort((a, c) => (Number(a.order) || 0) - (Number(c.order) || 0)));
  standalone.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  return { bundles, standalone };
}

/** 整组绑定线上/线下/通用：批量改组内每条记录的 mode。 */
export async function setPresetBundleMode(bundleId, mode) {
  const bid = String(bundleId || '').trim();
  if (!bid) return 0;
  const m = normalizePresetMode(mode);
  const rows = await db.getAllByKeyPrefix('settings', 'preset_', { batchSize: 32 });
  let n = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r.key && String(r.key).startsWith('preset_') && r.value?.bundleId === bid) {
      await db.put('settings', { key: r.key, value: { ...r.value, mode: m } });
      n += 1;
    }
  }
  if (n) invalidatePresetsPageSnapshot();
  return n;
}

/** 批量删除自定义/导入预设（内置 PROMPTS 条目跳过）。 */
export async function deletePresetRecords(ids = []) {
  const idList = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && !PROMPTS[id]),
  )];
  if (!idList.length) return 0;
  const idSet = new Set(idList);
  let n = 0;
  for (const id of idList) {
    const key = presetKey(id);
    const row = await db.get(key);
    if (row?.value) {
      await db.remove(key);
      n += 1;
    }
  }
  if (n) {
    const inject = await loadChatInjectList();
    await saveChatInjectList(inject.filter((id) => !idSet.has(id)));
    invalidatePresetsPageSnapshot();
  }
  return n;
}

/** 删除整组（含内部条目 + 从注入清单移除）。 */
export async function deletePresetBundle(bundleId) {
  const bid = String(bundleId || '').trim();
  if (!bid) return 0;
  const rows = await db.getAllByKeyPrefix('settings', 'preset_', { batchSize: 32 });
  const removedIds = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r.key && String(r.key).startsWith('preset_') && r.value?.bundleId === bid) {
      await db.remove(r.key);
      removedIds.push(String(r.key).slice('preset_'.length));
    }
  }
  if (removedIds.length) {
    const inject = await loadChatInjectList();
    const removedSet = new Set(removedIds);
    await saveChatInjectList(inject.filter((id) => !removedSet.has(id)));
    invalidatePresetsPageSnapshot();
  }
  return removedIds.length;
}

export function createCustomPresetId() {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}
