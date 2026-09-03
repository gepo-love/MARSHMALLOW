import { get, put } from './db.js';
import { resolveDefaultAvatar } from './default-avatar.js';

const PROFILE_LEFT = ['晚风', '微光', '云层', '海盐', '空格', '北纬', '长街', '回声', '晨雾', '余温'];
const PROFILE_RIGHT = ['旅人', '汽水', '灯塔', '纸片', '候鸟', '信号', '月台', '轨迹', '小窗', '薄荷'];

function clean(value = '') {
  return String(value ?? '').trim();
}

function hashCode(input = '') {
  let hash = 0;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function profileSettingsKey(userId = '') {
  return `anonymousNetworkProfiles_${clean(userId) || 'guest'}`;
}

export function buildAnonymousProfileId(actorId = '') {
  const id = clean(actorId);
  return id === 'user' ? 'anon_profile_user' : `anon_profile_${id}`;
}

export function buildDefaultNetworkHandle(actorId = '') {
  const id = clean(actorId) || 'anonymous';
  const code = hashCode(`network-profile|${id}`);
  const left = PROFILE_LEFT[code % PROFILE_LEFT.length];
  const right = PROFILE_RIGHT[Math.floor(code / PROFILE_LEFT.length) % PROFILE_RIGHT.length];
  return `${left}${right}`;
}

export function buildDefaultNetworkProfile(actorId = '', options = {}) {
  const id = clean(actorId);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const userRow = options.userRow || null;
  const character = options.character || null;
  const spaceProfile = id === 'user' ? (options.spaceProfile || null) : null;
  const handle = clean(spaceProfile?.handle)
    || clean(options.handle)
    || buildDefaultNetworkHandle(id);
  const avatar = clean(spaceProfile?.avatar) || clean(options.avatar) || resolveDefaultAvatar('anonymous');
  const avatarStyle = avatar || clean(options.avatarStyle);
  const signature = clean(spaceProfile?.signature)
    || clean(spaceProfile?.bio)
    || clean(options.signature)
    || (character?.personality
      ? `${handle}，普通网友，话题随缘`
      : `${handle}，路过型网友`);
  return {
    id: buildAnonymousProfileId(id),
    actorId: id,
    handle,
    displayName: handle,
    avatarStyle,
    avatar,
    signature,
    bio: signature,
    tags: [],
    visibility: 'anonymous_contact',
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadAnonymousNetworkProfiles(userId = '') {
  const row = await get(profileSettingsKey(userId));
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return { ...value };
}

export async function saveAnonymousNetworkProfiles(userId = '', profiles = {}) {
  await put('settings', {
    key: profileSettingsKey(userId),
    value: profiles && typeof profiles === 'object' ? profiles : {},
  });
}

export async function ensureAnonymousNetworkProfile(userId = '', actorId = '', options = {}) {
  const id = clean(actorId);
  if (!id) return null;
  const profiles = await loadAnonymousNetworkProfiles(userId);
  const existing = profiles[id] && typeof profiles[id] === 'object' ? profiles[id] : null;
  if (existing?.id && existing?.handle) return existing;
  const profile = buildDefaultNetworkProfile(id, options);
  profiles[id] = profile;
  await saveAnonymousNetworkProfiles(userId, profiles);
  return profile;
}

export async function ensureAnonymousNetworkProfiles(userId = '', actorIds = [], options = {}) {
  const ids = [...new Set((Array.isArray(actorIds) ? actorIds : []).map(clean).filter(Boolean))];
  const profiles = await loadAnonymousNetworkProfiles(userId);
  let changed = false;
  const out = {};
  for (const actorId of ids) {
    const existing = profiles[actorId] && typeof profiles[actorId] === 'object' ? profiles[actorId] : null;
    if (existing?.id && existing?.handle) {
      out[actorId] = existing;
      continue;
    }
    const profile = buildDefaultNetworkProfile(actorId, {
      ...options,
      character: options.characterMap?.get?.(actorId) || options.charactersById?.[actorId] || null,
    });
    profiles[actorId] = profile;
    out[actorId] = profile;
    changed = true;
  }
  if (changed) await saveAnonymousNetworkProfiles(userId, profiles);
  return out;
}

export function attachNetworkProfileToIdentity(identity = {}, profile = null) {
  if (!profile) return { ...(identity || {}) };
  return {
    ...(identity || {}),
    profileId: clean(profile.id),
    networkHandle: clean(profile.handle),
    networkAvatarStyle: clean(profile.avatarStyle),
    networkSignature: clean(profile.signature),
  };
}

export function attachNetworkProfilesToIdentityMap(identityMap = {}, profileMap = {}) {
  const out = {};
  for (const [actorId, identity] of Object.entries(identityMap || {})) {
    out[actorId] = attachNetworkProfileToIdentity(identity, profileMap[actorId]);
  }
  return out;
}
