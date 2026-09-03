import { getCharacter, saveCharacter } from './character-store.js';
import { createPrivateChat } from '../models/chat.js';
import { listChatsForUser, saveChat } from './chat-store.js';
import { isAnonymousChat } from './chat-helpers.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

/** 将匿名路人原地转正；actorId 不变，匿名期消息与记忆因此无需搬迁。 */
export async function acceptAnonymousReveal({ userId, actorId, sourceChatId = '', name = '', bio = '' } = {}) {
  const uid = clean(userId);
  const aid = clean(actorId);
  if (!uid || !aid) throw new Error('缺少匿名路人');
  const actor = await getCharacter(aid);
  if (!actor) throw new Error('找不到这位匿名网友');
  const draft = actor.anonymousPrivateDraft || {};
  const realName = clean(name) || clean(draft.realName) || clean(actor.realName);
  const displayName = realName || clean(actor.name);
  const next = await saveCharacter({
    ...actor,
    name: displayName,
    realName,
    currentRole: clean(draft.currentRole) || clean(actor.currentRole),
    promptCorpus: clean(actor.promptCorpus) || clean(bio) || clean(draft.background),
    groupId: actor.groupId === 'anon_npc' ? 'default' : actor.groupId,
    anonymousLifecycle: {
      ...(actor.anonymousLifecycle || {}),
      phase: 'revealed',
      retained: true,
      revealStatus: 'accepted',
      revealedAt: Date.now(),
      sourceChatIds: [...new Set([
        ...(actor.anonymousLifecycle?.sourceChatIds || []),
        clean(sourceChatId),
      ].filter(Boolean))],
    },
    anonymousPrivateDraft: {
      ...draft,
      realName,
      background: clean(draft.background) || clean(bio),
    },
  });
  const chats = await listChatsForUser(uid);
  let normal = chats.find((chat) => chat.type === 'private'
    && !isAnonymousChat(chat)
    && (chat.participants || []).includes(aid));
  if (!normal) {
    normal = createPrivateChat(uid, aid, next.name);
    normal.metadata = {
      ...(normal.metadata || {}),
      anonymousRevealActorId: aid,
      anonymousRevealSourceChatIds: [...new Set([
        ...(next.anonymousLifecycle?.sourceChatIds || []),
        clean(sourceChatId),
      ].filter(Boolean))],
      anonymousMemoryInject: 'merged',
    };
    await saveChat(normal);
  }
  return { character: next, chat: normal };
}
