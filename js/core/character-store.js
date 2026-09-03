import * as db from './db.js';
import {
  createCharacterProfile,
  isPublicContactCharacter,
  isSelectableContactCharacter,
  isEncounterPendingCharacter,
} from '../models/character.js';
import {
  hasActiveIdentityBinding,
  identityBindingSelectsCharacter,
  normalizeIdentityBinding,
  normalizeUserRecord,
} from '../models/user.js';
import { importContactGroupsFromPayload } from './contact-groups.js';

const STORE = 'characters';

/**
 * 角色表内存缓存：几乎每个页面首帧前都要 listCharacters/getCharacter，
 * 每次都全量读 IndexedDB 是切页「加载中」的主要固定开销之一。
 * db.js 的写入通知覆盖所有写路径（含备份恢复、绕过本模块的 putRecord），写后自动失效。
 */
let _rowsPromise = null;

db.onStoreWrite(STORE, () => {
  _rowsPromise = null;
});

function cloneRow(row) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(row); } catch (_) {}
  }
  return row;
}

function bindingGroupIds(binding = {}) {
  return normalizeIdentityBinding(binding).groupIds;
}

function characterBelongsToIdentity(character = {}, binding = {}) {
  return hasActiveIdentityBinding(binding)
    && identityBindingSelectsCharacter(binding, character);
}

function applyCharacterOverride(character = null, patch = null) {
  if (!character || !patch || typeof patch !== 'object') return character;
  return createCharacterProfile({
    ...character,
    ...cloneRow(patch),
    id: character.id,
    createdAt: character.createdAt,
  });
}

function valuesEqual(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch (_) {
    return false;
  }
}

function buildCharacterOverridePatch(base = {}, edited = {}) {
  const patch = {};
  const ignored = new Set(['id', 'createdAt', 'updatedAt']);
  for (const key of Object.keys(edited || {})) {
    if (ignored.has(key)) continue;
    if (!valuesEqual(base?.[key], edited?.[key])) patch[key] = cloneRow(edited[key]);
  }
  return patch;
}

async function loadCharacterOverrideUser(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return null;
  const row = await db.getRecord('users', id).catch(() => null);
  return row ? normalizeUserRecord(row) : null;
}

function getAllRowsCached() {
  if (!_rowsPromise) {
    _rowsPromise = db.getAllRecords(STORE)
      .then((rows) => (Array.isArray(rows) ? rows : []))
      .catch((err) => {
        _rowsPromise = null;
        throw err;
      });
  }
  return _rowsPromise;
}

async function syncCharacterDisplayNameReferences(characterId, previous = {}, next = {}) {
  const id = String(characterId || '').trim();
  const nextName = String(next.name || '').trim();
  if (!id || !nextName) return;
  const oldLabels = new Set([
    previous.name,
    previous.customNickname,
    previous.remarkName,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  if (!oldLabels.size || (oldLabels.size === 1 && oldLabels.has(nextName))) return;

  const chats = await db.getAllRecords('chats').catch(() => []);
  for (const chat of (Array.isArray(chats) ? chats : [])) {
    if (!Array.isArray(chat?.participants) || !chat.participants.includes(id)) continue;
    const isNormalPrivate = chat.type === 'private'
      && chat.participants.includes('user')
      && chat.metadata?.channelKind !== 'stranger_intercept';
    if (!isNormalPrivate) continue;
    let changed = false;
    const patched = { ...chat };
    if (oldLabels.has(String(chat.name || '').trim())) {
      patched.name = nextName;
      changed = true;
    }
    if (oldLabels.has(String(chat.partnerName || '').trim())) {
      patched.partnerName = nextName;
      changed = true;
    }
    if (oldLabels.has(String(chat.metadata?.partnerName || '').trim())) {
      patched.metadata = { ...(chat.metadata || {}), partnerName: nextName };
      changed = true;
    }
    if (changed) await db.putRecord('chats', patched);

    const prefsKey = `chatPrefs_${chat.id}`;
    const prefsRow = await db.getRecord('settings', prefsKey).catch(() => null);
    if (oldLabels.has(String(prefsRow?.value?.remarkName || '').trim())) {
      await db.putRecord('settings', {
        ...prefsRow,
        key: prefsKey,
        value: { ...(prefsRow?.value || {}), remarkName: nextName },
        updatedAt: Date.now(),
      });
    }
  }

  const facts = await db.getAllRecords('memoryFacts').catch(() => []);
  for (const fact of (Array.isArray(facts) ? facts : [])) {
    let changed = false;
    const patched = { ...fact };
    if (String(fact.subjectId || '').trim() === id
      && oldLabels.has(String(fact.subjectName || '').trim())) {
      patched.subjectName = nextName;
      changed = true;
    }
    if (String(fact.objectId || '').trim() === id
      && oldLabels.has(String(fact.objectName || '').trim())) {
      patched.objectName = nextName;
      changed = true;
    }
    if (changed) {
      patched.updatedAt = Date.now();
      await db.putRecord('memoryFacts', patched);
    }
  }
}

export async function listCharacters(options = {}) {
  const includeInternal = options.includeInternal === true;
  const excludeAnonNpc = options.excludeAnonNpc === true;
  const [user, rows] = await Promise.all([
    options.userId ? loadCharacterOverrideUser(options.userId) : null,
    getAllRowsCached(),
  ]);
  const overrides = user?.characterOverrides || {};
  // userId 原本只用于套用当前身份的角色覆写，不代表筛选面具可见范围。
  // 论坛等生成链路需要显式开启 identityScoped，避免同档位其它 user 的角色卡进入本轮上下文。
  const identityScoped = options.identityScoped === true
    && hasActiveIdentityBinding(user?.identityBinding);
  return rows
    .filter((row) => {
      if (includeInternal) return true;
      if (excludeAnonNpc) return isSelectableContactCharacter(row);
      // 初遇草稿在正式收纳前不进通讯录等公开列表
      return isPublicContactCharacter(row) && !isEncounterPendingCharacter(row);
    })
    .map((row) => {
      const base = createCharacterProfile(cloneRow(row));
      return applyCharacterOverride(base, overrides[base.id]);
    })
    .filter((row) => !identityScoped || characterBelongsToIdentity(row, user.identityBinding))
    .sort((a, b) => {
      const ta = String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
      if (ta !== 0) return ta;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}

/** 初遇草稿列表：等待第一场线下相遇的角色。 */
export async function listEncounterPendingCharacters() {
  const rows = await getAllRowsCached();
  return rows
    .filter(isEncounterPendingCharacter)
    .map((row) => createCharacterProfile(cloneRow(row)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getCharacter(id, options = {}) {
  if (!id) return null;
  const rows = await getAllRowsCached();
  const row = rows.find((r) => r && r.id === id);
  if (!row) return null;
  const base = createCharacterProfile(cloneRow(row));
  if (!options?.userId) return base;
  const user = await loadCharacterOverrideUser(options.userId);
  return applyCharacterOverride(base, user?.characterOverrides?.[base.id]);
}

export async function getCharactersByIds(ids = [], options = {}) {
  const requested = [...new Set((Array.isArray(ids) ? ids : [ids])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (!requested.length) return [];
  // 会话页通常只需要 1～3 张角色卡。首次进页时若为了这几个 id
  // getAll 整张 characters 表，多档位/大角色库会把几毫秒的点查放大到数百毫秒。
  // 列表缓存已经热起来时继续复用；冷启动则在同一个事务中按主键精确读取。
  const rowsPromise = _rowsPromise
    ? getAllRowsCached()
    : db.getMany(STORE, requested);
  const [rows, user] = await Promise.all([
    rowsPromise,
    options?.user && typeof options.user === 'object'
      ? Promise.resolve(normalizeUserRecord(options.user))
      : (options?.userId ? loadCharacterOverrideUser(options.userId) : Promise.resolve(null)),
  ]);
  const requestedSet = new Set(requested);
  const byId = new Map(rows.filter((row) => row?.id && requestedSet.has(row.id)).map((row) => [row.id, row]));
  return requested.map((id) => {
    const row = byId.get(id);
    if (!row) return null;
    const base = createCharacterProfile(cloneRow(row));
    return applyCharacterOverride(base, user?.characterOverrides?.[base.id]);
  });
}

export async function saveCharacter(profile) {
  if (!isPublicContactCharacter(profile)) {
    throw new Error('匿名聊天室内置角色不能保存到通讯录');
  }
  const previous = await db.getRecord(STORE, profile?.id).catch(() => null);
  const next = createCharacterProfile({
    ...profile,
    updatedAt: Date.now(),
  });
  if (!next.name) throw new Error('请填写备注名');
  await db.putRecord(STORE, next);
  await syncCharacterDisplayNameReferences(next.id, previous || {}, next);
  return next;
}

async function syncCharacterPhoneAvatarForUser(userId = '', previous = {}, next = {}) {
  const uid = String(userId || '').trim();
  const characterId = String(next?.id || previous?.id || '').trim();
  const previousAvatar = String(previous?.avatar || previous?.avatarUrl || '').trim();
  const nextAvatar = String(next?.avatar || next?.avatarUrl || '').trim();
  if (!uid || !characterId || previousAvatar === nextAvatar) return;
  // 角色卡编辑与角色手机编辑是两条入口；在角色存储层统一补同步，避免前者
  // 漏掉手机通讯录 / 会话头像快照。延迟导入避免 character-store 与联系人模块互相初始化。
  const { syncPhoneContactAvatarsAcrossOwners } = await import('./character-phone-contacts.js');
  await syncPhoneContactAvatarsAcrossOwners(uid, characterId, nextAvatar).catch(() => 0);
}

export async function saveCharacterForUser(userId, profile, options = {}) {
  const uid = String(userId || '').trim();
  const base = await getCharacter(profile?.id);
  const forceOverride = options.forceOverride === true;
  if (!uid) return saveCharacter(profile);
  if (!base) {
    if (forceOverride) throw new Error('档位角色不存在，已阻止写入通用通讯录');
    return saveCharacter(profile);
  }
  const user = await loadCharacterOverrideUser(uid);
  // 明确从“档位通讯录”发起的保存必须失败关闭。目标档位若在切页、恢复缓存或
  // 数据读取异常时已经取不到，绝不能静默降级成 saveCharacter 写穿通用角色卡。
  if (!user && forceOverride) {
    throw new Error('找不到目标档位，已阻止写入通用通讯录');
  }
  if (!user || (!forceOverride && !characterBelongsToIdentity(base, user.identityBinding))) {
    const saved = await saveCharacter(profile);
    await syncCharacterPhoneAvatarForUser(uid, base, saved);
    return saved;
  }

  const previousEffective = applyCharacterOverride(base, user.characterOverrides?.[base.id]);

  const edited = createCharacterProfile({
    ...base,
    ...profile,
    id: base.id,
    createdAt: base.createdAt,
    updatedAt: Date.now(),
  });
  if (!edited.name) throw new Error('请填写备注名');
  const patch = buildCharacterOverridePatch(base, edited);
  const overrides = { ...(user.characterOverrides || {}) };
  if (Object.keys(patch).length) overrides[base.id] = patch;
  else delete overrides[base.id];
  const nextUser = normalizeUserRecord({
    ...user,
    characterOverrides: overrides,
    updatedAt: Date.now(),
  });
  await db.putRecord('users', nextUser);
  const saved = applyCharacterOverride(base, patch);
  await syncCharacterPhoneAvatarForUser(uid, previousEffective, saved);
  return saved;
}

export async function clearCharacterOverride(userId = '', characterId = '') {
  const user = await loadCharacterOverrideUser(userId);
  const id = String(characterId || '').trim();
  if (!user || !id || !user.characterOverrides?.[id]) return false;
  const overrides = { ...(user.characterOverrides || {}) };
  delete overrides[id];
  await db.putRecord('users', normalizeUserRecord({
    ...user,
    characterOverrides: overrides,
    updatedAt: Date.now(),
  }));
  return true;
}

export async function deleteCharacter(id) {
  if (!id) return;
  await db.deleteRecord(STORE, id);
}

export async function countCharacters() {
  const rows = await getAllRowsCached();
  return rows.filter(isPublicContactCharacter).length;
}

export async function exportCharactersJson(options = {}) {
  const rows = options.characters || await listCharacters({ excludeAnonNpc: true });
  return {
    format: 'marshmallow-characters',
    version: 2,
    exportedAt: Date.now(),
    characters: rows,
  };
}

export async function importCharactersFromMarshmallow(payload, options = {}) {
  if (payload?.groups) {
    await importContactGroupsFromPayload(payload.groups);
  }
  const merge = options.merge !== false;
  const list = Array.isArray(payload?.characters) ? payload.characters : [];
  let imported = 0;
  let skipped = 0;
  for (const raw of list) {
    if (!raw || !raw.id) {
      skipped += 1;
      continue;
    }
    if (!isPublicContactCharacter(raw)) {
      skipped += 1;
      continue;
    }
    const next = createCharacterProfile(raw);
    if (!merge) {
      await db.putRecord(STORE, next);
      imported += 1;
      continue;
    }
    const existing = await db.getRecord(STORE, next.id);
    const merged = createCharacterProfile({
      ...(existing || {}),
      ...next,
      relationships: {
        ...(existing?.relationships || {}),
        ...(next.relationships || {}),
      },
      lifeProfile: {
        ...(existing?.lifeProfile || {}),
        ...(next.lifeProfile || {}),
      },
      residenceAnchor: {
        ...(existing?.residenceAnchor || {}),
        ...(next.residenceAnchor || {}),
      },
      createdAt: existing?.createdAt || next.createdAt,
    });
    await db.putRecord(STORE, merged);
    imported += 1;
  }
  return { imported, skipped, total: list.length };
}
