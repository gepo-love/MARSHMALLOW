/**
 * 叙事正文里的翻译标记：AI 用 〔中文翻译〕 就地标出外语/方言片段的中文意思，
 * 渲染时转成「译」按钮 + 可展开的译文，不再让括号裸露在正文里。
 * 供线下时光机、约会档案、旅行 char、小剧场卡片等叙事类展示复用。
 */

import {
  handleTranslationToggleClick,
  isValidUserFacingTranslation,
  looksLikeChineseDialectText,
  looksLikeChineseTranslation,
  messageLikelyNeedsTranslation,
} from './translation-utils.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return esc(value).replace(/`/g, '&#96;');
}

const TRANSLATION_MARK_RE = /〔([^〔〕]{1,3000})〕/g;

function repairUnclosedTranslationMarks(value = '') {
  const source = String(value || '');
  let out = '';
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === '〕') {
      index += 1;
      continue;
    }
    if (char !== '〔') {
      out += char;
      index += 1;
      continue;
    }
    const close = source.indexOf('〕', index + 1);
    const nextOpen = source.indexOf('〔', index + 1);
    if (close >= 0 && (nextOpen < 0 || close < nextOpen)) {
      out += source.slice(index, close + 1);
      index = close + 1;
      continue;
    }
    const paragraphEnd = source.indexOf('\n\n', index + 1);
    const searchEnd = paragraphEnd >= 0 ? paragraphEnd : source.length;
    const tail = source.slice(index + 1, searchEnd);
    const foreignResume = tail.search(/[\u3040-\u30ff\uac00-\ud7afA-Za-z]/u);
    const sentenceEnd = tail.search(/[。！？!?](?:[」』”’"']|\s|$)/u);
    let boundary = searchEnd;
    if (foreignResume > 1) boundary = index + 1 + foreignResume;
    else if (sentenceEnd >= 0) boundary = index + 1 + sentenceEnd + 1;
    out += `〔${source.slice(index + 1, boundary)}〕`;
    index = boundary;
  }
  return out;
}

function wrapOrphanChineseTranslationSentences(value = '') {
  const source = String(value || '');
  const hasForeignSource = /[\u3040-\u30ff\uac00-\ud7afA-Za-z]/u.test(source);
  if (!hasForeignSource || !/[〔〕]/u.test(source)) return source;
  let out = '';
  let cursor = 0;
  const paired = /〔[^〔〕]*〕/gu;
  let match;
  const wrapOutside = (chunk) => {
    const outside = String(chunk || '');
    // 只依据当前这段未标记文本判断，不能让同一自然段里别处的 Daddy 等英文词
    // 把纯汉字的粤语原句误判成“脱落译文”。
    if (!/[\u3040-\u30ff\uac00-\ud7afA-Za-z]/u.test(outside)) return outside;
    return outside.replace(
      /([^。！？!?\n]+[。！？!?]?)/gu,
      (sentence) => {
        const body = sentence.trim();
        if (!body || /[\u3040-\u30ff\uac00-\ud7afA-Za-z]/u.test(body)) return sentence;
        if (!looksLikeChineseTranslation(body) || looksLikeChineseDialectText(body)) return sentence;
        const leading = sentence.match(/^\s*/u)?.[0] || '';
        const trailing = sentence.match(/\s*$/u)?.[0] || '';
        return `${leading}〔${body}〕${trailing}`;
      },
    );
  };
  while ((match = paired.exec(source))) {
    out += wrapOutside(source.slice(cursor, match.index));
    out += match[0];
    cursor = paired.lastIndex;
  }
  return out + wrapOutside(source.slice(cursor));
}

/**
 * 修复长叙事里偶发缺失的翻译右括号，并把外语正文间脱落的纯中文译句
 * 收回翻译标记。只在文本本身已经出现翻译标记和明确外语字符时启用，
 * 避免误伤普通中文正文。
 */
export function repairNarrationTranslationMarkup(text = '', options = {}) {
  const repaired = repairUnclosedTranslationMarks(text);
  return options.wrapOrphanSentences === false
    ? repaired
    : wrapOrphanChineseTranslationSentences(repaired);
}

/** 供 TTS 等只该读外语原文的场景使用：整段去掉〔中文翻译〕标记，只留外语正文。 */
export function stripTranslationMarks(text = '') {
  return repairNarrationTranslationMarkup(text)
    // 若模型误把可辨识的中文方言原句放进译文标记，语音与导出仍应保住原文。
    .replace(/〔([^〔〕]*)〕/g, (_match, marked) => (
      looksLikeChineseDialectText(marked) ? marked : ''
    ))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？,.!?])/g, '$1')
    .trim();
}

/** 把一段叙事正文（单个自然段/句子）转成带内联翻译入口的 HTML；本身负责转义。 */
export function renderNarrationTextWithTranslations(text = '', options = {}) {
  const str = repairNarrationTranslationMarkup(text, options);
  TRANSLATION_MARK_RE.lastIndex = 0;
  if (!TRANSLATION_MARK_RE.test(str)) return esc(str);
  TRANSLATION_MARK_RE.lastIndex = 0;
  let out = '';
  let lastIndex = 0;
  let match;
  while ((match = TRANSLATION_MARK_RE.exec(str))) {
    out += esc(str.slice(lastIndex, match.index));
    const foreignSnippet = str.slice(lastIndex, match.index).trim();
    const translation = match[1].trim();
    const sourceHint = foreignSnippet || str;
    const standaloneTranslation = !foreignSnippet
      && looksLikeChineseTranslation(translation)
      && !looksLikeChineseDialectText(translation);
    const hasMeaningfulTranslationText = /[\p{L}\p{N}]/u.test(translation);
    if (translation && hasMeaningfulTranslationText
      && (standaloneTranslation || isValidUserFacingTranslation(sourceHint, translation) || messageLikelyNeedsTranslation(sourceHint))) {
      out += `<button type="button" class="narration-translate-btn" data-translation-toggle ${standaloneTranslation ? 'data-translation-static ' : ''}data-translation-source="${escAttr(standaloneTranslation ? '' : (foreignSnippet || sourceHint))}" aria-expanded="false">译</button><span class="narration-translation" hidden>${esc(translation)}</span>`;
    } else {
      // 标记内容不满足译文条件时保留正文，避免模型误把方言原句放进〔〕后被前端吞掉。
      out += esc(translation || match[0]);
    }
    lastIndex = TRANSLATION_MARK_RE.lastIndex;
  }
  out += esc(str.slice(lastIndex));
  return out;
}

/** 点击「译」按钮展开/收起紧跟其后的译文；`chat-bubble-translation` 是气泡翻译复用的同一套开关逻辑。 */
export function toggleTranslationElement(btn) {
  const wrap = btn?.nextElementSibling;
  if (!wrap || !(wrap.classList.contains('chat-bubble-translation') || wrap.classList.contains('narration-translation'))) return false;
  const expanded = !wrap.hidden;
  wrap.hidden = expanded;
  btn.setAttribute('aria-expanded', String(!expanded));
  return true;
}

/** 在容器上绑定一次委托点击，处理容器内所有 [data-translation-toggle] 按钮。 */
export function bindNarrationTranslationToggle(container, options = {}) {
  if (!container || container.__narrationTranslationBound) return;
  container.__narrationTranslationBound = true;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-translation-toggle]');
    if (!btn || !container.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.hasAttribute('data-translation-static')) {
      toggleTranslationElement(btn);
      return;
    }
    const sourceText = String(btn.getAttribute('data-translation-source') || '').trim();
    const translationText = String(btn.nextElementSibling?.textContent || '').trim();
    Promise.resolve(handleTranslationToggleClick(btn, {
      sourceText,
      translationText,
      languageHint: String(options.languageHint || btn.getAttribute('data-translation-lang') || '').trim(),
      onRepaired: typeof options.onRepaired === 'function'
        ? (translation) => options.onRepaired(translation, { button: btn, sourceText })
        : undefined,
    })).then((ok) => {
      if (ok === false && typeof options.onFailed === 'function') options.onFailed({
        button: btn,
        sourceText,
        message: String(btn.getAttribute('data-translation-failure-message') || '').trim(),
      });
    }).catch(() => {
      if (typeof options.onFailed === 'function') options.onFailed({
        button: btn,
        sourceText,
        message: String(btn.getAttribute('data-translation-failure-message') || '').trim(),
      });
    });
  });
}
