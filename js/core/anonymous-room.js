import { createChat } from '../models/chat.js';
import { saveChat } from './chat-store.js';
import { getNowForUser } from './time-mode.js';
import {
  ensureUniqueAnonymousIdentityMap,
  buildFallbackAnonymousName,
  isAnonymousHandleReserved,
  mintAnonymousHandleAvoiding,
} from './anonymous-chat.js';
import {
  attachNetworkProfilesToIdentityMap,
  ensureAnonymousNetworkProfiles,
} from './anonymous-network-profile.js';
import {
  buildUserAnonymousIdentitySeed,
  loadAnonymousSpaceState,
  loadAnonymousSpaceUserProfile,
  loadUserReservedAnonymousAvatars,
  loadUserReservedAnonymousHandles,
  normalizeAnonymousSpaceProfile,
} from './anonymous-space.js';
import { getAnonymousRoomTopicTemplate, getAnonymousMemoryModeById } from '../data/anonymous-room-presets.js';
import { loadAnonymousCharacterCandidates } from './anonymous-character-pool.js';
import {
  generateAnonymousNpcProfiles,
  persistAnonymousNpcs,
  generateAnonymousAliasesForActors,
} from './anonymous-npc.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

export async function createAnonymousGroupRoom({
  userId,
  userRow = null,
  roomName = '',
  topicTemplateId = 'lounge',
  customTopic = '',
  customDescription = '',
  memberIds = [],
  memoryMode = 'inherit_full',
  includeSelf = true,
  observerMode = false,
  npcConfig = null,
  roomWorldview = null,
  maskMode = 'ai',
  onPhase = null,
} = {}) {
  const uid = clean(userId);
  if (!uid) throw new Error('未登录');
  const template = getAnonymousRoomTopicTemplate(topicTemplateId);
  const topic = clean(customTopic) || template.topic || '闲聊';
  const name = clean(roomName) || `${topic} · 匿名房`;
  const description = clean(customDescription) || template.label;
  const memMode = getAnonymousMemoryModeById(memoryMode).id;
  const wv = roomWorldview && typeof roomWorldview === 'object' ? roomWorldview : {};
  const roomWorldviewText = clean(wv.worldview);
  const roomWorldBookId = clean(wv.worldBookId);
  const roomAuPresetId = clean(wv.auPresetId);

  const aiMembers = [...new Set((Array.isArray(memberIds) ? memberIds : []).map(clean).filter((id) => id && id !== 'user'))];
  const availableCharacters = await loadAnonymousCharacterCandidates({ userId: uid });
  const availableCharacterMap = new Map(availableCharacters.map((row) => [clean(row?.id), row]));
  if (aiMembers.some((id) => !availableCharacterMap.has(id))) {
    throw new Error('所选成员中有角色不属于当前面具');
  }

  // 现场生成路人（匿名 ID 由 AI 现填，不继承马甲）
  const npc = npcConfig && typeof npcConfig === 'object' ? npcConfig : {};
  const npcEnabled = npc.enabled === true;
  const npcCount = npcEnabled ? Math.max(0, Math.min(6, Number(npc.count) || 0)) : 0;
  const reservedHandles = await loadUserReservedAnonymousHandles(userRow);
  const reservedAvatars = await loadUserReservedAnonymousAvatars(userRow);
  let generatedNpcs = [];
  if (npcCount > 0) {
    if (typeof onPhase === 'function') onPhase('召唤路人网友');
    const profiles = await generateAnonymousNpcProfiles({
      count: npcCount,
      vibe: clean(npc.vibe),
      worldview: clean(npc.worldview) || roomWorldviewText,
      roomTopic: topic,
      reservedHandles,
    });
    const persist = npc.persist === true;
    const persisted = await persistAnonymousNpcs(profiles, { ephemeral: !persist });
    generatedNpcs = persisted.map((row, idx) => ({
      ...row,
      ephemeral: !persist,
      signature: row.signature || profiles[idx]?.signature || '',
    }));
  }
  const npcIds = generatedNpcs.map((n) => n.actorId);

  if (aiMembers.length + npcIds.length < 2) throw new Error('请至少凑够 2 位成员（可勾选路人补足）');

  const participants = includeSelf ? ['user', ...aiMembers, ...npcIds] : [...aiMembers, ...npcIds];
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 开局给选中的角色按人设定制马甲（maskMode='ai'）
  let aiAliasMap = {};
  let aliasMeta = null;
  if (maskMode === 'ai' && aiMembers.length) {
    if (typeof onPhase === 'function') onPhase('给大家分配马甲');
    const realChars = aiMembers.map((id) => availableCharacterMap.get(id)).filter(Boolean);
    aliasMeta = await generateAnonymousAliasesForActors(realChars, {
      roomTopic: topic,
      vibe: description,
      required: true,
      reservedHandles,
    }).catch((err) => {
      throw err;
    });
    aiAliasMap = aliasMeta.aliases || {};
  }

  const identitiesDraft = {};
  identitiesDraft.user = await buildUserAnonymousIdentitySeed(uid, { nonce, userRow });
  for (const aid of aiMembers) {
    if (aiAliasMap[aid]?.currentId) {
      const aliasId = clean(aiAliasMap[aid].currentId);
      identitiesDraft[aid] = {
        currentId: isAnonymousHandleReserved(aliasId, reservedHandles)
          ? mintAnonymousHandleAvoiding(aid, `${nonce}|ai|${aid}`, reservedHandles)
          : aliasId,
        signature: aiAliasMap[aid].signature || '',
      };
      continue;
    }
    const actorSpace = normalizeAnonymousSpaceProfile((await loadAnonymousSpaceState(uid, aid).catch(() => null))?.profile || {});
    const spaceHandle = clean(actorSpace.handle);
    const fallbackId = buildFallbackAnonymousName(aid, `${nonce}|${aid}`);
    const currentId = spaceHandle && !isAnonymousHandleReserved(spaceHandle, reservedHandles)
      ? spaceHandle
      : (isAnonymousHandleReserved(fallbackId, reservedHandles)
        ? mintAnonymousHandleAvoiding(aid, `${nonce}|${aid}`, reservedHandles)
        : fallbackId);
    identitiesDraft[aid] = {
      currentId,
      signature: actorSpace.signature || actorSpace.bio || `${currentId}，路过网友`,
      avatar: currentId === spaceHandle ? (actorSpace.avatar || '') : '',
    };
  }
  for (const row of generatedNpcs) {
    const npcId = clean(row.anonymousId);
    identitiesDraft[row.actorId] = {
      currentId: isAnonymousHandleReserved(npcId, reservedHandles)
        ? mintAnonymousHandleAvoiding(row.actorId, `${nonce}|npc`, reservedHandles)
        : npcId,
      signature: row.signature || `${row.anonymousId}，路过`,
    };
  }
  const profileMap = await ensureAnonymousNetworkProfiles(uid, participants, {
    userRow,
    spaceProfile: await loadAnonymousSpaceUserProfile(uid),
  });
  const anonymousIdentities = attachNetworkProfilesToIdentityMap(
    ensureUniqueAnonymousIdentityMap(identitiesDraft, participants, {
      reservedHandles,
      reservedAvatars,
    }),
    profileMap,
  );

  const ts = await getNowForUser(uid);
  const chat = createChat({
    type: 'group',
    userId: uid,
    participants,
    groupSettings: {
      name,
      isObserverMode: observerMode || !includeSelf,
      anonymousRoomConfig: {
        topic,
        description,
        vibe: template.vibe || 'casual',
        worldview: roomWorldviewText,
        worldBookId: roomWorldBookId,
        auPresetId: roomAuPresetId,
        onlineOnly: true,
        allowAnonymousPrivate: true,
        ownerActorId: '',
        identityPolicy: 'fixed',
      },
      anonymousIdentities,
    },
    metadata: {
      channel: 'anonymous',
      anonymousMode: true,
      anonymousRoomKind: 'group',
      anonymousRoomId: '',
      memoryMode: memMode,
      sourceAnonymousType: 'manual_create',
      anonymousNpcActorIds: [...npcIds],
      anonymousNpcEphemeral: generatedNpcs.some((n) => n.ephemeral),
      anonymousAliasMeta: aliasMeta ? {
        usedAi: aliasMeta.usedAi === true,
        generatedCount: Number(aliasMeta.generatedCount || 0) || 0,
        requestedCount: Number(aliasMeta.requestedCount || 0) || 0,
        warning: String(aliasMeta.warning || '').trim(),
      } : null,
    },
    lastActivity: ts,
  });
  chat.metadata.anonymousRoomId = chat.id;
  await saveChat(chat);
  return chat;
}

export function buildAnonymousIdentityDraftForActors(actorIds = [], seed = '', userSeed = null) {
  const participants = [...new Set((Array.isArray(actorIds) ? actorIds : []).filter(Boolean))];
  const draft = {};
  if (participants.includes('user')) {
    const preset = userSeed && typeof userSeed === 'object' ? userSeed : {};
    draft.user = {
      currentId: clean(preset.currentId) || buildFallbackAnonymousName('user', seed),
      signature: clean(preset.signature) || '刚上线',
      avatar: clean(preset.avatar),
    };
  }
  for (const aid of participants) {
    if (aid === 'user') continue;
    draft[aid] = {
      currentId: buildFallbackAnonymousName(aid, `${seed}|${aid}`),
      signature: `${buildFallbackAnonymousName(aid, aid)}，网友`,
    };
  }
  return ensureUniqueAnonymousIdentityMap(draft, participants);
}
