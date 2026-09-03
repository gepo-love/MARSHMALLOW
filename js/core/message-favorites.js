import { saveCollectible, listCollectiblesForUser } from './collectibles.js';
import { getMessageCopyText } from './chat-helpers.js';
import { getRecord } from './db.js';

export const FAVORITE_SOURCES = Object.freeze(['message_favorite', 'offline_favorite']);

export function isMessageFavorite(item = {}) {
  return FAVORITE_SOURCES.includes(String(item?.source || ''));
}

function cleanIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
}

function recordIds(values = []) {
  const rows = Array.isArray(values) ? values : (values == null ? [] : [values]);
  const seen = new Set();
  return rows.filter((id) => {
    if (id == null || id === '') return false;
    const key = `${typeof id}:${String(id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeFavoriteMetadata(type, metadata = {}) {
  const next = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  if (type !== 'image' && type !== 'sticker') return next;

  const prompt = String(next.prompt || '').trim();
  const caption = String(next.caption || '').trim();
  // 生图 prompt 是内部生成参数，不是角色真正发送的图片说明。
  // 用户主动生图发送时 prompt 会暂存在 caption，并带 userDrawnImage 标记。
  if ((prompt && caption === prompt) || next.userDrawnImage === true) delete next.caption;
  delete next.prompt;
  delete next.userDrawnImage;
  return next;
}

function normalizeStoredFavoriteMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const type = String(message.type || 'text').trim() || 'text';
  // 旧收藏读取、从原消息补快照时都在这一层清理，避免历史数据继续展示提示词。
  const metadata = sanitizeFavoriteMetadata(type, message.metadata);
  return {
    ...message,
    senderId: String(message.senderId || '').trim(),
    senderName: String(message.senderName || '').trim(),
    type,
    content: String(message.content || ''),
    timestamp: Number(message.timestamp || 0) || 0,
    metadata,
  };
}

export function normalizeMessageFavoriteForRead(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || !isMessageFavorite(item)) return null;
  const characterIdValues = Array.isArray(item.characterIds)
    ? item.characterIds
    : (item.characterIds != null ? [item.characterIds] : [item.characterId]);
  return {
    ...item,
    characterIds: cleanIds(characterIdValues),
    sourceMessageIds: recordIds(item.sourceMessageIds),
    messages: (Array.isArray(item.messages) ? item.messages : [])
      .map(normalizeStoredFavoriteMessage)
      .filter(Boolean),
  };
}

async function loadFavoriteOriginalMessage(id, loadMessage) {
  try {
    const row = await loadMessage(id);
    return normalizeStoredFavoriteMessage(row);
  } catch (_) {
    return null;
  }
}

export async function restoreFavoriteOriginalMessages(
  item,
  loadMessage = (id) => getRecord('messages', id),
) {
  const normalized = normalizeMessageFavoriteForRead(item);
  if (!normalized) return null;

  const snapshots = normalized.messages;
  const snapshotById = new Map(snapshots
    .filter((message) => message.id != null && message.id !== '')
    .map((message) => [String(message.id), message]));
  const sourceIds = recordIds(normalized.sourceMessageIds);
  let messages = snapshots;

  if (sourceIds.length) {
    const lookupIds = sourceIds.slice(0, 200);
    const ordered = await Promise.all(lookupIds.map(async (id) => (
      snapshotById.get(String(id))
      || loadFavoriteOriginalMessage(id, loadMessage)
    )));
    const sourceKeys = new Set(lookupIds.map((id) => String(id)));
    messages = [
      ...ordered.filter(Boolean),
      ...snapshots.filter((message) => (
        message.id == null
        || message.id === ''
        || !sourceKeys.has(String(message.id))
      )),
    ];
  }

  const restored = await Promise.all(messages.map(async (message) => {
    const type = String(message.type || '');
    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
    const missingHtml = type === 'htmlWidget' && !metadata.htmlExtension;
    const missingImage = ['image', 'sticker'].includes(type)
      && !String(message.content || metadata.url || metadata.imageUrl || metadata.src || '').trim();
    const missingTextImage = type === 'textimg' && !String(message.content || '').trim();
    if (message.id == null || message.id === '' || (!missingHtml && !missingImage && !missingTextImage)) {
      return message;
    }
    const original = await loadFavoriteOriginalMessage(message.id, loadMessage);
    if (!original || String(original.type || '') !== type) return message;
    return normalizeStoredFavoriteMessage({
      ...original,
      ...message,
      content: String(message.content || original.content || ''),
      metadata: { ...(original.metadata || {}), ...metadata },
    });
  }));

  return { ...normalized, messages: restored.filter(Boolean) };
}

function compactMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') return {};
  const keep = [
    'url', 'imageUrl', 'src', 'caption', 'prompt', 'userDrawnImage', 'text', 'transcript', 'duration',
    'translation', 'replyPreview', 'title', 'address', 'name', 'bundleTitle',
    'audioCacheKey', 'audioVoiceId', 'audioModel', 'audioFormat', 'audioGeneratedAt',
    'sendAsCharacterId', 'userComposedAsCharacter', 'avatar', 'htmlExtension', 'narratorBeat',
  ];
  return Object.fromEntries(keep
    .filter((key) => metadata[key] != null)
    .map((key) => [key, metadata[key]]));
}

export function snapshotFavoriteMessage(message = {}) {
  const type = String(message.type || 'text').trim() || 'text';
  const metadata = sanitizeFavoriteMetadata(type, compactMetadata(message.metadata));
  if (!metadata.translation && message.translation) metadata.translation = String(message.translation);
  return {
    id: String(message.id || '').trim(),
    senderId: String(message.senderId || '').trim(),
    senderName: String(message.senderName || '').trim(),
    type,
    content: String(message.content || ''),
    timestamp: Number(message.timestamp || 0) || 0,
    metadata,
  };
}

function favoriteBody(messages = []) {
  return messages.map((message) => {
    const name = String(message.senderName || (message.senderId === 'user' ? '我' : 'TA')).trim() || 'TA';
    const type = String(message.type || 'text');
    const mediaText = type === 'image'
      ? String(message.metadata?.caption || '').trim()
      : (type === 'voice' ? String(message.metadata?.transcript || message.metadata?.text || '').trim() : '');
    const text = mediaText
      || (type === 'image' ? '[图片]' : (type === 'voice' ? '[语音]' : getMessageCopyText(message)))
      || String(message.content || '').trim()
      || (message.type === 'image' ? '[图片]' : (message.type === 'voice' ? '[语音]' : `[${message.type || '消息'}]`));
    return `${name}：${text}`;
  }).filter(Boolean).join('\n');
}

function firstFavoriteImage(messages = []) {
  const row = messages.find((message) => message.type === 'image'
    && String(message.content || message.metadata?.url || message.metadata?.imageUrl || '').trim());
  return String(row?.content || row?.metadata?.url || row?.metadata?.imageUrl || '').trim();
}

function resolveCharacterIds(chat = {}, messages = [], explicit = []) {
  const pickedSenders = cleanIds(messages.map((message) => message.senderId));
  return cleanIds(explicit.length
    ? explicit
    : (pickedSenders.length ? pickedSenders : chat.participants));
}

export async function saveChatMessageFavorite({
  userId,
  chat,
  messages = [],
  characterIds = [],
  title = '',
  note = '',
  appearance = {},
} = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter(Boolean);
  if (!userId || !chat?.id || !rows.length) throw new Error('缺少可收藏的聊天记录');
  const related = resolveCharacterIds(chat, rows, characterIds);
  if (!related.length) throw new Error('找不到收藏对应的角色');
  const snapshots = rows.map(snapshotFavoriteMessage);
  const timestamp = Math.max(...snapshots.map((row) => row.timestamp || 0), Date.now());
  return saveCollectible({
    id: `fav_msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId,
    characterId: related[0],
    characterIds: related,
    ownership: 'character',
    source: 'message_favorite',
    title: String(title || chat.groupSettings?.name || chat.metadata?.partnerName || '聊天收藏').trim() || '聊天收藏',
    summary: String(note || '').trim(),
    albumNote: String(note || '').trim(),
    body: favoriteBody(snapshots),
    image: firstFavoriteImage(snapshots),
    linkedId: String(chat.id),
    sourceChatId: String(chat.id),
    sourceMessageIds: snapshots.map((row) => row.id).filter(Boolean),
    messages: snapshots,
    appearance,
    timestamp,
  });
}

export async function saveOfflineFavorite({
  userId,
  session,
  beats = [],
  characterIds = [],
  title = '',
  note = '',
} = {}) {
  const rows = (Array.isArray(beats) ? beats : []).filter((beat) => beat && beat.role !== 'daymark');
  if (!userId || !session?.id || !rows.length) throw new Error('缺少可收藏的线下片段');
  const related = cleanIds(characterIds.length ? characterIds : session.characterIds || session.participantIds);
  if (!related.length) throw new Error('找不到收藏对应的角色');
  const messages = rows.map((beat) => ({
    id: String(beat.id || '').trim(),
    senderId: beat.role === 'directive' || beat.role === 'opening' ? 'user' : related[0],
    senderName: beat.role === 'directive' || beat.role === 'opening' ? '我' : '线下片段',
    type: beat.image?.url ? 'image' : (beat.audio?.url ? 'voice' : 'text'),
    content: String(beat.image?.url || beat.text || ''),
    timestamp: Number(beat.ts || beat.createdAt || 0) || Date.now(),
    metadata: {
      ...(beat.image?.url ? { url: beat.image.url, caption: beat.text || '' } : {}),
      ...(beat.audio?.url ? { url: beat.audio.url, transcript: beat.text || '', duration: beat.audio.duration || '' } : {}),
    },
  }));
  return saveCollectible({
    id: `fav_off_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId,
    characterId: related[0],
    characterIds: related,
    ownership: 'character',
    source: 'offline_favorite',
    title: String(title || session.scene?.title || session.title || '线下收藏').trim() || '线下收藏',
    summary: String(note || '').trim(),
    albumNote: String(note || '').trim(),
    body: rows.map((beat) => String(beat.text || '').trim()).filter(Boolean).join('\n\n'),
    image: String(rows.find((beat) => beat.image?.url)?.image?.url || '').trim(),
    linkedId: String(session.id),
    sourceOfflineSessionId: String(session.id),
    sourceBeatIds: rows.map((beat) => String(beat.id || '').trim()).filter(Boolean),
    messages,
    timestamp: Math.max(...messages.map((row) => row.timestamp || 0), Date.now()),
  });
}

export async function listMessageFavorites(userId, characterId = '') {
  const cid = String(characterId || '').trim();
  const rows = await listCollectiblesForUser(userId);
  return rows
    .map(normalizeMessageFavoriteForRead)
    .filter((item) => item && (!cid || item.characterIds.includes(cid)));
}
