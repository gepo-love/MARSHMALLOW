import {
  createVoicePlaybackUrl,
  ensureVoiceAudioForMessage,
  getVoiceCachedAudio,
  getVoiceTextForMessage,
  isVoiceTtsSkipError,
  loadCharacterVoiceProfile,
  loadVoiceToolConfig,
  primeVoicePlayback,
  resolveCharacterVoiceProvider,
} from '../voice-tools.js';
import * as db from '../db.js';
import {
  captureMediaGesture,
  audioFromGestureOrNew,
  playAudioWhenReady,
  takePlayableAudio,
} from '../media-playback.js';
import {
  exportCachedVoicePayload,
  exportCachedVoiceSequence,
  exportMixedVoiceSequence,
} from '../voice-audio-export.js';
import { showToast } from '../../components/toast.js';
import { icon } from '../../components/svg-icons.js';
import { buildVoiceBubbleInnerHtml } from './card-render.js';
import {
  buildTextureSoundSchedule,
  filterTextureSoundAssetsByPlan,
  filterBreathSoundCues,
  inferNarrationContinuousSoundCuesFromMessages,
  inferNarrationSoundCuesFromMessages,
  inferNarrationTexturePlanFromMessages,
  isTextureSoundCategory,
  normalizeBreathSupplementMode,
  resolveNarrationBackgroundBaseVolume,
  resolveNarrationSoundMixVolume,
  resolveSpeechTextureMixVolume,
  resolveSpeechTextureVoiceVolume,
  resolveSoundCueEnvelope,
} from '../sound-cues.js';
import {
  createSoundAssetPlayback,
  listSoundAssets,
  recordSoundAssetPlayback,
} from '../sound-library.js';

let activeVoiceAudio = null;
let activeVoiceButton = null;
let activeVoiceMessageId = '';
let activeVoiceSequenceId = '';
let voiceRequestSeq = 0;
let voiceAbortController = null;
let activeVoiceBackgroundLayers = [];
let activeVoiceTextureBed = null;

/** root -> { getMessages, onRefresh }；事件委托绑一次，冒泡摘节点后再插回也能点。 */
const voiceRootState = new WeakMap();

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resetVoiceButton(btn) {
  if (!btn) return;
  btn.dataset.busy = '0';
  btn.classList.remove('is-loading', 'is-playing');
  btn.innerHTML = icon('play');
}

function cleanupBackgroundLayer(layer = {}) {
  if (layer.stopped) return;
  layer.stopped = true;
  try {
    if (layer.audio) {
      layer.audio.loop = false;
      layer.audio.pause();
      layer.audio.removeAttribute('src');
      layer.audio.load?.();
    }
  } catch (_) {}
  layer.revoke?.();
}

function stopActiveVoiceBackgroundLayers() {
  const layers = activeVoiceBackgroundLayers;
  activeVoiceBackgroundLayers = [];
  layers.forEach(cleanupBackgroundLayer);
}

function stopActiveVoiceTextureBed() {
  const bed = activeVoiceTextureBed;
  activeVoiceTextureBed = null;
  bed?.stop?.();
}

function stopActiveVoice() {
  voiceRequestSeq += 1;
  try { voiceAbortController?.abort?.(); } catch (_) {}
  voiceAbortController = null;
  stopActiveVoiceBackgroundLayers();
  stopActiveVoiceTextureBed();
  try {
    if (activeVoiceAudio) {
      activeVoiceAudio.pause();
      activeVoiceAudio.currentTime = 0;
    }
  } catch (_) {}
  resetVoiceButton(activeVoiceButton);
  activeVoiceAudio = null;
  activeVoiceButton = null;
  activeVoiceMessageId = '';
  activeVoiceSequenceId = '';
}

export function cancelVoiceMessagePlayback() {
  stopActiveVoice();
}

export function isVoiceMessagePlaybackActive(messageId = '') {
  const id = String(messageId || '').trim();
  return !!(id
    && activeVoiceMessageId === id
    && (activeVoiceAudio || voiceAbortController));
}

export function isVoiceMessageSequencePlaybackActive(sequenceId = '') {
  const id = String(sequenceId || '').trim();
  return !!(id
    && activeVoiceSequenceId === id
    && (activeVoiceAudio || voiceAbortController));
}

export function canReadTextBubbleAsVoice(msg = {}) {
  const senderId = String(msg?.senderId || '').trim();
  const type = String(msg?.type || 'text').trim() || 'text';
  if (!senderId || senderId === 'user' || senderId === 'system') return false;
  if (type !== 'text' || msg?.deleted || msg?.recalled) return false;
  return !!getVoiceTextForMessage(msg);
}

function getVoiceCharacterId(msg) {
  if (msg?.metadata?.speechActorId) {
    return String(msg.metadata.speechActorId || '').trim();
  }
  if (msg?.senderId === 'user' && msg?.metadata?.sendAsCharacterId) {
    return String(msg.metadata.sendAsCharacterId || '').trim();
  }
  return String(msg?.senderId || '').trim();
}

function applyAudioMetadata(msg, audioPayload) {
  if (!msg?.id || !audioPayload?.cacheKey) return false;
  const cacheChanged = msg.metadata?.audioCacheKey !== audioPayload.cacheKey;
  const nextMeta = {
    ...(msg.metadata || {}),
    audioCacheKey: audioPayload.cacheKey,
    audioVoiceId: audioPayload.voiceId || msg.metadata?.audioVoiceId || '',
    audioModel: audioPayload.model || msg.metadata?.audioModel || '',
    audioFormat: audioPayload.format || msg.metadata?.audioFormat || '',
    audioGeneratedAt: cacheChanged ? Date.now() : (msg.metadata?.audioGeneratedAt || Date.now()),
  };
  const changed = Object.entries(nextMeta).some(([key, value]) => msg.metadata?.[key] !== value);
  if (changed) msg.metadata = nextMeta;
  return changed;
}

/**
 * 语音生成/连续播放可能持续数秒，期间同一消息会被补译、回应或其它功能更新。
 * 这里只把语音模块拥有的 metadata 字段合并到数据库最新记录，禁止用播放开始时
 * 的整条消息快照覆盖刚保存的 translation 等字段。
 */
export async function mergeVoiceMetadataIntoLatestMessage(msg, fields = []) {
  const id = String(msg?.id || '').trim();
  const keys = [...new Set((Array.isArray(fields) ? fields : []).map(String).filter(Boolean))];
  if (!id || !keys.length) return { updated: false, record: null };
  const patch = {};
  keys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(msg?.metadata || {}, key)) {
      patch[key] = msg.metadata[key];
    }
  });
  if (!Object.keys(patch).length) return { updated: false, record: null };
  const result = await db.updateRecord('messages', id, (current) => (
    current
      ? {
        ...current,
        metadata: {
          ...(current.metadata || {}),
          ...patch,
        },
      }
      : null
  ));
  if (result?.record?.metadata) {
    msg.metadata = { ...result.record.metadata };
  }
  return result;
}

const AUDIO_CACHE_METADATA_FIELDS = [
  'audioCacheKey',
  'audioVoiceId',
  'audioModel',
  'audioFormat',
  'audioGeneratedAt',
];

function markButtonCacheState(button) {
  const card = button?.closest?.('[data-card-type="voice"]');
  const bar = button?.closest?.('.voice-msg-bar');
  if (!card || !bar) return;
  card.classList.add('voice-msg--cached');
  if (!bar.querySelector('.voice-msg-cache-mark')) {
    bar.insertAdjacentHTML('beforeend', '<span class="voice-msg-cache-mark" title="已缓存">●</span>');
  }
}

export async function playVoiceMessage(msg, {
  button = null,
  onRefresh = null,
  gestureToken = null,
  persist = true,
  allowShort = false,
} = {}) {
  const messageId = String(msg?.id || '').trim();
  if (!messageId) {
    gestureToken?.dispose?.();
    return null;
  }
  if (activeVoiceMessageId === messageId && (activeVoiceAudio || voiceAbortController)) {
    gestureToken?.dispose?.();
    stopActiveVoice();
    return null;
  }

  const text = getVoiceTextForMessage(msg);
  const hasCache = !!String(msg.metadata?.audioCacheKey || '').trim();
  if (!text && !hasCache) {
    gestureToken?.dispose?.();
    showToast('这条语音没有可合成的转写文本');
    return null;
  }
  if (msg.senderId === 'user' && !msg.metadata?.sendAsCharacterId && !hasCache) {
    gestureToken?.dispose?.();
    showToast('用户语音只有转写，不会自动合成声线');
    return null;
  }
  if (button?.dataset.busy === '1') {
    gestureToken?.dispose?.();
    stopActiveVoice();
    resetVoiceButton(button);
    return null;
  }

  const requestSeq = ++voiceRequestSeq;
  try { voiceAbortController?.abort?.(); } catch (_) {}
  voiceAbortController = new AbortController();
  if (activeVoiceButton && activeVoiceButton !== button) resetVoiceButton(activeVoiceButton);
  activeVoiceButton = button || null;
  activeVoiceMessageId = messageId;
  activeVoiceSequenceId = '';

  try {
    if (button) {
      button.dataset.busy = '1';
      button.classList.add('is-loading');
      button.innerHTML = '<span class="voice-msg-loading-dot" aria-hidden="true"></span>';
    }

    // 点击时已经有循环音轨承接 iOS 的用户手势；再开 AudioContext / 第二条静音轨
    // 会打断它，等缓存或 TTS 返回后 play() 可能成功但实际无声。
    if (!gestureToken) await primeVoicePlayback().catch(() => {});

    const audioPayload = await ensureVoiceAudioForMessage(msg, {
      characterId: getVoiceCharacterId(msg),
      signal: voiceAbortController.signal,
      allowShort,
    });
    if (!audioPayload) {
      gestureToken?.dispose?.();
      resetVoiceButton(button);
      showToast('语音暂时不可播放，请检查角色声线设置');
      return null;
    }
    if (requestSeq !== voiceRequestSeq) {
      if (audioPayload?.cacheKey) {
        applyAudioMetadata(msg, audioPayload);
        if (persist) {
          await mergeVoiceMetadataIntoLatestMessage(msg, AUDIO_CACHE_METADATA_FIELDS).catch(() => {});
        }
        markButtonCacheState(button);
      }
      gestureToken?.dispose?.();
      resetVoiceButton(button);
      return null;
    }

    const playback = createVoicePlaybackUrl(audioPayload);
    const audioUrl = playback.url;
    if (!audioUrl) throw new Error('没有可播放的音频缓存');

    const metadataChanged = applyAudioMetadata(msg, audioPayload);
    if (metadataChanged && persist) {
      await mergeVoiceMetadataIntoLatestMessage(msg, AUDIO_CACHE_METADATA_FIELDS);
    }
    if (metadataChanged) markButtonCacheState(button);

    if (activeVoiceAudio) {
      try {
        activeVoiceAudio.pause();
        activeVoiceAudio.currentTime = 0;
      } catch (_) {}
    }
    resetVoiceButton(activeVoiceButton);

    const audio = audioFromGestureOrNew(audioUrl, gestureToken);
    if (!audio) throw new Error('没有可播放的音频缓存');
    audio.preload = 'auto';
    audio.setAttribute('playsinline', 'true');
    activeVoiceAudio = audio;
    activeVoiceButton = button || null;
    activeVoiceMessageId = messageId;

    audio.addEventListener('ended', () => {
      if (activeVoiceAudio === audio) {
        activeVoiceAudio = null;
        activeVoiceButton = null;
        activeVoiceMessageId = '';
      }
      resetVoiceButton(button);
      playback.revoke?.();
    }, { once: true });
    audio.addEventListener('error', () => {
      if (activeVoiceAudio === audio) {
        activeVoiceAudio = null;
        activeVoiceButton = null;
        activeVoiceMessageId = '';
      }
      resetVoiceButton(button);
      playback.revoke?.();
    }, { once: true });

    try {
      await playAudioWhenReady(audio);
      if (button) {
        button.dataset.busy = '0';
        button.classList.remove('is-loading');
        button.classList.add('is-playing');
        button.innerHTML = icon('pause');
      }
    } catch (playErr) {
      playback.revoke?.();
      throw playErr;
    }
    if (!audioPayload.fromCache) showToast('语音已生成并写入本地缓存');
    if (metadataChanged && !button) onRefresh?.();
    return audio;
  } catch (err) {
    if (requestSeq !== voiceRequestSeq) {
      gestureToken?.dispose?.();
      resetVoiceButton(button);
      return null;
    }
    if (activeVoiceMessageId === messageId) stopActiveVoice();
    else resetVoiceButton(button);
    throw err;
  } finally {
    gestureToken?.dispose?.();
    if (requestSeq === voiceRequestSeq) voiceAbortController = null;
  }
}

export async function playTextBubbleAsVoice(msg, options = {}) {
  if (!canReadTextBubbleAsVoice(msg)) {
    options.gestureToken?.dispose?.();
    throw new Error('这条消息没有可朗读的角色文字');
  }
  return playVoiceMessage(msg, {
    ...options,
    allowShort: true,
  });
}

function messageSpeechText(msg = {}) {
  return String(
    msg?.metadata?.speechPlan?.text
    || msg?.metadata?.text
    || msg?.content
    || '',
  ).trim();
}

function isVoiceRoundNarration(msg = {}) {
  return msg?.metadata?.narratorBeat === true
    && !msg?.deleted
    && !msg?.recalled;
}

function voiceRoundActorId(msg = {}) {
  return getVoiceCharacterId(msg);
}

function voiceRoundSpeechPlan(msg = {}) {
  const text = messageSpeechText(msg);
  if (!text) return null;
  const raw = msg?.metadata?.speechPlan || {};
  const emotion = String(raw.emotion || 'neutral').trim().toLowerCase() || 'neutral';
  const pace = ['slow', 'fast'].includes(String(raw.pace || '').trim().toLowerCase())
    ? String(raw.pace).trim().toLowerCase()
    : 'normal';
  const intensity = Math.max(0, Math.min(1, Number(raw.intensity ?? 0) || 0));
  const performanceDirection = String(
    raw.performanceDirection
    || raw.direction
    || '',
  ).trim().slice(0, 240);
  return {
    text,
    emotion,
    pace,
    intensity,
    ...(performanceDirection ? { performanceDirection } : {}),
  };
}

/**
 * 气泡之间只补“换一口气”的留白；气泡内部的停顿仍由 speech.text 标签和标点负责。
 * 同一角色接着说比换角色接话更紧，省略号和慢速表演会多留一点余韵。
 */
export function resolveVoiceSequenceGapMs(previous = {}, next = {}, options = {}) {
  const previousText = messageSpeechText(previous);
  const sameActor = String(previous?.senderId || '').trim() === String(next?.senderId || '').trim();
  const bubbleGapMs = normalizeVoiceRoundGapMs(options.bubbleGapMs);
  let gap = sameActor ? bubbleGapMs : bubbleGapMs + 240;
  if (/(?:…{2,}|\.{3,})[”’"'）)]?\s*$/.test(previousText)) gap += 140;
  else if (/[,，、；;：:][”’"'）)]?\s*$/.test(previousText)) gap -= 120;
  const previousPace = String(previous?.metadata?.speechPlan?.pace || '').trim();
  const nextPace = String(next?.metadata?.speechPlan?.pace || '').trim();
  if (previousPace === 'slow' || nextPace === 'slow') gap += 100;
  if (previousPace === 'fast' && nextPace === 'fast') gap -= 70;
  return Math.max(120, Math.min(5600, Math.round(gap)));
}

export function normalizeVoiceRoundGapMs(value = 400) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 400;
  return Math.max(200, Math.min(5000, Math.round(numeric / 100) * 100));
}

function narrationBoundaryPauseMs(narrations = [], previous = {}, next = {}, options = {}) {
  const text = narrations
    .map((item) => String(item?.content || item?.metadata?.text || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!text) return resolveVoiceSequenceGapMs(previous, next, options);
  const compactLength = text.replace(/\s+/g, '').length;
  let gap = compactLength <= 18
    ? 720
    : compactLength <= 48
      ? 860
      : compactLength <= 96
        ? 1020
        : 1160;
  if (/(?:…{2,}|\.{3,})[”’"'）)]?\s*$/.test(messageSpeechText(previous))) gap += 120;
  const previousPace = String(previous?.metadata?.speechPlan?.pace || '').trim();
  const nextPace = String(next?.metadata?.speechPlan?.pace || '').trim();
  if (previousPace === 'slow' || nextPace === 'slow') gap += 80;
  if (narrations.length > 1) gap += Math.min(120, (narrations.length - 1) * 50);
  gap += normalizeVoiceRoundGapMs(options.bubbleGapMs) - 400;
  return Math.max(480, Math.min(6000, Math.round(gap)));
}

function shouldSplitVoiceRoundChunk(previous = {}, next = {}, currentChunkTextLength = 0) {
  if (voiceRoundActorId(previous) !== voiceRoundActorId(next)) return true;
  const previousPlan = voiceRoundSpeechPlan(previous);
  const nextPlan = voiceRoundSpeechPlan(next);
  if (!previousPlan || !nextPlan) return true;
  if (currentChunkTextLength + nextPlan.text.length > 9200) return true;
  if (previousPlan.emotion === nextPlan.emotion) return false;
  const strongest = Math.max(previousPlan.intensity, nextPlan.intensity);
  const delta = Math.abs(previousPlan.intensity - nextPlan.intensity);
  return strongest >= 0.72 || delta >= 0.5;
}

function aggregateVoiceRoundSpeechPlan(items = [], text = '') {
  const plans = items.map(voiceRoundSpeechPlan).filter(Boolean);
  const emotions = [...new Set(plans.map((plan) => plan.emotion).filter((emotion) => emotion !== 'neutral'))];
  const emotion = emotions.length === 1 ? emotions[0] : 'neutral';
  const relevantIntensities = emotion === 'neutral'
    ? plans.map((plan) => plan.intensity)
    : plans.filter((plan) => plan.emotion === emotion).map((plan) => plan.intensity);
  const intensity = relevantIntensities.length
    ? relevantIntensities.reduce((sum, value) => sum + value, 0) / relevantIntensities.length
    : 0;
  const paceCounts = plans.reduce((counts, plan) => {
    counts[plan.pace] = (counts[plan.pace] || 0) + 1;
    return counts;
  }, {});
  const pace = ['normal', 'slow', 'fast'].sort((a, b) => (
    (paceCounts[b] || 0) - (paceCounts[a] || 0)
  ))[0] || 'normal';
  return {
    text,
    emotion,
    pace,
    intensity: Math.round(Math.max(0, Math.min(1, intensity)) * 100) / 100,
    ...(plans.find((plan) => plan.performanceDirection)?.performanceDirection
      ? { performanceDirection: plans.find((plan) => plan.performanceDirection).performanceDirection }
      : {}),
  };
}

function voiceRoundChunkSignature(chunk = {}) {
  const raw = [
    chunk.actorId,
    chunk.provider,
    ...(chunk.messageIds || []),
    chunk.speechPlan?.text,
    chunk.speechPlan?.emotion,
    chunk.speechPlan?.pace,
    chunk.speechPlan?.intensity,
    chunk.speechPlan?.performanceDirection,
    ...(chunk.soundCuesBefore || []),
    ...(chunk.soundCuesAfter || []),
    ...(chunk.texturePlan?.categories || []),
    chunk.texturePlan?.intensity,
    chunk.texturePlan?.tempo,
  ].join('|');
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 将一轮可见消息整理成实际 TTS 请求：
 * - 同角色的连续气泡合成一次，让当前 TTS 提供商看见完整上下文；
 * - 穿插旁白不朗读，只折算为受控停顿；
 * - 换角色、强烈情绪跳变或单次文本过长时拆段。
 */
export function buildVoiceRoundSynthesisPlan(roundMessages = [], options = {}) {
  const source = (Array.isArray(roundMessages) ? roundMessages : [])
    .filter((message) => message && !message.deleted && !message.recalled);
  const chunks = [];
  let current = null;
  let previousSpeech = null;
  let pendingNarrations = [];
  let activeTexturePlan = null;

  const finishCurrent = () => {
    if (!current?.items?.length) return;
    current.speechPlan = aggregateVoiceRoundSpeechPlan(current.items, current.text);
    current.visibleText = current.items
      .map((item) => String(item?.metadata?.text || item?.content || '').trim())
      .filter(Boolean)
      .join('');
    current.signature = voiceRoundChunkSignature(current);
    delete current.items;
    chunks.push(current);
    current = null;
  };

  source.forEach((message) => {
    if (isVoiceRoundNarration(message)) {
      pendingNarrations.push(message);
      return;
    }
    if (!canReadTextBubbleAsVoice(message)) return;
    const plan = voiceRoundSpeechPlan(message);
    if (!plan) return;
    const actorId = voiceRoundActorId(message);
    if (!actorId) return;
    const actorProvider = resolveCharacterVoiceProvider(
      { provider: options.providerByActor?.[actorId] },
      options.provider,
    );
    const narrationSoundCues = options.soundEffectsEnabled
      ? filterBreathSoundCues(
        inferNarrationSoundCuesFromMessages(pendingNarrations, { max: 3 }),
        options.breathSupplementByActor?.[actorId],
      )
      : [];
    const speechHasDeclaredSound = Array.isArray(message?.metadata?.soundCueCategories)
      && message.metadata.soundCueCategories.length > 0;
    const textureUpdate = options.soundEffectsEnabled
      ? inferNarrationTexturePlanFromMessages([
        ...pendingNarrations,
        ...(speechHasDeclaredSound ? [message] : []),
      ])
      : null;
    if (textureUpdate?.stop) activeTexturePlan = null;
    else if (textureUpdate?.categories?.length) activeTexturePlan = { ...textureUpdate };
    const nextTexturePlan = textureUpdate?.stop
      ? textureUpdate
      : (activeTexturePlan ? { ...activeTexturePlan } : null);
    const soundCuesBefore = narrationSoundCues.filter((category) => (
      !isTextureSoundCategory(category)
    ));

    const split = !!(current && previousSpeech
      && (narrationSoundCues.length > 0
        || nextTexturePlan?.stop
        || speechHasDeclaredSound
        // Fish 不执行精确秒数停顿标签；逐气泡合成后由播放器落实真实静音。
        || actorProvider === 'fish'
        || shouldSplitVoiceRoundChunk(previousSpeech, message, current.text.length)));
    const gapMs = previousSpeech
      ? narrationBoundaryPauseMs(pendingNarrations, previousSpeech, message, options)
      : 0;
    if (split) finishCurrent();
    if (!current) {
      current = {
        actorId,
        provider: actorProvider,
        messageIds: [],
        items: [],
        text: '',
        gapBeforeMs: chunks.length ? gapMs : 0,
        soundCuesBefore,
        // 动作纹理是本轮状态层：开始后跨后续对白延续，直到旁白明确停止或切换。
        texturePlan: nextTexturePlan?.categories?.length ? { ...nextTexturePlan } : null,
      };
    } else if (previousSpeech) {
      const pauseSeconds = Math.max(0.12, Math.min(1.8, gapMs / 1000));
      current.text += `<#${pauseSeconds.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}#>`;
    }
    current.text += plan.text;
    current.items.push(message);
    current.messageIds.push(String(message.id || '').trim());
    previousSpeech = message;
    pendingNarrations = [];
  });
  if (current && options.soundEffectsEnabled && pendingNarrations.length) {
    current.soundCuesAfter = filterBreathSoundCues(
      inferNarrationSoundCuesFromMessages(pendingNarrations, { max: 3 }),
      options.breathSupplementByActor?.[current.actorId],
    );
  }
  finishCurrent();
  return chunks;
}

function waitForSequenceDelay(ms, signal) {
  const delay = Math.max(0, Number(ms || 0));
  if (!delay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      const err = new Error('已停止播放');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function waitForSequenceAudioEnd(audio, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      audio?.removeEventListener?.('ended', onEnded);
      audio?.removeEventListener?.('error', onError);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('音频播放失败'));
    };
    const onAbort = () => {
      cleanup();
      const err = new Error('已停止播放');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    audio.addEventListener('ended', onEnded, { once: true });
    audio.addEventListener('error', onError, { once: true });
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function findVoiceRoundCache(message = {}, roundId = '', signature = '') {
  const cache = message?.metadata?.voiceRoundAudioCache;
  if (!cache || Number(cache.version || 0) < 1 || String(cache.roundId || '') !== String(roundId || '')) return null;
  return (Array.isArray(cache.chunks) ? cache.chunks : [])
    .find((item) => String(item?.signature || '') === String(signature || '')) || null;
}

function applyVoiceRoundCache(message = {}, roundId = '', cacheRows = [], {
  provider = '',
  bubbleGapMs = 400,
  chunks = [],
} = {}) {
  if (!message?.id) return false;
  const next = {
    version: 3,
    roundId: String(roundId || ''),
    provider: ['fish', 'minimax', 'mixed'].includes(provider) ? provider : 'minimax',
    bubbleGapMs: normalizeVoiceRoundGapMs(bubbleGapMs),
    chunks: cacheRows.map((item, index) => ({
      signature: String(item.signature || ''),
      cacheKey: String(item.cacheKey || ''),
      voiceId: String(item.voiceId || ''),
      model: String(item.model || ''),
      format: String(item.format || ''),
      provider: ['fish', 'minimax'].includes(String(item.provider || ''))
        ? String(item.provider)
        : String(chunks[index]?.provider || ''),
      messageIds: Array.isArray(chunks[index]?.messageIds)
        ? chunks[index].messageIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [],
      gapBeforeMs: Math.max(0, Math.round(Number(chunks[index]?.gapBeforeMs || 0))),
    })),
    generatedAt: Date.now(),
  };
  const before = JSON.stringify(message.metadata?.voiceRoundAudioCache || null);
  const after = JSON.stringify(next);
  if (before === after) return false;
  message.metadata = {
    ...(message.metadata || {}),
    voiceRoundAudioCache: next,
  };
  return true;
}

async function ensureVoiceRoundChunkAudio(chunk, {
  roundId = '',
  cacheOwner = null,
  signal,
} = {}) {
  const cached = findVoiceRoundCache(cacheOwner, roundId, chunk.signature);
  const syntheticMessage = {
    id: `voice-round-${roundId}-${chunk.signature}`,
    senderId: chunk.actorId,
    type: 'text',
    content: chunk.visibleText,
    metadata: {
      speechActorId: chunk.actorId,
      speechPlan: chunk.speechPlan,
      ...(cached?.cacheKey ? { audioCacheKey: cached.cacheKey } : {}),
    },
  };
  const audioPayload = await ensureVoiceAudioForMessage(syntheticMessage, {
    characterId: chunk.actorId,
    signal,
    allowShort: true,
  });
  if (!audioPayload) throw new Error('语音暂时不可播放，请检查角色声线设置');
  return {
    audioPayload,
    cacheRow: {
      signature: chunk.signature,
      cacheKey: audioPayload.cacheKey,
      voiceId: audioPayload.voiceId,
      model: audioPayload.model,
      format: audioPayload.format,
      provider: audioPayload.provider || chunk.provider,
    },
  };
}

function stableSoundAssetIndex(seed = '', length = 0) {
  if (!length) return -1;
  let hash = 2166136261;
  const source = String(seed || '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function buildSoundAssetPools(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((map, row) => {
    if (!(row?.audioBlob instanceof Blob) || row.enabled === false) return map;
    const category = String(row.category || '').trim();
    if (!category) return map;
    if (!map.has(category)) map.set(category, []);
    map.get(category).push(row);
    return map;
  }, new Map());
}

function selectSoundAsset(pool, category = '', seed = '') {
  const normalizedCategory = String(category || '').trim();
  const exactRows = pool.get(normalizedCategory) || [];
  const rows = (!exactRows.length && normalizedCategory.startsWith('bgm_'))
    ? (pool.get('bgm') || [])
    : exactRows;
  const index = stableSoundAssetIndex(`${seed}|${category}`, rows.length);
  return index >= 0 ? rows[index] : null;
}

function soundAssetsForCategory(pool, category = '') {
  const normalizedCategory = String(category || '').trim();
  const exactRows = pool.get(normalizedCategory) || [];
  return (!exactRows.length && normalizedCategory.startsWith('bgm_'))
    ? (pool.get('bgm') || [])
    : exactRows;
}

function soundAssetsForTexturePlan(pool, category = '', plan = {}) {
  return filterTextureSoundAssetsByPlan(soundAssetsForCategory(pool, category), category, plan);
}

function selectTextureSoundAsset(pool, category = '', assetIndex = 0, plan = {}) {
  const rows = soundAssetsForTexturePlan(pool, category, plan);
  if (!rows.length) return null;
  const index = Math.abs(Math.round(Number(assetIndex || 0))) % rows.length;
  return rows[index] || null;
}

function resolveSoundCueSelections(categories = [], {
  pool,
  seed = '',
  volume = 0.58,
} = {}) {
  const normalizedVolume = normalizeMixVolume(volume, 0.58);
  if (normalizedVolume <= 0) return [];
  return categories.map((category, index) => {
    const asset = selectSoundAsset(pool, category, `${seed}|${index}`);
    return asset ? {
      asset,
      category,
      volume: resolveNarrationSoundMixVolume(normalizedVolume, category),
    } : null;
  }).filter(Boolean);
}

function resolveBackgroundSoundSelections(categories = [], {
  pool,
  seed = '',
  volume = 0.22,
} = {}) {
  const uniqueCategories = [...new Set(categories)].slice(0, 2);
  const baseVolume = resolveNarrationBackgroundBaseVolume(volume);
  if (baseVolume <= 0) return [];
  return uniqueCategories.map((category, index) => {
    const asset = selectSoundAsset(pool, category, `${seed}|background|${index}`);
    if (!asset) return null;
    return {
      asset,
      category,
      volume: resolveNarrationSoundMixVolume(baseVolume, category, {
        layerScale: uniqueCategories.length > 1 ? 0.86 : 1,
      }),
    };
  }).filter(Boolean);
}

function normalizeMixVolume(value, fallback = 0.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, normalized));
}

function fadeAudioVolume(audio, target, durationMs = 180) {
  if (!audio) return Promise.resolve();
  const from = Math.max(0, Math.min(1, Number(audio.volume || 0)));
  const to = Math.max(0, Math.min(1, Number(target || 0)));
  const duration = Math.max(0, Number(durationMs || 0));
  if (!duration || Math.abs(from - to) < 0.005) {
    audio.volume = to;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      try { audio.volume = from + ((to - from) * progress); } catch (_) {}
      if (progress >= 1 || audio.paused) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function stopBackgroundSoundLayers(layers = [], {
  natural = false,
  fadeMs = 180,
} = {}) {
  const active = layers.filter((layer) => !layer?.stopped);
  if (natural && active.length) {
    await new Promise((resolve) => setTimeout(resolve, 360));
  }
  await Promise.all(active.map((layer) => {
    const naturalFade = layer.kind === 'bgm' ? 1250 : 720;
    return fadeAudioVolume(layer.audio, 0, natural ? naturalFade : fadeMs);
  }));
  active.forEach(cleanupBackgroundLayer);
}

async function setBackgroundLayersDucked(layers = [], ducked = false) {
  await Promise.all(layers
    .filter((layer) => !layer?.stopped)
    .map((layer) => fadeAudioVolume(
      layer.audio,
      layer.baseVolume * (ducked ? (layer.kind === 'bgm' ? 0.54 : 0.76) : 1),
      ducked ? 120 : 220,
    )));
}

function createTexturePlaybackPool(gestureTokens = []) {
  const pendingTokens = Array.isArray(gestureTokens) ? [...gestureTokens] : [];
  const slots = new Map();
  const reusableSlots = [];
  let reuseCursor = 0;
  return {
    take(category = '', src = '', { persistent = false } = {}) {
      const key = String(category || '').trim();
      let slot = slots.get(key);
      if (!slot) {
        const gesture = pendingTokens.shift() || null;
        // iOS 只允许用户手势内预解锁有限数量的媒体元素。长轮次出现超过
        // 预留数量的音效分类时，继续创建未解锁 Audio 会让后半轮音效静默失败。
        // 手势槽用尽后轮换复用已有槽；并发超过槽数时宁可替换最早的纹理，
        // 也不要让后续所有旁白音效都变成无声。
        const reusable = reusableSlots.filter((candidate) => candidate.persistent !== true);
        slot = gesture || !reusableSlots.length
          ? { gesture, audio: null, owner: 0, persistent: false }
          : reusable.length
            ? reusable[reuseCursor++ % reusable.length]
            : null;
        if (!slot) return null;
        if (persistent) slot.persistent = true;
        if (!reusableSlots.includes(slot)) reusableSlots.push(slot);
        slots.set(key, slot);
      }
      const audio = takePlayableAudio(src, slot);
      if (!audio) return null;
      slot.owner += 1;
      const owner = slot.owner;
      return {
        audio,
        isCurrent: () => slot.owner === owner,
        release: () => {
          if (slot.owner === owner) slot.persistent = false;
        },
      };
    },
    dispose() {
      pendingTokens.forEach((token) => token?.dispose?.());
      pendingTokens.length = 0;
      new Set(slots.values()).forEach((slot) => {
        slot.owner += 1;
        slot.gesture?.dispose?.();
        try {
          slot.audio?.pause?.();
          slot.audio?.removeAttribute?.('src');
          slot.audio?.load?.();
        } catch (_) {}
      });
      slots.clear();
      reusableSlots.length = 0;
    },
  };
}

function startTextureSoundBed(plan = null, {
  pool,
  playbackPool = null,
  seed = '',
  durationMs = 0,
  volume = 0.58,
  speechAudio = null,
  signal,
} = {}) {
  const baseVolume = normalizeMixVolume(volume, 0.58);
  if (baseVolume <= 0) return { stop() {}, schedule: [] };
  const schedule = buildTextureSoundSchedule(plan, { durationMs, seed });
  const timedPlan = { ...(plan || {}), durationMs };
  const scheduledAssets = schedule.map((event) => (
    selectTextureSoundAsset(pool, event.category, event.assetIndex, timedPlan)
  ));
  const originalSpeechVolume = speechAudio
    ? Math.max(0, Math.min(1, Number(speechAudio.volume || 1)))
    : 1;
  if (speechAudio && scheduledAssets.some(Boolean)) {
    speechAudio.volume = Math.min(
      originalSpeechVolume,
      resolveSpeechTextureVoiceVolume(scheduledAssets.map((asset) => asset?.mixGain || 1)),
    );
  }
  const timers = new Set();
  const playing = new Set();
  let stopped = false;
  const onAbort = () => stop();
  const cleanupItem = (item) => {
    if (!item || !playing.has(item)) return;
    playing.delete(item);
    item.audio.removeEventListener('ended', item.release);
    item.audio.removeEventListener('error', item.release);
    if (item.lease?.isCurrent?.()) {
      try {
        item.audio.pause();
        item.audio.removeAttribute('src');
        item.audio.load?.();
      } catch (_) {}
    }
    item.lease?.release?.();
    item.revoke?.();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener?.('abort', onAbort);
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    playing.forEach((item) => cleanupItem(item));
    if (speechAudio) speechAudio.volume = originalSpeechVolume;
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  schedule.forEach((event, index) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped || signal?.aborted) return;
      if ([...playing].some((item) => item.category === event.category)) return;
      const asset = scheduledAssets[index];
      if (!asset) return;
      const playback = createSoundAssetPlayback(asset);
      if (!playback.url) return;
      const lease = playbackPool?.take?.(event.category, playback.url);
      const audio = lease?.audio || null;
      if (!audio || !lease) {
        playback.revoke?.();
        return;
      }
      const item = {
        audio,
        lease,
        revoke: playback.revoke,
        category: event.category,
        release: null,
      };
      playing.add(item);
      audio.volume = 0;
      const release = () => cleanupItem(item);
      item.release = release;
      audio.addEventListener('ended', release, { once: true });
      audio.addEventListener('error', release, { once: true });
      playAudioWhenReady(audio)
        .then(() => {
          if (stopped || signal?.aborted) {
            release();
            return null;
          }
          // playAudioWhenReady 会先把复用音频元素归一到 1x；真正开始播放后
          // 再应用纹理节奏，确保实时播放与 WAV 导出的确定性计划一致。
          audio.playbackRate = event.playbackRate;
          void recordSoundAssetPlayback(asset, {
            category: event.category,
            layer: 'texture',
          });
          try {
            audio.preservesPitch = false;
            audio.webkitPreservesPitch = false;
          } catch (_) {}
          return fadeAudioVolume(
            audio,
            Math.min(1, resolveSpeechTextureMixVolume(
              baseVolume,
              event.gain,
              event.category,
            ) * Math.max(0.5, Math.min(2, Number(asset?.mixGain || 1) || 1))),
            80,
          );
        })
        .catch(release);
    }, event.offsetMs);
    timers.add(timer);
  });
  return { stop, schedule };
}

async function startBackgroundSoundLayers(categories = [], {
  pool,
  seed = '',
  gestureTokens = [],
  volume = 0.22,
} = {}) {
  const tokens = Array.isArray(gestureTokens) ? [...gestureTokens] : [];
  const selections = resolveBackgroundSoundSelections(categories, {
    pool,
    seed,
    volume,
  });
  const layers = [];
  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    const { asset, category } = selection;
    const token = tokens.shift() || null;
    const playback = createSoundAssetPlayback(asset);
    if (!playback.url) {
      token?.dispose?.();
      continue;
    }
    const audio = audioFromGestureOrNew(playback.url, token);
    if (!audio) {
      playback.revoke?.();
      token?.dispose?.();
      continue;
    }
    const layer = {
      audio,
      category,
      kind: String(category).startsWith('bgm') ? 'bgm' : 'ambience',
      baseVolume: Math.max(0, Math.min(1, selection.volume)),
      revoke: playback.revoke,
      stopped: false,
    };
    audio.loop = true;
    audio.volume = 0;
    try {
      await playAudioWhenReady(audio);
      void recordSoundAssetPlayback(asset, { category, layer: 'background' });
      layers.push(layer);
    } catch (_) {
      cleanupBackgroundLayer(layer);
    }
  }
  tokens.forEach((token) => token?.dispose?.());
  await Promise.all(layers.map((layer) => fadeAudioVolume(
    layer.audio,
    layer.baseVolume,
    layer.kind === 'bgm' ? 720 : 520,
  )));
  return layers;
}

async function playSoundCueCategories(categories = [], {
  pool,
  seed = '',
  slot,
  overlayPool = null,
  allowLongOverlay = false,
  signal,
  volume = 0.58,
} = {}) {
  let played = 0;
  const overlays = [];
  const selections = resolveSoundCueSelections(categories, { pool, seed, volume });
  for (let index = 0; index < selections.length; index += 1) {
    const { asset, category, volume: selectionVolume } = selections[index];
    const playback = createSoundAssetPlayback(asset);
    if (!playback.url) continue;
    const assetDurationMs = Math.max(0, Number(asset?.durationMs || 0));
    const shouldOverlay = allowLongOverlay
      && !!overlayPool
      && (assetDurationMs >= 2200 || asset?.texturePlayback === 'span');
    if (shouldOverlay) {
      const lease = overlayPool.take(`cue-overlay:${category}`, playback.url, { persistent: true });
      const audio = lease?.audio || null;
      if (!audio || !lease) {
        playback.revoke?.();
        continue;
      }
      let stopped = false;
      let fadeTimer = 0;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (fadeTimer) clearTimeout(fadeTimer);
        signal?.removeEventListener?.('abort', stop);
        audio.removeEventListener('ended', stop);
        audio.removeEventListener('error', stop);
        if (lease.isCurrent?.()) {
          try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load?.();
          } catch (_) {}
        }
        lease.release?.();
        playback.revoke?.();
      };
      audio.volume = 0;
      try {
        await playAudioWhenReady(audio);
        void recordSoundAssetPlayback(asset, { category, layer: 'cue' });
        const envelope = resolveSoundCueEnvelope(category, assetDurationMs);
        void fadeAudioVolume(audio, Math.min(0.95, selectionVolume), envelope.fadeInMs);
        if (assetDurationMs > 0) {
          fadeTimer = setTimeout(() => {
            fadeTimer = 0;
            void fadeAudioVolume(audio, 0, envelope.fadeOutMs);
          }, Math.max(envelope.fadeInMs, assetDurationMs - envelope.fadeOutMs));
        }
        audio.addEventListener('ended', stop, { once: true });
        audio.addEventListener('error', stop, { once: true });
        signal?.addEventListener?.('abort', stop, { once: true });
        overlays.push({ stop, category, isActive: () => !stopped });
        played += 1;
        continue;
      } catch (_) {
        stop();
        continue;
      }
    }
    const audio = takePlayableAudio(playback.url, slot);
    if (!audio) {
      playback.revoke?.();
      continue;
    }
    activeVoiceAudio = audio;
    audio.volume = 0;
    let fadeTimer = 0;
    let envelope = resolveSoundCueEnvelope(category);
    try {
      await playAudioWhenReady(audio);
      void recordSoundAssetPlayback(asset, { category, layer: 'cue' });
      const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration * 1000
        : Number(asset?.durationMs || 0);
      envelope = resolveSoundCueEnvelope(category, durationMs);
      void fadeAudioVolume(audio, selectionVolume, envelope.fadeInMs);
      if (durationMs > 0) {
        fadeTimer = setTimeout(() => {
          fadeTimer = 0;
          void fadeAudioVolume(audio, 0, envelope.fadeOutMs);
        }, Math.max(envelope.fadeInMs, durationMs - envelope.fadeOutMs));
      }
      await waitForSequenceAudioEnd(audio, signal);
      played += 1;
    } finally {
      if (fadeTimer) clearTimeout(fadeTimer);
      playback.revoke?.();
    }
    if (index < selections.length - 1) {
      await waitForSequenceDelay(Math.max(48, envelope.postGapMs), signal);
    }
  }
  return { played, overlays };
}

export async function playTextBubbleSequenceAsVoice(sequence = [], {
  sequenceId = '',
  button = null,
  gestureToken = null,
  onRefresh = null,
  persist = true,
  bubbleGapMs = 400,
  soundEffectsEnabled = false,
  soundOwnerId = '',
  soundEffectsVolume = 0.58,
  backgroundVolume = 0.22,
  backgroundGestureTokens = [],
  textureGestureTokens = [],
} = {}) {
  const roundMessages = Array.isArray(sequence) ? sequence : [];
  const ambientGestureTokens = Array.isArray(backgroundGestureTokens)
    ? backgroundGestureTokens
    : [];
  const textureTokens = Array.isArray(textureGestureTokens)
    ? textureGestureTokens
    : [];
  const voiceConfig = await loadVoiceToolConfig().catch(() => null);
  const speechMessages = roundMessages.filter(canReadTextBubbleAsVoice);
  const globalProvider = voiceConfig?.provider === 'fish' ? 'fish' : 'minimax';
  const actorIds = [...new Set(speechMessages.map(voiceRoundActorId).filter(Boolean))];
  const profileByActor = Object.fromEntries(await Promise.all(actorIds.map(async (actorId) => {
    const profile = await loadCharacterVoiceProfile(actorId).catch(() => ({}));
    return [actorId, profile];
  })));
  const providerByActor = Object.fromEntries(actorIds.map((actorId) => [
    actorId,
    resolveCharacterVoiceProvider(profileByActor[actorId], globalProvider),
  ]));
  const breathSupplementByActor = Object.fromEntries(actorIds.map((actorId) => [
    actorId,
    normalizeBreathSupplementMode(profileByActor[actorId]?.breathSupplementMode),
  ]));
  const selectedProviders = [...new Set(Object.values(providerByActor))];
  const provider = selectedProviders.length > 1 ? 'mixed' : (selectedProviders[0] || globalProvider);
  const chunks = buildVoiceRoundSynthesisPlan(roundMessages, {
    bubbleGapMs,
    provider: globalProvider,
    providerByActor,
    breathSupplementByActor,
    soundEffectsEnabled,
  });
  const id = String(sequenceId || speechMessages[0]?.metadata?.aiRoundId || '').trim();
  if (!chunks.length || !speechMessages.length || !id) {
    gestureToken?.dispose?.();
    ambientGestureTokens.forEach((token) => token?.dispose?.());
    textureTokens.forEach((token) => token?.dispose?.());
    throw new Error('这一轮没有可朗读的角色文字');
  }
  if (isVoiceMessageSequencePlaybackActive(id)) {
    gestureToken?.dispose?.();
    ambientGestureTokens.forEach((token) => token?.dispose?.());
    textureTokens.forEach((token) => token?.dispose?.());
    stopActiveVoice();
    return null;
  }

  stopActiveVoice();
  const requestSeq = ++voiceRequestSeq;
  voiceAbortController = new AbortController();
  const signal = voiceAbortController.signal;
  activeVoiceButton = button || null;
  activeVoiceMessageId = String(speechMessages[0]?.id || '').trim();
  activeVoiceSequenceId = id;
  const slot = { gesture: gestureToken || null, audio: null };
  const texturePlaybackPool = createTexturePlaybackPool(textureTokens);
  const cacheOwner = speechMessages[speechMessages.length - 1];
  const cacheRows = [];
  let generatedCount = 0;
  const soundCueCategories = [...new Set(chunks.flatMap((chunk) => [
    ...(chunk.soundCuesBefore || []),
    ...(chunk.soundCuesAfter || []),
  ]))];
  const textureCategories = [...new Set(chunks.flatMap((chunk) => (
    chunk.texturePlan?.categories || []
  )))];
  const backgroundCategories = soundEffectsEnabled
    ? inferNarrationContinuousSoundCuesFromMessages(roundMessages)
    : [];
  const soundAssetPool = (soundCueCategories.length || textureCategories.length || backgroundCategories.length)
    ? buildSoundAssetPools(await listSoundAssets({
      ownerId: soundOwnerId,
      categories: [...soundCueCategories, ...textureCategories, ...backgroundCategories],
      limitPerCategory: 12,
    }).catch(() => []))
    : new Map();
  let backgroundLayers = [];
  // 长动作声属于整轮时间线，不属于某一条 TTS。旁白触发后跨后续语音段保留，
  // 直到自然播完、整轮结束或用户主动停止，避免每个气泡结束时被截断重播。
  const roundCueOverlays = [];
  let completedNaturally = false;

  if (button) {
    button.dataset.busy = '1';
    button.classList.add('is-loading');
    button.innerHTML = '<span class="voice-msg-loading-dot" aria-hidden="true"></span>';
  }
  if (!gestureToken) await primeVoicePlayback().catch(() => {});

  const prepare = (chunk) => ensureVoiceRoundChunkAudio(chunk, {
    roundId: id,
    cacheOwner,
    signal,
  })
    .then((value) => ({ value, error: null }))
    .catch((error) => ({ value: null, error }));
  const preparedByIndex = new Map();
  const preparedFor = (index) => {
    if (index < 0 || index >= chunks.length) return null;
    if (!preparedByIndex.has(index)) preparedByIndex.set(index, prepare(chunks[index]));
    return preparedByIndex.get(index);
  };
  // 短气泡可能比下一次 TTS 请求更快播完。保持两段前瞻，避免每个气泡结束后
  // 才发现下一段仍在网络等待；同时限制并发，不对语音服务形成整轮突发请求。
  preparedFor(0);
  preparedFor(1);

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const result = await preparedFor(index);
      if (result.error) throw result.error;
      if (requestSeq !== voiceRequestSeq || signal.aborted) return null;
      const { audioPayload, cacheRow } = result.value;
      cacheRows.push(cacheRow);
      if (!audioPayload.fromCache) generatedCount += 1;
      preparedFor(index + 2);

      // 等首段 TTS 真正准备好再起背景，避免用户在网络等待期间先听很久 BGM，
      // 角色开口时歌曲反而已经播到不合适的位置。
      if (index === 0) {
        if (backgroundCategories.length) {
          backgroundLayers = await startBackgroundSoundLayers(backgroundCategories, {
            pool: soundAssetPool,
            seed: id,
            gestureTokens: ambientGestureTokens,
            volume: backgroundVolume,
          });
          activeVoiceBackgroundLayers = backgroundLayers;
        } else {
          ambientGestureTokens.forEach((token) => token?.dispose?.());
        }
      }

      const nextChunk = chunks[index + 1] || null;
      if (chunk.soundCuesBefore?.length) {
        const activeOverlayCategories = new Set(roundCueOverlays
          .filter((item) => item.isActive?.() !== false)
          .map((item) => item.category));
        const cueResult = await playSoundCueCategories(
          chunk.soundCuesBefore.filter((category) => !activeOverlayCategories.has(category)), {
          pool: soundAssetPool,
          seed: `${id}|${chunk.signature}|before`,
          slot,
          overlayPool: texturePlaybackPool,
          allowLongOverlay: true,
          signal,
          volume: soundEffectsVolume,
          },
        );
        roundCueOverlays.push(...cueResult.overlays);
        await waitForSequenceDelay(resolveSoundCueEnvelope(
          chunk.soundCuesBefore.at(-1),
        ).postGapMs, signal);
      }
      const playback = createVoicePlaybackUrl(audioPayload);
      if (!playback.url) throw new Error('没有可播放的音频缓存');
      const audio = takePlayableAudio(playback.url, slot);
      if (!audio) {
        playback.revoke?.();
        throw new Error('没有可播放的音频缓存');
      }
      activeVoiceAudio = audio;
      activeVoiceMessageId = String(chunk?.messageIds?.[0] || '').trim();
      // 供应商已经在合成端处理自身音量；播放端不再因为存在动作纹理而二次压低人声。
      // 同播素材统一在 resolveSpeechTextureMixVolume 中让路。
      audio.volume = 1;
      let textureBed = null;
      try {
        await setBackgroundLayersDucked(backgroundLayers, true);
        await playAudioWhenReady(audio);
        const voiceDurationMs = Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.round(audio.duration * 1000)
          : Math.max(900, String(chunk?.speechPlan?.text || '').length * 170);
        textureBed = startTextureSoundBed(chunk.texturePlan, {
          pool: soundAssetPool,
          playbackPool: texturePlaybackPool,
          seed: `${id}|${chunk.signature}|texture`,
          durationMs: voiceDurationMs,
          volume: soundEffectsVolume,
          speechAudio: audio,
          signal,
        });
        activeVoiceTextureBed = textureBed;
        if (button) {
          button.dataset.busy = '0';
          button.classList.remove('is-loading');
          button.classList.add('is-playing');
          button.innerHTML = icon('pause');
        }
        await waitForSequenceAudioEnd(audio, signal);
      } finally {
        textureBed?.stop?.();
        if (activeVoiceTextureBed === textureBed) activeVoiceTextureBed = null;
        playback.revoke?.();
      }
      await setBackgroundLayersDucked(backgroundLayers, false);

      if (nextChunk) {
        const hasNextCue = nextChunk.soundCuesBefore?.some((category) => (
          (soundAssetPool.get(category) || []).length > 0
        ));
        const delay = hasNextCue
          ? Math.min(220, Math.max(100, Math.round(nextChunk.gapBeforeMs * 0.3)))
          : nextChunk.gapBeforeMs;
        await waitForSequenceDelay(delay, signal);
      } else if (chunk.soundCuesAfter?.length) {
        await waitForSequenceDelay(resolveSoundCueEnvelope(
          chunk.soundCuesAfter[0],
        ).postGapMs, signal);
        await playSoundCueCategories(chunk.soundCuesAfter, {
          pool: soundAssetPool,
          seed: `${id}|${chunk.signature}|after`,
          slot,
          signal,
          volume: soundEffectsVolume,
        });
      }
    }

    const cacheChanged = applyVoiceRoundCache(cacheOwner, id, cacheRows, {
      provider,
      bubbleGapMs,
      chunks,
    });
    if (cacheChanged && persist) {
      await mergeVoiceMetadataIntoLatestMessage(cacheOwner, ['voiceRoundAudioCache']);
    }
    if (generatedCount > 0) {
      showToast(chunks.length === 1
        ? '本轮语音已连贯生成并缓存'
        : (provider === 'fish'
          ? `Fish 已按气泡生成 ${chunks.length} 段并缓存`
          : (provider === 'mixed'
            ? `本轮已按角色语音提供商生成 ${chunks.length} 段并缓存`
            : `本轮已按声线分为 ${chunks.length} 段并缓存`)));
    }
    if (cacheChanged && !button) onRefresh?.();
    completedNaturally = true;
    return slot.audio;
  } catch (err) {
    if (requestSeq !== voiceRequestSeq || signal.aborted || err?.name === 'AbortError') return null;
    throw err;
  } finally {
    gestureToken?.dispose?.();
    ambientGestureTokens.forEach((token) => token?.dispose?.());
    texturePlaybackPool.dispose();
    roundCueOverlays.forEach((overlay) => overlay.stop());
    if (requestSeq === voiceRequestSeq) {
      stopActiveVoiceTextureBed();
      await stopBackgroundSoundLayers(backgroundLayers, { natural: completedNaturally });
      activeVoiceBackgroundLayers = [];
      try {
        if (slot.audio) {
          slot.audio.pause();
          slot.audio.removeAttribute('src');
          slot.audio.load?.();
        }
      } catch (_) {}
      resetVoiceButton(button);
      activeVoiceAudio = null;
      activeVoiceButton = null;
      activeVoiceMessageId = '';
      activeVoiceSequenceId = '';
      voiceAbortController = null;
    }
  }
}

function voiceRoundIdForMessage(message = {}) {
  return String(message?.metadata?.aiRoundId || '').trim();
}

function findVoiceRoundCacheOwner(roundMessages = [], roundId = '') {
  return [...(Array.isArray(roundMessages) ? roundMessages : [])]
    .reverse()
    .find((message) => {
      const cache = message?.metadata?.voiceRoundAudioCache;
      return cache
        && Number(cache.version || 0) >= 1
        && String(cache.roundId || '') === String(roundId || '');
    }) || null;
}

export function getCachedVoiceExportAvailability(message = {}, roundMessages = []) {
  const direct = !!String(message?.metadata?.audioCacheKey || '').trim();
  const roundId = voiceRoundIdForMessage(message);
  const owner = roundId ? findVoiceRoundCacheOwner(roundMessages, roundId) : null;
  const roundChunks = Array.isArray(owner?.metadata?.voiceRoundAudioCache?.chunks)
    ? owner.metadata.voiceRoundAudioCache.chunks
    : [];
  const round = roundChunks.some((item) => String(item?.cacheKey || '').trim());
  let segment = false;
  if (round) {
    const messageId = String(message?.id || '').trim();
    const hasStoredMapping = roundChunks.some((item) => (
      Array.isArray(item?.messageIds) && item.messageIds.map(String).includes(messageId)
    ));
    segment = hasStoredMapping || Number(owner?.metadata?.voiceRoundAudioCache?.version || 0) === 1;
  }
  return {
    direct,
    segment: direct || segment,
    round,
    roundId,
  };
}

async function resolveCachedVoiceRoundRows(roundMessages = [], {
  roundId = '',
  bubbleGapMs = 400,
} = {}) {
  const source = (Array.isArray(roundMessages) ? roundMessages : [])
    .filter((message) => String(message?.metadata?.aiRoundId || '').trim() === String(roundId || ''));
  const owner = findVoiceRoundCacheOwner(source, roundId);
  const stored = owner?.metadata?.voiceRoundAudioCache;
  const storedRows = Array.isArray(stored?.chunks) ? stored.chunks : [];
  if (!owner || !storedRows.length) throw new Error('这一轮还没有完整的语音缓存，请先播放一次');

  let planRows = [];
  if (Number(stored.version || 0) >= 2 && storedRows.every((item) => Array.isArray(item?.messageIds))) {
    planRows = storedRows.map((item) => ({
      ...item,
      messageIds: item.messageIds.map((id) => String(id || '').trim()).filter(Boolean),
      gapBeforeMs: Math.max(0, Math.round(Number(item.gapBeforeMs || 0))),
    }));
  } else {
    const voiceConfig = await loadVoiceToolConfig().catch(() => null);
    const currentProvider = voiceConfig?.provider === 'fish' ? 'fish' : 'minimax';
    const providers = [...new Set([String(stored.provider || ''), currentProvider, 'fish', 'minimax'])]
      .filter((provider) => provider === 'fish' || provider === 'minimax');
    let best = [];
    for (const provider of providers) {
      const candidate = buildVoiceRoundSynthesisPlan(source, {
        provider,
        bubbleGapMs: stored.bubbleGapMs ?? bubbleGapMs,
      });
      const matched = candidate.filter((chunk) => (
        storedRows.some((item) => String(item?.signature || '') === String(chunk.signature || ''))
      ));
      if (matched.length > best.length) best = matched;
      if (matched.length === storedRows.length) break;
    }
    planRows = best.map((chunk) => {
      const row = storedRows.find((item) => String(item?.signature || '') === String(chunk.signature || ''));
      return { ...row, messageIds: chunk.messageIds, gapBeforeMs: chunk.gapBeforeMs };
    });
  }

  if (planRows.length !== storedRows.length || planRows.some((item) => !String(item?.cacheKey || '').trim())) {
    throw new Error('本轮语音缓存不完整，请重新完整播放一次');
  }
  return Promise.all(planRows.map(async (item) => {
    const payload = await getVoiceCachedAudio(item.cacheKey);
    if (!payload) throw new Error('本轮有一段缓存已被清理，请重新播放后再导出');
    return {
      ...item,
      payload,
    };
  }));
}

export async function exportCachedTextBubbleVoice(message = {}, {
  roundMessages = [],
  bubbleGapMs = 400,
  filenameBase = '角色语音',
} = {}) {
  const directKey = String(message?.metadata?.audioCacheKey || '').trim();
  if (directKey) {
    const payload = await getVoiceCachedAudio(directKey);
    if (!payload) throw new Error('这条语音缓存已经被清理，请重新播放后再导出');
    return exportCachedVoicePayload(payload, { filenameBase });
  }

  const roundId = voiceRoundIdForMessage(message);
  if (!roundId) throw new Error('这条气泡还没有可导出的语音缓存');
  const rows = await resolveCachedVoiceRoundRows(roundMessages, { roundId, bubbleGapMs });
  const messageId = String(message?.id || '').trim();
  const row = rows.find((item) => item.messageIds.includes(messageId));
  if (!row) throw new Error('这条气泡还没有独立的语音缓存');
  return exportCachedVoicePayload(row.payload, { filenameBase });
}

export async function exportCachedTextBubbleRoundVoice(roundMessages = [], {
  roundId = '',
  bubbleGapMs = 400,
  filenameBase = '本轮语音',
  soundEffectsEnabled = false,
  soundOwnerId = '',
  soundEffectsVolume = 0.58,
  backgroundVolume = 0.22,
} = {}) {
  const id = String(roundId || roundMessages?.[0]?.metadata?.aiRoundId || '').trim();
  if (!id) throw new Error('找不到这条消息所属的语音轮次');
  const rows = await resolveCachedVoiceRoundRows(roundMessages, {
    roundId: id,
    bubbleGapMs,
  });
  if (soundEffectsEnabled) {
    const source = (Array.isArray(roundMessages) ? roundMessages : [])
      .filter((message) => String(message?.metadata?.aiRoundId || '').trim() === id);
    const speechMessages = source.filter(canReadTextBubbleAsVoice);
    const voiceConfig = await loadVoiceToolConfig().catch(() => null);
    const globalProvider = voiceConfig?.provider === 'fish' ? 'fish' : 'minimax';
    const actorIds = [...new Set(speechMessages.map(voiceRoundActorId).filter(Boolean))];
    const providerByActor = {};
    const breathSupplementByActor = {};
    for (const actorId of actorIds) {
      const profile = await loadCharacterVoiceProfile(actorId).catch(() => ({}));
      breathSupplementByActor[actorId] = normalizeBreathSupplementMode(
        profile?.breathSupplementMode,
      );
      const actorMessageIds = new Set(speechMessages
        .filter((message) => voiceRoundActorId(message) === actorId)
        .map((message) => String(message.id || '').trim()));
      const cachedProvider = rows.find((row) => (
        row.messageIds?.some((messageId) => actorMessageIds.has(String(messageId || '').trim()))
        && ['fish', 'minimax'].includes(String(row.provider || ''))
      ))?.provider;
      if (cachedProvider) {
        providerByActor[actorId] = cachedProvider;
      } else {
        providerByActor[actorId] = resolveCharacterVoiceProvider(profile, globalProvider);
      }
    }
    const chunks = buildVoiceRoundSynthesisPlan(source, {
      bubbleGapMs,
      provider: globalProvider,
      providerByActor,
      breathSupplementByActor,
      soundEffectsEnabled: true,
    });
    const requestedSoundCategories = [...new Set(chunks.flatMap((chunk) => [
      ...(chunk.soundCuesBefore || []),
      ...(chunk.soundCuesAfter || []),
      ...(chunk.texturePlan?.categories || []),
    ]))];
    const backgroundCategories = inferNarrationContinuousSoundCuesFromMessages(source);
    const soundAssets = await listSoundAssets({
      ownerId: soundOwnerId,
      categories: [...requestedSoundCategories, ...backgroundCategories],
      limitPerCategory: 12,
    }).catch(() => []);
    const soundAssetPool = buildSoundAssetPools(soundAssets);
    const mixedRows = rows.map((row) => {
      const rowIds = (row.messageIds || []).map((messageId) => String(messageId || '').trim());
      const chunk = chunks.find((item) => String(item.signature || '') === String(row.signature || ''))
        || chunks.find((item) => (
          rowIds.length
          && item.messageIds?.length === rowIds.length
          && item.messageIds.every((messageId, index) => String(messageId || '').trim() === rowIds[index])
        ));
      const before = resolveSoundCueSelections(chunk?.soundCuesBefore || [], {
        pool: soundAssetPool,
        seed: `${id}|${chunk?.signature || row.signature}|before`,
        volume: soundEffectsVolume,
      });
      const after = resolveSoundCueSelections(chunk?.soundCuesAfter || [], {
        pool: soundAssetPool,
        seed: `${id}|${chunk?.signature || row.signature}|after`,
        volume: soundEffectsVolume,
      });
      const texturePlan = chunk?.texturePlan?.categories?.length
        ? {
          ...chunk.texturePlan,
          seed: `${id}|${chunk.signature || row.signature}|texture`,
          volume: normalizeMixVolume(soundEffectsVolume, 0.58),
          assets: chunk.texturePlan.categories.map((category) => ({
            category,
            sources: soundAssetsForTexturePlan(soundAssetPool, category, chunk.texturePlan)
              .slice(0, 8)
              .map((asset) => ({
                blob: asset.audioBlob,
                mixGain: Math.max(0.5, Math.min(2, Number(asset.mixGain || 1) || 1)),
              }))
              .filter((source) => source.blob instanceof Blob && source.blob.size > 0),
          })).filter((item) => item.sources.length),
        }
        : null;
      return {
        ...row,
        soundBefore: before.map((item) => ({
          category: item.category,
          volume: item.volume,
          blob: item.asset.audioBlob,
          overlay: Number(item.asset.durationMs || 0) >= 2200 || item.asset.texturePlayback === 'span',
        })),
        soundAfter: after.map((item) => ({
          category: item.category,
          volume: item.volume,
          blob: item.asset.audioBlob,
        })),
        texturePlan,
      };
    });
    const backgrounds = resolveBackgroundSoundSelections(backgroundCategories, {
      pool: soundAssetPool,
      seed: id,
      volume: backgroundVolume,
    }).map((item) => ({
      category: item.category,
      volume: item.volume,
      blob: item.asset.audioBlob,
    }));
    const hasMixedAudio = backgrounds.length
      || mixedRows.some((row) => (
        row.soundBefore.length
        || row.soundAfter.length
        || row.texturePlan?.assets?.length
      ));
    if (hasMixedAudio) {
      return exportMixedVoiceSequence(mixedRows, {
        backgrounds,
        filenameBase,
      });
    }
  }
  return exportCachedVoiceSequence(rows, { filenameBase });
}

function patchVoiceCardDom(card, msg) {
  if (!card?.isConnected || !msg) return false;
  const compact = card.classList.contains('voice-msg--compact');
  const html = buildVoiceBubbleInnerHtml(msg, esc, { insCard: compact, anonymous: compact });
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const next = wrap.firstElementChild;
  if (!next) return false;
  card.replaceWith(next);
  return true;
}

async function toggleVoiceTranscript(msg, card, onRefresh, viewport = {}) {
  const viewportState = viewport.capture?.();
  const existingText = String(msg.metadata?.text || msg.metadata?.transcript || '').trim();
  const contentText = getVoiceTextForMessage(msg);
  msg.metadata = {
    ...(msg.metadata || {}),
    voiceExpanded: !msg.metadata?.voiceExpanded,
    text: existingText || contentText || '[语音转文字暂无]',
  };
  // 就地改 DOM：转文字只是展开已有转写，不必整表重绘；也不走 MiniMax/STT。
  const patched = patchVoiceCardDom(card, msg);
  if (!patched) onRefresh?.();
  viewport.restore?.(viewportState);
  await mergeVoiceMetadataIntoLatestMessage(msg, ['voiceExpanded', 'text']);
}

/**
 * 在 root 上事件委托绑定语音条交互。
 * messagesOrGetter 可为数组或 () => messages，保证冒泡重挂后仍读到最新列表。
 */
export function bindVoiceBubbleInteractions(root, messagesOrGetter, {
  onRefresh,
  captureViewport,
  restoreViewport,
} = {}) {
  if (!root) return;
  const getMessages = typeof messagesOrGetter === 'function'
    ? messagesOrGetter
    : () => (Array.isArray(messagesOrGetter) ? messagesOrGetter : []);

  let state = voiceRootState.get(root);
  if (!state) {
    state = { getMessages, onRefresh, captureViewport, restoreViewport };
    voiceRootState.set(root, state);
    root.addEventListener('click', async (e) => {
      const card = e.target.closest?.('[data-card-type="voice"]');
      if (!card || !root.contains(card)) return;
      const row = card.closest('[data-msg-id]');
      const msgId = row?.getAttribute('data-msg-id');
      const messages = state.getMessages() || [];
      const msg = messages.find((m) => String(m?.id || '') === String(msgId || ''));
      if (!msg) {
        showToast('语音消息尚未载入，请稍后再试');
        return;
      }

      const playButton = e.target.closest('.voice-msg-play');
      if (playButton) {
        e.preventDefault();
        e.stopPropagation();
        const viewportState = state.captureViewport?.();
        try {
          const playback = playVoiceMessage(msg, {
            button: playButton,
            onRefresh: state.onRefresh,
            gestureToken: captureMediaGesture(e),
          });
          state.restoreViewport?.(viewportState);
          await playback;
          state.restoreViewport?.(viewportState);
        } catch (err) {
          if (isVoiceTtsSkipError(err)) {
            showToast('这条语音尚未生成，当前身份没有可用声线');
            return;
          }
          console.warn('[voice]', err);
          showToast(`语音播放失败：${err?.message || err}`);
        }
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      try {
        await toggleVoiceTranscript(msg, card, state.onRefresh, {
          capture: state.captureViewport,
          restore: state.restoreViewport,
        });
      } catch (err) {
        console.warn('[voice]', err);
        showToast(err?.message || '语音转写切换失败');
      }
    });
  } else {
    state.getMessages = getMessages;
    state.onRefresh = onRefresh;
    if (captureViewport) state.captureViewport = captureViewport;
    if (restoreViewport) state.restoreViewport = restoreViewport;
  }
}
