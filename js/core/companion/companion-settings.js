// 陪伴功能的所有用户开关与频率档位。
// 主动说话默认 **关闭**：用户必须在浮窗设置里显式打开「主动说话」总开关，
// 各项 kind 才会真正产出。详见 docs/companion-architecture.md §10。

import { get as dbGet, put as dbPut } from '../db.js';

const KEY_PREFIX = 'companionSettings_';

function prefersNativeOverlayByDefault() {
  if (typeof window === 'undefined') return false;
  return window.Capacitor?.getPlatform?.() === 'android'
    && !!window.Capacitor?.Plugins?.MarshmallowOverlay;
}

export const FREQUENCY_PRESETS = {
  low: { label: '低频', multiplier: 1.6 },
  normal: { label: '日常', multiplier: 1 },
  high: { label: '热闹', multiplier: 0.6 },
};

export const DEFAULT_COMPANION_SETTINGS = Object.freeze({
  proactiveEnabled: false,        // 主动说话总开关
  allowBubble: true,
  allowChat: true,
  allowMusicPost: true,
  allowSpeechTts: false,          // TTS 默认关
  allowVoiceInput: false,         // STT 默认关
  allowScreenAwareness: false,    // 屏幕感知（陪你看屏幕）默认关，仅 Android 原生壳生效
  screenWatchIntervalMinutes: 15, // 定时截屏间隔（分钟），5-120
  confirmBeforeSendVoice: true,   // STT 转写默认让用户确认
  nativeOverlayEnabled: false,    // 网页默认关；Android 原生壳在用户未选择过时默认开
  nativeOverlayPreferenceSet: false,
  windowStyle: 'chat',            // 'chat' 聊天小窗 | 'call' 语音通话 | 'video' 视频通话
  callReplyDisplayMode: 'segments', // 'segments' 多段显示 | 'single' 整段显示（只影响展示，不合并 TTS）
  lastScreenCommentAt: 0,         // 上次「陪你看屏幕」评论时间戳（ms）
  lastScreenCaptureUsedAt: 0,     // 已消费过的截屏 capturedAt，避免同一张图重复评论
  frequency: 'normal',            // 'low' | 'normal' | 'high'
  proactiveProbability: 70,        // 每次到点后真正开口的概率（0-100）
  cooldownMinutes: 0,              // 0 表示按场景默认冷却
  guaranteeMinutes: 30,            // 距离上次说话超过该值后保底开口；0 关闭
  sleepIdleMinutes: 20,            // 哄睡无回应多久后留下晚安并结束
  quietHours: { start: 23, end: 7 },
  dockVisible: false,             // 浮窗默认关闭，用户在「陪伴助手」设置页里手动开
  dockCharacterId: '',            // 选中的陪伴角色 id
  dockAvatarOverride: '',         // 陪伴专属头像（dataURL / URL），若空则用角色自带头像
  listenBackground: '',           // 一起听沉浸页背景（dataURL / URL）
});

function settingsKey(userId) {
  return `${KEY_PREFIX}${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function normalize(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const freq = String(src.frequency || '').toLowerCase();
  const quiet = (src.quietHours && typeof src.quietHours === 'object') ? src.quietHours : {};
  const qStart = Number(quiet.start);
  const qEnd = Number(quiet.end);
  return {
    proactiveEnabled: src.proactiveEnabled === true,
    allowBubble: src.allowBubble !== false,
    allowChat: src.allowChat !== false,
    allowMusicPost: src.allowMusicPost !== false,
    allowSpeechTts: src.allowSpeechTts === true,
    allowVoiceInput: src.allowVoiceInput === true,
    allowScreenAwareness: src.allowScreenAwareness === true,
    screenWatchIntervalMinutes: clampNumber(src.screenWatchIntervalMinutes, 5, 120, DEFAULT_COMPANION_SETTINGS.screenWatchIntervalMinutes),
    confirmBeforeSendVoice: src.confirmBeforeSendVoice !== false,
    nativeOverlayEnabled: src.nativeOverlayPreferenceSet === true
      ? src.nativeOverlayEnabled === true
      : (prefersNativeOverlayByDefault() || src.nativeOverlayEnabled === true),
    nativeOverlayPreferenceSet: src.nativeOverlayPreferenceSet === true,
    windowStyle: src.windowStyle === 'video' ? 'video' : (src.windowStyle === 'call' ? 'call' : 'chat'),
    callReplyDisplayMode: normalizeCompanionReplyDisplayMode(src.callReplyDisplayMode),
    lastScreenCommentAt: clampNumber(src.lastScreenCommentAt, 0, Number.MAX_SAFE_INTEGER, 0),
    lastScreenCaptureUsedAt: clampNumber(src.lastScreenCaptureUsedAt, 0, Number.MAX_SAFE_INTEGER, 0),
    frequency: FREQUENCY_PRESETS[freq] ? freq : DEFAULT_COMPANION_SETTINGS.frequency,
    proactiveProbability: clampNumber(src.proactiveProbability, 0, 100, DEFAULT_COMPANION_SETTINGS.proactiveProbability),
    cooldownMinutes: clampNumber(src.cooldownMinutes, 0, 180, DEFAULT_COMPANION_SETTINGS.cooldownMinutes),
    guaranteeMinutes: clampNumber(src.guaranteeMinutes, 0, 360, DEFAULT_COMPANION_SETTINGS.guaranteeMinutes),
    sleepIdleMinutes: clampNumber(src.sleepIdleMinutes, 5, 120, DEFAULT_COMPANION_SETTINGS.sleepIdleMinutes),
    quietHours: {
      start: Number.isFinite(qStart) ? Math.max(0, Math.min(23, qStart)) : DEFAULT_COMPANION_SETTINGS.quietHours.start,
      end: Number.isFinite(qEnd) ? Math.max(0, Math.min(23, qEnd)) : DEFAULT_COMPANION_SETTINGS.quietHours.end,
    },
    dockVisible: src.dockVisible === true,
    dockCharacterId: String(src.dockCharacterId || '').trim(),
    dockAvatarOverride: String(src.dockAvatarOverride || '').trim(),
    listenBackground: String(src.listenBackground || '').trim(),
  };
}

export function normalizeCompanionReplyDisplayMode(value = '') {
  return String(value || '').trim() === 'single' ? 'single' : 'segments';
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function loadCompanionSettings(userId) {
  const row = await dbGet('settings', settingsKey(userId)).catch(() => null);
  return normalize(row?.value);
}

export async function saveCompanionSettings(userId, patch = {}) {
  const current = await loadCompanionSettings(userId);
  const marksNativePreference = Object.prototype.hasOwnProperty.call(patch, 'nativeOverlayEnabled');
  const next = normalize({
    ...current,
    ...patch,
    nativeOverlayPreferenceSet: marksNativePreference ? true : current.nativeOverlayPreferenceSet,
  });
  await dbPut('settings', { key: settingsKey(userId), value: next });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('companion-settings-changed', { detail: { userId, settings: next } }));
  }
  return next;
}

export function frequencyMultiplier(settings) {
  return FREQUENCY_PRESETS[settings?.frequency]?.multiplier ?? 1;
}

// 用一句话描述设置当前会让哪些 kind 真正落地（用于浮窗状态栏）。
export function describeEnabledKinds(settings) {
  if (!settings?.proactiveEnabled) return '主动说话已关闭';
  const parts = [];
  if (settings.allowBubble) parts.push('气泡');
  if (settings.allowChat) parts.push('聊天');
  if (settings.allowMusicPost) parts.push('广场');
  if (settings.allowSpeechTts) parts.push('TTS');
  return parts.length ? parts.join(' · ') : '所有输出已关闭';
}
