import {
  isGroupMutualAcquaintance,
  loadContactGroupsConfig,
  resolveCharacterGroupId,
} from './contact-groups.js';
import {
  collectCoNetworkMemberIds,
  loadRelationshipNetwork,
} from './relationship-network.js';
import {
  findLedgerEntry,
  loadAcquaintanceLedger,
} from './acquaintance-ledger.js';

function cleanId(value = '') {
  return String(value || '').trim();
}

function hasExplicitRelationship(from, toId) {
  const id = cleanId(toId);
  if (!id || !from?.relationships || typeof from.relationships !== 'object') return false;
  return !!String(from.relationships[id] || '').trim();
}

export function hasRelationshipNetworkOverride(
  ownerId = '',
  candidateId = '',
  relationshipNetwork = null,
) {
  const ownerKey = cleanId(ownerId);
  const candidateKey = cleanId(candidateId);
  if (!ownerKey || !candidateKey || ownerKey === candidateKey) return false;
  return collectCoNetworkMemberIds(relationshipNetwork, [ownerKey]).includes(candidateKey);
}

export function isUnauthorizedCrossGroupCharacterPair(
  left = null,
  right = null,
  relationshipNetwork = null,
) {
  const leftId = cleanId(left?.id);
  const rightId = cleanId(right?.id);
  if (!leftId || !rightId || leftId === rightId) return false;
  if (resolveCharacterGroupId(left) === resolveCharacterGroupId(right)) return false;
  return !hasRelationshipNetworkOverride(leftId, rightId, relationshipNetwork);
}

/**
 * 判断两个角色是否已建立社交联系。
 * 不同通讯录分组默认硬隔离；只有用户显式维护的关系网可以跨组放行。
 * 角色卡 relationships、剧情认识账本与旧聊天只在同组内生效，不能静默打穿分组边界。
 * 同组仍需满足：关系网、角色卡关系、认识账本，或该组显式开启「组内互识」。
 * 已存在的越界窗口由手机列表隐藏，并可在「数据自检」中确认清理。
 */
export function canPhoneCharactersKnowEachOther(
  owner,
  candidate,
  relationshipNetwork = null,
  contactGroupsConfig = null,
  acquaintanceLedger = null,
) {
  const ownerId = cleanId(owner?.id);
  const candidateId = cleanId(candidate?.id);
  if (!ownerId || !candidateId || ownerId === candidateId || candidateId === 'user') return false;
  const networkOverride = hasRelationshipNetworkOverride(
    ownerId,
    candidateId,
    relationshipNetwork,
  );
  if (networkOverride) return true;
  if (isUnauthorizedCrossGroupCharacterPair(owner, candidate, relationshipNetwork)) return false;
  const ownerGroupId = resolveCharacterGroupId(owner);
  if (hasExplicitRelationship(owner, candidateId) || hasExplicitRelationship(candidate, ownerId)) return true;
  if (findLedgerEntry(acquaintanceLedger, ownerId, candidateId)) return true;
  return isGroupMutualAcquaintance(contactGroupsConfig, ownerGroupId);
}

/**
 * 跨窗落库前的统一二次门禁。仅主通讯录角色对参与该判定；
 * 手机本地联系人由 owner 作用域的通讯录负责授权。
 */
export async function canPhoneCharacterIdsKnowEachOther(aId = '', bId = '', userId = '') {
  const leftId = cleanId(aId);
  const rightId = cleanId(bId);
  if (!leftId || !rightId || leftId === rightId) return false;
  const { getCharacter } = await import('./character-store.js');
  const [left, right, relationshipNetwork, contactGroupsConfig, acquaintanceLedger] = await Promise.all([
    getCharacter(leftId, { userId }),
    getCharacter(rightId, { userId }),
    loadRelationshipNetwork(userId),
    loadContactGroupsConfig(),
    loadAcquaintanceLedger(),
  ]);
  // 非主通讯录 actor（手机本地联系人 / 轻量 NPC）交给调用入口的 owner 作用域校验。
  if (!left || !right) return null;
  return canPhoneCharactersKnowEachOther(
    left,
    right,
    relationshipNetwork,
    contactGroupsConfig,
    acquaintanceLedger,
  );
}

export function findIneligiblePhoneSocialParticipantPair(
  ids = [],
  characterMap,
  relationshipNetwork = null,
  contactGroupsConfig = null,
  acquaintanceLedger = null,
) {
  const map = characterMap instanceof Map
    ? characterMap
    : new Map(Object.values(characterMap || {}).map((row) => [cleanId(row?.id), row]));
  const participantIds = [...new Set((Array.isArray(ids) ? ids : [])
    .map(cleanId)
    .filter((id) => id && id !== 'user' && id !== 'system'))];
  for (let i = 0; i < participantIds.length; i += 1) {
    for (let j = i + 1; j < participantIds.length; j += 1) {
      const left = map.get(participantIds[i]);
      const right = map.get(participantIds[j]);
      // 手机本地联系人和轻量 NPC 没有全局分组，由 owner 作用域通讯录授权。
      if (!left || !right) continue;
      if (!canPhoneCharactersKnowEachOther(
        left,
        right,
        relationshipNetwork,
        contactGroupsConfig,
        acquaintanceLedger,
      )) return { leftId: left.id, rightId: right.id };
    }
  }
  return null;
}

export async function checkPhoneSocialParticipantIds(ids = [], userId = '') {
  const { listCharacters } = await import('./character-store.js');
  const [characters, relationshipNetwork, contactGroupsConfig, acquaintanceLedger] = await Promise.all([
    listCharacters({ includeInternal: true, userId }),
    loadRelationshipNetwork(userId),
    loadContactGroupsConfig(),
    loadAcquaintanceLedger(),
  ]);
  const pair = findIneligiblePhoneSocialParticipantPair(
    ids,
    new Map(characters.map((row) => [cleanId(row?.id), row])),
    relationshipNetwork,
    contactGroupsConfig,
    acquaintanceLedger,
  );
  return { allowed: !pair, pair };
}

export function filterPhoneSocialCharacterIds(
  owner,
  ids = [],
  characterMap,
  relationshipNetwork = null,
  contactGroupsConfig = null,
  acquaintanceLedger = null,
) {
  const map = characterMap instanceof Map ? characterMap : new Map();
  return [...new Set((Array.isArray(ids) ? ids : []).map(cleanId).filter(Boolean))]
    .filter((id) => canPhoneCharactersKnowEachOther(
      owner,
      map.get(id),
      relationshipNetwork,
      contactGroupsConfig,
      acquaintanceLedger,
    ));
}
