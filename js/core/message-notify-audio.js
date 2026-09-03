/**
 * 后台消息提示音：可选开关 + 用户上传自定义音频 + 音量。
 * 存在 settings，随设置备份；不改系统 Notification 链路。
 *
 * 移动端关键：试听在用户手势里能响，但后台通知回调里 new Audio().play() 会被拦截。
 * 因此在设置页操作时解锁一条可复用的 Audio 元素，真实通知反复复用同一条通道，
 * 播完后回到静音垫片，避免「第一次响、之后再也不响」。
 */
import * as db from './db.js';
import { MEDIA_GESTURE_SILENT_WAV_DATA_URL, useAmbientAudioSession } from './media-playback.js';

export const MESSAGE_NOTIFY_SOUND_KEY = 'messageNotifySound';
export const MESSAGE_NOTIFY_SOUND_MAX_BYTES = 1024 * 1024;
/** 默认提示音音量（0–100） */
export const MESSAGE_NOTIFY_SOUND_DEFAULT_VOLUME = 80;

const DEFAULT_PREFS = Object.freeze({
  enabled: false,
  volume: MESSAGE_NOTIFY_SOUND_DEFAULT_VOLUME,
  fileName: '',
  mimeType: '',
  audioDataUrl: '',
});

/** @type {HTMLAudioElement | null} */
let unlockedPlayer = null;
/** @type {Promise<unknown> | null} */
let unlockPrime = null;
let defaultToneDataUrl = '';
let rearmSilentTimer = 0;

function clampVolume(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return MESSAGE_NOTIFY_SOUND_DEFAULT_VOLUME;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizePrefs(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const audioDataUrl = String(src.audioDataUrl || '').trim();
  const hasAudio = /^data:audio\//i.test(audioDataUrl);
  return {
    enabled: src.enabled === true,
    volume: clampVolume(src.volume ?? DEFAULT_PREFS.volume),
    fileName: String(src.fileName || '').trim().slice(0, 120),
    mimeType: String(src.mimeType || '').trim().slice(0, 80),
    audioDataUrl: hasAudio ? audioDataUrl : '',
  };
}

export async function getMessageNotifySoundPrefs() {
  const row = await db.get(MESSAGE_NOTIFY_SOUND_KEY).catch(() => null);
  return normalizePrefs(row?.value);
}

async function persistPrefs(patch = {}) {
  const current = await getMessageNotifySoundPrefs();
  const next = normalizePrefs({ ...current, ...patch });
  await db.put({ key: MESSAGE_NOTIFY_SOUND_KEY, value: next });
  return next;
}

export async function setMessageNotifySoundEnabled(enabled) {
  if (!enabled) releaseMessageNotifySoundPlayer();
  const next = await persistPrefs({ enabled: !!enabled });
  if (!next.enabled) releaseMessageNotifySoundPlayer();
  return next;
}

export async function setMessageNotifySoundVolume(volume) {
  return persistPrefs({ volume: clampVolume(volume) });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

export async function setMessageNotifySoundFromFile(file) {
  if (!file) throw new Error('请选择音频文件');
  const mime = String(file.type || '').trim().toLowerCase();
  const name = String(file.name || '提示音').trim() || '提示音';
  if (mime && !mime.startsWith('audio/')) {
    throw new Error('请选择音频文件');
  }
  const size = Number(file.size) || 0;
  if (size <= 0) throw new Error('音频文件无效');
  if (size > MESSAGE_NOTIFY_SOUND_MAX_BYTES) {
    throw new Error('音频请小于 1MB');
  }
  const audioDataUrl = await fileToDataUrl(file);
  if (!/^data:audio\//i.test(audioDataUrl)) {
    throw new Error('无法读取该音频');
  }
  return persistPrefs({
    enabled: true,
    fileName: name.slice(0, 120),
    mimeType: mime || 'audio/*',
    audioDataUrl,
  });
}

export async function clearMessageNotifySoundCustom() {
  return persistPrefs({
    fileName: '',
    mimeType: '',
    audioDataUrl: '',
  });
}

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

function ensureUnlockedPlayer() {
  if (typeof Audio === 'undefined') return null;
  if (unlockedPlayer) return unlockedPlayer;
  const audio = new Audio();
  audio.preload = 'auto';
  audio.setAttribute('playsinline', 'true');
  audio.setAttribute('webkit-playsinline', 'true');
  unlockedPlayer = audio;
  return audio;
}

function armSilentPad(audio) {
  if (!audio) return;
  try {
    audio.loop = false;
    audio.muted = true;
    audio.volume = 0;
    if (audio.src !== MEDIA_GESTURE_SILENT_WAV_DATA_URL) {
      audio.src = MEDIA_GESTURE_SILENT_WAV_DATA_URL;
    }
  } catch (_) {}
}

function clearRearmSilentTimer() {
  if (!rearmSilentTimer) return;
  clearTimeout(rearmSilentTimer);
  rearmSilentTimer = 0;
}

/** 关闭提示音或销毁页面时完整拆除解锁播放器，不能只把音量设为 0 留着系统会话。 */
export function releaseMessageNotifySoundPlayer() {
  clearRearmSilentTimer();
  unlockPrime = null;
  const audio = unlockedPlayer;
  unlockedPlayer = null;
  if (!audio) {
    useAmbientAudioSession();
    return;
  }
  try {
    audio.loop = false;
    audio.muted = true;
    audio.volume = 0;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio.remove();
  } catch (_) {}
  useAmbientAudioSession();
}

/** 提示音播完后把同一条元素垫回静音并短播一次，保持解锁态供下次复用（不常驻 loop，避免和保活抢会话）。 */
function scheduleRearmSilent(audio) {
  clearRearmSilentTimer();
  if (!audio || audio !== unlockedPlayer) return;
  const rearm = () => {
    rearmSilentTimer = 0;
    if (audio !== unlockedPlayer) return;
    armSilentPad(audio);
    useAmbientAudioSession();
    unlockPrime = audio.play()
      .then(() => {
        try { audio.pause(); } catch (_) {}
      })
      .catch(() => null);
  };
  if (audio.ended || audio.paused) {
    rearmSilentTimer = setTimeout(rearm, 40);
    return;
  }
  const onEnded = () => {
    audio.removeEventListener('ended', onEnded);
    rearm();
  };
  audio.addEventListener('ended', onEnded);
  rearmSilentTimer = setTimeout(() => {
    audio.removeEventListener('ended', onEnded);
    rearm();
  }, 2500);
}

/**
 * 在用户主动操作中解锁一条可反复复用的音频元素。
 * 移动 PWA 不允许定时器/后台回调临时创建音频，试听能响而真实通知无声通常由此造成。
 */
export function primeMessageNotifySoundGesture(event = null) {
  if (typeof Audio === 'undefined') return false;
  if (event && !isRecentGesture(event)) return false;
  const audio = ensureUnlockedPlayer();
  if (!audio) return false;
  clearRearmSilentTimer();
  armSilentPad(audio);
  useAmbientAudioSession();
  unlockPrime = audio.play().catch(() => null);
  return true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (event) => {
    if (!event?.persisted) releaseMessageNotifySoundPlayer();
  });
}

function volumeFactor(volume = MESSAGE_NOTIFY_SOUND_DEFAULT_VOLUME) {
  return clampVolume(volume) / 100;
}

function getDefaultToneDataUrl() {
  if (defaultToneDataUrl || typeof btoa !== 'function') return defaultToneDataUrl;
  const sampleRate = 8000;
  const duration = 0.42;
  const samples = Math.floor(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeText(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const tone = t < 0.17 ? 880 : 1175;
    const fade = Math.max(0, Math.min(1, (duration - t) / 0.08, t / 0.015));
    view.setInt16(44 + i * 2, Math.round(Math.sin(Math.PI * 2 * tone * t) * 0.24 * fade * 32767), true);
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  defaultToneDataUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return defaultToneDataUrl;
}

async function playDefaultBeep(volume = MESSAGE_NOTIFY_SOUND_DEFAULT_VOLUME) {
  return playDataUrl(getDefaultToneDataUrl(), volume);
}

async function playDataUrl(audioDataUrl, volume = MESSAGE_NOTIFY_SOUND_DEFAULT_VOLUME) {
  if (typeof Audio === 'undefined') return false;
  const src = String(audioDataUrl || '').trim();
  if (!src) return false;
  const factor = volumeFactor(volume);
  if (factor <= 0) return true;

  const audio = unlockedPlayer || ensureUnlockedPlayer();
  if (!audio) return false;
  clearRearmSilentTimer();
  if (unlockPrime) {
    try { await unlockPrime; } catch (_) {}
  }

  try {
    useAmbientAudioSession();
    audio.loop = false;
    audio.muted = false;
    audio.volume = Math.max(0, Math.min(1, factor));
    if (audio.src !== src) audio.src = src;
    try { audio.currentTime = 0; } catch (_) {}
    await audio.play();
    scheduleRearmSilent(audio);
    return true;
  } catch (_) {
    // 解锁通道失效时再试一次临时 Audio（前台手势场景仍可能成功）
    try {
      const fallback = new Audio(src);
      fallback.preload = 'auto';
      fallback.setAttribute('playsinline', 'true');
      fallback.volume = Math.max(0, Math.min(1, factor));
      await fallback.play();
      return true;
    } catch (_) {
      return false;
    }
  }
}

/**
 * 强制播放当前提示音（设置页试听用；无视 enabled）。
 */
export async function previewMessageNotifySound() {
  const prefs = await getMessageNotifySoundPrefs();
  if (prefs.audioDataUrl) {
    const ok = await playDataUrl(prefs.audioDataUrl, prefs.volume);
    if (ok) return { ok: true, source: 'custom' };
  }
  const ok = await playDefaultBeep(prefs.volume);
  return ok ? { ok: true, source: 'default' } : { ok: false, reason: 'play_failed' };
}

/**
 * 后台消息通知成功后调用：仅在开启时播放。
 */
export async function playMessageNotifySoundIfEnabled() {
  const prefs = await getMessageNotifySoundPrefs();
  if (!prefs.enabled) return { ok: false, reason: 'disabled' };
  if (prefs.audioDataUrl) {
    const ok = await playDataUrl(prefs.audioDataUrl, prefs.volume);
    if (ok) return { ok: true, source: 'custom' };
    // 自定义失败时回退默认嘀一声，避免「开了却完全没声」
  }
  const ok = await playDefaultBeep(prefs.volume);
  return ok ? { ok: true, source: 'default' } : { ok: false, reason: 'play_failed' };
}
