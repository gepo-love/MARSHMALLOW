/**
 * 一起旅行 · 多日行程引擎（Phase D）。
 *
 * 定位：只管「行程结构」——把目的地/主题/天数拆成 days[]（每天若干真实候选地点 + 一个岔路
 * checkpoint），供 offline-session.js 的 beat 引擎在推进时参考；不接管叙事正文本身。
 * 数据挂在线下会话的 scene.itinerary 上，随会话一起存取/归档，不建立独立的顶层 store。
 *
 * 和 travel-char.js 的关系：这里是「一起旅行」（用户全程在场、手动推进的互动游戏）专用，
 * travel-char.js 是「旅行char」（放置流，自动时间推进）专用；两者定位不同，故意不共用同一模块。
 */
import { amapExploreFromSeed, buildAmapStaticMapUrl, loadAmapConfig } from './amap-tools.js';
import { resolveGenerationMaxTokens } from './api.js';
import { chatJsonGeneration } from './chat-json-generation.js';
import { getCharacterAiContextName } from '../models/character.js';
import { getUserDisplayName } from '../models/user.js';
import { buildTimeAndHolidayPromptBlock, getNowForUser } from './time-mode.js';

function clip(text = '', max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function genId(prefix = 'trip') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function characterBrief(characters = []) {
  return (Array.isArray(characters) ? characters : []).filter(Boolean).map((c) => ({
    name: getCharacterAiContextName(c, c?.id) || c?.name || 'TA',
    gender: String(c?.gender || '').trim(),
    personality: String(c?.personality || '').trim(),
    speechStyle: String(c?.speechStyle || '').trim(),
    speechCorpus: String(c?.speechCorpus || '').trim(),
    promptCorpus: String(c?.promptCorpus || '').trim(),
    currentRole: String(c?.currentRole || '').trim(),
    currentStatus: String(c?.currentStatus || '').trim(),
    userRelationStatus: String(c?.userRelationStatus || '').trim(),
    notes: String(c?.notes || '').trim(),
    relationships: c?.relationships && typeof c.relationships === 'object' ? c.relationships : undefined,
  }));
}

// 主题 -> 近邻检索类目：同质主题（咖啡/甜品/下午茶）已在旅行char那侧合并，这里只保留真正需要
// 不同选点策略的几档；其余（含自定义主题）走 amap-tools 默认类目，保持通用。
const THEME_NEARBY_QUERIES = {
  治愈海边: [
    { keywords: '海滩 海边 观景台', types: '' },
    { keywords: '咖啡店 甜品店', types: '050000' },
    { keywords: '民宿 海鲜餐馆', types: '050000' },
  ],
  'City Walk': [
    { keywords: '网红街区 文创园区 老城区', types: '' },
    { keywords: '咖啡店 独立书店', types: '' },
    { keywords: '公园 绿地 步道', types: '110000' },
  ],
  深度文化: [
    { keywords: '博物馆 美术馆 展览', types: '140000' },
    { keywords: '历史街区 古迹 古建筑', types: '' },
    { keywords: '书店 文创空间', types: '' },
  ],
  美食巡礼: [
    { keywords: '本地美食 老字号餐馆', types: '050000' },
    { keywords: '小吃街 夜市', types: '050000' },
    { keywords: '甜品 咖啡', types: '050000' },
  ],
};

async function resolveDestinationIfBlank({ destination, theme, characters, user }) {
  const dest = clip(destination, 60);
  if (dest) return dest;
  const worldTime = user?.id ? await buildTimeAndHolidayPromptBlock(user.id).catch(() => '') : '';
  const payload = {
    task: 'together_trip_pick_destination',
    theme: theme || '随性漫游',
    userName: getUserDisplayName(user),
    characters: characterBrief(characters),
    worldTime,
    rules: [
      '给这群人挑一个适合旅行的真实地点（城市/城区/古镇/景区级别，要具体到能在地图上搜到），贴合旅行主题和角色人设气质，不要挑烂大街的官方推荐语，要有点具体的理由。',
      '季节/气候暗示按 worldTime 世界时钟理解，不要按现实日历臆断。',
      '只输出 JSON：{"destination":"具体地名"}，不要解释，不要 Markdown。',
    ],
  };
  const generated = await chatJsonGeneration({
    scope: 'together-trip-destination',
    messages: [
      {
        role: 'system',
        content: ['你负责结合人物、时间和旅行主题选择真实可检索的目的地。只输出任务要求的 JSON。', JSON.stringify(payload, null, 2)].join('\n\n'),
      },
      { role: 'user', content: '请按上述人物、时间与主题选择这次旅行目的地。' },
    ],
    temperature: 0.9,
    validate: (value) => !!value?.destination,
  }).catch(() => null);
  const parsed = generated?.data || null;
  return clip(parsed?.destination, 60) || '一座适合慢慢逛的城市';
}

async function collectCandidatePois({ destination, theme, placeKeywords, durationDays }) {
  const amapCfg = await loadAmapConfig().catch(() => null);
  if (!amapCfg?.enabled || !amapCfg?.apiKey) return { pois: [], mapImage: '' };
  const seed = clip(placeKeywords || destination, 80);
  if (!seed) return { pois: [], mapImage: '' };
  try {
    const explored = await amapExploreFromSeed({
      keywords: seed,
      city: destination,
      maxResults: Math.max(6, Math.min(8, Number(amapCfg.maxResults || 6) || 6)),
      nearbyQueries: THEME_NEARBY_QUERIES[theme] || undefined,
    }, { config: amapCfg });
    const pois = Array.isArray(explored?.pois) ? explored.pois : [];
    const cap = Math.min(24, Math.max(8, Number(durationDays || 3) * 6));
    const picked = pois.slice(0, cap);
    const mapImage = picked.length ? buildAmapStaticMapUrl({
      key: amapCfg.apiKey,
      center: explored.center || picked.find((p) => p.location)?.location || '',
      markers: picked.filter((p) => p.location).slice(0, 8).map((p, idx) => ({ label: String(idx + 1), location: p.location })),
    }) : '';
    return { pois: picked, mapImage };
  } catch (err) {
    console.warn('[together-trip-itinerary] amap explore failed', err);
    return { pois: [], mapImage: '' };
  }
}

async function planDaysWithLlm({ destination, theme, durationDays, pois, characters, user, keptDays = [] }) {
  const worldTime = user?.id ? await buildTimeAndHolidayPromptBlock(user.id).catch(() => '') : '';
  const payload = {
    task: keptDays.length ? 'together_trip_replan_remaining_days' : 'together_trip_plan_days',
    destination,
    theme: theme || '随性漫游',
    totalDays: durationDays,
    userName: getUserDisplayName(user),
    characters: characterBrief(characters),
    worldTime,
    candidatePois: pois.map((p) => ({ name: p.name, district: p.district, address: p.address, category: p.bucketLabel })),
    alreadyHappened: keptDays.map((d) => ({
      dayIndex: d.dayIndex, title: d.title, summary: d.summary, stopNames: (d.stops || []).map((s) => s.name),
    })),
    rules: [
      keptDays.length
        ? `已经发生的第 1~${keptDays.length} 天见 alreadyHappened，只需要重新规划第 ${keptDays.length + 1} 天到第 ${durationDays} 天，保持和前面自然衔接，不要重复用 alreadyHappened 里出现过的地点。`
        : `把 candidatePois 里合适的地点分配进第 1 天到第 ${durationDays} 天，每天挑 2~3 个地点，同一地点不要在多天重复出现。`,
      'candidatePois 不够或不贴题时可以直接写通用场景描述（不强绑真实地点），但优先使用给出的真实地名。',
      '季节、昼夜、假期氛围按 worldTime 世界时钟理解，不要按现实日历臆断。',
      '每天给 title（≤12字的这天主题）、summary（1~2句这天大概怎么过，给叙事者当剧本大纲，不是逐字台词）、stopNames（这天用到的 candidatePois 原名数组）。',
      `除了第 ${durationDays} 天（收尾日不需要），每天设计一个岔路 checkpoint：一句简短情境 prompt（供叙事者自然埋一个引子，不是最终台词）+ 2~3 个选项 options（每个一个短语 label）+ 对应 branches（同 id，给 1~2 句这个选择大致会怎么发展，供叙事者据此续写，不是最终文本）。`,
      '只输出 JSON：{"days":[{"dayIndex":0,"title":"","summary":"","stopNames":["..."],"checkpoint":{"prompt":"","options":[{"id":"a","label":""}],"branches":{"a":{"body":""}}}}]}，dayIndex 从 0 开始；不要解释，不要 Markdown。',
    ],
  };
  const maxTokens = await resolveGenerationMaxTokens();
  const generated = await chatJsonGeneration({
    scope: 'together-trip-itinerary',
    messages: [
      {
        role: 'system',
        content: ['你负责把真实地点候选编排成贴合人物的多日旅行行程。只输出任务要求的 JSON。', JSON.stringify(payload, null, 2)].join('\n\n'),
      },
      { role: 'user', content: '请按上述完整人物与旅行上下文编排本次多日行程。' },
    ],
    temperature: 0.85,
    maxTokens,
    validate: (value) => Array.isArray(value?.days),
  }).catch(() => null);
  return generated?.data || null;
}

function buildDayFromRaw(raw = {}, dayIndex, pois = [], usedNames) {
  const stopNames = Array.isArray(raw.stopNames) ? raw.stopNames.map((n) => clip(n, 80)).filter(Boolean) : [];
  const stops = [];
  for (const name of stopNames) {
    if (usedNames.has(name)) continue;
    const match = pois.find((p) => p.name === name);
    usedNames.add(name);
    stops.push({
      id: genId('stop'),
      name,
      address: match?.address || '',
      district: match?.district || '',
      location: match?.location || '',
    });
    if (stops.length >= 3) break;
  }
  const checkpointRaw = raw.checkpoint && typeof raw.checkpoint === 'object' ? raw.checkpoint : null;
  const options = Array.isArray(checkpointRaw?.options)
    ? checkpointRaw.options
      .map((o, idx) => ({ id: clip(o?.id, 10) || String.fromCharCode(97 + idx), label: clip(o?.label, 30) }))
      .filter((o) => o.label)
      .slice(0, 3)
    : [];
  const branchesRaw = checkpointRaw?.branches && typeof checkpointRaw.branches === 'object' ? checkpointRaw.branches : {};
  const branches = {};
  options.forEach((o) => {
    const b = branchesRaw[o.id];
    branches[o.id] = { body: clip(b?.body, 200) || `你们选择了"${o.label}"，故事按这个方向继续发展。` };
  });
  const checkpoint = (options.length >= 2 && checkpointRaw?.prompt)
    ? {
      id: genId('cp'),
      type: 'choice',
      prompt: clip(checkpointRaw.prompt, 160),
      options,
      branches,
      resolvedOptionId: '',
    }
    : null;
  return {
    dayIndex,
    title: clip(raw.title, 20) || `第 ${dayIndex + 1} 天`,
    summary: clip(raw.summary, 160),
    stops,
    checkpoint,
  };
}

/**
 * 生成一份完整的多日行程：目的地可留空（由 AI 按人设/主题挑一个），主题决定选点偏向。
 * @returns {Promise<object>} itinerary
 */
export async function planTogetherTripItinerary({
  destination = '', theme = '', durationDays = 3, placeKeywords = '', characters = [], user = null,
} = {}) {
  const days = Math.max(1, Math.min(7, Number(durationDays) || 3));
  const resolvedDestination = await resolveDestinationIfBlank({ destination, theme, characters, user })
    .catch(() => clip(destination, 60));
  const { pois, mapImage } = await collectCandidatePois({
    destination: resolvedDestination, theme, placeKeywords, durationDays: days,
  });
  const planned = await planDaysWithLlm({
    destination: resolvedDestination, theme, durationDays: days, pois, characters, user,
  }).catch(() => null);
  const rawDays = Array.isArray(planned?.days) ? planned.days : [];
  const usedNames = new Set();
  const builtDays = [];
  for (let i = 0; i < days; i += 1) {
    const raw = rawDays.find((d) => Number(d?.dayIndex) === i) || rawDays[i] || {};
    builtDays.push(buildDayFromRaw(raw, i, pois, usedNames));
  }
  const createdAt = user?.id
    ? await getNowForUser(user.id).catch(() => Date.now())
    : Date.now();
  return {
    version: 1,
    destination: resolvedDestination,
    theme: theme || '',
    routeSummary: pois.length ? `${resolvedDestination} · ${pois.length} 个候选地点` : resolvedDestination,
    mapImage,
    days: builtDays,
    createdAt,
  };
}

/**
 * 从某一天起重新规划：保留之前已经发生的天数不变，只重新生成从 fromDayIndex 开始的行程。
 */
export async function rerollTogetherTripItinerary({
  itinerary, fromDayIndex = 0, reason = '', characters = [], user = null,
} = {}) {
  if (!itinerary || !Array.isArray(itinerary.days) || !itinerary.days.length) {
    throw new Error('没有可重新规划的行程');
  }
  const total = itinerary.days.length;
  const from = Math.max(0, Math.min(total - 1, Number(fromDayIndex) || 0));
  const keptDays = itinerary.days.slice(0, from);
  const excludeNames = new Set(keptDays.flatMap((d) => (d.stops || []).map((s) => s.name)));
  const { pois, mapImage } = await collectCandidatePois({
    destination: itinerary.destination, theme: itinerary.theme, placeKeywords: '', durationDays: total,
  });
  const freshPois = pois.filter((p) => !excludeNames.has(p.name));
  const planned = await planDaysWithLlm({
    destination: itinerary.destination, theme: itinerary.theme, durationDays: total,
    pois: freshPois, characters, user, keptDays,
  }).catch(() => null);
  const rawDays = Array.isArray(planned?.days) ? planned.days : [];
  const usedNames = new Set(excludeNames);
  const rebuiltDays = [...keptDays];
  for (let i = from; i < total; i += 1) {
    const raw = rawDays.find((d) => Number(d?.dayIndex) === i) || rawDays[i - from] || {};
    rebuiltDays.push(buildDayFromRaw(raw, i, freshPois, usedNames));
  }
  const rerolledAt = user?.id
    ? await getNowForUser(user.id).catch(() => Date.now())
    : Date.now();
  return {
    ...itinerary,
    version: (Number(itinerary.version) || 1) + 1,
    mapImage: mapImage || itinerary.mapImage,
    days: rebuiltDays,
    rerolledAt,
    rerollReason: clip(reason, 120),
  };
}

/** 当天待解决的岔路 checkpoint（已解决或没有则返回 null），供 UI 渲染选项按钮用。 */
export function pendingCheckpointForDay(itinerary, dayIndex) {
  const day = itinerary?.days?.[dayIndex];
  if (!day?.checkpoint || day.checkpoint.resolvedOptionId) return null;
  return day.checkpoint;
}

/**
 * 用户选了某个岔路选项：纯数据操作，不额外调用 LLM——branch.body 直接作为下一轮的
 * "本轮方向"，交给 offline-session 的 beat 引擎用角色自己的语气续写结果。
 */
export function resolveItineraryCheckpointChoice(itinerary, dayIndex, optionId) {
  if (!itinerary || !Array.isArray(itinerary.days)) return { itinerary, directiveText: '', optionLabel: '' };
  const days = itinerary.days.map((d) => ({ ...d }));
  const day = days[dayIndex];
  if (!day?.checkpoint || day.checkpoint.resolvedOptionId) return { itinerary, directiveText: '', optionLabel: '' };
  const opt = (day.checkpoint.options || []).find((o) => o.id === optionId);
  if (!opt) return { itinerary, directiveText: '', optionLabel: '' };
  const branch = day.checkpoint.branches?.[optionId];
  day.checkpoint = { ...day.checkpoint, resolvedOptionId: optionId };
  days[dayIndex] = day;
  return {
    itinerary: { ...itinerary, days },
    directiveText: branch?.body || `选择了"${opt.label}"`,
    optionLabel: opt.label,
  };
}

/** 喂进 beat prompt 的当日行程上下文（今日主题/地点/待埋的岔路引子）。 */
export function buildItineraryDayContextLines(itinerary, dayIndex) {
  if (!itinerary || !Array.isArray(itinerary.days)) return [];
  const day = itinerary.days[dayIndex];
  if (!day) return [];
  const lines = [];
  lines.push(`今日行程主题：${day.title}${day.summary ? ` —— ${day.summary}` : ''}`);
  if (day.stops?.length) {
    lines.push(`今日预计地点：${day.stops.map((s) => s.name).join('、')}（按叙事节奏自然经过即可，不必逐一点名交代，也不用严格按顺序）`);
  }
  if (day.checkpoint && !day.checkpoint.resolvedOptionId) {
    lines.push(`今日埋一个岔路悬念的引子（先自然铺垫这件事快要发生，不要直接把选项文本甩出来）：${day.checkpoint.prompt}`);
  }
  return lines;
}
