import {
  pickCurrentFlowStep,
  parseTimeRangeStartMinutes,
  resolveActiveDailyLifePlanBlock,
  schedulePointMinuteForBlock,
  scheduleTimelineMinuteAt,
} from './character-phone-store.js';
import {
  loadCharacterRuntimeState,
  resolveEffectiveCharacterState,
} from './character-effective-state.js';
import { resolveCharacterScheduleTimezone } from './chat/chat-timezone.js';
import { listChatsForUser } from './chat-store.js';
import { loadOfflineSession } from './offline-session-store.js';
import { DEFAULT_CHAT_STATUS_TTL_MS } from './status-ttl.js';
import {
  hasAuthoritativeCharacterPresence,
  loadCharacterLiveState,
} from './character-live-state.js';

function clean(value = '', max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const DISPLAY_STATUS_TTL_MS = DEFAULT_CHAT_STATUS_TTL_MS;

function summarizeOfflineSession(session = null) {
  if (!session || session.status !== 'active') return null;
  const scene = session.scene || {};
  const lastNarration = [...(Array.isArray(session.beats) ? session.beats : [])]
    .reverse()
    .find((beat) => beat?.role === 'narration');
  const dayIndex = Math.max(0, Number(scene.dayIndex || 0) || 0);
  const dayPlan = scene.itinerary?.days?.[dayIndex];
  return {
    kind: scene.activityKind === 'trip' ? 'trip' : 'offline_meeting',
    place: clean(scene.place, 100),
    activity: clean(scene.goal || dayPlan?.title || '', 120),
    recentEvent: clean(lastNarration?.text || '', 180),
    updatedAt: Number(session.updatedAt || session.startedAt || 0) || 0,
    day: scene.activityKind === 'trip'
      ? `${dayIndex + 1}/${Math.max(1, Number(scene.durationDays || 1) || 1)}`
      : '',
  };
}

export function buildCharacterPhoneCurrentContext({
  runtimeState = null,
  phone = null,
  activeOfflineSession = null,
  liveState = null,
  now = Date.now(),
  timeZone = '',
} = {}) {
  const nowTs = Number(now || 0) || Date.now();
  const runtimeExpiresAt = Number(runtimeState?.activityExpiresAt || 0) || 0;
  const runtimeActive = !!(
    runtimeState?.activity
    && runtimeState?.scheduleOverride === true
    && (!runtimeExpiresAt || runtimeExpiresAt > nowTs)
  );
  const { plan, block: scheduleBlock } = resolveActiveDailyLifePlanBlock(phone, nowTs, timeZone);
  const currentStep = scheduleBlock ? pickCurrentFlowStep(scheduleBlock, nowTs, timeZone) : null;
  const scheduleTimelineMinute = scheduleBlock
    ? scheduleTimelineMinuteAt(scheduleBlock, nowTs, timeZone)
    : -1;
  const scheduleStepStartMinute = scheduleBlock
    ? (currentStep
      ? schedulePointMinuteForBlock(scheduleBlock, currentStep)
      : parseTimeRangeStartMinutes(scheduleBlock.timeRange))
    : -1;
  const scheduleWorldStartedAt = scheduleTimelineMinute >= 0 && scheduleStepStartMinute >= 0
    ? nowTs - Math.max(0, scheduleTimelineMinute - scheduleStepStartMinute) * 60 * 1000
    : 0;
  const stepUpdatedAt = Number(currentStep?.updatedAt || 0) || 0;
  const blockUpdatedAt = Number(scheduleBlock?.updatedAt || 0) || 0;
  const planUpdatedAt = Number(plan?.updatedAt || 0) || 0;
  // freshness 只在 wall updatedAt 域比较。旧计划没有子项时间戳时才退到
  // plan.updatedAt；按角色时区推导出的步骤开始时间另存为 worldStartedAt。
  const scheduleUpdatedAt = Math.max(stepUpdatedAt, blockUpdatedAt)
    || planUpdatedAt
    || 0;
  const schedulePlanRevision = Math.max(
    Number(currentStep?.planRevision || 0) || 0,
    Number(scheduleBlock?.planRevision || 0) || 0,
    Number(plan?.planRevision || 0) || 0,
  );
  const offline = summarizeOfflineSession(activeOfflineSession);
  const liveSceneExpiresAt = Number(liveState?.sceneFact?.expiresAt || 0) || 0;
  const liveScene = liveState?.sceneFact?.activity
    && (!liveSceneExpiresAt || liveSceneExpiresAt > nowTs)
    ? {
      activity: clean(liveState.sceneFact.activity, 120),
      place: clean(liveState.sceneFact.place, 100),
      availability: clean(liveState.sceneFact.availability, 20) || 'online',
      sourceRoundId: clean(liveState.sceneFact.sourceRoundId, 120),
      scheduleOverride: liveState.sceneFact.scheduleOverride === true,
      updatedAt: Number(liveState.sceneFact.updatedAt || 0) || 0,
      expiresAt: liveSceneExpiresAt,
    }
    : null;
  const runtime = runtimeActive
    ? {
      activity: clean(runtimeState.activity, 100),
      topStatus: clean(runtimeState.topStatus, 100),
      updatedAt: Number(runtimeState.activityUpdatedAt || runtimeState.updatedAt || 0) || 0,
      expiresAt: runtimeExpiresAt,
    }
    : null;
  const schedule = scheduleBlock
    ? {
      activity: clean(currentStep?.action || scheduleBlock.activity, 120),
      place: clean(currentStep?.placeName || currentStep?.place || scheduleBlock.placeName || scheduleBlock.anchor || scheduleBlock.city || '', 100),
      timeRange: clean(scheduleBlock.timeRange, 32),
      currentStep: currentStep ? {
        action: clean(currentStep.action, 120),
        at: clean(currentStep.at, 16),
        busy: currentStep.busy === true,
        updatedAt: stepUpdatedAt,
        planRevision: Number(currentStep.planRevision || 0) || 0,
      } : null,
      busy: currentStep ? currentStep.busy === true : scheduleBlock.busy === true,
      isSleep: scheduleBlock.isSleep === true,
      // changedAt 暂留作调用兼容，但语义已改为真实墙钟 mutation time。
      changedAt: scheduleUpdatedAt,
      updatedAt: scheduleUpdatedAt,
      updatedAtClock: 'wall',
      worldStartedAt: scheduleWorldStartedAt,
      worldClock: 'world',
      planRevision: schedulePlanRevision,
    }
    : null;
  const resolved = resolveEffectiveCharacterState({
    runtimeState,
    sceneFact: liveState?.sceneFact || null,
    scheduleBlock: schedule
      ? {
        ...scheduleBlock,
        activity: schedule.activity,
        changedAt: scheduleUpdatedAt,
        updatedAt: scheduleUpdatedAt,
      }
      : null,
    allowSceneScheduleOverride: liveState?.policy?.sceneScheduleOverrideAllowed !== false,
    now: nowTs,
  });
  const effective = offline
    ? {
      source: 'offline',
      activity: offline.activity || offline.recentEvent,
      place: offline.place,
      busy: true,
      updatedAt: offline.updatedAt,
      expiresAt: 0,
    }
    : resolved.source === 'scene'
      ? {
        source: 'scene_fact',
        activity: liveScene.activity,
        place: liveScene.place,
        busy: liveScene.availability === 'busy' || liveScene.availability === 'offline',
        updatedAt: liveScene.updatedAt,
        expiresAt: liveScene.expiresAt,
      }
      : {
      source: resolved.source,
      activity: resolved.activity,
      place: resolved.source === 'schedule' ? (schedule?.place || '') : '',
      busy: resolved.source === 'schedule' ? schedule?.busy === true : resolved.source === 'runtime',
      updatedAt: resolved.updatedAt,
      expiresAt: resolved.expiresAt,
    };
  const publicStatusText = clean(liveState?.statusLine?.text, 100);
  const publicStatusUpdatedAt = Number(liveState?.statusLine?.updatedAt || 0) || 0;
  const publicStatusAuthoritative = !!(
    liveState?.statusLine
    && typeof liveState.statusLine === 'object'
    && (
      publicStatusText
      || liveState.statusLine.source
      || liveState.statusLine.updatedAt
      || liveState.statusLine.expiredAt
    )
  );
  const topStatus = publicStatusText
    || (!publicStatusAuthoritative ? clean(runtimeState?.topStatus, 100) : '');
  const topStatusUpdatedAt = publicStatusUpdatedAt
    || Number(runtimeState?.topStatusUpdatedAt || runtimeState?.updatedAt || 0)
    || 0;
  const displayStatus = publicStatusText
    ? {
      text: publicStatusText,
      updatedAt: publicStatusUpdatedAt,
      expiresAt: Number(liveState?.statusLine?.expiresAt || 0) || 0,
      source: liveState?.statusLine?.source || 'character_status_line',
    }
    : topStatus && topStatusUpdatedAt
    && nowTs >= topStatusUpdatedAt
    && nowTs - topStatusUpdatedAt <= DISPLAY_STATUS_TTL_MS
    ? {
      text: topStatus,
      updatedAt: topStatusUpdatedAt,
      expiresAt: topStatusUpdatedAt + DISPLAY_STATUS_TTL_MS,
      source: 'chat_status',
    }
    : null;
  return {
    priority: 'current_fact',
    runtime,
    activeOffline: offline,
    schedule,
    effective,
    displayStatus,
    publicStatus: {
      text: publicStatusText,
      source: clean(liveState?.statusLine?.source, 40),
      updatedAt: publicStatusUpdatedAt,
      authoritative: publicStatusAuthoritative,
      presenceState: hasAuthoritativeCharacterPresence(liveState?.presence)
        ? (clean(liveState?.presence?.state, 20) || 'online')
        : '',
      presenceSource: clean(liveState?.presence?.source, 40),
      presenceUpdatedAt: Number(liveState?.presence?.updatedAt || 0) || 0,
      presenceSourceRoundId: clean(liveState?.presence?.sourceRoundId, 120),
      manualLocked: liveState?.policy?.manualLocked === true,
      aiUpdatesAllowed: liveState?.policy?.aiUpdatesAllowed !== false,
      presenceManualLocked: liveState?.policy?.presenceManualLocked === true,
      presenceUpdatesAllowed: liveState?.policy?.presenceUpdatesAllowed !== false,
    },
    sceneFact: liveScene,
    timeZone: clean(timeZone, 80),
    protected: !!(runtime || offline || liveScene || schedule),
    rule: '这是生成时已经成立的当前事实，只用于防止补历史记录与现实冲突。补记录不得把角色安排到别处，不得改写当前地点、当前活动、实时状态或正在进行的线下同行；关系网、常住地和旧手机记录只能作为更低优先级的历史背景。',
  };
}

async function findActiveOfflineSession(userId, characterId) {
  const chats = await listChatsForUser(userId).catch(() => []);
  const relevant = chats.filter((chat) => (
    chat?.id
    && Array.isArray(chat.participants)
    && chat.participants.includes(characterId)
  ));
  for (const chat of relevant.slice(0, 12)) {
    const session = await loadOfflineSession(chat.id).catch(() => null);
    if (session?.status === 'active') return session;
  }
  return null;
}

export async function collectCharacterPhoneCurrentContext({
  userId,
  characterId,
  phone = null,
  character = null,
  now = Date.now(),
  timeZone = '',
} = {}) {
  const resolvedTimeZone = timeZone || await resolveCharacterScheduleTimezone(
    userId,
    characterId,
    character,
  ).catch(() => '');
  const [runtimeState, activeOfflineSession, liveState] = await Promise.all([
    loadCharacterRuntimeState(userId, characterId, { now }).catch(() => null),
    findActiveOfflineSession(userId, characterId),
    loadCharacterLiveState(userId, characterId, { now, presenceNow: Date.now() }).catch(() => null),
  ]);
  return buildCharacterPhoneCurrentContext({
    runtimeState,
    phone,
    activeOfflineSession,
    liveState,
    now,
    timeZone: resolvedTimeZone,
  });
}
