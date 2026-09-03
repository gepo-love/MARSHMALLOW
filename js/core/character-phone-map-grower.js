import * as db from './db.js';
import {
  amapTextSearch,
  amapV5AroundSearch,
  bucketPoiLabel,
  loadAmapConfig,
} from './amap-tools.js';
import {
  loadCharacterPhone,
  mergePhoneStructuredPatch,
  saveCharacterPhone,
} from './character-phone-store.js';
import {
  getBaseLocationAnchor,
  normalizeLocationProfile,
} from './location-profile.js';
import { listInterestEntries } from './character-interest-table.js';
import { appendTasteItems } from './character-taste-pool.js';
import { getNowForUser } from './time-mode.js';
import { createAmapMcpSearchSession } from './amap-mcp-tools.js';

const DAILY_USAGE_KEY = 'amapAutoGrowDailyUsage';
const inFlight = new Set();

function clean(value = '', max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadDailyUsage() {
  const today = dayKey();
  const row = await db.get(DAILY_USAGE_KEY).catch(() => null);
  const value = row?.value || {};
  if (value.day !== today) return { day: today, used: 0, events: [] };
  return {
    day: today,
    used: Math.max(0, Number(value.used || 0) || 0),
    events: asArray(value.events).slice(-30),
  };
}

async function bumpDailyUsage(reason = '') {
  const usage = await loadDailyUsage();
  const next = {
    day: usage.day,
    used: usage.used + 1,
    events: [...usage.events, { at: Date.now(), reason: clean(reason, 90) }].slice(-30),
  };
  await db.put({ key: DAILY_USAGE_KEY, value: next });
  return next;
}

function inferCity(character = {}, profile = {}) {
  const anchor = character.residenceAnchor && typeof character.residenceAnchor === 'object'
    ? character.residenceAnchor
    : {};
  return clean(anchor.realCityMap || profile.city?.name || anchor.city || '', 40);
}

function uniq(list = [], limit = 12) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = clean(item, 60);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function pickAnchorQuery({ character = {}, phone = {}, profile = {} } = {}) {
  const base = getBaseLocationAnchor(profile) || {};
  const anchor = character.residenceAnchor && typeof character.residenceAnchor === 'object'
    ? character.residenceAnchor
    : {};
  const candidates = [
    base.query,
    base.label,
    base.area,
    anchor.mapQuery,
    anchor.area,
    anchor.label,
    ...(phone.mapPins || []).map((item) => item.anchorName || item.placeName),
  ];
  return uniq(candidates, 1)[0] || '';
}

/**
 * 兴趣表里 staple 频道的词条（TA 真心常惦记的日常吃喝品类）优先当周边搜索类目——
 * 比正则从 preferences 猜的词更贴角色本人，也是「日程想去烤肉店→搜附近烤肉店→定哪家」
 * 这条链路的第一环。查不到兴趣表或没有 staple 词条时返回空，交给正则兜底。
 */
async function pickStapleKeywords(userId, characterId) {
  if (!userId || !characterId) return [];
  const entries = await listInterestEntries(userId, characterId).catch(() => []);
  return uniq(
    entries.filter((e) => e.status === 'active' && e.channel === 'staple').map((e) => e.keyword),
    4,
  );
}

// 固定词表里每个词属于哪个 bucketPoiCategory 大类，用来在下面做"同一大类最多出 2 个词"的
// 密度上限——旧版兜底词直接写死"餐饮/咖啡/便利店"三个全是 food 桶的词，等于给普通角色（没填
// 具体饮食偏好）的地图生长固定搜三次吃喝，也是"日程/地图咖啡店出镜率很高"的另一个根因。
const KEYWORD_BUCKET = {
  景点: 'leisure', 博物馆: 'leisure', 咖啡: 'food', 甜品: 'food',
  餐饮: 'food', 书店: 'shopping', 展馆: 'leisure', 公园: 'leisure',
  便利店: 'food', 购物: 'shopping',
};

function capBucketDensity(list = [], maxPerBucket = 2) {
  const counts = {};
  const out = [];
  for (const kw of list) {
    const bucket = KEYWORD_BUCKET[kw] || 'other';
    counts[bucket] = (counts[bucket] || 0) + 1;
    if (counts[bucket] > maxPerBucket) continue;
    out.push(kw);
  }
  return out;
}

function pickInterestKeywords({ character = {}, phone = {}, contextText = '' } = {}) {
  const prefs = phone.preferences || {};
  const life = character.lifeProfile && typeof character.lifeProfile === 'object' ? character.lifeProfile : {};
  const loc = normalizeLocationProfile(character);
  const base = [
    ...asArray(prefs.food),
    ...asArray(prefs.places),
    ...asArray(prefs.shopping),
    ...asArray(loc.lifestyle?.hobbies),
    life.activitySeeds,
    life.habits,
    contextText,
  ].join(' ');
  const picked = [];
  const rules = [
    [/旅游|旅行|攻略|景区|打卡|城市|博物馆|美术馆|展览|酒店|远门/u, '景点'],
    [/博物馆|美术馆|展览|展馆/u, '博物馆'],
    [/咖啡|拿铁|美式|奶茶|饮品|茶/u, '咖啡'],
    [/甜品|蛋糕|面包|烘焙/u, '甜品'],
    [/吃|饭|餐厅|面|火锅|烧烤|小吃|夜宵/u, '餐饮'],
    [/书|阅读|小说|漫画|文具/u, '书店'],
    [/电影|展|博物馆|美术馆|剧场/u, '展馆'],
    [/跑步|健身|运动|散步|公园/u, '公园'],
    [/便利|买点|日用品/u, '便利店'],
  ];
  for (const [re, keyword] of rules) {
    if (re.test(base)) picked.push(keyword);
  }
  // 兜底词表按大类目分散（吃喝/购物/休闲/书店各出 1 个），不再让"咖啡/便利店"这类同属
  // food 桶的词占满兜底名额。
  const fallbackByBucket = ['餐饮', '购物', '公园', '书店'];
  const merged = capBucketDensity(uniq([
    ...picked,
    ...asArray(prefs.food),
    ...asArray(prefs.places),
    ...fallbackByBucket,
  ], 9), 2);
  return merged.slice(0, 5);
}

function dedupePois(list = []) {
  const seen = new Set();
  const out = [];
  for (const poi of asArray(list)) {
    const key = clean(poi?.id || `${poi?.name || ''}|${poi?.location || ''}`, 160);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(poi);
  }
  return out;
}

function poiToPin(poi = {}, {
  anchorName = '',
  sourceQuery = '',
  affinity = 0.5,
  timestamp = Date.now(),
} = {}) {
  return {
    placeName: poi.name || '',
    city: poi.city || '',
    district: poi.district || '',
    address: poi.address || '',
    location: poi.location || '',
    sourcePoiId: poi.id || '',
    sourceType: poi.lookupSource || poi.type || '',
    bucket: poi.bucket || 'other',
    bucketLabel: poi.bucketLabel || bucketPoiLabel(poi.bucket || 'other'),
    rating: poi.rating || '',
    cost: poi.cost || '',
    photo: poi.photo || '',
    distance: poi.distance || null,
    anchorName,
    sourceQuery,
    affinity,
    relationStatus: 'candidate',
    visitVerdict: '待角色筛选',
    aiJudgement: '高德返回的临时候选，尚未成为角色计划',
    visibility: 'candidate',
    tags: ['map', 'mcp_candidate', poi.lookupSource || '', sourceQuery, poi.bucket || 'other'].filter(Boolean),
    updatedAt: timestamp,
  };
}

export async function maybeGrowCharacterPhoneMapForDailyPlan({
  userId,
  characterId,
  character,
  phone: inputPhone = null,
  contextText = '',
  reason = 'daily-plan',
  respectAutoToggle = true,
  bypassCooldown = false,
  bypassDailyLimit = false,
  writeCurrentState = false,
  timestamp = null,
} = {}) {
  if (!userId || !characterId || !character) return inputPhone;
  const cfg = await loadAmapConfig().catch(() => null);
  if (!cfg?.enabled || !cfg.apiKey || (respectAutoToggle && cfg.autoGrowEnabled === false)) return inputPhone;
  const dailyLimit = Math.max(0, Number(cfg.autoGrowDailyLimit || 0) || 0);
  if (!dailyLimit && !bypassDailyLimit) return inputPhone;
  const usage = await loadDailyUsage();
  if (!bypassDailyLimit && usage.used >= dailyLimit) return inputPhone;

  let phone = inputPhone || await loadCharacterPhone(userId, characterId);
  const profile = normalizeLocationProfile(character);
  if (profile.mapEnabled === false) return phone;
  const city = inferCity(character, profile);
  const anchorQuery = pickAnchorQuery({ character, phone, profile });
  const stapleKeywords = await pickStapleKeywords(userId, characterId);
  const keywords = stapleKeywords.length ? stapleKeywords : pickInterestKeywords({ character, phone, contextText });
  if (!anchorQuery || !keywords.length) return phone;
  const stapleKeywordSet = new Set(stapleKeywords);

  const stateKey = `daily:${city}:${anchorQuery}:${keywords.slice(0, 3).join('|')}`;
  const realNow = Date.now();
  const worldNow = Number(timestamp) || await getNowForUser(userId);
  const cooldownMs = Math.max(1, Number(cfg.autoGrowCooldownHours || 12) || 12) * 60 * 60 * 1000;
  const lastAt = Number(phone.mapGrowState?.[stateKey] || 0) || 0;
  if (!bypassCooldown && lastAt && realNow - lastAt < cooldownMs) return phone;
  const lockKey = `${userId}:${characterId}:${stateKey}`;
  if (inFlight.has(lockKey)) return phone;

  inFlight.add(lockKey);
  let mcpSession = null;
  try {
    mcpSession = await createAmapMcpSearchSession(cfg).catch(() => null);
    await bumpDailyUsage(`${characterId}:${reason}:anchor`);
    const anchorValues = { keywords: anchorQuery, city, cityLimit: !!city, maxResults: 3 };
    const anchorResult = mcpSession
      ? await mcpSession.textSearch(anchorValues).catch(() => amapTextSearch(anchorValues, { config: cfg }))
      : await amapTextSearch(anchorValues, { config: cfg });
    const anchorPoi = anchorResult.pois?.[0] || null;
    if (!anchorPoi?.location) return phone;

    const aroundResults = [];
    for (const keyword of keywords.slice(0, 4)) {
      const latestUsage = await loadDailyUsage();
      if (!bypassDailyLimit && latestUsage.used >= dailyLimit) break;
      await bumpDailyUsage(`${characterId}:${reason}:around:${keyword}`);
      const aroundValues = {
        location: anchorPoi.location,
        keywords: keyword,
        city,
        radius: cfg.radius || 1500,
        maxResults: Math.max(3, Math.min(8, Number(cfg.maxResults || 6) || 6)),
      };
      const around = mcpSession
        ? await mcpSession.aroundSearch(aroundValues).catch(() => amapV5AroundSearch(aroundValues, { config: cfg }).catch(() => null))
        : await amapV5AroundSearch(aroundValues, { config: cfg }).catch(() => null);
      const keywordPois = asArray(around?.pois).map((poi) => ({ ...poi, lookupSource: around?.source || 'amap_api' }));
      aroundResults.push(...keywordPois);
      // staple 类目搜到真实店名，直接长进常识词汇池——日程/聊天以后能说出具体店名而不是泛称
      if (stapleKeywordSet.has(keyword) && keywordPois.length) {
        await appendTasteItems(
          userId, characterId, keyword,
          keywordPois.slice(0, 3).map((poi) => poi.name).filter(Boolean),
          { kind: 'shop', source: 'amap' },
        ).catch(() => {});
      }
    }
    const establishedPoiIds = new Set(asArray(phone.mapPins)
      .filter((pin) => pin?.relationStatus !== 'candidate' && pin?.visibility !== 'candidate')
      .map((pin) => clean(pin?.sourcePoiId || '', 90))
      .filter(Boolean));
    const establishedNames = new Set(asArray(phone.mapPins)
      .filter((pin) => pin?.relationStatus !== 'candidate' && pin?.visibility !== 'candidate')
      .map((pin) => clean(pin?.placeName || '', 90).toLowerCase())
      .filter(Boolean));
    const pois = dedupePois(aroundResults)
      .filter((poi) => !establishedPoiIds.has(clean(poi?.id || '', 90))
        && !establishedNames.has(clean(poi?.name || '', 90).toLowerCase()))
      .slice(0, 10);
    if (!pois.length) return phone;

    const patch = {
      source: 'characterPhoneMapAutoGrow',
      mapPins: pois.map((poi, idx) => poiToPin(poi, {
        anchorName: anchorPoi.name || anchorQuery,
        sourceQuery: keywords[idx % keywords.length] || keywords[0],
        affinity: idx === 0 ? 0.7 : 0.48,
        timestamp: worldNow,
      })),
      mapGrowState: { [stateKey]: realNow },
    };
    phone = {
      ...phone,
      mapPins: asArray(phone.mapPins).filter((pin) => (
        pin?.relationStatus !== 'candidate' && pin?.visibility !== 'candidate'
      )),
      ...(/amapPoiSearch/i.test(String(phone.currentMapState?.source || ''))
        ? { currentMapState: {} }
        : {}),
    };
    phone = mergePhoneStructuredPatch(phone, patch, { now: worldNow });
    return saveCharacterPhone(phone);
  } finally {
    await mcpSession?.close?.().catch(() => {});
    inFlight.delete(lockKey);
  }
}
