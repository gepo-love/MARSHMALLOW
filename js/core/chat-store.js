import * as db from './db.js';
import {
  createChat,
  createPrivateChat,
  createMessage,
  normalizeGroupUserPresence,
} from '../models/chat.js';
import { getReplyContentPreview, previewFromMessage, isPreviewCandidateMessage, isAnonymousChat, isStreamerSourcedChat } from './chat-helpers.js';
import { plotDirectiveConfirmsAnonymousUserIdentity } from './anonymous-chat.js';
import { deleteEventMemoriesForChat, deleteEventMemoriesForStoryCard } from './memory/event-memory.js';
import { deleteMemoryFactsForChat } from './memory/memory-facts.js';
import {
  deleteSharedKnowledgeByChat,
  deleteSharedKnowledgeByMessageIds,
} from './memory/shared-event-knowledge.js';
import { isChatStreaming } from './chat/chat-stream-session.js';
import { deleteChatCharState, rewindCharStateForAiRound } from './chat/character-state.js';
import {
  normalizePsychologicalContinuity,
  psychologicalContinuityFingerprint,
  psychologicalContinuityKey,
  PSYCHOLOGICAL_CONTINUITY_ROLLBACK_NONCE_FIELD,
  rewindPsychologicalContinuityForAiRound,
  rewindPsychologicalContinuityForAiRoundsWithRollback,
  runPsychologicalContinuityExclusive,
} from './chat/psychological-continuity.js';
import { deleteEphemeralNpcsForChat } from './anonymous-npc.js';
import { loadRelationshipNetwork } from './relationship-network.js';
import { recordAcquaintance } from './acquaintance-ledger.js';
import { chatPrefsKey, getChatBlockedState, loadChatPrefs, patchChatPrefs } from './chat-block-state.js';
import { isStrangerInterceptChat } from './stranger-thread-model.js';
import { getNowForUser, getTimeMode, TIME_MODE_REAL } from './time-mode.js';
import { resolveCharacterGroupId } from './contact-groups.js';
import {
  canPhoneCharacterIdsKnowEachOther,
  checkPhoneSocialParticipantIds,
  hasRelationshipNetworkOverride,
} from './phone-social-eligibility.js';
import { attachReceipts, createChatRoundReceipt } from './chat/chat-round-receipt.js';
import { isExplicitRelationshipObserverGroup } from './chat/chat-round-gate.js';
import {
  reconcileMemoryVectorsForScope,
  enqueueVectorSource,
} from './memory/memory-vectors.js';
import { shouldSuppressDeletedMemory } from './memory/memory-deletion-guard.js';
import { deleteMessageDerivedMemoryArtifacts } from './memory/message-derived-memory.js';
import { clearCharacterLiveStateForChat } from './character-live-state.js';
import {
  chatMemoryResetStateKey,
  markChatMemoryReset,
} from './memory/chat-memory-reset-state.js';
import {
  chatWallpaperNeedsCompaction,
  chatWallpaperNeedsHydration,
  compactChatWallpaperReference,
  hydrateChatWallpaperReference,
} from './chat-wallpaper-assets.js';

export { previewFromMessage };

export async function bumpChatUnread(chatId, delta = 1) {
  const id = String(chatId || '').trim();
  const amount = Math.max(0, Math.floor(Number(delta) || 0));
  if (!id || !amount) return id ? getChat(id) : null;
  const result = await db.updateRecord('chats', id, (current) => {
    if (!current) return null;
    return {
      ...current,
      unread: Math.max(0, Math.floor(Number(current.unread) || 0)) + amount,
    };
  });
  return result.record || null;
}

export async function clearChatUnread(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const result = await db.updateRecord('chats', id, (current) => {
    if (!current || !Math.max(0, Math.floor(Number(current.unread) || 0))) return null;
    return { ...current, unread: 0 };
  });
  return result.record || null;
}

export async function listAnonymousChatsForUser(userId) {
  const rows = await listChatsForUser(userId);
  // 主播私聊/粉丝群单独收在主播空间里，不混进匿名聊天室大厅列表
  return rows.filter((c) => isAnonymousChat(c) && !isStreamerSourcedChat(c));
}

export async function listChatsForUser(userId) {
  const id = String(userId || '').trim();
  if (!id) return [];
  const rows = await db.getAllByIndex('chats', 'userId', id);
  const normalized = (Array.isArray(rows) ? rows : []).map((chat) => normalizeGroupUserPresence(chat));
  const repaired = normalized.filter((chat, index) => chat !== rows[index]);
  if (repaired.length) {
    await Promise.all(repaired.map((chat) => db.updateRecord(
      'chats',
      chat.id,
      (current) => normalizeGroupUserPresence(current),
    ).catch(() => null)));
  }
  return normalized.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

export async function getChat(chatId) {
  const stored = await db.getRecord('chats', String(chatId || '').trim());
  const chat = normalizeGroupUserPresence(stored);
  if (chat && chat !== stored) {
    await db.updateRecord('chats', chat.id, (current) => normalizeGroupUserPresence(current)).catch(() => null);
  }
  return chatWallpaperNeedsHydration(chat) ? hydrateChatWallpaperReference(chat) : chat;
}

/**
 * 会话必须属于当前档位。极老数据可能没有 userId，只在明确允许时兼容；
 * 一旦存在归属值，任何旧路由、返回栈或预取缓存都不得把别档会话交给当前用户。
 */
export function chatBelongsToUserSlot(chat, userId, { allowLegacyUnscoped = true } = {}) {
  const uid = String(userId || '').trim();
  const ownerId = String(chat?.userId || '').trim();
  if (!chat || !uid) return false;
  if (!ownerId) return allowLegacyUnscoped;
  return ownerId === uid;
}

export async function saveChat(chat) {
  if (!chat?.id) throw new Error('chat.id required');
  const normalized = normalizeGroupUserPresence(chat);
  if (normalized !== chat) {
    chat.participants = normalized.participants;
    chat.groupSettings = normalized.groupSettings;
  }
  const stored = chatWallpaperNeedsCompaction(normalized)
    ? await compactChatWallpaperReference(normalized)
    : normalized;
  await db.putRecord('chats', stored);
  return chatWallpaperNeedsHydration(stored)
    ? hydrateChatWallpaperReference(stored)
    : stored;
}

/**
 * 会话描述和剧情提示历史上分别存在 metadata / groupSettings 两套字段。
 * 用户手动编辑时从最新记录原子合并，并同步兼容字段，避免旧快照或旧字段把新值覆盖回去。
 */
export async function updateChatDirectives(chatId, patch = {}) {
  const chat = await getChat(chatId);
  if (!chat) throw new Error('会话不存在');
  const metadata = { ...(chat.metadata || {}) };
  const groupSettings = { ...(chat.groupSettings || {}) };
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
    const description = String(patch.description ?? '').trim();
    metadata.description = description;
    metadata.descriptionEditedByUser = true;
    if (chat.type === 'group') groupSettings.description = description;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'plotDirective')) {
    const plotDirective = String(patch.plotDirective ?? '').trim();
    metadata.plotDirective = plotDirective;
    metadata.plotDirectiveEditedByUser = true;
    if (isAnonymousChat(chat) && plotDirectiveConfirmsAnonymousUserIdentity(plotDirective)) {
      metadata.anonymousUserIdentityKnown = true;
      metadata.anonymousUserIdentityKnownSource = 'plot_directive';
      metadata.anonymousUserIdentityKnownAt = Date.now();
      if (String(metadata.mainChatMemoryInject || '').trim() !== 'off') {
        metadata.mainChatMemoryInject = 'merged';
      }
    }
    if (chat.type === 'group') groupSettings.plotDirective = plotDirective;
  }
  return saveChat({ ...chat, metadata, groupSettings });
}

export const CHAT_FUTURE_DRIFT_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * 单个会话若混入一条明显晚于世界钟的消息，后续的单调时间保护会持续沿用这个未来时间。
 * 这里规划“世界钟之后”的尾段回拨；虚拟时间模式下仅在调用方明确处理手动回拨时启用。
 */
export function planChatFutureTimestampRepair(
  messages = [],
  worldNow = Date.now(),
  toleranceMs = CHAT_FUTURE_DRIFT_TOLERANCE_MS,
) {
  const now = Number(worldNow);
  if (!Number.isFinite(now) || now <= 0) return [];
  const tolerance = Math.max(0, Number(toleranceMs) || 0);
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((message) => (
      message?.id
      && !message.deleted
      && Number.isFinite(Number(message.timestamp))
      && Number(message.timestamp) > 0
    ));
  const latestVisible = rows.reduce((latest, message) => (
    Math.max(latest, Number(message.timestamp))
  ), 0);
  if (latestVisible <= now + tolerance) return [];

  const futureRows = rows
    .filter((message) => Number(message.timestamp) > now)
    .sort((a, b) => (
      Number(a.timestamp) - Number(b.timestamp)
      || String(a.id).localeCompare(String(b.id))
    ));
  if (!futureRows.length) return [];
  const latestFuture = Number(futureRows[futureRows.length - 1].timestamp);
  const latestSafe = rows.reduce((latest, message) => {
    const timestamp = Number(message.timestamp);
    return timestamp <= now ? Math.max(latest, timestamp) : latest;
  }, 0);
  const shift = latestFuture - now;
  const shiftedFirst = Number(futureRows[0].timestamp) - shift;

  if (shiftedFirst > latestSafe) {
    let previous = latestSafe;
    return futureRows.map((message) => {
      const timestamp = Math.max(previous + 1, Number(message.timestamp) - shift);
      previous = timestamp;
      return { ...message, timestamp };
    });
  }

  // 异常尾段整体平移后若会撞上最后一条正常消息，就把它们均匀压进正常消息到当前时刻之间。
  // 区间不足时允许最后几条只领先世界钟几毫秒，以保持稳定顺序且不再形成可见的未来日期。
  const end = Math.max(now, latestSafe + futureRows.length);
  const step = Math.max(1, Math.floor((end - latestSafe) / futureRows.length));
  return futureRows.map((message, index) => ({
    ...message,
    timestamp: latestSafe + step * (index + 1),
  }));
}

export async function repairChatFutureTimestampDrift(chatId, userId, options = {}) {
  const cid = String(chatId || '').trim();
  const uid = String(userId || '').trim();
  if (!cid || !uid) return { repaired: false, count: 0 };
  const mode = await getTimeMode(uid);
  if (mode !== TIME_MODE_REAL && options.allowVirtualRollback !== true) {
    return { repaired: false, count: 0 };
  }
  const worldNow = Number(options.worldNow) > 0 ? Number(options.worldNow) : await getNowForUser(uid);
  const knownMessages = Array.isArray(options.knownMessages) ? options.knownMessages : [];
  if (knownMessages.length
    && !planChatFutureTimestampRepair(knownMessages, worldNow).length) {
    return { repaired: false, count: 0 };
  }
  // 命中异常尾段后不再读取整段聊天。长会话里的图片、语音和卡片正文都可能很大，
  // 而修复算法实际只需要“最后一条安全时间”与 worldNow 之后的尾段。
  const [futureRows, latestSafeRows] = await Promise.all([
    db.getAllByIndexRange(
      'messages',
      'chatId_timestamp',
      [cid, worldNow],
      [cid, Number.MAX_SAFE_INTEGER],
      {
        lowerOpen: true,
        direction: 'next',
        filterRecord: (message) => message && !message.deleted,
      },
    ),
    db.getAllByIndexRange(
      'messages',
      'chatId_timestamp',
      [cid, 0],
      [cid, worldNow],
      {
        direction: 'prev',
        limit: 1,
        // 必须在 cursor 继续向前时过滤；若先 limit 再过滤，最近一条 tombstone
        // 会遮住真正的最后一条可见安全消息，改变旧全量读取的修复锚点。
        filterRecord: (message) => message && !message.deleted,
      },
    ),
  ]);
  const repairedMessages = planChatFutureTimestampRepair([
    ...(Array.isArray(latestSafeRows) ? latestSafeRows : []),
    ...(Array.isArray(futureRows) ? futureRows : []),
  ], worldNow);
  if (!repairedMessages.length) return { repaired: false, count: 0 };
  await db.putMany('messages', repairedMessages.map(compactDuplicateInlineMessageMedia));
  await recalcChatPreview(cid);
  return { repaired: true, count: repairedMessages.length };
}

/**
 * 普通聊天消息必须按实际发生顺序单调递增。
 * 用户回拨虚拟时间或后台计划晚到时，沿用较早的世界时间会让新气泡在重载后跳到旧消息前面。
 * 历史补写/插入气泡不应调用此函数，它们需要保留指定的历史位置。
 */
export function clampLiveMessageTimestamp(messages = [], proposedTimestamp = Date.now()) {
  const proposed = Number(proposedTimestamp);
  const safeProposed = Number.isFinite(proposed) && proposed > 0 ? proposed : Date.now();
  const latest = (Array.isArray(messages) ? messages : []).reduce((max, message) => {
    if (!message || message.deleted) return max;
    const timestamp = Number(message.timestamp || 0);
    return Number.isFinite(timestamp) && timestamp > max ? timestamp : max;
  }, 0);
  return latest >= safeProposed ? latest + 1 : safeProposed;
}

function chatMessageCreationTimestamp(message = {}) {
  const explicit = Number(message?.createdAt || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromId = Number(String(message?.id || '').match(/^msg_(\d{10,})_/)?.[1] || 0);
  return Number.isFinite(fromId) && fromId > 0 ? fromId : 0;
}

/**
 * 历史数据可能有完全相同的剧情时间戳。刷新时必须再按真实创建顺序稳定排序，
 * 否则 IndexedDB 的同键游标顺序会把后生成的气泡插进旧气泡中间。
 */
export function compareChatMessageChronology(a = {}, b = {}) {
  return Number(a?.timestamp || 0) - Number(b?.timestamp || 0)
    || chatMessageCreationTimestamp(a) - chatMessageCreationTimestamp(b)
    || String(a?.id || '').localeCompare(String(b?.id || ''));
}

export function resolveChatRoundBaseTimestamp(messages = [], proposedTimestamp = Date.now(), gapFillWindow = null) {
  const gapStart = Number(gapFillWindow?.startTs || 0);
  const gapEnd = Number(gapFillWindow?.endTs || 0);
  return gapStart > 0 && gapEnd > gapStart
    ? proposedTimestamp
    : clampLiveMessageTimestamp(messages, proposedTimestamp);
}

export function rebaseLiveMessageBatch(existingMessages = [], batch = [], gapFillWindow = null) {
  const rows = Array.isArray(batch) ? batch : [];
  if (!rows.length) return rows;
  const gapStart = Number(gapFillWindow?.startTs || 0);
  const gapEnd = Number(gapFillWindow?.endTs || 0);
  if (gapStart > 0 && gapEnd > gapStart) return rows;
  const firstTimestamp = Number(rows[0]?.timestamp || 0);
  const rebasedFirst = clampLiveMessageTimestamp(existingMessages, firstTimestamp);
  const delta = rebasedFirst - firstTimestamp;
  if (!(delta > 0)) return rows;
  return rows.map((message) => ({
    ...message,
    timestamp: Number(message?.timestamp || firstTimestamp) + delta,
  }));
}

export function compactDuplicateInlineMessageMedia(message) {
  if (!message || typeof message !== 'object' || message.type !== 'image') return message;
  const content = String(message.content || '');
  const metadata = message.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  if (!/^data:image\//i.test(content) || String(metadata.url || '') !== content) return message;
  return { ...message, metadata: { ...metadata, url: '' } };
}

const AI_ROUND_ARTIFACT_CACHE_PREFIX = '__mm_ai_round_artifacts_v1__:';
const pendingAiRoundArtifactIndex = new Map();
let aiRoundArtifactFlushTimer = 0;

function aiRoundArtifactCacheKey(sourceRoundId = '') {
  return `${AI_ROUND_ARTIFACT_CACHE_PREFIX}${encodeURIComponent(String(sourceRoundId || '').trim())}`;
}

function mergeAiRoundArtifactEntry(target, message) {
  const sourceRoundId = String(message?.metadata?.sourceAiRoundId || '').trim();
  const id = String(message?.id || '').trim();
  const chatId = String(message?.chatId || '').trim();
  if (!sourceRoundId || !id || !chatId) return;
  const entry = target.get(sourceRoundId) || { complete: false, items: new Map() };
  entry.items.set(id, { id, chatId });
  target.set(sourceRoundId, entry);
}

async function flushAiRoundArtifactIndex() {
  aiRoundArtifactFlushTimer = 0;
  const batch = [...pendingAiRoundArtifactIndex.entries()];
  batch.forEach(([sourceRoundId, entry]) => {
    if (pendingAiRoundArtifactIndex.get(sourceRoundId) === entry) {
      pendingAiRoundArtifactIndex.delete(sourceRoundId);
    }
  });
  for (const [sourceRoundId, liveEntry] of batch) {
    const key = aiRoundArtifactCacheKey(sourceRoundId);
    try {
      const stored = await db.getCacheOnlySetting(key);
      const previous = stored?.value && typeof stored.value === 'object' ? stored.value : {};
      const items = new Map((Array.isArray(previous.items) ? previous.items : [])
        .map((item) => [String(item?.id || ''), item])
        .filter(([id]) => id));
      liveEntry.items.forEach((item, id) => items.set(id, item));
      await db.putCacheOnlySetting(key, {
        version: 1,
        sourceRoundId,
        complete: previous.complete === true || liveEntry.complete === true,
        items: [...items.values()],
        updatedAt: Date.now(),
      });
    } catch (_) {
      // 这是可重建的加速索引；写失败时保留原来的全量扫描兜底。
      const retry = pendingAiRoundArtifactIndex.get(sourceRoundId) || { complete: false, items: new Map() };
      liveEntry.items.forEach((item, id) => retry.items.set(id, item));
      retry.complete = retry.complete === true || liveEntry.complete === true;
      pendingAiRoundArtifactIndex.set(sourceRoundId, retry);
    }
  }
  if (pendingAiRoundArtifactIndex.size && !aiRoundArtifactFlushTimer) {
    aiRoundArtifactFlushTimer = setTimeout(() => { void flushAiRoundArtifactIndex(); }, 1500);
  }
}

function trackAiRoundCascadeMessages(messages = []) {
  for (const message of Array.isArray(messages) ? messages : [messages]) {
    mergeAiRoundArtifactEntry(pendingAiRoundArtifactIndex, message);
  }
  if (pendingAiRoundArtifactIndex.size && !aiRoundArtifactFlushTimer) {
    aiRoundArtifactFlushTimer = setTimeout(() => { void flushAiRoundArtifactIndex(); }, 1500);
  }
}

/** 标记该轮同步产生的跨窗消息已经收齐；后续重 roll 可跳过逐聊天扫描。 */
export function markAiRoundCascadeIndexComplete(sourceRoundId = '') {
  const id = String(sourceRoundId || '').trim();
  if (!id) return;
  const entry = pendingAiRoundArtifactIndex.get(id) || { complete: false, items: new Map() };
  entry.complete = true;
  pendingAiRoundArtifactIndex.set(id, entry);
  if (!aiRoundArtifactFlushTimer) {
    aiRoundArtifactFlushTimer = setTimeout(() => { void flushAiRoundArtifactIndex(); }, 1500);
  }
}

async function readIndexedAiRoundCascadeMessages(roots = new Set()) {
  const items = new Map();
  for (const sourceRoundId of roots) {
    const stored = await db.getCacheOnlySetting(aiRoundArtifactCacheKey(sourceRoundId)).catch(() => null);
    const live = pendingAiRoundArtifactIndex.get(sourceRoundId);
    const complete = stored?.value?.complete === true || live?.complete === true;
    if (!complete) return null;
    for (const item of Array.isArray(stored?.value?.items) ? stored.value.items : []) {
      const id = String(item?.id || '').trim();
      if (id) items.set(id, item);
    }
    live?.items?.forEach((item, id) => items.set(id, item));
  }
  if (!items.size) return [];
  return (await db.getMany('messages', [...items.keys()])).filter(Boolean);
}

export async function saveMessage(message) {
  if (!message?.id) throw new Error('message.id required');
  const stored = compactDuplicateInlineMessageMedia(message);
  await db.putRecord('messages', stored);
  trackAiRoundCascadeMessages([stored]);
  void recordChatAcquaintances(message.chatId);
  void lightChatSparkDayFromMessage(message).catch(() => {});
  return stored;
}

export async function saveMessages(messages = []) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (!list.length) return 0;
  const stored = list.map(compactDuplicateInlineMessageMedia);
  await db.putMany('messages', stored);
  trackAiRoundCascadeMessages(stored);
  [...new Set(list.map((row) => row?.chatId).filter(Boolean))]
    .forEach((chatId) => { void recordChatAcquaintances(chatId); });
  // 一批回复只为每个聊天读写一次火花日期表；补历史跨多天时也一次 union 后落库，
  // 避免多个异步点亮互相覆盖同一个 chatPrefs.sparkDayKeys。
  void lightChatSparkDaysFromMessages(list).catch(() => {});
  return list.length;
}

async function recordChatAcquaintances(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  try {
    const chat = await getChat(id);
    if (!chat || isAnonymousChat(chat)) return;
    const participants = (chat.participants || [])
      .filter((pid) => pid && pid !== 'user' && pid !== 'system');
    if (participants.length < 2) return;
    const [{ listCharacters }, relationshipNetwork] = await Promise.all([
      import('./character-store.js'),
      loadRelationshipNetwork(chat.userId).catch(() => null),
    ]);
    const characters = await listCharacters({ includeInternal: true }).catch(() => []);
    const byId = new Map(characters.map((row) => [String(row?.id || ''), row]));
    for (let i = 0; i < participants.length; i += 1) {
      for (let j = i + 1; j < participants.length; j += 1) {
        const leftId = participants[i];
        const rightId = participants[j];
        const left = byId.get(leftId);
        const right = byId.get(rightId);
        if (!left || !right) continue;
        const sameGroup = resolveCharacterGroupId(left) === resolveCharacterGroupId(right);
        const networkOverride = hasRelationshipNetworkOverride(
          leftId,
          rightId,
          relationshipNetwork,
        );
        if (!sameGroup && !networkOverride) continue;
        await recordAcquaintance(leftId, rightId, {
          level: 'met',
          label: chat.type === 'group' ? '曾在同一群聊互动' : '曾在同一聊天窗口互动',
          source: 'rule',
        });
      }
    }
  } catch (_) {}
}

export async function deleteMessage(messageId, { recalcPreview = true } = {}) {
  const id = String(messageId || '').trim();
  if (!id) return;
  const msg = await db.getRecord('messages', id);
  const chatRow = msg?.chatId ? await db.getRecord('chats', msg.chatId).catch(() => null) : null;
  if (msg?.chatId) await markChatMemoryReset(msg.chatId);
  await db.deleteRecord('messages', id);
  const cleanupTasks = [deleteSharedKnowledgeByMessageIds([id])];
  if (msg?.type === 'storyCard') cleanupTasks.push(deleteEventMemoriesForStoryCard(msg));
  if (msg?.chatId && chatRow?.userId) {
    cleanupTasks.push(
      deleteMessageDerivedMemoryArtifacts({
        userId: chatRow.userId,
        chatId: msg.chatId,
        messageIds: [id],
      }),
      import('./ensemble-mode.js')
        .then((mod) => mod.reconcileEnsembleChatAfterMessageDeletion?.(chatRow.userId, msg.chatId)),
    );
  }
  await Promise.all(cleanupTasks);
  if (recalcPreview && msg?.chatId) await recalcChatPreview(msg.chatId);
}

export async function deleteMessagesWithAiRoundId(chatId, aiRoundId, {
  deleteSystem = false,
  psychologicalRollbackToken = null,
  skipPsychologicalRewind = false,
} = {}) {
  if (!chatId || !aiRoundId) return 0;
  const [{ undoEmojiReactionsForAiRound }, { undoRecallsForAiRound }, all, chatRow] = await Promise.all([
    import('./chat/reactions.js'),
    import('./chat/apply-recall-events.js'),
    db.getAllByIndex('messages', 'chatId', chatId),
    db.getRecord('chats', chatId).catch(() => null),
  ]);
  // 撤销表情反应、回滚角色状态和最终的批量删除互不依赖，并行跑省一段串行等待；
  // 重 roll 时上一轮气泡「残留几秒才消失」的卡顿，很大一部分就是这里原来逐条
  // await 单独开事务删除攒出来的。
  const ids = all
    // 本轮「发出又被本轮 recall 撤回」的消息也属于本轮产物，重 roll 时一并删除；
    // 用户手动撤回等其它撤回态仍然跳过。
    .filter((m) => m && !m.deleted
      && (!m.recalled || m.metadata?.recalledByAiRoundId === aiRoundId)
      && m.metadata?.aiRoundId === aiRoundId
      && m.senderId !== 'user' && !m.metadata?.userComposedAsCharacter
      && (deleteSystem || m.senderId !== 'system'))
    .map((m) => m.id);
  const psychologicalRewind = chatRow?.userId && !skipPsychologicalRewind
    ? rewindPsychologicalContinuityForAiRound({
      userId: chatRow.userId,
      chatId,
    }, aiRoundId, {
      rollbackNonce: psychologicalRollbackToken?.operationId,
    })
    : Promise.resolve(null);
  const [, , , psychologicalResult] = await Promise.all([
    undoEmojiReactionsForAiRound(chatId, aiRoundId),
    undoRecallsForAiRound(chatId, aiRoundId).catch(() => {}),
    rewindCharStateForAiRound(chatId, aiRoundId).catch(() => {}),
    psychologicalRollbackToken ? psychologicalRewind : psychologicalRewind.catch(() => null),
    ids.length ? db.deleteMany('messages', ids) : Promise.resolve(0),
  ]);
  if (psychologicalRollbackToken && psychologicalResult?.rewound === true) {
    const nextRevision = Number(psychologicalResult.runtime?.revision || 0);
    const expectedNextRevision = Number(psychologicalRollbackToken.expectedRevision || 0) + 1;
    if (!Number.isSafeInteger(nextRevision) || nextRevision !== expectedNextRevision) {
      psychologicalRollbackToken.safe = false;
      psychologicalRollbackToken.conflictReason = 'rewind-revision-gap';
    } else {
      psychologicalRollbackToken.expectedRevision = nextRevision;
      psychologicalRollbackToken.expectedFingerprint = psychologicalContinuityFingerprint(
        psychologicalResult.runtime,
        { userId: chatRow.userId, chatId },
      );
      psychologicalRollbackToken.expectedNonce = psychologicalRollbackToken.operationId;
      psychologicalRollbackToken.rewindCount = Number(psychologicalRollbackToken.rewindCount || 0) + 1;
    }
  }
  if (ids.length) {
    await Promise.all([
      recalcChatPreview(chatId),
      chatRow?.userId
        ? deleteMessageDerivedMemoryArtifacts({
          userId: chatRow.userId,
          chatId,
          messageIds: ids,
        })
        : Promise.resolve({ memories: 0, facts: 0, events: 0 }),
      deleteSharedKnowledgeByMessageIds(ids),
    ]);
  }
  return ids.length;
}

export async function rewindChatPsychologicalContinuityForReroll(chatId, aiRoundIds = []) {
  const id = String(chatId || '').trim();
  const roundIds = (Array.isArray(aiRoundIds) ? aiRoundIds : [aiRoundIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!id || !roundIds.length) {
    return { rewound: false, reason: 'missing-round-id', rollbackToken: null };
  }
  const chatRow = await db.getRecord('chats', id).catch(() => null);
  const userId = String(chatRow?.userId || '').trim();
  if (!userId) return { rewound: false, reason: 'missing-user-id', rollbackToken: null };
  return rewindPsychologicalContinuityForAiRoundsWithRollback({ userId, chatId: id }, roundIds);
}

/**
 * 重 roll 在请求前会先撤销旧轮心理状态。这里保留一份会话级快照，并在删除完成后
 * 记录期望 revision；若新请求失败，只在心理账本期间没有其它写入时原子恢复，避免
 * 覆盖另一标签页或后台刚完成的合法更新。
 */
export async function captureChatPsychologicalContinuityRollback(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const [chatRow, row] = await Promise.all([
    db.getRecord('chats', id).catch(() => null),
    db.getRecord('settings', psychologicalContinuityKey(id)).catch(() => null),
  ]);
  const userId = String(chatRow?.userId || '').trim();
  const raw = row?.value && typeof row.value === 'object' ? row.value : null;
  if (!userId || !raw) return null;
  if (String(raw.userId || '').trim() !== userId || String(raw.chatId || '').trim() !== id) return null;
  const runtime = normalizePsychologicalContinuity(raw, { userId, chatId: id });
  const operationId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `psych-reroll-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    version: 1,
    operationId,
    userId,
    chatId: id,
    before: runtime,
    beforeRevision: Number(runtime.revision || 0),
    expectedRevision: Number(runtime.revision || 0),
    expectedFingerprint: psychologicalContinuityFingerprint(runtime, { userId, chatId: id }),
    expectedNonce: operationId,
    rewindCount: 0,
    safe: true,
    sealed: false,
  };
}

export async function sealChatPsychologicalContinuityRollback(token) {
  if (
    !token?.before
    || !token.operationId
    || !token.userId
    || !token.chatId
    || token.safe !== true
    || !Number.isSafeInteger(token.beforeRevision)
    || !Number.isSafeInteger(token.expectedRevision)
    || token.beforeRevision < 0
    || token.expectedRevision < 0
    || typeof token.expectedFingerprint !== 'string'
    || !token.expectedFingerprint
    || token.expectedNonce !== token.operationId
  ) return null;
  if (Number(token.before?.revision ?? Number.NaN) !== token.beforeRevision) return null;
  return runPsychologicalContinuityExclusive(token.chatId, async () => {
    const key = psychologicalContinuityKey(token.chatId);
    let sealedToken = null;
    const result = await db.updateRecord('settings', key, (row) => {
      const raw = row?.value && typeof row.value === 'object' ? row.value : null;
      if (!raw) return undefined;
      if (
        String(raw.userId || '').trim() !== token.userId
        || String(raw.chatId || '').trim() !== token.chatId
      ) return undefined;
      const current = normalizePsychologicalContinuity(raw, {
        userId: token.userId,
        chatId: token.chatId,
      });
      if (Number(current.revision ?? Number.NaN) !== token.expectedRevision) return undefined;
      const fingerprint = psychologicalContinuityFingerprint(current, {
        userId: token.userId,
        chatId: token.chatId,
      });
      if (fingerprint !== token.expectedFingerprint) return undefined;
      const storedNonce = String(raw[PSYCHOLOGICAL_CONTINUITY_ROLLBACK_NONCE_FIELD] || '');
      if (Number(token.rewindCount || 0) > 0 && storedNonce !== token.expectedNonce) return undefined;
      sealedToken = { ...token, expectedNonce: token.operationId, sealed: true };
      return {
        key,
        value: {
          ...current,
          [PSYCHOLOGICAL_CONTINUITY_ROLLBACK_NONCE_FIELD]: token.operationId,
        },
      };
    });
    return result?.updated === true ? sealedToken : null;
  });
}

export async function restoreChatPsychologicalContinuityRollback(token, { now = Date.now() } = {}) {
  if (
    !token?.before
    || token.sealed !== true
    || token.safe !== true
    || !token.operationId
    || !token.userId
    || !token.chatId
    || !Number.isSafeInteger(token.beforeRevision)
    || !Number.isSafeInteger(token.expectedRevision)
    || token.beforeRevision < 0
    || token.expectedRevision < 0
    || typeof token.expectedFingerprint !== 'string'
    || !token.expectedFingerprint
    || token.expectedNonce !== token.operationId
    || Number(token.before?.revision ?? Number.NaN) !== token.beforeRevision
  ) {
    return { restored: false, reason: 'invalid-token' };
  }
  return runPsychologicalContinuityExclusive(token.chatId, async () => {
    const key = psychologicalContinuityKey(token.chatId);
    let reason = 'revision-conflict';
    const result = await db.updateRecord('settings', key, (row) => {
      const raw = row?.value && typeof row.value === 'object' ? row.value : null;
      if (!raw) {
        reason = 'runtime-missing';
        return undefined;
      }
      if (
        String(raw.userId || '').trim() !== token.userId
        || String(raw.chatId || '').trim() !== token.chatId
      ) {
        reason = 'scope-mismatch';
        return undefined;
      }
      const current = normalizePsychologicalContinuity(raw, {
        userId: token.userId,
        chatId: token.chatId,
      });
      if (Number(current.revision ?? Number.NaN) !== Number(token.expectedRevision)) return undefined;
      const currentFingerprint = psychologicalContinuityFingerprint(current, {
        userId: token.userId,
        chatId: token.chatId,
      });
      if (currentFingerprint !== token.expectedFingerprint) {
        reason = 'fingerprint-conflict';
        return undefined;
      }
      if (String(raw[PSYCHOLOGICAL_CONTINUITY_ROLLBACK_NONCE_FIELD] || '') !== token.expectedNonce) {
        reason = 'nonce-conflict';
        return undefined;
      }
      const restored = normalizePsychologicalContinuity({
        ...token.before,
        revision: Number(current.revision || 0) + 1,
        updatedAt: Number(now) || Date.now(),
      }, {
        userId: token.userId,
        chatId: token.chatId,
      });
      reason = 'restored';
      return { key, value: restored };
    });
    return {
      restored: result?.updated === true,
      reason: result?.updated === true ? 'restored' : reason,
      runtime: result?.updated === true ? result.record?.value : null,
    };
  });
}

/**
 * 捕获一批重 roll 失败时可能需要放回的消息及其会话实例代次。
 * 浏览器使用同一只读事务取得 chats/settings/messages 快照；原生主库只有在缓存
 * 序号可证明一致、且具备批量写能力时才允许调用方继续删除旧轮。
 */
export async function captureAiRoundMessageRestoreBundle(messages = [], userId = '') {
  const uid = String(userId || '').trim();
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.id && message?.chatId);
  const chatIds = [...new Set(rows.map((message) => String(message.chatId || '').trim()).filter(Boolean))];
  if (!uid || !rows.length || !chatIds.length) {
    return {
      supported: !!uid,
      captured: rows.length === 0,
      reason: rows.length ? 'missing-user-id' : 'empty',
      messages: [],
      scopes: [],
      skippedMessageIds: rows.map((message) => String(message.id)),
    };
  }
  return db.captureGuardedMessageRestore(rows, chatIds.map((chatId) => ({
    chatId,
    userId: uid,
    resetStateKey: chatMemoryResetStateKey(chatId),
  })));
}

/**
 * 删除由某个前台 AI 轮次派生到其它窗口的产物。
 * 只匹配明确的 sourceAiRoundId 或历史前缀轮次，并始终保留用户消息。
 * 返回删除前快照，供重 roll 请求失败时原样恢复。
 */
export async function deleteAiRoundCascadeArtifacts(userId, sourceRoundIds = [], { keepChatIds = [] } = {}) {
  const roots = new Set((Array.isArray(sourceRoundIds) ? sourceRoundIds : [sourceRoundIds])
    .map((id) => String(id || '').trim()).filter(Boolean));
  if (!roots.size) {
    return {
      messages: [],
      chatIds: [],
      deleted: 0,
      userId: String(userId || '').trim(),
      ensembleBackup: null,
      characterLiveStateBackup: null,
      restoreScopes: [],
      restoreCaptureSupported: true,
    };
  }
  const protectedChats = new Set((keepChatIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const snapshots = [];
  const touched = new Set();
  const rootIds = [...roots];
  const indexedRows = await readIndexedAiRoundCascadeMessages(roots);
  const collectMatches = (rows = []) => {
    for (const message of rows || []) {
      if (protectedChats.has(String(message?.chatId || '').trim())) continue;
      if (!message || message.deleted || message.senderId === 'user' || message.metadata?.userComposedAsCharacter) continue;
      const source = String(message.metadata?.sourceAiRoundId || '').trim();
      const round = String(message.metadata?.aiRoundId || '').trim();
      const matched = roots.has(source)
        || rootIds.some((root) => (
          round === `backstage_${root}` || round === `peer_${root}` || round === `relay_${root}`
        ));
      if (!matched) continue;
      snapshots.push(message);
      if (message.chatId) touched.add(message.chatId);
    }
  };
  if (indexedRows !== null) {
    collectMatches(indexedRows);
  } else {
    // 旧版本生成的轮次没有旁路索引，仍保留完整兼容扫描；新轮次只按记录的消息 id
    // 批量读取，不再让一个重 roll 随用户的全部聊天窗口线性变慢。
    const chats = await listChatsForUser(userId);
    for (const chat of chats) {
      if (!chat?.id || protectedChats.has(chat.id)) continue;
      collectMatches(await db.getAllByIndex('messages', 'chatId', chat.id));
    }
  }
  const messageRestoreBundle = snapshots.length
    ? await captureAiRoundMessageRestoreBundle(snapshots, userId)
    : {
      supported: true,
      captured: true,
      messages: [],
      scopes: [],
      skippedMessageIds: [],
    };
  if (snapshots.length && messageRestoreBundle.supported !== true) {
    const error = new Error(`无法安全捕获跨窗重 roll 恢复点：${messageRestoreBundle.reason || 'unsupported'}`);
    error.name = 'RerollAtomicRestoreUnavailableError';
    error.reason = messageRestoreBundle.reason || 'restore-capture-unavailable';
    throw error;
  }
  // 群像图和跨窗消息一样，都是这一轮生成的级联副作用。重 roll 必须在新一轮前
  // 撤销旧轮次；若后续请求失败，调用方会用这里的快照原样恢复。
  const { rollbackEnsembleRounds, restoreEnsembleGraphSnapshot } = await import('./ensemble-mode.js');
  const {
    rollbackCharacterLiveStatesForAiRounds,
    restoreCharacterLiveStateRoundRollback,
  } = await import('./character-live-state.js');
  let liveStateBackup = null;
  let ensemble = { backup: null };
  try {
    liveStateBackup = await rollbackCharacterLiveStatesForAiRounds(userId, [...roots]);
    ensemble = await rollbackEnsembleRounds(userId, [...roots]);
    if (snapshots.length) {
      const deletedMessageIds = snapshots.map((message) => message.id);
      await db.deleteMany('messages', deletedMessageIds);
      await Promise.all([
        ...[...touched].map((chatId) => {
          const chatMessageIds = snapshots
            .filter((message) => String(message?.chatId || '') === chatId)
            .map((message) => message.id);
          return Promise.all([
            recalcChatPreview(chatId),
            deleteMessageDerivedMemoryArtifacts({
              userId,
              chatId,
              messageIds: chatMessageIds,
            }),
          ]);
        }),
        deleteSharedKnowledgeByMessageIds(deletedMessageIds),
      ]);
    }
  } catch (error) {
    await restoreEnsembleGraphSnapshot(userId, ensemble.backup).catch(() => {});
    await restoreCharacterLiveStateRoundRollback(liveStateBackup).catch(() => {});
    throw error;
  }
  return {
    // 只有捕获到有效 chat owner / instance / reset token 的行才允许失败恢复。
    // 已失去 chat 主记录的孤儿产物仍会被清理，但绝不会在未来同 id 会话里复活。
    messages: messageRestoreBundle.messages,
    chatIds: [...touched],
    deleted: snapshots.length,
    userId: String(userId || '').trim(),
    ensembleBackup: ensemble.backup,
    characterLiveStateBackup: liveStateBackup,
    restoreScopes: messageRestoreBundle.scopes,
    restoreCaptureSupported: messageRestoreBundle.supported === true,
    restoreCaptureReason: messageRestoreBundle.reason || '',
  };
}

export async function restoreAiRoundCascadeArtifacts(snapshot = [], options = {}) {
  const payload = Array.isArray(snapshot)
    ? { messages: snapshot, ...options }
    : (snapshot && typeof snapshot === 'object' ? snapshot : {});
  const cascadeRows = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter((message) => message?.id && message.chatId);
  const primaryRows = (Array.isArray(options.primaryMessages) ? options.primaryMessages : [])
    .filter((message) => message?.id && message.chatId);
  const rows = [...primaryRows, ...cascadeRows];
  const restoreScopes = [
    ...(Array.isArray(options.primaryRestoreScopes) ? options.primaryRestoreScopes : []),
    ...(Array.isArray(payload.restoreScopes) ? payload.restoreScopes : []),
  ];
  const messageRestore = await db.restoreGuardedMessages(rows, restoreScopes);
  if (messageRestore.restored !== true) {
    return {
      restored: false,
      reason: messageRestore.reason || 'guarded-message-restore-failed',
      messages: 0,
      messageRestore,
      ensembleRestore: null,
      liveStateRestore: null,
    };
  }
  if (rows.length) {
    trackAiRoundCascadeMessages(rows);
    const chatIds = [...new Set(rows.map((message) => message.chatId))];
    await Promise.all(chatIds.map((chatId) => recalcChatPreview(chatId)));
  }
  let ensembleRestore = null;
  if (payload.ensembleBackup && payload.userId) {
    const { restoreEnsembleGraphSnapshot } = await import('./ensemble-mode.js');
    ensembleRestore = await restoreEnsembleGraphSnapshot(payload.userId, payload.ensembleBackup);
  }
  let liveStateRestore = null;
  if (payload.characterLiveStateBackup) {
    const { restoreCharacterLiveStateRoundRollback } = await import('./character-live-state.js');
    liveStateRestore = await restoreCharacterLiveStateRoundRollback(payload.characterLiveStateBackup);
  }
  return {
    restored: true,
    reason: messageRestore.reason || 'restored',
    messages: rows.length,
    messageRestore,
    ensembleRestore,
    liveStateRestore,
  };
}

export async function updateChatPreview(chatId, preview = '', timestamp) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  const result = await db.updateRecord('chats', id, (current) => {
    if (!current) return null;
    return {
      ...current,
      lastMessage: String(preview || '').slice(0, 120),
      lastActivity: ts,
    };
  });
  return result.record || null;
}

/**
 * Keep-Alive 会保留聊天页的旧 DOM 和内存消息。消息若由后台调度、其它页面或其它
 * 浏览器运行上下文写入，本页收不到当前上下文的 onStoreWrite 通知；恢复页面时需用
 * chats 摘要做一次轻量脏检查，避免“列表有新消息，点进去却还是旧气泡”。
 */
export function shouldReloadCachedThreadMessages({
  freshChat = null,
  cachedMessages = [],
  hasRenderedBubbles = false,
  pendingWrite = false,
  fromNotification = false,
} = {}) {
  if (!hasRenderedBubbles || pendingWrite || fromNotification) return true;
  if (!freshChat) return false;
  if (Number(freshChat.unread || 0) > 0) return true;

  const candidates = (Array.isArray(cachedMessages) ? cachedMessages : [])
    .filter((message) => isPreviewCandidateMessage(message));
  const latest = candidates.reduce((current, message) => (
    !current || Number(message?.timestamp || 0) >= Number(current?.timestamp || 0)
      ? message
      : current
  ), null);
  const cachedTimestamp = Number(latest?.timestamp || 0);
  const freshTimestamp = Number(freshChat.lastActivity || 0);
  if (freshTimestamp > cachedTimestamp) return true;

  const cachedPreview = latest
    ? String(previewFromMessage(latest) || '').slice(0, 120)
    : '';
  const freshPreview = String(freshChat.lastMessage || '').slice(0, 120);
  return freshPreview !== cachedPreview;
}

export async function listMessagesForChat(chatId, limit = 200, options = {}) {
  const id = String(chatId || '').trim();
  if (!id) return [];
  if (limit > 0) {
    return listMessagesPageForChat(id, {
      limit,
      deferHeavyImages: options.deferHeavyImages === true,
    }).then((page) => page.messages);
  }
  const rows = await db.getAllByIndex('messages', 'chatId', id);
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter((m) => m && !m.deleted)
    .sort(compareChatMessageChronology);
  return sorted;
}

export function deferHeavyMediaForDisplay(message, options = {}) {
  return maybeDeferHeavyImageContent(message, {
    deferHeavyImages: true,
    deferImageThreshold: 8192,
    ...options,
  });
}

/**
 * 消息列表为减轻首屏内存会把大图内容替换成 deferredImage/deferredSticker 占位。
 * 识图、灯箱等真正需要像素的链路可按消息 id 定向取回完整记录，避免整页重新加载大图。
 */
export async function hydrateDeferredMediaMessage(message) {
  if (!message?.id) return message;
  const metadata = message.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  if (metadata.deferredImage !== true && metadata.deferredSticker !== true) return message;
  const stored = await db.getRecord('messages', message.id).catch(() => null);
  if (!stored || stored.chatId !== message.chatId || stored.type !== message.type) return message;
  const storedUrl = String(stored.content || stored.metadata?.url || '').trim();
  if (!/^data:image\//i.test(storedUrl) && !/^https?:\/\//i.test(storedUrl)) return message;
  return stored;
}

function maybeDeferHeavyImageContent(message, options = {}) {
  if (!options.deferHeavyImages) return message;
  if (!message || (message.type !== 'image' && message.type !== 'sticker')) return message;
  const content = String(message.content || '');
  const metaUrl = String(message.metadata?.url || '');
  const heavyValue = /^data:image\//i.test(content)
    ? content
    : (/^data:image\//i.test(metaUrl) ? metaUrl : '');
  if (!heavyValue) return message;
  const threshold = Math.max(8192, Number(options.deferImageThreshold || 24000) || 24000);
  if (heavyValue.length < threshold) return message;
  const metadata = { ...(message.metadata || {}) };
  if (/^data:image\//i.test(String(metadata.url || ''))) metadata.url = '';
  if (message.type === 'sticker') {
    metadata.deferredSticker = true;
  } else {
    metadata.deferredImage = true;
    metadata.deferredImageBytes = heavyValue.length;
    metadata.deferredImageSource = 'message-content';
  }
  return {
    ...message,
    content: '',
    metadata,
  };
}

export async function listMessagesPageForChat(chatId, options = {}) {
  const id = String(chatId || '').trim();
  if (!id) return { messages: [], hasMore: false };
  const limit = Math.max(1, Number(options.limit || 100) || 100);
  const beforeTimestamp = Number(options.beforeTimestamp || 0) || 0;
  const upperTs = beforeTimestamp > 0 ? beforeTimestamp : Number.MAX_SAFE_INTEGER;
  const rows = await db.getAllByIndexRange(
    'messages',
    'chatId_timestamp',
    [id, 0],
    [id, upperTs],
    {
      upperOpen: beforeTimestamp > 0,
      direction: 'prev',
      limit: limit + 1,
    },
  );
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter((m) => m && !m.deleted)
    .sort(compareChatMessageChronology);
  const hasMore = sorted.length > limit;
  const messages = (hasMore ? sorted.slice(sorted.length - limit) : sorted)
    .map((m) => maybeDeferHeavyImageContent(m, options));
  return { messages, hasMore };
}

function localDayKey(timestamp = 0) {
  const date = new Date(Number(timestamp || 0));
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 返回某个月中存在消息的日期。只遍历 chatId_timestamp 的 key，避免读取图片正文。
 */
export async function listMessageDaysForChat(chatId, monthTimestamp = Date.now()) {
  const id = String(chatId || '').trim();
  if (!id) return [];
  const month = new Date(Number(monthTimestamp || Date.now()));
  if (!Number.isFinite(month.getTime())) return [];
  const start = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime();
  const keys = await db.getIndexKeysRange(
    'messages',
    'chatId_timestamp',
    [id, start],
    [id, end],
    { upperOpen: true },
  );
  return [...new Set((keys || []).map((key) => localDayKey(Array.isArray(key) ? key[1] : 0)).filter(Boolean))];
}

/** 找到本地自然日内第一条未删除消息，供日历跳转复用。 */
export async function findFirstMessageForChatDay(chatId, dayTimestamp) {
  const id = String(chatId || '').trim();
  const day = new Date(Number(dayTimestamp || 0));
  if (!id || !Number.isFinite(day.getTime())) return null;
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return db.findFirstByIndexRange(
    'messages',
    'chatId_timestamp',
    [id, start],
    [id, end],
    {
      upperOpen: true,
      predicate: (message) => !!message && !message.deleted,
    },
  );
}

/**
 * 读取某条历史消息附近的有界窗口。
 *
 * 搜索结果跳转不能把「命中消息 → 最新消息」之间的整段历史一次性塞进 DOM；
 * 长会话里这会同时放大 IndexedDB 结果、data URL 图片与气泡节点，移动端 WebView
 * 很容易直接被系统回收。这里始终只取目标前后少量消息，并明确告知两侧是否还有记录。
 */
export async function listMessagesAroundForChat(chatId, target, options = {}) {
  const id = String(chatId || '').trim();
  const targetId = String(
    typeof target === 'object' ? target?.id : (options.targetId || ''),
  ).trim();
  let targetMessage = target && typeof target === 'object' ? target : null;
  if ((!targetMessage || String(targetMessage.chatId || '') !== id) && targetId) {
    targetMessage = await db.getRecord('messages', targetId).catch(() => null);
  }
  const targetTimestamp = Number(
    targetMessage?.timestamp
    || (typeof target === 'number' ? target : options.targetTimestamp)
    || 0,
  );
  if (!id || !Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return { messages: [], hasOlder: false, hasNewer: false };
  }

  const beforeLimit = Math.max(1, Math.min(100, Number(options.beforeLimit || 30) || 30));
  const afterLimit = Math.max(1, Math.min(100, Number(options.afterLimit || 40) || 40));
  const [beforeRows, afterRows] = await Promise.all([
    db.getAllByIndexRange(
      'messages',
      'chatId_timestamp',
      [id, 0],
      [id, targetTimestamp],
      {
        direction: 'prev',
        limit: beforeLimit + 2,
      },
    ),
    db.getAllByIndexRange(
      'messages',
      'chatId_timestamp',
      [id, targetTimestamp],
      [id, Number.MAX_SAFE_INTEGER],
      {
        lowerOpen: true,
        direction: 'next',
        limit: afterLimit + 1,
      },
    ),
  ]);

  const beforeVisible = (Array.isArray(beforeRows) ? beforeRows : [])
    .filter((message) => message && !message.deleted);
  const afterVisible = (Array.isArray(afterRows) ? afterRows : [])
    .filter((message) => message && !message.deleted);
  const hasOlder = beforeVisible.length > beforeLimit;
  const hasNewer = afterVisible.length > afterLimit;
  const boundedBefore = beforeVisible.slice(0, beforeLimit).reverse();
  const boundedAfter = afterVisible.slice(0, afterLimit);
  const byId = new Map();
  [...boundedBefore, targetMessage, ...boundedAfter].forEach((message) => {
    if (!message || message.deleted || String(message.chatId || '') !== id) return;
    byId.set(String(message.id || `${message.timestamp}`), message);
  });
  const messages = [...byId.values()]
    .sort(compareChatMessageChronology)
    .map((message) => maybeDeferHeavyImageContent(message, {
      ...options,
      deferHeavyImages: true,
    }));
  return { messages, hasOlder, hasNewer };
}

function sparkDateKeyFromTimestamp(ts = 0) {
  const date = new Date(Number(ts || 0) || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sparkAddDaysToDateKey(key = '', delta = 0) {
  const parts = String(key || '').split('-').map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return '';
  const date = new Date(parts[0], parts[1] - 1, parts[2] + delta);
  return sparkDateKeyFromTimestamp(date.getTime());
}

function sparkDayTimestampRange(key = '') {
  const parts = String(key || '').split('-').map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const start = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  const end = new Date(parts[0], parts[1] - 1, parts[2] + 1).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function isSparkCountableMessage(m) {
  return !!(
    m
    && !m.deleted
    && !m.recalled
    && !m.metadata?.aiPlaceholder
    && m.senderId !== 'system'
    && m.type !== 'system'
    && Number(m.timestamp || 0) > 0
  );
}

/** chatId -> 已点亮的日期键；权威数据在 chatPrefs.sparkDayKeys */
const sparkDayCache = new Map();
/** chatId -> 是否为可统计火花的私聊 */
const sparkEligibleCache = new Map();
const sparkMigrateInflight = new Map();
const sparkLightQueues = new Map();

/** 按已点亮日期统计累计活跃天 / 连续天（用于聊天火花）。 */
export function computeSparkStatsFromDayKeys(dayKeysInput = []) {
  const dayKeys = [...new Set((Array.isArray(dayKeysInput) ? dayKeysInput : []).filter(Boolean))].sort();
  if (!dayKeys.length) return null;
  const daySet = new Set(dayKeys);
  const lastKey = dayKeys[dayKeys.length - 1];
  let streak = 0;
  for (let key = lastKey; key && daySet.has(key); key = sparkAddDaysToDateKey(key, -1)) streak += 1;
  return {
    activeDays: dayKeys.length,
    streak,
    firstKey: dayKeys[0],
    lastKey,
    dayKeys,
  };
}

export function computeSparkStatsFromMessages(rows = []) {
  const dayKeys = (Array.isArray(rows) ? rows : [])
    .filter(isSparkCountableMessage)
    .map((m) => sparkDateKeyFromTimestamp(m.timestamp))
    .filter(Boolean);
  return computeSparkStatsFromDayKeys(dayKeys);
}

async function isSparkEligibleChat(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  if (sparkEligibleCache.has(id)) return sparkEligibleCache.get(id);
  const chat = await getChat(id).catch(() => null);
  const ok = !!(chat && chat.type !== 'group');
  sparkEligibleCache.set(id, ok);
  return ok;
}

async function persistSparkDayKeys(chatId, daySet) {
  const id = String(chatId || '').trim();
  const dayKeys = [...daySet].filter(Boolean).sort();
  sparkDayCache.set(id, new Set(dayKeys));
  await patchChatPrefs(id, { sparkDayKeys: dayKeys });
  return dayKeys;
}

/** 旧会话缺点亮表时回填一次；之后靠「当天首条消息点亮」增量维护。 */
async function backfillSparkDayKeys(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return new Set();
  if (sparkMigrateInflight.has(id)) return sparkMigrateInflight.get(id);
  const task = (async () => {
    const daySet = new Set();
    // 旧实现为了找活跃日期会分页读取最多两万条完整消息。超长会话里的 data URL、
    // 卡片和语音也会随 cursor.value 被克隆，恰好又与聊天首屏并发，容易在移动端形成
    // 明显卡顿甚至闪白。先只扫复合索引里的 [chatId, timestamp] 小键，再按候选日期
    // 定向确认当天至少有一条可计数消息；整个迁移不再把聊天正文搬进 JS 堆。
    const indexKeys = await db.getIndexKeysRange(
      'messages',
      'chatId_timestamp',
      [id, 0],
      [id, Number.MAX_SAFE_INTEGER],
    );
    const candidateDays = [...new Set((indexKeys || [])
      .map((indexKey) => sparkDateKeyFromTimestamp(Array.isArray(indexKey) ? indexKey[1] : 0))
      .filter(Boolean))].sort();
    for (let index = 0; index < candidateDays.length; index += 12) {
      const batch = candidateDays.slice(index, index + 12);
      const confirmed = await Promise.all(batch.map(async (key) => {
        const range = sparkDayTimestampRange(key);
        if (!range) return '';
        const message = await db.findFirstByIndexRange(
          'messages',
          'chatId_timestamp',
          [id, range.start],
          [id, range.end],
          {
            upperOpen: true,
            predicate: isSparkCountableMessage,
          },
        );
        return message ? key : '';
      }));
      confirmed.filter(Boolean).forEach((key) => daySet.add(key));
    }
    await persistSparkDayKeys(id, daySet);
    return sparkDayCache.get(id) || daySet;
  })();
  sparkMigrateInflight.set(id, task);
  try {
    return await task;
  } finally {
    sparkMigrateInflight.delete(id);
  }
}

async function ensureSparkDayKeys(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return new Set();
  if (sparkDayCache.has(id)) return sparkDayCache.get(id);
  const prefs = await loadChatPrefs(id);
  // 读取 prefs 期间同一聊天的保存队列可能已经点亮并更新了 cache；此时不能再用
  // 较旧的读取结果覆盖它，否则下一次落库会把刚加入的日期写丢。
  if (sparkDayCache.has(id)) return sparkDayCache.get(id);
  if (Array.isArray(prefs.sparkDayKeys)) {
    const daySet = new Set(prefs.sparkDayKeys.filter(Boolean));
    sparkDayCache.set(id, daySet);
    return daySet;
  }
  return backfillSparkDayKeys(id);
}

/**
 * 当天第一次有可计数消息时点亮该日并写入 prefs。
 * 正常路径 O(1)；仅旧数据尚未建点亮表时会回填一次。
 */
function enqueueSparkDayKeys(chatId, keys = []) {
  const id = String(chatId || '').trim();
  const additions = [...new Set(keys.filter(Boolean))];
  if (!id || !additions.length) return Promise.resolve(null);
  const previous = sparkLightQueues.get(id) || Promise.resolve();
  const queued = previous.catch(() => {}).then(async () => {
    if (!(await isSparkEligibleChat(id))) return null;
    const daySet = await ensureSparkDayKeys(id);
    let changed = false;
    for (const key of additions) {
      if (daySet.has(key)) continue;
      daySet.add(key);
      changed = true;
    }
    if (changed) await persistSparkDayKeys(id, daySet);
    return computeSparkStatsFromDayKeys([...daySet]);
  });
  sparkLightQueues.set(id, queued);
  return queued.finally(() => {
    if (sparkLightQueues.get(id) === queued) sparkLightQueues.delete(id);
  });
}

export async function lightChatSparkDaysFromMessages(messages = []) {
  const dayKeysByChat = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isSparkCountableMessage(message)) continue;
    const chatId = String(message.chatId || '').trim();
    const key = sparkDateKeyFromTimestamp(message.timestamp);
    if (!chatId || !key) continue;
    if (!dayKeysByChat.has(chatId)) dayKeysByChat.set(chatId, new Set());
    dayKeysByChat.get(chatId).add(key);
  }
  return Promise.all([...dayKeysByChat.entries()].map(([chatId, keys]) => (
    enqueueSparkDayKeys(chatId, [...keys])
  )));
}

export async function lightChatSparkDayFromMessage(message) {
  if (!isSparkCountableMessage(message)) return null;
  const chatId = String(message.chatId || '').trim();
  const key = sparkDateKeyFromTimestamp(message.timestamp);
  if (!chatId || !key) return null;
  return enqueueSparkDayKeys(chatId, [key]);
}

/** 读取聊天火花：优先点亮表，不再每次扫消息。 */
export async function computeSparkStatsForChat(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  if (!(await isSparkEligibleChat(id))) return null;
  const daySet = await ensureSparkDayKeys(id);
  return computeSparkStatsFromDayKeys([...daySet]);
}

export async function resetChatSparkDays(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  sparkDayCache.set(id, new Set());
  await patchChatPrefs(id, { sparkDayKeys: [] });
}

export function pickPrivateChat(chats = [], characterId = '', options = {}) {
  const includeEncounterPending = options.includeEncounterPending === true;
  const preferEncounterPending = includeEncounterPending
    && options.preferEncounterPending === true;
  const candidates = (Array.isArray(chats) ? chats : []).filter(
    (c) => c.type !== 'group'
      && !isAnonymousChat(c)
      && !isStrangerInterceptChat(c)
      && (includeEncounterPending || c.metadata?.firstEncounterPending !== true)
      && Array.isArray(c.participants)
      && c.participants.includes('user')
      && c.participants.includes(characterId),
  );
  if (preferEncounterPending) {
    return candidates.find((chat) => chat.metadata?.firstEncounterPending === true)
      || candidates[0]
      || null;
  }
  return candidates[0] || null;
}

export async function findPrivateChat(userId, characterId, options = {}) {
  const chats = await listChatsForUser(userId);
  return pickPrivateChat(chats, characterId, options);
}

const privateChatEnsureLocks = new Map();

export function stablePrivateChatId(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim());
  const cid = encodeURIComponent(String(characterId || '').trim());
  return uid && cid ? `chat_private_${uid}__${cid}` : '';
}

export async function loadIdentityChatAppearanceDefaults(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return {};
  const user = await db.getRecord('users', uid).catch(() => null);
  const identityAppearance = user?.identityAppearance && typeof user.identityAppearance === 'object'
    ? user.identityAppearance
    : {};
  const appearance = identityAppearance.chatAppearance && typeof identityAppearance.chatAppearance === 'object'
    ? identityAppearance.chatAppearance
    : {};
  const hasPreset = !!String(identityAppearance.chatPresetId || '').trim();
  const defaults = {};

  if (hasPreset) {
    defaults.customCss = String(appearance.customCss || '');
    defaults.userBubbleCss = String(appearance.userBubbleCss || '');
    defaults.charBubbleCss = String(appearance.charBubbleCss || '');
    defaults.wallpaperOpacity = Math.min(100, Math.max(10, Number(appearance.wallpaperOpacity || 100) || 100));
    defaults.bubbleSelf = String(appearance.bubbleSelf || '').trim();
    defaults.bubbleOther = String(appearance.bubbleOther || '').trim();
    defaults.bubbleTextSelf = String(appearance.bubbleTextSelf || '').trim();
    defaults.bubbleTextOther = String(appearance.bubbleTextOther || '').trim();
    defaults.bubbleFontSize = Math.max(0, Number(appearance.bubbleFontSize || 0) || 0);
    defaults.avatarSize = Math.max(0, Number(appearance.avatarSize || 0) || 0);
    defaults.narrationFontSize = Math.max(0, Number(appearance.narrationFontSize || 0) || 0);
    defaults.narrationTextColor = String(appearance.narrationTextColor || '').trim();
    defaults.bubbleGrouping = appearance.bubbleGrouping === true;
  }

  const wallpaperAssetId = String(identityAppearance.wallpaperAssetId || '').trim();
  if (wallpaperAssetId) defaults.wallpaperAssetId = wallpaperAssetId;
  return defaults;
}

/**
 * 身份装扮同步是“覆盖当前壁纸选择”，不是只合并非空字段。
 * 因此即使当前选择“不设壁纸”，也必须显式清掉会话里的
 * 旧直存图片与素材引用；有新素材时 defaults 会再覆盖空的 assetId。
 */
export function buildIdentityChatAppearanceSyncPatch(defaults = {}) {
  const source = defaults && typeof defaults === 'object' ? defaults : {};
  return {
    wallpaper: '',
    wallpaperAssetId: '',
    ...source,
  };
}

const CHAT_APPEARANCE_PLACEHOLDERS = Object.freeze({
  wallpaper: '',
  wallpaperOpacity: 100,
  customCss: '',
  bubbleSelf: '',
  bubbleOther: '',
  bubbleTextSelf: '',
  bubbleTextOther: '',
});

export function mergeMissingIdentityChatAppearanceDefaults(groupSettings = {}, defaults = {}, {
  fillPlaceholders = false,
} = {}) {
  const current = groupSettings && typeof groupSettings === 'object' ? groupSettings : {};
  let merged = current;
  Object.entries(defaults && typeof defaults === 'object' ? defaults : {}).forEach(([key, value]) => {
    const hasValue = Object.prototype.hasOwnProperty.call(current, key);
    const isModelPlaceholder = Object.prototype.hasOwnProperty.call(CHAT_APPEARANCE_PLACEHOLDERS, key)
      && Object.is(current[key], CHAT_APPEARANCE_PLACEHOLDERS[key]);
    // 旁观群每次进入秘密基地都会走这里。空 CSS / 空颜色可能正是用户切换
    // 风格后主动保存的“恢复默认”，不能再当作缺失字段用身份默认样式覆盖。
    // 只有刚创建的内部空壳才允许把占位值替换成身份默认。
    if (hasValue && !(fillPlaceholders && isModelPlaceholder)) return;
    if (merged === current) merged = { ...current };
    merged[key] = value;
  });
  return merged;
}

export async function ensurePrivateChat(userId, characterId, characterName = '', options = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const preserveEncounterPending = options.preserveEncounterPending === true;
  const lockKey = `${uid}\u0000${cid}`;
  if (!uid || !cid) throw new Error('userId and characterId required');
  const pending = privateChatEnsureLocks.get(lockKey);
  if (pending) return pending;
  const task = (async () => {
    const existing = await findPrivateChat(uid, cid, preserveEncounterPending ? {
      includeEncounterPending: true,
      preferEncounterPending: true,
    } : {});
    if (existing) return existing;
    if (!preserveEncounterPending) {
      // 历史异常可能留下“角色已经转正、私聊仍标着初遇草稿”的隐藏窗口。
      // 普通入口首次碰到它时原地摘标，保留既有消息；主动消息也不会再投进不可见小窗。
      const orphanedEncounter = await findPrivateChat(uid, cid, {
        includeEncounterPending: true,
        preferEncounterPending: true,
      });
      if (orphanedEncounter?.metadata?.firstEncounterPending === true) {
        const metadata = { ...(orphanedEncounter.metadata || {}) };
        delete metadata.firstEncounterPending;
        orphanedEncounter.metadata = metadata;
        await saveChat(orphanedEncounter);
        return orphanedEncounter;
      }
    }
    // 稳定主键让同一账号/角色即使从两个异步任务或页面同时创建，
    // IndexedDB 也只会覆盖同一条记录，不会生成两个“暂无消息”私聊。
    const chat = createPrivateChat(uid, cid, characterName);
    chat.id = stablePrivateChatId(uid, cid);
    chat.groupSettings = {
      ...(chat.groupSettings || {}),
      ...(await loadIdentityChatAppearanceDefaults(uid)),
    };
    await saveChat(chat);
    return chat;
  })();
  privateChatEnsureLocks.set(lockKey, task);
  try {
    return await task;
  } finally {
    if (privateChatEnsureLocks.get(lockKey) === task) privateChatEnsureLocks.delete(lockKey);
  }
}

function duplicatePrivateChatPartnerId(chat, userId) {
  if (!chat || chat.type === 'group' || isAnonymousChat(chat) || isStrangerInterceptChat(chat)) return '';
  if (String(chat.userId || '') !== String(userId || '')) return '';
  const participants = [...new Set((Array.isArray(chat.participants) ? chat.participants : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (!participants.includes('user')) return '';
  const partners = participants.filter((id) => id !== 'user' && id !== 'system');
  return partners.length === 1 ? partners[0] : '';
}

/**
 * 清理历史竞态产生的同角色空白私聊。只删除零消息副本：
 * 任一聊天已有消息时保留该聊天；多个都有消息时全部保留，绝不自动合并正文。
 */
export async function collapseDuplicateEmptyPrivateChats(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const chats = await listChatsForUser(uid);
  const groups = new Map();
  for (const chat of chats) {
    const partnerId = duplicatePrivateChatPartnerId(chat, uid);
    if (!partnerId) continue;
    if (!groups.has(partnerId)) groups.set(partnerId, []);
    groups.get(partnerId).push(chat);
  }
  const removed = [];
  for (const duplicates of groups.values()) {
    if (duplicates.length < 2) continue;
    const inspected = await Promise.all(duplicates.map(async (chat) => ({
      chat,
      hasMessages: (await listMessagesForChat(chat.id, 1).catch(() => [])).length > 0,
      hasUserState: !!(
        chat.pinned
        || chat.autoActive
        || String(chat.lastMessage || '').trim()
        || Number(chat.unread || 0) > 0
      ),
    })));
    const protectedChats = inspected.filter((item) => item.hasMessages || item.hasUserState);
    const empty = inspected.filter((item) => !item.hasMessages && !item.hasUserState);
    const keepEmptyId = protectedChats.length
      ? ''
      : [...empty].sort((a, b) => (
        Number(a.chat.createdAt || a.chat.lastActivity || 0)
        - Number(b.chat.createdAt || b.chat.lastActivity || 0)
      ))[0]?.chat?.id || '';
    for (const item of empty) {
      if (item.chat.id === keepEmptyId) continue;
      // 已确认零消息、无置顶/自动任务/预览/未读，仅移除空壳记录。
      // 不走 deleteChatWithData 的重型记忆与后台任务级联，避免进聊天列表时加载整套调度模块。
      await db.deleteRecord('chats', item.chat.id);
      await db.remove(`chatPrefs_${item.chat.id}`).catch(() => {});
      removed.push(item.chat.id);
    }
  }
  return removed;
}

export function isPeerPrivateChat(chat) {
  return !!(
    chat?.type === 'private'
    && String(chat?.metadata?.channel || '') === 'peer_private'
    && Array.isArray(chat?.participants)
    && !chat.participants.includes('user')
    && chat.participants.filter(Boolean).length === 2
  );
}

/**
 * 旧版 AI 可能把普通双人私聊建成 backstage 群。只迁移明确属于 AI 幕后链路的旧记录；
 * 用户手动创建的旁观群（scrapbook）与关系网显式共享群继续保持群聊。
 */
export function isLegacyTwoActorBackstageChat(chat) {
  const ids = [...new Set((Array.isArray(chat?.participants) ? chat.participants : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== 'system'))];
  return !!(
    chat?.type === 'group'
    && String(chat?.metadata?.channel || '') === 'backstage'
    && !(chat.participants || []).includes('user')
    && ids.length === 2
    && !isAnonymousChat(chat)
    && !isExplicitRelationshipObserverGroup(chat)
  );
}

function legacyBackstagePeerMetadata(chat, participantIds) {
  const source = chat?.metadata && typeof chat.metadata === 'object' ? chat.metadata : {};
  const {
    channel: _channel,
    backstageKey: _backstageKey,
    knownByActorIds: _knownByActorIds,
    participantSnapshot: _participantSnapshot,
    backstagePurpose: _backstagePurpose,
    ...rest
  } = source;
  const requestedFocal = String(chat?.groupSettings?.owner || source.focalActorId || '').trim();
  return {
    ...rest,
    channel: 'peer_private',
    peerPrivateKey: peerPrivateKey(participantIds),
    focalActorId: participantIds.includes(requestedFocal) ? requestedFocal : participantIds[0],
    legacyBackstageMigratedAt: Date.now(),
    legacyBackstageName: String(chat?.groupSettings?.name || '').trim(),
  };
}

/**
 * 将历史普通双人 backstage 安全收敛为 peer_private。
 * 已有同成员角色私聊时合并消息，否则保留原 chatId 原地改型，避免外部引用失效。
 */
export async function migrateLegacyTwoActorBackstageChats(userId, suppliedChats = null) {
  const chats = Array.isArray(suppliedChats) ? suppliedChats : await listChatsForUser(userId);
  const legacyChats = chats.filter(isLegacyTwoActorBackstageChat);
  if (!legacyChats.length) return { changed: 0, converted: 0, merged: 0, chatIds: [] };
  let converted = 0;
  let merged = 0;
  const changedIds = [];

  for (const legacy of legacyChats) {
    const participantIds = [...new Set((legacy.participants || [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== 'user' && id !== 'system'))];
    if (participantIds.length !== 2) continue;
    const boundary = await checkPhoneSocialParticipantIds(participantIds, userId).catch(() => ({ allowed: false }));
    if (!boundary.allowed) continue;
    const key = peerPrivateKey(participantIds);
    const existing = chats
      .filter((chat) => chat?.id !== legacy.id && isPeerPrivateChat(chat))
      .filter((chat) => peerPrivateKey(chat.participants) === key)
      .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0))[0] || null;

    if (existing) {
      const legacyMessages = await listMessagesForChat(legacy.id, 0).catch(() => []);
      if (legacyMessages.length) {
        await db.putMany('messages', legacyMessages.map((message) => ({
          ...message,
          chatId: existing.id,
        })));
      }
      const parentIds = new Set([
        ...(existing.metadata?.linkedParentChatIds || []),
        ...(legacy.metadata?.linkedParentChatIds || []),
        existing.metadata?.parentChatId,
        legacy.metadata?.parentChatId,
      ].map((id) => String(id || '').trim()).filter(Boolean));
      const legacyNewer = Number(legacy.lastActivity || 0) > Number(existing.lastActivity || 0);
      existing.metadata = {
        ...(existing.metadata || {}),
        linkedParentChatIds: [...parentIds],
        legacyBackstageMigratedAt: Date.now(),
      };
      existing.lastActivity = Math.max(Number(existing.lastActivity || 0), Number(legacy.lastActivity || 0));
      existing.lastMessage = legacyNewer
        ? (legacy.lastMessage || existing.lastMessage || '')
        : (existing.lastMessage || '');
      existing.unread = Math.max(0, Number(existing.unread || 0)) + Math.max(0, Number(legacy.unread || 0));
      await saveChat(existing);
      await db.deleteRecord('chats', legacy.id);
      await db.remove(`chatPrefs_${legacy.id}`).catch(() => {});
      await recalcChatPreview(existing.id).catch(() => {});
      merged += 1;
      changedIds.push(existing.id);
      continue;
    }

    const nextMetadata = legacyBackstagePeerMetadata(legacy, participantIds);
    legacy.type = 'private';
    legacy.participants = participantIds;
    legacy.groupSettings = {};
    legacy.metadata = nextMetadata;
    await saveChat(legacy);
    converted += 1;
    changedIds.push(legacy.id);
  }

  return {
    changed: converted + merged,
    converted,
    merged,
    chatIds: [...new Set(changedIds)],
  };
}

function peerPrivateKey(ids = []) {
  return participantSetKey(ids);
}

export async function findPeerPrivateChat(userId, participantIds = []) {
  const key = peerPrivateKey(participantIds);
  if (!key || key.split(',').length !== 2) return null;
  const chats = await listChatsForUser(userId);
  return chats
    .filter((c) => isPeerPrivateChat(c) && peerPrivateKey(c.participants) === key)
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))[0] || null;
}

/** 角色与角色的一对一真实私聊；所有来源复用同一个窗口。 */
export async function ensurePeerPrivateChat(userId, participantIds = [], options = {}) {
  const ids = [...new Set((Array.isArray(participantIds) ? participantIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== 'system'))].slice(0, 2);
  if (ids.length !== 2) throw new Error('角色私聊需要两位真实角色');
  const sociallyEligible = await canPhoneCharacterIdsKnowEachOther(
    ids[0],
    ids[1],
    userId,
  ).catch(() => false);
  if (sociallyEligible === false) {
    throw new Error('跨分组角色尚未在关系网建立联系');
  }
  const existing = await findPeerPrivateChat(userId, ids);
  const parentId = String(options.parentChatId || '').trim();
  if (existing) {
    if (parentId) {
      const linked = new Set(existing.metadata?.linkedParentChatIds || []);
      if (existing.metadata?.parentChatId) linked.add(existing.metadata.parentChatId);
      if (!linked.has(parentId)) {
        linked.add(parentId);
        existing.metadata = { ...(existing.metadata || {}), linkedParentChatIds: [...linked] };
        await saveChat(existing);
      }
    }
    return existing;
  }
  const chat = createChat({
    type: 'private',
    userId,
    participants: ids,
    groupSettings: {},
    metadata: {
      channel: 'peer_private',
      peerPrivateKey: peerPrivateKey(ids),
      parentChatId: parentId,
      linkedParentChatIds: parentId ? [parentId] : [],
      focalActorId: String(options.focalActorId || ids[0]).trim() || ids[0],
    },
  });
  await saveChat(chat);
  return chat;
}

export async function createGroupChat(userId, characterIds = [], groupName = '', options = {}) {
  const includeSelf = options.includeSelf !== false;
  const ids = (Array.isArray(characterIds) ? characterIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .filter((id) => id !== 'user')
    .filter((id, idx, arr) => arr.indexOf(id) === idx);
  if (!ids.length) throw new Error('请至少选择一位角色');
  if (!includeSelf && ids.length < 2 && options.allowSingleObserver !== true) {
    throw new Error('旁观群聊至少选择 2 位角色');
  }
  const label = String(groupName || '').trim();
  const participants = includeSelf ? ['user', ...ids] : ids;
  const requestedOwner = String(options.ownerId || '').trim();
  let owner = includeSelf ? 'user' : ids[0];
  if (requestedOwner && participants.includes(requestedOwner)) {
    owner = requestedOwner;
  } else if (requestedOwner && requestedOwner !== 'user' && ids.includes(requestedOwner)) {
    owner = requestedOwner;
  }
  const chat = createChat({
    type: 'group',
    userId,
    participants,
    groupSettings: {
      name: label || (includeSelf ? `群聊（${ids.length + 1}人）` : `旁观群（${ids.length}人）`),
      owner,
      admins: [],
      isObserverMode: !includeSelf,
    },
    metadata: {
      channel: 'scrapbook',
      ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}),
    },
  });
  chat.groupSettings = {
    ...(chat.groupSettings || {}),
    ...(await loadIdentityChatAppearanceDefaults(userId)),
  };
  await saveChat(chat);
  return chat;
}

/**
 * 用户退群：从 participants 移除 user，群转为无 user 旁观群（进秘密基地列表），并写一条系统提示。
 */
export async function leaveGroupAsUser(chatId, { userId = '', userName = '我' } = {}) {
  const chat = await getChat(chatId);
  if (!chat || chat.type !== 'group') throw new Error('不是群聊');
  if (!(chat.participants || []).includes('user')) {
    return { chat, alreadyLeft: true };
  }
  const nextParticipants = (chat.participants || []).filter((id) => id && id !== 'user');
  if (!nextParticipants.length) throw new Error('群里没有其他成员，无法退群为旁观群');
  let owner = String(chat.groupSettings?.owner || '').trim();
  if (!owner || owner === 'user' || !nextParticipants.includes(owner)) {
    owner = nextParticipants[0];
  }
  const admins = (chat.groupSettings?.admins || []).filter((id) => id && id !== 'user' && nextParticipants.includes(id));
  chat.participants = nextParticipants;
  chat.groupSettings = {
    ...(chat.groupSettings || {}),
    owner,
    admins,
    isObserverMode: true,
  };
  await saveChat(chat);
  const name = String(userName || '我').trim() || '我';
  const sys = createMessage({
    chatId,
    senderId: 'system',
    senderName: '系统',
    type: 'system',
    content: `${name}已退出群聊`,
    timestamp: userId ? await getNowForUser(userId) : Date.now(),
    metadata: {
      groupEvent: 'user_left',
      leftUserId: 'user',
      leftUserName: name,
    },
  });
  await saveMessage(sys);
  await updateChatPreview(chatId, `${name}已退出群聊`, sys.timestamp).catch(() => {});
  return { chat, system: sys, alreadyLeft: false };
}

export function isBackstageListChat(chat) {
  if (chat?.type !== 'group') return false;
  const participants = [...new Set((Array.isArray(chat.participants) ? chat.participants : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'system'))];
  // 群助手承接原「秘密基地」：只展示 user 不在场、且确实由至少两位角色组成的群。
  // 未完成线下偶发留下的单角色 group 保留原始数据，但不能伪装成群聊进入群助手。
  return !participants.includes('user') && participants.length >= 2;
}

export async function listInboxChatsForUser(userId) {
  const chats = await listChatsForUser(userId);
  const candidates = chats.filter((c) => c
    && (c.participants || []).includes('user')
    && !isBackstageListChat(c)
    && !isAnonymousChat(c)
    && !isStrangerInterceptChat(c)
    // 初遇会话在第一场线下收纳前不进聊天列表（收纳时清掉标记）
    && !c.metadata?.firstEncounterPending);
  const prefsRows = await db.getMany(
    'settings',
    candidates.map((chat) => chatPrefsKey(chat.id)),
  ).catch(() => []);
  const checked = candidates.map((chat, index) => ({
    chat,
    blocked: getChatBlockedState(
      chat,
      prefsRows[index]?.value && typeof prefsRows[index].value === 'object'
        ? prefsRows[index].value
        : {},
    ).blocked,
  }));
  const visible = checked.filter((row) => !row.blocked).map((row) => row.chat);
  const hidden = chats.filter((chat) => !visible.some((row) => row.id === chat.id));
  return attachReceipts(visible, hidden.map((chat) => createChatRoundReceipt({
    code: 'chat_hidden_from_inbox',
    status: 'hidden',
    stage: 'list',
    eventType: 'chat',
    chatId: chat.id,
    context: {
      backstage: isBackstageListChat(chat),
      anonymous: isAnonymousChat(chat),
      firstEncounterPending: chat.metadata?.firstEncounterPending === true,
    },
  })));
}

export async function listBackstageChats(userId) {
  const beforeMigration = await listChatsForUser(userId);
  const migration = await migrateLegacyTwoActorBackstageChats(userId, beforeMigration);
  const chats = migration.changed > 0 ? await listChatsForUser(userId) : beforeMigration;
  // 匿名会话（如赛博告解室「旁观局」群聊）只属于匿名空间，不落到秘密基地。
  const candidates = chats.filter((c) => isBackstageListChat(c) && !isAnonymousChat(c));
  const boundaryRows = await Promise.all(candidates.map(async (chat) => ({
    chat,
    boundary: String(chat?.metadata?.channel || '') === 'backstage'
      ? await checkPhoneSocialParticipantIds(chat.participants, userId).catch(() => ({ allowed: false }))
      : { allowed: true, pair: null },
  })));
  const visible = boundaryRows.filter((row) => row.boundary.allowed).map((row) => row.chat);
  const hiddenSocialBoundary = boundaryRows.filter((row) => !row.boundary.allowed);
  const appearanceDefaults = await loadIdentityChatAppearanceDefaults(userId).catch(() => ({}));
  await Promise.all(visible.map(async (chat) => {
    const participants = (chat.participants || []).filter((id) => id && id !== 'user');
    const currentOwner = String(chat.groupSettings?.owner || '').trim();
    const owner = currentOwner && participants.includes(currentOwner)
      ? currentOwner
      : (participants[0] || null);
    const currentAdmins = Array.isArray(chat.groupSettings?.admins) ? chat.groupSettings.admins : [];
    const admins = currentAdmins.filter((id) => id && id !== owner && participants.includes(id));
    const appearanceDefaultsApplied = Number(chat.metadata?.identityAppearanceDefaultsVersion || 0) >= 1;
    const completedSettings = mergeMissingIdentityChatAppearanceDefaults(
      chat.groupSettings,
      appearanceDefaults,
      { fillPlaceholders: !appearanceDefaultsApplied },
    );
    if (owner === currentOwner
      && admins.join('\0') === currentAdmins.join('\0')
      && chat.groupSettings?.isObserverMode === true
      && completedSettings === chat.groupSettings
      && appearanceDefaultsApplied) return;
    chat.groupSettings = {
      ...completedSettings,
      owner,
      admins,
      isObserverMode: true,
    };
    chat.metadata = {
      ...(chat.metadata || {}),
      identityAppearanceDefaultsVersion: 1,
    };
    await saveChat(chat);
  }));
  const hiddenAnonymous = chats.filter((c) => isBackstageListChat(c) && isAnonymousChat(c));
  return attachReceipts(visible, [
    ...hiddenAnonymous.map((chat) => createChatRoundReceipt({
      code: 'anonymous_chat_hidden_from_backstage',
      status: 'hidden',
      stage: 'list',
      eventType: 'chat',
      chatId: chat.id,
    })),
    ...hiddenSocialBoundary.map(({ chat, boundary }) => createChatRoundReceipt({
      code: 'phone_social_group_boundary_hidden',
      status: 'hidden',
      stage: 'list',
      eventType: 'backstage',
      chatId: chat.id,
      context: { participantIds: [boundary.pair?.leftId, boundary.pair?.rightId].filter(Boolean) },
    })),
  ]);
}

function backstageKey(parentChatId, roomName) {
  return `${String(parentChatId || '').trim()}::${String(roomName || '').trim()}`;
}

const backstageEnsureQueues = new Map();

async function withBackstageEnsureLock(userId, task) {
  const key = String(userId || '').trim() || '__default__';
  const previous = backstageEnsureQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  backstageEnsureQueues.set(key, current);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (backstageEnsureQueues.get(key) === current) backstageEnsureQueues.delete(key);
  }
}

export async function findBackstageChat(userId, parentChatId, roomName) {
  const chats = await listBackstageChats(userId);
  const key = backstageKey(parentChatId, roomName);
  return chats.find((c) => c.metadata?.backstageKey === key) || null;
}

/** 参与者集合键：排除 user，去重后排序拼接；用于判断 roster 是否相同，不再单独充当群的唯一身份。 */
export function participantSetKey(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))].sort().join(',');
}

function backstageRoomKey(value = '') {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

const GENERIC_BACKSTAGE_ROOM_KEYS = new Set(['秘密基地', '幕后', '幕后群', '小群']);

/** 同一个具名群里，某轮只有部分成员发言时，仍应复用已有的完整成员群。 */
export function areBackstageParticipantSetsCompatible(leftIds = [], rightIds = []) {
  const left = participantSetKey(leftIds).split(',').filter(Boolean);
  const right = participantSetKey(rightIds).split(',').filter(Boolean);
  if (Math.min(left.length, right.length) < 2) return false;
  const smaller = left.length <= right.length ? left : right;
  const larger = new Set(left.length <= right.length ? right : left);
  return smaller.every((id) => larger.has(id));
}

/**
 * 关系网页面手动建的"预设小群"存了 shareChatId，但一直没有代码读取它——AI 动态建群完全不知道
 * 它存在。这里在参与者集合完全匹配某个预设小群时，把它找出来，让 AI 真正复用用户提前搭好的
 * 小群（以及它已经积累的记忆），而不是另外再开一个。
 */
export async function findPresetGroupChatForParticipants(userId, incomingIds = [], options = {}) {
  if (!incomingIds.length) return null;
  const wantKey = participantSetKey(incomingIds);
  const wantIds = new Set(wantKey.split(',').filter(Boolean));
  const allowCompatible = options.allowCompatible === true;
  const matches = [];
  const net = await loadRelationshipNetwork(userId).catch(() => null);
  for (const circle of net?.circles || []) {
    for (const group of circle.groups || []) {
      if (!group.shareChatId) continue;
      const groupKey = participantSetKey(group.memberIds);
      const groupIds = groupKey.split(',').filter(Boolean);
      const exact = groupKey === wantKey;
      const compatible = allowCompatible && wantIds.size >= 2 && [...wantIds].every((id) => groupIds.includes(id));
      if (!exact && !compatible) continue;
      const target = await getChat(group.shareChatId).catch(() => null);
      if (target
        && target.type === 'group'
        && !(target.participants || []).includes('user')
        && String(target.userId || '') === String(userId || '')) {
        matches.push({ target, exact, size: groupIds.length });
      }
    }
  }
  return matches
    .sort((a, b) => Number(b.exact) - Number(a.exact)
      || a.size - b.size
      || (b.target.lastActivity || 0) - (a.target.lastActivity || 0))[0]?.target || null;
}

async function mergeBackstageParticipants(existing, incomingIds = [], parentChatId = '', options = {}) {
  let dirty = false;
  const completedSettings = mergeMissingIdentityChatAppearanceDefaults(
    existing.groupSettings,
    await loadIdentityChatAppearanceDefaults(existing.userId).catch(() => ({})),
  );
  if (completedSettings !== existing.groupSettings) {
    existing.groupSettings = completedSettings;
    dirty = true;
  }
  const previousIds = [...new Set((existing.participants || []).filter(Boolean))];
  const additions = [...new Set((incomingIds || []).filter((id) => id && !previousIds.includes(id)))];
  const userAuthorizedExpansion = options.allowParticipantExpansion === true
    && options.userInitiated === true;
  if (additions.length && !userAuthorizedExpansion) {
    const error = new Error('已有幕后群新增成员必须由群主或管理员在原群内邀请');
    error.code = 'BACKSTAGE_MEMBER_EXPANSION_REQUIRES_GROUP_ACTION';
    error.chatId = existing.id;
    error.participantIds = additions;
    throw error;
  }
  const merged = [...new Set([...previousIds, ...incomingIds])];
  if (merged.length !== (existing.participants || []).length) {
    existing.participants = merged;
    dirty = true;
  }
  const knownByActorIds = [...new Set([
    ...(existing.metadata?.knownByActorIds || []),
    ...merged.filter((id) => id && id !== 'user'),
  ])];
  if (knownByActorIds.join('\0') !== (existing.metadata?.knownByActorIds || []).join('\0')) {
    existing.metadata = {
      ...(existing.metadata || {}),
      knownByActorIds,
      participantSnapshot: {
        actorIds: merged.filter((id) => id && id !== 'user'),
        capturedAt: Date.now(),
      },
    };
    dirty = true;
  }
  const pid = String(parentChatId || '').trim();
  if (pid) {
    const linked = new Set(existing.metadata?.linkedParentChatIds || []);
    const originalParent = String(existing.metadata?.parentChatId || '').trim();
    if (originalParent) linked.add(originalParent);
    if (!linked.has(pid)) {
      linked.add(pid);
      existing.metadata = { ...(existing.metadata || {}), linkedParentChatIds: [...linked] };
      dirty = true;
    }
  }
  const phoneContactGroupId = String(options.phoneContactGroupId || '').trim();
  const phoneOwnerId = String(options.phoneOwnerId || options.ownerId || '').trim();
  if (phoneContactGroupId && (
    String(existing.metadata?.phoneContactGroupId || '').trim() !== phoneContactGroupId
    || String(existing.metadata?.phoneOwnerId || '').trim() !== phoneOwnerId
  )) {
    existing.metadata = {
      ...(existing.metadata || {}),
      phoneContactGroupId,
      ...(phoneOwnerId ? { phoneOwnerId } : {}),
    };
    dirty = true;
  }
  const requestedOwner = String(options.ownerId || '').trim();
  const currentOwner = String(existing.groupSettings?.owner || '').trim();
  const owner = currentOwner && merged.includes(currentOwner)
    ? currentOwner
    : (requestedOwner && merged.includes(requestedOwner) ? requestedOwner : merged.find((id) => id && id !== 'user'));
  const admins = (Array.isArray(existing.groupSettings?.admins) ? existing.groupSettings.admins : [])
    .filter((id) => id && id !== owner && merged.includes(id));
  if (owner !== currentOwner || admins.join('\0') !== (existing.groupSettings?.admins || []).join('\0')) {
    existing.groupSettings = {
      ...(existing.groupSettings || {}),
      owner: owner || null,
      admins,
      isObserverMode: true,
    };
    dirty = true;
  }
  if (dirty) await saveChat(existing);
  return existing;
}

async function pickCanonicalBackstageChat(chats = []) {
  const candidates = (Array.isArray(chats) ? chats : []).filter((chat) => chat?.id);
  if (candidates.length <= 1) return candidates[0] || null;
  const inspected = await Promise.all(candidates.map(async (chat) => ({
    chat,
    hasMessages: (await listMessagesForChat(chat.id, 1).catch(() => [])).length > 0,
  })));
  return inspected.sort((left, right) => (
    Number(right.hasMessages) - Number(left.hasMessages)
    || Number(left.chat.createdAt || left.chat.lastActivity || 0)
      - Number(right.chat.createdAt || right.chat.lastActivity || 0)
    || String(left.chat.id || '').localeCompare(String(right.chat.id || ''))
  ))[0]?.chat || null;
}

/**
 * 幕后/秘密基地群默认稳定复用同 roster、同群主的历史群，AI 临时换 room 不能覆盖群名。
 * 只有业务层明确确认“独立新群”（新目的 + 新群名；同 roster 时还必须换发起人/群主）才可并存。
 * 其余具名群和关系网预设群仍用于承接沉默成员未出现在本轮 lines 里的情况。
 * 已有群不能通过 create/memberIds 静默扩员，必须走群内 group_member 管理动作。
 */
export async function ensureBackstageChat(userId, parentChatId, roomName, participantIds = [], options = {}) {
  return withBackstageEnsureLock(userId, () => ensureBackstageChatUnlocked(
    userId,
    parentChatId,
    roomName,
    participantIds,
    options,
  ));
}

async function ensureBackstageChatUnlocked(userId, parentChatId, roomName, participantIds = [], options = {}) {
  const room = String(roomName || '秘密基地').trim() || '秘密基地';
  const pid = String(parentChatId || '').trim();
  const incoming = [...new Set((Array.isArray(participantIds) ? participantIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const requestedOwner = String(options.ownerId || '').trim();
  const owner = requestedOwner && incoming.includes(requestedOwner) ? requestedOwner : incoming[0];
  const phoneContactGroupId = String(options.phoneContactGroupId || '').trim();
  const phoneOwnerId = String(options.phoneOwnerId || requestedOwner || '').trim();
  const distinctPurpose = String(options.distinctPurpose || '').trim().slice(0, 160);
  const distinctRequested = (
    options.allowDistinctGroup === true
    || options.allowDistinctSameRoster === true
  ) && !!distinctPurpose;
  const socialBoundary = await checkPhoneSocialParticipantIds(incoming, userId).catch(() => ({ allowed: false }));
  if (!socialBoundary.allowed) {
    const error = new Error('群成员之间尚未建立社交联系');
    error.code = 'PHONE_SOCIAL_GROUP_BOUNDARY';
    error.participantIds = [
      socialBoundary.pair?.leftId,
      socialBoundary.pair?.rightId,
    ].filter(Boolean);
    throw error;
  }

  if (incoming.length >= 2) {
    const wantKey = participantSetKey(incoming);
    const siblings = await listBackstageChats(userId);
    // 同 roster 默认回到原群；不同群主、独立目的和新群名同时明确时才允许并存。
    const sameMemberChats = siblings
      .filter((c) => participantSetKey(c.participants) === wantKey);
    const linkedPhoneGroup = phoneContactGroupId
      ? siblings.find((candidate) => (
        String(candidate?.metadata?.phoneContactGroupId || '').trim() === phoneContactGroupId
        && (!phoneOwnerId || String(candidate?.metadata?.phoneOwnerId || '').trim() === phoneOwnerId)
      ))
      : null;
    if (linkedPhoneGroup) {
      return mergeBackstageParticipants(linkedPhoneGroup, incoming, pid, {
        ...options,
        ownerId: owner,
        phoneContactGroupId,
        phoneOwnerId,
      });
    }
    const sameOwnerChats = sameMemberChats.filter(
      (chat) => String(chat.groupSettings?.owner || '').trim() === owner,
    );
    const roomKey = backstageRoomKey(room);
    const relatedChats = siblings.filter((chat) => (
      participantSetKey(chat.participants) === wantKey
      || areBackstageParticipantSetsCompatible(chat.participants, incoming)
    ));
    const canCreateDistinctGroup = distinctRequested
      && relatedChats.length > 0
      && (sameMemberChats.length === 0 || sameOwnerChats.length === 0)
      && roomKey
      && !GENERIC_BACKSTAGE_ROOM_KEYS.has(roomKey)
      && relatedChats.every((chat) => backstageRoomKey(chat.groupSettings?.name) !== roomKey);
    if (!canCreateDistinctGroup) {
      const sameMembers = await pickCanonicalBackstageChat(
        sameOwnerChats.length ? sameOwnerChats : sameMemberChats,
      );
      if (sameMembers) {
        return mergeBackstageParticipants(sameMembers, incoming, pid, {
          ...options,
          ownerId: owner,
          phoneContactGroupId,
          phoneOwnerId,
        });
      }
    }

    const presetMatch = canCreateDistinctGroup
      ? null
      : await findPresetGroupChatForParticipants(userId, incoming).catch(() => null);
    if (presetMatch) return mergeBackstageParticipants(presetMatch, incoming, pid, {
      ...options,
      ownerId: owner,
      phoneContactGroupId,
      phoneOwnerId,
    });

    if (!canCreateDistinctGroup && roomKey && !GENERIC_BACKSTAGE_ROOM_KEYS.has(roomKey)) {
      const compatibleRoom = siblings
        .filter((c) => backstageRoomKey(c.groupSettings?.name) === roomKey
          // 只允许“本轮部分成员发言 → 复用成员更完整的旧群”。
          // 反方向代表偷偷加人，必须走原群内 group_member add。
          && incoming.every((id) => (c.participants || []).includes(id)))
        // 优先成员更完整的窗口；同规模时沿用较早建立的窗口，避免继续追着新副本写。
        .sort((a, b) => participantSetKey(b.participants).split(',').filter(Boolean).length
          - participantSetKey(a.participants).split(',').filter(Boolean).length
          || String(a.id || '').localeCompare(String(b.id || '')))[0];
      if (compatibleRoom) return mergeBackstageParticipants(compatibleRoom, incoming, pid, {
        ...options,
        ownerId: owner,
        phoneContactGroupId,
        phoneOwnerId,
      });
    }

    // 明确是群聊意图时，AB/AC 可进入用户预设的最小 ABC 圈子；未发言成员仍是群成员。
    const compatiblePreset = canCreateDistinctGroup
      ? null
      : await findPresetGroupChatForParticipants(
        userId,
        incoming,
        { allowCompatible: true },
      ).catch(() => null);
    if (compatiblePreset) return mergeBackstageParticipants(compatiblePreset, incoming, pid, {
      ...options,
      ownerId: owner,
      phoneContactGroupId,
      phoneOwnerId,
    });
  }

  const existingByKey = await findBackstageChat(userId, pid, room);
  if (existingByKey) {
    const existingIds = participantSetKey(existingByKey.participants).split(',').filter(Boolean);
    const additions = incoming.filter((id) => !existingIds.includes(id));
    const userAuthorizedExpansion = options.allowParticipantExpansion === true
      && options.userInitiated === true;
    if (additions.length && !userAuthorizedExpansion) {
      const error = new Error('已有幕后群新增成员必须由群主或管理员在原群内邀请');
      error.code = 'BACKSTAGE_MEMBER_EXPANSION_REQUIRES_GROUP_ACTION';
      error.chatId = existingByKey.id;
      error.participantIds = additions;
      throw error;
    }
    const canContinueSingle = incoming.length === 1
      && existingIds.length >= 3
      && existingIds.includes(incoming[0]);
    if (incoming.length >= 2 || canContinueSingle || isExplicitRelationshipObserverGroup(existingByKey)) {
      return mergeBackstageParticipants(existingByKey, incoming, pid, {
        ...options,
        ownerId: owner,
        phoneContactGroupId,
        phoneOwnerId,
      });
    }
  }
  if (incoming.length < 2) {
    const error = new Error('新建幕后群至少需要两位真实角色');
    error.code = 'BACKSTAGE_ROSTER_INCOMPLETE';
    error.participantIds = incoming;
    throw error;
  }

  const chat = createChat({
    type: 'group',
    userId,
    participants: incoming,
    groupSettings: {
      name: room,
      owner,
      admins: [],
      isObserverMode: true,
    },
    metadata: {
      channel: 'backstage',
      identityAppearanceDefaultsVersion: 1,
      parentChatId: pid,
      linkedParentChatIds: pid ? [pid] : [],
      backstageKey: backstageKey(pid, room),
      knownByActorIds: incoming,
      participantSnapshot: {
        actorIds: incoming,
        capturedAt: Date.now(),
      },
      ...(phoneContactGroupId ? { phoneContactGroupId } : {}),
      ...(phoneOwnerId ? { phoneOwnerId } : {}),
      ...(distinctPurpose ? { backstagePurpose: distinctPurpose } : {}),
    },
  });
  chat.groupSettings = mergeMissingIdentityChatAppearanceDefaults(
    chat.groupSettings,
    await loadIdentityChatAppearanceDefaults(userId).catch(() => ({})),
    { fillPlaceholders: true },
  );
  await saveChat(chat);
  return chat;
}

/**
 * 让 user 真正加入一个无 user 的旁观群/幕后群。
 * 角色发出的邀请只负责落邀请卡；只有用户接受邀请或主动关闭旁观时才会走到这里。
 */
export async function promoteBackstageChatToGroup(chatId, options = {}) {
  const chat = await getChat(chatId);
  if (!chat || chat.type !== 'group') return null;
  const alreadyJoined = (chat.participants || []).includes('user');
  const wasBackstage = chat.metadata?.channel === 'backstage' || !!chat.metadata?.backstageKey;
  const nextMetadata = { ...(chat.metadata || {}) };
  if (nextMetadata.channel === 'backstage') delete nextMetadata.channel;
  delete nextMetadata.backstageKey;
  if (wasBackstage && !nextMetadata.promotedFromBackstageAt) {
    nextMetadata.promotedFromBackstageAt = Date.now();
  }
  const nextGroupSettings = { ...(chat.groupSettings || {}) };
  nextGroupSettings.isObserverMode = false;
  const updated = {
    ...chat,
    participants: alreadyJoined
      ? [...(chat.participants || [])]
      : [...new Set([...(chat.participants || []), 'user'])],
    metadata: nextMetadata,
    groupSettings: nextGroupSettings,
  };
  const needsSave = !alreadyJoined
    || chat.groupSettings?.isObserverMode === true
    || wasBackstage;
  if (needsSave) await saveChat(updated);

  // 手动关闭旁观也等同接受当前群的邀请，避免入群后历史邀请卡仍显示“待处理”。
  const inviteMessages = await listMessagesForChat(chatId, 200).catch(() => []);
  const pendingInvites = inviteMessages.filter((message) => (
    message?.type === 'groupInviteUser'
    && String(message?.metadata?.status || 'pending') === 'pending'
  ));
  if (pendingInvites.length) {
    const resolvedAt = Date.now();
    await saveMessages(pendingInvites.map((message) => ({
      ...message,
      metadata: {
        ...(message.metadata || {}),
        status: 'accepted',
        resolvedAt,
      },
    })));
  }

  // 重复点击、旧页面复挂或脏状态修正时，不重复写“加入群聊”。
  if (alreadyJoined) return needsSave ? updated : chat;
  const worldNow = chat.userId ? await getNowForUser(chat.userId) : Date.now();
  const joinedUserName = String(options.userName || '你').trim() || '你';
  const notice = createMessage({
    chatId,
    senderId: 'system',
    senderName: '系统',
    type: 'system',
    content: '你加入了群聊',
    timestamp: worldNow,
    metadata: {
      groupEvent: 'user_joined',
      joinedUserId: 'user',
      joinedUserName,
      groupInviteResolution: 'accepted',
      joinSource: String(options.source || 'group-invite').trim() || 'group-invite',
    },
  });
  await saveMessage(notice);
  await updateChatPreview(chatId, previewFromMessage(notice), notice.timestamp);
  return updated;
}

export async function listMomentPostsForUser(userId) {
  const id = String(userId || '').trim();
  if (!id) return [];
  const byIndex = await db.getAllByIndex('momentsPosts', 'userId', id);
  const all = await db.getAllRecords('momentsPosts');
  const legacy = (Array.isArray(all) ? all : []).filter((p) => (
    p && !p.userId && String(p.ownerUserId || '') === id
  ));
  const map = new Map();
  for (const row of [...byIndex, ...legacy]) {
    if (row?.id) map.set(row.id, row);
  }
  return [...map.values()]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function listMomentPostsForAuthor(userId, authorId) {
  const uid = String(userId || '').trim();
  const aid = String(authorId || '').trim();
  if (!uid || !aid) return [];
  const byUser = await db.getAllByIndex('momentsPosts', 'userId', uid);
  return (Array.isArray(byUser) ? byUser : [])
    .filter((p) => p && String(p.authorId || '') === aid)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function saveMomentPost(post) {
  if (!post?.id) throw new Error('moment post id required');
  await db.putRecord('momentsPosts', post);
  return post;
}

export async function listMemoriesForChat(chatId, userId) {
  const rows = await db.getAllByIndex('memories', 'chatId', String(chatId || ''));
  return (Array.isArray(rows) ? rows : [])
    .filter((m) => m && (!m.userId || m.userId === userId))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function listMemoriesForUser(userId) {
  const id = String(userId || '').trim();
  if (!id) return [];
  const rows = await db.getAllByIndex('memories', 'userId', id);
  return (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function saveMemory(memory) {
  if (!memory?.id) throw new Error('memory.id required');
  if (await shouldSuppressDeletedMemory('memories', memory)) return null;
  await db.putRecord('memories', memory);
  enqueueVectorSource('memory', memory).catch(() => {});
  return memory;
}

export async function countMemoriesForChat(chatId, userId) {
  const rows = await listMemoriesForChat(chatId, userId);
  return rows.length;
}

async function clearChatDerivedCharacterState(chat, userId = '') {
  const id = String(chat?.id || '').trim();
  const uid = String(userId || chat?.userId || '').trim();
  if (!id || !uid) return;
  const actorIds = [...new Set((Array.isArray(chat?.participants) ? chat.participants : [])
    .map((actorId) => String(actorId || '').trim())
    .filter((actorId) => actorId && actorId !== 'user' && actorId !== 'system'))];
  await Promise.all(actorIds.map((actorId) => (
    clearCharacterLiveStateForChat(uid, actorId, id).catch(() => null)
  )));
}

async function clearChatStatusSnapshot(chat = null) {
  const id = String(chat?.id || '').trim();
  if (!id) return;
  const prefs = await loadChatPrefs(id).catch(() => ({}));
  const clearedActorIds = new Set((Array.isArray(chat?.participants) ? chat.participants : [])
    .map((actorId) => String(actorId || '').trim())
    .filter((actorId) => actorId && actorId !== 'user' && actorId !== 'system'));
  const actorStatusMap = Object.fromEntries(Object.entries(
    prefs?.actorStatusMap && typeof prefs.actorStatusMap === 'object' ? prefs.actorStatusMap : {},
  ).filter(([actorId]) => !clearedActorIds.has(String(actorId || '').trim())));
  await patchChatPrefs(id, {
    presenceState: 'online',
    statusText: '',
    statusSource: 'cleared_chat',
    statusUpdatedAt: 0,
    statusExpiresAt: 0,
    statusExpiredAt: Date.now(),
    actorStatusMap,
    hardOfflineState: null,
  }).catch(() => null);
}

async function deleteChatScopedRowsCompletely(storeName, chatId) {
  const id = String(chatId || '').trim();
  if (!id) return 0;
  const indexed = await db.getAllByIndex(storeName, 'chatId', id).catch(() => []);
  const indexedIds = [...new Set((Array.isArray(indexed) ? indexed : [])
    .map((row) => String(row?.id || '').trim())
    .filter(Boolean))];
  if (indexedIds.length) await db.deleteMany(storeName, indexedIds);

  // 恢复大备份或旧 WebView 索引异常时，chatId 索引可能漏行。只走索引会留下
  // 孤儿消息；同一稳定会话 id 日后再次建窗时，这些旧消息就会全部“复活”。
  // 显式删除会话属于低频操作，这里用分批主表扫描换取真正完整的删除。
  let pendingIds = [];
  let recovered = 0;
  const flush = async () => {
    if (!pendingIds.length) return;
    const batch = pendingIds;
    pendingIds = [];
    await db.deleteMany(storeName, batch);
    recovered += batch.length;
  };
  await db.forEachStoreRecordBatched(storeName, async (row) => {
    if (String(row?.chatId || '').trim() !== id || !row?.id) return;
    pendingIds.push(String(row.id));
    if (pendingIds.length >= 64) await flush();
  }, { batchSize: 32 });
  await flush();
  return indexedIds.length + recovered;
}

export async function deleteChatWithData(chatId, userId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  const chatRow = await db.getRecord('chats', id).catch(() => null);
  const ownerUserId = String(userId || chatRow?.userId || '').trim();
  const cleanupErrors = [];
  const cleanup = async (label, task) => {
    try {
      await task();
    } catch (error) {
      cleanupErrors.push({ label, error });
    }
  };
  await import('./background-scheduler.js')
    .then((mod) => mod.unscheduleChat?.(id, { cancelCloud: false }))
    .catch(() => {});
  if (ownerUserId) {
    await import('./chat/pending-actions.js')
      .then((mod) => mod.cancelPendingActions?.(ownerUserId, (action) => action.chatId === id))
      .catch(() => {});
  }
  // 先删除会话主记录，确保长按确认后列表中的会话一定消失。记忆、状态或向量等
  // 附属清理即使遇到一条旧脏数据，也只能留下可后续清理的孤儿数据，不能让整次删除失效。
  await db.deleteRecord('chats', id);
  await cleanup('messages', async () => {
    await deleteChatScopedRowsCompletely('messages', id);
  });
  await cleanup('memories', async () => {
    await deleteChatScopedRowsCompletely('memories', id);
  });
  await cleanup('event-memories', () => deleteEventMemoriesForChat(id, userId));
  await cleanup('memory-facts', () => deleteMemoryFactsForChat(id, userId));
  await cleanup('shared-knowledge', () => deleteSharedKnowledgeByChat(id));
  await cleanup('memory-vectors', () => reconcileMemoryVectorsForScope(id));
  await cleanup('character-state', () => deleteChatCharState(id));
  await cleanup('derived-character-state', () => clearChatDerivedCharacterState(chatRow, ownerUserId));
  if (ownerUserId) {
    await cleanup('ensemble-event-graph', () => import('./ensemble-mode.js')
      .then((mod) => mod.reconcileEnsembleChatAfterMessageDeletion?.(ownerUserId, id)));
  }
  if (chatRow) {
    await cleanup('ephemeral-npcs', () => deleteEphemeralNpcsForChat(chatRow));
  }
  await db.remove(`chatPrefs_${id}`).catch(() => {});
  // 清理期间若有较早启动的后台任务拿旧会话快照回写，最后再删一次主记录。
  await db.deleteRecord('chats', id);
  import('./cloud-background-coordinator.js')
    .then((mod) => mod.cancelCloudChatSchedules?.(id))
    .catch(() => {});
  if (cleanupErrors.length) {
    console.warn('[chat-store] chat deleted with partial cleanup', {
      chatId: id,
      stages: cleanupErrors.map((item) => item.label),
    });
  }
  return { deleted: true, cleanupWarnings: cleanupErrors.length };
}

export async function clearChatHistory(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return 0;
  // 先切换摘要代次；已在途的旧摘要即使稍后返回，也不能再写回刚清掉的内容。
  await markChatMemoryReset(id);
  const chatRow = await getChat(id).catch(() => null);
  const rows = await db.getAllByIndex('messages', 'chatId', id);
  const messageIds = (rows || []).map((message) => String(message?.id || '')).filter(Boolean);
  let n = 0;
  for (const m of rows || []) {
    if (m?.id) {
      await db.deleteRecord('messages', m.id);
      n += 1;
    }
  }
  await deleteChatCharState(id);
  await clearChatDerivedCharacterState(chatRow);
  await clearChatStatusSnapshot(chatRow);
  if (chatRow?.userId) {
    const cleanupTasks = [
      import('./ensemble-mode.js')
        .then((mod) => mod.reconcileEnsembleChatAfterMessageDeletion?.(chatRow.userId, id)),
    ];
    if (messageIds.length) {
      cleanupTasks.push(deleteMessageDerivedMemoryArtifacts({
        userId: chatRow.userId,
        chatId: id,
        messageIds,
      }), deleteSharedKnowledgeByMessageIds(messageIds));
    }
    await Promise.all(cleanupTasks);
  }
  await resetChatSparkDays(id).catch(() => {});
  await updateChatPreview(id, '', Date.now());
  return n;
}

/**
 * 批量移除较早聊天记录，只保留最近一段。
 * 先用复合索引读取轻量 id/时间戳，再分批删除，避免把几千条消息里的 data URL 图片
 * 一次性留在 JS 内存；同时合并写入通知，避免每删一条都让聊天页重刷。
 */
export async function pruneChatHistory(chatId, keepLatest = 500) {
  const id = String(chatId || '').trim();
  if (!id) return { deleted: 0, kept: 0 };
  const keepCount = Math.max(50, Math.min(5000, Math.round(Number(keepLatest) || 500)));
  const rows = await db.getAllByIndexRange(
    'messages',
    'chatId_timestamp',
    [id, 0],
    [id, Number.MAX_SAFE_INTEGER],
    {
      mapRecord: (message) => ({
        id: String(message?.id || ''),
        timestamp: Number(message?.timestamp || 0),
      }),
    },
  );
  const ordered = (Array.isArray(rows) ? rows : [])
    .filter((row) => row.id)
    .sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
  if (ordered.length <= keepCount) return { deleted: 0, kept: ordered.length };
  const removeIds = ordered.slice(0, ordered.length - keepCount).map((row) => row.id);
  db.setSuppressWriteNotify(true);
  try {
    for (let index = 0; index < removeIds.length; index += 40) {
      await Promise.all(removeIds.slice(index, index + 40).map((messageId) => (
        db.deleteRecord('messages', messageId)
      )));
    }
  } finally {
    db.setSuppressWriteNotify(false);
    db.flushWriteListeners();
  }
  return { deleted: removeIds.length, kept: keepCount };
}

export async function clearChatMemories(chatId, userId) {
  await markChatMemoryReset(chatId);
  const chatRow = await getChat(chatId).catch(() => null);
  const mems = await listMemoriesForChat(chatId, userId);
  for (const m of mems) {
    if (m?.id) await db.deleteRecord('memories', m.id);
  }
  await deleteEventMemoriesForChat(chatId, userId);
  await deleteMemoryFactsForChat(chatId, userId);
  await deleteSharedKnowledgeByChat(chatId);
  await reconcileMemoryVectorsForScope(chatId);
  await deleteChatCharState(chatId);
  await clearChatDerivedCharacterState(chatRow, userId);
  await clearChatStatusSnapshot(chatRow);
  return mems.length;
}

export async function toggleChatPinned(chatId) {
  const chat = await getChat(chatId);
  if (!chat) return null;
  chat.pinned = !chat.pinned;
  chat.pinnedAt = chat.pinned ? Date.now() : 0;
  return saveChat(chat);
}

// 收件箱预览只需要尾部消息：占位/孤儿消息和最新可预览消息都在末尾。
// 只用索引读最近一段，避免对每个会话整表全量扫描导致 IndexedDB 风暴拖慢导航。
const PREVIEW_SCAN_WINDOW = 40;

export async function recalcChatPreview(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  if (isChatStreaming(id)) return getChat(id);
  const page = await listMessagesPageForChat(id, { limit: PREVIEW_SCAN_WINDOW });
  const messages = page.messages;
  const orphans = messages.filter((m) =>
    m && (m.metadata?.aiPlaceholder || String(m.senderId || '') === 'ai'));
  const real = messages.filter((m) => isPreviewCandidateMessage(m));
  for (const p of orphans) {
    const hasNewerReal = real.some((m) => Number(m.timestamp || 0) >= Number(p.timestamp || 0));
    if (hasNewerReal || !real.length) {
      await db.deleteRecord('messages', p.id);
    }
  }
  const refreshed = orphans.length
    ? (await listMessagesPageForChat(id, { limit: PREVIEW_SCAN_WINDOW })).messages
    : messages;
  const last = refreshed.filter((m) => isPreviewCandidateMessage(m)).slice(-1)[0];
  if (!last) {
    // 罕见：窗口内没有可预览消息但更早还有历史，退回全量扫一次，避免误清空预览。
    if (page.hasMore) {
      const all = await listMessagesForChat(id, 0);
      const lastAll = all.filter((m) => isPreviewCandidateMessage(m)).slice(-1)[0];
      if (lastAll) return updateChatPreview(id, previewFromMessage(lastAll), lastAll.timestamp);
    }
    // 空窗：锚定创建时间，绝不能刷成 Date.now()，否则收件箱预览刷新会把空会话顶到最前。
    const chat = await getChat(id);
    if (!chat) return null;
    const idTs = Number(String(chat.id || '').match(/^chat_(\d+)/)?.[1] || 0);
    const keepTs = Number(chat.createdAt || 0) || idTs || Number(chat.lastActivity || 0) || Date.now();
    if (!String(chat.lastMessage || '').trim() && Number(chat.lastActivity || 0) === keepTs) {
      return chat;
    }
    return updateChatPreview(id, '', keepTs);
  }
  return updateChatPreview(id, previewFromMessage(last), last.timestamp);
}

export function sortChatsForInbox(chats = []) {
  return (Array.isArray(chats) ? chats : []).slice().sort((a, b) => {
    const ap = a?.pinned ? 1 : 0;
    const bp = b?.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (ap && bp) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
}
