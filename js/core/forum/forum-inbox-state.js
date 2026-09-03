import * as db from '../db.js';
import { listChatsForUser } from '../chat-store.js';
import { isUserAuthoredForumThread } from '../forum-identity.js';

const MAX_SEEN_REPLIES = 600;

function clean(value = '') {
  return String(value ?? '').trim();
}

function readStateKey(userId = '') {
  return `forumInboxRead_${clean(userId) || 'guest'}`;
}

export function forumNotificationKey(thread = {}, row = {}) {
  return [
    clean(thread.id),
    Number(row.timestamp || 0) || 0,
    clean(row.author || row.authorName),
    clean(row.content),
  ].join('::');
}

export function collectForumNotifications(threads = [], user = {}, names = new Set()) {
  const rows = [];
  const seen = new Set();
  const isUserRow = (row) => isUserAuthoredForumThread(row, user);
  const add = (thread, row) => {
    const key = forumNotificationKey(thread, row);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      key,
      threadId: thread.id,
      threadTitle: thread.title || '无标题',
      author: row.author || row.authorName || '论坛网友',
      content: row.content || '',
      timestamp: row.timestamp || thread.timestamp || 0,
    });
  };
  for (const thread of threads) {
    const ownThread = isUserRow(thread);
    const walk = (replyRows = [], parentIsUser = false) => {
      for (const row of Array.isArray(replyRows) ? replyRows : []) {
        const ownRow = isUserRow(row);
        const targetsUser = names.has(clean(row.replyToAuthor));
        if (!ownRow && (ownThread || parentIsUser || targetsUser)) add(thread, row);
        walk(row.childReplies, ownRow);
      }
    };
    walk(thread.replies, ownThread);
  }
  return rows.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

export function forumInboxIdentityNames(user = {}, forumProfile = {}, vests = []) {
  return new Set([
    user?.name,
    user?.nickname,
    forumProfile?.displayName,
    ...(Array.isArray(vests) ? vests : []).map((row) => row?.displayId),
  ].map(clean).filter(Boolean));
}

export async function loadForumInboxReadState(userId = '') {
  const row = await db.get('settings', readStateKey(userId)).catch(() => null);
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    replyKeys: Array.isArray(value.replyKeys) ? value.replyKeys.map(clean).filter(Boolean).slice(-MAX_SEEN_REPLIES) : [],
    chatActivity: value.chatActivity && typeof value.chatActivity === 'object' ? value.chatActivity : {},
    updatedAt: Number(value.updatedAt) || 0,
  };
}

export async function buildForumInboxSnapshot({
  user = {},
  threads = [],
  forumProfile = {},
  vests = [],
  chats = null,
} = {}) {
  const userId = clean(user?.id);
  const chatRows = Array.isArray(chats) ? chats : await listChatsForUser(userId).catch(() => []);
  const names = forumInboxIdentityNames(user, forumProfile, vests);
  const notifications = collectForumNotifications(threads, {
    ...user,
    customNickname: forumProfile?.displayName,
  }, names);
  const privateChats = chatRows
    .filter((chat) => chat?.type === 'private' && chat?.metadata?.sourceForumActorId)
    .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0));
  const readState = await loadForumInboxReadState(userId);
  const seenReplies = new Set(readState.replyKeys);
  const unreadReplyKeys = notifications.filter((row) => !seenReplies.has(row.key)).map((row) => row.key);
  const unreadChatIds = privateChats.filter((chat) => (
    Number(chat.lastActivity || chat.createdAt || 0) > Number(readState.chatActivity[chat.id] || 0)
  )).map((chat) => chat.id);
  return {
    notifications,
    privateChats,
    unreadReplyKeys,
    unreadChatIds,
    unreadCount: unreadReplyKeys.length + unreadChatIds.length,
  };
}

export async function markForumInboxSnapshotRead(userId = '', snapshot = {}) {
  const previous = await loadForumInboxReadState(userId);
  const replyKeys = [...new Set([
    ...previous.replyKeys,
    ...(Array.isArray(snapshot.notifications) ? snapshot.notifications.map((row) => clean(row?.key)) : []),
  ].filter(Boolean))].slice(-MAX_SEEN_REPLIES);
  const chatActivity = { ...previous.chatActivity };
  for (const chat of Array.isArray(snapshot.privateChats) ? snapshot.privateChats : []) {
    if (!chat?.id) continue;
    chatActivity[chat.id] = Math.max(
      Number(chatActivity[chat.id] || 0),
      Number(chat.lastActivity || chat.createdAt || 0),
    );
  }
  const value = { replyKeys, chatActivity, updatedAt: Date.now() };
  await db.put('settings', { key: readStateKey(userId), value });
  return value;
}
