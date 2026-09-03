import * as db from './db.js';

const INLINE_MEDIA_PREFIX = /^data:(?:image|audio|video)\//i;
const DEFAULT_INLINE_MEDIA_LIMIT = 8192;

function mediaPlaceholder(type = '') {
  if (type === 'image' || type === 'sticker') return '[图片]';
  if (type === 'voice' || type === 'audio') return '[语音]';
  if (type === 'video') return '[视频]';
  return '[本地媒体]';
}

function compactInlineMediaValue(value, placeholder, depth = 0) {
  if (typeof value === 'string') {
    return value.length >= DEFAULT_INLINE_MEDIA_LIMIT && INLINE_MEDIA_PREFIX.test(value)
      ? placeholder
      : value;
  }
  if (!value || typeof value !== 'object' || depth >= 3) return value;
  if (Array.isArray(value)) {
    return value.map((item) => compactInlineMediaValue(item, placeholder, depth + 1));
  }
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = compactInlineMediaValue(item, placeholder, depth + 1);
  }
  return next;
}

/**
 * 上下文只需要文本摘要，不能为取最近几十条消息先把整个会话（含 base64 媒体）
 * 克隆进 WebView 内存。游标阶段就裁掉内嵌媒体，避免旧会话在发送/推进时 OOM。
 */
export function compactMessageForContext(message = {}) {
  const placeholder = mediaPlaceholder(message?.type);
  const next = compactInlineMediaValue(message, placeholder);
  if (typeof next?.content === 'string'
    && next.content.length >= DEFAULT_INLINE_MEDIA_LIMIT
    && INLINE_MEDIA_PREFIX.test(next.content)) {
    next.content = placeholder;
  }
  return next;
}

export async function listRecentMessagesForContext(chatId, limit = 100, options = {}) {
  const id = String(chatId || '').trim();
  if (!id) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  const overscan = Math.max(1, Math.min(5, Number(options.overscan) || 3));
  const fetchLimit = Math.min(1000, Math.max(cap + 20, cap * overscan));
  const rows = await db.getAllByIndexRange(
    'messages',
    'chatId_timestamp',
    [id, 0],
    [id, Number.MAX_SAFE_INTEGER],
    {
      direction: 'prev',
      limit: fetchLimit,
      mapRecord: compactMessageForContext,
    },
  );
  return (Array.isArray(rows) ? rows : [])
    .sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
}
