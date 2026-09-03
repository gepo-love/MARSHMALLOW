function shuffled(items = [], random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const value = Number(random());
    const unit = Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0;
    const swapIndex = Math.floor(unit * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function mixedByFollowing(characters, followingIds, random) {
  const followed = shuffled(characters.filter((character) => followingIds.has(character.id)), random);
  const others = shuffled(characters.filter((character) => !followingIds.has(character.id)), random);
  const mixed = [];
  while (followed.length || others.length) {
    if (followed.length) mixed.push(followed.shift());
    if (others.length) mixed.push(others.shift());
  }
  return mixed;
}

export function selectMusicCommentCandidates(characters = [], options = {}) {
  const limit = Math.max(1, Math.floor(Number(options.limit || 6) || 6));
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const followingIds = new Set((options.followingCharacterIds || []).map(String));
  const existingIds = new Set((options.existingCommentCharacterIds || []).map(String));
  const recentIds = new Set((options.recentCommentCharacterIds || []).map(String));
  const seen = new Set();
  const pool = (Array.isArray(characters) ? characters : []).filter((character) => {
    const id = String(character?.id || '').trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const fresh = [];
  const recent = [];
  const alreadyHere = [];
  pool.forEach((character) => {
    if (existingIds.has(character.id)) alreadyHere.push(character);
    else if (recentIds.has(character.id)) recent.push(character);
    else fresh.push(character);
  });
  return [fresh, recent, alreadyHere]
    .flatMap((bucket) => mixedByFollowing(bucket, followingIds, random))
    .slice(0, limit);
}

/**
 * 先在本地确定本轮真正出场的评论者，再让模型只负责写这些人的评论。
 * 避免模型面对较大的候选池时长期偏爱同一批熟悉角色。
 */
export function selectMusicCommentBatch(characters = [], options = {}) {
  const poolSize = new Set((Array.isArray(characters) ? characters : [])
    .map((character) => String(character?.id || '').trim())
    .filter(Boolean)).size;
  if (!poolSize) return [];
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const max = Math.min(poolSize, Math.max(1, Math.floor(Number(options.max || 4) || 4)));
  const min = Math.min(max, Math.max(1, Math.floor(Number(options.min || 2) || 2)));
  const value = Number(random());
  const unit = Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0;
  const limit = min + Math.floor(unit * (max - min + 1));
  return selectMusicCommentCandidates(characters, { ...options, random, limit });
}

export function pickUniqueMusicCommentAuthor(requestedId, candidates = [], usedIds = new Set()) {
  const requested = candidates.find((character) => (
    character.id === requestedId && !usedIds.has(character.id)
  ));
  return requested || candidates.find((character) => !usedIds.has(character.id)) || null;
}
