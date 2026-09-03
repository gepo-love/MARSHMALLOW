export const MOMENTS_REACTION_COMMENT_LEVELS = Object.freeze({
  low: Object.freeze({ min: 0, max: 3 }),
  high: Object.freeze({ min: 3, max: 8 }),
});

export function normalizeMomentsReactionCommentLevel(value = '', legacyCount = null) {
  const level = String(value || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MOMENTS_REACTION_COMMENT_LEVELS, level)) return level;
  const count = Number(legacyCount);
  if (legacyCount != null && Number.isFinite(count)) return count <= 3 ? 'low' : 'high';
  return 'high';
}

/** 每一次生成独立抽签；random 参数只用于稳定测试。 */
export function sampleMomentsReactionCommentCount(level = 'high', random = Math.random) {
  const normalized = normalizeMomentsReactionCommentLevel(level);
  const range = MOMENTS_REACTION_COMMENT_LEVELS[normalized];
  const roll = Math.max(0, Math.min(0.999999999, Number(random?.()) || 0));
  return range.min + Math.floor(roll * (range.max - range.min + 1));
}
