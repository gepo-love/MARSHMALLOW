import { hydrateDeferredMediaMessage, saveMessage } from '../chat-store.js';
import { displaySocialImageUrl, needsSocialImageProxy, resolveLinkMessagePreview } from '../link-card-enhancer.js';
import { hasNativeHttp, nativeHttpGetBytes } from '../native-http.js';

export const CHAT_IMAGE_FOLD_MESSAGE_WINDOW = 50;
/** 用户图片在上下文中附带真实像素的 AI 回复轮数上限（不含当前待生成轮） */
export const VISION_CONTEXT_KEEP_ALIVE_TURNS = 5;
const VISION_CONTEXT_MAX_IMAGES = 5;
const VISION_CONTEXT_TARGET_BYTES = 768 * 1024;
const VISION_CONTEXT_MAX_EDGE = 1280;
const VISION_CONTEXT_QUALITY_STEPS = [0.86, 0.8, 0.74, 0.68];
const VISION_CONTEXT_DETAIL = 'high';
const DIRECT_USER_IMAGE_PASSTHROUGH_BYTES = 1024 * 1024;

function dataUrlApproxBytes(dataUrl = '') {
  const raw = String(dataUrl || '');
  const base64 = raw.includes(',') ? raw.split(',').pop() : raw;
  return Math.max(0, Math.floor(base64.length * 0.75));
}

function loadImageForVision(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function canvasToVisionDataUrl(canvas, quality) {
  try {
    return canvas.toDataURL('image/jpeg', quality);
  } catch (_) {
    return '';
  }
}

function responseHeader(headers = {}, name = '') {
  const target = String(name || '').toLowerCase();
  return Object.entries(headers || {}).find(([key]) => String(key).toLowerCase() === target)?.[1] || '';
}

export function isGifStickerImage(msg = {}, url = '') {
  const raw = String(url || msg?.metadata?.url || msg?.content || '').trim();
  if (/^data:image\/gif(?:;|,)/i.test(raw)) return true;
  if (/\.gif(?:$|[?#])/i.test(raw)) return true;
  const metadata = msg?.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
  return [metadata.mimeType, metadata.mime, metadata.contentType]
    .some((value) => /^image\/gif(?:\s*;|$)/i.test(String(value || '').trim()))
    || [metadata.fileName, metadata.filename, metadata.name]
      .some((value) => /\.gif$/i.test(String(value || '').trim()));
}

async function gifVisionBlob(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) && hasNativeHttp()) {
    try {
      const result = await nativeHttpGetBytes(raw, {
        headers: { Accept: 'image/gif,image/*,*/*;q=0.8' },
        connectTimeout: 30_000,
        readTimeout: 60_000,
      });
      if (result.bytes?.length) {
        const mime = String(responseHeader(result.headers, 'content-type') || 'image/gif').split(';')[0];
        return new Blob([result.bytes], { type: mime || 'image/gif' });
      }
    } catch (_) {
      // 原生下载失败时继续尝试 Web fetch；最终失败会安全降级成表情名称。
    }
  }
  try {
    const response = await fetch(raw, {
      mode: /^https?:\/\//i.test(raw) ? 'cors' : undefined,
      credentials: /^https?:\/\//i.test(raw) ? 'omit' : 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return await response.blob();
  } catch (_) {
    return null;
  }
}

function drawGifFrameToPng(drawable, originalWidth, originalHeight) {
  if (typeof document === 'undefined') return '';
  const width = Number(originalWidth) || 0;
  const height = Number(originalHeight) || 0;
  if (!width || !height) return '';
  const scale = Math.min(1, VISION_CONTEXT_MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return '';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(drawable, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL('image/png');
  } catch (_) {
    return '';
  }
}

/** 只为模型请求生成 GIF 静态首帧；不会改写聊天消息或表情包原文件。 */
export async function extractGifFirstFrameForVision(url = '') {
  if (typeof document === 'undefined') return '';
  const blob = await gifVisionBlob(url);
  if (!blob) return '';
  if (typeof ImageDecoder === 'function') {
    let decoder = null;
    try {
      decoder = new ImageDecoder({
        data: await blob.arrayBuffer(),
        type: 'image/gif',
      });
      const result = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
      const frame = result?.image;
      const png = frame
        ? drawGifFrameToPng(frame, frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight)
        : '';
      frame?.close?.();
      if (png) return png;
    } catch (_) {
      // 不支持 WebCodecs GIF 解码时继续走通用图片解码。
    } finally {
      decoder?.close?.();
    }
  }
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const png = drawGifFrameToPng(bitmap, bitmap.width, bitmap.height);
      bitmap.close?.();
      if (png) return png;
    } catch (_) {
      // 旧 WebView 不支持 GIF createImageBitmap 时改走 HTMLImageElement。
    }
  }
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return '';
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImageForVision(objectUrl);
    return drawGifFrameToPng(
      image,
      Number(image.naturalWidth || image.width || 0),
      Number(image.naturalHeight || image.height || 0),
    );
  } catch (_) {
    return '';
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function compressVisionDataUrl(url = '') {
  const raw = String(url || '').trim();
  if (!/^data:image\//i.test(raw)) return raw;
  if (dataUrlApproxBytes(raw) <= VISION_CONTEXT_TARGET_BYTES) return raw;
  if (typeof document === 'undefined' || typeof Image === 'undefined') return raw;
  try {
    const img = await loadImageForVision(raw);
    const originalWidth = Number(img.naturalWidth || img.width || 0);
    const originalHeight = Number(img.naturalHeight || img.height || 0);
    if (!originalWidth || !originalHeight) return raw;
    const scale = Math.min(1, VISION_CONTEXT_MAX_EDGE / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return raw;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    let best = raw;
    let bestBytes = dataUrlApproxBytes(raw);
    for (const quality of VISION_CONTEXT_QUALITY_STEPS) {
      const next = canvasToVisionDataUrl(canvas, quality);
      const bytes = dataUrlApproxBytes(next);
      if (next && bytes && bytes < bestBytes) {
        best = next;
        bestBytes = bytes;
      }
      if (bytes > 0 && bytes <= VISION_CONTEXT_TARGET_BYTES) return next;
    }
    return best;
  } catch (_) {
    return raw;
  }
}

async function prepareDirectUserImageForVision(url = '') {
  const raw = String(url || '').trim();
  if (!/^data:image\//i.test(raw)) return raw;
  // 聊天上传链路已把本地图控制在约 900KB；这里直接复用入库图，避免在部分
  // iOS/Android WebView 上第二次 canvas 解码/转 JPEG 后出现空白或细节损失。
  if (dataUrlApproxBytes(raw) <= DIRECT_USER_IMAGE_PASSTHROUGH_BYTES) return raw;
  return compressVisionDataUrl(raw);
}

/** 微博等带防盗链的图片直接把远程 URL 丢给第三方 AI 接口会被拒；
 * 走同源代理下载成 blob 转 data URL，再复用现有的体积压缩逻辑。 */
async function fetchImageAsDataUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const res = await fetch(raw, { credentials: 'same-origin' });
    if (!res.ok) return '';
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch (_) {
    return '';
  }
}

/** 识图用的图片 URL：防盗链图床（微博）需先经代理下载成 data URL，其余平台直接把远程 URL 交给 AI。 */
async function resolveVisionFetchableUrl(url, platformId = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (!needsSocialImageProxy(raw)) return raw;
  const proxied = displaySocialImageUrl(raw, platformId);
  const dataUrl = await fetchImageAsDataUrl(proxied);
  return dataUrl || '';
}

export async function appendUserProfileAvatarVisionContext(contextMessages, options = {}) {
  const list = Array.isArray(contextMessages) ? contextMessages : [];
  const user = options.user || null;
  const events = Array.isArray(options.events) ? options.events : [];
  const hasAvatarEvent = events.some((event) => event?.type === 'avatar' && event.needsVision !== false);
  const avatarUrl = String(user?.avatar || '').trim();
  if (!hasAvatarEvent || !avatarUrl || (!/^data:image\//i.test(avatarUrl) && !/^https?:\/\//i.test(avatarUrl))) {
    return { messages: list, appended: false };
  }
  const visionUrl = await compressVisionDataUrl(avatarUrl);
  list.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          '用户刚把这张图片设置为聊天头像。请把它当作一次“标注为头像的图片上传”来观察。',
          '如果你能看到图片，请在本轮棉花糖协议里额外输出一条隐藏 memory_fact，记录一句简短、客观的头像视觉印象；不要识别真人身份，不要编造图片里没有的细节。',
          '示例：{"t":"memory_fact","subject":"user","factType":"关系印象","content":"用户刚换了头像：画面整体是……，给人的印象是……","tags":["头像"]}',
          '如果当前模型/API 看不到图片，就不要写具体视觉描述，只自然知道用户换了头像。',
        ].join('\n'),
      },
      { type: 'image_url', image_url: { url: visionUrl, detail: 'auto' } },
    ],
  });
  return { messages: list, appended: true };
}

export async function appendUserVideoAvatarVisionContext(contextMessages, options = {}) {
  const list = Array.isArray(contextMessages) ? contextMessages : [];
  const user = options.user || null;
  const avatarUrl = String(user?.videoAvatar || user?.videoProfileImage || '').trim();
  if (!avatarUrl || (!/^data:image\//i.test(avatarUrl) && !/^https?:\/\//i.test(avatarUrl))) {
    return { messages: list, appended: false };
  }
  const desc = String(user?.videoAppearancePrompt || user?.videoProfileDescription || '').trim();
  const visionUrl = await compressVisionDataUrl(avatarUrl);
  list.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          '这是用户为当前视频通话设置的“我的视频形象”图片。请把它当作通话中对方能看到的用户画面来参考。',
          desc ? `用户给这张视频画面的自述：${desc}` : '如果你能看到图片，可以自然参考画面里的外观、姿态和氛围；不要识别真人身份，不要编造看不见的细节。',
        ].join('\n'),
      },
      { type: 'image_url', image_url: { url: visionUrl, detail: 'auto' } },
    ],
  });
  return { messages: list, appended: true };
}

function getMessageIndexFromEndInChat(msg, sortedMessages) {
  const sorted = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const idx = sorted.findIndex((m) => m.id === msg.id);
  if (idx < 0) return 999999;
  return sorted.length - 1 - idx;
}

function resolveUserImageUrl(msg) {
  return String(msg?.content || msg?.metadata?.url || '').trim();
}

export function isUserLocalImageMessage(msg) {
  if (!msg || msg.deleted || msg.recalled) return false;
  if (msg.senderId !== 'user' || msg.type !== 'image') return false;
  const url = resolveUserImageUrl(msg);
  if (!/^data:image\//i.test(url) && !/^https?:\/\//i.test(url)) return false;
  if (msg.metadata?.stickerName || msg.metadata?.sticker) {
    return String(msg.metadata?.forceImage || '').trim() === 'true';
  }
  return true;
}

function resolveReplyToMessageId(msg) {
  if (!msg) return '';
  const md = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
  const replyMeta = msg.replyMeta && typeof msg.replyMeta === 'object' ? msg.replyMeta : {};
  return String(
    msg.replyTo
    || replyMeta.replyToMessageId
    || md.replyToMessageId
    || md.replyTo
    || '',
  ).trim();
}

/** 用户最新消息是否在回复某张用户本地图片（用于回复时强制重注入该图） */
export function resolveUserImageReplyRefocus(messages = []) {
  const sorted = [...(messages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let latestUser = null;
  let latestUserIndex = -1;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const m = sorted[i];
    if (m?.senderId === 'user') {
      latestUser = m;
      latestUserIndex = i;
      break;
    }
  }
  if (!latestUser || latestUser.type === 'image') return null;
  // 引用图片的用户消息只在它仍是当前待回应内容时重注入。后台主动消息不会
  // 改变“最后一条用户消息”，但已经代表角色回应过；若继续只找 latestUser，
  // 几小时后的主动轮会把旧引用伪装成用户刚刚又回复了那张图。
  const hasCharacterReplyAfter = sorted.slice(latestUserIndex + 1).some((m) => (
    m?.senderId
    && m.senderId !== 'user'
    && m.senderId !== 'system'
    && m.type !== 'system'
  ));
  if (hasCharacterReplyAfter) return null;
  const replyId = resolveReplyToMessageId(latestUser);
  if (!replyId) return null;
  const target = sorted.find((m) => m.id === replyId) || null;
  if (!target || !isUserLocalImageMessage(target)) return null;
  return target;
}

export function isUserReplyingToUserImage(messages = []) {
  return !!resolveUserImageReplyRefocus(messages);
}

function pickLatestUserImageInMessageWindow(sortedMessages, windowSize = CHAT_IMAGE_FOLD_MESSAGE_WINDOW) {
  const n = Math.max(1, Math.min(500, Number(windowSize) || CHAT_IMAGE_FOLD_MESSAGE_WINDOW));
  const sorted = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const imgs = sorted
    .filter((m) => m.senderId === 'user' && m.type === 'image' && resolveUserImageUrl(m))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  for (const m of imgs) {
    if (getMessageIndexFromEndInChat(m, sorted) < n) return m;
  }
  return null;
}

function pickLatestUnansweredUserImageInMessageWindow(sortedMessages, windowSize = CHAT_IMAGE_FOLD_MESSAGE_WINDOW) {
  const img = pickLatestUserImageInMessageWindow(sortedMessages, windowSize);
  if (!img) return null;
  const sorted = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const idx = sorted.findIndex((m) => m.id === img.id);
  if (idx < 0) return null;
  const hasAiAfter = sorted.slice(idx + 1).some((m) =>
    m.senderId && m.senderId !== 'user' && m.senderId !== 'system' && m.type !== 'system');
  return hasAiAfter ? null : img;
}

function pickLatestUserStickerInMessageWindow(sortedMessages, windowSize = CHAT_IMAGE_FOLD_MESSAGE_WINDOW) {
  const n = Math.max(1, Math.min(500, Number(windowSize) || CHAT_IMAGE_FOLD_MESSAGE_WINDOW));
  const sorted = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const stickers = sorted
    .filter((m) => m.senderId === 'user' && m.type === 'sticker' && (m.metadata?.stickerName || m.metadata?.url || m.content))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  for (const m of stickers) {
    if (getMessageIndexFromEndInChat(m, sorted) < n) return m;
  }
  return null;
}

function pickLatestUnansweredUserStickerInMessageWindow(sortedMessages, windowSize = CHAT_IMAGE_FOLD_MESSAGE_WINDOW) {
  const sticker = pickLatestUserStickerInMessageWindow(sortedMessages, windowSize);
  if (!sticker) return null;
  const sorted = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const idx = sorted.findIndex((m) => m.id === sticker.id);
  if (idx < 0) return null;
  const hasAiAfter = sorted.slice(idx + 1).some((m) =>
    m.senderId && m.senderId !== 'user' && m.senderId !== 'system' && m.type !== 'system');
  return hasAiAfter ? null : sticker;
}

function resolveUserStickerImageUrl(msg = {}) {
  const url = String(msg?.metadata?.url || msg?.content || '').trim();
  return /^data:image\//i.test(url) || /^https?:\/\//i.test(url) ? url : '';
}

function resolveChatBundleItems(msg = {}) {
  const md = msg?.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
  return Array.isArray(md.items) ? md.items : (Array.isArray(md.bundleItems) ? md.bundleItems : []);
}

function resolveBundleItemImageUrl(item = {}) {
  if (String(item.type || '') !== 'image') return '';
  return String(item.content || item.url || item.imageUrl || '').trim();
}

function chatBundleHasPlayableImages(msg) {
  return resolveChatBundleItems(msg).some((item) => {
    const url = resolveBundleItemImageUrl(item);
    return /^data:image\//i.test(url) || /^https?:\/\//i.test(url);
  });
}

function pickLatestUnansweredChatBundleWithImages(sortedMessages, windowSize = CHAT_IMAGE_FOLD_MESSAGE_WINDOW) {
  const n = Math.max(1, Math.min(500, Number(windowSize) || CHAT_IMAGE_FOLD_MESSAGE_WINDOW));
  const sorted = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const bundles = sorted
    .filter((m) => (m.type === 'chatBundle' || m.type === 'mergeForward') && chatBundleHasPlayableImages(m))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  for (const m of bundles) {
    if (getMessageIndexFromEndInChat(m, sorted) >= n) continue;
    const idx = sorted.findIndex((item) => item.id === m.id);
    if (idx < 0) continue;
    const hasAiAfter = sorted.slice(idx + 1).some((item) =>
      item.senderId && item.senderId !== 'user' && item.senderId !== 'system' && item.type !== 'system');
    if (!hasAiAfter) return m;
  }
  return null;
}

async function appendChatBundleVision(list, bundleMsg, pendingMarks, options = {}) {
  if (!bundleMsg || isVisionContextConsumed(bundleMsg)) return false;
  const items = resolveChatBundleItems(bundleMsg);
  const maxImages = Math.max(1, Math.min(5, Number(options.maxImages ?? VISION_CONTEXT_MAX_IMAGES) || VISION_CONTEXT_MAX_IMAGES));
  const imageItems = items
    .map((item) => ({ item, url: resolveBundleItemImageUrl(item) }))
    .filter(({ url }) => url && (/^data:image\//i.test(url) || /^https?:\/\//i.test(url)))
    .slice(0, maxImages);
  if (!imageItems.length) return false;
  const title = String(bundleMsg.metadata?.bundleTitle || '聊天记录').trim() || '聊天记录';
  const fromUser = bundleMsg.senderId === 'user';
  const parts = [{
    type: 'text',
    text: [
      fromUser
        ? `用户刚转发了一段聊天记录「${title}」，其中包含 ${imageItems.length} 张图片。`
        : `对话里刚出现一段转发的聊天记录「${title}」，其中包含 ${imageItems.length} 张图片。`,
      '请结合这些截图/图片里真实可见的内容理解并回复；看不清时不要编造画面里没有的细节。',
    ].join('\n'),
  }];
  for (let i = 0; i < imageItems.length; i += 1) {
    const { item, url } = imageItems[i];
    const visionUrl = await compressVisionDataUrl(url);
    if (!visionUrl) continue;
    const sender = String(item.senderName || item.senderId || '').trim();
    parts.push({
      type: 'text',
      text: `[转发聊天记录配图 ${i + 1}/${imageItems.length}${sender ? ` · ${sender}所发` : ''}]`,
    });
    parts.push({ type: 'image_url', image_url: { url: visionUrl, detail: 'auto' } });
  }
  if (parts.length <= 1) return false;
  list.push({ role: 'user', content: parts });
  pendingMarks.push({ msg: bundleMsg, reason: 'chat-bundle-images' });
  return true;
}

function resolveLinkShareImageUrls(msg = {}) {
  const md = msg?.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
  const images = Array.isArray(md.images) ? md.images.map((u) => String(u || '').trim()).filter(Boolean) : [];
  // 用户主动“让角色看看”时，优先把刚截取的网页画面交给模型。原卡片即使已有远程封面，
  // 也不能挤占有限的识图图片位，否则角色可能只看到商品封面、看不到详情页截图。
  if (md.screenshotFallback === true && md.forceVisionContextAfterCapture === true) {
    return images
      .filter((u) => /^data:image\/(?:jpeg|png|webp);base64,/i.test(u))
      .slice(0, 3);
  }
  const cover = String(md.coverUrl || md.imageUrl || images[0] || '').trim();
  if (!cover) return [];
  const merged = [cover, ...images.filter((u) => u !== cover)];
  return merged.filter((u) => /^data:image\//i.test(u) || /^https?:\/\//i.test(u)).slice(0, 3);
}

function pickLatestUnansweredUserLinkShare(
  sortedMessages,
  windowSize = CHAT_IMAGE_FOLD_MESSAGE_WINDOW,
  forcedMessageId = '',
) {
  const n = Math.max(1, Math.min(500, Number(windowSize) || CHAT_IMAGE_FOLD_MESSAGE_WINDOW));
  const sorted = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const forcedId = String(forcedMessageId || '').trim();
  if (forcedId) {
    const forced = sorted.find((message) => (
      String(message?.id || '') === forcedId
      && message?.senderId === 'user'
      && message?.type === 'link'
      && resolveLinkShareImageUrls(message).length
    ));
    // 明确点击读取的卡片不受“最近 50 条/是否已有回复”限制；这是本轮唯一指定的视觉来源。
    return forced || null;
  }
  const links = sorted
    .filter((m) => m.senderId === 'user' && m.type === 'link' && resolveLinkShareImageUrls(m).length)
    .sort((a, b) => {
      const forced = Number(b.metadata?.forceVisionContextAfterCapture === true)
        - Number(a.metadata?.forceVisionContextAfterCapture === true);
      return forced || (b.timestamp || 0) - (a.timestamp || 0);
    });
  for (const m of links) {
    if (getMessageIndexFromEndInChat(m, sorted) >= n) continue;
    const idx = sorted.findIndex((item) => item.id === m.id);
    if (idx < 0) continue;
    const hasAiAfter = sorted.slice(idx + 1).some((item) =>
      item.senderId && item.senderId !== 'user' && item.senderId !== 'system' && item.type !== 'system');
    if (!hasAiAfter || m.metadata?.forceVisionContextAfterCapture === true) return m;
  }
  return null;
}

async function appendLinkShareCoverVision(list, linkMsg, sortedForMedia, pendingMarks, options = {}) {
  if (!linkMsg || isVisionContextConsumed(linkMsg)) return false;
  const urls = resolveLinkShareImageUrls(linkMsg);
  if (!urls.length) return false;
  const md = linkMsg.metadata || {};
  const preview = resolveLinkMessagePreview(linkMsg, md);
  const platformId = String(md.platformId || md.platform?.id || preview.platformId || '').trim();
  const platformLabel = String(md.platformLabel || md.platform?.label || md.source || preview.platformLabel || '链接').trim() || '链接';
  const title = String(preview.title || md.title || '').trim();
  const bodySnippet = String(preview.descFull || '').trim().slice(0, 360);
  // 截图兜底（没配 TikHub Key 或 TikHub 挂了时的内置 WebView 截图）没有单独的结构化正文，
  // 标题/正文/评论都只存在于截图画面里，提示词要让模型知道「自己读图」而不是等着有独立正文可看。
  const isScreenshotFallback = md.enhancedBy === 'webview-snapshot' || md.screenshotFallback === true;
  const defaultMaxImages = 2;
  const parts = [{
    type: 'text',
    text: [
      `用户分享了一条${platformLabel}链接${title ? `：${title}` : ''}。`,
      bodySnippet && !isScreenshotFallback
        ? `分享摘要：${bodySnippet}${preview.isLocalPreview ? '（来自分享文案，可能被截断）' : ''}`
        : '',
      isScreenshotFallback
        ? '这条内容没有单独的文字版正文，是内置浏览器直接截的官方网页原样画面；标题、正文、配图都在下面的截图里，请直接阅读截图中的文字来理解内容。截图可能只覆盖开头一部分、评论区大概率截不全，看不清或没截全时要如实说明，不要凭猜测编内容。'
        : (bodySnippet
          ? '请结合下方摘要与配图理解内容；看不清时不要编造画面细节。'
          : '请结合下方配图与对话里的链接正文理解内容；看不清时不要编造画面细节。'),
      urls.length > 1
        ? (isScreenshotFallback ? `（共截了 ${urls.length} 屏，按顺序往下翻）` : `（笔记共 ${urls.length} 张配图，以下为封面）`)
        : '',
    ].filter(Boolean).join('\n'),
  }];
  const injectCount = Math.min(urls.length, Math.max(1, Number(options.linkVisionMaxImages ?? defaultMaxImages) || defaultMaxImages));
  for (let i = 0; i < injectCount; i += 1) {
    const fetchableUrl = await resolveVisionFetchableUrl(urls[i], platformId);
    if (!fetchableUrl) continue;
    const visionUrl = await compressVisionDataUrl(fetchableUrl);
    if (!visionUrl) continue;
    parts.push({
      type: 'text',
      text: isScreenshotFallback ? `[截图 ${i + 1}/${injectCount}]` : `[链接配图 ${i + 1}${i === 0 ? '·封面' : ''}]`,
    });
    parts.push({ type: 'image_url', image_url: { url: visionUrl, detail: 'auto' } });
  }
  if (parts.length <= 1) return false;
  list.push({ role: 'user', content: parts });
  pendingMarks.push({ msg: linkMsg, reason: 'link-share-cover' });
  return true;
}

function isVisionContextConsumed(msg) {
  const md = msg?.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
  return !!(md.visionContextConsumedAt || md.visionContextConsumed === true);
}

function countAiRepliesAfterMessage(msg, sortedMessages = []) {
  if (!msg?.id) return 999999;
  const idx = sortedMessages.findIndex((m) => m.id === msg.id);
  if (idx < 0) return 999999;
  return sortedMessages.slice(idx + 1).filter((m) =>
    m.senderId && m.senderId !== 'user' && m.senderId !== 'system' && m.type !== 'system').length;
}

function listRecentUserImagesForVisionContext(sortedMessages, options = {}) {
  const windowSize = options.windowSize ?? CHAT_IMAGE_FOLD_MESSAGE_WINDOW;
  const maxImages = Math.max(1, Math.min(5, Number(options.maxImages ?? VISION_CONTEXT_MAX_IMAGES) || VISION_CONTEXT_MAX_IMAGES));
  const keepAliveTurns = Math.max(1, Math.min(8, Number(options.keepAliveTurns ?? VISION_CONTEXT_KEEP_ALIVE_TURNS) || VISION_CONTEXT_KEEP_ALIVE_TURNS));
  const sorted = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const candidates = sorted
    .filter((m) => isUserLocalImageMessage(m) && getMessageIndexFromEndInChat(m, sorted) < windowSize)
    .filter((m) => countAiRepliesAfterMessage(m, sorted) < keepAliveTurns)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, maxImages)
    .reverse();
  return { candidates, keepAliveTurns };
}

function listCurrentUnansweredUserImages(sortedMessages, maxImages = VISION_CONTEXT_MAX_IMAGES) {
  const sorted = [...(sortedMessages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let lastAiIndex = -1;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const message = sorted[i];
    if (message?.senderId && message.senderId !== 'user' && message.senderId !== 'system' && message.type !== 'system') {
      lastAiIndex = i;
      break;
    }
  }
  return sorted
    .slice(lastAiIndex + 1)
    .filter((message) => isUserLocalImageMessage(message))
    .slice(-Math.max(1, Math.min(5, Number(maxImages) || VISION_CONTEXT_MAX_IMAGES)));
}

async function hydrateDeferredVisionMedia(messages = [], windowSize = CHAT_IMAGE_FOLD_MESSAGE_WINDOW) {
  const n = Math.max(1, Math.min(500, Number(windowSize) || CHAT_IMAGE_FOLD_MESSAGE_WINDOW));
  const sorted = [...(messages || [])]
    .filter((m) => !m.deleted && !m.recalled)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const visibleWindow = sorted.slice(-n);
  const deferred = visibleWindow.filter((message) => {
    if (!message?.id || message.senderId !== 'user') return false;
    if (message.type !== 'image' && message.type !== 'sticker') return false;
    return message.metadata?.deferredImage === true || message.metadata?.deferredSticker === true;
  });
  if (!deferred.length) return sorted;
  const hydrated = await Promise.all(deferred.map(async (message) => {
    try {
      return await hydrateDeferredMediaMessage(message);
    } catch (_) {
      return message;
    }
  }));
  const byId = new Map(hydrated.filter((message) => message?.id).map((message) => [message.id, message]));
  return sorted.map((message) => byId.get(message.id) || message);
}

async function markVisionContextConsumed(msg, reason = 'vision-context', options = {}) {
  if (!msg?.id) return;
  const prevCount = Number(msg.metadata?.visionContextUseCount || 0) || 0;
  const isDisposableSnapshot = msg.metadata?.screenshotFallback === true
    || msg.metadata?.enhancedBy === 'webview-snapshot';
  const metadata = {
    ...(msg.metadata || {}),
    visionContextConsumed: true,
    visionContextConsumedAt: Date.now(),
    visionContextConsumedReason: reason,
    visionContextUseCount: prevCount + 1,
    ...(options.keepAliveTurns ? { visionContextKeepAliveTurns: options.keepAliveTurns } : {}),
  };
  // 原生网页截图只为当前一次识图中转。模型请求成功后把 data URL 从消息持久化数据中抹掉，
  // 卡片仍保留标题和链接，但不会让商品页画面长期躺在 IndexedDB / 备份包里。
  if (isDisposableSnapshot) {
    metadata.images = [];
    if (/^data:image\//i.test(String(metadata.coverUrl || ''))) metadata.coverUrl = '';
    if (/^data:image\//i.test(String(metadata.imageUrl || ''))) metadata.imageUrl = '';
    if (/^data:image\//i.test(String(metadata.image || ''))) metadata.image = '';
    metadata.screenshotPurgedAt = Date.now();
  }
  delete metadata.forceVisionContextAfterCapture;
  await saveMessage({ ...msg, metadata });
  msg.metadata = metadata;
}

/**
 * 多模态识图：用户图片/表情包注入 API messages（对齐原项目 chat-helpers）。
 * 返回 pendingMarks，成功落库后再 commitVisionContextMarks，避免失败回合导致失明。
 */
export async function appendUnansweredUserVisionContext(contextMessages, scopedMessages, options = {}) {
  const list = Array.isArray(contextMessages) ? contextMessages : [];
  const pendingMarks = [];
  const windowSize = options.windowSize ?? CHAT_IMAGE_FOLD_MESSAGE_WINDOW;
  const sortedForMedia = await hydrateDeferredVisionMedia(scopedMessages, windowSize);

  const latestUserSticker = pickLatestUnansweredUserStickerInMessageWindow(sortedForMedia, windowSize);
  if (latestUserSticker && !isVisionContextConsumed(latestUserSticker)) {
    const nm = String(latestUserSticker.metadata?.stickerName || latestUserSticker.metadata?.sticker || '').trim();
    const stickerUrl = options.stickerVisionEnabled === true
      ? resolveUserStickerImageUrl(latestUserSticker)
      : '';
    const gifFirstFrameOnly = !!stickerUrl
      && options.stickerGifFirstFrameEnabled === true
      && isGifStickerImage(latestUserSticker, stickerUrl);
    const stickerVisionUrl = gifFirstFrameOnly
      ? await (options.gifFirstFrameResolver || extractGifFirstFrameForVision)(stickerUrl, latestUserSticker)
      : stickerUrl;
    if (stickerVisionUrl) {
      const visionUrl = await compressVisionDataUrl(stickerVisionUrl);
      list.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              nm ? `用户刚发了一张名为「${nm}」的表情包。` : '用户刚发了一张表情包。',
              gifFirstFrameOnly ? '当前附件是这张 GIF 表情包的第一帧，只根据这一帧中可见的内容理解，不要编造后续动画。' : '',
              '请直接观察图片中的人物/动物、表情、动作、文字和梗，结合当前语境理解它在表达什么；图片内容优先于名称，不识别真人身份，不编造看不见的细节。',
            ].filter(Boolean).join('\n'),
          },
          { type: 'image_url', image_url: { url: visionUrl, detail: VISION_CONTEXT_DETAIL } },
        ],
      });
      pendingMarks.push({ msg: latestUserSticker, reason: 'user-sticker-vision' });
    } else {
      list.push({
        role: 'user',
        content: nm ? `[表情包: ${nm}]` : '[表情包]',
      });
      pendingMarks.push({ msg: latestUserSticker, reason: 'user-sticker' });
    }
    return { messages: list, pendingMarks };
  }

  const forcedLinkVisionMessageId = String(options.forcedLinkVisionMessageId || '').trim();
  const latestLinkShare = pickLatestUnansweredUserLinkShare(
    sortedForMedia,
    windowSize,
    forcedLinkVisionMessageId,
  );
  if (latestLinkShare) {
    const appended = await appendLinkShareCoverVision(list, latestLinkShare, sortedForMedia, pendingMarks, options);
    if (appended) return { messages: list, pendingMarks, forcedLinkVisionAttached: !!forcedLinkVisionMessageId };
  }

  if (forcedLinkVisionMessageId) {
    return { messages: list, pendingMarks, forcedLinkVisionAttached: false };
  }

  const latestChatBundle = pickLatestUnansweredChatBundleWithImages(sortedForMedia, windowSize);
  if (latestChatBundle) {
    const appended = await appendChatBundleVision(list, latestChatBundle, pendingMarks, options);
    if (appended) return { messages: list, pendingMarks };
  }

  const replyRefocusImage = options.replyRefocusImage
    || (options.userDiscussingUserImage !== false ? resolveUserImageReplyRefocus(sortedForMedia) : null);
  const userDiscussingImage = options.userDiscussingUserImage === true || !!replyRefocusImage;
  const maxImages = Math.max(1, Math.min(5, Number(options.maxImages ?? VISION_CONTEXT_MAX_IMAGES) || VISION_CONTEXT_MAX_IMAGES));
  const { candidates: keepAliveImages, keepAliveTurns } = listRecentUserImagesForVisionContext(sortedForMedia, {
    windowSize,
    maxImages: options.maxImages,
    keepAliveTurns: options.keepAliveTurns,
  });
  const currentBatchImages = listCurrentUnansweredUserImages(sortedForMedia, maxImages);
  const keepAliveIds = new Set(keepAliveImages.map((m) => m.id));
  let imagesToInject = currentBatchImages.length ? [...currentBatchImages] : [...keepAliveImages];
  if (replyRefocusImage) {
    imagesToInject = [
      replyRefocusImage,
      ...imagesToInject.filter((m) => m.id !== replyRefocusImage.id),
    ].slice(0, maxImages);
  }
  if (imagesToInject.length) {
    const defaultPrompt = currentBatchImages.length
      ? (imagesToInject.length === 1
        ? '用户刚发送了一张图片。请优先、仔细观察这张图里的主体、动作、文字与细节后再回复；不要混入更早图片的内容，不要编造看不见的东西。'
        : `用户本轮连续发送了 ${imagesToInject.length} 张图片。请按下方顺序逐张观察主体、动作、文字与细节后再回复；不要混入更早图片的内容。`)
      : (userDiscussingImage
        ? '用户正在回复上面那张图片发言，请务必结合该图画面里真实可见的内容回答；不要被前几轮可能已经说错的描述带偏，也不要编造画面里没有的东西。'
        : `请结合最近 ${imagesToInject.length} 张用户图片理解并回复；这些图只代表用户刚刚发过的内容，不要当作实时摄像头。`);
    const parts = [{
      type: 'text',
      text: String(options.imagePromptText || defaultPrompt),
    }];
    let injectedImageIndex = 0;
    for (const img of imagesToInject) {
      const url = resolveUserImageUrl(img);
      if (!url) continue;
      injectedImageIndex += 1;
      const visionUrl = await prepareDirectUserImageForVision(url);
      const repliesAfter = countAiRepliesAfterMessage(img, sortedForMedia);
      const caption = String(img.metadata?.caption || img.metadata?.text || '').trim();
      const isReplyTarget = replyRefocusImage && img.id === replyRefocusImage.id;
      const refocused = isReplyTarget && !keepAliveIds.has(img.id);
      let tag = repliesAfter === 0 ? '刚发送' : `${repliesAfter}轮前`;
      if (isReplyTarget) tag = refocused ? '回复重注入' : '回复引用';
      parts.push({
        type: 'text',
        text: `[用户图片${injectedImageIndex} · ${tag}${caption ? ` · 说明:${caption}` : ''}]`,
      });
      parts.push({ type: 'image_url', image_url: { url: visionUrl, detail: VISION_CONTEXT_DETAIL } });
      pendingMarks.push({
        msg: img,
        reason: refocused ? 'user-image-refocus' : 'user-image-keepalive',
        options: { keepAliveTurns },
      });
    }
    if (parts.length > 1) list.push({ role: 'user', content: parts });
    return { messages: list, pendingMarks };
  }

  const latestImage = pickLatestUnansweredUserImageInMessageWindow(sortedForMedia, windowSize);
  if (latestImage && !isVisionContextConsumed(latestImage)) {
    const url = resolveUserImageUrl(latestImage);
    if (url) {
      const visionUrl = await prepareDirectUserImageForVision(url);
      list.push({
        role: 'user',
        content: [
          { type: 'text', text: '请结合这张用户图片理解并回复。' },
          { type: 'image_url', image_url: { url: visionUrl, detail: VISION_CONTEXT_DETAIL } },
        ],
      });
      pendingMarks.push({ msg: latestImage, reason: 'user-image' });
    }
  }

  return { messages: list, pendingMarks };
}

export async function commitVisionContextMarks(pendingMarks = []) {
  for (const item of pendingMarks) {
    if (!item?.msg) continue;
    await markVisionContextConsumed(item.msg, item.reason || 'vision-context', item.options || {});
  }
}

/** 将若干图片 URL 压成 vision 多模态 parts（朋友圈补评论等场景） */
export async function buildImageUrlVisionParts(urls = [], { max = 3, prefix = '配图' } = {}) {
  const parts = [];
  const list = (Array.isArray(urls) ? urls : [])
    .map((url) => String(url || '').trim())
    .filter((url) => /^data:image\//i.test(url) || /^https?:\/\//i.test(url))
    .slice(0, Math.max(1, Math.min(5, Number(max) || 3)));
  if (!list.length) return parts;
  parts.push({
    type: 'text',
    text: `${prefix}共 ${list.length} 张；若 API 支持识图请结合画面写评论，不支持则按文字理解。`,
  });
  for (let i = 0; i < list.length; i += 1) {
    const visionUrl = await compressVisionDataUrl(list[i]);
    parts.push({ type: 'text', text: `[${prefix} ${i + 1}]` });
    parts.push({ type: 'image_url', image_url: { url: visionUrl, detail: 'auto' } });
  }
  return parts;
}
