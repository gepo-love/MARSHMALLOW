import * as db from './db.js';

function cleanId(value) {
  return String(value || '').trim();
}

function encodedId(value) {
  return encodeURIComponent(cleanId(value));
}

export function characterProgressResetStateKey(userId, characterId) {
  const uid = encodedId(userId);
  const cid = encodedId(characterId);
  return uid && cid ? `characterProgressReset:${uid}:${cid}` : '';
}

export async function loadCharacterProgressResetState(userId, characterId) {
  const key = characterProgressResetStateKey(userId, characterId);
  if (!key) return { resetAt: 0, token: '' };
  const row = await db.get('settings', key).catch(() => null);
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    ...value,
    resetAt: Math.max(0, Number(value.resetAt || 0) || 0),
    token: cleanId(value.token),
  };
}

export async function loadCharacterProgressResetAt(userId, characterId) {
  const state = await loadCharacterProgressResetState(userId, characterId);
  return state.resetAt;
}

export async function markCharacterProgressReset(userId, characterId, chatId = '', options = {}) {
  const key = characterProgressResetStateKey(userId, characterId);
  if (!key) throw new Error('缺少角色重置范围');
  const recordedAt = Date.now();
  const resetAt = Math.max(0, Number(options?.resetAt || 0) || recordedAt);
  const token = `${recordedAt}_${Math.random().toString(36).slice(2, 10)}`;
  const value = {
    version: 1,
    userId: cleanId(userId),
    characterId: cleanId(characterId),
    chatId: cleanId(chatId),
    resetAt,
    recordedAt,
    token,
  };
  await db.put('settings', { key, value });
  return value;
}

export function filterRowsAfterCharacterReset(rows = [], resetAt = 0) {
  const cutoff = Math.max(0, Number(resetAt || 0) || 0);
  const list = Array.isArray(rows) ? rows : [];
  if (!cutoff) return list;
  return list.filter((row) => Number(
    row?.timestamp
    || row?.createdAt
    || row?.updatedAt
    || 0,
  ) > cutoff);
}
