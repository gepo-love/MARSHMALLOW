/** 小红书/微博链接深度解析（BYOK：用户自己的 TikHub Key）。
 * 只有配置里开启并填了 Key 才会调用；调用经由 apps/web/_worker.js 的 /api/social/tikhub 转发，
 * 因为 TikHub 没有对任意网页来源开放跨域，浏览器直连会被 CORS 拦掉。
 * TikHub 返回的 data 字段是小红书/微博私有接口的原始 JSON（未公开文档化字段），
 * 这里的字段映射基于公开可查的抓包资料，如遇实际字段偏差，只需改这里的 normalize* 函数。 */
import * as db from './db.js';
import { detectLinkPlatform } from './link-platforms.js';
import { resolveSocialWorkerUrl, socialWorkerFetch } from './social-worker-client.js';

const TIKHUB_PROXY_PATH = '/api/social/tikhub';
const REDIRECT_PROXY_PATH = '/api/social/resolve-redirect';
const SOCIAL_LINK_CACHE_KEY = 'socialLinkResolveCache';
const CACHE_VERSION = 13;
const MAX_CACHE_ITEMS = 150;
const DEFAULT_CACHE_DAYS = 3;

function text(value = '', max = 2000) {
  // 社媒（尤其 B站）简介经常把封面图/活动素材图写成 ![](url) 夹在正文里，不是真正想给用户
  // 看的文字——链接卡片自己有独立封面图字段，这里统一在最早的文本清洗点上就去掉，不然会在
  // 卡片正文里留下一串"![]"和裸链接。
  return String(value || '').replace(/!\[[^\]]*\]\s*\(\s*[^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeShareUrl(url = '') {
  const raw = text(url, 1000);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    ['share_source', 'vd_source', 'spm_id_from', 'from', 'seid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
      .forEach((key) => u.searchParams.delete(key));
    if (!u.searchParams.toString()) u.search = '';
    return u.toString();
  } catch {
    return raw;
  }
}

function cacheKeyForUrl(url = '') {
  return normalizeShareUrl(url) || String(url || '').trim();
}

/** 社媒链接缓存键：同一笔记/微博/B 站视频的不同分享 URL（含 xsec_token 等）归一到 canonical 形态，避免重复解析。 */
function socialCacheKey(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const platform = detectLinkPlatform(raw);
  if (platform?.id === 'xiaohongshu') {
    const m = raw.match(/xiaohongshu\.com\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/i);
    if (m?.[1]) return `https://www.xiaohongshu.com/explore/${m[1]}`;
  }
  if (platform?.id === 'weibo') {
    const mid = extractWeiboStatusId(raw);
    if (mid) return `https://m.weibo.cn/detail/${mid}`;
  }
  if (platform?.id === 'bilibili') {
    const m = raw.match(/\/video\/(BV[a-zA-Z0-9]+)/i) || raw.match(/^(BV[a-zA-Z0-9]+)$/i);
    if (m?.[1]) return `https://www.bilibili.com/video/${m[1]}`;
  }
  return cacheKeyForUrl(raw);
}

function cacheTtlMs(config = {}) {
  return Math.max(1, Number(config.cacheDays || DEFAULT_CACHE_DAYS)) * 24 * 60 * 60 * 1000;
}

function extractHttpUrlFromText(value = '', fallbackUrl = '') {
  const raw = String(value || '').trim();
  const direct = raw.match(/^https?:\/\/[^\s<>"'，。！？、]+$/i);
  if (direct) return direct[0].replace(/[)\].,;!?]+$/u, '');
  const all = (raw.match(/https?:\/\/[^\s<>"'，。！？、]+/gi) || [])
    .map((item) => item.replace(/[)\].,;!?]+$/u, ''))
    .filter(Boolean);
  if (all.length === 1) return all[0];
  if (all.length > 1) {
    const social = all.find((item) => /(?:^|\/\/)(?:[^/]+\.)?(xhslink\.(?:com|cn)|xiaohongshu\.com|weibo\.com|t\.cn)\b/i.test(item));
    if (social) return social;
    return all[0];
  }
  return cacheKeyForUrl(fallbackUrl) || String(fallbackUrl || '').trim();
}

/** TikHub 请求只用链接，不用整段分享文案（用户仍可粘贴 App 整段分享）。 */
export function buildTikhubShareInput(shareText = '', url = '') {
  const cleanUrl = cacheKeyForUrl(url) || String(url || '').trim();
  if (/^https?:\/\//i.test(cleanUrl)) return cleanUrl;
  const extracted = extractHttpUrlFromText(shareText, url);
  return cacheKeyForUrl(extracted) || extracted || cleanUrl;
}

function isXiaohongshuShortLink(url = '') {
  try {
    return /^(?:www\.)?xhslink\.(?:com|cn)$/i.test(new URL(String(url || '').trim()).hostname);
  } catch (_) {
    return false;
  }
}

export function extractXiaohongshuNoteId(url = '') {
  try {
    const parsed = new URL(String(url || '').trim());
    const match = parsed.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/i);
    return match?.[1] || '';
  } catch (_) {
    return '';
  }
}

export function extractXiaohongshuUserId(url = '') {
  try {
    const parsed = new URL(String(url || '').trim());
    const match = parsed.pathname.match(/\/user\/profile\/([a-zA-Z0-9]+)/i);
    return match?.[1] || '';
  } catch (_) {
    return '';
  }
}

/**
 * TikHub 虽然把 App V2 标成支持短链接，但新版 xhslink.cn/o/* 仍可能直接返回 400 并计费。
 * 对小红书短链先经自有安全代理展开，再按官方推荐优先传 note_id；展开失败时不要继续发起付费请求。
 */
export async function prepareXiaohongshuLookupParams(
  url = '',
  shareText = url,
  resolveShortLinkFn = resolveShortLink,
) {
  const input = buildTikhubShareInput(shareText, url);
  let resolved = input;
  if (isXiaohongshuShortLink(input)) {
    resolved = await resolveShortLinkFn(input).catch(() => '');
    if (!resolved) {
      throw new Error('小红书短链展开失败，已停止请求 TikHub，避免失败仍扣费。请稍后重试或粘贴完整笔记链接。');
    }
  }
  const noteId = extractXiaohongshuNoteId(resolved);
  return noteId ? { note_id: noteId } : { share_text: resolved };
}

/**
 * 主页分享使用 xhslink.cn/m/*。部分新短链在无登录环境只跳到小红书首页，
 * 这种情况无法提取 user_id，必须在调用 TikHub 前停止，避免确定失败的请求仍被计费。
 */
export async function prepareXiaohongshuUserLookupParams(
  profileInput = '',
  resolveShortLinkFn = resolveShortLink,
) {
  const input = buildTikhubShareInput(profileInput, profileInput);
  if (!input) return null;
  let resolved = input;
  if (isXiaohongshuShortLink(input)) {
    resolved = await resolveShortLinkFn(input).catch(() => '');
    if (!resolved) {
      throw new Error('小红书主页短链展开失败，已停止请求 TikHub，避免失败仍扣费。请稍后重试或粘贴完整主页链接。');
    }
  }
  const userId = extractXiaohongshuUserId(resolved);
  if (userId) return { user_id: userId };
  if (isXiaohongshuShortLink(input)) {
    throw new Error('新版小红书主页短链没有返回用户编号，已停止请求 TikHub，避免失败仍扣费。请从浏览器地址栏复制完整主页链接后重试。');
  }
  return { share_text: resolved };
}

export { normalizeShareUrl as normalizeLinkCacheKey };

const inflightResolve = new Map();

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** 代理路由本身没生效时（本地静态预览 / 站点还没重新部署最新 _worker.js），
 * 返回的是服务器/静态托管商的默认 404 页（HTML 或空），不是我们 json() 出来的错误体，
 * 这里要把这种情况和「TikHub 真的返回了错误」区分开，否则用户只会看到一句干巴巴的 404。 */
async function readProxyErrorText(res, label) {
  let bodyText = '';
  try {
    bodyText = (await res.text()).trim();
  } catch (_) {
    bodyText = '';
  }
  let payload = null;
  if (bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch (_) {
      payload = null;
    }
  }
  if (payload) {
    const detail = typeof payload.detail === 'string'
      ? payload.detail
      : (Array.isArray(payload.detail)
        ? payload.detail.map((item) => item?.msg || item?.message || '').filter(Boolean).join('；')
        : '');
    return payload.message_zh || payload.message || payload.error || detail || `${label} 失败（${res.status}）`;
  }
  if (res.status === 404) {
    return `${label} 转发路由没生效（404）。如果是本地 npx serve 预览，这个代理只有部署到 Cloudflare Pages 才会跑；如果是线上站点，说明还没重新部署最新的 _worker.js。`;
  }
  const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 160);
  return `${label} 失败（HTTP ${res.status}）${snippet ? `：${snippet}` : ''}`;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return value;
  }
}

function hasXhsNoteFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.note_card && typeof obj.note_card === 'object') return true;
  return !!(
    text(obj.desc, 4)
    || text(obj.title, 2)
    || text(obj.display_title, 2)
    || text(obj.content, 4)
    || text(obj.text, 4)
    || (Array.isArray(obj.image_list) && obj.image_list.length)
    || (Array.isArray(obj.images_list) && obj.images_list.length)
    || (Array.isArray(obj.images) && obj.images.length)
    || (Array.isArray(obj.pics) && obj.pics.length)
    || obj.cover
    || obj.note_id
    || (obj.id && (obj.desc || obj.title || obj.display_title || obj.image_list || obj.images))
  );
}

function pickXhsListEntry(list = []) {
  if (!Array.isArray(list) || !list.length) return null;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.note_card && typeof entry.note_card === 'object') return entry.note_card;
    if (hasXhsNoteFields(entry)) return entry;
    const nested = deepFindXhsNote(entry, 0, new WeakSet());
    if (nested) {
      return nested.note_card && typeof nested.note_card === 'object' ? nested.note_card : nested;
    }
  }
  return null;
}

function deepFindXhsNote(obj, depth = 0, seen = new WeakSet()) {
  if (obj == null || depth > 12) return null;
  const value = parseMaybeJson(obj);
  if (value == null || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    // 长度 >1 是真实的多条结果（如搜索列表），不能当成"单条详情套了层数组"直接吞掉第一条返回——
    // 否则列表类接口会被坍缩成 1 条，调用方按列表字段取值时全部落空（如 search_notes 返回一直被判定"无结果"）。
    if (value.length !== 1) return null;
    return deepFindXhsNote(value[0], depth + 1, seen);
  }

  for (const key of ['note_list', 'items']) {
    // 同上：只在"长度为 1 的数组包了一层详情"这种歧义场景才展开成单条，真正的多条列表原样保留，
    // 交给调用方（如 searchXiaohongshuNotes）自己按列表字段读取全部结果。
    if (Array.isArray(value[key]) && value[key].length === 1) {
      const picked = pickXhsListEntry(value[key]);
      if (picked) return picked;
    }
  }

  if (hasXhsNoteFields(value)) return value;

  if (isNestedApiEnvelope(value) && value.data != null) {
    const found = deepFindXhsNote(value.data, depth + 1, seen);
    if (found) return found;
  }

  for (const key of ['note_card', 'note', 'note_detail', 'note_info', 'item', 'data', 'result', 'items', 'note_list']) {
    if (value[key] != null) {
      const found = deepFindXhsNote(value[key], depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

function isNestedApiEnvelope(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (hasXhsNoteFields(obj)) return false;
  if (!('data' in obj)) return false;
  return 'code' in obj || 'success' in obj || 'msg' in obj || 'debug_id' in obj;
}

function isApiFailureEnvelope(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.success === false) return true;
  const code = Number(obj.code);
  return Number.isFinite(code) && code !== 0 && code !== 200;
}

function readApiEnvelopeError(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return '';
  if (isApiFailureEnvelope(obj)) return text(obj.msg || obj.message || obj.message_zh, 240);
  if (obj.data != null) {
    const inner = parseMaybeJson(obj.data);
    if (inner && typeof inner === 'object') {
      const nested = readApiEnvelopeError(inner, depth + 1);
      if (nested) return nested;
    }
  }
  return '';
}

/** TikHub ResponseModel 的 data 字段经常是 JSON 字符串；小红书网关还会再包一层 code/data/success/msg。 */
function unwrapTikhubData(raw, depth = 0) {
  if (raw == null || depth > 8) return raw;
  let data = parseMaybeJson(raw);
  if (data == null) return data;
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    // 只有"长度为 1 的数组包了一层详情"才继续往里展开；真正的多条列表（搜索结果等）原样返回，
    // 避免被贪心地坍缩成第一条，导致列表类接口拿不到剩下的结果。
    if (data.length === 1) return unwrapTikhubData(data[0], depth);
    return data;
  }

  while (isNestedApiEnvelope(data) && depth <= 8) {
    if (isApiFailureEnvelope(data)) {
      const errMsg = text(data.msg || data.message, 240);
      if (errMsg) throw new Error(`小红书接口返回错误：${errMsg}`);
    }
    if (data.data == null) break;
    data = unwrapTikhubData(data.data, depth + 1);
    depth += 1;
    if (data == null || typeof data !== 'object') return data;
    if (!Array.isArray(data) && hasXhsNoteFields(data)) return data;
  }

  if (!Array.isArray(data) && hasXhsNoteFields(data)) return data;

  const deep = deepFindXhsNote(data);
  if (deep) return deep;

  if (data.data != null) {
    const inner = unwrapTikhubData(data.data, depth + 1);
    if (inner && typeof inner === 'object' && hasXhsNoteFields(inner)) return inner;
  }
  if (data.result != null) {
    const inner = unwrapTikhubData(data.result, depth + 1);
    if (inner && typeof inner === 'object' && hasXhsNoteFields(inner)) return inner;
  }
  return data;
}

function resolveWorkerProxyPath(path = '') {
  return resolveSocialWorkerUrl(path);
}

async function tikhubFetch(apiKey, path, params = {}) {
  const queryParams = {};
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') queryParams[key] = String(value);
  });
  const res = await socialWorkerFetch(resolveWorkerProxyPath(TIKHUB_PROXY_PATH), {
    method: 'POST',
    headers: {
      'X-TikHub-Key': String(apiKey || '').trim(),
      'Content-Type': 'application/json',
    },
    body: { path, params: queryParams },
  });
  if (!res.ok) {
    const error = new Error(await readProxyErrorText(res, 'TikHub 代理请求'));
    error.status = res.status;
    throw error;
  }
  const payload = await res.json().catch(() => null);
  if (payload?.code != null && Number(payload.code) !== 200) {
    throw new Error(payload.message_zh || payload.message || `TikHub 返回错误（code ${payload.code}）`);
  }
  return unwrapTikhubData(payload?.data);
}

async function resolveShortLink(url) {
  const res = await socialWorkerFetch(`${resolveWorkerProxyPath(REDIRECT_PROXY_PATH)}?url=${encodeURIComponent(url)}`, {
    method: 'GET',
  });
  if (!res.ok) {
    throw new Error(await readProxyErrorText(res, '社媒短链解析'));
  }
  const payload = await res.json().catch(() => null);
  if (!payload?.ok) throw new Error(payload?.error || '短链解析失败。');
  return payload.url || '';
}

/** 打开分享链接前解析 t.cn / xhslink 短链（网页端无法直接跟跳）。 */
export async function resolveSocialOpenUrl(url = '') {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch (_) {
    return raw;
  }
  if (host === 't.cn' || host === 'xhslink.com' || host === 'xhslink.cn') {
    try {
      const resolved = await resolveShortLink(raw);
      return resolved || raw;
    } catch (_) {
      return raw;
    }
  }
  return raw;
}

function unwrapXhsItem(data) {
  const root = unwrapTikhubData(data);
  const fromList = pickXhsListEntry(root?.note_list) || pickXhsListEntry(root?.items);
  if (fromList) return fromList;

  const deep = deepFindXhsNote(root);
  if (deep) return deep.note_card && typeof deep.note_card === 'object' ? deep.note_card : deep;

  const base = Array.isArray(root) ? (root[0] || {}) : (root || {});
  const candidates = [
    base?.note_card,
    base,
    root?.note_detail,
    root?.note_info,
    root?.note,
  ].filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  return candidates.find((item) => hasXhsNoteFields(item)) || candidates[0] || {};
}

function hasXhsNoteData(data) {
  const item = unwrapXhsItem(data);
  const card = item.note_card || item;
  return !!(
    text(card.desc, 20)
    || text(card.title, 8)
    || text(item.desc, 20)
    || (Array.isArray(card.image_list) && card.image_list.length)
    || card.cover
    || card.video?.cover
  );
}

function pickXhsImageUrl(image = {}) {
  if (typeof image === 'string') return image;
  return image?.url_default || image?.url || image?.info_list?.[0]?.url || image?.url_pre || image?.original || '';
}

function collectXhsImages(card = {}, item = {}) {
  const list = [
    ...(Array.isArray(card.image_list) ? card.image_list : []),
    ...(Array.isArray(card.images_list) ? card.images_list : []),
    ...(Array.isArray(card.images) ? card.images : []),
    ...(Array.isArray(card.pics) ? card.pics : []),
    ...(Array.isArray(item.image_list) ? item.image_list : []),
    ...(Array.isArray(item.images) ? item.images : []),
  ];
  const images = list.map(pickXhsImageUrl).filter(Boolean);
  const coverCandidates = [
    card.cover,
    card.cover_image,
    card.video?.cover,
    card.video?.cover_url,
    card.video_info?.image,
    card.video_info?.first_frame,
    item.cover,
    item.cover_image,
  ];
  coverCandidates.forEach((c) => {
    const url = pickXhsImageUrl(c);
    if (url && !images.includes(url)) images.unshift(url);
  });
  return images;
}

function collectXhsTags(card = {}) {
  const raw = [
    ...(Array.isArray(card.tag_list) ? card.tag_list : []),
    ...(Array.isArray(card.hash_tag) ? card.hash_tag : []),
    ...(Array.isArray(card.topics) ? card.topics : []),
  ];
  const tags = [];
  const seen = new Set();
  raw.forEach((t) => {
    const name = text(stripXhsTopicMarker(typeof t === 'string' ? t : (t?.name || t?.tag_name || t?.id || '')), 32).replace(/^#+/, '');
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(name);
  });
  return tags;
}

// 小红书正文里的话题标签自带一个固定后缀标记，例如 "#甜品[话题]# #探店[话题]#"——
// "[话题]" 只是平台自己贴的标记，不是真正的标签文案。这里提前去掉，让正文里的话题
// 变回普通的 "#甜品#" 形态，后续提取/剔除 # 标签才能正常按 tag 名匹配，不会剩下一串
// 光秃秃的 "[话题]#" 挂在正文末尾。
function stripXhsTopicMarker(value = '') {
  return String(value || '').replace(/\[话题\]/g, '');
}

function normalizeXhsNote(data, url) {
  const root = unwrapTikhubData(data);
  const item = unwrapXhsItem(data);
  const card = item.note_card || item || {};
  const images = collectXhsImages(card, item);
  const interact = card.interact_info || item.interact_info || card || item || {};
  const desc = text(stripXhsTopicMarker(card.desc || item.desc || card.content || item.content || card.note_desc || card.text || item.text || ''), 2000);
  const rawTitle = text(card.title || item.title || card.display_title || item.display_title || '', 120);
  const title = rawTitle && rawTitle !== desc && !(desc && desc.startsWith(rawTitle) && rawTitle.length >= Math.min(24, desc.length * 0.85))
    ? rawTitle
    : '';
  const tags = collectXhsTags(card);
  const rootUser = root && typeof root === 'object' && !Array.isArray(root) ? root.user : null;
  return {
    platform: 'xiaohongshu',
    noteId: String(card.note_id || item.note_id || item.id || card.id || '').trim(),
    title,
    desc,
    images,
    cover: images[0] || pickXhsImageUrl(card.cover || item.cover || card.cover_image || item.cover_image),
    author: {
      name: text(card.user?.nickname || item.user?.nickname || rootUser?.nickname, 40),
      avatar: text(card.user?.avatar || card.user?.image || item.user?.avatar || item.user?.image || rootUser?.avatar || rootUser?.image, 500),
      // 小红书号跟昵称是两回事，各种接口字段名不统一，多个候选一起收，供跟用户资料里填的号核对。
      redId: text(card.user?.red_id || card.user?.redId || item.user?.red_id || rootUser?.red_id, 40),
      userId: text(card.user?.user_id || card.user?.userid || card.user?.id || item.user?.user_id || item.user?.userid || rootUser?.user_id || rootUser?.id, 60),
    },
    stats: {
      like: Number(interact.liked_count || interact.like_count || card.liked_count || item.liked_count) || 0,
      collect: Number(interact.collected_count || interact.collect_count || card.collected_count || item.collected_count) || 0,
      comment: Number(interact.comment_count || interact.comments_count || card.comments_count || item.comments_count) || 0,
      share: Number(interact.share_count || card.share_count || item.share_count) || 0,
    },
    tags,
    url,
    comments: [],
  };
}

function describeXhsPayloadShape(data) {
  const root = unwrapTikhubData(data);
  if (root == null) return 'data 为空';
  if (typeof root !== 'object') return `data 类型：${typeof root}`;
  if (Array.isArray(root)) {
    const first = root[0];
    const firstKeys = first && typeof first === 'object' && !Array.isArray(first)
      ? Object.keys(first).slice(0, 8).join('、')
      : String(first ?? '').slice(0, 40);
    return `数组长度 ${root.length}；首项：${firstKeys || '无'}`;
  }
  if (Array.isArray(root.note_list) && root.note_list.length) {
    const first = root.note_list[0];
    const firstKeys = first && typeof first === 'object'
      ? Object.keys(first.note_card && typeof first.note_card === 'object' ? first.note_card : first).slice(0, 10).join('、')
      : '无';
    return `note_list ${root.note_list.length} 条；首条字段：${firstKeys}`;
  }
  const topKeys = Object.keys(root).slice(0, 10).join('、') || '无';
  const item = unwrapXhsItem(root);
  const noteKeys = item && typeof item === 'object' && !Array.isArray(item)
    ? Object.keys(item).slice(0, 10).join('、')
    : '无';
  return `顶层：${topKeys}；笔记：${noteKeys}`;
}

function normalizeXhsComments(data) {
  const root = unwrapTikhubData(data);
  const list = root?.comments || root?.data?.comments || root?.list || [];
  return (Array.isArray(list) ? list : [])
    .map((c) => ({
      author: text(c?.user_info?.nickname || c?.user?.nickname || c?.nickname, 40),
      text: text(c?.content || c?.text, 200),
      likeCount: Number(c?.like_count || c?.liked_count || 0) || 0,
    }))
    .filter((c) => c.text);
}

/**
 * 小红书关键词搜笔记（供兴趣搜索编排用）：走 TikHub search_notes，只取预览级字段
 * （标题/摘要/作者/热度），不拉正文——预览信息足够撑「刷到了什么」，要深入再用 fetchXhsNoteRaw。
 * 返回 [] 表示没搜到或字段没识别出来；接口报错会抛出。
 */
function mapXhsSearchEntry(entry) {
  const item = entry && typeof entry === 'object' ? entry : {};
  const card = item.note_card && typeof item.note_card === 'object' ? item.note_card : item;
  const nested = item.note && typeof item.note === 'object' ? item.note : null;
  const noteCard = nested?.note_card && typeof nested.note_card === 'object' ? nested.note_card : (nested || card);
  const title = text(
    noteCard.display_title || noteCard.title || item.display_title || item.title || nested?.title,
    120,
  );
  const desc = text(noteCard.desc || item.desc || nested?.desc || '', 300);
  if (!title && !desc) return null;
  const noteId = String(
    noteCard.note_id || noteCard.id || item.note_id || item.id || nested?.note_id || nested?.id || '',
  ).trim();
  const xsecToken = text(noteCard.xsec_token || item.xsec_token || nested?.xsec_token || '', 200);
  const url = noteId
    ? `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_search` : ''}`
    : '';
  return {
    noteId,
    title,
    desc,
    url,
    xsecToken,
    cover: pickXhsImageUrl(noteCard.cover || item.cover || nested?.cover || ''),
    author: text(noteCard.user?.nickname || item.user?.nickname || nested?.user?.nickname, 40),
    likeCount: Number(
      noteCard.interact_info?.liked_count || noteCard.liked_count || item.liked_count || item.like_count,
    ) || 0,
  };
}

export async function searchXiaohongshuNotes(keyword, { apiKey, page = 1, limit = 6 } = {}) {
  const kw = text(keyword, 60);
  if (!kw || !apiKey) return [];
  const data = await tikhubFetch(apiKey, '/api/v1/xiaohongshu/app_v2/search_notes', {
    keyword: kw,
    page: Math.max(1, Number(page) || 1),
  });
  const root = unwrapTikhubData(data);
  const rawList = (Array.isArray(root?.note_list) && root.note_list)
    || (Array.isArray(root?.items) && root.items)
    || (Array.isArray(root?.data?.items) && root.data.items)
    || (Array.isArray(root?.data?.note_list) && root.data.note_list)
    || (Array.isArray(root) && root)
    || [];
  return rawList
    .map((entry) => mapXhsSearchEntry(entry))
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit) || 6));
}

/**
 * 抓「用户自己主页」发布的笔记列表（不是关键词搜索）：用于「TA 关注你的小红书」——
 * 用户自愿粘贴自己的主页分享链接，供角色定期看一眼你发了什么。
 * profileInput 接受完整分享链接/App 分享文案/纯网页 URL；短链先展开后优先传 user_id。
 */
export async function fetchXiaohongshuUserNotes(profileInput, { apiKey, cursor = '', limit = 10 } = {}) {
  if (!apiKey) return { notes: [], cursor: '', hasMore: false };
  const lookupParams = await prepareXiaohongshuUserLookupParams(profileInput);
  if (!lookupParams) return { notes: [], cursor: '', hasMore: false };
  const data = await tikhubFetch(apiKey, '/api/v1/xiaohongshu/app_v2/get_user_posted_notes', {
    ...lookupParams,
    cursor,
  });
  const root = unwrapTikhubData(data);
  const rawList = (Array.isArray(root?.notes) && root.notes)
    || (Array.isArray(root?.data?.notes) && root.data.notes)
    || (Array.isArray(root) && root)
    || [];
  const notes = rawList
    .map((entry) => {
      const item = entry && typeof entry === 'object' ? entry : {};
      const card = item.note_card && typeof item.note_card === 'object' ? item.note_card : item;
      const noteId = String(card.note_id || item.note_id || item.id || '').trim();
      const title = text(card.display_title || card.title || item.display_title || item.title, 120);
      const desc = text(card.desc || item.desc || '', 300);
      if (!noteId) return null;
      const xsecToken = text(card.xsec_token || item.xsec_token || '', 200);
      const url = `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_note` : ''}`;
      // 置顶标记的字段名各版本接口不统一，多个候选一起收；识别不出也不致命，
      // 消费方还会按 createdAt 排序兜底（置顶通常是旧帖，时间排序自然沉底）
      const pinned = [card.sticky, item.sticky, card.is_top, item.is_top, card.top, item.top, card.pinned, item.pinned]
        .some((v) => v === true || v === 1 || v === '1');
      return {
        noteId,
        title,
        desc,
        url,
        pinned,
        cover: pickXhsImageUrl(card.cover || item.cover || ''),
        likeCount: Number(card.interact_info?.liked_count || card.liked_count || item.liked_count) || 0,
        createdAt: Number(card.time || item.time || 0) || 0,
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit) || 10));
  const nextCursor = text(root?.cursor || root?.data?.cursor || '', 60);
  const hasMore = root?.has_more === true || root?.data?.has_more === true;
  return { notes, cursor: nextCursor, hasMore };
}

/** 只调图文详情接口一次：标题/正文/封面/tag 都在 note_card 里，没有单独的「正文接口」。
 *  不再兜底 get_video_note_detail（AI 看不了视频，多调一次只多扣费）。 */
async function fetchXhsNoteRaw(apiKey, url, shareText = url) {
  const params = await prepareXiaohongshuLookupParams(url, shareText);
  const data = await tikhubFetch(apiKey, '/api/v1/xiaohongshu/app_v2/get_image_note_detail', params);
  const preview = normalizeXhsNote(data, url);
  if (!(preview.desc || preview.cover || preview.title || preview.images?.length)) {
    const apiErr = readApiEnvelopeError(data);
    if (apiErr) throw new Error(`小红书笔记解析失败：${apiErr}`);
    throw new Error(`小红书笔记解析失败：接口已返回但未识别到标题/正文/封面（${describeXhsPayloadShape(data)}）。`);
  }
  return data;
}

async function resolveXiaohongshu(url, { apiKey, shareText, includeComments = false, commentCount = 3 }) {
  const data = await fetchXhsNoteRaw(apiKey, url, shareText || url);
  const note = normalizeXhsNote(data, url);
  if (includeComments && commentCount > 0 && note.noteId) {
    try {
      const cdata = await tikhubFetch(apiKey, '/api/v1/xiaohongshu/app_v2/get_note_comments', {
        note_id: note.noteId,
        sort_strategy: 'like_count',
      });
      note.comments = normalizeXhsComments(cdata).slice(0, commentCount);
    } catch (_) {
      note.comments = [];
    }
  }
  return note;
}

/**
 * 供「分享真实帖子精搜」用：从 searchXiaohongshuNotes 拿到的 noteId 直接取正文详情（可选带评论区）。
 * noteId 拼成标准笔记链接（xiaohongshu.com/explore/id）去查，不需要用户提供分享文案。
 * xsecToken 是搜索列表阶段就拿到的安全令牌：带上它拼进最终 url，分享给用户点开时才不容易
 * 被小红书要求登录/跳中间页——这是「搜索返回的链接要跳好几轮才能看」的关键修复点。
 */
export async function fetchXiaohongshuNoteDetail(noteId, {
  apiKey, includeComments = false, commentCount = 3, refresh = false, cacheDays = DEFAULT_CACHE_DAYS, xsecToken = '',
} = {}) {
  const id = text(noteId, 40);
  if (!id || !apiKey) return null;
  const token = text(xsecToken, 200);
  const url = `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search` : ''}`;
  return resolveSocialLinkCached(url, { enabled: true, apiKey, cacheDays }, {
    refresh,
    includeComments,
    commentCount,
    shareText: url,
  });
}

function extractWeiboStatusId(url = '') {
  try {
    const u = new URL(url);
    for (const key of ['id', 'mid', 'status_id', 'post_id']) {
      const val = String(u.searchParams.get(key) || '').trim();
      if (/^\d{10,20}$/.test(val) || /^[A-Za-z0-9]{6,16}$/.test(val)) return val;
    }
    const parts = u.pathname.split('/').filter(Boolean)
      .filter((part) => !/^(u|n|profile|status|detail|weibo|tv|show|p|feed)$/i.test(part));
    const numericParts = parts.filter((part) => /^\d{10,20}$/.test(part));
    if (numericParts.length >= 2) return numericParts[numericParts.length - 1];
    if (numericParts.length === 1) return numericParts[0];
    const last = parts[parts.length - 1] || '';
    if (/^\d{10,20}$/.test(last)) return last;
    if (/^[A-Za-z0-9]{6,16}$/.test(last)) return last;
  } catch (_) {
    // ignore
  }
  return '';
}

function hasWeiboStatusFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return !!(
    text(obj.text_raw || obj.text, 4)
    || (Array.isArray(obj.pics) && obj.pics.length)
    || (obj.pic_infos && typeof obj.pic_infos === 'object' && Object.keys(obj.pic_infos).length)
  );
}

function unwrapWeiboStatus(data) {
  const root = unwrapTikhubData(data);
  const candidates = [
    root?.status,
    root?.data?.status,
    root?.data,
    root?.mblog,
    root?.post,
    root,
  ];
  for (const item of candidates) {
    if (item && typeof item === 'object' && !Array.isArray(item) && hasWeiboStatusFields(item)) return item;
  }
  return root?.status || root?.data || root || {};
}

function normalizeWeiboImageUrl(url = '') {
  let raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!/^https?:\/\//i.test(raw)) return '';
  raw = raw.replace(/^http:/i, 'https:');
  raw = raw.replace(/\/(thumbnail|square|bmiddle|mw\d+|orj\d+|small|woriginal)\//gi, '/large/');
  return raw;
}

function pickWeiboPicUrl(pic) {
  if (typeof pic === 'string') return normalizeWeiboImageUrl(pic);
  if (!pic || typeof pic !== 'object') return '';
  const candidates = [
    pic?.largest?.url,
    pic?.original?.url,
    pic?.large?.url,
    pic?.bmiddle?.url,
    pic?.url,
    pic?.largeUrl,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWeiboImageUrl(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function collectWeiboImages(status = {}) {
  const fromPics = (Array.isArray(status.pics) ? status.pics : [])
    .map(pickWeiboPicUrl)
    .filter(Boolean);
  if (fromPics.length) return fromPics;

  if (status.pic_infos && typeof status.pic_infos === 'object') {
    const fromInfos = Object.values(status.pic_infos).map(pickWeiboPicUrl).filter(Boolean);
    if (fromInfos.length) return fromInfos;
  }

  if (Array.isArray(status.pic_ids) && status.pic_infos) {
    const fromIds = status.pic_ids
      .map((id) => pickWeiboPicUrl(status.pic_infos?.[id]))
      .filter(Boolean);
    if (fromIds.length) return fromIds;
  }

  if (status.page_info?.page_pic?.url) {
    const cover = normalizeWeiboImageUrl(status.page_info.page_pic.url);
    if (cover) return [cover];
  }
  return [];
}

function isWeiboShortLink(url = '') {
  try {
    return /(^|\.)t\.cn$/i.test(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

function normalizeWeiboStatus(data, url) {
  const status = unwrapWeiboStatus(data);
  const images = collectWeiboImages(status);
  const desc = text(stripHtml(status.text_raw || status.text || status.raw_text || ''), 2000);
  return {
    platform: 'weibo',
    statusId: String(status.mblogid || status.id || status.mid || status.idstr || '').trim(),
    title: '',
    desc,
    images,
    cover: images[0] || '',
    author: {
      name: text(status.user?.screen_name || status.user?.name, 40),
      avatar: text(status.user?.profile_image_url || status.user?.avatar_hd || status.user?.avatar, 500),
      userId: text(status.user?.id || status.user?.idstr || status.user?.uid, 40),
    },
    stats: {
      like: Number(status.attitudes_count || status.attitudes_num) || 0,
      comment: Number(status.comments_count || status.comments_num) || 0,
      share: Number(status.reposts_count || status.reposts_num) || 0,
    },
    tags: [],
    url,
    comments: [],
  };
}

function normalizeWeiboComments(data) {
  const root = unwrapTikhubData(data);
  const list = root?.data || root?.comments || root?.list || [];
  return (Array.isArray(list) ? list : [])
    .map((c) => ({
      author: text(c?.user?.screen_name, 40),
      text: text(stripHtml(c?.text_raw || c?.text || ''), 200),
      likeCount: Number(c?.like_counts || c?.like_count || 0) || 0,
    }))
    .filter((c) => c.text);
}

async function fetchWeiboStatusRaw(apiKey, url) {
  let targetUrl = url;
  let statusId = extractWeiboStatusId(targetUrl);
  if (!statusId && isWeiboShortLink(targetUrl)) {
    const expanded = await resolveShortLink(targetUrl).catch(() => '');
    if (expanded) {
      targetUrl = expanded;
      statusId = extractWeiboStatusId(expanded);
    }
  }
  if (!statusId) throw new Error('无法从链接中识别微博 ID。');

  const attempts = [
    () => tikhubFetch(apiKey, '/api/v1/weibo/app/fetch_status_detail', { status_id: statusId }),
    () => tikhubFetch(apiKey, '/api/v1/weibo/web/fetch_post_detail', { post_id: statusId }),
    () => tikhubFetch(apiKey, '/api/v1/weibo/web_v2/fetch_post_detail', { id: statusId, is_get_long_text: '1' }),
  ];

  let lastErr = null;
  let lastData = null;
  for (const run of attempts) {
    try {
      const data = await run();
      const preview = normalizeWeiboStatus(data, targetUrl);
      if (preview.desc || preview.cover || preview.images?.length) {
        return { data, statusId, url: targetUrl };
      }
      lastData = data;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastData) {
    const apiErr = readApiEnvelopeError(lastData);
    if (apiErr) throw new Error(`微博解析失败：${apiErr}`);
  }
  throw lastErr || new Error('微博解析失败：接口已返回但未识别到正文或配图。');
}

async function resolveWeibo(url, { apiKey, includeComments = false, commentCount = 3 }) {
  const { data, statusId, url: resolvedUrl } = await fetchWeiboStatusRaw(apiKey, url);
  const status = normalizeWeiboStatus(data, resolvedUrl || url);
  if (includeComments && commentCount > 0 && statusId) {
    try {
      const cdata = await tikhubFetch(apiKey, '/api/v1/weibo/app/fetch_status_comments', { status_id: statusId, sort_type: 0 });
      status.comments = normalizeWeiboComments(cdata).slice(0, commentCount);
    } catch (_) {
      status.comments = [];
    }
  }
  return status;
}

/** 命中小红书/微博才会真正发请求，其余平台返回 null。 */
export async function resolveSocialLink(url, options = {}) {
  const platform = detectLinkPlatform(url);
  if (!platform) return null;
  if (!options?.apiKey) return null;
  const shareText = options.shareText || url;
  if (platform.id === 'xiaohongshu') return resolveXiaohongshu(url, { ...options, shareText });
  if (platform.id === 'weibo') return resolveWeibo(url, options);
  return null;
}

async function loadResolveCache() {
  const row = await db.get('settings', SOCIAL_LINK_CACHE_KEY);
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  const version = Number(value.version || 0);
  if (version !== CACHE_VERSION) return { items: {} };
  return { items: value.items && typeof value.items === 'object' ? value.items : {} };
}

async function saveResolveCache(cache) {
  const existing = await loadResolveCache().catch(() => ({ items: {} }));
  const mergedItems = { ...(existing.items || {}), ...(cache.items || {}) };
  const entries = Object.entries(mergedItems)
    .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
    .slice(0, MAX_CACHE_ITEMS);
  await db.put('settings', {
    key: SOCIAL_LINK_CACHE_KEY,
    value: { version: CACHE_VERSION, items: Object.fromEntries(entries) },
  });
}

function cacheEntryMatchesRequest(entry, url) {
  if (!entry) return false;
  const urlKey = socialCacheKey(url);
  const entryUrlKey = socialCacheKey(entry.requestUrl || entry.data?.url || '');
  return !!entryUrlKey && !!urlKey && entryUrlKey === urlKey;
}

async function readSocialResolveCache(url, ttlMs) {
  const urlKey = socialCacheKey(url);
  if (!urlKey) return null;
  const cache = await loadResolveCache().catch(() => ({ items: {} }));
  const cached = cache.items?.[urlKey];
  if (!cached || Date.now() - Number(cached.updatedAt || 0) >= ttlMs) return null;
  if (!cacheEntryMatchesRequest(cached, url)) return null;
  const data = cached.data && typeof cached.data === 'object' ? { ...cached.data } : cached.data;
  if (data && !data.descFull && data.desc) data.descFull = data.desc;
  return data;
}

async function writeSocialResolveCache(url, data) {
  const urlKey = socialCacheKey(url);
  if (!urlKey || !data) return;
  const cache = await loadResolveCache().catch(() => ({ items: {} }));
  cache.items = {
    ...(cache.items || {}),
    [urlKey]: {
      data,
      requestUrl: urlKey,
      noteId: data.noteId || data.statusId || data.bvid || '',
      updatedAt: Date.now(),
    },
  };
  await saveResolveCache(cache).catch(() => {});
}

/** 只读社媒解析缓存（精搜/看主页写入，聊天分享链接读取）。 */
export async function getSocialLinkResolveCached(url, config = {}) {
  return readSocialResolveCache(url, cacheTtlMs(config));
}

/** 供 link-card-enhancer 调用：带缓存的解析入口，未命中平台/未开启/没填 Key 都直接返回 null。 */
export async function resolveSocialLinkCached(url, config = {}, options = {}) {
  const platform = detectLinkPlatform(url);
  if (!platform || !['xiaohongshu', 'weibo'].includes(platform.id)) return null;
  if (!config?.enabled || !config?.apiKey) return null;

  const urlKey = socialCacheKey(url);
  const shareText = buildTikhubShareInput(options.shareText || url, url);
  const requestKey = urlKey;
  const ttlMs = cacheTtlMs(config);

  if (!options.refresh) {
    const cached = await readSocialResolveCache(url, ttlMs);
    if (cached) return cached;
  }

  if (inflightResolve.has(requestKey)) return inflightResolve.get(requestKey);

  const task = (async () => {
    const data = await resolveSocialLink(url, {
      apiKey: config.apiKey,
      shareText,
      includeComments: options.includeComments === true,
      commentCount: Number(options.commentCount ?? 3),
    });
    if (data) await writeSocialResolveCache(url, data);
    return data;
  })().finally(() => {
    inflightResolve.delete(requestKey);
  });

  inflightResolve.set(requestKey, task);
  return task;
}

/** 设置页“测试”按钮用：解析一次；成功结果写入缓存，聊天里同链接不再重复扣费。 */
export async function testSocialLinkResolve(url, config = {}, options = {}) {
  const ttlMs = cacheTtlMs(config);
  const shareText = buildTikhubShareInput(options.shareText || url, url);
  if (!options.refresh) {
    const hit = await readSocialResolveCache(url, ttlMs);
    if (hit) return { ok: true, data: hit, cached: true };
  }
  const platform = detectLinkPlatform(url);
  if (!platform || !['xiaohongshu', 'weibo'].includes(platform.id)) {
    return { ok: false, error: '这个链接不是可识别的小红书或微博链接（支持 xiaohongshu.com / xhslink.com / xhslink.cn / weibo）。' };
  }
  if (!config?.apiKey) {
    return { ok: false, error: '还没填写 TikHub API Key。' };
  }
  try {
    const data = await resolveSocialLink(url, {
      apiKey: config.apiKey,
      shareText,
      includeComments: options.includeComments === true,
      commentCount: Number(options.commentCount ?? 3),
    });
    if (!data) return { ok: false, error: '解析未返回内容。' };
    await writeSocialResolveCache(url, data);
    return { ok: true, data, cached: false };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err || '解析失败'),
      status: Number(err?.status || 0) || null,
    };
  }
}

/**
 * 微博关键词搜（供兴趣搜索编排/分享帖精搜用）：走 TikHub fetch_search，只取预览级字段
 * （正文摘要/作者/热度），不拉全文——预览信息足够撑「刷到了什么」，要深入再取详情。
 * searchType 默认 1（综合，按相关性）；timeScope 默认 month，兼顾时效又不会太窄搜不到东西。
 */
export async function searchWeiboPosts(keyword, {
  apiKey, page = 1, searchType = 1, timeScope = 'month', limit = 8,
} = {}) {
  const kw = text(keyword, 60);
  if (!kw || !apiKey) return [];
  const data = await tikhubFetch(apiKey, '/api/v1/weibo/web/fetch_search', {
    keyword: kw,
    page: Math.max(1, Number(page) || 1),
    search_type: searchType,
    time_scope: timeScope || undefined,
  });
  const root = unwrapTikhubData(data);
  return normalizeWeiboSearchData(root, limit);
}

/**
 * 微博游客搜索会按账号/机房返回 cards、card_group、statuses 等不同壳。
 * 不按固定路径取第一层，而是只递归收集真正同时带「微博编号 + 正文」的对象。
 */
export function normalizeWeiboSearchData(root, limit = 8) {
  const posts = [];
  const seenObjects = new WeakSet();
  const seenIds = new Set();
  const visit = (value, depth = 0) => {
    const obj = parseMaybeJson(value);
    if (!obj || typeof obj !== 'object' || depth > 12 || seenObjects.has(obj)) return;
    seenObjects.add(obj);
    if (Array.isArray(obj)) {
      obj.forEach((item) => visit(item, depth + 1));
      return;
    }

    const item = obj.mblog && typeof obj.mblog === 'object' ? obj.mblog : obj;
    const body = text(stripHtml(item.text_raw || item.text || item.raw_text || item.content || ''), 300);
    const mid = String(item.mid || item.idstr || item.status_id || item.id || '').trim();
    if (mid && body && !seenIds.has(mid)) {
      seenIds.add(mid);
      posts.push({
        mid,
        text: body,
        url: `https://m.weibo.cn/detail/${encodeURIComponent(mid)}`,
        author: text(item.user?.screen_name || item.user?.name || item.author?.name, 40),
        likeCount: Number(item.attitudes_count || item.like_count || item.likes_count || 0) || 0,
        createdAt: text(item.created_at || item.createdAt || '', 40),
      });
    }

    // mblog 已在上面归一化；其余字段仍要继续找 card_group / statuses / items 等嵌套结果。
    Object.values(obj).forEach((child) => {
      if (child !== obj.mblog) visit(child, depth + 1);
    });
  };
  visit(root);
  return posts.slice(0, Math.max(1, Number(limit) || 8));
}

/** 供「分享真实帖子精搜」用：从搜索结果的 mid 直接取正文详情（可选带评论区）。 */
export async function fetchWeiboStatusDetailById(mid, {
  apiKey, includeComments = false, commentCount = 3, refresh = false, cacheDays = DEFAULT_CACHE_DAYS,
} = {}) {
  const id = text(mid, 40);
  if (!id || !apiKey) return null;
  const url = `https://m.weibo.cn/detail/${encodeURIComponent(id)}`;
  return resolveSocialLinkCached(url, { enabled: true, apiKey, cacheDays }, {
    refresh,
    includeComments,
    commentCount,
    shareText: url,
  });
}

function stripBilibiliHighlight(value = '') {
  return text(String(value || '').replace(/<[^>]+>/g, ''), 300);
}

/**
 * B 站关键词搜视频（供兴趣搜索编排/分享帖精搜用）：只取标题/简介/UP主/播放量，
 * 不涉及视频内容本身的转写（AI 看不了视频，标题+简介+评论区已经是重点）。
 * order 默认 1（最新发布），偏向拿到时效更新的内容。
 */
export async function searchBilibiliVideos(keyword, {
  apiKey, cursor = '', order = 1, limit = 8, onDiagnostic = null,
} = {}) {
  const kw = text(keyword, 60);
  if (!kw || !apiKey) return [];
  const data = await tikhubFetch(apiKey, '/api/v1/bilibili/app/fetch_search_by_type', {
    keyword: kw,
    search_type: 'video',
    order,
    cursor: text(cursor, 300) || undefined,
    page_size: Math.max(1, Math.min(20, Number(limit) || 8)),
  });
  const root = unwrapTikhubData(data);
  const videos = normalizeBilibiliSearchData(root, limit);
  if (typeof onDiagnostic === 'function') onDiagnostic(summarizeBilibiliSearchPayload(root, videos));
  return videos;
}

/**
 * B 站搜索空回的脱敏诊断摘要：只保留响应形状、首个疑似候选的字段名和少量标识，
 * 不保存 TikHub Key，也不把整包标题/正文落进调用日志。
 */
export function summarizeBilibiliSearchPayload(root, videos = []) {
  const parsedRoot = parseMaybeJson(root);
  if (parsedRoot == null) return 'TikHub 200；data=null';
  if (typeof parsedRoot !== 'object') {
    return `TikHub 200；data=${typeof parsedRoot}(${text(parsedRoot, 80) || '空'})`;
  }

  const arrays = [];
  const candidates = [];
  const seen = new WeakSet();
  const visit = (value, path = '$', depth = 0) => {
    const obj = parseMaybeJson(value);
    if (!obj || typeof obj !== 'object' || depth > 8 || seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) {
      if (arrays.length < 5) arrays.push(`${path}(${obj.length})`);
      obj.slice(0, 3).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    const keys = Object.keys(obj);
    const score = (obj.bvid || obj.bv_id ? 8 : 0)
      + (obj.aid || obj.param || obj.id ? 3 : 0)
      + (obj.title || obj.name ? 4 : 0)
      + (obj.uri || obj.url || obj.arcurl ? 2 : 0)
      + (obj.goto || obj.type ? 1 : 0);
    if (score > 0) candidates.push({ obj, path, keys, score });
    Object.entries(obj).slice(0, 60).forEach(([key, child]) => visit(child, `${path}.${key}`, depth + 1));
  };
  visit(parsedRoot);

  const rootKeys = Array.isArray(parsedRoot) ? [] : Object.keys(parsedRoot).slice(0, 16);
  const best = candidates.sort((a, b) => b.score - a.score)[0] || null;
  const segments = [
    'TikHub 200',
    `data=${Array.isArray(parsedRoot) ? `array(${parsedRoot.length})` : `object keys=${rootKeys.join(',') || '空'}`}`,
  ];
  if (arrays.length) segments.push(`数组=${arrays.join(',')}`);
  if (best) {
    const item = best.obj.archive && typeof best.obj.archive === 'object' ? best.obj.archive : best.obj;
    const itemKeys = Object.keys(item).slice(0, 24);
    const idParts = [
      item.bvid ? `bvid=${text(item.bvid, 24)}` : '',
      item.bv_id ? `bv_id=${text(item.bv_id, 24)}` : '',
      item.aid != null ? `aid=${text(item.aid, 24)}` : '',
      item.param != null ? `param=${text(item.param, 24)}` : '',
      item.goto ? `goto=${text(item.goto, 20)}` : '',
      item.type ? `type=${text(item.type, 20)}` : '',
    ].filter(Boolean);
    segments.push(`疑似候选=${best.path}`);
    segments.push(`字段=${itemKeys.join(',') || '空'}`);
    if (idParts.length) segments.push(idParts.join(','));
    const sampleTitle = stripBilibiliHighlight(item.title || item.name || '');
    if (sampleTitle) segments.push(`标题样例=${text(sampleTitle, 48)}`);
    if (!text(item.bvid || item.bv_id, 24)
      && !/(?:\/video\/|bvid=)BV[a-zA-Z0-9]+/i.test(String(item.uri || item.url || item.arcurl || ''))
      && !/^BV[a-zA-Z0-9]+$/i.test(String(item.param || '').trim())) {
      segments.push('未识别原因=候选没有可识别的BV号');
    } else if (!sampleTitle) {
      segments.push('未识别原因=候选没有标题');
    }
  }
  if (Array.isArray(videos) && videos.length) segments.push(`已解析=${videos.length}条`);
  else if (!best) segments.push('未发现疑似视频候选对象');
  return segments.join('；').slice(0, 700);
}

/** 兼容 TikHub B站搜索的新 data.items 壳、旧 result/list 壳，以及 archive 嵌套条目。 */
export function normalizeBilibiliSearchData(root, limit = 8) {
  const videos = [];
  const seenObjects = new WeakSet();
  const seenIds = new Set();
  const visit = (value, depth = 0) => {
    const obj = parseMaybeJson(value);
    if (!obj || typeof obj !== 'object' || depth > 12 || seenObjects.has(obj)) return;
    seenObjects.add(obj);
    if (Array.isArray(obj)) {
      obj.forEach((item) => visit(item, depth + 1));
      return;
    }

    const item = obj.archive && typeof obj.archive === 'object' ? obj.archive : obj;
    const uri = text(item.uri || item.url || item.share_url || '', 500);
    const uriBvid = uri.match(/(?:\/video\/|bvid=)(BV[a-zA-Z0-9]+)/i)?.[1] || '';
    const paramBvid = /^BV[a-zA-Z0-9]+$/i.test(String(item.param || '').trim()) ? item.param : '';
    const bvid = text(item.bvid || item.bv_id || paramBvid || uriBvid, 20);
    const title = stripBilibiliHighlight(item.title || item.name || '');
    if (bvid && title && !seenIds.has(bvid)) {
      seenIds.add(bvid);
      videos.push({
        bvid,
        title,
        url: `https://www.bilibili.com/video/${bvid}`,
        desc: stripBilibiliHighlight(item.description || item.desc || item.intro || ''),
        author: text(item.author || item.up_name || item.owner?.name || item.upper?.name || '', 40),
        play: Number(item.play || item.play_count || item.stat?.view || 0) || 0,
        pubdate: Number(item.pubdate || item.senddate || item.pub_time || 0) || 0,
      });
    }

    Object.values(obj).forEach((child) => {
      if (child !== obj.archive) visit(child, depth + 1);
    });
  };
  visit(root);
  return videos.slice(0, Math.max(1, Number(limit) || 8));
}

/** 取单个视频详情：标题 + UP 主自己写的简介（不涉及视频内容转写）。 */
export async function fetchBilibiliVideoDetail(bvid, { apiKey } = {}) {
  const id = text(bvid, 20);
  if (!id || !apiKey) return null;
  const data = await tikhubFetch(apiKey, '/api/v1/bilibili/app/fetch_one_video', { bv_id: id });
  const root = unwrapTikhubData(data);
  const item = root?.View || root?.data?.View || root?.data || root || {};
  const title = stripBilibiliHighlight(item.title || '');
  if (!title) return null;
  const pic = text(item.pic || item.cover || '', 500);
  return {
    bvid: id,
    title,
    desc: text(item.desc || item.description || '', 800),
    author: text(item.owner?.name || item.author || '', 40),
    pubdate: Number(item.pubdate || 0) || 0,
    url: `https://www.bilibili.com/video/${id}`,
    cover: pic,
    images: pic ? [pic] : [],
    comments: [],
  };
}

export async function fetchBilibiliVideoComments(bvid, { apiKey, limit = 5 } = {}) {
  const id = text(bvid, 20);
  if (!id || !apiKey) return [];
  const data = await tikhubFetch(apiKey, '/api/v1/bilibili/app/fetch_video_comments', { bv_id: id, mode: 3 });
  const root = unwrapTikhubData(data);
  const rawList = (Array.isArray(root?.replies) && root.replies)
    || (Array.isArray(root?.data?.replies) && root.data.replies)
    || (Array.isArray(root) && root)
    || [];
  return rawList
    .map((c) => ({
      author: text(c?.member?.uname || c?.author || '', 40),
      text: text(c?.content?.message || c?.message || '', 200),
      likeCount: Number(c?.like || c?.like_count || 0) || 0,
    }))
    .filter((c) => c.text)
    .slice(0, Math.max(1, Number(limit) || 5));
}

/** 供「分享真实帖子精搜」用：标题 + UP 主简介 +（可选）热评一次取全。 */
export async function fetchBilibiliVideoWithComments(bvid, {
  apiKey, includeComments = false, commentCount = 5, refresh = false, cacheDays = DEFAULT_CACHE_DAYS,
} = {}) {
  const id = text(bvid, 20);
  if (!id || !apiKey) return null;
  const url = `https://www.bilibili.com/video/${id}`;
  const ttlMs = cacheTtlMs({ cacheDays });
  if (!refresh) {
    const cached = await readSocialResolveCache(url, ttlMs);
    if (cached && (!includeComments || (Array.isArray(cached.comments) && cached.comments.length))) {
      return cached;
    }
  }
  const detail = await fetchBilibiliVideoDetail(id, { apiKey });
  if (!detail) return null;
  detail.platform = detail.platform || 'bilibili';
  detail.comments = includeComments && commentCount > 0
    ? await fetchBilibiliVideoComments(id, { apiKey, limit: commentCount }).catch(() => [])
    : (Array.isArray(detail.comments) ? detail.comments : []);
  await writeSocialResolveCache(url, detail);
  return detail;
}
