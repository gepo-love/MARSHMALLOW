import * as db from './db.js';
import { WORLD_BOOKS } from '../data/world-books.js';
import { createWorldBookEntry, WORLD_BOOK_CATEGORIES } from '../models/worldbook.js';
import { listCharacters } from './character-store.js';
import { resolveCharacterGroupId } from './contact-groups.js';
import { loadRelationshipNetwork, findCircle } from './relationship-network.js';
import {
  enqueueVectorSource,
  deleteVectorSourcesByPrefix,
  getMemoryVectorIndexStats,
  requestMemoryVectorBacklog,
  searchMemoryVectors,
  VECTOR_THRESHOLDS,
} from './memory/memory-vectors.js';
import { rankLexicalPassages } from './memory/vector-passages.js';

const HIDDEN_KEY = 'worldBookHiddenIds';
const COLLAPSED_KEY = 'worldBookCollapsedIds';
export const WORLD_BOOK_VECTOR_MANAGEMENT_KEY = 'worldBookVectorManagementEnabled';
export const WORLD_BOOK_VECTOR_CHUNK_CHARS = 1800;
const WORLD_BOOK_VECTOR_CHUNK_OVERLAP = 140;
const WORLD_BOOK_VECTOR_ENTRY_BUDGET_CHARS = 3600;
const WORLD_BOOK_VECTOR_CONTEXT_BUDGET_CHARS = 12000;
const WORLD_BOOK_VECTOR_MAX_MATCHED_ENTRIES = 8;
let worldBookRowsSnapshotPromise = null;
let worldBookRowsRevision = 0;

function invalidateWorldBookRowsSnapshot() {
  worldBookRowsRevision += 1;
  worldBookRowsSnapshotPromise = null;
}

db.onStoreWrite('worldBooks', invalidateWorldBookRowsSnapshot);
db.onStoreWrite('settings', (key) => {
  const normalized = String(key || '');
  if (!normalized || normalized === HIDDEN_KEY) invalidateWorldBookRowsSnapshot();
});

const WORLD_BOOK_PRIORITY_RANK = { core: 0, normal: 1, hint: 2 };
const WORLD_BOOK_PRIORITY_PREFIX = {
  core: '[核心设定·必须遵守] ',
  hint: '[参考·不必照搬] ',
};
const LEGACY_BUILTIN_REALISTIC_TONE = `[对话基调]
- 像真人聊天：口语、短句、可省略，不要客服腔或作文腔
- 先反应再补内容；允许停顿、改口、碎片化多条
- 角色活在具体关系与生活里，不要 24 小时贴标签
- 不确定的事先问细节，不要审判对方的普通选择`;

export async function loadWorldBookVectorManagementEnabled() {
  const row = await db.get(WORLD_BOOK_VECTOR_MANAGEMENT_KEY).catch(() => null);
  return row?.value === true;
}

export async function saveWorldBookVectorManagementEnabled(enabled) {
  const value = enabled === true;
  await db.put({ key: WORLD_BOOK_VECTOR_MANAGEMENT_KEY, value });
  return value;
}

function splitLongWorldBookParagraph(text = '', maxChars = WORLD_BOOK_VECTOR_CHUNK_CHARS) {
  const value = String(text || '').trim();
  if (!value) return [];
  if (value.length <= maxChars) return [value];
  const rows = [];
  for (let start = 0; start < value.length; start += Math.max(1, maxChars - WORLD_BOOK_VECTOR_CHUNK_OVERLAP)) {
    rows.push(value.slice(start, start + maxChars).trim());
    if (start + maxChars >= value.length) break;
  }
  return rows.filter(Boolean);
}

export function splitWorldBookVectorContent(content = '', maxChars = WORLD_BOOK_VECTOR_CHUNK_CHARS) {
  const cap = Math.max(600, Math.min(6000, Math.floor(Number(maxChars) || WORLD_BOOK_VECTOR_CHUNK_CHARS)));
  const paragraphs = String(content || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .flatMap((paragraph) => splitLongWorldBookParagraph(paragraph, cap))
    .filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= cap) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = paragraph;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildWorldBookVectorSources(entry = {}) {
  if (!entry?.id || isGroupEntry(entry) || entry.system === 'miniwiki') return [];
  const chunks = splitWorldBookVectorContent(entry.content);
  const witnesses = entry.scope === 'character'
    ? (Array.isArray(entry.characterIds) ? entry.characterIds : [])
    : [];
  return chunks.map((chunk, index) => ({
    id: `${entry.id}:chunk:${index}`,
    parentSourceId: String(entry.id),
    worldBookEntryId: String(entry.id),
    userId: String(entry.userId || ''),
    bookId: String(entry.bookId || ''),
    sourceType: 'worldbook_passage',
    type: 'worldbook_passage',
    knownByActorIds: witnesses,
    chunkIndex: index,
    chunkCount: chunks.length,
    updatedAt: Number(entry.updatedAt || Date.now()),
    content: [String(entry.name || '').trim(), chunk].filter(Boolean).join('\n'),
  }));
}

async function queueWorldBookVectorEntry(entry = {}, { force = false, notify = true } = {}) {
  if (!entry?.id || isGroupEntry(entry) || entry.system === 'miniwiki') return 0;
  if (!(await loadWorldBookVectorManagementEnabled())) return 0;
  const sources = buildWorldBookVectorSources(entry);
  const validIds = new Set(sources.map((source) => source.id));
  const stored = await db.getAllByIndex('memoryVectors', 'namespace', 'worldbook').catch(() => []);
  const staleIds = stored
    .filter((row) => (
      String(row?.parentSourceId || '') === String(entry.id)
      || String(row?.sourceId || '') === String(entry.id)
      || String(row?.sourceId || '').startsWith(`${entry.id}:chunk:`)
    ) && !validIds.has(String(row?.sourceId || '')))
    .map((row) => row.id)
    .filter(Boolean);
  if (staleIds.length) await db.deleteMany('memoryVectors', staleIds);
  let queued = 0;
  for (const source of sources) {
    const row = await enqueueVectorSource('worldbook', source, {
      force,
      notify: false,
    }).catch(() => null);
    if (row) queued += 1;
  }
  if (queued && notify) requestMemoryVectorBacklog('queued:worldbook');
  return queued;
}

export async function queueWorldBookVectorIndex({ force = false } = {}) {
  if (!(await loadWorldBookVectorManagementEnabled())) {
    return { queued: 0, passages: 0, enabled: false };
  }
  const rows = (await listAllWorldBookRows())
    .filter((entry) => isItemEntry(entry) && entry.system !== 'miniwiki');
  let queued = 0;
  let passages = 0;
  for (const entry of rows) {
    passages += buildWorldBookVectorSources(entry).length;
    queued += await queueWorldBookVectorEntry(entry, { force, notify: false });
  }
  requestMemoryVectorBacklog(force ? 'worldbook-rebuild' : 'worldbook-index');
  return { queued, passages, enabled: true };
}

export async function getWorldBookVectorManagementStatus(existingRows = null) {
  const rowsPromise = Array.isArray(existingRows)
    ? Promise.resolve(existingRows)
    : listAllWorldBookRows();
  const [enabled, stats, rows] = await Promise.all([
    loadWorldBookVectorManagementEnabled(),
    getMemoryVectorIndexStats({ namespaces: ['worldbook'] }).catch(() => ({
      total: 0,
      ready: 0,
      pending: 0,
      failed: 0,
      superseded: 0,
    })),
    rowsPromise,
  ]);
  const passages = rows
    .filter((entry) => isItemEntry(entry) && entry.system !== 'miniwiki')
    .reduce((sum, entry) => sum + buildWorldBookVectorSources(entry).length, 0);
  return { enabled, passages, ...stats };
}

export async function getHiddenWorldBookIds() {
  const row = await db.get(HIDDEN_KEY);
  const list = Array.isArray(row?.value) ? row.value : [];
  return new Set(list.map((x) => String(x)).filter(Boolean));
}

export async function hideWorldBookId(id) {
  const set = await getHiddenWorldBookIds();
  set.add(String(id));
  await db.put({ key: HIDDEN_KEY, value: [...set] });
}

export async function getCollapsedWorldBookIds() {
  const row = await db.get(COLLAPSED_KEY);
  const list = Array.isArray(row?.value) ? row.value : [];
  return new Set(list.map((x) => String(x)).filter(Boolean));
}

export async function saveCollapsedWorldBookIds(ids = []) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)).filter(Boolean))];
  await db.put({ key: COLLAPSED_KEY, value: clean });
}

export async function toggleCollapsedId(id, collapsedSet) {
  const key = String(id || '').trim();
  if (!key) return collapsedSet;
  const next = new Set(collapsedSet);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  await saveCollapsedWorldBookIds([...next]);
  return next;
}

export async function seedWorldBooksIfEmpty(existingRows = null) {
  const stored = Array.isArray(existingRows)
    ? existingRows
    : await db.getAllRecords('worldBooks');
  if (!Array.isArray(stored) || !stored.length) {
    await db.putMany('worldBooks', WORLD_BOOKS);
    return true;
  }
  const legacyTone = stored.find((row) => (
    String(row?.id || '') === 'wb_tone_realistic'
    && String(row?.content || '') === LEGACY_BUILTIN_REALISTIC_TONE
  ));
  if (!legacyTone) return false;
  const currentTone = WORLD_BOOKS.find((row) => row.id === 'wb_tone_realistic');
  if (!currentTone) return false;
  await db.putMany('worldBooks', [{
    ...legacyTone,
    content: currentTone.content,
    updatedAt: Date.now(),
  }]);
  return true;
}

export async function listAllWorldBookRows() {
  const requestedRevision = worldBookRowsRevision;
  if (!worldBookRowsSnapshotPromise) {
    worldBookRowsSnapshotPromise = (async () => {
      let stored = await db.getAllRecords('worldBooks');
      const seededOrMigrated = await seedWorldBooksIfEmpty(stored);
      if (seededOrMigrated) stored = await db.getAllRecords('worldBooks');
      const hidden = await getHiddenWorldBookIds();
      const byId = new Map((Array.isArray(stored) ? stored : []).map((e) => [e.id, { ...e }]));
      for (const seed of WORLD_BOOKS) {
        if (!byId.has(seed.id) && !hidden.has(seed.id)) {
          byId.set(seed.id, { ...seed });
        }
      }
      return [...byId.values()].filter((e) => !hidden.has(e.id));
    })().catch((error) => {
      worldBookRowsSnapshotPromise = null;
      throw error;
    });
  }
  const rows = await worldBookRowsSnapshotPromise;
  // 构建期间若发生写入，不把旧集合交给本轮；按新 revision 再取一次。
  if (requestedRevision !== worldBookRowsRevision) return listAllWorldBookRows();
  return rows;
}

function isGroupEntry(entry) {
  return entry?.kind === 'group' || !!entry?.isBookRoot || !!entry?.isCollection;
}

function isItemEntry(entry) {
  return !isGroupEntry(entry);
}

function isCollectionEntry(entry) {
  return !!entry?.isCollection;
}

export function selectiveMatchesWorldBook(wb, textBlob = '', options = {}) {
  if (!wb) return false;
  if (!wb.selective) return options.requireSelective !== true;
  const keys = wb.keys || [];
  if (!keys.length) return true;
  const lower = String(textBlob || '').toLowerCase();
  return keys.some((k) => lower.includes(String(k).toLowerCase()));
}

/** 世界书 id 列表归一化：兼容数组、{ worldBookIds }、旧版 worldBookId 字符串。 */
export function normalizeWorldBookIds(source = {}) {
  const raw = Array.isArray(source)
    ? source
    : (Array.isArray(source?.worldBookIds)
      ? source.worldBookIds
      : (source?.worldBookId ? [source.worldBookId] : []));
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

function scopeMatchesWorldBook(entry, characterIds = [], groupMembersMap = null) {
  const active = new Set((Array.isArray(characterIds) ? characterIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (entry?.scope === 'group') {
    if (!active.size) return false;
    const key = `${entry.groupType || 'contact'}:${entry.groupRefId || ''}`;
    const members = groupMembersMap?.get(key);
    if (!members || !members.size) return false;
    return [...active].some((id) => members.has(id));
  }
  if (entry?.scope !== 'character') return true;
  if (!active.size) return false;
  const bound = Array.isArray(entry.characterIds)
    ? entry.characterIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (!bound.length) return false;
  return bound.some((id) => active.has(id));
}

/**
 * 预展开所有 scope='group' 条目引用的分组成员：
 * contact → 通讯录分组（character.groupId 匹配），relationship → 关系网圈子 memberIds。
 * 只有确实存在 group 绑定条目时才加载分组数据，避免每次注入都白查。
 */
async function buildGroupMembersMap(entries = [], userId = '') {
  const refs = new Set();
  for (const e of entries) {
    if (e?.scope === 'group' && e.groupRefId) {
      refs.add(`${e.groupType || 'contact'}:${e.groupRefId}`);
    }
  }
  if (!refs.size) return null;
  const map = new Map();
  const needContact = [...refs].some((k) => k.startsWith('contact:'));
  const needRelationship = [...refs].some((k) => k.startsWith('relationship:'));
  if (needContact) {
    const characters = await listCharacters({ userId }).catch(() => []);
    for (const key of refs) {
      if (!key.startsWith('contact:')) continue;
      const groupId = key.slice('contact:'.length);
      map.set(key, new Set(
        (characters || [])
          .filter((c) => c?.id && resolveCharacterGroupId(c) === groupId)
          .map((c) => String(c.id)),
      ));
    }
  }
  if (needRelationship) {
    const network = await loadRelationshipNetwork(userId).catch(() => null);
    for (const key of refs) {
      if (!key.startsWith('relationship:')) continue;
      const circleId = key.slice('relationship:'.length);
      const circle = network ? findCircle(network, circleId) : null;
      map.set(key, new Set(
        (circle?.memberIds || []).map((id) => String(id || '').trim()).filter((id) => id && id !== 'user'),
      ));
    }
  }
  return map;
}

function buildBooksById(all = []) {
  const map = new Map();
  for (const row of all) {
    if (row?.isBookRoot && !row?.isCollection) map.set(row.id, row);
  }
  return map;
}

function buildCollectionsById(all = []) {
  const map = new Map();
  for (const row of all) {
    if (isCollectionEntry(row)) map.set(row.id, row);
  }
  return map;
}

/** 当前上下文是否应启用该世界书（整本） */
export function isBookActiveForContext(book, characterIds = [], onlyBookIds = new Set(), groupMembersMap = null) {
  if (!book?.id) return true;
  const bookId = String(book.id);
  // 会话显式选书是额外启用，不是排他白名单；全局规则仍应继续生效。
  if (onlyBookIds.has(bookId)) return true;
  // 默认规则下，无论整本按全局、角色还是分组绑定，关闭都必须真正停止注入。
  if (book.enabled === false) return false;
  if (book.scope === 'character' || book.scope === 'group') {
    return scopeMatchesWorldBook(book, characterIds, groupMembersMap);
  }
  return true;
}

/** 条目是否通过人物绑定校验（优先继承整本 scope，兼容旧版条目级绑定） */
function itemScopeAllowed(item, booksById, characterIds = [], groupMembersMap = null, onlyBookIds = new Set()) {
  const book = item?.bookId ? booksById.get(item.bookId) : null;
  if (book?.id && onlyBookIds.has(String(book.id))) return true;
  if (book?.scope === 'character' || book?.scope === 'group') {
    return scopeMatchesWorldBook(book, characterIds, groupMembersMap);
  }
  if (item?.scope === 'character' || item?.scope === 'group') {
    return scopeMatchesWorldBook(item, characterIds, groupMembersMap);
  }
  return true;
}

export function listWorldBookRootOptions(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .filter((row) => row?.isBookRoot && row.id !== '_orphan')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'))
    .map((row) => ({ id: row.id, name: row.name || row.title || row.id }));
}

export async function getActiveWorldBookItems(user = null, textForSelective = '', options = {}) {
  const mode = options.worldBookMode === 'full' ? 'full' : 'selective';
  const characterIds = Array.isArray(options.characterIds) ? options.characterIds : [];
  // system 过滤：默认只出常规世界书；'miniwiki' 只出小知识库；'all' 不过滤。
  const systemFilter = options.system === 'miniwiki' ? 'miniwiki' : (options.system === 'all' ? 'all' : 'worldbook');
  // 会话/线下显式指定时只保留这些书；可包含全局已关的书。
  const onlyBookIds = new Set(
    normalizeWorldBookIds(
      options.onlyBookIds ?? options.worldBookIds ?? options.worldBookId ?? [],
    ),
  );
  const restrictToBookIds = options.restrictToBookIds === true;
  const all = await listAllWorldBookRows();
  const userId = user?.id || null;
  const booksById = buildBooksById(all);
  const collectionsById = buildCollectionsById(all);
  const groupMembersMap = await buildGroupMembersMap(all, userId);

  const groupEnabled = new Map();
  for (const e of all) {
    if (isGroupEntry(e)) {
      groupEnabled.set(e.id, e.enabled !== false);
    }
  }

  const items = all
    .filter((e) => isItemEntry(e))
    .filter((e) => {
      if (systemFilter !== 'all' && (e.system === 'miniwiki' ? 'miniwiki' : 'worldbook') !== systemFilter) return false;
      if (e.enabled === false) return false;
      const book = e.bookId ? booksById.get(e.bookId) : null;
      // 某些独立生成器（如电台）把页面勾选理解为严格白名单：不勾即不读，
      // 勾选后也不能混入全局开启、人物绑定或其它会话额外启用的书。
      if (restrictToBookIds && (!book?.id || !onlyBookIds.has(String(book.id)))) return false;
      const collection = book?.collectionId ? collectionsById.get(book.collectionId) : null;
      if (collection?.enabled === false) return false;
      if (book && !isBookActiveForContext(book, characterIds, onlyBookIds, groupMembersMap)) return false;
      if (e.groupId && groupEnabled.has(e.groupId) && groupEnabled.get(e.groupId) === false) return false;
      if (e.userId && userId && e.userId !== userId) return false;
      if (e.userId && !userId) return false;
      if (!itemScopeAllowed(e, booksById, characterIds, groupMembersMap, onlyBookIds)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        (WORLD_BOOK_PRIORITY_RANK[a.priority] ?? 1) - (WORLD_BOOK_PRIORITY_RANK[b.priority] ?? 1)
        || (a.position ?? 0) - (b.position ?? 0)
        || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'),
    );

  const constant = items.filter((wb) => wb.constant);
  const variable = items.filter((wb) => !wb.constant);
  const vectorManaged = systemFilter === 'worldbook'
    && options.forceFullEntries !== true
    && await loadWorldBookVectorManagementEnabled();
  let matchedConstant = constant;
  let matchedVariable = variable;
  if (mode !== 'full' || vectorManaged) {
    const retrievalCandidates = vectorManaged ? items : variable;
    const keywordIds = new Set(
      retrievalCandidates
        .filter((wb) => selectiveMatchesWorldBook(wb, textForSelective, {
          requireSelective: vectorManaged,
        }))
        .map((wb) => String(wb.id)),
    );
    const semanticRows = vectorManaged && textForSelective
      ? await searchMemoryVectors(textForSelective, {
        userId: userId || '',
        namespaces: ['worldbook'],
        characterIds,
        limit: Math.min(40, Math.max(8, retrievalCandidates.length)),
        threshold: VECTOR_THRESHOLDS.worldbook,
      }).catch(() => [])
      : [];
    const semanticByEntry = new Map();
    for (const row of semanticRows) {
      const entryId = String(
        row?.parentSourceId
        || String(row?.sourceId || '').replace(/:chunk:\d+$/, ''),
      ).trim();
      if (!entryId) continue;
      const list = semanticByEntry.get(entryId) || [];
      if (list.length < 3) list.push(row);
      semanticByEntry.set(entryId, list);
    }
    const lexicalRows = vectorManaged && textForSelective
      ? rankLexicalPassages(
        textForSelective,
        retrievalCandidates.map((entry) => ({
          id: String(entry.id),
          excerpt: [entry.name, entry.content].filter(Boolean).join('\n'),
          timestamp: Number(entry.updatedAt || 0),
        })),
        { limit: 4, budgetChars: 5000, maxItemChars: 1400, minScore: 1.1 },
      )
      : [];
    const lexicalByEntry = new Map(lexicalRows.map((row) => [String(row.id), row]));
    if (vectorManaged) {
      const rankedMatches = retrievalCandidates.flatMap((wb, sourceIndex) => {
        const id = String(wb.id);
        if (keywordIds.has(id)) {
          const focused = rankLexicalPassages(
            textForSelective,
            [{
              id,
              excerpt: [wb.name, wb.content].filter(Boolean).join('\n'),
              timestamp: Number(wb.updatedAt || 0),
            }],
            {
              limit: 1,
              budgetChars: WORLD_BOOK_VECTOR_ENTRY_BUDGET_CHARS,
              maxItemChars: WORLD_BOOK_VECTOR_ENTRY_BUDGET_CHARS,
              minScore: 0,
            },
          )[0]?.excerpt;
          const content = String(focused || wb.content || '')
            .trim()
            .slice(0, WORLD_BOOK_VECTOR_ENTRY_BUDGET_CHARS);
          return content ? [{
            row: { ...wb, vectorContextContent: content },
            rank: 3000,
            sourceIndex,
          }] : [];
        }
        const semantic = semanticByEntry.get(id) || [];
        if (semantic.length) {
          const content = semantic
            .sort((left, right) => Number(left.chunkIndex || 0) - Number(right.chunkIndex || 0))
            .map((row) => String(row.content || '').trim())
            .filter(Boolean)
            .join('\n\n')
            .slice(0, WORLD_BOOK_VECTOR_ENTRY_BUDGET_CHARS);
          return content ? [{
            row: { ...wb, vectorContextContent: content },
            rank: 2000 + Number(semantic[0]?.score || 0),
            sourceIndex,
          }] : [];
        }
        const lexical = lexicalByEntry.get(id);
        const content = String(lexical?.excerpt || '')
          .trim()
          .slice(0, WORLD_BOOK_VECTOR_ENTRY_BUDGET_CHARS);
        return content ? [{
          row: { ...wb, vectorContextContent: content },
          rank: 1000 + Number(lexical?.score || 0),
          sourceIndex,
        }] : [];
      });
      rankedMatches.sort((left, right) => right.rank - left.rank || left.sourceIndex - right.sourceIndex);
      const matched = [];
      let remainingChars = WORLD_BOOK_VECTOR_CONTEXT_BUDGET_CHARS;
      for (const match of rankedMatches.slice(0, WORLD_BOOK_VECTOR_MAX_MATCHED_ENTRIES)) {
        if (remainingChars < 600) break;
        const content = String(match.row?.vectorContextContent || '').trim();
        if (!content) continue;
        const clipped = content.slice(0, remainingChars);
        matched.push({ ...match.row, vectorContextContent: clipped });
        remainingChars -= clipped.length;
      }
      matchedConstant = matched.filter((wb) => wb.constant);
      matchedVariable = matched.filter((wb) => !wb.constant);
    } else {
      matchedVariable = variable.filter((wb) => keywordIds.has(String(wb.id)));
    }
  }

  return { constant: matchedConstant, variable: matchedVariable, allItems: items, allRows: all };
}

function worldBookEntryPath(wb, allRows = []) {
  const rows = Array.isArray(allRows) ? allRows : [];
  const byId = new Map(rows.map((row) => [String(row?.id || ''), row]));
  const book = wb?.bookId ? byId.get(String(wb.bookId)) : null;
  const group = wb?.groupId ? byId.get(String(wb.groupId)) : null;
  const category = WORLD_BOOK_CATEGORIES[wb?.category]?.label || String(wb?.category || '').trim();
  const segments = [
    book?.name || book?.title,
    group?.name || group?.title || category,
    wb?.name || wb?.title,
  ].map((item) => String(item || '').trim()).filter(Boolean);
  return [...new Set(segments)].join(' / ') || '未命名条目';
}

function formatWorldBookEntryBody(wb, allRows = []) {
  const body = String(wb?.vectorContextContent || wb?.content || '').trim();
  if (!body) return '';
  const prefix = WORLD_BOOK_PRIORITY_PREFIX[wb.priority] || '';
  const entryType = wb?.system === 'miniwiki' ? '小知识条目' : '世界书条目';
  const priority = wb?.priority === 'core'
    ? '｜核心'
    : (wb?.priority === 'hint' ? '｜参考' : '');
  return `【${entryType}｜${worldBookEntryPath(wb, allRows)}${priority}】\n${prefix}${body}`;
}

export function buildWorldBookRecallTail(entries = [], allRows = [], options = {}) {
  const limit = Math.max(1, Math.min(12, Number(options.limit) || 8));
  const rows = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const ranked = rows
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const rank = (entry) => {
        if (entry?.priority === 'core') return 0;
        if (entry?.matchedByRecall === true) return 1;
        if (entry?.priority === 'hint') return 3;
        return 2;
      };
      return rank(left.entry) - rank(right.entry) || left.index - right.index;
    });
  const uniquePaths = ranked.reduce((set, { entry }) => {
    const path = worldBookEntryPath(entry, allRows);
    if (path) set.add(path);
    return set;
  }, new Set());
  const anchors = [];
  const seen = new Set();
  for (const { entry } of ranked) {
    const path = worldBookEntryPath(entry, allRows);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    anchors.push(`${path}${entry?.priority === 'core' ? '（核心）' : ''}`);
    if (anchors.length >= limit) break;
  }
  if (!anchors.length) return '';
  const omitted = Math.max(0, uniquePaths.size - anchors.length);
  return [
    '【本轮世界书回看】',
    `生成前再核对已注入条目：${anchors.join('；')}${omitted ? `；另有 ${omitted} 条` : ''}。`,
    '核心条目必须落实；不要复述或解释世界书，只在本轮自然遵守。',
  ].join('\n');
}

export async function buildWorldBookContextBundle(user = null, textForSelective = '', options = {}) {
  const { constant, variable, allRows = [] } = await getActiveWorldBookItems(user, textForSelective, options);
  const entries = [
    ...constant.map((entry) => ({ ...entry, matchedByRecall: false })),
    ...variable.map((entry) => ({ ...entry, matchedByRecall: true })),
  ];
  const parts = entries.map((entry) => formatWorldBookEntryBody(entry, allRows)).filter(Boolean);
  if (!parts.length) return { block: '', recallTail: '', entries: [] };
  if (options.system === 'miniwiki') {
    return {
      block: `【小知识 / 梗】\n${parts.join('\n\n')}`,
      recallTail: '',
      entries,
    };
  }
  // 世界观锚点：明确「优先于通用常识/模型自身惯性发挥」，核心条目冲突时以此为准，
  // 参考条目只在贴合场景时自然带出——不然长 system 里这段很容易被当成可有可无的背景资料。
  const block = [
    '【设定库 / 世界书 · 优先级高于通用常识】',
    '以下是本次对话世界的既定设定；标「核心设定」的条目必须遵守，与通用常识、模型自身习惯发挥冲突时以这些条目为准，不要另起一套体系；未标注的按默认权重参考；标「参考」的条目是氛围/补充类内容，只在贴合场景时自然带出，不必逐句复述或每轮强调。',
    parts.join('\n\n'),
  ].join('\n');
  return {
    block,
    recallTail: buildWorldBookRecallTail(entries, allRows, options),
    entries,
  };
}

export async function buildWorldBookContextBlock(user = null, textForSelective = '', options = {}) {
  const result = await buildWorldBookContextBundle(user, textForSelective, options);
  return result.block;
}

/**
 * 小知识库/梗百科注入块：只出 system='miniwiki' 的条目，按关键词 selective 命中，
 * 单独一个 header，与常规世界书分开，角色把它当作「自己知道的梗/常识」而非世界观设定。
 */
export async function buildMiniWikiContextBlock(user = null, textForSelective = '', options = {}) {
  const block = await buildWorldBookContextBlock(user, textForSelective, {
    ...options,
    system: 'miniwiki',
    worldBookMode: options.worldBookMode === 'full' ? 'full' : 'selective',
  });
  if (!block) return '';
  return `${block}\n（以上是角色自己知道的梗、热词、小知识背景，可自然融进对话；不要照本宣科复述。）`;
}

export async function saveWorldBookEntry(entry) {
  const existing = entry?.id ? await db.getRecord('worldBooks', entry.id).catch(() => null) : null;
  const now = Date.now();
  const row = createWorldBookEntry({
    ...entry,
    createdAt: existing?.createdAt || entry?.createdAt || now,
  });
  row.updatedAt = now;
  await db.putRecord('worldBooks', row);
  queueWorldBookVectorEntry(row).catch(() => {});
  return row;
}

function requireWorldBookMoveTarget(entries = [], bookId = '', groupId = '') {
  const list = Array.isArray(entries) ? entries : [];
  const targetBookId = String(bookId || '').trim();
  const targetGroupId = String(groupId || '').trim();
  const book = list.find((entry) => (
    entry?.id === targetBookId
    && entry.isBookRoot
    && !entry.isCollection
    && entry.system !== 'miniwiki'
  ));
  if (!book) throw new Error('目标世界书不存在');

  let group = null;
  if (targetGroupId) {
    group = list.find((entry) => (
      entry?.id === targetGroupId
      && entry.kind === 'group'
      && !entry.isBookRoot
      && !entry.isCollection
      && entry.system !== 'miniwiki'
    ));
    const groupBookId = String(group?.bookId || group?.parentGroupId || '').trim();
    if (!group || groupBookId !== targetBookId) {
      throw new Error('目标条目分组不属于所选世界书');
    }
  }
  return { book, group, bookId: targetBookId, groupId: targetGroupId };
}

function nextWorldBookPosition(entries = [], predicate = () => false) {
  const positions = entries
    .filter(predicate)
    .map((entry) => Number(entry?.position))
    .filter(Number.isFinite);
  return (positions.length ? Math.max(...positions) : 0) + 10;
}

/** 生成批量条目迁移结果；导出供 UI 与回归测试共用。 */
export function planWorldBookItemMove(entries = [], itemIds = [], target = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (!ids.length) throw new Error('请先选择条目');
  const destination = requireWorldBookMoveTarget(list, target.bookId, target.groupId);
  const movingSet = new Set(ids);
  const sourceById = new Map(list.map((entry) => [String(entry?.id || ''), entry]));
  const sources = ids.map((id) => {
    const entry = sourceById.get(id);
    if (!entry || !isItemEntry(entry) || entry.system === 'miniwiki') {
      throw new Error('选中的条目已不存在或不能迁移');
    }
    if (WORLD_BOOKS.some((seed) => seed.id === entry.id)) {
      throw new Error('内置条目不能迁移');
    }
    return entry;
  });
  let position = nextWorldBookPosition(list, (entry) => (
    isItemEntry(entry)
    && !movingSet.has(String(entry.id || ''))
    && String(entry.bookId || '') === destination.bookId
    && String(entry.groupId || '') === destination.groupId
  ));
  const now = Date.now();
  return sources.map((entry) => {
    const row = createWorldBookEntry({
      ...entry,
      bookId: destination.bookId,
      groupId: destination.groupId,
      parentGroupId: destination.groupId,
      position,
    });
    row.updatedAt = now;
    position += 10;
    return row;
  });
}

/** 批量迁移条目到指定世界书或其内部条目分组。 */
export async function moveWorldBookItems(itemIds = [], target = {}) {
  const entries = await listAllWorldBookRows();
  const rows = planWorldBookItemMove(entries, itemIds, target);
  await db.putMany('worldBooks', rows);
  for (const row of rows) queueWorldBookVectorEntry(row).catch(() => {});
  return rows;
}

/** 生成条目分组迁移结果；分组与组内条目始终一起更新。 */
export function planWorldBookGroupMove(entries = [], groupId = '', targetBookId = '', patch = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const key = String(groupId || '').trim();
  const destination = requireWorldBookMoveTarget(list, targetBookId, '');
  const group = list.find((entry) => (
    entry?.id === key
    && entry.kind === 'group'
    && !entry.isBookRoot
    && !entry.isCollection
    && entry.system !== 'miniwiki'
  ));
  if (!group) throw new Error('要迁移的条目分组不存在');
  if (WORLD_BOOKS.some((seed) => seed.id === group.id)) {
    throw new Error('内置分组不能迁移');
  }

  const now = Date.now();
  const currentBookId = String(group.bookId || group.parentGroupId || '').trim();
  const position = currentBookId === destination.bookId
    ? Number(group.position) || 100
    : nextWorldBookPosition(list, (entry) => (
      entry?.kind === 'group'
      && !entry.isBookRoot
      && !entry.isCollection
      && entry.id !== group.id
      && String(entry.bookId || entry.parentGroupId || '') === destination.bookId
    ));
  const movedGroup = createWorldBookEntry({
    ...group,
    ...(patch && typeof patch === 'object' ? patch : {}),
    bookId: destination.bookId,
    groupId: destination.bookId,
    parentGroupId: destination.bookId,
    position,
  });
  movedGroup.updatedAt = now;

  const childRows = currentBookId === destination.bookId
    ? []
    : list
      .filter((entry) => isItemEntry(entry) && String(entry.groupId || '') === group.id)
      .map((entry) => {
        const row = createWorldBookEntry({
          ...entry,
          bookId: destination.bookId,
          groupId: group.id,
          parentGroupId: group.id,
        });
        row.updatedAt = now;
        return row;
      });
  return [movedGroup, ...childRows];
}

/** 把条目分组及组内全部条目迁移到另一世界书。 */
export async function moveWorldBookGroup(groupId = '', targetBookId = '', patch = {}) {
  const entries = await listAllWorldBookRows();
  const rows = planWorldBookGroupMove(entries, groupId, targetBookId, patch);
  await db.putMany('worldBooks', rows);
  for (const row of rows) queueWorldBookVectorEntry(row).catch(() => {});
  return rows;
}

async function removeWorldBookRow(id) {
  const key = String(id || '').trim();
  if (!key) return;
  if (WORLD_BOOKS.some((e) => e.id === key)) {
    await hideWorldBookId(key);
    await deleteVectorSourcesByPrefix('worldbook', `${key}:chunk:`).catch(() => {});
    await db.deleteRecord('memoryVectors', `worldbook:${key}`).catch(() => {});
    return;
  }
  await db.deleteRecord('worldBooks', key);
  await deleteVectorSourcesByPrefix('worldbook', `${key}:chunk:`).catch(() => {});
  await db.deleteRecord('memoryVectors', `worldbook:${key}`).catch(() => {});
}

export async function deleteWorldBookEntry(id) {
  await removeWorldBookRow(id);
}

/** 删除世界书 / 分组 / 条目；整本与分组会级联删除子项 */
export async function deleteWorldBookEntryCascade(id, allEntries = null) {
  const key = String(id || '').trim();
  if (!key) return 0;
  const all = Array.isArray(allEntries) ? allEntries : await listAllWorldBookRows();
  const target = all.find((e) => e.id === key);
  if (!target) return 0;

  let ids = [key];
  if (target.isCollection) {
    ids = [key];
  } else if (target.isBookRoot) {
    ids = all.filter((e) => e.id === key || e.bookId === key).map((e) => e.id);
  } else if (target.kind === 'group') {
    ids = all.filter((e) => e.id === key || e.groupId === key).map((e) => e.id);
  }

  const unique = [...new Set(ids.filter(Boolean))];
  for (const rowId of unique) {
    await removeWorldBookRow(rowId);
  }
  return unique.length;
}

export async function importWorldBookEntries(entries = []) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return 0;
  await db.putMany('worldBooks', list);
  for (const row of list) queueWorldBookVectorEntry(row).catch(() => {});
  return list.length;
}

/** 构建页面用的树：book → groups → items（小知识库条目有自己的页面，不进世界书树） */
export function buildWorldBookTree(entries = []) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e?.system !== 'miniwiki');
  const books = list
    .filter((e) => e.isBookRoot && !e.isCollection)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const groups = list.filter((e) => e.kind === 'group' && !e.isBookRoot && !e.isCollection);
  const items = list.filter((e) => isItemEntry(e));

  const orphanItems = items.filter((e) => !e.bookId && !e.groupId);
  const orphanGroups = groups.filter((g) => !g.bookId && !g.parentGroupId);

  const tree = books.map((book) => {
    const bookGroups = groups
      .filter((g) => g.bookId === book.id || g.parentGroupId === book.id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const directItems = items
      .filter((it) => it.bookId === book.id && !it.groupId)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const groupNodes = bookGroups.map((group) => ({
      group,
      items: items
        .filter((it) => it.groupId === group.id)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    }));
    return { book, directItems, groups: groupNodes };
  });

  if (orphanGroups.length || orphanItems.length) {
    tree.push({
      book: {
        id: '_orphan',
        name: '未归类',
        isBookRoot: true,
        kind: 'group',
        enabled: true,
      },
      directItems: orphanItems.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
      groups: orphanGroups.map((group) => ({
        group,
        items: items.filter((it) => it.groupId === group.id),
      })),
    });
  }

  return tree;
}

export function listWorldBookCollections(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.isCollection && entry?.system !== 'miniwiki')
    .sort((a, b) => (
      (a.position ?? 0) - (b.position ?? 0)
      || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
    ));
}

export function truncateWorldBookPreview(text = '', max = 64) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
