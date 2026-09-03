import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { openFilePicker } from '../core/open-file-picker.js';
import { openParticipantPicker } from '../components/participant-picker.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { listCharacters } from '../core/character-store.js';
import { chat } from '../core/api.js';
import { chatJsonGeneration } from '../core/chat-json-generation.js';
import { buildSocialCharacterCardsBlock } from '../core/social-helpers.js';
import { getCharacterPromptTagSnippets } from '../data/character-prompt-tags.js';
import { downloadBlob, describeDownloadResult } from '../core/native-download.js';
import {
  DEFAULT_TXT_CHAPTER_PATTERN,
  READING_FORMAT_ACCEPT,
  addReadingAnnotation,
  addReadingReview,
  ensureReadingLibrary,
  getReadingBook,
  getReadingState,
  getReadingTxtSource,
  importReadingFile,
  listCharacterBooklists,
  listReadingBooks,
  patchReadingState,
  previewReadingChapterPattern,
  reparseReadingTxtBook,
  removeReadingBook,
  saveCharacterBooklist,
  saveReadingCard,
  updateReadingBookMetadata,
} from '../core/together-reading.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function hashNumber(value = '') {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

const AUTO_COVER_PALETTES = [
  ['#173f36', '#e8f0ec', '#ffffff'],
  ['#273b5d', '#e7ecf4', '#ffffff'],
  ['#5e3842', '#f1e8ea', '#ffffff'],
  ['#31383c', '#edf0f1', '#ffffff'],
  ['#765b30', '#f2eee5', '#ffffff'],
  ['#375054', '#e5eded', '#ffffff'],
];

function autoCoverMarkup(book = {}, className = '') {
  const index = hashNumber(book.id || book.title) % AUTO_COVER_PALETTES.length;
  const [ink, paper, light] = AUTO_COVER_PALETTES[index];
  const title = String(book.title || '未命名').trim();
  const author = String(book.author || '').trim();
  return `<span class="tr-auto-cover ${esc(className)}" style="--tr-cover-ink:${ink};--tr-cover-paper:${paper};--tr-cover-light:${light}">
    <i aria-hidden="true"></i><em>TOGETHER / READ</em><strong>${esc(title)}</strong><small>${esc(author)}</small>
  </span>`;
}

function coverMarkup(book = {}, className = '') {
  if (book.cover) return `<img class="tr-cover-img ${esc(className)}" src="${esc(book.cover)}" alt="${esc(book.title)}封面" />`;
  return autoCoverMarkup(book, className);
}

function participantAvatars(ids = [], characters = [], max = 2) {
  const rows = (Array.isArray(ids) ? ids : []).slice(0, max).map((id) => characters.find((item) => String(item.id) === String(id))).filter(Boolean);
  if (!rows.length) return '';
  return `<span class="tr-avatar-stack" aria-label="共读成员">${rows.map((character) => (
    `<span class="tr-avatar">${characterAvatarHtml(character, { className: 'tr-avatar-img' })}</span>`
  )).join('')}</span>`;
}

function percentOf(state = {}) {
  return clamp(state?.progress?.percent || 0, 0, 100);
}

function chapterAt(book = {}, state = {}) {
  const index = clamp(state?.progress?.chapterIndex || 0, 0, Math.max(0, (book.chapters?.length || 1) - 1));
  return book.chapters?.[index] || book.chapters?.[0] || { title: '正文', paragraphs: [] };
}

function markedParagraphHtml(part = {}, annotations = []) {
  const text = String(part.text || '');
  const pageStart = Number(part.startOffset || 0);
  const pageEnd = pageStart + text.length;
  const ranges = annotations
    .filter((item) => item.kind === 'highlight' && Number(item.endOffset || 0) > pageStart && Number(item.startOffset || 0) < pageEnd)
    .map((item) => ({
      start: clamp(Number(item.startOffset || 0) - pageStart, 0, text.length),
      end: clamp(Number(item.endOffset || 0) - pageStart, 0, text.length),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push(range);
      return merged;
    }, []);
  if (!ranges.length) return esc(text);
  let cursor = 0;
  let html = '';
  ranges.forEach((range) => {
    html += esc(text.slice(cursor, range.start));
    html += `<mark>${esc(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  });
  return html + esc(text.slice(cursor));
}

function bottomNav(section = 'shelf') {
  const rows = [
    ['shelf', 'book', '书架'],
    ['together', 'roleSay', '共读'],
    ['notes', 'edit', '笔记'],
    ['mine', 'lucideUser', '我的'],
  ];
  return `<nav class="tr-bottom-nav" aria-label="一起读导航">${rows.map(([id, iconName, label]) => `
    <button type="button" class="${section === id ? 'is-active' : ''}" data-tr-section="${id}" aria-current="${section === id ? 'page' : 'false'}">
      ${icon(iconName)}<span>${label}</span>
    </button>`).join('')}</nav>`;
}

function bookShelfItem(book, characters) {
  const progress = percentOf(book.state);
  const participants = book.state?.participantIds || [];
  return `<button type="button" class="tr-shelf-item" data-tr-book="${esc(book.id)}">
    <span class="tr-shelf-cover">
      ${coverMarkup(book)}
      ${participantAvatars(participants, characters)}
      ${progress > 0 ? `<i class="tr-cover-progress"><b style="width:${progress}%"></b></i>` : ''}
    </span>
    <strong>${esc(book.title)}</strong>
  </button>`;
}

function emptyState(title, actionLabel = '') {
  return `<div class="tr-empty"><strong>${esc(title)}</strong>${actionLabel ? `<button type="button" data-tr-import>${esc(actionLabel)}</button>` : ''}</div>`;
}

function modalHost() {
  return document.getElementById('modal-container');
}

function openTextComposer({ title = '写评价', placeholder = '', value = '', confirmLabel = '保存', quote = '' } = {}) {
  return new Promise((resolve) => {
    const host = modalHost();
    if (!host) { resolve(null); return; }
    host.classList.add('active');
    host.innerHTML = `<div class="modal-overlay tr-modal-overlay" data-tr-modal-close>
      <section class="tr-compose-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header><button type="button" data-tr-modal-close aria-label="关闭">${icon('close')}</button><h2>${esc(title)}</h2><button type="button" class="is-primary" data-tr-modal-confirm>${esc(confirmLabel)}</button></header>
        ${quote ? `<blockquote>${esc(quote)}</blockquote>` : ''}
        <textarea data-tr-compose-text maxlength="20000" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
      </section>
    </div>`;
    const close = (result) => {
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(result);
    };
    host.querySelector('.tr-compose-sheet')?.addEventListener('click', (event) => event.stopPropagation());
    host.querySelectorAll('[data-tr-modal-close]').forEach((button) => button.addEventListener('click', () => close(null)));
    host.querySelector('[data-tr-modal-confirm]')?.addEventListener('click', () => {
      const text = String(host.querySelector('[data-tr-compose-text]')?.value || '').trim();
      if (!text) { showToast('先写一点内容'); return; }
      close(text);
    });
    window.setTimeout(() => host.querySelector('[data-tr-compose-text]')?.focus(), 20);
  });
}

function openTxtChapterPatternEditor(book = {}) {
  return new Promise((resolve) => {
    const host = modalHost();
    if (!host) { resolve(null); return; }
    const sourceText = getReadingTxtSource(book);
    const currentPattern = String(book.chapterPattern || DEFAULT_TXT_CHAPTER_PATTERN);
    host.classList.add('active');
    host.innerHTML = `<div class="modal-overlay tr-modal-overlay" data-tr-modal-close>
      <section class="tr-directory-rule-sheet" role="dialog" aria-modal="true" aria-label="TXT 目录规则">
        <header><button type="button" data-tr-modal-close aria-label="关闭">${icon('close')}</button><h2>TXT 目录规则</h2><button type="button" class="is-primary" data-tr-rule-apply>应用</button></header>
        <label><span>章节标题正则</span><textarea data-tr-rule-pattern spellcheck="false" maxlength="1200">${esc(currentPattern)}</textarea></label>
        <div class="tr-directory-rule-actions"><button type="button" data-tr-rule-default>恢复默认</button><output data-tr-rule-status></output></div>
        <ol data-tr-rule-preview></ol>
      </section>
    </div>`;
    const sheet = host.querySelector('.tr-directory-rule-sheet');
    const field = host.querySelector('[data-tr-rule-pattern]');
    const status = host.querySelector('[data-tr-rule-status]');
    const preview = host.querySelector('[data-tr-rule-preview]');
    let timer = 0;
    let latest = null;
    const close = (result) => {
      window.clearTimeout(timer);
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(result);
    };
    const paintPreview = () => {
      try {
        latest = previewReadingChapterPattern(sourceText, field?.value || '');
        status.textContent = latest.count ? `识别到 ${latest.count} 章` : '没有识别到章节';
        status.classList.toggle('is-error', !latest.count);
        preview.innerHTML = latest.titles.length
          ? latest.titles.map((title, index) => `<li><span>${String(index + 1).padStart(2, '0')}</span><strong>${esc(title)}</strong></li>`).join('')
          : '<li class="is-empty">调整规则后在这里预览</li>';
      } catch (error) {
        latest = null;
        status.textContent = error?.message || '目录正则无效';
        status.classList.add('is-error');
        preview.innerHTML = '<li class="is-empty">正则无效</li>';
      }
    };
    sheet?.addEventListener('click', (event) => event.stopPropagation());
    host.querySelectorAll('[data-tr-modal-close]').forEach((button) => button.addEventListener('click', () => close(null)));
    field?.addEventListener('input', () => {
      window.clearTimeout(timer);
      status.textContent = '正在识别…';
      timer = window.setTimeout(paintPreview, 180);
    });
    host.querySelector('[data-tr-rule-default]')?.addEventListener('click', () => {
      field.value = DEFAULT_TXT_CHAPTER_PATTERN;
      paintPreview();
    });
    host.querySelector('[data-tr-rule-apply]')?.addEventListener('click', () => {
      paintPreview();
      if (!latest?.count) { showToast('当前规则没有识别到章节'); return; }
      close(String(field.value || '').trim());
    });
    paintPreview();
    window.setTimeout(() => field?.focus(), 20);
  });
}

function pickOneFile({ accept, onFile }) {
  openFilePicker({
    accept,
    multiple: false,
    onChange: (files) => {
      const file = files?.[0];
      if (file) Promise.resolve(onFile(file)).catch((error) => showToast(error?.message || String(error)));
    },
  });
}

async function imageFileToCover(file) {
  if (!String(file?.type || '').startsWith('image/')) throw new Error('请选择图片文件');
  if (Number(file.size || 0) > 15 * 1024 * 1024) throw new Error('封面图片请控制在 15MB 内');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('封面图片无法读取'));
      image.src = url;
    });
    const maxWidth = 720;
    const maxHeight = 1080;
    const ratio = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.84);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseJsonObject(raw = '') {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 没有返回可读取的书单');
  return JSON.parse(fenced.slice(start, end + 1));
}

function readingChapterSource(chapter = {}) {
  return (chapter.paragraphs || [])
    .map((text, index) => `${index + 1}. ${String(text || '')}`)
    .join('\n');
}

function readingCharacterCards(characters = []) {
  const cards = buildSocialCharacterCardsBlock(characters, {
    mode: 'full',
    maxCount: characters.length,
  });
  const tagRules = characters.map((character) => {
    const snippets = getCharacterPromptTagSnippets(character.promptTags || []);
    return snippets.length
      ? `【${character.name || character.realName || character.id} · 生效说话标签】\n${snippets.join('\n\n')}`
      : '';
  }).filter(Boolean).join('\n\n');
  return [cards, tagRules].filter(Boolean).join('\n\n');
}

function readingTraceRows(state = {}, { chapterId = '', includeBookReviews = false } = {}) {
  const rows = [
    ...(state.annotations || []).map((item) => ({ ...item, kind: '划线' })),
    ...(state.reviews || []).map((item) => ({
      ...item,
      kind: item.scope === 'paragraph' ? '段评' : item.scope === 'chapter' ? '章评' : '书评',
    })),
  ];
  return rows.filter((item) => {
    if (chapterId && String(item.chapterId || '') !== String(chapterId)) return false;
    if (!includeBookReviews && item.scope === 'book') return false;
    return true;
  }).map((item) => ({
    kind: item.kind,
    authorId: item.authorId || 'user',
    chapterId: item.chapterId || '',
    paragraphIndex: Number(item.paragraphIndex || 0),
    quote: item.quote || '',
    text: item.text || '',
  }));
}

function representativeParagraphIndexes(chapter = {}, traces = []) {
  const paragraphs = chapter.paragraphs || [];
  const nonEmpty = paragraphs
    .map((text, index) => ({ index, text: String(text || '').trim() }))
    .filter((item) => item.text);
  const selected = new Set();
  if (nonEmpty.length) {
    selected.add(nonEmpty[0].index);
    selected.add(nonEmpty[Math.floor(nonEmpty.length / 2)].index);
    selected.add(nonEmpty.at(-1).index);
  }
  traces.forEach((item) => {
    if (String(item.chapterId || '') !== String(chapter.id || '')) return;
    const index = Number(item.paragraphIndex);
    if (!Number.isInteger(index)) return;
    for (const nearby of [index - 1, index, index + 1]) {
      if (nearby >= 0 && nearby < paragraphs.length) selected.add(nearby);
    }
  });
  return [...selected].sort((a, b) => a - b);
}

function readingReviewSource(book = {}, chapter = null, review = {}, state = {}) {
  const scope = String(review.scope || 'book');
  if ((scope === 'paragraph' || scope === 'chapter') && chapter) {
    const traces = readingTraceRows(state, { chapterId: chapter.id });
    return [
      `【当前章节完整正文 · ${chapter.title || '正文'}】`,
      readingChapterSource(chapter),
      traces.length ? `【本章已有划线、段评与讨论 · 仅作辅助】\n${JSON.stringify(traces)}` : '',
    ].filter(Boolean).join('\n\n');
  }
  const traces = readingTraceRows(state);
  const chapterEvidence = (book.chapters || []).map((item) => {
    const indexes = representativeParagraphIndexes(item, traces);
    const paragraphs = indexes.map((index) => `${index + 1}. ${String(item.paragraphs?.[index] || '')}`).join('\n');
    const chapterTraces = traces.filter((trace) => String(trace.chapterId || '') === String(item.id || ''));
    return [
      `【${item.title || '正文'} · 重点正文】`,
      paragraphs,
      chapterTraces.length ? `【本章划线、段评与章评】\n${JSON.stringify(chapterTraces)}` : '',
    ].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
  return [
    `【目录】\n${(book.chapters || []).map((item, index) => `${index + 1}. ${item.title || '正文'}`).join('\n')}`,
    '【整本书评证据说明】以下内容来自真实正文及共读过程中已经留下的划线、段评和章评；已有评价只是辅助证据，不代表角色必须同意。',
    chapterEvidence,
  ].filter(Boolean).join('\n\n');
}

export async function generateReadingReviewReplies({
  book,
  state,
  review,
  characters,
  request,
} = {}) {
  const participantIds = [...new Set((state?.participantIds || []).map(String).filter(Boolean))];
  const characterMap = new Map((characters || []).map((character) => [String(character.id), character]));
  const participants = participantIds.map((id) => characterMap.get(id)).filter(Boolean);
  const independentReview = review?.triggerKind === 'independent';
  if (!participants.length || (!independentReview && !review?.text && !review?.quote)) return [];
  const chapter = (book?.chapters || []).find((item) => String(item.id) === String(review.chapterId || '')) || null;
  const highlightReply = review.triggerKind === 'highlight';
  const scopeLabel = highlightReply ? '划线回应' : review.scope === 'paragraph' ? '段评' : review.scope === 'chapter' ? '章评' : '书评';
  const characterCards = readingCharacterCards(participants);
  const { data } = await chatJsonGeneration({
    scope: 'together-reading-review-replies',
    request,
    messages: [
      {
        role: 'system',
        content: [
          '你在“一起读”中扮演用户选择的真实共读者。必须先完整读取每位角色的角色卡与语料，再从这个具体人物的经历、知识、审美、性格和说话习惯出发评价作品；角色资料是硬约束，禁止用通用文艺腔、陪伴腔或关系模板覆盖人设。',
          independentReview
            ? '本轮是角色独立写评价：评价对象是作品，不是用户。不要默认对用户说话，不要围绕用户表态，也不必附和已有评价；只有角色自身习惯与真实关系确实支持时，才可自然提到用户。'
            : '本轮是角色回应用户的具体评价或划线：先根据作品正文形成自己的判断，再回应用户。可以赞同、质疑、补充或从角色自身经历联想，但用户观点不能替代作品证据。',
          '只依据提供的真实正文、划线与既有讨论，不得伪造作品原文、作者观点或未提供的剧情。每位共读者各写一条 1～4 句的评价；不要写舞台动作、旁白、总结标题或“作为 AI”。只输出 JSON。',
          characterCards,
        ].join('\n\n'),
      },
      {
        role: 'user',
        content: [
          `作品：${book?.title || '未命名作品'}｜作者：${book?.author || '未知作者'}`,
          chapter ? `章节：${chapter.title}` : '',
          `评价类型：${scopeLabel}`,
          review.quote ? `用户选中的原文：${review.quote}` : '',
          independentReview
            ? `请让共读者各自独立写一条${scopeLabel}；不要假装用户已经发表过评价。`
            : highlightReply
            ? '用户刚划出了这段文字，没有附加评论，想听听共读者读到这里的真实反应。'
            : `用户的${scopeLabel}：${review.text}`,
          `作品正文与共读证据：\n${readingReviewSource(book, chapter, review, state)}`,
          `请让这些角色分别给出自己的评价，并原样使用角色 id：${participantIds.join('、')}`,
          '输出：{"replies":[{"authorId":"角色 id","text":"角色评价"}]}',
        ].filter(Boolean).join('\n\n'),
      },
    ],
    temperature: 0.82,
    maxTokens: Math.min(2600, Math.max(700, participants.length * 360)),
    auditContext: {
      operation: independentReview
        ? `together-reading-${review.scope || 'book'}-review-generation`
        : highlightReply
        ? 'together-reading-highlight-replies'
        : `together-reading-${review.scope || 'book'}-review-replies`,
      trigger: 'user-review',
      initiator: 'user',
      actorIds: participantIds,
      actorNames: participants.map((character) => String(character.name || '')).filter(Boolean),
    },
    validate: (value) => Array.isArray(value?.replies),
  });
  const allowed = new Set(participantIds);
  const seen = new Set();
  return (data?.replies || []).map((item) => ({
    authorId: String(item?.authorId || ''),
    text: String(item?.text || '').trim().slice(0, 20_000),
  })).filter((item) => {
    if (!allowed.has(item.authorId) || !item.text || seen.has(item.authorId)) return false;
    seen.add(item.authorId);
    return true;
  });
}

export async function generateReadingRangeComments({
  book,
  state,
  chapter,
  paragraphs,
  characters,
  trigger = 'auto',
  maxComments = 2,
  request,
} = {}) {
  const participantIds = [...new Set((state?.participantIds || []).map(String).filter(Boolean))];
  const preferredIds = trigger === 'auto'
    ? (state?.preferences?.autoReviewCharacterIds || []).map(String).filter((id) => participantIds.includes(id))
    : [];
  const allowedIds = preferredIds.length ? preferredIds : participantIds;
  const characterMap = new Map((characters || []).map((character) => [String(character.id), character]));
  const participants = allowedIds.map((id) => characterMap.get(id)).filter(Boolean);
  const rows = [...new Map((paragraphs || []).map((item) => [Number(item.paragraphIndex), {
    paragraphIndex: Number(item.paragraphIndex),
    text: String(item.text || '').trim().slice(0, 3000),
  }])).values()].filter((item) => Number.isInteger(item.paragraphIndex) && item.text).slice(0, 16);
  if (!participants.length || !rows.length) return [];
  const existing = (state.reviews || []).filter((item) => (
    item.chapterId === chapter?.id
    && rows.some((row) => row.paragraphIndex === Number(item.paragraphIndex))
  )).slice(-20).map((item) => ({
    authorId: item.authorId,
    paragraphIndex: Number(item.paragraphIndex),
    quote: String(item.quote || '').slice(0, 500),
    text: String(item.text || '').slice(0, 1200),
  }));
  const characterCards = readingCharacterCards(participants);
  const limit = clamp(maxComments, 1, Math.min(6, participants.length * 2));
  const { data } = await chatJsonGeneration({
    scope: 'together-reading-range-comments',
    request,
    messages: [
      {
        role: 'system',
        content: [
          '你在“一起读”的页边讨论里扮演所选共读者。每个人可以注意不同段落，也可以接住已有讨论；不要让所有人整齐围绕同一句话报到。',
          '只在确实有符合该角色的反应时写，允许少于上限。评论要像读到这里随手留下的真实段评，1～4 句，不写舞台动作、总结标题或“作为 AI”。',
          '不得虚构未提供的后文、作者意图或原句。quote 必须是对应段落里的短原文。只输出 JSON。',
          characterCards,
        ].join('\n\n'),
      },
      {
        role: 'user',
        content: [
          `作品：${book?.title || '未命名作品'}｜作者：${book?.author || '未知作者'}`,
          `章节：${chapter?.title || '正文'}`,
          `本轮来源：${trigger === 'supplement' ? '用户点击补回复' : '自动陪读段评'}`,
          `当前章节完整正文：\n${readingChapterSource(chapter)}`,
          `可评论段落：${JSON.stringify(rows)}`,
          existing.length ? `已有讨论：${JSON.stringify(existing)}` : '',
          `最多写 ${limit} 条，可由不同角色落在不同 paragraphIndex。角色只能使用这些 id：${allowedIds.join('、')}`,
          '输出：{"comments":[{"authorId":"角色 id","paragraphIndex":0,"quote":"该段短原文","text":"角色段评"}]}',
        ].filter(Boolean).join('\n\n'),
      },
    ],
    temperature: 0.86,
    maxTokens: Math.min(3000, Math.max(800, limit * 420)),
    auditContext: {
      operation: trigger === 'supplement' ? 'together-reading-paragraph-supplement' : 'together-reading-auto-paragraph-comments',
      trigger,
      initiator: trigger === 'auto' ? 'feature-auto' : 'user',
      actorIds: allowedIds,
      actorNames: participants.map((character) => String(character.name || '')).filter(Boolean),
    },
    validate: (value) => Array.isArray(value?.comments),
  });
  const allowed = new Set(allowedIds);
  const paragraphMap = new Map(rows.map((row) => [row.paragraphIndex, row.text]));
  const seen = new Set();
  return (data?.comments || []).map((item) => {
    const authorId = String(item?.authorId || '');
    const paragraphIndex = Number(item?.paragraphIndex);
    const source = paragraphMap.get(paragraphIndex) || '';
    let quote = String(item?.quote || '').trim().slice(0, 500);
    if (quote && !source.includes(quote)) quote = '';
    return {
      authorId,
      paragraphIndex,
      quote,
      text: String(item?.text || '').trim().slice(0, 20_000),
    };
  }).filter((item) => {
    const key = `${item.authorId}:${item.paragraphIndex}`;
    if (!allowed.has(item.authorId) || !paragraphMap.has(item.paragraphIndex) || !item.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

async function saveRangeComments(book, state, chapter, comments) {
  let latest = state;
  for (const comment of comments) {
    latest = await addReadingReview(book.id, {
      scope: 'paragraph',
      authorId: comment.authorId,
      chapterId: chapter.id,
      paragraphIndex: comment.paragraphIndex,
      quote: comment.quote,
      text: comment.text,
    });
  }
  return latest;
}

async function addReviewReplies(book, nextState, review, characters) {
  const participantCount = (nextState.participantIds || []).length;
  if (!participantCount) return { state: nextState, replies: [] };
  showToast('共读者正在回应…', 1800);
  const replies = await generateReadingReviewReplies({ book, state: nextState, review, characters });
  let latest = nextState;
  for (const reply of replies) {
    latest = await addReadingReview(book.id, {
      ...review,
      authorId: reply.authorId,
      text: reply.text,
    });
  }
  return { state: latest, replies };
}

async function generateCharacterBooklist(characters, books) {
  const shelf = books.map((book) => ({ id: book.id, title: book.title, author: book.author }));
  const characterCards = readingCharacterCards(characters);
  const raw = await chat([
    {
      role: 'system',
      content: `你在为“一起读”生成角色书单。保持角色口吻和真实阅读品味。书架内作品可以标记为 shelf；其它公开出版作品只能标记为 recommendation，不能声称已找到正文或下载地址。不要虚构作者、译者、文件来源或可下载状态。只输出 JSON：{"title":"书单名","note":"角色给用户的一小段话","books":[{"title":"","author":"","reason":"","sourceType":"shelf|recommendation","bookId":"书架作品 id 或空","verified":true|false}]}`,
    },
    {
      role: 'user',
      content: `${characterCards}\n\n用户当前书架：${JSON.stringify(shelf)}\n请共同挑 4～8 本，至少包含 1 本现有书架作品（若书架非空）。`,
    },
  ], {
    stream: false,
    temperature: 0.78,
    auditContext: { operation: 'together-reading-booklist', trigger: 'user-button', initiator: 'user' },
  });
  const parsed = parseJsonObject(raw);
  const shelfMap = new Map(books.map((book) => [String(book.id), book]));
  const result = {
    title: String(parsed.title || 'TA 推荐的书').slice(0, 120),
    note: String(parsed.note || '').slice(0, 8000),
    books: (Array.isArray(parsed.books) ? parsed.books : []).slice(0, 10).map((item) => {
      const match = shelfMap.get(String(item.bookId || ''));
      return {
        title: String(match?.title || item.title || '未命名作品').slice(0, 160),
        author: String(match?.author || item.author || '作者待核实').slice(0, 160),
        reason: String(item.reason || '').slice(0, 3000),
        sourceType: match ? 'shelf' : 'recommendation',
        bookId: match?.id || '',
        verified: !!match,
      };
    }),
  };
  if (result.books.length < 2) throw new Error('AI 返回的书目不足，请重新生成一次');
  return result;
}

async function renderLanding(container, params = {}) {
  await ensureReadingLibrary();
  const section = ['shelf', 'together', 'notes', 'mine'].includes(params.section) ? params.section : 'shelf';
  const tab = params.tab === 'recommendations' ? 'recommendations' : 'library';
  const [books, characters, booklists] = await Promise.all([
    listReadingBooks(),
    listCharacters({ excludeAnonNpc: true }).catch(() => []),
    listCharacterBooklists(),
  ]);
  const current = books.find((book) => percentOf(book.state) > 0 || book.state?.participantIds?.length) || null;

  const header = `<header class="tr-masthead">
    <span class="tr-brand"><button type="button" class="tr-home-back" data-back aria-label="返回主屏">${icon('back')}</button><span><h1>一起读</h1><em>测试中</em></span></span>
    <span class="tr-head-actions"><button type="button" data-tr-search aria-label="搜索">${icon('search')}</button><button type="button" data-tr-import aria-label="导入本地书">${icon('plusCircle')}</button></span>
  </header>`;

  let main = '';
  if (section === 'shelf') {
    const currentChapter = current ? chapterAt(current, current.state) : null;
    main = `${current ? `<button type="button" class="tr-now-reading" data-tr-book="${esc(current.id)}" data-tr-read-direct>
      <span class="tr-now-label">${current.state?.participantIds?.length ? '正在一起读' : '继续阅读'}</span>
      <span class="tr-now-cover">${coverMarkup(current)}</span>
      <span class="tr-now-copy"><strong>${esc(current.title)}</strong><small>${current.state?.participantIds?.length ? `和 ${esc(characters.find((character) => current.state.participantIds.includes(character.id))?.name || 'TA')} 共读 · ` : ''}${esc(currentChapter?.title || '准备开始')}</small><i><b style="width:${percentOf(current.state)}%"></b></i><em>${Math.max(1, Math.round(percentOf(current.state)))}%</em></span>
      ${participantAvatars(current.state?.participantIds, characters)}
    </button>` : ''}
    <div class="tr-library-tabs" role="tablist"><button type="button" class="${tab === 'library' ? 'is-active' : ''}" data-tr-tab="library">我的书架 <span>${books.length}</span></button><button type="button" class="${tab === 'recommendations' ? 'is-active' : ''}" data-tr-tab="recommendations">TA 推荐 <span>${booklists.length}</span></button></div>
    ${tab === 'library'
      ? `<div class="tr-shelf-grid">${books.map((book) => bookShelfItem(book, characters)).join('')}<button type="button" class="tr-shelf-item tr-add-book" data-tr-import><span class="tr-shelf-cover"><i>${icon('plus')}</i><small>TXT · EPUB</small></span><strong>导入书籍</strong></button></div>`
      : `<div class="tr-booklists">${booklists.length ? booklists.map((list) => `<article class="tr-booklist" data-tr-booklist="${esc(list.id)}"><header>${participantAvatars(list.characterIds, characters, 3)}<span><strong>${esc(list.title)}</strong><small>${new Date(list.createdAt).toLocaleDateString('zh-CN')}</small></span></header>${list.note ? `<p>${esc(list.note)}</p>` : ''}<div>${(list.books || []).slice(0, 8).map((book) => `<button type="button" ${book.bookId ? `data-tr-book="${esc(book.bookId)}"` : ''}><b>${esc(book.title)}</b><small>${esc(book.author)}</small><em>${book.bookId ? '书架内' : '仅推荐'}</em></button>`).join('')}</div></article>`).join('') : emptyState('还没有角色书单')}<button type="button" class="tr-primary-action" data-tr-generate-booklist>${icon('sparkle')}<span>生成书单 · 4–8 本</span></button></div>`}`;
  } else if (section === 'together') {
    const activeBooks = books.filter((book) => book.state?.participantIds?.length);
    main = `<div class="tr-section-title"><h2>共读</h2><span>${activeBooks.length}</span></div><div class="tr-together-list">${activeBooks.length ? activeBooks.map((book) => `<button type="button" data-tr-book="${esc(book.id)}"><span>${coverMarkup(book)}</span><span><strong>${esc(book.title)}</strong><small>${esc(chapterAt(book, book.state).title)}</small><i><b style="width:${percentOf(book.state)}%"></b></i></span>${participantAvatars(book.state.participantIds, characters, 4)}</button>`).join('') : emptyState('从书籍详情选择一起读的人')}</div>`;
  } else if (section === 'notes') {
    const noteRows = books.flatMap((book) => [
      ...(book.state?.annotations || []).map((item) => ({ ...item, rowKind: '划线', book })),
      ...(book.state?.reviews || []).map((item) => ({ ...item, rowKind: item.scope === 'book' ? '书评' : item.scope === 'chapter' ? '章评' : '段评', book })),
    ]).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    main = `<div class="tr-section-title"><h2>笔记</h2><span>${noteRows.length}</span></div><div class="tr-note-feed">${noteRows.length ? noteRows.map((item) => `<button type="button" data-tr-reviews="${esc(item.book.id)}"><span>${esc(item.rowKind)} · ${esc(item.book.title)}</span>${item.quote ? `<blockquote>${esc(item.quote)}</blockquote>` : ''}${item.text ? `<p>${esc(item.text)}</p>` : ''}<time>${new Date(item.createdAt).toLocaleDateString('zh-CN')}</time></button>`).join('') : emptyState('划线、段评和书评会收在这里')}</div>`;
  } else {
    const cardCount = books.reduce((sum, book) => sum + (book.state?.cards?.length || 0), 0);
    main = `<div class="tr-section-title"><h2>我的</h2></div><div class="tr-mine-list"><button type="button" data-tr-import><span>${icon('upload')}<b>导入本地书</b></span><em>TXT / EPUB</em></button><button type="button" data-tr-section="notes"><span>${icon('edit')}<b>阅读笔记</b></span><em>${books.reduce((sum, book) => sum + (book.state?.annotations?.length || 0) + (book.state?.reviews?.length || 0), 0)}</em></button><button type="button" data-tr-section="notes"><span>${icon('image')}<b>阅读卡片</b></span><em>${cardCount}</em></button></div>`;
  }

  container.className = 'page tr-page tr-library-page';
  container.innerHTML = `${header}<main class="tr-library-scroll">${main}</main>${bottomNav(section)}`;
  container.querySelector('[data-back]')?.addEventListener('click', () => back());

  const doImport = () => pickOneFile({
    accept: READING_FORMAT_ACCEPT,
    onFile: async (file) => {
      showToast('正在导入书籍…', 2000);
      const book = await importReadingFile(file);
      showToast(`已加入「${book.title}」`);
      navigate('together-reading', { view: 'book', bookId: book.id });
    },
  });
  container.querySelectorAll('[data-tr-import]').forEach((button) => button.addEventListener('click', doImport));
  container.querySelectorAll('[data-tr-book]').forEach((button) => button.addEventListener('click', () => {
    const bookId = button.getAttribute('data-tr-book');
    navigate('together-reading', button.hasAttribute('data-tr-read-direct') ? { view: 'reader', bookId } : { view: 'book', bookId });
  }));
  container.querySelectorAll('[data-tr-section]').forEach((button) => button.addEventListener('click', () => navigate('together-reading', { section: button.getAttribute('data-tr-section') })));
  container.querySelectorAll('[data-tr-tab]').forEach((button) => button.addEventListener('click', () => navigate('together-reading', { tab: button.getAttribute('data-tr-tab') })));
  container.querySelectorAll('[data-tr-reviews]').forEach((button) => button.addEventListener('click', () => navigate('together-reading', { view: 'reviews', bookId: button.getAttribute('data-tr-reviews') })));
  container.querySelector('[data-tr-search]')?.addEventListener('click', () => {
    const value = window.prompt('搜索书名或作者', '')?.trim().toLowerCase();
    if (!value) return;
    const match = books.find((book) => `${book.title} ${book.author}`.toLowerCase().includes(value));
    if (match) navigate('together-reading', { view: 'book', bookId: match.id });
    else showToast('书架里没有找到');
  });
  container.querySelector('[data-tr-generate-booklist]')?.addEventListener('click', async (event) => {
    // 弹窗等待结束后 event.currentTarget 会被清空，因此先保留按钮引用。
    const button = event.currentTarget;
    if (!characters.length) { showToast('先在通讯录添加角色'); return; }
    const selected = await openParticipantPicker({ title: '让谁来挑书', items: characters, searchable: true, multiple: true, confirmLabel: '开始挑书' });
    if (!selected?.length) return;
    const chosen = characters.filter((character) => selected.includes(String(character.id)));
    const label = button.querySelector('span');
    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    if (label) label.textContent = `正在整理 4–8 本 · ${chosen.length} 位角色`;
    showToast('已提交给聊天 API，正在生成角色书单…', 8000);
    try {
      const generated = await generateCharacterBooklist(chosen, books);
      await saveCharacterBooklist({ ...generated, characterIds: selected });
      showToast('TA 的书单已经放好了');
      navigate('together-reading', { tab: 'recommendations' }, true);
    } catch (error) {
      showToast(`书单生成失败：${error?.message || '请检查聊天 API'}`, 7000);
    } finally {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      if (label) label.textContent = '生成书单 · 4–8 本';
    }
  });
}

function detailTabs(book, state, tab) {
  const reviewCount = state.reviews.length;
  return `<div class="tr-detail-tabs"><button type="button" class="${tab === 'about' ? 'is-active' : ''}" data-tr-detail-tab="about">详情</button><button type="button" class="${tab === 'contents' ? 'is-active' : ''}" data-tr-detail-tab="contents">目录 <span>${book.chapters.length}</span></button><button type="button" class="${tab === 'reviews' ? 'is-active' : ''}" data-tr-detail-tab="reviews">书评 <span>${reviewCount}</span></button></div>`;
}

async function renderBookDetail(container, params = {}) {
  const book = await getReadingBook(params.bookId);
  if (!book) { showToast('没有找到这本书'); back(); return; }
  const [state, characters] = await Promise.all([getReadingState(book.id), listCharacters({ excludeAnonNpc: true }).catch(() => [])]);
  const tab = ['about', 'contents', 'reviews'].includes(params.tab) ? params.tab : 'about';
  const progress = percentOf(state);
  let tabContent = '';
  if (tab === 'about') {
    tabContent = `<section class="tr-book-about"><dl><div><dt>格式</dt><dd>${esc(book.format.toUpperCase())}</dd></div><div><dt>章节</dt><dd>${book.chapters.length}</dd></div><div><dt>字数</dt><dd>${Math.max(1, Math.round((book.charCount || 0) / 1000))} 千</dd></div>${book.language ? `<div><dt>语言</dt><dd>${esc(book.language)}</dd></div>` : ''}</dl><button type="button" class="tr-participant-entry" data-tr-pick-participants><span><b>一起读的人</b><small>${state.participantIds.length ? '阅读进度和段评会共享给所选角色' : '选择一位或多位角色'}</small></span>${participantAvatars(state.participantIds, characters, 4) || icon('chevron')}</button><button type="button" class="tr-delete-book" data-tr-delete-book>移出书架</button></section>`;
  } else if (tab === 'contents') {
    const txtRuleEntry = String(book.format || '').toLowerCase() === 'txt'
      ? `<button type="button" class="tr-directory-rule-entry" data-tr-directory-rule><span>${icon('edit')}<b>TXT 目录规则</b></span><em>${book.chapterPattern && book.chapterPattern !== DEFAULT_TXT_CHAPTER_PATTERN ? '自定义' : '自动识别'}</em></button>`
      : '';
    tabContent = `${txtRuleEntry}<ol class="tr-contents">${book.chapters.map((chapter, index) => `<li><button type="button" data-tr-chapter="${index}"><span>${String(index + 1).padStart(2, '0')}</span><strong>${esc(chapter.title)}</strong><em>${chapter.paragraphs.length} 段</em></button></li>`).join('')}</ol>`;
  } else {
    const reviews = state.reviews.filter((item) => item.scope === 'book');
    tabContent = `<div class="tr-detail-reviews"><div class="tr-review-actions"><button type="button" class="tr-write-review" data-tr-write-book-review>${icon('edit')}<span>写书评</span></button><button type="button" class="tr-generate-review" data-tr-generate-book-review>${icon('sparkle')}<span>让 TA 写书评</span></button></div>${reviews.length ? reviews.map((item) => `<article><header><strong>${item.authorId === 'user' ? '我' : esc(characters.find((character) => character.id === item.authorId)?.name || '共读者')}</strong><time>${new Date(item.createdAt).toLocaleDateString('zh-CN')}</time></header><p>${esc(item.text)}</p></article>`).join('') : emptyState('还没有书评')}</div>`;
  }
  container.className = 'page tr-page tr-book-page';
  container.innerHTML = `<header class="tr-page-head"><button type="button" data-back aria-label="返回">${icon('back')}</button><h1>书籍详情</h1><button type="button" data-tr-book-more aria-label="更多">${icon('more')}</button></header>
    <main class="tr-book-scroll"><section class="tr-book-hero"><button type="button" class="tr-detail-cover" data-tr-cover-action aria-label="更换封面">${coverMarkup(book)}<i>${icon('image')}</i></button><div class="tr-book-meta"><h2>${esc(book.title)}</h2><p>${esc(book.author)}</p><small>${book.source === 'builtin' ? '原创试读' : '本地导入'} · ${esc(book.format.toUpperCase())}</small></div></section>
    <button type="button" class="tr-continue-button" data-tr-open-reader><span>${progress ? '继续阅读' : '开始阅读'}</span><small>${esc(chapterAt(book, state).title)}</small><i>${Math.round(progress)}%</i></button>
    ${detailTabs(book, state, tab)}${tabContent}</main>`;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  const deleteCurrentBook = async () => {
    if (!window.confirm(`从本地书架删除「${book.title}」？划线、评价和卡片也会一起删除。`)) return;
    await removeReadingBook(book.id);
    showToast('已从书架删除');
    navigate('together-reading', {}, true);
  };
  container.querySelector('[data-tr-delete-book]')?.addEventListener('click', deleteCurrentBook);
  container.querySelector('[data-tr-open-reader]')?.addEventListener('click', () => navigate('together-reading', { view: 'reader', bookId: book.id }));
  container.querySelectorAll('[data-tr-detail-tab]').forEach((button) => button.addEventListener('click', () => navigate('together-reading', { view: 'book', bookId: book.id, tab: button.getAttribute('data-tr-detail-tab') }, true)));
  container.querySelectorAll('[data-tr-chapter]').forEach((button) => button.addEventListener('click', async () => {
    const chapterIndex = Number(button.getAttribute('data-tr-chapter') || 0);
    await patchReadingState(book.id, { progress: { chapterIndex, pageIndex: 0, paragraphIndex: 0, percent: Math.round((chapterIndex / book.chapters.length) * 100), updatedAt: Date.now() } });
    navigate('together-reading', { view: 'reader', bookId: book.id });
  }));
  container.querySelector('[data-tr-directory-rule]')?.addEventListener('click', async () => {
    const pattern = await openTxtChapterPatternEditor(book);
    if (!pattern) return;
    const hasReadingData = Number(state.progress?.updatedAt || 0) > 0 || state.annotations.length > 0 || state.reviews.length > 0;
    if (hasReadingData && !window.confirm('重新识别目录会回到对应章节开头。标题相同的章节会保留原有划线和评价，仍要继续吗？')) return;
    showToast('正在重新识别目录…', 1800);
    const updated = await reparseReadingTxtBook(book.id, pattern);
    showToast(`已识别 ${updated.chapters.length} 章`);
    renderBookDetail(container, { ...params, tab: 'contents' });
  });
  container.querySelector('[data-tr-pick-participants]')?.addEventListener('click', async () => {
    if (!characters.length) { showToast('先在通讯录添加角色'); return; }
    const selected = await openParticipantPicker({ title: '选择一起读的人', items: characters, searchable: true, multiple: true, preselected: state.participantIds, confirmLabel: '一起读' });
    if (!selected) return;
    await patchReadingState(book.id, { participantIds: selected });
    showToast(selected.length ? `已邀请 ${selected.length} 位共读者` : '已改为自己阅读');
    renderBookDetail(container, params);
  });
  const changeCover = () => pickOneFile({ accept: 'image/*', onFile: async (file) => {
    showToast('正在处理封面…', 1800);
    const cover = await imageFileToCover(file);
    await updateReadingBookMetadata(book.id, { cover, coverKind: 'custom' });
    showToast('封面已更新');
    renderBookDetail(container, params);
  } });
  container.querySelector('[data-tr-cover-action]')?.addEventListener('click', changeCover);
  container.querySelector('[data-tr-write-book-review]')?.addEventListener('click', async () => {
    const text = await openTextComposer({ title: '写书评', placeholder: '写下读完整本书后的想法' });
    if (!text) return;
    await addReadingReview(book.id, { scope: 'book', text });
    showToast('书评已保存');
    renderBookDetail(container, { ...params, tab: 'reviews' });
  });
  container.querySelector('[data-tr-generate-book-review]')?.addEventListener('click', async (event) => {
    if (!state.participantIds.length) { showToast('先在书籍详情选择一起读的人'); return; }
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await addReviewReplies(book, state, { scope: 'book', triggerKind: 'independent', text: '' }, characters);
      showToast(result.replies.length ? 'TA 的书评已经写好了' : '共读者这次没有留下书评');
      renderBookDetail(container, { ...params, tab: 'reviews' });
    } catch (error) {
      showToast(`书评生成失败：${error?.message || '请检查聊天 API'}`, 7000);
    } finally {
      button.disabled = false;
    }
  });
  container.querySelector('[data-tr-book-more]')?.addEventListener('click', async () => {
    const choice = window.prompt('输入操作：编辑 / 恢复封面 / 删除', '编辑')?.trim();
    if (!choice) return;
    if (choice.includes('恢复') || choice.includes('封面')) {
      await updateReadingBookMetadata(book.id, { cover: '', coverKind: 'auto' });
      showToast('已恢复自动封面');
      renderBookDetail(container, params);
      return;
    }
    if (choice.includes('删除')) {
      await deleteCurrentBook();
      return;
    }
    const title = window.prompt('书名', book.title)?.trim();
    if (!title) return;
    const author = window.prompt('作者', book.author)?.trim() || '未知作者';
    const categoryInput = window.prompt('题材：普通 / 诗歌 / 书信 / 短散文 / 外文学习', ({
      general: '普通', poetry: '诗歌', letter: '书信', prose: '短散文', study: '外文学习',
    })[book.category] || '普通')?.trim();
    const category = ({ 普通: 'general', 诗歌: 'poetry', 书信: 'letter', 短散文: 'prose', 外文学习: 'study' })[categoryInput] || book.category || 'general';
    await updateReadingBookMetadata(book.id, { title, author, category });
    showToast('书籍信息已更新');
    renderBookDetail(container, params);
  });
}

function cssPixelValue(element, propertyName) {
  if (!element || typeof getComputedStyle !== 'function') return 0;
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(propertyName));
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function readerPageMetrics(preferences = {}, layout = {}) {
  const font = clamp(preferences.fontSize || 19, 15, 30);
  const lineHeight = clamp(preferences.lineHeight || 1.95, 1.45, 2.4);
  const viewportElement = layout.viewportElement || null;
  const viewportWidth = Math.min(760, Math.max(280, Number(
    layout.width
    || viewportElement?.clientWidth
    || globalThis.visualViewport?.width
    || globalThis.innerWidth
    || 390,
  )));
  const viewportHeight = Math.max(320, Number(
    layout.height
    || viewportElement?.clientHeight
    || globalThis.visualViewport?.height
    || globalThis.innerHeight
    || 760,
  ));
  const safeTop = Number.isFinite(Number(layout.safeTop))
    ? Math.max(0, Number(layout.safeTop))
    : cssPixelValue(viewportElement, '--tr-safe-top');
  const safeBottom = Number.isFinite(Number(layout.safeBottom))
    ? Math.max(0, Number(layout.safeBottom))
    : cssPixelValue(viewportElement, '--tr-safe-bottom');
  const horizontalInset = clamp(viewportWidth * 0.07, 27, 68);
  const paperWidth = Math.max(font * 6, viewportWidth - horizontalInset * 2);
  // 与 CSS 的页头 61px、底栏 52px、纸张上下 inset 11/12px 保持同源。
  const paperHeight = Math.max(font * lineHeight * 4, (
    viewportHeight - 61 - 52 - safeTop - safeBottom - 23
  ));
  const charsPerLine = Math.max(6, Math.floor(paperWidth / (font * 1.04)));
  const visibleLines = Math.max(4, Math.floor(paperHeight / (font * lineHeight)));
  // 留一行应对 Android WebView 字体基线、字距与小数像素取整；段后距单独计成字符成本。
  const usableLines = Math.max(3, visibleLines - 1);
  const paragraphCost = Math.max(3, Math.ceil(charsPerLine / lineHeight));
  const budget = Math.max(
    charsPerLine * 3,
    Math.floor(charsPerLine * usableLines * 0.84),
  );
  return {
    budget,
    charsPerLine,
    visibleLines,
    paragraphCost,
    minChunk: Math.max(18, charsPerLine * 2),
  };
}

export function buildChapterPages(chapter = {}, preferences = {}, layout = {}) {
  const {
    budget,
    paragraphCost,
    minChunk,
  } = readerPageMetrics(preferences, layout);
  const pages = [];
  let current = [];
  let count = 0;
  const flush = () => {
    if (!current.length) return;
    pages.push(current);
    current = [];
    count = 0;
  };
  (chapter.paragraphs || []).forEach((paragraph, paragraphIndex) => {
    const text = String(paragraph || '');
    if (!text) return;
    let offset = 0;
    while (offset < text.length) {
      if (current.length && budget - count <= minChunk + paragraphCost) flush();
      const remaining = Math.max(minChunk, budget - count - paragraphCost);
      let end = Math.min(text.length, offset + remaining);
      if (end < text.length) {
        const candidates = [...text.slice(offset, end).matchAll(/[。！？!?；;]\s*/g)];
        const soft = candidates.at(-1);
        const softEnd = soft ? Number(soft.index || 0) + soft[0].length : 0;
        if (softEnd > remaining * 0.55) end = offset + softEnd;
      }
      const part = text.slice(offset, end);
      if (count && count + part.length + paragraphCost > budget) {
        flush();
        continue;
      }
      current.push({ paragraphIndex, startOffset: offset, endOffset: end, text: part });
      count += part.length + paragraphCost;
      offset = end;
      if (count >= budget) flush();
    }
  });
  flush();
  return pages.length ? pages : [[{ paragraphIndex: 0, startOffset: 0, endOffset: 0, text: '' }]];
}

function readerThemeSheet(state, nativeAvailable, characters = []) {
  const theme = state.preferences.theme;
  const activeAutoIds = state.preferences.autoReviewCharacterIds.length
    ? state.preferences.autoReviewCharacterIds
    : state.participantIds;
  const activeAutoNames = activeAutoIds.map((id) => characters.find((character) => String(character.id) === String(id))?.name).filter(Boolean);
  return `<div class="tr-reader-sheet" role="dialog" aria-modal="true"><header><h2>阅读设置</h2><button type="button" data-tr-reader-sheet-close>${icon('close')}</button></header><div class="tr-theme-options">${[
    ['white', '白纸'], ['paper', '米纸'], ['eye', '护眼'], ['night', '夜间'],
  ].map(([id, label]) => `<button type="button" class="is-${id} ${theme === id ? 'is-active' : ''}" data-tr-theme="${id}"><i></i><span>${label}</span></button>`).join('')}</div><div class="tr-font-controls"><span>字号</span><button type="button" data-tr-font="-1">A−</button><em>${state.preferences.fontSize}</em><button type="button" data-tr-font="1">A＋</button></div><section class="tr-auto-review-settings"><label class="tr-auto-review-toggle"><span><b>自动段评</b><small>${state.participantIds.length ? '按阅读进度自然出现' : '先选择一起读的人'}</small></span><input type="checkbox" data-tr-auto-review ${state.preferences.autoReviewEnabled ? 'checked' : ''} ${state.participantIds.length ? '' : 'disabled'}></label><div class="tr-auto-review-levels">${[['quiet', '安静'], ['natural', '自然'], ['active', '活跃']].map(([id, label]) => `<button type="button" class="${state.preferences.autoReviewActivity === id ? 'is-active' : ''}" data-tr-auto-review-level="${id}">${label}</button>`).join('')}</div><div class="tr-auto-review-row"><button type="button" data-tr-auto-review-characters><span>主动评论角色</span><em>${esc(activeAutoNames.join('、') || '全部共读者')}</em></button><label><span>每章上限</span><select data-tr-auto-review-max>${[1, 2, 3, 4].map((value) => `<option value="${value}" ${Number(state.preferences.autoReviewMaxPerChapter) === value ? 'selected' : ''}>${value} 次</option>`).join('')}</select></label></div></section>${nativeAvailable ? `<label class="tr-volume-toggle"><span><b>音量键翻页</b><small>仅 Android APK 阅读页生效</small></span><input type="checkbox" data-tr-volume-paging ${state.preferences.volumePaging ? 'checked' : ''}></label>` : ''}</div>`;
}

function nativeReaderPlugin() {
  return globalThis.Capacitor?.Plugins?.MarshmallowReader || null;
}

function readerProgressPercent(book, chapterIndex, pageIndex, totalPages) {
  const chapterShare = 100 / Math.max(1, book.chapters.length);
  return clamp((chapterIndex * chapterShare) + ((pageIndex + 1) / Math.max(1, totalPages)) * chapterShare, 0, 100);
}

async function renderReader(container, params = {}) {
  const book = await getReadingBook(params.bookId);
  if (!book) { showToast('没有找到这本书'); back(); return; }
  const [initialState, characters] = await Promise.all([
    getReadingState(book.id),
    listCharacters({ excludeAnonNpc: true }).catch(() => []),
  ]);
  let state = initialState;
  let chapterIndex = clamp(state.progress.chapterIndex || 0, 0, book.chapters.length - 1);
  let chapter = book.chapters[chapterIndex];
  const applyReaderSurface = () => {
    container.className = `page tr-page tr-reader-page tr-theme-${esc(state.preferences.theme)}`;
    container.style.setProperty('--tr-reader-font-size', `${state.preferences.fontSize}px`);
    container.style.setProperty('--tr-reader-line-height', String(state.preferences.lineHeight));
  };
  applyReaderSurface();
  let pages = buildChapterPages(chapter, state.preferences, { viewportElement: container });
  let pageIndex = clamp(state.progress.pageIndex || 0, 0, pages.length - 1);
  let settingsOpen = false;
  let selectionInfo = null;
  let pageEnteredAt = Date.now();
  let autoReviewInFlight = false;
  const plugin = nativeReaderPlugin();

  const savePosition = async () => {
    const percent = readerProgressPercent(book, chapterIndex, pageIndex, pages.length);
    state = await patchReadingState(book.id, { progress: { chapterIndex, pageIndex, paragraphIndex: pages[pageIndex]?.[0]?.paragraphIndex || 0, percent, updatedAt: Date.now() } });
  };

  const paint = ({ preserveAnchor = false } = {}) => {
    const anchor = preserveAnchor ? pages[pageIndex]?.[0] : null;
    chapter = book.chapters[chapterIndex];
    applyReaderSurface();
    pages = buildChapterPages(chapter, state.preferences, { viewportElement: container });
    if (anchor) {
      const anchoredPage = pages.findIndex((parts) => parts.some((part) => (
        part.paragraphIndex === anchor.paragraphIndex
        && part.startOffset <= anchor.startOffset
        && part.endOffset > anchor.startOffset
      )));
      if (anchoredPage >= 0) pageIndex = anchoredPage;
    }
    pageIndex = clamp(pageIndex, 0, pages.length - 1);
    const page = pages[pageIndex];
    const annotations = state.annotations.filter((item) => item.chapterId === chapter.id);
    const paragraphReviews = state.reviews.filter((item) => item.scope === 'paragraph' && item.chapterId === chapter.id);
    container.innerHTML = `<header class="tr-reader-head"><button type="button" data-back aria-label="返回">${icon('back')}</button><span><strong>${esc(book.title)}</strong><small>${esc(chapter.title)}</small></span><button type="button" data-tr-reader-settings aria-label="阅读设置">${icon('text')}</button></header><main class="tr-reader-stage" data-tr-reader-stage>
      <button type="button" class="tr-page-zone is-prev" data-tr-prev aria-label="上一页"></button>
      <article class="tr-reader-paper">${page.map((part) => {
        const paragraphAnnotations = annotations.filter((item) => Number(item.paragraphIndex) === part.paragraphIndex);
        const paragraphNotes = [...paragraphAnnotations, ...paragraphReviews.filter((item) => Number(item.paragraphIndex) === part.paragraphIndex)];
        return `<div class="tr-reader-paragraph-row"><p class="tr-paragraph ${paragraphNotes.length ? 'has-note' : ''}" data-paragraph-index="${part.paragraphIndex}" data-start-offset="${part.startOffset}">${markedParagraphHtml(part, paragraphAnnotations)}</p>${paragraphNotes.length ? `<button type="button" class="tr-margin-note" data-tr-open-notes data-paragraph-index="${part.paragraphIndex}" aria-label="${paragraphNotes.length} 条边注"><i></i><span>${paragraphNotes.length}</span></button>` : ''}</div>`;
      }).join('')}</article>
      <button type="button" class="tr-page-zone is-next" data-tr-next aria-label="下一页"></button>
    </main><footer class="tr-reader-foot"><button type="button" data-tr-contents>${icon('menu')}</button><span>${pageIndex + 1} / ${pages.length}</span><i><b style="width:${readerProgressPercent(book, chapterIndex, pageIndex, pages.length)}%"></b></i><button type="button" data-tr-open-notes>${icon('edit')}</button></footer>
    <div class="tr-selection-tools ${selectionInfo ? 'is-visible' : ''}" data-tr-selection-tools><button type="button" data-tr-highlight>划线</button><button type="button" data-tr-paragraph-review>段评</button><button type="button" data-tr-ask-participants>问 TA</button><button type="button" data-tr-make-card>制卡</button></div>
    ${settingsOpen ? readerThemeSheet(state, !!plugin, characters) : ''}`;
    bind();
  };

  const maybeGenerateAutoReviews = async ({ readChapter, readPage, dwellMs, chapterEnded = false } = {}) => {
    if (!state.preferences.autoReviewEnabled || autoReviewInFlight || !readChapter || !readPage?.length) return;
    if (!state.participantIds.length) return;
    const activity = state.preferences.autoReviewActivity;
    const threshold = activity === 'quiet' ? 5000 : activity === 'active' ? 1600 : 3000;
    const minDwell = activity === 'active' ? 7000 : activity === 'quiet' ? 16_000 : 11_000;
    if (!chapterEnded && dwellMs < minDwell) return;
    const paragraphStarts = [];
    let cursor = 0;
    (readChapter.paragraphs || []).forEach((text, index) => {
      paragraphStarts[index] = cursor;
      cursor += String(text || '').length + 1;
    });
    const lastPart = readPage.at(-1);
    const currentPosition = (paragraphStarts[lastPart.paragraphIndex] || 0) + Number(lastPart.endOffset || 0);
    const autoState = state.autoReviewState || { chapterCounts: {}, lastPositions: {}, generatedKeys: [] };
    const lastPosition = Number(autoState.lastPositions?.[readChapter.id] || 0);
    const chapterCount = Number(autoState.chapterCounts?.[readChapter.id] || 0);
    const maxPerChapter = Number(state.preferences.autoReviewMaxPerChapter || 2);
    if (chapterCount >= maxPerChapter || currentPosition <= lastPosition) return;
    const distance = currentPosition - lastPosition;
    if (distance < threshold && !(chapterEnded && distance >= 400)) return;
    const candidates = (readChapter.paragraphs || []).map((text, paragraphIndex) => ({
      paragraphIndex,
      text: String(text || ''),
      start: paragraphStarts[paragraphIndex] || 0,
      end: (paragraphStarts[paragraphIndex] || 0) + String(text || '').length,
    })).filter((item) => item.end > lastPosition && item.start < currentPosition).slice(-16);
    if (!candidates.length) return;
    autoReviewInFlight = true;
    state = await patchReadingState(book.id, {
      autoReviewState: {
        chapterCounts: { ...autoState.chapterCounts, [readChapter.id]: chapterCount + 1 },
        lastPositions: { ...autoState.lastPositions, [readChapter.id]: currentPosition },
        generatedKeys: autoState.generatedKeys || [],
      },
    });
    try {
      const comments = await generateReadingRangeComments({
        book,
        state,
        chapter: readChapter,
        paragraphs: candidates,
        characters,
        trigger: 'auto',
        maxComments: activity === 'active' ? 3 : activity === 'quiet' ? 1 : 2,
      });
      const knownKeys = new Set(state.autoReviewState.generatedKeys || []);
      const fresh = comments.filter((comment) => !knownKeys.has(`${readChapter.id}:${comment.paragraphIndex}:${comment.authorId}`));
      state = await saveRangeComments(book, state, readChapter, fresh);
      const generatedKeys = [...knownKeys, ...fresh.map((comment) => `${readChapter.id}:${comment.paragraphIndex}:${comment.authorId}`)].slice(-300);
      state = await patchReadingState(book.id, { autoReviewState: { generatedKeys } });
      if (fresh.length) {
        showToast(`共读者留下了 ${fresh.length} 条段评`);
        if (chapter.id === readChapter.id) paint({ preserveAnchor: true });
      }
    } catch (error) {
      showToast(`自动段评失败：${error?.message || '请检查聊天 API'}`, 5000);
    } finally {
      autoReviewInFlight = false;
    }
  };

  const changePage = async (direction) => {
    const readChapter = chapter;
    const readPage = pages[pageIndex];
    const dwellMs = Date.now() - pageEnteredAt;
    const leavingChapterForward = direction > 0 && pageIndex >= pages.length - 1;
    if (direction > 0 && pageIndex < pages.length - 1) pageIndex += 1;
    else if (direction < 0 && pageIndex > 0) pageIndex -= 1;
    else if (direction > 0 && chapterIndex < book.chapters.length - 1) { chapterIndex += 1; pageIndex = 0; }
    else if (direction < 0 && chapterIndex > 0) { chapterIndex -= 1; chapter = book.chapters[chapterIndex]; pages = buildChapterPages(chapter, state.preferences, { viewportElement: container }); pageIndex = pages.length - 1; }
    else if (direction > 0) {
      await savePosition();
      maybeGenerateAutoReviews({ readChapter, readPage, dwellMs, chapterEnded: true });
      const eligible = ['poetry', 'letter', 'prose'].includes(String(book.category || ''));
      showToast(eligible ? '读完了。有人好像留下一张笺。' : '已经读到最后一页');
      if (eligible) navigate('together-reading', { view: 'card', bookId: book.id, auto: '1', quote: chapter.paragraphs.at(-1) || '' });
      return;
    } else return;
    selectionInfo = null;
    await savePosition();
    paint();
    pageEnteredAt = Date.now();
    if (direction > 0) maybeGenerateAutoReviews({
      readChapter,
      readPage,
      dwellMs,
      chapterEnded: leavingChapterForward,
    });
  };

  function captureSelection() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { selectionInfo = null; return; }
    const range = selection.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const paragraph = startEl?.closest?.('.tr-paragraph');
    if (!paragraph || !container.contains(paragraph)) { selectionInfo = null; return; }
    const quote = String(selection.toString() || '').trim();
    if (!quote) { selectionInfo = null; return; }
    const baseOffset = Number(paragraph.getAttribute('data-start-offset') || 0);
    selectionInfo = {
      chapterId: chapter.id,
      paragraphIndex: Number(paragraph.getAttribute('data-paragraph-index') || 0),
      startOffset: baseOffset + range.startOffset,
      endOffset: baseOffset + range.endOffset,
      quote: quote.slice(0, 5000),
    };
  }

  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-tr-reader-settings]')?.addEventListener('click', () => { settingsOpen = true; paint(); });
    container.querySelector('[data-tr-reader-sheet-close]')?.addEventListener('click', () => { settingsOpen = false; paint(); });
    container.querySelector('[data-tr-prev]')?.addEventListener('click', () => changePage(-1));
    container.querySelector('[data-tr-next]')?.addEventListener('click', () => changePage(1));
    container.querySelector('[data-tr-contents]')?.addEventListener('click', () => navigate('together-reading', { view: 'book', bookId: book.id, tab: 'contents' }));
    container.querySelectorAll('[data-tr-open-notes]').forEach((button) => button.addEventListener('click', () => {
      const paragraphValue = button.getAttribute('data-paragraph-index');
      navigate('together-reading', {
        view: 'reviews',
        bookId: book.id,
        chapterId: chapter.id,
        ...(paragraphValue == null ? {} : { paragraphIndex: paragraphValue }),
      });
    }));
    container.querySelectorAll('[data-tr-theme]').forEach((button) => button.addEventListener('click', async () => {
      state = await patchReadingState(book.id, { preferences: { theme: button.getAttribute('data-tr-theme') } });
      settingsOpen = true;
      paint();
    }));
    container.querySelectorAll('[data-tr-font]').forEach((button) => button.addEventListener('click', async () => {
      state = await patchReadingState(book.id, { preferences: { fontSize: state.preferences.fontSize + Number(button.getAttribute('data-tr-font') || 0) } });
      pageIndex = 0;
      settingsOpen = true;
      paint();
    }));
    container.querySelector('[data-tr-volume-paging]')?.addEventListener('change', async (event) => {
      state = await patchReadingState(book.id, { preferences: { volumePaging: event.currentTarget.checked } });
      await plugin?.setEnabled?.({ enabled: event.currentTarget.checked });
    });
    container.querySelector('[data-tr-auto-review]')?.addEventListener('change', async (event) => {
      state = await patchReadingState(book.id, { preferences: { autoReviewEnabled: event.currentTarget.checked } });
      settingsOpen = true;
      paint();
    });
    container.querySelectorAll('[data-tr-auto-review-level]').forEach((button) => button.addEventListener('click', async () => {
      state = await patchReadingState(book.id, { preferences: { autoReviewActivity: button.getAttribute('data-tr-auto-review-level') } });
      settingsOpen = true;
      paint();
    }));
    container.querySelector('[data-tr-auto-review-max]')?.addEventListener('change', async (event) => {
      state = await patchReadingState(book.id, { preferences: { autoReviewMaxPerChapter: Number(event.currentTarget.value || 2) } });
    });
    container.querySelector('[data-tr-auto-review-characters]')?.addEventListener('click', async () => {
      const participantSet = new Set(state.participantIds.map(String));
      const choices = characters.filter((character) => participantSet.has(String(character.id)));
      if (!choices.length) { showToast('先在书籍详情选择一起读的人'); return; }
      const selected = await openParticipantPicker({
        title: '主动评论角色',
        items: choices,
        searchable: true,
        multiple: true,
        preselected: state.preferences.autoReviewCharacterIds.length ? state.preferences.autoReviewCharacterIds : state.participantIds,
        confirmLabel: '保存',
      });
      if (!selected) return;
      state = await patchReadingState(book.id, { preferences: { autoReviewCharacterIds: selected } });
      settingsOpen = true;
      paint();
    });
    const stage = container.querySelector('[data-tr-reader-stage]');
    let startX = 0;
    stage?.addEventListener('touchstart', (event) => { startX = event.touches?.[0]?.clientX || 0; }, { passive: true });
    stage?.addEventListener('touchend', (event) => {
      const delta = (event.changedTouches?.[0]?.clientX || 0) - startX;
      if (Math.abs(delta) > 54) changePage(delta < 0 ? 1 : -1);
      window.setTimeout(() => { captureSelection(); paint(); }, 50);
    }, { passive: true });
    stage?.addEventListener('mouseup', () => window.setTimeout(() => { captureSelection(); paint(); }, 30));
    container.querySelector('[data-tr-highlight]')?.addEventListener('click', async () => {
      if (!selectionInfo) return;
      state = await addReadingAnnotation(book.id, { ...selectionInfo, kind: 'highlight' });
      window.getSelection?.()?.removeAllRanges();
      selectionInfo = null;
      showToast('已划线');
      paint();
    });
    container.querySelector('[data-tr-paragraph-review]')?.addEventListener('click', async () => {
      if (!selectionInfo) return;
      const text = await openTextComposer({ title: '写段评', quote: selectionInfo.quote, placeholder: '这句话让你想到什么？' });
      if (!text) return;
      const review = { ...selectionInfo, scope: 'paragraph', text };
      state = await addReadingReview(book.id, review);
      window.getSelection?.()?.removeAllRanges();
      selectionInfo = null;
      showToast('段评已保存');
      paint();
    });
    container.querySelector('[data-tr-ask-participants]')?.addEventListener('click', async () => {
      if (!selectionInfo) return;
      if (!state.participantIds.length) { showToast('先在书籍详情选择一起读的人'); return; }
      const review = { ...selectionInfo, scope: 'paragraph', triggerKind: 'highlight', text: '' };
      state = await addReadingAnnotation(book.id, { ...selectionInfo, kind: 'highlight' });
      window.getSelection?.()?.removeAllRanges();
      selectionInfo = null;
      try {
        const result = await addReviewReplies(book, state, review, characters);
        state = result.state;
        showToast(result.replies.length ? '划线与共读回应已保存' : '已划线，共读者这次没有留下回应');
      } catch (error) {
        showToast(`已划线，共读回应失败：${error?.message || '请检查聊天 API'}`, 7000);
      }
      paint();
    });
    container.querySelector('[data-tr-make-card]')?.addEventListener('click', () => {
      if (!selectionInfo) return;
      navigate('together-reading', { view: 'card', bookId: book.id, quote: selectionInfo.quote });
    });
  }

  window.__trReaderCleanup?.();
  const keyboard = (event) => {
    if (event.target?.matches?.('input,textarea,select')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); changePage(1); }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); changePage(-1); }
  };
  window.addEventListener('keydown', keyboard);
  let viewportRepaintTimer = 0;
  const repaintForViewport = () => {
    window.clearTimeout(viewportRepaintTimer);
    viewportRepaintTimer = window.setTimeout(() => paint({ preserveAnchor: true }), 60);
  };
  window.addEventListener('marshmallow-viewport-change', repaintForViewport, { passive: true });
  window.addEventListener('orientationchange', repaintForViewport, { passive: true });
  let nativeHandle = null;
  if (plugin) {
    plugin.setEnabled?.({ enabled: state.preferences.volumePaging === true });
    Promise.resolve(plugin.addListener?.('volumeKey', (event) => changePage(event?.direction === 'previous' ? -1 : 1))).then((handle) => { nativeHandle = handle; });
  }
  const cleanup = () => {
    window.removeEventListener('keydown', keyboard);
    window.removeEventListener('marshmallow-viewport-change', repaintForViewport);
    window.removeEventListener('orientationchange', repaintForViewport);
    window.clearTimeout(viewportRepaintTimer);
    nativeHandle?.remove?.();
    plugin?.setEnabled?.({ enabled: false });
    if (window.__trReaderCleanup === cleanup) window.__trReaderCleanup = null;
  };
  window.__trReaderCleanup = cleanup;
  const onHash = () => {
    if (!String(location.hash || '').includes('view=reader')) cleanup();
  };
  window.addEventListener('hashchange', onHash, { once: true });
  paint();
  savePosition().catch(() => null);
}

async function renderReviews(container, params = {}) {
  const book = await getReadingBook(params.bookId);
  if (!book) { back(); return; }
  const [state, characters] = await Promise.all([getReadingState(book.id), listCharacters({ excludeAnonNpc: true }).catch(() => [])]);
  const scope = ['all', 'paragraph', 'chapter', 'book'].includes(params.scope) ? params.scope : 'all';
  const chapter = params.chapterId ? book.chapters.find((item) => item.id === params.chapterId) : null;
  const paragraphValue = String(params.paragraphIndex ?? '').trim();
  const focusedParagraphIndex = chapter && /^\d+$/.test(paragraphValue) ? Number(paragraphValue) : null;
  const actionScope = focusedParagraphIndex != null ? 'paragraph' : chapter ? 'chapter' : 'book';
  const generateLabel = actionScope === 'paragraph' ? '补回复' : actionScope === 'chapter' ? '让 TA 写章评' : '让 TA 写书评';
  const focusedQuote = focusedParagraphIndex == null ? '' : String(
    state.annotations.find((item) => item.chapterId === chapter.id && Number(item.paragraphIndex) === focusedParagraphIndex)?.quote
    || state.reviews.find((item) => item.chapterId === chapter.id && Number(item.paragraphIndex) === focusedParagraphIndex)?.quote
    || '',
  );
  const rows = [
    ...state.annotations.map((item) => ({ ...item, displayScope: 'paragraph', kindLabel: '划线' })),
    ...state.reviews.map((item) => ({ ...item, displayScope: item.scope, kindLabel: item.scope === 'book' ? '书评' : item.scope === 'chapter' ? '章评' : '段评' })),
  ].filter((item) => (
    (scope === 'all' || item.displayScope === scope)
    && (!chapter || item.chapterId === chapter.id)
    && (focusedParagraphIndex == null || Number(item.paragraphIndex) === focusedParagraphIndex)
  )).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  container.className = 'page tr-page tr-reviews-page';
  container.innerHTML = `<header class="tr-page-head"><button type="button" data-back>${icon('back')}</button><span><h1>${focusedParagraphIndex != null ? `第 ${focusedParagraphIndex + 1} 段讨论` : chapter ? esc(chapter.title) : '阅读评价'}</h1><small>${esc(book.title)}</small></span><button type="button" data-tr-new-review>${icon('edit')}</button></header><main class="tr-reviews-scroll">${focusedParagraphIndex == null ? `<div class="tr-review-tabs">${[['all', '全部'], ['paragraph', '段评'], ['chapter', '章评'], ['book', '书评']].map(([id, label]) => `<button type="button" class="${scope === id ? 'is-active' : ''}" data-tr-review-scope="${id}">${label}</button>`).join('')}</div>` : ''}<div class="tr-review-page-actions"><button type="button" data-tr-generate-review>${icon('sparkle')}<span>${generateLabel}</span></button></div><div class="tr-review-list">${rows.length ? rows.map((item) => `<article><header><span><b>${esc(item.kindLabel)}</b><strong>${item.authorId === 'user' ? '我' : esc(characters.find((character) => character.id === item.authorId)?.name || '共读者')}</strong></span><time>${new Date(item.createdAt).toLocaleDateString('zh-CN')}</time></header>${item.quote ? `<blockquote>${esc(item.quote)}</blockquote>` : ''}${item.text ? `<p>${esc(item.text)}</p>` : ''}</article>`).join('') : emptyState('这里还没有内容')}</div></main>`;
  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-tr-review-scope]').forEach((button) => button.addEventListener('click', () => navigate('together-reading', { ...params, view: 'reviews', scope: button.getAttribute('data-tr-review-scope') }, true)));
  container.querySelector('[data-tr-new-review]')?.addEventListener('click', async () => {
    const text = await openTextComposer({
      title: actionScope === 'paragraph' ? '写段评' : actionScope === 'book' ? '写书评' : '写章评',
      quote: actionScope === 'paragraph' ? focusedQuote : '',
      placeholder: actionScope === 'paragraph' ? '这段让你想到什么？' : '写下完整一点的评价',
    });
    if (!text) return;
    await addReadingReview(book.id, {
      scope: actionScope,
      chapterId: chapter?.id || '',
      paragraphIndex: focusedParagraphIndex ?? 0,
      quote: actionScope === 'paragraph' ? focusedQuote : '',
      text,
    });
    showToast('评价已保存');
    renderReviews(container, params);
  });
  container.querySelector('[data-tr-generate-review]')?.addEventListener('click', async (event) => {
    if (!state.participantIds.length) { showToast('先在书籍详情选择一起读的人'); return; }
    const button = event.currentTarget;
    button.disabled = true;
    try {
      let generatedCount = 0;
      if (actionScope === 'paragraph') {
        const comments = await generateReadingRangeComments({
          book,
          state,
          chapter,
          paragraphs: [{ paragraphIndex: focusedParagraphIndex, text: chapter.paragraphs[focusedParagraphIndex] || focusedQuote }],
          characters,
          trigger: 'supplement',
          maxComments: Math.min(4, Math.max(1, state.participantIds.length)),
        });
        await saveRangeComments(book, state, chapter, comments);
        generatedCount = comments.length;
      } else {
        const result = await addReviewReplies(book, state, {
          scope: actionScope,
          chapterId: chapter?.id || '',
          triggerKind: 'independent',
          text: '',
        }, characters);
        generatedCount = result.replies.length;
      }
      showToast(generatedCount
        ? actionScope === 'paragraph' ? `补了 ${generatedCount} 条回复` : actionScope === 'chapter' ? 'TA 的章评已经写好了' : 'TA 的书评已经写好了'
        : '共读者这次没有留下评价');
      renderReviews(container, params);
    } catch (error) {
      showToast(`评价生成失败：${error?.message || '请检查聊天 API'}`, 7000);
    } finally {
      button.disabled = false;
    }
  });
}

function sanitizeCardCss(css = '') {
  return String(css || '')
    .replace(/@import[\s\S]*?;/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/position\s*:\s*fixed/gi, 'position: absolute')
    .slice(0, 20_000);
}

async function generateCardEcho(book, quote, character, mode) {
  const characterCards = readingCharacterCards(character ? [character] : []);
  const raw = await chat([
    {
      role: 'system',
      content: `你是${character?.name || '共读者'}。必须完整服从下面的角色卡与语料，不得用通用文艺腔覆盖人设。\n${characterCards}\n\n你刚和用户读完一段文字，要留下一张很自然的阅读笺。可以引用原句，也可以化用；外文原句必须保留语言，不伪造作者译文。不要使用“我的感悟、想对你说、治愈、岁月静好”等模板词，不必浪漫，普通作品不要硬改成情诗。只输出 JSON：{"echo":"一到三句角色自己的话","title":"极短落款标题"}`,
    },
    { role: 'user', content: `书名：${book.title}\n作者：${book.author}\n模式：${mode}\n选句：${quote}` },
  ], { stream: false, temperature: 0.86, auditContext: { operation: 'together-reading-card', trigger: 'reading-card', initiator: 'user' } });
  return parseJsonObject(raw);
}

function cardMarkup({ book, mode, quote, translation, echo, material }) {
  const background = material ? `background-image:linear-gradient(rgba(255,255,255,.78),rgba(255,255,255,.78)),url('${material}')` : '';
  return `<article class="reading-card" style="${background}"><small class="reading-card-kind">${mode === 'quote' ? '原句' : mode === 'transcreation' ? '化用' : '原句 · 回声'}</small>${mode !== 'transcreation' && quote ? `<blockquote>${esc(quote)}</blockquote>` : ''}${translation ? `<p class="reading-card-translation">${esc(translation)}</p>` : ''}${echo ? `<p class="reading-card-echo">${esc(echo)}</p>` : ''}<footer><span>${esc(book.title)}</span><time>${new Date().toLocaleDateString('zh-CN')}</time></footer></article>`;
}

async function readingCardPngBlob({ book, mode, quote, translation, echo, material, customCss }) {
  const width = 900;
  const height = 1200;
  const baseCss = `.reading-card{box-sizing:border-box;width:${width}px;height:${height}px;padding:112px 104px 86px;background:#f8f8f5 center/cover;color:#1c211f;font-family:"Songti SC","Noto Serif SC",serif;display:flex;flex-direction:column}.reading-card-kind{font:500 22px/1.5 sans-serif;letter-spacing:.22em;color:#49665c}.reading-card blockquote{margin:94px 0 0;font-size:48px;line-height:1.8;font-weight:500}.reading-card-translation{font-size:26px;line-height:1.8;color:#686d69}.reading-card-echo{margin-top:auto;font-size:34px;line-height:1.75;border-left:3px solid #49665c;padding-left:30px}.reading-card footer{display:flex;justify-content:space-between;margin-top:80px;padding-top:28px;border-top:1px solid rgba(30,40,35,.2);font:22px/1.5 sans-serif;color:#676d69}`;
  const markup = cardMarkup({ book, mode, quote, translation, echo, material });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${baseCss}${sanitizeCardCss(customCss)}</style>${markup}</div></foreignObject></svg>`;
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('卡片渲染失败')); image.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('卡片导出失败')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

async function renderCardStudio(container, params = {}) {
  const book = await getReadingBook(params.bookId);
  if (!book) { back(); return; }
  const [state, characters] = await Promise.all([getReadingState(book.id), listCharacters({ excludeAnonNpc: true }).catch(() => [])]);
  let mode = ['quote', 'transcreation', 'quote_echo'].includes(params.mode) ? params.mode : 'quote_echo';
  let quote = String(params.quote || '').trim();
  let translation = '';
  let echo = '';
  let material = '';
  let customCss = '';
  let selectedCharacter = characters.find((character) => state.participantIds.includes(character.id)) || characters[0] || null;

  const paint = () => {
    container.className = 'page tr-page tr-card-page';
    container.innerHTML = `<header class="tr-page-head"><button type="button" data-back>${icon('back')}</button><h1>阅读卡片</h1><button type="button" data-tr-card-save>${icon('download')}</button></header><main class="tr-card-scroll"><div class="tr-card-preview" data-tr-card-preview></div><div class="tr-card-modes">${[['quote', '引用'], ['transcreation', '化用'], ['quote_echo', '引用＋回声']].map(([id, label]) => `<button type="button" class="${mode === id ? 'is-active' : ''}" data-tr-card-mode="${id}">${label}</button>`).join('')}</div><label><span>原句</span><textarea data-tr-card-quote>${esc(quote)}</textarea></label><label><span>译文（可选）</span><textarea data-tr-card-translation>${esc(translation)}</textarea></label><label><span>回声 / 化用</span><textarea data-tr-card-echo>${esc(echo)}</textarea></label><div class="tr-card-actions"><button type="button" data-tr-card-character>${selectedCharacter ? characterAvatarHtml(selectedCharacter, { className: 'tr-card-character-avatar' }) : icon('roleSay')}<span>${esc(selectedCharacter?.name || '选择角色')}</span></button><button type="button" data-tr-card-generate>${icon('sparkle')}<span>让 TA 留一句</span></button><button type="button" data-tr-card-material>${icon('image')}<span>添加素材</span></button></div><details class="tr-card-css"><summary>自定义 CSS</summary><textarea data-tr-card-css spellcheck="false" placeholder=".reading-card { ... }">${esc(customCss)}</textarea></details></main>`;
    const preview = container.querySelector('[data-tr-card-preview]');
    const root = preview.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{display:block}.reading-card{box-sizing:border-box;aspect-ratio:3/4;width:100%;padding:38px 34px 28px;background:#f8f8f5 center/cover;color:#1c211f;font-family:"Songti SC","Noto Serif SC",serif;display:flex;flex-direction:column;box-shadow:0 14px 42px rgba(16,24,20,.12)}.reading-card-kind{font:500 11px/1.5 sans-serif;letter-spacing:.2em;color:#49665c}.reading-card blockquote{margin:28px 0 0;font-size:22px;line-height:1.8}.reading-card-translation{font-size:13px;line-height:1.7;color:#686d69}.reading-card-echo{margin-top:auto;font-size:16px;line-height:1.75;border-left:2px solid #49665c;padding-left:14px}.reading-card footer{display:flex;justify-content:space-between;margin-top:26px;padding-top:12px;border-top:1px solid rgba(30,40,35,.2);font:11px/1.5 sans-serif;color:#676d69}${sanitizeCardCss(customCss)}</style>${cardMarkup({ book, mode, quote, translation, echo, material })}`;
    bind();
  };

  const syncFields = () => {
    quote = String(container.querySelector('[data-tr-card-quote]')?.value || '').trim();
    translation = String(container.querySelector('[data-tr-card-translation]')?.value || '').trim();
    echo = String(container.querySelector('[data-tr-card-echo]')?.value || '').trim();
    customCss = String(container.querySelector('[data-tr-card-css]')?.value || '');
  };
  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelectorAll('[data-tr-card-mode]').forEach((button) => button.addEventListener('click', () => { syncFields(); mode = button.getAttribute('data-tr-card-mode'); paint(); }));
    container.querySelectorAll('textarea').forEach((area) => area.addEventListener('change', () => { syncFields(); paint(); }));
    container.querySelector('[data-tr-card-character]')?.addEventListener('click', async () => {
      if (!characters.length) { showToast('先在通讯录添加角色'); return; }
      const id = await openParticipantPicker({ title: '由谁留下这张笺', items: characters, searchable: true });
      if (!id) return;
      selectedCharacter = characters.find((character) => character.id === id) || null;
      paint();
    });
    container.querySelector('[data-tr-card-generate]')?.addEventListener('click', async (event) => {
      syncFields();
      if (!selectedCharacter) { showToast('先选择一位角色'); return; }
      if (!quote && mode !== 'transcreation') { showToast('先放入一句原文'); return; }
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const generated = await generateCardEcho(book, quote, selectedCharacter, mode);
        echo = String(generated.echo || '').trim();
        showToast('TA 留下了一句话');
        paint();
      } catch (error) { showToast(error?.message || '生成失败'); }
    });
    container.querySelector('[data-tr-card-material]')?.addEventListener('click', () => pickOneFile({ accept: 'image/*', onFile: async (file) => { material = await imageFileToCover(file); paint(); } }));
    container.querySelector('[data-tr-card-save]')?.addEventListener('click', async () => {
      syncFields();
      await saveReadingCard(book.id, { mode, characterId: selectedCharacter?.id || '', quote, translation, echo, material, customCss: sanitizeCardCss(customCss) });
      try {
        const blob = await readingCardPngBlob({ book, mode, quote, translation, echo, material, customCss });
        const result = await downloadBlob(blob, `${book.title}-阅读卡片.png`, { mimeType: 'image/png', directory: 'pictures' });
        showToast(describeDownloadResult(result));
      } catch (error) { showToast(error?.message || '卡片已收藏，但图片保存失败'); }
    });
  }
  paint();
  if (params.auto === '1' && selectedCharacter && quote) {
    generateCardEcho(book, quote, selectedCharacter, mode).then((generated) => { echo = String(generated.echo || '').trim(); paint(); }).catch((error) => showToast(error?.message || '留笺生成失败'));
  }
}

export default async function render(container, params = {}) {
  window.__trReaderCleanup?.();
  const view = String(params.view || 'library');
  if (view === 'book') return renderBookDetail(container, params);
  if (view === 'reader') return renderReader(container, params);
  if (view === 'reviews') return renderReviews(container, params);
  if (view === 'card') return renderCardStudio(container, params);
  return renderLanding(container, params);
}
