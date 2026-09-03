/**
 * 0.5 秒、8kHz/16bit/单声道、全零采样的真静音 WAV（格式与早期版本一致，只是把循环单元从
 * 2 个采样点、约 0.18ms 一循环，延长到 0.5 秒一循环）。循环单元过短会让 iOS/Android 以
 * 每秒数千次的频率反复重启解码，容易被系统判定为异常/卡顿而被静音或直接掐断，导致「保活
 * 时开时不开」、系统媒体控制里也显示不出正在播放；延长循环单元后这个问题才会消失。
 */
export const SILENT_WAV_DATA_URL = 'data:audio/wav;base64,UklGRmQfAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

let audioCaptureSessionCount = 0;

function applyAudioSessionType(type = 'ambient') {
  try {
    if (typeof navigator !== 'undefined' && navigator.audioSession && 'type' in navigator.audioSession) {
      navigator.audioSession.type = type;
      return true;
    }
  } catch (_) {}
  return false;
}

/** 麦克风采集必须使用 play-and-record；采集期间其它播放/保活逻辑不得抢回会话类型。 */
export function useCaptureAudioSession() {
  return applyAudioSessionType('play-and-record');
}

/** 自动提示音/保活轨使用可混音会话，避免 iOS 把其它 App 的媒体暂停。 */
export function useAmbientAudioSession() {
  if (audioCaptureSessionCount > 0) return useCaptureAudioSession();
  return applyAudioSessionType('ambient');
}

/** 用户主动播放语音、通话或音乐时再切换为独占播放会话。 */
export function useForegroundAudioSession() {
  if (audioCaptureSessionCount > 0) return useCaptureAudioSession();
  return applyAudioSessionType('playback');
}

/**
 * 为一次麦克风采集加可嵌套的会话锁。权限预热、SpeechRecognition 与 MediaRecorder
 * 可能重叠，只有最后一个采集者释放后才恢复播放/环境会话。
 */
export function beginAudioCaptureSession() {
  audioCaptureSessionCount += 1;
  useCaptureAudioSession();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      audioCaptureSessionCount = Math.max(0, audioCaptureSessionCount - 1);
      if (audioCaptureSessionCount > 0) {
        useCaptureAudioSession();
      } else if (isForegroundMediaActive()) {
        useForegroundAudioSession();
      } else {
        useAmbientAudioSession();
      }
    },
  };
}

// iOS 17+ 若留在 auto，短静音轨也可能被 WebKit 判成 playback 并抢占灵动岛。
useAmbientAudioSession();

/**
 * 真正用于媒体手势解锁的静音源必须保持宽带采样率。
 *
 * 旧版 8kHz WAV 在部分 iOS WebKit / Android WebView 中会让复用的 HTMLAudioElement
 * 暂时沿用窄带输出管线：同一份 TTS 在页面里发闷，播放途中重新协商后才恢复清晰。
 * 48kHz 与移动设备常见硬件输出率一致，同时仍保留 0.5 秒循环单元，避免极短 WAV
 * 高频重启解码器。上方 SILENT_WAV_DATA_URL 仅保留给旧模块导入兼容，新播放链路勿再使用。
 */
export const MEDIA_GESTURE_SILENT_WAV_SAMPLE_RATE = 48000;

function buildMediaGestureSilentWavDataUrl() {
  const channels = 1;
  const bitsPerSample = 16;
  const durationSeconds = 0.5;
  const sampleCount = Math.round(MEDIA_GESTURE_SILENT_WAV_SAMPLE_RATE * durationSeconds);
  const dataBytes = sampleCount * channels * (bitsPerSample / 8);
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, MEDIA_GESTURE_SILENT_WAV_SAMPLE_RATE, true);
  view.setUint32(28, MEDIA_GESTURE_SILENT_WAV_SAMPLE_RATE * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export const MEDIA_GESTURE_SILENT_WAV_DATA_URL = buildMediaGestureSilentWavDataUrl();

function isRecentGesture(event) {
  return !!event && event.isTrusted !== false && (
    event.type === 'click'
    || event.type === 'change'
    || event.type === 'pointerup'
    || event.type === 'pointerdown'
    || event.type === 'touchend'
    || event.type === 'keydown'
  );
}

export function resolveMediaGestureAudioSession({
  trackAsForeground = true,
  audioSession = '',
} = {}) {
  if (audioSession === 'playback' || audioSession === 'ambient') return audioSession;
  return trackAsForeground ? 'playback' : 'ambient';
}

export function captureMediaGesture(event = null, {
  trackAsForeground = true,
  audioSession = '',
} = {}) {
  if (typeof Audio === 'undefined') return null;
  if (event && !isRecentGesture(event)) return null;
  const session = resolveMediaGestureAudioSession({ trackAsForeground, audioSession });
  if (session === 'playback') useForegroundAudioSession();
  else useAmbientAudioSession();
  let claimed = false;
  const audio = new Audio();
  audio.preload = 'auto';
  audio.setAttribute('playsinline', 'true');
  audio.src = MEDIA_GESTURE_SILENT_WAV_DATA_URL;
  // 与静音保活同理：volume=0 / muted 会被部分 iOS 当成「未在播」直接掐轨。
  // 通话开场要先等 LLM 再 TTS，垫片必须用极低音量 loop 才能撑过这段等待。
  audio.muted = false;
  audio.volume = 0.01;
  audio.loop = true;
  // 真实语音/音乐需要登记为前台媒体，避免等待期间静音保活把音轨抢回去；
  // 静音保活自己借手势时必须关闭登记，否则它会把自己误判成「真实媒体」，
  // teardown 时也会因 foregroundMediaCount > 0 跳过 Media Session 清理。
  if (trackAsForeground) trackForegroundMediaAudio(audio);

  const prime = audio.play().catch((err) => err);

  return {
    audio,
    prime,
    claim(src = '') {
      if (claimed) return null;
      claimed = true;
      const nextSrc = String(src || '').trim();
      if (!nextSrc) return null;
      try { audio.pause(); } catch (_) {}
      audio.loop = false;
      audio.removeAttribute('muted');
      audio.muted = false;
      audio.volume = 1;
      audio.preload = 'auto';
      audio.playbackRate = 1;
      try { audio.currentTime = 0; } catch (_) {}
      // 只赋值 src（隐式触发一次加载）。不要再额外调用 load()：
      // 把已缓冲的 data: 静音源切到网易云远程流时，二次 load 会和随后的 play()
      // 抢占资源选择，导致 iOS 永久卡加载、安卓加载变慢。
      audio.src = nextSrc;
      return audio;
    },
    dispose() {
      if (claimed) return;
      claimed = true;
      try {
        audio.loop = false;
        audio.pause();
        audio.src = '';
        audio.load?.();
      } catch (_) {}
    },
  };
}

let pendingMediaGesture = null;

/**
 * 跨 SPA 路由暂存一次用户手势解锁的 Audio。通讯录拨号会先异步建会话再进聊天页，
 * iOS 到真正播放首句时早已丢失 user activation，只能复用点击拨号时已 play() 的元素。
 */
export function storePendingMediaGesture(token = null) {
  pendingMediaGesture?.dispose?.();
  pendingMediaGesture = token || null;
  return pendingMediaGesture;
}

export function takePendingMediaGesture() {
  const token = pendingMediaGesture;
  pendingMediaGesture = null;
  return token;
}

export function hasMediaSession() {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

const foregroundMediaState = new WeakMap();
let foregroundMediaCount = 0;
let foregroundMediaLeaseCount = 0;
let foregroundMediaReleaseTimer = 0;
let foregroundMediaHoldUntil = 0;
const FOREGROUND_MEDIA_RELEASE_GRACE_MS = 4000;

function hasForegroundMediaOwner() {
  return foregroundMediaCount > 0 || foregroundMediaLeaseCount > 0;
}

function cancelForegroundMediaRelease() {
  if (foregroundMediaReleaseTimer && typeof clearTimeout === 'function') {
    clearTimeout(foregroundMediaReleaseTimer);
  }
  foregroundMediaReleaseTimer = 0;
  foregroundMediaHoldUntil = 0;
}

function scheduleForegroundMediaRelease() {
  if (hasForegroundMediaOwner()) return;
  if (typeof setTimeout !== 'function') {
    foregroundMediaHoldUntil = 0;
    useAmbientAudioSession();
    emitForegroundMediaChanged();
    return;
  }
  if (foregroundMediaReleaseTimer) clearTimeout(foregroundMediaReleaseTimer);
  foregroundMediaHoldUntil = Date.now() + FOREGROUND_MEDIA_RELEASE_GRACE_MS;
  // 多句语音复用同一元素时，每次换 src 都会短暂 pause。保留一个很短的播放会话
  // 缓冲，不让 iOS/WebView 在句间来回切 ambient/playback，导致后半段显示成功却无声。
  useForegroundAudioSession();
  emitForegroundMediaChanged();
  foregroundMediaReleaseTimer = setTimeout(() => {
    foregroundMediaReleaseTimer = 0;
    if (hasForegroundMediaOwner()) return;
    foregroundMediaHoldUntil = 0;
    useAmbientAudioSession();
    emitForegroundMediaChanged();
  }, FOREGROUND_MEDIA_RELEASE_GRACE_MS);
}

function emitForegroundMediaChanged() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('marshmallow-foreground-media-changed', {
    detail: {
      active: isForegroundMediaActive(),
      count: foregroundMediaCount,
      leases: foregroundMediaLeaseCount,
    },
  }));
}

function setForegroundMediaActive(audio, active) {
  const state = foregroundMediaState.get(audio);
  if (!state || state.active === active) return;
  state.active = active;
  foregroundMediaCount = Math.max(0, foregroundMediaCount + (active ? 1 : -1));
  if (active) {
    cancelForegroundMediaRelease();
    useForegroundAudioSession();
    emitForegroundMediaChanged();
  } else if (hasForegroundMediaOwner()) {
    useForegroundAudioSession();
    emitForegroundMediaChanged();
  } else {
    scheduleForegroundMediaRelease();
  }
}

/**
 * 多句/多段媒体在整轮完成前持有播放会话。实际 Audio 的 ended/pause 仍会更新计数，
 * 但不会让静音保活趁 TTS 合成下一句的空档重新抢占系统音频会话。
 */
export function beginForegroundMediaSession() {
  foregroundMediaLeaseCount += 1;
  cancelForegroundMediaRelease();
  useForegroundAudioSession();
  emitForegroundMediaChanged();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      foregroundMediaLeaseCount = Math.max(0, foregroundMediaLeaseCount - 1);
      if (hasForegroundMediaOwner()) {
        useForegroundAudioSession();
        emitForegroundMediaChanged();
      } else {
        scheduleForegroundMediaRelease();
      }
    },
  };
}

/**
 * 把真实语音/音乐登记为前台媒体。iOS 基本只有一条网页音频会话；真实媒体播放时，
 * 静音保活必须让出，不能在系统 pause 后继续抢着重播。
 */
export function trackForegroundMediaAudio(audio, { active = false } = {}) {
  if (!audio) return audio;
  if (!foregroundMediaState.has(audio)) {
    foregroundMediaState.set(audio, { active: false });
    audio.addEventListener('play', () => setForegroundMediaActive(audio, true));
    audio.addEventListener('playing', () => setForegroundMediaActive(audio, true));
    const release = () => setForegroundMediaActive(audio, false);
    audio.addEventListener('pause', release);
    audio.addEventListener('ended', release);
    audio.addEventListener('error', release);
    audio.addEventListener('emptied', release);
  }
  if (active) setForegroundMediaActive(audio, true);
  return audio;
}

export function isForegroundMediaActive() {
  return hasForegroundMediaOwner() || Date.now() < foregroundMediaHoldUntil;
}

export function updateMediaSessionMetadata(track = null) {
  if (!hasMediaSession()) return;
  try {
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    if (typeof MediaMetadata === 'undefined') return;
    const artwork = [];
    let cover = String(track.coverUrl || '').trim();
    if (cover.startsWith('//')) cover = `https:${cover}`;
    else if (/^http:\/\//i.test(cover)) cover = `https://${cover.slice(7)}`;
    if (/^https:\/\//i.test(cover)) {
      artwork.push({ src: cover, sizes: '512x512', type: 'image/png' });
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || '未知曲目',
      artist: track.artist || '',
      album: track.album || '',
      artwork,
    });
  } catch (_) {}
}

export function updateMediaSessionPlaybackState(isPlaying = false) {
  if (!hasMediaSession()) return;
  try {
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  } catch (_) {}
}

export function clearMediaSession() {
  if (hasMediaSession()) {
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch (_) {}
  }
  if (isForegroundMediaActive()) useForegroundAudioSession();
  else useAmbientAudioSession();
}

export function audioFromGestureOrNew(src = '', token = null) {
  const nextSrc = String(src || '').trim();
  if (!nextSrc) return null;
  useForegroundAudioSession();
  const claimed = token?.claim?.(nextSrc);
  if (claimed) return trackForegroundMediaAudio(claimed);
  const audio = new Audio(nextSrc);
  audio.preload = 'auto';
  audio.setAttribute('playsinline', 'true');
  audio.playbackRate = 1;
  return trackForegroundMediaAudio(audio);
}

/**
 * 多段语音播放槽：手势给「第一段成功创建」的 Audio，后续段复用同一已解锁元素换 src。
 * slot: { gesture, audio }，调用方可在整段队列结束后 dispose 残留 gesture。
 */
export function takePlayableAudio(src = '', slot = null) {
  const nextSrc = String(src || '').trim();
  if (!nextSrc) return null;
  const state = slot && typeof slot === 'object' ? slot : { gesture: null, audio: null };
  if (state.audio) {
    try { state.audio.pause(); } catch (_) {}
    state.audio.src = nextSrc;
    try { state.audio.currentTime = 0; } catch (_) {}
    state.audio.preload = 'auto';
    state.audio.setAttribute('playsinline', 'true');
    state.audio.playbackRate = 1;
    return state.audio;
  }
  const audio = audioFromGestureOrNew(nextSrc, state.gesture || null);
  // 无论 claim 成功还是退回 new Audio，都只尝试一次手势，避免后续段误用已失效 token。
  state.gesture = null;
  state.audio = audio;
  return audio;
}

const AUDIO_CANPLAY_TIMEOUT_MS = 12000;

export function primeAudioElementState(audio) {
  if (!audio) return audio;
  try {
    audio.playbackRate = 1;
    if (audio.currentTime > 0) audio.currentTime = 0;
  } catch (_) {}
  return audio;
}

export function waitForAudioCanPlay(audio, { timeoutMs = AUDIO_CANPLAY_TIMEOUT_MS } = {}) {
  if (!audio) return Promise.reject(new Error('无效音频元素'));
  const ready = Number(audio.readyState);
  if (ready >= 3) return Promise.resolve(audio);
  if (ready >= 1 && Number.isFinite(audio.duration) && audio.duration > 0) {
    return Promise.resolve(audio);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(audio);
    };
    const cleanup = () => {
      clearTimeout(timer);
      audio.removeEventListener('loadedmetadata', finish);
      audio.removeEventListener('canplay', finish);
      audio.removeEventListener('canplaythrough', finish);
      audio.removeEventListener('error', finish);
    };
    const timer = setTimeout(finish, timeoutMs);
    audio.addEventListener('loadedmetadata', finish, { once: true });
    audio.addEventListener('canplay', finish, { once: true });
    audio.addEventListener('canplaythrough', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
  });
}

export async function playAudioWhenReady(audio, options = {}) {
  if (!audio) throw new Error('无效音频元素');
  const foregroundMedia = options.foregroundMedia !== false;
  if (foregroundMedia) trackForegroundMediaAudio(audio, { active: true });
  primeAudioElementState(audio);
  try {
    // 必须在调用方仍处于 click / keydown 用户手势栈时立刻调用 play()。
    // HTMLMediaElement 会自行等待数据就绪；若先 await canplay，Android WebView / iOS
    // 会把随后发生的 play() 判定为异步自动播放，通话重听、语音气泡都会无声失败。
    await audio.play();
    return audio;
  } catch (err) {
    if (foregroundMedia) setForegroundMediaActive(audio, false);
    throw err;
  }
}
