import { loadChatPrefs, patchChatPrefs } from '../chat-block-state.js';
import { recordCharacterPresence } from '../character-live-state.js';

export const HARD_OFFLINE_MIN_MINUTES = 30;
export const HARD_OFFLINE_MAX_MINUTES = 14 * 24 * 60;

const PEEK_ALLOWED_SIDE_EFFECTS = Object.freeze([
  'status',
  'schedule_change',
  'memo',
  'radio_plan',
  'social_post',
  'social_react',
  'backstage',
  'peer_private',
  'open_alias',
  'alias_poke',
]);

function clean(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function clampMinutes(value, min = HARD_OFFLINE_MIN_MINUTES, max = HARD_OFFLINE_MAX_MINUTES) {
  const minutes = Math.trunc(Number(value || 0));
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.max(min, Math.min(max, minutes));
}

export function normalizeHardOfflineEvent(event = {}, options = {}) {
  if (event?.t !== 'hard_offline') return null;
  const actorId = clean(event.from || event.actor);
  const participants = new Set((options.chat?.participants || []).map((id) => clean(id)).filter(Boolean));
  const action = clean(event.action).toLowerCase() === 'clear' ? 'clear' : 'start';
  const minutes = clampMinutes(event.minutes || event.durationMinutes);
  if (!actorId || actorId === 'user' || (participants.size && !participants.has(actorId))) return null;
  if (action === 'start' && !minutes) return null;
  const rawPeekMinutes = Math.trunc(Number(event.peekMinutes || 0));
  const peekMinutes = Number.isFinite(rawPeekMinutes)
    && rawPeekMinutes >= 15
    && rawPeekMinutes < minutes
    ? rawPeekMinutes
    : 0;
  return {
    actorId,
    action,
    minutes,
    peekMinutes,
    reason: clean(event.reason || event.intent, 300),
  };
}

export function normalizeHardOfflineState(raw = {}, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const actorId = clean(raw.actorId);
  const untilAt = Math.trunc(Number(raw.untilAt || 0));
  if (!actorId || !untilAt || untilAt <= now) return null;
  const startedAt = Math.max(0, Math.trunc(Number(raw.startedAt || 0)));
  const nextPeekAt = Math.max(0, Math.trunc(Number(raw.nextPeekAt || 0)));
  return {
    version: 1,
    actorId,
    reason: clean(raw.reason, 300),
    startedAt,
    untilAt,
    nextPeekAt: nextPeekAt > now && nextPeekAt < untilAt ? nextPeekAt : 0,
    peekedAt: Math.max(0, Math.trunc(Number(raw.peekedAt || 0))),
    sourceAiRoundId: clean(raw.sourceAiRoundId),
  };
}

export async function loadActiveHardOfflineState(chatId, now = Date.now(), options = {}) {
  const id = clean(chatId);
  if (!id) return null;
  const prefs = options.prefs || await loadChatPrefs(id).catch(() => ({}));
  const state = normalizeHardOfflineState(prefs?.hardOfflineState, now);
  if (!state && prefs?.hardOfflineState && options.clearExpired !== false) {
    await patchChatPrefs(id, { hardOfflineState: null }).catch(() => {});
  }
  return state;
}

export async function isHardOfflineActiveForChat(userId, chat, now = Date.now(), options = {}) {
  const uid = clean(userId);
  if (!uid || !chat?.id || chat.type !== 'private' || !(chat.participants || []).includes('user')) return null;
  const actorId = clean((chat.participants || []).find((id) => id && id !== 'user'));
  if (!actorId) return null;
  let allowed = options.allowed;
  if (allowed == null) {
    try {
      const { loadResolvedCharacterAutonomyPolicy } = await import('../character-autonomy-settings.js');
      const policy = options.policy
        || await loadResolvedCharacterAutonomyPolicy(uid, actorId, chat.id);
      allowed = policy?.realPersonMode?.enabled === true
        && policy?.realPersonMode?.allowHardOffline === true;
    } catch (_) {
      allowed = false;
    }
  }
  if (!allowed) {
    const prefs = options.prefs || await loadChatPrefs(chat.id).catch(() => ({}));
    if (prefs?.hardOfflineState) {
      await patchChatPrefs(chat.id, { hardOfflineState: null }).catch(() => {});
    }
    return null;
  }
  const state = await loadActiveHardOfflineState(chat.id, now, options);
  return state?.actorId === actorId ? state : null;
}

export function buildHardOfflineContextLine(state, now = Date.now()) {
  const active = normalizeHardOfflineState(state, now);
  if (!active) return '';
  const remainingMinutes = Math.max(1, Math.ceil((active.untilAt - now) / 60000));
  return [
    `完全下线仍有效：约剩 ${remainingMinutes} 分钟。原因：${active.reason || '你决定暂时不看这段聊天'}。`,
    '自动接话会被系统硬拦；本轮只有用户手动点了「推进」才会发生。你可以按人物和剧情决定现在仍不回复、提前回来，或重新登记 hard_offline 延长离开；不要误以为对方多发几条就能把你戳醒。',
  ].join('\n');
}

export async function applyMarshmallowHardOfflineEvents(events = [], options = {}, overrides = {}) {
  const userId = clean(options.userId || options.user?.id);
  const chat = options.chat || options.sourceChat || null;
  const now = Math.trunc(Number(options.now || Date.now()));
  const items = (Array.isArray(events) ? events : [])
    .map((event) => normalizeHardOfflineEvent(event, { chat }))
    .filter(Boolean);
  if (!userId || !chat?.id || chat.type !== 'private' || !(chat.participants || []).includes('user') || !items.length) {
    return { handled: 0, skipped: items.length, errors: [] };
  }
  const enabled = overrides.isEnabled
    ? await overrides.isEnabled(userId, chat)
    : await (async () => {
      try {
        const { loadResolvedCharacterAutonomyPolicy } = await import('../character-autonomy-settings.js');
        const actorId = clean((chat.participants || []).find((id) => id && id !== 'user'));
        const policy = await loadResolvedCharacterAutonomyPolicy(userId, actorId, chat.id);
        return policy?.realPersonMode?.enabled === true
          && policy?.realPersonMode?.allowHardOffline === true;
      } catch (_) {
        return false;
      }
    })();
  if (!enabled) return { handled: 0, skipped: items.length, errors: [] };

  // 一轮只认最后一次决定，允许模型在同轮修正时长。
  const item = items[items.length - 1];
  if (item.action === 'clear') {
    await (overrides.saveState || ((next) => patchChatPrefs(chat.id, { hardOfflineState: next })))(null);
    await (overrides.recordPresence || recordCharacterPresence)(
      userId,
      item.actorId,
      'online',
      { source: 'hard_offline_clear', sourceChatId: chat.id, updatedAt: now },
    ).catch(() => null);
    return { handled: 1, skipped: Math.max(0, items.length - 1), state: null, cleared: true, errors: [] };
  }
  const untilAt = now + item.minutes * 60 * 1000;
  const state = {
    version: 1,
    actorId: item.actorId,
    reason: item.reason,
    startedAt: now,
    untilAt,
    nextPeekAt: item.peekMinutes > 0 ? now + item.peekMinutes * 60 * 1000 : 0,
    peekedAt: 0,
    sourceAiRoundId: clean(options.aiRoundId),
  };
  const saveState = overrides.saveState || ((next) => patchChatPrefs(chat.id, { hardOfflineState: next }));
  await saveState(state);

  // 完全下线优先级高于所有旧的“稍后回来/追发”票；连发不能再把旧票震醒。
  const cancel = overrides.cancelPending || (async (...args) => {
    const { cancelPendingActions } = await import('./pending-actions.js');
    return cancelPendingActions(...args);
  });
  await cancel(userId, (action) => (
    action.chatId === chat.id
    && ['delayed_reply', 'chase_beat', 'cold_follow_up'].includes(action.kind)
  )).catch(() => {});
  // 完全下线不是“系统挡刀”：清掉此前登记的自动回复和戳醒账本，
  // 否则到期后第一条用户消息可能突然弹出离开前的旧文案。
  try {
    const { loadCharacterPhone, saveCharacterPhone } = await import('../character-phone-store.js');
    const phone = await loadCharacterPhone(userId, item.actorId);
    if (phone?.sessionAutoReply?.text || phone?.busyAutoReplyState) {
      await saveCharacterPhone({
        ...phone,
        sessionAutoReply: null,
        busyAutoReplyState: {
          ...(phone.busyAutoReplyState || {}),
          sparseUntil: 0,
          sparseStartedAt: 0,
          wokeKey: '',
          silentNoCopy: false,
          lastRepliedAt: 0,
        },
      });
    }
  } catch (_) { /* 手机档清理失败不影响硬静默本体 */ }
  import('../cloud-background-coordinator.js')
    .then((mod) => mod.cancelCloudChatSchedules?.(chat.id))
    .catch(() => {});

  // 完全下线只更新回复可用性；公开短句由角色自行决定，二者互不覆盖。
  await (overrides.recordPresence || recordCharacterPresence)(
    userId,
    item.actorId,
    'offline',
    {
      source: 'hard_offline',
      sourceChatId: chat.id,
      sourceRoundId: options.aiRoundId,
      updatedAt: now,
      expiresAt: untilAt,
    },
  ).catch(() => null);
  return { handled: 1, skipped: Math.max(0, items.length - 1), state, errors: [] };
}

/**
 * 到 AI 自己选的“扫一眼”节点时，只允许做非当前私聊动作。
 * 代码层强制丢弃所有可见气泡，并限制 side effect 白名单，模型即使误输出 msg/private_msg 也不会送达用户。
 */
export async function maybeRunHardOfflinePeek(chat, user, options = {}) {
  const now = Math.trunc(Number(options.now || Date.now()));
  const state = await isHardOfflineActiveForChat(user?.id, chat, now, options);
  if (!state?.nextPeekAt || state.nextPeekAt > now || state.peekedAt > 0) {
    return { ok: false, skipped: true, reason: state ? 'peek-not-due' : 'hard-offline-inactive' };
  }
  const actorId = String((chat?.participants || []).find((id) => id && id !== 'user') || '').trim();
  const { loadResolvedCharacterAutonomyPolicy } = await import('../character-autonomy-settings.js');
  const policy = actorId
    ? await loadResolvedCharacterAutonomyPolicy(user?.id, actorId, chat?.id || '').catch(() => null)
    : null;
  if (policy?.totalEnabled !== true) {
    return { ok: false, skipped: true, reason: 'proactive-disabled' };
  }
  // 先销票，防前后台同时触发重复扫一眼；生成失败也不重试，保持“可能扫一眼”而非强制任务。
  await patchChatPrefs(chat.id, {
    hardOfflineState: {
      ...state,
      nextPeekAt: 0,
      peekedAt: now,
    },
  });
  const { runHeadlessChatReply } = await import('./headless-reply.js');
  return runHeadlessChatReply(chat, user, {
    allowInactive: true,
    skipBusyAutoReply: true,
    bypassHardOffline: true,
    suppressVisibleMessages: true,
    allowedSideEffectTypes: PEEK_ALLOWED_SIDE_EFFECTS,
    reason: 'real-person-hard-offline-peek',
    proactiveChannel: 'hard-offline-peek',
    proactiveIdempotencyKey: `${chat.id}:${Number(state.nextPeekAt || now)}`,
    sceneDirective: [
      '你仍处于自己决定的完全下线期，没有恢复这段私聊，也不能回复对方。',
      `你此前离开的原因：${state.reason || '暂时不看这段聊天'}。`,
      '这一轮只是你偶尔扫到手机/短暂拿回手机后的后台生活判断：可以改顶栏状态、调整日程、记备忘、发动态、点赞评论，或去别的窗口说话；也可以什么都不做。',
      '硬规则：禁止向当前用户发送 msg、sticker、voice、private_msg、nudge、链接或任何可见回复；不要用其它动作绕过这条规则。',
    ].join('\n'),
  });
}
