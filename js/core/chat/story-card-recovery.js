import { stripLeakedReasoning } from '../narration-sanitize.js';

const STORY_FIELDS = [
  'title',
  'summary',
  'paragraphs',
  'characters',
  'digest',
  'keyDialogues',
  'followupHook',
];

function decodeJsonStringFragment(value = '') {
  const raw = String(value || '');
  try {
    return JSON.parse(`"${raw.replace(/[\u0000-\u001f]/g, (char) => {
      if (char === '\n') return '\\n';
      if (char === '\r') return '\\r';
      if (char === '\t') return '\\t';
      return '';
    })}"`);
  } catch (_) {
    return raw
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
  }
}

function nextNonSpace(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function isFieldStringEnd(text, quoteIndex) {
  const cursor = nextNonSpace(text, quoteIndex + 1);
  if (cursor >= text.length || text[cursor] === '}') return true;
  if (text[cursor] !== ',') return false;
  const tail = text.slice(nextNonSpace(text, cursor + 1));
  return STORY_FIELDS.some((field) => new RegExp(`^"${field}"\\s*:`).test(tail));
}

function scanQuotedValue(text, start, isEnd) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"' && isEnd(text, index)) {
      return {
        value: decodeJsonStringFragment(text.slice(start + 1, index)),
        end: index + 1,
        complete: true,
      };
    }
  }
  return {
    value: decodeJsonStringFragment(text.slice(start + 1)),
    end: text.length,
    complete: false,
  };
}

function extractStringField(text, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(text);
  if (!match) return { value: '', complete: false, found: false };
  const start = match.index + match[0].length - 1;
  return { ...scanQuotedValue(text, start, isFieldStringEnd), found: true };
}

function extractStringArray(text, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*\\[`).exec(text);
  if (!match) return { values: [], complete: false, found: false };
  const values = [];
  let cursor = match.index + match[0].length;
  let complete = false;
  while (cursor < text.length) {
    cursor = nextNonSpace(text, cursor);
    if (text[cursor] === ']') {
      complete = true;
      break;
    }
    if (text[cursor] === ',') {
      cursor += 1;
      continue;
    }
    if (text[cursor] !== '"') break;
    const item = scanQuotedValue(text, cursor, (source, quoteIndex) => {
      const next = nextNonSpace(source, quoteIndex + 1);
      return next >= source.length || source[next] === ',' || source[next] === ']';
    });
    const value = String(item.value || '').trim();
    if (value) values.push(value);
    cursor = item.end;
    if (!item.complete) break;
  }
  return { values, complete, found: true };
}

function stripStoryThinking(raw = '') {
  let text = String(raw || '').replace(/^\uFEFF/, '');
  text = text
    .replace(/<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, '\n')
    .replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/gi, '\n');

  const customStart = text.search(/<<<THINKING>>>/i);
  if (customStart >= 0) {
    const after = text.slice(customStart).replace(/^<<<THINKING>>>/i, '');
    const visibleMatch = after.match(/(?:^|\n)\s*(?:```(?:json)?\s*)?(\{\s*"(?:title|summary|paragraphs)"\s*:)/i);
    text = visibleMatch
      ? `${text.slice(0, customStart)}${after.slice((visibleMatch.index || 0) + visibleMatch[0].indexOf(visibleMatch[1]))}`
      : text.slice(0, customStart);
  }

  text = text
    .replace(/<(?:think|thinking)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/^\s*```(?:json|markdown|md|text|plaintext|txt)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return text;
}

function looksLikeStoryJson(text = '') {
  const value = String(text || '').trim();
  return /^[{[]/.test(value)
    || /"(?:title|summary|paragraphs|characters|digest|followupHook)"\s*:/.test(value);
}

function safePlainStoryText(text = '') {
  if (!text || looksLikeStoryJson(text)) return '';
  const cleaned = stripLeakedReasoning(text).trim();
  if (!cleaned || looksLikeStoryJson(cleaned)) return '';
  if (/^(?:DIRECTIVE|CORE|TONE|PLAN|REQUIREMENTS?)\s*[:：]/im.test(cleaned)) return '';
  return cleaned;
}

/**
 * 保留失败原文，同时只把可识别的业务字段或普通正文交给卡片展示。
 * 这里不尝试补写缺失内容，也不会发起第二次模型请求。
 */
export function recoverStoryCardResponse(raw = '', failure = {}) {
  const rawResponse = String(raw || '').trim().slice(0, 120000);
  const visible = stripStoryThinking(rawResponse);
  const titleField = extractStringField(visible, 'title');
  const summaryField = extractStringField(visible, 'summary');
  const digestField = extractStringField(visible, 'digest');
  const hookField = extractStringField(visible, 'followupHook');
  const paragraphsField = extractStringArray(visible, 'paragraphs');
  const charactersField = extractStringArray(visible, 'characters');
  const dialoguesField = extractStringArray(visible, 'keyDialogues');
  const structured = [
    titleField,
    summaryField,
    digestField,
    hookField,
    paragraphsField,
    charactersField,
    dialoguesField,
  ].some((field) => field.found);
  const reason = String(failure?.reason || failure?.code || '').trim();
  const failureKind = String(failure?.jsonFailureKind || '').trim();
  const allowPlainFallback = reason !== 'upstream-content-refusal';

  let paragraphs = paragraphsField.values
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  let status = 'format-error';
  if (paragraphs.length || summaryField.value) {
    status = 'partial';
  } else if (!structured && allowPlainFallback) {
    const plain = safePlainStoryText(visible);
    if (plain) {
      paragraphs = visible
        .split(/\n\s*\n/)
        .map((part) => safePlainStoryText(part))
        .map((part) => part.trim())
        .filter(Boolean);
      status = paragraphs.length ? 'unformatted' : 'format-error';
    }
  }

  const summary = String(summaryField.value || paragraphs[0] || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const notice = status === 'partial'
    ? '本次返回可能未完成，已抢救可识别正文。'
    : status === 'unformatted'
      ? '模型未按格式返回，已保留可读正文。'
      : '模型有返回，但未形成可识别正文。';

  return {
    status,
    notice,
    title: String(titleField.value || (status === 'format-error' ? '小剧场未完成' : '小剧场')).trim(),
    summary,
    paragraphs,
    characters: charactersField.values.slice(0, 6),
    digest: String(digestField.value || summary).trim(),
    keyDialogues: dialoguesField.values.slice(0, 6),
    followupHook: String(hookField.value || '').trim(),
    rawResponse,
    failureReason: reason,
    failureKind,
  };
}
