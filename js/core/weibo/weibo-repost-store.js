import * as db from '../db.js';
import { isPrivateWeiboPost } from './weibo-post-utils.js';

function clean(value = '', max = 800) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function mention(name = '') {
  const value = clean(name, 80).replace(/^@+/, '');
  return value ? `@${value}` : '@原作者';
}

export function buildWeiboRepostRecords({
  sourcePost,
  ownerUserId = 'guest',
  authorId = 'guest',
  authorName = '匿名用户',
  avatar = null,
  comment = '',
  timestamp = Date.now(),
  repostPostId = '',
} = {}) {
  if (!sourcePost?.id) throw new Error('微博不存在');
  if (isPrivateWeiboPost(sourcePost)) throw new Error('仅自己可见的微博不能转发');
  const sourceAuthorName = clean(sourcePost.authorName || sourcePost.authorId || '原作者', 80);
  const text = clean(comment);
  const repostEntry = {
    authorId: clean(authorId, 120),
    author: clean(authorName, 80) || '匿名用户',
    content: `${mention(sourceAuthorName)} ${text || '转发微博'}`.trim(),
    timestamp,
  };
  const sourceRecord = {
    ...sourcePost,
    repostList: [...(Array.isArray(sourcePost.repostList) ? sourcePost.repostList : []), repostEntry],
  };
  sourceRecord.reposts = Math.max(Number(sourcePost.reposts || 0), sourceRecord.repostList.length);
  const repostRecord = {
    id: repostPostId || `weibo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ownerUserId: clean(ownerUserId, 120) || 'guest',
    authorId: clean(authorId, 120) || 'guest',
    authorName: clean(authorName, 80) || '匿名用户',
    avatar: avatar || null,
    content: text || `转发了 ${mention(sourceAuthorName)}`,
    images: [],
    timestamp,
    reposts: 0,
    comments: 0,
    likes: 0,
    metadata: {
      repostFrom: {
        authorId: clean(sourcePost.authorId, 120),
        authorName: sourceAuthorName,
        postId: clean(sourcePost.id, 160),
        content: clean(sourcePost.content, 160),
      },
    },
  };
  return { sourceRecord, repostRecord, repostEntry };
}

export async function saveWeiboRepost(options = {}) {
  const records = buildWeiboRepostRecords(options);
  await db.putMany('weiboPosts', [records.sourceRecord, records.repostRecord]);
  return records;
}
