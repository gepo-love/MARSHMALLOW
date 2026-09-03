/**
 * Tiny synchronous shadow outbox for a user message and its real-person reply ticket.
 *
 * The chat page stages an entry before its first await. Recovery first makes the
 * exact message durable, then creates the matching pending action, and only then
 * removes the shadow. Uncertain storage/policy state always keeps the entry.
 */

export const REPLY_INTENT_OUTBOX_KEY = 'mm_reply_intent_outbox_v1';
export const REPLY_INTENT_OUTBOX_KEY_PREFIX = `${REPLY_INTENT_OUTBOX_KEY}:`;
export const REPLY_INTENT_OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const REPLY_INTENT_OUTBOX_MAX_ENTRIES = 24;
export const REPLY_INTENT_OUTBOX_MAX_ENTRY_BYTES = 64 * 1024;
export const REPLY_INTENT_OUTBOX_MAX_TOTAL_BYTES = 1024 * 1024;

let recoveryInFlight = null;
let recoveryInstalled = false;
let lastQueuedMessageScanAt = 0;

function clean(value = '') {
  return String(value ?? '').trim();
}

function storage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function byteLength(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  try { return new TextEncoder().encode(text).length; } catch (_) { return text.length * 2; }
}

function entryKey({ userId = '', chatId = '', messageId = '' } = {}) {
  return `${clean(userId)}\n${clean(chatId)}\n${clean(messageId)}`;
}

function storageKeyForEntryKey(key = '') {
  return `${REPLY_INTENT_OUTBOX_KEY_PREFIX}${encodeURIComponent(clean(key))}`;
}

function listEntriesStrict() {
  const target = storage();
  if (!target) throw new Error('localStorage unavailable');
  const entries = [];
  const keys = [];
  for (let index = 0; index < Number(target.length || 0); index += 1) {
    const key = target.key(index);
    if (String(key || '').startsWith(REPLY_INTENT_OUTBOX_KEY_PREFIX)) keys.push(key);
  }
  for (const key of keys) {
    const raw = target.getItem(key);
    // Another tab may have completed this entry between key() and getItem().
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw);
      if (!entry || typeof entry !== 'object' || !clean(entry.key)) throw new Error('malformed');
      entries.push(entry);
    } catch (_) {
      // shadow 只是消息/票据的恢复副本。一个损坏 key 不能让所有后续发送失去
      // 保护；隔离删除该项，真实 messages/pending-actions 仍是业务主数据。
      try { target.removeItem(key); } catch (_) {}
    }
  }
  return entries;
}

function readEntryStrict(key = '') {
  const target = storage();
  if (!target) throw new Error('localStorage unavailable');
  const raw = target.getItem(storageKeyForEntryKey(key));
  if (!raw) return null;
  const entry = JSON.parse(raw);
  if (!entry || typeof entry !== 'object' || clean(entry.key) !== clean(key)) {
    throw new Error('reply intent outbox entry is malformed');
  }
  return entry;
}

function writeEntryStrict(entry) {
  const target = storage();
  if (!target) throw new Error('localStorage unavailable');
  target.setItem(storageKeyForEntryKey(entry?.key), JSON.stringify(entry));
  // Re-read the same per-message key. Unlike a shared array, another tab staging a
  // different message cannot overwrite this record between read and write.
  const confirmed = readEntryStrict(entry?.key);
  if (!confirmed || clean(confirmed.generationTaskId) !== clean(entry?.generationTaskId)) {
    throw new Error('reply intent outbox write was not confirmed');
  }
  return true;
}

function removeEntryStrict(key = '') {
  const target = storage();
  if (!target) throw new Error('localStorage unavailable');
  const storageKey = storageKeyForEntryKey(key);
  target.removeItem(storageKey);
  if (target.getItem(storageKey) != null) throw new Error('reply intent outbox clear was not confirmed');
  return true;
}

function normalizeStagedEntry({
  userId = '',
  chatId = '',
  characterId = '',
  message = null,
  dueAt = 0,
  requiresReply = true,
} = {}, now = Date.now()) {
  const uid = clean(userId);
  const cid = clean(chatId || message?.chatId);
  const actorId = clean(characterId);
  const messageId = clean(message?.id);
  const anchorTimestamp = Number(message?.timestamp || 0);
  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const generationTaskId = clean(metadata.generationTaskId);
  const generationIdempotencyKey = clean(metadata.generationIdempotencyKey);
  const generationAiRoundId = clean(metadata.generationAiRoundId);
  if (
    !uid
    || !cid
    || !actorId
    || !messageId
    || !Number.isFinite(anchorTimestamp)
    || anchorTimestamp <= 0
    || clean(message?.chatId) !== cid
    || clean(message?.senderId) !== 'user'
    || metadata.userComposedAsCharacter === true
    || !generationTaskId
    || !generationIdempotencyKey
    || !generationAiRoundId
  ) return null;
  const stagedAt = Math.max(1, Number(now) || Date.now());
  const replyRequired = requiresReply !== false
    && metadata.deliveryBlockedByCharacter !== true
    && clean(metadata.deliveryStatus) !== 'rejected';
  let messageSnapshot;
  try {
    messageSnapshot = cloneJson(message);
    messageSnapshot.metadata = {
      ...(messageSnapshot.metadata || {}),
      replyIntentState: replyRequired ? 'queued' : 'blocked',
      replyIntentQueuedAt: Number(metadata.replyIntentQueuedAt || 0) || stagedAt,
      replyIntentAnchorMessageId: messageId,
      replyIntentAnchorTimestamp: anchorTimestamp,
      ...(!replyRequired ? {
        replyIntentCompletedAt: Number(metadata.replyIntentCompletedAt || 0) || stagedAt,
        replyIntentBlockedAt: Number(metadata.replyIntentBlockedAt || 0) || stagedAt,
      } : {}),
    };
  } catch (_) { return null; }
  return {
    version: 1,
    key: entryKey({ userId: uid, chatId: cid, messageId }),
    userId: uid,
    chatId: cid,
    characterId: actorId,
    messageId,
    anchorTimestamp,
    generationTaskId,
    generationIdempotencyKey,
    generationAiRoundId,
    message: messageSnapshot,
    stagedAt,
    // 给原发送页完成世界钟修正、正则处理和 messages 落库一个短窗口；另一标签
    // 收到 storage 事件时不得抢先用临时时间戳创建旧锚点票据。
    recoverAfter: stagedAt + 3000,
    expiresAt: stagedAt + REPLY_INTENT_OUTBOX_TTL_MS,
    requestedDueAt: Math.max(0, Number(dueAt || 0)),
    requiresReply: replyRequired,
    attempts: 0,
    lastAttemptAt: 0,
    lastError: '',
    expiredLoggedAt: 0,
  };
}

/** Synchronous and fail-closed: false means the caller must not treat the intent as durable. */
export function stageReplyIntentOutbox(input = {}) {
  try {
    const staged = normalizeStagedEntry(input);
    if (!staged || byteLength(staged) > REPLY_INTENT_OUTBOX_MAX_ENTRY_BYTES) return false;
    const now = Date.now();
    const entries = listEntriesStrict().filter((entry) => {
      if (Number(entry?.expiresAt || 0) > now) return true;
      try { removeEntryStrict(entry.key); } catch (_) {}
      return false;
    });
    const existing = readEntryStrict(staged.key);
    if (existing && (
      clean(existing.generationTaskId) !== staged.generationTaskId
      || clean(existing.generationIdempotencyKey) !== staged.generationIdempotencyKey
      || clean(existing.generationAiRoundId) !== staged.generationAiRoundId
    )) return false;
    const sameUserEntries = entries.filter((entry) => clean(entry?.userId) === staged.userId);
    if (!existing && sameUserEntries.length >= REPLY_INTENT_OUTBOX_MAX_ENTRIES) return false;
    const nextEntry = existing
      ? {
        ...staged,
        stagedAt: Math.max(1, Number(existing.stagedAt || staged.stagedAt)),
        expiresAt: Math.max(
          Number(existing.expiresAt || 0),
          Number(staged.expiresAt || 0),
        ),
        requiresReply: existing.requiresReply === false ? false : staged.requiresReply,
        attempts: Math.max(0, Number(existing.attempts || 0)),
        lastAttemptAt: Math.max(0, Number(existing.lastAttemptAt || 0)),
        lastError: clean(existing.lastError),
        expiredLoggedAt: Math.max(0, Number(existing.expiredLoggedAt || 0)),
      }
      : staged;
    const totalBytes = sameUserEntries
      .filter((entry) => clean(entry?.key) !== staged.key)
      .reduce((total, entry) => total + byteLength(entry), byteLength(nextEntry));
    if (totalBytes > REPLY_INTENT_OUTBOX_MAX_TOTAL_BYTES) return false;
    writeEntryStrict(nextEntry);
    input.message.metadata = cloneJson(nextEntry.message.metadata);
    return true;
  } catch (_) {
    return false;
  }
}

export function completeReplyIntentOutbox(messageId, {
  userId = '',
  chatId = '',
  generationTaskId = '',
} = {}) {
  const mid = clean(messageId);
  if (!mid) return false;
  try {
    const entries = listEntriesStrict();
    const uid = clean(userId);
    const cid = clean(chatId);
    const taskId = clean(generationTaskId);
    const matches = entries.filter((entry) => (
      clean(entry?.messageId) === mid
      && (!uid || clean(entry?.userId) === uid)
      && (!cid || clean(entry?.chatId) === cid)
      && (!taskId || clean(entry?.generationTaskId) === taskId)
    ));
    if (!matches.length) return false;
    for (const entry of matches) removeEntryStrict(entry.key);
    return true;
  } catch (_) {
    return false;
  }
}

function patchReplyIntentOutboxEntry(key, patch = {}) {
  try {
    const entry = readEntryStrict(key);
    if (!entry) return false;
    writeEntryStrict({ ...entry, ...patch });
    return true;
  } catch (_) {
    return false;
  }
}

function ticketMatchesEntry(action, entry) {
  const payload = action?.payload || {};
  return !!clean(action?.id)
    && clean(action?.chatId) === clean(entry.chatId)
    && clean(payload.anchorMessageId) === clean(entry.messageId)
    && Number(payload.anchorTimestamp || 0) === Number(entry.anchorTimestamp || 0)
    && clean(payload.generationTaskId) === clean(entry.generationTaskId)
    && clean(payload.generationIdempotencyKey) === clean(entry.generationIdempotencyKey)
    && clean(payload.generationAiRoundId) === clean(entry.generationAiRoundId);
}

function newerTicketCanSupersedeEntry(action, entry) {
  const payload = action?.payload || {};
  return !!clean(action?.id)
    && clean(action?.kind) === 'real_person_reply'
    && clean(action?.userId) === clean(entry.userId)
    && clean(action?.characterId) === clean(entry.characterId)
    && clean(action?.chatId) === clean(entry.chatId)
    && !!clean(payload.anchorMessageId)
    && Number(payload.anchorTimestamp || 0) > Number(entry.anchorTimestamp || 0)
    && !!clean(payload.generationTaskId)
    && !!clean(payload.generationIdempotencyKey)
    && !!clean(payload.generationAiRoundId);
}

function storedMessageMatchesTicket(message, action) {
  const payload = action?.payload || {};
  const metadata = message?.metadata || {};
  return clean(message?.id) === clean(payload.anchorMessageId)
    && clean(message?.chatId) === clean(action?.chatId)
    && clean(message?.senderId) === 'user'
    && message?.metadata?.userComposedAsCharacter !== true
    && Number(message?.timestamp || 0) === Number(payload.anchorTimestamp || 0)
    && clean(metadata.generationTaskId) === clean(payload.generationTaskId)
    && clean(metadata.generationIdempotencyKey) === clean(payload.generationIdempotencyKey)
    && clean(metadata.generationAiRoundId) === clean(payload.generationAiRoundId);
}

function storedMessageMatchesEntry(message, entry) {
  if (!message) return false;
  const metadata = message.metadata || {};
  return clean(message.id) === clean(entry.messageId)
    && clean(message.chatId) === clean(entry.chatId)
    && clean(message.senderId) === 'user'
    && metadata.userComposedAsCharacter !== true
    && Number(message.timestamp || 0) === Number(entry.anchorTimestamp || 0)
    && clean(metadata.generationTaskId) === clean(entry.generationTaskId)
    && clean(metadata.generationIdempotencyKey) === clean(entry.generationIdempotencyKey)
    && clean(metadata.generationAiRoundId) === clean(entry.generationAiRoundId);
}

function messageIsReplyBlocked(message, entry) {
  const metadata = message?.metadata || {};
  return entry?.requiresReply === false
    || metadata.deliveryBlockedByCharacter === true
    || clean(metadata.deliveryStatus) === 'rejected';
}

async function persistReplyIntentResolution(message, entry, adapters, {
  state,
  actionId = '',
  supersededByActionId = '',
  supersededByMessageId = '',
  at = Date.now(),
} = {}) {
  const resolvedState = clean(state);
  const resolvedAt = Math.max(1, Number(at) || Date.now());
  if (!['scheduled', 'disabled', 'blocked', 'superseded'].includes(resolvedState)) {
    throw new Error('invalid reply intent resolution');
  }
  const resolved = cloneJson(message);
  resolved.metadata = {
    ...(resolved.metadata || {}),
    replyIntentState: resolvedState,
    replyIntentCompletedAt: resolvedAt,
    replyIntentActionId: resolvedState === 'scheduled' ? clean(actionId) : '',
    ...(resolvedState === 'scheduled' ? { replyIntentScheduledAt: resolvedAt } : {}),
    ...(resolvedState === 'disabled' ? { replyIntentDisabledAt: resolvedAt } : {}),
    ...(resolvedState === 'blocked' ? { replyIntentBlockedAt: resolvedAt } : {}),
    ...(resolvedState === 'superseded' ? {
      replyIntentSupersededAt: resolvedAt,
      replyIntentSupersededByActionId: clean(supersededByActionId),
      replyIntentSupersededByMessageId: clean(supersededByMessageId),
    } : {}),
  };
  if (resolvedState === 'scheduled' && !clean(actionId)) {
    throw new Error('reply ticket id unavailable');
  }
  if (
    resolvedState === 'superseded'
    && (!clean(supersededByActionId) || !clean(supersededByMessageId))
  ) {
    throw new Error('newer reply ticket marker unavailable');
  }
  await adapters.saveMessage(resolved);
  const confirmed = await adapters.getRecord('messages', entry.messageId);
  if (!storedMessageMatchesEntry(confirmed, entry)) {
    throw new Error('resolved message identity was not confirmed');
  }
  const confirmedMetadata = confirmed?.metadata || {};
  if (clean(confirmedMetadata.replyIntentState) !== resolvedState) {
    throw new Error('reply intent resolution was not confirmed');
  }
  if (
    resolvedState === 'scheduled'
    && clean(confirmedMetadata.replyIntentActionId) !== clean(actionId)
  ) {
    throw new Error('reply ticket marker was not confirmed');
  }
  if (
    resolvedState === 'superseded'
    && (
      clean(confirmedMetadata.replyIntentSupersededByActionId) !== clean(supersededByActionId)
      || clean(confirmedMetadata.replyIntentSupersededByMessageId) !== clean(supersededByMessageId)
    )
  ) {
    throw new Error('newer reply ticket marker was not confirmed');
  }
  return confirmed;
}

async function loadDefaultAdapters() {
  const [db, chatStore, users, autonomy, presence, timeMode, pending, debug] = await Promise.all([
    import('../db.js'),
    import('../chat-store.js'),
    import('../user-slot.js'),
    import('../character-autonomy-settings.js'),
    import('./marshmallow-presence.js'),
    import('../time-mode.js'),
    import('./pending-actions.js'),
    import('../debug-log.js'),
  ]);
  return {
    getCurrentUser: users.getCurrentUser,
    getRecord: db.getRecord,
    saveMessage: chatStore.saveMessage,
    recalcChatPreview: chatStore.recalcChatPreview,
    async loadPolicy(userId, characterId, chatId) {
      const key = autonomy.characterAutonomySettingsKey(userId, characterId);
      let row = await db.get(key);
      if (!row?.value) {
        // The legacy migration helper intentionally tolerates optional-source reads.
        // Require its authoritative settings write to be readable before treating a
        // default-disabled result as an explicit user decision.
        await autonomy.loadResolvedCharacterAutonomyPolicy(userId, characterId, chatId);
        row = await db.get(key);
        if (!row?.value) throw new Error('real-person policy is not durably readable');
      }
      return autonomy.resolveCharacterAutonomyPolicy(row.value, chatId);
    },
    resolveIdleReplyFloorMs: autonomy.resolveRealPersonIdleReplyFloorMs,
    computeReplyDelayMs: presence.computeRealPersonReplyDelayMs,
    getPacingNow: timeMode.getPacingNowForUser,
    upsertRealPersonReplyAction: pending.upsertRealPersonReplyAction,
    pendingActionExpireMs: pending.PENDING_ACTION_EXPIRE_MS,
    appendDebugEvent: debug.appendDebugEvent,
    async listQueuedReplyIntentEntries(user, now = Date.now()) {
      const userId = clean(user?.id);
      if (!userId) return [];
      const recentCutoff = Number(now || Date.now()) - 30 * 60 * 1000;
      const chats = (await chatStore.listChatsForUser(userId))
        .filter((chat) => (
          clean(chat?.type) === 'private'
          && chat?.isAnonymous !== true
          && Number(chat?.lastActivity || 0) >= recentCutoff
        ))
        .slice(0, 12);
      const rows = await Promise.all(chats.map(async (chat) => {
        const messages = await chatStore.listMessagesForChat(chat.id, 4);
        const message = messages[messages.length - 1] || null;
        const metadata = message?.metadata || {};
        if (
          clean(message?.senderId) !== 'user'
          || clean(metadata.replyIntentState) !== 'queued'
          || metadata.userComposedAsCharacter === true
          || Number(message?.timestamp || 0) < recentCutoff
        ) return null;
        const participantIds = Array.isArray(chat?.participantIds) ? chat.participantIds : [];
        const characterId = clean(chat?.characterId)
          || clean(participantIds.find((id) => clean(id) && clean(id) !== userId && clean(id) !== 'user'));
        if (!characterId) return null;
        return normalizeStagedEntry({
          userId,
          chatId: chat.id,
          characterId,
          message,
          requiresReply: true,
        }, Number(metadata.replyIntentQueuedAt || 0) || Number(message.timestamp || now));
      }));
      return rows.filter(Boolean);
    },
  };
}

async function noteExpiredEntry(entry, adapters, reason = '') {
  if (Number(entry.expiredLoggedAt || 0) > 0) return;
  const at = Date.now();
  patchReplyIntentOutboxEntry(entry.key, { expiredLoggedAt: at });
  try {
    await adapters.appendDebugEvent?.({
      type: 'reply_intent_outbox_expired_pending',
      level: 'warn',
      message: '聊天发送意图超过恢复期仍未确认，已保留待后续恢复',
      context: {
        userId: clean(entry.userId),
        chatId: clean(entry.chatId),
        messageId: clean(entry.messageId),
        generationTaskId: clean(entry.generationTaskId),
        stagedAt: Number(entry.stagedAt || 0),
        reason: clean(reason).slice(0, 120),
      },
    });
  } catch (_) {}
}

async function recoverEntry(entry, user, adapters, now) {
  const attemptPatch = {
    attempts: Math.max(0, Number(entry.attempts || 0)) + 1,
    lastAttemptAt: now,
  };
  patchReplyIntentOutboxEntry(entry.key, attemptPatch);
  let chat;
  let message;
  try {
    chat = await adapters.getRecord('chats', entry.chatId);
    if (!chat || (chat.userId && clean(chat.userId) !== clean(user.id))) {
      throw new Error('chat anchor unavailable');
    }
    message = await adapters.getRecord('messages', entry.messageId);
    if (!message) {
      await adapters.saveMessage(cloneJson(entry.message));
      message = await adapters.getRecord('messages', entry.messageId);
    }
    if (!storedMessageMatchesEntry(message, entry)) {
      throw new Error(message ? 'message identity conflict' : 'message anchor unavailable');
    }
    // Recalculate instead of blindly assigning the staged timestamp: a newer message
    // may already be present, and an old outbox must never regress the chat preview.
    await adapters.recalcChatPreview(entry.chatId);
  } catch (error) {
    const reason = clean(error?.message || error || 'message recovery unavailable').slice(0, 160);
    patchReplyIntentOutboxEntry(entry.key, { ...attemptPatch, lastError: reason });
    if (now >= Number(entry.expiresAt || 0)) await noteExpiredEntry(entry, adapters, reason);
    return { ok: false, retained: true, reason };
  }

  if (messageIsReplyBlocked(message, entry)) {
    try {
      await persistReplyIntentResolution(message, entry, adapters, {
        state: 'blocked',
        at: now,
      });
      removeEntryStrict(entry.key);
      return { ok: true, cleared: true, reason: 'delivery-blocked' };
    } catch (error) {
      const reason = clean(error?.message || error || 'blocked message confirmation unavailable').slice(0, 160);
      patchReplyIntentOutboxEntry(entry.key, { ...attemptPatch, lastError: reason });
      if (now >= Number(entry.expiresAt || 0)) await noteExpiredEntry(entry, adapters, reason);
      return { ok: false, retained: true, reason };
    }
  }

  let policy;
  try {
    policy = await adapters.loadPolicy(entry.userId, entry.characterId, entry.chatId);
  } catch (error) {
    const reason = clean(error?.message || error || 'policy unavailable').slice(0, 160);
    patchReplyIntentOutboxEntry(entry.key, { ...attemptPatch, lastError: reason });
    if (now >= Number(entry.expiresAt || 0)) await noteExpiredEntry(entry, adapters, reason);
    return { ok: false, retained: true, reason };
  }

  if (policy?.realPersonMode?.enabled !== true) {
    try {
      await persistReplyIntentResolution(message, entry, adapters, {
        state: 'disabled',
        at: now,
      });
      removeEntryStrict(entry.key);
      return { ok: true, cleared: true, reason: 'real-person-disabled' };
    } catch (error) {
      const reason = clean(error?.message || error || 'disabled message confirmation unavailable').slice(0, 160);
      patchReplyIntentOutboxEntry(entry.key, { ...attemptPatch, lastError: reason });
      if (now >= Number(entry.expiresAt || 0)) await noteExpiredEntry(entry, adapters, reason);
      return { ok: false, retained: true, reason };
    }
  }

  try {
    const pacingNow = Number(await adapters.getPacingNow(entry.userId)) || Date.now();
    const floorMs = Number(adapters.resolveIdleReplyFloorMs(policy.realPersonMode)) || 2500;
    const delayMs = Number(adapters.computeReplyDelayMs({ minDelayMs: floorMs })) || floorMs;
    const wallAgeMs = Math.max(0, now - Number(entry.stagedAt || now));
    const remainingMs = Math.max(0, delayMs - wallAgeMs);
    const dueAt = Number(entry.requestedDueAt || 0) > 0
      ? Math.min(Number(entry.requestedDueAt), pacingNow + remainingMs)
      : pacingNow + remainingMs;
    const expiryWindow = Math.max(60_000, Number(adapters.pendingActionExpireMs || 0) || 3 * 60 * 60 * 1000);
    const upserted = await adapters.upsertRealPersonReplyAction({
      userId: entry.userId,
      characterId: entry.characterId,
      chatId: entry.chatId,
      dueAt,
      createdAt: Math.max(1, pacingNow - wallAgeMs),
      expiresAt: dueAt + expiryWindow,
      dedupeKey: `real-person-reply:${entry.chatId}:${entry.messageId}`,
      payload: {
        anchorMessageId: entry.messageId,
        anchorTimestamp: entry.anchorTimestamp,
        generationTaskId: entry.generationTaskId,
        generationIdempotencyKey: entry.generationIdempotencyKey,
        generationAiRoundId: entry.generationAiRoundId,
        composeSettleMs: floorMs,
      },
    });
    if (upserted?.ok && upserted?.newer === true) {
      const newerAction = upserted.action;
      if (!newerTicketCanSupersedeEntry(newerAction, entry)) {
        throw new Error('newer reply ticket identity conflict');
      }
      const newerMessage = await adapters.getRecord(
        'messages',
        clean(newerAction.payload?.anchorMessageId),
      );
      if (!storedMessageMatchesTicket(newerMessage, newerAction)) {
        throw new Error('newer reply message was not durably confirmed');
      }
      await persistReplyIntentResolution(message, entry, adapters, {
        state: 'superseded',
        supersededByActionId: newerAction.id,
        supersededByMessageId: newerAction.payload.anchorMessageId,
        at: now,
      });
      removeEntryStrict(entry.key);
      return { ok: true, cleared: true, reason: 'superseded' };
    }
    if (!upserted?.ok || !ticketMatchesEntry(upserted.action, entry)) {
      throw new Error(upserted?.ok ? 'reply ticket identity conflict' : (upserted?.reason || 'reply ticket write failed'));
    }
    await persistReplyIntentResolution(message, entry, adapters, {
      state: 'scheduled',
      actionId: upserted.action.id,
      at: now,
    });
    removeEntryStrict(entry.key);
    return { ok: true, cleared: true, reason: 'recovered' };
  } catch (error) {
    const reason = clean(error?.message || error || 'ticket recovery unavailable').slice(0, 160);
    patchReplyIntentOutboxEntry(entry.key, { ...attemptPatch, lastError: reason });
    if (now >= Number(entry.expiresAt || 0)) await noteExpiredEntry(entry, adapters, reason);
    return { ok: false, retained: true, reason };
  }
}

export async function recoverReplyIntentOutbox({
  user = null,
  reason = 'startup',
  adapters = null,
  now = Date.now(),
} = {}) {
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = (async () => {
    let allEntries;
    try { allEntries = listEntriesStrict(); } catch (error) {
      return { ok: false, reason: 'shadow-unavailable', error: clean(error?.message || error) };
    }
    const runtime = adapters || await loadDefaultAdapters();
    let currentUser = user;
    try { currentUser = currentUser || await runtime.getCurrentUser(); } catch (error) {
      return { ok: false, reason: 'user-unavailable', error: clean(error?.message || error) };
    }
    const userId = clean(currentUser?.id);
    if (!userId) return { ok: false, reason: 'user-unavailable' };
    if (
      typeof runtime.listQueuedReplyIntentEntries === 'function'
      && Number(now || Date.now()) - lastQueuedMessageScanAt >= 60_000
    ) {
      lastQueuedMessageScanAt = Number(now || Date.now());
      try {
        const fallbackEntries = await runtime.listQueuedReplyIntentEntries(currentUser, now);
        const known = new Set(allEntries.map((entry) => clean(entry?.key)));
        for (const entry of fallbackEntries || []) {
          if (entry?.key && !known.has(clean(entry.key))) {
            known.add(clean(entry.key));
            allEntries.push(entry);
          }
        }
      } catch (_) { /* 下次启动/前台恢复时重试，不影响已有 shadow。 */ }
    }
    if (!allEntries.length) return { ok: true, checked: 0, recovered: 0, retained: 0 };
    const entries = allEntries
      .filter((entry) => clean(entry?.userId) === userId)
      .sort((left, right) => (
        Number(left?.anchorTimestamp || 0) - Number(right?.anchorTimestamp || 0)
        || Number(left?.stagedAt || 0) - Number(right?.stagedAt || 0)
      ));
    const results = [];
    for (const entry of entries) {
      results.push(await recoverEntry(entry, currentUser, runtime, Number(now) || Date.now()));
    }
    return {
      ok: results.every((row) => row.ok || row.retained),
      reason,
      checked: results.length,
      recovered: results.filter((row) => row.reason === 'recovered').length,
      cleared: results.filter((row) => row.cleared).length,
      retained: results.filter((row) => row.retained).length,
      results,
    };
  })().finally(() => { recoveryInFlight = null; });
  return recoveryInFlight;
}

export function installReplyIntentOutboxRecovery({ reason = 'startup' } = {}) {
  if (typeof globalThis.window === 'undefined') return false;
  const browserWindow = globalThis.window;
  const browserDocument = globalThis.document;
  const trigger = (why) => {
    void recoverReplyIntentOutbox({ reason: why }).catch(() => {});
  };
  if (!recoveryInstalled) {
    recoveryInstalled = true;
    browserWindow.addEventListener('pageshow', () => trigger('pageshow'), { passive: true });
    browserWindow.addEventListener('online', () => trigger('online'), { passive: true });
    browserWindow.addEventListener('storage', (event) => {
      // 只响应另一页面新建的 shadow。恢复器自身更新 attempts/lastError 也会触发
      // storage；若每次都重跑，两页会互相唤醒形成恢复风暴。
      if (
        String(event?.key || '').startsWith(REPLY_INTENT_OUTBOX_KEY_PREFIX)
        && event?.oldValue == null
        && event?.newValue != null
      ) browserWindow.setTimeout(() => trigger('storage-settled'), 3200);
    });
    browserDocument?.addEventListener?.('visibilitychange', () => {
      if (!browserDocument.hidden) trigger('foreground');
    }, { passive: true });
  }
  Promise.resolve().then(() => trigger(reason));
  return true;
}
