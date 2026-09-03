import * as db from '../db.js';
import { getNowForUser } from '../time-mode.js';
import { normalizeMomentPost } from '../../models/moment-post.js';
import { syncMomentPostMemory, removeMomentPostMemory } from './moment-memory.js';
import { normalizeMomentsReactionCommentLevel } from './moments-comment-frequency.js';

export { listMomentPostsForUser, listMomentPostsForAuthor, saveMomentPost };
export {
  MOMENTS_REACTION_COMMENT_LEVELS,
  normalizeMomentsReactionCommentLevel,
  sampleMomentsReactionCommentCount,
} from './moments-comment-frequency.js';

export function sortMomentPostsForFeed(posts = [], promotedIds = []) {
  const promoted = promotedIds instanceof Set
    ? promotedIds
    : new Set((Array.isArray(promotedIds) ? promotedIds : []).map((id) => String(id || '').trim()));
  return [...(Array.isArray(posts) ? posts : [])].sort((a, b) => (
    Number(promoted.has(String(b?.id || '').trim())) - Number(promoted.has(String(a?.id || '').trim()))
    || Number(b?.timestamp || 0) - Number(a?.timestamp || 0)
    || String(a?.id || '').localeCompare(String(b?.id || ''))
  ));
}

function prefsKey(userId) {
  return `momentsPrefs_${String(userId || 'guest').trim()}`;
}

export const DEFAULT_MOMENTS_AUTO_GEN = {
  enabled: false,
  intervalHours: 6,
  dailyMaxBatches: 3,
  manualPostCount: 3,
  autoPostCount: 2,
  reactionCommentLevel: 'high',
  // 兼容旧版本读取；新链路按 reactionCommentLevel 每轮随机。
  reactionCommentCount: 4,
  autoReactAfterPublish: true,
  authorIds: [],
  postChatTrigger: false,
  allowImages: false,
  allowTextImages: false,
  allowStickers: true,
};

function normalizeMomentsAutoGen(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const interval = Number(v.intervalHours);
  const dailyMax = Number(v.dailyMaxBatches);
  const manualPostCount = Number(v.manualPostCount);
  const autoPostCount = Number(v.autoPostCount);
  const reactionCommentCount = Number(v.reactionCommentCount);
  const reactionCommentLevel = normalizeMomentsReactionCommentLevel(
    v.reactionCommentLevel,
    reactionCommentCount,
  );
  return {
    enabled: v.enabled === true,
    intervalHours: [2, 4, 6, 12, 24].includes(interval) ? interval : DEFAULT_MOMENTS_AUTO_GEN.intervalHours,
    dailyMaxBatches: Number.isFinite(dailyMax) && dailyMax >= 1 && dailyMax <= 8
      ? Math.round(dailyMax)
      : DEFAULT_MOMENTS_AUTO_GEN.dailyMaxBatches,
    manualPostCount: Number.isFinite(manualPostCount) && manualPostCount >= 1 && manualPostCount <= 5
      ? Math.round(manualPostCount)
      : DEFAULT_MOMENTS_AUTO_GEN.manualPostCount,
    autoPostCount: Number.isFinite(autoPostCount) && autoPostCount >= 1 && autoPostCount <= 5
      ? Math.round(autoPostCount)
      : DEFAULT_MOMENTS_AUTO_GEN.autoPostCount,
    reactionCommentLevel,
    reactionCommentCount: Number.isFinite(reactionCommentCount) && reactionCommentCount >= 1 && reactionCommentCount <= 8
      ? Math.round(reactionCommentCount)
      : DEFAULT_MOMENTS_AUTO_GEN.reactionCommentCount,
    autoReactAfterPublish: v.autoReactAfterPublish !== false,
    authorIds: Array.isArray(v.authorIds)
      ? v.authorIds.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 30)
      : [],
    postChatTrigger: v.postChatTrigger === true,
    allowImages: v.allowImages === true,
    allowTextImages: v.allowTextImages === true,
    allowStickers: v.allowStickers !== false,
  };
}

export async function loadMomentsPrefs(userId) {
  const row = await db.get(prefsKey(userId));
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    coverImage: String(v.coverImage || '').trim(),
    coverByAuthor: v.coverByAuthor && typeof v.coverByAuthor === 'object' ? v.coverByAuthor : {},
    signatureByAuthor: v.signatureByAuthor && typeof v.signatureByAuthor === 'object' ? v.signatureByAuthor : {},
    lastSeenAt: Math.max(0, Number(v.lastSeenAt || 0) || 0),
    // 内容占比（手动生成与自动生成共用）：user 相关 / 修罗场剧情 / 分享转发
    genMix: v.genMix && typeof v.genMix === 'object' ? v.genMix : null,
    autoGen: normalizeMomentsAutoGen(v.autoGen),
  };
}

export async function hasUnreadMoments(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return false;
  const [prefs, rows] = await Promise.all([
    loadMomentsPrefs(uid),
    queryMomentRowsForUser(uid),
  ]);
  const lastSeenAt = Math.max(0, Number(prefs.lastSeenAt || 0) || 0);
  return rows.some((post) => (
    String(post?.authorId || '').trim() !== uid
    && Number(post?.timestamp || 0) > lastSeenAt
  ));
}

async function queryMomentRowsForUser(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const limit = Math.max(0, Number(options.limit || 0) || 0);
  // userId 索引中相同键的 cursor 顺序最终取决于主键，并不等于发布时间。
  // 首屏改走 timestamp 索引倒序，再按档位归属过滤，避免刚发的动态因 id 排序
  // 被截在首批之外。动态可能内嵌多张 Data URL，仍只克隆当前档需要的记录。
  let rows = limit
    ? await db.getAllByIndexRange('momentsPosts', 'timestamp', null, null, {
      direction: 'prev',
      limit,
      filterRecord: (row) => String(row?.userId || row?.ownerUserId || '').trim() === uid,
    }).catch(() => [])
    : await db.getAllByIndex('momentsPosts', 'userId', uid).catch(() => []);
  // 极旧记录可能没有 timestamp 索引值；首屏尚未填满时，用 userId 索引补齐。
  if (limit && rows.length < limit) {
    const indexedRows = await db.getAllByIndexRange('momentsPosts', 'userId', uid, uid, {
      direction: 'prev',
      limit,
    }).catch(() => []);
    const merged = new Map(rows.map((row) => [String(row?.id || '').trim(), row]));
    for (const row of indexedRows) {
      const id = String(row?.id || '').trim();
      if (id && !merged.has(id)) merged.set(id, row);
    }
    rows = [...merged.values()];
  }
  if (!rows.length) {
    const all = await db.getAllRecords('momentsPosts').catch(() => []);
    rows = (Array.isArray(all) ? all : []).filter((row) => (
      String(row?.userId || row?.ownerUserId || '').trim() === uid
    ));
  }
  return Array.isArray(rows) ? rows : [];
}

export async function markMomentsSeen(userId, viewedAt = Date.now()) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  const prefs = await loadMomentsPrefs(uid);
  const nextSeenAt = Math.max(
    Math.max(0, Number(prefs.lastSeenAt || 0) || 0),
    Math.max(0, Number(viewedAt || 0) || 0),
  );
  if (nextSeenAt === prefs.lastSeenAt) return prefs;
  return saveMomentsPrefs(uid, { lastSeenAt: nextSeenAt });
}

export async function loadAuthorMomentsProfile(userId, authorId) {
  const prefs = await loadMomentsPrefs(userId);
  const aid = String(authorId || '').trim();
  return {
    cover: String(prefs.coverByAuthor?.[aid] || '').trim(),
    signature: String(prefs.signatureByAuthor?.[aid] || '').trim(),
  };
}

export async function saveAuthorMomentsProfile(userId, authorId, patch = {}) {
  const aid = String(authorId || '').trim();
  if (!aid) return;
  const prefs = await loadMomentsPrefs(userId);
  const coverByAuthor = { ...(prefs.coverByAuthor || {}) };
  const signatureByAuthor = { ...(prefs.signatureByAuthor || {}) };
  if (Object.prototype.hasOwnProperty.call(patch, 'cover')) {
    coverByAuthor[aid] = String(patch.cover || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'signature')) {
    signatureByAuthor[aid] = String(patch.signature || '').trim();
  }
  await saveMomentsPrefs(userId, { coverByAuthor, signatureByAuthor });
}

export async function saveMomentsPrefs(userId, patch = {}) {
  const prev = await loadMomentsPrefs(userId);
  const next = { ...prev, ...patch };
  await db.put({ key: prefsKey(userId), value: next });
  return next;
}

const MOMENT_TIMESTAMP_STEP_MS = 30_000;
const MOMENT_LEGACY_CURSOR_FUTURE_TOLERANCE_MS = 10 * 60_000;
const MOMENT_CURSOR_ROLLBACK_EPSILON_MS = 1_000;

/**
 * 朋友圈批量生成时用游标把同一世界时刻的多条动态错开；世界时间回拨后则开启新时间段，
 * 不能继续沿用旧未来游标。对象形态记录上次取样的世界时间，旧版纯数字游标用十分钟容差迁移。
 */
export function resolveMomentTimestampCursor(rawCursor, nowTs, options = {}) {
  const now = Number(nowTs || 0) || Date.now();
  const stepMs = Math.max(1_000, Number(options.stepMs) || MOMENT_TIMESTAMP_STEP_MS);
  const legacyToleranceMs = Math.max(
    stepMs,
    Number(options.legacyFutureToleranceMs) || MOMENT_LEGACY_CURSOR_FUTURE_TOLERANCE_MS,
  );
  const cursorObject = rawCursor && typeof rawCursor === 'object' && !Array.isArray(rawCursor)
    ? rawCursor
    : null;
  const previousTimestamp = Math.max(0, Number(cursorObject?.timestamp ?? rawCursor ?? 0) || 0);
  const previousWorldNow = Math.max(0, Number(cursorObject?.worldNow || 0) || 0);
  const rolledBack = previousWorldNow > 0
    ? now + MOMENT_CURSOR_ROLLBACK_EPSILON_MS < previousWorldNow
    : previousTimestamp > now + legacyToleranceMs;
  const timestamp = rolledBack
    ? now
    : Math.max(now, previousTimestamp + stepMs);
  return {
    timestamp,
    rolledBack,
    value: {
      timestamp,
      worldNow: now,
    },
  };
}

export async function allocMomentTimestamp(userId) {
  const uid = String(userId || 'guest').trim();
  const key = `momentsTimeCursor_${uid}`;
  const row = await db.get(key);
  const now = Number(await getNowForUser(uid)) || Date.now();
  const cursor = resolveMomentTimestampCursor(row?.value, now);
  await db.put({ key, value: cursor.value });
  return cursor.timestamp;
}

export async function getMomentPost(postId) {
  const id = String(postId || '').trim();
  if (!id) return null;
  const row = await db.getRecord('momentsPosts', id);
  return row ? normalizeMomentPost(row) : null;
}

async function listMomentPostsForUser(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const requiredIds = [...new Set((Array.isArray(options.requiredIds) ? options.requiredIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  const limit = Math.max(0, Number(options.limit || 0) || 0);
  let rows = await queryMomentRowsForUser(uid, { limit });
  // 部分旧 WebView 升级 IndexedDB 后会出现索引查询为空、主键记录仍存在的情况。
  // 空结果时回扫一次全表；生成后的指定记录则直接按主键补齐，避免“已生成但列表不显示”。
  // 大备份在旧 WebView 上可能同时出现索引快照滞后、全表扫描不完整。无论前两步
  // 是否拿到旧记录，都要按本批主键逐条补回，不能让新动态只进入数量统计。
  const visibleIds = new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.id || '').trim()));
  const missingRequiredIds = requiredIds.filter((id) => !visibleIds.has(id));
  if (missingRequiredIds.length) {
    const recovered = await Promise.all(missingRequiredIds.map((id) => (
      db.getRecord('momentsPosts', id).catch(() => null)
    )));
    rows = [...rows, ...recovered.filter((row) => (
      row && String(row.userId || row.ownerUserId || '').trim() === uid
    ))];
  }
  const uniqueRows = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.id) uniqueRows.set(row.id, row);
  }
  const sorted = sortMomentPostsForFeed([...uniqueRows.values()]
    .map((row) => normalizeMomentPost(row))
    // 索引偶发脏数据时仍硬过滤，避免把别档动态拼进当前时间线
    .filter((post) => String(post?.userId || '').trim() === uid), requiredIds);
  return limit ? sorted.slice(0, limit) : sorted;
}

/**
 * 对齐微博：无归属动态归档到 guest，只补齐 ownerUserId→userId 的索引，
 * 绝不把空归属认领到「当前打开的档位」。
 */
const MOMENTS_OWNERSHIP_HYGIENE_KEY = 'momentsOwnershipHygieneVersion';
// v4：修复旧动态把本人写成 user、把角色名直接写进 authorId 的作者身份；
// 否则信息流里有记录，进入角色主页却会被严格 authorId 过滤掉。
const MOMENTS_OWNERSHIP_HYGIENE_VERSION = 4;
let momentsOwnershipHygienePromise = null;

async function runMomentsOwnershipHygiene() {
  const marker = await db.get('settings', MOMENTS_OWNERSHIP_HYGIENE_KEY).catch(() => null);
  if (Number(marker?.value || 0) >= MOMENTS_OWNERSHIP_HYGIENE_VERSION) return 0;
  const [all, users, chats, characters] = await Promise.all([
    db.getAllRecords('momentsPosts').catch(() => []),
    db.getAllRecords('users').catch(() => []),
    db.getAllRecords('chats').catch(() => []),
    db.getAllRecords('characters').catch(() => []),
  ]);
  const userIds = new Set((users || []).map((row) => String(row?.id || '').trim()).filter(Boolean));
  const userNamesById = new Map((users || []).map((row) => [
    String(row?.id || '').trim(),
    new Set([row?.name, row?.nickname].map((value) => String(value || '').trim()).filter(Boolean)),
  ]));
  const characterByName = new Map();
  const characterIds = new Set();
  for (const character of characters || []) {
    const id = String(character?.id || '').trim();
    if (!id) continue;
    characterIds.add(id);
    for (const rawName of [character?.name, character?.customNickname]) {
      const name = String(rawName || '').trim();
      if (!name) continue;
      if (!characterByName.has(name)) characterByName.set(name, id);
      else if (characterByName.get(name) !== id) characterByName.set(name, '');
    }
  }
  const slotsByCharacter = new Map();
  for (const chat of chats || []) {
    const slotId = String(chat?.userId || '').trim();
    if (!slotId || !userIds.has(slotId)) continue;
    for (const rawId of Array.isArray(chat?.participants) ? chat.participants : []) {
      const id = String(rawId || '').trim();
      if (!id || id === 'user') continue;
      if (!slotsByCharacter.has(id)) slotsByCharacter.set(id, new Set());
      slotsByCharacter.get(id).add(slotId);
    }
  }
  let fixed = 0;
  for (const row of Array.isArray(all) ? all : []) {
    if (!row?.id) continue;
    const uid = String(row.userId || '').trim();
    const oid = String(row.ownerUserId || '').trim();
    const rawAuthorId = String(row.authorId || '').trim();
    let authorId = rawAuthorId;
    const authorName = String(row.authorName || '').trim();
    const needsUnknownAuthorMemoryRepair = !rawAuthorId
      && row?.metadata?.authorIdentityRepaired !== true;
    // 旧动态缺 authorId，或被错误写成 owner userId 时，可用唯一角色名恢复作者。
    const nameMatchedCharacterId = characterByName.get(authorName) || '';
    const ownerNames = userNamesById.get(uid || oid) || new Set();
    const authorFieldMatchedCharacterId = characterByName.get(rawAuthorId) || '';
    if (rawAuthorId === 'user' && (uid || oid) && !nameMatchedCharacterId) {
      authorId = uid || oid;
    } else if (authorFieldMatchedCharacterId) {
      authorId = authorFieldMatchedCharacterId;
    } else if (nameMatchedCharacterId
      && (!authorId
        || (authorId === (uid || oid) && !ownerNames.has(authorName))
        || (!characterIds.has(authorId) && !userIds.has(authorId)))) {
      authorId = nameMatchedCharacterId;
    }
    let nextUserId = '';
    if (!uid && !oid) nextUserId = 'guest';
    else if (!uid && oid) nextUserId = oid;
    else if (uid && !oid) nextUserId = uid;
    else if (uid && oid && uid !== oid) nextUserId = uid;
    else nextUserId = uid;
    // 旧版从全局通讯录抽作者：若作者只属于一个用户档位，按其真实会话归档。
    const authorSlots = slotsByCharacter.get(authorId);
    if (authorSlots?.size === 1) nextUserId = [...authorSlots][0];
    const normalized = normalizeMomentPost({
      ...row,
      authorId,
      userId: nextUserId,
      ownerUserId: nextUserId,
      metadata: {
        ...(row.metadata || {}),
        ...(needsUnknownAuthorMemoryRepair ? { authorIdentityRepaired: true } : {}),
      },
    });
    const commentsChanged = JSON.stringify(row.comments || []) !== JSON.stringify(normalized.comments || []);
    if (uid === nextUserId && oid === nextUserId
      && authorId === rawAuthorId
      && !needsUnknownAuthorMemoryRepair
      && !commentsChanged) continue;
    await db.putRecord('momentsPosts', normalized);
    await syncMomentPostMemory(normalized, nextUserId).catch(() => {});
    fixed += 1;
  }
  await db.put('settings', {
    key: MOMENTS_OWNERSHIP_HYGIENE_KEY,
    value: MOMENTS_OWNERSHIP_HYGIENE_VERSION,
  }).catch(() => {});
  return fixed;
}

export async function ensureMomentsOwnershipHygiene() {
  // 并发进入只合并同一轮；完成后释放内存 Promise。这样用户先打开朋友圈、再导入
  // 带旧迁移标记的完整备份时，下次进入仍会重读 settings 并真正修复，而不是被本次
  // 启动里已经 resolve 的 Promise 永久短路。正常进入只多读一个 settings 键。
  if (!momentsOwnershipHygienePromise) {
    const pending = runMomentsOwnershipHygiene();
    momentsOwnershipHygienePromise = pending;
    const release = () => {
      if (momentsOwnershipHygienePromise === pending) momentsOwnershipHygienePromise = null;
    };
    pending.then(release, release);
  }
  return momentsOwnershipHygienePromise;
}

/**
 * 生成链路不能只相信 put 已 resolve：旧 WebView/恢复备份后的索引可能暂时漏行。
 * 按本批主键回读并核对，调用方只有拿到完整结果后才可以提示“生成成功”。
 */
export async function confirmMomentPostsForUser(userId, insertedPosts = []) {
  const expectedIds = [...new Set((Array.isArray(insertedPosts) ? insertedPosts : [])
    .map((post) => String(typeof post === 'string' ? post : post?.id || '').trim())
    .filter(Boolean))];
  if (!expectedIds.length) return [];
  const stored = await listMomentPostsForUser(userId, { requiredIds: expectedIds });
  const storedById = new Map(stored.map((post) => [String(post?.id || '').trim(), post]));
  const confirmed = expectedIds.map((id) => storedById.get(id)).filter(Boolean);
  if (confirmed.length !== expectedIds.length) {
    const error = new Error(`已写入 ${expectedIds.length} 条动态，但列表只回读到 ${confirmed.length} 条`);
    error.code = 'moments-write-readback-mismatch';
    throw error;
  }
  return confirmed;
}

async function listMomentPostsForAuthor(userId, authorId) {
  const aid = String(authorId || '').trim();
  if (!aid) return [];
  return (await listMomentPostsForUser(userId))
    .filter((post) => String(post.authorId || '').trim() === aid);
}

async function saveMomentPost(post) {
  const normalized = normalizeMomentPost(post || {});
  await db.putRecord('momentsPosts', normalized);
  return normalized;
}

/**
 * 赞和评论会直接从 momentsPosts 进入聊天上下文，而独立的朋友圈
 * 记忆只保留帖子本身、可见性和当事人。互动变更时不要重扫角色、
 * 重写 memory/fact，否则移动端要等整条记忆链完成才能刷新按钮。
 */
export function momentPostMemorySignature(post = {}) {
  const normalized = normalizeMomentPost(post || {});
  const {
    likes: _likes,
    likesIds: _likesIds,
    comments: _comments,
    ...memoryRelevant
  } = normalized;
  return JSON.stringify(memoryRelevant);
}

export async function deleteMomentPost(postId, userId = '') {
  const id = String(postId || '').trim();
  if (!id) return;
  const row = await db.getRecord('momentsPosts', id).catch(() => null);
  await db.deleteRecord('momentsPosts', id);
  await removeMomentPostMemory(id, String(userId || row?.userId || '').trim());
}

export async function putMomentPost(post, userId) {
  const forcedUserId = String(userId || post?.userId || post?.ownerUserId || '').trim();
  if (!forcedUserId) {
    throw new Error('朋友圈写入缺少用户档位');
  }
  const normalized = normalizeMomentPost({
    ...post,
    userId: forcedUserId,
    ownerUserId: forcedUserId,
  });
  const existing = normalized.id
    ? await db.getRecord('momentsPosts', normalized.id).catch(() => null)
    : null;
  // 禁止用同一 id 把别档动态「搬」到当前档
  if (existing) {
    const existingUid = String(existing.userId || existing.ownerUserId || '').trim();
    if (existingUid && existingUid !== forcedUserId) {
      throw new Error('朋友圈动态归属档位冲突，已跳过覆盖');
    }
  }
  await saveMomentPost(normalized);
  const memoryChanged = !existing
    || momentPostMemorySignature(existing) !== momentPostMemorySignature(normalized);
  if (memoryChanged) await syncMomentPostMemory(normalized, normalized.userId).catch(() => {});
  if (!existing
    && normalized.userId
    && String(normalized.authorId || '').trim() === normalized.userId
    && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('user-moment-published', {
      detail: { post: normalized, userId: normalized.userId },
    }));
  }
  return normalized;
}

export function buildMomentChatBundleMetadata(post) {
  const items = [{
    senderName: post.authorName || '好友',
    type: 'text',
    content: String(post.content || '').slice(0, 300),
  }];
  if (post.postKind === 'chat_share' && Array.isArray(post.chatShare?.lines) && post.chatShare.lines.length) {
    items.push({
      senderName: post.chatShare?.title || '聊天记录',
      type: 'text',
      content: post.chatShare.lines.join('\n').slice(0, 420),
    });
  }
  return {
    bundleTitle: `朋友圈 · ${post.authorName || '好友'}`,
    bundleSummary: String(post.content || '').slice(0, 80) || '查看朋友圈',
    source: '朋友圈',
    fromChatLabel: '朋友圈',
    items: [...items],
    bundleItems: [...items],
  };
}
