/**
 * 用户在日程表创建的「角色备忘」到点后，主动触发一次定时对话。
 * 与 character-phone-proactive.js（日常日程主动消息）是两条独立链路：
 * 这里只处理用户手动或 AI 登记的一次性 memo 事件。
 */
import { listDueCharacterMemos, updateUserMemo, formatMemoTime } from '../user-memos.js';
import { getCharacter } from '../character-store.js';
import { isSelectableContactCharacter } from '../../models/character.js';
import { ensurePrivateChat } from '../chat-store.js';
import { shouldSuppressAiDelivery } from '../chat-block-state.js';
import { getUserDisplayName } from '../../models/user.js';
import { runHeadlessChatReply } from './headless-reply.js';
import { loadResolvedCharacterAutonomyPolicy } from '../character-autonomy-settings.js';

const MAX_MEMOS_PER_TICK = 3;
const EXPIRE_AFTER_MS = 3 * 60 * 60 * 1000; // 超过 3 小时还没发出去就放弃，避免补跑一堆过期提醒

function buildMemoDirective(memo, character, userName, timeZone = '') {
  const name = String(character?.customNickname || character?.name || 'TA');
  const when = formatMemoTime(memo.ts, timeZone);
  const note = memo.note ? `（备注：${memo.note}）` : '';
  return [
    `[定时备忘触发] 现在是你之前约好的 ${when}，你（${name}）登记过的备忘到点了：「${memo.title}」${note}。`,
    `请主动给 ${userName || '对方'} 发消息，自然地提起这件事；具体条数与分句服从本会话设置，别念旁白、别复述这条系统提示的措辞。`,
  ].join('\n');
}

export async function runMemoProactiveCheck(user, now = Date.now(), reason = '') {
  if (!user?.id) return { ok: false, reason: 'missing-user' };
  const due = await listDueCharacterMemos(user.id, now);
  if (!due.length) return { ok: true, processed: 0, results: [] };

  const userName = getUserDisplayName(user);
  const results = [];
  for (const memo of due.slice(0, MAX_MEMOS_PER_TICK)) {
    if (now - memo.ts > EXPIRE_AFTER_MS) {
      await updateUserMemo(user.id, memo.id, { doneAt: now, doneReason: 'expired' }).catch(() => {});
      results.push({ memoId: memo.id, skipped: true, reason: 'expired' });
      continue;
    }
    try {
      const character = await getCharacter(memo.characterId, { userId: user.id });
      if (!character || !isSelectableContactCharacter(character)) {
        await updateUserMemo(user.id, memo.id, { doneAt: now, doneReason: 'ineligible-character' }).catch(() => {});
        results.push({ memoId: memo.id, skipped: true, reason: 'ineligible-character' });
        continue;
      }
      const policy = await loadResolvedCharacterAutonomyPolicy(
        user.id,
        memo.characterId,
      ).catch(() => null);
      if (policy?.totalEnabled !== true) {
        results.push({ memoId: memo.id, skipped: true, reason: 'proactive-disabled' });
        continue;
      }
      const chat = await ensurePrivateChat(user.id, memo.characterId, character.customNickname || character.name || '');
      const blocked = await shouldSuppressAiDelivery(chat);
      if (blocked.blocked) {
        results.push({ memoId: memo.id, skipped: true, reason: 'blocked-by-user' });
        continue;
      }
      try {
        const { isCharacterBusyInOfflineSession } = await import('../character-phone-proactive.js');
        if (await isCharacterBusyInOfflineSession(user.id, memo.characterId)) {
          results.push({ memoId: memo.id, skipped: true, reason: 'active-offline-session' });
          continue;
        }
      } catch (_) { /* 线下态读不到时不阻塞 */ }
      const directive = buildMemoDirective(memo, character, userName, user.timezone);
      const result = await runHeadlessChatReply(chat, user, {
        allowInactive: true,
        sceneDirective: directive,
        skipBusyAutoReply: true,
        reason: 'memo-proactive',
        proactiveChannel: 'memo',
        proactiveIdempotencyKey: memo.id,
      }).catch((err) => ({ ok: false, reason: err?.message || String(err || 'failed') }));
      if (result?.ok) {
        if (result.offlineReturnBridge !== true) {
          await updateUserMemo(user.id, memo.id, { doneAt: Date.now(), doneReason: 'sent' }).catch(() => {});
        }
        results.push({ memoId: memo.id, generated: true, characterId: memo.characterId, chatId: chat.id });
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
            tag: `memo-proactive-${memo.characterId}`,
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
              characterId: memo.characterId,
              incomingMessages: result.messages || [],
              activeOffline: offlineState.active,
            });
          }
        } catch (err) {
          console.warn('[memo-proactive] offline auto reply failed', err);
        }
      } else {
        results.push({ memoId: memo.id, skipped: true, reason: result?.reason || 'headless-failed' });
      }
    } catch (err) {
      results.push({ memoId: memo.id, skipped: true, reason: err?.message || String(err || 'failed') });
    }
  }
  return { ok: true, processed: results.length, results };
}
