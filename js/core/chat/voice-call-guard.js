import { splitSpokenSentences } from '../speech-segmentation.js';
import {
  isChineseDialectLanguageHint,
  looksLikeChineseDialectText,
  looksLikeChineseTranslation,
} from '../translation-utils.js';

const ACTIVE_CALL_STATES = new Set(['active', 'calling', 'ongoing', 'connected']);

export function resolveVoiceCallReplyDisplayMode(value, options = {}) {
  const mode = String(value || '').trim();
  if (mode === 'single' || mode === 'segments') return mode;
  return options.translationActive === true ? 'single' : 'segments';
}

export function isActiveVoiceCallMessage(message = null) {
  if (!message || message.deleted || message.recalled || String(message.type || '') !== 'voiceCall') {
    return false;
  }
  const rawState = String(message.metadata?.callState || message.metadata?.state || '')
    .trim()
    .toLowerCase();
  return ACTIVE_CALL_STATES.has(rawState)
    || /^(?:接听|通话中|正在通话|继续)$/.test(rawState);
}

export function hasActiveVoiceCall(messages = []) {
  return (Array.isArray(messages) ? messages : []).some(isActiveVoiceCallMessage);
}

/**
 * 实时通话不像普通气泡那样逐句落成独立 message，需要在场景指令里单独携带本通电话的轮次。
 * 轮次数量跟随聊天上下文深度，同时设字符预算，避免一通很长的电话挤掉角色卡与记忆。
 */
export function selectVoiceCallContextTurns(entries = [], options = {}) {
  const source = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      role: entry?.role === 'user' ? 'user' : 'assistant',
      text: String(entry?.text || '').trim(),
    }))
    .filter((entry) => entry.text);
  const rawDepth = Number(options.contextDepth);
  const maxTurns = Number.isFinite(rawDepth) && rawDepth > 0
    ? Math.max(4, Math.min(500, Math.floor(rawDepth)))
    : 100;
  const rawBudget = Number(options.charBudget);
  const charBudget = Number.isFinite(rawBudget) && rawBudget > 0
    ? Math.max(1000, Math.floor(rawBudget))
    : 12000;
  const selected = [];
  let usedChars = 0;
  for (let index = source.length - 1; index >= 0 && selected.length < maxTurns; index -= 1) {
    const entry = source[index];
    const cost = entry.text.length + 16;
    if (selected.length && usedChars + cost > charBudget) break;
    selected.unshift(entry);
    usedChars += cost;
  }
  return selected;
}

/**
 * 模型偶尔会把仅供上下文识别的通话气泡标签照抄到普通回复里。
 * 这里只移除消息开头的内部标签/说明，正文原样保留。
 */
export function stripLeakedVoiceCallContextPrefix(text = '') {
  let clean = String(text || '');
  const header = /^\s*[\[【]\s*聊天软件\s*(?:语音|视频)通话气泡\s*(?:[｜|][^\]】\r\n]*)?[\]】]\s*/u;
  const explanation = /^\s*[（(]\s*电话里双方说过的话[\s\S]*?按电话里说过的自然接话。\s*[）)]\s*/u;
  clean = clean.replace(header, '');
  clean = clean.replace(explanation, '');
  return clean.trim();
}

function voiceCallProtocolSpeech(text = '') {
  const source = String(text || '').trim();
  const markerDetected = /<<<(?:END_)?(?:MARSHMALLOW_CHAT_V2|GUGU_CHAT_V2)>>>/i.test(source);
  let eventDetected = false;
  const spoken = [];
  const lines = source
    .replace(/<<<(?:END_)?(?:MARSHMALLOW_CHAT_V2|GUGU_CHAT_V2)>>>/gi, '\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!/^\{[\s\S]*\}$/.test(line)) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const type = String(event?.t || event?.type || '').trim().toLowerCase();
    if (!type) continue;
    eventDetected = true;
    if (type !== 'msg' && type !== 'voice') continue;
    const body = String(event?.body || event?.text || event?.content || '').trim();
    if (body) spoken.push(body);
  }
  return {
    detected: markerDetected || eventDetected,
    text: spoken.join('\n').trim(),
  };
}

/**
 * 有些模型会无视“只输出口语”，把台词包进普通 JSON 对象或数组。这里仅从
 * 明确的正文键、消息事件和台词容器中取值；analysis/state/error 等内部字段
 * 不会被展示或送进 TTS。
 */
function structuredVoiceCallSpeech(value, depth = 0) {
  if (value == null || depth > 6) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => structuredVoiceCallSpeech(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof value !== 'object') return '';

  const type = String(value.t || value.type || '').trim().toLowerCase();
  if (['state', 'narration', 'action', 'analysis', 'reasoning', 'thinking', 'error'].includes(type)) {
    return '';
  }
  if (['msg', 'message', 'voice', 'speech', 'text', 'reply', 'output_text'].includes(type)) {
    for (const key of ['body', 'text', 'content', 'message', 'output_text', 'reply', 'speech']) {
      const spoken = structuredVoiceCallSpeech(value[key], depth + 1);
      if (spoken) return spoken;
    }
    return '';
  }

  for (const key of ['voices', 'lines', 'messages', 'items', 'replies', 'segments']) {
    if (!Array.isArray(value[key])) continue;
    const spoken = structuredVoiceCallSpeech(value[key], depth + 1);
    if (spoken) return spoken;
  }

  // 无事件类型的常见包装。带 error/code 的接口错误壳不当作角色台词。
  if ((value.error != null || value.code != null) && !('text' in value || 'body' in value || 'reply' in value)) {
    return '';
  }
  for (const key of ['text', 'body', 'content', 'message', 'output_text', 'reply', 'dialogue', 'line', 'speech']) {
    const spoken = structuredVoiceCallSpeech(value[key], depth + 1);
    if (spoken) return spoken;
  }
  return '';
}

function countVoiceCallChars(text = '', re) {
  return (String(text || '').match(re) || []).length;
}

function translationMarkState(text = '') {
  let opened = false;
  let pairs = 0;
  for (const char of String(text || '')) {
    if (char === '〔') {
      if (opened) return { ok: false, pairs, reason: 'nested-translation-marks' };
      opened = true;
      continue;
    }
    if (char !== '〕') continue;
    if (!opened) return { ok: false, pairs, reason: 'orphan-translation-close' };
    opened = false;
    pairs += 1;
  }
  if (opened) return { ok: false, pairs, reason: 'orphan-translation-open' };
  return { ok: true, pairs, reason: '' };
}

function voiceCallSpokenTextForLanguageCheck(text = '', { allowStageDirections = false } = {}) {
  let spoken = String(text || '').replace(/〔[^〔〕]*〕/g, ' ');
  if (allowStageDirections) {
    spoken = spoken.replace(/[（(][^（）()\r\n]{1,160}[）)]/g, ' ');
  }
  return spoken.replace(/\s+/g, ' ').trim();
}

/**
 * 外语通话会把中文翻译放在 〔〕 中。括号掉一边时不能继续展示或送进 TTS，
 * 否则孤立的中文译文会被当成口语，形成中英/中日混读。
 */
export function validateVoiceCallTranslationText(text = '', options = {}) {
  if (options.translationActive !== true) return { ok: true, reason: '' };
  const marks = translationMarkState(text);
  if (!marks.ok) return marks;

  const spoken = voiceCallSpokenTextForLanguageCheck(text, options);
  const language = String(options.translationLanguage || options.language || '').trim();
  const isChineseLanguage = /中文|汉语|漢語|普通话|普通話|国语|國語/u.test(language);
  const isJapaneseLanguage = /日语|日本语/u.test(language);
  if (isChineseLanguage) return { ok: true, pairs: marks.pairs, reason: '' };
  const isDialectLanguage = isChineseDialectLanguageHint(language);
  const hanCount = countVoiceCallChars(spoken, /[\u3400-\u9fff]/g);
  if (!isDialectLanguage && !isJapaneseLanguage && language && hanCount >= 2) {
    return { ok: false, pairs: marks.pairs, reason: 'foreign-voice-contains-chinese' };
  }
  if (marks.pairs < 1) {
    return { ok: false, pairs: marks.pairs, reason: 'missing-translation-marks' };
  }

  if (options.sentenceTranslationRequired === true) {
    const translationCoverageText = options.allowStageDirections === true
      ? String(text || '').replace(/[（(][^（）()\r\n]{1,160}[）)]/g, ' ')
      : String(text || '');
    const missingSentenceTranslation = splitSpokenSentences(translationCoverageText).some((segment) => {
      const segmentSpoken = voiceCallSpokenTextForLanguageCheck(segment, options);
      return segmentSpoken && !/〔[^〔〕]+〕/u.test(segment);
    });
    if (missingSentenceTranslation) {
      return { ok: false, pairs: marks.pairs, reason: 'missing-sentence-translation' };
    }
  }

  if (isDialectLanguage) {
    const translations = [...String(text || '').matchAll(/〔([^〔〕]+)〕/g)]
      .map((match) => String(match[1] || '').trim())
      .filter(Boolean);
    if (translations.some((translation) => (
      !looksLikeChineseTranslation(translation)
      || looksLikeChineseDialectText(translation, language)
    ))) {
      return { ok: false, pairs: marks.pairs, reason: 'dialect-translation-not-mandarin' };
    }
    return { ok: true, pairs: marks.pairs, reason: '' };
  }
  if (isJapaneseLanguage) return { ok: true, pairs: marks.pairs, reason: '' };

  // 语种留空时由 AI 自行判断；有假名按日语放行，其余“明显外文 + 一段中文”仍拦截。
  const kanaCount = countVoiceCallChars(spoken, /[\u3040-\u30ff]/g);
  const foreignLetterCount = countVoiceCallChars(
    spoken,
    /[A-Za-z\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f\uac00-\ud7af]/g,
  );
  if (!language && kanaCount === 0 && hanCount >= 4 && foreignLetterCount >= 8) {
    return { ok: false, pairs: marks.pairs, reason: 'mixed-voice-with-unmarked-chinese' };
  }
  return { ok: true, pairs: marks.pairs, reason: '' };
}

/**
 * 通话输出会直接显示并送进 TTS：协议事件可安全提取口语；其它 JSON/空回复直接失败，
 * 不能把内部结构原样展示或朗读给用户，也不能静默补发模型请求。
 */
export function normalizeVoiceCallReplyText(text = '', options = {}) {
  let clean = String(text || '')
    .replace(/```(?:json|javascript|js|text)?\s*([\s\S]*?)```/gi, '$1')
    .trim();
  clean = stripLeakedVoiceCallContextPrefix(clean);
  const protocol = voiceCallProtocolSpeech(clean);
  if (protocol.detected) {
    if (!protocol.text) {
      return { ok: false, text: '', repaired: false, reason: 'protocol-without-speech' };
    }
    const translationCheck = validateVoiceCallTranslationText(protocol.text, options);
    return translationCheck.ok
      ? { ok: true, text: protocol.text, repaired: true, reason: 'protocol-speech-extracted' }
      : { ok: false, text: '', repaired: false, reason: translationCheck.reason };
  }
  if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(clean)) {
    try {
      const structuredText = structuredVoiceCallSpeech(JSON.parse(clean));
      if (!structuredText) {
        return { ok: false, text: '', repaired: false, reason: 'unexpected-json' };
      }
      const translationCheck = validateVoiceCallTranslationText(structuredText, options);
      return translationCheck.ok
        ? { ok: true, text: structuredText, repaired: true, reason: 'structured-speech-extracted' }
        : { ok: false, text: '', repaired: false, reason: translationCheck.reason };
    } catch (_) {
      // 自然口语可能以括号开头；不是合法 JSON 时继续按正文处理。
    }
  }
  const targetName = String(options.targetName || '').trim();
  if (targetName) {
    const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean.replace(new RegExp(`^\\s*${escaped}\\s*[:：]\\s*`, 'u'), '').trim();
  }
  clean = clean.replace(/^\s*(?:assistant|ai|回复)\s*[:：]\s*/i, '').trim();
  if (!clean) return { ok: false, text: '', repaired: false, reason: 'empty' };
  const translationCheck = validateVoiceCallTranslationText(clean, options);
  if (!translationCheck.ok) {
    return { ok: false, text: '', repaired: false, reason: translationCheck.reason };
  }
  return { ok: true, text: clean, repaired: false, reason: '' };
}
