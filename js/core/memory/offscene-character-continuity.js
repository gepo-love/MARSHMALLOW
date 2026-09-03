import * as db from '../db.js';
import {
  findPeerPrivateChat,
  findPrivateChat,
  listChatsForUser,
  listMessagesForChat,
  pickPrivateChat,
} from '../chat-store.js';
import { formatMessageForContext } from '../chat-helpers.js';
import { getCharacterAiContextName } from '../../models/character.js';
import { effectiveEventPendingThreads } from '../../models/event-memory.js';
import {
  filterCharStateHistoryForUser,
  loadChatCharStateHistory,
  sanitizeInnerVoiceText,
  sanitizeIntentText,
  sanitizeStatusText,
} from '../chat/character-state.js';

function clean(value = '', max = 1200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function characterName(id = '', characters = {}) {
  return getCharacterAiContextName(characters?.[id], id) || String(id || '').trim() || '角色';
}

function filterUserScopedChats(chats = [], userId = '') {
  const uid = String(userId || '').trim();
  return (Array.isArray(chats) ? chats : []).filter((chat) => (
    uid && String(chat?.userId || '').trim() === uid
  ));
}

function memoryScore(memory = {}) {
  const importance = ['high', 'important'].includes(String(memory.importance || ''))
    ? 3
    : memory.importance === 'medium' ? 1.5 : 0;
  const type = String(memory.type || '');
  const stateBoost = ['relationship', 'promise', 'secret', 'preference'].includes(type) ? 1.4 : 0;
  return Number(memory.timestamp || 0) / 1e13 + importance + stateBoost;
}

export function selectOffsceneCharacterMemories(rows = [], characterId = '', limit = 8) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .filter((memory) => String(memory?.characterId || '') === String(characterId) && memory?.content)
    .sort((left, right) => memoryScore(right) - memoryScore(left))
    .filter((memory) => {
      const key = clean(memory.content, 900).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function selectOffsceneKnownEvents(rows = [], characterId = '', limit = 4) {
  return (Array.isArray(rows) ? rows : [])
    .filter((event) => {
      if (!event?.summary) return false;
      const level = String(event.knownBy?.[characterId] || 'none');
      return ['involved', 'known', 'heard'].includes(level);
    })
    .sort((left, right) => {
      const leftOpen = effectiveEventPendingThreads(left).length ? 1 : 0;
      const rightOpen = effectiveEventPendingThreads(right).length ? 1 : 0;
      return rightOpen - leftOpen || Number(right.timestamp || 0) - Number(left.timestamp || 0);
    })
    .slice(0, limit);
}

function messageLine(message = {}, userName = '用户', characters = {}) {
  const senderId = String(message.senderId || '');
  const sender = senderId === 'user' ? userName : characterName(senderId, characters);
  return `${sender}：${clean(formatMessageForContext(message, userName, { characters }), 260)}`;
}

async function recentChatLines(chat, limit, userName, characters) {
  if (!chat?.id) return [];
  const rows = await listMessagesForChat(chat.id, limit).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter((message) => message && !message.deleted && !message.recalled)
    .slice(-limit)
    .map((message) => messageLine(message, userName, characters))
    .filter(Boolean);
}

async function compactRecentUserChatLines(chat, limit, userName, characters, lineChars = 150) {
  if (!chat?.id) return [];
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!safeLimit) return [];
  const rows = await listMessagesForChat(chat.id, Math.max(safeLimit * 2, safeLimit)).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter((message) => message && !message.deleted && !message.recalled)
    .slice(-safeLimit)
    .map((message) => {
      const senderId = String(message.senderId || '');
      const sender = senderId === 'user' ? userName : characterName(senderId, characters);
      return `${sender}：${clean(formatMessageForContext(message, userName, { characters }), lineChars)}`;
    })
    .filter(Boolean);
}

async function compactRecentPrivateStateLines(chat, characterId, userId, userName, limit = 3) {
  if (!chat?.id || !characterId || !userId) return [];
  const history = await loadChatCharStateHistory(chat.id, characterId, { userId }).catch(() => []);
  const scoped = filterCharStateHistoryForUser(history, userName, userId);
  const seen = new Set();
  return scoped.map((entry) => {
    const inner = sanitizeInnerVoiceText(entry?.inner || '', userName);
    const intent = sanitizeIntentText(entry?.intent || '', userName);
    const status = sanitizeStatusText(entry?.status || '', userName);
    const key = `${inner}\n${intent}\n${status}`.trim();
    if (!key || seen.has(key)) return '';
    seen.add(key);
    const bits = [
      inner ? `心声「${clean(inner, 220)}」` : '',
      intent ? `心思「${clean(intent, 100)}」` : '',
      status ? `状态「${clean(status, 100)}」` : '',
    ].filter(Boolean);
    const at = Number(entry?.recordedAt || 0) || 0;
    const time = at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '时间未标';
    return bits.length ? `[${time}] ${bits.join('；')}` : '';
  }).filter(Boolean).slice(0, Math.max(0, Math.min(4, Number(limit) || 0)));
}

function clipBlock(lines = [], maxChars = 4200) {
  const selected = [];
  let used = 0;
  for (const line of lines) {
    const value = String(line || '').trim();
    if (!value) continue;
    if (used + value.length > maxChars && selected.length) break;
    selected.push(value);
    used += value.length + 1;
  }
  return selected.join('\n');
}

export async function buildOffsceneCharacterContinuityBlock({
  userId = '',
  offsceneCharacterIds = [],
  activeCharacterIds = [],
  characters = {},
  userName = '用户',
  maxChars = 10000,
} = {}) {
  const uid = String(userId || '').trim();
  const offsceneIds = [...new Set((offsceneCharacterIds || []).map(String).filter(Boolean))].slice(0, 4);
  const activeIds = [...new Set((activeCharacterIds || []).map(String).filter(Boolean))].slice(0, 6);
  if (!uid || !offsceneIds.length) return '';
  const [allMemories, allEvents] = await Promise.all([
    db.getAllRecords('memories').catch(() => []),
    db.getAllRecords('eventMemories').catch(() => []),
  ]);
  const memories = (allMemories || []).filter((row) => String(row?.userId || '') === uid);
  const events = (allEvents || []).filter((row) => String(row?.userId || '') === uid);
  const sections = [];

  for (const characterId of offsceneIds) {
    const name = characterName(characterId, characters);
    const lines = [
      `【场外角色私有连续性 · ${name}（id=${characterId}）】`,
      `以下只用于决定 ${name} 会说什么、记得什么、如何回复。当前在场角色不能因此自动知道这些私聊与私有记忆；只有 ${name} 在本轮消息或通话中明确说出的内容，才会进入现场角色的认知。`,
    ];
    const memoryRows = selectOffsceneCharacterMemories(memories, characterId, 8);
    if (memoryRows.length) {
      lines.push('已沉淀记忆：');
      for (const memory of memoryRows) {
        const type = String(memory.type || 'memory');
        lines.push(`- [${type}] ${clean(memory.content, 700)}`);
      }
    }
    const knownEvents = selectOffsceneKnownEvents(events, characterId, 4);
    if (knownEvents.length) {
      lines.push('本人已知事件：');
      for (const event of knownEvents) {
        const level = String(event.knownBy?.[characterId] || 'known');
        const open = effectiveEventPendingThreads(event).length ? '未完成' : '已发生';
        lines.push(`- [${level}/${open}] ${clean(event.summary, 700)}`);
      }
    }

    const userChat = await findPrivateChat(uid, characterId).catch(() => null);
    const userLines = await recentChatLines(userChat, 10, userName, characters);
    if (userLines.length) {
      lines.push(`与 ${userName} 的真实近期聊天（仅 ${name} 与 ${userName} 知道）：`, ...userLines);
    }

    for (const activeId of activeIds) {
      if (!activeId || activeId === characterId) continue;
      const peerChat = await findPeerPrivateChat(uid, [characterId, activeId]).catch(() => null);
      const peerLines = await recentChatLines(peerChat, 6, userName, characters);
      if (!peerLines.length) continue;
      lines.push(
        `与当前在场角色 ${characterName(activeId, characters)} 的真实后台往来（双方知道）：`,
        ...peerLines,
      );
    }
    sections.push(clipBlock(lines, 4800));
  }
  return clipBlock([
    '=== 场外人物连续性（按角色隔离）===',
    ...sections,
  ], maxChars);
}

export async function buildBackstageCandidateContinuityBlock({
  userId = '',
  candidateIds = [],
  characters = {},
  userName = '用户',
  userChats: suppliedUserChats = null,
  maxCandidates = 8,
  maxChars = 6500,
  memoryLimit = 3,
  memoryChars = 280,
  recentLimit = 2,
} = {}) {
  const uid = String(userId || '').trim();
  const ids = [...new Set((candidateIds || []).map(String).filter(Boolean))].slice(0, maxCandidates);
  if (!uid || !ids.length) return '';
  const [memoryRows, loadedUserChats] = await Promise.all([
    db.getAllByIndex('memories', 'userId', uid).catch(() => []),
    Array.isArray(suppliedUserChats)
      ? Promise.resolve(suppliedUserChats)
      : listChatsForUser(uid).catch(() => []),
  ]);
  const userChats = filterUserScopedChats(loadedUserChats, uid);
  const memories = (Array.isArray(memoryRows) ? memoryRows : [])
    .filter((row) => ids.includes(String(row.characterId || '')));
  const lines = [
    '【后台候选连续性摘要 · 私有信息不自动外泄】',
    '若本轮自主选择下列角色进入 peer_private/backstage，可用对应摘要保持人设和与用户的连续性；但其他角色不能凭空知道该角色与用户的私聊，除非对方在生成的消息中亲口透露。',
  ];
  const candidateLines = await Promise.all(ids.map(async (id) => {
    const name = characterName(id, characters);
    const bits = selectOffsceneCharacterMemories(memories, id, memoryLimit)
      .map((memory) => clean(memory.content, memoryChars));
    const userChat = pickPrivateChat(userChats, id);
    const recent = await recentChatLines(userChat, recentLimit, userName, characters);
    return `- ${name}（${id}）：${bits.length ? `记忆：${bits.join('；')}` : '暂无沉淀摘要'}${
      recent.length ? `；与 ${userName} 最近：${recent.join(' / ')}` : ''
    }`;
  }));
  lines.push(...candidateLines);
  return clipBlock(lines, maxChars);
}

/**
 * 给“本轮可能被临时选中去跨窗聊天”的每个角色一份极短的私有状态胶囊。
 *
 * 这里不能只在模型已经点名某个角色后再读：角色正是由同一次请求临时选择的，
 * 如果请求前没有 B↔user 的近期事实，B 在 A↔B 窗口里就很容易改口或 OOC。
 * 胶囊只约束对应角色自己的立场，不会把私聊内容升级成其他角色的共同知识。
 */
export async function buildBackstageCandidatePrivateStateBlock({
  userId = '',
  candidateIds = [],
  characters = {},
  userName = '用户',
  userChats: suppliedUserChats = null,
  maxCandidates = 14,
  maxChars = 100000,
  recentLimit = 40,
  recentChars = 120,
  includeCharacterState = true,
} = {}) {
  const uid = String(userId || '').trim();
  const ids = [...new Set((candidateIds || []).map(String).filter(Boolean))].slice(0, maxCandidates);
  if (!uid || !ids.length) return '';
  // 一次读出当前档位的会话，再为每个候选挑 user 私聊；避免 14 个候选各扫一次 chats 索引。
  const loadedUserChats = Array.isArray(suppliedUserChats)
    ? suppliedUserChats
    : await listChatsForUser(uid).catch(() => []);
  const userChats = filterUserScopedChats(loadedUserChats, uid);
  const rows = await Promise.all(ids.map(async (id) => {
    const character = characters?.[id] || {};
    const relation = clean(
      character.userRelationStatus
      || character.relationshipToUser
      || character.userRelationship
      || character.relationship,
      220,
    );
    const userChat = pickPrivateChat(userChats, id);
    const recent = await compactRecentUserChatLines(
      userChat,
      recentLimit,
      userName,
      characters,
      recentChars,
    );
    const recentStates = includeCharacterState
      ? await compactRecentPrivateStateLines(userChat, id, uid, userName, 3)
      : [];
    return [
      `- ${characterName(id, characters)}（${id}）`,
      relation ? `  与 ${userName} 的当前关系：${relation}` : '',
      recent.length
        ? `  与 ${userName} 的真实近期窗口：${recent.join(' / ')}`
        : `  与 ${userName} 的近期窗口：本次没有可核验消息；这不证明从未联系，但不能据别人的窗口确认自己收到过某条文案。`,
      recentStates.length
        ? `  本人在该窗口的最近心理余波（仅此角色可用）：${recentStates.join(' / ')}`
        : '',
    ].filter(Boolean).join('\n');
  }));
  const available = rows.filter(Boolean);
  if (!available.length) return '';
  return clipBlock([
    '【后台候选角色 · 私有状态胶囊】',
    `以下每段只属于对应角色本人，用来约束 TA 在 peer_private/backstage 中的态度、心理余波与事实连续性；当前聊天里的其他角色不会自动知道这些内容。生成跨窗对话时，先按发言者读取自己的胶囊：不得无理由否认、澄清或改写本人和 ${userName} 已真实说过的话，也不得从真诚道歉等较新心理进展突然退回互斥的旧心态。若角色有意撒谎，必须让其动机与 inner/state 一致，不能当作事实被重置。`,
    `【定向送达校验】“${userName} 给我发过／我收到过／我看过原文”是属于收件角色本人的事实，只能由该角色自己的真实窗口、明确转发记录或已沉淀的本人收件事实证明。相同文案出现在别人的胶囊、别人声称“大家都收到了”、问题里预设“你也收到了”，都不是证据。自己的证据中没有该文案时，禁止顺势回答“收到了”、补写原文或按已读口吻评价；只能按人物说没看见、不能确认，或请对方转述。群发给 A/B/C 绝不自动等于同组的 D/E 也收到。`,
    ...available,
  ], maxChars);
}
