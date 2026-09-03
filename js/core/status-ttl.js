import {
  loadChatPrefs,
  loadChatPrefsFresh,
  patchChatPrefs,
  updateChatPrefsAtomic,
} from './chat-block-state.js';

function clean(value = '', max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const DEFAULT_CHAT_STATUS_TTL_MS = 45 * 60 * 1000;
const CHAT_PRESENCE_STATES = new Set(['online', 'away', 'busy', 'offline']);

function normalizeChatPresence(value = '') {
  const state = String(value || '').trim().toLowerCase();
  return CHAT_PRESENCE_STATES.has(state) ? state : 'online';
}

export function defaultStatusTtlMs(statusText = '', presenceState = 'online') {
  clean(statusText, 60);
  // 普通在线状态是一次对话当下的快照，不是可以独立压住后续日程数小时的长期事实。
  // hard_offline / next_reply_delay 会显式传 statusExpiresAt，仍按剧情指定的时长保留。
  if (presenceState === 'offline') return 8 * 60 * 60 * 1000;
  return DEFAULT_CHAT_STATUS_TTL_MS;
}

export function withStatusTtl(prefs = {}, patch = {}) {
  const now = Date.now();
  const statusText = clean(patch.statusText ?? prefs.statusText ?? '', 60);
  const presenceState = normalizeChatPresence(patch.presenceState ?? prefs.presenceState);
  const statusUpdatedAt = Number(patch.statusUpdatedAt || now) || now;
  const explicitExpiresAt = Number(patch.statusExpiresAt || 0) || 0;
  const ttl = defaultStatusTtlMs(statusText, presenceState);
  return {
    ...(prefs || {}),
    ...(patch || {}),
    presenceState,
    statusText,
    statusSource: patch.statusSource || prefs.statusSource || 'ai',
    statusUpdatedAt,
    statusExpiresAt: explicitExpiresAt || (statusText || presenceState !== 'online' ? statusUpdatedAt + ttl : 0),
  };
}

export function expireStatusPrefs(prefs = {}, now = Date.now()) {
  const src = prefs && typeof prefs === 'object' ? prefs : {};
  const storedExpiresAt = Number(src.statusExpiresAt || 0) || 0;
  const updatedAt = Number(src.statusUpdatedAt || 0) || 0;
  const presenceState = normalizeChatPresence(src.presenceState);
  const statusSource = clean(src.statusSource, 40);
  const hasTransientStatus = !!(clean(src.statusText, 60) || presenceState !== 'online');
  const legacyStatusCanExpire = statusSource !== 'manual' && statusSource !== 'hard_offline';
  // 旧备份可能没有 statusSource / statusExpiresAt。这类状态不能因为
  // 缺少来源标记就变成永久状态；有时间戳时补短期限期，
  // 连时间戳也没有时只能当作已过期的兼容副本。
  const legacyStatusExpiresAt = (
    !storedExpiresAt
    && legacyStatusCanExpire
    && hasTransientStatus
  )
    ? (updatedAt > 0
      ? updatedAt + defaultStatusTtlMs(src.statusText, presenceState)
      : now)
    : 0;
  const shouldCapLegacyOnlineStatus = src.presenceState !== 'offline'
    && legacyStatusCanExpire
    && updatedAt > 0
    && storedExpiresAt > updatedAt + DEFAULT_CHAT_STATUS_TTL_MS;
  const expiresAt = legacyStatusExpiresAt || (shouldCapLegacyOnlineStatus
    ? updatedAt + DEFAULT_CHAT_STATUS_TTL_MS
    : storedExpiresAt);
  if (!expiresAt || expiresAt > now) {
    if (!legacyStatusExpiresAt && !shouldCapLegacyOnlineStatus) return { prefs: src, changed: false };
    return { prefs: { ...src, statusExpiresAt: expiresAt }, changed: true };
  }
  const next = {
    ...src,
    presenceState: 'online',
    statusText: '',
    statusSource: 'expired',
    statusExpiredAt: now,
    statusExpiresAt: 0,
  };
  return { prefs: next, changed: true };
}

export function resolveChatHeaderStatus(prefs = {}, currentContext = null) {
  const publicStatusAuthoritative = currentContext?.publicStatus?.authoritative === true;
  const livePresence = clean(currentContext?.publicStatus?.presenceState, 20);
  const livePresenceSource = clean(currentContext?.publicStatus?.presenceSource, 40);
  const livePresenceUpdatedAt = Number(currentContext?.publicStatus?.presenceUpdatedAt || 0) || 0;
  const livePresenceRoundId = clean(currentContext?.publicStatus?.presenceSourceRoundId, 120);
  // 手动保存只表示“现在先改成这个值”；只有用户亲自关闭 AI 更新时才是长期覆盖。
  // 否则旧的 manual online 会永久压住后来进入的忙碌/睡眠日程。
  const manualPresence = livePresenceSource === 'manual'
    // 旧数据没有 manualLocked 字段时仍按旧版“手动锁定”处理；新版明确写 false 才交还日程/AI。
    && currentContext?.publicStatus?.presenceManualLocked !== false;
  const storedPresenceState = normalizeChatPresence(livePresence || prefs?.presenceState);
  const publicStatus = clean(currentContext?.publicStatus?.text, 60);
  const publicStatusSource = clean(currentContext?.publicStatus?.source, 40);
  const publicStatusUpdatedAt = Number(currentContext?.publicStatus?.updatedAt || 0) || 0;
  // 角色级状态明确保存过空值（手动清空/过期）时，旧会话 statusText 只是兼容副本，
  // 不能再次回流到顶栏；只有从未建立角色级状态的旧数据才允许兜底。
  const statusText = publicStatusAuthoritative ? '' : clean(prefs?.statusText, 60);
  const phoneSchedule = currentContext?.schedule && typeof currentContext.schedule === 'object'
    ? currentContext.schedule
    : null;
  const phoneScheduleBusy = phoneSchedule?.busy === true || phoneSchedule?.isSleep === true;
  const effectiveSource = clean(currentContext?.effective?.source, 30);
  const currentEffectiveActivity = clean(currentContext?.effective?.activity, 60);
  const liveEffectiveActivity = currentEffectiveActivity
    && effectiveSource
    && effectiveSource !== 'schedule'
    && effectiveSource !== 'none'
    ? currentEffectiveActivity
    : '';
  const scenePresence = normalizeChatPresence(currentContext?.sceneFact?.availability);
  const sceneUpdatedAt = Number(currentContext?.sceneFact?.updatedAt || 0) || 0;
  const sceneRoundId = clean(currentContext?.sceneFact?.sourceRoundId, 120);
  const protectedOffline = storedPresenceState === 'offline'
    && (manualPresence || livePresenceSource === 'hard_offline');
  const effectiveOverridesSchedule = !protectedOffline && (
    effectiveSource === 'scene_fact' || effectiveSource === 'runtime'
  );
  // 独立 status 是角色对在线态的明确选择；state.status 只是一段场景文字推断。
  // 同轮或更新的显式在线态不能被场景推断遮住，否则设置页已经离线，聊天圆点仍会
  // 保持绿色直到场景快照 TTL 结束。
  const explicitPresenceSupersedesScene = effectiveSource === 'scene_fact'
    && livePresenceSource === 'ai'
    && (
      (livePresenceRoundId && sceneRoundId && livePresenceRoundId === sceneRoundId)
      || livePresenceUpdatedAt >= sceneUpdatedAt
    );
  const schedulePresence = phoneSchedule
    ? (phoneSchedule.isSleep === true ? 'offline' : (phoneScheduleBusy ? 'busy' : 'online'))
    : '';
  const scheduleUpdatedAt = Number(phoneSchedule?.updatedAt || phoneSchedule?.changedAt || 0) || 0;
  const scheduleUpdatedAtClock = clean(phoneSchedule?.updatedAtClock, 20);
  const scheduleSupersedesGeneratedPresence = !!schedulePresence
    && ['ai', 'expired', 'scene_fact_resumed'].includes(livePresenceSource)
    // presence.updatedAt 与日程 mutation updatedAt 都是设备墙钟。旧版 changedAt
    // 是按角色时区倒推的计划开始时间，没有显式 wall 标记时绝不能跨域比较。
    && scheduleUpdatedAtClock === 'wall'
    && scheduleUpdatedAt > livePresenceUpdatedAt;
  // 公开短句与在线态分开保存，但同一轮 AI 生成的“睡觉中”等短句通常会与
  // offline/busy 一起落库。日程已经跨入更新的阶段时，只修圆点会留下
  // “人已到图书馆、顶栏还在睡觉”的半旧状态；忙碌转入另一个忙碌步骤也一样。
  // 仅淘汰早于新日程的 AI 短句；用户手动短句与较新的 AI 短句仍按原优先级显示。
  const scheduleSupersedesGeneratedPublicStatus = !!publicStatus
    && publicStatusSource === 'ai'
    && scheduleSupersedesGeneratedPresence
    // 同为 busy / online 的日程内部换步骤，不代表角色主动换掉了公开短句。
    // 只有日程确实推翻了此前在线态时，才淘汰与旧在线态绑定的 AI 状态。
    && schedulePresence !== storedPresenceState
    && scheduleUpdatedAt > Math.max(publicStatusUpdatedAt, livePresenceUpdatedAt);
  const visiblePublicStatus = scheduleSupersedesGeneratedPublicStatus ? '' : publicStatus;
  // 顶栏圆点表达此刻已经发生的现实。新鲜的剧情临时场景可以覆盖较早生成的忙碌/睡眠
  // 日程；用户手动离线与 hard_offline 仍保持最高优先级。
  const presenceState = manualPresence
    ? storedPresenceState
    : (protectedOffline
    ? 'offline'
    : (effectiveOverridesSchedule && !explicitPresenceSupersedesScene
      ? (effectiveSource === 'scene_fact' ? scenePresence : storedPresenceState)
      : (scheduleSupersedesGeneratedPresence
        ? schedulePresence
        : (storedPresenceState === 'offline' || phoneSchedule?.isSleep === true
        ? 'offline'
        : (storedPresenceState === 'online' && phoneScheduleBusy ? 'busy' : storedPresenceState)))));
  // 明确下线（含 hard_offline）比普通手机日程忙碌更强，不能被“正在开会”改回忙碌点。
  if (presenceState === 'offline') {
    if (visiblePublicStatus) {
      return {
        presenceState,
        text: visiblePublicStatus,
        source: publicStatusSource || 'character_status_line',
      };
    }
    if (statusText) return { presenceState, text: statusText, source: 'chat_status' };
    const scheduleText = clean(
      phoneSchedule?.currentStep?.action || phoneSchedule?.activity,
      60,
    );
    return {
      presenceState,
      text: liveEffectiveActivity || (phoneSchedule?.isSleep === true && scheduleText ? scheduleText : '当前离线'),
      source: liveEffectiveActivity ? effectiveSource : (phoneSchedule?.isSleep === true ? 'phone_schedule' : 'presence'),
    };
  }
  // 顶栏首先是角色主动公开的状态短句。手机日程只在没有公开短句时兜底；
  // 否则同轮 status 已经落库并显示“更新了状态”，顶栏仍会被旧日程步骤压住。
  if (visiblePublicStatus) {
    return {
      presenceState,
      text: visiblePublicStatus,
      source: publicStatusSource || 'character_status_line',
    };
  }
  if (statusText) return { presenceState, text: statusText, source: 'chat_status' };
  if (phoneScheduleBusy && !effectiveOverridesSchedule) {
    const scheduleText = clean(
      phoneSchedule?.currentStep?.action || phoneSchedule?.activity,
      60,
    );
    return {
      presenceState: phoneSchedule?.isSleep === true ? 'offline' : 'busy',
      // 日程继续决定忙碌/睡眠门禁，但聊天中已经成立的实时场景决定“人正在做什么”。
      text: liveEffectiveActivity || scheduleText || (phoneSchedule?.isSleep === true ? '休息中' : '忙碌中'),
      source: liveEffectiveActivity ? effectiveSource : 'phone_schedule',
    };
  }
  // 新版角色级状态存在时，真实活动只做上下文锚点，不再回填成顶栏文案。
  if (currentContext?.publicStatus && typeof currentContext.publicStatus === 'object') {
    if (presenceState === 'busy') return { presenceState, text: '忙碌中', source: 'presence' };
    if (presenceState === 'away') return { presenceState, text: '暂时离开', source: 'presence' };
    return { presenceState, text: '当前在线', source: 'presence' };
  }
  const effectiveActivity = clean(currentContext?.effective?.activity, 60);
  if (effectiveActivity) {
    return { presenceState, text: effectiveActivity, source: currentContext?.effective?.source || 'current_fact' };
  }
  return { presenceState, text: '当前在线', source: 'presence' };
}

export async function loadChatPrefsWithExpiredStatus(chatId = '', options = {}) {
  const id = clean(chatId, 120);
  const fresh = options?.fresh === true;
  const current = fresh ? await loadChatPrefsFresh(id) : await loadChatPrefs(id);
  const { prefs, changed } = expireStatusPrefs(current);
  if (changed) {
    const statusPatch = {
      presenceState: prefs.presenceState,
      statusText: prefs.statusText,
      statusSource: prefs.statusSource,
      statusExpiredAt: prefs.statusExpiredAt,
      statusExpiresAt: prefs.statusExpiresAt,
    };
    if (fresh) {
      const result = await updateChatPrefsAtomic(id, (latest) => {
        const expired = expireStatusPrefs(latest);
        if (!expired.changed) return undefined;
        return {
          ...latest,
          presenceState: expired.prefs.presenceState,
          statusText: expired.prefs.statusText,
          statusSource: expired.prefs.statusSource,
          statusExpiredAt: expired.prefs.statusExpiredAt,
          statusExpiresAt: expired.prefs.statusExpiresAt,
        };
      });
      return result.updated ? result.value : prefs;
    }
    await patchChatPrefs(id, statusPatch);
  }
  return prefs;
}

export async function saveChatStatusWithTtl(chatId = '', patch = {}) {
  const id = clean(chatId, 120);
  const current = await loadChatPrefs(id);
  const next = withStatusTtl(current, patch);
  return patchChatPrefs(id, {
    presenceState: next.presenceState,
    statusText: next.statusText,
    statusSource: next.statusSource,
    statusUpdatedAt: next.statusUpdatedAt,
    statusExpiresAt: next.statusExpiresAt,
    actorStatusMap: next.actorStatusMap,
  });
}
