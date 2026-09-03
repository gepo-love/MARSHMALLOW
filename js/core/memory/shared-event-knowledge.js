import * as db from '../db.js';

function createKnowledgeId() {
  return `sek_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function createSharedKnowledgeFromStoryCard({
  chatId,
  messageId,
  userId,
  summary,
  characterIds = [],
  timestamp = 0,
}) {
  const cleanSummary = String(summary || '').trim();
  if (!chatId || !messageId || !cleanSummary) return null;
  const record = {
    id: createKnowledgeId(),
    chatId,
    sourceMessageId: messageId,
    userId: userId || '',
    summary: cleanSummary,
    characterIds: Array.isArray(characterIds) ? characterIds.map((x) => String(x || '').trim()).filter(Boolean) : [],
    knowledgeType: 'storyCard',
    timestamp: Number(timestamp) || Date.now(),
  };
  await db.putRecord('sharedEventKnowledge', record);
  return record;
}

export async function listSharedKnowledgeByChat(chatId) {
  const rows = await db.getAllByIndex('sharedEventKnowledge', 'chatId', String(chatId || ''));
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

export async function listSharedKnowledgeForCharacters({ userId = '', characterIds = [], limit = 12 } = {}) {
  const ids = new Set((Array.isArray(characterIds) ? characterIds : []).map((x) => String(x || '').trim()).filter(Boolean));
  if (!ids.size) return [];
  const all = await db.getAllRecords('sharedEventKnowledge');
  return all
    .filter((item) => String(item.userId || '') === String(userId || '')
      && Array.isArray(item.characterIds)
      && item.characterIds.some((id) => ids.has(String(id || '').trim())))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-Math.max(1, limit));
}

export async function deleteSharedKnowledgeByChat(chatId) {
  const list = await listSharedKnowledgeByChat(chatId);
  await Promise.all(list.map((item) => db.deleteRecord('sharedEventKnowledge', item.id)));
}

export async function deleteSharedKnowledgeByMessageIds(messageIds) {
  const ids = new Set((Array.isArray(messageIds) ? messageIds : []).map((x) => String(x || '').trim()).filter(Boolean));
  if (!ids.size) return;
  const all = await db.getAllRecords('sharedEventKnowledge');
  const matched = all.filter((item) =>
    ids.has(String(item?.sourceMessageId || '').trim())
    || (Array.isArray(item?.sourceMessageIds) && item.sourceMessageIds.some((id) => ids.has(String(id || '').trim()))));
  await Promise.all(matched.map((item) => db.deleteRecord('sharedEventKnowledge', item.id)));
}

export async function updateStoryCardKnowledgeByMessageId(messageId = '', summary = '') {
  const id = String(messageId || '').trim();
  const nextSummary = String(summary || '').trim();
  if (!id || !nextSummary) return 0;
  const all = await db.getAllRecords('sharedEventKnowledge');
  const matched = (Array.isArray(all) ? all : []).filter((item) => (
    String(item?.knowledgeType || '').trim() === 'storyCard'
    && String(item?.sourceMessageId || '').trim() === id
  ));
  await Promise.all(matched.map((item) => db.putRecord('sharedEventKnowledge', {
    ...item,
    summary: nextSummary,
    updatedAt: Date.now(),
  })));
  return matched.length;
}

export async function createSharedKnowledgeRecord({
  chatId,
  messageId,
  messageIds = [],
  userId,
  excerpt = '',
  note = '',
  characterIds = [],
  knowledgeType = 'told',
  timestamp = 0,
}) {
  const cleanExcerpt = String(excerpt || '').trim();
  const cleanNote = String(note || '').trim();
  const sourceIds = [...new Set((Array.isArray(messageIds) ? messageIds : []).map((x) => String(x || '').trim()).filter(Boolean))];
  const primaryMessageId = String(messageId || sourceIds[0] || '').trim();
  if (!chatId || !primaryMessageId || !cleanExcerpt) return null;
  const record = {
    id: createKnowledgeId(),
    chatId,
    sourceMessageId: primaryMessageId,
    sourceMessageIds: sourceIds.length ? sourceIds : [primaryMessageId],
    userId: userId || '',
    excerpt: cleanExcerpt,
    note: cleanNote,
    characterIds: Array.isArray(characterIds) ? characterIds.map((x) => String(x || '').trim()).filter(Boolean) : [],
    knowledgeType,
    timestamp: Number(timestamp) || Date.now(),
  };
  await db.putRecord('sharedEventKnowledge', record);
  return record;
}

export async function listSharedKnowledgeForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const rows = await db.getAllByIndex('sharedEventKnowledge', 'userId', uid);
  return (Array.isArray(rows) ? rows : []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}
