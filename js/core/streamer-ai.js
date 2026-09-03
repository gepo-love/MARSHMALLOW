import { chat, getConfig, resolveGenerationMaxTokens } from './api.js';
import { generateAnonymousAliasesForActors } from './anonymous-npc.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import { buildPresetFragmentContext } from './preset-store.js';
import { buildTimeAndHolidayPromptBlock } from './time-mode.js';
import { getStreamerPopularityTierById } from '../data/streamer-presets.js';
import { buildAnonymousRealLifeBlurRules, buildAnonymousHardBoundaryLine } from './anonymous-chat.js';
import { stripLeakedReasoning } from './narration-sanitize.js';
import { getCharacter } from './character-store.js';
import { resolveVoiceTranslationProfile } from '../models/character.js';
import { sanitizeAiTranslation } from './translation-utils.js';
import {
  loadVoiceToolConfig,
  normalizeVoiceSpeechPlan,
  resolveVoiceToolConfigForProfile,
} from './voice-tools.js';
import {
  buildVoiceWorldBookPrompt,
  VOICE_WORLD_BOOK_SURFACES,
} from './voice-worldbook.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

function normalizeAiPasteText(text = '') {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[“”]/g, '"')
    .replace(/['']/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
}

function extractJsonObject(text = '') {
  const raw = normalizeAiPasteText(text);
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch (_) { return null; }
  };
  let parsed = tryParse(raw);
  if (parsed) return parsed;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    parsed = tryParse(fence[1].trim());
    if (parsed) return parsed;
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    parsed = tryParse(raw.slice(start, end + 1));
    if (parsed) return parsed;
  }
  return null;
}

async function ensureAiReady() {
  const main = await getConfig();
  if (!String(main?.model || '').trim()) {
    const err = new Error('请先在设置里配置聊天 API');
    err.code = 'api-not-configured';
    throw err;
  }
}

function sanitizeStreamerHandle(value = '', fallback = '匿名主播') {
  let s = clean(value).replace(/["'`@#]/g, '').replace(/\s+/g, '');
  if (s.length > 12) s = s.slice(0, 12);
  return s || fallback;
}

/**
 * 让 AI 现场捏造一个匿名主播人格（不落库到 characters 表，人格数据完全内联）。
 * 同一轮里一起生成网名/性格/说话风格/签名 + 简单背景小传（为什么直播、世界观/设定），
 * 让创建页/编辑页可以把这份结果当成一份简易角色卡直接展示、供用户改。
 */
export async function generateStreamerPersonaAI({
  vibe = '',
  worldview = '',
  category = '',
} = {}) {
  await ensureAiReady();
  const requirements = [
    '背景设定与生成要求：',
    '- 你在为一场匿名深夜直播现场捏造一个主播马甲人格：网名、性格、说话风格各自独立设定，不要趋同、不要套用系统默认拼接词表风格（不要用两词硬拼的网名）。',
    '- handle 是马甲网名：2-8 个字，可中文、可带轻符号，绝不能是真实姓名、联系方式或任何可定位信息，也不能套用任何已知作品角色或真实人物。',
    '- streamReason（为什么直播）与 worldSetting（世界观/设定）是这个马甲的简单背景小传：streamReason 一句话说清楚这人图什么开播；worldSetting 默认写"普通现代人设"这类平实说明即可，只有明显偏奇幻/架空的氛围提示时才写虚构世界观，不要为了填字段硬造设定。',
    category ? `- 直播类型：${category}` : '',
    vibe ? `- 性格/氛围倾向：${vibe}` : '',
    worldview ? `- 世界观/设定倾向（已知信息，请据此延展 worldSetting）：${worldview}` : '',
  ].filter(Boolean).join('\n');
  const task = [
    '本次任务：生成这个匿名主播的完整人格设定。',
    '输出 JSON（只输出这个 JSON，不要解释、不要 Markdown）：',
    '{"handle":"主播马甲网名","personality":"一句话性格底色","speechStyle":"说话风格/语气","signature":"一句话匿名签名","streamReason":"为什么直播，10-40字","worldSetting":"世界观/设定，默认写普通现代人设即可，40字以内"}',
  ].join('\n');
  const maxTokens = await resolveGenerationMaxTokens();
  const response = await chat(
    [
      { role: 'system', content: requirements },
      { role: 'user', content: task },
    ],
    { temperature: 0.95, maxTokens },
  );
  const parsed = extractJsonObject(response) || {};
  return {
    handle: sanitizeStreamerHandle(parsed.handle),
    personality: clean(parsed.personality) || '随机捏的主播人格，性格待补充。',
    speechStyle: clean(parsed.speechStyle) || '口语、随性。',
    signature: clean(parsed.signature).slice(0, 60) || '刚开播，随便聊聊。',
    streamReason: clean(parsed.streamReason).slice(0, 200),
    worldSetting: clean(parsed.worldSetting).slice(0, 400),
  };
}

function fallbackStreamerHandle(character = {}) {
  const seed = String(character?.id || Math.random()).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const suffix = String(100 + (seed % 900));
  return { currentId: `深夜频道${suffix}`, signature: '不方便说太多，先看播。' };
}

/**
 * 通讯录角色来源的主播开播前，单独生成一个直播马甲（网名+签名），不直接暴露角色真名。
 * @returns {Promise<{handle:string, signature:string, usedAi:boolean, warning:string}>}
 */
export async function generateStreamerAliasForCharacterAI(character = {}, { category = '', streamReason = '' } = {}) {
  if (!character?.id) return { handle: '匿名主播', signature: '', usedAi: false, warning: '' };
  const result = await generateAnonymousAliasesForActors([character], {
    roomTopic: category ? `深夜直播 · ${category}` : '深夜直播',
    vibe: streamReason,
    required: false,
    useMainApi: true,
  }).catch((err) => ({ aliases: {}, warning: String(err?.message || err || '') }));
  const alias = result?.aliases?.[character.id];
  if (alias?.currentId) {
    return { handle: alias.currentId, signature: alias.signature || '', usedAi: true, warning: '' };
  }
  const fallback = fallbackStreamerHandle(character);
  return { handle: fallback.currentId, signature: fallback.signature, usedAi: false, warning: result?.warning || '' };
}

export function buildStreamerIsolationRules() {
  return [
    '【隔离规则 · 硬性】这是一个自封闭的匿名主播直播间小游戏，与角色本体在主线的记忆、聊天记录、关系进度完全无关，禁止在这里引用主线剧情，也不要把这里发生的事写回主线人设。',
    '你只是借用这个人物的说话风格与性格底色，来演出「一个在直播的匿名主播」，前台身份只有 persona 里给的信息。',
    '【身份自查】你没有失忆——是你自己主动选择用这个匿名主播马甲开播的，清楚自己为什么开播（见下方"为什么直播"）、清楚台下这些观众是刷进来看播的陌生人，不是你认识的人。你完全知道自己是谁、在做什么，只是选择在这里不暴露真实身份；不要表现出困惑、失焦或不知道自己在直播的样子。',
  ].join('\n');
}

function buildStreamerPersonaBlock(persona = {}) {
  const lines = [
    `主播马甲网名：${clean(persona.handle) || '匿名主播'}`,
    persona.categoryLabel ? `直播类型：${clean(persona.categoryLabel)}` : '',
    persona.streamReason ? `为什么直播：${clean(persona.streamReason)}` : '',
    persona.worldSetting ? `世界观/设定：${clean(persona.worldSetting)}` : '',
    persona.personality ? `性格底色：${clean(persona.personality)}` : '',
    persona.speechStyle ? `说话风格：${clean(persona.speechStyle)}` : '',
    persona.signature ? `签名：${clean(persona.signature)}` : '',
  ].filter(Boolean);
  return `【主播人设】\n${lines.join('\n')}`;
}

function buildDensityRules(popularityTier = 'small') {
  const tier = getStreamerPopularityTierById(popularityTier);
  const [min, max] = tier.danmakuRange;
  const vibeHint = tier.id === 'big'
    ? '弹幕密集嘈杂，混杂路人、粉丝、黑粉的声音，观点可以互相打架；用户的发言/打赏容易被刷屏淹没，除非专门点名。'
    : tier.id === 'mid'
      ? '弹幕有来有回，能看出几个常驻熟脸，氛围比较热闹但不算刷屏。'
      : '弹幕稀疏，在线人不多，熟人感强，很容易注意到用户说的话。';
  return `【弹幕密度】当前人气档位「${tier.label}」，本轮请生成 ${min}-${max} 条弹幕。${vibeHint}`;
}

function buildRecentHistoryBlock(channel = {}) {
  const lines = (channel.streamerLines || []).slice(0, 4).map((l) => `- 主播说：${clean(l.text)}`);
  const danmaku = (channel.recentDanmaku || []).slice(0, 8).map((d) => `- ${clean(d.from)}：${clean(d.text)}`);
  const blocks = [];
  if (lines.length) blocks.push(`【最近主播台词 · 保持连贯、勿重复】\n${lines.join('\n')}`);
  if (danmaku.length) blocks.push(`【最近弹幕 · 勿重复相同句子】\n${danmaku.join('\n')}`);
  return blocks.join('\n\n');
}

const STREAM_FLOW_HINTS = {
  chat: '闲聊唠嗑：像日常唠嗑一样自然换话题，可以从观众问题、突发念头、身边小事里找话题，别原地打转。',
  sing: '唱歌电台：可以报幕接下来想唱/念白的内容、聊点歌互动、讲讲歌背后的小故事；不要真的写出完整版权歌词，用「哼了几句」「唱到副歌」这类描述带过。',
  asmr: '助眠 ASMR：语气放松轻柔，多描述正在做的助眠动作/道具声音，节奏放慢，偶尔关心一下观众困不困。',
  game: '游戏陪玩：播报游戏内进展、翻车/推进这类起伏，适度带一点游戏梗和实况解说感。',
  study: '学习自习室：营造安静自习氛围，偶尔汇报一下进度、起来倒杯水这类小动作，别喧宾夺主。',
  late_night: '深夜档：氛围松弛私密，适合聊点心事、夜聊话题，语速可以放慢，带点夜晚特有的松弛感。',
  custom: '按主播自己的设定方向来，保持这个方向的连贯性，不要跑题到无关内容。',
};

function buildStreamFlowRules(category = 'chat') {
  const hint = STREAM_FLOW_HINTS[category] || STREAM_FLOW_HINTS.chat;
  return [
    '【直播流程 · 自主推进】即使观众没有发言/弹幕，你也要像正在直播的人一样自己找话题往下播，不要对着弹幕发呆式重复同一句话。',
    hint,
    '每隔几轮可以自然换一个小节奏（开场寒暄→正题→和弹幕互动→过渡到下一件事），避免连续多轮都在讲同一件事，也不要每轮都用同样的句式开头。',
  ].join('\n');
}

function buildSceneVoiceRules(persona = {}, voiceTranslation = null, voiceWorldBookPrompt = '') {
  const bits = [
    '如果这句话里主播的动作、表情、镜头前的小变化值得一提，写在全角括号里，例如（歪头笑了一下）（凑近镜头小声说）；括号内容只用于画面参考，不会被朗读出来。',
  ];
  if (persona.voiceEnabled) {
    bits.push('这场直播接了语音朗读，streamerLine 要是能自然读出声的口语句子，避免只有书面语才通的表达。');
    bits.push('括号里的动作描述尽量简短（4-10字以内），优先用"叹气""轻笑""停顿""清嗓子""喘了口气"这类能识别的简单动作词，不要写成一整句长描述——识别不出来的长描述会被直接丢弃，不会被朗读也不会体现在画面上。');
    bits.push('另写 speech 隐藏表演轨；speech.text 去掉隐藏提示后必须与 streamerLine 中真正说出口的台词一致，不得把括号动作、弹幕或画面写进去。');
  }
  if (voiceTranslation?.active) {
    const lang = voiceTranslation.language || 'TA 设定里的外语';
    bits.push(`【语音场景强制外语 · 直播台词】streamerLine 必须整句用${lang}说出口（像对着麦克风说话），正文不能写中文；全角括号（）里的动作描写仍可用中文。`);
    bits.push('同时必须另写 "zh" 给出简体中文翻译供观众点开字幕查看——「streamerLine 不写中文」绝不等于「不要 zh」，zh 只给看、不会被朗读。缺 zh = 掉格式。');
  }
  return [`【台词书写规则】\n${bits.join('\n')}`, voiceWorldBookPrompt].filter(Boolean).join('\n\n');
}

async function resolveStreamerVoiceTranslation(channel = {}) {
  if (channel?.sourceType !== 'character' || !channel?.characterId) return null;
  const char = await getCharacter(channel.characterId).catch(() => null);
  if (!char) return null;
  const profile = resolveVoiceTranslationProfile(char.translationProfile);
  return profile.active ? profile : null;
}

function buildScenePromptRules(isFirstScene = false) {
  const rules = [
    '【同轮画面 scenePrompt】额外给一句英文生图提示词，画面主体必须是主播本人的竖屏半身镜头（vertical half-body shot），不要写成空镜头/纯设备摆拍（不要只写摄像头、麦克风、桌面、房间摆设而没有人）。',
    '主播不露脸：可以是低头、侧脸、被手/麦克风/头发挡住、只露下巴或后脑勺，但禁止写清晰五官/正脸细节描述，也不要写不存在的第二个人。',
    '要贴合人设、世界观与此刻在做的事（姿势/动作/镜头角度的变化），风格自然、生活化。',
  ];
  if (isFirstScene) {
    rules.push('这是本场目前唯一一次定画面的机会（还没有任何画面），scenePrompt 这次必须写具体内容，不能留空。');
  } else {
    rules.push('如果这一轮画面和上一轮相比没有必要变化（比如只是随口聊两句），scenePrompt 可以留空字符串。');
  }
  return rules.join('\n');
}

/** 挂机自动推进 / 用户互动 / 重新开播……让 AI 清楚自己现在处于哪种状态、播到第几轮、大致该往哪个节奏走 */
function buildStreamerSessionStateBlock({ roundIndex = 1, mode = 'idle', songBy = 'user' } = {}) {
  const stageHint = roundIndex <= 1
    ? '这是本场开播的第一轮。'
    : roundIndex <= 3
      ? '还在开场热身阶段。'
      : roundIndex <= 10
        ? '已经进入正题阶段，按直播类型正常推进内容。'
        : '已经播了一段时间，可以找机会自然换个新话题、或者收一下当前小节奏（不代表要下播）。';
  const modeHint = {
    idle: '这一轮没有观众发言/弹幕/打赏触发，是你自己在挂机自动往下播的（观众可能在看播但没说话），按【直播流程·自主推进】接着往下说，不要每次都当成刚开播。',
    user: '这一轮是在回应观众刚发的弹幕/打赏。',
    song: songBy === 'streamer' ? '这一轮是你自己刚把背景音乐换成了新歌。' : '这一轮是在回应观众刚点的歌/切歌。',
    restart: '这是重新开播的第一轮。',
    opening: '这是开播不久的第一轮。',
  }[mode] || '';
  return `【本场进度】这是本场第 ${roundIndex} 轮内容。${stageHint}\n【当前状态】${modeHint}`;
}

function parseDanmakuRows(raw = []) {
  return (Array.isArray(raw) ? raw : [])
    .map((row) => {
      const text = clean(row?.text || row?.content).slice(0, 60);
      const rawZh = clean(row?.zh || row?.translation).slice(0, 120);
      const translation = sanitizeAiTranslation(text, rawZh);
      return {
        from: clean(row?.from || row?.name || '路人').slice(0, 16) || '路人',
        text,
        ...(translation ? { translation } : {}),
      };
    })
    .filter((row) => row.text);
}

async function requestStreamerBatch({ context, task, temperature = 0.92 }) {
  const maxTokens = await resolveGenerationMaxTokens();
  const response = await chat(
    [
      { role: 'system', content: context },
      { role: 'user', content: task },
    ],
    { temperature, maxTokens },
  );
  const parsed = extractJsonObject(response);
  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('主播未返回有效 JSON，已保留返回原文');
    err.reason = 'json-parse-failed';
    err.rawText = String(response ?? '').trim();
    err.rawResponse = err.rawText;
    throw err;
  }
  const streamerLine = stripLeakedReasoning(clean(parsed.streamerLine || parsed.line || parsed.text)).slice(0, 200);
  const speechPlan = streamerLine
    ? normalizeVoiceSpeechPlan(parsed.speech, stripStreamerSpeechStageDirections(streamerLine))
    : null;
  const rawZh = clean(parsed.zh || parsed.translation).slice(0, 200);
  const translation = sanitizeAiTranslation(streamerLine, rawZh);
  return {
    // streamerLine 要直接进 TTS 朗读，先过一遍思维链/英文协议泄漏过滤，
    // 免得偶尔从 JSON 字段里带出没洗干净的英文思考被念出来。
    streamerLine,
    ...(speechPlan ? { speechPlan } : {}),
    ...(translation ? { translation } : {}),
    danmaku: parseDanmakuRows(parsed.danmaku || parsed.comments || parsed.chat),
    scenePrompt: clean(parsed.scenePrompt || parsed.imagePrompt).slice(0, 300),
  };
}

function stripStreamerSpeechStageDirections(text = '') {
  return String(text || '').replace(/（[^（）]{1,80}）/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

async function buildStreamerWorldBookBlock(channel = {}, user = null, extraText = '') {
  const persona = channel?.persona || {};
  const selectiveBlob = [persona.worldSetting, persona.streamReason, persona.categoryLabel, extraText]
    .filter(Boolean).join('\n');
  const characterIds = channel?.sourceType === 'character' && channel?.characterId ? [channel.characterId] : [];
  const block = await buildWorldBookContextBlock(user, selectiveBlob, {
    worldBookMode: 'selective',
    characterIds,
  }).catch(() => '');
  return clean(block);
}

/**
 * 批量生成一轮「主播台词 + 弹幕 + 画面提示」。userMessage 存在时视为用户刚发的弹幕；isGift 为打赏时主播需要特别点名回应。
 */
export async function generateStreamerRoomBatchAI({
  channel,
  user = null,
  userMessage = '',
  isGift = false,
  giftLabel = '',
  openingTopic = '',
  songRequest = '',
  songBy = 'user',
  songComment = '',
} = {}) {
  await ensureAiReady();
  const persona = channel?.persona || {};
  const voiceTranslation = await resolveStreamerVoiceTranslation(channel);
  const voiceCharacter = channel?.sourceType === 'character' && channel?.characterId
    ? await getCharacter(channel.characterId).catch(() => null)
    : null;
  const globalVoiceConfig = persona.voiceEnabled
    ? await loadVoiceToolConfig().catch(() => null)
    : null;
  const voiceConfig = globalVoiceConfig
    ? resolveVoiceToolConfigForProfile(globalVoiceConfig, voiceCharacter?.voiceProfile || {})
    : null;
  const voiceWorldBookPrompt = voiceConfig?.styleBook?.enabled === true
    ? buildVoiceWorldBookPrompt(VOICE_WORLD_BOOK_SURFACES.STREAMER, {
      customText: voiceConfig.styleBook?.text || '',
      provider: voiceConfig.provider,
    })
    : '';
  const worldBookBlock = await buildStreamerWorldBookBlock(channel, user, userMessage || openingTopic);
  const presetBlock = await buildPresetFragmentContext('online').catch(() => '');
  const timeBlock = await buildTimeAndHolidayPromptBlock(channel?.userId).catch(() => '');
  const isFirstRound = !(channel?.streamerLines?.length);
  const isFirstScene = !(channel?.currentSceneImage || persona.avatarCover);
  const roundIndex = (channel?.streamerLines?.length || 0) + 1;
  const userMsg = clean(userMessage);
  const topicHint = clean(openingTopic);
  const songHint = clean(songRequest);
  const songNote = clean(songComment);
  const mode = userMsg ? 'user' : (songHint ? 'song' : (topicHint ? 'restart' : (isFirstRound ? 'opening' : 'idle')));
  const context = [
    buildStreamerIsolationRules(),
    buildAnonymousRealLifeBlurRules(),
    buildAnonymousHardBoundaryLine(),
    buildStreamerPersonaBlock(persona),
    buildStreamerSessionStateBlock({ roundIndex, mode, songBy }),
    buildDensityRules(persona.popularityTier),
    buildStreamFlowRules(persona.category),
    buildSceneVoiceRules(persona, voiceTranslation, voiceWorldBookPrompt),
    timeBlock,
    worldBookBlock,
    presetBlock,
    buildRecentHistoryBlock(channel),
  ].filter(Boolean).join('\n\n');
  const speechSchema = persona.voiceEnabled
    ? ',"speech":{"text":"与主播口播逐字一致、可带少量隐藏提示","emotion":"neutral","pace":"normal","intensity":0.2,"direction":"Fish 可用的简短英文指导或空字符串"}'
    : '';
  const lineSchema = voiceTranslation?.active
    ? `{"streamerLine":"外语台词","zh":"简体中文翻译"${speechSchema},"danmaku":[{"from":"弹幕昵称","text":"弹幕内容","zh":"外语弹幕才需要"}],"scenePrompt":"english image prompt or empty string"}`
    : `{"streamerLine":"主播说的话"${speechSchema},"danmaku":[{"from":"弹幕昵称","text":"弹幕内容","zh":"外语弹幕才需要"}],"scenePrompt":"english image prompt or empty string"}`;
  const task = [
    '本次任务：生成这场直播新一轮的「主播台词 + 一批弹幕 + 画面提示」。',
    voiceTranslation?.active
      ? `- streamerLine：主播说的一句话（10-60 词），必须整句用${voiceTranslation.language || '设定里的外语'}说，贴合人设口吻，像正在对着屏幕说话；另写 zh 给出简体中文翻译。`
      : '- streamerLine：主播说的一句话（10-60 字），贴合人设口吻，像正在对着屏幕说话，不要写成旁白或系统提示。',
    '- danmaku：观众发的弹幕列表，每条 from 是弹幕昵称（虚构网名 2-8 字，互不相同），text 是弹幕内容（2-20 字，短、口语、像真实直播间弹幕：刷梗、接话、吐槽、提问、纯表情文字都行）。',
    '- danmaku 每条可选 "zh"：仅当 text 是外语时给简体中文翻译；中文弹幕不要写 zh。',
    userMsg
      ? (isGift
        ? `观众刚刚打赏了「${giftLabel || '礼物'}」并说了：「${userMsg}」。主播的 streamerLine 必须特别点名感谢/回应这位观众，弹幕里也应有几条起哄/羡慕/跟风的反应。`
        : `观众刚刚发了弹幕：「${userMsg}」。主播的 streamerLine 可以自然回应这条弹幕（不必每次都点名，视人设和当下氛围决定），其余弹幕正常刷。`)
      : (songHint
        ? (songBy === 'streamer'
          ? `你（主播）自己刚把背景音乐换成了《${songHint}》${songNote ? `，换歌时心里想的是：「${songNote}」` : ''}。streamerLine 要像主播自己切完歌顺口说一句：为什么想放这首、跟着哼两句、或聊聊这首歌和此刻心情，语气自然贴人设；弹幕里可以有人接歌、评价品味、顺势点下一首。`
          : `观众刚刚点播/切换了背景音乐《${songHint}》。主播的 streamerLine 要自然接一句，比如评价这首歌、跟着哼一句、吐槽或夸点歌品味都行，不用很长；弹幕里也该有几条跟着讨论这首歌、附和点歌的反应。`)
        : (topicHint
          ? `这是本场重新开播的第一轮内容，这场想播的方向是：「${topicHint}」。streamerLine 要像刚开播打招呼、顺着这个方向起个头，弹幕里可以有人在问「这次播这个啊」之类的开场反应。`
          : (isFirstRound
            ? '这是开播不久的第一轮内容，弹幕可以有人在问「主播今天播什么」「什么时候开始的」等开场氛围。'
            : '这一轮没有新的弹幕/观众发言，你是自己挂机往下播的，按当前节奏自然接着说，不要用开场问候语气，也不要重复自己之前说过的话或话题。'))),
    buildScenePromptRules(isFirstScene),
    '只输出 JSON，不要解释、不要 Markdown：',
    lineSchema,
  ].filter(Boolean).join('\n');
  return requestStreamerBatch({ context, task });
}

/**
 * 主播自己从曲库里挑下一首背景音乐（char 自己切歌）。
 * @returns {Promise<{track:object|null, comment:string}>}
 */
export async function generateStreamerSongPickAI({ channel, tracks = [], currentTrack = '' } = {}) {
  await ensureAiReady();
  const persona = channel?.persona || {};
  const list = (Array.isArray(tracks) ? tracks : []).slice(0, 60);
  if (!list.length) return { track: null, comment: '' };
  const menu = list.map((t, i) => `${i + 1}. ${clean(t.title)} - ${clean(t.artist)}`).join('\n');
  const context = [
    buildStreamerIsolationRules(),
    buildStreamerPersonaBlock(persona),
    buildRecentHistoryBlock(channel),
  ].filter(Boolean).join('\n\n');
  const task = [
    '本次任务：主播想给直播间换一首背景音乐，请以主播本人的品味替TA从下面的曲库里挑一首最贴合人设与当下直播氛围的歌。',
    currentTrack ? `正在播的是《${currentTrack}》，不要再选这一首。` : '',
    `【曲库】\n${menu}`,
    '只输出 JSON，不要解释：{"index":曲目序号数字,"comment":"TA换这首歌时想说的一句话(10-40字)"}',
  ].filter(Boolean).join('\n');
  const maxTokens = await resolveGenerationMaxTokens();
  const response = await chat(
    [
      { role: 'system', content: context },
      { role: 'user', content: task },
    ],
    { temperature: 0.9, maxTokens },
  );
  const parsed = extractJsonObject(response) || {};
  const idx = Math.floor(Number(parsed.index ?? parsed.no ?? 0)) - 1;
  return {
    track: list[idx] || null,
    comment: clean(parsed.comment || parsed.reason).slice(0, 80),
  };
}

function parseFanCrowdRows(raw = []) {
  return (Array.isArray(raw) ? raw : [])
    .map((row) => ({
      from: clean(row?.from || row?.name).slice(0, 12) || '路人粉丝',
      text: clean(row?.text || row?.content).slice(0, 80),
    }))
    .filter((row) => row.text);
}

function buildFanGroupRecentHistoryBlock(recentLines = []) {
  const lines = (recentLines || []).slice(-12).map((l) => `- ${clean(l.from)}：${clean(l.text)}`);
  return lines.length ? `【最近粉丝群聊天 · 勿重复相同话题】\n${lines.join('\n')}` : '';
}

/**
 * 粉丝群一轮：不维护持久路人档案，每轮由 AI 现场虚构一批路人粉丝的发言，
 * 主播本人（actorHandle）偶尔搭话；群里显示的是虚构的大人数，营造真实粉丝群氛围。
 */
export async function generateStreamerFanGroupBatchAI({
  channel,
  user = null,
  memberCount = 0,
  userMessage = '',
  recentLines = [],
} = {}) {
  await ensureAiReady();
  const persona = channel?.persona || {};
  const tier = getStreamerPopularityTierById(persona.popularityTier);
  const [min, max] = tier.fanGroupCrowdRange || [2, 4];
  const worldBookBlock = await buildStreamerWorldBookBlock(channel, user, userMessage);
  const presetBlock = await buildPresetFragmentContext('online').catch(() => '');
  const timeBlock = await buildTimeAndHolidayPromptBlock(channel?.userId).catch(() => '');
  const context = [
    buildStreamerIsolationRules(),
    buildAnonymousRealLifeBlurRules(),
    buildAnonymousHardBoundaryLine(),
    buildStreamerPersonaBlock(persona),
    `【粉丝群场景】这是主播「${clean(persona.handle) || '匿名主播'}」的粉丝群，群里显示约 ${memberCount || '数百'} 名成员，但群里说话活跃的只是一小部分路人粉丝——每一轮都可以是全新的路人网名，不需要和之前的人保持是同一个人。`,
    timeBlock,
    worldBookBlock,
    presetBlock,
    buildFanGroupRecentHistoryBlock(recentLines),
  ].filter(Boolean).join('\n\n');
  const userMsg = clean(userMessage);
  const task = [
    '本次任务：生成粉丝群新一轮的「一批路人粉丝发言 + 主播（可选）搭话」。',
    `- crowd：路人粉丝发言列表，${min}-${max} 条，每条 from 是虚构网名（2-6 字，互不相同，本轮内也不要与上面最近记录重复），text 是像真实粉丝群聊天的一句话（吹主播、聊八卦、互相拌嘴、玩梗、回应用户都行，短口语，2-30 字）。`,
    '- streamerReply：主播本人是否插一句话，大多数轮次应该留空字符串（主播不用每轮都冒泡），只有明显该主播出面时才写（比如用户直接叫主播、群里在讨论主播、氛围需要主播定场）；要写就贴合人设口吻，一句话。',
    userMsg
      ? `用户刚在群里发了：「${userMsg}」。crowd 里应该有粉丝回应/起哄这条发言，streamerReply 视人设决定要不要亲自接一下。`
      : '这轮用户没有新发言，群里路人按自己的节奏闲聊即可，可以聊主播、聊直播内容、互相开玩笑。',
    '只输出 JSON，不要解释、不要 Markdown：',
    '{"crowd":[{"from":"路人网名","text":"发言内容"}],"streamerReply":"主播说的话或空字符串"}',
  ].filter(Boolean).join('\n');
  const maxTokens = await resolveGenerationMaxTokens();
  const response = await chat(
    [
      { role: 'system', content: context },
      { role: 'user', content: task },
    ],
    { temperature: 0.95, maxTokens },
  );
  const parsed = extractJsonObject(response);
  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('粉丝群未返回有效 JSON');
    err.reason = 'json-parse-failed';
    err.rawText = String(response ?? '').trim();
    throw err;
  }
  return {
    crowd: parseFanCrowdRows(parsed.crowd || parsed.comments || parsed.messages),
    streamerReply: clean(parsed.streamerReply || parsed.reply).slice(0, 200),
  };
}

/** 重新开播前，让 AI 帮忙定一个这场想播的方向（用户不指定主题时用） */
export async function generateStreamerOpeningTopicAI(channel = {}) {
  await ensureAiReady();
  const persona = channel?.persona || {};
  const timeBlock = await buildTimeAndHolidayPromptBlock(channel?.userId).catch(() => '');
  const context = [
    buildStreamerIsolationRules(),
    buildStreamerPersonaBlock(persona),
    timeBlock,
  ].filter(Boolean).join('\n\n');
  const maxTokens = await resolveGenerationMaxTokens();
  const response = await chat(
    [
      { role: 'system', content: context },
      { role: 'user', content: '这场主播准备重新开播，帮 TA 定一个这次想播的具体方向或话题（10-30 字，贴合人设，不要写成通用套话如"随便聊聊"）。只输出这句话本身，不要引号、不要解释。' },
    ],
    { temperature: 0.95, maxTokens },
  );
  return clean(response).replace(/^["'“”]|["'“”]$/g, '').slice(0, 60);
}
