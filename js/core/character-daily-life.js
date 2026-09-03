/**
 * 角色生活骨架生成 · 第一刀
 *
 * - dailyLifePlan / weeklyLifePlan 通过 AI 严格 JSON 写入
 * - 备忘录等附属内容只从 JSON 字段 merge，不用正则从正文抠
 * - 独立任务开关，不挂普通聊天 pipeline
 * - 去 IP / 赛季锚点；地点先用 character.residenceAnchor + lifeProfile
 */

import {
  chat as chatCompletion,
  chatForTask,
  resolveGenerationMaxTokens,
  resolveChatPreferStream,
  getStreamPartialText,
} from './api.js';
import * as db from './db.js';
import { buildTimeAndHolidayPromptBlock, getNowForUser } from './time-mode.js';
import {
  getCharacterAiContextName,
  normalizeTranslationProfile,
} from '../models/character.js';
import { getUserDisplayName } from '../models/user.js';
import {
  fetchWeatherForCity,
  formatWeatherLifeIndex,
  getEffectiveWeatherCityForCharacter,
} from './weather-location.js';
import { maybeGrowCharacterPhoneMapForDailyPlan } from './character-phone-map-grower.js';
import { listInterestEntries } from './character-interest-table.js';
import { loadTastePool } from './character-taste-pool.js';
import { listTravelCharTrips, getActiveExtendedTripForDate, buildTripDayPlanOverride } from './travel-char.js';
import { normalizeLocationProfile, getBaseLocationAnchor, describeLocationAnchor } from './location-profile.js';
import { filterNonGuidanceMessages, isGuidanceMessage } from './guidance-memory.js';
import {
  loadCharacterPhone,
  saveCharacterPhone,
  mergePhoneStructuredPatch,
  getDailyLifePlanForDate,
  pruneExpiredDailyLifePlans,
  normalizeDailyLifeBlock,
  normalizeDailyLifePlan,
  parseTimeRangeEndMinutes,
  parseTimeRangeStartMinutes,
  pickCurrentPlanBlock,
  dateKeyFromTimestamp,
  upsertDailyLifePlan,
  applyMapPinVisitTracking,
  applyElapsedScheduleMapVisits,
  enrichDailyLifePlanWithMapCandidates,
} from './character-phone-store.js';
import {
  formatClockInTimezone,
  resolveCharacterScheduleTimezone,
} from './chat/chat-timezone.js';
import { loadWebSearchConfig, runWebSearch } from './web-search-tools.js';
import { loadGeneralNewsDigest, loadPrivateNewsDigest } from './character-news-digest.js';
import {
  messageLikelyNeedsTranslation,
  needsTranslationRepair,
  repairTranslationEntries,
  translationRepairFailureMessage,
  translationProfileBrief,
} from './translation-utils.js';

const SCHEDULE_EVENT_SETTINGS_KEY_PREFIX = 'characterScheduleEventSettings';
export const EVENT_SEARCH_DAILY_LIMIT_MAX = 5;
export const EVENT_SEARCH_DAILY_LIMIT_DEFAULT = 2;
/** 日程正文默认简体中文（省 tokens，不附带双语） */
export const SCHEDULE_LANGUAGE_CHINESE = 'chinese';
/** 按角色卡 translationProfile 写正文；生成时同批带译文，缺失时仍可手动补译 */
export const SCHEDULE_LANGUAGE_FOLLOW_CHARACTER = 'followCharacter';

export function normalizeScheduleLanguageMode(value) {
  return value === SCHEDULE_LANGUAGE_FOLLOW_CHARACTER
    ? SCHEDULE_LANGUAGE_FOLLOW_CHARACTER
    : SCHEDULE_LANGUAGE_CHINESE;
}

function scheduleEventSettingsKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `${SCHEDULE_EVENT_SETTINGS_KEY_PREFIX}_${uid}_${cid}`;
}

/**
 * 单角色开关（日程主轴调整 Phase 2）：
 * - eventNewsEnabled：默认关。开启后日程生成会先读通用热点 + 这个角色的私人资讯缓存，
 *   围绕人设从里面挑事件当今天的主线，兴趣/口味池退居装饰；生成后还会对 AI 标出的
 *   searchTopic 做定向搜索补充细节（影评/进度之类）。关掉则完全走原来的兴趣驱动写法。
 * - eventSearchDailyLimit：定向搜索每天最多几次，默认 2，范围 0~5（EVENT_SEARCH_DAILY_LIMIT_MAX）。
 *   这个额度叠加在「API 设置」的联网搜索总额度之上，只是给单个角色再加一层上限，避免
 *   一个角色的事件搜索把当天共享额度全用掉。
 */
export async function loadScheduleEventSettings(userId, characterId) {
  const row = await db.get('settings', scheduleEventSettingsKey(userId, characterId)).catch(() => null);
  const value = row?.value || {};
  const limit = Number(value.eventSearchDailyLimit);
  return {
    eventNewsEnabled: value.eventNewsEnabled === true,
    eventSearchDailyLimit: Number.isFinite(limit)
      ? Math.min(EVENT_SEARCH_DAILY_LIMIT_MAX, Math.max(0, Math.round(limit)))
      : EVENT_SEARCH_DAILY_LIMIT_DEFAULT,
    scheduleLanguageMode: normalizeScheduleLanguageMode(value.scheduleLanguageMode),
  };
}

export async function saveScheduleEventSettings(userId, characterId, patch = {}) {
  const current = await loadScheduleEventSettings(userId, characterId);
  const next = { ...current, ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, 'scheduleLanguageMode')) {
    next.scheduleLanguageMode = normalizeScheduleLanguageMode(patch.scheduleLanguageMode);
  }
  await db.put('settings', { key: scheduleEventSettingsKey(userId, characterId), value: next });
  return next;
}

/**
 * 日程生成语言策略：默认中文；勾选「按角色语言」时跟 translationProfile。
 * 外语/方言正文的译文放在同一个生成 JSON 中，不另发一次计费请求。
 */
export function buildScheduleLanguagePolicy(mode, character) {
  const normalized = normalizeScheduleLanguageMode(mode);
  const textFields = 'activity / narrative / mood / dayTheme / shareCandidates / notes.text / flowSteps.action / privateThoughts / openLoops / changeReason';
  if (normalized !== SCHEDULE_LANGUAGE_FOLLOW_CHARACTER) {
    return {
      mode: SCHEDULE_LANGUAGE_CHINESE,
      directive: `语言：${textFields} 等所有正文一律用简体中文写。不要输出 zh 或 translation 字段。`,
      profile: null,
    };
  }
  const profile = normalizeTranslationProfile(character?.translationProfile);
  const brief = translationProfileBrief(profile);
  if (profile.mode === 'full') {
    const lang = profile.language || '角色设定里的主要外语';
    return {
      mode: SCHEDULE_LANGUAGE_FOLLOW_CHARACTER,
      directive: `语言：按角色聊天语言输出——TA 主要用${lang}。${textFields} 等正文直接写${lang}原文（不要把中文解释混进原文），并在本次同一个 JSON 内同步给出简体中文普通话译文，不得留到第二次请求。dailyLifePlan 写 dayThemeTranslation / moodTranslation；每个 block 写 activityTranslation / narrativeTranslation。卡片其它可见外语内容写入 block.displayTranslations：location 的 source 必须精确等于 [placeName, city].filter(Boolean).join(' · ')；changeReason、route、flow:<步骤 id>、eventNote、shareCandidates 也分别用 {"source":"对应原文","translation":"简体中文"}，只写实际存在的项。地点名 placeName/city 可用当地常用写法。`,
      profile: brief,
    };
  }
  if (profile.mode === 'mixed') {
    return {
      mode: SCHEDULE_LANGUAGE_FOLLOW_CHARACTER,
      directive: `语言：按角色聊天语言输出——日常以简体中文为主，偶尔夹${profile.dialectNote || '外语/方言'}词句时可直接写出原文。只要 dayTheme / mood / activity / narrative 实际含外语或方言，就在本次同一个 JSON 的对应 dayThemeTranslation / moodTranslation / activityTranslation / narrativeTranslation 给出完整简体中文普通话版本；其它卡片可见字段实际含外语或方言时，按 full 模式相同结构写入 block.displayTranslations。没有外语或方言的字段不要伪造译文。`,
      profile: brief,
    };
  }
  return {
    mode: SCHEDULE_LANGUAGE_FOLLOW_CHARACTER,
    directive: `语言：角色未设定主要外语（translationProfile 为中文/关闭），${textFields} 等正文一律用简体中文。不要输出 zh 或 translation 字段。`,
    profile: null,
  };
}

function withScheduleLanguageDirective(system, languagePolicy) {
  const directive = String(languagePolicy?.directive || '').trim();
  if (!directive) return String(system || '');
  return `${String(system || '').trim()}\n\n${directive}`;
}

function normalizeSchedulePasteText(text = '') {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
}

function extractJsonObject(raw) {
  const text = normalizeSchedulePasteText(String(raw || '').trim());
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

function extractFirstBalancedJsonObject(text = '') {
  const raw = normalizeSchedulePasteText(text);
  let start = -1;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== '}') continue;
    if (depth > 0) depth -= 1;
    if (depth === 0 && start >= 0) {
      try {
        return JSON.parse(normalizeSchedulePasteText(raw.slice(start, i + 1)));
      } catch (_) {
        start = -1;
      }
    }
  }
  return null;
}

function extractCompleteObjectsFromJsonArray(text = '', arrayKey = 'blocks') {
  const raw = normalizeSchedulePasteText(text);
  const re = new RegExp(`"${arrayKey}"\\s*:\\s*\\[`, 'i');
  const m = re.exec(raw);
  if (!m) return [];
  let idx = raw.indexOf('[', m.index);
  if (idx < 0) return [];
  idx += 1;
  const out = [];
  while (idx < raw.length) {
    while (idx < raw.length && /[\s,]/.test(raw[idx])) idx += 1;
    if (idx >= raw.length || raw[idx] === ']') break;
    if (raw[idx] !== '{') break;
    let depth = 0;
    let quote = '';
    let escaped = false;
    const objStart = idx;
    for (; idx < raw.length; idx += 1) {
      const ch = raw[idx];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          idx += 1;
          try {
            out.push(JSON.parse(normalizeSchedulePasteText(raw.slice(objStart, idx))));
          } catch (_) {}
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return out;
}

function salvageTruncatedScheduleJson(raw = '') {
  const text = normalizeSchedulePasteText(String(raw || '').trim());
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  const base = text.slice(start);
  for (const suffix of ['', ']}', ']}', ']}]}', ']}]}', '"]}', '"]}}', '"}]}', '"}]}}']) {
    try {
      const parsed = JSON.parse(base + suffix);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }
  const dailyBlocks = extractCompleteObjectsFromJsonArray(base, 'blocks');
  if (dailyBlocks.length) {
    const planMatch = base.match(/"dailyLifePlan"\s*:\s*\{/i);
    const dateMatch = base.match(/"dateKey"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
    return {
      dailyLifePlan: {
        dateKey: dateMatch?.[1] || '',
        dayType: 'mixed',
        dayTheme: '',
        mood: '',
        blocks: dailyBlocks,
      },
      _salvaged: true,
      _salvageNote: `从截断 JSON 救回 ${dailyBlocks.length} 个时段`,
    };
  }
  const weeklyPlans = [];
  const planRe = /"dateKey"\s*:\s*"(\d{4}-\d{2}-\d{2})"[\s\S]*?"blocks"\s*:\s*\[/gi;
  let wm;
  while ((wm = planRe.exec(base)) !== null) {
    const slice = base.slice(wm.index);
    const blocks = extractCompleteObjectsFromJsonArray(slice, 'blocks');
    if (blocks.length) {
      weeklyPlans.push({ dateKey: wm[1], dayType: 'mixed', blocks });
    }
  }
  if (weeklyPlans.length) {
    return {
      dailyLifePlans: weeklyPlans,
      _salvaged: true,
      _salvageNote: `从截断 JSON 救回 ${weeklyPlans.length} 天日程`,
    };
  }
  return null;
}

function throwScheduleJsonError(raw, { mode = 'daily', partialParsed = null } = {}) {
  const rawText = String(raw ?? '').trim();
  const partialBlocks = partialParsed?.dailyLifePlan?.blocks?.length
    || (Array.isArray(partialParsed?.dailyLifePlans)
      ? partialParsed.dailyLifePlans.reduce((n, p) => n + (p?.blocks?.length || 0), 0)
      : 0);
  const salvageNote = partialParsed?._salvageNote || '';
  const snippet = rawText.replace(/\s+/g, ' ').slice(0, 100);
  const err = new Error(
    partialBlocks
      ? `模型返回非完整 JSON（约 ${rawText.length} 字），但检测到 ${typeof partialBlocks === 'number' ? partialBlocks : '部分'}可救回数据${salvageNote ? `：${salvageNote}` : ''}`
      : `模型返回非 JSON 或 JSON 被截断（约 ${rawText.length} 字）${snippet ? `：${snippet}` : ''}`,
  );
  err.reason = rawText ? 'json-parse-failed' : 'empty-api-response';
  err.rawText = rawText;
  err.rawResponse = rawText;
  err.partialParsed = partialParsed;
  err.scheduleMode = mode;
  throw err;
}

async function saveScheduleGenerationDebug({
  userId, characterId, dateKey, mode, raw, parsedOk, maxTokens, salvaged = false,
} = {}) {
  await db.put('settings', {
    key: `dailyLifePlanDebug_${userId}_${characterId}`,
    value: {
      savedAt: Date.now(),
      dateKey,
      mode,
      maxTokens,
      rawLength: String(raw || '').length,
      parsedOk: !!parsedOk,
      salvaged: !!salvaged,
      raw: String(raw || '').slice(0, 60000),
    },
  }).catch(() => {});
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error('aborted');
  err.name = 'AbortError';
  throw err;
}

/** 日程默认保留 system / user 层级；兼容转换统一交给 API 设置。 */
function buildScheduleMessages(systemContent, userContent) {
  const context = String(systemContent || '').trim();
  const task = String(userContent || '').trim();
  return [
    ...(context ? [{ role: 'system', content: context }] : []),
    ...(task ? [{ role: 'user', content: task }] : []),
  ];
}

/**
 * 日程 JSON 很长（每段 narrative+flowSteps+routeHint，一天 5~8 段轻松超过 5000 tokens 输出），
 * 用户聊天档位的 maxTokens（默认 15000）若仍偏低时 JSON 可能被截断——本地容错只能救回前半天，
 * 表现为「日程到下午就没了」。这里给日程类生成设输出下限，用户配置更高时用用户的。
 */
const SCHEDULE_MIN_MAX_TOKENS = 6000;

function scheduleMaxTokens(resolved) {
  return Math.max(Number(resolved) || 0, SCHEDULE_MIN_MAX_TOKENS);
}

/** 流式中途断开时，已收到这么多字就交给下游截断救回，不整轮作废 */
const SCHEDULE_STREAM_PARTIAL_MIN_CHARS = 200;

/**
 * 单次请求；空回或断流不自动重发。
 * 跟随主 API 的流式开关：长 JSON 非流式要等几分钟才有首字节，最容易被网关当
 * 空闲连接掐掉（表现为「CORS 拦截」但中转已计费）；流式全程有数据不易被掐，
 * 且断开时还留有半截 JSON 可走本地 salvage / 手动救回弹窗。
 */
async function chatScheduleOnce({ system, user, options = {} } = {}) {
  const messages = buildScheduleMessages(system, user);
  const stream = (await resolveChatPreferStream()) === true;
  const requestOnce = async () => {
    try {
      return await chatCompletion(messages, { ...options, stream });
    } catch (err) {
      const partial = getStreamPartialText(err);
      if (partial.length >= SCHEDULE_STREAM_PARTIAL_MIN_CHARS) return partial;
      throw err;
    }
  };
  return requestOnce();
}

/** 先直接解析；失败（截断/包裹）时只做本地救回，不再调用模型修复。 */
async function parseScheduleJsonWithRepair(raw, { signal = null } = {}) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const attempts = [
    () => extractJsonObject(text),
    () => extractFirstBalancedJsonObject(text),
    () => salvageTruncatedScheduleJson(text),
  ];
  for (const tryParse of attempts) {
    const hit = tryParse();
    if (hit && typeof hit === 'object') return hit;
  }
  if (signal?.aborted) return salvageTruncatedScheduleJson(text);
  throwIfAborted(signal);
  return salvageTruncatedScheduleJson(text);
}

function addDaysToDateKey(dateKey, days) {
  const [y, m, d] = String(dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return dateKey;
  const dt = new Date(y, m - 1, d + days);
  return dateKeyFromTimestamp(dt.getTime());
}

function weekDateKeys(startDateKey) {
  return Array.from({ length: 7 }, (_, i) => addDaysToDateKey(startDateKey, i));
}

function cleanScheduleCity(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * 日程叙事使用故事城市；realCityMap / locationProfile.city 只负责天气与地图查数。
 * 旧角色常把现实映射城市同步进 locationProfile.city，因此有故事城市时不能再从那里回填。
 */
export function resolveCharacterScheduleCities(character = {}) {
  const residence = character?.residenceAnchor && typeof character.residenceAnchor === 'object'
    ? character.residenceAnchor
    : {};
  const profileCity = cleanScheduleCity(character?.locationProfile?.city?.name);
  const storyCity = cleanScheduleCity(residence.city);
  const dataCity = cleanScheduleCity(residence.realCityMap || profileCity || storyCity);
  return {
    storyCity: storyCity || profileCity || dataCity,
    dataCity,
  };
}

/**
 * 日程里的「家在哪」和「现在在哪」必须分开。尤其异地关系中，角色常驻城市不能
 * 被当成双方共享城市；近期聊天/用户指定的临时跨城事实也不能被常驻地覆盖。
 */
export function buildScheduleLocationContext({
  user = null,
  character = null,
  userDirective = '',
  recentChatContext = null,
  recentTravelFacts = null,
  offlineArchiveState = null,
  currentPlan = null,
} = {}) {
  const { storyCity: characterHomeCity } = resolveCharacterScheduleCities(character || {});
  const userHomeCity = cleanScheduleCity(user?.virtualCity);
  return {
    user: {
      homeCity: userHomeCity,
      placeLabel: String(user?.myPlaceLabel || '').trim(),
      placeAddress: String(user?.myPlaceAddress || '').trim(),
    },
    character: {
      homeCity: characterHomeCity,
      homeLabel: String(character?.residenceAnchor?.label || '').trim(),
    },
    currentLocationEvidence: {
      userDirective: String(userDirective || '').trim(),
      recentChatKeyLines: Array.isArray(recentChatContext?.keyLines)
        ? recentChatContext.keyLines.slice(-24)
        : [],
      verifiedCommitments: Array.isArray(recentChatContext?.verifiedCommitments)
        ? recentChatContext.verifiedCommitments.slice(-16)
        : [],
      recentTrips: Array.isArray(recentTravelFacts?.recentTrips)
        ? recentTravelFacts.recentTrips.slice(0, 8)
        : [],
      offlineArchiveState: offlineArchiveState || null,
      currentPlan: currentPlan || null,
    },
    rules: [
      'homeCity 只表示各自常驻地，不表示当前所在地；角色 homeCity 绝不是双方共享城市。',
      '用户与角色的位置必须分别判断：角色去用户所在城市时，只移动角色，不能把用户反向搬到角色常驻城市。',
      '用户直接指定、角色 currentStatus/promptCorpus、近期聊天中的明确到达/在途事实、约会卷宗 currentState、已接受或已完成邀约、现有日程起终点，都可以证明临时跨城；临时所在地优先于 homeCity。',
      '只有明确写出返程/到达后，角色才回到 homeCity；不得因刷新、重生成或校准而自动回家。',
      'realCityMap、天气城市和地图查询城市仅用于数据查询，不得覆盖上述叙事地点。',
    ],
  };
}

export function buildCharacterBrief(character, { includeTranslationProfile = false } = {}) {
  if (!character || typeof character !== 'object') return {};
  const lp = character.lifeProfile || {};
  const ra = character.residenceAnchor || {};
  const loc = character.locationProfile && typeof character.locationProfile === 'object'
    ? character.locationProfile
    : {};
  const locCity = loc.city && typeof loc.city === 'object' ? loc.city : {};
  const { storyCity } = resolveCharacterScheduleCities(character);
  const relationships = character.relationships && typeof character.relationships === 'object'
    ? character.relationships
    : {};
  const brief = {
    id: character.id,
    name: getCharacterAiContextName(character),
    realName: character.realName || '',
    aliases: Array.isArray(character.aliases) ? character.aliases : [],
    birthDate: character.birthDate || '',
    promptCorpus: character.promptCorpus || '',
    personality: character.personality || '',
    speechStyle: character.speechStyle || '',
    speechCorpus: character.speechCorpus || '',
    commonEmotes: character.commonEmotes || '',
    promptTags: Array.isArray(character.promptTags) ? character.promptTags : [],
    appearancePrompt: character.appearancePrompt || '',
    currentRole: character.currentRole || '',
    currentStatus: character.currentStatus || '',
    userRelationStatus: character.userRelationStatus || '',
    relationships,
    city: storyCity,
    storyCity,
    homeCity: storyCity,
    area: ra.area || '',
    mapQuery: ra.mapQuery || '',
    residenceAnchor: {
      city: storyCity,
      weatherHint: ra.weatherHint || '',
      area: ra.area || '',
      label: ra.label || '',
      mapQuery: ra.mapQuery || '',
      note: ra.note || '',
    },
    locationMode: loc.mode || '',
    locationRegion: loc.region || '',
    locationProfile: {
      mode: loc.mode || '',
      region: loc.region || '',
      city: { ...locCity, name: storyCity },
      lifestyle: loc.lifestyle || '',
      anchors: Array.isArray(loc.anchors) ? loc.anchors : [],
    },
    lifeProfile: {
      homeDetails: lp.homeDetails || '',
      familyThreads: lp.familyThreads || '',
      socialAnchors: lp.socialAnchors || '',
      habits: lp.habits || '',
      activitySeeds: lp.activitySeeds || '',
    },
    notes: character.notes || '',
    // Explicit clock-times anywhere in the profile beat generic "sleep at night" priors.
    sleepScheduleHint: '必须通读 promptCorpus 与全部结构化资料。任何模块写了具体睡眠钟点、昼伏夜出、夜班或白天休息，日程 blocks 都必须对齐，不得改写成普通早晚作息。',
  };
  if (includeTranslationProfile) {
    const tp = translationProfileBrief(character.translationProfile);
    if (tp) brief.translationProfile = tp;
  }
  return brief;
}

function summarizePlanLocation(loc = {}) {
  if (!loc || typeof loc !== 'object') return null;
  const city = String(loc.city || '').trim();
  const placeName = String(loc.placeName || '').trim();
  const area = String(loc.area || '').trim();
  if (!city && !placeName && !area) return null;
  return { city, placeName, area };
}

function summarizeBlockBrief(block = {}) {
  if (!block || typeof block !== 'object') return null;
  return {
    timeRange: block.timeRange,
    activity: block.activity,
    placeName: block.placeName,
    city: block.city,
    status: block.status || 'planned',
    origin: block.origin || '',
    updatedBy: block.updatedBy || '',
    changeReason: block.changeReason || '',
    sourceRefs: Array.isArray(block.sourceRefs) ? block.sourceRefs.slice(0, 4) : [],
    eventContext: block.eventContext ? {
      archiveId: block.eventContext.archiveId || '',
      participantNames: (block.eventContext.participantNames || []).slice(0, 8),
      summary: block.eventContext.summary || '',
      quotes: (block.eventContext.quotes || []).slice(0, 3),
      relationshipShifts: (block.eventContext.relationshipShifts || []).slice(0, 4),
      hooks: (block.eventContext.hooks || []).slice(0, 4),
    } : null,
    repeatFlag: block.repeatFlag || undefined,
  };
}

function resolvedPhonePlans(phone = {}) {
  const dateKeys = new Set([
    ...(phone?.dailyLifePlans || []).map((plan) => String(plan?.dateKey || '')),
    ...(phone?.offlineScheduleOverrides || []).map((item) => String(item?.dateKey || '')),
  ].filter(Boolean));
  return [...dateKeys]
    .map((dateKey) => getDailyLifePlanForDate(phone, dateKey))
    .filter(Boolean)
    .sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
}

/** 一天的活动极简摘要（时间段+做什么+在哪），只给去重参考用，别跟 notableBlocks 抢篇幅 */
function summarizeActivityBrief(block = {}) {
  const activity = String(block?.activity || '').trim();
  if (!activity) return '';
  const place = String(block?.placeName || block?.anchor || '').trim();
  const timeRange = String(block?.timeRange || '').trim();
  return [timeRange, activity, place ? `@${place}` : ''].filter(Boolean).join(' ').slice(0, 60);
}

function summarizePlanTail(plan = {}) {
  const blocks = Array.isArray(plan.blocks) ? plan.blocks : [];
  const firstBlock = blocks.find(Boolean) || null;
  const lastBlock = blocks.filter(Boolean).slice(-1)[0] || null;
  const notableBlocks = blocks
    .filter((block) => block && (
      block.origin === 'travel-char'
      || ['done', 'changed', 'active'].includes(String(block.status || ''))
      || block.repeatFlag
    ))
    .map(summarizeBlockBrief)
    .filter(Boolean)
    .slice(0, 6);
  return {
    dateKey: plan.dateKey,
    dayType: plan.dayType,
    dayTheme: plan.dayTheme,
    mood: plan.mood,
    startLocation: summarizePlanLocation(plan.dayStartLocation),
    endLocation: summarizePlanLocation(plan.dayEndLocation),
    firstBlock: firstBlock ? summarizeBlockBrief(firstBlock) : null,
    lastBlock: lastBlock ? summarizeBlockBrief(lastBlock) : null,
    activityBrief: blocks.map(summarizeActivityBrief).filter(Boolean).slice(0, 8),
    notableBlocks,
    doneTravelBlocks: blocks
      .filter((block) => block?.origin === 'travel-char'
        && ['done', 'changed'].includes(String(block.status || '')))
      .map(summarizeBlockBrief)
      .filter(Boolean)
      .slice(0, 4),
  };
}

function isImmutableScheduleBlock(block = {}) {
  const origin = String(block.origin || '').toLowerCase();
  const status = String(block.status || '').toLowerCase();
  return block.locked === true
    || ['done', 'active'].includes(status)
    || /(offline|travel-char|travel_char)/u.test(origin)
    || (Array.isArray(block.sourceRefs)
      && block.sourceRefs.some((ref) => /(offline|travel-char|travel_char)/iu.test(String(ref || ''))));
}

/** 重生成时把用户刚刚否掉的旧稿单独带回，只作负例，不能再被当成历史事实延续。 */
export function buildRerollAvoidPlan(phone = {}, dateKey = '') {
  const plan = (Array.isArray(phone?.dailyLifePlans) ? phone.dailyLifePlans : [])
    .find((item) => String(item?.dateKey || '') === String(dateKey || ''));
  if (!plan) return null;
  const blocks = (Array.isArray(plan.blocks) ? plan.blocks : [])
    .filter((block) => block && !isImmutableScheduleBlock(block))
    .map((block) => ({
      timeRange: block.timeRange || '',
      activity: block.activity || '',
      placeName: block.placeName || block.anchor || '',
      narrative: String(block.narrative || '').slice(0, 260),
      flowSteps: (Array.isArray(block.flowSteps) ? block.flowSteps : [])
        .map((step) => String(step?.action || '').trim())
        .filter(Boolean)
        .slice(0, 5),
    }))
    .filter((block) => block.activity || block.narrative);
  if (!blocks.length) return null;
  return {
    dateKey: plan.dateKey,
    dayTheme: plan.dayTheme || '',
    mood: plan.mood || '',
    blocks,
  };
}

function escapeScheduleRegExp(text = '') {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scheduleBlockText(block = {}) {
  return [
    block.activity,
    block.narrative,
    block.anchor,
    block.placeName,
    block.city,
    ...(Array.isArray(block.flowSteps) ? block.flowSteps.map((step) => step?.action) : []),
  ].filter(Boolean).join(' ');
}

export function scheduleBlockImpliesUserPresence(block = {}, userName = '') {
  const text = scheduleBlockText(block).replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const names = ['用户', '你', String(userName || '').trim()].filter(Boolean).map(escapeScheduleRegExp);
  const who = `(?:${names.join('|')})`;
  const patterns = [
    new RegExp(`(?:和|与|陪|跟)${who}.{0,12}(?:一起|见面|碰面|出门|吃饭|逛|看电影|旅行|约会|同行|待在)`, 'u'),
    new RegExp(`(?:去见|来见|见到|碰到|去接|来接|接上|送)${who}`, 'u'),
    new RegExp(`${who}.{0,10}(?:过来|到场|赴约|同行|一起出门|一起吃|一起逛|一起看|一起旅行)`, 'u'),
    new RegExp(`(?:线下.{0,8}${who}|${who}.{0,8}线下)`, 'u'),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function schedulePlanImpliesUserPresence(plan = {}, userName = '') {
  return (Array.isArray(plan?.blocks) ? plan.blocks : [])
    .some((block) => scheduleBlockImpliesUserPresence(block, userName));
}

function userDirectiveAllowsPresence(userDirective = '', userName = '') {
  const text = String(userDirective || '').trim();
  if (!text) return false;
  const names = ['我', '用户', String(userName || '').trim()].filter(Boolean).map(escapeScheduleRegExp);
  const who = `(?:${names.join('|')})`;
  return new RegExp(`(?:和|与|陪|跟)${who}.{0,16}(?:见面|碰面|出门|吃|逛|看|玩|旅行|约会|同行|一起)|${who}.{0,12}(?:见面|碰面|到场|赴约|同行|一起)`, 'u').test(text);
}

function hasVerifiedUserPresenceEvidence({
  phone = {},
  dateKey = '',
  recentChatContext = null,
  userDirective = '',
  userName = '',
} = {}) {
  if (userDirectiveAllowsPresence(userDirective, userName)) return true;
  if (Array.isArray(recentChatContext?.verifiedCommitments)
    && recentChatContext.verifiedCommitments.length) {
    const latestCommitment = String(recentChatContext.verifiedCommitments.slice(-1)[0] || '');
    if (!SCHEDULE_CANCEL_RE.test(latestCommitment)) return true;
  }
  return (Array.isArray(phone?.offlineScheduleOverrides) ? phone.offlineScheduleOverrides : [])
    .some((item) => String(item?.dateKey || '') === String(dateKey || '') && item?.block);
}

function createScheduleIntegrityError(message, reason) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}

function assertScheduleUserPresenceEvidence(plan, context = {}) {
  const userName = context.userName || '';
  if (!schedulePlanImpliesUserPresence(plan, userName)) return;
  if (hasVerifiedUserPresenceEvidence({ ...context, dateKey: plan?.dateKey, userName })) return;
  throw createScheduleIntegrityError(
    '生成结果凭空安排了用户参与线下行程，已拦截且未保存。请重新生成或先在聊天中明确约定。',
    'schedule-unverified-user-presence',
  );
}

const ROUTINE_SCHEDULE_PLOT_RE = /(睡|起床|洗漱|通勤|上班|工作|开会|午饭|晚饭|吃饭|休息|回家|家务|收拾|洗澡|刷牙|做饭|补觉)/u;
const DISTINCTIVE_SCHEDULE_PLOT_RE = /(用户|朋友|同事|见面|约会|聚会|探店|旅行|电影|展览|市集|公园|商场|咖啡|书店|餐厅|酒吧|演出|比赛|机场|车站)/u;

function normalizeSchedulePlotText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()\[\]【】《》<>\-—_·~`]/gu, '')
    .replace(/(然后|接着|随后|顺便|最后|于是|自己|今天|当天|一会儿|一阵子|慢慢|稍微|有点)/gu, '');
}

function schedulePlotBigrams(text = '') {
  const normalized = normalizeSchedulePlotText(text);
  const grams = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

function schedulePlotSimilarity(left = '', right = '') {
  const a = schedulePlotBigrams(left);
  const b = schedulePlotBigrams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function meaningfulScheduleBlocks(plan = {}) {
  return (Array.isArray(plan?.blocks) ? plan.blocks : []).filter((block) => {
    if (!block || isImmutableScheduleBlock(block)) return false;
    const activity = String(block.activity || '').trim();
    const text = scheduleBlockText(block);
    const isPlainRoutine = ROUTINE_SCHEDULE_PLOT_RE.test(activity)
      && !DISTINCTIVE_SCHEDULE_PLOT_RE.test(activity);
    return activity && !block.isSleep && !isPlainRoutine && normalizeSchedulePlotText(text).length >= 12;
  });
}

/**
 * 对比近 7 天的非固定日常主线。命中时不自动重试，直接拒绝保存，避免失败稿继续成为下一天的“历史”。
 */
export function findRepeatedSchedulePlot(plan = {}, phone = {}, {
  dateKey = plan?.dateKey || '',
  includeSameDate = false,
} = {}) {
  const currentBlocks = meaningfulScheduleBlocks(plan);
  if (!currentBlocks.length) return null;
  const priorPlans = (Array.isArray(phone?.dailyLifePlans) ? phone.dailyLifePlans : [])
    .filter((candidate) => {
      const candidateDate = String(candidate?.dateKey || '');
      if (!candidateDate) return false;
      if (includeSameDate && candidateDate === String(dateKey)) return true;
      return candidateDate < String(dateKey);
    })
    .sort((a, b) => String(b.dateKey).localeCompare(String(a.dateKey)))
    .slice(0, 7);
  for (const previous of priorPlans) {
    const previousBlocks = meaningfulScheduleBlocks(previous);
    const planSimilarity = schedulePlotSimilarity(
      currentBlocks.map(scheduleBlockText).join(' '),
      previousBlocks.map(scheduleBlockText).join(' '),
    );
    if (previousBlocks.length && planSimilarity >= 0.72) {
      return {
        dateKey: previous.dateKey,
        similarity: planSimilarity,
        activity: currentBlocks[0]?.activity || '',
      };
    }
    for (const currentBlock of currentBlocks) {
      const currentText = scheduleBlockText(currentBlock);
      for (const previousBlock of previousBlocks) {
        const previousText = scheduleBlockText(previousBlock);
        const similarity = schedulePlotSimilarity(currentText, previousText);
        const sameActivityPlace = normalizeSchedulePlotText(`${currentBlock.activity}${currentBlock.placeName || ''}`)
          === normalizeSchedulePlotText(`${previousBlock.activity}${previousBlock.placeName || ''}`);
        if (similarity >= 0.78 || (sameActivityPlace && similarity >= 0.58)) {
          return {
            dateKey: previous.dateKey,
            similarity,
            activity: currentBlock.activity || '',
          };
        }
      }
    }
  }
  return null;
}

function assertSchedulePlotIsFresh(plan, phone, options = {}) {
  const repeated = findRepeatedSchedulePlot(plan, phone, options);
  if (!repeated) return;
  throw createScheduleIntegrityError(
    `生成结果与 ${repeated.dateKey} 的剧情高度重复，已拦截且未保存。`,
    'schedule-plot-repeated',
  );
}

async function collectRecentTravelScheduleContext({ userId, characterId, timestamp = Date.now() } = {}) {
  if (!userId || !characterId) return null;
  const now = Number(timestamp || Date.now()) || Date.now();
  const cutoff = now - 14 * 24 * 60 * 60 * 1000;
  const recentTrips = (await listTravelCharTrips(userId, characterId).catch(() => []))
    .filter((trip) => trip && ['returned', 'cancelled'].includes(String(trip.status || '')))
    .filter((trip) => Number(trip.returnedAt || trip.updatedAt || trip.createdAt || 0) >= cutoff)
    .sort((a, b) => Number(b.returnedAt || b.updatedAt || 0) - Number(a.returnedAt || a.updatedAt || 0))
    .slice(0, 8)
    .map((trip) => ({
      dateKey: dateKeyFromTimestamp(trip.returnedAt || trip.createdAt || now),
      status: trip.status,
      theme: trip.theme,
      title: trip.title || '',
      city: trip.city || '',
      withUser: trip.withUser === true,
      companionNames: Array.isArray(trip.invite?.companionNames) ? trip.invite.companionNames.slice(0, 6) : [],
      companionJoinedIds: Array.isArray(trip.invite?.companionJoinedIds)
        ? trip.invite.companionJoinedIds.slice(0, 6)
        : [],
      places: (Array.isArray(trip.route?.stops) ? trip.route.stops : [])
        .map((stop) => String(stop?.placeName || '').trim())
        .filter(Boolean)
        .slice(0, 5),
      memoryText: String(trip.memoryText || trip.returnSummary || '').trim().slice(0, 220),
      occurredAt: trip.returnedAt || trip.createdAt || 0,
    }));

  let allMemories = [];
  try {
    allMemories = await db.getAllByIndex('memories', 'characterId', characterId);
  } catch (_) {
    allMemories = await db.getAllRecords('memories').catch(() => []);
  }
  const travelMemories = (Array.isArray(allMemories) ? allMemories : [])
    .filter((mem) => mem?.source === 'travel_char' && (!mem.userId || mem.userId === userId))
    .filter((mem) => Number(mem.timestamp || 0) >= cutoff)
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, 8)
    .map((mem) => ({
      dateKey: dateKeyFromTimestamp(mem.timestamp),
      occurredAt: mem.timestamp || 0,
      travelTripId: String(mem.travelTripId || '').trim(),
      summary: String(mem.content || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    }));

  if (!recentTrips.length && !travelMemories.length) return null;
  return {
    window: 'recent_14_days',
    rule: '以下旅行/外出事件已在指定日期真实发生过。新日程不得把它们当作未来计划重写，不得改动同行人员、地点组合与事件结论；只能作为回忆背景，或在之后另开全新活动。',
    recentTrips,
    travelMemories,
  };
}

function compactMessageContent(message = {}) {
  const type = String(message?.type || 'text');
  if (type === 'offlineInvite') return compactOfflineInviteContent(message);
  const content = String(message?.content || message?.metadata?.caption || message?.metadata?.text || '').replace(/\s+/g, ' ').trim();
  if (content) return content.slice(0, 120);
  if (type === 'image') return '[图片]';
  if (type === 'sticker') return '[表情]';
  if (type === 'location') return '[位置]';
  if (type === 'voice') return '[语音]';
  return `[${type || '消息'}]`;
}

/** 线下邀约的进展要完整带出地点/时间/状态，日程生成才能围着这个约定排，别只看到一句寒暄。 */
function compactOfflineInviteContent(message = {}) {
  const md = message?.metadata || {};
  const statusLabel = {
    fulfilled: '已完成',
    accepted: '已接受',
    declined: '已婉拒',
    shelved: '搁置中',
    pending: '待回应',
  }[String(md.status || 'pending')] || '待回应';
  const from = md.inviteFrom === 'character' ? 'TA 发起' : '用户发起';
  const parts = [
    md.timeLabel,
    md.toUserPlace ? '（TA 出门来找用户）' : md.place,
    md.activity,
    md.note || message?.content,
    md.route?.summary,
  ].map((x) => String(x || '').trim()).filter(Boolean);
  return `[线下邀约·${from}·${statusLabel}] ${parts.join(' · ')}`.slice(0, 200);
}

const SCHEDULE_DATE_SIGNAL_RE = /(今天(?:上午|下午|晚上)?|今晚|明天|后天|周末|下周|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{1,2}[:：]\d{2})/u;
const SCHEDULE_ACTION_RE = /(见面|碰面|约会|去接|来接|接你|送你|一起.{0,12}(吃|逛|看|玩|去|来|出门|旅行)|吃饭|看电影|逛街|旅行|出差|请假)/u;
const SCHEDULE_BILATERAL_RE = /(和你|跟你|陪你|接你|送你|你来|你去|我们|咱们|一起)/u;
const SCHEDULE_CONFIRM_RE = /(说好|约好|答应|定好|决定好了|安排好了|就这么定|不见不散|到时候见|明天见|我会去|我一定去|我来接|我去接)/u;
const SCHEDULE_CANCEL_RE = /(取消|改期|不去了|不去|别来|不用来|不见了|延期)/u;
const SCHEDULE_ACK_RE = /^(好|好啊|好呀|好的|好哒|可以|可以啊|行|行啊|没问题|说定了|就这么定|明天见|到时见|不见不散)[！!。.\s]*$/u;

/**
 * 只把明确承诺/取消，或已经接受、完成的结构化线下邀约视为日程事实。
 * 「明天去看看吧」这类单方提议不能单独证明用户会到场。
 */
export function isExplicitScheduleCommitment(content = '', { type = '', metadata = null } = {}) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  const status = String(metadata?.status || '').trim();
  if (type === 'offlineInvite') {
    return metadata?.arrived === true || ['accepted', 'fulfilled'].includes(status);
  }
  return !!text
    && SCHEDULE_DATE_SIGNAL_RE.test(text)
    && SCHEDULE_BILATERAL_RE.test(text)
    && (SCHEDULE_CANCEL_RE.test(text)
      || (SCHEDULE_ACTION_RE.test(text) && SCHEDULE_CONFIRM_RE.test(text)));
}

function isScheduleProposal(content = '') {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  return !!text && SCHEDULE_DATE_SIGNAL_RE.test(text) && SCHEDULE_ACTION_RE.test(text);
}

/**
 * 除了单句明确承诺，也识别「一方提出具体时间与活动，另一方紧接着明确同意」。
 * 必须是不同发送者、相距不超过 6 小时，避免把两段无关闲聊拼成约定。
 */
export function collectVerifiedScheduleCommitments(rows = []) {
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.content)
    .slice()
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const accepted = new Set();
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index];
    if (isExplicitScheduleCommitment(row.content, row)) {
      accepted.add(index);
      continue;
    }
    if (!SCHEDULE_ACK_RE.test(String(row.content || '').trim())) continue;
    for (let previousIndex = index - 1; previousIndex >= Math.max(0, index - 3); previousIndex -= 1) {
      const proposal = sorted[previousIndex];
      const elapsed = Number(row.timestamp || 0) - Number(proposal.timestamp || 0);
      if (elapsed < 0 || elapsed > 6 * 60 * 60 * 1000) continue;
      if (!proposal.senderId || !row.senderId || proposal.senderId === row.senderId) continue;
      if (!isScheduleProposal(proposal.content)) continue;
      accepted.add(previousIndex);
      accepted.add(index);
      break;
    }
  }
  return [...accepted]
    .sort((a, b) => a - b)
    .map((index) => sorted[index]?.line || sorted[index]?.content)
    .filter(Boolean)
    .slice(-16);
}

function scheduleChatDateLabel(timestamp, timeZone = '') {
  const options = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  };
  try {
    return new Date(timestamp).toLocaleString('zh-CN', options);
  } catch (_) {
    delete options.timeZone;
    return new Date(timestamp).toLocaleString('zh-CN', options);
  }
}

async function collectRecentScheduleChatContext({
  userId,
  characterId,
  timestamp = Date.now(),
  user = null,
  targetDateKey = '',
  timeZone = '',
} = {}) {
  if (!userId || !characterId) return null;
  const now = Number(timestamp || Date.now()) || Date.now();
  const resolvedTargetDateKey = String(targetDateKey || dateKeyFromTimestamp(now, timeZone));
  const previousDateKey = addDaysToDateKey(resolvedTargetDateKey, -1);
  const chats = (await db.getAllByIndex('chats', 'userId', userId).catch(() => []))
    .filter((chat) => Array.isArray(chat?.participants)
      && chat.participants.includes('user')
      && chat.participants.includes(characterId))
    .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0))
    .slice(0, 12);
  const userName = getUserDisplayName(user);
  const rows = [];
  const keyRows = [];
  const previousDayRows = [];
  const signalRe = /(今天|明天|后天|这周|周末|上午|下午|晚上|半夜|凌晨|熬夜|通宵|睡不着|约|见面|出门|逛|去|来|回|到|在|酒店|机场|高铁|车站|出差|旅行|吃饭|咖啡|餐厅|公园|商场|书店|展|电影|天气|下雨|降温|好热|好冷|路上|附近|顺路)/u;
  for (const chat of chats) {
    const messages = filterNonGuidanceMessages(await db.getAllByIndex('messages', 'chatId', chat.id).catch(() => []));
    const chatName = chat.type === 'group' ? String(chat.groupSettings?.name || '群聊').slice(0, 40) : '私聊';
    for (const message of messages) {
      if (!message || message.deleted || message.recalled || message.type === 'system') continue;
      const ts = Number(message.timestamp || 0) || 0;
      if (!ts || ts > now + 10 * 60 * 1000 || now - ts > 5 * 24 * 60 * 60 * 1000) continue;
      const senderId = String(message.senderId || '').trim();
      if (senderId !== 'user' && !chat.participants.includes(senderId)) continue;
      if (isGuidanceMessage(message)) continue;
      const content = compactMessageContent(message);
      if (!content) continue;
      const senderName = senderId === 'user'
        ? userName
        : String(message.senderName || senderId).slice(0, 40);
      const messageDateKey = dateKeyFromTimestamp(ts, timeZone);
      const line = `${scheduleChatDateLabel(ts, timeZone)} ${chatName} ${senderName}：${content}`;
      const row = {
        timestamp: ts,
        dateKey: messageDateKey,
        senderId,
        type: String(message.type || 'text'),
        metadata: message.metadata || {},
        content,
        line,
        high: signalRe.test(content),
      };
      rows.push(row);
      if (row.high) keyRows.push(row);
      if (messageDateKey === previousDateKey) {
        previousDayRows.push(row);
      }
    }
  }
  const newestLines = rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, 80).sort((a, b) => a.timestamp - b.timestamp).map((row) => row.line);
  const keyLines = keyRows.sort((a, b) => b.timestamp - a.timestamp).slice(0, 32).sort((a, b) => a.timestamp - b.timestamp).map((row) => row.line);
  const previousDayCommitmentLines = collectVerifiedScheduleCommitments(previousDayRows);
  const latestMessageAt = Math.max(0, ...rows.map((row) => Number(row.timestamp || 0)));
  const elapsedSinceLatestMessageMs = latestMessageAt ? Math.max(0, now - latestMessageAt) : 0;
  return {
    window: 'recent_5_days',
    rule: '近期聊天用于口吻、天气、位置、假期/学期与生活背景。只有 verifiedCommitments / previousDay.commitmentCandidates 中经过本地核验的双向约定或已接受邀约，才能证明用户会实际参与某段行程；其它闲聊不得推导出线下见面、约会、同行或用户到场。',
    latestMessageAt,
    elapsedSinceLatestMessageMs,
    timeFlowRule: elapsedSinceLatestMessageMs >= 24 * 60 * 60 * 1000
      ? '最近聊天距目标生成时刻已经跨日：旧消息里的“正在、刚要、马上、等会儿”等临时状态默认已经结束或转场，只保留已经确认的长期事实、假期/学期背景与明确约定。'
      : '按消息时间戳判断先后；临时动作只能在合理时长内延续，不能因为没有新聊天就冻结时间。',
    newestLines,
    keyLines,
    verifiedCommitments: previousDayCommitmentLines,
    previousDay: previousDayCommitmentLines.length
      ? {
        messageDateKey: previousDateKey,
        targetDateKey: resolvedTargetDateKey,
        rule: `这些候选已由本地规则确认包含双方确认、明确承诺、取消/改期，或已接受的线下邀约。消息发生在 ${previousDateKey}，目标日程是 ${resolvedTargetDateKey}；“明天”指目标日。只能使用 commitmentCandidates 证明用户会参与，不能从其它聊天行自行补出约会。`,
        commitmentCandidates: previousDayCommitmentLines,
      }
      : null,
  };
}

async function collectRecentScheduleMemoryContext({
  userId,
  characterId,
  timestamp = Date.now(),
  timeZone = '',
} = {}) {
  if (!userId || !characterId) return null;
  const now = Number(timestamp || Date.now()) || Date.now();
  const relatedChats = (await db.getAllByIndex('chats', 'userId', userId).catch(() => []))
    .filter((chat) => Array.isArray(chat?.participants) && chat.participants.includes(characterId));
  const relatedChatIds = new Set(relatedChats.map((chat) => String(chat?.id || '').trim()).filter(Boolean));
  let memories = await db.getAllByIndex('memories', 'userId', userId).catch(() => []);
  if (!memories.length) {
    memories = await db.getAllByIndex('memories', 'characterId', characterId).catch(() => []);
  }
  const items = (Array.isArray(memories) ? memories : [])
    .filter((memory) => memory && (!memory.userId || memory.userId === userId))
    .filter((memory) => (
      String(memory.characterId || '').trim() === characterId
      || relatedChatIds.has(String(memory.chatId || '').trim())
    ))
    .filter((memory) => String(memory.content || '').trim())
    .filter((memory) => !Number(memory.timestamp || 0) || Number(memory.timestamp || 0) <= now + 10 * 60 * 1000)
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, 18)
    .map((memory) => ({
      date: Number(memory.timestamp || 0)
        ? scheduleChatDateLabel(Number(memory.timestamp), timeZone)
        : '未标日期',
      type: String(memory.type || memory.source || 'memory').slice(0, 32),
      content: String(memory.content || '')
        .replace(/^【区间】[^\n]*\n/u, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 520),
    }));
  if (!items.length) return null;
  return {
    rule: '这些是角色相关的长期记忆与聊天摘要。明确的放假/开学、学期、职业变动、异地状态和已经发生的生活事实必须参与日程判断。按日期仲裁临时事实：较新的明确记忆可更新较旧的 currentStatus；稳定人设、身份和长期习惯仍然有效。',
    items,
  };
}

/** 取该角色最新一份约会卷宗里的持续状态；新卷宗会自然覆盖旧卷宗，避免旧地点重新浮现。 */
export function buildRecentOfflineArchiveStateContext(archives = [], characterId = '') {
  const cid = String(characterId || '').trim();
  if (!cid) return null;
  const latest = (Array.isArray(archives) ? archives : [])
    .filter((archive) => {
      const ids = [
        archive?.characterId,
        ...(Array.isArray(archive?.participantIds) ? archive.participantIds : []),
        ...(Array.isArray(archive?.allEverParticipantIds) ? archive.allEverParticipantIds : []),
      ].map((id) => String(id || '').trim());
      return ids.includes(cid);
    })
    .sort((a, b) => Number(b?.endedAt || b?.startedAt || 0) - Number(a?.endedAt || a?.startedAt || 0))[0];
  if (!latest) return null;
  const currentState = String(latest.currentState ?? latest.digest?.currentState ?? '').trim().slice(0, 600);
  if (!currentState) return null;
  return {
    archiveId: String(latest.id || ''),
    endedAt: Number(latest.endedAt || latest.startedAt || 0) || 0,
    participantIds: (Array.isArray(latest.participantIds) ? latest.participantIds : []).slice(0, 8),
    participantNames: (Array.isArray(latest.participantNames) ? latest.participantNames : []).slice(0, 8),
    currentState,
    rule: '这是最近一次线下剧情结束后仍然成立的现实状态，优先级高于角色常驻地和旧日程。生成新日程必须从此状态续接；只有记录了明确返程、搬离或其它更新事实，才能改变这里的所在地与同住/同行安排。',
  };
}

async function collectRecentOfflineArchiveStateContext({ userId, characterId } = {}) {
  if (!userId || !characterId) return null;
  const row = await db.get(`offlineDateArchives_${encodeURIComponent(userId)}`).catch(() => null);
  return buildRecentOfflineArchiveStateContext(row?.value, characterId);
}

async function buildDailyWeatherContext(character = {}) {
  const info = getEffectiveWeatherCityForCharacter(character);
  if (!info.weatherCity) return null;
  const weather = await fetchWeatherForCity(info.weatherCity).catch(() => null);
  if (!weather?.promptLine) return null;
  return {
    city: info.weatherCity,
    source: info.source,
    promptLine: weather.promptLine,
    lifeIndex: formatWeatherLifeIndex(weather).replace(/^\n生活指数提示：/u, ''),
  };
}

// 只识别几类高频重复场景（吃喝/休闲主力类目），未命中的活动不计入统计——避免"其它"占满
// 榜首却没有信息量；这些标签只用于查重提示，不是严谨的活动分类体系。
const ACTIVITY_BUCKET_KEYWORDS = [
  { label: '咖啡店', re: /(咖啡|espresso|拿铁|美式咖啡)/u },
  { label: '奶茶店', re: /(奶茶|果茶|柠檬茶|水果茶)/u },
  { label: '早茶', re: /(早茶|茶楼|粤式点心|港式点心|dim\s?sum)/iu },
  { label: '烤肉', re: /(烤肉|烧烤|烤串)/u },
  { label: '火锅', re: /火锅/u },
  { label: '健身', re: /(健身|撸铁|跑步机|游泳|球馆)/u },
  { label: '逛街', re: /(逛街|商场|逛店|购物)/u },
  { label: '网吧', re: /(网吧|电竞馆)/u },
  { label: '书店', re: /(书店|图书馆)/u },
  { label: '公园', re: /(公园|散步|遛)/u },
  { label: '看电影', re: /(电影院|看电影)/u },
  { label: '甜品店', re: /(甜品|蛋糕|冰淇淋|雪糕)/u },
];

function bucketActivityLabel(activity = '', placeName = '') {
  const text = `${activity || ''} ${placeName || ''}`;
  const hit = ACTIVITY_BUCKET_KEYWORDS.find(({ re }) => re.test(text));
  return hit ? hit.label : '';
}

function formatMonthDay(dateKey = '') {
  const parts = String(dateKey || '').split('-');
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : dateKey;
}

/**
 * 近 N 天高频活动类目统计，供日程生成避免「连续同店同活动」的完全重复（见 DAILY_SYSTEM
 * repeatWarning 规则）。只统计能命中关键词表的活动，命中不到的（比如上班、见朋友这类本就
 * 该重复或太杂的）不计入，避免噪音把真正重复的类目挤出 top 榜。
 */
export function computeRecentActivitySummary(phone, days = 5) {
  const plans = resolvedPhonePlans(phone)
    .filter((p) => p?.dateKey)
    .sort((a, b) => String(b.dateKey).localeCompare(String(a.dateKey)))
    .slice(0, days);
  const counts = new Map();
  for (const plan of plans) {
    for (const block of Array.isArray(plan.blocks) ? plan.blocks : []) {
      const label = bucketActivityLabel(block?.activity, block?.placeName);
      if (!label) continue;
      const row = counts.get(label) || { label, count: 0, lastDate: plan.dateKey };
      row.count += 1;
      if (String(plan.dateKey) > String(row.lastDate)) row.lastDate = plan.dateKey;
      counts.set(label, row);
    }
  }
  const all = [...counts.values()].sort((a, b) => b.count - a.count || String(b.lastDate).localeCompare(String(a.lastDate)));
  return {
    top: all.slice(0, 5).map((r) => ({ label: r.label, count: r.count, lastDate: formatMonthDay(r.lastDate) })),
    repeatWarning: all.filter((r) => r.count >= 3).map((r) => r.label),
  };
}

// repeatWarning 命中的类目里，这些是允许天天重复的固定规律（通勤/健身房/固定兴趣班），
// 与 DAILY_SYSTEM 里"除非那是 TA 的固定规律"的措辞保持一致，不参与硬校验。
const ROUTINE_EXEMPT_ACTIVITY_LABELS = new Set(['健身']);

/**
 * 生成后校验（把 repeatWarning 从纯提示词软提示加固一层）：提示词已经要求模型自己避开
 * repeatWarning 类目，但模型仍可能忽略——这里在拿到新 patch 后再核对一遍，命中且不属于
 * 固定规律的 block 打上 repeatFlag。不做自动 reroll（重新调用模型代价高，还可能陷入
 * 「同样的软提示、同样被忽略」的死循环）；而是把确认命中的证据经 summarizePlanTail 的
 * notableBlocks 带回下一次生成的 phoneSnapshot，让"这条真的被重复过"变成模型能看到的
 * 既成事实，而不是一个可能没被认真对待的统计提示。
 */
function flagRepeatedActivityBlocks(patch, recentSummary) {
  const repeatLabels = new Set(
    (recentSummary?.repeatWarning || []).filter((label) => !ROUTINE_EXEMPT_ACTIVITY_LABELS.has(label)),
  );
  const blocks = patch?.dailyLifePlan?.blocks;
  if (!repeatLabels.size || !Array.isArray(blocks) || !blocks.length) return patch;
  let flaggedCount = 0;
  for (const block of blocks) {
    if (!block) continue;
    const label = bucketActivityLabel(block.activity, block.placeName);
    if (label && repeatLabels.has(label)) {
      block.repeatFlag = label;
      flaggedCount += 1;
    }
  }
  if (flaggedCount) {
    console.warn(`[character-daily-life] 今日日程命中 repeatWarning 类目 ${flaggedCount} 处：`, [...repeatLabels]);
  }
  return patch;
}

const NIGHT_SCHEDULE_EXCEPTION_RE = /(夜班|值夜|夜勤|通宵班|昼伏夜出|夜行|夜猫|凌晨工作|深夜工作|晚上上班|白天睡|傍晚.{0,8}(起床|醒)|夜间通勤|24\s*小时轮班|夜生活|酒吧常客|夜店|蹦迪|驻唱|晚场|午夜场)/iu;
const EXPLICIT_DEEP_NIGHT_REST_RE = /(早睡|规律作息|作息严格|到点.{0,6}(睡|休息)|不熬夜|禁止熬夜|(?:晚上)?(?:十|十一|22|23)点.{0,8}(睡|上床|休息)|(?:零点|0\s*点|00\s*[:：])前.{0,8}(睡|上床|休息))/iu;
const EXPLICIT_MORNING_ROUTINE_RE = /(早起|晨型|晨间|早班|清晨.{0,8}(起床|出门|上班|训练)|(?:早上|上午)?(?:六|七|八|6|7|8)点.{0,8}(起床|出门|上班|训练))/iu;
const EXPLICIT_DAY_SLEEP_RE = /(白天睡|上午.{0,8}(睡觉|睡眠|补觉|休息)|中午.{0,8}(入睡|才睡)|傍晚.{0,8}(起床|醒)|昼伏夜出)/iu;
const NIGHT_EVIDENCE_RE = /(凌晨|半夜|深夜|通宵|夜班|值夜|赶夜车|红眼航班|机场|车站|返程|夜间通勤|急诊|演出散场|明确约好.{0,12}(出门|见面))/iu;
const OUTDOOR_ACTIVITY_RE = /(出门|外出|散步|夜跑|逛|探店|酒吧|夜店|便利店|餐厅|咖啡|公园|江边|海边|商场|影院|电影院|开车|骑车|步行去|打车|地铁|公交|路上|返程|赶车|机场|车站)/iu;
const HOME_ACTIVITY_RE = /(在家|家里|卧室|客厅|宿舍|睡|躺|休息|室内|线上)/iu;

function scheduleProfileText(character = {}) {
  const lp = character?.lifeProfile || {};
  return [
    character?.promptCorpus,
    character?.personality,
    character?.currentRole,
    character?.currentStatus,
    character?.notes,
    lp.habits,
    lp.activitySeeds,
    character?.locationProfile?.lifestyle,
    character?.residenceAnchor?.note,
  ].filter(Boolean).join(' ');
}

function blockTouchesEarlyMorning(block = {}) {
  const start = parseTimeRangeStartMinutes(block.timeRange);
  const end = parseTimeRangeEndMinutes(block.timeRange);
  if (start < 0 || end < 0) return false;
  if (end < start) return end > 0 || start < 6 * 60;
  return start < 6 * 60 && end > 0;
}

function blockLooksOutdoor(block = {}) {
  const routeMode = String(block?.routeHint?.mode || '').trim();
  if (['walk', 'bike', 'transit', 'drive'].includes(routeMode)) return true;
  if (['indoor', 'online'].includes(routeMode)) return false;
  const text = [
    block?.anchor,
    block?.placeName,
    block?.activity,
    block?.narrative,
    block?.routeHint?.origin,
    block?.routeHint?.destination,
  ].filter(Boolean).join(' ');
  if (HOME_ACTIVITY_RE.test(text) && !OUTDOOR_ACTIVITY_RE.test(text)) return false;
  return OUTDOOR_ACTIVITY_RE.test(text);
}

function hasGroundedNightEvidence({
  block = {},
  recentChatContext = null,
  recentTravelFacts = null,
  userDirective = '',
} = {}) {
  if (['travel-char', 'location-continuity'].includes(String(block.origin || ''))) return true;
  if ((block.sourceRefs || []).some((ref) => /travel|continuity|offline-invite|night-evidence/i.test(String(ref)))) {
    return true;
  }
  const evidence = [
    userDirective,
    ...(recentChatContext?.keyLines || []),
    ...(recentTravelFacts?.recentTrips || []).map((row) => `${row?.theme || ''} ${row?.title || ''} ${row?.memoryText || ''}`),
    block?.changeReason,
  ].filter(Boolean).join(' ');
  return NIGHT_EVIDENCE_RE.test(evidence);
}

function remapScheduleCityValue(value, aliases, storyCity) {
  if (typeof value === 'string') {
    const storyMarker = '\uE000schedule-story-city\uE001';
    const protectedText = value.split(storyCity).join(storyMarker);
    return aliases
      .reduce((text, alias) => text.split(alias).join(storyCity), protectedText)
      .split(storyMarker).join(storyCity);
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapScheduleCityValue(item, aliases, storyCity));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    remapScheduleCityValue(item, aliases, storyCity),
  ]));
}

function isGroundedTravelScheduleBlock(block = {}) {
  if (String(block?.origin || '') === 'travel-char') return true;
  return (Array.isArray(block?.sourceRefs) ? block.sourceRefs : [])
    .some((ref) => /travel-char|extended-trip/i.test(String(ref || '')));
}

function narrativeCityExceptions({ user = null, recentTravelFacts = null } = {}) {
  const cities = [cleanScheduleCity(user?.virtualCity)];
  for (const trip of (Array.isArray(recentTravelFacts?.recentTrips) ? recentTravelFacts.recentTrips : [])) {
    cities.push(cleanScheduleCity(trip?.city || trip?.destination || trip?.destinationCity));
  }
  return new Set(cities.filter(Boolean));
}

/**
 * 生成后城市边界兜底：现实映射城市可能经 mapPins / 路线状态重新进入模型输出。
 * 普通生活块统一写回故事城市；真正由旅行记录落库的跨城块保持原样。
 */
export function enforceScheduleStoryCityBoundary(patch, {
  character = null,
  user = null,
  recentTravelFacts = null,
} = {}) {
  if (!patch || typeof patch !== 'object') return patch;
  const residence = character?.residenceAnchor && typeof character.residenceAnchor === 'object'
    ? character.residenceAnchor
    : {};
  const { storyCity, dataCity } = resolveCharacterScheduleCities(character);
  const realCityMap = cleanScheduleCity(residence.realCityMap || dataCity);
  if (!storyCity || !realCityMap || storyCity === realCityMap) return patch;

  const cityBase = realCityMap.replace(/(?:特别行政区|自治区|自治州|地区|盟|市)$/u, '').trim();
  const allowedNarrativeCities = narrativeCityExceptions({ user, recentTravelFacts });
  const aliases = [...new Set([
    realCityMap,
    cityBase ? `${cityBase}市` : '',
    cityBase,
  ].filter((item) => item
    && item !== storyCity
    && item.length >= 2
    && !allowedNarrativeCities.has(item)))]
    .sort((a, b) => b.length - a.length);
  if (!aliases.length) return patch;

  const plans = Array.isArray(patch.dailyLifePlans)
    ? patch.dailyLifePlans
    : (patch.dailyLifePlan ? [patch.dailyLifePlan] : []);
  for (const plan of plans) {
    if (!plan || typeof plan !== 'object') continue;
    for (const [key, value] of Object.entries(plan)) {
      if (key === 'blocks') continue;
      plan[key] = remapScheduleCityValue(value, aliases, storyCity);
    }
    if (Array.isArray(plan.blocks)) {
      plan.blocks = plan.blocks.map((block) => (
        isGroundedTravelScheduleBlock(block)
          ? block
          : remapScheduleCityValue(block, aliases, storyCity)
      ));
    }
  }
  if (Array.isArray(patch.notes)) {
    patch.notes = remapScheduleCityValue(patch.notes, aliases, storyCity);
  }
  return patch;
}

/**
 * 生成后深夜后验：只在人设明确写了早睡/严格作息时，阻止 00:00–06:00
 * 无证据外出。没有写作息不是「默认早睡」的证据，不能用健康作息替角色做决定。
 */
export function enforceDeepNightSchedulePosterior(patch, {
  character = null,
  user = null,
  recentChatContext = null,
  recentTravelFacts = null,
  userDirective = '',
} = {}) {
  const plans = Array.isArray(patch?.dailyLifePlans)
    ? patch.dailyLifePlans
    : (patch?.dailyLifePlan ? [patch.dailyLifePlan] : []);
  if (!plans.length) return enforceScheduleStoryCityBoundary(patch, { character, user, recentTravelFacts });
  const profileText = scheduleProfileText(character);
  if (!EXPLICIT_DEEP_NIGHT_REST_RE.test(profileText)
    || NIGHT_SCHEDULE_EXCEPTION_RE.test(profileText)) {
    return enforceScheduleStoryCityBoundary(patch, { character, user, recentTravelFacts });
  }
  const home = character?.residenceAnchor || {};
  const { storyCity } = resolveCharacterScheduleCities(character);
  for (const plan of plans) {
    if (!Array.isArray(plan?.blocks)) continue;
    let changed = false;
    plan.blocks = plan.blocks.map((block, index) => {
      if (!blockTouchesEarlyMorning(block)
        || !blockLooksOutdoor(block)
        || hasGroundedNightEvidence({ block, recentChatContext, recentTravelFacts, userDirective })) {
        return block;
      }
      changed = true;
      return normalizeDailyLifeBlock({
        ...block,
        anchor: home.label || '家',
        placeName: '',
        city: storyCity,
        activity: '留在室内休息',
        narrative: '凌晨没有已知约定、夜班或必要行程，TA 没有临时跑去户外，而是留在室内放慢节奏，等天亮后再接当天安排。',
        busy: false,
        routeHint: {
          origin: home.label || '家',
          destination: home.label || '家',
          mode: 'indoor',
          durationText: '',
          distanceText: '',
          waypoints: [],
        },
        flowSteps: [
          { at: '凌晨', action: '留在室内收尾并休息', placeName: home.label || '家', transit: '室内移动', busy: false },
        ],
        triggerWindows: [],
        sourceRefs: [...new Set([...(block.sourceRefs || []), 'deep-night-schedule-posterior'])],
      }, index);
    }).filter(Boolean);
    if (changed) {
      const first = plan.blocks[0];
      const last = plan.blocks[plan.blocks.length - 1];
      if (first?.sourceRefs?.includes('deep-night-schedule-posterior')) {
        plan.dayStartLocation = { city: storyCity, placeName: home.label || '家', area: home.area || '' };
      }
      if (last?.sourceRefs?.includes('deep-night-schedule-posterior')) {
        plan.dayEndLocation = { city: storyCity, placeName: home.label || '家', area: home.area || '' };
      }
    }
  }
  return enforceScheduleStoryCityBoundary(patch, { character, user, recentTravelFacts });
}

/**
 * 类目骰子：从兴趣频道 + 常识词汇池里选一个「今天可以试试的不一样」，50% 概率产出，
 * 不是每天都塞——优先 hobby 存档里的 nextGoals（角色自己惦记的下一步），没有才退到
 * taste pool 里的具体店/单品；最近吃腻的类目（repeatWarning）不会被选中。
 */
export function rollDailyFreshSeed(interestEntries = [], tastePool = null, recentSummary = null) {
  const repeatLabels = new Set(recentSummary?.repeatWarning || []);
  const hobbySeeds = (Array.isArray(interestEntries) ? interestEntries : [])
    .filter((e) => e.channel === 'hobby' && e.progress?.nextGoals?.length)
    .map((e) => `试试${e.progress.nextGoals[e.progress.nextGoals.length - 1]}`);
  const stapleSeeds = Object.entries(tastePool?.categories || {})
    .filter(([cat]) => !repeatLabels.has(cat))
    .flatMap(([, val]) => (Array.isArray(val?.items) ? val.items : []).slice(-2).map((it) => `去试试${it.name}`));
  const candidates = hobbySeeds.length ? hobbySeeds : stapleSeeds;
  if (!candidates.length || Math.random() >= 0.5) return '';
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * 事件后置定向搜索（日程主轴调整 Phase 2c）：生成拿到 blocks 后，对 AI 标出的
 * searchTopic（具体电影名/书名/事件名）挨个真搜一轮，压缩成一句角色自己的具体感想/事实，
 * 写回 block.eventNote——聊天时能引用"刚查完的具体信息"，而不是空泛地说"我看了个电影"。
 * dailyLimit=0 时直接跳过；超出上限的 searchTopic 直接丢弃，不会攒到下一天。
 */
async function distillEventSearchToNote({ topic, activity, rows, characterName, signal }) {
  if (!rows.length) return '';
  const payload = {
    task: 'distill_schedule_event_search_to_note',
    topic,
    relatedActivity: activity,
    characterName,
    searchResults: rows,
    rules: [
      `以上是关于「${topic}」的真实搜索结果。用 ${characterName} 自己的语气压缩成一句 80 字以内的具体感想或事实要点（比如影评要点+自己的看法、书本身的进展信息），要像 TA 真的查过、有点态度，不要写成客观百科介绍。`,
      '只输出这一句话本身，不要引号、不要解释、不要 JSON、不要前缀。',
    ],
  };
  const raw = await chatForTask([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.6, signal }, 'searchRefine').catch(() => '');
  return String(raw || '').replace(/^["'「]|["'」]$/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function enrichBlocksWithEventSearch(blocks, {
  userId, characterId, character, dailyLimit = 0, signal = null,
} = {}) {
  if (!dailyLimit || !Array.isArray(blocks) || !blocks.length) return blocks;
  const targets = blocks.filter((b) => b?.searchTopic).slice(0, dailyLimit);
  if (!targets.length) return blocks;
  const webCfg = await loadWebSearchConfig().catch(() => null);
  if (!webCfg?.enabled) return blocks;
  const characterName = getCharacterAiContextName(character) || character?.name || 'TA';
  for (const block of targets) {
    if (signal?.aborted) break;
    try {
      const result = await runWebSearch(block.searchTopic, {
        category: 'schedule_event_search', maxResults: 5, searchDepth: 'basic', config: webCfg, characterId, freshness: 'month',
      }).catch(() => null);
      if (!result?.results?.length) continue;
      const rows = result.results.slice(0, 4).map((r) => ({
        title: String(r.title || '').slice(0, 80),
        content: String(r.content || '').slice(0, 220),
      }));
      const note = await distillEventSearchToNote({
        topic: block.searchTopic, activity: block.activity, rows, characterName, signal,
      }).catch(() => '');
      if (note) block.eventNote = note;
    } catch (_) {
      // 单条搜索失败不影响其它 block，也不影响整个日程生成结果
    }
  }
  return blocks;
}

function compactPhoneForPrompt(phone, { dateKey, excludeDateKey, character = null } = {}) {
  const plans = resolvedPhonePlans(phone)
    .filter((p) => {
      const dk = String(p?.dateKey || '');
      if (excludeDateKey && dk === excludeDateKey) return false;
      return dk && dk !== dateKey;
    })
    .slice(-7)
    .map(summarizePlanTail);
  const lastPlan = plans.filter(Boolean).slice(-1)[0] || null;
  // home 锚点兜底：首次生成（没有任何历史 dailyLifePlan）或历史都已过期清空时，
  // lastKnownLocation 本来会是 null，AI 就没有「从哪出发」的依据，容易空间瞬移。
  // getBaseLocationAnchor 对应 evergreen 的 home 锚点，不受任何过期规则约束，
  // 兜底保证「当前位置不明」时永远有一个可回退的起点（life-location-memory-plan.md §2.6）。
  const homeAnchor = character ? getBaseLocationAnchor(normalizeLocationProfile(character)) : null;
  const homeBaseAnchor = homeAnchor ? {
    label: describeLocationAnchor(homeAnchor) || homeAnchor.label || '家',
    area: homeAnchor.area || '',
  } : null;
  return {
    recentPlans: plans,
    lastKnownLocation: lastPlan?.endLocation || lastPlan?.lastBlock || null,
    homeBaseAnchor,
    noteCount: (phone?.notes || []).filter((n) => !n.completed).length,
    preferences: phone?.preferences || {},
    currentMapState: phone?.currentMapState || null,
    routeState: phone?.routeState || null,
    // 高 visitCount（程序化累计的曝光次数，不是模型猜的）排到后面，
    // 让「还没怎么去过」的地点更容易被 AI 挑中，降低同一批地点反复出现的概率。
    mapPins: (phone?.mapPins || [])
      .filter((pin) => pin?.relationStatus !== 'candidate' && pin?.visibility !== 'candidate')
      .slice()
      .sort((a, b) => (Number(a.visitCount) || 0) - (Number(b.visitCount) || 0))
      .slice(0, 12)
      .map((pin) => ({
        placeName: pin.placeName,
        city: pin.city,
        district: pin.district,
        address: pin.address,
        bucketLabel: pin.bucketLabel,
        sourceQuery: pin.sourceQuery,
        anchorName: pin.anchorName,
        rating: pin.rating,
        cost: pin.cost,
        distance: pin.distance,
        relationStatus: pin.relationStatus,
        visitVerdict: pin.visitVerdict,
        temporalState: pin.temporalState,
        visitCount: Number(pin.visitCount) || 0,
      })),
    mapCandidates: (phone?.mapPins || [])
      .filter((pin) => pin?.relationStatus === 'candidate' || pin?.visibility === 'candidate')
      .slice(0, 12)
      .map((pin) => ({
        placeName: pin.placeName,
        city: pin.city,
        district: pin.district,
        address: pin.address,
        location: pin.location,
        bucketLabel: pin.bucketLabel,
        sourceQuery: pin.sourceQuery,
        rating: pin.rating,
        cost: pin.cost,
        distance: pin.distance,
      })),
    mapItineraries: (phone?.mapItineraries || []).slice(0, 4).map((item) => ({
      title: item.title,
      city: item.city,
      anchorName: item.anchorName,
      theme: item.theme,
      summary: item.summary,
      routeSummary: item.routeSummary,
      stops: (item.stops || []).slice(0, 6).map((stop) => ({
        order: stop.order,
        placeName: stop.placeName,
        address: stop.address,
        city: stop.city,
        district: stop.district,
        bucketLabel: stop.bucketLabel,
        rating: stop.rating,
        cost: stop.cost,
        distance: stop.distance,
        visitHint: stop.visitHint,
      })),
    })),
    lifeIntents: (phone?.lifeIntents || []).slice(0, 8).map((intent) => ({
      kind: intent.kind,
      query: intent.query,
      action: intent.action,
      city: intent.city,
      anchor: intent.anchor,
      reason: intent.reason,
      updatedAt: intent.updatedAt,
    })),
  };
}

const DAILY_SYSTEM = `你是「角色生活骨架」生成器。只输出一个合法 JSON 对象，不要 Markdown，不要解释。
目标：为指定角色生成 today 的 dailyLifePlan——表示 TA 在 user 不在场时也真实存在的一天。
普通聊天不是主任务；这是后台生活流，供后续按时间切片读取。

写法：
- 【最高约束：完整人物资料】必须先通读 payload.character 的全部字段，尤其 promptCorpus（用户粘贴的整段设定）、personality、currentRole/currentStatus、userRelationStatus、relationships、speechCorpus、lifeProfile、residenceAnchor/locationProfile。人物身份、职业、身体条件、长期关系、明确禁忌、固定习惯与作息都是不可违反的硬约束；不能因通用常识、模板化生活、用户主题、新闻、兴趣或防重复要求而改写。结构化字段是对整段设定的补充，不是替代；不得因为某项同时出现在 promptCorpus 与结构化字段里就忽略其中一边。currentStatus 是角色卡中的状态快照，不是永不过期的实时活动：当它描述“正在上课/上班/出门/忙某件事”等临时状态，必须与 payload.temporalContext、带日期的 recentMemoryContext、近期聊天时间戳和目标 dateKey 一起仲裁；较新的明确事实可以结束或更新它，但不能擅自推翻稳定人设。
- 【时间与日期优先】必须先读 payload.temporalContext、dateKey、nowLabel。它们决定世界内当前日期、星期、时段与已开启的节假日语境；聊天中已经确认的寒暑假、放假、开学、调休等事实也必须从 recentMemoryContext / recentChatContext 接续。不得因为角色卡仍写“学生/上班族”就无视假期，机械生成上课、打卡或通勤。
- 【记忆连续性】必须读 payload.recentMemoryContext。带日期且较新的明确生活事实优先于旧的临时 currentStatus；旧记忆只作过去背景。稳定身份、性格、关系和长期习惯不会因时间流逝自动失效。
- 【常驻地不等于当前位置】必须先读 payload.locationContext。character.homeCity / storyCity / residenceAnchor.city 只表示角色常驻地，user.homeCity 是用户自己的常驻地，二者绝不能合并成双方共享城市。用户直接指定、角色 currentStatus/promptCorpus、近期聊天中的明确到达/在途事实、offlineArchiveState（约会卷宗结束后仍持续的状态）、已接受或已完成邀约、recentTravelFacts、已有日程起终点都可以证明临时跨城，并优先于 homeCity；角色去用户所在城市时只移动角色，不得把用户反向搬到角色常驻城市。offlineArchiveState 若写明多人暂住、同住或同行，日程必须从同一住处/地点续接，不能按各自常驻地拆开。没有明确返程/到达事实时，不得因刷新或重生成让角色自动回 homeCity。
- 【现实映射边界】weatherContext 以及 phoneSnapshot 的 mapPins、mapItineraries、currentMapState、routeState 中出现的 realCityMap、天气城市和现实地址只用于查天气、路线与真实 POI，不能单独证明任何人的叙事当前位置，也不能覆盖 locationContext 中的叙事地点。
- 如果 payload 里有 userThemeRequest：这是本次生成最高优先级的事件主线，但仍低于上述人物资料硬约束。今天必须让它以符合 TA 身份、能力、关系和作息的方式自然发生；若字面要求与硬设定冲突，保留主题意图并改写成 TA 实际会采用的做法。其它素材（兴趣/口味池/todayFreshSeed/newsContext）只做点缀，不要跟它抢主线，也不要因为凑齐早中晚而把主线挤成一句话带过。
- 如果 payload.previousDayChatContext 存在，只能使用其中 commitmentCandidates：它们已由本地规则确认是双方说定、明确承诺、改期/取消或已接受的邀约。先按 messageDateKey / targetDateKey 解析相对日期，再把目标日事项落进 blocks；除此之外的聊天行、单方提议、设想和问句都不能证明用户会到场。
- 【用户不默认在场】dailyLifePlan 描述的是 TA 自己的一天。除非 userThemeRequest 明确要求用户线下参与，或 previousDayChatContext.commitmentCandidates / recentChatContext.verifiedCommitments 中有已经核验的约定，否则不得编造和用户见面、约会、接送、一起吃饭/逛街/旅行、用户突然来访或任何线下同行。普通聊天只能影响口吻与背景，不能推导用户到场。
- 如果 payload.rerollAvoidPlan 存在，它是用户刚刚否掉的旧稿，只是负例，不是已经发生的历史事实。新稿必须更换主要事件结构、活动地点、叙事因果和关键流程，不能只换措辞、时段或无关小细节后把同一剧情再写一遍；已锁定的真实线下/旅行块不会出现在该负例中。
- 如果 payload 里有 newsContext（且没有 userThemeRequest）：这是第二优先级的事件来源，地位在兴趣/口味池之上——先看 newsContext.general（大众热点：电影上映/热门事件/热搜）和 newsContext.private（这个角色本人关注方向的最新动态），结合人设挑最多 1~2 条角色真的会关心、贴合人设的事件，具体化成今天的一段主线（比如"最近上映的《XX》，晚上找空档去看""关注的连载有新章节，蹭空刷了一下"），可以拆成相邻 blocks（决定/去做/过程/回味）；不贴合人设的条目直接不用，不必强凑。此时兴趣表/口味池/todayFreshSeed 退居装饰性细节，不再是决定今天做什么的主要来源。如果某条 newsContext 内容跟 phoneSnapshot.recentPlans 里近期活动明显是同一件事，换一条或跳过，不要反复围着同一件事写。没有 newsContext 或用户没开启这个功能时，退回下面「兴趣/口味池驱动」的默认写法。
- newsContext 驱动的事件里，如果角色会想去查证具体细节（一部电影的影评、一本书的最新进展、一个事件的后续），在对应 block 上写一个 searchTopic 字段（具体到能直接拿去搜索引擎搜的词，如"《电影名》 影评"或"书名 最新章节"），系统会在生成后真搜一次并把结果压缩回这个 block；不确定要不要查、或者随口聊聊不需要查证的事件，不要写 searchTopic。每天最多 2~3 个 block 带 searchTopic，不要每个事件都要查。
- 【事件因果骨架】日程已有的时间、地点、工作/行程、关系、兴趣、天气、地图与近期事实不是并列素材清单。生成一段有意义的生活片段时，沿着「这个时间和地点原本在做什么 → 哪个具体来源或小变化触发了反应 → 人物经历与当下情绪让 TA 怎样理解 → 因此作出什么选择、妥协或小动作 → 对后续计划、身边关系或自己留下什么影响」自然串起来。narrative 至少让这条因果可辨认，不要只报告活动名称。
- 来源可以很普通：家人寄来的东西、工作临时要求、队友或同事的一句话、路过某处、天气变化、正在追的内容更新、旧习惯突然被勾起。只使用人物资料、已有关系与输入素材能支持的来源；不要为了制造故事临时发明固定亲友、重大过去或用户参与。
- 环境、品牌、食物、店铺与物件只有在它改变选择、暴露偏好、牵出人物经历/关系、形成现实限制或留下后续线头时才值得写。没有这种作用就删掉；tastePool、地图和真实搜索给出的具体名词可以使用，但不得拿未经提供或查证的品牌细节冒充真实生活。
- 反差不是随机的新奇动作。角色偶尔做平常不会做的事，必须有贴近当下的诱因，并能连接 TA 一贯的欲望、压力、价值或关系；反差用来露出人物较少被看见但仍相容的一面，不把通用“强者心软、冷脸救小动物、笨拙做饭”当成自动剧情。
- 情绪先从角色自身生长：前一件事的余波、身体与精力、工作压力、期待、乡愁、羞耻、好胜或松弛会改变 TA 注意到什么、怎样选择。dailyLifePlan 不需要先猜 user 的情绪，也不以讨好 user 为事件目的。
- shareCandidates 只放 TA 此刻真可能选择告诉 user 的部分；有意义不等于一定分享。没有说出口但会增加人物厚度的感受、顾虑与关系含义放进 privateThoughts；会改变稍后选择、还没解决或可能再次触发的东西放进 openLoops。不要让三处同义复述。
- 普通日常不必每段都有戏剧、秘密或反转。例行活动中一个有因果的微小选择就足够；一整天最多让少数片段成为主线，其余保留重复、留白和无事发生的质地。
- blocks 的时段相位必须先读人设作息，再铺一天：不要默认「早起→白天活动→夜里睡觉」。普通日作息可以覆盖早/中/晚/夜；但若性格、lifeProfile.habits、notes、currentStatus 写明昼伏夜出 / 夜行动物 / 白天睡觉 / 傍晚才起（例如约 11:00–17:00 睡、17:00 后才醒、夜里才是主活动），则这一天的骨架必须跟着那份钟点走——傍晚起床、夜里办事、凌晨收工、上午入睡都可以，禁止再捏出「凌晨两点入睡、早上九点起床」这种半吊子夜猫版。
- 一天绝不能在人设活跃时段的半截就断掉；最后一段只表示本次日程写到的最后一个有意义活动，不承担「必须闭环」的功能。它可以是仍在忙、玩、发呆、临时起意或跨过零点，不必用回家、洗漱、关灯、睡觉给一天收口。只有人物资料或当天事实确实支持时才写就寝；不要把“明天还有事”“时间不早了”“一般人该睡了”当证据。
- 睡眠不是必填项：有就标 isSleep，没有也可以。人设里的睡眠钟点（几点睡、几点起）优先于一切「一般晚上睡觉」的常识；禁止把白天睡眠改写成夜间短憩。
- 人物资料没有明确写作息时，「规律、健康、按时、早睡早起」都不是中性默认值。先从职业、性格、自控力、社交方式、近期状态和已经发生的事推断 TA 当天会怎样过；仍无依据就让时间表保持松动、允许留白，宁可不写睡眠，也不要替 TA 养成好习惯。拖延、贪玩、沉迷、夜生活、临时兴起或毫无效率的一段，只要符合这个人，都比模板化作息更可信。
- 可按人设和最近聊天安排跨午夜块（如 23:40-02:10、00:00-04:00）；若最近半夜和 user 聊过、睡不着、赶稿、夜班、游戏、旅行返程，要体现熬夜/补觉/第二天精神影响。
- 每段必须补 flowSteps：2~5 个具体流程点，表达「准备/路上/到达/停留/收尾」这类动作链；室内活动也要写细小流程，不要只写“待着”。
- 如果某个 flowStep 确实会让 interestChannels 中带 progress 的兴趣往前走，在该步骤附带 interestProgress：entryId 必须原样使用兴趣条目的 id；stage 写这个步骤发生后的阶段；只有该步骤到点时确实完成了 nextGoals 中某一条，completedGoal 才能原样填写；newGoal / humanMoment 可空。未来计划不会在生成时提前写回，系统只会在角色当地时间真正走到该步骤后应用。
- 外出段尽量补 routeHint：origin/destination/mode/durationText/waypoints；不知道真实路程时写自然估算，不要伪造精确公里数。
- triggerWindows 是可主动分享的小窗口，0~2 个即可，必须来自 flowSteps 或 narrative，不要为了凑数硬写。
- 严禁空间瞬移：必须参考 phoneSnapshot.recentPlans / lastKnownLocation。若上一天结束在外地/旅途中，今天必须从那里开始，或写出返程/换乘/休息过渡；不能让 TA 昨晚在北京旅游，第二天清晨无说明回到上海日常。lastKnownLocation 为空（没有历史日程可参考，通常是首次生成）时，第一段默认从 phoneSnapshot.homeBaseAnchor（TA 的家/常驻锚点）出发，不要凭空捏造一个陌生起点。
- 如果要跨城市，必须有 travel/routeHint/flowSteps 表达交通过程和时间消耗；短时段内不要跨越不合理距离。
- 必须参考 weatherContext：下雨/高温/降温/大风会影响出门意愿、交通方式、衣物、停留地点；不要把坏天气写成晴朗逛街，也不要把天气夸张成灾难。
- 必须参考 recentChatContext：近期聊天里刚去过、刚抱怨过、正在路上的事实可以影响背景；只有 verifiedCommitments 能证明用户线下参与。这些事实可以造成临时熬夜、改班、出行等变化，但不能无解释地推翻人物资料中的身份、能力和长期习惯。避免重复生成相同吃喝/便利店/饭团套路。
- 必须参考 recentTravelFacts：近期已完成的旅行 char / 外出事件是「已发生」事实，不要当作未来计划重写，不要改同行人员或地点组合。
- 必须参考 phoneSnapshot.recentPlans 里的 notableBlocks / doneTravelBlocks：status=done 或 origin=travel-char 的时段只能当历史，不能复活成新安排；带 repeatFlag 的条目是系统已确认命中重复的类目（不是猜测），今天必须换成不同的类目或明显不同的细节，不能再原样重复。
- 必须参考 phoneSnapshot.recentPlans 里每天的 activityBrief（近 7 天活动摘要）：除了通勤/上班/固定作息这类本该重复的日常，不要让今天的活动+地点组合跟最近几天高度雷同（例如连续多天都写"去同一家咖啡馆"或"和同一批人吃饭"），保持内容新鲜；如果角色人设本来就是规律生活，允许保留主干但至少换一些细节。
- 必须参考 phoneSnapshot.mapPins/mapCandidates/mapItineraries/currentMapState/routeState：mapCandidates 是高德刚返回、尚未筛选的真实地点素材，不是角色去过或已经计划的事实。角色若确实需要外出，必须结合人物、时间、天气、距离和近期重复度自主选择最合适的一处，并把候选的 placeName 原样写入对应 block；写入日程即代表 TA 作出了真实计划。不要为了使用候选而强行出门，也不要一次把多家候选都塞进日程。mapPins 才是已经作出判断的地点：temporalState=completed（visited/revisit/avoid）表示已有经历，avoid 不要再推荐；visited 不要当新鲜发现反复去，除非是 revisit。temporalState=planned（want_to_go/maybe/unvisited）适合成为今天第一次前往的选择。mapPins 已按 visitCount 从低到高排列，固定通勤以外优先避免近期反复出现的同店同活动。
- 如果 mapItineraries 里有具体 stops，外出/旅行/探店日程要更像攻略行程：拆成相邻 blocks（准备/路上/首站/附近吃喝或停留/收尾），每个 block 只放一个当前目标，不要把多个目的地挤进一个 placeName。
- 可从 narrative 提取 environment / choices / shareCandidates 作为短标签；不要用标签反推 narrative。
- busy:true 表示该时段「在忙、不宜打扰」（后续用于自动回复，本刀仅标记）。
- isSleep:true 只标在真正睡着的那一段（从入睡到醒来），跟 busy 是两件事——上班/开会/摸鱼/熬夜办事都不是 isSleep，只有睡眠才是。睡眠可以落在夜里，也可以落在白天（倒作息常见）；一天通常 0～1 段，用于让「分享冲动」知道何时必须安静。若人设写明白天睡、夜里醒，isSleep 必须落在人设给出的睡眠窗附近，不要挪到凌晨。若这天按人设收尾时尚未入睡，可以没有 isSleep:true。
- 室内活动（看书、游戏、休息）不要强行写成出门；只有明确外出才写 placeName/city。
- 去神格化：日常要有普通人的笨拙、偏食、拖延等凡人细节。
- 不要伤痛文学，不要总结腔。
- 日程是这一天的骨架，不是每分钟的剧本：块与块之间允许留白和松动；privateThoughts / openLoops 里可以埋一两个「突然想起某事」「临时起意想去某处」的引子，供聊天时自然岔出去。
- interestChannels 里带存档的兴趣（hobby/follow/shopping）写进日程时必须与存档一致：玩到哪、追到哪、买没买，以 progress 为准，不要重置或跳跃。
- interestChannels 里带 backstory 的兴趣，写进日程时投入程度和语气要贴着这层关系：backstory 说刚入坑就写摸索/尝鲜的活动，说是多年老粉就可以写深度参与，不要所有兴趣一律同一个热情浓度。
- 写吃喝玩乐尽量用 tastePool 里的具体店名和单品，没有合适条目才写泛称；具体永远比泛称像真的生活。
- recentActivitySummary 是最近几天的高频活动统计，repeatWarning 里的类目今天避开「同店同活动」的完全重复——除非那是 TA 的固定规律（通勤、健身房、固定兴趣班可以重复，但写法要有当天的差异细节）。
- todayFreshSeed（若有）是「今天想做点不一样的」种子：可采纳可忽略，采纳时自然融进某个 block，不要硬凑。

必须同时输出结构化附属字段（全部放进 JSON，不要藏在正文里让程序去抠）：
- notes: 0~3 条备忘录，每条 { "title":"可选", "text":"...", "tags":["memo"] }

JSON 格式：
{
  "dailyLifePlan": {
    "dateKey": "YYYY-MM-DD",
    "dayType": "workday|rest|busy|travel|mixed",
    "dayTheme": "...",
    "mood": "...",
    "dayStartLocation": {"city":"可空","placeName":"可空","area":"可空"},
    "dayEndLocation": {"city":"可空","placeName":"可空","area":"可空"},
    "openLoops": ["..."],
    "privateThoughts": ["..."],
    "blocks": [
      {
        "timeRange": "09:00-10:30",
        "anchor": "家/路上/工作场所",
        "placeName": "可空",
        "city": "可空",
        "activity": "一句话",
        "narrative": "生活片段正文",
        "busy": false,
        "isSleep": false,
        "mood": "...",
        "environment": ["..."],
        "choices": ["..."],
        "shareCandidates": ["..."],
        "searchTopic": "可空，值得生成后真搜查证的具体词（电影名/书名/事件名+想查的角度）",
        "routeHint": {
          "origin": "可空",
          "destination": "可空",
          "mode": "walk|bike|transit|drive|indoor|online|unknown",
          "durationText": "可空",
          "distanceText": "可空",
          "waypoints": [{"label":"可空","kind":"origin|via|destination","location":null}]
        },
        "flowSteps": [
          {
            "at": "09:10",
            "offsetMinutes": 10,
            "action": "具体动作",
            "placeName": "可空",
            "transit": "步行/地铁/室内移动/可空",
            "mood": "可空",
            "shareCandidate": "可发给用户的一小句素材，可空",
            "checkpoint": false,
            "busy": false,
            "interestProgress": {
              "entryId": "可空；必须原样来自 interestChannels.id",
              "stage": "可空；该步骤发生后的兴趣阶段",
              "completedGoal": "可空；确实完成时原样填写 nextGoals 中的一条",
              "newGoal": "可空；下一步具体目标",
              "humanMoment": "可空；一句真实小情绪"
            }
          }
        ],
        "triggerWindows": [
          {
            "at": "09:25",
            "sourceStepId": "可空",
            "reason": "为什么这时可能想发消息",
            "shareHint": "短分享素材"
          }
        ],
        "status": "planned"
      }
    ]
  },
  "notes": [{"title":"","text":"","tags":["memo"]}]
}`;

const WEEKLY_SYSTEM = `你是「角色一周生活骨架」生成器。只输出一个 JSON 对象，不要 Markdown。
目标：从 startDateKey 起连续 7 天，每天一个轻量 dailyLifePlan（每 day 3~5 个 blocks，写粗不写细）。
不要生成备忘录（notes 留空数组）。
最高约束：先通读 payload.character 的全部人物资料，尤其 promptCorpus、身份/状态、关系、personality、speechCorpus、lifeProfile、residenceAnchor/locationProfile。七天安排必须从这个具体人物的职业、能力、关系、习惯和作息生长出来；人物资料是硬约束，普通人的朝九晚五、早睡早起、周末出游等常识模板不能覆盖它。结构化字段只补充整段设定，不得替代或忽略 promptCorpus。
时间与记忆：必须先读 payload.temporalContext、weekDates、recentMemoryContext 与 recentChatContext。世界内日期、假期/学期、较新的明确生活事实可以结束角色卡中已经过时的临时 currentStatus；稳定身份、性格、关系和长期习惯仍是硬约束。不得在已经确认的寒暑假/放假期间机械安排上课、打卡或普通通勤，也不得把跨日前聊天里的“正在/马上”冻结七天。
地点边界：必须先读 payload.locationContext。角色 homeCity 与用户 homeCity 是两个人各自的常驻地，不是共享当前位置；角色已在外地时必须从外地续排，只有明确返程后才回角色 homeCity。地图钉、路线状态、天气数据中的 realCityMap 和现实城市只用于查询，不能覆盖叙事地点。
作息必须按人设铺开，不要默认「早起→白天活动→夜里睡觉」。明确昼伏夜出、夜班、傍晚起床、白天睡眠或跨午夜活动时，每一天都要保持对应相位；睡眠不是必填，也不准为了凑早中晚硬塞健康作息。人物资料未写作息时，规律、健康、准点睡都不是中性默认值，应从职业、性格、自控力、社交方式与近期状态推断；仍无依据就保留留白，不要替 TA 养成好习惯。近期事实可造成有解释的临时变化，但不得悄悄改写稳定人设。
时间覆盖要求：每天从这个人物当天自然的生活起点铺到最后一个有意义活动；晚起、上午留白、醒着跨过零点都可以，只要符合人物。最后一段不必用回家、洗漱或睡觉收口。只有资料明确支持晨间活动或白天睡眠时才需要写对应上午 block，不能为了表格完整倒推一段不存在的睡眠或起居。timeRange 必须写明确的 24 小时制起止时间（如 09:00-12:00），不能只写「上午」「下午」。
硬约束：一周内地点必须连续。跨城市必须安排 travel block；如果某天结束在外地，下一天要从外地开始或写清楚返程，禁止瞬移回 homeCity。
必须参考 recentTravelFacts：近期已完成的旅行/外出是已发生事实，不要当作未来计划重写。
七天的主要事件、地点组合和叙事因果必须彼此不同；上班、通勤、睡眠等固定骨架可以重复，但不能连续几天换几个词就复写同一段特殊剧情。
周计划描述 TA 自己的生活，payload 没有提供已核验的用户线下约定；不得编造和用户见面、约会、接送、一起吃饭/逛街/旅行、用户突然来访或任何线下同行。

JSON 格式：
{
  "dailyLifePlans": [
    {
      "dateKey": "YYYY-MM-DD",
      "dayType": "workday|rest|busy|travel|mixed",
      "dayTheme": "...",
      "mood": "...",
      "dayStartLocation": {"city":"可空","placeName":"可空","area":"可空"},
      "dayEndLocation": {"city":"可空","placeName":"可空","area":"可空"},
      "blocks": [
        { "timeRange": "...", "activity": "...", "narrative": "80~160字", "busy": false, "isSleep": false }
      ]
    }
  ]
}`;

const CHANGE_SYSTEM = `你是「角色当前行程事实校准器」。只输出一个合法 JSON 对象，不要 Markdown，不要解释。
目标：核对当前时段是否被已经发生的新事实推翻；没有充分事实就保持原计划，禁止为了新鲜感硬改。

要求：
- 最高约束是 payload.character 的完整人物资料，尤其 promptCorpus、身份/状态、关系、personality、speechCorpus、lifeProfile 与作息。改行程只能改「今天怎么做」，不能把 TA 改成另一个人，也不能把昼伏夜出、夜班、身体限制等硬设定改成普通作息。
- 地点校准必须先读 payload.locationContext 和 currentPlan 的起终点、city、routeHint。角色 homeCity 与用户 homeCity 是各自常驻地，不是共享当前位置；用户直接说明、角色 currentStatus/promptCorpus、近期聊天中的明确到达/在途事实、已接受或已完成邀约、recentTravelFacts、现有日程都可以证明临时跨城。角色来用户所在城市时只移动角色，不能把用户反向写到角色 homeCity；没有明确返程时不得自动回家。weatherContext、地图钉和 realCityMap 只供查询。
- decision 默认 keep。只有 payload.reasonHint、weatherContext、recentChatContext、recentTravelFacts 中存在具体且足以影响当前时段的新事实，才能 decision=change。
- 不得凭空编造“朋友突然消息、店铺关门、临时不舒服、忽然想去某处”等触发。人物性格、心情和“想换换口味”只能影响怎么应对，不能单独作为改期证据。
- evidenceSources 只能填写实际使用的 reason|weather|recent_chat|travel；evidence 必须简述 payload 中可以逐项核对的原始事实。
- decision=keep 时 newBlock 必须为 null；decision=change 时才输出完整 newBlock。
- 改动要合理、具体、生活化；不要戏剧化大事件。
- 参考 weatherContext：天气差时更可能改成室内/近处/延后；天气好时可以顺路外出，但不要为了天气硬改。
- 不得把 recentTravelFacts 里已发生过的旅行/外出改写成新的未来安排，也不得改动当时的同行人员。
- newBlock 默认继承 targetBlock.timeRange；只有理由明确需要顺延或提前时才改时间。
- activity / narrative 必须和原时段有肉眼可辨的差别（换地点、换事、换节奏都行），不要只改一两个无关紧要的词。
- newBlock 必须包含 narrative、flowSteps、triggerWindows；字段结构与 dailyLifePlan.blocks 相同。
- 如果原时段 busy=true，新时段也要根据活动合理决定 busy；isSleep 同理，只有真的改成睡眠时段才标 true。

JSON 格式：
{
  "decision": "keep|change",
  "evidenceSources": ["recent_chat"],
  "evidence": "导致保留或改变的具体已知事实",
  "changeReason": "TA 为什么临时改了安排",
  "newBlock": {
    "timeRange": "09:00-10:30",
    "anchor": "家/路上/工作场所",
    "placeName": "可空",
    "city": "可空",
    "activity": "一句话",
    "narrative": "120~260 字生活片段正文",
    "busy": false,
    "isSleep": false,
    "mood": "...",
    "environment": ["..."],
    "choices": ["..."],
    "shareCandidates": ["..."],
    "routeHint": {
      "origin": "可空",
      "destination": "可空",
      "mode": "walk|bike|transit|drive|indoor|online|unknown",
      "durationText": "可空",
      "distanceText": "可空",
      "waypoints": [{"label":"可空","kind":"origin|via|destination","location":null}]
    },
    "flowSteps": [
      { "at": "09:10", "offsetMinutes": 10, "action": "具体动作", "placeName": "可空", "transit": "可空", "shareCandidate": "可空", "checkpoint": false, "busy": false }
    ],
    "triggerWindows": [
      { "at": "09:25", "reason": "为什么这时可能想发消息", "shareHint": "短分享素材" }
    ],
    "status": "planned"
  }
}`;

function buildDailyUserPayload({
  user, character, phone, dateKey, nowLabel, force, weatherContext = null,
  temporalContext = '', recentChatContext = null, recentMemoryContext = null,
  recentTravelFacts = null, interestChannels = [],
  offlineArchiveState = null,
  tastePool = null, recentActivitySummary = null, todayFreshSeed = '', userDirective = '',
  newsContext = null, languagePolicy = null,
}) {
  const followLang = languagePolicy?.mode === SCHEDULE_LANGUAGE_FOLLOW_CHARACTER;
  const previousDayChatContext = recentChatContext?.previousDay || null;
  const recentChatContextWithoutPreviousDay = recentChatContext
    ? { ...recentChatContext, previousDay: undefined }
    : null;
  return JSON.stringify({
    user: { id: user?.id, name: getUserDisplayName(user) },
    character: buildCharacterBrief(character, { includeTranslationProfile: followLang }),
    locationContext: buildScheduleLocationContext({
      user,
      character,
      userDirective,
      recentChatContext,
      recentTravelFacts,
      offlineArchiveState,
    }),
    dateKey,
    nowLabel,
    temporalContext: temporalContext || null,
    weatherContext,
    previousDayChatContext,
    recentChatContext: recentChatContextWithoutPreviousDay,
    recentMemoryContext,
    recentTravelFacts,
    offlineArchiveState,
    languagePolicy: languagePolicy
      ? { mode: languagePolicy.mode, translationProfile: languagePolicy.profile || null }
      : { mode: SCHEDULE_LANGUAGE_CHINESE },
    userThemeRequest: userDirective
      ? {
        text: userDirective,
        hint: '这是用户直接指定的今日主题/事件，优先级高于兴趣、口味池等其它素材来源：今天的 blocks 必须让它自然发生（可以拆成准备/过程/收尾等相邻 blocks），但具体怎么发生、心情、细节全部由角色人设自由发挥，不要机械复述这句话，也不要写成用户在下命令。',
      }
      : null,
    newsContext,
    interestChannels: interestChannels.length
      ? {
        list: interestChannels,
        hint: '这是 TA 当下真实关注的兴趣，channel 标了类型（staple 日常/hobby 爱好/shopping 种草/follow 在追/casual 泛兴趣），带 progress 的要按存档接续，不要重置或跳跃。日程里可以自然体现——刷相关内容、逛相关的店/展、跟这个爱好有关的小安排；若某个 flowStep 会实际推进存档，用该条目的 id 写 interestProgress，系统只在步骤真正到点后写回。不是每天都要出现，也不要一天塞好几个兴趣。',
      }
      : null,
    tastePool: tastePool && Object.keys(tastePool.categories || {}).length ? tastePool.categories : null,
    recentActivitySummary,
    todayFreshSeed: todayFreshSeed || undefined,
    phoneSnapshot: compactPhoneForPrompt(phone, { dateKey, excludeDateKey: force ? dateKey : '', character }),
    rerollAvoidPlan: force ? buildRerollAvoidPlan(phone, dateKey) : null,
    reroll: force ? '用户要求重生成今日骨架。rerollAvoidPlan 是被否掉的旧稿，只用于查重；必须换掉主要事件结构、地点、叙事因果和关键流程。' : '',
  }, null, 2);
}

function buildWeeklyUserPayload({
  user, character, phone, startDateKey, weekDates, temporalContext = '',
  recentChatContext = null, recentMemoryContext = null, recentTravelFacts = null,
  offlineArchiveState = null,
  languagePolicy = null,
}) {
  const followLang = languagePolicy?.mode === SCHEDULE_LANGUAGE_FOLLOW_CHARACTER;
  return JSON.stringify({
    user: { id: user?.id, name: getUserDisplayName(user) },
    character: buildCharacterBrief(character, { includeTranslationProfile: followLang }),
    locationContext: buildScheduleLocationContext({ user, character, recentTravelFacts, offlineArchiveState }),
    startDateKey,
    weekDates,
    temporalContext: temporalContext || null,
    recentChatContext,
    recentMemoryContext,
    recentTravelFacts,
    offlineArchiveState,
    languagePolicy: languagePolicy
      ? { mode: languagePolicy.mode, translationProfile: languagePolicy.profile || null }
      : { mode: SCHEDULE_LANGUAGE_CHINESE },
    phoneSnapshot: compactPhoneForPrompt(phone, { character }),
  }, null, 2);
}

function buildChangeUserPayload({
  user, character, plan, block, reason, nowLabel, weatherContext = null, recentTravelFacts = null,
  recentChatContext = null, languagePolicy = null,
}) {
  const followLang = languagePolicy?.mode === SCHEDULE_LANGUAGE_FOLLOW_CHARACTER;
  return JSON.stringify({
    user: { id: user?.id, name: getUserDisplayName(user) },
    character: buildCharacterBrief(character, { includeTranslationProfile: followLang }),
    locationContext: buildScheduleLocationContext({
      user,
      character,
      userDirective: reason,
      recentChatContext,
      recentTravelFacts,
      currentPlan: {
        dateKey: plan?.dateKey || '',
        dayStartLocation: plan?.dayStartLocation || null,
        dayEndLocation: plan?.dayEndLocation || null,
      },
    }),
    nowLabel,
    weatherContext,
    recentTravelFacts,
    recentChatContext,
    languagePolicy: languagePolicy
      ? { mode: languagePolicy.mode, translationProfile: languagePolicy.profile || null }
      : { mode: SCHEDULE_LANGUAGE_CHINESE },
    reasonHint: reason || '',
    currentPlan: {
      dateKey: plan?.dateKey || '',
      dayTheme: plan?.dayTheme || '',
      mood: plan?.mood || '',
      dayStartLocation: plan?.dayStartLocation || null,
      dayEndLocation: plan?.dayEndLocation || null,
      blocks: (plan?.blocks || []).map((item) => ({
        id: item.id,
        timeRange: item.timeRange,
        anchor: item.anchor,
        city: item.city,
        activity: item.activity,
        placeName: item.placeName,
        routeHint: item.routeHint || null,
        busy: item.busy === true,
        status: item.status,
      })),
    },
    targetBlock: block,
  }, null, 2);
}

export function evaluateGroundedScheduleChange(parsed = {}, {
  reason = '',
  weatherContext = null,
  recentChatContext = null,
  recentTravelFacts = null,
} = {}) {
  const decision = String(parsed?.decision || '').trim().toLowerCase();
  const evidenceSources = Array.isArray(parsed?.evidenceSources)
    ? parsed.evidenceSources.map((item) => String(item || '').trim())
    : [];
  const groundedSources = new Set([
    reason ? 'reason' : '',
    weatherContext ? 'weather' : '',
    recentChatContext?.keyLines?.length ? 'recent_chat' : '',
    recentTravelFacts ? 'travel' : '',
  ].filter(Boolean));
  const evidence = String(parsed?.evidence || '').trim();
  return {
    shouldChange: decision === 'change'
      && !!parsed?.newBlock
      && !!evidence
      && evidenceSources.some((source) => groundedSources.has(source)),
    evidence,
    evidenceSources,
  };
}

function normalizeDailyPatch(parsed, { characterId, dateKey, force, now = Date.now() }) {
  if (!parsed || typeof parsed !== 'object') throw new Error('AI 未返回有效 JSON');
  const planRaw = parsed.dailyLifePlan || parsed;
  const plan = normalizeDailyLifePlan(planRaw, { characterId, dateKey, now });
  if (!plan.blocks.length) throw new Error('AI 返回的 dailyLifePlan 缺少 blocks');
  plan.id = force
    ? `daily_${characterId}_${dateKey}_${Date.now()}`
    : (plan.id || `daily_${characterId}_${dateKey}`);
  plan.source = 'dailyLifePlanGenerator';
  plan.generatedAt = now;
  return {
    dateKey,
    dailyLifePlan: plan,
    dailyLifePlans: [plan],
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
  };
}

function normalizeWeeklyPatch(parsed, { characterId, startDateKey, now = Date.now() }) {
  if (!parsed || typeof parsed !== 'object') throw new Error('AI 未返回有效 JSON');
  const rawPlans = Array.isArray(parsed.dailyLifePlans) ? parsed.dailyLifePlans : [];
  if (!rawPlans.length) throw new Error('AI 返回缺少 dailyLifePlans');
  const weekDates = weekDateKeys(startDateKey);
  const plans = rawPlans.slice(0, 7).map((raw, idx) => {
    const dk = String(raw.dateKey || weekDates[idx] || startDateKey).trim();
    const plan = normalizeDailyLifePlan(raw, { characterId, dateKey: dk, now });
    plan.source = 'weeklyLifePlanGenerator';
    plan.generatedAt = now;
    return plan;
  }).filter((p) => p.blocks.length);
  if (!plans.length) throw new Error('周计划 blocks 为空');
  return {
    dateKey: startDateKey,
    dailyLifePlans: plans,
    notes: [],
  };
}

function formatScheduleClock(minutes) {
  const safe = Math.max(0, Math.min(23 * 60 + 59, Math.floor(Number(minutes) || 0)));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * 周生成后验：只在人物资料明确提供晨间习惯或白天睡眠时补上午连续性。
 * 没写作息时保留模型留白，不能把「缺上午块」自动解释成规律起居或补觉。
 */
export function ensureWeeklyMorningCoverage(patch, { character = null } = {}) {
  const plans = Array.isArray(patch?.dailyLifePlans) ? patch.dailyLifePlans : [];
  if (!plans.length) return patch;
  const profileText = scheduleProfileText(character);
  const daySleepSchedule = EXPLICIT_DAY_SLEEP_RE.test(profileText);
  const morningRoutine = EXPLICIT_MORNING_ROUTINE_RE.test(profileText);
  if (!daySleepSchedule && !morningRoutine) return patch;
  const home = character?.residenceAnchor || {};
  const { storyCity } = resolveCharacterScheduleCities(character);
  for (const plan of plans) {
    if (!Array.isArray(plan?.blocks) || !plan.blocks.length) continue;
    const starts = plan.blocks
      .map((block) => parseTimeRangeStartMinutes(block?.timeRange))
      .filter((minutes) => minutes >= 0);
    if (!starts.length) continue;
    const firstStart = Math.min(...starts);
    if (firstStart < 12 * 60) continue;
    const startMinutes = daySleepSchedule ? 6 * 60 : 8 * 60;
    if (firstStart <= startMinutes) continue;
    const activity = daySleepSchedule ? '上午睡眠与休息' : '上午起床与洗漱准备';
    const narrative = daySleepSchedule
      ? 'TA 延续自己的夜间作息，在上午完成收尾并休息，醒来后再自然接上当天后续安排。'
      : 'TA 按自己的日常节奏完成起居、吃点东西并整理当天要做的事，再自然接上后续安排。';
    const morningBlock = normalizeDailyLifeBlock({
      id: `weekly_morning_${plan.dateKey || 'day'}`,
      timeRange: `${formatScheduleClock(startMinutes)}-${formatScheduleClock(firstStart)}`,
      anchor: home.label || '家',
      city: storyCity,
      activity,
      narrative,
      busy: false,
      isSleep: daySleepSchedule,
      routeHint: {
        origin: home.label || '家',
        destination: home.label || '家',
        mode: 'indoor',
        durationText: '',
        distanceText: '',
        waypoints: [],
      },
      status: 'planned',
      origin: 'weekly-coverage',
      updatedBy: 'weekly-coverage',
    }, -1);
    if (morningBlock) plan.blocks = [morningBlock, ...plan.blocks];
  }
  return patch;
}

function locationCity(loc = {}) {
  return String(loc?.city || '').trim();
}

function findPreviousPlan(phone, dateKey) {
  return resolvedPhonePlans(phone)
    .filter((plan) => String(plan?.dateKey || '') && String(plan.dateKey) < String(dateKey))
    .sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)))
    .slice(-1)[0] || null;
}

function firstPlanLocation(plan = {}) {
  const first = Array.isArray(plan.blocks) ? plan.blocks.find(Boolean) : null;
  return plan.dayStartLocation || {
    city: first?.city || '',
    placeName: first?.routeHint?.origin || first?.placeName || first?.anchor || '',
    area: first?.anchor || '',
  };
}

function blockMentionsTravel(block = {}, fromCity = '', toCity = '') {
  const text = [
    block.timeRange,
    block.activity,
    block.narrative,
    block.anchor,
    block.placeName,
    block.city,
    block.routeHint?.origin,
    block.routeHint?.destination,
  ].filter(Boolean).join(' ');
  if (/返程|回去|回到|高铁|火车|飞机|机场|车站|出差|旅行|跨城|航班|赶车/u.test(text)) return true;
  return !!(fromCity && toCity && text.includes(fromCity) && text.includes(toCity));
}

function enforceLocationContinuity(patch, { phone, characterId, dateKey } = {}) {
  const plan = patch?.dailyLifePlan;
  if (!plan?.blocks?.length) return patch;
  const previous = findPreviousPlan(phone, dateKey);
  const prevEnd = previous?.dayEndLocation || null;
  const prevCity = locationCity(prevEnd);
  if (!prevCity) return patch;
  const firstLoc = firstPlanLocation(plan);
  const firstCity = locationCity(firstLoc);
  if (!firstCity || firstCity === prevCity) {
    plan.dayStartLocation = plan.dayStartLocation || prevEnd;
    return patch;
  }
  const firstBlock = plan.blocks[0] || {};
  if (plan.dayType === 'travel' || blockMentionsTravel(firstBlock, prevCity, firstCity)) return patch;
  const travelBlock = normalizeDailyLifeBlock({
    id: `continuity_return_${Date.now().toString(36)}`,
    timeRange: firstBlock.timeRange || '抵达前',
    anchor: '返程路上',
    placeName: prevEnd.placeName || prevCity,
    city: prevCity,
    activity: `从${prevCity}转场到${firstCity}`,
    narrative: `前一天的行程还停在${prevEnd.placeName || prevCity}，TA 没有直接切回日常，而是先把返程这段路走完：收拾随身物、确认交通时间，在路上断断续续处理消息，直到重新回到${firstCity}的生活节奏里。`,
    busy: true,
    mood: plan.mood || '',
    routeHint: {
      origin: prevEnd.placeName || prevCity,
      destination: firstLoc.placeName || firstCity,
      mode: 'transit',
      durationText: '跨城转场，按当天交通自然消耗时间',
      waypoints: [
        { label: prevEnd.placeName || prevCity, kind: 'origin', location: null },
        { label: firstLoc.placeName || firstCity, kind: 'destination', location: null },
      ],
    },
    flowSteps: [
      { at: '出发前', action: '收拾前一天的行李和随身物', placeName: prevEnd.placeName || prevCity, busy: true },
      { at: '途中', action: `从${prevCity}动身去${firstCity}`, transit: '跨城交通', busy: true },
      { at: '抵达后', action: `重新接上${firstCity}的安排`, placeName: firstLoc.placeName || firstCity },
    ],
    triggerWindows: [
      { at: '途中', reason: '返程路上有空隙', shareHint: `还在从${prevCity}往${firstCity}转场，今天会慢一点。` },
    ],
    status: 'planned',
    sourceRefs: ['location-continuity-guard'],
  }, 0);
  plan.dayType = plan.dayType === 'workday' ? 'mixed' : plan.dayType;
  plan.dayStartLocation = prevEnd;
  plan.blocks = [travelBlock, ...plan.blocks].filter(Boolean);
  return patch;
}

async function resolveScheduleClockContext(userId, characterId, character = null, nowTs = Date.now()) {
  const timeZone = await resolveCharacterScheduleTimezone(userId, characterId, character).catch(() => '');
  const dateKey = dateKeyFromTimestamp(nowTs, timeZone);
  let nowLabel = new Date(nowTs).toLocaleString('zh-CN');
  if (timeZone) {
    try {
      nowLabel = `${new Date(nowTs).toLocaleString('zh-CN', { timeZone })}（TA 当地 · ${timeZone}）`;
    } catch (_) {
      const short = formatClockInTimezone(nowTs, timeZone);
      if (short) nowLabel = `${short}（TA 当地 · ${timeZone}）`;
    }
  }
  return { timeZone, dateKey, nowLabel };
}

/** 只读检查角色今天有没有日程，不触发生成（供真人感开关等入口做推荐提示）。 */
export async function hasDailyLifePlanForToday(userId, characterId) {
  if (!userId || !characterId) return false;
  const nowTs = await getNowForUser(userId).catch(() => Date.now());
  const { dateKey } = await resolveScheduleClockContext(userId, characterId, null, nowTs);
  const phone = await loadCharacterPhone(userId, characterId).catch(() => null);
  const plan = getDailyLifePlanForDate(phone, dateKey);
  return Boolean(plan?.blocks?.length);
}

// 同一个角色同一天的日程生成可能被好几条路径同时撞上（手动按钮、后台每日任务、生活主动消息…），
// 这里做一把按 `userId:characterId:dateKey` 的进程内锁，撞车时排队复用同一个结果，
// 避免并发重复调用 AI、甚至互相覆盖写坏当天日程。
const dailyPlanInFlight = new Map();

function normalizeScheduleTargetDateKey(value, fallback = '') {
  const candidate = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return fallback;
  const [year, month, day] = candidate.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
    ? candidate
    : fallback;
}

export async function ensureDailyLifePlan(options = {}) {
  const {
    userId, characterId, character = null, force = false, timestamp = null, targetDateKey = '',
  } = options;
  if (!userId || !characterId) return null;
  const nowTs = timestamp == null ? await getNowForUser(userId) : Number(timestamp);
  const clock = await resolveScheduleClockContext(userId, characterId, character, nowTs);
  const dateKey = normalizeScheduleTargetDateKey(targetDateKey, clock.dateKey);
  const lockKey = `${userId}:${characterId}:${dateKey}`;
  const pending = dailyPlanInFlight.get(lockKey);
  if (pending && !force) return pending;

  const run = ensureDailyLifePlanInner({ ...options, timestamp: nowTs }).finally(() => {
    if (dailyPlanInFlight.get(lockKey) === run) dailyPlanInFlight.delete(lockKey);
  });
  dailyPlanInFlight.set(lockKey, run);
  return run;
}

function isScheduleAbortError(error) {
  return error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || ''));
}

async function trySalvageDailyPlanOnAbort({
  raw = '',
  userId,
  characterId,
  character,
  user,
  dateKey,
  force,
  phone,
  nowTs,
  recentChatContext = null,
  userDirective = '',
} = {}) {
  const text = String(raw || '').trim();
  if (!text || text.length < 80) return null;
  let parsed = salvageTruncatedScheduleJson(text);
  if (!parsed) {
    parsed = await parseScheduleJsonWithRepair(text, {}).catch(() => null);
  }
  if (!parsed?.dailyLifePlan?.blocks?.length) return null;
  await saveScheduleGenerationDebug({
    userId, characterId, dateKey, mode: 'daily', raw: text, parsedOk: true, maxTokens: 0, salvaged: true,
  });
  const worldNow = Number(nowTs || 0) || await getNowForUser(userId);
  let patch = normalizeDailyPatch(parsed, { characterId, dateKey, force, now: worldNow });
  const recentActivitySummary = computeRecentActivitySummary(phone, 5);
  patch = enforceDeepNightSchedulePosterior(patch, { character, user });
  patch = enforceLocationContinuity(patch, { phone, characterId, dateKey });
  patch = flagRepeatedActivityBlocks(patch, recentActivitySummary);
  assertScheduleUserPresenceEvidence(patch.dailyLifePlan, {
    phone,
    recentChatContext,
    userDirective,
    userName: getUserDisplayName(user),
  });
  assertSchedulePlotIsFresh(patch.dailyLifePlan, phone, { dateKey, includeSameDate: force });
  patch.dailyLifePlan = enrichDailyLifePlanWithMapCandidates(phone, patch.dailyLifePlan);
  phone = mergePhoneStructuredPatch(phone, patch, { now: worldNow });
  phone = applyMapPinVisitTracking(phone, patch.dailyLifePlan, { timestamp: patch.dailyLifePlan?.generatedAt || worldNow });
  phone = applyElapsedScheduleMapVisits(phone, { timestamp: worldNow });
  phone = await saveCharacterPhone(phone);
  await import('./interest-schedule-progress.js')
    .then((mod) => mod.syncInterestProgressFromSchedule({
      userId,
      characterId,
      phone,
      now: worldNow,
    }))
    .catch(() => {});
  const plan = getDailyLifePlanForDate(phone, dateKey);
  return { phone, plan, generated: true, dateKey, salvaged: true, abortedSalvage: true };
}

async function ensureDailyLifePlanInner({
  userId,
  characterId,
  character,
  user,
  force = false,
  timestamp = null,
  signal = null,
  userDirective = '',
  targetDateKey = '',
  auditContext = null,
} = {}) {
  if (!userId || !characterId) return null;
  const nowTs = timestamp == null ? await getNowForUser(userId) : Number(timestamp);
  const clock = await resolveScheduleClockContext(userId, characterId, character, nowTs);
  const { nowLabel, timeZone } = clock;
  const dateKey = normalizeScheduleTargetDateKey(targetDateKey, clock.dateKey);
  let phone = await loadCharacterPhone(userId, characterId);
  const reconciledPhone = applyElapsedScheduleMapVisits(phone, { timestamp: nowTs, timeZone });
  if (reconciledPhone !== phone) phone = await saveCharacterPhone(reconciledPhone);
  const pruned = pruneExpiredDailyLifePlans(phone, clock.dateKey);
  if (pruned.removed) phone = await saveCharacterPhone(pruned.phone);

  if (!force) {
    const existing = getDailyLifePlanForDate(phone, dateKey);
    if (existing?.blocks?.length && existing.runtimeOnly !== true) {
      return { phone, plan: existing, generated: false, dateKey };
    }
  }

  // 长线旅行覆盖的日子不用再花一次 AI 调用去编日常——直接用旅行自己的节点拼当天日程。
  const activeTrip = await getActiveExtendedTripForDate(userId, characterId, dateKey).catch(() => null);
  if (activeTrip) {
    const overridePlan = buildTripDayPlanOverride({ trip: activeTrip, dateKey, userName: getUserDisplayName(user) });
    if (overridePlan?.blocks?.length) {
      phone = upsertDailyLifePlan(phone, overridePlan);
      phone = await saveCharacterPhone(phone);
      return { phone, plan: getDailyLifePlanForDate(phone, dateKey), generated: true, dateKey };
    }
  }
  const recentChatContext = await collectRecentScheduleChatContext({
    userId,
    characterId,
    timestamp: nowTs,
    user,
    targetDateKey: dateKey,
    timeZone,
  }).catch(() => null);
  const [temporalContext, recentMemoryContext, offlineArchiveState] = await Promise.all([
    buildTimeAndHolidayPromptBlock(userId, nowTs).catch(() => ''),
    collectRecentScheduleMemoryContext({
      userId,
      characterId,
      timestamp: nowTs,
      timeZone,
    }).catch(() => null),
    collectRecentOfflineArchiveStateContext({ userId, characterId }).catch(() => null),
  ]);
  const recentTravelFacts = await collectRecentTravelScheduleContext({
    userId,
    characterId,
    timestamp: nowTs,
  }).catch(() => null);
  phone = await maybeGrowCharacterPhoneMapForDailyPlan({
    userId,
    characterId,
    character,
    phone,
    contextText: [
      ...(recentChatContext?.keyLines || []),
      character?.lifeProfile?.activitySeeds,
      character?.lifeProfile?.habits,
      character?.notes,
    ].filter(Boolean).join(' '),
    reason: 'daily-life-plan',
    timestamp: nowTs,
  }).catch(() => phone);
  throwIfAborted(signal);
  const weatherContext = await buildDailyWeatherContext(character).catch(() => null);
  throwIfAborted(signal);
  const interestEntries = await listInterestEntries(userId, characterId)
    .then((rows) => rows.filter((e) => e.status === 'active'))
    .catch(() => []);
  const interestChannels = interestEntries.slice(0, 10).map((e) => ({
    id: e.id,
    keyword: e.keyword,
    channel: e.channel,
    topic: e.topic || '',
    // 背景故事让日程写手知道"TA 和这个兴趣什么关系"：刚入坑的排新手内容、老粉排深度活动，
    // 而不是所有兴趣都按同一个热情浓度排进日程。
    backstory: e.backstory || undefined,
    progress: e.progress ? {
      stage: e.progress.stage || '',
      latestLog: e.progress.log?.[e.progress.log.length - 1]?.note || '',
      nextGoal: e.progress.nextGoals?.[0] || '',
      nextGoals: e.progress.nextGoals?.slice(0, 2) || [],
    } : null,
  }));
  const tastePool = await loadTastePool(userId, characterId).catch(() => null);
  const recentActivitySummary = computeRecentActivitySummary(phone, 5);
  const todayFreshSeed = rollDailyFreshSeed(interestEntries, tastePool, recentActivitySummary);
  const eventSettings = await loadScheduleEventSettings(userId, characterId).catch(() => ({
    eventNewsEnabled: false,
    eventSearchDailyLimit: EVENT_SEARCH_DAILY_LIMIT_DEFAULT,
    scheduleLanguageMode: SCHEDULE_LANGUAGE_CHINESE,
  }));
  const languagePolicy = buildScheduleLanguagePolicy(eventSettings.scheduleLanguageMode, character);
  const dailySystem = withScheduleLanguageDirective(DAILY_SYSTEM, languagePolicy);
  let newsContext = null;
  if (eventSettings.eventNewsEnabled && !userDirective) {
    const focusKeywords = interestEntries.slice(0, 3).map((e) => e.keyword);
    const [general, priv] = await Promise.all([
      loadGeneralNewsDigest().catch(() => null),
      loadPrivateNewsDigest({ userId, characterId, character, focusKeywords }).catch(() => null),
    ]);
    if (general?.items?.length || priv?.items?.length) {
      newsContext = { general: general?.items || [], private: priv?.items || [] };
    }
  }
  throwIfAborted(signal);
  const dailyMaxTokens = scheduleMaxTokens(await resolveGenerationMaxTokens());
  const userPayload = buildDailyUserPayload({
    user, character, phone, dateKey, nowLabel, force, weatherContext, temporalContext,
    recentChatContext, recentMemoryContext, recentTravelFacts,
    offlineArchiveState,
    interestChannels, tastePool, recentActivitySummary, todayFreshSeed, userDirective, newsContext,
    languagePolicy,
  });
  let raw = '';
  try {
  raw = await chatScheduleOnce({
    system: dailySystem,
    user: userPayload,
    options: {
      temperature: 0.78,
      maxTokens: dailyMaxTokens,
      signal,
      auditContext: {
        operation: 'daily-schedule-generation',
        initiator: userDirective ? 'user' : 'feature',
        actorIds: characterId ? [characterId] : [],
        actorNames: [getCharacterAiContextName(character) || character?.name || ''].filter(Boolean),
        ...(auditContext && typeof auditContext === 'object' ? auditContext : {}),
      },
    },
  });
  throwIfAborted(signal);

  const parsed = await parseScheduleJsonWithRepair(raw, { signal });
  const salvaged = !!parsed?._salvaged;
  await saveScheduleGenerationDebug({
    userId, characterId, dateKey, mode: 'daily', raw, parsedOk: !!parsed, maxTokens: dailyMaxTokens, salvaged,
  });
  if (!parsed) {
    throwScheduleJsonError(raw, { mode: 'daily', partialParsed: salvageTruncatedScheduleJson(raw) });
  }
  let patch;
  try {
    patch = normalizeDailyPatch(parsed, { characterId, dateKey, force, now: nowTs });
  } catch (e) {
    const partial = salvageTruncatedScheduleJson(raw);
    if (partial?.dailyLifePlan?.blocks?.length) {
      throwScheduleJsonError(raw, { mode: 'daily', partialParsed: partial });
    }
    throw e;
  }
  patch = enforceDeepNightSchedulePosterior(patch, {
    character,
    user,
    recentChatContext,
    recentTravelFacts,
    userDirective,
  });
  patch = enforceLocationContinuity(patch, { phone, characterId, dateKey });
  patch = flagRepeatedActivityBlocks(patch, recentActivitySummary);
  assertScheduleUserPresenceEvidence(patch.dailyLifePlan, {
    phone,
    recentChatContext,
    userDirective,
    userName: getUserDisplayName(user),
  });
  assertSchedulePlotIsFresh(patch.dailyLifePlan, phone, { dateKey, includeSameDate: force });
  if (eventSettings.eventNewsEnabled && eventSettings.eventSearchDailyLimit > 0) {
    patch.dailyLifePlan.blocks = await enrichBlocksWithEventSearch(patch.dailyLifePlan.blocks, {
      userId, characterId, character, dailyLimit: eventSettings.eventSearchDailyLimit, signal,
    }).catch(() => patch.dailyLifePlan.blocks);
  }
  patch.dailyLifePlan = enrichDailyLifePlanWithMapCandidates(phone, patch.dailyLifePlan);
  phone = mergePhoneStructuredPatch(phone, patch, { now: nowTs });
  phone = applyMapPinVisitTracking(phone, patch.dailyLifePlan, { timestamp: patch.dailyLifePlan?.generatedAt || nowTs });
  phone = applyElapsedScheduleMapVisits(phone, { timestamp: nowTs, timeZone });
  phone = await saveCharacterPhone(phone);
  await import('./interest-schedule-progress.js')
    .then((mod) => mod.syncInterestProgressFromSchedule({
      userId,
      characterId,
      phone,
      now: nowTs,
      timeZone,
    }))
    .catch(() => {});
  const plan = getDailyLifePlanForDate(phone, dateKey);
  return { phone, plan, generated: true, dateKey, salvaged };
  } catch (e) {
    if (isScheduleAbortError(e)) {
      const rescued = await trySalvageDailyPlanOnAbort({
        raw, userId, characterId, character, user, dateKey, force, phone, nowTs,
        recentChatContext, userDirective,
      });
      if (rescued) return rescued;
    }
    throw e;
  }
}

export async function ensureWeeklyLifePlans({
  userId,
  characterId,
  character,
  user,
  force = true,
  timestamp = null,
  signal = null,
} = {}) {
  if (!userId || !characterId) return null;
  const nowTs = timestamp == null ? await getNowForUser(userId) : Number(timestamp);
  const { dateKey: startDateKey, timeZone } = await resolveScheduleClockContext(userId, characterId, character, nowTs);
  const weekDates = weekDateKeys(startDateKey);
  let phone = await loadCharacterPhone(userId, characterId);
  const reconciledPhone = applyElapsedScheduleMapVisits(phone, { timestamp: nowTs, timeZone });
  if (reconciledPhone !== phone) phone = await saveCharacterPhone(reconciledPhone);
  const pruned = pruneExpiredDailyLifePlans(phone, startDateKey);
  if (pruned.removed) phone = await saveCharacterPhone(pruned.phone);

  if (!force) {
    const allExist = weekDates.every((dk) => {
      const plan = getDailyLifePlanForDate(phone, dk);
      return plan?.blocks?.length && plan.runtimeOnly !== true;
    });
    if (allExist) {
      return { phone, plans: weekDates.map((dk) => getDailyLifePlanForDate(phone, dk)), generated: false };
    }
  }

  const [recentTravelFacts, recentChatContext, temporalContext, recentMemoryContext, offlineArchiveState] = await Promise.all([
    collectRecentTravelScheduleContext({ userId, characterId, timestamp: nowTs }).catch(() => null),
    collectRecentScheduleChatContext({
      userId,
      characterId,
      timestamp: nowTs,
      user,
      targetDateKey: startDateKey,
      timeZone,
    }).catch(() => null),
    buildTimeAndHolidayPromptBlock(userId, nowTs).catch(() => ''),
    collectRecentScheduleMemoryContext({
      userId,
      characterId,
      timestamp: nowTs,
      timeZone,
    }).catch(() => null),
    collectRecentOfflineArchiveStateContext({ userId, characterId }).catch(() => null),
  ]);
  const eventSettings = await loadScheduleEventSettings(userId, characterId).catch(() => ({
    scheduleLanguageMode: SCHEDULE_LANGUAGE_CHINESE,
  }));
  const languagePolicy = buildScheduleLanguagePolicy(eventSettings.scheduleLanguageMode, character);
  const weeklySystem = withScheduleLanguageDirective(WEEKLY_SYSTEM, languagePolicy);

  const weeklyMaxTokens = scheduleMaxTokens(await resolveGenerationMaxTokens());
  const weeklyPayload = buildWeeklyUserPayload({
    user, character, phone, startDateKey, weekDates, temporalContext,
    recentChatContext, recentMemoryContext, recentTravelFacts, languagePolicy,
    offlineArchiveState,
  });
  const raw = await chatScheduleOnce({
    system: weeklySystem,
    user: weeklyPayload,
    options: { temperature: 0.72, maxTokens: weeklyMaxTokens, signal },
    retryMin: 8000,
  });
  throwIfAborted(signal);

  const parsed = await parseScheduleJsonWithRepair(raw, { signal });
  await saveScheduleGenerationDebug({
    userId, characterId, dateKey: startDateKey, mode: 'weekly', raw, parsedOk: !!parsed, maxTokens: weeklyMaxTokens, salvaged: !!parsed?._salvaged,
  });
  if (!parsed) {
    throwScheduleJsonError(raw, { mode: 'weekly', partialParsed: salvageTruncatedScheduleJson(raw) });
  }
  let patch;
  try {
    patch = normalizeWeeklyPatch(parsed, { characterId, startDateKey, now: nowTs });
  } catch (e) {
    const partial = salvageTruncatedScheduleJson(raw);
    if (partial?.dailyLifePlans?.length) {
      throwScheduleJsonError(raw, { mode: 'weekly', partialParsed: partial });
    }
    throw e;
  }
  patch = ensureWeeklyMorningCoverage(patch, { character });
  patch = enforceDeepNightSchedulePosterior(patch, { character, user, recentTravelFacts });
  patch.dailyLifePlans = patch.dailyLifePlans.map((plan) => (
    enrichDailyLifePlanWithMapCandidates(phone, plan)
  ));
  let validationPhone = phone;
  for (const plan of patch.dailyLifePlans) {
    assertScheduleUserPresenceEvidence(plan, {
      phone: validationPhone,
      userName: getUserDisplayName(user),
    });
    assertSchedulePlotIsFresh(plan, validationPhone, {
      dateKey: plan.dateKey,
      includeSameDate: force,
    });
    validationPhone = upsertDailyLifePlan(validationPhone, plan);
  }
  phone = mergePhoneStructuredPatch(phone, patch, { now: nowTs });
  for (const plannedDay of patch.dailyLifePlans) {
    phone = applyMapPinVisitTracking(phone, plannedDay, { timestamp: nowTs });
  }
  // 周计划里落在长线旅行区间内的日子，用旅行自己的节点覆盖掉 AI 编的那天，保持行程和日程一致。
  for (const dk of weekDates) {
    const activeTrip = await getActiveExtendedTripForDate(userId, characterId, dk).catch(() => null);
    if (!activeTrip) continue;
    const overridePlan = buildTripDayPlanOverride({ trip: activeTrip, dateKey: dk, userName: getUserDisplayName(user) });
    if (overridePlan?.blocks?.length) phone = upsertDailyLifePlan(phone, overridePlan);
  }
  phone = await saveCharacterPhone(phone);
  const plans = weekDates.map((dk) => getDailyLifePlanForDate(phone, dk)).filter(Boolean);
  return { phone, plans, generated: true, startDateKey, salvaged: !!parsed?._salvaged };
}

export async function changeDailyLifePlanByCharacter({
  userId,
  characterId,
  character,
  user,
  blockId = '',
  reason = '',
  timestamp = null,
  signal = null,
} = {}) {
  if (!userId || !characterId) throw new Error('缺少用户或角色');
  const nowTs = timestamp == null ? await getNowForUser(userId) : Number(timestamp);
  const { dateKey, nowLabel, timeZone } = await resolveScheduleClockContext(userId, characterId, character, nowTs);
  let phone = await loadCharacterPhone(userId, characterId);
  const reconciledPhone = applyElapsedScheduleMapVisits(phone, { timestamp: nowTs, timeZone });
  if (reconciledPhone !== phone) phone = await saveCharacterPhone(reconciledPhone);
  const pruned = pruneExpiredDailyLifePlans(phone, dateKey);
  if (pruned.removed) phone = await saveCharacterPhone(pruned.phone);
  const plan = getDailyLifePlanForDate(phone, dateKey);
  if (!plan?.blocks?.length) throw new Error('还没有今日日程');
  const target = blockId
    ? plan.blocks.find((item) => String(item?.id || '') === String(blockId))
    : pickCurrentPlanBlock(plan, nowTs, timeZone);
  if (!target) throw new Error('找不到要改的时段');
  if (target.locked) throw new Error('这个时段已锁定，不能自动改行程');

  const weatherContext = await buildDailyWeatherContext(character).catch(() => null);
  const recentTravelFacts = await collectRecentTravelScheduleContext({
    userId,
    characterId,
    timestamp: nowTs,
  }).catch(() => null);
  const recentChatContext = await collectRecentScheduleChatContext({
    userId,
    characterId,
    timestamp: nowTs,
    user,
  }).catch(() => null);
  const eventSettings = await loadScheduleEventSettings(userId, characterId).catch(() => ({
    scheduleLanguageMode: SCHEDULE_LANGUAGE_CHINESE,
  }));
  const languagePolicy = buildScheduleLanguagePolicy(eventSettings.scheduleLanguageMode, character);
  const changeSystem = withScheduleLanguageDirective(CHANGE_SYSTEM, languagePolicy);
  throwIfAborted(signal);
  const changeMaxTokens = scheduleMaxTokens(await resolveGenerationMaxTokens());
  const raw = await chatScheduleOnce({
    system: changeSystem,
    user: buildChangeUserPayload({
      user, character, plan, block: target, reason, nowLabel, weatherContext, recentTravelFacts,
      recentChatContext,
      languagePolicy,
    }),
    options: { temperature: 0.82, maxTokens: changeMaxTokens, signal },
    retryMin: 4000,
  });
  throwIfAborted(signal);

  const parsed = await parseScheduleJsonWithRepair(raw, { signal });
  await saveScheduleGenerationDebug({
    userId, characterId, dateKey, mode: 'change', raw, parsedOk: !!parsed, maxTokens: changeMaxTokens,
  });
  if (!parsed || typeof parsed !== 'object') {
    throwScheduleJsonError(raw, { mode: 'change', partialParsed: salvageTruncatedScheduleJson(raw) });
  }
  const decision = evaluateGroundedScheduleChange(parsed, {
    reason,
    weatherContext,
    recentChatContext,
    recentTravelFacts,
  });
  if (!decision.shouldChange) {
    return {
      phone,
      plan,
      oldBlock: target,
      newBlock: null,
      changed: false,
      changeReason: decision.evidence || '没有足够的新事实，保留原计划',
      dateKey,
    };
  }
  const wallUpdatedAt = Date.now();
  const applied = applyChangedBlockToPlan(plan, target, parsed, { reason, worldNow: nowTs });
  let guarded = enforceDeepNightSchedulePosterior({
    dailyLifePlan: applied.nextPlan,
  }, {
    character,
    user,
    recentChatContext,
    recentTravelFacts,
    userDirective: reason,
  }).dailyLifePlan;
  guarded = enrichDailyLifePlanWithMapCandidates(phone, guarded);
  phone = upsertDailyLifePlan(phone, guarded, { wallNow: wallUpdatedAt });
  phone = applyMapPinVisitTracking(phone, guarded, { timestamp: nowTs });
  phone = await saveCharacterPhone(phone);
  const savedPlan = getDailyLifePlanForDate(phone, dateKey) || guarded;
  const guardedNewBlock = savedPlan?.blocks?.find((item) => (
    String(item?.id || '') === String(applied.newBlock?.id || '')
  )) || applied.newBlock;
  return {
    phone,
    plan: savedPlan,
    oldBlock: applied.oldBlock,
    newBlock: guardedNewBlock,
    changeReason: applied.changeReason,
    changed: true,
    dateKey,
  };
}

function applyChangedBlockToPlan(plan, target, parsed, { reason = '', worldNow = 0 } = {}) {
  const changeReason = String(parsed?.changeReason || reason || '临时改变安排').trim();
  const newId = `block_change_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const newBlock = normalizeDailyLifeBlock({
    ...(parsed?.newBlock || {}),
    id: newId,
    timeRange: parsed?.newBlock?.timeRange || target.timeRange,
    status: 'planned',
    origin: 'ai',
    updatedBy: 'character',
    supersedes: target.id,
    changeReason,
    worldUpdatedAt: Number(worldNow || 0) || 0,
  }, plan.blocks.length);
  if (!newBlock) throw new Error('AI 返回的新时段无效');

  const nextPlan = {
    ...plan,
    blocks: plan.blocks.flatMap((item) => {
      if (String(item?.id || '') !== String(target.id || '')) return [item];
      return [
        {
          ...item,
          status: 'changed',
          supersededBy: newBlock.id,
          changeReason,
          updatedBy: 'character',
          worldUpdatedAt: Number(worldNow || 0) || 0,
        },
        newBlock,
      ];
    }),
    generatedAt: plan.generatedAt || Date.now(),
    worldUpdatedAt: Number(worldNow || 0) || Number(plan.worldUpdatedAt || 0) || 0,
  };
  return { nextPlan, oldBlock: target, newBlock, changeReason };
}

/** 从改行程失败时的模型原文手动解析并写入（截断/非 JSON 救回） */
export async function tryApplyChangeScheduleFromRaw({
  userId,
  characterId,
  character,
  user,
  blockId = '',
  reason = '',
  timestamp = null,
  raw = '',
} = {}) {
  if (!userId || !characterId) throw new Error('缺少用户或角色');
  const nowTs = timestamp == null ? await getNowForUser(userId) : Number(timestamp);
  const { dateKey, timeZone } = await resolveScheduleClockContext(userId, characterId, character, nowTs);
  let parsed = await parseScheduleJsonWithRepair(String(raw || ''), {});
  if (!parsed) parsed = salvageTruncatedScheduleJson(String(raw || ''));
  if (!parsed || typeof parsed !== 'object' || !parsed.newBlock) {
    throw new Error('无法从原文解析出可用的改行程 JSON');
  }
  if (String(parsed.decision || '').trim().toLowerCase() !== 'change'
    || !String(parsed.evidence || '').trim()) {
    throw new Error('模型没有给出需要改行程的可核对事实');
  }
  const [weatherContext, recentTravelFacts, recentChatContext] = await Promise.all([
    buildDailyWeatherContext(character).catch(() => null),
    collectRecentTravelScheduleContext({ userId, characterId, timestamp: nowTs }).catch(() => null),
    collectRecentScheduleChatContext({
      userId,
      characterId,
      timestamp: nowTs,
      user,
    }).catch(() => null),
  ]);
  if (!evaluateGroundedScheduleChange(parsed, {
    reason,
    weatherContext,
    recentChatContext,
    recentTravelFacts,
  }).shouldChange) {
    throw new Error('模型给出的改期理由没有对应到当前已知事实');
  }
  let phone = await loadCharacterPhone(userId, characterId);
  const plan = getDailyLifePlanForDate(phone, dateKey);
  if (!plan?.blocks?.length) throw new Error('还没有今日日程');
  const target = blockId
    ? plan.blocks.find((item) => String(item?.id || '') === String(blockId) && item.status !== 'changed')
      || plan.blocks.find((item) => String(item?.id || '') === String(blockId))
    : pickCurrentPlanBlock(plan, nowTs, timeZone);
  if (!target) throw new Error('找不到要改的时段');
  if (target.locked) throw new Error('这个时段已锁定，不能自动改行程');
  if (target.status === 'changed' || String(target.supersededBy || '').trim()) {
    throw new Error('该时段已被改过，请刷新后再试');
  }
  const wallUpdatedAt = Date.now();
  const applied = applyChangedBlockToPlan(plan, target, parsed, { reason, worldNow: nowTs });
  const guarded = enforceDeepNightSchedulePosterior({
    dailyLifePlan: applied.nextPlan,
  }, {
    character,
    user,
    recentChatContext,
    recentTravelFacts,
    userDirective: reason,
  }).dailyLifePlan;
  phone = upsertDailyLifePlan(phone, guarded, { wallNow: wallUpdatedAt });
  phone = await saveCharacterPhone(phone);
  const savedPlan = getDailyLifePlanForDate(phone, dateKey) || guarded;
  const guardedNewBlock = savedPlan?.blocks?.find((item) => (
    String(item?.id || '') === String(applied.newBlock?.id || '')
  )) || applied.newBlock;
  return {
    phone,
    plan: savedPlan,
    oldBlock: applied.oldBlock,
    newBlock: guardedNewBlock,
    changeReason: applied.changeReason,
    dateKey,
    salvaged: !!parsed._salvaged,
  };
}

/** 从模型原文手动解析并写入今日日程（用于截断/非 JSON 时的救回） */
export async function tryApplyDailyScheduleFromRaw({
  userId, characterId, character, user, dateKey, force = true, raw = '', userDirective = '',
} = {}) {
  if (!userId || !characterId) throw new Error('缺少用户或角色');
  const nowTs = await getNowForUser(userId);
  const clock = await resolveScheduleClockContext(userId, characterId, character, nowTs);
  const dk = String(dateKey || clock.dateKey).trim();
  let parsed = await parseScheduleJsonWithRepair(String(raw || ''), {});
  if (!parsed) parsed = salvageTruncatedScheduleJson(String(raw || ''));
  if (!parsed) throw new Error('无法从原文解析出可用 JSON');
  let phone = await loadCharacterPhone(userId, characterId);
  const recentChatContext = await collectRecentScheduleChatContext({
    userId,
    characterId,
    timestamp: nowTs,
    user,
    targetDateKey: dk,
    timeZone: clock.timeZone,
  }).catch(() => null);
  let patch = normalizeDailyPatch(parsed, { characterId, dateKey: dk, force, now: nowTs });
  const recentActivitySummary = computeRecentActivitySummary(phone, 5);
  patch = enforceDeepNightSchedulePosterior(patch, { character, user });
  patch = enforceLocationContinuity(patch, { phone, characterId, dateKey: dk });
  patch = flagRepeatedActivityBlocks(patch, recentActivitySummary);
  assertScheduleUserPresenceEvidence(patch.dailyLifePlan, {
    phone,
    recentChatContext,
    userDirective,
    userName: getUserDisplayName(user),
  });
  assertSchedulePlotIsFresh(patch.dailyLifePlan, phone, { dateKey: dk, includeSameDate: force });
  patch.dailyLifePlan = enrichDailyLifePlanWithMapCandidates(phone, patch.dailyLifePlan);
  phone = mergePhoneStructuredPatch(phone, patch, { now: nowTs });
  phone = applyMapPinVisitTracking(phone, patch.dailyLifePlan, { timestamp: nowTs });
  phone = await saveCharacterPhone(phone);
  const plan = getDailyLifePlanForDate(phone, dk);
  return { phone, plan, generated: true, dateKey: dk, salvaged: !!parsed._salvaged };
}

/** 从模型原文手动解析并写入本周日程 */
export async function tryApplyWeeklyScheduleFromRaw({
  userId, characterId, character, user, startDateKey, raw = '',
} = {}) {
  if (!userId || !characterId) throw new Error('缺少用户或角色');
  const nowTs = await getNowForUser(userId);
  const clock = await resolveScheduleClockContext(userId, characterId, character, nowTs);
  const sk = String(startDateKey || clock.dateKey).trim();
  let parsed = await parseScheduleJsonWithRepair(String(raw || ''), {});
  if (!parsed) parsed = salvageTruncatedScheduleJson(String(raw || ''));
  if (!parsed) throw new Error('无法从原文解析出可用 JSON');
  let phone = await loadCharacterPhone(userId, characterId);
  let patch = normalizeWeeklyPatch(parsed, { characterId, startDateKey: sk, now: nowTs });
  patch = ensureWeeklyMorningCoverage(patch, { character });
  patch = enforceDeepNightSchedulePosterior(patch, { character, user });
  patch.dailyLifePlans = patch.dailyLifePlans.map((plan) => enrichDailyLifePlanWithMapCandidates(phone, plan));
  let validationPhone = phone;
  for (const plan of patch.dailyLifePlans) {
    assertScheduleUserPresenceEvidence(plan, {
      phone: validationPhone,
      userName: getUserDisplayName(user),
    });
    assertSchedulePlotIsFresh(plan, validationPhone, {
      dateKey: plan.dateKey,
      includeSameDate: true,
    });
    validationPhone = upsertDailyLifePlan(validationPhone, plan);
  }
  phone = mergePhoneStructuredPatch(phone, patch, { now: nowTs });
  for (const plannedDay of patch.dailyLifePlans) {
    phone = applyMapPinVisitTracking(phone, plannedDay, { timestamp: nowTs });
  }
  const weekDates = weekDateKeys(sk);
  for (const dk of weekDates) {
    const activeTrip = await getActiveExtendedTripForDate(userId, characterId, dk).catch(() => null);
    if (!activeTrip) continue;
    const overridePlan = buildTripDayPlanOverride({ trip: activeTrip, dateKey: dk, userName: getUserDisplayName(user) });
    if (overridePlan?.blocks?.length) phone = upsertDailyLifePlan(phone, overridePlan);
  }
  phone = await saveCharacterPhone(phone);
  const plans = weekDates.map((dk) => getDailyLifePlanForDate(phone, dk)).filter(Boolean);
  return { phone, plans, generated: true, startDateKey: sk, salvaged: !!parsed._salvaged };
}

/** 收集某日日程里需要补中文译文的字段（供「翻译日程」一次工具 API 批量补全） */
function collectBlockDisplayTranslationFields(block = {}) {
  const stored = block.displayTranslations && typeof block.displayTranslations === 'object'
    ? block.displayTranslations
    : {};
  const fields = [];
  const push = (key, source) => {
    const src = String(source || '').trim();
    if (!src) return;
    const saved = stored[key] && typeof stored[key] === 'object' ? stored[key] : {};
    fields.push({
      key,
      source: src,
      translation: String(saved.source || '').trim() === src
        ? String(saved.translation || saved.zh || '').trim()
        : '',
    });
  };

  push('location', [block.placeName, block.city].filter(Boolean).join(' · '));
  push('changeReason', block.changeReason);
  const route = block.routeHint && typeof block.routeHint === 'object' ? block.routeHint : null;
  if (route) {
    const line = [route.origin, route.destination].filter(Boolean).join(' → ');
    const meta = [route.mode, route.durationText, route.distanceText].filter(Boolean).join(' · ');
    push('route', [line, meta].filter(Boolean).join('；'));
  }
  for (const [index, step] of (Array.isArray(block.flowSteps) ? block.flowSteps : []).entries()) {
    if (!step) continue;
    const sid = String(step.id || index).trim();
    const title = step.action || step.shareCandidate;
    const meta = [step.placeName, step.transit].filter(Boolean).join(' · ');
    const share = step.action && step.shareCandidate ? step.shareCandidate : '';
    push(`flow:${sid}`, [title, meta, share].filter(Boolean).join('；'));
  }
  push('eventNote', block.eventNote);
  push('shareCandidates', (Array.isArray(block.shareCandidates) ? block.shareCandidates : []).slice(0, 2).join('；'));
  return fields;
}

export function collectDailyLifePlanTranslationEntries(plan, { languageHint = '' } = {}) {
  if (!plan || typeof plan !== 'object') return [];
  const hint = String(languageHint || '').trim();
  const entries = [];
  const push = (id, source, translation) => {
    const src = String(source || '').trim();
    if (!src) return;
    entries.push({
      id: String(id || '').trim(),
      source: src,
      translation: String(translation || '').trim(),
      languageHint: hint,
    });
  };
  push('dayTheme', plan.dayTheme, plan.dayThemeTranslation);
  push('mood', plan.mood, plan.moodTranslation);
  for (const block of Array.isArray(plan.blocks) ? plan.blocks : []) {
    const bid = String(block?.id || '').trim();
    if (!bid) continue;
    push(`${bid}__activity`, block.activity, block.activityTranslation);
    const isLegacyOfflineStatus = block.origin === 'offline_active'
      && String(block.narrative || '').trim() === '线下会面进行中';
    if (!isLegacyOfflineStatus) push(`${bid}__narrative`, block.narrative, block.narrativeTranslation);
    for (const field of collectBlockDisplayTranslationFields(block)) {
      push(`${bid}__display__${encodeURIComponent(field.key)}`, field.source, field.translation);
    }
  }
  return entries.filter((entry) => needsTranslationRepair(entry.source, entry.translation, {
    translationProfile: hint ? { mode: 'full', language: hint } : {},
    languageHint: hint,
  }));
}

export function dailyLifePlanNeedsTranslation(plan) {
  if (!plan || typeof plan !== 'object') return false;
  const samples = [
    plan.dayTheme,
    plan.mood,
    ...(Array.isArray(plan.blocks) ? plan.blocks.flatMap((b) => [
      b?.activity,
      b?.narrative,
      ...collectBlockDisplayTranslationFields(b).map((field) => field.source),
    ]) : []),
  ];
  return samples.some((text) => messageLikelyNeedsTranslation(text));
}

/**
 * 点「翻译日程」：对旧日程或生成时漏掉的字段，用一次工具 API
 *（translationRepair）把当天外语正文补成简体中文并落库。
 */
export async function repairDailyLifePlanTranslations({
  userId,
  characterId,
  dateKey,
  languageHint = '',
  signal = null,
} = {}) {
  if (!userId || !characterId) throw new Error('缺少用户或角色');
  const dk = String(dateKey || '').trim();
  if (!dk) throw new Error('缺少日期');
  let phone = await loadCharacterPhone(userId, characterId);
  const plan = getDailyLifePlanForDate(phone, dk);
  if (!plan?.blocks?.length) throw new Error('还没有日程可翻译');

  const entries = collectDailyLifePlanTranslationEntries(plan, { languageHint });
  if (!entries.length) {
    return {
      phone,
      plan,
      repaired: 0,
      candidateCount: 0,
      remainingCount: 0,
      repairStatus: 'no_candidate',
      failureReason: '',
      failureMessage: '',
    };
  }

  const repairs = await repairTranslationEntries(entries, { signal });
  if (!repairs.size) {
    return {
      phone,
      plan,
      repaired: 0,
      candidateCount: entries.length,
      remainingCount: entries.length,
      repairStatus: repairs.repairStatus || 'invalid_translation',
      failureReason: repairs.failureReason || '',
      failureMessage: translationRepairFailureMessage(repairs),
    };
  }

  const nextPlan = {
    ...plan,
    ...(repairs.has('dayTheme') ? { dayThemeTranslation: repairs.get('dayTheme') } : {}),
    ...(repairs.has('mood') ? { moodTranslation: repairs.get('mood') } : {}),
    blocks: (plan.blocks || []).map((block) => {
      const bid = String(block?.id || '').trim();
      if (!bid) return block;
      const activityZh = repairs.get(`${bid}__activity`);
      const narrativeZh = repairs.get(`${bid}__narrative`);
      const nextDisplayTranslations = { ...(block.displayTranslations || {}) };
      let displayChanged = false;
      for (const field of collectBlockDisplayTranslationFields(block)) {
        const translation = repairs.get(`${bid}__display__${encodeURIComponent(field.key)}`);
        if (!translation) continue;
        nextDisplayTranslations[field.key] = { source: field.source, translation };
        displayChanged = true;
      }
      if (!activityZh && !narrativeZh && !displayChanged) return block;
      return {
        ...block,
        ...(activityZh ? { activityTranslation: activityZh } : {}),
        ...(narrativeZh ? { narrativeTranslation: narrativeZh } : {}),
        ...(displayChanged ? { displayTranslations: nextDisplayTranslations } : {}),
      };
    }),
  };

  phone = upsertDailyLifePlan(phone, nextPlan, { wallNow: Date.now() });
  phone = await saveCharacterPhone(phone);
  return {
    phone,
    plan: getDailyLifePlanForDate(phone, dk) || nextPlan,
    repaired: repairs.size,
    candidateCount: entries.length,
    remainingCount: Math.max(0, entries.length - repairs.size),
    repairStatus: repairs.repairStatus || (repairs.size === entries.length ? 'success' : 'partial'),
    failureReason: repairs.failureReason || '',
    failureMessage: translationRepairFailureMessage(repairs),
  };
}
