import * as db from '../db.js';
import { chatForTask } from '../api.js';
import {
  acquireNarrationGenerationLease,
  narrationGenerationInFlightError,
} from '../narration-generation-lease.js';
import { createMemory } from '../../models/memory.js';
import { getNowForUser } from '../time-mode.js';
import {
  deleteVectorSources,
  enqueueVectorSource,
  requestMemoryVectorBacklog,
} from './memory-vectors.js';

export const MEMORY_COMPACTION_SOURCE = 'memory-compaction';
export const MEMORY_COMPACTION_MIN_SOURCES = 2;
const SOURCE_BATCH_CHARS = 30000;
const SOURCE_UNIT_CHARS = 10000;
const COMPACTED_MAX_CHARS = 5000;

function cleanText(value = '') {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sourceStore(value = '') {
  return value === 'eventMemories' ? 'eventMemories' : 'memories';
}

function sourceContent(store = '', row = {}) {
  return cleanText(store === 'eventMemories' ? row.summary : row.content);
}

function sourceTimestamp(store = '', row = {}) {
  if (store === 'memories') {
    return Number(row.summaryToTs || row.timestamp || 0);
  }
  return Number(row.timestamp || 0);
}

function sourceChatIds(store = '', row = {}) {
  if (store === 'eventMemories') {
    return (Array.isArray(row.involvedChats) ? row.involvedChats : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
  }
  const id = String(row.chatId || '').trim();
  return id ? [id] : [];
}

function compactableMemory(row = {}) {
  return String(row.type || '') === 'summary'
    && !!cleanText(row.content)
    && !row.vectorSupersededBy
    && !row.memoryCompactionArchivedBy;
}

function compactableEvent(row = {}) {
  return !!cleanText(row.summary)
    && !row.vectorSupersededBy
    && !row.memoryCompactionArchivedBy;
}

export function isDistilledMemory(row = {}) {
  return String(row.source || '') === MEMORY_COMPACTION_SOURCE
    || row.memoryCompacted === true;
}

export function isMemoryCompactionArchived(row = {}) {
  return !!String(row.memoryCompactionArchivedBy || '').trim();
}

export function buildMemoryCompactionCandidates({ summaries = [], events = [] } = {}) {
  return [
    ...(Array.isArray(summaries) ? summaries : [])
      .filter(compactableMemory)
      .map((row) => ({
        store: 'memories',
        id: String(row.id || ''),
        kind: isDistilledMemory(row) ? '精简记忆' : '摘要',
        content: cleanText(row.content),
        timestamp: sourceTimestamp('memories', row),
        row,
      })),
    ...(Array.isArray(events) ? events : [])
      .filter(compactableEvent)
      .map((row) => ({
        store: 'eventMemories',
        id: String(row.id || ''),
        kind: '事件',
        content: cleanText(row.summary),
        timestamp: sourceTimestamp('eventMemories', row),
        row,
      })),
  ]
    .filter((item) => item.id && item.content)
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
}

export function sanitizeCompactedMemory(value = '') {
  return cleanText(value)
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/gi, '')
    .trim()
    .slice(0, COMPACTED_MAX_CHARS);
}

function splitSourceUnits(source = {}) {
  const content = cleanText(source.content);
  if (content.length <= SOURCE_UNIT_CHARS) return [{ ...source, content }];
  const units = [];
  for (let start = 0; start < content.length; start += SOURCE_UNIT_CHARS) {
    units.push({
      ...source,
      content: content.slice(start, start + SOURCE_UNIT_CHARS),
      part: Math.floor(start / SOURCE_UNIT_CHARS) + 1,
      parts: Math.ceil(content.length / SOURCE_UNIT_CHARS),
    });
  }
  return units;
}

export function groupMemoryCompactionSources(sources = [], maxChars = SOURCE_BATCH_CHARS) {
  const budget = Math.max(4000, Number(maxChars) || SOURCE_BATCH_CHARS);
  const units = (Array.isArray(sources) ? sources : []).flatMap(splitSourceUnits);
  const groups = [];
  let current = [];
  let used = 0;
  for (const unit of units) {
    const cost = unit.content.length + 160;
    if (current.length && used + cost > budget) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(unit);
    used += cost;
  }
  if (current.length) groups.push(current);
  return groups;
}

function formatSourceUnit(source = {}, index = 0) {
  const timestamp = Number(source.timestamp || 0);
  const date = timestamp ? new Date(timestamp).toLocaleString('zh-CN') : '时间未标';
  const part = source.parts > 1 ? ` · 第 ${source.part}/${source.parts} 段` : '';
  return `【${source.kind || '记忆'} ${index + 1} · ${date}${part}】\n${cleanText(source.content)}`;
}

function buildCompactionPrompt(sources = [], { intermediate = false } = {}) {
  return [
    '你在整理一组已经发生过的聊天摘要与事件记录。',
    intermediate
      ? '任务：把这一批资料压缩成可供下一轮继续合并的阶段记忆。'
      : '任务：把这些资料合并成一份可直接替代原记录的长期精简记忆。',
    '要求：',
    '- 只保留资料中明确出现的事实，不补写、不猜测。',
    '- 合并重复内容；冲突时优先采用时间更晚、描述更明确的记录。',
    '- 保留重要经历、稳定偏好、关系变化、当前仍有效的状态、承诺、日程、边界和冲突后果。',
    '- 清除被旧摘要误收的一次性昵称、关系标签、动物化意象、职业称谓、比喻和冷梗；仅当资料明确显示对方主动复用、要求保留或双方多轮持续正面接梗时，才把它视为稳定共享用语。单纯“出现过”以及角色单方面反复使用都不构成证据。',
    '- 已经被后续聊天越过或解决的随口问句、临时提议、点餐选择等，只保留必要结论，绝不能写成“尚待回答”。',
    '- 明确区分谁对谁做了什么，不交换人物主体。',
    '- 结果必须自足；原记录归档后，AI只读这份结果也能理解必要背景。',
    '- 使用简洁中文，按真实先后整理；没有内容的栏目不要输出。',
    intermediate
      ? '- 控制在 500～1800 个中文字符。'
      : '- 控制在 600～3000 个中文字符。',
    '- 只输出精简结果，不解释过程，不使用 Markdown 代码围栏。',
    '',
    '待整理资料：',
    sources.map(formatSourceUnit).join('\n\n'),
  ].join('\n');
}

async function compressSourceGroup(sources = [], options = {}) {
  const raw = await chatForTask(
    [{ role: 'user', content: buildCompactionPrompt(sources, options) }],
    { temperature: 0.2 },
    'materialCompress',
  );
  const content = sanitizeCompactedMemory(raw);
  if (!content) throw new Error('AI 没有返回可用的精简结果');
  return content;
}

async function distillMemorySourcesUnlocked(sources = []) {
  const selected = (Array.isArray(sources) ? sources : [])
    .filter((item) => item?.id && cleanText(item.content));
  if (selected.length < MEMORY_COMPACTION_MIN_SOURCES) throw new Error('请至少选择两条记忆');
  let groups = groupMemoryCompactionSources(selected);
  let round = 0;
  while (groups.length > 1) {
    const stageResults = [];
    for (let index = 0; index < groups.length; index += 1) {
      const content = await compressSourceGroup(groups[index], { intermediate: true });
      stageResults.push({
        id: `stage-${round}-${index}`,
        kind: '阶段记忆',
        timestamp: Math.max(...groups[index].map((item) => Number(item.timestamp || 0))),
        content,
      });
    }
    groups = groupMemoryCompactionSources(stageResults);
    round += 1;
    if (round > 6) throw new Error('所选记忆过多，请分批精简');
  }
  return compressSourceGroup(groups[0], { intermediate: false });
}

export async function distillMemorySources(sources = [], options = {}) {
  const selected = (Array.isArray(sources) ? sources : []).filter((item) => item?.id);
  const leaseId = String(options.leaseId || '').trim()
    || selected.map((item) => String(item.id)).sort().join('|')
    || 'memory-compaction';
  const lease = await acquireNarrationGenerationLease('memory-compaction', leaseId);
  if (!lease.acquired) throw narrationGenerationInFlightError();
  try {
    return await distillMemorySourcesUnlocked(sources);
  } finally {
    await lease.release();
  }
}

function normalizeSourceRefs(sourceRefs = []) {
  const seen = new Set();
  return (Array.isArray(sourceRefs) ? sourceRefs : [])
    .map((ref) => ({ store: sourceStore(ref?.store), id: String(ref?.id || '').trim() }))
    .filter((ref) => {
      const key = `${ref.store}:${ref.id}`;
      if (!ref.id || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function readCompactionSources(sourceRefs = [], userId = '') {
  const uid = String(userId || '').trim();
  const rows = [];
  for (const ref of normalizeSourceRefs(sourceRefs)) {
    const row = await db.getRecord(ref.store, ref.id).catch(() => null);
    const compactable = ref.store === 'eventMemories' ? compactableEvent(row) : compactableMemory(row);
    if (!row || !compactable || (row.userId && uid && String(row.userId) !== uid)) continue;
    rows.push({
      ...ref,
      row,
      content: sourceContent(ref.store, row),
      timestamp: sourceTimestamp(ref.store, row),
    });
  }
  return rows;
}

function archivedSourceRow(source = {}, compactedId = '', now = Date.now()) {
  const row = source.row || {};
  return {
    ...row,
    vectorSupersededBy: compactedId,
    vectorSupersededAt: now,
    memoryCompactionArchivedBy: compactedId,
    memoryCompactionArchivedAt: now,
    memoryCompactionRestoreState: {
      vectorSupersededBy: String(row.vectorSupersededBy || ''),
      vectorSupersededAt: Number(row.vectorSupersededAt || 0),
      vectorArchived: row.vectorArchived === true,
    },
  };
}

export async function saveCompactedMemory({
  userId = '',
  characterId = '',
  chatId = '',
  content = '',
  sourceRefs = [],
} = {}) {
  const uid = String(userId || '').trim();
  const body = sanitizeCompactedMemory(content);
  const sources = await readCompactionSources(sourceRefs, uid);
  if (!uid || !body || sources.length < MEMORY_COMPACTION_MIN_SOURCES) {
    throw new Error('精简内容或来源不足，请重新选择');
  }
  const now = await getNowForUser(uid);
  const timestamps = sources.map((item) => Number(item.timestamp || 0)).filter(Boolean);
  const cid = String(characterId || '').trim();
  const commonChatIds = [...new Set(sources.flatMap((item) => sourceChatIds(item.store, item.row)))];
  if (!cid && commonChatIds.length !== 1) {
    throw new Error('全局记忆请按同一会话分批精简');
  }
  const compacted = createMemory({
    userId: uid,
    characterId: cid,
    chatId: String(chatId || (commonChatIds.length === 1 ? commonChatIds[0] : '')).trim(),
    type: 'summary',
    category: 'consolidated',
    content: body,
    importance: 'high',
    source: MEMORY_COMPACTION_SOURCE,
    timestamp: now,
  });
  compacted.memoryCompacted = true;
  compacted.sourceMemoryRefs = sources.map(({ store, id }) => ({ store, id }));
  compacted.summaryFromTs = timestamps.length ? Math.min(...timestamps) : now;
  compacted.summaryToTs = timestamps.length ? Math.max(...timestamps) : now;
  compacted.archiveTitle = '精简记忆';
  compacted.vectorArchived = false;

  // 先为原记录保住独立向量。未启用向量时它们只会留在待处理队列，绝不会常驻注入。
  let queued = 0;
  for (const source of sources) {
    const namespace = source.store === 'eventMemories' ? 'event' : 'memory';
    if (await enqueueVectorSource(namespace, source.row, { notify: false }).catch(() => null)) queued += 1;
  }
  await db.putRecord('memories', compacted);
  const archivedAt = Date.now();
  const archivedMemories = sources
    .filter((item) => item.store === 'memories')
    .map((item) => archivedSourceRow(item, compacted.id, archivedAt));
  const archivedEvents = sources
    .filter((item) => item.store === 'eventMemories')
    .map((item) => archivedSourceRow(item, compacted.id, archivedAt));
  if (archivedMemories.length) await db.putMany('memories', archivedMemories);
  if (archivedEvents.length) await db.putMany('eventMemories', archivedEvents);
  if (await enqueueVectorSource('memory', compacted, { notify: false }).catch(() => null)) queued += 1;
  if (queued) requestMemoryVectorBacklog('memory-compacted');
  return compacted;
}

function restoredSourceRow(row = {}, compactedId = '') {
  if (String(row.memoryCompactionArchivedBy || '') !== String(compactedId || '')) return row;
  const previous = row.memoryCompactionRestoreState && typeof row.memoryCompactionRestoreState === 'object'
    ? row.memoryCompactionRestoreState
    : {};
  const next = {
    ...row,
    vectorSupersededBy: String(previous.vectorSupersededBy || ''),
    vectorSupersededAt: Number(previous.vectorSupersededAt || 0),
    vectorArchived: previous.vectorArchived === true,
  };
  delete next.memoryCompactionArchivedBy;
  delete next.memoryCompactionArchivedAt;
  delete next.memoryCompactionRestoreState;
  return next;
}

export async function restoreCompactedMemory(id = '', userId = '') {
  const compactedId = String(id || '').trim();
  const uid = String(userId || '').trim();
  const compacted = await db.getRecord('memories', compactedId).catch(() => null);
  if (!compacted || !isDistilledMemory(compacted) || (compacted.userId && uid && compacted.userId !== uid)) {
    throw new Error('精简记忆不存在');
  }
  const refs = normalizeSourceRefs(compacted.sourceMemoryRefs);
  const restored = [];
  for (const ref of refs) {
    const row = await db.getRecord(ref.store, ref.id).catch(() => null);
    if (!row || String(row.memoryCompactionArchivedBy || '') !== compactedId) continue;
    const next = restoredSourceRow(row, compactedId);
    await db.putRecord(ref.store, next);
    restored.push(next);
  }
  await db.deleteRecord('memories', compactedId);
  await deleteVectorSources('memory', [compactedId]).catch(() => {});
  if (restored.length) requestMemoryVectorBacklog('memory-compaction-restored');
  return { restored: restored.length };
}
