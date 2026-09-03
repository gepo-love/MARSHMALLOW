import { get as dbGet, put as dbPut } from './db.js';
import { loadOfflineSession, saveOfflineSession } from './offline-session-store.js';
import { buildOfflineInterludeBeat } from './offline-interlude.js';

export const OFFLINE_PHONE_FREQUENCIES = {
  low: { chance: 0.2, cooldownMinutes: 60, sessionLimit: 1, label: '低' },
  medium: { chance: 0.45, cooldownMinutes: 20, sessionLimit: 2, label: '中' },
  // “高”是用户明确选择的强演出档：具备资格时直接命中，再用短冷却防止
  // 连续两条消息重复接管。旧值 75% + 8 分钟会让十多分钟通常只出现一次。
  high: { chance: 1, cooldownMinutes: 3, sessionLimit: 6, label: '高' },
  // 用户主动选择的开放档：每次具备资格都允许演出，不设冷却与单场次数上限。
  always: { chance: 1, cooldownMinutes: 0, sessionLimit: Number.POSITIVE_INFINITY, label: '无冷却' },
};

function cleanFrequency(value = '') {
  return OFFLINE_PHONE_FREQUENCIES[value] ? value : 'medium';
}

function runtimeKey(userId) {
  return `offlinePhoneCinematicRuntime_${String(userId || '').trim()}`;
}

function jobKey(id) {
  return `offlinePhoneCinematicJob_${String(id || '').trim()}`;
}

function makeId() {
  return `opc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeJoinIntent(value = '') {
  return ['ask_join', 'coming'].includes(String(value || '')) ? String(value) : 'none';
}

function normalizeChannel(value = '') {
  const channel = String(value || '');
  if (channel === 'sideTripCaught' || channel === 'storyTakeover') return channel;
  return 'incomingTakeover';
}

export function isOfflinePhoneCinematicForeground(offlineChatId = '') {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false;
  const page = document.querySelector('.offline-session-page');
  if (!page?.isConnected) return false;
  if (!offlineChatId) return true;
  return String(location.hash || '').includes(`chatId=${encodeURIComponent(offlineChatId)}`)
    || String(location.hash || '').includes(`chatId=${offlineChatId}`);
}

/** 命中后立即写水位，避免并发主动消息重复创建演出。 */
export async function rollOfflinePhoneCinematic({
  userId,
  offlineChatId,
  channel,
  frequency = 'medium',
  force = false,
} = {}) {
  const tierId = cleanFrequency(frequency);
  const tier = OFFLINE_PHONE_FREQUENCIES[tierId];
  const key = runtimeKey(userId);
  const row = await dbGet(key).catch(() => null);
  const runtime = row?.value && typeof row.value === 'object' ? row.value : {};
  const scope = `${String(offlineChatId || '')}:${String(channel || '')}`;
  const state = runtime[scope] && typeof runtime[scope] === 'object' ? runtime[scope] : {};
  const now = Date.now();
  if (!force && now - Number(state.lastAt || 0) < tier.cooldownMinutes * 60 * 1000) {
    return { hit: false, reason: 'cooldown', tier: tierId };
  }
  if (!force && Number(state.count || 0) >= tier.sessionLimit) {
    return { hit: false, reason: 'session-limit', tier: tierId };
  }
  if (!force && Math.random() > tier.chance) return { hit: false, reason: 'chance', tier: tierId };
  runtime[scope] = { lastAt: now, count: Number(state.count || 0) + 1 };
  await dbPut({ key, value: runtime });
  return { hit: true, tier: tierId };
}

export async function createOfflinePhoneCinematicJob(payload = {}) {
  const now = Date.now();
  const job = {
    id: makeId(),
    status: 'queued',
    channel: normalizeChannel(payload.channel),
    userId: String(payload.userId || ''),
    offlineChatId: String(payload.offlineChatId || ''),
    targetChatId: String(payload.targetChatId || ''),
    senderCharacterId: String(payload.senderCharacterId || ''),
    senderName: String(payload.senderName || 'TA'),
    proxyCharacterId: String(payload.proxyCharacterId || ''),
    proxyName: String(payload.proxyName || 'TA'),
    replyText: String(payload.replyText || '').trim().slice(0, 120),
    counterpartReplies: (payload.counterpartReplies || [])
      .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 2)
      .map((item) => item.slice(0, 120)),
    joinIntent: normalizeJoinIntent(payload.joinIntent),
    joinMessage: normalizeJoinIntent(payload.joinIntent) === 'none'
      ? ''
      : String(payload.joinMessage || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    joinDecision: 'pending',
    incomingCount: Math.max(0, Number(payload.incomingCount || 0)),
    incomingMessageIds: (payload.incomingMessageIds || []).map(String).filter(Boolean).slice(0, 12),
    incomingLines: (payload.incomingLines || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8),
    sceneDirective: String(payload.sceneDirective || ''),
    sourceBeatId: String(payload.sourceBeatId || ''),
    createdAt: now,
    updatedAt: now,
  };
  await dbPut({ key: jobKey(job.id), value: job });
  return job;
}

export async function getOfflinePhoneCinematicJob(id) {
  const row = await dbGet(jobKey(id)).catch(() => null);
  if (!row?.value || typeof row.value !== 'object') return null;
  return {
    joinIntent: 'none',
    joinMessage: '',
    joinDecision: 'pending',
    ...row.value,
  };
}

export async function updateOfflinePhoneCinematicJob(id, patch = {}) {
  const prev = await getOfflinePhoneCinematicJob(id);
  if (!prev) return null;
  const next = { ...prev, ...(patch || {}), id: prev.id, updatedAt: Date.now() };
  await dbPut({ key: jobKey(id), value: next });
  return next;
}

export function announceOfflinePhoneCinematic(job) {
  if (!job?.id || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('marshmallow-offline-phone-cinematic', {
    detail: {
      jobId: job.id,
      targetChatId: job.targetChatId,
      offlineChatId: job.offlineChatId,
      proxyName: job.proxyName,
      channel: job.channel,
    },
  }));
}

export async function completeOfflinePhoneCinematicJob(id, {
  replyMessage = null,
  counterpartMessages = [],
} = {}) {
  const job = await getOfflinePhoneCinematicJob(id);
  if (!job || job.status === 'completed') return job;
  const counterpart = Array.isArray(counterpartMessages) ? counterpartMessages : [];
  const replyLine = replyMessage?.content ? `${job.proxyName}（拿着你的手机代回）：${replyMessage.content}` : '';
  const counterpartLines = counterpart.map((m) => {
    const body = String(m?.content || '').replace(/\s+/g, ' ').trim();
    return body ? `${job.senderName}：${body.slice(0, 120)}` : '';
  }).filter(Boolean);
  const lines = [...(job.incomingLines || []), replyLine, ...counterpartLines].filter(Boolean);
  const session = await loadOfflineSession(job.offlineChatId).catch(() => null);
  if (session?.status === 'active') {
    session.beats.push(buildOfflineInterludeBeat({
      kind: job.channel === 'sideTripCaught'
        ? 'side_trip_caught'
        : (job.channel === 'storyTakeover' ? 'story_takeover' : 'proactive_takeover'),
      chatId: job.targetChatId,
      chatLabel: job.senderName,
      incomingCount: job.incomingCount,
      outgoingCount: replyMessage ? 1 : 0,
      counterpartCount: counterpart.length,
      mode: 'companion',
      proxyCharacterId: job.proxyCharacterId,
      proxyName: job.proxyName,
      messageIds: [
        ...(job.incomingMessageIds || []),
        replyMessage?.id,
        ...counterpart.map((m) => m?.id),
      ],
      title: job.channel === 'incomingTakeover'
        ? `${job.senderName}发来 ${job.incomingCount || 1} 条消息`
        : `${job.proxyName}接过了手机`,
      detail: `${job.proxyName}已代回${counterpart.length ? ` · 对方又回复 ${counterpart.length} 条` : ''}`,
      text: lines.length
        ? `手机上的一段往来：\n${lines.join('\n')}`
        : `${job.proxyName}接过手机，替你处理了和${job.senderName}的消息。`,
      ts: Date.now(),
    }));
    await saveOfflineSession(session);
  }
  return updateOfflinePhoneCinematicJob(id, {
    status: 'completed',
    replyMessageId: replyMessage?.id || '',
    counterpartMessageIds: counterpart.map((m) => m?.id).filter(Boolean),
    joinDecision: job.joinIntent && job.joinIntent !== 'none'
      ? (job.joinDecision || 'pending')
      : 'not_applicable',
    completedAt: Date.now(),
  });
}
