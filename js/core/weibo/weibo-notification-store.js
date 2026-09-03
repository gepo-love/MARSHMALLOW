import * as db from '../db.js';

const PREFIX = 'weiboNotifications_';
const LIMIT = 500;

function clean(value = '') {
  return String(value ?? '').trim();
}

function keyFor(ownerUserId) {
  return `${PREFIX}${clean(ownerUserId) || 'guest'}`;
}

function fingerprint(item = {}) {
  return [item.type, item.postId, item.commentId, item.actorId || item.actorName, item.content].map(clean).join('|');
}

function notificationSort(a, b) {
  return Number(b?.timestamp || 0) - Number(a?.timestamp || 0)
    || Number(b?.createdAt || 0) - Number(a?.createdAt || 0)
    || clean(b?.id).localeCompare(clean(a?.id));
}

export async function listWeiboNotifications(ownerUserId, { type = '', unreadOnly = false } = {}) {
  const row = await db.get('settings', keyFor(ownerUserId));
  return (Array.isArray(row?.value) ? row.value : [])
    .filter((item) => !item.deletedAt)
    .filter((item) => !type || item.type === type || (type === 'comment' && item.type === 'mention'))
    .filter((item) => !unreadOnly || !item.readAt)
    .sort(notificationSort);
}

export async function appendWeiboNotification(ownerUserId, input = {}) {
  const owner = clean(ownerUserId) || 'guest';
  const list = await listWeiboNotifications(owner);
  const item = {
    id: clean(input.id) || `wbn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: owner,
    type: ['comment', 'mention', 'like', 'follow'].includes(input.type) ? input.type : 'comment',
    actorId: clean(input.actorId),
    actorName: clean(input.actorName) || '微博用户',
    content: clean(input.content),
    postId: clean(input.postId),
    commentId: clean(input.commentId),
    timestamp: Number(input.timestamp || Date.now()),
    createdAt: Number(input.createdAt || Date.now()),
    readAt: Number(input.readAt || 0),
  };
  const mark = fingerprint(item);
  if (list.some((row) => fingerprint(row) === mark)) return null;
  await db.put('settings', { key: keyFor(owner), value: [...list, item].sort(notificationSort).slice(0, LIMIT) });
  return item;
}

export async function markWeiboNotificationsRead(ownerUserId, type = '') {
  const owner = clean(ownerUserId) || 'guest';
  const row = await db.get('settings', keyFor(owner));
  const list = Array.isArray(row?.value) ? row.value : [];
  const now = Date.now();
  let changed = false;
  const next = list.map((item) => {
    const matches = !type || item.type === type || (type === 'comment' && item.type === 'mention');
    if (!matches || item.readAt) return item;
    changed = true;
    return { ...item, readAt: now };
  });
  if (changed) await db.put('settings', { key: keyFor(owner), value: next });
  return changed;
}

export async function removeWeiboCommentNotification(ownerUserId, { postId = '', commentId = '' } = {}) {
  const owner = clean(ownerUserId) || 'guest';
  const targetPostId = clean(postId);
  const targetCommentId = clean(commentId);
  if (!targetPostId || !targetCommentId) return false;
  const row = await db.get('settings', keyFor(owner));
  const list = Array.isArray(row?.value) ? row.value : [];
  const next = list.filter((item) => !(
    clean(item?.postId) === targetPostId
    && clean(item?.commentId) === targetCommentId
    && ['comment', 'mention'].includes(clean(item?.type))
  ));
  if (next.length === list.length) return false;
  await db.put('settings', { key: keyFor(owner), value: next });
  return true;
}

export async function getWeiboNotificationUnreadCounts(ownerUserId) {
  const list = await listWeiboNotifications(ownerUserId, { unreadOnly: true });
  return list.reduce((counts, item) => {
    const key = item.type === 'mention' ? 'comment' : item.type;
    counts[key] = Number(counts[key] || 0) + 1;
    counts.total += 1;
    return counts;
  }, { total: 0, comment: 0, like: 0, follow: 0 });
}

export async function clearWeiboNotificationData(ownerUserId) {
  await db.remove(keyFor(ownerUserId));
}

export async function appendWeiboCommentNotifications({ ownerUserId, user, post, comments = [] } = {}) {
  const userId = clean(user?.id);
  const userNames = new Set([user?.weiboNickname, user?.nickname, user?.name].map(clean).filter(Boolean));
  const isUserPost = userId && clean(post?.authorId) === userId;
  let added = 0;
  for (const comment of comments) {
    if (!comment || clean(comment.authorId) === userId) continue;
    const replyTo = clean(comment.replyTo);
    const mentioned = [...userNames].some((name) => replyTo === name || clean(comment.content).includes(`@${name}`));
    if (!isUserPost && !mentioned) continue;
    const saved = await appendWeiboNotification(ownerUserId, {
      type: mentioned ? 'mention' : 'comment',
      actorId: comment.authorId,
      actorName: comment.author,
      content: comment.content,
      postId: post?.id,
      commentId: comment.id,
      timestamp: comment.timestamp,
    });
    if (saved) added += 1;
  }
  return added;
}
