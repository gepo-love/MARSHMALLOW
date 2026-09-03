import { get, put } from './db.js';
import { getChat } from './chat-store.js';

const MAX_ANONYMOUS_CONTACTS = 200;

function clean(value = '') {
  return String(value ?? '').trim();
}

function settingsKey(userId = '') {
  return `anonymousContacts_${clean(userId) || 'guest'}`;
}

export function anonymousContactIdentityKey(actorId = '', profileId = '') {
  const actor = clean(actorId);
  const profile = clean(profileId);
  return profile || (actor ? `anon_profile_${actor}` : '');
}

export function normalizeAnonymousContact(raw = {}) {
  const actorId = clean(raw.actorId);
  const anonymousId = clean(raw.anonymousId || raw.displayName);
  if (!actorId && !anonymousId) return null;
  return {
    actorId,
    profileId: clean(raw.profileId) || anonymousContactIdentityKey(actorId),
    anonymousId,
    displayName: anonymousId,
    networkHandle: clean(raw.networkHandle),
    networkSignature: clean(raw.networkSignature),
    sourceChatId: clean(raw.sourceChatId),
    sourceChatIds: Array.isArray(raw.sourceChatIds) ? raw.sourceChatIds.map(clean).filter(Boolean) : [],
    privateChatId: clean(raw.privateChatId),
    lastSeenAt: Number(raw.lastSeenAt || 0) || 0,
    knownAliases: Array.isArray(raw.knownAliases) ? raw.knownAliases : [],
  };
}

export async function loadAnonymousContacts(userId = '') {
  const row = await get(settingsKey(userId));
  const list = Array.isArray(row?.value) ? row.value : [];
  return list.map(normalizeAnonymousContact).filter(Boolean);
}

export async function saveAnonymousContacts(userId = '', contacts = []) {
  const list = (Array.isArray(contacts) ? contacts : []).map(normalizeAnonymousContact).filter(Boolean).slice(0, MAX_ANONYMOUS_CONTACTS);
  await put('settings', { key: settingsKey(userId), value: list });
  return list;
}

export async function upsertAnonymousContact(userId = '', partial = {}) {
  const next = normalizeAnonymousContact(partial);
  if (!next) return null;
  const list = await loadAnonymousContacts(userId);
  const key = anonymousContactIdentityKey(next.actorId, next.profileId);
  const idx = list.findIndex((c) => anonymousContactIdentityKey(c.actorId, c.profileId) === key);
  const merged = idx >= 0
    ? {
      ...list[idx],
      ...next,
      sourceChatIds: [...new Set([...(list[idx].sourceChatIds || []), ...(next.sourceChatIds || []), next.sourceChatId].filter(Boolean))],
      knownAliases: [...(list[idx].knownAliases || []), ...(next.knownAliases || [])],
    }
    : next;
  if (idx >= 0) list[idx] = merged;
  else list.unshift(merged);
  await saveAnonymousContacts(userId, list);
  return merged;
}

export async function removeAnonymousContact(userId = '', actorId = '') {
  const id = clean(actorId);
  if (!id) return;
  const list = await loadAnonymousContacts(userId);
  await saveAnonymousContacts(userId, list.filter((c) => c.actorId !== id));
}

export async function buildAnonymousContactEntry({
  userId,
  chat = null,
  actorId = '',
  privateChatId = '',
} = {}) {
  const { getAnonymousDisplayProfile } = await import('./anonymous-chat.js');
  const { retainAnonymousNpc } = await import('./anonymous-npc.js');
  const profile = getAnonymousDisplayProfile(chat, actorId, {});
  if (!profile?.anonymousId) return null;
  await retainAnonymousNpc(actorId, chat?.id);
  return upsertAnonymousContact(userId, {
    actorId,
    profileId: profile.profileId,
    anonymousId: profile.anonymousId,
    networkHandle: profile.networkHandle,
    networkSignature: profile.signature,
    sourceChatId: chat?.id,
    privateChatId,
    lastSeenAt: Date.now(),
  });
}

export async function enrichContactFromChat(userId, contact = {}) {
  const src = clean(contact.sourceChatId || contact.sourceChatIds?.[0]);
  if (!src) return contact;
  const chat = await getChat(src);
  if (!chat) return contact;
  return buildAnonymousContactEntry({ userId, chat, actorId: contact.actorId, privateChatId: contact.privateChatId })
    || contact;
}
