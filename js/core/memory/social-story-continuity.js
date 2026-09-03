import * as db from '../db.js';
import { effectiveEventPendingThreads, effectiveEventTemporalState } from '../../models/event-memory.js';
import { isAnonymousChat } from '../chat-helpers.js';
import { isStrangerInterceptChat } from '../stranger-thread-model.js';

const KNOWN_LEVELS = new Set(['heard', 'known', 'involved', 'shared']);

function clean(value = '', limit = 0) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return limit > 0 ? text.slice(0, limit) : text;
}

function normalizeKnownLevel(value) {
  if (value === true) return 'involved';
  const level = String(value || '').trim().toLowerCase();
  return KNOWN_LEVELS.has(level) ? level : '';
}

function eventKnowledgeLevel(event = {}, actorId = '', snapshot = {}) {
  const id = String(actorId || '').trim();
  if (!id) return '';
  const explicit = normalizeKnownLevel(event?.knownBy?.[id]);
  if (explicit) return explicit;
  const hasExplicitAudience = Object.values(event?.knownBy || {}).some(normalizeKnownLevel);
  if (!hasExplicitAudience) {
    const participantsByChat = snapshot?.chatParticipantsById instanceof Map
      ? snapshot.chatParticipantsById
      : new Map(Object.entries(snapshot?.chatParticipantsById || {}));
    const isInvolved = (Array.isArray(event?.involvedChats) ? event.involvedChats : [])
      .some((chatId) => (participantsByChat.get(String(chatId || '').trim()) || [])
        .some((participantId) => String(participantId || '').trim() === id));
    if (isInvolved) return 'involved';
  }
  return ['public', 'spreading'].includes(String(event?.visibility || '').trim()) ? 'public' : '';
}

function knowledgeLabel(level = '') {
  if (level === 'involved' || level === 'shared') return '本人亲历';
  if (level === 'known') return '本人已知';
  if (level === 'heard') return '本人听说';
  if (level === 'public') return '公开获知';
  return '知情范围未知';
}

function temporalLabel(state = '') {
  return state === 'ongoing' ? '仍在进行·可承接' : '已经结束·禁止重演';
}

function timeLabel(timestamp = 0) {
  const value = Number(timestamp || 0);
  if (!value || !Number.isFinite(value)) return '时间未标';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未标';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function storyKey(row = {}) {
  const sourceMessageId = String(row?.sourceMessageId || '').trim();
  if (sourceMessageId) return `message:${sourceMessageId}`;
  const summary = clean(row?.summary || row?.excerpt || row?.note, 240).toLowerCase();
  return summary ? `summary:${summary}` : `row:${String(row?.id || '')}`;
}

export async function loadSocialStoryContinuitySnapshot(userId = '') {
  const uid = String(userId || '').trim();
  if (!uid) return {
    userId: '', events: [], sharedKnowledge: [], blockedChatIds: new Set(), chatParticipantsById: new Map(),
  };
  const [events, sharedKnowledge, chats] = await Promise.all([
    db.getAllByIndex('eventMemories', 'userId', uid).catch(() => []),
    db.getAllByIndex('sharedEventKnowledge', 'userId', uid).catch(() => []),
    db.getAllByIndex('chats', 'userId', uid).catch(() => []),
  ]);
  const blockedChatIds = new Set((Array.isArray(chats) ? chats : [])
    .filter((chat) => isAnonymousChat(chat) || isStrangerInterceptChat(chat))
    .map((chat) => String(chat?.id || '').trim())
    .filter(Boolean));
  const chatParticipantsById = new Map((Array.isArray(chats) ? chats : [])
    .map((chat) => [
      String(chat?.id || '').trim(),
      (Array.isArray(chat?.participants) ? chat.participants : [])
        .map((id) => String(id || '').trim())
        .filter((id) => id && id !== 'user'),
    ])
    .filter(([chatId]) => chatId));
  return {
    userId: uid,
    events: (Array.isArray(events) ? events : [])
      .filter((row) => String(row?.userId || '') === uid && clean(row?.summary)),
    sharedKnowledge: (Array.isArray(sharedKnowledge) ? sharedKnowledge : [])
      .filter((row) => String(row?.userId || '') === uid && clean(row?.summary || row?.excerpt || row?.note)),
    blockedChatIds,
    chatParticipantsById,
  };
}

function storyUsesBlockedChat(row = {}, snapshot = {}) {
  const blocked = snapshot?.blockedChatIds instanceof Set
    ? snapshot.blockedChatIds
    : new Set(Array.isArray(snapshot?.blockedChatIds) ? snapshot.blockedChatIds : []);
  if (!blocked.size) return false;
  const chatIds = [
    String(row?.chatId || '').trim(),
    String(row?.sourceChatId || '').trim(),
    ...(Array.isArray(row?.involvedChats) ? row.involvedChats : []),
  ].map((id) => String(id || '').trim()).filter(Boolean);
  return chatIds.some((id) => blocked.has(id));
}

/**
 * 返回剧情时间线中明确登记过知情权的角色。公开事件不会把整本通讯录都拉进作者池；
 * 它们只在角色已经被选中后作为公共背景提供。
 */
export function collectSocialStoryCharacterIds(snapshot = {}, { limit = 80 } = {}) {
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = String(value || '').trim();
    if (!id || id === 'user' || seen.has(id) || ids.length >= limit) return;
    seen.add(id);
    ids.push(id);
  };
  const events = [...(Array.isArray(snapshot?.events) ? snapshot.events : [])]
    .filter((row) => !storyUsesBlockedChat(row, snapshot))
    .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));
  for (const event of events) {
    let hasExplicitAudience = false;
    for (const [id, level] of Object.entries(event?.knownBy || {})) {
      if (normalizeKnownLevel(level)) {
        hasExplicitAudience = true;
        add(id);
      }
    }
    if (!hasExplicitAudience && !['public', 'spreading'].includes(String(event?.visibility || '').trim())) {
      const participantsByChat = snapshot?.chatParticipantsById instanceof Map
        ? snapshot.chatParticipantsById
        : new Map(Object.entries(snapshot?.chatParticipantsById || {}));
      for (const chatId of (Array.isArray(event?.involvedChats) ? event.involvedChats : [])) {
        for (const participantId of (participantsByChat.get(String(chatId || '').trim()) || [])) add(participantId);
      }
    }
  }
  const shared = [...(Array.isArray(snapshot?.sharedKnowledge) ? snapshot.sharedKnowledge : [])]
    .filter((row) => !storyUsesBlockedChat(row, snapshot))
    .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));
  for (const row of shared) {
    for (const id of (Array.isArray(row?.characterIds) ? row.characterIds : [])) add(id);
  }
  return ids;
}

export function selectSocialStoryContinuityRows(snapshot = {}, actorId = '', { limit = 5 } = {}) {
  const id = String(actorId || '').trim();
  const cap = Math.max(0, Math.min(12, Number(limit) || 0));
  if (!id || !cap) return [];
  const rows = [];
  const seen = new Set();
  const events = [...(Array.isArray(snapshot?.events) ? snapshot.events : [])]
    .filter((row) => !storyUsesBlockedChat(row, snapshot))
    .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));
  for (const event of events) {
    const level = eventKnowledgeLevel(event, id, snapshot);
    const summary = clean(event?.summary, 360);
    if (!level || !summary) continue;
    const key = storyKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: String(event?.id || key),
      actorId: id,
      sourceMessageId: String(event?.sourceMessageId || '').trim(),
      sourceType: 'event_memory',
      timestamp: Number(event?.timestamp || 0),
      summary,
      knowledgeLevel: level,
      temporalState: effectiveEventTemporalState(event),
      pendingThreads: effectiveEventPendingThreads(event).map((item) => clean(item, 100)).filter(Boolean).slice(0, 2),
      relationChanges: (Array.isArray(event?.relationChanges) ? event.relationChanges : [])
        .map((item) => clean(item, 100)).filter(Boolean).slice(0, 2),
    });
  }
  const shared = [...(Array.isArray(snapshot?.sharedKnowledge) ? snapshot.sharedKnowledge : [])]
    .filter((row) => !storyUsesBlockedChat(row, snapshot))
    .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));
  for (const item of shared) {
    if (!(Array.isArray(item?.characterIds) ? item.characterIds : [])
      .some((candidate) => String(candidate || '').trim() === id)) continue;
    const summary = clean(item?.summary || item?.excerpt || item?.note, 360);
    if (!summary) continue;
    const key = storyKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: String(item?.id || key),
      actorId: id,
      sourceMessageId: String(item?.sourceMessageId || '').trim(),
      sourceType: 'shared_knowledge',
      timestamp: Number(item?.timestamp || 0),
      summary,
      knowledgeLevel: 'involved',
      temporalState: 'completed',
      pendingThreads: [],
      relationChanges: [],
    });
  }
  const ordered = rows.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const personal = ordered.filter((row) => row.knowledgeLevel !== 'public');
  const latestPublic = ordered.find((row) => row.knowledgeLevel === 'public') || null;
  const selected = personal.slice(0, cap);
  // 公共事件只补一个最近背景，不能让连续热搜/公共事件挤掉角色自己的关系与主线进度。
  if (latestPublic && cap > 1) {
    if (selected.length < cap) selected.push(latestPublic);
    else if (Number(latestPublic.timestamp || 0) > Number(selected[selected.length - 1]?.timestamp || 0)) {
      selected[selected.length - 1] = latestPublic;
    }
  }
  return selected.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

export function formatSocialStoryContinuityLine(row = {}) {
  const summary = clean(row?.summary, 360);
  if (!summary) return '';
  const relation = (Array.isArray(row?.relationChanges) ? row.relationChanges : [])
    .map((item) => clean(item, 100)).filter(Boolean).slice(0, 2);
  const pending = (Array.isArray(row?.pendingThreads) ? row.pendingThreads : [])
    .map((item) => clean(item, 100)).filter(Boolean).slice(0, 2);
  return [
    `- [${timeLabel(row?.timestamp)}｜${knowledgeLabel(row?.knowledgeLevel)}｜${temporalLabel(row?.temporalState)}] ${summary}`,
    relation.length ? `关系变化：${relation.join('；')}` : '',
    row?.temporalState === 'ongoing' && pending.length ? `尚未结束：${pending.join('；')}` : '',
  ].filter(Boolean).join('；');
}

export function buildSocialStoryContinuityBlockFromSnapshot(snapshot = {}, actorIds = [], options = {}) {
  const ids = [...new Set((Array.isArray(actorIds) ? actorIds : [])
    .map((id) => String(id || '').trim()).filter((id) => id && id !== 'user'))];
  if (!ids.length) return '';
  const packets = [];
  for (const id of ids) {
    const rows = selectSocialStoryContinuityRows(snapshot, id, { limit: options.limitPerActor ?? 5 });
    if (!rows.length) continue;
    packets.push([
      `[ownerId=${id}｜从旧到新，末行最新]`,
      ...rows.slice().reverse().map(formatSocialStoryContinuityLine).filter(Boolean),
    ].join('\n'));
  }
  if (!packets.length) return '';
  return [
    '[角色最新剧情时间线 · 按知情范围隔离 · 高优先级]',
    '每位作者、评论者或楼层角色只能读取 ownerId 与自己真实角色 id 完全相同的块。未列出的角色不知道这些事；“听说/已知”不得改写为本人亲历。',
    '这条时间线比旧聊天摘要、角色卡里的静态关系状态更新：同一事项发生冲突时，以末行最新结果为准。标为“已经结束”的事件只能作为后续影响或回忆，禁止当作正在发生再次重演。',
    ...packets,
  ].join('\n');
}

export async function buildSocialStoryContinuityBlock(userId = '', actorIds = [], options = {}) {
  const snapshot = options.snapshot || await loadSocialStoryContinuitySnapshot(userId);
  return buildSocialStoryContinuityBlockFromSnapshot(snapshot, actorIds, options);
}
