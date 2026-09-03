import * as db from './db.js';
import {
  loadResolvedCharacterAutonomyPolicy,
  DEFAULT_PROACTIVE_DAILY_LIMIT,
  resolveEffectiveProactiveMinGapMinutes,
} from './character-autonomy-settings.js';
import { dateKeyFromTimestamp } from './character-phone-store.js';
import { resolveCharacterScheduleTimezone } from './chat/chat-timezone.js';

const LOG_CAP = 160;
const RESERVATION_TTL_MS = 10 * 60 * 1000;
// 统一最低间隔设为 0 时，各来源仍保留自己的节奏；这层只防不同来源在几分钟内接连撞车。
export const PROACTIVE_SOURCE_COLLISION_GUARD_MS = 5 * 60 * 1000;
const locks = new Map();

function clean(value = '', max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fullText(value = '') {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function usageKey(userId, characterId) {
  return `characterProactiveUsage:v1:${encodeURIComponent(clean(userId))}:${encodeURIComponent(clean(characterId))}`;
}

async function withLock(key, task) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    if (globalThis.navigator?.locks?.request) {
      return await globalThis.navigator.locks.request(`marshmallow:${key}`, task);
    }
    return await task();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

async function resolveDay(userId, characterId, now = Date.now()) {
  const timeZone = await resolveCharacterScheduleTimezone(userId, characterId).catch(() => '');
  return { dateKey: dateKeyFromTimestamp(now, timeZone), timeZone };
}

function normalizeUsage(value = {}, dateKey = '', now = Date.now()) {
  const sameDay = String(value?.dateKey || '') === String(dateKey || '');
  const lastSentAt = Math.max(
    0,
    Number(value?.lastSentAt || 0),
    ...(Array.isArray(value?.log)
      ? value.log
        .filter((entry) => entry?.status === 'sent')
        .map((entry) => Number(entry?.at || 0))
      : []),
  );
  const reservations = sameDay && value?.reservations && typeof value.reservations === 'object'
    ? Object.fromEntries(Object.entries(value.reservations).filter(([, row]) => Number(row?.expiresAt || 0) > now))
    : {};
  const latestSent = Array.isArray(value?.log)
    ? value.log.find((entry) => entry?.status === 'sent' && Number(entry?.at || 0) === lastSentAt)
    : null;
  return {
    version: 1,
    dateKey,
    sentRounds: sameDay ? Math.max(0, Number(value.sentRounds || 0)) : 0,
    messageCount: sameDay ? Math.max(0, Number(value.messageCount || 0)) : 0,
    // 每日次数会归零，但最小间隔必须跨午夜继续生效。
    lastSentAt,
    lastChannel: clean(value?.lastChannel || latestSent?.channel, 40),
    reservations,
    log: sameDay && Array.isArray(value.log) ? value.log.slice(0, LOG_CAP) : [],
    updatedAt: now,
  };
}

function makeLog(entry = {}, now = Date.now()) {
  return {
    at: now,
    channel: clean(entry.channel, 40),
    status: ['sent', 'failed', 'skipped'].includes(entry.status) ? entry.status : 'skipped',
    reason: clean(entry.reason, 80),
    messageCount: Math.max(0, Number(entry.messageCount || 0)),
    chatId: clean(entry.chatId, 80),
    idempotencyKey: clean(entry.idempotencyKey, 120),
    count: Math.max(1, Number(entry.count || 1)),
    error: fullText(entry.error),
    rawText: fullText(entry.rawText),
    reasoningText: fullText(entry.reasoningText),
    responseText: fullText(entry.responseText),
    finishReason: clean(entry.finishReason, 80),
    requestModel: clean(entry.requestModel, 160),
    requestStream: typeof entry.requestStream === 'boolean' ? entry.requestStream : null,
    statusCode: Math.max(0, Number(entry.statusCode || entry.apiStatus || 0) || 0),
  };
}

export function appendProactiveLog(log = [], entry = {}, now = Date.now()) {
  const next = makeLog(entry, now);
  const first = log[0];
  if (
    next.status === 'skipped'
    && first?.status === 'skipped'
    && first.channel === next.channel
    && first.reason === next.reason
    && first.chatId === next.chatId
  ) {
    // 定时扫描会每隔几分钟重复遇到静音、线下进行中、slot lock 等正常门禁。
    // 这里只保留「当前仍是这个原因」，不把轮询次数累计成几百次暂缓，避免把健康状态显示成故障。
    return [{ ...first, at: next.at, count: 1 }, ...log.slice(1)].slice(0, LOG_CAP);
  }
  return [next, ...log].slice(0, LOG_CAP);
}

async function readContext(userId, characterId, now = Date.now(), options = {}) {
  const [{ dateKey, timeZone }, policy] = await Promise.all([
    options.dateKey
      ? Promise.resolve({ dateKey: options.dateKey, timeZone: options.timeZone || '' })
      : resolveDay(userId, characterId, now),
    options.policy
      ? Promise.resolve(options.policy)
      : loadResolvedCharacterAutonomyPolicy(userId, characterId, options.chatId || '').catch(() => null),
  ]);
  const limit = Math.max(1, Math.round(Number(policy?.proactiveDailyLimit || DEFAULT_PROACTIVE_DAILY_LIMIT)));
  const configuredMinGapMinutes = Math.max(
    0,
    Math.min(1440, Math.round(Number(policy?.scheduleProactive?.minGapMinutes || 0))),
  );
  const minGapMinutes = resolveEffectiveProactiveMinGapMinutes(policy || {});
  return {
    dateKey,
    timeZone,
    policy,
    limit,
    minGapMinutes,
    configuredMinGapMinutes,
    sharedMinGapDisabled: configuredMinGapMinutes === 0,
  };
}

export async function getCharacterProactiveUsageStatus(userId, characterId, now = Date.now(), options = {}) {
  const uid = clean(userId);
  const cid = clean(characterId);
  if (!uid || !cid) {
    return { dateKey: '', limit: DEFAULT_PROACTIVE_DAILY_LIMIT, sentRounds: 0, messageCount: 0, remaining: 0, log: [] };
  }
  const context = await readContext(uid, cid, now, options);
  const row = await db.get('settings', usageKey(uid, cid)).catch(() => null);
  const usage = normalizeUsage(row?.value, context.dateKey, now);
  return {
    ...usage,
    limit: context.limit,
    remaining: Math.max(0, context.limit - usage.sentRounds - Object.keys(usage.reservations).length),
    timeZone: context.timeZone,
    minGapMinutes: context.minGapMinutes,
    configuredMinGapMinutes: context.configuredMinGapMinutes,
    sharedMinGapDisabled: context.sharedMinGapDisabled,
  };
}

export async function reserveProactiveDelivery({
  userId,
  characterId,
  chatId = '',
  channel = '',
  reason = '',
  idempotencyKey = '',
  now = Date.now(),
  policy = null,
  requireTotalEnabled = true,
} = {}) {
  const uid = clean(userId);
  const cid = clean(characterId);
  if (!uid || !cid) return { ok: false, reason: 'missing-identity' };
  const key = usageKey(uid, cid);
  const context = await readContext(uid, cid, now, { policy, chatId });
  return withLock(key, async () => {
    const row = await db.get('settings', key).catch(() => null);
    const usage = normalizeUsage(row?.value, context.dateKey, now);
    const idem = clean(idempotencyKey, 120);
    if (requireTotalEnabled !== false && context.policy?.totalEnabled !== true) {
      usage.log = appendProactiveLog(usage.log, {
        channel, status: 'skipped', reason: 'proactive-disabled', chatId, idempotencyKey: idem,
      }, now);
      await db.put('settings', { key, value: usage });
      return { ok: false, skipped: true, reason: 'proactive-disabled', usage };
    }
    if (idem && usage.log.some((entry) => entry.idempotencyKey === idem && entry.status === 'sent')) {
      return { ok: false, skipped: true, reason: 'already-counted', usage };
    }
    if (idem && Object.values(usage.reservations).some((entry) => entry?.idempotencyKey === idem)) {
      return { ok: false, skipped: true, reason: 'already-reserved', usage };
    }
    const activeReservations = Object.values(usage.reservations);
    if (activeReservations.length > 0) {
      usage.log = appendProactiveLog(usage.log, {
        channel, status: 'skipped', reason: 'proactive-arbitration-busy', chatId, idempotencyKey: idem,
      }, now);
      await db.put('settings', { key, value: usage });
      return {
        ok: false,
        skipped: true,
        reason: 'proactive-arbitration-busy',
        retryAt: now + 30 * 1000,
        activeChannel: clean(activeReservations[0]?.channel, 40),
        usage,
      };
    }
    const active = Object.keys(usage.reservations).length;
    if (usage.sentRounds + active >= context.limit) {
      usage.log = appendProactiveLog(usage.log, {
        channel, status: 'skipped', reason: 'daily-limit-reached', chatId, idempotencyKey: idem,
      }, now);
      await db.put('settings', { key, value: usage });
      return { ok: false, skipped: true, reason: 'daily-limit-reached', limit: context.limit, usage };
    }
    const minGapMs = context.minGapMinutes * 60 * 1000;
    const latestReservationAt = Math.max(
      0,
      ...Object.values(usage.reservations).map((entry) => Number(entry?.at || 0)),
    );
    const latestDeliveryAt = Math.max(usage.lastSentAt, latestReservationAt);
    const sinceLatestDelivery = now - latestDeliveryAt;
    if (minGapMs > 0 && latestDeliveryAt > 0 && sinceLatestDelivery >= 0 && sinceLatestDelivery < minGapMs) {
      usage.log = appendProactiveLog(usage.log, {
        channel, status: 'skipped', reason: 'cooldown', chatId, idempotencyKey: idem,
      }, now);
      await db.put('settings', { key, value: usage });
      return {
        ok: false,
        skipped: true,
        reason: 'cooldown',
        retryAt: latestDeliveryAt + minGapMs,
        usage,
      };
    }
    const incomingChannel = clean(channel, 40);
    if (
      minGapMs === 0
      && usage.lastSentAt > 0
      && usage.lastChannel
      && incomingChannel
      && usage.lastChannel !== incomingChannel
      && now - usage.lastSentAt >= 0
      && now - usage.lastSentAt < PROACTIVE_SOURCE_COLLISION_GUARD_MS
    ) {
      usage.log = appendProactiveLog(usage.log, {
        channel, status: 'skipped', reason: 'source-collision-guard', chatId, idempotencyKey: idem,
      }, now);
      await db.put('settings', { key, value: usage });
      return {
        ok: false,
        skipped: true,
        reason: 'source-collision-guard',
        retryAt: usage.lastSentAt + PROACTIVE_SOURCE_COLLISION_GUARD_MS,
        usage,
      };
    }
    const reservationId = `${now.toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    usage.reservations[reservationId] = {
      at: now,
      expiresAt: now + RESERVATION_TTL_MS,
      channel: clean(channel, 40),
      reason: clean(reason, 80),
      chatId: clean(chatId, 80),
      idempotencyKey: idem,
    };
    await db.put('settings', { key, value: usage });
    return { ok: true, reservationId, limit: context.limit, usage };
  });
}

export async function settleProactiveDelivery({
  userId,
  characterId,
  reservationId = '',
  ok = false,
  skipped = false,
  reason = '',
  messageCount = 0,
  error = '',
  rawText = '',
  reasoningText = '',
  responseText = '',
  finishReason = '',
  requestModel = '',
  requestStream = null,
  statusCode = 0,
  now = Date.now(),
} = {}) {
  const uid = clean(userId);
  const cid = clean(characterId);
  const key = usageKey(uid, cid);
  if (!uid || !cid || !reservationId) return null;
  const context = await readContext(uid, cid, now);
  return withLock(key, async () => {
    const row = await db.get('settings', key).catch(() => null);
    const usage = normalizeUsage(row?.value, context.dateKey, now);
    const reservation = usage.reservations[reservationId];
    if (!reservation) return usage;
    delete usage.reservations[reservationId];
    const count = Math.max(0, Number(messageCount || 0));
    const sent = ok === true && count > 0;
    if (sent) {
      usage.sentRounds += 1;
      usage.messageCount += count;
      usage.lastSentAt = Math.max(usage.lastSentAt, now);
      usage.lastChannel = clean(reservation.channel, 40);
    }
    usage.log = appendProactiveLog(usage.log, {
      ...reservation,
      status: sent ? 'sent' : (skipped ? 'skipped' : 'failed'),
      reason: clean(reason, 80) || (sent ? 'sent' : (count <= 0 ? 'empty-result' : 'failed')),
      messageCount: count,
      error,
      rawText,
      reasoningText,
      responseText,
      finishReason,
      requestModel,
      requestStream,
      statusCode,
    }, now);
    await db.put('settings', { key, value: usage });
    return usage;
  });
}

export async function recordProactiveOutcome({
  userId,
  characterId,
  chatId = '',
  channel = '',
  status = 'skipped',
  reason = '',
  messageCount = 0,
  error = '',
  rawText = '',
  reasoningText = '',
  responseText = '',
  finishReason = '',
  requestModel = '',
  requestStream = null,
  statusCode = 0,
  now = Date.now(),
} = {}) {
  const uid = clean(userId);
  const cid = clean(characterId);
  if (!uid || !cid) return null;
  const key = usageKey(uid, cid);
  const context = await readContext(uid, cid, now, { chatId });
  return withLock(key, async () => {
    const row = await db.get('settings', key).catch(() => null);
    const usage = normalizeUsage(row?.value, context.dateKey, now);
    usage.log = appendProactiveLog(usage.log, {
      channel,
      status,
      reason,
      chatId,
      messageCount,
      error,
      rawText,
      reasoningText,
      responseText,
      finishReason,
      requestModel,
      requestStream,
      statusCode,
    }, now);
    await db.put('settings', { key, value: usage });
    return usage;
  });
}

export function proactiveReasonLabel(reason = '') {
  const labels = {
    'proactive-disabled': '主动消息已关闭，本轮未调用接口',
    'daily-limit-reached': '今日主动上限已用完',
    'missing-plan': '今日日程生成失败',
    'missing-plan-auto-disabled': '没有今日日程',
    'no-active-block': '当前不在日程时段',
    'mute-hours': '处于静音时段',
    'active-offline-session': '正在和 TA 线下互动；结束或收纳后自动恢复',
    'deferred-user-active': '你正在操作，已延后',
    'composer-active': '你正在这个会话输入，本轮已停止并顺延',
    'foreground-streaming': '这个会话正在前台生成，本轮未重复调用',
    'headless-in-flight': '这个会话已有后台请求，本轮未重复调用',
    'autonomy-guard': '同一角色已有主动任务，本轮未重复调用',
    'proactive-near-duplicate': '生成内容与近期主动消息重复，已拦截且未自动重试',
    'proactive-duplicate-suppressed': '草稿与近期消息重复，本次保持安静',
    'failure-backoff': '接口失败后正在退避',
    'slot-lock-active': '同一日程窗口正在处理中',
    'slot-running': '同一日程窗口正在生成',
    'slot-used': '这个日程窗口已经发送过',
    'slot-generation-attempted': '这个日程窗口已经尝试生成，本次不再重复调用',
    'already-counted': '同一主动回合已经发送过',
    'already-reserved': '同一主动回合正在处理中',
    'proactive-arbitration-busy': '同一角色已有主动消息正在处理，本轮顺延',
    'source-collision-guard': '另一类主动消息刚刚发出，本轮顺延避免撞车',
    'recent-ai-message': 'TA 刚发过消息，本轮不打扰',
    'cooldown': '距离上次主动消息太近',
    'tick-generation-cap': '本轮后台调用已达上限，稍后继续',
    'catch-up-generation-cap': '恢复前台本轮只补一条，其余顺延',
    'runtime-state-overrides-schedule': 'TA 的实时状态已覆盖原日程',
    'busy-auto-reply-active': 'TA 正忙，本时段使用自动回复',
    'active-voice-call': '正在通话，本轮不另发聊天消息',
    'hard-offline-active': 'TA 处于完全下线状态',
    'blocked-by-user': '这个会话已被屏蔽',
    'persist-failed': '美团优惠提醒保存失败',
    'all-muted': '群聊全员禁言',
    'guidance-mode': '当前是指导模式，不自动推进',
    'missing-character-record': '角色资料已不存在，本轮未调用接口',
    'character-deleted': '角色已删除，本轮未调用接口',
    'api-http-error': '接口返回 HTTP 错误',
    'protocol-plain-text': '模型返回了普通文字，未按聊天协议输出',
    'protocol-format-error': '模型返回的聊天协议 JSON 格式错误',
    'protocol-no-events': '模型返回了协议结构，但没有有效消息事件',
    'no-marshmallow-protocol': '模型返回内容中未识别到聊天协议',
    'empty-api-response': '接口结束了，但没有返回可显示正文',
    'empty-visible': '模型完成了本轮，但没有生成可见角色消息',
    'missing-character': '残留会话含已删除角色，自动推进已停止',
    'not-leader': '由其他页面负责后台任务',
    'cloud-scheduled': '已交给云端处理',
    'cloud-generation-cancelled': '云端生成已由你终止',
    'empty-result': '模型未生成可见消息',
  };
  return labels[reason] || clean(reason, 80) || '未知原因';
}
