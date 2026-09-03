/** 微博列表/详情共用的互动数字与模拟展示（与存档字段取 max，避免详情与信息流不一致） */

export function hashCode(s) {
  let h = 0;
  const t = String(s || '');
  for (let i = 0; i < t.length; i += 1) h = (h << 5) - h + t.charCodeAt(i);
  return Math.abs(h);
}

export function seededNoise(seed, min = 0, max = 1) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  const n = x - Math.floor(x);
  return min + (max - min) * n;
}

export function formatSocialCount(v) {
  const n = Math.max(0, Number(v) || 0);
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.floor(n));
}

export function simulatePostMetrics(post) {
  const visibility = String(post?.metadata?.visibility ?? post?.visibility ?? 'public').trim();
  if (visibility === 'private') return { likes: 0, comments: 0, reposts: 0 };
  const seed = hashCode(post?.id || post?.content || '');
  const baseLikes = Number(post?.likes || 0);
  const baseComments = Number(post?.comments || 0);
  const baseReposts = Number(post?.reposts || 0);
  const likes = Math.max(baseLikes, Math.floor(120 + seededNoise(seed + 1, 0, 9800)));
  const comments = Math.max(baseComments, Math.floor(16 + seededNoise(seed + 2, 0, 1800)));
  const reposts = Math.max(baseReposts, Math.floor(8 + seededNoise(seed + 3, 0, 1200)));
  return { likes, comments, reposts };
}

/** 单条评论展示用点赞（不低于 AI 给定值，并带少量随机避免全 0） */
export function estimateCommentLike(post, c) {
  const seed = hashCode(`${post?.id || ''}_${c?.author || ''}_${c?.content || ''}`);
  return Math.max(Number(c?.likes || 0), Math.floor(6 + seededNoise(seed, 0, 480)));
}
