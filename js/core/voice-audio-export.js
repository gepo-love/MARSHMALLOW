import {
  describeDownloadResult,
  downloadBlob,
} from './native-download.js';
import {
  buildTextureSoundSchedule,
  resolveSpeechTextureMixVolume,
  resolveSpeechTextureVoiceVolume,
  resolveSoundCueEnvelope,
} from './sound-cues.js';

function dataUrlToBlob(dataUrl = '') {
  const raw = String(dataUrl || '').trim();
  const match = raw.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match || typeof Blob === 'undefined') return null;
  const mime = String(match[1] || 'application/octet-stream').trim() || 'application/octet-stream';
  try {
    if (match[2]) {
      const binary = atob(String(match[3] || '').replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(String(match[3] || ''))], { type: mime });
  } catch (_) {
    return null;
  }
}

function blobForVoicePayload(payload = {}) {
  if (payload.audioBlob instanceof Blob && payload.audioBlob.size > 0) return payload.audioBlob;
  return dataUrlToBlob(payload.audioDataUrl || payload.url || '');
}

function cleanFilenamePart(value = '', fallback = '语音') {
  const clean = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 72);
  return clean || fallback;
}

function extensionForVoicePayload(payload = {}, blob = null) {
  const format = String(payload.format || '').trim().toLowerCase();
  if (['mp3', 'wav', 'flac', 'pcm', 'ogg', 'm4a', 'aac'].includes(format)) return format;
  const mime = String(blob?.type || '').toLowerCase();
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('aac')) return 'aac';
  return 'mp3';
}

function mimeForExtension(extension = 'mp3') {
  if (extension === 'wav') return 'audio/wav';
  if (extension === 'flac') return 'audio/flac';
  if (extension === 'ogg') return 'audio/ogg';
  if (extension === 'm4a') return 'audio/mp4';
  if (extension === 'aac') return 'audio/aac';
  if (extension === 'pcm') return 'audio/L16';
  return 'audio/mpeg';
}

function decodeAudioData(context, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (buffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error || new Error('音频解码失败'));
    };
    try {
      const pending = context.decodeAudioData(arrayBuffer.slice(0), done, fail);
      if (pending?.then) pending.then(done, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function monoSamplesToWav(samples, sampleRate = 44100, { softLimit = false } = {}) {
  const totalFrames = Number(samples?.length || 0);
  if (!totalFrames) throw new Error('缓存音频为空');
  const output = new ArrayBuffer(44 + totalFrames * 2);
  const view = new DataView(output);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + totalFrames * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, totalFrames * 2, true);
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const raw = Number(samples[frame] || 0);
    const absolute = Math.abs(raw);
    // 0.82 以下保持原动态；超出的叠加峰值用软膝收进 1.0，避免 TTS、动作和
    // 背景同时出现时直接硬削波，也不会为了防峰值把整段动作声重新压小。
    const limitedAbsolute = !softLimit || absolute <= 0.82
      ? absolute
      : 0.82 + (0.18 * Math.tanh((absolute - 0.82) / 0.18));
    const sample = Math.max(-1, Math.min(1, Math.sign(raw) * limitedAbsolute));
    view.setInt16(
      44 + frame * 2,
      sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff),
      true,
    );
  }
  return new Blob([output], { type: 'audio/wav' });
}

export function audioBuffersToMonoWav(buffers = [], gapsBeforeMs = [], sampleRate = 44100) {
  const gapFrames = buffers.map((_, index) => Math.max(
    0,
    Math.round((Number(gapsBeforeMs[index] || 0) / 1000) * sampleRate),
  ));
  const totalFrames = buffers.reduce((sum, buffer, index) => (
    sum + gapFrames[index] + Number(buffer?.length || 0)
  ), 0);
  if (!totalFrames) throw new Error('缓存音频为空');
  if (totalFrames / sampleRate > 30 * 60) {
    throw new Error('本轮语音超过 30 分钟，暂不适合在手机内合并导出');
  }

  const samples = new Float32Array(totalFrames);
  let frameCursor = 0;
  buffers.forEach((buffer, bufferIndex) => {
    frameCursor += gapFrames[bufferIndex];
    const channels = Math.max(1, Number(buffer.numberOfChannels || 1));
    const channelData = Array.from(
      { length: channels },
      (_, channel) => buffer.getChannelData(channel),
    );
    for (let frame = 0; frame < buffer.length; frame += 1) {
      let sample = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        sample += Number(channelData[channel]?.[frame] || 0);
      }
      samples[frameCursor + frame] = sample / channels;
    }
    frameCursor += buffer.length;
  });
  return monoSamplesToWav(samples, sampleRate);
}

function bufferDuration(buffer) {
  return Math.max(0, Number(buffer?.duration || 0));
}

function addAudioBufferToMix(
  samples,
  buffer,
  startSeconds,
  volume,
  sampleRate,
  playbackRate = 1,
  endSeconds = Number.POSITIVE_INFINITY,
  envelope = {},
) {
  if (!buffer?.length || !samples?.length) return;
  const channels = Math.max(1, Number(buffer.numberOfChannels || 1));
  const channelData = Array.from(
    { length: channels },
    (_, channel) => buffer.getChannelData(channel),
  );
  const sourceRate = Math.max(1, Number(buffer.sampleRate || sampleRate));
  const startFrame = Math.max(0, Math.round(startSeconds * sampleRate));
  const rate = Math.max(0.5, Math.min(2, Number(playbackRate || 1)));
  const maxFrames = Number.isFinite(endSeconds)
    ? Math.max(0, Math.round((endSeconds - startSeconds) * sampleRate))
    : Number.POSITIVE_INFINITY;
  const outputFrames = Math.min(
    maxFrames,
    Math.max(0, Math.round((bufferDuration(buffer) / rate) * sampleRate)),
  );
  const fadeInFrames = Math.max(0, Math.round(Number(envelope.fadeInSeconds || 0) * sampleRate));
  const fadeOutFrames = Math.max(0, Math.round(Number(envelope.fadeOutSeconds || 0) * sampleRate));
  for (let frame = 0; frame < outputFrames && startFrame + frame < samples.length; frame += 1) {
    const sourceFrame = Math.min(
      buffer.length - 1,
      Math.max(0, Math.floor((frame * sourceRate * rate) / sampleRate)),
    );
    let sample = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sample += Number(channelData[channel]?.[sourceFrame] || 0);
    }
    const fadeInGain = fadeInFrames ? Math.min(1, frame / fadeInFrames) : 1;
    const remainingFrames = Math.max(0, outputFrames - 1 - frame);
    const fadeOutGain = fadeOutFrames ? Math.min(1, remainingFrames / fadeOutFrames) : 1;
    samples[startFrame + frame] += (sample / channels) * volume * fadeInGain * fadeOutGain;
  }
}

function addLoopingBackgroundToMix(samples, buffer, {
  volume = 0.2,
  sampleRate = 44100,
  speechWindows = [],
  fadeInSeconds = 0.52,
  fadeOutSeconds = 0.24,
  duckRatio = 0.58,
} = {}) {
  if (!buffer?.length || !samples?.length || volume <= 0) return;
  const channels = Math.max(1, Number(buffer.numberOfChannels || 1));
  const channelData = Array.from(
    { length: channels },
    (_, channel) => buffer.getChannelData(channel),
  );
  const sourceRate = Math.max(1, Number(buffer.sampleRate || sampleRate));
  const durationSeconds = samples.length / sampleRate;
  let speechIndex = 0;
  for (let frame = 0; frame < samples.length; frame += 1) {
    const time = frame / sampleRate;
    while (speechIndex < speechWindows.length - 1
      && time >= speechWindows[speechIndex][1]) speechIndex += 1;
    const speech = speechWindows[speechIndex];
    const ducked = !!speech && time >= speech[0] && time < speech[1];
    const fadeIn = fadeInSeconds > 0 ? Math.min(1, time / fadeInSeconds) : 1;
    const fadeOut = fadeOutSeconds > 0
      ? Math.min(1, Math.max(0, durationSeconds - time) / fadeOutSeconds)
      : 1;
    const sourceFrame = Math.floor(time * sourceRate) % buffer.length;
    let sample = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sample += Number(channelData[channel]?.[sourceFrame] || 0);
    }
    samples[frame] += (sample / channels)
      * volume
      * fadeIn
      * fadeOut
      * (ducked ? duckRatio : 1);
  }
}

async function downloadMixedWav(wav, filenameBase) {
  const filename = `${cleanFilenamePart(filenameBase)}.wav`;
  const result = await downloadBlob(wav, filename, {
    mimeType: 'audio/wav',
    directory: 'downloads',
  });
  return {
    ...result,
    message: describeDownloadResult(result),
  };
}

export async function mixVoiceSequenceToWav(segments = [], {
  backgrounds = [],
} = {}) {
  const rows = (Array.isArray(segments) ? segments : []).filter((item) => item?.payload);
  if (!rows.length) throw new Error('这一轮没有可导出的语音缓存');
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioContextCtor !== 'function') {
    throw new Error('当前浏览器不支持本地混音导出');
  }
  const context = new AudioContextCtor();
  try {
    const decodedBlobCache = new WeakMap();
    const decodeBlob = (blob) => {
      if (!(blob instanceof Blob) || !blob.size) return Promise.resolve(null);
      if (!decodedBlobCache.has(blob)) {
        decodedBlobCache.set(blob, blob.arrayBuffer()
          .then((bytes) => decodeAudioData(context, bytes)));
      }
      return decodedBlobCache.get(blob);
    };
    const decodedRows = [];
    for (const row of rows) {
      const voiceBlob = blobForVoicePayload(row.payload);
      if (!voiceBlob?.size) throw new Error('本轮有一段语音缓存已经失效');
      const before = [];
      for (const item of Array.isArray(row.soundBefore) ? row.soundBefore : []) {
        if (!(item?.blob instanceof Blob) || !item.blob.size) continue;
        before.push({
          ...item,
          buffer: await decodeBlob(item.blob),
        });
      }
      const after = [];
      for (const item of Array.isArray(row.soundAfter) ? row.soundAfter : []) {
        if (!(item?.blob instanceof Blob) || !item.blob.size) continue;
        after.push({
          ...item,
          buffer: await decodeBlob(item.blob),
        });
      }
      const textureAssets = [];
      for (const item of Array.isArray(row.texturePlan?.assets) ? row.texturePlan.assets : []) {
        const buffers = [];
        const gains = [];
        const sources = Array.isArray(item?.sources)
          ? item.sources
          : (Array.isArray(item?.blobs) ? item.blobs.map((blob) => ({ blob, mixGain: 1 })) : []);
        for (const source of sources) {
          const blob = source?.blob;
          if (!(blob instanceof Blob) || !blob.size) continue;
          buffers.push(await decodeBlob(blob));
          gains.push(Math.max(0.5, Math.min(2, Number(source?.mixGain || 1) || 1)));
        }
        if (buffers.length) textureAssets.push({ category: item.category, buffers, gains });
      }
      decodedRows.push({
        ...row,
        voiceBuffer: await decodeBlob(voiceBlob),
        before,
        after,
        texturePlan: row.texturePlan
          ? { ...row.texturePlan, assets: textureAssets }
          : null,
      });
    }
    const decodedBackgrounds = [];
    for (const item of Array.isArray(backgrounds) ? backgrounds : []) {
      if (!(item?.blob instanceof Blob) || !item.blob.size) continue;
      decodedBackgrounds.push({
        ...item,
        buffer: await decodeBlob(item.blob),
      });
    }

    const events = [];
    const speechWindows = [];
    let cursor = 0;
    decodedRows.forEach((row, index) => {
      const serialBefore = row.before.filter((item) => item.overlay !== true);
      const overlayBefore = row.before.filter((item) => item.overlay === true);
      const hasBefore = serialBefore.length > 0;
      if (index > 0) {
        const gapMs = Math.max(0, Number(row.gapBeforeMs || 0));
        cursor += (hasBefore
          ? Math.min(220, Math.max(100, Math.round(gapMs * 0.3)))
          : gapMs) / 1000;
      }
      serialBefore.forEach((item, soundIndex) => {
        const envelope = resolveSoundCueEnvelope(item.category, bufferDuration(item.buffer) * 1000);
        events.push({
          buffer: item.buffer,
          start: cursor,
          volume: Number(item.volume || 0),
          fadeInSeconds: envelope.fadeInMs / 1000,
          fadeOutSeconds: envelope.fadeOutMs / 1000,
        });
        cursor += bufferDuration(item.buffer);
        if (soundIndex < serialBefore.length - 1) cursor += envelope.postGapMs / 1000;
      });
      if (hasBefore) {
        cursor += resolveSoundCueEnvelope(serialBefore.at(-1)?.category).postGapMs / 1000;
      }
      const voiceStart = cursor;
      const voiceEnd = voiceStart + bufferDuration(row.voiceBuffer);
      const textureSchedule = row.texturePlan?.assets?.length
        ? buildTextureSoundSchedule(row.texturePlan, {
          durationMs: bufferDuration(row.voiceBuffer) * 1000,
          seed: row.texturePlan.seed || '',
        })
        : [];
      const scheduledTextureGains = textureSchedule.map((textureEvent) => {
        const assetGroup = row.texturePlan.assets.find((item) => (
          item.category === textureEvent.category
        ));
        if (!assetGroup?.buffers?.length) return 1;
        const assetIndex = Math.abs(Number(textureEvent.assetIndex || 0)) % assetGroup.buffers.length;
        return Number(assetGroup.gains?.[assetIndex] || 1);
      });
      events.push({
        buffer: row.voiceBuffer,
        start: voiceStart,
        volume: resolveSpeechTextureVoiceVolume(scheduledTextureGains),
      });
      overlayBefore.forEach((item) => {
        const envelope = resolveSoundCueEnvelope(item.category, bufferDuration(item.buffer) * 1000);
        events.push({
          buffer: item.buffer,
          start: voiceStart,
          end: voiceEnd,
          volume: Number(item.volume || 0),
          fadeInSeconds: envelope.fadeInMs / 1000,
          fadeOutSeconds: Math.max(0.2, envelope.fadeOutMs / 1000),
        });
      });
      speechWindows.push([voiceStart, voiceEnd]);
      if (row.texturePlan?.assets?.length) {
        textureSchedule.forEach((textureEvent) => {
          const assetGroup = row.texturePlan.assets.find((item) => (
            item.category === textureEvent.category
          ));
          if (!assetGroup?.buffers?.length) return;
          const textureBuffer = assetGroup.buffers[
            Math.abs(Number(textureEvent.assetIndex || 0)) % assetGroup.buffers.length
          ];
          const textureAssetIndex = Math.abs(Number(textureEvent.assetIndex || 0)) % assetGroup.buffers.length;
          events.push({
            buffer: textureBuffer,
            start: voiceStart + textureEvent.offsetMs / 1000,
            volume: resolveSpeechTextureMixVolume(
              row.texturePlan.volume ?? 0.58,
              textureEvent.gain,
              textureEvent.category,
            ) * Number(assetGroup.gains?.[textureAssetIndex] || 1),
            playbackRate: textureEvent.playbackRate,
            end: voiceEnd,
            fadeInSeconds: 0.04,
            fadeOutSeconds: 0.2,
          });
        });
      }
      cursor = voiceEnd;
      if (index === decodedRows.length - 1 && row.after.length) {
        cursor += resolveSoundCueEnvelope(row.after[0]?.category).postGapMs / 1000;
        row.after.forEach((item, soundIndex) => {
          const envelope = resolveSoundCueEnvelope(item.category, bufferDuration(item.buffer) * 1000);
          events.push({
            buffer: item.buffer,
            start: cursor,
            volume: Number(item.volume || 0),
            fadeInSeconds: envelope.fadeInMs / 1000,
            fadeOutSeconds: envelope.fadeOutMs / 1000,
          });
          cursor += bufferDuration(item.buffer);
          if (soundIndex < row.after.length - 1) cursor += envelope.postGapMs / 1000;
        });
      }
    });

    const sampleRate = Math.max(8000, Number(context.sampleRate || 44100));
    if (cursor <= 0) throw new Error('缓存音频为空');
    const backgroundTailSeconds = decodedBackgrounds.reduce((tail, item) => (
      Math.max(tail, String(item.category || '').startsWith('bgm') ? 1.61 : 1.08)
    ), 0);
    const mixDuration = cursor + backgroundTailSeconds;
    if (mixDuration > 10 * 60) throw new Error('本轮混音超过 10 分钟，暂不适合在手机内导出');
    const samples = new Float32Array(Math.ceil(mixDuration * sampleRate));
    events.forEach((event) => {
      addAudioBufferToMix(
        samples,
        event.buffer,
        event.start,
        event.volume,
        sampleRate,
        event.playbackRate,
        event.end,
        {
          fadeInSeconds: event.fadeInSeconds,
          fadeOutSeconds: event.fadeOutSeconds,
        },
      );
    });
    decodedBackgrounds.forEach((item) => {
      const isBgm = String(item.category || '').startsWith('bgm');
      addLoopingBackgroundToMix(samples, item.buffer, {
        volume: Number(item.volume || 0),
        sampleRate,
        speechWindows,
        fadeInSeconds: isBgm ? 0.72 : 0.52,
        fadeOutSeconds: isBgm ? 1.25 : 0.72,
        duckRatio: isBgm ? 0.54 : 0.76,
      });
    });
    return monoSamplesToWav(samples, sampleRate, { softLimit: true });
  } finally {
    try { await context.close?.(); } catch (_) {}
  }
}

export async function exportMixedVoiceSequence(segments = [], {
  backgrounds = [],
  filenameBase = '本轮混音',
} = {}) {
  const wav = await mixVoiceSequenceToWav(segments, { backgrounds });
  return downloadMixedWav(wav, filenameBase);
}

export async function exportCachedVoicePayload(payload = {}, {
  filenameBase = '角色语音',
} = {}) {
  const blob = blobForVoicePayload(payload);
  if (!blob?.size) throw new Error('这条语音的本地缓存已经失效');
  const extension = extensionForVoicePayload(payload, blob);
  const filename = `${cleanFilenamePart(filenameBase)}.${extension}`;
  const result = await downloadBlob(blob, filename, {
    mimeType: blob.type || mimeForExtension(extension),
    directory: 'downloads',
  });
  return {
    ...result,
    message: describeDownloadResult(result),
  };
}

export async function exportCachedVoiceSequence(segments = [], {
  filenameBase = '本轮语音',
} = {}) {
  const rows = (Array.isArray(segments) ? segments : []).filter((item) => item?.payload);
  if (!rows.length) throw new Error('这一轮没有可导出的语音缓存');
  if (rows.length === 1 && Number(rows[0].gapBeforeMs || 0) <= 0) {
    return exportCachedVoicePayload(rows[0].payload, { filenameBase });
  }

  const merged = await mergeCachedVoiceSequence(rows);
  try {
    const filename = `${cleanFilenamePart(filenameBase)}.wav`;
    const result = await downloadBlob(merged.audioBlob, filename, {
      mimeType: 'audio/wav',
      directory: 'downloads',
    });
    return {
      ...result,
      message: describeDownloadResult(result),
    };
  } finally { /* mergeCachedVoiceSequence owns and closes its decoder context */ }
}

/**
 * 把多条已经合成的语音在本地渲染成一条 WAV，不触发下载。
 * 电台用它把短表演段收束成单个章节 Blob；播放器和导出仍只面对一条音轨。
 */
export async function mergeCachedVoiceSequence(segments = []) {
  const rows = (Array.isArray(segments) ? segments : []).filter((item) => item?.payload);
  if (!rows.length) throw new Error('没有可合并的语音片段');
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioContextCtor !== 'function') throw new Error('当前浏览器不支持合并音频');
  const context = new AudioContextCtor();
  try {
    const buffers = [];
    for (const row of rows) {
      const blob = blobForVoicePayload(row.payload);
      if (!blob?.size) throw new Error('有一段语音缓存已经失效');
      buffers.push(await decodeAudioData(context, await blob.arrayBuffer()));
    }
    const sampleRate = context.sampleRate || 44100;
    const gapsBeforeMs = rows.map((row) => Math.max(0, Number(row.gapBeforeMs || 0) || 0));
    const timings = [];
    let cursorSeconds = 0;
    buffers.forEach((buffer, index) => {
      cursorSeconds += gapsBeforeMs[index] / 1000;
      const durationSeconds = Math.max(0, Number(buffer?.duration || 0));
      timings.push({
        startSeconds: cursorSeconds,
        durationSeconds,
        endSeconds: cursorSeconds + durationSeconds,
        gapBeforeMs: gapsBeforeMs[index],
      });
      cursorSeconds += durationSeconds;
    });
    return {
      audioBlob: audioBuffersToMonoWav(buffers, gapsBeforeMs, sampleRate),
      durationSeconds: cursorSeconds,
      timings,
      sampleRate,
    };
  } finally {
    try { await context.close?.(); } catch (_) {}
  }
}
