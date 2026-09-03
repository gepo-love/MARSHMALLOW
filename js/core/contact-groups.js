import * as db from './db.js';
import { listCharacters, saveCharacter } from './character-store.js';

const SETTINGS_KEY = 'contactGroups';
export const DEFAULT_GROUP_ID = 'default';
export const ALL_GROUPS_FILTER = '__all__';

const DEFAULT_CONFIG = {
  version: 2,
  groups: [{ id: DEFAULT_GROUP_ID, name: '默认', mutualAcquaintance: false }],
  lastSelectedGroupId: ALL_GROUPS_FILTER,
  collapsedGroups: [],
};

function normalizeConfig(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const groups = Array.isArray(base.groups) ? base.groups : [];
  // v1（没有 mutualAcquaintance 字段的老档）沿用旧语义：用户自建分组=组内互识；
  // v2 起新建分组默认不互识，需要用户显式打开。默认分组永远不互识。
  const legacySemantics = Number(base.version || 1) < 2;
  const normalized = [];
  const seen = new Set();
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    if (!g || !g.id || seen.has(g.id)) continue;
    seen.add(g.id);
    const id = String(g.id);
    let mutual = false;
    if (id !== DEFAULT_GROUP_ID) {
      mutual = typeof g.mutualAcquaintance === 'boolean'
        ? g.mutualAcquaintance
        : legacySemantics;
    }
    normalized.push({
      id,
      name: String(g.name || '未命名').trim() || '未命名',
      mutualAcquaintance: mutual,
    });
  }
  if (!normalized.some((g) => g.id === DEFAULT_GROUP_ID)) {
    normalized.unshift({ id: DEFAULT_GROUP_ID, name: '默认', mutualAcquaintance: false });
  }
  const last = String(base.lastSelectedGroupId || ALL_GROUPS_FILTER);
  const validIds = new Set(normalized.map((g) => g.id));
  const collapsedSrc = Array.isArray(base.collapsedGroups) ? base.collapsedGroups : [];
  const collapsedGroups = [...new Set(
    collapsedSrc.map((id) => String(id || '').trim()).filter((id) => id && validIds.has(id)),
  )];
  return {
    version: 2,
    groups: normalized,
    lastSelectedGroupId: last,
    collapsedGroups,
  };
}

let _configCache = null;

db.onStoreWrite('settings', (key) => {
  if (key === undefined || key === SETTINGS_KEY) _configCache = null;
});

export async function loadContactGroupsConfig() {
  if (_configCache) return normalizeConfig(_configCache);
  const row = await db.get(SETTINGS_KEY);
  _configCache = row?.value || null;
  return normalizeConfig(row?.value);
}

export async function saveContactGroupsConfig(config) {
  const next = normalizeConfig(config);
  await db.put({ key: SETTINGS_KEY, value: next });
  return next;
}

export function getGroupLabel(config, groupId) {
  if (groupId === ALL_GROUPS_FILTER) return '全部';
  const hit = (config?.groups || []).find((g) => g.id === groupId);
  return hit ? hit.name : '默认';
}

export function resolveCharacterGroupId(character) {
  const id = String(character?.groupId || '').trim();
  return id || DEFAULT_GROUP_ID;
}

/** 该分组是否开启「组内互识」：默认分组永远 false。 */
export function isGroupMutualAcquaintance(config, groupId) {
  const id = String(groupId || '').trim();
  if (!id || id === DEFAULT_GROUP_ID) return false;
  const hit = (config?.groups || []).find((g) => g.id === id);
  return !!hit?.mutualAcquaintance;
}

export async function setGroupMutualAcquaintance(groupId, enabled) {
  const id = String(groupId || '').trim();
  if (!id || id === DEFAULT_GROUP_ID) throw new Error('默认分组不支持组内互识');
  const config = await loadContactGroupsConfig();
  const hit = (config.groups || []).find((g) => g.id === id);
  if (!hit) throw new Error('分组不存在');
  hit.mutualAcquaintance = enabled === true;
  await saveContactGroupsConfig(config);
  return config;
}

export async function createContactGroup(name, options = {}) {
  const label = String(name || '').trim();
  if (!label) throw new Error('请填写分组名');
  const config = await loadContactGroupsConfig();
  const id = `group_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const mutualAcquaintance = options.mutualAcquaintance === true;
  config.groups.push({ id, name: label, mutualAcquaintance });
  await saveContactGroupsConfig(config);
  return { id, name: label, mutualAcquaintance };
}

export async function renameContactGroup(groupId, name) {
  const id = String(groupId || '').trim();
  const label = String(name || '').trim();
  if (!id) throw new Error('分组不存在');
  if (!label) throw new Error('请填写分组名');
  const config = await loadContactGroupsConfig();
  const hit = (config.groups || []).find((g) => g.id === id);
  if (!hit) throw new Error('分组不存在');
  hit.name = label;
  await saveContactGroupsConfig(config);
  return { id, name: label, mutualAcquaintance: hit.mutualAcquaintance === true };
}

export async function deleteContactGroup(groupId) {
  if (!groupId || groupId === DEFAULT_GROUP_ID) {
    throw new Error('默认分组不能删除');
  }
  const config = await loadContactGroupsConfig();
  const hit = (config.groups || []).find((g) => g.id === groupId);
  if (!hit) throw new Error('分组不存在');
  config.groups = config.groups.filter((g) => g.id !== groupId);
  if (config.lastSelectedGroupId === groupId) {
    config.lastSelectedGroupId = ALL_GROUPS_FILTER;
  }
  config.collapsedGroups = (config.collapsedGroups || []).filter((id) => id !== groupId);
  await saveContactGroupsConfig(config);
  const rows = await listCharacters();
  let moved = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (resolveCharacterGroupId(row) !== groupId) continue;
    await saveCharacter({ ...row, groupId: DEFAULT_GROUP_ID });
    moved += 1;
  }
  return { groupId, name: hit.name, moved };
}

/** 批量把角色移到目标分组；返回实际改动的人数。 */
export async function moveCharactersToGroup(characterIds, groupId) {
  const target = String(groupId || '').trim() || DEFAULT_GROUP_ID;
  const config = await loadContactGroupsConfig();
  const valid = new Set((config.groups || []).map((g) => g.id));
  if (!valid.has(target)) throw new Error('分组不存在');
  const ids = [...new Set(
    (Array.isArray(characterIds) ? characterIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  )];
  if (!ids.length) throw new Error('请先选择角色');
  const rows = await listCharacters();
  const byId = new Map(rows.map((r) => [r.id, r]));
  let moved = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const row = byId.get(ids[i]);
    if (!row) continue;
    if (resolveCharacterGroupId(row) === target) continue;
    await saveCharacter({ ...row, groupId: target });
    moved += 1;
  }
  return moved;
}

export async function setLastSelectedGroupId(groupId) {
  const config = await loadContactGroupsConfig();
  config.lastSelectedGroupId = groupId || ALL_GROUPS_FILTER;
  await saveContactGroupsConfig(config);
}

export function isGroupCollapsed(config, groupId) {
  const id = String(groupId || '').trim();
  return !!(config && Array.isArray(config.collapsedGroups) && config.collapsedGroups.includes(id));
}

export async function setGroupCollapsed(groupId, collapsed) {
  const id = String(groupId || '').trim();
  if (!id) return null;
  const config = await loadContactGroupsConfig();
  const set = new Set(config.collapsedGroups || []);
  if (collapsed) set.add(id);
  else set.delete(id);
  config.collapsedGroups = [...set];
  await saveContactGroupsConfig(config);
  return config;
}

export function filterCharactersByGroup(characters, groupId) {
  if (!groupId || groupId === ALL_GROUPS_FILTER) return characters;
  return characters.filter((c) => resolveCharacterGroupId(c) === groupId);
}

export async function importContactGroupsFromPayload(groups) {
  if (!Array.isArray(groups) || !groups.length) return;
  const config = await loadContactGroupsConfig();
  const map = new Map(config.groups.map((g) => [g.id, g]));
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    if (!g || !g.id || g.id === DEFAULT_GROUP_ID) continue;
    map.set(String(g.id), {
      id: String(g.id),
      name: String(g.name || '未命名').trim() || '未命名',
      // 老备份没有该字段：按旧语义视为组内互识，避免导入后行为突变
      mutualAcquaintance: typeof g.mutualAcquaintance === 'boolean' ? g.mutualAcquaintance : true,
    });
  }
  config.groups = [...map.values()];
  await saveContactGroupsConfig(config);
}
