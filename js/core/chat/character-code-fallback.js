/**
 * 显示层兜底：AI 有时会把内部标识（角色 id 形如 char_1712345678901_ab12cd、
 * 一次性 NPC id 形如 npc_徐景照、或字面 user）直接抄进正文/称呼里，而不是用备注名/昵称。
 * 只在渲染时替换，不改动已存储的原文；解析不出对应角色时使用中性称呼，不把内部编号上屏。
 */
import { getUserDisplayName } from '../../models/user.js';
import {
  buildChatActorReferenceTable,
  normalizeActorReference,
} from './actor-reference.js';

const CHARACTER_ID_RE = /\bchar_\d{5,}_[a-z0-9]{1,10}\b/g;
const LEGACY_CHARACTER_ID_RE = /\bchar\d{1,4}[-_]\d{3,}\b/gi;
const PREFIXLESS_LIGHTWEIGHT_NPC_ID_RE = /\b\d{11,16}_[a-z0-9]{3,10}\b/gi;
const PREFIXLESS_LIGHTWEIGHT_NPC_ID_EXACT_RE = /^\d{11,16}_[a-z0-9]{3,10}$/i;
const NPC_ID_RE = /\bnpc_[^\s，。！？,.!?：:；;、@"「『“]{1,30}/g;
const AT_USER_RE = /@\s*user\b/gi;
const AT_ACTOR_REFERENCE_RE = /[@＠][\t ]*(?:[UＵｕ]|[CＣｃc][\t _-]*(?:0|０)*[0-9０-９]{1,3})(?=$|[^A-Za-z0-9_])/g;

function resolveCharacterCodeLabel(id, options = {}) {
  const pid = String(id || '').trim();
  if (!pid) return '';
  for (const lookupId of participantIdentityLookupIds(pid)) {
    const anon = options.anonymousProfiles?.[lookupId];
    const anonymousLabel = String(anon?.anonymousId || '').trim();
    if (anonymousLabel && !looksLikeRawParticipantId(anonymousLabel)) return anonymousLabel;
    const card = String(options.memberCards?.[lookupId] || '').trim();
    if (card && !looksLikeRawParticipantId(card)) return card;
    // 朋友圈等场景手头只有 id → 昵称的 Map，不是完整角色对象，单独认一下。
    if (options.nameMap && typeof options.nameMap.get === 'function') {
      const mapped = String(options.nameMap.get(lookupId) || '').trim();
      if (mapped && !looksLikeRawParticipantId(mapped)) return mapped;
    }
    const char = options.characters?.[lookupId]
      || (lookupId === options.partner?.id ? options.partner : null);
    if (char) {
      const label = String(char.name || char.customNickname || char.realName || '').trim();
      if (label && !looksLikeRawParticipantId(label)) return label;
    }
  }
  return '';
}

/**
 * 早期后台群聊曾把 lightnpc_ 前缀从参与者 id 中剥掉。查询身份时同时尝试新旧两种键，
 * 只对「长时间戳_随机串」生效，避免把普通昵称或电话号码误判成 NPC。
 */
export function participantIdentityLookupIds(value = '') {
  const id = String(value || '').trim();
  if (!id) return [];
  if (PREFIXLESS_LIGHTWEIGHT_NPC_ID_EXACT_RE.test(id)) {
    return [id, `lightnpc_${id}`];
  }
  const prefixed = id.match(/^lightnpc_(\d{11,16}_[a-z0-9]{3,10})$/i);
  return prefixed ? [id, prefixed[1]] : [id];
}

/** 一次性 NPC 的内部 id 本身就是「npc_」+ 名字拼出来的，去掉前缀就是可读名字，不需要查表。 */
function stripNpcIdPrefix(token = '') {
  let cleaned = String(token || '').trim();
  while (/^npc_/i.test(cleaned)) cleaned = cleaned.replace(/^npc_/i, '').trim();
  return cleaned;
}

function resolveUserLabel(options = {}) {
  const direct = String(options.userName || '').trim();
  return direct || getUserDisplayName(options.user);
}

function resolveActorReferenceLabel(token = '', options = {}) {
  const reference = normalizeActorReference(token);
  if (!reference) return '';
  const table = buildChatActorReferenceTable(options.chat, {
    includeUser: (options.chat?.participants || []).includes('user'),
  });
  const actorId = table.idFor(reference);
  if (!actorId || !table.rows.some((row) => row.id === actorId)) return '';
  return actorId === 'user'
    ? resolveUserLabel(options)
    : resolveCharacterCodeLabel(actorId, options);
}

/** 是否形如内部 id（含旧版无 lightnpc_ 前缀的时间戳 id），常见于 AI 误把内部标识当称呼写进正文。 */
export function looksLikeRawParticipantId(value = '') {
  const v = String(value || '').trim();
  if (!v) return false;
  if (/^char_\d{5,}_[a-z0-9]{1,10}$/i.test(v)) return true;
  if (/^char\d{1,4}[-_]\d{3,}$/i.test(v)) return true;
  if (/^npc_/i.test(v)) return true;
  if (/^lightnpc_/i.test(v)) return true;
  if (PREFIXLESS_LIGHTWEIGHT_NPC_ID_EXACT_RE.test(v)) return true;
  if (/^phone-contact:/i.test(v)) return true;
  if (/^phone-group:/i.test(v)) return true;
  if (/^user$/i.test(v)) return true;
  return false;
}

/**
 * 把文本里出现的角色内部 id、一次性 NPC id、字面 @user 替换成备注名 / 昵称。
 * 三种模式独立判断是否命中，避免每次都跑三条正则。
 */
export function resolveActorDisplayLabel(value, options = {}) {
  const fallback = String(options.fallback || options.fallbackLabel || '').trim() || '匿名';
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const resolved = stripLeakedCharacterCodes(raw, { ...options, fallbackLabel: fallback });
  const cleaned = String(resolved || '').trim();
  if (!cleaned || looksLikeRawParticipantId(cleaned)) return fallback;
  return cleaned;
}

export function stripLeakedCharacterCodes(text, options = {}) {
  let input = String(text ?? '');
  if (!input) return input;
  const fallbackLabel = String(options.fallbackLabel || '').trim();
  const trimmed = input.trim();
  if (/^user$/i.test(trimmed)) {
    return resolveUserLabel(options) || fallbackLabel || '用户';
  }
  if (looksLikeRawParticipantId(trimmed)) {
    const label = resolveCharacterCodeLabel(trimmed, options);
    if (label && !looksLikeRawParticipantId(label)) return label;
    if (/^npc_/i.test(trimmed)) {
      const npcName = stripNpcIdPrefix(trimmed);
      if (npcName) return npcName;
    }
    // phone-contact:… / lightnpc_… / 旧版无前缀轻量 NPC 末段不可读时兜底，不把内部编号直接上屏
    if (/^phone-contact:/i.test(trimmed)
      || /^phone-group:/i.test(trimmed)
      || /^lightnpc_/i.test(trimmed)
      || PREFIXLESS_LIGHTWEIGHT_NPC_ID_EXACT_RE.test(trimmed)) {
      return fallbackLabel || '联系人';
    }
    return fallbackLabel || '某位';
  }
  if (/char_/i.test(input)) {
    input = input.replace(CHARACTER_ID_RE, (match) => resolveCharacterCodeLabel(match, options) || fallbackLabel || (looksLikeRawParticipantId(match) ? '某位' : match));
  }
  if (/char\d{1,4}[-_]\d{3,}/i.test(input)) {
    input = input.replace(LEGACY_CHARACTER_ID_RE, (match) => resolveCharacterCodeLabel(match, options) || fallbackLabel || (looksLikeRawParticipantId(match) ? '某位' : match));
  }
  if (input.includes('npc_')) {
    input = input.replace(NPC_ID_RE, (match) => stripNpcIdPrefix(match) || match);
  }
  if (/\d{11,16}_[a-z0-9]{3,10}/i.test(input)) {
    input = input.replace(PREFIXLESS_LIGHTWEIGHT_NPC_ID_RE, (match) => (
      resolveCharacterCodeLabel(match, options) || fallbackLabel || '某位'
    ));
  }
  if (/@\s*user\b/i.test(input)) {
    input = input.replace(AT_USER_RE, `@${resolveUserLabel(options)}`);
  }
  if (options.replaceActorReferences === true && /[@＠][\t ]*[UCＵｕＣｃ]/i.test(input)) {
    input = input.replace(AT_ACTOR_REFERENCE_RE, (token) => {
      const label = resolveActorReferenceLabel(token, options);
      return label ? `@${label}` : '某位成员';
    });
  }
  return input;
}
