import { loadPeriodTracker, getPeriodStatus, hasPeriodReminderBeenSent, markPeriodReminderSent } from '../period-tracker.js';
import { getCharacter } from '../character-store.js';
import { ensurePrivateChat, listMessagesForChat } from '../chat-store.js';
import { shouldSuppressAiDelivery } from '../chat-block-state.js';
import { runHeadlessChatReply } from './headless-reply.js';
import { getUserDisplayName } from '../../models/user.js';
import {
  isCharacterAutonomyMutedNow,
  loadResolvedCharacterAutonomyPolicy,
} from '../character-autonomy-settings.js';

const RECENT_CHARACTER_MESSAGE_MS = 6 * 60 * 60 * 1000;

function eligibleReminder(status) {
  if (status?.phase === 'upcoming' && status.daysUntil >= 1 && status.daysUntil <= 3) return 'upcoming';
  if (status?.phase === 'during' && status.dayInPeriod >= 1 && status.dayInPeriod <= 2) return 'during';
  return '';
}

function reminderKey(status, kind) {
  // nextStart is stable for an upcoming window and for the associated predicted/recorded period.
  const anchor = Number(status?.nextStart || 0);
  return anchor && kind ? `${kind}:${anchor}` : '';
}

async function hasRecentMessageFromCharacter(chatId, characterId, now) {
  const messages = await listMessagesForChat(chatId, 16).catch(() => []);
  return messages.some((message) => (
    message?.senderId === characterId
    && !message.deleted
    && !message.recalled
    && now - Number(message.timestamp || 0) < RECENT_CHARACTER_MESSAGE_MS
  ));
}

function buildPeriodReminderDirective({ status, userName }) {
  const timing = status.phase === 'upcoming'
    ? '对方的生理期预计快到了'
    : '对方大约正处在生理期的前两天';
  return [
    `[私密关心提醒] ${timing}。请以你自己的口吻，给 ${userName || '对方'} 发一轮自然消息；具体数量与分条服从【回复节奏 · 错落】。`,
    '这是一次自然关心：优先接住最近话题，并结合人物关系与当前处境交出真实内容，不要退回公式化问候。不要提系统、预测、周期、记录或任何医学结论。',
    '禁止说教、反复追问、提醒喝热水/少吃凉的，或暗示对方不能工作、出门、运动、社交。若对方没有接这个话题，立刻回到普通聊天。',
  ].join('\n');
}

async function runPeriodProactiveForTarget(user, tracker, target, status, key, now, reason) {
  const reminderCharacterId = String(target?.characterId || '').trim();
  const reminderChatId = String(target?.chatId || '').trim();
  const character = await getCharacter(reminderCharacterId, { userId: user.id }).catch(() => null);
  if (!character) return { ok: false, skipped: true, reason: 'missing-character' };
  const policy = await loadResolvedCharacterAutonomyPolicy(
    user.id,
    reminderCharacterId,
    reminderChatId,
  ).catch(() => null);
  if (policy?.totalEnabled !== true) {
    return { ok: true, skipped: true, reason: 'proactive-disabled' };
  }
  if (await isCharacterAutonomyMutedNow(user.id, reminderCharacterId, now)) {
    return { ok: true, skipped: true, reason: 'mute-hours' };
  }
  try {
    const { isCharacterBusyInOfflineSession } = await import('../character-phone-proactive.js');
    if (await isCharacterBusyInOfflineSession(user.id, reminderCharacterId)) {
      return { ok: true, skipped: true, reason: 'active-offline-session' };
    }
  } catch (_) { /* 线下态读不到时不阻塞 */ }
  const chat = await ensurePrivateChat(user.id, reminderCharacterId, character.customNickname || character.name || '');
  if (reminderChatId && chat.id !== reminderChatId) {
    return { ok: true, skipped: true, reason: 'bound-chat-missing' };
  }
  const blocked = await shouldSuppressAiDelivery(chat);
  if (blocked.blocked) return { ok: true, skipped: true, reason: 'blocked-by-user' };
  if (await hasRecentMessageFromCharacter(chat.id, reminderCharacterId, now)) {
    return { ok: true, skipped: true, reason: 'recent-character-message' };
  }

  const result = await runHeadlessChatReply(chat, user, {
    allowInactive: true,
    reason,
    proactiveChannel: 'period-care',
    proactiveIdempotencyKey: `${key}:${now}`,
    baseTimestamp: now,
    sceneDirective: buildPeriodReminderDirective({ status, userName: getUserDisplayName(user) }),
    skipBusyAutoReply: true,
  }).catch((error) => ({ ok: false, reason: error?.message || String(error || 'failed') }));
  if (!result?.ok || !result.messageCount) {
    return { ok: false, reason: result?.reason || 'headless-failed' };
  }

  if (result.offlineReturnBridge !== true) {
    await markPeriodReminderSent(user.id, key, now);
  }
  const {
    bumpPersistedMessagesUnread,
    notifyCharacterSentMessageIfEnabled,
    shouldNotifyForBackgroundReason,
  } = await import('../native-notifications.js');
  if (shouldNotifyForBackgroundReason(reason, chat.id)) {
    await bumpPersistedMessagesUnread(chat.id, result.messages).catch(() => {});
    await notifyCharacterSentMessageIfEnabled({
      characterName: character.customNickname || character.name || '',
      chatId: chat.id,
      tag: `period-proactive-${reminderCharacterId}-${key}`,
      messages: result.messages,
      requireHidden: false,
      avatar: character.avatar || '',
    }).catch(() => {});
  }
  try {
    const [{ collectOfflineState }, { maybeRunOfflineAutoReply }] = await Promise.all([
      import('../character-phone-proactive.js'),
      import('../offline-auto-reply.js'),
    ]);
    const offlineState = await collectOfflineState(user.id);
    if (offlineState.active) {
      await maybeRunOfflineAutoReply({
        user,
        chat,
        characterId: reminderCharacterId,
        incomingMessages: result.messages || [],
        activeOffline: offlineState.active,
      });
    }
  } catch (error) {
    console.warn('[period-proactive] offline auto reply failed', error);
  }
  return { ok: true, generated: true, characterId: reminderCharacterId, chatId: chat.id, key };
}

export async function runPeriodProactiveCheck(user, now = Date.now(), reason = '') {
  if (!user?.id) return { ok: false, reason: 'missing-user' };
  const tracker = await loadPeriodTracker(user.id);
  if (!tracker.remindAi || !tracker.history.length || !tracker.reminderTargets.length) {
    return { ok: true, skipped: true, reason: 'disabled-or-unbound' };
  }
  const status = getPeriodStatus(tracker, now);
  const kind = eligibleReminder(status);
  const baseKey = reminderKey(status, kind);
  if (!baseKey) return { ok: true, skipped: true, reason: 'outside-window' };

  let lastResult = { ok: true, skipped: true, reason: 'already-sent' };
  for (let index = 0; index < tracker.reminderTargets.length; index += 1) {
    const target = tracker.reminderTargets[index];
    const key = `${baseKey}:${target.characterId}`;
    // 旧版日志没有角色后缀，只能对应迁移后的第一位提醒对象。
    if (hasPeriodReminderBeenSent(tracker, key)
      || (index === 0 && hasPeriodReminderBeenSent(tracker, baseKey))) continue;
    lastResult = await runPeriodProactiveForTarget(user, tracker, target, status, key, now, reason);
    // 每次后台轮询最多真正生成一位角色的消息，避免多选后同一时刻集中轰炸。
    if (lastResult.generated) return lastResult;
  }
  return lastResult;
}
