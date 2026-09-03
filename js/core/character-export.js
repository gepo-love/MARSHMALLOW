import { loadContactGroupsConfig } from './contact-groups.js';
import { listCharacters } from './character-store.js';
import { downloadJson as downloadJsonNative } from './native-download.js';

export function downloadJsonFile(data, filename) {
  return downloadJsonNative(data, filename);
}

export async function buildCharactersExportPayload(options = {}) {
  const characters = options.characters || await listCharacters({ excludeAnonNpc: true });
  const includeGroups = options.includeGroups !== false;
  const groupId = options.groupId;
  const groupLabel = options.groupLabel || '';

  let list = characters;
  if (groupId && groupId !== '__all__') {
    list = characters.filter((c) => {
      const gid = String(c.groupId || 'default').trim() || 'default';
      return gid === groupId;
    });
  }

  const payload = {
    format: 'marshmallow-characters',
    version: 2,
    exportedAt: Date.now(),
    characters: list,
  };

  if (groupId && groupId !== '__all__') {
    payload.groupId = groupId;
    if (groupLabel) payload.groupLabel = groupLabel;
  }

  if (includeGroups) {
    const config = await loadContactGroupsConfig();
    const requestedGroupIds = Array.isArray(options.groupIds)
      ? new Set(options.groupIds.map((id) => String(id || '').trim()).filter(Boolean))
      : null;
    payload.groups = requestedGroupIds
      ? config.groups.filter((group) => requestedGroupIds.has(group.id))
      : config.groups;
  }

  return payload;
}

export async function downloadCharactersExport(options = {}) {
  const payload = await buildCharactersExportPayload(options);
  const count = payload.characters?.length || 0;
  let name = `marshmallow-characters-${count}`;
  if (payload.groupLabel) {
    name += `-${payload.groupLabel}`;
  }
  name += `-${Date.now()}.json`;
  await downloadJsonFile(payload, name);
  return payload;
}

export async function downloadSingleCharacterExport(character) {
  if (!character || !character.id) throw new Error('无效角色');
  const groupId = String(character.groupId || 'default').trim() || 'default';
  const config = await loadContactGroupsConfig();
  const payload = {
    format: 'marshmallow-characters',
    version: 2,
    exportedAt: Date.now(),
    characters: [character],
    groups: config.groups.filter((group) => group.id === groupId),
  };
  const safeName = String(character.name || character.id).replace(/[\\/:*?"<>|]/g, '_');
  await downloadJsonFile(payload, `character-${safeName}-${Date.now()}.json`);
  return payload;
}
