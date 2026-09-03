import { loadMailbox } from '../mailbox-store.js';
import { rankLexicalPassages } from '../memory/vector-passages.js';

const RECENT_MAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_THREAD_LIMIT = 3;
const SEARCH_MAIL_LIMIT = 160;

function clean(value = '', max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function mailActorIds(mail = {}) {
  return new Set([
    mail.characterId,
    mail.from?.actorId,
    ...(Array.isArray(mail.to) ? mail.to.map((party) => party?.actorId) : []),
  ].map((value) => String(value || '').trim()).filter(Boolean));
}

function formatMailTime(timestamp = 0, timeZone = '') {
  const value = Number(timestamp || 0);
  if (!Number.isFinite(value) || value <= 0) return '时间未知';
  return new Date(value).toLocaleString('zh-CN', {
    ...(timeZone ? { timeZone } : {}),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function mailDirectionLabel(mail = {}) {
  return mail.direction === 'outbound' ? '用户写给你' : '你写给用户';
}

function mailPassageSource(mail = {}) {
  const body = String(mail.body || '').trim();
  const translation = String(mail.bodyTranslation || '').trim();
  return {
    id: `mailbox:${String(mail.id || '').trim()}`,
    threadId: String(mail.threadId || mail.id || '').trim(),
    type: 'mailbox_original',
    timestamp: Number(mail.timestamp || 0) || 0,
    content: [
      `邮件《${clean(mail.subject, 180) || '无主题'}》（${mailDirectionLabel(mail)}）`,
      body,
      translation && translation !== body ? `中文译文：${translation}` : '',
    ].filter(Boolean).join('\n'),
  };
}

function groupMailThreads(messages = []) {
  const groups = new Map();
  for (const mail of messages) {
    const threadId = String(mail.threadId || mail.id || '').trim();
    if (!threadId) continue;
    if (!groups.has(threadId)) groups.set(threadId, []);
    groups.get(threadId).push(mail);
  }
  return [...groups.entries()].map(([threadId, rows]) => ({
    threadId,
    rows: rows.slice().sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0)),
    latest: rows.slice().sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0))[0],
  })).sort((left, right) => Number(right.latest?.timestamp || 0) - Number(left.latest?.timestamp || 0));
}

function formatRecentThread(thread = {}, timeZone = '') {
  const latest = thread.latest || {};
  const exchanges = (Array.isArray(thread.rows) ? thread.rows : [])
    .slice(-3)
    .map((mail) => `${mailDirectionLabel(mail)}：${clean(mail.preview || mail.body, 150) || '（无正文）'}`)
    .join('；');
  return `- ${formatMailTime(latest.timestamp, timeZone)}｜《${clean(latest.subject, 100) || '无主题'}》｜${thread.rows.length} 封往来：${exchanges}`;
}

/**
 * 邮箱与私聊的跨入口连续性：近期只放主题与预览，长正文只在本轮用户文字
 * 有明确词面命中时截取相关选段。邮件内容不因“进入上下文”自动变成当前话题。
 */
export function buildMailboxChatContextBlock({
  mailbox = null,
  characterId = '',
  queryText = '',
  now = Date.now(),
  timeZone = '',
} = {}) {
  const actorId = String(characterId || '').trim();
  if (!actorId) return '';
  const related = (Array.isArray(mailbox?.messages) ? mailbox.messages : [])
    .filter((mail) => (
      mail
      && !mail.deleted
      && mailActorIds(mail).has(actorId)
      && Number(mail.timestamp || 0) > 0
    ))
    .sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0));
  if (!related.length) return '';

  const current = Number(now || Date.now()) || Date.now();
  const threads = groupMailThreads(related);
  const recent = threads
    .filter((thread) => current - Number(thread.latest?.timestamp || 0) <= RECENT_MAIL_WINDOW_MS)
    .slice(0, RECENT_THREAD_LIMIT);
  const rankedHits = clean(queryText, 5000)
    ? rankLexicalPassages(
      queryText,
      related.slice(0, SEARCH_MAIL_LIMIT).map(mailPassageSource),
      { limit: 8, budgetChars: 6000, maxItemChars: 950, minScore: 1.25 },
    )
    : [];
  const hitThreadIds = new Set();
  const hits = [];
  let hitChars = 0;
  for (const row of rankedHits) {
    const threadId = String(row.threadId || row.id || '').trim();
    const excerpt = String(row.excerpt || row.content || '').trim();
    if (!threadId || hitThreadIds.has(threadId) || !excerpt || hitChars + excerpt.length > 1900) continue;
    hitThreadIds.add(threadId);
    hits.push(row);
    hitChars += excerpt.length;
    if (hits.length >= 2) break;
  }
  if (!recent.length && !hits.length) return '';

  return [
    '【应用内邮件往来 · 当前角色私有记忆】',
    recent.length ? '近期往来摘要：' : '',
    ...recent.map((thread) => formatRecentThread(thread, timeZone)),
    hits.length ? '本轮关键词命中的邮件原文选段：' : '',
    ...hits.map((row) => `- ${String(row.excerpt || row.content || '').trim()}`),
    '以上邮件是你与用户已经发生的私有往来，可用于保持语气、约定与细节连续。它们不是本轮待办或必聊话题；用户没有提及时不要主动复述邮件。不得将其它角色的邮件泄露到当前私聊。',
  ].filter(Boolean).join('\n');
}

export async function buildMailboxContextForChat(options = {}) {
  const userId = String(options.userId || '').trim();
  if (!userId) return '';
  const mailbox = await loadMailbox(userId).catch(() => null);
  return buildMailboxChatContextBlock({ ...options, mailbox });
}
