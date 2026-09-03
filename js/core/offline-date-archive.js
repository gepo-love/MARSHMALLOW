/**
 * 线下约会档案 · 一次线下 = 一份小档案（轮次原文 + 摘要），与小剧场卡分离。
 */
import { get as dbGet, put as dbPut, remove as dbRemove, getRecord } from './db.js';
import { isTransientApiError } from './api.js';
import { chatJsonGeneration } from './chat-json-generation.js';
import { getNowForUser } from './time-mode.js';
import { saveMemory } from './chat-store.js';
import { createMemory } from '../models/memory.js';
import { getCharacterAiContextName } from '../models/character.js';
import { getUserDisplayName } from '../models/user.js';
import { buildUnusedOfflineBranchArchives } from './offline-branch-snapshot.js';
import {
  deleteVectorSourcesByPrefix,
  enqueueVectorSource,
  enqueueVectorSources,
} from './memory/memory-vectors.js';
import { buildOfflineArchivePassageSources } from './memory/vector-passages.js';
import { buildOfflineAttributionBoundary } from './memory/offline-attribution.js';
import { effectiveOfflineCheckpointSummaries } from './offline-checkpoint-memory.js';
import { collectOfflineSceneMediaStats } from './offline-scene-video-export.js';
import { classifyOfflineErrorReason } from './offline-error-classification.js';


function genId(prefix = 'oda') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function storeKey(userId) {
  return `offlineDateArchives_${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function mediaStoreKey(userId, archiveId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const aid = encodeURIComponent(String(archiveId || '').trim());
  return `offlineDateArchiveMedia_${uid}_${aid}`;
}

function roundMedia(round = {}) {
  const media = {};
  if (round.image && typeof round.image === 'object') media.image = { ...round.image };
  if (Array.isArray(round.voiceLines) && round.voiceLines.length) {
    media.voiceLines = round.voiceLines.map((line) => ({
      ...line,
      ...(line?.speechPlan && typeof line.speechPlan === 'object' ? { speechPlan: { ...line.speechPlan } } : {}),
      ...(line?.audio && typeof line.audio === 'object' ? { audio: { ...line.audio } } : {}),
    }));
  }
  if (round.aiImagePrompt) media.aiImagePrompt = String(round.aiImagePrompt);
  if (Array.isArray(round.htmlWidgets) && round.htmlWidgets.length) {
    media.htmlWidgets = round.htmlWidgets.map((item) => ({ ...item }));
  }
  return media;
}

export function splitOfflineArchiveMedia(archive = {}) {
  const mediaRounds = {};
  const rounds = (Array.isArray(archive.rounds) ? archive.rounds : []).map((round) => {
    const media = roundMedia(round);
    if (Object.keys(media).length) mediaRounds[String(round.id || '')] = media;
    const {
      image: _image,
      voiceLines: _voiceLines,
      aiImagePrompt: _aiImagePrompt,
      htmlWidgets: _htmlWidgets,
      ...lightRound
    } = round;
    return lightRound;
  });
  const background = String(archive?.scene?.audioSceneBackground || '');
  const scene = archive.scene && typeof archive.scene === 'object'
    ? { ...archive.scene, audioSceneBackground: '' }
    : archive.scene;
  return {
    archive: { ...archive, scene, rounds },
    media: background || Object.keys(mediaRounds).length ? {
      version: 1,
      archiveId: String(archive.id || ''),
      audioSceneBackground: background,
      rounds: mediaRounds,
      updatedAt: Date.now(),
    } : null,
  };
}

export function hydrateOfflineArchiveMedia(archive = {}, media = null) {
  if (!media || typeof media !== 'object') return archive;
  const mediaRounds = media.rounds && typeof media.rounds === 'object' ? media.rounds : {};
  return {
    ...archive,
    scene: archive.scene && typeof archive.scene === 'object'
      ? {
        ...archive.scene,
        ...(media.audioSceneBackground ? { audioSceneBackground: String(media.audioSceneBackground) } : {}),
      }
      : archive.scene,
    rounds: (Array.isArray(archive.rounds) ? archive.rounds : []).map((round) => ({
      ...round,
      ...(mediaRounds[String(round.id || '')] || {}),
    })),
  };
}

function archiveRoundBoundary(archive = {}) {
  const rounds = Array.isArray(archive?.rounds) ? archive.rounds : [];
  return {
    count: rounds.length,
    firstId: String(rounds[0]?.id || '').trim(),
  };
}

/** 同一场线下重试收纳时复用原档案；兼容旧失败档案尚未保存 sourceSessionId 的情况。 */
export function isSameOfflineArchiveSource(left = {}, right = {}) {
  const leftId = String(left?.id || '').trim();
  const rightId = String(right?.id || '').trim();
  if (leftId && rightId && leftId === rightId) return true;
  const leftSessionId = String(left?.sourceSessionId || '').trim();
  const rightSessionId = String(right?.sourceSessionId || '').trim();
  if (leftSessionId && rightSessionId) return leftSessionId === rightSessionId;
  const leftChatId = String(left?.chatId || '').trim();
  const rightChatId = String(right?.chatId || '').trim();
  if (!leftChatId || leftChatId !== rightChatId) return false;
  const leftStart = Number(left?.startedAtWorld || left?.startedAt || 0);
  const rightStart = Number(right?.startedAtWorld || right?.startedAt || 0);
  if (!leftStart || leftStart !== rightStart) return false;
  const leftBoundary = archiveRoundBoundary(left);
  const rightBoundary = archiveRoundBoundary(right);
  return leftBoundary.count > 0
    && rightBoundary.count > 0
    && !!leftBoundary.firstId
    && leftBoundary.firstId === rightBoundary.firstId;
}

export function formatArchiveTitle(ts, characterNames, scene = {}, userPresent = true) {
  const d = new Date(Number(ts) || Date.now());
  const dateLabel = d.toLocaleString('zh-CN', {
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const place = String(scene.place || scene.goal || '线下约会').trim().slice(0, 24);
  const names = (Array.isArray(characterNames) ? characterNames : [characterNames])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  return `${userPresent ? '与 ' : ''}${names.join('、') || 'TA'} · ${dateLabel} · ${place}`;
}

/**
 * 旧版自动标题曾误用设备真实时间；档案的 startedAtWorld / startedAt 才是展示用剧情时间。
 * 只修正仍保持完整自动标题结构、且没有人工编辑标记的记录，避免覆盖用户自定义标题。
 */
export function normalizeOfflineArchiveWorldTimeTitle(archive = {}) {
  if (!archive || typeof archive !== 'object') return archive;
  const startedAtWorld = Number(archive.startedAtWorld || archive.startedAt || 0);
  if (!startedAtWorld || archive.titleEditedAt) return archive;
  const title = String(archive.title || '').trim();
  const names = (Array.isArray(archive.participantNames)
    ? archive.participantNames
    : [archive.characterName])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const prefix = `${archive.userPresent === false ? '' : '与 '}${names.join('、') || 'TA'} · `;
  const place = String(archive.scene?.place || archive.scene?.goal || '线下约会').trim().slice(0, 24);
  const suffix = ` · ${place}`;
  if (!title.startsWith(prefix) || !title.endsWith(suffix)) return archive;
  const middle = title.slice(prefix.length, title.length - suffix.length);
  if (!/^\d{1,2}月\d{1,2}日\s+\d{2}:\d{2}$/.test(middle)) return archive;
  const worldTitle = formatArchiveTitle(
    startedAtWorld,
    names,
    archive.scene,
    archive.userPresent !== false,
  );
  return worldTitle === title ? archive : { ...archive, title: worldTitle };
}

async function listAllOfflineDateArchivesRaw(userId) {
  const row = await dbGet('settings', storeKey(userId));
  return Array.isArray(row?.value) ? row.value : [];
}

export async function listOfflineDateArchives(userId, { characterId = '' } = {}) {
  const list = await listAllOfflineDateArchivesRaw(userId);
  const cid = String(characterId || '').trim();
  return list
    .map((item) => normalizeOfflineArchiveWorldTimeTitle(item))
    .filter((item) => {
      if (!cid) return true;
      if (String(item.characterId || '') === cid) return true;
      // 多人线下：参与者任意一人都能看到这份档案
      return Array.isArray(item.participantIds) && item.participantIds.includes(cid);
    })
    .sort((a, b) => {
      const af = a.favorite ? 1 : 0;
      const bf = b.favorite ? 1 : 0;
      if (af !== bf) return bf - af;
      return (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0);
    });
}

export async function getOfflineDateArchive(userId, archiveId) {
  const id = String(archiveId || '').trim();
  if (!id) return null;
  const list = await listAllOfflineDateArchivesRaw(userId);
  const archive = normalizeOfflineArchiveWorldTimeTitle(list.find((item) => item.id === id) || null);
  if (!archive) return null;
  const row = await dbGet('settings', mediaStoreKey(userId, id)).catch(() => null);
  return hydrateOfflineArchiveMedia(archive, row?.value || null);
}

async function saveOfflineDateArchive(userId, archive) {
  const list = await listAllOfflineDateArchivesRaw(userId);
  const savedArchive = { ...archive, updatedAt: Date.now() };
  const split = splitOfflineArchiveMedia(savedArchive);
  if (split.media) {
    await dbPut('settings', { key: mediaStoreKey(userId, archive.id), value: split.media });
  }
  const candidates = [
    split.archive,
    ...list.filter((item) => !isSameOfflineArchiveSource(item, archive)),
  ];
  const next = candidates.slice(0, 120);
  await dbPut('settings', { key: storeKey(userId), value: next });
  const retainedIds = new Set(next.map((item) => String(item?.id || '')).filter(Boolean));
  const droppedIds = candidates
    .map((item) => String(item?.id || ''))
    .filter((id) => id && !retainedIds.has(id));
  await Promise.all(droppedIds.map((id) => dbRemove(mediaStoreKey(userId, id)).catch(() => {})));
  return savedArchive;
}

/** 由已经通过格式校验的角色时光档案恢复单条线下记录。 */
export async function restoreOfflineDateArchive(userId, archive) {
  if (!archive?.id) throw new Error('线下档案缺少 id');
  return saveOfflineDateArchive(userId, { ...archive, userId: String(userId || '').trim() });
}

/** 收藏切换：收藏的记录在列表里优先置顶。 */
export async function toggleOfflineDateArchiveFavorite(userId, archiveId) {
  const id = String(archiveId || '').trim();
  const archive = (await listAllOfflineDateArchivesRaw(userId)).find((item) => item.id === id) || null;
  if (!archive) return null;
  await saveOfflineDateArchive(userId, { ...archive, favorite: !archive.favorite });
  return getOfflineDateArchive(userId, id);
}

export async function deleteOfflineDateArchive(userId, archiveId) {
  const id = String(archiveId || '').trim();
  if (!id) return;
  const list = await listAllOfflineDateArchivesRaw(userId);
  await dbPut('settings', { key: storeKey(userId), value: list.filter((item) => item.id !== id) });
  await dbRemove(mediaStoreKey(userId, id)).catch(() => {});
  await deleteVectorSourcesByPrefix('archive', id).catch(() => {});
}

function removeActorFromPairedLists(ids = [], names = [], characterId = '') {
  const cid = String(characterId || '').trim();
  const keptIds = [];
  const keptNames = [];
  (Array.isArray(ids) ? ids : []).forEach((id, index) => {
    if (String(id || '').trim() === cid) return;
    keptIds.push(id);
    if (Array.isArray(names) && index < names.length) keptNames.push(names[index]);
  });
  return { ids: keptIds, names: keptNames };
}

export function pruneOfflineDateArchivesForCharacter(archives = [], characterId = '') {
  const cid = String(characterId || '').trim();
  if (!cid) return { archives: Array.isArray(archives) ? archives : [], removedIds: [], prunedIds: [] };
  const kept = [];
  const removedIds = [];
  const prunedIds = [];
  for (const archive of (Array.isArray(archives) ? archives : [])) {
    if (!archive?.id) {
      kept.push(archive);
      continue;
    }
    const actorIds = new Set([
      archive.characterId,
      ...(Array.isArray(archive.participantIds) ? archive.participantIds : []),
      ...(Array.isArray(archive.allEverParticipantIds) ? archive.allEverParticipantIds : []),
      ...(Array.isArray(archive.knownByActorIds) ? archive.knownByActorIds : []),
      ...(Array.isArray(archive.participantSnapshot?.actorIds) ? archive.participantSnapshot.actorIds : []),
      ...(Array.isArray(archive.attendance?.members)
        ? archive.attendance.members.map((member) => member?.characterId)
        : []),
      ...(Array.isArray(archive.characterMemories)
        ? archive.characterMemories.map((memory) => memory?.characterId)
        : []),
    ].map((id) => String(id || '').trim()).filter(Boolean));
    if (!actorIds.has(cid)) {
      kept.push(archive);
      continue;
    }

    const participants = removeActorFromPairedLists(
      archive.participantIds,
      archive.participantNames,
      cid,
    );
    if (!participants.ids.length) {
      removedIds.push(archive.id);
      continue;
    }
    const snapshot = removeActorFromPairedLists(
      archive.participantSnapshot?.actorIds,
      archive.participantSnapshot?.names,
      cid,
    );
    const next = {
      ...archive,
      characterId: String(archive.characterId || '') === cid
        ? String(participants.ids[0] || '')
        : archive.characterId,
      characterName: String(archive.characterId || '') === cid
        ? String(participants.names[0] || participants.ids[0] || '')
        : archive.characterName,
      participantIds: participants.ids,
      participantNames: participants.names,
      allEverParticipantIds: (Array.isArray(archive.allEverParticipantIds)
        ? archive.allEverParticipantIds
        : []).filter((id) => String(id || '').trim() !== cid),
      knownByActorIds: (Array.isArray(archive.knownByActorIds)
        ? archive.knownByActorIds
        : []).filter((id) => String(id || '').trim() !== cid),
      participantSnapshot: archive.participantSnapshot
        ? {
          ...archive.participantSnapshot,
          actorIds: snapshot.ids,
          names: snapshot.names,
        }
        : archive.participantSnapshot,
      attendance: archive.attendance
        ? {
          ...archive.attendance,
          members: (Array.isArray(archive.attendance.members)
            ? archive.attendance.members
            : []).filter((member) => String(member?.characterId || '').trim() !== cid),
        }
        : archive.attendance,
      characterMemories: (Array.isArray(archive.characterMemories)
        ? archive.characterMemories
        : []).filter((memory) => String(memory?.characterId || '').trim() !== cid),
      updatedAt: Date.now(),
    };
    kept.push(next);
    prunedIds.push(archive.id);
  }
  return { archives: kept, removedIds, prunedIds };
}

export async function clearOfflineDateArchivesForCharacter(userId, characterId) {
  const result = pruneOfflineDateArchivesForCharacter(
    await listAllOfflineDateArchivesRaw(userId),
    characterId,
  );
  if (!result.removedIds.length && !result.prunedIds.length) {
    return { removed: 0, pruned: 0 };
  }
  await dbPut('settings', { key: storeKey(userId), value: result.archives });
  await Promise.all(result.removedIds.map((archiveId) => (
    dbRemove(mediaStoreKey(userId, archiveId)).catch(() => {})
  )));
  const touchedIds = [...result.removedIds, ...result.prunedIds];
  for (const archiveId of touchedIds) {
    await deleteVectorSourcesByPrefix('archive', archiveId).catch(() => {});
  }
  for (const archive of result.archives.filter((item) => result.prunedIds.includes(item?.id))) {
    enqueueVectorSource('archive', {
      ...archive,
      content: [archive.title, archive.currentState, archive.summary, archive.digest?.story].filter(Boolean).join('\n'),
    }).catch(() => {});
    enqueueVectorSources('archive', buildOfflineArchivePassageSources(archive)).catch(() => {});
  }
  return { removed: result.removedIds.length, pruned: result.prunedIds.length };
}

async function syncOfflineArchiveDerivedState(userId, archive) {
  const participantIds = Array.isArray(archive?.participantIds)
    ? archive.participantIds.filter(Boolean)
    : [archive?.characterId].filter(Boolean);
  const characterMemories = participantIds.map((characterId, index) => buildOfflineCharacterMemory({
    characterId,
    characterName: archive?.participantNames?.[index] || characterId,
    participantIds,
    participantNames: archive?.participantNames || [],
    rounds: archive?.rounds || [],
    summary: archive?.summary || '',
    digest: archive?.digest || null,
    userPresent: archive?.userPresent !== false,
  }));
  const next = { ...archive, characterMemories };
  const saved = await saveOfflineDateArchive(userId, next);

  for (const characterId of participantIds) {
    const ownedMemory = characterMemories.find((item) => item.characterId === characterId);
    const memory = createMemory({
      id: participantIds.length > 1
        ? `mem_oda_${saved.id}_${characterId}`
        : `mem_oda_${saved.id}`,
      userId,
      chatId: saved.chatId,
      characterId,
      type: 'event',
      category: 'shared',
      content: ownedMemory?.content || saved.summary,
      importance: 'high',
      timestamp: saved.endedAt,
      source: 'offline_date',
    });
    memory.offlineDateArchiveId = saved.id;
    memory.archivedAtReal = Number(saved.archivedAtReal || 0) || Date.now();
    memory.archiveTitle = saved.title;
    memory.offlineDateVisibility = ownedMemory?.visibility || [];
    memory.knownByActorIds = [characterId];
    memory.participantSnapshot = saved.participantSnapshot;
    await saveMemory(memory);
  }

  await deleteVectorSourcesByPrefix('archive', saved.id).catch(() => {});
  await enqueueVectorSource('archive', {
    ...saved,
    content: [saved.title, saved.currentState, saved.summary, saved.digest?.story].filter(Boolean).join('\n'),
  }).catch(() => {});
  await enqueueVectorSources('archive', buildOfflineArchivePassageSources(saved)).catch(() => {});

  const { applyOfflineSummaryScheduleOverride } = await import('./chat/offline-invite-schedule.js');
  for (const characterId of participantIds) {
    const ownedMemory = characterMemories.find((item) => item.characterId === characterId);
    await applyOfflineSummaryScheduleOverride({
      userId,
      characterId,
      startTs: saved.startedAtWorld || saved.startedAt,
      endTs: saved.endedAt,
      summary: saved.summary,
      place: saved.scene?.place || '',
      activity: saved.scene?.goal || (saved.userPresent === false ? '角色线下同行' : ''),
      sourceId: saved.id,
      replaceSourceId: saved.id,
      eventContext: {
        archiveId: saved.id,
        participantIds,
        participantNames: saved.participantNames || [],
        summary: saved.summary,
        memory: ownedMemory?.content || '',
        quotes: saved.digest?.quotes || [],
        relationshipShifts: saved.digest?.shifts || [],
        hooks: saved.digest?.hooks || [],
        items: saved.digest?.items || [],
      },
    }).catch(() => {});
  }
  if (saved.activitySessionId) {
    const { getActivitySession, saveActivitySession } = await import('./activity-sessions.js');
    const activity = await getActivitySession(userId, saved.activitySessionId).catch(() => null);
    if (activity) {
      await saveActivitySession(activity.userId || userId, {
        ...activity,
        outputs: (activity.outputs || []).map((item) => (
          String(item?.archiveId || item?.id || '') === String(saved.id)
            ? { ...item, title: saved.title, summary: saved.summary }
            : item
        )),
        detailCards: (activity.detailCards || []).map((item) => (
          String(item?.id || '') === String(saved.id)
            ? { ...item, title: saved.title, summary: saved.summary }
            : item
        )),
      }).catch(() => {});
    }
  }
  return saved;
}

/** 更新线下约会档案标题/摘要，并同步共同回忆、向量片段和角色日程。 */
export async function updateOfflineDateArchive(userId, archiveId, patch = {}) {
  const id = String(archiveId || '').trim();
  const archive = patch.summary != null || patch.currentState != null
    ? await getOfflineDateArchive(userId, id)
    : (await listAllOfflineDateArchivesRaw(userId)).find((item) => item.id === id) || null;
  if (!archive) return null;
  const next = { ...archive };
  if (patch.title != null) {
    next.title = String(patch.title || '').trim().slice(0, 120);
    next.titleEditedAt = Date.now();
  }
  if (patch.summary != null) {
    next.summary = String(patch.summary || '').trim().slice(0, 4000);
    next.digest = next.digest
      ? {
        ...next.digest,
        memory: next.summary,
        story: next.summary,
        quotes: [],
        shifts: [],
        items: [],
        hooks: [],
      }
      : buildFallbackOfflineDossier(next.summary, next.participantNames);
    next.summaryEditedAt = Date.now();
  }
  if (patch.currentState != null) {
    next.currentState = String(patch.currentState || '').trim().slice(0, 600);
    next.digest = next.digest
      ? { ...next.digest, currentState: next.currentState }
      : { ...buildFallbackOfflineDossier(next.summary, next.participantNames), currentState: next.currentState };
    next.currentStateEditedAt = Date.now();
  }
  if (patch.summary != null || patch.currentState != null) return syncOfflineArchiveDerivedState(userId, next);
  return saveOfflineDateArchive(userId, next);
}

/** 从档案保存的完整轮次重新生成卷宗与摘要，并覆盖所有派生记忆。 */
export async function regenerateOfflineDateArchiveSummary(userId, archiveId, { user = null } = {}) {
  const archive = await getOfflineDateArchive(userId, archiveId);
  if (!archive) throw new Error('线下档案不存在');
  const session = {
    id: `archive_regen_${archive.id}`,
    userId,
    chatId: archive.chatId,
    scene: { ...(archive.scene || {}) },
    beats: (archive.rounds || []).map((round) => ({
      ...round,
      role: round.role || 'narration',
      text: String(round.text || '').trim(),
    })),
    checkpointSummaries: [],
    checkpointRollup: null,
  };
  if (!session.beats.some((beat) => beat.role === 'narration' && beat.text)) {
    throw new Error('这份档案没有可重新总结的过程记录');
  }
  const joined = buildJoinedProcessText(session);
  const digest = await generateOfflineDossier({
    session,
    joined,
    sceneBits: buildSceneBits(session),
    participantIds: archive.participantIds || [],
    participantNames: archive.participantNames || [],
    userName: getUserDisplayName(user) || '用户',
  });
  let summary = digest?.memory || digest?.story?.slice(0, 240) || '';
  if (!summary) {
    summary = buildOfflineTransportFallbackSummary(session, archive.participantNames || []);
  }
  return syncOfflineArchiveDerivedState(userId, {
    ...archive,
    summary,
    currentState: String(digest?.currentState ?? archive.currentState ?? '').trim(),
    digest: digest || buildFallbackOfflineDossier(summary, archive.participantNames),
    summaryRegeneratedAt: Date.now(),
  });
}

export function beatsToRounds(beats = []) {
  return (Array.isArray(beats) ? beats : [])
    .filter((b) => b?.role !== 'daymark')
    .map((b) => ({
      id: String(b.id || genId('rnd')),
      role: ['directive', 'opening', 'interlude'].includes(b.role) ? b.role : 'narration',
      text: String(b.text || '').trim(),
      ts: Number(b.ts || 0) || 0,
      ...(b.notice && typeof b.notice === 'object' ? { notice: b.notice } : {}),
      ...(b.attendanceEvent && typeof b.attendanceEvent === 'object'
        ? { attendanceEvent: { ...b.attendanceEvent } }
        : {}),
      ...(b.attendanceDecision && typeof b.attendanceDecision === 'object'
        ? { attendanceDecision: { ...b.attendanceDecision } }
        : {}),
      ...(Array.isArray(b.options) && b.options.length ? {
        options: b.options.map((value) => String(value || '').trim()).filter(Boolean),
      } : {}),
      ...(b.image && typeof b.image === 'object' ? {
        image: {
          url: String(b.image.url || ''),
          prompt: String(b.image.prompt || ''),
          styleId: String(b.image.styleId || ''),
          warning: String(b.image.warning || ''),
          error: String(b.image.error || ''),
          referenceSkipped: b.image.referenceSkipped === true,
          referenceSubmittedCount: Math.max(0, Number(b.image.referenceSubmittedCount || 0) || 0),
          referenceSubjectIds: Array.isArray(b.image.referenceSubjectIds) ? [...b.image.referenceSubjectIds] : [],
          referenceSubmittedSubjectIds: Array.isArray(b.image.referenceSubmittedSubjectIds) ? [...b.image.referenceSubmittedSubjectIds] : [],
        },
      } : {}),
      ...(Array.isArray(b.voiceLines) && b.voiceLines.length ? {
        voiceLines: b.voiceLines.map((line) => ({
          actorId: String(line?.actorId || ''),
          actorName: String(line?.actorName || ''),
          text: String(line?.text || ''),
          ...(line?.speechPlan && typeof line.speechPlan === 'object' ? { speechPlan: { ...line.speechPlan } } : {}),
          ...(line?.audio?.dataUrl ? {
            audio: {
              dataUrl: String(line.audio.dataUrl),
              mimeType: String(line.audio.mimeType || ''),
            },
          } : {}),
        })),
      } : {}),
      ...(b.aiImagePrompt ? { aiImagePrompt: String(b.aiImagePrompt) } : {}),
      ...(Array.isArray(b.htmlWidgets) && b.htmlWidgets.length ? {
        htmlWidgets: b.htmlWidgets.map((row) => ({ ...row })),
      } : {}),
    })).filter((b) => b.text);
}

async function participantNamesForIds(ids = []) {
  const uniqueIds = [...new Set(ids.map((id) => String(id || '').trim()).filter((id) => id && id !== 'user'))];
  const names = [];
  for (const id of uniqueIds) {
    const row = await getRecord('characters', id).catch(() => null);
    names.push(getCharacterAiContextName(row, id));
  }
  return { ids: uniqueIds, names };
}

function cloneAttendance(session, fallbackIds = []) {
  const source = session?.attendance;
  const members = Array.isArray(source?.members)
    ? source.members
    : fallbackIds.map((characterId) => ({
      characterId,
      status: 'active',
      source: 'legacy_archive',
      joinedAt: Number(session?.startedAtReal || session?.createdAt || 0) || null,
      leftAt: null,
      joinedBeatId: '',
      leftBeatId: '',
      history: [],
    }));
  return {
    version: Number(source?.version || 1) || 1,
    archivedAt: Date.now(),
    members: members.map((member) => ({
      characterId: String(member?.characterId || member?.id || '').trim(),
      status: String(member?.status || 'active'),
      source: String(member?.source || 'legacy'),
      joinedAt: Number(member?.joinedAt || 0) || null,
      leftAt: Number(member?.leftAt || 0) || null,
      joinedBeatId: String(member?.joinedBeatId || ''),
      leftBeatId: String(member?.leftBeatId || ''),
      history: Array.isArray(member?.history)
        ? member.history.map((entry) => ({ ...entry }))
        : [],
    })).filter((member) => member.characterId),
  };
}

function attendanceMemberEverActive(member = {}) {
  if (member.status === 'active' || member.joinedAt || member.joinedBeatId) return true;
  return (Array.isArray(member.history) ? member.history : []).some((entry) =>
    entry?.status === 'active' || entry?.joinedAt || entry?.joinedBeatId);
}

/**
 * 从归档过程里的 attendance 节点重建角色在场区间。
 * 区间端点包含加入/离场节点本身，确保角色知道自己到场与离场的事实。
 */
export function deriveOfflineVisibilityIntervals(rounds = [], characterId = '') {
  const cid = String(characterId || '').trim();
  const events = rounds
    .map((round, index) => ({ round, index }))
    .filter(({ round }) => String(round?.attendanceEvent?.characterId || '') === cid);
  const intervals = [];
  const firstStatus = String(events[0]?.round?.attendanceEvent?.status || '');
  let start = events.length ? (firstStatus === 'left' ? 0 : null) : 0;
  for (const { round, index } of events) {
    const status = String(round.attendanceEvent?.status || '');
    if (status === 'active') {
      if (start == null) start = index;
    } else if (status === 'left') {
      if (start != null) intervals.push({ startIndex: start, endIndex: index });
      start = null;
    }
  }
  if (start != null && rounds.length) intervals.push({ startIndex: start, endIndex: rounds.length - 1 });
  return intervals;
}

export function filterOfflineRoundsForCharacter(rounds = [], characterId = '') {
  const intervals = deriveOfflineVisibilityIntervals(rounds, characterId);
  return rounds.filter((_round, index) => intervals.some((range) =>
    index >= range.startIndex && index <= range.endIndex));
}

function compactVisibleProcess(rounds = [], limit = 3600, userPresent = true) {
  const lines = rounds.map((round) => {
    if (round.attendanceEvent) return `现场变化：${round.text}`;
    if (round.role === 'opening') return `开场：${round.text}`;
    if (round.role === 'directive') return `${userPresent ? '用户方向' : '旁观方向'}：${round.text}`;
    if (round.role === 'interlude') return `现场插曲：${round.text}`;
    return `过程：${round.text}`;
  }).filter(Boolean);
  const text = lines.join('\n');
  if (text.length <= limit) return text;
  // 超长时保尾不保头：线下的结尾是回线上后最需要承接的部分，开头交给摘要/卷宗覆盖。
  let tail = text.slice(-limit);
  const firstBreak = tail.indexOf('\n');
  if (firstBreak > 0 && firstBreak < 120) tail = tail.slice(firstBreak + 1);
  return `（更早经过见摘要）…${tail}`;
}

export function buildOfflineCharacterMemory({
  characterId = '',
  characterName = 'TA',
  participantIds = [],
  participantNames = [],
  rounds = [],
  summary = '',
  digest = null,
  userPresent = true,
} = {}) {
  const intervals = deriveOfflineVisibilityIntervals(rounds, characterId);
  const visibleRounds = filterOfflineRoundsForCharacter(rounds, characterId);
  const coversAll = !!rounds.length
    && intervals.length === 1
    && intervals[0].startIndex === 0
    && intervals[0].endIndex === rounds.length - 1;
  // 全程在场：卷宗（摘要 + 剧情复盘）当主体，原文只保留结尾一小段当前情提要，
  // 回线上后最需要承接的正是线下最后发生的事。中途进出的角色没有可用的全场卷宗，
  // 仍按在场区间机械拼原文（compactVisibleProcess 超长时同样保尾）。
  let content = '';
  const attributionBoundary = buildOfflineAttributionBoundary({
    currentCharacterId: characterId,
    currentCharacterName: characterName,
    participantIds,
    participantNames,
    quotes: digest?.quotes || [],
  });
  if (coversAll && summary) {
    const story = String(digest?.story || '').trim();
    const currentState = String(digest?.currentState || '').trim();
    const tail = compactVisibleProcess(visibleRounds, story ? 600 : 1200, userPresent);
    content = [
      attributionBoundary,
      currentState ? `当前持续状态（后续日程与剧情从这里继续）：${currentState}` : '',
      summary,
      story && story !== summary ? `剧情复盘：${story}` : '',
      tail ? `结尾前情提要（线下最后的经过，承接后续时以此为准）：\n${tail}` : '',
    ].filter(Boolean).join('\n\n');
  } else {
    const process = compactVisibleProcess(visibleRounds, 3600, userPresent);
    content = [
      attributionBoundary,
      `${characterName}只记得自己在场期间发生的事：\n${process || '没有留下可见的过程记录。'}`,
    ].filter(Boolean).join('\n\n');
  }
  return {
    characterId: String(characterId || ''),
    characterName: String(characterName || 'TA'),
    content,
    visibility: intervals,
    roundIds: visibleRounds.map((round) => String(round.id || '')).filter(Boolean),
    joinedAt: visibleRounds[0]?.ts || null,
    leftAt: visibleRounds[visibleRounds.length - 1]?.ts || null,
    coversAll,
  };
}

const OFFLINE_ARCHIVE_SOURCE_CHAR_LIMIT = 96_000;

function compactArchiveBeatText(text = '', limit = 4000) {
  const source = String(text || '').trim();
  if (source.length <= limit) return source;
  const marker = '…（本轮中段过长，归档时机械省略）…';
  const available = Math.max(40, limit - marker.length);
  const head = Math.ceil(available * 0.58);
  return `${source.slice(0, head)}${marker}${source.slice(-(available - head))}`;
}

/**
 * 拼这次收纳要喂给模型的事实源。
 * 卷宗、摘要和详情页必须以同一批真实轮次为准；分段小结/上卷摘要是模型派生物，
 * 不能替代原文再次生成卷宗，否则一次编偏会污染后续共同回忆。
 * 极长会话只对每一轮做首尾机械压缩，仍保留全部轮次顺序，不引入 AI 小结。
 */
function buildJoinedProcessText(session) {
  const contentBeats = (session.beats || []).filter((b) => b.role !== 'daymark');
  const finalContinuityState = session?.continuityState || [...contentBeats].reverse()
    .find((beat) => beat?.role === 'narration' && beat?.continuityState)?.continuityState || null;
  const beatLine = (b, text = b.text) => {
    if (b.role === 'narration') return text;
    if (b.role === 'opening') return `（开场白：${text}）`;
    if (b.role === 'interlude') return `（中途手机插曲：${text}）`;
    return `（方向：${text}）`;
  };
  const continuityLine = finalContinuityState
    ? `（收尾现场连续状态：${JSON.stringify(finalContinuityState)}）`
    : '';
  const full = [
    ...contentBeats.map((beat) => beatLine(beat)),
    continuityLine,
  ].filter(Boolean).join('\n\n');
  if (full.length <= OFFLINE_ARCHIVE_SOURCE_CHAR_LIMIT) return full;

  const perBeatLimit = Math.max(
    160,
    Math.min(4000, Math.floor(88_000 / Math.max(1, contentBeats.length))),
  );
  return [
    ...contentBeats.map((beat) => beatLine(
      beat,
      compactArchiveBeatText(beat.text, perBeatLimit),
    )),
    continuityLine ? compactArchiveBeatText(continuityLine, 6000) : '',
  ].filter(Boolean).join('\n\n');
}

/** 测试与审计用：只返回当前活动路线会进入摘要的过程文本。 */
export function buildOfflineArchiveSummaryInput(session = {}) {
  return buildJoinedProcessText(session);
}

function buildSceneBits(session) {
  return [
    session.scene?.place ? `地点：${session.scene.place}` : '',
    session.scene?.goal ? `目标：${session.scene.goal}` : '',
    session.scene?.tone ? `氛围：${session.scene.tone}` : '',
  ].filter(Boolean).join('\n');
}

function strList(v, max, len) {
  return (Array.isArray(v) ? v : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, max)
    .map((x) => x.slice(0, len));
}

/** 结构化卷宗字段清洗；story/memory 都为空视为解析失败。 */
function normalizeDossier(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const quotes = (Array.isArray(raw.quotes) ? raw.quotes : [])
    .map((q) => ({
      speakerId: String(q?.speakerId || '').trim().slice(0, 80),
      speaker: String(q?.speaker || '').trim().slice(0, 24),
      line: String(q?.line || '').trim().slice(0, 140),
    }))
    .filter((q) => q.line)
    .slice(0, 3);
  const digest = {
    title: String(raw.title || '').trim().slice(0, 40),
    cast: String(raw.cast || '').trim().slice(0, 200),
    currentState: String(raw.currentState || '').trim().slice(0, 600),
    quotes,
    shifts: strList(raw.shifts, 3, 140),
    items: strList(raw.items, 3, 140),
    hooks: strList(raw.hooks, 3, 140),
    story: String(raw.story || '').trim().slice(0, 800),
    memory: String(raw.memory || '').trim().slice(0, 400),
  };
  if (!digest.story && !digest.memory) return null;
  return digest;
}

export function buildFallbackOfflineDossier(summary = '', participantNames = []) {
  const text = String(summary || '').trim();
  if (!text) return null;
  const names = (Array.isArray(participantNames) ? participantNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  return {
    title: '',
    cast: names.length ? `本次在场：${names.join('、')}` : '',
    currentState: '',
    quotes: [],
    shifts: [],
    items: [],
    hooks: [],
    story: text,
    memory: text,
    fallback: true,
  };
}

/**
 * 总结接口真实断网时的零请求兜底。优先使用推进期间已经落盘的分段小结；
 * 没有小结时只摘取本场最后几段原文，不编造未发生的关系变化。
 */
export function buildOfflineTransportFallbackSummary(session = {}, participantNames = []) {
  const checkpoints = effectiveOfflineCheckpointSummaries(
    session?.checkpointSummaries,
    session?.checkpointRollup,
  )
    .map((row) => String(row?.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (checkpoints.length) {
    return checkpoints.slice(-4).join(' ').slice(0, 800).trim();
  }

  const excerpts = (Array.isArray(session?.beats) ? session.beats : [])
    .filter((beat) => ['opening', 'directive', 'narration', 'interlude'].includes(beat?.role))
    .map((beat) => String(beat?.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-4);
  if (!excerpts.length) return '';
  const names = (Array.isArray(participantNames) ? participantNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const prefix = names.length
    ? (session?.userPresent === false
      ? `本次线下由${names.join('、')}共同经历。`
      : `本次线下与${names.join('、')}共同经历。`)
    : '本次线下记录。';
  return `${prefix}${excerpts.join(' ')}`.slice(0, 800).trim();
}

function isOfflineSummaryTransportError(error) {
  const reason = classifyOfflineErrorReason(error);
  return error?.streamIncomplete === true
    || isTransientApiError(error)
    || ['stream-error', 'network-unknown', 'network-cors', 'client-timeout', 'length-truncated', 'empty-api-response', 'api-html-response'].includes(reason)
    || /摘要生成失败，请重试/.test(String(error?.message || ''));
}

/**
 * 结构化卷宗生成：卷宗头 + 当前状态 + 关键台词 + 情感认知变动 + 物品伏笔 + 未完成悬念 + 剧情压缩。
 * 使用独立 system 约束和 user 过程记录生成；解析失败返回 null，由调用方降级为纯文本摘要。
 */
async function generateOfflineDossier({
  session,
  joined,
  sceneBits,
  participantIds = [],
  participantNames = [],
  userName = '用户',
}) {
  const userPresent = session?.userPresent !== false;
  const narrationPerson = !userPresent
    ? '全知旁观的第三人称叙事，user 不在故事中'
    : session?.scene?.person === 'first'
    ? '第一人称叙事，正文里的“我”指用户'
    : (session?.scene?.person === 'third'
      ? '第三人称叙事，正文用姓名／TA／他／她区分人物'
      : '第二人称叙事，正文里的“你”指用户');
  const systemPrompt = [
    '[线下经历 · 卷宗归档]',
    `背景：下面是一段已经结束的线下相处过程。叙事正文采用${narrationPerson}。`,
    userPresent
      ? `在场的人：用户（角色ID:user，显示名:${userName}）${participantNames.length ? `、${participantNames.map((name, index) => `${name}（角色ID:${participantIds[index] || 'unknown'}）`).join('、')}` : ''}。`
      : `在场的人：${participantNames.map((name, index) => `${name}（角色ID:${participantIds[index] || 'unknown'}）`).join('、')}。user 只是屏幕外旁观者，不得写入出场人物、台词或关系变化。`,
    userPresent
      ? '过程记录会混合叙事正文与“（方向：……）”用户输入，两者的代词不能混用：用户说出的对白里“我”是用户、“你／你们”是被用户说话的角色；导演式方向里的“你”默认也是当前主角色。只有叙事正文里的代词才按上面的叙事人称解释。'
      : '过程记录里的“（方向：……）”是屏幕外的导演指令，不是任何出场人物的台词或行动。其中“你”默认指被指导的角色，“我想看”不代表 user 入场。',
    sceneBits ? `场景：\n${sceneBits}` : '',
    '任务：把这段经历整理成一份结构化卷宗，作为长期记忆的存档锚点。所有内容必须来自原文，禁止虚构。',
    '多人归属是硬约束：每句话、每个动作、每种观点都必须明确写出实际人物姓名，禁止用容易串人的“他/她/对方/其中一人”代替主语；绝对不能把 A 说过或做过的事写成 B 的。',
    '只输出一个 JSON 对象，不要输出任何其它文字、解释或代码块标记。字段如下：',
    '{',
    '  "title": "给这段经历起的标题，12 字以内",',
    '  "cast": "角色出场速写，1 句",',
    '  "currentState": "剧情结束后仍然成立、会影响次日生活与地点安排的当前客观状态，1-3 句；例如暂住关系、当下所在城市/住处、同行或照护安排。已经结束的动作不要写，没有持续状态就写空字符串",',
    `  "quotes": [{"speakerId": "逐字使用上方角色ID${userPresent ? '，用户写user' : ''}", "speaker": "说话的人姓名", "line": "最能体现人物张力或推动剧情的一句对话，原句摘录"}],`,
    '  "shifts": ["情感与认知变动，例如：某人对某人的警惕下降 / 察觉到某事的端倪（1-3 条）"],',
    '  "items": ["本段出现的关键道具、可能成为伏笔的微小动作或环境特写（0-3 条，没有就给空数组）"],',
    '  "hooks": ["未完成悬念：结尾停留在何处、下一步即将发生什么（1-2 条）"],',
    '  "story": "全知视角、文学语言的高浓缩剧情复盘，250-300 字，必须包含事件推进与核心冲突的解决或升华，禁止空泛形容",',
    '  "memory": "2-4 句凝练摘要，将写入共同回忆，客观口吻，不要列表"',
    '}',
    'quotes 最多 3 条；speakerId 与 speaker 必须同时正确。currentState、story、memory、shifts、hooks 也必须保留明确人物主语，不能省略到产生归属歧义。currentState 是后续日程的现实锚点，若原文明确多人暂住在一起或改变了所在地，必须写明每个人目前住在哪里，不能按角色常驻地重置。',
  ].filter(Boolean).join('\n');
  const userPrompt = `请归档以下过程记录：\n${joined}`;
  try {
    const { data } = await chatJsonGeneration({
      scope: 'offline-date-dossier',
      task: 'chatSummary',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      requestOptions: { stream: false },
      validate: (value) => normalizeDossier(value) != null,
    });
    return normalizeDossier(data);
  } catch (error) {
    if (
      ['empty-api-response', 'json-parse-failed', 'output-truncated'].includes(error?.reason)
      || isOfflineSummaryTransportError(error)
    ) return null;
    throw error;
  }
}

/**
 * 收纳线下会话：写共同回忆摘要 + 统一约会档案（轮次 + 摘要），不生成小剧场卡。
 */
export async function archiveOfflineDateSession({ session, chat, user, messages = [] }) {
  if (!session) throw new Error('线下会话不存在');
  const userId = String(session.userId || user?.id || '').trim();
  const userPresent = session?.userPresent !== false;
  const chatId = String(session.chatId || chat?.id || '').trim();
  const endedAt = await getNowForUser(userId);
  const chatParticipantIds = (chat?.participants || []).filter((x) => x && x !== 'user');
  const attendance = cloneAttendance(session, chatParticipantIds);
  const allEverParticipantIds = attendance.members
    .filter(attendanceMemberEverActive)
    .map((member) => member.characterId);
  const { ids: participantIds, names: participantNames } = await participantNamesForIds(
    allEverParticipantIds.length ? allEverParticipantIds : chatParticipantIds,
  );
  const characterId = participantIds[0] || '';
  const characterName = participantNames[0] || 'TA';
  // 未采用路线只作为附录读取；摘要、卷宗与角色记忆仍只消费当前活动路线。
  const unusedBranches = await buildUnusedOfflineBranchArchives(session).catch((err) => {
    console.warn('[offline-date-archive] unused branches snapshot failed', err);
    return [];
  });

  // 一次收纳只发一次模型请求；结构化卷宗失败时直接使用本地摘要，是否重试交给用户。
  let digest = null;
  try {
    digest = await generateOfflineDossier({
      session,
      joined: buildJoinedProcessText(session),
      sceneBits: buildSceneBits(session),
      participantIds,
      participantNames,
      userName: getUserDisplayName(user) || '用户',
    });
  } catch (err) {
    console.warn('[offline-date-archive] dossier generation failed, fallback to plain summary', err);
  }
  let summary = digest ? (digest.memory || digest.story.slice(0, 240)) : '';
  if (!summary) {
    summary = buildOfflineTransportFallbackSummary(session, participantNames);
  }
  if (!digest) digest = buildFallbackOfflineDossier(summary, participantNames);
  const rounds = beatsToRounds(session.beats);
  const sourceSessionId = String(session.id || '').trim();
  const startedAtWorld = Number(session.startedAtWorld || session.createdAt || endedAt) || endedAt;
  const existingArchive = (await listAllOfflineDateArchivesRaw(userId)).find((item) => (
    isSameOfflineArchiveSource(item, {
      sourceSessionId,
      chatId,
      startedAtWorld,
      rounds,
    })
  )) || null;
  const archiveId = String(existingArchive?.id || '').trim() || genId();
  const title = formatArchiveTitle(startedAtWorld, participantNames, session.scene, userPresent);
  const characterMemories = participantIds.map((cid, index) => buildOfflineCharacterMemory({
    characterId: cid,
    characterName: participantNames[index] || cid,
    participantIds,
    participantNames,
    rounds,
    summary,
    digest,
    userPresent,
  }));

  const archive = {
    ...(existingArchive || {}),
    id: archiveId,
    sourceSessionId,
    userId,
    chatId,
    userPresent,
    // 世界时间可能被回拨，聊天连续气泡也可能为保持顺序而略微排到世界时间之后。
    // 单独记录真实收纳时刻，返线上时据此判断哪些消息确实是在收纳后新产生的。
    archivedAtReal: Date.now(),
    characterId,
    characterName,
    participantIds,
    participantNames,
    allEverParticipantIds: [...participantIds],
    knownByActorIds: [...participantIds],
    participantSnapshot: {
      actorIds: [...participantIds],
      names: [...participantNames],
      capturedAt: endedAt,
    },
    attendance,
    title,
    summary,
    currentState: String(digest?.currentState || '').trim(),
    digest,
    characterMemories,
    scene: { ...(session.scene || {}) },
    rounds,
    mediaSummary: collectOfflineSceneMediaStats(rounds, session.scene || {}),
    unusedBranches,
    startedAtWorld,
    startedAt: startedAtWorld,
    endedAt,
    activitySessionId: String(session.activitySessionId || '').trim(),
  };
  await saveOfflineDateArchive(userId, archive);
  enqueueVectorSource('archive', {
    ...archive,
    content: [title, archive.currentState, summary, digest?.story].filter(Boolean).join('\n'),
  }).catch(() => {});
  const detailFragments = effectiveOfflineCheckpointSummaries(
    session.checkpointSummaries,
    session.checkpointRollup,
  ).map((checkpoint, index) => ({
    id: `${archiveId}:checkpoint:${checkpoint.fromBeatIndex || index + 1}-${checkpoint.uptoBeatIndex || index + 1}`,
    userId,
    chatId,
    characterId,
    knownByActorIds: [...participantIds],
    title,
    content: String(checkpoint.text || '').trim(),
  })).filter((fragment) => fragment.content);
  const originalFragments = buildOfflineArchivePassageSources(archive);
  enqueueVectorSources('archive', [...detailFragments, ...originalFragments]).catch(() => {});

  // 摘要记忆按参与者分别注入：每个在场角色各得一条共同回忆。
  const memoryTargets = participantIds.length ? participantIds : [characterId].filter(Boolean);
  const memories = [];
  for (const cid of memoryTargets) {
    const ownedMemory = characterMemories.find((entry) => entry.characterId === cid);
    const memory = createMemory({
      id: memoryTargets.length > 1 ? `mem_oda_${archiveId}_${cid}` : `mem_oda_${archiveId}`,
      userId,
      chatId,
      characterId: cid,
      type: 'event',
      category: 'shared',
      content: ownedMemory?.content || summary,
      importance: 'high',
      timestamp: endedAt,
      source: 'offline_date',
    });
    memory.offlineDateArchiveId = archiveId;
    memory.archiveTitle = title;
    memory.offlineDateVisibility = ownedMemory?.visibility || [];
    memory.knownByActorIds = [cid];
    memory.participantSnapshot = archive.participantSnapshot;
    await saveMemory(memory);
    memories.push(memory);
  }

  // 供线下存取层识别“档案与共同回忆均已完成”的终态。必须放在所有 memory 保存后，
  // 不能只凭先落库的 archive 判断，否则总结中途失败时会误删仍需重试的现场。
  await dbPut('settings', {
    key: `offlineDateArchiveCompletion_${encodeURIComponent(sourceSessionId)}`,
    value: {
      archiveId,
      sourceSessionId,
      completedAt: Date.now(),
    },
  });

  return { archive, memory: memories[0] || null, memories, summary };
}
