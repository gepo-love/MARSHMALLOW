function text(value = '') {
  return String(value ?? '').trim();
}

export function normalizeWeiboSearchQuery(value = '') {
  return text(value).replace(/^#+|#+$/g, '').trim().toLowerCase();
}

function topicLabel(value = '') {
  if (value && typeof value === 'object') value = value.topic || value.title || value.name || value.keyword || '';
  return text(value).replace(/^#+|#+$/g, '').trim();
}

function addTopic(map, value, timestamp = 0) {
  const label = topicLabel(value);
  if (!label) return;
  const key = normalizeWeiboSearchQuery(label);
  const current = map.get(key) || { key, label, postCount: 0, latestTimestamp: 0 };
  current.latestTimestamp = Math.max(current.latestTimestamp, Number(timestamp || 0));
  map.set(key, current);
}

export function buildWeiboDiscoveryIndex({ posts = [], meta = {}, currentUser = null } = {}) {
  const profileMap = new Map();
  const topicMap = new Map();
  const followingIds = new Set((meta.followingIds || []).map(String));
  const ensureProfile = (key, authorId, authorName) => {
    const safeKey = text(key || authorId || authorName);
    if (!safeKey) return null;
    if (!profileMap.has(safeKey)) {
      const saved = meta.profiles?.[safeKey] || meta.profiles?.[authorId] || meta.profiles?.[authorName] || {};
      profileMap.set(safeKey, {
        key: safeKey,
        authorId: text(authorId),
        authorName: text(authorName) || '微博用户',
        bio: text(saved.bio),
        fans: Math.max(0, Number(saved.fans || 0)),
        postCount: 0,
        latestTimestamp: 0,
        following: followingIds.has(safeKey) || followingIds.has(text(authorId)) || followingIds.has(text(authorName)),
      });
    }
    return profileMap.get(safeKey);
  };

  if (currentUser) {
    const name = text(currentUser.weiboNickname || currentUser.nickname || currentUser.name) || '我';
    const profile = ensureProfile(currentUser.id || name, currentUser.id, name);
    if (profile) {
      profile.isSelf = true;
      profile.bio = text(currentUser.weiboBio || currentUser.bio || profile.bio);
      profile.fans = Math.max(profile.fans, Number(currentUser.weiboFans || 0));
    }
  }

  for (const post of posts || []) {
    const authorName = text(post.authorName) || '微博用户';
    const authorId = text(post.authorId);
    const profile = ensureProfile(authorId || authorName, authorId, authorName);
    if (profile) {
      profile.postCount += 1;
      profile.latestTimestamp = Math.max(profile.latestTimestamp, Number(post.timestamp || 0));
      profile.fans = Math.max(profile.fans, Number(post.fans || 0));
    }
    for (const tag of Array.isArray(post.tags) ? post.tags : []) addTopic(topicMap, tag, post.timestamp);
    for (const match of text(post.content).matchAll(/#([^#\n]{1,60})#/g)) addTopic(topicMap, match[1], post.timestamp);
  }

  for (const value of meta.trending || []) addTopic(topicMap, value);
  for (const profile of profileMap.values()) {
    const saved = meta.profiles?.[profile.key] || {};
    if (saved.bio) profile.bio = text(saved.bio);
    if (saved.fans != null) profile.fans = Math.max(0, Number(saved.fans) || 0);
  }
  for (const post of posts || []) {
    const seen = new Set();
    for (const raw of [...(Array.isArray(post.tags) ? post.tags : []), ...[...text(post.content).matchAll(/#([^#\n]{1,60})#/g)].map((m) => m[1])]) {
      const key = normalizeWeiboSearchQuery(raw);
      if (!key || seen.has(key) || !topicMap.has(key)) continue;
      seen.add(key);
      topicMap.get(key).postCount += 1;
    }
  }
  return {
    profiles: [...profileMap.values()].sort((a, b) => b.latestTimestamp - a.latestTimestamp || b.postCount - a.postCount),
    posts: [...(posts || [])].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)),
    topics: [...topicMap.values()].sort((a, b) => b.postCount - a.postCount || b.latestTimestamp - a.latestTimestamp),
  };
}

export function searchWeiboDiscovery(index = {}, query = '') {
  const q = normalizeWeiboSearchQuery(query);
  if (!q) return { profiles: [], posts: [], topics: [] };
  const includes = (value) => text(value).toLowerCase().includes(q);
  return {
    profiles: (index.profiles || []).filter((item) => includes(item.authorName) || includes(item.bio) || includes(item.key)),
    posts: (index.posts || []).filter((item) => includes(item.content) || includes(item.authorName) || (item.tags || []).some(includes)),
    topics: (index.topics || []).filter((item) => includes(item.label)),
  };
}
