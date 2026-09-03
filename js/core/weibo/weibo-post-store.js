import * as db from '../db.js';
import { deleteWeiboPostMemories } from './weibo-memory-sync.js';

export const WEIBO_DELETE_UNDO_MS = 6500;

export function isWeiboPostDeleted(post = null) {
  return !!post && (post.status === 'deleted' || Number(post.deletedAt || 0) > 0);
}

export function isActiveWeiboPost(post = null) {
  return !!post && !isWeiboPostDeleted(post) && post.status !== 'failed';
}

export function buildSoftDeletedWeiboPost(post, now = Date.now(), undoMs = WEIBO_DELETE_UNDO_MS) {
  if (!post?.id) return null;
  const deletedAt = Math.max(1, Number(now) || Date.now());
  return {
    ...post,
    status: 'deleted',
    deletedAt,
    deleteFinalizedAt: deletedAt + Math.max(0, Number(undoMs) || 0),
  };
}

export function buildRestoredWeiboPost(post) {
  if (!post?.id) return null;
  const next = { ...post, status: 'active' };
  delete next.deletedAt;
  delete next.deleteFinalizedAt;
  return next;
}

export function shouldFinalizeWeiboPostDeletion(post, now = Date.now()) {
  if (!isWeiboPostDeleted(post)) return false;
  const deadline = Number(post.deleteFinalizedAt || post.deletedAt || 0);
  return deadline > 0 && deadline <= Number(now || Date.now());
}

export async function softDeleteWeiboPost(postId, options = {}) {
  const id = String(postId || '').trim();
  if (!id) return null;
  const post = await db.get('weiboPosts', id);
  if (!post) return null;
  const next = buildSoftDeletedWeiboPost(
    post,
    options.now ?? Date.now(),
    options.undoMs ?? WEIBO_DELETE_UNDO_MS,
  );
  await db.put('weiboPosts', next);
  return next;
}

export async function restoreWeiboPost(postId) {
  const id = String(postId || '').trim();
  if (!id) return null;
  const post = await db.get('weiboPosts', id);
  if (!post || !isWeiboPostDeleted(post)) return null;
  const next = buildRestoredWeiboPost(post);
  await db.put('weiboPosts', next);
  return next;
}

export async function finalizeWeiboPostDeletion(postId, postSnapshot = null, options = {}) {
  const id = String(postId || postSnapshot?.id || '').trim();
  if (!id) return false;
  const stored = await db.get('weiboPosts', id);
  const post = stored || postSnapshot;
  if (!post) return false;
  if (options.force !== true && stored && !isWeiboPostDeleted(stored)) return false;
  await deleteWeiboPostMemories(id, post);
  await db.deleteRecord('weiboPosts', id);
  return true;
}

export async function finalizeExpiredWeiboPostDeletions(options = {}) {
  const now = Number(options.now ?? Date.now());
  const ownerUserId = options.ownerUserId == null ? null : String(options.ownerUserId);
  const posts = await db.getAllRecords('weiboPosts');
  const expired = posts.filter((post) => (
    (ownerUserId === null || String(post?.ownerUserId || '') === ownerUserId)
    && shouldFinalizeWeiboPostDeletion(post, now)
  ));
  for (const post of expired) {
    await finalizeWeiboPostDeletion(post.id, post);
  }
  return expired.length;
}

export async function listActiveWeiboPosts(options = {}) {
  const ownerUserId = options.ownerUserId == null ? null : String(options.ownerUserId);
  if (options.finalizeExpired !== false) {
    await finalizeExpiredWeiboPostDeletions({ ownerUserId, now: options.now });
  }
  const posts = await db.getAllRecords('weiboPosts');
  return posts.filter((post) => (
    isActiveWeiboPost(post)
    && (ownerUserId === null || String(post?.ownerUserId || '') === ownerUserId)
  ));
}
