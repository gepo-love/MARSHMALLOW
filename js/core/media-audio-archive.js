import * as db from './db.js';
import { downloadBlob, isNativeShell, pickWebSaveWritable } from './native-download.js';
import { beginNativeChunkedBinarySave } from './native-file-export.js';
import { StoreZipStreamWriter } from './zip-store-stream.js';

const VOICE_PREFIXES = ['voiceAudioCache_', 'callLineVoice_', 'streamerLineVoice_'];

function pad(value) { return String(value).padStart(2, '0'); }
function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function cleanName(value = '', fallback = '音频') {
  return String(value || '').replace(/[\\/:*?"<>|\r\n\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 54) || fallback;
}

function dataUrlToBlob(dataUrl = '') {
  const raw = String(dataUrl || '');
  const match = raw.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) return null;
  const mime = String(match[1] || 'application/octet-stream');
  try {
    if (!match[2]) return new Blob([decodeURIComponent(match[3] || '')], { type: mime });
    const binary = atob(String(match[3] || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  } catch (_) {
    return null;
  }
}

function payloadBlob(payload = {}) {
  if (payload instanceof Blob && payload.size) return payload;
  if (payload.audioBlob instanceof Blob && payload.audioBlob.size) return payload.audioBlob;
  if (payload.blob instanceof Blob && payload.blob.size) return payload.blob;
  return dataUrlToBlob(payload.audioDataUrl || payload.url || '');
}

function audioExtension(payload = {}, blob = null) {
  const format = String(payload.format || '').toLowerCase();
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'pcm'].includes(format)) return format;
  const mime = String(blob?.type || '').toLowerCase();
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('aac')) return 'aac';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  return 'mp3';
}

class MemoryBinarySink {
  constructor() { this.parts = []; this.bytes = 0; }
  async write(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.parts.push(bytes);
    this.bytes += bytes.byteLength;
  }
  async close() {}
  async abort() { this.parts.length = 0; this.bytes = 0; }
  toBlob() { return new Blob(this.parts, { type: 'application/zip' }); }
}

function deferredZipSave(blob, filename) {
  return {
    ok: true,
    method: 'deferred',
    filename,
    bytes: blob.size,
    requiresSaveGesture: true,
    save: () => downloadBlob(blob, filename, { mimeType: 'application/zip', directory: 'downloads' }),
  };
}

async function createZipTarget(filename) {
  const native = isNativeShell();
  const webTarget = native ? null : await pickWebSaveWritable(filename, { mimeType: 'application/zip' });
  const sink = native
    ? await beginNativeChunkedBinarySave({ filename, mimeType: 'application/zip', directory: 'downloads' })
    : (webTarget?.writable || new MemoryBinarySink());
  return { native, webTarget, sink, zip: new StoreZipStreamWriter(sink) };
}

function finalizedZipSave(target, filename) {
  if (target.native) return target.sink.result;
  if (target.webTarget?.writable) return { ok: true, method: 'browser-fs', filename, bytes: target.zip.offset };
  return deferredZipSave(target.sink.toBlob(), filename);
}

export async function exportAudioMediaArchive(options = {}) {
  const includeVoice = options.includeVoice !== false;
  const includeSounds = options.includeSounds !== false;
  if (!includeVoice && !includeSounds) throw new Error('请至少选择一类音频');
  const filename = `marshmallow-audio-${includeVoice && includeSounds ? 'all' : (includeVoice ? 'voice' : 'sounds')}-${stamp()}.zip`;
  const target = await createZipTarget(filename);
  const { sink, zip } = target;
  const manifest = {
    format: 'marshmallow-audio-archive',
    version: 1,
    exportedAt: new Date().toISOString(),
    voice: [], sounds: [], radio: [], music: [],
  };
  let files = 0;
  let audioBytes = 0;
  try {
    if (includeVoice) {
      const settingKeys = (await db.getAllKeys('settings')).map(String);
      const keys = settingKeys.filter((key) => VOICE_PREFIXES.some((prefix) => key.startsWith(prefix)));
      for (let index = 0; index < keys.length; index += 1) {
        const row = await db.getRecord('settings', keys[index]);
        const payload = row?.value || {};
        const blob = payloadBlob(payload);
        if (!blob?.size) continue;
        const extension = audioExtension(payload, blob);
        const base = cleanName(payload.text || payload.textPreview || payload.voiceId || keys[index], `语音-${index + 1}`);
        const entryName = `voice/${String(index + 1).padStart(4, '0')}-${base}.${extension}`;
        await zip.addBlobEntry(entryName, blob, {
          onProgress: (detail) => options.onProgress?.({ ...detail, kind: 'voice', file: index + 1, totalFiles: keys.length }),
        });
        manifest.voice.push({ file: entryName, storageKey: keys[index], text: String(payload.text || '').slice(0, 160), bytes: blob.size });
        files += 1;
        audioBytes += blob.size;
      }
      const radioKeys = settingKeys.filter((key) => key.startsWith('radioAudioBlob_'));
      for (let index = 0; index < radioKeys.length; index += 1) {
        const row = await db.getRecord('settings', radioKeys[index]);
        const blob = payloadBlob(row?.value);
        if (!blob?.size) continue;
        const extension = audioExtension(row?.value || {}, blob);
        const entryName = `radio/${String(index + 1).padStart(4, '0')}-${cleanName(radioKeys[index].slice('radioAudioBlob_'.length), '节目')}.${extension}`;
        await zip.addBlobEntry(entryName, blob, {
          onProgress: (detail) => options.onProgress?.({ ...detail, kind: 'radio', file: index + 1, totalFiles: radioKeys.length }),
        });
        manifest.radio.push({ file: entryName, storageKey: radioKeys[index], bytes: blob.size });
        files += 1;
        audioBytes += blob.size;
      }
    }
    if (includeSounds) {
      const keys = await db.getAllKeys('soundAssets');
      for (let index = 0; index < keys.length; index += 1) {
        const row = await db.getRecord('soundAssets', keys[index]);
        const blob = payloadBlob(row || {});
        if (!blob?.size) continue;
        const extension = audioExtension(row, blob);
        const base = cleanName(row?.name || row?.title || keys[index], `音效-${index + 1}`);
        const category = cleanName(row?.category || 'other', 'other');
        const entryName = `sounds/${category}/${String(index + 1).padStart(4, '0')}-${base}.${extension}`;
        await zip.addBlobEntry(entryName, blob, {
          onProgress: (detail) => options.onProgress?.({ ...detail, kind: 'sounds', file: index + 1, totalFiles: keys.length }),
        });
        manifest.sounds.push({ file: entryName, id: String(row?.id || keys[index]), category: String(row?.category || ''), bytes: blob.size });
        files += 1;
        audioBytes += blob.size;
      }
      const musicKeys = await db.getAllKeys('musicTracks');
      for (let index = 0; index < musicKeys.length; index += 1) {
        const row = await db.getRecord('musicTracks', musicKeys[index]);
        const blob = payloadBlob(row || {});
        if (!blob?.size) continue;
        const extension = audioExtension(row, blob);
        const entryName = `music/${String(index + 1).padStart(4, '0')}-${cleanName(row?.title || row?.name || musicKeys[index], '本地音乐')}.${extension}`;
        await zip.addBlobEntry(entryName, blob, {
          onProgress: (detail) => options.onProgress?.({ ...detail, kind: 'music', file: index + 1, totalFiles: musicKeys.length }),
        });
        manifest.music.push({ file: entryName, id: String(row?.id || musicKeys[index]), title: String(row?.title || row?.name || ''), bytes: blob.size });
        files += 1;
        audioBytes += blob.size;
      }
    }
    if (!files) throw new Error('没有可导出的本地音频');
    await zip.addEntry('manifest.json', JSON.stringify(manifest, null, 2));
    await zip.close();
    const saved = finalizedZipSave(target, filename);
    return {
      filename, saved, files, audioBytes,
      voice: manifest.voice.length,
      sounds: manifest.sounds.length,
      radio: manifest.radio.length,
      music: manifest.music.length,
    };
  } catch (error) {
    await sink.abort?.().catch(() => {});
    throw error;
  }
}

function collectInlineImages(value, path = '', found = [], ancestors = new Set()) {
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value)) found.push({ path, dataUrl: value });
    return found;
  }
  if (!value || typeof value !== 'object' || value instanceof Blob || ancestors.has(value)) return found;
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectInlineImages(item, `${path}[${index}]`, found, ancestors));
  } else {
    Object.entries(value).forEach(([key, item]) => collectInlineImages(item, path ? `${path}.${key}` : key, found, ancestors));
  }
  ancestors.delete(value);
  return found;
}

function imageExtension(blob = null) {
  const mime = String(blob?.type || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

export async function exportChatImageArchive(options = {}) {
  const filename = `marshmallow-chat-images-${stamp()}.zip`;
  const target = await createZipTarget(filename);
  const { sink, zip } = target;
  const manifest = { format: 'marshmallow-chat-image-archive', version: 1, exportedAt: new Date().toISOString(), images: [] };
  let files = 0;
  let imageBytes = 0;
  try {
    await db.forEachStoreRecordBatched('messages', async (row) => {
      const found = collectInlineImages(row);
      const seen = new Set();
      let localIndex = 0;
      for (const item of found) {
        if (seen.has(item.dataUrl)) continue;
        seen.add(item.dataUrl);
        const blob = dataUrlToBlob(item.dataUrl);
        if (!blob?.size) continue;
        localIndex += 1;
        const chat = cleanName(row?.chatId || 'unknown', 'unknown');
        const id = cleanName(row?.id || `${row?.timestamp || Date.now()}`, '图片');
        const entryName = `chat-images/${chat}/${id}${localIndex > 1 ? `-${localIndex}` : ''}.${imageExtension(blob)}`;
        await zip.addBlobEntry(entryName, blob, {
          onProgress: (detail) => options.onProgress?.({ ...detail, file: files + 1 }),
        });
        manifest.images.push({
          file: entryName,
          messageId: String(row?.id || ''),
          chatId: String(row?.chatId || ''),
          timestamp: Number(row?.timestamp || 0),
          sourcePath: item.path,
          caption: String(row?.metadata?.caption || '').slice(0, 240),
          bytes: blob.size,
        });
        files += 1;
        imageBytes += blob.size;
      }
    }, { batchSize: 1, onBatch: () => new Promise((resolve) => setTimeout(resolve, 0)) });
    if (!files) throw new Error('没有可导出的聊天图片');
    await zip.addEntry('manifest.json', JSON.stringify(manifest, null, 2));
    await zip.close();
    return { filename, saved: finalizedZipSave(target, filename), files, imageBytes };
  } catch (error) {
    await sink.abort?.().catch(() => {});
    throw error;
  }
}
