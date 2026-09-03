import { chatForTask, getToolConfig } from './api.js';
import { normalizeTranslationProfile } from '../models/character.js';

const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/g;
const CJK_RE = /[\u4E00-\u9FFF]/g;
const HANGUL_RE = /[\uAC00-\uD7AF]/g;
const LATIN_RE = /[A-Za-z]/g;
const MINIMAX_PAREN_SOUND_RE = /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi;
const STANDARD_MANDARIN_HINT_RE = /(?:普通话|普通話|国语|國語|现代标准汉语|現代標準漢語|mandarin)/iu;
const CHINESE_DIALECT_HINT_RE = /(?:粤语|粵語|广东话|廣東話|广府话|廣府話|香港话|香港話|白话|白話|cantonese|吴语|吳語|上海话|上海話|苏州话|蘇州話|闽南语|閩南語|福建话|福建話|台语|臺語|潮汕话|潮州话|hokkien|客家话|客家話|hakka|四川话|四川話|川话|川話|重庆话|重慶話|东北话|東北話|河南话|河南話|山东话|山東話|陕西话|陝西話|方言|土话|土話)/iu;
const CANTONESE_HINT_RE = /(?:粤语|粵語|广东话|廣東話|广府话|廣府話|香港话|香港話|白话|白話|cantonese)/iu;
const WU_HINT_RE = /(?:吴语|吳語|上海话|上海話|苏州话|蘇州話)/u;
const MINNAN_HINT_RE = /(?:闽南语|閩南語|福建话|福建話|台语|臺語|潮汕话|潮州话|hokkien)/iu;
const HAKKA_HINT_RE = /(?:客家话|客家話|hakka)/iu;
const SICHUAN_HINT_RE = /(?:四川话|四川話|川话|川話|重庆话|重慶話)/u;
const NORTHEAST_HINT_RE = /(?:东北话|東北話)/u;
const CANTONESE_TEXT_RE = /(?:唔|冇|咁|佢|嘅|咗|喺|嚟|睇|畀|俾|噉|噃|啩|喎|啫|嗰|仲|搵|揾|諗|谂|啱|攞|嬲|靚|靓|邊度|边度|而家|得閒|得闲|乜嘢|乜野|點解|点解|係咪|系咪|幾時|几时|聽日|听日|琴日|尋日|寻日|傾偈|倾偈|同埋|返工|收工|落雨|食飯|食饭|飲茶|饮茶)/u;
const WU_TEXT_RE = /(?:侬|儂|阿拉|伊拉|勿要|哪能|啥体|啥體|老卵)/u;
const MINNAN_TEXT_RE = /(?:阮|恁|拢总|攏總|按怎|啥物|袂使|毋通|足濟|足济)/u;
const HAKKA_TEXT_RE = /(?:涯等|若等|佢兜|毋使|做麼个|做么个)/u;
const SICHUAN_TEXT_RE = /(?:莫得|要得|爪子|啥子|巴适|巴適|雄起|搞快点|搞快點|安逸得很)/u;
const NORTHEAST_TEXT_RE = /(?:整啥|咋整|嘎哈|干哈|埋汰|得劲|得勁|唠嗑|嘮嗑)/u;

/** 译文里偶发抄进的 MiniMax 性能标签；与 voice-tools.stripVoiceDisplayTags 同源，避免循环依赖 */
function stripTranslationPerformanceTags(text = '') {
  return String(text || '')
    .replace(/<#\d+(?:\.\d+)?#>/g, ' ')
    .replace(/<[^<>\n]{0,48}>/g, ' ')
    .replace(MINIMAX_PAREN_SOUND_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const TOOL_TASK_TRANSLATION_REPAIR = 'translationRepair';
const TRANSLATION_REPAIR_LEASE_KEY = 'mm_translation_repair_lease_v1';
const TRANSLATION_REPAIR_LEASE_MS = 3 * 60 * 1000;
let translationPageTerminating = false;

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (event) => {
    if (event?.persisted !== true) translationPageTerminating = true;
  }, { passive: true });
  window.addEventListener('pageshow', () => {
    translationPageTerminating = false;
  }, { passive: true });
}

function translationLeaseFingerprint(value = '') {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readTranslationRepairLeases(now = Date.now()) {
  try {
    const raw = localStorage.getItem(TRANSLATION_REPAIR_LEASE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const leases = parsed && typeof parsed === 'object' ? parsed : {};
    for (const [key, row] of Object.entries(leases)) {
      if (!row || Number(row.expiresAt || 0) <= now) delete leases[key];
    }
    return leases;
  } catch (_) {
    return {};
  }
}

function writeTranslationRepairLeases(leases = {}) {
  try {
    if (Object.keys(leases).length) {
      localStorage.setItem(TRANSLATION_REPAIR_LEASE_KEY, JSON.stringify(leases));
    } else {
      localStorage.removeItem(TRANSLATION_REPAIR_LEASE_KEY);
    }
  } catch (_) { /* storage unavailable */ }
}

/**
 * iOS WebKit 若在请求中回收页面，内存 singleflight 会随进程消失，但上游可能仍在生成并计费。
 * 用不含聊天正文的短期租约挡住重载后立刻重复发起；正常成功/失败都会在 finally 释放。
 */
function claimTranslationRepairLease(rawKey = '') {
  if (typeof localStorage === 'undefined') return { acquired: true, key: '', owner: '' };
  const now = Date.now();
  const key = translationLeaseFingerprint(rawKey);
  const leases = readTranslationRepairLeases(now);
  if (Number(leases[key]?.expiresAt || 0) > now) {
    return { acquired: false, key, owner: '' };
  }
  const owner = `${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  leases[key] = { owner, expiresAt: now + TRANSLATION_REPAIR_LEASE_MS };
  writeTranslationRepairLeases(leases);
  const confirmed = readTranslationRepairLeases(now);
  return { acquired: confirmed[key]?.owner === owner, key, owner };
}

function releaseTranslationRepairLease(lease = {}) {
  if (translationPageTerminating) return;
  if (!lease?.key || !lease?.owner || typeof localStorage === 'undefined') return;
  const leases = readTranslationRepairLeases();
  if (leases[lease.key]?.owner !== lease.owner) return;
  delete leases[lease.key];
  writeTranslationRepairLeases(leases);
}

function blockedTranslationRepairMap() {
  return annotateTranslationRepairMap(new Map(), {
    repairStatus: 'busy',
    blockedByReloadGuard: true,
  });
}

function annotateTranslationRepairMap(result, diagnostics = {}) {
  const map = result instanceof Map ? result : new Map();
  Object.assign(map, diagnostics);
  return map;
}

function translationRequestFailureDiagnostics(error) {
  const raw = String(error?.message || error || '').trim();
  if (error?.name === 'AbortError' || /\babort(?:ed)?\b|已取消|取消请求/iu.test(raw)) {
    return { repairStatus: 'cancelled', failureReason: 'cancelled' };
  }
  if (/timeout|timed out|超时/iu.test(raw)) {
    return { repairStatus: 'request_failed', failureReason: 'timeout' };
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|api[ _-]?key|鉴权|认证失败/iu.test(raw)) {
    return { repairStatus: 'request_failed', failureReason: 'auth' };
  }
  if (/\b429\b|rate.?limit|quota|余额|额度|限流/iu.test(raw)) {
    return { repairStatus: 'request_failed', failureReason: 'quota' };
  }
  if (/failed to fetch|network|dns|enotfound|econn|网络/iu.test(raw)) {
    return { repairStatus: 'request_failed', failureReason: 'network' };
  }
  if (/未配置|missing.*(?:model|url|key)|配置.*(?:api|模型)|no .*model/iu.test(raw)) {
    return { repairStatus: 'request_failed', failureReason: 'config' };
  }
  return { repairStatus: 'request_failed', failureReason: 'request' };
}

export function translationRepairFailureMessage(result = {}) {
  const status = String(result?.repairStatus || '').trim();
  const reason = String(result?.failureReason || '').trim();
  if (status === 'busy' || result?.blockedByReloadGuard) return '上次翻译请求仍在处理中，请稍后再试';
  if (status === 'empty_response') return '翻译模型没有返回内容，请重试';
  if (status === 'invalid_format') return '翻译模型返回格式不完整，请重试';
  if (status === 'invalid_translation') return '模型返回的内容未通过中文译文校验，请重试';
  if (status === 'cancelled' || reason === 'cancelled') return '翻译请求已取消';
  if (reason === 'timeout') return '翻译请求超时，请重试';
  if (reason === 'auth') return '翻译 API 鉴权失败，请检查 API 设置';
  if (reason === 'quota') return '翻译 API 额度不足或请求过于频繁';
  if (reason === 'network') return '翻译网络请求失败，请检查网络';
  if (reason === 'config') return '翻译 API 尚未正确配置';
  if (status === 'request_failed') return '翻译接口请求失败，请检查 API 设置或调试日志';
  return '';
}

function countMatches(text, re) {
  return (String(text || '').match(re) || []).length;
}

function normalizeForCompare(text = '') {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？,.!?…~～「」『』【】〔〕"'“”‘’]/g, '')
    .toLowerCase();
}

function translationProfileDialectHint(profile = {}) {
  const normalized = normalizeTranslationProfile(profile);
  return [normalized.language, normalized.dialectNote].filter(Boolean).join(' ');
}

export function isChineseDialectLanguageHint(value = '') {
  const hint = String(value || '').trim();
  if (!hint || STANDARD_MANDARIN_HINT_RE.test(hint)) return false;
  return CHINESE_DIALECT_HINT_RE.test(hint);
}

/** 只使用辨识度较高的书面词，避免把普通中文口语误判成方言。 */
export function looksLikeChineseDialectText(text = '', languageHint = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  const hint = String(languageHint || '').trim();
  const tests = [];
  if (!hint || CANTONESE_HINT_RE.test(hint)) tests.push(CANTONESE_TEXT_RE);
  if (!hint || WU_HINT_RE.test(hint)) tests.push(WU_TEXT_RE);
  if (!hint || MINNAN_HINT_RE.test(hint)) tests.push(MINNAN_TEXT_RE);
  if (!hint || HAKKA_HINT_RE.test(hint)) tests.push(HAKKA_TEXT_RE);
  if (!hint || SICHUAN_HINT_RE.test(hint)) tests.push(SICHUAN_TEXT_RE);
  if (!hint || NORTHEAST_HINT_RE.test(hint)) tests.push(NORTHEAST_TEXT_RE);
  // 只写了“方言/土话”时按全部高辨识度词表检查。
  if (!tests.length && isChineseDialectLanguageHint(hint)) {
    tests.push(CANTONESE_TEXT_RE, WU_TEXT_RE, MINNAN_TEXT_RE, HAKKA_TEXT_RE, SICHUAN_TEXT_RE, NORTHEAST_TEXT_RE);
  }
  return tests.some((pattern) => pattern.test(source));
}

export function messageLikelyNeedsTranslationForProfile(source = '', profile = {}, options = {}) {
  const src = String(source || '').trim();
  if (!src) return false;
  if (messageLikelyNeedsTranslation(src)) return true;
  const normalized = normalizeTranslationProfile(profile);
  const hint = translationProfileDialectHint(normalized);
  const voiceFull = options.voice === true && normalized.forceForeignInVoice === true;
  if (isChineseDialectLanguageHint(hint)) {
    if (normalized.mode === 'full' || voiceFull) return true;
    return normalized.mode === 'mixed' && looksLikeChineseDialectText(src, hint);
  }
  // full 代表整句按指定语言输出；即使是很短的 yes / oui，也应保留翻译资格。
  if ((normalized.mode === 'full' || voiceFull)
    && normalized.language
    && !STANDARD_MANDARIN_HINT_RE.test(normalized.language)
    && !/(?:中文|汉语|漢語)/u.test(normalized.language)) {
    return true;
  }
  return false;
}

/** 文本是否像日语（假名占比明显） */
export function looksLikeJapaneseText(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  const kana = countMatches(t, KANA_RE);
  if (kana >= 2) return true;
  if (kana >= 1 && countMatches(t, CJK_RE) === 0) return true;
  return false;
}

/** zh 字段是否像给用户看的中文译文 */
export function looksLikeChineseTranslation(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  const han = countMatches(t, CJK_RE);
  if (han === 0) return false;
  const kana = countMatches(t, KANA_RE);
  if (kana >= 2 && kana >= han * 0.2) return false;
  if (looksLikeJapaneseText(t) && han < 3) return false;
  return true;
}

/**
 * Chat slang / kaomoji that happen to be Latin letters but are not foreign sentences.
 * These should never summon a translate button on their own.
 */
const CHAT_SLANG_RE = /^(?:qaq|qwq|tat|t_t|t\.t|orz|otl|www+|hhh+|hah?a+|hehe+|emm+|mmm+|hmm+|lol+|lmao+|rofl+|omg+|ok(?:ok)*|awa+|owo|uwu|xdxd+|yay+|yeah+|yep+|nope+|gg+|nb+|awsl|xswl)+$/iu;

function looksLikeChatSlangOrEmoticon(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const compact = raw.replace(/\s+/g, '');
  if (CHAT_SLANG_RE.test(compact)) return true;
  if (/\s/.test(raw) || compact.length > 12) return false;
  if (!/^[A-Za-z0-9._~!?？。.!]+$/.test(compact)) return false;
  const letters = compact.replace(/[^A-Za-z]/g, '');
  if (letters.length <= 3) return true;
  // Repeated spam: wwwww / hahaha / okokok
  if (/^(.)\1+$/i.test(letters)) return true;
  if (/^([a-z]{1,3})\1+$/i.test(letters)) return true;
  // Keyboard mash with no vowels
  if (!/[aeiouy]/i.test(letters)) return true;
  return false;
}

/** Whether source text looks like real foreign prose that may need a Chinese translation entry. */
export function messageLikelyNeedsTranslation(source = '') {
  if (source != null && typeof source === 'object') return false;
  const src = String(source || '').trim();
  if (!src) return false;
  if (/^\[\s*(?:object\s+object|对象\s*对象)\s*\]$/iu.test(src)) return false;
  if (looksLikeChatSlangOrEmoticon(src)) return false;
  if (looksLikeJapaneseText(src)) return true;
  if (countMatches(src, HANGUL_RE) >= 2) return true;
  const latin = countMatches(src, LATIN_RE);
  const han = countMatches(src, CJK_RE);
  if (!(latin >= 6 && latin > han)) return false;
  // Prefer real phrases over keyboard spam: spaced words, or punctuated English.
  if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(src)) return true;
  if (/[A-Za-z]{3,}[,.!?'’]/.test(src)) return true;
  // Rare continuous English without spaces — require a longer run.
  return latin >= 16 && latin > han * 2;
}

/** AI 给出的 zh 是否可作为用户可见译文 */
export function isValidUserFacingTranslation(source = '', translation = '', options = {}) {
  if ((source != null && typeof source === 'object')
    || (translation != null && typeof translation === 'object')) return false;
  const src = String(source || '').trim();
  const zh = String(translation || '').trim();
  if (!zh) return false;
  if (/^\[\s*(?:object\s+object|对象\s*对象)\s*\]$/iu.test(src)
    || /^\[\s*(?:object\s+object|对象\s*对象)\s*\]$/iu.test(zh)) return false;
  if (normalizeForCompare(zh) === normalizeForCompare(src)) return false;
  if (src.length > 6 && zh.includes(src) && zh.length <= src.length * 1.35) return false;

  const languageHint = String(options.languageHint || options.translationLanguage || '').trim();
  const dialectSource = isChineseDialectLanguageHint(languageHint)
    || looksLikeChineseDialectText(src, languageHint);
  // 方言译文必须落到普通话；只做繁简转换或继续保留高辨识度方言词不算翻译。
  if (dialectSource && looksLikeChineseDialectText(zh, languageHint)) return false;

  if (looksLikeJapaneseText(src) || looksLikeJapaneseText(zh)) {
    return looksLikeChineseTranslation(zh) && !looksLikeJapaneseText(zh);
  }
  if (countMatches(src, HANGUL_RE) >= 2) {
    return looksLikeChineseTranslation(zh);
  }
  const srcLatin = countMatches(src, LATIN_RE);
  const srcHan = countMatches(src, CJK_RE);
  if (srcLatin >= 6 && srcLatin > srcHan) {
    return looksLikeChineseTranslation(zh);
  }
  if (srcHan > 0 && messageLikelyNeedsTranslation(src)) {
    return looksLikeChineseTranslation(zh);
  }
  if (srcHan === 0 && messageLikelyNeedsTranslation(src)) {
    return looksLikeChineseTranslation(zh);
  }
  return looksLikeChineseTranslation(zh);
}

/**
 * 只剥「整句外包」的一对引号（模型偶发把译文再包一层）。
 * 不要用 /^["'“”…]+/ 这类字符类：原文带 '' 时，中文译文里的引导 “ 会被误删，
 * 留下「我爱你”。」这种半边引号。
 */
function stripWrappingTranslationQuotes(text = '') {
  let s = String(text || '').trim();
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
  ];
  for (let guard = 0; guard < 2; guard += 1) {
    let stripped = false;
    for (const [open, close] of pairs) {
      if (s.length < open.length + close.length) continue;
      if (!s.startsWith(open) || !s.endsWith(close)) continue;
      const inner = s.slice(open.length, s.length - close.length).trim();
      if (!inner) continue;
      s = inner;
      stripped = true;
      break;
    }
    if (!stripped) break;
  }
  return s;
}

/**
 * U / C1 / C2… 是聊天协议内部成员短引用，不属于用户可见译文。
 * 模型偶尔会把回复关系抄成「[回复 C6]」，或把原文里的真实 @称呼翻成 @C5；
 * 前者直接移除，后者仅在原文开头本来就有可见 @称呼时还原该称呼。
 */
export function stripTranslationActorReferenceArtifacts(source = '', translation = '') {
  const src = String(source || '').trim();
  let text = String(translation || '').trim();
  if (!text) return '';

  text = text.replace(
    /^[\[【(（]\s*(?:回复|回应|reply(?:ing)?\s+to)\s*[:：]?\s*[@＠]?(?:[UＵｕ]|[CＣｃc]\s*(?:0|０)*[0-9０-９]{1,3})(?:[·・][^\]】)）]{1,40})?\s*[\]】)）]\s*[:：]?\s*/iu,
    '',
  );

  const sourceMention = src.match(/^([@＠][^\s，。！？,.!?：:；;\[\]【】()（）]{1,40})(?=\s|$)/u)?.[1] || '';
  text = text.replace(
    /^[@＠]\s*(?:[UＵｕ]|[CＣｃc]\s*(?:0|０)*[0-9０-９]{1,3})(?=$|[\s，。！？,.!?：:；;])/u,
    sourceMention,
  );
  return text.trim();
}

export function sanitizeAiTranslation(source = '', translation = '', options = {}) {
  if ((source != null && typeof source === 'object')
    || (translation != null && typeof translation === 'object')) return '';
  // 译文偶发抄进 MiniMax 性能标签（<#0.5#> / <laughs>）；前台只该看到纯中文
  const labeled = String(translation || '')
    .trim()
    .replace(/^(?:翻译|译文|中文|中译|译|zh)\s*[：:]\s*/iu, '');
  const cleaned = stripTranslationPerformanceTags(
    stripTranslationActorReferenceArtifacts(source, stripWrappingTranslationQuotes(labeled)),
  );
  return isValidUserFacingTranslation(source, cleaned, options) ? cleaned : '';
}

export function resolveMessageSourceText(message = {}) {
  const type = String(message?.type || 'text').trim();
  if (type === 'voice') {
    const voiceText = message?.metadata?.text || message?.metadata?.transcript || '';
    return voiceText != null && typeof voiceText === 'object' ? '' : String(voiceText).trim();
  }
  return message?.content != null && typeof message.content === 'object'
    ? ''
    : String(message?.content || '').trim();
}

/** 模型给了 zh 但不可用，或外语正文却完全没给 zh */
export function needsTranslationRepair(source = '', translation = '', options = {}) {
  const src = String(source || '').trim();
  if (!src) return false;
  const raw = String(translation || '').trim();
  if (sanitizeAiTranslation(src, raw, options)) return false;
  if (raw) return true;
  return messageLikelyNeedsTranslationForProfile(
    src,
    options.translationProfile || {},
    { voice: options.voice === true },
  );
}

function resolveLanguageHint(senderId = '', characters = {}) {
  const char = characters?.[senderId];
  const profile = normalizeTranslationProfile(char?.translationProfile);
  return profile.language || profile.dialectNote || '';
}

function actorAllowsAutomaticTranslationRepair(senderId = '', characters = {}, { voice = false } = {}) {
  const id = String(senderId || '').trim();
  if (!id || id === 'user' || id === 'system') return false;
  const profile = normalizeTranslationProfile(characters?.[id]?.translationProfile);
  return profile.mode === 'full'
    || profile.mode === 'mixed'
    || (voice && profile.forceForeignInVoice === true);
}

function needsAutomaticRoundTranslationRepair(source = '', translation = '', {
  senderId = '',
  characters = {},
  voice = false,
} = {}) {
  // 自动补译只服务于明确开启了外语人设的角色。普通中文角色偶尔写英文、
  // URL 或模型误带了坏 zh 时，不应静默增加一次 API 请求。
  if (!actorAllowsAutomaticTranslationRepair(senderId, characters, { voice })) return false;
  const profile = normalizeTranslationProfile(characters?.[senderId]?.translationProfile);
  return needsTranslationRepair(source, translation, {
    translationProfile: profile,
    languageHint: translationProfileDialectHint(profile),
    voice,
  });
}

function extractRepairBatchJson(raw = '') {
  const text = String(raw || '').trim();
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (_) {
    try {
      return JSON.parse(slice.replace(/，/g, ',').replace(/,\s*([}\]])/g, '$1'));
    } catch (_) {
      return null;
    }
  }
}

function buildBatchRepairPrompt(candidates = []) {
  const payload = candidates.map((item) => ({
    id: item.id,
    source: item.source,
    ...(item.languageHint ? { languageHint: item.languageHint } : {}),
  }));
  return [
    '你是聊天译文修复器。下面是一轮对话里模型没写好 zh 的条目，请一次性补全简体中文普通话（现代标准汉语）翻译。',
    '硬规则：',
    '- 只输出一个 JSON 对象，不要 Markdown，不要解释。',
    '- translations 数组与输入 items 一一对应，每条都要有 id 和 zh。',
    '- zh 必须是通顺的现代标准汉语，禁止复制 source 原文，禁止日语假名/英文原文。',
    '- 粤语、吴语、闽南语、客家话、四川话等方言即使使用汉字也必须真正翻成普通话；禁止只做繁简转换，zh 中不要继续保留唔、冇、嘅、咗、喺、佢、侬、阮、莫得等方言词。',
    '- zh 禁止保留 <#...#> / <laughs> / <breath> 等尖括号性能标签，只写纯中文句子。',
    '- U、C1、C2 等是内部成员编号，禁止写进 zh；不要输出 [回复 C1]、@C2 等回复或点名标记。原文已有可见 @称呼时保留原称呼。',
    '- 语气贴合原句，不要比原文更长或更书面。',
    '',
    '输入 items：',
    JSON.stringify({ items: payload }, null, 2),
    '',
    '输出格式：',
    '{"translations":[{"id":"...","zh":"..."}]}',
  ].join('\n');
}

function parseBatchRepairResponse(raw = '', candidates = []) {
  const parsed = extractRepairBatchJson(raw);
  if (!parsed || !Array.isArray(parsed?.translations)) {
    return annotateTranslationRepairMap(new Map(), {
      repairStatus: String(raw || '').trim() ? 'invalid_format' : 'empty_response',
      candidateCount: candidates.length,
      rejectedCount: candidates.length,
    });
  }
  const rows = Array.isArray(parsed?.translations) ? parsed.translations : [];
  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.id || '').trim();
    const zh = String(row?.zh || row?.translation || '').trim();
    if (!id || !zh) continue;
    byId.set(id, zh);
  }
  const out = new Map();
  for (const item of candidates) {
    const zh = byId.get(item.id);
    if (!zh) continue;
    const valid = sanitizeAiTranslation(item.source, zh, { languageHint: item.languageHint });
    if (valid) out.set(item.id, valid);
  }
  const rejectedCount = Math.max(0, candidates.length - out.size);
  return annotateTranslationRepairMap(out, {
    repairStatus: out.size === candidates.length
      ? 'success'
      : (out.size ? 'partial' : 'invalid_translation'),
    candidateCount: candidates.length,
    rejectedCount,
  });
}

const batchInflight = new Map();

export async function isAutomaticTranslationRepairEnabled() {
  const config = await getToolConfig().catch(() => null);
  return config?.autoTranslationRepair === true;
}

async function fetchRoundTranslationsBatch(candidates = [], options = {}) {
  if (!candidates.length) return new Map();
  const cacheKey = candidates.map((c) => `${c.id}:${c.source}`).join('||');
  if (batchInflight.has(cacheKey)) return batchInflight.get(cacheKey);
  const lease = claimTranslationRepairLease(`batch:${cacheKey}`);
  if (!lease.acquired) return blockedTranslationRepairMap();

  const prompt = buildBatchRepairPrompt(candidates);
  // 不传 maxTokens：沿用工具/主 API 线路配置，禁止再写死内置上限。
  const requestOnce = () => chatForTask([
    { role: 'user', content: prompt },
  ], {
    temperature: 0.12,
    signal: options.signal,
    allowToolFallback: false,
    auditContext: options.auditContext || {},
  }, TOOL_TASK_TRANSLATION_REPAIR);

  const task = (async () => {
    const raw = await requestOnce();
    return parseBatchRepairResponse(raw, candidates);
  })().catch((error) => annotateTranslationRepairMap(new Map(), {
    ...translationRequestFailureDiagnostics(error),
    candidateCount: candidates.length,
    rejectedCount: candidates.length,
  })).finally(() => {
    batchInflight.delete(cacheKey);
    releaseTranslationRepairLease(lease);
  });

  batchInflight.set(cacheKey, task);
  return task;
}

/** 手机记录等非聊天消息结构共用的批量补译入口。 */
export async function repairTranslationEntries(entries = [], {
  signal = null,
  automatic = false,
} = {}) {
  if (automatic && !(await isAutomaticTranslationRepairEnabled())) return new Map();
  const rows = (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const source = String(entry?.source || '').trim();
    const translation = String(entry?.translation || entry?.zh || '').trim();
    return {
      id: String(entry?.id || `translation_${index}`).trim(),
      source,
      translation,
      languageHint: String(entry?.languageHint || '').trim(),
    };
  }).filter((entry) => entry.id && entry.source && needsTranslationRepair(entry.source, entry.translation, {
    translationProfile: entry.languageHint
      ? { mode: 'full', language: entry.languageHint }
      : {},
    languageHint: entry.languageHint,
  }));
  if (!rows.length) return new Map();
  return fetchRoundTranslationsBatch(rows, { signal });
}

export function collectRoundTranslationCandidates({
  messages = [],
  sideEffects = [],
  characters = {},
} = {}) {
  const candidates = [];

  for (const msg of messages) {
    const source = resolveMessageSourceText(msg);
    if (msg?.metadata?.narratorBeat === true) {
      // 旁白固定展示中文，不受角色翻译开关限制。若主生成仍偶发返回完整外语
      // 句子，复用本轮同一次批量补译，并在应用结果时直接替换旁白正文。
      if (messageLikelyNeedsTranslation(source)) {
        candidates.push({
          id: String(msg.id || '').trim(),
          source,
          languageHint: '',
          kind: 'narration',
        });
      }
      continue;
    }
    const type = String(msg?.type || 'text');
    if (type !== 'text' && type !== 'voice') continue;
    const senderId = String(msg?.senderId || '').trim();
    const rawZh = String(msg?.metadata?.translation || '').trim();
    if (!needsAutomaticRoundTranslationRepair(source, rawZh, {
      senderId,
      characters,
      voice: type === 'voice',
    })) continue;
    candidates.push({
      id: String(msg.id || '').trim(),
      source,
      languageHint: resolveLanguageHint(senderId, characters),
      kind: 'message',
    });
  }

  for (let ei = 0; ei < sideEffects.length; ei += 1) {
    const event = sideEffects[ei];
    if (!event || typeof event !== 'object') continue;
    if (event.t === 'state') {
      const source = String(event.inner || event.innerVoice || '').trim();
      const rawZh = String(event.innerZh || event.zh || '').trim();
      const senderId = String(event.from || event.actor || event.senderId || '').trim();
      if (needsAutomaticRoundTranslationRepair(source, rawZh, {
        senderId,
        characters,
      })) {
        candidates.push({
          id: `state_${ei}`,
          source,
          languageHint: resolveLanguageHint(senderId, characters),
          kind: 'state',
          eventIndex: ei,
        });
      }
      continue;
    }
    if ((event.t === 'backstage' || event.t === 'peer_private') && Array.isArray(event.lines)) {
      const sideKind = event.t === 'peer_private' ? 'peer_private' : 'backstage';
      for (let li = 0; li < event.lines.length; li += 1) {
        const line = event.lines[li];
        const source = String(line?.body || line?.text || line?.content || '').trim();
        const rawZh = String(line?.zh || line?.translation || '').trim();
        const senderId = String(line?.from || line?.actor || line?.senderId || '').trim();
        if (!needsAutomaticRoundTranslationRepair(source, rawZh, {
          senderId,
          characters,
        })) continue;
        candidates.push({
          id: `${sideKind}_${ei}_${li}`,
          source,
          languageHint: resolveLanguageHint(senderId, characters),
          kind: sideKind,
          eventIndex: ei,
          lineIndex: li,
        });
      }
      continue;
    }
    if (event.t === 'private_msg') {
      const source = String(event.body || event.text || event.content || '').trim();
      const rawZh = String(event.zh || event.translation || '').trim();
      const senderId = String(event.from || event.actor || '').trim();
      if (!needsAutomaticRoundTranslationRepair(source, rawZh, {
        senderId,
        characters,
      })) continue;
      candidates.push({
        id: `private_msg_${ei}`,
        source,
        languageHint: resolveLanguageHint(senderId, characters),
        kind: 'private_msg',
        eventIndex: ei,
      });
      continue;
    }
    if (event.t === 'auto_reply') {
      const source = String(event.text || event.body || event.content || '').trim();
      const rawZh = String(event.zh || event.translation || '').trim();
      const senderId = String(event.from || event.actor || event.senderId || '').trim();
      if (!needsAutomaticRoundTranslationRepair(source, rawZh, {
        senderId,
        characters,
      })) continue;
      candidates.push({
        id: `auto_reply_${ei}`,
        source,
        languageHint: resolveLanguageHint(senderId, characters),
        kind: 'auto_reply',
        eventIndex: ei,
      });
      continue;
    }
  }

  return candidates.filter((item) => item.id && item.source);
}

function applyRepairsToSideEffects(sideEffects = [], repairs = new Map()) {
  return sideEffects.map((event, ei) => {
    if (!event || typeof event !== 'object') return event;
    if (event.t === 'state') {
      const innerZh = repairs.get(`state_${ei}`);
      if (!innerZh) return event;
      return { ...event, innerZh };
    }
    if ((event.t === 'backstage' || event.t === 'peer_private') && Array.isArray(event.lines)) {
      const sideKind = event.t === 'peer_private' ? 'peer_private' : 'backstage';
      const lines = event.lines.map((line, li) => {
        const zh = repairs.get(`${sideKind}_${ei}_${li}`);
        if (!zh) return line;
        return { ...line, zh };
      });
      return { ...event, lines };
    }
    if (event.t === 'private_msg') {
      const zh = repairs.get(`private_msg_${ei}`);
      if (!zh) return event;
      return { ...event, zh };
    }
    if (event.t === 'auto_reply') {
      const zh = repairs.get(`auto_reply_${ei}`);
      if (!zh) return event;
      return { ...event, zh, translation: zh };
    }
    return event;
  });
}

/** 一轮落库前：把本轮所有缺失/坏掉的 zh 一次性走工具 API 补全 */
export async function repairChatRoundTranslations({
  messages = [],
  sideEffects = [],
  characters = {},
  signal = null,
  onStatus = null,
  auditContext = null,
  automatic = false,
} = {}) {
  if (automatic && !(await isAutomaticTranslationRepairEnabled())) {
    return { messages, sideEffects, repaired: 0, candidateCount: 0 };
  }
  const candidates = collectRoundTranslationCandidates({ messages, sideEffects, characters });
  if (!candidates.length) {
    return { messages, sideEffects, repaired: 0, candidateCount: 0 };
  }

  if (typeof onStatus === 'function') {
    try { onStatus({ phase: 'start', candidateCount: candidates.length }); } catch (_) { /* UI status is optional */ }
  }
  const repairs = await fetchRoundTranslationsBatch(candidates, { signal, auditContext });
  if (!repairs.size) {
    return { messages, sideEffects, repaired: 0, candidateCount: candidates.length };
  }

  const nextMessages = messages.map((msg) => {
    const zh = repairs.get(String(msg.id || '').trim());
    if (!zh) return msg;
    if (msg?.metadata?.narratorBeat === true) {
      return {
        ...msg,
        content: zh,
        metadata: {
          ...(msg.metadata || {}),
          narrationLanguageRepaired: true,
        },
      };
    }
    return {
      ...msg,
      metadata: {
        ...(msg.metadata || {}),
        translation: zh,
        translationRepaired: true,
      },
    };
  });

  const nextSideEffects = applyRepairsToSideEffects(sideEffects, repairs);
  return {
    messages: nextMessages,
    sideEffects: nextSideEffects,
    repaired: repairs.size,
    candidateCount: candidates.length,
  };
}

/** 点「翻译」补译时，从已加载列表里筛出本轮/本条候选（供批量请求与单测共用） */
export function selectTranslationRepairMessages(messages = [], {
  aiRoundId = '',
  messageId = '',
  characters = {},
} = {}) {
  const rid = String(aiRoundId || '').trim();
  const onlyId = String(messageId || '').trim();
  return (Array.isArray(messages) ? messages : []).filter((msg) => {
    if (!msg || (msg.type !== 'text' && msg.type !== 'voice')) return false;
    if (String(msg?.senderId || '').trim() === 'user') return false;
    const id = String(msg.id || '').trim();
    if (rid) {
      if (String(msg?.metadata?.aiRoundId || '').trim() !== rid) return false;
    } else if (onlyId) {
      // 没有 aiRoundId 时不能把整窗待补译消息塞进一次请求，否则容易空回后每次点击都重跑。
      if (id !== onlyId) return false;
    }
    const source = resolveMessageSourceText(msg);
    const profile = normalizeTranslationProfile(characters?.[msg.senderId]?.translationProfile);
    return needsTranslationRepair(source, msg?.metadata?.translation, {
      translationProfile: profile,
      languageHint: translationProfileDialectHint(profile),
      voice: msg.type === 'voice',
    });
  });
}

/** 从已加载的消息列表里按同一 aiRoundId 批量补译（旧消息点「翻译」时的兜底） */
export async function repairTranslationsFromMessageList(messages = [], {
  aiRoundId = '',
  messageId = '',
  characters = {},
  signal = null,
} = {}) {
  const list = selectTranslationRepairMessages(messages, { aiRoundId, messageId, characters });
  if (!list.length) return new Map();

  const candidates = list.map((msg) => ({
    id: String(msg.id || '').trim(),
    source: resolveMessageSourceText(msg),
    languageHint: resolveLanguageHint(msg.senderId, characters),
    kind: 'message',
  })).filter((item) => item.id && item.source);

  return fetchRoundTranslationsBatch(candidates, { signal });
}

const singleInflight = new Map();

async function repairChineseTranslationDetailed(sourceText = '', options = {}) {
  const source = String(sourceText || '').trim();
  if (!source) return { translation: '', repairStatus: 'no_candidate' };

  if (Array.isArray(options.roundMessages) && options.roundMessages.length) {
    const rid = String(options.aiRoundId || '').trim();
    const repairs = await repairTranslationsFromMessageList(options.roundMessages, {
      aiRoundId: rid,
      characters: options.characters || {},
      signal: options.signal,
    });
    const hit = [...repairs.values()].find((zh) => sanitizeAiTranslation(source, zh, {
      languageHint: options.languageHint || '',
    }));
    return {
      translation: hit || '',
      repairStatus: hit ? 'success' : (repairs.repairStatus || 'invalid_translation'),
      failureReason: repairs.failureReason || '',
      blockedByReloadGuard: repairs.blockedByReloadGuard === true,
    };
  }

  const cacheKey = `${options.languageHint || ''}::${source}`;
  if (singleInflight.has(cacheKey)) return singleInflight.get(cacheKey);
  const lease = claimTranslationRepairLease(`single:${cacheKey}`);
  if (!lease.acquired) {
    return { translation: '', repairStatus: 'busy', blockedByReloadGuard: true };
  }

  const hint = String(options.languageHint || '').trim();
  const prompt = [
    '你是聊天译文修复器。把下面这句翻成通顺的简体中文普通话（现代标准汉语）。',
    '只输出一个 JSON 对象：{"zh":"..."}。不要解释、不要 Markdown、不要保留外语原文、不要日语假名。',
    isChineseDialectLanguageHint(hint)
      ? '原文是中文方言：必须真正改写为普通话，不能只做繁简转换，也不能在 zh 里继续保留方言词。'
      : '',
    hint ? `原文语种提示：${hint}` : '',
    '',
    source,
  ].filter(Boolean).join('\n');

  const task = chatForTask([{ role: 'user', content: prompt }], {
    temperature: 0.12,
    signal: options.signal,
  }, TOOL_TASK_TRANSLATION_REPAIR).then((raw) => {
    const text = String(raw || '').trim();
    if (!text) return { translation: '', repairStatus: 'empty_response' };
    const parsed = parseSingleTranslationRepairResponse(text);
    if (!parsed) return { translation: '', repairStatus: 'invalid_format' };
    const translation = sanitizeAiTranslation(source, parsed, { languageHint: hint });
    return {
      translation,
      repairStatus: translation ? 'success' : 'invalid_translation',
    };
  }).catch((error) => ({
    translation: '',
    ...translationRequestFailureDiagnostics(error),
  })).finally(() => {
    singleInflight.delete(cacheKey);
    releaseTranslationRepairLease(lease);
  });

  singleInflight.set(cacheKey, task);
  return task;
}

/** 单条补译兜底（优先同一轮批量；只有 1 条时仍走工具 API） */
export async function repairChineseTranslation(sourceText = '', options = {}) {
  const result = await repairChineseTranslationDetailed(sourceText, options);
  return result.translation || '';
}

export function parseSingleTranslationRepairResponse(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  const parsed = extractRepairBatchJson(text);
  const structured = String(parsed?.zh || parsed?.translations?.[0]?.zh || '').trim();
  if (structured) return structured;
  // 截断 JSON / Markdown 围栏绝不能作为可见译文，否则会显示
  // `json {"zh":"...` 之类协议残片并看起来像正文被替换了一半。
  if (/```|[{}[\]]|["']?(?:zh|translation)["']?\s*[:：]/iu.test(text)) return '';
  return stripWrappingTranslationQuotes(
    text.replace(/^(?:翻译|译文|中文|中译|译)\s*[：:]\s*/iu, ''),
  );
}

function resolveTranslationTextNode(wrap) {
  if (!wrap) return null;
  return wrap.querySelector('.chat-bubble-translation-text, .voice-msg-translation, .narration-translation') || wrap;
}

/**
 * 展开/收起翻译；无效译文会优先尝试同轮批量补译。
 * 返回：
 * - true：已展开或已收起
 * - false：补译失败，仍无可用译文
 * - 'collapsed'：本次只是收起，调用方不要再当成补译成功去重绘/强行展开
 */
export async function handleTranslationToggleClick(btn, {
  sourceText = '',
  translationText = '',
  languageHint = '',
  aiRoundId = '',
  roundMessages = [],
  characters = {},
  onRepaired,
  onBatchRepaired,
  signal,
} = {}) {
  const wrap = btn?.nextElementSibling;
  if (!wrap || !(wrap.classList.contains('chat-bubble-translation') || wrap.classList.contains('narration-translation'))) {
    return false;
  }

  const expanded = !wrap.hidden;
  if (expanded) {
    wrap.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return 'collapsed';
  }

  const source = String(sourceText || '').trim();
  let translation = sanitizeAiTranslation(source, translationText, { languageHint });
  let failureDiagnostics = null;
  const textNode = resolveTranslationTextNode(wrap);

  if (!isValidUserFacingTranslation(source, translation, { languageHint })) {
    const prevLabel = btn.textContent;
    btn.disabled = true;
    if (prevLabel && btn.getAttribute('aria-busy') !== 'true') btn.textContent = '…';
    try {
      let batchMap = null;
      const hasRoundContext = Array.isArray(roundMessages) && roundMessages.length > 0;
      const msgId = String(btn.closest('[data-msg-id]')?.getAttribute('data-msg-id') || '').trim();
      if (hasRoundContext) {
        batchMap = await repairTranslationsFromMessageList(roundMessages, {
          aiRoundId,
          messageId: msgId,
          characters,
          signal,
        });
        if (typeof onBatchRepaired === 'function' && batchMap?.size) {
          await onBatchRepaired(batchMap);
        }
        failureDiagnostics = batchMap;
      }
      const batchHit = msgId ? batchMap?.get(msgId) : '';
      // 一次点击最多一次计费请求：有同轮上下文就只走批量补译，不再因空回自动补发单条请求。
      const singleResult = !hasRoundContext
        ? await repairChineseTranslationDetailed(source, { languageHint, signal })
        : null;
      if (singleResult) failureDiagnostics = singleResult;
      const repaired = batchHit || singleResult?.translation || '';
      if (repaired) {
        translation = repaired;
        if (textNode) textNode.textContent = repaired;
        if (typeof onRepaired === 'function') await onRepaired(repaired);
      }
    } finally {
      btn.disabled = false;
      if (prevLabel) btn.textContent = prevLabel;
    }
  } else if (textNode && !String(textNode.textContent || '').trim()) {
    textNode.textContent = translation;
  }

  if (!isValidUserFacingTranslation(source, translation, { languageHint })) {
    const failureMessage = translationRepairFailureMessage(failureDiagnostics || {});
    if (failureMessage) btn.setAttribute('data-translation-failure-message', failureMessage);
    return false;
  }

  btn.removeAttribute('data-translation-failure-message');
  wrap.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  return true;
}

/**
 * Collect full/mixed translation actors from character-like objects
 * ({ id, name?, translationProfile }).
 */
export function collectTranslationActors(characters = []) {
  const full = [];
  const mixed = [];
  for (const row of Array.isArray(characters) ? characters : []) {
    if (!row) continue;
    const id = String(row.id || '').trim();
    if (!id || id === 'user' || id === 'system') continue;
    const profile = normalizeTranslationProfile(row.translationProfile);
    const name = String(row.name || id).trim() || id;
    if (profile.mode === 'full') {
      full.push({ id, name, language: profile.language || '' });
    } else if (profile.mode === 'mixed') {
      mixed.push({ id, name, dialectNote: profile.dialectNote || '' });
    }
  }
  return { full, mixed };
}

/**
 * Prompt block for social/phone JSON generators (moments, phone-life, phone-records).
 * Asks models to write foreign text + a sibling "zh" field — same contract as chat bubbles.
 *
 * @param {object} actorsOrList - either {full,mixed} from collectTranslationActors, or a character list
 * @param {{ fields?: string, exampleField?: string }} options
 */
export function buildJsonFieldTranslationPromptBlock(actorsOrList, options = {}) {
  const actors = Array.isArray(actorsOrList)
    ? collectTranslationActors(actorsOrList)
    : (actorsOrList && typeof actorsOrList === 'object'
      ? {
        full: Array.isArray(actorsOrList.full) ? actorsOrList.full : [],
        mixed: Array.isArray(actorsOrList.mixed) ? actorsOrList.mixed : [],
      }
      : { full: [], mixed: [] });
  const fields = String(options.fields || 'text / content').trim() || 'text / content';
  const exampleField = String(options.exampleField || 'text').trim() || 'text';
  const lines = [];
  if (actors.full.length) {
    lines.push(
      '[外语人设翻译]',
      ...actors.full.map((t) => (
        isChineseDialectLanguageHint(t.language)
          ? `- ${t.name}（${t.id}）主要用${t.language || 'TA 设定里的中文方言'}写：TA 的 ${fields} 必须直接写方言原文，并额外给一个 "zh" 字段写通顺的简体中文普通话（现代标准汉语）译文。方言即使全是汉字也不能省略 zh，不能只做繁简转换，例如 {"${exampleField}":"我而家返紧嚟","zh":"我现在正在回来"}。`
          : `- ${t.name}（${t.id}）主要用${t.language || 'TA 设定里的外语'}写：TA 的 ${fields} 必须直接写外语原文（不要写中文），并额外给一个 "zh" 字段写通顺的简体中文普通话（现代标准汉语）翻译，例如 {"${exampleField}":"I miss you already","zh":"我已经想你了"}。`
      )),
      '- zh 是给用户看的简体中文普通话译文，禁止复制原文、只做繁简转换，或保留外语、日语假名和方言词；语气贴合原句，不要比原文更长或更书面。',
    );
  }
  if (actors.mixed.length) {
    lines.push(
      '[偶尔外语/方言翻译]',
      ...actors.mixed.map((t) => (
        isChineseDialectLanguageHint(t.dialectNote)
          ? `- ${t.name}（${t.id}）日常写普通话，偶尔使用${t.dialectNote || '中文方言'}时直接写出方言原文；只要这条 ${fields} 里出现方言表达，即使全是汉字，也要额外给 "zh" 写出整条的简体中文普通话版本，例如 {"${exampleField}":"我而家返紧嚟","zh":"我现在正在回来"}。没有方言表达时不用加 zh。`
          : `- ${t.name}（${t.id}）日常写中文，偶尔蹦${t.dialectNote || '外语/方言词句'}时直接写出原文；只要这条 ${fields} 里出现了外语或方言词句，就额外给 "zh" 写出整条的简体中文普通话版本，例如 {"${exampleField}":"这方案有点anticlimactic啊","zh":"这方案有点虎头蛇尾啊"}。没有外语或方言表达时不用加 zh。`
      )),
      '- zh 必须是简体中文普通话（现代标准汉语）：禁止复制原文或只做繁简转换，禁止保留日语假名、英文单词和方言词。',
    );
  }
  return lines.join('\n');
}

/** Compact translation hint for character cards / JSON payloads (null when off). */
export function translationProfileBrief(profile) {
  const tp = normalizeTranslationProfile(profile);
  if (tp.mode === 'off') return null;
  return {
    mode: tp.mode,
    ...(tp.language ? { language: tp.language } : {}),
    ...(tp.dialectNote ? { dialectNote: tp.dialectNote } : {}),
  };
}
