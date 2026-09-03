import * as db from '../db.js';
import {
  contentHash,
  cosineSimilarity,
  isEmbeddingEnabled,
  loadEmbeddingConfig,
  requestEmbedding,
} from '../embedding-tools.js';
import { lexicalTimelineSimilarity } from './unified-event-timeline.js';
import { effectiveEventTemporalState } from '../../models/event-memory.js';
import {
  buildChatMessagePassageSources,
  buildOfflineArchivePassageSources,
  buildRadioEpisodePassageSources,
  CHAT_ORIGINAL_RECENT_WINDOW,
} from './vector-passages.js';

const STORE = 'memoryVectors';
const MANAGED_SOURCE_STORES = Object.freeze({
  memory: 'memories',
  fact: 'memoryFacts',
  event: 'eventMemories',
});
export const MEMORY_VECTOR_BACKLOG_EVENT = 'marshmallow-memory-vector-backlog-changed';

let memoryVectorRuntimeState = {
  phase: 'idle',
  reason: '',
  processed: 0,
  updatedAt: 0,
};

export function getMemoryVectorBacklogRuntimeState() {
  return { ...memoryVectorRuntimeState };
}

export function publishMemoryVectorBacklogState(detail = {}) {
  const source = detail && typeof detail === 'object' ? detail : {};
  const wake = source.wake === true;
  memoryVectorRuntimeState = {
    ...memoryVectorRuntimeState,
    phase: String(source.phase || memoryVectorRuntimeState.phase || 'idle'),
    reason: String(source.reason || ''),
    processed: Math.max(0, Number(source.processed || 0)),
    error: String(source.error || '').slice(0, 300),
    updatedAt: Date.now(),
  };
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(MEMORY_VECTOR_BACKLOG_EVENT, {
      detail: { ...memoryVectorRuntimeState, wake },
    }));
  }
  return getMemoryVectorBacklogRuntimeState();
}

export function requestMemoryVectorBacklog(reason = 'queue-changed') {
  return publishMemoryVectorBacklogState({
    phase: 'queued',
    reason,
    wake: true,
  });
}

/**
 * 相似度阈值统一入口（余弦相似度 0~1）。
 * 当前为保守暂定值，接入真实 embedding 模型后按实测分布校准，只改这里。
 */
export const VECTOR_THRESHOLDS = Object.freeze({
  /** 世界书 selective 语义命中门槛（无关键词命中时的兜底通道） */
  worldbook: 0.42,
  /** 记忆馆手动语义搜索的展示门槛 */
  memorySearch: 0.3,
  /** 统一时间轴候选的语义过滤门槛（低于此值直接不进打分） */
  timelineGate: 0.24,
  /** 省 Token 模式下，旧普通记忆进入上下文的最低相关度 */
  memoryInject: 0.34,
  /** 省 Token 模式下，结构化事实进入上下文的最低相关度 */
  factInject: 0.3,
  /** 线下情景碎片注入聊天上下文的门槛（要求强相关，宁缺勿滥） */
  archiveInject: 0.5,
  /** 当前聊天最近上下文之外的原文选段门槛 */
  messagePassageInject: 0.48,
  /** 同作用域同类型新记录达到此值时，标记为近重复 */
  dedupe: 0.98,
  /** 与最近 AI 输出高度重合 → 强压分，防复读 */
  noveltyHardRepeat: 0.88,
  /** 与最近 AI 输出较相似 → 轻度压分 */
  noveltySoftRepeat: 0.76,
});

const DEFAULT_BATCH_SIZE = 16;
const RETRY_BASE_MS = 5 * 60 * 1000;
const QUERY_CACHE_LIMIT = 24;
const OPTIONAL_QUERY_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const queryCache = new Map();
const optionalQueryRetryAfter = new Map();

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function knownByList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((id) => id.trim()).filter(Boolean))];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .filter(([, level]) => level === true || !['', 'none', 'false'].includes(String(level || '').toLowerCase()))
    .map(([id]) => String(id).trim())
    .filter(Boolean);
}

export function vectorContentForSource(namespace, source = {}) {
  if (namespace === 'fact') {
    return cleanText([source.content, source.evidence, ...(source.tags || [])].filter(Boolean).join(' '));
  }
  if (namespace === 'event') return cleanText(source.summary || source.content);
  if (namespace === 'worldbook') return cleanText([source.name || source.title, source.content].filter(Boolean).join('\n'));
  if (namespace === 'archive') {
    return cleanText([source.title, source.summary, source.content, source.text].filter(Boolean).join('\n'));
  }
  return cleanText(source.content || source.summary || source.text);
}

export function vectorMetadataForSource(namespace, source = {}) {
  const involvedChats = Array.isArray(source.involvedChats) ? source.involvedChats.filter(Boolean) : [];
  const characterId = String(source.characterId || source.subjectId || source.awareCharacterId || '').trim();
  const metadata = {
    namespace,
    sourceId: String(source.id || '').trim(),
    userId: String(source.userId || '').trim(),
    scopeId: String(source.chatId || source.sourceChatId || involvedChats[0] || source.bookId || '').trim(),
    characterId,
    witnesses: knownByList(source.knownBy || source.witnesses || source.knownByActorIds),
    sourceType: String(
      source.type
      || source.factType
      || source.category
      || (namespace === 'event' ? source.visibility : ''),
    ).trim(),
    subjectId: String(source.subjectId || '').trim(),
    subjectName: String(source.subjectName || '').trim(),
    objectId: String(source.objectId || '').trim(),
    objectName: String(source.objectName || '').trim(),
    temporalState: namespace === 'event'
      ? effectiveEventTemporalState(source)
      : String(source.temporalState || '').trim(),
    sourceTimestamp: Number(source.timestamp || source.updatedAt || source.createdAt || 0) || 0,
  };
  if (namespace === 'worldbook') {
    metadata.parentSourceId = String(source.parentSourceId || source.worldBookEntryId || source.id || '').trim();
    metadata.bookId = String(source.bookId || '').trim();
    metadata.chunkIndex = Math.max(0, Math.floor(Number(source.chunkIndex) || 0));
    metadata.chunkCount = Math.max(1, Math.floor(Number(source.chunkCount) || 1));
  }
  if (namespace === 'message_passage' || ['offline_original', 'radio_original'].includes(String(source.type || ''))) {
    metadata.excerpt = String(source.excerpt || source.content || '').trim().slice(0, 12000);
    metadata.messageIds = Array.isArray(source.messageIds)
      ? source.messageIds.map(String).filter(Boolean).slice(0, 20)
      : [];
    metadata.fromTimestamp = Number(source.fromTimestamp || 0) || 0;
    metadata.toTimestamp = Number(source.toTimestamp || 0) || 0;
  }
  return metadata;
}

export function buildPendingVectorRecord(namespace, source = {}, existing = null, options = {}) {
  const meta = vectorMetadataForSource(namespace, source);
  const content = cleanText(options.content || vectorContentForSource(namespace, source));
  if (!meta.sourceId || !content) return null;
  return {
    ...(existing || {}),
    ...meta,
    id: `${namespace}:${meta.sourceId}`,
    content,
    contentHash: contentHash(content),
    vector: [],
    model: '',
    dims: 0,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    error: '',
    updatedAt: Number(options.updatedAt || Date.now()),
  };
}

export async function enqueueVectorSource(namespace, source = {}, options = {}) {
  const meta = vectorMetadataForSource(namespace, source);
  const content = cleanText(options.content || vectorContentForSource(namespace, source));
  if (!meta.sourceId || !content) return null;
  const id = `${namespace}:${meta.sourceId}`;
  const hash = contentHash(content);
  const existing = await db.getRecord(STORE, id).catch(() => null);
  if (!options.force && existing?.contentHash === hash && ['ready', 'pending'].includes(existing.status)) return existing;
  const row = buildPendingVectorRecord(namespace, source, existing, { ...options, content });
  await db.putRecord(STORE, row);
  if (options.notify !== false) requestMemoryVectorBacklog(`queued:${namespace}`);
  return row;
}

export async function enqueueVectorSources(namespace, sources = []) {
  let queued = 0;
  for (const source of (Array.isArray(sources) ? sources : [])) {
    if (await enqueueVectorSource(namespace, source, { notify: false }).catch(() => null)) queued += 1;
  }
  if (queued) requestMemoryVectorBacklog(`queued:${namespace}`);
  return queued;
}

export async function deleteVectorSources(namespace, sourceIds = []) {
  const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : [sourceIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean))]
    .map((id) => `${namespace}:${id}`);
  const removed = ids.length ? await db.deleteMany(STORE, ids) : 0;
  if (removed) publishMemoryVectorBacklogState({ reason: `deleted:${namespace}`, wake: false });
  return removed;
}

export async function deleteVectorSourcesByPrefix(namespace, sourceIdPrefix = '') {
  const prefix = String(sourceIdPrefix || '').trim();
  if (!namespace || !prefix) return 0;
  const rows = await db.getAllRecords(STORE).catch(() => []);
  const ids = rows
    .filter((row) => row?.namespace === namespace && String(row.sourceId || '').startsWith(prefix))
    .map((row) => row.id)
    .filter(Boolean);
  const removed = ids.length ? await db.deleteMany(STORE, ids) : 0;
  if (removed) publishMemoryVectorBacklogState({ reason: `deleted:${namespace}`, wake: false });
  return removed;
}

/**
 * 向量是可由源记忆重建的派生数据。旧版级联删除漏清理时，只删确认已经
 * 找不到源记录的回忆 / 事实 / 事件向量，不根据文本模糊判断。
 */
export async function pruneOrphanedMemoryVectors({
  userId = '',
  namespaces = Object.keys(MANAGED_SOURCE_STORES),
} = {}) {
  const allowed = [...new Set((Array.isArray(namespaces) ? namespaces : [namespaces])
    .map((value) => String(value || '').trim())
    .filter((value) => MANAGED_SOURCE_STORES[value]))];
  if (!allowed.length) return 0;
  const rows = await listVectorRowsForUser(userId, { namespaces: allowed }).catch(() => []);
  const orphanVectorIds = [];
  for (const namespace of allowed) {
    const grouped = rows.filter((row) => (
      row?.namespace === namespace && String(row?.sourceId || '').trim()
    ));
    if (!grouped.length) continue;
    let sources;
    try {
      sources = await db.getMany(
        MANAGED_SOURCE_STORES[namespace],
        grouped.map((row) => String(row.sourceId).trim()),
      );
    } catch {
      // 读取失败不等于源记录不存在，本轮不做任何删除。
      continue;
    }
    grouped.forEach((row, index) => {
      if (!sources[index] && row?.id) orphanVectorIds.push(row.id);
    });
  }
  if (!orphanVectorIds.length) return 0;
  const removed = await db.deleteMany(STORE, orphanVectorIds);
  publishMemoryVectorBacklogState({ reason: 'deleted:orphaned-sources', wake: false });
  return removed;
}

export async function reconcileMemoryVectorsForScope(scopeId = '') {
  const id = String(scopeId || '').trim();
  if (!id) return 0;
  const rows = (await db.getAllRecords(STORE).catch(() => []))
    .filter((row) => String(row?.scopeId || '') === id);
  const storeByNamespace = {
    memory: 'memories',
    fact: 'memoryFacts',
    event: 'eventMemories',
    worldbook: 'worldBooks',
  };
  let removed = 0;
  for (const row of rows) {
    const sourceStore = storeByNamespace[row?.namespace];
    // 线下档案保存在 settings 聚合记录里，聊天删除不代表档案也删除。
    if (!sourceStore || !row?.sourceId) continue;
    const source = await db.getRecord(sourceStore, row.sourceId).catch(() => null);
    if (!source) {
      await db.deleteRecord(STORE, row.id);
      removed += 1;
      continue;
    }
    const expected = vectorMetadataForSource(row.namespace, source);
    if (String(expected.scopeId || '') !== String(row.scopeId || '')) {
      await enqueueVectorSource(row.namespace, source, { force: true });
    }
  }
  return removed;
}

async function listRunnableRows(limit) {
  const now = Date.now();
  const [pending, failed] = await Promise.all([
    db.getAllByIndex(STORE, 'status', 'pending').catch(() => []),
    db.getAllByIndex(STORE, 'status', 'failed').catch(() => []),
  ]);
  return [...pending, ...failed]
    .filter((row) => !row.nextAttemptAt || Number(row.nextAttemptAt) <= now)
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
    .slice(0, limit);
}

function sameWitnesses(left = [], right = []) {
  const a = [...new Set((left || []).map(String).filter(Boolean))].sort();
  const b = [...new Set((right || []).map(String).filter(Boolean))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canMergeVectorRows(left = {}, right = {}) {
  if (!['memory', 'fact', 'event'].includes(String(left.namespace || ''))) return false;
  if (left.namespace !== right.namespace || left.sourceId === right.sourceId) return false;
  if (String(left.userId || '') !== String(right.userId || '')) return false;
  if (String(left.scopeId || '') !== String(right.scopeId || '')) return false;
  if (String(left.characterId || '') !== String(right.characterId || '')) return false;
  if (String(left.sourceType || '') !== String(right.sourceType || '')) return false;
  if (!sameWitnesses(left.witnesses, right.witnesses)) return false;
  if (left.namespace === 'memory') {
    if (lexicalTimelineSimilarity(left.content, right.content) < 0.4) return false;
    const leftTs = Number(left.sourceTimestamp || 0);
    const rightTs = Number(right.sourceTimestamp || 0);
    if (leftTs && rightTs && Math.abs(leftTs - rightTs) > 7 * 24 * 60 * 60 * 1000) return false;
  }
  if (left.namespace === 'fact') {
    if (String(left.subjectId || '') !== String(right.subjectId || '')) return false;
    if (String(left.objectId || '') !== String(right.objectId || '')) return false;
    if (String(left.temporalState || '') !== String(right.temporalState || '')) return false;
    // 事实里的「喜欢」→「不喜欢」在向量空间可能仍非常接近。事实只合并
    // 几乎相同的文本，状态变化继续交给 memory-facts 的结构化 upsert。
    const a = cleanText(left.content).replace(/[，。！？、；：,.!?;:\s]/g, '');
    const b = cleanText(right.content).replace(/[，。！？、；：,.!?;:\s]/g, '');
    if (a !== b && !((a.includes(b) || b.includes(a))
      && Math.min(a.length, b.length) / Math.max(1, Math.max(a.length, b.length)) >= 0.9)) return false;
  }
  if (left.namespace === 'event') {
    if (String(left.temporalState || '') !== String(right.temporalState || '')) return false;
    if (lexicalTimelineSimilarity(left.content, right.content) < 0.66) return false;
    const leftTs = Number(left.sourceTimestamp || 0);
    const rightTs = Number(right.sourceTimestamp || 0);
    if (leftTs && rightTs && Math.abs(leftTs - rightTs) > 14 * 24 * 60 * 60 * 1000) return false;
  }
  const type = String(left.sourceType || '').toLowerCase();
  return !['summary', 'guidance'].includes(type) && !type.includes('manual');
}

async function markSourceSuperseded(row, duplicateOf, vectorState = null) {
  const store = row.namespace === 'memory'
    ? 'memories'
    : (row.namespace === 'fact' ? 'memoryFacts' : (row.namespace === 'event' ? 'eventMemories' : ''));
  if (!store || !row.sourceId) return;
  const source = await db.getRecord(store, row.sourceId).catch(() => null);
  if (!source) return;
  await db.putRecord(store, {
    ...source,
    vectorSupersededBy: String(duplicateOf || ''),
    vectorSupersededAt: duplicateOf ? Date.now() : 0,
  });
  if (duplicateOf) {
    const canonical = await db.getRecord(store, duplicateOf).catch(() => null);
    if (canonical) {
      const sourceIsNewer = Number(source.timestamp || source.updatedAt || 0)
        >= Number(canonical.timestamp || canonical.updatedAt || 0);
      const merged = row.namespace === 'event'
        ? {
          ...canonical,
          ...(sourceIsNewer ? {
            summary: source.summary || canonical.summary,
            timestamp: Math.max(Number(source.timestamp || 0), Number(canonical.timestamp || 0)),
            temporalState: source.temporalState || canonical.temporalState,
            visibility: source.visibility || canonical.visibility,
          } : {}),
          knownBy: { ...(canonical.knownBy || {}), ...(source.knownBy || {}) },
          involvedChats: [...new Set([
            ...(canonical.involvedChats || []),
            ...(source.involvedChats || []),
          ])].slice(0, 20),
          relationChanges: [...(canonical.relationChanges || []), ...(source.relationChanges || [])].slice(-20),
          pendingThreads: [...new Set([
            ...(canonical.pendingThreads || []),
            ...(source.pendingThreads || []),
          ])].slice(0, 12),
          highlight: sourceIsNewer
            ? (source.highlight || canonical.highlight)
            : (canonical.highlight || source.highlight),
          tags: [...new Set([...(canonical.tags || []), ...(source.tags || [])])].slice(0, 16),
          embarrassmentLevel: Math.max(
            Number(canonical.embarrassmentLevel || 0),
            Number(source.embarrassmentLevel || 0),
          ),
          vectorMergedCount: Math.max(1, Number(canonical.vectorMergedCount || 1)) + 1,
          vectorMergedLatestAt: Math.max(
            Number(canonical.vectorMergedLatestAt || canonical.timestamp || 0),
            Number(source.timestamp || Date.now()),
          ),
          vectorMergedSourceIds: [...new Set([
            ...(Array.isArray(canonical.vectorMergedSourceIds) ? canonical.vectorMergedSourceIds : []),
            String(row.sourceId),
          ])].slice(-20),
        }
        : {
          ...canonical,
          ...(sourceIsNewer ? {
            content: source.content || canonical.content,
            evidence: source.evidence || canonical.evidence,
            timestamp: Math.max(Number(source.timestamp || 0), Number(canonical.timestamp || 0)),
            updatedAt: Math.max(Number(source.updatedAt || 0), Number(canonical.updatedAt || 0)),
            temporalState: source.temporalState || canonical.temporalState,
          } : {}),
          knownBy: { ...(canonical.knownBy || {}), ...(source.knownBy || {}) },
          tags: [...new Set([...(canonical.tags || []), ...(source.tags || [])])].slice(0, 12),
          sourceMessageIds: [...new Set([
            ...(canonical.sourceMessageIds || []),
            ...(source.sourceMessageIds || []),
          ])].slice(-20),
          vectorMergedCount: Math.max(1, Number(canonical.vectorMergedCount || 1)) + 1,
          vectorMergedLatestAt: Math.max(
            Number(canonical.vectorMergedLatestAt || canonical.timestamp || canonical.updatedAt || 0),
            Number(source.timestamp || source.updatedAt || Date.now()),
          ),
          vectorMergedSourceIds: [...new Set([
            ...(Array.isArray(canonical.vectorMergedSourceIds) ? canonical.vectorMergedSourceIds : []),
            String(row.sourceId),
          ])].slice(-20),
        };
      await db.putRecord(store, merged);
      if (sourceIsNewer && vectorState?.vector?.length) {
        const canonicalVector = await db.getRecord(STORE, `${row.namespace}:${duplicateOf}`).catch(() => null);
        if (canonicalVector) {
          const content = vectorContentForSource(row.namespace, merged);
          const vectorStillMatches = contentHash(content) === contentHash(row.content);
          await db.putRecord(STORE, {
            ...canonicalVector,
            ...vectorMetadataForSource(row.namespace, merged),
            content,
            contentHash: contentHash(content),
            vector: vectorStillMatches ? vectorState.vector : [],
            dims: vectorStillMatches ? vectorState.vector.length : 0,
            model: vectorStillMatches ? (vectorState.model || canonicalVector.model) : '',
            status: vectorStillMatches ? 'ready' : 'pending',
            updatedAt: Date.now(),
          });
        }
      }
    }
  }
}

export async function drainVectorBacklog({ batchSize = DEFAULT_BATCH_SIZE, config = null } = {}) {
  const effectiveConfig = config || await loadEmbeddingConfig();
  if (!isEmbeddingEnabled(effectiveConfig)) return { ok: false, skipped: true, reason: 'disabled', processed: 0 };
  const cap = Math.max(1, Math.min(64, Math.floor(Number(batchSize) || DEFAULT_BATCH_SIZE)));
  const rows = await listRunnableRows(cap);
  if (!rows.length) return { ok: true, processed: 0 };
  try {
    const vectors = await requestEmbedding(rows.map((row) => row.content), { config: effectiveConfig });
    const now = Date.now();
    const existingReady = (await db.getAllByIndex(STORE, 'status', 'ready').catch(() => []))
      .filter((row) => row?.model === effectiveConfig.model && Array.isArray(row.vector));
    const accepted = [...existingReady];
    const completed = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const vector = vectors[index];
      const duplicate = accepted.find((candidate) => (
        candidate.vector.length === vector.length
        && canMergeVectorRows(row, candidate)
        && cosineSimilarity(vector, candidate.vector) >= VECTOR_THRESHOLDS.dedupe
      ));
      const next = {
        ...row,
        vector,
        model: effectiveConfig.model,
        dims: vector.length,
        status: duplicate ? 'superseded' : 'ready',
        duplicateOf: duplicate?.sourceId || '',
        attempts: 0,
        nextAttemptAt: 0,
        error: '',
        updatedAt: now,
      };
      completed.push(next);
      if (duplicate) {
        await markSourceSuperseded(row, duplicate.sourceId, {
          vector,
          model: effectiveConfig.model,
        }).catch(() => {});
      }
      else {
        accepted.push(next);
        await markSourceSuperseded(row, '').catch(() => {});
      }
    }
    await db.putMany(STORE, completed);
    publishMemoryVectorBacklogState({
      phase: 'working',
      reason: 'batch-complete',
      processed: rows.length,
      wake: false,
    });
    return { ok: true, processed: rows.length };
  } catch (error) {
    const now = Date.now();
    await db.putMany(STORE, rows.map((row) => {
      const attempts = Number(row.attempts || 0) + 1;
      return {
        ...row,
        vector: [],
        status: 'failed',
        attempts,
        nextAttemptAt: now + Math.min(24 * 60 * 60 * 1000, RETRY_BASE_MS * (2 ** Math.min(8, attempts - 1))),
        error: String(error?.message || error).slice(0, 300),
        updatedAt: now,
      };
    }));
    publishMemoryVectorBacklogState({
      phase: 'waiting',
      reason: 'batch-failed',
      processed: 0,
      error: String(error?.message || error),
      wake: false,
    });
    return { ok: false, processed: 0, failed: rows.length, error };
  }
}

/**
 * 一个唤醒周期内连续处理短批次；批次之间让出事件循环，避免 PWA 冷启动时一次
 * 回填后固定留下 64 条，也避免单次长任务占住前台交互。
 */
export async function drainVectorBacklogBatches({
  batchSize = DEFAULT_BATCH_SIZE,
  maxBatches = 2,
  config = null,
} = {}) {
  const effectiveConfig = config || await loadEmbeddingConfig();
  const cap = Math.max(1, Math.min(8, Math.floor(Number(maxBatches) || 2)));
  let processed = 0;
  let batches = 0;
  let lastResult = null;

  for (let index = 0; index < cap; index += 1) {
    lastResult = await drainVectorBacklog({ batchSize, config: effectiveConfig });
    if (lastResult?.skipped || lastResult?.ok === false || !Number(lastResult?.processed || 0)) break;
    processed += Number(lastResult.processed || 0);
    batches += 1;
    await Promise.resolve();
  }

  const stats = await getMemoryVectorIndexStats().catch(() => ({
    total: 0, ready: 0, pending: 0, failed: 0, superseded: 0,
  }));
  const hasMore = Number(stats.pending || 0) > 0;
  const disabled = lastResult?.reason === 'disabled';
  publishMemoryVectorBacklogState({
    phase: disabled ? 'disabled' : (hasMore ? 'queued' : (stats.failed ? 'waiting' : 'idle')),
    reason: disabled ? 'disabled' : (hasMore ? 'batch-yield' : 'drain-complete'),
    processed,
    error: lastResult?.error?.message || lastResult?.error || '',
    wake: false,
  });
  return {
    ok: lastResult?.ok !== false,
    skipped: lastResult?.skipped === true,
    reason: String(lastResult?.reason || ''),
    processed,
    batches,
    hasMore,
    stats,
  };
}

const BACKFILL_SOURCES = [
  ['memories', 'memory'],
  ['memoryFacts', 'fact'],
  ['eventMemories', 'event'],
];

function sameMessageIds(left = [], right = []) {
  const a = (Array.isArray(left) ? left : []).map(String).filter(Boolean);
  const b = (Array.isArray(right) ? right : []).map(String).filter(Boolean);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function vectorRowMatchesSource(existing, namespace, source, config = null) {
  if (!existing) return false;
  const text = vectorContentForSource(namespace, source);
  const expectedMeta = vectorMetadataForSource(namespace, source);
  const metadataMatches = [
    'namespace', 'sourceId', 'userId', 'scopeId', 'characterId', 'sourceType',
    'subjectId', 'subjectName', 'objectId', 'objectName', 'temporalState', 'sourceTimestamp',
    'fromTimestamp', 'toTimestamp', 'excerpt',
    'parentSourceId', 'bookId', 'chunkIndex', 'chunkCount',
  ].every((key) => String(existing?.[key] || '') === String(expectedMeta[key] || ''))
    && sameWitnesses(existing.witnesses, expectedMeta.witnesses)
    && sameMessageIds(existing.messageIds, expectedMeta.messageIds);
  if (!text || existing.contentHash !== contentHash(text) || !metadataMatches) return false;
  if (['pending', 'failed'].includes(existing.status)) return true;
  const modelMatches = existing.model === config?.model
    && (!Number(config?.dimensions) || Number(existing.dims) === Number(config.dimensions));
  return existing.status === 'ready' && modelMatches;
}

export async function enqueueChatMessagePassages({
  chat = null,
  messages = [],
  recentWindow = CHAT_ORIGINAL_RECENT_WINDOW,
  limit = 80,
  config = null,
  notify = true,
} = {}) {
  if (!chat?.id || !chat?.userId) return { queued: 0, sources: 0, skipped: true };
  const effectiveConfig = config || await loadEmbeddingConfig().catch(() => null);
  if (!isEmbeddingEnabled(effectiveConfig)) return { queued: 0, sources: 0, skipped: true };
  const sources = buildChatMessagePassageSources({ chat, messages, recentWindow });
  const validIds = new Set(sources.map((source) => source.id));
  const staleRows = (await db.getAllByIndex(STORE, 'namespace', 'message_passage').catch(() => []))
    .filter((row) => String(row?.scopeId || '') === String(chat.id)
      && !validIds.has(String(row.sourceId || '')));
  if (staleRows.length) await db.deleteMany(STORE, staleRows.map((row) => row.id));

  const cap = Math.max(1, Math.min(500, Number(limit) || 80));
  let queued = 0;
  for (const source of [...sources].reverse()) {
    const existing = await db.getRecord(STORE, `message_passage:${source.id}`).catch(() => null);
    if (vectorRowMatchesSource(existing, 'message_passage', source, effectiveConfig)) continue;
    await enqueueVectorSource('message_passage', source, { force: true, notify: false });
    queued += 1;
    if (queued >= cap) break;
  }
  if (queued && notify) requestMemoryVectorBacklog('queued:message_passage');
  return { queued, sources: sources.length, complete: queued < cap };
}

export async function backfillVectorSources({ limit = 80 } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 80));
  const config = await loadEmbeddingConfig().catch(() => null);
  await pruneOrphanedMemoryVectors().catch(() => 0);
  let queued = 0;
  for (const [store, namespace] of BACKFILL_SOURCES) {
    const rows = await db.getAllRecords(store).catch(() => []);
    for (const row of rows) {
      if (row?.vectorSupersededBy) {
        // 手动精简后的原记录故意跨表指向精简记忆；保留其现有/待建向量，
        // 不把它误判成“丢失规范记录”后恢复为常驻内容。
        if (row?.memoryCompactionArchivedBy) continue;
        const canonical = await db.getRecord(store, row.vectorSupersededBy).catch(() => null);
        if (canonical) continue;
        row.vectorSupersededBy = '';
        row.vectorSupersededAt = 0;
        await db.putRecord(store, row);
      }
      const id = `${namespace}:${row?.id || ''}`;
      const existing = row?.id ? await db.getRecord(STORE, id).catch(() => null) : null;
      const text = vectorContentForSource(namespace, row);
      if (!text || vectorRowMatchesSource(existing, namespace, row, config)) continue;
      await enqueueVectorSource(namespace, row, { content: text, force: true, notify: false });
      queued += 1;
      if (queued >= cap) return { queued, complete: false };
    }
  }

  if (!isEmbeddingEnabled(config)) return { queued, complete: true };

  const settingsRows = await db.getAllRecords('settings').catch(() => []);
  const radioEpisodes = settingsRows
    .filter((row) => String(row?.key || '').startsWith('radioEpisode_') && row?.value)
    .map((row) => row.value);
  for (const episode of radioEpisodes) {
    for (const source of buildRadioEpisodePassageSources(episode)) {
      const existing = await db.getRecord(STORE, `archive:${source.id}`).catch(() => null);
      if (vectorRowMatchesSource(existing, 'archive', source, config)) continue;
      await enqueueVectorSource('archive', source, { force: true, notify: false });
      queued += 1;
      if (queued >= cap) return { queued, complete: false };
    }
  }
  const archives = settingsRows
    .filter((row) => String(row?.key || '').startsWith('offlineDateArchives_') && Array.isArray(row?.value))
    .flatMap((row) => row.value);
  for (const archive of archives) {
    const archiveSources = [
      {
        ...archive,
        content: [archive?.title, archive?.summary, archive?.digest?.story].filter(Boolean).join('\n'),
      },
      ...buildOfflineArchivePassageSources(archive),
    ].filter((source) => source?.id && vectorContentForSource('archive', source));
    for (const source of [...archiveSources].reverse()) {
      const existing = await db.getRecord(STORE, `archive:${source.id}`).catch(() => null);
      if (vectorRowMatchesSource(existing, 'archive', source, config)) continue;
      await enqueueVectorSource('archive', source, { force: true, notify: false });
      queued += 1;
      if (queued >= cap) return { queued, complete: false };
    }
  }

  const chats = await db.getAllRecords('chats').catch(() => []);
  for (const chat of chats) {
    const messages = await db.getAllByIndex('messages', 'chatId', chat.id).catch(() => []);
    const result = await enqueueChatMessagePassages({
      chat,
      messages,
      recentWindow: CHAT_ORIGINAL_RECENT_WINDOW,
      limit: cap - queued,
      config,
      notify: false,
    });
    queued += Number(result.queued || 0);
    if (queued >= cap) return { queued, complete: false };
  }
  return { queued, complete: true };
}

function cacheQuery(hash, vector) {
  if (queryCache.has(hash)) queryCache.delete(hash);
  queryCache.set(hash, vector);
  while (queryCache.size > QUERY_CACHE_LIMIT) queryCache.delete(queryCache.keys().next().value);
}

function queryConfigKey(config = {}) {
  return [
    String(config.baseUrl || '').trim(),
    String(config.model || '').trim(),
    Math.max(0, Number(config.dimensions) || 0),
  ].join('|');
}

function normalizeVectorQueryValues(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

async function listVectorRowsForUser(userId = '', options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return db.getAllRecords(STORE).catch(() => []);
  const statuses = normalizeVectorQueryValues(options.statuses);
  const namespaces = normalizeVectorQueryValues(options.namespaces);
  if (namespaces.length || statuses.length) {
    // 聊天语义召回只需要少数 namespace 的 ready 向量。优先走现有精确索引，
    // 避免按 userId 把原文分段、世界书、pending/failed 等无关大向量一起反序列化。
    const rows = namespaces.length
      ? (await Promise.all(namespaces.map((namespace) => (
        db.getAllByIndex(STORE, 'namespace', namespace).catch(() => [])
      )))).flat()
      : (await Promise.all(statuses.map((status) => (
        db.getAllByIndex(STORE, 'status', status).catch(() => [])
      )))).flat();
    const allowedStatuses = new Set(statuses);
    const allowedNamespaces = new Set(namespaces);
    return rows.filter((row) => (
      String(row?.userId || '') === uid
      && (!allowedStatuses.size || allowedStatuses.has(String(row?.status || 'pending')))
      && (!allowedNamespaces.size || allowedNamespaces.has(String(row?.namespace || '')))
    ));
  }
  return db.getAllByIndex(STORE, 'userId', uid).catch(() => []);
}

function memoryVectorScopeFilter({
  characterIds = [],
  namespaces = [],
  scopeIds = [],
  strictCharacterScope = false,
} = {}) {
  const audience = new Set((characterIds || []).map(String).filter(Boolean));
  const allowedScopes = new Set((scopeIds || []).map(String).filter(Boolean));
  const allowedNamespaces = new Set((Array.isArray(namespaces) ? namespaces : [namespaces])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  return (row) => {
    if (allowedNamespaces.size && !allowedNamespaces.has(String(row?.namespace || ''))) return false;
    if (!audience.size) return true;
    const witnesses = Array.isArray(row?.witnesses) ? row.witnesses.map(String) : [];
    if (strictCharacterScope) {
      const linkedActors = new Set([
        String(row?.characterId || ''),
        String(row?.subjectId || ''),
        String(row?.objectId || ''),
        ...witnesses,
      ].filter(Boolean));
      return [...audience].every((id) => linkedActors.has(id))
        || (allowedScopes.size && allowedScopes.has(String(row?.scopeId || '')));
    }
    return !witnesses.length || [...audience].every((id) => witnesses.includes(id));
  };
}

export async function getMemoryVectorIndexStats({
  userId = '',
  characterIds = [],
  namespaces = [],
  scopeIds = [],
  strictCharacterScope = false,
} = {}) {
  const rows = (await listVectorRowsForUser(userId)).filter(memoryVectorScopeFilter({
    characterIds,
    namespaces,
    scopeIds,
    strictCharacterScope,
  }));
  const counts = {
    total: rows.length,
    ready: 0,
    pending: 0,
    failed: 0,
    superseded: 0,
  };
  for (const row of rows) {
    const status = String(row?.status || 'pending');
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
  }
  const readyRows = rows.filter((row) => row?.status === 'ready');
  const nextRetryAt = rows
    .filter((row) => row?.status === 'failed' && Number(row.nextAttemptAt || 0) > 0)
    .reduce((earliest, row) => (
      !earliest || Number(row.nextAttemptAt) < earliest ? Number(row.nextAttemptAt) : earliest
    ), 0);
  return {
    ...counts,
    nextRetryAt,
    models: [...new Set(readyRows.map((row) => String(row.model || '').trim()).filter(Boolean))],
    dims: [...new Set(readyRows.map((row) => Number(row.dims || 0)).filter(Boolean))],
  };
}

/**
 * 供记忆馆浏览索引内容。向量数组本身既占内存又不适合用户阅读，返回前主动剥离。
 */
export async function listMemoryVectorIndexEntries({
  userId = '',
  characterIds = [],
  namespaces = [],
  scopeIds = [],
  strictCharacterScope = false,
  statuses = [],
  limit = 40,
} = {}) {
  const allowedStatuses = new Set((Array.isArray(statuses) ? statuses : [statuses])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  const cap = Math.max(1, Math.min(100, Math.floor(Number(limit) || 40)));
  const rows = (await listVectorRowsForUser(userId))
    .filter(memoryVectorScopeFilter({ characterIds, namespaces, scopeIds, strictCharacterScope }))
    .filter((row) => !allowedStatuses.size || allowedStatuses.has(String(row?.status || 'pending')))
    .sort((a, b) => (
      Number(b.sourceTimestamp || b.updatedAt || 0) - Number(a.sourceTimestamp || a.updatedAt || 0)
      || String(a.id || '').localeCompare(String(b.id || ''))
    ))
    .slice(0, cap);
  return rows.map((row) => {
    const { vector: _vector, ...entry } = row;
    return entry;
  });
}

/** 将当前用户可见范围内的失败记录立即放回队列；传 ids 时只重试指定记录。 */
export async function retryMemoryVectorIndexEntries({
  ids = [],
  userId = '',
  characterIds = [],
  namespaces = [],
  scopeIds = [],
  strictCharacterScope = false,
} = {}) {
  const requestedIds = new Set((Array.isArray(ids) ? ids : [ids])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  const now = Date.now();
  const rows = (await listVectorRowsForUser(userId))
    .filter(memoryVectorScopeFilter({ characterIds, namespaces, scopeIds, strictCharacterScope }))
    .filter((row) => row?.status === 'failed')
    .filter((row) => !requestedIds.size || requestedIds.has(String(row.id || '')))
    .map((row) => ({
      ...row,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      error: '',
      updatedAt: now,
    }));
  if (!rows.length) return { retried: 0 };
  await db.putMany(STORE, rows);
  requestMemoryVectorBacklog('manual-retry');
  return { retried: rows.length };
}

async function getQueryVectors(queryTexts = [], config = null, options = {}) {
  const queries = (Array.isArray(queryTexts) ? queryTexts : [queryTexts]).map(cleanText);
  const effectiveConfig = config || await loadEmbeddingConfig();
  if (!isEmbeddingEnabled(effectiveConfig)) return queries.map(() => null);
  const configKey = queryConfigKey(effectiveConfig);
  const entries = queries.map((query) => ({
    query,
    hash: query ? `${configKey}:${contentHash(query)}` : '',
  }));
  const missingByHash = new Map();
  for (const entry of entries) {
    if (entry.hash && !queryCache.has(entry.hash)) missingByHash.set(entry.hash, entry.query);
  }
  if (missingByHash.size) {
    const missingEntries = [...missingByHash.entries()];
    const vectors = await requestEmbedding(missingEntries.map(([, query]) => query), {
      config: effectiveConfig,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    for (let index = 0; index < missingEntries.length; index += 1) {
      cacheQuery(missingEntries[index][0], vectors[index]);
    }
  }
  return entries.map((entry) => (entry.hash ? queryCache.get(entry.hash) || null : null));
}

export async function getQueryVector(queryText = '', config = null, options = {}) {
  const [vector] = await getQueryVectors([queryText], config, options);
  return vector || null;
}

export async function createVectorSemanticScore(queryText = '', {
  namespaces = [],
  userId = '',
  lexicalScore = lexicalTimelineSimilarity,
  recentOutputText = '',
  signal = null,
  timeoutMs = 0,
} = {}) {
  const allowed = new Set((namespaces || []).filter(Boolean));
  let rows = await listVectorRowsForUser(userId, {
    statuses: ['ready'],
    namespaces: [...allowed],
  });
  rows = rows.filter((row) => row?.status === 'ready'
    && Array.isArray(row.vector)
    && (!allowed.size || allowed.has(row.namespace))
    && (!userId || String(row.userId || '') === String(userId)));
  // 没有可参与评分的本地向量时，联网生成查询向量没有任何意义。
  if (!rows.length) return null;

  const effectiveConfig = await loadEmbeddingConfig().catch(() => null);
  if (!isEmbeddingEnabled(effectiveConfig)) return null;
  rows = rows.filter((row) => String(row.model || '') === String(effectiveConfig.model || ''));
  if (!rows.length) return null;

  const configKey = queryConfigKey(effectiveConfig);
  if (Number(optionalQueryRetryAfter.get(configKey) || 0) > Date.now()) return null;
  let vectors;
  try {
    // 当前查询与最近回复一次批量提交，避免移动端串行发出两个远程 embedding 请求。
    vectors = await getQueryVectors(
      recentOutputText ? [queryText, recentOutputText] : [queryText],
      effectiveConfig,
      { signal, timeoutMs },
    );
    optionalQueryRetryAfter.delete(configKey);
  } catch (_) {
    // 向量排序只是增强项；线路已经失败时短期熔断，后续聊天直接走本地词面召回。
    optionalQueryRetryAfter.set(configKey, Date.now() + OPTIONAL_QUERY_FAILURE_COOLDOWN_MS);
    return null;
  }
  const queryVector = vectors[0] || null;
  if (!queryVector) return null;
  const recentOutputVector = recentOutputText ? vectors[1] || null : null;
  const byHash = new Map(rows.map((row) => [row.contentHash, row]));
  const score = (query = '', text = '') => {
    const lexical = Math.max(0, Number(lexicalScore(query, text)) || 0);
    const row = byHash.get(contentHash(cleanText(text)));
    if (!row || row.vector.length !== queryVector.length) return lexical;
    const semantic = Math.max(0, cosineSimilarity(queryVector, row.vector));
    const repeated = recentOutputVector?.length === row.vector.length
      ? Math.max(0, cosineSimilarity(recentOutputVector, row.vector))
      : 0;
    const noveltyFactor = repeated >= VECTOR_THRESHOLDS.noveltyHardRepeat
      ? 0.3
      : (repeated >= VECTOR_THRESHOLDS.noveltySoftRepeat ? 0.62 : 1);
    return Math.max(lexical, semantic * noveltyFactor);
  };
  score.hasVector = (text = '') => byHash.has(contentHash(cleanText(text)));
  score.readyCount = byHash.size;
  return score;
}

export async function getReadyVectorSourceIds({
  userId = '',
  namespace = '',
} = {}) {
  const rows = await listVectorRowsForUser(userId, {
    statuses: ['ready'],
    namespaces: namespace ? [namespace] : [],
  });
  return new Set(rows
    .filter((row) => row?.status === 'ready'
      && (!namespace || row.namespace === namespace)
      && (!userId || String(row.userId || '') === String(userId)))
    .map((row) => String(row.sourceId || ''))
    .filter(Boolean));
}

export async function searchMemoryVectors(queryText = '', {
  userId = '',
  namespaces = [],
  characterIds = [],
  scopeIds = [],
  strictCharacterScope = false,
  scopeId = '',
  limit = 30,
  threshold = 0.35,
} = {}) {
  const queryVector = await getQueryVector(queryText).catch(() => null);
  if (!queryVector) return [];
  const ns = new Set((namespaces || []).filter(Boolean));
  const rows = await listVectorRowsForUser(userId, {
    statuses: ['ready'],
    namespaces: [...ns],
  });
  return rows
    .filter((row) => row?.status === 'ready'
      && Array.isArray(row.vector)
      && row.vector.length === queryVector.length
      && (!userId || String(row.userId || '') === String(userId))
      && (!ns.size || ns.has(row.namespace))
      && (!scopeId || !row.scopeId || String(row.scopeId) === String(scopeId))
      && memoryVectorScopeFilter({
        characterIds,
        namespaces: [...ns],
        scopeIds,
        strictCharacterScope,
      })(row))
    .map((row) => ({ ...row, score: cosineSimilarity(queryVector, row.vector) }))
    .filter((row) => row.score >= threshold)
    .sort((a, b) => b.score - a.score || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 30)));
}
