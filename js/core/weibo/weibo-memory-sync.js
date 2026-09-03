import * as db from '../db.js';
import { loadWeiboMetaCompat } from './weibo-meta-store.js';
import { stripLeakedCharacterCodes } from '../chat/character-code-fallback.js';
import { lexicalTimelineSimilarity } from '../memory/unified-event-timeline.js';
import { getWeiboPostVisibility } from './weibo-post-utils.js';

/** 旧版：按条微博写入 memories（已弃用，仅 delete 用于清理历史数据） */
export const WEIBO_GLOBAL_CHAT_ID = '__weibo__';

function cleanHeadlineText(value = '') {
  return stripLeakedCharacterCodes(String(value || ''), { fallbackLabel: '匿名用户' })
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildWeiboGlobalPostHeadline(post = {}) {
  const postId = String(post.id || '').trim();
  const authorName = stripLeakedCharacterCodes(
    String(post.authorName || post.authorId || '用户'),
    { fallbackLabel: '匿名用户' },
  ).trim();
  const content = stripLeakedCharacterCodes(
    String(post.content || ''),
    { fallbackLabel: '某位用户' },
  ).replace(/\s+/g, ' ').trim().slice(0, 72);
  return {
    postId,
    authorName,
    content,
  };
}

export function formatWeiboGlobalPostHeadline(headline = '') {
  if (headline && typeof headline === 'object') {
    const authorName = cleanHeadlineText(headline.authorName || headline.authorId || '用户');
    const content = cleanHeadlineText(headline.content || headline.text || '').slice(0, 72);
    return `${authorName || '匿名用户'}：${content || '…'}`;
  }
  return cleanHeadlineText(headline);
}

export function removeWeiboPostFromGlobalBatches(batches = [], post = {}) {
  const postId = String(post?.id || post?.postId || post || '').trim();
  const legacySignature = post && typeof post === 'object'
    ? formatWeiboGlobalPostHeadline(buildWeiboGlobalPostHeadline(post))
    : '';
  let changed = false;
  const next = (Array.isArray(batches) ? batches : []).map((batch) => {
    if (!batch || !Array.isArray(batch.postHeadlines)) return batch;
    const postHeadlines = batch.postHeadlines.filter((headline) => {
      if (headline && typeof headline === 'object') {
        if (postId && String(headline.postId || '').trim() === postId) {
          changed = true;
          return false;
        }
        return true;
      }
      if (legacySignature && formatWeiboGlobalPostHeadline(headline) === legacySignature) {
        changed = true;
        return false;
      }
      return true;
    });
    return postHeadlines.length === batch.postHeadlines.length
      ? batch
      : { ...batch, postHeadlines };
  });
  return { batches: next, changed };
}

export function replaceWeiboPostInGlobalBatches(batches = [], post = {}) {
  const postId = String(post?.id || '').trim();
  if (!postId) return { batches: Array.isArray(batches) ? batches : [], changed: false };
  if (getWeiboPostVisibility(post) !== 'public') {
    return removeWeiboPostFromGlobalBatches(batches, post);
  }
  const replacement = buildWeiboGlobalPostHeadline(post);
  let changed = false;
  const next = (Array.isArray(batches) ? batches : []).map((batch) => {
    if (!batch || !Array.isArray(batch.postHeadlines)) return batch;
    let batchChanged = false;
    const postHeadlines = batch.postHeadlines.map((headline) => {
      if (!headline || typeof headline !== 'object' || String(headline.postId || '').trim() !== postId) return headline;
      changed = true;
      batchChanged = true;
      return replacement;
    });
    return batchChanged ? { ...batch, postHeadlines } : batch;
  });
  return { batches: next, changed };
}

async function deleteWeiboPostGlobalContext(postId, post = null) {
  const rows = await db.getAllRecords('settings');
  const target = post && typeof post === 'object' ? post : { id: postId };
  for (const row of rows) {
    const key = String(row?.key || '').trim();
    if (key !== 'weiboMeta' && !key.startsWith('weiboMeta_')) continue;
    const meta = row?.value;
    if (!meta || !Array.isArray(meta.globalWeiboBatches)) continue;
    const removed = removeWeiboPostFromGlobalBatches(meta.globalWeiboBatches, target);
    if (!removed.changed) continue;
    await db.put('settings', {
      ...row,
      key,
      value: {
        ...meta,
        globalWeiboBatches: removed.batches,
      },
    });
  }
}

export async function deleteWeiboPostMemories(postId, post = null) {
  if (!postId) return;
  const all = await db.getAllRecords('memories');
  const prefix = `mem_wb_${postId}_`;
  for (const m of all) {
    if (String(m.id || '').startsWith(prefix)) {
      await db.deleteRecord('memories', m.id);
    }
  }
  await deleteWeiboPostGlobalContext(postId, post);
}

function getWeiboMetaKey(userId) {
  return `weiboMeta_${userId || 'guest'}`;
}

// 舆情快照最多保留几次⚡生成：太多会让模型把角色自己现编的一句话当成必须反复延续的「设定」。
const WEIBO_GLOBAL_BATCH_KEEP = 3;

/**
 * 每次 ⚡ 生成结束后追加一条「公共舆情快照」（热搜+简讯+动态摘录），全角色可见；仅保留最近几次。
 * 直接 mutates meta（与微博页 settings 中 weiboMeta 同源）。
 */
export function appendWeiboGlobalContextBatch(meta, { trending = [], news = [], posts = [] }) {
  if (!meta) return;
  const postHeadlines = (posts || [])
    .filter((post) => getWeiboPostVisibility(post) === 'public')
    .slice(0, 16)
    .map(buildWeiboGlobalPostHeadline);
  const batch = {
    ts: Date.now(),
    trending: (trending || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8),
    news: (news || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6),
    postHeadlines,
  };
  meta.globalWeiboBatches = Array.isArray(meta.globalWeiboBatches) ? meta.globalWeiboBatches : [];
  meta.globalWeiboBatches.push(batch);
  meta.globalWeiboBatches = meta.globalWeiboBatches.slice(-WEIBO_GLOBAL_BATCH_KEEP);
}

/**
 * 分层记忆：微博公共舆情块（不按角色过滤，注入所有私聊/群聊续写上下文）。
 */
export async function formatWeiboGlobalBatchesBlock(userId, options = {}) {
  const meta = await loadWeiboMetaCompat(userId);
  const allBatches = meta?.globalWeiboBatches || [];
  const referencedPostIds = [...new Set(allBatches.flatMap((batch) => (
    Array.isArray(batch?.postHeadlines)
      ? batch.postHeadlines
        .filter((headline) => headline && typeof headline === 'object')
        .map((headline) => String(headline.postId || '').trim())
        .filter(Boolean)
      : []
  )))];
  const referencedPosts = referencedPostIds.length
    ? await Promise.all(referencedPostIds.map((postId) => db.get('weiboPosts', postId).catch(() => null)))
    : [];
  const activeGlobalPostIds = new Set(referencedPosts
    .filter((post) => (
      post
      && (!String(post.ownerUserId || '') || String(post.ownerUserId || '') === String(userId || ''))
      && post.status !== 'deleted'
      && post.status !== 'failed'
      && !Number(post.deletedAt || 0)
      && getWeiboPostVisibility(post) === 'public'
    ))
    .map((post) => String(post.id || '').trim())
    .filter(Boolean));
  const decayEnabled = options.decayEnabled === true;
  const now = Number(options.now || Date.now());
  const hotWindowMs = Math.max(1, Number(options.hotWindowMs) || 1);
  const queryText = String(options.queryText || '').trim();
  const batches = decayEnabled
    ? allBatches.filter((batch) => {
      const timestamp = Number(batch?.ts || 0);
      if (timestamp > 0 && now - timestamp <= hotWindowMs) return true;
      if (!queryText) return false;
      const searchable = [
        ...(Array.isArray(batch?.trending) ? batch.trending : []),
        ...(Array.isArray(batch?.news) ? batch.news : []),
        ...(Array.isArray(batch?.postHeadlines)
          ? batch.postHeadlines.map(formatWeiboGlobalPostHeadline)
          : []),
      ].join(' ');
      return lexicalTimelineSimilarity(queryText, searchable) >= 0.08;
    })
    : allBatches;
  // authorId 已有索引；这里只需要 user 本人的公开动态，不能让空档位每轮
  // 都反序列化其它身份的全部微博记录。
  const userPosts = (await db.getAllByIndex('weiboPosts', 'authorId', String(userId || '')).catch(() => []))
    .filter((post) => (
      post
      && String(post.ownerUserId || '') === String(userId || '')
      && String(post.authorId || '') === String(userId || '')
      && post.status !== 'deleted'
      && post.status !== 'failed'
      && !Number(post.deletedAt || 0)
      && getWeiboPostVisibility(post) === 'public'
    ))
    .sort((left, right) => Number(right.timestamp || right.createdAt || 0) - Number(left.timestamp || left.createdAt || 0))
    .slice(0, 3);
  if (!batches.length && !userPosts.length) return '';

  const sections = [];
  if (userPosts.length) {
    const lines = userPosts.map((post) => {
      const content = cleanHeadlineText(post.content || '').slice(0, 500);
      const tags = (Array.isArray(post.tags) ? post.tags : [])
        .map((tag) => cleanHeadlineText(tag))
        .filter(Boolean)
        .slice(0, 4);
      const imageCount = (Array.isArray(post.images) ? post.images : []).filter(Boolean).length;
      const payload = [
        content || (post.textImage ? cleanHeadlineText(post.textImage).slice(0, 220) : '（图片微博）'),
        tags.length ? `话题：${tags.join('、')}` : '',
        imageCount ? `配图 ${imageCount} 张` : '',
      ].filter(Boolean).join(' ｜ ');
      return `- ${payload}`;
    });
    sections.push([
      '=== 来源：user 本人在站内发布的公开微博（确定事实）===',
      '下列内容确实由 user 本人发布，当前对话角色能够看到并知道这些内容；不得把它误认成角色或路人的动态，也不要回答“没看到／不知道 user 发过”。',
      lines.join('\n'),
      '用法：结合人设和当前话题自然回应；不要求每轮主动提起，一次最多引用一条，不要把动态逐条复述成汇报。',
    ].join('\n'));
  }

  if (!batches.length) return sections.join('\n\n');
  const userPostIds = new Set(userPosts.map((post) => String(post.id || '')).filter(Boolean));
  let out =
    `\n=== 来源：微博公共舆情（站内热搜/新闻 · 全服可见 · 最近至多 ${WEIBO_GLOBAL_BATCH_KEEP} 次⚡生成）===\n`
    + '说明：下列内容仅是「可能听说过的背景资讯」，不代表角色本人关注、认同或记挂它；是否知晓、要不要提全由角色当下状态和人设决定，多数时候完全不提也正常。\n'
    + '禁止连续多轮反复念叨同一条动态或话题（除非该角色设定本来就长期关心这件事）；心声同样适用，不要把这里的资讯写成角色反复咀嚼的心事。\n';
  for (const b of batches) {
    const t = new Date(b.ts || Date.now()).toLocaleString('zh-CN');
    out += `--- ${t} ---\n`;
    if (b.trending?.length) out += `热搜：${b.trending.join('、')}\n`;
    if (b.news?.length) out += `简讯：${b.news.join('；')}\n`;
    if (b.postHeadlines?.length) {
      const safeHeadlines = b.postHeadlines
        .filter((headline) => {
          if (!headline || typeof headline !== 'object') return true;
          const postId = String(headline.postId || '').trim();
          if (postId && !activeGlobalPostIds.has(postId)) return false;
          return !userPostIds.has(postId);
        })
        .map(formatWeiboGlobalPostHeadline)
        .filter(Boolean);
      if (safeHeadlines.length) out += `动态摘录：\n${safeHeadlines.map((x) => `- ${x}`).join('\n')}\n`;
    }
  }
  sections.push(out.trim());
  return sections.join('\n\n');
}
