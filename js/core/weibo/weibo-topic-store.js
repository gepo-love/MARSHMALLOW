import * as db from '../db.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

function storeKey(ownerUserId = '') {
  return `weiboSuperTopics_${clean(ownerUserId) || 'guest'}`;
}

export function normalizeWeiboTopicKey(topic = '') {
  return clean(topic).replace(/^#+|#+$/g, '').trim().toLowerCase().slice(0, 80);
}

function localDateKey(now = Date.now()) {
  const date = new Date(Number(now || Date.now()));
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function previousLocalDateKey(now = Date.now()) {
  const date = new Date(Number(now || Date.now()));
  date.setDate(date.getDate() - 1);
  return localDateKey(date.getTime());
}

export function normalizeWeiboSuperTopic(value = {}, options = {}) {
  const key = normalizeWeiboTopicKey(options.topic || value.key || value.name);
  const displayName = clean(value.name).replace(/^#+|#+$/g, '') || key || '话题';
  return {
    id: clean(value.id) || `wb_super_${key || 'topic'}`,
    ownerUserId: clean(options.ownerUserId || value.ownerUserId) || 'guest',
    key,
    name: displayName,
    description: clean(value.description) || `聚集「${displayName}」相关的新鲜事与讨论`,
    hostName: clean(value.hostName) || '超话主持人',
    cover: clean(value.cover),
    avatar: clean(value.avatar),
    following: value.following === true,
    memberCount: Math.max(1, Number(value.memberCount || options.memberCount || 1) || 1),
    postCount: Math.max(0, Number(options.postCount ?? value.postCount ?? 0) || 0),
    checkInCount: Math.max(0, Number(value.checkInCount || 0) || 0),
    checkInStreak: Math.max(0, Number(value.checkInStreak || 0) || 0),
    lastCheckInDate: clean(value.lastCheckInDate),
    channel: ['popular', 'latest', 'featured'].includes(value.channel) ? value.channel : 'popular',
    createdAt: Math.max(0, Number(value.createdAt || Date.now()) || Date.now()),
    updatedAt: Math.max(0, Number(value.updatedAt || Date.now()) || Date.now()),
  };
}

async function loadMap(ownerUserId = '') {
  const row = await db.get('settings', storeKey(ownerUserId));
  return row?.value && typeof row.value === 'object' ? { ...row.value } : {};
}

async function saveMap(ownerUserId = '', value = {}) {
  await db.put('settings', { key: storeKey(ownerUserId), value });
}

export async function getOrCreateWeiboSuperTopic(ownerUserId = '', topic = '', options = {}) {
  const key = normalizeWeiboTopicKey(topic);
  if (!key) throw new Error('话题不能为空');
  const map = await loadMap(ownerUserId);
  const profile = normalizeWeiboSuperTopic(map[key] || {}, {
    ...options,
    ownerUserId,
    topic: key,
  });
  map[key] = profile;
  await saveMap(ownerUserId, map);
  return profile;
}

export async function saveWeiboSuperTopic(ownerUserId = '', topic = '', patch = {}) {
  const key = normalizeWeiboTopicKey(topic);
  const map = await loadMap(ownerUserId);
  const previous = normalizeWeiboSuperTopic(map[key] || {}, { ownerUserId, topic: key });
  const next = normalizeWeiboSuperTopic({ ...previous, ...patch, updatedAt: Date.now() }, {
    ownerUserId,
    topic: key,
    postCount: patch.postCount ?? previous.postCount,
  });
  map[key] = next;
  await saveMap(ownerUserId, map);
  return next;
}

export async function toggleWeiboSuperTopicFollow(ownerUserId = '', topic = '') {
  const current = await getOrCreateWeiboSuperTopic(ownerUserId, topic);
  return saveWeiboSuperTopic(ownerUserId, topic, {
    following: !current.following,
    memberCount: Math.max(1, current.memberCount + (current.following ? -1 : 1)),
  });
}

export function applyWeiboSuperTopicCheckIn(profile = {}, options = {}) {
  const now = Number(options.now || Date.now());
  const today = localDateKey(now);
  const current = normalizeWeiboSuperTopic(profile, {
    ownerUserId: profile.ownerUserId,
    topic: profile.key || profile.name,
  });
  if (current.lastCheckInDate === today) return { profile: current, checkedIn: false };
  const continued = current.lastCheckInDate === previousLocalDateKey(now);
  return {
    checkedIn: true,
    profile: normalizeWeiboSuperTopic({
      ...current,
      lastCheckInDate: today,
      checkInCount: current.checkInCount + 1,
      checkInStreak: continued ? current.checkInStreak + 1 : 1,
      updatedAt: now,
    }, { ownerUserId: current.ownerUserId, topic: current.key, postCount: current.postCount }),
  };
}

export async function checkInWeiboSuperTopic(ownerUserId = '', topic = '', options = {}) {
  const current = await getOrCreateWeiboSuperTopic(ownerUserId, topic);
  const result = applyWeiboSuperTopicCheckIn(current, options);
  if (!result.checkedIn) return result;
  const map = await loadMap(ownerUserId);
  map[current.key] = result.profile;
  await saveMap(ownerUserId, map);
  return result;
}

function engagementScore(post = {}) {
  return Math.max(0, Number(post.likes || 0))
    + Math.max(0, Number(post.comments || 0)) * 2
    + Math.max(0, Number(post.reposts || 0)) * 2.4;
}

export function isWeiboSuperTopicFeaturedPost(post = {}) {
  return post?.metadata?.superTopicFeatured === true
    || post?.metadata?.featured === true
    || engagementScore(post) >= 180;
}

export function sortWeiboSuperTopicPosts(posts = [], channel = 'popular') {
  const normalized = ['popular', 'latest', 'featured'].includes(channel) ? channel : 'popular';
  const scoped = normalized === 'featured'
    ? (posts || []).filter(isWeiboSuperTopicFeaturedPost)
    : [...(posts || [])];
  if (normalized === 'latest' || normalized === 'featured') {
    return scoped.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)
      || String(a.id || '').localeCompare(String(b.id || '')));
  }
  return scoped.sort((a, b) => engagementScore(b) - engagementScore(a)
    || Number(b.timestamp || 0) - Number(a.timestamp || 0)
    || String(a.id || '').localeCompare(String(b.id || '')));
}
