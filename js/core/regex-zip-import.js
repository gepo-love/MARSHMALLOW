/**
 * 从 .json / .zip 读取正则 JSON 条目。
 * ZIP 使用 deflate-raw（原生或纯 JS 降级）；仍失败时提示改用 JSON。
 */

import { inflateRaw } from './inflate-raw.js';

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file, 'UTF-8');
  });
}

function basename(path = '') {
  const parts = String(path).replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || String(path);
}

function stripNamePrefix(name = '') {
  return String(name)
    .replace(/\.json$/i, '')
    .replace(/^[^_]+_/, '')
    .trim();
}

function inflateRawDeflate(bytes) {
  return inflateRaw(
    bytes,
    '当前浏览器不支持 ZIP 解压，请解压后选择 JSON 文件，或粘贴 JSON',
  );
}

/** 解析 ZIP 本地条目，返回 [{ name, text }]（仅 .json）。 */
export async function readJsonEntriesFromZip(file) {
  const buf = await readFileAsArrayBuffer(file);
  const b = new Uint8Array(buf);
  const out = [];
  let i = 0;
  while (i + 30 <= b.length) {
    if (b[i] !== 0x50 || b[i + 1] !== 0x4b || b[i + 2] !== 0x03 || b[i + 3] !== 0x04) {
      i += 1;
      continue;
    }
    const comp = b[i + 8] | (b[i + 9] << 8);
    const csize = b[i + 18] | (b[i + 19] << 8) | (b[i + 20] << 16) | (b[i + 21] << 24);
    const nameLen = b[i + 26] | (b[i + 27] << 8);
    const extraLen = b[i + 28] | (b[i + 29] << 8);
    const nameBytes = b.slice(i + 30, i + 30 + nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);
    const dataStart = i + 30 + nameLen + extraLen;
    const compData = b.slice(dataStart, dataStart + csize);
    let raw;
    if (comp === 0) raw = compData;
    else if (comp === 8) raw = await inflateRawDeflate(compData);
    else throw new Error(`ZIP 条目「${name}」使用了不支持的压缩方式 (${comp})`);
    if (/\.json$/i.test(name)) {
      out.push({ name: basename(name), path: name.replace(/\\/g, '/'), text: new TextDecoder('utf-8').decode(raw) });
    }
    i = dataStart + csize;
  }
  if (!out.length) throw new Error('ZIP 内未找到 .json 正则文件');
  return out;
}

/** 单个 File → [{ name, text }]。 */
export async function readRegexJsonEntriesFromFile(file) {
  const name = String(file?.name || 'import.json');
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip')) return readJsonEntriesFromZip(file);
  const text = await readFileAsText(file);
  return [{ name: basename(name), text }];
}

/** 多文件批量读取。 */
export async function readRegexJsonEntriesFromFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return [];
  const entries = [];
  for (const file of list) {
    const rows = await readRegexJsonEntriesFromFile(file);
    entries.push(...rows);
  }
  return entries;
}

export { stripNamePrefix, basename };
