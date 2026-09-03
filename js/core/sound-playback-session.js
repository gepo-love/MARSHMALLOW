import {
  inferNarrationContinuousSoundCuesFromMessages,
  inferNarrationSoundCues,
} from './sound-cues.js';
import {
  createSoundAssetPlayback,
  listSoundAssets,
} from './sound-library.js';
import {
  audioFromGestureOrNew,
  playAudioWhenReady,
} from './media-playback.js';

const BACKGROUND_CATEGORIES = new Set([
  'ambience_water',
  'ambience_rain',
  'ambience_scene',
  'bgm_romantic',
  'bgm_calm',
  'bgm_night',
  'bgm_tension',
  'bgm',
]);

const CALL_ACTION_CATEGORIES = new Set([
  'kiss',
  'fabric',
  'body_movement',
  'body_impact',
  'footsteps',
  'door',
  'wet',
]);

function clampVolume(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, normalized));
}

export function resolveAutomaticSoundSpeechMixVolume(baseVolume = 0, kind = 'ambience', active = false) {
  const base = clampVolume(baseVolume, 0);
  if (!active) return base;
  const factor = kind === 'bgm' ? 0.32 : kind === 'cue' ? 0.28 : 0.58;
  return Math.round(base * factor * 1000) / 1000;
}

function stableIndex(seed = '', length = 0) {
  if (!length) return -1;
  let hash = 2166136261;
  const source = String(seed || '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function contextMessage(text = '') {
  return [{ content: String(text || '') }];
}

export function inferAutomaticSoundCategories(text = '', {
  availableCategories = [],
  allowBgm = true,
  fallbackScene = true,
} = {}) {
  const available = new Set((Array.isArray(availableCategories) ? availableCategories : [])
    .map((value) => String(value || '').trim())
    .filter((value) => BACKGROUND_CATEGORIES.has(value)));
  const inferred = inferNarrationContinuousSoundCuesFromMessages(contextMessage(text));
  let ambience = inferred.find((category) => category.startsWith('ambience_') && available.has(category)) || '';
  if (!ambience && fallbackScene && available.has('ambience_scene')) ambience = 'ambience_scene';
  let bgm = '';
  if (allowBgm) {
    const inferredBgm = inferred.find((category) => category.startsWith('bgm')) || '';
    if (inferredBgm && available.has(inferredBgm)) bgm = inferredBgm;
    else if (inferredBgm && inferredBgm !== 'bgm' && available.has('bgm')) bgm = 'bgm';
  }
  return [ambience, bgm].filter(Boolean);
}

export function extractExplicitStageSoundText(text = '') {
  const source = String(text || '');
  const matches = [];
  const pattern = /（([^（）]{1,180})）/gu;
  let match;
  while ((match = pattern.exec(source)) && matches.length < 6) {
    matches.push(String(match[1] || '').trim());
  }
  return matches.filter(Boolean).join(' ');
}

function fadeAudioVolume(audio, target, durationMs = 180) {
  if (!audio) return Promise.resolve();
  const from = clampVolume(audio.volume, 0);
  const to = clampVolume(target, 0);
  const duration = Math.max(0, Number(durationMs || 0));
  if (!duration || Math.abs(from - to) < 0.005) {
    audio.volume = to;
    return Promise.resolve();
  }
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const frame = globalThis.requestAnimationFrame
    ? (callback) => globalThis.requestAnimationFrame(callback)
    : (callback) => setTimeout(() => callback(now()), 16);
  return new Promise((resolve) => {
    const startedAt = now();
    const step = (time) => {
      const progress = Math.min(1, (time - startedAt) / duration);
      try { audio.volume = from + ((to - from) * progress); } catch (_) {}
      if (progress >= 1 || audio.paused) {
        resolve();
        return;
      }
      frame(step);
    };
    frame(step);
  });
}

function cleanupLayer(layer) {
  if (!layer || layer.stopped) return;
  layer.stopped = true;
  try {
    layer.audio.pause();
    layer.audio.removeAttribute('src');
    layer.audio.load?.();
  } catch (_) {}
  layer.revoke?.();
}

export function createAutomaticSoundSession({
  ownerId = '',
  seed = '',
  ambienceVolume = 0.18,
  bgmVolume = 0.1,
  cueVolume = 0.42,
  allowBgm = true,
  fallbackScene = true,
} = {}) {
  const baseAmbienceVolume = clampVolume(ambienceVolume, 0.18);
  const baseBgmVolume = clampVolume(bgmVolume, 0.1);
  const baseCueVolume = clampVolume(cueVolume, 0.42);
  const layers = new Map();
  const playingCues = new Set();
  let rowsPromise = null;
  let stopped = false;
  let speechActive = false;

  const loadRows = () => {
    if (!rowsPromise) {
      rowsPromise = listSoundAssets({ ownerId }).then((rows) => (
        (Array.isArray(rows) ? rows : []).filter((row) => (
          row?.enabled !== false
          && row?.audioBlob instanceof Blob
          && row.audioBlob.size > 0
        ))
      )).catch(() => []);
    }
    return rowsPromise;
  };

  const stopLayer = async (category, { immediate = false } = {}) => {
    const layer = layers.get(category);
    if (!layer) return;
    layers.delete(category);
    if (!immediate) await fadeAudioVolume(layer.audio, 0, layer.kind === 'bgm' ? 720 : 460);
    cleanupLayer(layer);
  };

  const startLayer = async (category, rows, gestureToken = null) => {
    if (stopped || layers.has(category)) {
      gestureToken?.dispose?.();
      return false;
    }
    const candidates = rows.filter((row) => row.category === category);
    const index = stableIndex(`${seed}|${category}`, candidates.length);
    const asset = index >= 0 ? candidates[index] : null;
    if (!asset) {
      gestureToken?.dispose?.();
      return false;
    }
    const playback = createSoundAssetPlayback(asset);
    if (!playback.url) {
      gestureToken?.dispose?.();
      return false;
    }
    const audio = audioFromGestureOrNew(playback.url, gestureToken);
    if (!audio) {
      gestureToken?.dispose?.();
      playback.revoke?.();
      return false;
    }
    const kind = category.startsWith('bgm') ? 'bgm' : 'ambience';
    const baseVolume = kind === 'bgm' ? baseBgmVolume : baseAmbienceVolume;
    const layer = {
      audio,
      category,
      kind,
      baseVolume,
      revoke: playback.revoke,
      stopped: false,
    };
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 0;
    audio.setAttribute('playsinline', 'true');
    try {
      await playAudioWhenReady(audio, { timeoutMs: 12000 });
      if (stopped) {
        cleanupLayer(layer);
        return false;
      }
      layers.set(category, layer);
      await fadeAudioVolume(
        audio,
        resolveAutomaticSoundSpeechMixVolume(baseVolume, kind, speechActive),
        kind === 'bgm' ? 680 : 440,
      );
      return true;
    } catch (_) {
      cleanupLayer(layer);
      return false;
    }
  };

  const updateContext = async (text = '', { gestureTokens = [] } = {}) => {
    if (stopped) {
      (gestureTokens || []).forEach((token) => token?.dispose?.());
      return [];
    }
    const rows = await loadRows();
    const available = [...new Set(rows.map((row) => String(row.category || '').trim()))];
    const desired = inferAutomaticSoundCategories(text, {
      availableCategories: available,
      allowBgm,
      fallbackScene,
    });
    const desiredSet = new Set(desired);
    await Promise.all([...layers.keys()]
      .filter((category) => !desiredSet.has(category))
      .map((category) => stopLayer(category)));
    const tokens = Array.isArray(gestureTokens) ? [...gestureTokens] : [];
    for (const category of desired) {
      if (layers.has(category)) continue;
      await startLayer(category, rows, tokens.shift() || null);
    }
    tokens.forEach((token) => token?.dispose?.());
    return [...layers.keys()];
  };

  const setSpeechActive = async (active) => {
    speechActive = active === true;
    await Promise.all([
      ...[...layers.values()].map((layer) => fadeAudioVolume(
        layer.audio,
        resolveAutomaticSoundSpeechMixVolume(layer.baseVolume, layer.kind, speechActive),
        speechActive ? 110 : 240,
      )),
      ...[...playingCues].map((item) => fadeAudioVolume(
        item.audio,
        resolveAutomaticSoundSpeechMixVolume(item.baseVolume, 'cue', speechActive),
        speechActive ? 70 : 180,
      )),
    ]);
  };

  const playExplicitCues = async (text = '') => {
    if (stopped) return [];
    const stageText = extractExplicitStageSoundText(text);
    if (!stageText) return [];
    const categories = inferNarrationSoundCues(stageText, { max: 3 })
      .filter((category) => CALL_ACTION_CATEGORIES.has(category));
    if (!categories.length) return [];
    const rows = await loadRows();
    const played = [];
    categories.forEach((category, cueIndex) => {
      const candidates = rows.filter((row) => row.category === category);
      const index = stableIndex(`${seed}|cue|${category}|${stageText}|${cueIndex}`, candidates.length);
      const asset = index >= 0 ? candidates[index] : null;
      if (!asset) return;
      const playback = createSoundAssetPlayback(asset);
      if (!playback.url) return;
      const audio = audioFromGestureOrNew(playback.url);
      if (!audio) {
        playback.revoke?.();
        return;
      }
      const item = { audio, revoke: playback.revoke, baseVolume: baseCueVolume };
      playingCues.add(item);
      const cleanup = () => {
        if (!playingCues.has(item)) return;
        playingCues.delete(item);
        try {
          audio.pause();
          audio.removeAttribute('src');
          audio.load?.();
        } catch (_) {}
        playback.revoke?.();
      };
      audio.preload = 'auto';
      audio.volume = 0;
      audio.setAttribute('playsinline', 'true');
      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', cleanup, { once: true });
      playAudioWhenReady(audio, { timeoutMs: 10000 })
        .then(() => fadeAudioVolume(
          audio,
          resolveAutomaticSoundSpeechMixVolume(baseCueVolume, 'cue', speechActive),
          70,
        ))
        .catch(cleanup);
      played.push(category);
    });
    return played;
  };

  const stop = async ({ immediate = false } = {}) => {
    if (stopped) return;
    stopped = true;
    await Promise.all([...layers.keys()].map((category) => stopLayer(category, { immediate })));
    playingCues.forEach((item) => {
      try {
        item.audio.pause();
        item.audio.removeAttribute('src');
        item.audio.load?.();
      } catch (_) {}
      item.revoke?.();
    });
    playingCues.clear();
  };

  return {
    updateContext,
    setSpeechActive,
    playExplicitCues,
    activeCategories: () => [...layers.keys()],
    stop,
  };
}
