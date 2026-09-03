import * as db from './db.js';
import { normalizeTranslationProfile } from '../models/character.js';

const SETTINGS_KEY = 'relationshipNetwork';
const SCOPE_MIGRATION_KEY = 'relationshipNetworkScopeMigrationV1';
const relationshipNetworkCache = new Map();
const relationshipNetworkInFlight = new Map();
let relationshipNetworkRevision = 0;

db.onStoreWrite('settings', (key) => {
  const normalizedKey = String(key || '');
  if (!normalizedKey || normalizedKey === SETTINGS_KEY || normalizedKey === SCOPE_MIGRATION_KEY) {
    relationshipNetworkRevision += 1;
    relationshipNetworkCache.clear();
    relationshipNetworkInFlight.clear();
    return;
  }
  if (!normalizedKey.startsWith(`${SETTINGS_KEY}:`)) return;
  relationshipNetworkRevision += 1;
  relationshipNetworkCache.delete(normalizedKey);
  relationshipNetworkInFlight.delete(normalizedKey);
});

function scopedSettingsKey(userId = '') {
  const id = String(userId || '').trim();
  return id ? `${SETTINGS_KEY}:${encodeURIComponent(id)}` : SETTINGS_KEY;
}

async function resolveRelationshipUserId(userId = '') {
  const explicit = String(userId || '').trim();
  if (explicit) return explicit;
  const current = await db.get('currentUserId').catch(() => null);
  return String(current?.value || '').trim();
}

function rid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function clampStr(value, len) {
  return String(value || '').trim().slice(0, len);
}

// 头像 data URL 不能走 clampStr：截到 2048 会把压缩后的 JPEG base64 截坏成裂图。
const MAX_NPC_AVATAR_CHARS = 900000;
function normalizeNpcAvatarUrl(value = '') {
  let url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  else if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
  if (!/^(data:image\/|https:\/\/)/i.test(url)) return '';
  return url.length <= MAX_NPC_AVATAR_CHARS ? url : '';
}

function normalizeNpc(raw) {
  if (!raw) return null;
  const name = clampStr(raw.name, 24);
  if (!name) return null;
  return {
    // phone-contact: 作用域 id 经常超过 60；截断会导致删通讯录后 prune 对不上。
    id: clampStr(raw.id, 240) || rid('npc'),
    name,
    note: clampStr(raw.note, 60),
    avatar: normalizeNpcAvatarUrl(raw.avatar || raw.avatarUrl),
    personality: clampStr(raw.personality, 280),
    speechStyle: clampStr(raw.speechStyle, 120),
    translationProfile: normalizeTranslationProfile(raw.translationProfile),
    sourceChatIds: Array.isArray(raw.sourceChatIds)
      ? [...new Set(raw.sourceChatIds.map((id) => clampStr(id, 60)).filter(Boolean))].slice(0, 20)
      : [],
    createdAt: Number(raw.createdAt) || 0,
  };
}

function normalizeEdge(raw) {
  if (!raw) return null;
  // phone-contact 是带 user/owner 作用域的身份，可能明显超过 60 字符。
  // 端点截断后会和 npcs[].id / 会话参与者失联。
  const a = clampStr(raw.a, 240);
  const b = clampStr(raw.b, 240);
  if (!a || !b || a === b) return null;
  return {
    id: clampStr(raw.id, 60) || rid('edge'),
    a,
    b,
    label: clampStr(raw.label, 20),
  };
}

function normalizeGroup(raw) {
  if (!raw) return null;
  const name = clampStr(raw.name, 24);
  if (!name) return null;
  const memberIds = Array.isArray(raw.memberIds)
    ? [...new Set(raw.memberIds.map((id) => clampStr(id, 240)).filter(Boolean))].slice(0, 30)
    : [];
  return {
    id: clampStr(raw.id, 60) || rid('grp'),
    name,
    memberIds,
    shareMemory: raw.shareMemory !== false,
    shareChatId: clampStr(raw.shareChatId, 60),
  };
}

function normalizeCircle(raw) {
  if (!raw) return null;
  const name = clampStr(raw.name, 24);
  if (!name) return null;
  const memberIds = Array.isArray(raw.memberIds)
    ? [...new Set(raw.memberIds.map((id) => clampStr(id, 240)).filter(Boolean))].slice(0, 60)
    : [];
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).map(normalizeGroup).filter(Boolean);
  const primaryChatByMembers = new Map();
  for (const group of groups) {
    const key = [...group.memberIds].sort().join(',');
    if (!key || !group.shareChatId) continue;
    if (primaryChatByMembers.has(key)) group.shareChatId = '';
    else primaryChatByMembers.set(key, group.shareChatId);
  }
  return {
    id: clampStr(raw.id, 60) || rid('cir'),
    name,
    memberIds,
    edges: (Array.isArray(raw.edges) ? raw.edges : []).map(normalizeEdge).filter(Boolean),
    groups,
  };
}

function normalizeDismissedNpc(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clampStr(raw.id, 60);
  const nameKey = clampStr(raw.nameKey || raw.name, 80).toLowerCase().replace(/[\s_\-./]+/g, '');
  if (!id && !nameKey) return null;
  return {
    id,
    nameKey,
    sourceChatIds: Array.isArray(raw.sourceChatIds)
      ? [...new Set(raw.sourceChatIds.map((item) => clampStr(item, 60)).filter(Boolean))].slice(0, 20)
      : [],
    dismissedAt: Number(raw.dismissedAt) || 0,
  };
}

function normalizeConfig(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const npcs = (Array.isArray(base.npcs) ? base.npcs : []).map(normalizeNpc).filter(Boolean);
  const dismissedNpcs = (Array.isArray(base.dismissedNpcs) ? base.dismissedNpcs : [])
    .map(normalizeDismissedNpc)
    .filter(Boolean)
    .slice(-200);

  // v2：圈 → 成员/连线/小群
  if (Array.isArray(base.circles)) {
    return {
      version: 2,
      npcs,
      dismissedNpcs,
      circles: base.circles.map(normalizeCircle).filter(Boolean),
    };
  }

  // v1 → v2 迁移：把扁平的 edges/groups 收进一个默认关系圈
  const legacyEdges = (Array.isArray(base.edges) ? base.edges : []).map(normalizeEdge).filter(Boolean);
  const legacyGroups = (Array.isArray(base.groups) ? base.groups : []).map(normalizeGroup).filter(Boolean);
  const circles = [];
  if (legacyEdges.length || legacyGroups.length) {
    const members = new Set();
    legacyEdges.forEach((e) => { members.add(e.a); members.add(e.b); });
    legacyGroups.forEach((g) => g.memberIds.forEach((id) => members.add(id)));
    circles.push({
      id: rid('cir'),
      name: '我的关系',
      memberIds: [...members].slice(0, 60),
      edges: legacyEdges,
      groups: legacyGroups,
    });
  }
  return { version: 2, npcs, dismissedNpcs, circles };
}

async function loadRelationshipNetworkUncached(userId = '') {
  const uid = await resolveRelationshipUserId(userId);
  if (!uid) {
    const row = await db.get(SETTINGS_KEY);
    return normalizeConfig(row?.value);
  }

  const scopedKey = scopedSettingsKey(uid);
  const scoped = await db.get(scopedKey);
  if (scoped) return normalizeConfig(scoped.value);

  // 旧版本只有一个全局关系网。升级后只把它归给首次打开的 user，
  // 其余 user 从空关系网开始，避免同一份关系被静默复制到所有身份。
  const migration = await db.get(SCOPE_MIGRATION_KEY).catch(() => null);
  if (!migration?.value?.ownerUserId) {
    const legacy = await db.get(SETTINGS_KEY).catch(() => null);
    if (legacy?.value) {
      const migrated = normalizeConfig(legacy.value);
      await db.put({ key: scopedKey, value: migrated });
      await db.put({
        key: SCOPE_MIGRATION_KEY,
        value: { ownerUserId: uid, migratedAt: Date.now() },
      });
      return migrated;
    }
  }
  return normalizeConfig(null);
}

export async function loadRelationshipNetwork(userId = '') {
  const uid = await resolveRelationshipUserId(userId);
  const cacheKey = scopedSettingsKey(uid);
  if (relationshipNetworkCache.has(cacheKey)) return relationshipNetworkCache.get(cacheKey);
  if (relationshipNetworkInFlight.has(cacheKey)) return relationshipNetworkInFlight.get(cacheKey);

  const pending = (async () => {
    let value;
    let observedRevision;
    do {
      observedRevision = relationshipNetworkRevision;
      value = await loadRelationshipNetworkUncached(uid);
    } while (observedRevision !== relationshipNetworkRevision);
    relationshipNetworkCache.set(cacheKey, value);
    return value;
  })()
    .finally(() => {
      if (relationshipNetworkInFlight.get(cacheKey) === pending) {
        relationshipNetworkInFlight.delete(cacheKey);
      }
    });
  relationshipNetworkInFlight.set(cacheKey, pending);
  return pending;
}

export async function saveRelationshipNetwork(config, userId = '') {
  const next = normalizeConfig(config);
  const uid = await resolveRelationshipUserId(userId);
  await db.put({ key: scopedSettingsKey(uid), value: next });
  return next;
}

function isPhoneContactActorId(id = '') {
  return /^phone-contact:/i.test(String(id || '').trim());
}

/** 精确匹配；phone-contact 兼容旧版 60 字截断残留（一侧是另一侧前缀即视为同一人）。 */
export function relationshipActorIdsMatch(storedId = '', targetId = '') {
  const stored = String(storedId || '').trim();
  const target = String(targetId || '').trim();
  if (!stored || !target) return false;
  if (stored === target) return true;
  if (!isPhoneContactActorId(stored) || !isPhoneContactActorId(target)) return false;
  return stored.startsWith(target) || target.startsWith(stored);
}

/**
 * 从关系网摘掉某个身份：节点、圈成员、连线、小群成员一并清。
 * 用于轻量 NPC dismiss、手机联系人删除、以及自检清理孤儿 phone-contact。
 */
export function removeActorFromRelationshipNetwork(net, actorId = '') {
  const id = clampStr(actorId, 240);
  if (!id || !net) return net;
  const drop = (memberId) => relationshipActorIdsMatch(memberId, id);
  const circles = (net.circles || []).map((circle) => ({
    ...circle,
    memberIds: (circle.memberIds || []).filter((memberId) => !drop(memberId)),
    edges: (circle.edges || []).filter((edge) => !drop(edge?.a) && !drop(edge?.b)),
    groups: (circle.groups || []).map((group) => ({
      ...group,
      memberIds: (group.memberIds || []).filter((memberId) => !drop(memberId)),
    })),
  })).filter((circle) => (
    circle.memberIds.length
    || circle.edges.length
    || circle.groups.some((group) => group.memberIds.length)
  ));
  return {
    ...net,
    npcs: (net.npcs || []).filter((row) => !drop(row?.id)),
    circles,
  };
}

/** 落库版：从关系网摘掉若干身份，返回实际摘掉的 id 列表。 */
export async function pruneActorsFromRelationshipNetwork(actorIds = [], userId = '') {
  const ids = [...new Set(
    (Array.isArray(actorIds) ? actorIds : [])
      .map((id) => clampStr(id, 240))
      .filter(Boolean),
  )];
  if (!ids.length) return { ok: true, pruned: [] };
  const net = await loadRelationshipNetwork(userId).catch(() => ({
    version: 2, npcs: [], circles: [], dismissedNpcs: [],
  }));
  let next = net;
  const pruned = [];
  for (const id of ids) {
    const beforeNpcs = (next.npcs || []).some((row) => relationshipActorIdsMatch(row?.id, id));
    const beforeMembers = (next.circles || []).some((circle) => (
      (circle.memberIds || []).some((memberId) => relationshipActorIdsMatch(memberId, id))
      || (circle.edges || []).some((edge) => (
        relationshipActorIdsMatch(edge?.a, id) || relationshipActorIdsMatch(edge?.b, id)
      ))
      || (circle.groups || []).some((group) => (
        (group.memberIds || []).some((memberId) => relationshipActorIdsMatch(memberId, id))
      ))
    ));
    if (!beforeNpcs && !beforeMembers) continue;
    next = removeActorFromRelationshipNetwork(next, id);
    pruned.push(id);
  }
  if (!pruned.length) return { ok: true, pruned: [] };
  await saveRelationshipNetwork(next, userId);
  return { ok: true, pruned };
}

export function newNpcId() { return rid('npc'); }
export function newCircleId() { return rid('cir'); }
export function newEdgeId() { return rid('edge'); }
export function findCircle(config, circleId) {
  return (config.circles || []).find((c) => c.id === circleId) || null;
}

/** 与 seed 角色处于同一子网的所有成员 id（含 seed，排除 user） */
export function collectCoNetworkMemberIds(config, seedIds = []) {
  const seeds = new Set((seedIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  if (!seeds.size) return [];
  const out = new Set();
  for (const circle of config?.circles || []) {
    const members = circle.memberIds || [];
    const hit = members.some((id) => seeds.has(id));
    if (!hit) continue;
    members.forEach((id) => {
      if (id && id !== 'user') out.add(id);
    });
  }
  return [...out];
}

/** 某角色所在的所有子网 */
export function findCirclesForMember(config, memberId) {
  const id = String(memberId || '').trim();
  if (!id) return [];
  return (config?.circles || []).filter((c) => (c.memberIds || []).includes(id));
}

/** 通讯录-关系网页标过的连线，返回可注入的行（不含 header） */
export function collectGlobalRelationshipNetworkLines(config, {
  partnerIds = [],
  characters = {},
  userName = '我',
  maxEdges = 14,
  linePrefix = '',
  includeUser = true,
} = {}) {
  const net = config && typeof config === 'object' ? config : null;
  if (!net?.circles?.length) return [];
  const focusIds = new Set([
    ...(includeUser ? ['user'] : []),
    ...(partnerIds || []).filter((id) => id && (includeUser || id !== 'user')),
  ]);
  const npcById = new Map((net.npcs || []).map((n) => [n.id, n]));
  const prefix = String(linePrefix || '').trim();

  const nodeName = (id) => {
    const key = String(id || '').trim();
    if (!key) return '';
    if (key === 'user') return String(userName || '我').trim() || '我';
    const c = characters[key];
    if (c) return String(c.realName || c.name || '').trim();
    const n = npcById.get(key);
    return n ? String(n.name || '').trim() : '';
  };

  const lines = [];
  const seen = new Set();
  for (const circle of net.circles) {
    const memberSet = new Set([
      ...(circle.memberIds || []).filter((id) => includeUser || id !== 'user'),
      ...(includeUser ? ['user'] : []),
    ]);
    const circleRelevant = [...focusIds].some((id) => memberSet.has(id));
    if (!circleRelevant) continue;
    for (const edge of circle.edges || []) {
      if (!edge?.a || !edge?.b || edge.a === edge.b) continue;
      // 只注入本轮双方都在 focus 内的关系边；不能因 B 入选就把 A↔B 的「助理」
      // 等专属关系带给无关的 C，造成角色归属错位。
      if (!focusIds.has(edge.a) || !focusIds.has(edge.b)) continue;
      const aName = nodeName(edge.a);
      const bName = nodeName(edge.b);
      if (!aName || !bName) continue;
      const pairKey = [edge.a, edge.b].sort().join('\0');
      const dedupe = `${pairKey}|${String(edge.label || '').trim()}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const label = String(edge.label || '').trim() || '认识';
      const line = `${aName} · ${label} · ${bName}（${circle.name || '子网'}）`;
      lines.push(prefix ? `${prefix} ${line}` : line);
      if (lines.length >= maxEdges) break;
    }
    if (lines.length >= maxEdges) break;
  }
  return lines;
}

/** 通讯录-关系网页标过的连线，注入私聊/群聊 system prompt */
export function buildGlobalRelationshipNetworkPromptBlock(config, options = {}) {
  const lines = collectGlobalRelationshipNetworkLines(config, options).map((line) => `  - ${line}`);
  if (!lines.length) return '';
  return [
    '【全局关系网 · 通讯录关系网页已标关系】',
    ...lines,
    '以上是用户整理的真实关系：聊天里可以自然提起、串场、幕后联动；一轮至多顺口带到一两个人，不要报菜名式全念完。',
  ].join('\n');
}

function relationshipName(id, characters = {}, userName = '用户', npcById = new Map()) {
  const key = String(id || '').trim();
  if (!key) return '';
  if (key === 'user') return String(userName || '用户').trim() || '用户';
  const row = characters[key];
  if (row) return String(row.realName || row.name || key).trim();
  return String(npcById.get(key)?.name || '').trim();
}

function pairKey(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right || left === right) return '';
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

/**
 * 为当前参与角色生成统一关系事实与互识边界。
 * 角色卡关系 > 关系网页边 > 剧情认识账本 > 同关系圈/组内互识。
 * 后两者只代表可以自然互动，不能被描述成具体亲密关系。
 */
export function buildRelationshipContextBlock(config, {
  participantIds = [],
  characters = {},
  userName = '用户',
  acquaintanceLedger = null,
  contactGroupsConfig = null,
  maxLines = 24,
} = {}) {
  const ids = [...new Set((participantIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    .slice(0, 24);
  if (ids.length < 2) return '';
  const idSet = new Set(ids);
  const npcById = new Map((config?.npcs || []).map((item) => [item.id, item]));
  const edgeLabels = new Map();
  const circlePairs = new Set();
  for (const circle of config?.circles || []) {
    const members = (circle.memberIds || []).filter((id) => idSet.has(id));
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) circlePairs.add(pairKey(members[i], members[j]));
    }
    for (const edge of circle.edges || []) {
      const key = pairKey(edge?.a, edge?.b);
      if (!key || !idSet.has(edge.a) || !idSet.has(edge.b) || edgeLabels.has(key)) continue;
      edgeLabels.set(key, String(edge.label || '').trim());
    }
  }
  const groupCanKnow = (a, b) => {
    const left = characters[a];
    const right = characters[b];
    const leftGroup = String(left?.groupId || 'default').trim() || 'default';
    const rightGroup = String(right?.groupId || 'default').trim() || 'default';
    if (leftGroup === 'default' || leftGroup !== rightGroup) return false;
    return (contactGroupsConfig?.groups || []).some((group) => (
      String(group?.id || '') === leftGroup && group?.mutualAcquaintance === true
    ));
  };
  const lines = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      const key = pairKey(a, b);
      const cardLabel = String(characters[a]?.relationships?.[b]
        || characters[b]?.relationships?.[a] || '').trim();
      const ledgerEntry = (acquaintanceLedger?.entries || []).find((entry) => pairKey(entry?.a, entry?.b) === key);
      const label = cardLabel
        || edgeLabels.get(key)
        || String(ledgerEntry?.label || '').trim()
        || (ledgerEntry ? (ledgerEntry.level === 'met' ? '刚认识' : '认识') : '')
        || (circlePairs.has(key) ? '同一关系圈（关系未细标）' : '')
        || (groupCanKnow(a, b) ? '同一通讯录分组（组内互识）' : '');
      if (!label) continue;
      const aName = relationshipName(a, characters, userName, npcById);
      const bName = relationshipName(b, characters, userName, npcById);
      if (aName && bName) lines.push(`  - ${aName} ↔ ${bName}：${label}`);
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  return [
    '【角色关系与互识边界 · 硬事实】',
    lines.length ? lines.join('\n') : '本轮角色之间没有已建立的关系。',
    '未列出的角色默认互不认识；不得互相点名、代替熟人接话或凭空共享私密经历。标为“刚认识”“同一关系圈”或“组内互识”时，只能按关系距离克制互动。',
  ].join('\n');
}
