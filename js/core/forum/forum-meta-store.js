import * as db from '../db.js';

const LEGACY_KEY = 'forumMeta';
const LEGACY_OWNER_KEY = 'forumMetaLegacyOwnerId';

function clean(value = '') {
  return String(value || '').trim();
}

export function forumMetaKey(userId = '') {
  return `forumMeta_${clean(userId) || 'guest'}`;
}

/**
 * 旧版只有一份全局 forumMeta。多面具升级后只能由首个访问它的面具认领；
 * 否则每个面具都会继承同一份自动更新配置，并各自生成一遍内容。
 */
export async function loadForumMetaCompat(userId = '') {
  const uid = clean(userId) || 'guest';
  const scopedKey = forumMetaKey(uid);
  const scoped = await db.get('settings', scopedKey).catch(() => null);
  if (scoped) return scoped.value || {};

  const legacy = await db.get('settings', LEGACY_KEY).catch(() => null);
  if (!legacy) return {};
  const ownerRow = await db.get('settings', LEGACY_OWNER_KEY).catch(() => null);
  let ownerId = clean(ownerRow?.value);
  if (!ownerId) {
    // 部分中间版本已经为当前面具写过 forumMeta_xxx，却还留着旧 forumMeta。
    // 此时旧数据显然已经被迁移，不能再由另一个面具二次认领。
    const settings = await db.getAllRecords('settings').catch(() => []);
    const existingScoped = (Array.isArray(settings) ? settings : []).find((row) => (
      /^forumMeta_.+/.test(clean(row?.key))
      && clean(row?.key) !== LEGACY_OWNER_KEY
    ));
    if (existingScoped) {
      ownerId = clean(existingScoped.key).slice('forumMeta_'.length);
      if (ownerId) await db.put('settings', { key: LEGACY_OWNER_KEY, value: ownerId });
    }
  }
  if (ownerId && ownerId !== uid) return {};

  // 后台按“当前面具优先”串行处理，同一 JS 运行时只会有一个首位认领者。
  if (!ownerId) {
    await db.put('settings', { key: LEGACY_OWNER_KEY, value: uid });
  }
  const value = legacy.value && typeof legacy.value === 'object' ? legacy.value : {};
  await db.put('settings', { key: scopedKey, value });
  return value;
}

export async function saveForumMetaCompat(userId = '', value = {}) {
  await db.put('settings', { key: forumMetaKey(userId), value });
  return value;
}
