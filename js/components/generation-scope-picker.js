import * as db from '../core/db.js';
import {
  loadContactGroupsConfig,
  resolveCharacterGroupId,
} from '../core/contact-groups.js';
import { openParticipantPicker } from './participant-picker.js';

const KEY_PREFIX = 'generationScope:';

function keyFor(scopeKey = 'social') {
  return `${KEY_PREFIX}${String(scopeKey || 'social').trim()}`;
}

async function loadSaved(scopeKey, fallbackScopeKey = '', defaultMode = 'all') {
  let row = await db.get(keyFor(scopeKey)).catch(() => null);
  if (!row && fallbackScopeKey && fallbackScopeKey !== scopeKey) {
    row = await db.get(keyFor(fallbackScopeKey)).catch(() => null);
  }
  const value = row?.value || {};
  const fallbackMode = ['all', 'group', 'characters', 'passersby'].includes(defaultMode)
    ? defaultMode
    : 'all';
  return {
    mode: ['all', 'group', 'characters', 'passersby'].includes(value.mode) ? value.mode : fallbackMode,
    groupId: String(value.groupId || ''),
    characterIds: Array.isArray(value.characterIds) ? value.characterIds.map(String) : [],
  };
}

async function saveScope(scopeKey, value) {
  await db.put({ key: keyFor(scopeKey), value });
}

/**
 * 静默读取某个生成入口上次保存的角色范围。
 * 用于发布后自动补互动，避免再次弹出范围选择器打断发布流程。
 */
export async function resolveSavedGenerationScope({
  scopeKey,
  fallbackScopeKey = '',
  characters = [],
  allowPassersbyOnly = false,
  defaultMode = 'all',
} = {}) {
  const rows = (Array.isArray(characters) ? characters : []).filter((row) => row?.id);
  if (!rows.length) {
    return {
      characters: [],
      scope: { mode: allowPassersbyOnly ? 'passersby' : 'all', groupId: '', characterIds: [] },
    };
  }
  const saved = await loadSaved(scopeKey, fallbackScopeKey, defaultMode);
  if (saved.mode === 'passersby' && allowPassersbyOnly) {
    return { characters: [], scope: saved };
  }
  if (saved.mode === 'group' && saved.groupId) {
    return {
      characters: rows.filter((row) => resolveCharacterGroupId(row) === saved.groupId),
      scope: saved,
    };
  }
  if (saved.mode === 'characters' && saved.characterIds.length) {
    const allowed = new Set(saved.characterIds);
    return {
      characters: rows.filter((row) => allowed.has(String(row.id))),
      scope: saved,
    };
  }
  return {
    characters: rows,
    scope: { mode: 'all', groupId: '', characterIds: [] },
  };
}

/**
 * 每个生成入口独立选择本轮允许出现的角色。
 * 返回 null 表示用户取消；否则返回过滤后的 characters 与本轮 scope。
 */
export async function pickGenerationScope({
  scopeKey,
  fallbackScopeKey = '',
  characters = [],
  title = '本轮出现范围',
  allowPassersbyOnly = false,
  passersbyLabel = '只用路人',
  defaultMode = 'all',
} = {}) {
  const rows = (Array.isArray(characters) ? characters : []).filter((row) => row?.id);
  if (!rows.length) return {
    characters: [],
    scope: { mode: allowPassersbyOnly ? 'passersby' : 'all' },
  };
  const saved = await loadSaved(scopeKey, fallbackScopeKey, defaultMode);
  const modeItems = [
    { id: 'all', name: '全部角色' },
    { id: 'group', name: '按通讯录分组' },
    { id: 'characters', name: '指定角色' },
  ];
  if (allowPassersbyOnly) modeItems.push({
    id: 'passersby',
    name: String(passersbyLabel || '只用路人').trim() || '只用路人',
  });
  const mode = await openParticipantPicker({
    title,
    items: modeItems,
    preselected: [saved.mode],
  });
  if (!mode) return null;

  if (mode === 'passersby' && allowPassersbyOnly) {
    const scope = { mode: 'passersby', groupId: '', characterIds: [] };
    await saveScope(scopeKey, scope);
    return { characters: [], scope };
  }

  if (mode === 'all') {
    const scope = { mode: 'all', groupId: '', characterIds: [] };
    await saveScope(scopeKey, scope);
    return { characters: rows, scope };
  }

  if (mode === 'group') {
    const config = await loadContactGroupsConfig();
    const groupId = await openParticipantPicker({
      title: '选择通讯录分组',
      items: (config.groups || []).map((group) => ({ id: group.id, name: group.name })),
      preselected: [saved.groupId],
    });
    if (!groupId) return null;
    const scope = { mode: 'group', groupId, characterIds: [] };
    await saveScope(scopeKey, scope);
    return {
      characters: rows.filter((row) => resolveCharacterGroupId(row) === groupId),
      scope,
    };
  }

  const picked = await openParticipantPicker({
    title: '指定本轮角色',
    items: rows.map((row) => ({
      id: row.id,
      name: row.customNickname || row.name || row.realName || row.id,
    })),
    searchable: true,
    multiple: true,
    preselected: saved.characterIds,
    confirmLabel: '使用所选角色',
  });
  if (!picked) return null;
  const characterIds = [...new Set(picked.map(String))];
  const allowed = new Set(characterIds);
  const scope = { mode: 'characters', groupId: '', characterIds };
  await saveScope(scopeKey, scope);
  return { characters: rows.filter((row) => allowed.has(String(row.id))), scope };
}
