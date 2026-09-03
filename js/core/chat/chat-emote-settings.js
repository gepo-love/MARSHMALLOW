/**
 * 聊天「贴表情」与颜文字库设置。
 * 会话 prefs：allowAiReact / aiReactKind / preferSafeEmoji / aiReactFrequency /
 * stickerFrequency / inlineEmoteFrequency
 * 全局：kaomojiLibrary（用户可导入管理）
 */
import { get, put } from '../db.js';

export const AI_REACT_KIND_EMOJI = 'emoji';
export const AI_REACT_KIND_KAOMOJI = 'kaomoji';
export const EXPRESSION_FREQUENCY_OFF = 'off';
export const EXPRESSION_FREQUENCY_LOW = 'low';
export const EXPRESSION_FREQUENCY_NORMAL = 'normal';
export const EXPRESSION_FREQUENCY_HIGH = 'high';

const EXPRESSION_FREQUENCY_VALUES = new Set([
  EXPRESSION_FREQUENCY_OFF,
  EXPRESSION_FREQUENCY_LOW,
  EXPRESSION_FREQUENCY_NORMAL,
  EXPRESSION_FREQUENCY_HIGH,
]);

const EXPRESSION_FREQUENCY_LABELS = Object.freeze({
  [EXPRESSION_FREQUENCY_OFF]: '关闭',
  [EXPRESSION_FREQUENCY_LOW]: '低频',
  [EXPRESSION_FREQUENCY_NORMAL]: '自然',
  [EXPRESSION_FREQUENCY_HIGH]: '高频',
});

const KAOMOJI_LIBRARY_KEY = 'kaomojiLibrary';
const KAOMOJI_MAX = 200;
const KAOMOJI_ITEM_MAX = 24;

/** 跨平台常见、不易裂成豆腐块的回应 emoji */
export const DEFAULT_SAFE_EMOJIS = Object.freeze([
  '👍', '😂', '😭', '❤️', '🥺', '🙏', '👏', '👀', '🤔', '😅',
  '😊', '🥰', '😳', '😴', '😤', '🫠', '🥹', '💔', '✨', '💯',
  '😎', '🥲', '😆', '😱', '🙄', '😶', '😮', '🤭', '🫡', '🫶',
]);

/** 内置颜文字；用户可导入覆盖/追加 */
export const DEFAULT_KAOMOJI = Object.freeze([
  '(｡>﹏<｡)', '_(:з」∠)_', '(´・ω・`)', '(￣▽￣)', '(╯°□°）╯︵ ┻━┻',
  '(≧▽≦)', '(；′⌒`)', '(๑•̀ㅂ•́)و', '(ノ﹏ヽ)', '∑(ﾟДﾟﾉ)ﾉ',
  '(´∀｀)', '(・∀・)', '(´▽｀)', '(＞＜)', '(๑´ڡ`๑)',
  'orz', 'www', '草', '(´-ω-`)', '( ˘▽˘)っ',
]);

export function normalizeAiReactKind(value) {
  return String(value || '').trim() === AI_REACT_KIND_KAOMOJI
    ? AI_REACT_KIND_KAOMOJI
    : AI_REACT_KIND_EMOJI;
}

export function normalizeExpressionFrequency(value, fallback = EXPRESSION_FREQUENCY_NORMAL) {
  const normalizedFallback = EXPRESSION_FREQUENCY_VALUES.has(String(fallback || '').trim())
    ? String(fallback).trim()
    : EXPRESSION_FREQUENCY_NORMAL;
  const normalized = String(value || '').trim();
  return EXPRESSION_FREQUENCY_VALUES.has(normalized) ? normalized : normalizedFallback;
}

export function expressionFrequencyLabel(value) {
  return EXPRESSION_FREQUENCY_LABELS[normalizeExpressionFrequency(value)] || '自然';
}

export function buildExpressionFrequencyInstruction(value, subject = '这种表达') {
  const frequency = normalizeExpressionFrequency(value);
  if (frequency === EXPRESSION_FREQUENCY_OFF) {
    return `${subject}频率：关闭；本会话不要使用。`;
  }
  if (frequency === EXPRESSION_FREQUENCY_LOW) {
    return `${subject}频率：低频；大多数回合不用，只在情绪或接梗明显需要时偶尔使用；最近刚用过就优先改用文字。`;
  }
  if (frequency === EXPRESSION_FREQUENCY_HIGH) {
    return `${subject}频率：高频；符合人设和当前气氛时可以主动使用、连续接梗，但不要机械地每轮都用，也不要用它跳过应答。`;
  }
  return `${subject}频率：自然；只在当前语气确实合适时使用，不按轮次打卡，也不要因为上一轮用了就照抄。`;
}

export function resolveChatEmoteSettings(prefs = {}) {
  const src = prefs && typeof prefs === 'object' ? prefs : {};
  return {
    allowAiReact: src.allowAiReact !== false,
    aiReactKind: normalizeAiReactKind(src.aiReactKind),
    preferSafeEmoji: src.preferSafeEmoji !== false,
    aiReactFrequency: normalizeExpressionFrequency(src.aiReactFrequency),
    stickerFrequency: normalizeExpressionFrequency(src.stickerFrequency),
    inlineEmoteFrequency: normalizeExpressionFrequency(src.inlineEmoteFrequency),
  };
}

export function parseCharacterEmoteCandidates(text = '') {
  return [...new Set(String(text || '')
    .split(/[\n\r/／|｜、，,]+/u)
    .map((item) => String(item || '').trim())
    .filter(Boolean))]
    .slice(0, 80);
}

function stableExpressionHash(value = '') {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 每轮稳定轮换候选，并优先暂时移除最近使用项。
 * 相同上下文构建多次会得到相同顺序；新消息到来后 seed 改变，候选随之轮换。
 */
export function rotateExpressionCandidates(list = [], options = {}) {
  const unique = [...new Set((Array.isArray(list) ? list : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
  const recent = [...new Set((Array.isArray(options.recentValues) ? options.recentValues : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
  const recentSet = new Set(recent);
  const fresh = unique.filter((item) => !recentSet.has(item));
  const source = fresh.length ? fresh : unique;
  const seed = String(options.seed || 'expression');
  const ordered = source
    .map((item, index) => ({
      item,
      index,
      score: stableExpressionHash(`${seed}|${item}`),
    }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((row) => row.item);
  const limit = Math.max(1, Math.min(unique.length || 1, Math.floor(Number(options.limit) || unique.length || 1)));
  return {
    total: unique.length,
    names: ordered.slice(0, limit),
    cooled: recent.filter((item) => unique.includes(item)),
    omitted: Math.max(0, unique.length - Math.min(limit, ordered.length)),
  };
}

export function collectRecentInlineEmotes(messages = [], candidates = [], actorId = '', maxItems = 6) {
  const pool = [...new Set((Array.isArray(candidates) ? candidates : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
  if (!pool.length) return [];
  const wantedActor = String(actorId || '').trim();
  const found = [];
  const seen = new Set();
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0 && found.length < maxItems; index -= 1) {
    const message = rows[index];
    if (!message || message.deleted || message.recalled || String(message.type || 'text') !== 'text') continue;
    if (wantedActor && String(message.senderId || '').trim() !== wantedActor) continue;
    const body = String(message.content || '');
    for (const item of pool) {
      if (!seen.has(item) && body.includes(item)) {
        seen.add(item);
        found.push(item);
        if (found.length >= maxItems) break;
      }
    }
  }
  return found;
}

export function collectRecentAiReactionEmotes(messages = [], maxItems = 8) {
  const found = [];
  const seen = new Set();
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0 && found.length < maxItems; index -= 1) {
    const byRound = rows[index]?.metadata?.reactionsByAiRound;
    if (!byRound || typeof byRound !== 'object') continue;
    const roundValues = Object.values(byRound).reverse();
    for (const reactionMap of roundValues) {
      if (!reactionMap || typeof reactionMap !== 'object') continue;
      for (const emote of Object.keys(reactionMap).reverse()) {
        const clean = String(emote || '').trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        found.push(clean);
        if (found.length >= maxItems) break;
      }
      if (found.length >= maxItems) break;
    }
  }
  return found;
}

export function buildExpressionRoundSeed(messages = [], chatId = '', scope = '') {
  const rows = (Array.isArray(messages) ? messages : []).filter((message) => message && !message.deleted && !message.recalled);
  const latest = rows[rows.length - 1] || {};
  return [
    String(chatId || ''),
    String(scope || ''),
    String(latest.id || ''),
    String(latest.timestamp || latest.createdAt || rows.length || 0),
    String(rows.length),
  ].join('|');
}

export function selectAiReactCandidates(settings = {}, options = {}) {
  const s = resolveChatEmoteSettings(settings);
  const base = s.aiReactKind === AI_REACT_KIND_KAOMOJI
    ? (normalizeKaomojiList(options.kaomojiList).length
      ? normalizeKaomojiList(options.kaomojiList)
      : [...DEFAULT_KAOMOJI])
    : ((Array.isArray(options.safeEmojis) && options.safeEmojis.length)
      ? options.safeEmojis
      : [...DEFAULT_SAFE_EMOJIS]);
  return rotateExpressionCandidates(base, {
    seed: options.rotationSeed || 'react',
    recentValues: options.recentEmotes,
    limit: s.aiReactKind === AI_REACT_KIND_KAOMOJI ? 18 : 20,
  });
}

export function normalizeKaomojiItem(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return s.slice(0, KAOMOJI_ITEM_MAX);
}

/** 按行 / | / 、 / ， 拆分导入文本 */
export function parseKaomojiImportText(text = '') {
  const chunks = String(text || '')
    .split(/[\n\r|｜、，,]+/u)
    .map((x) => normalizeKaomojiItem(x))
    .filter(Boolean);
  return [...new Set(chunks)].slice(0, KAOMOJI_MAX);
}

export function normalizeKaomojiList(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const s = normalizeKaomojiItem(item);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= KAOMOJI_MAX) break;
  }
  return out;
}

export async function loadKaomojiLibrary() {
  const row = await get(KAOMOJI_LIBRARY_KEY).catch(() => null);
  const list = normalizeKaomojiList(row?.value);
  return list.length ? list : [...DEFAULT_KAOMOJI];
}

export async function saveKaomojiLibrary(list = []) {
  const next = normalizeKaomojiList(list);
  await put({ key: KAOMOJI_LIBRARY_KEY, value: next });
  return next;
}

export function chatEmoteSettingsMeta(settings = {}) {
  const s = resolveChatEmoteSettings(settings);
  const react = s.allowAiReact
    ? `${s.aiReactKind === AI_REACT_KIND_KAOMOJI ? '颜文字' : 'emoji'}${expressionFrequencyLabel(s.aiReactFrequency)}`
    : '贴表情关';
  return `包${expressionFrequencyLabel(s.stickerFrequency)} · 文${expressionFrequencyLabel(s.inlineEmoteFrequency)} · ${react}`;
}

/**
 * 注入协议：约束 react 的 emoji 字段用什么。
 * @returns {string} 追加到协议核心事件附近的短说明；关闭时返回禁止文案
 */
export function buildAiReactConstraintLines(settings = {}, options = {}) {
  const s = resolveChatEmoteSettings(settings);
  const actor = String(options.actorId || '角色id').trim() || '角色id';
  if (!s.allowAiReact || s.aiReactFrequency === EXPRESSION_FREQUENCY_OFF) {
    return [
      '- 本会话已关闭「贴表情」：禁止输出 react 事件；没话可接时用短 msg 或表情包（若有），不要贴反应。',
    ];
  }
  const selection = selectAiReactCandidates(s, options);
  const names = selection.names;
  const example = names[0] || (s.aiReactKind === AI_REACT_KIND_KAOMOJI ? '(´・ω・`)' : '🙂');
  const cooldown = selection.cooled.length
    ? `近期已经用过：${selection.cooled.join(' · ')}；除非正在连续接同一个梗，本轮优先避开这些。`
    : '';
  const frequencyLine = `- ${buildExpressionFrequencyInstruction(s.aiReactFrequency, '消息贴表情')}`;
  if (s.aiReactKind === AI_REACT_KIND_KAOMOJI) {
    return [
      frequencyLine,
      `- 贴表情反应格式：{"t":"react","from":"${actor}","target":{"selector":"last_user"},"emoji":"${example}"}；本会话规定只用颜文字，禁止用普通 emoji。`,
      `- 本轮颜文字候选（emoji 字段填其一）：${names.join(' · ')}`,
      cooldown ? `- ${cooldown}` : '',
    ].filter(Boolean);
  }
  if (s.preferSafeEmoji) {
    return [
      frequencyLine,
      `- 贴表情反应格式：{"t":"react","from":"${actor}","target":{"selector":"last_user"},"emoji":"${example}"}；本会话用 emoji，本轮优先候选：${names.join('')}`,
      '- 不要用冷门/组合/国旗/皮肤色变体等容易裂图的符号；没新话可只贴一个反应。',
      cooldown ? `- ${cooldown}` : '',
    ].filter(Boolean);
  }
  return [
    frequencyLine,
    `- 贴表情反应格式：{"t":"react","from":"${actor}","target":{"selector":"last_user"},"emoji":"${example}"}；本会话用单个常见 emoji；可优先参考本轮轮换候选：${names.join('')}`,
    cooldown ? `- ${cooldown}` : '',
  ].filter(Boolean);
}
