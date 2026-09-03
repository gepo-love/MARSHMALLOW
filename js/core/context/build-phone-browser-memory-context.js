import { loadCharacterPhone } from '../character-phone-store.js';

const MAX_RECORDS_PER_CHARACTER = 4;
const MIN_RELEVANCE_SCORE = 4;
const CHAT_GROUNDED_BROWSER_SOURCES = new Set([
  'sharePostSearch',
  'webLinkShareSearch',
]);
const GENERIC_TERMS = new Set([
  '还是', '这个', '那个', '什么', '怎么', '可以', '觉得', '一下',
  '最近', '今天', '明天', '自己', '比较', '的话', '东西', '时候',
]);

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function collectMatchTerms(value = '') {
  const text = clean(value).toLowerCase();
  const terms = new Set();
  for (const token of text.match(/[a-z0-9][a-z0-9._+-]{1,}/g) || []) {
    if (!GENERIC_TERMS.has(token)) terms.add(token);
  }
  for (const run of text.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (run.length <= 4 && !GENERIC_TERMS.has(run)) terms.add(run);
    for (let i = 0; i < run.length - 1; i += 1) {
      const pair = run.slice(i, i + 2);
      if (!GENERIC_TERMS.has(pair)) terms.add(pair);
    }
  }
  return terms;
}

function fieldMatchScore(queryTerms, value, weight) {
  if (!queryTerms.size || !value) return 0;
  const fieldTerms = collectMatchTerms(value);
  let hits = 0;
  for (const term of queryTerms) {
    if (fieldTerms.has(term)) hits += 1;
  }
  return Math.min(hits, 3) * weight;
}

function relevanceScore(record = {}, queryTerms = new Set()) {
  const identity = [
    record.query,
    record.title,
    ...(Array.isArray(record.tags) ? record.tags : []),
  ].filter(Boolean).join(' ');
  return fieldMatchScore(queryTerms, record.aiJudgement, 6)
    + fieldMatchScore(queryTerms, identity, 4)
    + fieldMatchScore(queryTerms, record.summary, 3)
    + fieldMatchScore(queryTerms, record.body, 2)
    + (record.favorite === true ? 1 : 0);
}

export function canUsePhoneBrowserRecordInChat(record = {}) {
  const source = clean(record?.source);
  if (CHAT_GROUNDED_BROWSER_SOURCES.has(source)) return true;
  // 旧版未保存 producer source；精搜分享记录仍有明确的分享状态，可安全识别。
  if (record?.shareStatus === 'pending' || record?.shareStatus === 'shared') return true;
  return false;
}

export function selectRelevantPhoneBrowserRecords(records = [], recentText = '', limit = MAX_RECORDS_PER_CHARACTER) {
  const queryTerms = collectMatchTerms(recentText);
  if (!queryTerms.size) return [];
  return (Array.isArray(records) ? records : [])
    .filter(canUsePhoneBrowserRecordInChat)
    .map((record) => ({
      record,
      score: relevanceScore(record, queryTerms),
      timestamp: Number(record?.visitedAt || record?.createdAt || 0) || 0,
    }))
    .filter((item) => item.record && item.score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
    .slice(0, Math.max(0, Number(limit) || MAX_RECORDS_PER_CHARACTER))
    .map((item) => item.record);
}

function formatRecord(record = {}) {
  const heading = clean(record.title || record.query || '浏览记录');
  const details = [
    record.query ? `搜索：${clean(record.query)}` : '',
    record.summary ? `看到：${clean(record.summary).slice(0, 180)}` : '',
    record.aiJudgement ? `TA 当时自己的判断：${clean(record.aiJudgement).slice(0, 220)}` : '',
  ].filter(Boolean);
  return `- ${heading}${details.length ? `｜${details.join('｜')}` : ''}`;
}

export async function buildPhoneBrowserMemoryContextBlock({
  userId = '',
  partnerIds = [],
  characters = {},
  recentText = '',
} = {}) {
  const uid = clean(userId);
  if (!uid || !Array.isArray(partnerIds) || !partnerIds.length || !clean(recentText)) return '';
  const sections = [];
  for (const id of partnerIds.slice(0, 4)) {
    const phone = await loadCharacterPhone(uid, id).catch(() => null);
    const records = selectRelevantPhoneBrowserRecords(phone?.browserRecords, recentText);
    if (!records.length) continue;
    const name = clean(characters[id]?.realName || characters[id]?.name || id);
    sections.push(`${name}（id=${id}）自己浏览过、且与当前话题直接相关的记录：\n${records.map(formatRecord).join('\n')}`);
  }
  if (!sections.length) return '';
  return [
    '【TA 自己的相关浏览判断】',
    sections.join('\n\n'),
    '这些是角色通过精搜分享链路实际看过并形成过的判断，只能用于回答相关选择、偏好或看法。它们不是当前地点、行程、正在做的事或实时状态，绝对不能据此改写 status/state；若当前聊天、当前有效状态、线下同行、明确记忆或角色设定有更新，以更新的信息为准。',
  ].join('\n');
}
