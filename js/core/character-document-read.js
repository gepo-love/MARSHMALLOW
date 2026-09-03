import { inflateRaw } from './inflate-raw.js';

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsText(file, encoding = 'UTF-8') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file, encoding);
  });
}

function fileExt(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

/** 导入文件名去掉后缀，用作世界书/预设默认名称 */
export function importDocumentBaseName(fileName = '') {
  return String(fileName || '').replace(/\.[^.]+$/i, '').trim() || '导入';
}

export function isImportDocumentFile(file) {
  if (!file) return false;
  const ext = fileExt(file.name);
  return ext === 'txt'
    || ext === 'docx'
    || file.type === 'text/plain'
    || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

export function buildCharacterDocumentImportPayload(text, fileName = '', options = {}) {
  const promptCorpus = String(text || '').trim();
  if (!promptCorpus) throw new Error('文档内容为空');
  if (promptCorpus.length > 500_000) throw new Error('人物设定过长，请精简到 50 万字内');
  const name = String(options.name || importDocumentBaseName(fileName)).trim().slice(0, 80) || '导入角色';
  return {
    format: 'marshmallow-characters',
    version: 2,
    characters: [{
      id: `char_document_${Date.now().toString(36)}`,
      name,
      promptCorpus,
      isCustom: true,
    }],
  };
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function xmlToPlainText(xml) {
  const src = String(xml || '');
  if (!src.trim()) return '';
  const paras = src.split(/<\/w:p>/i);
  const lines = paras.map((para) => {
    const chunks = [];
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gi;
    let m;
    while ((m = re.exec(para))) chunks.push(m[1]);
    if (chunks.length) return chunks.join('');
    return para
      .replace(/<w:tab[^/>]*\/>/g, '\t')
      .replace(/<w:br[^/>]*\/>/g, '\n')
      .replace(/<[^>]+>/g, '');
  });
  return decodeXmlEntities(lines.map((line) => line.replace(/[ \t]+$/g, '')).join('\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isOleCompoundFile(buffer) {
  const bytes = new Uint8Array(buffer);
  return bytes.length >= 8
    && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0
    && bytes[4] === 0xA1 && bytes[5] === 0xB1 && bytes[6] === 0x1A && bytes[7] === 0xE1;
}

function inflateRawDeflate(bytes) {
  return inflateRaw(bytes, '当前浏览器不支持解压 .docx，请另存为 .txt 后上传');
}

function findEndOfCentralDirectory(bytes, view) {
  const minOffset = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function readZipLocalEntry(bytes, view, localHeaderOffset, compMethod, compSize) {
  if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) return null;
  const nameLen = view.getUint16(localHeaderOffset + 26, true);
  const extraLen = view.getUint16(localHeaderOffset + 28, true);
  const dataStart = localHeaderOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compSize;
  if (compSize <= 0 || dataEnd > bytes.length) return null;
  const compressed = bytes.subarray(dataStart, dataEnd);
  if (compMethod === 0) return compressed;
  if (compMethod === 8) return inflateRawDeflate(compressed);
  return null;
}

async function extractZipEntryBytes(buffer, targetName) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocdOffset = findEndOfCentralDirectory(bytes, view);
  if (eocdOffset >= 0) {
    const entryCount = view.getUint16(eocdOffset + 10, true);
    let cdOffset = view.getUint32(eocdOffset + 16, true);
    for (let i = 0; i < entryCount; i++) {
      if (cdOffset + 46 > bytes.length || view.getUint32(cdOffset, true) !== 0x02014b50) break;
      const compMethod = view.getUint16(cdOffset + 10, true);
      const compSize = view.getUint32(cdOffset + 20, true);
      const nameLen = view.getUint16(cdOffset + 28, true);
      const extraLen = view.getUint16(cdOffset + 30, true);
      const commentLen = view.getUint16(cdOffset + 32, true);
      const localHeaderOffset = view.getUint32(cdOffset + 42, true);
      const nameStart = cdOffset + 46;
      const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
      if (name === targetName || name.endsWith(`/${targetName}`)) {
        const payload = await readZipLocalEntry(bytes, view, localHeaderOffset, compMethod, compSize);
        if (payload) return payload;
      }
      cdOffset = nameStart + nameLen + extraLen + commentLen;
    }
  }
  let offset = 0;
  while (offset + 30 < bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const flags = view.getUint16(offset + 6, true);
    const compMethod = view.getUint16(offset + 8, true);
    let compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    let dataEnd = dataStart + compSize;
    if ((flags & 0x0008) && compSize === 0) {
      dataEnd = findNextLocalHeaderOffset(bytes, view, dataStart);
      compSize = dataEnd - dataStart;
    }
    if (name === targetName || name.endsWith(`/${targetName}`)) {
      const payload = await readZipLocalEntry(bytes, view, offset, compMethod, compSize);
      if (payload) return payload;
    }
    offset = dataEnd;
  }
  return null;
}

function findNextLocalHeaderOffset(bytes, view, fromOffset) {
  for (let i = fromOffset; i + 4 < bytes.length; i++) {
    if (view.getUint32(i, true) === 0x04034b50) return i;
    if (view.getUint32(i, true) === 0x02014b50) return i;
  }
  return bytes.length;
}

async function extractZipEntryText(buffer, targetName) {
  const payload = await extractZipEntryBytes(buffer, targetName);
  return payload ? new TextDecoder().decode(payload) : '';
}

async function readDocxText(file) {
  const buffer = await readFileAsArrayBuffer(file);
  if (isOleCompoundFile(buffer)) {
    throw new Error('检测到旧版 Word（.doc）格式，请另存为 .docx 或 .txt 后再上传');
  }
  const xmlTargets = [
    'word/document.xml',
    'word/header1.xml',
    'word/footer1.xml',
    'word/header2.xml',
    'word/footer2.xml',
  ];
  const parts = [];
  for (const target of xmlTargets) {
    const xml = await extractZipEntryText(buffer, target);
    const text = xmlToPlainText(xml);
    if (text) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

/** 从 txt / docx 读取纯文本，失败时抛错 */
export async function readCharacterDocumentFile(file) {
  if (!file) throw new Error('未选择文件');
  const ext = fileExt(file.name);
  if (ext === 'txt' || file.type === 'text/plain') {
    return readFileAsText(file, 'UTF-8');
  }
  if (ext === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const text = await readDocxText(file);
    if (!String(text || '').trim()) throw new Error('无法解析 Word 文档内容');
    return text;
  }
  throw new Error('仅支持 .txt / .docx');
}
