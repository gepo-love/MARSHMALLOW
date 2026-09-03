import * as db from '../db.js';

const THREADS_PREFIX = 'weiboDmThreads_';
const MESSAGES_PREFIX = 'weiboDmMessages_';
const LEGACY_PREFIX = 'weiboDmBox_';
const STORE_LIMIT = 800;

function text(value, fallback = '') {
  return String(value ?? '').trim() || fallback;
}

function hash(value) {
  let out = 2166136261;
  for (const ch of String(value || '')) {
    out ^= ch.charCodeAt(0);
    out = Math.imul(out, 16777619);
  }
  return (out >>> 0).toString(36);
}

function threadsKey(ownerUserId) {
  return `${THREADS_PREFIX}${text(ownerUserId, 'guest')}`;
}

function messagesKey(ownerUserId) {
  return `${MESSAGES_PREFIX}${text(ownerUserId, 'guest')}`;
}

function makeThreadId(ownerUserId, profileKey, counterpartKey) {
  return `wbdmt_${hash(`${ownerUserId}\n${profileKey}\n${counterpartKey}`)}`;
}

async function readList(key) {
  const row = await db.get('settings', key);
  return Array.isArray(row?.value) ? row.value : [];
}

async function writeState(ownerUserId, threads, messages) {
  await db.put('settings', { key: threadsKey(ownerUserId), value: threads });
  await db.put('settings', { key: messagesKey(ownerUserId), value: messages.slice(-STORE_LIMIT) });
}

function latestMessage(messages, threadId) {
  return messages
    .filter((message) => message.threadId === threadId && !message.deletedAt)
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0] || null;
}

function refreshThread(thread, messages) {
  const last = latestMessage(messages, thread.id);
  return {
    ...thread,
    updatedAt: Number(last?.timestamp || thread.updatedAt || Date.now()),
    lastMessage: text(last?.content, last?.media?.length ? '[图片]' : ''),
  };
}

function normalizeThreadInput(input = {}) {
  const ownerUserId = text(input.ownerUserId, 'guest');
  const profileKey = text(input.profileKey || input.inboxProfileKey, 'user');
  const counterpartName = text(input.counterpartName || input.senderName, '匿名用户');
  const counterpartKey = text(input.counterpartKey, `${text(input.counterpartType || input.senderType, '粉丝')}:${counterpartName}`);
  return {
    ownerUserId,
    profileKey,
    profileName: text(input.profileName || input.inboxProfileName, '主页'),
    authorId: text(input.authorId || input.inboxAuthorId),
    isSelf: input.isSelf === true || input.inboxIsSelf === true,
    counterpartKey,
    counterpartName,
    counterpartType: text(input.counterpartType || input.senderType, '粉丝'),
  };
}

export async function migrateLegacyWeiboDms(ownerUserId) {
  const owner = text(ownerUserId, 'guest');
  const [threads, messages, settings] = await Promise.all([
    readList(threadsKey(owner)),
    readList(messagesKey(owner)),
    db.getAllRecords('settings'),
  ]);
  const threadMap = new Map(threads.map((thread) => [thread.id, thread]));
  const messageIds = new Set(messages.map((message) => message.id));
  const prefix = `${LEGACY_PREFIX}${owner}_`;
  let changed = false;

  for (const row of settings) {
    if (!String(row?.key || '').startsWith(prefix) || !Array.isArray(row?.value)) continue;
    const profileKey = String(row.key).slice(prefix.length) || 'user';
    for (const legacy of row.value) {
      const normalized = normalizeThreadInput({
        ownerUserId: owner,
        profileKey,
        profileName: profileKey,
        counterpartName: legacy?.senderName,
        counterpartType: legacy?.senderType,
      });
      const threadId = makeThreadId(owner, profileKey, normalized.counterpartKey);
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, {
          id: threadId,
          ...normalized,
          pinned: false,
          muted: false,
          autoReplyEnabled: true,
          unreadCount: 0,
          createdAt: Number(legacy?.timestamp || Date.now()),
          updatedAt: Number(legacy?.timestamp || Date.now()),
          lastMessage: text(legacy?.content),
          source: 'legacy',
        });
        changed = true;
      }
      const incomingId = `legacy_${hash(`${row.key}:${legacy?.id || legacy?.timestamp}:${legacy?.content}`)}`;
      if (!messageIds.has(incomingId)) {
        messages.push({
          id: incomingId,
          threadId,
          ownerUserId: owner,
          direction: 'incoming',
          senderName: normalized.counterpartName,
          content: text(legacy?.content),
          translation: text(legacy?.translation),
          timestamp: Number(legacy?.timestamp || Date.now()),
          status: 'sent',
          source: 'legacy',
          legacyDmId: text(legacy?.id),
        });
        messageIds.add(incomingId);
        changed = true;
      }
      for (const reply of Array.isArray(legacy?.replies) ? legacy.replies : []) {
        const replyId = `legacy_${hash(`${row.key}:${legacy?.id}:${reply?.id || reply?.timestamp}:${reply?.content}`)}`;
        if (messageIds.has(replyId)) continue;
        messages.push({
          id: replyId,
          threadId,
          ownerUserId: owner,
          direction: 'outgoing',
          senderName: reply?.by === 'user' ? '我' : normalized.profileName,
          content: text(reply?.content),
          translation: text(reply?.translation),
          timestamp: Number(reply?.timestamp || legacy?.timestamp || Date.now()),
          status: 'sent',
          source: text(reply?.by, 'legacy'),
          legacyDmId: text(legacy?.id),
        });
        messageIds.add(replyId);
        changed = true;
      }
    }
  }
  if (changed) {
    const nextThreads = [...threadMap.values()].map((thread) => refreshThread(thread, messages));
    await writeState(owner, nextThreads, messages);
  }
  return { threads: [...threadMap.values()].map((thread) => refreshThread(thread, messages)), messages };
}

export async function listWeiboDmThreads(ownerUserId, { profileKey = '', profileKeys = [], unreadOnly = false } = {}) {
  const { threads } = await migrateLegacyWeiboDms(ownerUserId);
  const allowedProfileKeys = new Set([
    profileKey,
    ...(Array.isArray(profileKeys) ? profileKeys : []),
  ].map((value) => String(value || '').trim()).filter(Boolean));
  return threads
    .filter((thread) => !thread.deletedAt)
    .filter((thread) => !allowedProfileKeys.size || allowedProfileKeys.has(String(thread.profileKey || '').trim()))
    .filter((thread) => !unreadOnly || Number(thread.unreadCount || 0) > 0)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function getWeiboDmThread(ownerUserId, threadId) {
  const { threads } = await migrateLegacyWeiboDms(ownerUserId);
  return threads.find((thread) => thread.id === threadId && !thread.deletedAt) || null;
}

export async function listWeiboDmMessages(ownerUserId, threadId) {
  const { messages } = await migrateLegacyWeiboDms(ownerUserId);
  return messages
    .filter((message) => message.threadId === threadId && !message.deletedAt)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

export async function appendWeiboDmIncoming(input = {}) {
  const normalized = normalizeThreadInput(input);
  const { threads, messages } = await migrateLegacyWeiboDms(normalized.ownerUserId);
  const threadId = makeThreadId(normalized.ownerUserId, normalized.profileKey, normalized.counterpartKey);
  let thread = threads.find((item) => item.id === threadId);
  if (!thread) {
    thread = {
      id: threadId,
      ...normalized,
      pinned: false,
      muted: false,
      autoReplyEnabled: true,
      unreadCount: 0,
      createdAt: Number(input.timestamp || Date.now()),
    };
    threads.push(thread);
  } else {
    Object.assign(thread, normalized, { deletedAt: null });
  }
  const message = {
    id: text(input.id, `wbdmm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    threadId,
    ownerUserId: normalized.ownerUserId,
    direction: 'incoming',
    senderName: normalized.counterpartName,
    content: text(input.content),
    translation: text(input.translation),
    timestamp: Number(input.timestamp || Date.now()),
    status: 'sent',
    source: text(input.source, 'generated'),
    media: Array.isArray(input.media) ? input.media : [],
    sharedPostId: text(input.sharedPostId),
    sharedPostSnapshot: input.sharedPostSnapshot || null,
  };
  messages.push(message);
  thread.unreadCount = Number(thread.unreadCount || 0) + 1;
  Object.assign(thread, refreshThread(thread, messages));
  await writeState(normalized.ownerUserId, threads, messages);
  return { thread, message };
}

export async function appendWeiboDmOutgoing(ownerUserId, threadId, input = {}) {
  const owner = text(ownerUserId, 'guest');
  const { threads, messages } = await migrateLegacyWeiboDms(owner);
  const thread = threads.find((item) => item.id === threadId && !item.deletedAt);
  if (!thread) throw new Error('私信会话不存在');
  const message = {
    id: text(input.id, `wbdmm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    threadId,
    ownerUserId: owner,
    direction: 'outgoing',
    senderName: text(input.senderName, thread.profileName),
    content: text(input.content),
    translation: text(input.translation),
    timestamp: Number(input.timestamp || Date.now()),
    status: text(input.status, 'sent'),
    source: text(input.source, 'user'),
    media: Array.isArray(input.media) ? input.media : [],
    sharedPostId: text(input.sharedPostId),
    sharedPostSnapshot: input.sharedPostSnapshot || null,
  };
  messages.push(message);
  Object.assign(thread, refreshThread(thread, messages), { unreadCount: 0 });
  await writeState(owner, threads, messages);
  return message;
}

export async function updateWeiboDmThread(ownerUserId, threadId, patch = {}) {
  const owner = text(ownerUserId, 'guest');
  const { threads, messages } = await migrateLegacyWeiboDms(owner);
  const thread = threads.find((item) => item.id === threadId);
  if (!thread) return null;
  for (const key of ['pinned', 'muted', 'autoReplyEnabled', 'unreadCount', 'deletedAt']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) thread[key] = patch[key];
  }
  await writeState(owner, threads, messages);
  return thread;
}

export async function clearWeiboDmData(ownerUserId) {
  const owner = text(ownerUserId, 'guest');
  await db.remove(threadsKey(owner));
  await db.remove(messagesKey(owner));
}

export const __weiboDmStoreTestables = { hash, makeThreadId, normalizeThreadInput, refreshThread };
