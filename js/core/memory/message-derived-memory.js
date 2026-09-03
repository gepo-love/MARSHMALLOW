import * as db from '../db.js';
import { deleteVectorSources } from './memory-vectors.js';

function clean(value = '') {
  return String(value || '').trim();
}

function linkedMessageIds(row = {}) {
  return [
    clean(row?.sourceMessageId),
    ...(Array.isArray(row?.sourceMessageIds) ? row.sourceMessageIds.map(clean) : []),
    ...(Array.isArray(row?.summaryMessageIds) ? row.summaryMessageIds.map(clean) : []),
  ].filter(Boolean);
}

function referencesDeletedMessage(row = {}, deletedIds = new Set()) {
  return linkedMessageIds(row).some((id) => deletedIds.has(id));
}

/**
 * 删除气泡时撤销以该气泡为证据生成的摘要、事件与结构化事实。
 * 一条摘要只要混入了已删除原文，就不能继续当作可靠事实；剩余聊天后续可重新总结。
 */
export async function deleteMessageDerivedMemoryArtifacts({
  userId = '',
  chatId = '',
  messageIds = [],
} = {}) {
  const uid = clean(userId);
  const cid = clean(chatId);
  const deletedIds = new Set((Array.isArray(messageIds) ? messageIds : [messageIds])
    .map(clean)
    .filter(Boolean));
  if (!uid || !cid || !deletedIds.size) {
    return { memories: 0, facts: 0, events: 0 };
  }

  const [memories, facts, events] = await Promise.all([
    db.getAllByIndex('memories', 'chatId', cid).catch(() => []),
    db.getAllByIndex('memoryFacts', 'userId', uid).catch(() => []),
    db.getAllByIndex('eventMemories', 'userId', uid).catch(() => []),
  ]);
  const memoryIds = (Array.isArray(memories) ? memories : [])
    .filter((row) => referencesDeletedMessage(row, deletedIds))
    .map((row) => clean(row?.id))
    .filter(Boolean);
  const factIds = (Array.isArray(facts) ? facts : [])
    .filter((row) => (
      (clean(row?.chatId) === cid || clean(row?.sourceChatId) === cid)
      && referencesDeletedMessage(row, deletedIds)
    ))
    .map((row) => clean(row?.id))
    .filter(Boolean);
  const eventIds = (Array.isArray(events) ? events : [])
    .filter((row) => (
      (Array.isArray(row?.involvedChats) && row.involvedChats.some((id) => clean(id) === cid))
      || clean(row?.chatId) === cid
      || clean(row?.sourceChatId) === cid
    ))
    .filter((row) => referencesDeletedMessage(row, deletedIds))
    .map((row) => clean(row?.id))
    .filter(Boolean);

  await Promise.all([
    memoryIds.length ? db.deleteMany('memories', memoryIds) : Promise.resolve(0),
    factIds.length ? db.deleteMany('memoryFacts', factIds) : Promise.resolve(0),
    eventIds.length ? db.deleteMany('eventMemories', eventIds) : Promise.resolve(0),
  ]);
  await Promise.all([
    memoryIds.length ? deleteVectorSources('memory', memoryIds) : Promise.resolve(0),
    factIds.length ? deleteVectorSources('fact', factIds) : Promise.resolve(0),
    eventIds.length ? deleteVectorSources('event', eventIds) : Promise.resolve(0),
  ]);
  return {
    memories: memoryIds.length,
    facts: factIds.length,
    events: eventIds.length,
  };
}
