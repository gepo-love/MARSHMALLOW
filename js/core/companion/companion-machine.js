// 陪伴 session 状态机（纯函数）。所有迁移返回新对象，不产生副作用。
// 「下次触发时间」在这里统一计算，policy 只读时间差。
// 详见 docs/companion-architecture.md §3。

import { rhythmFor, QUIET_MULTIPLIER, isQuietHour } from './companion-policy.js';
import { extractCompanionText, sanitizeCompanionSpeechText } from './companion-values.js';

const SESSION_TYPES = new Set([
  'idle', 'sleep', 'listen_together', 'focus', 'voice_live', 'co_work', 'cooking', 'reading', 'pomodoro', 'custom',
]);

const SESSION_MODES = new Set(['pomodoro', 'ambient']);

const MAX_OUTPUTS = 100;

function genId(prefix = 'cmp') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function randomInWindow([a, b], rand = Math.random) {
  return Math.round(a + (b - a) * rand());
}

function cleanVisibleText(value = '') {
  return sanitizeCompanionSpeechText(extractCompanionText(value, { max: 4000 }), { max: 4000 })
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/<thinking>[\s\S]*$/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^(?:analysis|reasoning|thinking|thought|思考|推理|分析)\s*[:：]/i.test(line)) return false;
      if (/^\s*(?:气泡|bubble|bubbles|回复|text|voiceText|语音文本|正文)\s*[:：]\s*/i.test(line)) return true;
      if (/^(?:我|我们|现在)?(?:需要|要|应该|先|接下来|可以)(?:分析|推理|判断|构思|思考|生成|输出)/.test(line)) return false;
      return true;
    })
    .join('\n')
    .replace(/^\s*(?:气泡|bubble|bubbles|回复|text|voiceText|语音文本|正文)\s*[:：]\s*/i, '')
    .trim();
}

// 依据 type + 安静时段，算下一次「软到点」时间。
export function scheduleNextAmbient(session, now = Date.now(), opts = {}) {
  const rhythm = rhythmFor(session.type);
  const quiet = opts.quiet ?? isQuietHour(now, opts.quietHours);
  const mult = quiet ? QUIET_MULTIPLIER : 1;
  const rand = opts.rand || Math.random;
  return now + randomInWindow(rhythm.window, rand) * mult;
}

export function startSession(input = {}, now = Date.now()) {
  const type = SESSION_TYPES.has(input.type) ? input.type : 'idle';
  const mode = SESSION_MODES.has(input.mode) ? input.mode : (type === 'listen_together' ? 'ambient' : 'pomodoro');
  const plannedMin = mode === 'pomodoro'
    ? Math.max(5, Math.min(180, Number(input.plannedDurationMin) || 25))
    : 0;
  const base = {
    id: input.id || genId(),
    userId: String(input.userId || '').trim(),
    characterId: String(input.characterId || '').trim(),
    type,
    mode,
    status: 'active',
    startedAt: now,
    updatedAt: now,
    endedAt: 0,
    plannedDurationMin: plannedMin,
    endsAt: plannedMin ? now + plannedMin * 60 * 1000 : 0,
    pausedAt: 0,
    pausedMs: 0,
    scenarioId: String(input.scenarioId || '').trim(),
    scenarioTitle: String(input.scenarioTitle || '').trim(),
    scenarioBackground: String(input.scenarioBackground || '').trim(),
    windowStyle: input.windowStyle === 'video' ? 'video' : (input.windowStyle === 'call' ? 'call' : 'chat'),
    lastUserInputAt: 0,
    lastAiSpokeAt: 0,
    nextAmbientAt: 0,
    nextCheckInAt: 0,
    currentTrackId: String(input.context?.currentTrackId || input.currentTrackId || ''),
    trackStartedAt: input.context?.currentTrackId ? now : 0,
    commentCountForCurrentTrack: 0,
    context: {
      userActivity: String(input.context?.userActivity || input.scenarioDescription || ''),
      focusGoal: String(input.context?.focusGoal || ''),
      mood: String(input.context?.mood || ''),
      lyricCursorMs: 0,
      backgroundSoundId: '',
      ...(input.context || {}),
    },
    participants: Array.isArray(input.participants) && input.participants.length
      ? input.participants
      : [String(input.characterId || '').trim()].filter(Boolean),
    linkedChatId: String(input.linkedChatId || ''),
    outputs: [],
    userInputs: [],
  };
  base.nextAmbientAt = scheduleNextAmbient(base, now, { quietHours: input.quietHours });
  return base;
}

export function pauseSession(session, now = Date.now()) {
  if (session?.status === 'paused') return { ...session, updatedAt: now };
  return { ...session, status: 'paused', pausedAt: now, updatedAt: now };
}

export function resumeSession(session, now = Date.now(), opts = {}) {
  const pausedAt = Number(session?.pausedAt || 0) || 0;
  const delta = pausedAt ? Math.max(0, now - pausedAt) : 0;
  const next = {
    ...session,
    status: 'active',
    pausedAt: 0,
    pausedMs: Math.max(0, Number(session?.pausedMs || 0) || 0) + delta,
    endsAt: session?.endsAt ? Number(session.endsAt) + delta : 0,
    updatedAt: now,
  };
  next.nextAmbientAt = scheduleNextAmbient(next, now, opts);
  return next;
}

export function endSession(session, now = Date.now()) {
  return { ...session, status: 'ended', endedAt: now, updatedAt: now };
}

export function recordUserInput(session, now = Date.now(), text = '') {
  // 用户刚说话：更新指针并把下次主动时间往后推，不要马上追问。
  const trimmed = String(text || '').trim();
  const next = { ...session, lastUserInputAt: now, updatedAt: now };
  if (trimmed) {
    next.userInputs = [...(session.userInputs || []), { at: now, text: trimmed }].slice(-100);
  }
  next.nextAmbientAt = scheduleNextAmbient(next, now);
  return next;
}

// 番茄钟模式：判断 session 是否已经超过计划时长，应自动结束。
export function isSessionExpired(session, now = Date.now()) {
  return !!(session?.status !== 'paused' && session?.mode === 'pomodoro' && session?.endsAt && now >= session.endsAt);
}

export function recordAiOutput(session, now = Date.now(), output = {}, opts = {}) {
  const entry = {
    at: now,
    kind: String(output.kind || 'speech'),
    text: cleanVisibleText(output.text || ''),
    bubbles: Array.isArray(output.bubbles) ? output.bubbles.map((x) => cleanVisibleText(x || '')).filter(Boolean).slice(0, 8) : [],
    voiceText: cleanVisibleText(output.voiceText || ''),
    voiceSegments: Array.isArray(output.voiceSegments)
      ? output.voiceSegments.map((item) => ({
        text: cleanVisibleText(item?.text || ''),
        translation: String(item?.translation || '').trim(),
        audioDataUrl: String(item?.audioDataUrl || ''),
        audioMimeType: String(item?.audioMimeType || ''),
        audioCacheKey: String(item?.audioCacheKey || ''),
        audioFromCache: item?.audioFromCache === true,
        ttsError: String(item?.ttsError || ''),
      })).filter((item) => item.text).slice(0, 8)
      : [],
    trackId: String(output.trackId || ''),
    audioDataUrl: String(output.audioDataUrl || ''),
    audioMimeType: String(output.audioMimeType || ''),
  };
  const next = {
    ...session,
    lastAiSpokeAt: now,
    updatedAt: now,
    outputs: [...(session.outputs || []), entry].slice(-MAX_OUTPUTS),
  };
  if (session.type === 'listen_together') {
    next.commentCountForCurrentTrack = Number(session.commentCountForCurrentTrack || 0) + 1;
  }
  next.nextAmbientAt = scheduleNextAmbient(next, now, opts);
  return next;
}

export function onTrackChange(session, trackId, now = Date.now()) {
  return {
    ...session,
    currentTrackId: String(trackId || ''),
    trackStartedAt: now,
    commentCountForCurrentTrack: 0,
    updatedAt: now,
  };
}

export { SESSION_TYPES, SESSION_MODES };
