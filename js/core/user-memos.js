/**
 * 日程备忘：用户与角色共用的时间备忘存储。
 * - 用户备忘：让 AI 知道用户接下来有什么安排（仅注入语境，不触发消息）。
 * - 角色备忘：AI 在聊天里通过 memo 事件登记，到点由后台调度触发一次定时对话。
 */
import * as db from './db.js';
import { listCharacters } from './character-store.js';
import { getNowForUser, getUserTimezone } from './time-mode.js';
import {
  dateKeyInUserTimezone,
  getZonedDateParts,
  timestampFromUserWallTime,
  zonedDateProxy,
} from './user-timezone.js';

const MEMO_KEY = (userId) => `userMemos_${String(userId || '').trim()}`;
const MAX_MEMOS = 200;
const PRUNE_AGE_MS = 60 * 86400000; // 过期 60 天后自动清理

export const MEMO_SOURCE_USER = 'user';
export const MEMO_SOURCE_CHARACTER = 'character';

function genMemoId() {
  return `memo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clean(value = '', max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeMemo(raw = {}) {
  const ts = Number(raw.ts || 0);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const title = clean(raw.title, 80);
  if (!title) return null;
  const source = raw.source === MEMO_SOURCE_CHARACTER ? MEMO_SOURCE_CHARACTER : MEMO_SOURCE_USER;
  return {
    id: clean(raw.id, 60) || genMemoId(),
    ts,
    title,
    note: clean(raw.note, 160),
    source,
    characterId: clean(raw.characterId, 60),
    chatId: clean(raw.chatId, 60),
    remind: source === MEMO_SOURCE_CHARACTER ? raw.remind !== false : false,
    createdAt: Number(raw.createdAt || 0) || Date.now(),
    doneAt: Number(raw.doneAt || 0) || 0,
    doneReason: clean(raw.doneReason, 40),
  };
}

export async function listUserMemos(userId) {
  const id = String(userId || '').trim();
  if (!id) return [];
  const row = await db.get(MEMO_KEY(id)).catch(() => null);
  const list = Array.isArray(row?.value) ? row.value : [];
  return list.map(normalizeMemo).filter(Boolean).sort((a, b) => a.ts - b.ts);
}

async function saveMemoList(userId, memos) {
  const now = Date.now();
  const kept = memos
    .filter((m) => m && now - m.ts < PRUNE_AGE_MS)
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX_MEMOS);
  await db.put({ key: MEMO_KEY(userId), value: kept });
  return kept;
}

/**
 * 路人 NPC、初遇草稿或已经删除的角色不能继续持有主动提醒权限。
 * 保留备忘正文并降级为用户自己的普通备忘，避免清理时丢失用户写过的安排。
 */
export function demoteIneligibleCharacterMemos(memos = [], eligibleCharacterIds = []) {
  const eligible = eligibleCharacterIds instanceof Set
    ? eligibleCharacterIds
    : new Set(Array.from(eligibleCharacterIds || []));
  let changed = false;
  const next = (Array.isArray(memos) ? memos : []).map((memo) => {
    if (memo?.source !== MEMO_SOURCE_CHARACTER) return memo;
    const characterId = String(memo.characterId || '').trim();
    if (characterId && eligible.has(characterId)) return memo;
    changed = true;
    return {
      ...memo,
      source: MEMO_SOURCE_USER,
      characterId: '',
      chatId: '',
      remind: false,
    };
  });
  return { memos: next, changed };
}

export async function repairIneligibleCharacterMemos(userId, eligibleCharacterIds, loadedMemos = null) {
  const id = String(userId || '').trim();
  if (!id) return [];
  const source = Array.isArray(loadedMemos) ? loadedMemos : await listUserMemos(id);
  const repaired = demoteIneligibleCharacterMemos(source, eligibleCharacterIds);
  if (repaired.changed) await saveMemoList(id, repaired.memos).catch(() => null);
  return repaired.memos;
}

async function loadEligibleReminderCharacterIds(userId) {
  const characters = await listCharacters({
    excludeAnonNpc: true,
    userId: String(userId || '').trim(),
  });
  return new Set(characters.map((character) => String(character?.id || '').trim()).filter(Boolean));
}

export async function addUserMemo(userId, memo = {}) {
  const id = String(userId || '').trim();
  const normalized = normalizeMemo(memo);
  if (!id || !normalized) return null;
  const memos = await listUserMemos(id);
  memos.push(normalized);
  await saveMemoList(id, memos);
  return normalized;
}

export async function updateUserMemo(userId, memoId, patch = {}) {
  const id = String(userId || '').trim();
  const target = String(memoId || '').trim();
  if (!id || !target) return null;
  const memos = await listUserMemos(id);
  const idx = memos.findIndex((m) => m.id === target);
  if (idx < 0) return null;
  const next = normalizeMemo({ ...memos[idx], ...patch, id: target });
  if (!next) return null;
  memos[idx] = next;
  await saveMemoList(id, memos);
  return next;
}

export async function removeUserMemo(userId, memoId) {
  const id = String(userId || '').trim();
  const target = String(memoId || '').trim();
  if (!id || !target) return false;
  const memos = await listUserMemos(id);
  const kept = memos.filter((m) => m.id !== target);
  if (kept.length === memos.length) return false;
  await saveMemoList(id, kept);
  return true;
}

export function filterMemosForDay(memos = [], dayTs = 0, timeZone = '') {
  const selected = new Date(Number(dayTs) || Date.now());
  const key = `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, '0')}-${String(selected.getDate()).padStart(2, '0')}`;
  return (Array.isArray(memos) ? memos : []).filter((m) => dateKeyInUserTimezone(m.ts, timeZone) === key);
}

export function buildMemoDayMap(memos = [], timeZone = '') {
  const map = new Map();
  for (const memo of memos) {
    const d = zonedDateProxy(memo.ts, timeZone);
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

/** 到点、未触发过的角色备忘（供后台调度触发定时对话） */
export async function listDueCharacterMemos(userId, now = Date.now()) {
  const eligibleCharacterIds = await loadEligibleReminderCharacterIds(userId).catch(() => null);
  if (!eligibleCharacterIds) return [];
  const memos = await repairIneligibleCharacterMemos(userId, eligibleCharacterIds);
  return memos.filter((m) => (
    m.source === MEMO_SOURCE_CHARACTER
    && m.remind
    && !m.doneAt
    && m.characterId
    && m.ts <= now
  ));
}

export function formatMemoTime(ts, timeZone = '') {
  const p = getZonedDateParts(Number(ts) || 0, timeZone);
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatMemoDateTime(ts, timeZone = '') {
  const p = getZonedDateParts(Number(ts) || 0, timeZone);
  return `${p.month}月${p.day}日 ${formatMemoTime(ts, timeZone)}`;
}

/**
 * 注入聊天语境：未来 7 天内的备忘 + 今天已过但仍是今天的备忘。
 * 用户备忘让角色知道用户的安排；角色备忘让角色记得自己登记过什么。
 */
export async function buildUserMemoPromptBlock(userId, now = 0) {
  const id = String(userId || '').trim();
  if (!id) return '';
  const nowTs = Number(now) || await getNowForUser(id).catch(() => Date.now());
  const timeZone = await getUserTimezone(id).catch(() => '');
  const nowParts = getZonedDateParts(nowTs, timeZone);
  const dayStart = timestampFromUserWallTime({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  }, timeZone);
  const horizon = dayStart + 7 * 86400000;
  const eligibleCharacterIds = await loadEligibleReminderCharacterIds(id).catch(() => null);
  const memos = eligibleCharacterIds
    ? await repairIneligibleCharacterMemos(id, eligibleCharacterIds)
    : await listUserMemos(id);
  const upcoming = memos
    .filter((m) => m.ts >= dayStart && m.ts < horizon && !m.doneAt)
    .slice(0, 10);
  if (!upcoming.length) return '';
  const lines = upcoming.map((m) => {
    const when = formatMemoDateTime(m.ts, timeZone);
    const owner = m.source === MEMO_SOURCE_CHARACTER ? '（角色登记的备忘）' : '（用户自己的安排）';
    const note = m.note ? `，${m.note}` : '';
    return `- ${when}：${m.title}${note}${owner}`;
  });
  return [
    '【日程备忘】',
    '以下是日程表里登记的近期备忘，仅作背景参考：',
    ...lines,
    '用户的安排可在聊天里自然关心或提前叮嘱，但不要每轮都提；角色登记的备忘到点时系统会单独提示你，不要提前剧透执行。',
  ].join('\n');
}
