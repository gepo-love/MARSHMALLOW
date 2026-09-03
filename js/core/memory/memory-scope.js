/**
 * 记忆馆 · 分角色取数与档位作用域
 *
 * 记忆始终按当前档位（userId）隔离，再按「角色」二次归属：
 *  - 私聊会话的伙伴即该会话的角色；记忆/事实/事件通过会话归属到角色
 *  - 也兼容直接绑定 characterId 的记忆、以 subjectId/objectId/knownBy 命中的事实
 *  - 群聊与未绑定到单一角色的条目归入「全局/共享」桶
 */
import * as db from '../db.js';
import {
  clearChatMemories,
  deleteChatWithData,
  listChatsForUser,
  listMemoriesForUser,
} from '../chat-store.js';
import { listEventMemoriesForUser } from './event-memory.js';
import { listMemoryFactsForUser } from './memory-facts.js';
import { listCollectiblesForUser } from '../collectibles.js';
import { isInternalAnonymousCharacterId } from '../../models/character.js';
import { isStrangerInterceptChat } from '../stranger-thread-model.js';

export const GLOBAL_SCOPE_ID = '__global';

export function normalizeMemoryActorId(value) {
  return String(value ?? '').trim();
}

export function sameMemoryActorId(left, right) {
  const a = normalizeMemoryActorId(left);
  const b = normalizeMemoryActorId(right);
  return !!a && a === b;
}

/** 群聊/旁观指导记忆使用会话作用域，它不是可展示或可清理的角色身份。 */
export function isGuidanceChatMemoryScopeId(value) {
  return normalizeMemoryActorId(value).startsWith('guidance-chat:');
}

function isWorkspaceUserActorId(value, userId = '') {
  const id = normalizeMemoryActorId(value);
  return id === 'user' || (!!id && id === normalizeMemoryActorId(userId));
}

export function chatPartnerId(chat) {
  if (!chat || chat.type === 'group') return '';
  const partner = (chat.participants || []).find((p) => {
    const id = normalizeMemoryActorId(p);
    return id && id !== 'user';
  });
  return normalizeMemoryActorId(partner);
}

export async function loadMemoryWorkspace(userId) {
  const id = String(userId || '').trim();
  const [chats, memories, events, facts, collectibles] = await Promise.all([
    listChatsForUser(id),
    listMemoriesForUser(id),
    listEventMemoriesForUser(id),
    listMemoryFactsForUser(id),
    listCollectiblesForUser(id).catch(() => []),
  ]);
  return {
    userId: id,
    chats,
    memories: memories.filter((row) => !row?.vectorSupersededBy),
    events: events.filter((row) => !row?.vectorSupersededBy),
    facts: facts.filter((row) => !row?.vectorSupersededBy),
    collectibles,
  };
}

function buildCharChatMap(chats) {
  const map = new Map();
  const groupChatIds = new Set();
  for (const chat of chats) {
    if (isStrangerInterceptChat(chat)) continue;
    if (chat.type === 'group') { groupChatIds.add(chat.id); continue; }
    // 同一档位还会保存角色之间的幕后私聊。它们不属于“用户与某位角色”的记忆馆，
    // 否则模型临时生成的轻量 NPC 即使没有任何记忆，也会仅凭幕后窗口冒出独立卡片。
    const hasUser = (chat.participants || []).some((id) => (
      normalizeMemoryActorId(id) === 'user'
    ));
    if (!hasUser) continue;
    const pid = chatPartnerId(chat);
    if (!pid) continue;
    if (!map.has(pid)) map.set(pid, new Set());
    map.get(pid).add(chat.id);
  }
  return { map, groupChatIds };
}

function knownByTouches(knownBy, cid) {
  if (!cid || !knownBy || typeof knownBy !== 'object') return false;
  return Object.entries(knownBy).some(([id, level]) => (
    sameMemoryActorId(id, cid) && level && level !== 'none'
  ));
}

/** 是否「匿名身份下产生」的事实（匿名房间 / 匿名私聊来源）。 */
function isAnonFact(f) {
  if (!f) return false;
  if (String(f.anonymousRoomId || '').trim()) return true;
  const scope = String(f.scope || '').toLowerCase();
  return scope.includes('anon');
}

function factTouchesCharacterScope(f, cid, chatIds) {
  if (!f || !cid) return false;
  if (chatIds.has(f.chatId) || chatIds.has(f.sourceChatId)) return true;
  if (sameMemoryActorId(f.subjectId, cid) || sameMemoryActorId(f.objectId, cid)) return true;
  return knownByTouches(f.knownBy, cid);
}

/**
 * 角色作用域下的事实三分：
 *  - aboutYou：主体是「你」——你在 TA 眼中的样子
 *  - anonymous：匿名身份下发生的——单独归档，不和真实身份混
 *  - characterTraits：主体明确是 TA，或当前私聊内无法识别主体的旧事实
 *  第三方公开动态即使被 TA 看见，也不能显示成「TA 的偏好习惯」。
 */
function splitFactsForScope(facts, cid, chatIds, userId = '') {
  const aboutYou = [];
  const characterTraits = [];
  const anonymous = [];
  for (const f of facts) {
    if (!factTouchesCharacterScope(f, cid, chatIds)) continue;
    if (isAnonFact(f)) { anonymous.push(f); continue; }
    if (isWorkspaceUserActorId(f.subjectId, userId)) {
      aboutYou.push(f);
    } else if (
      sameMemoryActorId(f.subjectId, cid)
      || (!normalizeMemoryActorId(f.subjectId)
        && (chatIds.has(f.chatId) || chatIds.has(f.sourceChatId)))
    ) {
      characterTraits.push(f);
    }
  }
  return { aboutYou, characterTraits, anonymous };
}

function privateChatIdSet(map) {
  const ids = new Set();
  for (const set of map.values()) for (const id of set) ids.add(id);
  return ids;
}

/**
 * 「真实角色」id 集合：私聊伙伴 + 被记忆/非匿名事实引用的角色。
 * 故意不收匿名事实里的 subjectId，避免匿名 NPC（路人马甲）被当成真实角色、
 * 凭空生成一个角色记忆馆——这类记忆改归全局共享的匿名区。
 */
function realCharacterIdSet(ws, map) {
  const ids = new Set(map.keys());
  ids.delete(normalizeMemoryActorId(ws?.userId));
  for (const mem of ws.memories) {
    const cid = normalizeMemoryActorId(mem.characterId);
    if (cid
      && !isWorkspaceUserActorId(cid, ws?.userId)
      && !isGuidanceChatMemoryScopeId(cid)) ids.add(cid);
  }
  for (const f of ws.facts) {
    if (isAnonFact(f)) continue;
    const sid = normalizeMemoryActorId(f.subjectId);
    if (sid && !isWorkspaceUserActorId(sid, ws?.userId)) ids.add(sid);
  }
  // 匿名 NPC（路人马甲）不单独建角色记忆馆，其记忆改归全局共享匿名区。
  for (const id of [...ids]) {
    if (isInternalAnonymousCharacterId(id)) ids.delete(id);
  }
  return ids;
}

function factOwnedByRealCharacter(f, realIds, privateChatIds) {
  if (!f) return false;
  if (privateChatIds.has(f.chatId) || privateChatIds.has(f.sourceChatId)) return true;
  if (realIds.has(normalizeMemoryActorId(f.subjectId))
    || realIds.has(normalizeMemoryActorId(f.objectId))) return true;
  const kb = f.knownBy && typeof f.knownBy === 'object' ? f.knownBy : {};
  for (const id of realIds) { if (knownByTouches(kb, id)) return true; }
  return false;
}

function isSummary(mem) {
  return String(mem && mem.type) === 'summary';
}

/** 解析某个作用域（角色 id 或 GLOBAL_SCOPE_ID）对应的会话集合 */
export function getScopeChatIds(ws, scopeId) {
  const { map, groupChatIds } = buildCharChatMap(ws.chats);
  if (scopeId === GLOBAL_SCOPE_ID || !scopeId) {
    return { chatIds: groupChatIds, isGlobal: true };
  }
  return { chatIds: map.get(scopeId) || new Set(), isGlobal: false };
}

/**
 * 取某作用域下的分区记忆
 * - 全局/共享桶：只收「未归属到单一角色」的群聊共同记忆 + 无归属的事实/事件
 * - 角色桶：该角色私聊记忆 + characterId===cid 的单人 summary（含来自群聊的单人归纳）
 *   + 命中 subject/object/knownBy 的事实/事件
 */
export function pickMemoriesForScope(ws, scopeId) {
  const { chatIds, isGlobal } = getScopeChatIds(ws, scopeId);

  if (isGlobal) {
    const { map } = buildCharChatMap(ws.chats);
    const realIds = realCharacterIdSet(ws, map);
    const privateChatIds = privateChatIdSet(map);
    const summaries = ws.memories.filter((m) =>
      isSummary(m) && chatIds.has(m.chatId) && !normalizeMemoryActorId(m.characterId));
    const shared = ws.memories.filter((m) => {
      if (isSummary(m) || normalizeMemoryActorId(m.characterId)) return false;
      if (chatIds.has(m.chatId)) return true;
      // 朋友圈是公开可见事实，不是所有可见角色共同亲历；同时挡住旧版 category=shared 记录。
      if (String(m.source || '') === 'moments' || String(m.momentPostId || '').trim()) return false;
      // 手动写入及用户发布的共享记忆可能没有来源会话，仍应收进全局共享桶。
      return !normalizeMemoryActorId(m.chatId) && String(m.category || '') === 'shared';
    });
    const timeMachineFragments = (ws.collectibles || []).filter((c) => c.source === 'time_machine');
    const events = ws.events.filter((e) =>
      Array.isArray(e.involvedChats) && e.involvedChats.some((id) => chatIds.has(id)));
    // 未归属到任何真实角色的事实 → 落到全局，按匿名/主体再细分，保证不丢。
    const unowned = ws.facts.filter((f) => !factOwnedByRealCharacter(f, realIds, privateChatIds));
    const anonymous = unowned.filter(isAnonFact);
    const aboutYou = unowned.filter((f) => !isAnonFact(f)
      && isWorkspaceUserActorId(f.subjectId, ws.userId));
    const characterTraits = unowned.filter((f) => !isAnonFact(f)
      && !isWorkspaceUserActorId(f.subjectId, ws.userId));
    return {
      summaries,
      shared,
      facts: [],
      events,
      archive: aboutYou,
      aboutYou,
      characterTraits,
      anonymous,
      timeMachineFragments,
    };
  }

  const cid = scopeId;
  const summaries = ws.memories.filter((m) =>
    isSummary(m) && (chatIds.has(m.chatId) || sameMemoryActorId(m.characterId, cid)));
  const shared = ws.memories.filter((m) =>
    !isSummary(m) && (chatIds.has(m.chatId) || sameMemoryActorId(m.characterId, cid)));
  const { aboutYou, characterTraits, anonymous } = splitFactsForScope(
    ws.facts,
    cid,
    chatIds,
    ws.userId,
  );
  const timeMachineFragments = (ws.collectibles || []).filter((c) =>
    sameMemoryActorId(c.characterId, cid) && c.source === 'time_machine');
  const events = ws.events.filter((e) =>
    (Array.isArray(e.involvedChats) && e.involvedChats.some((id) => chatIds.has(id)))
    || knownByTouches(e.knownBy, cid));

  return {
    summaries,
    shared,
    facts: [],
    events,
    archive: aboutYou,
    aboutYou,
    characterTraits,
    anonymous,
    timeMachineFragments,
  };
}

export function countsForScope(ws, scopeId) {
  const picked = pickMemoriesForScope(ws, scopeId);
  return {
    journal: picked.summaries.length,
    shared: picked.shared.length,
    fragments: (picked.timeMachineFragments || []).length,
    events: picked.events.length,
    archive: (picked.aboutYou || picked.archive || []).length,
    characterTraits: (picked.characterTraits || []).length,
    anonymous: (picked.anonymous || []).length,
    vector: null,
  };
}

export function scopeTotal(ws, scopeId) {
  const c = countsForScope(ws, scopeId);
  return c.journal + c.shared + c.fragments + c.events
    + c.archive + c.characterTraits + c.anonymous;
}

/**
 * 列出当前档位下「有记忆馆」的角色 id：
 * 私聊伙伴 + 被记忆/事实直接引用的角色（排除 user）。
 */
export function listMemoryCharacterIds(ws) {
  const { map } = buildCharChatMap(ws.chats);
  return [...realCharacterIdSet(ws, map)];
}

/**
 * 清掉一个「幽灵角色」在记忆馆里的全部痕迹——通讯录里已经没有这个 id 对应的角色卡了，
 * 它之所以还出现在角色列表里，只是因为某条事实/记忆的 subjectId/characterId 曾经被
 * 误写成一段人名原文（见 memory-facts.js 里 resolveEntityId 的注释），或者角色本身
 * 已经被删掉了。
 * - subjectId 就是这个幽灵 id 的事实：直接删（这条事实本来就是"关于"它的）。
 * - 只是在 objectId/knownBy 里提到这个幽灵 id 的事实：保留事实本体，只摘掉这个引用。
 * - characterId 命中的记忆/收集物：直接删。
 * - 仍把它当私聊对象的僵尸会话：连同 chat 级记忆一起删。
 * - 由上述数据生成的向量索引：同步删除，避免正文已删但语义搜索仍能找回。
 */
async function clearCharacterMemoryRows(userId, characterId, deletedChatIds = new Set()) {
  const uid = normalizeMemoryActorId(userId);
  const gid = normalizeMemoryActorId(characterId);
  if (!uid || !gid || gid === GLOBAL_SCOPE_ID) return { deleted: 0 };
  let deleted = 0;

  const memories = await db.getAllByIndex('memories', 'userId', uid);
  for (const m of (memories || [])) {
    if (sameMemoryActorId(m?.characterId, gid)) {
      await db.deleteRecord('memories', m.id);
      deleted += 1;
    }
  }

  const facts = await db.getAllByIndex('memoryFacts', 'userId', uid);
  for (const f of (facts || [])) {
    if (!f) continue;
    if (sameMemoryActorId(f.subjectId, gid)) {
      await db.deleteRecord('memoryFacts', f.id);
      deleted += 1;
      continue;
    }
    const kb = f.knownBy && typeof f.knownBy === 'object' ? f.knownBy : {};
    const touchesObject = sameMemoryActorId(f.objectId, gid);
    const matchingKnownByKeys = Object.keys(kb).filter((id) => sameMemoryActorId(id, gid));
    if (!touchesObject && !matchingKnownByKeys.length) continue;
    const nextKnownBy = { ...kb };
    matchingKnownByKeys.forEach((id) => delete nextKnownBy[id]);
    await db.putRecord('memoryFacts', {
      ...f,
      objectId: touchesObject ? '' : f.objectId,
      knownBy: nextKnownBy,
    });
  }

  const collectibles = await db.getAllByIndex('collectibles', 'userId', uid);
  for (const c of (collectibles || [])) {
    if (sameMemoryActorId(c?.characterId, gid)) {
      await db.deleteRecord('collectibles', c.id);
      deleted += 1;
    }
  }

  const events = await db.getAllByIndex('eventMemories', 'userId', uid);
  for (const event of (events || [])) {
    if (!event) continue;
    const knownBy = event.knownBy && typeof event.knownBy === 'object' ? event.knownBy : {};
    const matchingKnownByKeys = Object.keys(knownBy).filter((id) => sameMemoryActorId(id, gid));
    if (!matchingKnownByKeys.length) continue;
    const nextKnownBy = { ...knownBy };
    matchingKnownByKeys.forEach((id) => delete nextKnownBy[id]);
    await db.putRecord('eventMemories', { ...event, knownBy: nextKnownBy });
  }

  const vectors = await db.getAllByIndex('memoryVectors', 'userId', uid).catch(() => []);
  for (const vector of vectors) {
    const witnesses = Array.isArray(vector?.witnesses) ? vector.witnesses : [];
    const touchesCharacter = sameMemoryActorId(vector?.characterId, gid)
      || witnesses.some((id) => sameMemoryActorId(id, gid))
      || deletedChatIds.has(String(vector?.scopeId || '').trim());
    if (!touchesCharacter || !vector?.id) continue;
    await db.deleteRecord('memoryVectors', vector.id);
    deleted += 1;
  }

  return { deleted };
}

/**
 * 保留角色卡与聊天窗口，只清当前档位下该角色的整座记忆馆。
 * 角色对应私聊里的会话记忆也会清掉，但不会删除其它窗口的聊天消息。
 */
export async function clearCharacterMemoryScope(userId, characterId) {
  const uid = normalizeMemoryActorId(userId);
  const cid = normalizeMemoryActorId(characterId);
  if (!uid || !cid || cid === GLOBAL_SCOPE_ID) return { deleted: 0, clearedChats: 0 };

  const chats = await listChatsForUser(uid);
  const chatIds = new Set(
    chats
      .filter((chat) => chat && chat.type !== 'group' && sameMemoryActorId(chatPartnerId(chat), cid))
      .map((chat) => String(chat.id || '').trim())
      .filter(Boolean),
  );
  for (const chatId of chatIds) {
    await clearChatMemories(chatId, uid);
  }
  const result = await clearCharacterMemoryRows(uid, cid, chatIds);
  return { ...result, clearedChats: chatIds.size };
}

export async function deleteGhostCharacterScope(userId, ghostId) {
  const uid = normalizeMemoryActorId(userId);
  const gid = normalizeMemoryActorId(ghostId);
  if (!uid || !gid || gid === GLOBAL_SCOPE_ID) return { deleted: 0 };
  // 所有调用方共享的不可绕过保护：档位 ID 和仍存在的正式角色永远不是幽灵。
  // 身份表读取失败时抛错中止，不能把读取异常降级成“允许删除”。
  const [liveUser, liveCharacter] = await Promise.all([
    db.getRecord('users', gid),
    db.getRecord('characters', gid),
  ]);
  if (liveUser || liveCharacter) return { deleted: 0, protected: true };
  // 与记忆馆、数据自检共用同一份“合法身份”判定。旧逻辑只要关系网里还有一行
  // 就永远保护，恰好会让已经被自检确认为孤儿的 NPC 显示删除按钮却怎么也删不掉。
  // 动态导入用于避开 data-hygiene → memory-scope 的静态循环。
  const { loadKnownActorIdSet } = await import('../data-hygiene.js');
  const knownActorIds = await loadKnownActorIdSet();
  if (knownActorIds.has(gid)) return { deleted: 0, protected: true };
  const chats = await listChatsForUser(uid).catch(() => []);
  let deleted = 0;

  const deletedChatIds = new Set();
  for (const chat of chats) {
    if (!chat || chat.type === 'group' || !sameMemoryActorId(chatPartnerId(chat), gid)) continue;
    const chatId = String(chat.id || '').trim();
    if (!chatId) continue;
    deletedChatIds.add(chatId);
    await deleteChatWithData(chatId, uid);
    deleted += 1;
  }

  const result = await clearCharacterMemoryRows(uid, gid, deletedChatIds);
  if (/^(?:lightnpc_|npc_|phone-contact:)/i.test(gid)) {
    const { pruneActorsFromRelationshipNetwork } = await import('../relationship-network.js');
    await pruneActorsFromRelationshipNetwork([gid]);
  }
  return { deleted: deleted + result.deleted };
}
