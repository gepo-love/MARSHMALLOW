import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters } from '../core/character-store.js';
import {
  RADIO_EPISODE_TYPES,
  continueRadioReadingSeries,
  deleteRadioEpisode,
  ensureRadioChapterAudio,
  generateRadioEpisode,
  getRadioEpisode,
  isRadioChapterAudioCurrent,
  loadRadioPlaybackPrefs,
  loadRadioUiPrefs,
  listRadioCustomTypes,
  listRadioPromptPresets,
  listRadioEpisodes,
  patchRadioEpisodeProgress,
  radioEpisodeTypeLabel,
  radioSoundMomentSeconds,
  saveRadioPromptPreset,
  saveRadioCustomType,
  saveRadioPlaybackPrefs,
  saveRadioUiPrefs,
  setRadioEpisodeCover,
  shareRadioEpisodeToChat,
  deleteRadioPromptPreset,
  deleteRadioCustomType,
  updateRadioEpisodeContent,
} from '../core/radio-episodes.js';
import { applyDisplayRegex, primeDisplayRegex } from '../core/display-regex.js';
import {
  bindNarrationTranslationToggle,
  renderNarrationTextWithTranslations,
} from '../core/narration-translation.js';
import {
  audioFromGestureOrNew,
  captureMediaGesture,
  playAudioWhenReady,
  takePlayableAudio,
} from '../core/media-playback.js';
import { stripVoiceDisplayTags } from '../core/voice-tools.js';
import {
  createSoundAssetPlayback,
  createSoundAssetPlaybackBlob,
  listSoundAssets,
  recordSoundAssetPlayback,
} from '../core/sound-library.js';
import {
  listAllWorldBookRows,
  listWorldBookRootOptions,
  normalizeWorldBookIds,
} from '../core/world-book-store.js';
import {
  createRadioPlan,
  listRadioPlans,
  updateRadioPlan,
} from '../core/radio-plans.js';
import { exportCachedVoiceSequence } from '../core/voice-audio-export.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return esc(value).replace(/'/g, '&#39;');
}

export function collectRadioEpisodeAudioExport(episode = null) {
  const chapters = Array.isArray(episode?.chapters) ? episode.chapters : [];
  const missingChapterNumbers = [];
  const segments = [];
  chapters.forEach((chapter, index) => {
    if (!isRadioChapterAudioCurrent(chapter)) {
      missingChapterNumbers.push(index + 1);
      return;
    }
    segments.push({
      payload: {
        audioBlob: chapter.audioBlob,
        format: String(chapter.audioType || chapter.audioBlob?.type || '').includes('wav') ? 'wav' : '',
      },
      gapBeforeMs: index > 0 ? 700 : 0,
    });
  });
  return { segments, missingChapterNumbers, totalChapters: chapters.length };
}

export function radioDisplayText(value = '') {
  const source = applyDisplayRegex(String(value || ''), 'radio')
    // 模型或自定义替换偶尔把停顿标签塞进了翻译括号开头。此时该段并非
    // 干净译文，先退回普通正文，避免自动展开后出现一排空「译」入口。
    .replace(/〔\s*(<#\d+(?:\.\d+)?#>[\s\S]*?)〕/giu, '$1')
    // 只有引号、句号等标点的括号不是译文，保留标点但不生成按钮。
    .replace(/〔\s*([^\p{L}\p{N}〔〕]+)\s*〕/gu, '$1');
  return stripVoiceDisplayTags(source);
}

function avatarUrl(character = {}) {
  if (typeof character.avatar === 'string') return character.avatar;
  return character.avatar?.url || character.avatar?.dataUrl || '';
}

function avatarHtml(character = {}, className = 'radio-avatar') {
  const src = avatarUrl(character) || character.characterAvatar || '';
  const name = character.name || character.characterName || '角色';
  return src
    ? `<span class="${className}"><span aria-hidden="true">${esc(String(name).slice(0, 1))}</span><img src="${escAttr(src)}" alt=""></span>`
    : `<span class="${className}"><span>${esc(String(name).slice(0, 1))}</span></span>`;
}

export function bindAvatarFallbacks(root) {
  root.querySelectorAll('.radio-character-avatar img, .radio-avatar img').forEach((image) => {
    const removeBrokenImage = () => image.remove();
    image.addEventListener('error', removeBrokenImage, { once: true });
    if (image.complete && image.naturalWidth <= 0) removeBrokenImage();
  });
}

function formatClock(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function formatDate(timestamp = 0) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function coverClass(type = '') {
  return `is-${String(type || 'bedtime').replace(/[^a-z]/g, '')}`;
}

function mainPlayGlyph(state = 'play') {
  const svgStyle = 'display:block;width:31px;height:31px;color:var(--radio-ink,#17191c);fill:currentColor;stroke:none';
  if (state === 'pause') {
    return `<svg class="radio-control-glyph is-pause" viewBox="0 0 32 32" aria-hidden="true" focusable="false" style="${svgStyle}"><rect x="8" y="6" width="6" height="20" rx="1" fill="currentColor"></rect><rect x="18" y="6" width="6" height="20" rx="1" fill="currentColor"></rect></svg>`;
  }
  return `<svg class="radio-control-glyph is-play" viewBox="0 0 32 32" aria-hidden="true" focusable="false" style="${svgStyle}"><path d="M10 6.5v19l15-9.5z" fill="currentColor"></path></svg>`;
}

export function paragraphList(text = '') {
  const source = String(text || '').trim();
  if (!source) return [];
  const blocks = source.split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;
  // 双语电台通常把一个完整外语自然段及其整段译文写成
  // “原文〔译文〕”。译文内部也有句号和问号，不能沿用普通正文的
  // 自动分段，否则会在 〔〕 中间截断，前端的容错修复随后会把前一句
  // 误认成完整译文，剩余中文便会裸露成正文。
  if (/[〔〕]/u.test(source)) return [source];
  const sentences = (source.match(/[^。！？!?]+[。！？!?]?/gu) || [source])
    .map((item) => item.trim())
    .filter(Boolean);
  if (sentences.length <= 2) return [sentences.join('')];
  const paragraphs = [];
  let paragraph = '';
  let sentenceCount = 0;
  for (const sentence of sentences) {
    paragraph += sentence;
    sentenceCount += 1;
    if ((paragraph.length >= 86 && sentenceCount >= 2) || sentenceCount >= 4) {
      paragraphs.push(paragraph);
      paragraph = '';
      sentenceCount = 0;
    }
  }
  if (paragraph) {
    if (paragraph.length < 48 && paragraphs.length) paragraphs[paragraphs.length - 1] += paragraph;
    else paragraphs.push(paragraph);
  }
  return paragraphs;
}

export function splitRadioParagraphByNarration(text = '', narrationBeats = []) {
  const source = String(text || '');
  const located = (Array.isArray(narrationBeats) ? narrationBeats : [])
    .map((beat) => ({ beat, offset: source.indexOf(String(beat?.anchor || '')) }))
    .filter((item) => item.offset >= 0 && item.beat?.anchor)
    .sort((left, right) => left.offset - right.offset);
  if (!located.length) return source ? [{ type: 'text', text: source }] : [];
  const parts = [];
  let cursor = 0;
  located.forEach(({ beat, offset }) => {
    if (offset < cursor) return;
    let end = offset + String(beat.anchor).length;
    // 双语正文的锚点只引用可朗读原文；视觉上先把紧随其后的完整译文
    // 留在同一小段，再插旁白，避免拆坏 〔译文〕 的折叠结构。
    const translation = source.slice(end).match(/^\s*〔[^〔〕]*〕/u)?.[0] || '';
    end += translation.length;
    const copy = source.slice(cursor, end).trim();
    if (copy) parts.push({ type: 'text', text: copy });
    parts.push({ type: 'narration', beat });
    cursor = end;
  });
  const tail = source.slice(cursor).trim();
  if (tail) parts.push({ type: 'text', text: tail });
  return parts;
}

const RADIO_READING_PREVIEW_LIMIT = 6000;

export function radioReadingSourcePreview(text = '', limit = RADIO_READING_PREVIEW_LIMIT) {
  const source = String(text || '');
  const safeLimit = Math.max(500, Math.floor(Number(limit || RADIO_READING_PREVIEW_LIMIT)));
  if (source.length <= safeLimit) return source;
  return `${source.slice(0, safeLimit)}\n\n……（全文已载入，页面仅显示开头预览）`;
}

export function radioTextLooksCorrupted(value = '') {
  const source = String(value || '');
  const replacements = (source.match(/\uFFFD/gu) || []).length;
  return replacements >= 3 && replacements / Math.max(1, source.length) >= 0.005;
}

/** TXT 下载站常见 GBK / GB18030；File.text() 固定按 UTF-8，会把原字节直接变成 U+FFFD 替换字符。 */
export function decodeRadioTextBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
  if (!bytes.length) return '';
  const decode = (label, source = bytes, options = {}) => (
    new TextDecoder(label, options).decode(source).replace(/^\uFEFF/u, '')
  );
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return decode('utf-8', bytes.subarray(3));
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return decode('utf-16le', bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return decode('utf-16be', bytes.subarray(2));
  try {
    return decode('utf-8', bytes, { fatal: true });
  } catch (_) {
    try {
      return decode('gb18030');
    } catch (_) {
      return decode('utf-8');
    }
  }
}

export function resolveRadioCreateCharacterId(characters = [], preferredIds = []) {
  const ids = new Set((Array.isArray(characters) ? characters : [])
    .map((character) => String(character?.id ?? '').trim())
    .filter(Boolean));
  for (const preferred of Array.isArray(preferredIds) ? preferredIds : [preferredIds]) {
    const id = String(preferred ?? '').trim();
    if (id && ids.has(id)) return id;
  }
  return String(characters?.[0]?.id ?? '').trim();
}

export function radioHomeBackUsesHistory(params = {}) {
  return !!String(params?.from || '').trim();
}

export default async function render(container, params = {}) {
  const exitRadioHome = () => {
    if (radioHomeBackUsesHistory(params)) back();
    else navigate('home', {}, true);
  };
  container.className = 'page radio-page';
  container.innerHTML = `
    <header class="radio-home-nav">
      <button type="button" class="radio-line-icon" data-back aria-label="返回">${icon('back')}</button>
      <h1>电台</h1>
      <span class="radio-create-entry" aria-hidden="true"></span>
    </header>
    <main class="radio-home-scroll">
      <section class="radio-list-empty" role="status">正在整理节目…</section>
    </main>
  `;
  container.querySelector('[data-back]')?.addEventListener('click', exitRadioHome);

  const user = await ensureDefaultUser();
  const [
    loadedCharacters,
    loadedEpisodes,
    loadedCustomTypes,
    loadedPromptPresets,
    loadedPlaybackPrefs,
    radioUiPrefs,
    loadedRadioPlans,
  ] = await Promise.all([
    listCharacters({
      excludeAnonNpc: true,
      userId: user.id,
      identityScoped: true,
    }).catch(() => []),
    listRadioEpisodes(user.id).catch(() => []),
    listRadioCustomTypes(user.id).catch(() => []),
    listRadioPromptPresets(user.id).catch(() => []),
    loadRadioPlaybackPrefs(user.id).catch(() => ({
      voiceVolume: 1,
      ambientVolume: 0.11,
      cueVolume: 0.4,
    })),
    loadRadioUiPrefs(user.id).catch(() => ({ lastCharacterId: '' })),
    listRadioPlans(user.id).catch(() => []),
    primeDisplayRegex().catch(() => null),
  ]);
  let characters = loadedCharacters;
  let episodes = loadedEpisodes;
  let customTypes = loadedCustomTypes;
  let promptPresets = loadedPromptPresets;
  let worldBookOptions = [];
  let worldBookOptionsLoading = null;
  let playbackPrefs = loadedPlaybackPrefs;
  let radioPlans = loadedRadioPlans;
  const availableCharacterIds = new Set(characters.map((character) => String(character?.id || '').trim()).filter(Boolean));
  const requestedCharacterId = String(params.characterId || '').trim();
  const rememberedCharacterId = String(radioUiPrefs.lastCharacterId || '').trim();
  let activeCharacterId = availableCharacterIds.has(requestedCharacterId)
    ? requestedCharacterId
    : (availableCharacterIds.has(rememberedCharacterId) ? rememberedCharacterId : '');
  let activeType = '';
  let createOpen = false;
  let creating = false;
  let continuingSeries = false;
  let continueMinutes = 0;
  let createType = 'bedtime';
  let createMinutes = 8;
  let createCharacterId = activeCharacterId;
  let createTopic = '';
  let createSourceText = '';
  let createSourceName = '';
  let createSourcePreviewOnly = false;
  let createCustomPrompt = '';
  let createWorldBookIds = [];
  let createActionMode = 'hidden';
  let createAmbientEnabled = true;
  let coverUrls = new Map();
  let currentAudio = null;
  let currentAudioUrl = '';
  let ambientPlaybacks = [];
  let momentSoundPool = new Map();
  let momentAudios = new Set();
  let momentPlaybackEpoch = 0;
  let playedSoundMoments = new Set();
  let lastMomentAssetByCategory = new Map();
  let lastMomentTime = 0;
  const momentSlot = { gesture: null, audio: null };
  let cueAudioContext = null;
  let cueCompressor = null;
  const cueBufferCache = new Map();
  let currentEpisode = null;
  let currentChapterIndex = 0;
  let synthesizingChapterIndex = -1;
  let progressSaveAt = 0;
  let playbackPrefsSaveTimer = 0;
  let destroyed = false;
  let releasePlaybackCritical = null;
  let playbackRiskToken = '';
  const voiceSlot = { gesture: null, audio: null };

  if (activeCharacterId && activeCharacterId !== rememberedCharacterId) {
    void saveRadioUiPrefs(user.id, { lastCharacterId: activeCharacterId }).catch(() => {});
  }

  const releaseCoverUrls = () => {
    coverUrls.forEach((url) => { try { URL.revokeObjectURL(url); } catch (_) {} });
    coverUrls = new Map();
  };

  const coverUrl = (episode) => {
    if (typeof episode?.coverDataUrl === 'string' && episode.coverDataUrl.startsWith('data:image/')) {
      return episode.coverDataUrl;
    }
    if (!(episode?.coverBlob instanceof Blob) || !episode.coverBlob.size) return '';
    if (!coverUrls.has(episode.id)) coverUrls.set(episode.id, URL.createObjectURL(episode.coverBlob));
    return coverUrls.get(episode.id) || '';
  };

  const coverStyle = (episode) => {
    const url = coverUrl(episode);
    return url ? ` style="--radio-cover:url('${escAttr(url)}');--radio-cover-position:${escAttr(episode.coverPosition || '50% 50%')}"` : '';
  };

  const stopMomentPlayback = () => {
    momentPlaybackEpoch += 1;
    momentAudios.forEach((item) => {
      try {
        item.source?.stop?.();
        item.audio?.pause?.();
      } catch (_) {}
      item.revoke?.();
    });
    momentAudios = new Set();
  };

  function resolveCueGain(asset = null) {
    const globalGain = Math.max(0, Math.min(1, Number(playbackPrefs.cueVolume) || 0));
    const assetGain = Math.max(0.5, Math.min(2, Number(asset?.mixGain || 1) || 1));
    // Web Audio 的 GainNode 可以真正把低电平素材推到 1 以上，后方压缩器负责收峰；
    // 旧 HTMLAudioElement.volume 只能到 1，“强增强”对安静素材几乎没有作用。
    return Math.max(0, Math.min(2.4, globalGain * assetGain * 1.55));
  }

  function ensureCueAudioContext() {
    if (cueAudioContext && cueAudioContext.state !== 'closed') return cueAudioContext;
    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof AudioContextCtor !== 'function') return null;
    try {
      cueAudioContext = new AudioContextCtor();
      cueCompressor = cueAudioContext.createDynamicsCompressor();
      cueCompressor.threshold.value = -10;
      cueCompressor.knee.value = 14;
      cueCompressor.ratio.value = 6;
      cueCompressor.attack.value = 0.004;
      cueCompressor.release.value = 0.2;
      cueCompressor.connect(cueAudioContext.destination);
      return cueAudioContext;
    } catch (_) {
      cueAudioContext = null;
      cueCompressor = null;
      return null;
    }
  }

  function primeCueAudioContext() {
    const context = ensureCueAudioContext();
    if (context?.state === 'suspended') void context.resume().catch(() => {});
  }

  function decodeCueAsset(asset = null) {
    const key = String(asset?.id || '');
    if (!key) return Promise.resolve(null);
    if (cueBufferCache.has(key)) return cueBufferCache.get(key);
    const context = ensureCueAudioContext();
    const blob = createSoundAssetPlaybackBlob(asset);
    if (!context || !blob?.size) return Promise.resolve(null);
    const pending = blob.arrayBuffer()
      .then((bytes) => new Promise((resolve, reject) => {
        let settled = false;
        const done = (buffer) => {
          if (settled) return;
          settled = true;
          resolve(buffer);
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        try {
          const result = context.decodeAudioData(bytes.slice(0), done, fail);
          if (result?.then) result.then(done, fail);
        } catch (error) { fail(error); }
      }))
      .catch(() => null);
    cueBufferCache.set(key, pending);
    return pending;
  }

  function applyMediaVolume(audio, value = 1) {
    if (!audio) return;
    const volume = Math.max(0, Math.min(1, Number(value) || 0));
    // 部分 iOS / WebView 会忽略 HTMLMediaElement.volume，但仍遵守 muted。
    // 0% 必须是真正的硬静音，不能只依赖设备可能忽略的音量属性。
    audio.muted = volume <= 0;
    try { audio.volume = volume; } catch (_) {}
  }

  function applyPlaybackVolumes() {
    applyMediaVolume(currentAudio, playbackPrefs.voiceVolume);
    const ambientScale = ambientPlaybacks.length > 1 ? 0.72 : 1;
    ambientPlaybacks.forEach((item) => {
      applyMediaVolume(
        item.audio,
        playbackPrefs.ambientVolume * Number(item.asset?.mixGain || 1) * ambientScale,
      );
    });
    momentAudios.forEach((item) => {
      if (item?.gain?.gain) item.gain.gain.value = resolveCueGain(item.asset);
      else applyMediaVolume(item?.audio, resolveCueGain(item.asset));
    });
  }

  function schedulePlaybackPrefsSave() {
    if (playbackPrefsSaveTimer) window.clearTimeout(playbackPrefsSaveTimer);
    playbackPrefsSaveTimer = window.setTimeout(async () => {
      playbackPrefsSaveTimer = 0;
      playbackPrefs = await saveRadioPlaybackPrefs(user.id, playbackPrefs).catch(() => playbackPrefs);
    }, 180);
  }

  function beginPlaybackGuard() {
    if (!releasePlaybackCritical && typeof globalThis.__mm_begin_critical_activity__ === 'function') {
      releasePlaybackCritical = globalThis.__mm_begin_critical_activity__('radio-playback');
    }
    if (!playbackRiskToken && typeof globalThis.__mm_mark_risky_activity__ === 'function') {
      playbackRiskToken = globalThis.__mm_mark_risky_activity__('radio-playback', {
        episodeId: currentEpisode?.id || '',
        chapterIndex: currentChapterIndex,
      });
    }
  }

  function endPlaybackGuard() {
    releasePlaybackCritical?.();
    releasePlaybackCritical = null;
    if (playbackRiskToken && typeof globalThis.__mm_clear_risky_activity__ === 'function') {
      globalThis.__mm_clear_risky_activity__(playbackRiskToken);
    }
    playbackRiskToken = '';
  }

  function stopPlayback({ clearAmbient = true } = {}) {
    if (currentAudio) {
      try { currentAudio.pause(); } catch (_) {}
    }
    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch (_) {}
      currentAudioUrl = '';
    }
    currentAudio = null;
    if (clearAmbient) {
      ambientPlaybacks.forEach((item) => {
        try {
          item.audio.pause();
          item.audio.removeAttribute('src');
          item.audio.load?.();
        } catch (_) {}
        item.revoke?.();
      });
      ambientPlaybacks = [];
    } else {
      ambientPlaybacks.forEach((item) => item.audio.pause());
    }
    stopMomentPlayback();
    momentSoundPool = new Map();
    playedSoundMoments = new Set();
    lastMomentTime = 0;
    endPlaybackGuard();
    if (clearAmbient) {
      momentSlot.gesture?.dispose?.();
      momentSlot.gesture = null;
      if (momentSlot.audio) {
        try {
          momentSlot.audio.pause();
          momentSlot.audio.removeAttribute('src');
          momentSlot.audio.load?.();
        } catch (_) {}
        momentSlot.audio = null;
      }
    }
  }

  const filteredEpisodes = () => episodes.filter((episode) => (
    (!activeCharacterId || String(episode.characterId) === activeCharacterId)
    && (!activeType || episode.type === activeType)
  ));

  const radioCreateTypes = () => [...RADIO_EPISODE_TYPES, ...customTypes];

  const loadWorldBookOptions = () => {
    if (worldBookOptions.length) return Promise.resolve(worldBookOptions);
    if (!worldBookOptionsLoading) {
      worldBookOptionsLoading = listAllWorldBookRows()
        .then((rows) => {
          worldBookOptions = listWorldBookRootOptions(rows);
          return worldBookOptions;
        })
        .catch(() => []);
    }
    return worldBookOptionsLoading;
  };

  // 已删除的自定义类型仍可能被历史节目引用：筛选栏保留它，方便找到旧节目；
  // 但制作弹窗不能再把它当作可选类型复活。
  const radioFilterTypes = () => {
    const rows = [...RADIO_EPISODE_TYPES, ...customTypes];
    for (const episode of episodes) {
      if (!episode.typeLabel || rows.some((row) => row.id === episode.type)) continue;
      rows.push({ id: episode.type, label: episode.typeLabel, hint: episode.typeHint || '' });
    }
    return rows;
  };

  const episodeTypeLabel = (episode) => (
    episode?.typeLabel || radioEpisodeTypeLabel(episode?.type)
  );

  const characterForEpisode = (episode) => (
    characters.find((character) => String(character.id) === String(episode?.characterId)) || episode
  );

  function episodeRowHtml(episode, index = 0) {
    const progress = episode.progress || {};
    const completion = progress.completed
      ? '已听完'
      : (progress.updatedAt ? `听到第 ${Number(progress.chapterIndex || 0) + 1} 章` : `${episode.chapters.length} 章`);
    return `
      <div class="radio-episode-swipe" data-episode-swipe="${escAttr(episode.id)}">
        <button type="button" class="radio-episode-delete" data-swipe-delete="${escAttr(episode.id)}" aria-label="删除《${escAttr(episode.title)}》">删除</button>
        <button type="button" class="radio-episode-row" data-episode-id="${escAttr(episode.id)}">
        <span class="radio-episode-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="radio-episode-thumb ${coverClass(episode.type)}"${coverStyle(episode)}></span>
        <span class="radio-episode-copy">
          <small>${esc(episode.characterName)} · ${episode.readingSeries ? `${esc(episode.readingSeries.title || episode.readingSeries.sourceName)} · 第 ${episode.readingSeries.partNumber} 期` : esc(episodeTypeLabel(episode))}</small>
          <strong>${esc(radioDisplayText(episode.title))}</strong>
          <span>${esc(radioDisplayText(episode.subtitle || episode.summary))}</span>
          <em>${esc(completion)} · ${esc(formatDate(episode.updatedAt))}</em>
        </span>
        <span class="radio-episode-arrow" aria-hidden="true">↗</span>
        </button>
      </div>`;
  }

  function filterHtml() {
    const usedIds = new Set(episodes.map((episode) => String(episode.characterId || '')));
    const visibleCharacters = characters.filter((character) => {
      const id = String(character.id || '');
      return usedIds.has(id) || id === activeCharacterId;
    }).slice(0, 8);
    return `
      <div class="radio-character-filter" aria-label="按角色筛选">
        <button type="button" class="radio-character-all ${activeCharacterId ? '' : 'is-active'}" data-character-filter="">全部</button>
        ${visibleCharacters.map((character) => `
          <button type="button" class="radio-character-chip ${activeCharacterId === String(character.id) ? 'is-active' : ''}" data-character-filter="${escAttr(String(character.id))}" aria-label="${escAttr(character.name)}">
            ${avatarHtml(character, 'radio-character-avatar')}
            <span>${esc(character.name)}</span>
          </button>`).join('')}
      </div>`;
  }

  function typeFilterHtml() {
    return `<div class="radio-type-filter" role="group" aria-label="节目类型">
      <button type="button" class="${activeType ? '' : 'is-active'}" data-type-filter="" aria-pressed="${activeType ? 'false' : 'true'}">全部节目</button>
      ${radioFilterTypes().map((type) => `<button type="button" class="${activeType === type.id ? 'is-active' : ''}" data-type-filter="${escAttr(type.id)}" aria-pressed="${activeType === type.id ? 'true' : 'false'}">${esc(type.label)}</button>`).join('')}
    </div>`;
  }

  function createSheetHtml() {
    if (!createOpen) return '';
    const selectable = resolveRadioCreateCharacterId(characters, [createCharacterId, activeCharacterId]);
    return `
      <div class="radio-create-layer" data-create-layer>
        <button type="button" class="radio-create-backdrop" data-create-close aria-label="关闭"></button>
        <section class="radio-create-sheet" role="dialog" aria-modal="true" aria-label="制作节目">
          <header>
            <div><small>NEW EPISODE</small><h2>制作一期节目</h2></div>
            <button type="button" class="radio-line-icon" data-create-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="radio-create-scroll">
            <label class="radio-create-field">
              <span>由谁来讲</span>
              <select data-create-character ${creating ? 'disabled' : ''}>
                ${characters.map((character) => `<option value="${escAttr(String(character.id))}" ${String(character.id) === selectable ? 'selected' : ''}>${esc(character.name)}</option>`).join('')}
              </select>
            </label>
            <fieldset class="radio-create-types" ${creating ? 'disabled' : ''}>
              <legend>节目类型</legend>
              ${radioCreateTypes().map((type) => `
                <span class="radio-create-type-row">
                  <button type="button" class="radio-create-type ${createType === type.id ? 'is-active' : ''}" data-create-type="${type.id}">
                    <strong>${esc(type.label)}</strong><span>${esc(type.hint)}</span>
                  </button>
                  ${String(type.id).startsWith('custom-') && customTypes.some((item) => item.id === type.id)
                    ? `<button type="button" class="radio-custom-type-delete" data-custom-type-delete="${escAttr(type.id)}" aria-label="删除自定义类型 ${escAttr(type.label)}">×</button>`
                    : ''}
                </span>`).join('')}
              <div class="radio-custom-type-add">
                <input type="text" maxlength="32" data-custom-type-label placeholder="添加类型名称" aria-label="新电台类型名称">
                <input type="text" maxlength="100" data-custom-type-hint placeholder="这个类型怎么讲" aria-label="新电台类型方向">
                <button type="button" data-custom-type-save>添加</button>
              </div>
            </fieldset>
            <label class="radio-create-field">
              <span>今晚讲什么</span>
              <textarea data-create-topic rows="3" placeholder="留空也可以，让角色自己决定" ${creating ? 'disabled' : ''}>${esc(createTopic)}</textarea>
            </label>
            <div class="radio-create-field radio-import-field ${createType === 'reading' ? 'is-visible' : ''}">
              <span>导入来稿</span>
              <div class="radio-import-tools">
                <label class="radio-text-file">选择 TXT<input type="file" accept=".txt,text/plain" data-create-source-file hidden ${creating ? 'disabled' : ''}></label>
                <small>${createSourceName ? `${esc(createSourceName)} · ${createSourceText.length.toLocaleString()} 字${createSourcePreviewOnly ? ' · 仅预览开头' : ''}` : (createSourceText ? `${createSourceText.length.toLocaleString()} 字` : '')}</small>
                ${createSourceText || createSourceName ? `<button type="button" class="radio-source-clear" data-create-source-clear ${creating ? 'disabled' : ''}>清空</button>` : ''}
              </div>
              <textarea data-create-source rows="6" maxlength="4000000" placeholder="选择 TXT，或在这里粘贴来稿" ${createSourcePreviewOnly ? 'readonly aria-label="来稿开头预览，生成时使用完整文件"' : ''} ${creating ? 'disabled' : ''}>${esc(createSourcePreviewOnly ? radioReadingSourcePreview(createSourceText) : createSourceText)}</textarea>
            </div>
            ${worldBookOptions.length ? `
              <details class="radio-create-worldbooks" ${createWorldBookIds.length ? 'open' : ''}>
                <summary><span>本期世界书${createWorldBookIds.length ? ` · 仅所选 ${createWorldBookIds.length} 本` : ' · 默认规则'}</span><i aria-hidden="true">＋</i></summary>
                <div class="radio-worldbook-picks">
                  ${worldBookOptions.map((book) => `
                    <label>
                      <input type="checkbox" data-create-worldbook-id="${escAttr(book.id)}" ${createWorldBookIds.includes(book.id) ? 'checked' : ''} ${creating ? 'disabled' : ''}>
                      <span>${esc(book.name)}</span>
                    </label>`).join('')}
                </div>
              </details>` : ''}
            <details class="radio-create-advanced">
              <summary><span>自定义生成提示词</span><i aria-hidden="true">＋</i></summary>
              <div class="radio-prompt-preset-row">
                <select data-create-prompt-preset aria-label="提示词预设">
                  <option value="">选择预设</option>
                  ${promptPresets.map((preset) => `<option value="${escAttr(preset.id)}">${esc(preset.name)}</option>`).join('')}
                </select>
                <button type="button" data-create-prompt-apply>套用</button>
                <button type="button" data-create-prompt-delete aria-label="删除所选提示词预设">删除</button>
              </div>
              <textarea data-create-custom-prompt rows="5" aria-label="自定义生成提示词" placeholder="例如：少用抒情比喻，多讲具体细节；像深夜随口说起，不要总结。" ${creating ? 'disabled' : ''}>${esc(createCustomPrompt)}</textarea>
              <div class="radio-prompt-save-row">
                <input type="text" data-create-prompt-name maxlength="40" placeholder="预设名称">
                <button type="button" data-create-prompt-save>保存为预设</button>
              </div>
            </details>
            <fieldset class="radio-action-choice" ${creating ? 'disabled' : ''}>
              <legend>讲述间的小动作</legend>
              ${[
                ['visible', '显示动描', '显示角色换姿势、翻页等小动作，并匹配声音'],
                ['hidden', '只听动静', '不显示动作文字，只在合适的位置加入小声音'],
                ['off', '纯净讲述', '不安排额外动作与动作音'],
              ].map(([id, label, hint]) => `<button type="button" class="${createActionMode === id ? 'is-active' : ''}" data-create-action-mode="${id}"><strong>${label}</strong><span>${hint}</span></button>`).join('')}
            </fieldset>
            <label class="radio-ambient-toggle">
              <input type="checkbox" data-create-ambient ${createAmbientEnabled ? 'checked' : ''} ${creating ? 'disabled' : ''}>
              <span><strong>连续环境背景音</strong><small>只使用音频库里已有且与场景吻合的素材</small></span>
            </label>
            <fieldset class="radio-duration-choice" ${creating ? 'disabled' : ''}>
              <legend>预计长度</legend>
              ${[5, 8, 15].map((minutes) => `<button type="button" class="${createMinutes === minutes ? 'is-active' : ''}" data-create-minutes="${minutes}">${minutes} 分钟</button>`).join('')}
            </fieldset>
          </div>
          <footer>
            <span>${creating ? '角色正在写稿，完成后会自动进入节目…' : '先生成文字稿，语音按章节在收听时缓存'}</span>
            <button type="button" class="radio-create-submit" data-create-submit ${creating || !characters.length ? 'disabled' : ''}>
              ${creating ? '<i></i>正在制作' : '开始制作'}
            </button>
          </footer>
        </section>
      </div>`;
  }

  function renderHome() {
    stopPlayback();
    currentEpisode = null;
    const list = filteredEpisodes();
    const continued = list.find((episode) => episode.progress?.updatedAt && !episode.progress?.completed)
      || list[0]
      || null;
    const heroChapter = continued?.chapters?.[continued.progress?.chapterIndex || 0];
    container.innerHTML = `
      <header class="radio-home-nav">
        <button type="button" class="radio-line-icon" data-back aria-label="返回">${icon('back')}</button>
        <h1>电台</h1>
        <button type="button" class="radio-create-entry" data-create-open><span>新节目</span><b aria-hidden="true">＋</b></button>
      </header>
      <main class="radio-home-scroll">
        ${filterHtml()}
        ${continued ? `
          <section class="radio-hero ${coverClass(continued.type)}"${coverStyle(continued)}>
            <button type="button" class="radio-hero-open" data-episode-id="${escAttr(continued.id)}" aria-label="打开 ${escAttr(continued.title)}"></button>
            <div class="radio-hero-caption">
              <small>${continued.progress?.updatedAt ? '继续收听' : episodeTypeLabel(continued)}</small>
              <h2>${esc(radioDisplayText(continued.title))}</h2>
              <p>${esc(radioDisplayText(continued.subtitle || continued.summary))}</p>
            </div>
            <div class="radio-continue-paper">
              ${avatarHtml(characterForEpisode(continued))}
              <span><small>${esc(continued.characterName)} · 第 ${Number(continued.progress?.chapterIndex || 0) + 1} 章</small><strong>${esc(heroChapter?.title || '开始收听')}</strong></span>
              <i><b style="width:${continued.progress?.completed ? 100 : Math.max(8, Math.min(92, ((continued.progress?.chapterIndex || 0) / Math.max(1, continued.chapters.length)) * 100))}%"></b></i>
              <em>▶</em>
            </div>
          </section>` : `
          <section class="radio-empty-hero">
            <small>CHARACTER RADIO</small>
            <h2>让一个声音，<br>慢慢讲完一件事。</h2>
            <p>故事、往事、深夜自白或一篇来稿。</p>
            <button type="button" data-create-open>制作第一期</button>
          </section>`}
        <section class="radio-library-head">
          <div><small>ARCHIVE</small><h2>${activeCharacterId ? `${esc(characters.find((item) => String(item.id) === activeCharacterId)?.name || '')}的节目` : '往期节目'}</h2></div>
          <span>${list.length} 期</span>
        </section>
        ${typeFilterHtml()}
        <section class="radio-episode-list">
          ${list.length ? list.map(episodeRowHtml).join('') : '<div class="radio-list-empty">这个分类还没有节目。</div>'}
        </section>
      </main>
      ${createSheetHtml()}
    `;
    bindAvatarFallbacks(container);
    const characterFilter = container.querySelector('.radio-character-filter');
    const activeCharacterChip = characterFilter?.querySelector('.radio-character-chip.is-active');
    if (characterFilter && activeCharacterChip) {
      characterFilter.scrollLeft = Math.max(0, activeCharacterChip.offsetLeft
        - ((characterFilter.clientWidth - activeCharacterChip.offsetWidth) / 2));
    }
    const typeFilter = container.querySelector('.radio-type-filter');
    const activeTypeButton = typeFilter?.querySelector('.is-active');
    if (typeFilter && activeTypeButton) {
      typeFilter.scrollLeft = Math.max(0, activeTypeButton.offsetLeft
        - ((typeFilter.clientWidth - activeTypeButton.offsetWidth) / 2));
    }
    bindHome();
  }

  function bindHome() {
    const rememberCreateDraft = () => {
      createCharacterId = container.querySelector('[data-create-character]')?.value || createCharacterId;
      createTopic = container.querySelector('[data-create-topic]')?.value || '';
      if (!createSourcePreviewOnly) createSourceText = container.querySelector('[data-create-source]')?.value || '';
      createCustomPrompt = container.querySelector('[data-create-custom-prompt]')?.value || '';
      createWorldBookIds = normalizeWorldBookIds([...container.querySelectorAll('[data-create-worldbook-id]:checked')]
        .map((input) => input.getAttribute('data-create-worldbook-id') || ''));
      createAmbientEnabled = container.querySelector('[data-create-ambient]')?.checked !== false;
    };
    container.querySelector('[data-back]')?.addEventListener('click', exitRadioHome);
    container.querySelectorAll('[data-create-open]').forEach((button) => button.addEventListener('click', () => {
      createCharacterId = resolveRadioCreateCharacterId(characters, [activeCharacterId, createCharacterId]);
      createOpen = true;
      renderHome();
      void loadWorldBookOptions().then(() => {
        if (createOpen && !destroyed) renderHome();
      });
    }));
    container.querySelectorAll('[data-create-close]').forEach((button) => button.addEventListener('click', () => {
      if (creating) return;
      createOpen = false;
      renderHome();
    }));
    container.querySelectorAll('[data-character-filter]').forEach((button) => button.addEventListener('click', () => {
      activeCharacterId = button.getAttribute('data-character-filter') || '';
      if (activeCharacterId) createCharacterId = activeCharacterId;
      void saveRadioUiPrefs(user.id, { lastCharacterId: activeCharacterId }).catch(() => {});
      renderHome();
    }));
    container.querySelector('[data-create-character]')?.addEventListener('change', (event) => {
      createCharacterId = String(event.target.value || '').trim();
      if (createCharacterId) {
        void saveRadioUiPrefs(user.id, { lastCharacterId: createCharacterId }).catch(() => {});
      }
    });
    container.querySelectorAll('[data-type-filter]').forEach((button) => button.addEventListener('click', () => {
      activeType = button.getAttribute('data-type-filter') || '';
      renderHome();
    }));
    container.querySelectorAll('[data-episode-id]').forEach((button) => button.addEventListener('click', () => {
      const swipe = button.closest('[data-episode-swipe]');
      if (swipe?.dataset.suppressClick === '1') {
        swipe.dataset.suppressClick = '0';
        return;
      }
      if (swipe?.classList.contains('is-open')) {
        swipe.classList.remove('is-open');
        return;
      }
      navigate('radio', { id: button.getAttribute('data-episode-id') || '' });
    }));
    container.querySelectorAll('[data-episode-swipe]').forEach((swipe) => {
      const row = swipe.querySelector('.radio-episode-row');
      const deleteButton = swipe.querySelector('.radio-episode-delete');
      if (!row) return;
      let startX = 0;
      let startY = 0;
      let deltaX = 0;
      let horizontal = false;
      row.addEventListener('touchstart', (event) => {
        const touch = event.touches?.[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
        deltaX = 0;
        horizontal = false;
        swipe.classList.add('is-dragging');
      }, { passive: true });
      row.addEventListener('touchmove', (event) => {
        const touch = event.touches?.[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (!horizontal && Math.abs(dx) > 7 && Math.abs(dx) > Math.abs(dy)) horizontal = true;
        if (!horizontal) return;
        event.preventDefault();
        const origin = swipe.classList.contains('is-open') ? -78 : 0;
        deltaX = Math.min(0, Math.max(-78, origin + dx));
        row.style.transform = `translateX(${deltaX}px)`;
      }, { passive: false });
      row.addEventListener('touchend', () => {
        swipe.classList.remove('is-dragging');
        row.style.transform = '';
        if (!horizontal) return;
        swipe.dataset.suppressClick = '1';
        swipe.classList.toggle('is-open', deltaX <= -38);
      }, { passive: true });
      row.addEventListener('touchcancel', () => {
        swipe.classList.remove('is-dragging');
        row.style.transform = '';
      }, { passive: true });
      deleteButton?.addEventListener('focus', () => swipe.classList.add('is-open'));
    });
    container.querySelectorAll('[data-swipe-delete]').forEach((button) => button.addEventListener('click', async () => {
      const id = button.getAttribute('data-swipe-delete') || '';
      const episode = episodes.find((item) => item.id === id);
      if (!episode || !window.confirm(`删除《${episode.title}》？`)) return;
      try {
        await deleteRadioEpisode(id, { userId: user.id });
        episodes = episodes.filter((item) => item.id !== id);
        renderHome();
        showToast('节目已删除');
      } catch (error) {
        showToast(error?.message || '节目删除失败');
      }
    }));
    container.querySelectorAll('[data-create-type]').forEach((button) => button.addEventListener('click', () => {
      createType = button.getAttribute('data-create-type') || 'bedtime';
      rememberCreateDraft();
      renderHome();
    }));
    container.querySelector('[data-custom-type-save]')?.addEventListener('click', async () => {
      const label = container.querySelector('[data-custom-type-label]')?.value || '';
      const hint = container.querySelector('[data-custom-type-hint]')?.value || '';
      try {
        rememberCreateDraft();
        const saved = await saveRadioCustomType(user.id, { label, hint });
        customTypes = await listRadioCustomTypes(user.id);
        createType = saved.id;
        renderHome();
        showToast(`已保存「${saved.label}」`);
      } catch (error) {
        showToast(error?.message || '类型保存失败');
      }
    });
    container.querySelectorAll('[data-custom-type-delete]').forEach((button) => button.addEventListener('click', async () => {
      const id = button.getAttribute('data-custom-type-delete') || '';
      const type = customTypes.find((item) => item.id === id);
      if (!type || !window.confirm(`删除自定义类型“${type.label}”？已生成的节目不会删除。`)) return;
      rememberCreateDraft();
      customTypes = await deleteRadioCustomType(user.id, id);
      if (createType === id) createType = 'bedtime';
      if (activeType === id && !episodes.some((episode) => episode.type === id)) activeType = '';
      renderHome();
      showToast('自定义类型已删除');
    }));
    container.querySelector('[data-create-character]')?.addEventListener('change', (event) => {
      createCharacterId = event.currentTarget.value || '';
    });
    container.querySelector('[data-create-topic]')?.addEventListener('input', (event) => {
      createTopic = event.currentTarget.value || '';
    });
    container.querySelector('[data-create-source]')?.addEventListener('input', (event) => {
      createSourceText = event.currentTarget.value || '';
      createSourcePreviewOnly = false;
      if (!createSourceName && createSourceText) createSourceName = '粘贴来稿';
    });
    container.querySelector('[data-create-source-file]')?.addEventListener('change', async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      if (!/\.txt$/iu.test(String(file.name || '')) && String(file.type || '') !== 'text/plain') {
        showToast('请选择 TXT 文本文件');
        return;
      }
      if (Number(file.size || 0) > 4 * 1024 * 1024) {
        showToast('TXT 文件请控制在 4 MB 以内');
        return;
      }
      try {
        const content = decodeRadioTextBytes(await file.arrayBuffer());
        if (!content.trim()) return showToast('TXT 文件里没有可读取的文字');
        if (radioTextLooksCorrupted(content)) {
          return showToast('TXT 原文编码或内容已损坏，请清空后换一个文件');
        }
        createSourceText = content;
        createSourceName = file.name || '未命名来稿.txt';
        createSourcePreviewOnly = content.length > RADIO_READING_PREVIEW_LIMIT;
        renderHome();
        showToast(createSourcePreviewOnly ? '全文已载入，页面仅显示开头预览' : '来稿已载入');
      } catch (_) {
        showToast('TXT 文件读取失败');
      }
    });
    container.querySelector('[data-create-source-clear]')?.addEventListener('click', () => {
      createSourceText = '';
      createSourceName = '';
      createSourcePreviewOnly = false;
      renderHome();
      showToast('来稿已清空');
    });
    container.querySelector('[data-create-custom-prompt]')?.addEventListener('input', (event) => {
      createCustomPrompt = event.currentTarget.value || '';
    });
    container.querySelectorAll('[data-create-worldbook-id]').forEach((input) => input.addEventListener('change', () => {
      createWorldBookIds = normalizeWorldBookIds([...container.querySelectorAll('[data-create-worldbook-id]:checked')]
        .map((item) => item.getAttribute('data-create-worldbook-id') || ''));
    }));
    container.querySelectorAll('[data-create-minutes]').forEach((button) => button.addEventListener('click', () => {
      createMinutes = Number(button.getAttribute('data-create-minutes') || 8);
      container.querySelectorAll('[data-create-minutes]').forEach((item) => item.classList.toggle('is-active', item === button));
    }));
    container.querySelectorAll('[data-create-action-mode]').forEach((button) => button.addEventListener('click', () => {
      createActionMode = button.getAttribute('data-create-action-mode') || 'hidden';
      container.querySelectorAll('[data-create-action-mode]').forEach((item) => item.classList.toggle('is-active', item === button));
    }));
    container.querySelector('[data-create-ambient]')?.addEventListener('change', (event) => {
      createAmbientEnabled = event.currentTarget.checked;
    });
    container.querySelector('[data-create-prompt-apply]')?.addEventListener('click', () => {
      const id = container.querySelector('[data-create-prompt-preset]')?.value || '';
      const preset = promptPresets.find((item) => item.id === id);
      if (!preset) return showToast('先选择一个提示词预设');
      const textarea = container.querySelector('[data-create-custom-prompt]');
      if (textarea) textarea.value = preset.prompt;
      createCustomPrompt = preset.prompt;
      showToast(`已套用「${preset.name}」`);
    });
    container.querySelector('[data-create-prompt-save]')?.addEventListener('click', async () => {
      const prompt = container.querySelector('[data-create-custom-prompt]')?.value || '';
      const name = container.querySelector('[data-create-prompt-name]')?.value || '';
      try {
        const saved = await saveRadioPromptPreset(user.id, { name, prompt });
        createCharacterId = container.querySelector('[data-create-character]')?.value || createCharacterId;
        createTopic = container.querySelector('[data-create-topic]')?.value || '';
        if (!createSourcePreviewOnly) createSourceText = container.querySelector('[data-create-source]')?.value || '';
        createCustomPrompt = saved.prompt;
        promptPresets = await listRadioPromptPresets(user.id);
        renderHome();
        showToast(`已保存「${saved.name}」`);
      } catch (error) {
        showToast(error?.message || '保存失败');
      }
    });
    container.querySelector('[data-create-prompt-delete]')?.addEventListener('click', async () => {
      const id = container.querySelector('[data-create-prompt-preset]')?.value || '';
      const preset = promptPresets.find((item) => item.id === id);
      if (!preset) return showToast('先选择一个提示词预设');
      if (!window.confirm(`删除提示词预设“${preset.name}”？`)) return;
      promptPresets = await deleteRadioPromptPreset(user.id, id);
      renderHome();
      showToast('预设已删除');
    });
    container.querySelector('[data-create-submit]')?.addEventListener('click', async () => {
      const characterId = container.querySelector('[data-create-character]')?.value || '';
      const topic = container.querySelector('[data-create-topic]')?.value || '';
      const sourceText = createSourcePreviewOnly
        ? createSourceText
        : (container.querySelector('[data-create-source]')?.value || '');
      const customPrompt = container.querySelector('[data-create-custom-prompt]')?.value || '';
      const worldBookIds = normalizeWorldBookIds([...container.querySelectorAll('[data-create-worldbook-id]:checked')]
        .map((input) => input.getAttribute('data-create-worldbook-id') || ''));
      if (!characterId) return showToast('先选择一位角色');
      if (createType === 'reading' && !String(sourceText).trim()) return showToast('来稿夜读需要先选择 TXT 或粘贴文本');
      createCharacterId = characterId;
      createTopic = topic;
      createSourceText = sourceText;
      createCustomPrompt = customPrompt;
      createWorldBookIds = worldBookIds;
      creating = true;
      renderHome();
      try {
        const selectedType = radioCreateTypes().find((item) => item.id === createType);
        const episode = await generateRadioEpisode({
          user,
          characterId,
          type: createType,
          typeLabel: selectedType?.label || '',
          typeHint: selectedType?.hint || '',
          topic,
          sourceText,
          sourceName: createSourceName,
          customPrompt,
          worldBookIds,
          actionMode: createActionMode,
          ambientEnabled: createAmbientEnabled,
          minutes: createMinutes,
        });
        episodes = await listRadioEpisodes(user.id);
        createOpen = false;
        creating = false;
        navigate('radio', { id: episode.id }, true);
      } catch (error) {
        creating = false;
        showToast(`节目制作失败：${error?.message || error}`, 5200);
        renderHome();
      }
    });
  }

  function renderTranscript(episode, chapterIndex) {
    const chapter = episode.chapters[chapterIndex];
    const narrationBeats = episode.actionMode === 'visible' && chapter?.narrationBeats?.length
      ? chapter.narrationBeats
      : (episode.actionMode === 'visible' ? (chapter?.soundMoments || []).filter((moment) => moment.actionText).map((moment) => ({
        id: `legacy-${moment.id}`,
        anchor: moment.anchor,
        text: moment.actionText,
      })) : []);
    const usedBeats = new Set();
    const sourceParagraphs = Array.isArray(chapter?.sourceParagraphs) ? chapter.sourceParagraphs : [];
    const paragraphs = paragraphList(chapter?.text);
    const rows = paragraphs.map((paragraph, index) => {
      const isSourceParagraph = sourceParagraphs.some((sourceParagraph) => (
        sourceParagraph === paragraph
        || (paragraph.length >= 24 && sourceParagraph.includes(paragraph))
      ));
      const displayText = isSourceParagraph ? paragraph : radioDisplayText(paragraph);
      const attached = narrationBeats.filter((beat) => {
        if (usedBeats.has(beat.id) || !paragraph.includes(beat.anchor)) return false;
        usedBeats.add(beat.id);
        return true;
      });
      if (attached.length && !isSourceParagraph) {
        const parts = splitRadioParagraphByNarration(paragraph, attached).map((part) => (
          part.type === 'narration'
            ? `<aside class="radio-narration-beat">${esc(applyDisplayRegex(part.beat.text, 'radio'))}</aside>`
            : `<p>${renderNarrationTextWithTranslations(radioDisplayText(part.text), { wrapOrphanSentences: false })}</p>`
        ));
        return `<section class="radio-transcript-block" data-radio-paragraph="${index}">${parts.join('')}</section>`;
      }
      const paragraphHtml = isSourceParagraph
        ? `<section class="radio-source-passage" data-radio-paragraph="${index}"><small>原文</small><p>${esc(displayText)}</p></section>`
        : `<p data-radio-paragraph="${index}">${renderNarrationTextWithTranslations(displayText, { wrapOrphanSentences: false })}</p>`;
      return `${paragraphHtml}${attached.map((beat) => (
        `<aside class="radio-narration-beat">${esc(applyDisplayRegex(beat.text, 'radio'))}</aside>`
      )).join('')}`;
    });
    const unmatched = narrationBeats.filter((beat) => !usedBeats.has(beat.id));
    if (unmatched.length) rows.push(unmatched.map((beat) => (
      `<aside class="radio-narration-beat">${esc(applyDisplayRegex(beat.text, 'radio'))}</aside>`
    )).join(''));
    return rows.join('');
  }

  function editSheetHtml(episode) {
    return `
      <div class="radio-edit-sheet" data-edit-sheet hidden>
        <button type="button" class="radio-sheet-backdrop" data-edit-close aria-label="关闭编辑"></button>
        <form data-edit-form>
          <header><span>编辑节目</span><button type="button" data-edit-close>${icon('close')}</button></header>
          <div class="radio-edit-scroll">
            <label><span>标题</span><input name="title" maxlength="120" value="${escAttr(episode.title)}" required></label>
            <label><span>副标题</span><input name="subtitle" maxlength="180" value="${escAttr(episode.subtitle)}"></label>
            <label><span>节目简介</span><textarea name="summary" maxlength="1000" rows="3">${esc(episode.summary)}</textarea></label>
            <label><span>后续聊天记忆</span><textarea name="memorySummary" maxlength="520" rows="4">${esc(episode.memorySummary)}</textarea></label>
            <div class="radio-edit-chapters">
              ${episode.chapters.map((chapter, index) => `
                <section data-edit-chapter="${index}">
                  <small>第 ${index + 1} 章</small>
                  <input data-edit-chapter-title maxlength="80" value="${escAttr(chapter.title)}" aria-label="第 ${index + 1} 章标题" required>
                  <textarea data-edit-chapter-text maxlength="12000" rows="12" aria-label="第 ${index + 1} 章正文" required>${esc(chapter.text)}</textarea>
                </section>`).join('')}
            </div>
          </div>
          <footer><span>修改过的章节会重新生成语音</span><button type="submit">保存修改</button></footer>
        </form>
      </div>`;
  }

  function mixerSheetHtml() {
    const rows = [
      ['voiceVolume', '角色语音'],
      ['ambientVolume', '环境背景'],
      ['cueVolume', '动作音效'],
    ];
    return `
      <div class="radio-mixer-sheet" data-mixer-sheet hidden>
        <button type="button" class="radio-sheet-backdrop" data-mixer-close aria-label="关闭声音设置"></button>
        <section>
          <header><span>声音</span><button type="button" data-mixer-close>${icon('close')}</button></header>
          <div class="radio-mixer-controls">
            ${rows.map(([key, label]) => {
              const percent = Math.round(Number(playbackPrefs[key] || 0) * 100);
              return `<label><span>${label}</span><input type="range" min="0" max="100" step="1" value="${percent}" data-volume-key="${key}" aria-label="${label}音量"><output data-volume-output="${key}">${percent}%</output></label>`;
            }).join('')}
          </div>
        </section>
      </div>`;
  }

  function seriesScheduleSheetHtml(episode, plan = null) {
    if (!episode.readingSeries?.hasMore) return '';
    return `
      <div class="radio-series-sheet" data-series-sheet hidden>
        <button type="button" class="radio-sheet-backdrop" data-series-schedule-close aria-label="关闭定期续读"></button>
        <section>
          <header><span>定期续读</span><button type="button" data-series-schedule-close>${icon('close')}</button></header>
          <div class="radio-series-schedule-options">
            <button type="button" class="${plan?.recurrence === 'daily' ? 'is-active' : ''}" data-series-cadence="daily"><strong>每天</strong><span>按当前时间续读下一期</span></button>
            <button type="button" class="${plan?.recurrence === 'weekly' ? 'is-active' : ''}" data-series-cadence="weekly"><strong>每周</strong><span>每七天继续这份来稿</span></button>
            ${plan ? '<button type="button" class="radio-series-schedule-off" data-series-cadence="off">停止定期续读</button>' : ''}
          </div>
        </section>
      </div>`;
  }

  function seriesContinueSheetHtml(episode) {
    if (!episode.readingSeries?.hasMore) return '';
    const selected = [5, 8, 15].includes(continueMinutes)
      ? continueMinutes
      : ([5, 8, 15].includes(Number(episode.readingSeries.minutes))
        ? Number(episode.readingSeries.minutes)
        : 8);
    return `
      <div class="radio-continue-sheet" data-series-continue-sheet hidden>
        <button type="button" class="radio-sheet-backdrop" data-series-continue-close aria-label="关闭续读时长选择"></button>
        <section>
          <header><span>续读时长</span><button type="button" data-series-continue-close>${icon('close')}</button></header>
          <div class="radio-series-duration-options">
            ${[5, 8, 15].map((minutes) => `<button type="button" class="${selected === minutes ? 'is-active' : ''}" data-series-continue-minutes="${minutes}"><strong>${minutes} 分钟</strong></button>`).join('')}
          </div>
        </section>
      </div>`;
  }

  function renderPlayer(episode) {
    currentEpisode = episode;
    currentChapterIndex = Math.max(0, Math.min(
      episode.chapters.length - 1,
      Number(episode.progress?.chapterIndex || 0),
    ));
    const chapter = episode.chapters[currentChapterIndex];
    const isSynthesizing = synthesizingChapterIndex === currentChapterIndex;
    const readingSeries = episode.readingSeries;
    const seriesPlan = readingSeries ? radioPlans.find((plan) => (
      plan.readingSeriesId === readingSeries.id
      && ['pending', 'generating'].includes(plan.status)
    )) : null;
    const readingPercent = readingSeries?.totalLength
      ? Math.max(0, Math.min(100, Math.round((readingSeries.end / readingSeries.totalLength) * 100)))
      : 0;
    container.innerHTML = `
      <main class="radio-player ${coverClass(episode.type)}"${coverStyle(episode)}>
        <section class="radio-player-cover">
          <div class="radio-player-nav">
            <button type="button" class="radio-player-icon" data-player-back aria-label="返回">${icon('back')}</button>
            <span>正在收听</span>
            <button type="button" class="radio-player-icon" data-player-share aria-label="发送到聊天">${icon('share')}</button>
          </div>
          <div class="radio-player-titles">
            <small>${esc(episodeTypeLabel(episode))}</small>
            <h1>${esc(radioDisplayText(episode.title))}</h1>
            <p>${esc(episode.characterName)} · ${esc(radioDisplayText(episode.subtitle))}</p>
          </div>
        </section>
        <section class="radio-reader">
          ${readingSeries ? `<div class="radio-series-progress">
            <span><small>${esc(readingSeries.title || readingSeries.sourceName)}</small><strong>第 ${readingSeries.partNumber} 期</strong></span>
            <i aria-label="书稿进度 ${readingPercent}%"><b style="width:${readingPercent}%"></b></i><em>${readingPercent}%</em>
          </div>` : ''}
          <div class="radio-progress-meta"><span data-current-time>${formatClock(episode.progress?.positionSeconds)}</span><span data-total-time>${chapter.durationSeconds ? formatClock(chapter.durationSeconds) : '--:--'}</span></div>
          <div class="radio-progress-rail" data-progress-seek role="slider" tabindex="0" aria-label="播放进度"><i data-progress-fill></i></div>
          <div class="radio-chapter-nav">
            <button type="button" data-chapter-step="-1" aria-label="上一章">‹</button>
            <button type="button" class="radio-chapter-current" data-chapter-list><small>第 ${currentChapterIndex + 1} 章</small><strong>${esc(radioDisplayText(chapter.title))}</strong></button>
            <button type="button" data-chapter-step="1" aria-label="下一章">›</button>
          </div>
          <article class="radio-transcript" data-transcript>${renderTranscript(episode, currentChapterIndex)}</article>
          <div class="radio-player-controls">
            <div class="radio-synthesis-status" data-audio-synthesis-status role="status" aria-live="polite" hidden>
              <i aria-hidden="true"></i><span></span>
            </div>
            <button type="button" data-chapter-list aria-label="章节目录">${icon('menu')}</button>
            <button type="button" data-seek-delta="-15" aria-label="后退15秒">${icon('rewind15')}</button>
            <button type="button" class="radio-main-play" data-main-play aria-label="播放">${mainPlayGlyph('play')}</button>
            <button type="button" data-seek-delta="15" aria-label="前进15秒">${icon('forward15')}</button>
            <label class="radio-cover-upload" aria-label="更换图片背景">${icon('image')}<input type="file" accept="image/*" data-cover-file hidden></label>
          </div>
          <div class="radio-player-foot">
            <span class="radio-player-foot-actions">${readingSeries?.hasMore ? `<button type="button" data-series-continue ${continuingSeries ? 'disabled' : ''}>${continuingSeries ? '正在续读…' : '续读下一期'}</button><button type="button" data-series-schedule>${seriesPlan ? (seriesPlan.recurrence === 'daily' ? '每天续读' : '每周续读') : '定期续读'}</button>` : ''}<button type="button" data-player-export>导出音频</button><button type="button" data-player-edit>编辑正文</button><button type="button" data-player-mixer>声音</button><button type="button" data-player-delete>删除节目</button></span>
            <span>${episode.ambientCategories.length ? `环境声 · ${episode.ambientCategories.map(esc).join(' / ')}` : '纯净人声'}</span>
          </div>
        </section>
        <div class="radio-chapter-sheet" data-chapter-sheet hidden>
          <button type="button" class="radio-sheet-backdrop" data-chapter-close aria-label="关闭"></button>
          <section><header><span>章节</span><button type="button" data-chapter-close>${icon('close')}</button></header>
            ${episode.chapters.map((item, index) => `<button type="button" class="${index === currentChapterIndex ? 'is-active' : ''}" data-chapter-index="${index}"><small>${String(index + 1).padStart(2, '0')}</small><span><strong>${esc(radioDisplayText(item.title))}</strong><em>${item.audioBlob instanceof Blob ? '已缓存音声' : '尚未生成音声'}</em></span></button>`).join('')}
          </section>
        </div>
        ${editSheetHtml(episode)}
        ${mixerSheetHtml()}
        ${seriesContinueSheetHtml(episode)}
        ${seriesScheduleSheetHtml(episode, seriesPlan)}
      </main>`;
    bindPlayer();
    setAudioSynthesisStatus(isSynthesizing);
    updatePlayerProgress();
  }

  function setAudioSynthesisStatus(active) {
    const status = container.querySelector('[data-audio-synthesis-status]');
    const chapter = currentEpisode?.chapters?.[currentChapterIndex];
    const needsSynthesis = chapter ? !isRadioChapterAudioCurrent(chapter) : false;
    if (status) {
      const state = active ? 'loading' : 'prompt';
      status.hidden = !active && !needsSynthesis;
      status.dataset.state = state;
      const label = status.querySelector('span');
      if (label) label.textContent = active
        ? '音频合成中，首次播放需要稍等…'
        : '点击播放，开始合成本章音声';
    }
    const playButton = container.querySelector('[data-main-play]');
    if (playButton) {
      playButton.disabled = active;
      playButton.setAttribute('aria-busy', active ? 'true' : 'false');
      playButton.setAttribute('aria-label', active ? '音频合成中' : '播放');
    }
  }

  function setMainPlayState(state = 'play') {
    const button = container.querySelector('[data-main-play]');
    if (!button) return;
    const loading = state === 'loading';
    button.classList.toggle('is-loading', loading);
    button.disabled = loading;
    button.setAttribute('aria-busy', loading ? 'true' : 'false');
    button.innerHTML = mainPlayGlyph(state);
    button.setAttribute('aria-label', loading ? '音频合成中' : (state === 'pause' ? '暂停' : '播放'));
  }

  function updatePlayerProgress() {
    const chapter = currentEpisode?.chapters?.[currentChapterIndex];
    if (!chapter) return;
    const current = Number(currentAudio?.currentTime ?? currentEpisode.progress?.positionSeconds ?? 0) || 0;
    const duration = Number(currentAudio?.duration || chapter.durationSeconds || 0) || 0;
    const ratio = duration > 0 ? Math.max(0, Math.min(1, current / duration)) : 0;
    const currentEl = container.querySelector('[data-current-time]');
    const totalEl = container.querySelector('[data-total-time]');
    const fill = container.querySelector('[data-progress-fill]');
    if (currentEl) currentEl.textContent = formatClock(current);
    if (totalEl) totalEl.textContent = duration ? formatClock(duration) : '--:--';
    if (fill) fill.style.width = `${ratio * 100}%`;
    const paragraphs = [...container.querySelectorAll('[data-radio-paragraph]')];
    const currentParagraph = Math.min(paragraphs.length - 1, Math.floor(ratio * paragraphs.length));
    paragraphs.forEach((paragraph, index) => paragraph.classList.toggle('is-current', index === currentParagraph && !!currentAudio));
  }

  async function startAmbient(episode, gestureTokens = []) {
    const tokens = (Array.isArray(gestureTokens) ? gestureTokens : [gestureTokens]).filter(Boolean);
    if (ambientPlaybacks.length) {
      await Promise.all(ambientPlaybacks.map((item) => playAudioWhenReady(item.audio).catch(() => {})));
      tokens.forEach((token) => token.dispose?.());
      return;
    }
    if (episode.ambientEnabled === false || !episode.ambientCategories.length) {
      tokens.forEach((token) => token.dispose?.());
      return;
    }
    const rows = await listSoundAssets().catch(() => []);
    const assets = [...new Set(episode.ambientCategories)].slice(0, 2)
      .map((category) => rows.find((row) => row.enabled !== false
        && row.category === category
        && row.audioBlob instanceof Blob
        && row.audioBlob.size > 0))
      .filter(Boolean);
    if (!assets.length) {
      tokens.forEach((token) => token.dispose?.());
      return;
    }
    const created = assets.map((asset, index) => {
      const playback = createSoundAssetPlayback(asset);
      const audio = audioFromGestureOrNew(playback.url, tokens[index] || null);
      if (!audio) {
        playback.revoke?.();
        return null;
      }
      audio.loop = true;
      return { asset, audio, revoke: playback.revoke };
    }).filter(Boolean);
    tokens.slice(assets.length).forEach((token) => token.dispose?.());
    ambientPlaybacks = created;
    applyPlaybackVolumes();
    await Promise.all(created.map(async (item) => {
      try {
        await playAudioWhenReady(item.audio);
        await recordSoundAssetPlayback(item.asset, { category: item.asset.category, layer: 'background' }).catch(() => {});
      } catch (_) {
        item.revoke?.();
        ambientPlaybacks = ambientPlaybacks.filter((candidate) => candidate !== item);
      }
    }));
  }

  async function prepareMomentSounds(chapter) {
    const categories = new Set((chapter?.soundMoments || []).flatMap((moment) => moment.categories || []));
    if (!categories.size) {
      momentSoundPool = new Map();
      return;
    }
    const rows = await listSoundAssets().catch(() => []);
    momentSoundPool = new Map([...categories].map((category) => [
      category,
      rows.filter((row) => row.enabled !== false
        && row.category === category
        && row.audioBlob instanceof Blob
        && row.audioBlob.size > 0),
    ]));
    // 播放按钮已经在用户手势中唤醒 AudioContext；提前解码避免动作发生时才卡一下。
    void Promise.all([...momentSoundPool.values()].flat().map((asset) => decodeCueAsset(asset)));
  }

  function soundMomentTime(chapter, moment, index, duration) {
    const seconds = radioSoundMomentSeconds(chapter, moment, index, duration);
    return Math.max(0.4, Math.min(Math.max(0.4, duration - 0.4), seconds));
  }

  function soundAssetMatchScore(asset, moment) {
    const action = String(moment?.actionText || '').toLowerCase();
    const descriptor = `${asset?.name || ''} ${asset?.sourceName || ''}`.toLowerCase();
    if (!action || !descriptor) return 0;
    const actionPairs = new Set([...action].map((char, index) => action.slice(index, index + 2)).filter((part) => part.length === 2));
    return [...actionPairs].reduce((score, part) => score + (descriptor.includes(part) ? 1 : 0), 0);
  }

  function selectMomentAsset(rows, moment, category) {
    const previousId = lastMomentAssetByCategory.get(category) || '';
    const sorted = [...rows].sort((left, right) => (
      soundAssetMatchScore(right, moment) - soundAssetMatchScore(left, moment)
      || Number(left.id === previousId) - Number(right.id === previousId)
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
    const asset = sorted[0] || null;
    if (asset?.id) lastMomentAssetByCategory.set(category, asset.id);
    return asset;
  }

  async function playMomentSound(moment) {
    const playbackEpoch = momentPlaybackEpoch;
    const category = (moment?.categories || []).find((id) => (momentSoundPool.get(id) || []).length);
    const rows = momentSoundPool.get(category) || [];
    const asset = selectMomentAsset(rows, moment, category);
    if (!asset) return;
    const context = ensureCueAudioContext();
    const buffer = await decodeCueAsset(asset);
    if (playbackEpoch !== momentPlaybackEpoch || currentAudio?.paused) return;
    if (context && buffer && cueCompressor) {
      if (context.state === 'suspended') await context.resume().catch(() => {});
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = resolveCueGain(asset);
      source.connect(gain);
      gain.connect(cueCompressor);
      const item = { asset, source, gain };
      momentAudios.add(item);
      source.onended = () => momentAudios.delete(item);
      source.start();
      void recordSoundAssetPlayback(asset, { category, layer: 'cue' }).catch(() => {});
      return;
    }
    const playback = createSoundAssetPlayback(asset);
    const audio = audioFromGestureOrNew(playback.url, momentSlot.gesture || null);
    momentSlot.gesture = null;
    if (!audio) {
      playback.revoke?.();
      return;
    }
    const item = { asset, audio, revoke: playback.revoke };
    momentAudios.add(item);
    applyMediaVolume(audio, resolveCueGain(asset));
    const release = () => {
      momentAudios.delete(item);
      playback.revoke?.();
    };
    audio.addEventListener('ended', release, { once: true });
    audio.addEventListener('error', release, { once: true });
    playAudioWhenReady(audio)
      .then(() => recordSoundAssetPlayback(asset, { category, layer: 'cue' }).catch(() => {}))
      .catch(release);
  }

  function updateMomentSounds(chapter, audio) {
    const current = Number(audio?.currentTime || 0);
    const duration = Number(audio?.duration || chapter?.durationSeconds || 0);
    if (!duration) return;
    const delta = current - lastMomentTime;
    if (delta < -0.8) {
      playedSoundMoments = new Set();
      lastMomentTime = current;
      return;
    }
    if (delta >= 0 && !audio?.seeking) {
      (chapter?.soundMoments || []).forEach((moment, index) => {
        const id = String(moment.id || index);
        const at = soundMomentTime(chapter, moment, index, duration);
        if (playedSoundMoments.has(id) || at <= lastMomentTime || at > current + 0.12) return;
        playedSoundMoments.add(id);
        void playMomentSound(moment);
      });
    }
    lastMomentTime = current;
  }

  async function playChapter(index, {
    voiceGesture = null,
    ambientGesture = null,
    ambientGestureAlt = null,
    momentGesture = null,
    resume = false,
  } = {}) {
    const episode = currentEpisode;
    if (!episode) return;
    const nextIndex = Math.max(0, Math.min(episode.chapters.length - 1, Number(index) || 0));
    if (synthesizingChapterIndex >= 0) {
      voiceGesture?.dispose?.();
      ambientGesture?.dispose?.();
      ambientGestureAlt?.dispose?.();
      momentGesture?.dispose?.();
      return;
    }
    const pendingChapter = episode.chapters[nextIndex];
    const needsSynthesis = !isRadioChapterAudioCurrent(pendingChapter);
    const playButton = container.querySelector('[data-main-play]');
    if (currentAudio && !currentAudio.paused && nextIndex === currentChapterIndex) {
      currentAudio.pause();
      ambientPlaybacks.forEach((item) => item.audio.pause());
      stopMomentPlayback();
      setMainPlayState('play');
      voiceGesture?.dispose?.();
      ambientGesture?.dispose?.();
      ambientGestureAlt?.dispose?.();
      momentGesture?.dispose?.();
      return;
    }
    if (playButton) setMainPlayState('loading');
    if (needsSynthesis) {
      synthesizingChapterIndex = nextIndex;
      setAudioSynthesisStatus(true);
    }
    try {
      if (nextIndex !== currentChapterIndex) {
        currentChapterIndex = nextIndex;
        currentEpisode = { ...currentEpisode, progress: { ...currentEpisode.progress, chapterIndex: nextIndex, positionSeconds: 0 } };
        renderPlayer(currentEpisode);
        if (needsSynthesis) setAudioSynthesisStatus(true);
      }
      const result = await ensureRadioChapterAudio(episode.id, nextIndex);
      currentEpisode = result.episode;
      if (needsSynthesis) {
        synthesizingChapterIndex = -1;
        setAudioSynthesisStatus(false);
      }
      episodes = episodes.map((item) => item.id === result.episode.id ? result.episode : item);
      const blob = result.chapter.audioBlob;
      await prepareMomentSounds(result.chapter);
      if (!momentSlot.audio && momentGesture) momentSlot.gesture = momentGesture;
      else momentGesture?.dispose?.();
      playedSoundMoments = new Set();
      lastMomentTime = 0;
      if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = URL.createObjectURL(blob);
      if (!voiceSlot.audio && voiceGesture) voiceSlot.gesture = voiceGesture;
      else voiceGesture?.dispose?.();
      const audio = takePlayableAudio(currentAudioUrl, voiceSlot);
      if (!audio) throw new Error('当前设备没有可用的播放音轨');
      currentAudio = audio;
      await startAmbient(result.episode, [ambientGesture, ambientGestureAlt]);
      const savedPosition = resume && nextIndex === Number(episode.progress?.chapterIndex || 0)
        ? Number(episode.progress?.positionSeconds || 0)
        : 0;
      applyMediaVolume(audio, playbackPrefs.voiceVolume);
      await playAudioWhenReady(audio);
      if (savedPosition > 0 && Number.isFinite(audio.duration) && savedPosition < audio.duration - 2) {
        try { audio.currentTime = savedPosition; } catch (_) {}
      }
      beginPlaybackGuard();
      setMainPlayState('pause');
      audio.ontimeupdate = () => {
        updatePlayerProgress();
        updateMomentSounds(result.chapter, audio);
        const now = Date.now();
        if (now - progressSaveAt > 4000) {
          progressSaveAt = now;
          void patchRadioEpisodeProgress(episode.id, {
            chapterIndex: nextIndex,
            positionSeconds: audio.currentTime,
            completed: false,
          });
        }
      };
      audio.onseeking = () => {
        lastMomentTime = Number(audio.currentTime || 0);
      };
      audio.onseeked = () => {
        lastMomentTime = Number(audio.currentTime || 0);
      };
      audio.onpause = () => {
        if (!audio.ended) {
          endPlaybackGuard();
          setMainPlayState('play');
        }
      };
      audio.onended = async () => {
        const last = nextIndex >= episode.chapters.length - 1;
        await patchRadioEpisodeProgress(episode.id, {
          chapterIndex: nextIndex,
          positionSeconds: 0,
          completed: last,
        });
        if (last) {
          endPlaybackGuard();
          ambientPlaybacks.forEach((item) => {
            item.audio.pause();
            try { item.audio.currentTime = 0; } catch (_) {}
          });
          stopMomentPlayback();
          setMainPlayState('play');
          showToast('本期节目已听完');
        } else {
          await playChapter(nextIndex + 1);
        }
      };
      updatePlayerProgress();
    } catch (error) {
      endPlaybackGuard();
      synthesizingChapterIndex = -1;
      setAudioSynthesisStatus(false);
      voiceGesture?.dispose?.();
      ambientGesture?.dispose?.();
      ambientGestureAlt?.dispose?.();
      momentGesture?.dispose?.();
      setMainPlayState('play');
      showToast(`播放失败：${error?.message || error}`, 5000);
    }
  }

  function changeChapter(index) {
    stopPlayback({ clearAmbient: false });
    currentEpisode = {
      ...currentEpisode,
      progress: { ...currentEpisode.progress, chapterIndex: index, positionSeconds: 0 },
    };
    renderPlayer(currentEpisode);
    void patchRadioEpisodeProgress(currentEpisode.id, { chapterIndex: index, positionSeconds: 0, completed: false });
  }

  function bindPlayer() {
    bindNarrationTranslationToggle(container);
    container.querySelector('[data-player-back]')?.addEventListener('click', () => navigate('radio', {}, true));
    container.querySelector('[data-main-play]')?.addEventListener('click', (event) => {
      primeCueAudioContext();
      const voiceGesture = captureMediaGesture(event);
      const ambientGesture = captureMediaGesture(event, { trackAsForeground: false, audioSession: 'ambient' });
      const ambientGestureAlt = captureMediaGesture(event, { trackAsForeground: false, audioSession: 'ambient' });
      const momentGesture = captureMediaGesture(event, { trackAsForeground: false, audioSession: 'ambient' });
      void playChapter(currentChapterIndex, {
        voiceGesture,
        ambientGesture,
        ambientGestureAlt,
        momentGesture,
        resume: true,
      });
    });
    container.querySelectorAll('[data-seek-delta]').forEach((button) => button.addEventListener('click', () => {
      if (!currentAudio) return;
      const delta = Number(button.getAttribute('data-seek-delta') || 0);
      currentAudio.currentTime = Math.max(0, Math.min(currentAudio.duration || Infinity, currentAudio.currentTime + delta));
      updatePlayerProgress();
    }));
    container.querySelector('[data-progress-seek]')?.addEventListener('click', (event) => {
      if (!currentAudio || !Number.isFinite(currentAudio.duration)) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      currentAudio.currentTime = currentAudio.duration * ratio;
      updatePlayerProgress();
    });
    container.querySelectorAll('[data-chapter-step]').forEach((button) => button.addEventListener('click', () => {
      const next = currentChapterIndex + Number(button.getAttribute('data-chapter-step') || 0);
      if (next < 0 || next >= currentEpisode.chapters.length) return;
      changeChapter(next);
    }));
    container.querySelectorAll('[data-chapter-list]').forEach((button) => button.addEventListener('click', () => {
      const sheet = container.querySelector('[data-chapter-sheet]');
      if (sheet) sheet.hidden = false;
    }));
    container.querySelectorAll('[data-chapter-close]').forEach((button) => button.addEventListener('click', () => {
      const sheet = container.querySelector('[data-chapter-sheet]');
      if (sheet) sheet.hidden = true;
    }));
    container.querySelectorAll('[data-chapter-index]').forEach((button) => button.addEventListener('click', () => {
      changeChapter(Number(button.getAttribute('data-chapter-index') || 0));
    }));
    container.querySelector('[data-cover-file]')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!String(file.type || '').startsWith('image/')) return showToast('请选择图片文件');
      try {
        const updated = await setRadioEpisodeCover(currentEpisode.id, file);
        releaseCoverUrls();
        currentEpisode = updated;
        episodes = episodes.map((item) => item.id === updated.id ? updated : item);
        renderPlayer(updated);
      } catch (error) {
        showToast(error?.message || '图片背景保存失败');
      }
    });
    container.querySelector('[data-player-share]')?.addEventListener('click', async () => {
      try {
        const { chat } = await shareRadioEpisodeToChat(currentEpisode.id);
        showToast('已发送到聊天');
        navigate('chat/thread', { chatId: chat.id });
      } catch (error) {
        showToast(error?.message || '发送失败');
      }
    });
    container.querySelector('[data-player-export]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const { segments, missingChapterNumbers, totalChapters } = collectRadioEpisodeAudioExport(currentEpisode);
      if (!totalChapters || !segments.length) {
        showToast('本期还没有可导出的音频，请先播放节目');
        return;
      }
      if (missingChapterNumbers.length) {
        showToast(`请先播放第 ${missingChapterNumbers.join('、')} 章，生成完整音频后再导出`, 5200);
        return;
      }
      button.disabled = true;
      button.textContent = '正在导出…';
      try {
        const result = await exportCachedVoiceSequence(segments, {
          filenameBase: `${currentEpisode.characterName || '角色'}-${radioDisplayText(currentEpisode.title) || '电台节目'}`,
        });
        showToast(result.message || '电台音频已导出', 5200);
      } catch (error) {
        showToast(`音频导出失败：${error?.message || error}`, 5200);
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = '导出音频';
        }
      }
    });
    container.querySelector('[data-series-continue]')?.addEventListener('click', () => {
      if (continuingSeries) return;
      const sheet = container.querySelector('[data-series-continue-sheet]');
      if (sheet) sheet.hidden = false;
    });
    container.querySelectorAll('[data-series-continue-close]').forEach((button) => button.addEventListener('click', () => {
      const sheet = container.querySelector('[data-series-continue-sheet]');
      if (sheet) sheet.hidden = true;
    }));
    container.querySelectorAll('[data-series-continue-minutes]').forEach((button) => button.addEventListener('click', async () => {
      if (continuingSeries) return;
      continueMinutes = Number(button.getAttribute('data-series-continue-minutes') || 8);
      continuingSeries = true;
      stopPlayback();
      renderPlayer(currentEpisode);
      try {
        const next = await continueRadioReadingSeries({
          user,
          episodeId: currentEpisode.id,
          minutes: continueMinutes,
        });
        episodes = await listRadioEpisodes(user.id);
        continuingSeries = false;
        navigate('radio', { id: next.id }, true);
      } catch (error) {
        continuingSeries = false;
        showToast(error?.message || '下一期生成失败', 5200);
        renderPlayer(currentEpisode);
      }
    }));
    container.querySelector('[data-series-schedule]')?.addEventListener('click', () => {
      const sheet = container.querySelector('[data-series-sheet]');
      if (sheet) sheet.hidden = false;
    });
    container.querySelectorAll('[data-series-schedule-close]').forEach((button) => button.addEventListener('click', () => {
      const sheet = container.querySelector('[data-series-sheet]');
      if (sheet) sheet.hidden = true;
    }));
    container.querySelectorAll('[data-series-cadence]').forEach((button) => button.addEventListener('click', async () => {
      const cadence = button.getAttribute('data-series-cadence') || '';
      const seriesId = currentEpisode.readingSeries?.id || '';
      const existing = radioPlans.find((plan) => (
        plan.readingSeriesId === seriesId
        && ['pending', 'generating'].includes(plan.status)
      ));
      try {
        if (cadence === 'off') {
          if (existing) await updateRadioPlan(user.id, existing.id, { status: 'cancelled', completedAt: Date.now() });
          radioPlans = await listRadioPlans(user.id);
          renderPlayer(currentEpisode);
          showToast('已停止定期续读');
          return;
        }
        if (!currentEpisode.chatId) throw new Error('需要先把这期节目关联到角色私聊');
        const interval = cadence === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        if (existing) {
          await updateRadioPlan(user.id, existing.id, {
            recurrence: cadence,
            dueAt: Date.now() + interval,
            status: 'pending',
            episodeId: '',
            completedAt: 0,
          });
        } else {
          await createRadioPlan(user.id, {
            characterId: currentEpisode.characterId,
            chatId: currentEpisode.chatId,
            dueAt: Date.now() + interval,
            topic: currentEpisode.topic || currentEpisode.readingSeries.title,
            note: currentEpisode.generationPrompt,
            type: 'reading',
            readingSeriesId: seriesId,
            recurrence: cadence,
            minutes: currentEpisode.readingSeries.minutes,
            actionMode: currentEpisode.actionMode,
            ambientEnabled: currentEpisode.ambientEnabled,
          });
        }
        radioPlans = await listRadioPlans(user.id);
        renderPlayer(currentEpisode);
        showToast(cadence === 'daily' ? '已约定每天续读' : '已约定每周续读');
      } catch (error) {
        showToast(error?.message || '定期续读设置失败');
      }
    }));
    container.querySelector('[data-player-mixer]')?.addEventListener('click', () => {
      const sheet = container.querySelector('[data-mixer-sheet]');
      if (sheet) sheet.hidden = false;
    });
    container.querySelectorAll('[data-mixer-close]').forEach((button) => button.addEventListener('click', () => {
      const sheet = container.querySelector('[data-mixer-sheet]');
      if (sheet) sheet.hidden = true;
    }));
    container.querySelectorAll('[data-volume-key]').forEach((input) => input.addEventListener('input', () => {
      const key = input.getAttribute('data-volume-key');
      if (!['voiceVolume', 'ambientVolume', 'cueVolume'].includes(key)) return;
      const value = Math.max(0, Math.min(1, Number(input.value || 0) / 100));
      playbackPrefs = { ...playbackPrefs, [key]: value };
      const output = container.querySelector(`[data-volume-output="${key}"]`);
      if (output) output.textContent = `${Math.round(value * 100)}%`;
      applyPlaybackVolumes();
      schedulePlaybackPrefsSave();
    }));
    container.querySelector('[data-player-edit]')?.addEventListener('click', () => {
      currentAudio?.pause?.();
      ambientPlaybacks.forEach((item) => item.audio.pause());
      stopMomentPlayback();
      const sheet = container.querySelector('[data-edit-sheet]');
      if (sheet) sheet.hidden = false;
    });
    container.querySelectorAll('[data-edit-close]').forEach((button) => button.addEventListener('click', () => {
      const sheet = container.querySelector('[data-edit-sheet]');
      if (sheet) sheet.hidden = true;
    }));
    container.querySelector('[data-edit-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('[type="submit"]');
      const data = new FormData(form);
      const chapters = [...form.querySelectorAll('[data-edit-chapter]')].map((section) => ({
        title: section.querySelector('[data-edit-chapter-title]')?.value || '',
        text: section.querySelector('[data-edit-chapter-text]')?.value || '',
      }));
      if (chapters.some((chapter) => !chapter.text.trim())) {
        showToast('章节正文不能为空');
        return;
      }
      if (submit) submit.disabled = true;
      try {
        stopPlayback();
        const updated = await updateRadioEpisodeContent(currentEpisode.id, {
          title: data.get('title'),
          subtitle: data.get('subtitle'),
          summary: data.get('summary'),
          memorySummary: data.get('memorySummary'),
          chapters,
        });
        currentEpisode = updated;
        episodes = episodes.map((item) => item.id === updated.id ? updated : item);
        renderPlayer(updated);
        showToast('修改已保存');
      } catch (error) {
        if (submit) submit.disabled = false;
        showToast(error?.message || '节目修改保存失败');
      }
    });
    container.querySelector('[data-player-delete]')?.addEventListener('click', async () => {
      if (!window.confirm(`删除《${currentEpisode.title}》？`)) return;
      stopPlayback();
      try {
        await deleteRadioEpisode(currentEpisode.id, { userId: user.id });
        episodes = episodes.filter((item) => item.id !== currentEpisode.id);
        navigate('radio', {}, true);
      } catch (error) {
        showToast(error?.message || '节目删除失败');
      }
    });
  }

  const dispose = () => {
    if (destroyed) return;
    destroyed = true;
    if (playbackPrefsSaveTimer) {
      window.clearTimeout(playbackPrefsSaveTimer);
      void saveRadioPlaybackPrefs(user.id, playbackPrefs).catch(() => {});
    }
    playbackPrefsSaveTimer = 0;
    stopPlayback();
    voiceSlot.gesture?.dispose?.();
    cueBufferCache.clear();
    if (cueAudioContext && cueAudioContext.state !== 'closed') {
      void cueAudioContext.close().catch(() => {});
    }
    cueAudioContext = null;
    cueCompressor = null;
    releaseCoverUrls();
    window.removeEventListener('marshmallow-route-disposed', onRouteDisposed);
  };
  const onRouteDisposed = (event) => {
    if (event.detail?.container === container) dispose();
  };
  window.addEventListener('marshmallow-route-disposed', onRouteDisposed);

  const episodeId = String(params.id || '').trim();
  if (episodeId) {
    const episode = await getRadioEpisode(episodeId);
    if (episode && episode.userId === user.id) renderPlayer(episode);
    else {
      showToast('没有找到这期节目');
      renderHome();
    }
  } else {
    renderHome();
  }
}
