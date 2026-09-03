import * as db from './db.js';
import { inflateRaw } from './inflate-raw.js';

const INDEX_KEY = 'togetherReading:index:v1';
const BOOK_KEY = (id) => `togetherReading:book:v1:${id}`;
const STATE_KEY = (id) => `togetherReading:state:v1:${id}`;
const BOOKLISTS_KEY = 'togetherReading:characterBooklists:v1';
const MAX_TEXT_CHARS = 5_000_000;
const MAX_EPUB_BYTES = 80 * 1024 * 1024;
export const DEFAULT_TXT_CHAPTER_PATTERN = String.raw`^(?:[【\[（(《〈「『]\s*)?(?:第\s*[零一二三四五六七八九十百千万〇○两\d]{1,12}\s*[章节卷回部集篇幕]|[章节卷]\s*[零一二三四五六七八九十百千万〇○两\d]{1,12}|序章|序言|前言|楔子|引子|开篇|尾声|后记|终章|番外(?:篇|章)?(?:\s*[零一二三四五六七八九十百千万〇○两\d]{0,6})?|(?:Chapter|Part|Volume|Book)\s*[a-z\d]+\b)(?:\s*[】\])）》〉」』])?(?:[\s:：._—-]+.*|[\u3400-\u9fff].*)?$`;

function now() { return Date.now(); }

function makeId(prefix = 'reading') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

async function readValue(key, fallback) {
  const row = await db.get(key).catch(() => null);
  return row && Object.prototype.hasOwnProperty.call(row, 'value') ? row.value : fallback;
}

async function writeValue(key, value) {
  await db.put({ key, value });
  return value;
}

function cleanText(value = '') {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .replace(/[ ]+\n/g, '\n')
    .trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function chapterPatternRegExp(pattern = '') {
  const source = String(pattern || DEFAULT_TXT_CHAPTER_PATTERN).trim();
  if (!source) throw new Error('目录正则不能为空');
  if (source.length > 1200) throw new Error('目录正则过长');
  try {
    return new RegExp(source, 'iu');
  } catch (error) {
    throw new Error(`目录正则无效：${error?.message || '请检查表达式'}`);
  }
}

function headingLike(line = '', matcher = null) {
  const value = String(line || '').trim();
  if (!value || value.length > 120) return false;
  return (matcher || chapterPatternRegExp()).test(value);
}

function paragraphLines(text = '') {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const blocks = normalized.split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;
  return normalized.split('\n').map((item) => item.trim()).filter(Boolean);
}

export function splitReadingText(text = '', fallbackTitle = '正文', options = {}) {
  const normalized = cleanText(text);
  if (!normalized) throw new Error('书籍正文为空');
  if (normalized.length > MAX_TEXT_CHARS) throw new Error('正文超过 500 万字，首批测试版暂不支持');

  const matcher = chapterPatternRegExp(options.chapterPattern);
  const lines = normalized.split('\n');
  const headingIndexes = [];
  lines.forEach((line, index) => {
    if (headingLike(line, matcher)) headingIndexes.push(index);
  });

  if (!headingIndexes.length) {
    return [{
      id: makeId('chapter'),
      title: String(fallbackTitle || '正文').trim() || '正文',
      paragraphs: paragraphLines(normalized),
    }];
  }

  const chapters = [];
  if (headingIndexes[0] > 0) {
    const preface = paragraphLines(lines.slice(0, headingIndexes[0]).join('\n'));
    if (preface.length) chapters.push({ id: makeId('chapter'), title: '开篇', paragraphs: preface });
  }
  headingIndexes.forEach((start, position) => {
    const end = headingIndexes[position + 1] ?? lines.length;
    const title = String(lines[start] || '').trim() || `第 ${position + 1} 章`;
    const paragraphs = paragraphLines(lines.slice(start + 1, end).join('\n'));
    chapters.push({ id: makeId('chapter'), title, paragraphs: paragraphs.length ? paragraphs : [''] });
  });
  return chapters;
}

export function previewReadingChapterPattern(text = '', chapterPattern = '') {
  const normalized = cleanText(text);
  if (!normalized) return { count: 0, titles: [], chapters: [] };
  const chapters = splitReadingText(normalized, '正文', { chapterPattern });
  const matched = !(chapters.length === 1 && chapters[0].title === '正文');
  return {
    count: matched ? chapters.length : 0,
    titles: matched ? chapters.slice(0, 20).map((chapter) => chapter.title) : [],
    chapters,
  };
}

function reconstructTxtSource(book = {}) {
  if (String(book.sourceText || '').trim()) return cleanText(book.sourceText);
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  if (chapters.length === 1 && ['正文', '开篇'].includes(String(chapters[0]?.title || '').trim())) {
    return cleanText((chapters[0]?.paragraphs || []).join('\n\n'));
  }
  return cleanText(chapters.map((chapter) => [
    String(chapter.title || '').trim(),
    ...(chapter.paragraphs || []),
  ].filter(Boolean).join('\n\n')).join('\n\n'));
}

function reuseChapterIds(chapters = [], previous = []) {
  const available = new Map();
  previous.forEach((chapter) => {
    const key = String(chapter?.title || '').trim().toLocaleLowerCase();
    if (!key) return;
    if (!available.has(key)) available.set(key, []);
    available.get(key).push(String(chapter.id || ''));
  });
  return chapters.map((chapter) => {
    const key = String(chapter.title || '').trim().toLocaleLowerCase();
    const id = available.get(key)?.shift();
    return id ? { ...chapter, id } : chapter;
  });
}

function extensionOf(name = '') {
  return String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

function baseName(name = '') {
  return String(name || '').replace(/\.[^.]+$/i, '').trim() || '未命名书籍';
}

async function decodeTxtFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const replacementRatio = (text.match(/\uFFFD/g)?.length || 0) / Math.max(1, text.length);
  if (replacementRatio > 0.003) {
    try {
      const fallback = new TextDecoder('gb18030', { fatal: false }).decode(bytes);
      if ((fallback.match(/\uFFFD/g)?.length || 0) < (text.match(/\uFFFD/g)?.length || 0)) text = fallback;
    } catch (_) {}
  }
  return cleanText(text);
}

function findEocd(bytes, view) {
  const min = Math.max(0, bytes.length - 66_000);
  for (let offset = bytes.length - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function decodeZipName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (_) { return ''; }
}

function normalizeZipPath(value = '') {
  const out = [];
  String(value || '').replace(/\\/g, '/').split('/').forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') out.pop();
    else out.push(part);
  });
  return out.join('/');
}

function resolveZipPath(base = '', href = '') {
  const cleanHref = String(href || '').split('#')[0].split('?')[0];
  if (!cleanHref) return '';
  const dir = normalizeZipPath(base).split('/').slice(0, -1).join('/');
  let resolved = normalizeZipPath(dir ? `${dir}/${cleanHref}` : cleanHref);
  try { resolved = decodeURIComponent(resolved); } catch (_) {}
  return resolved;
}

async function readZipEntries(file) {
  if (Number(file?.size || 0) > MAX_EPUB_BYTES) throw new Error('EPUB 超过 80MB，测试版暂不支持');
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEocd(bytes, view);
  if (eocd < 0) throw new Error('EPUB 文件结构不完整');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const name = normalizeZipPath(decodeZipName(bytes.subarray(nameStart, nameStart + nameLength)));
    if (name && localOffset + 30 <= bytes.length && view.getUint32(localOffset, true) === 0x04034b50) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      let raw = null;
      if (method === 0) raw = compressed.slice();
      else if (method === 8) raw = await inflateRaw(compressed, `无法解压 EPUB 条目「${name}」`);
      if (raw) entries.set(name, raw instanceof Uint8Array ? raw : new Uint8Array(raw));
    }
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function textFromBytes(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes || new Uint8Array());
}

function xmlAttrs(source = '') {
  const attrs = {};
  String(source || '').replace(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g, (_, key, _quote, value) => {
    attrs[String(key).toLowerCase()] = value;
    return '';
  });
  return attrs;
}

function decodeEntities(value = '') {
  if (typeof document !== 'undefined') {
    const area = document.createElement('textarea');
    area.innerHTML = String(value || '');
    return area.value;
  }
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function firstXmlText(xml = '', tag = '') {
  const safe = String(tag || '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const match = String(xml || '').match(new RegExp(`<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safe}>`, 'i'));
  return decodeEntities(match?.[1]?.replace(/<[^>]+>/g, '').trim() || '');
}

function htmlToChapter(html = '', fallbackTitle = '正文') {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('script,style,noscript,svg').forEach((node) => node.remove());
    const title = cleanText(doc.querySelector('h1,h2,h3,title')?.textContent || fallbackTitle).slice(0, 80) || fallbackTitle;
    let paragraphs = [...doc.querySelectorAll('p,blockquote,li')]
      .map((node) => cleanText(node.textContent || ''))
      .filter(Boolean);
    if (!paragraphs.length) paragraphs = paragraphLines(doc.body?.textContent || '');
    return { title, paragraphs };
  }
  const stripped = decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
  return { title: fallbackTitle, paragraphs: paragraphLines(stripped) };
}

function mimeForPath(path = '') {
  const ext = extensionOf(path);
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/jpeg';
}

function bytesToDataUrl(bytes, mimeType) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取封面失败'));
    reader.readAsDataURL(new Blob([bytes], { type: mimeType }));
  });
}

async function parseEpubFile(file) {
  const entries = await readZipEntries(file);
  const containerEntry = [...entries.keys()].find((name) => /(?:^|\/)META-INF\/container\.xml$/i.test(name));
  if (!containerEntry) throw new Error('EPUB 缺少 META-INF/container.xml');
  const containerXml = textFromBytes(entries.get(containerEntry));
  const rootfile = containerXml.match(/<rootfile\b([^>]*)>/i);
  const opfPath = normalizeZipPath(xmlAttrs(rootfile?.[1] || '')['full-path'] || '');
  if (!opfPath || !entries.has(opfPath)) throw new Error('EPUB 没有可读取的书籍目录');
  const opf = textFromBytes(entries.get(opfPath));
  const title = firstXmlText(opf, 'dc:title') || baseName(file.name);
  const author = firstXmlText(opf, 'dc:creator') || '未知作者';
  const language = firstXmlText(opf, 'dc:language') || '';
  const manifest = new Map();
  String(opf).replace(/<item\b([^>]*?)\/?\s*>/gi, (_, attrSource) => {
    const attrs = xmlAttrs(attrSource);
    if (attrs.id && attrs.href) manifest.set(attrs.id, attrs);
    return '';
  });
  const spineIds = [];
  String(opf).replace(/<itemref\b([^>]*?)\/?\s*>/gi, (_, attrSource) => {
    const attrs = xmlAttrs(attrSource);
    if (attrs.idref) spineIds.push(attrs.idref);
    return '';
  });
  const ordered = spineIds.length
    ? spineIds.map((id) => manifest.get(id)).filter(Boolean)
    : [...manifest.values()].filter((item) => /xhtml|html/i.test(item['media-type'] || '') || /\.x?html?$/i.test(item.href || ''));
  const chapters = [];
  let extractedChars = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    const path = resolveZipPath(opfPath, item.href);
    const bytes = entries.get(path);
    if (!bytes) continue;
    const parsed = htmlToChapter(textFromBytes(bytes), `第 ${chapters.length + 1} 章`);
    if (!parsed.paragraphs.length) continue;
    extractedChars += parsed.paragraphs.join('').length;
    if (extractedChars > MAX_TEXT_CHARS) throw new Error('EPUB 正文超过 500 万字，测试版暂不支持');
    chapters.push({ id: makeId('chapter'), title: parsed.title, paragraphs: parsed.paragraphs });
  }
  if (!chapters.length) throw new Error('EPUB 中没有提取到可阅读正文');

  let cover = '';
  const coverMetaId = String(opf.match(/<meta\b[^>]*name=["']cover["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] || '');
  const coverItem = [...manifest.values()].find((item) => /(?:^|\s)cover-image(?:\s|$)/i.test(item.properties || ''))
    || manifest.get(coverMetaId)
    || [...manifest.values()].find((item) => /cover/i.test(item.id || '') && /^image\//i.test(item['media-type'] || ''));
  if (coverItem) {
    const coverPath = resolveZipPath(opfPath, coverItem.href);
    const coverBytes = entries.get(coverPath);
    if (coverBytes && coverBytes.byteLength <= 3 * 1024 * 1024) {
      cover = await bytesToDataUrl(coverBytes, coverItem['media-type'] || mimeForPath(coverPath)).catch(() => '');
    }
  }
  return { title, author, language, chapters, cover };
}

function totalCharacters(book = {}) {
  return (book.chapters || []).reduce((sum, chapter) => (
    sum + (chapter.paragraphs || []).reduce((count, paragraph) => count + String(paragraph || '').length, 0)
  ), 0);
}

function bookMeta(book = {}) {
  return {
    id: String(book.id || ''),
    title: String(book.title || '未命名书籍'),
    author: String(book.author || '未知作者'),
    cover: String(book.cover || ''),
    coverKind: String(book.coverKind || (book.cover ? 'embedded' : 'auto')),
    format: String(book.format || 'txt'),
    language: String(book.language || ''),
    category: String(book.category || 'general'),
    chapterCount: Array.isArray(book.chapters) ? book.chapters.length : Number(book.chapterCount || 0),
    charCount: Number(book.charCount || totalCharacters(book)),
    createdAt: Number(book.createdAt || now()),
    updatedAt: Number(book.updatedAt || now()),
  };
}

function defaultState(bookId = '') {
  return {
    bookId: String(bookId || ''),
    progress: { chapterIndex: 0, pageIndex: 0, paragraphIndex: 0, percent: 0, updatedAt: 0 },
    preferences: {
      theme: 'white',
      fontSize: 19,
      lineHeight: 1.95,
      volumePaging: false,
      autoReviewEnabled: false,
      autoReviewActivity: 'natural',
      autoReviewMaxPerChapter: 2,
      autoReviewCharacterIds: [],
    },
    participantIds: [],
    annotations: [],
    reviews: [],
    cards: [],
    completedCardCharacterIds: [],
    autoReviewState: { chapterCounts: {}, lastPositions: {}, generatedKeys: [] },
    updatedAt: 0,
  };
}

function normalizeState(raw, bookId = '') {
  const base = defaultState(bookId);
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    ...base,
    ...state,
    bookId: String(bookId || state.bookId || ''),
    progress: { ...base.progress, ...(state.progress || {}) },
    preferences: {
      ...base.preferences,
      ...(state.preferences || {}),
      fontSize: clamp(state.preferences?.fontSize ?? base.preferences.fontSize, 15, 30),
      lineHeight: clamp(state.preferences?.lineHeight ?? base.preferences.lineHeight, 1.45, 2.4),
      autoReviewEnabled: state.preferences?.autoReviewEnabled === true,
      autoReviewActivity: ['quiet', 'natural', 'active'].includes(state.preferences?.autoReviewActivity)
        ? state.preferences.autoReviewActivity
        : base.preferences.autoReviewActivity,
      autoReviewMaxPerChapter: clamp(state.preferences?.autoReviewMaxPerChapter ?? base.preferences.autoReviewMaxPerChapter, 1, 5),
      autoReviewCharacterIds: Array.isArray(state.preferences?.autoReviewCharacterIds)
        ? [...new Set(state.preferences.autoReviewCharacterIds.map(String).filter(Boolean))]
        : [],
    },
    participantIds: Array.isArray(state.participantIds) ? [...new Set(state.participantIds.map(String).filter(Boolean))] : [],
    annotations: Array.isArray(state.annotations) ? state.annotations : [],
    reviews: Array.isArray(state.reviews) ? state.reviews : [],
    cards: Array.isArray(state.cards) ? state.cards : [],
    completedCardCharacterIds: Array.isArray(state.completedCardCharacterIds) ? state.completedCardCharacterIds : [],
    autoReviewState: {
      ...base.autoReviewState,
      ...(state.autoReviewState || {}),
      chapterCounts: state.autoReviewState?.chapterCounts && typeof state.autoReviewState.chapterCounts === 'object'
        ? state.autoReviewState.chapterCounts
        : {},
      lastPositions: state.autoReviewState?.lastPositions && typeof state.autoReviewState.lastPositions === 'object'
        ? state.autoReviewState.lastPositions
        : {},
      generatedKeys: Array.isArray(state.autoReviewState?.generatedKeys)
        ? state.autoReviewState.generatedKeys.slice(-300)
        : [],
    },
  };
}

const SAMPLE_TEXT = `第一章 窗边的书\n\n傍晚停在窗沿上时，房间里的东西都慢了下来。你把书翻到夹着叶子的那一页，才发现昨天写下的问号旁边，多了一行很轻的字。\n\n它没有回答问题，只说：我也在这里停了很久。\n\n第二章 潮声以前\n\n夜里的潮声还没有抵达，远处的灯先一盏一盏亮了。我们各自在不同的房间读同一段文字，偶尔把一句话圈起来，像隔着很远敲了敲对方的窗。\n\n读书并没有让时间停止。它只是让两段原本各自流过的时间，在某一页短暂地重合。\n\n第三章 合上书以后\n\n合上书以后，故事没有立刻结束。那句被划过线的话留在心里，到了第二天，忽然在完全不相干的时刻重新发亮。\n\n于是我知道，有些书不是读完的。它们只是换了一个地方继续。`;

function sampleBook() {
  const createdAt = now();
  return {
    id: 'together_reading_sample_v1',
    title: '窗边共读试页',
    author: '一起读原创试读',
    format: 'txt',
    source: 'builtin',
    category: 'prose',
    language: 'zh-CN',
    cover: '',
    coverKind: 'auto',
    chapters: splitReadingText(SAMPLE_TEXT, '正文'),
    createdAt,
    updatedAt: createdAt,
  };
}

export async function saveReadingBook(input = {}) {
  const createdAt = Number(input.createdAt || now());
  const book = {
    ...input,
    id: String(input.id || makeId('book')),
    title: String(input.title || '未命名书籍').trim().slice(0, 120) || '未命名书籍',
    author: String(input.author || '未知作者').trim().slice(0, 120) || '未知作者',
    chapters: Array.isArray(input.chapters) ? input.chapters : [],
    createdAt,
    updatedAt: now(),
  };
  if (!book.chapters.length) throw new Error('书籍没有可阅读章节');
  const meta = bookMeta(book);
  const contentRecord = { ...book };
  delete contentRecord.cover;
  await writeValue(BOOK_KEY(book.id), contentRecord);
  const current = await readValue(INDEX_KEY, []);
  const list = Array.isArray(current) ? current.filter((item) => String(item?.id) !== book.id) : [];
  list.unshift(meta);
  await writeValue(INDEX_KEY, list);
  return { ...contentRecord, ...meta };
}

export async function ensureReadingLibrary() {
  const index = await readValue(INDEX_KEY, null);
  if (Array.isArray(index)) return index;
  const sample = sampleBook();
  await saveReadingBook(sample);
  return readValue(INDEX_KEY, []);
}

export async function listReadingBooks() {
  await ensureReadingLibrary();
  const index = await readValue(INDEX_KEY, []);
  const books = Array.isArray(index) ? index : [];
  const states = await Promise.all(books.map((book) => getReadingState(book.id)));
  return books.map((book, indexPosition) => ({ ...book, state: states[indexPosition] }))
    .sort((a, b) => Number(b.state?.progress?.updatedAt || b.updatedAt || 0) - Number(a.state?.progress?.updatedAt || a.updatedAt || 0));
}

export async function getReadingBook(id) {
  const bookId = String(id || '').trim();
  if (!bookId) return null;
  const [content, index] = await Promise.all([
    readValue(BOOK_KEY(bookId), null),
    readValue(INDEX_KEY, []),
  ]);
  if (!content) return null;
  const meta = (Array.isArray(index) ? index : []).find((item) => String(item?.id) === bookId) || {};
  return { ...content, ...meta, chapters: content.chapters || [] };
}

export async function updateReadingBookMetadata(id, patch = {}) {
  const book = await getReadingBook(id);
  if (!book) throw new Error('没有找到这本书');
  return saveReadingBook({
    ...book,
    ...patch,
    id: book.id,
    createdAt: book.createdAt,
    chapters: book.chapters,
    coverKind: patch.coverKind || (Object.prototype.hasOwnProperty.call(patch, 'cover') ? 'custom' : book.coverKind),
  });
}

export async function removeReadingBook(id) {
  const bookId = String(id || '').trim();
  if (!bookId) return;
  const index = await readValue(INDEX_KEY, []);
  await writeValue(INDEX_KEY, (Array.isArray(index) ? index : []).filter((item) => String(item?.id) !== bookId));
  await Promise.all([db.remove(BOOK_KEY(bookId)), db.remove(STATE_KEY(bookId))]);
}

export async function importReadingFile(file, options = {}) {
  if (!file) throw new Error('请选择书籍文件');
  const ext = extensionOf(file.name);
  if (ext !== 'txt' && ext !== 'epub') throw new Error('目前支持 TXT 和 EPUB');
  if (ext === 'txt') {
    const text = await decodeTxtFile(file);
    if (!text) throw new Error('TXT 文件内容为空');
    const chapterPattern = String(options.chapterPattern || DEFAULT_TXT_CHAPTER_PATTERN).trim();
    return saveReadingBook({
      title: baseName(file.name),
      author: '未知作者',
      format: 'txt',
      source: 'local',
      category: 'general',
      cover: '',
      coverKind: 'auto',
      sourceText: text,
      chapterPattern,
      chapters: splitReadingText(text, '正文', { chapterPattern }),
    });
  }
  const parsed = await parseEpubFile(file);
  return saveReadingBook({
    ...parsed,
    format: 'epub',
    source: 'local',
    category: 'general',
    coverKind: parsed.cover ? 'embedded' : 'auto',
  });
}

export function getReadingTxtSource(book = {}) {
  return reconstructTxtSource(book);
}

export async function reparseReadingTxtBook(bookId, chapterPattern = '') {
  const book = await getReadingBook(bookId);
  if (!book) throw new Error('没有找到这本书');
  if (String(book.format || '').toLowerCase() !== 'txt') throw new Error('只有 TXT 书籍需要设置目录规则');
  const pattern = String(chapterPattern || DEFAULT_TXT_CHAPTER_PATTERN).trim();
  chapterPatternRegExp(pattern);
  const sourceText = reconstructTxtSource(book);
  const parsed = splitReadingText(sourceText, '正文', { chapterPattern: pattern });
  const chapters = reuseChapterIds(parsed, book.chapters || []);
  const state = await getReadingState(book.id);
  const currentChapter = book.chapters?.[clamp(state.progress?.chapterIndex || 0, 0, Math.max(0, (book.chapters?.length || 1) - 1))];
  const currentId = String(currentChapter?.id || '');
  const nextChapterIndex = Math.max(0, chapters.findIndex((chapter) => String(chapter.id) === currentId));
  const saved = await saveReadingBook({
    ...book,
    chapters,
    sourceText,
    chapterPattern: pattern,
  });
  await patchReadingState(book.id, {
    progress: {
      chapterIndex: nextChapterIndex,
      pageIndex: 0,
      paragraphIndex: 0,
      percent: Math.round((nextChapterIndex / Math.max(1, chapters.length)) * 100),
      updatedAt: now(),
    },
  });
  return saved;
}

export async function getReadingState(bookId) {
  const id = String(bookId || '').trim();
  return normalizeState(await readValue(STATE_KEY(id), null), id);
}

export async function patchReadingState(bookId, patch = {}) {
  const id = String(bookId || '').trim();
  const current = await getReadingState(id);
  const next = normalizeState({
    ...current,
    ...patch,
    progress: patch.progress ? { ...current.progress, ...patch.progress } : current.progress,
    preferences: patch.preferences ? { ...current.preferences, ...patch.preferences } : current.preferences,
    autoReviewState: patch.autoReviewState ? { ...current.autoReviewState, ...patch.autoReviewState } : current.autoReviewState,
    updatedAt: now(),
  }, id);
  await writeValue(STATE_KEY(id), next);
  return next;
}

export async function addReadingAnnotation(bookId, annotation = {}) {
  const state = await getReadingState(bookId);
  const item = {
    id: String(annotation.id || makeId('annotation')),
    kind: String(annotation.kind || 'highlight'),
    authorId: String(annotation.authorId || 'user'),
    chapterId: String(annotation.chapterId || ''),
    paragraphIndex: Number(annotation.paragraphIndex || 0),
    startOffset: Number(annotation.startOffset || 0),
    endOffset: Number(annotation.endOffset || 0),
    quote: String(annotation.quote || '').trim().slice(0, 5000),
    text: String(annotation.text || '').trim().slice(0, 8000),
    createdAt: Number(annotation.createdAt || now()),
  };
  return patchReadingState(bookId, { annotations: [...state.annotations, item] });
}

export async function addReadingReview(bookId, review = {}) {
  const state = await getReadingState(bookId);
  const item = {
    id: String(review.id || makeId('review')),
    scope: String(review.scope || 'book'),
    authorId: String(review.authorId || 'user'),
    chapterId: String(review.chapterId || ''),
    paragraphIndex: Number(review.paragraphIndex || 0),
    quote: String(review.quote || '').trim().slice(0, 5000),
    text: String(review.text || '').trim().slice(0, 20_000),
    createdAt: Number(review.createdAt || now()),
  };
  return patchReadingState(bookId, { reviews: [...state.reviews, item] });
}

export async function saveReadingCard(bookId, card = {}) {
  const state = await getReadingState(bookId);
  const item = {
    id: String(card.id || makeId('card')),
    mode: String(card.mode || 'quote_echo'),
    characterId: String(card.characterId || ''),
    quote: String(card.quote || '').trim().slice(0, 5000),
    translation: String(card.translation || '').trim().slice(0, 5000),
    echo: String(card.echo || '').trim().slice(0, 8000),
    material: String(card.material || ''),
    customCss: String(card.customCss || '').slice(0, 20_000),
    createdAt: Number(card.createdAt || now()),
  };
  return patchReadingState(bookId, { cards: [item, ...state.cards] });
}

export async function listCharacterBooklists() {
  const value = await readValue(BOOKLISTS_KEY, []);
  return Array.isArray(value) ? value : [];
}

export async function saveCharacterBooklist(booklist = {}) {
  const current = await listCharacterBooklists();
  const item = {
    id: String(booklist.id || makeId('booklist')),
    characterIds: Array.isArray(booklist.characterIds) ? [...new Set(booklist.characterIds.map(String).filter(Boolean))] : [],
    title: String(booklist.title || 'TA 推荐的书').trim().slice(0, 120),
    note: String(booklist.note || '').trim().slice(0, 8000),
    books: Array.isArray(booklist.books) ? booklist.books : [],
    verified: booklist.verified === true,
    createdAt: Number(booklist.createdAt || now()),
    updatedAt: now(),
  };
  await writeValue(BOOKLISTS_KEY, [item, ...current.filter((row) => String(row?.id) !== item.id)]);
  return item;
}

export const READING_FORMAT_ACCEPT = '.txt,.epub,text/plain,application/epub+zip';
