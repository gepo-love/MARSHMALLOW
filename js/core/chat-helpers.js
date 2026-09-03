import { createMessage } from '../models/chat.js';
import { resolveCharacterAiContextName } from '../models/character.js';
import { normalizeUserFacingLabel, coerceUserFacingLabel, isUserPlaceholderLabel, FALLBACK_USER_NAME, getUserDisplayName } from '../models/user.js';
import { getVoiceCallStateLabel, normalizeVoiceDurationLabel } from './chat/card-render.js';
import {
  parseEmbeddedLinkShareText,
  buildPendingLinkMetadata,
  resolveLinkMessagePreview,
} from './link-card-enhancer.js';
import {
  looksLikeRawParticipantId as isRawParticipantIdLike,
  stripLeakedCharacterCodes,
} from './chat/character-code-fallback.js';
import { stripLeakedVoiceCallContextPrefix } from './chat/voice-call-guard.js';
import { sanitizeVoiceTranscriptText, stripLeakedVoicePerformanceTags } from './voice-tools.js';
import { formatChatMentionContext } from './chat/mentions.js';

export function stripAiSearchRequestTags(text = '') {
  return String(text || '').replace(/\[AI搜索请求:[^\]]*\]/gi, '').trim();
}

function formatSelfAbsenceDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return `${hours} 小时`;
  return `${Math.max(1, totalMinutes)} 分钟`;
}

/** 从最近消息列表里找角色自己最后一条发言距今的时长（ms）；找不到返回 null */
export function computeCharacterSelfAbsenceGapMs(messages = [], characterId = '', now = Date.now()) {
  const id = String(characterId || '').trim();
  if (!id) return null;
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m && !m.deleted && !m.recalled && String(m.senderId || '') === id) {
      const ts = Number(m.timestamp || 0);
      return ts ? Math.max(0, Number(now || Date.now()) - ts) : null;
    }
  }
  return null;
}

/**
 * 主动消息通道用：角色自己这个窗口已经沉默多久，口吻按时长分档，抑制「一开口就长篇汇报行踪」
 * 或「毫无由头突然冒泡」两种机器感。短暂停顿本来就是正常聊天节奏，不应被解释成离席。
 */
export function buildSelfAbsenceDirective(gapMs) {
  if (!Number.isFinite(gapMs) || gapMs < 10 * 60 * 1000) return '';
  const selfGapText = formatSelfAbsenceDuration(gapMs);
  return `[你自己的窗口沉默时长] 你已经 ${selfGapText} 没在这个窗口说话。这是时间感知，不是报备指令：不足半小时只用于理解时间流动，正文不要提；半小时到两小时仍默认直接接着聊，除非此前明确存在约定、实时共同活动或“马上回来”的承诺；几小时后也只在自然且有真实依据时半句带过，不得为了填时间凭空编造行程。一天以上可按关系与人设给重新开口一个自然由头，但克制、独立型角色仍应简短，不要道歉式开场或详细汇报。`;
}

/**
 * 主动消息通道用：用户最后一条消息之后，角色已经单方面发过哪些没人接的消息。
 * 主动定时消息容易在用户长时间不回时反复发「醒了吗」「还没醒」同类开场——
 * 把已发未回的内容原样列出来并明令换话头，比抽象的「不要重复」有效得多。
 * 没有未回消息（用户刚说过话）时返回空。
 */
export function buildProactiveAntiRepeatDirective(messages = [], characterId = '') {
  const id = String(characterId || '').trim();
  if (!id) return '';
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.deleted && !m.recalled && m.senderId !== 'system' && m.type !== 'system');
  const pending = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (String(m.senderId || '') === 'user') break;
    if (String(m.senderId || '') !== id) continue;
    const body = getReplyContentPreview(m).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (body) pending.unshift(body);
  }
  if (!pending.length) return '';
  const lines = pending.slice(-5).map((t) => `- ${t}`).join('\n');
  return [
    `[已发未回的消息] 用户上次发言之后，你已经主动发过下面这些、对方都还没回：`,
    lines,
    '本次严禁再发相似内容或同类开场——尤其是「醒了吗/还没醒/在吗/在干嘛/吃了吗」这类查岗式问句，已经问过一次就不许换皮再问。要继续开口，就讲角色自己生活里的具体新鲜事（正在做的、刚看到的、突然想起的）并交出真实态度或联想；不要用单个表情、图片或极短占位掩盖没有新内容。消息数量与分条服从【回复节奏 · 错落】。',
  ].join('\n');
}

function normalizeProactiveComparisonText(value = '') {
  const source = String(value || '');
  let normalized = source;
  try { normalized = source.normalize('NFKC'); } catch (_) {}
  return normalized.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function proactiveComparisonGrams(value = '') {
  const text = normalizeProactiveComparisonText(value);
  const grams = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    grams.add(text.slice(index, index + 2));
  }
  return { text, grams };
}

/**
 * 主动消息落库前的确定性近似查重。
 *
 * 提示词只能劝模型不要复读，拦不住“保留大段原句、只补几句细节”的换皮输出。
 * 这里用字符二元组覆盖率抓这种高重合草稿；短句不参与，避免把正常的称呼或口头禅误杀。
 */
export function scoreProactiveTextSimilarity(left = '', right = '') {
  const a = proactiveComparisonGrams(left);
  const b = proactiveComparisonGrams(right);
  if (!a.text || !b.text) return { duplicate: false, score: 0, containment: 0, shared: 0 };
  if (a.text === b.text && a.text.length >= 10) {
    return { duplicate: true, score: 1, containment: 1, shared: a.grams.size };
  }
  if (a.text.length < 18 || b.text.length < 18 || !a.grams.size || !b.grams.size) {
    return { duplicate: false, score: 0, containment: 0, shared: 0 };
  }
  let shared = 0;
  for (const gram of a.grams) {
    if (b.grams.has(gram)) shared += 1;
  }
  const score = (2 * shared) / (a.grams.size + b.grams.size);
  const containment = shared / Math.min(a.grams.size, b.grams.size);
  return {
    duplicate: shared >= 10 && (containment >= 0.63 || score >= 0.58),
    score,
    containment,
    shared,
  };
}

export function findProactiveNearDuplicate(
  generatedMessages = [],
  historicalMessages = [],
  characterId = '',
  { historyLimit = 24 } = {},
) {
  const actorId = String(characterId || '').trim();
  const generated = (Array.isArray(generatedMessages) ? generatedMessages : [])
    .filter((message) => {
      const senderId = String(message?.senderId || '').trim();
      return message && !message.deleted && !message.recalled
        && senderId && senderId !== 'user' && senderId !== 'system' && senderId !== 'guidance'
        && (!actorId || senderId === actorId);
    })
    .map((message) => ({ message, text: getReplyContentPreview(message).replace(/\s+/g, ' ').trim() }))
    .filter((entry) => entry.text);
  const history = (Array.isArray(historicalMessages) ? historicalMessages : [])
    .filter((message) => {
      const senderId = String(message?.senderId || '').trim();
      return message && !message.deleted && !message.recalled
        && senderId && senderId !== 'user' && senderId !== 'system' && senderId !== 'guidance'
        && (!actorId || senderId === actorId);
    })
    .slice(-Math.max(1, Number(historyLimit) || 24))
    .map((message) => ({ message, text: getReplyContentPreview(message).replace(/\s+/g, ' ').trim() }))
    .filter((entry) => entry.text);
  let closest = null;
  for (const candidate of generated) {
    for (const previous of history) {
      const similarity = scoreProactiveTextSimilarity(candidate.text, previous.text);
      if (!similarity.duplicate) continue;
      if (!closest || similarity.containment > closest.containment) {
        closest = {
          ...similarity,
          generatedMessage: candidate.message,
          historicalMessage: previous.message,
          generatedText: candidate.text,
          historicalText: previous.text,
        };
      }
    }
  }
  return closest;
}

/**
 * 送达状态（红色感叹号/发送失败/已拉黑）是系统事后加在消息外面的展示层标记（见 formatMessageForContext），
 * 只用于喂给模型看历史；模型偶尔会把这段标记误当成自己该写的文字，抄进新一轮 msg 正文开头。
 * 这里做确定性兜底：不管提示词是否生效，落库前一律把这种自抄的方括号前缀砍掉。
 */
export function stripDeliveryStatusBracketFromText(text = '') {
  return String(text || '')
    .replace(/^\[[^\]]*(?:发送失败|红色感叹号|用户已拉黑|已被.{0,6}拉黑|消息拒收|拒收)[^\]]*\]\s*/u, '')
    .trim();
}

/** 购物礼物卡：规范化价格展示 */
export function normalizeOrderSharePrice(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[¥￥]/.test(raw)) return raw.replace(/￥/g, '¥');
  const num = raw.replace(/[^\d.]/g, '');
  if (!num) return raw;
  const n = Number(num);
  if (!Number.isFinite(n) || n < 0) return raw;
  return `¥${n.toFixed(2)}`;
}

/** 购物礼物卡：气泡/列表用的简短正文 */
export function buildOrderShareMessageContent(meta = {}) {
  const title = String(meta.orderTitle || meta.productTitle || '').trim();
  if (!title) return '礼物';
  const price = normalizeOrderSharePrice(meta.orderPrice || meta.price);
  const note = String(meta.orderNote || meta.note || '').trim();
  const giftFor = String(meta.giftForName || '').trim();
  const bits = [];
  if (giftFor) bits.push(`送给${giftFor}`);
  bits.push(title);
  if (price) bits.push(price);
  if (note) bits.push(note);
  return bits.join(' · ');
}

/** 购物礼物卡：喂给 AI 的双向上下文（用户→角色 / 角色→用户） */
export function formatOrderShareForContext(message = {}, options = {}) {
  const md = message?.metadata || {};
  const characters = options.characters || null;
  const senderId = String(message?.senderId || '').trim();
  const userName = String(options.currentUserName || options.userName || '用户').trim() || '用户';
  const isUserSender = senderId === 'user' || md.giftDirection === 'user_to_char';
  const title = String(md.orderTitle || md.productTitle || message?.content || '').trim() || '礼物';
  const price = normalizeOrderSharePrice(md.orderPrice || md.price);
  const note = String(md.orderNote || md.note || '').trim();
  let giftFor = String(md.giftForName || options.giftForName || '').trim();
  if (!giftFor && md.giftForCharacterId) {
    giftFor = resolveCharacterAiContextName(md.giftForCharacterId, characters);
  }
  if (!giftFor && !isUserSender && (md.giftForUserId === 'user' || md.giftDirection === 'char_to_user')) {
    giftFor = userName;
  }
  const buyer = isUserSender
    ? '用户'
    : (String(message?.senderName || '').trim()
      || resolveCharacterAiContextName(senderId, characters)
      || '角色');
  const priceBit = price ? `，价格 ${price}` : '';
  const noteBit = note ? `，备注：${note}` : '';
  if (giftFor) {
    return `[购物礼物] ${buyer}购买了「${title}」${priceBit}，送给${giftFor}${noteBit}`;
  }
  return `[购物礼物] ${buyer}购买了「${title}」${priceBit}${noteBit}`;
}

export function getReplyContentPreview(message = {}) {
  const type = String(message?.type || 'text');
  const content = String(message?.content || '').trim();
  const meta = message?.metadata || {};
  const visibleContent = type === 'text'
    && String(message?.senderId || '') !== 'user'
    && meta.userComposedAsCharacter !== true
    ? stripLeakedVoicePerformanceTags(content)
    : content;
  if (type === 'image') return '[图片]';
  if (type === 'sticker') return '[表情]';
  if (type === 'voice') return '[语音]';
  if (type === 'voice_call') return '[通话]';
  if (type === 'redpacket') return '[红包]';
  if (type === 'transfer') return '[转账]';
  if (type === 'orderShare') {
    const preview = buildOrderShareMessageContent(meta);
    return preview ? `[购物礼物] ${preview}` : '[购物礼物]';
  }
  if (type === 'textimg') return '[文字图]';
  if (type === 'location') return `[位置] ${meta.label || content}`.trim();
  if (type === 'link' && meta.musicTitle) {
    return `[音乐] ${meta.musicTitle}${meta.musicArtist ? ` - ${meta.musicArtist}` : ''}`.trim();
  }
  if (type === 'link') return `[链接] ${meta.title || content}`.trim();
  if (type === 'chatBundle' || type === 'mergeForward') return '[合并转发]';
  if (type === 'vote') return '[投票]';
  if (type === 'dice') return '[骰子]';
  if (type === 'offlineInvite') return '[线下邀约]';
  if (type === 'npcCard') return `[名片] ${meta.npcName || content}`.trim();
  if (type === 'groupInviteUser') return '[入群邀请]';
  if (meta.phoneAutoReply) return `[自动回复] ${visibleContent}`.trim();
  return visibleContent.slice(0, 80);
}

export function previewFromMessage(message = {}) {
  return getReplyContentPreview(message).slice(0, 120);
}

/** 会话列表预览：排除占位、系统提示、已撤回等 */
export function isPreviewCandidateMessage(message = {}) {
  if (!message || message.deleted || message.recalled) return false;
  if (message.metadata?.aiPlaceholder) return false;
  if (message.metadata?.plotExplain === true) return false;
  if (String(message.senderId || '') === 'ai') return false;
  if (message.type === 'system' || message.senderId === 'system') return false;
  // 指导模式气泡不出现在会话列表预览（退出后也不应露出 OOC 讨论）。
  if (message.metadata?.guidanceMode === true
    || message.metadata?.guidanceReply === true
    || message.senderId === 'guidance'
    || String(message.metadata?.aiRoundKind || '').trim() === 'guidance') {
    return false;
  }
  const preview = previewFromMessage(message);
  if (!preview || preview === '正在输入…' || preview === '正在输入...') return false;
  return true;
}

export function buildReplyTargetFields(target, options = {}) {
  const preview = options.getContentPreview
    ? options.getContentPreview(target)
    : getReplyContentPreview(target);
  const senderLabel = typeof options.resolveSenderLabel === 'function'
    ? options.resolveSenderLabel(target)
    : String(target?.senderName || target?.senderId || '');
  return {
    replyTo: target?.id || '',
    replyPreview: preview,
    replyMeta: {
      replyToMessageId: target?.id || '',
      replySenderId: target?.senderId || '',
      replySenderName: senderLabel,
    },
  };
}

/** 从 bracket 文案中提取金额（￥/¥/逗号均可） */
export function normalizeMoneyAmount(value = '', fallback = '0.01') {
  const raw = String(value || '').replace(/[^\d.]/g, '').trim();
  const n = Number(raw || fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n.toFixed(2);
}

const FINANCE_AMOUNT_RE = /(?:¥|￥|RMB|CNY)?\s*([\d,]+(?:\.\d+)?)/iu;

function stripFinanceAmount(text = '') {
  return String(text || '').replace(FINANCE_AMOUNT_RE, '').replace(/^[·•\-—,\s]+/u, '').trim();
}

/**
 * 模型误把转账/红包写进 msg.body（如 [转账: ￥200,000.00]）时的兜底解析。
 * @returns {{ kind: 'transfer'|'redpacket', amount: string, note?: string, greeting?: string }|null}
 */
export function parseFinanceBracketFromText(body = '') {
  const text = String(body || '').trim();
  if (!text) return null;

  const transferMatch = text.match(/^\[(?:微信)?转账[:：]?\s*([^\]]*)\]\s*(.*)$/u);
  if (transferMatch) {
    const inner = transferMatch[1].trim();
    const tail = transferMatch[2].trim();
    const amountSrc = inner.match(FINANCE_AMOUNT_RE) || tail.match(FINANCE_AMOUNT_RE);
    const amount = normalizeMoneyAmount(amountSrc?.[1] || amountSrc?.[0] || inner);
    const note = stripFinanceAmount(inner) || tail || '转账';
    return { kind: 'transfer', amount, note };
  }

  const rpMatch = text.match(/^\[红包[:：]?\s*([^\]]*)\]\s*(.*)$/u);
  if (rpMatch) {
    const inner = rpMatch[1].trim();
    const tail = rpMatch[2].trim();
    const amountSrc = inner.match(FINANCE_AMOUNT_RE) || tail.match(FINANCE_AMOUNT_RE);
    const amount = amountSrc ? normalizeMoneyAmount(amountSrc[1] || amountSrc[0]) : '8.88';
    const greeting = stripFinanceAmount(inner) || stripFinanceAmount(tail) || '恭喜发财';
    return { kind: 'redpacket', amount, greeting };
  }

  return null;
}

/**
 * 模型把合并转发写进 msg.body 的兜底解析。
 * 常见幻觉：`[relaychat_bundle.1754042030851, Lq02]`、`[合并转发: 群聊记录]`。
 * @returns {{ bundleTitle: string, unresolved?: boolean, relayId?: string, relayCode?: string }|null}
 */
export function parseChatBundleBracketFromText(body = '') {
  const text = String(body || '').trim();
  if (!text) return null;

  const relay = text.match(
    /^\[relay\s*:?\s*chat_bundle(?:[.\s:：_-]+(\d{6,}))?(?:\s*(?:,\s*|[.\s:：_-]+)([a-z0-9-]+))?\]\s*$/iu,
  );
  if (relay) {
    const relayId = String(relay[1] || '').trim();
    const relayCode = String(relay[2] || '').trim();
    return {
      bundleTitle: '聊天记录',
      unresolved: true,
      relayId,
      relayCode,
    };
  }

  const merge = text.match(/^\[(?:合并转发|chat[_-]?bundle|merge[_-]?forward)[:：]?\s*([^\]]*)\]\s*(.*)$/iu);
  if (merge) {
    const title = String(merge[1] || '').trim() || String(merge[2] || '').trim() || '聊天记录';
    return { bundleTitle: title.slice(0, 40), unresolved: false };
  }

  return null;
}

/** 已落库的旧消息可能把完整 chat_bundle JSON 当成 text；渲染时恢复成聊天记录卡片。 */
export function parseChatBundleJsonFromText(body = '') {
  const raw = String(body || '').trim();
  if (!raw || !/^(?:```(?:json)?\s*)?\{/i.test(raw)) return null;
  const json = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const type = String(parsed.t || parsed.type || '').trim().toLowerCase();
  if (!['chat_bundle', 'chatbundle', 'merge_forward', 'mergeforward'].includes(type)) return null;
  let rawItems = [
    parsed.items,
    parsed.messages,
    parsed.records,
    parsed.lines,
    parsed.bundleItems,
  ].find(Array.isArray);
  const fallbackContent = parsed.content ?? parsed.body ?? parsed.text;
  if (!rawItems && Array.isArray(fallbackContent)) rawItems = fallbackContent;
  if (!rawItems && fallbackContent && typeof fallbackContent === 'object') rawItems = [fallbackContent];
  if (!rawItems && String(fallbackContent || '').trim()) {
    const text = String(fallbackContent).trim();
    try {
      const decoded = JSON.parse(text);
      rawItems = Array.isArray(decoded) ? decoded : [decoded];
    } catch (_) {
      rawItems = [text];
    }
  }
  const items = (rawItems || [])
    .map((item) => {
      if (!item) return null;
      let spec = item;
      if (typeof spec === 'string') {
        try {
          spec = JSON.parse(spec);
        } catch (_) {
          spec = { body: spec };
        }
      }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
      const nestedText = spec.body ?? spec.text ?? spec.content;
      if (typeof nestedText === 'string' && nestedText.trim().startsWith('{')) {
        try {
          const nested = JSON.parse(nestedText);
          const nestedType = String(nested?.t || nested?.type || '').trim().toLowerCase();
          if (nestedType === 'msg') spec = { ...spec, ...nested };
        } catch (_) {
          // 普通以左花括号开头的聊天正文仍按原文保留。
        }
      }
      const itemType = String(spec.type || spec.kind || spec.t || 'text').trim();
      const content = String(spec.content || spec.body || spec.text || spec.url || spec.imageUrl || '').trim();
      if (!content) return null;
      return {
        senderId: String(spec.senderId || spec.from || '').trim(),
        senderName: String(spec.senderName || spec.fromName || spec.from || '').trim(),
        type: itemType === 'msg' ? 'text' : itemType,
        content,
        ...(Number(spec.timestamp) > 0 ? { timestamp: Number(spec.timestamp) } : {}),
        ...(spec.metadata && typeof spec.metadata === 'object' ? { metadata: { ...spec.metadata } } : {}),
      };
    })
    .filter(Boolean);
  return {
    bundleTitle: String(parsed.title || parsed.bundleTitle || '聊天记录').trim().slice(0, 40) || '聊天记录',
    items,
  };
}

/** 模型把引用回复写进 msg.body（如 [回复: "修一下"] 先吃饭？）时的兜底解析 */
export function parseReplyBracketFromText(body = '') {
  const text = String(body || '').trim();
  if (!text) return null;

  const withSender = text.match(/^\[回复\s*([^:：\]]+?)[:：]\s*["「『“](.+?)["」』”]\]\s*([\s\S]*)$/u);
  if (withSender) {
    return {
      senderName: withSender[1].trim(),
      preview: withSender[2].trim(),
      content: withSender[3].trim(),
    };
  }

  const colonSender = text.match(/^\[回复[:：]\s*([^"「『“\]]+?)["「『“](.+?)["」』”]\]\s*([\s\S]*)$/u);
  if (colonSender) {
    return {
      senderName: colonSender[1].trim(),
      preview: colonSender[2].trim(),
      content: colonSender[3].trim(),
    };
  }

  const bare = text.match(/^\[回复[:：]\s*["「『“](.+?)["」』”]\]\s*([\s\S]*)$/u);
  if (bare) {
    return {
      senderName: '',
      preview: bare[1].trim(),
      content: bare[2].trim(),
    };
  }

  // Model sometimes writes protocol selectors literally: [回复 last_user] 嗯
  const selectorOrName = text.match(/^\[回复\s+([^\]]+?)\]\s*([\s\S]*)$/u);
  if (selectorOrName) {
    return {
      senderName: selectorOrName[1].trim(),
      preview: '',
      content: selectorOrName[2].trim(),
    };
  }

  return null;
}

/** 引用原文不应再自带一层内部发送者前缀；发送者由独立 metadata 渲染。 */
export function sanitizeReplyPreview(value = '', options = {}) {
  let preview = String(value || '').trim();
  if (!preview) return '';
  const prefixed = preview.match(/^((?:char_\d{5,}_[a-z0-9]{1,10}|char\d{1,4}[-_]\d{3,}|npc_[^：:\s]{1,40}|lightnpc_[^：:\s]{1,40}|phone-(?:contact|group):[^：:\s]{1,80}))\s*[：:]\s*([\s\S]*)$/i);
  if (prefixed && isRawParticipantIdLike(prefixed[1])) preview = prefixed[2].trim();
  return stripLeakedCharacterCodes(preview, options).trim();
}

/** 反查失败时也不允许把 char_/npc_ 等后台标识当作引用昵称保存或展示。 */
export function sanitizeReplySenderName(value = '', options = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!isRawParticipantIdLike(raw)) return stripLeakedCharacterCodes(raw, options).trim();
  const cleaned = stripLeakedCharacterCodes(raw, options).trim();
  return !cleaned || cleaned === '某位' || cleaned === '联系人' ? '' : cleaned;
}

export function buildMessageUiUserLabelOptions(options = {}) {
  const userName = String(
    options.userName
    || (options.user ? getUserDisplayName(options.user) : ''),
  ).trim();
  if (!userName || options.anonymous) return null;
  return {
    userName,
    isGroup: !!options.isGroup,
    anonymous: !!options.anonymous,
  };
}

/**
 * 渲染前把消息里 AI/历史遗留的「用户」占位统一换成当前昵称（不改库，只改 UI 副本）。
 */
export function hydrateMessageUserLabelsForUi(message = {}, options = {}) {
  const userName = String(options.userName || '').trim();
  if (!userName || options.anonymous) return message;
  const liveName = coerceUserFacingLabel('', userName);
  const msg = { ...message, metadata: { ...(message?.metadata || {}) } };
  const md = msg.metadata;
  const replyMeta = msg.replyMeta && typeof msg.replyMeta === 'object'
    ? { ...msg.replyMeta }
    : null;

  if (msg.senderId === 'user') {
    msg.senderName = coerceUserFacingLabel(msg.senderName, liveName);
  }

  const replyPreview = String(msg.replyPreview || md.replyPreview || '').trim();
  if (replyPreview) {
    let replySenderId = String(md.replySenderId || replyMeta?.replySenderId || '').trim();
    let replySenderName = String(md.replySenderName || replyMeta?.replySenderName || '').trim();

    const shouldCoerceUser = replySenderId === 'user'
      || (!!replySenderName && isUserPlaceholderLabel(replySenderName));

    if (shouldCoerceUser) {
      replySenderId = 'user';
      replySenderName = liveName;
      md.replySenderId = 'user';
      md.replySenderName = liveName;
      if (replyMeta) {
        replyMeta.replySenderId = 'user';
        replyMeta.replySenderName = liveName;
        msg.replyMeta = replyMeta;
      }
    } else if (replySenderName) {
      const coerced = coerceUserFacingLabel(replySenderName, liveName);
      if (coerced !== replySenderName) {
        md.replySenderName = coerced;
        if (replyMeta) {
          replyMeta.replySenderName = coerced;
          msg.replyMeta = replyMeta;
        }
      }
    }
  }

  return msg;
}

export function normalizeMessageForUi(message = {}, uiOptions = null) {
  const msg = { ...message, metadata: { ...(message?.metadata || {}) } };
  const legacyFinanceEvent = String(msg.metadata?.financeEvent || '').trim();
  if (msg.type === 'system'
    && legacyFinanceEvent === 'transfer_accepted'
    && (msg.metadata?.sourceFinanceMessageId || msg.metadata?.sourceMessageId)) {
    const actorId = String(msg.metadata?.actorId || '').trim();
    const actorName = String(msg.metadata?.actorName || '').trim();
    msg.type = 'transferReceipt';
    msg.senderId = actorId || 'user';
    msg.senderName = actorName || (msg.senderId === 'user' ? '我' : msg.senderName);
    msg.content = '已收款';
    msg.metadata.transferState = 'accepted';
    msg.metadata.sourceFinanceMessageId = String(
      msg.metadata.sourceFinanceMessageId || msg.metadata.sourceMessageId || '',
    );
  }
  if (message?.userComposedAsCharacter && !msg.metadata.userComposedAsCharacter) {
    msg.metadata.userComposedAsCharacter = true;
  }
  if (message?.manualRoleMessage && !msg.metadata.manualRoleMessage) {
    msg.metadata.manualRoleMessage = true;
  }
  let type = String(msg.type || 'text');
  const typeAliases = {
    'chat-bundle': 'chatBundle',
    'order-share': 'orderShare',
    'merge-forward': 'chatBundle',
    mergeForward: 'chatBundle',
    'text-img': 'textimg',
    textImage: 'textimg',
    text_image: 'textimg',
    'voice-call': 'voiceCall',
    'red-packet': 'redpacket',
  };
  if (typeAliases[type]) type = typeAliases[type];
  let content = String(msg.content ?? '');
  if (type === 'text') {
    if (msg.senderId && msg.senderId !== 'user' && msg.senderId !== 'system') {
      content = stripDeliveryStatusBracketFromText(content);
    }
    const trimmed = content.trim();
    const replyBracket = parseReplyBracketFromText(trimmed);
    if (replyBracket) {
      content = replyBracket.content;
      if (!msg.replyPreview) {
        const rawLabel = String(replyBracket.senderName || '').trim();
        const isLastUser = !rawLabel || rawLabel === 'last_user' || isUserPlaceholderLabel(rawLabel);
        const isLastAi = rawLabel === 'last_ai' || rawLabel === 'round_prev';
        const preview = sanitizeReplyPreview(replyBracket.preview, {
          userName: uiOptions?.userName,
        }) || '一条消息';
        msg.replyPreview = preview;
        msg.metadata.replyPreview = preview;
        if (isLastUser) {
          msg.metadata.replySenderId = 'user';
          if (uiOptions?.userName) msg.metadata.replySenderName = uiOptions.userName;
        } else if (rawLabel && !isLastAi) {
          const senderNameRaw = uiOptions?.userName
            ? coerceUserFacingLabel(rawLabel, uiOptions.userName)
            : rawLabel;
          const senderName = sanitizeReplySenderName(senderNameRaw, {
            userName: uiOptions?.userName,
          });
          if (senderName) msg.metadata.replySenderName = senderName;
          if (uiOptions?.userName && (isUserPlaceholderLabel(rawLabel) || senderName === uiOptions.userName)) {
            msg.metadata.replySenderId = 'user';
          }
        }
      }
    }
    if (/^(weibo|forum):\/\//i.test(trimmed)) {
      type = 'link';
      if (!msg.metadata.url) msg.metadata.url = trimmed;
    }
    const pendingUrl = String(msg.metadata?.pendingLinkUrl || '').trim();
    if (pendingUrl && /^https?:\/\//i.test(pendingUrl)) {
      type = 'link';
      if (!msg.metadata.url) msg.metadata.url = pendingUrl;
      if (!msg.metadata.title && msg.metadata.pendingLinkTitle) msg.metadata.title = msg.metadata.pendingLinkTitle;
      if (!msg.metadata.desc && msg.metadata.pendingLinkDesc) msg.metadata.desc = msg.metadata.pendingLinkDesc;
      if (!msg.metadata.descFull && msg.metadata.pendingLinkDesc) msg.metadata.descFull = msg.metadata.pendingLinkDesc;
      if (!msg.metadata.descFull && msg.metadata.desc) msg.metadata.descFull = msg.metadata.desc;
      content = pendingUrl;
    }
    const stickerMatch = content.match(/^\[表情包[:：]\s*([^\]]+)\]\s*(.*)$/u);
    if (stickerMatch) {
      type = 'sticker';
      msg.metadata.stickerName = stickerMatch[1].trim();
      const tail = stickerMatch[2].trim();
      if (tail) msg.metadata.inlineText = tail;
      content = stickerMatch[1].trim();
    }
    const bareStickerMatch = type === 'text'
      ? content.match(/^\[(?:表情包|贴纸)\]\s*(.*)$/u)
      : null;
    if (bareStickerMatch) {
      type = 'sticker';
      msg.metadata.stickerName = '表情包';
      msg.metadata.bareStickerPlaceholder = true;
      const tail = bareStickerMatch[1].trim();
      if (tail) msg.metadata.inlineText = tail;
      content = '表情包';
    }
    const voiceMatch = content.match(/^\[语音消息(?:\s+([^\]]+))?\]\s*([\s\S]*)$/);
    if (voiceMatch && type === 'text') {
      type = 'voice';
      msg.metadata.duration = normalizeVoiceDurationLabel(voiceMatch[1], 5);
      if (voiceMatch[2].trim()) msg.metadata.text = voiceMatch[2].trim();
      content = '[语音消息]';
    }
    const finance = parseFinanceBracketFromText(content.trim());
    if (finance && type === 'text') {
      if (finance.kind === 'transfer') {
        type = 'transfer';
        content = finance.note || '转账';
        msg.metadata.amount = finance.amount;
        msg.metadata.note = finance.note || '';
        msg.metadata.transferNote = finance.note || '';
        if (!msg.metadata.transferState) msg.metadata.transferState = 'pending';
      } else if (finance.kind === 'redpacket') {
        type = 'redpacket';
        content = finance.greeting || '恭喜发财';
        msg.metadata.greeting = finance.greeting || '恭喜发财';
        msg.metadata.totalAmount = finance.amount;
      }
    }
    const bundleJson = type === 'text' ? parseChatBundleJsonFromText(content.trim()) : null;
    const bundleBracket = type === 'text' && !bundleJson ? parseChatBundleBracketFromText(content.trim()) : null;
    if (bundleJson) {
      type = 'chatBundle';
      content = `[合并转发] ${bundleJson.bundleTitle}`;
      msg.metadata.bundleTitle = bundleJson.bundleTitle;
      msg.metadata.items = bundleJson.items;
      msg.metadata.coercedFromEmbeddedJson = true;
    } else if (bundleBracket) {
      type = 'chatBundle';
      content = `[合并转发] ${bundleBracket.bundleTitle}`;
      msg.metadata.bundleTitle = bundleBracket.bundleTitle;
      if (!Array.isArray(msg.metadata.items) && !Array.isArray(msg.metadata.bundleItems)) {
        msg.metadata.items = [];
      }
      if (bundleBracket.unresolved) {
        msg.metadata.unresolvedRelayBundle = true;
        if (bundleBracket.relayId) msg.metadata.relayBundleId = bundleBracket.relayId;
        if (bundleBracket.relayCode) msg.metadata.relayBundleCode = bundleBracket.relayCode;
      }
    }
    if (type === 'text') {
      const embedded = parseEmbeddedLinkShareText(content);
      if (embedded?.url) {
        type = 'link';
        content = embedded.url;
        msg.metadata = {
          ...(msg.metadata || {}),
          ...buildPendingLinkMetadata(embedded, {
            coercedFromText: true,
            ...(embedded.platform ? {
              platform: embedded.platform,
              platformId: embedded.platform.id,
              platformLabel: embedded.platform.label,
              platformColor: embedded.platform.color,
              platformMono: embedded.platform.mono,
            } : {}),
          }),
        };
      }
    }
  }
  const normalized = { ...msg, type, content };
  const labelOpts = buildMessageUiUserLabelOptions(uiOptions || {});
  return labelOpts ? hydrateMessageUserLabelsForUi(normalized, labelOpts) : normalized;
}

function hydrateLinkMetadataForContext(msg = {}) {
  if (msg.type !== 'link') return msg;
  const md = { ...(msg.metadata || {}) };
  if (!md.descFull && md.pendingLinkDesc) md.descFull = md.pendingLinkDesc;
  if (!md.desc && md.pendingLinkDesc) md.desc = md.pendingLinkDesc;
  if (!md.title && md.pendingLinkTitle) md.title = md.pendingLinkTitle;
  if (!md.url && msg.content) md.url = msg.content;
  const preview = resolveLinkMessagePreview(msg, md);
  if (preview.title && (!md.title || md.title === preview.url)) md.title = preview.title;
  if (preview.descFull && !md.descFull) md.descFull = preview.descFull;
  if (preview.descFull && !md.desc) md.desc = preview.descFull;
  return { ...msg, metadata: md };
}

export function getMessageCopyText(message = {}) {
  if (!message) return '';
  if (message.type === 'storyCard') {
    return String(message.metadata?.fullText || message.content || '').trim();
  }
  if (message.type === 'sticker') {
    const name = String(message.metadata?.stickerName || message.metadata?.sticker || message.content || '').trim();
    return name ? `[表情包: ${name}]` : '[表情包]';
  }
  if (message.type === 'system' || message.metadata?.narratorBeat) {
    return String(message.content || '').trim();
  }
  return String(message.content || '').trim();
}

export function getPartnerId(chat) {
  return (chat?.participants || []).find((p) => p && p !== 'user') || '';
}

export function isBackstageChat(chat) {
  return String(chat?.metadata?.channel || '') === 'backstage';
}

export function isPeerPrivateChat(chat) {
  return !!(
    chat?.type === 'private'
    && String(chat?.metadata?.channel || '') === 'peer_private'
    && !isUserPresentInChat(chat)
  );
}

export function isAnonymousChat(chat) {
  if (!chat) return false;
  const meta = chat.metadata || {};
  const groupSettings = chat.groupSettings || {};
  return !!(
    chat.type === 'anonymous'
    || meta.channel === 'anonymous'
    || meta.anonymousMode === true
    || String(meta.anonymousRoomKind || '').trim()
    || String(meta.anonymousRoomId || '').trim()
    || chat.anonymousPrivateConfig
    || groupSettings.anonymousRoomConfig
    || groupSettings.anonymousIdentities
  );
}

/** 主播私聊/粉丝群：走匿名身份隔离，但入口只在主播空间，不混进匿名聊天室大厅 */
export function isStreamerSourcedChat(chat) {
  if (!chat) return false;
  const meta = chat.metadata || {};
  return !!(meta.streamerChannelId || String(meta.sourceAnonymousType || '').startsWith('streamer_'));
}

/** 复制文本；HTTP / 局域网预览下 clipboard API 常不可用，回退 execCommand */
export async function copyTextToClipboard(text = '') {
  const value = String(text ?? '');
  if (!value) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {}
  }

  if (typeof document === 'undefined' || !document.body) return false;
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    return document.execCommand('copy') === true;
  } catch (_) {
    return false;
  } finally {
    ta.remove();
  }
}

export async function resolveStickerMessage(body = '', chatId = '', senderId = '', senderName = '', options = {}) {
  const { resolveStickerMessage: resolveFromPool } = await import('./chat/sticker-resolve.js');
  return resolveFromPool(body, chatId, senderId, senderName, options);
}

export function isUserPresentInChat(chat) {
  return Array.isArray(chat?.participants) && chat.participants.includes('user');
}

export function shouldDeleteForAiRoundReroll(message = {}) {
  if (!message || message.deleted || message.recalled) return false;
  if (message.metadata?.narratorBeat === true && message.metadata?.aiGenerated === true) return true;
  if (message.senderId === 'system') return false;
  if (message.metadata?.userComposedAsCharacter) return false;
  if (message.senderId === 'user') return false;
  return true;
}

function aiRoundCreatedAt(message = {}) {
  const stored = Number(message?.metadata?.aiRoundCreatedAt || 0);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const rid = String(message?.metadata?.aiRoundId || '').trim();
  const match = rid.match(/^(?:s?round)_(\d{10,})_/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 找最新生成的可重 roll 单元。气泡 timestamp 是展示时间，闲聊补充会把新生成的气泡
 * 回填到历史空档，不能用消息数组末尾或最大 timestamp 判断生成先后。
 */
export function getLastAiRerollTarget(messages = []) {
  const groups = new Map();
  (Array.isArray(messages) ? messages : []).forEach((message, index) => {
    if (!message || message.deleted || message.recalled || message.metadata?.aiPlaceholder) return;
    if (message.metadata?.plotExplain === true) return;
    const rid = String(message.metadata?.aiRoundId || '').trim();
    if (!rid) return;
    const rootId = String(message.metadata?.rerollRootId || rid).trim() || rid;
    const createdAt = aiRoundCreatedAt(message);
    const current = groups.get(rootId) || {
      rootId,
      roundIds: new Set(),
      messages: [],
      createdAt: 0,
      lastIndex: -1,
      roundKind: '',
      gapFillWindow: null,
    };
    current.roundIds.add(rid);
    current.messages.push(message);
    current.createdAt = Math.max(current.createdAt, createdAt);
    current.lastIndex = Math.max(current.lastIndex, index);
    if (!current.roundKind && message.metadata?.aiRoundKind) {
      current.roundKind = String(message.metadata.aiRoundKind);
    }
    const gapStart = Number(message.metadata?.aiRoundGapStart || 0);
    const gapEnd = Number(message.metadata?.aiRoundGapEnd || 0);
    if (!current.gapFillWindow && gapStart > 0 && gapEnd > gapStart) {
      current.gapFillWindow = { startTs: gapStart, endTs: gapEnd };
    }
    groups.set(rootId, current);
  });
  const candidates = [...groups.values()];
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.createdAt !== b.createdAt) return a.createdAt ? 1 : -1;
    return a.lastIndex - b.lastIndex;
  });
  const target = candidates[candidates.length - 1];
  return {
    ...target,
    roundIds: [...target.roundIds],
  };
}

export function getLastAiRoundId(messages = []) {
  const target = getLastAiRerollTarget(messages);
  if (!target) return '';
  const sorted = target.roundIds
    .slice()
    .sort((a, b) => {
      const aTs = Number(a.match(/^(?:s?round)_(\d{10,})_/)?.[1] || 0);
      const bTs = Number(b.match(/^(?:s?round)_(\d{10,})_/)?.[1] || 0);
      return aTs - bTs;
    });
  return sorted[sorted.length - 1] || '';
}

export function formatBubbleDisplayContent(message = {}) {
  const msg = normalizeMessageForUi(message);
  if (msg.type === 'text' || !msg.type) {
    return String(msg.content || '').trim();
  }
  return getReplyContentPreview(msg);
}

export function formatReplyRefDisplayLine(msg, currentUserName = '用户', options = {}) {
  const preview = sanitizeReplyPreview(
    msg?.replyPreview || msg?.metadata?.replyPreview || '',
    { userName: currentUserName },
  );
  if (!preview) return '';
  const replySenderId = String(
    msg?.metadata?.replySenderId || msg?.replyMeta?.replySenderId || '',
  ).trim();
  const storedSender = String(
    msg?.metadata?.replySenderName || msg?.replyMeta?.replySenderName || '',
  ).trim();
  const liveUserName = coerceUserFacingLabel('', currentUserName);
  const resolver = typeof options.resolveReplySenderLabel === 'function'
    ? options.resolveReplySenderLabel
    : (typeof options.resolveSenderLabel === 'function' ? options.resolveSenderLabel : null);

  let sender = storedSender;
  if (replySenderId === 'user' || (!!storedSender && isUserPlaceholderLabel(storedSender))) {
    sender = resolver
      ? String(resolver({ senderId: 'user', senderName: storedSender }) || liveUserName).trim()
      : liveUserName;
  } else if (replySenderId && resolver) {
    sender = String(resolver({ senderId: replySenderId, senderName: storedSender }) || storedSender).trim();
  } else if (!replySenderId && resolver && isRawParticipantIdLike(storedSender)) {
    // 模型有时把引用回复直接写成文本 [回复 char_xxx: "..."]，没走 reply JSON 字段，
    // 这种「兜底解析」路径压根没有 replySenderId，storedSender 存的可能就是内部 id 原文。
    // 这里把它当 id 再喂给 resolver 试一次，解不出来才保留原文（不瞎猜）。
    const resolved = String(resolver({ senderId: storedSender, senderName: '' }) || '').trim();
    if (resolved && !isRawParticipantIdLike(resolved)) sender = resolved;
  }
  sender = sanitizeReplySenderName(sender, { userName: currentUserName });

  // 兼容已落库的半掉格式引用：[回复 msg_时间戳_随机串: "原文"]。
  // 渲染层没有完整历史可反查发言人时只显示被引原文，绝不把消息内部 id 当昵称展示。
  if (!replySenderId && /^msg_\d{10,}_[a-z0-9]+$/i.test(storedSender)) return preview;

  // 来源完全缺失时宁可只展示原文，也不能凭空把角色自己的话标成用户。
  if (!String(sender || '').trim()) return preview;
  const label = coerceUserFacingLabel(sender, liveUserName);
  if (label) return `${label}：${preview}`;
  return preview;
}

function formatImageMessageForContext(msg, md = {}) {
  const caption = String(md.caption || md.description || '').trim();
  const captionSuffix = caption ? ` ${caption}` : '';
  if (String(msg.senderId || '').trim() === 'user') {
    const idHint = msg.id ? `·id=${msg.id}` : '';
    return `[用户图片${idHint}]${captionSuffix}`;
  }
  if (md.generatedImage || md.marshmallowEventType === 'gen_image') {
    if (md.generatingImage) return `[发图·gen_image·生成中，图片尚未送达，对方还没有看到]${captionSuffix}`;
    if (md.generationFailed) return `[发图·gen_image·失败，图片没有送达，对方没有看到]${captionSuffix}`;
    return `[发图·gen_image]${captionSuffix}`;
  }
  return `[发图·image]${captionSuffix}`;
}

function buildLinkShareContextText(msg = {}, md = {}, options = {}) {
  const hydrated = hydrateLinkMetadataForContext({ ...msg, metadata: md });
  const meta = hydrated.metadata || {};
  const preview = resolveLinkMessagePreview(hydrated, meta);
  const platformLabel = preview.platformLabel || String(meta.platformLabel || meta.platform?.label || meta.source || '').trim();
  const platformId = preview.platformId || String(meta.platformId || meta.platform?.id || '').trim();
  const contentUrl = String(preview.url || hydrated.content || meta.url || '').trim();
  const linkTitle = preview.title && preview.title !== contentUrl ? preview.title : '';
  const bodyFull = String(preview.descFull || '').trim();
  const head = linkTitle || (bodyFull ? bodyFull.split(/\n/)[0].slice(0, 48) : '分享链接');
  const isScreenshotFallback = preview.isScreenshotFallback;
  const lines = [`[链接分享${platformLabel ? `·${platformLabel}` : ''}]`];
  const isForumShare = Boolean(
    String(meta.forumThreadId || '').trim()
    || /^forum:\/\//i.test(String(contentUrl || hydrated.content || meta.url || '').trim()),
  );
  if (isForumShare) {
    lines.push('动作边界：用户这里只做了“转发一篇论坛帖子”这个动作，没有把帖子正文或评论区的话当作自己的发言，也没有因此提出评论里的要求。帖子内每句话均归属于帖子标注的作者；只有用户另发的聊天文字才代表用户本人态度。');
  }
  if (isScreenshotFallback) {
    lines.push('说明：没配深度解析 Key，这条是内置浏览器直接截的网页原样画面，没有单独的文字版正文；标题/正文/评论都要靠下方截图里的文字自己看，请直接阅读配图。');
  } else if (preview.isLocalPreview && bodyFull) {
    lines.push('说明：以下为分享文案或网页可见摘要（可能被 App/站点截断），不是保证完整的正文；请据此理解大意，看不清的细节不要编造。');
  } else if (meta.enhancedBy === 'tavily' && bodyFull) {
    lines.push('说明：以下为网页抓取摘要，可能不完整；以对话语境为准，不要编造未给出的细节。');
  }
  // 小红书/微博这类第一人称笔记很容易被读成「用户自己发的」，默认按转发/刷到处理，
  // 只有资料里填的账号跟笔记作者核对上才当成用户本人的动态。
  if (['xiaohongshu', 'weibo'].includes(platformId)) {
    lines.push(meta.isOwnPost === true
      ? '说明：已核对作者就是用户本人的账号，可以当成用户自己发的动态来理解。'
      : '说明：这是用户刷到/看到后转发分享给你看的内容，不是用户自己发的动态；正文里出现的第一人称不是在说用户本人，除非用户在聊天里明确说这是TA自己发的。');
    lines.push('身份核验边界：正文和热评描述的是帖子作者、被拍摄者或第三方网友，不会因为外貌、衣着、性格标签、关系类型、地点或事件恰好相似，就自动成为当前聊天里的用户或角色。只有链接结构化资料明确给出可核对的身份，或当前聊天已有确定事实能唯一对应时，才能确认“帖子里说的就是我们/你们”；用户只问“不会是你们吧”属于求证，不是身份事实。证据不足时必须明确说无法确认，可以顺着内容开玩笑或讨论相似点，但不能承认、补写共同经历，也不能把猜测写进剧情连续性。');
  }
  if (linkTitle) lines.push(`标题：${linkTitle}`);
  const author = String(meta.author?.name || '').trim();
  if (author) lines.push(`作者：${author}`);
  const socialAuthorCharacterId = String(
    meta.socialAuthorCharacterId || meta.authorCharacterId || meta.author?.id || '',
  ).trim();
  const boundCharacter = options.characters?.[socialAuthorCharacterId];
  if (socialAuthorCharacterId && socialAuthorCharacterId !== 'user' && boundCharacter) {
    const boundCharacterName = resolveCharacterAiContextName(
      socialAuthorCharacterId,
      options.characters || null,
    );
    if (boundCharacterName) {
      lines.push(`账号归属：该账号已明确绑定通讯录角色「${boundCharacterName}」，是同一个人的社交账号，不是另一个同名人物；理解和回应时沿用该角色已有记忆。`);
    }
  }
  if (bodyFull) {
    lines.push('正文：');
    lines.push(bodyFull.slice(0, 900));
  }
  const tags = Array.isArray(md.tags) && md.tags.length
    ? md.tags
    : (Array.isArray(md.keywords) ? md.keywords.filter(Boolean).slice(0, 8) : []);
  if (tags.length) lines.push(`标签：${tags.map((t) => `#${String(t).replace(/^#+/, '')}`).join(' ')}`);
  const stats = md.stats || {};
  const statsBits = [
    stats.like ? `赞${stats.like}` : '',
    stats.comment ? `评${stats.comment}` : '',
    stats.collect ? `藏${stats.collect}` : '',
    stats.share ? `转${stats.share}` : '',
  ].filter(Boolean);
  if (statsBits.length) lines.push(`互动：${statsBits.join(' ')}`);
  const images = Array.isArray(md.images) ? md.images.filter(Boolean) : [];
  if (isScreenshotFallback && images.length) {
    lines.push(`配图：内置浏览器截了 ${images.length} 屏（已注入识图，见上方截图，文字信息都在图里）`);
  } else if (images.length > 1) {
    lines.push(`配图：共${images.length}张（封面已尝试注入识图）`);
  } else if (md.coverUrl || md.imageUrl || images[0]) {
    lines.push('配图：有封面图（已尝试注入识图）');
  }
  const comments = Array.isArray(md.comments) ? md.comments.filter((c) => c?.text).slice(0, 3) : [];
  if (comments.length) {
    lines.push('热评（以下每条均为标注作者的第三方原话，不是用户的发言或要求）：');
    comments.forEach((c) => {
      const who = String(c.author || '').trim();
      lines.push(`- 发言人=${who || '未识别网友'}｜身份=第三方网友｜原话=${String(c.text).slice(0, 120)}`);
    });
  }
  if (contentUrl && /^https?:\/\//i.test(contentUrl)) lines.push(`链接：${contentUrl}`);
  if (lines.length === 1 && head) lines.push(`摘要：${head}`);
  return lines.join('\n');
}

function resolveVoiceCallPeerName(message = {}, options = {}) {
  const md = message?.metadata || {};
  const characters = options.characters && typeof options.characters === 'object' ? options.characters : {};
  const candidateIds = [
    md.partnerId,
    md.targetId,
    md.characterId,
    md.peerId,
    message?.senderId && message.senderId !== 'user' ? message.senderId : '',
  ].map((id) => String(id || '').trim()).filter(Boolean);
  for (const id of candidateIds) {
    const row = characters[id];
    if (!row) continue;
    const name = resolveCharacterAiContextName(id, characters)
      || String(row.customNickname || row.name || '').trim();
    if (name) return name;
  }
  const fallback = String(md.partnerName || md.characterName || message?.senderName || '').trim();
  return fallback || 'TA';
}

/** 把旧转写里的「我/对方：」改成真实称呼，并统一成气泡口吻。 */
function normalizeVoiceCallSpokenLines(raw = '', { userName = '我', peerName = 'TA' } = {}) {
  const userLabel = String(userName || '').trim() || '我';
  const peerLabel = String(peerName || '').trim() || 'TA';
  return String(raw || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => {
      const text = String(line || '').trim();
      if (!text) return '';
      const named = text.match(/^([^：:]{1,32})\s*[:：]\s*(.+)$/);
      if (!named) return text;
      const who = String(named[1] || '').trim();
      const body = String(named[2] || '').trim();
      if (!body) return '';
      if (/^(我|用户|user)$/i.test(who)) return `${userLabel}｜${body}`;
      if (/^(对方|TA|助手|assistant|ai)$/i.test(who)) return `${peerLabel}｜${body}`;
      return `${who}｜${body}`;
    })
    .filter(Boolean)
    .join('\n');
}

function formatVoiceCallMessageForContext(message = {}, md = {}, currentUserName = '用户', options = {}) {
  const mode = String(md.callMode || '').trim() === 'video' ? '视频通话' : '语音通话';
  const state = getVoiceCallStateLabel(md.callState || md.state || '', md.callMode);
  const duration = String(md.duration || md.durationLabel || '').trim();
  const userLabel = String(currentUserName || '').trim() || '我';
  const peerLabel = resolveVoiceCallPeerName(message, options);
  const entries = Array.isArray(md.callEntries) ? md.callEntries : [];
  let spoken = '';
  if (entries.length) {
    spoken = entries
      .map((entry) => {
        const body = String(entry?.text || entry?.rawText || '').trim();
        if (!body) return '';
        const fromUser = entry?.from === 'user' || entry?.role === 'user';
        return `${fromUser ? userLabel : peerLabel}｜${body}`;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (!spoken) {
    const raw = String(
      md.transcript
      || md.transcriptText
      || md.callSummary
      || md.note
      || message.content
      || '',
    ).trim();
    spoken = normalizeVoiceCallSpokenLines(raw, { userName: userLabel, peerName: peerLabel });
  }
  // 弱模型易把「记录/通话内容/我：对方：」读成会议纪要；标明这是 IM 电话气泡转写。
  const head = `[聊天软件${mode}气泡｜${state}${duration ? `｜${duration}` : ''}]`;
  if (!spoken) return head;
  return [
    head,
    '（电话里双方说过的话，逐句转写；与文字聊天气泡同类。不是会议纪要、不是旁白、不是系统摘要——不要评论这份格式，按电话里说过的自然接话。）',
    spoken,
  ].join('\n');
}

/** 隐藏推理不得成为后续对话或跨模式叙事的文风样本。 */
export function stripHiddenReasoningForContext(value = '') {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/gi, '')
    .replace(/<<<THINKING>>>[\s\S]*$/gi, '')
    .replace(/<<<END_THINKING>>>/gi, '')
    .trim();
}

export function resolveTextImageVisibleText(message = {}, metadata = {}) {
  return String(
    message?.content
    || metadata?.text
    || metadata?.caption
    || metadata?.visibleText
    || '',
  ).trim();
}

/**
 * 文字图的正文来自本地卡片源数据，不需要视觉模型再做 OCR。
 * 用显式边界把“图片里的字”与“发送者说出口的话”分开，避免模型把卡片正文当普通聊天。
 */
export function formatTextImageMessageForContext(message = {}, metadata = {}, options = {}) {
  const visibleText = resolveTextImageVisibleText(message, metadata);
  if (options.omitVisibleText === true) {
    return '[发送了一张图片]';
  }
  return [
    '[发送了一张图片]',
    '【图片附件中已确认的可见内容｜由卡片源数据直接提供，无需 OCR】',
    visibleText || '（卡片没有可读正文）',
    '【图片附件内容结束】',
    '以上内容属于图片画面，不是发送者直接输入或说出口的聊天文字。请把它当作一张普通图片自然回应。',
  ].join('\n');
}

/** AI 上下文用全文；UI 引用预览仍走 getReplyContentPreview（80 字） */
export function formatMessageForContext(message = {}, currentUserName = '用户', options = {}) {
  const msg = hydrateLinkMetadataForContext(normalizeMessageForUi(message));
  if (msg.recalled) return '[已撤回]';
  const md = msg.metadata || {};
  const characters = options.characters || null;
  let text = md.aiGenerated && (msg.type || 'text') === 'text'
    ? stripLeakedVoiceCallContextPrefix(msg.content)
    : String(msg.content || '');
  const aiTextMessage = (msg.type || 'text') === 'text'
    && (md.aiGenerated === true
      || (msg.senderId && msg.senderId !== 'user' && msg.senderId !== 'system'));
  if (aiTextMessage) text = stripHiddenReasoningForContext(text);

  if (msg.type === 'image') {
    text = formatImageMessageForContext(msg, md);
  } else if (msg.type === 'voice') {
    const transcript = sanitizeVoiceTranscriptText(md.text || '', md);
    // 时长是播放器 UI 元数据，不参与剧情语义。过去把 `0:04` 紧贴转写塞进历史，
    // 模型会模仿成下一条 voice.text 的前缀；上下文只保留“这是语音”与实际台词。
    text = `[语音消息]${transcript ? ` ${transcript}` : ''}`;
  } else if (msg.type === 'voiceCall') {
    text = formatVoiceCallMessageForContext(msg, md, currentUserName, options);
  } else if (msg.type === 'sticker') {
    text = `[表情包:${md.stickerName || md.sticker || msg.content || '表情'}]`;
  } else if (msg.type === 'location') {
    text = `[位置] ${md.label || md.locationName || msg.content || ''}${md.address ? ` · ${md.address}` : ''}`;
  } else if (msg.type === 'link') {
    text = buildLinkShareContextText(msg, md, options);
  } else if (msg.type === 'redpacket') {
    text = `[红包] ${md.greeting || msg.content || ''}`;
  } else if (msg.type === 'transfer') {
    text = `[转账] ${md.amount || msg.content || ''}`;
  } else if (msg.type === 'orderShare') {
    text = formatOrderShareForContext(msg, { ...options, currentUserName });
  } else if (msg.type === 'textimg') {
    text = formatTextImageMessageForContext(msg, md, {
      omitVisibleText: options.omitUserTextImageBody === true
        && msg.senderId === 'user'
        && !md.userComposedAsCharacter,
    });
  } else if (msg.type === 'chatBundle' || msg.type === 'mergeForward') {
    const items = Array.isArray(md.items) ? md.items : [];
    const previews = items.slice(0, 8).map((item) => {
      const frontstage = String(item?.frontstageLabel || item?.senderName || '').trim().slice(0, 40);
      const body = item?.type === 'image'
        ? '[图片]'
        : String(item?.content || '').trim().slice(0, 100);
      return body ? `${frontstage ? `${frontstage}：` : ''}${body}` : '';
    }).filter(Boolean);
    text = [
      `[合并转发记录] ${md.bundleTitle || msg.content || ''} · 共${items.length}条`,
      ...previews.map((line) => `- ${line}`),
    ].join('\n');
  } else if (msg.type === 'dice') {
    const sides = Math.max(2, Math.min(100, Number(md.sides) || 6));
    const result = Number(md.result);
    text = Number.isFinite(result) && result > 0
      ? `[骰子] d${sides}=${result}`
      : `[骰子] d${sides}`;
  } else if (msg.type === 'vote') {
    text = `[投票] ${md.voteTitle || md.title || msg.content || ''}`;
  } else if (md.marshmallowEventType === 'social_post' || md.chatAction === 'social_post') {
    const targetLabel = {
      moments: '朋友圈',
      weibo: '微博',
      forum: '论坛',
    }[String(md.socialPostTarget || '').trim().toLowerCase()] || '社交动态';
    const brief = String(md.socialPostBrief || '').trim();
    const briefTail = brief ? ` 计划：${brief}` : '';
    if (md.socialPostStatus === 'completed') {
      text = `[${targetLabel}发布·已发布] 系统已确认发布成功。${briefTail}`;
    } else if (md.socialPostStatus === 'failed') {
      text = `[${targetLabel}发布·未发布] 发布没有成功，不得声称已经发布。${briefTail}`;
    } else {
      text = `[${targetLabel}发布·处理中] 已提交发布请求，尚未确认成功；在收到成功回执前不得声称已经发布。${briefTail}`;
    }
  } else if (msg.type === 'chatAction' || md.chatAction) {
    text = `[${md.actionKind || '聊天动作'}] ${md.actionText || msg.content || ''}`;
  } else if (msg.type === 'offlineInvite') {
    const bits = [md.timeLabel, md.place, md.activity, md.note || msg.content].filter(Boolean).join('·');
    const fromChar = md.inviteFrom === 'character';
    const status = String(md.status || 'pending');
    let tag;
    let tail = '';
    if (fromChar) {
      if (status === 'fulfilled') { tag = '线下邀约·已完成'; tail = '（你们已经见面并结束了这次线下经历；这是已发生事实，不要再次发起同地点同开场的邀约）'; }
      else if (status === 'accepted') { tag = '线下邀约·已接受'; tail = '（用户接受了你的邀约，准备赴约）'; }
      else if (status === 'declined') { tag = '线下邀约·被婉拒'; tail = '（用户这次婉拒了你的邀约，请自然体谅，别追问纠缠）'; }
      else if (status === 'shelved') { tag = '线下邀约·被搁置'; tail = '（用户没答应也没拒绝，说想好了再回你，先搁着了，别催）'; }
      else { tag = '线下邀约·待回应'; tail = '（你发出的邀约，用户还没回应）'; }
    } else {
      tag = status === 'fulfilled'
        ? '线下邀约·用户发起·已完成'
        : (status === 'accepted' ? '线下邀约·用户发起·已开始' : '线下邀约·用户发起');
      tail = status === 'fulfilled'
        ? '（这次线下见面已经发生并结束）'
        : '（用户主动约你线下见面）';
    }
    text = `[${tag}] ${bits}${tail}`;
  } else if (msg.type === 'npcCard') {
    const addedTail = md.addedContactId ? '（用户已把这个人加入通讯录）' : '（用户还没把这个人加入通讯录）';
    text = `[名片·${md.npcName || msg.content || ''}${md.relation ? `·${md.relation}` : ''}] ${md.npcBio || ''}${addedTail}`;
  } else if (msg.type === 'groupInviteUser') {
    const inviteStatus = String(md.status || 'pending');
    const inviteTail = inviteStatus === 'accepted'
      ? '（用户已同意，这个群现在有 user 在场了，不要再当无 user 的幕后群来写）'
      : (inviteStatus === 'declined' ? '（用户暂时没同意加入）' : '（用户还没处理这张邀请卡，不要重复再发一张）');
    text = `[入群邀请·${md.inviterName || msg.senderName || ''}] ${md.note || msg.content || ''}${inviteTail}`;
  } else if (msg.type === 'system' || md.narratorBeat) {
    const narration = String(msg.content || '')
      .replace(/^【当前轮系统旁白承接】/, '')
      .replace(/^【旁白】/, '')
      .trim();
    text = md.narratorBeat ? `[旁白] ${narration}` : narration;
  }

  if (md.phoneAutoReply) {
    const label = String(md.autoReplyLabel || '系统自动回复').trim();
    text = `${label}：${text}`;
  }
  if (md.deliveryBlockedByUser || md.deliveryStatus === 'rejected') {
    text = `[发送失败/红色感叹号/用户已拉黑] ${text}`;
  }
  const mentionContext = formatChatMentionContext(msg, {
    memberCards: options.memberCards,
    characters,
    currentUserName,
  });
  if (mentionContext) text = `${text}\n${mentionContext}`;

  const replyPreview = sanitizeReplyPreview(
    msg.replyPreview || md.replyPreview || '',
    { userName: currentUserName, characters },
  );
  if (replyPreview) {
    // replySenderId/replySenderName 可能挂在 metadata 上，也可能挂在消息顶层 replyMeta 上
    // （用户滑动引用回复走 buildReplyTargetFields + Object.assign 的路径），两处都要认，
    // 否则会把角色原话误标成用户说的塞进上下文，把 AI 带偏。
    const replyMeta = msg.replyMeta && typeof msg.replyMeta === 'object' ? msg.replyMeta : {};
    const replySenderId = String(md.replySenderId || replyMeta.replySenderId || '').trim();
    const resolveLabel = typeof options.resolveSenderLabel === 'function' ? options.resolveSenderLabel : null;
    let replySenderName = '';
    if (replySenderId) {
      replySenderName = resolveLabel
        ? String(resolveLabel(replySenderId, msg) || '').trim()
        : resolveCharacterAiContextName(replySenderId, characters);
    } else {
      replySenderName = String(md.replySenderName || replyMeta.replySenderName || '').trim();
    }
    replySenderName = normalizeUserFacingLabel(replySenderName, currentUserName);
    // resolveSenderLabel 是 AI 上下文专用的受控标签。群聊会在同名角色后附稳定 id，
    // 这里不能再走显示层的内部编号清洗，否则引用消息会重新退化成两个相同昵称。
    if (!resolveLabel) {
      replySenderName = sanitizeReplySenderName(
        replySenderName,
        { userName: currentUserName, characters },
      );
    }
    text = replySenderName
      ? `[回复 ${replySenderName}: "${replyPreview}"] ${text}`
      : `[回复: "${replyPreview}"] ${text}`;
  }

  if (msg.senderId && msg.senderId !== 'user' && msg.senderId !== 'system') {
    const resolveLabel = typeof options.resolveSenderLabel === 'function' ? options.resolveSenderLabel : null;
    const senderLabel = resolveLabel
      ? String(resolveLabel(msg.senderId, msg) || '').trim()
      : resolveCharacterAiContextName(msg.senderId, characters);
    if (senderLabel) text = `[${senderLabel}]: ${text}`;
  } else if (msg.senderId === 'user' && md.userComposedAsCharacter) {
    const roleId = String(md.sendAsCharacterId || '').trim();
    const resolveLabel = typeof options.resolveSenderLabel === 'function' ? options.resolveSenderLabel : null;
    const senderLabel = roleId
      ? (resolveLabel
        ? String(resolveLabel(roleId, msg) || '').trim()
        : resolveCharacterAiContextName(roleId, characters))
      : '';
    if (senderLabel) text = `[${senderLabel}]: ${text}`;
  }

  if (md.phoneProxyByUser === true) {
    const resolveLabel = typeof options.resolveSenderLabel === 'function' ? options.resolveSenderLabel : null;
    const ownerId = String(md.phoneProxyOwnerId || msg.senderId || '').trim();
    const ownerLabel = ownerId
      ? (resolveLabel
        ? String(resolveLabel(ownerId, msg) || '').trim()
        : resolveCharacterAiContextName(ownerId, characters))
      : '手机主人';
    const awareness = md.phoneProxyRecipientAwareness && typeof md.phoneProxyRecipientAwareness === 'object'
      ? md.phoneProxyRecipientAwareness
      : {};
    const awarenessLabel = {
      unnoticed: '未发现，仍当作手机主人本人发送',
      suspicious: '觉得口吻或细节不太对，但尚未确认',
      noticed: '已经察觉或确认不是手机主人本人发送',
    };
    const recipientLines = Object.entries(awareness).map(([actorId, state]) => {
      const actorLabel = resolveLabel
        ? String(resolveLabel(actorId, msg) || '').trim()
        : resolveCharacterAiContextName(actorId, characters);
      return `${actorLabel || actorId}=${awarenessLabel[state] || awarenessLabel.suspicious}`;
    });
    text = `${text}\n[手机代发元数据（只用于身份与知情边界，不得复述或解释）：气泡显示发送者=${ownerLabel || '手机主人'}；实际操作者=用户；手机主人知道。${recipientLines.length ? `收件人状态：${recipientLines.join('；')}。` : ''}回复应优先接住气泡的实际内容、语气和关系，不要展示“如何判断出不是本人”的推理过程；除非正文正在追问身份，否则不要把察觉写成固定的身份揭穿，也不要默认回复“用户在我这里”“别找用户”之类占有或挡人的套话。]`;
  }

  const reactionSuffix = formatUserReactionContextSuffix(msg, currentUserName);
  if (reactionSuffix) text = `${text} ${reactionSuffix}`.trim();

  return String(text || '').trim();
}

/**
 * 角色手机代发消息的稳定事实标记。每名收件人的察觉结果只抽取一次并随消息落库，
 * 后续重进页面、重 roll 或跨窗回流都沿用同一结果，不会每轮反复变动。
 */
function escapePhoneProxyRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createPhoneProxyMessageMetadata({
  ownerId = '',
  userId = '',
  participantIds = [],
  messageText = '',
  ownerName = '',
  userName = '',
  random = Math.random,
} = {}) {
  const owner = String(ownerId || '').trim();
  const visibleText = String(messageText || '').replace(/\s+/g, ' ').trim();
  const visibleOwnerName = String(ownerName || '').replace(/\s+/g, ' ').trim();
  const visibleUserName = String(userName || '').replace(/\s+/g, ' ').trim();
  const explicitlyDisclosed = !!visibleText && (
    /(?:代发|代回|不是.{0,8}(?:本人|本尊|他|她|TA)在打字|手机.{0,8}在我这|账号.{0,8}我在用|我.{0,8}(?:拿着|用了|登录了).{0,8}(?:手机|账号)|(?:替|帮).{0,10}(?:发|回)(?:消息|一句|一下)?)/i.test(visibleText)
    || (!!visibleUserName && new RegExp(`(?:我是|这里是|本人是)[「“\"']?${escapePhoneProxyRegExp(visibleUserName)}`, 'i').test(visibleText))
    || (!!visibleOwnerName && visibleText.includes(visibleOwnerName)
      && /(?:不在|睡了|忙着|手机给我|手机在我|让我回|托我回)/i.test(visibleText))
  );
  const awareness = {};
  [...new Set(Array.isArray(participantIds) ? participantIds : [])]
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== 'system' && id !== owner)
    .forEach((id) => {
      if (explicitlyDisclosed) {
        awareness[id] = 'noticed';
        return;
      }
      const sampled = Number(random());
      const roll = Number.isFinite(sampled) ? Math.max(0, Math.min(0.999999, sampled)) : 0.5;
      awareness[id] = roll < 0.24
        ? 'noticed'
        : (roll < 0.58 ? 'suspicious' : 'unnoticed');
    });
  return {
    userComposedAsCharacter: true,
    sendAsCharacterId: owner,
    phoneProxyByUser: true,
    phoneProxyOwnerId: owner,
    phoneProxyUserId: String(userId || '').trim(),
    phoneProxyRecipientAwareness: awareness,
  };
}

export function buildPhoneProxyOwnerFeedbackExplain({
  userName = '用户',
  ownerName = '手机主人',
  targetLabel = '当前会话',
  messageText = '',
} = {}) {
  const actor = String(userName || '用户').replace(/\s+/g, ' ').trim().slice(0, 40) || '用户';
  const owner = String(ownerName || '手机主人').replace(/\s+/g, ' ').trim().slice(0, 40) || '手机主人';
  const target = String(targetLabel || '当前会话').replace(/\s+/g, ' ').trim().slice(0, 80) || '当前会话';
  const content = String(messageText || '').replace(/\s+/g, ' ').trim().slice(0, 180) || '一条消息';
  return `【剧情解释】人物：${actor}（实际操作者）、${owner}（手机与账号主人）。关系：${actor}使用了${owner}的设备或账号。事件：上一轮${actor}拿了${owner}的手机或登录其账号，在「${target}」里以${owner}名义发送“${content}”；这是已经发生的真实账号操作。${owner}可以当场看见，也可以稍后从发送记录发现，但不能永久不知情。动机：是否获得允许、是玩笑还是越界，要按两人的关系与当时语境判断，不能预设。续写：${owner}下一次在主聊天自然留下一个符合人设的反应即可，可以明显，也可以融进当前话题、动作或语气里；优先回应这条消息的具体内容、措辞和造成的后果，不要复述“谁在打字”的判断过程，不要固定写成“你在我这里”“别找你”或同类占有式挡人句。如果时间线上已有${owner}对此事的反应，则不得重复追究。`;
}

function formatUserReactionContextSuffix(message = {}, userName = '用户') {
  const byUser = message?.metadata?.reactionsByUser;
  if (!byUser || typeof byUser !== 'object') return '';
  const items = Object.entries(byUser)
    .filter(([, count]) => Math.max(0, Number(count) || 0) > 0)
    .map(([em]) => String(em || '').trim())
    .filter(Boolean);
  if (!items.length) return '';
  const label = coerceUserFacingLabel('', userName) || '用户';
  return `〔${label}表情回应：${items.join(' ')}〕`;
}

export function isObserverLikeChat(chat) {
  if (!chat) return false;
  if (isPeerPrivateChat(chat)) return true;
  if (chat.type !== 'group') return false;
  return !!chat.groupSettings?.isObserverMode || !isUserPresentInChat(chat);
}

/** 真人感接话/追发只属于 user 真正在场的一对一前台私聊。 */
export function canRunUserRealPersonScheduling(chat, {
  fromCharacterPhone = false,
  strangerChat = false,
} = {}) {
  if (!chat || fromCharacterPhone || strangerChat) return false;
  if (chat.type === 'group' || !isUserPresentInChat(chat)) return false;
  return !isObserverLikeChat(chat);
}
