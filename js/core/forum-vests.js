import * as db from './db.js';

/** 论坛马甲身份组：预设几档中性文案 + 支持自定义文本，不做结构化权限系统。 */
export const FORUM_VEST_BADGE_PRESETS = [
  { id: 'normal', label: '普通用户' },
  { id: 'verified', label: '认证用户' },
  { id: 'senior', label: '资深会员' },
  { id: 'moderator', label: '版主' },
];

function getForumVestsKey(userId) {
  return `forumVests_${userId || 'guest'}`;
}

function getForumProfileKey(userId) {
  return `forumProfile_${userId || 'guest'}`;
}

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
}

export function normalizeForumProfile(raw = {}, user = null) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    displayName: clip(source.displayName, 40) || resolveSelfDisplayName(user),
    signature: clip(source.signature, 120),
    avatar: String(source.avatar || '').trim(),
  };
}

export async function loadForumProfile(userId, user = null) {
  const row = await db.get('settings', getForumProfileKey(userId));
  return normalizeForumProfile(row?.value, user);
}

export async function saveForumProfile(userId, profile, user = null) {
  const next = normalizeForumProfile(profile, user);
  await db.put('settings', { key: getForumProfileKey(userId), value: next });
  return next;
}

function normalizeVest(v) {
  if (!v || !v.id) return null;
  return {
    id: String(v.id),
    displayId: String(v.displayId || '').trim() || '未命名马甲',
    badge: String(v.badge || '').trim(),
    createdAt: Number(v.createdAt) || Date.now(),
    updatedAt: Number(v.updatedAt) || Number(v.createdAt) || Date.now(),
  };
}

/** 用户的全部马甲（不含"本人"这个隐式选项）。 */
export async function listForumVests(userId) {
  const row = await db.get('settings', getForumVestsKey(userId));
  const list = Array.isArray(row?.value) ? row.value : [];
  return list.map(normalizeVest).filter(Boolean);
}

async function saveForumVests(userId, vests) {
  await db.put('settings', { key: getForumVestsKey(userId), value: vests });
}

export async function createForumVest(userId, { displayId, badge } = {}) {
  const vests = await listForumVests(userId);
  const now = Date.now();
  const vest = {
    id: `vest_${now}_${Math.random().toString(36).slice(2, 7)}`,
    displayId: String(displayId || '').trim() || '未命名马甲',
    badge: String(badge || '').trim(),
    createdAt: now,
    updatedAt: now,
  };
  vests.push(vest);
  await saveForumVests(userId, vests);
  return vest;
}

export async function updateForumVest(userId, vestId, patch = {}) {
  const vests = await listForumVests(userId);
  const idx = vests.findIndex((v) => v.id === vestId);
  if (idx === -1) return null;
  vests[idx] = {
    ...vests[idx],
    ...(patch.displayId != null ? { displayId: String(patch.displayId).trim() || vests[idx].displayId } : {}),
    ...(patch.badge != null ? { badge: String(patch.badge).trim() } : {}),
    updatedAt: Date.now(),
  };
  await saveForumVests(userId, vests);
  return vests[idx];
}

export async function deleteForumVest(userId, vestId) {
  const vests = await listForumVests(userId);
  const next = vests.filter((v) => v.id !== vestId);
  await saveForumVests(userId, next);
}

export async function getForumVestById(userId, vestId) {
  if (!vestId) return null;
  const vests = await listForumVests(userId);
  return vests.find((v) => v.id === vestId) || null;
}

/** "本人"这个隐式第 0 个身份的展示名，取用户档案 nickname||name。 */
export function resolveSelfDisplayName(user) {
  return String(user?.nickname || user?.name || '旅行者').trim() || '旅行者';
}

/** 发帖/回帖时把选中身份解析成落库需要的三个字段。vestId 为空即"本人"。 */
export function resolveVestIdentity(vest, user) {
  if (!vest || !vest.id) {
    return { authorName: resolveSelfDisplayName(user), authorVestId: '', authorVestBadge: '', authorSource: 'user' };
  }
  return {
    authorName: vest.displayId,
    authorVestId: vest.id,
    authorVestBadge: vest.badge,
    authorSource: 'user',
  };
}

/** 发帖弹窗/回复框共用的"发帖身份"下拉 options 生成（value=vestId，空值=本人）。 */
export function buildVestSelectOptionsHtml(vests = [], user, selectedVestId = '') {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const selfLabel = resolveSelfDisplayName(user);
  const opts = [`<option value="" ${selectedVestId ? '' : 'selected'}>本人（${esc(selfLabel)}）</option>`];
  for (const v of vests) {
    const sel = v.id === selectedVestId ? 'selected' : '';
    const badgeText = v.badge ? `· ${v.badge}` : '';
    opts.push(`<option value="${esc(v.id)}" ${sel}>${esc(v.displayId)} ${esc(badgeText)}</option>`);
  }
  return opts.join('');
}
