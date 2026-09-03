import { getCharacter } from '../character-store.js';
import { loadChatPrefs, shouldSuppressAiDelivery } from '../chat-block-state.js';
import { getChat } from '../chat-store.js';
import {
  deleteRadioEpisode,
  generateRadioEpisode,
  getRadioEpisode,
  shareRadioEpisodeToChat,
} from '../radio-episodes.js';
import { getRadioPlan, listDueRadioPlans, updateRadioPlan } from '../radio-plans.js';
import { normalizeWorldBookIds } from '../world-book-store.js';
import { isSelectableContactCharacter } from '../../models/character.js';

const MAX_PER_TICK = 1;
const EXPIRE_AFTER_MS = 18 * 60 * 60 * 1000;
const GENERATION_LEASE_MS = 20 * 60 * 1000;

function retryDelay(attempt = 1) {
  return Math.min(60 * 60 * 1000, Math.max(2 * 60 * 1000, (2 ** Math.min(5, attempt - 1)) * 2 * 60 * 1000));
}

export async function runRadioPlanCheck(user, now = Date.now(), reason = '') {
  if (!user?.id) return { ok: false, reason: 'missing-user' };
  const due = await listDueRadioPlans(user.id, now);
  const results = [];
  for (const plan of due.slice(0, MAX_PER_TICK)) {
    if (now - plan.dueAt > EXPIRE_AFTER_MS) {
      await updateRadioPlan(user.id, plan.id, { status: 'expired', completedAt: now, leaseUntil: 0 });
      results.push({ planId: plan.id, skipped: true, reason: 'expired' });
      continue;
    }
    const character = await getCharacter(plan.characterId, { userId: user.id }).catch(() => null);
    if (!character || !isSelectableContactCharacter(character)) {
      await updateRadioPlan(user.id, plan.id, { status: 'cancelled', completedAt: now, lastError: 'ineligible-character' });
      results.push({ planId: plan.id, skipped: true, reason: 'ineligible-character' });
      continue;
    }
    const sourceChat = await getChat(plan.chatId).catch(() => null);
    if (!sourceChat || sourceChat.type !== 'private' || !(sourceChat.participants || []).includes(plan.characterId)) {
      await updateRadioPlan(user.id, plan.id, { status: 'cancelled', completedAt: now, lastError: 'missing-chat' });
      results.push({ planId: plan.id, skipped: true, reason: 'missing-chat' });
      continue;
    }
    const sourceChatPrefs = await loadChatPrefs(sourceChat.id).catch(() => ({}));
    const blocked = await shouldSuppressAiDelivery(sourceChat, { prefs: sourceChatPrefs })
      .catch(() => ({ blocked: false }));
    if (blocked.blocked) {
      results.push({ planId: plan.id, skipped: true, reason: 'blocked-by-user' });
      continue;
    }

    const attemptCount = plan.attemptCount + 1;
    const claimed = await updateRadioPlan(user.id, plan.id, {
      status: 'generating',
      attemptCount,
      leaseUntil: Date.now() + GENERATION_LEASE_MS,
      lastError: '',
    });
    if (!claimed) {
      results.push({ planId: plan.id, skipped: true, reason: 'claim-failed' });
      continue;
    }
    try {
      let episode = plan.episodeId ? await getRadioEpisode(plan.episodeId).catch(() => null) : null;
      if (!episode) {
        episode = await generateRadioEpisode({
          user,
          characterId: plan.characterId,
          type: plan.type,
          readingSeriesId: plan.readingSeriesId,
          topic: plan.topic,
          customPrompt: plan.note,
          // 角色自主制作没有电台页可供勾选：默认世界书规则照常生效，
          // 来源私聊额外启用的书以 additive 合并，不能误变成排他白名单。
          worldBookIds: normalizeWorldBookIds(sourceChatPrefs),
          worldBookSelectionMode: 'additive',
          actionMode: plan.actionMode,
          ambientEnabled: plan.ambientEnabled,
          minutes: plan.minutes,
        });
      }
      const current = await getRadioPlan(user.id, plan.id);
      if (!current || current.status !== 'generating' || current.updatedAt !== claimed?.updatedAt) {
        if (!plan.episodeId) await deleteRadioEpisode(episode.id).catch(() => {});
        results.push({ planId: plan.id, skipped: true, reason: 'plan-revised-during-generation' });
        continue;
      }
      await updateRadioPlan(user.id, plan.id, { episodeId: episode.id });
      const delivery = await shareRadioEpisodeToChat(episode.id, { idempotencyKey: plan.id });
      const recurrenceMs = plan.recurrence === 'daily'
        ? 24 * 60 * 60 * 1000
        : (plan.recurrence === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 0);
      const keepSeriesGoing = recurrenceMs > 0 && episode.readingSeries?.hasMore === true;
      await updateRadioPlan(user.id, plan.id, keepSeriesGoing ? {
        status: 'pending',
        dueAt: Math.max(Date.now(), plan.dueAt) + recurrenceMs,
        episodeId: '',
        completedAt: 0,
        leaseUntil: 0,
        retryAt: 0,
        lastError: '',
      } : {
        status: 'delivered',
        episodeId: episode.id,
        completedAt: Date.now(),
        leaseUntil: 0,
        retryAt: 0,
        lastError: '',
      });
      results.push({
        planId: plan.id,
        generated: delivery.alreadyShared !== true,
        delivered: true,
        characterId: plan.characterId,
        chatId: delivery.chat.id,
        message: delivery.message,
        episodeId: episode.id,
        reason,
      });
    } catch (error) {
      const message = String(error?.message || error || 'radio-plan-failed').slice(0, 240);
      await updateRadioPlan(user.id, plan.id, {
        status: 'pending',
        leaseUntil: 0,
        retryAt: Date.now() + retryDelay(attemptCount),
        lastError: message,
      }).catch(() => null);
      results.push({ planId: plan.id, skipped: true, reason: message });
    }
  }
  return { ok: true, processed: results.length, results };
}
