import { openImageLightbox } from './image-lightbox.js';
import { showToast } from './toast.js';
import { buildVoiceBubbleInnerHtml, chatBundleItemLabel, textImageBubbleHtml } from '../core/chat/card-render.js';
import { playVoiceMessage } from '../core/chat/voice-bubble.js';
import { captureMediaGesture } from '../core/media-playback.js';
import { sanitizeAiTranslation } from '../core/translation-utils.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function actorName(item = {}, options = {}) {
  const id = String(item.senderId || '').trim();
  if (id === 'user' || id === String(options.currentUserId || 'user')) {
    return String(options.currentUserName || item.senderName || '我').trim() || '我';
  }
  const resolved = typeof options.resolveDisplayName === 'function'
    ? String(options.resolveDisplayName(id, item) || '').trim()
    : '';
  return resolved || String(item.senderName || '').trim() || 'TA';
}

function itemImageSrc(item = {}) {
  if (!['image', 'sticker'].includes(String(item.type || ''))) return '';
  const candidates = [
    item.metadata?.url,
    item.metadata?.imageUrl,
    item.metadata?.src,
    item.content,
  ];
  return candidates
    .map((value) => String(value || '').trim())
    .find((value) => /^(?:https?:|data:image\/|blob:|\/|\.{1,2}\/)/i.test(value)) || '';
}

function itemSourceText(item = {}) {
  const type = String(item.type || 'text');
  if (type === 'voice') {
    return String(item.metadata?.text || item.metadata?.transcript || item.content || '').trim();
  }
  if (type === 'image') {
    // 收藏/转发记录只展示用户可见的图片说明；生图 prompt 属于内部参数。
    return item.metadata?.userDrawnImage === true
      ? ''
      : String(item.metadata?.caption || '').trim();
  }
  return String(item.content || '').trim();
}

function translationHtml(item = {}, source = '') {
  const raw = String(item.metadata?.translation || item.translation || '').trim();
  const translated = sanitizeAiTranslation(source, raw);
  if (!translated) return '';
  return `<div class="chat-record-translation"><span>译</span>${esc(translated)}</div>`;
}

function timeLabel(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const CHAT_RECORD_VOICE_SNAPSHOT_FIELDS = [
  'audioCacheKey',
  'audioVoiceId',
  'audioModel',
  'audioFormat',
  'audioGeneratedAt',
];

export function chatRecordVoiceSnapshotSignature(item = {}) {
  const metadata = item?.metadata && typeof item.metadata === 'object'
    ? item.metadata
    : {};
  return JSON.stringify(CHAT_RECORD_VOICE_SNAPSHOT_FIELDS.map((key) => metadata[key] ?? null));
}

function itemBodyHtml(item = {}, index = 0) {
  const type = String(item.type || 'text');
  const source = itemSourceText(item);
  if (type === 'image' || type === 'sticker') {
    const src = itemImageSrc(item);
    const image = src
      ? `<button type="button" class="chat-record-image-btn" data-chat-record-image="${index}" aria-label="查看图片"><img class="chat-record-image" src="${esc(src)}" alt="" loading="lazy"></button>`
      : `<div class="chat-record-text">${esc(type === 'sticker' ? '[表情]' : '[图片]')}</div>`;
    return `${image}${source ? `<div class="chat-record-caption">${esc(source)}</div>` : ''}${translationHtml(item, source)}`;
  }
  if (type === 'textimg') {
    return `<button type="button" class="chat-record-card-btn" data-chat-record-card="${index}" aria-label="查看文字图">${textImageBubbleHtml(item, esc, { insCard: true })}</button>${translationHtml(item, source)}`;
  }
  if (type === 'htmlWidget') {
    const snapshot = item.metadata?.htmlExtension;
    const title = String(snapshot?.title || item.content || 'HTML 小卡片').trim() || 'HTML 小卡片';
    const content = String(snapshot?.content || '').trim();
    return `<button type="button" class="chat-record-card-btn chat-record-html-card" data-chat-record-card="${index}" aria-label="查看 HTML 小卡片"><strong>${esc(title)}</strong>${content ? `<span>${esc(content)}</span>` : ''}<small>点击查看原内容</small></button>`;
  }
  if (type === 'voice') {
    const voice = {
      ...item,
      metadata: { ...(item.metadata || {}), voiceExpanded: true },
    };
    return buildVoiceBubbleInnerHtml(voice, esc, { insCard: true });
  }
  const label = chatBundleItemLabel(item) || `[${type}]`;
  return `<div class="chat-record-text">${esc(label)}</div>${translationHtml(item, source || label)}`;
}

export function chatRecordItemsHtml(items = [], options = {}) {
  const rows = Array.isArray(items)
    ? items.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  const limit = Math.max(1, Number(options.limit || 40));
  return rows.slice(0, limit).map((item, index) => {
    const self = String(item.senderId || '') === 'user'
      || String(item.senderId || '') === String(options.currentUserId || 'user');
    const name = actorName(item, options);
    const time = timeLabel(item.timestamp);
    const avatar = String(item.avatar || item.metadata?.avatar || '').trim();
    return `
      <div class="chat-record-row ${self ? 'is-self' : 'is-other'}" data-record-index="${index}">
        <div class="chat-record-avatar" aria-hidden="true">${avatar
    ? `<img src="${esc(avatar)}" alt="">`
    : esc([...name][0] || '·')}</div>
        <div class="chat-record-stack">
          <div class="chat-record-meta"><span>${esc(name)}</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
          <div class="chat-record-bubble">${itemBodyHtml(item, index)}</div>
        </div>
      </div>`;
  }).join('');
}

export function bindChatRecordInteractions(root, items = [], options = {}) {
  if (!root) return;
  const rows = Array.isArray(items)
    ? items.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  root.querySelectorAll('[data-chat-record-image]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = rows[Number(button.getAttribute('data-chat-record-image'))];
      const src = itemImageSrc(item);
      if (src) openImageLightbox(src);
    });
  });
  root.querySelectorAll('[data-chat-record-card]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = rows[Number(button.getAttribute('data-chat-record-card'))];
      if (item) options.onOpenCard?.(item);
    });
  });
  root.querySelectorAll('.chat-record-row .voice-msg-play').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = button.closest('[data-record-index]');
      const index = Number(row?.getAttribute('data-record-index'));
      const item = rows[index];
      if (!item) return;
      const snapshotBeforePlayback = chatRecordVoiceSnapshotSignature(item);
      try {
        await playVoiceMessage(item, {
          button,
          persist: false,
          gestureToken: captureMediaGesture(event),
        });
        // 已缓存语音的播放/暂停不会改变记录数据，不应反复写回父消息。
        // 首次生成缓存时才保存快照，避免每点一次都触发聊天列表重绘与滚动跳位。
        if (chatRecordVoiceSnapshotSignature(item) !== snapshotBeforePlayback) {
          await options.onVoiceSnapshotUpdate?.(item, index);
        }
      } catch (error) {
        console.warn('[chat-record-voice]', error);
        showToast(error?.message || '语音播放失败');
      }
    });
  });
}
