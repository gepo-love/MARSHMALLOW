/**
 * 微博热搜懒抓取与缓存（Tavily extract），供聊天 hook 注入真实热搜关键词。
 */
import * as db from '../db.js';
import { tavilyExtract, tavilySearch, loadWebSearchConfig } from '../web-search-tools.js';

export const WEIBO_HOT_TOPICS_CACHE_KEY = 'weiboHotTopicsCache';

const CACHE_VERSION = 1;
const REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000;
const MAX_ITEMS_PER_CATEGORY = 30;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const FRESH_AGE_MS = 24 * 60 * 60 * 1000;

/** 每源 1 次 extract；一天内允许多轮刷新调试，与 Tavily「每日搜索上限」无关 */
export const WEIBO_HOT_MODULE_QUOTA_PER_DAY = 20;
const DAILY_QUOTA_HARD_LIMIT = WEIBO_HOT_MODULE_QUOTA_PER_DAY;
const DAILY_USAGE_KEY = 'weiboHotTopicsDailyUsage';

const SEARCH_FALLBACK_QUERIES = {
  general: '微博实时热搜榜 site:s.weibo.com 热搜',
  entertainment: '微博文娱榜 热搜话题 今日',
  life: '微博生活榜 热搜 今日',
  social: '微博社会榜 热搜 今日',
};

export const WEIBO_HOT_SOURCES = [
  { category: 'general', label: '综合热搜', url: 'https://s.weibo.com/top/summary/' },
  {
    category: 'entertainment',
    label: '文娱热搜',
    url: 'https://weibo.com/newlogin?tabtype=entertainment&openLoginLayer=0&url=https://weibo.com/',
  },
  {
    category: 'life',
    label: '生活热搜',
    url: 'https://weibo.com/newlogin?tabtype=life&openLoginLayer=0&url=https://weibo.com/',
  },
  {
    category: 'social',
    label: '社会热搜',
    url: 'https://weibo.com/newlogin?tabtype=social&openLoginLayer=0&url=https://weibo.com/',
  },
];

let _refreshInFlight = null;

async function loadCache() {
  try {
    const row = await db.get('settings', WEIBO_HOT_TOPICS_CACHE_KEY);
    const v = row?.value;
    if (!v || v.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, updatedAt: 0, byCategory: {} };
    }
    return v;
  } catch (e) {
    return { version: CACHE_VERSION, updatedAt: 0, byCategory: {} };
  }
}

async function saveCache(cache, { touchUpdatedAt = false } = {}) {
  await db.put('settings', {
    key: WEIBO_HOT_TOPICS_CACHE_KEY,
    value: {
      ...cache,
      version: CACHE_VERSION,
      updatedAt: touchUpdatedAt ? Date.now() : Number(cache?.updatedAt || 0),
    },
  });
}

async function getDailyUsage() {
  const row = await db.get('settings', DAILY_USAGE_KEY);
  const today = new Date().toISOString().slice(0, 10);
  const v = row?.value;
  if (!v || v.date !== today) return { date: today, used: 0 };
  return v;
}

async function bumpDailyUsage(n = 1) {
  const cur = await getDailyUsage();
  const next = { date: cur.date, used: cur.used + n };
  await db.put('settings', { key: DAILY_USAGE_KEY, value: next });
  return next;
}

async function canSpendQuota(n = 1) {
  const cur = await getDailyUsage();
  return cur.used + n <= DAILY_QUOTA_HARD_LIMIT;
}

export function resetWeiboHotModuleDailyUsage() {
  const today = new Date().toISOString().slice(0, 10);
  return db.put('settings', { key: DAILY_USAGE_KEY, value: { date: today, used: 0 } });
}

function buildExtractBlob(extractResult) {
  const parts = [];
  const summary = String(extractResult?.summary || '').trim();
  if (summary) parts.push(summary);
  const topTitle = String(extractResult?.title || '').trim();
  if (topTitle) parts.push(topTitle);
  const rows = Array.isArray(extractResult?.results) ? extractResult.results : [];
  for (const r of rows) {
    const t = String(r?.title || '').trim();
    if (t) parts.push(t);
    for (const k of ['content', 'raw_content']) {
      const c = String(r?.[k] || '').trim();
      if (c) parts.push(c);
    }
  }
  return parts.join('\n');
}

function stripHtmlish(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]{0,200}?>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoiseKeyword(w) {
  const t = String(w || '').trim();
  if (t.length < 2 || t.length > 36) return true;
  if (/https?:/i.test(t)) return true;
  if (/weibo\.com/i.test(t)) return true;
  if (/\]\s*\(/i.test(t)) return true;
  if (/^["'`「『]/.test(t)) return true;
  if (/^\s*(?:tv|hot)\s+[「"']/i.test(t)) return true;
  if (/^_.{0,10}_$/.test(t)) return true;
  if (/随时随地发现新鲜事|不支持内嵌视频|抱歉.?您的浏览器/.test(t)) return true;
  if (/微博搜索\s*[#＃]|##\s*微博|热搜榜\.\s*##/.test(t)) return true;
  if (/favicon|\.(?:png|jpe?g|gif|webp)\b/i.test(t)) return true;
  if (/\)\s*\.\s*\[|^\[+登录|\[登录/.test(t)) return true;
  if (/^(登录|注册|微博|新浪网|手机微博|展开|更多|热搜榜|实时热点|点击查看|关于微博|返回顶部|Copyright|首页|推荐|视频|消息)$/i.test(t)) return true;
  if (/^[0-9\s.]+$/.test(t)) return true;
  if (/^[a-zA-Z]{1,12}$/.test(t)) return true;
  return false;
}

/**
 * 从任意文本块解析热搜词（兼容单行、无换行、|·/ 分隔、话题 #xxx#）
 */
export function parseHotKeywordsFromBlob(rawBlob) {
  let blob = stripHtmlish(rawBlob);
  if (!blob) return [];

  blob = blob
    .replace(/\s*\/\s*/g, '\n')
    .replace(/\s*[|｜·•]+\s*/g, '\n')
    .replace(/\s{2,}/g, ' ');

  const items = [];
  const seen = new Set();
  let rank = 0;
  const pushKw = (kw, hotValue = 0) => {
    let k = String(kw || '').trim().replace(/^#+|#+$/g, '');
    k = k.replace(/[:：]\s*$/, '').trim();
    k = k.replace(/\s*热度值\s*[：:]\s*\d[\d,\s]*/gi, '').trim();
    k = k.replace(/\s*阅读\s*[：:]?\s*\d[\d,\s万wW]*/gi, '').trim();
    k = k.replace(/\s+\d{5,}\s*$/g, '').trim();
    k = k.replace(/([\u4e00-\u9fff])\d{6,}\s*$/g, '$1').trim();
    k = k.replace(/\.+$/g, '').trim();
    if (isNoiseKeyword(k)) return;
    if (seen.has(k)) return;
    seen.add(k);
    rank += 1;
    items.push({
      rank,
      keyword: k,
      hotValue: Number(hotValue) || 0,
      fetchedAt: Date.now(),
      lastUsedInChats: {},
    });
  };

  const tagRe = /#([^#\s]{2,32})#/g;
  let tm;
  while ((tm = tagRe.exec(blob)) !== null) {
    pushKw(tm[1], 0);
    if (items.length >= MAX_ITEMS_PER_CATEGORY) return items;
  }

  const lines = blob.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const tryLine = (line) => {
    const cleaned = String(line || '').trim();
    if (!cleaned) return;
    const mRank = cleaned.match(/^(\d{1,2})[\.\s、:：\-]+(.{2,36}?)(?:\s+(\d{2,})(?:\s*万)?)?\s*$/);
    if (mRank) {
      pushKw(mRank[2].trim(), mRank[3] ? Number(mRank[3]) : 0);
      return;
    }
    const mRank2 = cleaned.match(/^(\d{1,2})\s+([\u4e00-\u9fff][^\d]{1,34})$/);
    if (mRank2) {
      pushKw(mRank2[2].trim(), 0);
      return;
    }
    if (
      cleaned.length >= 2
      && cleaned.length <= 40
      && !/^\d+$/.test(cleaned)
      && /[\u4e00-\u9fff]/.test(cleaned)
      && !/https?:/i.test(cleaned)
      && !/weibo\.com/i.test(cleaned)
      && !/\]\s*\(/i.test(cleaned)
    ) {
      pushKw(cleaned, 0);
    }
  };

  for (const line of lines) {
    tryLine(line);
    if (items.length >= MAX_ITEMS_PER_CATEGORY) return items;
  }

  if (items.length === 0 && blob.length > 40) {
    const g1 = /(\d{1,2})[\.\s、:：\-]+([\u4e00-\u9fff][\u4e00-\u9fff\w·\-]{1,30})/g;
    let gm;
    while ((gm = g1.exec(blob)) !== null) {
      pushKw(gm[2].trim(), 0);
      if (items.length >= MAX_ITEMS_PER_CATEGORY) break;
    }
  }

  return items.slice(0, MAX_ITEMS_PER_CATEGORY);
}

/**
 * @param {object} extractResult - tavilyExtract 非 raw 返回值
 */
export function parseHotKeywordsFromExtract(extractResult) {
  const blob = buildExtractBlob(extractResult);
  return parseHotKeywordsFromBlob(blob);
}

function tavilyOnlyOptions(options = {}) {
  return {
    ...options,
    force: true,
    config: {
      ...(options.config || {}),
      provider: 'tavily',
    },
  };
}

async function searchFallbackForCategory(source) {
  const q = SEARCH_FALLBACK_QUERIES[source.category] || SEARCH_FALLBACK_QUERIES.general;
  const res = await tavilySearch(q, tavilyOnlyOptions({ maxResults: 8, category: `weibo_hot:${source.category}` }));
  const tops = Array.isArray(res?.results) ? res.results : [];
  const blob = tops.map((r) => [r.title, r.content].filter(Boolean).join('\n')).join('\n');
  return parseHotKeywordsFromBlob(blob);
}

async function trySearchFallbackForCategory(source) {
  try {
    return await searchFallbackForCategory(source);
  } catch (e) {
    console.warn('[weibo-hot] search fallback failed:', source.category, e?.message);
    return [];
  }
}

async function fetchOneCategory(source) {
  if (!await canSpendQuota(1)) {
    return { fetched: null, error: new Error('微博热搜模块今日抓取配额已用完') };
  }

  let items = [];
  let extractError = null;
  let spentQuota = false;
  try {
    const result = await tavilyExtract([source.url], tavilyOnlyOptions({ extractDepth: 'advanced', includeImages: false }));
    await bumpDailyUsage(1);
    spentQuota = true;
    items = parseHotKeywordsFromExtract(result);
  } catch (e) {
    console.warn('[weibo-hot] fetch failed:', source.category, e?.message);
    extractError = e;
  }

  if (items.length === 0) {
    try {
      items = await searchFallbackForCategory(source);
      if (!spentQuota) await bumpDailyUsage(1);
    } catch (searchError) {
      console.warn('[weibo-hot] search fallback failed:', source.category, searchError?.message);
      const reasons = [extractError, searchError]
        .map((e) => String(e?.message || '').trim())
        .filter((value, index, list) => value && list.indexOf(value) === index);
      return { fetched: null, error: new Error(reasons.join('；') || 'Tavily 请求失败') };
    }
  }

  if (items.length === 0) {
    return { fetched: null, error: new Error('Tavily 已返回，但未解析到热搜条目') };
  }
  return { fetched: { fetchedAt: Date.now(), items }, error: null };
}

export async function maybeRefreshWeiboHotTopics({ force = false } = {}) {
  if (_refreshInFlight) return _refreshInFlight;

  const refreshTask = (async () => {
    const cfg = await loadWebSearchConfig();
    if (!cfg?.enabled) throw new Error('请先启用搜索 API');
    if (!cfg.tavilyApiKey) throw new Error('请先填写并保存 Tavily API Key');

    const cache = await loadCache();
    const age = Date.now() - Number(cache.updatedAt || 0);
    if (!force && age < REFRESH_INTERVAL_MS) {
      return { refreshed: false, reason: 'fresh_cache', categoryCount: 0, totalCount: 0, failures: [] };
    }

    const newByCategory = { ...(cache.byCategory || {}) };
    const failures = [];
    let categoryCount = 0;
    for (const source of WEIBO_HOT_SOURCES) {
      const outcome = await fetchOneCategory(source);
      if (outcome?.fetched) {
        newByCategory[source.category] = outcome.fetched;
        categoryCount += 1;
      } else {
        failures.push({
          category: source.category,
          label: source.label,
          reason: String(outcome?.error?.message || '未获取到数据'),
        });
      }
    }

    if (categoryCount === 0) {
      const firstReason = failures[0]?.reason || 'Tavily 未返回可用结果';
      throw new Error(`未获取到热搜：${firstReason}`);
    }

    await saveCache({ ...cache, byCategory: newByCategory }, { touchUpdatedAt: true });
    const totalCount = Object.values(newByCategory).reduce((sum, group) => (
      sum + (Array.isArray(group?.items) ? group.items.length : 0)
    ), 0);
    return { refreshed: true, categoryCount, totalCount, failures };
  })();

  _refreshInFlight = refreshTask;
  try {
    return await refreshTask;
  } finally {
    if (_refreshInFlight === refreshTask) _refreshInFlight = null;
  }
}

export async function getWeiboHotDebugSnapshot() {
  const cfg = await loadWebSearchConfig().catch(() => ({}));
  const cache = await loadCache();
  const daily = await getDailyUsage();
  const countWithSummary = (items) => (Array.isArray(items) ? items.filter((x) => String(x?.summary || '').trim()).length : 0);
  const categories = {
    general: Array.isArray(cache?.byCategory?.general?.items) ? cache.byCategory.general.items.length : 0,
    entertainment: Array.isArray(cache?.byCategory?.entertainment?.items) ? cache.byCategory.entertainment.items.length : 0,
    life: Array.isArray(cache?.byCategory?.life?.items) ? cache.byCategory.life.items.length : 0,
    social: Array.isArray(cache?.byCategory?.social?.items) ? cache.byCategory.social.items.length : 0,
  };
  const categoriesWithSummary = {
    general: countWithSummary(cache?.byCategory?.general?.items),
    entertainment: countWithSummary(cache?.byCategory?.entertainment?.items),
    life: countWithSummary(cache?.byCategory?.life?.items),
    social: countWithSummary(cache?.byCategory?.social?.items),
  };
  return {
    now: Date.now(),
    config: {
      enabled: !!cfg?.enabled,
      hasApiKey: !!cfg?.tavilyApiKey,
      dailyLimit: Number(cfg?.dailyLimit || 0),
      provider: String(cfg?.provider || ''),
    },
    cache: {
      updatedAt: Number(cache?.updatedAt || 0),
      categories,
      categoriesWithSummary,
      totalCount: Object.values(categories).reduce((a, b) => a + b, 0),
      totalWithSummary: Object.values(categoriesWithSummary).reduce((a, b) => a + b, 0),
    },
    quota: {
      date: daily?.date || '',
      used: Number(daily?.used || 0),
      hardLimit: DAILY_QUOTA_HARD_LIMIT,
      remaining: Math.max(0, DAILY_QUOTA_HARD_LIMIT - Number(daily?.used || 0)),
    },
  };
}

/**
 * 逐源诊断（默认不落库）：用于定位“点刷新没增长”的原因。
 * runExtract=true 会真实调用 Tavily extract（会消耗 Tavily 配额，但不入本模块缓存）。
 */
export async function diagnoseWeiboHotSources({ runExtract = false } = {}) {
  const snapshot = await getWeiboHotDebugSnapshot();
  const out = {
    ...snapshot,
    checks: [],
  };
  for (const src of WEIBO_HOT_SOURCES) {
    const row = {
      category: src.category,
      label: src.label,
      url: src.url,
      runExtract: !!runExtract,
      ok: false,
      reason: '',
      parsedCount: 0,
      sampleKeywords: [],
      rawCharLength: 0,
      rawPreview: '',
      viaSearchFallback: false,
      searchParsedCount: 0,
    };
    if (!snapshot.config.enabled) {
      row.reason = 'web_search_disabled';
      out.checks.push(row);
      continue;
    }
    if (!snapshot.config.hasApiKey) {
      row.reason = 'missing_tavily_key';
      out.checks.push(row);
      continue;
    }
    if (!runExtract) {
      row.ok = true;
      row.reason = 'skipped_extract';
      out.checks.push(row);
      continue;
    }
    try {
      const extracted = await tavilyExtract([src.url], tavilyOnlyOptions({ extractDepth: 'advanced', includeImages: false }));
      const blob = buildExtractBlob(extracted);
      row.rawCharLength = blob.length;
      row.rawPreview = blob.slice(0, 1200);
      let parsed = parseHotKeywordsFromExtract(extracted);
      if (parsed.length === 0) {
        const viaSearch = await trySearchFallbackForCategory(src);
        row.viaSearchFallback = viaSearch.length > 0;
        row.searchParsedCount = viaSearch.length;
        parsed = viaSearch;
      }
      row.ok = parsed.length > 0;
      row.reason = row.ok
        ? (row.viaSearchFallback ? 'ok_via_search' : 'ok')
        : 'empty_after_parse_and_search';
      row.parsedCount = parsed.length;
      row.sampleKeywords = parsed.slice(0, 5).map((x) => x.keyword);
    } catch (e) {
      row.ok = false;
      row.reason = String(e?.message || e || 'extract_failed');
    }
    out.checks.push(row);
  }
  return out;
}

async function ensureHotTopicSummary(cache, category, keyword) {
  const group = cache?.byCategory?.[category];
  if (!group?.items) return null;
  const item = group.items.find((x) => x.keyword === keyword);
  if (!item) return null;

  const existing = String(item.summary || '').trim();
  if (existing) return existing;

  const cfg = await loadWebSearchConfig().catch(() => null);
  if (!cfg?.enabled || !cfg.tavilyApiKey) return null;
  if (!await canSpendQuota(1)) return null;

  try {
    const res = await tavilySearch(keyword, tavilyOnlyOptions({
      maxResults: 4,
      searchDepth: 'advanced',
      includeImages: false,
      includeImageDescriptions: false,
      category: `weibo_hot_summary:${category}`,
    }));
    await bumpDailyUsage(1);
    const parts = [];
    const baseSummary = String(res?.summary || '').trim();
    if (baseSummary) parts.push(baseSummary);
    const rows = Array.isArray(res?.results) ? res.results : [];
    for (const r of rows) {
      const t = String(r?.title || '').trim();
      const c = String(r?.content || '').trim();
      const line = [t, c].filter(Boolean).join('：');
      if (line) parts.push(line);
      if (parts.join('\n').length > 900) break;
    }
    const merged = parts.join('\n').replace(/\s{3,}/g, '\n').slice(0, 900).trim();
    if (!merged) return null;
    item.summary = merged;
    item.summaryFetchedAt = Date.now();
    await saveCache(cache);
    return merged;
  } catch (e) {
    console.warn('[weibo-hot] summary fetch failed:', keyword, e?.message);
    return null;
  }
}

/**
 * @param {{ chatId: string, categoryPreferences?: object, enrich?: boolean, excludeKeyword?: string }} args
 *   enrich=true 时若选中条目缺摘要，会按需消耗模块日配额调一次 Tavily search 拿事件简介并写回缓存。
 *   excludeKeyword：与其它候选并存时跳过该词，减少连续两轮抽到同一条。
 */
export async function pickWeiboHotTopicForChat({
  chatId,
  categoryPreferences = null,
  enrich = false,
  excludeKeyword = '',
} = {}) {
  const id = String(chatId || '').trim();
  if (!id) return null;

  const cache = await loadCache();
  const byCat = cache.byCategory || {};
  if (Object.keys(byCat).length === 0) return null;

  const prefs = categoryPreferences || { general: 1, entertainment: 1, life: 1, social: 1 };
  const now = Date.now();
  const pool = [];

  for (const [cat, group] of Object.entries(byCat)) {
    const w = Number(prefs[cat] || 0);
    if (w <= 0) continue;
    for (const item of group.items || []) {
      const age = now - Number(item.fetchedAt || 0);
      if (age > MAX_AGE_MS) continue;
      const usedAt = Number(item.lastUsedInChats?.[id] || 0);
      if (usedAt > 0) continue;
      const freshnessFactor = age > FRESH_AGE_MS ? 0.3 : 1;
      pool.push({ item, category: cat, weight: w * freshnessFactor });
    }
  }

  if (pool.length === 0) return null;

  const ex = String(excludeKeyword || '').trim();
  const poolNoRepeat = ex && pool.length > 1
    ? pool.filter((p) => String(p.item?.keyword || '').trim() !== ex)
    : pool;
  const usePool = poolNoRepeat.length ? poolNoRepeat : pool;

  const totalWeight = usePool.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * totalWeight;
  let pickedRef = usePool[usePool.length - 1];
  for (const p of usePool) {
    r -= p.weight;
    if (r <= 0) {
      pickedRef = p;
      break;
    }
  }
  const picked = { ...pickedRef.item, category: pickedRef.category };
  if (enrich) {
    const summary = await ensureHotTopicSummary(cache, picked.category, picked.keyword).catch(() => null);
    if (summary) {
      picked.summary = summary;
      picked.summaryFetchedAt = Date.now();
    }
  }
  return picked;
}

export async function getWeiboHotTopicSnapshot({ limit = 8, refresh = true, enrichSummaryLimit = 0 } = {}) {
  if (refresh) {
    await maybeRefreshWeiboHotTopics().catch(() => {});
  }
  const cache = await loadCache();
  const byCat = cache.byCategory || {};
  const now = Date.now();
  const rows = [];
  for (const [category, group] of Object.entries(byCat)) {
    const fetchedAt = Number(group?.fetchedAt || cache.updatedAt || 0);
    for (const item of group?.items || []) {
      const keyword = String(item?.keyword || '').trim();
      if (!keyword) continue;
      const itemFetchedAt = Number(item.fetchedAt || fetchedAt || 0);
      if (itemFetchedAt && now - itemFetchedAt > MAX_AGE_MS) continue;
      rows.push({
        category,
        keyword,
        tag: `#${keyword.replace(/^#|#$/g, '')}#`,
        rank: Number(item.rank || 99),
        hotValue: Number(item.hotValue || 0),
        summary: String(item.summary || '').trim(),
        fetchedAt: itemFetchedAt || fetchedAt,
      });
    }
  }
  rows.sort((a, b) => {
    const freshDelta = Number(b.fetchedAt || 0) - Number(a.fetchedAt || 0);
    if (Math.abs(freshDelta) > 60 * 60 * 1000) return freshDelta;
    return (a.rank || 99) - (b.rank || 99) || (b.hotValue || 0) - (a.hotValue || 0);
  });
  const deduped = [];
  const seen = new Set();
  for (const item of rows) {
    if (seen.has(item.keyword)) continue;
    seen.add(item.keyword);
    deduped.push(item);
    if (deduped.length >= Math.max(1, Math.min(20, Number(limit || 8)))) break;
  }
  const enrichCount = Math.max(0, Math.min(deduped.length, Number(enrichSummaryLimit || 0)));
  for (let i = 0; i < enrichCount; i += 1) {
    if (deduped[i].summary) continue;
    const summary = await ensureHotTopicSummary(cache, deduped[i].category, deduped[i].keyword).catch(() => null);
    if (summary) deduped[i].summary = summary;
  }
  return {
    updatedAt: Number(cache.updatedAt || 0),
    topics: deduped,
  };
}

function buildRecentConversationHaystack(recentMessages, maxMsgs = 14) {
  const visible = [...(Array.isArray(recentMessages) ? recentMessages : [])]
    .filter((m) => m && m.senderId !== 'system' && m.type !== 'system' && !m.deleted && !m.recalled)
    .slice(-maxMsgs);
  return visible.map((m) => String(m?.content || m?.metadata?.text || '').trim()).filter(Boolean).join('\n');
}

/**
 * 近期对话（含用户与角色）是否出现微博/热搜相关提法，用于主动注入热搜上下文。
 */
export function recentMessagesMentionWeiboHot(recentMessages) {
  const hay = buildRecentConversationHaystack(recentMessages, 18);
  if (!hay) return false;
  if (/(微博|新浪微博|微型博客)/.test(hay)) return true;
  if (/(wb\b|weibo)/i.test(hay)) return true;
  if (/(热搜|熱搜|话题榜|实时热点|文娱热搜|社会热搜|微博榜|热一)/.test(hay)) return true;
  if (/(上热搜|挂热搜|冲热搜|热搜榜|爆了|沸了)/.test(hay)) return true;
  if (/超话/.test(hay)) return true;
  return false;
}

/**
 * 用户/对话主动聊起热搜时：优先选与近期台词重叠度最高的缓存词条，否则按分区权重随机；可选 enrich 摘要。
 * 不按 chatId 消耗 lastUsedInChats，便于同一聊天内多次讨论。
 * excludeKeyword：上一轮已注入的词，有其他候选时优先换一条，避免连续多轮同一条。
 */
export async function pickWeiboHotTopicForUserIntent({
  recentMessages,
  categoryPreferences = null,
  enrich = true,
  excludeKeyword = '',
} = {}) {
  const hay = buildRecentConversationHaystack(recentMessages, 20);
  const cache = await loadCache();
  const byCat = cache.byCategory || {};
  const prefs = categoryPreferences || { general: 1, entertainment: 1, life: 1, social: 1 };
  const now = Date.now();
  const candidates = [];
  const ex = String(excludeKeyword || '').trim();
  const withoutEx = (list) => {
    if (!ex || !Array.isArray(list) || list.length <= 1) return list;
    const next = list.filter((c) => String(c.item?.keyword || '').trim() !== ex);
    return next.length ? next : list;
  };
  for (const [cat, group] of Object.entries(byCat)) {
    const w = Number(prefs[cat] || 0);
    if (w <= 0) continue;
    for (const item of group.items || []) {
      const age = now - Number(item.fetchedAt || 0);
      if (age > MAX_AGE_MS) continue;
      const kw = String(item.keyword || '').trim();
      if (!kw) continue;
      let score = 0;
      if (hay.includes(kw)) score += kw.length * 10;
      const segs = kw.split(/[\s、，,.]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
      for (const s of segs) {
        if (hay.includes(s)) score += s.length * 5;
      }
      candidates.push({ item, category: cat, weight: w, score });
    }
  }
  if (!candidates.length) return null;
  const scoredHits = candidates.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || b.weight - a.weight);
  const withHit = withoutEx(scoredHits);
  let pickedRef = withHit.length ? withHit[0] : null;
  if (!pickedRef) {
    const zeros = withoutEx(candidates.filter((c) => c.score === 0));
    const pool = zeros.length ? zeros : withoutEx(candidates);
    const tw = pool.reduce((s, p) => s + p.weight, 0);
    let r = Math.random() * tw;
    for (const p of pool) {
      r -= p.weight;
      if (r <= 0) {
        pickedRef = p;
        break;
      }
    }
    pickedRef = pickedRef || pool[pool.length - 1];
  }
  const picked = { ...pickedRef.item, category: pickedRef.category };
  if (enrich) {
    const summary = await ensureHotTopicSummary(cache, picked.category, picked.keyword).catch(() => null);
    if (summary) {
      picked.summary = summary;
      picked.summaryFetchedAt = Date.now();
    }
  }
  return picked;
}

export async function markWeiboHotTopicUsedInChat({ chatId, category, keyword } = {}) {
  const id = String(chatId || '').trim();
  const cat = String(category || '').trim();
  const kw = String(keyword || '').trim();
  if (!id || !cat || !kw) return;

  const cache = await loadCache();
  const group = cache.byCategory?.[cat];
  if (!group?.items) return;
  const item = group.items.find((x) => x.keyword === kw);
  if (!item) return;
  item.lastUsedInChats = { ...(item.lastUsedInChats || {}), [id]: Date.now() };
  await saveCache(cache);
}

/**
 * 显式强制刷新某条热搜的事件摘要（忽略已缓存的 summary）。
 * 主要用于设置页里的"重抓事件摘要"调试。
 */
export async function refreshHotTopicSummary({ category, keyword } = {}) {
  const cat = String(category || '').trim();
  const kw = String(keyword || '').trim();
  if (!cat || !kw) return null;
  const cache = await loadCache();
  const item = cache?.byCategory?.[cat]?.items?.find((x) => x.keyword === kw);
  if (!item) return null;
  item.summary = '';
  return ensureHotTopicSummary(cache, cat, kw);
}
