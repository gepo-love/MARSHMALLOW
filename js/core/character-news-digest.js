/**
 * 日程「新资讯」缓存（日程主轴调整 Phase 2a）：
 * - general：全站共享的通用热点摘要（电影上映、热门社会事件、热搜），一天只搜一次，
 *   不分角色重复搜——所有开启了「参考新资讯」的角色共用同一份缓存。
 * - private：按角色人设/兴趣定向搜一次「跟这个角色本人相关的最新动态」，缓存在角色自己身上，
 *   刷新更慢（内容时效性不需要太频繁）。
 * 这个模块只做「搜索 → 压缩 → 缓存」，不决定要不要用——由 character-daily-life.js 按
 * 角色的 eventNewsEnabled 开关决定是否读取、怎么用。
 */
import * as db from './db.js';
import { chatForTask } from './api.js';
import { loadWebSearchConfig, runWebSearch } from './web-search-tools.js';
import { extractJsonArray } from './character-interest-table.js';

function clean(value = '', max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function distillNewsResultsToItems(rows, { task, extraRule = '' } = {}) {
  if (!rows.length) return [];
  const payload = {
    task,
    searchResults: rows,
    rules: [
      '从以上真实搜索结果里提炼最多 5 条具体资讯条目，只用结果里真实出现的信息，没把握的不要编。',
      extraRule,
      '只输出 JSON 数组，不要解释，不要 Markdown。',
    ].filter(Boolean),
    schema: [{ title: '一句话事件（具体到片名/书名/事件名）', gist: '补充一句简介或角度，供后续自然聊起' }],
  };
  const raw = await chatForTask([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.4 }, 'searchRefine').catch(() => '');
  const parsed = extractJsonArray(raw) || [];
  return parsed.map((it) => ({
    title: clean(it?.title, 60),
    gist: clean(it?.gist, 100),
  })).filter((it) => it.title).slice(0, 5);
}

const GENERAL_DIGEST_KEY = 'scheduleGeneralNewsDigest';
const GENERAL_DIGEST_REFRESH_MS = 8 * 3600000; // 通用热点 8 小时刷新一次，全角色共享这一份缓存

/**
 * 微博热搜榜抓取：Tavily 抓不到热搜词条的详情页，但能抓到热搜榜单页本身的文本快照。
 * 先搜榜单页，再让 LLM 从页面片段里把真实在榜的词条抠出来，供后续定点细化搜索。
 */
async function fetchWeiboHotTags(webCfg) {
  const result = await runWebSearch('微博热搜榜 实时', {
    category: 'schedule_news_hot_list', maxResults: 5, searchDepth: 'basic', config: webCfg, freshness: 'day',
  }).catch(() => null);
  if (!result?.results?.length) return [];
  const rows = result.results.slice(0, 5).map((r) => ({ title: clean(r.title, 80), content: clean(r.content, 400) }));
  const payload = {
    task: 'extract_weibo_hot_search_tags',
    searchResults: rows,
    rules: [
      '这些是搜「微博热搜榜」抓回来的页面片段。从里面抠出真实出现的热搜词条原文，最多 8 条。',
      '只要具体事件/作品/人物/话题类词条；跳过导航文字、广告、日期、「XX热搜榜」这类页面自述，跳过政治敏感类。',
      '只输出 JSON 数组，如 ["词条一","词条二"]，不要解释，不要 Markdown。',
    ],
    schema: ['热搜词条原文'],
  };
  const raw = await chatForTask([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.2 }, 'searchRefine').catch(() => '');
  const parsed = extractJsonArray(raw) || [];
  return parsed
    .map((t) => clean(typeof t === 'string' ? t : (t?.tag || t?.title || ''), 40))
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * 通用热点摘要：所有角色共享，只要有一个开了「参考新资讯」的角色触发日程生成，
 * 就顺带把这份全局缓存刷新一次，别的角色再生成日程时直接读缓存，不重复搜。
 * 流程：微博热搜榜抓 tag → 对前几条 tag 定点细化搜索 → 一起蒸馏成资讯条目；
 * 热搜链路任何一步没结果就回退到老的泛搜一次。
 */
export async function loadGeneralNewsDigest({ force = false } = {}) {
  const row = await db.get('settings', GENERAL_DIGEST_KEY).catch(() => null);
  const cached = row?.value && typeof row.value === 'object' ? row.value : null;
  if (!force && cached?.updatedAt && Date.now() - cached.updatedAt < GENERAL_DIGEST_REFRESH_MS) {
    return cached;
  }
  const webCfg = await loadWebSearchConfig().catch(() => null);
  if (!webCfg?.enabled) return cached || { items: [], updatedAt: 0 };

  const hotTags = await fetchWeiboHotTags(webCfg).catch(() => []);
  let rows = [];
  if (hotTags.length) {
    const refineTargets = hotTags.slice(0, 2);
    const refined = await Promise.all(refineTargets.map((tag) => runWebSearch(`${tag} 是什么 最新`, {
      category: 'schedule_news_general', maxResults: 3, searchDepth: 'basic', config: webCfg, freshness: 'day',
    }).catch(() => null)));
    rows = refined.flatMap((r, i) => (r?.results || []).slice(0, 3).map((it) => ({
      hotTag: refineTargets[i], title: clean(it.title, 80), content: clean(it.content, 200),
    })));
  }
  if (!hotTags.length && !rows.length) {
    const result = await runWebSearch('今日热点 电影上映 热门新闻 热搜', {
      category: 'schedule_news_general', maxResults: 6, searchDepth: 'basic', config: webCfg, freshness: 'day',
    }).catch(() => null);
    if (!result?.results?.length) return cached || { items: [], updatedAt: 0 };
    rows = result.results.slice(0, 6).map((r) => ({ title: clean(r.title, 80), content: clean(r.content, 200) }));
  }

  const tagOnly = hotTags.filter((tag) => !rows.some((r) => r.hotTag === tag));
  const items = await distillNewsResultsToItems(rows, {
    task: 'distill_general_hot_news_digest',
    extraRule: [
      hotTags.length ? `weiboHotTags（当前微博热搜在榜词条）：${hotTags.join('、')}。带 hotTag 的搜索结果是对应词条的细化搜索，优先据此产出条目；${tagOnly.length ? '没细化到的热搜词条如果本身够具体、适合聊起，也可以直接收一条，gist 写「正在热搜上」加上词条字面能读出的信息，不要编细节。' : ''}` : '',
      '偏好电影/剧集上映、热门社会事件、热搜话题这类适合被普通人随口聊到的内容，跳过纯财经/政治敏感类。',
    ].filter(Boolean).join(' '),
  }).catch(() => []);
  if (!items.length && !cached?.items?.length) return cached || { items: [], updatedAt: 0 };
  const digest = { items: items.length ? items : (cached?.items || []), hotTags, updatedAt: Date.now() };
  await db.put('settings', { key: GENERAL_DIGEST_KEY, value: digest }).catch(() => {});
  return digest;
}

const PRIVATE_DIGEST_REFRESH_MS = 24 * 3600000; // 私人资讯 1 天刷新一次

function privateDigestKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `scheduleNewsDigest_${uid}_${cid}`;
}

/**
 * 私人资讯摘要：按角色本人真实关注的方向（兴趣表关键词/人设关键信息）定向搜一次「最新动态」，
 * 缓存在角色自己身上。focusKeywords 为空时直接跳过（没有具体方向的定向搜索意义不大）。
 */
export async function loadPrivateNewsDigest({
  userId, characterId, character, focusKeywords = [], force = false,
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!uid || !cid) return { items: [], updatedAt: 0 };
  const key = privateDigestKey(uid, cid);
  const row = await db.get('settings', key).catch(() => null);
  const cached = row?.value && typeof row.value === 'object' ? row.value : null;
  if (!force && cached?.updatedAt && Date.now() - cached.updatedAt < PRIVATE_DIGEST_REFRESH_MS) {
    return cached;
  }
  const webCfg = await loadWebSearchConfig().catch(() => null);
  if (!webCfg?.enabled) return cached || { items: [], updatedAt: 0 };
  const focus = (Array.isArray(focusKeywords) ? focusKeywords : []).filter(Boolean).slice(0, 3).join(' ');
  const query = clean(focus ? `${focus} 最新动态` : '', 100);
  if (!query) return cached || { items: [], updatedAt: 0 };
  const result = await runWebSearch(query, {
    category: 'schedule_news_private', maxResults: 6, searchDepth: 'basic', config: webCfg, characterId: cid, freshness: 'week',
  }).catch(() => null);
  if (!result?.results?.length) return cached || { items: [], updatedAt: 0 };
  const rows = result.results.slice(0, 6).map((r) => ({ title: clean(r.title, 80), content: clean(r.content, 200) }));
  const characterName = character?.name || 'TA';
  const items = await distillNewsResultsToItems(rows, {
    task: 'distill_character_private_news_digest',
    extraRule: `这些是跟角色「${characterName}」本人关注的方向相关的搜索结果，只留角色会真的关心、能自然聊起的具体资讯，跳过无关广告或不相关内容。`,
  }).catch(() => []);
  const digest = { items, updatedAt: Date.now() };
  await db.put('settings', { key, value: digest }).catch(() => {});
  return digest;
}
