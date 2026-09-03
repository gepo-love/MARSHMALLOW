/**
 * 线下沉浸态会话（相遇模块 · 第一刀）
 *
 * 与「聊天内小剧场卡」(core/chat/offline-story-card.js) 的关系：
 * - 小剧场卡 = 聊天流里一张一次性折叠卡（输出单元）。
 * - 线下沉浸态 = 独立会话态：先设场景，多轮连续推进（长文本），收尾再折叠成小剧场卡回写聊天 + 记忆。
 *
 * 本模块只负责逻辑：会话存取、单轮线下推进、收尾总结。
 * 复用：buildChatContext（角色卡/世界书/用户卡）、archiveOfflineDateSession（收尾沉淀）。
 */

import {
  chat as apiChat,
  chatForTask,
  resolveChatPreferStream,
  resolveTaskApiConfig,
} from './api.js';
import { resolveSceneApiConfig } from './api-presets.js';
import {
  getNowForUser,
  ensureTimeSchedule,
  advanceVirtualTime,
  getUserTimezone,
  formatPromptTimeLine,
} from './time-mode.js';
import { formatZonedClock } from './user-timezone.js';
import { buildChatContext } from './context/build-chat-context.js';
import { getRegularAnonymousMemoryInjectMode } from './anonymous-chat.js';
import { buildAnonymousLinkedMemoryContext } from './memory/cross-chat-carry.js';
import { getRecord, get as dbGet, getAllByIndex } from './db.js';
import { invalidateKeepAlive } from './router.js';
import { getCharacterAiContextName, normalizeTranslationProfile } from '../models/character.js';
import { getUserDisplayName } from '../models/user.js';
import { formatMessageForContext, isAnonymousChat } from './chat-helpers.js';
import { getCharacter, listCharacters, saveCharacter } from './character-store.js';
import { isEncounterPendingCharacter } from '../models/character.js';
import { getChat, saveChat, ensurePrivateChat, saveMessage, listMessagesForChat, listChatsForUser } from './chat-store.js';
import { archiveOfflineDateSession, listOfflineDateArchives } from './offline-date-archive.js';
import { canAdvanceOfflineSettlementTime } from './offline-settlement-time.js';
import { restoreOfflineSourcePrivateChat } from './offline-chat-isolation.js';
import {
  getEffectiveWeatherCityForUser,
  getEffectiveWeatherCityForCharacter,
  fetchWeatherForCity,
  summarizeWeatherForHint,
} from './weather-location.js';
import { normalizeCityInput } from './regional-weather.js';
import {
  offlineSessionKey,
  offlineSessionMirrorKey,
  offlineNarrationCount,
  offlineSessionHasProgress,
  loadOfflineSession,
  loadOfflineSessionWithMeta,
  saveOfflineSession,
  clearOfflineSession as clearOfflineSessionStored,
} from './offline-session-store.js';
import {
  VARIED_SEGMENTATION_HINT,
  resolveNarrationMaxTokens,
} from './narration-settings.js';
import {
  personContinuityText,
  perspectiveText,
  personText,
} from './narration-perspective.js';
import {
  collectNarrationSupplementalAuditHits,
  extractNarrationEditorialAudits,
  recoverNarrationFromReasoning,
  sanitizeNarrationOutput,
} from './narration-sanitize.js';
import {
  extractPromptedThinkingBlock,
  isIncompletePromptedThinkingPrefix,
} from './marshmallow-protocol.js';
import { applyPermanentRegex, applyPromptRegex, primeRegex } from './display-regex.js';
import { stripTranslationMarks } from './narration-translation.js';
import { chatWithEmptyFallback } from './narration-compat.js';
import {
  acquireNarrationGenerationLease,
  narrationGenerationInFlightError,
} from './narration-generation-lease.js';
import { advanceOptionsInstruction, extractAdvanceOptions, OPTIONS_START } from './advance-options.js';
import { getActivitySession, saveActivitySession, buildOfflineSceneFromActivitySession } from './activity-sessions.js';
import {
  applyOfflineActiveScheduleOverride,
  applyOfflineSummaryScheduleOverride,
} from './chat/offline-invite-schedule.js';
import { loadLastOfflineScenePresetFields } from './offline-scene-presets.js';
import {
  OFFLINE_EXPERIENCE_AUDIO,
  isOfflineAudioExperience,
  normalizeOfflineExperienceMode,
} from './offline-experience-mode.js';
import { buildOfflineAudioScriptPrompt } from './offline-audio-script-prompt.js';
import { loadOfflineStylePrefs, resolveOfflineInnerVoiceCard } from './offline-appearance.js';
import { buildOfflineSessionGuidanceBlock } from './offline-guidance.js';
import { loadDisabledBuiltinPresetIds } from './preset-store.js';
import {
  normalizeOfflineSceneImageGenMode,
  buildOfflineScenePrompt,
  maybeGenerateOfflineSceneImage,
  sceneImageDirectiveInstruction,
  extractSceneImageDirective,
  SCENE_IMAGE_DIRECTIVE_START,
} from './offline-scene-image.js';
import {
  createSceneDraft,
  OFFLINE_PERSPECTIVES,
  OFFLINE_PERSONS,
  OFFLINE_ACTIVITY_KINDS,
} from './offline-scene-draft.js';

export {
  createSceneDraft,
  OFFLINE_PERSPECTIVES,
  OFFLINE_PERSONS,
  OFFLINE_ACTIVITY_KINDS,
} from './offline-scene-draft.js';
import {
  buildVoiceSpeechProfileOverride,
  loadCharacterVoiceProfile,
  loadVoiceToolConfig,
  resolveVoiceToolConfigForProfile,
  synthesizeVoice,
} from './voice-tools.js';
import {
  alignNarrativeVoiceLinesToDialogueSpans,
  buildNarrativeVoiceLinesInstruction,
  extractNarrativeVoiceLines,
  NARRATIVE_VOICE_LINES_START,
} from './narrative-voice-lines.js';
import { VOICE_WORLD_BOOK_SURFACES } from './voice-worldbook.js';
import {
  listAvailableSoundAssetCategories,
} from './sound-library.js';
import {
  combineBreathSupplementModes,
  filterBreathSoundCues,
} from './sound-cues.js';
import { buildOfflineInterludeBeat } from './offline-interlude.js';
import { appendDebugEvent } from './debug-log.js';
import {
  applyOfflinePhoneActionReceipts,
  buildOfflinePhoneActionDirectory,
  collectOfflinePhoneActionsFromBeats,
  dispatchOfflinePhoneActions,
  dispatchOfflineSocialPosts,
  extractOfflinePhoneActions,
  OFFLINE_PHONE_ACTIONS_START,
  offlinePhoneActionsInstruction,
  pendingOfflinePhoneActionOutbox,
  rollbackOfflinePhoneActionsForBeat,
  stageOfflinePhoneActionOutbox,
  stripOfflinePhoneActionTail,
} from './offline-phone-actions.js';
import {
  OFFLINE_CHARACTER_STATES_START,
  extractOfflineCharacterStates,
  filterNaturalEnsembleCharacterStates,
  latestOfflineCharacterStates,
  offlineCharacterStatesInstruction,
} from './offline-character-states.js';
import {
  OFFLINE_CONTINUITY_STATE_START,
  buildOfflineContinuityFallback,
  collectOfflineKnowledgeFacts,
  extractOfflineContinuityState,
  latestOfflineContinuityState,
  mergeOfflineContinuityPatches,
  offlineContinuityStateInstruction,
  rebuildOfflineContinuityState,
  stripLeakedOfflineContinuityTail,
} from './offline-continuity-state.js';
import { upsertMemoryFact } from './memory/memory-facts.js';
import {
  appendOfflineCheckpointSummary,
  effectiveOfflineCheckpointSummaries,
  isOfflineNarrationCovered,
  offlineCheckpointCoverageRanges,
  selectOfflineCheckpointSummariesForContext,
  shouldCreateOfflineCheckpoint,
} from './offline-checkpoint-memory.js';
import {
  OFFLINE_BEAT_DIGEST_START,
  extractOfflineBeatDigest,
  formatOfflineBeatDigestForContext,
  mergeOfflineBeatDigests,
  offlineBeatDigestInstruction,
} from './offline-beat-digest.js';
import {
  OFFLINE_HTML_EXTENSIONS_START,
  buildHtmlExtensionPromptBlock,
  extractOfflineHtmlExtensions,
  resolveTriggeredHtmlExtensions,
} from './html-extensions.js';
import {
  buildOfflineOffsceneQueryText,
  resolveMentionedOffsceneCharacterIds,
} from './offline-offscene-context.js';
import {
  pendingCheckpointForDay,
  resolveItineraryCheckpointChoice,
  rerollTogetherTripItinerary,
  buildItineraryDayContextLines,
} from './together-trip-itinerary.js';
import {
  ensureOfflineBranching,
  clearOfflineBranchSnapshots,
} from './offline-branch-snapshot.js';

const requestOfflineSummary = (messages, options = {}) =>
  chatForTask(messages, { ...options, stream: false }, 'chatSummary');

// 存取函数从 offline-session-store.js 转出，保持旧的 import 路径可用。
export {
  offlineSessionKey,
  offlineSessionMirrorKey,
  offlineNarrationCount,
  offlineSessionHasProgress,
  loadOfflineSession,
  loadOfflineSessionWithMeta,
  saveOfflineSession,
};

/**
 * 只有已经产生真实推进的现场才值得继续。
 * 仅创建过设置/开场的空壳现场必须允许重新建场，否则会一直沿用创建当时冻结的
 * lastEncounter，漏掉后来已经收纳的群聊线下记忆。
 */
export function shouldResumeExistingOfflineSession(session = null) {
  return !!session && offlineSessionHasProgress(session);
}

const INFLIGHT_PERSIST_MIN_MS = 1600;
const INFLIGHT_RECOVER_MIN_CHARS = 20;
/** chatId -> { timer, promise } */
const inflightPersistTimers = new Map();

export async function clearOfflineSession(chatId, options = {}) {
  const id = String(chatId || '').trim();
  const pending = id ? inflightPersistTimers.get(id) : null;
  if (pending?.timer) clearTimeout(pending.timer);
  if (id) inflightPersistTimers.delete(id);
  await clearOfflineSessionStored(id, options);
}

export function scheduleOfflineInFlightPersist(session, { force = false } = {}) {
  if (!session?.chatId || !session.inFlight) return Promise.resolve();
  const chatId = String(session.chatId);
  const existing = inflightPersistTimers.get(chatId);
  if (force) {
    if (existing?.timer) clearTimeout(existing.timer);
    inflightPersistTimers.delete(chatId);
    return saveOfflineSession(session).catch((err) => {
      console.warn('[offline-session] inFlight force save failed', err);
    });
  }
  if (existing?.timer) return existing.promise || Promise.resolve();
  let resolveFn = () => {};
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const timer = setTimeout(() => {
    inflightPersistTimers.delete(chatId);
    Promise.resolve()
      .then(() => (session.inFlight ? saveOfflineSession(session) : null))
      .catch((err) => console.warn('[offline-session] inFlight debounce save failed', err))
      .finally(() => resolveFn());
  }, INFLIGHT_PERSIST_MIN_MS);
  inflightPersistTimers.set(chatId, { timer, promise });
  return promise;
}

export async function flushOfflineSessionPersist(session) {
  if (!session?.chatId) return;
  const chatId = String(session.chatId);
  const existing = inflightPersistTimers.get(chatId);
  if (existing?.timer) clearTimeout(existing.timer);
  inflightPersistTimers.delete(chatId);
  await saveOfflineSession(session);
}

export async function clearOfflineInFlight(session, { save = true } = {}) {
  if (!session) return;
  const chatId = String(session.chatId || '');
  if (chatId) {
    const existing = inflightPersistTimers.get(chatId);
    if (existing?.timer) clearTimeout(existing.timer);
    inflightPersistTimers.delete(chatId);
  }
  if (!session.inFlight) return;
  delete session.inFlight;
  if (save) await saveOfflineSession(session);
}

/**
 * 冷启动：把中断的 inFlight.partialText 收成正式 narration，避免整轮蒸发。
 * @returns {{ committed: boolean, cleared: boolean, preservedExisting?: boolean }}
 */
export function commitOfflineInFlightIfNeeded(session) {
  const flight = session?.inFlight;
  if (!flight) return { committed: false, cleared: false };
  // 指导重修必须是“成功才替换”。崩溃恢复时不能把半截新稿追加成下一楼，
  // 否则既破坏末层事务语义，也会留下重复轮次。
  if (flight.mode === 'revision') {
    delete session.inFlight;
    return { committed: false, cleared: true };
  }
  const text = cleanNarration(String(flight.partialText || '').trim());
  const directive = String(flight.directive || '').trim();
  if (flight.mode === 'continuation') {
    const target = [...(session.beats || [])].reverse().find((beat) => (
      beat?.role === 'narration'
      && String(beat.id || '') === String(flight.targetBeatId || '')
    ));
    if (!target) {
      delete session.inFlight;
      return { committed: false, cleared: true };
    }
    if (text.length < 2) {
      delete session.inFlight;
      return { committed: false, cleared: true };
    }
    target.text = joinOfflineContinuationText(target.text, text);
    target.continuationPending = true;
    target.continuationReason = String(flight.interruptionReason || flight.finishReason || 'interrupted').trim();
    target.recoveredFromInFlight = true;
    delete session.inFlight;
    return { committed: true, cleared: true, continuedExisting: true };
  }
  if (text.length < INFLIGHT_RECOVER_MIN_CHARS) {
    delete session.inFlight;
    return { committed: false, cleared: true };
  }
  const lastNar = [...(session.beats || [])].reverse().find((b) => b.role === 'narration');
  if (lastNar && String(lastNar.text || '').trim() === text) {
    delete session.inFlight;
    return { committed: false, cleared: true, preservedExisting: true };
  }
  const ts = Date.now();
  if (directive) {
    const lastDir = [...(session.beats || [])].reverse().find((b) => b.role === 'directive');
    if (!lastDir || String(lastDir.text || '').trim() !== directive) {
      session.beats.push({ id: genId(), role: 'directive', text: directive, ts });
    }
  }
  session.beats.push({
    id: flight.beatId || genId(),
    role: 'narration',
    text,
    ts,
    options: [],
    recoveredFromInFlight: true,
    continuationPending: true,
    continuationReason: String(flight.interruptionReason || flight.finishReason || 'interrupted').trim(),
  });
  session.narrationEver = Math.max(
    Number(session.narrationEver || 0),
    session.beats.filter((b) => b.role === 'narration').length,
  );
  delete session.inFlight;
  return { committed: true, cleared: true };
}

/** 将模型的续写片段接回原楼层，并消除常见的句尾重复。 */
export function joinOfflineContinuationText(existingText = '', continuationText = '') {
  const existing = cleanNarration(String(existingText || '').trim());
  let continuation = cleanNarration(String(continuationText || '').trim());
  if (!existing) return continuation;
  if (!continuation) return existing;
  if (continuation.startsWith(existing)) return continuation;
  const maxOverlap = Math.min(240, existing.length, continuation.length);
  for (let size = maxOverlap; size >= 2; size -= 1) {
    if (existing.slice(-size) === continuation.slice(0, size)) {
      continuation = continuation.slice(size).trimStart();
      break;
    }
  }
  if (!continuation) return existing;
  const separator = /[。！？!?…」”’】）)]$/.test(existing) ? '\n\n' : '';
  return `${existing}${separator}${continuation}`;
}

export function missingOfflineCharacterStateIds(beat = {}, characterIds = []) {
  const states = beat?.characterStates && typeof beat.characterStates === 'object'
    ? beat.characterStates
    : {};
  return [...new Set((Array.isArray(characterIds) ? characterIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && !states[id]))];
}

function genId() {
  return `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 世界书多选归一化：兼容旧数据里单个 worldBookId 字符串。 */
function normalizeWorldBookIds(partial = {}) {
  const raw = Array.isArray(partial.worldBookIds)
    ? partial.worldBookIds
    : (partial.worldBookId ? [partial.worldBookId] : []);
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

/** 文风预设多选归一化：兼容旧数据里单个 presetStyleId 字符串。 */
function normalizePresetStyleIds(partial = {}) {
  const raw = Array.isArray(partial.presetStyleIds)
    ? partial.presetStyleIds
    : (partial.presetStyleId ? [partial.presetStyleId] : []);
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

export const OFFLINE_ATTENDANCE_STATUSES = ['active', 'pending', 'left'];

function cleanOfflineParticipantIds(ids = [], session = null) {
  const userId = String(session?.userId || '').trim();
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== userId))];
}

function normalizeAttendanceMember(raw = {}) {
  const characterId = String(raw.characterId || raw.id || '').trim();
  if (!characterId) return null;
  const status = OFFLINE_ATTENDANCE_STATUSES.includes(raw.status) ? raw.status : 'active';
  return {
    characterId,
    status,
    source: String(raw.source || 'legacy').trim() || 'legacy',
    joinedAt: Number(raw.joinedAt || 0) || null,
    leftAt: Number(raw.leftAt || 0) || null,
    joinedBeatId: String(raw.joinedBeatId || '').trim(),
    leftBeatId: String(raw.leftBeatId || '').trim(),
    history: Array.isArray(raw.history) ? raw.history.slice(-20) : [],
  };
}

/**
 * 兼容旧会话：attendance 首次读取时，从 session.participants 优先、否则从 chat.participants 初始化。
 * 初始化只发生一次；之后 chat 的历史群成员不会把已经离场的人重新变成 active。
 */
export function ensureOfflineAttendance(session, chat = null) {
  if (!session) return { version: 1, members: [] };
  const existing = session.attendance;
  if (existing && typeof existing === 'object' && Array.isArray(existing.members)) {
    const seen = new Set();
    existing.version = 1;
    existing.members = existing.members
      .map(normalizeAttendanceMember)
      .filter((row) => row && !seen.has(row.characterId) && seen.add(row.characterId));
    return existing;
  }
  const legacyIds = cleanOfflineParticipantIds(
    Array.isArray(session.participants) && session.participants.length
      ? session.participants
      : (chat?.participants || []),
    session,
  );
  const joinedAt = Number(session.startedAtReal || session.createdAt || 0) || Date.now();
  session.attendance = {
    version: 1,
    migratedAt: Date.now(),
    members: legacyIds.map((characterId) => ({
      characterId,
      status: 'active',
      source: Array.isArray(session.participants) && session.participants.length ? 'legacy_session' : 'legacy_chat',
      joinedAt,
      leftAt: null,
      joinedBeatId: '',
      leftBeatId: '',
      history: [],
    })),
  };
  return session.attendance;
}

export function getOfflineAttendanceMembers(session, chat = null, status = '') {
  const members = ensureOfflineAttendance(session, chat).members;
  return status ? members.filter((row) => row.status === status) : members;
}

export function getActiveOfflineParticipantIds(session, chat = null) {
  return getOfflineAttendanceMembers(session, chat, 'active').map((row) => row.characterId);
}

/** 新会话保存明确标志；旧会话按来源 chat 是否包含 user 兼容判定。 */
export function isOfflineUserPresent(session = null, chat = null) {
  if (typeof session?.userPresent === 'boolean') return session.userPresent;
  if (Array.isArray(chat?.participants)) return chat.participants.includes('user');
  return true;
}

export function buildActiveOfflineChat(session, chat = null) {
  if (!chat) return chat;
  const activeIds = getActiveOfflineParticipantIds(session, chat);
  const isOfflineGroup = chat.type === 'group' || activeIds.length > 1;
  const userPresent = isOfflineUserPresent(session, chat);
  return {
    ...chat,
    // 只在本轮上下文快照里表现为群体场景，绝不把临时在场者保存回来源私聊。
    type: isOfflineGroup ? 'group' : 'private',
    participants: userPresent ? ['user', ...activeIds] : activeIds,
    groupSettings: isOfflineGroup
      ? {
        ...(chat.groupSettings || {}),
        name: chat.type === 'group'
          ? String(chat.groupSettings?.name || '')
          : `线下现场（${activeIds.length + (userPresent ? 1 : 0)}人）`,
        isObserverMode: !userPresent,
      }
      : chat.groupSettings,
  };
}

async function syncOfflineSceneCompanions(session) {
  if (!session?.scene) return '';
  const names = [];
  for (const id of getActiveOfflineParticipantIds(session)) {
    const character = await getCharacter(id, { userId: session.userId }).catch(() => null);
    const name = String(character?.customNickname || character?.name || '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  session.scene.companions = names.join('、');
  return session.scene.companions;
}

async function transitionOfflineAttendance({
  session,
  chat = null,
  characterId,
  status,
  source = 'manual',
  text = '',
} = {}) {
  if (!session?.chatId) throw new Error('线下会话不存在');
  const id = String(characterId || '').trim();
  if (!id || id === 'user' || id === String(session.userId || '')) throw new Error('角色不存在');
  if (!OFFLINE_ATTENDANCE_STATUSES.includes(status)) throw new Error('无效的现场状态');
  const attendance = ensureOfflineAttendance(session, chat);
  let member = attendance.members.find((row) => row.characterId === id);
  const now = Date.now();
  const worldNow = await getNowForUser(session.userId).catch(() => now);
  const previousStatus = member?.status || '';
  if (!member) {
    member = normalizeAttendanceMember({ characterId: id, status, source });
    attendance.members.push(member);
  }
  if (previousStatus === status) return { session, member, changed: false };
  if (previousStatus) {
    member.history = [...(member.history || []), {
      status: previousStatus,
      source: member.source,
      joinedAt: member.joinedAt,
      leftAt: member.leftAt,
      joinedBeatId: member.joinedBeatId,
      leftBeatId: member.leftBeatId,
    }].slice(-20);
  }
  const character = await getCharacter(id, { userId: session.userId }).catch(() => null);
  const name = String(character?.customNickname || character?.name || 'TA').trim() || 'TA';
  const beatId = genId();
  const eventText = String(text || (
    status === 'active'
      ? `${name}来到了现场。`
      : (status === 'pending' ? `你邀请了${name}，正在等回应。` : `${name}离开了现场。`)
  )).trim();
  member.status = status;
  member.source = String(source || 'manual').trim() || 'manual';
  if (status === 'active') {
    member.joinedAt = now;
    member.joinedBeatId = beatId;
    member.leftAt = null;
    member.leftBeatId = '';
  } else if (status === 'left') {
    member.leftAt = now;
    member.leftBeatId = beatId;
  }
  session.beats = Array.isArray(session.beats) ? session.beats : [];
  session.beats.push({
    id: beatId,
    role: 'interlude',
    text: eventText,
    ts: worldNow,
    attendanceEvent: { characterId: id, status, source: member.source, previousStatus },
  });
  await syncOfflineSceneCompanions(session);
  await saveOfflineSession(session);
  return { session, member, changed: true };
}

export function inviteOfflineParticipant(args = {}) {
  return transitionOfflineAttendance({ ...args, status: 'pending' });
}

export function joinOfflineParticipant(args = {}) {
  return transitionOfflineAttendance({ ...args, status: 'active' });
}

export function leaveOfflineParticipant(args = {}) {
  return transitionOfflineAttendance({ ...args, status: 'left' });
}

export function withdrawOfflineParticipantInvite(args = {}) {
  return transitionOfflineAttendance({
    ...args,
    status: 'left',
    source: args.source || 'invite_withdrawn',
    text: args.text || '这次邀请已撤回。',
  });
}

export async function recordOfflineAttendanceDecision({
  session,
  characterId = '',
  decision = '',
  source = 'phone_join_intent',
  text = '',
} = {}) {
  if (!session?.chatId) return false;
  const id = String(characterId || '').trim();
  const body = String(text || '').trim();
  if (!body) return false;
  const worldNow = await getNowForUser(session.userId).catch(() => Date.now());
  session.beats = Array.isArray(session.beats) ? session.beats : [];
  session.beats.push({
    id: genId(),
    role: 'interlude',
    text: body,
    ts: worldNow,
    attendanceDecision: { characterId: id, decision: String(decision || ''), source },
  });
  await saveOfflineSession(session);
  return true;
}

/** 无设置表单的自动建场入口：用上次选中的命名预设覆盖 200~500 等初始默认值。 */
async function createSceneDraftWithLastPreset(userId, partial = {}, explicitOverrides = {}) {
  const presetFields = await loadLastOfflineScenePresetFields(userId).catch(() => ({}));
  const merged = {
    ...(partial || {}),
    ...presetFields,
    ...(explicitOverrides || {}),
  };
  const requestedMode = normalizeOfflineExperienceMode(merged.experienceMode, {
    legacyAudio: !merged.experienceMode && merged.audioSceneEnabled === true,
  });
  const hasExplicitTts = Object.prototype.hasOwnProperty.call(partial || {}, 'ttsEnabled')
    || Object.prototype.hasOwnProperty.call(explicitOverrides || {}, 'ttsEnabled');
  // 无表单的聊天跳转 / 邀约入口同样会读取普通线下的上次预设。只有调用方
  // 明确给出本场 ttsEnabled 时才尊重关闭；单纯来自跨模式预设的 false 不生效。
  if (requestedMode === OFFLINE_EXPERIENCE_AUDIO && !hasExplicitTts) {
    merged.ttsEnabled = true;
  }
  return createSceneDraft(merged);
}

function openingBeatFromScene(scene = {}, ts = Date.now()) {
  const text = String(scene.openingLine || '').trim();
  if (!text) return null;
  return { id: genId(), role: 'opening', text, ts };
}

/** 按场景里的开场白同步会话中的 opening beat（保存场景时调用） */
export function syncOpeningBeatFromScene(session = {}) {
  if (!session) return false;
  const text = String(session.scene?.openingLine || '').trim();
  const beats = Array.isArray(session.beats) ? session.beats : [];
  const idx = beats.findIndex((b) => b.role === 'opening');
  if (text) {
    if (idx >= 0) {
      beats[idx].text = text;
    } else {
      const ts = Number(session.startedAtWorld || beats[0]?.ts || 0) || Date.now();
      beats.unshift(openingBeatFromScene(session.scene, ts) || { id: genId(), role: 'opening', text, ts });
    }
  } else if (idx >= 0) {
    beats.splice(idx, 1);
  }
  session.beats = beats;
  return true;
}

function offlineMessageCreatedAtReal(message = {}) {
  const explicit = Number(
    message?.createdAt
    || message?.metadata?.createdAtReal
    || message?.metadata?.createdAt
    || message?.metadata?.aiRoundCreatedAt
    || 0,
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const idMatch = String(message?.id || '').match(/^msg_(\d{10,})_/);
  const fromId = Number(idMatch?.[1] || 0);
  return Number.isFinite(fromId) && fromId > 0 ? fromId : 0;
}

function offlineBeatCreatedAtReal(beat = {}) {
  const explicit = Number(beat?.createdAtReal || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const idMatch = String(beat?.id || '').match(/^ob_([a-z0-9]+)_/i);
  const fromId = Number.parseInt(idMatch?.[1] || '', 36);
  return Number.isFinite(fromId) && fromId > 0 ? fromId : 0;
}

/**
 * 已经推进过的线下现场返场时，只选上一层线下正文之后新发生的线上往来。
 * 剧情钟可能回拨，因此不用 message.timestamp，而用消息 / beat id 里的现实创建时间。
 */
export function selectOfflineReentryBridgeMessages(messages = [], session = {}, limit = 36) {
  const lastNarrationReal = [...(Array.isArray(session?.beats) ? session.beats : [])]
    .reverse()
    .find((beat) => beat?.role === 'narration');
  const cursor = Math.max(
    Number(session?.onlineBridgeConsumedAtReal || 0),
    offlineBeatCreatedAtReal(lastNarrationReal),
  );
  if (!cursor) return [];
  const cap = clampNum(limit, 8, 80, 36);
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted && !message.recalled)
    .filter((message) => offlineMessageCreatedAtReal(message) > cursor)
    .sort((a, b) => offlineMessageCreatedAtReal(a) - offlineMessageCreatedAtReal(b))
    .slice(-cap);
}

/** 把刚才那段线上消息对应的全局摘要提到跨模式时间线，避免手动总结只落在较远的通用记忆层。 */
export function selectOfflineBridgeSummaries(memories = [], bridgeMessages = [], {
  userId = '',
  limit = 2,
} = {}) {
  const rows = Array.isArray(bridgeMessages) ? bridgeMessages : [];
  if (!rows.length) return [];
  const messageIds = new Set(rows.map((message) => String(message?.id || '').trim()).filter(Boolean));
  const timestamps = rows.map((message) => Number(message?.timestamp || 0)).filter((value) => value > 0);
  const minTs = timestamps.length ? Math.min(...timestamps) : 0;
  const maxTs = timestamps.length ? Math.max(...timestamps) : 0;
  const uid = String(userId || '').trim();
  return (Array.isArray(memories) ? memories : [])
    .filter((memory) => memory?.type === 'summary'
      && !String(memory?.characterId || '').trim()
      && (!uid || !memory?.userId || String(memory.userId) === uid)
      && memory?.summarySuppressed !== true
      && String(memory?.content || '').trim())
    .filter((memory) => {
      const coveredIds = (Array.isArray(memory.summaryMessageIds) ? memory.summaryMessageIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      if (coveredIds.some((id) => messageIds.has(id))) return true;
      const fromTs = Number(memory.summaryFromTs || memory.timestamp || 0);
      const toTs = Number(memory.summaryToTs || memory.timestamp || 0);
      return minTs > 0 && maxTs >= minTs && fromTs > 0 && toTs >= minTs && fromTs <= maxTs;
    })
    .sort((a, b) => Number(a.summaryToTs || a.timestamp || 0) - Number(b.summaryToTs || b.timestamp || 0))
    .slice(-clampNum(limit, 1, 4, 2));
}

function offlineArchiveCreatedAtReal(archive = {}) {
  const explicit = Number(archive?.archivedAtReal || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const idMatch = String(archive?.id || '').match(/^oda_([a-z0-9]+)_/i);
  const fromId = Number.parseInt(idMatch?.[1] || '', 36);
  return Number.isFinite(fromId) && fromId > 0 ? fromId : 0;
}

function offlineArchiveOrder(archive = {}) {
  return offlineArchiveCreatedAtReal(archive)
    || Number(archive?.endedAt || archive?.startedAt || 0)
    || 0;
}

/** 从已收纳档案中提取当前在场角色真正可继承的最近一次线下。 */
export function selectLastEncounterSnapshot(archives = [], participantIds = []) {
  const ids = [...new Set((Array.isArray(participantIds) ? participantIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  if (!ids.length) return null;
  const all = Array.isArray(archives) ? archives : [];
  const relevant = all.filter((a) => ids.some((id) => id === a.characterId || (a.participantIds || []).includes(id)));
  if (!relevant.length) return null;
  // 剧情钟允许前进、回拨或切换时间线；“上一场”必须按真实收纳顺序判断。
  const last = [...relevant].sort((a, b) => offlineArchiveOrder(b) - offlineArchiveOrder(a))[0];
  if (!last) return null;
  const ownedMemories = (Array.isArray(last.characterMemories) ? last.characterMemories : [])
    .filter((entry) => ids.includes(String(entry?.characterId || '')))
    .map((entry) => {
      const name = String(entry?.characterName || entry?.characterId || 'TA').trim();
      const content = String(entry?.content || '').trim();
      return content ? `${name}亲历并记得：${content}` : '';
    })
    .filter(Boolean);
  return {
    title: String(last.title || '').trim(),
    summary: ownedMemories.length
      ? ownedMemories.join('\n')
      : String(last.summary || '').trim(),
    endedAt: Number(last.endedAt || last.startedAt || 0) || 0,
    archivedAtReal: offlineArchiveCreatedAtReal(last),
    kind: last.scene?.activityKind === 'trip' ? 'trip' : 'date',
    // 新开一场只带入已经成立的关系变化。hooks 是存档线索，
    // 不是下一场必须续写的待办；用户明确点“续写这段”时由 archiveContinuation 负责。
    shifts: ownedMemories.length ? [] : (Array.isArray(last.digest?.shifts) ? last.digest.shifts : []).slice(0, 2),
    hooks: [],
  };
}

/**
 * “续写这段”只保存所选档案的轻量续写快照，不把旧媒体或全部历史复制进新会话。
 * 摘要负责较早因果，尾部完整原文负责最后动作、位置、台词与停笔点。
 */
export function buildOfflineArchiveContinuationSnapshot(archive = {}, { maxNarrations = 4, maxChars = 14000 } = {}) {
  const archiveId = String(archive?.id || '').trim();
  if (!archiveId) return null;
  const contentRounds = (Array.isArray(archive?.rounds) ? archive.rounds : [])
    .filter((round) => ['opening', 'directive', 'narration', 'interlude'].includes(round?.role))
    .map((round) => ({
      id: String(round?.id || '').trim(),
      role: String(round?.role || 'narration'),
      text: String(round?.text || '').trim(),
      ts: Number(round?.ts || 0) || 0,
    }))
    .filter((round) => round.text);
  const narrationLimit = clampNum(maxNarrations, 1, 12, 4);
  let narrationSeen = 0;
  let startIndex = contentRounds.length;
  for (let index = contentRounds.length - 1; index >= 0; index -= 1) {
    startIndex = index;
    if (contentRounds[index].role === 'narration') narrationSeen += 1;
    if (narrationSeen >= narrationLimit) break;
  }
  let tail = contentRounds.slice(startIndex);
  const budget = clampNum(maxChars, 2000, 24000, 14000);
  let used = 0;
  const kept = [];
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const round = tail[index];
    const available = Math.max(0, budget - used);
    if (!available) break;
    const text = round.text.length > available
      ? round.text.slice(-available)
      : round.text;
    kept.unshift({ ...round, text });
    used += text.length;
  }
  tail = kept;
  return {
    archiveId,
    title: String(archive?.title || '').trim(),
    summary: String(archive?.summary || '').trim(),
    currentState: String(archive?.currentState || '').trim(),
    endedAt: Number(archive?.endedAt || archive?.startedAt || 0) || 0,
    tail,
  };
}

export function buildOfflineArchiveContinuationContext(snapshot = null) {
  if (!snapshot?.archiveId) return '';
  const roleLabel = {
    opening: '历史开场',
    directive: '历史用户方向（已执行）',
    narration: '历史线下原文',
    interlude: '历史现场插曲',
  };
  const tailLines = (Array.isArray(snapshot.tail) ? snapshot.tail : [])
    .map((round) => `[${roleLabel[round?.role] || '历史线下原文'}] ${String(round?.text || '').trim()}`)
    .filter((line) => !line.endsWith('] '));
  return [
    '【所选约会档案 · 精确续写锚点】',
    snapshot.title ? `档案：${snapshot.title}` : '',
    snapshot.summary ? `较早经过摘要：${snapshot.summary}` : '',
    snapshot.currentState ? `收纳时持续状态：${snapshot.currentState}` : '',
    tailLines.length ? `【档案末尾完整原文】\n${tailLines.join('\n\n')}` : '',
    '续写规则：这是用户明确点选的档案，不得改用其他更新档案代替。上面的末尾原文已经完整发生；以最后一条原文的最终动作、人物位置、正在谈论的话题和语气为唯一接续点，直接写下一拍，禁止重新入场、概括重演或跳到无关场景。',
  ].filter(Boolean).join('\n');
}

/** 找与这个会话在场角色相关的、最近一次已收尾的线下/旅行记录，供开场延续记忆用。 */
async function getLastEncounter(userId, chat, participantIds = null) {
  const ids = Array.isArray(participantIds) && participantIds.length
    ? participantIds
    : (chat?.participants || []).filter((id) => id && id !== 'user');
  const all = await listOfflineDateArchives(userId, {}).catch(() => []);
  return selectLastEncounterSnapshot(all, ids);
}

export async function startOfflineSession({
  chatId,
  userId,
  scene,
  participantIds = null,
  userPresent = null,
  attendanceSource = 'session_start',
  activitySessionId = '',
  originSeed = null,
  continuationArchive = null,
  replaceExisting = false,
  firstEncounter = false,
} = {}) {
  const existing = await loadOfflineSession(chatId);
  if (existing && offlineSessionHasProgress(existing) && !replaceExisting) {
    return existing;
  }
  let sceneDraft = createSceneDraft(scene);
  const chat = await getChat(chatId).catch(() => null);
  const resolvedUserPresent = typeof userPresent === 'boolean'
    ? userPresent
    : (Array.isArray(chat?.participants) ? chat.participants.includes('user') : true);
  if (!resolvedUserPresent) {
    sceneDraft = createSceneDraft({
      ...sceneDraft,
      perspective: 'omniscient',
      person: 'third',
      experienceMode: 'normal',
      dialogueMode: false,
      directorMode: true,
      blockUserSpeech: false,
      audioSceneEnabled: false,
    });
  }
  const worldStartTs = await getNowForUser(String(userId || '').trim()).catch(() => Date.now());
  // opening 与后续 narration 必须落在同一条世界时间线上；使用现实时间会让
  // 虚拟时间模式下的第一条线下记录跳回设备当前钟点。
  const openingBeat = openingBeatFromScene(sceneDraft, worldStartTs);
  const archiveContinuation = buildOfflineArchiveContinuationSnapshot(continuationArchive);
  const continuationParticipantIds = Array.isArray(continuationArchive?.participantIds)
    ? continuationArchive.participantIds
    : [continuationArchive?.characterId].filter(Boolean);
  const lastEncounter = archiveContinuation
    ? selectLastEncounterSnapshot([continuationArchive], continuationParticipantIds)
    : await getLastEncounter(userId, chat, participantIds).catch(() => null);
  const orderedLastEncounter = lastEncounter ? {
    ...lastEncounter,
    worldTimeConflict: Number(lastEncounter.endedAt || 0) > worldStartTs,
  } : null;
  const session = {
    id: genId(),
    chatId: String(chatId || '').trim(),
    userId: String(userId || '').trim(),
    userPresent: resolvedUserPresent,
    mode: 'date',
    activitySessionId: String(activitySessionId || '').trim(),
    originSeed: originSeed || null,
    archiveContinuation,
    firstEncounter: firstEncounter === true,
    lastEncounter: orderedLastEncounter,
    originChat: chat ? {
      type: chat.type === 'group' ? 'group' : 'private',
      participantIds: cleanOfflineParticipantIds(chat.participants, { userId }),
    } : null,
    settingsHintSeen: false,
    scene: sceneDraft,
    beats: openingBeat ? [openingBeat] : [],
    status: 'active',
    // 收纳结算用：这段线下在世界内 / 现实里分别从什么时候开始
    startedAtWorld: worldStartTs,
    startedAtReal: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  ensureOfflineBranching(session);
  if (Array.isArray(participantIds)) session.participants = cleanOfflineParticipantIds(participantIds);
  const attendance = ensureOfflineAttendance(session, chat);
  for (const member of attendance.members) member.source = String(attendanceSource || 'session_start');
  await syncOfflineSceneCompanions(session);
  await saveOfflineSession(session, { replace: !!existing || replaceExisting });
  const activeScheduleEnd = worldStartTs + 15 * 60 * 1000;
  for (const characterId of getActiveOfflineParticipantIds(session, chat)) {
    await applyOfflineActiveScheduleOverride({
      userId: session.userId,
      characterId,
      startTs: worldStartTs,
      endTs: activeScheduleEnd,
      place: session.scene?.place || '',
      activity: session.scene?.goal || (resolvedUserPresent ? '' : '角色线下同行'),
      sourceId: session.id,
    }).catch(() => {});
  }
  invalidateKeepAlive('offline', { chatId: session.chatId });
  return session;
}

/**
 * 「直接进入」：不填地点/活动，直接从线上聊天语境延续进线下。
 * 已有未收纳会话时原样返回（绝不覆盖进度）；场景留空，交给 AI 按聊天末段推断此刻的时空。
 */
export async function startOfflineSessionDirect({ chatId, userId, note = '', sceneOverrides = null, userPresent = null } = {}) {
  const existing = await loadOfflineSession(chatId);
  if (shouldResumeExistingOfflineSession(existing)) return { session: existing, resumed: true };
  const [worldNow, timeZone] = await Promise.all([
    getNowForUser(userId).catch(() => Date.now()),
    getUserTimezone(userId).catch(() => ''),
  ]);
  const hm = formatZonedClock(worldNow, timeZone);
  const session = await startOfflineSession({
    chatId,
    userId,
    userPresent,
    scene: await createSceneDraftWithLastPreset(userId, {
      openingLine: String(note || '').trim(),
    }, sceneOverrides),
    originSeed: {
      from: 'direct',
      place: '',
      activity: '',
      note: String(note || '').trim(),
      timeLabel: `今天 ${hm}`,
    },
  });
  return { session, resumed: false };
}

/**
 * 初遇模式：和一个尚未加入通讯录的角色（encounter_pending 分组）先开一场线下相遇。
 * - 创建/复用带 firstEncounterPending 标记的私聊（不出现在收件箱）
 * - 会话打 firstEncounter 标记，推进提示按「第一次见面」写
 * - 收纳时由 finalizeFirstEncounter 正式写入通讯录
 */
export async function startFirstEncounterSession({ userId, characterId, place = '', note = '' } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) throw new Error('userId / characterId required');
  const character = await getCharacter(cid);
  if (!character) throw new Error('character not found');
  const chat = await ensurePrivateChat(uid, cid, character.name || '', {
    preserveEncounterPending: true,
  });
  if (!chat.metadata?.firstEncounterPending) {
    chat.metadata = { ...(chat.metadata || {}), firstEncounterPending: true };
    await saveChat(chat);
  }
  const existing = await loadOfflineSession(chat.id);
  if (existing) return { chatId: chat.id, session: existing, resumed: true };
  const [worldNow, timeZone] = await Promise.all([
    getNowForUser(uid).catch(() => Date.now()),
    getUserTimezone(uid).catch(() => ''),
  ]);
  const hm = formatZonedClock(worldNow, timeZone);
  const session = await startOfflineSession({
    chatId: chat.id,
    userId: uid,
    scene: await createSceneDraftWithLastPreset(uid, {
      place: String(place || '').trim(),
      openingLine: String(note || '').trim(),
    }),
    originSeed: {
      from: 'first',
      place: String(place || '').trim(),
      activity: '',
      note: String(note || '').trim(),
      timeLabel: `今天 ${hm}`,
    },
    firstEncounter: true,
  });
  return { chatId: chat.id, session, resumed: false };
}

/**
 * 初遇收纳后转正：把角色移出 encounter_pending 分组、私聊摘掉 firstEncounterPending 标记，
 * 让角色出现在通讯录、聊天出现在收件箱。幂等，可安全重复调用。
 */
export async function finalizeFirstEncounter({ chatId, userId } = {}) {
  const chat = await getChat(String(chatId || '').trim()).catch(() => null);
  if (!chat) return false;
  let changed = false;
  if (chat.metadata?.firstEncounterPending) {
    const md = { ...(chat.metadata || {}) };
    delete md.firstEncounterPending;
    chat.metadata = md;
    await saveChat(chat);
    changed = true;
  }
  const uid = String(userId || chat.userId || '').trim();
  const others = (chat.participants || []).filter((p) => p && p !== 'user' && p !== uid);
  for (const pid of others) {
    const character = await getCharacter(pid).catch(() => null);
    if (character && isEncounterPendingCharacter(character)) {
      character.groupId = 'default';
      await saveCharacter(character);
      changed = true;
    }
  }
  return changed;
}

/** 从 char 主动邀约的消息（marshmallow offline_invite 事件落库后的 metadata）构建场景种子。 */
export function buildSceneSeedFromInviteMetadata(md = {}, fallbackNote = '', inviteMessage = null) {
  const inviteKind = String(md.kind || '').trim() === 'trip' ? 'trip' : 'stay';
  const place = String(md.place || '').trim();
  const activity = String(md.activity || '').trim();
  const note = String(md.note || fallbackNote || '').trim();
  const timeLabel = formatInviteTimeLabel(md, inviteMessage);
  const companions = companionsFromInviteMetadata(md);
  return {
    originSeed: {
      from: md.inviteFrom || 'character',
      place,
      activity,
      note,
      timeLabel,
      companions,
      routeSummary: String(md.route?.summary || '').trim(),
    },
    scene: createSceneDraft({
      place,
      goal: [activity, note].filter(Boolean).join('；'),
      companions,
      tone: md.tone,
      activityKind: inviteKind,
      openingLine: '',
    }),
  };
}

/** 邀约卡上的时间：优先 AI 写的 timeLabel，否则用发卡时间动态落到「今天/明天/具体日期」。 */
export function formatInviteTimeLabel(md = {}, inviteMessage = null) {
  const labeled = String(md.timeLabel || '').trim();
  if (labeled) return labeled;
  const ts = Number(inviteMessage?.timestamp || md.createdAt || 0);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const when = new Date(ts);
  if (Number.isNaN(when.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWhen = new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
  const dayDiff = Math.round((startOfWhen - startOfToday) / 86400000);
  const hm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `明天 ${hm}`;
  if (dayDiff === -1) return `昨天 ${hm}`;
  return `${when.getMonth() + 1}月${when.getDate()}日 ${hm}`;
}

/** 群聚邀约：发起人 + 被邀请群友；私聊通常只有发起人，留空表示只有彼此。 */
export function companionsFromInviteMetadata(md = {}) {
  const names = [];
  const push = (value) => {
    const name = String(value || '').trim();
    if (name && !names.includes(name)) names.push(name);
  };
  push(md.initiatorName);
  for (const name of (Array.isArray(md.inviteeNames) ? md.inviteeNames : [])) push(name);
  // 私聊一对一：只有发起人名字时不必写进同行者，场景里默认就是彼此
  if (names.length <= 1 && md.isGroupInvite !== true) return '';
  return names.join('、');
}

/** char 邀约卡「进入线下沉浸」：在跳转前就把 session 建好，避免落地后再弹一次确认表单。 */
export async function startOfflineSessionFromInvite({
  chatId,
  userId,
  inviteMessage,
  replaceExisting = false,
  experienceMode = 'normal',
}) {
  const md = inviteMessage?.metadata || {};
  const { originSeed, scene } = buildSceneSeedFromInviteMetadata(md, inviteMessage?.content || '', inviteMessage);
  originSeed.inviteMessageId = String(inviteMessage?.id || '').trim();
  const groupAttendees = md.isGroupInvite === true
    ? [
      String(md.initiatorId || inviteMessage?.senderId || '').trim(),
      ...(Array.isArray(md.groupResponses)
        ? md.groupResponses.filter((row) => row?.attending).map((row) => row.id)
        : (Array.isArray(md.inviteeIds) ? md.inviteeIds : [])),
    ].filter(Boolean)
    : null;
  return startOfflineSession({
    chatId,
    userId,
    scene: await createSceneDraftWithLastPreset(userId, scene, {
      experienceMode: md.isGroupInvite === true ? 'normal' : experienceMode,
    }),
    originSeed,
    replaceExisting,
    participantIds: groupAttendees,
    attendanceSource: md.isGroupInvite === true ? 'group_invite' : 'offline_invite',
  });
}

/**
 * 从某张邀约卡进入线下：必须对准这张卡，不能 silently 复用同 chat 里另一场旧 session。
 * - 同 inviteMessageId → 续写
 * - 无 session / 旧 session 已对应 fulfilled·婉拒·无进度 → 清掉后按本卡新建
 * - 另有一场仍在推进的线下 → 不覆盖，返回 blockedByExisting
 */
export async function ensureOfflineSessionFromInvite({
  chatId,
  userId,
  inviteMessage,
  experienceMode = 'normal',
}) {
  const clickedId = String(inviteMessage?.id || '').trim();
  const inviteStatus = String(inviteMessage?.metadata?.status || '').trim();
  if (inviteStatus === 'fulfilled') {
    return {
      session: null,
      justStarted: false,
      fulfilled: true,
      archiveId: String(inviteMessage?.metadata?.offlineDateArchiveId || '').trim(),
    };
  }

  const existing = await loadOfflineSession(chatId);
  if (!existing) {
    const session = await startOfflineSessionFromInvite({ chatId, userId, inviteMessage, experienceMode });
    return { session, justStarted: true };
  }

  const existingInviteId = String(existing.originSeed?.inviteMessageId || '').trim();
  if (clickedId && existingInviteId && existingInviteId === clickedId) {
    return { session: existing, justStarted: false };
  }

  let originDone = false;
  if (existingInviteId) {
    const originInvite = await getRecord('messages', existingInviteId).catch(() => null);
    const originStatus = String(originInvite?.metadata?.status || '').trim();
    originDone = ['fulfilled', 'declined', 'others_went'].includes(originStatus);
  }

  // 有真实进度的场绝不能因「换卡」清掉
  if (offlineSessionHasProgress(existing)) {
    return {
      session: existing,
      justStarted: false,
      blockedByExisting: true,
    };
  }

  // 无进度：旧邀约已结束，或仅开场白残留 → 可安全换成当前这张卡
  if (originDone || !existingInviteId || existingInviteId !== clickedId) {
    await clearOfflineSession(chatId, { sessionId: existing.id });
    const session = await startOfflineSessionFromInvite({
      chatId,
      userId,
      inviteMessage,
      replaceExisting: true,
      experienceMode,
    });
    return { session, justStarted: true, replacedStale: true };
  }

  return {
    session: existing,
    justStarted: false,
    blockedByExisting: true,
  };
}

/** 「他的手机」活动探索进入线下：同样先建好 session 再跳转。 */
export async function startOfflineSessionFromActivitySession({ chatId, userId, activitySession }) {
  const scene = await createSceneDraftWithLastPreset(userId, buildOfflineSceneFromActivitySession(activitySession));
  const originSeed = {
    from: 'activity',
    place: activitySession?.routePlan?.destination || activitySession?.title || '',
    activity: activitySession?.title || '',
    note: activitySession?.routePlan?.summary || activitySession?.motivation || '',
    timeLabel: '活动探索',
  };
  return startOfflineSession({ chatId, userId, scene, activitySessionId: activitySession?.id || '', originSeed });
}

function sceneLines(scene = {}, extras = {}) {
  const lines = [];
  if (scene.place) lines.push(`地点：${scene.place}`);
  if (extras.weatherLine) lines.push(`天气/环境：${extras.weatherLine}`);
  else if (scene.weather) lines.push(`天气/环境：${scene.weather}`);
  if (scene.companions) lines.push(`同行者：${scene.companions}`);
  if (extras.timeLabel) lines.push(`本场开场/约定时间：${extras.timeLabel}`);
  if (scene.goal) lines.push(`一起做什么：${scene.goal}`);
  if (scene.tone) lines.push(`语气/氛围：${scene.tone}`);
  if (scene.activityKind === 'trip' && Number(scene.durationDays) > 1) {
    lines.push(`行程进度：第 ${Number(scene.dayIndex || 0) + 1} / 共 ${scene.durationDays} 天`);
  }
  if (scene.itinerary) {
    lines.push(...buildItineraryDayContextLines(scene.itinerary, Number(scene.dayIndex || 0)));
  }
  return lines.join('\n');
}

const NARRATION_SYSTEM = [
  '下面不是线上聊天续写，而是一段线下沉浸推进。可见部分只输出叙事正文（旁白、动作、场景，可夹少量关键对白），不要输出聊天气泡、发送标签、群聊格式、角色名冒号接台词，也不要补充解释。',
  '可见正文禁止用方头括号、方括号或圆括号包裹音效分类，也不要输出舞台提示或素材名；真实发生的声音只能写进完整自然的叙事句。',
  '只有本轮用户提示明确要求的 <<<...>>> 尾部结构块可以在正文之后输出 JSON；这些块属于隐藏动作与走向数据，不是可见正文。除此之外禁止任何 JSON、协议事件或自创标签。',
  '每一轮都要让剧情发生一件具体的、能被记住的事，拒绝空泛的氛围烘托与心理独白堆砌。',
  '完整成稿必须输出到可见 content；原生 reasoning/thinking 字段和 <<<THINKING>>> 隐藏块都不能替代最终正文。若本轮提示要求生成 <<<THINKING>>> 回执，无论接口是否另有原生推理通道，都必须先在 content 中完整输出该回执，再从 <<<END_THINKING>>> 之后开始正式叙事正文。',
  '正文必须直接是中文叙事，第一句话起就是场景/动作/对白；严禁出现任何英文思考总结（如 "I am…/My approach…/Developing…"）、英文或中文的加粗小标题、计划清单。',
].join('\n');

const AUDIO_NARRATION_SYSTEM = [
  '下面不是普通线下长文，而是一幕供逐段播放的音声演出。可见正文必须同时包含静音旁白与角色现场说出的直接对白；对白是演出主体之一，不是偶尔点缀。不要输出聊天气泡、发送标签、群聊格式、角色名冒号接台词，也不要补充解释。',
  '按“短旁白拍点 → 一句角色对白 → 短旁白拍点 → 一句角色对白”组织。每个拍点和每句对白分别独立成段；旁白通常只写一至两句，不连续堆叠多个旁白段，不写需要由播放器再次切开的小说式长段。',
  '可见正文禁止用方头括号、方括号或圆括号包裹音效分类，也不要输出舞台提示或素材名；真实发生的声音只能写进完整自然的旁白句。',
  '只有本轮用户提示明确要求的 <<<...>>> 结构可以输出；这些标记与文末数据属于机器协议，不是可见正文。除此之外禁止任何 JSON、协议事件或自创标签。',
  '每一轮都要让剧情发生一件具体、能被记住的事。把情绪主要交给角色真正说出口的话、停顿与气息，不用连续环境铺陈或心理分析挤掉对白。',
  '完整成稿必须输出到可见 content；原生 reasoning/thinking 字段和 <<<THINKING>>> 隐藏块都不能替代最终正文。若本轮提示要求生成 <<<THINKING>>> 回执，无论接口是否另有原生推理通道，都必须先在 content 中完整输出该回执，再从 <<<END_THINKING>>> 之后开始正式演出。',
  '正文第一句话起就是旁白或对白；严禁出现任何英文思考总结（如 "I am…/My approach…/Developing…"）、英文或中文的加粗小标题、计划清单。',
].join('\n');

const AUDIO_STAGE_SEGMENTATION_HINT =
  '【音声成稿排版复核】可见正文不得套用普通长文的“长短段错落”写法。提交前只检查演出顺序：短旁白与角色对白是否各自独立成段并持续交替；若出现连续旁白或一段内堆了多个动作拍点，压缩为一个会改变下一句对白意义的短拍点，然后立刻回到角色对白。';

function clipOfflinePersonaField(value = '', maxChars = 360) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * 完整角色卡已经在共享上下文中注入；这里把最影响当轮表演的证据重新贴到生成点附近。
 * 这不是另造一份摘要人设，而是防止长篇协议和文风预设把角色卡的注意力冲淡。
 */
export function buildOfflinePersonaNearEndBlock(characterRows = [], { userPresent = true } = {}) {
  const rows = (Array.isArray(characterRows) ? characterRows : [])
    .filter((row) => row && (row.id || row.name || row.realName))
    .slice(0, 8);
  if (!rows.length) return '';
  const cards = rows.map((row) => {
    const name = clipOfflinePersonaField(row.customNickname || row.name || row.realName || row.id, 60);
    const lines = [`【${name || '角色'} · 当轮表演证据】`];
    const role = clipOfflinePersonaField(row.currentRole, 160);
    const status = clipOfflinePersonaField(row.currentStatus, 160);
    const relation = clipOfflinePersonaField(row.userRelationStatus, 180);
    const personality = clipOfflinePersonaField(row.personality, 260);
    const speechStyle = clipOfflinePersonaField(row.speechStyle, 260);
    const speechCorpus = clipOfflinePersonaField(row.speechCorpus, 420);
    const promptCorpus = clipOfflinePersonaField(row.promptCorpus, 560);
    if (role) lines.push(`身份：${role}`);
    if (status) lines.push(`此刻状态：${status}`);
    if (relation && userPresent) lines.push(`与用户关系：${relation}`);
    if (personality) lines.push(`性格证据：${personality}`);
    if (speechStyle) lines.push(`说话方式：${speechStyle}`);
    if (speechCorpus) lines.push(`对白语料摘录：${speechCorpus}`);
    if (promptCorpus) lines.push(`角色资料摘录：${promptCorpus}`);
    return lines.join('\n');
  });
  return [
    '【当轮角色卡近端索引】',
    '完整角色卡仍以上文【角色 ·】卡为准。下列只是把身份、当前状态、关系、性格与口吻字段移到生成点附近，避免长上下文漏读；不得把摘录当成新文风、新剧情或对完整角色卡的替代。',
    '角色如何行动和说话继续按这些人物资料与本场事实判断；通用叙事预设只调整表达方式。不要输出资料复述或分析过程。',
    ...cards,
  ].join('\n');
}

function normalizeOfflineDirectiveProbe(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
}

function offlineDirectiveLiteralSegments(text = '') {
  const segments = String(text || '')
    .replace(/\([^)]*\)|（[^）]*）/g, ' ')
    .split(/[\s，。！？；：、,.!?;:"“”‘’《》【】()[\]{}<>—…]+/)
    .map((part) => normalizeOfflineDirectiveProbe(part))
    .filter((part) => part.length >= 5);
  const fragments = segments.flatMap((part) => {
    if (part.length === 5) return [part];
    const windows = [];
    for (let index = 0; index <= part.length - 5; index += 1) {
      windows.push(part.slice(index, index + 5));
    }
    return [part, ...windows];
  });
  return [...new Set(fragments)].sort((a, b) => b.length - a.length);
}

function offlineDirectiveBigrams(text = '') {
  const normalized = normalizeOfflineDirectiveProbe(text);
  const ignored = new Set([
    '我们', '你们', '他们', '她们', '这里', '那里', '这个', '那个',
    '没有', '可以', '还是', '已经', '因为', '如果', '然后', '只是',
    '就是', '不是', '什么', '怎么', '现在', '自己',
  ]);
  const grams = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const gram = normalized.slice(index, index + 2);
    if (!ignored.has(gram)) grams.push(gram);
  }
  return [...new Set(grams)];
}

/**
 * 只拦截证据很强的“继续回答旧方向”：
 * - 正文逐字带回上一条方向中的长片段；
 * - 同时完全没有命中本轮新方向的任何有效双字锚点。
 * 语义相近但没有逐字复读时不额外耗费一次 API，避免正常承接被误判。
 */
export function detectOfflineStaleDirectiveReplay({
  narration = '',
  currentDirective = '',
  previousDirectives = [],
} = {}) {
  const normalizedNarration = normalizeOfflineDirectiveProbe(narration);
  const normalizedCurrent = normalizeOfflineDirectiveProbe(currentDirective);
  if (!normalizedNarration || normalizedCurrent.length < 4) {
    return { stale: false, matchedHistoricalFragment: '', currentAnchorMatched: false };
  }

  const historicalFragments = (Array.isArray(previousDirectives) ? previousDirectives : [])
    .filter((text) => normalizeOfflineDirectiveProbe(text) !== normalizedCurrent)
    .flatMap((text) => offlineDirectiveLiteralSegments(text));
  const matchedHistoricalFragment = historicalFragments
    .find((fragment) => normalizedNarration.includes(fragment)) || '';
  if (!matchedHistoricalFragment) {
    return { stale: false, matchedHistoricalFragment: '', currentAnchorMatched: false };
  }

  const currentAnchorMatched = offlineDirectiveBigrams(currentDirective)
    .some((anchor) => normalizedNarration.includes(anchor));
  return {
    stale: !currentAnchorMatched,
    matchedHistoricalFragment,
    currentAnchorMatched,
  };
}

export function buildOfflineCurrentDirectiveTail(directive = '', { userPresent = true } = {}) {
  const trimmed = String(directive || '').trim();
  if (!trimmed) return '';
  return [
    '【本轮最新方向 · 唯一续写起点 · 最高优先级】',
    trimmed,
    `这是${userPresent ? '用户' : '屏幕外旁观者'}刚刚给出的最新输入。历史里的“${userPresent ? '用户方向' : '旁观导演方向'}”都已经执行完毕，只能作为既定事实，禁止重新回应、引用或换词复演。`,
    '正文第一拍必须体现角色或环境对这条最新输入的直接反应，再向前推进一个新拍点；不要复述这条输入本身。',
  ].join('\n');
}

/**
 * 必须位于本轮最新方向之后：部分模型会把“最高优先级的最新方向”误解成可覆盖防抢话。
 * 这里最后再钉一次身份边界，不改变用户已明确写出的既定动作。
 */
export function buildOfflineAntiInterruptionTail(scene = {}, { userPresent = true, userName = '' } = {}) {
  if (!userPresent || scene?.blockUserSpeech === false) return '';
  const person = scene?.person || 'second';
  const userRef = person === 'first' ? '“我”' : (person === 'third' ? '用户这一侧' : '“你”');
  const namedUser = String(userName || '').trim();
  const narrationAddressRule = person === 'first'
    ? '叙述正文仍只用“我”指代用户，不得切换成用户姓名、TA、他或她。'
    : (person === 'third'
      ? '叙述正文仍只用用户姓名或中性 TA 指代用户；资料未明确时不得猜成“他／她”。'
      : '叙述正文仍只用“你”指代用户，不得切换成用户姓名、TA、他或她。');
  const userAliases = [...new Set([
    userRef,
    namedUser ? `姓名“${namedUser}”` : '用户姓名',
    'TA',
    '指向用户的“他／她”',
  ])].join('、');
  return [
    '【输出前最终身份校验 · 防抢话仍为硬限制】',
    `上面的本轮最新方向只描述用户已经给出的内容，不授予你继续扮演 ${userRef} 的权限。`,
    `正文逐句检查并删除所有由你新增的 ${userRef} 台词、心理、表情、动作、回应、决定与选择；只保留角色和环境的新反应。`,
    `语义身份复查：无论写成 ${userAliases}，只要实际指向用户，就不得让该实体成为任何新增动作、感知、台词或判断的执行者。把“你”替换成用户姓名、TA、他或她仍然属于代写，必须删除。用户只能作为角色观察、称呼、回应或动作所指向的对象。`,
    `【人称保持】防抢话只限制用户的能动性，不改变“用户在正文中的称呼”。${narrationAddressRule}角色对白中按人物关系直接称呼用户姓名不受此限制。`,
    '用户输入里明确写明已经发生的用户动作可作为既定事实被角色感知，但不得扩写、续演或补出台词。',
  ].join('\n');
}

export function buildOfflineStaleDirectiveRepairTail(directive = '') {
  const current = String(directive || '').trim();
  if (!current) return '';
  return [
    '【自动纠偏重试 · 最高优先级】',
    '上一稿错误地回应了更早一轮的用户方向，已经作废，不得复用其措辞、动作、回应对象或段落结构。',
    `本轮唯一需要直接承接的最新输入：${current}`,
    '从最后一段有效叙事的结尾继续；正文第一拍必须体现角色或环境对这条最新输入的反应。历史用户方向都已执行完毕。',
  ].join('\n');
}

/** 相遇独立模式：不读取线上 chatPrefs；组合开启时由这里统一解释优先级。 */
function offlineInputModeRules(scene = {}, participantNames = [], { userPresent = true } = {}) {
  if (!userPresent) {
    const cast = participantNames.length ? participantNames.join('、') : '在场角色';
    return [
      '【旁观线下 · 导演输入】',
      `user 只是屏幕外的旁观者，不在现场，不是故事人物。本轮输入只是对 ${cast} 的剧情方向或导演指令。`,
      '输入里的“你”默认指当前被指导的角色；多人时优先按明确姓名归属动作与台词。“我想看／让他们”是旁观者的导演意图，绝不得把“我”写进场景。',
      '所有在场角色都可以自主行动、对话和做决定；要把他们之间的互动完整演到新节点，不得留出一个隐形的“用户位”。',
      '新方向中已经指定发生的内容视为已发生；正文从下一拍继续，不机械复述指令。',
    ].join('\n');
  }
  const dialogue = scene.dialogueMode === true;
  const noParaphrase = scene.noParaphrase !== false;
  const director = scene.directorMode === true;
  const blockSpeech = scene.blockUserSpeech !== false;
  const leadName = String(participantNames[0] || '当前主角色').trim() || '当前主角色';
  const lines = ['【本场用户输入解释】'];
  if (dialogue && director) {
    lines.push('对话模式与导演模式同时开启：把明确的引号台词、第一人称直接发言视为用户已经说出口的话；其余简短动作、场景要求和剧情意图视为导演指令。不要把两类内容混成用户台词。');
  } else if (dialogue) {
    lines.push('【对话模式】用户本轮输入默认是用户已经说出口的发言。角色从听见这句话后的反应继续演，不要把它当写作要求或待生成台词。');
  } else if (director) {
    lines.push('【导演模式】用户本轮输入是场景指导或剧情大纲，不是用户台词。按角色人设、现场状态和这条指导扩写成完整场景。');
  } else {
    lines.push('用户本轮输入是推进方向：只取其中的意图和已明确发生的动作，按当前时间线自然续写。');
  }
  if (dialogue) {
    lines.push(`【输入代词】用户发出的对白里，“我”指用户本人，“你／你们”指用户正在对话的 ${leadName}${participantNames.length > 1 ? ' 或被点名的现场角色' : ''}；不要因为生成正文采用第二人称，就把对白里的“你”反转成用户。`);
  } else {
    lines.push(`【输入代词】用户是在给角色下推进方向：输入里的“你”默认指 ${leadName}，“我／用户”才指用户本人；若整句明显是一句用户说出口的自然对白，则对白里的“你”同样指被用户说话的角色。只有用户明确写“用户／我做……”时，才把该动作归给用户。`);
  }
  lines.push('上面只规定如何理解用户输入。你生成的叙事正文仍严格遵守下方“视角／人称”设置，两套代词规则不得互相覆盖。');
  if (noParaphrase) {
    lines.push('【防转述】用户输入里已经说过、做过或指定完成的内容都视为已经发生；正文从角色的下一拍反应开始，禁止复述、改写、总结或再演一遍用户原文。');
  } else {
    lines.push('未开启防转述：为了衔接可以自然带到用户输入中的必要片段，但不要机械逐字复读。');
  }
  if (director && !blockSpeech) {
    lines.push('导演模式且未开启防抢话：允许把用户这一侧也纳入连续扮演，可补足用户的动作、表情和必要台词，让场景完整向前演；仍不得擅自制造违背用户指导的重大决定。');
  } else if (director && blockSpeech) {
    lines.push('导演模式且开启防抢话：只扩展环境与角色侧的动作、心理和对白；用户指令中已明确的用户行为可视为完成，但禁止新增用户台词、动作或决定。');
  }
  return lines.join('\n');
}

/** 防抢话开启时追加的硬约束：禁止扮演用户，只写角色侧反应。 */
export function blockUserSpeechRules(person = 'second', { userName = '' } = {}) {
  const userRef = person === 'first' ? '「我」' : (person === 'third' ? '用户这一侧（名字 / TA）' : '「你」');
  const namedUser = String(userName || '').trim();
  const narrationAddressRule = person === 'first'
    ? '对白外的叙述正文仍只用「我」指代用户，不得切成用户姓名、TA、他或她。'
    : (person === 'third'
      ? '对白外的叙述正文仍只用用户姓名或中性 TA 指代用户；资料未明确时不得猜成「他／她」。'
      : '对白外的叙述正文仍只用「你」指代用户，不得切成用户姓名、TA、他或她。');
  const userAliases = [...new Set([
    userRef,
    namedUser ? `姓名「${namedUser}」` : '用户姓名',
    'TA',
    '指向用户的「他／她」',
  ])].join('、');
  return [
    '【防抢话 · 硬限制】本轮严禁扮演用户。',
    `- 禁止写出 ${userRef} 的台词、内心独白、主动决定、主动开口或替用户完成选择。`,
    `- 禁止用叙述口吻编造「${userRef} 说了 / 回答了 / 决定了 / 伸手做了某事」这类用户侧主动行为（用户开场白里已写明的动作除外，且不得扩写新台词）。`,
    `- 【语义身份硬边界】无论写成 ${userAliases}，只要实际指向用户，都不得成为任何新增动作、感知、身体反应、台词或判断的执行者。禁止“你／${namedUser || '用户姓名'}走向、拿起、喝水、擦汗、看见、听见、觉得、回答、选择”；改称姓名、TA、他或她不构成第三人称豁免。用户只能作为角色观察、称呼、回应或动作所指向的对象。`,
    `- 【人称保持】防抢话不等于切换叙事人称。${narrationAddressRule}角色对白中的称呼仍服从人物关系。`,
    '- 正文只推进角色（char）相关的反应扮演：神态、动作、环境反馈、角色对白，以及不需要代写用户也能发生的现场事件。',
    `- 可以把 ${userRef} 当作在场的一方来被观察、被回应，但镜头与能动性必须落在角色身上；用户侧留白只表示不代写用户，角色自己的动作、对白与即时后果仍要完整落地，不要为了等下一条输入把句子或动作截在半空。`,
    '【角色侧内在连续性】防抢话不等于只剩外部动作。用户已经明确输入的言行可以触发角色自己的有限视角心理：他先注意到什么、下意识怎样理解、是否改口或换一种做法。只在确有内容时选一两层自然穿插，不机械打卡，也不为了“细腻”把每句话都拆成完整心理链。',
    '- 心理应来自当前人物的偏见、秘密、旧经验或关系顾虑，并实际改变后续对白或动作；短回复与短篇幅下，直接接话本身就可以成立。禁止只写“审视、复杂、若有所思”，也禁止用“似乎在判断用户究竟是 A 还是 B”替用户编造内心选项。角色可以猜错，但只能把猜测写成自己的不确定。',
    '- 已在场的 NPC 只有被本轮真实触动时才反应，不为填补用户侧空白临时召来新人物或平均点名。不要用倒水、喝水、放杯、整理袖口、看钟、看窗等连续道具动作凑篇幅；物件只有影响角色判断、暴露习惯或造成后果时才写。',
    `- 禁止用“角色静静等待 / 看着 ${userRef} 等回应 / 把选择交给 ${userRef} / 空白留给 ${userRef}”之类句子收尾；自然写完角色这一拍即可。`,
  ].join('\n');
}

/**
 * 防抢话与“用户视角”同时开启时，用户只能是镜头所在位置与被回应对象，
 * 不能再用“所见所闻”措辞把用户误设为可续写的叙述主体。
 */
export function offlinePerspectiveText(scene = {}, { userName = '' } = {}) {
  const perspective = String(scene?.perspective || 'user');
  const person = scene?.person || 'second';
  const base = perspectiveText(perspective, person);
  if (scene?.blockUserSpeech === false) return base;
  if (perspective === 'user') {
    const userRef = person === 'first' ? '「我」' : (person === 'third' ? '用户名字或 TA' : '「你」');
    const namedUser = String(userName || '').trim();
    return [
      `视角：贴近用户所在位置的限制镜头，正文用 ${userRef} 指代用户，但用户不是可续写的叙述主体。`,
      '镜头只写角色能观察到的、用户输入已经明确成立的外部事实，以及角色由此产生的心理、动作和对白。',
      `禁止用“${userRef} 看见／听见／感觉／想到／走向／拿起／回答”等句式建立用户的感知或行动；画面推进与叙述能动性始终落在角色和环境。`,
      `${namedUser ? `把「你」改写成「${namedUser}」` : '改写成用户姓名'}、TA、他或她仍然指向同一个用户，不得借第三人称继续代写。`,
    ].join('');
  }
  if (perspective === 'omniscient') {
    return `${base} 防抢话开启：全知只授权进入角色与 NPC 的内心和行动，不授权补写用户的动作、感知、心理或决定。`;
  }
  return base;
}

export function paceHint(beatIndex, rounds, { userPresent = true } = {}) {
  const total = Math.max(1, Number(rounds) || 1);
  if (beatIndex >= total) {
    return '长线续写：用户正在继续这一场，不要因为超过参考轮数而自行收束、跳场或重置剧情；优先承接既有进展。';
  }
  const ratio = beatIndex / Math.max(1, total - 1);
  if (ratio < 0.34) return '开场阶段：落到一个具体的互动起点，不要泛泛交代背景。';
  if (ratio < 0.74) return userPresent
    ? '推进阶段：聚焦用户这一侧与对方之间的互动与张力，让这段交互往前走一步。'
    : '推进阶段：聚焦在场角色之间的互动与张力，让关系和具体事件往前走一步。';
  return '参考轮数后段：轮数只控制推进密度，不代表本场即将结束；完成当前小节点即可，可以平静落地，也可以自然延续，不要求制造高潮、转折、悬念或收尾。';
}

export function responseSpaceInstruction(person) {
  if (person === 'first') {
    return '代入感：需要让场景落地时，只选当前视角人物会注意、并会影响其动作或判断的一两处具体细节；不要按五感或镜头顺序盘点环境。把本轮角色动作、对白和即时后果完整写到一个可回应的新局面，自然停笔即可，不必额外制造悬念，也不要写成角色停下来等待「我」回答或选择。';
  }
  if (person === 'third') {
    return '代入感：需要让场景落地时，只选当前视角人物会注意、并会影响其动作或判断的一两处具体细节；不要按五感或镜头顺序盘点环境。把本轮角色动作、对白和即时后果完整写到一个可回应的新局面，自然停笔即可，不必额外制造悬念，也不要写成角色停下来等待用户回答或选择；正文继续保持第三人称。';
  }
  return '代入感：需要让场景落地时，只选当前视角人物会注意、并会影响其动作或判断的一两处具体细节；不要按五感或镜头顺序盘点环境。把本轮角色动作、对白和即时后果完整写到一个可回应的新局面，自然停笔即可，不必额外制造悬念，也不要写成角色停下来等待「你」回答或选择。';
}

export function naturalEndingInstruction(person) {
  const common = '停笔：先完整写完本轮正在发生的角色动作、对白和即时反应，再停在自然形成的新局面。普通日常节点也可以结束本轮，不要求悬念、转折或高潮。只有剧情中真实发生打断时，才可保留未完成动作；禁止为了吊住下一轮用“下一秒／忽然／正要……”另起一个不落地的动作，也不要用孤立破折号或省略号截断句子。';
  if (person === 'first') {
    return `${common} 不要替「我」写下一步，也不要让角色静静等待「我」回应、决定或作出选择。`;
  }
  if (person === 'third') {
    return `${common} 不要替用户这一侧写下一步，也不要让角色静静等待用户回应、决定或作出选择；全文继续保持第三人称。`;
  }
  return `${common} 不要替「你」写下一步，也不要让角色静静等待「你」回应、决定或作出选择。`;
}

function lastEncounterLine(lastEncounter) {
  if (!lastEncounter?.summary) return '';
  const kindLabel = lastEncounter.kind === 'trip' ? '上次一起旅行' : '上次相遇';
  const endedLabel = lastEncounter.worldTimeConflict
    ? '先前已收纳'
    : (lastEncounter.endedAt
    ? new Date(lastEncounter.endedAt).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    : '');
  const anchors = [
    lastEncounter.shifts?.length ? `当时的情感与认知变动：${lastEncounter.shifts.join('；')}` : '',
  ].filter(Boolean).join('。');
  return `[${endedLabel || '此前'}][已完成线下·${kindLabel}] ${lastEncounter.title ? `${lastEncounter.title}；` : ''}${lastEncounter.summary}${anchors ? `。${anchors}` : ''}`;
}

export function offlineNarrationLengthInstruction(wordMin = 200, wordMax = 500) {
  const min = Math.max(30, Math.round(Number(wordMin) || 200));
  const max = Math.max(min + 30, Math.round(Number(wordMax) || 500));
  const substantiveParagraphFloor = Math.max(3, Math.ceil(min / 160));
  const naturalParagraphCeiling = Math.max(
    substantiveParagraphFloor + 4,
    Math.ceil(max / 80),
  );
  const progressionStageFloor = Math.max(2, Math.ceil(min / 450));
  return [
    `【篇幅与段落验收】正文必须认真落在 ${min}~${max} 字之间；${min} 字是完整展开后的下限，不是写到附近就可以提前收束的参考值。`,
    `动笔前按 ${substantiveParagraphFloor}~${naturalParagraphCeiling} 个自然段规划正文容量，上限特意留得较宽，让对话、停顿和转折能够自然换气；其中至少 ${substantiveParagraphFloor} 个必须是有动作、对话抛接、人物信息或现场后果的有内容段落。同一主要拍点内至少完整展开 ${progressionStageFloor} 个推进环节（如触发、真实抛接、行动变化、即时后果）。`,
    '一句对白、停顿或转折可以独立成短段，连续动作链也可自然合并成长段；不要为了命中段落数拆碎完整句子，也不能用批量短句、空行或等长豆腐块充当有内容段落。达到字数下限前不得用总结、突然跳时或等待回复偷懒停笔；补足只能增加会改变现场的动作、对话、选择后果或贴身细节，不复述设定、情绪或五感凑字。',
    '正文末尾不汇报字数或段落数。',
  ].join('\n');
}

export function buildOfflineCurrentTimeAnchor(currentTimeLabel = '', openingTimeLabel = '') {
  const current = String(currentTimeLabel || '').trim();
  if (!current) return '';
  const opening = String(openingTimeLabel || '').trim();
  return [
    '【当前线下时间锚 · 每轮重新读取】',
    `现在：${current}。`,
    '本轮出现“现在、今天、今晚、早上、下午、深夜、刚才、已经过了多久”等时间判断时，一律以这里为准；环境明暗、作息和人物对时间的反应也必须与它一致。',
    opening ? `上方“本场开场/约定时间：${opening}”只记录进入本场时的起点，不代表本轮仍停在那个钟点。` : '',
    '旧聊天、旧摘要和较早线下正文里的日期或钟点仍是已经发生过的历史记录，不得把它们误认成此刻，也不得为了匹配当前时间而篡改已发生剧情。',
  ].filter(Boolean).join('\n');
}

function buildBeatPrompt({ scene, directive, isColdStart, hasOpening, hasPriorNarration, participantNames, beatIndex, rounds, optionCards, translationSpeakers, lastEncounter, parallelWorld = false, weatherLine = '', timeLabel = '', currentTimeLabel = '', directContinue = false, firstEncounter = false, userPresent = true, phoneMessagesEnabled = true, phoneActionDirectory = null, pendingPhoneReplyInstruction = '', characterStateActors = [], personaNearEndBlock = '', worldBookRecallTail = '', previousCharacterStates = {}, innerVoiceCard = null, previousContinuityState = {}, htmlExtensions = [], voiceInstruction = '', userName = '' }) {
  const sl = sceneLines(scene, { weatherLine, timeLabel });
  const wordMin = scene.wordMin || 200;
  const wordMax = scene.wordMax || 500;
  const trimmedDirective = String(directive || '').trim();
  const audioExperience = isOfflineAudioExperience(scene);
  const openingHint = isColdStart && hasOpening
    ? '用户已经指定了本场开场（见上文【本场开场设定】）。它是本场最新、最高优先的起点：必须按其中安排落地；明确写出的台词或动作视为已经发生，从对方反应与下一拍接续，禁止忽略、改写成无关场景或退回旧聊天。'
    : (isColdStart
      ? '这是本次线下的开场，请用一个具体的入场动作或画面打开场景。'
      : '请自然接续上面已经发生的线下片段，向前推进，不要复述，不要回到初次见面或重新介绍场景。');
  const emptyDirectiveHint = !trimmedDirective && hasPriorNarration
    ? `${userPresent ? '用户' : '旁观者'}本轮未填写方向：请从上文结尾自然续写一小段，严禁跳回开场、改写已发生的事或把剧情重置到刚见面。`
    : '';
  return [
    audioExperience ? '[音声线下 · 旁白与角色对白]' : '[线下推进 · 沉浸叙事]',
    openingHint,
    emptyDirectiveHint,
    parallelWorld
      ? '【平行世界共游】用户与角色分处两个平行世界，永远无法真正见面；这一场不是同处一地的线下，而是「平行共游」：两人约好同一时间去各自世界的同一地点，全程通过手机（消息、语音、照片、视频通话）分享彼此眼前的景象。硬规则：绝不能出现身体接触、同处一室、肉眼看见对方本人、把东西递到对方手上；所有互动都经由手机发生。可以写镜像呼应（用户在自己世界的塔下抬头，角色在另一个世界的同一座塔顶往下看），两个世界的同一地点允许有微妙差异，差异本身是乐趣。见不到面的怅然可以偶尔流露，但基调是各自安好、彼此分享。'
      : '',
    isColdStart && lastEncounter?.summary
      ? '本场开场必须严格承接上文【跨模式连续时间线】的最后状态；上一场线下已结束，线上桥接消息发生在两场线下之间，不得打乱先后顺序。'
      : '',
    isColdStart && directContinue
      ? (hasOpening
        ? '本场从线上聊天「直接进入」，但用户已经指定【本场开场设定】：以开场设定为本场落点，线上末段只用于补足两场之间的语气与因果，不得用旧聊天覆盖或改写开场安排。'
        : (String(scene?.place || '').trim() || String(scene?.goal || '').trim()
          ? `本场从线上聊天「直接进入」线下，并带有用户填写的地点或活动。必须把上面线上聊天末段发生的事当作紧邻前情，自然说明${userPresent ? '双方' : '这些角色'}如何从那段对话来到当前场景；地点与活动是落点，不是另起剧情的理由。`
          : `本场是从线上聊天「直接进入」的线下：没有预设地点与活动。请从上面线上聊天末段的语境自然推断此刻${userPresent ? '双方' : '这些角色'}为什么见面、在哪里见面（顺着聊到的事、约过的地方或最合理的日常场景落地），把线上话题的余温自然带进线下，不要凭空另起一套无关的场景。`))
      : '',
    firstEncounter
      ? '【初遇】这是双方人生中的第一次见面：此前没有聊天记录、没有共同回忆，也互相不知道对方的名字（除非场景设定里写了别的前提）。从陌生人的距离感写起——初次对视、试探性的搭话、自我介绍的时机都要符合初识；不要写出「熟稔感」，不要引用不存在的过往。'
      : '',
    sl ? `场景设定：\n${sl}` : '场景：延续当前氛围自然展开。',
    weatherLine
      ? '天气用上面给出的现实天气作轻背景即可，出门穿着、体感、窗外时可自然带一笔，不要另编一套天气。天气行若标有“现实天气映射数据源”，该现实城市名只能用于理解天气，绝不能当成角色所在地、用户所在地或本场地点写进叙事。'
      : '',
    userPresent
      ? (participantNames.length
        ? `${scene.naturalEnsemble === true ? '本场可出场角色池' : '涉及角色'}（char）：${participantNames.join('、')}；用户固定 id=user，与角色是两个独立的人`
        : '用户固定 id=user；角色只读上下文中的【角色 ·】卡')
      : `${scene.naturalEnsemble === true ? '本场可出场角色池' : '在场角色'}（char）：${participantNames.join('、') || '只读上下文中的角色卡'}；user 不在现场，正文中不得出现用户或为用户预留位置。`,
    scene.naturalEnsemble === true && participantNames.length > 1
      ? [
        '【自然群像 · 非轮询演出】上面的角色池表示这些人可以在本场出现，不是本轮点名册，也不表示所有人此刻必须同时站在镜头里。',
        '每轮只让当前事件真正触动的 1～2 名角色成为主要交互对象；其他角色可以不发言、不写动作、不写表情、不写心理，甚至连续数轮留在暗场。禁止按名单顺序逐个交代近况，禁止为了雨露均沾给每人补一笔反应。',
        '多人开场默认只启动一条关系边：一个具体触发者与一个直接回应者足够完成入场。不得把第一轮写成人物发布会；朋友、秘书、亲属、律师等身份不是自动登台理由。即使所有人确实身处同一地点，也允许大多数人整轮没有镜头。',
        '若提示中启用了思维链，CAST 的 FOCUS 只能有 1～2 人，SUPPORT 至多 1 人，其余必须进入 DARK；RHYTHM 不得再次列出 DARK 人物。正文与隐藏心声都服从这份本轮镜头名单。',
        '主次随剧情变化：上一轮的次要人物可以在新的因果、话题、空间移动或关系触发后自然进入，成为下一轮主角；入场必须有现场原因，不能只为轮换镜头凭空报到。',
        '群像张力来自打断、错位、物理位置、资源流向和谁选择不回应。未被写到的人仍然存在，但沉默不需要旁白证明；不要翻译“他在暗中观察／他没有参与”。',
      ].join('\n')
      : '',
    userPresent
      ? '【身份区分】用户人物设定/用户外观只属于用户档案；角色外观/人设只属于角色卡。禁止把用户外貌、经历、兴趣写成角色自己的，也不要让角色自称是用户。'
      : '【身份区分】不读取、不引用用户人设或外观；多个角色的人设、经历、动作和台词必须分别归给正确角色，禁止串人。',
    userPresent ? offlinePerspectiveText(scene, { userName }) : '视角：全知旁观，以客观第三方镜头描写所有在场角色，可以在不串人的前提下呈现各自心理。',
    userPresent ? personText(scene.person, scene.perspective) : '人称：正文使用角色姓名或明确的第三人称；资料未明确时不猜测性别代词。旁观者不使用“你／我／TA”占位。',
    rounds
      ? (beatIndex < rounds
        ? `节奏：本场参考约 ${rounds} 轮推进，当前第 ${beatIndex + 1} 轮。${paceHint(beatIndex, rounds, { userPresent })}`
        : `节奏：本场已继续到第 ${beatIndex + 1} 轮。${paceHint(beatIndex, rounds, { userPresent })}`)
      : '',
    offlineInputModeRules(scene, participantNames, { userPresent }),
    audioExperience
      ? buildOfflineAudioScriptPrompt({ wordMin, wordMax, hasUserInput: !!trimmedDirective })
      : '',
    trimmedDirective
      ? `本轮有新的${userPresent ? '用户输入' : '旁观导演方向'}；其原文位于本提示最末的【本轮最新方向】，必须以那里作为唯一续写起点。`
      : `${userPresent ? '用户' : '旁观者'}本轮没有输入：按当前节奏自然推进一小段。`,
    buildOfflineSessionGuidanceBlock(scene),
    userPresent ? personContinuityText(scene.perspective, scene.person) : '人称稳定：全文使用角色姓名或明确第三人称，绝不得突然写出一个代表旁观者的“你”或“我”。',
    !userPresent
      ? '【角色之间的新拍点】上文最后一层已经完整发生。本轮只推进一个此前尚未发生的具体拍点，让至少一位角色的动作、台词、环境反馈或即时后果完整落地；所有角色都能自主反应，不得等待屏幕外的人作答。'
      : scene.blockUserSpeech !== false
      ? '【角色侧新拍点】上文最后一层已经完整发生。本轮从它的最终动作、位置和话题继续，只推进一个此前尚未发生的角色侧拍点：角色的新动作、对白、会改变随后言行的心理转折、环境变化或即时后果，围绕当前主要回应完整落地。禁止换词重写上一层、复演用户输入、重复同一动作或情绪结论；不要求凑“有来有回”，更不能为形成对话而补写用户回应。'
      : '本轮必须发生一件具体的事：一个明确的动作、一处可触可感的细节、一段有来有回的对话，或一个推动关系的小转折——让剧情真的往前走，而不是停在气氛和心理铺陈里。',
    !userPresent
      ? '连续演出：按旁观导演方向让在场角色彼此反应，完整演到一个自然的新节点。'
      : scene.directorMode === true && scene.blockUserSpeech === false
      ? '连续演出：按导演指令把这一小段完整演到一个自然的新节点，用户与角色都可以行动，不必强行停在等待用户开口的位置。'
      : responseSpaceInstruction(scene.person),
    !userPresent
      ? '停笔：写完在场角色本轮的动作、对话与即时反应，停在自然形成的新局面；不要让任何人朝屏幕外等待回答。'
      : scene.directorMode === true && scene.blockUserSpeech === false
      ? '收束：停在本轮场景自然形成的新局面，不要为了等待下一条输入而生硬悬停。'
      : naturalEndingInstruction(scene.person),
    audioExperience ? AUDIO_STAGE_SEGMENTATION_HINT : VARIED_SEGMENTATION_HINT,
    !userPresent
      ? '【无 user 硬限制】正文只能出现在场角色及合理的环境/场外人物；禁止添加“用户”、“你”、“我们”等隐形参与者，禁止让角色向旁观者说话。'
      : scene.blockUserSpeech !== false
      ? blockUserSpeechRules(scene.person, { userName })
      : (scene.directorMode === true
        ? '导演模式允许连续扮演用户与角色双方；用户侧扩写必须服从本轮指导和既有人设，不得凭空作出重大决定。'
        : '可以自然描写用户侧已经明确发生的动作与即时反应，但不要擅自替用户作出重大选择。'),
    scene.placeMaterial ? `地点/攻略素材（真实检索结果，节点描写可借用其中具体细节如地名、特点，不要逐字照抄，也不要编造它没提到的信息）：\n${scene.placeMaterial}` : '',
    translationInstruction(translationSpeakers),
    voiceInstruction,
    phoneMessagesEnabled || parallelWorld
      ? offlinePhoneActionsInstruction(phoneActionDirectory)
      : '【本场手机消息已关闭】本轮禁止任何角色新发送、收到、查看或提起微信、短信、私信等手机消息；不要用来电、通知或场外联系人打断当前主线。只推进现场人物之间已经在进行的情节。',
    phoneMessagesEnabled ? pendingPhoneReplyInstruction : '',
    offlineContinuityStateInstruction(
      previousContinuityState,
      characterStateActors.map((actor) => actor.id),
      { beatNumber: beatIndex + 1, naturalEnsemble: scene.naturalEnsemble === true },
    ),
    scene.perBeatDigestEnabled === true
      ? offlineBeatDigestInstruction({ beatNumber: beatIndex + 1 })
      : '',
    optionCards ? advanceOptionsInstruction(3, {
      dialogue: scene.audioSceneEnabled === true,
      finalBlock: true,
    }) : '',
    (scene.autoImagePerBeat
      || scene.audioSceneEnabled === true
      || !!normalizeOfflineSceneImageGenMode(scene.imageGenMode))
      ? sceneImageDirectiveInstruction({
        styleId: scene.imageStyleId,
        anchor: scene.imagePromptTemplate,
        imageGenMode: scene.imageGenMode,
        includeUser: userPresent,
        availableSubjects: [
          ...(userPresent ? [{ id: 'user', name: userName || '用户' }] : []),
          ...characterStateActors.map((actor) => ({ id: actor.id, name: actor.name })),
        ],
      })
      : '',
    buildHtmlExtensionPromptBlock(htmlExtensions, { surface: 'offline' }),
    personaNearEndBlock,
    worldBookRecallTail,
    buildOfflineCurrentTimeAnchor(currentTimeLabel, timeLabel),
    buildOfflineCurrentDirectiveTail(trimmedDirective, { userPresent }),
    buildOfflineAntiInterruptionTail(scene, { userPresent, userName }),
    audioExperience ? '' : offlineNarrationLengthInstruction(wordMin, wordMax),
    // 心声完整性协议必须位于整份业务提示的最后。Claude 等长上下文模型若在它
    // 后面继续看到其它尾部任务，容易把未进入正文焦点的后几名角色误判成可省略。
    scene.innerVoiceEnabled === true
      ? offlineCharacterStatesInstruction(characterStateActors, previousCharacterStates, {
        generationMode: innerVoiceCard?.generationMode,
        generationPrompt: innerVoiceCard?.generationPrompt,
        userName,
        userPresent,
        naturalEnsemble: scene.naturalEnsemble === true,
      })
      : '',
  ].filter(Boolean).join('\n');
}

/** 流式显示用：截掉走向选项块和场景生图指令块，只留正文（无论哪个先出现都截得住）。 */
function stripGenerationTail(text = '') {
  const t = stripLeakedOfflineContinuityTail(stripOfflinePhoneActionTail(String(text || '')));
  const cuts = [
    t.indexOf(OPTIONS_START),
    t.indexOf(SCENE_IMAGE_DIRECTIVE_START),
    t.indexOf(OFFLINE_CHARACTER_STATES_START),
    t.indexOf(OFFLINE_CONTINUITY_STATE_START),
    t.indexOf(OFFLINE_BEAT_DIGEST_START),
    t.indexOf(OFFLINE_HTML_EXTENSIONS_START),
    t.indexOf(NARRATIVE_VOICE_LINES_START),
  ].filter((i) => i !== -1);
  return cuts.length ? t.slice(0, Math.min(...cuts)) : t;
}

const OFFLINE_SOUND_LABEL_TERMS = new Set([
  '亲吻', '亲吻声', '接吻声', '布料摩擦', '平缓呼吸', '较重呼吸', '呼吸声',
  '身体动作', '亲密接触', '身体碰撞', '脚步', '脚步声', '门', '门锁', '门铃',
  '敲门声', '湿润', '液体声', '水声', '浴室', '雨声', '场景氛围', '环境音',
  '风声', '海浪声', '鸟鸣', '虫鸣', '雷声', '笑声', '哭声', '掌声', '喘息声',
  '咳嗽声', '键盘声', '拍击声', '衣料声', '背景音', '背景音乐', 'bgm',
  '浪漫暧昧', '平静陪伴', '夜晚低落', '克制紧张',
]);

function isOfflineSoundLabel(value = '') {
  const normalized = String(value || '')
    .trim()
    .replace(/^(?:音效|环境音|背景音|sfx)\s*[：:]?\s*/iu, '')
    .replace(/[（(](?:持续|循环|渐近|渐远|渐强|渐弱|淡入|淡出)[）)]$/u, '')
    .replace(/(?:持续|循环|渐近|渐远|渐强|渐弱|渐起|停止|淡入|淡出)$/u, '')
    .toLowerCase();
  if (!normalized) return false;
  const terms = normalized
    .split(/\s*(?:[\/／·+、]|\s+or\s+)\s*/iu)
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.length > 0 && terms.every((term) => OFFLINE_SOUND_LABEL_TERMS.has(term));
}

/** 只清除模型泄露的已知音效舞台标签，保留普通书名号、地点标题和正文。 */
export function stripOfflineNarrationSoundLabels(raw = '') {
  return String(raw || '')
    .replace(/[【\[]([^】\]\n]{1,40})[】\]]/gu, (whole, label) => (
      isOfflineSoundLabel(label) ? '' : whole
    ))
    .replace(/(^|\n)[ \t]*[（(]([^）)\n]{1,40})[）)][ \t]*(?=\n|$)/gu, (whole, prefix, label) => (
      isOfflineSoundLabel(label) ? prefix : whole
    ))
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function cleanNarration(raw) {
  return stripOfflineNarrationSoundLabels(stripLeakedOfflineContinuityTail(sanitizeNarrationOutput(raw)));
}

/** 流式阶段不展示或暂存审稿注释中的 DRAFT，最终只让 Print 正文进入楼层。 */
export function cleanOfflineStreamingNarration(raw = '') {
  let visible = String(raw || '').replace(
    /<!--\s*editorial-audit\s*:\s*[\s\S]*?-->/gi,
    '\n',
  );
  const unfinishedAudit = visible.search(/<!--\s*editorial-audit\b/i);
  if (unfinishedAudit >= 0) visible = visible.slice(0, unfinishedAudit);
  return cleanNarration(stripGenerationTail(visible));
}

function cloneRevisionValue(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function revisionBeatSnapshot(beat = {}) {
  return cloneRevisionValue({
    ...beat,
    text: String(beat.text || ''),
    options: Array.isArray(beat.options) ? beat.options : [],
  });
}

function lastRevisableNarration(session = {}) {
  const beats = Array.isArray(session.beats) ? session.beats : [];
  const index = beats.length - 1;
  const beat = beats[index];
  if (!beat || beat.role !== 'narration') return null;
  const directiveBeat = beats[index - 1]?.role === 'directive' ? beats[index - 1] : null;
  const narrationNumber = beats.slice(0, index + 1).filter((row) => row?.role === 'narration').length;
  return { beat, index, directiveBeat, narrationNumber };
}

/**
 * 重写请求只读取目标层之前的已采用时间线。候选库、重修历史以及覆盖到目标层的
 * checkpoint / rollup 都是派生缓存，不允许成为旧稿回灌旁路。
 */
export function buildOfflineRevisionGenerationSession(session = {}, target = null) {
  const resolvedTarget = target || lastRevisableNarration(session);
  if (!resolvedTarget) return session;
  const narrationNumber = Math.max(1, Number(resolvedTarget.narrationNumber || 1));
  const checkpointSummaries = (Array.isArray(session.checkpointSummaries)
    ? session.checkpointSummaries
    : []).filter((checkpoint) => Number(checkpoint?.uptoBeatIndex || 0) < narrationNumber);
  const safeRollup = Number(session.checkpointRollup?.uptoBeatIndex || 0) < narrationNumber
    ? cloneRevisionValue(session.checkpointRollup || null)
    : null;
  const {
    revisions: _revisions,
    rerollVersions: _rerollVersions,
    inFlight: _inFlight,
    checkpointRollup: _checkpointRollup,
    ...base
  } = session;
  return {
    ...base,
    continuityState: undefined,
    checkpointSummaries: cloneRevisionValue(checkpointSummaries),
    ...(safeRollup ? { checkpointRollup: safeRollup } : {}),
    beats: (Array.isArray(session.beats) ? session.beats : [])
      .slice(0, resolvedTarget.directiveBeat ? resolvedTarget.index - 1 : resolvedTarget.index),
  };
}

export function canReviseLastOfflineBeat(session = {}, beatId = '') {
  const target = lastRevisableNarration(session);
  if (!target) return false;
  const id = String(beatId || '').trim();
  return !id || String(target.beat.id || '') === id;
}

function revisionProtocolOutputInstruction(options = {}) {
  const protocols = [];
  if (options.includeCharacterStates === true) {
    protocols.push(`按既定格式保留 ${OFFLINE_CHARACTER_STATES_START} 心声块`);
  }
  if (options.includePhoneActions === true) {
    protocols.push(`正文确实发生手机发送、发布或代答时，按既定格式保留 ${OFFLINE_PHONE_ACTIONS_START} 动作块`);
  }
  if (!protocols.length) return '只输出完整的新叙事正文。';
  return `先输出完整的新叙事正文，再${protocols.join('；')}。除正文和这些已启用协议外，不输出解释。`;
}

export function revisionNeedsPhoneActionProtocol(revision = null) {
  const requirement = String(revision?.requirement || '').trim();
  const originalText = String(revision?.originalText || '').trim();
  if (!requirement || !originalText) return false;
  if (/(删掉|删除|取消|不要再?发|不再发|并未发送|没有发送)/.test(requirement)) return false;
  const asksProtocolRepair = /(格式|协议|真实.{0,6}(?:发|发送|落地)|真的.{0,6}(?:发|发送)|落到.{0,6}(?:聊天|消息)|只.{0,8}(?:正文|文本)|没有.{0,8}(?:真的|真实).{0,6}(?:发|发送))/.test(requirement);
  const originalHasPhoneSend = /(?:发(?:了|出|送)?|发送|按下.{0,4}发送).{0,18}(?:消息|信息|短信|私信)|(?:消息|信息|短信|私信).{0,12}(?:发(?:了|出|送)?|发送)/.test(originalText);
  return asksProtocolRepair && originalHasPhoneSend;
}

export function revisionPromptInstruction(revision = null, options = {}) {
  if (!revision) return '';
  if (revision.supplementalAudit === true) {
    const hits = collectNarrationSupplementalAuditHits(revision.originalText);
    const hitList = hits.length
      ? hits.map((hit, index) => `${index + 1}. 命中：『${hit.value}』｜类型：${hit.type}｜改法：${hit.guidance}`).join('\n')
      : '本地硬扫描未命中固定结构；仍须逐句检查旁白解释、动作免责声明、人物空洞与段落砖块。';
    return [
      '【补审重写 · 硬约束】',
      '当前版本已经生成，但上一轮编辑审稿发生漏检。把下面旧稿视为待审文本，从同一时间点重写；保持已发生上文与用户方向，不把旧稿内部新增的可疑细节自动当成既定事实。',
      `旧稿（未采用）：\n${revision.originalText}`,
      `本地逐字预扫描：\n${hitList}`,
      '预扫描只是最低命中表，不是完整审稿。必须覆盖表中每一项，并继续逐句检查：不是/没有式负向垫句、缺席动作、旁白免责声明、语气目光翻译、无用途陈设、虚假精确、连续等长大段与重复段落骨架。角色对白里的真实否定不误删。',
      '新稿必须自然长短错落：对白、顿点和信息揭晓可以独立成短段；连续动作保持在中段；不得把整轮压成一个大段，也不得切成电报碎句。',
      '在 content 中先用 <!-- editorial-audit: DRAFT: … AUDIT: … --> 保存对旧稿的真实审查，再输出完整新正文。AUDIT 必须逐字引用实际命中，不准写优点评价或用 PASS 跳过预扫描项目。',
      revisionProtocolOutputInstruction(options),
    ].join('\n\n');
  }
  if (revision.independentReroll === true) {
    const samplingNonce = String(revision.samplingNonce || '').trim().slice(0, 80);
    const variationAxes = [
      '避开最惯常的动作接龙，改由另一名角色、环境变化或新信息发起本轮核心事件。',
      '优先更换对白目的与潜台词，让人物用不同策略推进，而不是只替换同义句。',
      '更换开场切入点、信息揭晓顺序与段落节奏，避免沿着最显然的情节骨架落笔。',
      '让一个此前已存在但未被聚焦的物件、约定或现场细节成为推进支点。',
      '改变本轮的主动方、动作因果和收束落点，同时保持此前事实与人物边界不变。',
      '从新的感官焦点或现场扰动切入，并让它真正改变动作链和对白组织。',
    ];
    let nonceHash = 0;
    for (const char of samplingNonce) nonceHash = ((nonceHash * 31) + char.charCodeAt(0)) >>> 0;
    const variationAxis = variationAxes[nonceHash % variationAxes.length];
    return [
      '【本轮重 roll · 独立重采样】',
      '从已经发生的上文与本轮原始用户方向重新生成一个同一时间点的替代版本。这不是修改旧稿；未采用版本不在上下文中，也不要猜测或复原它。',
      '保持此前既定事实、当前时刻、场所、人物位置与用户输入不变；重新选择本轮的核心落点、注意顺序、动作链和对白组织。除非上文或用户方向明确要求，不要把“替代版本”理解成必须重复同一套进门、带路、拿水、换衣等情节骨架。',
      variationAxis,
      samplingNonce ? `内部独立采样标记：${samplingNonce}。它没有剧情含义，不要在正文中输出或解释；只用于让本次请求避开相同采样轨道。` : '',
      `用户本次要求：${revision.requirement}`,
      revisionProtocolOutputInstruction(options),
    ].filter(Boolean).join('\n');
  }
  return [
    '【指导重修 · 硬约束】',
    '下面的上一版是未采用的错误示例，只用于识别问题，绝不是已经发生的剧情。不要承接、复述、仿写或保留其中造成问题的表达。',
    `上一版（未采用）：\n${revision.originalText}`,
    `用户本次要求：${revision.requirement}`,
    '必须把用户要求当作本轮最高优先级硬约束；重写为同一时间点的替代版本，并明确避免沿用上一版的相同问题。',
    options.includePhoneActions === true
      ? '若用户指出的是“手机动作只写在正文、没有真实落地”等格式或协议问题，必须保留该动作的剧情语义，并把它改写成已启用的真实手机动作协议；不得通过删除发消息、发布或代答情节来逃避格式修复。'
      : '',
    revisionProtocolOutputInstruction(options),
  ].join('\n');
}

function continuationPromptInstruction(continuation = null, options = {}) {
  if (!continuation) return '';
  return [
    '【从断点续写 · 硬约束】',
    '上一层因为接口中断，只保存了已经收到的前半段。前半段已经展示给用户，是已经发生的正文。',
    `已保存到断点的正文：\n${continuation.originalText}`,
    '只输出紧接断点之后的新内容。禁止复述、概括、换词重写或从本段开头重新开始；第一句必须直接接住最后一个未完成的动作、台词或句子。',
    options.includeCharacterStates === true
      ? `把这一层自然写完后，再按既定格式输出 ${OFFLINE_CHARACTER_STATES_START} 心声块。`
      : '把这一层自然写完，不要开启下一轮。',
  ].join('\n');
}

export function applyLastOfflineContinuation(session = {}, {
  beatId = '',
  continuationBeat = null,
  pending = false,
  reason = '',
} = {}) {
  const target = lastRevisableNarration(session);
  if (!target || String(target.beat.id || '') !== String(beatId || '') || !String(continuationBeat?.text || '').trim()) {
    return { ok: false, reason: 'invalid_target' };
  }
  const originalBeat = revisionBeatSnapshot(target.beat);
  const mergedVoiceLines = [
    ...(Array.isArray(originalBeat.voiceLines) ? originalBeat.voiceLines : []),
    ...(Array.isArray(continuationBeat.voiceLines) ? continuationBeat.voiceLines : []),
  ];
  const mergedHtmlWidgets = [
    ...(Array.isArray(originalBeat.htmlWidgets) ? originalBeat.htmlWidgets : []),
    ...(Array.isArray(continuationBeat.htmlWidgets) ? continuationBeat.htmlWidgets : []),
  ];
  const mergedEditorialAudits = [
    ...(Array.isArray(originalBeat.editorialAudits) ? originalBeat.editorialAudits : []),
    ...(Array.isArray(continuationBeat.editorialAudits) ? continuationBeat.editorialAudits : []),
  ];
  const mergedDigest = mergeOfflineBeatDigests(originalBeat.digest, continuationBeat.digest);
  const combined = revisionBeatSnapshot({
    ...originalBeat,
    ...continuationBeat,
    id: originalBeat.id,
    role: 'narration',
    ts: originalBeat.ts || continuationBeat.ts,
    text: joinOfflineContinuationText(originalBeat.text, continuationBeat.text),
    characterStates: {
      ...(originalBeat.characterStates || {}),
      ...(continuationBeat.characterStates || {}),
    },
    continuityPatch: mergeOfflineContinuityPatches(
      originalBeat.continuityPatch,
      continuationBeat.continuityPatch,
    ),
    ...(mergedVoiceLines.length ? { voiceLines: mergedVoiceLines } : {}),
    ...(mergedHtmlWidgets.length ? { htmlWidgets: mergedHtmlWidgets } : {}),
    ...(mergedEditorialAudits.length ? { editorialAudits: mergedEditorialAudits } : {}),
    ...(mergedDigest ? { digest: mergedDigest, digestStatus: continuationBeat.digestStatus || originalBeat.digestStatus || 'complete' } : {}),
    stageSound: {
      background: [
        ...(originalBeat.stageSound?.background || []),
        ...(continuationBeat.stageSound?.background || []),
      ],
      cues: [
        ...(originalBeat.stageSound?.cues || []),
        ...(continuationBeat.stageSound?.cues || []),
      ],
    },
    continuationPending: pending === true,
    continuationReason: pending === true ? String(reason || 'length').trim() : '',
    continuedAt: Date.now(),
  });
  if (!combined.continuationPending) {
    delete combined.continuationReason;
    delete combined.recoveredFromInFlight;
  }
  session.beats.splice(target.index, 1, combined);
  rebuildOfflineContinuityState(session);
  session.checkpointSummaries = (session.checkpointSummaries || [])
    .filter((checkpoint) => Number(checkpoint?.uptoBeatIndex || 0) < target.narrationNumber);
  if (Number(session.checkpointRollup?.uptoBeatIndex || 0) >= target.narrationNumber) {
    session.checkpointRollup = null;
  }
  return { ok: true, beat: combined, targetIndex: target.index, originalBeat };
}

function appendOfflineRevision(session, entry) {
  session.revisions = [...(Array.isArray(session.revisions) ? session.revisions : []), entry].slice(-40);
  return entry;
}

export const OFFLINE_REROLL_VERSION_MAX_COUNT = 5;
const OFFLINE_REROLL_VERSION_SET_MAX_COUNT = 20;

function offlineRerollVersionStore(session = {}) {
  if (!session.rerollVersions || typeof session.rerollVersions !== 'object' || Array.isArray(session.rerollVersions)) {
    session.rerollVersions = {};
  }
  return session.rerollVersions;
}

function offlineBeatHasExternalActions(beat = {}) {
  return !!(
    (Array.isArray(beat?.phoneActions) && beat.phoneActions.length)
    || (Array.isArray(beat?.phoneActionOutbox) && beat.phoneActionOutbox.length)
    || (Array.isArray(beat?.socialPostActions) && beat.socialPostActions.length)
    || (Array.isArray(beat?.socialPostOutbox) && beat.socialPostOutbox.length)
  );
}

function offlineRerollVersionEntry(beat, checkpoints, {
  id = '',
  label = '',
  createdAt = Date.now(),
  checkpointRollup = null,
} = {}) {
  return {
    id: String(id || genId()),
    label: String(label || '').trim().slice(0, 40) || '候选版本',
    createdAt: Number(createdAt || Date.now()),
    beat: revisionBeatSnapshot(beat),
    checkpointSummaries: cloneRevisionValue(checkpoints || []),
    checkpointRollup: cloneRevisionValue(checkpointRollup || null),
  };
}

function pruneOfflineRerollVersionSets(session = {}) {
  const store = offlineRerollVersionStore(session);
  const kept = Object.entries(store)
    .filter(([, set]) => set?.beatId && Array.isArray(set.versions) && set.versions.length)
    .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
    .slice(0, OFFLINE_REROLL_VERSION_SET_MAX_COUNT);
  session.rerollVersions = Object.fromEntries(kept);
  return session.rerollVersions;
}

/** 为当前末层登记一个隔离候选；候选本身绝不携带真实手机或社交动作。 */
export function recordOfflineRerollVersion(session = {}, beat = null, {
  checkpoints = null,
  checkpointRollup = undefined,
  label = '',
  makeActive = true,
} = {}) {
  if (!beat?.id || beat.role !== 'narration') return { ok: false, reason: 'invalid_beat' };
  if (offlineBeatHasExternalActions(beat)) return { ok: false, reason: 'external_actions' };
  const store = offlineRerollVersionStore(session);
  const beatId = String(beat.id);
  const previous = store[beatId] && typeof store[beatId] === 'object' ? store[beatId] : {};
  const versions = Array.isArray(previous.versions) ? previous.versions.slice() : [];
  const entry = offlineRerollVersionEntry(
    beat,
    checkpoints ?? session.checkpointSummaries ?? [],
    {
      label: label || `版本 ${versions.length + 1}`,
      checkpointRollup: checkpointRollup === undefined
        ? session.checkpointRollup
        : checkpointRollup,
    },
  );
  versions.push(entry);
  const retained = versions.slice(-OFFLINE_REROLL_VERSION_MAX_COUNT);
  store[beatId] = {
    beatId,
    activeVersionId: makeActive ? entry.id : (previous.activeVersionId || retained[0]?.id || ''),
    versions: retained,
    updatedAt: Date.now(),
  };
  pruneOfflineRerollVersionSets(session);
  return { ok: true, entry, set: session.rerollVersions[beatId] };
}

/** 媒体、心声或摘要在生成尾声补齐后，同步刷新当前候选快照。 */
export function syncActiveOfflineRerollVersion(session = {}, beatId = '') {
  const id = String(beatId || '').trim();
  const set = offlineRerollVersionStore(session)[id];
  const beat = (session.beats || []).find((row) => row?.id === id && row.role === 'narration');
  if (!set || !beat || offlineBeatHasExternalActions(beat)) return { ok: false, reason: 'not_syncable' };
  const index = (set.versions || []).findIndex((row) => row?.id === set.activeVersionId);
  if (index < 0) return { ok: false, reason: 'version_not_found' };
  set.versions[index] = {
    ...set.versions[index],
    beat: revisionBeatSnapshot(beat),
    checkpointSummaries: cloneRevisionValue(session.checkpointSummaries || []),
    checkpointRollup: cloneRevisionValue(session.checkpointRollup || null),
  };
  set.updatedAt = Date.now();
  return { ok: true, entry: set.versions[index] };
}

export function listOfflineRerollVersions(session = {}, beatId = '') {
  const id = String(beatId || '').trim();
  const set = offlineRerollVersionStore(session)[id];
  if (!set) return { beatId: id, activeVersionId: '', versions: [] };
  return {
    beatId: id,
    activeVersionId: String(set.activeVersionId || ''),
    versions: cloneRevisionValue(set.versions || []),
  };
}

/** 只允许切换当前最后一层，避免后续正文继续引用另一候选形成隐式串线。 */
export function selectOfflineRerollVersion(session = {}, beatId = '', versionId = '') {
  const target = lastRevisableNarration(session);
  const id = String(beatId || '').trim();
  if (!target || String(target.beat?.id || '') !== id) return { ok: false, reason: 'not_last_narration' };
  if (offlineBeatHasExternalActions(target.beat)) return { ok: false, reason: 'external_actions' };
  const set = offlineRerollVersionStore(session)[id];
  const version = (set?.versions || []).find((row) => row?.id === String(versionId || ''));
  if (!version?.beat || offlineBeatHasExternalActions(version.beat)) return { ok: false, reason: 'version_not_found' };
  session.beats.splice(target.index, 1, revisionBeatSnapshot(version.beat));
  rebuildOfflineContinuityState(session);
  session.checkpointSummaries = cloneRevisionValue(version.checkpointSummaries || []);
  session.checkpointRollup = cloneRevisionValue(version.checkpointRollup || null);
  set.activeVersionId = version.id;
  set.updatedAt = Date.now();
  session.updatedAt = Date.now();
  return { ok: true, beat: session.beats[target.index], version: cloneRevisionValue(version) };
}

/** 原子应用已生成的新稿；调用方只应在正文完整生成后调用。 */
export function applyLastOfflineRevision(session = {}, {
  beatId = '',
  newBeat = null,
  requirement = '',
  ts = Date.now(),
} = {}) {
  const target = lastRevisableNarration(session);
  if (!target || String(target.beat.id || '') !== String(beatId || '') || !String(newBeat?.text || '').trim()) {
    return { ok: false, reason: 'invalid_target' };
  }
  const originalBeat = revisionBeatSnapshot(target.beat);
  const checkpointsBefore = cloneRevisionValue(session.checkpointSummaries || []);
  const checkpointRollupBefore = cloneRevisionValue(session.checkpointRollup || null);
  const retainVersions = session.scene?.retainRerollVersions === true;
  if (retainVersions && offlineBeatHasExternalActions(originalBeat)) {
    return { ok: false, reason: 'external_actions' };
  }
  if (retainVersions && !offlineRerollVersionStore(session)[originalBeat.id]?.versions?.length) {
    recordOfflineRerollVersion(session, originalBeat, {
      checkpoints: checkpointsBefore,
      checkpointRollup: checkpointRollupBefore,
      label: '初始版本',
      makeActive: true,
    });
  }
  const fromVersion = Math.max(1, Number(originalBeat.revisionVersion || 1));
  const appliedBeat = revisionBeatSnapshot({
    ...newBeat,
    id: originalBeat.id,
    role: 'narration',
    ts: originalBeat.ts || newBeat.ts,
    revisionVersion: fromVersion + 1,
    revisedAt: ts,
  });
  session.beats.splice(target.index, 1, appliedBeat);
  rebuildOfflineContinuityState(session);
  session.checkpointSummaries = (session.checkpointSummaries || [])
    .filter((checkpoint) => Number(checkpoint?.uptoBeatIndex || 0) < target.narrationNumber);
  if (Number(session.checkpointRollup?.uptoBeatIndex || 0) >= target.narrationNumber) {
    session.checkpointRollup = null;
  }
  const entry = appendOfflineRevision(session, {
    id: genId(),
    type: 'revision',
    beatId: appliedBeat.id,
    fromVersion,
    toVersion: appliedBeat.revisionVersion,
    requirement: String(requirement || '').trim(),
    originalText: originalBeat.text,
    newText: appliedBeat.text,
    originalBeat,
    newBeat: revisionBeatSnapshot(appliedBeat),
    checkpointSummariesBefore: checkpointsBefore,
    checkpointRollupBefore,
    checkpointSummariesAfter: [],
    ts,
  });
  if (retainVersions) {
    recordOfflineRerollVersion(session, appliedBeat, {
      checkpoints: session.checkpointSummaries,
      makeActive: true,
    });
  }
  return {
    ok: true,
    beat: appliedBeat,
    revision: entry,
    targetIndex: target.index,
    checkpointsBefore,
    checkpointRollupBefore,
    originalBeat,
  };
}

/**
 * 恢复某次重修前的末层版本。只允许当前最后一条 narration，避免误改中间楼层。
 * checkpoint 使用该次重修前的快照恢复，确保摘要与正文来自同一版本。
 */
export function restoreLastOfflineRevision(session = {}, revisionId = '') {
  const target = lastRevisableNarration(session);
  if (!target) return { ok: false, reason: 'not_last_narration' };
  const rows = (Array.isArray(session.revisions) ? session.revisions : [])
    .filter((row) => row?.beatId === target.beat.id && row?.originalBeat);
  const selected = revisionId
    ? rows.find((row) => row.id === revisionId)
    : rows[rows.length - 1];
  if (!selected) return { ok: false, reason: 'not_found' };

  const currentBeat = revisionBeatSnapshot(target.beat);
  const currentCheckpoints = cloneRevisionValue(session.checkpointSummaries || []);
  const currentCheckpointRollup = cloneRevisionValue(session.checkpointRollup || null);
  const restoredBeat = revisionBeatSnapshot(selected.originalBeat);
  const fromVersion = Math.max(1, Number(target.beat.revisionVersion || selected.toVersion || 1));
  const toVersion = fromVersion + 1;
  restoredBeat.id = target.beat.id;
  restoredBeat.role = 'narration';
  restoredBeat.revisionVersion = toVersion;
  restoredBeat.revisedAt = Date.now();
  session.beats.splice(target.index, 1, restoredBeat);
  rebuildOfflineContinuityState(session);
  session.checkpointSummaries = cloneRevisionValue(selected.checkpointSummariesBefore || []);
  session.checkpointRollup = cloneRevisionValue(selected.checkpointRollupBefore || null);
  const entry = appendOfflineRevision(session, {
    id: genId(),
    type: 'restore',
    beatId: target.beat.id,
    fromVersion,
    toVersion,
    requirement: '恢复上一版',
    originalText: currentBeat.text,
    newText: restoredBeat.text,
    originalBeat: currentBeat,
    newBeat: revisionBeatSnapshot(restoredBeat),
    checkpointSummariesBefore: currentCheckpoints,
    checkpointRollupBefore: currentCheckpointRollup,
    checkpointSummariesAfter: cloneRevisionValue(session.checkpointSummaries || []),
    restoredFromRevisionId: selected.id,
    ts: Date.now(),
  });
  return { ok: true, beat: restoredBeat, revision: entry };
}

/**
 * 手动编辑当前活动路线中的文本后，清掉所有覆盖该位置的旧 checkpoint 与派生状态。
 * 否则页面虽然显示新文本，下一轮仍可能从旧分段摘要/连续状态继续，造成“AI 不读编辑”。
 */
export function editOfflineBeatText(session = {}, beatId = '', text = '') {
  const id = String(beatId || '').trim();
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  const targetIndex = beats.findIndex((beat) => String(beat?.id || '') === id);
  if (targetIndex < 0) return { ok: false, reason: 'beat_not_found' };
  const target = beats[targetIndex];
  if (!['narration', 'opening', 'directive'].includes(String(target?.role || ''))) {
    return { ok: false, reason: 'unsupported_role' };
  }
  const nextText = String(text || '').trim();
  if (target.role !== 'directive' && !nextText) return { ok: false, reason: 'empty_text' };

  let narrationBefore = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    if (beats[index]?.role === 'narration') narrationBefore += 1;
  }
  const invalidateFromNarration = target.role === 'narration'
    ? narrationBefore + 1
    : Math.max(1, narrationBefore + 1);

  target.text = nextText;
  // 人工编辑后的正文已不再对应当时的模型原稿与审查，不能继续挂着旧审稿轨迹。
  delete target.editorialAudits;
  target.editedAt = Date.now();
  target.revisionVersion = Math.max(1, Number(target.revisionVersion || 1)) + 1;
  if (target.role === 'opening' && session.scene) session.scene.openingLine = nextText;

  session.checkpointSummaries = (Array.isArray(session.checkpointSummaries)
    ? session.checkpointSummaries
    : []).filter((checkpoint) =>
    Number(checkpoint?.uptoBeatIndex || 0) < invalidateFromNarration);
  if (Number(session.checkpointRollup?.uptoBeatIndex || 0) >= invalidateFromNarration) {
    session.checkpointRollup = null;
  }
  for (let index = targetIndex; index < beats.length; index += 1) {
    if (beats[index]?.role !== 'narration') continue;
    delete beats[index].continuityState;
    delete beats[index].continuityPatch;
    delete beats[index].digest;
    delete beats[index].digestStatus;
    // 心声也是当前楼层已经展示给用户的内容。编辑叙事正文时保留本楼层心声，
    // 只清理后续楼层中会影响下一轮生成的旧角色状态。
    if (index > targetIndex || target.role !== 'narration') {
      delete beats[index].characterStates;
    }
  }
  // 旧重修快照携带编辑前的 checkpoint；手动编辑建立新基线后不再允许恢复旧派生摘要。
  session.revisions = [];
  session.rerollVersions = {};
  rebuildOfflineContinuityState(session);
  session.updatedAt = Date.now();
  return { ok: true, beat: target, invalidateFromNarration };
}

/** 「一起旅行」子模式：推进到下一天，插入一条纯展示的日期分隔 beat（不进 AI 上下文），供多天节奏使用。 */
export async function advanceOfflineSceneDay(session) {
  if (!session?.scene) return session;
  const maxDay = Math.max(0, Number(session.scene.durationDays || 1) - 1);
  const nextDay = Math.min(maxDay, Number(session.scene.dayIndex || 0) + 1);
  if (nextDay === Number(session.scene.dayIndex || 0)) return session;
  session.scene.dayIndex = nextDay;
  const dayPlan = session.scene.itinerary?.days?.[nextDay];
  const dayLabel = dayPlan?.title ? `第 ${nextDay + 1} 天 · ${dayPlan.title}` : `第 ${nextDay + 1} 天`;
  const worldNow = await getNowForUser(session.userId).catch(() => Date.now());
  session.beats.push({ id: genId(), role: 'daymark', text: dayLabel, ts: worldNow });
  await saveOfflineSession(session);
  return session;
}

/**
 * 用户当前进行中的线下（可排除某个 chat）：邀约撞车检测等用。
 * 多场并存时取最近更新的那场。
 */
export async function listActiveOfflineSessionsForUser(userId, { excludeChatId = '' } = {}) {
  const chats = await listChatsForUser(userId).catch(() => []);
  const active = [];
  for (const chat of chats) {
    if (!chat?.id || chat.id === excludeChatId) continue;
    if (!(chat.participants || []).some((id) => id && id !== 'user')) continue;
    const session = await loadOfflineSession(chat.id).catch(() => null);
    if (session?.status !== 'active') continue;
    active.push({ session, chat });
  }
  return active.sort((left, right) => (
    Number(right.session?.updatedAt || right.session?.createdAt || 0)
    - Number(left.session?.updatedAt || left.session?.createdAt || 0)
  ));
}

export async function findActiveOfflineSessionForUser(userId, options = {}) {
  const active = await listActiveOfflineSessionsForUser(userId, options);
  return active[0] || null;
}

/**
 * 「掏出手机」插曲：记录用户离开线下页、进入 Chat 的时间点。
 * targetChatId 仅保留给旧入口兼容；新入口不预选聊天，回程按实际产生的消息扫描。
 */
export async function beginPhoneSideTrip(session, targetChatId = '') {
  if (!session) return session;
  const worldTs = await getNowForUser(session.userId).catch(() => Date.now());
  session.phoneSideTrip = {
    chatId: String(targetChatId || '').trim(),
    startedAt: Date.now(),
    worldTs,
  };
  await saveOfflineSession(session);
  // 回到线下页时必须重新 render 才能折叠插曲，不能命中 keepAlive 缓存
  invalidateKeepAlive('offline', { chatId: session.chatId });
  return session;
}

function interludeLineForMessage(msg, nameOf) {
  const sender = msg.senderId === 'user' ? '你' : (nameOf(msg.senderId) || msg.senderName || 'TA');
  const type = String(msg.type || 'text');
  const body = String(msg.content || '').replace(/\s+/g, ' ').trim();
  if (type === 'text' && body) return `${sender}：${body.slice(0, 120)}`;
  if (type === 'image') return `${sender}：[发了张图]`;
  if (type === 'sticker') return `${sender}：[表情]`;
  if (type === 'voice') return `${sender}：[语音]`;
  if (body) return `${sender}：${body.slice(0, 120)}`;
  return '';
}

function clipOfflineBridgeText(value = '', limit = 1200) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.45);
  return `${text.slice(0, head)}…（消息中段略）…${text.slice(-(limit - head))}`;
}

function offlineBridgeLineForMessage(message = {}, characters = {}) {
  const senderName = (id) => (
    id === 'user'
      ? '你'
      : getCharacterAiContextName(characters?.[id], id)
  );
  const body = formatMessageForContext(message, '你', {
    characters,
    resolveSenderLabel: senderName,
  });
  if (!body) return '';
  const hasEmbeddedSender = /^\[[^\]]+\]:/.test(body);
  const sender = senderName(message.senderId) || message.senderName || 'TA';
  return hasEmbeddedSender
    ? clipOfflineBridgeText(body)
    : `${sender}：${clipOfflineBridgeText(body)}`;
}

/**
 * 用户从「掏出手机」插曲回到线下页：把期间那个聊天里的往来折成一条 interlude beat，
 * 让线下现场的后续推进知道刚才手机上发生了什么。没聊出内容就静默清掉标记。
 */
export async function resolvePhoneSideTripInterlude(session) {
  const trip = session?.phoneSideTrip;
  if (!trip || (!trip.startedAt && !trip.worldTs)) return { session, added: false };
  delete session.phoneSideTrip;
  try {
    const since = Number(trip.worldTs || trip.startedAt || 0) - 60 * 1000;
    const candidateChats = trip.chatId
      ? [await getChat(trip.chatId).catch(() => null)].filter(Boolean)
      : (await listChatsForUser(session.userId).catch(() => []))
        // 物理现场与手机窗口是两条同时发生的载体。用户可以在“掏出手机”后
        // 给本场角色本人发消息；排除来源 chat 会让这条消息无法折回线下时间线。
        .filter((row) => row?.id);
    const alreadyFoldedIds = new Set(
      (session.beats || []).flatMap((beat) => beat?.notice?.messageIds || []).map(String),
    );
    const activeRows = [];
    for (const sideChat of candidateChats) {
      const msgs = (await listMessagesForChat(sideChat.id).catch(() => []))
        .filter((m) => m && !m.deleted && !m.recalled && Number(m.timestamp || 0) >= since
          && !alreadyFoldedIds.has(String(m.id || ''))
          && !['system', 'time-divider'].includes(String(m.type || '')))
        .slice(-12);
      if (msgs.length) activeRows.push({ chat: sideChat, msgs });
    }
    if (!activeRows.length) {
      await saveOfflineSession(session);
      return { session, added: false };
    }
    const nameCache = new Map();
    for (const row of activeRows) {
      for (const m of row.msgs) {
        const cid = String(m.senderId || '');
        if (cid && cid !== 'user' && !nameCache.has(cid)) {
          const ch = await getCharacter(cid, { userId: session.userId }).catch(() => null);
          nameCache.set(cid, (ch && (ch.customNickname || ch.name)) || '');
        }
      }
    }
    const sections = activeRows.map(({ chat: sideChat, msgs }) => {
      const sidePartnerId = (sideChat.participants || []).find((id) => id && id !== 'user') || '';
      const label = sideChat.groupSettings?.name || nameCache.get(sidePartnerId) || '别的聊天';
      const lines = msgs
        .map((m) => interludeLineForMessage(m, (cid) => nameCache.get(String(cid || ''))))
        .filter(Boolean);
      return lines.length ? `「${label}」\n${lines.join('\n')}` : '';
    }).filter(Boolean);
    if (!sections.length) {
      await saveOfflineSession(session);
      return { session, added: false };
    }
    const ts = await getNowForUser(session.userId).catch(() => Date.now());
    const incomingCount = activeRows.reduce((sum, row) => (
      sum + row.msgs.filter((m) => m.senderId !== 'user').length
    ), 0);
    const outgoingCount = activeRows.reduce((sum, row) => (
      sum + row.msgs.filter((m) => m.senderId === 'user').length
    ), 0);
    const only = activeRows.length === 1 ? activeRows[0] : null;
    const onlyPartnerId = only
      ? (only.chat.participants || []).find((id) => id && id !== 'user') || ''
      : '';
    const onlyLabel = only
      ? (only.chat.groupSettings?.name || nameCache.get(onlyPartnerId) || '一段聊天')
      : '';
    session.beats.push(buildOfflineInterludeBeat({
      id: genId(),
      kind: 'side_trip_fold',
      chatId: only?.chat?.id || '',
      chatLabel: onlyLabel || `${activeRows.length} 个聊天`,
      incomingCount,
      outgoingCount,
      messageIds: activeRows.flatMap((row) => row.msgs.map((m) => m.id)),
      title: only
        ? `${onlyLabel}${incomingCount ? `发来 ${incomingCount} 条消息` : '有新的往来'}`
        : `${activeRows.length} 个聊天有新消息`,
      detail: `你处理了 ${outgoingCount || activeRows.reduce((n, row) => n + row.msgs.length, 0)} 条消息`,
      text: `你中途掏出手机，处理了几段线上往来：\n${sections.join('\n\n')}`,
      ts,
    }));
    await saveOfflineSession(session);
    return { session, added: true };
  } catch (err) {
    console.warn('[offline-session] phone side trip fold failed', err);
    await saveOfflineSession(session).catch(() => {});
    return { session, added: false };
  }
}

/** 未收到回信的最近一次手机插曲不能在后续楼层里静默蒸发。 */
export function buildOfflinePendingPhoneReplyInstruction(session = {}) {
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  for (let index = beats.length - 1; index >= 0; index -= 1) {
    const beat = beats[index];
    const notice = beat?.role === 'interlude' ? beat.notice : null;
    if (notice?.kind !== 'side_trip_fold' || Number(notice.outgoingCount || 0) <= 0) continue;
    const targetChatId = String(notice.chatId || '').trim();
    const resolved = beats.slice(index + 1).some((later) => {
      if (later?.role === 'interlude') {
        return Number(later?.notice?.incomingCount || 0) > 0
          && (!targetChatId || String(later.notice?.chatId || '') === targetChatId);
      }
      return (Array.isArray(later?.phoneActions) ? later.phoneActions : []).some((action) => (
        action?.recipientId === 'user'
        && (!targetChatId || String(action?.chatId || '') === targetChatId)
      ));
    });
    if (resolved) return '';
    return [
      '【尚未落地的手机回信】',
      '最近一次“掏出手机”插曲里，用户已经实际发出消息，但时间线里还没有对方的回信。后续推进不得把这条消息忘掉。',
      '若按人物、时间与当前情境已经适合回复，本轮让对方在手机上自然回信，并在可见正文写明收到或看到这条新消息，同时附真实手机消息动作；若确实暂时不回，正文可以不强插手机，但这一待回事项继续保留，禁止当作已经回复。',
    ].join('\n');
  }
  return '';
}

/** 当天待解决的岔路 checkpoint（供 UI 渲染选项按钮；没有行程或已解决则返回 null）。 */
export function getPendingTripCheckpoint(session) {
  const scene = session?.scene;
  if (!scene?.itinerary) return null;
  return pendingCheckpointForDay(scene.itinerary, Number(scene.dayIndex || 0));
}

/**
 * 用户点了岔路选项：更新行程状态（不额外调用 LLM），返回 directiveText 供下一轮 runOfflineBeat
 * 当"本轮方向"使用，让角色用自己的语气续写这个选择的结果。
 */
export async function resolveTripCheckpointChoice(session, optionId) {
  const scene = session?.scene;
  if (!scene?.itinerary) return { session, directiveText: '', optionLabel: '' };
  const dayIndex = Number(scene.dayIndex || 0);
  const { itinerary, directiveText, optionLabel } = resolveItineraryCheckpointChoice(scene.itinerary, dayIndex, optionId);
  const worldNow = await getNowForUser(session.userId).catch(() => Date.now());
  session.scene = { ...scene, itinerary };
  session.beats = Array.isArray(session.beats) ? session.beats : [];
  session.beats.push({
    id: genId(),
    role: 'interlude',
    text: `行程决定：${optionLabel}`,
    ts: worldNow,
    itineraryDecision: { optionId: String(optionId || ''), optionLabel, dayIndex },
  });
  await saveOfflineSession(session);
  return { session, directiveText, optionLabel };
}

async function participantCharactersForChat(chat, session = null, userId = '') {
  const ids = session
    ? getActiveOfflineParticipantIds(session, chat).slice(0, 6)
    : (chat?.participants || []).filter((x) => x && x !== 'user').slice(0, 6);
  const scopedUserId = String(userId || session?.userId || '').trim();
  const out = [];
  for (const id of ids) {
    const row = await getCharacter(id, { userId: scopedUserId }).catch(() => null);
    if (row) out.push(row);
  }
  return out;
}

/** 「重新规划从今天起的行程」：保留已经发生的天数，重新生成今天开始的剩余行程。 */
export async function rerollTripItineraryFromToday({ session, chat, user, reason = '' } = {}) {
  const scene = session?.scene;
  if (!scene?.itinerary) throw new Error('这场旅行没有可重新规划的行程');
  const dayIndex = Number(scene.dayIndex || 0);
  const characters = await participantCharactersForChat(chat, session);
  const nextItinerary = await rerollTogetherTripItinerary({
    itinerary: scene.itinerary, fromDayIndex: dayIndex, reason, characters, user,
  });
  const worldNow = await getNowForUser(session.userId || user?.id).catch(() => Date.now());
  session.scene = { ...scene, itinerary: nextItinerary };
  session.beats.push({
    id: genId(),
    role: 'daymark',
    text: `行程已重新规划：${nextItinerary.days[dayIndex]?.title || ''}`,
    ts: worldNow,
  });
  await saveOfflineSession(session);
  return session;
}

/**
 * 删除楼层后优先停在原位置后面的下一条；末尾删除才退到上一条。
 * daymark 没有可定位的楼层 DOM，跳过它，避免重绘后视口无锚点地向上回弹。
 */
export function resolveOfflineBeatAnchorAfterRemoval(beats = [], beatIds = []) {
  const rows = Array.isArray(beats) ? beats : [];
  const removedIds = new Set(
    (Array.isArray(beatIds) ? beatIds : [beatIds])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  if (!rows.length || !removedIds.size) return '';
  const firstRemovedIndex = rows.findIndex((row) => removedIds.has(String(row?.id || '')));
  if (firstRemovedIndex < 0) return '';
  const isAnchorable = (row) => (
    row
    && row.role !== 'daymark'
    && !removedIds.has(String(row.id || ''))
    && String(row.id || '').trim()
  );
  const next = rows.slice(firstRemovedIndex + 1).find(isAnchorable);
  if (next) return String(next.id);
  const previous = rows.slice(0, firstRemovedIndex).reverse().find(isAnchorable);
  return previous ? String(previous.id) : '';
}

/** 删除单条 beat（开场/方向/叙事）；始终只删除用户明确选中的这一条。 */
export function deleteOfflineBeat(session = {}, beatId = '') {
  const id = String(beatId || '').trim();
  if (!session?.beats || !id) return { ok: false, reason: 'invalid' };
  const idx = session.beats.findIndex((b) => b.id === id);
  if (idx < 0) return { ok: false, reason: 'not_found' };
  const beat = session.beats[idx];
  if (beat.role === 'daymark') return { ok: false, reason: 'protected' };
  if (!['opening', 'directive', 'narration'].includes(beat.role)) {
    return { ok: false, reason: 'protected' };
  }
  const removedNarrationNumber = beat.role === 'narration'
    ? session.beats.slice(0, idx + 1).filter((row) => row?.role === 'narration').length
    : 0;
  if (beat.role === 'narration') {
    session.beats.splice(idx, 1);
  } else if (beat.role === 'opening') {
    session.beats.splice(idx, 1);
    if (session.scene) session.scene.openingLine = '';
  } else {
    session.beats.splice(idx, 1);
  }
  if (removedNarrationNumber > 0) {
    session.checkpointSummaries = (Array.isArray(session.checkpointSummaries) ? session.checkpointSummaries : [])
      .filter((checkpoint) => Number(checkpoint?.uptoBeatIndex || 0) < removedNarrationNumber);
    if (Number(session.checkpointRollup?.uptoBeatIndex || 0) >= removedNarrationNumber) {
      delete session.checkpointRollup;
    }
    let narrationNumber = 0;
    for (const row of session.beats) {
      if (row?.role !== 'narration') continue;
      narrationNumber += 1;
      if (narrationNumber < removedNarrationNumber) continue;
      delete row.continuityState;
      delete row.continuityPatch;
      delete row.characterStates;
      delete row.digest;
      delete row.digestStatus;
    }
  }
  const remainingIds = new Set(session.beats.map((row) => String(row?.id || '')).filter(Boolean));
  session.bookmarks = (Array.isArray(session.bookmarks) ? session.bookmarks : [])
    .filter((row) => remainingIds.has(String(row?.beatId || '')));
  session.revisions = (Array.isArray(session.revisions) ? session.revisions : [])
    .filter((row) => !row?.beatId || remainingIds.has(String(row.beatId)));
  if (session.rerollVersions && typeof session.rerollVersions === 'object') {
    delete session.rerollVersions[id];
  }
  rebuildOfflineContinuityState(session);
  return { ok: true, role: beat.role };
}

/** 只清除某轮场景图或失败占位，保留正文与 aiImagePrompt 供之后重新生图。 */
export function clearOfflineBeatImage(session = {}, beatId = '') {
  const id = String(beatId || '').trim();
  if (!Array.isArray(session?.beats) || !id) return { ok: false, reason: 'invalid' };
  const beat = session.beats.find((row) => String(row?.id || '') === id);
  if (!beat) return { ok: false, reason: 'not_found' };
  if (!beat.image) return { ok: false, reason: 'no_image' };
  delete beat.image;
  return { ok: true };
}

/** 撤销最后一轮叙事（及紧邻的方向 beat），供重 roll 使用 */
export function rollbackLastOfflineBeat(session = {}) {
  const beats = Array.isArray(session.beats) ? [...session.beats] : [];
  if (!beats.length || beats[beats.length - 1]?.role !== 'narration') {
    return { ok: false, directive: '', removed: 0 };
  }
  beats.pop();
  let directive = '';
  if (beats.length && beats[beats.length - 1]?.role === 'directive') {
    directive = String(beats[beats.length - 1].text || '').trim();
    beats.pop();
  }
  session.beats = beats;
  rebuildOfflineContinuityState(session);
  return { ok: true, directive, removed: 1 };
}

async function participantNamesForChat(chat, session = null, userId = '') {
  const ids = session
    ? getActiveOfflineParticipantIds(session, chat).slice(0, 6)
    : (chat?.participants || []).filter((x) => x && x !== 'user').slice(0, 6);
  const names = [];
  const scopedUserId = String(userId || session?.userId || '').trim();
  for (const id of ids) {
    const row = await getCharacter(id, { userId: scopedUserId }).catch(() => null);
    names.push(getCharacterAiContextName(row, id));
  }
  return names;
}

/** 外语/方言人设角色：叙事对白需要中文括注翻译，按 full/mixed 分两组 */
async function translationSpeakersForChat(chat, session = null, userId = '') {
  const ids = session
    ? getActiveOfflineParticipantIds(session, chat).slice(0, 6)
    : (chat?.participants || []).filter((x) => x && x !== 'user').slice(0, 6);
  const full = [];
  const mixed = [];
  const scopedUserId = String(userId || session?.userId || '').trim();
  for (const id of ids) {
    const char = await getCharacter(id, { userId: scopedUserId }).catch(() => null);
    const profile = normalizeTranslationProfile(char?.translationProfile);
    if (profile.mode === 'full') {
      full.push({ name: getCharacterAiContextName(char, id), language: profile.language });
    } else if (profile.mode === 'mixed') {
      mixed.push({ name: getCharacterAiContextName(char, id), dialectNote: profile.dialectNote });
    }
  }
  return { full, mixed };
}

function translationInstruction(speakers = { full: [], mixed: [] }) {
  const lines = [];
  if (speakers.full?.length) {
    const list = speakers.full.map((s) => `${s.name}（主要讲${s.language || 'TA 设定里的外语'}）`).join('、');
    lines.push(
      '[外语人设翻译]',
      `${list} 的对白台词要直接写角色设定语言的原文；中文方言保留方言原句，其他外语不要改写成中文。紧跟在完整原句后面只加一组〔简体中文普通话译文〕，如：「I've missed you.」〔我很想你。〕或：「我而家返紧嚟。」〔我现在正在回来。〕`,
      '〔〕翻译只放在这些角色的直接引语后面，不要用来翻译旁白、动作描写，也不要影响其他角色或用户的对白语言；必须用半角方头括号〔〕，不要用普通括号（）。',
      '原文必须留在〔〕外，〔〕里只能放对应的简体中文普通话译文；禁止把外语、日语假名或粤语等方言原句放进〔〕，也禁止把同一句拆成多组原文/译文标记。',
    );
  }
  if (speakers.mixed?.length) {
    const list = speakers.mixed.map((s) => `${s.name}（偶尔蹦${s.dialectNote || '外语/方言词句'}）`).join('、');
    lines.push(
      '[偶尔外语/方言翻译]',
      `${list} 平时对白正常写中文，只有偶尔蹦出这类词句时，直接紧跟着用〔〕标出意思，如：他挠挠头，「这方案有点anticlimactic〔虎头蛇尾〕啊」；不要整句翻译，也不要没事找词硬凑，必须用〔〕而不是普通括号（）。`,
    );
  }
  return lines.join('\n');
}

export function buildOfflineWeatherReferenceLine({
  weatherLine = '',
  cityInfo = null,
  ownerLabel = '角色',
} = {}) {
  const line = String(weatherLine || '').trim();
  if (!line) return '';
  const virtualCity = String(cityInfo?.virtualCity || '').trim();
  const weatherCity = String(cityInfo?.weatherCity || cityInfo?.realCityMap || '').trim();
  if (
    !virtualCity
    || !weatherCity
    || normalizeCityInput(virtualCity) === normalizeCityInput(weatherCity)
  ) return line;
  return [
    line,
    `城市边界：上面的“${weatherCity}”只是${ownerLabel}的现实天气映射数据源，不是剧情城市。`,
    `${ownerLabel}资料中的故事城市仍是“${virtualCity}”；叙事地点以“${virtualCity}”或本场另行明确的地点为准，禁止把“${weatherCity}”写成${ownerLabel}所在城市或本场城市。`,
  ].join('\n');
}

/**
 * 推进一轮线下：把场景 + 已有 beats + 本轮方向交给模型，产出一段叙事正文。
 * 会把「方向」与「叙事」两条 beat 追加进 session 并落库。
 */
async function resolveOfflineWeatherLine({ chat = null, user = null, session = null } = {}) {
  const partnerId = session
    ? (getActiveOfflineParticipantIds(session, chat)[0] || '')
    : ((chat?.participants || []).find((id) => id && id !== 'user') || '');
  const scopedUserId = String(user?.id || session?.userId || '').trim();
  const character = partnerId
    ? await getCharacter(partnerId, { userId: scopedUserId }).catch(() => null)
    : null;
  const charInfo = character ? getEffectiveWeatherCityForCharacter(character) : null;
  const userInfo = user ? getEffectiveWeatherCityForUser(user) : null;
  const activeInfo = charInfo?.weatherCity ? charInfo : userInfo;
  const city = activeInfo?.weatherCity || '';
  if (!city) return '';
  const weather = await fetchWeatherForCity(city).catch(() => null);
  const weatherLine = summarizeWeatherForHint(weather) || String(weather?.promptLine || '').trim();
  return buildOfflineWeatherReferenceLine({
    weatherLine,
    cityInfo: activeInfo,
    ownerLabel: activeInfo === charInfo ? '角色' : '用户',
  });
}

/**
 * 选出应注入「完整原文窗口之前」的分段小结。
 * 每条 checkpoint 覆盖上一条之后的片段；若窗口边界落在某条小结中间，
 * 仍保留这条桥接小结，避免边界前几轮既不在原文窗口、也不在小结里。
 */
export { selectOfflineCheckpointSummariesForContext } from './offline-checkpoint-memory.js';

/**
 * 长线下会话采用「旧段小结 + 最近完整轮次」：
 * - scene.contextDepth 只计 narration，符合用户看到的“轮次/楼层”；
 * - 早于完整窗口、且已被 checkpoint 覆盖的内容以小结补回；
 * - 窗口边界若落在某条小结中间，就把原文起点后移到该小结之后；
 * - 小结与完整原文严格不重叠，避免模型把几轮前的总结误当成当前续写点。
 */
export function buildOfflineHistoryContext(session) {
  const contextDepth = clampNum(session.scene?.contextDepth, 2, 60, 12);
  const contentBeats = (session.beats || []).filter((beat) =>
    ['opening', 'directive', 'narration', 'interlude'].includes(beat.role),
  );
  const totalNarrations = contentBeats.filter((beat) => beat.role === 'narration').length;
  const desiredRawFirst = Math.max(1, totalNarrations - contextDepth + 1);
  const effectiveCheckpoints = effectiveOfflineCheckpointSummaries(
    session.checkpointSummaries,
    session.checkpointRollup,
  );
  // 至少保留最近半个窗口（最低 4 轮）的完整原文。桥接 checkpoint 可以向后
  // 跨过理想窗口边界，但不能吞掉最新现场、让模型只拿摘要继续写。
  const recentRawFloor = Math.min(contextDepth, Math.max(4, Math.ceil(contextDepth / 2)));
  const maxSummaryUpto = Math.max(0, totalNarrations - recentRawFloor);
  const usableCheckpoints = effectiveCheckpoints.filter((checkpoint) =>
    Number(checkpoint?.uptoBeatIndex || 0) <= maxSummaryUpto);
  const summaries = selectOfflineCheckpointSummariesForContext(
    usableCheckpoints,
    Math.max(0, desiredRawFirst - 1),
  );
  const summaryCutoff = summaries.reduce(
    (max, checkpoint) => Math.max(max, Number(checkpoint?.uptoBeatIndex || 0)),
    0,
  );
  const rawCutoff = Math.max(summaryCutoff, desiredRawFirst - 1);
  let rawStartIndex = 0;
  let narrationSeen = 0;
  for (let index = 0; index < contentBeats.length; index += 1) {
    if (contentBeats[index].role !== 'narration') continue;
    narrationSeen += 1;
    if (narrationSeen <= rawCutoff) rawStartIndex = index + 1;
  }

  const transcript = contentBeats.slice(rawStartIndex).map((beat) => {
    const socialReceipts = (Array.isArray(beat?.socialPostNotices) ? beat.socialPostNotices : [])
      .map((notice) => {
        const title = String(notice?.title || '').trim();
        const detail = String(notice?.detail || '').trim();
        if (!title) return '';
        return `${notice?.status === 'saved' ? '成功' : '失败'}：${title}${detail ? `（${detail}）` : ''}`;
      })
      .filter(Boolean);
    const baseContent = beat.role === 'interlude'
      ? `[线上插曲·现场时间线的一部分]\n${beat.text}`
      : (beat.role === 'opening'
        ? `[本场开场设定·优先于旧聊天]\n${beat.text}`
        : (beat.role === 'directive'
          ? `[历史用户方向·已执行]\n${beat.text}\n[历史边界] 这条方向后面的叙事已经是它的执行结果；后续轮次禁止再次回应或复演它。`
          : beat.text));
    return {
      role: beat.role === 'narration' ? 'assistant' : 'user',
      content: socialReceipts.length
        ? `${baseContent}\n[程序动作回执·事实优先]\n${socialReceipts.join('\n')}`
        : baseContent,
    };
  });
  const coverageRanges = offlineCheckpointCoverageRanges(
    summaries,
    session.scene?.autoSummaryEvery || 6,
  );
  let earlierNarrationNumber = 0;
  const uncoveredEarlierLines = contentBeats.slice(0, rawStartIndex).flatMap((beat) => {
    if (beat.role !== 'narration') return [];
    earlierNarrationNumber += 1;
    if (isOfflineNarrationCovered(earlierNarrationNumber, coverageRanges)) return [];
    const digestLine = formatOfflineBeatDigestForContext(beat.digest, earlierNarrationNumber);
    if (digestLine) return [`[恢复的逐轮摘要] ${digestLine}`];
    return [`[恢复的未覆盖原文·第 ${earlierNarrationNumber} 轮旁白] ${beat.text}`];
  });
  const checkpointContext = summaries.length || uncoveredEarlierLines.length
    ? [
      '[更早的线下进展 · 分段小结]',
      '以下是当前完整原文窗口之前已经发生的事。它们均为既定事实：承接其中的关系变化、未完成事项、关键物件和约定，不要推翻、遗忘或重新演一遍。',
      '这些小结与下方完整原文按轮次严格分段、没有重复覆盖。小结只交代因果和长期状态；当前动作、位置与续写起点一律以下方最后几轮完整原文为准。',
      ...summaries.map((checkpoint, index) => `${index + 1}. ${String(checkpoint.text).trim()}`),
      ...(uncoveredEarlierLines.length ? [
        '以下逐轮摘要或原文来自尚未被大摘要覆盖的区间，同样是既定事实；逐轮摘要仅压缩对应单轮，不代表新近发生：',
        ...uncoveredEarlierLines,
      ] : []),
    ].join('\n')
    : '';

  return { transcript, checkpointContext };
}

/**
 * 本体指导读取与实际线下推进相同的角色卡、用户卡、世界书、预设、记忆和线上桥接，
 * 再叠加本场 checkpoint 与当前完整原文窗口。指导只读这份上下文，不会推进剧情。
 */
export async function buildOfflineGuidanceReferenceContext({
  session,
  chat,
  user,
  messages = [],
} = {}) {
  if (!session || !chat) return '';
  const userId = String(user?.id || session?.userId || '').trim();
  const activeChat = buildActiveOfflineChat(session, chat);
  const participantRows = await participantCharactersForChat(activeChat, session, userId);
  const activeCharacterIds = getActiveOfflineParticipantIds(session, chat);
  const selectiveQueryText = buildOfflineOffsceneQueryText(session, '');
  const allKnownCharacters = await listCharacters({
    includeInternal: true,
    userId,
    identityScoped: true,
  }).catch(() => []);
  const offsceneCharacterIds = resolveMentionedOffsceneCharacterIds({
    text: selectiveQueryText,
    characters: allKnownCharacters,
    activeCharacterIds,
  });
  const offsceneSet = new Set(offsceneCharacterIds);
  const characters = Object.fromEntries(
    [...(participantRows || []), ...allKnownCharacters.filter((row) => offsceneSet.has(String(row?.id || '')))]
      .filter((row) => row?.id)
      .map((row) => [row.id, row]),
  );
  const worldBookIds = normalizeWorldBookIds(session.scene || {});
  const presetStyleIds = normalizePresetStyleIds(session.scene || {});
  const onlineBridgeLimit = clampNum(Number(session.scene?.contextDepth || 12) * 3, 12, 80, 36);
  const bridgeMessages = session.archiveContinuation?.archiveId
    ? []
    : selectOfflineBridgeMessages(messages, session.lastEncounter, onlineBridgeLimit);
  const { messages: sharedContextMessages } = await buildChatContext({
    chat: activeChat,
    chatId: activeChat.id || chat.id,
    user,
    userId,
    messages: bridgeMessages,
    characters,
    sceneDirective: '',
    presetMode: 'offline',
    regexSurface: 'offline',
    contextDepth: onlineBridgeLimit,
    worldBookOnlyIds: worldBookIds.length ? worldBookIds : undefined,
    presetOnlyIds: presetStyleIds.length ? presetStyleIds : undefined,
    selectiveQueryText,
    offsceneCharacterIds,
    deferAnonymousLinkedMemory: true,
  });
  const sharedContext = (sharedContextMessages || [])
    .map((message) => {
      const body = String(message?.content || '').trim();
      if (!body) return '';
      if (message.role === 'system') return body;
      return `${message.role === 'assistant' ? '角色' : '用户'}：${body}`;
    })
    .filter(Boolean)
    .join('\n\n');
  const { transcript, checkpointContext } = buildOfflineHistoryContext(session);
  const sceneTranscript = transcript
    .map((message) => `${message.role === 'assistant' ? '线下叙事' : '用户方向'}：${String(message.content || '').trim()}`)
    .filter((line) => !line.endsWith('：'))
    .join('\n\n');
  return [
    '【线下实际生成共用上下文】',
    sharedContext,
    checkpointContext,
    sceneTranscript ? `【本场当前完整原文窗口】\n${sceneTranscript}` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * 新一场线下只读取「上一场线下结束后」的线上消息作为桥梁。
 * 更早的聊天已被上一场档案覆盖；再次原样注入会诱导模型退回旧场景或重复剧情。
 */
export function selectOfflineBridgeMessages(messages = [], lastEncounter = null, limit = 36) {
  const cap = clampNum(limit, 8, 80, 36);
  const endedAt = Number(lastEncounter?.endedAt || 0);
  const archivedAtReal = Number(lastEncounter?.archivedAtReal || 0);
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted && !message.recalled)
    .sort((a, b) => {
      if (archivedAtReal > 0) {
        const realDelta = offlineMessageCreatedAtReal(a) - offlineMessageCreatedAtReal(b);
        if (realDelta) return realDelta;
      }
      return Number(a.timestamp || 0) - Number(b.timestamp || 0);
    });
  const bridge = archivedAtReal > 0
    ? rows.filter((message) => {
      const createdAtReal = offlineMessageCreatedAtReal(message);
      if (createdAtReal > 0) return createdAtReal > archivedAtReal;
      return endedAt <= 0 || Number(message.timestamp || 0) > endedAt;
    })
    : (endedAt > 0
      ? rows.filter((message) => Number(message.timestamp || 0) > endedAt)
      : rows);
  return bridge.slice(-cap);
}

function formatOfflineTransitionTime(ts = 0) {
  const value = Number(ts || 0);
  if (!value) return '当前';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '当前';
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 把「上一场线下 → 中间线上桥接 → 本场开场」压成唯一的跨模式事件链。
 * 线上消息仍参与 buildChatContext 的世界书/记忆检索，但不再作为一组裸聊天历史追加到叙事请求末尾。
 */
export function buildOfflineTransitionTimeline({
  session = {},
  bridgeMessages = [],
  bridgeSummaries = [],
  characters = {},
  budgetChars = 12000,
} = {}) {
  const rows = [];
  const worldTimeConflict = session?.lastEncounter?.worldTimeConflict === true
    || (
      Number(session?.lastEncounter?.endedAt || 0) > 0
      && Number(session?.lastEncounter?.endedAt || 0) > Number(session?.startedAtWorld || session?.createdAt || 0)
    );
  const previous = lastEncounterLine(session.lastEncounter);
  if (previous) rows.push(previous);
  const archiveContinuation = buildOfflineArchiveContinuationContext(session.archiveContinuation);
  if (archiveContinuation) rows.push(archiveContinuation);
  const summaryRows = (Array.isArray(bridgeSummaries) ? bridgeSummaries : [])
    .map((memory) => clipOfflineBridgeText(memory?.content, 3200))
    .filter(Boolean);
  if (summaryRows.length) {
    rows.push(
      '[线上桥接总结·覆盖后续原文] '
      + summaryRows.join('\n\n'),
    );
  }
  const maxChars = Math.max(3200, Math.min(24000, Number(budgetChars) || 12000));
  const bridgeRows = [];
  let used = 0;
  let omitted = 0;
  for (let index = bridgeMessages.length - 1; index >= 0; index -= 1) {
    const message = bridgeMessages[index];
    const line = offlineBridgeLineForMessage(message, characters);
    if (!line) continue;
    const row = `[${worldTimeConflict ? '上一场收纳后' : formatOfflineTransitionTime(message.timestamp)}][线上桥接原文] ${line}`;
    if (used + row.length > maxChars && bridgeRows.length >= 4) {
      omitted += 1;
      continue;
    }
    bridgeRows.unshift(row);
    used += row.length;
  }
  if (omitted) rows.push(`[较早线上桥接] 另有 ${omitted} 条消息因总预算省略；以下保留的是距离本场最近、应优先承接的原文。`);
  rows.push(...bridgeRows);
  const scene = session.scene || {};
  const currentBits = [
    scene.place ? `地点：${scene.place}` : '',
    scene.goal ? `安排：${scene.goal}` : '',
    scene.openingLine ? `用户指定开场：${scene.openingLine}` : '',
  ].filter(Boolean);
  rows.push(
    `[${worldTimeConflict ? '当前' : formatOfflineTransitionTime(session.startedAtWorld || session.createdAt)}][本场线下开始] ${
      currentBits.join('；') || (archiveContinuation
        ? '从上方所选档案的最后一条原文直接续写。'
        : '从线上桥接后的最新状态自然进入本场。')
    }`,
  );
  return [
    '【跨模式连续时间线 · 本场唯一先后顺序】',
    ...(worldTimeConflict ? ['剧情钟曾被切换或回拨，以下编号与真实收纳顺序是唯一先后依据；冲突的旧剧情钟点仅作存档展示，不得据此把上一场判到本场之后。'] : []),
    ...rows.map((row, index) => `${index + 1}. ${row}`),
    '硬规则：严格按编号理解时间。已完成线下只保留已发生经历与关系后果；线上桥接原文发生在两场线下之间，若已换地点、话题、安排或情绪阶段，它会覆盖上一场结尾的临时状态；本场开场是最新节点。只从最后一项继续，禁止把旧卷宗的结尾情绪、地点、话题或存档伏笔当成本场开场，也禁止跳回、重演、交换顺序或另起无关场景。线上消息的短句、换行、连续发送和句尾标点只是聊天载体，不是线下叙事文风样本；线下正文按当前叙事设置自然分段和使用标点。',
  ].join('\n');
}

export function buildOfflineReentryTimeline({
  bridgeMessages = [],
  bridgeSummaries = [],
  characters = {},
  budgetChars = 12000,
} = {}) {
  const summaryRows = (Array.isArray(bridgeSummaries) ? bridgeSummaries : [])
    .map((memory) => clipOfflineBridgeText(memory?.content, 3200))
    .filter(Boolean);
  const maxChars = Math.max(3200, Math.min(24000, Number(budgetChars) || 12000));
  const messageRows = [];
  let used = 0;
  for (let index = bridgeMessages.length - 1; index >= 0; index -= 1) {
    const message = bridgeMessages[index];
    const line = offlineBridgeLineForMessage(message, characters);
    if (!line) continue;
    const row = `[线下暂离期间·线上新消息] ${line}`;
    if (used + row.length > maxChars && messageRows.length >= 4) continue;
    messageRows.unshift(row);
    used += row.length;
  }
  if (!summaryRows.length && !messageRows.length) return '';
  return [
    '【返回线下前的新增线上剧情 · 最新接续点】',
    '用户在本场线下暂离期间又继续了线上聊天。下列内容比上方已有线下原文更晚，是本轮真正的新起点。',
    ...(summaryRows.length ? [
      `【用户手动/自动沉淀的这段线上总结】\n${summaryRows.join('\n\n')}`,
    ] : []),
    ...messageRows,
    '硬规则：先承认旧线下原文已发生，再以上面新增线上剧情校正人物当前位置、话题、约定和情绪；从最后一条线上内容后继续。禁止退回上次线下摘要重演，也禁止把线上简写句式当作线下文风。',
  ].join('\n');
}

export function buildOfflineTransitionContext({
  session = {},
  bridgeMessages = [],
  reentryMessages = [],
  bridgeSummaries = [],
  characters = {},
  beatIndex = 0,
} = {}) {
  const currentBeat = Math.max(0, Number(beatIndex) || 0);
  if (currentBeat > 2) {
    return buildOfflineReentryTimeline({
      bridgeMessages: reentryMessages,
      bridgeSummaries,
      characters,
    });
  }
  return buildOfflineTransitionTimeline({
    session,
    bridgeMessages: currentBeat === 0 ? bridgeMessages : bridgeMessages.slice(-6),
    bridgeSummaries,
    characters,
    ...(currentBeat === 0 ? {} : { budgetChars: 3200 }),
  });
}

/**
 * 把用户手动选择的匿名马甲经历放到线下生成末端的连续性时间线里。
 * 这里不改变身份判定：separate 只承接角色自身余波，merged 才能认定匿名网友就是当前 user。
 */
export function buildOfflineAnonymousContinuityContext(memoryBlock = '', mode = 'off') {
  const block = String(memoryBlock || '').trim();
  if (!block || (mode !== 'separate' && mode !== 'merged')) return '';
  const identityRule = mode === 'merged'
    ? '身份关系：用户已明确选择“已经掉马”；匿名房里的匿名网友就是本场这位 user。这是共同经历，可自然续接其中最后的情绪、话题、约定与未完反应。'
    : '身份关系：用户选择“当作陌生人”；这些是角色本人此前的匿名经历，但不能认定匿名网友就是本场 user。只承接角色自己的情绪余波、精力和想法，不得把具体对话安到当前 user 身上。';
  return [
    '【线下连续时间线 · 匿名经历前置节点】',
    '以下匿名经历均发生在本场线下开始之前，并已按房间最近活动时间排列；它们不是可忽略的背景资料，而是角色走进本场时已经带着的状态。',
    identityRule,
    block,
    '衔接规则：先承接每个房间最末处形成的状态，再进入后面的线上桥接与本场开场；禁止把匿名旧事写成本场刚刚发生，也禁止跳回匿名房重演。',
  ].join('\n');
}

/** 用户主动选择后，只补当前末层缺失的心声，不重写正文。 */
export async function supplementOfflineCharacterStates({
  session,
  chat,
  user,
  beatId = '',
  signal = null,
} = {}) {
  if (!session) throw new Error('线下会话不存在');
  if (session.scene?.innerVoiceEnabled !== true) throw new Error('本场尚未开启心声');
  const target = [...(session.beats || [])].reverse().find((beat) => beat?.role === 'narration');
  if (!target || String(target.id || '') !== String(beatId || '')) {
    throw new Error('只能补当前最后一层的心声');
  }
  const activeChat = buildActiveOfflineChat(session, chat);
  const activeCharacterIds = getActiveOfflineParticipantIds(session, chat);
  const missingIds = missingOfflineCharacterStateIds(target, activeCharacterIds);
  if (!missingIds.length) return { beat: target, addedIds: [] };
  const participantRows = await participantCharactersForChat(activeChat, session);
  const characterById = Object.fromEntries((participantRows || [])
    .filter((row) => row?.id)
    .map((row) => [String(row.id), row]));
  const actors = missingIds.map((id) => {
    const row = characterById[id] || {};
    return {
      id,
      name: String(row.customNickname || row.name || row.realName || id).trim() || id,
      translationProfile: normalizeTranslationProfile(row.translationProfile),
    };
  });
  const userId = session.userId || user?.id || '';
  const stylePrefs = await loadOfflineStylePrefs(userId).catch(() => null);
  const innerVoiceCard = resolveOfflineInnerVoiceCard(stylePrefs, activeChat, 'diary');
  const previousStates = latestOfflineCharacterStates({
    ...session,
    beats: (session.beats || []).filter((beat) => beat?.id !== target.id),
  }, activeCharacterIds);
  const prompt = [
    '【线下楼层 · 单独补心声】',
    '下面正文已经展示并保存。不要续写、改写、总结或重复正文；只补指定角色在这一刻没说出口的心声结构块。',
    `场景：${String(session.scene?.place || '当前线下场景').trim()}`,
    `已保存正文：\n${String(target.text || '').trim()}`,
    offlineCharacterStatesInstruction(actors, previousStates, {
      userName: getUserDisplayName(user),
      generationMode: innerVoiceCard?.generationMode,
      generationPrompt: innerVoiceCard?.generationPrompt,
    }),
    '只输出上述结构块，不要输出任何可见叙事正文。',
  ].filter(Boolean).join('\n\n');
  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  const raw = await chatWithEmptyFallback(apiChat, [
    { role: 'system', content: prompt },
    { role: 'user', content: '请仅补全指定角色在已保存正文后的心声结构块。' },
  ], {
    temperature: 0.65,
    configOverride: apiOverride || undefined,
    signal,
    stream: false,
  });
  const parsed = extractOfflineCharacterStates(raw, {
    actors,
    previousStates,
    userName: getUserDisplayName(user),
  });
  const addedIds = Object.keys(parsed.states || {});
  if (!addedIds.length) throw new Error('接口没有返回可识别的心声格式，可选择整轮重 roll');
  target.characterStates = {
    ...(target.characterStates || {}),
    ...parsed.states,
  };
  target.thoughtSupplementedAt = Date.now();
  await saveOfflineSession(session);
  return { beat: target, addedIds };
}

export async function runOfflineBeat({
  session,
  chat,
  user,
  messages = [],
  directive = '',
  revision = null,
  continuation = null,
  onChunk = null,
  onReasoning = null,
  onBeatReady = null,
  onRequestStart = null,
  signal = null,
}) {
  if (!session) throw new Error('线下会话不存在');
  const generationLease = await acquireNarrationGenerationLease('offline', session.id || session.chatId);
  if (!generationLease.acquired) throw narrationGenerationInFlightError();
  try {
  await primeRegex().catch(() => null);
  const chatId = session.chatId;
  const userId = session.userId || user?.id || '';
  const currentUserName = getUserDisplayName(user);
  if (revision && continuation) throw new Error('不能同时重修和续写');
  const revisionTarget = revision ? lastRevisableNarration(session) : null;
  const continuationTarget = continuation ? lastRevisableNarration(session) : null;
  if (revision && !revisionTarget) throw new Error('只能重修当前最后一层叙事');
  if (revision?.beatId && String(revision.beatId) !== String(revisionTarget?.beat?.id || '')) {
    throw new Error('只能重修当前最后一层叙事');
  }
  if (continuation && !continuationTarget) throw new Error('只能续写当前最后一层叙事');
  if (continuation?.beatId && String(continuation.beatId) !== String(continuationTarget?.beat?.id || '')) {
    throw new Error('只能续写当前最后一层叙事');
  }
  const revisionRequirement = String(revision?.requirement || '').trim().slice(
    0,
    revision?.expertConsultation === true ? 2600 : 500,
  );
  if (revision && !revisionRequirement) throw new Error('请写下这次想怎么改');
  if (revision && session.scene?.retainRerollVersions === true
    && offlineBeatHasExternalActions(revisionTarget?.beat)) {
    throw new Error('这一层已经产生真实手机或朋友圈动作，不能安全保留为多版本');
  }
  const originalDirective = String((revisionTarget || continuationTarget)?.directiveBeat?.text || '').trim();
  const trimmedDirective = applyPermanentRegex(
    String((revision || continuation) ? (directive || originalDirective) : directive || '').trim(),
    {
      surface: 'offline',
      placement: 1,
      depth: 0,
      macros: { user: user?.name || '用户', char: '角色' },
    },
  );
  const provisionalBeatId = genId();
  const revisionState = revision ? {
    beatId: revisionTarget.beat.id,
    originalText: revision.independentReroll === true
      ? ''
      : String(revisionTarget.beat.text || '').trim(),
    requirement: revisionRequirement,
    independentReroll: revision.independentReroll === true,
    samplingNonce: revision.independentReroll === true ? provisionalBeatId : '',
    supplementalAudit: revision.supplementalAudit === true,
    expertConsultation: revision.expertConsultation === true,
  } : null;
  const continuationState = continuation ? {
    beatId: continuationTarget.beat.id,
    originalText: String(continuationTarget.beat.text || '').trim(),
  } : null;
  const generationSession = revisionTarget
    ? buildOfflineRevisionGenerationSession(session, revisionTarget)
    : session;
  session.inFlight = {
    status: 'streaming',
    beatId: provisionalBeatId,
    mode: revision ? 'revision' : (continuation ? 'continuation' : 'advance'),
    targetBeatId: revisionState?.beatId || continuationState?.beatId || '',
    directive: trimmedDirective,
    partialText: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveOfflineSession(session).catch((err) => {
    console.warn('[offline-session] inFlight start save failed', err);
  });
  const generationIsCurrent = () => String(session.inFlight?.beatId || '') === provisionalBeatId;
  const assertGenerationCurrent = () => {
    if (generationIsCurrent()) return;
    const revokedError = new Error('这次线下生成已由用户停止');
    revokedError.name = 'AbortError';
    revokedError.reason = 'generation-revoked';
    revokedError.offlineGenerationBeatId = provisionalBeatId;
    throw revokedError;
  };

  let revisionRollback = null;
  try {
    ensureOfflineAttendance(session, chat);
    const activeChat = buildActiveOfflineChat(session, chat);
    const userPresent = isOfflineUserPresent(session, chat);
    const offlineStylePrefs = await loadOfflineStylePrefs(userId).catch(() => null);
    const innerVoiceCard = resolveOfflineInnerVoiceCard(offlineStylePrefs, activeChat, 'diary');
    const participantNames = await participantNamesForChat(activeChat, session);
    const translationSpeakers = await translationSpeakersForChat(activeChat, session);
    const promptDirective = applyPromptRegex(trimmedDirective, {
      surface: 'offline',
      placement: 1,
      depth: 0,
      macros: { user: user?.name || '用户', char: participantNames[0] || '角色' },
    });

    const worldBookIds = normalizeWorldBookIds(session.scene || {});
    const presetStyleIds = normalizePresetStyleIds(session.scene || {});
    const editorialAuditRequested = revision?.supplementalAudit === true || (presetStyleIds.length
      ? presetStyleIds.includes('style_paragraph_audit')
      : !(await loadDisabledBuiltinPresetIds()).has('style_paragraph_audit'));
    const participantRows = await participantCharactersForChat(activeChat, session);
    const activeCharacterIds = getActiveOfflineParticipantIds(session, chat);
    const offsceneQueryText = buildOfflineOffsceneQueryText(generationSession, promptDirective);
    const allKnownCharacters = await listCharacters({
      includeInternal: true,
      userId,
      identityScoped: true,
    }).catch(() => []);
    const offsceneCharacterIds = resolveMentionedOffsceneCharacterIds({
      text: offsceneQueryText,
      characters: allKnownCharacters,
      activeCharacterIds,
    });
    const offsceneSet = new Set(offsceneCharacterIds);
    const offsceneRows = allKnownCharacters.filter((row) => row?.id && offsceneSet.has(String(row.id)));
    const characters = Object.fromEntries(
      [...(participantRows || []), ...offsceneRows]
        .filter((row) => row?.id)
        .map((row) => [row.id, row]),
    );
    // 多版本候选必须是纯线下快照；真实聊天/朋友圈不能同时存在于多个候选中。
    const phoneMessagesEnabled = session.scene?.phoneMessagesEnabled !== false
      && !(revision && session.scene?.retainRerollVersions === true);
    const phoneActionDirectory = phoneMessagesEnabled
      ? await buildOfflinePhoneActionDirectory({
        userId,
        activeCharacterIds,
        focusCharacterIds: offsceneCharacterIds,
      }).catch(() => null)
      : null;
    // 把本场已落库的手机消息回灌进动作指令，避免几回合内换皮重发。
    if (phoneActionDirectory) {
      phoneActionDirectory.sentActions = collectOfflinePhoneActionsFromBeats(generationSession.beats);
      const configuredProxyId = String(session.autoReply?.proxyCharacterId || '').trim();
      const takeoverProxyId = activeCharacterIds.includes(configuredProxyId)
        ? configuredProxyId
        : (activeCharacterIds[0] || '');
      phoneActionDirectory.takeoverEnabled = session.autoReply?.mode === 'companion'
        && session.autoReply?.incomingTakeover?.enabled === true
        && !!takeoverProxyId;
      phoneActionDirectory.takeoverProxyId = takeoverProxyId;
      phoneActionDirectory.takeoverProxyName = takeoverProxyId
        ? (characters[takeoverProxyId]?.customNickname || characters[takeoverProxyId]?.name || takeoverProxyId)
        : '';
    }
    // 上次若在“beat 已保存、手机消息派发/回执保存”之间中断，这里用确定性
    // messageId 幂等补发。正文与 outbox 先落库，因此恢复失败也不会吞掉叙事。
    let recoveredPhoneOutbox = false;
    for (const previousBeat of (Array.isArray(session.beats) ? session.beats : [])) {
      const pending = pendingOfflinePhoneActionOutbox(previousBeat);
      if (!pending.length) continue;
      const recovered = await dispatchOfflinePhoneActions({
        actions: pending,
        directory: phoneActionDirectory,
        userId,
        sessionId: session.id,
        beatId: previousBeat.phoneActionDispatchBeatId || previousBeat.id,
        timestamp: previousBeat.ts,
      });
      applyOfflinePhoneActionReceipts(previousBeat, recovered);
      const knownMessageIds = new Set(
        (Array.isArray(previousBeat.phoneActions) ? previousBeat.phoneActions : [])
          .map((action) => String(action?.messageId || '').trim())
          .filter(Boolean),
      );
      previousBeat.phoneActions = [
        ...(Array.isArray(previousBeat.phoneActions) ? previousBeat.phoneActions : []),
        ...(recovered.actions || []).filter((action) => !knownMessageIds.has(String(action?.messageId || '').trim())),
      ];
      previousBeat.phoneActionNotices = [
        ...(Array.isArray(previousBeat.phoneActionNotices) ? previousBeat.phoneActionNotices : []),
        ...(recovered.notices || []).filter((notice) =>
          !(previousBeat.phoneActionNotices || []).some((row) =>
            String(row?.messageIds?.[0] || '') === String(notice?.messageIds?.[0] || ''))),
      ];
      recoveredPhoneOutbox = true;
      if ((recovered.receipts || []).some((receipt) => receipt.status !== 'saved')) {
        await appendDebugEvent({
          type: 'offline_phone_outbox_recovery',
          level: 'warn',
          message: '线下手机动作恢复未全部落库',
          context: { sessionId: session.id, beatId: previousBeat.id, receipts: recovered.receipts },
        });
      }
    }
    for (const previousBeat of (Array.isArray(session.beats) ? session.beats : [])) {
      const pendingSocialPosts = Array.isArray(previousBeat?.socialPostOutbox)
        ? previousBeat.socialPostOutbox
        : [];
      if (!pendingSocialPosts.length || (previousBeat.socialPostActions || []).length) continue;
      const recovered = await dispatchOfflineSocialPosts({
        posts: pendingSocialPosts,
        directory: phoneActionDirectory,
        user,
        userId,
        sessionId: session.id,
        beatId: previousBeat.phoneActionDispatchBeatId || previousBeat.id,
        recentMessages: messages,
      });
      previousBeat.socialPostActions = recovered.actions || [];
      previousBeat.socialPostNotices = recovered.notices || [];
      previousBeat.phoneActionNotices = [
        ...(Array.isArray(previousBeat.phoneActionNotices) ? previousBeat.phoneActionNotices : []),
        ...(recovered.notices || []),
      ];
      previousBeat.socialPostOutbox = Array.isArray(recovered.pending) ? recovered.pending : [];
      recoveredPhoneOutbox = true;
    }
    if (recoveredPhoneOutbox) {
      await saveOfflineSession(session).catch((error) => appendDebugEvent({
        type: 'offline_phone_outbox_receipt_save_error',
        level: 'error',
        error,
        context: { sessionId: session.id },
      }));
    }
    const onlineBridgeLimit = clampNum(Number(session.scene?.contextDepth || 12) * 3, 12, 80, 36);
    // “续写这段”是对所点档案开分支，不夹入该档案之后的线上聊天或其它新档案，
    // 否则模型会把更晚发生的内容误当成真正续写起点。
    const bridgeMessages = session.archiveContinuation?.archiveId
      ? []
      : selectOfflineBridgeMessages(messages, session.lastEncounter, onlineBridgeLimit);
    const beatIndex = generationSession.beats.filter((b) => b.role === 'narration').length;
    const reentryMessages = (!revision && !continuation && beatIndex > 0)
      ? selectOfflineReentryBridgeMessages(messages, session, onlineBridgeLimit)
      : [];
    const transitionBridgeMessages = beatIndex > 2
      ? reentryMessages
      : (beatIndex === 0 ? bridgeMessages : bridgeMessages.slice(-6));
    const bridgeSummaryRows = transitionBridgeMessages.length
      ? await getAllByIndex('memories', 'chatId', chatId).catch(() => [])
      : [];
    const bridgeSummaries = selectOfflineBridgeSummaries(
      bridgeSummaryRows,
      transitionBridgeMessages,
      { userId },
    );
    const { messages: contextMessages, worldBookRecallTail } = await buildChatContext({
      chat: activeChat,
      chatId,
      user,
      userId,
      messages: bridgeMessages,
      characters,
      sceneDirective: '',
      presetMode: 'offline',
      regexSurface: 'offline',
      contextDepth: onlineBridgeLimit,
      worldBookOnlyIds: worldBookIds.length ? worldBookIds : undefined,
      presetOnlyIds: presetStyleIds.length ? presetStyleIds : undefined,
      selectiveQueryText: offsceneQueryText,
      offsceneCharacterIds,
      // 线下会把这段记忆放到离生成点更近的连续时间线里，避免在通用记忆大块中被稀释。
      deferAnonymousLinkedMemory: true,
    });
    const contextSystemMessages = contextMessages.filter((message) => message?.role === 'system');
    const anonymousMemoryMode = getRegularAnonymousMemoryInjectMode(activeChat);
    const anonymousMemoryBlock = anonymousMemoryMode === 'off'
      ? ''
      : await buildAnonymousLinkedMemoryContext({
        chat: activeChat,
        user,
        characterIds: activeCharacterIds,
        characters,
        mode: anonymousMemoryMode,
      }).catch(() => '');
    const anonymousContinuityContext = buildOfflineAnonymousContinuityContext(
      anonymousMemoryBlock,
      anonymousMemoryMode,
    );
    // 跨模式时间线负责把本场开起来，不是长期剧情摘要。冷启动保留完整原文；
    // 前两轮留末段校准因果；之后通常交给本场 checkpoint + 最近原文。但若用户
    // 暂离现场又在线上继续了剧情，必须把新消息和对应摘要作为更晚的返场锚点。
    const transitionTimeline = buildOfflineTransitionContext({
      session,
      bridgeMessages,
      reentryMessages,
      bridgeSummaries,
      characters,
      beatIndex,
    });
    const offlineContinuityTimeline = [anonymousContinuityContext, transitionTimeline]
      .filter(Boolean)
      .join('\n\n');
    const { transcript, checkpointContext } = buildOfflineHistoryContext(generationSession);

    const wordMax = session.scene?.wordMax || 500;
    const optionCards = session.scene?.optionCards === true;
    const hasOpening = session.beats.some((b) => b.role === 'opening');
    const narrationEver = Math.max(Number(session.narrationEver || 0), beatIndex);
    const isColdStart = !revision && beatIndex === 0 && narrationEver === 0;
    const hasPriorNarration = revision ? beatIndex > 0 : narrationEver > 0;
    const prefsRow = chatId ? await dbGet(`chatPrefs_${chatId}`).catch(() => null) : null;
    const parallelWorld = userPresent && prefsRow?.value?.parallelWorldMode === true;
    // 普通线下不继承聊天窗“旁白音效”：那套配置面向聊天气泡，分类名进入叙事提示
    // 会诱导弱模型输出【水声】等舞台标签。只有音声线下读取素材，并走隐藏 stageSound。
    const rawSoundCategories = session.scene?.audioSceneEnabled === true
      && session.scene?.audioStageSoundEnabled !== false
      ? await listAvailableSoundAssetCategories({ ownerId: userId, includeSpecs: true }).catch(() => [])
      : [];
    const sharedBreathMode = combineBreathSupplementModes(activeCharacterIds.map((id) => (
      (characters[id]?.voiceProfile || characters[id]?.voice)?.breathSupplementMode
    )));
    // “额外呼吸素材”只控制音频库补足。所有在场角色都关闭时，生成提示和隐藏
    // stageSound 计划都不能再看见呼吸分类；多人场景则保留给仍允许的角色。
    const availableSoundCategories = filterBreathSoundCues(rawSoundCategories, sharedBreathMode);
    const [weatherLine, currentWorldNow, currentTimeZone] = await Promise.all([
      resolveOfflineWeatherLine({ chat: activeChat, user, session }).catch(() => ''),
      getNowForUser(userId).catch(() => Date.now()),
      getUserTimezone(userId).catch(() => ''),
    ]);
    const timeLabel = String(session.originSeed?.timeLabel || '').trim();
    const currentTimeLabel = formatPromptTimeLine(currentWorldNow, currentTimeZone);
    const characterStateActors = activeCharacterIds.map((id) => {
      const row = characters[id] || {};
      return {
        id,
        name: String(row.customNickname || row.name || row.realName || id).trim() || id,
        translationProfile: normalizeTranslationProfile(row.translationProfile),
      };
    });
    const previousCharacterStates = latestOfflineCharacterStates(generationSession, activeCharacterIds);
    const previousContinuityState = latestOfflineContinuityState(
      generationSession,
      buildOfflineContinuityFallback(session.scene, activeCharacterIds),
    );
    const globalVoiceConfig = session.scene?.ttsEnabled
      ? await loadVoiceToolConfig().catch(() => null)
      : null;
    const primaryVoiceProfile = characters[activeCharacterIds[0]]?.voiceProfile || {};
    const voiceConfig = globalVoiceConfig
      ? resolveVoiceToolConfigForProfile(globalVoiceConfig, primaryVoiceProfile)
      : null;
    const voiceInstruction = session.scene?.ttsEnabled
      ? buildNarrativeVoiceLinesInstruction(characterStateActors, {
        surface: VOICE_WORLD_BOOK_SURFACES.OFFLINE,
        provider: voiceConfig?.provider || 'minimax',
        customText: voiceConfig?.styleBook?.text || '',
        worldBookEnabled: voiceConfig?.styleBook?.enabled === true,
        audioStage: session.scene?.audioSceneEnabled === true,
        availableSoundCategories,
      })
      : '';
    const htmlExtensions = await resolveTriggeredHtmlExtensions([
      promptDirective,
      isColdStart ? session.scene?.openingLine : '',
    ].filter(Boolean).join('\n'), 'offline').catch(() => []);
    const activeCharacterSet = new Set(activeCharacterIds.map((id) => String(id)));
    const personaNearEndBlock = buildOfflinePersonaNearEndBlock(
      participantRows.filter((row) => activeCharacterSet.has(String(row?.id || ''))),
      { userPresent },
    );
    const prompt = [
      buildBeatPrompt({
      scene: session.scene,
      directive: promptDirective,
      isColdStart,
      hasOpening,
      hasPriorNarration,
      participantNames,
      beatIndex,
      rounds: session.scene?.rounds || 0,
      optionCards,
      translationSpeakers,
      lastEncounter: session.lastEncounter,
      parallelWorld,
      weatherLine,
      timeLabel,
      currentTimeLabel,
      directContinue: String(session.originSeed?.from || '') === 'direct',
      firstEncounter: session.firstEncounter === true,
      userPresent,
      phoneMessagesEnabled,
      phoneActionDirectory,
      pendingPhoneReplyInstruction: buildOfflinePendingPhoneReplyInstruction(generationSession),
      characterStateActors,
      personaNearEndBlock,
      worldBookRecallTail,
      previousCharacterStates,
      innerVoiceCard,
      previousContinuityState,
      htmlExtensions,
      voiceInstruction,
      userName: currentUserName,
      }),
      revisionPromptInstruction(revisionState, {
        includeCharacterStates: session.scene?.innerVoiceEnabled === true,
        includePhoneActions: phoneMessagesEnabled && !!phoneActionDirectory?.promptLines?.length,
      }),
      continuationPromptInstruction(continuationState, {
        includeCharacterStates: session.scene?.innerVoiceEnabled === true,
      }),
      editorialAuditRequested ? [
        '【本轮输出流程确认 · 编辑审稿已开启】',
        '完成 <<<END_THINKING>>> 后不得直接输出整篇正文。必须执行已注入的 <!-- editorial-audit: DRAFT: … AUDIT: … --> → Print 循环；每组先真实生成原稿并找茬，再输出该组定稿。',
        '正文末尾的状态、选项、心声等隐藏协议放在全部 Print 之后。若不返回可识别的 editorial-audit 注释，本轮视为未执行审稿。',
      ].join('\n') : '',
    ].filter(Boolean).join('\n\n');
    const recentHistoricalDirectives = [...(generationSession.beats || [])]
      .reverse()
      .filter((beat) => beat?.role === 'directive')
      .slice(0, 3)
      .map((beat) => String(beat.text || '').trim())
      .filter(Boolean);

    const apiOverride = await resolveSceneApiConfig().catch(() => null);
    const useStream = await resolveChatPreferStream(apiOverride);
    const canPreview = typeof onChunk === 'function';
    const narrationMaxTokens = await resolveNarrationMaxTokens(apiOverride);
    const supplementalAuditRoute = revisionState?.supplementalAudit === true
      ? await resolveTaskApiConfig('offlineEditorialAudit').catch(() => null)
      : null;
    const useToolForSupplementalAudit = supplementalAuditRoute?.apiSection === 'tool';
    const routedUseStream = useToolForSupplementalAudit
      ? supplementalAuditRoute?.config?.preferStream === true
      : useStream;
    const routedMaxTokens = useToolForSupplementalAudit
      ? Math.max(1, Math.floor(Number(supplementalAuditRoute?.config?.maxTokens) || narrationMaxTokens))
      : narrationMaxTokens;
    const blockSpeech = userPresent && session.scene?.blockUserSpeech !== false;
    const narrativeModeBlock = offlineInputModeRules(session.scene, participantNames, { userPresent });
    const narrationSystem = [
      isOfflineAudioExperience(session.scene) ? AUDIO_NARRATION_SYSTEM : NARRATION_SYSTEM,
      blockSpeech
        ? blockUserSpeechRules(session.scene?.person || 'second', { userName: currentUserName })
        : '',
      narrativeModeBlock,
    ].filter(Boolean).join('\n\n');
    const requestSamplingMarker = [
      '【本轮内部请求标记】',
      provisionalBeatId,
      '此标记没有剧情含义，不得在正文中输出或解释；它只用于区分本次模型采样。必须从当前时间线继续生成新的正文，不得返回上一轮正文副本。',
    ].join('\n');
    const streamChunk = (_piece, full) => {
      const cleaned = cleanOfflineStreamingNarration(full);
      const optionsStarted = String(full || '').includes(OPTIONS_START);
      const optionsComplete = optionsStarted && String(full || '').includes('<<<END_OPTIONS>>>');
      let streamedOptions = optionsStarted ? extractAdvanceOptions(full).options : [];
      if (
        optionsStarted
        && !String(full || '').includes('<<<END_OPTIONS>>>')
        && !String(full || '').endsWith('\n')
      ) {
        streamedOptions = streamedOptions.slice(0, -1);
      }
      if (generationIsCurrent()) {
        session.inFlight = {
          ...session.inFlight,
          status: 'streaming',
          partialText: cleaned,
          updatedAt: Date.now(),
        };
        void scheduleOfflineInFlightPersist(session);
      }
      if (canPreview) onChunk(cleaned, { options: streamedOptions, optionsStarted, optionsComplete });
    };
    const buildGenerationMessages = (promptSuffix = '') => [
      ...contextSystemMessages,
      { role: 'system', content: narrationSystem },
      ...(offlineContinuityTimeline ? [{ role: 'user', content: offlineContinuityTimeline }] : []),
      ...(checkpointContext ? [{ role: 'user', content: checkpointContext }] : []),
      ...transcript,
      {
        role: 'user',
        content: [prompt, promptSuffix].filter(Boolean).join('\n\n'),
      },
    ];
    const promptedThinkingExpected = [
      ...contextSystemMessages.map((message) => String(message?.content || '')),
      narrationSystem,
      prompt,
    ].some((content) => content.includes('<<<THINKING>>>'));
    let finishReason = '';
    let upstreamMeta = {};
    let requestStat = null;
    let lastReasoningPreview = '';
    let requestStartNotified = false;
    const auditOperation = revisionState?.supplementalAudit === true
      ? 'offlineEditorialAudit'
      : (revisionState?.expertConsultation === true
        ? 'offline-expert-revision'
        : (revisionState?.independentReroll === true
          ? 'offline-reroll'
          : (revisionState
            ? 'offline-guided-revision'
            : (continuationState ? 'offline-continuation' : 'offline-beat'))));
    const auditLogicalRoundId = `offline:${String(session.id || chatId || 'session')}:${provisionalBeatId}`;
    const runGenerationRequest = ({ tool = false } = {}) => {
      if (!requestStartNotified) {
        requestStartNotified = true;
        const requestStartedAt = Date.now();
        if (generationIsCurrent()) {
          session.inFlight = {
            ...session.inFlight,
            requestStartedAt,
            updatedAt: requestStartedAt,
          };
          void scheduleOfflineInFlightPersist(session);
        }
        if (typeof onRequestStart === 'function') {
          try { onRequestStart({ startedAt: requestStartedAt }); } catch (_) {}
        }
      }
      return chatWithEmptyFallback(
        tool
          ? ((requestMessages, requestOptions) => chatForTask(
            requestMessages,
            requestOptions,
            'offlineEditorialAudit',
          ))
          : apiChat,
        buildGenerationMessages(requestSamplingMarker), {
      maxTokens: tool ? routedMaxTokens : narrationMaxTokens,
      ...(!tool && apiOverride ? { configOverride: apiOverride } : {}),
      signal,
      onFinishReason: (reason) => { finishReason = String(reason || '').trim(); },
      onCompletionMeta: (meta) => {
        upstreamMeta = { ...upstreamMeta, ...(meta || {}) };
        const reasoningText = String(upstreamMeta.reasoningText || '');
        if (typeof onReasoning === 'function' && reasoningText && reasoningText !== lastReasoningPreview) {
          lastReasoningPreview = reasoningText;
          onReasoning(reasoningText);
        }
      },
      onRequestStat: (stat) => {
        requestStat = stat && typeof stat === 'object' ? { ...stat } : null;
      },
      // 线下需要严格尊重用户的流式开关。部分兼容线路在 MarshmallowHttp 的
      // 缓冲 SSE 通道中会以 200 空包结束，而同线路非流式 JSON 正常；这里退出
      // APK 的强制缓冲 SSE，避免 API 测试正常、线下却连续空回。
      auditContext: {
        operation: auditOperation,
        initiator: 'user',
        chatId,
        logicalRoundId: auditLogicalRoundId,
        actorIds: activeCharacterIds,
        actorNames: participantNames,
      },
      nativeBufferedStream: false,
      // 默认保留完整 system 与多轮 user / assistant 层级；若当前中转确实不接受
      // system，只由 API 设置中的兼容开关把 system 合并到首条 user。
      // 流式只显示正文，截掉文末的走向选项块/场景生图指令块
      ...((tool ? routedUseStream : useStream) ? {
        stream: true,
        ...(canPreview ? { onChunk: streamChunk } : {}),
      } : { stream: false }),
      });
    };
    const raw = await runGenerationRequest({ tool: useToolForSupplementalAudit });
    assertGenerationCurrent();

    if (promptedThinkingExpected && isIncompletePromptedThinkingPrefix(raw)) {
      const stat = requestStat || {};
      const truncatedError = new Error('模型输出在生成前检查标记的开头就截断了，本轮未保存；请重试或切换非流式请求。');
      truncatedError.reason = 'truncated-control-prefix';
      truncatedError.rawText = String(raw || '').slice(0, 8000);
      truncatedError.partialText = String(raw || '');
      truncatedError.finishReason = String(
        stat.finishReason || finishReason || upstreamMeta.finishReason || '',
      ).trim();
      truncatedError.upstreamMeta = upstreamMeta;
      truncatedError.streamStats = Object.keys(stat).length ? stat : null;
      truncatedError.correlationId = String(stat.correlationId || '');
      truncatedError.usedUrl = String(stat.usedUrl || '');
      truncatedError.requestModel = String(stat.model || upstreamMeta.requestModel || '');
      truncatedError.requestStream = stat.requestStream;
      throw truncatedError;
    }

    if (generationIsCurrent()) {
      session.inFlight = {
        ...session.inFlight,
        status: 'postprocess',
        partialText: cleanNarration(stripGenerationTail(raw)),
        updatedAt: Date.now(),
      };
      await scheduleOfflineInFlightPersist(session, { force: true });
    }

    const autoImage = session.scene?.autoImagePerBeat === true;
    const imagePromptRequested = autoImage
      || session.scene?.audioSceneEnabled === true
      || !!normalizeOfflineSceneImageGenMode(session.scene?.imageGenMode);
    const parseGeneratedResult = (generatedText) => {
      // 先提取提示词要求的可核验思维链回执，并剥离可能泄漏到 content 的原生
      // think/thinking，再碰任何线下协议。思考区可能预演一套未闭合的
      // CHARACTER_STATES / CONTINUITY / OPTIONS；若先找协议首尾，会跨过正式正文
      // 配到文末 END 标记，最终把整篇可见内容误删成空响应。
      const promptedThinking = extractPromptedThinkingBlock(generatedText);
      const visibleGeneratedText = promptedThinking.body;
      // 审稿注释里含有一份完整原稿，必须在对白、连续状态和动作协议解析之前取走，
      // 否则原稿对白会被当成正式正文重复合成语音或触发协议。
      const editorialResult = extractNarrationEditorialAudits(visibleGeneratedText);
      // 即使用户刚刚关闭逐轮摘要，也剥离模型沿用上一轮格式而多吐出的旧块，避免泄漏到正文。
      const digestResult = extractOfflineBeatDigest(editorialResult.body);
      const voiceResult = extractNarrativeVoiceLines(digestResult.body, {
        actors: characterStateActors,
        availableSoundCategories,
        fallbackQuotedDialogue: session.scene?.audioSceneEnabled === true,
        requireSpeechTags: session.scene?.audioSceneEnabled === true,
      });
      const continuityResult = extractOfflineContinuityState(voiceResult.body, {
        previousState: previousContinuityState,
        characterIds: activeCharacterIds,
        beatNumber: beatIndex + 1,
      });
      const htmlResult = extractOfflineHtmlExtensions(continuityResult.body, htmlExtensions, {
        name: participantNames[0] || '角色',
      });
      const stateResult = session.scene?.innerVoiceEnabled === true
        ? extractOfflineCharacterStates(htmlResult.body, {
          actors: characterStateActors,
          previousStates: previousCharacterStates,
          userName: currentUserName,
        })
        : { body: htmlResult.body, states: {} };
      const phoneResult = extractOfflinePhoneActions(stateResult.body);
      const imageResult = imagePromptRequested
        ? extractSceneImageDirective(phoneResult.body)
        : { body: phoneResult.body, imagePrompt: '' };
      const optionResult = optionCards
        ? extractAdvanceOptions(imageResult.body)
        : { body: imageResult.body, options: [] };
      const visibleNarration = cleanNarration(optionResult.body);
      const resolvedCharacterStates = session.scene?.naturalEnsemble === true
        ? filterNaturalEnsembleCharacterStates(stateResult.states, visibleNarration, 2)
        : (stateResult.states || {});
      const verifiedVoiceLines = alignNarrativeVoiceLinesToDialogueSpans(
        visibleNarration,
        voiceResult.lines || [],
        {
          actors: characterStateActors,
          allowBracketDialogue: session.scene?.audioSceneEnabled === true,
        },
      ).map((line) => {
        const { performanceDirection: _ignoredDirection, ...safeSpeechPlan } = line.speechPlan || {};
        return { ...line, speechPlan: safeSpeechPlan };
      });
      return {
        narration: visibleNarration,
        editorialAudits: editorialResult.audits || [],
        beatDigest: digestResult.digest,
        beatDigestStatus: digestResult.status,
        options: optionResult.options || [],
        aiImagePrompt: imageResult.imagePrompt || '',
        aiImageSubjectIds: imageResult.imageSubjectIds,
        promptedThinkingText: promptedThinking.thinkingText,
        promptedThinkingStatus: promptedThinking.status,
        phoneActionDirectives: phoneResult.actions || [],
        socialPostDirectives: phoneResult.socialPosts || [],
        phoneTakeoverDirectives: (phoneResult.takeovers || []).filter((action) => (
          phoneActionDirectory?.takeoverEnabled === true
          && action.proxyCharacterId === phoneActionDirectory.takeoverProxyId
          && phoneActionDirectory.takeoverTargetIds?.has(action.targetCharacterId)
        )).slice(0, 1),
        characterStates: resolvedCharacterStates,
        continuityState: continuityResult.state || previousContinuityState,
        continuityPatch: continuityResult.patch || {},
        htmlWidgets: htmlResult.widgets || [],
        voiceLines: verifiedVoiceLines,
        stageSound: voiceResult.stageSound || { background: [], cues: [] },
      };
    };
    let generated = parseGeneratedResult(raw);
    // 必选组件缺失时保留正文与缺失状态；不得在正文请求后静默追加修复调用。
    assertGenerationCurrent();
    let narration = generated.narration;
    let recoveredFromReasoning = false;
    if (!narration) {
      const recoveredRaw = recoverNarrationFromReasoning(upstreamMeta.reasoningText);
      if (recoveredRaw) {
        const recoveredGenerated = parseGeneratedResult(recoveredRaw);
        if (recoveredGenerated.narration) {
          generated = recoveredGenerated;
          narration = recoveredGenerated.narration;
          recoveredFromReasoning = true;
          if (generationIsCurrent()) {
            session.inFlight = {
              ...session.inFlight,
              partialText: narration,
              updatedAt: Date.now(),
            };
          }
          void appendDebugEvent({
            type: 'offline_reasoning_content_recovered',
            level: 'info',
            message: '线下正文从上游推理字段中的成稿段恢复',
            context: {
              sessionId: session.id,
              beatIndex: beatIndex + 1,
              recoveredLength: narration.length,
              finishReason: String(finishReason || upstreamMeta.finishReason || ''),
              requestModel: String(requestStat?.model || upstreamMeta.requestModel || ''),
            },
          });
        }
      }
    }
    const staleReplay = detectOfflineStaleDirectiveReplay({
      narration,
      currentDirective: promptDirective,
      previousDirectives: recentHistoricalDirectives,
    });
    if (narration && !continuation && staleReplay.stale) {
      void appendDebugEvent({
        type: 'offline_stale_directive_detected',
        level: 'warn',
        message: '线下正文疑似复读历史方向；已拦截且未自动重试',
        context: {
          sessionId: session.id,
          beatIndex: beatIndex + 1,
          matchedHistoricalFragment: staleReplay.matchedHistoricalFragment,
        },
      });
      delete session.inFlight;
      await saveOfflineSession(session).catch(() => {});
      const staleError = new Error('模型回应了更早一轮，本次错误结果未保存；请补充本轮方向后重试');
      staleError.reason = 'stale-directive-replay';
      throw staleError;
    }
    if (!narration) {
      const stat = requestStat || {};
      const resolvedFinishReason = String(stat.finishReason || finishReason || upstreamMeta.finishReason || '').trim();
      const reasoningText = String(upstreamMeta.reasoningText || '').trim();
      const reasoningLength = Number(stat.reasoningLength || reasoningText.length || 0);
      const reasoningTokens = Number(stat.reasoningTokens || upstreamMeta.reasoningTokens || 0);
      const rawResponsePresent = Boolean(String(raw || '').trim());
      const visibleAfterThinking = sanitizeNarrationOutput(raw);
      const filteredEmpty = rawResponsePresent && Boolean(visibleAfterThinking);
      const reasoningOnly = !filteredEmpty && (
        stat.errorKind === 'reasoning_only'
        || reasoningLength > 0
        || reasoningTokens > 0
      );
      const completed = stat.sawDone === true || Boolean(resolvedFinishReason);
      const message = reasoningOnly
        ? (resolvedFinishReason === 'length'
          ? '上游推理占满了本轮输出额度，没有返回可显示的正文'
          : (reasoningText
            ? '上游只返回了推理内容，没有返回可显示的正文'
            : '上游只上报了推理 token 用量，没有返回推理原文或可显示的正文'))
        : (filteredEmpty
          ? '上游返回了内容，但清除隐藏块与文末协议后没有剩余正文'
          : (completed
            ? '接口已正常结束本轮响应，但正文 content 为空'
            : '本轮未生成可显示正文，请重试'));
      const emptyError = new Error(message);
      emptyError.reason = resolvedFinishReason === 'length'
        ? 'length-truncated'
        : 'empty-api-response';
      emptyError.rawText = String(raw || '').slice(0, 8000);
      emptyError.emptyKind = reasoningOnly
        ? 'reasoning-only'
        : (filteredEmpty ? 'filtered-empty' : (completed ? 'completed-empty' : 'unknown-empty'));
      emptyError.finishReason = resolvedFinishReason;
      emptyError.upstreamMeta = upstreamMeta;
      if (reasoningText) emptyError.reasoningText = reasoningText;
      emptyError.streamStats = Object.keys(stat).length ? stat : null;
      emptyError.correlationId = String(stat.correlationId || '');
      emptyError.usedUrl = String(stat.usedUrl || '');
      emptyError.requestModel = String(stat.model || upstreamMeta.requestModel || '');
      emptyError.requestStream = stat.requestStream;
      emptyError.status = Number(stat.status || 0) || undefined;
      throw emptyError;
    }
    if (revisionState?.supplementalAudit === true) {
      const remainingAuditHits = collectNarrationSupplementalAuditHits(narration);
      if (remainingAuditHits.length) {
        delete session.inFlight;
        await saveOfflineSession(session).catch(() => {});
        const preview = remainingAuditHits.slice(0, 4).map((hit) => `『${hit.value}』`).join('、');
        const auditError = new Error(`补审后的新稿仍漏掉 ${remainingAuditHits.length} 处硬命中：${preview}；旧稿未替换，请再次补审或改用指导重修`);
        auditError.reason = 'supplemental-audit-failed';
        auditError.rawText = narration.slice(0, 8000);
        throw auditError;
      }
    }
    const permanentContext = {
      surface: 'offline',
      placement: 2,
      depth: 0,
      macros: { user: user?.name || '用户', char: characterStateActors[0]?.name || '角色' },
    };
    narration = applyPermanentRegex(narration, permanentContext);
    if (promptedThinkingExpected && isIncompletePromptedThinkingPrefix(narration)) {
      const regexError = new Error('正文被角色消息正则处理成了残缺的生成前检查标记，本轮未保存；请检查线下沉浸正则。');
      regexError.reason = 'regex-truncated-control-prefix';
      regexError.rawText = String(raw || '').slice(0, 8000);
      throw regexError;
    }
    // 语音轨最初按正则处理前的正文提取。永久正则若改到了对白文本，必须把
    // 可见台词与隐藏 speech 文本同步处理并重新对齐，否则画面仍能识别对白，
    // TTS 前的二次校验却会把整条语音轨过滤掉。
    const regexAdjustedVoiceLines = (Array.isArray(generated.voiceLines) ? generated.voiceLines : [])
      .map((line) => {
        const text = applyPermanentRegex(line?.text || '', permanentContext);
        const speechPlan = line?.speechPlan && typeof line.speechPlan === 'object'
          ? {
            ...line.speechPlan,
            text: applyPermanentRegex(line.speechPlan.text || line?.text || '', permanentContext),
          }
          : line?.speechPlan;
        return { ...line, text, speechPlan };
      });
    generated.voiceLines = alignNarrativeVoiceLinesToDialogueSpans(
      narration,
      regexAdjustedVoiceLines,
      {
        actors: characterStateActors,
        allowBracketDialogue: session.scene?.audioSceneEnabled === true,
      },
    );
    generated.characterStates = Object.fromEntries(
      Object.entries(generated.characterStates || {}).map(([id, state]) => [
        id,
        {
          ...state,
          inner: applyPermanentRegex(state?.inner, permanentContext),
          intent: applyPermanentRegex(state?.intent, permanentContext),
          mood: applyPermanentRegex(state?.mood, permanentContext),
          status: applyPermanentRegex(state?.status, permanentContext),
        },
      ]),
    );
    const {
      options,
      aiImagePrompt,
      aiImageSubjectIds,
      promptedThinkingText,
      promptedThinkingStatus,
      phoneActionDirectives,
      socialPostDirectives,
      phoneTakeoverDirectives,
      characterStates,
      editorialAudits,
      beatDigest,
      beatDigestStatus,
      continuityState,
      continuityPatch,
      htmlWidgets,
      voiceLines,
      stageSound,
    } = generated;
    if (phoneMessagesEnabled
      && revisionNeedsPhoneActionProtocol(revisionState)
      && !phoneActionDirectives.length) {
      const protocolError = new Error('重修稿没有返回真实手机动作，旧稿未替换；请重试指导重修');
      protocolError.reason = 'offline-revision-phone-action-missing';
      protocolError.rawText = narration.slice(0, 8000);
      throw protocolError;
    }
    if (canPreview && (!useStream || recoveredFromReasoning)) {
      onChunk(narration, {
        options,
        optionsStarted: Array.isArray(options) && options.length > 0,
      });
    }

    const ts = await getNowForUser(userId);
    if (trimmedDirective && !revision && !continuation) {
      session.beats.push({ id: genId(), role: 'directive', text: trimmedDirective, ts });
    }
    const beat = {
      id: revisionTarget?.beat?.id || continuationTarget?.beat?.id || provisionalBeatId,
      role: 'narration',
      text: narration,
      ts: revisionTarget?.beat?.ts || continuationTarget?.beat?.ts || ts,
      createdAtReal: revisionTarget?.beat?.createdAtReal
        || continuationTarget?.beat?.createdAtReal
        || Number(session.inFlight?.startedAt || 0)
        || Date.now(),
      options,
    };
    if (session.scene?.audioSceneEnabled === true) beat.voiceLineFormat = 'speech_tags_v1';
    beat.naturalEnsemble = session.scene?.naturalEnsemble === true;
    const nativeReasoningText = String(upstreamMeta.reasoningText || '').trim();
    const returnedThinkingText = String(promptedThinkingText || '').trim();
    const reasoningText = returnedThinkingText
      ? `【生成前检查】\n${returnedThinkingText}${nativeReasoningText ? `\n\n【模型原生思考】\n${nativeReasoningText}` : ''}`
      : nativeReasoningText;
    beat.thinkingStatus = returnedThinkingText
      ? (promptedThinkingStatus === 'complete' ? 'complete' : promptedThinkingStatus)
      : (promptedThinkingExpected
        ? (nativeReasoningText ? 'native-only' : 'missing')
        : (nativeReasoningText ? 'native-only' : ''));
    if (reasoningText) {
      const maxReasoningChars = 24000;
      beat.reasoningText = reasoningText.length > maxReasoningChars
        ? `（较早的思考内容已省略）\n${reasoningText.slice(-maxReasoningChars)}`
        : reasoningText;
    }
    if (recoveredFromReasoning) beat.recoveredFromReasoning = true;
    if (Object.keys(characterStates).length) beat.characterStates = characterStates;
    beat.editorialAuditRequested = editorialAuditRequested;
    if (Array.isArray(editorialAudits) && editorialAudits.length) beat.editorialAudits = editorialAudits;
    if (beatDigest) beat.digest = beatDigest;
    if (session.scene?.perBeatDigestEnabled === true) beat.digestStatus = beatDigestStatus || 'missing';
    if (phoneMessagesEnabled && phoneTakeoverDirectives.length) {
      beat.phoneTakeover = {
        ...phoneTakeoverDirectives[0],
        status: 'pending',
        requestedAt: Date.now(),
      };
    }
    if (continuityPatch && Object.keys(continuityPatch).length) {
      beat.continuityPatch = continuityPatch;
    }
    if (htmlWidgets.length) beat.htmlWidgets = htmlWidgets;
    if (voiceLines.length) beat.voiceLines = voiceLines;
    if (session.scene?.ttsEnabled && voiceLines.length) {
      beat.voiceSynthesis = {
        requested: voiceLines.length,
        completed: 0,
        failed: 0,
        pending: true,
      };
    }
    if (stageSound?.background?.length || stageSound?.cues?.length) beat.stageSound = stageSound;
    if (aiImagePrompt) beat.aiImagePrompt = aiImagePrompt;
    if (Array.isArray(aiImageSubjectIds)) beat.aiImageSubjectIds = aiImageSubjectIds;
    const resolvedFinishReason = String(
      requestStat?.finishReason || finishReason || upstreamMeta.finishReason || '',
    ).trim();
    if (resolvedFinishReason === 'length') {
      beat.continuationPending = true;
      beat.continuationReason = 'length';
    }
    assertGenerationCurrent();
    if (!revision && !continuation) {
      session.beats.push(beat);
      const consumedBridgeAt = transitionBridgeMessages.reduce(
        (max, message) => Math.max(max, offlineMessageCreatedAtReal(message)),
        Number(session.onlineBridgeConsumedAtReal || 0),
      );
      if (consumedBridgeAt > 0) session.onlineBridgeConsumedAtReal = consumedBridgeAt;
    }

    // 正文已经从模型完整返回。先结束视觉上的流式状态；落库、语音、生图、摘要与
    // 手机动作仍可继续收尾，且这些步骤的耗时不应随着楼层增长继续拖着光标闪烁。
    if (typeof onBeatReady === 'function') onBeatReady(beat, { phase: 'text' });

    // 正文先落库，再开始可能持续很久的生图 / 语音附加任务。尤其 NAI 大图在
    // APK 中下载、压缩较慢；如果此时 WebView 被回收，重进线下仍应立即看到正文。
    if (!revision && !continuation) {
      if (generationIsCurrent()) {
        session.inFlight = {
          ...session.inFlight,
          status: 'media',
          partialText: narration,
          updatedAt: Date.now(),
        };
      }
      await saveOfflineSession(session).catch((err) => {
        console.warn('[offline-session] narration checkpoint save failed', err);
      });
      assertGenerationCurrent();
      // 舞台正文已经是可恢复的正式 beat；不要再让生图、TTS、摘要和手机动作
      // 阻塞首屏分段。媒体完成后会用 complete 阶段刷新同一个 beat。
      if (typeof onBeatReady === 'function') onBeatReady(beat, { phase: 'content' });
    }

    // 音声舞台优先让角色语音就位。旧顺序会先等待整张图生成，再逐句开始 TTS，
    // 导致字幕和环境音已经走完整幕，角色语音才回来。
    if (session.scene?.ttsEnabled && voiceLines.length) {
      await maybeAttachOfflineBeatVoice(beat, chat, session, {
        signal,
        onProgress: () => {
          if (!revision && typeof onBeatReady === 'function') {
            onBeatReady(beat, { phase: 'voice-progress' });
          }
        },
      }).catch((error) => {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        beat.voiceSynthesis = {
          requested: voiceLines.length,
          completed: 0,
          failed: voiceLines.length,
          pending: false,
          reason: 'synthesis_failed',
        };
      });
      assertGenerationCurrent();
      if (!revision) {
        await saveOfflineSession(session).catch((err) => {
          console.warn('[offline-session] voice checkpoint save failed', err);
        });
        assertGenerationCurrent();
        if (typeof onBeatReady === 'function') onBeatReady(beat, { phase: 'voice', mediaPending: autoImage });
      }
    }

    if (signal?.aborted) {
      const abortError = new Error('用户已终止线下输出');
      abortError.name = 'AbortError';
      throw abortError;
    }

    if (autoImage) {
      const activeImageCharacterIds = getActiveOfflineParticipantIds(session, chat);
      const availableImageSubjectIds = ['user', ...activeImageCharacterIds];
      const imageSubjectIds = Array.isArray(aiImageSubjectIds)
        ? aiImageSubjectIds.filter((id) => availableImageSubjectIds.includes(id))
        : availableImageSubjectIds;
      const imagePromptArgs = {
        scene: session.scene,
        beatText: narration,
        styleId: session.scene?.imageStyleId,
        aiPrompt: aiImagePrompt,
        subjectCount: imageSubjectIds.length,
        imageGenMode: session.scene?.imageGenMode,
      };
      const imgPrompt = buildOfflineScenePrompt(imagePromptArgs);
      const novelAiPrompt = buildOfflineScenePrompt({ ...imagePromptArgs, imageGenMode: 'novelai' });
      const result = await maybeGenerateOfflineSceneImage({
        prompt: imgPrompt,
        novelAiPrompt,
        subjectIds: imageSubjectIds,
        user,
        imageGenMode: session.scene?.imageGenMode,
        aspect: session.scene?.audioSceneLayout || 'portrait',
        signal,
      }).catch((err) => ({
        image: '',
        prompt: imgPrompt,
        error: String(err?.message || err || '场景生图失败').slice(0, 160),
      }));
      if (result?.image) {
        beat.image = {
          url: result.image,
          prompt: result.prompt,
          styleId: session.scene?.imageStyleId || '',
          provider: String(result.provider || ''),
          generatedAt: Date.now(),
          ...(result.referenceSkipped ? {
            referenceSkipped: true,
            warning: '参考图锁定未生效，已改用文字外观生成',
          } : {}),
          ...(result.referenceSubjectIds?.length ? {
            referenceSubjectIds: result.referenceSubjectIds,
            referenceSubmittedCount: result.referenceSubmittedCount,
            referenceSubmittedSubjectIds: result.referenceSubmittedSubjectIds || [],
          } : {}),
        };
      } else if (result?.error || result?.prompt) {
        // 自动生图失败时留下可重试线索，避免静默吞错后界面像「线下生图坏了」
        beat.image = {
          url: '',
          prompt: result?.prompt || imgPrompt,
          styleId: session.scene?.imageStyleId || '',
          error: String(result?.error || '场景生图失败').slice(0, 160),
        };
      }
    }

    if (signal?.aborted) {
      const abortError = new Error('用户已终止线下输出');
      abortError.name = 'AbortError';
      throw abortError;
    }
    assertGenerationCurrent();
    if (revisionTarget) {
      const latestTarget = lastRevisableNarration(session);
      if (!latestTarget || latestTarget.beat.id !== revisionTarget.beat.id) {
        throw new Error('重修期间末层已变化，旧稿未被替换');
      }
      const originalBeat = revisionBeatSnapshot(latestTarget.beat);
      const checkpointsBefore = cloneRevisionValue(session.checkpointSummaries || []);
      revisionRollback = {
        index: latestTarget.index,
        beat: originalBeat,
        checkpoints: checkpointsBefore,
        checkpointRollup: cloneRevisionValue(session.checkpointRollup || null),
        revisions: cloneRevisionValue(session.revisions || []),
        rerollVersions: cloneRevisionValue(session.rerollVersions || {}),
        continuityState: cloneRevisionValue(session.continuityState || null),
      };
      const applied = applyLastOfflineRevision(session, {
        beatId: beat.id,
        newBeat: beat,
        requirement: revisionRequirement,
      });
      if (!applied.ok) throw new Error('末层版本已变化，旧稿未被替换');
      Object.assign(beat, applied.beat);
      await maybeCreateOfflineCheckpointSummary(session, { signal });
      assertGenerationCurrent();
      applied.revision.checkpointSummariesAfter = cloneRevisionValue(session.checkpointSummaries || []);
      syncActiveOfflineRerollVersion(session, applied.beat.id);
    } else if (continuationTarget) {
      const latestTarget = lastRevisableNarration(session);
      if (!latestTarget || latestTarget.beat.id !== continuationTarget.beat.id) {
        throw new Error('续写期间末层已变化，续写内容未拼接');
      }
      revisionRollback = {
        index: latestTarget.index,
        beat: revisionBeatSnapshot(latestTarget.beat),
        checkpoints: cloneRevisionValue(session.checkpointSummaries || []),
        checkpointRollup: cloneRevisionValue(session.checkpointRollup || null),
        revisions: cloneRevisionValue(session.revisions || []),
        continuityState: cloneRevisionValue(session.continuityState || null),
      };
      const applied = applyLastOfflineContinuation(session, {
        beatId: beat.id,
        continuationBeat: beat,
        pending: beat.continuationPending === true,
        reason: beat.continuationReason || resolvedFinishReason,
      });
      if (!applied.ok) throw new Error('末层版本已变化，续写内容未拼接');
      Object.assign(beat, applied.beat);
      await maybeCreateOfflineCheckpointSummary(session, { signal });
      assertGenerationCurrent();
    } else {
      await maybeCreateOfflineCheckpointSummary(session, { signal });
      assertGenerationCurrent();
    }
    session.continuityState = continuityState;
    if (signal?.aborted) {
      const abortError = new Error('用户已终止线下输出');
      abortError.name = 'AbortError';
      throw abortError;
    }
    session.narrationEver = Math.max(Number(session.narrationEver || 0), session.beats.filter((b) => b.role === 'narration').length);
    if (continuationTarget && (phoneActionDirectives.length || socialPostDirectives.length)) {
      beat.phoneActionDispatchBeatId = `${beat.id}_continuation_${Date.now().toString(36)}`;
    }
    if (phoneMessagesEnabled && phoneActionDirectives.length) {
      stageOfflinePhoneActionOutbox(beat, phoneActionDirectives);
      const stagedBeat = (revisionTarget || continuationTarget)
        ? session.beats.find((row) => row?.role === 'narration' && row.id === beat.id)
        : beat;
      if (stagedBeat && stagedBeat !== beat) {
        stagedBeat.phoneActionOutbox = beat.phoneActionOutbox;
        stagedBeat.phoneActionDispatchBeatId = beat.phoneActionDispatchBeatId;
      }
    }
    if (phoneMessagesEnabled && socialPostDirectives.length) {
      beat.socialPostOutbox = socialPostDirectives;
      const stagedBeat = (revisionTarget || continuationTarget)
        ? session.beats.find((row) => row?.role === 'narration' && row.id === beat.id)
        : beat;
      if (stagedBeat && stagedBeat !== beat) {
        stagedBeat.socialPostOutbox = socialPostDirectives;
        stagedBeat.phoneActionDispatchBeatId = beat.phoneActionDispatchBeatId;
      }
    }
    assertGenerationCurrent();
    // 先把完整 beat 与 inFlight 一起提交。只有成功后才清掉恢复标记，避免
    // 图片/存储异常发生在最后一步时把已经生成的正文一并判作失败。
    await saveOfflineSession(session);
    assertGenerationCurrent();
    delete session.inFlight;
    await saveOfflineSession(session).catch((err) => {
      console.warn('[offline-session] completed inFlight cleanup save failed', err);
    });
    // 正文若明确写成“消息已发送”，对应聊天记录必须先耐久写入，才能把这一幕
    // 交给前台。否则用户立刻点进聊天时，首屏读取会抢在后台派发前面，形成偶发缺消息。
    let releasePhoneDispatchBarrier = () => {};
    const phoneDispatchBarrier = new Promise((resolve) => {
      releasePhoneDispatchBarrier = resolve;
    });
    revisionRollback = null;
    const finishCommittedSideEffects = async () => {
    if (revisionTarget?.beat) {
      await rollbackOfflinePhoneActionsForBeat(revisionTarget.beat, session.id).catch(() => {});
    }
    const phoneResult = phoneMessagesEnabled
      ? await dispatchOfflinePhoneActions({
        actions: pendingOfflinePhoneActionOutbox(beat),
        directory: phoneActionDirectory,
        userId,
        sessionId: session.id,
        beatId: beat.phoneActionDispatchBeatId || beat.id,
        timestamp: beat.ts,
      })
      : { actions: [], notices: [], receipts: [] };
    // saveMessage 与会话 preview 都已完成；现在进入聊天不会再读到派发前的旧首屏。
    releasePhoneDispatchBarrier();
    const activeScheduleNow = await getNowForUser(String(userId || session.userId || '').trim())
      .catch(() => Number(session.startedAtWorld || Date.now()));
    for (const characterId of getActiveOfflineParticipantIds(session, chat)) {
      await applyOfflineActiveScheduleOverride({
        userId: session.userId,
        characterId,
        startTs: Number(session.startedAtWorld || session.createdAt || activeScheduleNow),
        endTs: activeScheduleNow,
        place: session.scene?.place || '',
        activity: session.scene?.goal || (userPresent ? '' : '角色线下同行'),
        sourceId: session.id,
      }).catch(() => {});
    }
    const socialPostResult = phoneMessagesEnabled
      ? await dispatchOfflineSocialPosts({
        posts: socialPostDirectives,
        directory: phoneActionDirectory,
        user,
        userId,
        sessionId: session.id,
        beatId: beat.phoneActionDispatchBeatId || beat.id,
        recentMessages: messages,
      })
      : { actions: [], notices: [] };
    const committedBeat = (revisionTarget || continuationTarget)
      ? session.beats.find((row) => row?.role === 'narration' && row.id === beat.id)
      : beat;
    if (committedBeat) {
      const previousPhoneActions = continuationTarget && Array.isArray(committedBeat.phoneActions)
        ? committedBeat.phoneActions
        : [];
      const previousSocialActions = continuationTarget && Array.isArray(committedBeat.socialPostActions)
        ? committedBeat.socialPostActions
        : [];
      const previousSocialNotices = continuationTarget && Array.isArray(committedBeat.socialPostNotices)
        ? committedBeat.socialPostNotices
        : [];
      const previousPhoneNotices = continuationTarget && Array.isArray(committedBeat.phoneActionNotices)
        ? committedBeat.phoneActionNotices
        : [];
      committedBeat.phoneActions = [
        ...previousPhoneActions,
        ...(phoneResult.actions || []).filter((action) => !previousPhoneActions.some((row) => row?.messageId === action?.messageId)),
      ];
      committedBeat.socialPostActions = [
        ...previousSocialActions,
        ...(socialPostResult.actions || []).filter((action) => !previousSocialActions.some((row) => row?.postId === action?.postId)),
      ];
      committedBeat.socialPostNotices = [...previousSocialNotices, ...(socialPostResult.notices || [])];
      committedBeat.socialPostOutbox = Array.isArray(socialPostResult.pending) ? socialPostResult.pending : [];
      committedBeat.phoneActionNotices = [
        ...previousPhoneNotices,
        ...(phoneResult.notices || []),
        ...(socialPostResult.notices || []),
      ];
      if (phoneActionDirectives.length) applyOfflinePhoneActionReceipts(committedBeat, phoneResult);
      beat.phoneActions = committedBeat.phoneActions;
      beat.socialPostActions = committedBeat.socialPostActions;
      beat.socialPostNotices = committedBeat.socialPostNotices;
      beat.socialPostOutbox = committedBeat.socialPostOutbox;
      beat.phoneActionNotices = committedBeat.phoneActionNotices;
      if (phoneActionDirectives.length) {
        beat.phoneActionOutbox = committedBeat.phoneActionOutbox;
        beat.phoneActionReceipt = committedBeat.phoneActionReceipt;
      }
    }
    if (phoneActionDirectives.length || socialPostDirectives.length) {
      await saveOfflineSession(session).catch((err) => {
        console.warn('[offline-session] phone action metadata save failed', err);
        void appendDebugEvent({
          type: 'offline_phone_outbox_receipt_save_error',
          level: 'error',
          error: err,
          context: { sessionId: session.id, beatId: beat.id },
        });
      });
      if (typeof window !== 'undefined' && socialPostDirectives.length) {
        window.dispatchEvent(new CustomEvent('marshmallow-offline-social-post-state', {
          detail: { sessionId: session.id, beatId: beat.id },
        }));
      }
      if ((phoneResult.receipts || []).some((receipt) => receipt.status !== 'saved')) {
        await appendDebugEvent({
          type: 'offline_phone_action_persist_partial',
          level: 'warn',
          message: '线下手机动作未全部落库',
          context: { sessionId: session.id, beatId: beat.id, receipts: phoneResult.receipts },
        });
      }
    }
    if (revisionTarget && session.scene?.retainRerollVersions === true) {
      syncActiveOfflineRerollVersion(session, committedBeat?.id || beat.id);
      await saveOfflineSession(session).catch(() => {});
    }
    };
    const committedSideEffectsPromise = finishCommittedSideEffects();
    void committedSideEffectsPromise.catch((error) => {
      // 派发前若发生意外，也必须释放等待；outbox 会在下一次推进时继续恢复。
      releasePhoneDispatchBarrier();
      console.warn('[offline-session] committed side effects failed', error);
      void appendDebugEvent({
        type: 'offline_committed_side_effect_error',
        level: 'warn',
        error,
        context: { sessionId: session.id, beatId: beat.id },
      });
    });
    if (phoneMessagesEnabled && phoneActionDirectives.length) {
      await phoneDispatchBarrier;
    }
    // 图片与语音已就绪，明确发送的手机消息也已落库；日程和朋友圈仍可在后台收尾。
    if (typeof onBeatReady === 'function') onBeatReady(beat, { phase: 'complete' });
    return beat;
  } catch (err) {
    if (err && typeof err === 'object' && !err.offlineGenerationBeatId) {
      err.offlineGenerationBeatId = provisionalBeatId;
    }
    if (revisionRollback) {
      session.beats.splice(revisionRollback.index, 1, revisionRollback.beat);
      session.checkpointSummaries = revisionRollback.checkpoints;
      session.checkpointRollup = revisionRollback.checkpointRollup || null;
      session.revisions = revisionRollback.revisions;
      if (Object.prototype.hasOwnProperty.call(revisionRollback, 'rerollVersions')) {
        session.rerollVersions = revisionRollback.rerollVersions;
      }
      if (revisionRollback.continuityState) session.continuityState = revisionRollback.continuityState;
      else rebuildOfflineContinuityState(session);
    }
    if (generationIsCurrent()) {
    const errorPartial = cleanNarration(stripGenerationTail(String(err?.partialText || '')));
      const savedPartial = String(session.inFlight.partialText || '');
      session.inFlight = {
        ...session.inFlight,
        status: 'interrupted',
        // The stream error may contain a final parsed fragment that the debounced
        // page checkpoint has not persisted yet. Keep whichever copy is longer.
        partialText: errorPartial.length > savedPartial.length ? errorPartial : savedPartial,
        interruptionReason: String(
          err?.reason || (signal?.aborted ? 'aborted' : '') || err?.name || 'interrupted',
        ).trim(),
        finishReason: String(err?.finishReason || '').trim(),
        updatedAt: Date.now(),
      };
      await scheduleOfflineInFlightPersist(session, { force: true });
    }
    if (err && typeof err === 'object' && !err.reason) {
      if (err.timeoutStage || err.abortReason === 'watchdog') err.reason = 'client-timeout';
      else if (/未生成内容|空回/i.test(String(err.message || ''))) err.reason = 'empty-api-response';
      else if (String(err.finishReason || '') === 'length') err.reason = 'length-truncated';
    }
    throw err;
  }
  } finally {
    await generationLease.release();
  }
}

/** 只合成本轮结构化角色对白；旁白、动作、心理与用户台词永远不送入 TTS。 */
async function maybeAttachOfflineBeatVoice(beat, chat, session = null, { onProgress = null, signal = null } = {}) {
  const sourceLines = Array.isArray(beat?.voiceLines) ? beat.voiceLines : [];
  const actors = sourceLines
    .map((line) => ({ id: line?.actorId, name: line?.actorName }))
    .filter((actor) => actor.id && actor.name);
  const lines = alignNarrativeVoiceLinesToDialogueSpans(beat?.text || '', sourceLines, {
    actors,
    // 音声舞台前台允许模型偶发使用 [台词]；TTS 二次校验必须使用同一规则，
    // 否则会出现“对白分段正常、语音条却消失”。
    allowBracketDialogue: session?.scene?.audioSceneEnabled === true,
  })
    .map((line) => {
      const { performanceDirection: _ignoredDirection, ...safeSpeechPlan } = line.speechPlan || {};
      return { ...line, speechPlan: safeSpeechPlan };
    });
  beat.voiceLines = lines;
  if (!lines.length) {
    beat.voiceSynthesis = {
      requested: 0,
      completed: 0,
      failed: 0,
      pending: false,
      reason: sourceLines.length ? 'no_verified_dialogue' : '',
    };
    return;
  }
  const globalCfg = await loadVoiceToolConfig().catch(() => null);
  if (!globalCfg) {
    beat.voiceSynthesis = {
      requested: lines.length,
      completed: 0,
      failed: lines.length,
      pending: false,
      reason: 'not_configured',
    };
    return;
  }
  const resolvedLines = [];
  let completed = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (signal?.aborted) {
      const abortError = new Error('用户已终止线下语音合成');
      abortError.name = 'AbortError';
      throw abortError;
    }
    const line = lines[lineIndex];
    const characterId = String(line?.actorId || '').trim();
    // 和聊天语音共用同一条声线读取入口。这里原先先经过 character-store，
    // 再把取不到时生成的空对象当作显式 override 传给 synthesizeVoice；这样会
    // 阻止语音层按 characterId 自行读取真实声线，表现为其它页面能发声、音声
    // 线下却整幕全部失败。直接读取规范化声线也兼容匿名主播等特殊 actorId。
    const baseProfile = characterId
      ? await loadCharacterVoiceProfile(characterId).catch(() => ({}))
      : {};
    const resolvedCfg = resolveVoiceToolConfigForProfile(globalCfg, baseProfile);
    const cfg = resolvedCfg;
    const voiceProfileOverride = buildVoiceSpeechProfileOverride(
      baseProfile,
      line.speechPlan,
      cfg,
    ) || baseProfile;
    const text = stripTranslationMarks(line?.speechPlan?.text || line?.text || '');
    if (!text) {
      resolvedLines.push(line);
      beat.voiceLines = [...resolvedLines, ...lines.slice(lineIndex + 1)];
      beat.voiceSynthesis = {
        requested: lines.length,
        completed,
        failed: Math.max(0, resolvedLines.length - completed),
        pending: lineIndex < lines.length - 1,
      };
      onProgress?.(beat.voiceSynthesis);
      continue;
    }
    const audio = await synthesizeVoice({
      text,
      characterId,
      config: cfg,
      voiceProfileOverride,
      signal,
    }).catch((error) => {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      console.warn('[offline-session] beat voice synthesis failed', {
        beatId: beat?.id,
        characterId,
        provider: cfg.provider,
        error,
      });
      void appendDebugEvent({
        type: 'offline_voice_synthesis_error',
        level: 'warn',
        error,
        context: {
          sessionId: session?.id || '',
          beatId: beat?.id || '',
          characterId,
          provider: cfg.provider,
          textLength: text.length,
        },
      });
      return null;
    });
    if (!audio?.audioDataUrl) {
      // 保留可见对白及角色归属；舞台可以继续以静音文字段播放，而不是在部分
      // TTS 失败时把整句从 voiceLines 中丢掉。
      resolvedLines.push(line);
      beat.voiceLines = [...resolvedLines, ...lines.slice(lineIndex + 1)];
      beat.voiceSynthesis = {
        requested: lines.length,
        completed,
        failed: Math.max(0, resolvedLines.length - completed),
        pending: lineIndex < lines.length - 1,
      };
      onProgress?.(beat.voiceSynthesis);
      continue;
    }
    completed += 1;
    resolvedLines.push({
      ...line,
      audio: {
        dataUrl: audio.audioDataUrl,
        mimeType: audio.mimeType || audio.audioMimeType || '',
      },
    });
    beat.voiceLines = [...resolvedLines, ...lines.slice(lineIndex + 1)];
    beat.voiceSynthesis = {
      requested: lines.length,
      completed,
      failed: Math.max(0, resolvedLines.length - completed),
      pending: lineIndex < lines.length - 1,
    };
    onProgress?.(beat.voiceSynthesis);
  }
  beat.voiceLines = resolvedLines;
  beat.voiceSynthesis = {
    requested: lines.length,
    completed,
    failed: Math.max(0, lines.length - completed),
    pending: false,
    reason: completed === lines.length ? '' : (completed ? 'partial' : 'synthesis_failed'),
  };
}

/** 每 N 条 narration beat 触发一次轻量分段摘要，供长线续写和结束总结共同使用。 */
export async function maybeCreateOfflineCheckpointSummary(session, { signal = null } = {}) {
  const configuredEvery = clampNum(session.scene?.autoSummaryEvery, 0, 100, 0);
  const every = configuredEvery || clampNum(session.scene?.contextDepth, 2, 60, 12);
  const narrationBeats = session.beats.filter((b) => b.role === 'narration');
  const uptoBeatIndex = narrationBeats.length;
  if (!uptoBeatIndex) return null;
  const checkpoints = Array.isArray(session.checkpointSummaries) ? session.checkpointSummaries : [];
  const coveredUpto = checkpoints.length ? Math.max(...checkpoints.map((c) => Number(c.uptoBeatIndex) || 0)) : 0;
  if (!shouldCreateOfflineCheckpoint(checkpoints, uptoBeatIndex, every)) return null;
  const firstNarration = narrationBeats[coveredUpto];
  const lastNarration = narrationBeats[uptoBeatIndex - 1];
  if (!firstNarration || !lastNarration) return null;
  const contentBeats = session.beats.filter((beat) =>
    ['opening', 'directive', 'narration', 'interlude'].includes(beat.role),
  );
  const previousNarration = coveredUpto > 0 ? narrationBeats[coveredUpto - 1] : null;
  const segmentStart = previousNarration
    ? contentBeats.findIndex((beat) => beat.id === previousNarration.id) + 1
    : 0;
  const segmentEnd = contentBeats.findIndex((beat) => beat.id === lastNarration.id);
  const segment = contentBeats.slice(Math.max(0, segmentStart), segmentEnd + 1);
  if (!segment.length) return null;
  try {
    const joined = segment.map((beat) => {
      if (beat.role === 'directive') return `用户方向：${beat.text}`;
      if (beat.role === 'interlude') return `线上插曲：${beat.text}`;
      if (beat.role === 'opening') return `开场白：${beat.text}`;
      const narrationNumber = narrationBeats.findIndex((row) => row.id === beat.id) + 1;
      const digest = formatOfflineBeatDigestForContext(beat.digest, narrationNumber);
      return `旁白：${beat.text}${digest ? `\n本轮隐藏摘要（仅作索引，正文事实优先）：${digest}` : ''}`;
    }).join('\n\n');
    const raw = await chatWithEmptyFallback(requestOfflineSummary, [
      { role: 'user', content: [
        '[线下推进 · 六轮小结]',
        '把下面这一段连续推进整理成可供后续续写的大摘要。正文是唯一事实源；若附有逐轮隐藏摘要，只用它帮助定位细节，冲突时以正文为准。',
        '保持明确人物主语，禁止交换多人台词和动作。不得制造原文没有的情绪结论、冲突解决、升华或悬念。用户方向和线上插曲同样是已经发生的时间线事实。',
        '按以下结构输出紧凑中文；某项确实没有就写“无”，总长度以 350—700 字为宜：',
        '【事件推进】关键行动、结果与当前落点',
        '【关系与认知】谁对谁发生了什么持续变化；谁新知道了什么',
        '【关键台词】最多两句，标明说话人并尽量保留原句',
        '【物品与伏笔】关键物件、归属、状态或有后果的细节',
        '【未完成事项】尚未兑现的约定、正在进行的动作或自然续接点',
        '【剧情压缩】用高密度叙述串起本段因果，不作空泛评价',
        joined,
      ].join('\n') },
    ], { temperature: 0.5, signal });
    const text = sanitizeNarrationOutput(raw);
    if (!text) return null;
    // 会话最多允许 500 轮。固定 slice(-40) 会在默认每 6 轮小结时静默丢掉
    // 约 240 轮以前的剧情，并让收尾摘要误判那些轮次仍已覆盖。先完整保留；
    // 后续若做层级压缩，必须在成功生成带覆盖区间的上卷摘要后才能删除原段。
    session.checkpointSummaries = appendOfflineCheckpointSummary(checkpoints, {
      text,
      fromBeatIndex: coveredUpto + 1,
      uptoBeatIndex,
      ts: Date.now(),
    });
    await maybeRollupOfflineCheckpointSummaries(session);
    return session.checkpointSummaries[session.checkpointSummaries.length - 1];
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw err;
    console.warn('[offline-session] checkpoint summary failed', err);
    return null;
  }
}

/**
 * 原始分段小结始终保留；这里只生成一个可替代早期小结进入模型上下文的上卷摘要。
 * 只有上卷成功后才推进覆盖游标，失败时下一轮继续保留并使用全部原始小结。
 */
export async function maybeRollupOfflineCheckpointSummaries(session) {
  const checkpoints = Array.isArray(session?.checkpointSummaries) ? session.checkpointSummaries : [];
  const currentRollup = session?.checkpointRollup && typeof session.checkpointRollup === 'object'
    ? session.checkpointRollup
    : null;
  const coveredUpto = Math.max(0, Number(currentRollup?.uptoBeatIndex || 0));
  const uncovered = checkpoints
    .filter((row) => Number(row?.uptoBeatIndex || 0) > coveredUpto && String(row?.text || '').trim())
    .sort((left, right) => Number(left.uptoBeatIndex || 0) - Number(right.uptoBeatIndex || 0));
  if (uncovered.length <= 40) return currentRollup;
  const uncoveredRanges = offlineCheckpointCoverageRanges(
    uncovered,
    session.scene?.autoSummaryEvery || 6,
  );
  if (!currentRollup && Number(uncoveredRanges[0]?.fromBeatIndex || 1) > 1) {
    // 旧版本已经淘汰了最早的小结。原始 beats 仍在，不能把从中途开始的
    // 小结误标为“从第 1 轮覆盖”的上卷摘要。
    return null;
  }
  const foldCount = uncovered.length - 32;
  const folding = uncovered.slice(0, foldCount);
  const uptoBeatIndex = Number(folding[folding.length - 1]?.uptoBeatIndex || 0);
  if (!uptoBeatIndex) return currentRollup;
  const source = [
    currentRollup?.text ? `既有上卷摘要：${currentRollup.text}` : '',
    ...folding.map((row) => `第 ${row.fromBeatIndex || '?'}-${row.uptoBeatIndex} 轮：${row.text}`),
  ].filter(Boolean).join('\n');
  try {
    const raw = await chatWithEmptyFallback(requestOfflineSummary, [{
      role: 'user',
      content: [
        '请把下面的线下长线进展压成一份可供后续续写的上卷摘要。',
        '必须保留：不可逆行动与结果、关系变化及原因、持续身体状态、关键物件归属、已建立事实、仍未完成的事项与承诺。',
        '明确区分“已经完成”和“仍未完成”，禁止把完成事项写成待办。沿用来源中的事件推进、关系认知、关键台词、物品伏笔和未完成事项分类；可以合并重复项，不能丢掉尚未被后文撤销的事实。使用紧凑中文，不要 JSON 或解释。',
        source,
      ].join('\n'),
    }], {
      temperature: 0.3,
    });
    const text = sanitizeNarrationOutput(raw);
    if (!text) return currentRollup;
    session.checkpointRollup = {
      text,
      fromBeatIndex: 1,
      uptoBeatIndex,
      ts: Date.now(),
    };
    return session.checkpointRollup;
  } catch (err) {
    console.warn('[offline-session] checkpoint rollup failed', err);
    return currentRollup;
  }
}

/** 返回这一轮上次实际用于生图的提示词，供编辑与后续重 roll 延用。 */
const LEGACY_REALISTIC_OFFLINE_PROMPT_RE = /(?:Photo quality baseline|Art direction:|Fixed style \/ subject notes|Visual continuity:|Focus on atmosphere, environment|Photorealistic everyday life scene)/i;

export function resolveOfflineBeatImagePrompt(beat = {}, imageGenMode = '') {
  const prompt = String(beat?.image?.prompt || '').trim();
  if (
    normalizeOfflineSceneImageGenMode(imageGenMode) === 'novelai'
    && LEGACY_REALISTIC_OFFLINE_PROMPT_RE.test(prompt)
  ) return '';
  return prompt;
}

/**
 * 手动生成/重roll 某一轮的场景图：未传 promptOverride 时沿用上次实际提示词；首次生成或用户主动
 * 清空编辑框时，按场景 + 该轮画面线索自动拼（该轮如果有模型自带的 aiImagePrompt 就优先用它）。
 * 传入非空 promptOverride 则用用户这次写的提示词整段替换。生成结果直接覆盖 beat.image 并落库。
 */
export async function generateOfflineBeatImage({ session, chat, user = null, beatId, promptOverride = null, styleId = '' } = {}) {
  if (!session) throw new Error('线下会话不存在');
  const beat = session.beats.find((b) => b.id === beatId);
  if (!beat) throw new Error('找不到这一轮');
  const availableImageSubjectIds = ['user', ...getActiveOfflineParticipantIds(session, chat)];
  const imageSubjectIds = Array.isArray(beat.aiImageSubjectIds)
    ? beat.aiImageSubjectIds.filter((id) => availableImageSubjectIds.includes(id))
    : availableImageSubjectIds;
  const effectiveStyleId = styleId || session.scene?.imageStyleId;
  const effectivePromptOverride = promptOverride === null || promptOverride === undefined
    ? resolveOfflineBeatImagePrompt(beat, session.scene?.imageGenMode)
    : String(promptOverride || '').trim();
  const imagePromptArgs = {
    scene: session.scene,
    beatText: beat.text,
    styleId: effectiveStyleId,
    promptOverride: effectivePromptOverride,
    aiPrompt: beat.aiImagePrompt || '',
    subjectCount: imageSubjectIds.length,
    imageGenMode: session.scene?.imageGenMode,
  };
  const prompt = buildOfflineScenePrompt(imagePromptArgs);
  const novelAiPrompt = effectivePromptOverride
    ? prompt
    : buildOfflineScenePrompt({ ...imagePromptArgs, imageGenMode: 'novelai' });
  const result = await maybeGenerateOfflineSceneImage({
    prompt,
    novelAiPrompt,
    subjectIds: imageSubjectIds,
    user,
    imageGenMode: session.scene?.imageGenMode,
    aspect: session.scene?.audioSceneLayout || 'portrait',
  });
  if (!result.image) throw new Error(result.error || '生图未开启或生成失败');
  beat.image = {
    url: result.image,
    prompt: result.prompt,
    styleId: effectiveStyleId || '',
    provider: String(result.provider || ''),
    generatedAt: Date.now(),
    ...(result.referenceSkipped ? {
      referenceSkipped: true,
      warning: '参考图锁定未生效，已改用文字外观生成',
    } : {}),
    ...(result.referenceSubjectIds?.length ? {
      referenceSubjectIds: result.referenceSubjectIds,
      referenceSubmittedCount: result.referenceSubmittedCount,
      referenceSubmittedSubjectIds: result.referenceSubmittedSubjectIds || [],
    } : {}),
  };
  await saveOfflineSession(session);
  return beat;
}

/**
 * 收尾：凝练摘要写入共同回忆 + 统一约会档案（轮次原文 + 摘要），不生成小剧场卡。
 * @param {{ targetTs?: number, keepVirtual?: boolean }|null} [advance]
 *   可选的时间线推进：把世界时钟推到 targetTs（幂等——已自然超过则不动）。
 *   默认走「时间债追平」：剧情领先现实，现实自然追上后自动恢复同步；keepVirtual=true 则留在经典虚拟。
 */
export async function summarizeOfflineSession({ session, chat, user, messages = [], advance = null }) {
  if (!session) throw new Error('线下会话不存在');
  const generationLease = await acquireNarrationGenerationLease('offline', session.id || session.chatId);
  if (!generationLease.acquired) throw narrationGenerationInFlightError();
  try {
  const narrationBeats = session.beats.filter((b) => b.role === 'narration');
  if (!narrationBeats.length) throw new Error('还没有可总结的线下内容');

  // 兼容旧版：多人线下曾会把来源私聊永久改成群聊。归档前先原地恢复，
  // 消息、chatPrefs 与 groupSettings 中承载的壁纸/自定义 CSS 都继续沿用原 chatId。
  await restoreOfflineSourcePrivateChat(session, chat).catch((err) => {
    console.warn('[offline-session] restore source private chat failed', err);
  });

  // 先推进时间（幂等），再生成摘要——这样 endedAt 与日程覆盖都落在推进后的时刻上。
  const advanceUserId = String(session.userId || user?.id || '').trim();
  const advanceTargetTs = Number(advance?.targetTs || 0);
  if (advanceUserId && advanceTargetTs > 0) {
    const schedule = await ensureTimeSchedule(advanceUserId);
    if (!canAdvanceOfflineSettlementTime(schedule)) {
      throw new Error('线下收纳推进仅限固定虚拟时间线使用');
    }
    const worldNow = await getNowForUser(advanceUserId);
    const delta = advanceTargetTs - worldNow;
    if (delta > 0) {
      await advanceVirtualTime(advanceUserId, delta, { reconverge: false });
    }
  }

  const activeChat = buildActiveOfflineChat(session, chat);
  const userPresent = isOfflineUserPresent(session, chat);
  const { archive, memory, summary } = await archiveOfflineDateSession({
    session, chat: activeChat, user, messages,
  });
  // 匿名房的身份边界由匿名记忆链路单独管理，不能把马甲下获得的认知写进普通 Chat。
  const knowledgeFacts = !userPresent || isAnonymousChat(activeChat) ? [] : collectOfflineKnowledgeFacts(session);
  for (const fact of knowledgeFacts) {
    const character = await getCharacter(fact.characterId, {
      userId: String(session.userId || user?.id || '').trim(),
    }).catch(() => null);
    const characterName = getCharacterAiContextName(character, fact.characterId);
    await upsertMemoryFact({
      userId: String(session.userId || user?.id || '').trim(),
      chatId: String(activeChat?.id || session.chatId || '').trim(),
      scope: 'normal_chat',
      subjectId: 'user',
      subjectName: '用户',
      objectId: fact.characterId,
      objectName: characterName,
      factType: 'relationship_impression',
      temporalState: 'evergreen',
      content: fact.fact,
      evidence: fact.evidence || `线下相遇第 ${fact.learnedAtBeat} 轮亲历`,
      confidence: 1,
      knownBy: { [fact.characterId]: 'involved' },
      tags: ['线下相遇', '角色认知'],
      sourceMessageIds: [],
      updatedAt: Date.now(),
    }).catch((err) => {
      console.warn('[offline-session] persist knowledge fact failed', err);
    });
  }

  // 这段线下真实占用的世界内时间段写回参与者日程，覆盖原本 AI 排在这个时段的安排。
  // 覆盖失败不阻塞收纳（日程只是展示层，档案与记忆才是主数据）。
  const overrideStart = Number(session.startedAtWorld || session.createdAt || 0);
  const overrideUserId = String(session.userId || user?.id || '').trim();
  const overrideTargets = Array.isArray(archive?.participantIds) && archive.participantIds.length
    ? archive.participantIds
    : [archive?.characterId].filter(Boolean);
  for (const cid of overrideTargets) {
    const ownedMemory = (archive?.characterMemories || [])
      .find((item) => String(item?.characterId || '') === String(cid || ''));
    await applyOfflineSummaryScheduleOverride({
      userId: overrideUserId,
      characterId: cid,
      startTs: overrideStart,
      endTs: Number(archive?.endedAt || 0),
      summary,
      place: session.scene?.place || '',
      activity: session.scene?.goal || (userPresent ? '' : '角色线下同行'),
      sourceId: archive?.id || '',
      replaceSourceId: session.id,
      eventContext: {
        archiveId: archive?.id || '',
        participantIds: archive?.participantIds || [],
        participantNames: archive?.participantNames || [],
        summary,
        memory: ownedMemory?.content || '',
        quotes: archive?.digest?.quotes || [],
        relationshipShifts: archive?.digest?.shifts || [],
        hooks: archive?.digest?.hooks || [],
        items: archive?.digest?.items || [],
      },
    }).catch(() => {});
  }

  const inviteMessageId = String(session.originSeed?.inviteMessageId || '').trim();
  let inviteMessage = inviteMessageId
    ? await getRecord('messages', inviteMessageId).catch(() => null)
    : null;
  if (!inviteMessage) {
    const originPlace = String(session.originSeed?.place || '').trim();
    const originActivity = String(session.originSeed?.activity || '').trim();
    inviteMessage = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => {
      if (message?.type !== 'offlineInvite') return false;
      const md = message.metadata || {};
      if (!['accepted', 'arrived'].includes(String(md.status || ''))) return false;
      if (originPlace && String(md.place || '').trim() !== originPlace) return false;
      if (originActivity && String(md.activity || '').trim() !== originActivity) return false;
      return true;
    }) || null;
  }
  if (inviteMessage?.id) {
    inviteMessage.metadata = {
      ...(inviteMessage.metadata || {}),
      status: 'fulfilled',
      fulfilledAt: Number(archive?.endedAt || 0) || Date.now(),
      offlineDateArchiveId: String(archive?.id || '').trim(),
    };
    await saveMessage(inviteMessage);
  }

  if (session.activitySessionId) {
    try {
      const activity = await getActivitySession(session.userId || user?.id || '', session.activitySessionId);
      if (activity) {
        await saveActivitySession(activity.userId || session.userId || user?.id || '', {
          ...activity,
          status: 'done',
          currentStep: 'done',
          outputs: [
            ...(Array.isArray(activity.outputs) ? activity.outputs : []),
            {
              id: archive.id,
              type: 'offlineDateArchive',
              title: archive.title || '约会记录',
              summary: summary || archive.summary || '',
              archiveId: archive.id,
              memoryId: memory?.id || '',
              createdAt: archive.endedAt || Date.now(),
            },
          ].slice(-12),
          detailCards: [
            ...(Array.isArray(activity.detailCards) ? activity.detailCards : []),
            {
              id: archive.id,
              title: archive.title || '约会记录',
              summary: summary || archive.summary || '',
              fullText: (archive.rounds || []).map((r) => r.text).filter(Boolean).join('\n\n'),
              createdAt: archive.endedAt || Date.now(),
            },
          ].slice(-12),
        });
      }
    } catch (_) {
      /* activity session 回写失败不阻塞收纳 */
    }
  }

  // 初遇收纳：角色正式写入通讯录、聊天露出收件箱，这场卷宗成为第一条共同回忆。
  if (session.firstEncounter === true) {
    await finalizeFirstEncounter({ chatId: session.chatId, userId: session.userId || user?.id || '' }).catch(() => {});
  }

  await clearOfflineSession(session.chatId, { sessionId: session.id });
  await clearOfflineBranchSnapshots(session);
  return { archive, memory, summary };
  } finally {
    await generationLease.release();
  }
}
