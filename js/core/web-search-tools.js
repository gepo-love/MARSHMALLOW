import * as db from './db.js';
import { logSearchCall } from './search-usage-log.js';
import { isNativeShell } from './native-update-bridge.js';
import { getNativeAccessToken } from './native-license-heartbeat.js';

export const WEB_SEARCH_CONFIG_KEY = 'webSearchConfig';

// Exa 官方明确不对浏览器/App 跨域开放（直连会泄漏 Key，会被 CORS 拦，请求根本到不了
// Exa 服务器——这也是 Exa 后台看不到用量的原因），所以和小红书/微博一样经这个 Worker 转发。
const WORKER_ORIGIN = '';
const EXA_SEARCH_PROXY_PATH = '/api/search/exa';

function resolveWorkerProxyPath(path = '') {
  return isNativeShell() ? `${WORKER_ORIGIN}${path}` : path;
}

/** 原生壳是跨域请求，Worker 门禁靠 Authorization 头里的站内登录 token 认人
 * （见 native-license-heartbeat.js），不能被第三方 Key 占用。 */
function accessAuthHeaders() {
  if (!isNativeShell()) return {};
  const token = getNativeAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const DEFAULT_WEB_SEARCH_CONFIG = {
  enabled: false,
  provider: 'tavily',
  tavilyApiKey: '',
  exaApiKey: '',
  exaEnabled: false,
  braveApiKey: '',
  braveEnabled: false,
  serpApiKey: '',
  serpApiEnabled: false,
  searchApiKey: '',
  searchApiEnabled: false,
  providerPoolEnabled: true,
  mode: 'local_plus_web',
  dailyLimit: 10,
  cacheDays: 3,
  maxResults: 5,
  includeImages: false,
  includeImageDescriptions: false,
  includeRawContent: false,
  tavilyChunksPerSource: 3,
  tavilyAutoParameters: false,
  enhanceLinkCards: false,
  materialCurationEnabled: true,
  domainMode: 'broad',
  // 聊天联网查证（need_search 逃生口）：全局搜索开启时默认可用；用户显式关闭仍优先
  needSearchEnabled: true,
  needSearchDailyLimit: 12,
};

export function mergeWebSearchConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_WEB_SEARCH_CONFIG,
    ...source,
    needSearchEnabled: source.needSearchEnabled !== false,
  };
}

export async function loadWebSearchConfig() {
  const row = await db.get('settings', WEB_SEARCH_CONFIG_KEY);
  return mergeWebSearchConfig(row?.value || {});
}

export async function saveWebSearchConfig(config = {}) {
  const next = mergeWebSearchConfig(config);
  await db.put('settings', { key: WEB_SEARCH_CONFIG_KEY, value: next });
  return next;
}

function clip(value = '', max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function uniq(list, max = 12) {
  return [...new Set((Array.isArray(list) ? list : []).map((x) => clip(x, 500)).filter(Boolean))].slice(0, max);
}

export function compressTavilyResults(payload = {}, { category = '', query = '' } = {}) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const top = results.slice(0, 8).map((item) => ({
    title: clip(item.title, 80),
    content: clip(item.content || item.raw_content || item.snippet, 320),
    url: clip(item.url, 500),
    score: Number(item.score || 0) || 0,
    images: Array.isArray(item.images) ? item.images.slice(0, 4) : [],
    raw_content: clip(item.raw_content || '', 900),
  })).filter((item) => item.title || item.content);
  const images = uniq([
    ...(Array.isArray(payload.images) ? payload.images : []),
    ...results.flatMap((item) => Array.isArray(item.images) ? item.images : []),
  ], 8);
  const imageDescriptions = uniq(results.flatMap((item) => (
    Array.isArray(item.image_descriptions) ? item.image_descriptions : []
  )), 6);
  const keywords = uniq(
    top.flatMap((item) => `${item.title} ${item.content}`
      .split(/[，。！？、,.!?;；:：\s]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2 && part.length <= 18)
    ),
    12,
  );
  const summary = top
    .map((item) => [item.title, item.content].filter(Boolean).join(': '))
    .join(' / ')
    .slice(0, 520);
  return {
    id: `web:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    source: 'tavily',
    category: clip(category, 40),
    query: clip(query, 120),
    title: top[0]?.title || clip(query, 80) || 'web material',
    summary,
    keywords,
    results: top,
    images,
    imageDescriptions,
    createdAt: Date.now(),
  };
}

function normalizeSearchResults({ source = 'web', category = '', query = '', results = [], images = [] } = {}) {
  const top = (Array.isArray(results) ? results : []).slice(0, 12).map((item) => ({
    title: clip(item.title || item.name || '', 100),
    content: clip(item.content || item.snippet || item.description || item.text || '', 240),
    url: clip(item.url || item.link || '', 500),
    score: Number(item.score || 0) || 0,
    images: Array.isArray(item.images) ? item.images.slice(0, 4) : (item.image ? [item.image] : []),
  })).filter((item) => item.title || item.content || item.url);
  const allImages = uniq([
    ...(Array.isArray(images) ? images : []),
    ...top.flatMap((item) => item.images || []),
  ], 8);
  return {
    id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    source,
    category: clip(category, 40),
    query: clip(query, 160),
    title: top[0]?.title || clip(query, 100) || source,
    summary: top.map((item) => [item.title, item.content].filter(Boolean).join(': ')).join(' / ').slice(0, 520),
    keywords: uniq(top.flatMap((item) => `${item.title} ${item.content}`.split(/\s+/)), 12),
    images: allImages,
    imageDescriptions: [],
    results: top,
    createdAt: Date.now(),
  };
}

const SEARCH_DAILY_USAGE_KEY = 'webSearchDailyUsage';

function searchDayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function loadSearchDailyUsage() {
  const row = await db.get('settings', SEARCH_DAILY_USAGE_KEY).catch(() => null);
  const value = row?.value || {};
  const today = searchDayKey();
  if (value.day !== today) return { day: today, used: 0, events: [] };
  return {
    day: today,
    used: Math.max(0, Number(value.used || 0) || 0),
    events: Array.isArray(value.events) ? value.events.slice(-40) : [],
  };
}

async function bumpSearchDailyUsage(provider = '', category = '') {
  const usage = await loadSearchDailyUsage();
  await db.put('settings', {
    key: SEARCH_DAILY_USAGE_KEY,
    value: {
      day: usage.day,
      used: usage.used + 1,
      events: [...usage.events, { at: Date.now(), provider: clip(provider, 20), category: clip(category, 40) }].slice(-40),
    },
  });
}

/** 主 provider 排最前；开了「搜索池瀑布流」时，其余已启用且填了 Key 的 provider 按序垫后。 */
function resolveProviderOrder(cfg = {}) {
  const hasKey = {
    tavily: !!cfg.tavilyApiKey,
    exa: !!cfg.exaApiKey,
    brave: !!cfg.braveApiKey,
    serpapi: !!cfg.serpApiKey,
    searchapi: !!cfg.searchApiKey,
  };
  const poolEnabled = {
    tavily: true,
    exa: cfg.exaEnabled === true,
    brave: cfg.braveEnabled === true,
    serpapi: cfg.serpApiEnabled === true,
    searchapi: cfg.searchApiEnabled === true,
  };
  const primary = hasKey[cfg.provider] ? cfg.provider : '';
  const order = primary ? [primary] : [];
  if (cfg.providerPoolEnabled !== false) {
    for (const p of ['tavily', 'exa', 'brave', 'serpapi', 'searchapi']) {
      if (p !== primary && hasKey[p] && poolEnabled[p]) order.push(p);
    }
  }
  return order;
}

function callProvider(provider, query, options) {
  if (provider === 'tavily') return tavilySearch(query, options);
  if (provider === 'exa') return exaSearch(query, options);
  if (provider === 'brave') return braveSearch(query, options);
  if (provider === 'serpapi') return serpApiSearch(query, options);
  if (provider === 'searchapi') return searchApiSearch(query, options);
  return Promise.resolve(null);
}

/**
 * 统一搜索入口：按 provider 顺序瀑布式尝试（主 provider 失败/空结果时自动切下一家），
 * 并执行 dailyLimit 每日总额度（0 = 不限）。所有业务调用方都应走这里，不要自己 if-else provider。
 *
 * @param options.skipDailyLimit 手动补充类调用传 true：不检查也不占用每日总额度（仍会记调用日志，标记 manual）。
 * @param options.characterId 关联的角色 id（可选），用于「兴趣页 · 今日调用」按角色筛选。
 */
export async function runWebSearch(query, options = {}) {
  const cfg = { ...(await loadWebSearchConfig()), ...(options.config || {}) };
  if (!cfg.enabled && !options.force) throw new Error('Web search is disabled');
  const q = String(query || '').trim();
  if (!q) throw new Error('Missing search query');
  const skipLimit = options.skipDailyLimit === true;
  const limit = Math.max(0, Number(cfg.dailyLimit || 0));
  if (limit > 0 && !skipLimit) {
    const usage = await loadSearchDailyUsage();
    if (usage.used >= limit) {
      // 之前配额跳过完全不记日志，最容易被误当成"搜不到内容"——补一条 quota_exceeded
      logSearchCall({
        category: options.category, characterId: options.characterId, ok: false, query: q, manual: skipLimit,
        resultCount: 0, reason: 'quota_exceeded',
      }).catch(() => {});
      throw new Error(`今日联网搜索额度已用完（${limit} 次，可在 API 设置里调整）`);
    }
  }
  const order = resolveProviderOrder(cfg);
  if (!order.length) throw new Error('没有可用的搜索渠道（缺少 API Key）');
  let lastError = null;
  let counted = false;
  let hadEmptyResult = false;
  for (const provider of order) {
    try {
      if (typeof options.beforeProviderAttempt === 'function') {
        const gate = await options.beforeProviderAttempt(provider);
        if (gate === false || gate?.ok === false) {
          const error = new Error(gate?.reason || 'search_attempt_blocked');
          error.code = gate?.reason || 'search_attempt_blocked';
          throw error;
        }
      }
      if (!counted && !skipLimit) {
        await bumpSearchDailyUsage(provider, options.category || '').catch(() => {});
        counted = true;
      }
      const result = await callProvider(provider, q, {
        ...options,
        config: { ...cfg, provider },
      });
      if (result && Array.isArray(result.results) && result.results.length) {
        logSearchCall({
          category: options.category, provider, characterId: options.characterId, ok: true, query: q, manual: skipLimit,
          resultCount: result.results.length,
        }).catch(() => {});
        return result;
      }
      hadEmptyResult = true;
      lastError = new Error(`${provider} 没有返回结果`);
    } catch (err) {
      lastError = err;
      if (String(err?.code || '').startsWith('budget-') || err?.code === 'real-person-disabled') break;
    }
  }
  logSearchCall({
    category: options.category,
    provider: order[order.length - 1],
    characterId: options.characterId,
    ok: false,
    query: q,
    error: String(lastError?.message || lastError || ''),
    manual: skipLimit,
    resultCount: 0,
    reason: hadEmptyResult ? 'empty_result' : 'api_error',
  }).catch(() => {});
  throw lastError || new Error('搜索失败');
}

export async function tavilySearch(query, options = {}) {
  const cfg = { ...(await loadWebSearchConfig()), ...(options.config || {}) };
  if (!cfg.enabled && !options.force) throw new Error('Web search is disabled');
  if (cfg.provider !== 'tavily') throw new Error(`Unsupported search provider: ${cfg.provider}`);
  if (!cfg.tavilyApiKey) throw new Error('Missing Tavily API key');
  const body = {
    query: String(query || '').trim(),
    max_results: Math.max(1, Math.min(10, Number(options.maxResults || cfg.maxResults) || 5)),
    search_depth: options.searchDepth || 'basic',
    include_images: options.includeImages ?? cfg.includeImages,
    include_image_descriptions: options.includeImageDescriptions ?? cfg.includeImageDescriptions,
    include_raw_content: options.includeRawContent ?? cfg.includeRawContent,
  };
  const chunks = Math.max(1, Math.min(5, Math.floor(Number(options.chunksPerSource || cfg.tavilyChunksPerSource || 3) || 3)));
  if (body.search_depth === 'advanced') body.chunks_per_source = chunks;
  if (options.autoParameters ?? cfg.tavilyAutoParameters) body.auto_parameters = true;
  if (!body.query) throw new Error('Missing search query');
  if (Array.isArray(options.includeDomains) && options.includeDomains.length) {
    body.include_domains = options.includeDomains;
  }
  if (Array.isArray(options.excludeDomains) && options.excludeDomains.length) {
    body.exclude_domains = options.excludeDomains;
  }
  if (options.freshness === 'day') body.time_range = 'day';
  if (options.freshness === 'week') body.time_range = 'week';
  if (options.freshness === 'month') body.time_range = 'month';
  if (options.freshness === 'year') body.time_range = 'year';
  if (options.startDate) body.start_date = options.startDate;
  if (options.endDate) body.end_date = options.endDate;
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.tavilyApiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily search failed (${res.status}): ${text || res.statusText}`);
  }
  const payload = await res.json();
  return options.raw ? payload : compressTavilyResults(payload, { category: options.category, query: body.query });
}

export async function exaSearch(query, options = {}) {
  const cfg = { ...(await loadWebSearchConfig()), ...(options.config || {}) };
  if (!cfg.enabled && !options.force) throw new Error('Web search is disabled');
  if (!cfg.exaEnabled && cfg.provider !== 'exa' && !options.force) throw new Error('Exa search is disabled');
  if (!cfg.exaApiKey) throw new Error('Missing Exa API key');
  const body = {
    query: String(query || '').trim(),
    numResults: Math.max(1, Math.min(20, Number(options.maxResults || cfg.maxResults) || 5)),
    contents: {
      text: { maxCharacters: 600 },
      highlights: { numSentences: 2 },
    },
  };
  if (!body.query) throw new Error('Missing search query');
  if (Array.isArray(options.includeDomains) && options.includeDomains.length) {
    body.includeDomains = options.includeDomains;
  }
  if (Array.isArray(options.excludeDomains) && options.excludeDomains.length) {
    body.excludeDomains = options.excludeDomains;
  }
  if (options.freshness === 'week') {
    body.startPublishedDate = new Date(Date.now() - 7 * 86400000).toISOString();
  } else if (options.freshness === 'month') {
    body.startPublishedDate = new Date(Date.now() - 30 * 86400000).toISOString();
  }
  const res = await fetch(resolveWorkerProxyPath(EXA_SEARCH_PROXY_PATH), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Exa-Key': cfg.exaApiKey,
      ...accessAuthHeaders(),
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Exa search failed (${res.status}): ${text || res.statusText}`);
  }
  const payload = await res.json();
  const results = Array.isArray(payload.results) ? payload.results : [];
  return {
    id: `exa:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    source: 'exa',
    category: clip(options.category, 40),
    query: clip(body.query, 120),
    title: clip(results[0]?.title || body.query, 100),
    summary: results.map((item) => clip(item.text || item.highlights?.join?.(' / ') || '', 180)).filter(Boolean).join(' / ').slice(0, 520),
    keywords: uniq(results.flatMap((item) => String(item.title || '').split(/\s+/)), 12),
    images: [],
    imageDescriptions: [],
    results: results.map((item) => ({
      title: clip(item.title || '', 100),
      content: clip(item.text || item.highlights?.join?.(' / ') || '', 240),
      url: clip(item.url || '', 500),
      score: Number(item.score || 0) || 0,
    })).filter((item) => item.title || item.content || item.url),
    createdAt: Date.now(),
  };
}

export async function braveSearch(query, options = {}) {
  const cfg = { ...(await loadWebSearchConfig()), ...(options.config || {}) };
  if (!cfg.enabled && !options.force) throw new Error('Web search is disabled');
  if (!cfg.braveEnabled && cfg.provider !== 'brave' && !options.force) throw new Error('Brave search is disabled');
  if (!cfg.braveApiKey) throw new Error('Missing Brave API key');
  const q = String(query || '').trim();
  if (!q) throw new Error('Missing search query');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', q);
  url.searchParams.set('count', String(Math.max(1, Math.min(20, Number(options.maxResults || cfg.maxResults) || 5))));
  url.searchParams.set('safesearch', 'moderate');
  if (options.freshness === 'day') url.searchParams.set('freshness', 'pd');
  if (options.freshness === 'week') url.searchParams.set('freshness', 'pw');
  if (options.freshness === 'month') url.searchParams.set('freshness', 'pm');
  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': cfg.braveApiKey,
    },
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Brave search failed (${res.status}): ${text || res.statusText}`);
  }
  const payload = await res.json();
  const web = Array.isArray(payload.web?.results) ? payload.web.results : [];
  return normalizeSearchResults({
    source: 'brave',
    category: options.category,
    query: q,
    results: web.map((item) => ({
      title: item.title,
      content: item.description,
      url: item.url,
      score: 0.55,
      image: item.thumbnail?.src,
    })),
  });
}

export async function serpApiSearch(query, options = {}) {
  const cfg = { ...(await loadWebSearchConfig()), ...(options.config || {}) };
  if (!cfg.enabled && !options.force) throw new Error('Web search is disabled');
  if (!cfg.serpApiEnabled && cfg.provider !== 'serpapi' && !options.force) throw new Error('SerpAPI search is disabled');
  if (!cfg.serpApiKey) throw new Error('Missing SerpAPI key');
  const q = String(query || '').trim();
  if (!q) throw new Error('Missing search query');
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', options.engine || 'google');
  url.searchParams.set('q', q);
  url.searchParams.set('api_key', cfg.serpApiKey);
  url.searchParams.set('num', String(Math.max(1, Math.min(20, Number(options.maxResults || cfg.maxResults) || 5))));
  if (options.engine === 'youtube') url.searchParams.delete('num');
  const res = await fetch(url.toString(), { signal: options.signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SerpAPI search failed (${res.status}): ${text || res.statusText}`);
  }
  const payload = await res.json();
  const organic = Array.isArray(payload.organic_results) ? payload.organic_results : [];
  const video = Array.isArray(payload.video_results) ? payload.video_results : [];
  return normalizeSearchResults({
    source: 'serpapi',
    category: options.category,
    query: q,
    results: [...video, ...organic].map((item) => ({
      title: item.title,
      content: item.snippet || item.description,
      url: item.link,
      score: 0.58,
      image: item.thumbnail,
    })),
  });
}

export async function searchApiSearch(query, options = {}) {
  const cfg = { ...(await loadWebSearchConfig()), ...(options.config || {}) };
  if (!cfg.enabled && !options.force) throw new Error('Web search is disabled');
  if (!cfg.searchApiEnabled && cfg.provider !== 'searchapi' && !options.force) throw new Error('SearchApi search is disabled');
  if (!cfg.searchApiKey) throw new Error('Missing SearchApi key');
  const q = String(query || '').trim();
  if (!q) throw new Error('Missing search query');
  const engine = options.engine || (options.video ? 'youtube' : 'google');
  const url = new URL('https://www.searchapi.io/api/v1/search');
  url.searchParams.set('engine', engine);
  url.searchParams.set('q', q);
  url.searchParams.set('api_key', cfg.searchApiKey);
  url.searchParams.set('num', String(Math.max(1, Math.min(20, Number(options.maxResults || cfg.maxResults) || 5))));
  const res = await fetch(url.toString(), { signal: options.signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SearchApi search failed (${res.status}): ${text || res.statusText}`);
  }
  const payload = await res.json();
  const organic = Array.isArray(payload.organic_results) ? payload.organic_results : [];
  const videos = Array.isArray(payload.video_results) ? payload.video_results : [];
  return normalizeSearchResults({
    source: 'searchapi',
    category: options.category,
    query: q,
    results: [...videos, ...organic].map((item) => ({
      title: item.title,
      content: item.snippet || item.description,
      url: item.link,
      score: 0.58,
      image: item.thumbnail,
    })),
  });
}

export async function tavilyExtract(urls, options = {}) {
  const cfg = { ...(await loadWebSearchConfig()), ...(options.config || {}) };
  if (!cfg.enabled && !options.force) throw new Error('Web search is disabled');
  if (cfg.provider !== 'tavily') throw new Error(`Unsupported search provider: ${cfg.provider}`);
  if (!cfg.tavilyApiKey) throw new Error('Missing Tavily API key');
  const list = Array.isArray(urls) ? urls : [urls];
  const cleanUrls = list.map((url) => String(url || '').trim()).filter(Boolean).slice(0, 5);
  if (!cleanUrls.length) throw new Error('Missing URL');
  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.tavilyApiKey}`,
    },
    body: JSON.stringify({
      urls: cleanUrls,
      include_images: options.includeImages ?? cfg.includeImages,
      extract_depth: options.extractDepth || 'basic',
    }),
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily extract failed (${res.status}): ${text || res.statusText}`);
  }
  const payload = await res.json();
  if (options.raw) return payload;
  const results = Array.isArray(payload.results) ? payload.results : [];
  return {
    id: `web_extract:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    source: 'tavily_extract',
    urls: cleanUrls,
    title: clip(results[0]?.title || cleanUrls[0], 100),
    summary: results.map((item) => clip(item.raw_content || item.content, 240)).filter(Boolean).join(' / ').slice(0, 520),
    images: uniq(results.flatMap((item) => Array.isArray(item.images) ? item.images : []), 8),
    results: results.map((item) => ({
      url: clip(item.url, 500),
      title: clip(item.title, 100),
      content: clip(item.raw_content || item.content, 240),
    })),
    createdAt: Date.now(),
  };
}
