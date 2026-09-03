import { get as dbGet, put as dbPut } from './db.js';
import { ensurePrivateChat } from './chat-store.js';
import { getCharacter } from './character-store.js';
import {
  dateKeyFromTimestamp,
  getDailyLifePlanForDate,
  isPlanBlockActiveAt,
  pickCurrentPlanBlock,
  pruneExpiredCharacterPhoneSchedules,
} from './character-phone-store.js';
import { getNowForUser } from './time-mode.js';
import { normalizeLocationProfile, getBaseLocationAnchor, describeLocationAnchor } from './location-profile.js';
import { loadAmapConfig, amapExploreFromSeed } from './amap-tools.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function genId(prefix = 'activity') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sessionsKey(userId) {
  return `activitySessions_${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function inferModuleId(text = '') {
  const s = String(text || '');
  if (/饭|餐|吃|咖啡|奶茶|甜品|夜宵|火锅|烧烤/u.test(s)) return 'food';
  if (/书|阅读|图书馆|书店/u.test(s)) return 'reading';
  if (/电影|剧|展|演出|游戏|打机|追番/u.test(s)) return 'screen_media';
  if (/健身|跑步|散步|运动|球|瑜伽/u.test(s)) return 'fitness';
  if (/学习|自习|上课|写作|工作/u.test(s)) return 'study';
  if (/旅行|车站|机场|出差|远门/u.test(s)) return 'travel';
  return 'local_explore';
}

function destinationText(block = {}, profile = {}) {
  const route = block.routeHint && typeof block.routeHint === 'object' ? block.routeHint : {};
  return clean(
    route.destination
    || block.placeName
    || block.anchor
    || block.activity
    || describeLocationAnchor(getBaseLocationAnchor(profile))
    || profile.region
    || profile.city?.name
    || '附近',
    120,
  );
}

function fallbackRoutePlan({ profile, block, destination }) {
  const base = getBaseLocationAnchor(profile);
  const route = block.routeHint && typeof block.routeHint === 'object' ? block.routeHint : {};
  const origin = clean(route.origin || '', 80) || describeLocationAnchor(base) || profile.region || profile.city?.name || '当前位置';
  const dest = destination || destinationText(block, profile);
  const waypoints = asArray(route.waypoints).map((w) => ({
    label: clean(w?.label || w?.name || '', 80),
    kind: clean(w?.kind || 'via', 24),
    location: w?.location || null,
  })).filter((w) => w.label).slice(0, 8);
  return {
    source: 'text_fallback',
    mode: 'text',
    origin,
    destination: dest,
    waypoints: [
      { label: origin, kind: base?.kind || 'origin', location: base?.location || null },
      ...waypoints,
      { label: dest, kind: 'destination', location: null },
    ],
    summary: `${origin} → ${dest}`,
    distanceText: clean(route.distanceText || '', 40),
    durationText: clean(route.durationText || '', 40) || '按当天节奏自然估算',
    map: null,
  };
}

async function buildRoutePlan({ character, block }) {
  const profile = normalizeLocationProfile(character);
  const destination = destinationText(block, profile);
  const fallback = fallbackRoutePlan({ profile, block, destination });
  const cfg = await loadAmapConfig().catch(() => null);
  if (!cfg?.enabled || !cfg?.apiKey || profile.mapEnabled === false) return fallback;

  const query = clean([
    block.placeName,
    block.routeHint?.destination,
    block.anchor,
    destination,
    getBaseLocationAnchor(profile)?.query,
  ].filter(Boolean).join(' '), 80);
  if (!query) return fallback;

  const city = clean(profile.city?.name || '', 40);
  const explored = await amapExploreFromSeed({
    keywords: query,
    city,
    maxResults: 6,
  }).catch(() => null);
  const anchor = explored?.anchor || explored?.pois?.[0] || null;
  if (!anchor) return fallback;
  return {
    ...fallback,
    source: 'amap_explore',
    mode: 'poi',
    destination: anchor.name || fallback.destination,
    waypoints: [
      fallback.waypoints[0],
      {
        label: anchor.name || fallback.destination,
        kind: 'destination',
        location: anchor.location || null,
        address: anchor.address || '',
      },
    ],
    summary: `${fallback.origin} → ${anchor.name || fallback.destination}`,
    map: {
      source: explored.source || 'amap',
      query,
      city,
      center: explored.center || anchor.location || '',
      anchor,
      pois: asArray(explored.pois).slice(0, 8),
      groups: explored.groups || {},
    },
  };
}

/** 可继续的未完成探索（planned 且未过期） */
export function findResumableActivitySession(sessions = [], characterId = '', now = Date.now()) {
  const cid = String(characterId || '').trim();
  if (!cid) return null;
  return (sessions || []).find((session) => {
    if (!(session?.characterIds || []).includes(cid)) return false;
    const st = getEffectiveActivityStatus(session, now);
    return st === 'planned';
  }) || null;
}

export async function listActivitySessions(userId) {
  const row = await dbGet('settings', sessionsKey(userId));
  return asArray(row?.value?.sessions || row?.value)
    .filter(Boolean)
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
}

/** 未完成的探索卡是否已过期（仅 planned/active 需判定） */
export function isActivitySessionExpired(session = {}, now = Date.now()) {
  const status = String(session.status || 'planned').trim();
  if (status === 'done' || status === 'cancelled') return false;
  const ts = Number(now) || Date.now();
  const expectedEnd = Number(session.expectedEndAt || 0) || 0;
  if (expectedEnd > 0 && ts > expectedEnd + 5 * 60 * 1000) return true;
  const startAt = Number(session.startAt || session.createdAt || 0) || 0;
  if (startAt > 0 && ts - startAt > 24 * 60 * 60 * 1000) return true;
  return false;
}

export function getEffectiveActivityStatus(session = {}, now = Date.now()) {
  const status = String(session.status || 'planned').trim();
  if ((status === 'planned' || status === 'active') && isActivitySessionExpired(session, now)) return 'expired';
  return status;
}

/** 打开他的手机时把过期探索卡落库为 cancelled，避免一直显示待探索 */
export async function reconcileExpiredActivitySessions(userId, now = Date.now()) {
  const uid = String(userId || '').trim();
  if (!uid) return { updated: 0 };
  const list = await listActivitySessions(uid);
  let updated = 0;
  for (const session of list) {
    const status = String(session.status || 'planned').trim();
    if (status !== 'planned' && status !== 'active') continue;
    if (!isActivitySessionExpired(session, now)) continue;
    await saveActivitySession(uid, {
      ...session,
      status: 'cancelled',
      currentStep: 'expired',
      cancelReason: 'expired',
      expiredAt: now,
    });
    updated += 1;
  }
  return { updated };
}

export async function saveActivitySession(userId, session) {
  const list = await listActivitySessions(userId);
  const next = [
    { ...session, updatedAt: Date.now() },
    ...list.filter((item) => item?.id !== session?.id),
  ].slice(0, 80);
  await dbPut('settings', { key: sessionsKey(userId), value: { sessions: next } });
  return next[0];
}

export async function getActivitySession(userId, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const list = await listActivitySessions(userId);
  return list.find((item) => item?.id === id) || null;
}

export function buildOfflineSceneFromActivitySession(session = {}) {
  const route = session.routePlan || {};
  const destination = route.destination || session.title || '';
  return {
    place: clean(destination, 60),
    weather: '',
    companions: clean(session.characterNames?.join('、') || '', 60),
    goal: clean(session.motivation || session.title || route.summary || '', 80),
    tone: '日常探索',
    perspective: 'user',
    person: 'second',
    wordMin: 200,
    wordMax: 500,
    rounds: 6,
  };
}

export async function createActivitySessionFromCurrentBlock({ user, userId, characterId } = {}) {
  const uid = String(userId || user?.id || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) throw new Error('缺少用户或角色');
  const character = await getCharacter(cid);
  if (!character) throw new Error('角色不存在');
  const now = await getNowForUser(uid);
  const dateKey = dateKeyFromTimestamp(now);
  const phone = (await pruneExpiredCharacterPhoneSchedules(uid, cid, dateKey)).phone;
  const plan = getDailyLifePlanForDate(phone, dateKey);
  const block = pickCurrentPlanBlock(plan, now);
  if (!isPlanBlockActiveAt(block, now)) throw new Error('还没有可发起的当前时段');
  const chat = await ensurePrivateChat(uid, cid, character.customNickname || character.name || '');
  const text = [block.activity, block.placeName, block.anchor, block.narrative].filter(Boolean).join(' ');
  const routePlan = await buildRoutePlan({ character, block });
  const title = clean(block.activity || routePlan.destination || '一起走走', 48);
  const session = await saveActivitySession(uid, {
    id: genId(),
    userId: uid,
    characterIds: [cid],
    characterNames: [character.customNickname || character.name || cid],
    moduleId: inferModuleId(text),
    status: 'planned',
    title,
    motivation: clean(block.shareCandidates?.[0] || block.narrative || block.activity || '', 160),
    startAt: now,
    expectedEndAt: now + 90 * 60 * 1000,
    currentStep: 'planned',
    routePlan,
    checkpoints: [],
    outputs: [],
    detailCards: [],
    sourceScheduleBlockId: block.id || '',
    itineraryChainId: '',
    nextScheduleHint: '',
    activityGroupChatId: chat.id,
    visibility: 'private',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return { session, chat, character, block, plan };
}
