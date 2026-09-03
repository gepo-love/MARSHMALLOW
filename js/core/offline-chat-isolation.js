import { listOfflineDateArchives } from './offline-date-archive.js';
import { saveChat } from './chat-store.js';

function cleanCharacterIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== 'system'))];
}

function firstAttendanceCharacterId(attendance = null) {
  const members = Array.isArray(attendance?.members) ? attendance.members : [];
  return String(members.find((row) => row?.characterId)?.characterId || '').trim();
}

function resolveOriginalPrivateCharacterId(session = null, archive = null) {
  const originIds = cleanCharacterIds(session?.originChat?.participantIds);
  if (originIds.length === 1) return originIds[0];
  return firstAttendanceCharacterId(session?.attendance || archive?.attendance)
    || String(archive?.characterId || '').trim();
}

function looksLikeOfflinePromotedPrivate(chat = null, session = null) {
  if (!chat || chat.type !== 'group') return false;
  if (session?.originChat?.type === 'private') return true;
  // 历史版本没有 originChat 快照；由 createPrivateChat 写入且在误转群时被保留下来的
  // partnerName 是可靠的兼容标记，正常新建群聊不会带这个字段。
  return !!String(chat.metadata?.partnerName || '').trim();
}

async function restorePrivateChat(chat, characterId, reason) {
  const cid = String(characterId || '').trim();
  if (!looksLikeOfflinePromotedPrivate(chat) || !cid) return false;
  chat.type = 'private';
  chat.participants = ['user', cid];
  chat.metadata = {
    ...(chat.metadata || {}),
    offlinePrivateRestoredAt: Date.now(),
    offlinePrivateRestoreReason: reason,
  };
  // groupSettings 里也承载壁纸与自定义 CSS；原地保留，避免恢复私聊时丢失美化。
  await saveChat(chat);
  return true;
}

/** 修复当前仍有线下会话的旧版误转群，不改动真正从群聊开始的多人线下。 */
export async function restoreOfflineSourcePrivateChat(session, chat) {
  if (!session || !looksLikeOfflinePromotedPrivate(chat, session)) return false;
  const characterId = resolveOriginalPrivateCharacterId(session);
  return restorePrivateChat(chat, characterId, 'active_offline_session');
}

/** 修复已经总结收纳、但来源私聊仍被旧版永久转成群聊的历史数据。 */
export async function restoreArchivedOfflinePrivateChats(userId, chats = []) {
  const candidates = (Array.isArray(chats) ? chats : [])
    .filter((chat) => looksLikeOfflinePromotedPrivate(chat));
  if (!candidates.length) return [];
  const archives = await listOfflineDateArchives(userId, {}).catch(() => []);
  const restoredChatIds = [];
  for (const chat of candidates) {
    const archive = archives
      .filter((row) => String(row?.chatId || '') === String(chat.id || ''))
      .sort((a, b) => Number(a?.startedAt || 0) - Number(b?.startedAt || 0))[0];
    if (!archive) continue;
    const characterId = resolveOriginalPrivateCharacterId(null, archive);
    if (await restorePrivateChat(chat, characterId, 'archived_offline_session')) {
      restoredChatIds.push(String(chat.id || ''));
    }
  }
  return restoredChatIds.filter(Boolean);
}
