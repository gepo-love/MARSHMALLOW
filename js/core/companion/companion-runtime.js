// 陪伴运行时：scheduler tick 入口。
// 取所有 active session → policy 判定 → output 执行 → machine 记录 → 持久化 → 派发事件。
// 在 background-scheduler 的 worker / catch-up 中复用。

import { ensureDefaultUser } from '../user-slot.js';
import {
  listActiveCompanionSessions,
  saveCompanionSession,
} from './companion-session-store.js';
import {
  startSession,
  recordAiOutput,
  endSession,
  pauseSession,
  resumeSession,
  recordUserInput,
  isSessionExpired,
} from './companion-machine.js';
import { decideCompanionAction } from './companion-policy.js';
import { generateCompanionStandbyPack, runCompanionOutput } from './companion-output.js';
import { loadCompanionSettings, saveCompanionSettings, frequencyMultiplier } from './companion-settings.js';
import { buildListenTogetherContext, reconcileSessionWithPlayer } from './listen-together.js';
import { isScreenWatchSupported, getLatestScreenCapture } from '../native-screen-watch.js';
import { getCharacter } from '../character-store.js';
import { isUserRecentlyActive } from '../user-activity.js';
import { ensurePrivateChat } from '../chat-store.js';

const COMPANION_TICK_MS = 60 * 1000;
const MIN = 60 * 1000;

let _tickInFlight = false;
let _timer = null;
let _initialized = false;

async function setSleepKeepAlive(active) {
  const { setGenerationKeepAliveActive } = await import('../background-scheduler.js');
  return setGenerationKeepAliveActive(!!active);
}

function emit(name, detail) {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
}

async function latestMatchingActiveSession(userId, snapshot) {
  const sessionId = String(snapshot?.id || '').trim();
  const characterId = String(snapshot?.characterId || '').trim();
  if (!sessionId || !characterId) return null;
  const active = await listActiveCompanionSessions(userId);
  const latest = active.find((item) => String(item?.id || '') === sessionId) || null;
  if (!latest || latest.status !== 'active') return null;
  if (String(latest.characterId || '') !== characterId) return null;
  return latest;
}

function currentSessionGuard(userId, snapshot) {
  return () => latestMatchingActiveSession(userId, snapshot).then(Boolean);
}

/** 「陪你看屏幕」：读到新截屏后让角色结合画面说一句话（仅 Android 原生壳 + allowScreenAwareness）。 */
async function tickScreenWatch(user, settings, activeSessions, now = Date.now()) {
  if (!settings?.allowScreenAwareness || !isScreenWatchSupported()) return 0;
  if (!activeSessions?.length) return 0;
  if (settings.allowBubble === false) return 0;

  const intervalMs = Math.max(5, Number(settings.screenWatchIntervalMinutes || 15)) * MIN;
  const sinceComment = now - Number(settings.lastScreenCommentAt || 0);
  if (sinceComment < intervalMs) return 0;

  const capture = await getLatestScreenCapture().catch(() => ({ ok: false }));
  if (!capture?.ok || !capture.dataUrl) return 0;
  const capturedAt = Number(capture.capturedAt || 0);
  if (!capturedAt || capturedAt <= Number(settings.lastScreenCaptureUsedAt || 0)) return 0;

  let session = activeSessions.find((s) => s.status === 'active') || activeSessions[0];
  if (!session || session.status !== 'active') return 0;

  const reconciled = reconcileSessionWithPlayer(session);
  if (reconciled !== session) {
    session = await saveCompanionSession(user.id, reconciled);
  }
  const sessionCtx = buildListenTogetherContext(session);

  const out = await runCompanionOutput(session, {
    kind: 'screen_watch',
    screenImageUrl: capture.dataUrl,
  }, { settings, ...sessionCtx, isSessionCurrent: currentSessionGuard(user.id, session) });
  if (!out) return 0;

  const latest = await latestMatchingActiveSession(user.id, session);
  if (!latest) return 0;
  const next = recordAiOutput(latest, now, out, { quietHours: settings.quietHours });
  const saved = await saveCompanionSession(user.id, next);
  await saveCompanionSettings(user.id, {
    lastScreenCommentAt: now,
    lastScreenCaptureUsedAt: capturedAt,
  });
  emit('companion-tick', { sessionId: saved.id, out, reason: 'screen_watch' });
  return 1;
}

export async function tickCompanion(reason = 'timer') {
  if (_tickInFlight) return { ok: false, reason: 'in-flight' };
  _tickInFlight = true;
  try {
    const user = await ensureDefaultUser();
    const settings = await loadCompanionSettings(user.id);
    const now = Date.now();

    let active = await listActiveCompanionSessions(user.id);

    // 番茄钟到点自动结束（与主动说话开关无关）
    for (const s of active) {
      if (isSessionExpired(s)) {
        const ended = endSession(s);
        await saveCompanionSession(user.id, ended);
        emit('companion-session-changed', { reason: 'expired', session: ended });
      }
    }
    active = await listActiveCompanionSessions(user.id);

    let acted = await tickScreenWatch(user, settings, active, now);

    const hasSleepSession = active.some((session) => session.status === 'active' && session.type === 'sleep');
    if (!settings.proactiveEnabled && !hasSleepSession) return { ok: true, reason: 'disabled', count: acted };
    if (!active.length) return { ok: true, reason: 'no-active', count: acted };
    for (let session of active) {
      if (session.status !== 'active') continue;
      const reconciled = reconcileSessionWithPlayer(session);
      if (reconciled !== session) {
        session = await saveCompanionSession(user.id, reconciled);
      }
      const sessionCtx = buildListenTogetherContext(session);
      if (session.type === 'sleep') {
        const pendingAt = Number(session.context?.sleepEndPendingAt || 0);
        if (pendingAt) {
          if (Date.now() - pendingAt >= 2 * MIN) {
            const ended = endSession(session);
            await saveCompanionSession(user.id, ended);
            emit('companion-session-changed', { reason: 'sleep-idle', session: ended });
            void setSleepKeepAlive(false).catch(() => {});
          }
          continue;
        }
        const idleMinutes = Math.max(5, Math.min(120,
          Number(session.context?.sleepIdleMinutes || settings.sleepIdleMinutes || 20),
        ));
        const idleSince = Number(session.lastUserInputAt || session.startedAt || Date.now());
        if (Date.now() - idleSince >= idleMinutes * MIN) {
          const out = await runCompanionOutput(session, { kind: 'goodnight' }, {
            settings,
            ...sessionCtx,
            isSessionCurrent: currentSessionGuard(user.id, session),
          });
          if (!out) continue;
          const latest = await latestMatchingActiveSession(user.id, session);
          if (!latest) continue;
          const next = recordAiOutput(latest, Date.now(), out, { quietHours: settings.quietHours });
          next.context = { ...(next.context || {}), sleepEndPendingAt: Date.now() };
          const saved = await saveCompanionSession(user.id, next);
          emit('companion-tick', {
            sessionId: saved.id,
            out,
            reason: 'sleep-goodnight',
            endAfterPlayback: true,
          });
          acted += 1;
          continue;
        }
      }
      const intent = decideCompanionAction(session, Date.now(), {
        settings,
        frequencyMultiplier: frequencyMultiplier(settings),
      });
      if (!intent.act) continue;

      const out = await runCompanionOutput(session, intent, {
        settings,
        ...sessionCtx,
        isSessionCurrent: currentSessionGuard(user.id, session),
      });
      if (!out) continue;

      const latest = await latestMatchingActiveSession(user.id, session);
      if (!latest) continue;
      const next = recordAiOutput(latest, Date.now(), out, { quietHours: settings.quietHours });
      const saved = await saveCompanionSession(user.id, next);
      emit('companion-tick', { sessionId: saved.id, out, reason });
      if (out.chatId) {
        const {
          bumpPersistedMessagesUnread,
          notifyCharacterSentMessageIfEnabled,
          shouldNotifyForBackgroundReason,
        } = await import('../native-notifications.js');
        if (shouldNotifyForBackgroundReason(reason, out.chatId)) {
          await bumpPersistedMessagesUnread(out.chatId, out.messages).catch(() => {});
          const ch = await getCharacter(session.characterId).catch(() => null);
          await notifyCharacterSentMessageIfEnabled({
            characterName: ch?.customNickname || ch?.name || '',
            chatId: out.chatId,
            tag: `companion-proactive-${session.characterId}`,
            messages: out.messages,
            requireHidden: false,
            avatar: ch?.avatar || '',
          }).catch(() => {});
        }
      }
      acted += 1;
    }
    return { ok: true, reason, count: acted };
  } catch (err) {
    console.warn('[companion-runtime] tick failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    _tickInFlight = false;
  }
}

function startTimer() {
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (isUserRecentlyActive(12000)) return;
    tickCompanion('foreground').catch(() => {});
  }, COMPANION_TICK_MS);
}

export async function initCompanionRuntime() {
  if (_initialized) return;
  _initialized = true;
  startTimer();
  // 启动后跑一次 catch-up（开启了主动且有 active session 才会真的产出）
  setTimeout(() => tickCompanion('startup').catch(() => {}), 8000);
}

// ---- Session 生命周期对外 API（供浮窗/一起听调用） ----

export async function startCompanionSession({
  characterId,
  type = 'idle',
  mode = '',
  plannedDurationMin = 0,
  scenarioId = '',
  scenarioTitle = '',
  scenarioBackground = '',
  windowStyle = 'chat',
  context = {},
  linkedChatId = '',
} = {}) {
  const user = await ensureDefaultUser();
  const settings = await loadCompanionSettings(user.id);
  const existing = await listActiveCompanionSessions(user.id);
  for (const active of existing) {
    await saveCompanionSession(user.id, endSession(active));
  }
  if (existing.length) emit('companion-session-changed', { reason: 'end-all', count: existing.length });
  const character = await getCharacter(characterId).catch(() => null);
  const boundChat = await ensurePrivateChat(
    user.id,
    characterId,
    character?.customNickname || character?.name || '',
  );
  const session = startSession({
    userId: user.id,
    characterId,
    type,
    mode,
    plannedDurationMin,
    scenarioId,
    scenarioTitle,
    scenarioBackground,
    windowStyle,
    context,
    // 陪伴固定绑定当前角色自己的稳定私聊，禁止沿用其它角色遗留的 chatId。
    linkedChatId: boundChat?.id || linkedChatId,
    quietHours: settings.quietHours,
  });
  const saved = await saveCompanionSession(user.id, session);
  void setSleepKeepAlive(saved.type === 'sleep').catch(() => {});
  // 把陪伴角色同步到 settings.dockCharacterId，浮窗/设置页保持一致。
  await saveCompanionSettings(user.id, {
    ...(characterId && settings.dockCharacterId !== characterId ? { dockCharacterId: characterId } : {}),
    dockVisible: true,
  });
  emit('companion-session-changed', { reason: 'start', session: saved });
  prepareCompanionStandbyPack(saved.id).catch((err) => {
    console.warn('[companion-runtime] standby prepare failed', err?.message || err);
  });
  return saved;
}

export async function endCompanionSession(sessionId) {
  const user = await ensureDefaultUser();
  const list = await listActiveCompanionSessions(user.id);
  const target = list.find((s) => s.id === sessionId);
  if (!target) return null;
  const ended = endSession(target);
  const saved = await saveCompanionSession(user.id, ended);
  if (target.type === 'sleep') void setSleepKeepAlive(false).catch(() => {});
  const remaining = await listActiveCompanionSessions(user.id);
  if (!remaining.length) await saveCompanionSettings(user.id, { dockVisible: false });
  emit('companion-session-changed', { reason: 'end', session: saved });
  return saved;
}

/** 关闭浮窗时收纳所有进行中的陪伴 session（暂停/番茄钟/一起听等） */
export async function endAllActiveCompanionSessions(userId = '') {
  const user = userId
    ? { id: String(userId).trim() }
    : await ensureDefaultUser();
  if (!user?.id) return 0;
  const active = await listActiveCompanionSessions(user.id);
  if (!active.length) return 0;
  for (const session of active) {
    const ended = endSession(session);
    await saveCompanionSession(user.id, ended);
  }
  if (active.some((session) => session.type === 'sleep')) {
    void setSleepKeepAlive(false).catch(() => {});
  }
  await saveCompanionSettings(user.id, { dockVisible: false });
  emit('companion-session-changed', { reason: 'end-all', count: active.length });
  return active.length;
}

export async function pauseCompanionSession(sessionId) {
  const user = await ensureDefaultUser();
  const list = await listActiveCompanionSessions(user.id);
  const target = list.find((s) => s.id === sessionId);
  if (!target) return null;
  const saved = await saveCompanionSession(user.id, pauseSession(target));
  emit('companion-session-changed', { reason: 'pause', session: saved });
  return saved;
}

export async function resumeCompanionSession(sessionId) {
  const user = await ensureDefaultUser();
  const list = await listActiveCompanionSessions(user.id);
  const target = list.find((s) => s.id === sessionId);
  if (!target) return null;
  const settings = await loadCompanionSettings(user.id);
  const saved = await saveCompanionSession(
    user.id,
    resumeSession(target, Date.now(), { quietHours: settings.quietHours }),
  );
  emit('companion-session-changed', { reason: 'resume', session: saved });
  return saved;
}

// 用户主动戳一下浮窗：记录输入（让 AI 暂时不要催）。
export async function noteUserInput(sessionId, text = '') {
  const user = await ensureDefaultUser();
  const list = await listActiveCompanionSessions(user.id);
  const target = list.find((s) => s.id === sessionId);
  if (!target) return null;
  const next = recordUserInput(target, Date.now(), text);
  if (next.type === 'sleep' && next.context?.sleepEndPendingAt) {
    next.context = { ...(next.context || {}), sleepEndPendingAt: 0 };
  }
  return saveCompanionSession(user.id, next);
}

export async function prepareCompanionStandbyPack(sessionId, opts = {}) {
  const user = await ensureDefaultUser();
  const settings = await loadCompanionSettings(user.id);
  const list = await listActiveCompanionSessions(user.id);
  const session = list.find((s) => s.id === sessionId);
  if (!session) throw new Error('陪伴会话不存在');
  const existing = session.context?.standbyPack;
  if (!opts.force && Array.isArray(existing?.voiceSegments) && existing.voiceSegments.length) {
    return existing;
  }
  const sessionCtx = buildListenTogetherContext(session);
  const pack = await generateCompanionStandbyPack(session, { settings, ...sessionCtx });
  // 待机包生成可能比通话开场/用户回复慢。保存前必须重新读取最新 session，
  // 否则这里拿启动时的旧快照回写，会把生成期间新增的 outputs / userInputs 整段覆盖掉。
  const latest = (await listActiveCompanionSessions(user.id)).find((item) => item.id === sessionId) || session;
  const next = {
    ...latest,
    context: {
      ...(latest.context || {}),
      standbyPack: {
        generatedAt: pack.generatedAt || Date.now(),
        cursor: 0,
        voiceSegments: pack.voiceSegments || [],
        bubbles: pack.bubbles || [],
        text: pack.text || '',
      },
    },
    updatedAt: Date.now(),
  };
  const saved = await saveCompanionSession(user.id, next);
  emit('companion-session-changed', { reason: 'standby', session: saved });
  return saved.context.standbyPack;
}

export async function advanceCompanionStandbyCursor(sessionId, cursor = 0) {
  const user = await ensureDefaultUser();
  const list = await listActiveCompanionSessions(user.id);
  const session = list.find((s) => s.id === sessionId);
  const pack = session?.context?.standbyPack;
  if (!session || !pack) return null;
  const count = Array.isArray(pack.voiceSegments) ? pack.voiceSegments.length : 0;
  const nextCursor = count ? ((Number(cursor) || 0) % count + count) % count : 0;
  const saved = await saveCompanionSession(user.id, {
    ...session,
    context: {
      ...(session.context || {}),
      standbyPack: {
        ...pack,
        cursor: nextCursor,
      },
    },
  });
  emit('companion-session-changed', { reason: 'standby-cursor', session: saved });
  return saved.context.standbyPack;
}

// 测试 / 手动让陪伴说一句（不受冷却限制，只受 settings.proactiveEnabled & kind 开关限制）。
export async function nudgeCompanion(sessionId, kind = 'bubble') {
  const user = await ensureDefaultUser();
  const settings = await loadCompanionSettings(user.id);
  if (!settings.proactiveEnabled && kind === 'auto') throw new Error('主动说话总开关已关闭');
  const list = await listActiveCompanionSessions(user.id);
  const session = list.find((s) => s.id === sessionId);
  if (!session) throw new Error('陪伴会话不存在');
  const sessionCtx = buildListenTogetherContext(session);
  let out = null;
  try {
    out = await runCompanionOutput(session, { kind }, {
      settings,
      ...sessionCtx,
      isSessionCurrent: currentSessionGuard(user.id, session),
    });
  } catch (cause) {
    const err = new Error(cause?.message || '陪伴发言生成失败');
    err.code = 'AI_OUTPUT_FAILED';
    err.cause = cause;
    throw err;
  }
  if (!out) {
    const err = new Error('没有生成可显示的陪伴发言');
    err.code = 'NO_OUTPUT';
    throw err;
  }
  const latest = await latestMatchingActiveSession(user.id, session);
  if (!latest) {
    const err = new Error('陪伴角色已切换，本次迟到回复已取消');
    err.code = 'STALE_COMPANION_SESSION';
    throw err;
  }
  const next = recordAiOutput(latest, Date.now(), out, { quietHours: settings.quietHours });
  const saved = await saveCompanionSession(user.id, next);
  emit('companion-tick', { sessionId: saved.id, out, reason: 'nudge' });
  return out;
}

export { COMPANION_TICK_MS };
