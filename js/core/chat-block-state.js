import { get, getRecord, onStoreWrite, put, updateRecord } from './db.js';
import { isUserAliasBlockedByCharacter } from './stranger-thread-model.js';

const chatPrefsCache = new Map();
const chatPrefsInFlight = new Map();
const characterBlockCache = new Map();
const characterBlockInFlight = new Map();
let blockStateRevision = 0;

onStoreWrite('settings', (key) => {
  const normalizedKey = String(key || '');
  if (!normalizedKey) {
    blockStateRevision += 1;
    chatPrefsCache.clear();
    chatPrefsInFlight.clear();
    characterBlockCache.clear();
    characterBlockInFlight.clear();
    return;
  }
  if (normalizedKey.startsWith('chatPrefs_')) {
    blockStateRevision += 1;
    chatPrefsCache.delete(normalizedKey);
    chatPrefsInFlight.delete(normalizedKey);
  }
  if (normalizedKey.startsWith('characterBlockState_')) {
    blockStateRevision += 1;
    characterBlockCache.delete(normalizedKey);
    characterBlockInFlight.delete(normalizedKey);
  }
});

export function chatPrefsKey(chatId) {
  return `chatPrefs_${String(chatId || '').trim()}`;
}

export function characterBlockKey(characterId, userId = '') {
  const character = String(characterId || '').trim();
  const user = String(userId || '').trim();
  return user
    ? `characterBlockState_${encodeURIComponent(user)}_${character}`
    : `characterBlockState_${character}`;
}

export async function loadChatPrefs(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return {};
  const key = chatPrefsKey(id);
  if (chatPrefsCache.has(key)) return chatPrefsCache.get(key);
  if (chatPrefsInFlight.has(key)) return chatPrefsInFlight.get(key);
  const pending = (async () => {
    let value;
    let observedRevision;
    do {
      observedRevision = blockStateRevision;
      const row = await get(key).catch(() => null);
      value = row?.value && typeof row.value === 'object' ? row.value : {};
    } while (observedRevision !== blockStateRevision);
    chatPrefsCache.set(key, value);
    return value;
  })().finally(() => {
    if (chatPrefsInFlight.get(key) === pending) chatPrefsInFlight.delete(key);
  });
  chatPrefsInFlight.set(key, pending);
  return pending;
}

/**
 * 跨标签页的执行门不能依赖 realm-local cache：另一个页面已经推进
 * 追发拍号时，本页的 onStoreWrite 不会收到那次写入。这个入口每次直接
 * 从 settings 读取，仅在读完后刷新当前 realm 的缓存。
 */
export async function loadChatPrefsFresh(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return {};
  const key = chatPrefsKey(id);
  // 让已在进行的 cached load 重读，避免它在 fresh read 之后又把较早快照塞回缓存。
  blockStateRevision += 1;
  chatPrefsInFlight.delete(key);
  // 这是付费生成前的安全读；存储失败时必须抛错让上层停下，
  // 不能把「读不到」伪装成空 prefs 后再调一次模型。
  const row = await get(key);
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  chatPrefsCache.set(key, value);
  chatPrefsInFlight.delete(key);
  return value;
}

/**
 * 在 IndexedDB 的同一个 readwrite transaction 内读取最新 prefs 并写回。
 * updater 必须是同步函数；返回 null/undefined 表示放弃写入。
 */
export async function updateChatPrefsAtomic(chatId, updater) {
  const id = String(chatId || '').trim();
  if (!id) return { updated: false, value: {} };
  if (typeof updater !== 'function') throw new TypeError('updater must be a function');
  const key = chatPrefsKey(id);
  const result = await updateRecord('settings', key, (row) => {
    const current = row?.value && typeof row.value === 'object' ? row.value : {};
    const next = updater({ ...current });
    if (next === null || next === undefined) return undefined;
    return { key, value: next && typeof next === 'object' ? next : current };
  });
  const value = result?.record?.value && typeof result.record.value === 'object'
    ? result.record.value
    : {};
  chatPrefsCache.set(key, value);
  chatPrefsInFlight.delete(key);
  return { updated: result?.updated === true, value };
}

/** 写入前重新读取并浅合并，避免详情页/聊天并发写 prefs 互相覆盖（如自动摘要被状态更新冲掉） */
export async function patchChatPrefs(chatId, patch = {}) {
  const id = String(chatId || '').trim();
  if (!id) return {};
  const delta = patch && typeof patch === 'object' ? patch : {};
  const result = await updateChatPrefsAtomic(id, (current) => ({ ...current, ...delta }));
  return result.value;
}

/** 同一模型回合里无论有几颗失败气泡，都只累计为一次主账号联系失败。 */
export async function noteBlockedContactFailureRound(chatId, at = Date.now()) {
  const id = String(chatId || '').trim();
  if (!id) return {};
  const current = await loadChatPrefs(id);
  if (!isChatBlockedByUser(null, current)) return current;
  const nextCount = Math.max(0, Number(current.blockedContactFailedRounds || 0) || 0) + 1;
  return patchChatPrefs(id, {
    blockedContactFailedRounds: nextCount,
    blockedContactLastFailedAt: Math.max(1, Number(at) || Date.now()),
  });
}

export async function loadCharacterBlockState(characterId, userId = '') {
  const id = String(characterId || '').trim();
  const uid = String(userId || '').trim();
  if (!id) return { blocked: false };
  const key = characterBlockKey(id, uid);
  if (characterBlockCache.has(key)) return characterBlockCache.get(key);
  if (characterBlockInFlight.has(key)) return characterBlockInFlight.get(key);
  const pending = (async () => {
    let state;
    let observedRevision;
    do {
      observedRevision = blockStateRevision;
      let row = await get(key).catch(() => null);
      let value = row?.value && typeof row.value === 'object' ? row.value : {};
      // 旧版只按 characterId 保存。只有记录里的来源会话明确属于当前档位时才迁移；
      // 无法证明归属的旧记录宁可不继承，避免新档位复用同一角色时被错误拉黑。
      if (!row && uid) {
        const legacyRow = await get(characterBlockKey(id)).catch(() => null);
        const legacyValue = legacyRow?.value && typeof legacyRow.value === 'object' ? legacyRow.value : {};
        const sourceChatId = String(legacyValue.sourceChatId || '').trim();
        const sourceChat = sourceChatId ? await getRecord('chats', sourceChatId).catch(() => null) : null;
        if (sourceChat && String(sourceChat.userId || '').trim() === uid) {
          value = legacyValue;
          row = { key, value };
          await put(row).catch(() => null);
        }
      }
      state = {
        ...value,
        characterId: id,
        blocked: value.blockedByUser === true || value.blockState === 'blocked_by_user',
        blockedAt: Number(value.blockedAt || 0) || 0,
        blockReason: String(value.blockReason || '').trim(),
        sourceChatId: String(value.sourceChatId || '').trim(),
        driftBottleIntervalMinutes: Math.max(5, Math.min(1440, Number(value.driftBottleIntervalMinutes || 30) || 30)),
      };
    } while (observedRevision !== blockStateRevision);
    characterBlockCache.set(key, state);
    return state;
  })().finally(() => {
    if (characterBlockInFlight.get(key) === pending) characterBlockInFlight.delete(key);
  });
  characterBlockInFlight.set(key, pending);
  return pending;
}

export function isChatBlockedByUser(chat, prefs = {}) {
  const meta = chat?.metadata && typeof chat.metadata === 'object' ? chat.metadata : {};
  const state = String(prefs.blockState || meta.blockState || chat?.blockState || '').trim();
  return prefs.blockedByUser === true
    || prefs.userBlocked === true
    || meta.blockedByUser === true
    || meta.userBlocked === true
    || chat?.blockedByUser === true
    || chat?.userBlocked === true
    || state === 'blocked_by_user';
}

export function getChatBlockedState(chat, prefs = {}) {
  const meta = chat?.metadata && typeof chat.metadata === 'object' ? chat.metadata : {};
  return {
    blocked: isChatBlockedByUser(chat, prefs),
    blockedAt: Number(prefs.blockedAt || meta.blockedAt || chat?.blockedAt || 0) || 0,
    blockReason: String(prefs.blockReason || meta.blockReason || chat?.blockReason || '').trim(),
  };
}

export async function setChatBlockedByUser(chatId, blocked, patch = {}) {
  const id = String(chatId || '').trim();
  if (!id) return {};
  const prefs = await loadChatPrefs(id);
  const intervalMinutes = Math.max(5, Math.min(1440, Number(patch.driftBottleIntervalMinutes || prefs.driftBottleIntervalMinutes || 30) || 30));
  const wasBlocked = prefs.blockedByUser === true || prefs.blockState === 'blocked_by_user';
  const blockedAt = blocked
    ? (wasBlocked
      ? (Number(prefs.blockedAt || patch.blockedAt || Date.now()) || Date.now())
      : (Number(patch.blockedAt || Date.now()) || Date.now()))
    : 0;
  const prefsPatch = {
    blockedByUser: !!blocked,
    blockState: blocked ? 'blocked_by_user' : '',
    blockedAt,
    blockReason: blocked ? String(patch.blockReason || prefs.blockReason || '').trim() : '',
    driftBottleIntervalMinutes: intervalMinutes,
  };
  if (!blocked) {
    // 解除拉黑后停止失联联系计时，并清掉本轮升级状态。
    prefsPatch.driftBottleLastFiredAt = 0;
    prefsPatch.blockedContactFailedRounds = 0;
    prefsPatch.blockedContactEscalated = false;
    prefsPatch.blockedContactLastRoute = '';
    prefsPatch.blockedContactLastFailedAt = 0;
  } else if (!wasBlocked) {
    // 刚拉黑：以此刻为基准，满一个间隔后再进行第一次失败联系。
    prefsPatch.driftBottleLastFiredAt = blockedAt;
    prefsPatch.blockedContactFailedRounds = 0;
    prefsPatch.blockedContactEscalated = false;
    prefsPatch.blockedContactLastRoute = '';
    prefsPatch.blockedContactLastFailedAt = 0;
  }
  const next = await patchChatPrefs(id, prefsPatch);
  const characterIds = Array.isArray(patch.characterIds) ? patch.characterIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const userId = String(patch.userId || '').trim();
  await Promise.all(characterIds.map((characterId) => put({
    key: characterBlockKey(characterId, userId),
    value: {
      blockedByUser: !!blocked,
      blockState: blocked ? 'blocked_by_user' : '',
      blockedAt: blocked ? next.blockedAt : 0,
      blockReason: blocked ? next.blockReason : '',
      sourceChatId: id,
      driftBottleIntervalMinutes: intervalMinutes,
    },
  }).catch(() => null)));
  return next;
}

export async function shouldSuppressAiDelivery(chat, { prefs = null, allowManual = false } = {}) {
  if (isUserAliasBlockedByCharacter(chat)) {
    return { blocked: true, reason: 'blocked-by-character-alias' };
  }
  if (allowManual) return { blocked: false };
  const loadedPrefs = prefs || await loadChatPrefs(chat?.id);
  const state = getChatBlockedState(chat, loadedPrefs);
  return state.blocked
    ? { blocked: true, reason: 'blocked-by-user', ...state }
    : { blocked: false };
}
