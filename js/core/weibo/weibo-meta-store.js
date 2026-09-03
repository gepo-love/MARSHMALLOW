import * as db from '../db.js';

const LEGACY_KEY = 'weiboMeta';
const LEGACY_OWNER_KEY = 'weiboMetaLegacyOwnerId';
let legacyClaimQueue = Promise.resolve();

function clean(value = '') {
  return String(value || '').trim();
}

export function weiboMetaKey(userId = '') {
  return `weiboMeta_${clean(userId) || 'guest'}`;
}

/** 旧版全局微博数据只能由一个档位认领，禁止被多个档位重复继承。 */
export async function loadWeiboMetaCompat(userId = '') {
  const uid = clean(userId) || 'guest';
  const scopedKey = weiboMetaKey(uid);
  const scoped = await db.get('settings', scopedKey).catch(() => null);
  if (scoped) return scoped.value || {};

  const claim = async () => {
    // 排队期间可能已由同档位的另一个读取入口完成迁移，先重新核验。
    const freshScoped = await db.get('settings', scopedKey).catch(() => null);
    if (freshScoped) return freshScoped.value || {};
    const legacy = await db.get('settings', LEGACY_KEY).catch(() => null);
    if (!legacy) return {};
    const ownerRow = await db.get('settings', LEGACY_OWNER_KEY).catch(() => null);
    let ownerId = clean(ownerRow?.value);
    if (!ownerId) {
      const settings = await db.getAllRecords('settings').catch(() => []);
      const existingScoped = (Array.isArray(settings) ? settings : []).find((row) => {
        const key = clean(row?.key);
        return key.startsWith('weiboMeta_') && key !== LEGACY_OWNER_KEY;
      });
      if (existingScoped) {
        ownerId = clean(existingScoped.key).slice('weiboMeta_'.length);
        if (ownerId) await db.put('settings', { key: LEGACY_OWNER_KEY, value: ownerId });
      }
    }
    if (ownerId && ownerId !== uid) return {};
    if (!ownerId) await db.put('settings', { key: LEGACY_OWNER_KEY, value: uid });

    const value = legacy.value && typeof legacy.value === 'object' ? legacy.value : {};
    await db.put('settings', { key: scopedKey, value });
    return value;
  };
  const task = legacyClaimQueue.then(claim, claim);
  legacyClaimQueue = task.then(() => undefined, () => undefined);
  return task;
}

export async function saveWeiboMeta(userId = '', value = {}) {
  await db.put('settings', { key: weiboMetaKey(userId), value });
  return value;
}
