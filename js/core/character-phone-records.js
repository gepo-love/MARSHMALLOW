import { chatWithPreferredStream, resolveGenerationMaxTokens } from './api.js';
import { getNowForUser } from './time-mode.js';
import { resolveCharacterScheduleTimezone } from './chat/chat-timezone.js';
import {
  loadCharacterPhone,
  saveCharacterPhone,
  mergePhoneStructuredPatch,
  compactPhoneRecords,
  dateKeyFromTimestamp,
} from './character-phone-store.js';
import { maybeGrowCharacterPhoneMapForDailyPlan } from './character-phone-map-grower.js';
import {
  applyPhonePhotoImages,
  buildPhonePhotoRecordsImageRules,
  resolvePhoneAlbumImageGenMode,
} from './character-phone-photo-images.js';
import { getCharacterAiContextName } from '../models/character.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
  repairTranslationEntries,
  translationProfileBrief,
} from './translation-utils.js';
import { getUserDisplayName } from '../models/user.js';
import { isActiveWeiboPost } from './weibo/weibo-post-store.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import {
  findPrivateChat,
  listChatsForUser,
  listMessagesForChat,
  listMomentPostsForAuthor,
} from './chat-store.js';
import { listOfflineDateArchives } from './offline-date-archive.js';
import { loadMemoryWorkspace, pickMemoriesForScope } from './memory/memory-scope.js';
import {
  buildAnonymousSelfMemoryContext,
  buildAnonymousUserPrivateMemoryContext,
} from './memory/cross-chat-carry.js';
import { formatWeiboGlobalBatchesBlock } from './weibo/weibo-memory-sync.js';
import { resolveForumAuthorIdentity } from './forum-identity.js';
import { runDailyInterestRotationForCharacter } from './interest-search-orchestrator.js';
import * as db from './db.js';
import {
  loadRelationshipNetwork,
  collectCoNetworkMemberIds,
  collectGlobalRelationshipNetworkLines,
} from './relationship-network.js';
import { listCharacters } from './character-store.js';
import { loadContactGroupsConfig, resolveCharacterGroupId } from './contact-groups.js';
import { canPhoneCharactersKnowEachOther } from './phone-social-eligibility.js';
import { loadAcquaintanceLedger } from './acquaintance-ledger.js';
import {
  buildIdentitySocialDirective,
} from './character-social-context.js';
import { isStrangerInterceptChat } from './stranger-thread-model.js';
import { collectCharacterPhoneCurrentContext } from './character-phone-current-context.js';
import { loadCharacterProgressResetAt } from './character-progress-reset-state.js';

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (_) {}
  try {
    // 常见瑕疵：尾随逗号 / 中文逗号误用，做一次轻量修复再试
    const relaxed = slice
      .replace(/，/g, ',')
      .replace(/：/g, ':')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(relaxed);
  } catch (_) {
    return null;
  }
}

const PHONE_PATCH_KEYS = [
  'notes', 'browserRecords', 'photoRecords', 'callRecords', 'musicRecords',
  'interestRecords', 'avatarLibrary', 'preferences', 'lifeIntents',
  'mapPins', 'mapItineraries', 'currentMapState', 'routeState',
];

export const PHONE_RECORD_SCOPE_FULL = 'full';

/** 子页面「批量生成」只补对应区域；主屏「补记录」走 full 全量 */
export const PHONE_RECORD_SCOPES = {
  browser: { label: '浏览器记录', fields: ['browserRecords'] },
  photos: { label: '相册记录', fields: ['photoRecords'] },
  calls: { label: '通话记录', fields: ['callRecords'] },
  music: { label: '音乐记录', fields: ['musicRecords'] },
  interests: { label: '兴趣记录', fields: ['interestRecords', 'preferences'] },
  map: { label: '地图候选', fields: ['mapPins', 'mapItineraries', 'lifeIntents'] },
};

const PHONE_RECORD_FULL_FIELDS = [
  'browserRecords', 'photoRecords', 'callRecords', 'musicRecords',
  'interestRecords', 'preferences', 'lifeIntents',
  'mapPins', 'mapItineraries', 'notes',
];

export function resolvePhoneRecordScope(scope) {
  const key = String(scope || PHONE_RECORD_SCOPE_FULL).trim();
  if (!key || key === PHONE_RECORD_SCOPE_FULL) return PHONE_RECORD_SCOPE_FULL;
  return PHONE_RECORD_SCOPES[key] ? key : PHONE_RECORD_SCOPE_FULL;
}

export function getPhoneRecordScopeLabel(scope) {
  const resolved = resolvePhoneRecordScope(scope);
  if (resolved === PHONE_RECORD_SCOPE_FULL) return '手机记录';
  return PHONE_RECORD_SCOPES[resolved]?.label || '手机记录';
}

function scopeFields(scope) {
  const resolved = resolvePhoneRecordScope(scope);
  if (resolved === PHONE_RECORD_SCOPE_FULL) return PHONE_RECORD_FULL_FIELDS;
  return PHONE_RECORD_SCOPES[resolved].fields;
}

function scopeNeedsInterestSearch(scope) {
  const resolved = resolvePhoneRecordScope(scope);
  return resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'browser' || resolved === 'interests';
}

function scopeNeedsMapGrow(scope) {
  const resolved = resolvePhoneRecordScope(scope);
  return resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'map';
}

function scopeNeedsPhotoImages(scope) {
  const resolved = resolvePhoneRecordScope(scope);
  return resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'photos';
}

function pickScopedPatch(patch, scope) {
  const resolved = resolvePhoneRecordScope(scope);
  const fields = scopeFields(resolved);
  const picked = { source: patch.source };
  for (const field of fields) {
    if (patch[field] == null) continue;
    if (field === 'preferences') {
      if (typeof patch.preferences === 'object') picked.preferences = patch.preferences;
      continue;
    }
    if (field === 'currentMapState' || field === 'routeState') {
      if (typeof patch[field] === 'object' && Object.keys(patch[field]).length) picked[field] = patch[field];
      continue;
    }
    picked[field] = patch[field];
  }
  return picked;
}

/** 模型有时会把记录包在 data/result/records 等外层里，这里向下钻一层找到真正的载荷 */
function unwrapPatchPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const hasTopLevel = PHONE_PATCH_KEYS.some((k) => parsed[k] != null);
  if (hasTopLevel) return parsed;
  for (const key of ['data', 'result', 'records', 'phone', 'phoneRecords', 'output', 'payload']) {
    const inner = parsed[key];
    if (inner && typeof inner === 'object' && PHONE_PATCH_KEYS.some((k) => inner[k] != null)) {
      return inner;
    }
  }
  return parsed;
}

function patchIsEmpty(patch = {}, { fields = null } = {}) {
  const arrayKeys = (fields || PHONE_RECORD_FULL_FIELDS).filter(
    (k) => !['preferences', 'currentMapState', 'routeState'].includes(k),
  );
  const hasArray = arrayKeys.some((k) => asArray(patch[k]).length);
  const checkPrefs = !fields || fields.includes('preferences');
  const hasPrefs = checkPrefs && patch.preferences && Object.values(patch.preferences).some((v) => asArray(v).length);
  const checkMapState = !fields || fields.includes('currentMapState') || fields.includes('routeState');
  const hasMapState = checkMapState && (
    (patch.currentMapState && Object.keys(patch.currentMapState).length)
    || (patch.routeState && Object.keys(patch.routeState).length)
  );
  return !hasArray && !hasPrefs && !hasMapState;
}

function clip(value = '', max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function characterBrief(character) {
  const lp = character?.lifeProfile || {};
  const ra = character?.residenceAnchor || {};
  const translation = translationProfileBrief(character?.translationProfile);
  return {
    id: character?.id || '',
    name: getCharacterAiContextName(character),
    personality: character?.personality || '',
    speechStyle: character?.speechStyle || '',
    currentRole: character?.currentRole || '',
    currentStatus: character?.currentStatus || '',
    notes: character?.notes || '',
    city: ra.city || '',
    area: ra.area || '',
    habits: lp.habits || '',
    activitySeeds: lp.activitySeeds || '',
    ...(translation ? { translation } : {}),
  };
}

function platformSearchUrl(platform, query) {
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return '';
  const key = String(platform || '').toLowerCase();
  if (key === 'bilibili' || key === 'b站') return `https://search.bilibili.com/all?keyword=${q}`;
  if (key === 'zhihu' || key === '知乎') return `https://www.zhihu.com/search?type=content&q=${q}`;
  if (key === 'weibo' || key === '微博') return `https://s.weibo.com/weibo?q=${q}`;
  if (key === 'douban' || key === '豆瓣') return `https://www.douban.com/search?q=${q}`;
  return `https://www.baidu.com/s?wd=${q}`;
}

function normalizeBrowserRecord(item, index, now) {
  if (!item || typeof item !== 'object') return null;
  const linkType = ['real', 'fictional', 'platform_search', 'weibo_hot', 'forum_post'].includes(item.linkType)
    ? item.linkType
    : 'fictional';
  const platform = clip(item.platform || item.sourceName || '', 40);
  const query = clip(item.query || item.keyword || item.title || '', 80);
  const url = (linkType === 'weibo_hot' || linkType === 'forum_post')
    ? ''
    : linkType === 'platform_search'
      ? platformSearchUrl(platform, query)
    : clip(item.url || '', 500);
  const defaultSource = linkType === 'forum_post'
    ? '站内论坛'
    : (linkType === 'fictional' ? '本地网页' : '网页');
  return {
    ...item,
    id: item.id || `browse_${now}_${index}`,
    linkType,
    sourceName: clip(item.sourceName || platform || defaultSource, 40),
    query,
    url,
    weiboAuthorName: clip(item.weiboAuthorName || item.weiboAuthor || '', 40),
    weiboAuthorType: clip(item.weiboAuthorType || '', 24),
    forumSection: clip(item.forumSection || item.section || '', 40),
    forumAuthorName: clip(item.forumAuthorName || item.forumAuthor || '', 40),
    forumAuthorType: clip(item.forumAuthorType || '', 24),
    visitedAt: Number(item.visitedAt || 0) || now - index * 29 * 60 * 1000,
    createdAt: Number(item.createdAt || 0) || now,
  };
}

function normalizeMusicRecord(item, index, now) {
  if (!item || typeof item !== 'object') return null;
  const title = clip(item.title || item.songName || '', 100);
  const artist = clip(item.artist || item.singer || '', 100);
  if (!title || !artist) return null;
  return {
    ...item,
    id: item.id || `music_${now}_${index}`,
    title,
    artist,
    platform: '网易云音乐',
    provider: 'netease',
    searchQuery: clip(item.searchQuery || `${title} ${artist}`, 180),
    url: '',
  };
}

function normalizePatch(rawParsed, now) {
  const parsed = unwrapPatchPayload(rawParsed);
  if (!parsed || typeof parsed !== 'object') throw new Error('AI 未返回有效 JSON');
  return {
    source: 'phoneBatchGenerator',
    notes: asArray(parsed.notes),
    browserRecords: asArray(parsed.browserRecords).map((item, i) => normalizeBrowserRecord(item, i, now)).filter(Boolean),
    photoRecords: asArray(parsed.photoRecords),
    callRecords: asArray(parsed.callRecords),
    musicRecords: asArray(parsed.musicRecords).map((item, i) => normalizeMusicRecord(item, i, now)).filter(Boolean),
    interestRecords: asArray(parsed.interestRecords),
    // 头像库只收用户自己上传/替换的图，批量生成不再产出头像备选
    avatarLibrary: [],
    preferences: parsed.preferences && typeof parsed.preferences === 'object' ? parsed.preferences : {},
    lifeIntents: asArray(parsed.lifeIntents),
    mapPins: asArray(parsed.mapPins),
    mapItineraries: asArray(parsed.mapItineraries),
    currentMapState: parsed.currentMapState && typeof parsed.currentMapState === 'object' ? parsed.currentMapState : null,
    routeState: parsed.routeState && typeof parsed.routeState === 'object' ? parsed.routeState : null,
    // 联系人身份不再由手机记录生成器创建；统一走隔离的联系人/社会面链路。
    phoneContacts: null,
  };
}

function buildScopeTaskLine(scope, who, you) {
  const resolved = resolvePhoneRecordScope(scope);
  if (resolved === PHONE_RECORD_SCOPE_FULL) {
    return `任务：为角色 ${who} 批量生成 TA 手机里的生活痕迹，并顺手整理本轮可沉淀的兴趣、地图规划备注和地点候选。但绝对不要生成、改写或覆盖日程/dailyLifePlan/blocks。`;
  }
  const label = getPhoneRecordScopeLabel(resolved);
  const fields = scopeFields(resolved).join('、');
  return `任务：为角色 ${who} 只补「${label}」。本次只输出 ${fields} 相关字段，不要输出其他顶层字段；绝对不要生成、改写或覆盖日程/dailyLifePlan/blocks。`;
}

function buildScopeCountHints(scope, you, imageGenRules = '') {
  const resolved = resolvePhoneRecordScope(scope);
  const lines = [];
  const add = (line) => { if (line) lines.push(line); };

  if (resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'browser') {
    add('- browserRecords 6~12 条，其中至少 3 条 platform_search/weibo_hot，至少 1 条 forum_post，至少 2 条 fictional。');
  }
  if (resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'photos') {
    add('- photoRecords 3~6 条；按下方配图规则写 wantsImage / imagePrompt / textImageCaption / imagePeople / imageIdentity，不必真的有 imageUrl。');
    if (imageGenRules && resolved === 'photos') add(imageGenRules);
  }
  if (resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'calls') {
    add('- callRecords 2~5 条。');
  }
  if (resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'music') {
    add(`- musicRecords 3~8 条：只选网易云音乐可搜索到的真实发行歌曲，title 与 artist 必须是真实且能对应的歌名、歌手；不要虚构歌名、歌手、专辑或歌曲外链。选曲贴 TA 的人设、心情与近期生活线索，可以自然形成一个小主题；不要照搬 ${you}（用户）的歌单或口味，除非 TA 明确是因为 ${you} 才去听的（在 note 写清缘由）。`);
  }
  if (resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'interests') {
    add('- interestRecords 5~10 条；先对照 existingPhoneRecords.interestRecords，禁止把已有兴趣换个标题继续增生。同一具体作品/人物/店铺/子话题本轮最多写 1 条，并尽量覆盖不同类别、不同母话题；没有新信号就少写，不要凑数。');
    add('- preferences 合并本轮明确偏好：food/media/places/shopping/study/dislikes，每类 0~6 个短词。');
  }
  if (resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'map') {
    add('- lifeIntents 2~6 条，用来记录「想去/想查/想收藏/想避开」的生活意图；地图相关意图优先写 kind="map_interest" 或 kind="trip_idea"，必须写 aiJudgement 表示 TA 自己为什么这样判断。');
    add('- mapPins 0~6 条：只写文本候选地点，可无坐标；有真实把握才写城市/区域/地址，不要编造经纬度。必须给 relationStatus/visitVerdict/aiJudgement：区分去过、没去过、想去、去了避雷、下次还能去、待观察。existingMap.mapPins 里已经带了历史 relationStatus/visitVerdict：同一地点不要凭空改口，除非确实有新进展要写成 revisit。优先补充新地点，而不是重复罗列已有的。');
    add('- mapItineraries 0~2 条：只写轻量候选路线/攻略，不要改日程。stops 2~5 个，每个包含 placeName/visitHint/city 可选。');
    add('- 地图只补历史痕迹和未来候选，绝对不要输出 currentMapState / routeState，也不要声称 TA 此刻已经到达某个候选地点。');
  }
  if (resolved === PHONE_RECORD_SCOPE_FULL) {
    add('- notes 0~4 条；地图规划备注可写 tags:["map_planning"]。');
    if (imageGenRules) add(imageGenRules);
  }
  return lines.join('\n');
}

function buildScopeJsonSchema(scope) {
  const resolved = resolvePhoneRecordScope(scope);
  const fields = scopeFields(resolved);
  const parts = [];
  if (fields.includes('browserRecords')) {
    parts.push(`  "browserRecords": [
    {
      "linkType": "fictional|platform_search|weibo_hot|forum_post|real",
      "platform": "bilibili|zhihu|weibo|douban|baidu|可空",
      "title": "...",
      "sourceName": "...",
      "query": "...",
      "url": "",
      "summary": "...",
      "body": "fictional/forum_post 详情正文，真实链接可短一些",
      "zh": "外语 body/本人自评才需要",
      "weiboAuthorType": "weibo_hot 必填：self|media|marketing|org|fan",
      "weiboAuthorName": "非 self 时写：如 中央气象台 / XX资讯",
      "forumSection": "forum_post 可写板块名",
      "forumAuthorType": "forum_post 必填：self|stranger|official",
      "forumAuthorName": "非 self 时写：伪装ID/昵称",
      "aiJudgement": "TA 看完后自己的判断：收藏/观望/避雷/想继续查/只是路过",
      "tags": ["..."]
    }
  ]`);
  }
  if (fields.includes('photoRecords')) {
    parts.push('  "photoRecords": [{"title":"文字记录示例","caption":"...","wantsImage":false,"location":"...","tags":["..."]},{"title":"配图记录示例","caption":"...","zh":"外语 caption 才需要","wantsImage":true,"imagePrompt":"...","imagePeople":"portrait|partial|none","imageIdentity":"self|user|both|other|none","textImageCaption":"标题\\n具体画面描述","location":"...","tags":["..."]}]');
  }
  if (fields.includes('callRecords')) {
    parts.push('  "callRecords": [{"contactName":"...","direction":"incoming|outgoing|missed","durationText":"...","summary":"...","zh":"外语 summary 才需要"}]');
  }
  if (fields.includes('musicRecords')) {
    parts.push('  "musicRecords": [{"title":"网易云可搜到的真实歌名","artist":"真实歌手名","platform":"网易云音乐","searchQuery":"歌名 歌手","mood":"...","note":"..."}]');
  }
  if (fields.includes('interestRecords')) {
    parts.push('  "interestRecords": [{"category":"...","title":"...","detail":"...","zh":"外语 detail 才需要","strength":"弱|中|强","aiJudgement":"TA 对这个兴趣信号的判断","aiJudgementZh":"外语 aiJudgement 才需要","tags":["..."]}]');
  }
  if (fields.includes('preferences')) {
    parts.push('  "preferences": {"food":["..."],"media":["..."],"places":["..."],"shopping":["..."],"study":["..."],"dislikes":["..."]}');
  }
  if (fields.includes('lifeIntents')) {
    parts.push('  "lifeIntents": [{"kind":"map_interest|trip_idea|search|avoid","query":"...","action":"save_note|search_nearby|plan_route","status":"want_to_go|avoid|revisit|maybe","city":"...","anchor":"...","target":"...","reason":"...","aiJudgement":"TA 自己的判断","shareHint":"..."}]');
  }
  if (fields.includes('mapPins')) {
    parts.push('  "mapPins": [{"placeName":"...","city":"...","district":"...","address":"...","sourceQuery":"...","bucket":"food|shopping|commute|leisure|service|other","bucketLabel":"...","affinity":0.6,"relationStatus":"visited|unvisited|want_to_go|avoid|revisit|maybe","visitVerdict":"去过/没去过/想去/去了避雷/下次还能去/待观察","aiJudgement":"TA 对这个地点的判断","zh":"外语 aiJudgement 才需要","nextAction":"收藏/下次路过/约人去/避开/再查","nextActionZh":"外语 nextAction 才需要","tags":["map","ai_candidate"]}]');
  }
  if (fields.includes('mapItineraries')) {
    parts.push('  "mapItineraries": [{"title":"...","city":"...","anchorName":"...","theme":"...","summary":"...","stops":[{"order":1,"placeName":"...","city":"...","district":"...","visitHint":"..."}]}]');
  }
  if (fields.includes('currentMapState')) {
    parts.push('  "currentMapState": {"city":"...","area":"...","placeName":"...","activity":"正在整理附近候选","target":"...","confidence":0.45,"source":"phoneBatchGenerator","tags":["map","ai_candidate"]}');
  }
  if (fields.includes('routeState')) {
    parts.push('  "routeState": {"origin":"...","destination":"...","mode":"walk","summary":"步行约 15 分钟"}');
  }
  if (fields.includes('notes')) {
    parts.push('  "notes": [{"title":"...","text":"...","zh":"外语 text 才需要","tags":["memo"]}]');
  }
  return `{\n${parts.join(',\n')}\n}`;
}

function buildScopeFieldRules(scope) {
  const resolved = resolvePhoneRecordScope(scope);
  const lines = [];
  const add = (line) => { if (line) lines.push(line); };

  if (resolved === PHONE_RECORD_SCOPE_FULL) {
    add('记录要像手机里真实留下的碎片：浏览器历史、相册、通话、音乐、兴趣信号、少量备忘录。不要写成关键词堆积。不要生成头像库/头像备选，头像库只放用户自己上传的图。');
  }

  if (resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'browser') {
    add('浏览器搜索词必须精细：不要只写“游戏/电影/音乐/吃饭/旅行/攻略”这类大词；至少包含具体品名、作品名、地点、平台、型号、菜名、店名、作者或事件。若上下文只显示用户/角色偏好任天堂、独立游戏、乙游等具体圈层，不要擅自塞入无关竞品或相反圈层；不确定就写“Switch 手柄漂移处理”“塞尔达料理配方”这类中性具体词，而不是泛泛“热门游戏”。');
    add('微博相关不要生成外部搜索链接；用 linkType="weibo_hot"，platform="weibo"，query 写话题关键词，点击后会进入站内微博话题。');
    add('【重要·发帖人归属】微博热搜/话题与论坛帖，记录的是 TA「看到/搜到」的内容，发帖人不一定是 TA 本人。');
    add('- weibo_hot 必须写 weiboAuthorType，取值之一：self / media / marketing / org / fan。非 self 时再写 weiboAuthorName。');
    add('- forum_post 写 forumAuthorType：self / stranger / official；非 self 时写 forumAuthorName。');
    add('- forumAuthorName 不得写 user、用户或当前用户显示名；角色只是看到帖子，不得虚构当前用户发帖。');
    add('浏览器记录类型：fictional / platform_search / weibo_hot / forum_post / real（只有能给出稳定真实 URL 时才用 real）。');
  }

  if (resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'music') {
    add('音乐记录只使用网易云音乐真实曲库：歌名和歌手必须真实对应；不知道是否真实存在就不要输出。platform 固定为“网易云音乐”，searchQuery 写“歌名 歌手”，不要生成任何歌曲外链。');
  }

  if (resolved === PHONE_RECORD_SCOPE_FULL || resolved === 'map') {
    add('地图相关内容只写「候选/备注/兴趣」，不要当成 TA 已经真的到达；具体真实 POI 可留给高德后续补全。');
  }

  return lines.join('\n');
}

function buildPhoneRecordsGuide({
  charName = 'TA',
  userName = '用户',
  imageGenRules = '',
  scope = PHONE_RECORD_SCOPE_FULL,
  translationPrompt = '',
  identitySocialDirective = '',
} = {}) {
  const who = String(charName || 'TA').trim() || 'TA';
  const you = String(userName || '用户').trim() || '用户';
  const resolved = resolvePhoneRecordScope(scope);
  const scopeOnly = resolved !== PHONE_RECORD_SCOPE_FULL;
  const countHints = buildScopeCountHints(scope, you, imageGenRules);
  const fieldRules = buildScopeFieldRules(scope);
  const jsonSchema = buildScopeJsonSchema(scope);
  const scopeOutputRule = scopeOnly
    ? `\n【本次输出范围·硬规则】只输出 ${scopeFields(resolved).join('、')}，JSON 顶层不要出现其他记录字段（例如不要顺带输出 browserRecords / musicRecords 等未列出的键）。`
    : '';
  const translationBlock = translationPrompt
    ? `\n${translationPrompt}\n- 手机主人若是外语人设：notes.text、callRecords.summary、browserRecords 里 self 视角的 body/aiJudgement、photoRecords.caption、interestRecords.detail/aiJudgement、mapPins.aiJudgement/nextAction 等「本人写下的话」按上面规则写外语原文并给 zh；其他纯元数据字段（歌名、地点名、兴趣词）不用翻译。\n`
    : '';
  return `【背景设定与生成要求】
你来扮演「角色手机记录」生成器。只输出一个合法 JSON 对象，不要 Markdown，不要解释。

【人称与归属·最高优先级，先读这一段】
- 这是「${who}」本人的手机。所有记录都是 ${who} 自己留下的痕迹，叙事主语永远是 ${who}（即下文所说的 TA）。
- 「${you}」是 ${who} 通讯录里的人（即用户本人），不是手机主人。绝对不要以 ${you}（用户）的视角写记录，不要把 ${you} 的经历、喜好、口吻当成 ${who} 的内容，也不要让 ${you} 取代 ${who} 成为这些记录的主角。
- 下文 recentChat / characterLife / 记忆里出现的「我 / 用户 / ${you}」都指 ${you} 本人；只能把它们当作 ${who} 认识、聊过、记挂的对象来引用，不能据此把手机主人换成 ${you}。
- ${you} 可以作为联系人出现在通话、合照、备忘里，但视角始终是「${who} 在用自己的手机记录与 ${you} 的往来」，而不是 ${you} 自己的手机。
- 【禁止虚构 ${you}】从 0 开始也一样：只能引用资料里已经出现的事实。禁止编造 ${you} 做过的事、说过的话、未发生的约会/冲突/约定，禁止替 ${you} 写行为或口吻。没有可靠信息时，优先只写 ${who} 自己的生活痕迹，少写或不写 ${you}。
${translationBlock}
${buildScopeTaskLine(scope, who, you)}
${scopeOutputRule}
${fieldRules ? `\n${fieldRules}` : ''}
${identitySocialDirective ? `\n${identitySocialDirective}` : ''}

数量建议：
${countHints}

【输出 JSON 格式】
${jsonSchema}`;
}

function messageToReadableLine(msg, charName, userName, characterId) {
  if (!msg || msg.deleted || msg.recalled) return '';
  const speaker = String(msg.senderId || '') === String(characterId) ? charName : userName;
  let text = '';
  if (msg.type === 'text' || !msg.type) {
    text = String(msg.content || '').trim();
  } else if (msg.type === 'image') {
    text = `[图片${msg.metadata?.caption ? `：${msg.metadata.caption}` : ''}]`;
  } else if (msg.type === 'sticker') {
    text = '[表情]';
  } else if (msg.type === 'voice') {
    text = `[语音${msg.metadata?.text ? `：${msg.metadata.text}` : ''}]`;
  } else {
    text = String(msg.metadata?.text || msg.metadata?.caption || msg.content || '').trim();
  }
  text = clip(text, 120);
  if (!text) return '';
  return `${speaker}：${text}`;
}

async function collectRecentChatContext({ userId, characterId, charName, userName }) {
  try {
    const resetAt = await loadCharacterProgressResetAt(userId, characterId).catch(() => 0);
    const lines = [];
    const seen = new Set();
    const pushFromMessages = (messages) => {
      for (const msg of messages || []) {
        if (resetAt && Number(msg?.timestamp || 0) <= resetAt) continue;
        const line = messageToReadableLine(msg, charName, userName, characterId);
        if (!line) continue;
        const key = `${msg.timestamp || 0}|${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push({ ts: Number(msg.timestamp || 0), line });
      }
    };
    const priv = await findPrivateChat(userId, characterId).catch(() => null);
    if (priv?.id) pushFromMessages(await listMessagesForChat(priv.id, 50).catch(() => []));
    if (lines.length < 12) {
      const chats = (await listChatsForUser(userId).catch(() => []))
        .filter((chat) => !isStrangerInterceptChat(chat)
          && Array.isArray(chat?.participants)
          && chat.participants.includes(characterId));
      for (const chat of chats.slice(0, 6)) {
        if (chat.id === priv?.id) continue;
        pushFromMessages(await listMessagesForChat(chat.id, 30).catch(() => []));
      }
    }
    return lines
      .sort((a, b) => a.ts - b.ts)
      .slice(-40)
      .map((item) => item.line);
  } catch (_) {
    return [];
  }
}

async function collectMomentsContext(userId, characterId) {
  try {
    const posts = await listMomentPostsForAuthor(userId, characterId);
    return asArray(posts)
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 12)
      .map((p) => {
        const body = clip(p.content || (p.chatShare?.title ? `[分享]${p.chatShare.title}` : ''), 120);
        if (!body) return '';
        const imgs = asArray(p.images).length ? `（配图${asArray(p.images).length}张）` : '';
        return `${body}${imgs}`;
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function collectWeiboContext(userId, characterId) {
  try {
    const rows = await db.getAllByIndex('weiboPosts', 'authorId', characterId).catch(() => []);
    return asArray(rows)
      .filter((p) => String(p?.ownerUserId || '') === String(userId || 'guest') && isActiveWeiboPost(p))
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 12)
      .map((p) => {
        const tags = asArray(p.tags).join(' ');
        const body = clip(p.content || '', 120);
        if (!body && !tags) return '';
        return `${body}${tags ? ` ${tags}` : ''}`.trim();
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function collectAnonWallContext(userId, characterId) {
  try {
    const row = await db.get('settings', `anonymousWallPosts_${userId || 'guest'}`).catch(() => null);
    const list = asArray(row?.value);
    return list
      .filter((post) => String(post?.authorActorId || '') === String(characterId)
        || String(post?.targetActorId || '') === String(characterId))
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 8)
      .map((post) => {
        const role = String(post?.authorActorId || '') === String(characterId) ? 'TA发的' : '关于TA';
        const body = clip(post.content || '', 110);
        return body ? `[${role}] ${body}` : '';
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function collectForumContext(userId, characterId, characters = {}) {
  try {
    const rows = await db.getAllByIndex('forumThreads', 'userId', userId).catch(() => []);
    return asArray(rows)
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .map((thread) => {
        const author = resolveForumAuthorIdentity(thread, characters);
        const ownThread = String(author.authorRoleId || '') === String(characterId);
        const ownReplies = asArray(thread.replies).filter((reply) => {
          const ident = resolveForumAuthorIdentity(reply, characters);
          return String(ident.authorRoleId || '') === String(characterId);
        });
        if (!ownThread && !ownReplies.length) return '';
        const title = clip(thread.title || '无标题', 70);
        const body = ownThread ? clip(thread.content || '', 150) : '';
        const replies = ownReplies
          .slice(-3)
          .map((reply) => clip(reply.content || reply.body || reply.text || '', 100))
          .filter(Boolean);
        if (ownThread) {
          return `[TA发帖｜${author.authorAlias || author.authorName || '论坛马甲'}] ${title}${body ? `：${body}` : ''}${replies.length ? `；TA后续回复：${replies.join(' / ')}` : ''}`;
        }
        return `[TA参与回复] ${title}：${replies.join(' / ')}`;
      })
      .filter(Boolean)
      .slice(0, 10);
  } catch (_) {
    return [];
  }
}

async function collectOfflineArchiveContext(userId, characterId) {
  try {
    const archives = await listOfflineDateArchives(userId, { characterId });
    return asArray(archives)
      .slice(0, 6)
      .map((a) => {
        const head = clip(a.title || a.scene || '线下相处', 40);
        const body = clip(a.summary || '', 120);
        return body ? `${head}：${body}` : head;
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function collectMemoryContext(userId, characterId) {
  try {
    const ws = await loadMemoryWorkspace(userId);
    const picked = pickMemoriesForScope(ws, characterId);
    const traits = asArray(picked.characterTraits).slice(0, 10).map((f) => clip(f.content || '', 110)).filter(Boolean);
    const summaries = asArray(picked.summaries).slice(0, 6).map((m) => clip(m.content || '', 120)).filter(Boolean);
    const events = asArray(picked.events).slice(0, 6).map((e) => clip(e.summary || e.highlight || '', 110)).filter(Boolean);
    return { traits, summaries, events };
  } catch (_) {
    return { traits: [], summaries: [], events: [] };
  }
}

async function buildGenerationContext({
  user,
  character,
  phone,
  characterId,
  now = Date.now(),
}) {
  const charName = getCharacterAiContextName(character) || character?.name || 'TA';
  const userName = getUserDisplayName(user);
  const userId = user?.id || '';
  const cid = String(characterId || '').trim();
  const [
    recentChat,
    moments,
    weibo,
    anonWall,
    offlineArchives,
    memory,
    allCharacters,
    relationshipNet,
    contactGroupsConfig,
    acquaintanceLedger,
    currentContext,
  ] = await Promise.all([
    collectRecentChatContext({ userId, characterId, charName, userName }),
    collectMomentsContext(userId, characterId),
    collectWeiboContext(userId, characterId),
    collectAnonWallContext(userId, characterId),
    collectOfflineArchiveContext(userId, characterId),
    collectMemoryContext(userId, characterId),
    listCharacters({ includeInternal: true, userId, identityScoped: true }).catch(() => []),
    loadRelationshipNetwork(userId).catch(() => null),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadAcquaintanceLedger().catch(() => ({ entries: [] })),
    collectCharacterPhoneCurrentContext({
      userId,
      characterId,
      character,
      phone,
      now,
    }),
  ]);
  const charMap = new Map((allCharacters || []).map((row) => [row.id, row]));
  const charactersById = Object.fromEntries(charMap);
  const nameById = new Map((allCharacters || []).map((row) => [
    row.id,
    getCharacterAiContextName(row) || row?.name || row.id,
  ]));
  const ownerGroupId = resolveCharacterGroupId(character);
  const relatedSet = new Set();
  const addRelated = (id) => {
    const key = String(id || '').trim();
    if (!key || key === cid || key === 'user' || !charMap.has(key)) return;
    if (!canPhoneCharactersKnowEachOther(
      character,
      charMap.get(key),
      relationshipNet,
      contactGroupsConfig,
      acquaintanceLedger,
    )) return;
    relatedSet.add(key);
  };
  for (const row of allCharacters || []) {
    if (ownerGroupId && resolveCharacterGroupId(row) === ownerGroupId) addRelated(row.id);
  }
  for (const id of collectCoNetworkMemberIds(relationshipNet, [cid])) addRelated(id);
  const ownerRel = character?.relationships && typeof character.relationships === 'object'
    ? character.relationships
    : {};
  for (const id of Object.keys(ownerRel)) addRelated(id);
  const relatedCharacterIds = [...relatedSet].slice(0, 14);
  const knownCharacters = relatedCharacterIds.map((id) => {
    const row = charMap.get(id);
    return {
      id,
      name: nameById.get(id) || id,
      persona: clip(row?.personality || '', 120),
      currentRole: clip(row?.currentRole || '', 60),
      withUser: clip(row?.userRelationStatus || '', 80),
      relationship: clip(
        (row?.relationships && typeof row.relationships === 'object'
          ? row.relationships[cid]
          : '') || '',
        80,
      ),
    };
  });
  const preferredNetworkGroups = [];
  if (relationshipNet) {
    for (const circle of relationshipNet.circles || []) {
      for (const group of circle.groups || []) {
        const members = (group.memberIds || []).map((id) => String(id || '').trim()).filter(Boolean);
        if (!members.includes(cid)) continue;
        const others = members.filter((id) => id !== cid && id !== 'user' && charMap.has(id));
        if (others.length < 1) continue;
        preferredNetworkGroups.push({
          name: String(group.name || circle.name || '关系网小群').trim().slice(0, 30),
          memberIds: others.slice(0, 8),
          members: others.slice(0, 8).map((id) => ({ id, name: nameById.get(id) || id })),
        });
        if (preferredNetworkGroups.length >= 6) break;
      }
      if (preferredNetworkGroups.length >= 6) break;
    }
  }
  const relationshipNetwork = relationshipNet
    ? collectGlobalRelationshipNetworkLines(relationshipNet, {
      partnerIds: [cid, ...relatedCharacterIds],
      characters: Object.fromEntries(charMap),
      userName,
      maxEdges: 16,
      includeUser: false,
    }).slice(0, 16)
    : [];
  const sourceChat = await findPrivateChat(userId, characterId).catch(() => null);
  const [forum, anonymousChatMemory, weiboTimeline] = await Promise.all([
    collectForumContext(userId, characterId, charactersById),
    sourceChat
      ? Promise.all([
        buildAnonymousSelfMemoryContext({
          chat: sourceChat,
          user,
          characterIds: [cid],
          characters: charactersById,
          excludeUserPrivate: true,
        }),
        buildAnonymousUserPrivateMemoryContext({
          chat: sourceChat,
          user,
          characterIds: [cid],
          characters: charactersById,
        }),
      ]).then((parts) => parts.filter(Boolean).join('\n\n')).catch(() => '')
      : Promise.resolve(''),
    formatWeiboGlobalBatchesBlock(userId).catch(() => ''),
  ]);
  const selectiveText = [
    charName,
    character?.personality || '',
    character?.currentRole || '',
    asArray(phone?.interestRecords).map((r) => r.title || r.category || '').join(' '),
    recentChat.join(' '),
    moments.join(' '),
    weibo.join(' '),
    forum.join(' '),
    anonymousChatMemory,
    weiboTimeline,
    anonWall.join(' '),
    offlineArchives.join(' '),
    memory.traits.join(' '),
    knownCharacters.map((row) => row.name).join(' '),
  ].filter(Boolean).join(' ').slice(0, 5000);
  let worldBook = '';
  try {
    worldBook = await buildWorldBookContextBlock(user || null, selectiveText, {
      characterIds: [characterId, ...relatedCharacterIds],
      worldBookMode: 'selective',
    });
  } catch (_) {
    worldBook = '';
  }
  return {
    userName,
    userPersona: clip(user?.persona || '', 600),
    recentChat,
    worldBook: clip(worldBook, 4000),
    moments,
    weibo,
    weiboTimeline: clip(weiboTimeline, 3200),
    forum,
    anonWall,
    anonymousChatMemory: clip(anonymousChatMemory, 4200),
    offlineArchives,
    memoryTraits: memory.traits,
    memorySummaries: memory.summaries,
    memoryEvents: memory.events,
    knownCharacters,
    preferredNetworkGroups,
    relationshipNetwork,
    currentContext,
  };
}

function buildUserPayload({ user, character, phone, dateKey, countMode, context = {} }) {
  const charName = characterBrief(character).name || getCharacterAiContextName(character) || 'TA';
  const userName = context.userName || getUserDisplayName(user);
  const records = compactPhoneRecords(phone);
  const brief = {};
  for (const [key, list] of Object.entries(records)) {
    const historyLimit = key === 'interestRecords' ? 24 : 6;
    brief[key] = asArray(list).slice(0, historyLimit).map((item) => ({
      title: item.title || item.contactName || item.text || '',
      sourceName: item.sourceName || item.platform || '',
      summary: item.summary || item.caption || item.detail || item.note || '',
      category: item.category || '',
      tags: asArray(item.tags).slice(0, 5),
      createdAt: item.createdAt || item.visitedAt || item.updatedAt || '',
    }));
  }
  return JSON.stringify({
    dateKey,
    countMode,
    user: {
      id: user?.id || '',
      name: context.userName || getUserDisplayName(user),
      persona: context.userPersona || '',
    },
    character: characterBrief(character),
    currentContext: context.currentContext || {},
    worldBook: context.worldBook || '',
    recentChat: asArray(context.recentChat),
    characterLife: {
      memoryTraits: asArray(context.memoryTraits),
      memorySummaries: asArray(context.memorySummaries),
      recentEvents: asArray(context.memoryEvents),
      momentsPosts: asArray(context.moments),
      weiboPosts: asArray(context.weibo),
      weiboTimeline: context.weiboTimeline || '',
      forumActivity: asArray(context.forum),
      anonymousWall: asArray(context.anonWall),
      anonymousChatMemory: context.anonymousChatMemory || '',
      offlineDates: asArray(context.offlineArchives),
    },
    knownCharacters: asArray(context.knownCharacters),
    preferredNetworkGroups: asArray(context.preferredNetworkGroups),
    relationshipNetwork: asArray(context.relationshipNetwork),
    contextNote: `这部手机的主人是「${charName}」（即下文的 TA）；「${userName}」是 TA 通讯录里的用户本人，不是手机主人。currentContext 是生成时已经成立的当前事实，优先级最高，只用于防止补历史记录与现实冲突，绝不能被补记录改写。worldBook、recentChat、characterLife 是人设与近期生活线索；生成内容要与它们连续，但不得把推测、旧记录或关系网社交线升级成当前事实。所有手机记录、搜索词、兴趣、地点候选、备忘都要以 ${charName} 为主语。匿名聊天内容沿用普通聊天的知情边界：TA 记得自己说过和经历过什么，但不能因此识破匿名对象现实身份。recentChat 与 characterLife 里的「我/用户/${userName}」都是用户本人，只能作为 ${charName} 认识、聊过的对象引用，绝不能把这些内容改写成以 ${userName} 为主角、或从用户视角写的手机记录。若生成 phoneContacts：主要联系人与群成员必须优先复用 knownCharacters / preferredNetworkGroups 里的真角色 id，禁止同名替身。`,
    verifiedMaterials: asArray(context.verifiedMaterials),
    existingPhoneRecords: brief,
    existingMap: {
      mapPins: asArray(phone?.mapPins).slice(0, 12).map((pin) => ({
        placeName: pin.placeName || '',
        city: pin.city || '',
        district: pin.district || '',
        sourceQuery: pin.sourceQuery || '',
        bucketLabel: pin.bucketLabel || pin.bucket || '',
        relationStatus: pin.relationStatus || '',
        visitVerdict: pin.visitVerdict || '',
      })),
      mapItineraries: asArray(phone?.mapItineraries).slice(0, 4).map((item) => ({
        title: item.title || '',
        city: item.city || '',
        theme: item.theme || '',
        stops: asArray(item.stops).slice(0, 5).map((stop) => stop.placeName || '').filter(Boolean),
      })),
      lifeIntents: asArray(phone?.lifeIntents).slice(0, 10).map((item) => ({
        kind: item.kind || '',
        query: item.query || '',
        city: item.city || '',
        target: item.target || '',
        reason: item.reason || '',
      })),
      preferences: phone?.preferences || {},
    },
    hardRules: [
      `【人称硬规则·最重要】所有记录都是「${charName}」本人手机里的痕迹，主语永远是 ${charName}（TA）；严禁以用户（${userName}）视角生成，严禁把用户的经历、喜好或口吻写成 ${charName} 的记录。用户只能作为 ${charName} 认识的联系人出现，不能成为手机主人或记录主角。`,
      '【当前事实硬规则】currentContext 的 runtime / activeOffline / schedule 是高优先级当前事实。补记录只能补此前留下的历史痕迹或明确标为候选的想法，不得让 TA 同时出现在别处，不得生成与当前同行、地点、活动相冲突的已发生行动，也不得用常住地、关系网或旧记录覆盖当前事实。',
      '生成内容必须贴合 worldBook 设定、recentChat 最近聊天与 characterLife（朋友圈/微博/论坛/匿名墙/匿名聊天/记忆/线下经历）：延续 TA 已经表达过的关注点、话题、人物、地点、计划与情绪，不要写出与人设或上述记录矛盾的内容；匿名经历只影响 TA 自己的心理连续性，不得识破匿名对象。',
      '不要输出 dailyLifePlan、dailyLifePlans、blocks、schedule、currentMapState 或 routeState 字段；地图只能写 mapPins / mapItineraries / lifeIntents，且只能表示历史判断或未来候选，不能表示此刻状态。',
      '浏览器不是关键词表；每条都要有标题、来源、摘要，fictional 要有可阅读 body。',
      '真实链接优先输出平台搜索 query，不要编造不存在的具体内容链接；query 必须具体到作品/品名/地点/型号/事件，禁止泛搜“游戏/攻略/音乐/电影”。',
      '微博相关一律用 linkType="weibo_hot"，不要生成 s.weibo.com 外链。',
      '浏览记录、兴趣记录、地图钉、生活意图都要写 TA 自己的判断 aiJudgement；地图钉必须写 relationStatus/visitVerdict，不能只堆地点名。',
      '地图候选没有高德坐标时不要编造 location；placeName/sourceQuery/visitHint 可以先写文本。',
      ...(asArray(context.verifiedMaterials).length
        ? ['verifiedMaterials 是真实网络搜索到的素材：browserRecords 优先据此各写 1~2 条（有 url 的用 linkType="real" 并照抄 url，没有 url 的写成 platform_search）；interestRecords 每份素材最多衍生 1 条，且仍须避开已有具体子话题。标题/摘要要贴着素材原文写，复述细节时绝不能编造素材里没提到的信息。']
        : []),
    ],
  }, null, 2);
}

function countMapItems(phone = {}) {
  return asArray(phone.mapPins).length
    + asArray(phone.mapItineraries).length
    + asArray(phone.lifeIntents).filter((item) => /map|trip|route|nearby|poi|interest/i.test(String(item?.kind || item?.action || ''))).length
    + (phone.currentMapState && Object.keys(phone.currentMapState).length ? 1 : 0)
    + (phone.routeState && Object.keys(phone.routeState).length ? 1 : 0);
}

function buildMapGrowContextFromPatch(patch = {}) {
  const parts = [];
  for (const item of asArray(patch.interestRecords)) {
    parts.push([item.category, item.title, item.detail, asArray(item.tags).join(' ')].filter(Boolean).join(' '));
  }
  for (const item of asArray(patch.browserRecords)) {
    parts.push([item.query, item.title, item.summary].filter(Boolean).join(' '));
  }
  for (const item of asArray(patch.photoRecords)) {
    parts.push([item.location, item.title, item.caption].filter(Boolean).join(' '));
  }
  for (const item of asArray(patch.lifeIntents)) {
    parts.push([item.kind, item.query, item.city, item.anchor, item.target, item.reason].filter(Boolean).join(' '));
  }
  for (const item of asArray(patch.mapItineraries)) {
    parts.push([item.title, item.theme, item.summary, asArray(item.stops).map((stop) => stop?.placeName || stop?.visitHint || '').join(' ')].filter(Boolean).join(' '));
  }
  const prefs = patch.preferences && typeof patch.preferences === 'object' ? patch.preferences : {};
  for (const list of Object.values(prefs)) parts.push(asArray(list).join(' '));
  return parts.join('\n').slice(0, 2400);
}

export async function generateCharacterPhoneRecords({
  userId,
  characterId,
  character,
  user,
  countMode = 'standard',
  scope = PHONE_RECORD_SCOPE_FULL,
  signal = null,
  onProgress = null,
} = {}) {
  const uid = String(userId || user?.id || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!uid || !cid) throw new Error('缺少用户或角色');
  const resolvedScope = resolvePhoneRecordScope(scope);
  const fields = scopeFields(resolvedScope);
  onProgress?.('正在整理人设、记忆和已有记录…');
  const now = await getNowForUser(uid);
  const timeZone = await resolveCharacterScheduleTimezone(uid, cid, character).catch(() => '');
  const dateKey = dateKeyFromTimestamp(now, timeZone);
  let phone = await loadCharacterPhone(uid, cid);
  const context = await buildGenerationContext({
    user,
    character,
    phone,
    characterId: cid,
    now,
  });
  if (scopeNeedsInterestSearch(resolvedScope)) {
    onProgress?.('正在收集近期兴趣和生活素材…');
    try {
      const { materials } = await runDailyInterestRotationForCharacter({ userId: uid, characterId: cid, character, signal });
      if (materials.length) context.verifiedMaterials = materials.slice(0, 6);
    } catch (err) {
      console.warn('[character-phone-records] interest search round failed', err);
    }
  }
  const charName = getCharacterAiContextName(character) || character?.name || 'TA';
  const userName = context.userName || getUserDisplayName(user);
  const imageGenMode = await resolvePhoneAlbumImageGenMode().catch(() => '');
  const imageGenRules = buildPhonePhotoRecordsImageRules(imageGenMode);
  const taskPayload = buildUserPayload({ user, character, phone, dateKey, countMode, context });
  const translationPrompt = buildJsonFieldTranslationPromptBlock(
    collectTranslationActors([{
      id: cid,
      name: charName,
      translationProfile: character?.translationProfile,
    }]),
    { fields: 'notes.text / callRecords.summary / caption / body / aiJudgement / interest.detail / mapPin.nextAction', exampleField: 'text' },
  );
  const guide = buildPhoneRecordsGuide({
    charName,
    userName,
    imageGenRules,
    scope: resolvedScope,
    translationPrompt,
    identitySocialDirective: buildIdentitySocialDirective(character, charName),
  });
  const scopeLabel = getPhoneRecordScopeLabel(resolvedScope);
  const taskIntro = resolvedScope === PHONE_RECORD_SCOPE_FULL
    ? `请据此生成 ${charName} 自己手机里的新记录 JSON（主语是 ${charName}，不是用户）`
    : `请据此只补 ${charName} 的「${scopeLabel}」JSON（主语是 ${charName}，不是用户；只输出 ${fields.join('、')}）`;
  const contextMessage = `${guide}\n\n【完整角色上下文】\n以下是本次要参考的角色「${charName}」的资料、世界书设定、最近聊天、TA 的跨平台生活（朋友圈/微博/论坛/匿名墙/匿名聊天/记忆/线下经历）与已有手机记录：\n${taskPayload}`;
  const maxTokens = await resolveGenerationMaxTokens();
  // 与聊天同路径：优先流式，避免 APK 上大段非流式补全被中转掐断后误拿本地 HTML。
  const requestOnce = () => chatWithPreferredStream([
    { role: 'system', content: contextMessage },
    { role: 'user', content: taskIntro },
  ], null, { temperature: 0.82, maxTokens, signal });
  onProgress?.('正在请求模型生成手机记录…');
  const raw = await requestOnce();
  const parsed = extractJsonObject(raw);
  await db.put('settings', {
    key: `characterPhoneRecordsDebug_${uid}_${cid}`,
    value: {
      savedAt: Date.now(),
      dateKey,
      countMode,
      scope: resolvedScope,
      maxTokens,
      rawLength: String(raw || '').length,
      parsedOk: !!parsed,
      raw: String(raw || '').slice(0, 60000),
    },
  }).catch(() => {});
  onProgress?.('正在校验并整理生成结果…');
  const patch = pickScopedPatch(normalizePatch(parsed, now), resolvedScope);
  const translationEntries = [
    ...asArray(patch.notes).map((item, index) => ({
      id: `note_${index}`,
      source: item?.text || item?.note || item?.body || '',
      translation: item?.translation || item?.zh || '',
      languageHint: character?.translationProfile?.language || '',
    })),
    ...asArray(patch.callRecords).map((item, index) => ({
      id: `call_${index}`,
      source: item?.summary || item?.note || item?.content || '',
      translation: item?.translation || item?.zh || '',
      languageHint: character?.translationProfile?.language || '',
    })),
    ...asArray(patch.browserRecords).map((item, index) => ({
      id: `browser_${index}`,
      source: item?.body || item?.summary || item?.aiJudgement || '',
      translation: item?.translation || item?.zh || item?.bodyTranslation || '',
      languageHint: character?.translationProfile?.language || '',
    })),
    ...asArray(patch.photoRecords).map((item, index) => ({
      id: `photo_${index}`,
      source: item?.caption || item?.summary || item?.description || '',
      translation: item?.translation || item?.zh || item?.captionTranslation || '',
      languageHint: character?.translationProfile?.language || '',
    })),
    ...asArray(patch.interestRecords).flatMap((item, index) => ([
      {
        id: `interest_detail_${index}`,
        source: item?.detail || item?.summary || '',
        translation: item?.translation || item?.zh || item?.detailTranslation || '',
        languageHint: character?.translationProfile?.language || '',
      },
      {
        id: `interest_judgement_${index}`,
        source: item?.aiJudgement || item?.judgement || '',
        translation: item?.aiJudgementTranslation || item?.aiJudgementZh || '',
        languageHint: character?.translationProfile?.language || '',
      },
    ])),
    ...asArray(patch.mapPins).flatMap((item, index) => ([
      {
        id: `map_judgement_${index}`,
        source: item?.aiJudgement || item?.judgement || item?.reason || '',
        translation: item?.aiJudgementTranslation || item?.aiJudgementZh || item?.zh || item?.translation || '',
        languageHint: character?.translationProfile?.language || '',
      },
      {
        id: `map_next_${index}`,
        source: item?.nextAction || item?.action || '',
        translation: item?.nextActionTranslation || item?.nextActionZh || '',
        languageHint: character?.translationProfile?.language || '',
      },
    ])),
  ];
  const repairedTranslations = await repairTranslationEntries(translationEntries, {
    signal,
    automatic: true,
  }).catch(() => new Map());
  patch.notes = asArray(patch.notes).map((item, index) => ({
    ...item,
    ...(repairedTranslations.has(`note_${index}`)
      ? { translation: repairedTranslations.get(`note_${index}`) }
      : {}),
  }));
  patch.callRecords = asArray(patch.callRecords).map((item, index) => ({
    ...item,
    ...(repairedTranslations.has(`call_${index}`)
      ? { translation: repairedTranslations.get(`call_${index}`) }
      : {}),
  }));
  patch.browserRecords = asArray(patch.browserRecords).map((item, index) => ({
    ...item,
    ...(repairedTranslations.has(`browser_${index}`)
      ? { translation: repairedTranslations.get(`browser_${index}`) }
      : {}),
  }));
  patch.photoRecords = asArray(patch.photoRecords).map((item, index) => ({
    ...item,
    ...(repairedTranslations.has(`photo_${index}`)
      ? { translation: repairedTranslations.get(`photo_${index}`) }
      : {}),
  }));
  patch.interestRecords = asArray(patch.interestRecords).map((item, index) => ({
    ...item,
    ...(repairedTranslations.has(`interest_detail_${index}`)
      ? { translation: repairedTranslations.get(`interest_detail_${index}`) }
      : {}),
    ...(repairedTranslations.has(`interest_judgement_${index}`)
      ? { aiJudgementTranslation: repairedTranslations.get(`interest_judgement_${index}`) }
      : {}),
  }));
  patch.mapPins = asArray(patch.mapPins).map((item, index) => ({
    ...item,
    ...(repairedTranslations.has(`map_judgement_${index}`)
      ? { aiJudgementTranslation: repairedTranslations.get(`map_judgement_${index}`) }
      : {}),
    ...(repairedTranslations.has(`map_next_${index}`)
      ? { nextActionTranslation: repairedTranslations.get(`map_next_${index}`) }
      : {}),
  }));
  delete patch.phoneContacts;
  if (patchIsEmpty(patch, { fields })) {
    const snippet = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`模型返回里没有可写入的${scopeLabel}（可能被截断或字段不符）。原始片段：${snippet || '（空）'}`);
  }
  if (scopeNeedsPhotoImages(resolvedScope) && asArray(patch.photoRecords).length) {
    onProgress?.('正在补全相册图片…');
    patch.photoRecords = await applyPhonePhotoImages(patch.photoRecords, {
      character,
      maxImages: 6,
      signal,
    });
  }
  const beforeMapCount = countMapItems(phone);
  onProgress?.('正在写入手机记录…');
  phone = mergePhoneStructuredPatch(phone, patch, { now });
  phone = await saveCharacterPhone(phone);
  let mapGrowError = '';
  if (scopeNeedsMapGrow(resolvedScope)) {
    try {
      const grown = await maybeGrowCharacterPhoneMapForDailyPlan({
        userId: uid,
        characterId: cid,
        character,
        phone,
        contextText: buildMapGrowContextFromPatch(patch),
        reason: 'manual-phone-records',
        respectAutoToggle: false,
        bypassCooldown: true,
        writeCurrentState: false,
        timestamp: now,
      });
      if (grown) phone = grown;
    } catch (error) {
      mapGrowError = String(error?.message || error || '').trim();
    }
  }
  return {
    phone,
    patch,
    generated: true,
    scope: resolvedScope,
    mapGrown: scopeNeedsMapGrow(resolvedScope) && countMapItems(phone) > beforeMapCount,
    mapGrowError,
  };
}
