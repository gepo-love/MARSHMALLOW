/**
 * 兴趣两阶段搜索编排（搜索与知识基建 Plan 的 C 部分）：
 *
 *   兴趣表候选词 → ①粗搜一轮（通用 web search / 小红书 search_notes）
 *                → ②小 LLM 调用筛选去噪、压缩成「近况简报」（带角色自己的态度，不是干巴百科）
 *                → 写入小知识库（system: 'miniwiki'，origin: 'ai_grown'，绑定角色）
 *
 * 另有「母词裂变」：像「明日方舟」这种大类词直接搜杂音很重，真人关注的其实是它下面
 * 会变的具体子话题（这期活动、这期危机合约、社区在吵什么）。deep 档的 root 词会定期
 * 花一次搜索 + 一次小 LLM 调用，裂变出几个具体子话题词（kind: 'sub'）写回兴趣表，
 * 之后的搜索轮转会优先挑这些更具体的子词，而不是反复搜那个笼统的大词。
 *
 * 设计约束：
 * - 候选词只从 character-interest-table 里来，调用方按预算挑好再传入，这里不做关键词生成。
 * - 小红书解析花的是用户的 TikHub 余额，给它独立的每日小额度 + 计数；
 *   通用 web search 沿用 webSearchConfig 自己的 enabled/dailyLimit 语义，这里只做轻量守门。
 * - 简报内容在写入时就压缩定长（≤300 字），读取时按关键词 selective 注入，不做常驻；
 *   另外聊天上下文里会单独挑最近几条简报做「主动可聊」常驻块，让角色能自己提起话题。
 * - 时效性内容不能「有卡就永久跳过」：简报超过保鲜期会用同一个 id 重新搜索覆盖更新。
 */
import * as db from './db.js';
import { chat as chatCompletion, chatForTask, resolveGenerationMaxTokens } from './api.js';
import { appendDebugEvent, classifyErrorKind } from './debug-log.js';
import { loadWebSearchConfig, runWebSearch } from './web-search-tools.js';
import { loadSocialLinkConfig } from './social-link-tools.js';
import {
  searchXiaohongshuNotes, fetchXiaohongshuNoteDetail,
  searchWeiboPosts, fetchWeiboStatusDetailById,
  searchBilibiliVideos, fetchBilibiliVideoWithComments,
} from './social-link-resolver.js';
import { saveWorldBookEntry, listAllWorldBookRows } from './world-book-store.js';
import { getCharacterAiContextName } from '../models/character.js';
import { logSearchCall } from './search-usage-log.js';
import { loadCharacterPhone, saveCharacterPhone, mergePhoneStructuredPatch } from './character-phone-store.js';
import {
  listInterestEntries,
  pickInterestCandidates,
  markInterestUsed,
  pickRootForSplit,
  markInterestSplit,
  saveSplitSubEntries,
  archiveExpiredInterestEntries,
  extractJsonArray,
  loadInterestTrackingSettings,
  normalizeSocialSearchChannels,
  normalizeShareSearchChannels,
  SOCIAL_SEARCH_CHANNELS,
  collectRecentChatLines,
  applyInterestProgressPatch,
  markInterestSearchQuality,
  isUsableProgressGoal,
} from './character-interest-table.js';
import { appendTasteItems } from './character-taste-pool.js';

async function optionalInterestChat(messages, options, scope) {
  try {
    return await chatCompletion(messages, options);
  } catch (error) {
    appendDebugEvent({
      type: 'interest_generation_error',
      level: 'warn',
      message: error?.message || String(error),
      correlationId: error?.correlationId || '',
      errorKind: classifyErrorKind(error, { status: error?.status }),
      status: error?.status ?? null,
      context: { scope },
    });
    return '';
  }
}

async function optionalSearchRefineResult(messages, options, scope) {
  try {
    return {
      raw: await chatForTask(messages, options, 'searchRefine'),
      error: null,
    };
  } catch (error) {
    appendDebugEvent({
      type: 'interest_generation_error',
      level: 'warn',
      message: error?.message || String(error),
      correlationId: error?.correlationId || '',
      errorKind: classifyErrorKind(error, { status: error?.status }),
      status: error?.status ?? null,
      context: { scope, apiTask: 'searchRefine' },
    });
    return { raw: '', error };
  }
}

async function optionalSearchRefine(messages, options, scope) {
  const result = await optionalSearchRefineResult(messages, options, scope);
  return result.raw;
}

const BRIEFING_STALE_MS = 3 * 86400000; // 简报保鲜期：超过 3 天视为可能过时，允许重新查证覆盖

// 小红书/微博/B站共用同一份每日小额度，但按角色分开计数——社媒解析本来就是单角色开关，
// 角色之间不该抢同一份配额（自动轮转用；手动/分享帖精搜绕开这个额度）
const SOCIAL_DAILY_USAGE_KEY = 'interestSocialSearchDailyUsage';
const SOCIAL_DAILY_LIMIT_DEFAULT = 5;
// shareDailyTarget 上限放宽到 20（见 character-interest-table.js），池子上限留点余量避免高目标的
// 角色总是被旧的 skim 记录顶掉「深读可分享」的名额。
const VERIFIED_POSTS_CAP = 40;
// 待分享素材不是永久库存：超过一周后页面仍在线，也可能已经是上一期活动或旧排期。
export const SHARE_POST_FRESH_MS = 7 * 86400000;
// 分享帖精搜每日轮转单次最多补几条，避免「shareDailyTarget 设得比较高，实际每天只补 1 条，
// 攒够要等好几天」——但也不一口气把当天的社媒搜索额度（SOCIAL_DAILY_LIMIT_DEFAULT）全用在补货上。
const SHARE_POST_REFILL_MAX_PER_ROTATION = 3;

export const SOCIAL_CHANNEL_LABEL = { xiaohongshu: '小红书', weibo: '微博', bilibili: 'B站' };

// 雷区/负面内容规避规则：CP 同人配对、拉踩对立/引战骂战都没法靠关键词黑名单拦住（没打标签的
// 内容只能靠 LLM 读语义判断），但两者是否要避开都交给用户自己按关键词决定——有人就是想看嗑到的
// CP 糖或爱吃瓜，一律强制避开反而不对，contentPref='open' 时两条都放开。
function contentAvoidRules(contentPref) {
  if (contentPref === 'open') {
    return ['用户对这个关键词明确表示不介意看到嗑 CP/同人配对倾向、拉踩对立/引战骂战类的内容，可以正常挑选，不用刻意回避这些。'];
  }
  return [
    '默认避开单纯的嗑 CP/同人配对倾向的内容——即使候选标题/简介没有明确标注，也要凭内容语气/用词读出这种倾向并跳过，角色本人的真实兴趣（作品/技术/生活分享等）才是重点，不要因为热度高就选带配对暗示的帖子。',
    '默认避开单纯的拉踩对立/引战骂战类内容，优先选角色真实兴趣向的信息（比如攻略、正常讨论、新进展），不是随便选热度最高或最吵的那条。',
  ];
}

function avoidNotesRule(avoidNotes = '') {
  const note = clean(avoidNotes, 200);
  return note ? `用户明确表示的雷点/忌讳：「${note}」——候选如果命中这些方向，直接跳过，即使内容本身质量或热度不错。` : '';
}

// 应用商店/应用市场产品页：本身只是"下载详情+相关推荐列表"，没有攻略/正文可聊，不该被当成
// "角色刷到的真实内容"分享出去（案例：星露谷"存档助手" App Store 页）。
const APP_STORE_DOMAIN_RE = /(apps\.apple\.com|play\.google\.com|sj\.qq\.com|wandoujia\.com|appchina\.com|apk\.hiapk\.com|coolapk\.com\/apk|itunes\.apple\.com)/i;
// 促销导购信号：价格+发售/预售/限时/满减等措辞组合出现，基本可以判定是电商软文/推广稿，
// 不是角色会当"自己刷到的真实内容"分享的东西——单靠 LLM 软判断经常漏（案例：机械键盘"今晚发售"新品稿）。
const PROMOTIONAL_CONTENT_RE = /(\d+\s*元起|限时[抢购优惠秒杀]|新品发售|即将发售|今晚发售|预售(?:中|开启|价)|直降\d|立减\d|专享价|拍下立减|优惠券|满\d+减\d+|折上折|秒杀价|全网首发|抢购价)/;
// 小红书常见的商业合作披露与购买引导。只拦明确组合，不把普通的「测评 / 种草 / 开箱」
// 一刀切成广告，避免误伤真实用户体验帖。
const SPONSORED_DISCLOSURE_RE = /(商务合作|品牌合作|推广合作|广告合作|赞助(?:内容|笔记|视频)|本(?:篇|文|内容|笔记).{0,8}(?:含|为).{0,4}(?:广告|推广))/;
const PURCHASE_CTA_RE = /(点击(?:下方)?链接|戳链接|购买链接|进(?:店|直播间)(?:下单|拍下)?|直播间(?:下单|拍下|同款)|橱窗(?:下单|同款)|私信(?:我)?(?:购买|下单|领券)|评论区(?:扣|回复).{0,8}(?:链接|优惠|购买)|券后(?:价)?|到手价|团购(?:链接|价)|拍下(?:即享|立减)|店铺(?:下单|同款))/;

/**
 * 分享候选的确定性质量判定。它不是统计学「广告概率」，而是可解释的硬信号：
 * 命中应用商店、强促销、商业合作披露或直接购买引导之一，就先挡在 LLM 外面。
 */
export function classifyShareCandidateQuality({ title = '', desc = '', url = '' } = {}) {
  const textValue = `${String(title || '')} ${String(desc || '')}`;
  const reasons = [];
  if (APP_STORE_DOMAIN_RE.test(String(url || ''))) reasons.push('app-store-page');
  if (PROMOTIONAL_CONTENT_RE.test(textValue)) reasons.push('promotion');
  if (SPONSORED_DISCLOSURE_RE.test(textValue)) reasons.push('sponsored-disclosure');
  if (PURCHASE_CTA_RE.test(textValue)) reasons.push('purchase-cta');
  return {
    lowQuality: reasons.length > 0,
    reasons,
  };
}

/**
 * 程序化剔除低质量分享候选：不指望 LLM 每次都能从标题/摘要里判断出"这是广告/产品列表页"，
 * 直接在候选阶段筛掉，LLM 连看到的机会都没有。
 * 导出给素材池的各个出口（分享冲动、聊天注入块）复用——池里可能还躺着质检上线前攒的旧广告帖。
 */
export function isLowQualityShareCandidate({ title = '', desc = '', url = '' } = {}) {
  return classifyShareCandidateQuality({ title, desc, url }).lowQuality;
}

/** 素材池条目形状（title/summary/url）的低质量判定快捷封装。 */
export function isLowQualityPooledPost(post = {}) {
  return isLowQualityShareCandidate({ title: post.title, desc: post.summary, url: post.url });
}

export function isFreshSharePost(post = {}, now = Date.now()) {
  const foundAt = Number(post?.foundAt || 0);
  return foundAt > 0 && now >= foundAt && now - foundAt < SHARE_POST_FRESH_MS;
}

/** 挑选/精读环节共用的内容质量兜底规则（程序化过滤之外，给 LLM 的软判断再上一道保险）。 */
function qualityGuardRules() {
  return [
    '优先选有实质内容的正文页面（文章、测评、攻略、讨论、图文笔记），不要选应用商店产品页、百科/wiki 的首页或分类列表页、"相关推荐/合集列表"这类没有具体内容的页面。',
    '不要选纯粹的电商促销/新品发售软文、导购强推稿（哪怕关键词本身是购物/装备向）——角色分享的应该是自己真的会看会讨论的内容，不是把对方当推销对象。',
  ];
}

function verifiedPostsKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `characterVerifiedPosts_${uid}_${cid}`;
}

/** 角色「真实刷到过」的帖子池：搜索编排每轮沉淀，供聊天里分享真实可点开的链接。 */
export async function listVerifiedPosts(userId, characterId) {
  const row = await db.get('settings', verifiedPostsKey(userId, characterId)).catch(() => null);
  return Array.isArray(row?.value) ? row.value : [];
}

async function appendVerifiedPosts(userId, characterId, posts = []) {
  if (!posts.length) return;
  const existing = await listVerifiedPosts(userId, characterId);
  const keyOf = (p) => p.url || p.title;
  const incoming = new Map(posts.filter((p) => keyOf(p)).map((p) => [keyOf(p), p]));
  // 已在池里的同帖不重复占位，但要把新拿到的精选标记/正文摘要合并回去（精搜复用池内链接时走这条路）
  const updated = existing.map((p) => {
    const hit = incoming.get(keyOf(p));
    if (!hit) return p;
    incoming.delete(keyOf(p));
    return {
      ...p,
      // depth 只升不降：已经被精搜「深读」过的帖子，之后再被浅扫命中也不能退回浅扫
      depth: p.depth === 'read' ? 'read' : (hit.depth || p.depth || 'skim'),
      picked: p.picked === true || hit.picked === true,
      reason: hit.reason || p.reason || '',
      summary: hit.summary || p.summary || '',
      title: hit.title || p.title || '',
      topicTag: hit.topicTag || p.topicTag || '',
      foundAt: Number(hit.foundAt) || Number(p.foundAt) || 0,
    };
  });
  const fresh = [...incoming.values()];
  if (!fresh.length && updated.every((p, i) => p === existing[i])) return;
  const merged = [...fresh, ...updated].slice(0, VERIFIED_POSTS_CAP);
  await db.put('settings', { key: verifiedPostsKey(userId, characterId), value: merged });
}

/**
 * 角色真的在聊天里把某条帖子甩出去后调用（ai-round 落地 link 消息时触发）：
 * 标记 sharedAt，之后注入块会把它挪进「已经分享过」档——不再重复甩同一条链接（防原地打转），
 * 但内容摘要还在，想继续深入聊内容本身是允许且鼓励的。
 */
export async function markVerifiedPostShared(userId, characterId, url) {
  const target = String(url || '').trim();
  if (!target) return;
  const posts = await listVerifiedPosts(userId, characterId);
  let changed = false;
  const next = posts.map((p) => {
    if (p.url === target && !p.sharedAt) {
      changed = true;
      return { ...p, sharedAt: Date.now() };
    }
    return p;
  });
  if (changed) await db.put('settings', { key: verifiedPostsKey(userId, characterId), value: next });

  // 「他的手机·浏览记录」里同一条链接也要跟着从「待分享」翻成「已分享」——
  // 这样浏览记录页看到的状态和角色实际有没有甩出去这条链接是一致的。
  try {
    const phone = await loadCharacterPhone(userId, characterId);
    const records = Array.isArray(phone?.browserRecords) ? phone.browserRecords : [];
    let recordChanged = false;
    const nextRecords = records.map((r) => {
      if (r?.url === target && r.shareStatus === 'pending') {
        recordChanged = true;
        return { ...r, shareStatus: 'shared' };
      }
      return r;
    });
    if (recordChanged) await saveCharacterPhone({ ...phone, browserRecords: nextRecords });
  } catch (_) { /* 浏览记录状态同步失败不影响主流程 */ }
}

/** 给工具 LLM 的角色画像：角色取向判断同样必须服从完整角色卡。 */
function buildToolPersonaBrief(character, interestEntries = []) {
  const interests = (Array.isArray(interestEntries) ? interestEntries : [])
    .filter((e) => e?.status === 'active' && e.keyword)
    .slice(0, 8)
    .map((e) => (e.depth === 'deep' ? `${e.keyword}(沉迷)` : e.keyword));
  return {
    name: String(character?.realName || character?.name || '').trim(),
    gender: String(character?.gender || '').trim(),
    currentRole: String(character?.currentRole || '').trim(),
    currentStatus: String(character?.currentStatus || '').trim(),
    userRelationStatus: String(character?.userRelationStatus || '').trim(),
    personality: String(character?.personality || '').trim(),
    speechStyle: String(character?.speechStyle || '').trim(),
    speechCorpus: String(character?.speechCorpus || '').trim(),
    promptCorpus: String(character?.promptCorpus || '').trim(),
    notes: String(character?.notes || '').trim(),
    relationships: character?.relationships && typeof character.relationships === 'object'
      ? character.relationships
      : undefined,
    interests,
  };
}

/** 兴趣的背景故事：sub 子话题自己不带背景，跟着母词的背景走（TA 和「明日方舟」的关系
 *  就是 TA 和「危机合约XX季」的关系）。找不到就返回空串。 */
function resolveEntryBackstory(entry, allEntries = []) {
  if (entry?.backstory) return entry.backstory;
  if (entry?.kind === 'sub' && entry.rootId) {
    const root = (Array.isArray(allEntries) ? allEntries : []).find((e) => e.id === entry.rootId);
    return root?.backstory || '';
  }
  return '';
}

function clean(value = '', max = 200) {
  // 同 social-link-resolver.js 的处理：先去掉正文里夹带的 markdown 图片语法（B站简介常见），
  // 避免深读摘要/分享文案里留下"![]"加裸链接。
  return String(value ?? '').replace(/!\[[^\]]*\]\s*\(\s*[^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function dayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function socialDailyUsageKey(characterId = '') {
  const cid = encodeURIComponent(String(characterId || '').trim() || 'shared');
  return `${SOCIAL_DAILY_USAGE_KEY}_${cid}`;
}

async function loadSocialDailyUsage(characterId = '') {
  const row = await db.get('settings', socialDailyUsageKey(characterId)).catch(() => null);
  const value = row?.value || {};
  const today = dayKey();
  if (value.day !== today) return { day: today, used: 0 };
  return { day: today, used: Math.max(0, Number(value.used || 0) || 0) };
}

async function bumpSocialDailyUsage(characterId = '') {
  const usage = await loadSocialDailyUsage(characterId);
  await db.put('settings', { key: socialDailyUsageKey(characterId), value: { day: usage.day, used: usage.used + 1 } });
}

/** 明显是小红书调性的关键词才优先选它（生活方式/种草/攻略/探店类） */
function keywordSuitsXiaohongshu(keyword = '', topic = '') {
  const blob = `${keyword} ${topic}`;
  return /(穿搭|探店|种草|测评|攻略|咖啡|甜品|美食|家居|收纳|布置|妆|护肤|发型|拍照|滤镜|周边|谷子|痛包|手帐|香薰|露营|市集|展|店)/.test(blob);
}

/** ACG/游戏/技术/知识区调性的关键词优先选 B 站——UP主标题+简介+评论区是重点，不涉及视频内容转写。 */
function keywordSuitsBilibili(keyword = '', topic = '') {
  const blob = `${keyword} ${topic}`;
  return /(游戏|二次元|动漫|番剧|手游|主机|评测|攻略|技术|编程|知识|科普|鬼畜|音乐|翻唱|舞蹈|模型|谷子|coser|同人|直播|UP主|电竞)/i.test(blob);
}

/** 每个关键词只挑一个社媒渠道去搜（省额度），在 allowedChannels 内按词性智能匹配，微博兜底泛话题。 */
export function pickSocialChannelForKeyword(keyword, topic, allowedChannels = null) {
  const allowed = normalizeSocialSearchChannels(allowedChannels);
  const preferred = keywordSuitsBilibili(keyword, topic) ? 'bilibili'
    : (keywordSuitsXiaohongshu(keyword, topic) ? 'xiaohongshu' : 'weibo');
  if (allowed.includes(preferred)) return preferred;
  if (allowed.includes('bilibili') && keywordSuitsBilibili(keyword, topic)) return 'bilibili';
  if (allowed.includes('xiaohongshu') && keywordSuitsXiaohongshu(keyword, topic)) return 'xiaohongshu';
  if (allowed.includes('weibo')) return 'weibo';
  return allowed[0] || 'weibo';
}

/**
 * 按用户勾选的分享渠道 + 当前可用性，算出这次精搜要不要试网页、社媒兜底池是哪些。
 * 未勾选的渠道一律不碰——「只分享选中渠道的链接」。
 */
export function resolveShareSearchAttempt(shareSearchChannels, { webOk = false, socialOk = false } = {}) {
  const selected = normalizeShareSearchChannels(shareSearchChannels);
  const tryWeb = selected.includes('web') && !!webOk;
  const socialAllowed = selected
    .filter((c) => SOCIAL_SEARCH_CHANNELS.includes(c) && !!socialOk);
  return { tryWeb, socialAllowed, selected };
}

/**
 * 分享帖精搜的 AI 选词：先按「这个兴趣最近有没有分享过」轮换（最久没被分享的兴趣先上，
 * 避免总薅同一个词导致对方连收好几条同题材），同样新旧下优先衍生子话题（本来就是 LLM
 * 从最新搜索结果里提炼的，比手填词更具体、时效更好），其次 deep 档母词。
 * @param lastSharedAtByKeyword Map/对象：keyword → 最近一次真实分享的时间戳（来自帖子池 sharedAt）
 */
export function pickAutoShareKeyword(entries = [], excludeKeywords = null, { lastSharedAtByKeyword = null } = {}) {
  const excluded = excludeKeywords instanceof Set ? excludeKeywords : new Set(excludeKeywords || []);
  const active = (Array.isArray(entries) ? entries : [])
    .filter((e) => e?.status === 'active' && e.surfaceMode !== 'quiet' && e.keyword && !excluded.has(e.keyword));
  if (!active.length) return null;
  const lastShared = (kw) => {
    if (!lastSharedAtByKeyword) return 0;
    const v = lastSharedAtByKeyword instanceof Map ? lastSharedAtByKeyword.get(kw) : lastSharedAtByKeyword[kw];
    return Number(v) || 0;
  };
  // 轮换优先：最久没分享的兴趣先上（没分享过的算最久）；同样久时按 sub > deep > 其它、新词先
  const tier = (e) => (e.kind === 'sub' ? 0 : e.depth === 'deep' ? 1 : 2);
  const sorted = [...active].sort((a, b) => lastShared(a.keyword) - lastShared(b.keyword)
    || tier(a) - tier(b)
    || (b.createdAt || 0) - (a.createdAt || 0));
  // channel/progress 一起带出去：分享搜索要按当前进度精确搜攻略，不能只拿裸关键词
  // （否则"星露谷物语"这种大词搜出来的常是首页/App Store 产品页，不是具体章节内容）。
  const e = sorted[0];
  return {
    keyword: e.keyword,
    topic: e.topic || '',
    channel: e.channel || '',
    progress: e.progress || null,
    kind: e.kind || 'root',
    subKind: e.subKind || '',
    volume: e.volume || 'medium',
  };
}

/** 从素材池里的真实链接反推渠道和 id，用于复用已有链接直接取正文（省一次列表搜索）。
 *  小红书链接如果原本就带 xsec_token（比如复用列表搜索阶段沉淀的素材），一并取出来接着用。 */
function extractSocialIdFromUrl(url = '') {
  const u = String(url || '');
  let m = u.match(/xiaohongshu\.com\/explore\/([0-9a-zA-Z]+)/);
  if (m) {
    const tokenMatch = u.match(/[?&]xsec_token=([^&]+)/);
    return { channel: 'xiaohongshu', id: m[1], xsecToken: tokenMatch ? decodeURIComponent(tokenMatch[1]) : '' };
  }
  m = u.match(/m\.weibo\.cn\/detail\/([0-9a-zA-Z]+)/);
  if (m) return { channel: 'weibo', id: m[1] };
  m = u.match(/bilibili\.com\/video\/(BV[0-9a-zA-Z]+)/i);
  if (m) return { channel: 'bilibili', id: m[1] };
  return null;
}

/**
 * 通用联网搜索（不占 TikHub 额度）本来就可能搜到小红书/微博/B站这些平台自己的公开页面，
 * 不是只有走精搜渠道才能拿到——按 URL 域名识别出真实来源，分享措辞才能准确说"刷到一个
 * B站视频"而不是笼统的"网上看到"；识别不出来就还是按普通网页处理。
 */
function detectSocialSourceFromUrl(url = '') {
  return extractSocialIdFromUrl(url)?.channel || 'web';
}

/**
 * 派生搜索计划：query 按「具体目标 > 进度模板 > 频道模板」三级递降——真人卡关搜的是
 * "星露谷 传说鱼 秋季 位置"（关键词+具体想解决的事），不是"星露谷 第二年春 攻略"。
 * goal 来自 progress.nextGoals（LLM 产物，质量不稳定），必须过 isUsableProgressGoal 校验
 * 才允许拼进 query；上一轮搜索质量差（thin/noise）时强制换角度：优先换一个没用过的 goal，
 * 换不了就退回模板层，绝不原样重搜。
 * @returns {{ query: string, usedGoal: string }}
 */
const TIMELY_INTEREST_RE = /(活动|版本|卡池|排期|赛季|联动|周年|更新|情报|直播|发布会|开服|复刻)/u;

function currentSearchMonth() {
  const now = new Date();
  return `${now.getFullYear()}年${now.getMonth() + 1}月`;
}

export function isTimelyInterestEntry(entry = {}) {
  return (entry.kind === 'sub' && entry.subKind === 'timely')
    || TIMELY_INTEREST_RE.test(`${entry.keyword || ''} ${entry.topic || ''}`);
}

export function deriveSearchPlan(entry) {
  const kw = clean(entry.keyword, 60);
  if (isTimelyInterestEntry(entry)) {
    return {
      query: `${kw} 最新 当前 活动 排期 ${currentSearchMonth()}`,
      usedGoal: '',
      freshness: 'week',
      timely: true,
    };
  }
  if (entry.channel === 'staple') return { query: `${kw} 热门单品 推荐 菜单`, usedGoal: '' };

  const badLastRound = entry.lastResultQuality === 'thin' || entry.lastResultQuality === 'noise';
  const goals = (Array.isArray(entry.progress?.nextGoals) ? entry.progress.nextGoals : [])
    .map((g) => clean(g, 60))
    .filter((g) => isUsableProgressGoal(g));
  // 换角度：上一轮质量差时跳过上次用过的那个 goal（还有别的 goal 才跳，只有一个就退模板）
  const lastUsed = clean(entry.lastGoalUsed, 60);
  const usableGoals = badLastRound && lastUsed ? goals.filter((g) => g !== lastUsed) : goals;
  const goal = usableGoals[0] || '';

  if (entry.channel === 'hobby' || entry.channel === 'follow') {
    if (goal) return { query: `${kw} ${goal}`, usedGoal: goal };
    const stage = clean(entry.progress?.stage, 30);
    // 上一轮模板搜出来就是噪音、又没有可用 goal：退到裸词换个面（模板本身可能就是噪音来源）
    if (badLastRound && !lastUsed) return { query: kw, usedGoal: '' };
    return { query: stage ? `${kw} ${stage} 攻略` : `${kw} 新手入门`, usedGoal: '' };
  }
  if (entry.channel === 'shopping') {
    if (goal) return { query: `${kw} ${goal}`, usedGoal: goal };
    return { query: `${kw} 测评 对比 避坑`, usedGoal: '' };
  }
  return { query: kw, usedGoal: goal };
}

export function deriveShareSearchPlan(entry = {}) {
  const plan = deriveSearchPlan(entry);
  if (plan.timely) return plan;
  const hasProgressTarget = isUsableProgressGoal(entry.progress?.nextGoals?.[0])
    || clean(entry.progress?.stage, 30);
  const query = (entry.channel === 'hobby' || entry.channel === 'follow') && !hasProgressTarget
    ? `${clean(entry.keyword, 60)} 最新资讯 ${currentSearchMonth()}`
    : `${plan.query} 最新 ${currentSearchMonth()}`;
  return { ...plan, query, freshness: plan.freshness || 'month' };
}

/**
 * staple 频道不走「近况简报」（那是给值得深挖的兴趣用的），只做一次轻量提取：从搜索结果里
 * 抠出几个具体的单品/店名短语，写进 taste pool，让角色说得出「一点点的杨枝甘露」而不是「奶茶」。
 */
async function extractTasteItemsFromSearch({ entry, webResult, socialNotes, characterName, signal }) {
  const webRows = asArray(webResult?.results).slice(0, 5).map((r) => clean(r.content, 200)).filter(Boolean);
  const socialRows = asArray(socialNotes).slice(0, 6).map((n) => clean(n.desc, 150)).filter(Boolean);
  const blob = [...webRows, ...socialRows].join('\n').slice(0, 2000);
  if (!blob) return [];
  const payload = {
    task: 'extract_taste_pool_items',
    keyword: entry.keyword,
    characterName,
    searchDigest: blob,
    rules: [
      `以上是关于「${entry.keyword}」的真实搜索结果片段。从里面提炼 3~6 个具体的单品名或店名（比如"一点点 QQ莓莓加冰淇淋"这种具体到能直接说出口的），不要抽象成"很受欢迎的饮品"这种泛称；只用真实出现在结果里的名字，没有把握的不要编。`,
      '只输出 JSON 数组，元素是字符串，不要解释。',
    ],
    schema: ['具体单品或店名'],
  };
  const raw = await optionalSearchRefine([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.4, signal }, 'interest-taste-extract');
  const parsed = extractJsonArray(raw) || [];
  return parsed.map((s) => clean(s, 60)).filter(Boolean).slice(0, 6);
}

function runGeneralSearch(query, cfg, {
  skipDailyLimit = false, characterId = '', category = 'interest_orchestrator', freshness = 'month',
} = {}) {
  return runWebSearch(query, {
    category, maxResults: 5, searchDepth: 'basic', config: cfg, skipDailyLimit, characterId, freshness,
  });
}

/** 按渠道搜列表并统一成 { id, title, desc, url, likeCount } 形状，屏蔽各平台字段差异。
 *  url 是列表结果直接拼出的真实链接（零额外调用），入素材池后聊天里就能直接分享。 */
async function searchSocialList(channel, keyword, apiKey, { onDiagnostic = null } = {}) {
  if (channel === 'xiaohongshu') {
    const notes = await searchXiaohongshuNotes(keyword, { apiKey });
    return notes.map((n) => ({
      id: n.noteId, title: n.title, desc: n.desc, url: n.url || '', likeCount: n.likeCount, xsecToken: n.xsecToken || '',
    }));
  }
  if (channel === 'weibo') {
    // search_type=1 综合排序，time_scope=month 兼顾时效又不至于搜不到东西
    const posts = await searchWeiboPosts(keyword, { apiKey, searchType: 1, timeScope: 'month' });
    return posts.map((p) => ({ id: p.mid, title: '', desc: p.text, url: p.url || '', likeCount: p.likeCount }));
  }
  if (channel === 'bilibili') {
    // order=1 按最新发布排序，优先拿到时效更新的内容
    const videos = await searchBilibiliVideos(keyword, { apiKey, order: 1, onDiagnostic });
    return videos.map((v) => ({ id: v.bvid, title: v.title, desc: v.desc, url: v.url || '', likeCount: v.play }));
  }
  return [];
}

/** 取正文详情，统一成 { title, desc, url, comments } 形状；微博没有标题字段，调用方自己兜底用正文开头当标题。
 *  xsecToken 只有小红书用得到（列表阶段拿到的安全令牌，带上它拼最终 url 能减少落地页要求登录的概率）。 */
async function fetchSocialDetail(channel, id, {
  apiKey, includeComments = false, commentCount = 3, cacheDays = 3, xsecToken = '',
} = {}) {
  if (channel === 'xiaohongshu') return fetchXiaohongshuNoteDetail(id, { apiKey, includeComments, commentCount, cacheDays, xsecToken });
  if (channel === 'weibo') return fetchWeiboStatusDetailById(id, { apiKey, includeComments, commentCount, cacheDays });
  if (channel === 'bilibili') return fetchBilibiliVideoWithComments(id, { apiKey, includeComments, commentCount, cacheDays });
  return null;
}

// 跨角色共享的「列表搜索结果」缓存（不分角色，只按渠道+关键词）：同一关键词不同角色都搜过，
// 复用同一份列表省一次 TikHub 调用；每个角色仍各自跑 pickInterestingPost 独立精选、独立决定分享，
// 不共享"最终选中要分享的那条"。详情层的复用已经由 socialLinkResolveCache（按 URL）覆盖，这里补列表层。
const SHARED_LIST_CACHE_PREFIX = 'sharedSocialListCache';
const SHARED_LIST_CACHE_TTL_MS = 86400000; // 1 天，跟池内素材的"3 天内算新鲜"是同一量级但更保守

function sharedListCacheKey(channel, keyword) {
  const kw = clean(keyword, 60).toLowerCase();
  return `${SHARED_LIST_CACHE_PREFIX}_${channel}_${encodeURIComponent(kw)}`;
}

async function readSharedListCache(channel, keyword) {
  const row = await db.get('settings', sharedListCacheKey(channel, keyword)).catch(() => null);
  const value = row?.value;
  if (!value || !Array.isArray(value.notes) || !value.notes.length) return null;
  if (Date.now() - Number(value.fetchedAt || 0) > SHARED_LIST_CACHE_TTL_MS) return null;
  return value.notes;
}

async function writeSharedListCache(channel, keyword, notes) {
  if (!Array.isArray(notes) || !notes.length) return;
  await db.put('settings', { key: sharedListCacheKey(channel, keyword), value: { notes, fetchedAt: Date.now() } }).catch(() => {});
}

/** 社媒关键词搜索的统一入口：先查跨角色共享的列表缓存，未命中再走共享日配额（可绕开）+ 调用日志。 */
/**
 * 返回 { notes, reason, error }，reason 只在 notes 为空时有意义：
 * '' 有结果 / 'quota_exceeded' 配额跳过 / 'empty_result' 接口正常但确实没搜到 / 'api_error' 接口本身报错。
 * 之前这里直接把三种「拿不到东西」的情况都压成一个空数组，调用方没法区分「真没搜到」和「接口挂了」，
 * 后者的报错信息也就跟着丢了——精搜失败时用户只会看到「没搜到相关内容」，看不出其实是接口在报错。
 */
async function fetchSocialListWithLogging(channel, keyword, {
  apiKey, characterId = '', skipDailyLimit = false, category = 'interest_social',
} = {}) {
  const cachedNotes = await readSharedListCache(channel, keyword).catch(() => null);
  if (cachedNotes) return { notes: cachedNotes.map((n) => ({ ...n, channel })), reason: '', error: '' };

  if (!skipDailyLimit) {
    const usage = await loadSocialDailyUsage(characterId);
    if (usage.used >= SOCIAL_DAILY_LIMIT_DEFAULT) {
      // 配额跳过之前完全不记日志，最容易被误当成"搜不到内容"——补一条 quota_exceeded，
      // 让「今日调用」/设置页调用统计能如实区分"真没搜"和"没搜就被跳过了"。
      logSearchCall({
        category, provider: channel, characterId, ok: false, query: keyword, manual: skipDailyLimit,
        resultCount: 0, reason: 'quota_exceeded',
      }).catch(() => {});
      return { notes: [], reason: 'quota_exceeded', error: '' };
    }
    await bumpSocialDailyUsage(characterId);
  }
  try {
    let responseDiagnostic = '';
    const notes = await searchSocialList(channel, keyword, apiKey, {
      onDiagnostic: (value) => { responseDiagnostic = String(value || ''); },
    });
    const resultCount = notes.length;
    logSearchCall({
      category, provider: channel, characterId, ok: resultCount > 0, query: keyword, manual: skipDailyLimit,
      resultCount, reason: resultCount > 0 ? '' : 'empty_result',
      diagnostic: resultCount > 0 ? '' : responseDiagnostic,
    }).catch(() => {});
    if (resultCount) writeSharedListCache(channel, keyword, notes);
    return { notes: notes.map((n) => ({ ...n, channel })), reason: resultCount > 0 ? '' : 'empty_result', error: '' };
  } catch (err) {
    const message = String(err?.message || err || '');
    logSearchCall({
      category, provider: channel, characterId, ok: false, query: keyword, manual: skipDailyLimit,
      resultCount: 0, reason: 'api_error',
      error: message,
    }).catch(() => {});
    return { notes: [], reason: 'api_error', error: message };
  }
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

/**
 * 用一次小 LLM 调用把粗搜结果筛选/压缩成一条「近况简报」（不是百科词条）。
 * 返回 null 表示素材太薄或模型判定不值得沉淀。
 */
async function distillSearchIntoCard({
  entry, webResult, socialNotes, characterName, personaBrief = null, backstory = '', searchGoal = '', signal,
}) {
  const webRows = asArray(webResult?.results).slice(0, 5).map((r) => ({
    title: clean(r.title, 90),
    content: clean(r.content, 240),
    url: clean(r.url, 300),
  })).filter((r) => r.title || r.content);
  const socialRows = asArray(socialNotes).slice(0, 6).map((n) => ({
    platform: SOCIAL_CHANNEL_LABEL[n.channel] || n.channel || '社媒',
    title: clean(n.title, 90),
    desc: clean(n.desc, 200),
    url: clean(n.url, 300),
  })).filter((n) => n.title || n.desc);
  if (!webRows.length && !socialRows.length) return null;

  const hasProgress = ['hobby', 'shopping', 'follow'].includes(entry.channel) && entry.progress;
  const goalLine = searchGoal ? `这次搜索是带着一个具体目标去搜的：「${searchGoal}」。` : '';
  const progressRule = hasProgress ? [
    `这个兴趣带有进度存档，当前存档：阶段=${entry.progress.stage || '未记录'}；已知：${entry.progress.knownFacts?.join('、') || '无'}；下一步想做：${entry.progress.nextGoals?.join('、') || '无'}。${goalLine}`,
    `请在输出 JSON 里额外给一个 "progressPatch" 字段：{"stage":"更新后的阶段（没变化就原样返回）","newFacts":["本次新学到的知识点，0~3 条短句"],"completedGoal":"${searchGoal ? `如果这次搜到的内容已经足够解决「${searchGoal}」这个目标，原样填这个目标表示可以划掉了；没解决就留空` : '留空'}","newGoal":"下一步想做的一件事（要具体到能直接拿去搜索，如『秋季钓到传说鱼』，不要『继续玩』这种空话；可空）","humanMoment":"一句这个阶段的人会有的真实小情绪（懊恼/得意/纠结，如『忘了春天前种够五个金星花菜』；想不出就留空，不要编模板腔）"}。`,
    '存档只能前进不能倒退：新阶段必须兼容旧阶段，不要凭空重置进度。',
  ] : [];

  const payload = {
    task: 'distill_interest_search_into_briefing',
    keyword: entry.keyword,
    topic: entry.topic || '',
    characterName,
    characterProfile: personaBrief || undefined,
    interestBackstory: backstory || undefined,
    webResults: webRows,
    socialMediaResults: socialRows,
    rules: [
      `以上是关于「${entry.keyword}」的真实搜索结果。角色「${characterName}」真心关注这个东西，把结果去噪、去重、合并成一条 TA 自己的「近况简报」，之后会让 TA 真的知道这些、甚至主动聊起。`,
      backstory ? 'interestBackstory 是 TA 自己讲的"和这个东西的关系"（怎么入坑、现在什么状态）：mood 和简报的视角要跟这层关系一致——老粉和刚入坑的人看同一条新闻的反应不一样，把这个立场感写出来。' : '',
      'digest 用中文写成 ≤300 字：优先写具体的、正在发生的信息（叫什么名字、什么进展、圈内在讨论/争的是什么、有什么值得一提的细节），不要写成通用百科介绍；只用搜索结果里真实出现的信息，不确定的地方可以模糊带过，绝不编造具体数字/名字。',
      '时效判断：搜索结果的标题/正文里如果能看出具体日期或"第几期/哪一版"这类信息，要以那个信息为准写清楚是哪一期/哪个时间点的内容，不要含糊地当成"最新"；如果结果本身看起来陈旧（比如提到的是很久以前的活动/版本），也如实写出来，不要假装是当下进行时。',
      `mood 用 ≤20 字写 TA 对这件事大概会有的态度/反应（比如"觉得这波强度离谱""马上想去试试""吐槽这次好贵"），要贴 characterProfile 里的性格与在追的兴趣，不要写成中立客观的评价。`,
      'keys 给 2~5 个能触发这条简报的关键词（含原词、常见别称/缩写）。',
      ...progressRule,
      '另给一个 "resultQuality" 字段客观评价这批搜索结果对这个关键词的价值：good=有具体有用的信息、thin=沾边但太薄撑不起简报、noise=基本无关或全是垃圾。这个字段和 skip 独立判断：即使写得出简报，素材勉强也要如实评 thin。',
      '如果搜索结果彼此矛盾、或都是无关噪音撑不起一条简报，输出 {"skip": true, "resultQuality": "thin 或 noise"}。',
      '只输出 JSON 对象，不要解释。',
    ],
    schema: hasProgress
      ? { name: '简报标题（≤20字）', digest: '≤300字正文', mood: 'TA的态度/反应（≤20字）', keys: ['触发词'], progressPatch: { stage: '', newFacts: [], completedGoal: '', newGoal: '', humanMoment: '' }, resultQuality: 'good|thin|noise', skip: false }
      : { name: '简报标题（≤20字）', digest: '≤300字正文', mood: 'TA的态度/反应（≤20字）', keys: ['触发词'], resultQuality: 'good|thin|noise', skip: false },
  };
  const raw = await optionalSearchRefine([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.5, signal }, 'interest-digest');
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  // LLM 给的质量评价不可尽信：只认白名单枚举，给了别的一律当没给（调用方按落卡与否兜底）
  const resultQuality = ['good', 'thin', 'noise'].includes(parsed.resultQuality) ? parsed.resultQuality : '';
  if (parsed.skip === true) return { skipped: true, resultQuality: resultQuality || 'thin' };
  const digest = clean(parsed.digest, 400);
  if (!digest || digest.length < 30) return { skipped: true, resultQuality: resultQuality || 'thin' };
  const mood = clean(parsed.mood, 40);
  const stampLine = `（查证于 ${dayKey()}）`;
  return {
    skipped: false,
    resultQuality: resultQuality || 'good',
    name: clean(parsed.name, 30) || entry.keyword,
    content: mood ? `${digest}\n（TA自己的感觉：${mood}）${stampLine}` : `${digest}${stampLine}`,
    keys: [...new Set([entry.keyword, ...asArray(parsed.keys).map((k) => clean(k, 40))])].filter(Boolean).slice(0, 6),
    progressPatch: hasProgress && parsed.progressPatch && typeof parsed.progressPatch === 'object' ? parsed.progressPatch : null,
  };
}

const PREVIOUS_DIGEST_SEPARATOR = '\n———\n';

/**
 * 简报覆盖更新时不完全丢掉旧知识：把上一版正文压缩后挂在新正文后面作「旧版对比」。
 * 只保留一代（旧版自己的「此前」段会先被剥掉，不无限嵌套），角色因此能聊出
 * 「之前是XX，现在变成XX了」这种时间纵深，而不是每次都像第一次听说。
 */
function appendPreviousDigest(newContent, previousEntry) {
  const prevRaw = String(previousEntry?.content || '').split(PREVIOUS_DIGEST_SEPARATOR)[0].trim();
  if (!prevRaw) return newContent;
  return `${newContent}${PREVIOUS_DIGEST_SEPARATOR}此前的了解（旧版，可能已过时，可用于对比"之前vs现在"）：${clean(prevRaw, 220)}`;
}

/**
 * 子话题的简报该归进哪个「梗百科」分组：跟着母词走（如「明日方舟 危机合约 XX 季」归进
 * 「明日方舟」分组），而不是每个子话题各自散落——这样一个大兴趣裂变出的一串子话题
 * 在小知识库里能看出是同一个类目下的，不是互相无关的碎片。
 * 独立的 root 词（还没裂变过/没有子话题）用自己的关键词当分组名，之后裂变出的子话题
 * 会自动并入这个同名分组，无需额外迁移。
 */
function resolveMiniwikiGroupKeyword(entry, allEntries = []) {
  if (entry?.kind === 'sub' && entry.rootId) {
    const root = allEntries.find((e) => e.id === entry.rootId);
    if (root?.keyword) return root.keyword;
  }
  return entry?.keyword || '';
}

/**
 * 按名称找到/建立一个 miniwiki 分组，返回其 id；只做轻量归类，不影响世界书注入判断。
 * 每次都实时查一遍现有分组（而不是长期缓存 id）：用户随时可能在梗百科页面改名/删掉分组，
 * 缓存 id 会导致后续沉淀挂到一个已经不存在或改名的分组上。
 */
async function ensureMiniwikiGroupId(groupName) {
  const name = clean(groupName, 24);
  if (!name) return '';
  const rows = await listAllWorldBookRows().catch(() => []);
  const existing = rows.find((e) => e?.system === 'miniwiki' && e.kind === 'group' && e.name === name);
  if (existing) return existing.id;
  const created = await saveWorldBookEntry({ kind: 'group', system: 'miniwiki', name, selective: false, constant: false }).catch(() => null);
  return created?.id || '';
}

/**
 * 同角色 + 同关键词的简报是否存在、是否新鲜：
 * - 不存在 → null（需要新搜）
 * - 存在且新鲜 → { entry, stale: false }（跳过，省搜索）
 * - 存在但过期 → { entry, stale: true }（时效内容需要重新查证覆盖，不能永久跳过）
 */
async function findExistingBriefing(characterId, keyword) {
  const all = await listAllWorldBookRows().catch(() => []);
  const kw = clean(keyword, 60).toLowerCase();
  const found = all.find((e) => e?.system === 'miniwiki'
    && (e.characterIds || []).includes(characterId)
    && (e.keys || []).some((k) => String(k).toLowerCase() === kw));
  if (!found) return null;
  const stamp = Number(found.updatedAt || found.createdAt || 0);
  return { entry: found, stale: !stamp || Date.now() - stamp > BRIEFING_STALE_MS };
}

/**
 * 编排入口：对挑好的候选条目跑「粗搜 → 筛选压缩 → 沉淀知识卡」。
 * @returns {Promise<{ cards: Array, materials: Array }>}
 *   cards：本轮写入小知识库的条目；materials：真实搜索素材（标题/URL/摘要），供补记录等调用方直接引用。
 */
export async function runInterestSearchRound({
  userId,
  characterId,
  character,
  candidates = [],
  signal = null,
  socialSearchChannels = null,
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  const list = asArray(candidates).filter((e) => e && e.keyword);
  if (!uid || !cid || !list.length) return { cards: [], materials: [] };
  const characterName = getCharacterAiContextName(character) || character?.name || 'TA';
  const personaBrief = buildToolPersonaBrief(character, list);

  const webCfg = await loadWebSearchConfig().catch(() => null);
  const webOk = !!webCfg?.enabled;
  const socialCfg = await loadSocialLinkConfig().catch(() => null);
  const socialOk = !!(socialCfg?.enabled && socialCfg?.apiKey);
  const allowedSocial = normalizeSocialSearchChannels(socialSearchChannels);
  const allEntries = await listInterestEntries(uid, cid).catch(() => list);

  const cards = [];
  const materials = [];
  for (const entry of list) {
    if (signal?.aborted) break;
    try {
      const entryChannel = entry.channel || 'casual';
      const hasProgressChannel = ['hobby', 'shopping', 'follow'].includes(entryChannel);
      const worthBriefing = entry.depth === 'deep' || hasProgressChannel;
      const existingBriefing = worthBriefing ? await findExistingBriefing(cid, entry.keyword) : null;
      if (existingBriefing && !existingBriefing.stale) continue;

      const plan = deriveSearchPlan(entry);
      let webResult = null;
      if (webOk) {
        webResult = await runGeneralSearch(plan.query, webCfg, { characterId: cid }).catch(() => null);
      }
      let socialNotes = [];
      if (socialOk && allowedSocial.length) {
        const socialChannel = pickSocialChannelForKeyword(entry.keyword, entry.topic, allowedSocial);
        socialNotes = (await fetchSocialListWithLogging(socialChannel, plan.query, { apiKey: socialCfg.apiKey, characterId: cid })).notes;
      }
      if (!webResult && !socialNotes.length) {
        // 搜都搜不出结果也算一次质量反馈：下轮换角度，别原样重试
        if (entry.id) await markInterestSearchQuality(uid, cid, entry.id, 'thin', plan.usedGoal).catch(() => {});
        continue;
      }

      for (const r of asArray(webResult?.results).slice(0, 3)) {
        materials.push({
          keyword: entry.keyword,
          source: 'web',
          title: clean(r.title, 90),
          summary: clean(r.content, 200),
          url: clean(r.url, 300),
        });
      }
      for (const n of socialNotes.slice(0, 3)) {
        materials.push({
          keyword: entry.keyword,
          source: n.channel,
          title: clean(n.title, 90) || clean(n.desc, 40),
          summary: clean(n.desc, 200),
          url: clean(n.url, 300),
        });
      }

      // staple 不走简报，走轻量提取写进常识词汇池（具体单品/店名，而不是抽象话题）
      if (entryChannel === 'staple') {
        const items = await extractTasteItemsFromSearch({ entry, webResult, socialNotes, characterName, signal }).catch(() => []);
        if (items.length) await appendTasteItems(uid, cid, entry.category || entry.keyword, items, { kind: 'item', source: 'search' }).catch(() => {});
        continue;
      }
      // 只有 deep 档或带进度存档的频道（hobby/shopping/follow）才值得再花一次 LLM 沉淀成简报；
      // casual 拿到素材（已写进 materials）就够了
      if (!worthBriefing) continue;
      const card = await distillSearchIntoCard({
        entry, webResult, socialNotes, characterName, personaBrief, backstory: resolveEntryBackstory(entry, allEntries), searchGoal: plan.usedGoal, signal,
      });
      // 质量反馈回写：good 清零噪音计数，thin/noise 累加（连续两次冷却翻倍）；
      // 解析失败（card=null）也按 thin 记一笔，下轮换角度
      if (entry.id) {
        await markInterestSearchQuality(uid, cid, entry.id, card?.resultQuality || 'thin', plan.usedGoal).catch(() => {});
      }
      if (!card || card.skipped) continue;
      const groupId = await ensureMiniwikiGroupId(resolveMiniwikiGroupKeyword(entry, allEntries)).catch(() => '');
      const saved = await saveWorldBookEntry({
        // 已有过期简报时沿用同一个 id 覆盖更新，而不是新增一条重复条目
        id: existingBriefing?.entry?.id,
        name: card.name,
        content: appendPreviousDigest(card.content, existingBriefing?.entry),
        keys: card.keys,
        groupId: groupId || existingBriefing?.entry?.groupId || '',
        selective: true,
        constant: false,
        scope: 'character',
        characterIds: [cid],
        userId: uid,
        system: 'miniwiki',
        origin: 'ai_grown',
        wikiDepth: 'deep',
        sourceUrl: clean(asArray(webResult?.results)[0]?.url || '', 300),
      });
      cards.push(saved);
      if (card.progressPatch && entry.id) {
        await applyInterestProgressPatch(uid, cid, entry.id, card.progressPatch).catch(() => {});
      }
    } catch (err) {
      console.warn('[interest-search-orchestrator] round failed for', entry.keyword, err);
    }
  }
  if (materials.length) {
    // 只沉淀进「素材池」（兴趣页可折叠查看），不写「他的手机·浏览记录」——
    // 浏览记录只留真正精搜挑出来、可能会分享的内容，列表扫过的噪音不该混进那个叙事性列表。
    await appendVerifiedPosts(uid, cid, materials.map((m) => ({
      keyword: m.keyword,
      source: m.source,
      title: m.title,
      summary: m.summary,
      url: m.url,
      depth: 'skim',
      picked: false,
      foundAt: Date.now(),
    }))).catch(() => {});
  }
  return { cards, materials };
}

/**
 * 进度自然推进：搜索只发生在有额度/有结果的时候，但角色的生活不会因此停摆——一个真的在玩
 * 星露谷的人就算这周没查攻略，存档也在往前走。对太久没动过进度的兴趣（hobby/follow），
 * 让小 LLM 按现有存档合理往前推一小步（只推"TA 自己玩出来的私人进度"，不准编造现实世界的
 * 外部新闻/版本事实——那些必须走真实搜索）。每次轮转最多推 1 条，省 LLM 预算也符合生活节奏。
 * @param scheduleHint 预留：之后接日程联动时把"TA 今天日程里玩了什么"传进来当推进依据；现在为空。
 */
const PROGRESS_IDLE_MS = 5 * 86400000;
async function advanceStaleInterestProgress({ userId, characterId, character, entries = [], scheduleHint = '', signal }) {
  const now = Date.now();
  const advanceAnchor = (entry) => Number(entry?.progress?.lastAdvancedAt || entry?.createdAt || 0);
  const entry = entries
    .filter((e) => e.status === 'active'
      && ['hobby', 'follow'].includes(e.channel)
      && e.progress
      && now - advanceAnchor(e) > PROGRESS_IDLE_MS)
    .sort((a, b) => advanceAnchor(a) - advanceAnchor(b))[0];
  if (!entry) return null;
  const characterName = getCharacterAiContextName(character) || character?.name || 'TA';
  const idleDays = Math.max(5, Math.round((now - advanceAnchor(entry)) / 86400000));
  const payload = {
    task: 'advance_hobby_progress_naturally',
    characterName,
    keyword: entry.keyword,
    progress: {
      stage: entry.progress.stage || '未记录',
      knownFacts: entry.progress.knownFacts || [],
      nextGoals: entry.progress.nextGoals || [],
      idleDays,
    },
    todaySchedule: scheduleHint || undefined,
    rules: [
      `角色「${characterName}」在玩/追「${entry.keyword}」，进度存档已经 ${idleDays} 天没动了。TA 这段时间大概率还在自己玩/追，请把存档合理往前推一小步。`,
      '只能推"TA 自己玩出来/看出来的私人进度"（比如把某个目标做完了、卡在哪、攒到什么程度），严禁编造现实世界的外部事实（新版本、新活动、官方消息这类必须靠真实搜索，不归你管）。',
      '幅度要克制：几天时间就推一小步，不要跳章节式大跃进；存档只能前进不能倒退。',
      '输出 JSON：{"stage":"更新后的阶段（没变化原样返回）","completedGoal":"如果推进中顺手做完了 nextGoals 里的某一条，原样填它；没有就留空","newGoal":"新的下一步目标（要具体到能拿去搜索，可空）","humanMoment":"一句 TA 这几天玩下来会有的真实小情绪（可空，别编模板腔）"}；推不动/没有自然的推进就输出 {"skip": true}。',
      '只输出 JSON 对象，不要解释。',
    ],
  };
  const maxTokens = await resolveGenerationMaxTokens();
  const raw = await optionalInterestChat([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.6, maxTokens, signal }, 'interest-progress');
  const parsed = extractJsonObject(raw);
  if (!parsed || parsed.skip === true) return null;
  // 全量校验：stage/goal/moment 都过 applyInterestProgressPatch 里的清洗与 isUsableProgressGoal，
  // 这里不新增事实（newFacts 不开放给自然推进，防 LLM 顺嘴编外部知识混进 knownFacts）
  const updated = await applyInterestProgressPatch(userId, characterId, entry.id, {
    stage: parsed.stage,
    completedGoal: parsed.completedGoal,
    newGoal: parsed.newGoal,
    humanMoment: parsed.humanMoment,
  }).catch(() => null);
  return updated ? { keyword: entry.keyword } : null;
}

/**
 * 母词裂变：给一个宽泛的 root 深度兴趣词（如「明日方舟」）搜一轮「最新动态」，
 * 让小 LLM 从结果里抽出几个当下真实在发生的具体子话题（如「危机合约 XX 季」），
 * 这些子词之后会进兴趣表按正常流程被搜索、沉淀成简报——从根上降低大词直接搜的噪音。
 */
async function splitRootKeywordIntoSubtopics({ rootEntry, characterName, characterId, webCfg, existingSubKeywords = [], signal }) {
  const query = clean(`${rootEntry.keyword} 最新 活动 热点 讨论`, 100);
  const result = await runGeneralSearch(query, webCfg, { characterId, category: 'interest_split' }).catch(() => null);
  const rows = asArray(result?.results).slice(0, 6).map((r) => ({
    title: clean(r.title, 90),
    content: clean(r.content, 240),
  })).filter((r) => r.title || r.content);
  if (!rows.length) return [];

  // 已覆盖负面清单：已有的兄弟子话题 + 最近沉淀过的简报标题，裂变别再给重复的面；
  // 当前进度当定位锚，让新子话题贴着"TA 玩到哪/追到哪"，不是漫无目的抓热点。
  const covered = [
    ...existingSubKeywords.map((k) => clean(k, 40)),
    ...(await listRecentBriefings(characterId, 8).catch(() => [])).map((b) => clean(b.name, 30)),
  ].filter(Boolean).slice(0, 14);
  const stage = clean(rootEntry.progress?.stage, 40);

  const payload = {
    task: 'split_root_interest_into_subtopics',
    rootKeyword: rootEntry.keyword,
    topic: rootEntry.topic || '',
    characterName,
    currentProgress: stage || undefined,
    alreadyCovered: covered.length ? covered : undefined,
    searchResults: rows,
    rules: [
      `「${rootEntry.keyword}」是角色「${characterName}」的一个大类兴趣，太宽泛不好直接搜。从上面的搜索结果里，提炼出 2~5 个当下真实存在、具体到可以直接拿去搜索引擎搜的子话题，而不是笼统话题。`,
      '每个子话题标注 kind："timely"=跟着一期活动/一个版本/一个热点走、过阵子就过时的；"thematic"=这个兴趣长期存在的玩法面/系统面/内容线（比如某游戏的钓鱼系统、某作品的某条故事线），不会几周就过时的。两类都要试着给，不要全押在热点上。',
      stage ? `currentProgress 是 TA 当前的进度（${stage}）：优先给贴近这个进度、TA 现在就用得上的子话题，太超前的剧透向/毕业向内容往后放。` : '',
      'alreadyCovered 是已经在追/已经了解过的子话题：语义重复的不要再给，同一个面的"新进展"才可以给。',
      `每个 keyword 必须包含「${rootEntry.keyword}」本身或能直接定位到该主题（如"${rootEntry.keyword} XX活动"），确保搜索时不会跑偏到别的东西。`,
      'topic 用一句话说这个子话题具体是什么。',
      '只挑搜索结果里真实提到的东西，没有把握的宁可少给；如果结果太杂噪音大、抽不出具体子话题，输出空数组 []。',
      '只输出 JSON 数组，不要解释。',
    ].filter(Boolean),
    schema: [{ keyword: '具体子话题搜索词', topic: '一句话说明', kind: 'timely 或 thematic' }],
  };
  const raw = await optionalSearchRefine([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.5, signal }, 'interest-candidates');
  return extractJsonArray(raw) || [];
}

/**
 * 手动触发一次「母词裂变」：跳过每日轮转的排队顺序和 4 天冷却，供兴趣页对某个 deep 大类词
 * 立即裂变出具体子话题——不用干等轮到这个角色，或者跑完冷却才等到下一次。
 * 花费与后台自动裂变一致（一次通用搜索 + 一次小 LLM 调用），走通用联网搜索的每日额度。
 */
export async function runManualInterestSplit({ userId, characterId, character, rootEntry, signal = null } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!uid || !cid || !rootEntry?.id) return { subs: [], reason: 'missing-params' };
  const webCfg = await loadWebSearchConfig().catch(() => null);
  if (!webCfg?.enabled) return { subs: [], reason: 'web-search-disabled' };
  const characterName = getCharacterAiContextName(character) || character?.name || 'TA';
  const siblings = (await listInterestEntries(uid, cid).catch(() => []))
    .filter((e) => e.kind === 'sub' && e.rootId === rootEntry.id).map((e) => e.keyword);
  const subs = await splitRootKeywordIntoSubtopics({ rootEntry, characterName, characterId: cid, webCfg, existingSubKeywords: siblings, signal });
  const added = await saveSplitSubEntries(uid, cid, rootEntry, subs);
  await markInterestSplit(uid, cid, rootEntry.id);
  return { subs: added, reason: added.length ? '' : 'no-subtopics-found' };
}

/**
 * 每日轮转编排入口：一个角色跑一整套「过期子话题退休 → 母词裂变（限速） → 候选词搜索沉淀」。
 * 供后台定时任务调用，也可以直接替代 phone-records 里手写的兴趣搜索逻辑。
 */
export async function runDailyInterestRotationForCharacter({ userId, characterId, character, signal } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!uid || !cid) return { split: false, cards: [], materials: [] };

  const tracking = await loadInterestTrackingSettings(uid, cid).catch(() => ({
    autoTrackEnabled: false, sharePostSearchEnabled: false, shareDailyTarget: 1, autoTrackCandidatesPerRound: 2,
  }));

  let entries = await listInterestEntries(uid, cid);
  let split = false;
  let result = { cards: [], materials: [] };
  // 关了「后台自动追踪」的角色（可能只想留着「分享真实帖子精搜」）不参与过期归档/裂变/候选词搜索，
  // 只走下面的分享补货；否则关掉开关也会被后台悄悄裂变新词、搜新内容，跟用户预期不符。
  if (tracking.autoTrackEnabled !== false) {
    await archiveExpiredInterestEntries(uid, cid).catch(() => {});
    entries = await listInterestEntries(uid, cid);

    const rootForSplit = pickRootForSplit(entries);
    if (rootForSplit) {
      try {
        const webCfg = await loadWebSearchConfig().catch(() => null);
        if (webCfg?.enabled) {
          const characterName = getCharacterAiContextName(character) || character?.name || 'TA';
          const siblings = entries.filter((e) => e.kind === 'sub' && e.rootId === rootForSplit.id).map((e) => e.keyword);
          const subs = await splitRootKeywordIntoSubtopics({ rootEntry: rootForSplit, characterName, characterId: cid, webCfg, existingSubKeywords: siblings, signal });
          await saveSplitSubEntries(uid, cid, rootForSplit, subs);
          split = subs.length > 0;
        }
        await markInterestSplit(uid, cid, rootForSplit.id);
      } catch (err) {
        console.warn('[interest-search-orchestrator] split failed for', rootForSplit.keyword, err);
      }
      entries = await listInterestEntries(uid, cid);
    }

    const candidates = pickInterestCandidates(entries, { limit: tracking.autoTrackCandidatesPerRound || 2 });
    result = await runInterestSearchRound({
      userId: uid,
      characterId: cid,
      character,
      candidates,
      signal,
      socialSearchChannels: tracking.socialSearchChannels,
    });
    if (candidates.length) {
      await markInterestUsed(uid, cid, candidates.map((e) => e.id)).catch(() => {});
    }

    // 搜索没轮到/没结果的兴趣，进度也别永远停着：太久没动的存档让小 LLM 自然推一小步
    // （每轮最多 1 条；scheduleHint 预留给日程联动，之后把"TA 今天玩了什么"接进来）
    try {
      entries = await listInterestEntries(uid, cid);
      await advanceStaleInterestProgress({ userId: uid, characterId: cid, character, entries, signal });
    } catch (err) {
      console.warn('[interest-search-orchestrator] natural progress advance failed', err);
    }
  }

  // 开了「分享真实帖子精搜」的角色，每日轮转顺带自动补货，直到「深读过但还没分享」的候选数
  // 攒够 shareDailyTarget（用户可调，默认 1）——这样"每天分享几条"才会真的体现在补货节奏上。
  // 单次轮转最多补 SHARE_POST_REFILL_MAX_PER_ROTATION 条（限速，避免一口气把当天社媒额度全用掉），
  // 缺口不大就少补，攒够了本轮就直接跳过不再精搜；换词避免拿同一个关键词反复搜出重复内容。
  // AI 选词（优先衍生子话题）+ 按词自动挑渠道，走正常社媒额度（manual=false），额度用完当天自然跳过。
  let sharePost = null;
  const sharePosts = [];
  try {
    if (tracking.sharePostSearchEnabled && tracking.shareDailyTarget > 0) {
      const pool = await listVerifiedPosts(uid, cid).catch(() => []);
      const openKeywords = new Set(entries.filter((e) => e.surfaceMode !== 'quiet').map((e) => e.keyword));
      let readyCount = pool.filter((p) => p.depth === 'read' && !p.sharedAt && p.url
        && isFreshSharePost(p) && (!p.keyword || openKeywords.has(p.keyword))).length;
      const shortfall = tracking.shareDailyTarget - readyCount;
      const refillBudget = Math.max(0, Math.min(shortfall, SHARE_POST_REFILL_MAX_PER_ROTATION));
      const triedKeywords = new Set();
      // 兴趣轮换依据：每个关键词最近一次真实分享的时间（久未分享的兴趣优先补货）
      const lastSharedAtByKeyword = new Map();
      for (const p of pool) {
        if (!p?.keyword || !p.sharedAt) continue;
        lastSharedAtByKeyword.set(p.keyword, Math.max(lastSharedAtByKeyword.get(p.keyword) || 0, p.sharedAt));
      }
      for (let i = 0; i < refillBudget; i += 1) {
        const pick = pickAutoShareKeyword(entries, triedKeywords, { lastSharedAtByKeyword });
        if (!pick?.keyword) break;
        triedKeywords.add(pick.keyword);
        // 只走用户勾选的分享渠道：网页在勾选且可用时优先（省 TikHub），再从勾选社媒里按词性挑一个
        const webCfg2 = await loadWebSearchConfig().catch(() => null);
        const socialCfg2 = await loadSocialLinkConfig().catch(() => null);
        const attempt = resolveShareSearchAttempt(tracking.shareSearchChannels, {
          webOk: !!webCfg2?.enabled,
          socialOk: !!(socialCfg2?.enabled && socialCfg2?.apiKey),
        });
        let shareResult = attempt.tryWeb
          ? await runWebLinkShareSearch({
            userId: uid, characterId: cid, character, keyword: pick.keyword, entryChannel: pick.channel,
            progress: pick.progress, kind: pick.kind, subKind: pick.subKind, topic: pick.topic, manual: false, signal,
          })
          : null;
        if (!shareResult?.post && attempt.socialAllowed.length) {
          shareResult = await runSharePostSearch({
            userId: uid,
            characterId: cid,
            character,
            keyword: pick.keyword,
            entryChannel: pick.channel,
            progress: pick.progress,
            kind: pick.kind,
            subKind: pick.subKind,
            topic: pick.topic,
            channel: pickSocialChannelForKeyword(pick.keyword, pick.topic, attempt.socialAllowed),
            manual: false,
            signal,
          });
        }
        if (shareResult?.post) {
          sharePosts.push(shareResult.post);
          readyCount += 1;
        }
      }
      sharePost = sharePosts[0] || null;
    }
  } catch (err) {
    console.warn('[interest-search-orchestrator] auto share post failed', err);
  }
  return {
    split, sharePost, sharePosts, ...result,
  };
}

/**
 * 手动补充积累：立即对某个兴趣词跑一轮搜索 + 沉淀，绕开每日总额度（不影响后台轮转自己的预算），
 * 供用户测试效果或想快速积累某个方向的素材时用。channels 由用户在兴趣页手动选。
 * @param channels 数组，元素为 'web' | 'xiaohongshu' | 'weibo' | 'bilibili'
 */
export async function runManualInterestSearch({ userId, characterId, character, entry, channels = ['web'] } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!uid || !cid || !entry?.keyword) return { card: null, materials: [] };
  const characterName = getCharacterAiContextName(character) || character?.name || 'TA';
  const wantWeb = channels.includes('web');
  const socialChannels = channels.filter((c) => ['xiaohongshu', 'weibo', 'bilibili'].includes(c));

  const webCfg = await loadWebSearchConfig().catch(() => null);
  const socialCfg = await loadSocialLinkConfig().catch(() => null);

  let webResult = null;
  let webFailError = '';
  if (wantWeb && webCfg?.enabled) {
    webResult = await runGeneralSearch(clean(entry.keyword, 100), webCfg, {
      skipDailyLimit: true, characterId: cid, category: 'interest_manual',
    }).catch((err) => { webFailError = String(err?.message || err || ''); return null; });
  }
  let socialNotes = [];
  let socialFailReason = '';
  let socialFailError = '';
  if (socialChannels.length && socialCfg?.enabled && socialCfg?.apiKey) {
    for (const ch of socialChannels) {
      const result = await fetchSocialListWithLogging(ch, entry.keyword, {
        apiKey: socialCfg.apiKey, characterId: cid, skipDailyLimit: true, category: 'interest_manual',
      });
      socialNotes.push(...result.notes);
      // 多渠道会覆盖写，只要有一个渠道报了 api_error 就优先把这个原因带出去，别被后面渠道的
      // empty_result 盖掉——接口报错比"确实没搜到"更值得让用户知道。
      if (result.reason === 'api_error' && socialFailReason !== 'api_error') {
        socialFailReason = 'api_error';
        socialFailError = result.error;
      } else if (!socialFailReason && result.reason) {
        socialFailReason = result.reason;
      }
    }
  }
  if (!webResult && !socialNotes.length) {
    // 网页搜索报错优先暴露（明确开了这个渠道却没搜到，大概率是接口问题，不是"没找到内容"）
    if (wantWeb && webFailError) return { card: null, materials: [], reason: 'api_error', error: webFailError };
    return { card: null, materials: [], reason: socialFailReason || (wantWeb ? 'empty_result' : ''), error: socialFailError };
  }

  const materials = [
    ...asArray(webResult?.results).slice(0, 3).map((r) => ({
      keyword: entry.keyword, source: 'web', title: clean(r.title, 90), summary: clean(r.content, 200), url: clean(r.url, 300),
    })),
    ...socialNotes.slice(0, 6).map((n) => ({
      keyword: entry.keyword, source: n.channel, title: clean(n.title, 90) || clean(n.desc, 40), summary: clean(n.desc, 200), url: clean(n.url, 300),
    })),
  ];

  // 手动触发是明确意图，不论浅深都尝试沉淀一条简报（常规轮转只对 deep 档才做这一步）
  const existingBriefing = await findExistingBriefing(cid, entry.keyword).catch(() => null);
  const allEntries = await listInterestEntries(uid, cid).catch(() => [entry]);
  const personaBrief = buildToolPersonaBrief(character, allEntries);
  const card = await distillSearchIntoCard({
    entry, webResult, socialNotes, characterName, personaBrief, backstory: resolveEntryBackstory(entry, allEntries), signal: null,
  });
  if (materials.length) {
    await appendVerifiedPosts(uid, cid, materials.map((m) => ({
      ...m, depth: 'skim', picked: false, foundAt: Date.now(),
    }))).catch(() => {});
  }
  let saved = null;
  if (card && !card.skipped) {
    const groupId = await ensureMiniwikiGroupId(resolveMiniwikiGroupKeyword(entry, allEntries)).catch(() => '');
    saved = await saveWorldBookEntry({
      id: existingBriefing?.entry?.id,
      name: card.name,
      content: appendPreviousDigest(card.content, existingBriefing?.entry),
      keys: card.keys,
      groupId: groupId || existingBriefing?.entry?.groupId || '',
      selective: true,
      constant: false,
      scope: 'character',
      characterIds: [cid],
      userId: uid,
      system: 'miniwiki',
      origin: 'ai_grown',
      wikiDepth: 'deep',
      sourceUrl: clean(asArray(webResult?.results)[0]?.url || '', 300),
    });
  }
  await markInterestUsed(uid, cid, [entry.id]).catch(() => {});
  return { card: saved, materials };
}

/**
 * LLM 给的话题标签不可尽信：只留短干净的中文/字母标签，带标点/太长/像 JSON 残渣的丢弃
 * （丢了也没关系，话题冷却是加分项，退化成 url 级去重而已）。
 */
function sanitizeTopicTag(raw = '') {
  const t = clean(raw, 16).replace(/^#+|#+$/g, '');
  if (t.length < 2 || t.length > 14) return '';
  if (/[{}\[\]"<>：:，,。/\\]/.test(t)) return '';
  return t;
}

/** 帖子池里最近 N 天分享过的话题标签集合，给精选当回避清单、给分享兜底当冷却过滤。 */
const TOPIC_SHARE_COOLDOWN_MS = 7 * 86400000;
export function collectRecentSharedTopics(pool = [], now = Date.now()) {
  return [...new Set(
    (Array.isArray(pool) ? pool : [])
      .filter((p) => p?.sharedAt && now - p.sharedAt < TOPIC_SHARE_COOLDOWN_MS)
      .map((p) => sanitizeTopicTag(p.topicTag))
      .filter(Boolean),
  )];
}

/**
 * 精选模型技术失败时的确定性兜底。只从带稳定帖子 id、且仍通过程序化质检的候选里选；
 * 优先关键词直接命中、信息更完整、互动数更高的条目。模型明确返回 skip 时不会走这里。
 */
export function pickShareCandidateFallback(notes = [], keyword = '', { curationEnabled = true } = {}) {
  const kw = clean(keyword, 60).toLowerCase();
  return (Array.isArray(notes) ? notes : [])
    .map((note, index) => {
      const id = String(note?.id || '').trim();
      const title = clean(note?.title, 120);
      const desc = clean(note?.desc, 300);
      if (!id || (!title && !desc)) return null;
      if (curationEnabled && isLowQualityShareCandidate(note)) return null;
      const haystack = `${title} ${desc}`.toLowerCase();
      const likeCount = Math.max(0, Number(note?.likeCount) || 0);
      const score = (kw && haystack.includes(kw) ? 1000 : 0)
        + (title ? 120 : 0)
        + Math.min(desc.length, 240)
        + Math.min(Math.log10(likeCount + 1) * 20, 80)
        - index;
      return { note, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)[0]?.note || null;
}

function buildSharePickerRows(notes = []) {
  return (Array.isArray(notes) ? notes : []).slice(0, 10)
    .map((note, index) => ({
      ref: String(index + 1),
      id: String(note?.id || '').trim(),
      platform: SOCIAL_CHANNEL_LABEL[note?.channel] || note?.channel,
      title: clean(note?.title, 120),
      desc: clean(note?.desc, 300),
      likeCount: Math.max(0, Number(note?.likeCount) || 0),
    }))
    .filter((row) => row.id && (row.title || row.desc));
}

/** 把模型选帖回复分成「明确跳过 / 正常选中 / 技术失败后兜底」，供主流程与回归测试共用。 */
export function resolveSharePickerDecision({
  raw = '', notes = [], keyword = '', curationEnabled = true, technicalError = '',
} = {}) {
  const rows = buildSharePickerRows(notes);
  if (!rows.length) return { failed: true, failureReason: 'no-valid-candidate-id' };

  const fallback = (failureReason, error = '') => {
    const note = pickShareCandidateFallback(notes, keyword, { curationEnabled });
    if (!note) return { failed: true, failureReason, error };
    return {
      id: String(note.id || '').trim(),
      channel: note.channel,
      title: clean(note.title, 120) || clean(note.desc, 60),
      reason: '',
      topicTag: '',
      xsecToken: note.xsecToken || '',
      fallbackUsed: true,
      fallbackReason: failureReason,
    };
  };

  if (technicalError) return fallback('picker-api-error', technicalError);
  const parsed = extractJsonObject(raw);
  if (!parsed) return fallback('picker-invalid-response');
  if (parsed.skip === true) return { skipped: true, skipReason: 'model-skip' };
  const selectedRef = parsed.ref == null ? '' : String(parsed.ref).trim();
  const legacyId = parsed.id == null ? '' : String(parsed.id).trim();
  if (!selectedRef && !legacyId) return fallback('picker-invalid-response');
  const match = rows.find((row) => row.ref === selectedRef || row.id === legacyId);
  if (!match) return fallback('picker-invalid-selection');
  const note = notes.find((candidate) => String(candidate?.id || '').trim() === match.id);
  return {
    id: match.id,
    channel: note?.channel,
    title: match.title,
    reason: clean(parsed.reason, 120),
    topicTag: sanitizeTopicTag(parsed.topicTag),
    xsecToken: note?.xsecToken || '',
  };
}

/**
 * 挑一条「TA 真的会点开细看」的候选帖：不是选热度最高的，要贴合关键词本身、避免标题党/无关广告。
 * notes 已经是 searchSocialList 统一后的 { id, title, desc, likeCount, channel } 形状。
 */
async function pickInterestingPost({
  keyword, characterName, notes, personaBrief = null, avoidTitles = [], contentPref = 'safe', avoidNotes = '', recentChat = [], recentSharedTopics = [], curationEnabled = true, timely = false, signal,
}) {
  const rows = buildSharePickerRows(notes);
  if (!rows.length) return { failed: true, failureReason: 'no-valid-candidate-id' };
  const payload = {
    task: 'pick_post_worth_reading_in_full',
    keyword,
    currentDate: dayKey(),
    characterName,
    characterProfile: personaBrief || undefined,
    recentChatWithUser: recentChat.length ? recentChat : undefined,
    recentlyReadTitles: avoidTitles.length ? avoidTitles : undefined,
    recentlySharedTopics: recentSharedTopics.length ? recentSharedTopics : undefined,
    candidates: rows.map(({ ref, platform, title, desc, likeCount }) => ({
      ref, platform, title, desc, likeCount,
    })),
    rules: [
      `角色「${characterName}」搜了「${keyword}」相关的帖子/视频列表，从候选里选一条 TA 真的会点开细看的——结合 characterProfile 里的性格与在追的兴趣判断什么才是 TA 的取向：攻略型的人挑干货攻略，爱凑热闹的人挑争议讨论，不是随便选热度最高的，也别选明显标题党/无关广告/空泛"如何评价"式的水贴。`,
      ...(curationEnabled ? qualityGuardRules() : []),
      '凡候选涉及活动排期、卡池、赛季或版本日期，必须对照 currentDate 判断正文事件是否仍在进行或尚未开始；已经结束的往期内容不得选择，页面最近发布或更新不代表正文事件仍有效。',
      ...(timely ? [
        '这是时效资讯筛选：活动排期、卡池、赛季、版本等内容必须明确仍在当前日期进行中或尚未开始；已经结束、明显属于往期、无法判断日期的候选都跳过。页面最近发布或更新，不等于正文里的活动仍有效。',
      ] : []),
      ...contentAvoidRules(contentPref),
      avoidNotesRule(avoidNotes),
      recentChat.length ? 'recentChatWithUser 是 TA 最近和用户的聊天片段：候选内容如果恰好接得上最近聊到的话题（比如用户提过的顾虑、正在聊的相关话题），优先选它；接不上就按角色兴趣正常判断，不要为了硬凑关联而选一条明显更差的。' : '',
      'recentlyReadTitles 是 TA 最近已经细看过的：内容高度雷同的候选不要再选（原地打转），但同话题的「新进展/不同角度」可以选。',
      recentSharedTopics.length ? 'recentlySharedTopics 是 TA 最近几天已经分享过的话题面：属于同一个面的候选不要再选（对方会觉得"你怎么老发这个"），换个面。' : '',
      '给选中的候选打一个 topicTag：2~10 字的话题面短标签（如「传说鱼攻略」「新活动情报」「设备种草」），描述它属于哪一类话题，用来做同话题去重。',
      '只输出 JSON：{"ref": "选中候选的短编号", "reason": "一句话说这条为什么值得点开（像 TA 转发给别人时会说的一句话）", "topicTag": "话题面短标签"}；ref 必须原样复制 candidates 里的短编号，不要抄帖子长 id；候选都不值得看时输出 {"skip": true}。',
    ].filter(Boolean),
  };
  const refineResult = await optionalSearchRefineResult([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.4, signal }, 'interest-share-review');
  // 「LLM 主动判 skip（候选全是广告/水贴，不值得分享）」和「调用/解析失败」必须分开返回：
  // skip 是审核结论，调用方要尊重；只有失败（null）才允许程序兜底选一条。
  return resolveSharePickerDecision({
    raw: refineResult.raw,
    notes,
    keyword,
    curationEnabled,
    technicalError: refineResult.error
      ? String(refineResult.error?.message || refineResult.error || '')
      : '',
  });
}

/**
 * 「分享真实帖子」精搜升级（重，需要单独开关，兴趣页可快捷开关）：
 *   按渠道搜列表（小红书/微博/B站） → 小 LLM 精选一条角色真的会点开的 → 取正文详情（可选带评论区）
 *   → 存入「TA 刷到过」帖子池（聊天可分享真实链接）+ 写进「他的手机 · 浏览记录」（角色自己也确实刷到过）。
 * 比常规兴趣搜索更贵：多一次 TikHub 详情调用（+ 可选评论调用）+ 一次 LLM 精选。
 * manual=true（兴趣页手动触发）时不占社媒每日额度；manual=false（后台轮转自动补充）时走正常额度。
 * 精搜前先看素材池：如果同关键词最近已经攒过带链接的社媒素材，直接从池里精选取正文，省掉列表搜索那一次调用。
 * 受「分享真实帖子精搜」单角色开关约束，默认关。
 * @param channel 'xiaohongshu' | 'weibo' | 'bilibili'
 */
export async function runSharePostSearch({
  userId, characterId, character, keyword, entryChannel = '', progress = null, kind = 'root', subKind = '', topic = '', channel = 'xiaohongshu', includeComments = false, commentCount = 3, manual = true, signal = null,
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  const kw = clean(keyword, 60);
  const requestedChannel = ['xiaohongshu', 'weibo', 'bilibili'].includes(channel) ? channel : 'xiaohongshu';
  if (!uid || !cid || !kw) return { post: null, reason: 'missing-params' };

  const trackSettings = await loadInterestTrackingSettings(uid, cid).catch(() => ({ sharePostSearchEnabled: false }));
  if (!trackSettings.sharePostSearchEnabled) return { post: null, reason: 'feature-disabled' };

  const socialCfg = await loadSocialLinkConfig().catch(() => null);
  if (!socialCfg?.enabled || !socialCfg?.apiKey) return { post: null, reason: 'social-link-disabled' };
  const webCfgForCuration = await loadWebSearchConfig().catch(() => null);
  const curationEnabled = webCfgForCuration?.materialCurationEnabled !== false;
  const characterName = getCharacterAiContextName(character) || character?.name || 'TA';
  const allPooled = await listVerifiedPosts(uid, cid).catch(() => []);
  const interestEntries = await listInterestEntries(uid, cid).catch(() => []);
  const personaBrief = buildToolPersonaBrief(character, interestEntries);
  const searchEntry = { keyword: kw, channel: entryChannel, progress, kind, subKind, topic };
  const searchPlan = deriveShareSearchPlan(searchEntry);
  // 挑帖记忆：最近深读过的标题（避免重复挑雷同内容）；已分享过的链接直接从候选剔除；
  // 最近分享过的话题面进冷却（同一个面的存货 7 天内不再端出来）
  const avoidTitles = allPooled.filter((p) => p.depth === 'read' && p.title).slice(0, 8).map((p) => p.title);
  const sharedUrls = new Set(allPooled.filter((p) => p.sharedAt).map((p) => p.url));
  const recentSharedTopics = collectRecentSharedTopics(allPooled);
  const cooledTopics = new Set(recentSharedTopics);

  // 池里已有同关键词「深读过但还没分享」的帖子：零调用直接返回它，不再重复搜+精选+取正文
  // （质检上线前入池的旧广告帖在这里也要拦一道）
  const readyToShare = allPooled.find((p) => p.keyword === kw && p.url && p.depth === 'read' && !p.sharedAt
    && isFreshSharePost(p)
    && (!p.topicTag || !cooledTopics.has(p.topicTag))
    && (!curationEnabled || !isLowQualityPooledPost(p)));
  if (readyToShare) {
    return {
      post: { title: readyToShare.title, url: readyToShare.url, summary: readyToShare.summary, reason: readyToShare.reason || '' },
      reused: true,
    };
  }

  // 复用快路径：同关键词、3 天内、带可识别社媒链接的池内素材，直接当候选，省一次列表搜索。
  // 池里可能有质检上线前攒下的旧素材，同样过一遍程序化质检再进候选。
  const POOL_FRESH_MS = 3 * 86400000;
  const pooled = allPooled
    .filter((p) => p.keyword === kw && p.url && !p.sharedAt && Date.now() - (p.foundAt || 0) < POOL_FRESH_MS)
    .filter((p) => !curationEnabled || !isLowQualityShareCandidate({ title: p.title, desc: p.summary, url: p.url }))
    .map((p) => {
      const loc = extractSocialIdFromUrl(p.url);
      return loc ? {
        id: loc.id, channel: loc.channel, title: p.title, desc: p.summary, url: p.url, likeCount: 0, xsecToken: loc.xsecToken || '',
      } : null;
    })
    .filter(Boolean);

  let notes = pooled;
  let reused = pooled.length > 0;
  let listReason = '';
  let listError = '';
  if (!notes.length) {
    // 同样按频道+进度派生搜索词：游戏/追更类关键词带上当前进度再去搜社媒列表，
    // 更容易搜到"具体章节讨论"而不是笼统的入门贴/软件推广笔记。
    const searchQuery = searchPlan.query;
    const listResult = await fetchSocialListWithLogging(requestedChannel, searchQuery, {
      apiKey: socialCfg.apiKey, characterId: cid, skipDailyLimit: manual, category: 'share_post_search',
    });
    notes = listResult.notes.filter((n) => (!n.url || !sharedUrls.has(n.url)) && (!curationEnabled || !isLowQualityShareCandidate(n)));
    listReason = listResult.reason;
    listError = listResult.error;
  }
  if (!notes.length) {
    // 接口报错和配额用完都不是「没搜到相关内容」——分开报出来，不然用户会误以为这个词/渠道真的搜不到东西
    if (listReason === 'api_error') return { post: null, reason: 'api-error', error: listError };
    if (listReason === 'quota_exceeded') return { post: null, reason: 'quota-exceeded' };
    return { post: null, reason: 'no-results', resultCount: 0 };
  }

  const contentPref = interestEntries.find((e) => e.keyword === kw)?.contentPref || 'safe';
  const recentChat = await collectRecentChatLines(uid, cid, characterName).catch(() => []);
  const picked = await pickInterestingPost({
    keyword: kw, characterName, notes, personaBrief, avoidTitles, contentPref, avoidNotes: trackSettings.avoidNotes, recentChat, recentSharedTopics, curationEnabled, timely: searchPlan.timely === true, signal,
  });
  // LLM 明确判了 skip（候选全是广告/水贴/雷点）：尊重审核结论，这轮就是没有可分享的，
  // 不能拿"第一条能用的"硬顶上去——那会把整个精选审核架空。
  if (picked?.skipped) {
    return { post: null, reason: 'nothing-picked', resultCount: notes.length };
  }
  if (picked?.failed) {
    return {
      post: null,
      reason: picked.failureReason || 'picker-invalid-response',
      error: picked.error || '',
      resultCount: notes.length,
    };
  }
  const finalPick = picked;
  if (!finalPick?.id) {
    return { post: null, reason: notes.length ? 'picker-invalid-response' : 'no-results', resultCount: notes.length };
  }
  if (finalPick.fallbackUsed) {
    appendDebugEvent({
      type: 'interest_share_picker_fallback',
      level: 'warn',
      message: '分享精搜的 AI 精选技术失败，已使用通过程序化质检的候选兜底',
      context: {
        scope: 'interest-share-review',
        reason: finalPick.fallbackReason || 'unknown',
        channel: requestedChannel,
        resultCount: notes.length,
      },
    });
  }
  const ch = finalPick.channel || requestedChannel;

  let detail = null;
  try {
    detail = await fetchSocialDetail(ch, finalPick.id, {
      apiKey: socialCfg.apiKey,
      includeComments,
      commentCount,
      cacheDays: socialCfg.cacheDays,
      xsecToken: finalPick.xsecToken || '',
    });
    logSearchCall({
      category: 'share_post_detail', provider: ch, characterId: cid, ok: !!detail, query: kw, manual,
    }).catch(() => {});
  } catch (err) {
    logSearchCall({
      category: 'share_post_detail', provider: ch, characterId: cid, ok: false, query: kw, manual,
      error: String(err?.message || err || ''),
    }).catch(() => {});
    return { post: null, reason: 'detail-fetch-failed' };
  }
  if (!detail || (!detail.desc && !detail.title)) return { post: null, reason: 'empty-detail' };

  const noteUrl = detail.url || '';
  if (curationEnabled) {
    const detailQuality = classifyShareCandidateQuality({
      title: detail.title || finalPick.title,
      desc: detail.desc,
      url: noteUrl,
    });
    if (detailQuality.lowQuality) {
      appendDebugEvent({
        type: 'interest_share_detail_rejected',
        level: 'info',
        message: '分享精搜取到正文后识别出明确广告信号，未写入素材池',
        context: {
          channel: ch,
          reasons: detailQuality.reasons,
        },
      });
      return {
        post: null,
        reason: 'detail-rejected-low-quality',
        qualityReasons: detailQuality.reasons,
      };
    }
  }
  const summary = clean(detail.desc, 260);
  const commentLines = includeComments && Array.isArray(detail.comments) && detail.comments.length
    ? detail.comments.slice(0, commentCount).map((c) => `${c.author || '网友'}：${c.text}`).join('\n')
    : '';
  const title = clean(detail.title, 100) || clean(finalPick.title, 100) || clean(summary, 24);
  let coverUrl = clean(detail.cover || (Array.isArray(detail.images) ? detail.images[0] : '') || '', 500);
  if (coverUrl.startsWith('//')) coverUrl = `https:${coverUrl}`;
  else if (/^http:\/\//i.test(coverUrl)) coverUrl = `https://${coverUrl.slice(7)}`;
  const imageCount = Array.isArray(detail.images) ? detail.images.filter(Boolean).length : (coverUrl ? 1 : 0);

  await appendVerifiedPosts(uid, cid, [{
    keyword: kw, source: ch, title, summary, url: noteUrl, coverUrl, depth: 'read', picked: true, reason: finalPick.reason || '', topicTag: finalPick.topicTag || '', foundAt: Date.now(),
  }]).catch(() => {});

  try {
    const phone = await loadCharacterPhone(uid, cid);
    const next = mergePhoneStructuredPatch(phone, {
      source: 'sharePostSearch',
      browserRecords: [{
        title,
        query: kw,
        url: noteUrl,
        coverUrl,
        imageCount,
        sourceName: SOCIAL_CHANNEL_LABEL[ch] || ch,
        linkType: 'real',
        summary,
        body: commentLines ? `${summary}\n\n热评：\n${commentLines}` : summary,
        aiJudgement: finalPick.reason,
        shareStatus: 'pending',
      }],
    });
    await saveCharacterPhone(next);
  } catch (err) {
    console.warn('[interest-search-orchestrator] write browser record failed', err);
  }

  return {
    post: { title, url: noteUrl, summary, reason: finalPick.reason },
    reused,
    fallbackUsed: finalPick.fallbackUsed === true,
    fallbackReason: finalPick.fallbackReason || '',
  };
}

/**
 * 挑一条「值得分享」的普通网页链接（网页链接精搜分享通道用）：形状和 pickInterestingPost 类似，
 * 但候选来自免费的通用联网搜索（Tavily/Exa 等），用 url 当唯一标识（网页没有稳定的平台 id）。
 */
async function pickWebLinkWorthSharing({
  keyword, characterName, results, personaBrief = null, avoidTitles = [], contentPref = 'safe', avoidNotes = '', recentChat = [], recentSharedTopics = [], curationEnabled = true, timely = false, signal,
}) {
  const rows = results.slice(0, 8)
    .map((r, i) => ({ ref: String(i), title: clean(r.title, 90), desc: clean(r.content, 220), url: clean(r.url, 300) }))
    .filter((r) => r.url && (r.title || r.desc));
  if (!rows.length) return null;
  const payload = {
    task: 'pick_web_link_worth_sharing',
    keyword,
    currentDate: dayKey(),
    characterName,
    characterProfile: personaBrief || undefined,
    recentChatWithUser: recentChat.length ? recentChat : undefined,
    recentlyReadTitles: avoidTitles.length ? avoidTitles : undefined,
    recentlySharedTopics: recentSharedTopics.length ? recentSharedTopics : undefined,
    candidates: rows.map(({ ref, title, desc }) => ({ ref, title, desc })),
    rules: [
      `角色「${characterName}」搜了「${keyword}」相关的网页列表，从候选里选一条 TA 真的会点开细看、也愿意转发给对方看的——不是随便选第一条，也别选明显是广告/导航页/无关内容的。`,
      ...(curationEnabled ? qualityGuardRules() : []),
      '凡候选涉及活动排期、卡池、赛季或版本日期，必须对照 currentDate 判断正文事件是否仍在进行或尚未开始；已经结束的往期内容不得选择，页面最近发布或更新不代表正文事件仍有效。',
      ...(timely ? [
        '这是时效资讯筛选：活动排期、卡池、赛季、版本等内容必须明确仍在当前日期进行中或尚未开始；已经结束、明显属于往期、无法判断日期的候选都跳过。页面最近发布或更新，不等于正文里的活动仍有效。',
      ] : []),
      ...contentAvoidRules(contentPref),
      avoidNotesRule(avoidNotes),
      recentChat.length ? 'recentChatWithUser 是 TA 最近和用户的聊天片段：候选内容如果恰好接得上最近聊到的话题，优先选它；接不上就按角色兴趣正常判断，不要为了硬凑关联而选一条明显更差的。' : '',
      'recentlyReadTitles 是 TA 最近已经细看过的：内容高度雷同的候选不要再选（原地打转），但同话题的「新进展/不同角度」可以选。',
      recentSharedTopics.length ? 'recentlySharedTopics 是 TA 最近几天已经分享过的话题面：属于同一个面的候选不要再选（对方会觉得"你怎么老发这个"），换个面。' : '',
      '给选中的候选打一个 topicTag：2~10 字的话题面短标签（如「传说鱼攻略」「新活动情报」「设备种草」），描述它属于哪一类话题，用来做同话题去重。',
      '只输出 JSON：{"ref": "选中候选的 ref", "reason": "一句话说这条为什么值得点开", "topicTag": "话题面短标签"}；候选都不值得看时输出 {"skip": true}。',
    ].filter(Boolean),
  };
  const raw = await optionalSearchRefine([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.4, signal }, 'interest-share-pick');
  const parsed = extractJsonObject(raw);
  if (!parsed || parsed.skip === true || parsed.ref == null) return null;
  const match = rows.find((r) => r.ref === String(parsed.ref).trim());
  if (!match) return null;
  return { url: match.url, title: match.title, desc: match.desc, reason: clean(parsed.reason, 120), topicTag: sanitizeTopicTag(parsed.topicTag) };
}

/**
 * 「网页链接精搜分享」——和 runSharePostSearch 平行的免费渠道：数据源是通用联网搜索
 * （Tavily/Exa 等），不占 TikHub 额度。流程比社媒精搜短：网页搜索的 content 字段本身已经是
 * 摘要正文，够用来判断+分享，不需要再单独拉一次详情。受同一个「分享真实帖子精搜」开关约束。
 * 候选列表在送进 LLM 精选前会先过一道程序化质检（应用商店产品页/电商促销软文直接剔除，
 * 受「LLM 素材整理」开关 materialCurationEnabled 控制），搜索词也会按兴趣频道+当前进度
 * 派生得更具体，减少选中首页/产品列表页这类没有实质内容的候选。
 */
export async function runWebLinkShareSearch({
  userId, characterId, character, keyword, entryChannel = '', progress = null, kind = 'root', subKind = '', topic = '', manual = true, signal = null,
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  const kw = clean(keyword, 60);
  if (!uid || !cid || !kw) return { post: null, reason: 'missing-params' };

  const trackSettings = await loadInterestTrackingSettings(uid, cid).catch(() => ({ sharePostSearchEnabled: false }));
  if (!trackSettings.sharePostSearchEnabled) return { post: null, reason: 'feature-disabled' };

  const webCfg = await loadWebSearchConfig().catch(() => null);
  if (!webCfg?.enabled) return { post: null, reason: 'web-search-disabled' };
  const curationEnabled = webCfg?.materialCurationEnabled !== false;

  const characterName = getCharacterAiContextName(character) || character?.name || 'TA';
  const allPooled = await listVerifiedPosts(uid, cid).catch(() => []);
  const interestEntries = await listInterestEntries(uid, cid).catch(() => []);
  const personaBrief = buildToolPersonaBrief(character, interestEntries);
  const searchPlan = deriveShareSearchPlan({ keyword: kw, channel: entryChannel, progress, kind, subKind, topic });
  const avoidTitles = allPooled.filter((p) => p.depth === 'read' && p.title).slice(0, 8).map((p) => p.title);
  const sharedUrls = new Set(allPooled.filter((p) => p.sharedAt).map((p) => p.url));
  const recentSharedTopics = collectRecentSharedTopics(allPooled);
  const cooledTopics = new Set(recentSharedTopics);

  // 池里已有同关键词、来源是网页、深读过但还没分享的：零调用直接返回（话题在冷却期、
  // 或命中低质量判定的旧存货除外）
  const readyToShare = allPooled.find((p) => p.keyword === kw && p.source === 'web' && p.url && p.depth === 'read' && !p.sharedAt
    && isFreshSharePost(p)
    && (!p.topicTag || !cooledTopics.has(p.topicTag))
    && (!curationEnabled || !isLowQualityPooledPost(p)));
  if (readyToShare) {
    return {
      post: { title: readyToShare.title, url: readyToShare.url, summary: readyToShare.summary, reason: readyToShare.reason || '' },
      reused: true,
    };
  }

  // 按频道+当前进度派生更精确的搜索词（比如 hobby/follow 会带上 progress.stage 拼成
  // "xxx 第二年春 攻略"），而不是拿裸关键词去搜——裸词搜游戏/软件类大词很容易搜到
  // 首页、App Store 产品页这类没有实质内容的页面。
  const searchQuery = searchPlan.query;
  let webError = '';
  const result = await runGeneralSearch(searchQuery, webCfg, {
    skipDailyLimit: manual, characterId: cid, category: 'web_link_share_search',
    freshness: searchPlan.freshness || 'month',
  }).catch((err) => { webError = String(err?.message || err || ''); return null; });
  const results = asArray(result?.results).filter((r) => r?.url && !sharedUrls.has(clean(r.url, 300))
    && (!curationEnabled || !isLowQualityShareCandidate({ title: r.title, desc: r.content, url: r.url })));
  if (!results.length) {
    if (webError) return { post: null, reason: 'api-error', error: webError };
    return { post: null, reason: 'no-results', resultCount: 0 };
  }

  const contentPref = interestEntries.find((e) => e.keyword === kw)?.contentPref || 'safe';
  const recentChat = await collectRecentChatLines(uid, cid, characterName).catch(() => []);
  const picked = await pickWebLinkWorthSharing({
    keyword: kw, characterName, results, personaBrief, avoidTitles, contentPref, avoidNotes: trackSettings.avoidNotes, recentChat, recentSharedTopics, curationEnabled, timely: searchPlan.timely === true, signal,
  });
  if (!picked?.url) return { post: null, reason: results.length ? 'nothing-picked' : 'no-results', resultCount: results.length };

  const detectedSource = detectSocialSourceFromUrl(picked.url);
  await appendVerifiedPosts(uid, cid, [{
    keyword: kw, source: detectedSource, title: picked.title, summary: picked.desc, url: picked.url, depth: 'read', picked: true, reason: picked.reason || '', topicTag: picked.topicTag || '', foundAt: Date.now(),
  }]).catch(() => {});

  try {
    const phone = await loadCharacterPhone(uid, cid);
    const next = mergePhoneStructuredPatch(phone, {
      source: 'webLinkShareSearch',
      browserRecords: [{
        title: picked.title,
        query: kw,
        url: picked.url,
        sourceName: SOCIAL_CHANNEL_LABEL[detectedSource] || '网页',
        linkType: 'real',
        summary: picked.desc,
        aiJudgement: picked.reason,
        shareStatus: 'pending',
      }],
    });
    await saveCharacterPhone(next);
  } catch (err) {
    console.warn('[interest-search-orchestrator] write web link browser record failed', err);
  }

  return { post: { title: picked.title, url: picked.url, summary: picked.desc, reason: picked.reason }, reused: false };
}

/** 供聊天上下文注入：某角色最近沉淀的几条简报，让角色能主动提起/分享，而不是只等用户先问到关键词。 */
export async function listRecentBriefings(characterId, limit = 3) {
  const cid = String(characterId || '').trim();
  if (!cid) return [];
  const all = await listAllWorldBookRows().catch(() => []);
  return all
    .filter((e) => e?.system === 'miniwiki' && e.origin === 'ai_grown' && (e.characterIds || []).includes(cid))
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
    .slice(0, Math.max(0, limit));
}
