const SENTENCE_END_RE = /[。！？!?；;…]/u;
const SOFT_BREAK_RE = /[，,、：:\s]/u;
const TRANSLATION_PAIR_RE = /〔[^〔〕]*〕/g;
const WORD_SCRIPT_RE = /[A-Za-z\u0370-\u052f\u0600-\u06ff]/g;
const DENSE_SCRIPT_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g;

function isAsciiFullStopBoundary(text = '', index = 0) {
  if (text[index] !== '.') return false;
  const previous = text[index - 1] || '';
  const next = text[index + 1] || '';
  if (/\d/.test(previous) && /\d/.test(next)) return false;
  if (/[A-Za-z]/.test(previous) && /[A-Za-z]/.test(next)) return false;
  return true;
}

function isSentenceEnd(text = '', index = 0) {
  return SENTENCE_END_RE.test(text[index] || '') || isAsciiFullStopBoundary(text, index);
}

export function spokenSourceLength(value = '') {
  return String(value || '').replace(TRANSLATION_PAIR_RE, '').trim().length;
}

/**
 * 拉丁、西里尔与阿拉伯文字按“字符”计数时天然比中日韩文字更长。
 * 给这些按词书写的语言更宽的长度预算，避免一句正常口语被硬切成许多小块。
 */
export function resolveSpokenSegmentMax(value = '', baseMax = 58) {
  const source = String(value || '').replace(TRANSLATION_PAIR_RE, '');
  const wordChars = (source.match(WORD_SCRIPT_RE) || []).length;
  const denseChars = (source.match(DENSE_SCRIPT_RE) || []).length;
  if (wordChars >= 12 && wordChars > denseChars * 1.5) {
    return Math.round(baseMax * 1.85);
  }
  return baseMax;
}

/**
 * 句末标点后的 〔中文译文〕 属于前一句：扫描时延迟落段，直到译文右括号也收入。
 * 译文内部的标点永远不参与拆段，避免界面出现孤立的 〔 或 〕。
 */
export function splitSpokenSentences(value = '') {
  const text = String(value || '').replace(/\r\n/g, '\n');
  const out = [];
  const flushParagraph = (paragraph = '') => {
    let buffer = '';
    let insideTranslation = false;
    let pendingBoundary = false;
    const flush = () => {
      const next = buffer.trim();
      if (next) out.push(next);
      buffer = '';
      pendingBoundary = false;
    };
    for (let index = 0; index < paragraph.length; index += 1) {
      const char = paragraph[index];
      if (pendingBoundary && !insideTranslation) {
        if (char === '〔') {
          buffer += char;
          insideTranslation = true;
          continue;
        }
        if (/\s/u.test(char) || isSentenceEnd(paragraph, index)) {
          buffer += char;
          continue;
        }
        flush();
      }
      buffer += char;
      if (char === '〔') {
        insideTranslation = true;
      } else if (char === '〕') {
        insideTranslation = false;
      } else if (!insideTranslation && isSentenceEnd(paragraph, index)) {
        pendingBoundary = true;
      }
    }
    flush();
  };
  for (const paragraph of text.split(/\n+/).map((part) => part.trim()).filter(Boolean)) {
    flushParagraph(paragraph);
  }
  return out;
}

function joinSpeechParts(left = '', right = '') {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a) return b;
  if (!b) return a;
  const separator = /[A-Za-z\u0370-\u052f\u0600-\u06ff\d]$/u.test(a)
    && /^[A-Za-z\u0370-\u052f\u0600-\u06ff\d]/u.test(b)
    ? ' '
    : '';
  return `${a}${separator}${b}`;
}

function splitOversizedUnit(value = '', baseMax = 58) {
  let rest = String(value || '').trim();
  const maxChars = resolveSpokenSegmentMax(rest, baseMax);
  if (!rest || spokenSourceLength(rest) <= maxChars) return rest ? [rest] : [];

  // 无法在不知道译文对应范围的情况下安全从 〔…〕 前后硬切；宁可让单段稍长。
  if (/〔|〕/.test(rest)) return [rest];

  const chunks = [];
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let softCut = -1;
    for (let index = window.length - 1; index >= 0; index -= 1) {
      if (SOFT_BREAK_RE.test(window[index])) {
        softCut = index;
        break;
      }
    }
    const cut = softCut >= Math.floor(maxChars * 0.55) ? softCut + 1 : maxChars;
    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * 通话、视频字幕与陪伴窗共用的多语言拆段器。
 * preserveParagraphIfFits 适合已经由模型给出 voices 数组的场景，优先尊重原段落边界。
 */
export function splitSpokenTextSegments(value = '', options = {}) {
  const baseMax = Math.max(24, Math.min(160, Number(options.maxChars) || 58));
  const maxSegments = Math.max(1, Math.min(24, Number(options.maxSegments) || 8));
  const mergeShortChars = Math.max(0, Number(options.mergeShortChars) || 0);
  const preserveParagraphIfFits = options.preserveParagraphIfFits === true;
  const packSentences = options.packSentences === true;
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const segments = [];
  for (const paragraph of text.split(/\n+/).map((part) => part.trim()).filter(Boolean)) {
    const paragraphMax = resolveSpokenSegmentMax(paragraph, baseMax);
    const units = preserveParagraphIfFits && spokenSourceLength(paragraph) <= paragraphMax
      ? [paragraph]
      : splitSpokenSentences(paragraph);
    for (const unit of units.flatMap((part) => splitOversizedUnit(part, baseMax))) {
      const previous = segments[segments.length - 1] || '';
      const combined = joinSpeechParts(previous, unit);
      const combinedMax = resolveSpokenSegmentMax(combined, baseMax);
      const canPack = previous && packSentences && spokenSourceLength(combined) <= combinedMax;
      const canMergeShort = previous
        && mergeShortChars > 0
        && spokenSourceLength(previous) < mergeShortChars
        && spokenSourceLength(combined) <= combinedMax;
      if (canPack || canMergeShort) segments[segments.length - 1] = combined;
      else segments.push(unit);
    }
  }

  if (segments.length <= maxSegments) return segments;
  return [
    ...segments.slice(0, maxSegments - 1),
    segments.slice(maxSegments - 1).reduce((joined, part) => joinSpeechParts(joined, part), ''),
  ];
}
