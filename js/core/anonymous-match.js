import { createChat } from '../models/chat.js';
import { listChatsForUser, saveChat } from './chat-store.js';
import { getNowForUser } from './time-mode.js';
import {
  MATCH_PURPOSES_SINGLE,
  getMatchPurposeSingleById,
  MATCH_RELATION_INTENTS,
  getMatchRelationIntentById,
} from '../data/anonymous-match-presets.js';
import {
  MATCH_PURPOSES_GROUP,
  getMatchPurposeGroupById,
} from '../data/anonymous-room-presets.js';
import { ensureUniqueAnonymousIdentityMap, isAnonymousHandleReserved, mintAnonymousHandleAvoiding } from './anonymous-chat.js';
import {
  filterAnonymousCandidatesByLibrary,
  findAnonymousCharacterCandidateById,
  loadAnonymousCharacterCandidates,
} from './anonymous-character-pool.js';
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
import {
  generateAnonymousNpcProfiles,
  persistAnonymousNpcs,
  generateAnonymousAliasesForActors,
} from './anonymous-npc.js';

function hashCode(input = '') {
  let hash = 0;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

const HANDLE_LEFT = ['晚风', '微光', '云层', '海盐', '空格', '北纬', '长街', '回声'];
const HANDLE_RIGHT = ['旅人', '汽水', '灯塔', '纸片', '候鸟', '信号', '月台', '轨迹'];

function buildAnonHandle(actorId, seed = '') {
  const code = hashCode(`${actorId}|${seed}`);
  return `${HANDLE_LEFT[code % HANDLE_LEFT.length]}${HANDLE_RIGHT[Math.floor(code / HANDLE_LEFT.length) % HANDLE_RIGHT.length]}`;
}

const PURPOSE_BIO_LINE = {
  casual: '路过型网友，聊什么都行',
  vent: '话不多，更适合先听你说完',
  flirt: '会接梗也会收一点',
  sad: '不急着安慰，先陪着',
  argue: '嘴快但不下死手',
  debate: '爱抬杠也爱听反方',
  share: '会先听完再给真实反应',
  late_night: '夜猫子作息，接得住飘忽话题',
  lounge: '水群型，接梗快',
  advisor: '军师型网友',
  vent_circle: '怨气型网友',
  brainstorm: '爱抛点子',
  literary: '文艺型网友',
  mixed_party: '画风随缘',
  confession: '赛博告解室网友',
};

export function generateAnonymousIdentityForActorSimple(actorId, purposeId, nonce = '', character = null) {
  const seed = `${actorId}|${purposeId}|${nonce}`;
  const currentId = buildAnonHandle(actorId, seed);
  const pLine = PURPOSE_BIO_LINE[purposeId] || '随机匹配到的网友';
  const snippet = String(character?.personality || '').replace(/\s+/g, ' ').trim().slice(0, 28);
  const signature = snippet ? `${currentId}，${pLine}` : `${currentId}，${pLine}`;
  return { currentId, signature };
}

async function buildActorMatchIdentity(
  userId = '',
  actorId = '',
  purposeId = '',
  nonce = '',
  character = null,
  reservedHandles = [],
) {
  const state = userId ? await loadAnonymousSpaceState(userId, actorId).catch(() => null) : null;
  const profile = normalizeAnonymousSpaceProfile(state?.profile || {});
  const spaceHandle = String(profile.handle || '').trim();
  // 角色匿名空间若已撞上用户自己的马甲网名，绝不能原样继承进匹配房
  const canInheritSpace = (spaceHandle || profile.signature || profile.avatar)
    && !isAnonymousHandleReserved(spaceHandle, reservedHandles);
  if (canInheritSpace) {
    return {
      currentId: spaceHandle || generateAnonymousIdentityForActorSimple(actorId, purposeId, nonce, character).currentId,
      signature: profile.signature || profile.bio || `${spaceHandle || actorId}，路过网友`,
      avatar: profile.avatar || '',
    };
  }
  if (character?.groupId === 'anon_npc') {
    const npcName = String(character.name || '').trim();
    const currentId = npcName && !isAnonymousHandleReserved(npcName, reservedHandles)
      ? npcName
      : mintAnonymousHandleAvoiding(actorId, nonce, reservedHandles);
    return {
      currentId,
      signature: String(character.notes || '').trim() || `${currentId}，路过`,
      avatar: String(character.avatar || '').trim(),
    };
  }
  const simple = generateAnonymousIdentityForActorSimple(actorId, purposeId, nonce, character);
  if (isAnonymousHandleReserved(simple.currentId, reservedHandles)) {
    const currentId = mintAnonymousHandleAvoiding(actorId, `${purposeId}|${nonce}`, reservedHandles);
    return { currentId, signature: `${currentId}，${PURPOSE_BIO_LINE[purposeId] || '随机匹配到的网友'}` };
  }
  return simple;
}

function buildUserMatchIdentity(userRow, nonce = '') {
  return buildUserAnonymousIdentitySeed(String(userRow?.id || '').trim(), { nonce, userRow });
}

function weightedRandomPick(weighted) {
  if (!weighted.length) return null;
  const total = weighted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return weighted[Math.floor(Math.random() * weighted.length)].item;
  let r = Math.random() * total;
  for (const { item, weight } of weighted) {
    r -= weight;
    if (r <= 0) return item;
  }
  return weighted[weighted.length - 1].item;
}

export function collectRecentAnonymousMatchUsage(chats = [], limit = 8) {
  const recent = (Array.isArray(chats) ? chats : [])
    .filter((chat) => String(chat?.metadata?.sourceAnonymousType || '').trim() === 'random_match')
    .sort((a, b) => Number(b?.lastActivity || 0) - Number(a?.lastActivity || 0))
    .slice(0, Math.max(1, Number(limit) || 8));
  const usage = new Map();
  const latestActorIds = new Set();
  recent.forEach((chat, index) => {
    const actorIds = [...new Set((Array.isArray(chat?.participants) ? chat.participants : [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== 'user' && id !== 'system'))];
    const recency = (recent.length - index) / recent.length;
    actorIds.forEach((id) => usage.set(id, (usage.get(id) || 0) + recency));
    if (index === 0) actorIds.forEach((id) => latestActorIds.add(id));
  });
  return { usage, latestActorIds };
}

async function loadRecentAnonymousMatchUsage(userId = '') {
  const uid = String(userId || '').trim();
  if (!uid) return { usage: new Map(), latestActorIds: new Set() };
  const chats = await listChatsForUser(uid).catch(() => []);
  return collectRecentAnonymousMatchUsage(chats);
}

function preferMainRelationshipPool(pool = []) {
  const rows = Array.isArray(pool) ? pool : [];
  const main = rows.filter((c) => String(c?.anonymousMeta?.roleTier || '') === 'main');
  return main.length ? main : rows;
}

export async function rollMatchedActor({
  userId = '',
  excludeIds = [],
  sourceLibrary = 'mixed',
  purposeId = 'casual',
  candidatePool = null,
  relationshipSlot = true,
  recentUsage = null,
  latestActorIds = null,
} = {}) {
  const exclude = new Set(['user', 'system', ...(excludeIds || [])].map((id) => String(id || '').trim()).filter(Boolean));
  const allCandidates = Array.isArray(candidatePool)
    ? candidatePool
    : await loadAnonymousCharacterCandidates({ userId });
  const latest = latestActorIds instanceof Set
    ? latestActorIds
    : new Set(Array.isArray(latestActorIds) ? latestActorIds : []);
  let pool = filterAnonymousCandidatesByLibrary(allCandidates, sourceLibrary)
    .filter((c) => c?.id && !exclude.has(c.id));
  const freshPool = pool.filter((candidate) => !latest.has(String(candidate?.id || '').trim()));
  if (freshPool.length) pool = freshPool;
  if (relationshipSlot) pool = preferMainRelationshipPool(pool);
  if (!pool.length) {
    pool = allCandidates.filter((c) => c?.id && !exclude.has(c.id));
    const freshFallback = pool.filter((candidate) => !latest.has(String(candidate?.id || '').trim()));
    if (freshFallback.length) pool = freshFallback;
    if (relationshipSlot) pool = preferMainRelationshipPool(pool);
  }
  if (!pool.length) return '';
  const weighted = pool.map((candidate) => {
    const priority = Number(candidate?.anonymousMeta?.priorityWeight) || 1;
    const recentCount = recentUsage instanceof Map
      ? Number(recentUsage.get(candidate.id) || 0)
      : Number(recentUsage?.[candidate.id] || 0);
    return { item: candidate.id, weight: priority / (1 + (Math.max(0, recentCount) * 2.5)) };
  });
  return weightedRandomPick(weighted) || pool[0]?.id || '';
}

async function pickGroupAiActorIds(aiCount, sourceLibrary, purposeId, matchUsage = null, userId = '') {
  const ids = [];
  const exclude = new Set(['user']);
  const candidatePool = await loadAnonymousCharacterCandidates({ userId });
  while (ids.length < aiCount) {
    const id = await rollMatchedActor({
      excludeIds: [...exclude],
      sourceLibrary,
      purposeId,
      candidatePool,
      relationshipSlot: sourceLibrary !== 'mixed',
      recentUsage: matchUsage?.usage,
      latestActorIds: matchUsage?.latestActorIds,
    });
    if (!id) break;
    ids.push(id);
    exclude.add(id);
  }
  return ids;
}

export async function executeGroupMatchPlan({
  userRow = null,
  purposeId = 'lounge',
  relationIntentId = 'light',
  memberCountTotal,
  sourceLibrary = 'mixed',
  npcConfig = null,
  roomWorldview = null,
  maskMode = 'ai',
  onPhase = null,
} = {}) {
  const purpose = getMatchPurposeGroupById(purposeId);
  const relationIntent = getMatchRelationIntentById(relationIntentId);
  const lo = Math.max(3, Number(purpose.minMembers) || 3);
  const hi = Math.max(lo, Number(purpose.maxMembers) || 6);
  let total = Number(memberCountTotal);
  if (!Number.isFinite(total)) total = lo;
  total = Math.min(hi, Math.max(lo, total));
  const aiTotal = total - 1;
  if (aiTotal < 2) throw new Error('人数不足');

  // 路人（NPC）配置：是否要、几个、用之即弃 or 复用
  const npc = npcConfig && typeof npcConfig === 'object' ? npcConfig : {};
  const wv = roomWorldview && typeof roomWorldview === 'object' ? roomWorldview : {};
  const roomWorldviewText = String(wv.worldview || '').trim();
  const npcEnabled = npc.enabled === true;
  let npcCount = npcEnabled ? Math.max(0, Math.min(aiTotal - 1, Number(npc.count) || 0)) : 0;
  const realCount = aiTotal - npcCount;

  const matchUsage = await loadRecentAnonymousMatchUsage(userRow?.id);
  const realIds = await pickGroupAiActorIds(realCount, sourceLibrary, purpose.id, matchUsage, userRow?.id);
  if (!realIds.length) throw new Error('没有可匹配的角色，请先在通讯录添加角色');
  // 真实角色不够就用路人补满（前提是开了路人）
  if (realIds.length < realCount && npcEnabled) {
    npcCount += realCount - realIds.length;
  }
  if (realIds.length + npcCount < 2) throw new Error('可匹配成员不足，请添加角色或开启路人');

  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const candidatePool = await loadAnonymousCharacterCandidates({ userId: userRow?.id });
  const candidateMap = new Map(candidatePool.map((c) => [String(c.id || '').trim(), c]));
  const reservedHandles = await loadUserReservedAnonymousHandles(userRow);
  const reservedAvatars = await loadUserReservedAnonymousAvatars(userRow);

  // 现场生成路人（匿名 ID 由 AI 现填，不继承马甲）
  let generatedNpcs = [];
  if (npcCount > 0) {
    if (typeof onPhase === 'function') onPhase('召唤路人网友');
    const profiles = await generateAnonymousNpcProfiles({
      count: npcCount,
      vibe: String(npc.vibe || '').trim(),
      worldview: roomWorldviewText || String(npc.worldview || '').trim(),
      roomTopic: purpose.label,
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
  const participants = ['user', ...realIds, ...npcIds];

  // 开局给真实角色按人设定制马甲（maskMode='ai'），否则走随机/空间马甲
  let aiAliasMap = {};
  let aliasMeta = null;
  if (maskMode === 'ai' && realIds.length) {
    if (typeof onPhase === 'function') onPhase('给大家分配马甲');
    const realChars = realIds.map((id) => candidateMap.get(id)).filter(Boolean);
    aliasMeta = await generateAnonymousAliasesForActors(realChars, {
      roomTopic: purpose.label,
      vibe: purpose.vibePrompt || '',
      required: true,
      reservedHandles,
    });
    aiAliasMap = aliasMeta.aliases || {};
  }

  const anonymousIdentitiesDraft = { user: await buildUserMatchIdentity(userRow, `${nonce}|user`) };
  for (const aid of realIds) {
    if (aiAliasMap[aid]?.currentId) {
      const aliasId = String(aiAliasMap[aid].currentId || '').trim();
      anonymousIdentitiesDraft[aid] = {
        currentId: isAnonymousHandleReserved(aliasId, reservedHandles)
          ? mintAnonymousHandleAvoiding(aid, `${nonce}|ai|${aid}`, reservedHandles)
          : aliasId,
        signature: aiAliasMap[aid].signature || '',
      };
    } else {
      anonymousIdentitiesDraft[aid] = await buildActorMatchIdentity(
        userRow?.id || '',
        aid,
        purpose.id,
        `${nonce}|${aid}`,
        candidateMap.get(aid),
        reservedHandles,
      );
    }
  }
  for (const row of generatedNpcs) {
    const npcId = String(row.anonymousId || '').trim();
    anonymousIdentitiesDraft[row.actorId] = {
      currentId: isAnonymousHandleReserved(npcId, reservedHandles)
        ? mintAnonymousHandleAvoiding(row.actorId, `${nonce}|npc`, reservedHandles)
        : npcId,
      signature: row.signature || `${row.anonymousId}，路过`,
    };
  }

  const anonymousIdentities = ensureUniqueAnonymousIdentityMap(anonymousIdentitiesDraft, participants, {
    reservedHandles,
    reservedAvatars,
  });
  return {
    purpose,
    relationIntent,
    participants,
    aiMemberIds: [...realIds, ...npcIds],
    npcActorIds: npcIds,
    npcEphemeral: generatedNpcs.some((n) => n.ephemeral),
    anonymousIdentities,
    aliasMeta,
    roomWorldview: {
      worldview: roomWorldviewText,
      worldBookId: String(wv.worldBookId || '').trim(),
      auPresetId: String(wv.auPresetId || '').trim(),
    },
    nonce,
    sourceLibrary: String(sourceLibrary || 'mixed').trim(),
  };
}

export async function persistRandomGroupMatchPlan({
  userId,
  userRow = null,
  plan,
} = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('未登录');
  if (!plan?.participants?.length || !plan.anonymousIdentities || !plan.purpose) {
    throw new Error('匹配数据无效');
  }

  const purpose = plan.purpose;
  const relationIntent = plan.relationIntent || getMatchRelationIntentById('light');
  const roomName = `${purpose.label} · 随机房`;
  const profileMap = await ensureAnonymousNetworkProfiles(uid, plan.participants, {
    userRow,
    spaceProfile: await loadAnonymousSpaceUserProfile(uid),
  });
  const anonymousIdentities = attachNetworkProfilesToIdentityMap(plan.anonymousIdentities, profileMap);
  const ts = await getNowForUser(uid);

  const chat = createChat({
    type: 'group',
    userId: uid,
    participants: [...plan.participants],
    groupSettings: {
      name: roomName,
      isObserverMode: false,
      groupThemeTags: [purpose.label, relationIntent.label].filter(Boolean),
      anonymousRoomConfig: {
        topic: purpose.label,
        description: purpose.description,
        vibePrompt: String(purpose.vibePrompt || '').trim(),
        vibe: 'casual',
        worldview: String(plan.roomWorldview?.worldview || '').trim(),
        worldBookId: String(plan.roomWorldview?.worldBookId || '').trim(),
        auPresetId: String(plan.roomWorldview?.auPresetId || '').trim(),
        onlineOnly: true,
        allowAnonymousPrivate: true,
        ownerActorId: '',
        identityPolicy: 'fixed',
      },
      anonymousIdentities: { ...anonymousIdentities },
    },
    metadata: {
      channel: 'anonymous',
      anonymousMode: true,
      anonymousRoomKind: 'group',
      anonymousRoomId: '',
      memoryMode: 'inherit_full',
      sourceAnonymousType: 'random_match',
      matchPurpose: purpose.id,
      matchPurposeLabel: String(purpose.label || '').trim(),
      matchVibePrompt: String(purpose.vibePrompt || '').trim(),
      matchRelationIntent: String(relationIntent.id || 'light').trim(),
      matchRelationIntentLabel: String(relationIntent.label || '').trim(),
      matchRelationIntentPrompt: String(relationIntent.prompt || '').trim(),
      matchScenePremise: 'simultaneous_random_match',
      randomMatchMemberCount: plan.participants.length,
      anonymousNpcActorIds: Array.isArray(plan.npcActorIds) ? [...plan.npcActorIds] : [],
      anonymousNpcEphemeral: plan.npcEphemeral === true,
      anonymousAliasMeta: plan.aliasMeta ? {
        usedAi: plan.aliasMeta.usedAi === true,
        generatedCount: Number(plan.aliasMeta.generatedCount || 0) || 0,
        requestedCount: Number(plan.aliasMeta.requestedCount || 0) || 0,
        warning: String(plan.aliasMeta.warning || '').trim(),
      } : null,
    },
    lastActivity: ts,
  });
  chat.metadata.anonymousRoomId = chat.id;
  await saveChat(chat);
  return chat;
}

export async function executeSingleMatch({
  userRow = null,
  purposeId = 'casual',
  relationIntentId = 'light',
  excludeActorIds = [],
  sourceLibrary = 'mixed',
  counterpartSource = 'random',
  npcGender = 'random',
  customDirection = '',
  selectedActorId = '',
} = {}) {
  const purpose = getMatchPurposeSingleById(purposeId);
  const relationIntent = getMatchRelationIntentById(relationIntentId);
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const source = ['character', 'npc', 'random', 'specific'].includes(String(counterpartSource || '').trim())
    ? String(counterpartSource).trim()
    : 'random';
  let candidateId = '';
  let generatedNpc = false;
  const reservedHandles = await loadUserReservedAnonymousHandles(userRow);
  if (source === 'specific') {
    const requestedId = String(selectedActorId || '').trim();
    const available = await loadAnonymousCharacterCandidates({ userId: userRow?.id });
    const selected = available.find((candidate) => String(candidate?.id || '').trim() === requestedId);
    if (!selected) throw new Error('请选择一个可用角色');
    candidateId = selected.id;
  } else if (source === 'npc' || (source === 'random' && Math.random() < 0.5)) {
    const [profile] = await generateAnonymousNpcProfiles({
      count: 1,
      roomTopic: purpose.label,
      vibe: purpose.vibePrompt,
      gender: npcGender,
      direction: String(customDirection || '').trim(),
      reservedHandles,
    });
    const [saved] = await persistAnonymousNpcs([profile], { ephemeral: true });
    candidateId = saved?.actorId || '';
    generatedNpc = !!candidateId;
  } else {
    const matchUsage = await loadRecentAnonymousMatchUsage(userRow?.id);
    candidateId = await rollMatchedActor({
      userId: userRow?.id,
      excludeIds: excludeActorIds,
      sourceLibrary,
      purposeId: purpose.id,
      recentUsage: matchUsage.usage,
      latestActorIds: matchUsage.latestActorIds,
    });
  }
  if (!candidateId) throw new Error('没有可用的匹配角色');
  const candidate = await findAnonymousCharacterCandidateById(candidateId);
  const reservedAvatars = await loadUserReservedAnonymousAvatars(userRow);
  const counterpartIdentity = await buildActorMatchIdentity(
    userRow?.id || '',
    candidateId,
    purpose.id,
    nonce,
    candidate,
    reservedHandles,
  );
  const userIdentity = await buildUserMatchIdentity(userRow, nonce);
  const identities = ensureUniqueAnonymousIdentityMap({
    user: userIdentity,
    [candidateId]: counterpartIdentity,
  }, ['user', candidateId], {
    reservedHandles,
    reservedAvatars,
  });
  return {
    candidateId,
    counterpartIdentity: identities[candidateId],
    userIdentity: identities.user,
    purpose,
    relationIntent,
    nonce,
    generatedNpc,
    counterpartSource: generatedNpc ? 'npc' : (source === 'specific' ? 'specific_character' : 'character'),
    npcGender: generatedNpc ? String(npcGender || 'random').trim() : '',
    customDirection: String(customDirection || '').trim(),
  };
}

export {
  MATCH_PURPOSES_SINGLE,
  getMatchPurposeSingleById,
  MATCH_PURPOSES_GROUP,
  getMatchPurposeGroupById,
  MATCH_RELATION_INTENTS,
  getMatchRelationIntentById,
};
