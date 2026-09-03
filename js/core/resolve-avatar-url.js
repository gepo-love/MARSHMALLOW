import { get, getRecord, getAllRecords } from './db.js';
import { resolveDefaultAvatar } from './default-avatar.js';
import { getCharacter, listCharacters } from './character-store.js';

const avatarObjectUrlCache = new Map();

function isUsableAvatar(value = '') {
  const s = String(value || '');
  return (
    s.startsWith('data:')
    || /^https?:/i.test(s)
    || /^blob:/i.test(s)
    || /^assets\//i.test(s)
  );
}

export function resolveWeiboUserAvatar(user = {}) {
  const dedicated = String(user?.weiboAvatar || '').trim();
  if (user?.weiboAvatarConfigured === true) return isUsableAvatar(dedicated) ? dedicated : '';
  if (isUsableAvatar(dedicated)) return dedicated;
  const shared = String(user?.avatar || '').trim();
  return isUsableAvatar(shared) ? shared : '';
}

export async function normalizeAvatarImageSrc(rawUrl = '') {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  if (!/^data:image\//i.test(raw)) return raw;
  if (raw.length < 12000) return raw;
  const hit = avatarObjectUrlCache.get(raw);
  if (hit) return hit;
  try {
    const blob = await fetch(raw).then((res) => res.blob());
    const objectUrl = URL.createObjectURL(blob);
    avatarObjectUrlCache.set(raw, objectUrl);
    return objectUrl;
  } catch (_) {
    return raw;
  }
}

export async function resolveAvatarUrl(authorId, authorName, explicitAvatar, fallbackScope = '') {
  const id = authorId ? String(authorId).trim() : '';
  const scopedUserId = fallbackScope === 'weibo'
    ? String((await get('currentUserId').catch(() => null))?.value || '').trim()
    : '';
  let userRow = null;
  if (id && fallbackScope === 'weibo') {
    userRow = await getRecord('users', id);
    if (userRow) {
      const weiboAvatar = resolveWeiboUserAvatar(userRow);
      if (weiboAvatar) return weiboAvatar;
      if (userRow.weiboAvatarConfigured === true) return resolveDefaultAvatar('weibo');
    }
  }
  if (explicitAvatar && isUsableAvatar(explicitAvatar)) return String(explicitAvatar).trim();

  if (id) {
    userRow ||= await getRecord('users', id);
    if (userRow?.avatar && isUsableAvatar(userRow.avatar)) return userRow.avatar;
    const charRow = scopedUserId
      ? await getCharacter(id, { userId: scopedUserId }).catch(() => null)
      : await getRecord('characters', id);
    if (charRow?.avatar && isUsableAvatar(charRow.avatar)) return charRow.avatar;
  }

  const name = authorName ? String(authorName).trim() : '';
  if (name) {
    const allChars = scopedUserId
      ? await listCharacters({ includeInternal: true, userId: scopedUserId }).catch(() => [])
      : await getAllRecords('characters');
    const found = allChars.find((c) => (
      c.id === name
      || c.name === name
      || c.customNickname === name
      || c.realName === name
      || c.weiboName === name
      || c.weiboNickname === name
    ));
    if (found?.avatar && isUsableAvatar(found.avatar)) return found.avatar;
  }

  return fallbackScope ? resolveDefaultAvatar(fallbackScope) : '';
}

export async function resolveDefaultEmoji(authorId, authorName) {
  const id = authorId ? String(authorId).trim() : '';
  if (id) {
    const charRow = await getRecord('characters', id);
    if (charRow?.defaultEmoji) return charRow.defaultEmoji;
  }
  const name = authorName ? String(authorName).trim() : '';
  if (name) {
    const allChars = await getAllRecords('characters');
    const found = allChars.find((c) => c.id === name || c.name === name || c.customNickname === name);
    if (found?.defaultEmoji) return found.defaultEmoji;
  }
  return '';
}
