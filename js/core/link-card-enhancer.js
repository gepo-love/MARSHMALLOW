import * as db from './db.js';
import { loadWebSearchConfig, tavilyExtract } from './web-search-tools.js';
import { loadImageToolConfig } from './image-generation-tools.js';
import { detectLinkPlatform, extractShareKeywords } from './link-platforms.js';
import { resolveSocialWorkerUrl, socialWorkerFetch } from './social-worker-client.js';
import { loadSocialLinkConfig } from './social-link-tools.js';
import {
  resolveSocialLinkCached,
  normalizeLinkCacheKey,
  getSocialLinkResolveCached,
  resolveSocialOpenUrl,
} from './social-link-resolver.js';
import { getCurrentUser } from './user-slot.js';
import { isWebSnapshotSupported, captureUrlSnapshot } from './native-web-snapshot.js';
import { showToast } from '../components/toast.js';

const SOCIAL_UNFURL_PATH = '/api/social/unfurl';

/** 剥离文本中的 markdown 链接语法：[文字](url) → 文字；整体是裸 url 时返回空串交给兜底 */
export function stripMarkdownLinkSyntax(text = '') {
  let s = String(text || '').trim();
  s = s.replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, '$1').trim();
  if (/^https?:\/\/\S+$/i.test(s)) return '';
  return s;
}

function workerProxyPath(path = '') {
  return resolveSocialWorkerUrl(path);
}

/** 社交正文清洗：比 cleanUsableText 宽松，避免误杀短正文；保留 descFull 供 AI 读全文。 */
function cleanSocialBodyText(value = '', max = 1200) {
  let raw = String(value || '');
  // 去掉正文里夹带的 markdown 图片语法：不只是 base64 内嵌图——B站简介等经常把封面图/
  // 活动素材图直接写成 ![](https://...) 塞在文字里，链接卡片本身已经有独立的封面图字段，
  // 这种嵌在正文里的图片语法只会在气泡里剩下一串"![]"和裸链接，不是真正想给用户看的文字。
  raw = raw.replace(/!\[[^\]]*\]\s*\(\s*[^)]*\)/g, ' ');
  raw = raw.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{40,}/gi, ' ');
  raw = raw.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!raw) return '';
  if (/;base64,|iVBORw0KG|\/9j\/4AAQSkZJRgABAQ/i.test(raw)) return '';
  return raw.slice(0, max);
}

function mergeSocialTags(resolved = {}, descFull = '', baseKeywords = []) {
  const fromApi = Array.isArray(resolved.tags) ? resolved.tags.filter(Boolean) : [];
  const fromDesc = extractShareKeywords(descFull, 8);
  const merged = [];
  const seen = new Set();
  [...fromApi, ...fromDesc, ...(Array.isArray(baseKeywords) ? baseKeywords : [])].forEach((tag) => {
    const clean = String(tag || '').replace(/^#+/, '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(clean);
  });
  return merged.slice(0, 8);
}

function pickSocialTitle(resolved = {}, base = {}, descFull = '') {
  const candidates = [resolved.title, base.title, base.linkTitle].map((v) => String(v || '').trim()).filter(Boolean);
  for (const raw of candidates) {
    if (!raw || raw === descFull || isLikelyShareMashTitle(raw, descFull)) continue;
    if (descFull && descFull.startsWith(raw) && raw.length >= Math.min(24, descFull.length * 0.85)) continue;
    const cleaned = cleanUsableText(raw, 90);
    if (cleaned) return cleaned;
  }
  return '';
}
const LINK_CARD_CACHE_KEY = 'webLinkCardCache';
const CACHE_VERSION = 1;
const MAX_CACHE_ITEMS = 200;

function text(value = '', max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isHttpUrl(value) {
  const raw = String(value || '').trim();
  if (/^https?:\/\//i.test(raw)) return true;
  if (raw.startsWith('//')) return true;
  return false;
}

export function normalizeExternalImageUrl(url = '') {
  // 动态 import 会拖慢卡片渲染；media-url 无依赖，这里内联同等升级逻辑并保留微博尺寸规范化。
  let raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!/^https?:\/\//i.test(raw)) return '';
  if (/^http:\/\//i.test(raw)) raw = `https://${raw.slice(7)}`;
  if (/sinaimg\.cn/i.test(raw)) {
    raw = raw.replace(/\/(thumbnail|square|bmiddle|mw\d+|orj\d+|small|woriginal)\//gi, '/large/');
  }
  return raw.slice(0, 1000);
}

export function needsSocialImageProxy(url = '') {
  try {
    const normalized = normalizeExternalImageUrl(url);
    if (!normalized) return false;
    const host = new URL(normalized).hostname.toLowerCase();
    return /(?:^|\.)sinaimg\.cn$/.test(host) || /(?:^|\.)wimg\.weibo\.(?:com|cn)$/.test(host);
  } catch {
    return false;
  }
}

/** 微博等防盗链图床走同源代理，避免卡片封面裂图。 */
export function displaySocialImageUrl(url = '', platformId = '') {
  const normalized = normalizeExternalImageUrl(url);
  if (!normalized) return '';
  if (platformId === 'weibo' || needsSocialImageProxy(normalized)) {
    return `${workerProxyPath('/api/social/image-proxy')}?url=${encodeURIComponent(normalized)}`;
  }
  return normalized;
}

function getHost(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

export function normalizeLinkUrl(url = '') {
  return normalizeLinkCacheKey(url) || String(url || '').trim();
}

export function isLinkMessageMetadataStale(msg = {}) {
  const md = msg.metadata || {};
  if (!md.enhancedBy) return false;
  const messageUrl = normalizeLinkUrl(md.url || msg.content || md.pendingLinkUrl || '');
  const resolvedUrl = normalizeLinkUrl(md.resolvedUrl || md.url || '');
  if (messageUrl && resolvedUrl && messageUrl !== resolvedUrl) return true;
  const resolvedNoteId = String(md.resolvedNoteId || '').trim();
  const noteId = String(md.noteId || '').trim();
  if (resolvedNoteId && noteId && resolvedNoteId !== noteId) return true;
  return false;
}

function normalizeUrl(url = '') {
  return normalizeLinkUrl(url);
}

function isXhsUrl(url = '') {
  const host = getHost(url);
  return /(?:^|\.)xhslink\.(?:com|cn)$/i.test(host) || /(?:^|\.)xiaohongshu\.com$/i.test(host);
}

function isWeiboUrl(url = '') {
  const host = getHost(url);
  return /(?:^|\.)?weibo\.(?:com|cn)$/i.test(host) || host === 't.cn';
}

function isTaobaoUrl(url = '') {
  return detectLinkPlatform(url)?.id === 'taobao';
}

function taobaoProductId(url = '') {
  try {
    const parsed = new URL(String(url || '').trim());
    return String(parsed.searchParams.get('id') || parsed.searchParams.get('itemId') || '').trim().slice(0, 40);
  } catch {
    return '';
  }
}

/** 小红书 App 分享文案里的播报头 / 跳转尾（新旧口令格式都剥掉）。 */
function cleanXhsShareText(value = '') {
  return String(value || '')
    .replace(/^\s*\d+\s*.{1,30}?发布(?:了)?(?:一篇|一个)?小红书(?:笔记|视频)?[，,]?\s*快来看吧[!！]?\s*/u, ' ')
    .replace(/[，,、\s]*(?:长按)?复制(?:本条|这条|这段)?(?:信息|内容|消息)?[，,]?\s*打开[【\[]?\s*小红书\s*[】\]]?\s*(?:App|app|应用)?\s*(?:查看|即可查看)?.{0,20}$/u, ' ')
    .replace(/[，,、\s]*(?:拷走口令|复制口令)[，,、\s]*来[【\[]?\s*小红书\s*[】\]]?\s*(?:瞅瞅|看看|查看|瞧瞧)[~～!！。.]?$/u, ' ')
    .replace(/[，,、\s]*来[【\[]?\s*小红书\s*[】\]]?\s*(?:瞅瞅|看看|查看|瞧瞧)[~～!！。.]?$/u, ' ')
    .replace(/(?:😆|👀|🔥)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 微博分享文案常见尾巴（正文一般在链接前，这里只清引导语）。 */
function cleanWeiboShareText(value = '') {
  return String(value || '')
    .replace(/^\s*\d+\s*.{0,24}?的(?:微博|Weibo)(?:视频)?[，,]?\s*/iu, ' ')
    .replace(/^\s*(?:分享@|分享了@)\S+\s*的(?:微博|新鲜事)?[，,]?\s*/u, ' ')
    .replace(/^\s*\/\/@\S+[:：]\s*/u, '')
    .replace(/^\s*回复@\S+[:：]\s*/u, '')
    .replace(/[，,、\s]*(?:点击|打开)?链接查看(?:全文|更多)?[。.!！]?$/u, ' ')
    .replace(/[，,、\s]*来自\s*微博\s*(?:网页版|移动版|客户端)?[。.!！]?$/iu, ' ')
    .replace(/[，,、\s]*查看图片[。.!！]?$/u, ' ')
    .replace(/\s*转发微博\s*$/u, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 淘宝 App 分享文案的稳定信息在链接后的书名号里：
 * 【淘宝】活动角标 https://e.tb.cn/... 淘口令 「真实商品标题」 点击链接直接打开……
 * 活动角标、淘口令和打开提示都不应进入商品卡标题。
 */
function extractTaobaoProductTitle(value = '', url = '') {
  const raw = String(value || '').replace(url, ' ').replace(/\s+/g, ' ').trim();
  const quoted = raw.match(/[「“]([^」”]{2,180})[」”]/u);
  if (quoted?.[1]) return text(quoted[1], 120);
  return String(raw)
    .replace(/^\s*【(?:淘宝|天猫)】\s*/u, '')
    .replace(/(?:点击链接直接打开|复制(?:这段)?(?:信息|内容)|淘宝搜索直接打开|打开淘宝).*$/u, '')
    .replace(/\b[A-Za-z0-9]{5,16}\b/g, ' ')
    .replace(/^(?:大促价保|假一赔四|官方立减|百亿补贴)\s*/u, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanSocialShareBoilerplate(value = '', url = '') {
  let cleaned = String(value || '').replace(url, ' ').replace(/\s+/g, ' ').trim();
  if (isXhsUrl(url)) cleaned = cleanXhsShareText(cleaned);
  else if (isWeiboUrl(url)) cleaned = cleanWeiboShareText(cleaned);
  return cleaned
    .replace(/^[\s:：｜|—-]+|[\s:：｜|—-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractSharePreviewText(raw = '', url = '') {
  const source = String(raw || '').trim();
  if (!source || !url) return '';
  if (isTaobaoUrl(url)) return extractTaobaoProductTitle(source, url);
  const idx = source.indexOf(url);
  const before = idx >= 0 ? source.slice(0, idx) : source;
  const after = idx >= 0 ? source.slice(idx + url.length) : '';
  const leading = cleanSocialShareBoilerplate(before, url);
  if (leading) return leading;
  return cleanSocialShareBoilerplate(after, url);
}

/** 分享文案里常见的 App/平台名，避免被误当成标题（比如尾巴里没剥净的【小红书】） */
const SHARE_TITLE_GUARD_WORDS = new Set([
  '小红书', '微博', '抖音', '抖音极速版', '知乎', 'B站', 'b站', '哔哩哔哩',
  '百度', '淘宝', '天猫', '京东', '拼多多', '微信', 'QQ', 'App', 'app',
  '转发微博', '分享新鲜事',
]);

export function extractSingleHttpUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const direct = raw.match(/^https?:\/\/[^\s<>"'，。！？、]+$/i);
  if (direct) return direct[0].replace(/[)\].,;!?]+$/u, '');
  if (!/\s/.test(raw) && /^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(raw)) {
    return `https://${raw.replace(/^\/+/, '')}`;
  }
  const all = (raw.match(/https?:\/\/[^\s<>"'，。！？、]+/gi) || [])
    .map((item) => item.replace(/[)\].,;!?]+$/u, ''))
    .filter(Boolean);
  if (!all.length) return '';
  if (all.length === 1) return all[0];
  const social = all.find((item) => /(?:^|\/\/)(?:[^/]+\.)?(?:www\.|m\.)?weibo\.(?:com|cn)|xhslink\.(?:com|cn)|xiaohongshu\.com|t\.cn\b/i.test(item));
  return social || all[0];
}

/**
 * HTML 小剧场、代码块和样式源码里的 URL 是资源地址，不是用户分享的链接。
 * 在所有链接卡片入口前统一拦截，避免 src/href/url(...) 被强制转换成卡片。
 */
export function isCodeOrHtmlLinkPayload(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/```|~~~/u.test(raw)) return true;
  if (/<\/?(?:!doctype|html|head|body|style|script|template|main|section|article|aside|header|footer|nav|div|span|p|a|img|picture|source|video|audio|canvas|svg|details|summary|button|input|form|label|ul|ol|li|table|iframe)\b[^>]*>/iu.test(raw)) return true;
  if (/\b(?:src|href|poster|action)\s*=\s*["']?https?:\/\//iu.test(raw)) return true;
  if (/\b(?:url|image-set)\(\s*["']?https?:\/\//iu.test(raw)) return true;
  return false;
}

/** 深度解析后：过长的分享 mash 不当独立标题。本地兜底不走这条。 */
function isLikelyShareMashTitle(value = '', descFull = '') {
  const raw = String(value || '').trim();
  if (!raw) return true;
  if (raw.length > 56) return true;
  if (/[。！？!?；;\n]/.test(raw)) return true;
  const desc = String(descFull || '').trim();
  if (desc && desc.includes(raw) && raw.length >= 24) return true;
  return false;
}

/** 从 App 分享摘要里抽卡片标题：优先截断符前的一段，否则取前 56 字。 */
export function pickSharePreviewTitle(previewText = '') {
  const raw = String(previewText || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const articleMatch = raw.match(/发布了(?:头条)?文章[：:]\s*[《「]([^》」]{1,100})[》」]/u);
  if (articleMatch?.[1]) {
    const inner = articleMatch[1].trim();
    if (inner && !SHARE_TITLE_GUARD_WORDS.has(inner)) return text(inner, 90);
  }
  const bracketMatch = raw.match(/【([^】]{1,100})】/u);
  if (bracketMatch) {
    const inner = bracketMatch[1].trim();
    if (inner && !SHARE_TITLE_GUARD_WORDS.has(inner)) return text(inner, 90);
  }
  const truncMatch = raw.match(/^(.{8,}?)(?:…|\.{3,})(?:\s|$)/u);
  if (truncMatch?.[1]) return text(truncMatch[1].trim(), 72);
  if (raw.length <= 72) return text(raw, 72);
  const slice = raw.slice(0, 56);
  const soft = slice.replace(/\s+\S*$/u, '').trim();
  return text(soft || slice, 72);
}

function pickSharePreviewDesc(previewText = '') {
  return text(String(previewText || '').replace(/\s+/g, ' ').trim(), 480);
}

/** 无深度解析时的本地预览：拿到的是 App 分享摘要（标题/前几行），不是笔记全文。 */
export function parseLocalLinkSharePreview(value = '') {
  const raw = String(value || '').trim();
  if (isCodeOrHtmlLinkPayload(raw)) return null;
  const url = extractSingleHttpUrl(raw);
  if (!url) return null;
  const platform = detectLinkPlatform(url);
  const previewText = extractSharePreviewText(raw, url);
  const desc = pickSharePreviewDesc(previewText);
  const title = pickSharePreviewTitle(previewText);
  if (!title && !desc) return null;
  return {
    url,
    title: title || pickSharePreviewTitle(desc) || '',
    desc: desc || title || '',
    descFull: desc || title || '',
    rawText: raw,
    platform,
    keywords: extractShareKeywords(raw),
    localPreview: true,
  };
}

export function parseSingleLinkShareText(value = '') {
  const parsed = parseLocalLinkSharePreview(value);
  if (parsed) return parsed;
  const raw = String(value || '').trim();
  const url = extractSingleHttpUrl(raw);
  if (!url) return null;
  const platform = detectLinkPlatform(url);
  if (!platform || !['xiaohongshu', 'weibo', 'bilibili', 'taobao'].includes(platform.id)) return null;
  const compact = raw.replace(/\s+/g, '');
  if (compact !== url && !raw.includes(url)) return null;
  return {
    url,
    title: '',
    desc: '',
    descFull: '',
    rawText: raw,
    platform,
    keywords: extractShareKeywords(raw),
    localPreview: false,
  };
}

/** 给 AI 上下文 / 识图提示用：合并 metadata 与 shareText 本地摘要。 */
export function resolveLinkMessagePreview(msg = {}, md = {}) {
  const meta = md && typeof md === 'object' ? md : {};
  const url = String(msg.content || meta.url || meta.pendingLinkUrl || '').trim();
  let title = String(meta.title || meta.pendingLinkTitle || meta.linkTitle || '').trim();
  let descFull = String(meta.descFull || meta.pendingLinkDesc || meta.desc || meta.description || '').trim();
  const shareText = String(meta.shareText || '').trim();

  if ((!title && !descFull) || title === url) {
    const parsed = shareText && shareText !== url ? parseLocalLinkSharePreview(shareText) : null;
    if (parsed) {
      title = title || parsed.title || '';
      descFull = descFull || parsed.descFull || parsed.desc || '';
    } else if (shareText && url && shareText.includes(url)) {
      const previewText = extractSharePreviewText(shareText, url);
      const desc = pickSharePreviewDesc(previewText);
      descFull = descFull || desc;
      title = title || pickSharePreviewTitle(desc || previewText);
    }
  }

  if (title === url) title = '';
  // 老数据/兜底来源可能还带着小红书的 "[话题]" 标记（正常链路已在抓取时去掉），
  // 这里兜底清一次，避免这段原文被直接喂给 AI 当上下文。
  descFull = descFull.replace(/\[话题\]/g, '').trim();
  const platformId = String(meta.platformId || meta.platform?.id || detectLinkPlatform(url)?.id || '').trim();
  const platformLabel = String(meta.platformLabel || meta.platform?.label || meta.source || detectLinkPlatform(url)?.label || '').trim();
  const deepEnhanced = !!meta.enhancedBy && !['local-share'].includes(meta.enhancedBy);
  const isLocalPreview = !deepEnhanced && !!(descFull || title) && (
    meta.localPreview === true
    || meta.enhancedBy === 'local-share'
    || !!meta.pendingLinkUrl
    || (!!shareText && shareText !== url)
  );

  return {
    url,
    title,
    descFull,
    platformId,
    platformLabel,
    isLocalPreview,
    isScreenshotFallback: meta.enhancedBy === 'webview-snapshot' || meta.screenshotFallback === true,
  };
}

/** 从混合正文里抽出可分享链接（角色常在 msg 里带一句口语 + URL，而不是单独发 link 事件）。 */
export function parseEmbeddedLinkShareText(value = '') {
  const raw = String(value || '').trim();
  if (isCodeOrHtmlLinkPayload(raw)) return null;
  const url = extractSingleHttpUrl(raw);
  if (!url) return null;
  const platform = detectLinkPlatform(url);
  const social = !!(platform && ['xiaohongshu', 'weibo', 'bilibili', 'douyin', 'taobao'].includes(platform.id));
  const urlHeavy = raw.length <= url.length + 8;
  const leadingContext = extractSharePreviewText(raw, url);
  const hasLeadingContext = leadingContext.length >= 4;
  if (!social && !urlHeavy && !hasLeadingContext) return null;
  const parsed = parseLocalLinkSharePreview(raw);
  if (!parsed) {
    return {
      url,
      title: '',
      desc: '',
      descFull: '',
      rawText: raw,
      platform,
      keywords: extractShareKeywords(raw),
      leadingText: '',
    };
  }
  return {
    ...parsed,
    leadingText: parsed.desc || parsed.title || '',
  };
}

function buildLocalShareMetadata(cleanUrl, base = {}, options = {}) {
  const shareText = String(options.shareText || base.shareText || cleanUrl).trim() || cleanUrl;
  const parsed = parseLocalLinkSharePreview(shareText);
  const title = String(base.title || base.pendingLinkTitle || parsed?.title || '').trim();
  const descFull = String(base.descFull || base.pendingLinkDesc || base.desc || parsed?.descFull || parsed?.desc || '').trim();
  const desc = String(base.desc || descFull || parsed?.desc || '').trim();
  if (!title && !desc) return null;
  const platform = base.platform || parsed?.platform || detectLinkPlatform(cleanUrl);
  return {
    ...base,
    url: cleanUrl,
    title: title || pickSharePreviewTitle(desc) || '',
    desc: desc || title,
    descFull: descFull || desc || title,
    description: desc || title,
    platform,
    keywords: base.keywords || parsed?.keywords,
    shareText: parsed?.rawText || shareText,
    enhancedBy: 'local-share',
    enhancedAt: Date.now(),
    localPreview: true,
    pendingLinkUrl: undefined,
    pendingLinkTitle: undefined,
    pendingLinkDesc: undefined,
    linkEnhanceFailedAt: undefined,
    linkEnhanceError: undefined,
  };
}

/** 无深度解析、也无分享文案时：立刻落平台名 + 链接，避免掉进 Tavily / WebView 长等待。 */
function buildSocialShallowMetadata(cleanUrl, base = {}, options = {}) {
  const platform = base.platform || detectLinkPlatform(cleanUrl);
  const shareText = String(options.shareText || base.shareText || cleanUrl).trim() || cleanUrl;
  const title = String(base.title || base.pendingLinkTitle || platform?.label || getHost(cleanUrl) || '分享链接').trim();
  return {
    ...base,
    url: cleanUrl,
    title,
    desc: String(base.desc || base.pendingLinkDesc || '').trim(),
    descFull: String(base.descFull || base.pendingLinkDesc || base.desc || '').trim(),
    description: String(base.desc || base.pendingLinkDesc || '').trim(),
    platform,
    keywords: base.keywords,
    shareText,
    enhancedBy: 'local-share',
    enhancedAt: Date.now(),
    localPreview: false,
    shallowLink: true,
    pendingLinkUrl: undefined,
    pendingLinkTitle: undefined,
    pendingLinkDesc: undefined,
    linkEnhanceFailedAt: undefined,
    linkEnhanceError: undefined,
  };
}

function resolveSocialFastMetadata(cleanUrl, base = {}, options = {}, socialCfg = {}) {
  const localOnly = buildLocalShareMetadata(cleanUrl, base, options);
  if (localOnly) return localOnly;
  if (socialCfg?.webviewFallbackEnabled) return null;
  return buildSocialShallowMetadata(cleanUrl, base, options);
}

/** 微博 / B 站卡片以正文缩略为主，不单独展示「标题」行。 */
export function isBodyFirstLinkPlatform(platformId = '') {
  return ['weibo', 'bilibili'].includes(String(platformId || '').trim());
}

function isPlatformishLinkTitle(title = '', platformId = '') {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (SHARE_TITLE_GUARD_WORDS.has(t)) return true;
  if (platformId === 'weibo' && (t === '微博' || /^@.+的(?:微博|Weibo)/iu.test(t))) return true;
  if (platformId === 'bilibili' && /^(哔哩哔哩|bilibili|B站|b站)$/i.test(t)) return true;
  return false;
}

function shouldIncludeSocialLinkCover(platformId = '', includeCoverSetting = false) {
  return includeCoverSetting === true
    || ['weibo', 'xiaohongshu', 'bilibili', 'taobao'].includes(String(platformId || '').trim());
}

function buildBodyFirstDescFull(fullDesc = '', rawTitle = '', platformId = '') {
  let source = String(fullDesc || '').replace(/\s+/g, ' ').trim();
  const title = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (title && !isPlatformishLinkTitle(title, platformId)) {
    if (!source) return title;
    if (!source.startsWith(title) && !source.includes(title)) return `${title} ${source}`;
  }
  return source;
}

function normalizeOgUnfurlMetadata(platform, payload = {}) {
  const ogTitle = cleanUsableText(payload.title, 90);
  const ogDesc = cleanSocialBodyText(payload.description, 1200);
  if (platform?.id === 'weibo') {
    const descFull = ogDesc || (!isPlatformishLinkTitle(ogTitle, 'weibo') ? ogTitle : '');
    return { title: '', descFull };
  }
  if (platform?.id === 'bilibili') {
    const descFull = ogDesc || ogTitle;
    return { title: '', descFull };
  }
  const descFull = ogDesc || ogTitle;
  const title = ogTitle && !isPlatformishLinkTitle(ogTitle, platform?.id) ? ogTitle : pickSharePreviewTitle(descFull);
  return { title: title || '', descFull: descFull || title };
}

/** 淘宝短链的访客页/跨境站经常只返回站点宣传文案，并不代表具体商品。 */
function isGenericTaobaoUnfurl(payload = {}, normalized = {}) {
  const title = String(normalized.title || payload.title || '').replace(/\s+/g, ' ').trim();
  const desc = String(normalized.descFull || payload.description || '').replace(/\s+/g, ' ').trim();
  const combined = `${title} ${desc}`;
  if (/天猫淘宝海外|面向华人的跨境电商平台|覆盖\s*200\s*多个国家和地区/u.test(combined)) return true;
  if (/^(?:e\.tb\.cn|m\.tb\.cn|淘宝|天猫|Taobao|Tmall)$/iu.test(title) && !payload?.product?.itemId) return true;
  return false;
}

export function shouldDeepParseSocialLink(url = '', socialCfg = {}) {
  const platform = detectLinkPlatform(url);
  if (!platform || !['xiaohongshu', 'weibo'].includes(platform.id)) return false;
  return !!(socialCfg?.enabled && socialCfg?.apiKey);
}

export function shouldAwaitSlowSocialFallback(url = '', socialCfg = {}) {
  const platform = detectLinkPlatform(url);
  if (!platform || !['xiaohongshu', 'weibo'].includes(platform.id)) return false;
  return socialCfg?.webviewFallbackEnabled === true;
}

/** 无 TikHub 时仍要走异步增强（Worker OG 抓取等），避免裸链接只显示平台名就结束。 */
export function shouldAwaitLinkEnhanceQueue(url = '', socialCfg = {}) {
  if (shouldDeepParseSocialLink(url, socialCfg)) return true;
  if (shouldAwaitSlowSocialFallback(url, socialCfg)) return true;
  const platform = detectLinkPlatform(url);
  if (platform && ['xiaohongshu', 'weibo', 'bilibili'].includes(platform.id)) {
    return !(socialCfg?.enabled && socialCfg?.apiKey);
  }
  if (platform?.id === 'taobao') return true;
  return false;
}

export function hasMeaningfulLinkSharePreview(linkShare = {}, seedMd = {}) {
  const platformLabel = String(
    linkShare?.platform?.label || seedMd?.platform?.label || seedMd?.platformLabel || '',
  ).trim();
  const title = String(linkShare?.title || seedMd?.pendingLinkTitle || seedMd?.title || '').trim();
  const desc = String(
    linkShare?.desc || linkShare?.descFull || seedMd?.pendingLinkDesc || seedMd?.desc || seedMd?.descFull || '',
  ).trim();
  if (desc) return true;
  if (title && title !== platformLabel && title !== linkShare?.url) return true;
  return false;
}

/** 链接卡片展示文案：本地摘要优先，深度解析成功后再覆盖。 */
export function pickLinkCardDisplayCopy(msg = {}, url = '') {
  const md = msg.metadata || {};
  let fullDesc = stripMarkdownLinkSyntax(md.descFull || md.desc || md.description || md.pendingLinkDesc || '');
  let rawTitle = stripMarkdownLinkSyntax(md.title || md.pendingLinkTitle || '');
  // 旧版“让角色看看”曾把淘宝卡片的展示字段覆盖为空，但原始分享文案仍保存在 shareText。
  // 渲染时从它自愈标题/摘要，让已受影响的历史卡片升级后也能恢复，不要求用户重新发送。
  if ((!rawTitle || !fullDesc) && String(md.shareText || '').trim()) {
    const recovered = parseLocalLinkSharePreview(md.shareText);
    rawTitle = rawTitle || stripMarkdownLinkSyntax(recovered?.title || '');
    fullDesc = fullDesc || stripMarkdownLinkSyntax(recovered?.descFull || recovered?.desc || '');
  }
  const platformId = String(md.platformId || md.platform?.id || detectLinkPlatform(url)?.id || '').trim();
  const bodyFirst = isBodyFirstLinkPlatform(platformId);
  const stale = isLinkMessageMetadataStale(msg);
  const deepEnhanced = !!md.enhancedBy && md.enhancedBy !== 'local-share';
  const failedResolve = !!md.linkEnhanceFailedAt && !deepEnhanced;
  const pendingResolve = (!!md.pendingLinkUrl && !md.enhancedBy && !failedResolve) || stale;
  const tags = Array.isArray(md.tags) && md.tags.length
    ? md.tags
    : (Array.isArray(md.keywords) ? md.keywords : []);

  if (bodyFirst) {
    const source = buildBodyFirstDescFull(fullDesc, rawTitle, platformId);
    const bodySource = stripHashTagsFromBody(source, tags);
    const body = excerptLinkBody(bodySource, deepEnhanced ? 96 : 120);
    const showMore = !!body && !!bodySource
      && (bodySource.length > body.length || bodySource.length > 48)
      && body !== '正在解析链接…';
    const hasLocalPreview = !!body;
    const cardPending = pendingResolve && !hasLocalPreview;
    return {
      title: '',
      body: body || (cardPending ? '正在解析链接…' : (failedResolve ? String(md.linkEnhanceError || '链接解析失败').slice(0, 96) : '')),
      tags,
      pendingResolve: cardPending,
      showMore,
    };
  }

  const localTitle = rawTitle && rawTitle !== url ? rawTitle : pickSharePreviewTitle(fullDesc);
  const localBodySource = fullDesc && fullDesc !== localTitle ? fullDesc : '';
  const platformFallbackTitle = String(md.platform?.label || '').trim();
  const hasLocalPreview = !!(localTitle || localBodySource)
    || (!deepEnhanced && !failedResolve && !!platformFallbackTitle && (md.localPreview || md.shallowLink || md.pendingLinkUrl));

  let title = '';
  if (deepEnhanced) {
    if (rawTitle && !isLikelyShareMashTitle(rawTitle, fullDesc) && rawTitle !== url) {
      if (!(fullDesc && fullDesc.startsWith(rawTitle) && rawTitle.length >= Math.min(24, fullDesc.length * 0.85))) {
        title = rawTitle;
      }
    }
    if (!title && fullDesc && !isLikelyShareMashTitle(fullDesc, fullDesc)) {
      title = fullDesc.split(/[\n。！？!?]/)[0].slice(0, 56).trim();
    }
  } else if (hasLocalPreview) {
    title = localTitle || platformFallbackTitle || '分享链接';
  } else if (pendingResolve) {
    title = String(md.platform?.label || '分享链接').trim() || '分享链接';
  } else if (rawTitle && rawTitle !== url) {
    title = rawTitle;
  }

  let body = '';
  if (deepEnhanced) {
    const bodySource = stripHashTagsFromBody(fullDesc, tags);
    body = excerptLinkBody(bodySource && bodySource !== title ? bodySource : '', 96);
  } else if (hasLocalPreview) {
    body = excerptLinkBody(localBodySource, 120);
    if (!body && localTitle && localTitle.length > 48) {
      body = excerptLinkBody(localTitle, 120);
    }
  } else if (pendingResolve) {
    body = '正在解析链接…';
  } else if (failedResolve) {
    body = String(md.linkEnhanceError || '链接解析失败').slice(0, 96);
  }

  const showMore = !!body && !!fullDesc
    && (fullDesc.length > body.length || fullDesc.length > 48)
    && body !== '正在解析链接…';
  const cardPending = pendingResolve && !hasLocalPreview;
  return { title, body, tags, pendingResolve: cardPending, showMore };
}

function stripHashTagsFromBody(body = '', tags = []) {
  // 小红书正文里的话题标签自带 "[话题]" 后缀标记（如 "#甜品[话题]#"），正常链路在
  // social-link-resolver.js 里就已经提前去掉；这里再兜底清一次，防止其它来源（OG 兜底、
  // 老数据）漏网，避免只把 "#标签名" 部分剔掉，却把光秃秃的 "[话题]#" 剩在正文里。
  let next = String(body || '').replace(/\[话题\]/g, '');
  (Array.isArray(tags) ? tags : []).forEach((tag) => {
    const clean = String(tag || '').replace(/^#+/, '').trim();
    if (!clean) return;
    next = next.replace(new RegExp(`#${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#?`, 'gi'), ' ');
  });
  return next.replace(/(?:#[^\s#]{1,32}\s*){2,}$/g, ' ').replace(/\s+/g, ' ').trim();
}

function excerptLinkBody(body = '', max = 96) {
  const raw = String(body || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max).trim()}…`;
}

export function buildPendingLinkMetadata(linkShare, extra = {}) {
  if (!linkShare?.url) return {};
  const token = createLinkEnhanceToken();
  const descFull = String(linkShare.descFull || linkShare.desc || '').trim();
  const title = String(linkShare.title || pickSharePreviewTitle(descFull) || '').trim();
  const desc = String(linkShare.desc || descFull || '').trim();
  return {
    url: linkShare.url,
    title,
    desc,
    descFull: descFull || desc,
    description: desc,
    source: 'web',
    platform: linkShare.platform,
    keywords: linkShare.keywords,
    shareText: linkShare.rawText || linkShare.url,
    localPreview: !!linkShare.localPreview,
    linkEnhanceToken: token,
    pendingLinkUrl: linkShare.url,
    pendingLinkTitle: title,
    pendingLinkDesc: desc,
    coverUrl: '',
    imageUrl: '',
    images: [],
    ...extra,
  };
}

function safeImageUrl(url = '') {
  const raw = normalizeExternalImageUrl(url);
  if (!raw) return '';
  if (/\/(avatar|icon|emoji|logo)\b/i.test(raw)) return '';
  if (/[?&](w|width)=([1-9]|[1-9][0-9])\b/i.test(raw)) return '';
  return raw;
}

function pickCover(images = []) {
  return (Array.isArray(images) ? images : []).map(safeImageUrl).find(Boolean) || '';
}

function isDefaultTitle(value = '') {
  return /^(?:share link|分享链接|链接)$/i.test(text(value, 40));
}

function isLikelyUrlTitle(value = '') {
  const raw = text(value, 200);
  if (!raw) return true;
  if (/^https?:\/\//i.test(raw)) return true;
  if (/^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(raw)) return true;
  return false;
}

function cleanMetadataText(value = '', max = 240) {
  let raw = String(value || '');
  raw = raw.replace(/!\[[^\]]*\]\(\s*data:image\/[^)\s]+[^)]*\)/gi, ' ');
  raw = raw.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{40,}/gi, ' ');
  raw = raw.replace(/!\[[^\]]*\]\(\s*\)/g, ' ');
  raw = raw.replace(/\[[^\]]{0,40}\]\(\s*\)/g, ' ');
  return text(raw, max);
}

function cleanUsableText(value = '', max = 240) {
  const cleaned = cleanMetadataText(value, max);
  const compact = cleaned.replace(/\s+/g, '');
  if (!cleaned) return '';
  if (/data:image\/|;base64,|iVBORw0KG|\/9j\/4AAQSkZJRgABAQ/i.test(cleaned)) return '';
  if (compact.length > 80 && /^[A-Za-z0-9+/=]+$/.test(compact)) return '';
  return cleaned;
}

function attachPlatform(url, metadata = {}) {
  const platform = metadata.platform && metadata.platform.id ? metadata.platform : detectLinkPlatform(url);
  if (!platform) return {};
  return {
    platform,
    platformId: platform.id,
    platformLabel: platform.label,
    platformColor: platform.color,
    platformMono: platform.mono,
  };
}

function sanitizeDisplayMetadata(url, metadata = {}) {
  const descFull = String(metadata.descFull || metadata.desc || metadata.description || '').trim();
  let title = cleanUsableText(metadata.title, 90) || getHost(url) || '分享链接';
  if (isLikelyShareMashTitle(title, descFull)) {
    title = getHost(url) || '分享链接';
  }
  const desc = cleanUsableText(metadata.desc || metadata.description, 180) || '';
  const keywords = Array.isArray(metadata.keywords) ? metadata.keywords.filter(Boolean).slice(0, 6) : [];
  return {
    ...(metadata || {}),
    title,
    desc,
    description: desc,
    source: text(metadata.source, 60) || getHost(url) || 'web',
    url,
    ...(keywords.length ? { keywords } : {}),
    ...attachPlatform(url, metadata),
  };
}

function stripCoverMetadata(metadata = {}) {
  const next = { ...(metadata || {}) };
  delete next.coverUrl;
  delete next.imageUrl;
  delete next.image;
  return next;
}

async function loadCache() {
  const row = await db.get('settings', LINK_CARD_CACHE_KEY);
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    version: CACHE_VERSION,
    updatedAt: Number(value.updatedAt || 0) || 0,
    items: value.items && typeof value.items === 'object' ? value.items : {},
  };
}

async function saveCache(cache) {
  const entries = Object.entries(cache.items || {})
    .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
    .slice(0, MAX_CACHE_ITEMS);
  await db.put('settings', {
    key: LINK_CARD_CACHE_KEY,
    value: {
      version: CACHE_VERSION,
      updatedAt: Date.now(),
      items: Object.fromEntries(entries),
    },
  });
}

function mergeMetadata(url, base = {}, extracted = {}, options = {}) {
  const first = Array.isArray(extracted.results) ? extracted.results[0] || {} : {};
  const summary = cleanUsableText(extracted.summary || first.content || '', 240);
  const baseTitle = cleanUsableText(base.title, 90);
  const extractedTitle = cleanUsableText(extracted.title || first.title || '', 90);
  const title = !isDefaultTitle(baseTitle) && baseTitle
    ? baseTitle
    : (isLikelyUrlTitle(extractedTitle) ? baseTitle : extractedTitle);
  const baseDesc = cleanUsableText(base.desc || base.description || '', 180);
  const extractedBody = cleanSocialBodyText(extracted.summary || first.content || '', 1200);
  const desc = baseDesc && baseDesc !== title ? baseDesc : text(extractedBody || summary || baseDesc || url, 480);
  const descFull = extractedBody || desc;
  const coverUrl = options.includeCover === true ? pickCover(extracted.images || first.images || []) : '';
  const keywords = Array.isArray(base.keywords) ? base.keywords.filter(Boolean).slice(0, 6) : [];
  return {
    ...(base || {}),
    title: title || getHost(url) || '分享链接',
    desc,
    descFull,
    description: desc,
    source: text(base.source, 60) || getHost(url) || 'web',
    url,
    ...(keywords.length ? { keywords } : {}),
    ...attachPlatform(url, base),
    ...(coverUrl ? { coverUrl, imageUrl: base.imageUrl || coverUrl } : {}),
    enhancedBy: 'tavily',
    enhancedAt: Date.now(),
  };
}

function normalizeIdForMatch(value = '') {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

/** 用户在资料里填了自己的小红书号/微博号才比对；没填就永远当转发处理，不瞎猜。 */
function matchesOwnSocialAccount(resolved = {}, user = null, platformId = '') {
  if (!user) return false;
  const author = resolved?.author || {};
  if (platformId === 'xiaohongshu') {
    const mine = normalizeIdForMatch(user.xiaohongshuId);
    if (!mine) return false;
    return [author.redId, author.userId, author.name].map(normalizeIdForMatch).includes(mine);
  }
  if (platformId === 'weibo') {
    const mine = normalizeIdForMatch(user.weiboId);
    if (!mine) return false;
    return [author.userId, author.name].map(normalizeIdForMatch).includes(mine);
  }
  return false;
}

function mergeSocialResolvedMetadata(url, base = {}, resolved = {}, includeCover = true, isOwnPost = false) {
  const platformId = String(base.platform?.id || detectLinkPlatform(url)?.id || resolved.platform || '').trim();
  const bodyFirst = isBodyFirstLinkPlatform(platformId);
  const socialCover = shouldIncludeSocialLinkCover(platformId, includeCover);
  let descFull = cleanSocialBodyText(resolved.desc || base.desc || base.description, 1200)
    || cleanUsableText(base.desc || base.description, 240);
  if (bodyFirst && platformId === 'bilibili' && !descFull) {
    descFull = cleanSocialBodyText(resolved.title || base.title, 1200);
  }
  const title = bodyFirst
    ? ''
    : (pickSocialTitle(resolved, base, descFull) || (descFull ? text(descFull, 48) : '') || getHost(url) || '分享链接');
  const desc = descFull ? text(descFull, 220) : cleanUsableText(base.desc || base.description, 180);
  const resolvedImages = Array.isArray(resolved.images)
    ? resolved.images.map(safeImageUrl).filter(Boolean).slice(0, 9)
    : [];
  const coverCandidate = safeImageUrl(resolved.cover || '');
  const images = socialCover
    ? (resolvedImages.length ? resolvedImages : (coverCandidate ? [coverCandidate] : []))
    : [];
  const cover = images[0] || (socialCover ? coverCandidate : '');
  const keywords = mergeSocialTags(resolved, descFull, base.keywords);
  return {
    title,
    desc,
    descFull: descFull || desc,
    description: descFull || desc,
    source: text(base.source, 60) || getHost(url) || 'web',
    url,
    resolvedUrl: url,
    resolvedNoteId: String(resolved.noteId || resolved.statusId || '').trim(),
    noteId: String(resolved.noteId || resolved.statusId || '').trim(),
    ...(keywords.length ? { keywords, tags: keywords } : {}),
    ...attachPlatform(url, { platform: base.platform || detectLinkPlatform(url) }),
    ...(cover ? { coverUrl: cover, imageUrl: cover, images } : { coverUrl: '', imageUrl: '', images: [] }),
    author: resolved.author || null,
    isOwnPost: !!isOwnPost,
    stats: resolved.stats || null,
    comments: Array.isArray(resolved.comments) ? resolved.comments.slice(0, 6) : [],
    enhancedBy: 'tikhub',
    enhancedAt: Date.now(),
  };
}

/** Worker unfurl 返回的小红书完整笔记数据（__INITIAL_STATE__ 解析）：正文/多图/评论/互动全量。 */
function mergeXhsUnfurlNoteMetadata(cleanUrl, base = {}, payload = {}, options = {}) {
  const note = payload.note;
  const descFull = cleanSocialBodyText(note.desc, 1600);
  const title = cleanUsableText(note.title, 90);
  if (!title && !descFull) return null;
  const images = (Array.isArray(note.images) ? note.images : [])
    .map((u) => normalizeExternalImageUrl(u)).filter(Boolean).slice(0, 9);
  const cover = images[0] || '';
  const tags = (Array.isArray(note.tags) ? note.tags : []).map((t) => text(t, 24)).filter(Boolean).slice(0, 8);
  const comments = (Array.isArray(note.comments) ? note.comments : [])
    .map((c) => ({ author: text(c?.author, 40), text: text(c?.text, 160) }))
    .filter((c) => c.text).slice(0, 5);
  const stats = note.stats && typeof note.stats === 'object' ? {
    like: text(note.stats.like, 16),
    comment: text(note.stats.comment, 16),
    collect: text(note.stats.collect, 16),
    share: text(note.stats.share, 16),
  } : null;
  const noteId = text(note.noteId, 64);
  return {
    ...base,
    url: cleanUrl,
    // 保持 resolvedUrl = 原始链接（与 TikHub 路径一致）：消息 content 是 xhslink 短链时，
    // 写入展开后的完整地址会被 isLinkMessageMetadataStale / chat-thread 的 URL 一致性
    // 校验当成「解析结果对不上消息」而丢弃。
    resolvedUrl: cleanUrl,
    ...(noteId ? { resolvedNoteId: noteId, noteId } : {}),
    title,
    desc: text(descFull || title, 220),
    descFull: descFull || title,
    description: text(descFull || title, 220),
    ...(tags.length ? { keywords: tags, tags } : {}),
    author: note.author ? { name: text(note.author, 40) } : null,
    stats,
    comments,
    shareText: String(options.shareText || base.shareText || cleanUrl).trim() || cleanUrl,
    enhancedBy: 'og-unfurl',
    enhancedAt: Date.now(),
    localPreview: false,
    shallowLink: false,
    pendingLinkUrl: undefined,
    pendingLinkTitle: undefined,
    pendingLinkDesc: undefined,
    linkEnhanceFailedAt: undefined,
    linkEnhanceError: undefined,
    ...attachPlatform(cleanUrl, base),
    ...(cover ? { coverUrl: cover, imageUrl: cover, images } : { coverUrl: '', imageUrl: '', images: [] }),
  };
}

/** Worker unfurl 返回的 B 站完整稿件数据（__INITIAL_STATE__ 解析）：简介/封面/UP主/互动数/热评全量。
 * BV 号本身长期有效，不像小红书分享令牌那样会过期，是三个社媒里最稳的免费全文路径。 */
function mergeBiliUnfurlNoteMetadata(cleanUrl, base = {}, payload = {}, options = {}) {
  const video = payload.video;
  const descFull = cleanSocialBodyText(video.desc, 800);
  const title = cleanUsableText(video.title, 90);
  if (!title && !descFull) return null;
  const cover = normalizeExternalImageUrl(video.cover) || '';
  const tags = (Array.isArray(video.tags) ? video.tags : []).map((t) => text(t, 24)).filter(Boolean).slice(0, 8);
  const comments = (Array.isArray(video.comments) ? video.comments : [])
    .map((c) => ({ author: text(c?.author, 40), text: text(c?.text, 160) }))
    .filter((c) => c.text).slice(0, 5);
  const stat = video.stats && typeof video.stats === 'object' ? video.stats : {};
  // 复用卡片渲染统一认的 like/comment/collect/share 四字段（对应 UI 上的赞/评/藏/转），
  // B 站原始字段名不同（reply=评论数、favorite=收藏数），这里做一次语义映射。
  const stats = {
    like: text(stat.like, 16),
    comment: text(stat.reply, 16),
    collect: text(stat.favorite, 16),
    share: text(stat.share, 16),
  };
  const bvid = text(video.bvid, 32);
  return {
    ...base,
    url: cleanUrl,
    resolvedUrl: cleanUrl,
    ...(bvid ? { resolvedNoteId: bvid, noteId: bvid } : {}),
    title,
    desc: text(descFull || title, 220),
    descFull: descFull || title,
    description: text(descFull || title, 220),
    ...(tags.length ? { keywords: tags, tags } : {}),
    author: video.author ? { name: text(video.author, 40) } : null,
    stats,
    comments,
    shareText: String(options.shareText || base.shareText || cleanUrl).trim() || cleanUrl,
    enhancedBy: 'og-unfurl',
    enhancedAt: Date.now(),
    localPreview: false,
    shallowLink: false,
    pendingLinkUrl: undefined,
    pendingLinkTitle: undefined,
    pendingLinkDesc: undefined,
    linkEnhanceFailedAt: undefined,
    linkEnhanceError: undefined,
    ...attachPlatform(cleanUrl, base),
    ...(cover ? { coverUrl: cover, imageUrl: cover, images: [cover] } : { coverUrl: '', imageUrl: '', images: [] }),
  };
}

/** Worker 侧免 Key 抓取：小红书/B站走 __INITIAL_STATE__，微博/淘宝走公开 OG 摘要。 */
async function trySocialLinkUnfurl(cleanUrl, base = {}, options = {}) {
  const platform = detectLinkPlatform(cleanUrl);
  if (!platform || !['xiaohongshu', 'weibo', 'bilibili', 'taobao'].includes(platform.id)) return null;
  try {
    const endpoint = `${workerProxyPath(SOCIAL_UNFURL_PATH)}?url=${encodeURIComponent(cleanUrl)}`;
    const res = await socialWorkerFetch(endpoint, { method: 'GET', cache: 'no-store' });
    if (res.status === 401 || res.status === 403) {
      // APK 里免费解析靠登录令牌鉴权：令牌过期时服务器会拒绝，此后所有链接都
      // 只剩分享文字兜底，而且没有任何报错，用户只会觉得"解析坏了"。这里把
      // 真实原因亮出来（每次会话最多提示一次）。
      console.warn('[link-card-enhancer] social unfurl auth rejected', res.status);
      if (!trySocialLinkUnfurl._authToastShown) {
        trySocialLinkUnfurl._authToastShown = true;
        showToast('链接解析登录态已过期：请到设置重新登录后再试，否则只能显示分享文字。', 5600);
      }
      return null;
    }
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null);
    if (!payload?.ok) return null;
    if (platform.id === 'xiaohongshu') {
      // 小红书失败壳页（token 过期/被拦/私密）本身也几乎没有可用的 og:title、og:description——
      // 硬凹一个只有平台名量级的"标题"意义不大，不如直接交回上一层去试分享文案/TikHub。
      const rich = payload.note && typeof payload.note === 'object'
        ? mergeXhsUnfurlNoteMetadata(cleanUrl, base, payload, options)
        : null;
      return rich || null;
    }
    if (platform.id === 'bilibili' && payload.video && typeof payload.video === 'object') {
      const rich = mergeBiliUnfurlNoteMetadata(cleanUrl, base, payload, options);
      if (rich) return rich;
    }
    let normalized = normalizeOgUnfurlMetadata(platform, payload);
    const local = platform.id === 'taobao'
      ? buildLocalShareMetadata(cleanUrl, base, options)
      : null;
    const genericTaobaoPage = platform.id === 'taobao' && isGenericTaobaoUnfurl(payload, normalized);
    if (genericTaobaoPage) {
      normalized = { title: '', descFull: '' };
    }
    // 淘宝 App 的分享文案含真实商品名，比短链访客页的站点标题稳定；抓取结果主要补主图和商品 ID。
    const localTitle = String(local?.title || '').trim();
    const localDesc = String(local?.descFull || local?.desc || '').trim();
    const descFull = platform.id === 'taobao'
      ? (localDesc || normalized.descFull)
      : normalized.descFull;
    const resolvedTitle = platform.id === 'taobao'
      ? (localTitle || normalized.title)
      : normalized.title;
    if (!resolvedTitle && !descFull) return null;
    const coverRaw = genericTaobaoPage ? '' : normalizeExternalImageUrl(payload.image);
    const cover = coverRaw ? displaySocialImageUrl(coverRaw, platform.id) : '';
    return {
      ...base,
      url: cleanUrl,
      // 淘宝短链展开后的地址只作为 canonicalUrl 保存。消息正文仍保留用户分享的短链，
      // 避免聊天异步增强的一致性校验把合法结果误判为“解析到了另一条链接”。
      resolvedUrl: platform.id === 'taobao' ? cleanUrl : (String(payload.url || cleanUrl).trim() || cleanUrl),
      ...(platform.id === 'taobao' && payload.url ? { canonicalUrl: String(payload.url).trim() } : {}),
      ...(platform.id === 'taobao' && payload.product?.itemId ? { productId: String(payload.product.itemId) } : {}),
      title: resolvedTitle,
      desc: text(descFull, 220),
      descFull,
      description: text(descFull, 220),
      platform,
      keywords: base.keywords,
      shareText: String(options.shareText || base.shareText || cleanUrl).trim() || cleanUrl,
      enhancedBy: 'og-unfurl',
      enhancedAt: Date.now(),
      localPreview: false,
      shallowLink: false,
      pendingLinkUrl: undefined,
      pendingLinkTitle: undefined,
      pendingLinkDesc: undefined,
      linkEnhanceFailedAt: undefined,
      linkEnhanceError: undefined,
      ...attachPlatform(cleanUrl, { ...base, platform }),
      ...(cover ? { coverUrl: cover, imageUrl: cover, images: [cover] } : {}),
    };
  } catch (err) {
    // 走到这里说明连解析服务器都没够着（WebView 与原生 HTTP 双通道都失败），
    // 多为设备网络对该域名不通/被污染。静默降级成分享文字会让用户以为解析
    // 功能坏了，这里把真实原因亮出来（每次会话最多提示一次）。
    console.warn('[link-card-enhancer] social og unfurl failed', err);
    if (!trySocialLinkUnfurl._netToastShown) {
      trySocialLinkUnfurl._netToastShown = true;
      showToast('连不上链接解析服务器：当前网络可能屏蔽了该域名，链接只能显示分享文字。切换网络或代理后重试。', 6000);
    }
    return null;
  }
}

/** 截图兜底解析结果：没有结构化正文，标题/正文都在截图画面里，交给识图模型自己读。 */
function mergeSocialScreenshotMetadata(url, base = {}, shot = {}) {
  const images = (Array.isArray(shot.images) ? shot.images : [])
    .map((image) => (typeof image === 'string' ? image : image?.dataUrl))
    .map((image) => String(image || '').trim())
    .filter((image) => /^data:image\/(?:jpeg|png|webp);base64,/i.test(image))
    .slice(0, 3);
  const pageTitle = cleanUsableText(shot.pageTitle, 90);
  const baseTitle = cleanUsableText(base.title || base.pendingLinkTitle, 90);
  const title = baseTitle || (pageTitle && !isLikelyUrlTitle(pageTitle) ? pageTitle : '') || getHost(url) || '分享链接';
  const cover = images[0] || '';
  const canonicalUrl = String(shot.finalUrl || '').trim();
  const productId = isTaobaoUrl(url) ? taobaoProductId(canonicalUrl) : '';
  return {
    ...base,
    title,
    desc: '',
    descFull: '',
    description: '',
    source: text(base.source, 60) || getHost(url) || 'web',
    url,
    // 异步增强的一致性校验以用户原始链接为准；短链展开地址单独存 canonicalUrl。
    resolvedUrl: url,
    ...(canonicalUrl && canonicalUrl !== url ? { canonicalUrl } : {}),
    ...(productId ? { productId } : {}),
    ...attachPlatform(url, { platform: base.platform || detectLinkPlatform(url) }),
    ...(cover ? { coverUrl: cover, imageUrl: cover, images } : { coverUrl: '', imageUrl: '', images: [] }),
    author: null,
    isOwnPost: false,
    stats: null,
    comments: [],
    enhancedBy: 'webview-snapshot',
    enhancedAt: Date.now(),
    screenshotFallback: true,
  };
}

/** 没配 TikHub Key、或 TikHub 请求失败时的免 Key 兜底：内置 WebView 打开分享链接。
 * 优先抽取页面里的 __INITIAL_STATE__ 结构化正文；抽不到再截 1~2 屏交给识图模型。
 * 仅原生壳 + 用户在设置里主动打开开关才会触发；失败时返回 null。
 * 注意：这条路径要在设备上打开小红书域名，境外网络常需代理；免费解析应优先走 Worker 代抓。 */
async function tryWebviewSnapshotFallback(url, socialCfg, base) {
  if (!socialCfg?.webviewFallbackEnabled) return null;
  if (!isWebSnapshotSupported()) return null;
  try {
    const openUrl = await resolveSocialOpenUrl(url).catch(() => url);
    const shot = await captureUrlSnapshot(openUrl || url, {
      maxShots: socialCfg.webviewFallbackMaxShots,
      minSecurityVersion: Number(socialCfg.minSecurityVersion) || 1,
    });
    if (!shot?.ok) {
      if (shot?.reason === 'load_error' || shot?.reason === 'timeout') {
        showToast('截图兜底打不开该页面，请切换网络后再试。', 4200);
      } else if (shot?.reason === 'blocked_redirect' || shot?.reason === 'blocked_url') {
        showToast('为保护隐私，登录、订单、购物车或非支持站点不会被自动截图。', 4800);
      } else if (shot?.reason === 'native_update_required') {
        showToast('当前 APK 版本暂不启用页面截图，请更新 APK；淘宝商品卡仍可正常使用。', 4800);
      }
      return null;
    }
    if (shot.note && typeof shot.note === 'object' && (shot.note.title || shot.note.desc)) {
      return mergeXhsUnfurlNoteMetadata(url, base, {
        ok: true,
        url: shot.finalUrl || openUrl || url,
        note: shot.note,
        title: shot.note.title,
        description: shot.note.desc,
        image: Array.isArray(shot.note.images) ? shot.note.images[0] : '',
      }, { includeCover: true });
    }
    if (!Array.isArray(shot.images) || !shot.images.length) return null;
    return mergeSocialScreenshotMetadata(url, base, shot);
  } catch (err) {
    console.warn('[link-card-enhancer] webview snapshot fallback failed', err);
    return null;
  }
}

/** 用户从淘宝卡片明确发起的一次性页面读取；不会参与发送后的自动增强或后台重试。 */
export async function captureLinkDetailSnapshot(url, metadata = {}) {
  const cleanUrl = normalizeUrl(url || metadata?.url || '');
  if (!cleanUrl || !isTaobaoUrl(cleanUrl)) return null;
  const cfg = await loadSocialLinkConfig().catch(() => ({}));
  return tryWebviewSnapshotFallback(cleanUrl, {
    ...cfg,
    webviewFallbackEnabled: true,
    // v2 会忽略淘宝页面主动唤起 App 的非 HTTP 意图，同时继续阻止登录、订单等敏感跳转。
    minSecurityVersion: 2,
  }, { ...(metadata || {}), url: cleanUrl });
}

/**
 * 把一次性商品页截图挂到下一轮识图上下文，但不让截图解析结果覆盖链接卡片本身。
 * 淘宝页面截图通常没有可靠的结构化标题/摘要；如果直接 merge snapshot，读取后卡片会
 * 从分享文案生成的商品卡退回只剩域名的基础卡。
 */
export function attachLinkDetailSnapshotMetadata(metadata = {}, snapshot = {}) {
  const images = (Array.isArray(snapshot?.images) ? snapshot.images : [])
    .map((image) => (typeof image === 'string' ? image : image?.dataUrl))
    .map((image) => String(image || '').trim())
    .filter((image) => /^data:image\/(?:jpeg|png|webp);base64,/i.test(image))
    .slice(0, 3);
  return {
    ...(metadata || {}),
    // 这些截图只供下一轮模型读取；标题、摘要、封面、平台和增强来源继续沿用原卡片。
    images,
    screenshotFallback: true,
    screenshotCapturedAt: Number(snapshot?.enhancedAt || Date.now()),
    forceVisionContextAfterCapture: true,
    visionContextConsumed: undefined,
    visionContextConsumedAt: undefined,
    visionContextConsumedReason: undefined,
  };
}

/** 免 Key 兜底顺序按平台区分：小红书/B站 Worker 抓取能拿到完整正文（或简介）+封面+互动数+热评
 * （小红书 __INITIAL_STATE__、B站 __INITIAL_STATE__），比只有标题的分享口令信息量大得多，
 * 先抓再退回本地文案；B 站的 BV 号还长期有效，比小红书的分享令牌更不容易过期。微博的 Worker
 * 抓取只有 OG 摘要且常撞访客墙，分享文案里的正文反而更全，维持本地文案优先。 */
function buildSocialFreeFallbackOrder(platformId, cleanUrl, base, options, includeCover) {
  const viaLocal = () => buildLocalShareMetadata(cleanUrl, base, options);
  const viaUnfurl = () => trySocialLinkUnfurl(cleanUrl, base, { ...options, includeCover });
  if (platformId === 'xiaohongshu' || platformId === 'bilibili') return [viaUnfurl, viaLocal];
  return [viaLocal, viaUnfurl];
}

export function createLinkEnhanceToken() {
  return `le_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function enhanceLinkMetadata(url, metadata = {}, options = {}) {
  const cleanUrl = normalizeUrl(url || metadata?.url || metadata?.href || '');
  const base = { ...(metadata || {}), url: cleanUrl || metadata?.url || url };
  if (!cleanUrl) return base;

  const imageCfg = await loadImageToolConfig().catch(() => null);
  const socialPlatform = detectLinkPlatform(cleanUrl);
  const includeCover = shouldIncludeSocialLinkCover(
    socialPlatform?.id,
    imageCfg?.usage?.linkCardCovers === true,
  );
  const socialCfg = await loadSocialLinkConfig().catch(() => null);
  const socialDeep = socialPlatform && ['xiaohongshu', 'weibo'].includes(socialPlatform.id);
  const tikhubReady = !!(socialCfg?.enabled && socialCfg?.apiKey);
  if (socialDeep && tikhubReady) {
    const viaTikhub = async () => {
      const shareText = String(options.shareText || metadata?.shareText || cleanUrl).trim() || cleanUrl;
      const resolved = await resolveSocialLinkCached(cleanUrl, socialCfg, {
        refresh: options.refresh,
        shareText,
      });
      if (!resolved) throw new Error('链接解析未返回内容，请检查 TikHub Key 与设置是否已保存。');
      const currentUser = await getCurrentUser().catch(() => null);
      const isOwnPost = matchesOwnSocialAccount(resolved, currentUser, socialPlatform.id);
      return mergeSocialResolvedMetadata(cleanUrl, base, resolved, true, isOwnPost);
    };
    // 小红书链接够新鲜时，免费解析（__INITIAL_STATE__）就能拿到完整正文+多图+首屏评论，信息量
    // 不输 TikHub 还不花一次调用；配了 Key 只在免费解析失败（链接过期/被拦/私密）时才顶上当兜底，
    // 不会每贴一条链接都白烧一次调用。微博的免费兜底常年撞访客验证墙成功率低，配了 Key 就没必要
    // 多等一次大概率失败的尝试，维持 TikHub 优先不变。
    if (socialPlatform.id === 'xiaohongshu') {
      const freeFallbacks = buildSocialFreeFallbackOrder(socialPlatform.id, cleanUrl, base, options, includeCover);
      for (const attempt of freeFallbacks) {
        const meta = await attempt();
        if (meta) return meta;
      }
      try {
        return await viaTikhub();
      } catch (err) {
        const viaScreenshot = await tryWebviewSnapshotFallback(cleanUrl, socialCfg, base);
        if (viaScreenshot) return viaScreenshot;
        console.warn('[link-card-enhancer] social link resolve failed', err);
        throw err;
      }
    }
    try {
      return await viaTikhub();
    } catch (err) {
      const fallbacks = buildSocialFreeFallbackOrder(socialPlatform.id, cleanUrl, base, options, includeCover);
      for (const attempt of fallbacks) {
        const meta = await attempt();
        if (meta) return meta;
      }
      const viaScreenshot = await tryWebviewSnapshotFallback(cleanUrl, socialCfg, base);
      if (viaScreenshot) return viaScreenshot;
      console.warn('[link-card-enhancer] social link resolve failed', err);
      throw err;
    }
  }
  if (socialDeep && !tikhubReady) {
    const fallbacks = buildSocialFreeFallbackOrder(socialPlatform.id, cleanUrl, base, options, includeCover);
    for (const attempt of fallbacks) {
      const meta = await attempt();
      if (meta) return meta;
    }
    if (socialCfg?.webviewFallbackEnabled) {
      const viaScreenshot = await tryWebviewSnapshotFallback(cleanUrl, socialCfg, base);
      if (viaScreenshot) return viaScreenshot;
    }
    return buildSocialShallowMetadata(cleanUrl, base, options);
  }
  if (socialPlatform?.id === 'bilibili') {
    // B 站 __INITIAL_STATE__ 解析比小红书更稳（BV 号不会像分享令牌那样过期），永久优先于 TikHub；
    // 配了 Key 时只在缓存里刚好已经有解析结果（比如兴趣页刚搜到过这条）才顺手复用，不为它专门
    // 发起一次新调用去抢免费路径能拿到的信息。
    const cached = tikhubReady ? await getSocialLinkResolveCached(cleanUrl, socialCfg).catch(() => null) : null;
    if (cached) {
      return mergeSocialResolvedMetadata(cleanUrl, base, {
        platform: 'bilibili',
        title: cached.title,
        desc: cached.desc,
        cover: cached.cover,
        images: cached.images,
        url: cached.url || cleanUrl,
        author: cached.author ? { name: cached.author } : undefined,
      }, includeCover, false);
    }
    const fallbacks = buildSocialFreeFallbackOrder('bilibili', cleanUrl, base, options, includeCover);
    for (const attempt of fallbacks) {
      const meta = await attempt();
      if (meta) return meta;
    }
    if (!tikhubReady && socialCfg?.webviewFallbackEnabled) {
      const viaScreenshot = await tryWebviewSnapshotFallback(cleanUrl, socialCfg, base);
      if (viaScreenshot) return viaScreenshot;
    }
    return buildSocialShallowMetadata(cleanUrl, base, options);
  }
  if (socialPlatform?.id === 'taobao') {
    // 发送淘宝链接时只做后台静默解析。短链经常经由登录/风控页跳转，自动启动原生网页窗既会
    // 打断聊天，也可能连续触发隐私拦截提示；用户主动点卡片时仍可正常打开商品页。
    const viaUnfurl = await trySocialLinkUnfurl(cleanUrl, base, { ...options, includeCover });
    if (viaUnfurl) return sanitizeDisplayMetadata(cleanUrl, viaUnfurl);
    const localOnly = buildLocalShareMetadata(cleanUrl, base, options);
    if (localOnly) return sanitizeDisplayMetadata(cleanUrl, localOnly);
    return sanitizeDisplayMetadata(cleanUrl, buildSocialShallowMetadata(cleanUrl, base, options));
  }

  const cfg = await loadWebSearchConfig().catch(() => null);
  const displayBase = includeCover ? base : stripCoverMetadata(base);
  if (socialDeep) {
    const fallbacks = buildSocialFreeFallbackOrder(socialPlatform.id, cleanUrl, base, options, includeCover);
    for (const attempt of fallbacks) {
      const meta = await attempt();
      if (meta) return sanitizeDisplayMetadata(cleanUrl, meta);
    }
    const fastMeta = resolveSocialFastMetadata(cleanUrl, base, options, socialCfg)
      || buildSocialShallowMetadata(cleanUrl, base, options);
    return sanitizeDisplayMetadata(cleanUrl, fastMeta);
  }
  if (!cfg?.enabled || cfg.enhanceLinkCards === false || !cfg.tavilyApiKey) {
    const localOnly = buildLocalShareMetadata(cleanUrl, base, options);
    if (localOnly) return sanitizeDisplayMetadata(cleanUrl, localOnly);
    return sanitizeDisplayMetadata(cleanUrl, displayBase);
  }

  const cache = await loadCache().catch(() => ({ items: {} }));
  const ttlMs = Math.max(1, Number(cfg.cacheDays || 3) || 3) * 24 * 60 * 60 * 1000;
  const cached = cache.items?.[cleanUrl];
  if (!options.refresh && cached && Date.now() - Number(cached.updatedAt || 0) < ttlMs) {
    const cachedMeta = { ...displayBase, ...(cached.metadata || {}) };
    return sanitizeDisplayMetadata(cleanUrl, includeCover ? cachedMeta : stripCoverMetadata(cachedMeta));
  }

  try {
    const extracted = await tavilyExtract(cleanUrl, {
      includeImages: includeCover,
      extractDepth: options.extractDepth || 'basic',
    });
    const metadataNext = mergeMetadata(cleanUrl, displayBase, extracted, { includeCover });
    cache.items = {
      ...(cache.items || {}),
      [cleanUrl]: {
        url: cleanUrl,
        metadata: metadataNext,
        updatedAt: Date.now(),
      },
    };
    await saveCache(cache).catch(() => {});
    return metadataNext;
  } catch (err) {
    console.warn('[link-card-enhancer] enhance failed', err);
    const localOnly = buildLocalShareMetadata(cleanUrl, base, options);
    if (localOnly) return sanitizeDisplayMetadata(cleanUrl, localOnly);
    return sanitizeDisplayMetadata(cleanUrl, {
      ...base,
      enhanceError: String(err?.message || err || '').slice(0, 160),
    });
  }
}

/** AI/协议落库后的链接消息：异步解析封面与正文，写回 metadata 供卡片渲染。 */
export async function enhanceStoredLinkMessage(message) {
  if (!message?.id || message.type !== 'link') return message;
  const md = message.metadata || {};
  if (md.enhancedBy && !isLinkMessageMetadataStale(message)) return message;
  const targetUrl = normalizeLinkUrl(md.url || message.content || md.pendingLinkUrl || '')
    || String(md.url || message.content || '').trim();
  if (!targetUrl) return message;
  const shareText = String(md.shareText || message.content || targetUrl).trim() || targetUrl;
  try {
    const linkMeta = await enhanceLinkMetadata(targetUrl, {
      ...md,
      url: targetUrl,
      title: md.title || md.pendingLinkTitle || '',
      desc: md.desc || md.pendingLinkDesc || '',
      shareText,
    }, { shareText });
    const { saveMessage } = await import('./chat-store.js');
    const next = {
      ...message,
      type: 'link',
      content: linkMeta.url || targetUrl,
      metadata: {
        ...md,
        ...linkMeta,
        url: linkMeta.url || targetUrl,
        resolvedUrl: linkMeta.url || targetUrl,
        shareText,
        pendingLinkUrl: undefined,
        pendingLinkTitle: undefined,
        pendingLinkDesc: undefined,
        linkEnhanceFailedAt: undefined,
        linkEnhanceError: undefined,
      },
    };
    await saveMessage(next);
    return next;
  } catch (err) {
    console.warn('[link-card-enhancer] stored link enhance failed', err);
    return message;
  }
}

export async function enhanceStoredLinkMessages(messages = []) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m?.type === 'link');
  await Promise.all(list.map((m) => enhanceStoredLinkMessage(m).catch(() => m)));
}
