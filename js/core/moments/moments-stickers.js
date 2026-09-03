import { listStickerPacks } from '../sticker-store.js';
import {
  parseStickerTagLine,
  normalizeStickerBracketText,
  resolveStickerUrlByKeyword,
} from '../chat/sticker-resolve.js';
import { expandTextEmoteAliases } from '../text-emote-aliases.js';

const STICKER_TAG_RE = /\[(?:表情包|贴纸)[:：]\s*([^\]]+)\]/g;

export async function loadFlatStickerPool(stickerPackIds = null) {
  const scopedPackIds = Array.isArray(stickerPackIds)
    ? new Set(stickerPackIds.map((id) => String(id || '').trim()).filter(Boolean))
    : null;
  const packs = (await listStickerPacks())
    .filter((pack) => !scopedPackIds || scopedPackIds.has(String(pack?.id || '').trim()));
  const out = [];
  for (const p of packs) {
    for (const s of p.stickers || []) {
      if (s?.url) out.push(s);
    }
  }
  return out;
}

export function extractStickerNamesFromText(text = '') {
  const s = normalizeStickerBracketText(String(text || ''));
  const names = [];
  let m;
  const re = new RegExp(STICKER_TAG_RE.source, 'g');
  while ((m = re.exec(s)) !== null) {
    const name = String(m[1] || '').trim();
    if (name) names.push(name);
  }
  return names;
}

export function stripStickerTagsFromText(text = '') {
  return normalizeStickerBracketText(String(text || ''))
    .replace(STICKER_TAG_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 将 stickerNames / 正文与评论里的 [表情包:名] 解析为真实 URL。
 * 表情包写入 stickerImages（独立渲染），不要塞进 photos 九宫格，避免 cover 裁切。
 */
export function applyMomentPostStickers(post = {}, stickerPool = []) {
  if (!post || !stickerPool.length) return post;
  const names = [
    ...(Array.isArray(post.stickerNames) ? post.stickerNames : []),
    ...extractStickerNamesFromText(post.content),
  ];
  const stickerImages = [...(Array.isArray(post.stickerImages) ? post.stickerImages : [])]
    .map((item) => (typeof item === 'string'
      ? { url: item, name: '' }
      : { url: String(item?.url || '').trim(), name: String(item?.name || '').trim() }))
    .filter((item) => item.url);
  const seen = new Set(stickerImages.map((item) => item.url));
  // 旧数据：曾把表情包 URL 混进 images，尽量从「本次解析到的 sticker」里识别并挪出来
  const photoImages = [...(Array.isArray(post.images) ? post.images : [])].filter(Boolean);

  for (const rawName of names) {
    if (stickerImages.length >= 6) break;
    const hit = resolveStickerUrlByKeyword(rawName, stickerPool);
    if (hit?.url && !seen.has(hit.url)) {
      stickerImages.push({ url: hit.url, name: hit.name || rawName });
      seen.add(hit.url);
    }
  }

  // 若 images 里碰巧就是刚解析到的表情包 URL，从九宫格里拿掉，避免重复且被 cover 裁切
  const nextImages = photoImages.filter((url) => !seen.has(url));

  const next = {
    ...post,
    images: nextImages.slice(0, 9),
    stickerImages,
  };
  if (names.length) {
    next.content = stripStickerTagsFromText(post.content);
  }
  delete next.stickerNames;
  return next;
}

export function buildMomentsStickerPromptBlock(stickerPool = []) {
  if (!stickerPool.length) {
    return '[表情包] 用户未导入表情包库时可省略；不要编造不存在的表情包名。';
  }
  const names = [...new Set(stickerPool.map((s) => String(s.name || '').trim()).filter(Boolean))].slice(0, 120);
  return [
    '[表情包 · 须用库内真实名称]',
    '勾选「可带表情包」时：用 stickerNames 数组填 1～3 个名称（与下方列表完全一致），前台会解析成独立表情包图（完整显示，不裁切），与配图并列。',
    '评论里也可写 [表情包:名称]；名称必须来自下列列表，禁止编造。',
    names.map((n) => `· ${n}`).join('\n'),
  ].join('\n');
}

export function renderMomentTextWithStickers(text = '', stickerPool = [], esc, escAttr) {
  const raw = expandTextEmoteAliases(String(text || '').trim());
  if (!raw) return '';
  if (!stickerPool?.length) return esc(raw);
  return expandStickerTagsInBubbleText(raw, stickerPool, esc, escAttr);
}

function expandStickerTagsInBubbleText(rawText, allStickers, esc, escAttr) {
  const s = normalizeStickerBracketText(String(rawText ?? ''));
  if (!s) return '';
  if (!allStickers?.length) return esc(s);
  if (!/(?:\[表情包|\[贴纸|(?:表情包|贴纸)\s*[：:])/.test(s)) return esc(s);

  const imgSpan = (url, name) =>
    `<span class="chat-sticker-slot chat-sticker-slot--mixed-bubble"><span class="chat-sticker"><img src="${escAttr(url)}" alt="${esc(name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('.chat-sticker-slot')?.replaceWith(document.createTextNode('[表情包: ${escAttr(name)}]'))" /></span></span>`;

  function segmentToHtml(seg) {
    const t = String(seg || '').trim();
    if (!t) return '';
    const pl = parseStickerTagLine(t);
    if (pl?.url) return imgSpan(pl.url, pl.name);
    const bracket = t.match(/^\[(?:表情包|贴纸)[:：]\s*([^\]]+)\]\s*$/);
    if (bracket) {
      const r = resolveStickerUrlByKeyword(bracket[1], allStickers);
      if (r?.url) return imgSpan(r.url, r.name);
      return esc(t);
    }
    const kwForm = t.match(/^(?:表情包|贴纸)[：:]\s*(.+)$/);
    if (kwForm) {
      const r = resolveStickerUrlByKeyword(kwForm[1].trim(), allStickers);
      if (r?.url) return imgSpan(r.url, r.name);
    }
    return esc(t);
  }

  const re =
    /\[(?:表情包|贴纸)[:：]\s*[^\]]+\](?:\s+(?:https?:\/\/[^\s\[\]）]+|data:image[^;\s]+;base64,[A-Za-z0-9+/=]+))?|(?:表情包|贴纸)[：:]\s*[^\n\r，。！？]{1,48}/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    out += esc(s.slice(last, m.index));
    out += segmentToHtml(m[0]);
    last = m.index + m[0].length;
  }
  out += esc(s.slice(last));
  return out;
}
