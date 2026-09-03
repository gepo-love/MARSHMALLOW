import * as db from '../db.js';
import { createEventMemory } from '../../models/event-memory.js';
import { listCharacters } from '../character-store.js';
import { resolveAnonymousActorId } from '../anonymous-chat.js';
import { deleteVectorSources, enqueueVectorSources } from './memory-vectors.js';

export const EVENT_MEMORY_BLOCK_OPEN = '【记忆:事件摘要】';
export const EVENT_MEMORY_BLOCK_CLOSE = '【/记忆】';

const MEMORY_BLOCK_RE =
  /【\s*记忆\s*[:：]\s*事件摘要\s*】([\s\S]*?)(?=【\s*\/\s*记忆\s*】|$)/g;
const MEMORY_BLOCK_CLOSE_RE = /【\s*\/\s*记忆\s*】/g;
const MEMORY_BLOCK_OPEN_RE = /【\s*记忆\s*[:：]\s*事件摘要\s*】/g;

function stableEventSourceHash(value = '') {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function buildEventMemorySourceId(userId = '', sourceKey = '', index = 0) {
  const source = String(sourceKey || '').trim();
  if (!source) return '';
  return `evm_source_${stableEventSourceHash(`${userId}|${source}|${index}`)}`;
}

async function buildCharacterNameMap() {
  const map = new Map();
  const chars = await listCharacters({ excludeAnonNpc: true });
  for (const c of chars) {
    const names = [c.id, c.name, c.realName, c.customNickname, ...(Array.isArray(c.aliases) ? c.aliases : [])]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    for (const name of names) map.set(name, c.id);
  }
  return map;
}

export function resolveEventCharacterId(name, nameMap = new Map(), chats = []) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const chatActorId = (Array.isArray(chats) ? chats : [])
    .flatMap((chat) => (Array.isArray(chat?.participants) ? chat.participants : []))
    .map((id) => String(id || '').trim())
    .find((id) => id && id !== 'user' && id === raw);
  return nameMap.get(raw) || chatActorId || '';
}

function tryParseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const firstObj = raw.match(/\{[\s\S]*\}/);
  if (firstObj) {
    try {
      return JSON.parse(firstObj[0]);
    } catch (_) {}
  }
  const firstArr = raw.match(/\[[\s\S]*\]/);
  if (firstArr) {
    try {
      return JSON.parse(firstArr[0]);
    } catch (_) {}
  }
  return null;
}

export function parseMemoryBlock(rawText = '') {
  const text = String(rawText || '');
  const found = [];
  let m;
  const re = new RegExp(MEMORY_BLOCK_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const body = String(m[1] || '').trim();
    if (!body) continue;
    const parsed = tryParseJsonLoose(body);
    if (!parsed) continue;
    if (Array.isArray(parsed)) found.push(...parsed);
    else found.push(parsed);
  }
  return found.filter((x) => x && typeof x === 'object');
}

export function stripMemoryBlocks(text = '') {
  let t = String(text || '');
  t = t.replace(new RegExp(MEMORY_BLOCK_RE.source, 'g'), '');
  t = t.replace(MEMORY_BLOCK_OPEN_RE, '');
  t = t.replace(MEMORY_BLOCK_CLOSE_RE, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

async function normalizeKnownByKeys(knownBy, options = {}) {
  const kb = knownBy && typeof knownBy === 'object' ? knownBy : null;
  if (!kb) return {};
  const nameMap = await buildCharacterNameMap();
  const fallbackChatIds = [
    options?.chat?.id,
    ...(Array.isArray(options?.involvedChatIds) ? options.involvedChatIds : []),
  ].filter(Boolean);
  const chatRows = [];
  const seenChatIds = new Set();
  if (options?.chat?.id) {
    seenChatIds.add(options.chat.id);
    chatRows.push(options.chat);
  }
  for (const chatId of fallbackChatIds) {
    if (seenChatIds.has(chatId)) continue;
    seenChatIds.add(chatId);
    const row = await db.getRecord('chats', chatId).catch(() => null);
    if (row) chatRows.push(row);
  }
  const out = {};
  for (const [k, v] of Object.entries(kb)) {
    const key = String(k || '').trim();
    if (!key) continue;
    let anonymousResolved = '';
    for (const chat of chatRows) {
      anonymousResolved = resolveAnonymousActorId(chat, key);
      if (anonymousResolved && anonymousResolved !== key) break;
    }
    const resolved = anonymousResolved || resolveEventCharacterId(key, nameMap, chatRows);
    if (!resolved) continue;
    out[resolved] = String(v || '').trim() || 'none';
  }
  return out;
}

export async function inferKnownByFromInvolvedChats(chat = null, involvedChatIds = []) {
  const rows = [];
  const seen = new Set();
  if (chat?.id) {
    seen.add(String(chat.id));
    rows.push(chat);
  }
  for (const chatId of involvedChatIds) {
    const id = String(chatId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = await db.getRecord('chats', id).catch(() => null);
    if (row) rows.push(row);
  }
  const out = {};
  for (const row of rows) {
    for (const participant of (Array.isArray(row?.participants) ? row.participants : [])) {
      const id = String(participant || '').trim();
      if (!id || id === 'user') continue;
      out[id] = 'involved';
    }
  }
  return out;
}

export async function persistEventMemoriesFromRaw({
  rawText = '',
  userId = '',
  chat = null,
  defaultChatId = '',
  defaultVisibility = 'private',
  defaultTimestamp = 0,
  sourceKey = '',
} = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return { stored: 0 };
  const parsed = parseMemoryBlock(rawText);
  if (!parsed.length) return { stored: 0 };
  const items = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const it = parsed[index];
    const eventId = it.id || buildEventMemorySourceId(userId, sourceKey, index) || '';
    const existing = eventId
      ? await db.getRecord('eventMemories', eventId).catch(() => null)
      : null;
    const involvedChatIds = Array.isArray(it.involvedChats) ? it.involvedChats : (defaultChatId ? [defaultChatId] : []);
    let knownBy = await normalizeKnownByKeys(it.knownBy, { chat, involvedChatIds });
    if (!Object.keys(knownBy).length) {
      knownBy = await inferKnownByFromInvolvedChats(chat, involvedChatIds);
    }
    const em = createEventMemory({
      ...it,
      id: eventId || undefined,
      userId: uid,
      timestamp: Number(it.timestamp || defaultTimestamp || 0) || undefined,
      visibility: it.visibility || defaultVisibility,
      involvedChats: involvedChatIds,
      knownBy,
      createdAt: Number(existing?.createdAt || Date.now()),
      updatedAt: Date.now(),
    });
    if (!em.summary) continue;
    items.push(em);
  }
  if (!items.length) return { stored: 0 };
  await db.putMany('eventMemories', items);
  enqueueVectorSources('event', items).catch(() => {});
  return { stored: items.length };
}

export async function listEventMemoriesForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const rows = await db.getAllByIndex('eventMemories', 'userId', uid);
  return (Array.isArray(rows) ? rows : []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function deleteEventMemoriesForChat(chatId, userId) {
  const id = String(chatId || '').trim();
  const uid = String(userId || '').trim();
  if (!id) return 0;
  const rows = uid
    ? await db.getAllByIndex('eventMemories', 'userId', uid)
    : await db.getAllRecords('eventMemories');
  const matched = (Array.isArray(rows) ? rows : []).filter((row) =>
    Array.isArray(row?.involvedChats) && row.involvedChats.includes(id));
  for (const row of matched) {
    if (!row?.id) continue;
    const rest = row.involvedChats.filter((chatId) => String(chatId || '').trim() !== id);
    if (rest.length) {
      await db.putRecord('eventMemories', { ...row, involvedChats: rest });
    } else {
      await db.deleteRecord('eventMemories', row.id);
    }
  }
  return matched.length;
}

/**
 * 删除线下小剧场消息时同步移除它派生出的事件记忆。
 *
 * 新记录通过 sourceMessageId 精确关联；旧版本没有保存该字段，只能用小剧场标签、
 * 同一会话和完全一致的时间戳共同识别。时间戳来自创建消息时的同一个值，可以避免
 * 误删同会话里的其它事件。
 */
export async function deleteEventMemoriesForStoryCard(message = {}) {
  const messageId = String(message?.id || '').trim();
  const chatId = String(message?.chatId || '').trim();
  const timestamp = Number(message?.timestamp || 0);
  if (!messageId || !chatId || String(message?.type || '').trim() !== 'storyCard') return 0;

  const chat = await db.getRecord('chats', chatId).catch(() => null);
  const userId = String(chat?.userId || '').trim();
  const rows = userId
    ? await db.getAllByIndex('eventMemories', 'userId', userId)
    : await db.getAllRecords('eventMemories');
  const matched = (Array.isArray(rows) ? rows : []).filter((row) => {
    const sourceMessageId = String(row?.sourceMessageId || '').trim();
    const sourceMessageIds = Array.isArray(row?.sourceMessageIds)
      ? row.sourceMessageIds.map((id) => String(id || '').trim())
      : [];
    if (sourceMessageId === messageId || sourceMessageIds.includes(messageId)) return true;
    if (sourceMessageId || sourceMessageIds.length || !timestamp) return false;
    const tags = Array.isArray(row?.tags) ? row.tags.map((tag) => String(tag || '').trim()) : [];
    return tags.includes('storyCard')
      && Number(row?.timestamp || 0) === timestamp
      && Array.isArray(row?.involvedChats)
      && row.involvedChats.some((id) => String(id || '').trim() === chatId);
  });
  const ids = matched.map((row) => String(row?.id || '').trim()).filter(Boolean);
  if (!ids.length) return 0;
  await db.deleteMany('eventMemories', ids);
  await deleteVectorSources('event', ids);
  return ids.length;
}
