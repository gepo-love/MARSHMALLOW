import { createMessage } from '../models/chat.js';
import { saveMessage, updateChatPreview } from './chat-store.js';
import { getNowForUser } from './time-mode.js';

export async function seedAnonymousMatchOpening({
  chat,
  userId,
  userRow = null,
  isGroup = false,
} = {}) {
  if (!chat?.id) return null;
  const ts = await getNowForUser(userId);
  const identities = chat.groupSettings?.anonymousIdentities
    || chat.anonymousPrivateConfig?.identities
    || {};
  const actorIds = (chat.participants || []).filter((p) => p && p !== 'user' && p !== 'system');
  const joined = actorIds
    .map((actorId) => identities[actorId]?.currentId || actorId)
    .filter(Boolean)
    .slice(0, isGroup ? 6 : 1);
  const content = joined.length
    ? `${joined.join('、')} 进入房间`
    : '匿名房间已创建';
  const msg = createMessage({
    chatId: chat.id,
    senderId: 'system',
    senderName: '系统',
    type: 'system',
    content,
    timestamp: ts,
    metadata: { anonymousSeed: true, matchOpening: false, roomJoinNotice: true },
  });
  await saveMessage(msg);
  await updateChatPreview(chat.id, content, ts);
  return msg;
}
