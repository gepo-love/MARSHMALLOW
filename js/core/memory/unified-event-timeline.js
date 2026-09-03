import * as db from '../db.js';
import { isAnonymousChat } from '../chat-helpers.js';
import { listWorldUserIds } from '../world-scope.js';
import { loadChatPrefs, patchChatPrefs } from '../chat-block-state.js';
import { normalizeMemoryInjectionSettings } from './memory-injection-settings.js';
import { canStrangerChatShareMemory, isStrangerInterceptChat } from '../stranger-thread-model.js';
import {
  audienceCanReceiveSource,
  selectArchiveAudienceScope,
} from '../context/context-injection-scope.js';
import { effectiveEventPendingThreads, effectiveEventTemporalState } from '../../models/event-memory.js';

const DEFAULT_BUDGET_CHARS = 9000;
const DEFAULT_MAX_EVENTS = 36;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TIMELINE_LEXICAL_GATE = 0.08;
export const TIMELINE_HOT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const TIMELINE_DECAY_CATEGORIES = Object.freeze(['core', 'group', 'social', 'ambient']);

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function timelineRetrievalTimestamp(event = {}) {
  const retrievalTimestamp = Number(event?.retrievalTimestamp || 0);
  if (Number.isFinite(retrievalTimestamp) && retrievalTimestamp > 0) return retrievalTimestamp;
  return Number(event?.timestamp || 0) || 0;
}

function archiveIdCreatedAtReal(archiveId = '') {
  const idMatch = String(archiveId || '').match(/^oda_([a-z0-9]+)_/i);
  const timestamp = Number.parseInt(idMatch?.[1] || '', 36);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function mergeRowsById(lists = []) {
  const merged = new Map();
  for (const list of Array.isArray(lists) ? lists : []) {
    for (const row of Array.isArray(list) ? list : []) {
      const id = String(row?.id || '').trim();
      if (!id || merged.has(id)) continue;
      merged.set(id, row);
    }
  }
  return [...merged.values()];
}

async function readRowsByIndex(storeName, indexName, values = []) {
  const keys = [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (!keys.length) return [];
  const lists = await Promise.all(keys.map((key) => (
    db.getAllByIndex(storeName, indexName, key).catch(() => [])
  )));
  return mergeRowsById(lists);
}

function isHighImportance(value = '') {
  return ['high', 'important'].includes(String(value || '').trim());
}

/** 剧情长卷与聊天摘要是完整上下文材料；聊天摘要仍属于有损概括。 */
export function isFullContextSummary(event = {}) {
  return event?.fullContextSummary === true;
}

export function classifyTimelineDecayCategory(event = {}, options = {}) {
  const explicit = String(event?.decayCategory || '').trim();
  if (TIMELINE_DECAY_CATEGORIES.includes(explicit)) return explicit;
  const source = String(event?.source || '').trim();
  const userId = String(options.userId || '').trim();
  const authorId = String(event?.momentAuthorId || '').trim();
  if (source === 'moments') {
    return authorId === 'user' || (!!userId && authorId === userId) || isHighImportance(event?.importance)
      ? 'core'
      : 'social';
  }
  if (source === 'weibo_dm' || ['public', 'spreading'].includes(String(event?.visibility || ''))) {
    return 'social';
  }
  if (['offline_date', 'offline_archive', 'manual-import', 'memory-compaction', 'travel_char'].includes(source)) {
    return 'core';
  }
  const chatById = options.chatById instanceof Map ? options.chatById : new Map();
  const sourceChats = (Array.isArray(event?.chatIds) ? event.chatIds : [])
    .map((chatId) => chatById.get(String(chatId || '').trim()))
    .filter(Boolean);
  if (sourceChats.some((row) => isStrangerInterceptChat(row))) return 'ambient';
  if (sourceChats.some((row) => String(row?.type || '') === 'group'
    || (Array.isArray(row?.participants) && row.participants.length > 2))) return 'group';
  return 'core';
}

export function resolveTimelineHotWindowMs(event = {}, decaySettings = null) {
  if (!decaySettings || decaySettings.memoryDecayEnabled !== true) return TIMELINE_HOT_WINDOW_MS;
  const category = classifyTimelineDecayCategory(event);
  const field = {
    core: 'memoryDecayCoreHours',
    group: 'memoryDecayGroupHours',
    social: 'memoryDecaySocialHours',
    ambient: 'memoryDecayAmbientHours',
  }[category] || 'memoryDecayCoreHours';
  return Math.max(1, Number(decaySettings[field]) || 1) * HOUR_MS;
}

export function isTimelineEventHot(event = {}, now = Date.now(), decaySettings = null) {
  const timestamp = timelineRetrievalTimestamp(event);
  return timestamp > 0
    && timestamp <= Number(now || Date.now())
    && Number(now || Date.now()) - timestamp <= resolveTimelineHotWindowMs(event, decaySettings);
}

function localDayRange(now, dayOffset = 0) {
  const start = new Date(Number(now || Date.now()));
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + dayOffset);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    start: start.getTime(),
    end: end.getTime(),
  };
}

function localDateRange(year, month, day) {
  const start = new Date(Number(year), Number(month) - 1, Number(day));
  if (start.getFullYear() !== Number(year)
    || start.getMonth() !== Number(month) - 1
    || start.getDate() !== Number(day)) return null;
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

/** 将相对日期与明确年月日转成硬日期范围，避免只靠语义相似度漏掉摘要。 */
export function parseTimelineTemporalRange(queryText = '', now = Date.now()) {
  const query = clean(queryText);
  if (!query) return null;
  const fullDate = query.match(/(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/);
  if (fullDate) return localDateRange(fullDate[1], fullDate[2], fullDate[3]);
  const monthDay = query.match(/(?:^|\D)(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (monthDay) return localDateRange(new Date(Number(now || Date.now())).getFullYear(), monthDay[1], monthDay[2]);
  if (/大前天/.test(query)) return localDayRange(now, -3);
  if (/(?:前天|前日)/.test(query)) return localDayRange(now, -2);
  if (/(?:昨天|昨日|昨晚|昨夜)/.test(query)) return localDayRange(now, -1);
  if (/(?:今天|今日|今早|今晚|今夜)/.test(query)) return localDayRange(now, 0);
  return null;
}

function timestampInRange(timestamp = 0, range = null) {
  const value = Number(timestamp || 0);
  return Boolean(range && value >= Number(range.start || 0) && value < Number(range.end || 0));
}

function isTimestampToday(timestamp = 0, now = Date.now()) {
  return timestampInRange(timestamp, localDayRange(now, 0));
}

/**
 * 摘要正文会保留生成当时的“今天 / 明天”等说法。给跨日记录加硬校准，
 * 避免较弱模型只看正文里的相对时间，把昨天的旧待办误认成今天仍未完成。
 */
export function timelineRelativeDateGuard(event = {}, now = Date.now()) {
  const timestamp = Number(event?.timestamp || 0);
  const text = clean(event?.text);
  if (!timestamp || isTimestampToday(timestamp, now)) return '';
  if (!/(?:今天|今日|今早|今晚|今夜|昨天|昨日|昨晚|昨夜|明天|明日|明早|明晚|后天|前天)/u.test(text)) return '';
  return `正文中的相对日期以 ${timelineDateLabel(timestamp).slice(0, 10)} 当时为准，不是当前“今天”`;
}

function isSummaryCoveredByRecentHistory(event = {}, options = {}) {
  if (!isFullContextSummary(event)) return false;
  const currentChatId = String(options.currentChatId || '').trim();
  if (!currentChatId || !event?.chatIds?.includes(currentChatId)) return false;
  const summaryMessageIds = (Array.isArray(event.summaryMessageIds) ? event.summaryMessageIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const recentHistoryMessageIds = new Set(
    (Array.isArray(options.recentHistoryMessageIds) ? options.recentHistoryMessageIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  if (summaryMessageIds.length && recentHistoryMessageIds.size) {
    return summaryMessageIds.every((id) => recentHistoryMessageIds.has(id));
  }
  const summaryFromTs = Number(event.summaryFromTs || 0);
  const summaryToTs = Number(event.summaryToTs || 0);
  const recentHistoryStartTs = Number(options.recentHistoryStartTs || 0);
  const recentHistoryEndTs = Number(options.recentHistoryEndTs || 0);
  return summaryFromTs > 0
    && summaryToTs >= summaryFromTs
    && recentHistoryStartTs > 0
    && recentHistoryEndTs >= recentHistoryStartTs
    && summaryFromTs >= recentHistoryStartTs
    && summaryToTs <= recentHistoryEndTs;
}

export function compactTimelineSummary(text = '', limit = 1000) {
  const raw = clean(text);
  const cap = Math.max(240, Number(limit) || 1000);
  if (raw.length <= cap) return raw;
  const head = Math.floor(cap * 0.68);
  return `${raw.slice(0, head)} …（摘要中段已收进向量档案）… ${raw.slice(-(cap - head))}`;
}

function normalizeKey(value = '') {
  return clean(value)
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()[\]{}<>《》【】\s]/g, '');
}

function bigrams(value = '') {
  const text = normalizeKey(value);
  if (!text) return new Set();
  if (text.length === 1) return new Set([text]);
  const out = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    out.add(text.slice(index, index + 2));
  }
  return out;
}

/** 无 embeddings 时的可插拔词面相关度；后续向量层可替换 semanticScore。 */
export function lexicalTimelineSimilarity(query = '', text = '') {
  const left = bigrams(query);
  const right = bigrams(text);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return (2 * overlap) / (left.size + right.size);
}

export function isTimelineMemory(memory = {}) {
  const type = String(memory.type || '').trim();
  const source = String(memory.source || '').trim();
  return type === 'event'
    || type === 'summary'
    || ['offline_date', 'moments', 'travel_char', 'weibo_dm'].includes(source)
    || source.startsWith('api-summary-');
}

function knownLevelWeight(level = '') {
  if (level === 'involved' || level === 'shared') return 1;
  if (level === 'known') return 0.82;
  if (level === 'heard') return 0.48;
  return 0;
}

export function momentTimelineAudienceLabel(memory = {}, characterIds = []) {
  if (String(memory?.source || '').trim() !== 'moments') return '';
  const ids = [...new Set((characterIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return '';
  const knownBy = memory?.knownBy && typeof memory.knownBy === 'object' ? memory.knownBy : {};
  const levels = ids.map((id) => String(knownBy[id] || 'none'));
  if (levels.some((level) => knownLevelWeight(level) <= 0)) return '';
  return levels.every((level) => level === 'involved' || level === 'shared')
    ? '明确当事'
    : '仅知情';
}

function memoryVisibleToCharacters(memory = {}, characterIds = new Set()) {
  const id = String(memory.characterId || '').trim();
  if (String(memory.source || '').trim() === 'moments') {
    // 旧版朋友圈 memory 没有知情账本，不能让无归属记录绕过 public_feed 事实门禁。
    return !!momentTimelineAudienceLabel(memory, [...characterIds]);
  }
  if (!id) return true;
  if (characterIds.size <= 1) return characterIds.has(id);
  const knownBy = memory.knownBy && typeof memory.knownBy === 'object' ? memory.knownBy : {};
  return [...characterIds].every((cid) => knownLevelWeight(String(knownBy[cid] || 'none')) > 0);
}

export function selectTimelineMemoryRows(memories = [], characterIds = []) {
  const rows = Array.isArray(memories) ? memories : [];
  const sourceIds = Array.isArray(characterIds)
    ? characterIds
    : (characterIds && typeof characterIds[Symbol.iterator] === 'function' ? [...characterIds] : []);
  const ids = [...new Set(sourceIds
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (ids.length !== 1) return rows;
  const characterId = ids[0];
  const grouped = new Map();
  const passthrough = [];
  for (const row of rows) {
    if (String(row?.type || '') !== 'summary') {
      passthrough.push(row);
      continue;
    }
    const rangeKey = String(row?.summaryRangeKey || '').trim()
      || (
        Number(row?.summaryFromTs || 0) && Number(row?.summaryToTs || 0)
          ? `${Number(row.summaryFromTs)}:${Number(row.summaryToTs)}`
          : ''
      );
    if (!rangeKey) {
      passthrough.push(row);
      continue;
    }
    const key = `${String(row?.chatId || '')}:${rangeKey}`;
    const list = grouped.get(key) || [];
    list.push(row);
    grouped.set(key, list);
  }
  for (const list of grouped.values()) {
    const roleSummary = list.find((row) => String(row?.characterId || '') === characterId);
    const globalSummary = list.find((row) => !String(row?.characterId || '').trim());
    passthrough.push(roleSummary || globalSummary || list[0]);
  }
  return passthrough;
}

function eventVisibleToCharacters(event = {}, characterIds = new Set(), chatById = new Map()) {
  const knownBy = event.knownBy && typeof event.knownBy === 'object' ? event.knownBy : {};
  const hasExplicitAudience = Object.values(knownBy)
    .some((level) => knownLevelWeight(String(level || 'none')) > 0);
  if (!hasExplicitAudience) {
    const participants = new Set(
      (Array.isArray(event.involvedChats) ? event.involvedChats : [])
        .flatMap((chatId) => chatById.get(String(chatId || ''))?.participants || [])
        .map((id) => String(id || '').trim())
        .filter((id) => id && id !== 'user'),
    );
    return characterIds.size > 0 && [...characterIds].every((id) => participants.has(id));
  }
  return characterIds.size > 0 && [...characterIds]
    .every((id) => knownLevelWeight(String(knownBy[id] || 'none')) > 0);
}

function timelineDateLabel(timestamp = 0) {
  const value = Number(timestamp || 0);
  if (!value) return '时间未标';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未标';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/** 给跨自然日的旧记录显式标出“过去存档”，避免相似情节被并入当前场景。 */
export function timelinePastDayLabel(timestamp = 0, now = Date.now()) {
  const value = Number(timestamp || 0);
  const current = Number(now || Date.now());
  if (!value || !Number.isFinite(value) || !Number.isFinite(current)) return '';
  const eventDay = new Date(value);
  const currentDay = new Date(current);
  if (Number.isNaN(eventDay.getTime()) || Number.isNaN(currentDay.getTime())) return '';
  eventDay.setHours(0, 0, 0, 0);
  currentDay.setHours(0, 0, 0, 0);
  if (eventDay.getTime() >= currentDay.getTime()) return '';
  const days = Math.max(1, Math.round((currentDay.getTime() - eventDay.getTime()) / DAY_MS));
  return days === 1 ? '昨天 · 过去存档' : `${days}天前 · 过去存档`;
}

function sourceLabel(source = '') {
  const value = String(source || '').trim();
  if (value === 'memory-compaction') return '精简记忆';
  if (value === 'manual-import') return '剧情长卷';
  if (value === 'offline_date') return '线下相遇';
  if (value === 'moments') return '朋友圈';
  if (value === 'travel_char') return '旅行';
  if (value === 'weibo_dm') return '微博私信';
  if (value.startsWith('api-summary-')) return '聊天摘要';
  if (value === 'shared_event') return '共享知情';
  if (value === 'event_memory') return '跨窗事件';
  if (value === 'world_public_event') return '同世界公开事件';
  if (value === 'offline_archive') return '线下档案';
  return '事件';
}

function scoreTimelineEvent(event, {
  now = Date.now(),
  queryText = '',
  currentChatId = '',
  semanticScore = lexicalTimelineSimilarity,
  recentEventIds = [],
  temporalRange = null,
  decaySettings = null,
} = {}) {
  const timestamp = Number(event.timestamp || 0);
  const retrievalTimestamp = timelineRetrievalTimestamp(event);
  const age = retrievalTimestamp > 0 ? Math.max(0, now - retrievalTimestamp) : 180 * DAY_MS;
  const halfLifeDays = isHighImportance(event.importance) || event.unresolved ? 120 : 21;
  const recency = Math.pow(0.5, age / (halfLifeDays * DAY_MS));
  const semanticText = event.semanticText || event.text;
  const semantic = Math.max(0, Math.min(1, Number(semanticScore(queryText, semanticText) || 0)));
  const importantBoost = isHighImportance(event.importance) ? 1.8 : 0;
  // 跨日遗留的 pendingThreads 可能只是摘要没有及时收束，不能仅凭“未完成”永久抬高。
  // 用户本轮重新提起时，语义分仍会把它正常召回。
  const unresolvedBoost = event.unresolved && isTimestampToday(timestamp, now) ? 1.6 : 0;
  const currentChatBoost = currentChatId && event.chatIds?.includes(currentChatId) ? 1.15 : 0;
  const recentGuarantee = isTimelineEventHot(event, now, decaySettings) ? 0.9 : 0;
  const temporalBoost = timestampInRange(timestamp, temporalRange) ? 2.6 : 0;
  const cooldownPenalty = (Array.isArray(recentEventIds) ? recentEventIds : [])
    .includes(String(event.id || '')) ? 1.25 : 0;
  return importantBoost + unresolvedBoost + currentChatBoost + recentGuarantee
    + temporalBoost + recency + semantic * 1.7 - cooldownPenalty;
}

function dedupeTimelineEvents(events = []) {
  const byKey = new Map();
  for (const event of events) {
    const key = normalizeKey(event.text);
    if (!key) continue;
    const existing = byKey.get(key);
    const eventIsFullSummary = isFullContextSummary(event);
    const existingIsFullSummary = isFullContextSummary(existing);
    if (!existing
      || (eventIsFullSummary && !existingIsFullSummary)
      || (eventIsFullSummary === existingIsFullSummary
        && timelineRetrievalTimestamp(event) > timelineRetrievalTimestamp(existing))) {
      byKey.set(key, event);
    } else if (isHighImportance(event.importance)) {
      existing.importance = 'high';
    }
  }
  return [...byKey.values()];
}

export function retrieveTimelineEvents(events = [], options = {}) {
  const budgetChars = Math.max(1200, Math.min(20000, Number(options.budgetChars) || DEFAULT_BUDGET_CHARS));
  const requestedMaxEvents = options.maxEvents === undefined || options.maxEvents === null
    ? DEFAULT_MAX_EVENTS
    : Number(options.maxEvents);
  const maxEvents = Math.max(0, Math.min(80, Number.isFinite(requestedMaxEvents)
    ? requestedMaxEvents
    : DEFAULT_MAX_EVENTS));
  const guaranteedIds = new Set(
    (Array.isArray(options.guaranteedEventIds) ? options.guaranteedEventIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const guaranteedKeys = new Set(
    (Array.isArray(events) ? events : [])
      .filter((event) => guaranteedIds.has(String(event?.id || '')))
      .map((event) => normalizeKey(event?.text))
      .filter(Boolean),
  );
  const semanticThreshold = Math.max(0, Math.min(1, Number(options.semanticThreshold) || 0));
  const semanticScore = typeof options.semanticScore === 'function'
    ? options.semanticScore
    : lexicalTimelineSimilarity;
  const now = Number(options.now || Date.now());
  const decaySettings = options.decaySettings?.memoryDecayEnabled === true
    ? options.decaySettings
    : null;
  const decayEnabled = !!decaySettings;
  const temporalRange = options.temporalRange || parseTimelineTemporalRange(options.queryText, now);
  const ordinaryRelevanceThreshold = semanticThreshold > 0
    ? semanticThreshold
    : (clean(options.queryText) ? TIMELINE_LEXICAL_GATE : 0);
  const recentEventIds = new Set(
    (Array.isArray(options.recentEventIds) ? options.recentEventIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const availableEvents = (Array.isArray(events) ? events : [])
    .filter((event) => !isSummaryCoveredByRecentHistory(event, options))
    // 手动精简后的原记录不再参与无向量的常驻/词面召回。
    // 它们只在向量开启且语义真正命中时作为底层证据回来。
    .filter((event) => !(event?.compactionArchived === true && semanticThreshold <= 0));
  const passesRelevanceGate = (event) => {
      const semanticText = event?.semanticText || event?.text || '';
      const semanticRelevance = Number(semanticScore(options.queryText, semanticText) || 0);
      const dateMatched = timestampInRange(event?.timestamp, temporalRange);
      const eventId = String(event?.id || '');
      const offlineHistory = ['offline_date', 'offline_archive']
        .includes(String(event?.source || ''));
      const cooldownRecallThreshold = semanticThreshold > 0 ? semanticThreshold : 0.18;
      const explicitlyRelevant = dateMatched
        || (clean(options.queryText) && semanticRelevance >= cooldownRecallThreshold);
      if (guaranteedIds.has(eventId)) return true;
      if (event?.compactionArchived === true) {
        const hasReadyVector = typeof semanticScore.hasVector === 'function'
          && semanticScore.hasVector(semanticText);
        return semanticThreshold > 0
          && hasReadyVector
          && semanticRelevance >= semanticThreshold;
      }
      // 已完成线下的 high importance 表示“值得保留”，不是“每轮常驻”。返线上强承接
      // 退出后，线下历史必须由当前用户话题或明确日期重新召回；近期刚注入过的同一条
      // 还需达到较高阈值，避免模型自己复述旧情节后形成召回回音。
      if (offlineHistory && !dateMatched) {
        if (!clean(options.queryText)) return false;
        const baseThreshold = semanticThreshold > 0
          ? semanticThreshold
          : Math.max(TIMELINE_LEXICAL_GATE, ordinaryRelevanceThreshold);
        const required = recentEventIds.has(eventId)
          ? Math.max(baseThreshold, cooldownRecallThreshold)
          : baseThreshold;
        return semanticRelevance >= required;
      }
      if (decayEnabled) {
        const hot = isTimelineEventHot(event, now, decaySettings);
        // “重要 / 未完成 / 最近”只影响通过相关度门槛后的排序，不再把旧冲突
        // 变成每轮常驻话题。没有用户查询的后台场景仍可保留热状态。
        if (hot && isFullContextSummary(event) && !recentEventIds.has(eventId)) return true;
        if (hot && !clean(options.queryText) && (
          isHighImportance(event?.importance)
          || event?.unresolved
          || guaranteedIds.has(eventId)
        )) return true;
        if (dateMatched) return true;
        if (ordinaryRelevanceThreshold <= 0) return false;
        return semanticRelevance >= ordinaryRelevanceThreshold;
      }
      const fullSummary = isFullContextSummary(event);
      // 完整摘要首轮进入工作记忆；注入过后进入冷却。即使仍在 48 小时热窗内，
      // 也只有用户重新提到相关内容或日期时才恢复，避免有损概括持续主导弱模型。
      if (fullSummary
        && recentEventIds.has(String(event?.id || ''))
        && !explicitlyRelevant) return false;
      if (fullSummary && event?.distilledMemory === true) return true;
      // 未配置向量时保持旧摘要兼容：摘要仍完整可用，只收紧普通事件。
      if (fullSummary && semanticThreshold <= 0) return true;
      if (fullSummary && isTimelineEventHot(event, now)) return true;
      if (fullSummary && dateMatched) return true;
      if (fullSummary) {
        return semanticRelevance >= semanticThreshold;
      }
      if (guaranteedIds.has(eventId)) return true;
      if (dateMatched) return true;
      // 高重要度负责排序与预算竞争，不负责绕过相关度门槛。否则一条关系冲突
      // 会在用户换题后仍被每轮注入，弱模型很容易把“记得”误写成“继续追责”。
      return semanticRelevance >= ordinaryRelevanceThreshold;
    };
  const scopedEvents = options.temporalOnly === true && temporalRange
    ? availableEvents.filter((event) => timestampInRange(event?.timestamp, temporalRange))
    : availableEvents;
  const candidates = decayEnabled || ordinaryRelevanceThreshold > 0
    ? scopedEvents.filter(passesRelevanceGate)
    : scopedEvents;
  const ranked = dedupeTimelineEvents(candidates)
    .map((event) => ({
      ...event,
      score: scoreTimelineEvent(event, { ...options, semanticScore, temporalRange }),
    }))
    .sort((left, right) => right.score - left.score
      || timelineRetrievalTimestamp(right) - timelineRetrievalTimestamp(left));
  const recentGuaranteed = ranked.filter((event) => (
    event?.compactionArchived !== true
    && isFullContextSummary(event)
    && !recentEventIds.has(String(event?.id || ''))
    && (
      isTimelineEventHot(event, now, decaySettings)
      || (!decayEnabled && event?.distilledMemory === true)
    )
  ));
  const recentGuaranteedIds = new Set(
    recentGuaranteed.map((event) => String(event?.id || '')).filter(Boolean),
  );
  const ordered = [
    ...ranked
      .filter((event) => !recentGuaranteedIds.has(String(event.id || ''))
        && (guaranteedIds.has(String(event.id || ''))
        || guaranteedKeys.has(normalizeKey(event.text)))
      )
      .sort((left, right) => timelineRetrievalTimestamp(right) - timelineRetrievalTimestamp(left)),
    ...ranked.filter((event) => !recentGuaranteedIds.has(String(event.id || ''))
      && !guaranteedIds.has(String(event.id || ''))
      && !guaranteedKeys.has(normalizeKey(event.text))),
  ];
  // 各类别仍在常驻期内的摘要属于完整工作记忆，不占普通事件条数和冷却。
  // 普通事件即使刚发生，也必须先与当前话题相关；否则很容易把已经聊完的旧问句重新抬起来。
  const selected = semanticThreshold > 0 || decayEnabled
    ? [...recentGuaranteed]
    : [
      ...ranked.filter(isFullContextSummary),
      ...recentGuaranteed.filter((event) => !isFullContextSummary(event)),
    ];
  let used = 0;
  let selectedEventCount = 0;
  for (const event of ordered) {
    const cost = clean(event.text).length + 64;
    if (selectedEventCount >= maxEvents) break;
    if (used + cost > budgetChars && selectedEventCount >= 6) continue;
    selected.push(event);
    used += cost;
    selectedEventCount += 1;
  }
  return selected.sort((left, right) =>
    timelineRetrievalTimestamp(left) - timelineRetrievalTimestamp(right)
    || String(left.id || '').localeCompare(String(right.id || '')));
}

export function applyOfflineTimelineCandidateLimit(events = [], limit = 20) {
  const rows = Array.isArray(events) ? events : [];
  const cap = Math.max(0, Math.min(100, Math.floor(Number(limit) || 0)));
  const isOfflineEvent = (event) => ['offline_date', 'offline_archive'].includes(String(event?.source || ''));
  const offlineCandidates = rows
    .filter(isOfflineEvent)
    .sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0))
    .slice(0, cap);
  const allowedOfflineIds = new Set(offlineCandidates.map((event) => String(event.id || '')));
  return {
    events: rows.filter((event) =>
      !isOfflineEvent(event) || allowedOfflineIds.has(String(event.id || ''))),
    // “最新线下”只决定候选池保留谁，不代表每轮无条件注入。刚收纳后的必读承接
    // 由 offline-return-context 按轮数负责；进入长期时间轴后必须重新经过话题/日期召回。
    guaranteedEventIds: [],
  };
}

async function archiveFallbackEvents(userId, characterIds, coveredArchiveIds) {
  if (!characterIds.size) return [];
  try {
    const { listOfflineDateArchives } = await import('../offline-date-archive.js');
    const lists = await Promise.all(
      [...characterIds].map((characterId) =>
        listOfflineDateArchives(userId, { characterId }).catch(() => [])),
    );
    const seen = new Set();
    return lists.flatMap((list) => list).flatMap((archive) => {
      if (!archive?.id || seen.has(archive.id) || coveredArchiveIds.has(archive.id)) return [];
      seen.add(archive.id);
      const scope = selectArchiveAudienceScope(archive, [...characterIds]);
      if (characterIds.size > 1 && !scope.allInRoster) return [];
      const owned = scope.owned
        .map((entry) => clean(entry?.content))
        .filter(Boolean);
      const text = characterIds.size === 1
        ? (owned.join('；') || '一次线下见面已经结束并收纳。')
        : (scope.canUseSharedSummary ? clean(archive.summary) : '一次线下见面已经结束并收纳。');
      if (!text) return [];
      return [{
        id: `archive:${archive.id}`,
        timestamp: Number(archive.endedAt || archive.startedAt || 0),
        retrievalTimestamp: Number(archive.archivedAtReal || 0) || archiveIdCreatedAtReal(archive.id),
        text,
        source: 'offline_archive',
        // 完成的线下档案是重要历史，但“重要”不等于每轮常驻当前场景。
        importance: 'normal',
        chatIds: [String(archive.chatId || '')].filter(Boolean),
        // 卷宗 hooks 是叙事存档线索，不等于现实中的未完成任务或待兑现约定。
        // 若一律标成 unresolved，会让普通伏笔长期获得召回加权并被模型反复 callback。
        unresolved: false,
      }];
    });
  } catch (_) {
    return [];
  }
}

export async function buildUnifiedEventTimelineContext({
  chat = null,
  userId = '',
  characterIds = [],
  queryText = '',
  temporalQueryText = null,
  temporalOnly = false,
  now = Date.now(),
  recentHistoryMessageIds = [],
  recentHistoryStartTs = 0,
  recentHistoryEndTs = 0,
  budgetChars = DEFAULT_BUDGET_CHARS,
  maxEvents = null,
  semanticScore = lexicalTimelineSimilarity,
  semanticThreshold = 0,
  returnDetails = false,
  strictUserScope = false,
} = {}) {
  const finish = (text = '', selected = []) => (
    returnDetails ? { text, selected } : text
  );
  const uid = String(userId || '').trim();
  if (!uid || !chat?.id || isAnonymousChat(chat)) return finish();
  const ids = new Set(
    (Array.isArray(characterIds) ? characterIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  if (!ids.size) return finish();

  const worldUserIds = await listWorldUserIds(uid).catch(() => [uid]);
  const siblingUserIds = worldUserIds.filter((id) => id !== uid);

  const allChats = (await (strictUserScope
    ? db.getAllByIndex('chats', 'userId', uid)
    : db.getAllRecords('chats')).catch(() => []))
    .filter((row) => (strictUserScope
      ? String(row?.userId || '') === uid
      : (!row?.userId || String(row.userId) === uid)));
  const currentPrefs = await loadChatPrefs(chat.id).catch(() => ({}));
  const currentInjectionSettings = normalizeMemoryInjectionSettings(currentPrefs);
  const explicitSharedChatIds = new Set(currentInjectionSettings.explicitSharedChatIds);
  const effectiveMaxEvents = maxEvents !== null && maxEvents !== undefined && Number.isFinite(Number(maxEvents))
    ? Math.max(0, Number(maxEvents))
    : currentInjectionSettings.eventTimelineLimit;
  const chatById = new Map(
    (Array.isArray(allChats) ? allChats : [])
      .filter((row) => row?.id)
      .map((row) => [String(row.id), row]),
  );
  const currentAliasAccountIds = isStrangerInterceptChat(chat)
    ? [...new Set([...ids]
      .map((id) => String(chat?.metadata?.accountIdentityMap?.[`character:${id}`] || '').trim())
      .filter(Boolean))]
    : [];
  const identityAllowed = (row) => {
    if (!row || String(row.id) === String(chat.id) || !isStrangerInterceptChat(row)) return !!row;
    if (canStrangerChatShareMemory(row)) return true;
    return currentAliasAccountIds.some((currentAccountId) =>
      canStrangerChatShareMemory(row, { currentAccountId }));
  };
  const relatedChats = (Array.isArray(allChats) ? allChats : [])
    .filter((row) => row?.id && !isAnonymousChat(row) && identityAllowed(row) && (
      row.id === chat.id
      || (currentInjectionSettings.relatedMemoryEnabled && audienceCanReceiveSource({
        audienceCharacterIds: [...ids],
        sourceChat: row,
        currentChatId: chat.id,
        requireAll: true,
      }))
      || explicitSharedChatIds.has(String(row.id))
    ));
  const relatedChatIds = new Set(relatedChats.map((row) => String(row.id)));

  // memories 是最大的长文本表。过去每轮先 getAllRecords 再过滤，
  // Android 从后台恢复或记忆量较大时会把无关窗口正文也全部反序列化。
  const relevantChatIds = [...relatedChatIds];
  const [chatMemories, characterMemories, eventMemoriesByUser, worldEventMemories, sharedKnowledgeByUser] = await Promise.all([
    readRowsByIndex('memories', 'chatId', relevantChatIds),
    readRowsByIndex('memories', 'characterId', [...ids]),
    db.getAllByIndex('eventMemories', 'userId', uid).catch(() => []),
    readRowsByIndex('eventMemories', 'userId', siblingUserIds),
    db.getAllByIndex('sharedEventKnowledge', 'userId', uid).catch(() => []),
  ]);
  let memories = mergeRowsById([chatMemories, characterMemories]);
  let eventMemories = eventMemoriesByUser;
  let sharedKnowledge = sharedKnowledgeByUser;
  // 非严格调用仍兼容极老备份的缺索引记录。聊天主链使用 strictUserScope，
  // 缺少归属索引的记录本来就无法安全注入，不能在每次空结果时扫描整张长文本表。
  if (!strictUserScope && !memories.length) {
    memories = (await db.getAllRecords('memories').catch(() => []))
      .filter((row) => (strictUserScope
        ? String(row?.userId || '') === uid
        : (!row?.userId || String(row.userId) === uid)));
  }
  if (!strictUserScope && !eventMemories.length) {
    eventMemories = (await db.getAllRecords('eventMemories').catch(() => []))
      .filter((row) => (strictUserScope
        ? String(row?.userId || '') === uid
        : (!row?.userId || String(row.userId) === uid)));
  }
  const siblingPublicEvents = (Array.isArray(worldEventMemories) ? worldEventMemories : [])
    .filter((event) => ['public', 'spreading'].includes(String(event?.visibility || '').trim()))
    .map((event) => ({ ...event, __worldShared: true }));
  eventMemories = mergeRowsById([eventMemories, siblingPublicEvents]);
  if (!strictUserScope && !sharedKnowledge.length) {
    sharedKnowledge = (await db.getAllRecords('sharedEventKnowledge').catch(() => []))
      .filter((row) => (strictUserScope
        ? String(row?.userId || '') === uid
        : (!row?.userId || String(row.userId) === uid)));
  }
  // 只读取本轮候选来源的会话权限；旧实现会为所有聊天逐条读取 chatPrefs，
  // 即使绝大多数窗口与当前角色完全无关。
  const candidateSourceChatIds = new Set([
    ...relatedChatIds,
    ...memories.map((row) => String(row?.chatId || '').trim()),
    ...eventMemories.flatMap((row) => (
      Array.isArray(row?.involvedChats) ? row.involvedChats : []
    )).map((id) => String(id || '').trim()),
    ...sharedKnowledge.map((row) => String(row?.chatId || '').trim()),
  ].filter(Boolean));
  const sourcePermissions = new Map(await Promise.all([...candidateSourceChatIds]
    .filter((id) => {
      const row = chatById.get(id);
      return row?.id && !isAnonymousChat(row) && identityAllowed(row);
    })
    .map(async (id) => {
      if (id === String(chat.id)) return [id, true];
      const prefs = await loadChatPrefs(id).catch(() => ({}));
      return [id, normalizeMemoryInjectionSettings(prefs).allowAsCrossWindowSource];
    })));
  const sourceAllowed = (chatId = '') => {
    const id = String(chatId || '').trim();
    if (!id || id === String(chat.id)) return true;
    const sourceChat = chatById.get(id);
    return !!sourceChat && identityAllowed(sourceChat) && sourcePermissions.get(id) !== false;
  };
  const events = [];
  const coveredArchiveIds = new Set();

  for (const memory of selectTimelineMemoryRows(memories, [...ids])) {
    if (strictUserScope && String(memory?.userId || '') !== uid) continue;
    if (memory?.userId && String(memory.userId) !== uid) continue;
    const isSummary = String(memory.type || '') === 'summary';
    const compactionArchived = !!String(memory?.memoryCompactionArchivedBy || '').trim();
    if (memory?.vectorSupersededBy && !isSummary && !compactionArchived) continue;
    if (!isTimelineMemory(memory)) continue;
    const memoryChatId = String(memory.chatId || '').trim();
    if (!explicitSharedChatIds.has(memoryChatId) && !memoryVisibleToCharacters(memory, ids)) continue;
    if (memoryChatId && isAnonymousChat(chatById.get(memoryChatId))) continue;
    if (memoryChatId && !identityAllowed(chatById.get(memoryChatId))) continue;
    if (!sourceAllowed(memoryChatId)) continue;
    if (memoryChatId && !relatedChatIds.has(memoryChatId)
      && !(currentInjectionSettings.relatedMemoryEnabled && ids.has(String(memory.characterId || '')))) continue;
    const rawText = String(memory.content || '').trim();
    const semanticText = clean(rawText);
    if (!semanticText) continue;
    const archiveId = String(memory.offlineDateArchiveId || '').trim();
    if (archiveId) coveredArchiveIds.add(archiveId);
    const offlineArchivedAtReal = String(memory.source || '').trim() === 'offline_date'
      ? (Number(memory.archivedAtReal || 0) || archiveIdCreatedAtReal(archiveId))
      : 0;
    events.push({
      id: `memory:${memory.id}`,
      timestamp: Number(memory.summaryToTs || memory.timestamp || 0),
      retrievalTimestamp: offlineArchivedAtReal,
      text: isSummary ? rawText : semanticText,
      semanticText,
      source: memory.source,
      momentAuthorId: memory.momentAuthorId,
      audienceLabel: momentTimelineAudienceLabel(memory, [...ids]),
      importance: isHighImportance(memory.importance) ? 'high' : 'normal',
      chatIds: memoryChatId ? [memoryChatId] : [],
      unresolved: false,
      fullContextSummary: isSummary,
      archived: isSummary && memory.vectorArchived === true,
      compactionArchived,
      distilledMemory: memory.memoryCompacted === true,
      summaryFromTs: Number(memory.summaryFromTs || 0),
      summaryToTs: Number(memory.summaryToTs || 0),
      summaryMessageIds: Array.isArray(memory.summaryMessageIds)
        ? memory.summaryMessageIds
        : [],
    });
  }

  for (const event of (Array.isArray(eventMemories) ? eventMemories : [])) {
    const worldShared = event?.__worldShared === true;
    if (worldShared && !['public', 'spreading'].includes(String(event?.visibility || '').trim())) continue;
    if (strictUserScope && String(event?.userId || '') !== uid && !worldShared) continue;
    if (event?.userId && String(event.userId) !== uid && !worldShared) continue;
    const compactionArchived = !!String(event?.memoryCompactionArchivedBy || '').trim();
    if (event?.vectorSupersededBy && !compactionArchived) continue;
    if (!event?.summary) continue;
    const involvedChats = (Array.isArray(event.involvedChats) ? event.involvedChats : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    if (!worldShared && !involvedChats.some((id) => explicitSharedChatIds.has(id))
      && !eventVisibleToCharacters(event, ids, chatById)) continue;
    if (!worldShared && involvedChats.length && !involvedChats.some((id) => sourceAllowed(id))) continue;
    if (!worldShared && involvedChats.some((id) => isAnonymousChat(chatById.get(id)))) continue;
    if (!worldShared && involvedChats.some((id) => !identityAllowed(chatById.get(id)))) continue;
    if (!worldShared && involvedChats.length && !involvedChats.some((id) => relatedChatIds.has(id))) {
      const publicish = ['public', 'spreading'].includes(String(event.visibility || ''));
      if (!publicish) continue;
    }
    const pendingThreads = effectiveEventPendingThreads(event);
    const unresolved = effectiveEventTemporalState(event) === 'ongoing' && pendingThreads.length > 0;
    const relationshipSignal = (Array.isArray(event.relationChanges) && event.relationChanges.length > 0)
      || (Array.isArray(event.tags) && event.tags.some((tag) =>
        /关系|感情|心动|告白|争执|和好|信任|边界|承诺|吃醋/.test(String(tag || ''))));
    events.push({
      id: `event:${event.id}`,
      timestamp: Number(event.timestamp || 0),
      text: clean(event.summary),
      source: worldShared ? 'world_public_event' : 'event_memory',
      visibility: event.visibility,
      importance: relationshipSignal || Number(event.embarrassmentLevel || 0) >= 70 ? 'high' : 'normal',
      chatIds: involvedChats,
      unresolved,
      compactionArchived,
    });
  }

  for (const item of (Array.isArray(sharedKnowledge) ? sharedKnowledge : [])) {
    if (strictUserScope && String(item?.userId || '') !== uid) continue;
    if (item?.userId && String(item.userId) !== uid) continue;
    const explicitlyShared = explicitSharedChatIds.has(String(item.chatId || '').trim());
    if (!explicitlyShared
      && (!Array.isArray(item.characterIds) || ![...ids].every((id) =>
        item.characterIds.some((knownId) => String(knownId || '').trim() === id)))) continue;
    if (item.chatId && isAnonymousChat(chatById.get(String(item.chatId)))) continue;
    if (item.chatId && !identityAllowed(chatById.get(String(item.chatId)))) continue;
    if (!sourceAllowed(item.chatId)) continue;
    const text = clean(item.excerpt || item.summary);
    if (!text) continue;
    events.push({
      id: `shared:${item.id}`,
      timestamp: Number(item.timestamp || 0),
      text: [clean(item.note), text].filter(Boolean).join('；'),
      source: 'shared_event',
      importance: 'normal',
      chatIds: [String(item.chatId || '')].filter(Boolean),
      unresolved: false,
    });
  }

  const archiveFallbacks = await archiveFallbackEvents(uid, ids, coveredArchiveIds);
  events.push(...archiveFallbacks.filter((event) =>
    !(event.chatIds || []).length || event.chatIds.some((id) =>
      sourceAllowed(id) && (relatedChatIds.has(String(id)) || currentInjectionSettings.relatedMemoryEnabled))));
  for (const event of events) {
    event.decayCategory = classifyTimelineDecayCategory(event, { chatById, userId: uid });
    event.worldTimeConflict = ['offline_date', 'offline_archive'].includes(String(event.source || ''))
      && timelineRetrievalTimestamp(event) > 0
      && Number(event.timestamp || 0) > Number(now || Date.now());
  }
  const limitedCandidates = applyOfflineTimelineCandidateLimit(
    events,
    currentInjectionSettings.offlineMemoryLimit,
  );
  const selected = retrieveTimelineEvents(limitedCandidates.events, {
    now,
    queryText,
    temporalRange: parseTimelineTemporalRange(
      temporalQueryText === null ? queryText : temporalQueryText,
      now,
    ),
    temporalOnly,
    currentChatId: String(chat.id),
    recentHistoryMessageIds,
    recentHistoryStartTs,
    recentHistoryEndTs,
    budgetChars,
    maxEvents: effectiveMaxEvents,
    semanticScore,
    semanticThreshold,
    decaySettings: currentInjectionSettings,
    guaranteedEventIds: limitedCandidates.guaranteedEventIds,
    recentEventIds: currentPrefs.vectorRecentEventIds,
  });
  if (!selected.length) return finish();
  const selectedEventIds = selected.map((event) => String(event.id || '')).filter(Boolean);
  const selectedEventIdSet = new Set(selectedEventIds);
  const recentEventIds = [
    ...(Array.isArray(currentPrefs.vectorRecentEventIds) ? currentPrefs.vectorRecentEventIds : [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && !selectedEventIdSet.has(id)),
    ...selectedEventIds,
  ];
  patchChatPrefs(chat.id, {
    vectorRecentEventIds: [...new Set(recentEventIds)].slice(-48),
  }).catch(() => {});
  const text = [
    '=== 来源：记忆摘要与统一事件时间轴（按真实先后）===',
    currentInjectionSettings.memoryDecayEnabled
      ? `各类记忆在设置的常驻期内完整保留（与用户相关 ${currentInjectionSettings.memoryDecayCoreHours} 小时、群聊旁支 ${currentInjectionSettings.memoryDecayGroupHours} 小时、朋友圈/微博 ${currentInjectionSettings.memoryDecaySocialHours} 小时、论坛/外围动态 ${currentInjectionSettings.memoryDecayAmbientHours} 小时）；退出常驻期不代表遗忘或删除，用户再次提到相关人物、事情、关键词或日期时仍须召回。被精简替代的原记录不再常驻，只在向量语义命中时作为细节证据回来。其它事件也经过相关度与时间筛选。以下仅收录当前角色可知的内容，并按发生时间排列。它们是背景校准，不是本轮待聊话题：当前正在聊什么，必须以最近原始消息尤其是用户最新内容为准；即使这里标成“未完成”，普通问句、随口提议或已经被后续聊天越过的话题也不得突然补答、补演。只有仍有效的承诺、日程、冲突后果，或用户本轮重新提起的内容才可继续。除非用户本轮明确提到或正在承接后果，否则不要主动翻旧账。聊天摘要和向量命中都是有损线索，不是裁决记录：不得仅凭它们断言用户说过什么、判定用户动机或把冲突责任推给用户；用户正在纠正时先核对带稳定说话人的原文，原文不足就保留不确定性。若用户明确询问某段过去或某个日期，必须先查阅这里已有的剧情长卷与摘要并据此回答，不能在已有记录时笼统声称完全没有相关印象；资料确实不足时只说明缺少哪部分。若同时提供了带稳定说话人的历史原文，人物归属与“谁对谁做了什么”的方向以原文为准，摘要只能概括、不能把人称写反。已完成事件只承接后果，禁止重新演一遍。朋友圈标为“仅知情”时只代表看见过动态，绝不代表当前角色亲历。`
      : '剧情长卷、聊天摘要与用户确认过的精简记忆作为工作记忆保留；被精简替代的原记录不再常驻，只在向量语义命中时作为细节证据回来。其它事件也经过相关度与时间筛选。以下仅收录当前角色可知的内容，并按发生时间排列。它们是背景校准，不是本轮待聊话题：当前正在聊什么，必须以最近原始消息尤其是用户最新内容为准；即使这里标成“未完成”，普通问句、随口提议或已经被后续聊天越过的话题也不得突然补答、补演。只有仍有效的承诺、日程、冲突后果，或用户本轮重新提起的内容才可继续。除非用户本轮明确提到或正在承接后果，否则不要主动翻旧账。聊天摘要和向量命中都是有损线索，不是裁决记录：不得仅凭它们断言用户说过什么、判定用户动机或把冲突责任推给用户；用户正在纠正时先核对带稳定说话人的原文，原文不足就保留不确定性。若用户明确询问某段过去或某个日期，必须先查阅这里已有的剧情长卷与摘要并据此回答，不能在已有记录时笼统声称完全没有相关印象；资料确实不足时只说明缺少哪部分。若同时提供了带稳定说话人的历史原文，人物归属与“谁对谁做了什么”的方向以原文为准，摘要只能概括、不能把人称写反。已完成事件只承接后果，禁止重新演一遍。朋友圈标为“仅知情”时只代表看见过动态，绝不代表当前角色亲历。',
    '时间边界：标为“过去存档”的条目是历史事实，不得仅因动作、情绪或台词相似就把它认成今天，或用它覆盖最近原始消息；若最近原始消息明确说明正在承接同一件事，则可以延续其后果，跨过零点本身不代表场景或关系中断。',
    ...selected.map((event) => {
      const staleUnresolved = event.unresolved && !isTimestampToday(event.timestamp, now);
      const status = event.unresolved
        ? (staleUnresolved ? '旧记录留有待续/非今日待办' : '未完成')
        : '已发生';
      const audience = event.audienceLabel ? `/${event.audienceLabel}` : '';
      const pastDayLabel = timelinePastDayLabel(event.timestamp, now);
      const timeLabel = event.worldTimeConflict
        ? `${timelineDateLabel(timelineRetrievalTimestamp(event))} 收纳（旧剧情钟点已回拨）`
        : `${timelineDateLabel(event.timestamp)}${pastDayLabel ? `（${pastDayLabel}）` : ''}`;
      const relativeDateGuard = timelineRelativeDateGuard(event, now);
      return `- [${timeLabel}][${sourceLabel(event.source)}/${status}${audience}] ${event.text}${relativeDateGuard ? `（时间校准：${relativeDateGuard}）` : ''}`;
    }),
  ].join('\n');
  return finish(text, selected);
}
