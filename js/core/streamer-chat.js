/**
 * 主播私聊 / 粉丝群：直接复用主聊天引擎（chats/messages + runChatAiTurn 全套协议），
 * 只是套上和匿名聊一致的身份隔离（memoryMode: room_only + 马甲展示），
 * 这样打开后走的是与普通聊天完全一致的 chat/thread 页面与 AI 回合逻辑。
 */
import { createChat, createMessage } from '../models/chat.js';
import { saveChat, saveMessage, updateChatPreview, listChatsForUser, listMessagesForChat } from './chat-store.js';
import * as db from './db.js';
import { ensureUniqueAnonymousIdentityMap } from './anonymous-chat.js';
import { getNowForUser } from './time-mode.js';
import { persistAnonymousNpcs } from './anonymous-npc.js';
import { getStreamerChannel, saveStreamerChannel } from './streamer-store.js';
import { getStreamerPopularityTierById } from '../data/streamer-presets.js';
import { generateStreamerFanGroupBatchAI, buildStreamerIsolationRules } from './streamer-ai.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

function randomInRange([min, max] = [100, 300]) {
  const lo = Number(min) || 0;
  const hi = Number(max) || lo;
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// 隔离/马甲措辞统一复用 streamer-ai.js 的 buildStreamerIsolationRules，避免私聊/粉丝群和直播间各写一份、逐渐漂移
function buildPersonaContextText(channel = {}) {
  const p = channel.persona || {};
  return [
    `你是深夜直播里主播「${p.handle || '匿名主播'}」的马甲人格，这是从直播间延伸出来的私聊/粉丝群场景。`,
    buildStreamerIsolationRules(),
    p.categoryLabel ? `直播类型：${p.categoryLabel}` : '',
    p.streamReason ? `为什么直播：${p.streamReason}` : '',
    p.worldSetting ? `世界观/设定：${p.worldSetting}` : '',
    p.personality ? `性格底色：${p.personality}` : '',
    p.speechStyle ? `说话风格：${p.speechStyle}` : '',
    p.signature ? `签名：${p.signature}` : '',
  ].filter(Boolean).join('\n');
}

/** 生成来源主播没有真实角色可挂靠时，惰性落一个匿名 NPC 角色档案，之后私聊/粉丝群都复用这个 actorId */
export async function resolveStreamerChatActorId(channel = {}) {
  if (channel.sourceType === 'character' && clean(channel.characterId)) return clean(channel.characterId);
  if (clean(channel.personaActorId)) return clean(channel.personaActorId);
  const [npc] = await persistAnonymousNpcs([{
    anonymousId: channel.persona?.handle,
    personality: channel.persona?.personality,
    speechStyle: channel.persona?.speechStyle,
    signature: channel.persona?.signature,
  }], { ephemeral: channel.ephemeral === true });
  await saveStreamerChannel({ ...channel, personaActorId: npc.actorId }).catch(() => {});
  return npc.actorId;
}

export async function findStreamerPrivateChat(userId, channelId) {
  const uid = clean(userId);
  const cid = clean(channelId);
  if (!uid || !cid) return null;
  const chats = await listChatsForUser(uid);
  return chats.find((c) => c.type === 'private' && clean(c.metadata?.streamerChannelId) === cid) || null;
}

export async function ensureStreamerPrivateChat(userId, channel) {
  const uid = clean(userId);
  if (!uid || !channel?.id) throw new Error('参数不完整');
  const existing = await findStreamerPrivateChat(uid, channel.id);
  if (existing) {
    const counterpartActorId = clean(existing.anonymousPrivateConfig?.counterpartActorId)
      || (existing.participants || []).find((p) => p && p !== 'user');
    const currentId = clean(existing.anonymousPrivateConfig?.identities?.[counterpartActorId]?.currentId);
    const expectedHandle = clean(channel.persona?.handle) || '匿名主播';
    // 人设可能在「主播空间 › 编辑设定」里被改过：重进私聊时把展示身份和 system prompt 描述都刷新到最新，
    // 不需要额外的一次性迁移脚本。
    const expectedDescription = buildPersonaContextText(channel);
    const identityStale = !currentId || currentId !== expectedHandle;
    const descriptionStale = existing.metadata?.descriptionEditedByUser !== true
      && clean(existing.metadata?.description) !== expectedDescription;
    if (identityStale || descriptionStale) {
      if (identityStale) {
        const identities = ensureUniqueAnonymousIdentityMap({
          user: { currentId: '我' },
          [counterpartActorId]: {
            ...(existing.anonymousPrivateConfig?.identities?.[counterpartActorId] || {}),
            currentId: expectedHandle,
            signature: clean(channel.persona?.signature),
            avatar: clean(channel.persona?.avatar) || clean(channel.persona?.avatarCover),
          },
        }, ['user', counterpartActorId]);
        existing.anonymousPrivateConfig = {
          ...(existing.anonymousPrivateConfig || {}),
          selfActorId: 'user',
          counterpartActorId,
          identities,
        };
      }
      if (descriptionStale) {
        existing.metadata = { ...(existing.metadata || {}), description: expectedDescription };
      }
      await saveChat(existing);
    }
    return existing;
  }

  const actorId = await resolveStreamerChatActorId(channel);
  const id = `streamer_priv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const identities = ensureUniqueAnonymousIdentityMap({
    user: { currentId: '我' },
    [actorId]: {
      currentId: clean(channel.persona?.handle) || '匿名主播',
      signature: clean(channel.persona?.signature),
      avatar: clean(channel.persona?.avatar) || clean(channel.persona?.avatarCover),
    },
  }, ['user', actorId]);

  const chat = createChat({
    id,
    type: 'private',
    userId: uid,
    participants: ['user', actorId],
    metadata: {
      channel: 'anonymous',
      anonymousMode: true,
      anonymousRoomKind: 'private',
      anonymousRoomId: id,
      sourceAnonymousType: 'streamer_private',
      streamerChannelId: channel.id,
      memoryMode: 'room_only',
      description: buildPersonaContextText(channel),
    },
    anonymousPrivateConfig: {
      selfActorId: 'user',
      counterpartActorId: actorId,
      identities,
    },
  });
  chat.lastActivity = await getNowForUser(uid);
  await saveChat(chat);

  const ts = await getNowForUser(uid);
  const notice = `已私信 ${channel.persona?.handle || '主播'}`;
  const opener = createMessage({
    chatId: id,
    senderId: 'system',
    senderName: '系统',
    type: 'system',
    content: notice,
    timestamp: ts,
    metadata: { anonymousSeed: true, roomJoinNotice: true },
  });
  await saveMessage(opener);
  await updateChatPreview(id, notice, opener.timestamp);
  return chat;
}

export async function findStreamerFanGroup(userId, channelId) {
  const uid = clean(userId);
  const cid = clean(channelId);
  if (!uid || !cid) return null;
  const chats = await listChatsForUser(uid);
  return chats.find((c) => c.type === 'group'
    && clean(c.metadata?.streamerChannelId) === cid
    && clean(c.metadata?.sourceAnonymousType) === 'streamer_fan_group') || null;
}

/**
 * 粉丝群不维护持久路人档案：群里显示的是虚构的大人数（按人气档位随机），
 * 实际说话的路人由 AI 每轮现场虚构网名，不占用 participants/anonymousNpc 记录。
 * 参与者只有 user + 主播本人 actorId，主播马甲身份复用主播私聊同一套。
 */
export async function ensureStreamerFanGroup(userId, channel) {
  const uid = clean(userId);
  if (!uid || !channel?.id) throw new Error('参数不完整');
  const existing = await findStreamerFanGroup(uid, channel.id);
  if (existing) {
    // 与私聊对齐：人设编辑后重进粉丝群，把马甲展示身份和 system prompt 描述都刷新到最新
    const actorId = await resolveStreamerChatActorId(channel);
    const expectedHandle = clean(channel.persona?.handle) || '匿名主播';
    const currentId = clean(existing.groupSettings?.anonymousIdentities?.[actorId]?.currentId);
    const expectedDescription = buildPersonaContextText(channel);
    const identityStale = !currentId || currentId !== expectedHandle;
    const descriptionEditedByUser = existing.metadata?.descriptionEditedByUser === true;
    const descriptionStale = !descriptionEditedByUser
      && clean(existing.metadata?.description) !== expectedDescription;
    if (identityStale || descriptionStale) {
      const identities = identityStale
        ? ensureUniqueAnonymousIdentityMap({
          user: { currentId: '我' },
          [actorId]: {
            ...(existing.groupSettings?.anonymousIdentities?.[actorId] || {}),
            currentId: expectedHandle,
            signature: clean(channel.persona?.signature),
            avatar: clean(channel.persona?.avatar) || clean(channel.persona?.avatarCover),
          },
        }, ['user', actorId])
        : existing.groupSettings?.anonymousIdentities;
      const groupName = `${expectedHandle} 的粉丝群`;
      existing.groupSettings = {
        ...(existing.groupSettings || {}),
        name: groupName,
        description: descriptionEditedByUser
          ? existing.groupSettings?.description
          : `${channel.persona?.categoryLabel || ''}主播粉丝群`,
        anonymousIdentities: identities,
        anonymousRoomConfig: {
          ...(existing.groupSettings?.anonymousRoomConfig || {}),
          topic: groupName,
          description: expectedDescription,
        },
      };
      if (descriptionStale) {
        existing.metadata = { ...(existing.metadata || {}), description: expectedDescription };
      }
      await saveChat(existing);
    }
    return existing;
  }

  const actorId = await resolveStreamerChatActorId(channel);
  const tier = getStreamerPopularityTierById(channel.persona?.popularityTier);
  const memberCount = randomInRange(tier.fanGroupMemberRange || [100, 300]);

  const identities = ensureUniqueAnonymousIdentityMap({
    user: { currentId: '我' },
    [actorId]: {
      currentId: clean(channel.persona?.handle) || '匿名主播',
      signature: clean(channel.persona?.signature),
      avatar: clean(channel.persona?.avatar) || clean(channel.persona?.avatarCover),
    },
  }, ['user', actorId]);

  const id = `streamer_fan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const groupName = `${channel.persona?.handle || '匿名主播'} 的粉丝群`;
  const chat = createChat({
    id,
    type: 'group',
    userId: uid,
    participants: ['user', actorId],
    groupSettings: {
      name: groupName,
      description: `${channel.persona?.categoryLabel || ''}主播粉丝群`,
      anonymousIdentities: identities,
      anonymousRoomConfig: {
        topic: groupName,
        description: buildPersonaContextText(channel),
      },
      fanGroupMemberCount: memberCount,
    },
    metadata: {
      channel: 'anonymous',
      anonymousMode: true,
      anonymousRoomKind: 'group',
      sourceAnonymousType: 'streamer_fan_group',
      streamerChannelId: channel.id,
      memoryMode: 'room_only',
      description: buildPersonaContextText(channel),
      fanGroupCrowdSim: true,
    },
  });
  chat.lastActivity = await getNowForUser(uid);
  await saveChat(chat);

  const ts = await getNowForUser(uid);
  const notice = `粉丝群建好了，约 ${memberCount} 人关注着「${channel.persona?.handle || '匿名主播'}」`;
  const opener = createMessage({
    chatId: id,
    senderId: 'system',
    senderName: '系统',
    type: 'system',
    content: notice,
    timestamp: ts,
    metadata: { anonymousSeed: true, roomJoinNotice: true },
  });
  await saveMessage(opener);
  await updateChatPreview(id, notice, opener.timestamp);

  try {
    await runStreamerFanGroupRound(uid, chat, { channel });
  } catch (_) { /* 开场热闹一下失败也不影响群创建 */ }
  return chat;
}

function makeStreamerRoundId() {
  return `sround_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 粉丝群一轮：AI 现场虚构一批路人发言 + 主播（可选）搭话，直接写消息，不走棉花糖协议/AI 回合。
 * 每条消息都打上同一个 aiRoundId，重 roll 时才能整轮删干净，不残留上一轮的路人发言/主播回复。
 */
export async function runStreamerFanGroupRound(userId, chat, { channel = null, userMessage = '', aiRoundId = '' } = {}) {
  const uid = clean(userId);
  if (!uid || !chat?.id) throw new Error('参数不完整');
  const channelId = clean(chat.metadata?.streamerChannelId);
  const resolvedChannel = channel || (channelId ? await getStreamerChannel(channelId) : null);
  if (!resolvedChannel) throw new Error('主播频道不存在');
  const roundId = clean(aiRoundId) || makeStreamerRoundId();

  const recentMsgs = await listMessagesForChat(chat.id, 16).catch(() => []);
  const recentLines = recentMsgs
    .filter((m) => m && !m.deleted && m.senderId !== 'system' && m.senderId !== 'user')
    .slice(-12)
    .map((m) => ({ from: m.senderName || m.senderId, text: m.content }));

  const memberCount = Number(chat.groupSettings?.fanGroupMemberCount) || 0;
  const userRow = await db.getRecord('users', uid).catch(() => null);
  const batch = await generateStreamerFanGroupBatchAI({
    channel: resolvedChannel,
    user: userRow,
    memberCount,
    userMessage,
    recentLines,
  });

  const actorId = await resolveStreamerChatActorId(resolvedChannel);
  const reserved = new Set(['user', 'system', actorId]);
  let ts = await getNowForUser(uid);
  let lastPreview = '';
  for (const row of batch.crowd) {
    ts += 400 + Math.floor(Math.random() * 800);
    const fromName = reserved.has(row.from) ? `路人${Math.floor(100 + Math.random() * 900)}` : row.from;
    const msg = createMessage({
      chatId: chat.id,
      senderId: fromName,
      senderName: fromName,
      type: 'text',
      content: row.text,
      timestamp: ts,
      metadata: { streamerFanCrowd: true, aiRoundId: roundId, aiGenerated: true },
    });
    await saveMessage(msg);
    lastPreview = `${fromName}：${row.text}`;
  }
  if (batch.streamerReply) {
    ts += 500 + Math.floor(Math.random() * 600);
    const msg = createMessage({
      chatId: chat.id,
      senderId: actorId,
      type: 'text',
      content: batch.streamerReply,
      timestamp: ts,
      metadata: { aiRoundId: roundId, aiGenerated: true },
    });
    await saveMessage(msg);
    lastPreview = batch.streamerReply;
  }
  if (lastPreview) await updateChatPreview(chat.id, lastPreview, ts);
  return { ...batch, aiRoundId: roundId };
}
