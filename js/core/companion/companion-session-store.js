// 陪伴 session 持久层。沿用 activity-sessions 的存法：
// settings store 里 `companionSessions_<userId>` -> { sessions: [...] }，可恢复。
// 详见 docs/companion-architecture.md §2.1。

import { get as dbGet, put as dbPut } from '../db.js';
import { sanitizeCompanionSpeechText } from './companion-values.js';

const MAX_SESSIONS = 40;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sessionsKey(userId) {
  return `companionSessions_${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function normalizeStoredSession(session = {}) {
  const outputs = asArray(session.outputs).map((output) => ({
    ...output,
    text: sanitizeCompanionSpeechText(output?.text, { max: 4000 }),
    voiceText: sanitizeCompanionSpeechText(output?.voiceText, { max: 4000 }),
    bubbles: asArray(output?.bubbles).map((item) => sanitizeCompanionSpeechText(item, { max: 500 })).filter(Boolean),
    voiceSegments: asArray(output?.voiceSegments).map((item) => ({
      ...item,
      text: sanitizeCompanionSpeechText(item?.text, { max: 500 }),
    })).filter((item) => item.text),
  }));
  return { ...session, outputs };
}

export async function listCompanionSessions(userId) {
  const row = await dbGet('settings', sessionsKey(userId)).catch(() => null);
  return asArray(row?.value?.sessions)
    .filter(Boolean)
    .map(normalizeStoredSession)
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
}

export async function listActiveCompanionSessions(userId) {
  const list = await listCompanionSessions(userId);
  return list.filter((s) => s?.status === 'active' || s?.status === 'paused');
}

export async function getCompanionSession(userId, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const list = await listCompanionSessions(userId);
  return list.find((s) => s?.id === id) || null;
}

export async function saveCompanionSession(userId, session) {
  if (!session?.id) throw new Error('session 缺少 id');
  const list = await listCompanionSessions(userId);
  const next = [
    normalizeStoredSession({ ...session, updatedAt: Date.now() }),
    ...list.filter((item) => item?.id !== session.id),
  ].slice(0, MAX_SESSIONS);
  await dbPut('settings', { key: sessionsKey(userId), value: { sessions: next } });
  return next[0];
}

export async function removeCompanionSession(userId, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const list = await listCompanionSessions(userId);
  const next = list.filter((item) => item?.id !== id);
  await dbPut('settings', { key: sessionsKey(userId), value: { sessions: next } });
  return true;
}
