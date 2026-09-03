import * as db from '../db.js';
import { recordForumRelationshipEvent } from './forum-relationships.js';

const MAX_THREAD_SIGNALS = 240;
const MAX_FOLLOWED_ACTORS = 120;

function clean(value = '', max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function engagementKey(userId = '') {
  return `forumEngagement_${clean(userId) || 'guest'}`;
}

function normalizeThreadSignals(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    threadId: clean(row?.threadId || row?.id, 180),
    title: clean(row?.title, 120),
    sectionId: clean(row?.sectionId, 120),
    authorName: clean(row?.authorName || row?.author, 80),
    updatedAt: Number(row?.updatedAt) || 0,
  })).filter((row) => row.threadId).slice(-MAX_THREAD_SIGNALS);
}

function normalizeActorSignals(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    actorId: clean(row?.actorId || row?.id, 180),
    displayName: clean(row?.displayName || row?.name, 80),
    followedAt: Number(row?.followedAt) || 0,
  })).filter((row) => row.actorId).slice(-MAX_FOLLOWED_ACTORS);
}

function normalizeState(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    likedThreads: normalizeThreadSignals(value.likedThreads),
    favoriteThreads: normalizeThreadSignals(value.favoriteThreads),
    followedActors: normalizeActorSignals(value.followedActors),
    updatedAt: Number(value.updatedAt) || 0,
  };
}

export async function loadForumEngagement(userId = '') {
  const row = await db.get('settings', engagementKey(userId)).catch(() => null);
  return normalizeState(row?.value || {});
}

async function saveForumEngagement(userId = '', state = {}) {
  const value = normalizeState({ ...state, updatedAt: Date.now() });
  await db.put('settings', { key: engagementKey(userId), value });
  return value;
}

function threadSnapshot(thread = {}) {
  return {
    threadId: clean(thread.id, 180),
    title: clean(thread.title, 120),
    sectionId: clean(thread.sectionId, 120),
    authorName: clean(thread.authorName || thread.author, 80),
    updatedAt: Date.now(),
  };
}

export async function toggleForumThreadEngagement(userId = '', thread = {}, kind = 'like') {
  const field = kind === 'favorite' ? 'favoriteThreads' : 'likedThreads';
  const state = await loadForumEngagement(userId);
  const id = clean(thread?.id, 180);
  if (!id) throw new Error('缺少帖子');
  const index = state[field].findIndex((row) => row.threadId === id);
  const active = index < 0;
  if (active) state[field].push(threadSnapshot(thread));
  else state[field].splice(index, 1);
  const saved = await saveForumEngagement(userId, state);
  return { active, state: saved };
}

export async function toggleForumActorFollow(userId = '', actor = {}) {
  const state = await loadForumEngagement(userId);
  const actorId = clean(actor?.actorId || actor?.id, 180);
  if (!actorId) throw new Error('缺少论坛身份');
  const index = state.followedActors.findIndex((row) => row.actorId === actorId);
  const active = index < 0;
  if (active) {
    state.followedActors.push({
      actorId,
      displayName: clean(actor?.displayName || actor?.name, 80),
      followedAt: Date.now(),
    });
  } else {
    state.followedActors.splice(index, 1);
  }
  const saved = await saveForumEngagement(userId, state);
  await recordForumRelationshipEvent(userId, {
    actorId,
    displayName: clean(actor?.displayName || actor?.name, 80),
    eventKey: `follow:${actorId}`,
    kind: 'follow',
    active,
    timestamp: Date.now(),
  });
  return { active, state: saved };
}

export async function buildForumEngagementPromptBlock(userId = '') {
  const state = await loadForumEngagement(userId);
  const parts = [];
  if (state.followedActors.length) {
    parts.push(`关注的论坛号：${state.followedActors.slice(-20).map((row) => `${row.displayName || row.actorId}(actorId=${row.actorId})`).join('、')}`);
  }
  if (state.likedThreads.length) {
    parts.push(`最近点赞：${state.likedThreads.slice(-16).map((row) => `《${row.title || row.threadId}》`).join('、')}`);
  }
  if (state.favoriteThreads.length) {
    parts.push(`最近收藏：${state.favoriteThreads.slice(-16).map((row) => `《${row.title || row.threadId}》`).join('、')}`);
  }
  if (!parts.length) return '';
  return [
    '【用户论坛互动偏好】',
    ...parts,
    '这些行为只代表兴趣和关系倾向：后续可适度增加相关人物或话题的自然回归，但不要每次都迎合，也不要声称其他网友看见了用户的私密收藏。',
  ].join('\n');
}
