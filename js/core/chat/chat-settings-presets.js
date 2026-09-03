import { get, put } from '../db.js';
import {
  memoryInjectionSettingsPatch,
  normalizeMemoryInjectionSettings,
} from '../memory/memory-injection-settings.js';
import { DEFAULT_INNER_VOICE_INJECT_COUNT } from './inner-voice-history-settings.js';
import { promptProfilePrefsPatch, resolvePromptProfile } from '../prompt-profile.js';

export const CHAT_SETTINGS_PRESETS_KEY = 'chatSettingsPresets:v1';
export const CHAT_SETTINGS_PRESET_KINDS = ['private', 'group'];

export const CHAT_SETTINGS_PRESET_PREF_DEFAULTS = Object.freeze({
  promptProfile: 'v2',
  lightweightPromptEnabled: true,
  thinkingPromptMode: 'default',
  thinkingPromptCustom: '',
  variedRhythmReply: true,
  bubbleRangeEnabled: false,
  bubbleRangeMin: 1,
  bubbleRangeMax: 6,
  shortBubbleReply: false,
  messageTimestampMode: 'last',
  callProactiveSpeechEnabled: false,
  callProactiveIntervalSeconds: 60,
  callAiHangupEnabled: false,
  callReplyDisplayMode: 'segments',
  showChatSpark: false,
  voiceBubblePreference: '',
  voicePerformanceMode: false,
  voicePerformanceContinuous: false,
  voicePerformanceBubbleGapMs: 400,
  narrationSoundEffectsEnabled: false,
  narrationSoundEffectsVolume: 58,
  narrationBackgroundVolume: 22,
  parallelWorldMode: false,
  longDistanceMode: false,
  dialoguePresentationMode: false,
  narrationMode: false,
  narrationUserPerson: 'second',
  timezoneEnabled: false,
  characterTimezone: '',
  statusStoryMode: false,
  chatImageGenEnabled: false,
  stickerVisionEnabled: false,
  stickerGifFirstFrameEnabled: false,
  innerVoiceInjectCount: DEFAULT_INNER_VOICE_INJECT_COUNT,
  innerVoiceDisabled: false,
  innerVoiceHidden: false,
  innerVoiceInjectEnabled: true,
  seeUserAvatar: false,
  stickerFrequency: 'normal',
  inlineEmoteFrequency: 'normal',
  allowAiReact: false,
  aiReactFrequency: 'normal',
  aiReactKind: 'emoji',
  preferSafeEmoji: false,
  chaseBeatMaxRounds: 3,
  chaseMinIntervalMinutes: 20,
  autoSummary: false,
  autoSummaryFreq: 100,
  contextDepth: 100,
  worldBookIds: Object.freeze([]),
  mainApiPresetId: '',
  // null = 跟随全局线上预设；数组（含空数组）= 本会话使用独立绑定。
  onlinePresetIds: null,
});

/**
 * 设置预设保存可迁移的会话参数。显式互通窗口 ID 属于具体会话关系，不能随预设复制。
 */
export function pickChatSettingsPresetPrefs(prefs = {}) {
  const source = object(prefs);
  const picked = Object.fromEntries(Object.entries(CHAT_SETTINGS_PRESET_PREF_DEFAULTS).map(([key, fallback]) => [
    key,
    Object.prototype.hasOwnProperty.call(source, key) ? clone(source[key]) : clone(fallback),
  ]));
  if (source.innerVoiceInjectCount === undefined) {
    picked.innerVoiceInjectCount = DEFAULT_INNER_VOICE_INJECT_COUNT;
  }
  if (!Object.prototype.hasOwnProperty.call(source, 'promptProfile')) {
    Object.assign(picked, promptProfilePrefsPatch(resolvePromptProfile(source)));
  }
  const memoryPrefs = memoryInjectionSettingsPatch(normalizeMemoryInjectionSettings(source));
  delete memoryPrefs.explicitSharedMemoryChatIds;
  picked.worldBookIds = normalizeIdList(picked.worldBookIds);
  picked.onlinePresetIds = Array.isArray(picked.onlinePresetIds)
    ? normalizeIdList(picked.onlinePresetIds)
    : null;
  return { ...picked, ...memoryPrefs };
}

function clean(value = '') {
  return String(value ?? '').trim();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeIdList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => clean(item))
    .filter(Boolean))];
}

function clone(value) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) {}
  }
  return JSON.parse(JSON.stringify(value));
}

export function normalizeChatSettingsPreset(raw = {}) {
  const source = object(raw);
  const kind = CHAT_SETTINGS_PRESET_KINDS.includes(source.kind) ? source.kind : 'private';
  const createdAt = Math.max(0, Number(source.createdAt) || Date.now());
  return {
    id: clean(source.id) || `chat_settings_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: clean(source.name) || (kind === 'group' ? '群聊预设' : '私聊预设'),
    kind,
    snapshot: clone(object(source.snapshot)),
    createdAt,
    updatedAt: Math.max(createdAt, Number(source.updatedAt) || createdAt),
  };
}

export async function loadChatSettingsPresets() {
  const row = await get(CHAT_SETTINGS_PRESETS_KEY).catch(() => null);
  const source = Array.isArray(row?.value) ? row.value : [];
  const seen = new Set();
  return source
    .map(normalizeChatSettingsPreset)
    .filter((preset) => preset.id && !seen.has(preset.id) && seen.add(preset.id))
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}

async function writeChatSettingsPresets(presets = []) {
  const normalized = (Array.isArray(presets) ? presets : []).map(normalizeChatSettingsPreset);
  await put({ key: CHAT_SETTINGS_PRESETS_KEY, value: normalized });
  return normalized;
}

export async function saveChatSettingsPreset({ id = '', name = '', kind = 'private', snapshot = {} } = {}) {
  const presets = await loadChatSettingsPresets();
  const presetId = clean(id);
  const existing = presets.find((preset) => preset.id === presetId);
  const now = Date.now();
  const next = normalizeChatSettingsPreset({
    id: presetId || undefined,
    name: clean(name) || existing?.name,
    kind: CHAT_SETTINGS_PRESET_KINDS.includes(kind) ? kind : existing?.kind,
    snapshot,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  await writeChatSettingsPresets([next, ...presets.filter((preset) => preset.id !== next.id)]);
  return next;
}

export async function renameChatSettingsPreset(id, name) {
  const presetId = clean(id);
  const label = clean(name);
  if (!label) throw new Error('请输入预设名称');
  const presets = await loadChatSettingsPresets();
  const existing = presets.find((preset) => preset.id === presetId);
  if (!existing) throw new Error('预设不存在');
  const next = { ...existing, name: label, updatedAt: Date.now() };
  await writeChatSettingsPresets([next, ...presets.filter((preset) => preset.id !== presetId)]);
  return next;
}

export async function deleteChatSettingsPreset(id) {
  const presetId = clean(id);
  const presets = await loadChatSettingsPresets();
  const existing = presets.find((preset) => preset.id === presetId);
  if (!existing) return null;
  await writeChatSettingsPresets(presets.filter((preset) => preset.id !== presetId));
  return existing;
}
