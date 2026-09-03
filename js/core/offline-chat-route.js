import {
  createGroupChat,
  ensurePrivateChat,
  listChatsForUser,
  listInboxChatsForUser,
  participantSetKey,
} from './chat-store.js';
import { loadOfflineSession } from './offline-session-store.js';
import { isAnonymousChat } from './chat-helpers.js';

export async function resolve_offline_chat_for_participants({
  user_id,
  characters = [],
  group_name = '',
  location = '',
  encounter_label = '',
  include_user = true,
} = {}) {
  const picked = (Array.isArray(characters) ? characters : []).filter((character) => character?.id);
  if (!picked.length) throw new Error('请至少选择一位角色');
  const includeUser = include_user !== false;

  if (picked.length === 1 && includeUser) {
    const chat = await ensurePrivateChat(user_id, picked[0].id, picked[0].name || '');
    return {
      chat,
      session: await loadOfflineSession(chat.id),
    };
  }

  const wanted_key = participantSetKey(picked.map((character) => character.id));
  const candidateChats = includeUser
    ? await listInboxChatsForUser(user_id)
    : await listChatsForUser(user_id);
  const matches = candidateChats.filter((chat) => (
    chat?.type === 'group'
    && !isAnonymousChat(chat)
    && (chat.participants || []).includes('user') === includeUser
    && participantSetKey(chat.participants) === wanted_key
  ));

  for (const chat of matches) {
    const session = await loadOfflineSession(chat.id);
    if (session) return { chat, session };
  }

  if (matches.length) return { chat: matches[0], session: null };

  const names = picked
    .map((character) => String(character?.customNickname || character?.name || '').trim())
    .filter(Boolean);
  const peopleLabel = names.length === 2
    ? `${names[0].slice(0, 10)}和${names[1].slice(0, 10)}`
    : names.map((name) => name.slice(0, 8)).join('、');
  const placeLabel = String(location || '').trim();
  const fallbackName = [placeLabel.slice(0, 12), peopleLabel].filter(Boolean).join(' · ').slice(0, 40);
  const label = String(encounter_label || placeLabel || '线下相遇').trim();
  const chat = await createGroupChat(
    user_id,
    picked.map((character) => character.id),
    fallbackName || String(group_name || '').trim() || peopleLabel,
    {
      includeSelf: includeUser,
      allowSingleObserver: !includeUser,
      ownerId: includeUser ? 'user' : picked[0]?.id,
      metadata: {
        encounterOrigin: true,
        observerOfflineOrigin: !includeUser,
        encounterLabel: label,
        encounterInboxPolicy: 'auto',
      },
    },
  );
  return { chat, session: null };
}
