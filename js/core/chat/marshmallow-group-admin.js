import { createMessage } from '../../models/chat.js';
import {
  getChat,
  saveChat,
  saveMessage,
  ensurePrivateChat,
  updateChatPreview,
  previewFromMessage,
  bumpChatUnread,
  listMessagesForChat,
  listChatsForUser,
} from '../chat-store.js';
import { getNowForUser } from '../time-mode.js';
import { isAnonymousChat, isUserPresentInChat } from '../chat-helpers.js';
import { getAnonymousDisplayProfile } from '../anonymous-chat.js';
import { createAnonymousPrivateFromGroup } from '../anonymous-private-chat.js';
import { sanitizeAiTranslation } from '../translation-utils.js';
import { buildAnonymousContactEntry } from '../anonymous-contacts.js';
import { createChatRoundReceipt } from './chat-round-receipt.js';
import { checkPhoneSocialParticipantIds } from '../phone-social-eligibility.js';
import { syncPhoneContactGroupFromChat } from '../character-phone-contacts.js';
import {
  claimedGroupName,
  isCompletedInviteClaim,
  isExplicitGroupInviteRequest,
  isExplicitGroupRenameRequest,
  requestedGroupName,
} from './group-action-grounding.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

function getGroupAdminPrivilege(chat, actorId) {
  const gs = chat?.groupSettings || {};
  const id = clean(actorId);
  if (!id) return 'none';
  const owner = clean(gs.owner) || ((chat?.participants || []).includes('user') ? 'user' : clean((chat?.participants || []).find((p) => p && p !== 'user')));
  if (owner === id) return 'owner';
  if ((gs.admins || []).includes(id)) return 'admin';
  if ((chat.participants || []).includes(id)) return 'member';
  return 'none';
}

function canManageGroup(chat, actorId) {
  const role = getGroupAdminPrivilege(chat, actorId);
  return role === 'owner' || role === 'admin';
}

async function appendGroupSystemLine(chatId, content, options = {}) {
  const { timestamp, metadata: nestedMeta, ...rest } = options || {};
  const meta = nestedMeta && typeof nestedMeta === 'object' ? nestedMeta : rest;
  const msg = createMessage({
    chatId,
    senderId: 'system',
    type: 'system',
    content: clean(content),
    timestamp: Number(timestamp) || Date.now(),
    metadata: { ...meta },
  });
  await saveMessage(msg);
  await updateChatPreview(chatId, previewFromMessage(msg), msg.timestamp);
  return msg;
}

export async function applyMarshmallowGroupAdminEvents(events = [], options = {}) {
  const sourceChatId = clean(options.sourceChatId || options.sourceChat?.id);
  const userId = clean(options.userId);
  const resolveName = typeof options.resolveName === 'function'
    ? options.resolveName
    : async (id) => id;
  let chatRow = sourceChatId ? await getChat(sourceChatId) : options.sourceChat;
  const allowed = chatRow?.groupSettings?.allowAiGroupOps !== false;
  const items = (Array.isArray(events) ? events : []).filter((e) => (
    e?.t === 'group_title'
    || e?.t === 'group_name'
    || e?.t === 'group_announcement'
    || e?.t === 'group_todo'
    || e?.t === 'group_transfer'
    || e?.t === 'group_admin'
    || e?.t === 'group_member'
    || e?.t === 'mute'
    || e?.t === 'vote_close'
  ));
  if (!items.length || !allowed || !chatRow || chatRow.type !== 'group') {
    return {
      handled: 0,
      skipped: items.length,
      chat: chatRow || null,
      receipts: items.length ? [createChatRoundReceipt({
        code: !allowed ? 'ai_group_ops_disabled' : 'group_admin_context_invalid',
        status: 'blocked',
        stage: 'group-admin',
        eventType: 'group_admin',
        chatId: sourceChatId,
        context: { count: items.length },
      })] : [],
    };
  }

  let handled = 0;
  let skipped = 0;
  const appliedTypes = new Set();
  const failureCodes = [];
  const recordHandled = (type) => {
    handled += 1;
    if (type) appliedTypes.add(type);
  };
  const recordSkipped = (code) => {
    skipped += 1;
    failureCodes.push(clean(code) || 'group_action_rejected');
  };
  const participants = new Set(chatRow.participants || []);
  const allowedAddMemberIds = new Set(
    (Array.isArray(options.allowedAddMemberIds) ? options.allowedAddMemberIds : [])
      .map(clean)
      .filter(Boolean),
  );
  const worldTs = userId ? await getNowForUser(userId) : Date.now();
  const recentMessages = await listMessagesForChat(sourceChatId, 100).catch(() => []);
  const explicitGroupActionRequested = options.explicitUserRequest === true;
  const explicitRenameRequested = explicitGroupActionRequested
    || [...recentMessages].reverse().slice(0, 12).some(isExplicitGroupRenameRequest);
  const cooldownByType = new Map([
    ['group_name', 10 * 60 * 1000],
    ['group_transfer', 30 * 60 * 1000],
    ['group_admin', 30 * 60 * 1000],
    ['group_member', 30 * 60 * 1000],
    ['mute', 2 * 60 * 1000],
  ]);

  for (const event of items) {
    const actorId = clean(event.actor || event.from);
    const targetId = clean(event.target || event.to);
    if (event.t === 'group_name'
      && actorId
      && canManageGroup(chatRow, actorId)
      && clean(chatRow.groupSettings?.name) === clean(event.name)) {
      recordHandled('group_name');
      continue;
    }
    const cooldownMs = cooldownByType.get(event.t) || 0;
    if (cooldownMs > 0
      && !explicitGroupActionRequested
      && !(event.t === 'group_name' && explicitRenameRequested)
      && recentMessages.some((message) => (
      message
      && !message.deleted
      && message.type === 'system'
      && message.metadata?.marshmallowEventType === event.t
      && worldTs - Number(message.timestamp || 0) < cooldownMs
      ))) {
      recordSkipped('group_action_cooldown');
      continue;
    }
    const needsTarget = event.t === 'group_title'
      || event.t === 'group_transfer'
      || event.t === 'group_admin'
      || event.t === 'group_member'
      || event.t === 'mute';
    if (!actorId || !participants.has(actorId) || (needsTarget && !targetId)) {
      recordSkipped(!actorId || !participants.has(actorId)
        ? 'group_action_actor_not_member'
        : 'group_action_target_missing');
      continue;
    }
    const gs = { ...(chatRow.groupSettings || {}) };
    if (!clean(gs.owner)) gs.owner = (chatRow.participants || []).includes('user') ? 'user' : [...participants].find((p) => p !== 'user');
    gs.titles = { ...(gs.titles || {}) };
    gs.muted = Array.isArray(gs.muted) ? [...gs.muted] : [];

    if (event.t === 'group_title') {
      if (!canManageGroup(chatRow, actorId)) {
        recordSkipped('group_action_actor_not_manager');
        continue;
      }
      if (!participants.has(targetId)) {
        recordSkipped('group_action_target_not_member');
        continue;
      }
      const title = clean(event.title).slice(0, 24);
      if (title) gs.titles[targetId] = title;
      else delete gs.titles[targetId];
      chatRow.groupSettings = gs;
      await saveChat(chatRow);
      const actorName = await resolveName(actorId);
      const targetName = await resolveName(targetId);
      await appendGroupSystemLine(
        sourceChatId,
        title ? `${actorName} 设置了 ${targetName} 的群头衔：${title}` : `${actorName} 清除了 ${targetName} 的群头衔`,
        { timestamp: worldTs, aiRoundId: options.aiRoundId, marshmallowEventType: 'group_title' },
      );
      recordHandled(event.t);
      continue;
    }

    if (event.t === 'group_name') {
      if (!canManageGroup(chatRow, actorId)) {
        recordSkipped('group_action_actor_not_manager');
        continue;
      }
      const name = clean(event.name).slice(0, 40);
      if (!name) {
        recordSkipped('group_action_name_missing');
        continue;
      }
      gs.name = name;
      chatRow.groupSettings = gs;
      await saveChat(chatRow);
      const actorName = await resolveName(actorId);
      await appendGroupSystemLine(
        sourceChatId,
        `${actorName} 修改群名为：${name}`,
        { timestamp: worldTs, aiRoundId: options.aiRoundId, marshmallowEventType: 'group_name' },
      );
      recordHandled(event.t);
      continue;
    }

    if (event.t === 'group_announcement') {
      if (!canManageGroup(chatRow, actorId)) {
        recordSkipped('group_action_actor_not_manager');
        continue;
      }
      const announcement = clean(event.announcement).slice(0, 600);
      gs.announcement = announcement;
      chatRow.groupSettings = gs;
      await saveChat(chatRow);
      const actorName = await resolveName(actorId);
      await appendGroupSystemLine(
        sourceChatId,
        announcement ? `${actorName} 更新了群公告` : `${actorName} 清空了群公告`,
        { timestamp: worldTs, aiRoundId: options.aiRoundId, marshmallowEventType: 'group_announcement' },
      );
      recordHandled(event.t);
      continue;
    }

    if (event.t === 'group_todo') {
      if (!canManageGroup(chatRow, actorId)) {
        recordSkipped('group_action_actor_not_manager');
        continue;
      }
      const now = Date.now();
      const todos = Array.isArray(gs.todos) ? [...gs.todos] : [];
      const action = clean(event.action || 'add').toLowerCase();
      const todoId = clean(event.id || event.todoId);
      if (action === 'done' || action === 'complete' || action === 'toggle') {
        const idx = todos.findIndex((item) => item && clean(item.id) === todoId);
        if (idx < 0) {
          recordSkipped('group_action_todo_not_found');
          continue;
        }
        todos[idx] = { ...todos[idx], done: event.done !== false, updatedAt: now };
      } else if (action === 'delete' || action === 'remove') {
        gs.todos = todos.filter((item) => clean(item?.id) !== todoId);
      } else {
        const text = clean(event.text).slice(0, 120);
        if (!text) {
          recordSkipped('group_action_todo_missing');
          continue;
        }
        gs.todos = [{ id: todoId || `todo_${now}_${Math.random().toString(36).slice(2, 6)}`, text, done: false, createdAt: now }, ...todos].slice(0, 20);
      }
      if (action === 'done' || action === 'complete' || action === 'toggle') gs.todos = todos;
      chatRow.groupSettings = gs;
      await saveChat(chatRow);
      const actorName = await resolveName(actorId);
      await appendGroupSystemLine(
        sourceChatId,
        `${actorName} 更新了群待办`,
        { timestamp: worldTs, aiRoundId: options.aiRoundId, marshmallowEventType: 'group_todo' },
      );
      recordHandled(event.t);
      continue;
    }

    if (event.t === 'group_transfer') {
      if (getGroupAdminPrivilege(chatRow, actorId) !== 'owner') {
        recordSkipped('group_action_actor_not_owner');
        continue;
      }
      if (!participants.has(targetId)) {
        recordSkipped('group_action_target_not_member');
        continue;
      }
      gs.owner = targetId;
      gs.admins = (gs.admins || []).filter((id) => id !== targetId);
      chatRow.groupSettings = gs;
      await saveChat(chatRow);
      const actorName = await resolveName(actorId);
      const targetName = await resolveName(targetId);
      await appendGroupSystemLine(
        sourceChatId,
        `${actorName} 将群转让给 ${targetName}`,
        { timestamp: worldTs, aiRoundId: options.aiRoundId, marshmallowEventType: 'group_transfer' },
      );
      recordHandled(event.t);
      continue;
    }

    if (event.t === 'group_admin') {
      if (getGroupAdminPrivilege(chatRow, actorId) !== 'owner'
        || !participants.has(targetId)
        || targetId === gs.owner) {
        recordSkipped(getGroupAdminPrivilege(chatRow, actorId) !== 'owner'
          ? 'group_action_actor_not_owner'
          : (!participants.has(targetId) ? 'group_action_target_not_member' : 'group_action_target_protected'));
        continue;
      }
      const admins = new Set(Array.isArray(gs.admins) ? gs.admins : []);
      if (event.admin === false) admins.delete(targetId);
      else admins.add(targetId);
      gs.admins = [...admins];
      chatRow.groupSettings = gs;
      await saveChat(chatRow);
      const actorName = await resolveName(actorId);
      const targetName = await resolveName(targetId);
      await appendGroupSystemLine(
        sourceChatId,
        `${actorName} ${event.admin === false ? '取消了' : '设置了'} ${targetName} 的管理员身份`,
        { timestamp: worldTs, aiRoundId: options.aiRoundId, marshmallowEventType: 'group_admin' },
      );
      recordHandled(event.t);
      continue;
    }

    if (event.t === 'group_member') {
      const owner = clean(gs.owner);
      const action = clean(event.action || 'remove');
      const socialBoundary = action === 'add'
        ? await checkPhoneSocialParticipantIds([...participants, targetId], userId).catch(() => ({ allowed: false }))
        : { allowed: true };
      const canAdd = action === 'add'
        && !participants.has(targetId)
        && allowedAddMemberIds.has(targetId)
        && socialBoundary.allowed;
      const canRemove = action === 'remove'
        && participants.has(targetId)
        && targetId !== 'user'
        && targetId !== owner;
      if (!canManageGroup(chatRow, actorId) || (!canAdd && !canRemove)) {
        let failureCode = 'group_action_member_action_invalid';
        if (!canManageGroup(chatRow, actorId)) failureCode = 'group_action_actor_not_manager';
        else if (action === 'add' && participants.has(targetId)) failureCode = 'group_action_member_already_present';
        else if (action === 'add' && !allowedAddMemberIds.has(targetId)) failureCode = 'group_action_member_target_not_allowed';
        else if (action === 'add' && !socialBoundary.allowed) failureCode = 'group_action_member_social_boundary';
        else if (action === 'remove' && !participants.has(targetId)) failureCode = 'group_action_target_not_member';
        else if (action === 'remove' && (targetId === 'user' || targetId === owner)) failureCode = 'group_action_target_protected';
        recordSkipped(failureCode);
        continue;
      }
      const actorName = await resolveName(actorId);
      const targetName = await resolveName(targetId);
      if (canAdd) {
        participants.add(targetId);
        chatRow.participants = [...new Set([...(chatRow.participants || []), targetId])];
      } else {
        participants.delete(targetId);
        chatRow.participants = (chatRow.participants || []).filter((id) => id !== targetId);
        gs.admins = (gs.admins || []).filter((id) => id !== targetId);
        gs.muted = (gs.muted || []).filter((id) => id !== targetId);
        if (gs.titles) delete gs.titles[targetId];
        if (gs.memberCards) {
          gs.memberCards = { ...gs.memberCards };
          delete gs.memberCards[targetId];
        }
      }
      chatRow.groupSettings = gs;
      chatRow.metadata = {
        ...(chatRow.metadata || {}),
        participantSnapshot: {
          actorIds: chatRow.participants.filter((id) => id && id !== 'user'),
          capturedAt: Date.now(),
        },
      };
      await saveChat(chatRow);
      await appendGroupSystemLine(
        sourceChatId,
        canAdd ? `${actorName} 邀请 ${targetName} 加入了群聊` : `${actorName} 将 ${targetName} 移出了群聊`,
        { timestamp: worldTs, aiRoundId: options.aiRoundId, marshmallowEventType: 'group_member' },
      );
      recordHandled(event.t);
      continue;
    }

    if (event.t === 'vote_close') {
      const recent = await listMessagesForChat(sourceChatId, 100).catch(() => []);
      const requestedId = clean(event.target || event.voteId || 'last_vote');
      const vote = [...recent].reverse().find((message) => (
        message
        && message.type === 'vote'
        && message.metadata?.voteClosed !== true
        && (requestedId === 'last_vote' || message.id === requestedId)
      ));
      if (!vote || (vote.senderId !== actorId && !canManageGroup(chatRow, actorId))) {
        recordSkipped(!vote ? 'group_action_vote_not_found' : 'group_action_vote_permission_denied');
        continue;
      }
      vote.metadata = {
        ...(vote.metadata || {}),
        voteClosed: true,
        voteClosedAt: worldTs,
        voteClosedBy: actorId,
      };
      await saveMessage(vote);
      const actorName = await resolveName(actorId);
      await appendGroupSystemLine(
        sourceChatId,
        `${actorName} 结束了群投票`,
        { timestamp: worldTs, aiRoundId: options.aiRoundId, marshmallowEventType: 'vote_close' },
      );
      recordHandled(event.t);
      continue;
    }

    if (event.t === 'mute') {
      if (!canManageGroup(chatRow, actorId)) {
        recordSkipped('group_action_actor_not_manager');
        continue;
      }
      const muted = event.muted !== false;
      if (targetId === 'all') {
        gs.allMuted = muted;
      } else if (participants.has(targetId)) {
        const set = new Set(gs.muted);
        if (muted) set.add(targetId);
        else set.delete(targetId);
        gs.muted = [...set];
      } else {
        recordSkipped('group_action_target_not_member');
        continue;
      }
      chatRow.groupSettings = gs;
      await saveChat(chatRow);
      const actorName = await resolveName(actorId);
      const targetName = targetId === 'all' ? '全员' : await resolveName(targetId);
      await appendGroupSystemLine(
        sourceChatId,
        `${actorName} ${muted ? '禁言' : '解除禁言'} ${targetName}`,
        { timestamp: worldTs, aiRoundId: options.aiRoundId, marshmallowEventType: 'mute' },
      );
      recordHandled(event.t);
    }
  }

  let phoneGroupSync = null;
  if (handled > 0 && userId) {
    phoneGroupSync = await syncPhoneContactGroupFromChat(userId, chatRow).catch(() => null);
    if (phoneGroupSync?.synced) {
      const nextMetadata = {
        ...(chatRow.metadata || {}),
        phoneOwnerId: phoneGroupSync.ownerId,
        phoneContactGroupId: phoneGroupSync.groupId,
      };
      if (nextMetadata.phoneOwnerId !== chatRow.metadata?.phoneOwnerId
        || nextMetadata.phoneContactGroupId !== chatRow.metadata?.phoneContactGroupId) {
        chatRow.metadata = nextMetadata;
        await saveChat(chatRow);
      }
    }
  }

  return {
    handled,
    skipped,
    chat: chatRow,
    appliedTypes: [...appliedTypes],
    phoneGroupSync,
    receipts: skipped ? [createChatRoundReceipt({
      code: 'group_admin_events_skipped',
      status: 'dropped',
      stage: 'group-admin',
      eventType: 'group_admin',
      chatId: sourceChatId,
      context: { handled, skipped, failureCodes: [...new Set(failureCodes)] },
    })] : [],
  };
}

/**
 * AI 在无 user 的秘密基地/幕后群里发起「拉 user 进群」：只生成一张待处理的邀请卡，
 * 不直接改群——是否真的转正成有 user 的普通群聊，交给用户在邀请卡上手动点「加入群聊」。
 */
export async function applyMarshmallowGroupInviteUserEvents(events = [], options = {}) {
  const sourceChatId = clean(options.sourceChatId || options.sourceChat?.id);
  const userId = clean(options.userId);
  const resolveName = typeof options.resolveName === 'function'
    ? options.resolveName
    : async (id) => id;
  const chatRow = sourceChatId ? await getChat(sourceChatId) : options.sourceChat;
  const items = (Array.isArray(events) ? events : []).filter((e) => e?.t === 'invite_user');
  if (!items.length
    || !chatRow
    || chatRow.type !== 'group'
    || isUserPresentInChat(chatRow)
    || chatRow.groupSettings?.userTopicPolicy === 'off') {
    return {
      handled: 0,
      skipped: items.length,
      chat: chatRow || null,
      effective: false,
      receipts: items.length ? [createChatRoundReceipt({
        code: 'group_invite_user_context_invalid',
        status: 'blocked',
        stage: 'group-invite-user',
        eventType: 'invite_user',
        chatId: sourceChatId,
        context: { count: items.length },
      })] : [],
    };
  }

  const participants = new Set(chatRow.participants || []);
  const recentMessages = await listMessagesForChat(sourceChatId, 50).catch(() => []);
  const hasPendingInvite = (recentMessages || []).some((m) => (
    m && !m.deleted && m.type === 'groupInviteUser' && String(m.metadata?.status || 'pending') === 'pending'
  ));
  const declinedRecently = (recentMessages || []).some((m) => (
    m
    && !m.deleted
    && m.type === 'groupInviteUser'
    && String(m.metadata?.status || '') === 'declined'
    && Date.now() - Number(m.metadata?.resolvedAt || m.timestamp || 0) < 24 * 60 * 60 * 1000
  ));
  if (hasPendingInvite) {
    return {
      handled: 0,
      skipped: items.length,
      chat: chatRow,
      effective: true,
      alreadyPending: true,
      appliedTypes: ['invite_user'],
      receipts: [],
    };
  }
  const worldTs = Number(options.timestamp)
    || (userId ? await getNowForUser(userId) : Date.now());

  let handled = 0;
  let skipped = 0;
  for (const event of items) {
    const actorId = clean(event.actor || event.from);
    if (!actorId || !participants.has(actorId) || hasPendingInvite || declinedRecently || handled > 0) {
      skipped += 1;
      continue;
    }
    const actorName = await resolveName(actorId);
    const note = clean(event.note || event.reason).slice(0, 80);
    const msg = createMessage({
      chatId: sourceChatId,
      senderId: actorId,
      senderName: actorName,
      type: 'groupInviteUser',
      content: note,
      timestamp: worldTs,
      metadata: {
        aiRoundId: options.aiRoundId,
        marshmallowEventType: 'invite_user',
        status: 'pending',
        inviterId: actorId,
        inviterName: actorName,
        note,
      },
    });
    await saveMessage(msg);
    await updateChatPreview(sourceChatId, previewFromMessage(msg), msg.timestamp);
    void import('../native-notifications.js')
      .then(({ notifyBackgroundMessageIfEnabled }) => notifyBackgroundMessageIfEnabled({
        title: '群聊邀请',
        body: `${actorName} 邀请你加入「${clean(chatRow.groupSettings?.name) || '群聊'}」`,
        chatId: sourceChatId,
        tag: `group-invite-${sourceChatId}-${msg.id}`,
        data: { chatId: sourceChatId, kind: 'group-invite' },
        requireHidden: true,
      }))
      .catch(() => {});
    handled += 1;
  }
  return {
    handled,
    skipped,
    chat: chatRow,
    effective: handled > 0,
    appliedTypes: handled > 0 ? ['invite_user'] : [],
    receipts: skipped ? [createChatRoundReceipt({
      code: declinedRecently ? 'group_invite_user_declined_cooldown' : 'group_invite_user_skipped',
      status: 'dropped',
      stage: 'group-invite-user',
      eventType: 'invite_user',
      chatId: sourceChatId,
      context: { handled, skipped },
    })] : [],
  };
}

const REMOTE_GROUP_OPERATIONS = new Set([
  'group_name',
  'group_announcement',
  'group_todo',
  'group_title',
  'group_transfer',
  'group_admin',
  'group_member',
  'mute',
  'vote_close',
  'invite_user',
]);

function remoteGroupEventToLocal(event = {}) {
  const operation = clean(event.operation || event.op || event.action).toLowerCase();
  if (!REMOTE_GROUP_OPERATIONS.has(operation)) return null;
  if (operation === 'invite_user') {
    return { t: 'invite_user', from: clean(event.from || event.actor), note: clean(event.note || event.reason) };
  }
  return {
    ...event,
    t: operation,
    from: clean(event.from || event.actor),
    target: clean(event.target || event.to),
    ...(operation === 'group_member' ? { action: clean(event.memberAction || event.mode || 'remove').toLowerCase() } : {}),
    ...(operation === 'group_todo' ? { action: clean(event.todoAction || event.mode || 'add').toLowerCase() } : {}),
  };
}

/**
 * 私聊里执行另一扇群窗的结构化群管命令。目标群必须来自本轮提示词给出的白名单，
 * 到执行时再重新读取群和权限，避免模型凭空编 groupId 或使用过期身份。
 */
export async function applyMarshmallowRemoteGroupEvents(events = [], options = {}) {
  const items = (Array.isArray(events) ? events : []).filter((event) => event?.t === 'group_remote');
  const userId = clean(options.userId);
  const allowedGroupIds = new Set((Array.isArray(options.allowedGroupIds) ? options.allowedGroupIds : [])
    .map(clean)
    .filter(Boolean));
  const receipts = [];
  const actions = [];
  let handled = 0;
  let skipped = 0;

  for (const event of items) {
    const groupId = clean(event.groupId || event.targetChatId || event.chatId);
    const local = remoteGroupEventToLocal(event);
    if (!local) {
      skipped += 1;
      receipts.push(createChatRoundReceipt({
        code: 'remote_group_operation_invalid',
        status: 'blocked',
        stage: 'remote-group',
        eventType: 'group_remote',
        chatId: groupId,
        context: { operation: clean(event.operation || event.op || event.action), groupId },
      }));
      continue;
    }
    if (!groupId || !allowedGroupIds.has(groupId)) {
      skipped += 1;
      receipts.push(createChatRoundReceipt({
        code: 'remote_group_target_not_allowed',
        status: 'blocked',
        stage: 'remote-group',
        eventType: local.t,
        chatId: groupId,
        context: { actorId: local.from, groupId },
      }));
      continue;
    }
    const target = await getChat(groupId).catch(() => null);
    if (!target || target.type !== 'group') {
      skipped += 1;
      receipts.push(createChatRoundReceipt({
        code: 'remote_group_target_missing',
        status: 'blocked',
        stage: 'remote-group',
        eventType: local.t,
        chatId: groupId,
        context: { actorId: local.from, groupId },
      }));
      continue;
    }
    if (!(target.participants || []).includes(local.from)) {
      skipped += 1;
      receipts.push(createChatRoundReceipt({
        code: 'remote_group_actor_not_member',
        status: 'blocked',
        stage: 'remote-group',
        eventType: local.t,
        chatId: groupId,
        context: { actorId: local.from, groupId },
      }));
      continue;
    }
    const result = local.t === 'invite_user'
      ? await applyMarshmallowGroupInviteUserEvents([local], {
        sourceChatId: target.id,
        sourceChat: target,
        userId,
        aiRoundId: options.aiRoundId,
        resolveName: options.resolveName,
      })
      : await applyMarshmallowGroupAdminEvents([local], {
        sourceChatId: target.id,
        sourceChat: target,
        userId,
        aiRoundId: options.aiRoundId,
        resolveName: options.resolveName,
        allowedAddMemberIds: options.allowedAddMemberIds,
        explicitUserRequest: true,
      });
    const effective = result?.effective === true || Number(result?.handled || 0) > 0;
    if (effective) {
      handled += Math.max(1, Number(result?.handled || 0));
      actions.push({ type: local.t, targetChatId: target.id, actorId: local.from });
    } else {
      skipped += 1;
      if (result?.receipts?.length) receipts.push(...result.receipts);
      else receipts.push(createChatRoundReceipt({
        code: 'remote_group_operation_rejected',
        status: 'blocked',
        stage: 'remote-group',
        eventType: local.t,
        chatId: groupId,
        context: { actorId: local.from, groupId },
      }));
    }
  }
  return { handled, skipped, actions, receipts };
}

function crossWindowGroupContextText(sourceMessages = [], generatedMessage = null) {
  return [
    ...(Array.isArray(sourceMessages) ? sourceMessages : []).slice(-10)
      .filter((message) => message && !message.deleted && !message.recalled)
      .map((message) => String(message.content || '')),
    String(generatedMessage?.content || generatedMessage?.body || ''),
  ].join('\n');
}

function uniqueReferencedGroup(groups = [], contextText = '') {
  const text = String(contextText || '');
  const named = (Array.isArray(groups) ? groups : []).filter((group) => {
    const name = clean(group?.groupSettings?.name || group?.title);
    return name && text.includes(name);
  });
  if (named.length === 1) return named[0];
  return groups.length === 1 ? groups[0] : null;
}

/**
 * 私聊/角色手机侧窗里，角色明确说自己已经操作了“另一扇群窗”时，只有目标群能被
 * 唯一定位才真实落地。多群歧义时不猜，避免把一个群的邀请或名字误写到另一个群。
 */
export async function applyClaimedCrossWindowGroupActions(messages = [], options = {}) {
  const sourceChat = options.sourceChat || null;
  const userId = clean(options.userId || sourceChat?.userId);
  const sourceMessages = Array.isArray(options.sourceMessages) ? options.sourceMessages : [];
  if (!userId || !sourceChat || sourceChat.type === 'group') {
    return { handled: 0, skipped: 0, actions: [] };
  }
  const generated = (Array.isArray(messages) ? messages : []).map((message, messageIndex) => ({
    message,
    messageIndex,
  })).filter(({ message }) => {
    const senderId = clean(message?.senderId || message?.from);
    return senderId && senderId !== 'user' && senderId !== 'system';
  });
  if (!generated.length) return { handled: 0, skipped: 0, actions: [] };
  const groups = (await listChatsForUser(userId).catch(() => []))
    .filter((chat) => chat?.type === 'group');
  let handled = 0;
  let skipped = 0;
  const actions = [];
  const failedClaims = [];
  const receipts = [];
  const completed = new Set(Array.isArray(options.completedActions) ? options.completedActions : []);

  for (const { message, messageIndex } of generated) {
    const actorId = clean(message.senderId || message.from);
    const body = clean(message.content || message.body);
    const contextText = crossWindowGroupContextText(sourceMessages, message);
    const actorGroups = groups.filter((group) => (group.participants || []).includes(actorId));
    if (isCompletedInviteClaim(body) && !completed.has(`invite:${actorId}`)) {
      const target = uniqueReferencedGroup(actorGroups.filter((group) => (
        !(group.participants || []).includes('user')
        && group.groupSettings?.userTopicPolicy !== 'off'
      )), contextText);
      if (target) {
        const result = await applyMarshmallowGroupInviteUserEvents([
          { t: 'invite_user', from: actorId, note: '邀请你加入群聊' },
        ], {
          sourceChatId: target.id,
          sourceChat: target,
          userId,
          aiRoundId: options.aiRoundId,
          resolveName: options.resolveName,
        });
        if (result.effective || result.handled) {
          handled += Math.max(1, Number(result.handled || 0));
          actions.push({ type: 'invite_user', targetChatId: target.id, actorId });
        } else {
          skipped += 1;
          const code = clean(result?.receipts?.[0]?.code) || 'group_invite_user_skipped';
          failedClaims.push({ messageIndex, type: 'invite_user', code });
          receipts.push(...(result?.receipts || []));
        }
        completed.add(`invite:${actorId}`);
      } else {
        skipped += 1;
        failedClaims.push({ messageIndex, type: 'invite_user', code: 'cross_window_group_target_ambiguous' });
        receipts.push(createChatRoundReceipt({
          code: 'cross_window_group_target_ambiguous',
          status: 'blocked',
          stage: 'cross-window-group-claim',
          eventType: 'invite_user',
          context: { actorId },
        }));
      }
    }

    const name = claimedGroupName(body);
    if (name && !completed.has(`rename:${actorId}`)) {
      const manageable = actorGroups.filter((group) => {
        if (group.groupSettings?.allowAiGroupOps === false) return false;
        const owner = clean(group.groupSettings?.owner)
          || ((group.participants || []).includes('user')
            ? 'user'
            : clean((group.participants || []).find((id) => id && id !== 'user')));
        return actorId === owner || (group.groupSettings?.admins || []).includes(actorId);
      });
      const target = uniqueReferencedGroup(manageable, contextText);
      if (target) {
        const explicitUserRequest = [...sourceMessages].reverse().slice(0, 10)
          .some(isExplicitGroupRenameRequest);
        const result = await applyMarshmallowGroupAdminEvents([
          { t: 'group_name', from: actorId, name },
        ], {
          sourceChatId: target.id,
          sourceChat: target,
          userId,
          aiRoundId: options.aiRoundId,
          resolveName: options.resolveName,
          explicitUserRequest,
        });
        if (result.handled) {
          handled += result.handled;
          actions.push({ type: 'group_name', targetChatId: target.id, actorId, name });
        } else {
          skipped += 1;
          const code = clean(result?.receipts?.[0]?.context?.failureCodes?.[0])
            || clean(result?.receipts?.[0]?.code)
            || 'remote_group_operation_rejected';
          failedClaims.push({ messageIndex, type: 'group_name', code });
          receipts.push(...(result?.receipts || []));
        }
        completed.add(`rename:${actorId}`);
      } else {
        skipped += 1;
        failedClaims.push({ messageIndex, type: 'group_name', code: 'cross_window_group_target_ambiguous' });
        receipts.push(createChatRoundReceipt({
          code: 'cross_window_group_target_ambiguous',
          status: 'blocked',
          stage: 'cross-window-group-claim',
          eventType: 'group_name',
          context: { actorId },
        }));
      }
    }
  }

  const recentUserMessage = [...sourceMessages].reverse().find((message) => (
    clean(message?.senderId || message?.from) === 'user' && !message?.deleted && !message?.recalled
  ));
  const fallbackActorId = clean(generated[0]?.message?.senderId || generated[0]?.message?.from)
    || clean((sourceChat.participants || []).find((id) => id && id !== 'user'));
  if (fallbackActorId && recentUserMessage && isExplicitGroupInviteRequest(recentUserMessage)
    && !completed.has(`invite:${fallbackActorId}`)) {
    const contextText = crossWindowGroupContextText(sourceMessages, generated[0]?.message);
    const target = uniqueReferencedGroup(groups.filter((group) => (
      (group.participants || []).includes(fallbackActorId)
      && !(group.participants || []).includes('user')
      && group.groupSettings?.userTopicPolicy !== 'off'
    )), contextText);
    if (target) {
      const result = await applyMarshmallowGroupInviteUserEvents([
        { t: 'invite_user', from: fallbackActorId, note: '应你的请求邀请你加入群聊' },
      ], {
        sourceChatId: target.id,
        sourceChat: target,
        userId,
        aiRoundId: options.aiRoundId,
        resolveName: options.resolveName,
      });
      if (result.effective || result.handled) {
        handled += Math.max(1, Number(result.handled || 0));
        actions.push({ type: 'invite_user', targetChatId: target.id, actorId: fallbackActorId, explicitRequest: true });
      } else {
        skipped += 1;
        receipts.push(...(result?.receipts || []));
      }
      completed.add(`invite:${fallbackActorId}`);
    } else {
      skipped += 1;
      receipts.push(createChatRoundReceipt({
        code: 'cross_window_group_target_ambiguous',
        status: 'blocked',
        stage: 'cross-window-group-request',
        eventType: 'invite_user',
        context: { actorId: fallbackActorId },
      }));
    }
  }

  const requestedName = requestedGroupName(recentUserMessage);
  if (fallbackActorId && requestedName && !completed.has(`rename:${fallbackActorId}`)) {
    const contextText = crossWindowGroupContextText(sourceMessages, generated[0]?.message);
    const manageable = groups.filter((group) => {
      if (!(group.participants || []).includes(fallbackActorId) || group.groupSettings?.allowAiGroupOps === false) return false;
      const owner = clean(group.groupSettings?.owner)
        || ((group.participants || []).includes('user')
          ? 'user'
          : clean((group.participants || []).find((id) => id && id !== 'user')));
      return fallbackActorId === owner || (group.groupSettings?.admins || []).includes(fallbackActorId);
    });
    const target = uniqueReferencedGroup(manageable, contextText);
    if (target) {
      const result = await applyMarshmallowGroupAdminEvents([
        { t: 'group_name', from: fallbackActorId, name: requestedName },
      ], {
        sourceChatId: target.id,
        sourceChat: target,
        userId,
        aiRoundId: options.aiRoundId,
        resolveName: options.resolveName,
        explicitUserRequest: true,
      });
      if (result.handled) {
        handled += result.handled;
        actions.push({ type: 'group_name', targetChatId: target.id, actorId: fallbackActorId, name: requestedName, explicitRequest: true });
      } else {
        skipped += 1;
        receipts.push(...(result?.receipts || []));
      }
      completed.add(`rename:${fallbackActorId}`);
    } else {
      skipped += 1;
      receipts.push(createChatRoundReceipt({
        code: 'cross_window_group_target_ambiguous',
        status: 'blocked',
        stage: 'cross-window-group-request',
        eventType: 'group_name',
        context: { actorId: fallbackActorId },
      }));
    }
  }

  return { handled, skipped, actions, failedClaims, receipts };
}

export async function applyMarshmallowPrivateMsgEvents(events = [], options = {}) {
  const sourceChatId = clean(options.sourceChatId || options.sourceChat?.id);
  const userId = clean(options.userId);
  const userName = clean(options.userName || '用户') || '用户';
  const userRow = options.userRow || null;
  const resolveName = typeof options.resolveName === 'function'
    ? options.resolveName
    : async (id) => id;
  const sourceChat = options.sourceChat || (sourceChatId ? await getChat(sourceChatId) : null);
  const anonGroup = !!(sourceChat && isAnonymousChat(sourceChat) && sourceChat.type === 'group');
  const sourceParticipantIds = new Set((Array.isArray(sourceChat?.participants) ? sourceChat.participants : [])
    .map((id) => clean(id))
    .filter(Boolean));
  const allowPrivate = options.allowPrivateLinkage === true;
  const items = (Array.isArray(events) ? events : []).filter((e) => e?.t === 'private_msg');
  if (!items.length || !allowPrivate || !userId) {
    return {
      handled: 0,
      chats: [],
      receipts: items.length ? [createChatRoundReceipt({
        code: !allowPrivate ? 'private_linkage_disabled' : 'private_context_invalid',
        status: 'blocked',
        stage: 'private-msg',
        eventType: 'private_msg',
        chatId: sourceChatId,
        context: { count: items.length },
      })] : [],
    };
  }

  const saved = [];
  let dropped = 0;
  for (const event of items) {
    const fromId = clean(event.from || event.actor);
    const targetId = clean(event.to);
    const body = clean(event.body || event.text || event.content);
    const translation = sanitizeAiTranslation(body, event.zh || event.translation);
    // private_msg 的唯一合法收件人是主用户。即使调用方绕过了协议校验，
    // 也不能把缺失/错误收件人的内容默认塞进角色与用户的主私聊。
    if (
      !fromId
      || fromId === 'user'
      || targetId !== 'user'
      || !body
      // 协议层通常已把 C1 / 角色名解析成真实 participant id；这里仍需做落库硬门槛。
      // 否则任何绕过校验或旧调用链传来的英文代号都会被 ensurePrivateChat 当成新角色，
      // 形成“群里名字变字母 + 列表多一个同角色私聊”，删除后下一轮还会重建。
      || sourceChat?.type !== 'group'
      || !sourceParticipantIds.has(fromId)
    ) {
      dropped += 1;
      continue;
    }
    let dm;
    let senderName;
    if (anonGroup) {
      dm = await createAnonymousPrivateFromGroup({
        userId,
        userRow,
        sourceChat,
        counterpartActorId: fromId,
        seedOpening: false,
      });
      senderName = getAnonymousDisplayProfile(sourceChat, fromId, { currentUserName: userName, userRow })?.anonymousId
        || await resolveName(fromId);
      await buildAnonymousContactEntry({
        userId,
        chat: sourceChat,
        actorId: fromId,
        privateChatId: dm.id,
      }).catch(() => null);
    } else {
      dm = await ensurePrivateChat(userId, fromId, await resolveName(fromId));
      senderName = await resolveName(fromId);
    }
    const ts = await getNowForUser(userId);
    const msg = createMessage({
      chatId: dm.id,
      senderId: fromId,
      senderName,
      type: 'text',
      content: body,
      timestamp: ts,
      metadata: {
        aiGenerated: true,
        aiRoundId: options.aiRoundId || '',
        sourceAiRoundId: options.sourceAiRoundId || options.aiRoundId || '',
        sourceChatId: options.sourceChatId || '',
        marshmallowEventType: 'private_msg',
        sourceGroupChatId: sourceChatId,
        ...translation ? { translation } : {},
        ...event.inner ? { innerVoice: event.inner } : {},
      },
    });
    await saveMessage(msg);
    await updateChatPreview(dm.id, previewFromMessage(msg), msg.timestamp);
    await bumpChatUnread(dm.id, 1);
    saved.push({ chatId: dm.id, messageId: msg.id, actorId: fromId });
  }
  return {
    handled: saved.length,
    chats: saved,
    receipts: dropped ? [createChatRoundReceipt({
      code: 'private_message_rows_dropped',
      status: 'dropped',
      stage: 'private-msg',
      eventType: 'private_msg',
      chatId: sourceChatId,
      context: { dropped, handled: saved.length },
    })] : [],
  };
}
