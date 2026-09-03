import { get as dbGet, put as dbPut, deleteRecord as dbDeleteRecord } from './db.js';
import { chat as chatCompletion, resolveGenerationMaxTokens } from './api.js';
import { getCharacter } from './character-store.js';
import {
  dateKeyFromTimestamp,
  getDailyLifePlanForDate,
  loadCharacterPhone,
  normalizeDailyLifeBlock,
  normalizeDailyLifePlan,
  pickCurrentPlanBlock,
  pruneExpiredDailyLifePlans,
  saveCharacterPhone,
  upsertDailyLifePlan,
} from './character-phone-store.js';
import { buildTimeAndHolidayPromptBlock, getNowForUser } from './time-mode.js';
import { normalizeLocationProfile, getBaseLocationAnchor, describeLocationAnchor } from './location-profile.js';
import {
  amapExploreFromSeed,
  buildAmapStaticMapUrl,
  loadAmapConfig,
} from './amap-tools.js';
import { saveCollectible, getCollectible } from './collectibles.js';
import { createMemory } from '../models/memory.js';
import { getUserDisplayName } from '../models/user.js';
import {
  saveMemory, ensurePrivateChat, findPrivateChat, listMessagesForChat, saveMessage, updateChatPreview,
} from './chat-store.js';
import { createMessage } from '../models/chat.js';
import { normalizeTranslationProfile } from '../models/character.js';
import { createOfflineStoryCard } from './chat/offline-story-card.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import { buildPresetFragmentContext } from './preset-store.js';
import { getCharacterPromptTagSnippets } from '../data/character-prompt-tags.js';
import { loadMemoryWorkspace, pickMemoriesForScope } from './memory/memory-scope.js';
import {
  persistGeneratedImageUrlLocally,
  loadImageToolConfig,
  generateImageForScene,
  resolveImageProviderForScene,
} from './image-generation-tools.js';
import { getImageStylePreset, listScenePresets, buildSceneStylePrompt } from './image-style-presets.js';
import { loadWebSearchConfig, runWebSearch } from './web-search-tools.js';

/** 旅行结构化生成保留 system / user 层级；兼容转换统一交给 API 设置。 */
async function chatJsonWithSystem(system, user, { temperature = 0.7, maxTokens, signal } = {}) {
  const { resolveSceneApiConfig } = await import('./api-presets.js');
  const sceneOverride = await resolveSceneApiConfig().catch(() => null);
  return chatCompletion([
    { role: 'system', content: String(system || '').trim() },
    { role: 'user', content: String(user || '').trim() },
  ], {
    temperature,
    maxTokens,
    signal,
    configOverride: sceneOverride || undefined,
  }).catch(() => '');
}

// 主题分类：只用于 hub 页收纳展示，不影响生成逻辑。
export const TRAVEL_THEME_CATEGORIES = [
  { id: 'nature', label: '自然系' },
  { id: 'food', label: '味觉系' },
  { id: 'culture', label: '文化系' },
  { id: 'city', label: '城市系' },
  { id: 'home', label: '居家系' },
];

// 明信片生图风格模板：用户可在归来卡片上直接切换或在此基础上自己改写 prompt。
export const TRAVEL_POSTCARD_STYLES = {
  watercolor_cartoon: {
    label: '水彩卡通',
    promptFragment: 'soft watercolor cartoon illustration, gentle pastel color wash, hand-drawn postcard style, visible paper grain, rounded friendly shapes',
  },
  photo_scrapbook: {
    label: '实景照片手账',
    promptFragment: 'natural realistic phone snapshot photo, candid framing, soft daylight, true-to-life colors, scrapbook photo corner',
  },
  retro_ticket: {
    label: '复古票根',
    promptFragment: 'vintage ticket stub layout, muted retro color grading, halftone print texture, aged paper edge, postage-stamp perforation hint',
  },
  ink_sketch: {
    label: '钢笔速写',
    promptFragment: 'quick ink pen sketch with a light watercolor wash, travel journal line art, loose expressive strokes',
  },
};

const DEFAULT_POSTCARD_STYLE_ID = 'watercolor_cartoon';

// 节奏模板：同一套"生成节点"的流程不该套死在所有主题上——观鸟/钓鱼该慢、该等、该有"没等到"的空手而归，
// 逛街市集该密、该碎、该多点打卡；这里只给 LLM 写节点时的节奏/密度/互动倾向指引，不改变输出 schema。
const TRAVEL_RHYTHM_TEMPLATES = {
  city_flow: {
    label: '城市穿梭',
    guide: '节奏偏快、点位偏密：短停留、多切换，节点之间可以有"顺路又去了哪"的推进感；互动倾向 ask_user（问用户要不要也来一份）或 photo（打卡拍照）。',
  },
  food_linger: {
    label: '慢慢待着',
    guide: '找一个地方坐下来就别急着走：节点重心是"在这一个地方待多久、点了什么、聊了什么"，不必强求逛完所有候选点；互动倾向 choice（要不要加点/续一杯）或 photo。',
  },
  culture_deep: {
    label: '沉浸式深逛',
    guide: '停留更久、点位更少：一次只认真逛 1-2 个地方，节点可以细写具体展品/书目/细节感受，体现"看进去了"而不是走过场；互动倾向 ask_user 或纯展示。',
  },
  nature_watch: {
    label: '等待与观察',
    guide: '核心是"等"和"观察"，不是赶路：可以有一两个节点写"还没等到/没钓到/鸟飞走了"的空手而归，制造真实的不确定感；这类主题特别适合安排一个 kind=surprise 的意外小插曲（天气突变、遇到別的路人、意外发现），互动倾向 photo 或 choice。',
  },
  home_cozy: {
    label: '居家放置',
    guide: '不出门、不赶路：节奏松散随意，节点围绕居家动线（书桌/沙发/厨房/床头）展开，可以有"就是没干什么正事，但很舒服"的闲散感；互动倾向纯展示或 ask_user。',
  },
};

/** 明信片风格候选：内置手账风模板 + 全站共享的场景滤镜预设，合成一份给创建面板用的下拉列表。 */
export function listPostcardStyleOptions() {
  const builtin = Object.entries(TRAVEL_POSTCARD_STYLES).map(([id, style]) => ({ id, label: style.label, hint: '' }));
  const shared = listScenePresets().map((p) => ({ id: p.id, label: p.label, hint: p.hint || '' }));
  return [...builtin, ...shared];
}

export function isValidPostcardStyleId(id = '') {
  const key = String(id || '').trim();
  if (!key) return false;
  return !!TRAVEL_POSTCARD_STYLES[key] || !!getImageStylePreset(key);
}

// 主题预设：query/looseAnchors 兜底文本定位；nearbyQueries 才是真正驱动高德近邻检索的类目，
// 必须按主题收窄（比如"咖啡"只搜咖啡厅），否则会像旧版一样把任意餐饮都当成候选。
const TRAVEL_THEME_PRESETS = {
  city_walk: {
    label: '城市散步',
    category: 'city',
    rhythmId: 'city_flow',
    query: '街区 老街',
    nearbyQueries: [
      { keywords: '公园 绿地', types: '110000' },
      { keywords: '咖啡馆', types: '050500' },
      { keywords: '书店', types: '' },
      { keywords: '特色小店', types: '' },
    ],
    durationMinutes: 120,
    collectibleLabel: '路线碎片',
    collectibleKind: 'route_fragment',
    promptCue: '街景、路牌、小店票据、路线涂鸦',
    sceneCue: 'a quiet street corner, old signage, pavement texture, soft afternoon light',
    postcardStyleId: 'ink_sketch',
  },
  // 咖啡/甜点/下午茶本质上是同一套"找个位置坐下来慢慢待"的流程，没必要拆成三个主题
  // 各自僵硬地圈死自己的搜索类目——合并后 nearbyQueries 覆盖更广，同名候选也更不容易撞车。
  cafe: {
    label: '咖啡·甜点·下午茶',
    category: 'food',
    query: '咖啡馆 甜品店',
    rhythmId: 'food_linger',
    nearbyQueries: [
      { keywords: '咖啡馆 咖啡厅', types: '050500' },
      { keywords: '甜品店 蛋糕店', types: '' },
      { keywords: '茶饮店 奶茶', types: '' },
      { keywords: '烘焙工坊', types: '' },
    ],
    durationMinutes: 90,
    collectibleLabel: '店铺卡',
    collectibleKind: 'small_object',
    promptCue: '咖啡杯、甜品、杯垫、小票、桌面一角',
    sceneCue: 'a coffee cup or a slice of cake on a wooden table by the window, warm indoor light',
    postcardStyleId: 'watercolor_cartoon',
  },
  night_market: {
    label: '夜市小吃',
    category: 'food',
    rhythmId: 'food_linger',
    query: '夜市',
    searchTopic: '{city}{seed}附近 夜市 小吃街 攻略',
    nearbyQueries: [
      { keywords: '夜市 小吃街', types: '' },
      { keywords: '烧烤 小吃', types: '' },
    ],
    durationMinutes: 120,
    collectibleLabel: '小吃摊票',
    collectibleKind: 'small_object',
    promptCue: '烧烤签、纸碗、灯串、摊位招牌',
    sceneCue: 'a night street food stall, string lights, steam rising from food, warm glow',
    postcardStyleId: 'retro_ticket',
    looseAnchors: ['社区夜市摊', '商场美食街', '便利店门口的烧烤摊', '大排档一角'],
  },
  izakaya: {
    label: '小酌一杯',
    category: 'food',
    rhythmId: 'food_linger',
    query: '小酒馆',
    nearbyQueries: [
      { keywords: '酒吧 小酒馆', types: '' },
      { keywords: '精酿啤酒', types: '' },
    ],
    durationMinutes: 100,
    collectibleLabel: '酒单便签',
    collectibleKind: 'small_object',
    promptCue: '酒杯、调酒小单、昏黄灯光、木质吧台',
    sceneCue: 'a drink glass on a dim bar counter, warm ambient light, blurred background',
    postcardStyleId: 'retro_ticket',
  },
  museum: {
    label: '展览',
    category: 'culture',
    rhythmId: 'culture_deep',
    query: '博物馆 美术馆',
    searchTopic: '{city}{seed}附近 展览 博物馆 开放信息',
    nearbyQueries: [
      { keywords: '博物馆', types: '140500' },
      { keywords: '美术馆', types: '140300' },
      { keywords: '展览馆', types: '140400' },
    ],
    durationMinutes: 150,
    collectibleLabel: '展览票根',
    collectibleKind: 'ticket_stub',
    promptCue: '票根、展览手册、馆内导览图、日期章',
    sceneCue: 'a gallery hallway with soft spotlighting, a framed piece slightly out of focus',
    postcardStyleId: 'retro_ticket',
  },
  bookstore: {
    label: '书店淘书',
    category: 'culture',
    rhythmId: 'culture_deep',
    query: '书店',
    nearbyQueries: [
      { keywords: '书店', types: '' },
      { keywords: '图书馆', types: '140100' },
      { keywords: '文创', types: '' },
    ],
    durationMinutes: 100,
    collectibleLabel: '书店便签',
    collectibleKind: 'small_object',
    promptCue: '书脊、书签、借阅章、台灯下的书桌一角',
    sceneCue: 'a stack of books on a wooden shelf, warm reading light, dust motes',
    postcardStyleId: 'ink_sketch',
  },
  old_town: {
    label: '老城巷弄',
    category: 'culture',
    rhythmId: 'city_flow',
    query: '老街 古镇',
    searchTopic: '{city}{seed}附近 老街 古镇 历史文化街区',
    nearbyQueries: [
      { keywords: '历史文化街区', types: '' },
      { keywords: '古镇 老街', types: '' },
    ],
    durationMinutes: 150,
    collectibleLabel: '巷弄拓印',
    collectibleKind: 'route_fragment',
    promptCue: '青石板、老门牌、爬藤、斑驳墙面',
    sceneCue: 'an old alley with weathered walls, hanging lanterns, cobblestone path',
    postcardStyleId: 'ink_sketch',
  },
  birdwatching: {
    label: '观鸟',
    category: 'nature',
    rhythmId: 'nature_watch',
    query: '公园 湿地 河道',
    searchTopic: '{city}{seed}附近 观鸟点 湿地公园',
    nearbyQueries: [
      { keywords: '湿地公园', types: '' },
      { keywords: '公园 广场', types: '110000' },
      { keywords: '河道 滨水绿地', types: '' },
    ],
    durationMinutes: 150,
    collectibleLabel: '观鸟记录',
    collectibleKind: 'bird_record',
    promptCue: '鸟类观察卡、羽毛贴纸、路边树、电线杆、商场外广场、窗台或街角',
    sceneCue: 'a bird perched on a branch or wire, soft bokeh background, natural light',
    postcardStyleId: 'ink_sketch',
    looseAnchors: ['小区树下', '街角电线杆', '商场外广场', '学校操场边', '河道栏杆', '便利店门口的屋檐', '公交站旁的行道树'],
  },
  fishing: {
    label: '钓鱼',
    category: 'nature',
    rhythmId: 'nature_watch',
    query: '钓鱼场 河边',
    searchTopic: '{city}{seed}附近 钓鱼场 野钓点',
    nearbyQueries: [
      { keywords: '钓鱼场 垂钓园', types: '' },
      { keywords: '水库 河边', types: '' },
      { keywords: '儿童乐园', types: '' },
    ],
    durationMinutes: 180,
    collectibleLabel: '钓点卡',
    collectibleKind: 'fish_record',
    promptCue: '钓点记录卡、水面、鱼钩、儿童乐园金鱼池、商场小游戏、天气碎片、保温杯',
    sceneCue: 'a fishing rod by calm water, ripples on the surface, overcast soft light',
    postcardStyleId: 'ink_sketch',
    looseAnchors: ['商场儿童乐园', '夜市捞金鱼摊', '公园小水池', '社区活动中心', '河边栏杆', '室内小游戏摊', '水族店门口'],
  },
  picnic: {
    label: '公园野餐',
    category: 'nature',
    rhythmId: 'nature_watch',
    query: '公园 草坪',
    nearbyQueries: [
      { keywords: '公园 草坪', types: '110000' },
      { keywords: '湖边 绿地', types: '' },
    ],
    durationMinutes: 130,
    collectibleLabel: '野餐垫贴纸',
    collectibleKind: 'small_object',
    promptCue: '格纹野餐垫、水果、草地光斑、小风车',
    sceneCue: 'a picnic blanket on grass, dappled sunlight through leaves, soft breeze feel',
    postcardStyleId: 'watercolor_cartoon',
  },
  waterside_walk: {
    label: '河边/海边散步',
    category: 'nature',
    rhythmId: 'nature_watch',
    query: '滨江 海边',
    nearbyQueries: [
      { keywords: '滨江步道 河边', types: '' },
      { keywords: '海边 沙滩', types: '' },
    ],
    durationMinutes: 130,
    collectibleLabel: '风景明信片',
    collectibleKind: 'postcard',
    promptCue: '水面波光、栈道、远处天际线、贝壳或鹅卵石',
    sceneCue: 'a waterfront boardwalk at golden hour, gentle waves, distant skyline silhouette',
    postcardStyleId: 'photo_scrapbook',
  },
  market_fair: {
    label: '文创市集',
    category: 'city',
    rhythmId: 'city_flow',
    query: '市集 创意园区',
    searchTopic: '{city}{seed}附近 文创市集 创意集市',
    nearbyQueries: [
      { keywords: '市集 创意市集', types: '' },
      { keywords: '文创园区', types: '' },
    ],
    durationMinutes: 130,
    collectibleLabel: '市集小票',
    collectibleKind: 'small_object',
    promptCue: '手作摆摊、帆布袋、小旗串、印章贴纸',
    sceneCue: 'a small market stall with handmade crafts, string flags, daylight',
    postcardStyleId: 'retro_ticket',
  },
  short_trip: {
    label: '短途旅行',
    category: 'city',
    rhythmId: 'city_flow',
    query: '景点 车站',
    nearbyQueries: [
      { keywords: '景点 风景名胜', types: '110000' },
      { keywords: '车站', types: '150000' },
      { keywords: '咖啡馆', types: '050500' },
    ],
    durationMinutes: 300,
    collectibleLabel: '城市明信片',
    collectibleKind: 'postcard',
    promptCue: '城市地标、车票、住宿便签、路线章',
    sceneCue: 'a small-city skyline or landmark at dusk, travel ticket resting nearby',
    postcardStyleId: 'photo_scrapbook',
  },
  home_trip: {
    label: '宅家小旅行',
    category: 'home',
    rhythmId: 'home_cozy',
    query: '书 电影 料理',
    nearbyQueries: [
      { keywords: '便利店', types: '060200' },
      { keywords: '书店 影音', types: '' },
    ],
    durationMinutes: 80,
    collectibleLabel: '宅家票根',
    collectibleKind: 'small_object',
    promptCue: '书页、电影票根、料理照片、桌面手账',
    sceneCue: 'a cozy desk with a book, a mug, soft lamp light, rainy window in the background',
    postcardStyleId: 'watercolor_cartoon',
    looseAnchors: ['书桌前', '沙发角', '厨房餐桌', '窗边小几', '卧室床头'],
  },
};

// 旧数据兼容：以前保存过 theme:'dessert_tea' 的行程，直接指回合并后的 cafe 配置，
// hidden 让它不出现在创建面板的选择列表里，但任何直接按 id 查表的地方都还能查到。
TRAVEL_THEME_PRESETS.dessert_tea = { ...TRAVEL_THEME_PRESETS.cafe, hidden: true };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanNote(value = '', max = 220) {
  const text = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 注入角色上下文/记忆时用的 user 名：绝不能落到裸「我」。
// 角色扮演时第一人称也是「我」，若把 user 标成「我」，AI 会把 user 当成自己，
// 出现「分不清 user 和 char」「把 user 的事代到 char 身上」。这里统一回落成「用户」。
function contextSafeUserName(name, fallback = '用户') {
  const raw = clean(name || '', 60);
  if (raw && raw !== '我' && raw !== '我自己') return raw;
  const fb = clean(fallback || '用户', 60);
  return fb && fb !== '我' && fb !== '我自己' ? fb : '用户';
}

function tripUserDisplayName(trip, fallback = '用户') {
  return contextSafeUserName(trip?.invite?.userDisplayName, fallback);
}

function ensureUserPresenceText(text = '', trip = {}, fallback = '') {
  const base = cleanNote(text || fallback || '', 260);
  if (trip?.withUser !== true) return base;
  const userName = tripUserDisplayName(trip);
  if (!base) return `和${userName}一起出去了。\n这张照片是一起走过那段路之后留下的。`;
  if (base.includes(userName) || /你|user|用户|一起|同行|我们/.test(base)) return base;
  return `和${userName}一起。\n${base}`;
}

function travelParticipantLines(trip = {}) {
  const userName = tripUserDisplayName(trip);
  const primaryNames = asArray(trip.characterNames).map((name) => clean(name, 60)).filter(Boolean);
  const companionNames = asArray(trip.invite?.companionNames).map((name) => clean(name, 60)).filter(Boolean);
  return [
    trip.withUser === true
      ? `用户同行：${userName}（真实用户/聊天对象，不是角色同行）`
      : '用户同行：否',
    primaryNames.length ? `主角色：${primaryNames.join('、')}` : '',
    companionNames.length
      ? `同行角色：${companionNames.join('、')}（这些才是角色同行）`
      : '同行角色：无',
  ].filter(Boolean);
}

function travelRoleForCharacter(trip = {}, characterId = '') {
  const id = String(characterId || '').trim();
  const primaryIds = asArray(trip.characterIds).map(String);
  const companionIds = asArray(trip.invite?.companionJoinedIds).length
    ? asArray(trip.invite?.companionJoinedIds).map(String)
    : asArray(trip.invite?.companionIds).map(String);
  if (id && primaryIds.includes(id)) return '主角色';
  if (id && companionIds.includes(id)) return '同行角色';
  return '参与角色';
}

function formatEventChatLine(item = {}, trip = {}) {
  const senderId = clean(item.senderId || '', 80);
  const role = clean(item.role || '', 40);
  const speakerType = clean(item.speakerType || (senderId === 'user' || role === 'user' ? 'real_user' : 'character'), 40);
  const text = clean(item.text || item.content || '', 180);
  if (!text) return '';
  if (senderId === 'user' || role === 'user' || speakerType === 'real_user') {
    return `${tripUserDisplayName(trip)}（聊天对象本人）：${text}`;
  }
  const name = clean(item.senderName || senderId || '角色', 80);
  return `角色${name}${senderId ? `（id=${senderId}）` : ''}：${text}`;
}

function formatEventChatExcerpt(trip = {}, limit = 10) {
  const lines = asArray(trip.eventChat)
    .slice(-Math.max(1, Number(limit) || 10))
    .map((item) => formatEventChatLine(item, trip))
    .filter(Boolean);
  return lines;
}

function genId(prefix = 'travel') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

function travelKey(userId) {
  return `travelCharTrips_${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function travelNotifyKey(userId) {
  return `travelCharNotifications_${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function themePreset(theme = '') {
  return TRAVEL_THEME_PRESETS[String(theme || '').trim()] || TRAVEL_THEME_PRESETS.city_walk;
}

// 主题留空时的随机抽取：不是纯均匀随机，按人设文本里的关键词给对应分类加权，
// 让"随机"也带一点"像TA会去的地方"，而不是每次都可能抽到风格完全不搭的主题。
const CATEGORY_KEYWORD_WEIGHTS = {
  nature: ['自然', '户外', '爬山', '徒步', '露营', '动物', '植物', '钓鱼', '观鸟', '野餐', '海边', '大海', '安静', '慢'],
  food: ['美食', '吃', '甜品', '咖啡', '奶茶', '下午茶', '小酒', '喝酒', '夜市', '烧烤', '料理'],
  culture: ['文艺', '书', '阅读', '艺术', '展览', '博物馆', '画', '音乐', '摄影', '历史'],
  city: ['热闹', '逛街', '市集', '城市', '潮流', '打卡', '拍照', '旅行', '出差'],
  home: ['宅', '家里蹲', '不爱出门', '内向', '独处', '安静待着'],
};

function pickRandomTravelTheme(character = {}) {
  const ids = Object.keys(TRAVEL_THEME_PRESETS).filter((id) => !TRAVEL_THEME_PRESETS[id]?.hidden);
  const life = character?.lifeProfile && typeof character.lifeProfile === 'object' ? character.lifeProfile : {};
  const text = [
    character?.personality, character?.currentStatus, life.habits, life.activitySeeds, character?.notes,
  ].filter(Boolean).join(' ');
  const categoryWeights = {};
  if (text) {
    for (const [cat, words] of Object.entries(CATEGORY_KEYWORD_WEIGHTS)) {
      const hits = words.filter((w) => text.includes(w)).length;
      if (hits) categoryWeights[cat] = hits;
    }
  }
  const hasSignal = Object.keys(categoryWeights).length > 0;
  const weighted = ids.map((id) => {
    const cat = TRAVEL_THEME_PRESETS[id]?.category || '';
    const base = 1;
    const boost = hasSignal ? (categoryWeights[cat] || 0) * 3 : 0;
    return { id, weight: base + boost };
  });
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of weighted) {
    roll -= item.weight;
    if (roll <= 0) return item.id;
  }
  return ids[ids.length - 1] || 'city_walk';
}

function travelThemeLayoutKey(userId) {
  return `travelThemeLayout_${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

function defaultThemeLayout() {
  return {
    categories: TRAVEL_THEME_CATEGORIES.map((cat) => ({
      id: cat.id,
      label: cat.label,
      custom: false,
      themeIds: Object.keys(TRAVEL_THEME_PRESETS).filter((id) => (TRAVEL_THEME_PRESETS[id].category || 'city') === cat.id),
    })),
  };
}

function normalizeThemeLayout(raw = {}) {
  const base = defaultThemeLayout();
  const allThemeIds = new Set(Object.keys(TRAVEL_THEME_PRESETS));
  const customCats = asArray(raw?.categories).filter((cat) => cat?.custom === true).map((cat) => ({
    id: clean(cat.id || genId('cat'), 40),
    label: clean(cat.label || '自定义分类', 20) || '自定义分类',
    custom: true,
    themeIds: asArray(cat.themeIds).map((id) => clean(id, 40)).filter((id) => allThemeIds.has(id)),
  }));
  // 主题挪进自定义分类后要从默认分类里摘掉，避免同一个主题重复出现在两处。
  const movedIds = new Set(customCats.flatMap((cat) => cat.themeIds));
  const builtinOverrides = new Map(asArray(raw?.categories).filter((cat) => !cat?.custom).map((cat) => [clean(cat.id, 40), cat]));
  const categories = base.categories.map((cat) => {
    const override = builtinOverrides.get(cat.id);
    const themeIds = (override
      ? asArray(override.themeIds).map((id) => clean(id, 40)).filter((id) => allThemeIds.has(id))
      : cat.themeIds
    ).filter((id) => !movedIds.has(id));
    return { ...cat, themeIds };
  });
  return { categories: [...categories, ...customCats].slice(0, 24) };
}

export async function loadTravelThemeLayout(userId) {
  const row = await dbGet('settings', travelThemeLayoutKey(userId));
  return normalizeThemeLayout(row?.value || {});
}

export async function saveTravelThemeLayout(userId, layout = {}) {
  const next = normalizeThemeLayout(layout);
  await dbPut('settings', { key: travelThemeLayoutKey(userId), value: next });
  return next;
}

export async function moveTravelThemeToCategory(userId, themeId, categoryId) {
  const tid = clean(themeId, 40);
  if (!tid || !TRAVEL_THEME_PRESETS[tid]) throw new Error('主题不存在');
  const layout = await loadTravelThemeLayout(userId);
  const categories = layout.categories.map((cat) => ({ ...cat, themeIds: cat.themeIds.filter((id) => id !== tid) }));
  const target = categories.find((cat) => cat.id === categoryId);
  if (target) target.themeIds.push(tid);
  return saveTravelThemeLayout(userId, { categories });
}

export async function createTravelThemeCategory(userId, label) {
  const layout = await loadTravelThemeLayout(userId);
  const id = genId('cat');
  const categories = [...layout.categories, { id, label: clean(label, 20) || '新分类', custom: true, themeIds: [] }];
  await saveTravelThemeLayout(userId, { categories });
  return id;
}

export async function deleteTravelThemeCategory(userId, categoryId) {
  const layout = await loadTravelThemeLayout(userId);
  const target = layout.categories.find((cat) => cat.id === categoryId && cat.custom);
  if (!target) return layout;
  const categories = layout.categories.filter((cat) => cat.id !== categoryId);
  const fallback = categories.find((cat) => cat.id === 'city') || categories[0];
  if (fallback) fallback.themeIds.push(...target.themeIds);
  return saveTravelThemeLayout(userId, { categories });
}

function fillSearchTopicTemplate(template = '', { city = '', seed = '' } = {}) {
  return String(template || '').replace('{city}', city || '').replace('{seed}', city ? '' : (seed || ''));
}

// 观鸟/钓鱼/展览这类高德 POI 覆盖不好的主题，靠一次性网络检索给行程生成补一点真实素材，
// 不做多轮 agent 循环——复用论坛已有的"一次检索、把摘要喂给生成"模式，避免过度设计。
async function collectTravelSearchMaterial({ preset, city, seedArea }) {
  const template = preset.searchTopic;
  if (!template) return '';
  const cfg = await loadWebSearchConfig().catch(() => null);
  if (!cfg?.enabled) return '';
  const query = clean(fillSearchTopicTemplate(template, { city, seed: seedArea }), 120);
  if (!query) return '';
  try {
    const result = await runWebSearch(query, { category: 'travel_char', maxResults: 5, searchDepth: 'basic', config: cfg });
    if (!result) return '';
    const rows = asArray(result.results).slice(0, 4)
      .map((item) => clean([item.title, item.content].filter(Boolean).join('：'), 200))
      .filter(Boolean);
    return clean([
      `搜索：${query}`,
      result.summary ? `摘要：${result.summary}` : '',
      rows.length ? rows.join('\n') : '',
    ].filter(Boolean).join('\n'), 900);
  } catch (err) {
    console.warn('[travel-char] search material failed', err);
    return '';
  }
}

function normalizeStop(raw = {}, index = 0, city = '') {
  if (!raw || typeof raw !== 'object') return null;
  const placeName = clean(raw.placeName || raw.name || raw.title || raw.label || '', 90);
  if (!placeName) return null;
  return {
    id: clean(raw.id || raw.sourcePoiId || raw.poiId || `stop_${index}`, 80),
    order: Number(raw.order || index + 1) || index + 1,
    placeName,
    city: clean(raw.city || city || '', 40),
    district: clean(raw.district || '', 60),
    address: clean(raw.address || '', 140),
    location: clean(raw.location || '', 48),
    bucket: clean(raw.bucket || 'other', 30),
    bucketLabel: clean(raw.bucketLabel || '', 40),
    visitHint: clean(raw.visitHint || raw.note || '', 140),
    sourceType: clean(raw.sourceType || raw.type || '', 120),
    // queryGroup/sourceQuery 是"这个候选是被哪一条近邻检索词搜出来的"（比如咖啡厅 vs 甜品店），
    // 只用于同主题多候选时的类目查重/轮转，不参与展示；旧数据没有这两个字段时保持 null/空。
    queryGroup: Number.isInteger(raw.queryGroup) ? raw.queryGroup : null,
    sourceQuery: clean(raw.sourceQuery || '', 60),
    // visitCount 跟手机地图那份 pin 同步：角色去过几次这个点位，用于下次挑选时"轮着去"而不是老三样。
    visitCount: Number(raw.visitCount || 0) || 0,
  };
}

// 候选分组 key：新搜到的 amap POI 有 queryGroup（对应 preset.nearbyQueries 的第几条检索词，
// 比如"咖啡厅"和"甜品店"是不同组）；手机缓存的旧 pin/行程站点走 sourceQuery 或 bucket 兜底。
// 同一组内的候选本质是"同一类地点换了个名字"，跨组轮转选才能避免"三个咖啡店"一把梭。
function stopGroupKey(stop = {}) {
  if (Number.isInteger(stop.queryGroup) && stop.queryGroup >= 0) return `q${stop.queryGroup}`;
  if (stop.sourceQuery) return `s:${stop.sourceQuery}`;
  return `b:${stop.bucket || 'other'}`;
}

// 从 preset.nearbyQueries 按 queryGroup 下标取回具体检索词文本，给 POI 打上"属于哪一类"的标签。
function resolvePoiSourceQueryLabel(poi = {}, preset = {}) {
  if (!Number.isInteger(poi.queryGroup) || poi.queryGroup < 0) return '';
  const entry = asArray(preset.nearbyQueries)[poi.queryGroup];
  return clean(entry?.keywords || '', 60);
}

function normalizeCheckpointInteraction(raw = {}) {
  const type = ['choice', 'ask_user', 'photo', 'surprise'].includes(raw?.type) ? raw.type : 'none';
  if (type === 'none' || type === 'surprise' || type === 'photo') {
    return { type, prompt: '', options: [], branches: {} };
  }
  const options = asArray(raw.options).map((item, idx) => ({
    id: clean(item?.id || `opt_${idx + 1}`, 40),
    label: clean(item?.label || item?.text || `选项 ${idx + 1}`, 40),
  })).filter((item) => item.label).slice(0, 3);
  const branches = {};
  if (raw.branches && typeof raw.branches === 'object') {
    for (const opt of options) {
      const branch = raw.branches[opt.id];
      if (!branch) continue;
      branches[opt.id] = {
        body: clean(branch.body || branch.text || '', 260),
        mood: clean(branch.mood || '', 40),
        collectibleHint: clean(branch.collectibleHint || '', 160),
        diaryLine: clean(branch.diaryLine || '', 100),
      };
    }
  }
  return {
    type,
    prompt: clean(raw.prompt || raw.question || '', 120),
    options: type === 'choice' ? options : [],
    branches: type === 'choice' ? branches : {},
  };
}

// maxOffsetMinutes 由调用方按 lengthMode 算好传入：快速模式是 preset.durationMinutes（几小时内），
// 长线模式是 durationDays*1440（跨天），不能再假设所有旅行都是分钟级的。
function normalizeCheckpoint(raw = {}, index = 0, maxOffsetMinutes = 120) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clean(raw.title || raw.name || raw.phase || '', 80);
  const body = clean(raw.body || raw.text || raw.note || '', 260);
  if (!title && !body) return null;
  const bound = Math.max(1, Number(maxOffsetMinutes) || 120);
  const offset = Math.max(0, Math.min(bound, Number(raw.offsetMinutes ?? index * 25) || 0));
  return {
    id: clean(raw.id || `cp_${index + 1}`, 80),
    offsetMinutes: offset,
    dayIndex: Math.max(0, Math.min(30, Number(raw.dayIndex ?? Math.floor(offset / 1440)) || 0)),
    title: title || `节点 ${index + 1}`,
    body,
    // diaryLine：角色第一人称口吻写的一句随手日记，跟 body（状态卡叙述正文）分开——
    // 相册手写批注、分享小卡等复用场景要的是"角色自己写的一句话"，不是状态卡叙事。
    diaryLine: clean(raw.diaryLine || raw.diary || '', 100),
    placeName: clean(raw.placeName || raw.place || '', 90),
    mood: clean(raw.mood || '', 40),
    collectibleHint: clean(raw.collectibleHint || raw.postcardText || raw.result || '', 160),
    kind: clean(raw.kind || 'note', 40),
    interaction: normalizeCheckpointInteraction(raw.interaction || {}),
    resolvedOptionId: clean(raw.resolvedOptionId || '', 40),
    capturedPhoto: raw.capturedPhoto && typeof raw.capturedPhoto === 'object' ? {
      image: String(raw.capturedPhoto.image || '').trim().slice(0, 30 * 1024 * 1024),
      caption: clean(raw.capturedPhoto.caption || '', 160),
    } : null,
    storyBeatPosted: raw.storyBeatPosted === true,
    askedInChatAt: Number(raw.askedInChatAt || 0) || 0,
  };
}

function normalizeTrip(raw = {}) {
  const now = Date.now();
  const theme = String(raw.theme || 'city_walk').trim();
  const preset = themePreset(theme);
  const createdAt = Number(raw.createdAt || now) || now;
  // 快速模式沿用主题自带的分钟级时长；长线模式是用户自己选的 1-7 天，会连续覆盖角色多天日程。
  const lengthMode = raw.lengthMode === 'extended' ? 'extended' : 'quick';
  const durationDays = lengthMode === 'extended' ? Math.max(1, Math.min(7, Number(raw.durationDays || 3) || 3)) : 0;
  const maxOffsetMinutes = lengthMode === 'extended' ? durationDays * 1440 : (preset.durationMinutes || 120);
  return {
    id: String(raw.id || genId()).trim(),
    userId: String(raw.userId || '').trim(),
    characterIds: asArray(raw.characterIds).map((id) => String(id || '').trim()).filter(Boolean).slice(0, 8),
    characterNames: asArray(raw.characterNames).map((name) => clean(name, 40)).filter(Boolean).slice(0, 8),
    // cancelled = 出发前被角色婉拒（从没走过）；terminated = 已经在路上/长线进行中，用户主动中途叫停。
    status: ['planned', 'away', 'returned', 'cancelled', 'terminated'].includes(raw.status) ? raw.status : 'away',
    theme,
    lengthMode,
    durationDays,
    title: clean(raw.title || `${preset.label} · ${preset.collectibleLabel || '明信片'}`, 80),
    city: clean(raw.city || '', 40),
    withUser: raw.withUser === true,
    imagePrefs: {
      showCharacter: raw.imagePrefs?.showCharacter === true,
      showUserPresence: raw.imagePrefs?.showUserPresence === true,
      styleMode: clean(raw.imagePrefs?.styleMode || '', 40),
      // styleId 优先于 styleMode：用户在创建面板选了具体风格滤镜（内置手账风或共享场景滤镜）时用这个。
      // 都空时生图组装会回落全局 sceneStyleId，再回落主题默认。
      styleId: clean(raw.imagePrefs?.styleId || '', 60),
      // 默认不强制"绝不能有人"，只是不主动往画面里加人物；用户可以主动打开允许路人入镜。
      allowPeople: raw.imagePrefs?.allowPeople === true,
      customStyleSuffix: clean(raw.imagePrefs?.customStyleSuffix || '', 300),
      identitySafety: clean(raw.imagePrefs?.identitySafety || 'no_identifiable_person', 40),
      // 开着时：任意节点到点都自动生一张实景照，不再局限于 interaction.type === 'photo'，
      // 用户不用手动点，只是仍能在事件页里对任意节点重roll。
      autoImageAllNodes: raw.imagePrefs?.autoImageAllNodes === true,
    },
    route: {
      source: clean(raw.route?.source || 'text_fallback', 40),
      summary: clean(raw.route?.summary || '', 180),
      mapImage: clean(raw.route?.mapImage || '', 800),
      stops: asArray(raw.route?.stops).map((item, idx) => normalizeStop(item, idx, raw.city)).filter(Boolean).slice(0, 6),
    },
    invite: {
      mode: clean(raw.invite?.mode || (raw.withUser ? 'with_user' : 'solo'), 40),
      // 只有 withUser 时才有意义：虚拟共游=同一条路线一起走；分处两地=char去TA自己的地点，
      // 节点里抛一句"你那边呢"，回应转发进真实聊天由角色自然回应，不建新的对话系统。
      coTravelMode: ['together', 'parallel'].includes(raw.invite?.coTravelMode) ? raw.invite.coTravelMode : 'together',
      prompt: clean(raw.invite?.prompt || '', 160),
      fromUser: raw.invite?.fromUser === true,
      userDisplayName: clean(raw.invite?.userDisplayName || '', 60),
      companionIds: asArray(raw.invite?.companionIds).map((id) => clean(id, 80)).filter(Boolean).slice(0, 8),
      companionNames: asArray(raw.invite?.companionNames).map((name) => clean(name, 60)).filter(Boolean).slice(0, 8),
      companionJoinedIds: asArray(raw.invite?.companionJoinedIds).map((id) => clean(id, 80)).filter(Boolean).slice(0, 8),
      companionSkippedIds: asArray(raw.invite?.companionSkippedIds).map((id) => clean(id, 80)).filter(Boolean).slice(0, 8),
    },
    decision: raw.decision && typeof raw.decision === 'object' ? {
      accepted: raw.decision.accepted !== false,
      reply: clean(raw.decision.reply || '', 220),
      reason: clean(raw.decision.reason || '', 180),
      statusText: clean(raw.decision.statusText || '', 80),
      companionReactions: asArray(raw.decision.companionReactions).map((item) => ({
        characterId: clean(item?.characterId || item?.id || '', 80),
        name: clean(item?.name || '', 60),
        accepted: item?.accepted !== false,
        reply: clean(item?.reply || item?.text || '', 180),
      })).filter((item) => item.reply).slice(0, 6),
    } : {
      accepted: true,
      reply: '',
      reason: '',
      statusText: '',
      companionReactions: [],
    },
    // 出发仪式感卡片：接受邀请那一刻生成的一张小卡（生图开了就是图，没开就是一句装饰文字），
    // 只在创建时生成一次，不随节点推进变化。
    departureCard: raw.departureCard && typeof raw.departureCard === 'object' ? {
      image: String(raw.departureCard.image || '').trim().slice(0, 30 * 1024 * 1024),
      text: clean(raw.departureCard.text || '', 120),
    } : null,
    checkpoints: asArray(raw.checkpoints)
      .map((item, idx) => normalizeCheckpoint(item, idx, maxOffsetMinutes))
      .filter(Boolean)
      .slice(0, lengthMode === 'extended' ? 24 : 8),
    interactions: asArray(raw.interactions).map((item) => ({
      id: clean(item?.id || genId('travel_act'), 80),
      checkpointId: clean(item?.checkpointId || '', 80),
      kind: clean(item?.kind || 'note', 40),
      label: clean(item?.label || '', 60),
      text: clean(item?.text || '', 180),
      createdAt: Number(item?.createdAt || now) || now,
    })).filter((item) => item.checkpointId && item.text).slice(0, 80),
    eventChat: asArray(raw.eventChat).map((item) => {
      const senderId = clean(item?.senderId || '', 80);
      const role = clean(item?.role || (senderId === 'user' ? 'user' : 'character'), 40);
      const speakerType = clean(item?.speakerType || (senderId === 'user' || role === 'user' ? 'real_user' : 'character'), 40);
      return {
        id: clean(item?.id || genId('travel_chat'), 80),
        senderId,
        senderName: clean(item?.senderName || '', 80),
        role,
        speakerType,
        text: clean(item?.text || item?.content || '', 260),
        checkpointId: clean(item?.checkpointId || '', 80),
        createdAt: Number(item?.createdAt || now) || now,
      };
    }).filter((item) => item.text).slice(0, 160),
    returnSummary: clean(raw.returnSummary || '', 260),
    memoryText: clean(raw.memoryText || '', 260),
    apiUsage: {
      llmCalls: Math.max(0, Math.min(20, Number(raw.apiUsage?.llmCalls || 0) || 0)),
      amapCalls: Math.max(0, Math.min(50, Number(raw.apiUsage?.amapCalls || 0) || 0)),
      imageCalls: Math.max(0, Math.min(20, Number(raw.apiUsage?.imageCalls || 0) || 0)),
    },
    postcard: raw.postcard && typeof raw.postcard === 'object' ? {
      title: clean(raw.postcard.title || '', 80),
      summary: clean(raw.postcard.summary || '', 260),
      // postcardImagePrompt 是实际生图用的英文 prompt；styleId 选内置风格模板拼进去；
      // imagePromptOverride 有值时完全替换模板拼接结果，交给用户自己改写。
      postcardImagePrompt: clean(raw.postcard.postcardImagePrompt || '', 1400),
      styleId: TRAVEL_POSTCARD_STYLES[raw.postcard.styleId] ? raw.postcard.styleId : DEFAULT_POSTCARD_STYLE_ID,
      imagePromptOverride: clean(raw.postcard.imagePromptOverride || '', 1400),
      image: String(raw.postcard.image || '').trim().slice(0, 30 * 1024 * 1024),
      albumNote: clean(raw.postcard.albumNote || '', 260),
      albumFragments: asArray(raw.postcard.albumFragments).map((item) => clean(item, 80)).filter(Boolean).slice(0, 8),
      collectibleId: clean(raw.postcard.collectibleId || '', 80),
    } : null,
    sourceScheduleBlockId: clean(raw.sourceScheduleBlockId || '', 80),
    replacedBlockId: clean(raw.replacedBlockId || '', 80),
    createdAt,
    createdAtReal: Number(raw.createdAtReal || 0) || 0,
    departAt: Number(raw.departAt || createdAt) || createdAt,
    expectedReturnAt: Number(raw.expectedReturnAt || 0) || createdAt + maxOffsetMinutes * 60 * 1000,
    returnedAt: Number(raw.returnedAt || 0) || 0,
    updatedAt: Number(raw.updatedAt || createdAt) || createdAt,
  };
}

function normalizeTravelNotification(raw = {}) {
  const now = Date.now();
  const kind = ['checkpoint', 'return'].includes(raw.kind) ? raw.kind : 'checkpoint';
  return {
    id: clean(raw.id || genId('travel_notice'), 120),
    userId: clean(raw.userId || '', 80),
    characterId: clean(raw.characterId || '', 80),
    characterName: clean(raw.characterName || '', 60),
    tripId: clean(raw.tripId || '', 80),
    checkpointId: clean(raw.checkpointId || '', 80),
    kind,
    title: clean(raw.title || (kind === 'return' ? '旅行char回来了' : '旅行char新阶段'), 80),
    body: clean(raw.body || '', 220),
    dueAt: Number(raw.dueAt || now) || now,
    createdAt: Number(raw.createdAt || now) || now,
    readAt: Number(raw.readAt || 0) || 0,
  };
}

async function loadTrips(userId) {
  const row = await dbGet('settings', travelKey(userId));
  return asArray(row?.value?.trips || row?.value)
    .map(normalizeTrip)
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
}

async function loadNotifications(userId) {
  const row = await dbGet('settings', travelNotifyKey(userId));
  return asArray(row?.value?.notifications || row?.value)
    .map(normalizeTravelNotification)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

async function saveNotifications(userId, notifications = []) {
  const next = asArray(notifications).map(normalizeTravelNotification).slice(0, 120);
  await dbPut('settings', { key: travelNotifyKey(userId), value: { notifications: next } });
  return next;
}

export async function listTravelCharTrips(userId, characterId = '') {
  const cid = String(characterId || '').trim();
  const trips = await loadTrips(userId);
  return cid ? trips.filter((trip) => trip.characterIds.includes(cid)) : trips;
}

export async function saveTravelCharTrip(userId, trip) {
  const list = await loadTrips(userId);
  const nextTrip = normalizeTrip({ ...trip, updatedAt: Date.now() });
  const next = [nextTrip, ...list.filter((item) => item.id !== nextTrip.id)].slice(0, 120);
  await dbPut('settings', { key: travelKey(userId), value: { trips: next } });
  return nextTrip;
}

export async function listTravelCharNotifications(userId, { unreadOnly = false } = {}) {
  const list = await loadNotifications(userId);
  return unreadOnly ? list.filter((item) => !item.readAt) : list;
}

export async function markTravelCharNotificationRead(userId, notificationId) {
  const id = String(notificationId || '').trim();
  if (!id) return [];
  const list = await loadNotifications(userId);
  return saveNotifications(userId, list.map((item) => (
    item.id === id ? { ...item, readAt: item.readAt || Date.now() } : item
  )));
}

export async function markTravelCharTripNotificationsRead(userId, tripId) {
  const id = String(tripId || '').trim();
  if (!id) return [];
  const list = await loadNotifications(userId);
  return saveNotifications(userId, list.map((item) => (
    item.tripId === id ? { ...item, readAt: item.readAt || Date.now() } : item
  )));
}

// 角色是否填了可用于旅行/地图定位的现实城市（现实城市 > 故事城市 > 已归一城市）。
// 用于发起旅行前提醒用户去通讯录补城市，空字符串表示没填。
export function getCharacterTravelCity(character = {}) {
  const anchor = character?.residenceAnchor && typeof character.residenceAnchor === 'object'
    ? character.residenceAnchor
    : {};
  const profileCity = character?.locationProfile && typeof character.locationProfile === 'object'
    ? character.locationProfile.city?.name
    : '';
  return clean(anchor.realCityMap || anchor.city || profileCity || '', 40);
}

function cityFromContext({ profile, phone, block }) {
  // profile.city.name 已经在 normalizeLocationProfile 里把「现实城市」（residenceAnchor.realCityMap）
  // 当成最高优先级来源，是用户手动填过、最权威的一份数据。phone.currentMapState.city 是地图自动生长
  // 顺手回填的「当前位置」，早期没填现实城市时可能被高德无城市限定搜索误定位到北京，一旦写进
  // IndexedDB 就会一直留着——绝不能让这份可能过期/污染的缓存值反过来盖掉用户明确填写的现实城市。
  return clean(
    profile?.city?.name
    || phone?.currentMapState?.city
    || block?.city
    || '',
    40,
  );
}

function seedAreaFromContext({ profile, phone, block }) {
  const base = getBaseLocationAnchor(profile);
  return clean(
    phone?.currentMapState?.placeName
    || phone?.currentMapState?.area
    || block?.placeName
    || block?.anchor
    || describeLocationAnchor(base)
    || profile?.region
    || profile?.city?.name
    || '',
    90,
  );
}

// 锚点描述里「住处 / 家 / 附近 / 公司」这类通用词不足以定位城市。
// 没有城市又只有通用词时绝不能去查高德：高德文本搜索在「无城市 + 通用关键词」
// 下会默认落到北京（丰台一带），导致无论用户在南方还是角色锚点在西安，都被送去北京。
const GENERIC_ANCHOR_PARTS = new Set([
  '住处', '家', '家里', '我家', '附近', '附近街区', '本地', '周边', '城市',
  '公司', '单位', '学校', '宿舍', '租房', '合租公寓', '出租屋', '工作室',
]);

function splitAnchorParts(text = '') {
  return String(text || '')
    .split(/[·,，、/|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isSpecificAnchorText(text = '') {
  return splitAnchorParts(text).some((part) => part.length >= 2 && !GENERIC_ANCHOR_PARTS.has(part));
}

// 锚点关键词必须和主题词（景点/咖啡/车站…）分开：定位只用锚点本身，
// 否则通用主题词会把高德搜索拉偏。这里只保留具体的锚点片段（通常含「西安…」之类城市线索）。
function buildAnchorSeedKeywords(seedArea = '', city = '') {
  const parts = splitAnchorParts(seedArea).filter((part) => !GENERIC_ANCHOR_PARTS.has(part));
  return clean(parts.join(' '), 60) || clean(city, 40);
}

// 主题相关性打分：用主题自己的检索词（而不是粗粒度的吃喝/购物大桶）判断一个候选地点
// 是不是真的跟主题沾边，避免"喝咖啡"捞到川菜馆、早点铺这类同桶但不相关的结果。
function themeMatchPattern(preset = {}) {
  const words = [
    ...asArray(preset.nearbyQueries).flatMap((q) => String(q?.keywords || '').split(/[\s,，]+/)),
    ...String(preset.query || '').split(/[\s,，]+/),
  ].map((w) => w.trim()).filter((w) => w.length >= 2);
  if (!words.length) return null;
  const escaped = [...new Set(words)].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'i');
}

function poiThemeScore(poi = {}, pattern) {
  if (!pattern) return 0;
  const text = [poi.placeName || poi.name, poi.type, poi.bucketLabel, poi.visitHint].filter(Boolean).join(' ');
  return pattern.test(text) ? 1 : 0;
}

function uniqueStops(stops = [], city = '', pattern = null) {
  const seen = new Set();
  const candidates = [];
  for (const raw of stops) {
    const stop = normalizeStop(raw, candidates.length, city);
    const key = `${stop?.placeName || ''}|${stop?.location || ''}`;
    if (!stop || seen.has(key)) continue;
    seen.add(key);
    candidates.push(stop);
  }
  // 打分：主题匹配的优先，同分内去过越多次的越往后排——避免"常客点位"每趟都被选中，
  // 老是同一批地方，新鲜候选永远没机会露面。
  const scored = candidates.map((stop) => ({
    stop,
    score: (pattern ? poiThemeScore(stop, pattern) : 0) * 10 - Math.min(stop.visitCount || 0, 5),
  }));
  scored.sort((a, b) => b.score - a.score);
  // 跨类目轮转：同一个 queryGroup/sourceQuery/bucket（本质是同一类地点，比如都是咖啡厅）
  // 先只选 1 个再轮下一类，"咖啡店A→咖啡店B→咖啡店C"这种同质三连就是因为漏了这一步。
  const byGroup = new Map();
  for (const item of scored) {
    const key = stopGroupKey(item.stop);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(item);
  }
  const groups = [...byGroup.values()];
  const picked = [];
  let round = 0;
  while (picked.length < 3 && groups.some((g) => g.length > round)) {
    for (const g of groups) {
      if (picked.length >= 3) break;
      if (g.length > round) picked.push(g[round]);
    }
    round += 1;
  }
  return picked.slice(0, 3).map((item, idx) => ({ ...item.stop, order: idx + 1 }));
}

function pickStopsFromPhone(phone = {}, preset, city = '') {
  const pattern = themeMatchPattern(preset);
  const bucketSet = new Set(asArray(preset.buckets));
  const itineraryStops = asArray(phone.mapItineraries)
    .flatMap((item) => asArray(item?.stops).map((stop) => ({
      ...stop,
      city: stop?.city || item.city || city,
      visitHint: stop?.visitHint || item.summary || '',
    })));
  const pins = asArray(phone.mapPins)
    .filter((pin) => !bucketSet.size || bucketSet.has(pin.bucket || 'other'))
    .map((pin) => ({
      ...pin,
      visitHint: pin.anchorName || pin.sourceQuery || '',
    }));
  const pool = [...itineraryStops, ...pins];
  // 手机里缓存的旧地图痕迹范围更杂，主题匹配模式存在时必须打分排序；
  // 排不出任何相关结果就直接放弃复用旧痕迹，交给下面的高德实时检索或文本兜底。
  if (pattern && !pool.some((item) => poiThemeScore(item, pattern))) return [];
  return uniqueStops(pool, city, pattern);
}

function fallbackStops({ city, seedArea, preset }) {
  const base = seedArea || city || '附近街区';
  const label = preset.label || '散步';
  const loose = asArray(preset.looseAnchors);
  return uniqueStops([
    { placeName: base, city, bucketLabel: '起点', visitHint: '从熟悉的地方慢慢出发' },
    { placeName: loose[0] || `${label}候选点`, city, bucketLabel: '停留', visitHint: `可以正经${label}，也可以只是顺路碰到一点相关的东西` },
    { placeName: loose[1] || `${city || '城市'}的收尾点`, city, bucketLabel: '收尾', visitHint: `带回一枚${preset.collectibleLabel || '明信片'}` },
  ], city);
}

// 宅家小旅行不走地图 POI：动线是家里角落，不是街上点位。
function homeFallbackStops({ seedArea = '', preset, profile, character } = {}) {
  const life = character?.lifeProfile && typeof character.lifeProfile === 'object' ? character.lifeProfile : {};
  const homeDetail = clean(life.homeDetails || '', 60);
  const anchor = clean(seedArea || describeLocationAnchor(getBaseLocationAnchor(profile)) || '', 60);
  const base = homeDetail || anchor || '家里';
  const loose = asArray(preset?.looseAnchors);
  return uniqueStops([
    { placeName: loose[0] || `${base}·书桌/沙发`, bucketLabel: '起点', visitHint: '从家里熟悉的一角慢慢开始' },
    { placeName: loose[1] || '厨房/餐桌', bucketLabel: '停留', visitHint: '顺手做点吃的、泡杯喝的，或摆点零食' },
    { placeName: loose[2] || '窗边/卧室', bucketLabel: '收尾', visitHint: `把今天的${preset?.label || '宅家小旅行'}收起来` },
  ], '');
}

function poiToStop(poi = {}, index = 0, city = '', preset = null) {
  return normalizeStop({
    ...poi,
    placeName: poi.name || poi.placeName,
    city: poi.city || city,
    visitHint: poi.bucketLabel || poi.type || '',
    queryGroup: poi.queryGroup,
    sourceQuery: preset ? resolvePoiSourceQueryLabel(poi, preset) : '',
    visitCount: poi.visitCount,
  }, index, city);
}

function poiToPin(poi = {}, {
  query = '',
  anchorName = '',
  preset = null,
  timestamp = Date.now(),
} = {}) {
  // 优先用"这个 POI 具体是哪一条近邻检索词搜出来的"（比如"甜品店 蛋糕店"），
  // 比统一存一个笼统的锚点关键词更能反映这个点位实际是什么类型，供后续查重/轮转用。
  const specificQuery = preset ? resolvePoiSourceQueryLabel(poi, preset) : '';
  return {
    id: poi.id || genId('pin'),
    placeName: poi.name || poi.placeName || '',
    city: poi.city || '',
    district: poi.district || '',
    address: poi.address || '',
    location: poi.location || '',
    sourcePoiId: poi.id || '',
    sourceType: poi.type || '',
    bucket: poi.bucket || 'other',
    bucketLabel: poi.bucketLabel || '',
    rating: poi.rating || '',
    cost: poi.cost || '',
    photo: poi.photo || '',
    distance: poi.distance || null,
    anchorName,
    sourceQuery: specificQuery || query,
    queryGroup: Number.isInteger(poi.queryGroup) ? poi.queryGroup : null,
    visitCount: 0,
    affinity: 0.65,
    tags: ['旅行char'],
    source: 'travel-char',
    updatedAt: timestamp,
  };
}

// 新搜到的 pin 和手机里已有的 pin 按"地名+坐标"去重合并：同一个地方再搜到一次不该变成
// 第二条记录（visitCount 清零、丢历史），而是保留旧记录的访问历史，只补新鲜字段（评分/图片等）。
function mapPinIdentityKey(pin = {}) {
  return `${String(pin.placeName || '').trim()}|${String(pin.location || '').trim()}`;
}

function mergeMapPinsDedupe(freshPins = [], existingPins = []) {
  const byKey = new Map();
  for (const pin of asArray(existingPins)) {
    const key = mapPinIdentityKey(pin);
    if (key.trim() !== '|') byKey.set(key, pin);
  }
  const merged = [];
  const usedKeys = new Set();
  for (const pin of asArray(freshPins)) {
    const key = mapPinIdentityKey(pin);
    const old = key.trim() !== '|' ? byKey.get(key) : null;
    if (old) {
      merged.push({ ...pin, id: old.id, visitCount: Number(old.visitCount || 0) || 0, tags: [...new Set([...asArray(old.tags), ...asArray(pin.tags)])] });
      usedKeys.add(key);
    } else {
      merged.push(pin);
    }
  }
  const rest = asArray(existingPins).filter((pin) => !usedKeys.has(mapPinIdentityKey(pin)));
  return [...merged, ...rest];
}

// 一趟旅行结束时，给真的走过的这几个 stop 对应的手机地图 pin 加访问次数，
// 下次同主题再挑点位时才能"轮着去"而不是反复挑中同一批常客点位。
function applyMapPinVisitTracking(phone = {}, stops = [], { timestamp = Date.now() } = {}) {
  const keys = new Set(asArray(stops).map((stop) => mapPinIdentityKey(stop)).filter((k) => k.trim() !== '|'));
  if (!keys.size) return phone;
  let changed = false;
  const mapPins = asArray(phone.mapPins).map((pin) => {
    if (!keys.has(mapPinIdentityKey(pin))) return pin;
    changed = true;
    return { ...pin, visitCount: Number(pin.visitCount || 0) + 1, lastVisitedAt: timestamp };
  });
  return changed ? { ...phone, mapPins } : phone;
}

async function resolveRoute({
  phone,
  preset,
  profile,
  city,
  seedArea,
  character,
  timestamp = Date.now(),
}) {
  if (preset?.category === 'home') {
    const stops = homeFallbackStops({ seedArea, preset, profile, character });
    return {
      source: 'home_fallback',
      stops,
      mapImage: '',
      mapPatch: null,
      city: clean(city, 40),
      apiUsage: { amapCalls: 0 },
    };
  }
  const pattern = themeMatchPattern(preset);
  const existingStops = pickStopsFromPhone(phone, preset, city);
  let source = existingStops.length ? 'phone_map' : 'text_fallback';
  let stops = existingStops;
  let mapImage = '';
  let resolvedCity = clean(city, 40);
  const cfg = await loadAmapConfig().catch(() => null);

  const anchorSeed = clean(seedArea, 80);
  // 只有「已知城市」或「锚点足够具体」才查高德定位，避免空城市 + 通用词被默认拉去北京。
  const hasGeoAnchor = !!resolvedCity || isSpecificAnchorText(anchorSeed);

  if ((!stops.length || source === 'text_fallback')
    && cfg?.enabled && cfg?.apiKey && profile.mapEnabled !== false && hasGeoAnchor) {
    // 定位锚点只用来找一个坐标中心，关键词必须是纯地址片段（不混主题词），
    // 否则「西安·合租公寓」这类锚点文本会被当成检索词，把定位搜偏。
    const seedKeywords = buildAnchorSeedKeywords(anchorSeed, resolvedCity) || preset.query;
    // 近邻检索类目必须换成主题自己的（喝咖啡只搜咖啡厅），不能用固定的餐饮/购物/公园那一套，
    // 否则任何主题捞到的都是同一批通用地点，和主题毫不相干。
    const explored = await amapExploreFromSeed({
      keywords: seedKeywords,
      city: resolvedCity,
      nearbyQueries: preset.nearbyQueries,
      maxResults: Math.max(4, Math.min(8, Number(cfg.maxResults || 6) || 6)),
    }, { config: cfg }).catch(() => null);
    // 用高德回填的真实城市校正：角色只填了片区/地标、没填城市字段时也能定准。
    const anchorCity = clean(explored?.anchor?.city || '', 40);
    if (anchorCity) resolvedCity = anchorCity;
    // 锚点本身（住处附近的定位点）大概率跟主题无关，只有真的匹配主题时才当作候选站点，
    // 避免它挤占本该留给"真正相关地点"的名额。
    const anchorMatches = !pattern || poiThemeScore(explored?.anchor, pattern) > 0;
    const poiStops = uniqueStops([
      (explored?.anchor && anchorMatches) ? poiToStop(explored.anchor, 0, resolvedCity, preset) : null,
      ...asArray(explored?.pois).map((poi, index) => poiToStop(poi, index + 1, resolvedCity, preset)),
    ].filter(Boolean), resolvedCity, pattern);
    if (poiStops.length) {
      source = 'amap_explore';
      stops = poiStops;
      mapImage = buildAmapStaticMapUrl({
        key: cfg.apiKey,
        center: explored.center || poiStops.find((stop) => stop.location)?.location || '',
        markers: poiStops.filter((stop) => stop.location).map((stop, index) => ({
          label: String(index + 1),
          location: stop.location,
        })),
      });
      const pins = asArray(explored?.pois).slice(0, 8).map((poi) => poiToPin(poi, {
        query: seedKeywords,
        anchorName: seedArea,
        preset,
        timestamp,
      }));
      const itinerary = {
        id: genId('itinerary'),
        title: `${preset.label}候选`,
        city: resolvedCity,
        anchorName: seedArea,
        theme: preset.query,
        summary: stops.map((stop) => stop.placeName).join(' → '),
        routeSummary: stops.map((stop) => stop.placeName).join(' → '),
        source: 'travel-char',
        stops,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return { source, stops, mapImage, mapPatch: { mapPins: pins, mapItineraries: [itinerary] }, city: resolvedCity, apiUsage: { amapCalls: 7 } };
    }
  }

  if (!stops.length) stops = fallbackStops({ city: resolvedCity, seedArea, preset });
  return { source, stops, mapImage, mapPatch: null, city: resolvedCity, apiUsage: { amapCalls: 0 } };
}

function routeSummary(stops = []) {
  return asArray(stops).map((stop) => stop.placeName).filter(Boolean).join(' → ');
}

function postcardKindLabel(preset = {}) {
  const kind = preset.collectibleKind || 'postcard';
  if (kind === 'ticket_stub') return 'ticket stub';
  if (kind === 'bird_record') return 'birdwatching field record card';
  if (kind === 'fish_record') return 'fishing spot record card';
  if (kind === 'route_fragment') return 'route scrapbook fragment';
  if (kind === 'small_object') return 'small keepsake card';
  return 'postcard';
}

function travelCollectibleTitle(preset = {}) {
  const label = clean(preset.label || '', 40);
  const collectible = clean(preset.collectibleLabel || '明信片', 40);
  if (!label) return collectible;
  if (!collectible) return label;
  if (collectible.includes(label) || label.includes(collectible)) return collectible;
  return `${label}${collectible}`;
}

// 创建页 styleId（内置手账风 or 共享场景滤镜）优先；
// 没选具体 styleId 时：旧版 styleMode 映射 → 全局 sceneStyleId → 主题默认 → 水彩卡通。
function resolvePostcardStyleIdFromPrefs(imagePrefs = {}, preset = {}, globalSceneStyleId = '') {
  const explicitId = String(imagePrefs?.styleId || '').trim();
  if (explicitId && isValidPostcardStyleId(explicitId)) return explicitId;
  const mode = String(imagePrefs?.styleMode || '').trim();
  const modeMap = {
    postcard_photo: 'photo_scrapbook',
    moe_illustration: 'watercolor_cartoon',
    scrapbook_ticket: 'retro_ticket',
  };
  if (mode && mode !== 'follow_global' && modeMap[mode]) return modeMap[mode];
  const globalId = String(globalSceneStyleId || '').trim();
  if (globalId && isValidPostcardStyleId(globalId)) return globalId;
  const presetId = String(preset?.postcardStyleId || '').trim();
  if (presetId && isValidPostcardStyleId(presetId)) return presetId;
  return DEFAULT_POSTCARD_STYLE_ID;
}

/** 实景/摄影向风格：途中图保留摄影质感开头；插画向则不写死 realistic photo */
function isPhotoOrientedTravelStyle(styleId = '') {
  const id = String(styleId || '').trim();
  if (id === 'photo_scrapbook') return true;
  return [
    'scene_pure_realistic',
    'scene_clear_daily',
    'scene_ins_film',
    'scene_retro_film',
    'scene_youth_cinema',
  ].includes(id);
}

// 风格片段可能来自内置手账风模板，也可能来自全站共享的场景滤镜预设，两边都要能查到。
function resolvePostcardStyleFragment(styleId = '') {
  const builtin = TRAVEL_POSTCARD_STYLES[styleId];
  if (builtin) return builtin.promptFragment;
  const shared = getImageStylePreset(styleId);
  if (shared?.prompt) return shared.prompt;
  return TRAVEL_POSTCARD_STYLES[DEFAULT_POSTCARD_STYLE_ID].promptFragment;
}

function buildPostcardImagePrompt({ trip, preset, characterName, summary, styleId }) {
  const stops = asArray(trip.route?.stops).map((stop) => [stop.placeName, stop.visitHint].filter(Boolean).join(' - ')).filter(Boolean);
  const checkpoints = asArray(trip.checkpoints).map((cp) => [cp.title, cp.placeName, cp.collectibleHint].filter(Boolean).join(' - ')).filter(Boolean);
  const userName = tripUserDisplayName(trip);
  const allowPeople = trip.imagePrefs?.allowPeople === true;
  const peopleRule = trip.imagePrefs?.showCharacter
    ? `No visible face. If ${characterName || 'the character'} appears, show only anonymous cropped hands, sleeve, shoulder, or back silhouette as a tiny detail.`
    : allowPeople
      ? 'Anonymous passersby may appear naturally in the background if the scene calls for it, but keep them unposed and not the focal point.'
      : 'No people, no human face, no portrait, no selfie, no identifiable person.';
  const userRule = trip.withUser
    ? `This trip included the user named ${userName}. The image must imply two-person participation through paired objects, two cups, two tickets, a shared table, an empty seat beside the character, or two sets of items; do not show any user body or identifiable user figure, and do not infer the user's gender.`
    : '';
  const custom = String(trip.imagePrefs?.customStyleSuffix || '').trim();
  return [
    custom ? `User style override: ${custom}` : '',
    `A complete opaque rectangular keepsake card for a scrapbook album, inspired by a small trip and the idea of a ${postcardKindLabel(preset)}.`,
    `Art direction: ${resolvePostcardStyleFragment(styleId)}.`,
    preset.category === 'home'
      ? `Theme: ${preset.label || trip.theme || 'home trip'}; setting: cozy home interior, desk or sofa corner, warm lamp light — not outdoor travel.`
      : `Theme: ${preset.label || trip.theme || 'travel'}; city or area: ${trip.city || 'nearby streets'}.`,
    stops.length ? `Place clues: ${stops.slice(0, 5).join('; ')}.` : '',
    checkpoints.length ? `Trip fragments: ${checkpoints.slice(0, 5).join('; ')}.` : '',
    summary ? `Mood note: ${summary}.` : '',
    `Visual cues may be loose and ordinary: ${preset.promptCue || 'street corner, table surface, window light, small object, route trace, soft daylight'}.`,
    'The generated image itself should be only the artwork content, filling the whole frame with a full background, not a transparent sticker asset.',
    'Opaque image only, no alpha channel, no transparent background, no isolated cutout object, no PNG sticker look.',
    'No readable words, no Chinese characters, no UI screenshot, no map app interface, no QR code, no brand logo, no advertisement. Any labels should be blank or abstract marks.',
    peopleRule,
    userRule,
  ].filter(Boolean).join('\n');
}

// 途中节点配图：按用户选的风格组装；实景档保留摄影质感，插画档不写死 realistic photo。
// 自定义追加词置顶；整段 override（若有）最高优先。
function buildCheckpointScenePrompt({ trip, preset, checkpoint, globalSceneStyleId = '' }) {
  const fullOverride = String(
    checkpoint?.imagePromptOverride
    || trip.imagePrefs?.checkpointImagePromptOverride
    || '',
  ).trim();
  if (fullOverride) return fullOverride;

  const allowPeople = trip.imagePrefs?.allowPeople === true;
  const peopleRule = allowPeople
    ? 'Anonymous passersby may appear naturally if the scene calls for it, unposed and not the focal point.'
    : 'No people, no human face, no portrait, no identifiable person; focus purely on the scene, object, or animal.';
  const styleId = resolvePostcardStyleIdFromPrefs(trip.imagePrefs, preset, globalSceneStyleId);
  const styleFragment = resolvePostcardStyleFragment(styleId);
  const custom = String(trip.imagePrefs?.customStyleSuffix || '').trim();
  const photoLike = isPhotoOrientedTravelStyle(styleId);
  return [
    custom ? `User style override: ${custom}` : '',
    photoLike
      ? 'A single realistic photo snapshot, natural phone-camera framing, true-to-life color and lighting, crisp clear focus — not a flat washed-out frame.'
      : 'A travel scene image filling the whole frame, clear subject and intentional composition.',
    styleFragment ? `Style direction: ${styleFragment}.` : '',
    `Scene: ${preset.sceneCue || 'a quiet corner of the city, natural light'}.`,
    checkpoint?.placeName ? `Location cue: ${checkpoint.placeName}.` : '',
    checkpoint?.collectibleHint ? `Detail to include: ${checkpoint.collectibleHint}.` : '',
    checkpoint?.mood ? `Mood: ${checkpoint.mood}.` : '',
    'Opaque full-frame image, no alpha channel, no sticker cutout, no UI screenshot, no readable text, no brand logo.',
    peopleRule,
  ].filter(Boolean).join('\n');
}

// 旅行生图统一走 travelImages 场景入口（可在 API 管理页配置引擎），rawPrompt 直发，
// 不套用聊天/朋友圈那套默认生活图规则；portraitStyleAllowed:false 避免误套人物画风模板。
// 出发仪式感卡片：风格跟随用户选择/全局，自定义词置顶。
function buildDepartureImagePrompt({ trip, preset, characterName, globalSceneStyleId = '' }) {
  const allowPeople = trip.imagePrefs?.allowPeople === true;
  const peopleRule = trip.imagePrefs?.showCharacter
    ? `No visible face. If ${characterName || 'the character'} appears, show only anonymous cropped hands, sleeve, a bag being packed, or a back silhouette stepping out the door.`
    : allowPeople
      ? 'Anonymous figures may appear small in the background, unposed.'
      : 'No people, no human face, no portrait, no identifiable person.';
  const styleId = resolvePostcardStyleIdFromPrefs(trip.imagePrefs, preset, globalSceneStyleId);
  const styleFragment = resolvePostcardStyleFragment(styleId);
  const custom = String(trip.imagePrefs?.customStyleSuffix || '').trim();
  return [
    custom ? `User style override: ${custom}` : '',
    'A small anticipatory "about to set off" image, capturing the feeling of just before a trip begins — packed bag, door about to open, a map or ticket in hand, morning light.',
    styleFragment ? `Style direction: ${styleFragment}.` : '',
    `Theme: ${preset.label || trip.theme || 'a small trip'}${trip.city ? `, heading toward ${trip.city}` : ''}.`,
    'Opaque full-frame image, no alpha channel, no sticker cutout, no UI screenshot, no readable text, no brand logo.',
    peopleRule,
  ].filter(Boolean).join('\n');
}

// 生成一张出发仪式感小卡：生图开着就带图，没开就退成一句装饰文字，两条路径都要有内容可展示。
async function buildDepartureCard({ trip, preset, characterName }) {
  const fallbackText = trip.theme && TRAVEL_THEME_PRESETS[trip.theme]?.category === 'home'
    ? `${characterName || 'TA'}窝进了${preset.label || '这次宅家计划'}`
    : `${characterName || 'TA'}出发去${preset.label || '附近'}了`;
  const cfg = await loadImageToolConfig().catch(() => null);
  const prompt = buildDepartureImagePrompt({
    trip,
    preset,
    characterName,
    globalSceneStyleId: cfg?.styles?.sceneStyleId || '',
  });
  const gen = await maybeGenerateTravelImage(prompt).catch(() => ({ used: false, image: '' }));
  return {
    image: gen.used && gen.image ? gen.image : '',
    text: fallbackText,
  };
}

async function maybeGenerateTravelImage(imagePrompt) {
  const cfg = await loadImageToolConfig().catch(() => null);
  if (!cfg) return { image: '', used: false, error: '' };
  const provider = resolveImageProviderForScene('travelImages', cfg, imagePrompt);
  if (!provider) return { image: '', used: false, error: '' };
  try {
    const result = await generateImageForScene(imagePrompt, 'travelImages', {
      config: cfg,
      rawPrompt: true,
      portraitStyleAllowed: false,
    });
    let image = String(result?.url || '').trim();
    if (!image) throw new Error('没有生成图片地址');
    image = await persistGeneratedImageUrlLocally(image).catch(() => image);
    return { image, used: true, error: '' };
  } catch (err) {
    console.warn('[travel-char] postcard image generation failed', err);
    return { image: '', used: false, error: String(err?.message || err || '').slice(0, 160) };
  }
}

function buildPostcardSummary({ trip, characterName }) {
  if (trip.returnSummary) return ensureUserPresenceText(trip.returnSummary, trip);
  const preset = themePreset(trip.theme);
  const stops = asArray(trip.route?.stops).map((stop) => stop.placeName).filter(Boolean);
  const name = characterName || trip.characterNames?.[0] || 'TA';
  const userName = tripUserDisplayName(trip);
  const verb = trip.withUser ? `和${userName}一起去了` : '去了';
  return `${name}${verb}${stops.slice(0, 3).join('、') || trip.city || '附近'}，带回一枚${travelCollectibleTitle(preset)}。`;
}

async function saveTravelTripMemory({ trip, userId, characterId, summary, timestamp, phase = 'finished' } = {}) {
  const preset = themePreset(trip.theme);
  const isOngoing = phase === 'ongoing';
  const eventText = isOngoing
    ? buildOngoingTripMemoryText(trip, characterId)
    : ensureUserPresenceText(trip.memoryText || summary || '', trip);
  if (!eventText) return null;
  const occurredTs = Number(timestamp || trip.returnedAt || trip.updatedAt || trip.createdAt || 0) || Date.now();
  const occurredDate = dateKeyFromTimestamp(occurredTs);
  const chatExcerpt = formatEventChatExcerpt(trip, 8);
  const content = [
    occurredDate
      ? `发生日期：${occurredDate}（${isOngoing ? '进行中，不是未来计划' : '已发生，不是未来计划'}）`
      : '',
    isOngoing ? `活动状态：进行中 · ${clean(trip.decision?.statusText || preset.label || '旅行', 80)}` : '',
    ...travelParticipantLines(trip),
    `当前角色身份：${travelRoleForCharacter(trip, characterId)}`,
    chatExcerpt.length ? `活动小群摘录（逐条标明说话人，用户不是角色）：\n${chatExcerpt.join('\n')}` : '',
    `事件记录：${eventText}`,
  ].filter(Boolean).join('\n');
  const mem = createMemory({
    id: `mem_travel_${trip.id}_${characterId}`,
    userId,
    characterId,
    chatId: '',
    type: 'event',
    category: trip.withUser ? 'shared' : 'life_trace',
    content,
    importance: isOngoing ? 'normal' : (trip.withUser ? 'important' : 'normal'),
    timestamp,
    source: 'travel_char',
  });
  mem.travelTripId = trip.id;
  mem.travelPhase = isOngoing ? 'ongoing' : 'finished';
  await saveMemory(mem);
  return mem;
}

function buildOngoingTripMemoryText(trip = {}, characterId = '') {
  const preset = themePreset(trip.theme);
  const isHome = preset.category === 'home';
  const statusText = clean(trip.decision?.statusText || '', 80);
  const title = clean(trip.title || '', 80);
  const nowTs = Number(trip.departAt || trip.createdAt || 0) || Date.now();
  const depart = Number(trip.departAt || trip.createdAt || nowTs) || nowTs;
  const current = (Array.isArray(trip.checkpoints) ? trip.checkpoints : [])
    .filter((cp) => depart + Number(cp.offsetMinutes || 0) * 60000 <= nowTs)
    .slice(-1)[0] || asArray(trip.checkpoints)[0] || null;
  const cpLine = current
    ? [current.title, current.placeName, current.body, current.collectibleHint].filter(Boolean).join('｜')
    : '';
  const activityLabel = isHome ? '宅家小旅行' : (preset.label || '旅行');
  const parts = [
    `${activityLabel}进行中${isHome ? '（不出门，在家里进行）' : ''}`,
    statusText ? `当前状态：${statusText}` : '',
    title ? `活动：${title}` : '',
    cpLine ? `当前节点：${cpLine}` : '',
    trip.route?.summary
      ? (isHome ? `居家动线：${trip.route.summary}` : `路线：${trip.route.summary}`)
      : '',
    `角色身份：${travelRoleForCharacter(trip, characterId)}`,
  ].filter(Boolean);
  return ensureUserPresenceText(parts.join('；'), trip);
}

async function removeTravelTripMemory({ userId, characterId, tripId } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const id = String(tripId || '').trim();
  if (!uid || !cid || !id) return;
  await dbDeleteRecord('memories', `mem_travel_${id}_${cid}`).catch(() => null);
}

async function generateReturnAlbumNote({ trip, preset, characterName, summary, character = null }) {
  const userName = tripUserDisplayName(trip);
  const fallbackFragments = asArray(trip.checkpoints)
    .map((cp) => [cp.title, cp.placeName, cp.collectibleHint || cp.body].filter(Boolean).join(' · '))
    .filter(Boolean)
    .slice(0, 4);
  const fallback = {
    albumNote: trip.withUser
      ? `和${userName}一起出去。\n${characterName || 'TA'}把这趟${preset.label || '旅行'}收成了一页相册。`
      : `${characterName || 'TA'}把这趟${preset.label || '旅行'}收成了一页相册。`,
    fragments: fallbackFragments,
  };
  // 创建时已经预生成过 checkpoints/memoryText，归来只是"收纳"，按设计不该再烧一次 LLM；
  // 只有素材明显太薄（比如创建时走了兜底脚本）才值得补一次真正的相册手写体。
  const hasRichMaterial = fallbackFragments.length >= 2 && String(trip.memoryText || '').length >= 20;
  if (hasRichMaterial) return fallback;
  const payload = {
    task: 'travel_char_return_album_note',
    character: character ? characterBrief(character) : { name: characterName || 'TA' },
    trip: {
      title: trip.title || '',
      theme: preset.label || trip.theme || '',
      collectibleLabel: preset.collectibleLabel || '明信片',
      city: trip.city || '',
      route: trip.route?.summary || '',
      withUser: trip.withUser === true,
      userName: trip.withUser === true ? userName : '',
      checkpoints: asArray(trip.checkpoints).map((cp) => ({
        title: cp.title || '',
        body: cp.body || '',
        placeName: cp.placeName || '',
        mood: cp.mood || '',
        collectibleHint: cp.collectibleHint || '',
      })).slice(0, 6),
      summary,
      eventChatExcerpt: formatEventChatExcerpt(trip, 12),
    },
    rules: [
      '写给实体旅行相册页面用，不是聊天气泡。',
      'eventChatExcerpt 每条都已经标明“真实用户”或“角色”；不得把真实用户当成角色同行，也不得把某个角色说的话归给另一个角色。',
      'albumNote 用角色本人视角，像照片旁边的手写标注，写成2-4行短句；总长60-120字；语气、口头禅要贴合 character.personality / speechStyle / profile，不要写成任何角色都能套用的通用旅行文案。',
      trip.withUser === true
        ? `这次是 ${userName} 和角色一起出去，albumNote 必须明确写出 ${userName} / 你 / 我们 / 一起同行的存在，不能写成角色独自旅行。`
        : '这次不是用户同行，不要强行写成用户也去了。',
      'fragments 是可选的相册边角便签短句，2-4条，每条不超过22字；不要当成必须陈列的票根。',
      '不要输出系统说明，不要写用户提示词。',
    ],
    schema: {
      albumNote: '角色视角手写标注，允许换行',
      fragments: ['边角便签短句'],
    },
  };
  const albumMaxTokens = await resolveGenerationMaxTokens();
  const raw = await chatJsonWithSystem(
    ['你是旅行相册收束写作者。只输出合法 JSON 对象。', JSON.stringify(payload, null, 2)].join('\n\n'),
    '请按上述完整旅行上下文生成相册收束内容。',
    { temperature: 0.72, maxTokens: albumMaxTokens },
  );
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return fallback;
  return {
    albumNote: ensureUserPresenceText(cleanNote(parsed.albumNote || fallback.albumNote, 220), trip, fallback.albumNote),
    fragments: asArray(parsed.fragments).map((item) => clean(item, 60)).filter(Boolean).slice(0, 5) || fallback.fragments,
  };
}

function buildCollectibleBody({ trip, preset, userName = '' }) {
  const stops = asArray(trip.route?.stops);
  const displayName = contextSafeUserName(trip.invite?.userDisplayName || userName);
  const characterNames = asArray(trip.characterNames).filter(Boolean).join('、') || 'char';
  const companionNames = asArray(trip.invite?.companionNames).filter(Boolean).join('、');
  return [
    trip.route?.summary ? `路线：${trip.route.summary}` : '',
    trip.city ? `城市：${trip.city}` : '',
    stops.length ? `收集点：${stops.map((stop) => [stop.placeName, stop.visitHint].filter(Boolean).join(' · ')).join(' / ')}` : '',
    `类型：${preset.collectibleKind || 'postcard'}`,
    trip.withUser ? `用户同行：${displayName}（真实用户）` : '用户同行：否',
    `主角色：${characterNames}`,
    companionNames ? `同行角色：${companionNames}` : '同行角色：无',
  ].filter(Boolean).join('\n');
}

// 剪掉超长人设资料，但保留换行结构（人设/世界书条目常靠分行组织信息）。
function clipPreserve(value = '', max = 900) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function messageToBriefLine(msg, charName, userName, characterId) {
  if (!msg || msg.deleted || msg.recalled) return '';
  const speaker = String(msg.senderId || '') === String(characterId) ? (charName || 'TA') : (userName || '用户');
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
  text = clean(text, 100);
  return text ? `${speaker}：${text}` : '';
}

// 拉最近的真实私聊，让旅行放置的反应/语气接得上正在进行的关系状态，而不是凭空发生。
async function collectRecentChatBrief(userId, characterId, charName, userName) {
  if (!userId || !characterId) return [];
  try {
    const chat = await findPrivateChat(userId, characterId).catch(() => null);
    if (!chat?.id) return [];
    const messages = await listMessagesForChat(chat.id, 30).catch(() => []);
    return asArray(messages)
      .map((msg) => messageToBriefLine(msg, charName, userName, characterId))
      .filter(Boolean)
      .slice(-20);
  } catch (_) {
    return [];
  }
}

// 拉记忆馆里这个角色已沉淀的人物特征/剧情摘要/事件，避免旅行事件和已知设定/过往打架。
async function collectMemoryBrief(userId, characterId) {
  if (!userId || !characterId) return { traits: [], summaries: [], events: [] };
  try {
    const ws = await loadMemoryWorkspace(userId);
    const picked = pickMemoriesForScope(ws, characterId);
    return {
      traits: asArray(picked.characterTraits).slice(0, 8).map((f) => clean(f.content || '', 100)).filter(Boolean),
      summaries: asArray(picked.summaries).slice(0, 5).map((m) => clean(m.content || '', 110)).filter(Boolean),
      events: asArray(picked.events).slice(0, 5).map((e) => clean(e.summary || e.highlight || '', 100)).filter(Boolean),
    };
  } catch (_) {
    return { traits: [], summaries: [], events: [] };
  }
}

function characterBrief(character = {}) {
  const life = character.lifeProfile && typeof character.lifeProfile === 'object' ? character.lifeProfile : {};
  const anchor = character.residenceAnchor && typeof character.residenceAnchor === 'object' ? character.residenceAnchor : {};
  const tagSnippets = getCharacterPromptTagSnippets(character.promptTags || []);
  return {
    id: character.id || '',
    name: character.customNickname || character.name || '',
    personality: character.personality || '',
    speechStyle: character.speechStyle || '',
    currentRole: character.currentRole || '',
    currentStatus: character.currentStatus || '',
    habits: life.habits || '',
    activitySeeds: life.activitySeeds || '',
    city: anchor.realCityMap || anchor.city || '',
    area: anchor.area || '',
    commonEmotes: character.commonEmotes || '',
    notes: clean(character.notes || '', 200),
    profile: clipPreserve(character.promptCorpus || '', 900),
    speechTags: tagSnippets.length ? tagSnippets.join('\n\n') : '',
  };
}

function fallbackTripScript({ preset, route, withUser, lengthMode = 'quick', durationDays = 0 }) {
  const stops = asArray(route.stops);
  const isHome = preset?.category === 'home';
  const base = {
    accepted: true,
    reply: withUser
      ? (isHome ? `可以，那就在家一起${preset.label}吧` : `可以，那就一起去${preset.label}吧`)
      : (isHome ? `行，我在家自己${preset.label}一下` : `可以，我自己去看看`),
    reason: isHome
      ? `最近不太想出门，${preset.label}刚好适合窝在家里`
      : `对${preset.label}有点兴趣，路线也不算麻烦`,
    statusText: isHome ? `${preset.label}进行中` : `${preset.label}探索中`,
    title: isHome
      ? `${preset.label} · ${stops[0]?.placeName || '家里'}`
      : `${preset.label} · ${stops[0]?.placeName || '附近'}`,
    returnSummary: '',
    memoryText: '',
  };
  if (lengthMode === 'extended' && durationDays > 0) {
    const days = Math.max(1, durationDays);
    const checkpoints = [];
    for (let day = 0; day < days; day += 1) {
      const stop = stops[day % Math.max(1, stops.length)];
      checkpoints.push({
        offsetMinutes: day * 1440 + (day === 0 ? 0 : 480),
        dayIndex: day,
        title: day === 0 ? '出发' : `第 ${day + 1} 天`,
        body: stop?.placeName ? `在${stop.placeName}附近待着，先慢慢走走看。` : '继续按当天的节奏走。',
        diaryLine: day === 0 ? '出发啦，先随便走走看。' : (stop?.placeName ? `又在${stop.placeName}耗了一天。` : '今天也照常晃了一圈。'),
        placeName: stop?.placeName || '',
        collectibleHint: preset.collectibleLabel || '明信片',
        kind: day === 0 ? 'start' : (day === days - 1 ? 'return' : 'middle'),
      });
    }
    return { ...base, checkpoints };
  }
  if (isHome) {
    return {
      ...base,
      checkpoints: [
        {
          offsetMinutes: 0,
          title: '安顿下来',
          body: withUser ? '在家里找了个舒服的位置，准备开始这趟小小的宅家旅行。' : '把手机搁一边，在家里找了个舒服的角落。',
          diaryLine: '窝好了，准备开始。',
          placeName: stops[0]?.placeName || '家里',
          collectibleHint: '起点记进宅家票根',
          kind: 'start',
        },
        {
          offsetMinutes: Math.round((preset.durationMinutes || 80) * 0.4),
          title: '进行中',
          body: stops[1]?.placeName
            ? `挪到${stops[1].placeName}，继续看书、观影或顺手做点吃的。`
            : '窝着看点东西、听点音乐，或者随手整理一下桌面。',
          diaryLine: stops[1]?.placeName ? `窝在${stops[1].placeName}，懒得动。` : '就这么窝着，挺舒服。',
          placeName: stops[1]?.placeName || stops[0]?.placeName || '家里',
          collectibleHint: preset.collectibleLabel || '宅家票根',
          kind: 'middle',
        },
        {
          offsetMinutes: Math.max(1, Math.round((preset.durationMinutes || 80) * 0.82)),
          title: '收尾',
          body: stops.slice(-1)[0]?.placeName
            ? `最后在${stops.slice(-1)[0].placeName}把今天收一收，准备结束这趟宅家小旅行。`
            : '差不多该把今天收起来了，留一点宅家旅行的痕迹。',
          diaryLine: '今天就到这儿，先记一笔。',
          placeName: stops.slice(-1)[0]?.placeName || '家里',
          collectibleHint: preset.collectibleLabel || '宅家票根',
          kind: 'return',
        },
      ],
    };
  }
  return {
    ...base,
    checkpoints: [
      {
        offsetMinutes: 0,
        title: '出发',
        body: withUser ? '先确认了一下路线，准备慢慢过去。' : '把手机收好，先按路线出发。',
        diaryLine: '出发了，随手记一笔。',
        placeName: stops[0]?.placeName || '',
        collectibleHint: '起点被记进路线碎片',
        kind: 'start',
      },
      {
        offsetMinutes: Math.round((preset.durationMinutes || 120) * 0.45),
        title: '路上',
        body: stops[1]?.placeName ? `到了${stops[1].placeName}附近，先停一下看看。` : '在路上遇到一个适合停下来的角落。',
        diaryLine: stops[1]?.placeName ? `在${stops[1].placeName}多待了一会儿。` : '路上随便逛了逛。',
        placeName: stops[1]?.placeName || '',
        collectibleHint: preset.collectibleLabel || '明信片',
        kind: 'middle',
      },
      {
        offsetMinutes: Math.max(1, Math.round((preset.durationMinutes || 120) * 0.82)),
        title: '收尾',
        body: stops.slice(-1)[0]?.placeName ? `最后停在${stops.slice(-1)[0].placeName}，准备把今天收起来。` : '差不多该回去了，带回一点今天的痕迹。',
        diaryLine: '差不多该回去了。',
        placeName: stops.slice(-1)[0]?.placeName || '',
        collectibleHint: preset.collectibleLabel || '明信片',
        kind: 'return',
      },
    ],
  };
}

function recentTripBriefs(trips = [], currentTheme = '') {
  return asArray(trips)
    .filter((trip) => trip && ['away', 'returned', 'cancelled'].includes(trip.status))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, 8)
    .map((trip) => {
      const preset = themePreset(trip.theme);
      return {
        theme: preset.label || trip.theme,
        sameTheme: String(trip.theme || '') === String(currentTheme || ''),
        status: trip.status,
        title: trip.title || '',
        city: trip.city || '',
        route: trip.route?.summary || '',
        places: asArray(trip.route?.stops).map((stop) => stop.placeName).filter(Boolean).slice(0, 5),
        checkpointTitles: asArray(trip.checkpoints).map((cp) => cp.title).filter(Boolean).slice(0, 6),
        collectibleHints: asArray(trip.checkpoints).map((cp) => cp.collectibleHint).filter(Boolean).slice(0, 4),
        returnedAt: trip.returnedAt || 0,
        createdAt: trip.createdAt || 0,
      };
    });
}

function travelTranslationInstruction(character) {
  const profile = normalizeTranslationProfile(character?.translationProfile);
  if (profile.mode === 'full') {
    return `外语人设：character 主要讲${profile.language || 'TA 设定里的外语'}。reply 和 checkpoint.body / interaction 分支里如果出现角色的直接引语台词，要直接写外语原文（不要写成中文），紧跟着用〔〕标出中文翻译，如：「I'm home.」〔我回来了。〕；旁白、状态描写、statusText、returnSummary、memoryText 仍正常写中文；必须用半角方头括号〔〕，不要用普通括号（）。〔〕里必须是简体中文，禁止复制外语原文或日语假名。`;
  }
  if (profile.mode === 'mixed') {
    return `偶尔外语/方言：character 日常讲中文，偶尔蹦${profile.dialectNote || '外语单词或方言词句'}。reply 和 checkpoint.body / interaction 分支正常写中文，只有蹦出这类词句时，直接紧跟着用〔〕标出意思，不要整句翻译，也不要没事找词硬凑，必须用〔〕而不是普通括号（）。`;
  }
  return '';
}

function buildTripScriptPayload({
  user, character, preset, route, city, seedArea, block, withUser, coTravelMode = 'together',
  imagePrefs, companions = [], recentTrips = [], theme = '', lengthMode = 'quick', durationDays = 0,
  searchMaterial = '', worldBook = '', narrativePreset = '', recentChat = [], memoryContext = null,
  worldTime = '',
}) {
  const userName = contextSafeUserName(getUserDisplayName(user));
  const isExtended = lengthMode === 'extended' && durationDays > 0;
  const isHome = preset?.category === 'home';
  return JSON.stringify({
    task: 'travel_char_event_plan',
    user: { id: user?.id || '', name: userName },
    character: characterBrief(character),
    invite: {
      fromUser: true,
      mode: withUser ? 'with_user' : 'solo',
      coTravelMode: withUser ? coTravelMode : '',
      prompt: withUser
        ? (isHome ? `${userName}邀请 TA 一起在家${preset.label}` : `${userName}邀请 TA 一起去${preset.label}`)
        : (isHome ? `${userName}问 TA 要不要自己在家${preset.label}` : `${userName}问 TA 要不要自己去${preset.label}`),
      companions: asArray(companions).map((item) => ({
        id: item.id || '',
        name: item.customNickname || item.name || item.realName || item.id || '',
        role: item.currentRole || '',
      })).slice(0, 6),
      safety: {
        showCharacter: imagePrefs?.showCharacter === true,
        showUserPresence: withUser === true && imagePrefs?.showUserPresence === true,
        noIdentifiableUserByDefault: true,
      },
    },
    tripLength: {
      mode: lengthMode,
      durationDays: isExtended ? durationDays : 0,
      note: isExtended
        ? `这是一趟 ${durationDays} 天的长线旅行，不是几小时的短途放置。`
        : '这是几小时内的短途放置，不是多日旅行。',
    },
    context: {
      city,
      seedArea,
      currentScheduleBlock: block ? {
        timeRange: block.timeRange || '',
        activity: block.activity || '',
        placeName: block.placeName || '',
        city: block.city || '',
        mood: block.mood || '',
        busy: block.busy === true,
      } : null,
      theme: {
        label: preset.label,
        collectibleLabel: preset.collectibleLabel,
        collectibleKind: preset.collectibleKind,
        durationMinutes: preset.durationMinutes,
        looseAnchors: asArray(preset.looseAnchors).slice(0, 8),
        promptCue: preset.promptCue || '',
        rhythm: TRAVEL_RHYTHM_TEMPLATES[preset.rhythmId]?.guide || '',
      },
      route: {
        source: route.source,
        summary: routeSummary(route.stops),
        stops: asArray(route.stops).map((stop) => ({
          placeName: stop.placeName,
          city: stop.city,
          district: stop.district,
          address: stop.address,
          bucketLabel: stop.bucketLabel,
          visitHint: stop.visitHint,
          hasLocation: !!stop.location,
        })),
      },
      webSearchMaterial: searchMaterial || '',
      recentTravelEvents: recentTripBriefs(recentTrips, theme),
      worldBook: worldBook || '',
      narrativePresets: narrativePreset || '',
      worldTime: worldTime || '',
      recentChat: asArray(recentChat).slice(-20),
      memory: memoryContext ? {
        characterTraits: asArray(memoryContext.traits),
        pastStorySummaries: asArray(memoryContext.summaries),
        pastEvents: asArray(memoryContext.events),
      } : null,
    },
    outputRules: [
      '只输出合法 JSON 对象，不要 Markdown。',
      'context.worldTime 是故事世界时钟锚点；「今天、今晚、周末、假期、日出日落」等一律按该锚点理解，禁止按现实日历臆断出发/归来时段。',
      'context.character.profile / speechTags / commonEmotes / notes 是这个角色的详细人设资料；context.worldBook 是设定库里与本次场景相关的世界观/关系网条目；context.narrativePresets 是叙事风格要求。三者存在时必须体现在 checkpoint.body、statusText、returnSummary、memoryText 的具体细节和语气里（比如角色特有的习惯、口头禅、在意的人/事、世界观设定），不能只套用 preset.label 写成任何角色都通用的旅行流水账。',
      'context.recentChat 是和用户最近的真实聊天片段，只用来判断当前关系状态/语气/最近在聊什么，reply 和节点描写不能和这个语气脱节，但不要逐句复述聊天内容，也不要把聊天里的话当成本次旅行邀请。',
      'context.memory 是已经沉淀的角色记忆（人物特征/过往剧情摘要/过往事件），存在时不能写出和这些已知设定/经历矛盾的内容；可以在合适的地方自然带一句呼应（比如提到某个已知习惯或没讲完的事），但不要每条都硬凑进去。',
      `身份区分（最高优先）：character 是被扮演的角色本人；${userName} 是真实用户/邀请方，是另一个独立的人，不是角色。绝不能把 ${userName} 的身份、经历、喜好、台词写成角色自己的；也不要让角色自称是 ${userName}。`,
      `用角色本人视角判断想不想去；reply 是角色对 ${userName} 的即时聊天式反应，不是系统提示词，也不要复述「用户问你要不要」。`,
      'reply 不能只是一个字/一句敷衍的应答（如"好""行吧""去看看"），要像真实聊天里会打出来的 1-2 句话：带一点当下的态度、联想或小情绪（意外、心动、犹豫、期待、被说服的过程等），符合人设语气和当前关系亲密度，但也别写成一段小作文——保持像真人发消息的自然长度。',
      !withUser ? `"旅行char"这个玩法本质像"旅行青蛙"：${userName} 把TA放出去逛一逛，TA自己心里清楚这层默契——出去晃一趟、大概会带点什么小东西或明信片回来分享。reply 可以自然带这份自觉，比如反问一句"那我要给你带点什么回来吗""明信片算不算"，或者顺嘴调侃 ${userName} 是不是把自己当成放出去玩的小宠物/旅行青蛙；不必每次都点破"青蛙"这个词，也不用每趟都这么写，语气偏这种被安排出门、带点宠溺感的吐槽即可，别写成一本正经的行程确认。` : '',
      !withUser ? `【重要】invite.mode=solo：这是角色一个人出发，${userName} 只是提出/建议这个主意的那个人，本人没有同行、始终待在原地（比如家里/公司）。reply、checkpoint.body、interaction 分支、returnSummary、memoryText 里绝对不能出现"我们一起去/一起逛/陪你/带你去"这类暗示 ${userName} 本人也在场、正在同一段路上的表述；只能是角色自己一个人的所见所感，最多是"回去讲给你听/带点什么给你"这种单向汇报语气。如果想吐槽或撒娇，方向是"你怎么不来"而不是假装对方在旁边。companionReactions（如果有同行角色）也只针对那些同行角色本人，不涉及 ${userName}。` : '',
      '可以拒绝，但不要频繁无理由拒绝；如果有同行 companions，要根据角色关系/性格对“和这个人一起去”多做一重反应。',
      `如果有 companions，为每位同行生成 companionReactions：模拟 ${userName} 也问了对方愿不愿意一起去。反应可以微妙、犹豫、吐槽、勉强、爽快或好奇。`,
      '节点必须严格贴着 theme.label 和 route.stops 走：checkpoint.placeName 优先从 route.stops 里选，body 描写要能看出跟这个主题有关系，不要写成随便一次城市漫游的通用流水账。',
      TRAVEL_RHYTHM_TEMPLATES[preset.rhythmId]?.guide ? `theme.rhythm 节奏指引（必须体现在节点密度/停留时长/互动类型选择上）：${TRAVEL_RHYTHM_TEMPLATES[preset.rhythmId].guide}` : '',
      isHome
        ? '这是宅家小旅行：角色不出门、不赶路、不假装在街上或景区。checkpoint.placeName 应是家里的角落或房间动线（书桌、沙发、厨房、卧室等），body 写读书、观影、料理、发呆、整理桌面等居家活动；route.stops 是居家动线，不是地图 POI。statusText 用「宅家小旅行进行中」这类表述，不要写「探索中/出门」。'
        : '',
      'route.stops 是已经按主题筛过的候选点；如果 stops 明显不够贴题（比如喝咖啡却只有便利店），可以让角色吐槽"这附近没什么正经选择"，但仍要在描写里保持自知，不要假装它很贴题。',
      '当 route.stops 有多个候选时，具体去哪个、怎么逛，优先由角色本人性格/习惯/当下心情决定，不必雨露均沾覆盖所有候选点——挑 1-2 个真正对味的点位深入写，比机械式逛完所有点位更像真人。',
      searchMaterial ? 'context.webSearchMaterial 是检索到的真实攻略/地点信息，节点描写可以借用其中的具体细节（地名、时间、特点），但不要逐句照抄，也不要编造它没提到的具体数据。' : '',
      '节点文字像旅行小窗口里的状态卡，不要写成完整小说。',
      isExtended
        ? `长线模式：生成覆盖 ${durationDays} 天的节点（每天 1-3 个，dayIndex 从 0 到 ${durationDays - 1}，offsetMinutes = dayIndex*1440 + 当天内偏移分钟数），首尾各一个节点分别是出发和归来，中间几天要有推进感（心情、天气、进度变化），不要每天都写得一样。`
        : '如果接受，预先生成 3-6 个放置节点，后续系统会按时间分批展示，不会每个节点再调用 API。',
      '互动可选：每个 checkpoint 可以带一个 interaction 字段。type=none 表示纯展示；type=choice 时给 2 个 options 和对应 branches（每个分支预先写好 body/mood/collectibleHint，用户选哪个就展示哪个分支，系统不会为此再调用 API，所以两个分支都要写完整）；type=ask_user 时给一句 prompt 问用户此刻在干什么/要不要也来一份，用户的回答会转发进你们的真实聊天，不需要你现在预判回答；type=photo 表示这个节点适合拍照带回实景照片；type=surprise 表示一个计划外的小插曲（天气突变/意外邂逅/临时状况），body 要写出"意外"感，不需要额外字段。整趟旅行有 1-2 个互动节点即可，不要每个节点都塞互动；nature_watch 节奏的主题更适合安排一个 surprise。',
      `节点文字像旅行小窗口里的状态卡，不要写成完整小说。`,
      `with_user 且 coTravelMode=together 时写成"一起探索中"的放置感，必须明确 ${userName} 也在这趟活动里；节点 body / returnSummary / memoryText 至少有两处提到 ${userName}、你、我们或一起，不能写成角色独自出门。`,
      `with_user 且 coTravelMode=parallel 时是"分处两地一起玩"：角色去 TA 自己的地点，${userName} 在自己那边过自己的生活，不必同路；节点可以带一句"你那边呢/要不要也整一份"的 ask_user 互动，但不要虚构 ${userName} 实际在做什么。`,
      `with_user 时不生成可识别 ${userName} 形象，图像和记录只用第二杯饮料、另一张票、空座位、并排物件等暗示用户存在。`,
      '如果有 companions，把他们当成同行角色小队；不要喧宾夺主，主视角仍是被邀请的 character。',
      '参考 recentTravelEvents 做承续和查重：同一角色近期做过同主题事件时，避免重复同一地点组合、同样的节点标题、同样的收集物描述和同样的饭团/便利店式舒适区表达。',
      '如果路线候选不可避免重复地点，也要换观察重点、天气/时间细节、停留顺序或收集物角度；不要表现为上一趟的简单复读。',
      '角色可以按人设偷懒、敷衍、临时改成低成本版本，尤其是懒得户外/怕晒/忙碌/社恐的角色；只要结果和主题有一点联系即可。',
      '不要编造经纬度；地点从 route.stops 里选。',
      // 相册/分享小卡要复用的是角色自己写的一句日记，不是状态卡叙述——两者视角、长度、语气都不同，
      // 分开写才不会串味：body 可以是描写角色在做什么，diaryLine 必须是角色本人的口吻。
      '每个 checkpoint 都要写 diaryLine：用角色第一人称口吻写的一句随手日记/备注，10-30字，像随手记一笔而不是完整叙述；要贴合这个角色的说话习惯/口头禅/情绪反应，不能是任何角色都能套用的通用旅行文案，也不要跟 body 是同一句话的简单变形。选了 interaction=choice 时，每个分支也要单独写各自的 diaryLine，跟该分支的 body 对应上。',
      travelTranslationInstruction(character),
    ].filter(Boolean),
    schema: {
      accepted: true,
      reply: '角色对邀请的真实聊天式回复，1-2 句、带态度/联想/小情绪，不是一个词的敷衍',
      reason: '接受或拒绝原因',
      statusText: '观鸟探索中/咖啡探索中等',
      companionReactions: [
        { characterId: '同行角色id', name: '同行名', accepted: true, reply: '同行角色的简短回应' },
      ],
      title: '事件标题',
      checkpoints: [
        {
          offsetMinutes: 0,
          dayIndex: 0,
          title: '出发',
          body: '状态卡正文',
          diaryLine: '角色第一人称随手日记一句，10-30字',
          placeName: '从 stops 选',
          mood: '心情',
          collectibleHint: '可带回的小东西',
          kind: 'start',
          interaction: { type: 'none|choice|ask_user|photo|surprise', prompt: '仅 ask_user 需要', options: [{ id: 'a', label: '仅 choice 需要' }], branches: { a: { body: '', mood: '', collectibleHint: '', diaryLine: '' } } },
        },
      ],
      returnSummary: '归来时收集物摘要，可空',
      memoryText: '结束后写入角色记忆的一句话；with_user 时必须包含用户同行',
    },
  }, null, 2);
}

async function generateTripScript(options) {
  const { preset, route, withUser, lengthMode = 'quick', durationDays = 0, user, character, userId } = options;
  const fallback = fallbackTripScript({ preset, route, withUser, lengthMode, durationDays });
  const maxOffsetMinutes = lengthMode === 'extended' && durationDays > 0 ? durationDays * 1440 : (preset.durationMinutes || 120);
  const scriptMaxTokens = await resolveGenerationMaxTokens();
  const uid = String(userId || user?.id || '').trim();
  const charName = character?.customNickname || character?.name || '';
  const userName = contextSafeUserName(getUserDisplayName(user));
  const selectiveText = [
    charName,
    character?.personality || '',
    character?.currentRole || '',
    preset?.label || '',
    asArray(route?.stops).map((stop) => stop.placeName).filter(Boolean).join(' '),
  ].filter(Boolean).join(' ');
  const [worldBook, narrativePreset, recentChat, memoryContext, worldTime] = await Promise.all([
    buildWorldBookContextBlock(user || null, selectiveText, {
      characterIds: [character?.id].filter(Boolean),
      worldBookMode: 'selective',
    }).catch(() => ''),
    buildPresetFragmentContext('offline', {}).catch(() => ''),
    collectRecentChatBrief(uid, character?.id, charName, userName),
    collectMemoryBrief(uid, character?.id),
    uid ? buildTimeAndHolidayPromptBlock(uid).catch(() => '') : Promise.resolve(''),
  ]);
  const raw = await chatJsonWithSystem(
    [
      '你是旅行 char 放置事件导演。一次性生成角色是否接受邀请、旅行放置节点、归来摘要和记忆文本。只输出 JSON。',
      buildTripScriptPayload({ ...options, worldBook, narrativePreset, recentChat, memoryContext, worldTime }),
    ].join('\n\n'),
    '请按上述完整角色设定与旅行上下文生成这次放置事件。',
    { temperature: 0.78, maxTokens: scriptMaxTokens },
  );
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return fallback;
  return {
    accepted: parsed.accepted !== false,
    reply: clean(parsed.reply || fallback.reply, 220),
    reason: clean(parsed.reason || fallback.reason, 180),
    statusText: clean(parsed.statusText || fallback.statusText, 80),
    companionReactions: asArray(parsed.companionReactions).map((item) => ({
      characterId: clean(item?.characterId || item?.id || '', 80),
      name: clean(item?.name || '', 60),
      accepted: item?.accepted !== false,
      reply: clean(item?.reply || item?.text || '', 180),
    })).filter((item) => item.reply).slice(0, 6),
    title: clean(parsed.title || fallback.title, 80),
    checkpoints: asArray(parsed.checkpoints)
      .map((item, idx) => normalizeCheckpoint(item, idx, maxOffsetMinutes))
      .filter(Boolean)
      .slice(0, lengthMode === 'extended' ? 24 : 6),
    returnSummary: withUser ? ensureUserPresenceText(parsed.returnSummary || '', { withUser: true, invite: { userDisplayName: getUserDisplayName(options.user) } }) : clean(parsed.returnSummary || '', 260),
    memoryText: withUser ? ensureUserPresenceText(parsed.memoryText || '', { withUser: true, invite: { userDisplayName: getUserDisplayName(options.user) } }) : clean(parsed.memoryText || '', 260),
  };
}

async function markScheduleForTrip({ phone, dateKey, block, trip, preset, userName = '用户' }) {
  if (!phone || !dateKey || !block?.id) return phone;
  const safeUserName = contextSafeUserName(userName);
  const isHomeTrip = preset?.category === 'home';
  const plan = getDailyLifePlanForDate(phone, dateKey);
  if (!plan?.blocks?.length) return phone;
  const routeSummary = trip.route?.summary || (isHomeTrip ? '在家里慢慢晃' : '附近');
  const tripBlock = normalizeDailyLifeBlock({
    id: `block_${trip.id}`,
    timeRange: block.timeRange || '此刻-稍后',
    anchor: isHomeTrip ? (trip.route.stops?.[0]?.placeName || block.anchor || '家里') : (trip.city || block.anchor || ''),
    placeName: isHomeTrip
      ? (trip.route.stops?.[0]?.placeName || '家里')
      : (trip.route.stops?.[0]?.placeName || block.placeName || ''),
    city: trip.city || block.city || '',
    activity: preset.label,
    narrative: isHomeTrip
      ? (trip.withUser
        ? `临时改成和 ${safeUserName} 一起在家开启${preset.label}，先按 ${routeSummary} 慢慢来。`
        : `临时起意在家开启${preset.label}，先按 ${routeSummary} 慢慢来。`)
      : (trip.withUser
        ? `临时改成和 ${safeUserName} 一起出去，路线先按 ${routeSummary} 慢慢走。`
        : `临时起意出去走走，路线先按 ${routeSummary} 慢慢走。`),
    busy: false,
    mood: block.mood || '',
    routeHint: {
      origin: block.placeName || block.anchor || '',
      destination: trip.route.stops?.slice(-1)[0]?.placeName || '',
      mode: 'walk',
      durationText: '按实际节奏',
      waypoints: asArray(trip.route.stops).map((stop) => ({
        label: stop.placeName,
        kind: 'travel_char',
        location: stop.location || null,
      })),
    },
    flowSteps: asArray(trip.route.stops).map((stop, index) => ({
      id: `step_${trip.id}_${index + 1}`,
      action: index === 0 ? (isHomeTrip ? '开始' : '出发') : '停留',
      placeName: stop.placeName,
      transit: isHomeTrip
        ? (index === 0 ? '就在家里' : '换个角落')
        : (index === 0 ? '从当前地点过去' : '顺路走过去'),
      shareCandidate: stop.visitHint || (isHomeTrip
        ? `${stop.placeName} 适合记进宅家票根`
        : `${stop.placeName} 看起来适合收进明信片`),
      checkpoint: true,
    })),
    status: 'active',
    origin: 'travel-char',
    updatedBy: 'travel-char',
    supersedes: block.id,
    sourceRefs: [trip.id],
  }, plan.blocks.length + 1);
  if (!tripBlock) return phone;
  const nextPlan = {
    ...plan,
    blocks: asArray(plan.blocks).flatMap((item) => {
      if (String(item?.id || '') !== String(block.id || '')) return [item];
      return [
        tripBlock,
        {
          ...item,
          status: 'changed',
          supersededBy: tripBlock.id,
          changeReason: `改去${preset.label}`,
          updatedBy: 'travel-char',
        },
      ];
    }),
    dayType: plan.dayType === 'workday' ? 'mixed' : plan.dayType,
  };
  const nextPhone = upsertDailyLifePlan(phone, nextPlan);
  await saveCharacterPhone(nextPhone);
  return nextPhone;
}

async function markCompanionSchedulesForTrip({ userId, companionIds = [], dateKey, timestamp, trip, preset }) {
  const ids = asArray(companionIds).map((id) => String(id || '').trim()).filter(Boolean).slice(0, 8);
  const joined = [];
  const tripCity = clean(trip.city || asArray(trip.route?.stops)[0]?.city || '', 40);
  for (const companionId of ids) {
    let companionPhone = await loadCharacterPhone(userId, companionId).catch(() => null);
    if (!companionPhone) continue;
    const pruned = pruneExpiredDailyLifePlans(companionPhone, dateKey);
    if (pruned.removed) companionPhone = await saveCharacterPhone(pruned.phone);
    const companionPlan = getDailyLifePlanForDate(companionPhone, dateKey);
    const companionBlock = companionPlan ? pickCurrentPlanBlock(companionPlan, timestamp) : null;
    if (!companionBlock?.id) continue;
    const companionCity = clean(
      companionBlock.city
      || companionPhone.currentMapState?.city
      || '',
      40,
    );
    if (tripCity && companionCity && tripCity !== companionCity) continue;
    await markScheduleForTrip({
      phone: companionPhone,
      dateKey,
      block: companionBlock,
      trip,
      preset,
    }).catch(() => null);
    joined.push(companionId);
  }
  return joined;
}

// 长线旅行会连续占用角色多天日程；character-daily-life.js 生成某一天计划前会先查这个，
// 命中就直接拼当天节点当日程，不再为这一天单独调 LLM——省钱，也保证聊天里的日程跟旅行进度一致。
export async function getActiveExtendedTripForDate(userId, characterId, dateKey) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const dk = String(dateKey || '').trim();
  if (!uid || !cid || !dk) return null;
  const trips = await listTravelCharTrips(uid, cid).catch(() => []);
  const active = asArray(trips).find((trip) => {
    if (!trip || trip.status !== 'away' || trip.lengthMode !== 'extended') return false;
    const departKey = dateKeyFromTimestamp(trip.departAt || trip.createdAt || 0);
    const returnKey = dateKeyFromTimestamp(trip.expectedReturnAt || 0);
    if (!departKey || !returnKey) return false;
    return dk >= departKey && dk <= returnKey;
  });
  return active || null;
}

function dayIndexForDateKey(trip, dateKey) {
  const departKey = dateKeyFromTimestamp(trip.departAt || trip.createdAt || 0);
  const departMs = new Date(`${departKey}T00:00:00`).getTime();
  const targetMs = new Date(`${dateKey}T00:00:00`).getTime();
  if (Number.isNaN(departMs) || Number.isNaN(targetMs)) return 0;
  return Math.max(0, Math.round((targetMs - departMs) / (24 * 60 * 60 * 1000)));
}

// 用旅行本身已经生成好的 checkpoint 直接拼出这一天的日程 block，不再额外调用 AI。
export function buildTripDayPlanOverride({ trip, dateKey, userName = '用户' }) {
  const preset = themePreset(trip.theme);
  const dayIndex = dayIndexForDateKey(trip, dateKey);
  const safeUserName = contextSafeUserName(userName);
  const dayCheckpoints = asArray(trip.checkpoints).filter((cp) => Number(cp.dayIndex || 0) === dayIndex);
  const isFirstDay = dayIndex === 0;
  const isLastDay = dateKey === dateKeyFromTimestamp(trip.expectedReturnAt || 0);
  const narrativeParts = dayCheckpoints.length
    ? dayCheckpoints.map((cp) => cp.body || cp.title).filter(Boolean)
    : [trip.route?.summary
      ? (preset.category === 'home' ? `继续按 ${trip.route.summary} 在家里晃。` : `继续按 ${trip.route.summary} 的路线走。`)
      : (preset.category === 'home' ? '继续这趟宅家小旅行。' : '继续在外面的行程里。')];
  const placeName = dayCheckpoints[0]?.placeName || trip.route?.stops?.[0]?.placeName || trip.city || '';
  const block = normalizeDailyLifeBlock({
    id: `block_${trip.id}_day${dayIndex}`,
    timeRange: isFirstDay ? '此刻-稍后' : '全天',
    anchor: trip.city || '',
    placeName,
    city: trip.city || '',
    activity: `${preset.label}（第 ${dayIndex + 1} 天）`,
    narrative: trip.withUser
      ? `和 ${safeUserName} 的${preset.label}进行到第 ${dayIndex + 1} 天：${narrativeParts.join(' ')}`
      : `${preset.label}进行到第 ${dayIndex + 1} 天：${narrativeParts.join(' ')}`,
    busy: false,
    routeHint: {
      origin: placeName,
      destination: isLastDay ? (trip.city || '') : (trip.route?.stops?.slice(-1)[0]?.placeName || ''),
      mode: 'travel',
      durationText: '按行程节奏',
      waypoints: asArray(trip.route?.stops).map((stop) => ({
        label: stop.placeName,
        kind: 'travel_char',
        location: stop.location || null,
      })),
    },
    status: 'active',
    origin: 'travel-char',
    updatedBy: 'travel-char',
    sourceRefs: [trip.id],
  }, 0);
  if (!block) return null;
  return normalizeDailyLifePlan({
    dateKey,
    dayType: 'mixed',
    blocks: [block],
  }, { characterId: trip.characterIds?.[0] || '', dateKey });
}

async function markScheduleDoneForTrip({ userId, characterId, tripId } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const id = String(tripId || '').trim();
  if (!uid || !cid || !id) return null;
  const phone = await loadCharacterPhone(uid, cid).catch(() => null);
  if (!phone?.dailyLifePlans?.length) return phone;
  let changed = false;
  const nextPlans = asArray(phone.dailyLifePlans).map((plan) => ({
    ...plan,
    blocks: asArray(plan.blocks).map((block) => {
      const refs = asArray(block?.sourceRefs);
      if (String(block?.id || '') !== `block_${id}` && !refs.includes(id)) return block;
      changed = true;
      return {
        ...block,
        status: 'done',
        updatedBy: 'travel-char',
      };
    }),
  }));
  if (!changed) return phone;
  const nextPhone = { ...phone, dailyLifePlans: nextPlans };
  await saveCharacterPhone(nextPhone);
  return nextPhone;
}

export async function createTravelCharTrip({
  user,
  userId,
  characterId,
  character: providedCharacter,
  theme = '',
  destinationOverride = '',
  withUser = false,
  coTravelMode = 'together',
  lengthMode = 'quick',
  durationDays = 3,
  companionIds = [],
  imagePrefs = {},
} = {}) {
  const uid = String(userId || user?.id || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) throw new Error('缺少用户或角色');
  const character = providedCharacter || await getCharacter(cid);
  if (!character) throw new Error('角色不存在');
  // 主题留空/传 'random' 时按人设加权随机抽，不再兜底成固定的"城市散步"。
  const resolvedTheme = TRAVEL_THEME_PRESETS[String(theme || '').trim()]
    ? String(theme).trim()
    : pickRandomTravelTheme(character);
  theme = resolvedTheme;
  // 角色上下文里不能把 user 标成裸「我」（会与角色第一人称撞车），统一回落「用户」。
  const userName = contextSafeUserName(getUserDisplayName(user));
  const companions = [];
  for (const id of asArray(companionIds).map((x) => String(x || '').trim()).filter((x) => x && x !== cid).slice(0, 5)) {
    const companion = await getCharacter(id).catch(() => null);
    if (companion) companions.push(companion);
  }
  const preset = themePreset(theme);
  const now = await getNowForUser(uid);
  const dateKey = dateKeyFromTimestamp(now);
  let phone = await loadCharacterPhone(uid, cid);
  const pruned = pruneExpiredDailyLifePlans(phone, dateKey);
  if (pruned.removed) phone = await saveCharacterPhone(pruned.phone);
  const plan = getDailyLifePlanForDate(phone, dateKey);
  const block = plan ? pickCurrentPlanBlock(plan, now) : null;
  const profile = normalizeLocationProfile(character);
  const destination = clean(destinationOverride, 60);
  // 用户填了具体目的地：直接拿它当城市+定位锚点，不走角色本地上下文（否则会把角色平时的
  // 住处锚点词和一个完全不相关的目的地拼在一起去搜，检索词会变得很奇怪）。
  let city = destination || cityFromContext({ profile, phone, block });
  const seedArea = destination || seedAreaFromContext({ profile, phone, block });
  const route = await resolveRoute({
    phone,
    preset,
    profile,
    city,
    seedArea,
    character,
    timestamp: now,
  });
  // 高德按锚点回填的真实城市优先，避免角色没填城市字段时 trip.city 留空再被默认到北京。
  if (route.city) city = route.city;
  const characterName = character.customNickname || character.name || cid;
  const recentTrips = (await listTravelCharTrips(uid, cid).catch(() => []))
    .filter((trip) => trip.theme === theme || trip.status === 'away')
    .slice(0, 10);
  const isExtended = lengthMode === 'extended';
  const safeDurationDays = isExtended ? Math.max(1, Math.min(7, Number(durationDays) || 3)) : 0;
  const searchMaterial = await collectTravelSearchMaterial({ preset, city, seedArea }).catch(() => '');
  const script = await generateTripScript({
    user,
    userId: uid,
    character,
    preset,
    theme,
    route,
    city,
    seedArea,
    block,
    withUser: withUser === true,
    coTravelMode: withUser === true ? coTravelMode : 'together',
    lengthMode: isExtended ? 'extended' : 'quick',
    durationDays: safeDurationDays,
    searchMaterial,
    companions,
    recentTrips,
    imagePrefs,
  });
  const trip = normalizeTrip({
    id: genId('travel'),
    userId: uid,
    characterIds: [cid],
    characterNames: [characterName],
    status: script.accepted ? 'away' : 'cancelled',
    theme,
    lengthMode: isExtended ? 'extended' : 'quick',
    durationDays: safeDurationDays,
    title: script.title || `${preset.label} · ${route.stops[0]?.placeName || city || '附近'}`,
    city,
    withUser: withUser === true,
    invite: {
      mode: withUser === true ? 'with_user' : 'solo',
      coTravelMode: withUser === true ? coTravelMode : 'together',
      prompt: withUser === true ? `${userName}邀请 TA 一起去${preset.label}` : `${userName}问 TA 要不要自己去${preset.label}`,
      fromUser: true,
      userDisplayName: userName,
      companionIds: companions.map((item) => item.id).filter(Boolean),
      companionNames: companions.map((item) => item.customNickname || item.name || item.realName || item.id).filter(Boolean),
    },
    decision: {
      accepted: script.accepted,
      reply: script.reply,
      reason: script.reason,
      statusText: script.statusText,
      companionReactions: companions.map((item) => {
        const found = asArray(script.companionReactions).find((r) => (
          String(r.characterId || '') === String(item.id || '')
          || String(r.name || '') === String(item.customNickname || item.name || item.realName || '')
        ));
        return {
          characterId: item.id,
          name: item.customNickname || item.name || item.realName || item.id,
          accepted: found?.accepted !== false,
          reply: found?.reply || `我也可以去，看看${preset.label}是什么情况。`,
        };
      }),
    },
    checkpoints: script.checkpoints?.length ? script.checkpoints : fallbackTripScript({ preset, route, withUser, lengthMode: isExtended ? 'extended' : 'quick', durationDays: safeDurationDays }).checkpoints,
    returnSummary: script.returnSummary,
    memoryText: script.memoryText,
    apiUsage: {
      llmCalls: 1,
      amapCalls: Number(route.apiUsage?.amapCalls || 0) || 0,
      imageCalls: 0,
    },
    imagePrefs: {
      showCharacter: imagePrefs.showCharacter === true,
      showUserPresence: withUser === true && imagePrefs.showUserPresence === true,
      styleMode: imagePrefs.styleMode || '',
      styleId: imagePrefs.styleId || '',
      allowPeople: imagePrefs.allowPeople === true,
      customStyleSuffix: imagePrefs.customStyleSuffix || '',
      identitySafety: imagePrefs.identitySafety || 'no_identifiable_person',
      autoImageAllNodes: imagePrefs.autoImageAllNodes === true,
    },
    route: {
      source: route.source,
      stops: route.stops,
      summary: routeSummary(route.stops),
      mapImage: route.mapImage,
    },
    sourceScheduleBlockId: block?.id || '',
    replacedBlockId: block?.id || '',
    departAt: now,
    expectedReturnAt: now + (isExtended ? safeDurationDays * 1440 : (preset.durationMinutes || 120)) * 60 * 1000,
    createdAt: now,
    createdAtReal: Date.now(),
  });
  if (route.mapPatch) {
    phone = {
      ...phone,
      // 新搜到的 pin 按地名+坐标跟已有 pin 去重合并，不然同一家店换个搜索批次就会多出一条
      // 访问次数清零的"新记录"，白白挤占查重/轮转要用的历史数据。
      mapPins: mergeMapPinsDedupe(route.mapPatch.mapPins, phone.mapPins).slice(0, 120),
      mapItineraries: [...asArray(route.mapPatch.mapItineraries), ...asArray(phone.mapItineraries)].slice(0, 40),
    };
    await saveCharacterPhone(phone);
  }
  if (trip.status === 'away') {
    // 出发仪式感：接受邀请那一刻生成一张小卡，不等到第一个节点才有内容可看。
    trip.departureCard = await buildDepartureCard({ trip, preset, characterName }).catch(() => null);
    if (trip.departureCard?.image) trip.apiUsage.imageCalls = Number(trip.apiUsage.imageCalls || 0) + 1;
    phone = await markScheduleForTrip({ phone, dateKey, block, trip, preset, userName });
    if (isExtended && safeDurationDays > 1) {
      // 长线旅行覆盖的后续天数直接拼节点写进日程，不等到那天才懒生成，避免和已排好的日程打架。
      for (let day = 1; day < safeDurationDays; day += 1) {
        const dk = dateKeyFromTimestamp(now + day * 24 * 60 * 60 * 1000);
        const overridePlan = buildTripDayPlanOverride({ trip, dateKey: dk, userName });
        if (overridePlan?.blocks?.length) phone = upsertDailyLifePlan(phone, overridePlan);
      }
      phone = await saveCharacterPhone(phone);
    }
    const joinedCompanionIds = await markCompanionSchedulesForTrip({
      userId: uid,
      companionIds: trip.invite.companionIds,
      dateKey,
      timestamp: now,
      trip,
      preset,
    });
    trip.invite.companionJoinedIds = joinedCompanionIds;
    trip.invite.companionSkippedIds = trip.invite.companionIds.filter((id) => !joinedCompanionIds.includes(id));
  }
  const saved = await saveTravelCharTrip(uid, trip);
  if (saved.status === 'away') {
    await saveTravelTripMemory({
      trip: saved,
      userId: uid,
      characterId: cid,
      phase: 'ongoing',
      timestamp: now,
    }).catch(() => null);
    const companionIds = asArray(saved.invite?.companionJoinedIds).length
      ? asArray(saved.invite.companionJoinedIds)
      : asArray(saved.invite?.companionIds);
    for (const companionId of companionIds) {
      await saveTravelTripMemory({
        trip: saved,
        userId: uid,
        characterId: companionId,
        phase: 'ongoing',
        timestamp: now,
      }).catch(() => null);
    }
  }
  return { trip: saved, phone, character, declined: !script.accepted };
}

export async function finishTravelCharTrip({ userId, characterId, tripId } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const id = String(tripId || '').trim();
  if (!uid || !cid || !id) throw new Error('缺少旅行记录');
  const character = await getCharacter(cid);
  const characterName = character?.customNickname || character?.name || cid;
  const list = await loadTrips(uid);
  const trip = list.find((item) => item.id === id && item.characterIds.includes(cid));
  if (!trip) throw new Error('旅行记录不存在');
  if (trip.status === 'returned' && trip.postcard?.collectibleId) return trip;
  const returnedAt = await getNowForUser(uid);
  const preset = themePreset(trip.theme);
  const title = travelCollectibleTitle(preset);
  const summary = buildPostcardSummary({ trip, characterName });
  const album = await generateReturnAlbumNote({ trip, preset, characterName, summary, character });
  const cfg = await loadImageToolConfig().catch(() => null);
  const styleId = trip.postcard?.styleId
    || resolvePostcardStyleIdFromPrefs(trip.imagePrefs, preset, cfg?.styles?.sceneStyleId || '');
  const postcardImagePrompt = trip.postcard?.imagePromptOverride
    || buildPostcardImagePrompt({ trip, preset, characterName, summary, styleId });
  const imageResult = await maybeGenerateTravelImage(postcardImagePrompt);
  const collectibleImage = imageResult.image || '';
  const collectible = await saveCollectible({
    id: `clt_${trip.id}`,
    userId: uid,
    characterId: cid,
    ownership: trip.withUser ? 'shared' : 'character',
    source: 'travel_char',
    viewpoint: trip.withUser ? 'shared' : 'character',
    theme: preset.collectibleKind || trip.theme,
    title,
    summary,
    body: buildCollectibleBody({ trip, preset }),
    image: collectibleImage,
    imagePrompt: postcardImagePrompt,
    albumNote: album.albumNote,
    albumFragments: album.fragments,
    iconAsset: '',
    linkedId: trip.id,
    timestamp: returnedAt,
  });
  const nextTrip = await saveTravelCharTrip(uid, {
    ...trip,
    status: 'returned',
    returnedAt,
    postcard: {
      title,
      summary,
      postcardImagePrompt,
      styleId,
      imagePromptOverride: trip.postcard?.imagePromptOverride || '',
      image: collectibleImage,
      collectibleId: collectible.id,
      albumNote: album.albumNote,
      albumFragments: album.fragments,
    },
    apiUsage: {
      ...(trip.apiUsage || {}),
      llmCalls: Number(trip.apiUsage?.llmCalls || 0) + 1,
      imageCalls: Number(trip.apiUsage?.imageCalls || 0) + (imageResult.used ? 1 : 0),
      imageErrors: imageResult.error
        ? [...asArray(trip.apiUsage?.imageErrors), imageResult.error].slice(-3)
        : asArray(trip.apiUsage?.imageErrors),
    },
  });
  await saveTravelTripMemory({
    trip,
    userId: uid,
    characterId: cid,
    summary,
    timestamp: returnedAt,
  }).catch(() => null);
  const loadedPhone = await loadCharacterPhone(uid, cid);
  // 归来时给这趟路线上真的走过的 stop 对应的 pin 加访问次数，下次同主题再挑点位才知道
  // 哪些是"已经去过好几次的老地方"，好轮着挑新鲜候选，而不是每趟都撞回同一批常客点位。
  const phone = applyMapPinVisitTracking(loadedPhone, trip.route?.stops, { timestamp: returnedAt });
  const lastStop = asArray(trip.route?.stops).slice(-1)[0] || null;
  await saveCharacterPhone({
    ...phone,
    photoRecords: [
      {
        id: `photo_${trip.id}`,
        title,
        caption: summary,
        imageUrl: collectibleImage || trip.route?.mapImage || '',
        imagePrompt: postcardImagePrompt,
        location: lastStop?.placeName || trip.city || '',
        tags: ['旅行char', preset.label, preset.collectibleLabel || '明信片'],
        takenAt: returnedAt,
        createdAt: returnedAt,
      },
      ...asArray(phone.photoRecords).filter((item) => item?.id !== `photo_${trip.id}`),
    ].slice(0, 80),
    currentMapState: lastStop ? {
      area: lastStop.district || '',
      placeName: lastStop.placeName,
      activity: themePreset(trip.theme).label,
      city: lastStop.city || trip.city || '',
      location: lastStop.location || '',
      target: '',
      mode: 'travel_char',
      confidence: lastStop.location ? 0.8 : 0.45,
      source: 'travel-char',
      visibility: 'private',
      tags: ['旅行char'],
      updatedAt: returnedAt,
      expiresAt: returnedAt + 12 * 60 * 60 * 1000,
    } : phone.currentMapState,
  });
  await markScheduleDoneForTrip({ userId: uid, characterId: cid, tripId: trip.id }).catch(() => null);
  const returnCompanionIds = asArray(trip.invite?.companionJoinedIds).length
    ? asArray(trip.invite?.companionJoinedIds)
    : asArray(trip.invite?.companionIds);
  for (const companionId of returnCompanionIds) {
    await saveCollectible({
      id: `clt_${trip.id}_${companionId}`,
      userId: uid,
      characterId: companionId,
      ownership: trip.withUser ? 'shared' : 'character',
      source: 'travel_char',
      viewpoint: 'character',
      theme: preset.collectibleKind || trip.theme,
      title,
      summary,
      body: buildCollectibleBody({ trip, preset }),
      image: collectibleImage,
      imagePrompt: postcardImagePrompt,
      albumNote: album.albumNote,
      albumFragments: album.fragments,
      iconAsset: '',
      linkedId: trip.id,
      timestamp: returnedAt,
    }).catch(() => null);
    await saveTravelTripMemory({
      trip,
      userId: uid,
      characterId: companionId,
      summary,
      timestamp: returnedAt,
    }).catch(() => null);
    const companionPhone = await loadCharacterPhone(uid, companionId).catch(() => null);
    if (companionPhone) {
      await saveCharacterPhone({
        ...companionPhone,
        photoRecords: [
          {
            id: `photo_${trip.id}`,
            title,
            caption: summary,
            imageUrl: collectibleImage || trip.route?.mapImage || '',
            imagePrompt: postcardImagePrompt,
            location: lastStop?.placeName || trip.city || '',
            tags: ['旅行char', preset.label, preset.collectibleLabel || '明信片'],
            takenAt: returnedAt,
            createdAt: returnedAt,
          },
          ...asArray(companionPhone.photoRecords).filter((item) => item?.id !== `photo_${trip.id}`),
        ].slice(0, 80),
        currentMapState: lastStop ? {
          area: lastStop.district || '',
          placeName: lastStop.placeName,
          activity: preset.label,
          city: lastStop.city || trip.city || '',
          location: lastStop.location || '',
          target: '',
          mode: 'travel_char',
          confidence: lastStop.location ? 0.8 : 0.45,
          source: 'travel-char',
          visibility: 'private',
          tags: ['旅行char'],
          updatedAt: returnedAt,
          expiresAt: returnedAt + 12 * 60 * 60 * 1000,
        } : companionPhone.currentMapState,
      }).catch(() => null);
    }
    await markScheduleDoneForTrip({ userId: uid, characterId: companionId, tripId: trip.id }).catch(() => null);
  }
  return nextTrip;
}

/**
 * 补发丢失的旅行收集物：正常情况下 finishTravelCharTrip 落地收集物和翻转 trip.status
 * 是同一次调用里前后两步，但 trips 列表整份存在 settings 单个 key 里，跟并发的其它
 * 旅行/角色一起读-改-写时可能互相覆盖，导致「trip 已标记 returned/带了明信片，
 * collectibles 表里那条记录却没跟上，或者落地时 characterId/userId 归属写错」——
 * 旅行相册显示 0 张、记忆馆角标却还在计数。
 * trip.postcard 上已经缓存了文案/图片，不用再烧一次 AI，直接按原样补建/纠正即可。
 */
export async function repairMissingTravelCollectibles(userId, characterId) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return { repaired: 0 };
  const worldNow = await getNowForUser(uid).catch(() => Date.now());
  const trips = await listTravelCharTrips(uid, cid);
  let repaired = 0;
  for (const trip of trips) {
    if (trip.status !== 'returned' || !trip.postcard) continue;
    const isPrimary = asArray(trip.characterIds)[0] === cid;
    const collectibleId = isPrimary
      ? (String(trip.postcard.collectibleId || '').trim() || `clt_${trip.id}`)
      : `clt_${trip.id}_${cid}`;
    const existing = await getCollectible(collectibleId).catch(() => null);
    // 记录存在，且 userId/characterId 归属都对得上时才算「没问题」；否则不管是压根
    // 没有这条记录，还是记录存在但归属字段被写错（旧 bug 留下的脏数据），都按当前
    // trip/角色数据重新写一遍——saveCollectible 按 id put，不会产生重复记录。
    const alreadyOk = existing
      && String(existing.userId || '').trim() === uid
      && String(existing.characterId || '').trim() === cid;
    if (alreadyOk) continue;
    const preset = themePreset(trip.theme);
    await saveCollectible({
      id: collectibleId,
      userId: uid,
      characterId: cid,
      ownership: trip.withUser ? 'shared' : 'character',
      source: 'travel_char',
      viewpoint: isPrimary && trip.withUser ? 'shared' : 'character',
      theme: preset.collectibleKind || trip.theme,
      title: trip.postcard.title || travelCollectibleTitle(preset),
      summary: trip.postcard.summary || trip.returnSummary || '',
      body: buildCollectibleBody({ trip, preset }),
      image: trip.postcard.image || '',
      imagePrompt: trip.postcard.postcardImagePrompt || '',
      albumNote: trip.postcard.albumNote || '',
      albumFragments: trip.postcard.albumFragments || [],
      iconAsset: '',
      linkedId: trip.id,
      timestamp: Number(trip.returnedAt || trip.updatedAt || 0) || worldNow,
    }).catch(() => null);
    repaired += 1;
  }
  return { repaired };
}

// 用户主动叫停一趟还在进行的旅行（不生成明信片/收集物），和"角色婉拒邀请"的 cancelled
// 是两码事：这里标 terminated，长线旅行的日程覆盖判定只认 status==='away'，标完就自动失效，
// 角色的日程会恢复正常，不用另外清理。
export async function cancelTravelCharTrip({ userId, characterId, tripId } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const id = String(tripId || '').trim();
  if (!uid || !cid || !id) throw new Error('缺少旅行记录');
  const list = await loadTrips(uid);
  const trip = list.find((item) => item.id === id && item.characterIds.includes(cid));
  if (!trip) throw new Error('旅行记录不存在');
  if (trip.status === 'returned' || trip.status === 'terminated' || trip.status === 'cancelled') return trip;
  const worldNow = await getNowForUser(uid).catch(() => Date.now());
  const nextTrip = await saveTravelCharTrip(uid, {
    ...trip,
    status: 'terminated',
    expectedReturnAt: worldNow,
  });
  await removeTravelTripMemory({ userId: uid, characterId: cid, tripId: trip.id }).catch(() => null);
  await markScheduleDoneForTrip({ userId: uid, characterId: cid, tripId: trip.id }).catch(() => null);
  return nextTrip;
}

// 彻底删掉一条旅行记录（进行中/已完成/已取消都可以），顺带清掉它产生的应用内通知；
// 不影响已经生成过的收集物/共同记忆，那些是独立的历史痕迹，不随记录一起消失。
export async function deleteTravelCharTrip({ userId, characterId, tripId } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const id = String(tripId || '').trim();
  if (!uid || !id) throw new Error('缺少旅行记录');
  const list = await loadTrips(uid);
  const target = list.find((item) => item.id === id && (!cid || item.characterIds.includes(cid)));
  if (!target) return false;
  const next = list.filter((item) => item.id !== id);
  await dbPut('settings', { key: travelKey(uid), value: { trips: next } });
  const notices = await loadNotifications(uid);
  const nextNotices = notices.filter((item) => item.tripId !== id);
  if (nextNotices.length !== notices.length) {
    await saveNotifications(uid, nextNotices);
  }
  return true;
}

export async function syncTravelCharTrips({ userId, characterId } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return { finished: 0 };
  const now = await getNowForUser(uid).catch(() => Date.now());
  const trips = await listTravelCharTrips(uid, cid);
  let finished = 0;
  for (const trip of trips) {
    if (trip.status !== 'away') continue;
    if (!trip.expectedReturnAt || Number(trip.expectedReturnAt) > now) continue;
    await finishTravelCharTrip({ userId: uid, characterId: cid, tripId: trip.id }).catch(() => null);
    finished += 1;
  }
  return { finished };
}

function checkpointDueAt(trip, checkpoint) {
  return Number(trip.departAt || trip.createdAt || 0) + Number(checkpoint?.offsetMinutes || 0) * 60 * 1000;
}

function buildCheckpointNotification({
  userId,
  trip,
  checkpoint,
  characterId,
  characterName,
  dueAt,
  timestamp = dueAt,
}) {
  const preset = themePreset(trip.theme);
  return normalizeTravelNotification({
    id: `trn_${trip.id}_${checkpoint.id}`,
    userId,
    characterId,
    characterName,
    tripId: trip.id,
    checkpointId: checkpoint.id,
    kind: 'checkpoint',
    title: `${characterName || 'TA'} · ${checkpoint.title || preset.label}`,
    body: checkpoint.body || checkpoint.placeName || `${preset.label}进入新阶段`,
    dueAt,
    createdAt: timestamp,
  });
}

// 长线旅行到某个节点时，把它当成一次真实的"事件小剧场"贴进角色本人的聊天窗，
// 而不是只留一条应用内通知——这样翻回聊天就能看到旅行进度的自然推进，不用开一个新的小窗系统。
async function postTripStoryBeatToChat({ user, userId, trip, checkpoint, characterId, characterName }) {
  if (checkpoint.storyBeatPosted) return false;
  try {
    const chat = await ensurePrivateChat(userId, characterId, characterName);
    const recentMessages = await listMessagesForChat(chat.id, 40).catch(() => []);
    const preset = themePreset(trip.theme);
    const dayIndex = Number(checkpoint.dayIndex || 0);
    const timeLabel = `旅行第 ${dayIndex + 1} 天`;
    const extraPrompt = [
      `这是「${trip.title || preset.label}」这趟旅行里的一个新节点，不是普通日常。`,
      checkpoint.placeName ? `地点：${checkpoint.placeName}` : '',
      checkpoint.body ? `节点素材：${checkpoint.body}` : '',
      checkpoint.mood ? `此刻心情：${checkpoint.mood}` : '',
      trip.withUser ? '这趟是和用户一起/约好同步进行的，可以自然带一句关于用户的呼应，但不要替用户说话。' : '',
      '把这段素材扩写成一段自然的旅途小剧场，不要逐字复述节点素材，要有场景感。',
    ].filter(Boolean).join('\n');
    await createOfflineStoryCard({
      chat,
      chatId: chat.id,
      user: user || { id: userId },
      userId,
      messages: recentMessages,
    }, {
      mode: 'time+story',
      targetWords: 380,
      timeLabel,
      extraPrompt,
    });
    return true;
  } catch (err) {
    console.warn('[travel-char] story beat post failed', err);
    return false;
  }
}

function buildReturnNotification({ userId, trip, characterId, characterName, timestamp }) {
  const preset = themePreset(trip.theme);
  return normalizeTravelNotification({
    id: `trn_${trip.id}_return`,
    userId,
    characterId,
    characterName,
    tripId: trip.id,
    kind: 'return',
    title: `${characterName || 'TA'}带回了${preset.collectibleLabel || '明信片'}`,
    body: trip.postcard?.summary || trip.returnSummary || trip.decision?.statusText || `${preset.label}结束了`,
    dueAt: Number(trip.returnedAt || trip.expectedReturnAt || 0) || timestamp,
    createdAt: timestamp,
  });
}

export async function scanTravelCharNotifications({ userId, user = null, characterIds = [] } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return { created: 0, notifications: [] };
  const idSet = new Set(asArray(characterIds).map((id) => String(id || '').trim()).filter(Boolean));
  const now = await getNowForUser(uid).catch(() => Date.now());
  let trips = await listTravelCharTrips(uid);
  if (idSet.size) trips = trips.filter((trip) => asArray(trip.characterIds).some((id) => idSet.has(id)));
  let notices = await loadNotifications(uid);
  const existing = new Set(notices.map((item) => item.id));
  const created = [];

  for (const trip of trips) {
    const cid = asArray(trip.characterIds)[0] || '';
    if (!cid) continue;
    const characterName = asArray(trip.characterNames)[0] || cid;
    let currentTrip = trip;
    if (trip.status === 'away' && Number(trip.expectedReturnAt || 0) && Number(trip.expectedReturnAt) <= now) {
      currentTrip = await finishTravelCharTrip({ userId: uid, characterId: cid, tripId: trip.id }).catch(() => trip);
    }
    if (currentTrip.status === 'away') {
      const depart = Number(currentTrip.departAt || currentTrip.createdAt || 0) || 0;
      const isExtended = currentTrip.lengthMode === 'extended';
      const postedDayIndexes = new Set();
      let checkpointsChanged = false;
      let autoImageCalls = 0;
      const nextCheckpoints = [];
      for (const checkpoint of asArray(currentTrip.checkpoints)) {
        const dueAt = checkpointDueAt(currentTrip, checkpoint);
        let nextCheckpoint = checkpoint;
        if (dueAt && dueAt > depart && dueAt <= now) {
          const item = buildCheckpointNotification({
            userId: uid,
            trip: currentTrip,
            checkpoint,
            characterId: cid,
            characterName,
            dueAt,
            timestamp: now,
          });
          if (!existing.has(item.id)) {
            existing.add(item.id);
            created.push(item);
            await saveTravelTripMemory({
              trip: currentTrip,
              userId: uid,
              characterId: cid,
              phase: 'ongoing',
              timestamp: dueAt || now,
            }).catch(() => null);
          }
          // 长线旅行每天最多贴一次小剧场，不会因为一天多个节点而刷屏聊天。
          const dayIdx = Number(checkpoint.dayIndex || 0);
          if (isExtended && !checkpoint.storyBeatPosted && !postedDayIndexes.has(dayIdx)) {
            postedDayIndexes.add(dayIdx);
            const posted = await postTripStoryBeatToChat({
              user, userId: uid, trip: currentTrip, checkpoint, characterId: cid, characterName,
            });
            if (posted) {
              nextCheckpoint = { ...nextCheckpoint, storyBeatPosted: true };
              checkpointsChanged = true;
            }
          }
          // "开了生图还要手动点生图"不合理：拍照类节点一到点，图就该自己长出来，
          // 用户到点开通知看到的直接是已经拍好的实景照，不用再手动点一次。
          // 创建时勾了"每个节点自动生图"的话，不再局限于 interaction.type === 'photo'，
          // 任意节点到点都自动出图；用户仍能在事件页里对已出图的节点重roll。
          const wantsAutoPhoto = nextCheckpoint.interaction?.type === 'photo' || currentTrip.imagePrefs?.autoImageAllNodes === true;
          if (wantsAutoPhoto && !nextCheckpoint.capturedPhoto) {
            const gen = await generateCheckpointPhotoRaw(currentTrip, checkpoint).catch(() => null);
            if (gen?.used && gen.image) {
              nextCheckpoint = { ...nextCheckpoint, capturedPhoto: { image: gen.image, caption: checkpoint.diaryLine || checkpoint.collectibleHint || checkpoint.body || '' } };
              checkpointsChanged = true;
              autoImageCalls += 1;
              await writeCheckpointPhotoRecord(uid, cid, currentTrip, checkpoint, gen).catch(() => null);
            }
          }
        }
        nextCheckpoints.push(nextCheckpoint);
      }
      if (checkpointsChanged) {
        currentTrip = await saveTravelCharTrip(uid, {
          ...currentTrip,
          checkpoints: nextCheckpoints,
          apiUsage: autoImageCalls
            ? { ...currentTrip.apiUsage, imageCalls: Number(currentTrip.apiUsage?.imageCalls || 0) + autoImageCalls }
            : currentTrip.apiUsage,
        }).catch(() => currentTrip);
      }
    }
    if (currentTrip.status === 'returned') {
      const item = buildReturnNotification({
        userId: uid,
        trip: currentTrip,
        characterId: cid,
        characterName,
        timestamp: now,
      });
      if (!existing.has(item.id)) {
        existing.add(item.id);
        created.push(item);
      }
    }
  }

  if (created.length) {
    notices = await saveNotifications(uid, [...created, ...notices]);
  }
  return { created: created.length, notifications: created, all: notices };
}

async function loadOwnTrip(userId, characterId, tripId) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  const id = String(tripId || '').trim();
  if (!uid || !cid || !id) throw new Error('缺少旅行记录');
  const list = await loadTrips(uid);
  const trip = list.find((item) => item.id === id && item.characterIds.includes(cid));
  if (!trip) throw new Error('旅行记录不存在');
  return trip;
}

// choice 类互动的分支文案在创建时已经预生成好，选择时只是"揭开"对应分支，不产生新的 API 调用，
// 保持放置过程中的低成本。
export async function resolveCheckpointChoice({ userId, characterId, tripId, checkpointId, optionId }) {
  const trip = await loadOwnTrip(userId, characterId, tripId);
  const cpId = String(checkpointId || '').trim();
  const optId = String(optionId || '').trim();
  const checkpoint = trip.checkpoints.find((cp) => cp.id === cpId);
  if (!checkpoint || checkpoint.interaction?.type !== 'choice') throw new Error('这个节点没有可选的互动');
  const branch = checkpoint.interaction.branches?.[optId];
  const nextCheckpoints = trip.checkpoints.map((cp) => {
    if (cp.id !== cpId) return cp;
    return {
      ...cp,
      resolvedOptionId: optId,
      body: branch?.body || cp.body,
      mood: branch?.mood || cp.mood,
      collectibleHint: branch?.collectibleHint || cp.collectibleHint,
      diaryLine: branch?.diaryLine || cp.diaryLine,
    };
  });
  return saveTravelCharTrip(userId, { ...trip, checkpoints: nextCheckpoints });
}

// ask_user 互动不在事件页临时输入框里对答，而是把角色的提问原样发进真实私聊——
// 用户在那边回复时，角色能拿到完整聊天记忆自然接话，不需要另建一套对话状态机。
// 只发一次：askedInChatAt 有值后再点只是带用户跳回那条聊天，不会重复发消息。
export async function postCheckpointAskUserToChat({ userId, characterId, tripId, checkpointId, characterName }) {
  const trip = await loadOwnTrip(userId, characterId, tripId);
  const checkpoint = trip.checkpoints.find((cp) => cp.id === checkpointId);
  if (!checkpoint || checkpoint.interaction?.type !== 'ask_user') throw new Error('这个节点没有可提问的互动');
  const chat = await ensurePrivateChat(userId, characterId, characterName || trip.characterNames?.[0] || '');
  if (checkpoint.askedInChatAt) return { trip, chat };
  const promptText = checkpoint.interaction.prompt || '在干嘛呀，要不要也来一份？';
  const worldNow = await getNowForUser(userId);
  const message = createMessage({
    chatId: chat.id,
    senderId: characterId,
    senderName: characterName || trip.characterNames?.[0] || '',
    type: 'text',
    content: promptText,
    timestamp: worldNow,
  });
  await saveMessage(message);
  await updateChatPreview(chat.id, promptText, message.timestamp);
  const nextCheckpoints = trip.checkpoints.map((cp) => (
    cp.id !== checkpointId ? cp : { ...cp, askedInChatAt: worldNow }
  ));
  const nextTrip = await saveTravelCharTrip(userId, { ...trip, checkpoints: nextCheckpoints });
  return { trip: nextTrip, chat };
}

// 生图节点预设的核心执行体（只管生图，不管落库）：不管是用户手动点一次，还是节点到点后系统
// 自动触发，都走这一份逻辑——按用户选的风格（实景/插画等）生成途中配图。
async function generateCheckpointPhotoRaw(trip, checkpoint) {
  const preset = themePreset(trip.theme);
  const cfg = await loadImageToolConfig().catch(() => null);
  const prompt = buildCheckpointScenePrompt({
    trip,
    preset,
    checkpoint,
    globalSceneStyleId: cfg?.styles?.sceneStyleId || '',
  });
  const result = await maybeGenerateTravelImage(prompt);
  return { image: result.image || '', used: result.used === true, error: result.error || '', prompt, preset };
}

// 把生好的实拍图落一条 photoRecords，让手机相册/旅行相册都能看到这张照片。
async function writeCheckpointPhotoRecord(userId, characterId, trip, checkpoint, gen) {
  const phone = await loadCharacterPhone(userId, characterId).catch(() => null);
  if (!phone) return;
  const worldNow = await getNowForUser(userId).catch(() => Date.now());
  const cpId = checkpoint.id;
  await saveCharacterPhone({
    ...phone,
    photoRecords: [
      {
        id: `photo_${trip.id}_${cpId}`,
        title: checkpoint.title || gen.preset?.label || '',
        caption: checkpoint.diaryLine || checkpoint.collectibleHint || checkpoint.body || '',
        imageUrl: gen.image,
        imagePrompt: gen.prompt,
        location: checkpoint.placeName || trip.city || '',
        tags: ['旅行char', gen.preset?.label].filter(Boolean),
        takenAt: worldNow,
        createdAt: worldNow,
      },
      ...asArray(phone.photoRecords).filter((item) => item?.id !== `photo_${trip.id}_${cpId}`),
    ].slice(0, 80),
  }).catch(() => null);
}

// 手动入口：支持任意已解锁节点手动生图 + 重roll，已有图也允许重新生成并覆盖，不再早退。
export async function captureCheckpointPhoto({ userId, characterId, tripId, checkpointId }) {
  const trip = await loadOwnTrip(userId, characterId, tripId);
  const cpId = String(checkpointId || '').trim();
  const checkpoint = trip.checkpoints.find((cp) => cp.id === cpId);
  if (!checkpoint) throw new Error('节点不存在');
  const gen = await generateCheckpointPhotoRaw(trip, checkpoint);
  if (!gen.used || !gen.image) throw new Error(gen.error || '生图未开启或生成失败');
  const nextCheckpoints = trip.checkpoints.map((cp) => (
    cp.id !== cpId ? cp : { ...cp, capturedPhoto: { image: gen.image, caption: cp.diaryLine || cp.collectibleHint || cp.body || '' } }
  ));
  const nextTrip = await saveTravelCharTrip(userId, {
    ...trip,
    checkpoints: nextCheckpoints,
    apiUsage: { ...trip.apiUsage, imageCalls: Number(trip.apiUsage?.imageCalls || 0) + 1 },
  });
  await writeCheckpointPhotoRecord(userId, characterId, trip, checkpoint, gen);
  return nextTrip;
}

// 明信片生图提示词的可编辑入口：用户可以直接改写 override，或只切换内置风格模板。
export async function updateTravelPostcardPrompt({ userId, characterId, tripId, imagePromptOverride, styleId }) {
  const trip = await loadOwnTrip(userId, characterId, tripId);
  if (!trip.postcard) throw new Error('还没有归来的明信片');
  return saveTravelCharTrip(userId, {
    ...trip,
    postcard: {
      ...trip.postcard,
      imagePromptOverride: typeof imagePromptOverride === 'string' ? imagePromptOverride.slice(0, 1400) : trip.postcard.imagePromptOverride,
      styleId: TRAVEL_POSTCARD_STYLES[styleId] ? styleId : trip.postcard.styleId,
    },
  });
}

// 用当前 styleId/override 重新生成一次明信片图，是用户主动触发的一次额外生图调用。
export async function regenerateTravelPostcardImage({ userId, characterId, tripId }) {
  const trip = await loadOwnTrip(userId, characterId, tripId);
  if (!trip.postcard) throw new Error('还没有归来的明信片');
  const character = await getCharacter(characterId).catch(() => null);
  const characterName = character?.customNickname || character?.name || characterId;
  const preset = themePreset(trip.theme);
  const styleId = trip.postcard.styleId
    || resolvePostcardStyleIdFromPrefs(
      trip.imagePrefs,
      preset,
      (await loadImageToolConfig().catch(() => null))?.styles?.sceneStyleId || '',
    );
  const prompt = trip.postcard.imagePromptOverride
    || buildPostcardImagePrompt({ trip, preset, characterName, summary: trip.postcard.summary, styleId });
  const result = await maybeGenerateTravelImage(prompt);
  if (!result.used || !result.image) throw new Error(result.error || '生图未开启或生成失败');
  const nextTrip = await saveTravelCharTrip(userId, {
    ...trip,
    postcard: { ...trip.postcard, image: result.image, postcardImagePrompt: prompt },
    apiUsage: { ...trip.apiUsage, imageCalls: Number(trip.apiUsage?.imageCalls || 0) + 1 },
  });
  if (trip.postcard.collectibleId) {
    await saveCollectible({ id: trip.postcard.collectibleId, image: result.image, imagePrompt: prompt }).catch(() => null);
  }
  return nextTrip;
}

export { TRAVEL_THEME_PRESETS };
