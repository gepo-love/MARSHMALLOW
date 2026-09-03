import { createCharacterProfile, isPublicContactCharacter } from '../models/character.js';
import { importCharactersFromMarshmallow } from './character-store.js';

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file, 'UTF-8');
  });
}

export function parseBackupJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('不是有效的 JSON 备份文件');
  }
  if (!data || typeof data !== 'object') throw new Error('备份格式无效');

  const meta = data.__meta || {};
  const format = String(meta.format || data.format || '');

  if (format === 'marshmallow-characters' || Array.isArray(data.characters)) {
    return {
      source: 'marshmallow',
      format,
      meta,
      characters: (data.characters || []).filter((c) => c && c.id),
      groups: Array.isArray(data.groups) ? data.groups : [],
    };
  }

  if (format === 'glory-phone-backup' || data.idb) {
    const idb = data.idb || {};
    const characters = Array.isArray(idb.characters) ? idb.characters : [];
    return {
      source: 'glory-phone',
      format: format || 'glory-phone-backup',
      meta,
      characters: characters.filter((c) => c && c.id),
      hasFullBackup: true,
    };
  }

  if (Array.isArray(data)) {
    return {
      source: 'array',
      format: 'character-array',
      meta: {},
      characters: data.filter((c) => c && c.id),
    };
  }

  throw new Error('无法识别格式。请使用本应用导出的角色包 JSON（不支持酒馆等其他平台角色卡）。');
}

export const CHARACTER_JSON_SCOPE_NOTE = '角色包 JSON 仅用于本应用之间的迁移，不兼容酒馆、SillyTavern 等其他平台的角色卡格式。';

export function mapLegacyBackupCharacter(record) {
  if (!record || !record.id) return null;
  return createCharacterProfile({
    ...record,
    isCustom: record.isCustom !== false || String(record.id).startsWith('custom_'),
    roleTier: record.roleTier || record.anonymousRoleTier || record.roleTierHint,
  });
}

/** @deprecated 使用 mapLegacyBackupCharacter */
export const mapGloryCharacterToMarshmallow = mapLegacyBackupCharacter;

export async function importParsedBackup(parsed, options = {}) {
  const selectedIds = options.selectedIds;
  let rows = (parsed.characters || [])
    .map((row) => {
      if (parsed.source === 'glory-phone' || parsed.source === 'array') {
        return mapLegacyBackupCharacter(row);
      }
      return createCharacterProfile(row);
    })
    .filter((row) => row && isPublicContactCharacter(row));

  if (selectedIds && selectedIds.size) {
    rows = rows.filter((c) => selectedIds.has(c.id));
  }

  const payload = {
    format: 'marshmallow-characters',
    version: 2,
    characters: rows,
  };
  if (Array.isArray(parsed.groups) && parsed.groups.length) {
    payload.groups = parsed.groups;
  }
  return importCharactersFromMarshmallow(payload, { merge: options.merge !== false });
}

export async function importBackupFile(file, options = {}) {
  const text = await readFileText(file);
  const parsed = parseBackupJson(text);
  const result = await importParsedBackup(parsed, options);
  return { ...result, parsed };
}

export const IMPORT_GUIDE = {
  marshmallow: [
    '角色包 JSON 仅用于本应用之间的迁移（设置 → 导出全部通讯录，或编辑页「导出角色包」）。',
    '不兼容酒馆、SillyTavern、CharX 等其他平台的角色卡 JSON。',
    '选择本应用导出的 .json 文件，勾选要迁入的角色后点导入。',
    '同 id 的角色会合并字段（新值覆盖空字段，关系网会合并）。',
  ],
};
