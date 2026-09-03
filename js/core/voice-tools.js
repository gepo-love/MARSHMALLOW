import * as db from './db.js';
import { getCharacter } from './character-store.js';
import { getCurrentUser } from './user-slot.js';
import { stripTranslationMarks } from './narration-translation.js';
import { isOpaqueFetchError, makeOpaqueFetchError } from './network-error.js';
import {
  hasNativeHttp,
  isNativeAppShell,
  nativeHttpPostJson,
  nativeHttpPostJsonBytes,
} from './native-http.js';
import { isKnownUnofficialFishAudioSite } from './fish-audio-connectivity.js';

export const VOICE_TOOL_CONFIG_KEY = 'voiceToolConfig';
export const FISH_AUDIO_TTS_PROXY_PATH = '/api/voice/fish/tts';
export const MINIMAX_TTS_PROXY_PATH = '/api/voice/minimax/tts';
const VOICE_CACHE_INDEX_KEY = 'voiceAudioCacheIndex';
const VOICE_CACHE_ROW_PREFIX = 'voiceAudioCache_';
const CALL_LINE_VOICE_INDEX_KEY = 'callLineVoiceIndex';
const CALL_LINE_VOICE_PREFIX = 'callLineVoice_';
const CALL_LINE_VOICE_LIMIT = 240;
const STREAMER_LINE_VOICE_PREFIX = 'streamerLineVoice_';
const VOICE_TTS_TEXT_NORMALIZATION_VERSION = 'provider-performance-v14';

export const DEFAULT_VOICE_TOOL_CONFIG = {
  enabled: false,
  provider: 'minimax',
  region: 'global',
  endpoint: '',
  apiKey: '',
  model: 'speech-2.8-hd',
  languageBoost: 'auto',
  outputFormat: 'hex',
  defaultVoiceId: '',
  speed: 1,
  vol: 1,
  pitch: 0,
  emotion: '',
  audio: {
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
  },
  cache: {
    enabled: true,
    maxEntries: 120,
  },
  costControl: {
    // 仅为兼容旧备份保留；TTS 通常按文本量计费，不再用字数门槛跳过短句。
    minChars: 0,
  },
  styleBook: {
    enabled: false,
    text: '',
    naturalPauses: true,
    subtleEmotion: true,
    nativeEmotion: false,
    pauseScale: 1,
    stripStageDirections: true,
  },
  fish: {
    endpoint: 'https://api.fish.audio',
    apiKey: '',
    model: 's2.1-pro-free',
    temperature: 0.7,
    topP: 0.7,
    speed: 1,
    volume: 0,
    normalizeLoudness: true,
    normalize: true,
    chunkLength: 300,
    minChunkLength: 50,
    conditionOnPreviousChunks: true,
    latency: 'normal',
    qualityGuard: true,
    format: 'wav',
    sampleRate: 44100,
    mp3Bitrate: 128,
  },
};

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampOptionalNumber(value, min, max, fallback) {
  if (value === undefined || value === null) return clampNumber(fallback, min, max, fallback);
  if (typeof value === 'string' && !value.trim()) return clampNumber(fallback, min, max, fallback);
  return clampNumber(value, min, max, fallback);
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clampOptionalNumber(value, min, max, fallback));
}

export function normalizeMiniMaxPitch(value, fallback = 0) {
  return clampInteger(value, -12, 12, fallback);
}

function normalizeVoiceStyleBook(value = {}) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_VOICE_TOOL_CONFIG.styleBook,
    ...src,
    text: String(src.text || '').slice(0, 12000),
    enabled: src.enabled === true,
    naturalPauses: src.naturalPauses !== false,
    subtleEmotion: src.subtleEmotion !== false,
    nativeEmotion: src.nativeEmotion === true,
    pauseScale: clampNumber(
      src.pauseScale,
      0.5,
      1.8,
      DEFAULT_VOICE_TOOL_CONFIG.styleBook.pauseScale,
    ),
    stripStageDirections: src.stripStageDirections !== false,
  };
}

function mergeConfig(value = {}) {
  const src = value && typeof value === 'object' ? value : {};
  const fish = src.fish && typeof src.fish === 'object' ? src.fish : {};
  const provider = String(src.provider || '').trim().toLowerCase() === 'fish' ? 'fish' : 'minimax';
  const storedStyleBooks = src.styleBooks && typeof src.styleBooks === 'object'
    ? src.styleBooks
    : {};
  const miniMaxStyleBook = normalizeVoiceStyleBook(storedStyleBooks.minimax || src.styleBook || {});
  const fishStyleBook = normalizeVoiceStyleBook(
    storedStyleBooks.fish
    || (fish.styleBook && typeof fish.styleBook === 'object' ? fish.styleBook : null)
    || src.styleBook
    || {},
  );
  const fishModelValue = String(fish.model || DEFAULT_VOICE_TOOL_CONFIG.fish.model).trim()
    || DEFAULT_VOICE_TOOL_CONFIG.fish.model;
  const fishLatency = ['low', 'balanced', 'normal'].includes(String(fish.latency || '').trim())
    ? String(fish.latency).trim()
    : DEFAULT_VOICE_TOOL_CONFIG.fish.latency;
  const fishFormat = ['mp3', 'wav'].includes(String(fish.format || '').trim().toLowerCase())
    ? String(fish.format).trim().toLowerCase()
    : DEFAULT_VOICE_TOOL_CONFIG.fish.format;
  const merged = {
    ...DEFAULT_VOICE_TOOL_CONFIG,
    ...src,
    provider,
    audio: {
      ...DEFAULT_VOICE_TOOL_CONFIG.audio,
      ...(src.audio || {}),
      sampleRate: clampInteger(src.audio?.sampleRate, 8000, 48000, DEFAULT_VOICE_TOOL_CONFIG.audio.sampleRate),
      bitrate: clampInteger(src.audio?.bitrate, 32000, 320000, DEFAULT_VOICE_TOOL_CONFIG.audio.bitrate),
      channel: clampInteger(src.audio?.channel, 1, 2, DEFAULT_VOICE_TOOL_CONFIG.audio.channel),
      format: String(src.audio?.format || DEFAULT_VOICE_TOOL_CONFIG.audio.format).trim() || DEFAULT_VOICE_TOOL_CONFIG.audio.format,
    },
    cache: {
      ...DEFAULT_VOICE_TOOL_CONFIG.cache,
      ...(src.cache || {}),
      maxEntries: clampNumber(src.cache?.maxEntries, 10, 1000, DEFAULT_VOICE_TOOL_CONFIG.cache.maxEntries),
    },
    costControl: {
      ...DEFAULT_VOICE_TOOL_CONFIG.costControl,
      ...(src.costControl || {}),
      // 旧备份可能仍保存 3/6 等阈值；统一归零，避免其它调用方误把它当成有效开关。
      minChars: 0,
    },
    styleBooks: {
      minimax: miniMaxStyleBook,
      fish: fishStyleBook,
    },
    // 兼容旧调用：始终把当前提供商的世界书暴露为 styleBook。
    styleBook: provider === 'fish' ? fishStyleBook : miniMaxStyleBook,
    fish: {
      ...DEFAULT_VOICE_TOOL_CONFIG.fish,
      ...fish,
      endpoint: String(fish.endpoint || DEFAULT_VOICE_TOOL_CONFIG.fish.endpoint).trim()
        || DEFAULT_VOICE_TOOL_CONFIG.fish.endpoint,
      apiKey: String(fish.apiKey || '').trim(),
      model: fishModelValue,
      temperature: clampNumber(
        fish.temperature,
        0,
        1,
        DEFAULT_VOICE_TOOL_CONFIG.fish.temperature,
      ),
      topP: clampNumber(fish.topP, 0, 1, DEFAULT_VOICE_TOOL_CONFIG.fish.topP),
      speed: clampOptionalNumber(fish.speed, 0.5, 2, DEFAULT_VOICE_TOOL_CONFIG.fish.speed),
      volume: clampOptionalNumber(fish.volume, -20, 20, DEFAULT_VOICE_TOOL_CONFIG.fish.volume),
      normalizeLoudness: fish.normalizeLoudness !== false,
      normalize: fish.normalize !== false,
      chunkLength: clampInteger(
        fish.chunkLength,
        100,
        300,
        DEFAULT_VOICE_TOOL_CONFIG.fish.chunkLength,
      ),
      minChunkLength: clampInteger(
        fish.minChunkLength,
        0,
        100,
        DEFAULT_VOICE_TOOL_CONFIG.fish.minChunkLength,
      ),
      conditionOnPreviousChunks: fish.conditionOnPreviousChunks !== false,
      latency: fishLatency,
      qualityGuard: fish.qualityGuard !== false,
      format: fishFormat,
      sampleRate: clampInteger(
        fish.sampleRate,
        8000,
        48000,
        DEFAULT_VOICE_TOOL_CONFIG.fish.sampleRate,
      ),
      mp3Bitrate: [64, 128, 192].includes(Number(fish.mp3Bitrate))
        ? Number(fish.mp3Bitrate)
        : DEFAULT_VOICE_TOOL_CONFIG.fish.mp3Bitrate,
    },
    speed: clampOptionalNumber(src.speed, 0.5, 2, DEFAULT_VOICE_TOOL_CONFIG.speed),
    vol: clampOptionalNumber(src.vol, 0.1, 10, DEFAULT_VOICE_TOOL_CONFIG.vol),
    pitch: normalizeMiniMaxPitch(src.pitch, DEFAULT_VOICE_TOOL_CONFIG.pitch),
  };
  // MiniMax 现行 TTS 只使用 Bearer API Key。旧备份里的 Group ID 不再进入配置或请求。
  delete merged.groupId;
  return merged;
}

export async function loadVoiceToolConfig() {
  const row = await db.get('settings', VOICE_TOOL_CONFIG_KEY);
  return mergeConfig(row?.value || {});
}

export async function saveVoiceToolConfig(config = {}) {
  const next = mergeConfig(config);
  await db.put('settings', { key: VOICE_TOOL_CONFIG_KEY, value: next });
  return next;
}

export function isVoiceToolEnabled(config = {}) {
  const cfg = mergeConfig(config);
  if (cfg.enabled !== true) return false;
  if (cfg.provider === 'fish') {
    return !!String(cfg.fish?.apiKey || '').trim()
      && !!String(cfg.fish?.model || '').trim();
  }
  return !!String(cfg.apiKey || '').trim()
    && !!String(cfg.model || '').trim();
}

export function normalizeVoiceProvider(value = '', fallback = 'minimax') {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'fish' || provider === 'minimax') return provider;
  return String(fallback || '').trim().toLowerCase() === 'fish' ? 'fish' : 'minimax';
}

/** 角色可固定自己的 TTS 提供商；留空时继续跟随 API 管理里的全局选择。 */
export function resolveCharacterVoiceProvider(rawProfile = {}, globalProvider = 'minimax') {
  const raw = rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile)
    ? rawProfile
    : {};
  const providerValue = Object.prototype.hasOwnProperty.call(raw, 'provider')
    ? raw.provider
    : (raw.voiceProvider || raw.voice_provider || '');
  const override = String(providerValue || '').trim().toLowerCase();
  return normalizeVoiceProvider(override, globalProvider);
}

/** 把全局两套 API 配置切到当前角色实际选择的提供商，并同步对应语音世界书。 */
export function resolveVoiceToolConfigForProfile(config = {}, rawProfile = {}) {
  const base = mergeConfig(config);
  const provider = resolveCharacterVoiceProvider(rawProfile, base.provider);
  return provider === base.provider ? base : mergeConfig({ ...base, provider });
}

/** 角色是否允许走 TTS：须有当前提供商声线 ID，且显式启用；未指定提供商时检查任一声线。 */
export function isCharacterVoiceTtsEnabled(rawProfile = {}, provider = '') {
  const raw = rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile) ? rawProfile : {};
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const miniMaxVoiceId = String(raw.voiceId || raw.voice_id || '').trim();
  const fishReferenceId = String(
    raw.fishReferenceId
    || raw.fish_reference_id
    || raw.fishVoiceId
    || '',
  ).trim();
  const voiceId = normalizedProvider === 'fish'
    ? fishReferenceId
    : normalizedProvider === 'minimax'
      ? miniMaxVoiceId
      : (miniMaxVoiceId || fishReferenceId);
  if (!voiceId) return false;
  if (raw.enabled === false) return false;
  if (raw.enabled === true) return true;
  return true;
}

export function createVoiceTtsDisabledError() {
  return Object.assign(new Error('VOICE_TTS_DISABLED'), { code: 'VOICE_TTS_DISABLED' });
}

export function isVoiceTtsSkipError(err) {
  return err?.code === 'VOICE_TTS_DISABLED';
}

function endpointBaseForRegion(region = '') {
  if (region === 'china') return 'https://api.minimaxi.com';
  if (region === 'uw') return 'https://api-uw.minimax.io';
  return 'https://api.minimax.io';
}

function buildApiUrl(cfg = {}) {
  const raw = String(cfg.endpoint || '').trim();
  const base = raw || endpointBaseForRegion(cfg.region);
  const clean = base.replace(/\/+$/, '');
  return /\/v1\/t2a_v2$/i.test(clean) ? clean : `${clean}/v1/t2a_v2`;
}

function buildFishApiUrl(cfg = {}) {
  const raw = String(cfg.fish?.endpoint || DEFAULT_VOICE_TOOL_CONFIG.fish.endpoint).trim();
  if (isKnownUnofficialFishAudioSite(raw)) {
    throw new Error('已阻止连接 fishaudio.org：它不是 Fish Audio 官方站。请将接口地址改为 https://api.fish.audio');
  }
  const clean = raw.replace(/\/+$/, '');
  return /\/v1\/tts$/i.test(clean) ? clean : `${clean}/v1/tts`;
}

export function resolveFishTtsRequestTarget(
  url = '',
  { nativeApp = isNativeAppShell() } = {},
) {
  const directUrl = String(url || '').trim();
  if (nativeApp) return { url: directUrl, proxied: false };
  try {
    const parsed = new URL(directUrl);
    const officialTts = parsed.origin === 'https://api.fish.audio'
      && parsed.pathname.replace(/\/+$/, '').toLowerCase() === '/v1/tts';
    if (officialTts) return { url: FISH_AUDIO_TTS_PROXY_PATH, proxied: true };
  } catch (_) {}
  return { url: directUrl, proxied: false };
}

export function resolveMiniMaxTtsRequestTarget(
  url = '',
  { nativeApp = isNativeAppShell() } = {},
) {
  const directUrl = String(url || '').trim();
  if (nativeApp) return { url: directUrl, proxied: false };
  try {
    const parsed = new URL(directUrl);
    if (parsed.pathname.replace(/\/+$/, '').toLowerCase() !== '/v1/t2a_v2') {
      return { url: directUrl, proxied: false };
    }
    const regionByOrigin = {
      'https://api.minimaxi.com': 'china',
      'https://api.minimax.io': 'global',
      'https://api-uw.minimax.io': 'uw',
    };
    const region = regionByOrigin[parsed.origin];
    if (region) return { url: MINIMAX_TTS_PROXY_PATH, proxied: true, region };
  } catch (_) {}
  return { url: directUrl, proxied: false };
}

function wrapNetworkError(err, url = '', elapsedMs = 0, provider = 'minimax') {
  if (isOpaqueFetchError(err)) {
    return makeOpaqueFetchError(err, url, {
      label: '语音接口请求',
      elapsedMs,
      replayRisk: true,
      nativeHint: provider === 'fish'
        ? '反复出现时请检查 Fish Audio 线路、API Key 与接口地址。'
        : '反复出现时请检查 MiniMax 线路，或改用预先配置的同源代理。',
    });
  }
  const raw = String(err?.message || err || '');
  return err instanceof Error ? err : new Error(raw || '语音接口请求失败');
}

function responseHeaderValue(headers, name = '') {
  const target = String(name || '').toLowerCase();
  if (!target || !headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const match = Object.entries(headers).find(([key]) => String(key).toLowerCase() === target);
  return match ? String(match[1] || '') : '';
}

function decodeResponseBytes(bytes) {
  if (!bytes?.byteLength) return '';
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch (_) {
    return '';
  }
}

function fishApiErrorDetail(raw = '') {
  let detail = String(raw || '').trim();
  try {
    const parsed = JSON.parse(detail);
    detail = parsed?.message
      || parsed?.detail
      || parsed?.error?.message
      || parsed?.error
      || detail;
  } catch (_) {
    /* keep raw body */
  }
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

async function loadGeneratedStreamerVoiceProfile(actorId = '') {
  const id = String(actorId || '').trim();
  if (!id) return null;
  const channels = await db.getAllRecords('streamerChannels').catch(() => []);
  const channel = (Array.isArray(channels) ? channels : [])
    .filter((row) => row?.sourceType !== 'character'
      && String(row?.personaActorId || '').trim() === id)
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))[0];
  if (!channel) return null;
  const persona = channel.persona && typeof channel.persona === 'object' ? channel.persona : {};
  return {
    voiceId: String(persona.voiceId || '').trim(),
    enabled: persona.voiceEnabled === true,
  };
}

export async function loadCharacterVoiceProfile(characterId = '', options = {}) {
  const id = String(characterId || '').trim();
  if (!id || id === 'user' || id === 'system') return {};
  // 随机主播进入私聊/粉丝群后使用的是惰性创建的匿名 NPC actorId，
  // 声线的真实来源仍是主播频道，而不是隐藏 NPC 的通讯录档案。
  const streamerProfile = await loadGeneratedStreamerVoiceProfile(id);
  if (streamerProfile) return streamerProfile;
  // Chat 侧边栏会把角色编辑保存到当前身份的 characterOverrides。
  // 语音生成不能绕过角色存储层直读 characters，否则刚在侧边栏新增的声线
  // 只会留在身份覆写中，播放时却仍看到公用角色卡的空声线。
  const requestedUserId = String(options?.userId || '').trim();
  const activeUser = requestedUserId
    ? { id: requestedUserId }
    : await getCurrentUser().catch(() => null);
  const row = await getCharacter(id, activeUser?.id ? { userId: activeUser.id } : {}).catch(() => null);
  const raw = row?.voiceProfile || row?.voice || {};
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

async function normalizeVoiceProfile(cfg = {}, characterId = '', overrideProfile = null) {
  const id = String(characterId || '').trim();
  const raw = (overrideProfile && typeof overrideProfile === 'object')
    ? overrideProfile
    : await loadCharacterVoiceProfile(id);
  const miniMaxVoiceId = String(raw.voiceId || raw.voice_id || '').trim();
  const fishReferenceId = String(
    raw.fishReferenceId
    || raw.fish_reference_id
    || raw.fishVoiceId
    || '',
  ).trim();
  const voiceId = cfg.provider === 'fish' ? fishReferenceId : miniMaxVoiceId;
  const fishProfile = cfg.provider === 'fish';
  const legacyFishOnly = fishProfile && !!fishReferenceId && !miniMaxVoiceId;
  const defaultSpeed = fishProfile ? cfg.fish?.speed : cfg.speed;
  const rawSpeed = fishProfile
    ? (raw.fishSpeed ?? raw.fish_speed ?? (legacyFishOnly ? raw.speed : undefined))
    : raw.speed;
  const rawEmotion = fishProfile
    ? (raw.fishEmotion ?? raw.fish_emotion ?? (legacyFishOnly ? raw.emotion : undefined))
    : raw.emotion;
  const rawEmotionIntensity = fishProfile
    ? (raw.fishEmotionIntensity ?? raw.fish_emotion_intensity ?? raw.emotionIntensity)
    : (raw.emotionIntensity ?? raw.emotion_intensity ?? raw.intensity);
  return {
    voiceId,
    miniMaxVoiceId,
    fishReferenceId,
    languageBoost: String(raw.languageBoost || raw.language_boost || cfg.languageBoost || 'auto').trim() || 'auto',
    speed: clampOptionalNumber(rawSpeed, 0.5, 2, defaultSpeed || 1),
    vol: fishProfile
      ? clampOptionalNumber(raw.fishVolume ?? raw.fish_volume, -20, 20, cfg.fish?.volume ?? 0)
      : clampOptionalNumber(raw.vol, 0.1, 10, cfg.vol || 1),
    pitch: fishProfile ? 0 : normalizeMiniMaxPitch(raw.pitch, cfg.pitch || 0),
    emotion: String(rawEmotion || cfg.emotion || '').trim(),
    emotionIntensity: rawEmotionIntensity === undefined || rawEmotionIntensity === null
      ? null
      : normalizeVoiceEmotionIntensity(rawEmotionIntensity, rawEmotion || cfg.emotion || ''),
    temperature: fishProfile
      ? clampOptionalNumber(raw.fishTemperature, 0, 1, cfg.fish?.temperature ?? 0.7)
      : null,
    topP: fishProfile
      ? clampOptionalNumber(raw.fishTopP ?? raw.fish_top_p, 0, 1, cfg.fish?.topP ?? 0.7)
      : null,
    performanceDirection: fishProfile
      ? String(raw.fishPerformanceDirection || raw.fish_performance_direction || '').trim().slice(0, 360)
      : '',
  };
}

// MiniMax 的 speed / vol 接受小数，但 pitch 是 [-12, 12] 的整数音阶。
// 轻微情绪只在连续参数上做小幅变化，避免把 0.12 之类浮点音高送成 2013 参数错误。
const SUBTLE_EMOTION_ADJUSTMENTS = {
  happy: { speed: 0.03, vol: 0.03 },
  sad: { speed: -0.04, vol: -0.03 },
  angry: { speed: 0.04, vol: 0.05 },
  fearful: { speed: 0.03, vol: 0.02 },
  surprised: { speed: 0.02, vol: 0.04 },
  disgusted: { speed: -0.01, vol: 0.01 },
  neutral: { speed: 0, vol: 0 },
};

function normalizeEmotionKey(value = '') {
  const s = String(value || '').trim().toLowerCase();
  if (/开心|高兴|愉快|happy|joy/.test(s)) return 'happy';
  if (/难过|低落|伤心|sad/.test(s)) return 'sad';
  if (/生气|愤怒|angry/.test(s)) return 'angry';
  if (/害怕|紧张|fear/.test(s)) return 'fearful';
  if (/惊讶|意外|surpris/.test(s)) return 'surprised';
  if (/嫌弃|厌恶|disgust/.test(s)) return 'disgusted';
  return s && SUBTLE_EMOTION_ADJUSTMENTS[s] ? s : 'neutral';
}

function normalizeVoiceEmotionIntensity(value, emotion = 'neutral') {
  const emotionKey = normalizeEmotionKey(emotion);
  if (emotionKey === 'neutral') return 0;
  const named = String(value ?? '').trim().toLowerCase();
  if (/^(?:subtle|soft|low|轻微|克制|柔和)$/.test(named)) return 0.25;
  if (/^(?:moderate|medium|中等|明显)$/.test(named)) return 0.5;
  if (/^(?:strong|high|intense|强烈|激烈)$/.test(named)) return 0.85;
  let numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1 && numeric <= 100) numeric /= 100;
  return Number.isFinite(numeric) ? clampNumber(numeric, 0, 1, 0.35) : 0.35;
}

function applyVoiceStyleProfile(profile = {}, cfg = {}) {
  if (!cfg.styleBook?.enabled || cfg.styleBook?.subtleEmotion === false) return profile;
  if (cfg.provider === 'fish') return profile;
  const key = normalizeEmotionKey(profile.emotion);
  const adj = SUBTLE_EMOTION_ADJUSTMENTS[key] || SUBTLE_EMOTION_ADJUSTMENTS.neutral;
  // 角色声线里手动固定的 emotion 没有强度字段，沿用原行为；
  // AI 表演轨则按 0~1 强度缩放，避免每个气泡只要标 angry 就整句突然激昂。
  const intensity = profile.emotionIntensity === null || profile.emotionIntensity === undefined
    ? 1
    : normalizeVoiceEmotionIntensity(profile.emotionIntensity, key);
  return {
    ...profile,
    speed: clampNumber(Number(profile.speed || 1) + (adj.speed * intensity), 0.5, 2, profile.speed || 1),
    pitch: normalizeMiniMaxPitch(profile.pitch, 0),
    vol: clampNumber(Number(profile.vol || 1) + (adj.vol * intensity), 0.1, 10, profile.vol || 1),
  };
}

const NATIVE_EMOTION_INTENSITY_THRESHOLD = Object.freeze({
  happy: 0.58,
  sad: 0.58,
  angry: 0.75,
  fearful: 0.72,
  surprised: 0.68,
  disgusted: 0.75,
});

export function buildMiniMaxVoiceSetting(profile = {}, cfg = {}) {
  const emotion = normalizeEmotionKey(profile.emotion);
  const hasPlannedIntensity = profile.emotionIntensity !== null && profile.emotionIntensity !== undefined;
  const emotionIntensity = hasPlannedIntensity
    ? normalizeVoiceEmotionIntensity(profile.emotionIntensity, emotion)
    : null;
  const nativeThreshold = NATIVE_EMOTION_INTENSITY_THRESHOLD[emotion] ?? 1;
  const setting = {
    voice_id: String(profile.voiceId || profile.voice_id || '').trim(),
    speed: clampOptionalNumber(profile.speed, 0.5, 2, cfg.speed || 1),
    vol: clampOptionalNumber(profile.vol, 0.1, 10, cfg.vol || 1),
    pitch: normalizeMiniMaxPitch(profile.pitch, cfg.pitch || 0),
  };
  if (cfg.styleBook?.nativeEmotion === true
    && emotion !== 'neutral'
    && (!hasPlannedIntensity || emotionIntensity >= nativeThreshold)) {
    setting.emotion = emotion;
  }
  return setting;
}

export function buildMiniMaxAudioSetting(audio = {}, format = 'mp3') {
  const src = audio && typeof audio === 'object' ? audio : {};
  return {
    sample_rate: clampInteger(src.sampleRate, 8000, 48000, DEFAULT_VOICE_TOOL_CONFIG.audio.sampleRate),
    bitrate: clampInteger(src.bitrate, 32000, 320000, DEFAULT_VOICE_TOOL_CONFIG.audio.bitrate),
    format: String(format || DEFAULT_VOICE_TOOL_CONFIG.audio.format).trim() || DEFAULT_VOICE_TOOL_CONFIG.audio.format,
    channel: clampInteger(src.channel, 1, 2, DEFAULT_VOICE_TOOL_CONFIG.audio.channel),
  };
}

function pauseTag(seconds, scale = 1) {
  const n = clampNumber(Number(seconds) * Number(scale || 1), 0.05, 0.8, seconds);
  return `<#${n.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}#>`;
}

const MINIMAX_PARALINGUISTIC_TAGS = Object.freeze({
  breath: '(breath)',
  inhale: '(inhale)',
  exhale: '(exhale)',
  gasps: '(gasps)',
  pant: '(pant)',
  sighs: '(sighs)',
  laughs: '(laughs)',
  chuckle: '(chuckle)',
  coughs: '(coughs)',
  clearThroat: '(clear-throat)',
  humming: '(humming)',
  emm: '(emm)',
});

const MINIMAX_SOUND_INNER_RE = /^(?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)$/i;

function normalizeMiniMaxParalinguisticTagFromAction(action = '') {
  const s = String(action || '').trim();
  if (!s) return '';
  if (/倒吸气|抽气|吸了口气|吸一口气/.test(s)) return MINIMAX_PARALINGUISTIC_TAGS.gasps;
  if (/深吸|吸气|吸了一口|吸口气/.test(s)) return MINIMAX_PARALINGUISTIC_TAGS.inhale;
  if (/呼气|吐气|缓缓吐出/.test(s)) return MINIMAX_PARALINGUISTIC_TAGS.exhale;
  if (/换气|呼吸|喘口气|调整呼吸/.test(s)) return MINIMAX_PARALINGUISTIC_TAGS.breath;
  if (/喘|气喘|喘息/.test(s)) return MINIMAX_PARALINGUISTIC_TAGS.pant;
  if (/叹气|叹了口气|叹/.test(s)) return MINIMAX_PARALINGUISTIC_TAGS.sighs;
  if (/轻笑|低笑|笑出声|笑了|笑/.test(s)) return /轻笑|低笑/.test(s) ? MINIMAX_PARALINGUISTIC_TAGS.chuckle : MINIMAX_PARALINGUISTIC_TAGS.laughs;
  if (/清嗓|清了清嗓|清嗓子/.test(s)) return MINIMAX_PARALINGUISTIC_TAGS.clearThroat;
  if (/咳|咳嗽/.test(s)) return MINIMAX_PARALINGUISTIC_TAGS.coughs;
  if (/哼|哼唱|哼了一声/.test(s)) return MINIMAX_PARALINGUISTIC_TAGS.humming;
  return '';
}

const ASTERISK_CHINESE_STAGE_DIRECTION_RE = /(?:大笑|轻笑|低笑|苦笑|冷笑|嗤笑|笑出声|点头|摇头|歪头|挑眉|皱眉|眨眼|闭眼|睁眼|耸肩|叹气|吸气|呼气|喘息|咳嗽?|清嗓|沉默|停顿|顿了顿|愣住?|怔住?|走(?:向|到|开|近)|转身|回头|看向|移开视线|抬头|低头|靠近|后退|伸手|收手|握住|抱住|亲吻|吻住|推开|拉住|坐下|站起|起身)/u;
const ASTERISK_ENGLISH_STAGE_DIRECTION_RE = /^(?:(?:softly|quietly|slowly|suddenly|briefly)\s+)?(?:laughs?|laughing|chuckles?|chuckling|smiles?|smiling|smirks?|smirking|grins?|grinning|sighs?|sighing|gasps?|gasping|coughs?|coughing|nods?|nodding|shrugs?|shrugging|pauses?|pausing|hesitates?|hesitating|whispers?|whispering|murmurs?|murmuring|looks?\s+(?:away|at\b.+)|walks?\b.+|walking\b.+|turns?\b.+|turning\b.+|leans?\b.+|leaning\b.+|steps?\b.+|stepping\b.+|raises?\b.+|lowering\b.+|rolls?\s+(?:his|her|their)\s+eyes|shakes?\s+(?:his|her|their)?\s*head|takes?\s+(?:a\s+)?breath|silence)$/iu;

function isLikelyAsteriskStageDirection(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  return ASTERISK_CHINESE_STAGE_DIRECTION_RE.test(text)
    || ASTERISK_ENGLISH_STAGE_DIRECTION_RE.test(text);
}

function normalizeVoiceStageDirections(text = '', cfg = {}) {
  let out = String(text || '');
  // 「过滤括号动作」独立于语音世界书：默认开启时，朗读会过滤括号及 *...* 舞台指示；
  // 转写展示走原始消息文本，不会动这些舞台动作。
  if (!out || cfg.styleBook?.stripStageDirections === false) return out;
  const scale = clampNumber(cfg.styleBook?.pauseScale, 0.5, 1.8, 1);
  const actionToPause = (full, inner) => {
    const s = String(inner || '').trim();
    if (!s) return '';
    // MiniMax 拟声标签本身用圆括号，必须先识别；Fish 也会把这些标签
    // 转成局部英文 direction，不能提前把 inhale / breath 当成现成方括号指导。
    if (MINIMAX_SOUND_INNER_RE.test(s)) return `(${String(s).toLowerCase()})`;
    // Fish S2 的英文方括号 direction 是合成元数据，不是会被朗读的舞台动作。
    // 电台等长音声会把局部表演指导直接放在它控制的句段前，必须原样留给
    // Fish；普通中文/叙事括注仍继续走下面的过滤逻辑。
    if (cfg.provider === 'fish'
      && /^[A-Za-z][A-Za-z0-9\s,.'’\-;:]{2,240}$/u.test(s)
      && isFishDisplayPerformanceCue(s, { allowSingleStyle: true })) {
      return `[${s}]`;
    }
    const tag = normalizeMiniMaxParalinguisticTagFromAction(s);
    if (tag) {
      return `${tag}${pauseTag(
        /^(?:\(gasps\)|\(inhale\)|\(exhale\)|\(breath\)|\(pant\)|\(sighs\))$/.test(tag) ? 0.18 : 0.12,
        scale,
      )}`;
    }
    if (/深吸|吸气|呼气|呼吸|叹气|叹了口气|喘|清嗓|咳|沉默|停顿|顿了顿|安静|没说话|笑|轻笑|低笑|苦笑|愣|怔/.test(s)) {
      if (/深吸|吸气|呼气|呼吸|叹气|喘/.test(s)) return pauseTag(0.45, scale);
      if (/沉默|停顿|顿了顿|安静|没说话|愣|怔/.test(s)) return pauseTag(0.38, scale);
      return pauseTag(0.18, scale);
    }
    // 其余括注（含较长书面说明）只显示、不朗读
    return '';
  };
  out = out
    .replace(/[（(]([^（）()]{1,120})[）)]/g, actionToPause)
    .replace(/[【\[]([^【】\[\]]{1,120})[】\]]/g, actionToPause)
    // 单星号既可能是角色扮演动作，也常被模型用作英文/外语重音。只有高置信度
    // 动作才过滤；普通 *word* / *short phrase* 仅去掉 Markdown 标记并保留朗读。
    // 避开 **强调**，聊天气泡仍显示原始格式。
    .replace(/(^|[^*])\*([^*\n]{1,120})\*(?!\*)/g, (_full, prefix, inner) => {
      const emphasized = String(inner || '').trim();
      const isStageDirection = !!normalizeMiniMaxParalinguisticTagFromAction(emphasized)
        || isLikelyAsteriskStageDirection(emphasized);
      const spoken = isStageDirection
        ? actionToPause('', emphasized)
        : emphasized;
      return `${prefix}${spoken}`;
    })
    // 超长括注：仍不朗读（展示侧保留原文）
    .replace(/[（(][^（）()\n]{121,}[）)]/g, ' ')
    .replace(/[【\[][^【】\[\]\n]{121,}[】\]]/g, ' ');
  return out.replace(/(?:\s*<#\d+(?:\.\d+)?#>\s*){3,}/g, pauseTag(0.65, scale));
}

const MINIMAX_INLINE_SOUND_CUE_RE = /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/i;
const MINIMAX_NEXT_PERFORMANCE_CUE_RE = /^\s*(?:<#\d+(?:\.\d+)?#>|\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\))/i;
const VOICE_SPEAKABLE_CHAR_RE = /[A-Za-z0-9\u00c0-\u024f\u0400-\u052f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

function hasVoiceSpeakableText(value = '') {
  return VOICE_SPEAKABLE_CHAR_RE.test(
    String(value || '')
      .replace(/<#\d+(?:\.\d+)?#>/g, '')
      .replace(/\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi, ''),
  );
}

function supportsMiniMaxSoundCues(model = '') {
  return /^speech-2\.8-(?:hd|turbo)$/i.test(String(model || '').trim());
}

function normalizeMiniMaxInterjections(text = '', cfg = {}) {
  const source = String(text || '');
  if (!source
    || cfg.styleBook?.enabled !== true
    || !supportsMiniMaxSoundCues(cfg.model)) {
    return source;
  }
  return source
    // MiniMax 的 (emm) 听感更接近“呃……”式卡顿，而不是表示应声、赞同或思考的“嗯……”。
    // 只处理后接停顿的独立“呃”，保留可见正文里的“嗯”及其语义。
    .replace(
      /(^|[\s，,。！？!?、；;：:])呃(?=\s*(?:…{2,}|\.{3,}))/g,
      '$1(emm)',
    )
    // 独立的轻声“哈……”按轻笑演绎；“哈？”、哈尔滨、哈哈大笑等保留原文读法。
    .replace(
      /(^|[\s，,。！？!?、；;：:])哈(?=\s*(?:…{2,}|\.{3,}))/g,
      '$1(chuckle)',
    );
}

function addMiniMaxNaturalPauses(text = '', cfg = {}) {
  let out = String(text || '').trim();
  if (!out) return out;
  const scale = clampNumber(cfg.styleBook?.pauseScale, 0.5, 1.8, 1);
  const plainLength = out
    .replace(/<#\d+(?:\.\d+)?#>/g, '')
    .replace(/\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi, '')
    .length;
  let canAddBreath = supportsMiniMaxSoundCues(cfg.model)
    && plainLength >= 18
    && !MINIMAX_INLINE_SOUND_CUE_RE.test(out);

  // 连续省略号通常是一次真实的犹豫或重新起句。首个长气口在 2.8 模型下补一声轻换气，
  // 其余位置只给精确停顿；句首、句尾和已经带表演提示的位置不机械追加。
  out = out.replace(/(?:…{2,}|\.{3,}|。{3,})/g, (ellipsis, offset, source) => {
    const before = source.slice(0, offset);
    const after = source.slice(offset + ellipsis.length);
    if (!hasVoiceSpeakableText(before) || !hasVoiceSpeakableText(after)) return ellipsis;
    if (MINIMAX_NEXT_PERFORMANCE_CUE_RE.test(after)) return ellipsis;
    if (canAddBreath) {
      canAddBreath = false;
      return `${ellipsis}${MINIMAX_PARALINGUISTIC_TAGS.breath}`;
    }
    return `${ellipsis}${pauseTag(0.38, scale)}`;
  });

  // 真正的换段比逗号更长，但只在前后都有可发音内容时使用，避免生成非法的首尾停顿标签。
  return out.replace(/[ \t]*\n+[ \t]*/g, (separator, offset, source) => {
    const before = source.slice(0, offset);
    const after = source.slice(offset + separator.length);
    if (!hasVoiceSpeakableText(before) || !hasVoiceSpeakableText(after)) return ' ';
    if (/<#\d+(?:\.\d+)?#>\s*$/.test(before) || MINIMAX_NEXT_PERFORMANCE_CUE_RE.test(after)) return ' ';
    return pauseTag(0.3, scale);
  });
}

function limitMiniMaxPerformanceCues(text = '') {
  const source = String(text || '');
  const plainLength = source
    .replace(/<#\d+(?:\.\d+)?#>/g, '')
    .replace(/\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi, '')
    .length;
  const spokenSentences = source
    .split(/[。！？!?]+/)
    .filter((part) => hasVoiceSpeakableText(part))
    .length;
  const maxSounds = plainLength >= 120 ? 3 : spokenSentences >= 2 || plainLength >= 40 ? 2 : 1;
  // 长音声会在每个真实段落边界预先放入精确停顿标签。固定只留 3 个会让
  // 电台后半章重新黏成一口气；按正文长度放宽，但仍设上限，避免短气泡或
  // 弱模型输出的密集标签把语音切得支离破碎。
  const maxPauses = Math.min(12, Math.max(2, Math.ceil(plainLength / 240)));
  let sounds = 0;
  let pauses = 0;
  return source.replace(
    /<#\d+(?:\.\d+)?#>|\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi,
    (cue) => {
      if (cue.startsWith('<#')) {
        pauses += 1;
        return pauses <= maxPauses ? cue : ' ';
      }
      sounds += 1;
      return sounds <= maxSounds ? cue : ' ';
    },
  );
}

function normalizeVoiceAngleTags(text = '') {
  return String(text || '')
    // 模型偶尔把标签转成 HTML 实体；先还原，避免 TTS 把 lt/gt 或“大于号小于号”念出来。
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // MiniMax 的拟声标签使用圆括号。兼容模型常输出的 <sighs>/<breath> 写法。
    .replace(
      /<\s*(\/?)\s*(laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\s*>/gi,
      (_full, closing, cue) => (closing ? '' : `(${String(cue).toLowerCase()})`),
    )
    // 精确的 MiniMax 停顿标签保留；其它尖括号内容不是可朗读正文，直接丢弃。
    .replace(/<\s*#\s*(\d+(?:\.\d+)?)\s*#\s*>/g, '<#$1#>')
    .replace(/<[^<>\n]{0,96}>/g, (tag) => (/^<#\d+(?:\.\d+)?#>$/.test(tag) ? tag : ' '))
    .replace(/＜[^＜＞\n]{0,96}＞/g, ' ');
}

function prepareVoiceTextForMiniMax(text = '', cfg = {}) {
  const angleClean = normalizeVoiceAngleTags(String(text || '').trim());
  const stageClean = normalizeVoiceStageDirections(angleClean, cfg).trim();
  const interjectionClean = normalizeMiniMaxInterjections(stageClean, cfg);
  const naturallyPaused = !cfg.styleBook?.enabled || cfg.styleBook?.naturalPauses === false
    ? interjectionClean.replace(/\n+/g, ' ')
    : addMiniMaxNaturalPauses(interjectionClean, cfg);
  return limitMiniMaxPerformanceCues(naturallyPaused)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const FISH_INLINE_PERFORMANCE_CUES = Object.freeze({
  inhale: '[taking a soft, natural and audible breath before speaking]',
  breath: '[briefly pausing, then continuing smoothly with a clean onset]',
  exhale: '[letting the phrase settle quietly before continuing]',
  gasps: '[a single small startled intake, then returning to steady clear speech]',
  pant: '[a single brief pant, then returning to steady clear speech]',
  sighs: '[a quiet restrained sigh slips into the voice]',
  chuckle: '[a small restrained chuckle slips out]',
  laughs: '[laughing softly for a brief moment before continuing]',
  groans: '[a quiet strained sound catches in the voice]',
  sniffs: '[a small restrained sniff before continuing]',
  humming: '[a quiet thoughtful hum before continuing]',
  emm: '[hesitating softly before continuing]',
  coughs: '[a small restrained cough before continuing]',
  'clear-throat': '[clearing the throat softly before continuing]',
  snorts: '[a brief breath through the nose before continuing]',
  'lip-smacking': '[a small natural mouth sound before continuing]',
  hissing: '[speaking with a faint tense edge]',
  sneezes: '[a brief sneeze before continuing]',
  burps: '[a brief burp before continuing]',
});

function fishEmotionDirection(profile = {}) {
  const emotion = normalizeEmotionKey(profile.emotion);
  const intensity = normalizeVoiceEmotionIntensity(profile.emotionIntensity, emotion);
  const subtle = intensity < 0.45;
  if (emotion === 'happy') {
    return subtle
      ? 'warm and quietly pleased, with restrained natural emotion'
      : 'warm and clearly happy, while keeping the performance natural';
  }
  if (emotion === 'sad') {
    return subtle
      ? 'soft and subdued, with a slight vulnerability in the voice'
      : 'sad and emotionally unsteady, while keeping the voice natural';
  }
  if (emotion === 'angry') {
    return subtle
      ? 'serious and slightly tense, controlled rather than openly angry'
      : 'firm and angry, but grounded and never theatrical';
  }
  if (emotion === 'fearful') {
    return subtle
      ? 'quietly tense and hesitant, with restrained uncertainty'
      : 'fearful and unsteady, while trying to remain composed';
  }
  if (emotion === 'surprised') {
    return subtle
      ? 'gently surprised, with a small natural lift in the voice'
      : 'clearly surprised, but not exaggerated';
  }
  if (emotion === 'disgusted') {
    return subtle
      ? 'cool and slightly displeased, with restrained distance'
      : 'clearly displeased, but controlled and natural';
  }
  return 'calm and natural, with restrained emotion';
}

function fishPaceDirection(profile = {}) {
  const speed = Number(profile.speed || 1);
  if (speed <= 0.9) return 'speaking slowly with small natural pauses between phrases';
  if (speed >= 1.12) return 'speaking a little faster while keeping clear natural phrasing';
  return 'with relaxed, natural phrasing';
}

function normalizeFishPauseMarkers(text = '') {
  return String(text || '')
    .replace(/<#(\d+(?:\.\d+)?)#>/g, (_full, seconds) => {
      // Fish S2 不执行 MiniMax 的精确秒数标签。电台的长换段标记改写成
      // 局部英文表演指导，让模型在真正的自然段边界停住并换一口气；较短
      // 的句内停顿仍用省略停顿，避免每个逗号附近都插入 direction。
      if (Number(seconds) >= 0.55) {
        return '\n[pausing briefly at the paragraph boundary, then continuing with a clean onset]\n';
      }
      return Number(seconds) >= 0.3 ? '……' : '…';
    })
    .replace(/…{4,}/g, '……')
    .replace(/([，,。！？!?；;：:])…+(?=[，,。！？!?；;：:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stripTrailingFishPerformanceCues(value = '') {
  const source = String(value || '');
  const trailing = source.match(/(?:\s*\[[^\[\]\r\n]{1,240}\]\s*)+$/u)?.[0] || '';
  if (!trailing) return source.trim();
  const cues = [...trailing.matchAll(/\[([^\[\]\r\n]{1,240})\]/gu)].map((match) => match[1]);
  if (!cues.length || !cues.every((cue) => isFishDisplayPerformanceCue(cue, { allowSingleStyle: true }))) {
    return source.trim();
  }
  // 最后一个字后没有台词可供 direction 控制。把呼吸、叹气或停顿提示留在
  // 这里会让 Fish 用剩余尾音持续表演，常表现成一长段无缘由的喘息。
  return source.slice(0, source.length - trailing.length).trim();
}

function hasExplicitRespiratoryEvidence(value = '') {
  return /(?:\((?:pant|gasps)\)|喘|上气不接下气|呼吸急促|气息不稳|奔跑|跑得|抽泣|哭得|惊吓|疼痛|\b(?:panting|gasping|out of breath|running|sobbing)\b)/iu.test(String(value || ''));
}

function restrainUnsupportedFishBreathing(direction = '', spokenSource = '') {
  let value = String(direction || '')
    .replace(/paragraph breath resets?/giu, 'clean paragraph phrase resets')
    .replace(/breath resets?/giu, 'clean phrase resets');
  if (hasExplicitRespiratoryEvidence(spokenSource)) return value;
  return value
    .replace(/breathy\s+and\s+unsteady/giu, 'soft and slightly unsteady')
    .replace(/\bbreathy\b/giu, 'soft-voiced')
    .replace(/\bairy\b/giu, 'light')
    .replace(/\bpanting\b/giu, 'with controlled phrasing')
    .replace(/\bgasping\b/giu, 'slightly startled')
    .replace(/(?:soft,?\s*)?slightly uneven breaths?/giu, 'small natural pauses')
    .replace(/a small catch in the breath/giu, 'a brief hesitation')
    .replace(/recovering on an exhale/giu, 'settling gently');
}

/**
 * Fish S2 使用自然语言表演指导。MiniMax 的隐藏生理标签会在原位置转换为
 * 细粒度英文指令，精确停顿则退化为可被 Fish 理解的省略停顿。
 */
export function prepareVoiceTextForFish(text = '', config = {}, profile = {}) {
  const cfg = mergeConfig(config);
  const angleClean = normalizeVoiceAngleTags(String(text || '').trim());
  const stageClean = normalizeVoiceStageDirections(angleClean, cfg).trim();
  const cueConverted = stageClean.replace(
    /\((laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi,
    (_full, cue) => FISH_INLINE_PERFORMANCE_CUES[String(cue || '').toLowerCase()] || '',
  );
  const restrainedCues = cueConverted.replace(/\[([^\[\]\r\n]{1,240})\]/gu, (full, cue) => (
    isFishDisplayPerformanceCue(cue, { allowSingleStyle: true })
      ? `[${restrainUnsupportedFishBreathing(cue, stageClean)}]`
      : full
  ));
  const spoken = stripTrailingFishPerformanceCues(normalizeFishPauseMarkers(restrainedCues)
    .replace(/\n{3,}/g, '\n\n')
    .trim());
  if (!spoken) return spoken;
  const explicitDirection = String(profile.performanceDirection || '').trim();
  if (cfg.styleBook?.enabled !== true && !explicitDirection && !String(profile.emotion || '').trim()) {
    return spoken;
  }
  const cleanedDirection = restrainUnsupportedFishBreathing(explicitDirection, stageClean)
    .replace(/[\[\]\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Fish 对 breathy / whispering 的整句指导偶尔会把辅音和高频细节一起压糊。
  // 保留气声表演，但明确要求轻声仍需清晰咬字，避免同一轮某句突然像蒙住麦克风。
  const articulationGuard = /\b(?:breathy|whisper(?:ing|ed)?|hushed|airy)\b/i.test(cleanedDirection)
    && !/\b(?:clear articulation|clearly articulated|without muffling)\b/i.test(cleanedDirection);
  const baseDirection = explicitDirection
    ? `${cleanedDirection}${articulationGuard ? ', with clear but soft articulation, without muffling the voice' : ''}`
    : `${fishEmotionDirection(profile)}, ${fishPaceDirection(profile)}`;
  const direction = `${baseDirection.slice(0, 300)}, ending cleanly on the final spoken word`.slice(0, 360);
  return `[${direction}]\n${spoken}`;
}

export function buildFishTtsRequest(text = '', referenceId = '', config = {}, profile = {}) {
  const cfg = mergeConfig(config);
  const fish = cfg.fish || DEFAULT_VOICE_TOOL_CONFIG.fish;
  const body = {
    text: prepareVoiceTextForFish(text, cfg, profile),
    reference_id: String(referenceId || profile.voiceId || '').trim(),
    temperature: clampOptionalNumber(
      profile.temperature,
      0,
      1,
      fish.temperature,
    ),
    top_p: clampOptionalNumber(profile.topP, 0, 1, fish.topP),
    prosody: {
      speed: clampOptionalNumber(profile.speed, 0.5, 2, fish.speed),
      volume: clampOptionalNumber(profile.vol, -20, 20, fish.volume),
      normalize_loudness: fish.normalizeLoudness !== false,
    },
    chunk_length: clampInteger(
      fish.chunkLength,
      100,
      300,
      DEFAULT_VOICE_TOOL_CONFIG.fish.chunkLength,
    ),
    min_chunk_length: clampInteger(
      fish.minChunkLength,
      0,
      100,
      DEFAULT_VOICE_TOOL_CONFIG.fish.minChunkLength,
    ),
    condition_on_previous_chunks: fish.conditionOnPreviousChunks !== false,
    normalize: fish.normalize !== false,
    format: String(fish.format || DEFAULT_VOICE_TOOL_CONFIG.fish.format),
    sample_rate: clampInteger(
      fish.sampleRate,
      8000,
      48000,
      DEFAULT_VOICE_TOOL_CONFIG.fish.sampleRate,
    ),
    latency: String(fish.latency || DEFAULT_VOICE_TOOL_CONFIG.fish.latency),
  };
  if (body.format === 'mp3') {
    body.mp3_bitrate = [64, 128, 192].includes(Number(fish.mp3Bitrate))
      ? Number(fish.mp3Bitrate)
      : DEFAULT_VOICE_TOOL_CONFIG.fish.mp3Bitrate;
  }
  if (fish.qualityGuard !== false) body.features = ['quality-guard'];
  return body;
}

/** 合成前的朗读文本（供测试与缓存键对齐）；展示转写请用 stripVoiceDisplayTags。 */
export function prepareVoiceSpeechText(text = '', config = {}) {
  const cfg = mergeConfig(config);
  return cfg.provider === 'fish'
    ? prepareVoiceTextForFish(text, cfg)
    : prepareVoiceTextForMiniMax(text, cfg);
}

function hexToDataUrl(hex = '', mime = 'audio/mpeg') {
  const clean = String(hex || '').replace(/\s+/g, '');
  if (!clean || clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return '';
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function dataUrlToBlob(dataUrl = '') {
  const raw = String(dataUrl || '').trim();
  if (!raw || !/^data:/i.test(raw) || typeof Blob === 'undefined') return null;
  const match = raw.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) return null;
  const mime = String(match[1] || 'application/octet-stream').trim() || 'application/octet-stream';
  const isBase64 = !!match[2];
  const body = String(match[3] || '');
  try {
    if (isBase64) {
      const binary = atob(body.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  } catch (_) {
    return null;
  }
}

function mimeForFormat(format = 'mp3') {
  const f = String(format || '').toLowerCase();
  if (f === 'wav') return 'audio/wav';
  if (f === 'flac') return 'audio/flac';
  if (f === 'pcm') return 'audio/L16';
  return 'audio/mpeg';
}

export function createVoicePlaybackUrl(audioPayload = {}) {
  const raw = String(audioPayload?.audioDataUrl || audioPayload?.url || '').trim();
  const blob = audioPayload?.audioBlob instanceof Blob
    ? audioPayload.audioBlob
    : (raw && /^data:/i.test(raw) ? dataUrlToBlob(raw) : null);
  if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const objectUrl = URL.createObjectURL(blob);
    return {
      url: objectUrl,
      revoke() {
        try { URL.revokeObjectURL(objectUrl); } catch (_) {}
      },
    };
  }
  return { url: raw, revoke() {} };
}

let voicePlaybackPrime = null;

export async function primeVoicePlayback() {
  if (voicePlaybackPrime) return voicePlaybackPrime;
  voicePlaybackPrime = (async () => {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return false;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        setTimeout(() => {
          try { ctx.close?.(); } catch (_) {}
        }, 1200);
        return true;
      }
      const audio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQQAAAAAAA==');
      audio.volume = 0;
      audio.setAttribute('playsinline', 'true');
      await audio.play().catch(() => {});
      setTimeout(() => {
        try { audio.pause(); } catch (_) {}
      }, 200);
      return true;
    } catch (_) {
      return false;
    } finally {
      voicePlaybackPrime = null;
    }
  })();
  return voicePlaybackPrime;
}

async function stableHash(input = '') {
  const text = String(input || '');
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return String(h >>> 0);
}

async function loadCacheIndex() {
  const row = await db.get('settings', VOICE_CACHE_INDEX_KEY);
  return Array.isArray(row?.value) ? row.value.filter((x) => x?.key) : [];
}

async function saveCacheIndex(index = []) {
  await db.put('settings', { key: VOICE_CACHE_INDEX_KEY, value: Array.isArray(index) ? index : [] });
}

export async function getVoiceCacheStats() {
  const entries = await listVoiceCacheEntries();
  const totalBytes = entries.reduce((sum, item) => sum + (Number(item?.bytes || 0) || 0), 0);
  return { count: entries.length, totalBytes };
}

/** 列出本机语音缓存。payload 保留 Blob 引用，供用户手势内直接试听或导出。 */
export async function listVoiceCacheEntries() {
  const index = await loadCacheIndex();
  const commonEntries = await Promise.all(index.map(async (item) => {
    const cached = await getCachedAudio(item.key);
    const audioBlob = cached?.audioBlob instanceof Blob ? cached.audioBlob : null;
    return {
      key: String(item.key || ''),
      storageKey: `${VOICE_CACHE_ROW_PREFIX}${String(item.key || '')}`,
      scope: 'common',
      createdAt: Number(item.createdAt || cached?.createdAt || 0) || 0,
      updatedAt: Number(item.updatedAt || cached?.updatedAt || 0) || 0,
      bytes: Number(item.bytes || cached?.bytes || audioBlob?.size || 0) || 0,
      provider: String(item.provider || cached?.provider || ''),
      voiceId: String(item.voiceId || cached?.voiceId || ''),
      model: String(item.model || cached?.model || ''),
      format: String(item.format || cached?.format || ''),
      textPreview: String(item.textPreview || cached?.text || '').trim().slice(0, 60),
      available: !!cached && (
        !!cached.audioDataUrl
        || cached.audioBlob instanceof Blob
      ),
      payload: cached || null,
    };
  }));
  const callIndex = await loadCallLineVoiceIndex();
  const callEntries = await Promise.all(callIndex.map(async (item) => {
    const storageKey = String(item.key || '');
    const row = storageKey ? await db.get('settings', storageKey) : null;
    const cached = row?.value || null;
    const audioBlob = cached?.audioBlob instanceof Blob ? cached.audioBlob : null;
    return {
      key: storageKey,
      storageKey,
      scope: 'call',
      createdAt: Number(cached?.createdAt || 0) || 0,
      updatedAt: Number(item.updatedAt || cached?.updatedAt || 0) || 0,
      bytes: Number(item.bytes || cached?.bytes || audioBlob?.size || 0) || 0,
      provider: String(cached?.provider || ''),
      voiceId: String(cached?.voiceId || ''),
      model: String(cached?.model || ''),
      format: String(cached?.format || ''),
      textPreview: String(cached?.text || '').trim().slice(0, 60),
      available: !!cached && (
        !!cached.audioDataUrl
        || cached.audioBlob instanceof Blob
      ),
      payload: cached,
    };
  }));
  const settingsRows = await db.getAllRecords('settings').catch(() => []);
  const streamerEntries = settingsRows
    .filter((row) => String(row?.key || '').startsWith(STREAMER_LINE_VOICE_PREFIX))
    .map((row) => {
      const cached = row?.value || null;
      const audioBlob = cached?.audioBlob instanceof Blob ? cached.audioBlob : null;
      return {
        key: String(row.key || ''),
        storageKey: String(row.key || ''),
        scope: 'streamer',
        createdAt: Number(cached?.createdAt || 0) || 0,
        updatedAt: Number(cached?.updatedAt || cached?.createdAt || 0) || 0,
        bytes: Number(cached?.bytes || audioBlob?.size || 0) || 0,
        provider: String(cached?.provider || ''),
        voiceId: String(cached?.voiceId || ''),
        model: String(cached?.model || ''),
        format: String(cached?.format || ''),
        textPreview: String(cached?.text || '').trim().slice(0, 60),
        available: !!cached && (
          !!cached.audioDataUrl
          || cached.audioBlob instanceof Blob
        ),
        payload: cached,
      };
    });
  return [...commonEntries, ...callEntries, ...streamerEntries]
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
}

/** 删除一条本机语音缓存，同时维护索引。 */
export async function deleteVoiceCachedAudio(cacheKey = '') {
  const requestedKey = String(cacheKey || '').trim();
  if (!requestedKey) return false;
  const storageKey = requestedKey.startsWith(VOICE_CACHE_ROW_PREFIX)
    || requestedKey.startsWith(CALL_LINE_VOICE_PREFIX)
    || requestedKey.startsWith(STREAMER_LINE_VOICE_PREFIX)
    ? requestedKey
    : `${VOICE_CACHE_ROW_PREFIX}${requestedKey}`;
  const existed = !!(await db.get('settings', storageKey));
  await db.remove(storageKey).catch(() => {});

  if (storageKey.startsWith(VOICE_CACHE_ROW_PREFIX)) {
    const logicalKey = storageKey.slice(VOICE_CACHE_ROW_PREFIX.length);
    const index = await loadCacheIndex();
    const next = index.filter((item) => item.key !== logicalKey);
    if (next.length !== index.length) await saveCacheIndex(next);
    return existed || next.length !== index.length;
  }
  if (storageKey.startsWith(CALL_LINE_VOICE_PREFIX)) {
    const index = await loadCallLineVoiceIndex();
    const next = index.filter((item) => item.key !== storageKey);
    if (next.length !== index.length) {
      await db.put('settings', { key: CALL_LINE_VOICE_INDEX_KEY, value: next });
    }
    return existed || next.length !== index.length;
  }
  return existed;
}

export async function clearVoiceCache() {
  const entries = await listVoiceCacheEntries();
  await Promise.all(entries.map((item) => db.remove(item.storageKey || item.key).catch(() => {})));
  await saveCacheIndex([]);
  await db.put('settings', { key: CALL_LINE_VOICE_INDEX_KEY, value: [] });
}

async function getCachedAudio(cacheKey = '') {
  const key = String(cacheKey || '').trim();
  if (!key) return null;
  const row = await db.get('settings', `${VOICE_CACHE_ROW_PREFIX}${key}`);
  return row?.value || null;
}

/** 只读取已经存在的 TTS 缓存，供用户导出；不会触发重新合成。 */
export async function getVoiceCachedAudio(cacheKey = '') {
  const cached = await getCachedAudio(cacheKey);
  if (!cached) return null;
  return hydrateCachedAudio(cached);
}

/** 恢复角色时光档案中已经存在的 TTS 缓存；不会调用语音接口。 */
export async function restoreVoiceCachedAudio(cacheKey = '', payload = null) {
  const key = String(cacheKey || '').trim();
  if (!key || !payload || (!payload.audioDataUrl && !(payload.audioBlob instanceof Blob))) return false;
  await putCachedAudio(key, { ...payload, cacheKey: key }, {
    cache: { enabled: true, maxEntries: 1000 },
  });
  return true;
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    if (!(blob instanceof Blob) || typeof FileReader === 'undefined') {
      resolve('');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(blob);
  });
}

/**
 * 缓存落盘时为了省 IndexedDB 空间，有 Blob 就会删掉体积翻倍的 base64 audioDataUrl（见 putCachedAudio）。
 * 但很多调用方（陪伴 session 落库、通话重听等）预期拿到的音频负载里始终有 audioDataUrl 字符串，
 * 缓存命中时如果只有 audioBlob 就把它原样吐出去，会在这些地方表现成"重听等于没缓存、每次都要重新合成"。
 * 统一在这里把 audioBlob 补回 audioDataUrl，让缓存命中和现场合成对调用方来说是同一种形状。
 */
async function hydrateCachedAudio(cached) {
  if (!cached) return null;
  if (cached.audioDataUrl) return cached;
  if (cached.audioBlob instanceof Blob) {
    const audioDataUrl = await blobToDataUrl(cached.audioBlob);
    if (audioDataUrl) return { ...cached, audioDataUrl };
  }
  return cached;
}

async function putCachedAudio(cacheKey, value, cfg = {}) {
  const key = String(cacheKey || '').trim();
  if (!key || (!value?.audioDataUrl && !(value?.audioBlob instanceof Blob))) return;
  const createdAt = Date.now();
  const audioBlob = value.audioBlob instanceof Blob ? value.audioBlob : dataUrlToBlob(value.audioDataUrl || '');
  const bytes = audioBlob instanceof Blob
    ? audioBlob.size
    : Math.round(String(value.audioDataUrl || '').length * 0.75);
  const nextValue = {
    ...value,
    key,
    createdAt,
    updatedAt: createdAt,
    bytes,
  };
  if (audioBlob instanceof Blob) {
    nextValue.audioBlob = audioBlob;
    delete nextValue.audioDataUrl;
  }
  await db.put('settings', {
    key: `${VOICE_CACHE_ROW_PREFIX}${key}`,
    value: nextValue,
  });
  const limit = clampNumber(cfg.cache?.maxEntries, 10, 1000, DEFAULT_VOICE_TOOL_CONFIG.cache.maxEntries);
  const index = (await loadCacheIndex()).filter((item) => item.key !== key);
  index.unshift({
    key,
    createdAt,
    updatedAt: createdAt,
    bytes,
    provider: value.provider || '',
    voiceId: value.voiceId || '',
    model: value.model || '',
    format: value.format || '',
    textPreview: String(value.text || '').slice(0, 40),
  });
  const overflow = index.splice(limit);
  await Promise.all(overflow.map((item) => db.remove(`${VOICE_CACHE_ROW_PREFIX}${item.key}`).catch(() => {})));
  await saveCacheIndex(index);
}

function parseVoiceArtifactDurationSeconds(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const clock = raw.match(/^(\d+):(\d{1,2})$/);
  if (clock) {
    const seconds = Number(clock[1]) * 60 + Number(clock[2]);
    return seconds > 0 && seconds <= 600 ? Math.round(seconds) : null;
  }
  const numeric = raw.match(/^(\d+(?:\.\d+)?)\s*(?:秒|s|sec(?:ond)?s?)?$/i);
  if (!numeric) return null;
  const seconds = Math.round(Number(numeric[1]));
  return seconds > 0 && seconds <= 600 ? seconds : null;
}

function voiceDurationArtifactTokens(options = {}) {
  const values = [options.seconds, options.durationSeconds, options.duration];
  const seconds = values.map(parseVoiceArtifactDurationSeconds).find((value) => value != null);
  if (seconds == null) return [];
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return [
    `${seconds}`,
    `${seconds}秒`,
    `${seconds} 秒`,
    `${seconds}s`,
    `${seconds} s`,
    `${minutes}:${remainder}`,
    `${String(minutes).padStart(2, '0')}:${remainder}`,
  ];
}

function escapeVoiceArtifactToken(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
}

function looksLikeSpokenDurationLead(value = '') {
  const body = String(value || '').trim();
  if (!body) return false;
  return /(?:等我|等一下|再等|给我|倒数|数|停|暂停|缓|撑|坚持|沉默|安静|保留|需要|只要|花了|用了|还有|只剩|不到|超过|至少|最多|大概|大约|约|差不多)\s*$/u.test(body)
    || /(?:wait|give me|count|pause|hold|stay|last|need|take|for|in|after|about|around)\s*$/i.test(body);
}

/**
 * 弱模型偶尔会把 voice.seconds / duration 掉进 text 尾部。
 * 只删除字段标签、括号时长或与独立时长字段一致的分隔尾巴，保留“等我 4 秒”等正常台词。
 */
export function sanitizeVoiceTranscriptText(text = '', options = {}) {
  let value = String(text || '').trim();
  if (!value) return '';
  const stripSuffix = (pattern) => {
    const match = value.match(pattern);
    const body = String(match?.[1] || '').trim();
    if (body) value = body;
  };
  const visibleDurationToken = '(?:\\d{1,3}(?:\\.\\d+)?\\s*(?:秒|s|secs?|seconds?)|\\d{1,2}:\\d{1,2})';
  const labeledDurationToken = '(?:\\d{1,3}(?:\\.\\d+)?\\s*(?:秒|s|secs?|seconds?)?|\\d{1,2}:\\d{1,2})';
  const durationField = '(?:语音)?(?:时长|duration(?:Seconds)?|seconds?)';
  stripSuffix(new RegExp(`^([\\s\\S]*?)(?:\\s*[,，;；|｜·-]\\s*|\\s+)${durationField}\\s*[:：=]\\s*${labeledDurationToken}\\s*$`, 'i'));
  stripSuffix(new RegExp(`^([\\s\\S]*?)\\s*[（(\\[【]\\s*(?:${durationField}\\s*[:：=]?\\s*${labeledDurationToken}|${visibleDurationToken})\\s*[）)\\]】]\\s*$`, 'i'));

  // `0:04 台词` 是模型模仿旧上下文格式后最常见的泄漏。语音转写开头的零分钟
  // MM:SS 不可能是自然的口语时间表达；即使模型写出的数字与 seconds 相差一秒，也应删除。
  // 只处理 0/00 分钟，保留“8:30 开会”“12:05 到站”等真实钟点。
  value = value.replace(
    /^(?:[（(\[【]\s*)?(?:0|00):[0-5]\d(?:\s*[）)\]】])?(?:\s*[,，;；|｜·-]\s*|[ \t]+)(?=\S)/u,
    '',
  ).trim();

  const expectedTokens = voiceDurationArtifactTokens(options);
  if (expectedTokens.length) {
    const expected = expectedTokens.map(escapeVoiceArtifactToken).join('|');
    // 非零分钟或纯秒数仍要求与独立时长字段一致，避免误删正常数字台词。
    value = value.replace(
      new RegExp(`^(?:${expected})(?:\\s*[,，;；|｜·-]\\s*|[ \\t]+)(?=\\S)`, 'i'),
      '',
    ).trim();
    // 只有换行、字段分隔符或完整句号之后的同值尾巴才视为元数据；普通句中时间表达不动。
    stripSuffix(new RegExp(`^([\\s\\S]*?)(?:\\r?\\n|[,，|｜;；]\\s*)(?:${expected})\\s*$`, 'i'));
    stripSuffix(new RegExp(`^([\\s\\S]*?[。！？!?…~～])\\s*(?:${expected})\\s*$`, 'i'));
    const spokenExpected = expectedTokens
      .filter((token) => !/^\d+$/.test(token))
      .map(escapeVoiceArtifactToken)
      .join('|');
    const looseMatch = spokenExpected
      ? value.match(new RegExp(`^([\\s\\S]*\\S)[ \\t]+(?:${spokenExpected})\\s*$`, 'i'))
      : null;
    const looseBody = String(looseMatch?.[1] || '').trim();
    if (looseBody && !looksLikeSpokenDurationLead(looseBody)) value = looseBody;
  }
  return value;
}

export function getVoiceTextForMessage(message = {}) {
  const metaText = sanitizeVoiceTranscriptText(message.metadata?.text || '', message.metadata || {});
  const content = String(message.content || '').trim();
  const visibleText = metaText || sanitizeVoiceTranscriptText(content, message.metadata || {});
  const speechPlan = normalizeVoiceSpeechPlan(message.metadata?.speechPlan, visibleText);
  // 朗读只读外语原文：万一模型误把〔中文翻译〕标记混进了转写文本，这里兜底剥掉，
  // 翻译只应该出现在 metadata.translation 里，靠前台点按查看。
  if (speechPlan?.text) {
    return stripTranslationMarks(sanitizeVoiceTranscriptText(speechPlan.text, message.metadata || {}));
  }
  if (metaText) return stripTranslationMarks(metaText);
  if (!content || /^\[语音消息/.test(content)) return '';
  return stripTranslationMarks(sanitizeVoiceTranscriptText(content, message.metadata || {}));
}

const MINIMAX_PAREN_SOUND_RE = /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi;

// Fish 会把英文自然语言写在 [] 里作为表演指导。模型也可能自行缩写成
// [warm and comforting] / [soft, smiling] / [low, coaxing]；这些内容应交给 TTS，不能进入字幕。
// 只识别高置信度的英文表演描述，保留 [Chapter 1]、[I love you] 等普通方括号正文。
const FISH_DISPLAY_CUE_MARKER_RE = /\b(?:tone|voice|vocal|speak(?:ing|s|er)?|spoken|whisper(?:ing|ed|s)?|murmur(?:ing|ed|s)?|breath(?:ing|s|y)?|inhale|exhale|sigh(?:ing|s|ed)?|laugh(?:ing|s|ed)?|chuckle(?:ing|s|ed)?|giggl(?:ing|ed|es|e)|smil(?:ing|ed|es|e)|coax(?:ing|ingly|ed|es)?|sooth(?:ing|ingly|ed|es|e)?|cough(?:ing|s|ed)?|pause(?:s|d|ing)?|emotion(?:al|ally|s)?|reassur(?:ing|ingly|ed)?|comfort(?:ing|ingly|ed)?|articulat(?:ion|ed|ing)|phrasing|hesitat(?:e|es|ed|ing|ion)|audible|theatrical|restrained|muffl(?:ed|ing)|continu(?:e|es|ed|ing))\b/i;
const FISH_DISPLAY_CUE_STYLE_RE = /\b(?:warm|warmly|soft|softly|low|gentle|gently|calm|calmly|quiet|quietly|slow|slowly|fast|faster|serious|firm|tense|tender|tenderly|intimate|playful|natural|relaxed|subdued|vulnerable|pleased|happy|sad|angry|fearful|surprised|displeased|composed|breathy|airy|hushed|sleepy|soothing)\b/gi;
const FISH_DISPLAY_SINGLE_STYLE_CUE_RE = /^(?:warm|warmly|soft|softly|low|gentle|gently|calm|calmly|quiet|quietly|slow|slowly|fast|faster|serious|firm|tense|tender|tenderly|intimate|playful|natural|relaxed|subdued|vulnerable|pleased|happy|sad|angry|fearful|surprised|displeased|composed|breathy|airy|hushed|sleepy|soothing)$/i;
const MINIMAX_ANGLE_SOUND_RE = /<\s*\/?\s*(?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\s*>/gi;

function isFishDisplayPerformanceCue(value = '', { allowSingleStyle = false } = {}) {
  const cue = String(value || '').trim();
  if (!cue || cue.length > 240 || /[^\x00-\x7f]/.test(cue) || !/[A-Za-z]/.test(cue)) return false;
  if (FISH_DISPLAY_CUE_MARKER_RE.test(cue)) return true;
  const styleWords = new Set((cue.match(FISH_DISPLAY_CUE_STYLE_RE) || []).map((word) => word.toLowerCase()));
  return styleWords.size >= 2 || (allowSingleStyle && FISH_DISPLAY_SINGLE_STYLE_CUE_RE.test(cue));
}

/**
 * 清理模型误写进可见正文的高置信度语音表演标签。
 * 不移除普通中文括号动作、HTML 或 [Chapter 1] 等可能属于正文的内容。
 */
export function stripLeakedVoicePerformanceTags(text = '') {
  return String(text || '')
    .replace(/<#\d+(?:\.\d+)?#>/g, ' ')
    .replace(MINIMAX_ANGLE_SOUND_RE, ' ')
    .replace(MINIMAX_PAREN_SOUND_RE, ' ')
    .replace(/\[([^\[\]\r\n]{1,240})\]/g, (full, cue, offset, source) => {
      const prefix = source.slice(0, offset);
      const atLineStart = /(?:^|\n)[ \t]*$/.test(prefix);
      return isFishDisplayPerformanceCue(cue, { allowSingleStyle: atLineStart }) ? ' ' : full;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip provider performance / pause tags for on-screen voice transcripts.
 * Keeps spoken words only: <#0.5#>, <laughs>, (breath), and Fish [] cues are TTS metadata.
 */
export function stripVoiceDisplayTags(text = '') {
  return stripLeakedVoicePerformanceTags(text)
    .replace(/<[^<>\n]{0,48}>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const VOICE_SPEECH_PLAN_EMOTIONS = new Set([
  'neutral',
  'happy',
  'sad',
  'angry',
  'fearful',
  'surprised',
  'disgusted',
]);
const VOICE_SPEECH_PLAN_PACES = new Set(['slow', 'normal', 'fast']);
const FISH_OVERDRAMATIC_DIRECTION_RE = /\b(?:growl(?:ing|ed|s)?|snarl(?:ing|ed|s)?|roar(?:ing|ed|s)?|booming|thunderous)\b/i;

function comparableVoiceSpeechText(text = '') {
  return stripTranslationMarks(stripVoiceDisplayTags(normalizeVoiceAngleTags(text)))
    .replace(/\s+/g, '')
    .trim();
}

/**
 * AI 表演轨只能给可见正文加 MiniMax 标签，不能借隐藏字段改词。
 * 若正文对不上，保留情绪/速度提示但强制退回可见文字，避免听到屏幕上没有的内容。
 */
export function normalizeVoiceSpeechPlan(rawPlan = null, visibleText = '') {
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) return null;
  const visible = stripTranslationMarks(String(visibleText || '').trim());
  if (!visible) return null;
  const candidate = String(rawPlan.text || rawPlan.speechText || '').trim();
  const textMatches = !!candidate
    && comparableVoiceSpeechText(candidate) === comparableVoiceSpeechText(visible);
  const emotionValue = normalizeEmotionKey(rawPlan.emotion);
  const emotion = VOICE_SPEECH_PLAN_EMOTIONS.has(emotionValue) ? emotionValue : 'neutral';
  const paceValue = String(rawPlan.pace || '').trim().toLowerCase();
  const pace = VOICE_SPEECH_PLAN_PACES.has(paceValue) ? paceValue : 'normal';
  const intensity = normalizeVoiceEmotionIntensity(
    rawPlan.intensity ?? rawPlan.emotionIntensity ?? rawPlan.emotion_intensity,
    emotion,
  );
  const rawPerformanceDirection = String(
    rawPlan.direction
    || rawPlan.performanceDirection
    || rawPlan.performance_direction
    || '',
  )
    .replace(/[\[\]\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 240);
  // Fish 的自然语言 direction 会被模型直接当作表演依据。AI 偶发写出的低吼、
  // 咆哮或舞台腔会明显破坏克隆声线；丢弃该条 direction，保留正文、情绪和语速兜底。
  const performanceDirection = FISH_OVERDRAMATIC_DIRECTION_RE.test(rawPerformanceDirection)
    ? ''
    : rawPerformanceDirection;
  return {
    text: textMatches ? candidate : visible,
    emotion,
    pace,
    intensity,
    ...(performanceDirection ? { performanceDirection } : {}),
  };
}

export function buildVoiceSpeechProfileOverride(rawProfile = {}, speechPlan = null, cfg = {}) {
  if (!speechPlan) return null;
  const base = rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile)
    ? rawProfile
    : {};
  const providerDefaultSpeed = cfg.provider === 'fish' ? cfg.fish?.speed : cfg.speed;
  const legacyFishOnly = cfg.provider === 'fish'
    && !!String(base.fishReferenceId || base.fish_reference_id || '').trim()
    && !String(base.voiceId || base.voice_id || '').trim();
  const providerBaseSpeed = cfg.provider === 'fish'
    ? (base.fishSpeed ?? base.fish_speed ?? (legacyFishOnly ? base.speed : undefined))
    : base.speed;
  const baseSpeed = clampOptionalNumber(providerBaseSpeed, 0.5, 2, providerDefaultSpeed || 1);
  const baseEmotion = cfg.provider === 'fish'
    ? (base.fishEmotion ?? base.fish_emotion ?? (legacyFishOnly ? base.emotion : undefined))
    : base.emotion;
  const intensity = normalizeVoiceEmotionIntensity(speechPlan.intensity, speechPlan.emotion);
  const paceStrength = 0.45 + (intensity * 0.55);
  const paceDelta = speechPlan.pace === 'slow'
    ? -0.08 * paceStrength
    : speechPlan.pace === 'fast'
      ? 0.08 * paceStrength
      : 0;
  return {
    ...base,
    ...(cfg.provider === 'fish'
      ? {
        fishSpeed: clampNumber(baseSpeed + paceDelta, 0.5, 2, baseSpeed),
        fishEmotion: speechPlan.emotion || baseEmotion || cfg.emotion || '',
        fishEmotionIntensity: intensity,
        fishPerformanceDirection: speechPlan.performanceDirection
          || base.fishPerformanceDirection
          || '',
      }
      : {
        speed: clampNumber(baseSpeed + paceDelta, 0.5, 2, baseSpeed),
        emotion: speechPlan.emotion || baseEmotion || cfg.emotion || '',
        emotionIntensity: intensity,
      }),
  };
}

export async function buildVoiceCacheKey({ text = '', characterId = '', config = null, voiceProfileOverride = null } = {}) {
  const rawProfile = (voiceProfileOverride && typeof voiceProfileOverride === 'object')
    ? voiceProfileOverride
    : await loadCharacterVoiceProfile(characterId);
  const cfg = resolveVoiceToolConfigForProfile(
    config || await loadVoiceToolConfig(),
    rawProfile,
  );
  const profile = applyVoiceStyleProfile(await normalizeVoiceProfile(cfg, characterId, voiceProfileOverride), cfg);
  const speechText = cfg.provider === 'fish'
    ? prepareVoiceTextForFish(text, cfg, profile)
    : prepareVoiceTextForMiniMax(text, cfg);
  return stableHash(JSON.stringify({
    provider: cfg.provider,
    region: cfg.region,
    endpoint: cfg.endpoint,
    model: cfg.model,
    languageBoost: cfg.languageBoost,
    text: speechText,
    voice: profile,
    audio: cfg.audio,
    fish: cfg.provider === 'fish' ? {
      endpoint: cfg.fish?.endpoint,
      model: cfg.fish?.model,
      temperature: cfg.fish?.temperature,
      topP: cfg.fish?.topP,
      speed: cfg.fish?.speed,
      volume: cfg.fish?.volume,
      normalizeLoudness: cfg.fish?.normalizeLoudness,
      normalize: cfg.fish?.normalize,
      chunkLength: cfg.fish?.chunkLength,
      minChunkLength: cfg.fish?.minChunkLength,
      conditionOnPreviousChunks: cfg.fish?.conditionOnPreviousChunks,
      latency: cfg.fish?.latency,
      qualityGuard: cfg.fish?.qualityGuard,
      format: cfg.fish?.format,
      sampleRate: cfg.fish?.sampleRate,
      mp3Bitrate: cfg.fish?.mp3Bitrate,
    } : undefined,
    styleBook: cfg.styleBook,
    textNormalizationVersion: VOICE_TTS_TEXT_NORMALIZATION_VERSION,
  }));
}

/**
 * voiceProfileOverride：跳过 characters 表查找，直接用给定的 { voiceId, languageBoost, speed, vol, pitch, emotion }。
 * 供没有落库到 characters 表的人格（如匿名主播现场生成人格）使用自己的声线设置。
 */
export async function synthesizeVoice({
  text,
  characterId = '',
  config = null,
  signal,
  voiceProfileOverride = null,
  skipCache = false,
} = {}) {
  const rawProfile = (voiceProfileOverride && typeof voiceProfileOverride === 'object')
    ? voiceProfileOverride
    : await loadCharacterVoiceProfile(characterId);
  const cfg = resolveVoiceToolConfigForProfile(
    config || await loadVoiceToolConfig(),
    rawProfile,
  );
  if (!isVoiceToolEnabled(cfg)) {
    throw new Error(
      cfg.provider === 'fish'
        ? '语音接口未启用，或缺少 Fish Audio API Key / 模型。'
        : '语音接口未启用，或缺少 MiniMax API Key / 模型。',
    );
  }
  const cleanText = String(text || '').trim();
  if (!cleanText) throw new Error('语音文本为空。');
  if (cleanText.length > 10000) throw new Error('同步 TTS 单次文本不能超过 10000 字。');

  if (!isCharacterVoiceTtsEnabled(rawProfile, cfg.provider)) {
    throw createVoiceTtsDisabledError();
  }
  const profile = applyVoiceStyleProfile(await normalizeVoiceProfile(cfg, characterId, voiceProfileOverride), cfg);
  if (!profile.voiceId) throw createVoiceTtsDisabledError();
  const speechText = cfg.provider === 'fish'
    ? prepareVoiceTextForFish(cleanText, cfg, profile)
    : prepareVoiceTextForMiniMax(cleanText, cfg);

  const cacheKey = await buildVoiceCacheKey({ text: cleanText, characterId, config: cfg, voiceProfileOverride });
  if (!skipCache && cfg.cache?.enabled !== false) {
    const cached = await getCachedAudio(cacheKey);
    if (cached?.audioDataUrl || cached?.audioBlob instanceof Blob) {
      const hydrated = await hydrateCachedAudio(cached);
      return { ...hydrated, cacheKey, fromCache: true };
    }
  }
  if (cfg.provider === 'fish') {
    const fish = cfg.fish || DEFAULT_VOICE_TOOL_CONFIG.fish;
    const body = buildFishTtsRequest(cleanText, profile.voiceId, cfg, profile);
    const url = buildFishApiUrl(cfg);
    const apiKey = String(fish.apiKey || '').trim();
    const model = String(fish.model || DEFAULT_VOICE_TOOL_CONFIG.fish.model).trim();
    const target = resolveFishTtsRequestTarget(url);
    const requestHeaders = target.proxied
      ? {
        'Content-Type': 'application/json',
        'X-Fish-Audio-Key': apiKey,
        'X-Fish-Audio-Model': model,
      }
      : {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model,
      };
    const requestStartedAt = Date.now();
    let status = 0;
    let statusText = '';
    let responseHeaders = {};
    let audioBytes;
    try {
      if (isNativeAppShell() && hasNativeHttp()) {
        const nativeResult = await nativeHttpPostJsonBytes(url, {
          headers: requestHeaders,
          body,
          signal,
        });
        status = nativeResult.status;
        statusText = String(status);
        responseHeaders = nativeResult.headers;
        audioBytes = nativeResult.bytes;
      } else {
        const res = await fetch(target.url, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(body),
          signal,
        });
        status = res.status;
        statusText = res.statusText;
        responseHeaders = res.headers;
        audioBytes = new Uint8Array(await res.arrayBuffer());
      }
    } catch (err) {
      throw wrapNetworkError(err, url, Date.now() - requestStartedAt, 'fish');
    }
    if (status < 200 || status >= 300) {
      const detail = fishApiErrorDetail(decodeResponseBytes(audioBytes));
      throw new Error(`Fish Audio TTS 失败 (${status}): ${detail || statusText}`);
    }
    if (!audioBytes?.byteLength) throw new Error('Fish Audio TTS 没有返回可播放音频。');
    const format = String(body.format || DEFAULT_VOICE_TOOL_CONFIG.fish.format);
    const contentType = responseHeaderValue(responseHeaders, 'content-type').split(';')[0].trim();
    const audioBlob = new Blob([audioBytes], { type: contentType || mimeForFormat(format) });
    const audioDataUrl = await blobToDataUrl(audioBlob);
    const payload = {
      cacheKey,
      provider: cfg.provider,
      audioDataUrl,
      audioBlob,
      text: cleanText,
      ttsText: body.text,
      characterId: String(characterId || ''),
      voiceId: profile.voiceId,
      model: String(fish.model || ''),
      format,
      extraInfo: {
        temperature: body.temperature,
        topP: body.top_p,
        chunkLength: body.chunk_length,
      },
      traceId: responseHeaderValue(responseHeaders, 'x-request-id'),
    };
    if (!skipCache && cfg.cache?.enabled !== false) await putCachedAudio(cacheKey, payload, cfg);
    return { ...payload, fromCache: false };
  }

  const format = String(cfg.audio?.format || 'mp3').trim() || 'mp3';
  const body = {
    model: String(cfg.model || '').trim(),
    text: speechText,
    stream: false,
    language_boost: String(profile.languageBoost || cfg.languageBoost || 'auto').trim() || 'auto',
    output_format: 'hex',
    voice_setting: buildMiniMaxVoiceSetting(profile, cfg),
    audio_setting: buildMiniMaxAudioSetting(cfg.audio, format),
    subtitle_enable: false,
  };

  const url = buildApiUrl(cfg);
  const target = resolveMiniMaxTtsRequestTarget(url);
  const apiKey = String(cfg.apiKey || '').trim();
  const requestHeaders = target.proxied
    ? {
      'Content-Type': 'application/json',
      'X-MiniMax-Key': apiKey,
      'X-MiniMax-Region': target.region,
    }
    : {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  const requestStartedAt = Date.now();
  let res;
  try {
    res = isNativeAppShell() && hasNativeHttp()
      ? await nativeHttpPostJson(url, {
        headers: requestHeaders,
        body,
        signal,
      })
      : await fetch(target.url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal,
      });
  } catch (err) {
    throw wrapNetworkError(err, url, Date.now() - requestStartedAt, 'minimax');
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`MiniMax TTS 失败 (${res.status}): ${raw || res.statusText}`);
  }
  const data = await res.json();
  const statusCode = Number(data?.base_resp?.status_code ?? 0);
  if (statusCode !== 0) {
    throw new Error(`MiniMax TTS 失败 (${statusCode}): ${data?.base_resp?.status_msg || 'unknown'}`);
  }
  const hex = String(data?.data?.audio || '').trim();
  const audioDataUrl = hexToDataUrl(hex, mimeForFormat(format));
  if (!audioDataUrl) throw new Error('MiniMax TTS 没有返回可播放音频。');
  const audioBlob = dataUrlToBlob(audioDataUrl);

  const payload = {
    cacheKey,
    provider: cfg.provider,
    audioDataUrl,
    audioBlob,
    text: cleanText,
    ttsText: speechText,
    characterId: String(characterId || ''),
    voiceId: profile.voiceId,
    model: String(cfg.model || ''),
    format,
    extraInfo: data?.extra_info || {},
    traceId: data?.trace_id || '',
  };
  if (!skipCache && cfg.cache?.enabled !== false) await putCachedAudio(cacheKey, payload, cfg);
  return { ...payload, fromCache: false };
}

function streamerLineVoiceKey(channelId, lineId) {
  const cid = String(channelId || '').trim();
  const lid = String(lineId || '').trim();
  if (!cid || !lid) return '';
  return `${STREAMER_LINE_VOICE_PREFIX}${cid}_${lid}`;
}

/** 深夜主播台词专属语音缓存：按 (channelId, lineId) 精确存一份，不占全局 TTS 缓存名额、也不会被无关的语音请求挤掉 */
export async function getStreamerLineVoice(channelId, lineId) {
  const key = streamerLineVoiceKey(channelId, lineId);
  if (!key) return null;
  const row = await db.get('settings', key);
  return row?.value || null;
}

export async function removeStreamerLineVoice(channelId, lineId) {
  const key = streamerLineVoiceKey(channelId, lineId);
  if (!key) return;
  await db.remove(key).catch(() => {});
}

/**
 * 直播间台词的语音合成入口：优先播放这条台词自己专属缓存的那份音频，
 * 保证「重听」永远是当初生成的那个声音，不会因为全局语音缓存被别处挤掉而被迫用 MiniMax 重新合成出不一样的音色/语调。
 */
export async function synthesizeStreamerLineVoice({ channelId, lineId, text, characterId = '', voiceProfileOverride = null, config = null } = {}) {
  const cached = await getStreamerLineVoice(channelId, lineId);
  if (cached?.audioDataUrl || cached?.audioBlob instanceof Blob) {
    const hydrated = await hydrateCachedAudio(cached);
    return { ...hydrated, fromCache: true };
  }
  const payload = await synthesizeVoice({ text, characterId, config, voiceProfileOverride });
  const key = streamerLineVoiceKey(channelId, lineId);
  if (key) await db.put('settings', { key, value: payload }).catch(() => {});
  return payload;
}

function callLineVoiceKey(callId = '', lineId = '') {
  const cid = String(callId || '').trim();
  const lid = String(lineId || '').trim();
  if (!cid || !lid) return '';
  return `${CALL_LINE_VOICE_PREFIX}${cid}_${lid}`;
}

export function buildCallLineAudioId(text = '') {
  const value = String(text || '').trim();
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `line_${(hash >>> 0).toString(36)}`;
}

async function loadCallLineVoiceIndex() {
  const row = await db.get('settings', CALL_LINE_VOICE_INDEX_KEY);
  return Array.isArray(row?.value) ? row.value.filter((item) => item?.key) : [];
}

async function touchCallLineVoiceIndex(key = '', bytes = 0) {
  const now = Date.now();
  const index = (await loadCallLineVoiceIndex()).filter((item) => item.key !== key);
  index.unshift({ key, bytes: Number(bytes || 0) || 0, updatedAt: now });
  const overflow = index.splice(CALL_LINE_VOICE_LIMIT);
  await Promise.all(overflow.map((item) => db.remove(item.key).catch(() => {})));
  await db.put('settings', { key: CALL_LINE_VOICE_INDEX_KEY, value: index });
}

export async function getCallLineVoice(callId = '', lineId = '') {
  const key = callLineVoiceKey(callId, lineId);
  if (!key) return null;
  const row = await db.get('settings', key);
  const payload = row?.value || null;
  if (!payload) return null;
  await touchCallLineVoiceIndex(key, payload.audioBlob?.size || payload.bytes || 0).catch(() => {});
  return hydrateCachedAudio(payload);
}

export async function removeCallLineVoices(callId = '') {
  const cid = String(callId || '').trim();
  if (!cid) return;
  const prefix = `${CALL_LINE_VOICE_PREFIX}${cid}_`;
  const index = await loadCallLineVoiceIndex();
  const removed = index.filter((item) => String(item.key || '').startsWith(prefix));
  await Promise.all(removed.map((item) => db.remove(item.key).catch(() => {})));
  await db.put('settings', {
    key: CALL_LINE_VOICE_INDEX_KEY,
    value: index.filter((item) => !String(item.key || '').startsWith(prefix)),
  });
}

export async function synthesizeCallLineVoice({
  callId,
  lineId,
  text,
  characterId = '',
  voiceProfileOverride = null,
  config = null,
  signal,
} = {}) {
  const key = callLineVoiceKey(callId, lineId);
  if (!key) return null;
  const cached = await getCallLineVoice(callId, lineId);
  if (cached?.audioDataUrl || cached?.audioBlob instanceof Blob) {
    return { ...cached, fromCache: true };
  }
  const cfg = mergeConfig(config || await loadVoiceToolConfig());
  const payload = await synthesizeVoice({
    text,
    characterId,
    voiceProfileOverride,
    config: cfg,
    signal,
  });
  const audioBlob = payload.audioBlob instanceof Blob
    ? payload.audioBlob
    : dataUrlToBlob(payload.audioDataUrl || '');
  const stored = { ...payload, callId: String(callId), lineId: String(lineId), savedAt: Date.now() };
  if (audioBlob instanceof Blob) {
    stored.audioBlob = audioBlob;
    stored.bytes = audioBlob.size;
    delete stored.audioDataUrl;
  }
  await db.put('settings', { key, value: stored });
  await touchCallLineVoiceIndex(key, stored.bytes || 0);
  return { ...payload, callId: String(callId), lineId: String(lineId), fromCache: false };
}

export async function ensureVoiceAudioForMessage(message = {}, options = {}) {
  const text = getVoiceTextForMessage(message);
  const characterId = String(
    options.characterId
    || message.metadata?.speechActorId
    || message.senderId
    || '',
  ).trim();
  let cfg = mergeConfig(options.config || await loadVoiceToolConfig());
  // 已经生成过的语音属于这条消息本身：即使用户之后关闭角色 TTS，
  // 点击“播放缓存语音”仍应直接重听，不能在检查当前声线开关时静默返回。
  const existingKey = String(message.metadata?.audioCacheKey || '').trim();
  const existingCached = existingKey ? await getCachedAudio(existingKey) : null;
  const rawProfile = await loadCharacterVoiceProfile(characterId);
  cfg = resolveVoiceToolConfigForProfile(cfg, rawProfile);
  if (!isCharacterVoiceTtsEnabled(rawProfile, cfg.provider)) {
    if (existingCached?.audioDataUrl || existingCached?.audioBlob instanceof Blob) {
      const hydrated = await hydrateCachedAudio(existingCached);
      return { ...hydrated, cacheKey: existingKey, fromCache: true };
    }
    throw createVoiceTtsDisabledError();
  }
  const visibleText = String(message.metadata?.text || message.content || '').trim();
  const speechPlan = normalizeVoiceSpeechPlan(message.metadata?.speechPlan, visibleText);
  // 语音演绎模式本身就应启用内置表演处理，不依赖用户是否另外打开自定义语音世界书。
  if (speechPlan) {
    cfg.styleBook = {
      ...(cfg.styleBook || {}),
      enabled: true,
    };
  }
  const voiceProfileOverride = buildVoiceSpeechProfileOverride(rawProfile, speechPlan, cfg);
  const profile = await normalizeVoiceProfile(cfg, characterId, voiceProfileOverride);
  const expectedKey = text
    ? await buildVoiceCacheKey({
      text,
      characterId,
      config: cfg,
      voiceProfileOverride,
    })
    : '';
  if (existingKey && (!expectedKey || existingKey === expectedKey)) {
    const cachedUsable = existingCached && String(existingCached.voiceId || '') === profile.voiceId
      && (existingCached.audioDataUrl || existingCached.audioBlob instanceof Blob);
    if (cachedUsable) {
      const hydrated = await hydrateCachedAudio(existingCached);
      return { ...hydrated, cacheKey: existingKey, fromCache: true };
    }
  }
  return synthesizeVoice({
    text,
    characterId,
    voiceProfileOverride,
    config: cfg,
    signal: options.signal,
  });
}
