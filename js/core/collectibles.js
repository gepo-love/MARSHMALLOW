/**
 * 收集物存取（collectibles store）+ 记忆馆镜像。
 *
 * 主家：他的空间·收藏册。
 * 镜像：共同回忆、时光机等需要进记忆馆的收集物额外写一条记忆（memories，引用 collectibleId），
 *       让它自然出现在记忆馆共同回忆分区——不改 memory-scope 逻辑、不复制图。
 */

import { getRecord, putRecord, deleteRecord, getAllByIndex, getAllRecords } from './db.js';
import { createCollectible } from '../models/collectible.js';
import { createMemory } from '../models/memory.js';
import { saveMemory } from './chat-store.js';

export async function saveCollectible(record) {
  const row = createCollectible(record);
  await putRecord('collectibles', row);
  if (shouldMirrorCollectibleToMemory(row)) {
    await mirrorCollectibleToMemory(row);
  }
  return row;
}

function shouldMirrorCollectibleToMemory(collectible) {
  return !!collectible?.characterId
    && (collectible.ownership === 'shared' || collectible.source === 'time_machine');
}

async function mirrorCollectibleToMemory(collectible) {
  const mem = createMemory({
    id: `mem_clt_${collectible.id}`,
    userId: collectible.userId,
    characterId: collectible.characterId,
    chatId: '',
    type: 'event',
    category: collectible.ownership === 'shared' ? 'shared' : 'character',
    content: collectible.summary
      ? `${collectible.title}：${collectible.summary}`
      : collectible.title,
    importance: 'normal',
    timestamp: collectible.timestamp,
    source: `collectible:${collectible.source || 'manual'}`,
  });
  // 记忆引用回收集物，便于以后从记忆馆点回收藏册
  mem.collectibleId = collectible.id;
  await saveMemory(mem);
  return mem;
}

export async function getCollectible(id) {
  return getRecord('collectibles', id);
}

export async function deleteCollectible(id) {
  await deleteRecord('collectibles', id);
}

export async function listCollectiblesForUser(userId) {
  const rows = await getAllByIndex('collectibles', 'userId', String(userId || '').trim());
  return (rows || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function listCollectiblesForCharacter(userId, characterId) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  let rows = [];
  if (cid) {
    rows = await getAllByIndex('collectibles', 'characterId', cid);
    rows = rows.filter((r) => !uid || r.userId === uid);
  } else {
    rows = await listCollectiblesForUser(uid);
  }
  return (rows || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function countCollectiblesForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) {
    const all = await getAllRecords('collectibles');
    return (all || []).length;
  }
  const rows = await getAllByIndex('collectibles', 'userId', uid);
  return (rows || []).length;
}
