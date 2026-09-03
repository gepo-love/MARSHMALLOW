/**
 * 跨会话接入：私↔群继承上下文 + 跨窗口最新焦点（按时间最新优先衔接）
 *
 * 对齐原版 private-group-carry.js / buildPrivateCarryContext / buildCrossChatLatestFocusContext：
 *  - 私聊窗口：注入对方所在各群的近期公屏（【群聊继承上下文/对方】）
 *  - 群聊窗口：注入各 AI 成员与 user 的近期私聊片段（【私聊继承上下文/成员】）
 *  - 最新焦点：跨窗口最近消息的时间锚点，防止把旧尾巴误当成"刚刚"
 */
import * as db from '../db.js';
import { listRecentMessagesForContext } from '../recent-message-store.js';
import {
  isAnonymousChat,
  isPeerPrivateChat,
  isUserPresentInChat,
  formatMessageForContext,
} from '../chat-helpers.js';
import { resolveCharacterAiContextName } from '../../models/character.js';
import { getUserDisplayName } from '../../models/user.js';
import { resolveAllowUserMainChatContext } from '../../models/chat.js';
import { getNowForUser } from '../time-mode.js';
import { filterNonGuidanceMessages } from '../guidance-memory.js';
import { getAnonymousMainChatInjectMode } from '../anonymous-chat.js';
import { resolveAnonymousMainChatMessageLimit } from '../../data/anonymous-room-presets.js';
import {
  isStrangerInterceptChat,
  normalizeRevealEntry,
  resolveAliasThreadMainChatShareMode,
} from '../stranger-thread-model.js';
import { principalKey } from '../alias-account-model.js';
import { getAliasAccount, isAliasAccountRevoked } from '../alias-account-store.js';
import { loadChatPrefs } from '../chat-block-state.js';
import { normalizeMemoryInjectionSettings } from './memory-injection-settings.js';
import { listAliasAwareness } from './memory-facts.js';
import { formatMemorySourceChatLabel } from './memory-chat-label.js';
import {
  filterRowsAfterCharacterReset,
  loadCharacterProgressResetAt,
} from '../character-progress-reset-state.js';
import {
  audienceCanReceiveSource,
  collectExplicitKnownBy,
  normalizeAudienceCharacterIds,
} from '../context/context-injection-scope.js';
import {
  filterCharStateHistoryForUser,
  loadChatCharStateHistory,
  sanitizeInnerVoiceText,
  sanitizeIntentText,
  sanitizeStatusText,
} from '../chat/character-state.js';

function displayName(id, characters = {}) {
  if (!id || id === 'user') return '用户';
  return resolveCharacterAiContextName(id, characters);
}

function chatLabel(chat, characters = {}, options = {}) {
  return formatMemorySourceChatLabel(chat, characters, options);
}

function excerpt(text = '', cap = 80) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

function relTime(ts, now) {
  const diff = Math.max(0, Number(now) - Number(ts));
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  return `${d}天前`;
}

function pad2(n) {
  return Number(n) < 10 ? `0${Number(n)}` : `${Number(n)}`;
}

/** 绝对时间标签：几月几号几点 */
function absTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 一条消息的时间戳标签：[6月22日 23:10·4天前] */
function msgTimeTag(ts, now) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const abs = absTime(t);
  return abs ? `[${abs}·${relTime(t, now)}] ` : '';
}

function isPlotExplainMessage(m = {}) {
  return m?.metadata?.plotExplain === true
    || (m?.senderId === 'system' && /^【剧情解释】/.test(String(m?.content || '').trim()));
}

function formatSideRecapLine(m, now, userName, characters = {}, whoOverride = '') {
  const body = excerpt(
    formatMessageForContext(m, userName, { characters }),
    isPlotExplainMessage(m) || m?.metadata?.phoneProxyByUser === true ? 320 : 110,
  );
  if (isPlotExplainMessage(m)) return `${msgTimeTag(m.timestamp, now)}${body}`;
  const who = whoOverride
    || (m.senderId === 'user' ? userName : displayName(m.senderId, characters));
  return `${msgTimeTag(m.timestamp, now)}${who}: ${body}`;
}

async function recentMessages(chatId, cap) {
  const rows = await db.getAllByIndex('messages', 'chatId', chatId).catch(() => []);
  return filterNonGuidanceMessages(Array.isArray(rows) ? rows : [])
    .filter((m) => m && !m.deleted && !m.recalled && (m.type !== 'system' || m.metadata?.plotExplain === true))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-Math.max(1, cap));
}

/**
 * 读取某个角色在指定来源窗口里的最近心理状态。
 *
 * 心声仍然只属于角色本人：这里不会把它转成共享事件，也不会写进其它角色的
 * 状态仓。requireUserName=true 用于 user 正在场的普通群私聊，继续遵守前台身份
 * 隔离；角色手机、匿名房等本人亲历回流则只按稳定 userId 隔离。
 */
async function recentCharacterStateEntries(chatId, characterId, {
  userId = '',
  userName = '',
  requireUserName = true,
  limit = 3,
} = {}) {
  const raw = await loadChatCharStateHistory(chatId, characterId, { userId }).catch(() => []);
  const scoped = requireUserName
    ? filterCharStateHistoryForUser(raw, userName, userId)
    : raw.filter((entry) => String(entry?.userId || '').trim() === String(userId || '').trim());
  const seen = new Set();
  return scoped
    .map((entry) => ({
      ...entry,
      inner: sanitizeInnerVoiceText(entry?.inner || '', userName),
      intent: sanitizeIntentText(entry?.intent || '', userName),
      status: sanitizeStatusText(entry?.status || '', userName),
    }))
    .filter((entry) => {
      const key = `${entry.inner}\n${entry.intent}\n${entry.status}`.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(0, Math.min(4, Number(limit) || 0)));
}

function formatCrossWindowStateBlock(entries = [], characterName = '角色', now = Date.now()) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return '';
  const lines = list.map((entry) => {
    const parts = [];
    if (entry.inner) parts.push(`当时心声「${excerpt(entry.inner, 220)}」`);
    if (entry.intent) parts.push(`当时心思「${excerpt(entry.intent, 100)}」`);
    if (entry.status) parts.push(`当时状态「${excerpt(entry.status, 100)}」`);
    const recordedAt = Number(entry.recordedAt || 0) || 0;
    return `- ${msgTimeTag(recordedAt, now)}${parts.join('；')}`;
  });
  return [
    `【${characterName}在该窗口的最近心理余波 · 仅本人可用】`,
    ...lines,
    '这些是角色本人当时真实保存的私人状态，不是说出口的台词，也不是当前窗口其他人的知识。承接仍未消化的情绪、心结、意图与状态变化；若后来剧情已经改变它，就按时间顺序推进，禁止退回较旧心态。不要照抄原句，也不要为了保密而让本人失忆。',
  ].join('\n');
}

/** 群聊窗口：注入各 AI 成员与 user 的最近私聊片段 */
export async function buildPrivateCarryForGroup({
  chat,
  userId,
  userName = '用户',
  characters = {},
  recentMessageLimit = 40,
  relatedChatLimit = 6,
  includeCharacterState = true,
}) {
  if (chat?.type !== 'group' || isAnonymousChat(chat) || !userId) return '';
  if (!resolveAllowUserMainChatContext(chat)) return '';
  const safeRecentLimit = Math.max(0, Math.floor(Number(recentMessageLimit) || 0));
  const safeRelatedChatLimit = Math.max(0, Math.floor(Number(relatedChatLimit) || 0));
  if (!safeRecentLimit || !safeRelatedChatLimit) return '';
  const aiIds = (chat.participants || []).filter((id) => id && id !== 'user');
  if (!aiIds.length) return '';
  const actorPrivate = aiIds.length > 1;
  const now = await getNowForUser(userId).catch(() => Date.now());
  const allChats = await db.getAllByIndex('chats', 'userId', userId).catch(() => []);
  const dmByMember = new Map();
  for (const c of Array.isArray(allChats) ? allChats : []) {
    if (c?.type !== 'private' || isAnonymousChat(c)) continue;
    if (!Array.isArray(c.participants) || !c.participants.includes('user')) continue;
    const pid = c.participants.find((p) => p && p !== 'user');
    if (!pid || !aiIds.includes(pid)) continue;
    const prev = dmByMember.get(pid);
    if (!prev || (c.lastActivity || 0) > (prev.lastActivity || 0)) dmByMember.set(pid, c);
  }
  const entries = [...dmByMember.entries()]
    .sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0))
    .slice(0, Math.min(aiIds.length, safeRelatedChatLimit));
  const blocks = [];
  for (const [pid, dm] of entries) {
    const who = displayName(pid, characters);
    const [msgs, stateEntries] = await Promise.all([
      recentMessages(dm.id, safeRecentLimit),
      includeCharacterState ? recentCharacterStateEntries(dm.id, pid, {
        userId,
        userName,
        requireUserName: true,
        limit: 3,
      }) : Promise.resolve([]),
    ]);
    if (!msgs.length && !stateEntries.length) continue;
    const lines = msgs.map((m) => {
      const name = m.senderId === 'user' ? userName : displayName(m.senderId, characters);
      return `${msgTimeTag(m.timestamp, now)}${name}: ${excerpt(formatMessageForContext(m, userName, { characters }))}`;
    });
    const stateBlock = formatCrossWindowStateBlock(stateEntries, who, now);
    const lastTs = Math.max(
      Number(msgs[msgs.length - 1]?.timestamp || 0) || 0,
      Number(stateEntries[0]?.recordedAt || 0) || 0,
    );
    const spanHint = lastTs ? `（这些是 ${relTime(lastTs, now)} 的旧私聊，每条都带时间戳，别当成此刻刚发生）` : '';
    blocks.push(
      `${actorPrivate ? `◆ 【仅 ${who} 可用的私有认知｜角色ID:${pid}】\n` : ''}`
      + `【私聊继承上下文/${who}】${spanHint}\n`
      + `以下为「${who}」与${userName}的最近私聊片段，每条前面方括号是它真实发生的时间；请按这些时间承接，不要把旧记录当成刚刚发生，也不要当作首次认识：\n`
      + [lines.join('\n'), stateBlock].filter(Boolean).join('\n'),
    );
  }
  if (!blocks.length) return '';
  if (!actorPrivate) return blocks.join('\n\n');
  return [
    '【群聊成员私有记忆胶囊 · 最高知情边界】',
    '群聊共用一份技术 prompt，不代表下面的私聊内容被全群看见。每个 ◆ 区块只有标题标出的角色本人知道。',
    '生成某个角色的 msg/state/inner/intent 前，只能读取该角色自己的 ◆ 区块；其中最近心理余波也只属于本人。其他角色禁止引用、接话、影射、猜中或表现得已经知道。',
    '这些私聊事实可以影响持有者自己的判断、情绪和措辞，但除非持有者在群公屏主动说出，否则不能升级成群内共同事实。',
    '窗口切换不会让角色失忆：即使群公屏是后来才打开的线程，角色仍要按自己私聊里更完整的关系与事件进度回应；禁止声称“私聊和群聊记忆不互通”。',
    blocks.join('\n\n'),
  ].join('\n');
}

/**
 * 私聊窗口：若这段私聊曾经拉起过幕后（秘密基地）群聊，给幕后里除当前对话对象外的其他参与者
 * 各自补一份自己与 user 私聊窗口的最近片段。幕后是同一轮调用生成的，被拉进幕后的角色本没有
 * 自己窗口的记忆，只能照当前私聊上文脑补，容易张冠李戴——这里把各自真实的窗口记忆带回去。
 */
export async function buildBackstagePeerContextBlock({ chat, userId, userName = '用户', characters = {} }) {
  if (chat?.type !== 'private' || isAnonymousChat(chat) || !userId) return '';
  const partnerId = (chat.participants || []).find((p) => p && p !== 'user');
  if (!chat.id) return '';
  const allChats = await db.getAllByIndex('chats', 'userId', userId).catch(() => []);
  const list = Array.isArray(allChats) ? allChats : [];
  const backstageRooms = list
    .filter((c) => c?.type === 'group'
      && c?.metadata?.channel === 'backstage'
      && (String(c.metadata?.parentChatId || '') === String(chat.id)
        || (Array.isArray(c.metadata?.linkedParentChatIds) && c.metadata.linkedParentChatIds.includes(chat.id)))
      && audienceCanReceiveSource({
        audienceCharacterIds: [partnerId],
        sourceChat: c,
        record: { knownBy: collectExplicitKnownBy(c) },
        currentChatId: chat.id,
      }))
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, 2);
  if (!backstageRooms.length) return '';

  const peerIds = new Set();
  for (const room of backstageRooms) {
    for (const pid of Array.isArray(room.participants) ? room.participants : []) {
      const id = String(pid || '').trim();
      if (id && id !== 'user' && id !== partnerId) peerIds.add(id);
    }
  }
  if (!peerIds.size) return '';

  const dmByMember = new Map();
  for (const c of list) {
    if (c?.type !== 'private' || isAnonymousChat(c)) continue;
    if (!Array.isArray(c.participants) || !c.participants.includes('user')) continue;
    const pid = c.participants.find((p) => p && p !== 'user');
    if (!pid || !peerIds.has(pid)) continue;
    const prev = dmByMember.get(pid);
    if (!prev || (c.lastActivity || 0) > (prev.lastActivity || 0)) dmByMember.set(pid, c);
  }
  if (!dmByMember.size) return '';

  const now = await getNowForUser(userId).catch(() => Date.now());
  const entries = [...dmByMember.entries()].slice(0, 2);
  const blocks = [];
  for (const [pid, dm] of entries) {
    const msgs = await recentMessages(dm.id, 6);
    if (!msgs.length) continue;
    const who = displayName(pid, characters);
    const lines = msgs.map((m) => {
      const name = m.senderId === 'user' ? userName : displayName(m.senderId, characters);
      return `${msgTimeTag(m.timestamp, now)}${name}: ${excerpt(formatMessageForContext(m, userName, { characters }))}`;
    });
    blocks.push(`◆ ${who}：\n${lines.join('\n')}`);
  }
  if (!blocks.length) return '';

  return [
    `【幕后参照 · 各自窗口近况】以下是可能在幕后开口的角色各自与${userName}私聊窗口的最近片段（带时间标注，这是各角色自己的真实记忆）。幕后发言以此为底：每个角色自己跟${userName}聊过什么、聊到哪一步、当时什么情绪，都以自己窗口为准；不要照着别人窗口的内容脑补自己的经历，也不要把不知道的事当成知道。`,
    blocks.join('\n\n'),
  ].join('\n');
}

/**
 * 私聊窗口：把对方角色自己最近参与过的幕后（秘密基地）对话回灌进来。
 * 幕后小剧场生成完只躺在自己的群窗口里，角色回到私聊对这段"自己经历过的事"毫无记忆，
 * 关系网永远长不出可分享的近况——这里让 TA 记得自己私下和谁聊了什么。
 */
export async function buildBackstageEchoBlock({
  chat,
  userId,
  userName = '用户',
  characters = {},
  focusCharacterId = '',
  includeCharacterState = true,
} = {}) {
  if (!chat || isAnonymousChat(chat) || !userId) return '';
  const requestedFocusId = String(focusCharacterId || '').trim();
  const isPhoneOwnerScope = !!requestedFocusId
    && !isUserPresentInChat(chat)
    && Array.isArray(chat.participants)
    && chat.participants.includes(requestedFocusId);
  if (chat.type !== 'private' && !isPhoneOwnerScope) return '';
  const partnerId = requestedFocusId && (chat.participants || []).includes(requestedFocusId)
    ? requestedFocusId
    : (chat.participants || []).find((p) => p && p !== 'user');
  if (!partnerId) return '';
  const now = await getNowForUser(userId).catch(() => Date.now());
  const FRESH_WINDOW_MS = isPhoneOwnerScope
    ? 7 * 24 * 60 * 60 * 1000
    : 48 * 60 * 60 * 1000;
  const allChats = await db.getAllByIndex('chats', 'userId', userId).catch(() => []);
  const rooms = (Array.isArray(allChats) ? allChats : [])
    .filter((c) => {
      // 当前窗口的完整消息已经作为 API history 注入；再次塞进「幕后近况」会让模型
      // 把刚发生的对话当成另一段背景重演，角色手机侧窗尤其容易出现鬼打墙。
      if (!c?.id || String(c.id) === String(chat.id)) return false;
      if (!c || now - Number(c.lastActivity || 0) >= FRESH_WINDOW_MS) return false;
      if (!Array.isArray(c.participants) || !c.participants.includes(partnerId)) return false;
      if (c.type === 'group' && c?.metadata?.channel === 'backstage') return true;
      // 从角色手机进入联系人私聊时，手机主人也必须记得自己刚在普通群里经历的公开冲突、
      // 立场和决定；过去这里只读“幕后群”，导致普通群 → 手机私聊完全断层。
      if (isPhoneOwnerScope && c.type === 'group') return true;
      // 角色间真实私聊：对方亲历过的 A↔B 小剧场，也要回灌到 user↔对方 的记忆里。
      if (c.type === 'private' && c?.metadata?.channel === 'peer_private') {
        return (c.participants || []).filter((p) => p && p !== 'user').length === 2;
      }
      return false;
    })
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, isPhoneOwnerScope ? 4 : 2);
  if (!rooms.length) return '';

  const partnerName = displayName(partnerId, characters);
  // characters 只装了本会话成员，幕后房间里其他角色的名字要单独补查
  const nameOf = async (id, fallback = '') => {
    if (!id || id === 'user') return userName;
    if (id === 'system') return '剧情';
    if (characters[id]) return displayName(id, characters);
    const row = await db.getRecord('characters', id).catch(() => null);
    return String(row?.realName || row?.name || fallback || '').trim() || 'TA';
  };
  const blocks = [];
  let hasPhoneProxyFeedback = false;
  for (const room of rooms) {
    const [messageRows, stateEntries] = await Promise.all([
      recentMessages(room.id, 8),
      includeCharacterState ? recentCharacterStateEntries(room.id, partnerId, {
        userId,
        userName,
        // 角色手机/无 user 侧窗里，心声属于角色本人的亲历；前台 userName
        // 不是当前身份，不能用昵称相等性把本人状态误删掉。
        requireUserName: !isPhoneOwnerScope,
        limit: 3,
      }) : Promise.resolve([]),
    ]);
    const msgs = messageRows.filter((m) => now - Number(m.timestamp || 0) < FRESH_WINDOW_MS);
    const freshStates = stateEntries.filter((entry) => (
      now - Number(entry.recordedAt || 0) < FRESH_WINDOW_MS
    ));
    if (!msgs.length && !freshStates.length) continue;
    if (!isPhoneOwnerScope && msgs.some((message) => (
      message?.metadata?.phoneProxyByUser === true
      && String(message?.metadata?.phoneProxyOwnerId || message?.senderId || '').trim() === partnerId
    ))) {
      hasPhoneProxyFeedback = true;
    }
    const otherIds = (room.participants || [])
      .filter((p) => p && p !== 'user' && p !== partnerId)
      .slice(0, 4);
    const others = (await Promise.all(otherIds.map((p) => nameOf(p)))).filter(Boolean).join('、');
    const lines = await Promise.all(msgs.map(async (m) => {
      if (isPlotExplainMessage(m)) return formatSideRecapLine(m, now, userName, characters);
      const name = await nameOf(m.senderId, m.senderName);
      return formatSideRecapLine(m, now, userName, characters, name);
    }));
    const label = room?.metadata?.channel === 'peer_private'
      ? `和${others || '别人'}的一对一私聊`
      : (room.type === 'group' && room?.metadata?.channel !== 'backstage'
        ? `群「${String(room.groupSettings?.name || '群聊').trim()}」的公开聊天`
        : `和${others || '别人'}的私下聊天`);
    const stateBlock = formatCrossWindowStateBlock(freshStates, partnerName, now);
    blocks.push([
      `◆ ${label}：`,
      lines.join('\n'),
      stateBlock,
    ].filter(Boolean).join('\n'));
  }
  if (!blocks.length) return '';

  return [
    `【${partnerName}自己的${isPhoneOwnerScope ? '近期社交' : '幕后近况'}】以下是 ${partnerName} 最近亲身参与的聊天片段（带真实时间）。这是 TA 自己真实经历过的事，不是系统资料：聊到相关话题、或者想分享近况时，可以自然承接。注意分寸：私聊与幕后群里的秘密不能自动告诉当前联系人；普通群公屏则是 ${partnerName} 已知的公开群内事实，但当前联系人只有在本窗听 TA 说出口后才会知道。`,
    '若片段里有【剧情解释】，按其中人物/关系/事件/动机四段理解知情边界，不要当成所有相关人都已知。',
    hasPhoneProxyFeedback
      ? `【手机账号操作待反馈】以上片段里有用户拿 ${partnerName} 的手机或登录其账号代发的真实记录。若 ${partnerName} 在当前主聊天时间线中还没有留下过反应，本轮按人设自然带出一次即可；可以明显，也可以融进正在聊的话题、动作或语气，重点落在代发内容和真实后果，不要解释“如何判断不是本人”，不要固定写成“用户在我这里”“别找用户”或同义句。若已经反应过则不要重复追究。`
      : '',
    blocks.join('\n\n'),
  ].filter(Boolean).join('\n');
}

// 马甲线程回流的额度：最近的线程给足原文，其余线程只带简短尾巴，防止 prompt 爆量
const ALIAS_ECHO_THREAD_LIMIT = 3;
const ALIAS_ECHO_PRIMARY_LINES = 30;
const ALIAS_ECHO_SECONDARY_LINES = 12;
// 群聊是全员共享 prompt，多成员都可能有线程，单段配额要收紧
const ALIAS_ECHO_GROUP_THREAD_LIMIT = 4;
const ALIAS_ECHO_GROUP_LINES = 12;
const ALIAS_ECHO_FRESH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** 指定角色集合参与过、近期活跃、按活跃时间倒序的陌生人线程。 */
async function listAliasThreadsFor(userId, characterIds, now, cap) {
  const wanted = new Set(characterIds);
  const allChats = await db.getAllByIndex('chats', 'userId', userId).catch(() => []);
  return (Array.isArray(allChats) ? allChats : [])
    .filter((c) => c?.id && isStrangerInterceptChat(c)
      && Array.isArray(c.participants)
      && c.participants.some((p) => wanted.has(String(p || '')))
      && now - Number(c.lastActivity || 0) < ALIAS_ECHO_FRESH_WINDOW_MS)
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, cap);
}

/**
 * 单条陌生线程 → 注入段。secondPerson=true 用于一对一主私聊（以「你」称呼角色）；
 * 群聊传 false，用第三人称并强调这是该成员独有的私人经历。
 */
async function aliasThreadSection({
  thread,
  userId,
  actorId,
  actorName,
  characters = {},
  userName = '用户',
  now,
  lineCap,
  secondPerson = true,
  includeCharacterState = true,
}) {
  const prefs = await loadChatPrefs(thread.id).catch(() => ({}));
  if (!normalizeMemoryInjectionSettings(prefs).allowAsCrossWindowSource) return '';
  const meta = thread.metadata || {};
  const identityMap = meta.accountIdentityMap || {};
  const userKey = principalKey('user', userId);
  const actorKey = principalKey('character', actorId);
  const actorAccountId = String(identityMap[actorKey] || '').trim();
  const userAccountId = String(identityMap[userKey] || '').trim();
  if (actorAccountId) {
    const [account, revoked] = await Promise.all([
      getAliasAccount(actorAccountId).catch(() => null),
      isAliasAccountRevoked(actorAccountId, { userId, ownerId: actorId }),
    ]);
    if (!account || revoked) return '';
  }
  const actorReveal = normalizeRevealEntry(meta.identityReveal?.[actorKey]).state;
  const userReveal = normalizeRevealEntry(meta.identityReveal?.[userKey]).state;
  const actorAliasHidden = !!actorAccountId && actorReveal !== 'revealed';
  const userAliasHidden = !!userAccountId && userReveal !== 'revealed';
  const actorFrontName = actorAccountId
    ? String(meta.accountSnapshots?.[actorAccountId]?.displayName || '').trim() || '小号'
    : actorName;
  const userFrontName = userAliasHidden
    ? String(meta.accountSnapshots?.[userAccountId]?.displayName || '').trim() || '一个陌生账号'
    : userName;

  const shareMode = resolveAliasThreadMainChatShareMode(thread);
  // 同一个角色始终记得自己亲身参与过的线程。未揭示只限制“能否对外说”，
  // 不能把角色本人的近期原线程也从认知里删掉；否则摘要默认未开启/未到阈值时会直接失忆。
  const resetAt = await loadCharacterProgressResetAt(userId, actorId).catch(() => 0);
  const msgs = filterRowsAfterCharacterReset(await recentMessages(thread.id, lineCap), resetAt);
  const stateRows = includeCharacterState
    ? await recentCharacterStateEntries(thread.id, actorId, {
      userId,
      userName: userFrontName,
      requireUserName: true,
      limit: 3,
    })
    : [];
  const stateEntries = stateRows.filter((entry) => Number(entry.recordedAt || 0) > resetAt);
  const isolatedSummaries = shareMode === 'isolated_summary'
    ? (await db.getAllByIndex('memories', 'chatId', thread.id).catch(() => []))
      .filter((memory) => memory?.type === 'summary'
        && memory?.isolatedAlias === true
        && String(memory?.memoryMode || '') === 'isolated_alias'
        && !String(memory?.characterId || '').trim()
        && Number(memory?.timestamp || 0) > resetAt)
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 2)
      .map((memory) => excerpt(String(memory.content || '').replace(/^【区间】[^\n]*\n/u, ''), 900))
      .filter(Boolean)
    : [];
  if (!msgs.length && !isolatedSummaries.length && !stateEntries.length) return '';
  const lines = msgs.map((m) => {
    const who = m.senderId === 'user'
      ? userFrontName
      : (m.senderId === actorId ? actorFrontName : displayName(m.senderId, characters));
    return `${msgTimeTag(m.timestamp, now)}${who}: ${excerpt(formatMessageForContext(m, userFrontName, { characters }))}`;
  });

  // 角色是否私下已知这个陌生号其实是用户（知情账本比线程揭示状态更细）
  let awarenessLevel = '';
  if (userAliasHidden && userAccountId) {
    const rows = await listAliasAwareness({
      userId,
      awareCharacterId: actorId,
      accountId: userAccountId,
    }).catch(() => []);
    awarenessLevel = String(rows[0]?.awarenessLevel || '');
  }
  const privatelyKnowsUser = ['knows_account', 'knows_purpose'].includes(awarenessLevel);

  const subject = secondPerson ? '你' : `${actorName}`;
  const label = actorAccountId
    ? `${subject}用小号「${actorFrontName}」和「${userFrontName}」的私聊`
    : `账号「${userFrontName}」和${subject}（本号）的私聊`;
  const rules = [];
  if (secondPerson) {
    if (actorAliasHidden) {
      rules.push(`「${actorFrontName}」是你自己操作的小号，这段是你的亲身经历；你本人始终记得，相关的情绪、判断、打算和后续行动都必须连续，禁止用“不知道”“没印象”或毫无反应来保密。但眼前的用户不知道这个号是你：对外只隐藏账号归属与信息来源，不承认、不暗示真身，也不把只在小号里发生的细节冒充成大号窗口里已公开的共同经历。`);
    } else if (actorAccountId) {
      rules.push(`「${actorFrontName}」是你的小号且用户已知情，这段可作为共同话题自然提起。`);
    }
    if (userAliasHidden) {
      if (privatelyKnowsUser) {
        rules.push(`你私下已确认「${userFrontName}」其实就是眼前这位用户，但对方没有公开承认；要不要点破由你的人设与剧情决定，默认不点破、不当面对质。`);
      } else {
        rules.push(`「${userFrontName}」对你只是一个陌生账号，你不知道TA是谁；绝对禁止把这个号和眼前的用户联系起来，禁止拿小窗内容试探、指认或质问用户。这段经历只能作为「你最近遇到的一件事」存在于你心里，按人设可以模糊地提起（不带可识别细节）。`);
      }
    } else if (userAccountId) {
      rules.push(`那个号已确认是眼前用户本人，这段是你们真实的共同经历，可自然衔接、提起。`);
    }
  } else {
    if (actorAliasHidden) {
      rules.push(`「${actorFrontName}」是${actorName}自己操作的小号，这段只有${actorName}本人知道。${actorName}必须保持对这段亲历的记忆、情绪、判断与行动连续，不能为了隐瞒而表现得失忆或毫无反应。对外只隐藏账号归属与信息来源：不得在群里承认或暗示这是自己的号；群里其他人（包括用户）完全不知情，也绝不能替TA提起。`);
    } else if (actorAccountId) {
      rules.push(`「${actorFrontName}」是${actorName}的小号且用户已知情，${actorName}可自然当话题提起；其他成员是否知情以群内已有对话为准，不得凭空全知。`);
    }
    if (userAliasHidden) {
      if (privatelyKnowsUser) {
        rules.push(`${actorName}私下已确认「${userFrontName}」其实是用户本人，但对方没有公开承认；默认不点破，更不能在群里当众挑明或影射。`);
      } else {
        rules.push(`「${userFrontName}」对${actorName}只是一个陌生账号，TA不知道是谁；禁止把这个号和群里的用户联系起来，其他成员更不知道这段事的存在。`);
      }
    } else if (userAccountId) {
      rules.push(`那个号已确认是用户本人，这是${actorName}和用户的真实共同经历；其他成员默认不知情，除非群里已经聊起过。`);
    }
  }
  const content = shareMode === 'explicit_shared'
    ? [
      '  【身份已揭示·显式共享原线程】',
      lines.join('\n'),
      formatCrossWindowStateBlock(stateEntries, actorName, now),
    ]
    : [
      '  【身份未全揭示·仅本人可读的原线程】以下记录只用于该角色恢复自己的亲历、情绪和未竟事项，不是当前群聊/大号窗口里已经公开的对话。',
      '  认知连续硬要求：标注角色本人必须记得自己做过、说过和感受过什么，让这段亲历自然影响当下的情绪、判断与行动；保密不等于失忆。',
      '  对外硬限制：不得逐字引用、复原、影射或拿细节试探当前用户；不得把未揭示账号认成当前用户；除标注角色本人外，其他群成员完全不可读取。隐瞒时只收住信息来源和账号归属，不得把本人的认知一起删掉。',
      isolatedSummaries.length
        ? `  已沉淀概括：\n${isolatedSummaries.map((summary) => `  - ${summary}`).join('\n')}`
        : '',
      lines.length ? `  本人近期亲历（内部证据）：\n${lines.join('\n')}` : '',
      stateEntries.length ? formatCrossWindowStateBlock(stateEntries, actorName, now) : '',
    ];
  return [`◆ ${label}`, ...rules.map((r) => `  ${r}`), ...content].filter(Boolean).join('\n');
}

/**
 * 主聊天窗口：把角色亲身参与过的陌生人/马甲线程近期原文回灌进来。
 * 马甲窗剧情只躺在自己线程里；摘要默认未开启或尚未到阈值时，角色仍靠本人私有的
 * 近期原文保持连续。未揭示线程的原文只是内部证据，不能对外引用、复原或拿来认人。
 * 带强身份边界：防掉马、防串号、防把未揭示的陌生号指认成眼前用户。
 * 私聊：只回流对方角色的线程，第二人称。
 * 群聊：逐成员回流并标注「仅该成员知情」，与【私聊继承上下文/成员】同一隔离方式。
 */
export async function buildAliasThreadEchoBlock({
  chat,
  userId,
  userName = '用户',
  characters = {},
  includeCharacterState = true,
} = {}) {
  if (!chat || !userId) return '';
  if (isAnonymousChat(chat) || isStrangerInterceptChat(chat)) return '';
  if (!(chat.participants || []).includes('user')) return '';
  if (chat.type === 'group') {
    return buildAliasEchoForGroup({
      chat, userId, userName, characters, includeCharacterState,
    });
  }
  if (chat.type !== 'private') return '';
  const partnerId = (chat.participants || []).find((p) => p && p !== 'user');
  if (!partnerId || (chat.participants || []).filter((p) => p && p !== 'user').length !== 1) return '';

  const now = await getNowForUser(userId).catch(() => Date.now());
  const threads = await listAliasThreadsFor(userId, [partnerId], now, ALIAS_ECHO_THREAD_LIMIT);
  if (!threads.length) return '';

  const partnerName = displayName(partnerId, characters);
  const sections = [];
  for (const thread of threads) {
    const section = await aliasThreadSection({
      thread,
      userId,
      actorId: partnerId,
      actorName: partnerName,
      characters,
      userName,
      now,
      lineCap: sections.length === 0 ? ALIAS_ECHO_PRIMARY_LINES : ALIAS_ECHO_SECONDARY_LINES,
      secondPerson: true,
      includeCharacterState,
    }).catch(() => '');
    if (section) sections.push(section);
  }
  if (!sections.length) return '';

  return [
    `【${partnerName}的陌生账号线程近况 · 亲身经历】以下各线程严格按身份状态回流：未全揭示时原线程只作为${partnerName}本人不可外显的内部证据；身份全部揭示后才会明确标注为可共享原线程。这些事真实发生过，可影响本人情绪、状态与话题走向。`,
    '但必须严格遵守每段线程各自标注的身份边界：禁止掉马、禁止把 A 号经历记成 B 号、禁止把未揭示的陌生号当成眼前用户来对质或影射。',
    sections.join('\n\n'),
  ].join('\n');
}

/**
 * 无 user 的角色侧窗：把每位实际参与者亲身经历过的陌生账号线程带回自己的私有胶囊。
 *
 * 角色手机私聊与幕后私聊共用一份技术 prompt，但不等于双方共享知情。这里复用
 * aliasThreadSection 的第三人称边界，让联系人记得自己和用户马甲说过什么，同时
 * 明确禁止手机主人或其它参与者读取、引用或猜中这段私聊。
 */
export async function buildSideParticipantAliasThreadEchoBlock({
  chat,
  userId,
  userName = '用户',
  characters = {},
  includeCharacterState = true,
} = {}) {
  if (!chat?.id || !userId || isAnonymousChat(chat) || isStrangerInterceptChat(chat)) return '';
  if ((chat.participants || []).includes('user')) return '';
  const memberIds = [...new Set((chat.participants || [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== 'system'))];
  if (!memberIds.length) return '';

  const now = await getNowForUser(userId).catch(() => Date.now());
  const threads = await listAliasThreadsFor(userId, memberIds, now, ALIAS_ECHO_GROUP_THREAD_LIMIT);
  if (!threads.length) return '';

  const sections = [];
  for (const thread of threads) {
    const actorId = (thread.participants || [])
      .map((id) => String(id || '').trim())
      .find((id) => id && id !== 'user' && memberIds.includes(id));
    if (!actorId) continue;
    const section = await aliasThreadSection({
      thread,
      userId,
      actorId,
      actorName: displayName(actorId, characters),
      characters,
      userName,
      now,
      lineCap: sections.length === 0 ? ALIAS_ECHO_PRIMARY_LINES : ALIAS_ECHO_SECONDARY_LINES,
      secondPerson: false,
      includeCharacterState,
    }).catch(() => '');
    if (section) sections.push(section);
  }
  if (!sections.length) return '';

  return [
    '【侧窗参与者各自的陌生账号线程 · 严格私有】以下每段只属于标注角色本人，用于恢复本人亲历、情绪与未竟事项；当前侧窗里的其他角色完全不知道这些内容。',
    '生成每条 msg/state/inner/intent 前，只能按精确角色 ID 读取发言者自己的段落。禁止让手机主人、联系人或其它参与者互相读取、影射、猜中或据此行动；只有本人在当前窗口实际说出口后，相关内容才会成为对方的新知情。',
    sections.join('\n\n'),
  ].join('\n');
}

/** 群聊版：逐成员回流各自的陌生线程近况，知情范围严格限定在本人。 */
async function buildAliasEchoForGroup({
  chat,
  userId,
  userName = '用户',
  characters = {},
  includeCharacterState = true,
}) {
  const memberIds = (chat.participants || []).filter((p) => p && p !== 'user');
  if (!memberIds.length) return '';
  const now = await getNowForUser(userId).catch(() => Date.now());
  const threads = await listAliasThreadsFor(userId, memberIds, now, ALIAS_ECHO_GROUP_THREAD_LIMIT);
  if (!threads.length) return '';

  const sections = [];
  for (const thread of threads) {
    const actorId = (thread.participants || [])
      .map((p) => String(p || ''))
      .find((p) => p && p !== 'user' && memberIds.includes(p));
    if (!actorId) continue;
    const section = await aliasThreadSection({
      thread,
      userId,
      actorId,
      actorName: displayName(actorId, characters),
      characters,
      userName,
      now,
      lineCap: ALIAS_ECHO_GROUP_LINES,
      secondPerson: false,
      includeCharacterState,
    }).catch(() => '');
    if (section) sections.push(section);
  }
  if (!sections.length) return '';

  return [
    '【成员各自的陌生账号线程近况 · 私人经历】以下各线程严格按身份状态回流：未全揭示时原线程只作为标注角色本人不可外显的内部证据；身份全部揭示后才会明确标注为可共享原线程。每段只属于标注的那位成员：TA记得这些事，可以让它们影响TA自己的情绪、状态与话题；群里其他成员和用户默认完全不知情。',
    '群聊共用技术 prompt 不等于共同知情。生成每条 msg/state 前只读取该发言者自己的段落；硬边界：禁止掉马、禁止把A号经历记成B号、禁止任何成员替别人提起这些私事、禁止把未揭示的陌生号指认成群里的用户或其他成员。',
    sections.join('\n\n'),
  ].join('\n');
}

/** 用户 ↔ 指定角色的主私聊（非 peer_private）。 */
async function findUserPrivateChatWith(userId, characterId) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return null;
  const all = await db.getAllByIndex('chats', 'userId', uid).catch(() => []);
  return (Array.isArray(all) ? all : [])
    .filter((c) => c?.type === 'private'
      && !isAnonymousChat(c)
      && String(c?.metadata?.channel || '') !== 'peer_private'
      && Array.isArray(c.participants)
      && c.participants.includes('user')
      && c.participants.includes(cid))
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))[0] || null;
}

/**
 * 角色手机 / 无 user 侧窗推进：注入「手机主人 ↔ 用户」主窗近期往来与知情边界。
 * 侧窗对方默认不知道这些私聊原话，除非本窗剧情已交代。
 */
export async function buildPhoneOwnerMainChatRecapBlock({
  chat,
  userId,
  userName = '用户',
  characters = {},
  phoneViewerId = '',
  includeCharacterState = true,
} = {}) {
  if (!chat?.id || !userId || isAnonymousChat(chat) || isUserPresentInChat(chat)) return '';
  if (!resolveAllowUserMainChatContext(chat)) return '';
  const channel = String(chat.metadata?.channel || '').trim();
  const isSide = isPeerPrivateChat(chat)
    || channel === 'backstage'
    || channel === 'scrapbook'
    || !!chat.groupSettings?.isObserverMode
    || (chat.type === 'group' && !isUserPresentInChat(chat));
  if (!isSide) return '';

  const focalId = String(
    phoneViewerId
    || chat.metadata?.focalActorId
    || (chat.participants || []).find((id) => id && id !== 'user')
    || '',
  ).trim();
  if (!focalId || !(chat.participants || []).includes(focalId)) return '';

  const mainDm = await findUserPrivateChatWith(userId, focalId);
  if (!mainDm?.id || mainDm.id === chat.id) return '';

  const now = await getNowForUser(userId).catch(() => Date.now());
  const ownerName = displayName(focalId, characters);
  const [msgs, stateEntries] = await Promise.all([
    recentMessages(mainDm.id, 24),
    includeCharacterState ? recentCharacterStateEntries(mainDm.id, focalId, {
      userId,
      userName,
      requireUserName: true,
      limit: 3,
    }) : Promise.resolve([]),
  ]);
  if (!msgs.length && !stateEntries.length) return '';
  const lines = msgs.map((m) => {
    const who = m.senderId === 'user' ? userName : displayName(m.senderId, characters);
    return `${msgTimeTag(m.timestamp, now)}${who}: ${excerpt(formatMessageForContext(m, userName, { characters }), 90)}`;
  });
  const stateBlock = formatCrossWindowStateBlock(stateEntries, ownerName, now);
  return [
    `【${ownerName}的主窗私聊记忆 · 仅本人知道】以下是「${ownerName}」与「${userName}」在主聊天窗的近期往来（不是本侧窗原文）。身份隔离不等于让 ${ownerName} 失忆：这段只供 ${ownerName} 延续自己的关系、情绪、约定、行程和未竟事。`,
    `知情边界：侧窗里除 ${ownerName} 外的角色默认完全不知道这些私聊细节；只有 ${ownerName} 在本窗实际说出口的内容，才会成为对方的新知情。禁止让对方凭空接话、替 ${userName} 发言，或把主窗内容写成公开事实。`,
    `分享门槛：不要把主窗当播报素材。${userName} 的秘密、脆弱、争吵或暧昧原话不得外传；吃了什么、几点睡、普通行踪等琐碎日常也不因“知道”就值得转述。只有确有对当前对象说的动机、对方关系合适且内容有交流价值时，才允许由 ${ownerName} 用自己的话概括；否则聊 ${ownerName} 自己的生活或本窗原有话题。`,
    lines.join('\n'),
    stateBlock,
  ].filter(Boolean).join('\n');
}

/**
 * 普通窗口的“导演回忆”：读取由当前窗口衍生、或后来关联到当前窗口的角色私聊/后台群。
 * 只用于模型维持连续性，不代表 user 看过这些原话。
 */
export async function buildLinkedSideChatRecapBlock({ chat, userId, userName = '用户', characters = {} }) {
  if (!chat?.id || !userId || isAnonymousChat(chat)) return '';
  const audienceCharacterIds = normalizeAudienceCharacterIds(chat.participants);
  if (!audienceCharacterIds.length) return '';
  const resetAt = audienceCharacterIds.length === 1
    ? await loadCharacterProgressResetAt(userId, audienceCharacterIds[0]).catch(() => 0)
    : 0;
  const currentPrefs = await loadChatPrefs(chat.id).catch(() => ({}));
  const explicitSharedChatIds = new Set(
    normalizeMemoryInjectionSettings(currentPrefs).explicitSharedChatIds,
  );
  const allChats = await db.getAllByIndex('chats', 'userId', userId).catch(() => []);
  const navigationallyLinked = (Array.isArray(allChats) ? allChats : [])
    .filter((row) => {
      if (!row?.id || row.id === chat.id || isAnonymousChat(row)) return false;
      const channel = String(row.metadata?.channel || '').trim();
      if (!['peer_private', 'backstage', 'scrapbook'].includes(channel)) return false;
      return String(row.metadata?.parentChatId || '') === String(chat.id)
        || (Array.isArray(row.metadata?.linkedParentChatIds)
          && row.metadata.linkedParentChatIds.includes(chat.id));
    })
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, 12);
  const linked = [];
  for (const row of navigationallyLinked) {
    const sourcePrefs = await loadChatPrefs(row.id).catch(() => ({}));
    if (!normalizeMemoryInjectionSettings(sourcePrefs).allowAsCrossWindowSource) continue;
    if (!audienceCanReceiveSource({
      audienceCharacterIds,
      sourceChat: row,
      record: { knownBy: collectExplicitKnownBy(row) },
      currentChatId: chat.id,
      explicitShared: explicitSharedChatIds.has(String(row.id)),
      requireAll: true,
    })) continue;
    linked.push(row);
    if (linked.length >= 3) break;
  }
  if (!linked.length) return '';

  const now = await getNowForUser(userId).catch(() => Date.now());
  const blocks = [];
  for (const row of linked) {
    const msgs = filterRowsAfterCharacterReset(await recentMessages(row.id, 8), resetAt);
    if (!msgs.length) continue;
    const lines = msgs.map((m) => formatSideRecapLine(m, now, userName, characters));
    blocks.push(`◆ ${chatLabel(row, characters, { userId })}\n${lines.join('\n')}`);
  }
  if (!blocks.length) return '';
  return [
    '【关联侧窗 · 已发生的导演回忆】以下私聊/后台群内容已经真实发生。只用于续写角色自己的经历、判断是否要继续回话和避免换皮重演；它们不是 user 已知事实，也不是必须在当前窗口复述的素材。',
    '侧窗里若有【剧情解释】，按人物/关系/事件/动机四段理解知情边界；续写时按信息差理解，不要当成所有人（含 user）都已知。',
    '若再次跨窗，优先延续同一真实窗口与未回复关系；没有新信息时可以本轮不联动。禁止把相同的吃醋、质问、串供、邀约或爆料只换措辞再演一次。',
    blocks.join('\n\n'),
  ].join('\n');
}

/** 私聊窗口：注入对方所在各群的近期公屏 */
export async function buildGroupCarryForPrivate({
  chat,
  userId,
  userName = '用户',
  characters = {},
  includeCharacterState = true,
}) {
  if (chat?.type !== 'private' || isAnonymousChat(chat) || !userId) return '';
  const partnerId = (chat.participants || []).find((p) => p && p !== 'user');
  if (!partnerId) return '';
  const resetAt = await loadCharacterProgressResetAt(userId, partnerId).catch(() => 0);
  const now = await getNowForUser(userId).catch(() => Date.now());
  const currentPrefs = await loadChatPrefs(chat.id).catch(() => ({}));
  const explicitSharedChatIds = new Set(
    normalizeMemoryInjectionSettings(currentPrefs).explicitSharedChatIds,
  );
  const allChats = await db.getAllByIndex('chats', 'userId', userId).catch(() => []);
  const groups = (Array.isArray(allChats) ? allChats : [])
    .filter((c) => c?.type === 'group' && !isAnonymousChat(c)
      && Array.isArray(c.participants) && c.participants.includes(partnerId))
    .sort((a, b) => Number(explicitSharedChatIds.has(String(b.id))) - Number(explicitSharedChatIds.has(String(a.id)))
      || (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, 6);
  if (!groups.length) return '';
  const peer = displayName(partnerId, characters);
  const blocks = [];
  for (const g of groups) {
    const sourcePrefs = await loadChatPrefs(g.id).catch(() => ({}));
    if (!normalizeMemoryInjectionSettings(sourcePrefs).allowAsCrossWindowSource) continue;
    const [messageRows, stateEntries] = await Promise.all([
      recentMessages(g.id, 80),
      includeCharacterState ? recentCharacterStateEntries(g.id, partnerId, {
        userId,
        userName,
        requireUserName: true,
        limit: 3,
      }) : Promise.resolve([]),
    ]);
    const msgs = filterRowsAfterCharacterReset(messageRows, resetAt);
    const filteredStates = stateEntries.filter((entry) => Number(entry.recordedAt || 0) > resetAt);
    if (!msgs.length && !filteredStates.length) continue;
    const gname = String(g.groupSettings?.name || '').trim() || '未命名群聊';
    const lines = msgs.map((m) => {
      const who = m.senderId === 'user' ? userName : displayName(m.senderId, characters);
      return `${msgTimeTag(m.timestamp, now)}${who}: ${excerpt(formatMessageForContext(m, userName, { characters }))}`;
    });
    const stateBlock = formatCrossWindowStateBlock(filteredStates, peer, now);
    const lastTs = Math.max(
      Number(msgs[msgs.length - 1]?.timestamp || 0) || 0,
      Number(filteredStates[0]?.recordedAt || 0) || 0,
    );
    const spanHint = lastTs ? `· 最后活动 ${relTime(lastTs, now)}` : '';
    blocks.push([
      `【群「${gname}」· 近期约${lines.length}条${spanHint}】`,
      lines.join('\n'),
      stateBlock,
    ].filter(Boolean).join('\n'));
  }
  if (!blocks.length) return '';
  return (
    `【群聊继承上下文/${peer}】\n`
    + `以下为「${peer}」所在各群聊的近期公屏记录（按时间顺序），供你在本私聊中延续已在群内公开的信息、语气与关系线；\n`
    + `说明：每条气泡前的方括号是它在群里真实发生的时间（几月几号·多久之前）；这些来自其它群窗口、不是本私聊记录，更不是此刻刚发生——务必按时间戳判断新旧，别把几天前的群尾巴当成刚刚的话题。若某事仅在私聊发生、未在群内提及，演绎时须符合信息边界。\n\n`
    + `事实仲裁：群里的提问、猜测、误会或“不知道”只代表当时的公屏表达，不能覆盖「${peer}」在本私聊里已经确认、亲历或明确知道的地点、身份、约定和共同经历；较新只代表后来发生，不代表更真。\n\n`
    + `连续性硬约束：当前私聊的旧尾巴只表示这条线程上次停在哪里，不表示「${peer}」的记忆或心理状态停在那里。若群聊发生得更晚，必须承接群里的后来进展与本人尚未消化的心理余波；用户只说“之前”“那件事”“还记得吗”时，也要先从下方近期群聊中按时间和对话关系寻找指代，不能要求用户重新复述关键词。\n\n`
    + blocks.join('\n\n')
  );
}

/** 普通聊天：注入本会话各角色"本人"在匿名房参与过的对话片段，
 * 让角色心里清楚自己最近和谁（匿名网友 / 匿名修女）聊过、说了什么、对方怎么回的。
 * 跳过 room_only 临时房（喵喵咪咪等）；跳过告解室硬隔离档；其他档位列对话节选。 */
export async function buildAnonymousSelfMemoryContext({
  chat,
  user,
  characterIds = [],
  characters = {},
  excludeUserPrivate = false,
  includeCharacterState = true,
}) {
  if (!chat || isAnonymousChat(chat)) return '';
  const uid = String(user?.id || '').trim();
  if (!uid) return '';
  const targetIds = new Set((Array.isArray(characterIds) ? characterIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'));
  if (!targetIds.size && Array.isArray(chat.participants)) {
    chat.participants.forEach((id) => {
      const cid = String(id || '').trim();
      if (cid && cid !== 'user') targetIds.add(cid);
    });
  }
  if (!targetIds.size) return '';
  const resetAt = Math.max(0, ...(await Promise.all([...targetIds].map(
    (characterId) => loadCharacterProgressResetAt(uid, characterId).catch(() => 0),
  ))));

  const allChats = await db.getAllByIndex('chats', 'userId', uid).catch(() => []);
  const anonChats = (Array.isArray(allChats) ? allChats : []).filter((c) => c && isAnonymousChat(c));
  if (!anonChats.length) return '';

  const now = await getNowForUser(uid);
  const WINDOW_MS = 48 * 60 * 60 * 1000; // 最近 48 小时内有过活动就带回来
  const SEGMENT_LIMIT = 8; // 每个房间取最后 8 条非系统消息
  const userName = getUserDisplayName(user);
  const perCharSegments = new Map(); // charId -> [{ts, room, isConfession, isPrivate, myAnonId, lines}]

  for (const ac of anonChats) {
    const meta = ac?.metadata || {};
    const memMode = String(meta.memoryMode || ac?.anonymousPrivateConfig?.memoryMode || '').trim();
    if (memMode === 'room_only') continue;
    const participants = Array.isArray(ac.participants) ? ac.participants : [];
    const userInRoom = participants.includes('user');
    const mainChatInjectMode = userInRoom ? getAnonymousMainChatInjectMode(ac) : 'separate';
    if (userInRoom && mainChatInjectMode === 'off') continue;
    // 与 user 的匿名 1v1 由下方专用块按房间设置、时间与摘要精细带回，避免和 8 条余波重复。
    if (excludeUserPrivate
      && ac.type !== 'group'
      && userInRoom) continue;

    const myActorIds = participants.filter((pid) => targetIds.has(String(pid || '').trim()));
    if (!myActorIds.length) continue;

    const isConfession = String(meta.sourceAnonymousType || '') === 'cyber_confession'
      || String(meta.anonymousRoomKind || '').includes('confession');
    const confessionIsolation = String(meta.confessionMemoryIsolation || '').trim();
    if (isConfession && confessionIsolation === 'hard') continue;

    const recentRows = await listRecentMessagesForContext(ac.id, SEGMENT_LIMIT).catch(() => []);
    const recent = filterRowsAfterCharacterReset(filterNonGuidanceMessages(recentRows), resetAt)
      .filter((m) => m && !m.deleted && !m.recalled && m.type !== 'system' && Number(m.timestamp || 0) > 0)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
      .slice(-SEGMENT_LIMIT);
    const identities = ac.groupSettings?.anonymousIdentities
      || ac.anonymousPrivateConfig?.identities
      || {};
    const isPrivate = ac.type === 'private';
    const roomLabel = String(ac.groupSettings?.name || meta.anonymousRoomKind || (isPrivate ? '匿名 1v1' : '匿名房')).trim();
    const statesByCharacter = new Map(await Promise.all(myActorIds.map(async (charId) => [
      charId,
      (includeCharacterState ? await recentCharacterStateEntries(ac.id, charId, {
        userId: uid,
        userName,
        requireUserName: false,
        limit: 3,
      }) : []).filter((entry) => Number(entry.recordedAt || 0) > resetAt),
    ])));

    // 匿名群的公屏是每位实际参与者都亲历的，但每个人的心声只属于自己。
    // 因此为每位角色各建一份完整公屏 + 本人状态，而不是把非本人消息只塞给
    // 第一个角色，或为了防串知情直接丢弃整个多人匿名群。
    for (const charId of myActorIds) {
      const mySpoken = recent.filter((m) => String(m.senderId || '').trim() === charId);
      const stateEntries = statesByCharacter.get(charId) || [];
      if (!mySpoken.length && !stateEntries.length) continue;
      const lastActivityTs = Math.max(
        Number(mySpoken[mySpoken.length - 1]?.timestamp || 0) || 0,
        Number(stateEntries[0]?.recordedAt || 0) || 0,
      );
      if (!lastActivityTs || (now - lastActivityTs) > WINDOW_MS) continue;
      const lines = recent.map((m) => {
        const sid = String(m.senderId || '').trim();
        let speakerLabel;
        if (sid === charId) {
          speakerLabel = '我';
        } else if (sid === 'user') {
          speakerLabel = mainChatInjectMode === 'merged'
            ? userName
            : (identities.user?.currentId || '匿名网友');
        } else if (isConfession) {
          speakerLabel = `${identities[sid]?.currentId || '匿名修女'}（修女）`;
        } else {
          speakerLabel = identities[sid]?.currentId || '匿名网友';
        }
        const body = excerpt(formatMessageForContext(m, userName, { characters }), 90);
        return `${speakerLabel}：${body}`;
      });
      const list = perCharSegments.get(charId) || [];
      list.push({
        ts: lastActivityTs,
        room: roomLabel,
        isConfession,
        isPrivate,
        myAnonId: String(identities[charId]?.currentId || '').trim(),
        userIdentityMerged: userInRoom && mainChatInjectMode === 'merged',
        lines,
        stateEntries,
      });
      perCharSegments.set(charId, list);
    }
  }

  if (!perCharSegments.size) return '';

  const sections = [];
  for (const [charId, segments] of perCharSegments.entries()) {
    const name = displayName(charId, characters);
    segments.sort((a, b) => b.ts - a.ts);
    const top = segments.slice(0, 3);
    const blocks = top.map((seg) => {
      const head = [
        `· ${relTime(seg.ts, now)}｜${seg.room}`,
        seg.myAnonId ? `（你在那里用的马甲：${seg.myAnonId}）` : '',
        seg.isConfession ? '｜对面是匿名修女' : (seg.isPrivate ? '｜匿名 1v1' : ''),
        seg.userIdentityMerged ? `｜已确认 ${userName} 的匿名身份` : '',
      ].filter(Boolean).join(' ');
      return [
        head,
        seg.lines.length ? seg.lines.map((l) => `  ${l}`).join('\n') : '',
        formatCrossWindowStateBlock(seg.stateEntries, name, now),
      ].filter(Boolean).join('\n');
    });
    sections.push(`【${name} · 匿名房经历】\n${blocks.join('\n')}`);
  }

  return [
    '[匿名房自我经历 / 心理连续性]',
    '以下是上述角色本人最近在匿名聊天里参与过的对话节选——TA 自己心里清楚刚刚和谁聊过、说了什么、对方怎么回的。',
    '使用规则：',
    '- 这是角色"自己的记忆"，用于保持心理连续性（情绪余波、欲言又止、注意力、能量水平等）；多人房里每位角色只可读取自己标题下的心理状态。',
    `- 只有标注「已确认 ${userName} 的匿名身份」的房间，才可把其中 user 的匿名发言视为与当前 user 的共同经历；其他匿名 ID 仍不得识破。`,
    '- 未标注已确认身份的节选里，匿名网友 / 匿名修女只是角色当时遇到的匿名对象，不得自行等同于当前 user 或其他在场者。',
    '- 不需要刻意复述匿名房原话；只在自然合适时让那段经历影响当下反应。',
    sections.join('\n\n'),
  ].join('\n');
}

function replaceLiteral(text = '', from = '', to = '') {
  const source = String(text || '');
  const needle = String(from || '').trim();
  return needle ? source.split(needle).join(String(to || '')) : source;
}

function pickAnonymousRoomSummaries(memories = [], userId = '', characterId = '') {
  return (Array.isArray(memories) ? memories : [])
    .filter((m) => m?.type === 'summary' && String(m.userId || '') === String(userId || ''))
    .filter((m) => {
      const owner = String(m.characterId || '').trim();
      return !owner || owner === characterId;
    })
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, 6);
}

/**
 * 日常主聊专用：把当前角色与 user 的匿名 1v1 按房间设置带回。
 * 48 小时内带最近 50 条，7 天内带 20 条，更早只带已有摘要。
 */
export async function buildAnonymousUserPrivateMemoryContext({
  chat, user, characterIds = [], characters = {},
}) {
  if (!chat || isAnonymousChat(chat)) return '';
  const uid = String(user?.id || '').trim();
  if (!uid) return '';
  const targetIds = new Set((Array.isArray(characterIds) ? characterIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'));
  if (!targetIds.size && Array.isArray(chat.participants)) {
    chat.participants.forEach((id) => {
      const cid = String(id || '').trim();
      if (cid && cid !== 'user') targetIds.add(cid);
    });
  }
  if (!targetIds.size) return '';
  if (chat.type === 'group' && targetIds.size > 1) return '';

  const allChats = await db.getAllByIndex('chats', 'userId', uid).catch(() => []);
  const candidates = (Array.isArray(allChats) ? allChats : [])
    .filter((ac) => ac && isAnonymousChat(ac)
      && ac.type !== 'group'
      && Array.isArray(ac.participants)
      && ac.participants.includes('user')
      && ac.participants.some((id) => targetIds.has(String(id || '').trim()))
      && getAnonymousMainChatInjectMode(ac) !== 'off');
  if (!candidates.length) return '';

  const now = await getNowForUser(uid);
  const userName = getUserDisplayName(user);
  const rooms = [];

  for (const ac of candidates) {
    const characterId = ac.participants
      .map((id) => String(id || '').trim())
      .find((id) => targetIds.has(id));
    if (!characterId) continue;
    const resetAt = await loadCharacterProgressResetAt(uid, characterId).catch(() => 0);
    const mode = getAnonymousMainChatInjectMode(ac);
    const identities = ac.groupSettings?.anonymousIdentities
      || ac.anonymousPrivateConfig?.identities
      || {};
    const userAnonId = String(identities.user?.currentId || '匿名网友').trim();
    const characterAnonId = String(identities[characterId]?.currentId || '').trim();
    const allMessages = filterRowsAfterCharacterReset(filterNonGuidanceMessages(
      await listRecentMessagesForContext(ac.id, 50).catch(() => []),
    ), resetAt)
      .filter((m) => m && !m.deleted && !m.recalled && m.type !== 'system' && Number(m.timestamp || 0) > 0)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    const lastTs = Number(allMessages[allMessages.length - 1]?.timestamp || ac.lastActivity || 0) || 0;
    const messageLimit = resolveAnonymousMainChatMessageLimit(lastTs, now);
    const selectedMessages = messageLimit ? allMessages.slice(-messageLimit) : [];
    const memories = await db.getAllByIndex('memories', 'chatId', ac.id).catch(() => []);
    const summaries = filterRowsAfterCharacterReset(
      pickAnonymousRoomSummaries(memories, uid, characterId),
      resetAt,
    )
      .map((m) => String(m.content || '').trim())
      .filter(Boolean);
    if (!selectedMessages.length && !summaries.length) continue;

    const lines = selectedMessages.map((m) => {
      const sid = String(m.senderId || '').trim();
      const speaker = sid === characterId
        ? '我'
        : (sid === 'user' ? (mode === 'merged' ? userName : userAnonId) : '匿名网友');
      const body = excerpt(formatMessageForContext(m, userName, { characters }), 120);
      return `${msgTimeTag(m.timestamp, now)}${speaker}：${body}`;
    });
    const normalizedSummaries = summaries.map((content) => {
      const merged = mode === 'merged' ? replaceLiteral(content, userAnonId, userName) : content;
      return merged.length > 1400 ? `${merged.slice(0, 1400)}…` : merged;
    });
    const roomLabel = String(ac.groupSettings?.name || ac.metadata?.anonymousRoomKind || '匿名 1v1').trim();
    rooms.push({
      ts: lastTs,
      characterId,
      mode,
      roomLabel,
      characterAnonId,
      userAnonId,
      messageLimit,
      lines,
      summaries: normalizedSummaries,
    });
  }

  if (!rooms.length) return '';
  rooms.sort((a, b) => b.ts - a.ts);
  const blocks = rooms.slice(0, 4).map((room) => {
    const name = displayName(room.characterId, characters);
    const identityRule = room.mode === 'merged'
      ? `身份：用户已确认对面匿名网友就是当前这位 ${userName}，可当作你们的共同经历自然承接。`
      : `身份：对面仍只是你记忆里的「${room.userAnonId}」，不知道其现实身份，不能自行认定是当前 user。`;
    const summaryBlock = room.summaries.length
      ? `相关记忆摘要：\n${room.summaries.map((s) => `  ${s}`).join('\n')}`
      : '';
    const messagesBlock = room.lines.length
      ? `近期对话（最近 ${room.messageLimit} 条上限）：\n${room.lines.map((line) => `  ${line}`).join('\n')}`
      : '';
    const alias = room.characterAnonId ? `｜你的马甲：${room.characterAnonId}` : '';
    return [
      `【${name} · ${room.roomLabel}｜${relTime(room.ts, now)}${alias}】`,
      identityRule,
      summaryBlock,
      messagesBlock,
    ].filter(Boolean).join('\n');
  });

  return [
    '[与 user 的匿名 1v1 · 带回主聊天]',
    '以下内容按每个匿名房自己的设置带回；只用于对应角色，不得扩散给其他角色。',
    ...blocks,
  ].join('\n\n');
}


/**
 * 「约线下 / 时光机」叙事场景专用的匿名马甲记忆回填（由调用方按 presetMode==='offline' 决定是否调用，
 * 日常聊天/通话/语音陪伴不会触发）。与 buildAnonymousSelfMemoryContext（48小时内自动残留、
 * 只当自我连续性，任何场景都会触发）不同，这里由用户在「约线下」或线下场景设置里手动选择才生效，不设时间窗，
 * 按房间时间顺序把角色在各匿名房的经历带回本次线下叙事：
 *  - mode='separate'：仍不确认马甲对象是谁，角色只当自己经历过、对方是另一个人；
 *  - mode='merged'：用户已手动确认「本房那位就是我」，可按同一人处理、自然承接。
 * 私聊每房最多取最近 50 条，群聊每房最多取最近 30 条，均按时间顺序排列。
 */
export async function buildAnonymousLinkedMemoryContext({
  chat, user, characterIds = [], characters = {}, mode = 'off',
}) {
  if (!chat || isAnonymousChat(chat)) return '';
  if (mode !== 'separate' && mode !== 'merged') return '';
  const uid = String(user?.id || '').trim();
  if (!uid) return '';
  const targetIds = new Set((Array.isArray(characterIds) ? characterIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'));
  if (!targetIds.size && Array.isArray(chat.participants)) {
    chat.participants.forEach((id) => {
      const cid = String(id || '').trim();
      if (cid && cid !== 'user') targetIds.add(cid);
    });
  }
  if (!targetIds.size) return '';
  if (chat.type === 'group' && targetIds.size > 1) return '';

  const resetAt = Math.max(0, ...(await Promise.all([...targetIds].map(
    (characterId) => loadCharacterProgressResetAt(uid, characterId).catch(() => 0),
  ))));
  const allChats = await db.getAllByIndex('chats', 'userId', uid).catch(() => []);
  const anonChats = (Array.isArray(allChats) ? allChats : []).filter((c) => c && isAnonymousChat(c));
  if (!anonChats.length) return '';

  const now = await getNowForUser(uid);
  const userName = getUserDisplayName(user);
  const perCharRooms = new Map(); // charId -> [{ts, room, isPrivate, lines}]

  for (const ac of anonChats) {
    const meta = ac?.metadata || {};
    const memMode = String(meta.memoryMode || ac?.anonymousPrivateConfig?.memoryMode || '').trim();
    if (memMode === 'room_only') continue;

    const isConfession = String(meta.sourceAnonymousType || '') === 'cyber_confession'
      || String(meta.anonymousRoomKind || '').includes('confession');
    const confessionIsolation = String(meta.confessionMemoryIsolation || '').trim();
    if (isConfession && confessionIsolation === 'hard') continue;

    const participants = Array.isArray(ac.participants) ? ac.participants : [];
    const myActorIds = participants.filter((pid) => targetIds.has(String(pid || '').trim()));
    if (!myActorIds.length) continue;

    const isPrivate = ac.type !== 'group';
    const cap = isPrivate ? 50 : 30;
    const recentRows = await listRecentMessagesForContext(ac.id, cap).catch(() => []);
    const recent = filterRowsAfterCharacterReset(filterNonGuidanceMessages(recentRows), resetAt)
      .filter((m) => m && !m.deleted && !m.recalled && m.type !== 'system' && Number(m.timestamp || 0) > 0)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
      .slice(-cap);
    if (!recent.length) continue;
    const mySpoken = recent.filter((m) => myActorIds.includes(String(m.senderId || '').trim()));
    if (!mySpoken.length) continue;

    const identities = ac.groupSettings?.anonymousIdentities || ac.anonymousPrivateConfig?.identities || {};
    const roomLabel = String(ac.groupSettings?.name || meta.anonymousRoomKind || (isPrivate ? '匿名 1v1' : '匿名房')).trim();
    const lastTs = Number(mySpoken[mySpoken.length - 1].timestamp || 0) || 0;

    const segmentsForChars = new Map();
    for (const m of recent) {
      const sid = String(m.senderId || '').trim();
      const myMatch = myActorIds.includes(sid) ? sid : null;
      let speakerLabel;
      if (myMatch) {
        speakerLabel = '我';
      } else if (sid === 'user') {
        speakerLabel = mode === 'merged' ? userName : (identities.user?.currentId || '匿名网友');
      } else {
        speakerLabel = identities[sid]?.currentId || '匿名网友';
      }
      const body = excerpt(formatMessageForContext(m, userName, { characters }), 90);
      const line = `${msgTimeTag(m.timestamp, now)}${speakerLabel}：${body}`;
      const owner = myMatch || myActorIds[0];
      const arr = segmentsForChars.get(owner) || [];
      arr.push(line);
      segmentsForChars.set(owner, arr);
    }
    for (const [charId, lines] of segmentsForChars.entries()) {
      const list = perCharRooms.get(charId) || [];
      list.push({ ts: lastTs, room: roomLabel, isPrivate, lines });
      perCharRooms.set(charId, list);
    }
  }

  if (!perCharRooms.size) return '';

  const sections = [];
  for (const [charId, rooms] of perCharRooms.entries()) {
    const name = displayName(charId, characters);
    rooms.sort((a, b) => b.ts - a.ts);
    const top = rooms.slice(0, 4);
    const blocks = top.map((room) => {
      const head = `· ${relTime(room.ts, now)}｜${room.room}${room.isPrivate ? '（匿名1v1）' : '（匿名群）'}`;
      return `${head}\n${room.lines.map((l) => `  ${l}`).join('\n')}`;
    });
    sections.push(`【${name} · 匿名马甲经历】\n${blocks.join('\n')}`);
  }

  const modeRules = mode === 'merged'
    ? [
      '- 用户已在这个会话里手动确认：以下匿名房片段中的匿名网友，就是当前和你说话的这位 user 本人（已经掉马/相认过），不是你自己猜的。',
      '- 可以自然承接、引用、翻旧账，把这些内容当成你们之间已经心照不宣的共同经历来回应；不必每次都点破「我知道那是你」，按关系亲疏自然表达即可。',
    ]
    : [
      '- 这是角色本人自己的匿名马甲经历，只用于保持心理连续性（情绪余波、话题倾向、精力状态等）。',
      '- 用户并未确认匿名对象是谁；不能把片段里的“匿名网友”直接当成当前这位 user，不要点破、不要套用现实称呼或亲密度。',
      '- 只在自然合适时，让这段经历隐约影响当下反应，不要主动提起马甲房的具体内容。',
    ];

  return [
    '[匿名记忆 · 用户已在本会话手动开启回填]',
    ...modeRules,
    sections.join('\n\n'),
  ].join('\n');
}

/** 跨窗口最新焦点：按时间最新优先衔接 */
export async function buildCrossChatLatestFocusContext({ chat, user, characterIds = [], characters = {} }) {
  const uid = String(user?.id || '').trim();
  const chatId = chat?.id;
  if (!uid || !chatId || isAnonymousChat(chat)) return '';
  const now = await getNowForUser(uid);
  const userName = getUserDisplayName(user);
  const targetIds = new Set((Array.isArray(characterIds) ? characterIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'));
  if (!targetIds.size && Array.isArray(chat?.participants)) {
    chat.participants.forEach((id) => {
      const cid = String(id || '').trim();
      if (cid && cid !== 'user') targetIds.add(cid);
    });
  }
  if (!targetIds.size) return '';
  const resetAt = targetIds.size === 1
    ? await loadCharacterProgressResetAt(uid, [...targetIds][0]).catch(() => 0)
    : 0;
  const currentPrefs = await loadChatPrefs(chatId).catch(() => ({}));
  const explicitSharedChatIds = new Set(
    normalizeMemoryInjectionSettings(currentPrefs).explicitSharedChatIds,
  );
  const chats = await db.getAllByIndex('chats', 'userId', uid).catch(() => []);
  const candidates = (Array.isArray(chats) ? chats : [])
    .filter((c) => {
      if (!c?.id || isAnonymousChat(c) || !Array.isArray(c.participants)) return false;
      const sourceHasUser = c.participants.includes('user');
      const isObserverGroup = c.type === 'group' && !sourceHasUser;
      if (!sourceHasUser && !isObserverGroup) return false;
      return audienceCanReceiveSource({
        audienceCharacterIds: [...targetIds],
        sourceChat: c,
        currentChatId: chatId,
        explicitShared: explicitSharedChatIds.has(String(c.id)),
        requireAll: true,
      });
    })
    .slice(0, 18);
  const rows = [];
  let currentLatestTs = 0;
  for (const sc of candidates) {
    if (sc.id !== chatId) {
      const sourcePrefs = await loadChatPrefs(sc.id).catch(() => ({}));
      if (!normalizeMemoryInjectionSettings(sourcePrefs).allowAsCrossWindowSource) continue;
    }
    const msgs = filterRowsAfterCharacterReset(
      filterNonGuidanceMessages(await listRecentMessagesForContext(sc.id, 8).catch(() => [])),
      resetAt,
    )
      .filter((m) => m && !m.deleted && !m.recalled && m.type !== 'system' && Number(m.timestamp || 0) > 0)
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 8);
    if (sc.id === chatId && msgs[0]) currentLatestTs = Number(msgs[0].timestamp || 0) || 0;
    for (const m of msgs) {
      const parts = Array.isArray(sc.participants) ? sc.participants.map((id) => String(id || '').trim()) : [];
      const relevant = targetIds.has(String(m.senderId || '').trim())
        || m.senderId === 'user'
        || parts.some((id) => targetIds.has(id));
      if (!relevant) continue;
      const sender = m.senderId === 'user' ? userName : displayName(m.senderId, characters);
      rows.push({
        chatId: sc.id,
        label: chatLabel(sc, characters, { userId: uid }),
        ts: Number(m.timestamp || 0) || 0,
        sender,
        text: excerpt(formatMessageForContext(m, userName, { characters }), 60),
      });
    }
  }
  const picked = rows
    .filter((r) => r.ts > 0 && Math.max(0, Number(now) - r.ts) <= 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 12);
  if (!picked.length) return '';
  const newest = picked[0];
  const newestOutside = newest.chatId !== chatId && (!currentLatestTs || newest.ts > currentLatestTs);
  const lines = picked.map((r) => `- ${relTime(r.ts, now)}｜${r.label}｜${r.sender}：${r.text}`);
  return [
    '[跨窗口最新焦点]',
    '这些是同一用户存档里、与本窗口角色相关的最近消息时间锚点，用来防止当前窗口把旧尾巴误当成"刚刚"。',
    newestOutside
      ? '时间优先级：跨窗口消息发生得更晚，角色本人的认知与关系进度必须推进到这里；当前窗口旧尾巴只是这条聊天线程上次停住的位置，绝不是角色的记忆截止点。当前私聊已确认的地点、身份、约定和共同经历仍然有效，外窗里的提问、猜测、误会或“不知道”不能反向抹掉角色本人已经知道的事实。'
      : '优先级：若本窗口最新消息已经是最新，就正常承接本窗口；跨窗口消息只作低调背景。',
    '事实仲裁：确定陈述 > 提问/猜测/似乎/可能；亲历与本人私聊已知 > 其他窗口里的旁人判断。新时间戳只决定先后，不自动决定真假。',
    ...lines,
  ].join('\n');
}
