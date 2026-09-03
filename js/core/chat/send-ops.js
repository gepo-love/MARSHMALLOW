/**
 * 【发送:type:target】...【/发送】 统一解析与执行（跨会话路由）
 * 原则：不做概率/补人/意图推断；仅解析与路由。
 */
import { createChat, createMessage } from '../../models/chat.js';
import {
  ensurePrivateChat,
  ensurePeerPrivateChat,
  saveChat,
  saveMessage,
  updateChatPreview,
  ensureBackstageChat,
  listChatsForUser,
  listBackstageChats,
  findPresetGroupChatForParticipants,
  isBackstageListChat,
} from '../chat-store.js';
import { listCharacters, getCharacter } from '../character-store.js';
import { advanceVirtualTimeForMessages, getNowForUser } from '../time-mode.js';
import { getPartnerId, isAnonymousChat } from '../chat-helpers.js';
import {
  buildSideChatPlotExplainContent,
  stripThinkingBlocks,
} from '../marshmallow-protocol.js';
import { canPhoneCharacterIdsKnowEachOther, checkPhoneSocialParticipantIds } from '../phone-social-eligibility.js';
import {
  attachReceipts,
  createChatRoundReceiptCollector,
} from './chat-round-receipt.js';
import { isExplicitRelationshipObserverGroup } from './chat-round-gate.js';

/** 闭合尾标支持半角 / 与全角 ／ */
const SEND_BLOCK_RE =
  /(?:【|\[)\s*发送\s*[:：·•]\s*(私聊|群聊|幕后|建群)\s*[:：·•]\s*([^\]】]*)(?:】|\])\s*([\s\S]*?)(?:【|\[)\s*[\/／]\s*发送\s*(?:】|\])/g;

let _characterLookup = null;
let _characterLookupAt = 0;
let _characterLookupUserId = '';

async function getCharacterLookup(userId = '') {
  const now = Date.now();
  if (_characterLookup && _characterLookupUserId === userId && now - _characterLookupAt < 5000) return _characterLookup;
  const list = await listCharacters({ excludeAnonNpc: true, userId, identityScoped: true });
  _characterLookup = {
    list,
    byId: new Map(list.map((c) => [c.id, c])),
  };
  _characterLookupUserId = userId;
  _characterLookupAt = now;
  return _characterLookup;
}

function buildTimestampAllocator(baseTs, gapMs = 2000) {
  let cursor = Number(baseTs) || Date.now();
  return (count = 1) => {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      cursor += gapMs + Math.floor(Math.random() * 800);
      out.push(cursor);
    }
    return out;
  };
}

async function allocateChatTimestamps(userId, count, gapMs = 2000) {
  const base = await getNowForUser(userId);
  const timestamps = buildTimestampAllocator(base, gapMs)(count);
  // 跨会话发送不经过聊天页 persistUserMessage，也要推进暂停态下的消息刻度。
  await advanceVirtualTimeForMessages(userId, timestamps);
  return timestamps;
}

async function nextChatMessageTimestamp(userId) {
  const [ts] = await allocateChatTimestamps(userId, 1);
  return ts;
}

/**
 * 块内台词：支持「角色名:正文」「[角色名] 正文」「【角色名】正文」；其它非空行视为目标私聊角色的口语（speaker 空）。
 */
function normalizeSendBlockSpeakerToken(value = '') {
  return String(value || '').trim().replace(/^@+/, '').replace(/\s+/g, '').toLowerCase();
}

function stripRedundantSendBlockSpeakerPrefix(text = '', speaker = '') {
  const raw = String(text || '').trim();
  const expected = normalizeSendBlockSpeakerToken(speaker);
  if (!raw || !expected) return raw;
  const bracket = raw.match(/^(?:\[([^\]\n\r]+)\]|【([^】\n\r]+)】)\s*[:：]\s*([\s\S]+)$/);
  if (bracket) {
    const repeated = normalizeSendBlockSpeakerToken(bracket[1] || bracket[2]);
    if (repeated === expected) return String(bracket[3] || '').trim();
  }
  const plain = raw.match(/^([^:：\[\]【】\n\r]+)\s*[:：]\s*([\s\S]+)$/);
  if (plain && normalizeSendBlockSpeakerToken(plain[1]) === expected) {
    return String(plain[2] || '').trim();
  }
  return raw;
}

function parseSendBlockDialogueLine(line) {
  const raw = String(line || '').trim();
  // 模型偶尔把发送块正文排成 Markdown/编号列表；列表符不是角色名的一部分。
  // 先剥掉它再识别“角色名:正文”，避免署名解析失败后整批回退成发起人。
  const t = raw.replace(/^(?:[-*•·]|\d{1,2}[.)、])\s+/, '').trim();
  if (!t) return null;
  const bracket = t.match(/^\[([^\]\n\r]+)\]\s*(.*)$/);
  if (bracket) {
    const speaker = bracket[1].trim();
    const body = stripRedundantSendBlockSpeakerPrefix(bracket[2], speaker);
    if (body) return { speaker, text: body };
    return { speaker: '', text: t };
  }
  const fw = t.match(/^[【]([^】\n\r]+)[】]\s*(.*)$/);
  if (fw) {
    const speaker = fw[1].trim();
    const body = stripRedundantSendBlockSpeakerPrefix(fw[2], speaker);
    if (body) return { speaker, text: body };
    return { speaker: '', text: t };
  }
  if (/^\[/.test(t) || /^【/.test(t)) {
    return { speaker: '', text: t };
  }
  const colon = t.match(/^([^:：\[\]【]+)\s*[:：]\s*(.+)$/);
  if (colon) {
    const sp = colon[1].trim();
    const tx = stripRedundantSendBlockSpeakerPrefix(colon[2], sp);
    if (sp && tx) return { speaker: sp, text: tx };
  }
  return { speaker: '', text: t };
}

/**
 * @returns {{ cleaned: string, ops: Array<object> }}
 */
export function parseSendBlocks(rawText = '') {
  const text = String(rawText || '');
  const ops = [];
  let m;
  const re = new RegExp(SEND_BLOCK_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const type = m[1];
    const target = String(m[2] || '').trim();
    const body = String(m[3] || '');
    const bodyLines = body.split(/\r?\n/);
    let members = null;
    let memberIds = null;
    let userPresent = null;
    let intent = null;
    let intentOwner = null;
    const dialogueLines = [];
    for (const line of bodyLines) {
      const t = line.trim();
      if (!t) continue;
      const intentMatch = t.match(/^意图\s*[：:]\s*(.+)$/);
      if (intentMatch) {
        intent = intentMatch[1].trim();
        continue;
      }
      const intentTag = t.match(/^\[意图[:：]\s*([^\]]+)\]\s*(.*)$/i);
      if (intentTag) {
        intentOwner = String(intentTag[1] || '').trim() || null;
        const rest = String(intentTag[2] || '').trim();
        intent = rest || String(intentTag[1] || '').trim();
        continue;
      }
      const memberMatch = t.match(/^成员\s*[：:]\s*(.+)$/);
      if (memberMatch) {
        members = memberMatch[1].split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        continue;
      }
      const memberIdsMatch = t.match(/^成员\s*ID\s*[：:]\s*(.+)$/i);
      if (memberIdsMatch) {
        memberIds = memberIdsMatch[1].split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        continue;
      }
      const userPresentMatch = t.match(/^用户在场\s*[：:]\s*(是|否|true|false)$/i);
      if (userPresentMatch) {
        userPresent = /^(是|true)$/i.test(userPresentMatch[1]);
        continue;
      }
      const parsed = parseSendBlockDialogueLine(t);
      if (parsed?.text) dialogueLines.push(parsed);
    }
    ops.push({
      type,
      target,
      members,
      memberIds,
      userPresent,
      intent: intent || null,
      intentOwner,
      lines: dialogueLines,
      actorOverride: null,
      raw: m[0],
    });
  }
  const cleaned = stripSendBlocks(text);
  return { cleaned: cleaned.trim(), ops };
}
export function parseExecutableSendBlocks(rawText = '') {
  const executable = stripThinkingBlocks(rawText);
  const parsed = parseSendBlocks(executable);
  const lines = executable.split(/\r?\n/);
  let openHeaderIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const header = getSendBlockHeaderMatch(trimmed);
    // 只抢救单独成行的正式块头。JSON 字符串里的
    // {"body":"【发送:群聊:...】"} 不是动作，不能据此吞掉后文。
    if (header && !trimmed.slice(header[0].length).trim()) openHeaderIndex = index;
  }
  const hasCloseAfterHeader = openHeaderIndex >= 0
    && lines.slice(openHeaderIndex + 1).some((line) => isSendBlockCloseLine(line));
  if (openHeaderIndex < 0 || hasCloseAfterHeader) return parsed;
  // 只把最后一个独立块头之后的尾巴交给抢救解析，避免协议 JSON 中作为
  // msg.body 字符串出现的同名块头先一步吃掉整段内容。
  const repairedTail = `${lines.slice(openHeaderIndex).join('\n').replace(/\s+$/, '')}\n【/发送】`;
  const salvaged = parseSendBlocks(repairedTail);
  return {
    ...parsed,
    ops: [...parsed.ops, ...salvaged.ops],
  };
}


function getSendBlockHeaderMatch(trimmedLine) {
  const tr = String(trimmedLine || '').trim();
  return tr.match(/^(?:【|\[)\s*发送\s*[:：·•]\s*(私聊|群聊|幕后|建群)\s*[:：·•]\s*([^\]】]*)(?:】|\])/);
}

function isSendBlockCloseLine(trimmedLine) {
  const tr = String(trimmedLine || '').trim();
  const m = tr.match(/^(?:【|\[)\s*[\/／]\s*发送\s*(?:】|\])/);
  if (!m) return false;
  return !tr.slice(m[0].length).trim();
}

/**
 * 公屏用文本：去掉所有【发送】…【/发送】；未闭合块内行一律不进入公屏。
 * 仅以「单独成行的块首/块尾标签」界定块内外；块外台词不因 [角色] 与块内重复而被误删。
 */
export function stripSendBlocks(text = '') {
  let t = String(text || '').replace(new RegExp(SEND_BLOCK_RE.source, 'g'), '');
  const lines = t.split(/\r?\n/);
  const out = [];
  let insideSend = false;
  for (const line of lines) {
    const tr = line.trim();
    if (!insideSend) {
      const header = getSendBlockHeaderMatch(tr);
      if (header) {
        const rest = tr.slice(header[0].length).trim();
        if (rest) {
          out.push(rest);
        }
        insideSend = true;
        continue;
      }
      out.push(line);
      continue;
    }
    if (isSendBlockCloseLine(tr)) {
      const closeMatch = tr.match(/^(?:【|\[)\s*[\/／]\s*发送\s*(?:】|\])/);
      const rest = closeMatch ? tr.slice(closeMatch[0].length).trim() : '';
      if (rest) out.push(rest);
      insideSend = false;
      continue;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 流式预览用：去掉已闭合【发送】块；未闭合则从块首标签删到文末（尽力而为，不替代终稿 stripSendBlocks）。
 */
export function stripSendBlocksPartial(text = '') {
  return stripSendBlocks(text);
}

/**
 * 【发送】写入单条：识别 [合并转发:…] 为 chatBundle
 */
async function createSendOpLineMessage(raw, base, ctx, metaSend) {
  const rawTrim = String(raw || '').trim();
  if (!rawTrim) return null;
  const mergeFm = rawTrim.match(/^\[合并转发[:：]\s*([^\]]*)\]\s*(.*)$/);
  const sc = ctx.sourceChat;
  const sendMeta = metaSend({ fromSendOp: true, sourceGroupChatId: sc?.id || '' });
  if (!mergeFm) {
    return createMessage({
      ...base,
      type: 'text',
      content: rawTrim,
      metadata: sendMeta,
    });
  }
  const inBracket = (mergeFm[1] || '').trim();
  const rest = (mergeFm[2] || '').trim();
  const bundleTitle = inBracket || rest || '聊天记录';
  const itemBody = ((inBracket && rest ? rest : bundleTitle) || '').slice(0, 280);
  const fromChatId = sc?.id || '';
  let fromChatLabel = '';
  if (sc && typeof ctx.resolveName === 'function') {
    if (sc.type === 'group') {
      fromChatLabel = String(sc.groupSettings?.name || '').trim();
    } else {
      fromChatLabel = await ctx.resolveName(getPartnerId(sc));
    }
  }
  const bundleItem = {
    senderId: base.senderId,
    senderName: base.senderName,
    type: 'text',
    content: itemBody || bundleTitle,
    timestamp: base.timestamp - 1,
  };
  return createMessage({
    ...base,
    type: 'chatBundle',
    content: `[合并转发] ${bundleTitle}`,
    metadata: {
      ...sendMeta,
      bundleTitle,
      bundleSummary: `${(itemBody || bundleTitle).slice(0, 18)}${(itemBody || bundleTitle).length > 18 ? '…' : ''} · 共1条`,
      items: [bundleItem],
      fromChatId,
      fromChatLabel,
    },
  });
}

export function filterUnauthorizedSyntheticChatBundleLines(lines = [], authorized = false) {
  const source = Array.isArray(lines) ? lines : [];
  if (authorized === true) return { lines: source, blockedCount: 0 };
  const safeLines = source.filter((line) => (
    !/^\s*\[合并转发[:：]/u.test(String(line?.text || ''))
  ));
  return { lines: safeLines, blockedCount: source.length - safeLines.length };
}

async function resolveCharacterIdLocal(input, userId = '') {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const v = raw
    .replace(/^(?:[-*•·]|\d{1,2}[.)、])\s+/, '')
    .replace(/^[`'“”‘’]+|[`'“”‘’]+$/g, '')
    .trim();
  if (v === 'user' || v === '我' || v === '用户') return 'user';
  const { list } = await getCharacterLookup(userId);
  const byId = list.find((c) => c.id === raw || c.id === v);
  if (byId?.id) return byId.id;
  const byName = list.filter((c) =>
    c.name === v || c.realName === v || c.customNickname === v || (c.aliases || []).includes(v),
  );
  const uniqueIds = [...new Set(byName.map((c) => c?.id).filter(Boolean))];
  if (uniqueIds.length === 1) return uniqueIds[0];
  if (uniqueIds.length > 1) return '';
  const stored = await getCharacter(v, { userId });
  return stored?.id || '';
}

async function resolveSendTargetId(input, ctx = {}) {
  if (typeof ctx.resolveCharacterId === 'function') {
    const custom = await ctx.resolveCharacterId(input);
    if (custom) return custom;
  }
  const raw = String(input || '').trim();
  const rows = Array.isArray(ctx.addressBookCharacters) ? ctx.addressBookCharacters : [];
  const exact = rows.find((row) => String(row?.id || '').trim() === raw);
  if (exact?.id) return exact.id;
  const byName = rows.filter((row) => [
    row?.name,
    row?.realName,
    row?.customNickname,
    ...(Array.isArray(row?.aliases) ? row.aliases : []),
  ].some((value) => String(value || '').trim() === raw));
  const uniqueIds = [...new Set(byName.map((row) => row?.id).filter(Boolean))];
  if (uniqueIds.length === 1) return uniqueIds[0];
  if (uniqueIds.length > 1) return '';
  return resolveCharacterIdLocal(input, ctx.userId || '');
}

function normalizeParticipantIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((x) => x && x !== 'user'))].sort();
}

/**
 * 群名对不上，但参与者集合（是否含 user + 角色成员集合）完全一样：视为同一个群，
 * 不再另开一个。这是模型每次给幕后/建群起的名字不一致，导致重复建群的主要来源。
 */
function findGroupByParticipantSet(userChats, wantHasUser, memberIds = []) {
  const wantKey = normalizeParticipantIds(memberIds).join(',');
  if (!wantKey) return null;
  return userChats.find((c) => {
    if (c.type !== 'group' || isAnonymousChat(c)) return false;
    const parts = c.participants || [];
    if (parts.includes('user') !== wantHasUser) return false;
    return normalizeParticipantIds(parts).join(',') === wantKey;
  }) || null;
}

/**
 * 精确名 → 唯一的模糊包含，且须含 user。
 * requiredParticipantIds 用于把 AI 写出的目标名和本批实际发言人交叉校验：
 * 目标群不包含实际发言角色时整批拒绝，不能先挑一个名字像的群再只落部分台词。
 */
export function findUserGroupByNameHint(userChats, nameHint, requiredParticipantIds = []) {
  const hint = String(nameHint || '').trim();
  if (!hint) return null;
  const required = [...new Set((Array.isArray(requiredParticipantIds) ? requiredParticipantIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const groups = (Array.isArray(userChats) ? userChats : [])
    .filter((c) => c?.type === 'group'
      && (c.participants || []).includes('user')
      && !isAnonymousChat(c))
    .map((chat) => ({ chat, name: String(chat.groupSettings?.name || '').trim() }))
    // 空群名不能参与 hint.includes(name)；否则任意目标名都会误命中第一个空名群。
    .filter((row) => row.name)
    .filter((row) => required.every((id) => (row.chat.participants || []).includes(id)));
  const newestFirst = (a, b) => Number(b.chat.lastActivity || 0) - Number(a.chat.lastActivity || 0);
  const exact = groups.filter((row) => row.name === hint).sort(newestFirst);
  if (exact.length) return exact[0].chat;
  const fuzzy = groups.filter((row) => row.name.includes(hint) || hint.includes(row.name));
  // 多个相近群名时拒绝猜测，避免把消息落进列表顺序靠前但语义无关的群。
  return fuzzy.length === 1 ? fuzzy[0].chat : null;
}

export function parseGroupTargetSelector(value = '') {
  const raw = String(value || '').trim();
  const match = raw.match(/^chatId\s*=\s*([^|]+)\|([\s\S]*)$/i);
  if (!match) return { targetChatId: '', nameHint: raw };
  return {
    targetChatId: String(match[1] || '').trim(),
    nameHint: String(match[2] || '').trim(),
  };
}

/**
 * 跨窗群聊只校验本次真正落入目标群的发言人。
 * 当前窗口角色可能只是触发了联动，并不一定在目标群里；把 actorId 无条件加入
 * 会让带精确 chatId、且块内发言人都合法的消息被误判为成员不匹配。
 */
export function collectGroupSendParticipantIds(resolvedLines = []) {
  return [...new Set((Array.isArray(resolvedLines) ? resolvedLines : [])
    .map((line) => String(line?.senderId || '').trim())
    .filter((id) => id && id !== 'user'))];
}

const GROUP_SEND_FAILURE_REASONS = Object.freeze({
  social_linkage_disabled: ['当前会话关闭了跨窗群聊联动', 'settings'],
  group_line_actor_dropped: ['群消息中的发言人无法对应到现有角色', 'protocol'],
  group_target_unresolved: ['没有找到唯一且成员匹配的目标群；请确认角色仍在群内，群名或群 ID 没有变化', 'routing'],
  group_send_interval_blocked: ['跨窗联动仍在间隔限制内，本轮没有重复发送', 'cooldown'],
  group_send_actor_muted: ['当前发起角色在来源群内处于禁言状态', 'permission'],
  group_send_source_muted: ['来源群已开启全员禁言', 'permission'],
  group_send_sender_restricted: ['本轮只允许指定角色回复，跨窗发送被拦截', 'scope'],
  group_send_no_effect: ['跨窗发送没有产生可落库的群消息', 'internal'],
});

export function describeCrossWindowGroupSendFailure(receipts = [], fallbackCode = 'group_send_no_effect') {
  const relevant = (Array.isArray(receipts) ? receipts : []).filter((receipt) => (
    receipt?.eventType === 'group'
    && ['blocked', 'dropped'].includes(String(receipt?.status || ''))
  ));
  const code = String(relevant[0]?.code || fallbackCode || 'group_send_no_effect').trim();
  const [reason, category] = GROUP_SEND_FAILURE_REASONS[code]
    || GROUP_SEND_FAILURE_REASONS.group_send_no_effect;
  return {
    code,
    reason,
    category,
    message: `跨窗群消息未发出：${reason}。`,
  };
}

/**
 * 已有前台群优先按稳定 chatId 定位；旧协议才回退到群名。
 * 若模型给错 ID/名称，但参与者集合只可能落在一个现有群，允许代码唯一纠正一次。
 */
export function resolveUserGroupTarget(userChats, selector, requiredParticipantIds = [], userId = '') {
  const { targetChatId, nameHint } = parseGroupTargetSelector(selector);
  const required = [...new Set((Array.isArray(requiredParticipantIds) ? requiredParticipantIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const eligible = (Array.isArray(userChats) ? userChats : [])
    .filter((chat) => chat?.type === 'group'
      && (chat.participants || []).includes('user')
      && !isAnonymousChat(chat))
    .filter((chat) => !userId || !chat.userId || String(chat.userId) === String(userId))
    .filter((chat) => required.every((id) => (chat.participants || []).includes(id)));
  if (targetChatId) {
    const direct = eligible.find((chat) => String(chat.id || '') === targetChatId);
    if (direct) return { chat: direct, resolution: 'id' };
  }
  const byName = findUserGroupByNameHint(eligible, nameHint, required);
  if (byName) return { chat: byName, resolution: targetChatId ? 'corrected_name' : 'name' };
  if (required.length >= 2 && eligible.length === 1) {
    return { chat: eligible[0], resolution: 'corrected_members' };
  }
  return { chat: null, resolution: 'unresolved' };
}

/**
 * 兼容模型把明确的旁观群 chatId / 完整群名写进“群聊”发送块。
 * 这里只接受稳定 ID 或唯一精确名，不做模糊猜测，避免把普通前台群误改投幕后。
 */
export function resolveExplicitObserverGroupTarget(userChats, selector, requiredParticipantIds = [], userId = '') {
  const { targetChatId, nameHint } = parseGroupTargetSelector(selector);
  const required = [...new Set((Array.isArray(requiredParticipantIds) ? requiredParticipantIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const eligible = (Array.isArray(userChats) ? userChats : [])
    .filter((chat) => chat?.type === 'group'
      && !(chat.participants || []).includes('user')
      && !isAnonymousChat(chat))
    .filter((chat) => !userId || !chat.userId || String(chat.userId) === String(userId))
    .filter((chat) => required.every((id) => (chat.participants || []).includes(id)));
  if (targetChatId) {
    const direct = eligible.find((chat) => String(chat.id || '') === targetChatId);
    if (direct) return { chat: direct, resolution: 'observer_id' };
  }
  const exact = eligible.filter((chat) => String(chat.groupSettings?.name || '').trim() === nameHint);
  return exact.length === 1
    ? { chat: exact[0], resolution: 'observer_name' }
    : { chat: null, resolution: 'unresolved' };
}

/** 幕后群：同一来源内精确名 → 唯一模糊名，同时要求本批角色都是真实群成员。 */
export function findBackstageGroupByNameHintFromChats(
  chats,
  parentChatId,
  nameHint,
  requiredParticipantIds = [],
) {
  const hint = String(nameHint || '').trim();
  if (!hint) return null;
  const parentId = String(parentChatId || '').trim();
  const required = [...new Set((Array.isArray(requiredParticipantIds) ? requiredParticipantIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const scoped = (Array.isArray(chats) ? chats : [])
    .filter((c) => c?.type === 'group'
      && !(c.participants || []).includes('user')
      && !isAnonymousChat(c))
    .filter((c) => !parentId || String(c.metadata?.parentChatId || '') === parentId)
    .map((chat) => ({ chat, name: String(chat.groupSettings?.name || '').trim() }))
    .filter((row) => row.name)
    .filter((row) => required.every((id) => (row.chat.participants || []).includes(id)));
  const exact = scoped.filter((row) => row.name === hint);
  if (exact.length) {
    return exact
      .sort((a, b) => Number(b.chat.lastActivity || 0) - Number(a.chat.lastActivity || 0))[0].chat;
  }
  const fuzzy = scoped.filter((row) => row.name.includes(hint) || hint.includes(row.name));
  return fuzzy.length === 1 ? fuzzy[0].chat : null;
}

async function findBackstageGroupByNameHint(
  userId,
  parentChatId,
  nameHint,
  requiredParticipantIds = [],
) {
  const backstage = await listBackstageChats(userId);
  return findBackstageGroupByNameHintFromChats(
    backstage,
    parentChatId,
    nameHint,
    requiredParticipantIds,
  );
}

/**
 * @param {object[]} ops
 * @param {string|null} currentActorId
 * @param {object} ctx
 * @param {string} ctx.userId
 * @param {string} [ctx.userName]
 * @param {string} [ctx.currentChatId]
 * @param {object} [ctx.sourceChat]
 * @param {boolean} [ctx.allowGroupLinkage=true]
 * @param {boolean} [ctx.allowGroupCreation=true]
 * @param {boolean} [ctx.allowPrivateLinkage=false]
 * @param {string[]} [ctx.privateLinkageIds=[]]
 * @param {boolean} [ctx.debugMode=false]
 * @param {(id:string)=>Promise<string>} [ctx.resolveName]
 * @param {Record<string, unknown>} [ctx.relayMeta]
 * @param {(chatId: string) => void} [ctx.onRelayChatWritten]
 */
export async function executeSendOps(ops, currentActorId, ctx = {}) {
  const logs = [];
  const receipts = createChatRoundReceiptCollector();
  const userId = ctx.userId || '';
  if (!userId || !ops?.length) return attachReceipts(logs, receipts.list());

  const sourceChat = ctx.sourceChat || null;
  const allowGroup = ctx.allowGroupLinkage !== false;
  const allowGroupCreation = ctx.allowGroupCreation !== false;
  const allowPrivate = ctx.allowPrivateLinkage === true;
  const explicitPrivate = Array.isArray(ctx.privateLinkageIds) ? ctx.privateLinkageIds.filter(Boolean) : [];
  const whitelist = explicitPrivate;
  const debugMode = !!ctx.debugMode;
  const resolveName = ctx.resolveName || (async (id) => id);
  const relayExtra = ctx.relayMeta && typeof ctx.relayMeta === 'object' ? ctx.relayMeta : null;
  const metaSend = (base) => (relayExtra ? { ...base, ...relayExtra } : base);
  const resolveActorId = (input) => resolveSendTargetId(input, ctx);
  const groupCreationBudget = ctx.groupCreationBudget && typeof ctx.groupCreationBudget === 'object'
    ? ctx.groupCreationBudget
    : { remaining: 1 };
  if (!Number.isFinite(Number(groupCreationBudget.remaining))) groupCreationBudget.remaining = 1;
  const canCreateAnotherGroup = () => Number(groupCreationBudget.remaining) > 0;
  const consumeGroupCreation = () => {
    groupCreationBudget.remaining = Math.max(0, Number(groupCreationBudget.remaining) - 1);
  };

  async function formatBackstageRoomName(ids = []) {
    const uniq = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => x && x !== 'user'))];
    const names = await Promise.all(uniq.map((id) => resolveName(id)));
    const cleaned = names.map((n, i) => String(n || uniq[i] || '').trim()).filter(Boolean);
    return `幕后·${cleaned.join(' · ') || '小群'}`;
  }

  async function debugSystem(content) {
    if (!debugMode || !ctx.currentChatId) return;
    const ts = await nextChatMessageTimestamp(userId);
    await saveMessage(createMessage({
      chatId: ctx.currentChatId,
      senderId: 'system',
      type: 'system',
      content: String(content || '').slice(0, 500),
      timestamp: ts,
      metadata: { debug: 'send-ops' },
    }));
  }

  for (const rawOp of ops) {
    let op = rawOp;
    if (ctx.explicitUserForwardAuthorization !== true && Array.isArray(op?.lines)) {
      const { lines: safeLines, blockedCount } = filterUnauthorizedSyntheticChatBundleLines(
        op.lines,
        false,
      );
      if (blockedCount > 0) {
        receipts.add({
          code: 'synthetic_chat_bundle_requires_user_authorization',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'chat_bundle',
          reason: 'AI send blocks cannot fabricate forwarded records',
          context: { blockedCount },
        });
        op = { ...op, lines: safeLines };
        if (!safeLines.length) continue;
      }
    }
    let actorId = op.actorOverride || currentActorId;
    if (!actorId && op.forwarderName) actorId = await resolveActorId(String(op.forwarderName));
    let type = op.type;
    let workOp = op;

    if (type === '私聊') {
      if (!allowPrivate) {
        receipts.add({
          code: 'private_linkage_disabled',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'private_msg',
          reason: 'private linkage is disabled',
        });
        continue;
      }
      const targetRaw = String(op.target || '').trim();
      let peerId = targetRaw ? await resolveSendTargetId(targetRaw, ctx) : '';
      if (!peerId && (op.lines || []).length) {
        for (const ln of op.lines || []) {
          const sid = ln.speaker ? await resolveSendTargetId(String(ln.speaker), ctx) : '';
          if (sid && sid !== 'user') {
            peerId = sid;
            break;
          }
        }
      }
      if (!peerId) peerId = actorId;
      if (!peerId) {
        receipts.add({
          code: 'private_target_unresolved',
          status: 'dropped',
          stage: 'send-op',
          eventType: 'private_msg',
          reason: 'target is missing or ambiguous',
          context: { target: targetRaw },
        });
        await debugSystem('[发送:私聊] 无法解析目标角色（块首「目标」或块内台词）');
        continue;
      }
      if (whitelist.length && !whitelist.includes(peerId)) {
        receipts.add({
          code: 'private_target_not_whitelisted',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'private_msg',
          context: { peerId },
        });
        continue;
      }

      const parts = sourceChat ? sourceChat.participants || [] : [];
      if (sourceChat?.id) {
        const peerIn = parts.includes(peerId);
        const actorIn = actorId && parts.includes(actorId);
        let lineIn = false;
        for (const ln of op.lines || []) {
          if (!ln.speaker) continue;
          const sid = await resolveSendTargetId(String(ln.speaker), ctx);
          if (sid && parts.includes(sid)) lineIn = true;
        }
        if (!peerIn && !actorIn && !lineIn) {
          receipts.add({
            code: 'private_source_membership_gate',
            status: 'blocked',
            stage: 'send-op',
            eventType: 'private_msg',
            context: { peerId, actorId },
          });
          await debugSystem('[发送:私聊] 目标与发言者均不在来源群');
          continue;
        }
      }

      let ownerId = '';
      if (op.intentOwner) {
        const cand = await resolveSendTargetId(String(op.intentOwner), ctx);
        if (cand && cand !== 'user') ownerId = cand;
      }
      const explicitSpeakerIds = [];
      for (const ln of op.lines || []) {
        if (!ln?.speaker) continue;
        const sid = await resolveSendTargetId(String(ln.speaker), ctx);
        if (sid && sid !== 'user') explicitSpeakerIds.push(sid);
      }
      const hasForeignSpeaker =
        (ownerId && ownerId !== peerId)
        || explicitSpeakerIds.some((sid) => sid && sid !== peerId);
      let peerPrivateIds = [];
      if (hasForeignSpeaker) {
        const backstageActor = ownerId || actorId || explicitSpeakerIds.find((x) => x && x !== peerId) || peerId;
        const roomIds = normalizeParticipantIds([backstageActor, peerId, ...explicitSpeakerIds]);
        if (roomIds.length === 2) {
          peerPrivateIds = roomIds;
          type = '角色私聊';
          await debugSystem('[发送:私聊] 已写入角色双方共享的真实私聊窗');
        } else {
          const roomName = await formatBackstageRoomName(roomIds);
          await debugSystem(`[发送:私聊→幕后] 多人内容已改为后台群聊：${roomName}`);
          type = '幕后';
          workOp = {
            ...op,
            type: '幕后',
            target: roomName,
            intent: op.intent || null,
            lines: (op.lines || []).map((ln) => ({
              speaker: String(ln.speaker || '').trim() || backstageActor,
              text: ln.text,
            })),
          };
        }
      }

      if (type === '私聊') {
        const bubbles = [];
        for (const ln of op.lines || []) {
          const raw = String(ln.text || '').trim();
          if (!raw) continue;
          let sid = ln.speaker ? await resolveSendTargetId(String(ln.speaker), ctx) : '';
          if (!sid) sid = peerId;
          if (sid !== 'user' && sid !== peerId) sid = peerId;
          bubbles.push({ content: raw, senderId: sid });
        }
        if (!bubbles.length) continue;

        const dm = await ensurePrivateChat(userId, peerId);
        const tsList = await allocateChatTimestamps(userId, bubbles.length);
        for (let i = 0; i < bubbles.length; i += 1) {
          const { content, senderId } = bubbles[i];
          const senderName =
            senderId === 'user'
              ? String(ctx.userName || '').trim() || '用户'
              : await resolveName(senderId);
          const msg = await createSendOpLineMessage(
            content,
            {
              chatId: dm.id,
              senderId,
              senderName,
              timestamp: tsList[i],
            },
            ctx,
            metaSend,
          );
          if (msg) await saveMessage(msg);
        }
        const lastBubble = bubbles[bubbles.length - 1];
        await updateChatPreview(dm.id, lastBubble.content.slice(0, 80), tsList[tsList.length - 1]);
        if (typeof ctx.onRelayChatWritten === 'function') ctx.onRelayChatWritten(dm.id);
        logs.push(`私聊→${await resolveName(peerId)}（${bubbles.length}条）`);
        continue;
      }
      if (type === '角色私聊' && peerPrivateIds.length === 2) {
        const sociallyEligible = await canPhoneCharacterIdsKnowEachOther(
          peerPrivateIds[0],
          peerPrivateIds[1],
          userId,
        ).catch(() => false);
        if (sociallyEligible === false) {
          receipts.add({
            code: 'peer_private_social_boundary',
            status: 'blocked',
            stage: 'send-op',
            eventType: 'peer_private',
            context: { participantIds: peerPrivateIds },
          });
          await debugSystem('[发送:私聊] 已拦截跨分组且无关系网授权的角色私聊');
          continue;
        }
        const dm = await ensurePeerPrivateChat(userId, peerPrivateIds, {
          parentChatId: sourceChat?.id || ctx.currentChatId || '',
          focalActorId: ownerId || actorId || peerPrivateIds[0],
        });
        const bubbles = [];
        for (const ln of workOp.lines || []) {
          const raw = String(ln.text || '').trim();
          if (!raw) continue;
          let sid = ln.speaker ? await resolveSendTargetId(String(ln.speaker), ctx) : '';
          if (!sid || !peerPrivateIds.includes(sid)) sid = ownerId || actorId || peerPrivateIds[0];
          bubbles.push({ content: raw, senderId: sid });
        }
        if (!bubbles.length) continue;
        const intentText = String(workOp.intent || op.intent || '').trim();
        const stampCount = bubbles.length + 1;
        const tsList = await allocateChatTimestamps(userId, stampCount);
        await saveMessage(createMessage({
          chatId: dm.id,
          senderId: 'system',
          senderName: '剧情',
          type: 'system',
          content: buildSideChatPlotExplainContent(intentText, { userName: ctx.userName }),
          timestamp: tsList[0],
          metadata: metaSend({ peerPrivate: true, plotExplain: true, fromSendOp: true }),
        }));
        for (let i = 0; i < bubbles.length; i += 1) {
          const { content, senderId } = bubbles[i];
          const msg = await createSendOpLineMessage(content, {
            chatId: dm.id,
            senderId,
            senderName: await resolveName(senderId),
            timestamp: tsList[i + 1],
          }, ctx, (base) => ({ ...metaSend(base), peerPrivate: true }));
          if (msg) await saveMessage(msg);
        }
        await updateChatPreview(dm.id, bubbles[bubbles.length - 1].content.slice(0, 80), tsList[tsList.length - 1]);
        if (typeof ctx.onRelayChatWritten === 'function') ctx.onRelayChatWritten(dm.id);
        logs.push(`角色私聊（${bubbles.length}条）`);
        continue;
      }
    }

    if (!allowGroup) {
      receipts.add({
        code: 'social_linkage_disabled',
        status: 'blocked',
        stage: 'send-op',
        eventType: String(type || ''),
      });
      continue;
    }

    if (type === '群聊') {
      const userChats = await listChatsForUser(userId);
      const resolvedLines = [];
      for (const ln of op.lines || []) {
        const raw = String(ln.text || '').trim();
        if (!raw) continue;
        let sid = ln.speaker ? await resolveActorId(String(ln.speaker)) : '';
        if (!sid) sid = actorId;
        if (!sid || sid === 'user') {
          receipts.add({
            code: 'group_line_actor_dropped',
            status: 'dropped',
            stage: 'send-op',
            eventType: 'group',
            context: { actor: String(ln.speaker || '') },
          });
          await debugSystem('[发送:群聊] 行内角色无法解析');
          continue;
        }
        resolvedLines.push({ content: raw, senderId: sid });
      }
      if (!resolvedLines.length) continue;
      const requiredParticipantIds = collectGroupSendParticipantIds(resolvedLines);
      const explicitObserver = resolveExplicitObserverGroupTarget(
        userChats,
        String(op.target || ''),
        requiredParticipantIds,
        userId,
      );
      const targetResolution = explicitObserver.chat
        ? explicitObserver
        : resolveUserGroupTarget(userChats, String(op.target || ''), requiredParticipantIds, userId);
      const g = targetResolution.chat;
      if (!g) {
        receipts.add({
          code: 'group_target_unresolved',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'group',
          context: {
            target: String(op.target || ''),
            requiredParticipantIds: [...new Set(requiredParticipantIds)],
          },
        });
        console.warn('[send-ops] 群聊目标不存在、名称有歧义或成员不匹配:', op.target);
        await debugSystem(`[调试] 群聊目标「${op.target}」不存在、名称有歧义或成员不匹配，已忽略`);
        continue;
      }
      if (targetResolution.resolution.startsWith('corrected_')) {
        receipts.add({
          code: 'group_target_corrected',
          status: 'routed',
          stage: 'send-op',
          eventType: 'group',
          targetChatId: g.id,
          context: {
            requestedTarget: String(op.target || ''),
            resolution: targetResolution.resolution,
          },
        });
      }
      const bubbles = resolvedLines;
      const observerTarget = targetResolution.resolution.startsWith('observer_');
      const tsList = await allocateChatTimestamps(userId, bubbles.length);
      for (let i = 0; i < bubbles.length; i += 1) {
        const { content, senderId } = bubbles[i];
        const sn = await resolveName(senderId);
        const msg = await createSendOpLineMessage(
          content,
          {
            chatId: g.id,
            senderId,
            senderName: sn,
            timestamp: tsList[i],
          },
          ctx,
          observerTarget
            ? (base) => metaSend({ ...base, backstage: true })
            : metaSend,
        );
        if (msg) await saveMessage(msg);
      }
      const lastBubble = bubbles[bubbles.length - 1];
      await updateChatPreview(g.id, lastBubble.content.slice(0, 80), tsList[tsList.length - 1]);
      if (typeof ctx.onRelayChatWritten === 'function') ctx.onRelayChatWritten(g.id);
      receipts.add({
        code: observerTarget ? 'observer_group_send_delivered' : 'group_send_delivered',
        status: 'applied',
        stage: 'send-op',
        eventType: observerTarget ? 'backstage' : 'group',
        targetChatId: g.id,
        context: { speakerIds: [...new Set(bubbles.map((bubble) => bubble.senderId).filter(Boolean))] },
      });
      logs.push(`${observerTarget ? '旁观群' : '群聊'}「${g.groupSettings?.name || op.target}」(${bubbles.length}条)`);
      continue;
    }

    if (type === '幕后') {
      const targetName = String(workOp.target || '').trim();
      if (!targetName) continue;
      const parentChatId = sourceChat?.id || ctx.currentChatId || '';

      const lineTexts = workOp.lines || [];
      const speakerIds = [];
      for (const ln of lineTexts) {
        let sid = ln.speaker ? await resolveActorId(String(ln.speaker)) : '';
        if (!sid && String(ln.text || '').trim() && actorId) sid = actorId;
        if (sid && sid !== 'user') speakerIds.push(sid);
      }
      if (actorId && !speakerIds.includes(actorId)) speakerIds.push(actorId);
      const roomIds = normalizeParticipantIds(speakerIds);
      if (roomIds.length < 2) {
        receipts.add({
          code: 'backstage_roster_incomplete',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'backstage',
          context: { participantIds: roomIds },
        });
        await debugSystem('[backstage] 参与角色不足两人（请块内写多角台词或 [角色] 行，且目标幕后群须能解析成员）');
        continue;
      }
      const explicitTwoObserver = roomIds.length === 2
        ? await findPresetGroupChatForParticipants(userId, roomIds).catch(() => null)
        : null;
      if (roomIds.length === 2 && !isExplicitRelationshipObserverGroup(explicitTwoObserver)) {
        const sociallyEligible = await canPhoneCharacterIdsKnowEachOther(
          roomIds[0],
          roomIds[1],
          userId,
        ).catch(() => false);
        if (sociallyEligible === false) {
          receipts.add({
            code: 'peer_private_social_boundary',
            status: 'blocked',
            stage: 'send-op',
            eventType: 'peer_private',
            context: { participantIds: roomIds },
          });
          continue;
        }
        const peerChat = await ensurePeerPrivateChat(userId, roomIds, {
          parentChatId,
          focalActorId: actorId || roomIds[0],
        });
        const validLines = [];
        for (const ln of lineTexts) {
          const body = String(ln.text || '').trim();
          if (!body) continue;
          let sid = ln.speaker ? await resolveActorId(String(ln.speaker)) : actorId;
          if (!sid || !roomIds.includes(sid)) {
            receipts.add({
              code: 'peer_private_line_actor_dropped',
              status: 'dropped',
              stage: 'send-op',
              eventType: 'peer_private',
              context: { actor: String(ln.speaker || '') },
            });
            continue;
          }
          validLines.push({ body, senderId: sid });
        }
        if (!validLines.length) continue;
        const tsList = await allocateChatTimestamps(userId, validLines.length + 1);
        await saveMessage(createMessage({
          chatId: peerChat.id,
          senderId: 'system',
          senderName: '剧情',
          type: 'system',
          content: buildSideChatPlotExplainContent(workOp.intent || op.intent || '', { userName: ctx.userName }),
          timestamp: tsList[0],
          metadata: metaSend({ fromSendOp: true, peerPrivate: true, plotExplain: true }),
        }));
        for (let i = 0; i < validLines.length; i += 1) {
          const line = validLines[i];
          const msg = await createSendOpLineMessage(line.body, {
            chatId: peerChat.id,
            senderId: line.senderId,
            senderName: await resolveName(line.senderId),
            timestamp: tsList[i + 1],
          }, ctx, (base) => ({ ...metaSend(base), peerPrivate: true }));
          if (msg) await saveMessage(msg);
        }
        await updateChatPreview(
          peerChat.id,
          validLines[validLines.length - 1].body.slice(0, 80),
          tsList[tsList.length - 1],
        );
        if (typeof ctx.onRelayChatWritten === 'function') ctx.onRelayChatWritten(peerChat.id);
        receipts.add({
          code: 'two_actor_backstage_to_peer_private',
          status: 'routed',
          stage: 'send-op',
          eventType: 'peer_private',
          targetChatId: peerChat.id,
          context: { participantIds: roomIds },
        });
        logs.push(`角色私聊（${validLines.length}条）`);
        continue;
      }

      let g = await findBackstageGroupByNameHint(
        userId,
        parentChatId,
        targetName,
        roomIds,
      );
      if (!g) {
        if (!allowGroupCreation) {
          receipts.add({
            code: 'group_creation_disabled',
            status: 'blocked',
            stage: 'send-op',
            eventType: 'backstage',
            context: { memberIds: roomIds, userPresent: false },
          });
          await debugSystem('[发送:幕后] 当前会话已关闭角色自主建群');
          continue;
        }
        if (!canCreateAnotherGroup()) {
          receipts.add({
            code: groupCreationBudget.cooldownBlocked
              ? 'group_creation_cooldown'
              : 'group_creation_round_limit',
            status: 'blocked',
            stage: 'send-op',
            eventType: 'backstage',
            context: { memberIds: roomIds, userPresent: false },
          });
          await debugSystem(groupCreationBudget.cooldownBlocked
            ? '[发送:幕后] 自主建群仍在冷却中'
            : '[发送:幕后] 本轮已经新建过群，已跳过重复拉群');
          continue;
        }
        const existingBackstageIds = new Set((await listBackstageChats(userId))
          .map((chat) => String(chat?.id || ''))
          .filter(Boolean));
        g = await ensureBackstageChat(
          userId,
          parentChatId,
          targetName,
          roomIds,
          { ownerId: actorId || roomIds[0] },
        );
        if (!existingBackstageIds.has(String(g?.id || ''))) consumeGroupCreation();
      } else if (workOp.intent && !g.groupSettings?.intent) {
        g.groupSettings = { ...g.groupSettings, intent: workOp.intent };
        await saveChat(g);
      }

      const tsList = await allocateChatTimestamps(userId, lineTexts.length + 1);
      let msgIdx = 0;
      await saveMessage(createMessage({
        chatId: g.id,
        senderId: 'system',
        senderName: '剧情',
        type: 'system',
        content: buildSideChatPlotExplainContent(workOp.intent || op.intent || '', { userName: ctx.userName }),
        timestamp: tsList[msgIdx],
        metadata: metaSend({ fromSendOp: true, sourceGroupChatId: sourceChat?.id || '', plotExplain: true, backstage: true }),
      }));
      msgIdx += 1;
      for (let i = 0; i < lineTexts.length; i += 1) {
        const ln = lineTexts[i];
        let sid = ln.speaker ? await resolveActorId(String(ln.speaker)) : '';
        if (!sid && String(ln.text || '').trim() && actorId) sid = actorId;
        if (!sid || sid === 'user' || !roomIds.includes(sid)) continue;
        const sn = await resolveName(sid);
        await saveMessage(createMessage({
          chatId: g.id,
          senderId: sid,
          senderName: sn,
          type: 'text',
          content: String(ln.text || '').trim(),
          timestamp: tsList[msgIdx],
          metadata: metaSend({ fromSendOp: true, sourceGroupChatId: sourceChat?.id || '' }),
        }));
        msgIdx += 1;
      }
      const lastLine = lineTexts[lineTexts.length - 1];
      await updateChatPreview(
        g.id,
        String(lastLine?.text || '').slice(0, 80),
        tsList[Math.max(0, msgIdx - 1)] || await getNowForUser(userId),
      );
      if (typeof ctx.onRelayChatWritten === 'function') ctx.onRelayChatWritten(g.id);
      logs.push(`幕后「${targetName}」`);
      continue;
    }

    if (type === '建群') {
      const targetName = String(op.target || '').trim();
      const explicitMembers = (Array.isArray(op.memberIds) && op.memberIds.length)
        ? op.memberIds
        : op.members;
      if (!targetName || !explicitMembers?.length) {
        await debugSystem('[发送:建群] 缺少成员行或群名');
        continue;
      }
      const userLabel = ctx.userName || '用户';
      let hasUser = typeof op.userPresent === 'boolean'
        ? op.userPresent
        : explicitMembers.some((m) => m === '用户' || m === userLabel || m === 'user');

      if (!hasUser && sourceChat && isBackstageListChat(sourceChat) && actorId && userId) {
        const sourceParticipants = Array.isArray(sourceChat.participants) ? sourceChat.participants : [];
        const hasSelectedUserActor = sourceParticipants.includes(actorId);
        if (hasSelectedUserActor) hasUser = true;
      }
      const userChats = await listChatsForUser(userId);
      const charMembers = [];
      for (const m of explicitMembers) {
        if (m === '用户' || m === userLabel || m === 'user') continue;
        const id = await resolveActorId(m);
        if (id && id !== 'user') charMembers.push(id);
      }
      const uniqueChars = [...new Set(charMembers)];
      if (actorId && !uniqueChars.includes(actorId)) {
        receipts.add({
          code: 'group_create_initiator_missing',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'group_create',
          context: { actorId, memberIds: uniqueChars },
        });
        await debugSystem('[发送:建群] 显式成员 ID 未包含发起角色');
        continue;
      }
      let createLineActorInvalid = false;
      let createLineSpeakerMissing = false;
      const repairedSpeakerIds = [];
      for (const ln of op.lines || []) {
        if (!String(ln?.text || '').trim()) continue;
        // 多角色群聊里无署名台词无法可靠判断是谁说的。旧逻辑统一归给发起人，
        // 会把真实的多人抛接显示成一个人连发；宁可拒绝这次脏建群，也不能伪造发送者。
        if (!String(ln?.speaker || '').trim() && uniqueChars.length > 1) {
          createLineSpeakerMissing = true;
          break;
        }
        const sid = ln.speaker ? await resolveActorId(ln.speaker) : actorId;
        if (!sid || sid === 'user') {
          createLineActorInvalid = true;
          break;
        }
        // 发送协议偶尔会在“成员 ID”里漏掉一位实际发言人。只对能精确解析到
        // 现有角色的署名做补全，后续仍统一经过关系边界校验，避免整块静默丢失。
        if (!uniqueChars.includes(sid)) {
          uniqueChars.push(sid);
          repairedSpeakerIds.push(sid);
        }
      }
      if (createLineActorInvalid) {
        receipts.add({
          code: 'group_create_speaker_not_in_roster',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'group_create',
          context: { memberIds: uniqueChars },
        });
        await debugSystem('[发送:建群] 台词发言人不在显式成员 ID 中');
        continue;
      }
      if (createLineSpeakerMissing) {
        receipts.add({
          code: 'group_create_speaker_missing',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'group_create',
          context: { memberIds: uniqueChars },
        });
        await debugSystem('[发送:建群] 多角色群聊正文缺少发言人署名');
        continue;
      }
      if (repairedSpeakerIds.length) {
        receipts.add({
          code: 'group_create_speaker_roster_repaired',
          status: 'repaired',
          stage: 'send-op',
          eventType: 'group_create',
          context: { addedMemberIds: [...new Set(repairedSpeakerIds)] },
        });
      }
      // 无 user 的建群统一交给 ensureBackstageChat；它还要处理沉默成员子集与并发创建，
      // 不能先被这里的“精确成员”短路回较新的重复副本。
      const existing = hasUser
        ? findGroupByParticipantSet(userChats, true, uniqueChars)
        : null;

      if (existing) {
        if (String(existing?.metadata?.groupOrigin || '') === 'send-op') {
          const existingBoundary = await checkPhoneSocialParticipantIds(uniqueChars, userId)
            .catch(() => ({ allowed: false }));
          if (!existingBoundary.allowed) {
            receipts.add({
              code: 'phone_social_group_boundary',
              status: 'blocked',
              stage: 'send-op-existing',
              eventType: 'group_reuse',
              chatId: existing.id,
              context: { memberIds: uniqueChars },
            });
            await debugSystem('[send:group] blocked legacy AI group without social linkage');
            continue;
          }
        }
        const tsList = await allocateChatTimestamps(userId, Math.max(1, (op.lines || []).length));
        let li = 0;
        let lastWrittenText = '';
        for (const ln of op.lines || []) {
          const rawText = String(ln.text || '').trim();
          if (!rawText) continue;
          const explicitSid = await resolveActorId(ln.speaker);
          const fallbackSid = actorId && (existing.participants || []).includes(actorId) ? actorId : '';
          const sid = explicitSid && explicitSid !== 'user' && (existing.participants || []).includes(explicitSid)
            ? explicitSid
            : fallbackSid;
          if (!sid) continue;
          const sn = await resolveName(sid);
          await saveMessage(createMessage({
            chatId: existing.id,
            senderId: sid,
            senderName: sn,
            type: 'text',
            content: rawText,
            timestamp: tsList[li],
            metadata: metaSend({ fromSendOp: true }),
          }));
          lastWrittenText = rawText;
          li += 1;
        }
        if (li > 0) {
          await updateChatPreview(
            existing.id,
            lastWrittenText.slice(0, 80),
            tsList[Math.max(0, li - 1)] || await getNowForUser(userId),
          );
          if (typeof ctx.onRelayChatWritten === 'function') ctx.onRelayChatWritten(existing.id);
        }
        const existingName = String(existing.groupSettings?.name || '').trim() || targetName;
        logs.push(
          existingName === targetName
            ? `建群（含用户，已存在）「${targetName}」`
            : `建群（含用户，成员一致，复用已有群）「${existingName}」`,
        );
        continue;
      }

      // “允许跨窗联动”仍可用于续写已有群；新开群由独立开关控制。
      // 这里在真正落库前再拦一次，避免模型忽略提示词时仍把用户拉进新群。
      if (!allowGroupCreation) {
        receipts.add({
          code: 'group_creation_disabled',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'group_create',
          context: { memberIds: uniqueChars, userPresent: hasUser },
        });
        await debugSystem('[发送:建群] 当前会话已关闭角色自主建群');
        continue;
      }
      if (!canCreateAnotherGroup()) {
        receipts.add({
          code: groupCreationBudget.cooldownBlocked
            ? 'group_creation_cooldown'
            : 'group_creation_round_limit',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'group_create',
          context: { memberIds: uniqueChars, userPresent: hasUser },
        });
        await debugSystem(groupCreationBudget.cooldownBlocked
          ? '[发送:建群] 自主建群仍在冷却中'
          : '[发送:建群] 本轮已经新建过群，已跳过重复拉群');
        continue;
      }

      if (hasUser) {
        if (uniqueChars.length < 1) {
          await debugSystem('[发送:建群] 含用户时至少需一名角色成员');
          continue;
        }
      } else if (uniqueChars.length < 3) {
        await debugSystem('[发送:建群] 新建无用户幕后群至少需要三名明确角色');
        continue;
      }

      const socialBoundary = await checkPhoneSocialParticipantIds(uniqueChars, userId)
        .catch(() => ({ allowed: false }));
      if (!socialBoundary.allowed) {
        receipts.add({
          code: 'phone_social_group_boundary',
          status: 'blocked',
          stage: 'send-op',
          eventType: 'group_create',
          context: {
            memberIds: uniqueChars,
            blockedPair: [
              socialBoundary.pair?.leftId,
              socialBoundary.pair?.rightId,
            ].filter(Boolean),
          },
        });
        await debugSystem('[发送:建群] 已拦截尚未建立社交联系的角色组合');
        continue;
      }
      const ownerId = actorId && uniqueChars.includes(actorId) ? actorId : uniqueChars[0];
      let gNew;
      let reusedByEnsure = false;
      if (hasUser) {
        gNew = createChat({
          type: 'group',
          userId,
          participants: ['user', ...uniqueChars],
          groupSettings: {
            name: targetName,
            owner: ownerId,
            admins: [ownerId],
            isObserverMode: false,
            plotDirective: '发送协议建群',
            intent: op.intent || '',
          },
          metadata: {
            channel: 'scrapbook',
            groupOrigin: 'send-op',
            parentChatId: '',
          },
        });
        await saveChat(gNew);
        consumeGroupCreation();
      } else {
        const parentChatId = String(sourceChat?.id || ctx.currentChatId || '');
        gNew = await ensureBackstageChat(userId, parentChatId, targetName, uniqueChars);
        reusedByEnsure = userChats.some((chat) => chat.id === gNew.id);
        gNew.groupSettings = {
          ...(gNew.groupSettings || {}),
          owner: gNew.groupSettings?.owner || ownerId,
          admins: (gNew.groupSettings?.admins || []).length ? gNew.groupSettings.admins : [ownerId],
          isObserverMode: true,
          plotDirective: gNew.groupSettings?.plotDirective || '角色对角色幕后（发送协议）',
          intent: gNew.groupSettings?.intent || op.intent || '',
        };
        gNew.metadata = {
          ...(gNew.metadata || {}),
          groupOrigin: gNew.metadata?.groupOrigin || 'send-op',
        };
        await saveChat(gNew);
        if (!reusedByEnsure) consumeGroupCreation();
      }

      const lineCount = (op.lines || []).length;
      const tsList = await allocateChatTimestamps(userId, Math.max(1, lineCount));
      let idx = 0;
      let lastWrittenText = '';
      for (const ln of op.lines || []) {
        const rawText = String(ln.text || '').trim();
        if (!rawText) continue;
        const explicitSid = await resolveActorId(ln.speaker);
        const fallbackSid = actorId && (gNew.participants || []).includes(actorId) ? actorId : '';
        const sid = explicitSid && explicitSid !== 'user' && (gNew.participants || []).includes(explicitSid)
          ? explicitSid
          : fallbackSid;
        if (!sid) continue;
        const sn = await resolveName(sid);
        await saveMessage(createMessage({
          chatId: gNew.id,
          senderId: sid,
          senderName: sn,
          type: 'text',
          content: rawText,
          timestamp: tsList[idx],
          metadata: metaSend({ fromSendOp: true }),
        }));
        lastWrittenText = rawText;
        idx += 1;
      }
      if (idx > 0) {
        await updateChatPreview(
          gNew.id,
          lastWrittenText.slice(0, 80),
          tsList[Math.max(0, idx - 1)] || await getNowForUser(userId),
        );
      }
      if (typeof ctx.onRelayChatWritten === 'function') ctx.onRelayChatWritten(gNew.id);

      if (hasUser && sourceChat?.id && actorId) {
        const invTs = await nextChatMessageTimestamp(userId);
        const inviterName = await resolveName(actorId);
        await saveMessage(createMessage({
          chatId: sourceChat.id,
          senderId: 'system',
          senderName: '系统',
          type: 'system',
          content: `${inviterName} 邀请你加入群聊：${targetName}`,
          timestamp: invTs,
          metadata: metaSend({
            targetChatId: gNew.id,
            groupName: targetName,
            inviterId: actorId,
            inviteState: 'pending',
            existingGroup: false,
            fromSendOp: true,
          }),
        }));
      }

      logs.push(hasUser
        ? `建群（含用户）「${targetName}」`
        : (reusedByEnsure
          ? `建群（复用幕后群）「${targetName}」`
          : `建群（无用户）「${targetName}」`));
    }
  }

  return attachReceipts(logs, receipts.list());
}

/**
 * 微博/论坛 chatShares → 与 parseSendBlocks 同结构的 ops（供 executeSendOps）
 */
export function normalizeSocialShares(chatShares, sourceType = 'weibo', sourceId = '') {
  const list = Array.isArray(chatShares) ? chatShares : [];
  const out = [];
  for (const share of list) {
    const actionRaw = String(share.action || share.targetType || '群聊').trim();
    const low = actionRaw.toLowerCase?.() || actionRaw;
    const typeMap = {
      群聊: '群聊',
      群: '群聊',
      group: '群聊',
      group_chat: '群聊',
      建群: '建群',
      create_group: '建群',
      私聊: '私聊',
      private: '私聊',
      private_user: '私聊',
    };
    const type = typeMap[actionRaw] || typeMap[low] || '群聊';
    const target = String(share.groupName || share.group || '').trim();
    const idx = share.postIndex ?? 0;
    const linkRepl = (t) => String(t || '').replace(/\[链接\]/g, `[${sourceType}://${sourceId}/${idx}]`);
    const rawLines = Array.isArray(share.lines) ? share.lines : [];
    const lines = rawLines.map((l) => {
      if (typeof l === 'string') {
        return {
          speaker: String(share.forwarderName || '').trim(),
          text: linkRepl(l),
        };
      }
      return {
        speaker: String(l.speaker || l.forwarderName || share.forwarderName || '').trim(),
        text: linkRepl(l.text || ''),
      };
    }).filter((l) => l.text);
    const members = Array.isArray(share.members) ? share.members : null;
    const intent = share.intent ? String(share.intent) : null;
    let actorOverride = '';
    if (share.forwarderId) actorOverride = String(share.forwarderId).trim();
    out.push({
      type,
      target,
      members,
      intent,
      lines,
      actorOverride: actorOverride || null,
      forwarderName: String(share.forwarderName || '').trim(),
      raw: null,
    });
  }
  return out;
}
