import * as db from './db.js';
import { createUser, normalizeUserRecord } from '../models/user.js';
import { ensureTimeSchedule } from './time-mode.js';
import { setState } from './state.js';
import {
  loadRelationshipNetwork,
  saveRelationshipNetwork,
} from './relationship-network.js';
import {
  loadAcquaintanceLedger,
  saveAcquaintanceLedger,
} from './acquaintance-ledger.js';
import { duplicateCharacterPhoneContactBooks } from './character-phone-contacts.js';
import {
  loadAuConfigForUser,
  saveAuConfigForUser,
  serializeAuConfigForUser,
} from './au-config.js';

const CURRENT_USER_KEY = 'currentUserId';
const KNOWN_DATABASE_MARKER_KEY = '__mm_known_nonempty_database__';
const HYDRATED_AU_CONFIG = Symbol('hydratedAuConfig');
const EMPTY_USER_TABLE_RECOVERY_KEY = '__mm_empty_user_table_recovery__';
const ORPHAN_USER_RECOVERY_RESULT_KEY = '__mm_orphan_user_recovery_result__';
const ORPHAN_USER_ID_STORES = [
  'chats',
  'memories',
  'memoryFacts',
  'eventMemories',
  'sharedEventKnowledge',
  'momentsPosts',
  'forumThreads',
  'aliasAccounts',
  'collectibles',
  'auStories',
  'streamerChannels',
];

export function getCurrentStorageScopeLabel() {
  try {
    if (
      typeof globalThis.Capacitor?.isNativePlatform === 'function'
      && globalThis.Capacitor.isNativePlatform()
    ) {
      return '当前 APK';
    }
  } catch (_) {}
  try {
    if (
      globalThis.navigator?.standalone === true
      || globalThis.matchMedia?.('(display-mode: standalone)')?.matches
      || globalThis.matchMedia?.('(display-mode: fullscreen)')?.matches
      || globalThis.matchMedia?.('(display-mode: minimal-ui)')?.matches
    ) {
      return '当前主屏 App / PWA';
    }
  } catch (_) {}
  return typeof globalThis.location !== 'undefined' ? '当前浏览器' : '当前打开位置';
}

export function buildUnexpectedEmptyDatabaseMessage(storageScope = getCurrentStorageScopeLabel()) {
  return (
    `检测到${storageScope}以前保存过本地数据，但现在读取到的是空数据库。`
    + '为避免创建空档掩盖故障现场，应用已停止启动。请勿卸载或清除应用/网站数据；'
    + '请先打开急救诊断。若诊断确认本地库为 0，可选择“确认空库并继续”，再从备份恢复。'
  );
}

function readKnownDatabaseMarker() {
  try {
    const raw = globalThis.localStorage?.getItem(KNOWN_DATABASE_MARKER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function markKnownDatabase(userId = '') {
  try {
    globalThis.localStorage?.setItem(KNOWN_DATABASE_MARKER_KEY, JSON.stringify({
      userId: String(userId || ''),
      build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
      checkedAt: Date.now(),
    }));
  } catch (_) {}
}

export function shouldRecoverUnexpectedEmptyDatabase(existingUsers = [], marker = null) {
  return Array.isArray(existingUsers) && existingUsers.length === 0 && !!marker;
}

function recoveryUserId(currentId = '', marker = null) {
  const candidates = [currentId, marker?.userId, 'user_default'];
  for (const candidate of candidates) {
    const id = String(candidate || '').trim();
    if (id) return id.slice(0, 240);
  }
  return 'user_default';
}

function rememberEmptyUserTableRecovery({ userId = '', marker = null } = {}) {
  try {
    globalThis.localStorage?.setItem(EMPTY_USER_TABLE_RECOVERY_KEY, JSON.stringify({
      recoveredAt: Date.now(),
      build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
      userId: String(userId || ''),
      knownDatabase: marker || null,
    }));
  } catch (_) {}
}

function readEmptyUserTableRecovery() {
  try {
    const raw = globalThis.localStorage?.getItem(EMPTY_USER_TABLE_RECOVERY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function finishOrphanUserRecovery(result = {}) {
  try {
    globalThis.localStorage?.setItem(ORPHAN_USER_RECOVERY_RESULT_KEY, JSON.stringify({
      completedAt: Date.now(),
      build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
      ...result,
    }));
    globalThis.localStorage?.removeItem(EMPTY_USER_TABLE_RECOVERY_KEY);
  } catch (_) {}
}

function validRecoveredUserId(value = '') {
  const id = String(value || '').trim();
  if (!id || id === 'undefined' || id === 'null') return '';
  return id.slice(0, 240);
}

async function recoverOrphanedUserSlots(existingUsers = [], currentId = '') {
  const pending = readEmptyUserTableRecovery();
  if (!pending) return null;

  const linkedIds = new Set();
  const scannedStores = [];
  const failedStores = [];
  for (const storeName of ORPHAN_USER_ID_STORES) {
    try {
      const ids = await db.getDistinctIndexKeys(storeName, 'userId', { limit: 100 });
      scannedStores.push(storeName);
      for (const value of ids) {
        const id = validRecoveredUserId(value);
        if (id) linkedIds.add(id);
      }
    } catch (error) {
      failedStores.push({
        store: storeName,
        error: String(error?.message || error || 'read failed').slice(0, 240),
      });
    }
  }
  // 所有索引都读取失败时保留待恢复标记，下次启动继续尝试，不能把“扫描失败”记成“没有数据”。
  if (!scannedStores.length) return null;

  const knownIds = new Set((Array.isArray(existingUsers) ? existingUsers : [])
    .map((user) => validRecoveredUserId(user?.id))
    .filter(Boolean));
  const createdIds = [];
  for (const id of linkedIds) {
    if (knownIds.has(id)) continue;
    const existing = await db.getRecord('users', id);
    if (existing) {
      knownIds.add(id);
      continue;
    }
    const recovered = createUser({
      id,
      slotName: createdIds.length ? `恢复档 ${createdIds.length + 1}` : '恢复档',
    });
    await db.putRecord('users', recovered);
    knownIds.add(id);
    createdIds.push(id);
  }

  let activeUserId = validRecoveredUserId(currentId);
  if (!linkedIds.has(activeUserId) && linkedIds.size) {
    const markerId = validRecoveredUserId(pending?.knownDatabase?.userId);
    activeUserId = markerId && linkedIds.has(markerId) ? markerId : [...linkedIds][0];
    await db.put({ key: CURRENT_USER_KEY, value: activeUserId });
  }
  finishOrphanUserRecovery({
    linkedUserIds: [...linkedIds],
    createdUserIds: createdIds,
    activeUserId,
    scannedStores,
    failedStores,
  });
  if (linkedIds.size) {
    try {
      console.warn('[user-slot] 已从业务表恢复孤立档位', {
        linkedUserIds: [...linkedIds],
        createdUserIds: createdIds,
        activeUserId,
      });
    } catch (_) {}
  }
  return { activeUserId, linkedUserIds: [...linkedIds], createdUserIds: createdIds };
}

/**
 * 当前档位内存缓存：ensureDefaultUser 是所有页面首帧前的第一个 await，
 * 原来每次切页都要 3~4 次串行 IndexedDB 往返。缓存后同一会话内直接命中，
 * 任何 users 表写入或 currentUserId 切换（含备份恢复）都会经 db.js 写入通知自动失效。
 */
let _currentIdCache = '';
let _currentUserRowCache = null;

function invalidateUserCache() {
  _currentIdCache = '';
  _currentUserRowCache = null;
}

db.onStoreWrite('users', invalidateUserCache);
db.onStoreWrite('settings', (key) => {
  if (key === undefined || key === CURRENT_USER_KEY) invalidateUserCache();
});

async function hydrateReusableUserResources(row = null) {
  if (!row) return null;
  const user = normalizeUserRecord(row);
  const auConfig = await loadAuConfigForUser(user).catch(() => null);
  const hydrated = auConfig
    ? normalizeUserRecord({ ...user, auConfig: serializeAuConfigForUser(auConfig) })
    : user;
  if (auConfig) Object.defineProperty(hydrated, HYDRATED_AU_CONFIG, { value: true });
  return hydrated;
}

function userRecordForPersistence(user = {}) {
  const record = { ...user };
  if (user?.[HYDRATED_AU_CONFIG] === true) delete record.auConfig;
  return record;
}

export async function getCurrentUserId() {
  if (_currentIdCache) {
    setState('currentUserId', _currentIdCache);
    return _currentIdCache;
  }
  const row = await db.get(CURRENT_USER_KEY);
  const id = String(row?.value || '').trim();
  if (id) {
    _currentIdCache = id;
    setState('currentUserId', id);
    return id;
  }
  return '';
}

export async function getCurrentUser() {
  const id = await getCurrentUserId();
  if (!id) return null;
  if (_currentUserRowCache && _currentUserRowCache.id === id) {
    return hydrateReusableUserResources(_currentUserRowCache);
  }
  const row = await db.getRecord('users', id);
  if (row) _currentUserRowCache = row;
  return hydrateReusableUserResources(row);
}

export async function getUserById(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return null;
  if (_currentUserRowCache && _currentUserRowCache.id === id) {
    return hydrateReusableUserResources(_currentUserRowCache);
  }
  const row = await db.getRecord('users', id).catch(() => null);
  return hydrateReusableUserResources(row);
}

export async function listUsers() {
  const rows = await db.getAllRecords('users');
  const users = await Promise.all((Array.isArray(rows) ? rows : [])
    .map((row) => hydrateReusableUserResources(row)));
  return users.filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function listUsersInSlot(slotGroupIdOrUserId = '') {
  const requestedId = String(slotGroupIdOrUserId || '').trim();
  if (!requestedId) return [];
  const users = await listUsers();
  const requestedUser = users.find((candidate) => candidate.id === requestedId);
  const slotGroupId = String(requestedUser?.slotGroupId || requestedUser?.worldId || requestedId).trim();
  return users.filter((candidate) => (
    String(candidate.slotGroupId || candidate.worldId || candidate.id).trim() === slotGroupId
  ));
}

export async function saveUserRecord(user) {
  const hasHydratedAuConfig = user?.[HYDRATED_AU_CONFIG] === true;
  const next = normalizeUserRecord(user);
  const now = Date.now();
  const prev = await db.getRecord('users', next.id).catch(() => null);
  if (prev) {
    const prevSig = String(prev.signature || '').trim();
    const nextSig = String(next.signature || '').trim();
    const prevStatus = String(prev.statusText || '').trim();
    const nextStatus = String(next.statusText || '').trim();
    next.signatureUpdatedAt = prevSig !== nextSig
      ? now
      : (Number(prev.signatureUpdatedAt || next.signatureUpdatedAt || 0) || 0);
    next.statusUpdatedAt = prevStatus !== nextStatus
      ? now
      : (Number(prev.statusUpdatedAt || next.statusUpdatedAt || 0) || 0);
  } else {
    if (next.signature && !next.signatureUpdatedAt) next.signatureUpdatedAt = now;
    if (next.statusText && !next.statusUpdatedAt) next.statusUpdatedAt = now;
  }
  next.updatedAt = now;
  const persistedNext = userRecordForPersistence(hasHydratedAuConfig
    ? { ...next, [HYDRATED_AU_CONFIG]: true }
    : next);
  await db.putRecord('users', persistedNext);
  const sharedSlotFieldsChanged = prev && (
    String(prev.slotName || '').trim() !== String(next.slotName || '').trim()
    || String(prev.worldBackground || '').trim() !== String(next.worldBackground || '').trim()
  );
  if (sharedSlotFieldsChanged) {
    const siblings = await listUsersInSlot(next.slotGroupId);
    await Promise.all(siblings
      .filter((sibling) => sibling.id !== next.id && (
        sibling.slotName !== next.slotName
        || sibling.worldBackground !== next.worldBackground
      ))
      .map((sibling) => db.putRecord('users', userRecordForPersistence({
        ...sibling,
        [HYDRATED_AU_CONFIG]: sibling?.[HYDRATED_AU_CONFIG] === true,
        slotName: next.slotName,
        worldBackground: next.worldBackground,
        updatedAt: now,
      }))));
  }
  if (hasHydratedAuConfig) Object.defineProperty(next, HYDRATED_AU_CONFIG, { value: true });
  return next;
}

let _worldIdMigrationPromise = null;

async function ensureUserWorldIds() {
  if (_worldIdMigrationPromise) return _worldIdMigrationPromise;
  _worldIdMigrationPromise = (async () => {
    const rows = await db.getAllRecords('users');
    const changed = (Array.isArray(rows) ? rows : [])
      .map((row) => ({ before: row, next: normalizeUserRecord(row) }))
      .filter(({ before, next }) => (
        String(before?.worldId || '').trim() !== next.worldId
        || String(before?.slotGroupId || '').trim() !== next.slotGroupId
      ))
      .map(({ next }) => next);
    if (changed.length) await db.putMany('users', changed, { batchSize: 20 });
    return changed.length;
  })().catch((error) => {
    _worldIdMigrationPromise = null;
    throw error;
  });
  return _worldIdMigrationPromise;
}

export async function ensureDefaultUser() {
  await ensureUserWorldIds();
  let id = await getCurrentUserId();
  if (id && _currentUserRowCache && _currentUserRowCache.id === id) {
    setState('currentUserId', id);
    return hydrateReusableUserResources(_currentUserRowCache);
  }
  if (id) {
    const existing = await db.getRecord('users', id);
    if (existing) {
      let user = normalizeUserRecord(existing);
      const orphanRecovery = await recoverOrphanedUserSlots([user], user.id);
      if (orphanRecovery?.activeUserId && orphanRecovery.activeUserId !== user.id) {
        const recoveredActive = await db.getRecord('users', orphanRecovery.activeUserId);
        if (recoveredActive) user = normalizeUserRecord(recoveredActive);
      }
      await ensureTimeSchedule(user.id);
      setState('currentUserId', user.id);
      _currentIdCache = user.id;
      _currentUserRowCache = user;
      markKnownDatabase(user.id);
      return hydrateReusableUserResources(user);
    }
  }
  // 指针丢失但档位还在时，切回最近使用的档，避免静默新建空档看起来像「数据被清空」。
  // 读取失败必须继续抛给 IndexedDB 的重连/急救流程，不能把异常吞成空数组。
  // 否则 WebView 存储进程短暂失联也会被误判为“数据库已空”。
  const existingUsers = await listUsers();
  if (existingUsers.length) {
    const recovered = existingUsers[0];
    await db.put({ key: CURRENT_USER_KEY, value: recovered.id });
    await ensureTimeSchedule(recovered.id);
    setState('currentUserId', recovered.id);
    _currentIdCache = recovered.id;
    _currentUserRowCache = recovered;
    markKnownDatabase(recovered.id);
    try {
      console.warn('[user-slot] currentUserId 无效，已恢复到既有档位', recovered.id);
    } catch (_) {}
    return recovered;
  }
  const knownDatabase = readKnownDatabaseMarker();
  if (shouldRecoverUnexpectedEmptyDatabase(existingUsers, knownDatabase)) {
    // users 表丢失不代表角色、聊天和消息也丢失。优先用 settings 指针，其次用
    // 上次成功档位标记重建同 ID 的最小用户行，让其它表里的 userId 关联继续有效。
    // 即使整库确实已空，也要先创建可用档进入应用，备份恢复可以在设置里完成。
    const recoveredId = recoveryUserId(id, knownDatabase);
    const recovered = createUser({ id: recoveredId, slotName: '默认档' });
    await db.putRecord('users', recovered);
    await db.put({ key: CURRENT_USER_KEY, value: recovered.id });
    await ensureTimeSchedule(recovered.id);
    setState('currentUserId', recovered.id);
    _currentIdCache = recovered.id;
    _currentUserRowCache = recovered;
    markKnownDatabase(recovered.id);
    rememberEmptyUserTableRecovery({ userId: recovered.id, marker: knownDatabase });
    const orphanRecovery = await recoverOrphanedUserSlots([recovered], recovered.id);
    if (orphanRecovery?.activeUserId && orphanRecovery.activeUserId !== recovered.id) {
      const active = await db.getRecord('users', orphanRecovery.activeUserId);
      if (active) {
        const normalized = normalizeUserRecord(active);
        await ensureTimeSchedule(normalized.id);
        setState('currentUserId', normalized.id);
        _currentIdCache = normalized.id;
        _currentUserRowCache = active;
        markKnownDatabase(normalized.id);
        return hydrateReusableUserResources(normalized);
      }
    }
    try {
      console.warn('[user-slot] users 表为空，已重建最小档位并继续启动', recovered.id);
    } catch (_) {}
    return hydrateReusableUserResources(recovered);
  }
  const user = createUser({ id: 'user_default', slotName: '默认档' });
  await db.putRecord('users', user);
  await db.put({ key: CURRENT_USER_KEY, value: user.id });
  await ensureTimeSchedule(user.id);
  setState('currentUserId', user.id);
  _currentIdCache = user.id;
  _currentUserRowCache = user;
  markKnownDatabase(user.id);
  return hydrateReusableUserResources(user);
}

export async function setCurrentUserId(userId) {
  const id = String(userId || '').trim();
  if (!id) return;
  const existing = await db.getRecord('users', id);
  if (!existing) throw new Error('档位不存在');
  const normalized = normalizeUserRecord(existing);
  // 时间表属于附属设置。旧备份中的时间字段即使需要修复，也不能让“切换档位”
  // 在 currentUserId 已经写入后才抛错，造成界面说失败、实际指针却已改变。
  let scheduleWarning = '';
  try {
    await ensureTimeSchedule(id);
  } catch (error) {
    scheduleWarning = String(error?.message || error || '时间表初始化失败');
    try { console.warn('[user-slot] 切换后时间表暂未修复', id, error); } catch (_) {}
  }
  await db.put({ key: CURRENT_USER_KEY, value: id });
  setState('currentUserId', id);
  _currentIdCache = id;
  _currentUserRowCache = normalized;
  // 通知路由丢掉所有 Keep-Alive 页面缓存、通知悬浮组件重新拉数据——
  // 否则切完档位回到聊天页/浮窗看到的还是切换前那个档位的旧 DOM/数据。
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('marshmallow-user-slot-changed', {
      detail: { userId: id, scheduleWarning },
    }));
  }
  return normalized;
}

/**
 * 完整备份替换 users/settings 后修复旧档位缺失的容器字段与失效的 currentUserId。
 * 只改用户行和当前指针，不创建新档，也不触碰角色、聊天或消息。
 */
export async function reconcileUserSlotsAfterImport() {
  invalidateUserCache();
  const rows = await db.getAllRecords('users');
  const pairs = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && String(row.id || '').trim())
    .map((row) => ({ before: row, next: normalizeUserRecord(row) }));
  const users = pairs.map((pair) => pair.next);
  if (!users.length) {
    return { ok: false, users: 0, activeUserId: '', repairedUsers: 0 };
  }
  const changed = [];
  for (const { before, next } of pairs) {
    if (
      String(before.slotGroupId || '').trim() !== next.slotGroupId
      || String(before.worldId || '').trim() !== next.worldId
      || String(before.slotName || '').trim() !== next.slotName
    ) {
      changed.push(next);
    }
  }
  if (changed.length) await db.putMany('users', changed, { batchSize: 20 });

  const current = String((await db.get(CURRENT_USER_KEY))?.value || '').trim();
  const knownIds = new Set(users.map((user) => user.id));
  const activeUserId = knownIds.has(current) ? current : users[0].id;
  if (activeUserId !== current) {
    await db.put({ key: CURRENT_USER_KEY, value: activeUserId });
  }
  invalidateUserCache();
  return {
    ok: true,
    users: users.length,
    activeUserId,
    repairedUsers: changed.length,
    repairedPointer: activeUserId !== current,
  };
}

export async function createUserSlot(name = '') {
  const label = String(name || '').trim() || `新档位 ${new Date().toLocaleDateString('zh-CN')}`;
  const id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const user = createUser({ id, worldId: id, slotGroupId: id, slotName: label });
  await saveUserRecord(user);
  return user;
}

/**
 * 从当前身份开一条新的主世界线：只复制身份资料与角色覆写，不复制聊天、记忆或番外档案。
 */
export async function createUserSlotFromIdentity(sourceId, name = '', { worldBackground = '' } = {}) {
  const source = await db.getRecord('users', String(sourceId || '').trim());
  if (!source) throw new Error('当前身份不存在');
  const now = Date.now();
  const id = `user_${now}_${Math.random().toString(36).slice(2, 7)}`;
  const slotName = String(name || '').trim() || `新世界线 ${new Date().toLocaleDateString('zh-CN')}`;
  const user = normalizeUserRecord({
    ...source,
    id,
    worldId: id,
    slotGroupId: id,
    slotName,
    worldBackground: String(worldBackground || '').trim(),
    createdAt: now,
    updatedAt: now,
  });
  await saveUserRecord(user);
  const sourceAuConfig = await loadAuConfigForUser(source).catch(() => null);
  if (sourceAuConfig) await saveAuConfigForUser(user, sourceAuConfig).catch(() => null);
  return user;
}

export async function createLinkedUser(sourceId, name = '') {
  const source = await db.getRecord('users', String(sourceId || '').trim());
  if (!source) throw new Error('当前身份不存在');
  const current = normalizeUserRecord(source);
  const now = Date.now();
  const id = `user_${now}_${Math.random().toString(36).slice(2, 7)}`;
  const user = createUser({
    id,
    worldId: current.worldId || current.slotGroupId || current.id,
    slotGroupId: current.worldId || current.slotGroupId || current.id,
    slotName: current.slotName,
    worldBackground: current.worldBackground,
    name: String(name || '').trim(),
    createdAt: now,
    updatedAt: now,
  });
  await saveUserRecord(user);
  return user;
}

export async function duplicateUserSlot(sourceId, name = '') {
  const src = await db.getRecord('users', String(sourceId || '').trim());
  if (!src) throw new Error('源档位不存在');
  const now = Date.now();
  const rootId = `user_${now}_${Math.random().toString(36).slice(2, 5)}`;
  const slotName = String(name || '').trim() || `${src.slotName || src.name || '档位'} · 副本`;
  const sourceUsers = await listUsersInSlot(src.slotGroupId || src.id);
  const orderedSources = [
    src,
    ...sourceUsers.filter((row) => row.id !== src.id),
  ];
  const copies = orderedSources.map((source, index) => normalizeUserRecord({
    ...source,
    id: index === 0
      ? rootId
      : `user_${now}_${index}_${Math.random().toString(36).slice(2, 5)}`,
    slotGroupId: rootId,
    worldId: rootId,
    slotName,
    createdAt: now + index,
    updatedAt: now + index,
  }));
  await Promise.all(copies.map((copy) => saveUserRecord(copy)));
  const sourceAuConfigs = await Promise.all(orderedSources.map((source) => (
    loadAuConfigForUser(source).catch(() => null)
  )));
  await Promise.all(copies.map((copy, index) => (
    sourceAuConfigs[index]
      ? saveAuConfigForUser(copy, sourceAuConfigs[index]).catch(() => null)
      : Promise.resolve()
  )));
  await Promise.all(copies.map(async (copy, index) => {
    const source = orderedSources[index];
    const [relationshipNetwork, acquaintanceLedger, phoneBooks] = await Promise.all([
      loadRelationshipNetwork(source.id).catch(() => null),
      loadAcquaintanceLedger(source.id).catch(() => null),
      duplicateCharacterPhoneContactBooks(source.id, copy.id),
    ]);
    const actorIdMap = phoneBooks?.actorIdMap || {};
    const remapActorId = (value = '') => actorIdMap[String(value || '').trim()] || value;
    const copiedRelationshipNetwork = relationshipNetwork ? {
      ...relationshipNetwork,
      npcs: (relationshipNetwork.npcs || []).map((npc) => ({
        ...npc,
        id: remapActorId(npc.id),
      })),
      dismissedNpcs: (relationshipNetwork.dismissedNpcs || []).map((npc) => ({
        ...npc,
        id: remapActorId(npc.id),
      })),
      circles: (relationshipNetwork.circles || []).map((circle) => ({
        ...circle,
        memberIds: (circle.memberIds || []).map(remapActorId),
        edges: (circle.edges || []).map((edge) => ({
          ...edge,
          a: remapActorId(edge.a),
          b: remapActorId(edge.b),
        })),
        groups: (circle.groups || []).map((group) => ({
          ...group,
          memberIds: (group.memberIds || []).map(remapActorId),
        })),
      })),
    } : null;
    const copiedAcquaintanceLedger = acquaintanceLedger ? {
      ...acquaintanceLedger,
      entries: (acquaintanceLedger.entries || []).map((entry) => ({
        ...entry,
        a: remapActorId(entry.a),
        b: remapActorId(entry.b),
      })),
    } : null;
    await Promise.all([
      copiedRelationshipNetwork
        ? saveRelationshipNetwork(copiedRelationshipNetwork, copy.id).catch(() => null)
        : Promise.resolve(),
      copiedAcquaintanceLedger
        ? saveAcquaintanceLedger(copiedAcquaintanceLedger, copy.id).catch(() => null)
        : Promise.resolve(),
    ]);
  }));
  return copies[0];
}

const USER_SCOPED_INDEX_STORES = [
  'aliasAccounts',
  'memories',
  'memoryFacts',
  'eventMemories',
  'memoryVectors',
  'sharedEventKnowledge',
  'momentsPosts',
  'forumThreads',
  'worldBooks',
  'collectibles',
  'auStories',
  'streamerChannels',
  'streamerFanState',
  'streamerRecordings',
];

function recordOwnedByUser(row = {}, userId = '') {
  const id = String(userId || '').trim();
  if (!id || !row || typeof row !== 'object') return false;
  if ([row.userId, row.ownerUserId, row.slotUserId].some((value) => String(value || '').trim() === id)) {
    return true;
  }
  const ownerType = String(row.ownerType || row.authorType || '').trim().toLowerCase();
  const ownerId = String(row.ownerId || row.authorId || '').trim();
  return ownerType === 'user' && ownerId === id;
}

async function deleteRowsByUserIndex(storeName, userId) {
  const rows = await db.getAllByIndex(storeName, 'userId', userId).catch(() => []);
  await Promise.all((Array.isArray(rows) ? rows : [])
    .filter((row) => row?.id != null)
    .map((row) => db.deleteRecord(storeName, row.id).catch(() => {})));
  return rows.length;
}

async function deleteIdentityOwnedData(userId, options = {}) {
  const id = String(userId || '').trim();
  if (!id) return { chats: 0, rows: 0, settings: 0 };
  const protectedSettingKeys = new Set((options.protectedSettingKeys || [])
    .map((key) => String(key || '').trim())
    .filter(Boolean));
  const chats = await db.getAllByIndex('chats', 'userId', id).catch(() => []);
  let deletedChats = 0;
  if (chats.length) {
    const { deleteChatWithData } = await import('./chat-store.js');
    for (const chat of chats) {
      if (!chat?.id) continue;
      await deleteChatWithData(chat.id, id).catch(async () => {
        await db.deleteRecord('chats', chat.id).catch(() => {});
      });
      deletedChats += 1;
    }
  }

  let deletedRows = 0;
  for (const storeName of USER_SCOPED_INDEX_STORES) {
    deletedRows += await deleteRowsByUserIndex(storeName, id);
  }
  await db.deleteRecord('streamerLedger', id).catch(() => {});

  // 少数历史表没有 userId 索引，只对明确的所有者字段做精确匹配。
  for (const storeName of ['weiboPosts', 'musicTracks', 'musicPlaylists', 'musicPosts']) {
    const rows = await db.getAllRecords(storeName).catch(() => []);
    for (const row of rows) {
      if (!recordOwnedByUser(row, id) || row?.id == null) continue;
      await db.deleteRecord(storeName, row.id).catch(() => {});
      deletedRows += 1;
    }
  }

  // 身份级功能大量使用 settings 前缀存储。用户 id 是生成的唯一长标识，
  // 只删除 key 中含该完整标识的行，不扫描或改写其它身份的聚合值。
  const encodedId = encodeURIComponent(id);
  const settingRows = await db.getAllRecords('settings').catch(() => []);
  let deletedSettings = 0;
  for (const row of settingRows) {
    const key = String(row?.key || '');
    if (!key || (key !== id && !key.includes(id) && !key.includes(encodedId))) continue;
    if (key === CURRENT_USER_KEY) continue;
    if (protectedSettingKeys.has(key)) continue;
    await db.remove(key).catch(() => {});
    deletedSettings += 1;
  }
  return { chats: deletedChats, rows: deletedRows, settings: deletedSettings };
}

async function mapInBatches(values, batchSize, mapper) {
  const rows = Array.isArray(values) ? values : [];
  const out = [];
  const size = Math.max(1, Number(batchSize || 8) || 8);
  for (let index = 0; index < rows.length; index += size) {
    out.push(...await Promise.all(rows.slice(index, index + size).map(mapper)));
  }
  return out;
}

async function collectPrimaryKeysByIndex(storeName, indexName, values) {
  const keys = await mapInBatches([...values], 8, (value) => (
    db.getPrimaryKeysByIndex(storeName, indexName, value).catch(() => [])
  ));
  return [...new Set(keys.flat().filter((key) => key !== undefined && key !== null))];
}

async function deleteKeysInChunks(storeName, keys, onChunk = null) {
  const rows = Array.isArray(keys) ? keys : [];
  let deleted = 0;
  for (let index = 0; index < rows.length; index += 120) {
    const chunk = rows.slice(index, index + 120);
    deleted += await db.deleteMany(storeName, chunk).catch(() => 0);
    onChunk?.({ deleted, total: rows.length });
  }
  return deleted;
}

async function deleteIdentitiesOwnedDataBatch(userIds, options = {}) {
  const ownerIds = new Set((Array.isArray(userIds) ? userIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const nonIndexedStores = ['weiboPosts', 'musicTracks', 'musicPlaylists', 'musicPosts'];
  const totalStages = 5 + USER_SCOPED_INDEX_STORES.length + nonIndexedStores.length;
  let completed = 0;
  const emit = (phase, label, detail = '') => onProgress({
    phase,
    label,
    detail,
    completed,
    total: totalStages,
    percent: Math.min(99, Math.round((completed / totalStages) * 100)),
  });
  const finishStage = (phase, label, detail = '') => {
    completed += 1;
    emit(phase, label, detail);
  };

  emit('prepare', '正在整理待删除数据');
  const chatIds = await collectPrimaryKeysByIndex('chats', 'userId', ownerIds);
  finishStage('chats', '已找到聊天', `${chatIds.length} 个会话`);

  if (chatIds.length) {
    const chatIdSet = new Set(chatIds.map(String));
    await import('./background-scheduler.js').then(async (mod) => {
      await mapInBatches(chatIds, 8, (chatId) => mod.unscheduleChat?.(chatId, { cancelCloud: false }));
    }).catch(() => {});
    await import('./chat/pending-actions.js').then(async (mod) => {
      await mapInBatches([...ownerIds], 8, (ownerId) => (
        mod.cancelPendingActions?.(ownerId, (action) => chatIdSet.has(String(action?.chatId || '')))
      ));
    }).catch(() => {});
  }
  finishStage('schedules', '已停止后台任务');

  const messageIds = await collectPrimaryKeysByIndex('messages', 'chatId', new Set(chatIds));
  await deleteKeysInChunks('messages', messageIds, ({ deleted, total }) => {
    emit('messages', '正在清理聊天记录', `${deleted} / ${total}`);
  });
  finishStage('messages', '已清理聊天记录', `${messageIds.length} 条`);
  await deleteKeysInChunks('chats', chatIds);

  let deletedRows = messageIds.length + chatIds.length;
  for (const storeName of USER_SCOPED_INDEX_STORES) {
    emit('indexed-data', `正在清理 ${storeName}`);
    const keys = await collectPrimaryKeysByIndex(storeName, 'userId', ownerIds);
    deletedRows += await deleteKeysInChunks(storeName, keys, ({ deleted, total }) => {
      emit('indexed-data', `正在清理 ${storeName}`, `${deleted} / ${total}`);
    });
    finishStage('indexed-data', `已清理 ${storeName}`, `${keys.length} 条`);
  }

  await deleteKeysInChunks('streamerLedger', [...ownerIds]);
  finishStage('ledger', '已清理档位账本');

  for (const storeName of nonIndexedStores) {
    emit('legacy-data', `正在检查 ${storeName}`);
    const rows = await db.getAllRecords(storeName).catch(() => []);
    const keys = rows
      .filter((row) => [...ownerIds].some((ownerId) => recordOwnedByUser(row, ownerId)))
      .map((row) => row?.id)
      .filter((key) => key !== undefined && key !== null);
    deletedRows += await deleteKeysInChunks(storeName, keys);
    finishStage('legacy-data', `已清理 ${storeName}`, `${keys.length} 条`);
  }

  emit('settings', '正在清理档位设置');
  const settingRows = await db.getAllRecords('settings').catch(() => []);
  const worldIds = (Array.isArray(options.worldIds) ? options.worldIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const ownerTokens = [...new Set([...ownerIds, ...worldIds])]
    .flatMap((id) => [id, encodeURIComponent(id)]);
  const chatTokens = chatIds.map(String);
  const settingKeys = settingRows.map((row) => String(row?.key || '')).filter((key) => (
    key
    && key !== CURRENT_USER_KEY
    && (ownerTokens.some((token) => token && key.includes(token))
      || chatTokens.some((token) => token && key.includes(token)))
  ));
  await deleteKeysInChunks('settings', settingKeys);
  finishStage('settings', '已清理档位设置', `${settingKeys.length} 条`);

  return {
    chats: chatIds.length,
    rows: deletedRows,
    settings: settingKeys.length,
  };
}

export async function deleteUserIdentity(userId) {
  const id = String(userId || '').trim();
  if (!id) return { deletedUserIds: [] };
  const all = await listUsers();
  const target = all.find((user) => user.id === id);
  if (!target) throw new Error('身份不存在');
  if (all.length <= 1) throw new Error('至少保留一个身份');
  const currentId = await getCurrentUserId();
  if (currentId === id) {
    const sameSlot = all.find((candidate) => (
      candidate.id !== id
      && String(candidate.slotGroupId || candidate.id) === String(target.slotGroupId || target.id)
    ));
    const next = sameSlot || all.find((candidate) => candidate.id !== id);
    if (next) await setCurrentUserId(next.id);
  }
  const worldId = String(target.worldId || target.slotGroupId || target.id).trim();
  const worldStillExists = all.some((candidate) => (
    candidate.id !== id
    && String(candidate.worldId || candidate.slotGroupId || candidate.id).trim() === worldId
  ));
  const cleanup = await deleteIdentityOwnedData(id, {
    protectedSettingKeys: worldStillExists
      ? [`timeScheduleWorld_${worldId}`, `auWorldConfig:v1:${worldId}`]
      : [],
  });
  await db.deleteRecord('users', id);
  return { deletedUserIds: [id], cleanup };
}

export async function deleteUserSlot(userId) {
  return deleteUserSlots([userId]);
}

export async function deleteUserSlots(userIds = [], options = {}) {
  const requestedIds = new Set((Array.isArray(userIds) ? userIds : [userIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  if (!requestedIds.size) return { deletedUserIds: [], deletedSlotGroupIds: [] };
  const all = await listUsers();
  const requestedGroups = new Set();
  for (const user of all) {
    const slotGroupId = String(user.slotGroupId || user.id).trim();
    if (requestedIds.has(user.id) || requestedIds.has(slotGroupId)) requestedGroups.add(slotGroupId);
  }
  if (!requestedGroups.size) throw new Error('档位不存在');
  const deleting = all.filter((user) => requestedGroups.has(String(user.slotGroupId || user.id).trim()));
  const remaining = all.filter((user) => !requestedGroups.has(String(user.slotGroupId || user.id).trim()));
  if (!remaining.length) throw new Error('至少保留一个档位');
  const deletingIds = new Set(deleting.map((user) => user.id));
  const currentId = await getCurrentUserId();
  if (deletingIds.has(currentId)) await setCurrentUserId(remaining[0].id);
  const cleanup = [await deleteIdentitiesOwnedDataBatch([...deletingIds], {
    ...options,
    worldIds: [...requestedGroups],
  })];
  options.onProgress?.({
    phase: 'users',
    label: '正在删除档位',
    detail: `${deletingIds.size} 个身份`,
    completed: 1,
    total: 1,
    percent: 99,
  });
  await deleteKeysInChunks('users', [...deletingIds]);
  options.onProgress?.({
    phase: 'done',
    label: '删除完成',
    detail: `${requestedGroups.size} 个档位`,
    completed: 1,
    total: 1,
    percent: 100,
  });
  return { deletedUserIds: [...deletingIds], deletedSlotGroupIds: [...requestedGroups], cleanup };
}
