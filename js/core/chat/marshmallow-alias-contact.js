import { createMessage } from '../../models/chat.js';
import { createAliasPublicSnapshot } from '../alias-account-model.js';
import { getAliasAccount, saveAliasAccount } from '../alias-account-store.js';
import { ensureStrangerThread } from '../stranger-thread-store.js';
import {
  bumpChatUnread,
  getChat,
  listMessagesForChat,
  previewFromMessage,
  saveChat,
  saveMessages,
  updateChatPreview,
} from '../chat-store.js';
import { sanitizeAiTranslation } from '../translation-utils.js';
import { getNowForUser } from '../time-mode.js';
import {
  isCharacterAliasBlockedByUser,
  isStrangerInterceptChat,
} from '../stranger-thread-model.js';
import { applyRoundStateEvents } from './character-state.js';

function clean(value, max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function stablePart(value = '') {
  return clean(value).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'event';
}

export function buildAliasContactDeliveryMetadata(chat, now = Date.now()) {
  if (!isCharacterAliasBlockedByUser(chat)) return {};
  return {
    deliveryBlockedByUser: true,
    deliveryStatus: 'rejected',
    deliveryRejectedAt: Math.max(0, Number(now) || Date.now()),
    deliveryRejectedReason: 'blocked-character-alias-by-user',
  };
}

/** 新建号：handle + displayName 必填；avatarPrompt 或本地 avatar 任一即可 */
export function hasUsableAliasPublicAccount(publicAccount = {}) {
  const handle = clean(publicAccount.handle, 60);
  const displayName = clean(publicAccount.displayName, 60);
  const avatarPrompt = clean(publicAccount.avatarPrompt, 800);
  const avatar = clean(publicAccount.avatar);
  return Boolean(handle && displayName && (avatarPrompt || avatar));
}

export async function applyMarshmallowAliasContactEvents(events = [], options = {}) {
  const userId = clean(options.userId);
  const sourceChatId = clean(options.sourceChatId || options.sourceChat?.id);
  const aiRoundId = clean(options.aiRoundId) || `round_${Date.now()}`;
  const sourceParticipants = new Set(options.sourceChat?.participants || []);
  const results = [];
  if (!userId || !sourceChatId) return results;

  for (const event of Array.isArray(events) ? events : []) {
    const characterId = clean(event?.from || event?.actor || event?.senderId);
    if (!characterId || characterId === 'user' || !sourceParticipants.has(characterId)) continue;
    const saved = await persistAliasContactEvent(event, {
      userId,
      sourceChatId,
      aiRoundId,
    });
    if (saved) results.push(saved);
  }
  return results;
}

export async function persistAliasContactEvent(event = {}, options = {}) {
    const userId = clean(options.userId);
    const sourceChatId = clean(options.sourceChatId);
    const aiRoundId = clean(options.aiRoundId) || `round_${Date.now()}`;
    const characterId = clean(event?.from || event?.actor || event?.senderId);
    if (!userId || !sourceChatId || !characterId || characterId === 'user') return null;
    const reuseAccountId = clean(options.reuseAccountId || event.accountId || event.reuseAccountId, 180);
    const suffix = `${stablePart(aiRoundId)}_${Number(event.sourceIndex || 0)}`;
    let account = null;
    if (reuseAccountId) {
      const existing = await getAliasAccount(reuseAccountId).catch(() => null);
      if (
        !existing
        || existing.ownerType !== 'character'
        || clean(existing.ownerId) !== characterId
        || clean(existing.userId) !== userId
        || existing.status !== 'active'
      ) {
        return null;
      }
      account = existing;
    } else {
      const publicAccount = event.account && typeof event.account === 'object' ? event.account : {};
      if (!hasUsableAliasPublicAccount(publicAccount)) return null;
      account = await saveAliasAccount({
        id: `alias_ai_${stablePart(characterId)}_${suffix}`,
        ownerType: 'character',
        ownerId: characterId,
        userId,
        handle: clean(publicAccount.handle, 60).replace(/^@+/, ''),
        displayName: clean(publicAccount.displayName, 60),
        bio: clean(publicAccount.bio, 300),
        avatar: clean(publicAccount.avatar),
        avatarPrompt: clean(publicAccount.avatarPrompt, 800),
        windowLabel: clean(event.windowLabel || event.motiveKind, 40),
        personaOverlay: clean(event.motive, 4000),
        createdBy: 'ai',
      });
    }
    const chat = await ensureStrangerThread({
      userId,
      characterId,
      characterAccountId: account.id,
      initiatorType: 'character',
      friendshipState: 'intercepted',
    });
    // 自动小号冒泡只能落进独立陌生窗；若存量数据或线程查找异常，宁可拒绝本轮，
    // 也不能把消息/心声状态写进同一角色的正常私聊。
    if (!isStrangerInterceptChat(chat)) return null;
    const latestChat = await getChat(chat.id).catch(() => chat);
    if (!isStrangerInterceptChat(latestChat)) return null;
    const deliveryMetadata = buildAliasContactDeliveryMetadata(latestChat);
    latestChat.metadata = {
      ...(latestChat.metadata || {}),
      accountSnapshots: {
        ...(latestChat.metadata?.accountSnapshots || {}),
        [account.id]: createAliasPublicSnapshot(account),
      },
    };
    await saveChat(latestChat);
    const baseTimestamp = await getNowForUser(userId);
    const batch = (Array.isArray(event.messages) ? event.messages : [])
      .map((item, index) => {
        const body = clean(item?.body || item?.text || item?.content, 500);
        if (!body) return null;
        const translation = sanitizeAiTranslation(body, item?.zh || item?.translation);
        return createMessage({
          id: `msg_alias_${suffix}_${index}`,
          chatId: chat.id,
          senderId: characterId,
          senderName: account.displayName,
          type: 'text',
          content: body,
          timestamp: baseTimestamp + index * 800,
          metadata: {
            protocol: 'MARSHMALLOW_CHAT_V2',
            marshmallowEventType: 'alias_intercept',
            aiGenerated: true,
            aiRoundId,
            sourceChatId,
            sourceEventIndex: event.sourceIndex,
            accountId: account.id,
            ...deliveryMetadata,
            ...(translation ? { translation } : {}),
          },
        });
      })
      .filter(Boolean);
    if (!batch.length) return null;
    const existingIds = new Set((await listMessagesForChat(chat.id, 0).catch(() => [])).map((row) => row.id));
    const newCount = batch.filter((row) => !existingIds.has(row.id)).length;
    await saveMessages(batch);
    // 开号批次不走棉花糖协议：仅当模型给了正经第一人称 state/inner 才落库。
    // 禁止把 motiveKind/triggerEvidence 拼盘当心理声——那会变成剧情总结且容易被截断。
    const stateSrc = event.state && typeof event.state === 'object' ? event.state : event;
    const inner = clean(stateSrc.inner || stateSrc.innerVoice, 400);
    const intent = clean(stateSrc.intent, 60);
    const status = clean(stateSrc.status, 80);
    if (newCount && inner) {
      await applyRoundStateEvents(chat.id, [{
        t: 'state',
        from: characterId,
        inner,
        intent: intent || '先看对方怎么回',
        status: status || '刚发出消息',
        moodShift: Number(stateSrc.moodShift) || 0,
      }], {
        userId,
        aiRoundId,
        resolveSenderName: async () => account.displayName,
        sceneSource: 'alias_intercept_state',
        persistCharacterLiveState: false,
        allowScheduleOverride: false,
      }).catch(() => {});
    }
    const last = batch[batch.length - 1];
    await updateChatPreview(chat.id, previewFromMessage(last), last.timestamp);
    if (newCount) await bumpChatUnread(chat.id, newCount);
    return { chatId: chat.id, accountId: account.id, characterId, count: batch.length };
}
