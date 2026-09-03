import { get, put } from './db.js';

const STATUS_SET = new Set(['pending', 'accepted', 'declined']);

function clean(value, max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function applicationKey(userId = '') {
  return `qqContactApplications_${clean(userId) || 'guest'}`;
}

export function normalizeQqContactApplication(input = {}) {
  const row = input && typeof input === 'object' ? input : {};
  const id = clean(row.id, 260);
  if (!id) return null;
  const status = STATUS_SET.has(clean(row.status).toLowerCase())
    ? clean(row.status).toLowerCase()
    : 'pending';
  return {
    ...row,
    id,
    sourceKind: clean(row.sourceKind, 24),
    sourceId: clean(row.sourceId, 260),
    ownerId: clean(row.ownerId, 160),
    characterId: clean(row.characterId, 160),
    chatId: clean(row.chatId, 160),
    name: clean(row.name, 80) || '新的联系人',
    avatar: clean(row.avatar),
    subtitle: clean(row.subtitle, 160),
    status,
    createdAt: Math.max(0, Number(row.createdAt) || Date.now()),
    decidedAt: Math.max(0, Number(row.decidedAt) || 0),
    decisionReason: clean(row.decisionReason, 300),
  };
}

export async function loadQqContactApplications(userId = '') {
  const row = await get(applicationKey(userId)).catch(() => null);
  return (Array.isArray(row?.value) ? row.value : [])
    .map(normalizeQqContactApplication)
    .filter(Boolean)
    .slice(0, 120);
}

export async function saveQqContactApplications(userId = '', rows = []) {
  const value = (Array.isArray(rows) ? rows : [])
    .map(normalizeQqContactApplication)
    .filter(Boolean)
    .slice(0, 120);
  await put({ key: applicationKey(userId), value });
  return value;
}

export async function upsertQqContactApplication(userId = '', input = {}) {
  const next = normalizeQqContactApplication(input);
  if (!next) throw new Error('好友申请缺少候选身份');
  const rows = await loadQqContactApplications(userId);
  const rest = rows.filter((row) => row.id !== next.id);
  return saveQqContactApplications(userId, [next, ...rest]);
}

export async function deleteQqContactApplicationsForThread(userId = '', {
  chatId = '',
  applicationId = '',
} = {}) {
  const targetChatId = clean(chatId, 160);
  const targetApplicationId = clean(applicationId, 260);
  if (!targetChatId && !targetApplicationId) return { deleted: 0, rows: await loadQqContactApplications(userId) };
  const rows = await loadQqContactApplications(userId);
  const kept = rows.filter((row) => !(
    (targetChatId && clean(row.chatId, 160) === targetChatId)
    || (targetApplicationId && row.id === targetApplicationId)
  ));
  if (kept.length === rows.length) return { deleted: 0, rows };
  const saved = await saveQqContactApplications(userId, kept);
  return { deleted: rows.length - saved.length, rows: saved };
}

export async function markQqContactApplicationDecision(userId = '', applicationId = '', {
  status,
  reason = '',
  characterId = '',
  chatId = '',
} = {}) {
  const id = clean(applicationId, 260);
  const nextStatus = clean(status).toLowerCase();
  if (!id || !['accepted', 'declined'].includes(nextStatus)) return null;
  const rows = await loadQqContactApplications(userId);
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return null;
  rows[index] = normalizeQqContactApplication({
    ...rows[index],
    status: nextStatus,
    decidedAt: Date.now(),
    decisionReason: reason,
    characterId: characterId || rows[index].characterId,
    chatId: chatId || rows[index].chatId,
  });
  await saveQqContactApplications(userId, rows);
  return rows[index];
}
