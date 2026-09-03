import * as db from './db.js';
import { listChatsForUser, listMessagesForChat, saveMemory } from './chat-store.js';
import { previewFromMessage } from './chat-helpers.js';
import { phoneContactCanonicalActorId } from './phone-social-actor-directory.js';
import { createMemory } from '../models/memory.js';

const MEMORY_SOURCE = 'phone-contact-history';
const MAX_MESSAGES_PER_CHUNK = 24;
const MAX_CHUNKS = 80;

function clean(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function stableHash(value = '') {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function messageUsable(message = {}) {
  return !!message
    && !message.deleted
    && !message.recalled
    && message.metadata?.aiPlaceholder !== true
    && message.metadata?.plotExplain !== true
    && String(message.type || '') !== 'system'
    && !['system', 'ai', 'guidance'].includes(String(message.senderId || '').trim());
}

function phoneChatTitle(chat = {}) {
  if (chat.type === 'group') return clean(chat.groupSettings?.name, 80) || '群聊';
  return '私聊';
}

function senderLabel(message = {}, options = {}) {
  const senderId = clean(message.senderId, 240);
  if (options.actorIds.has(senderId)) return options.contactName;
  if (senderId === options.ownerId) return options.ownerName;
  return clean(message.senderName || options.aliases?.[senderId]?.name, 80) || '群成员';
}

export function buildPhoneContactMemoryChunks({
  chats = [],
  messagesByChat = new Map(),
  actorIds = [],
  ownerId = '',
  ownerName = '通讯录主人',
  contactName = '联系人',
} = {}) {
  const knownActorIds = new Set((Array.isArray(actorIds) ? actorIds : []).map((id) => clean(id, 240)).filter(Boolean));
  const oid = clean(ownerId, 240);
  const rows = [];
  for (const chat of Array.isArray(chats) ? chats : []) {
    const participants = new Set((chat?.participants || []).map((id) => clean(id, 240)).filter(Boolean));
    if (!chat?.id || participants.has('user') || !participants.has(oid)) continue;
    if (![...knownActorIds].some((id) => participants.has(id))) continue;
    const messages = (messagesByChat instanceof Map ? messagesByChat.get(chat.id) : messagesByChat?.[chat.id]) || [];
    const visible = messages.filter(messageUsable).sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    for (let start = 0; start < visible.length; start += MAX_MESSAGES_PER_CHUNK) {
      const chunk = visible.slice(start, start + MAX_MESSAGES_PER_CHUNK);
      if (!chunk.length) continue;
      const aliases = chat.metadata?.phoneLightNpcAliases || {};
      const dialogue = chunk.map((message) => {
        const label = senderLabel(message, {
          actorIds: knownActorIds,
          ownerId: oid,
          ownerName,
          contactName,
          aliases,
        });
        return `${label}：${clean(previewFromMessage(message), 180) || '[非文字消息]'}`;
      }).join('\n');
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      rows.push({
        sourceChatId: clean(chat.id, 160),
        sourceTitle: phoneChatTitle(chat),
        timestamp: Number(last?.timestamp || first?.timestamp || chat.lastActivity || Date.now()),
        rangeKey: `${clean(first?.id) || start}:${clean(last?.id) || (start + chunk.length - 1)}`,
        content: [
          `${contactName}亲自参与过的${phoneChatTitle(chat)}记录；这是已经发生的经历，不是传闻，也不代表知道其他窗口的内容。`,
          dialogue,
        ].join('\n'),
      });
    }
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_CHUNKS);
}

export async function syncPhoneContactConversationMemory({
  userId = '',
  ownerId = '',
  ownerName = '',
  contact = null,
  targetCharacterId = '',
} = {}) {
  const uid = clean(userId, 160);
  const oid = clean(ownerId, 160);
  const targetId = clean(targetCharacterId, 240);
  if (!uid || !oid || !targetId || !contact?.id) return { chunks: 0, messages: 0, promptBlock: '' };
  const actorIds = [...new Set([
    clean(contact.id, 240),
    clean(phoneContactCanonicalActorId(contact), 240),
    clean(contact.linkedActorId, 240),
    clean(contact.linkedCharacterId, 240),
  ].filter(Boolean))];
  const allChats = await listChatsForUser(uid).catch(() => []);
  const relevantChats = allChats.filter((chat) => {
    const participants = new Set((chat?.participants || []).map((id) => clean(id, 240)).filter(Boolean));
    return !participants.has('user')
      && participants.has(oid)
      && actorIds.some((id) => participants.has(id));
  });
  const messagePairs = await Promise.all(relevantChats.map(async (chat) => [
    chat.id,
    await listMessagesForChat(chat.id, 0).catch(() => []),
  ]));
  const messagesByChat = new Map(messagePairs);
  const contactName = clean(contact.name || contact.nickname, 80) || '联系人';
  const chunks = buildPhoneContactMemoryChunks({
    chats: relevantChats,
    messagesByChat,
    actorIds,
    ownerId: oid,
    ownerName: clean(ownerName, 80) || '通讯录主人',
    contactName,
  });
  const existing = await db.getAllByIndex('memories', 'characterId', targetId).catch(() => []);
  const oldRows = existing.filter((row) => row?.source === MEMORY_SOURCE
    && clean(row.phoneOwnerId, 160) === oid
    && clean(row.phoneContactId, 240) === clean(contact.id, 240));
  const nextIds = new Set();
  for (const [index, chunk] of chunks.entries()) {
    const id = `mem_phone_${stableHash(`${uid}|${oid}|${contact.id}|${chunk.sourceChatId}|${chunk.rangeKey}`)}`;
    nextIds.add(id);
    const memory = createMemory({
      id,
      chatId: '',
      characterId: targetId,
      userId: uid,
      type: 'event',
      category: 'social-history',
      content: chunk.content,
      importance: index >= chunks.length - 2 ? 'important' : 'normal',
      timestamp: chunk.timestamp,
      source: MEMORY_SOURCE,
    });
    memory.phoneOwnerId = oid;
    memory.phoneContactId = clean(contact.id, 240);
    memory.sourceChatId = chunk.sourceChatId;
    memory.sourceTitle = chunk.sourceTitle;
    memory.knowledgeScope = 'participant-only';
    await saveMemory(memory);
  }
  await Promise.all(oldRows
    .filter((row) => row?.id && !nextIds.has(row.id))
    .map((row) => db.deleteRecord('memories', row.id).catch(() => null)));
  const recent = chunks.slice(-2);
  return {
    chunks: chunks.length,
    messages: [...messagesByChat.values()].reduce((sum, rows) => sum + rows.filter(messageUsable).length, 0),
    promptBlock: recent.length
      ? `【这位联系人的既有记忆】\n${recent.map((row) => row.content).join('\n\n')}`
      : '',
  };
}
