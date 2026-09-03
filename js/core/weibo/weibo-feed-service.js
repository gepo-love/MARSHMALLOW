function compactFingerprintText(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#[^#\n]{1,80}#/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 260);
}

function repostParts(post = {}) {
  const repost = post?.metadata?.repostFrom || {};
  return [
    post.repostFromAuthorId,
    post.repostFromAuthorName,
    post.repostComment,
    repost.authorId,
    repost.authorName,
    repost.content,
  ].filter(Boolean).join('|');
}

export function buildWeiboPostFingerprint(post = {}, options = {}) {
  const author = compactFingerprintText(post.authorId || post.authorName || 'npc');
  const body = compactFingerprintText(post.content || post.text || '');
  const repost = compactFingerprintText(repostParts(post));
  const key = `${author}|${body}|${repost}`;
  if (options.bodyOnly === true) return body || repost;
  return key;
}

export function filterNovelWeiboCandidates(candidates = [], existingPosts = [], options = {}) {
  const max = Math.max(1, Number(options.limit) || 99);
  const exact = new Set();
  const substantialBodies = new Set();
  for (const post of existingPosts || []) {
    exact.add(buildWeiboPostFingerprint(post));
    const body = buildWeiboPostFingerprint(post, { bodyOnly: true });
    if (body.length >= 16) substantialBodies.add(body);
  }
  const kept = [];
  let duplicateCount = 0;
  for (const post of candidates || []) {
    if (!post || typeof post !== 'object') continue;
    const exactKey = buildWeiboPostFingerprint(post);
    const bodyKey = buildWeiboPostFingerprint(post, { bodyOnly: true });
    const duplicate = exact.has(exactKey) || (bodyKey.length >= 16 && substantialBodies.has(bodyKey));
    if (duplicate) {
      duplicateCount += 1;
      continue;
    }
    exact.add(exactKey);
    if (bodyKey.length >= 16) substantialBodies.add(bodyKey);
    kept.push(post);
    if (kept.length >= max) break;
  }
  return { posts: kept, duplicateCount };
}

export function createWeiboGenerationBatch(options = {}) {
  const now = Number(options.now || Date.now());
  const mode = options.mode === 'refresh' ? 'refresh' : 'full';
  return {
    id: `wb_batch_${now}_${Math.random().toString(36).slice(2, 7)}`,
    mode,
    createdAt: now,
    requestedCount: Math.max(1, Number(options.requestedCount) || (mode === 'refresh' ? 4 : 8)),
  };
}

export function appendWeiboFeedBatch(meta, batch, posts = [], options = {}) {
  if (!meta || !batch?.id) return;
  const rows = Array.isArray(meta.weiboFeedBatches) ? meta.weiboFeedBatches : [];
  rows.push({
    ...batch,
    insertedCount: posts.length,
    duplicateCount: Math.max(0, Number(options.duplicateCount) || 0),
    postIds: posts.map((post) => String(post?.id || '')).filter(Boolean),
  });
  meta.weiboFeedBatches = rows.slice(-20);
}

export function normalizeWeiboFeedChannel(value = '') {
  return ['recommended', 'following', 'latest'].includes(value) ? value : 'latest';
}

export function resolvePendingWeiboPostIds(meta = {}, now = Date.now(), maxAgeMs = 10 * 60 * 1000) {
  const pendingCount = Math.max(0, Number(meta?.pendingNewPostCount || 0));
  const pendingAt = Number(meta?.pendingNewPostAt || 0);
  if (!pendingCount || !pendingAt || Number(now) - pendingAt >= Math.max(0, Number(maxAgeMs) || 0)) {
    return new Set();
  }
  const batches = Array.isArray(meta?.weiboFeedBatches) ? meta.weiboFeedBatches : [];
  const latest = batches[batches.length - 1] || null;
  if (!latest || !Array.isArray(latest.postIds)) return new Set();
  return new Set(latest.postIds.map((id) => String(id || '').trim()).filter(Boolean));
}

function recommendationScore(post = {}, options = {}) {
  const now = Number(options.now || Date.now());
  const ageHours = Math.max(0, (now - Number(post.timestamp || 0)) / 3600000);
  const recency = Math.max(0, 96 - Math.min(96, ageHours));
  const followingIds = options.followingIds instanceof Set ? options.followingIds : new Set(options.followingIds || []);
  const profileKey = String(post.authorId || post.authorName || '');
  const relation = String(post.authorId || '') === String(options.userId || '')
    ? 80
    : (followingIds.has(profileKey) ? 34 : 0);
  const engagement = Math.log10(1
    + Math.max(0, Number(post.likes || 0))
    + Math.max(0, Number(post.comments || 0)) * 2
    + Math.max(0, Number(post.reposts || 0)) * 2.4) * 9;
  const discussion = Math.min(12, (Array.isArray(post.commentList) ? post.commentList.length : 0) * 2);
  const media = (Array.isArray(post.images) && post.images.length) || post.textImage ? 3 : 0;
  return recency + relation + engagement + discussion + media;
}

export function sortWeiboFeedPosts(posts = [], channel = 'recommended', options = {}) {
  const normalized = normalizeWeiboFeedChannel(channel);
  const followingIds = options.followingIds instanceof Set
    ? options.followingIds
    : new Set((options.followingIds || []).map(String));
  const userId = String(options.userId || '');
  const promotedIds = options.promotedIds instanceof Set
    ? options.promotedIds
    : new Set((options.promotedIds || []).map(String));
  const scoped = normalized === 'following'
    ? (posts || []).filter((post) => (
      String(post.authorId || '') === userId
      || followingIds.has(String(post.authorId || post.authorName || ''))
    ))
    : [...(posts || [])];
  if (normalized === 'recommended') {
    return scoped.sort((a, b) => (
      Number(promotedIds.has(String(b?.id || ''))) - Number(promotedIds.has(String(a?.id || '')))
      || recommendationScore(b, { ...options, followingIds, userId })
      - recommendationScore(a, { ...options, followingIds, userId })
      || Number(b.timestamp || 0) - Number(a.timestamp || 0)
      || String(a.id || '').localeCompare(String(b.id || ''))
    ));
  }
  return scoped.sort((a, b) => (
    Number(promotedIds.has(String(b?.id || ''))) - Number(promotedIds.has(String(a?.id || '')))
    || Number(b.timestamp || 0) - Number(a.timestamp || 0)
    || String(a.id || '').localeCompare(String(b.id || ''))
  ));
}

export function buildWeiboFeedPage(posts = [], options = {}) {
  const pageSize = Math.max(4, Number(options.pageSize) || 12);
  const visibleCount = Math.max(pageSize, Number(options.visibleCount) || pageSize);
  const items = (posts || []).slice(0, visibleCount);
  const tail = items[items.length - 1] || null;
  return {
    items,
    total: posts.length,
    visibleCount: items.length,
    hasMore: items.length < posts.length,
    cursor: tail ? { timestamp: Number(tail.timestamp || 0), id: String(tail.id || '') } : null,
    nextVisibleCount: Math.min(posts.length, items.length + pageSize),
  };
}
