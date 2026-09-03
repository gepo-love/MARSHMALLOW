import { createChat, createMessage } from '../models/chat.js';
import { saveChat, saveMessage, updateChatPreview, listChatsForUser } from './chat-store.js';
import {
  ensureUniqueAnonymousIdentityMap,
  getAnonymousDisplayProfile,
  getAnonymousIdentityMap,
} from './anonymous-chat.js';
import { isAnonymousChat } from './chat-helpers.js';
import { getNowForUser } from './time-mode.js';
import { getRecord } from './db.js';
import { listCharacters } from './character-store.js';
import { retainAnonymousNpc } from './anonymous-npc.js';

function draftIdentityToSnapshot(identity = {}) {
  return {
    currentId: String(identity?.currentId || '').trim(),
    signature: String(identity?.signature || '').trim(),
    avatar: String(identity?.avatar || '').trim(),
    profileId: String(identity?.profileId || '').trim(),
    networkHandle: String(identity?.networkHandle || '').trim(),
    networkAvatarStyle: String(identity?.networkAvatarStyle || '').trim(),
    networkSignature: String(identity?.networkSignature || '').trim(),
    aliasHistory: Array.isArray(identity?.aliasHistory) ? identity.aliasHistory : [],
  };
}

function clean(value = '') {
  return String(value ?? '').trim();
}

let characterLookupCache = null;

async function buildCharacterLookup() {
  if (characterLookupCache) return characterLookupCache;
  const rows = await listCharacters().catch(() => []);
  const lookup = new Map();
  for (const c of Array.isArray(rows) ? rows : []) {
    const id = clean(c?.id);
    if (!id) continue;
    const names = [
      id,
      c.name,
      c.realName,
      c.customNickname,
      ...(Array.isArray(c.aliases) ? c.aliases : []),
    ];
    for (const name of names) {
      const key = clean(name).toLowerCase();
      if (key && !lookup.has(key)) lookup.set(key, id);
    }
  }
  characterLookupCache = lookup;
  return lookup;
}

async function canonicalCharacterId(value = '') {
  const raw = clean(value);
  if (!raw) return '';
  const lowered = raw.toLowerCase();
  const lookup = await buildCharacterLookup();
  if (lookup.has(lowered)) return lookup.get(lowered);
  const profileMatch = raw.match(/^anon_profile_(.+)$/i);
  if (profileMatch) {
    const fromProfile = await canonicalCharacterId(profileMatch[1]);
    if (fromProfile) return fromProfile;
  }
  return raw;
}

async function resolveActorIdInChat(chat = null, value = '') {
  const raw = clean(value);
  if (!raw) return '';
  const direct = await canonicalCharacterId(raw);
  const identities = getAnonymousIdentityMap(chat);
  if (identities[direct] || identities[raw]) return direct;
  const needle = raw.toLowerCase();
  for (const [actorId, entry] of Object.entries(identities || {})) {
    const names = [
      actorId,
      entry?.currentId,
      entry?.networkHandle,
      entry?.profileId,
      ...(Array.isArray(entry?.aliasHistory) ? entry.aliasHistory.map((item) => item?.id) : []),
    ];
    if (names.some((name) => clean(name).toLowerCase() === needle)) {
      return canonicalCharacterId(actorId);
    }
  }
  return direct;
}

function anonymousPrivateSourceId(chat = null) {
  return clean(chat?.metadata?.sourceAnonymousChatId || chat?.anonymousPrivateConfig?.sourceContext?.sourceChatId);
}

async function anonymousPrivateCounterpartIds(chat = null) {
  const values = [
    chat?.anonymousPrivateConfig?.counterpartActorId,
    ...(Array.isArray(chat?.participants) ? chat.participants.filter((id) => id && id !== 'user') : []),
    ...Object.keys(getAnonymousIdentityMap(chat)).filter((id) => id && id !== 'user'),
  ];
  const sourceId = anonymousPrivateSourceId(chat);
  const sourceChat = sourceId ? await getRecord('chats', sourceId).catch(() => null) : null;
  const out = new Set();
  for (const value of values) {
    const byPrivate = await resolveActorIdInChat(chat, value);
    if (byPrivate) out.add(byPrivate);
    if (sourceChat) {
      const bySource = await resolveActorIdInChat(sourceChat, value);
      if (bySource) out.add(bySource);
    }
  }
  return out;
}

async function hydrateExistingPrivateIdentityFromSource(chat = null, sourceChat = null, counterpartId = '') {
  if (!chat || !sourceChat || !counterpartId) return chat;
  const identities = chat.anonymousPrivateConfig?.identities;
  if (!identities || typeof identities !== 'object') return chat;
  const current = identities[counterpartId];
  if (current?.currentId) return chat;
  const sourceIdentities = getAnonymousIdentityMap(sourceChat);
  const sourceEntry = sourceIdentities[counterpartId]
    || Object.entries(sourceIdentities).find(([actorId]) => clean(actorId) === clean(counterpartId))?.[1];
  const profile = sourceEntry || getAnonymousDisplayProfile(sourceChat, counterpartId, {});
  if (!profile) return chat;
  identities[counterpartId] = draftIdentityToSnapshot(profile);
  await saveChat(chat);
  return chat;
}

export async function createAnonymousPrivateFromRandomMatch({
  userId,
  userRow = null,
  counterpartActorId,
  counterpartIdentity,
  userIdentity,
  purpose,
  relationIntent = null,
  counterpartSource = '',
  npcGender = '',
  customDirection = '',
  seedOpening = true,
} = {}) {
  const uid = String(userId || '').trim();
  const other = String(counterpartActorId || '').trim();
  if (!uid || !other || other === 'user') throw new Error('参数不完整');
  const pur = purpose && typeof purpose === 'object' ? purpose : { id: 'casual', label: '随便聊聊', vibePrompt: '' };

  const id = `anon_priv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const privateIdentities = ensureUniqueAnonymousIdentityMap({
    user: draftIdentityToSnapshot(userIdentity),
    [other]: draftIdentityToSnapshot(counterpartIdentity),
  }, ['user', other]);

  const newChat = createChat({
    id,
    type: 'private',
    userId: uid,
    participants: ['user', other],
    metadata: {
      channel: 'anonymous',
      anonymousMode: true,
      anonymousRoomKind: 'private',
      anonymousRoomId: id,
      sourceAnonymousType: 'random_match',
      matchPurpose: String(pur.id || 'casual').trim(),
      matchPurposeLabel: String(pur.label || '').trim(),
      matchVibePrompt: String(pur.vibePrompt || '').trim(),
      matchRelationIntent: String(relationIntent?.id || '').trim(),
      matchRelationIntentLabel: String(relationIntent?.label || '').trim(),
      matchRelationIntentPrompt: String(relationIntent?.prompt || '').trim(),
      matchCounterpartSource: clean(counterpartSource),
      matchNpcGender: clean(npcGender),
      matchCustomDirection: clean(customDirection),
      memoryMode: 'inherit_full',
    },
    anonymousPrivateConfig: {
      selfActorId: 'user',
      counterpartActorId: other,
      identities: privateIdentities,
      sourceContext: {
        matchPurpose: String(pur.id || '').trim(),
        matchPurposeLabel: String(pur.label || '').trim(),
        matchVibePrompt: String(pur.vibePrompt || '').trim(),
        matchRelationIntent: String(relationIntent?.id || '').trim(),
        matchRelationIntentLabel: String(relationIntent?.label || '').trim(),
        matchRelationIntentPrompt: String(relationIntent?.prompt || '').trim(),
      },
    },
  });

  newChat.lastActivity = await getNowForUser(uid);
  await saveChat(newChat);
  await retainAnonymousNpc(other, id);

  if (seedOpening) {
    const ts = await getNowForUser(uid);
    const label = privateIdentities[other]?.currentId || other;
    const notice = `${label} 进入房间`;
    const opener = createMessage({
      chatId: id,
      senderId: 'system',
      senderName: '系统',
      type: 'system',
      content: notice,
      timestamp: ts,
      metadata: { anonymousSeed: true, roomJoinNotice: true },
    });
    await saveMessage(opener);
    await updateChatPreview(id, notice, opener.timestamp);
  }

  return newChat;
}

function normalizeParticipantPair(counterpartId) {
  const other = String(counterpartId || '').trim();
  if (!other || other === 'user') return '';
  return ['user', other].sort().join('|');
}

export async function findExistingAnonymousPrivateFromGroup(userId, sourceChatId, counterpartActorId) {
  const uid = String(userId || '').trim();
  const src = String(sourceChatId || '').trim();
  if (!uid || !src) return null;
  const sourceChat = await getRecord('chats', src).catch(() => null);
  const other = await resolveActorIdInChat(sourceChat, counterpartActorId);
  if (!other) return null;
  const pair = normalizeParticipantPair(other);
  const chats = await listChatsForUser(uid);
  const candidates = chats.filter((c) => c.type === 'private'
    && isAnonymousChat(c)
    && String(c.metadata?.anonymousRoomKind || '') === 'private');
  for (const c of candidates) {
    const canonicalParts = await Promise.all((c.participants || []).map((id) => canonicalCharacterId(id)));
    const parts = canonicalParts.filter(Boolean).sort().join('|');
    if (parts !== pair) continue;
    const sourceIds = [
      c.metadata?.sourceAnonymousChatId,
      c.anonymousPrivateConfig?.sourceContext?.sourceChatId,
      ...(Array.isArray(c.metadata?.sourceAnonymousChatIds) ? c.metadata.sourceAnonymousChatIds : []),
    ].map((id) => String(id || '').trim());
    if (sourceIds.includes(src)) return c;
  }
  const sorted = candidates.slice().sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0));
  for (const c of sorted) {
    const ids = await anonymousPrivateCounterpartIds(c);
    if (!ids.has(other)) continue;
    c.metadata = {
      ...(c.metadata || {}),
      sourceAnonymousChatIds: [...new Set([
        ...(Array.isArray(c.metadata?.sourceAnonymousChatIds) ? c.metadata.sourceAnonymousChatIds : []),
        c.metadata?.sourceAnonymousChatId,
        src,
      ].filter(Boolean))],
    };
    c.anonymousPrivateConfig = {
      ...(c.anonymousPrivateConfig || {}),
      counterpartActorId: await canonicalCharacterId(c.anonymousPrivateConfig?.counterpartActorId || other),
      relatedSources: [
        ...((c.anonymousPrivateConfig?.relatedSources || []).filter((item) => item?.sourceChatId !== src)),
        {
          sourceChatId: src,
          sourceGroupName: String(sourceChat?.groupSettings?.name || '').trim(),
          sourceTopic: String(sourceChat?.groupSettings?.anonymousRoomConfig?.topic || '').trim(),
          counterpartActorId: other,
          addedAt: Date.now(),
        },
      ].slice(-20),
    };
    await saveChat(c);
    return c;
  }
  return null;
}

export async function createAnonymousPrivateFromGroup({
  userId,
  userRow = null,
  sourceChat,
  counterpartActorId,
  seedOpening = true,
} = {}) {
  const uid = String(userId || '').trim();
  const srcChat = sourceChat || null;
  const srcId = String(srcChat?.id || '').trim();
  const rawOther = String(counterpartActorId || '').trim();
  const other = await resolveActorIdInChat(srcChat, counterpartActorId);
  if (!uid || !srcId || !other || other === 'user') throw new Error('参数不完整');

  const existing = await findExistingAnonymousPrivateFromGroup(uid, srcId, other);
  if (existing) {
    await retainAnonymousNpc(other, srcId);
    existing.metadata = {
      ...(existing.metadata || {}),
      sourceAnonymousChatIds: [...new Set([
        ...(Array.isArray(existing.metadata?.sourceAnonymousChatIds) ? existing.metadata.sourceAnonymousChatIds : []),
        existing.metadata?.sourceAnonymousChatId,
        srcId,
      ].filter(Boolean))],
    };
    existing.anonymousPrivateConfig = {
      ...(existing.anonymousPrivateConfig || {}),
      relatedSources: [
        ...((existing.anonymousPrivateConfig?.relatedSources || []).filter((item) => item?.sourceChatId !== srcId)),
        {
          sourceChatId: srcId,
          sourceGroupName: String(srcChat?.groupSettings?.name || '').trim(),
          counterpartActorId: other,
          addedAt: Date.now(),
        },
      ].slice(-20),
    };
    await saveChat(existing);
    return hydrateExistingPrivateIdentityFromSource(existing, srcChat, other);
  }

  const groupIdentities = srcChat?.groupSettings?.anonymousIdentities
    || srcChat?.anonymousPrivateConfig?.identities
    || {};
  const userSnap = draftIdentityToSnapshot(groupIdentities.user || getAnonymousDisplayProfile(srcChat, 'user', { userRow }) || {});
  const rawOtherProfile = rawOther ? getAnonymousDisplayProfile(srcChat, rawOther, { userRow }) : null;
  const otherProfile = getAnonymousDisplayProfile(srcChat, other, { userRow });
  const otherSnap = draftIdentityToSnapshot(groupIdentities[rawOther] || rawOtherProfile || groupIdentities[other] || otherProfile || {});

  const id = `anon_priv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await retainAnonymousNpc(other, srcId);
  const privateIdentities = ensureUniqueAnonymousIdentityMap({
    user: userSnap,
    [other]: otherSnap,
  }, ['user', other]);

  const topic = String(srcChat?.groupSettings?.anonymousRoomConfig?.topic || srcChat?.groupSettings?.name || '').trim();
  const chat = createChat({
    id,
    type: 'private',
    userId: uid,
    participants: ['user', other],
    metadata: {
      channel: 'anonymous',
      anonymousMode: true,
      anonymousRoomKind: 'private',
      anonymousRoomId: id,
      sourceAnonymousType: 'group_jump',
      sourceAnonymousChatId: srcId,
      memoryMode: String(srcChat?.metadata?.memoryMode || 'inherit_full').trim() || 'inherit_full',
    },
    anonymousPrivateConfig: {
      selfActorId: 'user',
      counterpartActorId: other,
      identities: privateIdentities,
      sourceContext: {
        sourceChatId: srcId,
        sourceGroupName: String(srcChat?.groupSettings?.name || '').trim(),
        sourceTopic: topic,
      },
    },
  });
  chat.lastActivity = await getNowForUser(uid);
  await saveChat(chat);

  if (seedOpening) {
    const ts = await getNowForUser(uid);
    const label = privateIdentities[other]?.currentId || other;
    const notice = `已打开与 ${label} 的匿名私聊`;
    const opener = createMessage({
      chatId: id,
      senderId: 'system',
      senderName: '系统',
      type: 'system',
      content: notice,
      timestamp: ts,
      metadata: { anonymousSeed: true, groupJump: true, roomJoinNotice: true },
    });
    await saveMessage(opener);
    await updateChatPreview(id, notice, opener.timestamp);
  }
  return chat;
}
