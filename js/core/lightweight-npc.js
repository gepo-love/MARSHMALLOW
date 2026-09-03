import { createCharacterProfile, normalizeTranslationProfile } from '../models/character.js';
import * as db from './db.js';
import { getCharacter, listCharacters, saveCharacter } from './character-store.js';
import {
  loadRelationshipNetwork,
  saveRelationshipNetwork,
  removeActorFromRelationshipNetwork,
} from './relationship-network.js';
import { createPhoneSocialActorDirectory } from './phone-social-actor-directory.js';

const LIGHTWEIGHT_NPC_PREFIX = 'lightnpc_';
let ensureQueue = Promise.resolve();
let peerRepairQueue = Promise.resolve();

function clean(value = '', max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const MAX_NPC_AVATAR_CHARS = 900000;
function normalizeNpcAvatarUrl(value = '') {
  const url = String(value ?? '').trim();
  if (!url) return '';
  if (!/^(data:image\/|https?:\/\/)/i.test(url)) return '';
  return url.length <= MAX_NPC_AVATAR_CHARS ? url : '';
}

function nameKey(value = '') {
  return clean(value, 80).toLowerCase().replace(/[\s_\-./]+/g, '');
}

/**
 * 同名 NPC 已经分裂时也必须稳定选中一项，不能因为候选不唯一继续铸第三份。
 * 优先用户手动建立的无来源身份，其次当前会话使用过的身份，再取最早创建项。
 */
export function selectReusableRelationshipNpc(npcs = [], name = '', sourceChatId = '') {
  const key = nameKey(name);
  const chatId = clean(sourceChatId, 60);
  if (!key) return null;
  const rows = (Array.isArray(npcs) ? npcs : [])
    .filter((row) => row?.id && nameKey(row.name) === key);
  if (!rows.length) return null;
  // 群聊现场生成的 NPC 只能在当前会话内复用。过去仅凭同名跨聊天复用，
  // 会让两个本来无关的路人共享同一个 id；其中一处修改头像后，所有群都会跟着变。
  // 没有会话作用域的显式查询仍可稳定选中已有身份，供关系网管理等入口使用。
  const scopedRows = chatId
    ? rows.filter((row) => (Array.isArray(row?.sourceChatIds) ? row.sourceChatIds : []).includes(chatId))
    : rows;
  if (!scopedRows.length) return null;
  return scopedRows.slice().sort((a, b) => {
    const aSources = Array.isArray(a?.sourceChatIds) ? a.sourceChatIds : [];
    const bSources = Array.isArray(b?.sourceChatIds) ? b.sourceChatIds : [];
    const aManual = aSources.length ? 0 : 1;
    const bManual = bSources.length ? 0 : 1;
    if (aManual !== bManual) return bManual - aManual;
    const aCreated = Number(a?.createdAt) || Number.MAX_SAFE_INTEGER;
    const bCreated = Number(b?.createdAt) || Number.MAX_SAFE_INTEGER;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a.id).localeCompare(String(b.id));
  })[0] || null;
}

export function isReservedLightweightNpcIdentity(value = '', options = {}) {
  const key = nameKey(value);
  if (!key) return false;
  const reserved = [
    'user', '用户', '用户本人',
    '我', '我本人', '你', '你本人', '本人',
    '自己', '自己本人', '手机主人', '机主',
    options.userId,
    options.userName,
    options.ownerId,
    options.ownerName,
    ...(Array.isArray(options.userAliases) ? options.userAliases : []),
    ...(Array.isArray(options.ownerAliases) ? options.ownerAliases : []),
  ];
  return reserved.some((item) => nameKey(item) === key);
}

/**
 * 轻量 NPC 的 name 必须是可读姓名，不能接收角色 id、联系人 id 或明显的随机代码。
 * 这是最终写入边界；即使上游协议解析以后增加了新入口，也不能再把代码名落进关系网。
 */
export function isUnsafeLightweightNpcName(value = '') {
  const label = clean(value, 120);
  if (!label) return true;
  if (/[\u0000-\u001f\u007f\ufffd]/u.test(label)) return true;
  if (/^(?:char(?:_|\d)|npc_|lightnpc_|phone-(?:contact|group):)/i.test(label)) return true;
  if (/^(?:联系人|对方|TA)$/i.test(label)) return true;
  return /^(?:x[0-9a-f]{4,}|[0-9a-f]{8,})$/i.test(label);
}


function newLightweightNpcId() {
  return `${LIGHTWEIGHT_NPC_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isLightweightNpcId(id = '') {
  return String(id || '').startsWith(LIGHTWEIGHT_NPC_PREFIX);
}

export function buildLightweightNpcCharacter(npc = {}) {
  if (!npc?.id || !npc?.name) return null;
  return {
    id: npc.id,
    name: npc.name,
    realName: npc.name,
    customNickname: '',
    avatar: npc.avatar || '',
    personality: npc.personality || npc.note || '',
    speechStyle: npc.speechStyle || '',
    translationProfile: normalizeTranslationProfile(npc.translationProfile),
    notes: npc.note || '',
    roleTier: 'background',
    metadata: { isLightweightNpc: true },
    _lightweightNpc: true,
  };
}

export async function listLightweightNpcs(userId = '') {
  const net = await loadRelationshipNetwork(userId);
  return (net.npcs || [])
    .filter((npc) => npc?.id && isLightweightNpcId(npc.id))
    .map(buildLightweightNpcCharacter)
    .filter(Boolean);
}

export async function getLightweightNpc(id = '', userId = '') {
  const npcId = clean(id, 60);
  if (!npcId || !isLightweightNpcId(npcId)) return null;
  const net = await loadRelationshipNetwork(userId);
  const npc = (net.npcs || []).find((row) => row?.id === npcId);
  return buildLightweightNpcCharacter(npc);
}

async function updateLightweightNpcTranslationProfileUnlocked(id = '', translationProfile = {}, options = {}) {
  const npcId = clean(id, 240);
  if (!npcId || !isLightweightNpcId(npcId)) throw new Error('轻量 NPC 不存在');
  const scopeUserId = clean(options.userId, 160);
  const net = await loadRelationshipNetwork(scopeUserId);
  const index = (net.npcs || []).findIndex((row) => row?.id === npcId);
  if (index < 0) throw new Error('轻量 NPC 不存在');
  const npc = {
    ...net.npcs[index],
    translationProfile: normalizeTranslationProfile(translationProfile),
  };
  net.npcs = net.npcs.map((row, rowIndex) => (rowIndex === index ? npc : row));
  const saved = await saveRelationshipNetwork(net, scopeUserId);
  return buildLightweightNpcCharacter(
    (saved.npcs || []).find((row) => row?.id === npcId) || npc,
  );
}

export async function updateLightweightNpcTranslationProfile(id = '', translationProfile = {}, options = {}) {
  const previous = ensureQueue;
  let release;
  ensureQueue = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await updateLightweightNpcTranslationProfileUnlocked(id, translationProfile, options);
  } finally {
    release();
  }
}

async function updateLightweightNpcAvatarUnlocked(id = '', avatar = '', options = {}) {
  const npcId = clean(id, 240);
  const nextAvatar = normalizeNpcAvatarUrl(avatar);
  if (!npcId || !nextAvatar) return null;
  const scopeUserId = clean(options.userId, 160);
  const net = await loadRelationshipNetwork(scopeUserId);
  const index = (net.npcs || []).findIndex((row) => row?.id === npcId);
  if (index < 0) return null;
  const npc = {
    ...net.npcs[index],
    avatar: nextAvatar,
  };
  net.npcs = net.npcs.map((row, rowIndex) => (rowIndex === index ? npc : row));
  const saved = await saveRelationshipNetwork(net, scopeUserId);
  return buildLightweightNpcCharacter(
    (saved.npcs || []).find((row) => row?.id === npcId) || npc,
  );
}

/**
 * 手机联系人上传头像后覆盖关系网里的同一轻量 NPC。
 * 与自动铸造共用写锁，避免并发生成 NPC 时旧关系网快照反向盖回新头像。
 */
export async function updateLightweightNpcAvatar(id = '', avatar = '', options = {}) {
  const previous = ensureQueue;
  let release;
  ensureQueue = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await updateLightweightNpcAvatarUnlocked(id, avatar, options);
  } finally {
    release();
  }
}

function isDismissedMatch(entry, key, chatId = '') {
  if (!entry) return false;
  if (entry.nameKey && entry.nameKey !== key) return false;
  if (!entry.nameKey && !entry.id) return false;
  const scopes = Array.isArray(entry.sourceChatIds) ? entry.sourceChatIds : [];
  if (!scopes.length) return true;
  if (!chatId) return true;
  return scopes.includes(chatId);
}

export function isLightweightNpcDismissed(net = {}, { name = '', id = '', sourceChatId = '' } = {}) {
  const key = nameKey(name);
  const npcId = clean(id, 60);
  const chatId = clean(sourceChatId, 60);
  return (net.dismissedNpcs || []).some((entry) => {
    if (npcId && entry.id && entry.id === npcId) return true;
    return key ? isDismissedMatch(entry, key, chatId) : false;
  });
}

function pruneNpcFromNetwork(net, npcId) {
  return removeActorFromRelationshipNetwork(net, npcId);
}

/**
 * 用户主动移除轻量 NPC：删实体、记黑名单，并清理相关二人窗 / 群成员引用。
 * 之后同名同群不会再被 ensureLightweightNpc 自动建回。
 */
export async function dismissLightweightNpc(id = '', options = {}) {
  const npcId = clean(id, 60);
  const scopeUserId = clean(options.userId, 120);
  const net = await loadRelationshipNetwork(scopeUserId).catch(() => ({ version: 2, npcs: [], circles: [], dismissedNpcs: [] }));
  const npc = (net.npcs || []).find((row) => row?.id === npcId) || null;
  if (!npcId || (!isLightweightNpcId(npcId) && !npc)) {
    return { ok: false, reason: 'not-relationship-npc' };
  }
  const label = clean(options.name || npc?.name, 24);
  const key = options.blockName === false ? '' : nameKey(label);
  const sourceChatIds = [...new Set([
    ...(npc?.sourceChatIds || []),
    ...(Array.isArray(options.sourceChatIds) ? options.sourceChatIds : []),
  ].map((item) => clean(item, 60)).filter(Boolean))].slice(0, 20);

  let next = pruneNpcFromNetwork(net, npcId);
  if (key || npcId) {
    const dismissed = {
      id: npcId,
      nameKey: key,
      // 手机侧移除默认全局生效，避免只删会话后同名又被建回。
      sourceChatIds: options.global !== false ? [] : sourceChatIds,
      dismissedAt: Date.now(),
    };
    next = {
      ...next,
      dismissedNpcs: [
        ...(next.dismissedNpcs || []).filter((entry) => (
          entry?.id !== npcId && !(key && entry?.nameKey === key && !(entry.sourceChatIds || []).length)
        )),
        dismissed,
      ].slice(-200),
    };
  }
  await saveRelationshipNetwork(next, scopeUserId);

  let deletedChats = 0;
  let updatedGroups = 0;
  if (options.purgeChats !== false) {
    const chats = await db.getAllRecords('chats').catch(() => []);
    for (const chat of chats || []) {
      if (scopeUserId && String(chat?.userId || '') !== scopeUserId) continue;
      const participants = (chat?.participants || []).filter((pid) => pid && pid !== 'user');
      if (!participants.includes(npcId)) continue;
      if (chat.type === 'group') {
        const gs = chat.groupSettings || {};
        await db.putRecord('chats', {
          ...chat,
          participants: (chat.participants || []).filter((pid) => pid !== npcId),
          groupSettings: {
            ...gs,
            admins: Array.isArray(gs.admins) ? gs.admins.filter((pid) => pid !== npcId) : gs.admins,
            muted: Array.isArray(gs.muted) ? gs.muted.filter((pid) => pid !== npcId) : gs.muted,
            owner: gs.owner === npcId ? null : gs.owner,
          },
        });
        updatedGroups += 1;
      } else {
        const { deleteChatWithData } = await import('./chat-store.js');
        await deleteChatWithData(chat.id, chat.userId);
        deletedChats += 1;
      }
    }
  }
  return { ok: true, deletedChats, updatedGroups, name: label };
}

/**
 * 修复旧版 actor 解析把通讯录主角色误建成 lightnpc_ 后产生的错误双人窗。
 * 仅处理 peer_private、恰好一名正式角色 + 一名轻量 NPC，且轻量 NPC 姓名唯一精确命中
 * 通讯录主角色的无歧义场景；把消息 senderId 和会话 participants 一并迁回正式角色。
 */
export async function repairMisclassifiedPeerPrivateCharacters(userId = '') {
  const uid = clean(userId, 160);
  if (!uid) return { changed: 0, movedMessages: 0 };
  const task = peerRepairQueue.then(async () => {
    const [characters, lightweightNpcs, chats] = await Promise.all([
      listCharacters().catch(() => []),
      listLightweightNpcs(uid).catch(() => []),
      db.getAllByIndex('chats', 'userId', uid).catch(() => []),
    ]);
    const uniqueCharacterByName = new Map();
    const ambiguousNames = new Set();
    for (const row of characters) {
      const aliases = [row?.name, row?.realName, row?.customNickname, ...(Array.isArray(row?.aliases) ? row.aliases : [])];
      for (const alias of aliases) {
        const key = nameKey(alias);
        if (!key || ambiguousNames.has(key)) continue;
        const previous = uniqueCharacterByName.get(key);
        if (previous && previous.id !== row.id) {
          uniqueCharacterByName.delete(key);
          ambiguousNames.add(key);
        } else {
          uniqueCharacterByName.set(key, row);
        }
      }
    }
    const lightById = new Map(lightweightNpcs.map((row) => [row.id, row]));
    const peerKey = (ids = []) => [...new Set(ids.filter(Boolean))].sort().join(',');
    let changed = 0;
    let movedMessages = 0;

    for (const chat of chats) {
      if (String(chat?.metadata?.channel || '') !== 'peer_private') continue;
      const participants = [...new Set((chat.participants || []).filter((id) => id && id !== 'user' && id !== 'system'))];
      if (participants.length !== 2) continue;
      const lightIds = participants.filter(isLightweightNpcId);
      if (lightIds.length !== 1) continue;
      const lightId = lightIds[0];
      const lightweight = lightById.get(lightId);
      const canonical = uniqueCharacterByName.get(nameKey(lightweight?.name));
      if (!canonical?.id || participants.includes(canonical.id)) continue;

      const canonicalParticipants = participants.map((id) => id === lightId ? canonical.id : id);
      const canonicalKey = peerKey(canonicalParticipants);
      const existing = chats.find((candidate) => (
        candidate?.id !== chat.id
        && String(candidate?.metadata?.channel || '') === 'peer_private'
        && peerKey((candidate.participants || []).filter((id) => id && id !== 'user' && id !== 'system')) === canonicalKey
      )) || null;
      const messages = await db.getAllByIndex('messages', 'chatId', chat.id).catch(() => []);
      const targetChatId = existing?.id || chat.id;
      const rewritten = messages.map((message) => {
        const metadata = { ...(message.metadata || {}) };
        if (message.senderId === lightId) delete metadata.lightweightNpc;
        return {
          ...message,
          chatId: targetChatId,
          senderId: message.senderId === lightId ? canonical.id : message.senderId,
          senderName: message.senderId === lightId
            ? (canonical.realName || canonical.name || message.senderName)
            : message.senderName,
          metadata,
        };
      });
      if (rewritten.length) {
        await db.putMany('messages', rewritten);
        movedMessages += rewritten.length;
      }

      if (existing) {
        const linked = new Set([
          ...(existing.metadata?.linkedParentChatIds || []),
          ...(chat.metadata?.linkedParentChatIds || []),
          existing.metadata?.parentChatId,
          chat.metadata?.parentChatId,
        ].filter(Boolean));
        const visible = rewritten
          .filter((row) => row && !row.deleted && !row.recalled && row.senderId !== 'system' && !row.metadata?.plotExplain)
          .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
        const last = visible[visible.length - 1];
        await db.putRecord('chats', {
          ...existing,
          lastActivity: Math.max(Number(existing.lastActivity || 0), Number(chat.lastActivity || 0), Number(last?.timestamp || 0)),
          lastMessage: Number(chat.lastActivity || 0) >= Number(existing.lastActivity || 0)
            ? (chat.lastMessage || existing.lastMessage || '')
            : (existing.lastMessage || chat.lastMessage || ''),
          metadata: { ...(existing.metadata || {}), linkedParentChatIds: [...linked] },
        });
        await db.deleteRecord('chats', chat.id);
        await db.remove(`chatPrefs_${chat.id}`).catch(() => {});
      } else {
        await db.putRecord('chats', {
          ...chat,
          participants: canonicalParticipants,
          metadata: {
            ...(chat.metadata || {}),
            peerPrivateKey: canonicalKey,
            focalActorId: chat.metadata?.focalActorId === lightId ? canonical.id : chat.metadata?.focalActorId,
          },
        });
      }
      changed += 1;
    }
    return { changed, movedMessages };
  });
  peerRepairQueue = task.catch(() => {});
  return task;
}

/**
 * 同一个群内按名字稳定复用轻量 NPC；不同群里的同名路人保持为不同人物。
 * 角色手机视角下，优先复用该机通讯录里的轻量联系人（phone-contact:），
 * 不再为已有联系人另铸一份 lightnpc_。
 */
async function ensureLightweightNpcUnlocked({
  name = '',
  sourceChatId = '',
  note = '',
  personality = '',
  speechStyle = '',
  translationProfile = null,
  avatar = '',
  phoneUserId = '',
  phoneOwnerId = '',
  userId = '',
  userName = '',
  userAliases = [],
  ownerName = '',
  ownerAliases = [],
} = {}) {
  const rawLabel = clean(name, 120);
  if (isUnsafeLightweightNpcName(rawLabel)) return null;
  const label = clean(rawLabel, 24);
  const chatId = clean(sourceChatId, 60);
  if (!label) throw new Error('轻量 NPC 缺少名字');
  if (isReservedLightweightNpcIdentity(label, {
    userId: userId || phoneUserId,
    userName,
    userAliases,
    ownerId: phoneOwnerId,
    ownerName,
    ownerAliases,
  })) return null;

  const phoneUser = clean(phoneUserId, 160);
  const phoneOwner = clean(phoneOwnerId, 160);
  let loadedNet = null;
  if (phoneUser && phoneOwner) {
    try {
      const {
        loadCharacterPhoneContacts,
        buildPhoneLightContactCharacter,
      } = await import('./character-phone-contacts.js');
      const [state, characters, relationshipNet] = await Promise.all([
        loadCharacterPhoneContacts(phoneUser, phoneOwner).catch(() => null),
        listCharacters({ includeInternal: true }).catch(() => []),
        loadRelationshipNetwork(phoneUser || userId).catch(() => null),
      ]);
      loadedNet = relationshipNet;
      const directory = createPhoneSocialActorDirectory({
        ownerId: phoneOwner,
        characters,
        relationshipNetwork: relationshipNet,
        contacts: state?.contacts || [],
        removedLinkedCharacterIds: state?.removedLinkedCharacterIds || [],
        removedLinkedActorIds: state?.removedLinkedActorIds || [],
      });
      const actor = directory.resolve('', { name: label });
      if (actor && directory.candidates.some((candidate) => candidate.id === actor.id)) {
        if (actor.character) return actor.character;
        if (actor.contact) {
          return { ...buildPhoneLightContactCharacter(actor.contact, phoneOwner), id: actor.id };
        }
        if (actor.npc) return buildLightweightNpcCharacter(actor.npc);
      }
    } catch (_) { /* 手机通讯录读失败时退回关系网铸造 */ }
  }

  const scopeUserId = clean(phoneUser || userId, 160);
  const net = loadedNet || await loadRelationshipNetwork(scopeUserId).catch(() => ({
    version: 2,
    npcs: [],
    circles: [],
    dismissedNpcs: [],
  }));
  if (isLightweightNpcDismissed(net, { name: label, sourceChatId: chatId })) {
    return null;
  }
  // 同一会话内同名稳定复用；不同聊天不再仅凭姓名合并身份。
  let npc = selectReusableRelationshipNpc(net.npcs || [], label, chatId);
  if (!npc) {
    npc = {
      id: newLightweightNpcId(),
      name: label,
      note: clean(note, 60),
      personality: clean(personality, 280),
      speechStyle: clean(speechStyle, 120),
      translationProfile: normalizeTranslationProfile(translationProfile),
      avatar: normalizeNpcAvatarUrl(avatar),
      sourceChatIds: chatId ? [chatId] : [],
      createdAt: Date.now(),
    };
    net.npcs = [...(net.npcs || []), npc];
  } else {
    npc.name = npc.name || label;
    npc.note = npc.note || clean(note, 60);
    npc.personality = npc.personality || clean(personality, 280);
    npc.speechStyle = npc.speechStyle || clean(speechStyle, 120);
    if (translationProfile && typeof translationProfile === 'object') {
      npc.translationProfile = normalizeTranslationProfile(translationProfile);
    }
    npc.avatar = npc.avatar || normalizeNpcAvatarUrl(avatar);
    npc.sourceChatIds = [...new Set([...(npc.sourceChatIds || []), chatId].filter(Boolean))].slice(0, 20);
  }
  const saved = await saveRelationshipNetwork(net, scopeUserId);
  const row = (saved.npcs || []).find((item) => item.id === npc.id) || npc;
  return buildLightweightNpcCharacter(row);
}

export async function ensureLightweightNpc(options = {}) {
  const previous = ensureQueue;
  let release;
  ensureQueue = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await ensureLightweightNpcUnlocked(options);
  } finally {
    release();
  }
}

/**
 * 保留原 id 转正，群成员引用与历史消息无需迁移。
 */
export async function promoteLightweightNpcToCharacter(id = '', options = {}) {
  const npcId = clean(id, 60);
  const existing = await getCharacter(npcId).catch(() => null);
  if (existing) return { character: existing, alreadyPromoted: true };
  const scopeUserId = clean(options.userId, 160);
  const net = await loadRelationshipNetwork(scopeUserId);
  const npc = (net.npcs || []).find((row) => row?.id === npcId);
  if (!npc || !isLightweightNpcId(npc.id)) throw new Error('轻量 NPC 不存在');
  const character = await saveCharacter(createCharacterProfile({
    id: npc.id,
    name: npc.name,
    avatar: npc.avatar || null,
    personality: npc.personality || npc.note || '',
    speechStyle: npc.speechStyle || '',
    translationProfile: normalizeTranslationProfile(npc.translationProfile),
    notes: npc.note || '',
    roleTier: 'npc',
    groupId: options.groupId || 'default',
    isCustom: true,
  }));
  net.npcs = (net.npcs || []).filter((row) => row?.id !== npc.id);
  await saveRelationshipNetwork(net, scopeUserId);
  return { character, alreadyPromoted: false };
}

/**
 * 把旧版本仅写在消息上的 npc_ 发言标签迁移成群内轻量 NPC。
 * 手机视角传入 phoneUserId/phoneOwnerId 时，优先落到手机通讯录联系人。
 */
export async function migrateEphemeralNpcMessagesForChat(chat, messages = [], options = {}) {
  if (chat?.type !== 'group' || !chat?.id) {
    return { chat, messages, characters: [], changed: 0 };
  }
  const rows = Array.isArray(messages) ? messages : [];
  const byLabel = new Map();
  const repairedByKey = new Map();
  const changedRows = [];
  let changed = 0;
  const phoneUserId = clean(options.phoneUserId, 160);
  const phoneOwnerId = clean(options.phoneOwnerId || options.phoneViewerId, 160);
  const scopeUserId = clean(options.userId || phoneUserId, 160);
  const net = await loadRelationshipNetwork(scopeUserId).catch(() => ({ npcs: [] }));
  const npcById = new Map((net.npcs || []).filter((row) => row?.id).map((row) => [String(row.id), row]));
  const storedIdentityAliases = (
    chat?.metadata?.lightweightNpcIdentityAliases
    && typeof chat.metadata.lightweightNpcIdentityAliases === 'object'
  ) ? { ...chat.metadata.lightweightNpcIdentityAliases } : {};
  let aliasesChanged = false;
  const repairKey = (actorId, label) => `${clean(actorId, 240)}::${nameKey(label)}`;
  const labelsByActorId = new Map();
  for (const row of rows) {
    const actorId = clean(row?.senderId, 160);
    const labelKey = nameKey(row?.senderName);
    if (!actorId || !labelKey) continue;
    if (!labelsByActorId.has(actorId)) labelsByActorId.set(actorId, new Set());
    labelsByActorId.get(actorId).add(labelKey);
  }
  for (const message of rows) {
    const rawId = clean(message?.senderId, 160);
    if (!message || !rawId || rawId === 'user' || rawId === 'system') continue;
    const label = clean(message.senderName, 24)
      || clean(rawId.replace(/^(?:npc_)+/i, ''), 24)
      || '路人';
    const isEphemeral = message.metadata?.ephemeralNpc === true
      || (/^npc_/i.test(rawId) && !npcById.has(rawId));
    const sourceNpc = npcById.get(rawId) || null;
    const identityMismatch = !!sourceNpc
      && !!label
      && nameKey(sourceNpc.name) !== nameKey(label)
      // 单纯改过 NPC 名字也会让旧消息名与当前卡片名不同，不能据此拆身份。
      // 只有同一群页内同一个 id 同时对应多个发言名，才属于可确定的串绑。
      && (labelsByActorId.get(rawId)?.size || 0) > 1;
    const identityKey = repairKey(rawId, label);
    const storedTargetId = clean(storedIdentityAliases[identityKey], 160);
    if (!isEphemeral && !identityMismatch && !storedTargetId) continue;
    let lightweight = byLabel.get(label);
    if (!lightweight && storedTargetId) {
      lightweight = repairedByKey.get(identityKey)
        || await getLightweightNpc(storedTargetId, scopeUserId).catch(() => null)
        || buildLightweightNpcCharacter(npcById.get(storedTargetId));
    }
    if (!lightweight) {
      lightweight = await ensureLightweightNpc({
        name: label,
        sourceChatId: chat.id,
        note: `来自「${chat.groupSettings?.name || '群聊'}」`,
        userId: scopeUserId,
        phoneUserId,
        phoneOwnerId,
      });
      if (!lightweight) continue;
      byLabel.set(label, lightweight);
    }
    repairedByKey.set(identityKey, lightweight);
    if (identityMismatch && storedIdentityAliases[identityKey] !== lightweight.id) {
      storedIdentityAliases[identityKey] = lightweight.id;
      aliasesChanged = true;
    }
    const metadata = { ...(message.metadata || {}), lightweightNpc: true };
    delete metadata.ephemeralNpc;
    message.senderId = lightweight.id;
    message.senderName = lightweight.name;
    if (identityMismatch) metadata.npcIdentityRepaired = true;
    message.metadata = metadata;
    changedRows.push(message);
    changed += 1;
  }
  const characters = [...new Map(
    [...byLabel.values(), ...repairedByKey.values()]
      .filter(Boolean)
      .map((row) => [row.id, row]),
  ).values()];
  if (!changed && !aliasesChanged) return { chat, messages: rows, characters, changed: 0 };
  chat.participants = [...new Set([
    ...(chat.participants || []),
    ...characters.map((row) => row.id),
  ])];
  if (aliasesChanged) {
    chat.metadata = {
      ...(chat.metadata || {}),
      lightweightNpcIdentityAliases: storedIdentityAliases,
    };
  }
  await Promise.all([
    Promise.all(changedRows.map(async (message) => {
      const stored = await db.getRecord('messages', message.id).catch(() => null);
      const metadata = { ...(stored?.metadata || {}), ...(message.metadata || {}), lightweightNpc: true };
      delete metadata.ephemeralNpc;
      await db.putRecord('messages', {
        ...(stored || {}),
        ...message,
        // 首屏可能使用了延迟媒体副本；落库迁移时保留 IndexedDB 中的完整内容。
        content: stored?.content ?? message.content,
        metadata,
      });
    })),
    db.putRecord('chats', chat),
  ]);
  return { chat, messages: rows, characters, changed };
}
