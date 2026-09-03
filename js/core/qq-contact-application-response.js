import { getChat, listMessagesForChat, saveChat } from './chat-store.js';
import { isStrangerInterceptChat, transitionFriendship } from './stranger-thread-model.js';
import { principalKey } from './alias-account-model.js';
import { getCharacter } from './character-store.js';
import {
  isLightweightNpcId,
  promoteLightweightNpcToCharacter,
} from './lightweight-npc.js';
import { markQqContactApplicationDecision } from './qq-contact-applications.js';

const inFlight = new Map();

function clean(value) {
  return String(value ?? '').trim();
}

function isPendingApplication(chat) {
  const application = chat?.metadata?.contactApplication;
  const friendshipState = clean(chat?.metadata?.friendshipState);
  return isStrangerInterceptChat(chat)
    && !!clean(application?.id)
    && friendshipState === 'requested'
    && !['accepted', 'declined'].includes(clean(application?.status));
}

function isTerminalApplication(chat) {
  const status = clean(chat?.metadata?.contactApplication?.status);
  const friendshipState = clean(chat?.metadata?.friendshipState);
  return ['accepted', 'declined'].includes(status) || friendshipState === 'accepted';
}

export function inferQqContactApplicationDecision(messages = []) {
  const text = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && message.senderId !== 'user' && (!message.type || message.type === 'text'))
    .map((message) => clean(message.content))
    .filter(Boolean)
    .join('\n');
  if (!text) return null;
  const declined = /验证(?:没|未)通过|验证失败|(?:拒绝|不通过|没通过|不同意|不接受)(?:你|这次|这个)?(?:的)?好友(?:申请)?|(?:暂时|现在)?不想加(?:你)?(?:为)?好友|不加好友|算了吧/.test(text);
  if (declined) return { action: 'decline', reason: '从对方可见回复确认拒绝好友申请' };
  const accepted = /验证(?:已经)?通过|通过(?:了|你的|这次|这个)?(?:好友)?申请|同意(?:了|你的|这次|这个)?(?:好友)?申请|接受(?:了|你的|这次|这个)?(?:好友)?申请|(?:可以|愿意|那就|行吧|好啊|好吧).{0,8}(?:加|成为|做)(?:你|个)?好友|(?:已经|现在)?加上(?:你)?了|(?:我)?(?:加你|把你加|加了你)(?:为好友)?|我们(?:已经|现在)?是好友了/.test(text);
  return accepted ? { action: 'accept', reason: '从对方可见回复确认通过好友申请' } : null;
}

export function shouldAutoResumeQqContactApplication(chat, now = Date.now()) {
  if (!isPendingApplication(chat)) return false;
  const application = chat.metadata.contactApplication || {};
  if (['accept', 'decline'].includes(clean(application.responseDecision))) return true;
  const state = clean(application.responseState);
  if (state === 'failed') return false;
  if (state === 'running') {
    const attemptedAt = Math.max(0, Number(application.responseAttemptedAt) || 0);
    return attemptedAt > 0 && Number(now) - attemptedAt >= 2 * 60 * 1000;
  }
  if (state === 'queued') return true;
  return Math.max(0, Number(application.responseAttemptCount) || 0) === 0;
}

function applicationDirective(application = {}, phoneMemoryPromptBlock = '') {
  const name = clean(application.name) || '这位用户';
  return [
    `用户刚从“可能想认识的人”向「${name}」发送了好友申请。`,
    clean(phoneMemoryPromptBlock),
    clean(phoneMemoryPromptBlock)
      ? '这些记录只包含你亲自参与的对话；请自然承接，但不要声称看过通讯录主人的其他手机内容。'
      : '',
    '请按你已有的人设、关系和边界决定是否接受；不要因为这是用户操作就默认同意。',
    '本轮必须输出 stranger_friend，action 只能是 accept 或 decline，并给出一条简短自然的可见回复。',
  ].filter(Boolean).join('\n');
}

async function writeAttemptState(chatId, applicationId, patch = {}) {
  const latest = await getChat(chatId).catch(() => null);
  if (!latest || clean(latest.metadata?.contactApplication?.id) !== applicationId) return latest;
  if (!isPendingApplication(latest)) return latest;
  latest.metadata = {
    ...(latest.metadata || {}),
    contactApplication: {
      ...(latest.metadata?.contactApplication || {}),
      status: 'pending',
      ...patch,
    },
  };
  await saveChat(latest);
  return latest;
}

async function promoteApplicationActor(application, actorId, userId) {
  let promotedCharacterId = actorId;
  if (isLightweightNpcId(actorId)) {
    const existing = await getCharacter(actorId).catch(() => null);
    if (!existing) {
      const promoted = await promoteLightweightNpcToCharacter(actorId, { userId });
      promotedCharacterId = clean(promoted?.character?.id) || actorId;
    }
  }
  const phoneOwnerId = clean(application.phoneOwnerId);
  const phoneContactId = clean(application.phoneContactId);
  if (phoneOwnerId && phoneContactId) {
    const { getPhoneContact, upsertPhoneContact } = await import('./character-phone-contacts.js');
    const contact = await getPhoneContact(userId, phoneOwnerId, phoneContactId).catch(() => null);
    if (contact && clean(contact.linkedCharacterId) !== promotedCharacterId) {
      await upsertPhoneContact(userId, phoneOwnerId, {
        ...contact,
        id: contact.id,
        linkedCharacterId: promotedCharacterId,
      });
    }
  }
  return promotedCharacterId;
}

async function settleStoredDecision(chatId, applicationId, userId, action, reason = '') {
  const latest = await getChat(chatId).catch(() => null);
  if (!latest || clean(latest.metadata?.contactApplication?.id) !== applicationId) {
    return { ok: false, skipped: true, reason: 'application-changed' };
  }
  const application = latest.metadata.contactApplication || {};
  const actorId = (latest.participants || []).find((id) => id && id !== 'user' && id !== 'system') || '';
  if (!actorId) return { ok: false, reason: 'missing-contact-actor' };
  let promotedCharacterId = actorId;
  try {
    if (action === 'accept') {
      promotedCharacterId = await promoteApplicationActor(application, actorId, userId);
    }
  } catch (error) {
    const promotionError = clean(error?.message || error) || '联系人转正失败';
    await writeAttemptState(chatId, applicationId, {
      responseState: 'failed',
      responseDecision: action,
      responseDecisionReason: reason,
      responseFinishedAt: Date.now(),
      responseError: promotionError,
      promotionError,
    }).catch(() => null);
    return { ok: false, reason: promotionError, localPromotionFailed: true };
  }
  const status = action === 'accept' ? 'accepted' : 'declined';
  const nextState = action === 'accept' ? 'accepted' : 'intercepted';
  const now = Date.now();
  latest.metadata = {
    ...transitionFriendship(latest.metadata, nextState, {
      by: principalKey('character', actorId),
      at: now,
      reason,
    }),
    friendshipDecisionBy: principalKey('character', actorId),
    friendshipDecisionAt: now,
    friendshipDecision: action,
    friendshipDecisionReason: reason,
    contactApplication: {
      ...application,
      status,
      responseState: 'complete',
      responseDecision: action,
      responseDecisionReason: reason,
      responseFinishedAt: now,
      responseError: '',
      decidedAt: now,
      decisionReason: reason,
      promotedCharacterId: action === 'accept' ? promotedCharacterId : '',
      promotionError: '',
    },
  };
  await saveChat(latest);
  await markQqContactApplicationDecision(userId, applicationId, {
    status,
    reason,
    characterId: promotedCharacterId,
    chatId,
  }).catch(() => null);
  return { ok: true, decided: true, chat: latest, promotedCharacterId };
}

export async function recoverQqContactApplicationFromHistory(chat, user) {
  const chatId = clean(chat?.id);
  const latest = chatId ? await getChat(chatId).catch(() => chat) : chat;
  const applicationId = clean(latest?.metadata?.contactApplication?.id);
  if (chatId && applicationId && isTerminalApplication(latest)) {
    return { ok: true, decided: true, chat: latest, alreadySettled: true };
  }
  if (!chatId || !applicationId || !isPendingApplication(latest)) {
    return { ok: false, skipped: true, reason: 'not-pending' };
  }
  const application = latest.metadata.contactApplication || {};
  const storedDecision = clean(application.responseDecision);
  if (['accept', 'decline'].includes(storedDecision)) {
    return settleStoredDecision(
      chatId,
      applicationId,
      clean(user?.id),
      storedDecision,
      clean(application.responseDecisionReason) || '恢复上次已经作出的好友决定',
    );
  }
  const attempted = clean(application.responseState) === 'failed'
    || Math.max(0, Number(application.responseAttemptCount) || 0) > 0;
  if (!attempted) return { ok: false, skipped: true, reason: 'no-prior-attempt' };
  const messages = await listMessagesForChat(chatId, 40).catch(() => []);
  const inferred = inferQqContactApplicationDecision(messages.slice(-40));
  if (!inferred) return { ok: false, skipped: true, reason: 'no-visible-decision' };
  await writeAttemptState(chatId, applicationId, {
    responseDecision: inferred.action,
    responseDecisionReason: inferred.reason,
  });
  return settleStoredDecision(
    chatId,
    applicationId,
    clean(user?.id),
    inferred.action,
    inferred.reason,
  );
}

/**
 * 驱动“发送好友申请 → 对方决定 → 陌生线程转好友/拒绝”的可恢复链路。
 * 页面跳转不会取消它；若进程中断，重新打开待处理线程只恢复本地决定或安全领取未完成任务。
 */
export async function resolveQqContactApplication(chat, user, {
  phoneMemoryPromptBlock = '',
  forceRetry = false,
} = {}) {
  const chatId = clean(chat?.id);
  const applicationId = clean(chat?.metadata?.contactApplication?.id);
  if (chatId && applicationId && isTerminalApplication(chat)) {
    return { ok: true, decided: true, chat, alreadySettled: true };
  }
  if (!chatId || !applicationId || !isPendingApplication(chat)) {
    return { ok: false, skipped: true, reason: 'not-pending' };
  }
  if (inFlight.has(chatId)) return inFlight.get(chatId);

  const task = (async () => {
    const latest = await getChat(chatId).catch(() => chat);
    if (isTerminalApplication(latest)) {
      return { ok: true, decided: true, chat: latest, alreadySettled: true };
    }
    if (!isPendingApplication(latest)) {
      return { ok: false, skipped: true, reason: 'not-pending' };
    }
    const recovered = await recoverQqContactApplicationFromHistory(latest, user);
    if (recovered?.decided) return recovered;
    const refreshed = await getChat(chatId).catch(() => latest);
    if (!isPendingApplication(refreshed)) {
      return { ok: true, decided: true, chat: refreshed };
    }
    if (!forceRetry && !shouldAutoResumeQqContactApplication(refreshed)) {
      return { ok: false, skipped: true, reason: 'awaiting-manual-retry' };
    }
    const activeApplication = refreshed.metadata.contactApplication;
    const attemptCount = Math.max(0, Number(activeApplication.responseAttemptCount) || 0) + 1;
    await writeAttemptState(chatId, applicationId, {
      responseState: 'running',
      responseAttemptCount: attemptCount,
      responseAttemptedAt: Date.now(),
      responseError: '',
    });

    try {
      const { runHeadlessChatReply } = await import('./chat/headless-reply.js');
      const result = await runHeadlessChatReply(latest, user, {
        allowInactive: true,
        ignoreComposerBusy: true,
        skipBusyAutoReply: true,
        bypassCatchUpGenerationCap: true,
        sceneDirective: applicationDirective(activeApplication, phoneMemoryPromptBlock),
        reason: 'qq-contact-application',
        allowedSideEffectTypes: ['stranger_friend'],
      });
      const settled = await getChat(chatId).catch(() => null);
      const decided = !isPendingApplication(settled);
      if (decided) return { ...result, ok: true, decided: true, chat: settled };

      const inferred = inferQqContactApplicationDecision(result?.messages || []);
      if (inferred) {
        await writeAttemptState(chatId, applicationId, {
          responseDecision: inferred.action,
          responseDecisionReason: inferred.reason,
        });
        const local = await settleStoredDecision(
          chatId,
          applicationId,
          clean(user?.id),
          inferred.action,
          inferred.reason,
        );
        return { ...result, ...local, inferredDecision: true };
      }

      const reason = clean(result?.reason || result?.message) || '未收到好友决定';
      await writeAttemptState(chatId, applicationId, {
        responseState: 'failed',
        responseFinishedAt: Date.now(),
        responseError: reason,
      });
      return { ...result, ok: false, reason };
    } catch (error) {
      const reason = clean(error?.message || error) || '好友申请回应生成失败';
      await writeAttemptState(chatId, applicationId, {
        responseState: 'failed',
        responseFinishedAt: Date.now(),
        responseError: reason,
      }).catch(() => null);
      return { ok: false, reason, error };
    }
  })().finally(() => {
    inFlight.delete(chatId);
  });
  inFlight.set(chatId, task);
  return task;
}
