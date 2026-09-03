/**
 * 保留角色卡，重置当前档位里某个角色产生的内容。
 *
 * 边界：
 * - 仅清当前私聊窗口的消息，保留窗口与聊天设定。
 * - 清当前档位下该角色的记忆馆。
 * - 清该角色手机、自动化、线下约会档案与手机衍生的角色间私聊。
 * - 不碰其它档位、群聊、世界书、关系设定或角色卡本身。
 */
import * as db from './db.js';
import {
  clearChatHistory,
  deleteChatWithData,
  getChat,
  listChatsForUser,
} from './chat-store.js';
import { clearActiveEvent } from './chat/active-event.js';
import { cancelPendingActions } from './chat/pending-actions.js';
import { unscheduleChat } from './background-scheduler.js';
import { loadChatPrefs, patchChatPrefs } from './chat-block-state.js';
import { isAnonymousChat } from './chat-helpers.js';
import { isStrangerInterceptChat } from './stranger-thread-model.js';
import { clearCharacterMemoryScope } from './memory/memory-scope.js';
import { pruneActorsFromRelationshipNetwork } from './relationship-network.js';
import { clearOfflineDateArchivesForCharacter } from './offline-date-archive.js';
import { clearEnsembleCharacterData } from './ensemble-mode.js';
import { markCharacterProgressReset } from './character-progress-reset-state.js';
import { getNowForUser } from './time-mode.js';

function cleanId(value) {
  return String(value || '').trim();
}

function encodedId(value) {
  return encodeURIComponent(cleanId(value));
}

export function characterSlotSettingMatches(key, userId, characterId) {
  const rawKey = String(key || '');
  const uid = encodedId(userId);
  const cid = encodedId(characterId);
  if (!rawKey || !uid || !cid) return false;

  const exactKeys = new Set([
    `characterPhone_${uid}_${cid}`,
    `characterPhoneRecordsDebug_${uid}_${cid}`,
    `characterInterestTable_${uid}_${cid}`,
    `characterInterestTracking_${uid}_${cid}`,
    `characterVerifiedPosts_${uid}_${cid}`,
    `shareImpulse_${uid}_${cid}`,
    `shareImpulseSettings_${uid}_${cid}`,
    `shareImpulseProactive_${uid}_${cid}`,
    `userSocialWatch_${uid}_${cid}`,
    `userSocialWatchPosts_${uid}_${cid}`,
    `characterPhoneAutomationConfig:${uid}:${cid}`,
    `characterPhoneAutomationRuntime:${uid}:${cid}`,
    `characterPhoneMoments:${uid}:${cid}`,
    `characterPhoneContacts:${uid}:${cid}`,
  ]);
  if (exactKeys.has(rawKey)) return true;

  const rawUid = cleanId(userId);
  const rawCid = cleanId(characterId);
  if ([
    `characterEffectiveState_${rawUid}_${rawCid}`,
    `characterLiveState_${rawUid}_${rawCid}`,
    `characterPhoneChatAuto:${rawUid}:${rawCid}`,
    `characterPhoneChatAutoState:${rawUid}:${rawCid}`,
    `characterPhoneLifeBatch:${rawUid}:${rawCid}`,
    `characterPhoneInterceptBatch:${rawUid}:${rawCid}`,
  ].includes(rawKey)) return true;

  if (rawKey.startsWith(`characterPhoneProactiveLock_${uid}_${cid}_`)) return true;
  if (new RegExp(`^characterAutonomySettings:v\\d+:${escapeRegex(uid)}:${escapeRegex(cid)}$`).test(rawKey)) return true;
  if (new RegExp(`^lifeGlimpseSettings:v\\d+:${escapeRegex(uid)}:${escapeRegex(cid)}$`).test(rawKey)) return true;
  return new RegExp(`^characterProactiveUsage:v\\d+:${escapeRegex(uid)}:${escapeRegex(cid)}$`).test(rawKey);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isResettableCharacterPrivateChat(chat, userId, characterId) {
  if (!chat || chat.type === 'group' || isAnonymousChat(chat) || isStrangerInterceptChat(chat)) return false;
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  const participants = Array.isArray(chat.participants) ? chat.participants.map(cleanId) : [];
  return !!uid && !!cid
    && cleanId(chat.userId) === uid
    && participants.includes('user')
    && participants.includes(cid);
}

function phoneContactActorIdsFromSetting(row) {
  if (!String(row?.key || '').startsWith('characterPhoneContacts:')) return [];
  return (Array.isArray(row?.value?.contacts) ? row.value.contacts : [])
    .flatMap((contact) => [
      cleanId(contact?.id),
      cleanId(contact?.linkedActorId || contact?.canonicalActorId),
    ])
    .filter((id) => /^(?:phone-contact:|lightnpc_|npc_)/i.test(id));
}

async function deleteCharacterRowsForUser(storeName, userId, characterId) {
  const rows = await db.getAllRecords(storeName).catch(() => []);
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  const ids = rows
    .filter((row) => {
      const rowUserId = cleanId(row?.userId);
      const ownerUserId = cleanId(row?.ownerUserId);
      if (rowUserId) return rowUserId === uid;
      if (ownerUserId) return ownerUserId === uid;
      return true;
    })
    .filter((row) => (
      cleanId(row?.characterId) === cid
      || cleanId(row?.authorId) === cid
      || cleanId(row?.ownerId) === cid
    ))
    .map((row) => row?.id)
    .filter(Boolean);
  if (ids.length) await db.deleteMany(storeName, ids);
  return ids.length;
}

function rowActorMatches(row, characterId) {
  const cid = cleanId(characterId);
  return !!cid && [
    row?.characterId,
    row?.authorId,
    row?.authorRoleId,
    row?.authorActorId,
    row?.ownerId,
    row?.targetActorId,
  ].some((value) => cleanId(value) === cid);
}

async function pruneCharacterForumRows(userId, characterId) {
  const rows = await db.getAllRecords('forumThreads').catch(() => []);
  const uid = cleanId(userId);
  let deleted = 0;
  let pruned = 0;
  for (const row of rows) {
    if (!row?.id || (cleanId(row.userId) && cleanId(row.userId) !== uid)) continue;
    if (rowActorMatches(row, characterId)) {
      await db.deleteRecord('forumThreads', row.id);
      deleted += 1;
      continue;
    }
    const replies = Array.isArray(row.replies) ? row.replies : [];
    const nextReplies = replies.filter((reply) => !rowActorMatches(reply, characterId));
    if (nextReplies.length === replies.length) continue;
    await db.putRecord('forumThreads', { ...row, replies: nextReplies });
    pruned += replies.length - nextReplies.length;
  }
  return deleted + pruned;
}

async function pruneCharacterAnonymousWallRows(userId, characterId) {
  const key = `anonymousWallPosts_${cleanId(userId) || 'guest'}`;
  const row = await db.get('settings', key).catch(() => null);
  const posts = Array.isArray(row?.value) ? row.value : [];
  if (!posts.length) return 0;
  let removed = 0;
  const next = [];
  for (const post of posts) {
    if (rowActorMatches(post, characterId)) {
      removed += 1;
      continue;
    }
    const comments = Array.isArray(post?.comments) ? post.comments : [];
    const nextComments = comments.filter((comment) => !rowActorMatches(comment, characterId));
    removed += comments.length - nextComments.length;
    next.push(nextComments.length === comments.length ? post : { ...post, comments: nextComments });
  }
  if (removed) await db.put('settings', { ...row, key, value: next });
  return removed;
}

async function pruneCharacterMusicRows(characterId) {
  const rows = await db.getAllRecords('musicPosts').catch(() => []);
  let removed = 0;
  for (const row of rows) {
    if (!row?.id) continue;
    if (rowActorMatches(row, characterId)) {
      await db.deleteRecord('musicPosts', row.id);
      removed += 1;
      continue;
    }
    const comments = Array.isArray(row.comments) ? row.comments : [];
    const nextComments = comments.filter((comment) => !rowActorMatches(comment, characterId));
    if (nextComments.length === comments.length) continue;
    await db.putRecord('musicPosts', { ...row, comments: nextComments });
    removed += comments.length - nextComments.length;
  }
  return removed;
}

async function deleteCharacterStreamerRows(userId, characterId) {
  const rows = await db.getAllByIndex('streamerChannels', 'userId', cleanId(userId)).catch(() => []);
  const targets = rows.filter((row) => cleanId(row?.characterId) === cleanId(characterId));
  if (!targets.length) return 0;
  const { deleteStreamerChannel } = await import('./streamer-store.js');
  for (const row of targets) await deleteStreamerChannel(row.id);
  return targets.length;
}

async function resetDailyScheduleGenerationState(characterId) {
  const row = await db.get('settings', 'dailyScheduleGenState').catch(() => null);
  const value = row?.value && typeof row.value === 'object' ? row.value : null;
  const doneCharacterIds = Array.isArray(value?.doneCharacterIds) ? value.doneCharacterIds : [];
  const nextIds = doneCharacterIds.filter((id) => cleanId(id) !== cleanId(characterId));
  if (!value || nextIds.length === doneCharacterIds.length) return false;
  await db.put('settings', {
    ...row,
    key: 'dailyScheduleGenState',
    value: { ...value, doneCharacterIds: nextIds },
  });
  return true;
}

export async function resetCharacterSlotProgress({ userId, characterId, chatId } = {}) {
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  const currentChatId = cleanId(chatId);
  if (!uid || !cid || !currentChatId) throw new Error('缺少角色清除范围');

  const chat = await getChat(currentChatId);
  if (!isResettableCharacterPrivateChat(chat, uid, cid)) {
    throw new Error('只能清除当前档位下的普通角色私聊');
  }

  // 必须先写重置代次：旧摘要即使已经发出请求，也会在回写前发现代次变化并作废。
  const resetWorldAt = await getNowForUser(uid).catch(() => Date.now());
  await markCharacterProgressReset(uid, cid, currentChatId, { resetAt: resetWorldAt });
  const allChats = await listChatsForUser(uid);
  const relatedPrivateChats = allChats.filter((row) => (
    row?.id
    && row.type !== 'group'
    && Array.isArray(row.participants)
    && row.participants.map(cleanId).includes(cid)
  ));
  const relatedPrivateChatIds = [...new Set([
    currentChatId,
    ...relatedPrivateChats.map((row) => cleanId(row.id)).filter(Boolean),
  ])];
  const [{ abortHeadlessChatReply }, { cancelCloudChatGeneration }] = await Promise.all([
    import('./chat/headless-reply.js'),
    import('./cloud-background-coordinator.js'),
  ]);
  for (const relatedChatId of relatedPrivateChatIds) {
    abortHeadlessChatReply(relatedChatId, 'character-progress-reset');
    unscheduleChat(relatedChatId);
  }
  await Promise.all(relatedPrivateChatIds.map((relatedChatId) => (
    cancelCloudChatGeneration(relatedChatId, 'character-progress-reset').catch(() => null)
  )));
  await cancelPendingActions(uid, (action) => (
    cleanId(action?.chatId) === currentChatId || cleanId(action?.characterId) === cid
  )).catch(() => null);

  const messagesDeleted = await clearChatHistory(currentChatId);
  await clearActiveEvent(currentChatId);
  const chatPrefs = await loadChatPrefs(currentChatId).catch(() => ({}));
  const actorStatusMap = { ...(chatPrefs.actorStatusMap || {}) };
  delete actorStatusMap[cid];
  await patchChatPrefs(currentChatId, {
    presenceState: 'online',
    statusText: '',
    statusSource: '',
    statusUpdatedAt: 0,
    statusExpiresAt: 0,
    statusExpiredAt: 0,
    actorStatusMap,
  });

  const phonePeerChats = allChats.filter((row) => {
    if (!row?.id || row.id === currentChatId || row.type === 'group' || isAnonymousChat(row)) return false;
    const participants = Array.isArray(row.participants) ? row.participants.map(cleanId) : [];
    return participants.includes(cid) && !participants.includes('user');
  });
  for (const row of phonePeerChats) {
    await deleteChatWithData(row.id, uid);
  }
  const ensembleResult = await clearEnsembleCharacterData(
    uid,
    cid,
    [currentChatId, ...phonePeerChats.map((row) => row.id)],
  );

  const memoryResult = await clearCharacterMemoryScope(uid, cid);
  const offlineArchiveResult = await clearOfflineDateArchivesForCharacter(uid, cid);
  const settings = await db.getAllRecords('settings');
  const matchingSettings = settings.filter((row) => characterSlotSettingMatches(row?.key, uid, cid));
  const phoneContactActorIds = new Set(matchingSettings.flatMap(phoneContactActorIdsFromSetting));
  for (const row of matchingSettings) {
    await db.deleteRecord('settings', row.key);
  }
  await resetDailyScheduleGenerationState(cid);
  await Promise.all([
    db.deleteRecord('settings', `offlineSession_${currentChatId}`).catch(() => null),
    db.deleteRecord('settings', `offlineSessionMirror_${currentChatId}`).catch(() => null),
  ]);

  for (const actorId of phoneContactActorIds) {
    await clearCharacterMemoryScope(uid, actorId).catch(() => null);
  }
  if (phoneContactActorIds.size) {
    await pruneActorsFromRelationshipNetwork([...phoneContactActorIds]).catch(() => null);
  }

  const [
    storiesDeleted,
    momentsDeleted,
    weiboDeleted,
    forumDeleted,
    anonymousWallDeleted,
    musicDeleted,
    streamerDeleted,
  ] = await Promise.all([
    deleteCharacterRowsForUser('auStories', uid, cid),
    deleteCharacterRowsForUser('momentsPosts', uid, cid),
    deleteCharacterRowsForUser('weiboPosts', uid, cid),
    pruneCharacterForumRows(uid, cid),
    pruneCharacterAnonymousWallRows(uid, cid),
    pruneCharacterMusicRows(cid),
    deleteCharacterStreamerRows(uid, cid),
  ]);

  return {
    messagesDeleted,
    memoryEntriesDeleted: Number(memoryResult?.deleted || 0),
    offlineArchivesDeleted: Number(offlineArchiveResult?.removed || 0),
    offlineArchivesPruned: Number(offlineArchiveResult?.pruned || 0),
    phoneSettingsDeleted: matchingSettings.length,
    phoneChatsDeleted: phonePeerChats.length,
    relatedRowsDeleted: storiesDeleted + momentsDeleted + weiboDeleted
      + forumDeleted + anonymousWallDeleted + musicDeleted + streamerDeleted,
    ensembleNodesDeleted: Number(ensembleResult?.nodesRemoved || 0),
    ensembleThreadsDeleted: Number(ensembleResult?.threadsRemoved || 0),
    ensembleResourcesDeleted: Number(ensembleResult?.resourcesRemoved || 0),
    ensembleSituationsDeleted: Number(ensembleResult?.situationsRemoved || 0),
    ensembleIdentityStatesDeleted: Number(ensembleResult?.identityStatesRemoved || 0),
  };
}
