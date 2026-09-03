/**
 * 拉黑后的「失联联系」：前两轮仍在原会话显示发送失败；之后按用户设定间隔，
 * 由角色改用独立邮箱或社交小号联系。旧漂流瓶设置键继续读取，保证升级无感。
 *
 * 两套时间：
 * - 投递间隔（每会话）：满多久才再给该角色投一只瓶
 * - 扫描间隔（每用户全局）：后台多久醒来扫一遍「有没有到期该投的会话」
 */
import { ensureDefaultUser, getUserById } from '../user-slot.js';
import { listChatsForUser } from '../chat-store.js';
import { getNowForUser } from '../time-mode.js';
import { get as dbGet, put as dbPut, getRecord } from '../db.js';
import { getCharacterAiContextName } from '../../models/character.js';
import { isAnonymousChat } from '../chat-helpers.js';
import {
  loadChatPrefs,
  patchChatPrefs,
  isChatBlockedByUser,
} from '../chat-block-state.js';
import { runHeadlessChatReply } from './headless-reply.js';
import { deliverBlockedContactAttempt } from '../blocked-contact-delivery.js';
import { reserveProactiveDelivery, settleProactiveDelivery } from '../character-proactive-usage.js';

/** 默认扫描间隔（未配置时）：1 分钟 */
export const DRIFT_BOTTLE_PROACTIVE_CHECK_MS = 60 * 1000;
export const DRIFT_BOTTLE_SCAN_INTERVAL_MIN = 1;
export const DRIFT_BOTTLE_SCAN_INTERVAL_MAX = 60;
export const DEFAULT_DRIFT_BOTTLE_SCAN_INTERVAL_MINUTES = 1;

const CATCH_UP_MAX = 2;
const TIMER_MAX = 4;

let _running = false;

function scanSettingsKey(userId) {
  return `driftBottleScan_${String(userId || '').trim()}`;
}

export function clampDriftBottleScanIntervalMinutes(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_DRIFT_BOTTLE_SCAN_INTERVAL_MINUTES;
  return Math.max(
    DRIFT_BOTTLE_SCAN_INTERVAL_MIN,
    Math.min(DRIFT_BOTTLE_SCAN_INTERVAL_MAX, n),
  );
}

export async function loadDriftBottleScanSettings(userId = '') {
  const uid = String(userId || '').trim();
  if (!uid) {
    return { scanIntervalMinutes: DEFAULT_DRIFT_BOTTLE_SCAN_INTERVAL_MINUTES };
  }
  const row = await dbGet(scanSettingsKey(uid)).catch(() => null);
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    scanIntervalMinutes: clampDriftBottleScanIntervalMinutes(
      value.scanIntervalMinutes ?? DEFAULT_DRIFT_BOTTLE_SCAN_INTERVAL_MINUTES,
    ),
  };
}

export async function saveDriftBottleScanSettings(userId, patch = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return loadDriftBottleScanSettings('');
  const prev = await loadDriftBottleScanSettings(uid);
  const next = {
    scanIntervalMinutes: clampDriftBottleScanIntervalMinutes(
      patch?.scanIntervalMinutes ?? prev.scanIntervalMinutes,
    ),
  };
  await dbPut({ key: scanSettingsKey(uid), value: next });
  return next;
}

export async function getDriftBottleScanIntervalMs(userId = '') {
  let uid = String(userId || '').trim();
  if (!uid) {
    const user = await ensureDefaultUser().catch(() => null);
    uid = String(user?.id || '').trim();
  }
  const settings = await loadDriftBottleScanSettings(uid);
  return Math.max(60 * 1000, settings.scanIntervalMinutes * 60 * 1000);
}

function clampIntervalMinutes(raw) {
  return Math.max(5, Math.min(1440, Number(raw || 30) || 30));
}

function buildDriftBottleDirective(name, intervalMinutes) {
  return [
    '[被拉黑后的主账号联系失败]',
    `你已被对方拉黑，普通消息无法正常送达。这是按约 ${intervalMinutes} 分钟间隔触发的一次再次尝试：你仍然可以发消息，但对方侧会显示拒收/红色感叹号，对方未必会回。`,
    '节奏和条数跟平时聊天一样，按人设和当下情绪自然发挥，不设条数上限；辩解、道歉、死犟、试探、反应余波都行，不要装作不知道被拉黑，不要提系统、定时器或站外联系模块。',
    '正文只写你想说的话本身，不要自己加「发送失败」「已拉黑」这类方括号标签。',
  ].join('\n');
}

async function listDriftBottleTargets(userId) {
  const chats = await listChatsForUser(userId).catch(() => []);
  const targets = [];
  for (const chat of chats) {
    if (!chat?.id || chat.type === 'group' || isAnonymousChat(chat)) continue;
    if (!(chat.participants || []).includes('user')) continue;
    // eslint-disable-next-line no-await-in-loop
    const prefs = await loadChatPrefs(chat.id).catch(() => ({}));
    if (!isChatBlockedByUser(chat, prefs)) continue;
    const partnerId = (chat.participants || []).find((id) => id && id !== 'user');
    if (!partnerId) continue;
    targets.push({
      chat,
      partnerId: String(partnerId),
      intervalMinutes: clampIntervalMinutes(prefs.driftBottleIntervalMinutes),
      lastFiredAt: Number(prefs.driftBottleLastFiredAt || prefs.blockedAt || 0) || 0,
      failedRounds: Math.max(0, Number(prefs.blockedContactFailedRounds || 0) || 0),
      escalated: prefs.blockedContactEscalated === true,
      lastRoute: String(prefs.blockedContactLastRoute || '').trim(),
    });
  }
  return targets;
}

async function runForTarget(user, target, now, reason = '') {
  const {
    chat,
    partnerId,
    intervalMinutes,
    lastFiredAt,
    failedRounds,
    escalated,
    lastRoute,
  } = target;
  const gapMs = intervalMinutes * 60 * 1000;
  if (lastFiredAt && now - lastFiredAt < gapMs) {
    return { chatId: chat.id, skipped: true, reason: 'interval' };
  }

  const character = await getRecord('characters', partnerId).catch(() => null);
  if (!character) return { chatId: chat.id, skipped: true, reason: 'missing-character' };
  const { loadResolvedCharacterAutonomyPolicy } = await import('../character-autonomy-settings.js');
  const policy = await loadResolvedCharacterAutonomyPolicy(user.id, partnerId, chat.id).catch(() => null);
  if (policy?.totalEnabled !== true) {
    return { chatId: chat.id, characterId: partnerId, skipped: true, reason: 'proactive-disabled' };
  }

  if (escalated || failedRounds >= 2) {
    const reservation = await reserveProactiveDelivery({
      userId: user.id,
      characterId: partnerId,
      chatId: chat.id,
      channel: 'blocked-contact',
      idempotencyKey: `${chat.id}:blocked-contact:${lastFiredAt || 0}:${now}`,
      policy,
      now,
    }).catch((error) => ({ ok: false, reason: error?.message || 'reservation-failed' }));
    if (!reservation?.ok) {
      return {
        chatId: chat.id,
        characterId: partnerId,
        skipped: true,
        reason: reservation?.reason || 'reservation-failed',
        retryAt: reservation?.retryAt,
      };
    }
    const delivered = await deliverBlockedContactAttempt({
      user,
      chat,
      characterId: partnerId,
      blockReason: String((await loadChatPrefs(chat.id).catch(() => ({})))?.blockReason || ''),
      failedRounds,
      lastRoute,
      reason,
    }).catch((error) => ({ ok: false, reason: error?.message || String(error || 'failed') }));
    await settleProactiveDelivery({
      userId: user.id,
      characterId: partnerId,
      reservationId: reservation.reservationId,
      ok: delivered?.ok === true,
      messageCount: delivered?.ok ? 1 : 0,
      now,
      reason: delivered?.reason || '',
    }).catch(() => null);
    await patchChatPrefs(chat.id, {
      driftBottleLastFiredAt: now,
      ...(delivered?.ok ? {
        blockedContactEscalated: true,
        blockedContactLastRoute: delivered.route || '',
      } : {}),
    }).catch(() => {});
    return {
      chatId: chat.id,
      characterId: partnerId,
      generated: delivered?.ok === true,
      route: delivered?.route || '',
      reason: delivered?.reason || '',
    };
  }

  const name = getCharacterAiContextName(character) || character?.name || 'TA';
  const result = await runHeadlessChatReply(chat, user, {
    allowInactive: true,
    allowBlocked: true,
    reason,
    proactiveChannel: 'blocked-contact',
    proactiveIdempotencyKey: `${chat.id}:${lastFiredAt || 0}:${now}`,
    baseTimestamp: now,
    sceneDirective: buildDriftBottleDirective(name, intervalMinutes),
    skipBusyAutoReply: true,
  }).catch((err) => ({ ok: false, reason: err?.message || String(err || 'failed') }));

  // 无论成败都记下时间，避免 API 失败时下一分钟连打；失败时间隔照常走。
  await patchChatPrefs(chat.id, { driftBottleLastFiredAt: now }).catch(() => {});

  if (!result?.ok) {
    return { chatId: chat.id, characterId: partnerId, generated: false, reason: result?.reason || 'failed' };
  }

  const {
    bumpPersistedMessagesUnread,
    notifyCharacterSentMessageIfEnabled,
    shouldNotifyForBackgroundReason,
  } = await import('../native-notifications.js');
  await bumpPersistedMessagesUnread(chat.id, result.messages).catch(() => {});
  if (shouldNotifyForBackgroundReason(reason, chat.id)) {
    await notifyCharacterSentMessageIfEnabled({
      characterName: name,
      chatId: chat.id,
      tag: `blocked-contact-${partnerId}`,
      messages: result.messages,
      requireHidden: false,
      avatar: character?.avatar || '',
    }).catch(() => {});
  }

  return {
    chatId: chat.id,
    characterId: partnerId,
    generated: true,
    messageCount: Array.isArray(result.messages) ? result.messages.length : 0,
  };
}

export async function runDriftBottleProactiveCheck({ user: suppliedUser = null, userId = '', reason = '' } = {}) {
  if (_running) return { ok: false, reason: 'in-flight' };
  _running = true;
  try {
    const requestedUserId = String(userId || suppliedUser?.id || '').trim();
    const user = suppliedUser
      || (requestedUserId ? await getUserById(requestedUserId) : null)
      || await ensureDefaultUser();
    if (!user?.id) return { ok: false, reason: 'missing-user' };
    const now = await getNowForUser(user.id);
    const targets = await listDriftBottleTargets(user.id);
    if (!targets.length) return { ok: true, skipped: true, reason: 'no-blocked-chats', results: [] };

    const isCatchUp = /^catch-up:/i.test(String(reason || ''));
    const maxFire = isCatchUp ? CATCH_UP_MAX : TIMER_MAX;
    // 先处理等待最久的，避免总是打到同一批会话
    targets.sort((a, b) => (a.lastFiredAt || 0) - (b.lastFiredAt || 0));

    const results = [];
    let fired = 0;
    for (const target of targets) {
      if (fired >= maxFire) break;
      const gapMs = target.intervalMinutes * 60 * 1000;
      if (target.lastFiredAt && now - target.lastFiredAt < gapMs) {
        results.push({ chatId: target.chat.id, skipped: true, reason: 'interval' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await runForTarget(user, target, now, reason);
      results.push(r);
      if (r?.generated) fired += 1;
    }
    return { ok: true, reason, fired, results };
  } finally {
    _running = false;
  }
}
