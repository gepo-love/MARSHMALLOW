import { inferWetSoundAssetProfile } from './sound-library.js';

export { inferWetSoundAssetProfile };

const KISS_ACTION_PATTERN = /亲吻|接吻|吻上|吻住|拥吻|深吻|落下一吻|啄吻|亲了|唇瓣相贴|唇齿相触|唇舌|舌尖|吮吻|舔吻|舔舐|含住|吮吸/u;
const INTIMATE_WET_ACTION_PATTERN = /交合|进出|抽送|吞吐|顶弄|律动|研磨|结合处|交缠处|身下|指尖(?:探入|深入)|手指(?:探入|深入|抽动)|湿润动作|亲密动作(?:持续|加深|加快|放缓)|身体贴合着(?:动作|律动)/u;
// AI 已明确声明 wet 时，正文经常只承接上一句写“动作没停”，不会重复实体词。
// 这组词只用于校验显式声明，自动推断仍须满足动作 + 可闻湿润声的双证据规则。
const DECLARED_WET_CONTINUATION_PATTERN = /(?:动作|律动)(?:还|仍|依旧|一直|始终)?(?:没有|没|未)(?:停|停下|停住|结束)|(?:动作|律动)(?:还|仍|依旧|一直|始终)?(?:持续|继续)|仍维持着(?:原本|刚才|方才)?的动作|一下一下(?:地)?(?:继续|动作|起伏)|腰(?:身|胯)?(?:仍|还|继续)?(?:起伏|挺动)|(?:挺身|顶入|送入|没入|埋入|贯入|抽动)/u;
const INTIMATE_WET_SOUND_PATTERN = /湿黏|湿腻|黏腻|湿响|黏响|液体声|结合处(?:的)?水声|交缠处(?:的)?水声|动作间(?:的)?水声/u;
const ORDINARY_WATER_CONTEXT_PATTERN = /雨水|雨声|雨点|下雨|淋雨|浴室|淋浴|花洒|洗澡|洗头|湿头发|湿发|湿衣|湿毛巾|水杯|喝水|饮水|水渍|清洁|洗手|洗脸|流水|水龙头|河水|海水|湖水/u;
const CLEAR_NON_INTIMATE_WET_CONTEXT_PATTERN = /进入(?:房间|屋内|教室|会场|电梯|店里)|深入(?:聊|讨论|交流|了解|研究|调查)/u;
const FABRIC_CONTEXT_PATTERN = /布料|衣料|衣物|衣服|衣袖|袖口|裙摆|衬衫|外套|床单|床褥|被褥|被子/u;
const FABRIC_SOUND_PATTERN = /摩擦|摩挲|擦过|蹭过|窸窣|沙沙|布料声|衣料声|衣物声|衣服声|床单声|被褥声|轻响|响动|皱响/u;

function matchesIntimateWetTexture(source = '') {
  return INTIMATE_WET_ACTION_PATTERN.test(source)
    && INTIMATE_WET_SOUND_PATTERN.test(source);
}

/**
 * AI 明确给出的 wet 是动作计划的一部分，不应再要求正文机械复述固定关键词。
 * 这里只保留普通雨水/洗浴等反误判保护；自动从正文猜测 wet 时仍走上面的双证据规则。
 */
export function acceptsDeclaredWetSound(source = '') {
  const text = String(source || '').replace(/\s+/gu, ' ').trim();
  if (!text) return false;
  const hasDeclaredWetAction = INTIMATE_WET_ACTION_PATTERN.test(text)
    || DECLARED_WET_CONTINUATION_PATTERN.test(text);
  if (ORDINARY_WATER_CONTEXT_PATTERN.test(text) && !hasDeclaredWetAction) return false;
  // 只有亲吻/唇舌动作时始终交给 kiss；即使写了“湿润的吻/唇间水声”，
  // 也不能借声音词把另一套亲密 wet 素材混进接吻。
  if (KISS_ACTION_PATTERN.test(text) && !hasDeclaredWetAction) return false;
  // sound 是模型已经做出的显式音效编排。除已知误判语境外应尊重该声明，
  // 否则自然续写没有重复词表关键词时，会只剩同数组里的 body_movement。
  if (CLEAR_NON_INTIMATE_WET_CONTEXT_PATTERN.test(text) && !hasDeclaredWetAction) return false;
  return true;
}

function intimateWetTextureIndex(source = '') {
  const actionIndex = source.search(INTIMATE_WET_ACTION_PATTERN);
  const soundIndex = source.search(INTIMATE_WET_SOUND_PATTERN);
  return actionIndex >= 0 && soundIndex >= 0 ? Math.max(actionIndex, soundIndex) : -1;
}

function fabricTextureIndex(source = '') {
  const text = String(source || '').replace(/\s+/gu, ' ').trim();
  if (!text) return -1;
  // 只有同一句里同时出现布料对象和可闻摩擦/响动，才视作布料音效。
  // 单独提到床单、被子或衣服只是场景信息，不能持续给对白铺一层摩擦声。
  for (const match of text.matchAll(/[^。！？；!?]+/gu)) {
    const clause = String(match[0] || '');
    const contextIndex = clause.search(FABRIC_CONTEXT_PATTERN);
    const soundIndex = clause.search(FABRIC_SOUND_PATTERN);
    if (contextIndex >= 0 && soundIndex >= 0) {
      return Number(match.index || 0) + Math.max(contextIndex, soundIndex);
    }
  }
  return -1;
}

function matchesFabricTexture(source = '') {
  return fabricTextureIndex(source) >= 0;
}

export function acceptsDeclaredFabricSound(source = '') {
  return matchesFabricTexture(source);
}

function cueRuleMatches(rule, source = '') {
  if (typeof rule?.matches === 'function') return rule.matches(source);
  return rule?.pattern?.test(source) === true;
}

const CUE_RULES = Object.freeze([
  {
    category: 'kiss',
    pattern: KISS_ACTION_PATTERN,
  },
  {
    category: 'wet',
    // wet 与 kiss 严格分池：接吻只走 kiss。wet 必须出现非接吻的持续亲密动作
    // 和对应湿润声学证据，雨水/洗浴等普通水声继续交给环境分类。
    // 雨水、洗澡、湿头发、湿衣物或普通水渍统一交给环境水声，不进入该池。
    matches: matchesIntimateWetTexture,
    index: intimateWetTextureIndex,
  },
  {
    category: 'fabric',
    matches: matchesFabricTexture,
    index: fabricTextureIndex,
  },
  {
    category: 'breath_heavy',
    pattern: /呼吸急促|呼吸紊乱|呼吸凌乱|剧烈呼吸|喘息|喘着|重重喘|急喘|粗重的呼吸/u,
  },
  {
    category: 'breath_soft',
    pattern: /平稳呼吸|轻轻呼吸|轻缓呼吸|呼吸声|吸了口气|缓缓吐气|轻喘|气息拂过/u,
  },
  {
    category: 'footsteps',
    pattern: /脚步声|脚步渐近|脚步渐远|踩着地面|鞋跟声/u,
  },
  {
    category: 'door',
    pattern: /敲门声|叩门声|门铃响|门锁(?:轻响|咔哒|转动)|钥匙插进锁孔|拧动门把手|推开(?:房门|门)|拉开(?:房门|门)|关上(?:房门|门)|门轴(?:轻响|吱呀)|房门(?:打开|合上|关上)/u,
  },
  {
    category: 'body_movement',
    pattern: /拥抱|抱住|搂住|揽进怀里|依偎|贴进怀里|身体相贴|沙发微微下陷|床垫微微下陷/u,
  },
  {
    category: 'body_impact',
    pattern: /身体撞上|撞进怀里|撞在墙上|跌进怀里|摔在床上|倒在床上|身体相撞/u,
  },
]);

const CONTINUOUS_AMBIENCE_RULES = Object.freeze([
  {
    category: 'ambience_water',
    pattern: /浴室|淋浴|花洒|水流声|流水声|水声潺潺|洗澡|浴缸|潮湿的瓷砖/u,
  },
  {
    category: 'ambience_rain',
    pattern: /雨声|雨点|雨幕|下着雨|窗外的雨|暴雨|细雨|雨夜|雨水/u,
  },
  {
    category: 'ambience_scene',
    pattern: /卧室|房间里|室内|床边|沙发上|窗边|深夜的街道|咖啡馆|安静的夜/u,
  },
]);

const CONTINUOUS_BGM_RULES = Object.freeze([
  {
    category: 'bgm_tension',
    pattern: /紧张|压迫|僵持|争执|不安|危险|冷峻|克制着怒意|剑拔弩张/u,
  },
  {
    category: 'bgm_romantic',
    pattern: /浪漫|暧昧|爱意|告白|脸红|心跳|温柔地吻|轻轻吻|拥吻|亲密|耳鬓厮磨/u,
  },
  {
    category: 'bgm_night',
    pattern: /低落|失落|悲伤|难过|落寞|沉默良久|雨夜|深夜|夜色|月光/u,
  },
  {
    category: 'bgm_calm',
    pattern: /安静|陪伴|依偎|平静|温柔|闲聊|放松|安心|慵懒|宁静/u,
  },
]);

const TEXTURE_CATEGORIES = new Set([
  'fabric',
  'body_movement',
  'body_impact',
  'wet',
]);
const CUSTOM_CUE_CATEGORY_RE = /^user_cue_[a-z0-9]{6,48}$/u;
const CUSTOM_TEXTURE_CATEGORY_RE = /^user_texture_[a-z0-9]{6,48}$/u;
const CUSTOM_BACKGROUND_CATEGORY_RE = /^user_background_[a-z0-9]{6,48}$/u;

// sound 数组容量有限时，先保留真正承载动作状态的声音；fabric 只作伴随层，
// 不能因为模型先写了衣料窸窣，就把湿黏或身体拍击截掉。
const NARRATION_SOUND_CATEGORY_PRIORITY = Object.freeze({
  wet: 10,
  body_impact: 20,
  body_movement: 30,
  kiss: 40,
  breath_heavy: 50,
  breath_soft: 60,
  footsteps: 70,
  door: 80,
  fabric: 90,
  ambience_water: 110,
  ambience_rain: 111,
  ambience_scene: 112,
  bgm_romantic: 120,
  bgm_calm: 121,
  bgm_night: 122,
  bgm_tension: 123,
  bgm: 124,
});

function narrationSoundCategoryPriority(category = '') {
  const id = String(category || '').trim();
  if (CUSTOM_TEXTURE_CATEGORY_RE.test(id)) return 15;
  if (CUSTOM_CUE_CATEGORY_RE.test(id)) return 45;
  if (CUSTOM_BACKGROUND_CATEGORY_RE.test(id)) return 105;
  return Number(NARRATION_SOUND_CATEGORY_PRIORITY[id] || 999);
}

// 当前素材从近距离口腔小声到完整 BGM，源文件平均电平相差十余 dB。
// 所有旁白声音统一从这里做分类补偿；最终仍受用户滑块和 0..1 上限约束。
const NARRATION_SOUND_GAIN_COMPENSATION = Object.freeze({
  kiss: 1.55,
  wet: 3.4,
  fabric: 3,
  breath_soft: 1.4,
  breath_heavy: 1.2,
  body_movement: 3,
  body_impact: 1.8,
  footsteps: 1.55,
  door: 1.35,
  ambience_water: 1.8,
  ambience_rain: 1.55,
  ambience_scene: 1.6,
  bgm_romantic: 1,
  bgm_calm: 1,
  bgm_night: 1,
  bgm_tension: 1,
  bgm: 1,
});

const SHORT_SOUND_CATEGORIES = new Set(CUE_RULES.map((rule) => rule.category));
const CONTINUOUS_SOUND_CATEGORIES = new Set([
  ...CONTINUOUS_AMBIENCE_RULES.map((rule) => rule.category),
  ...CONTINUOUS_BGM_RULES.map((rule) => rule.category),
  'bgm',
]);

export function declaredNarrationSoundCategories(message = {}, { continuous = null } = {}) {
  const raw = message?.metadata?.soundCueCategories;
  const values = Array.isArray(raw) ? raw : [];
  const source = String(message?.content || message?.metadata?.text || '').replace(/\s+/g, ' ').trim();
  const isAllowed = (category) => {
    const id = String(category || '').trim();
    if (continuous === true) {
      return CONTINUOUS_SOUND_CATEGORIES.has(id) || CUSTOM_BACKGROUND_CATEGORY_RE.test(id);
    }
    if (continuous === false) {
      return SHORT_SOUND_CATEGORIES.has(id)
        || CUSTOM_CUE_CATEGORY_RE.test(id)
        || CUSTOM_TEXTURE_CATEGORY_RE.test(id);
    }
    return SHORT_SOUND_CATEGORIES.has(id)
      || CONTINUOUS_SOUND_CATEGORIES.has(id)
      || CUSTOM_CUE_CATEGORY_RE.test(id)
      || CUSTOM_TEXTURE_CATEGORY_RE.test(id)
      || CUSTOM_BACKGROUND_CATEGORY_RE.test(id);
  };
  return prioritizeNarrationSoundCategories([...new Set(values
    .map((category) => String(category || '').trim())
    .filter(isAllowed)
    .filter((category) => category !== 'wet' || acceptsDeclaredWetSound(source))
    .filter((category) => category !== 'fabric' || acceptsDeclaredFabricSound(source)))], { max: 3 });
}

const TEXTURE_STOP_PATTERN = /停下|停住|分开|松开|退开|拉开距离|不再动作|动作渐止/u;
const TEXTURE_RISING_PATTERN = /渐快|越来越快|逐渐加快|愈发急促|更加激烈|加重|用力|猛烈/u;
const TEXTURE_FALLING_PATTERN = /渐缓|慢下来|逐渐放慢|缓下来|放轻|动作变轻|平复/u;
const TEXTURE_STRONG_PATTERN = /激烈|猛烈|急促|重重|用力|剧烈|狠狠|撞击|撞上|失控/u;
const TEXTURE_SOFT_PATTERN = /轻轻|轻缓|缓慢|克制|小心|温柔|若有若无|细微/u;

function clampUnit(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function stableUnit(seed = '') {
  let hash = 2166136261;
  const source = String(seed || '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

export function isTextureSoundCategory(category = '') {
  const id = String(category || '').trim();
  return TEXTURE_CATEGORIES.has(id) || CUSTOM_TEXTURE_CATEGORY_RE.test(id);
}

export function prioritizeNarrationSoundCategories(categories = [], { max = 3 } = {}) {
  const rows = [];
  const seen = new Set();
  (Array.isArray(categories) ? categories : []).forEach((category, index) => {
    const id = String(category || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    rows.push({
      id,
      index,
      priority: narrationSoundCategoryPriority(id),
    });
  });
  const limit = Math.max(1, Math.min(3, Number(max || 3) || 3));
  return rows
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, limit)
    .map((row) => row.id);
}

export function resolveNarrationSoundMixVolume(baseVolume = 0.58, category = '', {
  eventGain = 1,
  layerScale = 1,
} = {}) {
  const numericBase = Number(baseVolume);
  const normalizedBase = Number.isFinite(numericBase)
    ? Math.max(0, Math.min(1, numericBase > 1 ? numericBase / 100 : numericBase))
    : 0.58;
  const numericEventGain = Number(eventGain);
  const normalizedEventGain = Number.isFinite(numericEventGain)
    ? Math.max(0, Math.min(1, numericEventGain))
    : 1;
  const numericLayerScale = Number(layerScale);
  const normalizedLayerScale = Number.isFinite(numericLayerScale)
    ? Math.max(0, Math.min(1, numericLayerScale))
    : 1;
  const categoryId = String(category || '').trim();
  const customCompensation = /^user_texture_/u.test(categoryId)
    ? 3
    : (/^user_(?:cue|background)_/u.test(categoryId) ? 1.45 : 1);
  const compensation = Number(
    NARRATION_SOUND_GAIN_COMPENSATION[categoryId] || customCompensation,
  );
  // 素材补偿只在较高滑块档位逐步展开。否则 quiet source 的 3x 补偿会把 10%
  // 重新推到约 30%，用户听起来就像滑块几乎无效；0 则必须始终保持绝对静音。
  const adaptiveCompensation = 1 + ((Math.max(1, compensation) - 1) * normalizedBase);
  return Math.round(Math.min(
    1,
    normalizedBase * normalizedEventGain * normalizedLayerScale * adaptiveCompensation,
  ) * 1000) / 1000;
}

/**
 * 背景滑块使用听感曲线而不是直接把百分比当振幅。线性振幅在低档仍然很响，
 * 且容易被系统录屏压缩听成 7% 与 17% 差不多；动作音量不走这条曲线。
 */
export function resolveNarrationBackgroundBaseVolume(value = 0.22) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric)
    ? Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric))
    : 0.22;
  return Math.round((normalized ** 1.6) * 10000) / 10000;
}

export function resolveTextureMixVolume(baseVolume = 0.58, eventGain = 1, category = '') {
  return resolveNarrationSoundMixVolume(baseVolume, category, { eventGain });
}

/**
 * 持续纹理本身就是对白表演的一部分，不应套用 BGM 的重度让路。这里只留少量余量
 * 防止高电平素材直接满幅盖住 TTS；动作音量拉满时，低电平素材仍应清晰可闻。
 */
export function resolveSpeechTextureMixVolume(baseVolume = 0.58, eventGain = 1, category = '') {
  const mixed = resolveTextureMixVolume(baseVolume, eventGain, category);
  return Math.round(Math.min(0.95, mixed * 0.95) * 1000) / 1000;
}

/**
 * HTMLAudioElement 的 volume 上限是 1。低电平素材选了“增强”后，单纯把素材音量
 * 乘到 1 附近仍可能被满音量 TTS 掩蔽；按本段实际命中的最强素材给人声留出少量空间，
 * 才能让正常 / 增强 / 强增强在连续播放与导出中保持可辨别的相对响度。
 */
export function resolveSpeechTextureVoiceVolume(mixGains = 1) {
  const values = Array.isArray(mixGains) ? mixGains : [mixGains];
  const strongest = values.reduce((max, value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 1);
  if (strongest <= 1) return 1;
  const strength = Math.max(0, Math.min(1, (strongest - 1) / 0.8));
  return Math.round((1 - (0.28 * (strength ** 0.85))) * 1000) / 1000;
}

/**
 * 动作纹理不是把一条素材死循环，而是在语音段内按强度稀疏穿插短片段。
 * AI 只负责语义强度和趋势；具体毫秒、轻微倍速与音量抖动由本地确定性生成，
 * 因而页面播放和导出可以复用同一个 seed 得到相同节奏。
 */
export function inferNarrationTexturePlanFromMessages(messages = []) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const source = joinMessageText(sourceMessages).replace(/\s+/g, ' ').trim();
  const declaredTextures = sourceMessages
    .flatMap((message) => declaredNarrationSoundCategories(message, { continuous: false }))
    .filter(isTextureSoundCategory);
  if (!source && !declaredTextures.length) return null;
  const stopIndex = source.search(TEXTURE_STOP_PATTERN);
  const lastTextureIndex = CUE_RULES.reduce((latest, rule) => {
    if (!isTextureSoundCategory(rule.category)) return latest;
    if (!cueRuleMatches(rule, source)) return latest;
    if (typeof rule.index === 'function') return Math.max(latest, rule.index(source));
    if (rule.pattern) return Math.max(latest, source.search(rule.pattern));
    return Math.max(latest, 0);
  }, -1);
  // 同一句可能先结束旧动作、再开始新动作（如“停下脚步后抱住她”）。
  // 只有停止语义出现在最后一个纹理动作之后，才真正清掉延续中的纹理层。
  if (!declaredTextures.length && stopIndex >= 0 && stopIndex >= lastTextureIndex) {
    return { categories: [], intensity: 0, tempo: 'falling', stop: true };
  }
  const inferredTextures = CUE_RULES
    .filter((rule) => isTextureSoundCategory(rule.category) && cueRuleMatches(rule, source))
    .map((rule) => rule.category);
  const categories = prioritizeNarrationSoundCategories([
    ...declaredTextures,
    ...inferredTextures,
  ], { max: 3 });
  if (!categories.length) return null;
  const planIntensities = sourceMessages
    .map((message) => Number(message?.metadata?.speechPlan?.intensity))
    .filter(Number.isFinite)
    .map((value) => clampUnit(value));
  let intensity = planIntensities.length ? Math.max(...planIntensities) : 0.34;
  if (categories.includes('body_impact')) intensity = Math.max(intensity, 0.62);
  else if (categories.includes('wet')) intensity = Math.max(intensity, 0.46);
  if (TEXTURE_STRONG_PATTERN.test(source)) intensity = Math.max(intensity, 0.78);
  if (TEXTURE_SOFT_PATTERN.test(source)) intensity = Math.min(intensity, 0.38);
  const tempo = TEXTURE_RISING_PATTERN.test(source)
    ? 'rising'
    : (TEXTURE_FALLING_PATTERN.test(source) ? 'falling' : 'steady');
  return {
    categories,
    intensity: Math.round(clampUnit(intensity, 0.34) * 100) / 100,
    tempo,
    stop: false,
  };
}

export function buildTextureSoundSchedule(plan = {}, {
  durationMs = 0,
  seed = '',
  maxEvents = 24,
} = {}) {
  const categories = prioritizeNarrationSoundCategories((Array.isArray(plan?.categories) ? plan.categories : [])
    .map((category) => String(category || '').trim())
    .filter(isTextureSoundCategory), { max: 3 });
  const duration = Math.max(0, Number(durationMs || 0));
  if (!categories.length || duration < 260 || plan?.stop === true) return [];
  const intensity = clampUnit(plan?.intensity, 0.34);
  const tempo = ['rising', 'falling'].includes(String(plan?.tempo || ''))
    ? String(plan.tempo)
    : 'steady';
  const result = [];
  const textureWeights = {
    wet: 3,
    body_impact: 3,
    body_movement: 2,
    fabric: 1,
  };
  const maxWeight = categories.reduce((max, category) => (
    Math.max(max, Number(textureWeights[category] || 1))
  ), 1);
  const categoryCycle = [];
  for (let weightIndex = 0; weightIndex < maxWeight; weightIndex += 1) {
    categories.forEach((category) => {
      if (Number(textureWeights[category] || 1) > weightIndex) categoryCycle.push(category);
    });
  }
  const categoryCounts = new Map();
  const canScheduleCategory = (category) => (
    category !== 'fabric' || Number(categoryCounts.get(category) || 0) < 1
  );
  let offset = 150 + Math.round(stableUnit(`${seed}|lead`) * 220);
  let index = 0;
  let cycleCursor = 0;
  while (offset < Math.max(180, duration - 110) && result.length < maxEvents) {
    const progress = duration > 0 ? offset / duration : 0;
    const contour = tempo === 'rising'
      ? 0.72 + progress * 0.56
      : (tempo === 'falling' ? 1.24 - progress * 0.52 : 1);
    const jitter = 0.82 + stableUnit(`${seed}|gap|${index}`) * 0.36;
    const baseGap = 1850 - intensity * 1280;
    const gap = Math.max(320, baseGap * jitter / contour);
    // 先轮转覆盖 AI 明确给出的每个纹理分类；此前完全随机挑分类，短对白即使
    // 同时声明 wet / fabric，也常常整段只播到其中一种。
    let category = '';
    for (let attempt = 0; attempt < categoryCycle.length; attempt += 1) {
      const candidate = categoryCycle[cycleCursor % categoryCycle.length];
      cycleCursor += 1;
      if (canScheduleCategory(candidate)) {
        category = candidate;
        break;
      }
    }
    if (!category) break;
    const rateJitter = (stableUnit(`${seed}|rate|${index}`) - 0.5) * 0.08;
    const volumeJitter = 0.88 + stableUnit(`${seed}|volume|${index}`) * 0.24;
    result.push({
      category,
      offsetMs: Math.round(offset),
      playbackRate: Math.round(Math.max(0.9, Math.min(1.15, 0.94 + intensity * 0.12 + rateJitter)) * 100) / 100,
      gain: Math.round(Math.max(0.18, Math.min(0.72, (0.28 + intensity * 0.34) * volumeJitter)) * 100) / 100,
      assetIndex: Math.floor(stableUnit(`${seed}|asset|${index}`) * 100000),
    });
    categoryCounts.set(category, Number(categoryCounts.get(category) || 0) + 1);
    offset += gap;
    index += 1;
  }
  const scheduledCategories = new Set(result.map((event) => event.category));
  const missingCategories = categories.filter((category) => (
    !scheduledCategories.has(category)
    // 极短对白优先容纳主动作纹理，不再为了“每类都覆盖”硬塞一声布料摩擦。
    && (category !== 'fabric' || duration >= 1200)
    && canScheduleCategory(category)
  ));
  if (missingCategories.length && result.length < maxEvents) {
    const lead = Math.min(160, Math.max(70, Math.round(duration * 0.18)));
    const tail = Math.max(lead, duration - 120);
    missingCategories.slice(0, maxEvents - result.length).forEach((category, missingIndex) => {
      const eventIndex = result.length + missingIndex;
      const offsetRatio = (missingIndex + 1) / (missingCategories.length + 1);
      const eventOffset = Math.round(lead + ((tail - lead) * offsetRatio));
      const rateJitter = (stableUnit(`${seed}|rate|coverage|${category}`) - 0.5) * 0.08;
      const volumeJitter = 0.88 + stableUnit(`${seed}|volume|coverage|${category}`) * 0.24;
      result.push({
        category,
        offsetMs: Math.max(0, Math.min(Math.max(0, duration - 110), eventOffset)),
        playbackRate: Math.round(Math.max(0.9, Math.min(1.15, 0.94 + intensity * 0.12 + rateJitter)) * 100) / 100,
        gain: Math.round(Math.max(0.18, Math.min(0.72, (0.28 + intensity * 0.34) * volumeJitter)) * 100) / 100,
        assetIndex: Math.floor(stableUnit(`${seed}|asset|coverage|${category}|${eventIndex}`) * 100000),
      });
      categoryCounts.set(category, Number(categoryCounts.get(category) || 0) + 1);
    });
    result.sort((left, right) => left.offsetMs - right.offsetMs || left.category.localeCompare(right.category));
  }
  return result;
}

function soundAssetSearchText(asset = {}) {
  return [asset?.sourceName, asset?.name, asset?.id]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
}

/**
 * 新素材包沿用 wet 分类，通过文件名里的 slow/gentle/fast/intense 等标签做强度分流。
 * 老包没有这些标签时仍完整可用；过滤后为空也会回退原池，不要求用户重新整理素材。
 */
export function filterTextureSoundAssetsByPlan(assets = [], category = '', plan = {}) {
  const rows = Array.isArray(assets) ? assets.filter(Boolean) : [];
  if (rows.length < 2) return rows;
  const targetDuration = Math.max(0, Number(plan?.durationMs || 0));
  const preferredMode = targetDuration >= 2800 ? 'span' : (targetDuration > 0 && targetDuration <= 1800 ? 'shot' : '');
  const modeMatched = preferredMode
    ? rows.filter((asset) => String(asset?.texturePlayback || 'auto') === preferredMode)
    : [];
  const modeRows = modeMatched.length ? modeMatched : rows;
  const durationMatched = targetDuration >= 4000
    ? modeRows.filter((asset) => Number(asset?.durationMs || 0) >= Math.min(3200, targetDuration * 0.55))
    : (targetDuration > 0 && targetDuration <= 1800
      ? modeRows.filter((asset) => Number(asset?.durationMs || 0) > 0 && Number(asset.durationMs) <= 2400)
      : []);
  const durationRows = durationMatched.length ? durationMatched : modeRows;
  if (String(category || '').trim() !== 'wet') return durationRows;
  const intensity = clampUnit(plan?.intensity, 0.46);
  const tagged = durationRows.map((asset) => ({ asset, ...inferWetSoundAssetProfile(asset) }));
  const targetPace = intensity <= 0.42
    ? 'gentle'
    : (intensity >= 0.75 || plan?.tempo === 'rising' ? 'intense' : 'rhythm');
  let selected = tagged.filter((item) => item.pace === targetPace);
  if (!selected.length && targetPace === 'rhythm') {
    selected = tagged.filter((item) => item.pace === 'natural');
  }
  if (!selected.length) selected = tagged;
  const targetLength = targetDuration >= 5000 ? 'long' : (targetDuration > 0 && targetDuration <= 1800 ? 'short' : '');
  if (targetLength) {
    const lengthMatches = selected.filter((item) => item.length === targetLength);
    if (lengthMatches.length) selected = lengthMatches;
  }
  return selected.map((item) => item.asset);
}

/** 短音效统一包络：亲吻保留更长尾音，其它动作轻收，避免文件末帧直接切断。 */
export function resolveSoundCueEnvelope(category = '', durationMs = 0) {
  const normalized = String(category || '').trim();
  const duration = Math.max(0, Number(durationMs || 0));
  const profile = normalized === 'kiss'
    ? { fadeInMs: 36, fadeOutMs: 360, postGapMs: 42 }
    : (normalized.startsWith('breath_')
      ? { fadeInMs: 48, fadeOutMs: 240, postGapMs: 56 }
      : (normalized === 'footsteps'
        ? { fadeInMs: 28, fadeOutMs: 180, postGapMs: 72 }
        : (normalized === 'door'
          ? { fadeInMs: 24, fadeOutMs: 190, postGapMs: 78 }
          : { fadeInMs: 34, fadeOutMs: 220, postGapMs: 64 })));
  if (!duration) return profile;
  return {
    fadeInMs: Math.round(Math.min(profile.fadeInMs, Math.max(12, duration * 0.12))),
    fadeOutMs: Math.round(Math.min(profile.fadeOutMs, Math.max(72, duration * 0.34))),
    postGapMs: profile.postGapMs,
  };
}

export function inferNarrationSoundCues(text = '', { max = 2 } = {}) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const limit = Math.max(1, Math.min(3, Number(max || 2) || 2));
  return prioritizeNarrationSoundCategories(
    CUE_RULES.filter((rule) => cueRuleMatches(rule, source)).map((rule) => rule.category),
    { max: limit },
  );
}

export function inferNarrationSoundCuesFromMessages(messages = [], options = {}) {
  const seen = new Set();
  const result = [];
  const max = Math.max(1, Math.min(3, Number(options.max || 2) || 2));
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = String(message?.content || message?.metadata?.text || '').trim();
    const categories = prioritizeNarrationSoundCategories([
      ...declaredNarrationSoundCategories(message, { continuous: false }),
      ...inferNarrationSoundCues(text, { max }),
    ], { max });
    for (const category of categories) {
      if (seen.has(category)) continue;
      seen.add(category);
      result.push(category);
      if (result.length >= max) return result;
    }
  }
  return result;
}

export function normalizeBreathSupplementMode(value = '') {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'off' || mode === 'none' || mode === 'disabled') return 'off';
  if (mode === 'reduced' || mode === 'light' || mode === 'low') return 'reduced';
  return 'standard';
}

export function filterBreathSoundCues(categories = [], mode = 'standard') {
  const normalized = normalizeBreathSupplementMode(mode);
  return (Array.isArray(categories) ? categories : []).filter((category) => {
    const id = String(category?.id || category || '').trim();
    if (normalized === 'off') {
      return id !== 'breath_soft' && id !== 'breath_heavy';
    }
    if (normalized === 'reduced') return id !== 'breath_soft';
    return true;
  });
}

/** 多角色共用一份音效计划时，取仍允许播放呼吸素材的最高档位。 */
export function combineBreathSupplementModes(modes = []) {
  const normalized = (Array.isArray(modes) ? modes : [])
    .map((mode) => normalizeBreathSupplementMode(mode));
  if (!normalized.length || normalized.includes('standard')) return 'standard';
  if (normalized.includes('reduced')) return 'reduced';
  return 'off';
}

function joinMessageText(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => String(message?.content || message?.metadata?.text || '').trim())
    .filter(Boolean)
    .join(' ');
}

export function inferNarrationContinuousSoundCuesFromMessages(messages = []) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const source = joinMessageText(sourceMessages).replace(/\s+/g, ' ').trim();
  const result = [...new Set(sourceMessages.flatMap((message) => (
    declaredNarrationSoundCategories(message, { continuous: true })
  )))].slice(0, 2);
  if (!source) return result;
  const ambience = CONTINUOUS_AMBIENCE_RULES.find((rule) => rule.pattern.test(source));
  const bgm = CONTINUOUS_BGM_RULES.find((rule) => rule.pattern.test(source));
  if (ambience && !result.includes(ambience.category)) result.push(ambience.category);
  if (bgm && !result.includes(bgm.category)) result.push(bgm.category);
  return result.slice(0, 2);
}
