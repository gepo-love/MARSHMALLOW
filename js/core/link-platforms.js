/** 链接分享的平台识别 + 关键词提取（不依赖任何抓取/反爬，只用 URL host 和分享文本本身）。 */

const PLATFORM_RULES = [
  { id: 'xiaohongshu', label: '小红书', color: '#ff2442', mono: '红', hostRe: /(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.(?:com|cn)$/i },
  { id: 'weibo', label: '微博', color: '#ff8200', mono: '博', hostRe: /(?:^|\.)?(?:www\.|m\.)?weibo\.(?:com|cn)$|(^|\.)m\.weibo\.cn$|^t\.cn$/i },
  { id: 'douyin', label: '抖音', color: '#fe2c55', mono: '抖', hostRe: /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i },
  { id: 'bilibili', label: 'B站', color: '#fb7299', mono: 'B', hostRe: /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/i },
  { id: 'zhihu', label: '知乎', color: '#0084ff', mono: '知', hostRe: /(^|\.)zhihu\.com$/i },
  { id: 'douban', label: '豆瓣', color: '#00a685', mono: '瓣', hostRe: /(^|\.)douban\.com$/i },
  { id: 'wechat', label: '公众号', color: '#07c160', mono: '公', hostRe: /(^|\.)weixin\.qq\.com$/i },
  { id: 'taobao', label: '淘宝', color: '#ff4400', mono: '淘', hostRe: /(^|\.)taobao\.com$|(^|\.)tmall\.(?:com|hk)$|(^|\.)tb\.cn$/i },
  { id: 'jd', label: '京东', color: '#e3101e', mono: '东', hostRe: /(^|\.)jd\.com$/i },
  { id: 'pdd', label: '拼多多', color: '#e2231a', mono: '拼', hostRe: /(^|\.)pinduoduo\.com$|(^|\.)yangkeduo\.com$/i },
  { id: 'xiaomi', label: '小米商城', color: '#ff6900', mono: '米', hostRe: /(^|\.)mi\.com$/i },
  { id: 'youtube', label: 'YouTube', color: '#ff0000', mono: '▶', hostRe: /(^|\.)youtube\.com$|^youtu\.be$/i },
  { id: 'twitter', label: 'X', color: '#111111', mono: 'X', hostRe: /(^|\.)twitter\.com$|(^|\.)x\.com$/i },
  { id: 'github', label: 'GitHub', color: '#24292f', mono: 'GH', hostRe: /(^|\.)github\.com$/i },
  { id: 'zhihu_zhuanlan', label: '知乎', color: '#0084ff', mono: '知', hostRe: /(^|\.)zhuanlan\.zhihu\.com$/i },
];

const INTERNAL_PLATFORMS = {
  weibo: { id: 'weibo', label: '微博', color: '#ff8200', mono: '博' },
  forum: { id: 'forum', label: '论坛', color: '#5c7b8f', mono: '论' },
};

function safeHost(url = '') {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 根据 URL（或内部协议 weibo://、forum://）识别平台，识别不到时返回通用兜底。 */
export function detectLinkPlatform(url = '') {
  const raw = String(url || '').trim();
  const internalMatch = raw.match(/^(weibo|forum):\/\//i);
  if (internalMatch) {
    const key = internalMatch[1].toLowerCase();
    return INTERNAL_PLATFORMS[key] || null;
  }
  const host = safeHost(raw);
  if (!host) return null;
  const rule = PLATFORM_RULES.find((r) => r.hostRe.test(host));
  if (rule) return { id: rule.id, label: rule.label, color: rule.color, mono: rule.mono };
  return null;
}

/** 从分享文本里提取话题标签（#话题#、#话题）当关键词，不做任何联网请求。 */
export function extractShareKeywords(text = '', max = 6) {
  const raw = String(text || '');
  const tags = [];
  const seen = new Set();
  const pushTag = (tag) => {
    const clean = String(tag || '').trim().replace(/[#\s]+$/g, '');
    if (!clean || clean.length > 24) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(clean);
  };
  const pairedRe = /#([^#\s]{1,24})#/g;
  let m;
  while ((m = pairedRe.exec(raw)) && tags.length < max) pushTag(m[1]);
  if (tags.length < max) {
    const withoutPaired = raw.replace(pairedRe, ' ');
    const singleRe = /#([^\s#，。！？、,.!?]{1,24})/g;
    while ((m = singleRe.exec(withoutPaired)) && tags.length < max) pushTag(m[1]);
  }
  return tags.slice(0, max);
}
