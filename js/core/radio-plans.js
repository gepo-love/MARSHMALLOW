/**
 * 聊天里约定的待生成电台。
 * 计划只保存稳定约束；真正生成时重新读取聊天、记忆与世界书，才能承接约定后的变化。
 */
import * as db from './db.js';
import { getUserTimezone } from './time-mode.js';
import { formatMemoDateTime } from './user-memos.js';

const PLAN_KEY = (userId) => `radioPlans_${String(userId || '').trim()}`;
const MAX_PLANS = 120;
const KEEP_COMPLETED_MS = 90 * 86400000;
const ACTIVE_STATUSES = new Set(['pending', 'generating']);
const RADIO_TYPES = new Set(['bedtime', 'memory', 'confession', 'daily', 'knowledge', 'improv', 'reading']);

function clean(value = '', max = 600) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function createId() {
  if (globalThis.crypto?.randomUUID) return `radio-plan-${globalThis.crypto.randomUUID()}`;
  return `radio-plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeRadioPlan(raw = {}) {
  const dueAt = Number(raw.dueAt || raw.ts || 0);
  const status = ['pending', 'generating', 'delivered', 'cancelled', 'expired'].includes(raw.status)
    ? raw.status
    : 'pending';
  return {
    id: clean(raw.id, 100) || createId(),
    userId: clean(raw.userId, 240),
    characterId: clean(raw.characterId, 240),
    chatId: clean(raw.chatId, 240),
    dueAt: Number.isFinite(dueAt) && dueAt > 0 ? dueAt : 0,
    topic: clean(raw.topic, 1000),
    note: clean(raw.note, 800),
    type: RADIO_TYPES.has(String(raw.type || '')) ? String(raw.type) : 'bedtime',
    readingSeriesId: clean(raw.readingSeriesId, 180),
    recurrence: ['daily', 'weekly'].includes(raw.recurrence) ? raw.recurrence : '',
    minutes: Math.max(3, Math.min(30, Math.round(Number(raw.minutes || 8) || 8))),
    actionMode: ['visible', 'hidden', 'off'].includes(raw.actionMode) ? raw.actionMode : 'hidden',
    ambientEnabled: raw.ambientEnabled !== false,
    status,
    episodeId: clean(raw.episodeId, 180),
    attemptCount: Math.max(0, Math.round(Number(raw.attemptCount || 0) || 0)),
    retryAt: Math.max(0, Number(raw.retryAt || 0) || 0),
    leaseUntil: Math.max(0, Number(raw.leaseUntil || 0) || 0),
    lastError: clean(raw.lastError, 240),
    createdAt: Math.max(0, Number(raw.createdAt || Date.now()) || Date.now()),
    updatedAt: Math.max(0, Number(raw.updatedAt || Date.now()) || Date.now()),
    completedAt: Math.max(0, Number(raw.completedAt || 0) || 0),
    sourceAiRoundId: clean(raw.sourceAiRoundId, 120),
  };
}

export async function listRadioPlans(userId) {
  const uid = clean(userId, 240);
  if (!uid) return [];
  const row = await db.get(PLAN_KEY(uid)).catch(() => null);
  return (Array.isArray(row?.value) ? row.value : [])
    .map(normalizeRadioPlan)
    .filter((plan) => plan.userId === uid && plan.characterId && plan.dueAt)
    .sort((a, b) => a.dueAt - b.dueAt);
}

export async function getRadioPlan(userId, planId) {
  const id = clean(planId, 100);
  return (await listRadioPlans(userId)).find((plan) => plan.id === id) || null;
}

async function savePlanList(userId, plans = []) {
  const uid = clean(userId, 240);
  const cutoff = Date.now() - KEEP_COMPLETED_MS;
  const kept = plans
    .map((plan) => normalizeRadioPlan({ ...plan, userId: uid }))
    .filter((plan) => ACTIVE_STATUSES.has(plan.status) || !plan.completedAt || plan.completedAt >= cutoff)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(-MAX_PLANS);
  await db.put({ key: PLAN_KEY(uid), value: kept });
  return kept;
}

export async function createRadioPlan(userId, raw = {}) {
  const uid = clean(userId, 240);
  const plan = normalizeRadioPlan({ ...raw, userId: uid, status: 'pending' });
  if (!uid || !plan.characterId || !plan.chatId || !plan.dueAt) return null;
  const plans = await listRadioPlans(uid);
  plans.push(plan);
  await savePlanList(uid, plans);
  return plan;
}

export async function updateRadioPlan(userId, planId, patch = {}) {
  const uid = clean(userId, 240);
  const id = clean(planId, 100);
  const plans = await listRadioPlans(uid);
  const index = plans.findIndex((plan) => plan.id === id);
  if (index < 0) return null;
  const next = normalizeRadioPlan({ ...plans[index], ...patch, id, userId: uid, updatedAt: Date.now() });
  plans[index] = next;
  await savePlanList(uid, plans);
  return next;
}

export async function findLatestActiveRadioPlan(userId, { chatId = '', characterId = '' } = {}) {
  const chat = clean(chatId, 240);
  const actor = clean(characterId, 240);
  const plans = await listRadioPlans(userId);
  return [...plans].reverse().find((plan) => (
    ACTIVE_STATUSES.has(plan.status)
    && (!chat || plan.chatId === chat)
    && (!actor || plan.characterId === actor)
  )) || null;
}

export async function listDueRadioPlans(userId, now = Date.now()) {
  const plans = await listRadioPlans(userId);
  return plans.filter((plan) => (
    (plan.status === 'pending' || (plan.status === 'generating' && plan.leaseUntil <= now))
    && plan.dueAt <= now
    && (!plan.retryAt || plan.retryAt <= now)
  ));
}

export async function buildRadioPlanPromptBlock(userId, { chatId = '', characterIds = [] } = {}) {
  const chat = clean(chatId, 240);
  const actors = new Set((Array.isArray(characterIds) ? characterIds : []).map((id) => clean(id, 240)).filter(Boolean));
  const plans = (await listRadioPlans(userId)).filter((plan) => (
    ACTIVE_STATUSES.has(plan.status)
    && (!chat || plan.chatId === chat)
    && (!actors.size || actors.has(plan.characterId))
  ));
  if (!plans.length) return '';
  const timeZone = await getUserTimezone(userId).catch(() => '');
  return [
    '【尚未送达的电台约定】',
    ...plans.slice(-4).map((plan) => `- ${formatMemoDateTime(plan.dueAt, timeZone)}｜${plan.topic || '由角色决定主题'}｜${plan.minutes} 分钟${plan.note ? `｜补充：${plan.note}` : ''}`),
    '这些是已经答应但尚未完成的约定。用户改变题材、时间或要求时，用 radio_plan operation:"update" 更新最近一条；明确取消时用 operation:"cancel"。不要重复创建同一约定。',
  ].join('\n');
}
