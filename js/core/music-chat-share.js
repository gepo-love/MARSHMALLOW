import { createMessage } from '../models/chat.js';
import { getUserDisplayName } from '../models/user.js';
import {
  previewFromMessage,
  saveMessages,
  updateChatPreview,
} from './chat-store.js';

function clean(value = '', max = 600) {
  return String(value ?? '').trim().slice(0, max);
}

export function resolveMusicShareUrl(track = {}) {
  const direct = clean(track.sourceUrl || track.url, 1200);
  if (/^https?:\/\//i.test(direct)) return direct;
  const provider = clean(track.provider || track.source, 40).toLowerCase();
  const providerTrackId = clean(track.providerTrackId || track.neteaseSongId, 120);
  if (provider === 'netease' && providerTrackId) {
    return `https://music.163.com/song?id=${encodeURIComponent(providerTrackId)}`;
  }
  return '';
}

export function buildMusicShareMessages({
  chatId = '',
  user = null,
  track = {},
  caption = '',
  lyric = '',
  timestamp = Date.now(),
} = {}) {
  const targetChatId = clean(chatId, 120);
  const title = clean(track.title, 180) || '未命名歌曲';
  const artist = clean(track.artist, 180);
  const url = resolveMusicShareUrl(track);
  const at = Number(timestamp || 0) || Date.now();
  const senderName = getUserDisplayName(user);
  const card = createMessage({
    chatId: targetChatId,
    senderId: 'user',
    senderName,
    type: 'link',
    content: url || title,
    timestamp: at,
    metadata: {
      title: `🎵 ${title}`,
      url,
      musicTitle: title,
      musicArtist: artist,
      coverUrl: clean(track.coverUrl, 1600),
      source: clean(track.source || track.provider, 40),
      provider: clean(track.provider || track.source, 40),
      providerTrackId: clean(track.providerTrackId, 120),
    },
  });
  const captionText = clean(caption, 280);
  const lyricText = clean(lyric, 600);
  if (!captionText && !lyricText) return [card];
  const shareText = [
    `（分享了《${title}》${artist ? ` - ${artist}` : ''}）`,
    captionText,
    lyricText ? `其中这几句：\n${lyricText}` : '',
  ].filter(Boolean).join('\n');
  return [card, createMessage({
    chatId: targetChatId,
    senderId: 'user',
    senderName,
    type: 'text',
    content: shareText,
    timestamp: at + 1,
  })];
}

export async function saveMusicShareToChat(options = {}) {
  const messages = buildMusicShareMessages(options);
  if (!messages[0]?.chatId) throw new Error('缺少目标聊天');
  await saveMessages(messages);
  const latest = messages[messages.length - 1];
  await updateChatPreview(latest.chatId, previewFromMessage(latest), latest.timestamp);
  return messages;
}
