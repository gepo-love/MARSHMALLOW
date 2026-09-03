/**
 * 线下沉浸态会话的纯存取层（无业务逻辑，无 buildChatContext 依赖）。
 *
 * 独立成文件是为了让 core/context/build-chat-context.js 能够读取「进行中的线下/旅行会话」
 * 来给主聊天拼状态块，同时不会和 core/offline-session.js（反过来依赖 build-chat-context.js）
 * 形成循环 import。
 *
 * 防丢：主 key + mirror 双写；save 拒绝陈旧缩写/异 id 覆盖；load 可从 mirror 自愈。
 */
import {
  get as dbGet,
  getMany as dbGetMany,
  put as dbPut,
  remove as dbRemove,
} from './db.js';
import { ensureOfflineBranching } from './offline-branch-snapshot.js';
import {
  compactLegacyOfflineContinuitySnapshots,
  rebuildOfflineContinuityState,
  stripLeakedOfflineContinuityTail,
} from './offline-continuity-state.js';

const OFFLINE_CLEAR_TOMBSTONE_TTL_MS = 10 * 60 * 1000;
/** chatId -> { sessionIds: Set<string>, clearedAt: number } */
const clearedOfflineSessions = new Map();
/** 同一场的镜像 + 主记录必须串行提交，避免两个页面同时通过陈旧检查后倒序覆盖。 */
const offlineSessionSaveQueues = new Map();

function activeClearTombstone(chatId) {
  const id = String(chatId || '').trim();
  const entry = id ? clearedOfflineSessions.get(id) : null;
  if (!entry) return null;
  if (Date.now() - Number(entry.clearedAt || 0) <= OFFLINE_CLEAR_TOMBSTONE_TTL_MS) return entry;
  clearedOfflineSessions.delete(id);
  return null;
}

function markOfflineSessionCleared(chatId, sessionId = '') {
  const id = String(chatId || '').trim();
  if (!id) return;
  const sid = String(sessionId || '').trim();
  const previous = activeClearTombstone(id);
  const sessionIds = new Set(previous?.sessionIds || []);
  if (sid) sessionIds.add(sid);
  clearedOfflineSessions.set(id, { sessionIds, clearedAt: Date.now() });
}

function normalizeOfflineSessionShape(session) {
  if (!session || typeof session !== 'object') return session;
  session.beats = Array.isArray(session.beats) ? session.beats : [];
  session.beats.forEach((beat) => {
    if (beat?.role !== 'narration' || typeof beat.text !== 'string') return;
    beat.text = stripLeakedOfflineContinuityTail(beat.text);
  });
  compactLegacyOfflineContinuitySnapshots(session);
  if (!session.continuityState) rebuildOfflineContinuityState(session);
  session.bookmarks = Array.isArray(session.bookmarks) ? session.bookmarks : [];
  ensureOfflineBranching(session);
  return session;
}

export function offlineSessionKey(chatId) {
  return `offlineSession_${String(chatId || '').trim()}`;
}

export function offlineSessionMirrorKey(chatId) {
  return `offlineSessionMirror_${String(chatId || '').trim()}`;
}

export function offlineSessionClearKey(chatId) {
  return `offlineSessionCleared_${String(chatId || '').trim()}`;
}

export function offlineNarrationCount(session = null) {
  return (Array.isArray(session?.beats) ? session.beats : [])
    .filter((b) => b && b.role === 'narration').length;
}

/**
 * Returns the known narration count even when a damaged/stale snapshot lost beats.
 * narrationEver is monotonic and prevents a long-running session from being mistaken
 * for a fresh, safe-to-replace invite after a bad write.
 */
function offlineKnownNarrationCount(session = null) {
  return Math.max(
    offlineNarrationCount(session),
    Math.max(0, Number(session?.narrationEver || 0) || 0),
  );
}

async function isOfflineSessionAlreadyArchived(session = null) {
  const sessionId = String(session?.id || '').trim();
  const userId = String(session?.userId || '').trim();
  if (!sessionId || !userId) return false;
  const key = `offlineDateArchives_${encodeURIComponent(userId || 'guest')}`;
  const row = await dbGet('settings', key);
  const archives = Array.isArray(row?.value) ? row.value : [];
  const archive = archives.find((item) => (
    String(item?.sourceSessionId || '').trim() === sessionId
  ));
  if (!archive?.id) return false;
  const completion = await dbGet(
    'settings',
    `offlineDateArchiveCompletion_${encodeURIComponent(sessionId)}`,
  );
  if (
    String(completion?.value?.archiveId || '').trim() === String(archive.id || '').trim()
  ) return true;

  // 旧版还没有 completion 小标记；只有对应参与者的共同回忆全部落库，才把档案
  // 视为真正收纳完成。若归档中途失败，只写出了半份档案，必须保留现场供用户重试。
  const participantIds = Array.isArray(archive.participantIds)
    ? archive.participantIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [String(archive.characterId || '').trim()].filter(Boolean);
  if (!participantIds.length) return false;
  const memoryIds = participantIds.length > 1
    ? participantIds.map((id) => `mem_oda_${archive.id}_${id}`)
    : [`mem_oda_${archive.id}`];
  const memories = await Promise.all(memoryIds.map((id) => dbGet('memories', id)));
  return memories.every((memory) => (
    String(memory?.offlineDateArchiveId || '').trim() === String(archive.id || '').trim()
  ));
}

async function discardArchivedSessionGhost(chatId, session = null) {
  if (!session) return false;
  let archived = false;
  try {
    archived = await isOfflineSessionAlreadyArchived(session);
  } catch (_) {
    return false;
  }
  if (!archived) return false;
  await clearOfflineSession(chatId, { sessionId: session.id });
  console.warn('[offline-session] cleared archived session ghost', {
    chatId: String(chatId || '').trim(),
    sessionId: String(session.id || '').trim(),
  });
  return true;
}

export function shouldRefuseOfflineSessionShrink(existing = null, next = null, { allowShrink = false } = {}) {
  if (allowShrink || !existing) return false;
  const existingStoredNarr = offlineNarrationCount(existing);
  const nextStoredNarr = offlineNarrationCount(next);
  const existingNarr = offlineKnownNarrationCount(existing);
  const nextNarr = offlineKnownNarrationCount(next);
  // narrationEver 只能证明“这场曾有进度”，不能掩盖实体 beats 已经变少。
  // 否则带着最新 narrationEver 的陈旧页面快照仍能覆盖几十层正文。
  return nextStoredNarr < existingStoredNarr || nextNarr < existingNarr;
}

function latestNarrationRevision(session = null) {
  const beat = [...(Array.isArray(session?.beats) ? session.beats : [])]
    .reverse()
    .find((row) => row?.role === 'narration');
  return {
    id: String(beat?.id || '').trim(),
    version: Math.max(0, Number(beat?.revisionVersion || 0) || 0),
    changedAt: Math.max(
      0,
      Number(beat?.revisedAt || 0) || 0,
      Number(beat?.editedAt || 0) || 0,
    ),
  };
}

function shouldRefuseOlderSameFloorSnapshot(existing = null, next = null) {
  if (!existing || !next) return false;
  if (offlineNarrationCount(existing) !== offlineNarrationCount(next)) return false;
  const current = latestNarrationRevision(existing);
  const incoming = latestNarrationRevision(next);
  if (!current.id || current.id !== incoming.id) return false;
  if (incoming.version !== current.version) return incoming.version < current.version;
  if (incoming.changedAt !== current.changedAt) return incoming.changedAt < current.changedAt;
  return Number(next.updatedAt || 0) < Number(existing.updatedAt || 0);
}

/**
 * 同楼层数的镜像也可能更新：重 roll、编辑正文、手机动作回执都不会新增楼层。
 * 优先实体楼层更多的副本；楼层相同时再看末层版本和写入时间。
 */
export function compareOfflineSessionSnapshots(left = null, right = null) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  const narrationDelta = offlineNarrationCount(left) - offlineNarrationCount(right);
  if (narrationDelta) return narrationDelta;
  // 保存层把 updatedAt 维持为单调递增。先尊重最近一次完整用户操作，避免
  // 切换到旧分支（其末层 revisionVersion 可能较低）后又被高版本旧分支抢回。
  const updatedDelta = Number(left.updatedAt || 0) - Number(right.updatedAt || 0);
  if (updatedDelta) return updatedDelta;
  const leftRevision = latestNarrationRevision(left);
  const rightRevision = latestNarrationRevision(right);
  if (leftRevision.id && leftRevision.id === rightRevision.id) {
    const versionDelta = leftRevision.version - rightRevision.version;
    if (versionDelta) return versionDelta;
    const changedDelta = leftRevision.changedAt - rightRevision.changedAt;
    if (changedDelta) return changedDelta;
  }
  // mirroredAt 只是“副本写完”的时间，不代表内容比同一次保存的主记录新；
  // 若把它参与比较，每次正常加载都会误报成从镜像恢复。
  return (Array.isArray(left.beats) ? left.beats.length : 0)
    - (Array.isArray(right.beats) ? right.beats.length : 0);
}

/** Whether a session has ever gained real progress. */
export function offlineSessionHasProgress(session = null) {
  if (offlineKnownNarrationCount(session) > 0) return true;
  return (Array.isArray(session?.beats) ? session.beats : [])
    .some((b) => b && (b.role === 'user' || b.role === 'choice'));
}

async function readPrimaryRaw(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const row = await dbGet('settings', offlineSessionKey(id));
  return row?.value || null;
}

async function readMirrorRaw(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const row = await dbGet('settings', offlineSessionMirrorKey(id));
  return row?.value || null;
}

async function writeMirror(session) {
  if (!session?.chatId || !offlineSessionHasProgress(session)) return;
  // The recovery copy deliberately omits local base64 media. Keeping those blobs in
  // every full-session rewrite is the main long-session quota risk; text recovery is
  // more important than restoring an already-rendered image or voice attachment.
  const beats = (Array.isArray(session.beats) ? session.beats : []).map((beat) => {
    const next = { ...beat };
    if (next.image?.url && /^data:/i.test(String(next.image.url))) {
      next.image = { ...next.image, url: '', recoveredWithoutLocalMedia: true };
    }
    if (next.audio?.dataUrl) {
      next.audio = { ...next.audio, dataUrl: '', recoveredWithoutLocalMedia: true };
    }
    return next;
  });
  await dbPut('settings', {
    key: offlineSessionMirrorKey(session.chatId),
    value: {
      ...session,
      beats,
      updatedAt: session.updatedAt || Date.now(),
      mirroredAt: Date.now(),
    },
  });
}

/**
 * 读取进行中线下会话。主 key 空/无进度而 mirror 有进度时，自动把 mirror 写回主 key。
 * @returns {Promise<{ session: object|null, recoveredFromMirror?: boolean }>}
 */
export async function loadOfflineSessionWithMeta(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return { session: null };
  const [primary, mirror, clearRow] = await Promise.all([
    readPrimaryRaw(id),
    readMirrorRaw(id),
    dbGet('settings', offlineSessionClearKey(id)),
  ]);
  const clearedSessionId = String(clearRow?.value?.sessionId || '').trim();
  const storedSessionIds = [primary, mirror]
    .map((session) => String(session?.id || '').trim())
    .filter(Boolean);
  if (
    clearedSessionId
    && storedSessionIds.some((sessionId) => sessionId === clearedSessionId)
  ) {
    // 删除成功后若旧页面的延迟保存、原生存储镜像或异常中断又留下同一场记录，
    // 以持久化墓碑为准清掉，绝不能把用户明确删除的现场“自愈”回来。
    markOfflineSessionCleared(id, clearedSessionId);
    await Promise.allSettled([
      dbRemove(offlineSessionMirrorKey(id)),
      dbRemove(offlineSessionKey(id)),
    ]);
    return { session: null, discardedClearedSession: true };
  }
  if (
    clearedSessionId
    && storedSessionIds.length
    && storedSessionIds.every((sessionId) => sessionId !== clearedSessionId)
  ) {
    // 已经明确开始了另一场，旧墓碑完成使命；不要影响新 session。
    await dbRemove(offlineSessionClearKey(id)).catch(() => {});
  }
  // A primary snapshot that only retains narrationEver is not usable for rendering.
  // Prefer the compact recovery copy whenever it physically contains more beats.
  if (mirror && compareOfflineSessionSnapshots(mirror, primary) > 0) {
    const restored = { ...mirror, updatedAt: Date.now() };
    delete restored.mirroredAt;
    if (await discardArchivedSessionGhost(id, restored)) {
      return { session: null, discardedArchivedSession: true };
    }
    await dbPut('settings', { key: offlineSessionKey(id), value: restored });
    return { session: normalizeOfflineSessionShape(restored), recoveredFromMirror: true };
  }
  if (primary) {
    if (await discardArchivedSessionGhost(id, primary)) {
      return { session: null, discardedArchivedSession: true };
    }
    return { session: normalizeOfflineSessionShape(primary) };
  }
  if (mirror && offlineSessionHasProgress(mirror)) {
    const restored = { ...mirror, updatedAt: Date.now() };
    delete restored.mirroredAt;
    if (await discardArchivedSessionGhost(id, restored)) {
      return { session: null, discardedArchivedSession: true };
    }
    await dbPut('settings', { key: offlineSessionKey(id), value: restored });
    return { session: normalizeOfflineSessionShape(restored), recoveredFromMirror: true };
  }
  return { session: normalizeOfflineSessionShape(primary) || null };
}

export async function loadOfflineSession(chatId) {
  const { session } = await loadOfflineSessionWithMeta(chatId);
  return session;
}

/**
 * 批量读取一组聊天中仍在进行的线下会话，供聊天上下文与群像物理锁使用。
 *
 * 旧路径会先列出几十个聊天，再给每个 chat 分别读取 primary / mirror / tombstone，
 * 一轮提示构建轻易产生数百个 IndexedDB 事务。这里在同一个只读事务中按精确 key
 * 批量读取，并沿用 loadOfflineSessionWithMeta 的镜像优先级与删除墓碑判断；它只读，
 * 不在发模型请求的关键路径里触发恢复写入或归档清理。
 */
export async function listActiveOfflineSessionsForChats(chatIds = []) {
  const ids = [...new Set((Array.isArray(chatIds) ? chatIds : [chatIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (!ids.length) return [];

  const keys = ids.flatMap((chatId) => [
    offlineSessionKey(chatId),
    offlineSessionMirrorKey(chatId),
    offlineSessionClearKey(chatId),
  ]);
  const rows = await dbGetMany('settings', keys);
  const active = [];
  ids.forEach((chatId, index) => {
    const offset = index * 3;
    const primary = rows[offset]?.value || null;
    const mirror = rows[offset + 1]?.value || null;
    const clearRow = rows[offset + 2]?.value || null;
    const clearedSessionId = String(clearRow?.sessionId || '').trim();
    if (clearedSessionId && [primary, mirror].some((session) => (
      String(session?.id || '').trim() === clearedSessionId
    ))) return;

    let selected = primary;
    if (mirror && compareOfflineSessionSnapshots(mirror, primary) > 0) selected = mirror;
    else if (!selected && mirror && offlineSessionHasProgress(mirror)) selected = mirror;
    if (!selected || String(selected.status || '') !== 'active') return;
    const session = normalizeOfflineSessionShape(selected);
    if (session) active.push(session);
  });
  return active;
}

/**
 * @param {object} session
 * @param {{ allowShrink?: boolean, replace?: boolean }} [options]
 * @returns {Promise<object|null>} 实际保留的 session（可能因防护未写入而返回库内旧值）
 */
async function saveOfflineSessionUnlocked(session, options = {}) {
  if (!session?.chatId) return null;
  normalizeOfflineSessionShape(session);
  const allowShrink = options.allowShrink === true;
  const replace = options.replace === true;
  const chatId = String(session.chatId || '').trim();
  const nextId = String(session.id || '').trim();
  const clearTombstone = activeClearTombstone(chatId);
  if (
    clearTombstone
    && !replace
    && (!nextId || clearTombstone.sessionIds.has(nextId))
  ) {
    console.warn('[offline-session] refuse revive cleared session', { chatId, sessionId: nextId });
    return null;
  }
  // 明确开始/替换成另一场时解除旧墓碑；同一 chat 可以立即开始新线下。
  if (clearTombstone && (replace || (nextId && !clearTombstone.sessionIds.has(nextId)))) {
    clearedOfflineSessions.delete(chatId);
    await dbRemove(offlineSessionClearKey(chatId)).catch(() => {});
  }
  const existing = await readPrimaryRaw(chatId);

  if (existing) {
    const existingId = String(existing.id || '').trim();
    const existingNarr = offlineKnownNarrationCount(existing);
    const nextNarr = offlineKnownNarrationCount(session);

    if (existingId && nextId && existingId !== nextId) {
      if (offlineSessionHasProgress(existing) && !replace) {
        console.warn('[offline-session] refuse overwrite: different session id with progress', {
          chatId, existingId, nextId, existingNarr, nextNarr,
        });
        return existing;
      }
    } else if (existingId && nextId && existingId === nextId) {
      // 自动保存不得把已有进度写成空壳；用户明确删除、截断或切换路线时，
      // 调用方会传 allowShrink，必须允许它把最后一层也真正删掉。
      if (shouldRefuseOfflineSessionShrink(existing, session, { allowShrink })) {
        console.warn('[offline-session] refuse shrink save: stale/fewer narrations', {
          chatId, sessionId: nextId, existingNarr, nextNarr,
        });
        return existing;
      }
      if (!allowShrink && shouldRefuseOlderSameFloorSnapshot(existing, session)) {
        console.warn('[offline-session] refuse stale same-floor save', {
          chatId, sessionId: nextId,
        });
        return existing;
      }
    } else if (!nextId && offlineSessionHasProgress(existing) && !replace) {
      console.warn('[offline-session] refuse overwrite: missing session id', { chatId });
      return existing;
    }
  }

  session.updatedAt = Math.max(
    Date.now(),
    Number(existing?.updatedAt || 0) + 1,
  );
  // Persist the compact recovery copy first. A full snapshot can contain generated
  // base64 images/audio and exceed browser quota after a long scene.
  let mirrorSaved = false;
  await writeMirror(session).then(() => {
    mirrorSaved = offlineSessionHasProgress(session);
  }).catch((err) => {
    console.warn('[offline-session] mirror write failed', err);
  });
  try {
    await dbPut('settings', { key: offlineSessionKey(chatId), value: session });
  } catch (err) {
    // 完整主记录可能被本地大图/语音撑过配额；紧凑文字镜像已经成功时，
    // 不把刚完成的重 roll 回滚成旧稿。下次 load 会自动用镜像修复主记录。
    if (!mirrorSaved) throw err;
    console.warn('[offline-session] primary write failed; compact mirror retained', err);
  }
  return session;
}

export function saveOfflineSession(session, options = {}) {
  const chatId = String(session?.chatId || '').trim();
  if (!chatId) return Promise.resolve(null);
  const previous = offlineSessionSaveQueues.get(chatId) || Promise.resolve();
  const queued = previous
    .catch(() => {})
    .then(() => saveOfflineSessionUnlocked(session, options));
  offlineSessionSaveQueues.set(chatId, queued);
  const cleanup = () => {
    if (offlineSessionSaveQueues.get(chatId) === queued) offlineSessionSaveQueues.delete(chatId);
  };
  void queued.then(cleanup, cleanup);
  return queued;
}

export async function clearOfflineSession(chatId, options = {}) {
  const id = String(chatId || '').trim();
  if (!id) return;
  const pendingSave = offlineSessionSaveQueues.get(id);
  if (pendingSave) await pendingSave.catch(() => {});
  let sessionId = String(options?.sessionId || '').trim();
  if (!sessionId) {
    const existing = await readPrimaryRaw(id).catch(() => null);
    sessionId = String(existing?.id || '').trim();
  }
  // 必须在第一次删除前登记：否则已排队的旧 save 可能正好夹在双删之间复活现场。
  markOfflineSessionCleared(id, sessionId);
  await dbPut('settings', {
    key: offlineSessionClearKey(id),
    value: {
      chatId: id,
      sessionId,
      clearedAt: Date.now(),
    },
  });
  // 先删恢复副本，再删主记录。若反过来，恰好夹在两次删除之间的 load 会看到
  // “主记录为空 + mirror 有进度”，并按自愈逻辑把刚结束的会话重新写回主记录。
  await dbRemove(offlineSessionMirrorKey(id));
  await dbRemove(offlineSessionKey(id));
}
