import { inflateRaw } from './inflate-raw.js';
import {
  soundAssetCategoryFromPrefixedName,
  soundAssetMimeTypeForName,
  stripSoundAssetCategoryPrefix,
} from './sound-library.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_PACK_BYTES = 128 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 500;
const AUDIO_EXTENSION = /\.(wav|mp3|m4a|aac|ogg|flac)$/i;
const CUSTOM_CATEGORY_ID_RE = /^user_(cue|texture|background)_[a-z0-9]{6,48}$/u;

function readAsArrayBuffer(file) {
  if (typeof file?.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取 ZIP 失败'));
    reader.readAsArrayBuffer(file);
  });
}

function findEndOfCentralDirectory(view) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function decodeName(bytes) {
  return new TextDecoder('utf-8').decode(bytes).replace(/\\/g, '/');
}

function basename(path = '') {
  return String(path || '').replace(/\\/g, '/').split('/').pop() || '';
}

async function unpackEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localOffset;
  if (offset < 0 || offset + 30 > bytes.byteLength
    || view.getUint32(offset, true) !== LOCAL_SIGNATURE) {
    throw new Error(`ZIP 条目「${entry.name}」位置无效`);
  }
  const localNameLength = view.getUint16(offset + 26, true);
  const localExtraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > bytes.byteLength) {
    throw new Error(`ZIP 条目「${entry.name}」数据不完整`);
  }
  const compressed = bytes.slice(dataStart, dataEnd);
  let raw;
  if (entry.method === 0) raw = compressed;
  else if (entry.method === 8) {
    raw = await inflateRaw(compressed, `无法解压音频「${entry.name}」`);
  } else {
    throw new Error(`ZIP 条目「${entry.name}」使用了不支持的压缩方式`);
  }
  if (entry.uncompressedSize && raw.byteLength !== entry.uncompressedSize) {
    throw new Error(`ZIP 条目「${entry.name}」大小校验失败`);
  }
  return raw;
}

export async function readSoundAssetPackZip(file) {
  const fileSize = Math.max(0, Number(file?.size || 0));
  if (fileSize > MAX_PACK_BYTES) throw new Error('音频包不能超过 128 MB');
  const buffer = await readAsArrayBuffer(file);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 22) {
    throw new Error('ZIP 文件为空或不完整');
  }
  if (buffer.byteLength > MAX_PACK_BYTES) throw new Error('音频包不能超过 128 MB');
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('不是有效的 ZIP 音频包');
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (!totalEntries || totalEntries > MAX_ENTRIES) {
    throw new Error(`ZIP 条目数量必须在 1–${MAX_ENTRIES} 之间`);
  }

  const entries = [];
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error('ZIP 中央目录不完整');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error('ZIP 文件名数据不完整');
    const name = decodeName(bytes.slice(nameStart, nameEnd));
    if ((flags & 0x0001) !== 0) throw new Error('暂不支持加密 ZIP');
    if (uncompressedSize > MAX_ASSET_BYTES) {
      throw new Error(`ZIP 条目「${basename(name)}」超过 32 MB`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_PACK_BYTES) throw new Error('ZIP 解压后不能超过 128 MB');
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }

  let manifest = null;
  const assets = [];
  for (const entry of entries) {
    const shortName = basename(entry.name);
    if (!shortName || entry.name.endsWith('/')) continue;
    if (shortName === 'PACK-INFO.json') {
      const raw = await unpackEntry(bytes, entry);
      try {
        manifest = JSON.parse(new TextDecoder('utf-8').decode(raw));
      } catch (_) {
        throw new Error('音频包清单不是有效 JSON');
      }
      continue;
    }
    if (!AUDIO_EXTENSION.test(shortName)) continue;
    const category = soundAssetCategoryFromPrefixedName(shortName);
    if (!category) {
      throw new Error(`音频「${shortName}」缺少有效分类前缀；请按 kiss--标题.mp3 这类格式命名`);
    }
    const raw = await unpackEntry(bytes, entry);
    assets.push({
      name: shortName,
      displayName: stripSoundAssetCategoryPrefix(shortName.replace(/\.[^.]+$/, '')),
      category,
      blob: new Blob([raw], { type: soundAssetMimeTypeForName(shortName) || 'audio/mpeg' }),
    });
  }

  if (!manifest || manifest.format !== 'marshmallow-sound-library-prefixed-files') {
    throw new Error('ZIP 不是棉花糖机音频包，或缺少 PACK-INFO.json');
  }
  const categories = (Array.isArray(manifest.categories) ? manifest.categories : [])
    .map((item) => {
      const id = String(item?.id || '').trim().toLowerCase();
      const mode = id.match(CUSTOM_CATEGORY_ID_RE)?.[1] || '';
      return {
        id,
        label: String(item?.label || '').trim().slice(0, 40),
        hint: String(item?.hint || '').trim().replace(/\s+/gu, ' ').slice(0, 180),
        mode,
      };
    })
    .filter((item) => item.id && item.label && item.hint && item.mode);
  const declaredCustomIds = new Set(categories.map((item) => item.id));
  const missingCustomDefinition = assets.find((item) => (
    CUSTOM_CATEGORY_ID_RE.test(item.category) && !declaredCustomIds.has(item.category)
  ));
  if (missingCustomDefinition) {
    throw new Error(`自定义分类「${missingCustomDefinition.category}」缺少名称和触发说明`);
  }
  if (!assets.length) throw new Error('音频包里没有可导入的音频');
  if (Number(manifest.assetCount || 0) !== assets.length) {
    throw new Error(`音频包清单为 ${manifest.assetCount || 0} 条，实际找到 ${assets.length} 条`);
  }
  return { manifest, categories, assets };
}
