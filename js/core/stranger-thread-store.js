import { createChat } from '../models/chat.js';
import { getAliasAccount } from './alias-account-store.js';
import {
  deleteMessage,
  findPrivateChat,
  getChat,
  listChatsForUser,
  listMessagesForChat,
  recalcChatPreview,
  saveChat,
} from './chat-store.js';
import {
  createStrangerThreadMetadata,
  isStrangerInterceptChat,
  isUserAliasBlockedByCharacter,
  strangerThreadKey,
  transitionFriendship,
  transitionIdentityReveal,
} from './stranger-thread-model.js';
import { aliasBelongsTo, createAliasPublicSnapshot, principalKey } from './alias-account-model.js';
import { getAllByIndex, putMany } from './db.js';
import { upsertAliasAwareness } from './memory/memory-facts.js';
import { getChatBlockedState, loadChatPrefs } from './chat-block-state.js';
import {
  getChatAppearance,
  isChatAppearanceEmpty,
  pickChatAppearanceGroupSettings,
} from './chat-appearance.js';

export async function refreshStrangerThreadAccountSnapshots(chat, { persist = true } = {}) {
  if (!isStrangerInterceptChat(chat)) return chat;
  const accountIds = [...new Set(Object.values(chat.metadata?.accountIdentityMap || {}).filter(Boolean))];
  if (!accountIds.length) return chat;
  const accounts = await Promise.all(accountIds.map((id) => getAliasAccount(id).catch(() => null)));
  const snapshots = { ...(chat.metadata?.accountSnapshots || {}) };
  let changed = false;
  for (const account of accounts.filter(Boolean)) {
    const next = createAliasPublicSnapshot(account);
    if (JSON.stringify(snapshots[account.id] || null) === JSON.stringify(next)) continue;
    snapshots[account.id] = next;
    changed = true;
  }
  if (!changed) return chat;
  chat.metadata = { ...chat.metadata, accountSnapshots: snapshots };
  if (persist) await saveChat(chat);
  return chat;
}

/** 清掉旧版本已经明确标记为 AI 生成、却以用户身份落库的陌生窗消息。 */
export async function purgeStrangerGeneratedUserMessages(chat) {
  if (!isStrangerInterceptChat(chat) || !chat?.id) return 0;
  const messages = await listMessagesForChat(chat.id, 0).catch(() => []);
  const polluted = messages.filter((message) => {
    if (String(message?.senderId || '').trim() !== 'user') return false;
    const metadata = message?.metadata || {};
    return metadata.aiGenerated === true
      || metadata.offlineAutoReply === true
      || !!String(metadata.offlinePhoneCinematicJobId || '').trim();
  });
  if (!polluted.length) return 0;
  await Promise.all(polluted.map((message) => deleteMessage(message.id).catch(() => {})));
  await recalcChatPreview(chat.id).catch(() => {});
  return polluted.length;
}

async function loadOwnedAccount(accountId, ownerType, ownerId, userId) {
  const id = String(accountId || '').trim();
  if (!id) return null;
  const account = await getAliasAccount(id);
  if (!account || account.status !== 'active') throw new Error('当前马甲不存在或已归档');
  if (!aliasBelongsTo(account, ownerType, ownerId) || account.userId !== userId) {
    throw new Error('马甲与当前本体不匹配');
  }
  return account;
}

/**
 * 旧版/兼容备份里的陌生线程可能只有 channelKind 与账号映射，缺少发起方、接收方或稳定键。
 * 通知仍可凭 chatId 直达，但陌生消息列表会因无法确认收件身份而把它过滤掉。
 *
 * 这里只在信息能够唯一推出时补字段：无用户马甲映射的陌生窗必然投递到用户本体，
 * 对端角色（包含骚扰生成的轻量 NPC）视为发起方。已有合法字段一律保留。
 */
export async function repairLegacyStrangerThreadMetadata(chat, { persist = true } = {}) {
  if (!isStrangerInterceptChat(chat)) return chat;
  const uid = String(chat?.userId || '').trim();
  const characterId = (Array.isArray(chat?.participants) ? chat.participants : [])
    .map((id) => String(id || '').trim())
    .find((id) => id && id !== 'user' && id !== 'system');
  if (!uid || !characterId) return chat;

  const metadata = chat.metadata && typeof chat.metadata === 'object' ? chat.metadata : {};
  const identityMap = metadata.accountIdentityMap && typeof metadata.accountIdentityMap === 'object'
    ? metadata.accountIdentityMap
    : {};
  const userKey = principalKey('user', uid);
  const characterKey = principalKey('character', characterId);
  const participantKeys = [userKey, characterKey].filter(Boolean);
  const mappedUserAccountId = String(identityMap[userKey] || '').trim();
  let changed = false;
  const next = { ...metadata };

  const storedParticipantKeys = Array.isArray(metadata.strangerParticipantKeys)
    ? metadata.strangerParticipantKeys.map((key) => String(key || '').trim()).filter(Boolean)
    : [];
  if (participantKeys.some((key) => !storedParticipantKeys.includes(key))) {
    next.strangerParticipantKeys = participantKeys;
    changed = true;
  }

  const validInitiator = participantKeys.includes(String(metadata.initiatorKey || '').trim());
  if (!validInitiator && !mappedUserAccountId) {
    next.initiatorKey = characterKey;
    changed = true;
  }
  const resolvedInitiator = String(next.initiatorKey || '').trim();
  const expectedRecipient = resolvedInitiator === userKey
    ? characterKey
    : (resolvedInitiator === characterKey ? userKey : '');
  if (expectedRecipient && String(metadata.recipientKey || '').trim() !== expectedRecipient) {
    next.recipientKey = expectedRecipient;
    changed = true;
  }

  const expectedThreadKey = strangerThreadKey(participantKeys, identityMap);
  if (!String(metadata.strangerThreadKey || '').trim() && expectedThreadKey) {
    next.strangerThreadKey = expectedThreadKey;
    changed = true;
  }
  if (!String(metadata.memoryMode || '').trim()) {
    next.memoryMode = 'isolated_alias';
    changed = true;
  }

  if (!changed) return chat;
  const repaired = { ...chat, metadata: next };
  if (persist) await saveChat(repaired);
  return repaired;
}

export async function findStrangerThread(userId, threadKey) {
  const key = String(threadKey || '').trim();
  if (!userId || !key) return null;
  const chats = await listChatsForUser(userId);
  for (const chat of chats) {
    if (!isStrangerInterceptChat(chat)) continue;
    const repaired = await repairLegacyStrangerThreadMetadata(chat);
    if (repaired.metadata?.strangerThreadKey === key) return repaired;
  }
  return null;
}

export async function listStrangerThreadsForCharacter(userId, characterId) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return [];
  const chats = await listChatsForUser(uid);
  return chats.filter((chat) => isStrangerInterceptChat(chat)
    && (chat.participants || []).includes(cid));
}

export function matchesUserInterceptIdentity(chat, {
  userId = '',
  userAccountId = '',
  blocked = false,
} = {}) {
  const uid = String(userId || '').trim();
  const selectedAccountId = String(userAccountId || '').trim();
  if (!uid || !chat) return false;
  const stranger = isStrangerInterceptChat(chat);
  const mappedUserAccountId = stranger
    ? String(chat.metadata?.accountIdentityMap?.[principalKey('user', uid)] || '').trim()
    : '';
  if (selectedAccountId) return stranger && mappedUserAccountId === selectedAccountId;
  if (stranger) {
    return !mappedUserAccountId
      && (
        String(chat.metadata?.initiatorKey || '').startsWith('character:')
        || !!chat.metadata?.contactApplication
      );
  }
  return blocked === true
    && chat.type === 'private'
    && (chat.participants || []).includes('user');
}

export function shouldShowOrphanedUserAliasThread(chat, userId = '', account = null) {
  const uid = String(userId || '').trim();
  if (!uid || !isStrangerInterceptChat(chat)) return false;
  const accountId = String(
    chat.metadata?.accountIdentityMap?.[principalKey('user', uid)] || '',
  ).trim();
  return !!accountId && (!account || account.status !== 'active');
}

export async function listUserInterceptThreads(userId, { userAccountId = '' } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const selectedAccountId = String(userAccountId || '').trim();
  const chats = await listChatsForUser(uid);
  const rows = await Promise.all(chats.map(async (chat) => {
    const repairedChat = isStrangerInterceptChat(chat)
      ? await repairLegacyStrangerThreadMetadata(chat)
      : chat;
    const stranger = isStrangerInterceptChat(repairedChat);
    const blocked = stranger ? false : getChatBlockedState(
      repairedChat,
      await loadChatPrefs(repairedChat.id).catch(() => ({})),
    ).blocked;
    let identityMatches = matchesUserInterceptIdentity(repairedChat, {
      userId: uid,
      userAccountId: selectedAccountId,
      blocked,
    });
    if (!identityMatches && stranger && !selectedAccountId) {
      const mappedAccountId = String(
        repairedChat.metadata?.accountIdentityMap?.[principalKey('user', uid)] || '',
      ).trim();
      const mappedAccount = mappedAccountId
        ? await getAliasAccount(mappedAccountId).catch(() => null)
        : null;
      identityMatches = shouldShowOrphanedUserAliasThread(repairedChat, uid, mappedAccount);
    }
    if (!identityMatches) return null;
    return stranger ? refreshStrangerThreadAccountSnapshots(repairedChat) : repairedChat;
  }));
  return rows.filter(Boolean).sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0));
}

export async function updateStrangerFriendship(chatId, nextState, evidence = {}) {
  const chat = await getChat(chatId);
  if (!isStrangerInterceptChat(chat)) throw new Error('这不是陌生人会话');
  chat.metadata = transitionFriendship(chat.metadata, nextState, evidence);
  await saveChat(chat);
  return chat;
}

function hasUserAliasAccount(chat = null) {
  return Object.entries(chat?.metadata?.accountIdentityMap || {})
    .some(([key, accountId]) => String(key).startsWith('user:') && String(accountId || '').trim());
}

/** 大号会话里口头承诺「加好友 / 通过申请 / 解除拉黑」时，用于同步到对应用户马甲线程。 */
export function detectMainChatAliasFriendshipPromises(text = '') {
  const raw = String(text || '');
  if (!raw.trim()) return { unblock: false, acceptFriend: false };
  return {
    unblock: /解除拉黑|取消拉黑|不拉黑了|移出黑名单|从黑名单(里)?(删|移除|清)|解开拉黑|把你取消拉黑/.test(raw),
    acceptFriend: /通过(你的)?好友(申请)?|同意(你的)?好友(申请)?|加你(为|做)?好友|接受好友|已经是好友|当我们是好友|加好友了|好友申请.*过了|过了.*好友申请/.test(raw),
  };
}

/**
 * 把大号上的好友/解黑承诺落到同一角色相关的用户马甲陌生线程。
 * @returns {Promise<{ unblocked:number, accepted:number, threadIds:string[] }>}
 */
export async function applyMainChatFriendshipPromisesToAliases({
  userId = '',
  characterId = '',
  text = '',
  reason = '大号承诺同步到马甲线程',
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const promises = detectMainChatAliasFriendshipPromises(text);
  const out = { unblocked: 0, accepted: 0, threadIds: [] };
  if (!uid || !cid || (!promises.unblock && !promises.acceptFriend)) return out;

  const threads = await listStrangerThreadsForCharacter(uid, cid).catch(() => []);
  const charKey = principalKey('character', cid);
  const now = Date.now();
  const note = String(reason || '').trim().slice(0, 300);
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (!isStrangerInterceptChat(thread) || !hasUserAliasAccount(thread)) continue;
    const state = String(thread.metadata?.friendshipState || 'stranger').trim() || 'stranger';
    let next = null;
    let didUnblock = false;
    if (promises.unblock && state === 'blocked' && isUserAliasBlockedByCharacter(thread)) {
      next = promises.acceptFriend ? 'accepted' : 'intercepted';
      didUnblock = true;
    } else if (
      promises.acceptFriend
      && ['requested', 'intercepted', 'stranger'].includes(state)
    ) {
      next = 'accepted';
    }
    if (!next) continue;
    try {
      let metadata = transitionFriendship(thread.metadata, next, {
        by: charKey,
        at: now,
        reason: note,
      });
      if (next === 'accepted') {
        metadata = {
          ...metadata,
          friendshipDecisionBy: charKey,
          friendshipDecisionAt: now,
          friendshipDecision: 'accept',
          friendshipDecisionReason: note,
          friendshipSyncedFromMainAt: now,
        };
      } else {
        metadata = {
          ...metadata,
          friendshipSyncedFromMainAt: now,
        };
      }
      thread.metadata = metadata;
      await saveChat(thread);
      if (didUnblock) out.unblocked += 1;
      if (next === 'accepted') out.accepted += 1;
      out.threadIds.push(thread.id);
    } catch (_) {
      /* 状态不允许跳转时跳过 */
    }
  }
  return out;
}

export async function updateStrangerIdentityReveal(chatId, subjectKey, nextState, evidence = {}) {
  const chat = await getChat(chatId);
  if (!isStrangerInterceptChat(chat)) throw new Error('这不是陌生人会话');
  chat.metadata = transitionIdentityReveal(chat.metadata, subjectKey, nextState, evidence);
  await saveChat(chat);
  const accountId = String(chat.metadata?.accountIdentityMap?.[subjectKey] || '').trim();
  const subjectIsUser = String(subjectKey || '').startsWith('user:');
  if (accountId && subjectIsUser && ['suspected', 'revealed'].includes(nextState)) {
    const awareCharacterIds = (chat.participants || [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== 'user');
    const snapshot = chat.metadata?.accountSnapshots?.[accountId] || {};
    await Promise.all(awareCharacterIds.map((characterId) => upsertAliasAwareness({
      userId: chat.userId,
      accountId,
      awareCharacterId: characterId,
      awarenessLevel: nextState === 'revealed' ? 'knows_account' : 'suspects',
      confidence: nextState === 'revealed' ? 1 : 0.55,
      provenance: {
        source: nextState === 'revealed' ? 'told' : 'observed',
        sourceChatId: chat.id,
        note: String(evidence.text || (nextState === 'revealed' ? '当事人在当前线程明确揭示' : '当前线程出现可疑线索')).trim(),
      },
      accountLabel: snapshot.displayName || '',
    }))).catch(() => {});
  }
  if (nextState === 'revealed') {
    const linkedKeys = [...new Set([
      subjectKey,
      ...(chat.metadata?.strangerParticipantKeys || []).filter((key) => String(key).startsWith('character:')),
    ])];
    const facts = await getAllByIndex('memoryFacts', 'chatId', chat.id).catch(() => []);
    const updated = facts.map((fact) => ({
      ...fact,
      linkedPrincipalKeys: [...new Set([...(fact.linkedPrincipalKeys || []), ...linkedKeys])],
      identityLinkedAt: Date.now(),
      updatedAt: Date.now(),
    }));
    if (updated.length) await putMany('memoryFacts', updated);
  }
  return chat;
}

/** 不触发揭示：为第三方/Phase 4 consulted 流程写入独立知情账本。 */
export async function recordStrangerAliasSuspicion({
  userId = '',
  accountId = '',
  awareCharacterId = '',
  sourceChatId = '',
  note = '',
  source = 'observed',
  accountLabel = '',
} = {}) {
  return upsertAliasAwareness({
    userId,
    accountId,
    awareCharacterId,
    awarenessLevel: 'suspects',
    confidence: 0.55,
    provenance: { source, sourceChatId, note },
    accountLabel,
  });
}

export async function ensureStrangerThread({
  userId,
  characterId,
  characterAccountId = '',
  userAccountId = '',
  initiatorType,
  friendshipState = 'intercepted',
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) throw new Error('陌生人会话缺少用户档位或角色');
  const userKey = principalKey('user', uid);
  const characterKey = principalKey('character', cid);
  const initiatorKey = initiatorType === 'user' ? userKey : characterKey;
  const recipientKey = initiatorType === 'user' ? characterKey : userKey;
  const [characterAccount, userAccount] = await Promise.all([
    loadOwnedAccount(characterAccountId, 'character', cid, uid),
    loadOwnedAccount(userAccountId, 'user', uid, uid),
  ]);
  const accountIdentityMap = {};
  const accountSnapshots = {};
  if (characterAccount) {
    accountIdentityMap[characterKey] = characterAccount.id;
    accountSnapshots[characterAccount.id] = characterAccount;
  }
  if (userAccount) {
    accountIdentityMap[userKey] = userAccount.id;
    accountSnapshots[userAccount.id] = userAccount;
  }
  const participants = [userKey, characterKey];
  const key = strangerThreadKey(participants, accountIdentityMap);
  const existing = await findStrangerThread(uid, key);
  if (existing) {
    const repaired = await repairLegacyStrangerThreadMetadata(existing);
    return ensureStrangerChatAppearanceInherited(repaired);
  }
  const metadata = createStrangerThreadMetadata({
    participants,
    accountIdentityMap,
    accountSnapshots,
    friendshipState,
    initiatorKey,
    recipientKey,
  });
  // 新建陌生/马甲窗默认继承主私聊美化，避免「普通 CSS 改不了气泡」
  const mainChat = await findPrivateChat(uid, cid).catch(() => null);
  const inheritedAppearance = pickChatAppearanceGroupSettings(mainChat);
  const chat = createChat({
    id: `stranger_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'private',
    userId: uid,
    participants: ['user', cid],
    groupSettings: {
      allowSocialLinkage: false,
      allowPrivateLinkage: false,
      allowAiGroupOps: false,
      allowAiOfflineInvite: false,
      allowAiVoiceCall: false,
      ...inheritedAppearance,
      ...(Object.keys(inheritedAppearance).length
        ? { appearanceInheritedFromMainAt: Date.now() }
        : {}),
    },
    metadata,
  });
  await saveChat(chat);
  return chat;
}

/** 旧陌生窗若从未配置美化，首次打开时从主私聊补一份（只补一次）。 */
export async function ensureStrangerChatAppearanceInherited(chat) {
  if (!isStrangerInterceptChat(chat)) return chat;
  const gs = chat.groupSettings || {};
  if (Number(gs.appearanceInheritedFromMainAt || 0) > 0) return chat;
  if (!isChatAppearanceEmpty(getChatAppearance(chat)) || String(gs.wallpaper || '').trim()) {
    return chat;
  }
  const uid = String(chat.userId || '').trim();
  const cid = (Array.isArray(chat.participants) ? chat.participants : [])
    .map((id) => String(id || '').trim())
    .find((id) => id && id !== 'user');
  if (!uid || !cid) return chat;
  const mainChat = await findPrivateChat(uid, cid).catch(() => null);
  const inherited = pickChatAppearanceGroupSettings(mainChat);
  if (!Object.keys(inherited).length) return chat;
  chat.groupSettings = {
    ...gs,
    ...inherited,
    appearanceInheritedFromMainAt: Date.now(),
  };
  await saveChat(chat);
  return chat;
}
