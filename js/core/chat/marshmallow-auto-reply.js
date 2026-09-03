import { getNowForUser } from '../time-mode.js';
import {
  dateKeyFromTimestamp,
  getDailyLifePlanForDate,
  pickCurrentPlanBlock,
  pruneExpiredCharacterPhoneSchedules,
  saveCharacterPhone,
} from '../character-phone-store.js';
import { sanitizeAiTranslation } from '../translation-utils.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 未过期的会话级 / 日程块自动回复。 */
export function getLiveAutoReplyRecord(autoReply, now = Date.now()) {
  if (!autoReply || typeof autoReply !== 'object') return null;
  const text = clean(autoReply.text, 120);
  if (!text) return null;
  const expireAt = Number(autoReply.expireAt || 0) || 0;
  if (expireAt && now > expireAt) return null;
  return { ...autoReply, text, expireAt };
}

export async function applyMarshmallowAutoReplyEvents(events = [], options = {}) {
  const userId = String(options.userId || options.user?.id || '').trim();
  if (!userId) return { handled: 0, skipped: asArray(events).length, errors: [{ message: 'missing_user' }] };
  const now = await getNowForUser(userId).catch(() => Date.now());
  const dateKey = dateKeyFromTimestamp(now);
  let handled = 0;
  let skipped = 0;
  const errors = [];

  for (const event of asArray(events).filter((item) => item?.t === 'auto_reply')) {
    const characterId = clean(event.from || event.actor || event.senderId || '', 80);
    const clearRequested = event.clear === true
      || event.stop === true
      || event.action === 'clear'
      || event.action === 'stop'
      || event.enabled === false;
    const text = clean(event.text || event.body || event.content || '', 120);
    if (!characterId || (!text && !clearRequested)) {
      skipped += 1;
      continue;
    }
    try {
      const phone = (await pruneExpiredCharacterPhoneSchedules(userId, characterId, dateKey)).phone;
      if (clearRequested) {
        const nextPlans = asArray(phone.dailyLifePlans).map((item) => {
          if (String(item?.dateKey || '') !== dateKey) return item;
          return {
            ...item,
            blocks: asArray(item.blocks).map((block) => (
              block?.autoReply
                ? { ...block, autoReply: null, busy: event.setBusy === true ? true : false }
                : (event.setBusy === false ? { ...block, busy: false } : block)
            )),
          };
        });
        await saveCharacterPhone({
          ...phone,
          sessionAutoReply: null,
          dailyLifePlans: nextPlans,
          busyAutoReplyState: {
            ...(phone.busyAutoReplyState || {}),
            sparseUntil: 0,
            sparseStartedAt: 0,
            wokeKey: '',
            silentNoCopy: false,
            lastRepliedAt: 0,
          },
        });
        handled += 1;
        continue;
      }
      const durationMinutes = Math.max(5, Math.min(480, Number(event.durationMinutes || 90) || 90));
      const translationProfile = options.characters?.[characterId]?.translationProfile || {};
      const translation = sanitizeAiTranslation(text, event.zh || event.translation || '', {
        languageHint: translationProfile.language || translationProfile.dialectNote || '',
      });
      const autoReply = {
        text,
        ...(translation ? { translation } : {}),
        setAt: now,
        expireAt: now + durationMinutes * 60 * 1000,
        pool: [],
        source: 'marshmallow-auto-reply',
        reason: clean(event.reason || '', 120),
        label: '系统自动回复',
        chatId: clean(options.chatId || options.chat?.id || '', 120),
      };
      const plan = getDailyLifePlanForDate(phone, dateKey);
      const targetBlock = plan?.blocks?.length
        ? (event.blockId
          ? asArray(plan.blocks).find((block) => String(block?.id || '') === String(event.blockId || ''))
          : pickCurrentPlanBlock(plan, now))
        : null;
      const nextPlans = targetBlock?.id
        ? asArray(phone.dailyLifePlans).map((item) => {
          if (String(item?.dateKey || '') !== dateKey) return item;
          return {
            ...item,
            blocks: asArray(item.blocks).map((block) => (
              String(block?.id || '') === String(targetBlock.id || '')
                ? {
                  ...block,
                  busy: event.setBusy !== false ? true : block.busy === true,
                  autoReply,
                }
                : block
            )),
          };
        })
        : asArray(phone.dailyLifePlans);
      await saveCharacterPhone({
        ...phone,
        sessionAutoReply: autoReply,
        dailyLifePlans: nextPlans,
        // 新设自动回复时清掉抽空窗口，重新进入「忙碌挡刀」循环。
        busyAutoReplyState: {
          ...(phone.busyAutoReplyState || {}),
          sparseUntil: 0,
          sparseStartedAt: 0,
          wokeKey: '',
          silentNoCopy: false,
        },
      });
      handled += 1;
    } catch (error) {
      skipped += 1;
      errors.push({ message: clean(error?.message || error || 'auto_reply_failed', 160) });
    }
  }
  return { handled, skipped, errors };
}
