/**
 * 角色兴趣关键词表：搜索/知识基建的候选词池。
 *
 * 设计原则（对应搜索与知识基建 Plan 的 A 部分）：
 * - 搜索候选词只从这张表里出，AI 生成大 JSON 时不再临时现造搜索词——这是控制关键词质量与调用成本的关键。
 * - 表可以由 AI 按人设/记忆/最近聊天补充（source: 'ai'），用户也能手动增删改（source: 'user'），互不覆盖。
 * - depth 区分「light 顺手一搜」与「deep 值得认真查一轮再沉淀成知识卡」。
 */
import * as db from './db.js';
import { chat as chatCompletion, resolveGenerationMaxTokens } from './api.js';
import { appendDebugEvent, classifyErrorKind } from './debug-log.js';
import { getCharacterAiContextName } from '../models/character.js';
import { loadMemoryWorkspace, pickMemoriesForScope } from './memory/memory-scope.js';
import { findPrivateChat, listMessagesForChat } from './chat-store.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import { filterNonGuidanceMessages } from './guidance-memory.js';

const MAX_ACTIVE = 30;

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

function storeKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `characterInterestTable_${uid}_${cid}`;
}

function trackingSettingsKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `characterInterestTracking_${uid}_${cid}`;
}

export const SHARE_EAGERNESS_LEVELS = ['low', 'normal', 'high'];
/** 主动性档位 → 分享冲动概率的映射，供 share-impulse.js 读取。 */
export const SHARE_EAGERNESS_PROBABILITY = { low: 0.25, normal: 0.5, high: 0.8 };
// 之前写死成 5，对想让角色更爱分享的用户来说太低；放宽到 20，够用又能防止手滑输入离谱数字。
export const SHARE_DAILY_TARGET_MAX = 20;
export const AUTO_TRACK_INTERVAL_HOURS_DEFAULT = 12;
export const AUTO_TRACK_INTERVAL_HOURS_MIN = 4;
export const AUTO_TRACK_INTERVAL_HOURS_MAX = 72;
export const AUTO_TRACK_CANDIDATES_DEFAULT = 2;
export const AUTO_TRACK_CANDIDATES_MAX = 5;
export const SOCIAL_SEARCH_CHANNELS = ['xiaohongshu', 'weibo', 'bilibili'];
export const SOCIAL_SEARCH_CHANNEL_LABELS = {
  xiaohongshu: '小红书',
  weibo: '微博',
  bilibili: 'B站',
};

/** 分享真实帖子精搜可用渠道（含免费网页），兴趣页可多选并持久化。 */
export const SHARE_SEARCH_CHANNELS = ['web', 'xiaohongshu', 'weibo', 'bilibili'];
export const SHARE_SEARCH_CHANNEL_LABELS = {
  web: '通用网页',
  xiaohongshu: '小红书',
  weibo: '微博',
  bilibili: 'B站',
};

/** 后台社媒搜索渠道多选：空或未配置时默认全开，与旧行为一致。 */
export function normalizeSocialSearchChannels(raw) {
  const list = Array.isArray(raw)
    ? raw.map((c) => String(c || '').trim()).filter((c) => SOCIAL_SEARCH_CHANNELS.includes(c))
    : [];
  if (!list.length) return [...SOCIAL_SEARCH_CHANNELS];
  return [...new Set(list)];
}

/** 分享精搜渠道多选：空或未配置时默认全开（网页优先 + 社媒兜底），与旧行为一致。 */
export function normalizeShareSearchChannels(raw) {
  const list = Array.isArray(raw)
    ? raw.map((c) => String(c || '').trim()).filter((c) => SHARE_SEARCH_CHANNELS.includes(c))
    : [];
  if (!list.length) return [...SHARE_SEARCH_CHANNELS];
  return [...new Set(list)];
}

/**
 * 单角色开关：
 * - autoTrackEnabled：是否参与后台自动轮转（关掉这个词表还在，只是不会被后台自动搜）。默认关——
 *   每个角色都要用户自己主动打开才会被搜，不是填了词表就默认全搜。
 * - autoTrackIntervalHours：自动轮转的冷却间隔（多久搜一次），默认 12 小时，可按角色单独调。
 * - autoTrackCandidatesPerRound：自动轮转一轮搜几个候选词，默认 2，可按角色单独调。
 * - sharePostSearchEnabled：是否允许「分享真实帖子」精搜升级（小红书列表 → 精选 → 取正文，成本更高）。默认关。
 * - shareDailyTarget：这个角色每天最多攒/分享几条真实帖子，默认 1，范围 0-20（SHARE_DAILY_TARGET_MAX）。
 * - shareEagerness：主动分享的积极性档位，决定分享冲动命中概率，默认 normal。
 * - avoidNotes：用户自由填写的雷点/忌讳（如"不想看到 CP 同人""不想看到骂战"），传给精选/精搜的 LLM 当硬约束。
 * - includeHotComments：精搜是否连带拉取热评（多一次调用）。默认关。
 * - shareSearchChannels：分享真实帖子精搜可用渠道多选（网页/小红书/微博/B站）。
 *   AI 选词精搜与后台补货只从勾选渠道取链；空则默认全开。
 */
export async function loadInterestTrackingSettings(userId, characterId) {
  const row = await db.get('settings', trackingSettingsKey(userId, characterId)).catch(() => null);
  const value = row?.value || {};
  const target = Number(value.shareDailyTarget);
  const intervalHours = Number(value.autoTrackIntervalHours);
  const candidates = Number(value.autoTrackCandidatesPerRound);
  return {
    autoTrackEnabled: value.autoTrackEnabled === true,
    autoTrackIntervalHours: Number.isFinite(intervalHours)
      ? Math.min(AUTO_TRACK_INTERVAL_HOURS_MAX, Math.max(AUTO_TRACK_INTERVAL_HOURS_MIN, Math.round(intervalHours)))
      : AUTO_TRACK_INTERVAL_HOURS_DEFAULT,
    autoTrackCandidatesPerRound: Number.isFinite(candidates)
      ? Math.min(AUTO_TRACK_CANDIDATES_MAX, Math.max(1, Math.round(candidates)))
      : AUTO_TRACK_CANDIDATES_DEFAULT,
    sharePostSearchEnabled: value.sharePostSearchEnabled === true,
    shareDailyTarget: Number.isFinite(target) ? Math.min(SHARE_DAILY_TARGET_MAX, Math.max(0, Math.round(target))) : 1,
    shareEagerness: SHARE_EAGERNESS_LEVELS.includes(value.shareEagerness) ? value.shareEagerness : 'normal',
    avoidNotes: clean(value.avoidNotes, 200),
    includeHotComments: value.includeHotComments === true,
    socialSearchChannels: normalizeSocialSearchChannels(value.socialSearchChannels),
    shareSearchChannels: normalizeShareSearchChannels(value.shareSearchChannels),
    // 兴趣页顶部「一键开启推荐配置」引导卡：用户点过"先不用"就不再出现
    setupCardDismissed: value.setupCardDismissed === true,
  };
}

export async function saveInterestTrackingSettings(userId, characterId, patch = {}) {
  const current = await loadInterestTrackingSettings(userId, characterId);
  const next = { ...current, ...patch };
  await db.put('settings', { key: trackingSettingsKey(userId, characterId), value: next });
  return next;
}

function genId() {
  return `int_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function clean(value = '', max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fullText(value = '') {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

/** 短词相似度：字符级 2-gram 的 Dice 系数，中文没有天然分词，这个粒度对短搜索词够用。 */
function charBigrams(s) {
  const chars = Array.from(String(s || ''));
  if (chars.length < 2) return new Set(chars);
  const grams = new Set();
  for (let i = 0; i < chars.length - 1; i += 1) grams.add(chars[i] + chars[i + 1]);
  return grams;
}

function keywordSimilarity(a, b) {
  const ga = charBigrams(a);
  const gb = charBigrams(b);
  if (!ga.size || !gb.size) return a === b ? 1 : 0;
  let overlap = 0;
  for (const g of ga) if (gb.has(g)) overlap += 1;
  return (2 * overlap) / (ga.size + gb.size);
}

const KEYWORD_SIMILARITY_THRESHOLD = 0.6;

/**
 * 判断 candidate 是否跟 existingList 里的某个词高度重复/换皮——不只是完全相同才算重复：
 * 互相包含（比如已有"机械键盘"，candidate 是"键盘"或"键盘配列"）、字符层面高度重叠（比如
 * "无线鼠标"和"无线鼠标推荐"）都视为重复。避免 AI 补词/裂变每次给一堆换汤不换药的近义词。
 */
function isNearDuplicateKeyword(candidate, existingList) {
  const norm = String(candidate || '').toLowerCase().trim();
  if (!norm) return true;
  for (const ex of existingList) {
    const exNorm = String(ex || '').toLowerCase().trim();
    if (!exNorm) continue;
    if (exNorm === norm) return true;
    if (norm.length >= 2 && exNorm.length >= 2 && (exNorm.includes(norm) || norm.includes(exNorm))) return true;
    if (keywordSimilarity(norm, exNorm) >= KEYWORD_SIMILARITY_THRESHOLD) return true;
  }
  return false;
}

export const INTEREST_DEPTHS = ['light', 'deep'];
export const INTEREST_SURFACE_MODES = ['open', 'quiet'];
export const INTEREST_SURFACE_MODE_LABELS = { open: '会分享', quiet: '私下成长' };

/**
 * 兴趣频道：比 depth 更细的行为分类，决定轮转冷却、搜索目标和产出形态（见文档
 * docs/liveliness-refactor-plan.md 阶段 5）。旧数据没有 channel 时按 depth 迁移：
 * deep → hobby（深度爱好），light → casual（泛兴趣）。
 */
export const INTEREST_CHANNELS = ['staple', 'hobby', 'shopping', 'follow', 'casual'];
export const INTEREST_CHANNEL_LABELS = { staple: '日常', hobby: '爱好', shopping: '种草', follow: '在追', casual: '泛兴趣' };
const CHANNEL_COOLDOWN_MS = {
  staple: 7 * 86400000,
  hobby: 2 * 86400000,
  shopping: 1 * 86400000,
  follow: 1 * 86400000,
  casual: 5 * 86400000,
};
const CHANNEL_HAS_PROGRESS = new Set(['hobby', 'shopping', 'follow']);
export const INTEREST_CHANNELS_WITH_PROGRESS = [...CHANNEL_HAS_PROGRESS];

export function getChannelCooldownMs(channel) {
  return CHANNEL_COOLDOWN_MS[channel] || CHANNEL_COOLDOWN_MS.casual;
}

/** 频道基础冷却 × 体量系数，得到某个具体词条这次真正要等多久才能再被搜到。 */
export function getEntryCooldownMs(entry = {}) {
  const base = getChannelCooldownMs(entry?.channel);
  const mult = VOLUME_COOLDOWN_MULTIPLIER[normalizeVolume(entry?.volume)] ?? 1;
  // 连续两轮搜出来都是噪音的词降频（冷却翻倍）：大概率是词本身太偏/没内容，
  // 继续按原节奏搜只是烧额度产出 skip。
  const noisePenalty = (Number(entry?.noiseStreak) || 0) >= 2 ? 2 : 1;
  return Math.round(base * mult * noisePenalty);
}

/**
 * 体量档位：同一个 channel 底下，「明日方舟」这种内容总量巨大、天天有新东西的兴趣，
 * 和「一次性的某场展览」「奶茶」这种内容有限的兴趣，不该用同一套搜索/裂变频率——
 * 前者应该搜得更勤、裂变更快；后者搜太勤只会搜出重复内容。
 * large：内容持续扩张（长期运营的游戏/剧集/连载），搜索冷却打 5 折、裂变冷却缩到 2 天。
 * medium（默认）：维持现有节奏不变。
 * light：内容有限（一次性种草/短期活动/日常消费类），搜索冷却打 1.6 倍、几乎不裂变（10 天）。
 */
export const INTEREST_VOLUMES = ['large', 'medium', 'light'];
export const INTEREST_VOLUME_LABELS = { large: '内容多', medium: '适中', light: '内容少' };
const VOLUME_COOLDOWN_MULTIPLIER = { large: 0.5, medium: 1, light: 1.6 };
const VOLUME_SPLIT_COOLDOWN_MS = { large: 2 * 86400000, medium: 4 * 86400000, light: 10 * 86400000 };

function normalizeVolume(raw) {
  return INTEREST_VOLUMES.includes(raw) ? raw : 'medium';
}

export function getSplitCooldownMs(volume) {
  return VOLUME_SPLIT_COOLDOWN_MS[normalizeVolume(volume)] ?? VOLUME_SPLIT_COOLDOWN_MS.medium;
}

function normalizeChannel(raw, depth) {
  if (INTEREST_CHANNELS.includes(raw)) return raw;
  return depth === 'deep' ? 'hobby' : 'casual';
}

function normalizeProgress(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      stage: '',
      log: [],
      knownFacts: [],
      nextGoals: [],
      updatedAt: 0,
      lastAdvancedAt: 0,
      appliedRefs: [],
    };
  }
  const log = (Array.isArray(raw.log) ? raw.log : [])
    .map((l) => ({ at: Number(l?.at) || Date.now(), note: clean(l?.note, 80) }))
    .filter((l) => l.note)
    .slice(-12);
  const loggedAdvanceAt = log.reduce((latest, item) => (
    /^(?:阶段变化：|完成：)/.test(item.note) ? Math.max(latest, item.at) : latest
  ), 0);
  return {
    stage: clean(raw.stage, 40),
    log,
    knownFacts: (Array.isArray(raw.knownFacts) ? raw.knownFacts : [])
      .map((f) => clean(f, 60)).filter(Boolean).slice(0, 10),
    nextGoals: (Array.isArray(raw.nextGoals) ? raw.nextGoals : [])
      .map((g) => clean(g, 60)).filter(Boolean).slice(0, 4),
    updatedAt: Number(raw.updatedAt) || 0,
    // updatedAt 记录任何存档内容变化；lastAdvancedAt 只记录阶段/目标真的往前走。
    // 两者分开后，后台不断补充 knownFacts 不会把自然推进的五天冷却无限重置。
    lastAdvancedAt: Number(raw.lastAdvancedAt) || loggedAdvanceAt || 0,
    // 日程步骤是可重放的本地投影。保存已应用事件指纹，避免切页、回前台或多标签页重复记账。
    appliedRefs: [...new Set((Array.isArray(raw.appliedRefs) ? raw.appliedRefs : [])
      .map((ref) => clean(ref, 160))
      .filter(Boolean))]
      .slice(-32),
  };
}

/** 关键词基本校验：太短、太泛的词直接拒收，避免污染搜索预算。 */
export function isUsableInterestKeyword(keyword = '') {
  const k = clean(keyword, 60);
  if (k.length < 2 || k.length > 60) return false;
  const tooBroad = ['游戏', '电影', '音乐', '美食', '吃饭', '旅行', '旅游', '攻略', '动漫', '小说', '综艺', '电视剧', '新闻', '热搜', '视频', '直播'];
  if (tooBroad.includes(k)) return false;
  return true;
}

/**
 * 目标（nextGoal）可用性校验：goal 会被拼进真实搜索词，LLM 给的质量不稳定，
 * 太短、太泛、模板腔的一律拒收——校验不过就退回频道模板搜索，不让坏 goal 污染 query。
 */
const GENERIC_GOAL_RE = /^(继续|接着|保持|多|好好|认真|努力)?(玩|看|追|学|练|用|逛|刷|了解|研究|体验|探索)?(下去|一下|更多|看看)?$/;
export function isUsableProgressGoal(goal = '') {
  const g = clean(goal, 60);
  if (g.length < 4 || g.length > 60) return false;
  if (GENERIC_GOAL_RE.test(g)) return false;
  // 疑似 JSON/占位符/英文字段名残渣（LLM 输出没洗干净的常见形态）
  if (/[{}\[\]"<>]|^null$|^undefined$/i.test(g)) return false;
  return true;
}

export function normalizeInterestEntry(raw = {}) {
  const keyword = clean(raw.keyword, 60);
  if (!keyword) return null;
  const depth = INTEREST_DEPTHS.includes(raw.depth) ? raw.depth : 'light';
  const channel = normalizeChannel(raw.channel, depth);
  const source = ['user', 'ai', 'split'].includes(raw.source) ? raw.source : 'ai';
  const surfaceMode = INTEREST_SURFACE_MODES.includes(raw.surfaceMode)
    ? raw.surfaceMode
    : (source === 'ai' ? 'quiet' : 'open');
  return {
    id: String(raw.id || '').trim() || genId(),
    keyword,
    topic: clean(raw.topic, 80),
    // 背景故事：角色口吻的「为什么喜欢/什么时候喜欢上的」叙事层——兴趣不是孤立词条，
    // 是长在人设上的。用户可手填，也可以 AI 按人设/记忆补全（backstorySource 记录来源）。
    // 搜索简报、日程、分享文案都会带上它，让产出贴着"TA 和这个东西的关系"，而不是泛泛的百科态度。
    backstory: clean(raw.backstory, 300),
    backstorySource: ['user', 'ai'].includes(raw.backstorySource) ? raw.backstorySource : '',
    depth,
    channel,
    volume: normalizeVolume(raw.volume),
    progress: CHANNEL_HAS_PROGRESS.has(channel) ? normalizeProgress(raw.progress) : null,
    category: clean(raw.category, 30),
    source,
    // open：可进入主动简报与真实链接分享；quiet：仍会搜索、长进度、影响日程，
    // 但只在用户明确聊到时浮出，不会主动甩链接。
    surfaceMode,
    status: raw.status === 'archived' ? 'archived' : 'active',
    createdAt: Number(raw.createdAt) || Date.now(),
    lastUsedAt: Number(raw.lastUsedAt) || 0,
    // root：宽泛的兴趣大类（如「明日方舟」），本身太泛不好直接搜；
    // sub：由 root 裂变出的具体子话题（如「明日方舟 危机合约 XX季」），才是真正拿去搜索/沉淀简报的词。
    kind: raw.kind === 'sub' ? 'sub' : 'root',
    // sub 词再分两类：timely（活动/版本/热点，短命）与 thematic（玩法面/系统面/长期内容线，长命），
    // TTL 不同——之前一刀切 14 天，主题类子话题跟着活动一起被扔掉了。
    subKind: ['timely', 'thematic'].includes(raw.subKind) ? raw.subKind : 'timely',
    rootId: String(raw.rootId || '').trim(),
    lastSplitAt: Number(raw.lastSplitAt) || 0,
    // sub 词多半跟着一期活动/一个热点走，过期后自动退休，避免表里堆满过时话题
    expiresAt: Number(raw.expiresAt) || 0,
    // 搜索质量反馈（蒸馏时顺带评的）：thin/noise 会让下次搜索换角度、连续 noise 拉长冷却。
    lastResultQuality: ['good', 'thin', 'noise'].includes(raw.lastResultQuality) ? raw.lastResultQuality : '',
    noiseStreak: Math.max(0, Math.min(9, Number(raw.noiseStreak) || 0)),
    // 上次拼进搜索词的那个 goal：质量差时下次强制换一个角度，不原样重搜
    lastGoalUsed: clean(raw.lastGoalUsed, 60),
    // 'safe'（默认）：精选时避开拉踩对立/引战骂战/CP 同人配对倾向的内容；
    // 'open'：这个词用户明确表示不介意争议/骂战类内容，精选时放开这条限制。
    contentPref: raw.contentPref === 'open' ? 'open' : 'safe',
  };
}

export async function listInterestEntries(userId, characterId) {
  const row = await db.get('settings', storeKey(userId, characterId)).catch(() => null);
  const list = Array.isArray(row?.value) ? row.value : [];
  return list.map(normalizeInterestEntry).filter(Boolean);
}

async function persist(userId, characterId, entries) {
  await db.put('settings', { key: storeKey(userId, characterId), value: entries });
  return entries;
}

/** active 超上限时归档最旧的（按 createdAt），不物理删除。 */
function enforceActiveCap(entries) {
  const active = entries.filter((e) => e.status === 'active');
  if (active.length <= MAX_ACTIVE) return entries;
  const toArchive = new Set(
    active
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, active.length - MAX_ACTIVE)
      .map((e) => e.id),
  );
  return entries.map((e) => (toArchive.has(e.id) ? { ...e, status: 'archived' } : e));
}

export async function saveInterestEntry(userId, characterId, entry = {}) {
  const next = normalizeInterestEntry(entry);
  if (!next) throw new Error('关键词不能为空');
  const list = await listInterestEntries(userId, characterId);
  const merged = enforceActiveCap([next, ...list.filter((e) => e.id !== next.id)]);
  await persist(userId, characterId, merged);
  return next;
}

/**
 * 老词条一次性重新分类：旧数据在升级时只能按 depth 粗迁移（deep→hobby、light→casual），
 * 猜不出 staple/shopping/follow，导致升级前建好的词表看起来跟改造前几乎没区别。
 * 这里对现有 active 词条整批重新判断 channel，一次 LLM 调用、一次读写。
 */
export async function reclassifyInterestChannels({ userId, characterId, character, signal = null } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!uid || !cid) throw new Error('缺少用户或角色');
  const charName = getCharacterAiContextName(character) || character?.name || 'TA';
  const list = await listInterestEntries(uid, cid);
  const active = list.filter((e) => e.status === 'active');
  if (!active.length) return { updated: 0 };

  const payload = {
    task: 'reclassify_interest_channels',
    character: {
      name: charName,
      personality: fullText(character?.personality),
      speechStyle: fullText(character?.speechStyle),
      speechCorpus: fullText(character?.speechCorpus),
      promptCorpus: fullText(character?.promptCorpus),
      currentRole: fullText(character?.currentRole),
      currentStatus: fullText(character?.currentStatus),
      userRelationStatus: fullText(character?.userRelationStatus),
      gender: fullText(character?.gender),
    },
    entries: active.map((e) => ({ id: e.id, keyword: e.keyword, topic: e.topic, currentChannel: e.channel })),
    rules: [
      `逐条给出这些兴趣词条最合适的频道，从五类里选：staple（能反复消费的日常吃喝/生活品类，如奶茶、健身房）/ hobby（需要长期投入的深度爱好，如某款游戏、观鸟、手工）/ shopping（正在种草或研究的一次性购物目标，如换键盘、换手机）/ follow（正在追的剧/番/比赛/连载）/ casual（其它没有明显归类的泛兴趣）。`,
      'currentChannel 是旧数据自动迁移时按 light/deep 粗猜的，未必准，请只按关键词和 topic 本身重新判断。',
      '只输出 JSON 数组，每项 {"id":"原样带回对应词条的 id","channel":"五选一"}；覆盖 entries 里的每一条，不要遗漏，也不要新增不存在的 id。',
    ],
    schema: [{ id: '原样带回的 id', channel: 'staple|hobby|shopping|follow|casual' }],
  };
  const maxTokens = await resolveGenerationMaxTokens();
  const raw = await optionalInterestChat([
    { role: 'system', content: JSON.stringify(payload, null, 2) },
    { role: 'user', content: '请按上述角色与词条资料重新判断每条的兴趣频道，只输出规定 JSON。' },
  ], { temperature: 0.2, maxTokens, signal }, 'interest-table-refine');
  const parsed = extractJsonArray(raw) || [];
  const patchMap = new Map();
  for (const item of parsed) {
    const id = String(item?.id || '').trim();
    if (!id) continue;
    if (!INTEREST_CHANNELS.includes(item?.channel)) continue;
    patchMap.set(id, item.channel);
  }
  if (!patchMap.size) return { updated: 0 };
  let updated = 0;
  const nextList = list.map((e) => {
    const nextChannel = patchMap.get(e.id);
    if (!nextChannel || nextChannel === e.channel) return e;
    updated += 1;
    return normalizeInterestEntry({ ...e, channel: nextChannel });
  });
  if (updated) await persist(uid, cid, nextList);
  return { updated };
}

/**
 * AI 补全兴趣背景故事：以角色第一人称口吻，结合人设、记忆、最近聊天，给一批兴趣词各写一段
 * 「为什么喜欢/什么时候喜欢上的」。只补 backstory 为空的词条，不覆盖用户手填的内容。
 * entryIds 传空则补全所有缺背景的 active root 词条（sub 子话题跟着母词走，不单独写背景）。
 */
export async function growInterestBackstories({
  userId, characterId, character, user = null, entryIds = [], signal = null,
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!uid || !cid || !character) throw new Error('缺少用户或角色');
  const charName = getCharacterAiContextName(character) || character?.name || 'TA';
  const list = await listInterestEntries(uid, cid);
  const wanted = new Set((Array.isArray(entryIds) ? entryIds : []).map((x) => String(x || '').trim()).filter(Boolean));
  const targets = list.filter((e) => (
    e.status === 'active'
    && e.kind === 'root'
    && !e.backstory
    && (wanted.size ? wanted.has(e.id) : true)
  )).slice(0, 10);
  if (!targets.length) return [];

  const [recentChat, memory] = await Promise.all([
    collectRecentChatLines(uid, cid, charName),
    (async () => {
      try {
        const ws = await loadMemoryWorkspace(uid);
        const picked = pickMemoriesForScope(ws, cid);
        return [
          ...(picked.characterTraits || []).slice(0, 8).map((f) => clean(f.content, 100)),
          ...(picked.summaries || []).slice(0, 5).map((m) => clean(m.content, 110)),
        ].filter(Boolean);
      } catch (_) {
        return [];
      }
    })(),
  ]);

  const payload = {
    task: 'write_interest_backstories_in_character_voice',
    character: {
      name: charName,
      personality: fullText(character.personality),
      speechStyle: fullText(character.speechStyle),
      speechCorpus: fullText(character.speechCorpus),
      promptCorpus: fullText(character.promptCorpus),
      currentRole: fullText(character.currentRole),
      currentStatus: fullText(character.currentStatus),
      userRelationStatus: fullText(character.userRelationStatus),
      gender: fullText(character.gender),
    },
    memory,
    recentChat,
    entries: targets.map((e) => ({ id: e.id, keyword: e.keyword, topic: e.topic, channel: e.channel })),
    rules: [
      `给角色「${charName}」的每个兴趣词条写一段"背景故事"：TA 为什么喜欢这个？什么时候、因为什么契机喜欢上的？现在和它是什么关系（刚入坑/老粉/又爱又恨）？`,
      '用 TA 自己的第一人称口吻写，2~3 句话、≤120 字，像 TA 随口跟朋友解释"我怎么入坑的"，不是百科介绍。',
      '背景必须长在人设和记忆上：结合 TA 的职业、经历、性格、记忆里提过的事去编织合理的起源，前后不能和已知设定矛盾；记忆和聊天里如果真的提到过相关内容，优先用真实提到的。',
      '每条背景要彼此不同——不要都是"朋友安利的"这一种模板起源。',
      '每条再给 "depth" 字段，按背景本身判断 TA 对它的投入深浅：deep（老粉/认真研究/会主动深挖的核心爱好）或 light（顺口喜欢、浅尝辄止）。深浅要和背景故事自洽，deep 别超过一半。',
      '只输出 JSON 数组，每项 {"id":"原样带回","backstory":"背景故事","depth":"light|deep"}；写不出合理背景的词条可以跳过不输出。',
    ],
    schema: [{ id: '原样带回的 id', backstory: 'TA 第一人称口吻的入坑故事（≤120字）', depth: 'light|deep' }],
  };
  const maxTokens = await resolveGenerationMaxTokens();
  const raw = await optionalInterestChat([
    { role: 'system', content: JSON.stringify(payload, null, 2) },
    { role: 'user', content: '请按上述完整角色、记忆与兴趣资料扩写背景故事 JSON。' },
  ], { temperature: 0.8, maxTokens, signal }, 'interest-table-expand');
  const parsed = extractJsonArray(raw) || [];
  const patchMap = new Map();
  for (const item of parsed) {
    const id = String(item?.id || '').trim();
    const backstory = clean(item?.backstory, 300);
    const depth = item?.depth === 'deep' ? 'deep' : (item?.depth === 'light' ? 'light' : '');
    if (id && backstory && targets.some((t) => t.id === id)) patchMap.set(id, { backstory, depth });
  }
  if (!patchMap.size) return [];
  const updated = [];
  const nextList = list.map((e) => {
    const patch = patchMap.get(e.id);
    if (!patch || e.backstory) return e;
    // 背景决定深浅：AI 按入坑故事判定投入度，省得用户再手动拨一遍深/浅档
    const next = {
      ...e, backstory: patch.backstory, backstorySource: 'ai', depth: patch.depth || e.depth,
    };
    updated.push(next);
    return next;
  });
  if (updated.length) await persist(uid, cid, nextList);
  return updated;
}

/**
 * 用户手填/改写背景故事（backstorySource: 'user'，AI 之后不会覆盖）。传空字符串等于清掉背景。
 * 深浅由背景决定：手填后顺手让 AI 按背景判一次投入深浅（判不了就保持原档），
 * 用户不用再单独管理"深/浅"这个档位。
 */
export async function saveInterestBackstory(userId, characterId, entryId, backstory = '') {
  const id = String(entryId || '').trim();
  if (!id) return null;
  const list = await listInterestEntries(userId, characterId);
  const text = clean(backstory, 300);
  let depth = '';
  if (text) {
    const target = list.find((e) => e.id === id);
    if (target && text !== target.backstory) {
      depth = await judgeDepthFromBackstory(target.keyword, text).catch(() => '');
    }
  }
  let updated = null;
  const next = list.map((e) => {
    if (e.id !== id) return e;
    updated = {
      ...e,
      backstory: text,
      backstorySource: text ? 'user' : '',
      depth: depth || e.depth,
    };
    return updated;
  });
  if (updated) await persist(userId, characterId, next);
  return updated;
}

async function judgeDepthFromBackstory(keyword, backstory) {
  const raw = await optionalInterestChat([
    {
      role: 'user',
      content: `根据这段"TA 和某个兴趣的关系"判断投入深浅。兴趣词：「${keyword}」。背景：「${backstory}」。老粉/认真研究/会主动深挖=deep，顺口喜欢/浅尝辄止=light。只输出 deep 或 light 一个词。`,
    },
  ], { temperature: 0 }, 'interest-depth-classify');
  const answer = String(raw || '').toLowerCase();
  if (answer.includes('deep')) return 'deep';
  if (answer.includes('light')) return 'light';
  return '';
}

export async function deleteInterestEntry(userId, characterId, entryId) {
  const id = String(entryId || '').trim();
  const list = await listInterestEntries(userId, characterId);
  const next = list.filter((e) => e.id !== id);
  await persist(userId, characterId, next);
  return next;
}

/**
 * 简报沉淀时顺带写回的爱好存档补丁：自动 stage 更新会拦截明显倒退、newFacts 并入
 * knownFacts（去重）、newGoal 并入 nextGoals（过 isUsableProgressGoal 校验，LLM 给的烂 goal 拒收）、
 * completedGoal 从 nextGoals 挪进 log（目标完成闭环）、humanMoment 追加进 log。
 * 只对带 progress 的频道（hobby/shopping/follow）生效。
 */
const BEGINNER_STAGE_RE = /(?:新手|入门|刚开始|刚入坑|初学|开局|起步|第一章|第[一1]阶段)/i;
const STAGE_LOG_PREFIX = '阶段变化：';

function resolveProgressStage(progress, patch) {
  const current = clean(progress.stage, 40);
  const proposed = clean(patch.stage, 40);
  if (!proposed || proposed === current) return current || proposed;
  if (patch.allowStageReset === true || !current) return proposed;

  const previousStages = new Set();
  for (const item of progress.log || []) {
    const note = clean(item?.note, 80);
    if (!note.startsWith(STAGE_LOG_PREFIX)) continue;
    const transition = note.slice(STAGE_LOG_PREFIX.length).split('→').map((part) => clean(part, 40));
    transition.forEach((stage) => { if (stage) previousStages.add(stage); });
  }
  if (previousStages.has(proposed)) return current;
  if (!BEGINNER_STAGE_RE.test(current) && BEGINNER_STAGE_RE.test(proposed)) return current;
  return proposed;
}

export async function applyInterestProgressPatch(userId, characterId, entryId, patch = {}) {
  const id = String(entryId || '').trim();
  if (!id) return null;
  const list = await listInterestEntries(userId, characterId);
  let updatedEntry = null;
  let changed = false;
  const next = list.map((e) => {
    if (e.id !== id || !e.progress) return e;
    const progress = e.progress;
    const sourceRef = clean(patch.sourceRef, 160);
    if (sourceRef && progress.appliedRefs.includes(sourceRef)) {
      updatedEntry = e;
      return e;
    }
    const stage = resolveProgressStage(progress, patch);
    const newFacts = (Array.isArray(patch.newFacts) ? patch.newFacts : []).map((f) => clean(f, 60)).filter(Boolean);
    const knownFacts = [...new Set([...progress.knownFacts, ...newFacts])].slice(-10);
    // 完成的目标从待办里划掉、记进 log——目标"提出→查证/做到→划掉→换新目标"才是活的进度
    const completedGoal = clean(patch.completedGoal, 60);
    let nextGoals = completedGoal
      ? progress.nextGoals.filter((g) => g !== completedGoal)
      : [...progress.nextGoals];
    const newGoal = clean(patch.newGoal, 60);
    if (newGoal && isUsableProgressGoal(newGoal)) {
      nextGoals = [...new Set([...nextGoals, newGoal])].slice(-4);
    }
    const humanMoment = clean(patch.humanMoment, 80);
    let log = progress.log;
    const stageChanged = stage !== progress.stage;
    const completedGoalApplied = !!(completedGoal && progress.nextGoals.includes(completedGoal));
    const newGoalAdded = !!(newGoal && isUsableProgressGoal(newGoal) && !progress.nextGoals.includes(newGoal));
    const humanMomentAdded = !!(humanMoment && !log.some((item) => clean(item?.note, 80) === humanMoment));
    const factsChanged = knownFacts.length !== progress.knownFacts.length
      || knownFacts.some((fact, index) => fact !== progress.knownFacts[index]);
    if (stage && progress.stage && stageChanged) {
      log = [...log, { at: Date.now(), note: clean(`${STAGE_LOG_PREFIX}${progress.stage}→${stage}`, 80) }];
    }
    if (completedGoalApplied) {
      log = [...log, { at: Date.now(), note: clean(`完成：${completedGoal}`, 80) }];
    }
    if (humanMomentAdded) {
      log = [...log, { at: Date.now(), note: humanMoment }];
    }
    log = log.slice(-12);
    const contentChanged = stageChanged
      || completedGoalApplied
      || newGoalAdded
      || humanMomentAdded
      || factsChanged;
    const appliedRefs = sourceRef
      ? [...new Set([...progress.appliedRefs, sourceRef])].slice(-32)
      : progress.appliedRefs;
    const refsChanged = appliedRefs.length !== progress.appliedRefs.length;
    if (!contentChanged && !refsChanged) {
      updatedEntry = e;
      return e;
    }
    const now = Date.now();
    const advanced = stageChanged || completedGoalApplied || newGoalAdded || humanMomentAdded;
    updatedEntry = {
      ...e,
      progress: {
        stage,
        log,
        knownFacts,
        nextGoals,
        updatedAt: contentChanged ? now : progress.updatedAt,
        lastAdvancedAt: advanced ? now : progress.lastAdvancedAt,
        appliedRefs,
      },
    };
    changed = true;
    return updatedEntry;
  });
  if (updatedEntry && changed) await persist(userId, characterId, next);
  return updatedEntry;
}

/**
 * 记录一次搜索的质量反馈：good 清零 noiseStreak，thin/noise 累加；lastGoalUsed 记下这次
 * 拼进 query 的角度，质量差时下次派生搜索计划会强制换角度（换 goal / 退回模板）。
 */
export async function markInterestSearchQuality(userId, characterId, entryId, quality = '', goalUsed = '') {
  const id = String(entryId || '').trim();
  const q = ['good', 'thin', 'noise'].includes(quality) ? quality : '';
  if (!id || !q) return;
  const list = await listInterestEntries(userId, characterId);
  const next = list.map((e) => {
    if (e.id !== id) return e;
    return {
      ...e,
      lastResultQuality: q,
      noiseStreak: q === 'good' ? 0 : Math.min(9, (Number(e.noiseStreak) || 0) + 1),
      lastGoalUsed: clean(goalUsed, 60),
    };
  });
  await persist(userId, characterId, next);
}

export async function markInterestUsed(userId, characterId, entryIds = []) {
  const ids = new Set((Array.isArray(entryIds) ? entryIds : []).map((x) => String(x || '').trim()).filter(Boolean));
  if (!ids.size) return;
  const list = await listInterestEntries(userId, characterId);
  const now = Date.now();
  await persist(userId, characterId, list.map((e) => (ids.has(e.id) ? { ...e, lastUsedAt: now } : e)));
}

const SUB_ENTRY_TTL_MS = 14 * 86400000; // 时效类子话题追踪 2 周，过期自动退休（活动/热点通常也就这个周期）
const SUB_ENTRY_THEMATIC_TTL_MS = 60 * 86400000; // 主题类子话题（玩法面/系统面/长期内容线）能撑更久，2 个月再退休复查

/**
 * 挑一个「该裂变了」的 root 深度兴趣词：active、depth=deep、最久没裂变过的排前面；
 * 都没裂变过（lastSplitAt 都是 0）时按创建时间早的优先，避免最近添加的词一直抢在老词前面。
 * 裂变冷却按 volume 档位缩放：large（明日方舟类）2 天就能再裂一次，light（内容有限的兴趣）
 * 拉长到 10 天，避免对着一个没多少新内容的话题反复裂变出雷同的子话题。
 */
export function pickRootForSplit(entries = []) {
  const now = Date.now();
  const candidates = (Array.isArray(entries) ? entries : [])
    .filter((e) => e.status === 'active' && e.kind === 'root' && e.depth === 'deep' && isUsableInterestKeyword(e.keyword))
    .filter((e) => now - (e.lastSplitAt || 0) >= getSplitCooldownMs(e.volume))
    .sort((a, b) => (a.lastSplitAt || 0) - (b.lastSplitAt || 0) || a.createdAt - b.createdAt);
  return candidates[0] || null;
}

export async function markInterestSplit(userId, characterId, rootId) {
  const id = String(rootId || '').trim();
  if (!id) return;
  const list = await listInterestEntries(userId, characterId);
  await persist(userId, characterId, list.map((e) => (e.id === id ? { ...e, lastSplitAt: Date.now() } : e)));
}

/**
 * 把裂变出的具体子话题词写回兴趣表：跳过与现有关键词重复的，超上限时归档最旧的。
 * timely（活动/热点）短 TTL，thematic（玩法面/长期内容线）长 TTL；裂变 LLM 没给 kind 或
 * 给了非法值时按 timely 兜底（宁可早退休，不让存疑的词长期占坑）。
 * @param subs Array<{ keyword, topic, kind? }>
 */
export async function saveSplitSubEntries(userId, characterId, rootEntry, subs = []) {
  if (!rootEntry?.id || !Array.isArray(subs) || !subs.length) return [];
  const existing = await listInterestEntries(userId, characterId);
  // 子话题按规则必须包含 root 自己的词，不能拿 root 本身去做「互相包含」判重，
  // 不然每个合规的子话题都会被误判成跟 root 重复；只跟其它兄弟子话题/别的词去重。
  const seenList = existing.filter((e) => e.id !== rootEntry.id).map((e) => e.keyword);
  const now = Date.now();
  const added = [];
  for (const item of subs.slice(0, 6)) {
    const subKind = item?.kind === 'thematic' ? 'thematic' : 'timely';
    const entry = normalizeInterestEntry({
      keyword: item?.keyword,
      topic: item?.topic,
      depth: 'deep',
      category: rootEntry.category,
      source: 'split',
      status: 'active',
      kind: 'sub',
      subKind,
      rootId: rootEntry.id,
      volume: rootEntry.volume,
      surfaceMode: rootEntry.surfaceMode,
      expiresAt: now + (subKind === 'thematic' ? SUB_ENTRY_THEMATIC_TTL_MS : SUB_ENTRY_TTL_MS),
    });
    if (!entry || !isUsableInterestKeyword(entry.keyword)) continue;
    if (isNearDuplicateKeyword(entry.keyword, seenList)) continue;
    seenList.push(entry.keyword);
    added.push(entry);
  }
  if (added.length) {
    const merged = enforceActiveCap([...added, ...existing]);
    await persist(userId, characterId, merged);
  }
  return added;
}

/** 过期子话题自动归档（保留记录，不占用 active 上限和搜索预算）。 */
export async function archiveExpiredInterestEntries(userId, characterId) {
  const list = await listInterestEntries(userId, characterId);
  const now = Date.now();
  const toArchive = list.filter((e) => e.status === 'active' && e.kind === 'sub' && e.expiresAt && e.expiresAt < now);
  if (!toArchive.length) return 0;
  const ids = new Set(toArchive.map((e) => e.id));
  await persist(userId, characterId, list.map((e) => (ids.has(e.id) ? { ...e, status: 'archived' } : e)));
  return toArchive.length;
}

/**
 * 按预算挑搜索候选：优先 deep 档且最久没用过的，其次 light；只出 active 条目。
 * 已经裂变出具体子话题的大类词（kind=root && depth=deep 且有存活的 sub）不再把它自己也当候选——
 * 子话题已经覆盖它，直接搜大词只会加噪音；还没成功裂变过的大类词继续保留作为候选，避免裂变搜不出
 * 子话题（太小众/裂变功能未配置）时这个词彻底沦为死词、永远不会被搜到。
 */
export function pickInterestCandidates(entries = [], { limit = 2 } = {}) {
  const now = Date.now();
  const active = (Array.isArray(entries) ? entries : []).filter((e) => e.status === 'active' && isUsableInterestKeyword(e.keyword));
  const hasLiveSub = (rootId) => active.some((e) => e.kind === 'sub' && e.rootId === rootId);
  const searchable = active.filter((e) => !(e.kind === 'root' && e.depth === 'deep' && hasLiveSub(e.id)));
  // 频道冷却 × 体量系数过滤：staple 7天/hobby 2天/shopping·follow 1天/casual 5天是基础值，
  // large 打 5 折搜得更勤，light 拉长到 1.6 倍避免对内容有限的话题搜出重复。
  const eligible = searchable.filter((e) => now - (e.lastUsedAt || 0) >= getEntryCooldownMs(e));
  const byStaleness = (a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0) || a.createdAt - b.createdAt;
  // 按频道分桶再轮询取词：保证一轮候选尽量来自不同频道，不被同一个频道的词挤占预算
  const byChannel = new Map();
  for (const e of [...eligible].sort(byStaleness)) {
    const arr = byChannel.get(e.channel) || [];
    arr.push(e);
    byChannel.set(e.channel, arr);
  }
  const channelOrder = [...byChannel.keys()].sort((a, b) => (
    (byChannel.get(a)[0]?.lastUsedAt || 0) - (byChannel.get(b)[0]?.lastUsedAt || 0)
  ));
  const picked = [];
  const pickedRoots = new Set();
  let round = 0;
  while (picked.length < limit && channelOrder.some((c) => (byChannel.get(c) || []).length > round)) {
    for (const c of channelOrder) {
      if (picked.length >= limit) break;
      const arr = byChannel.get(c) || [];
      const candidate = arr[round];
      if (!candidate) continue;
      // 同一母兴趣裂变出的多个子话题每轮最多占一个预算，避免一个 root 垄断整轮搜索。
      const rootKey = candidate.kind === 'sub'
        ? String(candidate.rootId || candidate.id || '').trim()
        : String(candidate.id || '').trim();
      if (rootKey && pickedRoots.has(rootKey)) continue;
      picked.push(candidate);
      if (rootKey) pickedRoots.add(rootKey);
    }
    round += 1;
  }
  return picked.slice(0, Math.max(0, limit));
}

/** 私聊最近的文本片段，供 AI 补词/精选类工具调用参考"最近聊到了什么"。 */
export async function collectRecentChatLines(userId, characterId, charName) {
  try {
    const priv = await findPrivateChat(userId, characterId);
    if (!priv?.id) return [];
    const messages = filterNonGuidanceMessages(await listMessagesForChat(priv.id, 40).catch(() => []));
    return (messages || [])
      .filter((m) => m && !m.deleted && !m.recalled && (m.type === 'text' || !m.type))
      .map((m) => {
        const speaker = String(m.senderId || '') === String(characterId) ? charName : '用户';
        const text = clean(m.content, 100);
        return text ? `${speaker}：${text}` : '';
      })
      .filter(Boolean)
      .slice(-30);
  } catch (_) {
    return [];
  }
}

export function extractJsonArray(raw) {
  const text = String(raw || '').trim();
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * AI 填表：读取人设、世界书 selective 块、最近聊天、记忆摘要，补充若干候选关键词（source: 'ai'）。
 * 不覆盖用户手动条目；与现有条目关键词重复的跳过。
 */
export async function growInterestTableFromContext({ userId, characterId, character, user = null, signal = null } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!uid || !cid || !character) throw new Error('缺少用户或角色');
  const charName = getCharacterAiContextName(character) || character?.name || 'TA';

  const [recentChat, memory] = await Promise.all([
    collectRecentChatLines(uid, cid, charName),
    (async () => {
      try {
        const ws = await loadMemoryWorkspace(uid);
        const picked = pickMemoriesForScope(ws, cid);
        return [
          ...(picked.characterTraits || []).slice(0, 8).map((f) => clean(f.content, 100)),
          ...(picked.summaries || []).slice(0, 5).map((m) => clean(m.content, 110)),
        ].filter(Boolean);
      } catch (_) {
        return [];
      }
    })(),
  ]);
  const selectiveBlob = [charName, character.personality, character.speechCorpus, character.promptCorpus, recentChat.join(' ')].filter(Boolean).join(' ');
  const worldBook = await buildWorldBookContextBlock(user, selectiveBlob, {
    worldBookMode: 'selective',
    characterIds: [cid],
  }).catch(() => '');

  const existing = await listInterestEntries(uid, cid);
  const existingKeywords = existing.map((e) => e.keyword);

  const payload = {
    task: 'grow_character_interest_table',
    character: {
      name: charName,
      personality: fullText(character.personality),
      speechStyle: fullText(character.speechStyle),
      speechCorpus: fullText(character.speechCorpus),
      promptCorpus: fullText(character.promptCorpus),
      currentRole: fullText(character.currentRole),
      currentStatus: fullText(character.currentStatus),
      userRelationStatus: fullText(character.userRelationStatus),
      gender: fullText(character.gender),
    },
    worldBook: clean(worldBook, 1500),
    recentChat,
    memory,
    existingKeywords,
    rules: [
      `为角色「${charName}」的"兴趣关键词表"补充 3~8 条新的候选搜索词。这张表之后会用来做真实网络检索，替角色查证 TA 感兴趣的东西。`,
      'keyword 必须是可以直接拿去搜索引擎搜的具体词：具体作品名、品名、地点、事件、圈层黑话、型号、菜名、店铺类型；禁止"游戏/音乐/美食/旅行"这类大词。',
      'topic 用一句人话描述这个词对 TA 的意义（如"最近在追的悬疑剧"、"想入手的相机型号"）。',
      'depth 取 light（顺手了解即可）或 deep（TA 真的会认真研究、值得深挖一轮的核心兴趣）；deep 最多 2 条。',
      '每个关键词额外给 "channel" 字段，从这五类里选：staple（奶茶咖啡餐馆等日常生活品类）/ hobby（需要长期投入的深度爱好，如某款游戏、观鸟、手工）/ shopping（正在种草或研究的购物目标）/ follow（正在追的剧/番/比赛/连载）/ casual（其它泛兴趣）。判断依据是这个词对 TA 的意义，不是词本身的类型。',
      '再给一个 "volume" 字段，判断这个具体事物本身「持续产出新内容的量」：large（长期运营、天天有新东西，比如正在运营的游戏/连载中的剧集/职业联赛）/ medium（内容适中，多数兴趣默认这档）/ light（内容有限，比如某场已结束的展览、一次性种草的单品、普通日常小吃）。这决定搜索频率，不是"TA 有多喜欢"。',
      'category 是简短分类词（如 影视/游戏/生活/学习）。',
      '再给一个 "backstory" 字段：用 TA 自己的第一人称口吻写 2~3 句（≤120字）"我怎么喜欢上这个的"——什么时候、因为什么契机入坑、现在和它什么关系。必须长在人设和记忆上（结合职业/经历/性格编织合理起源，记忆里真提到过的优先用），每条起源要彼此不同，不要都是"朋友安利"模板。',
      '这些由 AI 自然补出的兴趣默认是 TA 私下默默发展的，不代表 TA 会主动向用户分享；不要输出分享开关字段，系统会按私下成长保存。',
      '不要与 existingKeywords 里已有的词重复、换皮重复，也不要只是换了个限定词但核心事物还是同一个（比如已经有"机械键盘"，就不要再给"键盘轴体""键盘配列"这类差异很小、搜出来的东西基本重叠的词，除非确实是完全独立的细分主题）；没有把握的宁可少给。',
      '只输出 JSON 数组，不要解释。',
    ],
    schema: [{ keyword: '具体搜索词', topic: '对 TA 的意义', depth: 'light|deep', channel: 'staple|hobby|shopping|follow|casual', volume: 'large|medium|light', category: '分类', backstory: 'TA 第一人称的入坑故事（≤120字）' }],
  };
  const maxTokens = await resolveGenerationMaxTokens();
  const raw = await chatCompletion([
    { role: 'system', content: JSON.stringify(payload, null, 2) },
    { role: 'user', content: '请按上述完整角色、记忆与已有兴趣生成不重复的新兴趣 JSON。' },
  ], { temperature: 0.7, maxTokens, signal });
  const parsed = extractJsonArray(raw) || [];
  const seenList = existingKeywords.slice();
  const added = [];
  for (const item of parsed.slice(0, 10)) {
    const entry = normalizeInterestEntry({
      ...item, source: 'ai', surfaceMode: 'quiet', status: 'active', backstorySource: item?.backstory ? 'ai' : '',
    });
    if (!entry || !isUsableInterestKeyword(entry.keyword)) continue;
    if (isNearDuplicateKeyword(entry.keyword, seenList)) continue;
    seenList.push(entry.keyword);
    added.push(entry);
  }
  if (added.length) {
    const merged = enforceActiveCap([...added, ...existing]);
    await persist(uid, cid, merged);
  }
  return added;
}
