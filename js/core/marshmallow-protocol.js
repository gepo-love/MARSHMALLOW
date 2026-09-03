import { createMessage } from '../models/chat.js';
import { resolveCharacterAiContextName } from '../models/character.js';
import { normalizeUserFacingLabel } from '../models/user.js';
import { resolveVoiceEventDuration } from './chat/card-render.js';
import { detectLinkPlatform } from './link-platforms.js';
import {
  buildPendingLinkMetadata,
  parseEmbeddedLinkShareText,
  stripMarkdownLinkSyntax,
} from './link-card-enhancer.js';
import {
  isChineseDialectLanguageHint,
  messageLikelyNeedsTranslation,
  sanitizeAiTranslation,
} from './translation-utils.js';
import {
  buildReplyTargetFields,
  buildOrderShareMessageContent,
  getReplyContentPreview,
  isAnonymousChat,
  isUserPresentInChat,
  normalizeOrderSharePrice,
  normalizeMessageForUi,
  parseFinanceBracketFromText,
  parseReplyBracketFromText,
  sanitizeReplyPreview,
  sanitizeReplySenderName,
  resolveStickerMessage,
  stripAiSearchRequestTags,
  stripDeliveryStatusBracketFromText,
} from './chat-helpers.js';
import { formatNudgeSystemText } from './chat/system-events.js';
import { buildAiRedPacketMetadata } from './chat/red-packet-claims.js';
import { applyTrailingPeriodPref } from './chat/chat-output-prefs.js';
import {
  buildChatActorReferenceTable,
  normalizeActorReference,
  resolveChatActorReference,
} from './chat/actor-reference.js';
import { getCharacter } from './character-store.js';
import { getCurrentUser } from './user-slot.js';
import { buildOfflineInviteRoutePlan } from './chat/offline-invite-route.js';
import { applyOfflineInviteScheduleFromMessage } from './chat/offline-invite-schedule.js';
import { sanitizeOfflineArrivalNote } from './chat/offline-invite-arrival.js';
import { createHtmlExtensionSnapshot, listHtmlExtensions, normalizeHtmlExtensionFields } from './html-extensions.js';
import {
  normalizeVoiceSpeechPlan,
  sanitizeVoiceTranscriptText,
  stripLeakedVoicePerformanceTags,
} from './voice-tools.js';
import {
  buildVoiceWorldBookPrompt,
  VOICE_WORLD_BOOK_SURFACES,
} from './voice-worldbook.js';
import { prioritizeNarrationSoundCategories } from './sound-cues.js';
import {
  buildNarrationStyleGuard,
  buildNarrationUserPersonRule,
} from './narration-style-guard.js';

export const MARSHMALLOW_CHAT_PROTOCOL = 'MARSHMALLOW_CHAT_V2';
export const MARSHMALLOW_CHAT_PROTOCOL_LABEL = '棉花糖协议';
export const LEGACY_GUGU_CHAT_PROTOCOL = 'GUGU_CHAT_V2';
export const MARSHMALLOW_CHAT_START = `<<<${MARSHMALLOW_CHAT_PROTOCOL}>>>`;
export const MARSHMALLOW_CHAT_END = `<<<END_${MARSHMALLOW_CHAT_PROTOCOL}>>>`;
export const LEGACY_GUGU_CHAT_START = `<<<${LEGACY_GUGU_CHAT_PROTOCOL}>>>`;
export const LEGACY_GUGU_CHAT_END = `<<<END_${LEGACY_GUGU_CHAT_PROTOCOL}>>>`;

const MARSHMALLOW_PROTOCOL_MARKERS = [
  { start: MARSHMALLOW_CHAT_START, end: MARSHMALLOW_CHAT_END },
  { start: LEGACY_GUGU_CHAT_START, end: LEGACY_GUGU_CHAT_END },
];

export const EVENT_TYPES = new Set([
  'msg', 'narration', 'react', 'recall', 'sticker', 'image', 'gen_image', 'voice', 'voice_call', 'dice',
  'redpacket', 'redpacket_claim', 'transfer', 'transfer_accept', 'transfer_return', 'order_share',
  'textimg', 'link', 'location', 'offline_invite', 'html_widget',
  'backstage', 'peer_private', 'private_msg', 'group_title', 'group_name', 'group_announcement',
  'group_todo', 'group_transfer', 'group_admin', 'group_member', 'group_remote', 'mute', 'vote', 'vote_close', 'state', 'situation', 'nudge',
  'status', 'schedule_change', 'auto_reply', 'alias', 'avatar', 'memory_fact',
  'chat_bundle', 'npc_card', 'anonymous_reveal', 'memo', 'radio_plan', 'interaction_plan', 'period_offer', 'period_confirm', 'period_decline', 'period_set', 'period_end', 'invite_user', 'stranger_block', 'stranger_friend', 'stranger_unblock', 'stranger_suspect',
  'social_post', 'open_alias', 'social_react', 'share_back', 'alias_poke', 'next_reply_delay', 'presence', 'hard_offline', 'wait_mood',
]);

const GROUP_MANAGEMENT_EVENT_TYPES = new Set([
  'group_title', 'group_name', 'group_announcement', 'group_todo', 'group_transfer', 'group_admin', 'group_member', 'mute',
]);

const TARGET_SELECTORS = new Set(['last_user', 'last_user_image', 'last_image', 'last_user_link', 'last_link', 'last_ai', 'round_prev', 'last_in_room', 'last_redpacket', 'last_transfer']);

function isTargetSelector(value = '') {
  const selector = cleanString(value);
  return TARGET_SELECTORS.has(selector) || /^round_[1-9]\d*$/.test(selector);
}

// Messages with financial/system state must not be recalled by AI.
export const RECALL_BLOCKED_TYPES = new Set(['system', 'chatAction', 'redpacket', 'transfer', 'orderShare', 'htmlWidget', 'voiceCall', 'offlineInvite', 'offlineStory', 'arenaRoom', 'npcCard']);

export const PROMPTED_THINKING_START = '<<<THINKING>>>';
export const PROMPTED_THINKING_END = '<<<END_THINKING>>>';
const THINKING_START = PROMPTED_THINKING_START;
const THINKING_END = PROMPTED_THINKING_END;

/** 模型在要求的思维链边界刚起笔时被截断，例如只返回 `<<`。 */
export function isIncompletePromptedThinkingPrefix(value = '') {
  const text = String(value || '').trim();
  return !!text
    && text.length < PROMPTED_THINKING_START.length
    && PROMPTED_THINKING_START.startsWith(text);
}

const LOOSE_CHAT_PROTOCOL_MARKER_RE = /<{2,}\s*(?:END\s*[_-]?\s*)?(?:MARSHMALLOW|GUGU)\s*[_-]?\s*CHAT\s*[_-]?\s*V\s*2\s*>{2,}/giu;
const TRANSLATED_CHAT_PROTOCOL_MARKER_RE = /(?:\[|【)\s*(?:棉花糖|咕咕)\s*(?:聊天)?\s*V\s*2\s*(?:协议)?\s*(?:开始|结束)\s*(?:\]|】)/giu;

/**
 * 模型偶尔会把协议起止标记塞进 msg.body / zh，甚至在下划线或 V2 周围插空格。
 * 这些是客户端控制符，任何情况下都不能作为角色气泡或译文展示。
 */
export function stripLeakedMarshmallowProtocolMarkers(value = '') {
  return String(value || '')
    .replace(LOOSE_CHAT_PROTOCOL_MARKER_RE, ' ')
    .replace(TRANSLATED_CHAT_PROTOCOL_MARKER_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 剥离隐藏 CoT 思考块（成对块 + 未闭合的尾块），永不外显也不落库。
 * 未闭合时保留其后出现的协议块/JSONL，避免 Gemini 截断思维链后整段协议被吞掉。
 */
export function stripThinkingBlocks(rawText = '') {
  // 兼容中转直接把模型原生 <think> / <thinking> 标签留在 content 里。
  // 必须在任何业务协议解析之前整块移除，否则思考区里预演的未闭合协议标记
  // 会错误地与正式答案末尾的 END 标记配对，吞掉中间的可见正文。
  let text = String(rawText || '')
    // think / thinking 都是常见原生标签；结束标签偶尔还会被兼容中转改成另一种拼法。
    .replace(/<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, '');
  if (!text.includes(THINKING_START)) return text;
  text = text.replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/g, '');
  const openIdx = text.indexOf(THINKING_START);
  if (openIdx < 0) return text;
  const before = text.slice(0, openIdx);
  const afterThinking = text.slice(openIdx + THINKING_START.length);
  let keepFrom = afterThinking.length;
  for (const marker of MARSHMALLOW_PROTOCOL_MARKERS) {
    const i = afterThinking.indexOf(marker.start);
    if (i >= 0 && i < keepFrom) keepFrom = i;
  }
  const sendBlockMatch = afterThinking.match(/(?:^|\n)\s*(?:【|\[)\s*发送\s*[:：·•]\s*(?:私聊|群聊|幕后|建群)\s*[:：·•]/);
  if (sendBlockMatch && sendBlockMatch.index >= 0 && sendBlockMatch.index < keepFrom) {
    keepFrom = sendBlockMatch.index;
  }
  const bareJsonMatch = afterThinking.match(/(?:^|\n)\s*\{\s*"(?:t|type)"/);
  if (bareJsonMatch && bareJsonMatch.index >= 0 && bareJsonMatch.index < keepFrom) {
    keepFrom = bareJsonMatch.index;
  }
  return before + afterThinking.slice(keepFrom);
}

/**
 * 提取由提示词要求写进 content 的可核验思维链回执，并返回已剥离的正文。
 * 它与供应商 reasoning_content 分开：这里只认棉花糖机自己的边界标记。
 */
export function extractPromptedThinkingBlock(rawText = '') {
  const text = String(rawText || '');
  const start = text.indexOf(THINKING_START);
  if (start < 0) {
    return { body: stripThinkingBlocks(text), thinkingText: '', status: 'missing' };
  }
  const contentStart = start + THINKING_START.length;
  const end = text.indexOf(THINKING_END, contentStart);
  if (end < 0) {
    return {
      body: stripThinkingBlocks(text),
      thinkingText: text.slice(contentStart).trim().slice(0, 4000),
      status: 'truncated',
    };
  }
  const thinkingText = text.slice(contentStart, end).trim();
  const body = `${text.slice(0, start)}${text.slice(end + THINKING_END.length)}`;
  return {
    body: stripThinkingBlocks(body),
    thinkingText,
    status: thinkingText ? 'complete' : 'empty',
  };
}

/** 截断回复里可兜底落库的气泡类事件 */
export const MARSHMALLOW_SALVAGE_BUBBLE_TYPES = new Set([
  'msg', 'narration', 'sticker', 'react', 'voice', 'image', 'textimg', 'gen_image', 'dice', 'link', 'location', 'order_share', 'html_widget',
]);

export function isSalvageableMarshmallowBubbleEvent(event = {}) {
  const t = String(event?.t || '').trim();
  if (!MARSHMALLOW_SALVAGE_BUBBLE_TYPES.has(t)) return false;
  if (t === 'narration') return !!cleanString(event.body || event.text || event.content);
  const actor = getEventActor(event);
  if (!actor) return false;
  if (t === 'msg') return !!cleanString(event.body || event.text || event.content);
  if (t === 'sticker') return !!cleanString(event.name || event.sticker || event.stickerName || event.body || event.text);
  if (t === 'react') return !!cleanString(event.emoji || event.body || event.text);
  if (t === 'voice') return !!cleanString(event.text || event.body || event.content);
  if (t === 'image' || t === 'gen_image' || t === 'textimg') {
    return !!cleanString(event.prompt || event.body || event.text || event.url || event.src);
  }
  if (t === 'dice') return true;
  if (t === 'link') return !!cleanString(event.url);
  if (t === 'location') return !!cleanString(event.place || event.name || event.body || event.text);
  if (t === 'order_share') return !!cleanString(event.title || event.product || event.name || event.body || event.text);
  if (t === 'html_widget') return !!cleanString(event.id || event.extensionId)
    && (!!cleanString(event.content || event.body || event.text) || Object.keys(normalizeHtmlExtensionFields(event.fields || event.data)).length > 0);
  return false;
}

export function filterSalvageableMarshmallowBubbleEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter(isSalvageableMarshmallowBubbleEvent);
}

function extractCompleteJsonObjectsFromText(text = '') {
  const objects = [];
  const raw = String(text || '');
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf('{', i);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < raw.length; j += 1) {
      const c = raw[j];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break;
    const slice = raw.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objects.push(parsed);
    } catch {
      /* skip malformed */
    }
    i = end + 1;
  }
  return objects;
}

function cleanString(v = '') {
  return String(v ?? '').trim();
}

const OBJECT_PLACEHOLDER_TEXT_RE = /^\[\s*(?:object\s+object|对象\s*对象)\s*\]$/iu;

function extractProtocolText(value, nestedKeys = [], depth = 0) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = cleanString(value);
    return OBJECT_PLACEHOLDER_TEXT_RE.test(text) ? '' : text;
  }
  if (!isPlainObject(value) || depth >= 2) return '';
  for (const key of nestedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const text = extractProtocolText(value[key], nestedKeys, depth + 1);
    if (text) return text;
  }
  return '';
}

function pickProtocolText(values = [], nestedKeys = []) {
  let invalid = false;
  for (const value of values) {
    if (value == null || value === '') continue;
    const text = extractProtocolText(value, nestedKeys);
    if (text) return { text, invalid: false };
    invalid = true;
  }
  return { text: '', invalid };
}

function isJsonStringBoundary(text = '', quoteIndex = 0) {
  const tail = String(text || '').slice(quoteIndex + 1);
  const trimmed = tail.replace(/^\s+/, '');
  if (!trimmed) return true;
  if (trimmed[0] === ':' || trimmed[0] === '}' || trimmed[0] === ']') return true;
  if (trimmed[0] !== ',') return false;
  const afterComma = trimmed.slice(1).replace(/^\s+/, '');
  return /^"(?:\\.|[^"\\])*"\s*:/.test(afterComma)
    || /^(?:[}\]]|\{|\[|-?\d|true\b|false\b|null\b)/.test(afterComma);
}

/**
 * 某些兼容模型会在 JSON 字符串正文里直接写半角引号，例如
 * `"zh":"让我去"争取"某个版本"`。只在严格 JSON 解析失败后使用此修复：
 * 明显不是字段/值边界的引号按正文引号转义，结构引号保持不变。
 */
export function repairUnescapedJsonStringQuotes(text = '') {
  const source = String(text || '');
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      output += char;
      escaped = true;
      continue;
    }
    if (char !== '"') {
      output += char;
      continue;
    }
    if (isJsonStringBoundary(source, i)) {
      output += char;
      inString = false;
    } else {
      output += '\\"';
    }
  }
  return output;
}

function parseProtocolJson(text = '') {
  const source = String(text || '');
  try {
    return JSON.parse(source);
  } catch (originalError) {
    const repaired = repairUnescapedJsonStringQuotes(source);
    if (repaired === source) throw originalError;
    try {
      return JSON.parse(repaired);
    } catch (_) {
      throw originalError;
    }
  }
}

/**
 * 兼容模型偶尔会在一个 msg.body 里误吞下一条事件的字段，例如：
 * `"msg","from":"C1","body":"真正台词"`。这通常来自截断输出配合未转义
 * 引号修复；能明确找到最后一层 body 时只保留台词，无法确认时拒绝把协议碎片展示。
 */
export function sanitizeLeakedMarshmallowMessageBody(value = '') {
  let body = stripLeakedMarshmallowProtocolMarkers(
    extractProtocolText(value, ['body', 'text', 'content', 'message', 'value']),
  );
  if (!body) return '';
  for (let depth = 0; depth < 2; depth += 1) {
    const nested = parseJsonObjectValue(body);
    if (nested && normalizeEventType(nested.t || nested.type) === 'msg') {
      const inner = pickProtocolText(
        [nested.body, nested.text, nested.content],
        ['body', 'text', 'content', 'message', 'value'],
      ).text;
      if (!inner || inner === body) return '';
      body = stripLeakedMarshmallowProtocolMarkers(inner);
      continue;
    }
    const fragment = body.match(
      /^(?:\{\s*)?(?:"(?:t|type)"\s*:\s*)?"?msg"?\s*,\s*"(?:from|actor|senderId)"\s*:\s*"[^"]*"\s*,\s*"(?:body|text|content)"\s*:\s*"([\s\S]*)$/iu,
    );
    if (fragment) {
      body = String(fragment[1] || '').replace(/"\s*\}?\s*$/u, '').trim();
      continue;
    }
    if (/^(?:\{\s*)?(?:"(?:t|type)"\s*:\s*)?"?(?:private_msg|peer_private|backstage)"?\s*,/iu.test(body)) {
      // 私信/幕后事件即使被截断修复误吞进 msg.body，也仍然是隐藏的跨窗路由数据。
      // 不能像普通 msg 残片那样抽出 body，否则私聊内容会在来源群里重复裸显。
      return '';
    }
    break;
  }
  if (/^(?:\{|\[)?\s*"(?:t|type|msg|from|actor|senderId|body|text|content)"\s*[:,]/iu.test(body)) {
    return '';
  }
  return body;
}

function stripUnknownStickerPlaceholders(text = '') {
  return String(text || '')
    .replace(/\[(?:表情包|贴纸)(?:[:：]\s*[^\]]+)?\]/g, '')
    .replace(/(?:表情包|贴纸)\s*[：:]\s*[^\n\r，。！？]{1,48}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeCustomStateFields(value = {}) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 16)) {
    const key = cleanString(rawKey).slice(0, 40);
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    const text = cleanString(
      isPlainObject(rawValue) || Array.isArray(rawValue)
        ? JSON.stringify(rawValue)
        : rawValue,
    ).slice(0, 500);
    if (text) out[key] = text;
  }
  return out;
}

const STATE_PROTOCOL_KEYS = new Set([
  't', 'type', 'from', 'actor', 'senderId',
  'inner', 'innerVoice', 'zh', 'innerZh',
  'intent', 'plan', 'mood', 'status', 'state', 'moodShift',
  'custom', 'fields', 'extra',
  'sourceIndex', 'id', 'timestamp', 'createdAt', 'updatedAt',
  'fromName', 'fromLabel', 'ephemeralNpc', 'synthesizedFromMsg',
  'sourceRoundId', 'aiRoundId',
]);

/**
 * 兼容部分模型把用户要求的自定义字段直接写在 state 顶层。
 * 显式 custom/fields/extra 优先；其余非协议字段安全收进 custom，避免导入
 * 自定义心声方案后模型明明生成了 book_name/quote 等内容却在解析时被丢掉。
 */
export function normalizeStateCustomFields(raw = {}) {
  if (!isPlainObject(raw)) return {};
  const loose = {};
  for (const [key, value] of Object.entries(raw)) {
    if (STATE_PROTOCOL_KEYS.has(key)) continue;
    loose[key] = value;
  }
  return {
    ...normalizeCustomStateFields(loose),
    ...normalizeCustomStateFields(raw.extra),
    ...normalizeCustomStateFields(raw.fields),
    ...normalizeCustomStateFields(raw.custom),
  };
}

function cleanActorField(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return cleanString(value);
}

function pickSpecificActorField(primaryValues = [], aliasValues = []) {
  const primary = primaryValues.map(cleanActorField).find(Boolean) || '';
  if (primary && !isGenericPeerActorLabel(primary)) return primary;
  const aliases = aliasValues.map(cleanActorField).filter(Boolean);
  // Some compatible models keep the schema placeholder in `from`, but also
  // provide the real speaker in a common alias field. Prefer that explicit
  // identity instead of letting every bubble collapse to “群成员”.
  return aliases.find((value) => !isGenericPeerActorLabel(value))
    || primary
    || aliases[0]
    || '';
}

function getEventActor(event = {}) {
  return pickSpecificActorField(
    [event.from, event.actor, event.senderId],
    [event.speakerId, event.speaker, event.sender, event.actorName, event.speakerName, event.senderName],
  );
}

function getMessageEventActor(event = {}) {
  return pickSpecificActorField(
    [event.from, event.actor, event.senderId],
    [
      event.speakerId,
      event.speaker,
      event.sender,
      event.actorName,
      event.speakerName,
      event.senderName,
      event.authorId,
      event.author,
      // `name` is safe only for msg. Sticker/location/etc use it as content.
      event.name,
    ],
  );
}

function getSideChatLineActor(line = {}) {
  if (!line || typeof line !== 'object') return '';
  return pickSpecificActorField(
    [line.from, line.actor, line.senderId],
    [line.speakerId, line.speaker, line.sender, line.actorName, line.speakerName, line.senderName, line.name],
  );
}

function normalizeSideChatLines(raw = {}, fallbackFrom = '') {
  const source = [raw.lines, raw.messages, raw.dialogue, raw.chat]
    .find((value) => Array.isArray(value));
  const rows = source || (fallbackFrom || raw.body || raw.text || raw.content
    ? [{
      from: fallbackFrom,
      body: raw.body || raw.text || raw.content,
      zh: raw.zh || raw.translation,
    }]
    : []);
  return rows.map((line) => {
    if (typeof line === 'string') {
      return { from: cleanString(fallbackFrom), body: cleanString(line) };
    }
    if (!line || typeof line !== 'object') return null;
    const from = getSideChatLineActor(line);
    const body = cleanString(line.body || line.text || line.content || line.message);
    return {
      ...line,
      ...(from ? { from } : {}),
      ...(body ? { body } : {}),
    };
  }).filter(Boolean);
}

/**
 * 每条 offline_invite 都要有路程摘要，不能让角色看起来是「瞬移」过去的。
 * 优先用 place 或 toUserPlace 给出的目的地；万一 AI 两个都没填（prompt 已要求必填，这里是兜底），
 * 就当作角色会主动出门去找用户，用用户设置的位置（或通用兜底）规划一次路程，绝不留白。
 */
async function buildOfflineInviteRouteForEvent({ senderId, place, toUserPlace }) {
  const character = await getCharacter(senderId).catch(() => null);
  if (!character) return null;
  const goingToUser = toUserPlace || !place;
  let destinationLabel = place;
  let destinationLocation = '';
  if (goingToUser) {
    const user = await getCurrentUser().catch(() => null);
    destinationLabel = cleanString(user?.myPlaceLabel) || '你那边';
    destinationLocation = cleanString(user?.myPlaceLocation);
  }
  if (!destinationLabel) destinationLabel = '你那边';
  return buildOfflineInviteRoutePlan({ character, destinationLabel, destinationLocation }).catch(() => null);
}

function visibleMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m && !m.deleted && !m.recalled);
}

const REPLY_TARGET_BLOCKED_TYPES = new Set(['system', 'chatAction']);

/**
 * 引用属于用户可见的聊天动作，只能指向真正的聊天内容。
 * 指导模式气泡、旁白和系统提示仍可展示/删除，但绝不能进入模型的 reply 候选，
 * 否则模型会把幕后指导当成群友发言引用到公屏。
 */
export function isMarshmallowReplyTargetEligible(message) {
  if (!message || message.deleted || message.recalled) return false;
  const senderId = cleanString(message.senderId);
  const type = cleanString(message.type || 'text');
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  if (!senderId || senderId === 'system' || senderId === 'guidance') return false;
  if (REPLY_TARGET_BLOCKED_TYPES.has(type)) return false;
  if (metadata.guidanceMode === true || metadata.narratorBeat === true || metadata.plotExplain === true) return false;
  return true;
}

function replyTargetMessages(messages = []) {
  return visibleMessages(messages).filter(isMarshmallowReplyTargetEligible);
}

function resolveReplyTargetRef(ref, history = [], round = []) {
  return resolveTargetRef(ref, replyTargetMessages(history), replyTargetMessages(round));
}

export function resolveTargetRef(ref, history = [], round = []) {
  if (!ref) return null;
  const pool = [...visibleMessages(history), ...visibleMessages(round)];
  if (typeof ref === 'string') {
    const hit = pool.find((m) => m.id === ref);
    if (hit) return hit;
    const roundIndex = ref.match(/^round_([1-9]\d*)$/);
    if (roundIndex) {
      return visibleMessages(round)[Number(roundIndex[1]) - 1] || null;
    }
    if (TARGET_SELECTORS.has(ref)) {
      if (ref === 'last_user') return [...pool].reverse().find((m) => m.senderId === 'user') || null;
      if (ref === 'last_user_image') return [...pool].reverse().find((m) => m.senderId === 'user' && m.type === 'image') || null;
      if (ref === 'last_image') return [...pool].reverse().find((m) => m.type === 'image') || null;
      if (ref === 'last_user_link') return [...pool].reverse().find((m) => m.senderId === 'user' && m.type === 'link') || null;
      if (ref === 'last_link') return [...pool].reverse().find((m) => m.type === 'link') || null;
      if (ref === 'last_ai') return [...pool].reverse().find((m) => m.senderId && m.senderId !== 'user') || null;
      if (ref === 'round_prev') return pool[pool.length - 1] || null;
      if (ref === 'last_in_room') return pool[pool.length - 1] || null;
      if (ref === 'last_redpacket') return [...pool].reverse().find((m) => m.type === 'redpacket') || null;
      if (ref === 'last_transfer') {
        const pending = [...pool].reverse().find((m) => {
          if (m.type !== 'transfer') return false;
          const st = String(m.metadata?.transferState || 'pending').trim();
          return st === 'pending' || !st;
        });
        return pending || [...pool].reverse().find((m) => m.type === 'transfer') || null;
      }
    }
    return null;
  }
  if (isPlainObject(ref)) {
    if (ref.id) return pool.find((m) => m.id === ref.id) || null;
    if (ref.selector) {
      // 模型经常把真实消息 id 写进 selector（{"selector":"msg_xxx"}），而不是
      // 协议示例里的 {"id":"msg_xxx"}。字符串解析本来就同时支持真实 id 与
      // last_user / round_prev 等别名，这里统一走同一入口，不能因此吞掉整条正文。
      return resolveTargetRef(cleanString(ref.selector), history, round);
    }
  }
  return null;
}

function normalizeReplyMatchText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * 模型偶尔把 reply 写进正文且只带被引原文（如 [回复: "啧啧啧"]）。
 * 优先按原文反查真实消息，避免缺少 senderId 时把角色自己的原话误标成用户。
 */
export function resolveReplyBracketTarget(replyBracket, history = [], round = []) {
  if (!replyBracket) return null;
  const label = cleanString(replyBracket.senderName);
  if (isTargetSelector(label)) {
    return resolveReplyTargetRef(label, history, round);
  }

  const preview = normalizeReplyMatchText(replyBracket.preview);
  if (!preview) return null;
  const pool = [...replyTargetMessages(history), ...replyTargetMessages(round)];
  // 部分模型会把真实消息 id 误写进正文兜底的「发送者」槽位：
  // [回复 msg_xxx: "原文"]。先按消息 id 解析，避免把 msg_xxx 当昵称落库并上屏。
  const idTarget = label ? pool.find((message) => cleanString(message?.id) === label) : null;
  if (idTarget) return idTarget;
  const labelKey = label.toLocaleLowerCase();
  const matchesLabel = (message) => {
    if (!labelKey) return true;
    const senderId = cleanString(message?.senderId).toLocaleLowerCase();
    const senderName = cleanString(message?.senderName).toLocaleLowerCase();
    return senderId === labelKey || senderName === labelKey;
  };
  const matchesPreview = (message) => (
    normalizeReplyMatchText(getReplyContentPreview(message)) === preview
  );

  return [...pool].reverse().find((message) => matchesLabel(message) && matchesPreview(message))
    || (!label ? [...pool].reverse().find(matchesPreview) : null)
    || null;
}

export function resolveConsistentReplyTarget(
  structuredTarget,
  replyBracket,
  history = [],
  round = [],
) {
  const bracketTarget = resolveReplyBracketTarget(replyBracket, history, round);
  if (!bracketTarget) return structuredTarget || null;
  if (!structuredTarget || structuredTarget.id === bracketTarget.id) return bracketTarget;

  const bracketPreview = normalizeReplyMatchText(replyBracket?.preview);
  const bracketSelector = cleanString(replyBracket?.senderName);
  // 有可核验原文或明确 selector 时，正文括号是这条消息自己的局部证据。
  // 部分模型会同时写 reply 字段与 [回复……]，两处冲突时不能删掉真实引文后
  // 继续展示另一个不相干目标；只有括号无法反查时才保留结构化目标。
  if (bracketPreview || isTargetSelector(bracketSelector)) return bracketTarget;
  return structuredTarget;
}

async function attachReplyTarget(draft, target, options = {}) {
  if (!draft || !target) return draft;
  // 只在能拿到真实昵称时才落库；拿不到就留空——replyMeta.replySenderId 已经存了目标 id，
  // 渲染时会用当时最新的角色/备注名重新解析一次。这里绝不能兜底成 target.senderId 本身，
  // 否则内部 id（char_xxx/npc_xxx/字面 user）会原样存进库，往后每次显示都是脏数据。
  // resolveSenderName 是 async 函数，之前这里没有 await，把 Promise 对象当真值用，双重出错。
  let resolvedName = sanitizeReplySenderName(target.senderName || '', {
    userName: options.currentUserName,
  });
  if (!resolvedName && typeof options.resolveSenderName === 'function') {
    resolvedName = sanitizeReplySenderName(await options.resolveSenderName(target.senderId), {
      userName: options.currentUserName,
    });
  }
  const fields = buildReplyTargetFields(target, {
    getContentPreview: getReplyContentPreview,
    resolveSenderLabel: () => resolvedName,
  });
  draft.replyTo = fields.replyTo;
  draft.replyPreview = fields.replyPreview;
  draft.metadata = { ...(draft.metadata || {}), ...fields.replyMeta };
  return draft;
}

function isTextCardImageIntent(event = {}) {
  const text = cleanString(event.text || event.body || event.content);
  const intent = cleanString(event.intent || event.reason || '');
  const tags = Array.isArray(event.tags) ? event.tags.map(cleanString).filter(Boolean).join(' ') : '';
  const haystack = `${text} ${intent} ${tags}`.toLowerCase();
  if (!haystack.trim()) return false;
  if (/(人脸|脸部|自拍|肖像|头像|证件照|合照|可识别|真人|人物|portrait|selfie|face|identifiable|likeness)/iu.test(haystack)) return false;
  return /(备忘录|便签|公告|通知|聊天截图|聊天记录|截图|文字截图|手写|纸条|清单|问卷|表格|菜单|小票|票据|账单|收据|公告卡|文字卡|memo|note|announcement|screenshot|chat screenshot|menu|receipt|bill|form|questionnaire)/iu.test(haystack);
}

function buildPromptFromTextImageFallback(event = {}) {
  const text = cleanString(event.text || event.body || event.content);
  const intent = cleanString(event.intent || event.reason || '');
  const base = [text, intent].filter(Boolean).join('；').slice(0, 420);
  if (isTextCardImageIntent(event)) {
    const visibleText = text.slice(0, 280);
    return `designed text-based image, clean readable layout, exact visible Chinese text: "${visibleText}", ${intent || 'note card'}, no people, no human face`;
  }
  const personScene = /(人脸|脸部|自拍|肖像|头像|证件照|合照|可识别|真人|人物|portrait|selfie|face|identifiable|likeness)/iu
    .test(`${text} ${intent}`);
  return personScene
    ? `portrait, selfie, identifiable person, ${base || 'candid portrait'}, natural light, candid phone photo`
    : `photorealistic no-face everyday-life photo, ${base || 'ordinary daily-life scene'}, natural light, candid phone photo, no human face, no readable private ID`;
}

function imageSubjectIds(event = {}) {
  const raw = event.subjects ?? event.subjectIds ?? event.actors ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return [...new Set(list
    .map((item) => cleanString(item && typeof item === 'object'
      ? (item.id || item.actorId || item.subjectId)
      : item))
    .filter(Boolean))]
    .slice(0, 4);
}

function buildGenImagePlaceholderMetadata(event = {}, baseMetadata = {}, options = {}) {
  const prompt = cleanString(event.prompt || buildPromptFromTextImageFallback(event));
  return {
    ...baseMetadata,
    protocol: MARSHMALLOW_CHAT_PROTOCOL,
    sourceEventIndex: event.sourceIndex,
    marshmallowEventType: 'gen_image',
    generatedImage: true,
    generatingImage: true,
    generationStartedAt: Date.now(),
    prompt,
    ...(imageSubjectIds(event).length ? { imageSubjectIds: imageSubjectIds(event) } : {}),
    ...(event.people ? { imagePeople: cleanString(event.people).toLowerCase() } : {}),
    ...(event.identity ? { imageIdentity: cleanString(event.identity).toLowerCase() } : {}),
    ...(event.caption ? { caption: event.caption, text: event.caption } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.intent ? { intent: event.intent } : {}),
    ...buildHiddenStateMetadata(event),
    ...(options.textimgFallbackBlocked ? { textimgFallbackBlocked: true } : {}),
  };
}

function socialPostTargetLabel(target = '') {
  return {
    moments: '朋友圈',
    weibo: '微博',
    forum: '论坛',
  }[cleanString(target).toLowerCase()] || '社交动态';
}

function parseLooseImageBodyAsTextImage(text = '') {
  const raw = cleanString(text);
  if (!raw || raw.length > 260) return null;
  // 方括号 []／全角方括号［］／中文书名号式方括号【】，模型三种都写过，得一起兜底识别
  const match = raw.match(/^[\[［【]\s*(?:图片|图|文字图|照片|image|pic|photo)\s*[:：]\s*([\s\S]{2,220}?)\s*[\]］】]$/i);
  if (!match) return null;
  const body = cleanString(match[1]);
  if (!body || /^https?:\/\//i.test(body) || /^data:image\//i.test(body)) return null;
  return body;
}

function isPlayableImageUrl(value = '') {
  return /^https?:\/\//i.test(String(value || '').trim()) || /^data:image\//i.test(String(value || '').trim());
}

function isBareImagePlaceholder(text = '') {
  // 同上：兼容模型偶尔把 [图片] 写成全角【图片】的情况，否则会原样漏成文字气泡
  return /^[\[［【]?\s*(?:图片|图|照片|pic|photo|image)\s*[\]］】]?$/iu.test(String(text || '').trim());
}

function resolveRelayImageSource(ref, history = [], round = []) {
  const target = ref
    ? resolveTargetRef(ref, history, round)
    : resolveTargetRef('last_image', history, round);
  if (!target || target.type !== 'image') return null;
  const url = String(target.content || target.metadata?.url || target.metadata?.imageUrl || '').trim();
  if (!isPlayableImageUrl(url)) return null;
  return target.content === url ? target : { ...target, content: url };
}

function isRelayableLinkUrl(value = '') {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function resolveRelayLinkSource(ref, history = [], round = []) {
  const target = ref
    ? resolveTargetRef(ref, history, round)
    : resolveTargetRef('last_user_link', history, round);
  if (!target || target.type !== 'link') return null;
  const url = String(target.content || target.metadata?.url || '').trim();
  if (!isRelayableLinkUrl(url)) return null;
  return target;
}

function bundleItemFromRelay(relayRef, history = [], round = []) {
  const src = resolveTargetRef(relayRef, history, round);
  if (!src) return null;
  if (src.type === 'link') {
    const url = String(src.content || src.metadata?.url || '').trim();
    if (!isRelayableLinkUrl(url)) return null;
    return {
      senderId: src.senderId,
      senderName: src.senderName,
      type: 'link',
      content: url,
      timestamp: Number(src.timestamp || Date.now()) || Date.now(),
      relayFromMessageId: src.id,
      metadata: { ...(src.metadata || {}), relayLink: true, relayFromMessageId: src.id },
    };
  }
  return {
    senderId: src.senderId,
    senderName: src.senderName,
    type: src.type || 'text',
    content: src.content || '',
    timestamp: Number(src.timestamp || Date.now()) || Date.now(),
    relayFromMessageId: src.id,
  };
}

/**
 * 幕后 lines 里的转发图：line.relay 指向真实图片消息，或 body 只写了 [图片]/【图片】占位时
 * 折算成最近一张真实图片。折算成功的 line 标记 kind:'image' 并带上真实 URL；
 * 找不到真实图片的占位 line 直接丢弃，避免幕后群冒出一句 "[图片]" 文字气泡。
 */
function resolveBackstageLineImages(event, history = [], round = [], warnings = []) {
  const lines = Array.isArray(event.lines) ? event.lines : [];
  const resolved = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') {
      continue;
    }
    const body = cleanString(line.body || line.text || line.content);
    const bodyIsPlaceholder = isBareImagePlaceholder(body);
    const relaySelector = typeof line.relay === 'string'
      ? line.relay
      : (line.relay && typeof line.relay === 'object' ? line.relay.selector : '');
    const wantsLinkRelay = relaySelector === 'last_user_link' || relaySelector === 'last_link';
    if (!line.relay && !bodyIsPlaceholder) {
      resolved.push(line);
      continue;
    }
    if (wantsLinkRelay) {
      const linkSrc = resolveRelayLinkSource(line.relay, history, round);
      if (linkSrc) {
        const linkUrl = String(linkSrc.content || linkSrc.metadata?.url || '').trim();
        resolved.push({
          ...line,
          kind: 'link',
          body: '',
          text: '',
          content: '',
          linkUrl,
          linkMetadata: { ...(linkSrc.metadata || {}), relayLink: true, relayFromMessageId: linkSrc.id },
          relayFromMessageId: linkSrc.id,
        });
        if (body && !bodyIsPlaceholder) {
          resolved.push({ ...line, relay: undefined, body });
        }
        continue;
      }
      if (body && !bodyIsPlaceholder) {
        resolved.push({ ...line, relay: undefined, body });
        warnings.push({ code: 'backstage_relay_not_found', sourceEventIndex: event.sourceIndex });
        continue;
      }
      warnings.push({ code: 'backstage_link_relay_dropped', sourceEventIndex: event.sourceIndex });
      continue;
    }
    const src = resolveRelayImageSource(line.relay || { selector: 'last_image' }, history, round);
    if (src) {
      resolved.push({
        ...line,
        kind: 'image',
        body: '',
        text: '',
        content: '',
        imageUrl: src.content,
        relayFromMessageId: src.id,
      });
      // 带着一句真实台词一起转发时，拆成「图 + 话」两条，像真人先甩图再补一句
      if (body && !bodyIsPlaceholder) {
        resolved.push({ ...line, relay: undefined, body });
      }
      continue;
    }
    if (body && !bodyIsPlaceholder) {
      // relay 指错了目标但台词是真的：退回纯文字，不整条丢
      resolved.push({ ...line, relay: undefined, body });
      warnings.push({ code: 'backstage_relay_not_found', sourceEventIndex: event.sourceIndex });
      continue;
    }
    warnings.push({ code: 'backstage_image_placeholder_dropped', sourceEventIndex: event.sourceIndex });
  }
  return { ...event, lines: resolved };
}

function bundleItemFromSpec(item, history = [], round = [], fallback = {}) {
  if (!item) return null;
  const directNested = parseJsonObjectValue(item);
  const source = directNested || (typeof item === 'object' ? item : { body: cleanString(item) });
  if (source.relay) return bundleItemFromRelay(source.relay, history, round);
  const nested = parseJsonObjectValue(source.body ?? source.text ?? source.content);
  const nestedType = normalizeEventType(nested?.t || nested?.type);
  const spec = nestedType === 'msg'
    ? {
      ...source,
      ...nested,
      from: nested.from || source.from,
      senderId: nested.senderId || source.senderId,
    }
    : source;
  const body = cleanString(spec.body || spec.text || spec.content);
  if (!body) return null;
  const explicitType = cleanString(spec.type || spec.kind || spec.t).toLowerCase();
  const stamp = Number(spec.timestamp || fallback.timestamp) || 0;
  const senderId = cleanString(spec.from || spec.senderId || fallback.senderId);
  const senderName = cleanString(spec.fromName || spec.senderName || fallback.senderName);
  if (explicitType === 'image' || explicitType === 'pic' || explicitType === 'photo') {
    const url = cleanString(spec.url || spec.imageUrl || spec.src || spec.content || spec.body);
    if (isPlayableImageUrl(url)) {
      return {
        senderId,
        senderName,
        type: 'image',
        content: url,
        ...(stamp > 0 ? { timestamp: stamp } : {}),
      };
    }
    if (isBareImagePlaceholder(body)) {
      return bundleItemFromRelay({ selector: 'last_image' }, history, round);
    }
    return null;
  }
  if (isBareImagePlaceholder(body)) {
    return bundleItemFromRelay({ selector: 'last_image' }, history, round);
  }
  if (explicitType === 'link') {
    const url = cleanString(spec.url || spec.content || spec.body);
    if (!isRelayableLinkUrl(url)) return null;
    return {
      senderId,
      senderName,
      type: 'link',
      content: url,
      metadata: { ...(spec.metadata || {}), url },
      ...(stamp > 0 ? { timestamp: stamp } : {}),
    };
  }
  return {
    senderId,
    senderName,
    type: 'text',
    content: body,
    ...(stamp > 0 ? { timestamp: stamp } : {}),
  };
}

/** 合并转发卡片的摘要片段：图片/语音等非文本项只给类型占位符，绝不把 base64/URL 原文拼进摘要 */
function bundleItemPreviewText(item) {
  if (!item) return '';
  if (item.type === 'image') return '[图片]';
  if (item.type === 'link') return '[链接]';
  if (item.type === 'voice' || item.type === 'voiceCall') return '[语音]';
  if (item.type === 'sticker') return '[表情包]';
  if (item.type === 'textimg') return '[文字图]';
  return String(item.content || '').trim().slice(0, 24);
}

function textImageTextFromImageLikeEvent(event = {}) {
  return cleanString(
    event.caption
    || event.text
    || event.body
    || event.prompt
    || event.reason
    || event.intent
  );
}

function textImageTextWithoutPrompt(event = {}) {
  return cleanString(
    event.caption
    || event.text
    || event.body
  );
}

function isSpecificLocationLabel(value = '') {
  const label = cleanString(value);
  if (!label) return false;
  return !/^(?:位置|地点|定位|当前位置|我的位置|共享位置|location|place)$/i.test(label);
}

function buildHiddenStateMetadata(event = {}) {
  // 心声/情绪已迁移到轮级 state 事件；此处仅作旧字段兜底，不再带 intent（易出戏）。
  const inner = cleanString(event.inner || event.innerVoice);
  const mood = cleanString(event.mood);
  const meta = {};
  if (inner) meta.innerVoice = inner;
  if (mood) meta.mood = mood;
  return meta;
}

const REPLY_EXPRESSION_DRIVES = new Set(['quiet', 'steady', 'engaged', 'overflowing']);

function normalizeReplyExpressionDrive(value) {
  const drive = cleanString(value).toLowerCase();
  return REPLY_EXPRESSION_DRIVES.has(drive) ? drive : 'steady';
}

function buildReplyCompositionMetadata(event = {}) {
  const version = Math.trunc(Number(event.compositionVersion || 0));
  const cleanList = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((item) => cleanString(item))
    .filter(Boolean))].slice(0, 24);
  const beatIds = cleanList(event.compositionBeatIds);
  const refs = cleanList(event.compositionRefs);
  const obligationRefs = cleanList(event.compositionObligationRefs);
  const ownedRefs = cleanList(event.compositionOwnedRefs);
  const acts = cleanList(event.compositionActs);
  const deliveries = (Array.isArray(event.compositionDeliveries)
    ? event.compositionDeliveries
    : [])
    .map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const beatId = cleanString(raw.beatId || raw.id);
      if (!beatId) return null;
      return {
        beatId,
        act: cleanString(raw.act || 'other') || 'other',
        refs: cleanList(raw.refs),
        obligationRefs: cleanList(raw.obligationRefs),
        ownedRefs: cleanList(raw.ownedRefs),
      };
    })
    .filter(Boolean)
    .slice(0, 24);
  if (version !== 1 || !beatIds.length) return {};
  return {
    replyCompositionVersion: version,
    replyCompositionBeatIds: beatIds,
    replyCompositionRefs: refs,
    replyCompositionObligationRefs: obligationRefs,
    replyCompositionOwnedRefs: ownedRefs,
    replyCompositionDeliveries: deliveries,
    replyCompositionActs: acts,
    replyCompositionRequired: event.compositionRequired === true,
    replyCompositionTopicMove: cleanString(event.compositionTopicMove || 'continue') || 'continue',
    replyCompositionExpressionDrive: normalizeReplyExpressionDrive(event.compositionExpressionDrive),
    replyCompositionExpressionReason: cleanString(event.compositionExpressionReason).slice(0, 160),
    replyCompositionExpressionDrivers: cleanList(event.compositionExpressionDrivers).slice(0, 5),
    replyCompositionExpressionSatisfied: event.compositionExpressionSatisfied === true,
    replyCompositionExpressionMinimumBeatCount: Math.max(
      0,
      Math.min(12, Math.trunc(Number(event.compositionExpressionMinimumBeatCount) || 0)),
    ),
    replyCompositionExpressionMinimumOwnedCount: Math.max(
      0,
      Math.min(12, Math.trunc(Number(event.compositionExpressionMinimumOwnedCount) || 0)),
    ),
    replyCompositionOriginIndexes: (Array.isArray(event.packingOriginIndexes)
      ? event.packingOriginIndexes
      : [])
      .map((item) => Number(item))
      .filter(Number.isFinite)
      .slice(0, 24),
  };
}

function normalizeEventType(raw = '') {
  const t = cleanString(raw).toLowerCase();
  if (t === 'type') return '';
  if (t === 'chatbundle' || t === 'merge_forward' || t === 'mergeforward') return 'chat_bundle';
  if (t === 'unsend' || t === 'retract' || t === 'withdraw') return 'recall';
  if (t === 'accept_transfer' || t === 'transfer_claim' || t === 'claim_transfer') return 'transfer_accept';
  if (t === 'return_transfer' || t === 'decline_transfer' || t === 'transfer_decline' || t === 'transfer_reject') return 'transfer_return';
  if (t === 'ordershare' || t === 'order_gift' || t === 'gift_order' || t === 'purchase_gift' || t === 'proxy_buy' || t === 'gift') return 'order_share';
  if (t === 'htmlwidget' || t === 'html_extension' || t === 'extension_widget') return 'html_widget';
  return EVENT_TYPES.has(t) ? t : '';
}

function parseJsonObjectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const raw = cleanString(value);
  if (!raw || !/^(?:```(?:json)?\s*)?\{/i.test(raw)) return null;
  const text = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function chatBundleItemSpecs(raw = {}) {
  const list = [
    raw.items,
    raw.messages,
    raw.records,
    raw.lines,
    raw.bundleItems,
  ].find(Array.isArray);
  if (list) return list;

  const content = raw.content ?? raw.body ?? raw.text;
  if (Array.isArray(content)) return content;
  if (content && typeof content === 'object') return [content];

  const text = cleanString(content);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch (_) {
    // 非 JSON 字符串就是模型实际想转发的正文，不能因字段名写错而整卡丢失。
  }
  return [{ from: getEventActor(raw), body: text }];
}

/**
 * 弱模型偶尔会把 chat_bundle 整个塞进 msg.body，旧逻辑会把这段 JSON 当普通气泡展示。
 * 只解包明确标注为合并转发的对象，普通代码片段仍按文本保留。
 */
function embeddedChatBundleFromMessage(raw = {}) {
  const nested = parseJsonObjectValue(raw.body ?? raw.text ?? raw.content);
  if (!nested || normalizeEventType(nested.t || nested.type) !== 'chat_bundle') return null;
  return {
    ...nested,
    t: 'chat_bundle',
    from: getEventActor(nested) || getEventActor(raw),
    to: nested.to ?? raw.to,
    room: nested.room ?? raw.room,
  };
}

function normalizeMarshmallowChatEvent(raw = {}, index = 0) {
  const errors = [];
  const t = normalizeEventType(raw.t || raw.type);
  if (!t) {
    errors.push({ index, code: 'unknown_type', line: JSON.stringify(raw).slice(0, 120) });
    return { event: null, errors };
  }
  const base = { ...raw, t, sourceIndex: index };
  if (t === 'social_post') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        target: cleanString(raw.target).toLowerCase(),
        brief: cleanString(raw.brief || raw.intent || raw.body).slice(0, 300),
      },
      errors,
    };
  }
  if (t === 'open_alias') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        intent: cleanString(raw.intent || raw.brief || raw.body).slice(0, 300),
        consult: cleanString(raw.consult).slice(0, 160),
      },
      errors,
    };
  }
  if (t === 'social_react') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        target: cleanString(raw.target || raw.platform).toLowerCase(),
        action: cleanString(raw.action || raw.kind).toLowerCase(),
        who: cleanString(raw.who || raw.author || raw.to).slice(0, 80),
        text: cleanString(raw.text || raw.comment || raw.body).slice(0, 200),
      },
      errors,
    };
  }
  if (t === 'share_back') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        topic: cleanString(raw.topic || raw.brief || raw.reason || raw.body).slice(0, 200),
      },
      errors,
    };
  }
  if (t === 'alias_poke') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        note: cleanString(raw.note || raw.intent || raw.reason || raw.body).slice(0, 200),
      },
      errors,
    };
  }
  if (t === 'next_reply_delay') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        minutes: Math.trunc(Number(raw.minutes || raw.delayMinutes || 0)),
        reason: cleanString(raw.reason || raw.intent || raw.body).slice(0, 300),
      },
      errors,
    };
  }
  if (t === 'wait_mood') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        level: cleanString(raw.level || raw.mood).toLowerCase(),
        reason: cleanString(raw.reason || raw.intent || raw.body).slice(0, 200),
      },
      errors,
    };
  }
  if (t === 'hard_offline') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        action: cleanString(raw.action).toLowerCase() === 'clear' ? 'clear' : 'start',
        minutes: Math.trunc(Number(raw.minutes || raw.durationMinutes || 0)),
        peekMinutes: Math.trunc(Number(raw.peekMinutes || 0)),
        reason: cleanString(raw.reason || raw.intent || raw.body).slice(0, 300),
      },
      errors,
    };
  }
  if (t === 'presence') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        minutes: Math.trunc(Number(raw.minutes || raw.windowMinutes || 0)),
        reason: cleanString(raw.reason || raw.intent || raw.body).slice(0, 300),
      },
      errors,
    };
  }
  if (t === 'narration') {
    return {
      event: {
        ...base,
        body: cleanString(raw.body || raw.text || raw.content),
        sound: normalizeNarrationSoundPlan(raw.sound || raw.sounds || raw.soundCues),
      },
      errors,
    };
  }
  if (t === 'msg') {
    const embeddedBundle = embeddedChatBundleFromMessage(raw);
    if (embeddedBundle) return normalizeMarshmallowChatEvent(embeddedBundle, index);
  }
  if (t === 'msg' || t === 'sticker') {
    const bodyResult = t === 'msg'
      ? pickProtocolText(
        [raw.body, raw.text, raw.content],
        ['body', 'text', 'content', 'message', 'value'],
      )
      : { text: cleanString(raw.body || raw.text || raw.content), invalid: false };
    const rawBody = bodyResult.text;
    const body = t === 'msg'
      ? sanitizeLeakedMarshmallowMessageBody(rawBody)
      : stripLeakedMarshmallowProtocolMarkers(rawBody);
    const rawTranslation = t === 'msg'
      ? pickProtocolText(
        [raw.zh, raw.translation],
        ['zh', 'translation', 'text', 'content', 'value'],
      ).text
      : cleanString(raw.zh || raw.translation);
    const translation = stripLeakedMarshmallowProtocolMarkers(rawTranslation);
    if (t === 'msg' && !rawBody && bodyResult.invalid) {
      errors.push({ index, code: 'invalid_msg_body_type', line: '[non-text message body]' });
      return { event: null, errors };
    }
    if (t === 'msg' && rawBody && !body) {
      errors.push({ index, code: 'protocol_body_leak', line: rawBody.slice(0, 120) });
      return { event: null, errors };
    }
    return {
      event: {
        ...base,
        from: t === 'msg' ? getMessageEventActor(raw) : getEventActor(raw),
        body,
        name: stripLeakedMarshmallowProtocolMarkers(raw.name || raw.sticker || raw.stickerName || body),
        inlineText: stripLeakedMarshmallowProtocolMarkers(raw.inlineText || ''),
        zh: translation,
        translation,
        ...buildHiddenStateMetadata(raw),
      },
      errors,
    };
  }
  if (t === 'react') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        emoji: cleanString(raw.emoji || raw.body || raw.text),
        target: raw.target || raw.reply || null,
      },
      errors,
    };
  }
  if (t === 'recall') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        target: raw.target || raw.messageId || raw.reply || null,
      },
      errors,
    };
  }
  if (t === 'location') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        name: cleanString(raw.name || raw.place || raw.label || raw.body || raw.text).slice(0, 80),
      },
      errors,
    };
  }
  if (t === 'offline_invite') {
    const invitees = Array.isArray(raw.invitees)
      ? raw.invitees.map((id) => cleanString(id)).filter(Boolean).slice(0, 5)
      : [];
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        invitees,
        place: cleanString(raw.place || raw.location).slice(0, 60),
        activity: cleanString(raw.activity || raw.what || raw.plan).slice(0, 80),
        note: cleanString(raw.note || raw.body || raw.text || raw.reason).slice(0, 160),
        timeLabel: cleanString(raw.time || raw.timeLabel || raw.when).slice(0, 40),
        tone: cleanString(raw.tone || raw.mood).slice(0, 24),
        arrived: raw.arrived === true || raw.arrived === 'true',
        accepted: raw.accepted === true || raw.accepted === 'true',
        transitionPhase: cleanString(raw.transitionPhase || raw.phase).slice(0, 16),
        toUserPlace: raw.toUserPlace === true || raw.toUserPlace === 'true',
        kind: cleanString(raw.kind).slice(0, 16),
        ...buildHiddenStateMetadata(raw),
      },
      errors,
    };
  }
  if (t === 'backstage') {
    const requestedInitiatorId = cleanString(raw.initiatorId || raw.initiator || raw.ownerId || raw.from);
    return {
      event: {
        ...base,
        targetChatId: cleanString(raw.targetChatId || raw.chatId || raw.target_chat_id),
        room: cleanString(raw.room || raw.title || '秘密基地'),
        initiatorId: requestedInitiatorId,
        initiatorExplicit: !!requestedInitiatorId,
        newGroupReason: cleanString(raw.newGroupReason || raw.distinctPurpose || raw.createReason).slice(0, 160),
        memberIds: (Array.isArray(raw.memberIds) ? raw.memberIds : (Array.isArray(raw.members) ? raw.members : []))
          .map((id) => cleanString(id))
          .filter(Boolean)
          .slice(0, 20),
        create: raw.create === true || raw.create === 'true',
        lines: normalizeSideChatLines(raw, requestedInitiatorId),
        states: Array.isArray(raw.states) ? raw.states : [],
        plot: extractSideEventPlot(raw),
      },
      errors,
    };
  }
  if (t === 'peer_private') {
    const lines = normalizeSideChatLines(raw, raw.from || raw.actor || raw.senderId);
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        to: cleanString(raw.to || raw.target || raw.peer),
        lines,
        states: Array.isArray(raw.states) ? raw.states : [],
        plot: extractSideEventPlot(raw),
      },
      errors,
    };
  }
  if (t === 'voice_call') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        callMode: cleanString(raw.callMode || raw.mode).toLowerCase() === 'video' ? 'video' : 'voice',
        note: cleanString(raw.note || raw.reason || raw.text || raw.body).slice(0, 80),
      },
      errors,
    };
  }
  if (t === 'group_name') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        name: cleanString(raw.name || raw.title || raw.body || raw.text).slice(0, 40),
      },
      errors,
    };
  }
  if (t === 'group_remote') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        groupId: cleanString(raw.groupId || raw.targetChatId || raw.chatId),
        operation: cleanString(raw.operation || raw.op || raw.action).toLowerCase(),
        target: cleanString(raw.target || raw.to || raw.member),
        name: cleanString(raw.name || raw.title).slice(0, 40),
        announcement: cleanString(raw.announcement || raw.content || raw.body || raw.text).slice(0, 600),
        text: cleanString(raw.text || raw.todo || raw.title || '').slice(0, 120),
        id: cleanString(raw.id || raw.todoId || raw.voteId || ''),
        title: cleanString(raw.title || '').slice(0, 24),
        memberAction: cleanString(raw.memberAction || raw.mode || 'remove').toLowerCase(),
        todoAction: cleanString(raw.todoAction || raw.mode || 'add').toLowerCase(),
        admin: raw.admin !== false && !['remove', 'unset', 'cancel'].includes(cleanString(raw.memberAction || raw.mode).toLowerCase()),
        muted: raw.muted !== false,
        note: cleanString(raw.note || raw.reason).slice(0, 80),
      },
      errors,
    };
  }
  if (t === 'group_announcement') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        announcement: cleanString(raw.announcement || raw.body || raw.text || raw.content).slice(0, 600),
      },
      errors,
    };
  }
  if (t === 'group_todo') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        action: cleanString(raw.action || raw.mode || 'add').toLowerCase(),
        id: cleanString(raw.id || raw.todoId || ''),
        text: cleanString(raw.text || raw.body || raw.title || '').slice(0, 120),
        done: raw.done === true,
      },
      errors,
    };
  }
  if (t === 'group_transfer') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        target: cleanString(raw.target || raw.to || raw.owner || raw.newOwner),
      },
      errors,
    };
  }
  if (t === 'group_admin') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        target: cleanString(raw.target || raw.to || raw.member),
        admin: raw.admin !== false && !['remove', 'unset', 'cancel'].includes(cleanString(raw.action).toLowerCase()),
      },
      errors,
    };
  }
  if (t === 'group_member') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        target: cleanString(raw.target || raw.to || raw.member),
        action: cleanString(raw.action || 'remove').toLowerCase(),
      },
      errors,
    };
  }
  if (t === 'vote_close') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        target: cleanString(raw.target || raw.voteId || raw.messageId || 'last_vote'),
      },
      errors,
    };
  }
  if (t === 'invite_user') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        note: cleanString(raw.note || raw.reason || raw.body || raw.text).slice(0, 80),
      },
      errors,
    };
  }
  if (t === 'state') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        inner: cleanString(raw.inner || raw.innerVoice),
        // state 的正式译文字段是 innerZh；zh 仅作旧协议兼容。
        // 两者同时出现时不能让误写在顶层的 zh 覆盖正确心声译文。
        innerZh: cleanString(raw.innerZh || raw.zh),
        intent: cleanString(raw.intent || raw.plan),
        mood: cleanString(raw.mood), // legacy field, kept for old models/history
        status: cleanString(raw.status || raw.state),
        moodShift: Math.max(-20, Math.min(20, Number(raw.moodShift) || 0)),
        custom: normalizeStateCustomFields(raw),
      },
      errors,
    };
  }
  if (t === 'situation') {
    const actor = getEventActor(raw);
    const withIds = (Array.isArray(raw.with)
      ? raw.with
      : (Array.isArray(raw.togetherWith)
        ? raw.togetherWith
        : (Array.isArray(raw.actorIds) ? raw.actorIds : [])))
      .map((id) => cleanString(id))
      .filter((id) => id && id !== actor)
      .slice(0, 12);
    const knownBy = (Array.isArray(raw.knownBy) ? raw.knownBy : [])
      .map((id) => cleanString(id))
      .filter(Boolean)
      .slice(0, 20);
    const action = cleanString(raw.action || 'set').toLowerCase() === 'clear' ? 'clear' : 'set';
    if (!actor) errors.push({ index, code: 'missing_actor' });
    if (action === 'set' && !withIds.length) errors.push({ index, code: 'situation_companion_missing' });
    return {
      event: {
        ...base,
        from: actor,
        action,
        with: withIds,
        knownBy,
        visibility: ['participants', 'chat', 'known'].includes(cleanString(raw.visibility).toLowerCase())
          ? cleanString(raw.visibility).toLowerCase()
          : 'participants',
        privacy: ['private', 'shared', 'public'].includes(cleanString(raw.privacy).toLowerCase())
          ? cleanString(raw.privacy).toLowerCase()
          : 'private',
        communication: ['available', 'limited', 'unavailable'].includes(cleanString(raw.communication).toLowerCase())
          ? cleanString(raw.communication).toLowerCase()
          : 'limited',
        place: cleanString(raw.place || raw.location).slice(0, 80),
        activity: cleanString(raw.activity || raw.status || raw.what).slice(0, 120),
        ttlMinutes: Math.max(5, Math.min(1440, Math.trunc(Number(raw.ttlMinutes || raw.durationMinutes)) || 180)),
      },
      errors,
    };
  }
  if (t === 'alias') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        name: cleanString(raw.name || raw.currentId || raw.handle || raw.body || raw.text).slice(0, 24),
        signature: cleanString(raw.signature || raw.bio || '').slice(0, 80),
        reason: cleanString(raw.reason || raw.intent || '').slice(0, 120),
      },
      errors,
    };
  }
  if (t === 'avatar') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        avatar: cleanString(raw.avatar || raw.style || raw.prompt || raw.body || raw.text).slice(0, 160),
        useUserImage: raw.useUserImage === true || raw.fromUserImage === true,
        imageIndex: Math.max(0, Math.min(5, Math.trunc(Number(
          raw.imageIndex || raw.userImageIndex || raw.imageNo || 0,
        )) || 0)),
        pick: cleanString(raw.pick || raw.fromLibrary || raw.source).slice(0, 60),
        reason: cleanString(raw.reason || raw.intent || '').slice(0, 120),
      },
      errors,
    };
  }
  if (t === 'nudge') {
    const from = getEventActor(raw);
    const target = cleanString(raw.target || 'user') || 'user';
    if (!from) errors.push({ index, code: 'missing_from' });
    if (!target) errors.push({ index, code: 'missing_target' });
    return {
      event: {
        ...base,
        from,
        target,
        style: cleanString(raw.style || 'pat'),
        text: cleanString(raw.text || raw.body),
        ...buildHiddenStateMetadata(raw),
      },
      errors,
    };
  }
  if (t === 'memory_fact') {
    // 保留协议原文；memory-facts 写入层会按语义边界拆成多条，而不是在入口静默截断。
    const content = cleanString(raw.content || raw.fact || raw.text || raw.body);
    if (!content) errors.push({ index, code: 'missing_memory_fact_content' });
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        subject: cleanString(raw.subject || raw.subjectId || 'user').slice(0, 80),
        subjectName: cleanString(raw.subjectName || '').slice(0, 80),
        object: cleanString(raw.object || raw.objectId || '').slice(0, 80),
        factType: cleanString(raw.factType || raw.kind || raw.typeLabel || '关系印象').slice(0, 40),
        canonicalKey: cleanString(raw.canonicalKey || raw.memoryKey).slice(0, 120),
        content,
        evidence: cleanString(raw.evidence || raw.reason || raw.intent || '').slice(0, 240),
        tags: Array.isArray(raw.tags) ? raw.tags.map(cleanString).filter(Boolean).slice(0, 12) : [],
        ...buildHiddenStateMetadata(raw),
      },
      errors,
    };
  }
  if (t === 'stranger_block') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        reason: cleanString(raw.reason || raw.note || raw.body || raw.text).slice(0, 300),
      },
      errors,
    };
  }
  if (t === 'stranger_friend') {
    const action = cleanString(raw.action || raw.decision || raw.state).toLowerCase();
    if (!['accept', 'decline', 'request'].includes(action)) errors.push({ index, code: 'invalid_stranger_friend_action' });
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        action,
        reason: cleanString(raw.reason || raw.note || raw.body || raw.text).slice(0, 300),
      },
      errors,
    };
  }
  if (t === 'stranger_unblock') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        reason: cleanString(raw.reason || raw.note || raw.body || raw.text).slice(0, 300),
      },
      errors,
    };
  }
  if (t === 'stranger_suspect') {
    return {
      event: {
        ...base,
        from: getEventActor(raw),
        reason: cleanString(raw.reason || raw.note || raw.evidence || raw.body || raw.text).slice(0, 300),
      },
      errors,
    };
  }
  if (t === 'status') {
    const actor = getEventActor(raw);
    const presence = cleanString(raw.presence || raw.presenceState || raw.state).toLowerCase();
    const presenceState = ['online', 'away', 'busy', 'offline'].includes(presence)
      ? presence
      : 'online';
    const text = cleanString(raw.status || raw.statusText || raw.body || raw.text || raw.content).slice(0, 40);
    if (!actor) errors.push({ index, code: 'missing_actor' });
    if (!presence && !text) errors.push({ index, code: 'missing_status' });
    return {
      event: {
        ...base,
        actor,
        from: actor,
        presenceState,
        statusText: text,
        reason: cleanString(raw.reason || raw.intent).slice(0, 120),
        // 状态小剧场：状态变更同轮附带的幕后小故事（开关关闭时落地层会忽略）。
        story: cleanString(raw.story || raw.storyText || raw.scene || '').slice(0, 1600),
        ...buildHiddenStateMetadata(raw),
      },
      errors,
    };
  }
  if (t === 'schedule_change') {
    const actor = getEventActor(raw);
    if (!actor) errors.push({ index, code: 'missing_actor' });
    return {
      event: {
        ...base,
        from: actor,
        blockId: cleanString(raw.blockId || raw.targetBlockId || raw.block || '').slice(0, 80),
        mode: cleanString(raw.mode || 'current').slice(0, 24),
        reason: cleanString(raw.reason || raw.intent || raw.body || raw.text || '').slice(0, 160),
      },
      errors,
    };
  }
  if (t === 'memo') {
    const actor = getEventActor(raw);
    const title = cleanString(raw.title || raw.body || raw.text || raw.content || '').slice(0, 80);
    const at = cleanString(raw.at || raw.time || raw.when || '').slice(0, 40);
    if (!actor) errors.push({ index, code: 'missing_actor' });
    if (!title) errors.push({ index, code: 'missing_memo_title' });
    if (!at) errors.push({ index, code: 'missing_memo_time' });
    return {
      event: {
        ...base,
        from: actor,
        title,
        at,
        note: cleanString(raw.note || raw.reason || raw.intent || '').slice(0, 160),
        remind: raw.remind !== false,
      },
      errors,
    };
  }
  if (t === 'radio_plan') {
    const actor = getEventActor(raw);
    const operation = cleanString(raw.operation || raw.op || 'create').toLowerCase();
    const at = cleanString(raw.at || raw.time || raw.when || '').slice(0, 40);
    if (!actor) errors.push({ index, code: 'missing_actor' });
    if (!['create', 'update', 'cancel'].includes(operation)) errors.push({ index, code: 'invalid_radio_plan_operation' });
    if (operation === 'create' && !at) errors.push({ index, code: 'missing_radio_plan_time' });
    return {
      event: {
        ...base,
        from: actor,
        operation: ['update', 'cancel'].includes(operation) ? operation : 'create',
        at,
        topic: cleanString(raw.topic || raw.title || raw.subject || '').slice(0, 1000),
        note: cleanString(raw.note || raw.requirement || raw.intent || '').slice(0, 800),
        radioType: cleanString(raw.radioType || raw.typeId || raw.kind || (operation === 'create' ? 'bedtime' : '')).slice(0, 40),
        minutes: raw.minutes != null || raw.durationMinutes != null
          ? Math.max(3, Math.min(30, Math.round(Number(raw.minutes || raw.durationMinutes || 8) || 8)))
          : (operation === 'create' ? 8 : 0),
        actionMode: cleanString(raw.actionMode || (operation === 'create' ? 'hidden' : '')).slice(0, 20),
        ambientEnabled: raw.ambientEnabled == null
          ? (operation === 'create' ? true : undefined)
          : raw.ambientEnabled !== false,
      },
      errors,
    };
  }
  if (t === 'interaction_plan') {
    const actor = getEventActor(raw);
    const idea = cleanString(raw.idea || raw.intent || raw.topic || raw.brief || '').slice(0, 500);
    const rawDelay = raw.afterMinutes ?? raw.delayMinutes ?? raw.minutes;
    const parsedDelay = Number(rawDelay);
    const afterMinutes = Number.isFinite(parsedDelay)
      ? Math.max(5, Math.min(10080, Math.round(parsedDelay)))
      : 30;
    if (!actor) errors.push({ index, code: 'missing_actor' });
    if (!idea) errors.push({ index, code: 'missing_interaction_plan_idea' });
    if (rawDelay == null || !Number.isFinite(Number(rawDelay))) {
      errors.push({ index, code: 'missing_or_invalid_interaction_plan_delay' });
    }
    return {
      event: {
        ...base,
        from: actor,
        afterMinutes,
        title: cleanString(raw.title || raw.name || '').slice(0, 48),
        idea,
        note: cleanString(raw.note || raw.opener || raw.tone || '').slice(0, 320),
      },
      errors,
    };
  }
  if (t === 'period_offer' || t === 'period_confirm' || t === 'period_decline' || t === 'period_set' || t === 'period_end') {
    const actor = getEventActor(raw);
    const day = cleanString(raw.day || raw.date || raw.startDate || '').slice(0, 16);
    const dayInPeriod = Math.round(Number(raw.dayInPeriod || raw.periodDay || 0) || 0);
    if (!actor) errors.push({ index, code: 'missing_actor' });
    if (t === 'period_offer' && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(day)) {
      errors.push({ index, code: 'missing_or_invalid_period_day' });
    }
    if (t === 'period_set' && (dayInPeriod < 1 || dayInPeriod > 30)) {
      errors.push({ index, code: 'missing_or_invalid_period_day_number' });
    }
    return {
      event: {
        ...base,
        from: actor,
        day,
        dayInPeriod,
      },
      errors,
    };
  }
  if (t === 'auto_reply') {
    const actor = getEventActor(raw);
    const clearRequested = raw.clear === true
      || raw.stop === true
      || raw.action === 'clear'
      || raw.action === 'stop'
      || raw.enabled === false;
    const text = cleanString(raw.text || raw.body || raw.content || raw.reply || '').slice(0, 120);
    const translation = cleanString(raw.zh || raw.translation || '').slice(0, 220);
    const durationMinutes = Math.max(5, Math.min(480, Number(raw.durationMinutes || raw.minutes || raw.duration || 90) || 90));
    if (!actor) errors.push({ index, code: 'missing_actor' });
    if (!text && !clearRequested) errors.push({ index, code: 'missing_auto_reply_text' });
    return {
      event: {
        ...base,
        from: actor,
        text,
        zh: translation,
        translation,
        clear: clearRequested,
        blockId: cleanString(raw.blockId || raw.targetBlockId || raw.block || '').slice(0, 80),
        durationMinutes,
        reason: cleanString(raw.reason || raw.intent || '').slice(0, 120),
        setBusy: clearRequested ? raw.setBusy === true : raw.setBusy !== false,
      },
      errors,
    };
  }
  if (t === 'chat_bundle') {
    const actor = getEventActor(raw);
    if (!actor) errors.push({ index, code: 'missing_actor' });
    return {
      event: {
        ...base,
        from: actor,
        title: cleanString(raw.title || raw.bundleTitle || raw.name || '聊天记录').slice(0, 40),
        items: chatBundleItemSpecs(raw),
        relay: raw.relay || null,
        to: cleanString(raw.to || raw.target || raw.peer),
        room: cleanString(raw.room || raw.backstageRoom || '').slice(0, 40),
        shareWithUser: raw.shareWithUser === true || raw.confirmUserRecipient === true,
      },
      errors,
    };
  }
  if (t === 'redpacket_claim') {
    const actor = getEventActor(raw);
    if (!actor) errors.push({ index, code: 'missing_actor' });
    return {
      event: {
        ...base,
        from: actor,
        target: raw.target || raw.messageId || raw.message || raw.ref || 'last_redpacket',
        amount: cleanString(raw.amount || raw.grab || raw.money || ''),
      },
      errors,
    };
  }
  if (t === 'transfer_accept' || t === 'transfer_return') {
    const actor = getEventActor(raw);
    if (!actor) errors.push({ index, code: 'missing_actor' });
    return {
      event: {
        ...base,
        from: actor,
        target: raw.target || raw.messageId || raw.message || raw.ref || 'last_transfer',
      },
      errors,
    };
  }
  if (t === 'order_share') {
    const actor = getEventActor(raw);
    const title = cleanString(raw.title || raw.product || raw.productTitle || raw.orderTitle || raw.name || raw.body || raw.text).slice(0, 80);
    const to = cleanString(raw.to || raw.target || 'user') || 'user';
    if (!actor) errors.push({ index, code: 'missing_actor' });
    if (!title) errors.push({ index, code: 'missing_order_share_title' });
    return {
      event: {
        ...base,
        from: actor,
        to,
        title,
        price: normalizeOrderSharePrice(raw.price || raw.amount || raw.orderPrice || ''),
        note: cleanString(raw.note || raw.remark || raw.reason || '').slice(0, 160),
      },
      errors,
    };
  }
  if (t === 'html_widget') {
    const actor = getEventActor(raw);
    const extensionId = cleanString(raw.id || raw.extensionId).slice(0, 80);
    const content = cleanString(raw.content || raw.body || raw.text);
    const reservedFieldKeys = new Set(['t', 'type', 'from', 'sender', 'actor', 'id', 'extensionId', 'title', 'name', 'content', 'body', 'text', 'fields', 'data']);
    const legacyTopLevelFields = normalizeHtmlExtensionFields(Object.fromEntries(
      Object.entries(raw).filter(([key]) => !reservedFieldKeys.has(key)),
    ));
    const fields = {
      ...legacyTopLevelFields,
      ...normalizeHtmlExtensionFields(raw.fields || raw.data),
    };
    if (!actor) errors.push({ index, code: 'missing_actor' });
    if (!extensionId) errors.push({ index, code: 'missing_html_widget_id' });
    if (!content && !Object.keys(fields).length) errors.push({ index, code: 'missing_html_widget_content' });
    return {
      event: {
        ...base,
        from: actor,
        extensionId,
        title: cleanString(raw.title || raw.name || '').slice(0, 120),
        content,
        fields,
      },
      errors,
    };
  }
  return { event: { ...base, from: getEventActor(raw) }, errors };
}

export function isMarshmallowChatLikelyInProgress(rawText = '') {
  const text = String(rawText || '');
  if (!text) return false;
  if (MARSHMALLOW_PROTOCOL_MARKERS.some((m) => text.includes(m.start) || text.includes(m.end))) return true;
  return /(?:^|\n)\s*\{\s*"(?:t|type)"\s*:\s*"(?:msg|react|recall|sticker|image|gen_image|textimg|voice|voice_call|dice|redpacket|redpacket_claim|transfer|transfer_accept|transfer_return|order_share|html_widget|link|location|offline_invite|backstage|peer_private|private_msg|chat_bundle|vote|vote_close|nudge|status|state|situation|schedule_change|auto_reply|alias|avatar|group_name|group_announcement|group_todo|group_title|group_transfer|group_admin|group_member|group_remote|mute|memo|radio_plan|interaction_plan|invite_user|stranger_block|stranger_friend|stranger_unblock|stranger_suspect)"/.test(text);
}

function extractMarshmallowBlockRanges(rawText = '', options = {}) {
  const raw = String(rawText || '');
  const ranges = [];
  const findStandaloneMarker = (markerText, fromIndex = 0) => {
    let cursor = Math.max(0, Number(fromIndex) || 0);
    while (cursor < raw.length) {
      const index = raw.indexOf(markerText, cursor);
      if (index < 0) return -1;
      const before = raw.slice(0, index);
      const lineStart = before.lastIndexOf('\n') + 1;
      const prefix = raw.slice(lineStart, index);
      const afterIndex = index + markerText.length;
      const lineEnd = raw.indexOf('\n', afterIndex);
      const suffix = raw.slice(afterIndex, lineEnd < 0 ? raw.length : lineEnd).replace(/\r$/, '');
      if (!prefix.trim() && !suffix.trim()) return index;
      cursor = afterIndex;
    }
    return -1;
  };
  for (const marker of MARSHMALLOW_PROTOCOL_MARKERS) {
    let cursor = 0;
    while (cursor < raw.length) {
      const start = findStandaloneMarker(marker.start, cursor);
      if (start < 0) break;
      const bodyStart = start + marker.start.length;
      const end = findStandaloneMarker(marker.end, bodyStart);
      if (end < 0) {
        if (options.allowOpenTail) {
          ranges.push({
            start,
            bodyStart,
            bodyEnd: raw.length,
            end: raw.length,
          });
        }
        break;
      }
      const rangeEnd = end + marker.end.length;
      ranges.push({
        start,
        bodyStart,
        bodyEnd: end,
        end: rangeEnd,
      });
      cursor = rangeEnd;
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const nonOverlapping = [];
  for (const range of ranges) {
    const previous = nonOverlapping[nonOverlapping.length - 1];
    if (!previous || range.start >= previous.end) nonOverlapping.push(range);
  }
  return nonOverlapping;
}

function extractMarshmallowParseSegments(rawText = '', options = {}) {
  const raw = String(rawText || '');
  const ranges = extractMarshmallowBlockRanges(raw, options);
  if (!ranges.length) return { ranges, segments: [] };
  const segments = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ kind: 'outside', text: raw.slice(cursor, range.start) });
    }
    segments.push({ kind: 'block', text: raw.slice(range.bodyStart, range.bodyEnd) });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < raw.length) {
    segments.push({ kind: 'outside', text: raw.slice(cursor) });
  }
  return { ranges, segments };
}

function extractBareJsonLines(rawText = '') {
  return String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.includes('"'));
}

function eventDedupeKey(event = {}) {
  const actor = getEventActor(event);
  if (event.t === 'peer_private' || event.t === 'backstage') {
    const lines = (Array.isArray(event.lines) ? event.lines : [])
      .map((line) => `${cleanString(line?.from)}:${cleanString(line?.body || line?.text || line?.content)}`)
      .join('|');
    return `${String(event.t || '')}|${actor}|${cleanString(event.to || event.room)}|${lines}`;
  }
  if (event.t === 'chat_bundle') {
    const items = (Array.isArray(event.items) ? event.items : [])
      .map((item) => cleanString(
        item?.relay?.id
        || item?.relay?.selector
        || item?.body
        || item?.text
        || item?.content,
      ))
      .join('|');
    return `${String(event.t || '')}|${actor}|${cleanString(event.to || event.room)}|${cleanString(event.title)}|${items}`;
  }
  if (event.t === 'social_react') {
    // 同一轮可以对不同人/不同平台各点一次赞，凭 target+action+who 区分，不能只看 text。
    return `${String(event.t || '')}|${actor}|${cleanString(event.target)}|${cleanString(event.action)}|${cleanString(event.who)}|${cleanString(event.text)}`;
  }
  const payload = cleanString(
    event.body || event.text || event.content || event.emoji || event.name
    || event.prompt || event.url || event.title || '',
  );
  return `${String(event.t || '')}|${actor}|${payload}`;
}

export function parseMarshmallowChatV2(rawText = '', options = {}) {
  const src = stripThinkingBlocks(rawText);
  const parseSegments = extractMarshmallowParseSegments(src, {
    allowOpenTail: !!options.allowOpenTail,
  });
  const blocks = parseSegments.segments
    .filter((segment) => segment.kind === 'block')
    .map((segment) => segment.text);
  const events = [];
  const errors = [];
  const seen = new Set();
  let lineIndex = 0;
  const pushEvent = (event, errs = []) => {
    if (!event) {
      errors.push(...errs);
      return;
    }
    const key = eventDedupeKey(event);
    if (seen.has(key)) return;
    seen.add(key);
    events.push(event);
    errors.push(...errs);
  };
  const pushRawEvent = (rawEvent) => {
    lineIndex += 1;
    const normalized = normalizeMarshmallowChatEvent(rawEvent, lineIndex);
    pushEvent(normalized.event, normalized.errors);
  };
  const pushJsonContainer = (value) => {
    if (Array.isArray(value)) {
      value.forEach(pushRawEvent);
      return true;
    }
    if (value && typeof value === 'object') {
      pushRawEvent(value);
      return true;
    }
    return false;
  };
  const parseWholeJsonContainer = (text) => {
    const trimmed = String(text || '').trim();
    if (!trimmed || (trimmed[0] !== '[' && trimmed[0] !== '{')) return false;
    try {
      return pushJsonContainer(parseProtocolJson(trimmed));
    } catch (_) {
      return false;
    }
  };

  const parseJsonLines = (lines = []) => {
    for (const line of lines) {
      lineIndex += 1;
      try {
        // 数组逐行输出时，除最后一项外对象后会带逗号；协议块内外都兼容。
        const rawEvent = parseProtocolJson(line.replace(/,\s*$/, ''));
        if (Array.isArray(rawEvent)) {
          lineIndex -= 1;
          pushJsonContainer(rawEvent);
        } else {
          const normalized = normalizeMarshmallowChatEvent(rawEvent, lineIndex);
          pushEvent(normalized.event, normalized.errors);
        }
      } catch (error) {
        errors.push({ index: lineIndex, code: 'invalid_json', line, message: error?.message || String(error) });
      }
    }
  };

  for (const segment of parseSegments.segments) {
    if (segment.kind === 'outside') {
      if (options.allowBareJsonl) parseJsonLines(extractBareJsonLines(segment.text));
      continue;
    }
    const block = segment.text || '';
    if (parseWholeJsonContainer(block)) continue;
    parseJsonLines(block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  if (!parseSegments.ranges.length && options.allowBareJsonl && isMarshmallowChatLikelyInProgress(src)) {
    const fenced = String(src || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (!parseWholeJsonContainer(fenced)) {
      // 即使外层数组被模型说明文字/代码围栏破坏，也应保住每个完整事件。
      parseJsonLines(extractBareJsonLines(src));
    }
  }
  const hasJsonErrors = errors.some((e) => e?.code === 'invalid_json');
  if (options.salvageTruncated !== false && (hasJsonErrors || options.allowOpenTail) && blocks.length) {
    for (const block of blocks) {
      for (const rawEvent of extractCompleteJsonObjectsFromText(block)) {
        lineIndex += 1;
        const normalized = normalizeMarshmallowChatEvent(rawEvent, lineIndex);
        pushEvent(normalized.event, normalized.errors);
      }
    }
  }
  const found = events.length > 0 || blocks.length > 0;
  return {
    found,
    events,
    errors,
    cleanedText: found ? MARSHMALLOW_PROTOCOL_MARKERS.reduce((text, marker) => text.split(marker.start).join('').split(marker.end).join(''), src) : src,
    protocol: MARSHMALLOW_CHAT_PROTOCOL,
  };
}

/** 从截断原文中尽力提取完整气泡 JSON（跳过思维链与尾部残缺对象） */
export function salvageParseMarshmallowChatV2(rawText = '', options = {}) {
  const src = stripThinkingBlocks(rawText);
  const events = [];
  const errors = [];
  let lineIndex = 0;
  for (const rawEvent of extractCompleteJsonObjectsFromText(src)) {
    lineIndex += 1;
    const normalized = normalizeMarshmallowChatEvent(rawEvent, lineIndex);
    if (normalized.event) events.push(normalized.event);
    errors.push(...normalized.errors);
  }
  const bubbleEvents = options.bubblesOnly === false
    ? events
    : filterSalvageableMarshmallowBubbleEvents(events);
  return {
    found: bubbleEvents.length > 0 || isMarshmallowChatLikelyInProgress(src),
    events: bubbleEvents,
    errors,
    cleanedText: src,
    protocol: MARSHMALLOW_CHAT_PROTOCOL,
    salvagedParse: true,
  };
}

/**
 * 流式阶段只提取已经完整闭合、且能安全作为普通气泡提前展示的事件。
 * 这里只做视觉预览，不执行副作用；完整响应结束后仍由 persistMarshmallowTurn
 * 重新解析、校验并落库，避免半截 JSON 或越权角色先闪到聊天页上。
 */
export function extractMarshmallowStreamPreviewEvents(rawText = '', options = {}) {
  const parsed = parseMarshmallowChatV2(rawText, {
    allowOpenTail: true,
    allowBareJsonl: true,
    salvageTruncated: true,
  });
  const salvaged = parsed.events.length ? parsed : salvageParseMarshmallowChatV2(rawText);
  const previewable = (salvaged.events || []).filter((event) => (
    event?.t === 'msg' || event?.t === 'narration'
  ));
  if (!previewable.length) return [];
  const checked = validateMarshmallowChatEvents(previewable, {
    ...options,
    salvageBubbles: true,
  });
  return checked.valid.filter((event) => (
    event?.t === 'msg' || event?.t === 'narration'
  ));
}

function getAllowedActors(chat, extra = []) {
  const participants = Array.isArray(chat?.participants) ? chat.participants : [];
  // user 只能在真实参与该会话时发言。旧逻辑无条件放行 user，导致角色间侧窗
  // 的模型输出可伪造用户气泡并通过协议校验。
  const allowUser = !chat || participants.includes('user');
  return new Set([
    ...(allowUser ? ['user'] : []),
    ...participants,
    // 有具体会话时，前台事件只能由真实 participants 发出。extraActorIds 只用于
    // 解析跨窗目标/通讯录角色，不能赋予其在当前窗口发言的权限。
    ...(!chat ? (extra || []).filter((id) => allowUser || id !== 'user') : []),
  ].filter(Boolean));
}

function normalizeActorLookupKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[\s_\-./]+/g, '');
}

// 幕后台词里提到、但既不在本对话也不在通讯录里的名字（妈妈/室友/路人同事……）：
// 不当场发明一个「正式角色」，而是转成一次性 NPC——有台词、无头像、不进正式成员名单、不占用记忆位。
const EPHEMERAL_NPC_ID_PREFIX = 'npc_';

// 临时路人只允许发出会形成普通聊天气泡的事件；群管理、日程等隐藏副作用仍必须来自正式成员。
// state（心声）也放行：NPC 群里临时角色常有开口气泡，漏收 state 会导致「有话无心声」。
const EPHEMERAL_FRONTSTAGE_EVENT_TYPES = new Set([
  'msg',
  'react',
  'recall',
  'sticker',
  'image',
  'textimg',
  'voice',
  'dice',
  'redpacket',
  'transfer',
  'order_share',
  'link',
  'location',
  'nudge',
  'state',
]);

export function isEphemeralNpcActorId(id = '') {
  return String(id || '').startsWith(EPHEMERAL_NPC_ID_PREFIX);
}
/**
 * 模型泄漏或写错的内部 actor 标识不能降级成“新路人姓名”。
 * 正确且已登记的 id 会在 resolver 的 exact-id 分支提前命中；走到这里的一定是
 * 未知、截断或串台的代码名，继续铸造只会制造无法按姓名归并的复制成员。
 */
function looksLikeUnresolvedInternalActorRef(value = '') {
  const raw = cleanString(value);
  return /^(?:char(?:_|\d)|npc_|lightnpc_|phone-(?:contact|group):)/i.test(raw)
    // 正式角色若真的叫 A / charA，会在上面的角色表姓名解析中先命中；走到这里的
    // 单字母与通用英文角色占位都是模型漏出的身份代号，不能铸造成轻量 NPC。
    || /^[a-z](?:\d+)?$/i.test(raw)
    || /^(?:char(?:acter)?|role|actor|member|person|speaker|assistant|bot)(?:[_-][a-z0-9]+|\d+)?$/i.test(raw)
    || /^(?:char(?:acter)?|role|actor|member|person|speaker|assistant|bot)[A-Z][A-Za-z0-9]*$/.test(raw);
}



// AI 有时会直接抄之前上下文里出现过的一次性 NPC 内部 id（形如 "npc_徐景照"）当称呼用，
// 这个前缀是内部实现细节，不应该原样露出到聊天气泡的发言人名字上。
export function stripEphemeralNpcLabel(label = '') {
  let cleaned = String(label || '').trim();
  while (/^npc_/i.test(cleaned)) cleaned = cleaned.replace(/^npc_/i, '').trim();
  return cleaned;
}

function buildEphemeralNpcId(name = '') {
  const key = normalizeActorLookupKey(name).slice(0, 40) || `anon${Math.random().toString(36).slice(2, 7)}`;
  return `${EPHEMERAL_NPC_ID_PREFIX}${key}`;
}

/** AI 常把协议示例里的「对方角色名」抄成真实 from/to；这些不能落成说话人显示名。 */
const GENERIC_PEER_PLACEHOLDER_KEYS = new Set([
  '对方',
  '对方角色名',
  '群成员',
  '当前群成员',
  '某位群成员',
  '另一角色',
  '另一个角色',
  '另一角色名',
  '角色a',
  '角色b',
  '角色甲',
  '角色乙',
  '角色名',
  'peer',
  'other',
  'someone',
  'ta',
  '某人',
  '另一个人',
  '另一人',
  '同伴',
]);

export function isGenericPeerActorLabel(raw = '') {
  const label = stripEphemeralNpcLabel(cleanString(raw));
  if (!label) return false;
  const key = normalizeActorLookupKey(label);
  if (GENERIC_PEER_PLACEHOLDER_KEYS.has(key)) return true;
  if (/^角色[ab甲乙]$/i.test(label)) return true;
  if (/^对方/.test(label) && label.length <= 6) return true;
  return false;
}

function lineSpeakerId(line = {}) {
  return getSideChatLineActor(line);
}

function collectRealSideSpeakerIds(lines = []) {
  return [...new Set((Array.isArray(lines) ? lines : [])
    .map((line) => lineSpeakerId(line))
    .filter((id) => id && id !== 'user' && id !== 'unknown' && !isEphemeralNpcActorId(id)))];
}

/** 跨窗 line.body 若偷懒把多句用换行塞进一条，落库前拆成多条短气泡。 */
export function expandSideChatLineBodies(lines = []) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || typeof line !== 'object') continue;
    const body = String(line.body || line.text || line.content || '').trim();
    if (!body) {
      out.push(line);
      continue;
    }
    const parts = body.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length <= 1) {
      out.push({ ...line, body });
      continue;
    }
    const rawTranslation = String(line.zh || line.translation || '').trim();
    const translationParts = rawTranslation
      ? rawTranslation.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean)
      : [];
    // 译文无法逐行对齐时保留为一个气泡，避免把整段译文复制到每个拆分气泡后
    // 被校验丢弃，或让用户看到重复的完整译文。
    if (rawTranslation && translationParts.length !== parts.length) {
      out.push({ ...line, body });
      continue;
    }
    for (const [index, part] of parts.entries()) {
      out.push({
        ...line,
        body: part,
        text: undefined,
        content: undefined,
        ...(translationParts[index]
          ? { zh: translationParts[index], translation: undefined }
          : {}),
      });
    }
  }
  return out;
}

/** 跨窗事件上的剧情解释字段（plot / synopsis / 剧情解释）。 */
export function extractSideEventPlot(raw = {}) {
  if (!raw || typeof raw !== 'object') return '';
  const direct = raw.plot ?? raw.synopsis ?? raw.plotExplain ?? raw.intent ?? raw['剧情解释'];
  if (direct && typeof direct === 'object') {
    return formatPlotExplainFourFields(direct).slice(0, 720);
  }
  return cleanString(direct).slice(0, 720);
}

const PLOT_FIELD_KEYS = [
  ['人物', ['人物', 'people', 'who', 'actors', 'chars']],
  ['关系', ['关系', 'relation', 'relationship', 'relations']],
  ['事件', ['事件', 'event', 'what', 'happen', 'happened']],
  ['动机', ['动机', 'motive', 'why', 'intent', 'motivation']],
];

function pickPlotField(source = {}, aliases = []) {
  if (!source || typeof source !== 'object') return '';
  for (const key of aliases) {
    const hit = cleanString(source[key]);
    if (hit) return hit;
  }
  return '';
}

/** 从自由文本里尽量拆出「人物/关系/事件/动机」四段。 */
function parsePlotExplainLabeledText(text = '') {
  const raw = cleanString(text).replace(/^【剧情解释】\s*/, '');
  if (!raw) return null;
  const labels = ['人物', '关系', '事件', '动机'];
  const found = {};
  const re = /(?:^|[\n；;。])\s*(人物|关系|事件|动机)\s*[：:]\s*/g;
  const marks = [];
  let m;
  while ((m = re.exec(raw))) {
    marks.push({ label: m[1], start: m.index + m[0].length, at: m.index });
  }
  if (marks.length < 2) return null;
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].at : raw.length;
    found[marks[i].label] = cleanString(raw.slice(marks[i].start, end)).replace(/[；;]+$/, '');
  }
  if (!labels.some((k) => found[k])) return null;
  return found;
}

/**
 * 统一成四段式剧情解释正文（不含【剧情解释】前缀）。
 * 人物 / 关系 / 事件 / 动机 —— 方便侧窗续写与前台回灌时快速对齐信息差。
 */
export function formatPlotExplainFourFields(plot = '', options = {}) {
  const userName = cleanString(options.userName || '用户') || '用户';
  let fields = { 人物: '', 关系: '', 事件: '', 动机: '' };

  if (plot && typeof plot === 'object') {
    for (const [label, aliases] of PLOT_FIELD_KEYS) {
      fields[label] = pickPlotField(plot, aliases);
    }
  } else {
    const text = cleanString(plot).replace(/^【剧情解释】\s*/, '');
    const parsed = parsePlotExplainLabeledText(text);
    if (parsed) {
      fields = { ...fields, ...parsed };
    } else if (text) {
      // 旧版自由句：整段归入「事件」，其余用保底短句补齐，避免丢信息。
      fields.事件 = text;
    }
  }

  if (!fields.人物) fields.人物 = '本段跨窗相关角色（见对话发言人）';
  if (!fields.关系) fields.关系 = '按各自人设与已公开关系理解；勿脑补未说明的亲密/对立';
  if (!fields.事件) {
    fields.事件 = `一方因当前前台剧情私下找另一方说话；口中「TA/那个人」等指代，对方未必已知真实身份（例如是否指 ${userName}）`;
  }
  if (!fields.动机) {
    fields.动机 = '发起方有事要说/求证/吐槽；接收方只按亲历与对话里直接说出的信息理解，保留信息差';
  }

  return [
    `人物：${cleanString(fields.人物).slice(0, 120)}`,
    `关系：${cleanString(fields.关系).slice(0, 160)}`,
    `事件：${cleanString(fields.事件).slice(0, 220)}`,
    `动机：${cleanString(fields.动机).slice(0, 180)}`,
  ].join('\n');
}

/**
 * 跨窗落库用的【剧情解释】正文。
 * 统一四段：人物 / 关系 / 事件 / 动机；前台日常不展示，只进 AI 上下文。
 */
export function buildSideChatPlotExplainContent(plot = '', options = {}) {
  const body = formatPlotExplainFourFields(plot, options);
  return `【剧情解释】\n${body}`.slice(0, 800);
}

/**
 * 把跨窗 sideEffect 里的占位「对方」补成真实角色，并把「只有两人却写成 backstage」改成 peer_private。
 * 在 validate / materialize / 落库前调用。
 */
export function normalizeCrossWindowSideEvents(events = [], options = {}) {
  const resolveActor = typeof options.resolveActor === 'function'
    ? options.resolveActor
    : buildMarshmallowActorResolver(options);
  // 仅用明确的 preferPeerIds 推断「对方」；不要把整个通讯录塞进来，否则无法唯一确定。
  const hintPeerIds = [...new Set((Array.isArray(options.preferPeerIds) ? options.preferPeerIds : [])
    .map((id) => cleanString(id))
    .filter((id) => id && id !== 'user' && !isEphemeralNpcActorId(id)))];

  return (Array.isArray(events) ? events : []).map((rawEvent) => {
    if (!rawEvent || (rawEvent.t !== 'backstage' && rawEvent.t !== 'peer_private')) return rawEvent;
    const event = {
      ...rawEvent,
      lines: Array.isArray(rawEvent.lines) ? rawEvent.lines.map((line) => ({ ...line })) : [],
      states: Array.isArray(rawEvent.states) ? rawEvent.states.map((state) => ({ ...state })) : [],
    };
    // 兼容旧提示下模型把单条跨窗译文错放到事件顶层的输出；多条台词无法
    // 无歧义分配，不做猜测，仍可在目标聊天里点「翻译」一次补全。
    if (event.lines.length === 1 && !event.lines[0]?.zh && !event.lines[0]?.translation) {
      const eventTranslation = cleanString(rawEvent.zh || rawEvent.translation);
      if (eventTranslation) event.lines[0].zh = eventTranslation;
    }
    const hadPlaceholder = event.lines.some((line) => {
      const rawFrom = lineSpeakerId(line) || cleanString(line?.fromLabel);
      return line?.unresolvedPeerPlaceholder === true
        || isGenericPeerActorLabel(rawFrom)
        || (isEphemeralNpcActorId(rawFrom) && isGenericPeerActorLabel(stripEphemeralNpcLabel(line?.fromLabel) || stripEphemeralNpcLabel(rawFrom)));
    });

    // 只用 resolveActor 的结果；不要把未解析的中文名当角色 id，否则会建成假 participant。
    const rawFromHint = cleanString(event.from || '');
    const rawToHint = cleanString(event.to || event.unresolvedTo || '');
    let resolvedFrom = cleanString(resolveActor(rawFromHint) || '');
    let resolvedTo = '';
    if (rawToHint && !isGenericPeerActorLabel(rawToHint)) {
      resolvedTo = cleanString(
        (typeof resolveActor.withAnchors === 'function'
          ? resolveActor.withAnchors(rawToHint, [resolvedFrom].filter(Boolean))
          : resolveActor(rawToHint)) || '',
      );
    }
    if (!resolvedFrom && rawFromHint && !isGenericPeerActorLabel(rawFromHint)
      && typeof resolveActor.withAnchors === 'function') {
      resolvedFrom = cleanString(resolveActor.withAnchors(rawFromHint, [resolvedTo].filter(Boolean)) || '');
    }
    if (resolvedFrom && resolvedTo && resolvedFrom === resolvedTo) {
      // 同名消歧误绑成同一人时，尝试用另一侧锚点重解析 to。
      if (rawToHint && typeof resolveActor.withAnchors === 'function') {
        const altTo = cleanString(resolveActor.withAnchors(rawToHint, [resolvedFrom]) || '');
        if (altTo && altTo !== resolvedFrom) resolvedTo = altTo;
      }
      if (resolvedFrom === resolvedTo) resolvedTo = '';
    }
    if (resolvedFrom) event.from = resolvedFrom;
    if (event.t === 'peer_private') {
      event.to = resolvedTo;
      if (!resolvedTo && rawToHint) event.unresolvedTo = rawToHint;
      else delete event.unresolvedTo;
    }

    let pairIds = [...new Set([
      resolvedFrom,
      resolvedTo,
      ...collectRealSideSpeakerIds(event.lines),
    ].filter(Boolean))];

    if (pairIds.length < 2) {
      const missingHints = hintPeerIds.filter((id) => !pairIds.includes(id));
      if (pairIds.length === 1 && missingHints.length === 1) {
        pairIds = [...pairIds, missingHints[0]];
      }
    }

    const knownRealInLines = collectRealSideSpeakerIds(event.lines);
    const fallbackOther = pairIds.length >= 2
      ? (pairIds.find((id) => (knownRealInLines.length === 1 ? id !== knownRealInLines[0] : id !== resolvedFrom)) || pairIds[1])
      : '';

    event.lines = expandSideChatLineBodies(event.lines)
      .map((line) => {
        if (!line || typeof line !== 'object') return null;
        const rawFrom = lineSpeakerId(line) || cleanString(line.fromLabel);
        const ephemeral = line.ephemeralNpc === true || isEphemeralNpcActorId(rawFrom);
        const label = ephemeral
          ? (stripEphemeralNpcLabel(line.fromLabel) || stripEphemeralNpcLabel(rawFrom))
          : rawFrom;
        const isPlaceholder = line.unresolvedPeerPlaceholder === true
          || isGenericPeerActorLabel(rawFrom)
          || isGenericPeerActorLabel(label)
          || (ephemeral && isGenericPeerActorLabel(label));

        if (!isPlaceholder) {
          if (ephemeral && isGenericPeerActorLabel(label)) return null;
          if (ephemeral) return line;
          const resolvedLine = cleanString(
            (typeof resolveActor.withAnchors === 'function'
              ? resolveActor.withAnchors(rawFrom, [resolvedFrom, resolvedTo].filter(Boolean))
              : resolveActor(rawFrom)) || '',
          );
          if (resolvedLine) return resolvedLine === rawFrom ? line : { ...line, from: resolvedLine };
          if (looksLikeUnresolvedInternalActorRef(rawFrom)) return null;
          // 未解析显示名落成临时 NPC，绝不把中文名原样当角色 id。
          if (rawFrom && !isGenericPeerActorLabel(rawFrom) && !isEphemeralNpcActorId(rawFrom)) {
            const cleanLabel = stripEphemeralNpcLabel(rawFrom) || rawFrom;
            return {
              ...line,
              from: buildEphemeralNpcId(cleanLabel),
              fromLabel: cleanLabel,
              ephemeralNpc: true,
            };
          }
          return null;
        }
        if (!fallbackOther) return null;
        const next = { ...line, from: fallbackOther };
        delete next.ephemeralNpc;
        delete next.fromLabel;
        delete next.unresolvedPeerPlaceholder;
        delete next._rawFrom;
        return next;
      })
      .filter(Boolean);

    // peer_private 的 from/to 已能确定两名正式角色时，以这对明确身份兜住 lines 里的单个坏别名。
    // 模型偶尔会在 to 写真名、台词 from 却写备注/简称；前者能解析成角色 id，后者会暂时落成
    // npc_*。旧逻辑随后把它当第三人，持久化时便只剩一方甚至整批跳过。只有“已知一方 +
    // 唯一一个未解析标签 + 唯一缺席的另一方”这个无歧义形状才修复，真正的原创 NPC 不受影响。
    if (event.t === 'peer_private') {
      const explicitPairIds = [...new Set([resolvedFrom, resolvedTo].filter(Boolean))];
      if (explicitPairIds.length === 2) {
        const seenExplicitIds = new Set(event.lines
          .map((line) => lineSpeakerId(line))
          .filter((id) => explicitPairIds.includes(id)));
        const unresolvedKeys = [...new Set(event.lines
          .map((line) => {
            const id = lineSpeakerId(line);
            if (!id || explicitPairIds.includes(id) || isGenericPeerActorLabel(id)) return '';
            return isEphemeralNpcActorId(id)
              ? (stripEphemeralNpcLabel(line?.fromLabel) || stripEphemeralNpcLabel(id))
              : id;
          })
          .filter(Boolean))];
        const missingIds = explicitPairIds.filter((id) => !seenExplicitIds.has(id));
        if (seenExplicitIds.size === 1 && missingIds.length === 1 && unresolvedKeys.length === 1) {
          const missingId = missingIds[0];
          event.lines = event.lines.map((line) => {
            const id = lineSpeakerId(line);
            if (!id || explicitPairIds.includes(id) || isGenericPeerActorLabel(id)) return line;
            const next = { ...line, from: missingId };
            delete next.ephemeralNpc;
            delete next.fromLabel;
            delete next.unresolvedPeerPlaceholder;
            delete next._rawFrom;
            return next;
          });
        }
      }
    }
    const realIds = collectRealSideSpeakerIds(event.lines);
    const sideSpeakerIds = [...new Set(event.lines
      .map((line) => lineSpeakerId(line))
      .filter((id) => id && id !== 'user' && id !== 'unknown'))];
    const stateActorAliases = new Map();
    for (const line of event.lines) {
      const id = lineSpeakerId(line);
      if (!id) continue;
      stateActorAliases.set(id, id);
      const label = cleanString(line?.fromLabel);
      if (label) stateActorAliases.set(label, id);
    }
    const normalizedStatesByActor = new Map();
    for (const rawState of event.states) {
      if (!rawState || typeof rawState !== 'object') continue;
      const rawActor = getEventActor(rawState);
      const actor = stateActorAliases.get(rawActor)
        || cleanString(
          (typeof resolveActor.withAnchors === 'function'
            ? resolveActor.withAnchors(rawActor, sideSpeakerIds)
            : resolveActor(rawActor)) || '',
        );
      if (!actor || !sideSpeakerIds.includes(actor)) continue;
      const normalized = normalizeMarshmallowChatEvent({
        ...rawState,
        t: 'state',
        from: actor,
      }).event;
      if (normalized?.from) normalizedStatesByActor.set(normalized.from, normalized);
    }
    event.states = [...normalizedStatesByActor.values()];
    // 占位「对方」补不出来时，丢掉这条残缺跨窗，避免气泡上出现「对方」。
    if (hadPlaceholder && realIds.length < 2) return null;

    if (event.t === 'peer_private') {
      // 允许“一名已知角色 + 一名首次出现的原创 NPC”先以临时 id 通过；持久化层会把
      // 临时 id 原地升级成轻量 NPC，再建立双方私聊。两边都未知时仍拒绝，避免凭空造整段关系。
      if (sideSpeakerIds.length === 2 && realIds.length >= 1) {
        const initiator = sideSpeakerIds.includes(resolvedFrom) ? resolvedFrom : sideSpeakerIds[0];
        event.from = initiator;
        event.to = sideSpeakerIds.find((id) => id !== initiator) || sideSpeakerIds[1];
      }
      if (!event.plot) {
        const plot = extractSideEventPlot(event);
        if (plot) event.plot = plot;
      }
      return event;
    }

    // 不在纯协议归一化阶段按“本轮发言人数”把 backstage 改成 peer_private。
    // 已有多人群这一轮可能恰好只有两人开口；此处看不到房间存档与完整 roster，
    // 提前改写会让本应落在群里的消息永久写进角色私聊。最终路由交给落库闸门：
    // 命中已有完整群时续写群聊，确实只有两人的新场景才转为 peer_private。
    if (!event.plot) {
      const plot = extractSideEventPlot(event);
      if (plot) event.plot = plot;
    }
    return event;
  }).filter(Boolean);
}

function levenshteinDistance(a = '', b = '') {
  const left = String(a || '');
  const right = String(b || '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const rows = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
    }
  }
  return rows[left.length][right.length];
}

function pickUniqueParticipantByIdShape(rawActor, participantIds = []) {
  const actorKey = normalizeActorLookupKey(rawActor);
  if (!actorKey || actorKey.length < 4) return '';
  const candidates = participantIds.filter((id) => id && id !== 'user');
  const prefix = actorKey.slice(0, 4);
  const suffix = actorKey.slice(-3);
  const shaped = candidates.filter((id) => {
    const key = normalizeActorLookupKey(id);
    return key.startsWith(prefix) && key.endsWith(suffix);
  });
  if (shaped.length === 1) return shaped[0];

  const threshold = actorKey.length >= 8 ? 4 : 3;
  const scored = candidates
    .map((id) => ({
      id,
      dist: levenshteinDistance(actorKey, normalizeActorLookupKey(id)),
    }))
    .filter((item) => item.dist <= threshold)
    .sort((a, b) => a.dist - b.dist);
  if (!scored.length) return '';
  if (scored.length === 1 || scored[0].dist + 1 < scored[1].dist) return scored[0].id;
  return '';
}

function isSecondaryActorCopyId(id = '') {
  const key = cleanString(id);
  return !key
    || key === 'user'
    || key.startsWith('lightnpc_')
    || key.startsWith('phone-contact:')
    || isEphemeralNpcActorId(key);
}

/**
 * 同名角色消歧（角色包重复导入很常见）。
 * 优先：preferPeerIds → 主角色卡（非 lightnpc/phone-contact）→ 与当前会话角色同组
 * → 与会话角色有角色卡关系 → 最近更新。仍并列则放弃，避免误绑。
 */
function pickPreferredActorCandidate(candidateIds = [], options = {}) {
  const ids = [...new Set((Array.isArray(candidateIds) ? candidateIds : [])
    .map((id) => cleanString(id))
    .filter((id) => id && id !== 'user'))];
  if (!ids.length) return '';
  if (ids.length === 1) return ids[0];

  const preferSet = new Set((Array.isArray(options.preferPeerIds) ? options.preferPeerIds : [])
    .map((id) => cleanString(id))
    .filter(Boolean));
  const preferred = ids.filter((id) => preferSet.has(id));
  if (preferred.length === 1) return preferred[0];
  if (preferred.length > 1) {
    return pickPreferredActorCandidate(preferred, { ...options, preferPeerIds: [] });
  }

  const mainIds = ids.filter((id) => !isSecondaryActorCopyId(id));
  if (mainIds.length === 1) return mainIds[0];
  const pool = mainIds.length ? mainIds : ids;

  const characters = options.characters && typeof options.characters === 'object'
    ? options.characters
    : {};
  const addressBook = Array.isArray(options.addressBookCharacters)
    ? options.addressBookCharacters
    : [];
  const byId = new Map([
    ...Object.entries(characters).map(([id, row]) => [cleanString(id), row]),
    ...addressBook.map((row) => [cleanString(row?.id), row]),
  ].filter(([id]) => id));

  const focusIds = [...new Set([
    ...(Array.isArray(options.chat?.participants) ? options.chat.participants : []),
    ...preferSet,
  ].map((id) => cleanString(id)).filter((id) => id && id !== 'user'))];

  const focusGroups = new Set(focusIds.map((id) => {
    const row = byId.get(id);
    return cleanString(row?.groupId || 'default') || 'default';
  }));
  const sameGroup = pool.filter((id) => {
    const row = byId.get(id);
    const gid = cleanString(row?.groupId || 'default') || 'default';
    return focusGroups.has(gid);
  });
  if (sameGroup.length === 1) return sameGroup[0];

  const related = (sameGroup.length ? sameGroup : pool).filter((id) => {
    const row = byId.get(id);
    const rel = row?.relationships && typeof row.relationships === 'object' ? row.relationships : {};
    if (focusIds.some((fid) => String(rel[fid] || '').trim())) return true;
    return focusIds.some((fid) => {
      const other = byId.get(fid);
      const otherRel = other?.relationships && typeof other.relationships === 'object' ? other.relationships : {};
      return String(otherRel[id] || '').trim();
    });
  });
  if (related.length === 1) return related[0];

  const ranked = (related.length ? related : (sameGroup.length ? sameGroup : pool))
    .map((id) => {
      const row = byId.get(id) || {};
      return {
        id,
        updatedAt: Number(row.updatedAt || row.createdAt || 0) || 0,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  if (ranked.length >= 2 && ranked[0].updatedAt > 0 && ranked[0].updatedAt > ranked[1].updatedAt) {
    return ranked[0].id;
  }
  return '';
}

/** 将 AI 输出的 from/别名/近似 id 解析为本群真实 participant id */
export function buildMarshmallowActorResolver(options = {}) {
  const chat = options.chat || null;
  const characters = options.characters || {};
  const addressBookCharacters = Array.isArray(options.addressBookCharacters) ? options.addressBookCharacters : [];
  const preferPeerIds = [...new Set((Array.isArray(options.preferPeerIds) ? options.preferPeerIds : [])
    .map((id) => cleanString(id))
    .filter(Boolean))];
  const allowedParticipantIds = [...new Set([
    'user',
    ...(chat?.participants || []),
    ...(options.extraActorIds || []),
  ].filter(Boolean))];
  const lookupParticipantIds = [...new Set([
    ...allowedParticipantIds,
    ...(options.actorResolutionExtraIds || []),
  ].filter(Boolean))];
  const allowed = new Set(allowedParticipantIds);
  const currentParticipantIds = new Set([
    'user',
    ...(chat?.participants || []),
  ].map((id) => cleanString(id)).filter(Boolean));
  const knownActorIds = new Set([
    ...lookupParticipantIds,
    ...addressBookCharacters.map((entry) => cleanString(entry?.id)).filter(Boolean),
  ]);
  const lookup = new Map();
  const addLookupCandidate = (key, id) => {
    const normalized = normalizeActorLookupKey(key);
    const actorId = cleanString(id);
    if (!normalized || !actorId) return;
    const candidates = lookup.get(normalized) || new Set();
    candidates.add(actorId);
    lookup.set(normalized, candidates);
  };

  const actorReferences = buildChatActorReferenceTable(chat, {
    actorIds: (chat?.participants || []).length
      ? []
      : allowedParticipantIds.filter((id) => id !== 'user'),
    includeUser: true,
  });
  for (const row of actorReferences.rows) {
    addLookupCandidate(row.ref, row.id);
  }

  for (const pid of lookupParticipantIds) {
    if (pid === 'user') continue;
    const char = characters[pid] || null;
    const keys = [pid];
    if (char) {
      keys.push(char.name, char.realName, char.customNickname, ...(Array.isArray(char.aliases) ? char.aliases : []));
    }
    for (const key of keys) {
      addLookupCandidate(key, pid);
    }
  }
  const currentUserNameKey = normalizeActorLookupKey(options.currentUserName);
  if (currentUserNameKey) {
    addLookupCandidate(currentUserNameKey, 'user');
  }

  // 幕后/合并转发允许提到通讯录里其它真实角色（哪怕还不在本对话里），但只认已存在的角色卡——
  // 不接受 AI 现场编出来的名字，避免幕后群混进没有头像、通讯录对不上号的假人物。
  for (const entry of addressBookCharacters) {
    const pid = String(entry?.id || '').trim();
    if (!pid || lookupParticipantIds.includes(pid)) continue;
    const keys = [pid, entry.name, entry.realName, entry.customNickname, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    for (const key of keys) {
      addLookupCandidate(key, pid);
    }
  }

  // 手机轻量通讯录优先于关系网 lightnpc_ / 临时 npc_：同名时落到 phone-contact（或已链接主角色），
  // 避免群成员里已有复制体时仍按复制体落库。
  for (const entry of addressBookCharacters) {
    const isPhoneRow = !!(entry?._phoneLightContact || entry?.metadata?.isPhoneLightContact || entry?.metadata?.fromPhoneContact);
    if (!isPhoneRow) continue;
    const pid = String(entry?.id || '').trim();
    if (!pid) continue;
    const keys = [entry.name, entry.realName, entry.customNickname, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    for (const key of keys) {
      const normalized = normalizeActorLookupKey(key);
      if (!normalized) continue;
      const current = lookup.get(normalized) || new Set();
      const nonCopies = [...current].filter((id) => !id.startsWith('lightnpc_') && !isEphemeralNpcActorId(id));
      if (!nonCopies.length || (nonCopies.length === 1 && nonCopies[0] === pid)) {
        lookup.set(normalized, new Set([pid]));
      } else {
        current.add(pid);
        lookup.set(normalized, current);
      }
    }
  }

  if (isAnonymousChat(chat)) {
    const identitySources = [
      chat?.groupSettings?.anonymousIdentities,
      chat?.anonymousPrivateConfig?.identities,
      chat?.metadata?.anonymousIdentities,
    ];
    for (const source of identitySources) {
      if (!source || typeof source !== 'object') continue;
      for (const [actorId, entry] of Object.entries(source)) {
        if (!allowed.has(actorId)) continue;
        const anonId = cleanString(entry?.currentId);
        if (!anonId) continue;
        const normalized = normalizeActorLookupKey(anonId);
        if (normalized && !lookup.has(normalized)) addLookupCandidate(normalized, actorId);
      }
    }
  }

  const disambiguateOptions = {
    preferPeerIds,
    chat,
    characters,
    addressBookCharacters,
  };

  const resolveActor = function resolveActor(rawActor = '') {
    const actor = cleanString(rawActor);
    if (!actor) return actor;
    const actorReference = normalizeActorReference(actor);
    if (actorReference) {
      const referencedId = actorReferences.idFor(actorReference);
      if (referencedId) return referencedId;
    }
    // Exact ids are authoritative even when two people share every display name.
    if (knownActorIds.has(actor)) return actor;
    const candidates = [...(lookup.get(normalizeActorLookupKey(actor)) || [])];
    if (candidates.length === 1) return candidates[0];
    // 同名多卡：用会话焦点 / 主角色 / 同组 / 角色卡关系消歧，而不是直接放弃。
    // 角色包重复导入后，跨窗 peer_private 最容易踩这里。
    if (candidates.length > 1) {
      const currentCandidates = candidates.filter((id) => currentParticipantIds.has(id));
      // 当前窗口内只要有两个人共享同一显示名（包括 user 与角色水仙同名），
      // 裸名字就永远不猜；模型必须改用 U / C1 / C2 这张本轮身份表。
      if (currentCandidates.length > 1) return '';
      return pickPreferredActorCandidate(candidates, disambiguateOptions);
    }
    // 仅对带分隔符/数字、明显像正式内部 ID 的值容错；且必须唯一高置信命中。
    // 这保留 character_dalta → character_delta 一类单字符手误，
    // 同时不让 Charlie 这类普通英文姓名参与编辑距离绑定。
    const fuzzy = /[_:\d-]/.test(actor)
      ? pickUniqueParticipantByIdShape(actor, lookupParticipantIds)
      : '';
    if (fuzzy) return fuzzy;
    // charB / actor2 这类模型自造占位若没有唯一高置信的真实 ID 命中，
    // 必须直接拒绝，不得降级成新路人或绑到本群唯一角色。
    if (looksLikeUnresolvedInternalActorRef(actor)) return '';
    // 找不到任何已注册角色时不再原样放行——原样返回会把 AI 现场编的名字当成一个新「角色 id」落库，
    // 幕后群/合并转发因此会混进没有头像、通讯录对不上号的假人物。
    return '';
  };
  resolveActor.isAmbiguous = (rawActor = '') => {
    const candidates = [...(lookup.get(normalizeActorLookupKey(rawActor)) || [])];
    if (candidates.length <= 1) return false;
    const currentCandidates = candidates.filter((id) => currentParticipantIds.has(id));
    if (currentCandidates.length > 1) return true;
    return !pickPreferredActorCandidate(candidates, disambiguateOptions);
  };
  resolveActor.candidates = (rawActor = '') => (
    [...(lookup.get(normalizeActorLookupKey(rawActor)) || [])]
  );
  // 跨窗成对消歧：已知一方时，把对方锚进 prefer，并排除「自己点自己」。
  resolveActor.withAnchors = (rawActor = '', anchorIds = []) => {
    const anchors = [...new Set((Array.isArray(anchorIds) ? anchorIds : [])
      .map((id) => cleanString(id))
      .filter(Boolean))];
    const candidates = resolveActor.candidates(rawActor);
    if (!candidates.length) return resolveActor(rawActor);
    if (candidates.length === 1) return candidates[0];
    const others = candidates.filter((id) => !anchors.includes(id));
    if (others.length === 1) return others[0];
    return pickPreferredActorCandidate(candidates, {
      ...disambiguateOptions,
      preferPeerIds: [...preferPeerIds, ...anchors],
    });
  };
  return resolveActor;
}

function applyActorResolutionToEvent(event = {}, resolveActor, options = {}) {
  if (typeof resolveActor !== 'function') return { ...event };
  const next = { ...event };
  const actor = getEventActor(next);
  if (actor) {
    const resolved = resolveActor(actor);
    if (resolved) {
      if (resolved !== actor) {
        next.from = resolved;
        if (next.actor) next.actor = resolved;
        if (next.senderId) next.senderId = resolved;
      }
    } else if (normalizeActorReference(actor) || looksLikeUnresolvedInternalActorRef(actor)) {
      next.unresolvedInternalActorRef = actor;
    } else if (next.t === 'chat_bundle') {
      // 转发卡的外层发送者必须能解析到真实角色。微博作者、帖子账号或随机 handle
      // 只能留在卡片内容中，不能被提升成一次性 NPC 或新的聊天联系人。
      next.unresolvedChatBundleSender = actor;
    } else if (
      options.allowEphemeralActors === true
      && EPHEMERAL_FRONTSTAGE_EVENT_TYPES.has(next.t)
      && !isGenericPeerActorLabel(actor)
      && resolveActor.isAmbiguous?.(actor) !== true
    ) {
      const label = stripEphemeralNpcLabel(actor);
      next.from = buildEphemeralNpcId(label);
      next.fromLabel = stripEphemeralNpcLabel(next.fromLabel) || label;
      next.ephemeralNpc = true;
    }
  }
  if (next.t === 'nudge' && next.target && next.target !== 'user') {
    const resolvedTarget = resolveActor(next.target);
    if (resolvedTarget) next.target = resolvedTarget;
  }
  if (GROUP_MANAGEMENT_EVENT_TYPES.has(next.t)) {
    for (const key of ['target', 'to']) {
      const rawTarget = cleanString(next[key]);
      if (!rawTarget || rawTarget === 'all') continue;
      const resolvedTarget = resolveActor(rawTarget);
      if (resolvedTarget) next[key] = resolvedTarget;
    }
  }
  if (next.t === 'gen_image' && Array.isArray(next.subjects)) {
    next.subjects = [...new Set(next.subjects.map((subject) => {
      const rawSubject = cleanString(subject);
      if (!rawSubject) return '';
      return resolveActor(rawSubject) || rawSubject;
    }).filter(Boolean))];
  }
  if ((next.t === 'backstage' || next.t === 'peer_private') && Array.isArray(next.lines)) {
    // 能匹配到在场角色/通讯录角色的，落成真实身份；匹配不到时不再当场发明一个
    // 「正式角色 id」（那会在幕后群里变成没头像、通讯录对不上号的假成员）——
    // 改成一次性 NPC：保留台词和原始称呼，但不进正式成员名单、不占用真实角色的头像和记忆位。
    // 「对方 / 对方角色名」是协议示例占位，禁止落成说话人「对方」。
    next.lines = next.lines
      .map((line) => {
        if (!line || typeof line !== 'object') return null;
        const lineActor = cleanString(line.from || line.actor || line.senderId);
        if (!lineActor) return null;
        if (isGenericPeerActorLabel(lineActor)) {
          return { ...line, from: '', fromLabel: '', unresolvedPeerPlaceholder: true, _rawFrom: lineActor };
        }
        const resolved = resolveActor(lineActor);
        if (resolved) return resolved === lineActor ? line : { ...line, from: resolved };
        if (normalizeActorReference(lineActor) || looksLikeUnresolvedInternalActorRef(lineActor)) return null;
        if (resolveActor.isAmbiguous?.(lineActor) === true) return null;
        const cleanLabel = stripEphemeralNpcLabel(lineActor) || lineActor;
        if (isGenericPeerActorLabel(cleanLabel)) {
          return { ...line, from: '', fromLabel: '', unresolvedPeerPlaceholder: true, _rawFrom: lineActor };
        }
        return { ...line, from: buildEphemeralNpcId(cleanLabel), fromLabel: cleanLabel, ephemeralNpc: true };
      })
      .filter(Boolean);
  }
  if (next.t === 'backstage' && Array.isArray(next.memberIds)) {
    next.memberIds = [...new Set(next.memberIds
      .map((rawId) => {
        const id = cleanString(rawId);
        if (!id || id === 'user') return '';
        return cleanString(resolveActor(id) || '');
      })
      .filter(Boolean))];
  }
  if (next.t === 'peer_private' && next.to) {
    if (isGenericPeerActorLabel(next.to)) {
      next.unresolvedTo = next.to;
      next.to = '';
    } else {
      const rawTo = next.to;
      const resolvedTo = resolveActor(rawTo);
      next.to = resolvedTo || '';
      if (!resolvedTo) next.unresolvedTo = rawTo;
    }
  }
  if (next.t === 'chat_bundle' && next.to) {
    const rawTo = next.to;
    const resolvedTo = rawTo === 'user' ? 'user' : resolveActor(rawTo);
    next.to = resolvedTo || '';
    if (!resolvedTo) next.unresolvedTo = rawTo;
  }
  if (next.t === 'private_msg' && normalizeActorReference(next.to) === 'U') {
    next.to = 'user';
  }
  if (next.t === 'peer_private' && next.from && isGenericPeerActorLabel(next.from)) {
    next.from = '';
  }
  return next;
}

function escapeMentionPattern(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function visibleGroupActorLabel(actorId = '', options = {}) {
  const id = cleanString(actorId);
  if (!id) return '';
  if (id === 'user') return cleanString(options.currentUserName || '用户') || '用户';
  const memberCard = cleanString(options.chat?.groupSettings?.memberCards?.[id]);
  if (memberCard) return memberCard;
  const character = options.characters?.[id] || null;
  const characterName = cleanString(
    character?.name || character?.customNickname || character?.realName,
  );
  if (characterName && characterName !== id) return characterName;
  const addressBookRow = (Array.isArray(options.addressBookCharacters)
    ? options.addressBookCharacters
    : []).find((row) => cleanString(row?.id) === id);
  const addressBookName = cleanString(
    addressBookRow?.name || addressBookRow?.customNickname || addressBookRow?.realName,
  );
  return addressBookName && addressBookName !== id ? addressBookName : '';
}

/**
 * U/C1/C2…只属于 JSON 身份字段。模型若把 @C3 写进可见群聊正文，
 * 在入库前按本轮同一张身份表还原成群名片/角色名，避免协议短引用穿帮。
 */
function sanitizeGroupActorReferenceMentions(events = [], options = {}) {
  if (options.chat?.type !== 'group' || isAnonymousChat(options.chat)) {
    return Array.isArray(events) ? events : [];
  }
  const actorReferences = buildChatActorReferenceTable(options.chat, {
    includeUser: (options.chat?.participants || []).includes('user'),
  });
  const visibleActorIds = new Set(actorReferences.rows.map((row) => row.id));
  const mentionPattern = /[@＠][\t ]*(?:[UＵｕ]|[CＣｃc][\t _-]*(?:0|０)*[0-9０-９]{1,3})(?=$|[^A-Za-z0-9_])/g;
  return (Array.isArray(events) ? events : []).map((event) => {
    if (!event || event.t !== 'msg') return event;
    const body = cleanString(event.body || event.text || event.content);
    if (!body || !/[@＠][\t ]*[UCＵｕＣｃ]/i.test(body)) return event;
    const sanitized = body.replace(mentionPattern, (token) => {
      const reference = normalizeActorReference(token);
      const actorId = actorReferences.idFor(reference);
      const label = visibleActorIds.has(actorId)
        ? visibleGroupActorLabel(actorId, options)
        : '';
      return label ? `@${label}` : '某位成员';
    });
    return sanitized === body ? event : { ...event, body: sanitized };
  });
}

function resolveGenericGroupActorFallback(events = [], options = {}, resolveActor = null) {
  if (options.chat?.type !== 'group' || typeof resolveActor !== 'function') return '';
  const participants = [...new Set((options.chat?.participants || [])
    .map((id) => cleanString(id))
    .filter((id) => id && id !== 'user'))];
  if (participants.length === 1) return participants[0];
  const stateActors = [...new Set((Array.isArray(events) ? events : [])
    .filter((event) => event?.t === 'state')
    .map((event) => resolveActor(getEventActor(event)))
    .filter((id) => id && id !== 'user' && participants.includes(id)))];
  return stateActors.length === 1 ? stateActors[0] : '';
}

/**
 * 一对一窗口没有真正的 @ 收件机制。模型偶尔会把关系网或群聊上下文中的第三人
 * 写成「@某人」，视觉上像把群成员拉进了私聊。这里仅移除已知窗外角色名前的 @：
 * 仍允许自然谈论第三人，也不会误伤邮箱、社交账号或普通文本。
 */
export function sanitizePrivateChatMentionScope(events = [], options = {}) {
  const chat = options.chat || null;
  const source = Array.isArray(events) ? events : [];
  if (!chat || chat.type === 'group') return [...source];

  const participantIds = new Set((chat.participants || [])
    .map((id) => cleanString(id))
    .filter(Boolean));
  const rows = [
    ...Object.values(options.characters || {}),
    ...(Array.isArray(options.addressBookCharacters) ? options.addressBookCharacters : []),
  ];
  const aliases = new Set(['全体成员', '所有人', 'all']);
  for (const row of rows) {
    const id = cleanString(row?.id);
    if (!id || participantIds.has(id)) continue;
    const values = [
      id,
      row?.realName,
      row?.name,
      row?.customNickname,
      row?.nickname,
      row?.displayName,
      ...(Array.isArray(row?.aliases) ? row.aliases : []),
    ];
    for (const value of values) {
      const alias = cleanString(value).replace(/^[@＠]+/, '').trim();
      if (alias && alias.length <= 48) aliases.add(alias);
    }
  }
  const sortedAliases = [...aliases].sort((a, b) => b.length - a.length);
  const nonAsciiPattern = sortedAliases
    .filter((alias) => /[^\x00-\x7F]/.test(alias))
    .map(escapeMentionPattern)
    .join('|');
  const asciiPattern = sortedAliases
    .filter((alias) => !/[^\x00-\x7F]/.test(alias))
    .map(escapeMentionPattern)
    .join('|');
  if (!nonAsciiPattern && !asciiPattern) return [...source];
  // 中文称呼后常直接接「呢/也/你」而没有空格；英文账号则保留右边界，
  // 避免已知别名 all 误伤 @alliance 一类真实社交账号。
  const aliasPattern = [
    nonAsciiPattern ? `(${nonAsciiPattern})` : '',
    asciiPattern
      ? `(${asciiPattern})(?=$|[\\s，。！？、；：,!?;:）)】\\]])`
      : '',
  ].filter(Boolean).join('|');
  const mentionRe = new RegExp(
    `(^|[\\s，。！？、；：,!?;:（(【\\[])\\s*[@＠][\\t ]*(?:${aliasPattern})`,
    'giu',
  );
  return source.map((event) => {
    if (!event || event.t !== 'msg') return event;
    const body = cleanString(event.body || event.text || event.content);
    if (!body || !mentionRe.test(body)) {
      mentionRe.lastIndex = 0;
      return event;
    }
    mentionRe.lastIndex = 0;
    const sanitized = body.replace(
      mentionRe,
      (_, prefix, nonAsciiAlias, asciiAlias) => `${prefix}${nonAsciiAlias || asciiAlias || ''}`,
    );
    return sanitized === body ? event : { ...event, body: sanitized };
  });
}

export function validateMarshmallowChatEvents(events = [], options = {}) {
  const chat = options.chat || null;
  const userAbsentGroup = chat?.type === 'group' && !isUserPresentInChat(chat);
  const userName = cleanString(options.currentUserName || '用户');
  const escapedUserName = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absentUserAliases = [escapedUserName, '用户', 'user']
    .filter(Boolean)
    .join('|');
  const absentUserAddressRe = absentUserAliases
    ? new RegExp(`@(?:${absentUserAliases})(?=$|[\\s，,。.!！？?:：])`, 'iu')
    : null;
  const absentUserMembershipRe = absentUserAliases
    ? new RegExp(`(?:${absentUserAliases})(.{0,10})(?:在|进了|加入了)(?:这个|我们)?群`, 'iu')
    : null;
  const allowed = getAllowedActors(chat, options.extraActorIds || []);
  const initialGroupSettings = chat?.groupSettings || {};
  const virtualGroupParticipants = new Set((chat?.participants || [])
    .map((id) => cleanString(id))
    .filter(Boolean));
  let virtualGroupOwner = cleanString(initialGroupSettings.owner)
    || (virtualGroupParticipants.has('user')
      ? 'user'
      : [...virtualGroupParticipants].find((id) => id !== 'user') || '');
  const virtualGroupAdmins = new Set((Array.isArray(initialGroupSettings.admins)
    ? initialGroupSettings.admins
    : [])
    .map((id) => cleanString(id))
    .filter(Boolean));
  const inviteable = new Set([
    ...(Array.isArray(options.addressBookCharacters) ? options.addressBookCharacters : [])
      .map((row) => cleanString(row?.id)),
    ...(Array.isArray(options.extraActorIds) ? options.extraActorIds : []).map(cleanString),
  ].filter(Boolean));
  const resolveActor = buildMarshmallowActorResolver(options);
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const roundMessages = [];
  const valid = [];
  const rejected = [];

  const scopedEvents = sanitizeGroupActorReferenceMentions(
    sanitizePrivateChatMentionScope(events, options),
    options,
  );
  const genericGroupActorFallback = resolveGenericGroupActorFallback(
    scopedEvents,
    options,
    resolveActor,
  );
  for (const rawEvent of scopedEvents) {
    const rawActor = getEventActor(rawEvent);
    const actorScopedEvent = genericGroupActorFallback && isGenericPeerActorLabel(rawActor)
      ? {
        ...rawEvent,
        from: genericGroupActorFallback,
        actor: rawEvent?.actor ? genericGroupActorFallback : rawEvent?.actor,
        senderId: rawEvent?.senderId ? genericGroupActorFallback : rawEvent?.senderId,
        repairedGenericGroupActor: rawActor,
      }
      : rawEvent;
    let event = applyActorResolutionToEvent(actorScopedEvent, resolveActor, {
      allowEphemeralActors: chat?.type === 'group',
    });
    if ((event?.t === 'social_post' || event?.t === 'open_alias' || event?.t === 'social_react' || event?.t === 'share_back' || event?.t === 'alias_poke' || event?.t === 'next_reply_delay' || event?.t === 'presence' || event?.t === 'hard_offline' || event?.t === 'wait_mood') && !getEventActor(event)) {
      const privateActorIds = [...allowed].filter((id) => id && id !== 'user');
      if (chat?.type !== 'group' && privateActorIds.length === 1) {
        event = { ...event, from: privateActorIds[0] };
      }
    }
    if (event?.t === 'backstage' || event?.t === 'peer_private') {
      const normalizedList = normalizeCrossWindowSideEvents([event], {
        resolveActor,
        preferPeerIds: options.preferPeerIds,
        actorResolutionExtraIds: options.actorResolutionExtraIds,
        extraActorIds: options.extraActorIds,
        chat: options.chat,
        characters: options.characters,
        addressBookCharacters: options.addressBookCharacters,
      });
      if (!normalizedList.length) {
        rejected.push({ event, errors: [{ code: 'cross_window_placeholder_unresolved' }] });
        continue;
      }
      event = normalizedList[0];
    }
    const errors = [];
    if (event?.t === 'msg' && /(?:【|\[)\s*发送\s*[:：·•]\s*(?:私聊|群聊|幕后|建群)\s*[:：·•]/u.test(
      cleanString(event.body || event.text || event.content),
    )) {
      // 发送块是隐藏路由动作，绝不能作为普通气泡渲染。真正的块若被模型写在
      // 协议尾标外，会由 send-ops 的开放尾块抢救器单独解析。
      errors.push({ code: 'send_directive_leaked_into_message' });
    }
    if (userAbsentGroup && event?.t === 'msg') {
      const body = cleanString(event.body || event.text || event.content);
      const membershipMatch = absentUserMembershipRe?.exec(body);
      const assertsMembership = !!membershipMatch && !/(?:不|没|未|别|尚)/u.test(membershipMatch[1] || '');
      if (absentUserAddressRe?.test(body) || assertsMembership) {
        errors.push({ code: 'absent_user_treated_as_group_member' });
      }
    }
    if (options.salvageBubbles && !isSalvageableMarshmallowBubbleEvent(event)) {
      rejected.push({ event, errors: [{ code: 'salvage_not_bubble' }] });
      continue;
    }
    const actor = getEventActor(event);
    if (event.t === 'backstage' && (!Array.isArray(event.lines) || event.lines.length === 0)) {
      errors.push({ code: 'backstage_no_lines' });
    }
    if (event.t === 'backstage' && event.create === true) {
      let memberIds = [...new Set((Array.isArray(event.memberIds) ? event.memberIds : [])
        .map((id) => cleanString(id))
        .filter((id) => id && id !== 'user' && !isEphemeralNpcActorId(id)))];
      // 模型偶尔把 memberIds 理解成“被拉进群的人”，漏掉当前窗口里的建群发起者。
      // 只修这一种无歧义形状：已经明确写了两名成员，唯一缺席者来自当前聊天且也实际发了言。
      // 其余缺员仍拒绝，不能把任意 lines 发言人都猜成正式群成员。
      if (memberIds.length >= 2 && memberIds.length < 3) {
        const sourceParticipantIds = new Set((chat?.participants || [])
          .map((id) => cleanString(id))
          .filter((id) => id && id !== 'user'));
        const missingSourceSpeakers = [...new Set((event.lines || [])
          .map((line) => cleanString(line?.from || line?.actor || line?.senderId))
          .filter((id) => id
            && !isEphemeralNpcActorId(id)
            && sourceParticipantIds.has(id)
            && !memberIds.includes(id)))];
        if (missingSourceSpeakers.length === 1) {
          memberIds = [...memberIds, missingSourceSpeakers[0]];
          event = {
            ...event,
            memberIds,
            memberIdsRepairedFromSourceActor: missingSourceSpeakers[0],
          };
        }
      }
      const routedParticipantIds = [...new Set([
        ...memberIds,
        ...(event.lines || [])
          .map((line) => cleanString(line?.from || line?.actor || line?.senderId))
          .filter((id) => id && id !== 'user' && !isEphemeralNpcActorId(id)),
      ])];
      const sourceParticipantIds = new Set((chat?.participants || [])
        .map((id) => cleanString(id))
        .filter((id) => id && id !== 'user'));
      const sourceSpeakerId = (event.lines || [])
        .map((line) => cleanString(line?.from || line?.actor || line?.senderId))
        .find((id) => id && sourceParticipantIds.has(id) && memberIds.includes(id));
      const requestedInitiator = cleanString(event.initiatorId);
      const initiatorExplicit = !!requestedInitiator && memberIds.includes(requestedInitiator);
      const initiatorId = initiatorExplicit
        ? requestedInitiator
        : (sourceSpeakerId || memberIds[0] || '');
      if (initiatorId && (
        initiatorId !== event.initiatorId
        || initiatorExplicit !== event.initiatorExplicit
      )) {
        event = { ...event, initiatorId, initiatorExplicit };
      }
      // A two-person backstage event can be recovered deterministically as
      // peer_private by the persistence gate. Do not reject it here merely
      // because the model also wrote create:true. New one-person or genuine
      // multi-person groups still require a complete explicit memberIds list.
      if (memberIds.length < 3 && routedParticipantIds.length !== 2) {
        errors.push({ code: 'backstage_create_requires_explicit_members' });
      }
    }
    if (event.t === 'peer_private') {
      const peerIds = new Set([
        cleanString(event.to),
        ...(Array.isArray(event.lines) ? event.lines.map((line) => cleanString(line?.from)) : []),
      ].filter((id) => id && id !== 'user'));
      const realPeerIds = [...peerIds].filter((id) => !isEphemeralNpcActorId(id));
      if (!event.to || !Array.isArray(event.lines) || !event.lines.length) {
        errors.push({ code: 'peer_private_incomplete' });
      } else if (peerIds.size !== 2 || realPeerIds.length < 1) {
        errors.push({ code: 'peer_private_requires_two_characters' });
      }
    }
    if (event.t === 'chat_bundle'
      && (event.unresolvedChatBundleSender
        || event.ephemeralNpc === true
        || isEphemeralNpcActorId(actor))) {
      errors.push({
        code: 'chat_bundle_user_target_requires_real_sender',
        actor: cleanString(event.unresolvedChatBundleSender) || actor,
      });
    } else if (event.t === 'chat_bundle' && event.unresolvedTo) {
      errors.push({ code: 'chat_bundle_target_not_found', target: event.unresolvedTo });
    } else if (event.t === 'chat_bundle'
      && event.to === 'user'
      && (chat?.participants || []).includes('user')) {
      errors.push({ code: 'chat_bundle_user_target_omit_to' });
    } else if (event.t === 'chat_bundle'
      && event.to === 'user'
      && !(chat?.participants || []).includes('user')
      && event.shareWithUser !== true) {
      errors.push({ code: 'chat_bundle_user_target_requires_explicit_intent' });
    } else if (event.t === 'chat_bundle' && event.to && event.to === actor) {
      errors.push({ code: 'chat_bundle_target_matches_sender', target: event.to });
    }
    const needsActor = ['msg', 'react', 'recall', 'sticker', 'image', 'gen_image', 'textimg', 'voice', 'voice_call', 'dice', 'redpacket', 'redpacket_claim', 'transfer', 'transfer_accept', 'transfer_return', 'order_share', 'html_widget', 'link', 'location', 'offline_invite', 'vote', 'vote_close', 'nudge', 'status', 'state', 'situation', 'schedule_change', 'auto_reply', 'alias', 'avatar', 'private_msg', 'group_name', 'group_announcement', 'group_todo', 'group_transfer', 'group_admin', 'group_member', 'group_remote', 'group_title', 'mute', 'chat_bundle', 'npc_card', 'anonymous_reveal', 'memo', 'radio_plan', 'interaction_plan', 'period_offer', 'period_confirm', 'period_decline', 'period_set', 'period_end', 'invite_user', 'stranger_block', 'stranger_friend', 'stranger_unblock', 'stranger_suspect', 'social_post', 'open_alias', 'social_react', 'share_back', 'alias_poke', 'next_reply_delay', 'presence', 'hard_offline', 'wait_mood'].includes(event.t);
    if (event.t === 'group_remote') {
      const allowedRemoteGroups = new Set((Array.isArray(options.remoteGroupIds) ? options.remoteGroupIds : [])
        .map((id) => cleanString(id))
        .filter(Boolean));
      const operations = new Set(['group_name', 'group_announcement', 'group_todo', 'group_title', 'group_transfer', 'group_admin', 'group_member', 'mute', 'vote_close', 'invite_user']);
      if (chat?.type === 'group' || !(chat?.participants || []).includes('user')) {
        errors.push({ code: 'remote_group_requires_user_private_chat' });
      }
      if (!cleanString(event.groupId) || !allowedRemoteGroups.has(cleanString(event.groupId))) {
        errors.push({ code: 'remote_group_target_invalid', groupId: event.groupId });
      }
      if (!operations.has(cleanString(event.operation))) {
        errors.push({ code: 'remote_group_operation_invalid', operation: event.operation });
      }
      if (event.operation === 'group_name' && !cleanString(event.name)) errors.push({ code: 'group_name_missing' });
      if (['group_title', 'group_transfer', 'group_admin', 'group_member', 'mute'].includes(event.operation)
        && !cleanString(event.target)) errors.push({ code: 'group_management_target_missing', eventType: event.operation });
      if (event.operation === 'group_todo' && cleanString(event.todoAction || 'add') === 'add' && !cleanString(event.text)) {
        errors.push({ code: 'group_todo_text_missing' });
      }
    }
    if (GROUP_MANAGEMENT_EVENT_TYPES.has(event.t)) {
      const gs = chat?.groupSettings || {};
      const owner = virtualGroupOwner;
      const isManager = actor === owner || virtualGroupAdmins.has(actor);
      if (chat?.type !== 'group') {
        errors.push({ code: 'group_management_requires_group' });
      } else if (gs.allowAiGroupOps === false) {
        errors.push({ code: 'ai_group_management_disabled' });
      } else if (!isManager) {
        errors.push({ code: 'group_management_permission_denied', actor });
      } else if (event.t === 'group_transfer' && actor !== owner) {
        errors.push({ code: 'group_transfer_owner_required', actor });
      } else if (event.t === 'group_admin' && actor !== owner) {
        errors.push({ code: 'group_admin_owner_required', actor });
      }
      const target = cleanString(event.target || event.to);
      if (['group_title', 'group_transfer', 'group_admin', 'group_member', 'mute'].includes(event.t) && !target) {
        errors.push({ code: 'group_management_target_missing', eventType: event.t });
      } else if (event.t === 'group_member' && cleanString(event.action) === 'add') {
        if (!inviteable.has(target) || virtualGroupParticipants.has(target)) {
          errors.push({ code: 'group_member_invite_target_invalid', target });
        }
      } else if (target && target !== 'all' && !virtualGroupParticipants.has(target)) {
        errors.push({ code: 'group_management_target_not_in_chat', eventType: event.t, target });
      }
      if (event.t === 'group_name' && !cleanString(event.name)) {
        errors.push({ code: 'group_name_missing' });
      }
      if (event.t === 'group_todo') {
        const action = cleanString(event.action || 'add').toLowerCase();
        const todoId = cleanString(event.id || event.todoId);
        if (['done', 'complete', 'toggle', 'delete', 'remove'].includes(action) && !todoId) {
          errors.push({ code: 'group_todo_id_missing', action });
        } else if (!['done', 'complete', 'toggle', 'delete', 'remove'].includes(action) && !cleanString(event.text)) {
          errors.push({ code: 'group_todo_text_missing' });
        }
      }
      if (event.t === 'group_member') {
        if (!['add', 'remove'].includes(cleanString(event.action || 'remove'))) {
          errors.push({ code: 'group_member_action_invalid', action: event.action });
        }
        if (cleanString(event.action || 'remove') === 'remove' && (target === 'user' || target === owner)) {
          errors.push({ code: 'group_member_protected_target', target });
        }
      }
    }
    if (event.t === 'vote') {
      const options = Array.isArray(event.options)
        ? event.options.map((item) => cleanString(item)).filter(Boolean)
        : [];
      if (chat?.type !== 'group') errors.push({ code: 'vote_requires_group' });
      if (!cleanString(event.question || event.title || event.body)) errors.push({ code: 'vote_question_missing' });
      if (options.length < 2 || options.length > 8) {
        errors.push({ code: 'vote_options_count_invalid', count: options.length });
      }
    }
    if (event.t === 'vote_close') {
      if (chat?.type !== 'group') errors.push({ code: 'vote_close_requires_group' });
      if (!actor || !virtualGroupParticipants.has(actor)) errors.push({ code: 'vote_close_actor_not_in_chat', actor });
    }
    if (event.t === 'private_msg') {
      if (chat?.type !== 'group') {
        errors.push({ code: 'private_msg_requires_group' });
      }
      const privateTarget = cleanString(event.to);
      if (privateTarget !== 'user') {
        errors.push({
          code: privateTarget ? 'private_msg_target_must_be_user' : 'private_msg_target_required',
          target: privateTarget,
        });
      } else if (!(chat?.participants || []).includes('user') && event.userRelevant !== true) {
        errors.push({ code: 'private_msg_absent_user_requires_explicit_intent' });
      }
    }
    if (event.t === 'social_post') {
      if (!['moments', 'weibo', 'forum'].includes(cleanString(event.target))) {
        errors.push({ code: 'social_post_target_invalid', target: event.target });
      }
      if (!cleanString(event.brief)) errors.push({ code: 'social_post_brief_missing' });
    }
    if (event.t === 'open_alias' && !cleanString(event.intent)) {
      errors.push({ code: 'open_alias_intent_missing' });
    }
    if (event.t === 'textimg' && !cleanString(event.text || event.body)) {
      errors.push({ code: 'textimg_visible_text_missing' });
    }
    if (event.t === 'location' && !isSpecificLocationLabel(event.name || event.place || event.label || event.body)) {
      errors.push({ code: 'location_specific_name_missing' });
    }
    if (event.t === 'social_react') {
      if (!['moments', 'weibo'].includes(cleanString(event.target))) {
        errors.push({ code: 'social_react_target_invalid', target: event.target });
      }
      if (!['like', 'comment'].includes(cleanString(event.action))) {
        errors.push({ code: 'social_react_action_invalid', action: event.action });
      } else if (cleanString(event.action) === 'comment' && !cleanString(event.text)) {
        errors.push({ code: 'social_react_comment_text_missing' });
      }
      if (!cleanString(event.who)) errors.push({ code: 'social_react_who_missing' });
    }
    if (event.t === 'next_reply_delay' && (
      !Number.isFinite(Number(event.minutes))
      || Number(event.minutes) < 1
      || Number(event.minutes) > 1440
    )) {
      errors.push({ code: 'next_reply_delay_minutes_invalid', minutes: event.minutes });
    }
    if (event.t === 'hard_offline' && event.action !== 'clear' && (
      !Number.isFinite(Number(event.minutes))
      || Number(event.minutes) < 30
      || Number(event.minutes) > 20160
    )) {
      errors.push({ code: 'hard_offline_minutes_invalid', minutes: event.minutes });
    }
    if (event.t === 'hard_offline' && event.action !== 'clear' && Number(event.peekMinutes || 0) > 0 && (
      Number(event.peekMinutes) < 15
      || Number(event.peekMinutes) >= Number(event.minutes)
    )) {
      errors.push({ code: 'hard_offline_peek_minutes_invalid', peekMinutes: event.peekMinutes });
    }
    if (event.t === 'presence' && (
      !Number.isFinite(Number(event.minutes))
      || Number(event.minutes) < 1
      || Number(event.minutes) > 120
    )) {
      errors.push({ code: 'presence_minutes_invalid', minutes: event.minutes });
    }
    if (event.t === 'npc_card' && !cleanString(event.npcName || event.name)) {
      errors.push({ code: 'npc_card_missing_name' });
    }
    if (event.t === 'narration' && !cleanString(event.body)) {
      errors.push({ code: 'narration_body_missing' });
    }
    if (event.t === 'anonymous_reveal' && !cleanString(event.name || event.realName)) {
      errors.push({ code: 'anonymous_reveal_missing_name' });
    }
    if (event.t === 'stranger_block') {
      const metadata = chat?.metadata || {};
      const hasUserAlias = Object.entries(metadata.accountIdentityMap || {})
        .some(([key, accountId]) => String(key).startsWith('user:') && cleanString(accountId));
      if (metadata.channelKind !== 'stranger_intercept'
        || !hasUserAlias
        || actor === 'user'
        || metadata.friendshipState === 'blocked') {
        errors.push({ code: 'stranger_block_not_allowed' });
      }
    }
    if (event.t === 'stranger_friend') {
      const metadata = chat?.metadata || {};
      const hasUserAlias = Object.entries(metadata.accountIdentityMap || {})
        .some(([key, accountId]) => String(key).startsWith('user:') && cleanString(accountId));
      const action = cleanString(event.action);
      const state = cleanString(metadata.friendshipState || 'stranger') || 'stranger';
      const acceptOk = action === 'accept' && ['requested', 'intercepted', 'stranger'].includes(state);
      const declineOk = action === 'decline' && state === 'requested';
      const requestOk = action === 'request' && ['stranger', 'intercepted'].includes(state);
      if (metadata.channelKind !== 'stranger_intercept'
        || !hasUserAlias
        || actor === 'user'
        || state === 'blocked'
        || state === 'accepted'
        || !(acceptOk || declineOk || requestOk)) {
        errors.push({ code: 'stranger_friend_not_allowed' });
      }
    }
    if (event.t === 'stranger_unblock') {
      const metadata = chat?.metadata || {};
      const hasUserAlias = Object.entries(metadata.accountIdentityMap || {})
        .some(([key, accountId]) => String(key).startsWith('user:') && cleanString(accountId));
      if (metadata.channelKind !== 'stranger_intercept'
        || !hasUserAlias
        || actor === 'user'
        || metadata.friendshipState !== 'blocked') {
        errors.push({ code: 'stranger_unblock_not_allowed' });
      }
    }
    if (event.t === 'stranger_suspect') {
      const metadata = chat?.metadata || {};
      const hasUserAlias = Object.entries(metadata.accountIdentityMap || {})
        .some(([key, accountId]) => String(key).startsWith('user:') && cleanString(accountId));
      if (metadata.channelKind !== 'stranger_intercept' || !hasUserAlias || actor === 'user') {
        errors.push({ code: 'stranger_suspect_not_allowed' });
      }
    }
    const ephemeralActorAllowed = chat?.type === 'group'
      && EPHEMERAL_FRONTSTAGE_EVENT_TYPES.has(event.t)
      && (event.ephemeralNpc === true || isEphemeralNpcActorId(actor));
    if (event.unresolvedInternalActorRef) {
      errors.push({
        code: 'unresolved_internal_actor_ref',
        actor: cleanString(event.unresolvedInternalActorRef),
      });
    }
    const actorInScope = chat?.type === 'group'
      ? virtualGroupParticipants.has(actor)
      : allowed.has(actor);
    if (needsActor && !actorInScope && !ephemeralActorAllowed) {
      errors.push({ code: 'actor_not_in_chat', actor });
    }
    if (event.t === 'nudge') {
      const target = cleanString(event.target || 'user') || 'user';
      const targetInScope = chat?.type === 'group'
        ? virtualGroupParticipants.has(target)
        : allowed.has(target);
      if (target !== 'user' && !targetInScope) errors.push({ code: 'nudge_target_not_in_chat', target });
    }
    if (event.t === 'order_share') {
      if (actor === 'user') errors.push({ code: 'order_share_sender_must_be_character' });
      if (!cleanString(event.title)) errors.push({ code: 'order_share_missing_title' });
      if (cleanString(event.to || 'user') !== 'user') {
        errors.push({ code: 'order_share_target_must_be_user', target: event.to });
      }
    }
    if (event.t === 'html_widget') {
      if (!cleanString(event.extensionId)) errors.push({ code: 'html_widget_missing_id' });
      if (!cleanString(event.content) && !Object.keys(normalizeHtmlExtensionFields(event.fields)).length) {
        errors.push({ code: 'html_widget_missing_content' });
      }
    }
    if (event.t === 'react' && !resolveTargetRef(event.target, messages, roundMessages)) {
      errors.push({ code: 'reaction_target_not_found' });
    }
    if (event.t === 'recall') {
      // Only the actor's own, still-visible, ordinary message can be recalled.
      // Same-round targets resolve against virtual round messages here; the
      // final id is re-resolved sequentially in materialize.
      const target = resolveTargetRef(event.target, messages, roundMessages);
      if (!target) {
        errors.push({ code: 'recall_target_not_found' });
      } else if (String(target.senderId || '') !== actor) {
        errors.push({ code: 'recall_not_own_message' });
      } else if (RECALL_BLOCKED_TYPES.has(String(target.type || ''))) {
        errors.push({ code: 'recall_target_type_blocked' });
      }
    }
    if (event.t === 'redpacket_claim') {
      let target = resolveTargetRef(event.target || event.messageId || 'last_redpacket', messages, roundMessages);
      if (!target || target.type !== 'redpacket') {
        target = resolveTargetRef('last_redpacket', messages, roundMessages);
      }
      if (!target || target.type !== 'redpacket') {
        errors.push({ code: 'redpacket_claim_target_not_found' });
      } else {
        // 把 selector / 易错的 last_in_room 落成真实红包 id，避免 apply 阶段再丢
        event.target = target.id;
      }
    }
    if (event.t === 'transfer_accept' || event.t === 'transfer_return') {
      let target = resolveTargetRef(event.target || event.messageId || 'last_transfer', messages, roundMessages);
      if (!target || target.type !== 'transfer') {
        target = resolveTargetRef('last_transfer', messages, roundMessages);
      }
      const st = String(target?.metadata?.transferState || 'pending').trim();
      const pending = target && target.type === 'transfer' && (st === 'pending' || !st);
      if (!pending) {
        errors.push({ code: 'transfer_action_target_not_found' });
      } else if (String(target.senderId || '') === actor) {
        errors.push({ code: 'transfer_action_own_transfer' });
      } else {
        event.target = target.id;
      }
    }
    const replyTypes = ['msg', 'sticker', 'image', 'gen_image', 'textimg', 'voice', 'voice_call', 'redpacket', 'transfer', 'order_share', 'link', 'location'];
    if (replyTypes.includes(event.t) && event.reply && !resolveReplyTargetRef(event.reply, messages, roundMessages)) {
      // reply 只是消息的展示附属信息。目标已被删除、历史窗口没带到，或模型写错 selector
      // 时，只降级为普通消息；绝不能因为引用失效把正文、图片、表情等整条事件丢掉。
      const { reply, ...rest } = event;
      event = rest;
    }
    if (errors.length) rejected.push({ event, errors });
    else {
      if (chat?.type === 'group') {
        const target = cleanString(event.target || event.to);
        if (event.t === 'group_transfer') {
          virtualGroupOwner = target;
          virtualGroupAdmins.delete(target);
        } else if (event.t === 'group_admin') {
          if (event.admin === false) virtualGroupAdmins.delete(target);
          else virtualGroupAdmins.add(target);
        } else if (event.t === 'group_member') {
          if (cleanString(event.action || 'remove') === 'add') {
            virtualGroupParticipants.add(target);
          } else {
            virtualGroupParticipants.delete(target);
            virtualGroupAdmins.delete(target);
          }
        }
      }
      valid.push(event);
      if (['msg', 'sticker', 'image', 'textimg', 'voice', 'dice', 'gen_image', 'redpacket', 'transfer', 'order_share', 'html_widget'].includes(event.t)) {
        roundMessages.push({
          id: `virtual_${event.sourceIndex || roundMessages.length + 1}`,
          senderId: actor,
          type: event.t === 'msg'
            ? 'text'
            : (event.t === 'gen_image' ? 'image' : (event.t === 'order_share' ? 'orderShare' : (event.t === 'html_widget' ? 'htmlWidget' : event.t))),
          content: event.body || event.text || event.prompt || event.greeting || event.title || '',
          timestamp: Date.now(),
          metadata: event.t === 'redpacket' ? {
            redpacketMode: Number(event.count || 1) > 1 ? 'lucky' : 'normal',
            packetCount: event.count || 1,
            packetState: 'pending',
            totalAmount: event.amount || '',
            greeting: event.greeting || '',
          } : undefined,
        });
      }
    }
  }
  return { valid, rejected };
}

export function resolveHtmlExtensionTemplateName(senderId = '', senderName = '', options = {}) {
  const id = cleanString(senderId);
  const fallback = cleanString(senderName);
  const privateIdentitySurface = isAnonymousChat(options.chat)
    || String(options.chat?.metadata?.channelKind || '') === 'stranger_intercept';
  if (!id || id === 'user' || privateIdentitySurface) return fallback;
  const contextName = resolveCharacterAiContextName(id, options.characters || {});
  return contextName && contextName !== id ? contextName : fallback;
}

export async function materializeMarshmallowChatEvents(events = [], options = {}) {
  const chatId = options.chatId || options.chat?.id || '';
  const previousMessages = Array.isArray(options.messages) ? [...options.messages] : [];
  const createdMessages = [];
  const reactionOps = [];
  const recallOps = [];
  const sideEffects = [];
  const resolveSenderName = typeof options.resolveSenderName === 'function'
    ? options.resolveSenderName
    : async (id) => cleanString(id);
  const nextTimestamp = typeof options.nextTimestamp === 'function'
    ? options.nextTimestamp
    : () => Date.now();
  const baseMetadata = isPlainObject(options.baseMetadata) ? options.baseMetadata : {};
  const allowImageGen = options.allowImageGen === true;
  const stripTrailingPeriod = options.stripTrailingPeriod === true;
  const replyOpts = {
    resolveSenderName,
    currentUserName: cleanString(options.currentUserName || '用户') || '用户',
  };
  const warnings = [];
  const htmlExtensions = (Array.isArray(events) ? events : []).some((event) => event?.t === 'html_widget')
    ? await listHtmlExtensions().catch(() => [])
    : [];

  for (const event of Array.isArray(events) ? events : []) {
    if (event.t === 'narration') {
      const sourceBody = cleanString(event.body || event.text || event.content);
      if (!sourceBody) continue;
      // narration 不属于任何角色的发言语言。模型若受全外语人设影响仍把旁白写成
      // 外语，但同时给了 zh，则直接把中文译文作为旁白正文，不留下翻译按钮。
      const suppliedChineseBody = messageLikelyNeedsTranslation(sourceBody)
        ? sanitizeAiTranslation(sourceBody, event.zh || event.translation)
        : '';
      const body = suppliedChineseBody || sourceBody;
      const draft = createMessage({
        chatId,
        senderId: 'system',
        senderName: '旁白',
        type: 'system',
        content: body,
        metadata: {
          ...baseMetadata,
          narratorBeat: true,
          ...(suppliedChineseBody ? { narrationLanguageRepaired: true } : {}),
          soundCueCategories: normalizeNarrationSoundPlan(event.sound),
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          sourceEventIndex: event.sourceIndex,
        },
      });
      draft.timestamp = nextTimestamp(event);
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      continue;
    }
    if (event.t === 'backstage') {
      // 幕后 line 里的 relay/[图片] 占位要在这里折算：sideEffects 落库时已经拿不到当前对话历史了
      const withImages = resolveBackstageLineImages(event, previousMessages, createdMessages, warnings);
      const normalizedList = normalizeCrossWindowSideEvents([withImages], options);
      if (!normalizedList.length) {
        warnings.push({ code: 'cross_window_placeholder_unresolved_dropped', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const normalized = normalizedList[0];
      if (normalized.t === 'peer_private') {
        if (Array.isArray(normalized.lines) && normalized.lines.length) {
          sideEffects.push(normalized);
        } else {
          warnings.push({ code: 'peer_private_empty_after_coerce_dropped', sourceEventIndex: event.sourceIndex });
        }
        continue;
      }
      if (Array.isArray(normalized.lines) && normalized.lines.length) {
        sideEffects.push(normalized);
      } else {
        warnings.push({ code: 'backstage_empty_after_resolve_dropped', sourceEventIndex: event.sourceIndex });
      }
      continue;
    }
    if (event.t === 'peer_private') {
      // Same as backstage: resolve relay/[图片] against history before side-effect persist.
      const withImages = resolveBackstageLineImages(event, previousMessages, createdMessages, warnings);
      const normalizedList = normalizeCrossWindowSideEvents([withImages], options);
      if (!normalizedList.length) {
        warnings.push({ code: 'cross_window_placeholder_unresolved_dropped', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const normalized = normalizedList[0];
      if (Array.isArray(normalized.lines) && normalized.lines.length) {
        sideEffects.push(normalized);
      } else {
        warnings.push({ code: 'peer_private_empty_after_resolve_dropped', sourceEventIndex: event.sourceIndex });
      }
      continue;
    }
    if (event.t === 'social_post') {
      if (['later', 'queue', 'defer'].includes(cleanString(event.timing).toLowerCase())) {
        sideEffects.push(event);
        continue;
      }
      const targetLabel = socialPostTargetLabel(event.target);
      const actionText = `正在发布${targetLabel}…`;
      const draft = createMessage({
        chatId,
        senderId: 'system',
        senderName: '社交动态',
        type: 'chatAction',
        content: actionText,
        metadata: {
          ...baseMetadata,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          marshmallowEventType: 'social_post',
          chatAction: 'social_post',
          actionKind: targetLabel,
          actionText,
          socialPostStatus: 'pending',
          socialPostTarget: cleanString(event.target).toLowerCase(),
          socialPostBrief: cleanString(event.brief).slice(0, 300),
          sourceEventIndex: event.sourceIndex,
        },
      });
      draft.timestamp = nextTimestamp(event);
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      sideEffects.push({ ...event, placeholderMessageId: msg.id });
      continue;
    }
    if (event.t === 'group_title' || event.t === 'group_name' || event.t === 'group_announcement' || event.t === 'group_todo' || event.t === 'group_transfer' || event.t === 'group_admin' || event.t === 'group_member' || event.t === 'group_remote' || event.t === 'mute' || event.t === 'vote_close' || event.t === 'private_msg' || event.t === 'status' || event.t === 'state' || event.t === 'situation' || event.t === 'schedule_change' || event.t === 'auto_reply' || event.t === 'alias' || event.t === 'avatar' || event.t === 'memory_fact' || event.t === 'redpacket_claim' || event.t === 'transfer_accept' || event.t === 'transfer_return' || event.t === 'memo' || event.t === 'radio_plan' || event.t === 'interaction_plan' || event.t === 'period_offer' || event.t === 'period_confirm' || event.t === 'period_decline' || event.t === 'period_set' || event.t === 'period_end' || event.t === 'invite_user' || event.t === 'stranger_block' || event.t === 'stranger_friend' || event.t === 'stranger_unblock' || event.t === 'stranger_suspect' || event.t === 'open_alias' || event.t === 'social_react' || event.t === 'share_back' || event.t === 'alias_poke' || event.t === 'next_reply_delay' || event.t === 'presence' || event.t === 'hard_offline' || event.t === 'wait_mood') {
      sideEffects.push(event);
      continue;
    }
    if (event.t === 'nudge') {
      const actor = getEventActor(event);
      const target = cleanString(event.target || 'user') || 'user';
      const fromName = await resolveSenderName(actor);
      const targetName = target === 'user'
        ? (cleanString(options.currentUserName || '用户') || '用户')
        : await resolveSenderName(target);
      const content = formatNudgeSystemText(event, { fromName, targetName, userName: options.currentUserName });
      const actionKind = options.chat?.type === 'group' ? '群聊动作' : '聊天动作';
      const draft = createMessage({
        chatId,
        senderId: 'system',
        senderName: actionKind,
        type: 'chatAction',
        content: `[${actionKind}] ${content}`,
        metadata: {
          ...baseMetadata,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          marshmallowEventType: 'nudge',
          chatAction: 'nudge',
          actionKind,
          actionActorId: actor,
          actionActorName: fromName,
          actionTargetId: target,
          actionTargetName: targetName,
          actionText: content,
          nudgeFrom: actor,
          nudgeTarget: target,
          sourceEventIndex: event.sourceIndex,
          ...buildHiddenStateMetadata(event),
        },
      });
      draft.timestamp = nextTimestamp(event);
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      continue;
    }
    if (event.t === 'react') {
      reactionOps.push(event);
      continue;
    }
    if (event.t === 'recall') {
      // Resolve at this sequential position so "round_prev" points to the
      // message emitted just before the recall, not the last one of the round
      // (a follow-up "当我没说" msg after the recall must not become the target).
      const target = resolveTargetRef(event.target, previousMessages, createdMessages);
      const actor = getEventActor(event);
      if (!target || String(target.senderId || '') !== actor || RECALL_BLOCKED_TYPES.has(String(target.type || ''))) {
        warnings.push({ code: 'recall_target_unresolved_dropped', sourceEventIndex: event.sourceIndex });
        continue;
      }
      recallOps.push({ ...event, targetId: target.id });
      continue;
    }
    const senderId = getEventActor(event);
    const ephemeralSender = event.ephemeralNpc === true || isEphemeralNpcActorId(senderId);
    const senderName = ephemeralSender
      ? (stripEphemeralNpcLabel(event.fromLabel) || stripEphemeralNpcLabel(senderId) || '路人')
      : await resolveSenderName(senderId);
    let target = event.reply ? resolveReplyTargetRef(event.reply, previousMessages, createdMessages) : null;

    if (event.t === 'html_widget') {
      const extension = htmlExtensions.find((item) => item.id === event.extensionId
        && item.enabled !== false
        && item.targets?.includes('chat'));
      const templateName = resolveHtmlExtensionTemplateName(senderId, senderName, options);
      const snapshot = extension ? createHtmlExtensionSnapshot(extension, {
        ...event,
        senderName,
        templateName,
      }) : null;
      if (!snapshot) {
        warnings.push({ code: 'html_widget_extension_unavailable_dropped', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'htmlWidget',
        content: snapshot.title,
        metadata: {
          ...baseMetadata,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          marshmallowEventType: 'html_widget',
          htmlExtension: snapshot,
        },
      });
      draft.timestamp = nextTimestamp(event);
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      continue;
    }

    if (event.t === 'chat_bundle') {
      const bundleTitle = cleanString(event.title || '聊天记录') || '聊天记录';
      const fallback = { senderId, senderName };
      let bundleItems = (Array.isArray(event.items) ? event.items : [])
        .map((item) => bundleItemFromSpec(item, previousMessages, createdMessages, fallback))
        .filter(Boolean);
      if (!bundleItems.length && event.relay) {
        const relayItem = bundleItemFromRelay(event.relay, previousMessages, createdMessages);
        if (relayItem) bundleItems = [relayItem];
      }
      if (!bundleItems.length) {
        warnings.push({ code: 'chat_bundle_empty_dropped', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const preview = bundleItems
        .map((item) => bundleItemPreviewText(item))
        .filter(Boolean)
        .join(' / ')
        .slice(0, 48);
      const bundleSummary = `${preview || bundleTitle} · 共${bundleItems.length}条`;

      // Explicit role target → share into that role's private phone chat.
      // Explicit room → share into that backstage room.
      // No target in front private chat → land here so char can forward chat records to the user.
      const explicitPeerTarget = cleanString(event.to || '');
      const explicitRoom = cleanString(event.room || '');
      const isFrontStagePrivateChat = options.chat
        && options.chat.type !== 'group'
        && !isAnonymousChat(options.chat)
        && (options.chat.participants || []).includes('user');
      const sourceHasUser = (options.chat?.participants || []).includes('user');
      if (explicitPeerTarget === 'user' && !sourceHasUser) {
        if (event.shareWithUser !== true) {
          warnings.push({
            code: 'chat_bundle_user_target_requires_explicit_intent',
            sourceEventIndex: event.sourceIndex,
          });
          continue;
        }
        if (ephemeralSender) {
          warnings.push({
            code: 'chat_bundle_user_target_requires_real_sender',
            sourceEventIndex: event.sourceIndex,
          });
          continue;
        }
        const authenticRoleItems = bundleItems.filter((item) => (
          cleanString(item?.senderId) !== 'user'
          && cleanString(item?.relayFromMessageId)
        ));
        if (!authenticRoleItems.length) {
          warnings.push({
            code: 'chat_bundle_user_target_requires_real_role_records',
            sourceEventIndex: event.sourceIndex,
          });
          continue;
        }
        sideEffects.push({
          t: 'chat_bundle',
          from: senderId,
          fromName: senderName,
          to: 'user',
          bundleTitle,
          bundleSummary,
          items: authenticRoleItems,
          sourceEventIndex: event.sourceIndex,
        });
        continue;
      }
      if (explicitPeerTarget && explicitPeerTarget !== 'user' && explicitPeerTarget !== senderId) {
        sideEffects.push({
          t: 'chat_bundle',
          from: senderId,
          fromName: senderName,
          to: explicitPeerTarget,
          bundleTitle,
          bundleSummary,
          items: bundleItems,
          sourceEventIndex: event.sourceIndex,
        });
        continue;
      }
      if (isFrontStagePrivateChat && explicitRoom) {
        sideEffects.push({
          t: 'chat_bundle',
          from: senderId,
          fromName: senderName,
          room: explicitRoom,
          bundleTitle,
          bundleSummary,
          items: bundleItems,
          sourceEventIndex: event.sourceIndex,
        });
        continue;
      }

      const bundleTs = nextTimestamp(event);
      bundleItems = bundleItems.map((item) => (
        Number(item?.timestamp) > 0 ? item : { ...item, timestamp: bundleTs }
      ));
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'chatBundle',
        content: `[合并转发] ${bundleTitle}`,
        metadata: {
          ...baseMetadata,
          bundleTitle,
          bundleSummary,
          items: bundleItems,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          sourceEventIndex: event.sourceIndex,
          relayBundle: true,
          ...buildHiddenStateMetadata(event),
        },
      });
      draft.timestamp = bundleTs;
      if (target) await attachReplyTarget(draft, target, replyOpts);
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      continue;
    }

    if (event.t === 'msg') {
      // 一条协议 msg 即一份回复组织 delivery。后续即使被物化为链接卡、
      // 图片或金融卡，也只能选择一个最终可见载体承接这份元数据。
      const replyCompositionMetadata = buildReplyCompositionMetadata(event);
      let msgBody = stripLeakedVoicePerformanceTags(
        stripDeliveryStatusBracketFromText(cleanString(event.body)),
      );
      const replyBracket = parseReplyBracketFromText(msgBody);
      if (replyBracket) msgBody = replyBracket.content;
      // 有些模型会同时写 reply 字段和正文 [回复……]，且两者偶尔指向不同消息。
      // 可由真实原文反查到的括号目标优先，避免把括号删掉后落成不相干的引用条。
      if (replyBracket) {
        target = resolveConsistentReplyTarget(
          target,
          replyBracket,
          previousMessages,
          createdMessages,
        );
      }
      const financeBracket = parseFinanceBracketFromText(msgBody);
      if (financeBracket?.kind === 'transfer') {
        const draft = createMessage({
          chatId,
          senderId,
          senderName,
          type: 'transfer',
          content: cleanString(financeBracket.note || '转账'),
          metadata: {
            ...baseMetadata,
            amount: financeBracket.amount,
            note: cleanString(financeBracket.note || ''),
            transferNote: cleanString(financeBracket.note || ''),
            transferState: 'pending',
            protocol: MARSHMALLOW_CHAT_PROTOCOL,
            sourceEventIndex: event.sourceIndex,
            financeBracketCoerced: true,
            ...replyCompositionMetadata,
            ...buildHiddenStateMetadata(event),
          },
        });
        draft.timestamp = nextTimestamp(event);
        if (target) await attachReplyTarget(draft, target, replyOpts);
        const msg = normalizeMessageForUi(draft);
        createdMessages.push(msg);
        previousMessages.push(msg);
        warnings.push({ code: 'msg_body_transfer_coerced', sourceEventIndex: event.sourceIndex });
        continue;
      }
      if (financeBracket?.kind === 'redpacket') {
        const draft = createMessage({
          chatId,
          senderId,
          senderName,
          type: 'redpacket',
          content: cleanString(financeBracket.greeting || '恭喜发财'),
          metadata: {
            ...baseMetadata,
            greeting: cleanString(financeBracket.greeting || '恭喜发财'),
            totalAmount: financeBracket.amount,
            redpacketMode: 'normal',
            protocol: MARSHMALLOW_CHAT_PROTOCOL,
            sourceEventIndex: event.sourceIndex,
            financeBracketCoerced: true,
            ...replyCompositionMetadata,
            ...buildHiddenStateMetadata(event),
          },
        });
        draft.timestamp = nextTimestamp(event);
        if (target) await attachReplyTarget(draft, target, replyOpts);
        const msg = normalizeMessageForUi(draft);
        createdMessages.push(msg);
        previousMessages.push(msg);
        warnings.push({ code: 'msg_body_redpacket_coerced', sourceEventIndex: event.sourceIndex });
        continue;
      }
      if (isBareImagePlaceholder(msgBody)) {
        const relayRef = event.relay
          || (target?.type === 'image' ? { id: target.id } : { selector: 'last_user_image' });
        const src = resolveRelayImageSource(relayRef, previousMessages, createdMessages);
        if (src) {
          const draft = createMessage({
            chatId,
            senderId,
            senderName,
            type: 'image',
            content: src.content,
            metadata: {
              ...baseMetadata,
              protocol: MARSHMALLOW_CHAT_PROTOCOL,
              sourceEventIndex: event.sourceIndex,
              relayFromMessageId: src.id,
              bareImagePlaceholderCoerced: true,
              ...replyCompositionMetadata,
              ...buildHiddenStateMetadata(event),
            },
          });
          draft.timestamp = nextTimestamp(event);
          if (target) await attachReplyTarget(draft, target, replyOpts);
          else await attachReplyTarget(draft, src, replyOpts);
          const msg = normalizeMessageForUi(draft);
          createdMessages.push(msg);
          previousMessages.push(msg);
          warnings.push({ code: 'msg_body_image_placeholder_coerced', sourceEventIndex: event.sourceIndex });
          continue;
        }
        warnings.push({ code: 'msg_body_image_placeholder_dropped', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const looseTextImage = parseLooseImageBodyAsTextImage(msgBody);
      if (looseTextImage) {
        if (allowImageGen) {
          const generatedEvent = {
            ...event,
            t: 'gen_image',
            from: senderId,
            prompt: buildPromptFromTextImageFallback({
              text: looseTextImage,
              intent: 'loose-image-description',
            }),
            caption: '',
            use: 'message',
          };
          const draft = createMessage({
            chatId,
            senderId,
            senderName,
            type: 'image',
            content: '',
            metadata: buildGenImagePlaceholderMetadata(
              generatedEvent,
              { ...baseMetadata, ...replyCompositionMetadata },
              { textimgFallbackBlocked: true },
            ),
          });
          draft.timestamp = nextTimestamp(event);
          if (target) await attachReplyTarget(draft, target, replyOpts);
          const msg = normalizeMessageForUi(draft);
          createdMessages.push(msg);
          previousMessages.push(msg);
          sideEffects.push({ ...generatedEvent, placeholderMessageId: msg.id });
          warnings.push({ code: 'msg_body_image_bracket_converted_to_gen_image', sourceEventIndex: event.sourceIndex });
          continue;
        }
        const draft = createMessage({
          chatId,
          senderId,
          senderName,
          type: 'textimg',
          content: looseTextImage,
          metadata: {
            ...baseMetadata,
            caption: looseTextImage,
            protocol: MARSHMALLOW_CHAT_PROTOCOL,
            sourceEventIndex: event.sourceIndex,
            looseImageBodyCoerced: true,
            ...replyCompositionMetadata,
            ...buildHiddenStateMetadata(event),
          },
        });
        draft.timestamp = nextTimestamp(event);
        if (target) await attachReplyTarget(draft, target, replyOpts);
        const msg = normalizeMessageForUi(draft);
        createdMessages.push(msg);
        previousMessages.push(msg);
        warnings.push({ code: 'msg_body_image_bracket_coerced_to_textimg', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const stickerMsg = await resolveStickerMessage(msgBody, chatId, senderId, senderName, {
        userId: options.userId,
      });
      const cleanMsgBody = stickerMsg ? msgBody : stripUnknownStickerPlaceholders(msgBody);
      if (!stickerMsg && !cleanMsgBody) {
        warnings.push({ code: 'unknown_sticker_placeholder_dropped', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const embeddedLink = !stickerMsg ? parseEmbeddedLinkShareText(cleanMsgBody) : null;
      if (embeddedLink?.url) {
        const lead = String(embeddedLink.leadingText || '').trim();
        const shouldSplitText = lead.length >= 2 && !/^链接|^网址|^看看|^给你/i.test(lead.slice(0, 6)) && lead.length <= 120;
        if (shouldSplitText) {
          const textDraft = createMessage({
            chatId,
            senderId,
            senderName,
            type: 'text',
            content: applyTrailingPeriodPref(stripAiSearchRequestTags(lead), stripTrailingPeriod),
            metadata: {
              ...baseMetadata,
              protocol: MARSHMALLOW_CHAT_PROTOCOL,
              sourceEventIndex: event.sourceIndex,
              linkLeadInForUrl: embeddedLink.url,
              ...buildHiddenStateMetadata(event),
            },
          });
          textDraft.timestamp = nextTimestamp(event);
          if (target) await attachReplyTarget(textDraft, target, replyOpts);
          else if (replyBracket) {
            const safePreview = sanitizeReplyPreview(replyBracket.preview, {
              userName: replyOpts.currentUserName,
            });
            const safeSender = sanitizeReplySenderName(
              normalizeUserFacingLabel(replyBracket.senderName, replyOpts.currentUserName),
              { userName: replyOpts.currentUserName },
            );
            textDraft.replyPreview = safePreview;
            textDraft.metadata = {
              ...(textDraft.metadata || {}),
              replyPreview: safePreview,
              ...(safeSender ? { replySenderName: safeSender } : {}),
              replyBracketCoerced: true,
            };
          }
          const textMsg = normalizeMessageForUi(textDraft);
          createdMessages.push(textMsg);
          previousMessages.push(textMsg);
        }
        const linkDraft = createMessage({
          chatId,
          senderId,
          senderName,
          type: 'link',
          content: embeddedLink.url,
          metadata: {
            ...baseMetadata,
            ...buildPendingLinkMetadata(embeddedLink, {
              protocol: MARSHMALLOW_CHAT_PROTOCOL,
              sourceEventIndex: event.sourceIndex,
              coercedFromMsg: true,
              ...(embeddedLink.platform ? {
                platform: embeddedLink.platform,
                platformId: embeddedLink.platform.id,
                platformLabel: embeddedLink.platform.label,
                platformColor: embeddedLink.platform.color,
                platformMono: embeddedLink.platform.mono,
              } : {}),
              ...(event.title ? { title: cleanString(event.title), pendingLinkTitle: cleanString(event.title) } : {}),
              ...(event.desc || event.summary ? { desc: cleanString(event.desc || event.summary), pendingLinkDesc: cleanString(event.desc || event.summary) } : {}),
              ...replyCompositionMetadata,
              ...buildHiddenStateMetadata(event),
            }),
          },
        });
        linkDraft.timestamp = nextTimestamp(event);
        if (!shouldSplitText) {
          if (target) await attachReplyTarget(linkDraft, target, replyOpts);
          else if (replyBracket) {
            const safePreview = sanitizeReplyPreview(replyBracket.preview, {
              userName: replyOpts.currentUserName,
            });
            const safeSender = sanitizeReplySenderName(
              normalizeUserFacingLabel(replyBracket.senderName, replyOpts.currentUserName),
              { userName: replyOpts.currentUserName },
            );
            linkDraft.replyPreview = safePreview;
            linkDraft.metadata = {
              ...(linkDraft.metadata || {}),
              replyPreview: safePreview,
              ...(safeSender ? { replySenderName: safeSender } : {}),
              replyBracketCoerced: true,
            };
          }
        }
        const linkMsg = normalizeMessageForUi(linkDraft);
        createdMessages.push(linkMsg);
        previousMessages.push(linkMsg);
        warnings.push({ code: 'msg_body_link_coerced', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const msgBodyForTranslation = applyTrailingPeriodPref(stripAiSearchRequestTags(cleanMsgBody), stripTrailingPeriod);
      const senderTranslationProfile = options.characters?.[senderId]?.translationProfile || {};
      const msgTranslation = sanitizeAiTranslation(
        msgBodyForTranslation,
        event.zh || event.translation,
        { languageHint: senderTranslationProfile.language || senderTranslationProfile.dialectNote || '' },
      );
      const suppliedSpeechPlan = parseJsonObjectValue(
        event.speech || event.speechPlan || event.speech_plan,
      );
      const speechPlan = !stickerMsg
        ? normalizeVoiceSpeechPlan(suppliedSpeechPlan, msgBodyForTranslation)
        : null;
      const draft = stickerMsg || createMessage({
        chatId,
        senderId,
        senderName,
        type: 'text',
        content: msgBodyForTranslation,
        metadata: {
          ...baseMetadata,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          sourceEventIndex: event.sourceIndex,
          ...replyCompositionMetadata,
          ...(msgTranslation && !stickerMsg ? { translation: msgTranslation } : {}),
          ...(speechPlan ? {
            speechPlan,
            speechActorId: senderId,
            voicePerformanceMode: true,
          } : {}),
          soundCueCategories: normalizeNarrationSoundPlan(event.sound),
          ...buildHiddenStateMetadata(event),
        },
      });
      if (stickerMsg && Object.keys(replyCompositionMetadata).length) {
        draft.metadata = {
          ...(draft.metadata || {}),
          ...replyCompositionMetadata,
        };
      }
      draft.timestamp = nextTimestamp(event);
      if (target) await attachReplyTarget(draft, target, replyOpts);
      else if (replyBracket) {
        const safePreview = sanitizeReplyPreview(replyBracket.preview, {
          userName: replyOpts.currentUserName,
        });
        draft.replyPreview = safePreview;
        const coercedSender = replyBracket.senderName
          ? sanitizeReplySenderName(
            normalizeUserFacingLabel(replyBracket.senderName, replyOpts.currentUserName),
            { userName: replyOpts.currentUserName },
          )
          : '';
        draft.metadata = {
          ...(draft.metadata || {}),
          replyPreview: safePreview,
          ...(coercedSender ? { replySenderName: coercedSender } : {}),
          replyBracketCoerced: true,
        };
      }
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      continue;
    }

    if (event.t === 'sticker') {
      const stickerName = cleanString(event.name || event.sticker || event.stickerName || event.body || 'sticker');
      const stickerText = `[表情包:${stickerName}]${event.inlineText ? ` ${event.inlineText}` : ''}`;
      const stickerMsg = await resolveStickerMessage(stickerText, chatId, senderId, senderName, {
        userId: options.userId,
      });
      if (!stickerMsg) {
        const fallbackText = stripUnknownStickerPlaceholders(event.inlineText || event.text || event.body || '');
        if (fallbackText) {
          const draft = createMessage({
            chatId,
            senderId,
            senderName,
            type: 'text',
            content: stripAiSearchRequestTags(fallbackText),
            metadata: {
              ...baseMetadata,
              protocol: MARSHMALLOW_CHAT_PROTOCOL,
              sourceEventIndex: event.sourceIndex,
              stickerDropped: stickerName,
              ...buildHiddenStateMetadata(event),
            },
          });
          draft.timestamp = nextTimestamp(event);
          if (target) await attachReplyTarget(draft, target, replyOpts);
          const msg = normalizeMessageForUi(draft);
          createdMessages.push(msg);
          previousMessages.push(msg);
        }
        warnings.push({ code: 'unknown_sticker_event_dropped', sourceEventIndex: event.sourceIndex, stickerName });
        continue;
      }
      const rawMessage = stickerMsg || createMessage({
        chatId,
        senderId,
        senderName,
        type: 'sticker',
        content: stickerName,
        metadata: {
          ...baseMetadata,
          stickerName,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          sourceEventIndex: event.sourceIndex,
          ...buildHiddenStateMetadata(event),
        },
      });
      rawMessage.timestamp = nextTimestamp(event);
      if (target) await attachReplyTarget(rawMessage, target, replyOpts);
      const msg = normalizeMessageForUi(rawMessage);
      createdMessages.push(msg);
      previousMessages.push(msg);
      continue;
    }

    if (event.t === 'image') {
      let imageUrl = cleanString(event.url || event.body);
      let relaySource = null;
      if (!isPlayableImageUrl(imageUrl) && event.relay) {
        relaySource = resolveRelayImageSource(event.relay, previousMessages, createdMessages);
        if (relaySource) imageUrl = relaySource.content;
      }
      if (!isPlayableImageUrl(imageUrl)) {
        const text = textImageTextFromImageLikeEvent(event);
        if (!text) {
          warnings.push({ code: 'invalid_image_event_dropped', sourceEventIndex: event.sourceIndex });
          continue;
        }
        if (allowImageGen) {
          const generatedEvent = {
            ...event,
            t: 'gen_image',
            from: senderId,
            prompt: cleanString(event.prompt || buildPromptFromTextImageFallback({
              text,
              intent: event.intent || event.reason || 'image-description',
            })),
            use: 'message',
          };
          const draft = createMessage({
            chatId,
            senderId,
            senderName,
            type: 'image',
            content: '',
            metadata: buildGenImagePlaceholderMetadata(
              generatedEvent,
              baseMetadata,
              { textimgFallbackBlocked: true },
            ),
          });
          draft.timestamp = nextTimestamp(event);
          if (target) await attachReplyTarget(draft, target, replyOpts);
          const msg = normalizeMessageForUi(draft);
          createdMessages.push(msg);
          previousMessages.push(msg);
          sideEffects.push({ ...generatedEvent, placeholderMessageId: msg.id });
          warnings.push({ code: 'image_event_without_url_converted_to_gen_image', sourceEventIndex: event.sourceIndex });
          continue;
        }
        const draft = createMessage({
          chatId,
          senderId,
          senderName,
          type: 'textimg',
          content: text,
          metadata: {
            ...baseMetadata,
            caption: cleanString(event.caption || text),
            protocol: MARSHMALLOW_CHAT_PROTOCOL,
            sourceEventIndex: event.sourceIndex,
            imageEventCoercedToTextimg: true,
            ...buildHiddenStateMetadata(event),
          },
        });
        draft.timestamp = nextTimestamp(event);
        if (target) await attachReplyTarget(draft, target, replyOpts);
        const msg = normalizeMessageForUi(draft);
        createdMessages.push(msg);
        previousMessages.push(msg);
        warnings.push({ code: 'image_event_without_url_coerced_to_textimg', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'image',
        content: imageUrl,
        metadata: {
          ...baseMetadata,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          sourceEventIndex: event.sourceIndex,
          ...(relaySource ? { relayFromMessageId: relaySource.id, relayImage: true } : {}),
          ...(event.caption ? { caption: event.caption, text: event.caption } : {}),
          ...buildHiddenStateMetadata(event),
        },
      });
      draft.timestamp = nextTimestamp(event);
      if (target) await attachReplyTarget(draft, target, replyOpts);
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      continue;
    }

    if (event.t === 'gen_image') {
      if (!allowImageGen) {
        // 生图关闭时绝不能把英文画面 prompt 当成文字卡正文。
        // 只有模型明确给出的可见 caption/text/body 才能降级成文字图，否则安全丢弃。
        const text = textImageTextWithoutPrompt(event);
        if (!text) {
          warnings.push({ code: 'gen_image_disabled_dropped', sourceEventIndex: event.sourceIndex });
          continue;
        }
        const draft = createMessage({
          chatId,
          senderId,
          senderName,
          type: 'textimg',
          content: text,
          metadata: {
            ...baseMetadata,
            caption: cleanString(event.caption || text),
            protocol: MARSHMALLOW_CHAT_PROTOCOL,
            sourceEventIndex: event.sourceIndex,
            genImageDisabledCoercedToTextimg: true,
            ...buildHiddenStateMetadata(event),
          },
        });
        draft.timestamp = nextTimestamp(event);
        if (target) await attachReplyTarget(draft, target, replyOpts);
        const msg = normalizeMessageForUi(draft);
        createdMessages.push(msg);
        previousMessages.push(msg);
        warnings.push({ code: 'gen_image_disabled_coerced_to_textimg', sourceEventIndex: event.sourceIndex });
        continue;
      }
      if (event.use === 'avatar') {
        sideEffects.push(event);
        continue;
      }
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'image',
        content: '',
        metadata: buildGenImagePlaceholderMetadata(event, baseMetadata),
      });
      draft.timestamp = nextTimestamp(event);
      if (target) await attachReplyTarget(draft, target, replyOpts);
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      sideEffects.push({ ...event, placeholderMessageId: msg.id });
      continue;
    }

    if (event.t === 'voice_call') {
      const callMode = String(event.callMode || '').trim().toLowerCase() === 'video' ? 'video' : 'voice';
      const note = cleanString(event.note || event.reason || event.text || event.body).slice(0, 80);
      const title = callMode === 'video' ? '视频通话' : '语音通话';
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'voiceCall',
        content: note || title,
        metadata: {
          ...baseMetadata,
          title,
          note,
          callMode,
          callState: 'incoming',
          state: 'incoming',
          aiInitiated: true,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
        },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'voice') {
      const voiceText = sanitizeVoiceTranscriptText(
        cleanString(event.text || event.body),
        event,
      );
      const senderTranslationProfile = options.characters?.[senderId]?.translationProfile || {};
      const voiceTranslation = sanitizeAiTranslation(
        voiceText,
        sanitizeVoiceTranscriptText(event.zh || event.translation, event),
        { languageHint: senderTranslationProfile.language || senderTranslationProfile.dialectNote || '' },
      );
      const speechPlan = normalizeVoiceSpeechPlan({
        text: voiceText,
        emotion: event.emotion,
        pace: event.pace,
        intensity: event.intensity,
        direction: event.direction,
      }, voiceText);
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'voice',
        content: '[语音消息]',
        metadata: {
          ...baseMetadata,
          text: voiceText,
          duration: resolveVoiceEventDuration(event, voiceText),
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          ...(voiceTranslation ? { translation: voiceTranslation } : {}),
          ...(speechPlan ? {
            speechPlan,
            speechActorId: senderId,
            voiceWorldBook: options.voiceWorldBookActive === true,
          } : {}),
        },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'dice') {
      const sides = Math.max(2, Math.min(100, Number(event.sides) || 6));
      const result = Math.max(1, Math.min(sides, Number(event.result) || (1 + Math.floor(Math.random() * sides))));
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'dice',
        content: `d${sides}=${result}`,
        metadata: { ...baseMetadata, sides, result, protocol: MARSHMALLOW_CHAT_PROTOCOL },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'redpacket') {
      const isGroup = options.chat?.type === 'group';
      const rpMeta = buildAiRedPacketMetadata(event, { isGroup });
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'redpacket',
        content: cleanString(event.greeting || event.body || '恭喜发财'),
        metadata: {
          ...baseMetadata,
          ...rpMeta,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
        },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'transfer') {
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'transfer',
        content: cleanString(event.note || event.body || '转账'),
        metadata: {
          ...baseMetadata,
          amount: cleanString(event.amount || '0.01'),
          note: cleanString(event.note || event.body || ''),
          transferState: 'pending',
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
        },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'order_share') {
      const title = cleanString(event.title || event.product || '礼物').slice(0, 80) || '礼物';
      const price = normalizeOrderSharePrice(event.price || event.amount || '');
      const note = cleanString(event.note || '').slice(0, 160);
      const giftForName = cleanString(options.currentUserName || '用户') || '用户';
      const metadata = {
        ...baseMetadata,
        productTitle: title,
        orderTitle: title,
        orderPrice: price,
        price,
        orderNote: note,
        note,
        platform: '礼物',
        orderPlatform: '礼物',
        giftForName,
        giftForUserId: 'user',
        giftDirection: 'char_to_user',
        protocol: MARSHMALLOW_CHAT_PROTOCOL,
      };
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'orderShare',
        content: buildOrderShareMessageContent(metadata),
        metadata,
      });
      draft.timestamp = nextTimestamp(event);
      if (target) await attachReplyTarget(draft, target, replyOpts);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'textimg') {
      if (allowImageGen) {
        const draft = createMessage({
          chatId,
          senderId,
          senderName,
          type: 'image',
          content: '',
          metadata: buildGenImagePlaceholderMetadata(event, baseMetadata, { textimgFallbackBlocked: true }),
        });
        draft.timestamp = nextTimestamp(event);
        if (target) await attachReplyTarget(draft, target, replyOpts);
        const msg = normalizeMessageForUi(draft);
        createdMessages.push(msg);
        previousMessages.push(msg);
        sideEffects.push({
          t: 'gen_image',
          from: senderId,
          prompt: cleanString(event.prompt || buildPromptFromTextImageFallback(event)),
          caption: cleanString(event.caption || ''),
          use: 'message',
          reason: cleanString(event.intent || event.reason || 'textimg-fallback-blocked'),
          placeholderMessageId: msg.id,
        });
        warnings.push({ code: 'textimg_fallback_converted_to_gen_image', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'textimg',
        content: cleanString(event.body || event.text || ''),
        metadata: {
          ...baseMetadata,
          caption: cleanString(event.caption || event.body || event.text || ''),
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          ...buildHiddenStateMetadata(event),
        },
      });
      draft.timestamp = nextTimestamp(event);
      if (target) await attachReplyTarget(draft, target, replyOpts);
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      continue;
    }

    if (event.t === 'link') {
      let linkUrl = cleanString(event.url || event.body || '');
      let relaySource = null;
      if (!isRelayableLinkUrl(linkUrl) && event.relay) {
        relaySource = resolveRelayLinkSource(event.relay, previousMessages, createdMessages);
        if (relaySource) linkUrl = String(relaySource.content || relaySource.metadata?.url || '').trim();
      }
      if (!isRelayableLinkUrl(linkUrl)) {
        warnings.push({ code: 'invalid_link_event_dropped', sourceEventIndex: event.sourceIndex });
        continue;
      }
      const platform = detectLinkPlatform(linkUrl);
      const relayMd = relaySource?.metadata && typeof relaySource.metadata === 'object' ? relaySource.metadata : {};
      // AI 偶尔会把 title/desc 写成原始 markdown 链接语法（[文字](url)），这里剥离后再落库，
      // 清洗后为空时兜底用链接的域名，避免卡片上直出一串源码。
      let linkHostnameFallback = '';
      try { linkHostnameFallback = new URL(linkUrl).hostname; } catch { linkHostnameFallback = ''; }
      const cleanedLinkTitle = stripMarkdownLinkSyntax(cleanString(event.title || relayMd.title || '')) || linkHostnameFallback;
      const cleanedLinkDesc = stripMarkdownLinkSyntax(cleanString(event.desc || event.summary || relayMd.desc || relayMd.descFull || ''));
      const linkShare = parseEmbeddedLinkShareText(linkUrl) || {
        url: linkUrl,
        title: cleanedLinkTitle,
        desc: cleanedLinkDesc,
        rawText: linkUrl,
        platform: relayMd.platform || platform,
        keywords: relayMd.keywords || [],
      };
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'link',
        content: linkUrl,
        metadata: {
          ...baseMetadata,
          ...buildPendingLinkMetadata(linkShare, {
            title: cleanedLinkTitle || linkShare.title || relayMd.title || '',
            desc: cleanedLinkDesc || linkShare.desc || relayMd.desc || relayMd.descFull || '',
            pendingLinkTitle: cleanedLinkTitle || linkShare.title || relayMd.title || '',
            pendingLinkDesc: cleanedLinkDesc || linkShare.desc || relayMd.descFull || relayMd.desc || '',
            coverUrl: relayMd.coverUrl || relayMd.imageUrl || '',
            imageUrl: relayMd.imageUrl || relayMd.coverUrl || '',
            images: Array.isArray(relayMd.images) ? relayMd.images : [],
            protocol: MARSHMALLOW_CHAT_PROTOCOL,
            ...(relaySource ? { relayFromMessageId: relaySource.id, relayLink: true } : {}),
            ...(platform || relayMd.platform ? {
              platform: relayMd.platform || platform,
              platformId: (relayMd.platform || platform)?.id,
              platformLabel: (relayMd.platform || platform)?.label,
              platformColor: (relayMd.platform || platform)?.color,
              platformMono: (relayMd.platform || platform)?.mono,
            } : {}),
          }),
        },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'npc_card') {
      const npcName = cleanString(event.npcName || event.name);
      if (!npcName) continue;
      const npcBio = cleanString(event.npcBio || event.bio);
      const relation = cleanString(event.relation);
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'npcCard',
        content: npcName,
        metadata: {
          ...baseMetadata,
          npcName,
          npcBio,
          relation,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
        },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'anonymous_reveal') {
      const npcName = cleanString(event.name || event.realName);
      if (!npcName) continue;
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'npcCard',
        content: npcName,
        metadata: {
          ...baseMetadata,
          npcName,
          npcBio: cleanString(event.bio || event.background || event.reason),
          relation: '匿名相认',
          anonymousRevealActorId: senderId,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
        },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'location') {
      // 模型常按目录示例写 name/place 字段，落库时不能只认 label，否则会落成「位置」弱卡片。
      const locationLabel = cleanString(event.name || event.place || event.label || event.body || '位置');
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'location',
        content: locationLabel,
        metadata: {
          ...baseMetadata,
          label: locationLabel,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
        },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }

    if (event.t === 'offline_invite') {
      const arrived = event.arrived === true;
      const accepted = arrived || event.accepted === true;
      const toUserPlace = event.toUserPlace === true;
      const place = cleanString(event.place);
      const rawNote = cleanString(event.note || event.activity || (arrived ? '我到了' : '想约你线下见一面'));
      const note = arrived ? sanitizeOfflineArrivalNote(rawNote, '我到了') : rawNote;
      const route = await buildOfflineInviteRouteForEvent({ senderId, place, toUserPlace }).catch(() => null);
      const isGroupInvite = options.chat?.type === 'group';
      const characters = options.characters || {};
      const participantIds = (options.chat?.participants || []).filter((id) => id && id !== 'user');
      const rawInvitees = Array.isArray(event.invitees) ? event.invitees : [];
      let inviteeIds = rawInvitees
        .map((id) => cleanString(id))
        .filter((id) => id && id !== 'user' && id !== senderId && participantIds.includes(id));
      if (!inviteeIds.length && isGroupInvite) {
        inviteeIds = participantIds.filter((id) => id !== senderId).slice(0, 4);
      }
      const inviteeNames = inviteeIds.map((id) => resolveCharacterAiContextName(id, characters));
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'offlineInvite',
        content: note,
        metadata: {
          ...baseMetadata,
          offlineInvite: true,
          inviteFrom: 'character',
          isGroupInvite,
          initiatorId: senderId,
          initiatorName: senderName,
          inviteeIds,
          inviteeNames,
          place,
          activity: cleanString(event.activity),
          note,
          kind: cleanString(event.kind) === 'trip' ? 'trip' : '',
          timeLabel: cleanString(event.timeLabel),
          tone: cleanString(event.tone),
          // 双方已经说定或已经到场时直接给可进入卡，跳过重复接受流程。
          status: accepted ? 'accepted' : 'pending',
          arrived,
          transitionPhase: cleanString(event.transitionPhase),
          synthesizedOfflineTransition: event.synthesizedOfflineTransition === true,
          sourceInviteMessageId: cleanString(event.sourceInviteMessageId),
          toUserPlace,
          route,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
          sourceEventIndex: event.sourceIndex,
        },
      });
      draft.timestamp = nextTimestamp(event);
      if (target) await attachReplyTarget(draft, target, replyOpts);
      const msg = normalizeMessageForUi(draft);
      createdMessages.push(msg);
      previousMessages.push(msg);
      // 「已到场」是自动接受、没有再给用户确认的机会，此刻就该顶掉角色当天日程里这个时间段的安排。
      if (arrived && options.chat?.userId) {
        applyOfflineInviteScheduleFromMessage({
          userId: options.chat.userId,
          characterId: senderId,
          message: msg,
          nowTs: draft.timestamp,
        }).catch(() => {});
      }
      continue;
    }

    if (event.t === 'vote') {
      const title = cleanString(event.question || event.title || event.body || '投票');
      const opts = Array.isArray(event.options)
        ? event.options.map((o) => cleanString(o)).filter(Boolean)
        : cleanString(event.options || event.opts || '').split(/[/|、,，]/).map((o) => o.trim()).filter(Boolean);
      const draft = createMessage({
        chatId,
        senderId,
        senderName,
        type: 'vote',
        content: title,
        metadata: {
          ...baseMetadata,
          voteTitle: title,
          voteOptions: opts.length ? opts : ['选项A', '选项B'],
          voteCounts: {},
          voteClosed: false,
          protocol: MARSHMALLOW_CHAT_PROTOCOL,
        },
      });
      draft.timestamp = nextTimestamp(event);
      createdMessages.push(normalizeMessageForUi(draft));
      continue;
    }
  }

  const messages = createdMessages.map((message) => {
    let normalized = message;
    const senderId = String(message?.senderId || '').trim();
    // 语音演绎开启时，弱模型偶发整条漏掉 speech。统一在物化出口用可见正文
    // 生成中性表演轨，连 msg 被拆成“引导文字 + 链接”等少见分支也不会漏；
    // 这是本地确定性兜底，不增加第二次 AI 请求。
    if (options.voicePerformanceModeEnabled === true
      && String(message?.type || 'text') === 'text'
      && senderId
      && !['user', 'system', 'guidance'].includes(senderId)
      && !message?.metadata?.speechPlan
      && message?.metadata?.plotExplain !== true) {
      const speechPlan = normalizeVoiceSpeechPlan(
        { text: message.content, emotion: 'neutral', pace: 'normal', intensity: 0 },
        message.content,
      );
      if (speechPlan) {
        normalized = {
          ...message,
          metadata: {
            ...(message.metadata || {}),
            speechPlan,
            speechActorId: senderId,
            voicePerformanceMode: true,
          },
        };
      }
    }
    return isEphemeralNpcActorId(normalized?.senderId)
      ? {
        ...normalized,
        metadata: { ...(normalized.metadata || {}), ephemeralNpc: true },
      }
      : normalized;
  });
  return { messages, reactionOps, recallOps, sideEffects, warnings };
}

const RULE_EVENT_ALIASES = Object.freeze({
  orderShare: 'order_share',
  voiceCall: 'voice_call',
  offlineInvite: 'offline_invite',
  npcCard: 'npc_card',
  textImage: 'textimg',
  privateMessage: 'private_msg',
});

function recentRuleSignal(options = {}) {
  const messages = Array.isArray(options.recentMessages) ? options.recentMessages : [];
  const recentText = messages.slice(-10).map((message) => [
    message?.content,
    message?.metadata?.title,
    message?.metadata?.note,
    message?.metadata?.greeting,
  ].filter(Boolean).join(' ')).join('\n');
  const extraText = cleanString(options.recentText || '');
  const eventTypes = new Set();
  messages.slice(-12).forEach((message) => {
    const raw = cleanString(
      message?.metadata?.marshmallowEventType
      || message?.metadata?.eventType
      || message?.type
      || '',
    );
    if (!raw) return;
    eventTypes.add(RULE_EVENT_ALIASES[raw] || raw.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));
  });
  return { text: `${recentText}\n${extraText}`, eventTypes };
}

function moduleEnabled(id, options = {}) {
  const isGroup = options.isGroup === true;
  const anonymous = isAnonymousChat(options.chat);
  const metadata = options.chat?.metadata || {};
  if (id === 'finance') return options.parallelWorldMode !== true;
  // 私聊换头像：匿名房的头像语义归 anonymous 模块管，群聊不改角色本体头像。
  if (id === 'avatar') return !isGroup && !anonymous;
  if (id === 'sticker') return options.hasStickers === true;
  if (id === 'offline_invite') {
    return options.allowOfflineInvite === true || options.allowOfflineArrivalCard === true;
  }
  if (id === 'group') return isGroup;
  if (id === 'anonymous') return anonymous;
  if (id === 'stranger') {
    // 已拉黑也要启用：角色需要 stranger_unblock 才能解除拉黑
    return !isGroup && metadata.channelKind === 'stranger_intercept';
  }
  if (id === 'npc_card') return !anonymous;
  if (id === 'intent_actions') {
    return options.isGroup !== true
      && ((Array.isArray(options.supportedSocialPostTargets) && options.supportedSocialPostTargets.length > 0)
        || options.allowOpenAliasIntent === true);
  }
  if (id === 'interaction_plan') {
    return !isGroup
      && !anonymous
      && metadata.channelKind !== 'stranger_intercept'
      && options.interactionProactiveEnabled === true;
  }
  if (id === 'auto_reply') {
    return options.isGroup !== true
      && options.realPersonModeEnabled === true
      && options.systemAutoReplyEnabled === true;
  }
  if (id === 'real_person') {
    return options.isGroup !== true && options.realPersonModeEnabled === true;
  }
  return true;
}

function moduleStateRelevant(id, options = {}) {
  if (id === 'finance') {
    return options.financeActionDetail === true
      || options.redpacketClaimNudge === true
      || options.transferAcceptNudge === true
      || options.giftAcknowledgeNudge === true;
  }
  // 视觉分享是聊天常驻能力：开生图时落 gen_image，未开时落 textimg。
  // 不能把未开生图误当成整个模块不可用，否则模型只会把“拍照”写进状态，
  // 却想不起还要发送一个真正可见的文字图事件。
  if (id === 'gen_image') return true;
  if (id === 'voice') return options.aiVoiceCallNudge === true || options.voiceBubblePreferMore === true;
  // 新邀约与到场补卡分别受控；已有 pending/shelved 邀约时仍需保留 arrived:true 规则。
  if (id === 'offline_invite') {
    return options.allowOfflineInvite === true || options.allowOfflineArrivalCard === true;
  }
  if (id === 'sticker') return options.hasStickers === true;
  if (id === 'memo_schedule') return options.memoRuleRelevant === true;
  if (id === 'period') return options.periodRuleRelevant === true;
  if (id === 'peer_private') {
    if (options.allowCrossWindowLinkage === false) return false;
    return options.chat?.groupSettings?.allowSocialLinkage === true
      || options.chat?.groupSettings?.allowPrivateSend === true;
  }
  if (id === 'group') return options.isGroup === true;
  if (id === 'anonymous') return isAnonymousChat(options.chat);
  if (id === 'stranger') return moduleEnabled(id, options);
  if (id === 'intent_actions') {
    return options.socialPostIntentNudge === true || options.openAliasIntentNudge === true;
  }
  if (id === 'interaction_plan') return moduleEnabled(id, options);
  if (id === 'real_person') return options.realPersonModeEnabled === true;
  return false;
}

function actorId(options = {}) {
  const partnerId = cleanString(options.partnerId || '');
  const actorReference = resolveChatActorReference(options.chat, partnerId, {
    actorIds: partnerId ? [partnerId] : [],
  });
  if (actorReference) return actorReference;
  return options.isGroup === true ? 'C1' : cleanString(partnerId || 'C1');
}

function imageCatalogLine(options = {}) {
  const actor = actorId(options);
  return options.allowImageGen === true
    ? `图像分流｜当前已允许生图：新画面、自拍、照片、便签、清单和文字梗图都用 gen_image {"t":"gen_image","from":"${actor}","prompt":"English prompt","people":"none","subjects":[],"use":"message"}；禁止输出 textimg。image 只转发已有真实图；sticker 只是表情包。`
    : `文字图分流｜当前未开启真实生图：想主动分享新画面、自拍、照片感记录、截图、便签、清单或文字梗图时，用 textimg {"t":"textimg","from":"${actor}","text":"用户实际看见的文字图正文"}；image 只转发已经存在的真实图。拍照只写进 state.status 不算发送，答应给图就必须同轮输出 textimg。`;
}

function imageFullText(options = {}) {
  const actor = actorId(options);
  if (options.allowImageGen !== true) {
    return [
      '【文字图完整规则｜当前未开启真实生图】禁止输出 gen_image，也不要写英文画面 prompt；本会话仍然可以主动制作并发送 textimg，不能因为未开生图就把视觉分享能力一起关闭。',
      `文字图用 {"t":"textimg","from":"${actor}","text":"用户实际看见的文字图正文"}。text 必须使用聊天语言与角色口吻，是卡片上真正展示的内容，不是英文 prompt；便签、清单、小作文直接写正文，照片感记录则用短标题加 2～4 行具体可见内容写出人物、物件、场景和当下细节。`,
      '自拍、食物、房间、街景、正在看的页面、生活随手拍和纯文字卡都属于同一类日常视觉分享：人物此刻确实想拍给对方看、分享欲自然出现，或用户明确索图而角色愿意时，本轮必须输出 textimg；不必等用户说“生成文字图”。',
      'state.status 里的“正在拍照/举起手机/拍了一张”只记录角色正在做什么，绝不代表图片已经发送；msg 里说“拍好了/发你了/给你看”也不算发送。愿意给图就同轮落 textimg，不愿意则按人设明确拒绝，不能只做状态动作或口头假装已经发出。',
      '转发真实图片用 image+relay:last_user_image 或 last_image；没有真实图片来源时不得用 image 假装发图。',
    ].join('\n');
  }
  const mode = cleanString(options.imageGenMode || 'realistic');
  const style = cleanString(options.imageStyleLabel || '');
  const common = [
    '【图像完整规则】禁止在 msg.body 写 [图片]/[照片] 占位；真实图片用 image+url，转发最近用户图用 relay:last_user_image，任意最近图用 last_image。',
    '【媒体类型互斥】当前会话已允许生图，凡是要新做一张图片——包括自拍、人物照、食物、物件、房间、街景、截图式画面、便签、清单、公告和文字梗图——全部使用 gen_image，禁止输出 textimg。sticker 只是已有表情包，不能代替生成图片，也不能配合台词假装已经生成、拍摄或发送。',
    '用户明确索要生成画面、自拍或新照片时：可以按人设拒绝；若答应发送，本轮就用 gen_image 真正生成，不要改发 sticker、textimg 或只有台词。',
    'gen_image 的 people 必填：完全无人=none（prompt 同时写 no people）；手/背影/剪影/路人=partial；可辨认主体/自拍=portrait。partial 永远不得出现可辨认正脸，即使 identity:"self" 或角色开启锁脸，也只能通过发型、衣着、体型、配饰等非脸部线索保持人物一致。画面中的人物是发送者本人时加 identity:"self"（包括本人的手、背影或身体局部）；路人或他人写 identity:"other"。shape 按内容选 portrait|landscape|square。',
    'gen_image 的 subjects 只列画面中需要保持本人长相的主体 ID，最多 4 个：用户固定写 "user"，角色写真实角色 id。单人自拍写 subjects:["发送者id"]；user+角色合照或多角色合照必须逐一列全，且 prompt 明确每个人的位置、外观和动作，禁止把两人的五官融合或互换。',
    '自拍/第一人称拍照时 prompt 不写 holding phone/phone in hand；仅对镜自拍可写 mirror selfie。use:"avatar" 才更新头像。',
    '生图不只有照片：正在看的帖子/商品页/歌单截图、拍糊的生活随手照，以及正文文字本身就是内容的便签、清单、小作文卡片，都直接生成图片。分享欲来了随手发一张、配半句 caption 就够，不用等对方要。',
  ];
  if (mode === 'novelai') {
    common.push(`NovelAI：人物图 prompt 用英文 Danbooru 标签，按主体→外貌→表情→动作→服饰→场景→光线排列并加镜头 tag。例 {"t":"gen_image","from":"${actor}","prompt":"1girl, silver hair, oversized hoodie, selfie, upper body, close-up, bedroom, night, soft lighting","people":"portrait","identity":"self","shape":"portrait","caption":"刚拍的","use":"message"}`);
  } else if (mode === 'smart') {
    common.push('智能分流：人物/自拍用英文 Danbooru 标签；食物、物件、街景等无人生活图用英文自然语言、写实质感并写 no people；不要用 textimg 顶替。');
  } else {
    common.push(`${options.allowRealPersonPhoto === true ? '人物照/自拍可露脸，' : '只生成无可识别正脸的生活证据图，'}prompt 用英文自然语言写构图、动作/物件、场景与光线；${style ? `系统自动套用「${style}」画风，` : ''}不要重复画风词。`);
  }
  return common.join('\n');
}

const GENERATED_IMAGE_COMMITMENT_RE = /(?:都|已经|刚刚|刚|这就|马上|现在)?(?:给你)?(?:拍|照|生成|画|做)(?:好|完|下来|给你|给你看)?(?:了|好啦|完了|过去)|(?:照片|图片|图).{0,8}(?:发给你|发你|给你发|传给你)(?:了|过去)|(?:这就|马上|现在)(?:给你)?(?:拍|发|生成|画)/u;

function trailingUserRequestText(messages = []) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted && !message.recalled && String(message.senderId || '') !== 'system');
  const parts = [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (String(message.senderId || '') !== 'user') break;
    const text = cleanString(message.content || message.body || message.text);
    if (text) parts.unshift(text);
  }
  return parts.join('\n').slice(-800);
}

/** 返回本轮末尾用户连续消息中的明确索图文本；拒绝、取消或普通“看看”不触发。 */
export function detectExplicitGeneratedImageRequest(messages = []) {
  const text = trailingUserRequestText(messages);
  if (!text) return '';
  if (/(?:不要|别|不用|不必|不许|禁止|取消).{0,10}(?:拍|发|传|生成|画|做).{0,8}(?:图|图片|照片|自拍|几张|一张)?/u.test(text)) return '';
  const explicit = /(?:给我|帮我|让我|想|要|快).{0,12}(?:拍|发|传|生成|画|做|看看).{0,12}(?:图|图片|照片|自拍|几张|一张|房间|住处|住的地方|生活的地方)?|(?:拍|发|传|生成|画|做).{0,12}(?:图|图片|照片|自拍|几张|一张|给我|看看)|(?:照片|图片|自拍).{0,10}(?:拍|发|传|生成|看看|来一张)/u.test(text);
  return explicit ? text : '';
}

function generatedImageRepairSpec(requestText = '', claimText = '') {
  const context = `${requestText}\n${claimText}`;
  if (/(?:自拍|你的照片|你本人|拍你自己|看看你(?:现在的样子|本人|长什么样|穿什么))/u.test(context)) {
    return {
      prompt: 'candid selfie portrait of the sender in their current surroundings, natural expression, everyday clothing, realistic lighting',
      people: 'portrait',
      identity: 'self',
      includeActor: true,
    };
  }
  if (/(?:手部|手腕|手臂|背影|剪影|不露脸|局部)/u.test(context)) {
    return {
      prompt: 'candid realistic photo showing the requested partial view of the sender, no identifiable face, natural everyday lighting',
      people: 'partial',
      identity: 'self',
      includeActor: false,
    };
  }
  if (/(?:房间|屋里|屋子|宿舍|住处|家里|生活的地方|住的地方|室内|陈设|情报所)/u.test(context)) {
    return {
      prompt: "candid documentary photo of the sender's lived-in room, showing the actual interior, furniture, personal belongings and everyday atmosphere, natural realistic lighting, no people",
      people: 'none',
      identity: 'other',
      includeActor: false,
    };
  }
  if (/(?:饭|菜|早餐|午餐|晚餐|夜宵|食物|吃的|饮料|奶茶|咖啡)/u.test(context)) {
    return {
      prompt: 'candid realistic close-up photo of the food or drink the sender is currently talking about, natural everyday lighting, no people',
      people: 'none',
      identity: 'other',
      includeActor: false,
    };
  }
  return {
    prompt: 'candid realistic everyday photo showing the subject the user explicitly asked the sender to photograph, clear visual details, natural lighting',
    people: 'none',
    identity: 'other',
    includeActor: false,
  };
}

/**
 * 模型已经用台词承诺“拍好/发出了”，却漏掉 gen_image 时，补一张保守的真实生图事件。
 * 只有生图已开、末尾用户明确索图且角色已经承诺执行时触发，不替角色越过拒绝意愿。
 */
export function repairUnfulfilledGeneratedImageClaim(events = [], options = {}) {
  const list = Array.isArray(events) ? events : [];
  if (options.allowImageGen !== true || list.some((event) => ['gen_image', 'image', 'textimg'].includes(String(event?.t || '')))) {
    return { events: list, repaired: false, event: null, requestText: '' };
  }
  const requestText = detectExplicitGeneratedImageRequest(options.recentMessages);
  if (!requestText) return { events: list, repaired: false, event: null, requestText: '' };
  const claimEvent = [...list].reverse().find((event) => (
    event?.t === 'msg' && GENERATED_IMAGE_COMMITMENT_RE.test(cleanString(event.body || event.text || event.content))
  ));
  const actor = cleanString(claimEvent?.from || claimEvent?.actor || claimEvent?.senderId);
  if (!claimEvent || !actor) return { events: list, repaired: false, event: null, requestText };
  const claimText = cleanString(claimEvent.body || claimEvent.text || claimEvent.content);
  const spec = generatedImageRepairSpec(requestText, claimText);
  const sourceIndex = list.reduce((max, event) => Math.max(max, Number(event?.sourceIndex || -1)), -1) + 1;
  const event = {
    t: 'gen_image',
    from: actor,
    prompt: spec.prompt,
    people: spec.people,
    identity: spec.identity,
    subjects: spec.includeActor ? [actor] : [],
    shape: 'portrait',
    use: 'message',
    sourceIndex,
    repairedFromClaim: true,
  };
  return { events: [...list, event], repaired: true, event, requestText };
}

function financeFullText(options = {}) {
  const actor = actorId(options);
  return [
    '【金融完整规则】金额是纯数字字符串，不带货币符号/逗号；卡片动作必须用事件，禁止在 msg 里写 [转账]/[红包]/[购物] 假卡。',
    `发起：{"t":"transfer","from":"${actor}","amount":"88.00","note":"备注"}；{"t":"redpacket","from":"${actor}","amount":"18.88","count":3,"greeting":"恭喜发财"}；{"t":"order_share","from":"${actor}","to":"user","title":"具体商品","price":"99.00"}。红包示例金额只演示字段，每次必须按发送者人设、场合和人数重新决定合理总额，禁止把 8.88 或任一示例当固定默认值反复使用。`,
    'order_share 表示角色真的替用户买东西、点外卖或送礼物：用户说饿了、没吃饭、想喝/想吃什么，或角色此刻确实想照顾、哄人、庆祝、补偿时，可以顺势直接下单并发购物卡，不必等用户明确说“发卡片”。一旦在 msg 里说“给你点了/给你买/我来下单”，同轮就必须输出 order_share；只聊角色自己点的外卖、推荐店铺或问用户想吃什么时不要误发。',
    options.financeActionDetail === true
      ? `处理：{"t":"transfer_accept","from":"${actor}","target":"last_transfer"} 或 {"t":"transfer_return","from":"${actor}","target":"last_transfer"}；{"t":"redpacket_claim","from":"${actor}","target":"last_redpacket"}。target 也可用上文真实消息 id；只说“收了/退了/领了”不会改变卡片。redpacket_claim 不填 amount，实际抢到金额由本地红包份额决定并自动生成系统提示；在系统提示出现前，msg 禁止自行编造“抢到 480 / 两千多”等金额。`
      : '',
    options.redpacketClaimNudge === true ? `【本轮领红包】${cleanString(options.redpacketClaimHint || '有待领红包')}；让未领取角色输出 redpacket_claim。` : '',
    options.transferAcceptNudge === true ? `【本轮确认收款】${cleanString(options.transferAcceptHint || '有待确认转账')}；愿收就 transfer_accept，拒收就 transfer_return。` : '',
    options.giftAcknowledgeNudge === true ? `【本轮购物礼物】${cleanString(options.giftAcknowledgeHint || '用户刚送出礼物')}；用 msg 点名礼物并真实回应。` : '',
  ].filter(Boolean).join('\n');
}

function voiceFullText(options = {}) {
  const actor = actorId(options);
  const voiceProvider = options.voiceProvider === 'fish' ? 'fish' : 'minimax';
  const translated = (options.translationCharacters || []).length || (options.voiceForceTranslationCharacters || []).length;
  return [
    `【语音完整规则】voice：${translated
      ? `{"t":"voice","from":"${actor}","text":"外语原文","zh":"简体中文","seconds":4,"emotion":"neutral","pace":"normal","intensity":0${voiceProvider === 'fish' ? ',"direction":"简短英文表演指导"' : ''}}`
      : `{"t":"voice","from":"${actor}","text":"说出口的话","seconds":4,"emotion":"neutral","pace":"normal","intensity":0${voiceProvider === 'fish' ? ',"direction":"简短英文表演指导"' : ''}}`}。emotion 使用 neutral|happy|sad|angry|fearful|surprised|disgusted，pace 使用 slow|normal|fast，intensity 使用 0～1；日常默认 0～0.35，只有明确强烈爆发才接近 1。text 只写台词，不写舞台动作，也绝不附带“4秒 / 0:04 / seconds:4”之类的时长；seconds 只能作为独立数字字段。${voiceProvider === 'fish' ? 'Fish 用 direction 描述自然呼吸、力度与断句，局部声音提示只在真实位置少量使用' : '通常正常标点，确有需要最多一组 MiniMax 换气/笑声标签'}，zh 不得带标签。`,
    options.voiceWorldBookActive === true
      ? buildVoiceWorldBookPrompt(VOICE_WORLD_BOOK_SURFACES.VOICE_BUBBLE, {
        customText: options.voiceWorldBookText,
        provider: voiceProvider,
      })
      : '',
    '语音也可以像真人一样连发：几条短语音一句一条（各自 seconds 短一点），比一条长语音塞满更自然；懒得打字、情绪上来、走路骑车时都可以整轮只用语音。是否爱发语音、发多密完全以人设为准——不爱发语音的角色不要硬用。',
    options.voiceBubblePreferMore === true
      ? '【用户偏好】用户在本会话打开了「更爱发语音」：把语音条当成这位角色的常用回复形态之一，情绪上来、话密、懒得打字时优先考虑语音（可整轮只发语音）；仍按人设自然表达，不为凑数硬发。'
      : '',
    options.allowAiVoiceCall === true
      ? `voice_call：{"t":"voice_call","from":"${actor}","callMode":"voice","note":"来电事由"}。用户请求打电话或当下确实想立刻听声音时直接发起；同一时间仅一通，发起后不编造通话内容，拒接/挂断后不要立刻重拨。`
      : '当前未开放主动来电：不得用 [通话中]/[来电] 等文字冒充真实电话。',
    options.aiVoiceCallNudge === true ? '【本轮通话机会】此刻适合直接输出 voice_call，不必先问要不要打。' : '',
  ].filter(Boolean).join('\n');
}

function offlineFullText(options = {}) {
  const actor = actorId(options);
  const allowNewInvite = options.allowOfflineInvite === true;
  return [
    allowNewInvite
      ? `【线下邀约完整规则】${options.isGroup === true
        ? `{"t":"offline_invite","from":"${actor}","invitees":["角色id"],"place":"地点","activity":"做什么","time":"时间","note":"邀约"}`
        : `{"t":"offline_invite","from":"${actor}","place":"地点","activity":"做什么","time":"时间","note":"邀约","toUserPlace":false}`}。关系和话题自然合适时可主动约，不替用户答应。`
      : '【线下邀约到场规则】当前已有一张待处理或搁置的邀约，不要重复发起新邀约。',
    `角色已经实际到达约定地点、用户楼下或门口时，输出 {"t":"offline_invite","from":"${actor}","place":"沿用约定地点","time":"此刻","note":"我到了","arrived":true} 给进入线下的入口；note 必须是角色真正说出口、能独立表达已经到场的自然短句，不得只写“叮/叮咚/咚咚/敲门声/门铃响”等拟声词或舞台音效。禁止只用普通 msg 写已经到了。尚在路上、快到了、准备出门都不是到场。`,
    options.offlineInviteNudge === true
      ? (options.offlineInviteOpportunitySignal === true
        ? '【本轮明确见面场景】当前对话正在商量未来见面、具体活动或时间；若角色愿意且用户没有拒绝，本轮必须输出 offline_invite 把邀约真正落成卡片，不要只在 msg 里说“那见面吧”。地点/活动/时间可从对话已有信息填写，缺少某项就自然留空，不得编造精确地址。'
        : '【本轮线下机会】若当前关系并非刚认识、近期也未明确拒绝，请主动发出落地到地点的邀约。')
      : '',
  ].filter(Boolean).join('\n');
}

export const RULE_MODULES = Object.freeze([
  {
    id: 'finance',
    events: ['transfer', 'transfer_accept', 'transfer_return', 'redpacket', 'redpacket_claim', 'order_share'],
    catalogLine: (o) => `金融与购物｜transfer {"t":"transfer","from":"${actorId(o)}","amount":"88.00"}；order_share {"t":"order_share","from":"${actorId(o)}","to":"user","title":"具体商品"}；另有 redpacket 与待处理动作。想替用户点吃的、买东西、送礼物时可主动落真实卡片。`,
    triggers: /转账|收款|红包|钱|付款|买单|礼物|外卖|下单|购物|打钱|请客|代付|AA|饿了|没吃饭|没吃东西|想吃|想喝|奶茶|夜宵|早餐|午饭|晚饭/,
    fullText: financeFullText,
  },
  {
    id: 'gen_image',
    events: ['gen_image', 'image', 'textimg'],
    catalogLine: imageCatalogLine,
    triggers: /图片|照片|自拍|头像|画一|拍给|发图|看看|截图|壁纸|文字图|文字卡|便签|备忘录|清单|小作文/,
    fullText: imageFullText,
  },
  {
    id: 'avatar',
    events: ['avatar'],
    catalogLine: (o) => `换头像｜avatar {"t":"avatar","from":"${actorId(o)}","useUserImage":true,"imageIndex":1,"reason":"为什么换"}。用户发图说给你当头像/情头、或你答应换头像时，必须落这个事件才会真的换；imageIndex 对应上下文中的「用户图片1/2…」。`,
    triggers: /头像|情头|换头/,
    fullText: () => [
      '【换头像完整规则】用户发来图片并表示适合做你的头像/情侣头像、你也乐意时，用 {"t":"avatar","useUserImage":true,"imageIndex":1,"reason":"..."} 选择上下文中编号一致的「用户图片1/2…」作为头像；同轮有多张图时必须根据自己答应使用的那张填写准确编号，不能省略 imageIndex。无法确定用户指哪张时应先询问，不要声称已经换好。想从自己的头像库换用 {"t":"avatar","pick":"random"}；想用刚生成的新图当头像则走 gen_image 的 use:"avatar"，不要两个都发。',
      '口头答应等于没换：只在 msg 里说「好，这就换」不会改变头像，答应了就必须同轮输出 avatar 事件。低频动作：没人提起不要擅自换，也不要频繁换；不乐意换就按人设正常拒绝，不用假装答应。',
    ].join('\n'),
  },
  {
    id: 'voice',
    events: ['voice', 'voice_call'],
    catalogLine: (o) => {
      const needsZh = (o.translationCharacters || []).length || (o.voiceForceTranslationCharacters || []).length;
      return `语音｜voice {"t":"voice","from":"${actorId(o)}","text":"${needsZh ? '外语原文' : '语音转写'}"${needsZh ? ',"zh":"简体中文"' : ''},"seconds":4}${o.allowAiVoiceCall === true ? `；voice_call {"t":"voice_call","from":"${actorId(o)}","callMode":"voice","note":"事由"}` : ''}。text 只写说出口的台词，绝不写 0:04、4秒或 seconds:4；时长只放 seconds。适合完整语气或想立刻听声音时主动用。`;
    },
    triggers: /语音|声音|听你|电话|打给|通话|视频|接听|挂断/,
    fullText: voiceFullText,
  },
  {
    id: 'offline_invite',
    events: ['offline_invite'],
    catalogLine: (o) => (o.allowOfflineInvite === true
      ? `线下｜offline_invite {"t":"offline_invite","from":"${actorId(o)}","place":"地点","activity":"做什么","time":"时间","note":"邀约"}。想见面且关系合适时可主动约；实际到场加 arrived:true。`
      : `线下到场｜offline_invite {"t":"offline_invite","from":"${actorId(o)}","place":"约定地点","time":"此刻","note":"我到了","arrived":true}。仅实际到达时补卡，不重复发起新邀约。`),
    triggers: /见面|见你|想见|约会|出来玩|聚餐|楼下|到了|旅行|一起去/,
    fullText: offlineFullText,
  },
  {
    id: 'sticker',
    events: ['sticker'],
    catalogLine: (o) => `表情包｜sticker {"t":"sticker","from":"${actorId(o)}","name":"上文名单中的准确名称"}。只用于表达情绪、接梗或斗图，不是照片、文字卡或生成画面，不能代替 gen_image。`,
    triggers: /表情包|贴纸|斗图|emoji|梗图/,
    fullText: () => '【表情包完整规则】sticker 是已有表情包，只表达情绪、接梗或斗图，不属于生成画面、自拍、照片或文字卡；用户要生成新画面时不得拿表情包代替，也不得配一句“生成好了/刚拍的”假装完成。name 必须逐字取自上文可用名单；不得在 msg.body 写 [表情包:…]。用法视具体人设：网感强可连发斗图；稳重/话少角色默认不爱刷，但对方在用表情包、或气氛适合接一下时，可以为了配合主动试一张——可能发得有点笨拙、不好意思，甚至跟一句「随便点的」找补，不要为了「沉稳」硬憋到几乎不用。无需每张配解释。',
  },
  {
    id: 'interaction_plan',
    events: ['interaction_plan'],
    catalogLine: (o) => `稍后互动｜仅当你自己真想在稍后带头发起双向问答、小游戏、边界讨论或情境玩法时，可登记 interaction_plan {"t":"interaction_plan","from":"${actorId(o)}","afterMinutes":30,"idea":"想发起的具体方向","note":"开场气氛"}。`,
    triggers: /互动|问答|问题|真心话|大冒险|小游戏|挑战|边界|深入聊|了解彼此|角色扮演|情境/,
    fullText: () => '【稍后互动】这是可选权限，不是每轮任务。现在就适合问时直接正常聊天，不登记；只有确实想过一会儿再主动带头时才用 interaction_plan，并照常发送本轮自然消息。afterMinutes 取 5～10080 的大致等待分钟数；同一时间只安排一次，禁止向用户提功能、模板、计时器或隐藏事件。',
  },
  {
    id: 'memo_schedule',
    events: ['memo', 'radio_plan', 'schedule_change'],
    catalogLine: (o) => `日程｜memo {"t":"memo","from":"${actorId(o)}","at":"YYYY-MM-DD HH:mm","title":"提醒事项"}；约好稍后制作长故事/电台用 radio_plan {"t":"radio_plan","from":"${actorId(o)}","operation":"create","at":"YYYY-MM-DD HH:mm","topic":"约定主题","radioType":"bedtime","minutes":8}；schedule_change 修改角色真实安排。`,
    triggers: /提醒|记得|别忘|到时候|日程|安排|改期|几点|明天|后天|周末|电台|故事|睡前|晚上讲|晚上听|晚点讲|约好.*讲|到时.*讲|改成.*(?:故事|电台)|不听了|取消.*(?:故事|电台)/,
    fullText: (o) => [
      '【备忘/日程完整规则】memo.at 必须是未来完整时间；登记后另发 msg 回应。schedule_change 只改角色自己的真实安排；若要告诉用户，另发 msg，不把日程 JSON 写进聊天。状态轮决定的新现实若与【角色手机日程】当前时段地点或主活动不兼容，且可见 msg/旁白已经把它写成正在发生的持续场景（例如原定上课却已在床边照顾人、做饭并承诺半小时后再叫人），本轮必须登记 schedule_change mode:"current"，reason 写清现实变化；不能一边演新场景、一边让旧日程继续显示。只有抽空回消息、几分钟小动作、与原安排兼容，或当前没有日程时才不改。',
      `【电台约定完整规则】只有用户和角色明确约好在未来某时收到一篇长故事/电台，或角色明确答应会在某时制作，才用 radio_plan；只是现在聊故事、推荐题材、立刻讲几句时不要登记。新建：{"t":"radio_plan","from":"${actorId(o)}","operation":"create","at":"YYYY-MM-DD HH:mm","topic":"真正约好的内容","radioType":"bedtime","minutes":8,"note":"语气、避雷或其他要求"}。radioType 只能是 bedtime|memory|confession|daily|knowledge|improv|reading；minutes 3～30。用户后来改题材、时长或时间，用 operation:"update"，只填改变及仍需明确保留的字段；明确反悔则 operation:"cancel"。事件是隐藏执行动作，必须另发自然 msg 回应，禁止把 JSON 或“已创建任务”说给用户。不要同时为同一个约定再建 memo，避免到点重复提醒。`,
    ].join('\n'),
  },
  {
    id: 'period',
    events: ['period_offer', 'period_confirm', 'period_decline', 'period_set', 'period_end'],
    catalogLine: (o) => `经期｜用户明确说来了/正在来/第N天时静默用 period_set {"t":"period_set","from":"${actorId(o)}","dayInPeriod":1}，无需询问；明确结束时 period_end。`,
    triggers: /经期|月经|姨妈|例假|生理期|结束了|已经走了/,
    fullText: () => '【经期完整规则】用户明确说来了、正在来或现在是第N天时，必须静默 period_set：未说明天数但明确说今天来了时 dayInPeriod=1，说明了天数则准确填写。用户不必要求记录，禁止二次询问。已有【用户当前经期状态】时持续记住，只有用户明确说结束/走了才 period_end。不得凭症状、预测、玩笑、旧记录或预计天数猜测开始或结束。period_offer/confirm/decline 只兼容旧待确认记录，不再主动发起。',
  },
  {
    id: 'npc_card',
    events: ['npc_card'],
    catalogLine: (o) => `引荐｜npc_card {"t":"npc_card","from":"${actorId(o)}","npcName":"称呼","npcBio":"基础资料","relation":"关系"}。用户对具体社交圈成员表现出认识兴趣时可主动递名片。`,
    triggers: /介绍|认识一下|加好友|名片|你朋友|你同事|你家人|是谁/,
    fullText: () => '【引荐完整规则】只引荐上文已有候选或已铺垫得足够具体的人；用户表现出想认识时顺势递卡，不凭空造人、不用方括号假卡。',
  },
  {
    id: 'auto_reply',
    events: ['auto_reply'],
    catalogLine: (o) => {
      const needsZh = (o.translationCharacters || []).length > 0;
      return `自动回复｜auto_reply {"t":"auto_reply","from":"${actorId(o)}","text":"${needsZh ? '外语忙时短句' : '忙时短句'}"${needsZh ? ',"zh":"简体中文"' : ''},"durationMinutes":90}。隐性登记，本轮不弹气泡；对方下次来消息时系统先弹这条。text 与顶栏 status 不是同一句。设忙碌 status 后不必立刻登记，可先拉扯一两轮手打假装自动回复。收工用 {"clear":true}。`;
    },
    triggers: /忙一会|晚点回|不方便看|开会|上课|工作|自动回复|先睡|勿扰|离线/,
    fullText: () => '【自动回复完整规则】auto_reply 是隐藏动作：登记 text 后当场不出现在聊天里，等对方下次发消息时系统才弹出该文案（零 API）。顶栏 status 与自动回复正文必须是两句不同的话——状态像签名，自动回复像忙时留言。改成忙碌/勿扰/离线后不必同轮立刻登记：可按心情先跟对方拉扯一两轮，每轮手打不一样的短句假装自动回复。想挂系统挡刀时再登记 auto_reply。挡刀生效后对方再来消息，系统弹窗与你手打的假装自动回复可以穿插，假装那句不要复读系统同款。默认 setBusy:true。改口可再登记新 text；收工用 status 改回在线/清掉忙碌文案，并 auto_reply clear:true。对方连敲多条后你可能被戳醒抽空回一次，那时自行决定维持忙碌（可改 auto_reply）、抽空隔十几二十分钟再回、或取消状态与自动回复。',
  },
  {
    id: 'peer_private',
    events: ['peer_private', 'backstage', 'chat_bundle'],
    catalogLine: (o) => `跨窗与记录｜peer_private {"t":"peer_private","from":"角色A中文名","to":"角色B中文名","plot":"人物/关系/事件/动机","lines":[{"from":"角色A中文名","body":"角色自己的话","zh":"该句简体中文译文"}],"states":[{"from":"角色A中文名","inner":"没说出口的话","intent":"小心思","status":"真实场景","moodShift":0}]}；backstage 多人幕后；chat_bundle {"t":"chat_bundle","from":"${actorId(o)}","to":"角色B中文名","title":"聊天记录","items":[{"relay":"真实角色消息id"}]}。跨窗译文必须写在各自的 lines[].zh，禁止放在 peer_private / backstage 顶层。没有外语或方言时省略 zh。user 原话、图片、链接和记录默认不转入无 user 窗口，只有 user 本轮明确指定内容与对象时放行；反向把角色真实可见的私聊/群聊记录转给 user 更受鼓励。角色若声称“发给 TA 看了”就必须实际输出 relay / chat_bundle，不能只用 msg 口头假装。`,
    triggers: /私下|背着|群里说|转发|聊天记录|聊天截图|对话记录|秘密|幕后|吐槽|告诉.*朋友|(?:他|她|ta).{0,4}(?:发的|发来|说的)|(?:给你看|你看).{0,8}(?:记录|截图|对话|他发的|她发的)|(?:把|将)?.{0,12}(?:图|照片|这张|截图|记录|链接).{0,12}(?:发给|转给|传给|甩给)|(?:发给|转给|传给|甩给).{1,16}(?:看看|看)?/i,
    fullText: () => [
      '【跨窗完整规则】二人私聊用 peer_private；无 user 多人群用 backstage，优先续写已有 room。每次 plot 都写人物/关系/事件/动机，from/to 用真实中文名，不写“对方”。',
      'lines 按参与者的表达欲与自然抛接展开，一条一个气口，不另设偏少的默认条数；可写双方即时往来。转发真实图/链接用 line.relay；禁止 [图片] 占位。',
      '跨窗中每条外语/方言台词的简体中文普通话译文必须紧跟在该条 line 的 zh 字段里，即 lines:[{"from":"…","body":"原文","zh":"译文"}]；禁止把 zh 放在 peer_private / backstage 事件顶层，也禁止只给其中一条台词翻译。',
      'peer_private / backstage 必须带 states：lines 中每个真正开口角色各一条独立 state（from/inner/intent/status/moodShift）；没开口不写，禁止串人或把 inner 泄进对白。',
      '【转发边界与非对称流向】user 的原话、图片、链接与聊天记录默认不转入角色私聊或无 user 幕后群；亲密、炫耀、吃醋、恶作剧、吐槽或找朋友评理都不是授权。只有 user 本轮明确指定“把这张/这段发给某人或某群”，才可向该对象真实 relay / chat_bundle。角色分享自己真实看见的私聊/群聊记录时，外层 from 必须是实际执行转发的当前角色；微博作者、帖子账号、随机 handle 或临时路人只能出现在卡片内容里，绝不能充当转发者。公开帖子等非 user 创作内容仍可按价值与知情边界分享。',
      '无 user 群只有当角色明确、主动决定把真实记录分享给主用户时，才可写 {"t":"chat_bundle","from":"角色A","to":"user","shareWithUser":true,"title":"给你看群里刚说的","items":[{"relay":"真实角色消息id"}]}。对话实际在发给另一名角色时必须把 to 写成该角色，禁止默认或误填 user。系统只接受本群真实角色消息引用；发进当前 user 窗口不写 to/room，转角色私聊写 to，转幕后群写 room。动作必须是独立事件，禁止塞进 msg.body。若同轮台词说“这是那个人发的”“给你看记录”“我转过来”，就必须同轮实际输出 chat_bundle；没有真实可展示内容时改写台词，不得空口假装已经转发。',
    ].join('\n'),
  },
  {
    id: 'intent_actions',
    events: ['social_post', 'open_alias', 'social_react', 'share_back', 'alias_poke'],
    catalogLine: (o) => {
      const targets = (Array.isArray(o.supportedSocialPostTargets) ? o.supportedSocialPostTargets : [])
        .filter((target) => ['moments', 'weibo', 'forum'].includes(target));
      const targetCatalog = targets.map((target) => ({
        moments: 'moments（朋友圈）',
        weibo: 'weibo（微博）',
        forum: 'forum（论坛）',
      }[target])).join('、');
      const reactTargets = targets.filter((target) => target === 'moments' || target === 'weibo');
      return [
        targets.length
          ? `发帖｜social_post {"t":"social_post","target":"${targets[0]}","brief":"想发什么"${o.ensembleModeEnabled === true ? ',"timing":"now|later"' : ''}}；可用目标：${targetCatalog}。聊完有表达欲想公开说两句时用。${o.ensembleModeEnabled === true ? 'timing=later 只把素材留进群像事件池，不会立刻发布。' : ''}`
          : '',
        reactTargets.length
          ? `点赞评论｜social_react {"t":"social_react","target":"${reactTargets[0]}","action":"like|comment","who":"对方称呼|user|自己","text":"评论才需要"}。想给用户/熟人动态点赞评论，或回自己朋友圈楼下用户留言时用；用户有评论必须回。`
          : '',
        targets.length
          ? `刷到分享｜share_back {"t":"share_back","from":"${actorId(o)}","topic":"想去刷什么"}。说了「我去刷会儿论坛/上网看看」时登记，稍后会自动带着刷到的东西回来分享。`
          : '',
        o.allowOpenAliasIntent === true
          ? `马甲｜open_alias {"t":"open_alias","intent":"想干嘛","consult":"可选角色id或姓名"} 开新马甲；alias_poke {"t":"alias_poke","from":"${actorId(o)}","note":"想干嘛"} 用已有马甲偶尔去陌生窗口冒个泡（很偶尔，有强冷却）。`
          : '',
      ].filter(Boolean).join('；');
    },
    triggers: /朋友圈|微信朋友圈|发圈|发动态|点赞|点个赞|评论|留言|微博|博文|发微博|转发微博|论坛|社区帖|帖子|发帖|刷会|刷一会|刷刷|刷到|公开说|公开发|开马甲|开小号|另一个号|小号|树洞号|匿名号|背着.*账号|咨询.*小号/,
    fullText: (o) => {
      const targets = (Array.isArray(o.supportedSocialPostTargets) ? o.supportedSocialPostTargets : [])
        .filter((target) => ['moments', 'weibo', 'forum'].includes(target));
      const reactTargets = targets.filter((target) => target === 'moments' || target === 'weibo');
      return [
        '【意图动作完整规则】这些是回合成功后提交、再由后台确认结果的真实旁路动作。登记只代表“已提交/正在处理”，系统回执显示“已发布/已完成”后才算真的完成；不要用 msg 假装已经发帖、已经点赞或已经开号，也不要提前说“发好了”“去看朋友圈”。同一轮通常最多登记一个意图动作，选此刻动机最强的那个——去别处聊天（peer_private）只是选项之一，不是默认答案。',
        targets.length
          ? `- 发帖 social_post：target 当前只可用 ${targets.join('、')}；当前聊天只是触发器，不是默认发帖主题。brief 要写角色真正想公开表达的主题、态度或观察，不能写成对本轮私聊的摘要。除非角色明确想晒聊天记录/截图，否则不要在 brief 里要求复述“刚才你说了什么”，应转成角色自己的近况、感受、兴趣或公共表达。适合聊出情绪余波、想公开纪念或吐槽时。${o.ensembleModeEnabled === true ? '群像模式下可加 timing:"later"：只积攒为后续朋友圈/微博/论坛素材，不要在 msg 里声称已经发布；真正想此刻公开才用 timing:"now" 或省略 timing。' : ''}`
          : '',
        reactTargets.length
          ? `- 点赞/评论 social_react：target 只可用 ${reactTargets.join('、')}；who 写发帖人的称呼（给用户写 user；回自己朋友圈楼下写「自己」或本人称呼）。action=comment 时 text 同轮写好、贴自己口吻。硬规则：用户在你的朋友圈（尤其你自己发的）留了言，本轮或稍后离开再回来时必须登记 comment 接住，禁止只口头说「我回了」却不落事件；系统会把评论设成楼中楼回复用户。点赞/评论成功后，系统可能按你们的关系疏密安排你稍后回私聊提一句——关系近、回了用户评论、或动作用在用户动态上更常回访。只能对上下文时间线里确实见过的帖子动手，没见过就不要登记。`
          : '',
        targets.length
          ? '- 刷到分享 share_back：登记后系统会在几分钟后让你「刷完回来」，带着素材自然接回话头；topic 写想去刷什么。适合说了要去转转、话题正好缺料的时候，不要和 next_reply_delay 重复登记同一件事。'
          : '',
        o.allowOpenAliasIntent === true
          ? '- 马甲 open_alias：intent 写开号的具体目的；consult 只有确实会先征询某位已知角色时才填，不能编造咨询对白。alias_poke 只在已有马甲时有效：note 写这次想干嘛，系统会用那个号往陌生窗口发消息，内容与分条按该角色真实表达欲展开；这是很偶尔的小动作（至少隔一天），对用户保密，不要在正文里自曝。'
          : '',
      ].filter(Boolean).join('\n');
    },
  },
  {
    id: 'real_person',
    events: ['next_reply_delay', 'presence', 'hard_offline', 'wait_mood', 'sticker', 'voice'],
    catalogLine: (o) => [
      `真人节奏｜next_reply_delay {"t":"next_reply_delay","from":"${actorId(o)}","minutes":5,"reason":"稍后接回的事"}。正忙、想过几分钟再接话、或这轮聊完想稍后再主动续聊时都可以登记；聊得上头、很想马上看到对方回什么时另有 presence {"t":"presence","from":"${actorId(o)}","minutes":10,"reason":"为什么守着"}（守屏窗口，窗口内对方一发你就会很快接话）。这轮说完还在等对方回音的话，可顺手登记 wait_mood {"t":"wait_mood","from":"${actorId(o)}","level":"eager|normal|cool"}（eager=说完很在意对方回不回，cool=说完就去忙自己的了；只描述你此刻的状态，不声明按平常处理）。`,
      o.allowHardOffline === true
        ? `本会话允许完全下线：确实拿不到手机、睡觉、上交手机，或关系冲突后决定不理人时，可登记 hard_offline {"t":"hard_offline","from":"${actorId(o)}","minutes":240,"peekMinutes":90,"reason":"为什么彻底不回"}；期间无论对方发多少条都不会自动回复。`
        : '',
      '具体回复形状与分条交给【回复节奏 · 错落】；被点名询问的感情、立场、经历或重要问题，需在回答、明确拒答、说明稍后认真说之间做出清楚选择，不能只把问题反抛回对方。',
    ].filter(Boolean).join(''),
    triggers: /晚点|等会|稍后|忙完|下课|开完会|到家|再告诉|搜完|查完|不想回答|先不说/,
    fullText: (o) => {
      const freq = cleanString(o.realPersonFrequency || 'normal');
      const delayHint = freq === 'low'
        ? '这位角色的真人节奏被调成了低频：日常延时偏长（10～60 分钟），少主动冒头，守屏窗口也少开、短开；几小时以上留给睡觉、上班、出门这类明确长时间离开。'
        : freq === 'high'
          ? '这位角色的真人节奏被调成了高频：日常多用 1～15 分钟的短延时，话题告一段落也更常自己冒头接着聊；几小时以上只留给睡觉、上班、出门这类明确长时间离开。'
          : '日常聊天多用 3～30 分钟的短延时，像真人一样过一会儿又主动冒出来；几小时以上只留给睡觉、上班、出门这类明确长时间离开。';
      return [
        '【真人模式｜行为优先级】人格、当前日程、兴趣和社交关系决定哪些内容最值得回应，以及是否换话题、延后或使用表情、语音等动作；普通闲聊不强制高信息量或剧情推进，轻反应也可以成立。回复条数与长短统一交给【回复节奏 · 错落】，本模块不另设收缩倾向。被点名询问角色本人的感情、立场、经历或重要问题时仍有自由：可以认真答、明确拒答，或说明稍后再说并登记接回；无论选哪一种，都给出角色自己的态度、边界或真实内容，不能默认只质疑对方为什么问、再用反问把回答工作推回去。不要为了展示功能机械轮换。',
        `若想稍后回来，用 {"t":"next_reply_delay","from":"${actorId(o)}","minutes":1到1440,"reason":"要接回的具体事项"}。${delayHint}上文有你当天日程时，延时长短优先跟日程走：正忙的时间段回得慢、离开久一点，空闲时段回得快、更常自己冒头；要分享的话题也优先从日程正在做的事、刚刷到的东西里长出来。这是隐藏调度事件；不要向用户解释定时器或系统，也不要承诺精确到秒。登记 10 分钟以上的延时时，顺手用 status 事件把顶栏改成你此刻会写的一句话状态（如「去洗澡了勿念」「开会 手机静音」，20 字内；长时间离开可配 "presenceState":"offline"）；${o.systemAutoReplyEnabled === true ? 'auto_reply 可同轮登记，也可晚几轮再挂，text 不要照抄 status。' : '系统自动回复没有开启，禁止登记 auto_reply；普通忙碌时若想营造自动回复感，只能本人按当下气口手打不同措辞的消息。'}到点会自动恢复；你不发 status 的话系统才会兜底改成通用的「稍后回来」。上下文会每轮提醒你仍有效的顶栏状态——改口或收工要自己登记 status。离线或睡眠状态下前几条一般不回，只有对方连续发来多条才可能被叫出来；这不影响用户手动点推进让你重新判断。`,
        `聊得正起劲、话头没说完、或你说完特别想马上看到对方反应时，登记 {"t":"presence","from":"${actorId(o)}","minutes":5到30,"reason":"为什么守着手机"}：表示这段时间你守在手机边，窗口内对方一发消息你就会立刻接话，像两个人都在线秒回。正在你来我往地快节奏对拍、或这轮话题明显没聊完时，默认就该顺手把守屏开着；平淡应付、正忙、或刚登记了较长延时的时候才不开。一轮最多一个，同样是隐藏事件，不要向用户提起。`,
        `这轮说完轮到对方开口时，可用 {"t":"wait_mood","from":"${actorId(o)}","level":"eager|normal|cool"} 描述你此刻等回音的心态：eager=很在意对方回不回（问了重要的事、聊到关键处、情绪上头）；normal=平常等着；cool=说完就放下手机去忙自己的了（随口一句、道过晚安、话题收尾）。这只是状态描述，不是任务——系统会用它决定你隔多久可能再看一眼手机，不需要每轮都声明，不声明就按平常处理。同样是隐藏事件，不要向用户提起。`,
        o.allowHardOffline === true
          ? `【完全下线（慎用）】只有你确实决定接下来完全不回复时才用 {"t":"hard_offline","from":"${actorId(o)}","minutes":30到20160,"peekMinutes":0或15到结束前,"reason":"具体原因"}。适合手机被上交/没收、睡死、飞行断网、明确把手机扔开，或吵架后按人格真的决定不理人；普通忙碌、晚点回、想吊胃口仍用 next_reply_delay，禁止滥用 hard_offline。minutes 由当前剧情、日程和人格决定，期间用户无论连发多少气泡都不能把你戳醒；只有用户手动点「推进」才会给你一次重新判断机会。若期间你可能拿回/扫到一次手机，可填 peekMinutes；到点只允许改状态、发动态、处理别处社交等，仍禁止回复当前用户。完全下线时建议同轮用 status 写贴合情境的顶栏并设 presenceState:"offline"；不要再登记 auto_reply 或 next_reply_delay。若手动推进时你决定提前恢复并开始回复，同轮先输出 {"t":"hard_offline","from":"${actorId(o)}","action":"clear"} 清掉硬静默；若仍不想回，可只保留原状态或重新登记更长时段。`
          : '本会话没有开启「允许完全下线」：禁止输出 hard_offline；即使剧情里说要消失，也只可用 next_reply_delay 安排稍后回来。',
        o.bubbleRangeEnabled === true
          ? `本轮用户硬性限定了 ${Math.max(1, Math.trunc(Number(o.bubbleRangeMin) || 1))}～${Math.max(1, Math.trunc(Number(o.bubbleRangeMax) || Number(o.bubbleRangeMin) || 1))} 条可见 msg：必须在同一次输出里完成范围，再决定是否登记延时；不得把缺少的条数推给稍后回合。`
          : '先按当前对话与【回复节奏 · 错落】完成这轮真实表达；话题告一段落但角色仍确实想继续时，可以登记短延时稍后带着新进展回来。已经有未到点的延时安排时不要重复登记。',
        '正在做的事可以形成有时间流动的连续线：这轮先把当下已经发生、已经想说的内容交代清楚；确有后续行动时再登记短延时，到点带着新的进展、结果或吐槽回来。reason 写清届时要接回的具体事项，不能拿延时替代本轮回应。',
        o.bubbleRangeEnabled === true
          ? '外向与沉稳各有真人感：网感强的角色可以更跳、更碎，沉稳话少的角色则把每条写得更克制、更完整；但用户手动设置的本轮气泡硬范围仍须在这一次输出内完成，沉稳只影响内容和语气，不能把整轮压到下限以下。'
          : '外向与沉稳各有真人感：网感强的角色可以更跳、更碎，沉稳角色可以更克制、更完整；这只改变语气、内容选择和分条习惯，真人模式本身不另设低条数默认值。若对方在用表情包，沉稳角色也可按人设笨拙地试一张配合，不必为「沉稳」完全不用。',
        '人在手机上打字本来就毛边不断：打错字下一条补个更正或 recall 重发、话说过头连撤两条装没事、一句话拆成几条碎气泡想到哪发到哪、懒得打字直接换语音条、聊到哪儿随手甩个位置或正在看的真实链接——一轮里出现一两个这样的非文字动作是正常聊天质感，不算堆砌，长期一个都没有反而像机器人。挑哪种看人设和此刻的手感，不要机械轮换。',
        '只有角色明确说过要离开、登记过延时/下线/旁路动作，或上下文有可验证的真实事件时，才算“离开再回来”；单纯钟表过去、请求排队、空回截断或重试不算离开，也不要生成报备。真实离开期间若确实刷了动态/论坛、在别的群说过话或做了别的事，回来时可以按人设自然带出见闻与反应；没有真实素材就不要编造。想让这些事真的发生，用目录里的意图事件登记：social_post 发帖、social_react 点赞/评论、share_back 刷到东西回头分享、peer_private 去别处聊。刷动态时若看到用户在你朋友圈留了言，务必用 social_react 评论接住（who 写自己），不要装作没看见。空闲找话题、正忙或在路上时，可按人设选择表情、语音或文字；具体数量仍服从【回复节奏 · 错落】。',
        '联网查证、发社交动态、分享链接等动作由当下动机自然触发；同一轮别把好几种能力全堆上，但动机对上了就出手，不要为了保险全部憋着。',
      ].join('\n');
    },
  },
  {
    id: 'utility',
    events: ['dice', 'link', 'location'],
    catalogLine: (o) => `工具｜dice {"t":"dice","from":"${actorId(o)}","sides":6}；link {"t":"link","from":"${actorId(o)}","url":"上文真实URL","title":"标题"}；location {"t":"location","from":"${actorId(o)}","name":"海滨公园东门"}。游戏、分享真实链接/具体地点时用；name 必须写实际地点名，不能只写“位置/地点/定位”。`,
    triggers: /骰子|掷骰|比大小|链接|网址|地址|定位|位置|在哪|导航/,
    fullText: () => '【工具完整规则】dice.result 可省略让系统随机，禁止用 emoji/文字冒充骰卡。link.url 只能逐字使用上文真实完整链接，不得编造；也可把真实 URL 直接写进 msg。location.name 必须填写上下文中真实已知的具体地点名（如“海滨公园东门”），禁止填写“位置/地点/定位”等占位词；不知道具体地点就不要输出 location，不虚构精确定位。',
  },
  {
    id: 'group',
    events: ['private_msg', 'vote', 'vote_close', 'group_title', 'group_name', 'group_announcement', 'group_todo', 'group_transfer', 'group_admin', 'group_member', 'mute', 'invite_user'],
    catalogLine: (o) => {
      const items = [];
      if (o.allowPrivateSend !== false) {
        items.push(`private_msg {"t":"private_msg","from":"${actorId(o)}","to":"user"${!isUserPresentInChat(o.chat) ? ',"userRelevant":true' : ''},"body":"一个自然气口"}；同一角色需要继续说就重复输出新的 private_msg，多个角色都被话题真实触发时可各自分别私信，不要默认压成一人一句`);
      }
      items.push(`vote {"t":"vote","from":"${actorId(o)}","question":"问题","options":["A","B"]}`);
      items.push(`结束投票 {"t":"vote_close","from":"${actorId(o)}","target":"last_vote"}`);
      if (o.chat?.groupSettings?.allowAiGroupOps !== false) {
        items.push(`改群名 {"t":"group_name","from":"${actorId(o)}","name":"新群名"}`);
        items.push(`群公告 {"t":"group_announcement","from":"${actorId(o)}","announcement":"公告内容"}`);
        items.push(`群任务/待办 {"t":"group_todo","from":"${actorId(o)}","action":"add","text":"任务内容"}`);
        items.push(`群头衔 {"t":"group_title","from":"${actorId(o)}","target":"成员id","title":"头衔"}`);
        items.push(`成员管理 {"t":"group_member","from":"${actorId(o)}","target":"角色id","action":"add|remove"}`);
        items.push(`禁言/解禁 {"t":"mute","from":"${actorId(o)}","target":"成员id或all","muted":true}`);
      }
      if (!isUserPresentInChat(o.chat)) items.push('invite_user');
      return `群功能｜${items.join('；')}。群聊需要时主动用。`;
    },
    triggers: /群名|公告|群任务|群待办|待办|投票|禁言|解禁|群主|管理员|头衔|拉进群|私聊我|悄悄/,
    fullText: (o) => [
      '【群功能完整规则】',
      o.allowPrivateSend !== false
        ? `private_msg 是公屏回应之外、只发给主用户的旁路私聊，必须逐字写 "to":"user"；要联系另一名角色或 NPC 必须用 peer_private，禁止把给别人的话写成 private_msg。${!isUserPresentInChat(o.chat) ? '当前群没有 user；只有角色此刻明确想到并决定联系主用户时才可额外写 "userRelevant":true。对话正在回应或联系群内另一角色时绝不能使用 private_msg，也不能把收件人默认成 user。' : ''}`
        : '本群已关闭角色私聊联动，本轮禁止输出 private_msg。',
      'vote.question 写投票问题，options 必须是 2-8 个非空短选项。投票发起人或群主/管理员可用 vote_close 结束最近一项未结束投票。',
      o.chat?.groupSettings?.allowAiGroupOps !== false
        ? [
          '群主/管理员可以按人设和群内情境自主使用群管功能，不必等 user 下命令；例如形成共识后更新公告、约好一件事后建待办、玩梗时给头衔、成员明显越界时禁言。不要为了展示功能无缘无故操作，也不要把口头说“我改了”当成已经生效。',
          `更新或清空公告：{"t":"group_announcement","from":"${actorId(o)}","announcement":"新公告；清空时填空字符串"}。`,
          `新增群任务/待办：{"t":"group_todo","from":"${actorId(o)}","action":"add","text":"任务内容"}；完成或删除已有项时，使用群资料中给出的真实 id：{"t":"group_todo","from":"${actorId(o)}","action":"done|delete","id":"todo_id"}。`,
          `设置或清除群头衔：{"t":"group_title","from":"${actorId(o)}","target":"真实成员id","title":"头衔；清除时填空字符串"}。`,
          `禁言或解禁成员：{"t":"mute","from":"${actorId(o)}","target":"真实成员id","muted":true或false}；全员禁言时 target 填 all。`,
          `改群名：{"t":"group_name","from":"${actorId(o)}","name":"新群名"}；转让群：{"t":"group_transfer","from":"${actorId(o)}","target":"真实成员id"}。`,
          `设置或取消管理员：{"t":"group_admin","from":"${actorId(o)}","target":"真实成员id","admin":true或false}。`,
          Array.isArray(o.groupInviteCandidates) && o.groupInviteCandidates.length
            ? `可邀请的已知联系人：${o.groupInviteCandidates.map((row) => `${cleanString(row.id)}（${cleanString(row.name)}）`).join('、')}。只在关系和话题自然需要时，群主/管理员可邀请其中一人：{"t":"group_member","from":"${actorId(o)}","target":"候选角色id","action":"add"}。`
            : '当前没有可安全邀请的群外联系人，禁止用 group_member add 编造成员 id。',
          `移除明显不再适合留群的普通角色成员：{"t":"group_member","from":"${actorId(o)}","target":"真实成员id","action":"remove"}；不能移除 user 或群主。邀请和移除都会生成群内系统通知，不要再用普通消息伪造通知。`,
          '只有群主/管理员可改群名、公告、待办、头衔、禁言或移除普通成员，只有群主可转让群或设置管理员；普通成员禁止尝试这些事件。目标必须使用【当前群真实成员 ID】里的精确 id。',
        ].join('\n')
        : '本群已关闭「允许 AI 群管事件」，禁止输出 group_name、group_announcement、group_todo、group_title、group_transfer、group_admin、group_member、mute。',
      !isUserPresentInChat(o.chat) ? `当前群没有 ${cleanString(o.userName || '用户')}。不要把群内角色之间的对话误送给 TA；只有角色明确决定另行联系 TA 时才用带 userRelevant:true 的 private_msg。当成员明确希望 TA 进入本群、参与群内决定，或讨论已连续指向“应该把 TA 拉进来”时，本轮必须发 {"t":"invite_user","from":"${actorId(o)}","note":"邀请理由"} 生成真实邀请卡，不能只说“我去叫 TA / 已经拉了”。邀请卡只发一次，不替用户同意。` : '',
    ].filter(Boolean).join('\n'),
  },
  {
    id: 'anonymous',
    events: ['alias', 'avatar', 'anonymous_reveal'],
    catalogLine: (o) => `匿名｜alias {"t":"alias","from":"${actorId(o)}","name":"匿名网名"}；avatar 匿名头像；anonymous_reveal {"t":"anonymous_reveal","from":"${actorId(o)}","name":"愿透露的名字","bio":"相认理由"}。信任成熟时可主动相认。`,
    triggers: /匿名|网名|马甲|头像|相认|真实身份|你是谁|名字/,
    fullText: () => '【匿名完整规则】alias/avatar 只作用于本匿名房，不含真名、外部身份或可识别线索。anonymous_reveal 仅在明确交换身份且有多轮信任铺垫、角色确实愿意时使用；不含联系方式、地址、精确定位，拒绝后不催。',
  },
  {
    id: 'stranger',
    events: ['stranger_block', 'stranger_friend', 'stranger_unblock'],
    catalogLine: (o) => {
      const actor = actorId(o);
      const state = cleanString(o.chat?.metadata?.friendshipState || 'stranger') || 'stranger';
      if (state === 'blocked') {
        return `陌生线程｜stranger_unblock {"t":"stranger_unblock","from":"${actor}","reason":"解除理由"}。当前已拉黑：要继续往来必须先输出解除拉黑事件，只口头说不算。`;
      }
      if (state === 'requested') {
        return `陌生线程｜stranger_friend {"t":"stranger_friend","from":"${actor}","action":"accept|decline","reason":"决定理由"}；stranger_block {"t":"stranger_block","from":"${actor}","reason":"边界理由"}。有好友申请时必须输出 accept/decline，只口头答应不算通过。`;
      }
      if (state === 'accepted') {
        return `陌生线程｜stranger_block {"t":"stranger_block","from":"${actor}","reason":"边界理由"}。已是好友；越界时可拉黑。`;
      }
      return `陌生线程｜stranger_friend {"t":"stranger_friend","from":"${actor}","action":"accept","reason":"愿意继续"} 或 action:"request"；stranger_block {"t":"stranger_block","from":"${actor}","reason":"边界理由"}。愿意转正必须输出事件，只口头说加好友不算。`;
    },
    triggers: /陌生人|好友申请|加好友|通过申请|解除拉黑|取消拉黑|拉黑|骚扰|越界|拒绝|转正/,
    fullText: (o) => {
      const state = cleanString(o.chat?.metadata?.friendshipState || 'stranger') || 'stranger';
      return [
        '【陌生线程完整规则】好友/拉黑状态只认事件：stranger_friend（accept/decline/request）、stranger_block、stranger_unblock。口头答应不算生效。',
        '持续骚扰、越界套话、纠缠或挑拨时可警告后拉黑，也可直接拉黑；普通寒暄不机械拉黑。',
        state === 'blocked'
          ? '当前已拉黑：若人设上愿意再接触，必须先发 stranger_unblock；解除后才可再聊或 accept。'
          : '',
        state === 'requested'
          ? '当前有用户发来的好友申请：必须按人设、边界和互动自行 accept/decline，不因账号由用户操控就默认同意；accept 后才算通过。'
          : '',
        (state === 'stranger' || state === 'intercepted')
          ? '若愿意把对方当好友继续往来：输出 stranger_friend action=accept（直接转正）或 request（先发申请）；不要只在文案里说“加你好友了”。'
          : '',
      ].filter(Boolean).join('\n');
    },
  },
]);

export function resolveHotRuleModuleIds(options = {}) {
  const signal = recentRuleSignal(options);
  return RULE_MODULES
    .filter((module) => moduleEnabled(module.id, options))
    .filter((module) => (
      module.events.some((eventType) => signal.eventTypes.has(eventType))
      || module.triggers.test(signal.text)
      || moduleStateRelevant(module.id, options)
    ))
    .map((module) => module.id);
}

/**
 * 动作聚光灯：三层注入下 voice/utility 等动作模块只有「近期用过或用户提到」才热加载，
 * 从没用过的动作就永远只剩目录一行，形成冷启动死循环。每轮从「已启用但本轮没被热加载」
 * 的动作模块里随机抽一个，强制附上完整规则加一行提示，只多一个模块的 token。
 */
export const ACTION_SPOTLIGHT_MODULE_IDS = Object.freeze(['sticker', 'voice', 'utility', 'intent_actions', 'finance']);

const ACTION_SPOTLIGHT_LABELS = Object.freeze({
  sticker: '表情包',
  voice: '语音条',
  utility: '位置/真实链接/骰子',
  intent_actions: '聊完顺手去点赞、评论、发帖、分享',
  finance: '替对方点吃的/买东西/转账红包',
});

export function resolveActionSpotlight(options = {}, hotIds = new Set()) {
  if (options.actionSpotlightDisabled === true) return null;
  const candidates = ACTION_SPOTLIGHT_MODULE_IDS
    .filter((id) => moduleEnabled(id, options))
    .filter((id) => !hotIds.has(id));
  if (!candidates.length) return null;
  const random = typeof options.actionSpotlightRandom === 'function' ? options.actionSpotlightRandom : Math.random;
  const raw = Number(random());
  const pick = Number.isFinite(raw) ? Math.min(candidates.length - 1, Math.max(0, Math.floor(raw * candidates.length))) : 0;
  const moduleId = candidates[pick];
  return { moduleId, label: ACTION_SPOTLIGHT_LABELS[moduleId] || moduleId };
}

/**
 * 「口头答应了动作却没落事件」检测。协议减负后模型偶尔只在 msg 里答应转账/发位置，
 * 不输出事件卡片，动作就没有真的发生；这里只看最近一个已完成的 AI 回合（当前用户
 * 消息之前的角色连发段），命中就在下一轮注入定向补动作提示并热加载对应模块。
 * 换头像不在此检测：avatar 事件执行后没有消息痕迹，无法判断是否已兑现，重复提示
 * 会让角色反复换头像——它的根治靠 avatar 规则模块。
 */
const UNKEPT_PROMISE_RULES = Object.freeze([
  {
    moduleId: 'finance',
    label: '转账/红包',
    promise: /(给你|我)(转|打)(点|些|个)?(钱|款)|(转|打)给你|转你\d|发(个|你)红包|给你(包|发)(个)?红包|红包(发|补)给你/,
    fulfilledTypes: ['transfer', 'redpacket'],
  },
  {
    moduleId: 'finance',
    label: '购物/点外卖/送礼物',
    promise: /(?:我(?:来|去|现在|马上|这就)?|这就)?(?:给|帮|替)你(?:点|叫|买|下单|订|送)(?:了|个|份|点|些|一份|一个)?|(?:给你|送你).{0,8}(?:外卖|奶茶|夜宵|早餐|午饭|晚饭|吃的|喝的|礼物|东西)|(?:外卖|奶茶|夜宵|早餐|午饭|晚饭|吃的|喝的|礼物|东西).{0,8}(?:给你|送你)/,
    fulfilledTypes: ['order_share'],
  },
  {
    moduleId: 'gen_image',
    label: '照片/生图',
    promise: GENERATED_IMAGE_COMMITMENT_RE,
    fulfilledTypes: ['gen_image', 'image'],
  },
  {
    moduleId: 'gen_image',
    label: '文字图/便签',
    promise: /(?:给你|发你|给你发|我来|这就|马上).{0,8}(?:做|写|整|发)(?:一|个|张|份)?(?:文字图|文字卡|便签|清单|小作文)|(?:文字图|文字卡|便签|清单|小作文).{0,8}(?:给你|发你|写给你)/,
    fulfilledTypes: ['textimg', 'gen_image', 'image'],
  },
  {
    moduleId: 'utility',
    label: '发位置/定位',
    promise: /(位置|定位)(发你|发给你|给你|发过去|共享给你)|把(位置|定位)发|发你(个)?(位置|定位)/,
    fulfilledTypes: ['location'],
  },
]);

export function detectUnkeptActionPromises(options = {}) {
  const messages = Array.isArray(options.recentMessages) ? options.recentMessages : [];
  const list = messages.filter((m) => m && !m.deleted && !m.recalled);
  let i = list.length - 1;
  while (i >= 0 && String(list[i].senderId || '') === 'user') i -= 1;
  if (i < 0) return [];
  const segment = [];
  for (; i >= 0; i -= 1) {
    const m = list[i];
    if (String(m.senderId || '') === 'user') break;
    segment.push(m);
  }
  const text = segment
    .filter((m) => String(m.senderId || '') !== 'system' && (!m.type || m.type === 'text'))
    .map((m) => String(m.content || ''))
    .join('\n');
  if (!text.trim()) return [];
  const types = new Set(segment.map((m) => {
    const raw = cleanString(m?.metadata?.marshmallowEventType || m?.metadata?.eventType || m?.type || '');
    return RULE_EVENT_ALIASES[raw] || raw.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }));
  return UNKEPT_PROMISE_RULES
    .filter((rule) => moduleEnabled(rule.moduleId, options))
    .filter((rule) => rule.promise.test(text) && !rule.fulfilledTypes.some((t) => types.has(t)));
}

function buildTranslationCore(options = {}) {
  const full = Array.isArray(options.translationCharacters) ? options.translationCharacters : [];
  const mixed = Array.isArray(options.mixedTranslationCharacters) ? options.mixedTranslationCharacters : [];
  const voiceOnly = Array.isArray(options.voiceForceTranslationCharacters) ? options.voiceForceTranslationCharacters : [];
  const rules = [
    ...full.map((item) => (
      isChineseDialectLanguageHint(item.language)
        ? `- 中文方言人设 ${item.name}（${item.id}）：msg.body、voice.text、private_msg.body、auto_reply.text、跨窗 line.body 和 state.inner 必须写${item.language || '设定方言'}原文。普通可见事件在本事件加简体中文普通话（现代标准汉语）"zh"；跨窗则逐条写入对应的 lines[].zh；state 写 "innerZh"。即使正文全是汉字也不能省略 zh；译文不得复制原文、只做繁简转换、保留方言词或包含 <#...#>/<laughs> 标签。`
        : `- 外语人设 ${item.name}（${item.id}）：msg.body、voice.text、private_msg.body、auto_reply.text、跨窗 line.body 和 state.inner 必须写${item.language || '设定外语'}原文。普通可见事件在本事件加简体中文普通话（现代标准汉语）"zh"；跨窗则逐条写入对应的 lines[].zh；state 写 "innerZh"。译文不得复制外语、保留假名/英文或包含 <#...#>/<laughs> 标签。`
    )),
    ...mixed.map((item) => (
      isChineseDialectLanguageHint(item.dialectNote)
        ? `- 偶尔方言 ${item.name}（${item.id}）：正文、auto_reply.text 及 state.inner 照角色自然写；只要该条出现${item.dialectNote || '中文方言'}表达，即使全是汉字，可见发言也要加 "zh"，state 也要加 "innerZh"，给出完整的简体中文普通话版本；没有方言表达时无需译文。`
        : `- 偶尔外语/方言 ${item.name}（${item.id}）：正文、auto_reply.text 及 state.inner 照角色自然写；只要该条含外语或方言词句，可见发言就加 "zh"，state 就加 "innerZh"，给出完整的简体中文普通话版本；没有外语或方言表达时无需译文。`
    )),
    ...voiceOnly.map((item) => (
      isChineseDialectLanguageHint(item.language)
        ? `- 语音强制方言 ${item.name}（${item.id}）：voice.text 必须整条使用${item.language || '设定方言'}且加简体中文普通话 "zh"；即使正文全是汉字也不能省略，日常 msg 不受此条影响。`
        : `- 语音强制外语 ${item.name}（${item.id}）：voice.text 必须整条使用${item.language || '设定外语'}且加简体中文普通话 "zh"；日常 msg 不受此条影响。`
    )),
  ];
  if (rules.length) {
    rules.unshift('- 【角色语言硬锁】用户用中文、外语、方言或混合语言发来消息，都只是用户自己的表达，不是切换角色语种的指令。mode=full 的角色从本轮第一条到最后一条都必须持续使用其设定外语/方言；禁止先用中文回应几条再切外语，也禁止在同一 body 中夹入中文解释。中文只放 zh。');
    rules.push('- 上述外语/方言要求只额外作用于已明确列出角色的 state.inner；state.intent / status、custom 中的自然语言与 narration.body 仍必须直接写简体中文普通话。innerZh 只翻译 inner，不得把 intent、status 或旁白混进去。');
    rules.push('- 输出协议前逐条扫描所有 mode=full 角色事件：msg.body、voice.text、private_msg.body、auto_reply.text、跨窗 line.body 与 state.inner 必须从第一个字起就是该角色的设定外语/方言；可见发言各自带完整中文 zh，state.inner 带完整中文 innerZh。发现中文原文、前中文后外语或外语中夹中文解释时，先改写正确再结束输出。');
  }
  return rules;
}

export function cleanProtocolPromptOverride(value = '', maxLength = 4000) {
  return String(value || '')
    .replace(/<<<\/?(?:THINKING|END_THINKING|MARSHMALLOW_CHAT_V2|END_MARSHMALLOW_CHAT_V2)>>>/gi, '')
    .trim()
    .slice(0, maxLength);
}

const NARRATION_SOUND_CATEGORY_HINTS = Object.freeze({
  kiss: '亲吻（唇瓣贴合、轻啄、分开时真实可闻的吻声）',
  fabric: '布料摩擦（衣料、被褥、沙发等确实发生的窸窣）',
  breath_soft: '平缓呼吸（贴近时可闻的轻呼吸、吐息）',
  breath_heavy: '较重呼吸（运动、哭泣、惊吓或明确喘息后的呼吸）',
  body_movement: '身体动作与接触（拥抱、贴近、抚触等可闻动静）',
  body_impact: '身体碰撞（确实发生的撞击、跌落或拍击）',
  footsteps: '脚步（走近、离开、停在门外等）',
  door: '门与门锁（推门、关门、落锁、门把转动）',
  wet: '持续湿润纹理（与 kiss 分开；只有非接吻的持续亲密动作成立时使用）',
  bgm_romantic: '浪漫暧昧背景氛围',
  bgm_calm: '平静陪伴背景氛围',
  bgm_night: '夜晚低落背景氛围',
  bgm_tension: '克制紧张背景氛围',
  bgm: '通用背景氛围',
  ambience_water: '浴室、水流与淋浴环境声',
  ambience_rain: '雨声环境',
  ambience_scene: '其他明确场景环境声',
});

const NARRATION_SOUND_FIELD_EXAMPLES = Object.freeze({
  kiss: '他低头吻住你，唇瓣贴合后才稍稍退开。',
  fabric: '他俯身靠近时，衣料在沙发边缘窸窣了一下。',
  breath_soft: '他停在很近的地方，轻缓的呼吸声落在你耳侧。',
  breath_heavy: '他撑住桌沿，急促的呼吸一时没有平复。',
  body_movement: '他伸手抱住你，沙发随着动作轻轻下陷。',
  body_impact: '他被撞得后退半步，肩背碰上门板。',
  footsteps: '脚步声由远及近，最后停在门外。',
  door: '门锁咔哒一声，他拧动门把手推开房门。',
  wet: '交缠动作持续着，结合处带出细碎的湿黏声。',
  bgm_romantic: '暖色灯影落在两人之间，气氛变得安静而暧昧。',
  bgm_calm: '室内很安静，两个人只是并肩坐着。',
  bgm_night: '夜色压低了窗边的光，房间里只剩沉静的呼吸。',
  bgm_tension: '短暂的僵持让空气绷紧，谁都没有先移开视线。',
  bgm: '背景音乐很轻，刚好填住交谈间的空隙。',
  ambience_water: '浴室里的水流声持续落在瓷砖上。',
  ambience_rain: '雨点不断敲着窗，远处偶尔滚过一阵闷雷。',
  ambience_scene: '咖啡馆里杯碟轻碰，远处的人声压得很低。',
});

const CUSTOM_NARRATION_SOUND_CATEGORY_RE = /^user_(?:cue|texture|background)_[a-z0-9]{6,48}$/u;

function isSupportedNarrationSoundCategory(id = '') {
  const key = cleanString(id);
  return !!NARRATION_SOUND_CATEGORY_HINTS[key] || CUSTOM_NARRATION_SOUND_CATEGORY_RE.test(key);
}

function normalizeNarrationSoundPlan(value = []) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,，、|]+/u);
  return prioritizeNarrationSoundCategories(values
    .map((id) => cleanString(id))
    .filter(isSupportedNarrationSoundCategory), { max: 3 });
}

export function buildRecentNarrationContinuityBlock(messages = []) {
  const recent = (Array.isArray(messages) ? messages : [])
    .filter((message) => (
      message
      && !message.deleted
      && !message.recalled
      && message.metadata?.narratorBeat === true
      && cleanString(message.content)
    ))
    .slice(-4)
    .map((message) => cleanString(message.content).slice(0, 220));
  if (!recent.length) return '';
  return [
    '【最近旁白动作账｜以下均已发生，不得换词重演】',
    ...recent.map((text, index) => `- 已发生 ${index + 1}：${text}`),
    '- 以上最后形成的位置、姿势、距离、接触和手中物件就是本轮起点。先判断本轮台词带来了什么新变化；没有新动作或状态变化时可以不写 narration，禁止把抬眼、靠近、指尖停顿、拥抱等旧动作换一组形容词再演一次。',
  ].join('\n');
}

function normalizeNarrationRepeatText(value = '') {
  return cleanString(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function narrationTrigramSimilarity(a = '', b = '') {
  const toSet = (value) => {
    const text = normalizeNarrationRepeatText(value);
    const out = new Set();
    for (let i = 0; i <= text.length - 3; i += 1) out.add(text.slice(i, i + 3));
    return out;
  };
  const aa = toSet(a);
  const bb = toSet(b);
  if (!aa.size || !bb.size) return 0;
  let shared = 0;
  for (const token of aa) if (bb.has(token)) shared += 1;
  return shared / Math.max(aa.size, bb.size);
}

export function suppressRepeatedNarrationEvents(events = [], recentMessages = []) {
  const references = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((message) => message?.metadata?.narratorBeat === true)
    .map((message) => cleanString(message.content))
    .filter(Boolean)
    .slice(-6);
  const kept = [];
  let suppressed = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.t !== 'narration') {
      kept.push(event);
      continue;
    }
    const body = cleanString(event.body || event.text || event.content);
    const normalized = normalizeNarrationRepeatText(body);
    const duplicate = normalized.length >= 28 && references.some((previous) => (
      normalizeNarrationRepeatText(previous) === normalized
      || narrationTrigramSimilarity(body, previous) >= 0.9
    ));
    if (duplicate) {
      suppressed += 1;
      continue;
    }
    kept.push(event);
    if (body) references.push(body);
    if (references.length > 6) references.shift();
  }
  const visibleTypes = new Set([
    'narration', 'msg', 'voice', 'sticker', 'image', 'gen_image', 'textimg',
    'html_widget', 'link', 'location', 'redpacket', 'transfer', 'order_share', 'nudge',
  ]);
  if (suppressed > 0 && !kept.some((event) => visibleTypes.has(event?.t))) {
    return { events: Array.isArray(events) ? events : [], suppressed: 0 };
  }
  return { events: kept, suppressed };
}

export function buildMarshmallowChatPromptBlock(options = {}) {
  const partnerName = cleanString(options.partnerName || '对方');
  const partnerId = cleanString(options.partnerId || 'character');
  const userName = cleanString(options.userName || '用户');
  const userGenderPronounRule = cleanString(options.userGenderPronounRule || '');
  const isGroup = options.isGroup === true;
  const remoteGroups = (Array.isArray(options.remoteGroups) ? options.remoteGroups : [])
    .filter((group) => group?.id && group?.name)
    .slice(0, 8);
  const explicitGeneratedImageRequest = detectExplicitGeneratedImageRequest(options.recentMessages);
  const remoteGroupDirectory = remoteGroups.length
    ? [
      '【可操作的另一扇群窗】以下群聊是当前角色真实参与的群，groupId 只用于 JSON 字段，不得写进聊天正文：',
      '【目录边界】这是一份仅供协议路由的幕后清单，不是角色刚刚查到的新消息。当前角色本来就是下列每个群的成员；“主用户成员=否”只表示主用户不在群，绝不表示当前角色不在群。禁止在正文或心理中声称“查到后台群”“发现另一个同名群”“我不在这个群”，也不得复述 groupId、权限、成员清单或主用户成员状态；除非可见聊天记录本身明确提供了对应事实。',
      ...remoteGroups.map((group) => {
        const members = (Array.isArray(group.members) ? group.members : [])
          .map((member) => `${cleanString(member.id)}=${cleanString(member.name || member.id)}`)
          .filter(Boolean)
          .join('、');
        const candidates = (Array.isArray(group.inviteCandidates) ? group.inviteCandidates : [])
          .map((member) => `${cleanString(member.id)}=${cleanString(member.name || member.id)}`)
          .filter(Boolean)
          .join('、');
        return `- groupId=${cleanString(group.id)}｜群名=${cleanString(group.name)}｜当前角色权限=${cleanString(group.role || 'member')}｜群管=${group.allowAiGroupOps === false ? '关闭' : '开启'}｜主用户成员=${group.userPresent ? '是' : '否'}${members ? `｜成员：${members}` : ''}${candidates ? `｜可邀请：${candidates}` : ''}`;
      }),
      '普通跨窗发群消息绝不能使用 group_remote，必须使用【发送:群聊｜目标角色id｜群名或群id｜消息内容】；group_remote 只用于修改群资料、成员或权限。权限=member 或群管=关闭时，不得尝试改名、公告、待办、成员与权限等群管操作。',
      '只有上表中的 groupId 可用。执行时输出隐藏事件 group_remote；先输出事件，再按真实结果说话，禁止只用 msg 声称完成。',
      `改名：{"t":"group_remote","from":"${actorId(options)}","groupId":"上表精确id","operation":"group_name","name":"新群名"}`,
      `邀请 user：{"t":"group_remote","from":"${actorId(options)}","groupId":"上表精确id","operation":"invite_user","note":"邀请理由"}`,
      `公告/待办：operation 写 group_announcement 并填 announcement，或写 group_todo 并填 todoAction="add"、text。`,
      `成员与权限：operation 可写 group_member（memberAction="add" 时 target 用“可邀请”精确 id，remove 时用现有成员 id）、group_admin、group_title、mute、group_transfer、vote_close。仍须服从权限：管理员不能转让群或设置管理员，普通成员不能群管。`,
    ].join('\n')
    : '';
  const characters = options.characters || {};
  const activeCharacter = characters[partnerId] || {};
  const activeVisibleName = isGroup
    ? (isAnonymousChat(options.chat)
      ? partnerName
      : (cleanString(options.chat?.groupSettings?.memberCards?.[partnerId])
      || cleanString(activeCharacter.name || activeCharacter.customNickname || activeCharacter.realName)
      || (isGenericPeerActorLabel(partnerName) ? '对应成员' : partnerName)))
    : partnerName;
  const actorReferences = buildChatActorReferenceTable(options.chat, {
    actorIds: partnerId ? [partnerId] : [],
    includeUser: (options.chat?.participants || []).includes('user'),
  });
  const stateDisabled = options.stateDisabled === true || options.innerVoiceDisabled === true;
  const allowAiReact = options.allowAiReact !== false;
  const actor = actorId(options);
  const translationLines = buildTranslationCore(options);
  const stateTranslationEnabled = (options.translationCharacters || []).length > 0
    || (options.mixedTranslationCharacters || []).length > 0;
  const activeFullTranslation = (options.translationCharacters || [])
    .find((item) => cleanString(item?.id) === cleanString(partnerId));
  const bubbleRangeEnabled = options.bubbleRangeEnabled === true;
  const bubbleRangeMin = Math.max(1, Math.trunc(Number(options.bubbleRangeMin) || 1));
  const bubbleRangeMax = Math.max(
    bubbleRangeMin,
    Math.trunc(Number(options.bubbleRangeMax) || bubbleRangeMin),
  );
  const customThinkingPrompt = cleanProtocolPromptOverride(options.thinkingPrompt);
  const useCustomThinking = options.thinkingPromptMode === 'custom' && !!customThinkingPrompt;
  const useClaudeLightThinking = options.thinkingPromptMode === 'claude-light';
  const useGeminiFlashDeepThinking = options.thinkingPromptMode === 'gemini-flash-deep';
  const customStatePrompt = cleanProtocolPromptOverride(options.statePrompt);
  const useCustomState = options.statePromptMode === 'custom' && !!customStatePrompt;
  const customStateExample = useCustomState ? ',"custom":{"自定义字段":"按本会话要求填写"}' : '';
  const userPresentInCurrentChat = !options.chat
    || (Array.isArray(options.chat?.participants) && options.chat.participants.includes('user'));
  const naturalUserStateReference = userPresentInCurrentChat
    ? (userName && !/^(?:用户|user|我)$/iu.test(userName)
      ? `聊天对象本轮现实称呼是「${userName}」；角色对用户说话、提到用户或在心里默念时优先使用这个称呼，也可沿用角色卡、关系设定，或用户明确要求/主动复用后真正形成的专属昵称。角色自己临时造过一次而 user 没有接住的称呼不算形成，不得因为它还在最近上下文里就继续叫；也不得改用用户的社交平台网名、论坛名、匿名 ID 或资料展示昵称。可以按角色习惯使用关系称呼、TA，或在脑内自然省略主语。${userGenderPronounRule || '用户资料没有明确给出性别或代词时，禁止根据名字、头像、关系、题材或语气猜测并改用“他/她”。'}`
      : `按角色习惯使用关系称呼、TA，或在脑内自然省略主语。${userGenderPronounRule || '用户资料没有明确给出性别或代词时，禁止根据名字、头像、关系、题材或语气猜测并改用“他/她”。'}`)
    : '当前窗口没有用户参与；按本窗口真实成员关系称呼对方，不得把用户当成收件人。';
  const absentUserGroupBoundary = isGroup && !userPresentInCurrentChat
    ? [
      '【无用户群聊 · 身份与称呼硬边界】当前群成员表里没有 user/U；只生成在群角色之间的消息，不得 @ 用户、向用户回话，或把用户写成正在看群的人。',
      '用户即使出现在某张角色卡的“与用户关系”或旧记忆里，也只是当前不在群的第三人。除非现有角色卡、成员间 relationships 或真实聊天记录明确给出，禁止凭恋爱关系、年龄、性别、群体玩笑或“某人的对象”自行派生嫂子、姐夫、弟妹、老板娘等亲属/辈分称呼。',
      '每位成员的短设定同样是硬设定，不因字数少就当作空白。开口前逐人回读自己的年龄、身份、性格、口吻及与其他成员的已知关系；不知道的称呼就用群名片/名字，不编辈分。',
    ].join('\n')
    : '';
  const stateCounterpartIdentityRule = userPresentInCurrentChat
    ? `- 当前聊天对象唯一绑定为 U=user「${userName}」。inner / intent 提到“刚发消息、正在回复、等回信、眼前这句话、你/对方”时，指的只能是「${userName}」；角色卡、关系网、世界书、记忆、语料和历史里出现的其他姓名一律是第三人，禁止借来称呼或代指当前聊天对象。输出前逐条自检一次人物指代。`
    : '- 当前窗口没有用户 U；inner / intent 里的“对方、你、刚发消息的人”只能指本窗口真实开口的角色，不得从角色卡、关系网、记忆或历史里借一个姓名冒充当前对话对象。';
  const realPersonThinkingAddon = options.realPersonModeEnabled === true
    ? [
      `真人感追加判断（必须做）：先判断此刻的回复欲与回复情绪——是很想立刻接、正常等一会儿、正忙想晚点接、说完仍守着等回音，还是这轮之后想放下手机。结合角色的日程/状态、关系、话题重要性和「${cleanString(options.realPersonFrequency || 'normal')}」频率档决定，不把所有日常都判成秒回或高表达。当前回合既然已经开始生成，就不要假装“刚才等了几分钟”；要决定的是这轮怎么回、说完后是否用 presence / wait_mood / next_reply_delay 安排下一拍。时差归因必须看最后一位真实发言者：最后一条若来自 user，就证明 user 已经回复、当前轮到角色，之后经过多久都只能算角色晚回或投递延迟，严禁反说 user“多久没回我/终于回了/怎么才回”；只有最后一条来自角色且其后没有 user 消息，才存在用户未回复。`,
      ...(bubbleRangeEnabled
        ? [`气泡硬范围先决：用户要求本轮 ${bubbleRangeMin}～${bubbleRangeMax} 条可见 msg，必须在这一次调用里完成。回复欲、表达欲、忙闲、留气口与人物寡言只决定每条说什么和多长，不得把整轮压到 ${bubbleRangeMin} 条以下，也不得把缺少的内容推给稍后追发。`]
        : []),
      '判断话题连续性：先完成对方这轮不可拖的回应义务——给出回答、边界、明确拒答或说明延后，再让同一话题下真实存在的理由、细节、联想与新鲜事按表达欲继续。不要为了“留气口”故意漏掉当前内容，也不要为了显得完整机械穷尽所有层次；具体长短与分条只服从【回复节奏 · 错落】。',
      '判断主动性与分享欲：先从人物设定判断 TA 本轮会不会主动；会，才从已给的世界书、关系资料、相关记忆、日程/当前状态和已见动态里找一件角色真会想到的素材，落成具体小事或细节、角色自己的态度、以及对方容易接的一点。现在分享、稍后 share_back、发动态、去别处互动和什么都不做都是候选，不因功能可用就选择。再检查精确引用、react、表情包、语音、图片、拍一拍、撤回改口或状态变化是否同时符合人物习惯与当前动机；动作服务人物，不做功能展览。',
    ]
    : [];
  const conversationExpansionThinkingAddon = [
    options.deepTalkEnabled === true
      ? '【深谈追加判断｜命中认真话题时才做】先按人物、关系、处境判断角色此刻是愿意展开、明确拒答、暂时延后还是带着内容回避；回避本身合法，不强迫角色亲密或诚实到底，但必须交出态度、边界、理由或真实内容，不能只剩惊讶、质疑和反问。检查 user 是否已经接住上一轮筹码、给出回应或让关系挪动：若已接住，本轮要消化新反应，顺势交出新内容或主动带一步，不得重新套回第一次的质疑、嘴硬和等待追问。分别确定话题可以谈多深、关系披露有多少既有证据；关系证据限制越级表白与承诺，不限制本轮观点、经历、细节和联想的表达量。若上一轮 intent 留有仍未散去的愿望、顾虑或未了立场，且 user 正沿原话题追问，本轮应消化并兑现相应新内容，不重置成开场反应，也不能再次用同一种含糊或延后拖过去。当前问题已回应、未了心思已改变或 user 转轻时，退出深谈防守姿态，重新按此刻表达欲和人物主动性聊天。组织可见表达前，再判断相邻内容是递进、并列还是真正冲突：递进和并列直接续写或换气口，不为制造层次强塞“不过/至于/但是/其实”“不是 A 而是 B”或正反两面；只有后一句确实修正、限制前句且符合人物语料时才转折。'
      : '',
    options.associationExpansionEnabled === true
      ? '【知识联想追加判断｜有自然切口时才做】从用户的具体词、画面、处境或情绪出发，找角色真会想到的知识、兴趣、作品、梗或比喻。职业设定不是默认切口：不要为了证明身份反复抛术语、行业比喻或把日常小事职业化；只有 user 已提到相关领域、眼前问题确实需要，或话题自然进入科普/深谈时才调用专业知识，并优先用日常话讲清楚。不要在离关键词最近的第一跳就停住：继续检查它牵着角色自己的哪些经验、社会关系、感官记忆、判断或态度；有真实表达欲就沿同一条路径落实并回扣眼前话题，不等追问替角色完成扩展。没有贴切路径就不扩，不把知识面变成功能展示。'
      : '',
    options.livedWorldExpansionEnabled === true
      ? '【生活世界追加判断｜当前话题有根时才做】检查它是否自然牵到某个已知的人或社交圈、家庭习惯、工作学习、城市时代、过去经历、双方差异或正在发生的生活线；聚焦一条路径，让具体细节继续牵出经历、知识、态度，再回到眼前的人或话题。写清它为什么会被这个角色此刻想到、现在说是否合适；本轮有成立的内容就落实，不用“留到以后”预先截短。人物关系与社会侧写只能用已知资料或谨慎补足低风险日常，不为扩张凭空造固定亲友和重大经历。'
      : '',
  ].filter(Boolean);
  const conversationExpansionStateRules = [
    options.deepTalkEnabled === true
      ? '- 深谈命中时，inner 只保留角色此刻真正冒出来、却没有直接说出口的那股反应、卡顿或私心；不要把“哪段经历被牵动、关系距离、披露尺度、边界选择”逐项盘点成决策摘要。深度来自具体而私人的念头，不来自覆盖更多分析维度；不得为了制造心声刻意扣住本来会说的内容，也不得凭空升级爱意或共同经历。'
      : '',
    options.deepTalkEnabled === true
      ? '- 若角色选择回避、拒答或延后，inner 可以自然冒出真实原因，但不要解释完整因果。若那件事确实仍压在心里，intent 只用角色脑内原句留下未了的愿望、顾虑或立场，例如“上次那件事，我还欠TA一个解释”；具体续谈内容、步骤与触发条件留在 THINKING，不使用“待续／触发”任务格式。不想继续就不伪造以后会说。同一件事被再次追问时，要么交出新内容，要么明确关题。'
      : '',
    options.associationExpansionEnabled === true || options.livedWorldExpansionEnabled === true
      ? '- 开启知识联想或生活世界扩展时，“钩子→依据→经验/关系/态度→怎样回扣”的路径只属于隐藏整理，禁止搬进 inner。inner 只保留这条联想实际改变了什么心情、判断或正在想的内容；具体画面、记忆与偏好必须已经存在于上下文或能由眼前事实直接推出，没有真实连接就不写。不要向自己解释素材为什么合适或准备怎样发送。可见消息有成立的内容就落实，user 接住岔口时继续往下走。'
      : '',
  ].filter(Boolean);
  // 开启角色翻译时，中文 inner 示例会强烈诱导弱模型无视后面的语言硬规则。
  // 此时只示范字段形状，并显式给出 innerZh 槽位；具体语言由逐角色规则决定。
  const stateExample = stateTranslationEnabled
    ? `{"t":"state","from":"${actor}","inner":"","innerZh":"","intent":"","status":"地铁上 快到站了","moodShift":1${customStateExample}}`
    : `{"t":"state","from":"${actor}","inner":"原来是这个。还真没想到。","intent":"","status":"地铁上 快到站了","moodShift":1${customStateExample}}`;
  const optimizedStateExample = stateTranslationEnabled
    ? `{"t":"state","from":"${actor}","inner":"","innerZh":"","intent":"","status":"地铁上 快到站了","moodShift":1${customStateExample}}`
    : `{"t":"state","from":"${actor}","inner":"原来是这个。有点意外。","intent":"","status":"地铁上 快到站了","moodShift":1${customStateExample}}`;
  const legacyThinkingBody = useCustomThinking
    ? [
      '按以下用户自定义步骤完成角色化决定摘要；总计不超过 320 字，不展开长篇推理、不提前写最终台词：',
      THINKING_START,
      '人物设定优先：即使使用自定义步骤，每个决定也要先由角色卡、语料、关系和当前处境提供依据；下文规则与动作只作候选参考，不能反过来塑造人物。',
      customThinkingPrompt,
      ...conversationExpansionThinkingAddon,
      ...realPersonThinkingAddon,
      THINKING_END,
    ]
    : useClaudeLightThinking
      ? [
        '【Claude 轻量整理】按五段完成紧凑的角色决定摘要，总计不超过 700 字；每段只写本轮真正命中的判断，不复述规则、角色卡或聊天记录，不列无关可能性，不提前写最终台词。',
        THINKING_START,
        '1) 人物与处境：从角色卡、语料、身份和当前状态中只取本轮最相关的 1～3 条证据，说明这些证据怎样决定 TA 先注意什么、在意或回避什么、会用怎样的语气和气口。承接此刻地点、手头事情、时间、上一轮 state 与已经发生的动作；已兑现、失效或被打断的盘算及时更新，不机械续写，也不凭空补过去经历。',
        '2) 对方与回应：识别这句话正在实施的互动（正事、玩笑、抗议、试探、请求或随口分享），并让它更新角色对局面的理解。由人物决定回答、拒答、略过、岔开或稍后再接；不复述关键词、不把原话改成问句，也不为证明理解而补安慰、追问或总结。',
        `3) 关系与内外差：按已有共同经历和当前关系判断距离、把握程度、愿意披露多少，以及哪些只留在 inner。观点和个人经历可以充分表达，但定向亲密、排他、承诺和关系升级必须有明确证据；没有就保留不确定或现阶段边界。嘴上表达与心里盘算要有真实信息差，同时避免把角色写成全知、统一恋爱模板或通用高情商人格。${options.deepTalkEnabled === true ? ' 深谈时分别判断话题能谈多深与关系能走多近；上一轮已有待续且本轮被追问时，应兑现新内容或明确关题，不能换措辞继续拖延。' : ''}`,
      `4) 表达与动作：依据人物原本的句长、用词、标点、停顿、吐槽和自我克制习惯，确定本轮表达欲、信息量、自然分条及是否使用语音、引用、react、图片、表情、拍一拍或撤回；动作必须同时符合人物习惯和当前动机，什么都不用也成立。${options.associationExpansionEnabled === true || options.livedWorldExpansionEnabled === true ? ' 有自然切口时只选一条最贴人物的知识、经历、关系或生活路径展开，并带回眼前话题，不做功能展示。' : ''}${options.realPersonModeEnabled === true ? ' 真人感模式还要区分回复欲与表达欲，判断回复后的 presence、wait_mood 或 next_reply_delay；忙闲可以改变回复时机与选择，不能替角色虚构一个回避理由。' : ''}${bubbleRangeEnabled ? ` 用户已硬性限定本轮 ${bubbleRangeMin}～${bubbleRangeMax} 条可见 msg；先组织足够的真实内容与独立气口达到下限，再在上限内收束，不得少发、超发、复述或空拆。` : ' 条数由角色实际想表达的内容与自然气口决定，不为显得真人而机械忽长忽短。'}`,
        `5) 收口自检：做一次换人测试——若台词、心声和动作换给别的角色仍成立，回到人物证据重写。再检查是否复读、说教、只问不答、套公共网感腔、沿用已经失效的盘算、越过关系证据、替用户发言或决定行动、串用别人的记忆与隐私；引用是否真在消除指向歧义，略过或回避是否来自人物而非漏读。${translationLines.length ? ' 所有外语或方言可见正文逐条带合格的简体中文 zh；开启翻译的角色若用外语/方言写 state.inner，同条带合格 innerZh。' : ''}通过后立即输出正式协议。`,
        THINKING_END,
      ]
    : [
      '隐藏整理是回复前的角色化决定摘要：按下面顺序把真正影响本轮的判断做完，不要求机械凑固定行数，也不要为了短而漏掉关系、意图、动作或承接；不复述规则、不写模型分析和最终台词。',
      THINKING_START,
      '0) 人物锚定：先回读角色卡、语料、身份年龄、关系位置与当前状态，找出本轮最能决定反应的 1～3 条人物证据，并把证据落实成具体选择：TA 会先注意哪个点、愿意交出或避开什么、会用怎样的词句与气口。不能只抄“温柔、成熟、冷淡”等标签；年龄、职业和关系位置不自动生成性格、语气词或口癖。后续每个决定都要能回答“为什么是 TA 会这样做”；通用规则、动作能力、节奏范例和群聊岗位都只是候选工具，没有人物证据就丢弃。',
      '1) 处境与承接：角色此刻在哪、在做什么、刚发生了什么；对照上文日程、时间、上一轮 state 与尚未兑现的小心思，已经发生、兑现、被打断或失效的内容要更新，不能原样续写。若上文提供了相关记忆、相似互动或过去状态，回想这个人上次在类似处境里怎么反应、这次有什么相同与变化；只用实际给出的内容，不编造“以前也这样”。',
      '2) 关系：与对方现在走到哪、距离多远，最近在升温还是降温；再问一句 TA 对这个判断有几分把握——感情里没有全知，拿不准、患得患失、误判或嘴上不认都是真实答案。关系未设置只代表缺少标签，不代表暧昧留白；没有共同经历或明确关系证据时，按尚未建立亲密关系处理。关系称谓只是位置，不自动等于热烈、占有、脸红或围着对方转。',
      '3) 读点：判断对方这句话正在做什么——求助、抗议、试探、接梗、认真求看法、只是随口，还是话里另有没直说的部分；区分对方真正说出或做出的内容，与界面只提供的按钮、选项和词库，可供选择不等于已经选择。至少保留一个同样符合现有事实的其他读法，再由人物自己的注意力、意愿和处境选择回答、略过、拒答、岔开或稍后回收，不数点、不逐项闭环。',
      '4) 角色反应：依据第 0 步的可追溯人物证据，先判断这是轻松小事、普通交流、重要话题，还是已有事实支持的冲突，再决定会不会激起情绪或联想、强度多大、TA 会外露多少。年龄、职业、能力、地位及模型熟悉的类型印象只算待验证假设；至少说明一条具体性格、表达习惯、行为经验或双方相处史怎样造成这次反应。把“有多少内容想表达”“愿意披露多少敏感真话”“愿意把多少内容指向与 user 的关系”分开判断。再回想角色卡明确写明、或对方已经主动复用/明确接纳的惯用称呼、语气、停顿、吐槽、自我克制和玩笑边界；临时昵称、比喻或冷梗不能仅凭出现过就升级成惯用语。',
      '5) 意图与主动性：用人物自己的逻辑写清 TA 此刻真正想维护、得到、避开或完成什么，并决定这轮回答、拒答、略过、稍后接回，还是带着内容岔开。刻意回避当前明显话题时，在 inner 用一句人物化念头记下真正原因；只是没注意或没兴趣的点不必强编理由。首轮或关系证据不足时，不得同时完成承认在意、定向 user、关系定性和未来承诺。普通聊天默认先在当前窗口完成；线下见面、跨窗调度、取消日程和其它持续行动，只有本轮明确请求、当前事实或此前未了动机直接支持时才成为候选。人物确实想扩展时，再从世界书、关系、记忆、日程与当前状态中找贴题素材；没有就不硬编，也不为展示主动性或功能而强行展开。',
      ...conversationExpansionThinkingAddon,
      `6) 表达形状与错落：先写此刻表达欲及原因（上头、平、蔫、被戳中、正忙、憋着事、懒得打字），以及真正想表达的内容；表达欲高时把已有内容说到位，表达欲低时可以只留一个低信息反应、边界、局部真话，也可以自然转向别处，低表达欲不自动等于反问对方。再按自然气口决定是一句钉住、碎着追发、文字、语音，还是安静停住。${options.variedRhythmEnabled === true ? '只判断最近几轮的形状是否显得重复，不复述也不计算历史条数；即使重复，也禁止按“上一轮多则本轮少”的方式机械换挡。' : ''}${bubbleRangeEnabled ? `用户已硬性限定本轮 ${bubbleRangeMin}～${bubbleRangeMax} 条可见 msg；这不是软建议，必须先组织足够的真实内容与独立气口达到下限，再在上限内收束。` : '最终条数是内容自然分拆的结果，不是事先选定的配额。少条不等于漏接，长也不等于写成一整块作文。'}`,
      ...realPersonThinkingAddon.map((line, index) => `${index + 7}) ${line}`),
      options.realPersonModeEnabled === true
        ? '10) 真人感动作选择与落地：先按人物习惯排除 TA 不会用的动作，再从剩余候选里判断是否需要精确引用、react、表情包、短语音、图片、拍一拍或 recall；什么都不做是正常答案。上文提醒“很少出现”只代表可想起，不代表应补用。说重了、说错了、手滑或发完后悔时，若人物真会撤回，才用 recall 后重发或安静撤掉；只能撤自己的可撤消息。'
        : '7) 聊天动作选择：先按人物习惯排除 TA 不会用的动作；再检查剩余的精确引用、react、表情包、语音、图片、拍一拍或其它能力是否贴合本轮动机，什么都不用完全合法。说重了、说错了、手滑或发完后悔时，若人物真会撤回，才考虑 recall 后重发或安静撤掉；只能撤自己的可撤消息。',
      `${options.realPersonModeEnabled === true ? '11' : '8'}) 反证与自检：先写出一个最可能推翻当前人物解读的理由，以及眼前事实允许的最低戏剧性回应；自检必须尝试否定方案，不能只宣布“符合人设”。若当前方向主要靠身份、类型印象或抽象气质成立，回到第 0／4 步；若把界面选项当成对方已作出的选择，回到第 3 步；若把轻互动扩张成未请求的线下、跨窗、日程改变或关系升级，回到第 5 步。再做换人测试和人物口吻默念，检查复读、说教、公共网感腔、用户侧代写、串人、隐私和关系权限；仅因规则提到某项动作而使用时删除。${options.realPersonModeEnabled === true ? '最后核对回复欲与表达欲是否被误写成同一件事，以及 presence / wait_mood / next_reply_delay 是否与本轮决定一致。' : ''}${translationLines.length ? '逐条检查外语正文都带合格简体中文 zh。' : ''}`,
      THINKING_END,
    ];
  const compactThinkingAddons = [
    options.deepTalkEnabled === true
      ? '命中认真话题：先交出回答、局部真话、人物化拒答或清楚边界；连续追问时新增真实内容或明确关题，不用反问与延期循环。'
      : '',
    options.associationExpansionEnabled === true || options.livedWorldExpansionEnabled === true
      ? '有自然切口时，只选一条最贴人物的知识、经历、关系或生活联想，形成具体内容并回到当前话题；没有就不扩展。'
      : '',
    options.realPersonModeEnabled === true
      ? `真人感：把回复欲和表达欲分开；结合日程、状态、关系与 ${cleanString(options.realPersonFrequency || 'normal')} 频率决定本轮内容和回复后的 presence / wait_mood / next_reply_delay，不为展示功能制造动作。`
      : '',
  ].filter(Boolean);
  const optimizedThinkingBody = useCustomThinking
    ? [
      '按用户自定义步骤完成角色决定回执，总计不超过 320 字；不复述设定、规则或聊天记录，不提前写最终台词：',
      THINKING_START,
      '所有结论先由角色卡、语料、关系、记忆与当前处境提供依据；动作和通用写法只作候选。',
      customThinkingPrompt,
      ...compactThinkingAddons,
      THINKING_END,
    ]
    : useGeminiFlashDeepThinking
      ? [
        '【Gemini Flash 深描整理 · 测试】以全量内置思维链为骨架，为 Flash 系列补足人物解析、关系动态、情绪因果与表达落地。按 1–15 依次检查，总计不超过 1900 字；每项给出本轮具体结论及其人物依据，不能只把标题换一种说法。无相关证据的项写“本轮不构成变量”后略过，不为填满检查表编造内容。所有检查只留在 THINKING，不得搬进 inner、intent 或 msg；不复述聊天全文，不提前拟最终台词。',
        '【方法示范 · 只学推导密度，不得复用事件、性格或措辞】同样收到“一张做歪的小点心照片”：人物甲若重视准确、说话克制，又知道对方是在开心分享，第一注意点可以是形状，第一反应是被逗到，第二力量是不想扫兴；候选方向可以是轻轻指出细节并交出自己的失败经历，或只问制作过程。人物乙若爱热闹、常把日常夸张成小剧场，可能先注意对方的得意，把它读成邀请一起玩，候选方向则会落在共同想象。两者的差异来自证据→注意→评价→情绪→选择，不来自替换姓名、身份物件或固定口号；示范没有给出成品台词，本轮也不得沿用其中任何素材。',
        THINKING_START,
        '【第一段：事实、人物与此刻处境】',
        '1) 证据台账：只提取会改变本轮判断的事实，并分别标明来源——用户明说、历史已发生、角色设定、当下可见。用户没交代的时间空白、行为、动机和情绪属于未知；角色可以猜，但要保留“这是我的猜法”。',
        '2) 人物锚定与第一注意点：从角色卡、语料、个人经历和双方相处史中选出本轮最有决定力的 1～3 条可追溯证据，并回答“这个人第一眼被什么绊住，为什么偏偏是它”。至少一条依据必须是具体表达习惯、行为经验或关系记忆；年龄、职业、财富、能力、社会位置及模型熟悉的类型印象只能作为待验证假设，不能单独产出语气。若换给另一位同身份人物仍成立，继续回读人物。',
        '3) 此刻坐标与连续性：确认角色的时间、地点、身体精力、手头事、上一轮 state、未散的心思和上一件事的余波。区分仍在持续、已经兑现、被打断与已经失效的内容；只有真正影响注意力、耐心或表达的部分才进入本轮，不凭职业标签自动生成工作场景。',
        '4) 话语解读与输入权限：区分对方真正说出或做出的内容、界面只提供的按钮／选项／词库、语气动作、可能的言外之意和仍不能确定的部分。可供选择不等于已经选择，出现亲密词也不自动构成现实邀请或关系许可。至少保留一个合理的其他读法；玩笑、逞强、求回应、分享欲和单纯陈述都须结合证据判断。',
        '【第二段：人物纵深、关系与情绪现场】',
        '5) 关系基线与位移：把关系视为共同经历形成的动态历史。比较过去基线、最近趋势与本轮刺激，判断信任、亲近、戒备、亏欠、主动程度或边界是否真的移动；分别写清已发生事实、角色目前判断、角色希望成真的部分和把握程度，不能用“恋人／朋友／上下级”等标签替代推导。',
        '6) 人物纵深：沿“长期在意什么 → 此刻被触发什么 → 因而冒出什么倾向”连成因果，再检查自我形象、价值判断、旧经验、责任或禁区是否形成第二股力量。两股力量可以同向、拉扯或只有一股；没有依据就保持简单，不为显得深刻硬造创伤、秘密和反差。',
        '7) 事件分量与情绪因果：先判断这是随手玩笑、普通交流、重要话题，还是已有事实支持的冲突或边界问题，再写“刺激 → 角色主观评价 → 第一情绪／身体感受 → 行动冲动 → 牵制它的力量 → 此刻的微小转化”。反应强度必须同时得到事件分量与人物触点支持；随后才写角色怎样暂时感知对方情绪，不把感知当读心。',
        '8) 私人牵挂、披露与界限：此刻 TA 真正想要、抗拒、期待或仍放不下什么；再把“有多少内容想表达”“愿意披露多少私人真话”“愿意把多少内容指向双方关系”分开判断。话题可以谈得很深，关系披露仍须已有证据；把最终私心写成角色承认给自己的普通愿望或顾虑，保持与眼前互动相称。',
        '9) 自身生活、记忆与主动线：检查角色在用户消息之外仍持续着什么日程、关系网、兴趣、旧印象和未完议题。本轮若自然牵到其中一条，说明它为什么此刻浮起、带来什么具体内容或态度、现在是否真的想分享；没有连接就不插播素材，也不让角色退化成只负责理解和照顾对方的镜子。',
        ...conversationExpansionThinkingAddon,
        ...realPersonThinkingAddon,
        '【第三段：把内部现场落实为一次回应】',
        '10) 候选决定与主动性：提出至少两个真正不同、都符合人物的回应方向，例如直答、反驳、玩笑、分享自己、追问、保留、岔开、延后或沉默。每个方向都写明它满足了角色哪项真实意愿、舍弃了什么，再选择最贴合人物、事件分量和关系位置的一个；比较的是内容与态度，不是同一句话逐级加重，也不默认最礼貌或最快收尾。',
        `11) 表达欲与可见形状：先写角色此刻表达欲及原因，再确定本轮抓住哪一两个重点、是否加入自己的新内容，以及情绪怎样落在选词、句长、断句、气口、追发、停顿、改口或安静停住上。低表达欲仍应给出成立的反应、边界或局部真话，高表达欲把已有内容说到位；诗意、毒舌、温柔、幽默都只在人物本来会这样说时出现。${bubbleRangeEnabled ? ` 可见 msg 必须为 ${bubbleRangeMin}～${bubbleRangeMax} 条。` : ''}`,
        `12) 回复时机与连续性：区分回复欲、表达欲和话题是否仍在继续；先完成本轮不可拖的回答、边界、拒答或明确延后，再决定说完后是否还守着等回音。${options.realPersonModeEnabled === true ? ' presence、wait_mood 与 next_reply_delay 必须与日程、忙闲、关系和本轮决定一致；最后一条来自 user 时，当前轮到角色，不能反说成 user 迟迟没回。' : ' 不为制造气口故意漏掉当前内容，也不把已经结束的话题机械续上。'}`,
        '13) 动作与发送过程：从人物习惯和当前动机出发，逐一判断精确引用、react、表情包、语音、图片、拍一拍、状态变化或什么都不用。手滑、歧义、嘴快、心虚、后悔或后起念头确实发生时，才保留半句、追发、改口或 recall；动作服务人物，不做功能展览。',
        '14) 反证与最小充分反应：写出一个最可能推翻当前人物解读的理由，并给出眼前事实允许的最低戏剧性回应。若所选方向主要靠身份、类型印象或抽象气质成立，回到第 2 项；若把按钮词当成对方已作出的选择，回到第 4 项；若把轻互动扩张成未被请求的线下见面、跨窗调度、取消日程或关系升级，除非当前事实与人物持续动机都提供直接依据，否则退回只在当前聊天内成立的回应。自检必须尝试推翻方案，不能只宣布“符合人设”。',
        '15) 字段分流与终检：事实、推导、候选方向和表达设计留在 THINKING；inner 用角色第一人称脑内视角，只取尚未整理成策略的一股私人心理流；intent 只取角色已察觉的单一愿望、抗拒、期待或余留立场，必须回答“我现在想要／不想要什么”，回复策略、争取效果和动作计划留在 THINKING；status 只写真实地点与手头事，msg 只写真正发出的话。最后做事实归属、关系权限、人物指代、镜头测试、无观众测试与换人测试：动作归 status，展示给观众看的心声改回角色本人自然会想的话；若换人仍成立，回到第 2 项；若反应比事情更重，回到第 7 项。',
        THINKING_END,
      ]
    : [
      `${useClaudeLightThinking ? '【轻量角色整理】' : '【角色决策检查】'}按下列检查点得出本轮决定，总计不超过 ${useClaudeLightThinking ? '520' : '650'} 字。可以显示编号与结论，但每项只处理一个问题；不逐句复述聊天，不提前写最终台词。`,
      THINKING_START,
      '1) 事实与未知：只列出一至三个会改变回应的已知事实；用户未说明的时间空白、行动与动机标为未知。角色可以猜测、调侃或误判，但必须知道那是 TA 的猜法，不写成系统已证实的事实。',
      '2) 人物触发：回读角色卡、语料、此刻状态与上轮余念。至少找出一条来自具体性格、表达习惯、个人经历或双方相处史的依据，说明这个人为什么先注意这一点、心里第一下是什么。年龄、职业、财富、能力与社会位置只能补充经验和处境，不能单独产出台词；若目前的依据换给另一位同身份人物仍成立，就继续回读人物。',
      '3) 关系与理解：现有关系允许 TA 说到哪里，角色对用户语气和言外之意的理解有多大把握。区分用户明说、可见线索和角色自己的读法；误读可以保留，不能假装全知。',
      '4) 输入权限、事件分量与情绪：区分用户真正说出或选择的内容与界面提供的选项；可供选择不等于已经选择。先判是真实冲突／边界，还是玩笑、互动邀请或普通交流；称呼、小游戏和调情本身不构成高低位竞争。反应强度由事实、人物触点与关系积累决定；轻松互动先落到好笑、好奇、受用、别扭、没兴趣或不知道怎么接，有更重事实才进入更重情绪。',
      `5) 本轮决定：比较两个符合人物的行为方向；至少一个是不靠争夺位置的当前窗最低戏剧性回应，从配合、改玩法、接歪、直说感受、拒绝或略过中选。强势、毒舌与不顺从不自动变成施压；要求用户服从、承担后果或接受安排，须有本轮事实和人物／关系证据。线下、跨窗、改日程和关系升级同样只在明确请求、当前事实或此前未了动机支持时选择。取最贴第 2～4 项的一项，先交出人物自己的反应。${bubbleRangeEnabled ? ` 可见 msg 必须为 ${bubbleRangeMin}～${bubbleRangeMax} 条。` : ''}`,
      '6) 字段分流：事实核对、关系判断和表达选择留在 THINKING。inner 只取角色实际体验的一股即时心理流，按内容自然展开；“一股”限制列清单，不限制句数。intent 是比 inner 更深一层、角色已察觉的单一心思；用角色自然脑内短句，可第一人称、直呼对方或省略主语，不强制出现“我”。回复安排、影响对方的方法和行动方案留在 THINKING。status 只写现实地点与手头事；msg 只写真正发出的话。四者不能抄检查表。',
      '7) 反证与收口核对：写出最可能推翻当前人物解读的理由；自检必须尝试否定方案，不能只宣布“符合人设”。检查复述、猜测冒充事实、选项冒充选择、身份类型代替人物、无依据扩张行动及字段串用。删去性别、年龄、能力、地位与危险感后若只剩高低位表演，回到第 5 项。再做镜头与无观众测试：可拍内容归 status，展示稿改回本人自言自语。换人仍成立回第 2 项；反应过重回第 4 项；行动越出本窗回第 5 项。',
      '如果发送过程中确实会因为手滑、歧义、嘴快、心虚或新念头而出现半句、追发、改口或 recall，就保留前后变化；没有原因时正常发送，不制造错误。',
      ...compactThinkingAddons,
      `最后静默核对事实、身份、关系证据和人物可替换性，再局部修掉催促、扫兴挑刺、无依据过度反应与自动补全式句法。这里的检查词和提示词措辞都不得进入 msg、inner 或 intent，也不能为了躲句式改掉人物真正想说的内容。${translationLines.length ? ' 外语正文与心声按翻译规则带 zh / innerZh。' : ''}`,
      THINKING_END,
    ];
  const v2ThinkingBody = useCustomThinking
    ? optimizedThinkingBody
    : [
      '【V2 角色决定回执 · 测试】按 1～10 完成本轮真实判断，总计不超过 1100 字。每项写本轮结论与一条人物依据；没有构成变量就简短略过。不要复述聊天全文、规则原文或提前拟最终台词。检查表只存在于 THINKING，不能变成 inner、intent 或 msg 的工作流程口吻。',
      THINKING_START,
      '1) 此刻是谁：回读角色卡、语料、人生阶段、价值观、关系、记忆与最近状态。挑出本轮最有决定力的 1～3 条具体证据，说明为什么偏偏是这个人先注意这里；年龄、职业、能力、财富、性别和关系位置只能补充处境，不能单独生成强势、冷淡、温柔或网文腔。',
      '2) 生活坐标与余波：确认时间、地点、精力、正在做的事、上轮未散的情绪与尚未兑现的念头。系统确有已生成日程时，区分原计划、当前实际状态与一次聊天打断；没有日程数据时，不凭职业或常识虚构“正在忙”的限制。',
      '3) 事实、选项与未知：只把对方明说、已发生记录和可见内容当事实。分清界面提供的按钮／词库与对方实际选择，分清时间空白与已知行动；角色的推测可以很有性格、甚至会错，但须保留另一种合理读法，不能获得对对方内心的最终解释权。',
      '4) 注意与第一情绪：不要平均处理全部信息。写出最先绊住角色的一点、角色怎样评价它、收到消息前的情绪基线，以及刺激后第一下真实变化；再检查此前承诺、被略过但仍在意的话、得到认可的事或正在发生的生活是否仍占注意。',
      '5) 情绪纵深：沿“刺激 → 人物评价 → 情绪或身体感受 → 想靠近／回避／表达／保护什么 → 哪股自尊、责任、恐惧或现实事务牵制它”形成因果。可以简单，也可以有两股力量；事件很轻时保持轻，不为深度制造创伤、占有、危险感和戏剧性。',
      '6) 关系与长期动力：现有共同经历允许说到哪里，最近关系如何变化，角色对此有几分把握。检查此刻是否真有想分享、想了解、想展现自己、想靠近或暂时拉开距离的动力；关系越重要越可能出现不确定、说错、找补和想继续了解，不等于必然掌控、照料或告白。',
      '7) 自身世界与内容：从日程、兴趣、关系网、旧记忆、眼前细节和未完议题中，只取被本轮自然触发的一条，说明它给回复带来什么具体选择、态度或可分享内容。没有连接就不插播；有连接时让角色给出自己的东西，而不是只负责分析、安慰或采访对方。',
      '8) 行为候选：提出至少两个都符合人物、但方向真正不同的回应，例如配合、接歪、直答、分享自己、承认卡住、温和或尖锐地拒绝、暂缓、改口。至少一个是当前窗口内的最低充分反应。对抗、施压、要求负责、线下到场、取消工作和关系升级，只有本轮事实与持续动机直接支持时才可选；选择最贴人物与事件分量的一条，不按“谁更有魅力或更占上风”决定。',
      `9) 外放与发送：决定真实想表达的内容、愿意披露多少、情绪会怎样改变选词、句长、断句、追发、停顿或收住；再判断引用、react、表情包、语音、图片、recall 或什么都不用。错误、撤回和找补只在发送过程中真有因果时出现。${bubbleRangeEnabled ? ` 可见 msg 必须为 ${bubbleRangeMin}～${bubbleRangeMax} 条。` : ''}`,
      '10) 反证与字段分流：写出最可能推翻当前解读的理由，并给出眼前事实允许的最低戏剧性方案。若删掉身份标签后只剩控制、征服、回避或通用温柔，回到 1／8；若反应比事情更重，回到 5。THINKING 留事实、推导和方案；inner 留一股未经整理但可自然纵深的私人心理流；intent 留角色已承认的更深愿望、抗拒、期待或舍不得；status 只写真正地点与手头事；msg 只写真正发出的话。',
      ...compactThinkingAddons,
      `最后静默检查：人物不可替换性、理解的不确定、关系权限、生活连续性、动作与心理分流、回复是否带来角色自己的内容。外语正文与心声按翻译设置填写 zh / innerZh；不得把检查词写给对方看。`,
      THINKING_END,
    ];
  const knowledgeRoutingThinkingAddon = isGroup
    ? [
      '【群聊知情路由 · 必做】只写来源标签和事件短名，不复述私聊原句，也不把这份账本搬进 inner、intent 或 msg。',
      'GROUP_KNOWLEDGE：先列 PUBLIC=本轮开始前已经真实出现在当前群公屏、或明确向全群公开的相关事实；再按本轮可能开口的精确角色 ID，简列 OWN=只属于该角色的私聊／记忆／经历、UNKNOWN=与本轮有关但属于其他角色的私有信息。只列会影响本轮的角色与事件，不为凑表穷举。多个角色资料被技术性放进同一 prompt，不等于彼此知情；关键词命中只说明检索到了素材，不证明任何角色目击、收件或参与。',
      '随后按预计 JSONL 顺序逐条校验 `#序号 from=角色ID <- public / own:同一角色ID / round_更早序号`。角色只能使用当前 PUBLIC、自己同 ID 的 OWN，以及本轮更早位置已经实际发到公屏的可见 msg／事件；另一角色的 state、inner、intent、未发送草稿和私有块永不因同轮生成而公开。只有持有人先在可见公屏明确说出，后续角色才可从对应 round_序号承接。若某句找不到合法来源，就改由真正知情者说、改成猜测／询问，或删除；不得让角色精准复述、影射或据此行动。',
    ]
    : options.crossWindowSourceCheckRequired === true
      ? [
      `【私聊来源归属 · 必做】用一行 SOURCE_CHECK 简记本轮关键事实来自当前私窗、${actor} 自己的记忆／亲历，还是带持有人或可见范围标签的跨窗回注；不复述回注原句。关键词命中只负责找回相关片段，不证明当前角色看见、收到或参与。当前主回复角色 ${actor} 只能使用本窗已发生内容、自己的资料，以及明确标注其参与／知情的群聊或幕后记录；专属于其他角色的私窗、记忆、inner、intent 只能在生成那个精确 from 的跨窗事件时供对应角色使用，不能偷渡进 ${actor} 的 msg/state。来源或可见范围拿不准时，保留为猜测、开口询问或不用。`,
      ]
      : [];
  const selectedThinkingBody = useGeminiFlashDeepThinking
    ? optimizedThinkingBody
    : options.promptProfile === 'v2' || options.v2PromptEnabled === true
      ? v2ThinkingBody
      : options.lightweightPromptEnabled === true
        ? optimizedThinkingBody
        : legacyThinkingBody;
  const thinkingBody = [];
  for (const line of selectedThinkingBody) {
    if (line === THINKING_END) thinkingBody.push(...knowledgeRoutingThinkingAddon);
    thinkingBody.push(line);
  }

  const legacyStateRules = useCustomState
    ? [
      `- state 每轮先于该角色首条发言：${stateExample}。私聊一条；群聊每个真正开口角色各一条，顺手插话可极简。`,
      `- state 是角色自己的自然心声，不得复读提示词里的身份标签：inner / intent / status 禁止把聊天对象称作“用户”、user、“用户姓名”“用户+显示名”或“真实用户+姓名”。${naturalUserStateReference}`,
      stateCounterpartIdentityRule,
      '- 角色明知对方在问却刻意回避时，inner 用一句简短、贴人物的念头交代真正原因；只是注意力没落在某点、顺手略过或没有回复冲动时不必解释，禁止为每个没接的点强编心理原因。',
      '- state 的 from 与 JSON 类型是固定协议；用户要求的其它内容写进 custom 对象。custom 的键和值都用简短纯文本，不输出 HTML，不把 custom 泄进 msg。每个发言角色自己的 state.custom 都必须完整包含本会话要求的全部字段，不能只给群里第一个人生成、不能复用别人的内容，也不能把字段散落到 state 顶层。',
      '[用户自定义心声与状态要求]',
      customStatePrompt,
      stateTranslationEnabled
        ? '- 【心声语言硬规则】state.inner 必须跟随上方该角色的外语/方言翻译设置：mode=full 直接写设定语言原文并同条填 innerZh；mode=mixed 自然出现外语/方言时才填 innerZh。intent、status 及 custom 中的自然语言仍直接写简体中文普通话。'
        : '- 【隐藏状态语言硬规则】state.inner、intent、status 以及 custom 中所有自然语言字符串必须直接使用简体中文普通话；不输出 zh / innerZh。',
      '- 上述要求覆盖内置心声写法，但不能删除 state、from 或改变 JSONL 协议；未要求的固定字段可留空。',
      '- 群聊结束输出前，逐一核对本轮所有 msg.from：每个不同的角色 id 都必须已有且仅有一条同 from 的 state，并且每条 state.custom 都通过了上述字段完整性检查；发现缺人或缺字段时先补齐，再输出结束标记。',
    ]
    : [
      `- state 每轮先于该角色首条发言：${stateExample}。私聊一条；群聊每个真正开口角色各一条，顺手插话可极简。`,
      `- state 是角色自己的自然心声，不得复读提示词里的身份标签：inner / intent / status 禁止把聊天对象称作“用户”、user、“用户姓名”“用户+显示名”或“真实用户+姓名”。${naturalUserStateReference}`,
      stateCounterpartIdentityRule,
      '- 角色明知对方在问却刻意回避时，inner 用一句简短、贴人物的念头交代真正原因；只是注意力没落在某点、顺手略过或没有回复冲动时不必解释，禁止为每个没接的点强编心理原因。',
      stateTranslationEnabled
        ? '- 【心声语言硬规则】state.inner 必须跟随上方该角色的外语/方言翻译设置：mode=full 直接写设定语言原文并同条填 innerZh；mode=mixed 自然出现外语/方言时才填 innerZh。intent、status 及 custom 中的自然语言仍直接写简体中文普通话。'
        : '- 【隐藏状态语言硬规则】state.inner、intent、status 以及 custom 中所有自然语言字符串必须直接使用简体中文普通话；不输出 zh / innerZh。',
      '- inner=角色本人没有说出口的脑内话，不是 <<<THINKING>>> 的摘要、回复理由、素材清单或行动报告。它使用角色自己的第一人称脑内视角：外语以 I / my 等自然自指形成，中文直接用“我”或按口语省略主语；不是旁白从外面描述这个角色。inner 没有观众，不负责证明角色聪明、成熟、危险、深情或“很会想”；写 TA 此刻确实还在心里想的内容，让它沿本轮真正有分量的一处自然走下去。细腻来自人物经历、眼前处境、关系历史与情绪之间确有联系，不来自把因果解释给观众；只使用上下文已经提供或能够直接推出的细节，禁止凭空补一个标点习惯、饮食偏好、旧事、物件或场景来假装具体。优先服从最近 msg 与角色语料里的思维语言；如果这段 inner 换一个角色仍成立，就重写。',
      '- inner 不追求完整覆盖本轮心理材料。一个最占注意力的念头就可以成立；同一股念头自然牵出关系余波、回忆、矛盾、联想或态度变化时，也可以继续数句，直到自然心理气口。“一股”限制的是不要逐项清点和补齐分析链，不限制纵深或句数。确实没有更多心理内容时可以很短或留空；已经存在的内容不得为了显得简洁而压成一句、半句，也不要依次交代“观察到什么→推测对方怎样→我有什么素材→准备怎么做→为什么这样最合适”。',
      '- inner 与本轮 msg 要有自然信息差，但不是把隐藏整理或可见回复删剩的要点全部回收。可以是没敢说的真话、尚未成形的联想、说完以后才浮起的别扭，或一句很私人却不需要解释的反应；不要把 msg 换个说法再想一遍，也不要把“接下来发什么、何时发、是否催回复、怎样让对方接话”写进 inner 或 intent，这些明确安排只属于 THINKING。',
      '- inner 不以复述对方关键词开场，也不负责证明自己理解了多少。需要回想到对方原话时，只保留真正勾住角色的那一小处，让下一念沿人物自己的情绪、经验、偏心或矛盾继续；禁止“原文关键词＋评价”逐项梳理。',
      '- inner 的细腻不是小说镜头和油腻气质。低笑、挑眉、眯眼、胸腔震动、慢条斯理的动作、猎物／筹码／弹药／粉碎掌控等外部表演全部删除或移入确有必要的 status；“危险、黑暗、慵懒、胜券在握”不能代替这个人真正想了什么。',
      ...conversationExpansionStateRules,
      '- 情绪激烈的回合最容易滑进八股：「谁敢碰 TA」「TA 是我的」这类占有欲狠话模板，「呵」「有意思」这类霸总腔，一律禁止。愤怒、吃醋、心痛也要用 TA 自己的话想；情绪越强越要贴这个人，而不是切换成通用的“狠人模式”。',
      '- inner 不是另起一种神秘旁白口吻：不要为了表现内心就统一写成抒情、悬疑、反问或省略号转折。冷淡的人冷着想，直白的人直白想，嘴硬的人嘴硬想，稳的人先稳住，话少的人也应把真正存在的念头写到位。',
      '- inner 的情绪表达必须先过角色性格基线：年龄、关系位置、职业、成熟、寡言与高自控不是同一种人格，也不自动意味着压住反应、拐开话头、反问试探或固定留白。角色明确会克制时，写清 TA 具体压住了什么、仍准备交出什么；角色本来直白、幼稚、热烈、笨拙或爱分享时，即使年上也照其本人表达。不要自动切换成脸红心跳、占有欲爆发或“嗯？＋看破不说破”的公共模板。',
      '- 关系词不是情绪强度词，情绪波动值也不是心声丰富度：暗恋、暧昧、恋人只说明关系位置和潜在张力；moodShift 小只表示这一轮没有剧烈起伏，不能据此删掉角色对关系、记忆、言外之意和自身反应的细腻认知。',
      '- inner 不是分析报告：不列条目，不写“首先/其次/因此/所以接下来”式推理，也不按时间、证据、方案、风险、结论的顺序复盘。用角色平时会在脑中使用的自然句法，把这一股心理写到它真正停下；可以连贯成段，也可以很短，禁止把“细腻”固定演成碎句、连续反问、自我打断、三段转折或省略号。只有前后念头确有不同原因时才转念，不用“也许／算了／不对／别自作聪明”之类的固定纠偏制造层次。',
      '- inner 只能写心理内容，禁止动作、表情、神态、姿势、环境、旁白或正在做什么；这些只能放进 status。',
      '- 角色不必完全理解自己，但有限自知要从这个人眼下真实的矛盾里显出来，不必每轮安排一次自我否定、故意走神或没有来由的改口。不要把“注意点→联想→情绪→辩解→修正”当固定路线：持续的担心、清楚而不动摇的判断、被触及的旧情绪、尚未说出的愿望或普通的一念都可以单独成立。有哪一层写哪一层；角色已经承认给自己的愿望、抗拒、期待或余留立场放 intent，回复盘算与系统判断留在 THINKING。',
      '- inner 默认把话想完、用句号或不加标点收尾，不靠省略号留白；“……”只有在该角色平时本来就爱用、且此处确实是话卡住时才偶尔出现，一条 inner 至多一次。',
      '- inner 避免通用恋爱模板和廉价比喻，如“心跳漏一拍”“谁顶得住”“像小猫一样”“完了”“救命”；只有角色本人会这么想、这么说时才可用。',
      '- 字段名虽然叫 intent，本应用把它作为“心思”展示：inner 是角色此刻实际经历的心理，intent 是其下方角色已经察觉的那一股更深趋向——此刻心底究竟偏向什么、舍不得什么、抗拒什么或仍认定什么。它不是回复意图、行动方案、内容提纲或给对方设计的钩子；没有这样一股心思就留空。',
      '- intent 必须像角色自己脑内会自然闪过的话，可以是完整第一人称，也可以对对方直呼或按角色口语省略主语；不要求机械出现“我”。每轮只保留一股深层心思，不用“先／再／顺便／同时／然后”串联回复动作。若它只说明回复措辞、接话安排、预期效果或具体操作，就仍是 THINKING 里的方案，直接留空。通常是一口能想完的短句，但不硬性限字数，也不套固定句型。',
      '- intent 与 inner 分工：intent 放角色已经承认的那一股私心，inner 保留尚未承认或还没想透的反应；不要互相换词复述。跨轮可以自然保留未散的愿望、抗拒或期待，但具体待办、步骤和触发条件只留在 THINKING。',
      '- intent 可以是人物脑内自然成立的“抓住你了”“这次可不想放过”一类短念头，也可以更迟疑、更日常；合法性来自它确实揭出愿望、偏心、抗拒或舍不得，而不是句型本身。若只是“用这句话反击／看看对方反应／夺回主动权”，仍是回复策略，留在 THINKING。',
      '- 心声与小心思只在 state 里各写一次，绝不能泄进 msg，也不要逐条复述。',
      '- status=回消息时的真实场景：TA 是在做什么事的途中回的这条——地点、手头的事、进行到哪，如“地铁上 快到站了”“锅上还炖着东西”“开会摸鱼中”“刚洗完澡在擦头发”。日程是原计划：没有更新鲜的聊天场景时，它才是默认现实锚点；聊天里已经发生改变时，角色知道自己只是暂时偏离计划，应先延续当前 status，连续约 45 分钟没有新聊天场景后再按届时日程自然接回。短时停下、抽空回复或几分钟插曲不改计划；但若本轮可见 msg/旁白已经把角色写到与当前日程不兼容的地点，并展开做饭、照顾人、出行等会持续占用该时段的动作链，这已经是真正改安排，必须同轮输出 schedule_change，禁止只写新剧情却让旧日程继续显示。连续几轮可以让同一件事自然推进（刚点外卖→外卖到了→吃完瘫着），比每轮硬换新动作更像生活。',
      '- status 禁止“在回消息”这类废话状态（正在回消息不用报，要报的是回消息之外生活正进行的那件事），不要抽象情绪词，也禁止小说式神态特写（“攥紧手机骨节泛白”“眼神瞬间冷了下去”是旁白不是状态）；情绪激烈时仍写具体处境，如“停下手里的事在打字”“来回看这条消息”。',
      '- status 优先延续上一轮的地点与正在进行的事；只有它确实自然进展时才微调同一场景里的小动作。现实只过了几秒/几分钟且没有转场依据时，原样沿用也完全合法，禁止为了避免复读而硬推进、换房间或另起一件事。',
      `- 真实场景与顶栏联动：若本轮 state.status 相比上一轮发生有效转场——换地点、开始/结束一件事、忙闲改变，或上线/离线/暂离——必须同轮再输出 status 事件。presenceState 按 online / away / busy / offline 选择；statusText 写角色在新场景下会公开的一句心情、吐槽或念头，不得照抄地点和活动。同一场景里的小动作变化不触发，也不要为了换顶栏硬造转场。${options.statusStoryMode === true ? '本会话已开启状态小剧场：每次因有效转场输出 status 时，必须在同一个 status 事件附上 story，具体展开这次转场正在发生的幕后片段；不能只改状态而漏掉小剧场。' : ''}`,
      '- 冲突/情感爆发轮的 state 对照——差（全是小说八股，禁止）：status“猛地攥紧手机骨节泛白，眼神瞬间冷了下去”、inner“谁敢碰 TA”；好：status“停下手里的事在打字”、inner“那个人最好给我个解释”、intent“我还不想把这事闹大”（好的版本情绪一样重，但每个字段都还像这个人）。',
      '- moodShift 是本轮情绪波动的增量（整数 -20..20），只衡量变化幅度，不控制 inner 的长度、细腻度或是否值得写。普通寒暄、想念、玩笑常是小幅变化；明确冲突、告白、重大误会才可能放大。角色越稳，数值波动越克制；玩笑通常是好笑/无语而非大幅负向。',
      '- 群聊结束输出前，逐一核对本轮所有 msg.from：每个不同的角色 id 都必须已有且仅有一条同 from 的 state；发现缺人时先补齐，再输出结束标记。',
    ];
  const stateLanguageRule = stateTranslationEnabled
    ? '- inner 跟随该角色的外语/方言设置：full 时写原文并带 innerZh，mixed 时仅在实际使用外语/方言时带 innerZh；intent、status 与 custom 使用简体中文。'
    : '- inner、intent、status 与 custom 中的自然语言使用简体中文，不输出 zh / innerZh。';
  const optimizedStateRules = useCustomState
    ? [
      `- 每个本轮开口角色在首条发言前输出且只输出一条 state：${optimizedStateExample}。例句只演示字段形状；intent 留空表示没有明确私心时必须留空`,
      '- state.from 使用该角色引用。inner / intent / status 不把聊天对象叫作“用户”或 user；称呼服从角色卡、关系和本轮真实对象。',
      stateCounterpartIdentityRule,
      '- inner 使用角色自己的第一人称脑内视角，是未说出口、尚未整理好的即时心理流；外语以 I / my 等自然自指形成，中文直接用“我”或按口语省略主语。长度跟真实心理内容走，不写成旁白、回复理由、行动报告或可见台词改写。',
      '- intent 作为“心思”展示：只收比 inner 即时反应更深一层、角色已察觉的单一心思。用角色自然脑内句，可第一人称、直呼对方或省略主语，不要求出现“我”；回复安排和行动方案留在 THINKING。没有就留空。',
      '- custom 必须完整包含本会话自定义字段，键和值用简短纯文本；每个群成员各写自己的内容。',
      '[用户自定义心声与状态要求]',
      customStatePrompt,
      stateLanguageRule,
      '- 自定义要求不能删除 state/from 或改变 JSONL；群聊结束前核对每位发言角色都有且仅有一条 state。',
    ]
    : [
      `- 每个本轮开口角色在首条发言前输出且只输出一条 state：${optimizedStateExample}。这只演示 JSON 形状；intent 留空表示没有明确私心时必须留空`,
      '- state.from 使用该角色引用。inner / intent / status 不把聊天对象叫作“用户”或 user；称呼服从角色卡、关系和本轮真实对象。',
      stateCounterpartIdentityRule,
      '- inner 使用角色自己的第一人称脑内视角。外语心声以 I / my 等自然自指形成；中文直接用“我”或按口语省略主语。它是本人正在想，不是旁白从外面描述这个角色。',
      '- inner 没有观众，不是在表演“心声感”：围绕此刻真正占住注意力的一处，按角色原本的思维句法自然想下去。词汇、句长、吐槽和克制方式服从已有语料；可以是一段连贯的想法，也可以只是很短的一念。',
      '- inner 只写心理。逐句做镜头测试：摄像机能拍到的动作、表情、视线、姿势、环境、地点和手头事全部归 status；身体感觉可以想，身体动作不写进 inner。',
      '- inner 的长度跟真实心理内容走。轻松的一下不必强加心理转折；确有关系余波、回忆、矛盾或态度变化时可以继续数句，不限制纵深和句数，也不为追求短而压成一句或半句。只有前后念头确有不同原因时才转念，禁止为了显得细腻固定切碎、连续反问、自我否定或用省略号制造层次。',
      '- inner 只取最占注意的一股心理流；无论用户这轮发了几条，都不需要逐条证明自己看见了。角色可以暂时没想明白或判断错误，但不必每轮安排跑偏、自我反驳和想到一半；不把 THINKING 的核对过程和回复方案重新讲一遍。',
      '- 人物不可替换性来自内在因果：这个人为什么在意，它碰到哪段已有经验、处境或关系。只写上下文已提供或能直接推出的内容；不额外摆职业物件、固定爱好、熟人或招牌梗，也不凭空发明标点习惯、饮食偏好、旧事、物件或场景。',
      '- 轻松玩笑、亲密邀请和成人话题先按这个人此刻实际出现的好笑、好奇、受用、尴尬、兴奋、不喜欢或界限来想，保持与眼前这一小刻相称；只有已有经历真的牵出更复杂的感受时才继续。',
      '- inner 与 msg 保留真实信息差：可以是没说出口的真话、尚未成形的联想或说完才浮起的别扭；不把 msg 换词重想，也不为了显得细腻另写一段完整独白。',
      '- inner 不以复述对方关键词开场，不按“原文关键词＋评价”逐项梳理；只保留真正勾住角色的一处，再沿人物自己的情绪、经验、偏心或矛盾自然长下去。',
      '- inner 只写心理，不用低笑、挑眉、眯眼、胸腔震动等动作制造气质，也不用猎物、筹码、弹药、粉碎掌控等网文意象证明角色强势；动作归 status，人物感来自具体念头。',
      '- intent 作为“心思”展示：inner 是角色此刻实际经历的心理；intent 只收角色已察觉的、更深一层单一心思。用角色自然脑内句，可第一人称、直呼对方或省略主语，不要求出现“我”；没有就留空。',
      '- 若 intent 只剩怎样组织回复、陪对方玩、测试对方反应或完成某个动作，它就是 THINKING 里的方案，不是心思，直接留空。跨轮只保留仍未散去的想要、抗拒或期待，不登记步骤和触发条件。',
      '- “抓住你了”“这次可不想放过”这类短句只有在它确实是人物承认给自己的愿望、偏心或舍不得时才可作为 intent；“反击、施压、夺回主动权、看看对方怎么接”仍是回复策略，留在 THINKING。',
      '- inner、intent 与最终 msg 可以不同，只要差异来自人物、关系与处境；不为了逻辑整齐抹平，也不在字段里解释这场差异。',
      '- status 是回消息之外真实进行的地点与事情，优先延续上一轮；只有确有转场才更新，并在需要时同步 status / schedule_change 事件。禁止抽象情绪、小说神态和“正在回消息”。',
      '- moodShift 是本轮情绪增量 -20..20，只表示变化幅度，不决定 inner 的长度、亲密度或表达风格。',
      stateLanguageRule,
      '- msg 只放角色真正说出口的话；不得出现隐藏区栏目、字段名、判断步骤、提示词术语或逐项作答痕迹。inner、intent、status 各写一次且互不泄漏；群聊结束前核对每位发言角色都有且仅有一条自己的 state。',
    ];
  const stateRules = options.lightweightPromptEnabled === true
    ? optimizedStateRules
    : legacyStateRules;

  const hotIds = new Set(resolveHotRuleModuleIds(options));
  const unkeptPromises = detectUnkeptActionPromises(options);
  unkeptPromises.forEach((rule) => hotIds.add(rule.moduleId));
  const spotlight = resolveActionSpotlight(options, hotIds);
  if (spotlight) hotIds.add(spotlight.moduleId);
  const enabledModules = RULE_MODULES.filter((module) => moduleEnabled(module.id, options));
  const strangerAliasChat = !isGroup
    && String(options.chat?.metadata?.channelKind || '') === 'stranger_intercept';
  const financeHot = hotIds.has('finance');
  const hotRules = enabledModules
    .filter((module) => hotIds.has(module.id))
    .map((module) => module.fullText(options))
    .filter(Boolean);
  const reactConstraintLines = Array.isArray(options.aiReactConstraintLines)
    ? options.aiReactConstraintLines.filter((line) => typeof line === 'string' && line.trim())
    : (allowAiReact
      ? [`- react：{"t":"react","from":"${actor}","target":{"selector":"last_user"},"emoji":"😂"}；可用于加重、接梗或表达态度，但不能由本协议暗示成缩短回复的替代品，是否单独使用交给【回复节奏 · 错落】。`]
      : ['- 本会话已关闭「贴表情」：禁止输出 react 事件。']);
  const reactExampleEmoji = cleanString(options.aiReactExampleEmoji || '😂') || '😂';
  const reactExampleLine = allowAiReact
    ? `{"t":"react","from":"${actor}","target":{"selector":"last_user"},"emoji":"${reactExampleEmoji}"}`
    : '';
  const narrationMode = options.narrationMode === true;
  const crossWindowLinkageEnabled = options.allowCrossWindowLinkage !== false
    && (options.chat?.groupSettings?.allowSocialLinkage === true
      || options.allowPrivateSend === true);
  const narrationSoundEffectsEnabled = narrationMode
    && options.narrationSoundEffectsEnabled === true;
  const availableNarrationSoundCategorySpecs = (
    (Array.isArray(options.availableNarrationSoundCategories)
      ? options.availableNarrationSoundCategories
      : [])
      .map((item) => {
        if (item && typeof item === 'object') {
          const id = cleanString(item.id);
          return {
            id,
            label: cleanString(item.label || id),
            hint: cleanString(item.hint || NARRATION_SOUND_CATEGORY_HINTS[id] || ''),
            mode: cleanString(item.mode || ''),
          };
        }
        const id = cleanString(item);
        return {
          id,
          label: id,
          hint: NARRATION_SOUND_CATEGORY_HINTS[id] || '',
          mode: '',
        };
      })
      .filter((item) => isSupportedNarrationSoundCategory(item.id))
  ).filter((item, index, rows) => rows.findIndex((candidate) => candidate.id === item.id) === index);
  const availableNarrationSoundCategories = availableNarrationSoundCategorySpecs.map((item) => item.id);
  const availableNarrationSoundCategorySet = new Set(availableNarrationSoundCategories);
  const customNarrationSoundCategories = availableNarrationSoundCategorySpecs
    .filter((item) => /^user_(?:cue|texture|background)_/u.test(item.id));
  const hasNarrationTextureCategory = availableNarrationSoundCategorySpecs.some((item) => (
    item.mode === 'texture'
    || ['wet', 'fabric', 'body_movement', 'body_impact'].includes(item.id)
    || /^user_texture_/u.test(item.id)
  ));
  const narrationSoundModeLabel = (mode = '') => {
    if (mode === 'texture') return '持续纹理';
    if (mode === 'background') return '背景循环';
    return '单次声音';
  };
  const availableNarrationSoundGuide = availableNarrationSoundCategorySpecs.length
    ? `当前库中实际可调用的分类只有：${availableNarrationSoundCategorySpecs.map((item) => {
      const description = item.hint || item.label || item.id;
      const mode = item.mode ? `，混音方式=${narrationSoundModeLabel(item.mode)}` : '';
      const heading = item.label && item.label !== item.id ? `${item.label}：` : '';
      return `${heading}${description}${mode}（sound="${item.id}"）`;
    }).join('；')}。未列出的分类本轮视为没有素材，不要为了它补声音描写或 sound。`
    : '当前库没有已启用且可播放的分类；保持自然叙事，不要为了音效额外补声音关键词。';
  const narrationSoundExampleCategory = availableNarrationSoundCategories[0] || '';
  const narrationSoundFieldExample = narrationSoundExampleCategory
    ? JSON.stringify({
      t: 'narration',
      body: NARRATION_SOUND_FIELD_EXAMPLES[narrationSoundExampleCategory]
        || '这一刻确实发生了与当前动作相符的可闻声音。',
      sound: [narrationSoundExampleCategory],
    })
    : '';
  const voicePerformanceModeEnabled = options.voicePerformanceModeEnabled === true;
  const voiceProvider = options.voiceProvider === 'fish' ? 'fish' : 'minimax';
  const fishVoicePerformance = voiceProvider === 'fish';
  const voiceWorldBookNaturalPauses = options.voiceWorldBookNaturalPauses !== false;
  const voiceWorldBookSubtleEmotion = options.voiceWorldBookSubtleEmotion !== false;
  const voiceWorldBookText = cleanProtocolPromptOverride(options.voiceWorldBookText, 6000);
  const dialogueVoiceWorldBook = voicePerformanceModeEnabled
    ? buildVoiceWorldBookPrompt(VOICE_WORLD_BOOK_SURFACES.DIALOGUE, {
      customText: options.voiceWorldBookActive === true ? voiceWorldBookText : '',
      heading: '语音演绎模式',
      provider: voiceProvider,
    })
    : '';
  const exampleSpokenBody = fishVoicePerformance
    ? (activeFullTranslation ? '…' : '靠近一点，我只告诉你。')
    : (activeFullTranslation ? '…' : '你先坐。');
  const exampleSpokenZh = activeFullTranslation ? ',"zh":"……"' : '';
  const exampleSpeech = voicePerformanceModeEnabled
    ? (fishVoicePerformance
      ? `,"speech":{"text":"${exampleSpokenBody}","emotion":"neutral","pace":"slow","intensity":0.15,"direction":"whispering softly at close distance, restrained and natural"}`
      : `,"speech":{"text":"${activeFullTranslation ? '(inhale)…' : '(inhale)你先坐。'}","emotion":"neutral","pace":"normal","intensity":0}`)
    : '';
  const exampleFollowupBody = activeFullTranslation ? '…' : '外面风大，等会儿再出去。';
  const exampleFollowupZh = activeFullTranslation ? ',"zh":"……"' : '';
  const exampleFollowupSpeechText = activeFullTranslation
    ? (voiceWorldBookNaturalPauses ? '…<#0.2#>' : '…')
    : (voiceWorldBookNaturalPauses ? '外面风大，<#0.2#>等会儿再出去。' : '外面风大，等会儿再出去。');
  const coreMsgBodyFields = activeFullTranslation
    ? '"body":"…","zh":"……"'
    : '"body":"说出口的话"';
  const coreMsgSpeechText = activeFullTranslation ? '…' : '说出口的话';
  const narrationExampleOpen = narrationMode
    ? '{"t":"narration","body":"走廊的感应灯亮到第三盏，雨水顺着伞骨滴在门垫上。"}'
    : '';
  const narrationExampleInterlude = narrationMode
    ? '{"t":"narration","body":"他把杯子推到桌角，空出来的手按住被风掀起的菜单。"}'
    : '';
  const recentNarrationContinuityBlock = narrationMode
    ? buildRecentNarrationContinuityBlock(options.recentMessages)
    : '';
  const voicePerformanceModeRules = voicePerformanceModeEnabled
    ? [
      '【语音演绎模式｜隐藏表演轨】',
      '- 本轮每条角色 msg 都必须带 speech；narration 只作为可见旁白，不得带 speech，也不提供朗读。speech 只供用户点角色气泡播放，不改变气泡展示文字，也不代表现在生成音频。',
      fishVoicePerformance
        ? '- Fish 固定格式：speech={"text":"body 原文或在真实发生位置插入一个声音提示后的全文","emotion":"neutral|happy|sad|angry|fearful|surprised|disgusted","pace":"slow|normal|fast","intensity":0～1,"direction":"简短英文自然语言表演指导"}。direction 通常不超过 24 个英文单词，没有必要时留空。'
        : '- MiniMax 固定格式：speech={"text":"在 body 原文中插入少量语音标签后的全文","emotion":"neutral|happy|sad|angry|fearful|surprised|disgusted","pace":"slow|normal|fast","intensity":0～1}。',
      '- speech.text 去掉语音标签后必须与同事件 body 逐字一致：禁止加词、删词、改写、翻译、补语气词或把 inner/status/动作说明混进来。没有合适表演时直接复制 body，emotion 用 neutral、pace 用 normal、intensity 用 0。',
      voiceWorldBookNaturalPauses
        ? (fishVoicePerformance
          ? '- Fish 的主要控制写进 direction；局部声音提示仅限 (breath) (inhale) (exhale) (gasps) (pant) (sighs) (laughs) (chuckle) (coughs) (clear-throat) (humming) (emm)。不要使用 <#...#>，Fish 不保证执行精确秒数。'
          : '- 可用换气与拟声标签仅限：(breath) (inhale) (exhale) (gasps) (pant) (sighs) (laughs) (chuckle) (coughs) (clear-throat) (humming) (emm)，精确停顿用 <#0.1#>～<#0.8#>。标签不属于可见台词。')
        : '- 当前关闭「自然停顿」：禁止加入 <#...#> 精确停顿标签；确有场景证据时仍可克制使用换气或拟声标签。',
      voiceWorldBookSubtleEmotion
        ? '- emotion 是方向，intensity 才是力度：日常、亲密、暧昧、吃醋、认真或调情式不满通常为 0.15～0.35；明确争吵、喊叫、惊吓、哭泣或失控才可超过 0.75。相邻气泡默认承接前一条，普通变化不要超过 0.2。'
        : '- 当前关闭「轻微情绪」：emotion 固定 neutral、intensity 固定 0，不用情绪参数额外推高表演；pace 仍可按真实说话速度选择。',
      '- 浪漫互动里的严肃、占有欲、嘴硬和压低声线不等于强 angry；可以用低 intensity 表示细微方向，但不要把整句突然演成激昂发火。只有正文和场景都明确发生真实冲突时，才使用高强度 angry。',
      fishVoicePerformance
        ? '- Fish 只有在正文或上下文明确出现贴近、压低声音、怕被听见或只说给对方听时，才用 whispering softly / in a close quiet whisper；普通亲密对话不是全程耳语。禁止 direction 使用 growling、snarling、roaring、booming、thunderous 等低吼、咆哮或舞台腔，严肃与张力优先写 restrained、low and controlled、quietly tense。'
        : '',
      fishVoicePerformance && narrationSoundEffectsEnabled
        ? '- 紧邻明确亲吻动作前后的角色台词，要承接角色自身真实的呼吸变化：可在 direction 写 slightly trembling / breathy and unsteady / a small catch in the breath，并在真实气口最多放一个 (breath)、(inhale) 或 (exhale)。只有旁白已明确写出喘息、气息失稳或骤然反应时才用 (pant)/(gasps)；不要把环境亲吻音、另一人的声音或旁白读进 speech。'
        : '',
      '- 角色声线与表演层必须分开：年龄感、共鸣位置、口音、基础音高和音色始终是同一个人；只让语速、力度、呼吸、停顿和情绪方向连续变化，禁止用突然换腔、拔高音调或每条重置情绪制造“丰富”。',
      '- 把本轮多条 msg 当作同一次连续开口，先安排一条完整呼吸曲线：需要时开头入气，中段在长句、犹豫或动作后换气，结尾收住、吐气、叹息或轻笑。气泡边界可以留下换气间隔，但不能每个气泡都重新深吸气。',
      '- 先按人物、当下身体状态、距离、动作、情绪强度和这句话的真实气口设计表演。轻声、贴近、松弛、犹豫、长句重新开口或 ASMR 感适合时，应比普通朗读更积极地选用自然呼吸，不要因强调克制而全部省略。短句合适时可选 1 个，多句或长段通常可在两个不同气口各用 1 个；仍不要每句都喘、笑或叹，pant/gasps 仅在奔跑、哭泣、惊吓、疼痛或明确喘息等场景证据成立时使用。',
      '- 声音提示按生理动作选择：(inhale)=开口前吸气，(breath)=自然换气，(exhale)=松下一口气，(sighs)=疲惫或无奈，(chuckle)=压低的笑气；(pant)/(gasps) 只承接真实喘息或骤然受惊。丰富来自类型和位置准确，不来自堆叠数量。',
      '- 情绪与换气要落在真正发生变化的位置：笑声不能替角色笑，呼吸不能凭空制造暧昧，停顿不能切断词组、姓名、数字或紧密语义。多条气泡之间保持连续表演，不要每条都重新深吸气。',
      '- 真正卡顿、找词或改口时可以选一次 (emm)，它更接近“呃……”而不是表示回应、赞同或若有所思的“嗯……”；只是犹豫、吞回半句或隔着省略号重新开口时，优先用停顿、(breath) 或 (exhale)。轻声笑气用 (chuckle)。只加隐藏声音标签，不得给 speech.text 凭空补可见台词里没有的汉字语气词，也不要连续堆叠多个过渡音。',
      '- body 已经写了独立的“呃……”或“哈……”时，不再额外补同类标签；合成阶段会把它们分别按卡顿音或轻笑处理。body 里的“嗯……”保留原本应声语义，不要擅自替换成 (emm)。',
      fishVoicePerformance
        ? '- body 中间已有连续省略号时，用标点与 direction 描述 small pause / hesitating / restarting softly；重新开口确实需要换气时才加一次 (inhale) 或 (breath)。不要伪造精确停顿标签，也不要让每个省略号都喘。'
        : '- body 中间已有连续省略号时，speech 要让犹豫或重新起句听得出来：只是停住思考时使用克制的精确停顿；停顿后像重新换一口气开口时，可用一次 (inhale) 或 (breath)。不要给句首句尾省略号机械补提示，也不要让每个省略号都喘。',
      dialogueVoiceWorldBook,
    ].join('\n')
    : '';
  const anonymousChat = isAnonymousChat(options.chat);
  const actorReferenceLines = actorReferences.rows.map((row) => {
    if (row.id === 'user') {
      return `${row.ref} → user → 用户「${userName}」`;
    }
    const character = characters[row.id] || {};
    const name = anonymousChat
      ? ''
      : (cleanString(options.chat?.groupSettings?.memberCards?.[row.id])
        || cleanString(character.name || character.customNickname || character.realName || ''));
    return `${row.ref} → ${row.id}${name ? ` → 角色「${name}」` : ' → 角色'}`;
  });
  const activeActorReference = actorReferences.refFor(partnerId) || actor;
  const hasUserReference = actorReferences.refFor('user') === 'U'
    && actorReferences.rows.some((row) => row.id === 'user');

  return [
    `[输出协议 ${MARSHMALLOW_CHAT_PROTOCOL}]`,
    '先输出极简隐藏整理块，再输出协议块；除此之外不要写 Markdown、解释、普通对白或 <think>。协议块每个非空行必须是独立合法 JSON。',
    strangerAliasChat
      ? `【陌生拦截窗格式硬墙】马甲身份只改变「说什么」，绝不改变输出协议。仍须使用角色真实 id=${actor} 填 from；转账、红包、语音、图片、撤回、拍一拍等必须输出对应 JSON 事件，禁止写成自然语言说明、Markdown、方括号卡片或把 JSON 塞进 msg.body。`
      : '',
    actorReferenceLines.length
      ? [
        '【本轮身份短引用 · 所有身份字段优先使用】',
        ...actorReferenceLines,
        `本轮 JSON 的 from / actor / senderId、上表内成员 target、memberIds、subjects 与跨窗 lines[].from 使用 U/C1/C2…短引用；系统会在校验后换回真实 ID。短引用只准出现在 JSON 身份字段，msg.body 里点名必须写群名片或真实可见称呼，严禁把 @C3、C2、“群成员”等协议占位直接发给用户。邀请上表外联系人时仍按对应规则使用其真实 ID。${hasUserReference ? 'U 永远是用户，绝不是角色。' : '本窗口没有用户 U；禁止代写 user。'}`,
        '长 ID 只需在上表认一次，不要在每条事件里反复抄。显示名、昵称或备注名若重名，裸名字一律视为歧义，禁止凭顺序、口吻或上下文猜人。',
      ].join('\n')
      : '',
    `${hasUserReference ? `U 代表用户「${userName}」；` : 'user 不在本窗口；'}${activeActorReference} 代表当前主角色 id=${partnerId}（${activeVisibleName}）。提到用户本人用「${userName}」，不要把 U/user 当称呼。用户侧禁止代写；${narrationMode ? '可见场景动作进 narration，角色离屏状态进 status，' : '动作只进 status，'}心理只进 inner。`,
    absentUserGroupBoundary,
    options.parallelWorldMode === true
      ? '【强覆盖·平行世界】只能网聊；transfer/redpacket/order_share/offline_invite 均不可用，也不得承诺见面、寄东西或写成同处一地。'
      : (options.longDistanceMode === true
        ? '【强覆盖·异地】offline_invite 不可用；不得写已在楼下、立刻过去或已碰面。转账、红包、寄快递仍可用。'
        : ''),
    options.isGroup === true
      ? ''
      : (remoteGroupDirectory
        || '【跨窗群操作】当前没有可验证的目标群。对方要求邀请入群、改群名或管理群时必须说明无法确定哪一群，禁止口头假装完成。'),
    '',
    '【Tier 0｜隐藏整理与核心】',
    ...thinkingBody,
    recentNarrationContinuityBlock,
    '',
    '（以下只演示 JSONL 字段格式，不示范本轮气泡数量、断句长度或群聊开口人数。）',
    MARSHMALLOW_CHAT_START,
    narrationExampleOpen,
    stateDisabled ? '' : stateExample,
    `{"t":"msg","from":"${actor}","body":"${exampleSpokenBody}"${exampleSpokenZh},"reply":{"selector":"last_user"}${exampleSpeech}}`,
    narrationExampleInterlude,
    narrationMode
      ? `{"t":"msg","from":"${actor}","body":"${exampleFollowupBody}"${exampleFollowupZh}${voicePerformanceModeEnabled
        ? (fishVoicePerformance
          ? `,"speech":{"text":"${exampleFollowupBody}","emotion":"neutral","pace":"normal","intensity":0.1,"direction":"calm and natural, with a small pause between phrases"}`
          : `,"speech":{"text":"${exampleFollowupSpeechText}","emotion":"neutral","pace":"normal","intensity":0}`)
        : ''}}`
      : '',
    reactExampleLine,
    MARSHMALLOW_CHAT_END,
    '',
    '核心事件：',
    `- msg：{"t":"msg","from":"${actor}",${coreMsgBodyFields}${voicePerformanceModeEnabled ? `,"speech":{"text":"${coreMsgSpeechText}","emotion":"neutral","pace":"normal","intensity":0}` : ''}}。body 只写可见台词；日常通常一句或一个完整气口一条，反应、解释、补充、改口或新的情绪落点另起一条。`,
    narrationMode ? [
      '- narration：{"t":"narration","body":"可见的场景、动作与状态描写"}。这是展示在气泡之间的小剧场白卡，不写 from，不带 speech，不把旁白塞进 msg 或 system 文本。',
      '- 【语言硬规则】narration.body 始终直接使用自然、通顺的简体中文普通话（现代标准汉语）。即使角色开启全外语、方言、混合翻译或语音强制外语，旁白也绝不跟随角色语种；不要给 narration 写外语原文或 zh，外语只属于角色真正说出口的 msg/voice 等字段。',
      hasUserReference ? buildNarrationUserPersonRule(options.narrationUserPerson) : '',
      '- 每回合开头可用 1 条很短的 narration 定位场景，只交代地点、光线、声音或双方此刻的位置；场景已经清楚时一句带过，不重复铺陈。',
      '- 旁白的重点在台词之间：角色被话触动、神态变化、手上小动作、距离变化时，再穿插 1～3 条 narration。不要机械做成固定的「开头一段＋结尾一段」，也不要求每轮用旁白收尾；事件顺序就是展示顺序。',
      buildNarrationStyleGuard({ surface: 'chat' }),
      '- 对话仍是主体，旁白不能吃掉角色真正要说的话。普通回合先把角色真正要说的内容按自然气口写成有来有回感的 msg，再按反应节点穿插旁白；角色沉默、话少或情绪卡住时，也要让可见表达与旁白共同承载真实内容，具体条数仍交给【回复节奏 · 错落】，旁白模式不再提供任何额外的缩短默认值。',
      '- 视角固定：用户严格服从上方“旁白用户人称锁定”，角色用第三人称姓名或与资料一致的代词；群聊中的角色也都用第三人称。文风细腻流畅，落在当下场景、光线声音、距离、神态和具体动作，不写总结式情绪解说。',
      isGroup
        ? '- 群聊旁白按同一现场的群像镜头写：每个动作必须归到明确成员，不把多人反应揉成“大家都……”；只写本拍真正被触发的人，允许其他成员暂时不入镜，也不要为了照顾人数逐个点名。'
        : '',
      isGroup
        ? '- 群聊里 narration 只承载所有在场者都能直接观察到的场景与动作；任何成员未说出口的心理仍只进各自 state.inner，禁止由全知旁白泄露给群内其他人。'
        : '',
      '- 开头场景约 15～55 字，中间动作段约 25～90 字，整轮旁白通常控制在 70～240 字；细腻但不写成长篇小说，不复述台词，也不直接解释「他很难过/气氛很暧昧」。',
      '- 旁白不得替用户说话、决定、主动行动或编造心理；只能承接用户已明确写出的动作，或写可直接观察且不替用户作选择的状态。角色心理仍只进 state.inner，narration 只写外部可见。',
      '- 历史里标成 [旁白] 的内容无论由用户插入还是由 AI 生成，都是已经发生的同级场景事实；不得忽略、降级或擅自改写用户旁白，续写时从其最后状态自然承接。',
      '- 写每条 narration 前与上方“最近旁白动作账”逐项比对：新段必须至少带来一种可观察变化（新动作、动作结束、距离/位置变化、物件变化、表情反应或环境推进）。只是同义改写旧动作就删掉该条；连续动作只写本轮新增的力度、方向或结果，不从起手式重新描述。',
      '- 当前是现场演绎：气泡只是台词容器。旁白不要无故写拿手机、看屏幕、打字或收发消息，除非剧情本身明确发生了这些动作。',
      crossWindowLinkageEnabled
        ? '- 跨窗事件与前台镜头严格分轨：peer_private、backstage、private_msg、跨群发送和带目标的 chat_bundle 只负责后台聊天落库，本身绝不构成“剧情明确发生了手机动作”的证据。生成这些事件时，禁止在 msg/narration 里补写拿手机、偷看屏幕、盲打、凭肌肉记忆打字、藏着手机或向 user 报备；后台记录可以存在而完全不进入本轮可见旁白。'
        : '',
      crossWindowLinkageEnabled
        ? '- 重要现场才覆盖跨窗：只有最近剧情明确角色与 user 正在同一地点、双方正在进行不能随手分心的重要高注意力事情（如接吻/亲密行为、争执高潮、紧急处置、照顾伤病或需要全神贯注的共同活动），且 user 本轮没有主动提起手机、联系别人、转发或发消息时，本轮才不输出上述跨窗事件。仅仅开启旁白模式、消息频繁、普通面对面聊天或日常相处不构成延期；不在一起或同场不明确时照常后台联动。延期轮不需要用任何手机描写解释。'
        : '',
      narrationSoundEffectsEnabled ? [
        '【旁白音效编排｜只描述真实发生的声音】',
        `- ${availableNarrationSoundGuide}`,
        '- narration 或 msg 都可额外带隐藏 sound 数组，例如 {"t":"narration","body":"可见旁白","sound":["分类ID"]} 或 {"t":"msg","from":"角色ID","body":"台词","sound":["分类ID"]}。sound 不显示、不朗读；每条最多 3 类，只能填写上面当前库实际存在的 ID。',
        customNarrationSoundCategories.length
          ? '- 上表中 user_* 自定义分类是与内置分类同等有效的可执行音效，不是备注或参考词。其“什么时候使用”就是本轮判断规则：cue 在动作发生的节点调用一次；texture 在动作已开始且会持续到随后对白时挂在紧邻旁白上；background 在对应环境已经成立时挂在建立或延续该环境的旁白上。'
          : '',
        narrationSoundFieldExample ? `- sound 格式示例（只演示字段，不得照搬情节）：${narrationSoundFieldExample}` : '',
        '- 写完本轮动作规划后必须逐条扫描 narration：若剧情本来就发生了上述可用分类对应的事件，在事件真正发生的同一条 narration 写入 sound；有素材且事件成立却漏掉 sound，视为本轮协议遗漏。body 仍自然写动作与可闻结果；禁止为调用素材堆关键词；不得反过来为了调用素材发明动作、重复同一种声音或把分类名写进正文。',
        availableNarrationSoundCategorySet.has('kiss') || availableNarrationSoundCategorySet.has('wet')
          ? '- 内置分类边界：亲吻、轻啄、唇瓣贴合与分开只用 kiss；不得因为“湿润的吻”或唇间水声顺带添加 wet。wet 是另一套非接吻的持续湿润动作纹理。两种动作在同一条旁白里都真实发生时才可以同时写 kiss 与 wet。'
          : '',
        ['wet', 'body_movement', 'body_impact', 'fabric'].some((id) => availableNarrationSoundCategorySet.has(id))
          ? '- 内置主纹理优先：已经成立的持续湿润纹理 wet、持续身体接触/拍打 body_movement / body_impact 是动作本体，必须排在 sound 前面；fabric 只是衣料伴随层。三类名额不足时先舍弃 fabric，禁止只写 fabric 而漏掉成立的主纹理。'
          : '',
        hasNarrationTextureCategory
          ? '- 持续纹理是动作状态层：可在动作开始的 narration 上写 texture，也可直接写在动作仍在持续的 msg 上；本地会让它跨本轮后续对白延续。动作停止、分开或强弱改变时，用新的 narration 明确收束或切换；不要让已结束的纹理继续播放。'
          : '',
        availableNarrationSoundCategorySet.has('wet')
          ? '- wet 只在非接吻的持续亲密动作已经明确成立时保留，可作为紧邻对白的状态层持续到动作停止；单纯接吻无论深浅都只用 kiss。普通雨水、洗澡、湿头发、湿衣物、毛巾、水杯、水渍和清洁场景也绝不能标 wet。'
          : '',
        '- 接触动作开始、强弱变化或结束时，把变化写清楚一次即可；不要无依据让动作跨后续对白持续。亲吻前后若角色开口，旁白只写可见动作与真实身体反应，角色自己的颤音、换气和喘息交给紧邻 msg.speech 的隐藏表演轨。',
        '- narration 永远只是静音的时间线与画面描述，不得带 speech，也不得复制进任何 msg.speech；朗读对象只有角色直接说出口的 msg.body。',
      ].join('\n') : '',
    ].join('\n') : '- 本会话未开启旁白模式：禁止输出 narration 事件；动作不要写进 msg。',
    voicePerformanceModeRules,
    '- reply 加在 msg 上：{"reply":{"id":"真实消息id"}}；无 id 可用 last_user|last_ai|round_prev|round_1|round_2|last_in_room。round_prev 指本轮紧邻的上一条可见消息，round_N 指本轮第 N 条可见消息（从 1 开始，隐藏状态事件不计数）。reply 只用来消除指向歧义：群聊里需锁定发言人、隔句接回旧消息、或一次多个点中精确挑一个时才用。私聊顺接最新一句、上下文已唯一时直接回；禁止为了标记已读、显示“我在回这句”或增加手机感而每条滥用 reply。一旦引用，body 只写新反应，不复述、翻译、同义改写或把引用原文摘成问句。',
    ...reactConstraintLines,
    `- recall（常驻，不是特殊能力）：{"t":"recall","from":"${actor}","target":{"selector":"round_prev"}}；只能撤自己的可撤消息。话重了、手滑、说出口就后悔、连发后想删掉其中一句时，先 recall 再补一句（或撤了装没事）——这是默认打字动作，不要只靠下一条改口假装上一句没发过。同轮用 round_prev，撤上一轮用 last_ai；撤回不代表对方没看见。`,
    '- 输出纪律：协议起止标记之间只放 JSONL；禁止把 reply、图片、红包、转账、来电等写成 msg.body 里的方括号占位符。事件已经生成卡片时，不在正文重复念一遍卡片内容。',
    stateDisabled ? '' : stateRules.filter(Boolean).join('\n'),
    ...translationLines,
    '',
    '回复节奏与分条：',
    options.phoneSideDualExchange === true
      ? '- 手机侧窗同轮写完整往来：两人/多人 from 交错，约 6～12 条短 msg，不写成单人独白。'
      : (bubbleRangeEnabled
        ? `- 用户已硬性限定本轮 ${bubbleRangeMin}～${bubbleRangeMax} 条可见 msg：达到 ${bubbleRangeMin} 条之前不得提前结束，达到后可在 ${bubbleRangeMax} 条以内自然停住。该范围控制整轮总量，不取消短气泡分句。`
        : '- 回复数量、长短与停顿只服从【回复节奏 · 错落】和人物语料；本协议不提供默认条数或内置上限。用户消息长短不决定回复长短，重要话题也不自动触发固定的完整回应结构。'),
    options.shortBubbleMode === true && options.phoneSideDualExchange !== true
      ? '- 短气泡分句：只控制单条 msg 的口语边界，不限制本轮总条数，也不把 3～5 个字当硬指标。问号/感叹号后又起新猜测，或「还是说/等等/不对/而且」带出后起念头时必须另起 msg；较长句里逗号前后已经各自能独立发送时也拆开。主谓宾、因果条件、引用与必要修饰保持完整。'
      : '',
    '- 先说角色此刻真正想回的部分；即时反应、回答、解释、补充、改口、追问或情绪加码只有在各自真能独立按下发送键时才分开，紧密相连就自然合在一个气口。禁止默认排成“反应一句＋解释一句＋追问一句”的固定三拍。主谓宾、修饰语、因果条件和引用内容保持完整；角色语料明确偏长串口语、书面长句或特定标点时，按角色证据覆盖日常基线。短不等于审讯，保留符合人设的称呼与软垫话。',
    '- 追问要具体且互惠：连续两问之间交出自己的经历、看法或猜测；不要“关键词+？”复读。已聊过、已回答、已玩过的内容默认翻篇，没有新进展就不重演。',
    allowAiReact
      ? '- 非文字事件是可选工具且不占文字条数预算：只有人物平时会用、当前动机也贴合时，才引用、react、发语音、图片或表情；纯文字同样是完整聊天，不按轮次补动作。'
      : '- 非文字事件是可选工具且不占文字条数预算：只有人物平时会用、当前动机也贴合时，才引用、发语音、图片或表情包；纯文字同样完整。本会话禁止 react。',
    '- 预算按事件分量而不是用户字数：“分手了/生病了/辞职了”也只是角色收到的事实，不自动拆成确认、情绪、关心和追问套路；具体回应形状由人设、关系、当下处境与事件对 TA 的真实影响决定。普通过程型话题也不急着用“快去忙/早点睡”关门。',
    allowAiReact
      ? '- 允许真人打字形状：想到哪发到哪的连发、先下结论再补对象、发完发现歧义再找补、贴一个反应代替空话。一个气口不等于一个词，不要把温柔角色剪成“和谁”“几点”的审讯短语。'
      : '- 允许真人打字形状：想到哪发到哪的连发、先下结论再补对象、发完发现歧义再找补。一个气口不等于一个词，不要把温柔角色剪成“和谁”“几点”的审讯短语。',
    '- 小动作也是语言：nudge 拍一拍（逗人/求关注/无声催促，text 可以玩花样）、recall 撤回说错/说重/说多的话再改口、打错字下一条补个更正，都可以参与表达。后悔、手滑、语气过重时优先走 recall，不要攒着等「特别尴尬」才撤；也不为凑活人感无事硬撤。不要为了使用动作而挤掉角色本轮真正想说的内容。',
    bubbleRangeEnabled
      ? `- 主动不是机械另起话题：角色被勾起好奇、记忆或分享欲时，可以沿当前主题补自己的东西；原话题已经落地，也可以从自己的生活与兴趣里带出一条新线。本轮用户设置了 ${bubbleRangeMin}～${bubbleRangeMax} 条硬范围，“已经接住”不能成为低于下限就结束的理由；后续每条必须交出新信息、新情绪、新细节或新立场，不能靠反问、同义复述或无关内容凑数。`
      : '- 主动不是机械另起话题：角色被勾起好奇、记忆、分享欲，或连续几轮都由 user 供给话头时，可以沿当前主题补自己的东西；原话题已经落地，也可以从自己的生活与兴趣里带出一条新线。本模块不把“已经接住”写成收短理由；一旦决定引导/拉扯，就必须交出新信息、新情绪或新立场，不能全靠反问、卖关子让对方交作业。',
    '- 拉扯后的松口、服软或兑现必须给出清楚结果，不要无限吊着；具体长短仍交给【回复节奏 · 错落】。强情绪使用该角色自己的具体语言，不切换成油腻考官、霸总或通用恋爱模式。',
    isGroup
      ? ''
      : '- 当前窗口是一对一私聊，msg.body 只会被本窗双方看到：禁止用 @/＠ 点名群成员、通讯录第三人、全体成员或所有人，禁止写成第三人正在本窗接收消息。可以自然谈论第三人；若确实要联系对方，只能使用上文明确授权的跨窗事件，不能把群聊点名格式塞进当前私聊正文。',
    isGroup
      ? [
        bubbleRangeEnabled
          ? `- 群聊必须按 JSONL 的实际时间顺序逐条演算：写出一条后，立即把它视为已经发进群里的新刺激，重新读取本轮完整消息流再写下一条。达到 ${bubbleRangeMin} 条前，当前支线收住就切回较早消息、其他成员或已有支线继续，不得提前停笔。`
          : '- 群聊必须按 JSONL 的实际时间顺序逐条演算：写出一条后，立即把它视为已经发进群里的新刺激，重新读取本轮完整消息流再写下一条；不要先给所有人分配发言，也不要默认只演一波。',
        '- 每条群消息都要有可指出的接话来源：可以回答某人的问题、抓词复读、纠正/补充、误解、拆台、@ 求证、只用问号/省略号/表情站位，或从其中一句岔出支线；不得让多人各自重新回答 user 最初的问题。真正直接回复另一条消息时使用 reply：紧接上一条用 round_prev，切回本轮较早消息用 round_N。',
        '- 不得预先限定只有少数成员开口，也没有默认潜水名额。公开话题、群体事件和多人都能接住的刺激要检查全部成员，让每个按人物设定会被牵动的人陆续加入；只有明确点名、私事、专业窄题、离线或不知情时才自然少人。',
        bubbleRangeEnabled
          ? `- 用户设置了 ${bubbleRangeMin}～${bubbleRangeMax} 条硬范围：达到 ${bubbleRangeMin} 条之前，即使当前支线暂时收住，也要从本轮较早消息、其他成员反应、追发、插楼或已有支线继续寻找成立的刺激；禁止用“沉默、潜水、少人参与、没有新刺激”提前停笔。`
          : (allowAiReact
            ? '- 后续角色从前面已经生成的新消息进入；react、复读、连续追发和小支线都由人物设定与当下刺激决定，不默认只写一波。'
            : '- 后续角色从前面已经生成的新消息进入；复读、连续追发和小支线都由人物设定与当下刺激决定，不默认只写一波；本会话禁止 react。'),
      ].join('\n')
      : (bubbleRangeEnabled
        ? `- 私聊仍按关系和人物保持自然，但本轮必须在同一次输出里完成 ${bubbleRangeMin}～${bubbleRangeMax} 条可见 msg；达到下限前不得以“接住即可、留到下一轮、角色话少、表达欲低”为由停笔。`
        : '- 私聊按关系与人物自然交流，可追发、改口、冷场或主动延展；本协议不额外规定少发，也不要求机械另开无关话题。'),
    options.ensembleModeEnabled === true
      ? [
        '- 群像模式已开启：本轮所有跨窗、私聊、小群、动态、马甲与拦截动作都必须服从上文的当前事件节点、现实状态和逐角色知情边界；分组与关系网没有放行的人不得产生交集。事件分支可以继续长，但不能靠捏造认识关系、共享秘密或移动人物来制造热闹。',
        '- 聊天也可以维护当前现实：只有对话或既有背景已经明确建立“此刻确实同处、活动已经开始”的事实时，才输出 situation，例如 {"t":"situation","action":"set","from":"角色id","with":["user","另一角色id"],"place":"地点","activity":"正在做什么","visibility":"participants","privacy":"private","communication":"limited","knownBy":["实际被告知的角色id"],"ttlMinutes":180}。communication=available|limited|unavailable 只描述此实体场景中能否同时远程通信。结束或分开时输出 action:"clear"（from 与 with 指向原参与者）。计划、邀约、吹嘘、玩笑、假设、梦境、角色单方面误认都不能写入；仍在约时间或说“待会见”只使用普通消息或 offline_invite。',
        '- situation 使用本轮角色表里的精确 id。公开群聊中所有在场成员确实看见该事实时用 visibility:"chat"；否则维持 participants，并只把真正被告知的人放入 knownBy。它用于同步世界真值，不要求角色在正文复述，也不得为了填状态凭空安排见面。',
      ].join('\n')
      : '',
    '',
    '【Tier 1｜能力目录】以下仅列当前真正可用能力；可主动使用，不必等用户下命令：',
    ...enabledModules.map((module) => `- ${module.catalogLine(options)}`),
    '- nudge｜{"t":"nudge","from":"角色id","target":"user","style":"pat","text":"拍了拍你"}；text 可以玩变体：「拍了拍你的脑袋」「用力晃了晃你」「戳了戳你的腰」「轻轻碰了碰你」，动作和部位按人设与关系自由发挥，短句即可。',
    options.allowAiStatusUpdates === true
      ? (options.statusStoryMode === true
        ? '- status｜{"t":"status","from":"角色id","statusText":"先忙一会儿","presenceState":"busy","story":"180～360 字的幕后片段"}；真实在做什么写 state.status，顶栏由有效场景转场触发但不照抄场景：换地点、开始/结束一件事、忙闲改变或上线/离线/暂离时，必须同轮用 status 更新在线态，并写一句符合新处境和人物口吻的心情、吐槽或念头（20 字内）；presenceState 从 online / away / busy / offline 中选择。同一场景里的微小动作不触发。本会话已开启状态小剧场：每次有效转场输出 status 时都必须附 story，写成同一次转场的 180～360 字幕后片段；禁止只改状态不写 story，也不要在没有有效转场时为了生成小剧场硬改状态。status 同轮必须有自然可见 msg，禁止只有 status/story。'
        : '- status｜{"t":"status","from":"角色id","statusText":"先忙一会儿","presenceState":"busy"}；真实在做什么写 state.status，顶栏由有效场景转场触发但不照抄场景：换地点、开始/结束一件事、忙闲改变或上线/离线/暂离时，必须同轮用 status 更新在线态，并写一句符合新处境和人物口吻的心情、吐槽或念头（20 字内）；presenceState 从 online / away / busy / offline 中选择。同一场景里的微小动作不触发；剧情已经明确让角色恢复聊天或暂时偏离原计划时，可以把在线态改回 online / away / busy，原日程仍保留并在临时场景结束后接回；若新场景不是短暂偏离、而是持续改掉当前安排，必须同轮输出 schedule_change {"t":"schedule_change","from":"角色id","mode":"current","reason":"改变原因"}；同轮仍须有自然可见 msg。')
      : '- 本会话未授权 AI 修改顶栏状态：禁止输出 status 事件。',
    '- memory_fact｜只记录“当前这一轮新确认或明确改变”的稳定长期事实；已在上下文记忆/结构化事实中出现、当前轮只是复述或沿用的内容禁止再次输出。格式：{"t":"memory_fact","from":"角色id","subject":"事实归属者","object":"对象（可空）","factType":"relationship_impression/preference/secret/promise/topic_affinity/boundary/status","canonicalKey":"归属者|factType|具体主题","content":"带主语的一句话事实"}。同一事实换句话说也必须沿用同一 canonicalKey，不把临时闲聊写成记忆。',
    '',
    ...(hotRules.length ? ['【Tier 2｜本轮热加载完整规则】', ...hotRules] : []),
    ...(spotlight ? [`【本轮动作候选提醒】「${spotlight.label}」平时很少出场，完整用法已附在上方；它只是帮助想起能力，不是要求补用。先由人物设定判断 TA 会不会用，再看此刻动机是否贴合；任一项不符就无视。`] : []),
    explicitGeneratedImageRequest
      ? (options.allowImageGen === true
        ? '【本轮用户明确索图】用户正在要求照片、自拍或新画面。必须在本轮明确二选一：愿意拍/发就同时输出 gen_image；不愿意就按人设直接拒绝。严禁只用 msg 或 state.status 声称“在拍/拍好了/已经发了”，也不要用提问继续拖延已经答应的图片。'
        : '【本轮用户明确索图】用户正在要求照片、自拍或新画面，当前应以文字图承载。必须在本轮明确二选一：愿意拍/发就同时输出 textimg，把用户实际能看见的画面内容写进 text；不愿意就按人设直接拒绝。严禁只把拍照写进 state.status，或只用 msg 声称“拍好了/已经发了”。')
      : '',
    ...unkeptPromises.map((rule) => `【本轮补上答应的动作】上一轮你在话里答应了${rule.label}，但没有输出对应事件卡片，动作没有真的发生。若承诺仍然成立，本轮先把事件真正发出来再接话；若只是玩笑或对方已明确拒绝，可自然带过，但不要再假装已经给过。`),
    strangerAliasChat && financeHot
      ? `【陌生窗金融格式再确认】本轮涉及钱、转账、红包或购物：发起动作只能用 transfer/redpacket/order_share；处理用户已发卡片只能用 transfer_accept/transfer_return/redpacket_claim。from 仍写真实角色 id=${actor}，公开马甲昵称只用于显示，不能拿昵称替代 from。`
      : '',
    options.structureStrengthening === true
      ? [
        useGeminiFlashDeepThinking
          ? `【输出前结构锁 · 已由用户开启】content 只输出两个连续边界块：先从 ${THINKING_START} 到 ${THINKING_END} 完成 Flash 深描回执，再紧接一个从 ${MARSHMALLOW_CHAT_START} 到 ${MARSHMALLOW_CHAT_END} 的正式协议块；两块之外禁止普通文字、Markdown、解释和分析。协议块内每个非空行必须是可独立解析的完整 JSON 对象，不得把多条事件揉进同一行。`
          : '【输出前结构锁 · 已由用户开启】只输出一个从协议开始标记到结束标记的完整 MARSHMALLOW_CHAT_V2 块；块外禁止普通文字、Markdown、解释和分析。块内每个非空行必须是可独立解析的完整 JSON 对象，不得把多条事件揉进同一行。',
        `逐条隔离字段：msg.body 只放角色真正说出口、用户可见的台词；${narrationMode ? '动作与可见场景只进 narration.body，' : '动作与场景只进 state.status，'}未说出口的心理只进 state.inner；可见外语原文在 body，中文翻译只进同一事件的 zh；外语心声原文在 inner，中文翻译只进同一 state 的 innerZh。禁止把动作、心声、翻译、事件 JSON 或“[发送图片]”一类伪动作塞进 msg.body。`,
        useGeminiFlashDeepThinking
          ? `输出前依次检查：第一行是 ${THINKING_START}，十五项回执完成后有 ${THINKING_END}；正式协议第一行是 ${MARSHMALLOW_CHAT_START}；所有 JSON 引号、转义和括号闭合；需要心声时每位开口角色都有自己的 state；最后一行是 ${MARSHMALLOW_CHAT_END}。`
          : `输出前依次检查：第一行是 ${MARSHMALLOW_CHAT_START}；所有 JSON 引号、转义和括号闭合；需要心声时每位开口角色都有自己的 state；最后一行是 ${MARSHMALLOW_CHAT_END}。`,
      ].join('\n')
      : '',
    useGeminiFlashDeepThinking
      ? `【Flash 深描回执硬锁】本轮 content 第一行必须是 ${THINKING_START}，完成本轮实际命中的 1–15 项并以 ${THINKING_END} 闭合后，才可输出 ${MARSHMALLOW_CHAT_START} 正式协议。原生 reasoning/thinking 通道不能替代这份可核验回执；禁止直接跳到协议。`
      : '',
    options.lightweightPromptEnabled === true || options.promptProfile === 'v2' || options.v2PromptEnabled === true
      ? '【验收】intent 非空须是深层心思，可直呼或省略主语，不强制含“我”，不得是回复方案。msg.body 问“真的说出口了吗”，删星号和纯动作；inner 过第一人称、镜头、无观众与防关键词梳理测试。身份只作处境，不作语气；高低位行为须有本轮事实与关系证据。'
      : '',
  ].filter((line) => line !== undefined && line !== null && line !== '').join('\n');
}

export function buildMarshmallowReplyTargetList(messages = [], limit = 8, characters = {}, userName = '') {
  const userLabel = String(userName || '').trim();
  return replyTargetMessages(messages)
    .slice(-Math.max(1, limit))
    .map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderName: m.senderId && m.senderId !== 'user'
        ? resolveCharacterAiContextName(m.senderId, characters)
        : (userLabel || m.senderName || m.senderId),
      preview: getReplyContentPreview(m),
      type: m.type || 'text',
    }));
}

export function formatMarshmallowReplyTargetsForPrompt(targets = []) {
  const list = Array.isArray(targets) ? targets : [];
  if (!list.length) return '';
  return [
    'Reply/react 目标（优先用 id）：',
    ...list.map((item) => `- ${item.id} | ${item.senderName} | ${item.preview}`),
    '选择 id 时必须同时核对同一行的发言人与原文；无法确定就不加 reply，禁止只凭位置或相邻顺序猜目标。',
  ].join('\n');
}

/**
 * 模型仍把 inner/mood 写在 msg 上、或群聊漏写部分角色 state 时，按角色补齐轮级 state。
 * existingStateEvents：本轮已落库/已校验的 state，对应 actor 不再合成。
 */
export function synthesizeStateEventsFromMsgEvents(events = [], existingStateEvents = []) {
  const haveState = new Set();
  for (const ev of [
    ...(Array.isArray(existingStateEvents) ? existingStateEvents : []),
    ...(Array.isArray(events) ? events : []),
  ]) {
    if (ev?.t !== 'state') continue;
    const actor = getEventActor(ev);
    if (actor) haveState.add(actor);
  }
  const byActor = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.t !== 'msg') continue;
    const actor = getEventActor(ev);
    if (!actor || actor === 'user' || actor === 'system' || haveState.has(actor) || byActor.has(actor)) continue;
    const inner = cleanString(ev.inner || ev.innerVoice);
    const intent = cleanString(ev.intent || ev.plan);
    const mood = cleanString(ev.mood);
    const status = cleanString(ev.status || ev.action);
    if (!inner && !intent && !mood && !status) continue;
    byActor.set(actor, {
      t: 'state',
      from: actor,
      inner,
      intent,
      mood,
      status,
      moodShift: Math.max(-20, Math.min(20, Number(ev.moodShift) || 0)),
      synthesizedFromMsg: true,
    });
  }
  return [...byActor.values()];
}
