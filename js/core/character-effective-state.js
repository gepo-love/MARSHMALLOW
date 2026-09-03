import { get, put, remove } from './db.js';
import { loadChatPrefs } from './chat-block-state.js';

const KEY = (userId, characterId) => (
  `characterEffectiveState_${String(userId || '').trim()}_${String(characterId || '').trim()}`
);

const DEFAULT_ACTIVITY_TTL_MS = 45 * 60 * 1000;
const LONG_ACTIVITY_TTL_MS = 6 * 60 * 60 * 1000;
const ACTIVITY_MAX_LEN = 80;

const TOP_STATUS_ACTIVITY_RE = /(?:^|[\s，。；：!！?？])(?:正在(?:开会|上课|上班|工作|加班|训练|吃饭|做饭|洗澡|睡觉|休息|看电影|打游戏|散步|逛街|赶路|旅行|通勤|收拾|坐车|打车|飞行|住院)|乘坐(?:出租车|网约车|公交|地铁|高铁|火车|飞机)?|在(?:家|外面|路上|公司|学校|医院|机场|车站|车上|出租车|网约车|公交|地铁|高铁|火车|飞机|开会|上课|上班|工作|吃饭|睡觉|洗澡|看电影|打游戏|逛街|散步)[^，。；：!！?？\s]{0,16}|坐在[^，。；：!！?？\s]{0,16}(?:出租车|网约车|公交|地铁|高铁|火车|飞机|车)上|刚(?:到|回|下班|下课|醒|睡)|准备(?:去|回|出门|睡)|(?:赶去|前往|去往|临时去|坐车去|打车去|打车前往)[^，。；：!！?？\s]{1,16}|坐车|打车|回家|出门|下班|下课|开会|上课|上班|工作|加班|训练|吃饭|做饭|洗澡|睡觉|休息|看电影|打游戏|散步|逛街|赶路|旅行|忙完|到家)(?:中|了|结束|刚结束|勿扰|手机静音)?(?=$|[\s，。；：!！?？])/u;
const LONG_ACTIVITY_RE = /(?:睡觉|睡了|休息|住院|旅行|出差|长途|飞行)/u;

function cleanText(value, max = ACTIVITY_MAX_LEN) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

function timestamp(value, fallback = 0) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function clearRuntimeActivity(state = {}) {
  return {
    ...state,
    activity: '',
    activitySource: '',
    activityChatId: '',
    activityUpdatedAt: 0,
    activityExpiresAt: 0,
    scheduleOverride: false,
  };
}

async function chatAllowsRuntimeScheduleOverride(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return true;
  const prefs = await loadChatPrefs(id).catch(() => ({}));
  // 真实场景事实与公开顶栏短句是两条链：关闭 AI 改签名不应抹掉角色正在做什么。
  return prefs.allowAiStatusScheduleOverride !== false;
}

export function topStatusCanOverrideSchedule(statusText = '', reason = '') {
  const text = `${cleanText(statusText)} ${cleanText(reason)}`.trim();
  return !!text && TOP_STATUS_ACTIVITY_RE.test(text);
}

export function defaultRuntimeActivityTtlMs(activity = '') {
  return LONG_ACTIVITY_RE.test(String(activity || ''))
    ? LONG_ACTIVITY_TTL_MS
    : DEFAULT_ACTIVITY_TTL_MS;
}

export async function loadCharacterRuntimeState(userId, characterId, options = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return null;
  const row = await get(KEY(uid, cid));
  const state = row?.value && typeof row.value === 'object' ? row.value : null;
  if (!state) return null;
  const nowTs = timestamp(options.now, Date.now());
  const activityUpdatedAt = timestamp(state.activityUpdatedAt || state.updatedAt);
  const storedActivityExpiresAt = timestamp(state.activityExpiresAt);
  const activityExpiresAt = storedActivityExpiresAt || (
    state.activity && activityUpdatedAt
      ? activityUpdatedAt + defaultRuntimeActivityTtlMs(state.activity)
      : 0
  );
  // 旧版运行时状态没有 expiresAt；能根据更新时间推导就补齐，连更新时间也没有的
  // 无法证明仍是当前事实，直接让位给此刻日程，不能无限期压住后续日期。
  if (state.activity && (!activityExpiresAt || activityExpiresAt <= nowTs)) {
    const next = clearRuntimeActivity(state);
    if (!next.topStatus) {
      await remove(KEY(uid, cid)).catch(() => {});
      return null;
    }
    await put({ key: KEY(uid, cid), value: next }).catch(() => {});
    return next;
  }
  if (state.activity && !storedActivityExpiresAt && activityExpiresAt > nowTs) {
    const next = { ...state, activityExpiresAt };
    await put({ key: KEY(uid, cid), value: next }).catch(() => {});
    return next;
  }
  // 覆盖权限属于聊天，运行时状态却按角色保存。旧请求可能在用户关掉开关后才返回，
  // 或旧版本曾绕过开关写入；读取时再按来源聊天核验一次，避免脏状态继续压住日程。
  if (
    state.activity
    && state.scheduleOverride === true
    && state.activityChatId
    && !(await chatAllowsRuntimeScheduleOverride(state.activityChatId))
  ) {
    const next = clearRuntimeActivity(state);
    if (!next.topStatus) {
      await remove(KEY(uid, cid)).catch(() => {});
      return null;
    }
    await put({ key: KEY(uid, cid), value: next }).catch(() => {});
    return next;
  }
  return state;
}

export async function recordCharacterRuntimeState(userId, characterId, patch = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return null;
  const nowTs = timestamp(patch.updatedAt, Date.now());
  const previous = await loadCharacterRuntimeState(uid, cid, { now: nowTs }).catch(() => null);
  const next = {
    ...(previous || {}),
    characterId: cid,
    updatedAt: nowTs,
  };

  if (Object.prototype.hasOwnProperty.call(patch, 'topStatus')) {
    next.topStatus = cleanText(patch.topStatus);
    next.presenceState = cleanText(patch.presenceState, 24);
    next.topStatusUpdatedAt = nowTs;
  }

  const activityProvided = Object.prototype.hasOwnProperty.call(patch, 'activity');
  const activity = cleanText(patch.activity);
  const activityChatId = cleanText(patch.chatId, 80);
  const wantsScheduleOverride = !!activity && patch.scheduleOverride === true;
  const scheduleOverrideAllowed = !wantsScheduleOverride
    || await chatAllowsRuntimeScheduleOverride(activityChatId);
  if (wantsScheduleOverride && scheduleOverrideAllowed) {
    const ttlMs = Math.max(
      5 * 60 * 1000,
      timestamp(patch.ttlMs, defaultRuntimeActivityTtlMs(activity)),
    );
    next.activity = activity;
    next.activitySource = cleanText(patch.source, 32) || 'chat_state';
    next.activityChatId = activityChatId;
    next.activityUpdatedAt = nowTs;
    next.activityExpiresAt = timestamp(patch.expiresAt, nowTs + ttlMs);
    next.scheduleOverride = true;
  } else if (
    activityProvided
    && (!next.activityChatId || next.activityChatId === activityChatId)
  ) {
    // 同一会话的新状态明确不具备覆盖权时，及时撤掉旧覆盖；
    // 否则一次“开会中”会在后来改成普通心情签名后仍压住日程直到 TTL 到期。
    Object.assign(next, clearRuntimeActivity(next));
  }

  await put({ key: KEY(uid, cid), value: next });
  return next;
}

/**
 * 清掉旧版本写在 runtimeState.topStatus 的兼容副本，但保留真实活动与日程覆盖。
 * 新版公开短句以 characterLiveState.statusLine 为唯一真源；手动保存或清空后，
 * 旧副本不能在重新进页时又被顶栏捞回来。
 */
export async function clearCharacterRuntimeTopStatus(userId, characterId) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return null;
  const previous = await loadCharacterRuntimeState(uid, cid).catch(() => null);
  if (!previous) return null;
  const next = {
    ...previous,
    topStatus: '',
    topStatusUpdatedAt: 0,
    updatedAt: Date.now(),
  };
  if (!next.activity) {
    await remove(KEY(uid, cid));
    return null;
  }
  await put({ key: KEY(uid, cid), value: next });
  return next;
}

export async function clearCharacterRuntimeScheduleOverride(userId, characterId, options = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return null;
  const previous = await loadCharacterRuntimeState(uid, cid).catch(() => null);
  if (!previous) return null;
  const sourceChatId = String(options.chatId || '').trim();
  if (sourceChatId && previous.activityChatId && previous.activityChatId !== sourceChatId) {
    return previous;
  }
  const next = {
    ...clearRuntimeActivity(previous),
    updatedAt: Date.now(),
  };
  if (!next.topStatus) {
    await remove(KEY(uid, cid)).catch(() => {});
    return null;
  }
  await put({ key: KEY(uid, cid), value: next });
  return next;
}

export function resolveEffectiveCharacterState({
  runtimeState = null,
  sceneFact = null,
  scheduleBlock = null,
  allowSceneScheduleOverride = true,
  now = Date.now(),
} = {}) {
  const nowTs = timestamp(now, Date.now());
  const activity = cleanText(runtimeState?.activity);
  const activityUpdatedAt = timestamp(runtimeState?.activityUpdatedAt || runtimeState?.updatedAt);
  const activityExpiresAt = timestamp(runtimeState?.activityExpiresAt)
    || (activity && activityUpdatedAt
      ? activityUpdatedAt + defaultRuntimeActivityTtlMs(activity)
      : 0);
  // 旧版本曾把每轮 state.status 自动记成 scene_fact 覆盖。升级后立刻忽略这类
  // 遗留记录，避免还要等下一轮写入或 TTL 到期，日程才能重新生效。
  const legacyImplicitSceneOverride = runtimeState?.activitySource === 'scene_fact';
  const runtimeActive = !!(
    activity
    && runtimeState?.scheduleOverride === true
    && !legacyImplicitSceneOverride
    && activityExpiresAt > nowTs
  );
  if (runtimeActive) {
    return {
      source: 'runtime',
      activity,
      scheduleOverridden: true,
      originalActivity: cleanText(scheduleBlock?.activity),
      updatedAt: timestamp(runtimeState?.activityUpdatedAt),
      expiresAt: activityExpiresAt,
    };
  }
  const sceneActivity = cleanText(sceneFact?.activity);
  const sceneExpiresAt = timestamp(sceneFact?.expiresAt);
  const sceneSource = cleanText(sceneFact?.source, 32);
  const foregroundScene = sceneSource === 'foreground_chat_state';
  const scheduleIsSleep = scheduleBlock?.isSleep === true;
  const sceneActive = !!(
    sceneActivity
    // sceneFact 只记录“现实正在发生什么”，不修改原日程。是否临时显示在
    // 原计划之前由当前策略决定；旧实现还额外要求写入 scheduleOverride=true，
    // 导致设置页开关虽然开启，普通聊天场景仍永远无法生效。
    && allowSceneScheduleOverride !== false
    // 重进页面时，旧版普通 chat_state 快照不能仅凭仍在 TTL 内就把已经到点的
    // 睡眠日程改回在线；本轮前台场景或显式覆盖仍可以证明角色确实醒着。
    && (!scheduleIsSleep || foregroundScene || sceneFact?.scheduleOverride === true)
    && (!sceneExpiresAt || sceneExpiresAt > nowTs)
  );
  if (sceneActive) {
    return {
      source: 'scene',
      activity: sceneActivity,
      availability: cleanText(sceneFact?.availability, 24) || 'online',
      sourceChatId: cleanText(sceneFact?.sourceChatId, 80),
      scheduleOverridden: true,
      temporaryScene: true,
      originalActivity: cleanText(scheduleBlock?.activity),
      updatedAt: timestamp(sceneFact?.updatedAt),
      expiresAt: sceneExpiresAt,
    };
  }
  return {
    source: scheduleBlock ? 'schedule' : 'none',
    activity: cleanText(scheduleBlock?.activity),
    scheduleOverridden: false,
    originalActivity: '',
    updatedAt: timestamp(scheduleBlock?.changedAt || scheduleBlock?.updatedAt),
    expiresAt: 0,
  };
}
