/**
 * 主聊上下文：手机拦截箱（仅相关话题命中时注入）。
 * - 命中某分类关键词 → 注入该分类全部会话全文
 * - 提到某个拦截联系人 → 注入该人整扇窗全文
 * - 仅泛提黑名单/拦截箱 → 只给名单概览，不灌全部聊天
 * 日常不进记忆库、不常驻 timeline。
 */
import { getCharacterAiContextName } from '../../models/character.js';
import { loadCharacterPhoneContacts } from '../character-phone-contacts.js';
import {
  listCharacterPhoneInterceptChats,
  resolvePhoneChatTitle,
} from '../character-phone-messages.js';
import { listMessagesForChat } from '../chat-store.js';
import { normalizeKind } from '../character-phone-intercept.js';

const GENERIC_INTERCEPT_RE = /黑名单|拉黑|拦截|拦截箱|陌生人|陌生人消息/;

/** 分类触发词：命中则拉取该 kind 下全部分会话 */
const KIND_TRIGGERS = Object.freeze([
  { kind: 'enemy', re: /死敌|仇人|宿敌|仇家|敌对/, label: '死敌仇人' },
  { kind: 'ad', re: /广告|推销|营销/, label: '广告推销' },
  { kind: 'scam', re: /诈骗|骗局|钓鱼/, label: '诈骗' },
  { kind: 'ex', re: /前任|前女友|前男友|旧爱/, label: '前任纠缠' },
  { kind: 'fan', re: /粉丝|饭圈|站姐|粉丝缠/, label: '狂热粉丝' },
  { kind: 'unrequited', re: /爱而不得|单恋|暗恋|舔狗/, label: '爱而不得' },
  { kind: 'harass', re: /骚扰|纠缠|被缠/, label: '骚扰纠缠' },
]);

const KIND_LABEL = Object.freeze(Object.fromEntries(
  KIND_TRIGGERS.map((row) => [row.kind, row.label]),
));

/** 单扇窗注入软上限，避免一次把 prompt 撑爆；超出则从最早处截断并注明 */
const MAX_THREAD_CHARS = 4500;
const MAX_MSG_LINE = 120;
const MAX_THREADS_PER_OWNER = 12;

function buildRecentHaystack(recentMessages = [], limit = 18) {
  return (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((m) => m && !m.deleted && !m.recalled)
    .slice(-Math.max(1, limit))
    .map((m) => String(m.content || m.metadata?.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

function detectHitKinds(hay = '') {
  const text = String(hay || '');
  if (!text) return [];
  const hit = [];
  for (const row of KIND_TRIGGERS) {
    if (row.re.test(text)) hit.push(row.kind);
  }
  return hit;
}

function contactDisplayNames(contact = {}) {
  return [...new Set([
    String(contact.name || '').trim(),
    String(contact.nickname || '').trim(),
  ].filter((name) => name.length >= 2))];
}

/**
 * 最近对话里点到的拦截联系人（人名优先于泛关键词）。
 * 长名优先匹配，减少短名误伤。
 */
function detectMentionedContacts(hay = '', contacts = []) {
  const text = String(hay || '');
  if (!text || !contacts.length) return [];
  const ranked = [...contacts]
    .map((item) => ({
      contact: item,
      names: contactDisplayNames(item).sort((a, b) => b.length - a.length),
    }))
    .filter((row) => row.names.length)
    .sort((a, b) => (b.names[0]?.length || 0) - (a.names[0]?.length || 0));

  const hit = [];
  const usedSpans = [];
  for (const row of ranked) {
    const matched = row.names.find((name) => text.includes(name));
    if (!matched) continue;
    // 已被更长名字覆盖的同段不再重复计入
    if (usedSpans.some((span) => span.includes(matched) || matched.includes(span))) continue;
    usedSpans.push(matched);
    hit.push(row.contact);
  }
  return hit;
}

function contactKind(contact = {}) {
  return normalizeKind(contact.blockReason || contact.note || '');
}

function chatPeerId(chat, ownerId = '') {
  return (chat?.participants || []).find((id) => id && id !== ownerId && id !== 'user') || '';
}

function resolveChatKind(chat, contactByPeer = new Map()) {
  const peerId = chatPeerId(chat, chat?.metadata?.phoneOwnerId);
  const fromContact = contactByPeer.get(peerId);
  if (fromContact) return contactKind(fromContact);
  return normalizeKind(chat?.metadata?.interceptKind || '');
}

export function recentMessagesMentionPhoneIntercept(recentMessages = [], recentChatBlob = '', contacts = []) {
  const hay = String(recentChatBlob || '').trim() || buildRecentHaystack(recentMessages);
  if (!hay) return false;
  if (GENERIC_INTERCEPT_RE.test(hay)) return true;
  if (detectHitKinds(hay).length) return true;
  if (detectMentionedContacts(hay, contacts).length) return true;
  return false;
}

function formatMessageLine(msg, nameMap = {}, ownerId = '', ownerName = 'TA') {
  const senderId = String(msg?.senderId || '').trim();
  const who = senderId === ownerId
    ? ownerName
    : (nameMap[senderId]?.realName || nameMap[senderId]?.name || msg?.senderName || '对方');
  const body = String(msg?.content || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const clipped = body.length > MAX_MSG_LINE ? `${body.slice(0, MAX_MSG_LINE - 1)}…` : body;
  return `${who}：${clipped}`;
}

async function loadFullThreadLines(chat, {
  ownerId = '',
  ownerName = 'TA',
  nameMap = {},
} = {}) {
  const messages = (await listMessagesForChat(chat.id, 0).catch(() => []))
    .filter((m) => m && !m.deleted && !m.recalled && m.senderId !== 'system' && m.type !== 'system');
  if (!messages.length) return { lines: [], truncated: false, count: 0 };

  const formatted = messages
    .map((m) => formatMessageLine(m, nameMap, ownerId, ownerName))
    .filter(Boolean);

  let truncated = false;
  let kept = formatted;
  let total = kept.join('\n').length;
  if (total > MAX_THREAD_CHARS) {
    truncated = true;
    // 保留尾部（更近的往来），丢掉更早的部分
    kept = [];
    total = 0;
    for (let i = formatted.length - 1; i >= 0; i -= 1) {
      const nextLen = total + formatted[i].length + (kept.length ? 1 : 0);
      if (nextLen > MAX_THREAD_CHARS && kept.length) break;
      kept.unshift(formatted[i]);
      total = nextLen;
    }
  }
  return { lines: kept, truncated, count: formatted.length };
}

function contactMatchesSelection(contact, { hitKinds = [], mentionedIds = new Set() } = {}) {
  if (mentionedIds.has(contact.id) || (contact.linkedCharacterId && mentionedIds.has(contact.linkedCharacterId))) {
    return true;
  }
  if (hitKinds.length && hitKinds.includes(contactKind(contact))) return true;
  return false;
}

/**
 * @returns {Promise<string>} 未命中返回空串
 */
export async function buildPhoneInterceptContextBlock({
  userId = '',
  partnerIds = [],
  characters = {},
  recentMessages = [],
  recentChatBlob = '',
} = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return '';

  const owners = [...new Set((Array.isArray(partnerIds) ? partnerIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))].slice(0, 3);
  if (!owners.length) return '';

  const hay = String(recentChatBlob || '').trim() || buildRecentHaystack(recentMessages);
  if (!hay) return '';

  // 联系人是单个小设置项，可以并行读取；拦截会话列表会触发身份修复、迁移与
  // 多张表扫描，只在本轮文字真的命中相关主题后再启动。过去两者无条件并行，
  // 普通一句闲聊也会为每个角色跑完整手机列表链路。
  const ownerContexts = await Promise.all(owners.map(async (ownerId) => ({
    ownerId,
    ownerName: getCharacterAiContextName(characters?.[ownerId], ownerId) || ownerId,
    contactsState: await loadCharacterPhoneContacts(uid, ownerId)
      .catch(() => ({ contacts: [] })),
  })));

  const sections = [];
  for (const { ownerId, ownerName, contactsState } of ownerContexts) {
    const interceptContacts = (contactsState.contacts || [])
      .filter((item) => item && (item.blocked || item.interceptSource));

    // 人名也可单独开门（不必先说「骚扰」）
    if (!recentMessagesMentionPhoneIntercept(recentMessages, hay, interceptContacts)) continue;

    const hitKinds = detectHitKinds(hay);
    const mentioned = detectMentionedContacts(hay, interceptContacts);
    const mentionedIds = new Set(mentioned.flatMap((c) => [c.id, c.linkedCharacterId].filter(Boolean)));
    const genericOnly = !hitKinds.length && !mentioned.length && GENERIC_INTERCEPT_RE.test(hay);

    // 泛提黑名单时联系人摘要已经足够，不必为了一个不会展开的会话列表执行迁移。
    // 没有联系人时仍读取一次会话列表，兼容历史上只剩拦截线程的存档。
    const chats = genericOnly && interceptContacts.length
      ? []
      : await listCharacterPhoneInterceptChats(uid, ownerId).catch(() => []);
    if (!interceptContacts.length && !chats.length) continue;

    const nameMap = { ...(characters || {}) };
    for (const item of (contactsState.contacts || [])) {
      if (!item?.id) continue;
      nameMap[item.id] = {
        id: item.id,
        name: item.name || item.nickname || item.id,
        realName: item.name || item.nickname || '',
      };
    }

    const contactByPeer = new Map();
    for (const item of interceptContacts) {
      contactByPeer.set(item.id, item);
      if (item.linkedCharacterId) contactByPeer.set(item.linkedCharacterId, item);
    }

    const lines = [];
    lines.push(`【私有手机上下文｜ownerId=${ownerId}｜${ownerName} 的手机拦截箱 · 仅当对话聊到相关话题时参考】`);
    lines.push(`归属硬规则：本块只属于 ownerId=${ownerId}。只有该角色本人可以把其中内容当作自己看过的手机记录；同场其他角色、群友和用户不会因共享同一轮提示而自动知道。`);
    lines.push('说明：这是手机里被拦截/拉黑的陌生人与纠缠对象，不是用户本人的消息；角色可「看一眼」后用自己口吻回应，勿复述内部 id。');

    if (genericOnly) {
      lines.push('当前只泛提到拦截/黑名单：先给完整名单。若用户追问某一类或某个人，下一轮再展开对应全文。');
      lines.push('黑名单 / 拦截联系人：');
      for (const item of interceptContacts.slice(0, 20)) {
        const kind = contactKind(item);
        const label = KIND_LABEL[kind] || '拦截';
        const hint = item.personaCapsule?.relationship || '';
        lines.push(`- ${item.name || item.nickname || '某人'}（${label}${hint ? ` · ${hint}` : ''}）`);
      }
      sections.push(lines.join('\n'));
      continue;
    }

    const selectedContacts = interceptContacts.filter((item) => contactMatchesSelection(item, {
      hitKinds,
      mentionedIds,
    }));
    if (selectedContacts.length) {
      const scope = [
        hitKinds.length ? `分类 ${hitKinds.map((k) => KIND_LABEL[k] || k).join('、')}` : '',
        mentioned.length ? `点名 ${mentioned.map((c) => c.name || c.nickname).filter(Boolean).join('、')}` : '',
      ].filter(Boolean).join('；');
      lines.push(`本轮命中范围：${scope || '相关拦截对象'}`);
      lines.push('相关联系人：');
      for (const item of selectedContacts.slice(0, 16)) {
        const kind = contactKind(item);
        const label = KIND_LABEL[kind] || '拦截';
        const hint = item.personaCapsule?.relationship || '';
        lines.push(`- ${item.name || item.nickname || '某人'}（${label}${hint ? ` · ${hint}` : ''}）`);
      }
    }

    const selectedChats = chats.filter((chat) => {
      const peerId = chatPeerId(chat, ownerId);
      if (peerId && mentionedIds.has(peerId)) return true;
      const contact = contactByPeer.get(peerId);
      if (contact && mentionedIds.has(contact.id)) return true;
      if (hitKinds.length) {
        const kind = resolveChatKind(chat, contactByPeer);
        if (hitKinds.includes(kind)) return true;
        if (contact && hitKinds.includes(contactKind(contact))) return true;
      }
      return false;
    }).slice(0, MAX_THREADS_PER_OWNER);

    for (const chat of selectedChats) {
      const title = resolvePhoneChatTitle(chat, ownerId, nameMap, '用户');
      const peerId = chatPeerId(chat, ownerId);
      const contact = contactByPeer.get(peerId);
      const kind = contact ? contactKind(contact) : resolveChatKind(chat, contactByPeer);
      const label = KIND_LABEL[kind] || '拦截';
      const { lines: threadLines, truncated, count } = await loadFullThreadLines(chat, {
        ownerId,
        ownerName,
        nameMap,
      });
      if (!threadLines.length) continue;
      lines.push(`—— 拦截会话「${title}」（${label} · 共 ${count} 条${truncated ? '，已截取较近部分' : '全文'}）——`);
      lines.push(...threadLines);
    }

    if (lines.length <= 3) continue;
    sections.push(lines.join('\n'));
  }

  if (!sections.length) return '';
  return [
    '【多角色手机记忆防串用】下方每个块都有唯一 ownerId。生成某个角色的发言时，只能读取该角色自己的块；禁止把 A 手机里的陌生消息、黑名单或纠缠对象写成 B 看过、收到过或处理过。',
    ...sections,
  ].join('\n\n').trim();
}
