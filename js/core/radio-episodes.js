import * as db from './db.js';
import { resolveGenerationMaxTokens } from './api.js';
import {
  chatJsonGeneration,
  composeContextualGenerationMessages,
} from './chat-json-generation.js';
import { listCharacters } from './character-store.js';
import {
  ensurePrivateChat,
  findPrivateChat,
  listMessagesForChat,
  saveMessage,
  updateChatPreview,
} from './chat-store.js';
import {
  buildVoiceSpeechProfileOverride,
  loadCharacterVoiceProfile,
  loadVoiceToolConfig,
  normalizeVoiceSpeechPlan,
  resolveVoiceToolConfigForProfile,
  synthesizeVoice,
} from './voice-tools.js';
import {
  buildVoiceWorldBookPrompt,
  VOICE_WORLD_BOOK_SURFACES,
} from './voice-worldbook.js';
import { normalizeTranslationProfile } from '../models/character.js';
import {
  messageLikelyNeedsTranslation,
  repairTranslationEntries,
  sanitizeAiTranslation,
} from './translation-utils.js';
import {
  repairNarrationTranslationMarkup,
  stripTranslationMarks,
} from './narration-translation.js';
import {
  applyDisplayRegex,
  applyPermanentRegex,
  applyPromptRegex,
  primeDisplayRegex,
} from './display-regex.js';
import { listSoundAssets, listSoundAssetCategoryCatalog } from './sound-library.js';
import {
  buildMiniWikiContextBlock,
  buildWorldBookContextBlock,
  normalizeWorldBookIds,
} from './world-book-store.js';
import { buildLayeredMemoryContext } from './memory/build-layered-memory-context.js';
import { buildUnifiedEventTimelineContext } from './memory/unified-event-timeline.js';
import { VARIED_SEGMENTATION_HINT } from './narration-settings.js';
import {
  deleteVectorSourcesByPrefix,
  enqueueVectorSources,
} from './memory/memory-vectors.js';
import { buildRadioEpisodePassageSources } from './memory/vector-passages.js';
import { createEventMemory } from '../models/event-memory.js';
import { createMessage } from '../models/chat.js';
import { getNowForUser } from './time-mode.js';
import {
  deleteRadioAudioCache,
  radioAudioCacheKey,
  readRadioAudioCache,
  writeRadioAudioCache,
} from './radio-audio-cache.js';
import { mergeCachedVoiceSequence } from './voice-audio-export.js';

export const RADIO_EPISODE_TYPES = Object.freeze([
  { id: 'bedtime', label: '枕边故事', hint: '原创童话、故事或小说式夜读' },
  { id: 'memory', label: '角色往事', hint: '从角色视角讲一段过去或共同回忆' },
  { id: 'confession', label: '深夜自白', hint: '克制而真实的自我剖析' },
  { id: 'daily', label: '今日手记', hint: '把今天整理成一篇有情绪的声音日记' },
  { id: 'knowledge', label: '小课堂', hint: '用角色自己的方式讲明白一个主题' },
  { id: 'improv', label: '随便讲讲', hint: '冷笑话、怪谈或一本正经地胡编' },
  { id: 'reading', label: '来稿夜读', hint: '把导入文本融入讲述并自然评论' },
]);

const RADIO_TYPE_IDS = new Set(RADIO_EPISODE_TYPES.map((item) => item.id));
const RADIO_SETTING_PREFIX = 'radioEpisode_';
// 与主记录使用不同前缀，避免任何按 radioEpisode_ 扫描/迁移的逻辑把恢复副本
// 当成节目本体。恢复副本只保留文字与结构，不复制 Base64 音频和大封面。
const RADIO_RECOVERY_PREFIX = 'radioEpisodeRecovery_';
const RADIO_READING_SERIES_PREFIX = 'radioReadingSeries_';
const RADIO_PROGRESS_PREFIX = 'radioEpisodeProgress_';
const RADIO_CATALOG_PREFIX = 'radioEpisodeCatalog_';
const RADIO_CATALOG_VERSION = 1;
const RADIO_PROMPT_PRESET_PREFIX = 'radioPromptPresets_';
const RADIO_CUSTOM_TYPES_PREFIX = 'radioCustomTypes_';
const RADIO_PROMPT_PRESET_GLOBAL_KEY = `${RADIO_PROMPT_PRESET_PREFIX}global`;
const RADIO_CUSTOM_TYPES_GLOBAL_KEY = `${RADIO_CUSTOM_TYPES_PREFIX}global`;
const RADIO_RESOURCE_MIGRATION_KEY = 'radioReusableResourceMigration:v1';
const RADIO_PLAYBACK_PREFS_PREFIX = 'radioPlaybackPrefs_';
const RADIO_UI_PREFS_PREFIX = 'radioUiPrefs_';
// v11 之前的成品缺少可靠的正文/表演处理。v11 成品继续视为可用，避免这次分段渲染
// 上线后让用户已经付费合成并缓存的旧节目静默失效；只有新合成写入 v12。
const RADIO_AUDIO_MIN_COMPAT_VERSION = 11;
const RADIO_AUDIO_TEXT_VERSION = 12;

export const RADIO_PLAYBACK_DEFAULTS = Object.freeze({
  voiceVolume: 1,
  ambientVolume: 0.11,
  cueVolume: 0.4,
});

export function isRadioChapterAudioCurrent(chapter = null) {
  return chapter?.audioBlob instanceof Blob
    && chapter.audioBlob.size > 0
    && chapter.audioTextVersion >= RADIO_AUDIO_MIN_COMPAT_VERSION;
}
const RADIO_ACTION_MODES = new Set(['visible', 'hidden', 'off']);
let legacyRadioMigration = null;
let reusableRadioResourceMigration = null;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function text(value = '', max = 20000) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function fullText(value = '') {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

export function normalizeRadioDurationSeconds(value = 0) {
  const raw = Math.max(0, Number(value) || 0);
  if (!raw) return 0;
  // Fish 的 audio_length 使用毫秒；旧版本曾直接按秒保存，导致约两分钟
  // 的章节显示成两千多分钟。电台单章不会真实超过两小时，借此修复旧记录。
  const seconds = raw > 2 * 3600 ? raw / 1000 : raw;
  return Math.max(0, Math.round(seconds * 10) / 10);
}

export function normalizeRadioPlaybackPrefs(raw = {}) {
  return {
    voiceVolume: clamp(raw.voiceVolume, 0, 1, RADIO_PLAYBACK_DEFAULTS.voiceVolume),
    ambientVolume: clamp(raw.ambientVolume, 0, 1, RADIO_PLAYBACK_DEFAULTS.ambientVolume),
    cueVolume: clamp(raw.cueVolume, 0, 1, RADIO_PLAYBACK_DEFAULTS.cueVolume),
  };
}

export async function loadRadioPlaybackPrefs(userId = '') {
  const uid = text(userId, 240);
  if (!uid) return normalizeRadioPlaybackPrefs();
  const stored = await db.getRecord('settings', `${RADIO_PLAYBACK_PREFS_PREFIX}${uid}`);
  return normalizeRadioPlaybackPrefs(stored?.value);
}

export async function saveRadioPlaybackPrefs(userId = '', patch = {}) {
  const uid = text(userId, 240);
  if (!uid) throw new Error('缺少用户身份');
  const current = await loadRadioPlaybackPrefs(uid);
  const value = normalizeRadioPlaybackPrefs({ ...current, ...patch });
  await db.putRecord('settings', {
    key: `${RADIO_PLAYBACK_PREFS_PREFIX}${uid}`,
    value,
    updatedAt: Date.now(),
  });
  return value;
}

export function normalizeRadioUiPrefs(raw = {}) {
  return {
    lastCharacterId: text(raw.lastCharacterId, 240),
  };
}

export async function loadRadioUiPrefs(userId = '') {
  const uid = text(userId, 240);
  if (!uid) return normalizeRadioUiPrefs();
  const stored = await db.getRecord('settings', `${RADIO_UI_PREFS_PREFIX}${uid}`).catch(() => null);
  return normalizeRadioUiPrefs(stored?.value);
}

export async function saveRadioUiPrefs(userId = '', patch = {}) {
  const uid = text(userId, 240);
  if (!uid) throw new Error('缺少用户身份');
  const current = await loadRadioUiPrefs(uid);
  const value = normalizeRadioUiPrefs({ ...current, ...patch });
  await db.putRecord('settings', {
    key: `${RADIO_UI_PREFS_PREFIX}${uid}`,
    value,
    updatedAt: Date.now(),
  });
  return value;
}

export function normalizeRadioProseText(value = '', max = 12000) {
  return text(value, max)
    .replace(/([\u3400-\u9fff，。！？；：“”‘’、])[ \t]+(?=[\u3400-\u9fff，。！？；：“”‘’、])/gu, '$1')
    .replace(/[ \t]+([，。！？；：、])/gu, '$1')
    .replace(/[\t ]*\n[\t ]*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function createId(prefix = 'radio') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function radioReadingSeriesKey(id = '') {
  const key = text(id, 180);
  return key ? `${RADIO_READING_SERIES_PREFIX}${key}` : '';
}

export function normalizeRadioReadingSeries(raw = {}) {
  const sourceText = fullText(raw.sourceText || raw.text || '').slice(0, 4000000);
  const cursor = Math.floor(clamp(raw.cursor, 0, sourceText.length, 0));
  return {
    id: text(raw.id || createId('radio-reading'), 180),
    userId: text(raw.userId, 240),
    characterId: text(raw.characterId, 240),
    chatId: text(raw.chatId, 240),
    title: text(raw.title || raw.sourceName || '未命名来稿', 160) || '未命名来稿',
    sourceName: text(raw.sourceName || raw.title || '未命名来稿', 240) || '未命名来稿',
    sourceText,
    minutes: Math.round(clamp(raw.minutes, 3, 20, 8)),
    cursor,
    partNumber: Math.max(0, Math.floor(Number(raw.partNumber || 0) || 0)),
    episodeIds: [...new Set((Array.isArray(raw.episodeIds) ? raw.episodeIds : [])
      .map((id) => text(id, 180)).filter(Boolean))].slice(-240),
    status: cursor >= sourceText.length && sourceText ? 'completed' : 'active',
    createdAt: Math.max(0, Number(raw.createdAt || Date.now()) || Date.now()),
    updatedAt: Math.max(0, Number(raw.updatedAt || Date.now()) || Date.now()),
  };
}

export function resolveRadioReadingContinuationMinutes(requestedMinutes, previousMinutes = 8) {
  const requested = Math.round(Number(requestedMinutes));
  if ([5, 8, 15].includes(requested)) return requested;
  const previous = Math.round(Number(previousMinutes));
  return [5, 8, 15].includes(previous) ? previous : 8;
}

export async function getRadioReadingSeries(id = '') {
  const key = radioReadingSeriesKey(id);
  if (!key) return null;
  const stored = await db.getRecord('settings', key).catch(() => null);
  return stored?.value ? normalizeRadioReadingSeries(stored.value) : null;
}

async function putRadioReadingSeries(raw = {}) {
  const series = normalizeRadioReadingSeries({ ...raw, updatedAt: Date.now() });
  if (!series.userId || !series.characterId || !series.sourceText) throw new Error('来稿专栏缺少完整书稿');
  await db.putRecord('settings', {
    key: radioReadingSeriesKey(series.id),
    value: series,
    updatedAt: series.updatedAt,
  });
  return series;
}

function readingBoundary(source = '', start = 0, target = 1200) {
  if (start + target >= source.length) return source.length;
  const min = Math.min(source.length, start + Math.floor(target * 0.62));
  const max = Math.min(source.length, start + Math.ceil(target * 1.35));
  const windowText = source.slice(min, max);
  const boundaries = [];
  const addMatches = (pattern, weight) => {
    for (const match of windowText.matchAll(pattern)) {
      const offset = min + Number(match.index || 0) + String(match[0] || '').length;
      boundaries.push({ offset, weight });
    }
  };
  addMatches(/\n{2,}(?=(?:第[\d一二三四五六七八九十百千零〇两]+[章节回卷部篇]|chapter\s+\d+))/giu, 4);
  addMatches(/\n{2,}/gu, 3);
  addMatches(/[。！？!?][”」』’"']?(?:\s+|$)/gu, 2);
  addMatches(/[；;](?:\s+|$)/gu, 1);
  if (!boundaries.length) return Math.min(source.length, start + target);
  return boundaries.sort((left, right) => (
    right.weight - left.weight
    || Math.abs(left.offset - (start + target)) - Math.abs(right.offset - (start + target))
  ))[0].offset;
}

export function splitRadioReadingSource(rawSeries = {}, minutes = 8) {
  const series = normalizeRadioReadingSeries(rawSeries);
  const source = series.sourceText;
  let start = series.cursor;
  while (start < source.length && /\s/u.test(source[start])) start += 1;
  if (start >= source.length) return { start, end: start, text: '', paragraphs: [], hasMore: false };
  // 来稿还会穿插角色的引入与评论，因此原文预算约占目标音声的六成。
  const target = Math.round(clamp(minutes, 3, 20, 8) * 155);
  const end = readingBoundary(source, start, target);
  const selected = source.slice(start, end).trim();
  const roughParagraphs = selected.split(/\n\s*\n+/u).map((item) => item.trim()).filter(Boolean);
  const paragraphs = roughParagraphs.flatMap((paragraph) => {
    if (paragraph.length <= 900) return [paragraph];
    const chunks = [];
    let rest = paragraph;
    while (rest.length > 900) {
      const windowText = rest.slice(0, 900);
      const candidates = [...windowText.matchAll(/[。！？!?][”」』’"']?/gu)]
        .map((match) => Number(match.index || 0) + String(match[0] || '').length)
        .filter((offset) => offset >= 480);
      const cut = candidates.at(-1) || 900;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trimStart();
    }
    if (rest.trim()) chunks.push(rest.trim());
    return chunks;
  }).slice(0, 80);
  return {
    start,
    end,
    text: selected,
    paragraphs,
    hasMore: end < source.length,
  };
}

function dataUrlToBlob(value = '') {
  const source = String(value || '').trim();
  const match = source.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match || typeof Blob === 'undefined') return null;
  try {
    const mime = String(match[1] || 'application/octet-stream');
    if (match[2]) {
      const binary = atob(String(match[3] || '').replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(match[3] || '')], { type: mime });
  } catch (_) {
    return null;
  }
}

async function blobToDataUrl(blob) {
  if (!(blob instanceof Blob)) return '';
  if (typeof FileReader !== 'undefined') {
    const fromReader = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
    if (fromReader) return fromReader;
  }
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const step = 24 * 1024;
    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
    }
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
  } catch (_) {
    return '';
  }
}

function normalizeSoundMoment(raw = {}, index = 0) {
  return {
    id: text(raw.id || `sound-${index + 1}`, 120) || `sound-${index + 1}`,
    anchor: text(raw.anchor || raw.afterText || '', 120),
    actionText: text(raw.actionText || raw.action || '', 180),
    categories: [...new Set((Array.isArray(raw.categories) ? raw.categories : raw.soundCategories || [])
      .map((item) => text(item, 80)).filter(Boolean))].slice(0, 2),
  };
}

function normalizeNarrationBeat(raw = {}, index = 0) {
  return {
    id: text(raw.id || `narration-${index + 1}`, 120) || `narration-${index + 1}`,
    anchor: text(raw.anchor || raw.afterText || '', 160),
    text: normalizeRadioProseText(raw.text || raw.body || raw.actionText || '', 800),
  };
}

const RADIO_FISH_DIRECTION_BLOCK_RE = /\b(?:growl(?:ing|ed|s)?|snarl(?:ing|ed|s)?|roar(?:ing|ed|s)?|booming|thunderous|dramatic narration|announcer voice)\b/iu;

function normalizeRadioFishPerformanceCues(rawCues = [], chapterText = '') {
  const spoken = stripTranslationMarks(String(chapterText || ''));
  const seen = new Set();
  return (Array.isArray(rawCues) ? rawCues : [])
    .map((raw) => {
      const anchor = normalizeRadioProseText(raw?.anchor || raw?.text || '', 240);
      let direction = String(raw?.direction || raw?.performanceDirection || '')
        .replace(/[\[\]\r\n]+/gu, ' ')
        .replace(/\s{2,}/gu, ' ')
        .trim()
        .slice(0, 220);
      const hasLocalPlan = raw?.emotion != null || raw?.pace != null || raw?.intensity != null;
      if (!anchor || (!direction && !hasLocalPlan) || !spoken.includes(anchor) || RADIO_FISH_DIRECTION_BLOCK_RE.test(direction)) return null;
      if (direction && !/^speaking\b/iu.test(direction)) direction = `speaking ${direction}`;
      if (seen.has(anchor)) return null;
      seen.add(anchor);
      const localPlan = normalizeVoiceSpeechPlan({
        text: anchor,
        emotion: raw?.emotion,
        pace: raw?.pace,
        intensity: raw?.intensity,
        direction,
      }, anchor);
      return {
        anchor,
        direction: localPlan?.performanceDirection || direction,
        ...(raw?.emotion != null ? { emotion: localPlan?.emotion || 'neutral' } : {}),
        ...(raw?.pace != null ? { pace: localPlan?.pace || 'normal' } : {}),
        ...(raw?.intensity != null ? { intensity: localPlan?.intensity ?? 0 } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeRadioAudioTimeline(raw = []) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      startChar: Math.max(0, Math.floor(Number(item?.startChar || 0) || 0)),
      endChar: Math.max(0, Math.floor(Number(item?.endChar || 0) || 0)),
      startSeconds: Math.max(0, Number(item?.startSeconds || 0) || 0),
      endSeconds: Math.max(0, Number(item?.endSeconds || 0) || 0),
      gapBeforeMs: Math.max(0, Math.round(Number(item?.gapBeforeMs || 0) || 0)),
    }))
    .filter((item) => item.endChar > item.startChar && item.endSeconds >= item.startSeconds)
    .slice(0, 160);
}

function normalizeRadioSpeechPlan(rawPlan = null, chapterText = '') {
  const plan = normalizeVoiceSpeechPlan(rawPlan, chapterText);
  if (!plan) return null;
  const rawCues = rawPlan?.performanceCues || rawPlan?.cues || rawPlan?.directions || [];
  const performanceCues = normalizeRadioFishPerformanceCues(rawCues, chapterText);
  return performanceCues.length ? { ...plan, performanceCues } : plan;
}

export function applyRadioFishPerformanceCues(textValue = '', rawCues = []) {
  const source = String(textValue || '');
  const insertions = normalizeRadioFishPerformanceCues(rawCues, source)
    .map((cue) => ({ ...cue, offset: source.indexOf(cue.anchor) }))
    .filter((cue) => cue.offset >= 0 && cue.direction)
    .sort((a, b) => b.offset - a.offset);
  return insertions.reduce((out, cue) => (
    `${out.slice(0, cue.offset)}[${cue.direction}]\n${out.slice(cue.offset)}`
  ), source);
}

function normalizeChapter(raw = {}, index = 0, { hydrateAudio = true } = {}) {
  const audioDataUrl = text(raw.audioDataUrl || '', 40000000);
  const audioCache = raw.audioCache && typeof raw.audioCache === 'object' && raw.audioCache.key
    ? {
      key: text(raw.audioCache.key, 80),
      backend: text(raw.audioCache.backend, 40),
      type: text(raw.audioCache.type, 80),
      size: Math.max(0, Number(raw.audioCache.size || 0) || 0),
    }
    : null;
  const hasStoredAudio = raw.audioBlob instanceof Blob || !!audioDataUrl || !!audioCache;
  const audioBlob = hydrateAudio
    ? (raw.audioBlob instanceof Blob ? raw.audioBlob : dataUrlToBlob(audioDataUrl))
    : null;
  const sourceParagraphs = (Array.isArray(raw.sourceParagraphs) ? raw.sourceParagraphs : [])
    .map((item) => text(item, 1200))
    .filter(Boolean)
    .slice(0, 80);
  // 来稿正文由本地按段落 ID 拼装，不能再经过空格清洗或译文修复，
  // 否则「原文」标记出来的内容会悄悄偏离用户上传的书稿。
  const chapterText = sourceParagraphs.length
    ? text(raw.text || raw.content || '', 12000)
    : repairNarrationTranslationMarkup(
      normalizeRadioProseText(raw.text || raw.content || '', 12000),
    );
  const speechPlan = normalizeRadioSpeechPlan(raw.speechPlan || raw.speech, chapterText);
  return {
    id: text(raw.id || `chapter-${index + 1}`, 120) || `chapter-${index + 1}`,
    title: text(raw.title || `第 ${index + 1} 章`, 80) || `第 ${index + 1} 章`,
    text: chapterText,
    speechPlan,
    sourceParagraphs,
    narrationBeats: (Array.isArray(raw.narrationBeats) ? raw.narrationBeats : [])
      .map(normalizeNarrationBeat)
      .filter((beat) => beat.anchor && beat.text)
      .slice(0, 8),
    soundMoments: (Array.isArray(raw.soundMoments) ? raw.soundMoments : [])
      .map(normalizeSoundMoment)
      .filter((moment) => moment.anchor && moment.categories.length)
      .slice(0, 8),
    durationSeconds: normalizeRadioDurationSeconds(raw.durationSeconds),
    audioTimeline: normalizeRadioAudioTimeline(raw.audioTimeline),
    audioBlob,
    audioDataUrl: hydrateAudio ? audioDataUrl : '',
    audioCache,
    audioType: text(raw.audioType || audioBlob?.type || '', 80),
    audioTextVersion: Math.max(0, Number(raw.audioTextVersion || 0) || 0),
    audioStatus: hasStoredAudio || raw.audioStatus === 'ready'
      ? 'ready'
      : (raw.audioStatus === 'error' ? 'error' : 'idle'),
    audioError: text(raw.audioError || '', 240),
    updatedAt: Math.max(0, Number(raw.updatedAt || Date.now()) || Date.now()),
  };
}

export function radioEpisodeTypeLabel(type = '') {
  return RADIO_EPISODE_TYPES.find((item) => item.id === type)?.label || '声音节目';
}

function normalizeCustomRadioType(raw = {}, index = 0) {
  const label = text(raw.label || raw.name || '', 32);
  if (!label) return null;
  const fallbackId = `custom-${Date.now().toString(36)}-${index + 1}`;
  const rawId = text(raw.id || fallbackId, 120).toLowerCase();
  const id = /^custom-[a-z0-9-]+$/u.test(rawId) ? rawId : fallbackId;
  return {
    id,
    label,
    hint: text(raw.hint || raw.description || '', 100) || '按你保存的方向制作节目',
    updatedAt: Math.max(0, Number(raw.updatedAt || Date.now()) || Date.now()),
  };
}

async function ensureReusableRadioResourcesMigrated() {
  const marker = await db.getRecord('settings', RADIO_RESOURCE_MIGRATION_KEY).catch(() => null);
  if (marker?.value?.done === true) return;
  if (reusableRadioResourceMigration) return reusableRadioResourceMigration;
  reusableRadioResourceMigration = (async () => {
    const rows = await db.getAllRecords('settings').catch(() => []);
    const customTypes = [];
    const typeFingerprints = new Set();
    const promptPresets = [];
    const promptFingerprints = new Set();
    rows.forEach((row) => {
      const key = String(row?.key || '');
      const values = Array.isArray(row?.value) ? row.value : [];
      if (key.startsWith(RADIO_CUSTOM_TYPES_PREFIX) && key !== RADIO_CUSTOM_TYPES_GLOBAL_KEY) {
        values.map(normalizeCustomRadioType).filter(Boolean).forEach((item) => {
          const fingerprint = `${item.label.toLocaleLowerCase()}\u241f${item.hint}`;
          if (typeFingerprints.has(fingerprint)) return;
          typeFingerprints.add(fingerprint);
          customTypes.push(item);
        });
      }
      if (key.startsWith(RADIO_PROMPT_PRESET_PREFIX) && key !== RADIO_PROMPT_PRESET_GLOBAL_KEY) {
        values.map(normalizeRadioPromptPreset).filter(Boolean).forEach((item) => {
          const fingerprint = `${item.name.toLocaleLowerCase()}\u241f${item.prompt}`;
          if (promptFingerprints.has(fingerprint)) return;
          promptFingerprints.add(fingerprint);
          promptPresets.push(item);
        });
      }
    });
    const existingTypes = await db.getRecord('settings', RADIO_CUSTOM_TYPES_GLOBAL_KEY).catch(() => null);
    const existingPrompts = await db.getRecord('settings', RADIO_PROMPT_PRESET_GLOBAL_KEY).catch(() => null);
    const mergedTypes = [...(Array.isArray(existingTypes?.value) ? existingTypes.value : []), ...customTypes]
      .map(normalizeCustomRadioType).filter(Boolean)
      .filter((item, index, list) => list.findIndex((candidate) => (
        candidate.label.toLocaleLowerCase() === item.label.toLocaleLowerCase() && candidate.hint === item.hint
      )) === index)
      .slice(-30);
    const mergedPrompts = [...(Array.isArray(existingPrompts?.value) ? existingPrompts.value : []), ...promptPresets]
      .map(normalizeRadioPromptPreset).filter(Boolean)
      .filter((item, index, list) => list.findIndex((candidate) => (
        candidate.name.toLocaleLowerCase() === item.name.toLocaleLowerCase() && candidate.prompt === item.prompt
      )) === index)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 30);
    await Promise.all([
      db.putRecord('settings', { key: RADIO_CUSTOM_TYPES_GLOBAL_KEY, value: mergedTypes, updatedAt: Date.now() }),
      db.putRecord('settings', { key: RADIO_PROMPT_PRESET_GLOBAL_KEY, value: mergedPrompts, updatedAt: Date.now() }),
      db.putRecord('settings', {
        key: RADIO_RESOURCE_MIGRATION_KEY,
        value: { done: true, migratedAt: Date.now() },
        updatedAt: Date.now(),
      }),
    ]);
  })().finally(() => { reusableRadioResourceMigration = null; });
  return reusableRadioResourceMigration;
}

export async function listRadioCustomTypes(userId = '') {
  await ensureReusableRadioResourcesMigrated();
  const uid = text(userId, 240);
  const [row, legacyRow] = await Promise.all([
    db.getRecord('settings', RADIO_CUSTOM_TYPES_GLOBAL_KEY).catch(() => null),
    uid && uid !== 'global'
      ? db.getRecord('settings', `${RADIO_CUSTOM_TYPES_PREFIX}${uid}`).catch(() => null)
      : null,
  ]);
  const values = [
    ...(Array.isArray(row?.value) ? row.value : []),
    ...(Array.isArray(legacyRow?.value) ? legacyRow.value : []),
  ];
  const result = values
    .map(normalizeCustomRadioType)
    .filter(Boolean)
    .filter((item, index, list) => list.findIndex((candidate) => (
      candidate.label.toLocaleLowerCase() === item.label.toLocaleLowerCase() && candidate.hint === item.hint
    )) === index)
    .sort((left, right) => left.updatedAt - right.updatedAt);
  if (result.length !== (Array.isArray(row?.value) ? row.value.length : 0)) {
    await db.putRecord('settings', { key: RADIO_CUSTOM_TYPES_GLOBAL_KEY, value: result.slice(-30), updatedAt: Date.now() });
  }
  return result.slice(-30);
}

export async function saveRadioCustomType(userId = '', input = {}) {
  const label = text(input.label || input.name || '', 32);
  if (!label) throw new Error('请填写电台类型名称');
  const rows = await listRadioCustomTypes(userId);
  const duplicate = rows.find((row) => row.label.toLocaleLowerCase() === label.toLocaleLowerCase());
  if (duplicate) return duplicate;
  const next = normalizeCustomRadioType({
    id: createId('custom'),
    label,
    hint: input.hint,
    updatedAt: Date.now(),
  });
  const value = [...rows, next].slice(-30);
  await db.putRecord('settings', {
    key: RADIO_CUSTOM_TYPES_GLOBAL_KEY,
    value,
    updatedAt: Date.now(),
  });
  return next;
}

export async function deleteRadioCustomType(userId = '', typeId = '') {
  const id = text(typeId, 120);
  if (!id) return listRadioCustomTypes(userId);
  const value = (await listRadioCustomTypes(userId)).filter((row) => row.id !== id);
  await db.putRecord('settings', {
    key: RADIO_CUSTOM_TYPES_GLOBAL_KEY,
    value,
    updatedAt: Date.now(),
  });
  return value;
}

export function normalizeRadioEpisode(raw = {}, { hydrateAudio = true, hydrateCover = true } = {}) {
  const now = Date.now();
  const chapters = (Array.isArray(raw.chapters) ? raw.chapters : [])
    .map((chapter, index) => normalizeChapter(chapter, index, { hydrateAudio }))
    .filter((chapter) => chapter.text);
  const coverDataUrl = text(raw.coverDataUrl || '', 20000000);
  const coverBlob = hydrateCover
    ? (raw.coverBlob instanceof Blob ? raw.coverBlob : dataUrlToBlob(coverDataUrl))
    : null;
  const requestedType = String(raw.type || '');
  const type = RADIO_TYPE_IDS.has(requestedType) || /^custom-[a-z0-9-]+$/u.test(requestedType)
    ? requestedType
    : 'bedtime';
  const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
  return {
    ...raw,
    id: text(raw.id || createId(), 180),
    userId: text(raw.userId, 240),
    characterId: text(raw.characterId, 240),
    chatId: text(raw.chatId, 240),
    characterIds: [...new Set((Array.isArray(raw.characterIds) ? raw.characterIds : [raw.characterId])
      .map((id) => text(id, 240)).filter(Boolean))],
    characterName: text(raw.characterName || '角色', 80) || '角色',
    characterAvatar: text(raw.characterAvatar || '', 200000),
    type,
    typeLabel: text(raw.typeLabel || '', 32),
    typeHint: text(raw.typeHint || '', 100),
    title: normalizeGeneratedTitle(
      raw.title || '未命名节目',
      text(raw.typeLabel || '', 32) || radioEpisodeTypeLabel(type),
    ),
    subtitle: text(raw.subtitle || '', 180),
    summary: text(raw.summary || '', 1000),
    memorySummary: text(raw.memorySummary || raw.summary || '', 520),
    memoryKeywords: [...new Set((Array.isArray(raw.memoryKeywords) ? raw.memoryKeywords : [])
      .map((item) => text(item, 60)).filter(Boolean))].slice(0, 12),
    canonNotes: (Array.isArray(raw.canonNotes) ? raw.canonNotes : [])
      .map((item) => text(item, 240)).filter(Boolean).slice(0, 8),
    sourceKind: raw.sourceKind === 'imported' ? 'imported' : 'prompt',
    sourceText: text(raw.sourceText || '', 30000),
    readingSeries: raw.readingSeries && typeof raw.readingSeries === 'object'
      ? {
        id: text(raw.readingSeries.id, 180),
        sourceName: text(raw.readingSeries.sourceName || raw.readingSeries.title, 240),
        title: text(raw.readingSeries.title || raw.readingSeries.sourceName, 160),
        partNumber: Math.max(1, Math.floor(Number(raw.readingSeries.partNumber || 1) || 1)),
        start: Math.max(0, Math.floor(Number(raw.readingSeries.start || 0) || 0)),
        end: Math.max(0, Math.floor(Number(raw.readingSeries.end || 0) || 0)),
        totalLength: Math.max(0, Math.floor(Number(raw.readingSeries.totalLength || 0) || 0)),
        minutes: Math.round(clamp(raw.readingSeries.minutes, 3, 20, 8)),
        hasMore: raw.readingSeries.hasMore === true,
      }
      : null,
    topic: fullText(raw.topic || ''),
    generationPrompt: fullText(raw.generationPrompt || ''),
    worldBookIds: normalizeWorldBookIds(raw.worldBookIds),
    worldBookSelectionMode: raw.worldBookSelectionMode === 'additive' ? 'additive' : 'exclusive',
    actionMode: RADIO_ACTION_MODES.has(String(raw.actionMode || '')) ? String(raw.actionMode) : 'hidden',
    ambientEnabled: raw.ambientEnabled !== false,
    chapters,
    discussionHooks: (Array.isArray(raw.discussionHooks) ? raw.discussionHooks : [])
      .map((item) => text(item, 180)).filter(Boolean).slice(0, 5),
    ambientCategories: (Array.isArray(raw.ambientCategories) ? raw.ambientCategories : [])
      .map((item) => text(item, 80)).filter(Boolean).slice(0, 2),
    coverBlob,
    coverDataUrl,
    coverType: text(raw.coverType || coverBlob?.type || '', 80),
    coverPosition: text(raw.coverPosition || '50% 50%', 40) || '50% 50%',
    status: ['draft', 'ready', 'error'].includes(raw.status) ? raw.status : (chapters.length ? 'ready' : 'draft'),
    progress: {
      chapterIndex: Math.floor(clamp(progress.chapterIndex, 0, Math.max(0, chapters.length - 1), 0)),
      positionSeconds: clamp(progress.positionSeconds, 0, 24 * 3600, 0),
      completed: progress.completed === true,
      updatedAt: Math.max(0, Number(progress.updatedAt || 0) || 0),
    },
    createdAt: Math.max(0, Number(raw.createdAt || now) || now),
    updatedAt: Math.max(0, Number(raw.updatedAt || now) || now),
    lastPlayedAt: Math.max(0, Number(raw.lastPlayedAt || 0) || 0),
  };
}

function normalizeRadioPromptPreset(raw = {}, index = 0) {
  const prompt = fullText(raw.prompt || '');
  if (!prompt) return null;
  return {
    id: text(raw.id || `radio-prompt-${index + 1}`, 160) || `radio-prompt-${index + 1}`,
    name: text(raw.name || `提示词 ${index + 1}`, 40) || `提示词 ${index + 1}`,
    prompt,
    updatedAt: Math.max(0, Number(raw.updatedAt || Date.now()) || Date.now()),
  };
}

export async function listRadioPromptPresets(userId = '') {
  await ensureReusableRadioResourcesMigrated();
  const uid = text(userId, 240);
  const [row, legacyRow] = await Promise.all([
    db.getRecord('settings', RADIO_PROMPT_PRESET_GLOBAL_KEY).catch(() => null),
    uid && uid !== 'global'
      ? db.getRecord('settings', `${RADIO_PROMPT_PRESET_PREFIX}${uid}`).catch(() => null)
      : null,
  ]);
  const result = [
    ...(Array.isArray(row?.value) ? row.value : []),
    ...(Array.isArray(legacyRow?.value) ? legacyRow.value : []),
  ]
    .map(normalizeRadioPromptPreset)
    .filter(Boolean)
    .filter((item, index, list) => list.findIndex((candidate) => (
      candidate.name.toLocaleLowerCase() === item.name.toLocaleLowerCase() && candidate.prompt === item.prompt
    )) === index)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  if (result.length !== (Array.isArray(row?.value) ? row.value.length : 0)) {
    await db.putRecord('settings', { key: RADIO_PROMPT_PRESET_GLOBAL_KEY, value: result.slice(0, 30), updatedAt: Date.now() });
  }
  return result.slice(0, 30);
}

export async function saveRadioPromptPreset(userId = '', input = {}) {
  const prompt = fullText(input.prompt || '');
  if (!prompt) throw new Error('请先填写生成提示词');
  const rows = await listRadioPromptPresets(userId);
  const id = text(input.id || createId('radio-prompt'), 160);
  const next = normalizeRadioPromptPreset({
    id,
    name: input.name || prompt.slice(0, 16),
    prompt,
    updatedAt: Date.now(),
  });
  const value = [next, ...rows.filter((row) => row.id !== id)].slice(0, 30);
  await db.putRecord('settings', { key: RADIO_PROMPT_PRESET_GLOBAL_KEY, value });
  return next;
}

export async function deleteRadioPromptPreset(userId = '', presetId = '') {
  const id = text(presetId, 160);
  if (!id) return [];
  const value = (await listRadioPromptPresets(userId)).filter((row) => row.id !== id);
  await db.putRecord('settings', { key: RADIO_PROMPT_PRESET_GLOBAL_KEY, value });
  return value;
}

function radioSettingKey(id = '') {
  const key = text(id, 180);
  return key ? `${RADIO_SETTING_PREFIX}${key}` : '';
}

function radioProgressKey(id = '') {
  const key = text(id, 180);
  return key ? `${RADIO_PROGRESS_PREFIX}${key}` : '';
}

function radioRecoveryKey(id = '') {
  const key = text(id, 180);
  return key ? `${RADIO_RECOVERY_PREFIX}${key}` : '';
}

function radioRecoverySnapshot(raw = {}) {
  const row = normalizeRadioEpisode(raw, { hydrateAudio: false, hydrateCover: false });
  return {
    ...row,
    coverBlob: null,
    coverDataUrl: '',
    chapters: row.chapters.map((chapter) => ({
      ...chapter,
      audioBlob: null,
      audioDataUrl: '',
    })),
  };
}

function radioCatalogKey(userId = '') {
  const uid = text(userId, 240);
  return uid ? `${RADIO_CATALOG_PREFIX}${uid}` : '';
}

function radioCatalogEntry(raw = {}) {
  const row = normalizeRadioEpisode(raw, { hydrateAudio: false, hydrateCover: false });
  return {
    id: row.id,
    userId: row.userId,
    characterId: row.characterId,
    characterIds: row.characterIds,
    characterName: row.characterName,
    characterAvatar: row.characterAvatar,
    type: row.type,
    typeLabel: row.typeLabel,
    typeHint: row.typeHint,
    title: row.title,
    subtitle: row.subtitle,
    summary: row.summary,
    readingSeries: row.readingSeries,
    chapters: row.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      text: '目录占位',
      durationSeconds: chapter.durationSeconds,
      audioStatus: chapter.audioStatus,
    })),
    coverDataUrl: row.coverDataUrl,
    coverType: row.coverType,
    coverPosition: row.coverPosition,
    progress: row.progress,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastPlayedAt: row.lastPlayedAt,
  };
}

async function updateRadioCatalog(row, { completeIfMissing = false } = {}) {
  const key = radioCatalogKey(row?.userId);
  if (!key || !row?.id) return;
  const stored = await db.getRecord('settings', key).catch(() => null);
  const current = stored?.value && typeof stored.value === 'object' ? stored.value : null;
  const episodes = Array.isArray(current?.episodes) ? current.episodes : [];
  await db.putRecord('settings', {
    key,
    value: {
      version: RADIO_CATALOG_VERSION,
      complete: current?.complete === true || completeIfMissing === true,
      episodes: [radioCatalogEntry(row), ...episodes.filter((item) => item?.id !== row.id)],
    },
    updatedAt: Date.now(),
  });
}

async function putRadioEpisode(row) {
  const chapters = await Promise.all((Array.isArray(row.chapters) ? row.chapters : []).map(async (chapter) => {
    const audioBlob = chapter.audioBlob instanceof Blob
      ? chapter.audioBlob
      : dataUrlToBlob(chapter.audioDataUrl || '');
    let audioCache = chapter.audioCache || null;
    let audioDataUrl = '';
    if (audioBlob?.size) {
      const cached = await writeRadioAudioCache(row.id, chapter.id, audioBlob).catch(() => null);
      if (cached) audioCache = cached;
      else audioDataUrl = chapter.audioDataUrl || await blobToDataUrl(audioBlob);
    } else if (chapter.audioStatus !== 'ready') {
      if (audioCache) await deleteRadioAudioCache(audioCache).catch(() => {});
      audioCache = null;
    }
    const stored = { ...chapter, audioCache, audioDataUrl };
    delete stored.audioBlob;
    return stored;
  }));
  const coverDataUrl = row.coverDataUrl
    || (row.coverBlob instanceof Blob ? await blobToDataUrl(row.coverBlob) : '');
  const value = { ...row, chapters, coverDataUrl };
  delete value.coverBlob;
  await db.putRecord('settings', {
    key: radioSettingKey(row.id),
    value,
    updatedAt: Number(row.updatedAt || Date.now()) || Date.now(),
  });
  // 主记录可能包含很大的音频 Data URL。旧 WebView 或存储压力下若它之后损坏，
  // 仍可用这份轻量正文副本恢复节目并按需重新合成音频。
  await db.putRecord('settings', {
    key: radioRecoveryKey(row.id),
    value: radioRecoverySnapshot({ ...row, chapters }),
    updatedAt: Number(row.updatedAt || Date.now()) || Date.now(),
  }).catch(() => {});
  await updateRadioCatalog({ ...row, coverDataUrl }).catch(() => {});
  return row;
}

async function readLegacyRadioEpisodes() {
  try {
    const connection = await db.open();
    if (!connection?.objectStoreNames?.contains?.('radioEpisodes')) return [];
    return await new Promise((resolve, reject) => {
      const request = connection.transaction('radioEpisodes', 'readonly').objectStore('radioEpisodes').getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error);
    });
  } catch (_) {
    return [];
  }
}

async function migrateLegacyRadioEpisodesOnce() {
  if (!legacyRadioMigration) {
    legacyRadioMigration = (async () => {
      const legacy = await readLegacyRadioEpisodes();
      for (const raw of legacy) {
        const row = normalizeRadioEpisode({ ...raw, updatedAt: raw.updatedAt });
        if (!row.id || !row.userId || !row.characterId || !row.chapters.length) continue;
        const key = radioSettingKey(row.id);
        if (!await db.getRecord('settings', key)) await putRadioEpisode(row);
      }
    })().catch(() => {});
  }
  await legacyRadioMigration;
}

export async function saveRadioEpisode(raw = {}) {
  const row = normalizeRadioEpisode({ ...raw, updatedAt: Date.now() });
  if (!row.userId || !row.characterId) throw new Error('节目缺少用户或角色');
  if (!row.chapters.length) throw new Error('节目还没有正文');
  await putRadioEpisode(row);
  enqueueVectorSources('archive', buildRadioEpisodePassageSources(row)).catch(() => {});
  return row;
}

export async function updateRadioEpisodeContent(id = '', patch = {}) {
  const current = await getRadioEpisode(id);
  if (!current) throw new Error('没有找到这期节目');
  const requestedChapters = Array.isArray(patch.chapters) ? patch.chapters : [];
  let chapterTextChanged = false;
  const staleAudioCaches = [];
  const chapters = current.chapters.map((chapter, index) => {
    const requested = requestedChapters[index] || {};
    const nextText = normalizeRadioProseText(requested.text ?? chapter.text, 12000);
    if (!nextText) throw new Error(`第 ${index + 1} 章正文不能为空`);
    const textChanged = nextText !== chapter.text;
    chapterTextChanged ||= textChanged;
    if (textChanged && chapter.audioCache) staleAudioCaches.push(chapter.audioCache);
    return normalizeChapter({
      ...chapter,
      title: requested.title ?? chapter.title,
      text: nextText,
      soundMoments: textChanged
        ? chapter.soundMoments.filter((moment) => nextText.includes(moment.anchor))
        : chapter.soundMoments,
      narrationBeats: textChanged
        ? chapter.narrationBeats.filter((beat) => nextText.includes(beat.anchor))
        : chapter.narrationBeats,
      ...(textChanged ? {
        speechPlan: null,
        audioBlob: null,
        audioDataUrl: '',
        audioCache: null,
        audioType: '',
        audioTimeline: [],
        audioTextVersion: 0,
        audioStatus: 'idle',
        audioError: '',
        durationSeconds: 0,
      } : {}),
      updatedAt: textChanged ? Date.now() : chapter.updatedAt,
    }, index);
  });
  const next = normalizeRadioEpisode({
    ...current,
    title: patch.title ?? current.title,
    subtitle: patch.subtitle ?? current.subtitle,
    summary: patch.summary ?? current.summary,
    memorySummary: patch.memorySummary ?? current.memorySummary,
    // 正文经人工纠错后，旧 canonNotes 可能正包含被纠正的错误事实；宁可交给修订后的
    // 原文按需召回，也不要继续把旧结论当作角色亲口确认的稳定事实。
    canonNotes: chapterTextChanged ? [] : current.canonNotes,
    chapters,
    updatedAt: Date.now(),
  });
  await Promise.allSettled(staleAudioCaches.map((meta) => deleteRadioAudioCache(meta)));
  await putRadioEpisode(next);
  await deleteVectorSourcesByPrefix('archive', `${next.id}:original:`).catch(() => {});
  enqueueVectorSources('archive', buildRadioEpisodePassageSources(next)).catch(() => {});
  await rememberRadioCreation(next, next.chatId || '').catch(() => {});
  return next;
}

export async function getRadioEpisode(id = '') {
  await migrateLegacyRadioEpisodesOnce();
  const [stored, recoveryStored, progressStored] = await Promise.all([
    db.getRecord('settings', radioSettingKey(id)),
    db.getRecord('settings', radioRecoveryKey(id)).catch(() => null),
    db.getRecord('settings', radioProgressKey(id)).catch(() => null),
  ]);
  const row = stored?.value || recoveryStored?.value;
  if (!row) return null;
  let episode = normalizeRadioEpisode({
    ...row,
    progress: progressStored?.value || row.progress,
    lastPlayedAt: progressStored?.value?.lastPlayedAt || row.lastPlayedAt,
    updatedAt: row.updatedAt,
  });
  const hydratedChapters = await Promise.all(episode.chapters.map(async (chapter, index) => {
    if (chapter.audioBlob instanceof Blob || !chapter.audioCache) return chapter;
    const audioBlob = await readRadioAudioCache(chapter.audioCache).catch(() => null);
    if (!audioBlob?.size) return chapter;
    return normalizeChapter({ ...chapter, audioBlob }, index);
  }));
  episode = { ...episode, chapters: hydratedChapters };
  if (!stored?.value && recoveryStored?.value) {
    // 恢复失败（例如设备空间仍不足）时本轮仍返回内存中的正文，至少允许阅读；
    // 后续播放会按章重新合成音频，并再次尝试写回。
    await putRadioEpisode(episode).catch(() => {});
  } else if (stored?.value && !recoveryStored?.value) {
    // 为升级前已经存在的节目补建恢复副本；无需用户重新生成。
    await db.putRecord('settings', {
      key: radioRecoveryKey(episode.id),
      value: radioRecoverySnapshot(episode),
      updatedAt: Number(episode.updatedAt || Date.now()) || Date.now(),
    }).catch(() => {});
  }
  if (stored?.value && (stored.value.chapters || []).some((chapter) => chapter?.audioDataUrl)) {
    // 旧版整期 Base64 首次打开即迁移到独立二进制缓存；成功后主记录不再携带大字符串。
    await putRadioEpisode(episode).catch(() => {});
  }
  return episode;
}

export async function listRadioEpisodes(userId = '', { characterId = '', type = '' } = {}) {
  const uid = text(userId, 240);
  if (!uid) return [];
  await migrateLegacyRadioEpisodesOnce();
  const catalogStored = await db.getRecord('settings', radioCatalogKey(uid)).catch(() => null);
  const catalog = catalogStored?.value;
  if (
    catalog?.version === RADIO_CATALOG_VERSION
    && catalog.complete === true
    && Array.isArray(catalog.episodes)
  ) {
    return catalog.episodes
      .filter((row) => !characterId || String(row.characterId || '') === String(characterId))
      .filter((row) => !type || String(row.type || '') === String(type))
      .map((row) => normalizeRadioEpisode(row, { hydrateAudio: false, hydrateCover: false }))
      .sort((a, b) => Number(b.lastPlayedAt || b.updatedAt) - Number(a.lastPlayedAt || a.updatedAt));
  }
  const settings = await db.getAllRecords('settings');
  const progressById = new Map(settings
    .filter((stored) => String(stored?.key || '').startsWith(RADIO_PROGRESS_PREFIX))
    .map((stored) => [String(stored.key).slice(RADIO_PROGRESS_PREFIX.length), stored.value]));
  const rows = settings
    .filter((stored) => String(stored?.key || '').startsWith(RADIO_SETTING_PREFIX))
    .map((stored) => stored?.value)
    .filter((row) => row && String(row.userId || '') === uid);
  const normalized = rows
    // 首页只需要元数据，不把每一期的所有 Base64 音频同时解码成 Blob。
    .map((row) => normalizeRadioEpisode({
      ...row,
      progress: progressById.get(String(row.id || '')) || row.progress,
      lastPlayedAt: progressById.get(String(row.id || ''))?.lastPlayedAt || row.lastPlayedAt,
      updatedAt: row.updatedAt,
    }, { hydrateAudio: false, hydrateCover: false }))
    .sort((a, b) => Number(b.lastPlayedAt || b.updatedAt) - Number(a.lastPlayedAt || a.updatedAt));
  await db.putRecord('settings', {
    key: radioCatalogKey(uid),
    value: {
      version: RADIO_CATALOG_VERSION,
      complete: true,
      episodes: normalized.map(radioCatalogEntry),
    },
    updatedAt: Date.now(),
  }).catch(() => {});
  return normalized
    .filter((row) => !characterId || String(row.characterId || '') === String(characterId))
    .filter((row) => !type || String(row.type || '') === String(type));
}

async function deleteLegacyRadioEpisode(id = '') {
  try {
    const connection = await db.open();
    if (!connection?.objectStoreNames?.contains?.('radioEpisodes')) return;
    await new Promise((resolve, reject) => {
      const transaction = connection.transaction('radioEpisodes', 'readwrite');
      transaction.objectStore('radioEpisodes').delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('旧电台记录删除失败'));
    });
  } catch (_) { /* 旧表不存在或已经清理时无需阻断当前删除 */ }
}

export async function deleteRadioEpisode(id = '', { userId = '' } = {}) {
  const key = text(id, 180);
  if (key) {
    const [stored, recoveryStored] = await Promise.all([
      db.getRecord('settings', radioSettingKey(key)).catch(() => null),
      db.getRecord('settings', radioRecoveryKey(key)).catch(() => null),
    ]);
    const knownUserId = text(userId || stored?.value?.userId || recoveryStored?.value?.userId, 240);
    let catalogRecords = [];
    if (knownUserId) {
      const catalogStored = await db.getRecord('settings', radioCatalogKey(knownUserId)).catch(() => null);
      if (catalogStored?.value) catalogRecords.push(catalogStored);
    } else {
      // 主记录与恢复副本都丢失时，首页仍可能从轻量目录显示一张“孤儿卡片”。
      // 删除是低频操作，此时才扫描目录，以便把用户实际点到的残留记录彻底移除。
      const settings = await db.getAllRecords('settings').catch(() => []);
      catalogRecords = settings.filter((item) => (
        String(item?.key || '').startsWith(RADIO_CATALOG_PREFIX)
        && Array.isArray(item?.value?.episodes)
        && item.value.episodes.some((episode) => episode?.id === key)
      ));
    }
    const catalogEpisodes = catalogRecords.flatMap((item) => (
      Array.isArray(item?.value?.episodes)
        ? item.value.episodes.filter((episode) => episode?.id === key)
        : []
    ));
    const cachedChapters = [
      ...(Array.isArray(stored?.value?.chapters) ? stored.value.chapters : []),
      ...(Array.isArray(recoveryStored?.value?.chapters) ? recoveryStored.value.chapters : []),
      ...catalogEpisodes.flatMap((episode) => (Array.isArray(episode?.chapters) ? episode.chapters : [])),
    ];
    const audioCaches = cachedChapters.flatMap((chapter) => [
      chapter?.audioCache,
      chapter?.id ? { key: radioAudioCacheKey(key, chapter.id) } : null,
    ]).filter((meta) => meta?.key);
    await Promise.allSettled(audioCaches.map((meta) => deleteRadioAudioCache(meta)));
    await db.deleteRecord('settings', radioSettingKey(key));
    await db.deleteRecord('settings', radioRecoveryKey(key)).catch(() => {});
    await db.deleteRecord('settings', radioProgressKey(key)).catch(() => {});
    await deleteLegacyRadioEpisode(key);
    await db.deleteRecord('eventMemories', `event-radio-created-${key}`).catch(() => {});
    await db.deleteRecord('eventMemories', `event-radio-listened-${key}`).catch(() => {});
    await deleteVectorSourcesByPrefix('archive', `${key}:original:`).catch(() => {});
    await Promise.all(catalogRecords.map(async (catalogStored) => {
      const catalog = catalogStored?.value;
      if (catalog && Array.isArray(catalog.episodes)) {
        await db.putRecord('settings', {
          key: catalogStored.key,
          value: { ...catalog, episodes: catalog.episodes.filter((item) => item?.id !== key) },
          updatedAt: Date.now(),
        }).catch(() => {});
      }
    }));
  }
}

export async function patchRadioEpisodeProgress(id = '', progress = {}) {
  const key = text(id, 180);
  if (!key) return null;
  const [episodeStored, progressStored] = await Promise.all([
    db.getRecord('settings', radioSettingKey(key)),
    db.getRecord('settings', radioProgressKey(key)).catch(() => null),
  ]);
  const row = episodeStored?.value;
  if (!row) return null;
  const chapters = Array.isArray(row.chapters) ? row.chapters : [];
  const current = progressStored?.value && typeof progressStored.value === 'object'
    ? progressStored.value
    : (row.progress || {});
  const now = Date.now();
  const next = {
    chapterIndex: Math.floor(clamp(
      progress.chapterIndex ?? current.chapterIndex,
      0,
      Math.max(0, chapters.length - 1),
      0,
    )),
    positionSeconds: clamp(
      progress.positionSeconds ?? current.positionSeconds,
      0,
      24 * 3600,
      0,
    ),
    completed: progress.completed ?? current.completed === true,
    updatedAt: now,
    lastPlayedAt: now,
  };
  // 进度高频保存必须只写独立小记录，不能每 4 秒复制整期 Base64 长音频。
  await db.putRecord('settings', {
    key: radioProgressKey(key),
    value: next,
    updatedAt: now,
  });
  await updateRadioCatalog(normalizeRadioEpisode({
    ...row,
    progress: next,
    lastPlayedAt: next.lastPlayedAt,
    updatedAt: row.updatedAt,
  }, { hydrateAudio: false, hydrateCover: false })).catch(() => {});
  if (next.completed) {
    const episode = normalizeRadioEpisode({ ...row, progress: next }, { hydrateAudio: false });
    await rememberRadioListeningCompletion(episode).catch(() => {});
  }
  return next;
}

export async function setRadioEpisodeCover(id = '', coverBlob = null) {
  const current = await getRadioEpisode(id);
  if (!current) throw new Error('没有找到这期节目');
  const next = normalizeRadioEpisode({
    ...current,
    updatedAt: Date.now(),
    coverBlob: coverBlob instanceof Blob ? coverBlob : null,
    coverDataUrl: '',
    coverType: coverBlob instanceof Blob ? coverBlob.type : '',
  });
  await putRadioEpisode(next);
  return next;
}

function avatarUrl(character = {}) {
  if (typeof character.avatar === 'string') return character.avatar;
  return character.avatar?.url || character.avatar?.dataUrl || '';
}

function characterFieldText(value, max = 5000) {
  if (Array.isArray(value)) return text(value.join('、'), max);
  if (value && typeof value === 'object') {
    const meaningful = Object.fromEntries(Object.entries(value).filter(([, item]) => (
      Array.isArray(item) ? item.length > 0
        : (item && typeof item === 'object') ? Object.values(item).some(Boolean)
          : String(item ?? '').trim()
    )));
    if (!Object.keys(meaningful).length) return '';
    try { return text(JSON.stringify(meaningful, null, 2), max); } catch (_) { return ''; }
  }
  return text(value, max);
}

function characterContext(character = {}) {
  const fields = [
    ['姓名', character.name],
    ['真实姓名', character.realName],
    ['性别', character.gender],
    ['别名', character.aliases],
    ['当前身份', character.currentRole],
    ['当前状态', character.currentStatus],
    ['角色简介', character.description || character.persona?.summary],
    ['性格', character.personality],
    ['与用户的关系', character.userRelationStatus || character.persona?.relationship],
    ['关系网', character.relationships],
    ['说话方式', character.speechStyle || character.persona?.speechStyle],
    ['说话标签', character.promptTags],
    ['角色完整资料', character.promptCorpus],
    ['真实语料', character.speechCorpus],
    ['背景经历', character.background || character.backstory],
    ['兴趣', Array.isArray(character.interests) ? character.interests.join('、') : character.interests],
    ['生活资料', character.lifeProfile],
    ['地点锚点', character.residenceAnchor],
    ['位置与生活方式', character.locationProfile],
    ['个人名片', character.card],
    ['用户备注', character.notes],
  ];
  return fields
    .map(([label, value]) => [label, characterFieldText(value, label === '真实语料' ? 7000 : 5000)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}：${value}`)
    .join('\n');
}

function radioTranslationInstruction(character = {}) {
  const profile = normalizeTranslationProfile(character?.translationProfile);
  const fullVoice = profile.mode === 'full' || profile.forceForeignInVoice === true;
  if (fullVoice) {
    return `语言与翻译：角色的有声节目使用${profile.language || '角色设定中的外语或方言'}讲述。正文的每个自然段都必须严格写成“外语原文〔对应的完整简体中文翻译〕”，一段原文只配一段译文，右括号〕后再换段；禁止出现没有〔〕译文的外语自然段，禁止把译文拆到下一个自然段。〔〕内只能写干净、通顺的简体中文，不得混入原文、乱码、颜文字、性能标签或动作提示。narrationBeats 始终只写简体中文，不跟随角色外语。`;
  }
  if (profile.mode === 'mixed') {
    return `语言与翻译：角色平时使用中文，偶尔自然使用${profile.dialectNote || '设定中的外语或方言'}；每次出现外语或方言词句，都必须在该词句后立刻紧跟〔简体中文意思〕，不得遗漏或把译文挪到下一段。〔〕内禁止原文、乱码、颜文字、性能标签和动作提示。narrationBeats 始终只写简体中文。`;
  }
  return '语言与翻译：按角色平时的中文表达生成，不添加翻译标记。';
}

const RADIO_TRANSLATION_MARK_RE = /〔([^〔〕]{1,3000})〕/gu;
const RADIO_TRANSLATION_NOISE_RE = /[^\u3400-\u9fffA-Za-z0-9\s，。！？；：、“”‘’（）《》〈〉—…·,.!?;:'"()\-/%℃°]/gu;

function radioTranslationLooksCorrupted(value = '') {
  const source = String(value || '').trim();
  if (!source) return true;
  if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(source)) return true;
  return (source.match(RADIO_TRANSLATION_NOISE_RE) || []).length >= 2;
}

function radioParagraphParts(value = '') {
  return String(value || '').split(/(\n+)/u);
}

async function repairGeneratedRadioTranslations(chapters = [], character = {}, { signal } = {}) {
  const profile = normalizeTranslationProfile(character?.translationProfile);
  const translationEnabled = profile.mode === 'full'
    || profile.mode === 'mixed'
    || profile.forceForeignInVoice === true;
  if (!translationEnabled) return chapters;
  const languageHint = [profile.language, profile.dialectNote].filter(Boolean).join(' ');
  const next = (Array.isArray(chapters) ? chapters : []).map((chapter) => ({
    ...chapter,
    narrationBeats: (Array.isArray(chapter?.narrationBeats) ? chapter.narrationBeats : [])
      .map((beat) => ({ ...beat })),
  }));
  const candidates = [];
  const paragraphTargets = new Map();
  const narrationTargets = new Map();

  next.forEach((chapter, chapterIndex) => {
    const parts = radioParagraphParts(repairNarrationTranslationMarkup(chapter?.text || '', {
      wrapOrphanSentences: false,
    }));
    for (let partIndex = 0; partIndex < parts.length; partIndex += 2) {
      const paragraph = String(parts[partIndex] || '');
      const leading = paragraph.match(/^\s*/u)?.[0] || '';
      const trailing = paragraph.match(/\s*$/u)?.[0] || '';
      const translations = [...paragraph.matchAll(RADIO_TRANSLATION_MARK_RE)]
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean);
      const source = paragraph.replace(RADIO_TRANSLATION_MARK_RE, '').trim();
      if (!source || !messageLikelyNeedsTranslation(source)) continue;
      const rawTranslation = translations.join('\n');
      const validTranslation = sanitizeAiTranslation(source, rawTranslation, { languageHint });
      if (validTranslation && !radioTranslationLooksCorrupted(validTranslation)) continue;
      const id = `radio_chapter_${chapterIndex}_paragraph_${partIndex}`;
      candidates.push({ id, source, translation: '', languageHint });
      paragraphTargets.set(id, { parts, partIndex, source, leading, trailing });
    }
    chapter.narrationBeats.forEach((beat, beatIndex) => {
      const source = String(beat?.text || '').trim();
      if (!source || !messageLikelyNeedsTranslation(source)) return;
      const id = `radio_chapter_${chapterIndex}_narration_${beatIndex}`;
      candidates.push({ id, source, translation: '', languageHint });
      narrationTargets.set(id, { chapter, beatIndex });
    });
    chapter.__translationParts = parts;
  });

  if (!candidates.length) {
    next.forEach((chapter) => { delete chapter.__translationParts; });
    return next;
  }
  const repairs = await repairTranslationEntries(candidates, {
    signal,
    automatic: true,
  }).catch(() => new Map());
  for (const [id, target] of paragraphTargets) {
    const translation = String(repairs.get(id) || '').trim();
    if (!translation) continue;
    target.parts[target.partIndex] = `${target.leading}${target.source}〔${translation}〕${target.trailing}`;
  }
  for (const [id, target] of narrationTargets) {
    const translation = String(repairs.get(id) || '').trim();
    if (!translation) continue;
    target.chapter.narrationBeats[target.beatIndex].text = translation;
  }
  next.forEach((chapter) => {
    chapter.text = chapter.__translationParts.join('');
    delete chapter.__translationParts;
  });
  return next;
}

function messageText(message = {}) {
  const body = text(message.metadata?.text || message.content || '', 800);
  if (!body || ['image', 'sticker'].includes(message.type)) return '';
  return `${message.senderId === 'user' ? '用户' : '角色'}：${body}`;
}

function localDateKey(timestamp = Date.now()) {
  const date = new Date(Number(timestamp || Date.now()));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function resolveRadioTemporalQuery({
  type = '',
  now = Date.now(),
  topic = '',
  recentText = '',
} = {}) {
  if (String(type || '') === 'daily') return `今日 ${localDateKey(now)}`;
  return fullText(topic) || text(recentText, 12000);
}

function targetSpec(minutes = 8) {
  const duration = Math.round(clamp(minutes, 3, 20, 8));
  const chapters = duration <= 5 ? 3 : (duration <= 10 ? 4 : 5);
  const chars = Math.round(duration * 260);
  return { duration, chapters, chars };
}

function normalizeGeneratedTitle(value = '', typeLabel = '') {
  let title = text(value, 120).replace(/^[《“"]+|[》”"]+$/gu, '').trim();
  const prefixes = [...new Set([
    typeLabel,
    ...RADIO_EPISODE_TYPES.map((item) => item.label),
    '角色电台',
    '声音节目',
    '电台',
  ].map((item) => text(item, 40)).filter(Boolean))];
  for (const prefix of prefixes) {
    if (title.startsWith(`${prefix}：`) || title.startsWith(`${prefix}:`)) {
      title = title.slice(prefix.length + 1).trim();
      break;
    }
  }
  return title || '今晚，讲给你听';
}

export function radioSpeechText(value = '') {
  return normalizeRadioProseText(value, 12000)
    .replace(/[（(](?:轻笑|笑|低笑|叹气|停顿|沉默|清嗓|压低声音|小声|深呼吸)[）)]/gu, '')
    .replace(/[ \t]*\n{2,}[ \t]*/gu, '<#0.62#>')
    .replace(/[ \t]*\n[ \t]*/gu, '<#0.34#>')
    .replace(/([，。！？；：])\1+/gu, '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

const RADIO_PARAGRAPH_PAUSE_RE = /<#\d+(?:\.\d+)?#>/gu;
const RADIO_MIN_DIRECTED_SEGMENT_CHARS = 6;

function splitRadioSpeechSection(value = '', maxChars = 180) {
  const source = String(value || '');
  const rows = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] || '')) cursor += 1;
    if (cursor >= source.length) break;
    const remaining = source.length - cursor;
    let end = source.length;
    if (remaining > maxChars) {
      const minEnd = Math.min(source.length, cursor + 56);
      const maxEnd = Math.min(source.length, cursor + maxChars);
      const window = source.slice(minEnd, maxEnd);
      const strong = [...window.matchAll(/[。！？!?．.][”」』’"']?/gu)].at(-1);
      const soft = [...window.matchAll(/[；;，,：:][”」』’"']?/gu)].at(-1);
      const chosen = strong || soft;
      end = chosen ? minEnd + chosen.index + chosen[0].length : maxEnd;
    }
    let trimmedEnd = end;
    while (trimmedEnd > cursor && /\s/u.test(source[trimmedEnd - 1] || '')) trimmedEnd -= 1;
    if (trimmedEnd > cursor) rows.push({
      text: source.slice(cursor, trimmedEnd),
      localStart: cursor,
      localEnd: trimmedEnd,
    });
    cursor = Math.max(end, cursor + 1);
  }
  return rows;
}

/**
 * 把整章变成可独立表演的短段。AI 的 performanceCues 是“语气段起点”，本地再按
 * 句义长度收束；段内让 TTS 自己处理技术分块，段间使用真实静音拼接。
 */
export function buildRadioVoiceSegments(textValue = '', rawPlan = null) {
  const source = String(textValue || '').trim();
  if (!source) return [];
  const timingText = source.replace(RADIO_PARAGRAPH_PAUSE_RE, '');
  const basePlan = normalizeVoiceSpeechPlan(rawPlan || {}, timingText) || {
    text: timingText,
    emotion: 'neutral',
    pace: 'normal',
    intensity: 0,
  };
  const cues = normalizeRadioFishPerformanceCues(
    rawPlan?.performanceCues || rawPlan?.cues || [],
    timingText,
  )
    .map((cue) => ({ ...cue, offset: timingText.indexOf(cue.anchor) }))
    .filter((cue) => cue.offset >= 0)
    .sort((left, right) => left.offset - right.offset);
  const paragraphParts = source.split(RADIO_PARAGRAPH_PAUSE_RE);
  const segments = [];
  let timingCursor = 0;
  paragraphParts.forEach((paragraph, paragraphIndex) => {
    const paragraphStart = timingCursor;
    const paragraphEnd = paragraphStart + paragraph.length;
    const localCueOffsets = cues
      .filter((cue) => cue.offset > paragraphStart && cue.offset < paragraphEnd)
      .map((cue) => cue.offset - paragraphStart)
      // Fish 的 cue 只是语气段起点。模型偶尔会把锚点放在段首后一两个字，
      // 若照单全收就会产生单字 TTS 请求；离边缘太近或彼此太近的 cue 直接
      // 沿用相邻语气，比制造碎片更自然，也不会丢正文。
      .filter((offset, index, rows) => {
        const previous = index > 0 ? rows[index - 1] : 0;
        return offset - previous >= RADIO_MIN_DIRECTED_SEGMENT_CHARS
          && paragraph.length - offset >= RADIO_MIN_DIRECTED_SEGMENT_CHARS;
      });
    const boundaries = [0, ...localCueOffsets, paragraph.length]
      .filter((value, index, rows) => rows.indexOf(value) === index)
      .sort((left, right) => left - right);
    let firstInParagraph = true;
    for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
      const sectionStart = boundaries[boundaryIndex];
      const sectionEnd = boundaries[boundaryIndex + 1];
      const section = paragraph.slice(sectionStart, sectionEnd);
      splitRadioSpeechSection(section).forEach((chunk) => {
        const startChar = paragraphStart + sectionStart + chunk.localStart;
        const endChar = paragraphStart + sectionStart + chunk.localEnd;
        const activeCue = [...cues].reverse().find((cue) => cue.offset <= startChar) || null;
        const cueDirection = String(activeCue?.direction || '').trim();
        const baseDirection = String(basePlan.performanceDirection || '').trim();
        const performanceDirection = [baseDirection, cueDirection && cueDirection !== baseDirection ? cueDirection : '']
          .filter(Boolean)
          .join('; ')
          .slice(0, 360);
        segments.push({
          text: chunk.text,
          startChar,
          endChar,
          gapBeforeMs: segments.length === 0 ? 0 : (firstInParagraph && paragraphIndex > 0 ? 420 : 150),
          speechPlan: normalizeVoiceSpeechPlan({
            text: chunk.text,
            emotion: activeCue?.emotion || basePlan.emotion,
            pace: activeCue?.pace || basePlan.pace,
            intensity: activeCue?.intensity ?? basePlan.intensity,
            performanceDirection,
          }, chunk.text),
        });
        firstInParagraph = false;
      });
    }
    timingCursor = paragraphEnd;
  });
  return segments.filter((segment) => segment.text).slice(0, 160);
}

/**
 * 电台是一整章长音声，不能只依赖模型自己从标点推断气口。正常长度的完整句后
 * 补一次隐藏停连：Fish 使用自然语言 direction，MiniMax 使用精确停顿。
 * 中英文句号都要识别；自然段使用更清楚的换段停顿并重置句内计数。
 */
export function applyRadioLongFormPhraseBreaks(value = '', provider = 'minimax') {
  const source = String(value || '').trim();
  if (!source) return '';
  const paragraphParts = source.split(/(<#\d+(?:\.\d+)?#>)/gu);
  const fish = String(provider || '').trim().toLowerCase() === 'fish';
  const sentencePause = fish
    ? '\n[speaking after a clearly audible short pause between sentences, then continuing conversationally with a fresh phrase onset]\n'
    : '<#0.24#>';
  const paragraphPause = '\n[speaking after a clearly audible, slightly longer paragraph pause, then resuming conversationally with a fresh phrase onset]\n';
  const minSpokenBeforePause = fish ? 28 : 72;
  return paragraphParts.map((part) => {
    if (/^<#\d+(?:\.\d+)?#>$/u.test(part)) return fish ? paragraphPause : part;
    const pieces = part.split(/([。！？!?．][”」』’"']?|\.[”」』’"']?(?=\s|$))/gu);
    let spokenSincePause = 0;
    return pieces.map((piece, index) => {
      const spoken = piece
        .replace(/\[[^\[\]\r\n]{1,240}\]/gu, '')
        .replace(/\s+/gu, '');
      spokenSincePause += spoken.length;
      const isSentenceEnd = /^[。！？!?．.]/u.test(piece);
      const hasMoreSpeech = pieces.slice(index + 1).some((next) => (
        next.replace(/\[[^\[\]\r\n]{1,240}\]/gu, '').replace(/\s+/gu, '').length > 0
      ));
      if (!isSentenceEnd || spokenSincePause < minSpokenBeforePause || !hasMoreSpeech) return piece;
      spokenSincePause = 0;
      return `${piece}${sentencePause}`;
    }).join('');
  }).join('');
}

/**
 * 同一声线在长文本里通常会比短气泡越念越赶。电台对最终 provider speed 做轻微
 * 降速，仍保留角色自己的相对语速和 speech pace，但不让整章 fast 变成抢读。
 */
export function applyRadioLongFormVoicePacing(profile = {}, config = {}, speechText = '') {
  const next = profile && typeof profile === 'object' ? { ...profile } : {};
  const spokenLength = radioSpeechTimingText(speechText).replace(/\s+/gu, '').length;
  // Fish 新电台以短表演段合成，正常段沿用角色原速；MiniMax 保留原有整章
  // 长文本节奏，继续对持续章节轻微降速，不能把两家的长文本策略混为一套。
  const factor = config?.provider === 'fish'
    ? (spokenLength >= 240 ? 0.96 : 1)
    : (spokenLength >= 160 ? 0.92 : 0.96);
  if (config?.provider === 'fish') {
    const fallback = Number(config?.fish?.speed || 1) || 1;
    const speed = Number(next.fishSpeed ?? next.fish_speed ?? fallback) || fallback;
    next.fishSpeed = Math.round(clamp(speed * factor, 0.5, 2, fallback) * 1000) / 1000;
  } else {
    const fallback = Number(config?.speed || 1) || 1;
    const speed = Number(next.speed ?? fallback) || fallback;
    next.speed = Math.round(clamp(speed * factor, 0.5, 2, fallback) * 1000) / 1000;
  }
  return next;
}

function radioSpeechTimingText(value = '') {
  return radioSpeechText(value).replace(/<#\d+(?:\.\d+)?#>/gu, '');
}

export function radioSoundMomentRatio(chapter = {}, moment = {}, index = 0) {
  const spoken = radioSpeechTimingText(stripTranslationMarks(chapter?.speechPlan?.text || chapter?.text || ''));
  const anchor = radioSpeechTimingText(stripTranslationMarks(moment?.anchor || ''));
  const anchorIndex = anchor ? spoken.indexOf(anchor) : -1;
  if (anchorIndex >= 0 && spoken.length) {
    // 动作发生在引用句说完之后，不在句子刚开口时抢先播放。
    return Math.max(0, Math.min(1, (anchorIndex + anchor.length) / spoken.length));
  }
  return Math.max(0, Math.min(1, (Number(index) + 1) / ((chapter?.soundMoments?.length || 0) + 1)));
}

/** 优先使用新分段渲染留下的真实时间轴；旧缓存没有时间轴时保持原比例算法。 */
export function radioSoundMomentSeconds(chapter = {}, moment = {}, index = 0, duration = 0) {
  const totalDuration = Math.max(0, Number(duration || chapter?.durationSeconds || 0) || 0);
  const spoken = radioSpeechTimingText(stripTranslationMarks(chapter?.speechPlan?.text || chapter?.text || ''));
  const anchor = radioSpeechTimingText(stripTranslationMarks(moment?.anchor || ''));
  const anchorIndex = anchor ? spoken.indexOf(anchor) : -1;
  const anchorEnd = anchorIndex >= 0 ? anchorIndex + anchor.length : -1;
  const timeline = normalizeRadioAudioTimeline(chapter?.audioTimeline);
  if (anchorEnd >= 0 && timeline.length) {
    const segment = timeline.find((item) => anchorEnd <= item.endChar && anchorEnd > item.startChar)
      || timeline.find((item) => anchorEnd <= item.endChar)
      || timeline.at(-1);
    if (segment) {
      const charSpan = Math.max(1, segment.endChar - segment.startChar);
      const localRatio = Math.max(0, Math.min(1, (anchorEnd - segment.startChar) / charSpan));
      const voiceSpan = Math.max(0, segment.endSeconds - segment.startSeconds);
      return Math.max(0, Math.min(totalDuration || Number.POSITIVE_INFINITY,
        segment.startSeconds + voiceSpan * localRatio));
    }
  }
  return totalDuration * radioSoundMomentRatio(chapter, moment, index);
}

function validateGeneratedRadio(value) {
  return !!value && typeof value === 'object'
    && text(value.title, 120)
    && Array.isArray(value.chapters)
    && value.chapters.length > 0
    && value.chapters.every((chapter) => text(chapter?.text || chapter?.content, 12000).length >= 40);
}

function validateGeneratedReadingRadio(value) {
  return !!value && typeof value === 'object'
    && text(value.title, 120)
    && Array.isArray(value.chapters)
    && value.chapters.length > 0
    && value.chapters.every((chapter) => (
      Array.isArray(chapter?.sourceParagraphIds)
      && (text(chapter?.intro, 4000) || text(chapter?.outro, 4000) || chapter.sourceParagraphIds.length)
    ));
}

function assembleReadingChapters(rawChapters = [], sourceParagraphs = []) {
  const paragraphs = sourceParagraphs
    .map((value) => text(value, 1200))
    .filter(Boolean);
  const chapters = (Array.isArray(rawChapters) ? rawChapters : []).slice(0, 8);
  if (!chapters.length || !paragraphs.length) return [];
  const validIds = new Set(paragraphs.map((_item, index) => `P${String(index + 1).padStart(3, '0')}`));
  const requestedCounts = chapters.map((chapter) => new Set(
    (Array.isArray(chapter?.sourceParagraphIds) ? chapter.sourceParagraphIds : [])
      .map((id) => String(id || '').trim().toUpperCase())
      .filter((id) => validIds.has(id)),
  ).size);
  let remaining = paragraphs.length;
  let paragraphIndex = 0;
  return chapters.map((chapter, chapterIndex) => {
    const chaptersLeft = chapters.length - chapterIndex;
    const requested = requestedCounts[chapterIndex];
    const count = chapterIndex === chapters.length - 1
      ? remaining
      : Math.max(1, Math.min(
        remaining - Math.max(0, chaptersLeft - 1),
        requested || Math.ceil(remaining / chaptersLeft),
      ));
    const sourceRows = paragraphs.slice(paragraphIndex, paragraphIndex + count);
    paragraphIndex += count;
    remaining -= count;
    const intro = applyPermanentRegex(
      normalizeRadioProseText(chapter?.intro || '', 4000),
      { surface: 'radio', placement: 2 },
    );
    const outro = applyPermanentRegex(
      normalizeRadioProseText(chapter?.outro || chapter?.commentary || '', 4000),
      { surface: 'radio', placement: 2 },
    );
    return {
      ...chapter,
      text: [intro, ...sourceRows, outro].filter(Boolean).join('\n\n'),
      sourceParagraphs: sourceRows,
    };
  }).filter((chapter) => chapter.text);
}

export async function generateRadioEpisode({
  user,
  characterId = '',
  type = 'bedtime',
  typeLabel = '',
  typeHint = '',
  topic = '',
  sourceText = '',
  sourceName = '',
  readingSeriesId = '',
  customPrompt = '',
  worldBookIds = [],
  worldBookSelectionMode = 'exclusive',
  actionMode = 'hidden',
  ambientEnabled = true,
  minutes = 8,
  signal,
} = {}) {
  const uid = text(user?.id, 240);
  const characters = await listCharacters({ excludeAnonNpc: true, userId: uid, identityScoped: true });
  const character = characters.find((item) => String(item.id) === String(characterId));
  if (!uid || !character) throw new Error('请选择一位当前身份可见的角色');
  await primeDisplayRegex().catch(() => null);
  const customType = /^custom-[a-z0-9-]+$/u.test(String(type || ''));
  const episodeType = RADIO_TYPE_IDS.has(type) || customType ? type : 'bedtime';
  const typeInfo = RADIO_EPISODE_TYPES.find((item) => item.id === episodeType) || {
    id: episodeType,
    label: text(typeLabel, 32) || '自定义节目',
    hint: text(typeHint, 100) || '按用户保存的节目方向来讲述',
  };
  const spec = targetSpec(minutes);
  let readingSeries = null;
  let readingPart = null;
  if (episodeType === 'reading') {
    if (readingSeriesId) {
      readingSeries = await getRadioReadingSeries(readingSeriesId);
      if (!readingSeries || readingSeries.userId !== uid || readingSeries.characterId !== text(character.id, 240)) {
        throw new Error('没有找到可继续的来稿专栏');
      }
    } else {
      const completeSource = fullText(sourceText).slice(0, 4000000);
      if (!completeSource) throw new Error('来稿夜读需要先导入文本');
      const cleanSourceName = text(sourceName || topic || '未命名来稿', 240)
        .replace(/\.txt$/iu, '')
        .trim() || '未命名来稿';
      readingSeries = normalizeRadioReadingSeries({
        userId: uid,
        characterId: character.id,
        title: cleanSourceName,
        sourceName: text(sourceName || cleanSourceName, 240),
        sourceText: completeSource,
        minutes: spec.duration,
      });
    }
    readingPart = splitRadioReadingSource(readingSeries, spec.duration);
    if (!readingPart.text) throw new Error('这份来稿已经读完了');
  }
  const rawVoiceProfile = character.voiceProfile || character.voice || {};
  const voiceConfig = resolveVoiceToolConfigForProfile(
    await loadVoiceToolConfig().catch(() => ({})),
    rawVoiceProfile,
  );
  const voiceWorldBook = buildVoiceWorldBookPrompt(VOICE_WORLD_BOOK_SURFACES.RADIO, {
    provider: voiceConfig.provider,
    customText: voiceConfig.styleBook?.enabled === true ? voiceConfig.styleBook?.text : '',
    includeCustom: voiceConfig.styleBook?.enabled === true,
  });
  const chat = await findPrivateChat(uid, character.id).catch(() => null);
  if (readingSeries) {
    readingSeries = normalizeRadioReadingSeries({ ...readingSeries, chatId: chat?.id || readingSeries.chatId });
  }
  const recent = chat ? await listMessagesForChat(chat.id, 24).catch(() => []) : [];
  const recentText = recent.map(messageText).filter(Boolean).slice(-18).join('\n');
  const worldNow = await getNowForUser(uid).catch(() => Date.now());
  const imported = readingPart?.text || text(sourceText, 18000);
  const requestedTopic = fullText(topic);
  const requestedPrompt = fullText(customPrompt);
  const requestedWorldBookIds = normalizeWorldBookIds(worldBookIds);
  const requestedWorldBookSelectionMode = worldBookSelectionMode === 'additive' ? 'additive' : 'exclusive';
  const promptTopic = applyPromptRegex(requestedTopic, { surface: 'radio', placement: 1 });
  const promptImport = applyPromptRegex(imported, { surface: 'radio', placement: 1 });
  const readingParagraphRows = (readingPart?.paragraphs || []).map((paragraph, index) => ({
    id: `P${String(index + 1).padStart(3, '0')}`,
    text: applyPromptRegex(paragraph, { surface: 'radio', placement: 1 }),
  }));
  const readingManuscript = readingParagraphRows.map((row) => `[${row.id}]\n${row.text}`).join('\n\n');
  const promptCustom = applyPromptRegex(requestedPrompt, { surface: 'radio', placement: 1 });
  const promptRecent = applyPromptRegex(recentText, { surface: 'radio', placement: 2 });
  const promptCharacter = characterContext(character);
  const requestedActionMode = RADIO_ACTION_MODES.has(String(actionMode || ''))
    ? String(actionMode)
    : 'hidden';
  // 世界书关键词可能只出现在角色卡里；角色绑定只负责作用域过滤，不能替代关键词召回。
  const selectiveText = [requestedTopic, requestedPrompt, imported, recentText, promptCharacter]
    .filter(Boolean)
    .join('\n')
    .slice(-32000);
  const characterMap = Object.fromEntries(characters.map((item) => [item.id, item]));
  // 不选时沿用默认世界书规则；电台页一旦选书就改为本期排他白名单。
  // 角色自主生成会把来源私聊的额外启用项以 additive 传入，继续保留全局与角色绑定规则。
  const activeWorldBookIds = requestedWorldBookIds;
  const exclusiveWorldBookSelection = activeWorldBookIds.length > 0
    && requestedWorldBookSelectionMode === 'exclusive';
  const recentTimestamps = recent
    .map((message) => Number(message?.timestamp || 0))
    .filter((timestamp) => timestamp > 0);
  const temporalQueryText = resolveRadioTemporalQuery({
    type: episodeType,
    now: worldNow,
    topic: requestedTopic,
    recentText,
  });
  const [layeredMemory, eventTimeline, worldBook, miniWiki] = await Promise.all([
    chat ? buildLayeredMemoryContext({
      chat,
      characterIds: [character.id],
      user,
      characters: characterMap,
      fallbackChatId: chat.id,
      unifiedEventTimeline: true,
      queryText: selectiveText,
      strictUserScope: true,
    }).catch(() => '') : '',
    chat ? buildUnifiedEventTimelineContext({
      chat,
      userId: uid,
      characterIds: [character.id],
      now: worldNow,
      queryText: selectiveText,
      temporalQueryText,
      temporalOnly: episodeType === 'daily',
      recentHistoryMessageIds: recent.map((message) => String(message?.id || '')).filter(Boolean),
      recentHistoryStartTs: recentTimestamps.length ? Math.min(...recentTimestamps) : 0,
      recentHistoryEndTs: recentTimestamps.length ? Math.max(...recentTimestamps) : 0,
      budgetChars: 5600,
      maxEvents: 16,
      strictUserScope: true,
    }).catch(() => '') : '',
    buildWorldBookContextBlock(user, selectiveText, {
      characterIds: [character.id],
      worldBookMode: exclusiveWorldBookSelection ? 'full' : 'selective',
      onlyBookIds: activeWorldBookIds.length ? activeWorldBookIds : undefined,
      restrictToBookIds: exclusiveWorldBookSelection,
      forceFullEntries: exclusiveWorldBookSelection,
      sparseVectorMode: false,
    }).catch(() => ''),
    buildMiniWikiContextBlock(user, selectiveText, {
      characterIds: [character.id],
      worldBookMode: exclusiveWorldBookSelection ? 'full' : 'selective',
      onlyBookIds: activeWorldBookIds.length ? activeWorldBookIds : undefined,
      restrictToBookIds: exclusiveWorldBookSelection,
      forceFullEntries: exclusiveWorldBookSelection,
      sparseVectorMode: false,
    }).catch(() => ''),
  ]);
  const [soundAssets, soundCatalog] = await Promise.all([
    listSoundAssets().catch(() => []),
    listSoundAssetCategoryCatalog().catch(() => []),
  ]);
  const availableSoundIds = new Set(soundAssets
    .filter((asset) => asset?.enabled !== false && asset?.audioBlob instanceof Blob && asset.audioBlob.size > 0)
    .map((asset) => text(asset.category, 80))
    .filter(Boolean));
  const availableSoundSpecs = soundCatalog.filter((item) => availableSoundIds.has(String(item.id || '')));
  const momentSoundSpecs = availableSoundSpecs.filter((item) => item.mode === 'cue' || item.mode === 'texture');
  const backgroundSoundSpecs = availableSoundSpecs.filter((item) => item.mode === 'background');
  const soundSpecText = (items) => items.map((item) => (
    `${item.id}（${item.label}${item.hint ? `：${item.hint}` : ''}）`
  )).join('；');
  const actionInstruction = requestedActionMode === 'visible'
    ? `非语言动作采用“可见旁白”模式，并拆成两条轨道。第一条是 narrationBeats：每章在讲述转折处穿插 2～5 段静音旁白，每段约 35～120 字，用自然、连贯的简体中文写角色当下可见的神态、手上动作、坐姿、距离、光线与周围变化；像聊天旁白模式的场景段落，不写括号舞台提示，不替用户行动，不泄露角色心理，也不要只写“轻笑”“停顿”这种词条。每段 anchor 必须逐字引用它前面紧邻的正文短句，旁白 text 不得重复进有声正文。第二条是 soundMoments：只记录确实会发声的动作与音频分类，actionText 只供内部判断、不在前台显示；有没有可用音效都不影响 narrationBeats。soundMoments.anchor 必须引用角色实际会朗读的原文，双语节目不得引用〔〕内中文译文，并代表说完这句后触发动作音。可用动作音分类只有：${soundSpecText(momentSoundSpecs) || '无可用素材，因此 soundMoments 留空，但 narrationBeats 仍正常生成'}。`
    : (requestedActionMode === 'hidden'
      ? `非语言小动作采用“只听动静”模式：所有章节 narrationBeats 必须为空数组。正文保持角色连续讲述，可在 soundMoments 中少量安排角色换姿势、碰杯、翻页、走动等当下动作；actionText 只用于内部判断，不会显示或朗读，anchor 必须引用动作发生前的可朗读原文，表示说完这句后触发，双语节目不得引用〔〕内中文译文。只在物理上真的会发声时选分类，可用分类只有：${soundSpecText(momentSoundSpecs) || '无可用素材，因此 soundMoments 留空'}。`
      : '非语言小动作采用“纯净讲述”模式：所有章节的 narrationBeats 与 soundMoments 都必须为空数组，不额外安排动作旁白或动作音。');
  const promptParts = [
    '背景',
    `你要以角色“${text(character.name, 80)}”本人的口吻，制作一期可收藏、可重播的中文长音声电台。`,
    promptCharacter,
    `当前用户称呼：${text(user?.name || user?.nickname || '用户', 80)}`,
    '用户资料没有明确给出性别或代词时，只能用名字、“你”或中性指代，不得根据昵称、头像、关系和题材猜成“他/她”。',
    promptRecent ? `最近聊天片段（只用于关系语气与共同上下文，不要逐句复述）：\n${promptRecent}` : '',
    layeredMemory ? `与这位角色有关的分层记忆（用于保持关系、经历与称呼连续）：\n${text(layeredMemory, 8000)}` : '',
    eventTimeline ? `相关事件时间线（注意先后、完成状态与知情范围）：\n${text(eventTimeline, 5600)}` : '',
    worldBook ? `本期需要遵守的世界书与设定：\n${text(worldBook, 9000)}` : '',
    String(worldBook || '').includes('[核心设定·必须遵守]')
      ? '最后提醒：本期世界书里标「[核心设定·必须遵守]」的条目仍是角色本人必须服从的长期设定；节目任务只规定本期作品与 JSON 外壳，不得把核心角色约束降级成普通素材。'
      : '',
    miniWiki ? `角色本来知道、且与本期有关的小知识或梗：\n${text(miniWiki, 3000)}` : '',
    '',
    '任务',
    `节目类型：${typeInfo?.label || '声音节目'}。${typeInfo?.hint || ''}`,
    episodeType === 'daily'
      ? `当前世界日期：${localDateKey(worldNow)}。本期“今日手记”只整理这个自然日内已经发生的聊天、记忆与事件；更早内容只能在解释今天的延续或后果时简短带到，禁止把旧日经历冒充今天重新讲述。若今日素材较少，就如实写一篇较安静的手记，不得拿最早一天的记忆填充。`
      : '',
    promptTopic ? `用户给出的主题：${promptTopic}` : '没有指定主题，请根据角色自然选择一个适合此刻的主题。',
    episodeType === 'reading' && readingManuscript
      ? `本期是“${readingSeries.title}”来稿专栏第 ${readingSeries.partNumber + 1} 期，只处理下列编号原文，不得续写、改写、翻译、删句或把后续未提供内容提前讲出。角色可以在原文段落前后加入简短引入、衔接和评论，但原文本身必须通过 sourceParagraphIds 引用，由程序按编号逐字放回；不要把原文复制进 intro / outro。\n---\n${readingManuscript}\n---`
      : (promptImport ? `用户导入的来稿如下。不能机械照读；要保留核心内容，同时用角色自己的过渡、评价、联想和停顿把它融入一期节目：\n---\n${promptImport}\n---` : ''),
    `目标约 ${spec.duration} 分钟、${spec.chapters} 章、总计约 ${spec.chars} 个中文字符。每章应能单独进行语音合成，章节之间自然衔接。`,
    '角色可以评论、停顿、联想和偶尔对用户说一句话，但不要变成需要用户即时回答的聊天。',
    episodeType === 'memory' || episodeType === 'confession'
      ? '角色可以讲资料里已经存在的过去，也可以沿着人设、生活逻辑和既有时间线补全此前没有写明的个人经历。新增经历必须属于角色自己、不得与既有事实冲突，也不得擅自给用户补共同经历；它会被视作角色这次亲口透露的新碎片，而不是要求你标注“虚构”或“假设”。'
      : '童话、改编、怪谈或胡编内容必须保持作品语境，不要伪装成现实事实。',
    '事实一致性是硬约束：写作前核对角色身份与性别、用户称呼、关系阶段、已发生事件、住处、房间、家具与物品等具体锚点。角色卡、世界书、有效记忆、用户来稿和最近聊天中已经明确的事实不得擅自改写；资料没有说明时宁可保持模糊，也不要为了增加细节自行确定床型、户型、家庭成员、身体特征或共同经历。若不同来源冲突，优先采用更明确、更新且与当前角色直接相关的资料。',
    '标题只写作品名本身，要自然、具体、有画面感，像真的一期节目或一篇短篇作品。禁止使用“节目类型：标题”“枕边故事：标题”“角色电台：标题”这类栏目名加冒号的模板，也不要使用“AI”“生成”“根据要求”等幕后措辞。',
    '先把它当成角色在夜里真的想讲完的一件事，而不是命题作文、播音稿或内容平台脚本。允许说到一半换一种讲法、插入具体细节、短暂跑开又自然回来；不要固定使用“今晚想和你聊聊”“那么故事开始了”“你准备好了吗”“这告诉我们”等主持模板，也不要每章开头复述题目、结尾总结中心思想。',
    '专业背景只是一种可调用的经验，不是整期节目的身份标签。除非本期主题本来就在相关领域、用户明确要科普，或叙述走到确实需要专业判断的地方，否则不要反复抛职业名词、行业术语和职业比喻，也不要把普通感情与生活细节强行职业化；专业性应体现在观察、判断和少量具体细节里，不体现在名词密度里。',
    '句子服从角色本人真实说话的气口和语料：紧密相连的意思留在同一句或同一段，念头真的转向时再落句；标点用来表达语义，不要为了制造停顿密集堆逗号、空格、省略号或破折号。不要写“（轻笑）”“（停顿）”等会被语音直接念出的舞台提示。',
    voiceWorldBook,
    voiceConfig.provider === 'fish'
      ? '每章都要填写 speech 隐藏表演轨，但不要在 speech 里重复正文。emotion 使用 neutral|happy|sad|angry|fearful|surprised|disgusted，pace 使用 slow|normal|fast，intensity 使用 0～1。章级字段只负责开场的基础状态；真正的语气变化写进 performanceCues。系统会把这些 cue 当成独立表演段的起点，分别合成后连续拼接。'
      : '每章都要填写 speech 隐藏表演轨，但不要在 speech 里重复正文。emotion 使用 neutral|happy|sad|angry|fearful|surprised|disgusted，pace 使用 slow|normal|fast，intensity 使用 0～1。MiniMax 按整章连续合成，speech 只填写章级情绪与节奏，performanceCues 留空。',
    voiceConfig.provider === 'fish'
      ? 'Fish performanceCues 是语气段隐藏轨：第一条 anchor 必须引用本章开头的可朗读原文；后续每条 anchor 必须逐字引用新语气段开头的一小段原文。每条填写该段 emotion、pace、intensity；direction 以 speaking 开头，用简短英文描述这一段的具体说法。每章通常 3～8 段，只在调侃、迟疑、认真、难过、放软、重新开口等真实变化处换段，不要机械逐句切。双语节目 anchor 只能引用外语原文，不能引用〔〕内译文。'
      : '',
    VARIED_SEGMENTATION_HINT,
    '有声断句要求：每个自然段也是一个真实换气单元。句子必须用完整标点表达语义边界，不要用换行代替逗号或句号，也不要把许多独立意思用逗号一路串成长句；需要转折、放软、犹豫或重新开口时另起短段，让长段之间确实有呼吸位。',
    radioTranslationInstruction(character),
    actionInstruction,
    ambientEnabled !== false
      ? `连续环境声只在场景从头到尾真实成立时选择，最多两个；当前音频库可用背景分类只有：${soundSpecText(backgroundSoundSpecs) || '无，因此 ambientCategories 留空'}。ambientCategories 只能原样填写这里真实列出的分类 ID，包括用户自定义 ID；不要因为“夜晚”“安静”等抽象气氛凭空添加雨声、水声或音乐。`
      : '本期关闭连续环境背景音，ambientCategories 必须为空数组。',
    promptCustom ? `用户为本期补充的生成要求如下。把它用于题材、文风、结构和表达偏好；若与角色事实或下方 JSON 输出格式冲突，以角色事实和输出格式为准：\n---\n${promptCustom}\n---` : '',
    '',
    '输出 JSON 格式',
    '{',
    '  "title": "节目标题",',
    '  "subtitle": "一句很短的副标题",',
    '  "summary": "不剧透的节目简介",',
    '  "memorySummary": "供以后聊天记起本期内容的事实摘要，120到260字，不写宣传文案",',
    '  "memoryKeywords": ["3到8个可用于检索内容的具体词语"],',
    '  "canonNotes": ["本期由角色亲口补充的个人过去或稳定自我认知；没有则空数组，童话情节不要写入"],',
    '  "ambientCategories": ["真实可用的背景分类ID；最多两个，没有则空数组"],',
    '  "discussionHooks": ["听完后可以自然聊起的问题，1到3条"],',
    episodeType === 'reading'
      ? (voiceConfig.provider === 'fish'
        ? '  "chapters": [{"title":"章节名","intro":"角色在原文前说的话，可空","sourceParagraphIds":["P001","P002"],"outro":"角色在原文后说的话，可空","speech":{"emotion":"neutral","pace":"normal","intensity":0.2,"direction":"Fish 专用基础指导","performanceCues":[{"anchor":"语气段开头的可朗读原文","emotion":"neutral","pace":"normal","intensity":0.25,"direction":"speaking 开头的局部英文表演指导"}]},"narrationBeats":[],"soundMoments":[]}]'
        : '  "chapters": [{"title":"章节名","intro":"角色在原文前说的话，可空","sourceParagraphIds":["P001","P002"],"outro":"角色在原文后说的话，可空","speech":{"emotion":"neutral","pace":"normal","intensity":0.2,"direction":"","performanceCues":[]},"narrationBeats":[],"soundMoments":[]}]')
      : (voiceConfig.provider === 'fish'
        ? '  "chapters": [{"title":"章节名","text":"本章完整可朗读正文","speech":{"emotion":"neutral","pace":"normal","intensity":0.2,"direction":"Fish 专用基础指导","performanceCues":[{"anchor":"语气段开头的原文","emotion":"neutral","pace":"normal","intensity":0.25,"direction":"speaking 开头的局部英文表演指导"}]},"narrationBeats":[{"anchor":"前面正文中可精确找到的短句","text":"静音的可见场景与动作旁白"}],"soundMoments":[{"anchor":"正文中可精确找到的短句","actionText":"角色当下没有说出口的小动作","categories":["音频库分类"]}]}]'
        : '  "chapters": [{"title":"章节名","text":"本章完整可朗读正文","speech":{"emotion":"neutral","pace":"normal","intensity":0.2,"direction":"","performanceCues":[]},"narrationBeats":[{"anchor":"前面正文中可精确找到的短句","text":"静音的可见场景与动作旁白"}],"soundMoments":[{"anchor":"正文中可精确找到的短句","actionText":"角色当下没有说出口的小动作","categories":["音频库分类"]}]}]'),
    '}',
    '只输出一个 JSON 对象，不要 Markdown。',
  ].filter(Boolean);
  const taskBoundaryIndex = promptParts.indexOf('任务');
  const radioSystemPrompt = promptParts
    .slice(0, taskBoundaryIndex >= 0 ? taskBoundaryIndex : promptParts.length)
    .join('\n');
  const radioUserPrompt = promptParts
    .slice(taskBoundaryIndex >= 0 ? taskBoundaryIndex : promptParts.length)
    .join('\n');
  const maxTokens = await resolveGenerationMaxTokens();
  const { data } = await chatJsonGeneration({
    messages: composeContextualGenerationMessages({
      systemParts: [radioSystemPrompt],
      userContent: radioUserPrompt,
    }),
    validate: episodeType === 'reading' ? validateGeneratedReadingRadio : validateGeneratedRadio,
    maxTokens,
    temperature: 0.82,
    signal,
    task: '',
  });
  const rawGeneratedChapters = episodeType === 'reading'
    ? assembleReadingChapters(data.chapters, readingPart?.paragraphs || [])
    : (Array.isArray(data.chapters) ? data.chapters : []);
  const generatedChapters = rawGeneratedChapters.map((chapter) => {
    const chapterText = episodeType === 'reading'
      ? text(chapter?.text || chapter?.content || '', 12000)
      : applyPermanentRegex(chapter?.text || chapter?.content || '', { surface: 'radio', placement: 2 });
    const rawSpeech = chapter?.speechPlan || chapter?.speech || {};
    return {
      ...chapter,
      title: applyPermanentRegex(chapter?.title || '', { surface: 'radio', placement: 2 }),
      text: chapterText,
      speechPlan: normalizeRadioSpeechPlan({
        ...rawSpeech,
        // speech 只承载表演元数据，正文永远取唯一的 chapter.text，避免模型双份输出后截断。
        text: chapterText,
      }, chapterText),
      narrationBeats: requestedActionMode === 'visible'
        ? (Array.isArray(chapter?.narrationBeats) ? chapter.narrationBeats : []).map((beat) => ({
          ...beat,
          anchor: applyPermanentRegex(beat?.anchor || '', { surface: 'radio', placement: 2 }),
          text: applyPermanentRegex(beat?.text || beat?.body || '', { surface: 'radio', placement: 2 }),
        }))
        : [],
      soundMoments: requestedActionMode === 'off'
        ? []
        : (Array.isArray(chapter?.soundMoments) ? chapter.soundMoments : []).map((moment) => ({
          ...moment,
          categories: (Array.isArray(moment?.categories) ? moment.categories : [])
            .filter((category) => momentSoundSpecs.some((item) => item.id === category)),
        })),
    };
  });
  const repairedChapters = episodeType === 'reading'
    ? generatedChapters
    : await repairGeneratedRadioTranslations(generatedChapters, character, { signal });
  const episode = normalizeRadioEpisode({
    id: createId(),
    userId: uid,
    characterId: character.id,
    chatId: chat?.id || '',
    characterIds: [character.id],
    characterName: character.name,
    characterAvatar: avatarUrl(character),
    type: episodeType,
    typeLabel: customType ? typeInfo.label : '',
    typeHint: customType ? typeInfo.hint : '',
    title: normalizeGeneratedTitle(
      applyPermanentRegex(data.title, { surface: 'radio', placement: 2 }),
      typeInfo?.label,
    ),
    subtitle: applyPermanentRegex(data.subtitle, { surface: 'radio', placement: 2 }),
    summary: applyPermanentRegex(data.summary, { surface: 'radio', placement: 2 }),
    memorySummary: data.memorySummary,
    memoryKeywords: data.memoryKeywords,
    canonNotes: data.canonNotes,
    topic: requestedTopic,
    generationPrompt: requestedPrompt,
    worldBookIds: requestedWorldBookIds,
    worldBookSelectionMode: requestedWorldBookSelectionMode,
    actionMode: requestedActionMode,
    ambientEnabled: ambientEnabled !== false,
    sourceKind: imported ? 'imported' : 'prompt',
    sourceText: episodeType === 'reading' ? '' : imported,
    readingSeries: readingSeries ? {
      id: readingSeries.id,
      sourceName: readingSeries.sourceName,
      title: readingSeries.title,
      partNumber: readingSeries.partNumber + 1,
      start: readingPart.start,
      end: readingPart.end,
      totalLength: readingSeries.sourceText.length,
      minutes: spec.duration,
      hasMore: readingPart.hasMore,
    } : null,
    ambientCategories: ambientEnabled !== false
      ? (Array.isArray(data.ambientCategories) ? data.ambientCategories : [])
        .filter((category) => backgroundSoundSpecs.some((item) => item.id === category))
      : [],
    discussionHooks: data.discussionHooks,
    chapters: repairedChapters,
    status: 'ready',
  });
  await putRadioEpisode(episode);
  if (readingSeries) {
    await putRadioReadingSeries({
      ...readingSeries,
      cursor: readingPart.end,
      partNumber: readingSeries.partNumber + 1,
      minutes: spec.duration,
      episodeIds: [...readingSeries.episodeIds, episode.id],
    });
  }
  enqueueVectorSources('archive', buildRadioEpisodePassageSources(episode)).catch(() => {});
  await rememberRadioCreation(episode, chat?.id || '').catch(() => {});
  return episode;
}

export async function continueRadioReadingSeries({ user, episodeId = '', minutes = null, signal } = {}) {
  const previous = await getRadioEpisode(episodeId);
  if (!previous || previous.userId !== text(user?.id, 240) || previous.type !== 'reading') {
    throw new Error('没有找到要续读的来稿节目');
  }
  if (!previous.readingSeries?.id || previous.readingSeries.hasMore !== true) {
    throw new Error('这份来稿已经读完了');
  }
  const continuationMinutes = resolveRadioReadingContinuationMinutes(
    minutes,
    previous.readingSeries.minutes,
  );
  return generateRadioEpisode({
    user,
    characterId: previous.characterId,
    type: 'reading',
    topic: previous.topic,
    readingSeriesId: previous.readingSeries.id,
    customPrompt: previous.generationPrompt,
    worldBookIds: previous.worldBookIds,
    worldBookSelectionMode: previous.worldBookSelectionMode,
    actionMode: previous.actionMode,
    ambientEnabled: previous.ambientEnabled,
    minutes: continuationMinutes,
    signal,
  });
}

export async function ensureRadioChapterAudio(episodeId = '', chapterIndex = 0, { signal } = {}) {
  const episode = await getRadioEpisode(episodeId);
  if (!episode) throw new Error('没有找到这期节目');
  const index = Math.floor(clamp(chapterIndex, 0, Math.max(0, episode.chapters.length - 1), 0));
  const chapter = episode.chapters[index];
  if (isRadioChapterAudioCurrent(chapter)) {
    return { episode, chapter, fromCache: true };
  }
  await primeDisplayRegex().catch(() => null);
  const speechText = stripTranslationMarks(applyDisplayRegex(chapter.text, 'radio'));
  const cleanSpeechText = radioSpeechText(speechText);
  const rawPlanText = chapter.speechPlan?.text
    ? radioSpeechText(stripTranslationMarks(applyDisplayRegex(chapter.speechPlan.text, 'radio')))
    : cleanSpeechText;
  const speechPlan = normalizeRadioSpeechPlan({
    ...(chapter.speechPlan || {}),
    text: rawPlanText,
    emotion: chapter.speechPlan?.emotion || 'neutral',
    pace: chapter.speechPlan?.pace || 'normal',
    intensity: chapter.speechPlan?.intensity ?? 0.18,
    performanceDirection: chapter.speechPlan?.performanceDirection
      || 'direct and conversational, as if speaking to one familiar person; emotionally responsive to each turn, with natural pauses and clear articulation',
  }, cleanSpeechText);
  const rawVoiceProfile = await loadCharacterVoiceProfile(episode.characterId);
  const config = resolveVoiceToolConfigForProfile(await loadVoiceToolConfig(), rawVoiceProfile);
  config.styleBook = { ...(config.styleBook || {}), enabled: true };
  if (config.provider === 'fish' && speechPlan) {
    const generatedDirection = String(speechPlan.performanceDirection || '').trim();
    const radioPhrasingDirection = 'direct and conversational, speaking to one familiar person with clear articulation';
    speechPlan.performanceDirection = [radioPhrasingDirection, generatedDirection]
      .filter(Boolean)
      .join('; ')
      .slice(0, 360);
  }
  let payload = null;
  let blob = null;
  let audioTimeline = [];
  let renderedDurationSeconds = 0;
  if (config.provider === 'fish') {
    const voiceSegments = buildRadioVoiceSegments(speechPlan?.text || cleanSpeechText, speechPlan);
    if (!voiceSegments.length) throw new Error('没有可合成的电台正文');
    const renderedSegments = [];
    for (const segment of voiceSegments) {
      const voiceProfileOverride = applyRadioLongFormVoicePacing(
        buildVoiceSpeechProfileOverride(rawVoiceProfile, segment.speechPlan, config),
        config,
        segment.text,
      );
      const segmentPayload = await synthesizeVoice({
        text: segment.text,
        characterId: episode.characterId,
        config,
        voiceProfileOverride,
        signal,
        // Fish 分段只在内存中存在；电台最终仅持久化拼好的单章 Blob。
        skipCache: true,
      });
      renderedSegments.push({ ...segment, payload: segmentPayload });
    }
    const merged = await mergeCachedVoiceSequence(renderedSegments.map((segment) => ({
      payload: segment.payload,
      gapBeforeMs: segment.gapBeforeMs,
    })));
    blob = merged.audioBlob instanceof Blob ? merged.audioBlob : null;
    renderedDurationSeconds = merged.durationSeconds;
    audioTimeline = renderedSegments.map((segment, segmentIndex) => ({
      startChar: segment.startChar,
      endChar: segment.endChar,
      startSeconds: merged.timings[segmentIndex]?.startSeconds || 0,
      endSeconds: merged.timings[segmentIndex]?.endSeconds || 0,
      gapBeforeMs: segment.gapBeforeMs,
    }));
    payload = {
      ...renderedSegments[0].payload,
      audioBlob: blob,
      audioDataUrl: '',
      text: cleanSpeechText,
      ttsText: cleanSpeechText,
      format: 'wav',
      extraInfo: {
        ...(renderedSegments[0].payload?.extraInfo || {}),
        audio_length: Math.round(merged.durationSeconds * 1000),
        speech_segments: renderedSegments.length,
      },
    };
  } else {
    // MiniMax 保留原有整章连续合成：精确停顿标签、章级 emotion 和长文本
    // condition 由它自己的模型链路处理，不套用 Fish 的多请求拼接策略。
    const synthesisText = applyRadioLongFormPhraseBreaks(
      speechPlan?.text || cleanSpeechText,
      config.provider,
    );
    const voiceProfileOverride = applyRadioLongFormVoicePacing(
      buildVoiceSpeechProfileOverride(rawVoiceProfile, speechPlan, config),
      config,
      synthesisText,
    );
    payload = await synthesizeVoice({
      text: synthesisText,
      characterId: episode.characterId,
      config,
      voiceProfileOverride,
      signal,
      // 长音声由电台自己持久化；不要再写一份通用 TTS Blob 缓存。
      skipCache: true,
    });
    blob = payload.audioBlob instanceof Blob ? payload.audioBlob : null;
    renderedDurationSeconds = payload.extraInfo?.audio_length != null
      ? normalizeRadioDurationSeconds(Number(payload.extraInfo.audio_length) / 1000)
      : normalizeRadioDurationSeconds(chapter.durationSeconds);
  }
  if (!blob?.size) throw new Error('语音接口没有返回可保存的音频');
  const chapters = episode.chapters.map((item, chapterOffset) => chapterOffset === index
    ? normalizeChapter({
      ...item,
      audioBlob: blob,
      audioDataUrl: config.provider === 'fish' ? '' : (payload.audioDataUrl || ''),
      audioType: blob.type,
      audioTimeline,
      audioTextVersion: RADIO_AUDIO_TEXT_VERSION,
      audioStatus: 'ready',
      audioError: '',
      durationSeconds: normalizeRadioDurationSeconds(renderedDurationSeconds),
      updatedAt: Date.now(),
    }, chapterOffset)
    : item);
  const saved = normalizeRadioEpisode({ ...episode, updatedAt: Date.now(), chapters });
  let cacheError = '';
  try {
    await putRadioEpisode(saved);
  } catch (error) {
    // 已经合成成功时，存储空间不足或旧 WebView 的落库故障不应阻断本次播放。
    // 本轮继续使用内存 Blob；下次进入节目时至多重新合成这一章。
    cacheError = text(error?.message || error || 'audio-cache-failed', 240);
    console.warn('[radio] chapter audio cache skipped', error);
  }
  return {
    episode: saved,
    chapter: saved.chapters[index],
    payload,
    fromCache: false,
    cachePersisted: !cacheError,
    cacheError,
  };
}

export async function shareRadioEpisodeToChat(episodeId = '', { idempotencyKey = '' } = {}) {
  const episode = await getRadioEpisode(episodeId);
  if (!episode) throw new Error('没有找到这期节目');
  const chat = await ensurePrivateChat(
    episode.userId,
    episode.characterId,
    episode.characterName,
  );
  const deliveryKey = text(idempotencyKey, 120);
  if (deliveryKey) {
    const recent = await listMessagesForChat(chat.id, 500).catch(() => []);
    const existing = recent.find((item) => (
      item?.type === 'radioEpisode'
      && String(item?.metadata?.radioPlanId || '') === deliveryKey
    ));
    if (existing) return { chat, message: existing, alreadyShared: true };
  }
  const message = createMessage({
    chatId: chat.id,
    senderId: episode.characterId,
    senderName: episode.characterName,
    type: 'radioEpisode',
    content: episode.title,
    metadata: {
      aiGenerated: true,
      radioEpisodeId: episode.id,
      radioEpisodeType: episode.type,
      radioEpisodeTypeLabel: episode.typeLabel || radioEpisodeTypeLabel(episode.type),
      radioEpisodeTitle: episode.title,
      radioEpisodeSubtitle: episode.subtitle,
      radioEpisodeSummary: episode.summary,
      radioEpisodeChapters: episode.chapters.length,
      radioPlanId: deliveryKey,
    },
  });
  await saveMessage(message);
  await updateChatPreview(chat.id, `[电台] ${episode.title}`, message.timestamp);
  return { chat, message };
}

async function rememberRadioCreation(episode, chatId = '') {
  const knownBy = { [episode.characterId]: 'involved' };
  const contentMemory = [
    `${episode.characterName}制作了一期${episode.typeLabel || radioEpisodeTypeLabel(episode.type)}《${episode.title}》。`,
    episode.canonNotes.length ? `其中亲口补充的个人经历或自我认知：${episode.canonNotes.join('；')}` : '',
    episode.memorySummary,
  ].filter(Boolean).join(' ');
  await db.putRecord('eventMemories', createEventMemory({
    id: `event-radio-created-${episode.id}`,
    userId: episode.userId,
    summary: contentMemory,
    timestamp: episode.createdAt,
    knownBy,
    involvedChats: [chatId].filter(Boolean),
    tags: ['radio', 'radio-created', episode.type, ...episode.memoryKeywords],
    visibility: 'private',
  }));
}

async function rememberRadioListeningCompletion(episode) {
  const id = `event-radio-listened-${episode.id}`;
  if (await db.getRecord('eventMemories', id)) return;
  const chat = await findPrivateChat(episode.userId, episode.characterId).catch(() => null);
  await db.putRecord('eventMemories', createEventMemory({
    id,
    userId: episode.userId,
    summary: `用户听完了${episode.characterName}的电台节目《${episode.title}》。`,
    timestamp: Date.now(),
    knownBy: { [episode.characterId]: 'involved' },
    involvedChats: [chat?.id].filter(Boolean),
    highlight: episode.discussionHooks[0] || '',
    pendingThreads: episode.discussionHooks.slice(0, 2),
    tags: ['radio', 'radio-listened', episode.type],
    visibility: 'private',
  }));
}
