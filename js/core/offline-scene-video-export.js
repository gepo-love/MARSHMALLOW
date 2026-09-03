import { saveBlobNatively } from './native-file-export.js';
import { alignNarrativeVoiceLinesToDialogueSpans } from './narrative-voice-lines.js';

const VIDEO_BITRATE = 1_200_000;
const AUDIO_BITRATE = 96_000;
const clean = (value = '') => String(value || '').trim();

function playableVoiceLines(round = {}) {
  return alignNarrativeVoiceLinesToDialogueSpans(
    round.text || '',
    (Array.isArray(round.voiceLines) ? round.voiceLines : []).filter((line) => line?.audio?.dataUrl),
    { allowBracketDialogue: true },
  );
}

export function dataUrlByteSize(value = '') {
  const source = clean(value);
  const comma = source.indexOf(',');
  if (!source.startsWith('data:') || comma < 0) return 0;
  const body = source.slice(comma + 1);
  if (/;base64/i.test(source.slice(0, comma))) {
    const padding = body.endsWith('==') ? 2 : (body.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(body.length * 3 / 4) - padding);
  }
  try { return new TextEncoder().encode(decodeURIComponent(body)).byteLength; } catch (_) { return body.length; }
}

function estimatedSceneSeconds(round = {}) {
  const voices = playableVoiceLines(round)
    .reduce((sum, line) => sum + Math.max(1.1, Math.min(9, clean(line.text).length * 0.23)) + 0.22, 0);
  return Math.max(3.5, Math.min(12, clean(round.text).length / 18 + 2.2), voices + 0.8);
}

export function collectOfflineSceneMediaStats(rounds = [], scene = {}) {
  const scenes = (Array.isArray(rounds) ? rounds : []).filter((round) => round?.role === 'narration');
  const images = new Set();
  const audio = new Set();
  if (clean(scene.audioSceneBackground)) images.add(clean(scene.audioSceneBackground));
  let cachedVoiceLines = 0;
  scenes.forEach((round) => {
    if (clean(round?.image?.url)) images.add(clean(round.image.url));
    // 缓存体积统计仍反映实际已占用的全部媒体；只有真正回放/导出时
    // 才排除无法与当前正文直接对白对齐的旧音轨。
    (Array.isArray(round.voiceLines) ? round.voiceLines : []).forEach((line) => {
      if (!clean(line?.audio?.dataUrl)) return;
      cachedVoiceLines += 1;
      audio.add(clean(line.audio.dataUrl));
    });
  });
  const imageBytes = [...images].reduce((sum, value) => sum + dataUrlByteSize(value), 0);
  const audioBytes = [...audio].reduce((sum, value) => sum + dataUrlByteSize(value), 0);
  const durationSeconds = scenes.reduce((sum, round) => sum + estimatedSceneSeconds(round), 0);
  return {
    sceneCount: scenes.length,
    imageCount: images.size,
    cachedVoiceLines,
    imageBytes,
    audioBytes,
    cachedBytes: imageBytes + audioBytes,
    durationSeconds,
    estimatedVideoBytes: Math.ceil(durationSeconds * (VIDEO_BITRATE + AUDIO_BITRATE) / 8),
  };
}

export function formatMediaBytes(bytes = 0) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10485760 ? 1 : 0)} MB`;
}

export function formatSceneDuration(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return total >= 60 ? `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒` : `${total}秒`;
}

function loadImage(src = '') {
  if (!clean(src)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function decodeAudio(context, src = '') {
  if (!clean(src)) return null;
  try { return await context.decodeAudioData((await (await fetch(src)).arrayBuffer()).slice(0)); } catch (_) { return null; }
}

function cover(ctx, image, width, height) {
  if (!image?.naturalWidth || !image?.naturalHeight) return;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sw = width / scale;
  const sh = height / scale;
  ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, 0, 0, width, height);
}

function roundedRect(ctx, x, y, width, height, radius) {
  if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, width, height, radius); return; }
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function textLines(ctx, value, width) {
  const lines = [];
  clean(value).split(/\n+/).forEach((paragraph) => {
    let line = '';
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = char; } else line += char;
    }
    if (line) lines.push(line);
  });
  return lines;
}

function safeFilename(value = '') {
  return clean(value).replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 60) || '线下音声回顾';
}

function browserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function exportOfflineSceneVideo({ rounds = [], scene = {}, title = '线下音声回顾', orientation = 'portrait', onProgress = null } = {}) {
  const scenes = (Array.isArray(rounds) ? rounds : []).filter((round) => round?.role === 'narration');
  if (!scenes.length) throw new Error('还没有可以导出的视频幕');
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!globalThis.MediaRecorder || !AudioContextCtor) throw new Error('当前浏览器不支持音声视频导出');
  const canvas = document.createElement('canvas');
  const landscape = orientation === 'landscape';
  canvas.width = landscape ? 1280 : 720;
  canvas.height = landscape ? 720 : 1280;
  if (typeof canvas.captureStream !== 'function') throw new Error('当前浏览器不支持画布视频录制');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建视频画布');
  const audioContext = new AudioContextCtor();
  const destination = audioContext.createMediaStreamDestination();
  let recorder = null;
  let tracks = [];
  let timer = null;
  try {
    await audioContext.resume();
    let carried = clean(scene.audioSceneBackground);
    const cache = new Map();
    const prepared = [];
    for (let index = 0; index < scenes.length; index += 1) {
      const round = scenes[index];
      carried = clean(round?.image?.url) || carried;
      if (carried && !cache.has(carried)) cache.set(carried, await loadImage(carried));
      const voices = [];
      for (const line of playableVoiceLines(round)) {
        const buffer = await decodeAudio(audioContext, line?.audio?.dataUrl);
        if (buffer) voices.push(buffer);
      }
      const voiceDuration = voices.reduce((sum, buffer) => sum + buffer.duration + 0.22, 0);
      prepared.push({ round, image: cache.get(carried) || null, voices, duration: Math.max(estimatedSceneSeconds(round), voiceDuration + 0.8) });
      onProgress?.({ phase: 'prepare', current: index + 1, total: scenes.length });
    }
    tracks = [
      ...canvas.captureStream(24).getVideoTracks(),
      ...(prepared.some((item) => item.voices.length) ? destination.stream.getAudioTracks() : []),
    ];
    const mimeType = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE });
    } catch (_) { recorder = new MediaRecorder(new MediaStream(tracks)); }
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = () => reject(recorder.error || new Error('视频录制失败'));
    });
    const total = prepared.reduce((sum, item) => sum + item.duration, 0);
    let offset = 0;
    prepared.forEach((item) => {
      let voiceOffset = offset + 0.35;
      item.voices.forEach((buffer) => {
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        source.start(audioContext.currentTime + 0.2 + voiceOffset);
        voiceOffset += buffer.duration + 0.22;
      });
      offset += item.duration;
    });
    const draw = (item, index, progress) => {
      const { width, height } = canvas;
      ctx.fillStyle = '#13202a'; ctx.fillRect(0, 0, width, height); cover(ctx, item.image, width, height);
      const shade = ctx.createLinearGradient(0, 0, 0, height); shade.addColorStop(0, 'rgba(4,10,16,.28)'); shade.addColorStop(1, 'rgba(4,10,16,.86)'); ctx.fillStyle = shade; ctx.fillRect(0, 0, width, height);
      const side = landscape ? 62 : 44; const boxHeight = landscape ? 238 : 390; const y = height - boxHeight - side;
      ctx.fillStyle = 'rgba(8,15,22,.72)'; ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); roundedRect(ctx, side, y, width - side * 2, boxHeight, landscape ? 24 : 30); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.72)'; ctx.font = `${landscape ? 22 : 25}px sans-serif`; ctx.fillText(`${safeFilename(title)} · 第 ${index + 1} 幕`, side + 28, y + 45);
      ctx.fillStyle = '#fff'; ctx.font = `${landscape ? 27 : 31}px sans-serif`;
      const lines = textLines(ctx, item.round.text, width - side * 2 - 56); const limit = landscape ? 5 : 8; const page = Math.min(Math.max(0, Math.ceil(lines.length / limit) - 1), Math.floor(Math.max(0, Math.min(.999, progress)) * Math.max(1, Math.ceil(lines.length / limit))));
      lines.slice(page * limit, page * limit + limit).forEach((line, i) => ctx.fillText(line, side + 28, y + 91 + i * (landscape ? 38 : 45)));
    };
    draw(prepared[0], 0, 0);
    recorder.start(1000);
    const started = performance.now();
    await new Promise((resolve) => {
      timer = setInterval(() => {
        const elapsed = (performance.now() - started) / 1000;
        let cursor = 0; let index = prepared.length - 1;
        for (let i = 0; i < prepared.length; i += 1) { if (elapsed < cursor + prepared[i].duration) { index = i; break; } cursor += prepared[i].duration; }
        draw(prepared[index], index, (elapsed - cursor) / prepared[index].duration);
        onProgress?.({ phase: 'record', elapsed: Math.min(elapsed, total), total });
        if (elapsed >= total + 0.15) { clearInterval(timer); timer = null; resolve(); }
      }, 80);
    });
    recorder.stop();
    await stopped;
    const type = recorder.mimeType || mimeType || 'video/webm';
    const blob = new Blob(chunks, { type });
    if (!blob.size) throw new Error('视频导出结果为空');
    const filename = `${safeFilename(title)}-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    if (!await saveBlobNatively(blob, { filename, mimeType: type, directory: 'downloads' })) browserDownload(blob, filename);
    return { blob, filename, mimeType: type, bytes: blob.size, durationSeconds: total };
  } finally {
    if (timer) clearInterval(timer);
    if (recorder?.state && recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} }
    tracks.forEach((track) => track.stop());
    await audioContext.close().catch(() => {});
  }
}
