function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    if (!(blob instanceof Blob)) {
      resolve('');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('本地音乐读取失败'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl, fallbackType = 'audio/mpeg') {
  const source = String(dataUrl || '');
  const commaAt = source.indexOf(',');
  if (commaAt <= 0) return null;
  const header = source.slice(0, commaAt);
  if (!/^data:[^;,]*;base64$/i.test(header)) return null;
  try {
    const type = header.slice(5, header.length - ';base64'.length) || fallbackType || 'audio/mpeg';
    const base64 = source.slice(commaAt + 1);
    // 一次性 atob 大音频会同时持有 Base64、等大的 binary string 和 Uint8Array，
    // Android WebView 容易在资源段尾部 OOM。按 256KB（4 字节对齐）分块解码，
    // Blob 可直接接收分块，避免再创建一份完整连续数组。
    const parts = [];
    const step = 256 * 1024;
    for (let offset = 0; offset < base64.length; offset += step) {
      const binary = atob(base64.slice(offset, Math.min(base64.length, offset + step)));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      parts.push(bytes);
    }
    return new Blob(parts, { type });
  } catch (_) {
    return null;
  }
}

export const BACKUP_BLOB_BASE64_CHUNK_BYTES = 192 * 1024;

function bytesToBinaryString(bytes) {
  let text = '';
  const step = 8 * 1024;
  for (let i = 0; i < bytes.length; i += step) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + step)));
  }
  return text;
}

/** 将 Blob 直接按 3 字节对齐的切片写成连续 base64，不创建整包 Data URL。 */
export async function appendBlobBase64ToWriter(writer, blob) {
  for (let offset = 0; offset < blob.size; offset += BACKUP_BLOB_BASE64_CHUNK_BYTES) {
    const slice = blob.slice(offset, Math.min(blob.size, offset + BACKUP_BLOB_BASE64_CHUNK_BYTES));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    writer.write(btoa(bytesToBinaryString(bytes)));
    if (writer.shouldDrain) await writer.drain();
  }
}

/** 向流式 JSON writer 写入一条本地音乐资源；无可导出音频时返回 false。 */
export async function appendMusicAssetJsonToWriter(writer, track, { prefix = '' } = {}) {
  if (!track || typeof track !== 'object' || !track.id || track.source !== 'local') return false;
  const audioBlob = track.audioBlob;
  if (!(audioBlob instanceof Blob) || !audioBlob.size) return false;
  const audioType = String(track.audioType || audioBlob.type || 'audio/mpeg');
  const dataUrlPrefix = `data:${audioType};base64,`;
  writer.write(prefix);
  writer.write(`{"id":${JSON.stringify(String(track.id))},"audioDataUrl":`);
  // 保留 JSON 字符串的开头，base64 正文逐片追加，最后再补闭合引号。
  writer.write(JSON.stringify(dataUrlPrefix).slice(0, -1));
  await appendBlobBase64ToWriter(writer, audioBlob);
  writer.write(`","audioType":${JSON.stringify(audioType)}`);
  writer.write(`,"fileName":${JSON.stringify(String(track.fileName || ''))}`);
  writer.write(`,"fileModified":${Number(track.fileModified || 0) || 0}`);
  writer.write(`,"songSize":${Number(track.songSize || audioBlob.size || 0) || 0}}`);
  return true;
}

/** 音效库与本地音乐共用分片 base64 写法，避免大音频在内存里复制多份。 */
export async function appendSoundAssetJsonToWriter(writer, asset, { prefix = '' } = {}) {
  if (!asset || typeof asset !== 'object' || !asset.id) return false;
  const audioBlob = asset.audioBlob;
  if (!(audioBlob instanceof Blob) || !audioBlob.size) return false;
  const audioType = String(asset.audioType || audioBlob.type || 'audio/mpeg');
  const dataUrlPrefix = `data:${audioType};base64,`;
  writer.write(prefix);
  writer.write(`{"id":${JSON.stringify(String(asset.id))},"audioDataUrl":`);
  writer.write(JSON.stringify(dataUrlPrefix).slice(0, -1));
  await appendBlobBase64ToWriter(writer, audioBlob);
  writer.write(`","audioType":${JSON.stringify(audioType)}`);
  writer.write(`,"size":${Number(asset.size || audioBlob.size || 0) || 0}`);
  writer.write(`,"name":${JSON.stringify(String(asset.name || ''))}`);
  writer.write(`,"category":${JSON.stringify(String(asset.category || ''))}`);
  writer.write(`,"categoryLabel":${JSON.stringify(String(asset.categoryLabel || ''))}`);
  writer.write(`,"categoryHint":${JSON.stringify(String(asset.categoryHint || ''))}`);
  writer.write(`,"categoryMode":${JSON.stringify(String(asset.categoryMode || ''))}`);
  writer.write(`,"enabled":${asset.enabled !== false}`);
  writer.write(`,"mixGain":${Number(asset.mixGain || 1) || 1}`);
  writer.write(`,"texturePlayback":${JSON.stringify(String(asset.texturePlayback || 'auto'))}`);
  writer.write(`,"durationMs":${Number(asset.durationMs || 0) || 0}`);
  writer.write(`,"sourceName":${JSON.stringify(String(asset.sourceName || ''))}`);
  writer.write(`,"createdAt":${Number(asset.createdAt || 0) || 0}}`);
  return true;
}

/** 本地音乐二进制只进入资源包，核心备份保留曲目和歌单元数据。 */
export async function extractMusicAssetRow(track) {
  if (!track || typeof track !== 'object' || !track.id || track.source !== 'local') return null;
  if (!(track.audioBlob instanceof Blob) || !track.audioBlob.size) return null;
  const audioDataUrl = await blobToDataUrl(track.audioBlob);
  if (!audioDataUrl) return null;
  return {
    id: String(track.id),
    audioDataUrl,
    audioType: String(track.audioType || track.audioBlob.type || ''),
    fileName: String(track.fileName || ''),
    fileModified: Number(track.fileModified || 0) || 0,
    songSize: Number(track.songSize || track.audioBlob.size || 0) || 0,
  };
}

/** 按曲目 id 把资源包音频合回完整备份先恢复出的曲目记录。 */
export function mergeMusicAssetRow(existing, patch) {
  if (!existing || !patch?.id || existing.id !== patch.id) return null;
  const audioBlob = dataUrlToBlob(patch.audioDataUrl, patch.audioType);
  if (!audioBlob) return null;
  return {
    ...existing,
    source: 'local',
    provider: 'local',
    audioBlob,
    audioType: String(patch.audioType || audioBlob.type || ''),
    fileName: String(patch.fileName || existing.fileName || ''),
    fileModified: Number(patch.fileModified || existing.fileModified || 0) || 0,
    songSize: Number(patch.songSize || audioBlob.size || 0) || 0,
    updatedAt: Date.now(),
  };
}

export function mergeSoundAssetRow(existing, patch) {
  if (!patch?.id || (existing && existing.id !== patch.id)) return null;
  const audioBlob = dataUrlToBlob(patch.audioDataUrl, patch.audioType);
  if (!audioBlob) return null;
  return {
    ...(existing || {}),
    id: String(patch.id),
    name: String(patch.name || existing?.name || '导入音频'),
    category: String(patch.category || existing?.category || 'ambience'),
    categoryLabel: String(patch.categoryLabel || existing?.categoryLabel || ''),
    categoryHint: String(patch.categoryHint || existing?.categoryHint || ''),
    categoryMode: String(patch.categoryMode || existing?.categoryMode || ''),
    enabled: patch.enabled !== false && existing?.enabled !== false,
    mixGain: Number(patch.mixGain || existing?.mixGain || 1) || 1,
    texturePlayback: String(patch.texturePlayback || existing?.texturePlayback || 'auto'),
    audioBlob,
    audioType: String(patch.audioType || audioBlob.type || ''),
    size: Number(patch.size || audioBlob.size || 0) || 0,
    durationMs: Number(patch.durationMs || existing?.durationMs || 0) || 0,
    sourceName: String(patch.sourceName || existing?.sourceName || ''),
    createdAt: Number(patch.createdAt || existing?.createdAt || Date.now()) || Date.now(),
    updatedAt: Date.now(),
  };
}
