import {
  formatBubbleDisplayContent,
  formatReplyRefDisplayLine,
} from '../core/chat-helpers.js';
import {
  buildStickerPoolResolverFromMessageSenders,
  resolveStickerBubbleImageUrl,
} from '../core/chat/sticker-resolve.js';
import { saveBlobNatively } from '../core/native-file-export.js';
import {
  normalizeAvatarImageSrc,
  resolveAvatarUrl,
  resolveDefaultEmoji,
} from '../core/resolve-avatar-url.js';
import { resolveActorDisplayLabel } from '../core/chat/character-code-fallback.js';
import { sanitizeAiTranslation } from '../core/translation-utils.js';

const EXPORT_WIDTH = 390;
// 内容（1x）高度上限：超过则提示分几次导出
const MAX_EXPORT_CSS_HEIGHT = 24000;
const MAX_EXPORT_MESSAGE_COUNT = 80;
// 单张 canvas 的安全像素面积上限。iOS Safari 对超大 canvas 有内存/面积硬限制，
// 超出会直接整页闪退或生成空白图；这里取保守值，宁可清晰度略降也不崩。
const MAX_CANVAS_AREA_DEFAULT = 24_000_000;
const MAX_CANVAS_AREA_IOS = 11_000_000;
const MAX_SHARE_FILE_BYTES_IOS = 8 * 1024 * 1024;

function isIOSDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iP(hone|od|ad)/.test(ua)) return true;
  // iPadOS 13+ 默认伪装成 Mac，靠触摸点数判断
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
}

function forceCleanupAfterExport() {
  try {
    requestAnimationFrame(() => {
      try {
        window.scrollTo({ top: 0, behavior: 'auto' });
      } catch (_) {}
    });
  } catch (_) {}
}

const UI = {
  headerH: 56,
  headerBottomGap: 14,
  sidePad: 10,
  avatar: 40,
  avatarRadius: 5,
  avatarGap: 8,
  rowGap: 14,
  groupNameH: 18,
  bubbleRadius: 5,
  bubblePadX: 10,
  bubblePadY: 8,
  bubbleMaxRatio: 0.74,
  textFont: 15,
  textLineH: 22,
  replyFont: 12,
  replyLineH: 17,
  replyPadX: 8,
  replyPadY: 5,
  timeFont: 13,
  timeH: 25,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatTime(ts) {
  const n = Number(ts || 0);
  if (!n) return '';
  try {
    const d = new Date(n);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const date = sameYear
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${date} ${hh}:${mm}`;
  } catch (_) {
    return '';
  }
}

function safeText(value = '') {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function messageText(msg = {}) {
  const type = String(msg.type || 'text');
  const md = msg.metadata || {};
  const content = safeText(formatBubbleDisplayContent(msg) || md.text || msg.content || '');
  let display = '';
  if (type === 'text') display = content || ' ';
  else if (type === 'voice') display = `[语音] ${safeText(md.text || md.transcript || content || '语音消息')}`;
  else if (type === 'image') display = safeText(md.caption || md.prompt || content || '[图片]');
  else if (type === 'sticker') display = safeText(md.inlineText || '');
  else if (type === 'location') display = `[位置] ${safeText(md.name || md.title || content || '位置分享')}${md.address ? `\n${md.address}` : ''}`;
  else if (type === 'link') display = `[链接] ${safeText(md.title || content || md.url || '链接分享')}${md.url ? `\n${md.url}` : ''}`;
  else if (type === 'music') display = `[音乐] ${safeText(md.title || content || '音乐分享')}`;
  else if (type === 'redpacket' || type === 'redPacket') display = `[红包] ${safeText(md.title || md.greeting || content || '红包')}`;
  else if (type === 'transfer') display = `[转账] ${safeText(md.amount || content || '转账')}`;
  else if (type === 'dice') display = `[骰子] ${content}`;
  else if (type === 'vote') display = `[群投票] ${safeText(md.voteTitle || md.title || content || '投票')}`;
  else if (type === 'chatBundle') display = `[合并转发] ${safeText(md.bundleTitle || content || '聊天记录')}`;
  else if (type === 'textimg') display = `[文字图]\n${content}`;
  else if (content) display = `[${type}] ${content}`;
  else display = `[${type}]`;
  const translation = sanitizeAiTranslation(content || display, md.translation || msg.translation || '');
  return translation ? `${display}\n译：${translation}` : display;
}

function wrapText(ctx, text, maxWidth) {
  const rawLines = safeText(text).split('\n');
  const out = [];
  for (const raw of rawLines) {
    const chars = [...(raw || ' ')];
    let line = '';
    for (const ch of chars) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        out.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    out.push(line || ' ');
  }
  return out;
}

function truncateText(ctx, text, maxWidth) {
  const raw = safeText(text);
  if (!raw || ctx.measureText(raw).width <= maxWidth) return raw;
  let out = raw;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function colorFromCss(value, fallback) {
  const raw = String(value || '').trim();
  const hex = raw.match(/#[0-9a-f]{3,8}\b/i)?.[0];
  if (hex) return hex;
  const rgb = raw.match(/rgba?\([^)]*\)/i)?.[0];
  return rgb || fallback;
}

function drawImageCover(ctx, img, x, y, w, h) {
  if (!img) return;
  const iw = Math.max(1, Number(img.naturalWidth || img.width || 1));
  const ih = Math.max(1, Number(img.naturalHeight || img.height || 1));
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

function drawTextLines(ctx, lines, x, y, lineHeight, maxWidth = Infinity) {
  let yy = y;
  for (const line of lines) {
    ctx.fillText(maxWidth === Infinity ? line : truncateText(ctx, line, maxWidth), x, yy);
    yy += lineHeight;
  }
  return yy;
}

function drawBubbleTail(ctx, x, y, isSelf, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (isSelf) {
    ctx.moveTo(x, y + 13);
    ctx.lineTo(x + 6, y + 18);
    ctx.lineTo(x, y + 23);
  } else {
    ctx.moveTo(x, y + 13);
    ctx.lineTo(x - 6, y + 18);
    ctx.lineTo(x, y + 23);
  }
  ctx.closePath();
  ctx.fill();
}

function drawRoundedImage(ctx, img, x, y, w, h, r = 8) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

function drawImageContain(ctx, img, x, y, boxW, boxH, radius = 0) {
  const iw = Math.max(1, Number(img?.naturalWidth || img?.width || 1));
  const ih = Math.max(1, Number(img?.naturalHeight || img?.height || 1));
  const scale = Math.min(boxW / iw, boxH / ih);
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const dx = x + (boxW - w) / 2;
  const dy = y + (boxH - h) / 2;
  if (radius) drawRoundedImage(ctx, img, dx, dy, w, h, radius);
  else ctx.drawImage(img, dx, dy, w, h);
}

async function loadImageCached(src, cache) {
  let raw = safeText(src);
  if (!raw) return null;
  if (raw.startsWith('//')) raw = `https:${raw}`;
  else if (/^http:\/\//i.test(raw)) raw = `https://${raw.slice(7)}`;
  if (cache.has(raw)) return cache.get(raw);
  const promise = new Promise((resolve) => {
    const img = new Image();
    if (/^https?:/i.test(raw)) img.crossOrigin = 'anonymous';
    img.onload = async () => {
      try {
        await img.decode?.();
      } catch (_) {}
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = raw;
  });
  cache.set(raw, promise);
  return promise;
}

export async function resolveLongImageMessageAvatar(msg = {}, isSelf = false, options = {}) {
  if (isSelf) return safeText(options.currentUserAvatar || '');
  const current = typeof options.resolveSenderAvatar === 'function'
    ? await options.resolveSenderAvatar(msg)
    : '';
  // 长图应与当前聊天页显示一致：角色换头像后优先用最新资料，
  // 只有无法解析当前角色时才回退到消息落库时的历史快照。
  return safeText(current || msg.avatar || msg.metadata?.avatar || '');
}

async function resolveAvatarVisual(msg, name, isSelf, options, caches) {
  const explicit = await resolveLongImageMessageAvatar(msg, isSelf, options);
  const id = isSelf ? safeText(options.currentUserId || 'user') : safeText(msg.senderId || '');
  let url = '';
  try {
    url = await resolveAvatarUrl(id, name, explicit);
    url = url ? await normalizeAvatarImageSrc(url) : '';
  } catch (_) {
    url = explicit;
  }
  const image = await loadImageCached(url, caches.images);
  const emoji = image ? '' : await resolveDefaultEmoji(id, name).catch(() => '');
  return { image, emoji, label: [...safeText(name || '?')].slice(0, 1).join('') || '?' };
}

function drawAvatar(ctx, x, y, name, isSelf, visual = {}) {
  const size = UI.avatar;
  ctx.fillStyle = isSelf ? '#8db8e8' : '#d8dee8';
  roundRect(ctx, x, y, size, size, UI.avatarRadius);
  ctx.fill();
  if (visual.image) {
    drawRoundedImage(ctx, visual.image, x, y, size, size, UI.avatarRadius);
    return;
  }
  const label = safeText(visual.emoji || visual.label || name || '?').slice(0, 2) || '?';
  ctx.fillStyle = isSelf ? '#ffffff' : '#536274';
  ctx.font = '700 18px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + size / 2, y + size / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawTimeDivider(ctx, text, y) {
  if (!text) return 0;
  ctx.font = `${UI.timeFont}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  const w = ctx.measureText(text).width + 18;
  const h = UI.timeH;
  const x = (EXPORT_WIDTH - w) / 2;
  ctx.fillStyle = '#d2d8e0';
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, EXPORT_WIDTH / 2, y + h / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  return h + 10;
}

function getMediaSrc(msg, stickerPool) {
  if (msg.type === 'sticker') {
    return resolveStickerBubbleImageUrl(msg, stickerPool) || safeText(msg.metadata?.url || '');
  }
  if (msg.type === 'image') return safeText(msg.content || msg.metadata?.url || msg.metadata?.imageUrl || '');
  return '';
}

function mediaBoxFor(img, type) {
  const iw = Math.max(1, Number(img?.naturalWidth || img?.width || 1));
  const ih = Math.max(1, Number(img?.naturalHeight || img?.height || 1));
  const maxW = type === 'image' ? 220 : 132;
  const maxH = type === 'image' ? 190 : 168;
  const scale = Math.min(maxW / iw, maxH / ih, 1);
  return {
    width: Math.max(44, Math.round(iw * scale)),
    height: Math.max(44, Math.round(ih * scale)),
  };
}

async function prepareMessage(msg, index, ctx, options, caches) {
  const cacheKey = msg.id || `${index}:${msg.senderId || ''}:${msg.timestamp || ''}:${msg.content || ''}`;
  if (caches.prepared.has(cacheKey)) return caches.prepared.get(cacheKey);

  const isSelf = msg.senderId === 'user' || msg.senderId === 'me';
  const senderName = typeof options.resolveSenderName === 'function'
    ? options.resolveSenderName
    : async (m) => safeText(resolveActorDisplayLabel(m.senderName || m.senderId, { fallback: '某人' }));
  const name = isSelf ? safeText(options.currentUserName || '我') : await senderName(msg);
  const avatar = await resolveAvatarVisual(msg, name, isSelf, options, caches);
  const stickerPool = typeof options.stickerPoolForMessage === 'function'
    ? options.stickerPoolForMessage(msg)
    : null;
  const mediaSrc = getMediaSrc(msg, stickerPool);
  const mediaImage = await loadImageCached(mediaSrc, caches.images);
  const media = mediaImage ? { image: mediaImage, ...mediaBoxFor(mediaImage, msg.type) } : null;
  const text = messageText(msg);
  const reply = safeText(msg.replyPreview || msg.metadata?.replyPreview || '')
    ? formatReplyRefDisplayLine(
      msg,
      options.currentUserName || '我',
      { resolveReplySenderLabel: options.resolveReplySenderLabel },
    ) || safeText(msg.replyPreview || msg.metadata?.replyPreview || '')
    : '';

  const prepared = { msg, isSelf, name, avatar, media, text, reply };
  caches.prepared.set(cacheKey, prepared);
  return prepared;
}

function drawHeader(ctx, options = {}, wallpaperImage = null) {
  const title = safeText(options.title || '聊天记录');
  const status = safeText(options.statusText || options.subtitle || '');
  const cssHeight = ctx.canvas.height / Math.max(0.01, Number(ctx.getTransform?.().a || 1));
  const appearance = options.appearance && typeof options.appearance === 'object' ? options.appearance : {};
  ctx.fillStyle = '#ededed';
  ctx.fillRect(0, 0, EXPORT_WIDTH, cssHeight);
  if (wallpaperImage) {
    drawImageCover(ctx, wallpaperImage, 0, 0, EXPORT_WIDTH, cssHeight);
    const visible = clamp(Number(appearance.wallpaperOpacity ?? 100), 0, 100) / 100;
    ctx.fillStyle = `rgba(237,237,237,${Math.max(0.08, 1 - visible)})`;
    ctx.fillRect(0, 0, EXPORT_WIDTH, cssHeight);
  }
  ctx.fillStyle = wallpaperImage ? 'rgba(247,247,247,0.82)' : '#f7f7f7';
  ctx.fillRect(0, 0, EXPORT_WIDTH, UI.headerH);
  ctx.fillStyle = '#111111';
  ctx.font = '700 17px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, EXPORT_WIDTH / 2, status ? 24 : 34);
  if (status) {
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillStyle = '#8a8a8a';
    ctx.fillText(status, EXPORT_WIDTH / 2, 42);
  }
  ctx.textAlign = 'left';
}

function measureBubble(ctx, prepared, maxBubbleW) {
  const padX = UI.bubblePadX;
  const lineHeight = UI.textLineH;
  const replyLineHeight = UI.replyLineH;
  const textMax = maxBubbleW - padX * 2;
  ctx.font = `${UI.textFont}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  const lines = prepared.text ? wrapText(ctx, prepared.text, textMax) : [];
  let replyLines = [];
  if (prepared.reply) {
    ctx.font = `${UI.replyFont}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    replyLines = wrapText(ctx, prepared.reply, textMax - UI.replyPadX * 2).slice(0, 2);
    ctx.font = `${UI.textFont}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  }
  const textW = Math.max(
    ...lines.map((line) => ctx.measureText(line).width),
    60,
  );
  ctx.font = `${UI.replyFont}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  const replyW = Math.max(0, ...replyLines.map((line) => ctx.measureText(line).width + UI.replyPadX * 2));
  ctx.font = `${UI.textFont}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  const bubbleW = clamp(Math.ceil(Math.max(textW, replyW) + padX * 2), 96, maxBubbleW);
  const replyH = replyLines.length ? replyLines.length * replyLineHeight + UI.replyPadY * 2 + 4 : 0;
  const textH = lines.length ? lines.length * lineHeight : 0;
  const bubbleH = Math.max(36, replyH + textH + UI.bubblePadY * 2);
  return { lines, replyLines, bubbleW, bubbleH, replyH, padX, lineHeight, replyLineHeight };
}

function drawTextBubble(ctx, prepared, x, y, layout, options = {}) {
  const appearance = options.appearance && typeof options.appearance === 'object' ? options.appearance : {};
  const fill = prepared.isSelf
    ? colorFromCss(appearance.bubbleSelf, '#95ec69')
    : colorFromCss(appearance.bubbleOther, '#ffffff');
  drawBubbleTail(ctx, prepared.isSelf ? x + layout.bubbleW : x, y, prepared.isSelf, fill);
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, layout.bubbleW, layout.bubbleH, UI.bubbleRadius);
  ctx.fill();

  let textY = y + UI.bubblePadY + UI.textFont;
  if (layout.replyLines.length) {
    const rx = x + UI.bubblePadX;
    const ry = y + UI.bubblePadY;
    const rw = layout.bubbleW - UI.bubblePadX * 2;
    const rh = layout.replyH - 4;
    ctx.fillStyle = prepared.isSelf ? 'rgba(0,0,0,0.10)' : 'rgba(0,0,0,0.05)';
    roundRect(ctx, rx, ry, rw, rh, 4);
    ctx.fill();
    ctx.fillStyle = '#666666';
    ctx.font = `${UI.replyFont}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    drawTextLines(ctx, layout.replyLines, rx + UI.replyPadX, ry + UI.replyPadY + UI.replyFont, layout.replyLineHeight, rw - UI.replyPadX * 2);
    textY += layout.replyH;
  }

  ctx.fillStyle = prepared.isSelf
    ? colorFromCss(appearance.bubbleTextSelf, '#111111')
    : colorFromCss(appearance.bubbleTextOther, '#111111');
  ctx.font = `${UI.textFont}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  drawTextLines(ctx, layout.lines, x + layout.padX, textY, layout.lineHeight, layout.bubbleW - layout.padX * 2);
}

async function layoutAndRender(ctx, items, options = {}, render = false) {
  const isGroup = options.isGroup === true;
  const caches = options._longImageCaches;
  let y = 0;
  if (render) {
    const wallpaper = safeText(options.appearance?.wallpaper || options.wallpaper || '');
    const wallpaperImage = wallpaper ? await loadImageCached(wallpaper, caches.images) : null;
    drawHeader(ctx, options, wallpaperImage);
  }
  y += UI.headerH + UI.headerBottomGap;

  let lastTs = 0;
  for (let i = 0; i < items.length; i += 1) {
    const msg = items[i];
    const prepared = await prepareMessage(msg, i, ctx, options, caches);
    const ts = Number(msg.timestamp || 0);
    const needTime = ts && (!lastTs || ts - lastTs >= 10 * 60 * 1000 || new Date(ts).toDateString() !== new Date(lastTs).toDateString());
    if (needTime) y += render ? drawTimeDivider(ctx, formatTime(ts), y) : UI.timeH + 10;

    const avatarSize = UI.avatar;
    const avatarX = prepared.isSelf ? EXPORT_WIDTH - UI.sidePad - avatarSize : UI.sidePad;
    const nameH = isGroup && !prepared.isSelf ? UI.groupNameH : 0;
    const rowTop = y;
    const contentTop = rowTop + nameH;
    const maxBubbleW = Math.floor(EXPORT_WIDTH * UI.bubbleMaxRatio);
    const bubbleXForW = (w) => prepared.isSelf ? avatarX - UI.avatarGap - w : avatarX + avatarSize + UI.avatarGap;

    if (render) {
      drawAvatar(ctx, avatarX, contentTop, prepared.name, prepared.isSelf, prepared.avatar);
      if (nameH) {
        ctx.fillStyle = '#7a7a7a';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        ctx.fillText(prepared.name, avatarX + avatarSize + UI.avatarGap + 2, rowTop + 12);
      }
    }

    let rowH = nameH;
    if (prepared.media && !prepared.text && !prepared.reply) {
      const mx = prepared.isSelf ? avatarX - UI.avatarGap - prepared.media.width : avatarX + avatarSize + UI.avatarGap;
      if (render) {
        drawImageContain(
          ctx,
          prepared.media.image,
          mx,
          contentTop,
          prepared.media.width,
          prepared.media.height,
          msg.type === 'image' ? 8 : 0,
        );
      }
      rowH += Math.max(avatarSize, prepared.media.height);
    } else {
      let mediaH = 0;
      if (prepared.media) {
        const mw = prepared.media.width;
        const mx = prepared.isSelf ? avatarX - UI.avatarGap - mw : avatarX + avatarSize + UI.avatarGap;
        if (render) {
          drawImageContain(ctx, prepared.media.image, mx, contentTop, mw, prepared.media.height, msg.type === 'image' ? 8 : 0);
        }
        mediaH = prepared.media.height + 8;
      }
      const layout = measureBubble(ctx, prepared, maxBubbleW);
      const bx = bubbleXForW(layout.bubbleW);
      if (render) drawTextBubble(ctx, prepared, bx, contentTop + mediaH, layout, options);
      rowH += mediaH + Math.max(avatarSize, layout.bubbleH);
    }

    y += rowH + UI.rowGap;
    if (ts) lastTs = ts;
  }

  y += 14;
  return Math.ceil(y);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('长图生成失败'));
      }, 'image/png');
    } catch (err) {
      reject(err instanceof Error ? err : new Error('长图生成失败'));
    }
  });
}

function releaseCanvas(canvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch (_) {}
}

// 逐次降级渲染：iOS 上即便算好了面积，仍可能因瞬时内存峰值失败，
// 失败就把缩放调小再试，优先保证「不崩、能出图」。
async function renderLongImageBlob(items, renderOptions, cssHeight, startScale) {
  let scale = startScale;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(EXPORT_WIDTH * scale));
    canvas.height = Math.max(1, Math.ceil(cssHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      releaseCanvas(canvas);
      throw new Error('当前设备不支持生成长图');
    }
    try {
      ctx.scale(scale, scale);
      await layoutAndRender(ctx, items, renderOptions, true);
      const blob = await canvasToBlob(canvas);
      const out = { blob, width: canvas.width, height: canvas.height };
      releaseCanvas(canvas);
      return out;
    } catch (err) {
      lastErr = err;
      releaseCanvas(canvas);
      if (scale <= 0.6) break;
      scale = Math.max(0.6, scale * 0.7);
    }
  }
  throw lastErr || new Error('长图生成失败');
}

async function shareOrDownloadBlob(blob, filename) {
  const ios = isIOSDevice();
  try {
    const nativeSaved = await saveBlobNatively(blob, {
      filename,
      mimeType: 'image/png',
      directory: 'pictures',
    });
    if (nativeSaved?.ok) {
      return {
        method: 'native',
        filename: nativeSaved.filename || filename,
        relativePath: nativeSaved.relativePath || 'Pictures/MarshmallowPhone',
        uri: nativeSaved.uri || '',
      };
    }
  } catch (err) {
    console.warn('[chat-long-image] native save failed, fallback to share/download', err);
  }
  const canUseShare = !ios || blob.size <= MAX_SHARE_FILE_BYTES_IOS;
  if (canUseShare) {
    const file = new File([blob], filename, { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        await navigator.share({ files: [file], title: filename });
        forceCleanupAfterExport();
        return { method: 'shared', filename };
      }
    } catch (err) {
      console.warn('[chat-long-image] native share failed, fallback to download', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  forceCleanupAfterExport();
  return { method: 'downloaded', filename };
}

export async function exportChatMessagesAsLongImage(options = {}) {
  const items = Array.isArray(options.messages) ? options.messages.filter(Boolean) : [];
  if (!items.length) throw new Error('请先选择聊天记录');
  if (items.length > MAX_EXPORT_MESSAGE_COUNT) {
    throw new Error(`一次最多选择 ${MAX_EXPORT_MESSAGE_COUNT} 条聊天记录，请分几次生成长图`);
  }

  const stickerResolver = await buildStickerPoolResolverFromMessageSenders(items.map((m) => m.senderId)).catch(() => null);
  const caches = {
    images: new Map(),
    prepared: new Map(),
  };
  const renderOptions = {
    ...options,
    stickerPoolForMessage: stickerResolver?.poolForMessage || (() => stickerResolver?.full || null),
    _longImageCaches: caches,
  };

  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = EXPORT_WIDTH;
  measureCanvas.height = 10;
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) throw new Error('当前设备不支持生成长图');
  const cssHeight = await layoutAndRender(measureCtx, items, renderOptions, false);
  releaseCanvas(measureCanvas);
  if (cssHeight > MAX_EXPORT_CSS_HEIGHT) {
    throw new Error('选择的记录太多，请分几次生成长图');
  }

  // 按设备安全面积上限反推缩放：iOS 走更保守的面积，避免整页闪退
  const ios = isIOSDevice();
  const maxArea = ios ? MAX_CANVAS_AREA_IOS : MAX_CANVAS_AREA_DEFAULT;
  const desiredScale = clamp((globalThis.devicePixelRatio || 1) * 1.5, 1.5, ios ? 2.5 : 3);
  const areaScale = Math.sqrt(maxArea / Math.max(1, EXPORT_WIDTH * cssHeight));
  const scale = clamp(Math.min(desiredScale, areaScale), 0.6, desiredScale);

  const { blob, width, height } = await renderLongImageBlob(items, renderOptions, cssHeight, scale);
  const filenameBase = safeText(options.filenameBase || options.title || 'chat-long-image')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 48) || 'chat-long-image';
  const filename = `${filenameBase}-${new Date().toISOString().slice(0, 10)}.png`;
  const saved = await shareOrDownloadBlob(blob, filename);
  return {
    ...saved,
    filename: saved.filename || filename,
    width,
    height,
  };
}
