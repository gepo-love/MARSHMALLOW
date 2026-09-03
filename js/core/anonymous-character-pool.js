import { listCharacters, getCharacter } from './character-store.js';
import { ANON_NPC_GROUP_ID } from './anonymous-npc.js';

function normalizeId(id) {
  return String(id || '').trim();
}

function isAnonNpcGroup(character) {
  return String(character?.groupId || '').trim() === ANON_NPC_GROUP_ID;
}

export function inferAnonymousRoleTier(character) {
  const explicit = String(character?.roleTier || '').trim();
  if (explicit === 'main' || explicit === 'supporting' || explicit === 'npc' || explicit === 'background') {
    return explicit === 'background' ? 'npc' : explicit;
  }
  const notes = String(character?.notes || character?.currentRole || '').trim();
  if (/路人|配角|背景|群众|npc/i.test(notes)) return 'npc';
  return 'main';
}

export function getAnonymousCharacterMeta(character) {
  const id = normalizeId(character?.id);
  const roleTier = isAnonNpcGroup(character) ? 'npc' : inferAnonymousRoleTier(character);
  const isCustom = character?.isCustom !== false;
  const priorityWeight = roleTier === 'main'
    ? (isCustom ? 4.2 : 5)
    : (roleTier === 'supporting' ? 1.8 : 0.62);
  return {
    id,
    isCustom,
    roleTier,
    roleLabel: roleTier === 'main'
      ? '主要角色'
      : (roleTier === 'supporting' ? '常驻角色' : '网友'),
    priorityWeight,
  };
}

/**
 * 匿名匹配候选：默认只用通讯录里的普通角色。
 * 生成的匿名 NPC（归在【匿名NPC】分组）默认不参与匹配，除非显式 includeNpcGroup。
 */
export async function loadAnonymousCharacterCandidates(options = {}) {
  const { includeNpcGroup = false, userId = '' } = options || {};
  const uid = normalizeId(userId);
  const scopedRows = await listCharacters({
    userId: uid,
    identityScoped: !!uid,
  });
  let rows = Array.isArray(scopedRows) ? scopedRows : [];
  // 匿名 NPC 是功能内部角色，不属于任何 user 面具；显式请求时单独合并，
  // 避免为保留 NPC 而重新放开其它面具的普通通讯录角色。
  if (includeNpcGroup) {
    const internalRows = await listCharacters({ includeInternal: true }).catch(() => []);
    const byId = new Map(rows.map((row) => [normalizeId(row?.id), row]));
    for (const row of internalRows) {
      if (row?.id && isAnonNpcGroup(row)) byId.set(normalizeId(row.id), row);
    }
    rows = [...byId.values()];
  }
  const list = rows
    .filter((c) => c?.id && c.id !== 'user')
    .filter((c) => includeNpcGroup || !isAnonNpcGroup(c));
  return list.map((c) => ({
    ...c,
    anonymousMeta: getAnonymousCharacterMeta(c),
  }));
}

export async function findAnonymousCharacterCandidateById(id) {
  const target = normalizeId(id);
  if (!target || target === 'user') return null;
  const stored = await getCharacter(target).catch(() => null);
  if (stored) {
    return { ...stored, anonymousMeta: getAnonymousCharacterMeta(stored) };
  }
  return null;
}

export async function getAnonymousRuntimeCharacterById(id) {
  const candidate = await findAnonymousCharacterCandidateById(id);
  if (!candidate) return null;
  const { anonymousMeta, ...runtimeOnly } = candidate;
  return runtimeOnly;
}

export function filterAnonymousCandidatesByLibrary(candidates, sourceLibrary = 'mixed') {
  const lib = String(sourceLibrary || 'mixed').trim();
  const rows = Array.isArray(candidates) ? candidates : [];
  if (lib === 'main_only') return rows.filter((c) => c?.anonymousMeta?.roleTier === 'main');
  if (lib === 'npc_only') return rows.filter((c) => c?.anonymousMeta?.roleTier === 'npc');
  return rows;
}
