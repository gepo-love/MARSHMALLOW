import * as db from '../db.js';
import { isPrivateForumVestAuthor, isUserAuthoredForumThread } from '../forum-identity.js';

const MAX_SEEN_EVENTS = 1200;

function clean(value = '', max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function relationshipKey(userId = '') {
  return `forumRelationships_${clean(userId) || 'guest'}`;
}

function normalizeRecord(raw = {}, actorId = '') {
  const score = Math.max(0, Math.min(100, Number(raw.score) || 0));
  return {
    actorId: clean(raw.actorId || actorId, 180),
    displayName: clean(raw.displayName, 80),
    score,
    userReplies: Math.max(0, Number(raw.userReplies) || 0),
    actorReplies: Math.max(0, Number(raw.actorReplies) || 0),
    privateOpened: raw.privateOpened === true,
    followed: raw.followed === true,
    firstMetAt: Number(raw.firstMetAt) || 0,
    lastInteractionAt: Number(raw.lastInteractionAt) || 0,
  };
}

function normalizeLedger(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const records = {};
  for (const [actorId, row] of Object.entries(value.records || {})) {
    const record = normalizeRecord(row, actorId);
    if (record.actorId) records[record.actorId] = record;
  }
  return {
    records,
    seenEvents: Array.isArray(value.seenEvents)
      ? value.seenEvents.map((item) => clean(item, 360)).filter(Boolean).slice(-MAX_SEEN_EVENTS)
      : [],
    updatedAt: Number(value.updatedAt) || 0,
  };
}

async function loadLedger(userId = '') {
  const row = await db.get('settings', relationshipKey(userId)).catch(() => null);
  return normalizeLedger(row?.value || {});
}

async function saveLedger(userId = '', ledger = {}) {
  const value = normalizeLedger({ ...ledger, updatedAt: Date.now() });
  await db.put('settings', { key: relationshipKey(userId), value });
  return value;
}

export function forumRelationshipStage(score = 0) {
  const value = Number(score) || 0;
  if (value >= 40) return { id: 'close', label: '很熟的网友' };
  if (value >= 20) return { id: 'regular', label: '常来常往' };
  if (value >= 8) return { id: 'familiar', label: '有点眼熟' };
  return { id: 'stranger', label: '刚刚认识' };
}

function applyEvent(ledger, {
  actorId = '',
  displayName = '',
  eventKey = '',
  kind = 'actor_reply',
  timestamp = Date.now(),
  active = true,
} = {}) {
  const aid = clean(actorId, 180);
  const key = clean(eventKey, 360);
  if (!aid || !key) return false;
  const seen = new Set(ledger.seenEvents);
  const existing = normalizeRecord(ledger.records[aid], aid);
  if (kind === 'follow') {
    existing.followed = active === true;
    if (seen.has(key)) {
      ledger.records[aid] = existing;
      return true;
    }
  } else if (seen.has(key)) {
    return false;
  }
  const points = kind === 'user_reply' ? 4 : kind === 'private_open' ? 8 : kind === 'follow' ? 5 : 2;
  existing.displayName = clean(displayName, 80) || existing.displayName;
  existing.score = Math.min(100, existing.score + points);
  if (kind === 'user_reply') existing.userReplies += 1;
  if (kind === 'actor_reply') existing.actorReplies += 1;
  if (kind === 'private_open') existing.privateOpened = true;
  existing.firstMetAt = existing.firstMetAt || Number(timestamp) || Date.now();
  existing.lastInteractionAt = Math.max(existing.lastInteractionAt, Number(timestamp) || Date.now());
  ledger.records[aid] = existing;
  ledger.seenEvents.push(key);
  ledger.seenEvents = ledger.seenEvents.slice(-MAX_SEEN_EVENTS);
  return true;
}

export async function recordForumRelationshipEvent(userId = '', event = {}) {
  const ledger = await loadLedger(userId);
  const changed = applyEvent(ledger, event);
  return changed ? saveLedger(userId, ledger) : ledger;
}

export async function getForumRelationship(userId = '', actorId = '') {
  const ledger = await loadLedger(userId);
  const record = normalizeRecord(ledger.records[clean(actorId, 180)], actorId);
  return { ...record, stage: forumRelationshipStage(record.score) };
}

function actorIdOf(row = {}) {
  return clean(row.forumActorId || row.authorRoleId, 180);
}

function actorNameOf(row = {}) {
  return clean(row.author || row.authorName || row.authorAlias, 80) || '论坛网友';
}

function rowEventKey(thread = {}, row = {}, direction = '') {
  return [
    direction,
    clean(thread.id, 180),
    Number(row.timestamp || thread.timestamp || 0) || 0,
    actorIdOf(row),
    clean(row.content, 120),
  ].join('::');
}

/** 从已落库帖子同步公开互回关系；seenEvents 保证刷新与轮询不会重复加分。 */
export async function syncForumRelationshipsFromThreads({ userId = '', user = {}, threads = [], userNames = [] } = {}) {
  const uid = clean(userId, 160);
  if (!uid) return { changed: 0 };
  const ledger = await loadLedger(uid);
  const names = new Set((Array.isArray(userNames) ? userNames : [])
    .concat([user?.name, user?.nickname, user?.customNickname, user?.displayName])
    .map((value) => clean(value, 80)).filter(Boolean));
  let changed = 0;
  for (const thread of Array.isArray(threads) ? threads : []) {
    const threadIsUser = isUserAuthoredForumThread(thread, user)
      && !isPrivateForumVestAuthor(thread, user);
    const threadActorId = actorIdOf(thread);
    const walk = (rows = [], parent = null) => {
      for (const row of Array.isArray(rows) ? rows : []) {
        const rowIsUser = isUserAuthoredForumThread(row, user)
          && !isPrivateForumVestAuthor(row, user);
        const rowActorId = actorIdOf(row);
        const parentIsUser = parent
          ? isUserAuthoredForumThread(parent, user) && !isPrivateForumVestAuthor(parent, user)
          : threadIsUser;
        const parentActorId = parent ? actorIdOf(parent) : threadActorId;
        const targetsUser = names.has(clean(row.replyToAuthor, 80));
        if (!rowIsUser && rowActorId && (threadIsUser || parentIsUser || targetsUser)) {
          if (applyEvent(ledger, {
            actorId: rowActorId,
            displayName: actorNameOf(row),
            eventKey: rowEventKey(thread, row, 'actor_reply'),
            kind: 'actor_reply',
            timestamp: row.timestamp || thread.timestamp,
          })) changed += 1;
        }
        if (rowIsUser && parentActorId) {
          if (applyEvent(ledger, {
            actorId: parentActorId,
            displayName: actorNameOf(parent || thread),
            eventKey: rowEventKey(thread, { ...row, forumActorId: parentActorId }, 'user_reply'),
            kind: 'user_reply',
            timestamp: row.timestamp || thread.timestamp,
          })) changed += 1;
        }
        walk(row.childReplies, row);
      }
    };
    walk(thread.replies, null);
  }
  if (changed) await saveLedger(uid, ledger);
  return { changed };
}

export async function buildForumRelationshipPromptBlock(userId = '') {
  const ledger = await loadLedger(userId);
  const rows = Object.values(ledger.records)
    .filter((record) => record.actorId && record.score > 0)
    .sort((a, b) => b.score - a.score || b.lastInteractionAt - a.lastInteractionAt)
    .slice(0, 24)
    .map((record) => {
      const stage = forumRelationshipStage(record.score);
      return `- actorId=${record.actorId}；论坛名=${record.displayName || '未记录'}；关系=${stage.label}；用户回过TA ${record.userReplies} 次；TA回过用户 ${record.actorReplies} 次${record.privateOpened ? '；已私聊' : ''}${record.followed ? '；已关注' : ''}`;
    });
  if (!rows.length) return '';
  return [
    '【论坛关系进度】',
    '仅对应 actorId 的本人可以使用自己的关系进度。熟悉后可以更自然地认出用户论坛昵称、接续旧话题或在私聊里放松，但不能跳过尚未发生的相认与身份揭示。',
    rows.join('\n'),
  ].join('\n');
}
