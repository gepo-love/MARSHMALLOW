/**
 * 线下路线分支：活动路线保留在 session，未活动路线以紧凑快照单独持久化。
 * 本模块不做 merge；切换前总会先保存当前活动路线。
 */
import { get as dbGet, put as dbPut, remove as dbRemove } from './db.js';
import { rebuildOfflineContinuityState } from './offline-continuity-state.js';

export const OFFLINE_BRANCH_SNAPSHOT_VERSION = 1;
export const OFFLINE_BRANCH_MAX_COUNT = 12;
export const OFFLINE_BRANCH_MAX_BYTES = 1_500_000;

const ROUTE_FIELDS = [
  'beats',
  'checkpointSummaries',
  'checkpointRollup',
  'continuityState',
  'continuityStorageVersion',
  'scene',
  'bookmarks',
  'attendance',
  'participants',
  'narrationEver',
  'revisions',
  'rerollVersions',
  'phoneSideTrip',
  'uiState',
];

function clone(value, fallback = null) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function branchId(prefix = 'obr') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function offlineBranchSnapshotKey(sessionOrIds = {}) {
  const sessionId = String(sessionOrIds.sessionId || sessionOrIds.id || '').trim();
  const chatId = String(sessionOrIds.chatId || '').trim();
  return `offlineBranchSnapshots_${encodeURIComponent(chatId)}_${encodeURIComponent(sessionId)}`;
}

function isReusableMediaUrl(value = '') {
  const url = String(value || '').trim();
  if (!url || /^data:/i.test(url) || /^blob:/i.test(url)) return false;
  return /^(https?:|\/|\.\/|\.\.\/|assets\/)/i.test(url);
}

function stripLargeMediaValue(value, key = '') {
  if (typeof value === 'string') {
    if (/^(data:|blob:)/i.test(value)) {
      return { omitted: true, reason: 'local_media' };
    }
    if (/base64/i.test(key) && value.length > 256) {
      return { omitted: true, reason: 'base64_media' };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => stripLargeMediaValue(item));
  if (!value || typeof value !== 'object') return value;
  const next = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (childKey === 'dataUrl' || childKey === 'audioDataUrl' || childKey === 'base64') {
      if (typeof child === 'string' && child) {
        next.mediaOmitted = true;
        continue;
      }
    }
    if (childKey === 'url' && typeof child === 'string' && /^(data:|blob:)/i.test(child)) {
      next.url = '';
      next.mediaOmitted = true;
      continue;
    }
    next[childKey] = stripLargeMediaValue(child, childKey);
  }
  return next;
}

/** 纯函数：生成可安全持久化的当前路线快照。 */
export function createOfflineBranchSnapshot(session = {}, branch = null, now = Date.now()) {
  const route = {};
  for (const field of ROUTE_FIELDS) {
    if (session[field] !== undefined) route[field] = stripLargeMediaValue(clone(session[field]));
  }
  route.beats = Array.isArray(route.beats) ? route.beats : [];
  route.bookmarks = Array.isArray(route.bookmarks) ? route.bookmarks : [];
  route.checkpointSummaries = Array.isArray(route.checkpointSummaries) ? route.checkpointSummaries : [];
  route.revisions = Array.isArray(route.revisions) ? route.revisions : [];
  route.narrationEver = Math.max(
    Number(route.narrationEver || 0),
    route.beats.filter((beat) => beat?.role === 'narration').length,
  );
  return {
    version: OFFLINE_BRANCH_SNAPSHOT_VERSION,
    branchId: String(branch?.id || session.branching?.activeBranchId || '').trim(),
    name: String(branch?.name || '').trim(),
    chatId: String(session.chatId || '').trim(),
    sessionId: String(session.id || '').trim(),
    createdAt: Number(branch?.createdAt || now) || now,
    updatedAt: now,
    route,
  };
}

/** 纯函数：把快照路线应用到 session；分支目录等共享字段不会被覆盖。 */
export function applyOfflineBranchSnapshot(session = {}, snapshot = {}) {
  if (!snapshot?.route || typeof snapshot.route !== 'object') {
    return { ok: false, reason: 'snapshot_not_found' };
  }
  for (const field of ROUTE_FIELDS) {
    if (snapshot.route[field] === undefined) {
      delete session[field];
    } else {
      session[field] = clone(snapshot.route[field]);
    }
  }
  session.beats = Array.isArray(session.beats) ? session.beats : [];
  session.bookmarks = Array.isArray(session.bookmarks) ? session.bookmarks : [];
  session.checkpointSummaries = Array.isArray(session.checkpointSummaries) ? session.checkpointSummaries : [];
  session.revisions = Array.isArray(session.revisions) ? session.revisions : [];
  session.narrationEver = Math.max(
    Number(session.narrationEver || 0),
    session.beats.filter((beat) => beat?.role === 'narration').length,
  );
  if (!session.continuityState) rebuildOfflineContinuityState(session);
  delete session.inFlight;
  return { ok: true, session };
}

export function ensureOfflineBranching(session = {}) {
  session.bookmarks = Array.isArray(session.bookmarks) ? session.bookmarks : [];
  const raw = session.branching && typeof session.branching === 'object' ? session.branching : {};
  let branches = Array.isArray(raw.branches)
    ? raw.branches.filter((row) => row?.id).map((row) => ({
      id: String(row.id),
      name: String(row.name || '未命名路线').trim().slice(0, 40) || '未命名路线',
      isMain: row.isMain === true,
      createdAt: Number(row.createdAt || Date.now()),
      updatedAt: Number(row.updatedAt || row.createdAt || Date.now()),
    }))
    : [];
  if (!branches.length) {
    const id = branchId('main');
    branches = [{
      id,
      name: '主干',
      isMain: true,
      createdAt: Number(session.createdAt || Date.now()),
      updatedAt: Date.now(),
    }];
  }
  if (!branches.some((row) => row.isMain)) branches[0].isMain = true;
  const activeBranchId = branches.some((row) => row.id === raw.activeBranchId)
    ? String(raw.activeBranchId)
    : branches.find((row) => row.isMain)?.id || branches[0].id;
  // 就地写回，避免调用方持有旧 branching 引用时把后续改动写丢。
  if (!session.branching || typeof session.branching !== 'object') session.branching = {};
  session.branching.version = OFFLINE_BRANCH_SNAPSHOT_VERSION;
  session.branching.activeBranchId = activeBranchId;
  session.branching.branches = branches;
  return session.branching;
}

export function addOfflineBookmark(session = {}, beatId = '', name = '') {
  const id = String(beatId || '').trim();
  const beat = (session.beats || []).find((row) => row?.id === id && row.role === 'narration');
  if (!beat) return { ok: false, reason: 'narration_not_found' };
  session.bookmarks = Array.isArray(session.bookmarks) ? session.bookmarks : [];
  const existing = session.bookmarks.find((row) => row.beatId === id);
  if (existing) {
    existing.name = String(name || existing.name || '节点').trim().slice(0, 40) || '节点';
    existing.updatedAt = Date.now();
    return { ok: true, bookmark: existing, updated: true };
  }
  const floor = session.beats.slice(0, session.beats.indexOf(beat) + 1)
    .filter((row) => row?.role === 'narration').length;
  const bookmark = {
    id: branchId('obm'),
    beatId: id,
    name: String(name || `第 ${floor} 楼`).trim().slice(0, 40) || `第 ${floor} 楼`,
    floor,
    createdAt: Date.now(),
  };
  session.bookmarks.push(bookmark);
  return { ok: true, bookmark };
}

export function deleteOfflineBookmark(session = {}, bookmarkId = '') {
  const before = Array.isArray(session.bookmarks) ? session.bookmarks : [];
  const next = before.filter((row) => row?.id !== bookmarkId);
  session.bookmarks = next;
  return { ok: next.length !== before.length };
}

function isExternalEventBeat(beat = {}) {
  if (!beat || typeof beat !== 'object') return false;
  if (beat.role === 'daymark') return true;
  if (beat.role === 'interlude') return true;
  if (Array.isArray(beat.phoneActions) && beat.phoneActions.length > 0) return true;
  return !!(
    beat.attendanceEvent
    || beat.attendanceDecision
    || beat.timeAdvanceEvent
    || beat.scheduleEvent
    || beat.itineraryDecision
  );
}

/**
 * 纯函数：V1 只能从最近不可逆外部事件之后的 narration 分叉。
 * 返回 anchorBeatId 供 UI 解释阻止原因。
 */
export function getOfflineForkEligibility(session = {}, targetBeatId = '') {
  const beats = Array.isArray(session.beats) ? session.beats : [];
  const targetIndex = beats.findIndex((beat) => beat?.id === String(targetBeatId || '') && beat.role === 'narration');
  if (targetIndex < 0) return { ok: false, reason: 'narration_not_found' };
  let anchorIndex = -1;
  for (let index = beats.length - 1; index >= 0; index -= 1) {
    if (isExternalEventBeat(beats[index])) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex >= 0 && targetIndex <= anchorIndex) {
    return {
      ok: false,
      reason: 'before_latest_external_event',
      message: '此楼层早于最近一次手机消息、现场成员变化或时间推进，不能从这里另开路线。',
      anchorBeatId: String(beats[anchorIndex]?.id || ''),
      anchorIndex,
      targetIndex,
    };
  }
  return { ok: true, targetIndex, anchorIndex };
}

/** 纯函数：截断到目标 narration（含目标），并清理其后的摘要、重修与节点。 */
export function truncateOfflineRouteAtNarration(session = {}, targetBeatId = '') {
  const eligibility = getOfflineForkEligibility(session, targetBeatId);
  if (!eligibility.ok) return eligibility;
  const keptBeats = session.beats.slice(0, eligibility.targetIndex + 1);
  const keptIds = new Set(keptBeats.map((beat) => String(beat?.id || '')).filter(Boolean));
  const narrationCount = keptBeats.filter((beat) => beat?.role === 'narration').length;
  session.beats = keptBeats;
  session.checkpointSummaries = (Array.isArray(session.checkpointSummaries) ? session.checkpointSummaries : [])
    .filter((row) => Number(row?.uptoBeatIndex || 0) <= narrationCount);
  if (Number(session.checkpointRollup?.uptoBeatIndex || 0) > narrationCount) {
    delete session.checkpointRollup;
  }
  session.revisions = (Array.isArray(session.revisions) ? session.revisions : [])
    .filter((row) => keptIds.has(String(row?.beatId || '')));
  session.bookmarks = (Array.isArray(session.bookmarks) ? session.bookmarks : [])
    .filter((row) => keptIds.has(String(row?.beatId || '')));
  session.narrationEver = narrationCount;
  rebuildOfflineContinuityState(session);
  delete session.inFlight;
  return { ok: true, targetIndex: eligibility.targetIndex, narrationCount };
}

function snapshotBytes(snapshot) {
  try {
    return new Blob([JSON.stringify(snapshot)]).size;
  } catch (_) {
    return JSON.stringify(snapshot).length * 2;
  }
}

/** 纯函数：按 updatedAt 做 LRU，保留条数与总字节上限。 */
export function pruneOfflineBranchSnapshots(snapshots = [], {
  maxCount = OFFLINE_BRANCH_MAX_COUNT,
  maxBytes = OFFLINE_BRANCH_MAX_BYTES,
  protectedBranchIds = [],
} = {}) {
  const protectedIds = new Set(protectedBranchIds.map(String));
  const sorted = [...(Array.isArray(snapshots) ? snapshots : [])]
    .filter((row) => row?.branchId)
    .sort((a, b) => {
      const protectedDiff = Number(protectedIds.has(String(b.branchId))) - Number(protectedIds.has(String(a.branchId)));
      return protectedDiff || Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });
  const kept = [];
  let bytes = 0;
  for (const snapshot of sorted) {
    const size = snapshotBytes(snapshot);
    if (kept.length >= maxCount || bytes + size > maxBytes) continue;
    kept.push(snapshot);
    bytes += size;
  }
  return { snapshots: kept, bytes };
}

/**
 * 路线目录是用户数据，不能因应用自己的软容量预算静默淘汰。
 * 这里只去重并清掉已经不在目录里的孤儿快照；已登记路线一条不少。
 */
export function retainRegisteredOfflineBranchSnapshots(snapshots = [], branchIds = []) {
  const registeredIds = new Set((Array.isArray(branchIds) ? branchIds : []).map(String).filter(Boolean));
  const seen = new Set();
  return [...(Array.isArray(snapshots) ? snapshots : [])]
    .filter((snapshot) => {
      const id = String(snapshot?.branchId || '');
      if (!id || !registeredIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

async function readSnapshotList(session) {
  const row = await dbGet('settings', offlineBranchSnapshotKey(session));
  return Array.isArray(row?.value?.snapshots) ? row.value.snapshots : [];
}

async function writeSnapshotList(session, snapshots) {
  const branching = ensureOfflineBranching(session);
  const retained = retainRegisteredOfflineBranchSnapshots(
    snapshots,
    branching.branches.map((branch) => branch.id),
  );
  const record = {
    key: offlineBranchSnapshotKey(session),
    value: {
      version: OFFLINE_BRANCH_SNAPSHOT_VERSION,
      chatId: String(session.chatId || ''),
      sessionId: String(session.id || ''),
      snapshots: retained,
      updatedAt: Date.now(),
    },
  };
  try {
    await dbPut('settings', record);
    return retained;
  } catch (err) {
    if (!/quota|空间|容量/i.test(`${err?.name || ''} ${err?.message || ''}`)) throw err;
    const wrapped = new Error('路线保存空间不足，原有路线已保留；请先收纳当前线下记录或删除不需要的路线后再试。');
    wrapped.cause = err;
    throw wrapped;
  }
}

export async function listOfflineBranchSnapshots(session = {}) {
  return readSnapshotList(session);
}

export async function saveActiveOfflineBranchSnapshot(session = {}) {
  const branching = ensureOfflineBranching(session);
  const branch = branching.branches.find((row) => row.id === branching.activeBranchId);
  if (!branch) throw new Error('活动路线不存在');
  branch.updatedAt = Date.now();
  const snapshot = createOfflineBranchSnapshot(session, branch);
  const existing = await readSnapshotList(session);
  const saved = await writeSnapshotList(session, [snapshot, ...existing.filter((row) => row.branchId !== branch.id)]);
  if (!saved.some((row) => row.branchId === branch.id)) {
    throw new Error('当前路线快照保存失败，原有路线未改动');
  }
  return snapshot;
}

export async function forkOfflineBranch(session = {}, targetBeatId = '', name = '') {
  const eligibility = getOfflineForkEligibility(session, targetBeatId);
  if (!eligibility.ok) return eligibility;
  const branching = ensureOfflineBranching(session);
  if (branching.branches.length >= OFFLINE_BRANCH_MAX_COUNT) {
    return {
      ok: false,
      reason: 'branch_limit',
      message: `最多保留 ${OFFLINE_BRANCH_MAX_COUNT} 条路线，请先删除不需要的路线。`,
    };
  }
  // 先把当前活动路线完整落盘。注意 saveActive 内部会重建 session.branching，
  // 后面必须重新取引用，不能继续用旧对象，否则新路线写不进 session。
  await saveActiveOfflineBranchSnapshot(session);
  const liveBefore = ensureOfflineBranching(session);
  const routeBackup = Object.fromEntries(ROUTE_FIELDS.map((field) => [field, clone(session[field])]));
  const branchingBackup = clone(liveBefore);
  const nextBranch = {
    id: branchId(),
    name: String(name || `路线 ${liveBefore.branches.length + 1}`).trim().slice(0, 40)
      || `路线 ${liveBefore.branches.length + 1}`,
    isMain: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    const result = truncateOfflineRouteAtNarration(session, targetBeatId);
    if (!result.ok) return result;
    const live = ensureOfflineBranching(session);
    live.branches.push(nextBranch);
    live.activeBranchId = nextBranch.id;
    await saveActiveOfflineBranchSnapshot(session);
    return { ok: true, branch: nextBranch, narrationCount: result.narrationCount };
  } catch (err) {
    for (const field of ROUTE_FIELDS) {
      if (routeBackup[field] === undefined) delete session[field];
      else session[field] = routeBackup[field];
    }
    session.branching = branchingBackup;
    throw err;
  }
}

export async function switchOfflineBranch(session = {}, targetBranchId = '', io = {}) {
  const branching = ensureOfflineBranching(session);
  const targetId = String(targetBranchId || '').trim();
  if (targetId === branching.activeBranchId) return { ok: true, unchanged: true, session };
  if (!branching.branches.some((row) => row.id === targetId)) return { ok: false, reason: 'branch_not_found' };
  const saveCurrent = typeof io.saveCurrent === 'function' ? io.saveCurrent : saveActiveOfflineBranchSnapshot;
  const readSnapshots = typeof io.readSnapshots === 'function' ? io.readSnapshots : readSnapshotList;
  await saveCurrent(session);
  const snapshots = await readSnapshots(session);
  const target = snapshots.find((row) => row.branchId === targetId);
  if (!target) return { ok: false, reason: 'snapshot_not_found' };
  const phoneActionIds = (beats = []) => [...new Set(
    (Array.isArray(beats) ? beats : [])
      .flatMap((beat) => Array.isArray(beat?.phoneActions) ? beat.phoneActions : [])
      .map((action) => String(action?.messageId || '').trim())
      .filter(Boolean),
  )].sort();
  const currentPhoneActions = phoneActionIds(session.beats);
  const targetPhoneActions = phoneActionIds(target.route?.beats);
  if (currentPhoneActions.join('|') !== targetPhoneActions.join('|')) {
    return {
      ok: false,
      reason: 'phone_actions_differ',
      message: '两条路线包含不同的真实手机消息；已发出的消息不能随路线切换撤销。',
    };
  }
  const applied = applyOfflineBranchSnapshot(session, target);
  if (!applied.ok) return applied;
  branching.activeBranchId = targetId;
  const branch = branching.branches.find((row) => row.id === targetId);
  if (branch) branch.updatedAt = Date.now();
  return { ok: true, session, branch };
}

export async function renameOfflineBranch(session = {}, targetBranchId = '', name = '') {
  const branching = ensureOfflineBranching(session);
  const branch = branching.branches.find((row) => row.id === String(targetBranchId || ''));
  if (!branch) return { ok: false, reason: 'branch_not_found' };
  branch.name = String(name || '').trim().slice(0, 40) || branch.name;
  branch.updatedAt = Date.now();
  return { ok: true, branch };
}

export async function deleteOfflineBranch(session = {}, targetBranchId = '') {
  const branching = ensureOfflineBranching(session);
  const targetId = String(targetBranchId || '').trim();
  if (targetId === branching.activeBranchId) return { ok: false, reason: 'active_branch' };
  const branch = branching.branches.find((row) => row.id === targetId);
  if (!branch) return { ok: false, reason: 'branch_not_found' };
  branching.branches = branching.branches.filter((row) => row.id !== targetId);
  if (branch.isMain && branching.branches.length) {
    branching.branches[0].isMain = true;
  }
  const snapshots = await readSnapshotList(session);
  await writeSnapshotList(session, snapshots.filter((row) => row.branchId !== targetId));
  return { ok: true, branch };
}

/** 归档专用：保存正史后只返回其他路线，绝不参与当前摘要输入。 */
export async function buildUnusedOfflineBranchArchives(session = {}) {
  const branching = ensureOfflineBranching(session);
  if (branching.branches.length <= 1) return [];
  await saveActiveOfflineBranchSnapshot(session);
  const snapshots = await readSnapshotList(session);
  return snapshots
    .filter((snapshot) => snapshot.branchId !== branching.activeBranchId)
    .map((snapshot) => {
      const branch = branching.branches.find((row) => row.id === snapshot.branchId);
      return {
        id: snapshot.branchId,
        name: String(branch?.name || snapshot.name || '未采用路线'),
        createdAt: Number(snapshot.createdAt || 0),
        updatedAt: Number(snapshot.updatedAt || 0),
        bookmarks: clone(snapshot.route?.bookmarks || [], []),
        rounds: (snapshot.route?.beats || [])
          .filter((beat) => beat && beat.role !== 'daymark' && String(beat.text || '').trim())
          .map((beat) => ({
            id: String(beat.id || ''),
            role: ['opening', 'directive', 'interlude'].includes(beat.role) ? beat.role : 'narration',
            text: String(beat.text || '').trim(),
            ts: Number(beat.ts || 0),
          })),
      };
    });
}

export async function clearOfflineBranchSnapshots(session = {}) {
  await dbRemove(offlineBranchSnapshotKey(session)).catch(() => {});
}

export const __offlineBranchTest = {
  isReusableMediaUrl,
  stripLargeMediaValue,
  snapshotBytes,
};
