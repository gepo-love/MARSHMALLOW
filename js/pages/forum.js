import { navigate, back, syncCurrentRoute } from '../core/router.js';
import * as db from '../core/db.js';
import { createMessage } from '../models/chat.js';
import { resolveGenerationMaxTokens } from '../core/api.js';
import { chatJsonGeneration } from '../core/chat-json-generation.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/svg-icons.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listAllWorldBookRows } from '../core/world-book-store.js';
import { listForumVisibleCharacters } from '../core/forum/forum-character-scope.js';
import { loadForumMetaCompat, saveForumMetaCompat } from '../core/forum/forum-meta-store.js';
import { buildForumAiSystemPrompt, collectForumRoleplayHints } from '../core/context/build-forum-context.js';
import { normalizeAuConfig } from '../core/au-config.js';
import { loadWebSearchConfig, runWebSearch } from '../core/web-search-tools.js';
import { getVirtualNow, nextChatMessageTimestamp } from '../core/virtual-time-shim.js';
import { applyGeneratedChatShares } from '../core/chat/social-chat-relay.js';
import { loadSocialLinkConfig, buildSocialLinkPromptHint } from '../core/chat/social-link-config.js';
import { saveMessage, updateChatPreview } from '../core/chat-store.js';
import { isAnonymousChat, isUserPresentInChat } from '../core/chat-helpers.js';
import { getAllStickersFlat } from '../core/chat/sticker-resolve.js';
import { stripLeakedCharacterCodes } from '../core/chat/character-code-fallback.js';
import {
  enforceForumRoleScopedAuthor,
  sanitizeGeneratedForumAuthor,
  sanitizeGeneratedForumReplyAuthor,
} from '../core/forum-identity.js';
import {
  listForumVests,
  resolveVestIdentity,
  buildVestSelectOptionsHtml,
  getForumVestById,
  loadForumProfile,
} from '../core/forum-vests.js';
import {
  mountStickerPickerAfterTextarea,
  extractStickerTagsToImageUrls,
  mergeSocialPostImageUrls,
  stripSocialStickerMarkers,
  stripSocialStickerTranslationArtifacts,
} from '../components/social-sticker-picker.js';
import { setButtonLoading, setGenStatus, setGenerationActivity } from '../components/generation-busy.js';
import {
  beginManualGeneration,
  finishManualGeneration,
  isManualGenerationRunning,
  subscribeManualGeneration,
  updateManualGeneration,
} from '../core/manual-generation-state.js';
import { pickGenerationScope } from '../components/generation-scope-picker.js';
import { openForwardPicker } from '../components/forward-picker.js';
import { bindSwipeActions } from '../components/swipe-actions.js';
import { openForumSettingsModal } from '../components/forum-settings-modal.js';
import { normalizeForumAutoPrefs } from '../core/forum/forum-auto.js';
import {
  buildForumTopicPlan,
  buildForumTopicPlanPrompt,
  hasFreshForumWeiboMaterial,
} from '../core/forum/forum-topic-plan.js';
import { fileToOptimizedChatImageDataUrl } from '../core/chat/chat-image-utils.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import {
  applySocialPostImages,
  buildSocialImageGenPromptRules,
  resolveSocialImageGenMode,
} from '../core/social-image-generation.js';
import {
  applyForumGenerationActorPlanBestEffort,
  materializeForumActors,
} from '../core/forum/forum-actors.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
  sanitizeAiTranslation,
} from '../core/translation-utils.js';

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeForumActorLabel(value, fallback = '论坛匿名') {
  const raw = String(value || '').trim();
  return stripLeakedCharacterCodes(raw, { fallbackLabel: fallback }).trim() || fallback;
}

function safeForumDisplayText(value) {
  return stripLeakedCharacterCodes(String(value || ''), { fallbackLabel: '论坛匿名' });
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function buildRandomGenerationKey(prefix = 'gen') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeForumPostCount(value, fallback = 3) {
  const count = Number(value);
  const safeFallback = Math.min(5, Math.max(1, Math.floor(Number(fallback) || 3)));
  return Number.isFinite(count) ? Math.min(5, Math.max(1, Math.floor(count))) : safeFallback;
}

function extractJsonObject(raw = '') {
  const body = String(raw || '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return body.slice(start, end + 1).trim();
}

function parseForumJson(raw) {
  const first = extractJsonObject(raw);
  if (!first) return null;
  try {
    return JSON.parse(first);
  } catch (_) { return null; }
}

function readForumImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function forumGeneratedImageOptions(enabled, allowTextImages = false, allowStickers = true) {
  return {
    allowLifePhoto: enabled === true,
    allowPersonPhoto: enabled === true,
    allowTextImage: allowTextImages === true,
    allowStickers: allowStickers !== false,
  };
}

async function buildForumGeneratedImageRules(enabled, allowTextImages = false, allowStickers = true) {
  const imageGenMode = enabled
    ? await resolveSocialImageGenMode('momentsImages').catch(() => '')
    : '';
  return buildSocialImageGenPromptRules(imageGenMode, {
    imageOptions: forumGeneratedImageOptions(enabled, allowTextImages, allowStickers),
    surface: 'forum',
  });
}

async function applyForumGeneratedImages(rows = [], enabled = false, allowTextImages = false, allowStickers = true) {
  return applySocialPostImages(rows, {
    scene: 'momentsImages',
    imageField: 'images',
    maxImages: 2,
    imageOptions: forumGeneratedImageOptions(enabled, allowTextImages, allowStickers),
  });
}

function pickForumGeneratedImageFields(row = {}) {
  const textImage = String(row.textImage || row.textImageCaption || '').trim();
  const images = Array.isArray(row.images) ? row.images.filter(Boolean).slice(0, 2) : [];
  return {
    images,
    imagePrompt: String(row.imagePrompt || '').trim(),
    imageCharacterId: String(row.imageCharacterId || '').trim(),
    textImage,
    textImageCaption: textImage,
    imageKind: images.length ? 'photo' : (row.imageKind === 'textimg' && textImage ? 'textimg' : ''),
  };
}

async function saveForumGenerationDebug(userId, kind, payload = {}) {
  await db.put('settings', {
    key: `forumGenerationDebug_${userId || 'guest'}`,
    value: {
      kind,
      savedAt: Date.now(),
      ...payload,
      raw: String(payload.raw || '').slice(0, 120000),
    },
  }).catch(() => {});
}

function objectKeys(value = {}) {
  return value && typeof value === 'object' ? Object.keys(value) : [];
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function coerceForumThreadRows(parsed = {}) {
  const root = parsed && typeof parsed === 'object' ? parsed : {};
  const data = root.data && typeof root.data === 'object' ? root.data : {};
  const section = root.section && typeof root.section === 'object' ? root.section : {};
  const rows = firstArray(
    root.threads,
    root.posts,
    root.items,
    root.results,
    root.topics,
    root.articles,
    root.forumPosts,
    root.forumThreads,
    root.threadList,
    data.threads,
    data.posts,
    data.items,
    data.topics,
    data.articles,
    data.forumPosts,
    section.threads,
    section.posts,
    section.topics,
  );
  if (rows.length) return rows.filter((item) => item && typeof item === 'object');
  const one = root.thread || root.post || data.thread || data.post;
  return one && typeof one === 'object' ? [one] : [];
}

function pickForumThreadTitle(row = {}, fallback = '无标题', stickerPool = []) {
  const raw = String(row.title || row.subject || row.name || row.heading || '').trim();
  return stripSocialStickerMarkers(raw, stickerPool) || fallback || '无标题';
}

function pickForumThreadContent(row = {}) {
  return String(row.content || row.body || row.text || row.mainText || row.post || row.description || '').trim();
}

function pickForumTranslation(row = {}) {
  return String(row?.zh || row?.translation || row?.contentTranslation || '').trim();
}

function sanitizeForumTranslation(source = '', translation = '', stickerPool = []) {
  const plainSource = stripSocialStickerMarkers(source, stickerPool);
  const plainTranslation = stripSocialStickerTranslationArtifacts(source, translation, stickerPool);
  return sanitizeAiTranslation(plainSource, plainTranslation);
}

function buildForumTranslationPrompt(characters = []) {
  return buildJsonFieldTranslationPromptBlock(
    collectTranslationActors(characters),
    { fields: 'content / replies[].content', exampleField: 'content' },
  );
}

function pickForumThreadReplies(row = {}) {
  return firstArray(row.replies, row.comments, row.floors, row.replyList, row.children);
}

const FORUM_TYPES = ['游戏', '同人', '八卦', '生活', '社畜', '校园', '考据', '闲聊', '凝视', '求助'];

const DEFAULT_FORUM_SECTIONS = [
  {
    id: 'cook_fail',
    name: '炸厨房小组',
    type: '生活',
    desc: '围绕翻车料理、夜宵事故、厨房求助和角色日常的小组。发帖可以轻松、有图感，但要贴合角色生活习惯。',
  },
  {
    id: 'gossip',
    name: '八卦小组',
    type: '八卦',
    desc: '围绕人际关系、活动风声、误会澄清和匿名爆料的八卦版块。允许拉扯和反转，但不能捏造与人设冲突的恶意黑料。',
  },
  {
    id: 'watching_you',
    name: '我会一直看着你👀',
    type: '凝视',
    desc: [
      '该板块仅限通讯录角色用伪装 ID / 小号发帖，不生成路人 NPC 主帖。输出要简短，像发帖角色本来的说话语气，不要写成统一论坛变态腔。',
      '<凝视心理>',
      '角色的视线在所有时候都无意识地追随{{user}}看似平常的微小动作、外表细节（衣着、局部特点）、个人习惯，并产生联想。',
      '与此同时，角色对{{user}}的凝视并非破坏欲，而是爱意混杂着迷恋、想要珍惜与疼爱 TA 的情感+联想心理。',
      '注意：念头的来源是【喜欢 TA】，先写感情再写欲望。通过凝视的视角来写被凝视对象身上的细节、肢体、神态等等。',
      '必须体现出【感情】！先感情再欲望！先写感情再写由感情出发的欲望！',
      '逻辑链：喜欢 TA-关注 TA-注意到 TA 身上的某个小细节-扩散想象',
      'Example：喜欢 TA-视线总会追着 TA-注意到 TA 锁骨下方有颗小痣-好想亲近',
      '暗恋 TA-假装自己很正常若无其事地相处-发现 TA 运动完出了汗-注意到力量感与体温-产生更进一步的幻想（气味-温度-接下来具体动作的幻想）',
      '注意:这种凝视是角色对{{user}}的，而不是{{user}}对角色。即使{{user}}暗恋角色，在未经指令的情况下也不要写{{user}}对角色的性幻想。',
      '',
      '以下<example>举例只是例句写法，禁止照抄复用，只允许参考。',
      '凝视对象',
      '<example_1>',
      'TA 思考的时候好像总喜欢轻轻咬住下唇，留下浅浅的痕迹。',
      '可爱，想亲，好喜欢。宝宝不要咬嘴唇了咬点别的吧？',
      '</example_1>',
      '',
      '<example_2>',
      '例:高岭之花{{user}}瞪人',
      'Char:被瞪得又心虚又……有点暗爽。就算是做蟑螂，好歹也成功让 TA 注意到了！',
      '</example_2>',
      '凝视者们会在论坛【一直看着你🥺】里分享自己对{{user}}的凝视。',
      '论坛内容',
      '分享的主要内容包括:',
      '日常接触+幻想触发、从一点无害细节衍生出的对对方性格/性癖/具体性征/做爱之类的幻想，可以是纯爱清水，一见钟情、crush等等。',
      '',
      '发帖人与文风：',
      '具体内容语气根据发帖人设定决定，需要模仿人物口吻、视角，参考对方和凝视对象（{{user}}）的关系来描写。',
      '参考例子（禁止照抄）',
      '1.【脑洞】养了一条宝宝小狗',
      '2.【偶遇】今天在散场后看见 TA 了……',
      '喜欢的人今天穿得好可爱🥵',
      '3.【黑泥】喜欢的人的队友好碍眼',
      '4.【发散】最适合宝宝的姿势是什么🤔',
      '7.【我就直说了】好想被宝宝……',
      '8.【讨论】宝宝有没有可能是……',
      '',
      '</凝视论坛内容>',
    ].join('\n'),
  },
];

function normalizeBoundIds(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(list.map((x) => String(x || '').trim()).filter(Boolean))];
}

function normalizeForumSection(sec = {}) {
  const preset = DEFAULT_FORUM_SECTIONS.find((item) => item.id === sec.id);
  const rawRules = sec.forumRules && typeof sec.forumRules === 'object' ? sec.forumRules : null;
  const desc = String(sec.id === 'watching_you'
    ? preset?.desc
    : (sec.desc || rawRules?.contentGuide || rawRules?.sectionRule || '')).trim();
  const worldBookIds = normalizeBoundIds(sec.worldBookIds || sec.worldBookId);
  return {
    id: String(sec.id || `sec_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`).trim(),
    name: String(sec.id === 'watching_you' ? preset?.name : (sec.name || '未命名板块')).trim(),
    type: String(sec.id === 'watching_you' ? preset?.type : (sec.type || '闲聊')).trim(),
    desc,
    worldBookIds,
    auEntryIds: normalizeBoundIds(sec.auEntryIds),
    materialQuery: String(sec.materialQuery || '').trim(),
    generationKey: String(sec.generationKey || '').trim(),
    postGenerationKey: String(sec.postGenerationKey || '').trim(),
    generationPrompt: String(sec.generationPrompt || '').trim(),
  };
}

function normalizeForumRules(rules, theme = '', desc = '') {
  const fallback = {
    sectionRule: `围绕主题「${theme || '当前主线'}」生成论坛版块内容，强调角色关系与当前虚拟时间一致。`,
    postFormat: '帖子结构建议：标题简短有梗；正文 2-6 段；可带转述、吐槽、引用；语气保持论坛口语化。',
    contentGuide: desc || '论坛内容应包含理性分析、情绪争执、复盘、错窗补救、观点对撞等真实讨论氛围。',
    replyRule: '回复与回复内容必须在同一段，不要拆成“回复标签一段 + 正文一段”。允许短句连发但保持楼层可读。',
  };
  const src = rules && typeof rules === 'object' ? rules : {};
  return {
    sectionRule: String(src.sectionRule || fallback.sectionRule).trim(),
    postFormat: String(src.postFormat || fallback.postFormat).trim(),
    contentGuide: String(src.contentGuide || fallback.contentGuide).trim(),
    replyRule: String(src.replyRule || fallback.replyRule).trim(),
  };
}

function rulesToText(rules) {
  const r = normalizeForumRules(rules);
  return [
    `版块规则：${r.sectionRule}`,
    `发帖格式：${r.postFormat}`,
    `论坛内容：${r.contentGuide}`,
    `回复规范：${r.replyRule}`,
  ].join('\n');
}

function characterMapFromList(list = []) {
  const out = {};
  for (const ch of list || []) {
    if (ch?.id) out[ch.id] = ch;
  }
  return out;
}

function forumCastModeMarkup(className, selected = 'mixed') {
  const options = [
    ['mixed', '路人 + 角色（随机混合）'],
    ['passersby', '纯路人'],
    ['roles', '仅角色（选择范围）'],
    ['scoped-mixed', '路人 + 角色（选择范围）'],
  ];
  return `
    <select class="form-input ${className}">
      ${options.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('')}
    </select>
  `;
}

function randomForumCharacters(characters = [], maxCount = 4) {
  const pool = (characters || []).filter((row) => row?.id && row.id !== 'user');
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const count = Math.min(pool.length, Math.max(1, 1 + Math.floor(Math.random() * Math.min(maxCount, pool.length))));
  return pool.slice(0, count);
}

async function resolveForumCast({
  mode = 'mixed',
  scopeKey = 'forum-posts',
  characters = [],
} = {}) {
  if (mode === 'passersby') return { mode, characters: [] };
  if (mode === 'mixed') {
    const picked = randomForumCharacters(characters);
    return { mode: picked.length ? mode : 'passersby', characters: picked };
  }
  const pickedScope = await pickGenerationScope({
    scopeKey,
    characters,
    title: mode === 'roles' ? '本轮出场角色' : '本轮混合角色',
  });
  if (!pickedScope) return null;
  return { mode, characters: pickedScope.characters.slice(0, 24) };
}

function buildForumCastPrompt(mode = 'mixed', characters = [], section = null) {
  const watchingOnly = section?.id === 'watching_you';
  if (mode === 'passersby') {
    return [
      '【本轮出场构成：纯路人】',
      '主帖作者、被提及者和回复者都必须是普通路人、匿名网友、NPC 或社区账号。',
      '禁止任何通讯录角色出场或被点名；thread.authorId 与 thread.authorRoleId 必须留空。',
    ].join('\n');
  }
  if (mode === 'roles') {
    return [
      '【本轮出场构成：仅角色】',
      '主帖作者必须来自下方角色候选名单并使用伪装 ID；不得让普通路人、匿名 NPC 或范围外角色成为主帖作者。',
      '每条 thread 都必须填写候选角色对应的 authorRoleId。',
    ].join('\n');
  }
  return [
    `【本轮出场构成：路人 + 角色混合${mode === 'scoped-mixed' ? '（自选范围）' : '（随机）'}】`,
    watchingOnly
      ? '该特殊版块的主帖仍必须由候选角色小号发布；回复区可以混入普通路人。'
      : '本批帖子必须同时出现候选角色的小号内容和普通路人内容，不要整批只写其中一类。',
    '通讯录角色只能使用下方候选名单；范围外角色不得作为作者、回复者或被点名。',
  ].join('\n');
}

function buildForumAuthorPrompt(characters = [], section = null) {
  const watchingOnly = section?.id === 'watching_you';
  const rows = (characters || [])
    .filter((ch) => ch?.id && ch.id !== 'user')
    .slice(0, 24)
    .map((ch) => `${ch.id}=${ch.name || ch.realName || ch.id}`)
    .join('、');
  return [
    '论坛发帖身份规则：',
    rows ? `可用角色：${rows}` : '当前没有可用角色；普通版块可使用路人/匿名网友。',
    '前台作者名必须是伪装 ID / 小号名，禁止把真实角色名写进 authorName，禁止使用「角色名-小号名」这种实名格式。',
    '若帖子是某个已知角色的小号/马甲发的，thread 必须写 authorRoleId=该角色 id，authorAlias=小号名，authorName=同一个小号名或更自然的伪装 ID。',
    '若帖子是普通路人或无法归属角色，authorRoleId 留空，authorName 写普通昵称；不要把用户写成发帖人。',
    watchingOnly ? '当前是「我会一直看着你👀」板块：主帖作者必须来自可用角色的小号，必须填写 authorRoleId/authorAlias；不要生成路人、NPC、匿名网友主帖。' : '普通版块允许混入路人/NPC/匿名网友。',
    '回复楼层也优先使用伪装 ID；如需让已知角色用小号回复，可在回复文本口吻里体现，但不要前台实名。',
  ].join('\n');
}

function isWatchingYouSection(section = {}) {
  return section?.id === 'watching_you' || String(section?.name || '').includes('我会一直看着你');
}

function buildWatchingYouStylePrompt(section = {}) {
  if (!isWatchingYouSection(section)) return '';
  return [
    '本板块额外写法：',
    '每条帖子必须短，正文 1-3 句即可；回复 0-2 条即可。',
    '最重要的是像发帖角色本人：用TA平时的词、节奏、克制程度和关系距离，不要为了论坛感变成统一的夸张变态腔。',
    '先写喜欢、心软、在意、疼惜，再从一个细节扩散一点欲望；不要只剩露骨欲望。',
  ].join('\n');
}

function parseReplyPrefix(content = '') {
  const text = String(content || '').trim();
  const patterns = [
    /^\[回复\s*#?(\d+)\s*[:：]\s*["“「]?([^"”」\]]*)["”」]?\]\s*([\s\S]*)$/u,
    /^\[回复\s+([^:：\]]+)\s*[:：]\s*["“「]?([^"”」\]]*)["”」]?\]\s*([\s\S]*)$/u,
    /^回复\s*#?(\d+)\s*[:：]\s*([\s\S]*)$/u,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    return {
      target: String(m[1] || '').trim(),
      content: String(m[3] || m[2] || text).trim(),
    };
  }
  return null;
}

function normalizeForumReplies(rows = [], timestamp = Date.now(), forbiddenNames = [], stickerPool = [], {
  user = {},
  characters = {},
} = {}) {
  const top = [];
  const children = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const parsed = parseReplyPrefix(raw?.content || '');
    const floor = Number(raw?.replyToFloor || raw?.parentFloor || 0) || (parsed && /^\d+$/.test(parsed.target) ? Number(parsed.target) : 0);
    const content = String(parsed?.content || raw?.content || raw?.text || raw?.body || '').trim();
    const translation = sanitizeForumTranslation(content, pickForumTranslation(raw), stickerPool);
    const identity = sanitizeGeneratedForumReplyAuthor(raw, characters, {
      user,
      forbiddenNames,
      strictRoleScope: true,
    });
    const item = {
      author: safeForumActorLabel(identity.author, '匿名'),
      content,
      timestamp,
      childReplies: [],
      authorSource: identity.authorSource,
      authorRoleId: identity.authorRoleId,
      forumActorId: identity.forumActorId,
      authorPersonality: String(raw?.authorPersonality || raw?.authorProfile?.personality || '').trim(),
      authorSpeechStyle: String(raw?.authorSpeechStyle || raw?.authorProfile?.speechStyle || '').trim(),
      authorBackground: String(raw?.authorBackground || raw?.authorProfile?.background || '').trim(),
      authorInterests: (Array.isArray(raw?.authorInterests) ? raw.authorInterests : raw?.authorProfile?.interests || [])
        .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 8),
      ...(translation ? { translation } : {}),
    };
    if (floor > 0) children.push({ floor, item });
    else top.push(item);
  }
  for (const child of children) {
    const parent = top[child.floor - 1];
    if (parent) parent.childReplies.push(child.item);
    else top.push(child.item);
  }
  return top.filter((r) => String(r.content || '').trim());
}

async function loadForumMeta(userId) {
  const src = await loadForumMetaCompat(userId);
  const rawSections = Array.isArray(src?.sections) && src.sections.length ? src.sections : DEFAULT_FORUM_SECTIONS;
  const normalized = rawSections.map(normalizeForumSection);
  const ids = new Set(normalized.map((s) => s.id));
  const deletedIds = new Set(Array.isArray(src?.deletedSectionIds) ? src.deletedSectionIds : []);
  for (const preset of DEFAULT_FORUM_SECTIONS) {
    if (!ids.has(preset.id) && !deletedIds.has(preset.id)) normalized.push(normalizeForumSection(preset));
  }
  const active = normalized.some((s) => s.id === src?.activeSectionId)
    ? src.activeSectionId
    : normalized[0]?.id;
  const savedOrder = Array.isArray(src?.sectionOrder) ? src.sectionOrder : [];
  const sectionIds = new Set(normalized.map((section) => section.id));
  const sectionOrder = [
    ...savedOrder.filter((id, index) => sectionIds.has(id) && savedOrder.indexOf(id) === index),
    ...normalized.map((section) => section.id).filter((id) => !savedOrder.includes(id)),
  ];
  return {
    ...(src || {}),
    sections: normalized,
    sectionOrder,
    activeSectionId: active,
    forumAuto: normalizeForumAutoPrefs(src?.forumAuto || {}, normalized),
  };
}

async function saveForumMeta(userId, meta) {
  await saveForumMetaCompat(userId, meta);
}

const FORUM_FUTURE_DRIFT_TOLERANCE_MS = 5 * 60 * 1000;

export function repairForumFutureTimestampDrift(threads = [], worldNow = Date.now(), {
  toleranceMs = FORUM_FUTURE_DRIFT_TOLERANCE_MS,
} = {}) {
  const now = Number(worldNow) || Date.now();
  const cutoff = now + Math.max(0, Number(toleranceMs) || 0);
  const changedThreads = [];
  const repairRow = (row = {}) => {
    let changed = false;
    let next = row;
    const timestamp = Number(row?.timestamp || 0);
    if (timestamp > cutoff) {
      next = { ...next, timestamp: now };
      changed = true;
    }
    if (Array.isArray(row?.childReplies)) {
      const repairedChildren = row.childReplies.map(repairRow);
      if (repairedChildren.some((item, index) => item !== row.childReplies[index])) {
        next = { ...next, childReplies: repairedChildren };
        changed = true;
      }
    }
    return changed ? next : row;
  };
  const repairedThreads = (Array.isArray(threads) ? threads : []).map((thread) => {
    let next = repairRow(thread);
    if (Array.isArray(thread?.replies)) {
      const repairedReplies = thread.replies.map(repairRow);
      if (repairedReplies.some((item, index) => item !== thread.replies[index])) {
        next = { ...next, replies: repairedReplies };
      }
    }
    if (next !== thread) changedThreads.push(next);
    return next;
  });
  return { threads: repairedThreads, changedThreads };
}

async function loadThreadsForUser(userId) {
  if (!userId) return [];
  let list;
  try {
    list = await db.getAllByIndex('forumThreads', 'userId', userId);
  } catch (_) {
    const all = await db.getAllRecords('forumThreads');
    list = all.filter((t) => t.userId === userId);
  }
  const worldNow = await getVirtualNow(userId, 0).catch(() => Date.now());
  const repaired = repairForumFutureTimestampDrift(list, worldNow);
  for (const thread of repaired.changedThreads) {
    await db.put('forumThreads', thread).catch(() => {});
  }
  return repaired.threads.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function forumThreadSignature(threads = []) {
  return (Array.isArray(threads) ? threads : [])
    .map((t) => [
      t.id,
      t.sectionId || '',
      t.timestamp || 0,
      t.title || '',
      String(t.content || '').slice(0, 120),
      Array.isArray(t.images) ? t.images.length : 0,
      Array.isArray(t.replies) ? t.replies.length : 0,
    ].join(':'))
    .join('|');
}

function forumMetaSignature(meta = {}) {
  return [
    meta.activeSectionId || '',
    JSON.stringify(meta.sectionOrder || []),
    JSON.stringify(meta.pinnedSectionIds || []),
    JSON.stringify(meta.forumAuto || {}),
    ...(Array.isArray(meta.sections) ? meta.sections : []).map((s) => [
      s.id,
      s.name || '',
      s.type || '',
      s.desc || '',
      normalizeBoundIds(s.worldBookIds || s.worldBookId).join(','),
      normalizeBoundIds(s.auEntryIds).join(','),
    ].join(':')),
  ].join('|');
}

export function mergeForumSectionEdit(meta = {}, sectionId = '', patch = {}) {
  const id = String(sectionId || '').trim();
  if (!id || !Array.isArray(meta?.sections)) return meta;
  let changed = false;
  const sections = meta.sections.map((section) => {
    if (String(section?.id || '') !== id) return section;
    changed = true;
    const next = { ...section, ...(patch && typeof patch === 'object' ? patch : {}) };
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'worldBookIds')) delete next.worldBookId;
    return next;
  });
  return changed ? { ...meta, sections } : meta;
}

function worldBookSelectMarkup(className, { multiple = false } = {}) {
  return `
    <label class="form-label">绑定世界书（可多选）</label>
    <select class="form-input ${className}" ${multiple ? 'multiple size="5"' : ''}></select>
    <p class="text-hint" style="font-size:11px;margin-top:4px;">选中后会读取该书中当前可用的全部条目；选择 0 项时不注入世界书。</p>`;
}

function isWorldBookRoot(row = {}) {
  return !!row?.isBookRoot
    && !row?.isCollection
    && row.id !== '_orphan'
    && row.system !== 'miniwiki';
}

function resolveSelectedWorldBookRootIds(selectedIds = [], rows = []) {
  const byId = new Map((rows || []).filter((row) => row?.id).map((row) => [String(row.id), row]));
  return [...new Set(normalizeBoundIds(selectedIds).map((id) => {
    const row = byId.get(id);
    if (isWorldBookRoot(row)) return String(row.id);
    return row?.bookId ? String(row.bookId) : '';
  }).filter(Boolean))];
}

async function fillWorldBookSelect(root, className, wbList, selectedIds = []) {
  const sel = root.querySelector(`select.${className}`);
  if (!sel) return;
  const picked = new Set(resolveSelectedWorldBookRootIds(selectedIds, wbList));
  sel.innerHTML = '';
  if (!sel.multiple) sel.appendChild(new Option('不绑定（仅用全局预设）', ''));
  for (const w of (wbList || []).filter(isWorldBookRoot)) {
    const o = new Option(w.name || w.title || w.id, w.id);
    if (picked.has(w.id)) o.selected = true;
    sel.appendChild(o);
  }
}

function auSelectMarkup(className) {
  return `
    <label class="form-label" style="margin-top:10px;">绑定 AU（可多选）</label>
    <select class="form-input ${className}" multiple size="5"></select>
    <p class="text-hint" style="font-size:11px;margin-top:4px;">生成会参考 AU 设定；不选则使用当前用户启用的 AU。</p>`;
}

function fillAuSelect(root, className, user, selectedIds = []) {
  const sel = root.querySelector(`select.${className}`);
  if (!sel) return;
  const cfg = normalizeAuConfig(user);
  const picked = new Set(normalizeBoundIds(selectedIds));
  sel.innerHTML = '';
  for (const entry of cfg.entries || []) {
    if (!entry.content) continue;
    const o = new Option(`${entry.name} · ${entry.category || 'AU'}`, entry.id);
    if (picked.has(entry.id)) o.selected = true;
    sel.appendChild(o);
  }
}

function selectedValues(root, selector) {
  const sel = root.querySelector(selector);
  if (!sel) return [];
  return [...sel.selectedOptions].map((o) => String(o.value || '').trim()).filter(Boolean);
}

function forumTypeSelectMarkup(className, current = '') {
  const cur = String(current || '').trim();
  const options = [...new Set([...FORUM_TYPES, cur].filter(Boolean))]
    .map((type) => `<option value="${escapeAttr(type)}" ${type === cur ? 'selected' : ''}>${escapeHtml(type)}</option>`)
    .join('');
  return `<select class="form-input ${className}">${options}</select>`;
}

function sectionSelectMarkup(className, sections, activeId = '') {
  return `<select class="form-input ${className}">${(sections || []).map((sec) => (
    `<option value="${escapeAttr(sec.id)}" ${sec.id === activeId ? 'selected' : ''}>${escapeHtml(sec.name)} · ${escapeHtml(sec.type || '闲聊')}</option>`
  )).join('')}</select>`;
}

function describeBoundResources(sec, wbList = [], user = null) {
  const wbNames = resolveSelectedWorldBookRootIds(sec.worldBookIds || sec.worldBookId, wbList)
    .map((id) => {
      const hit = wbList.find((w) => w.id === id);
      return hit?.name || hit?.title || id;
    })
    .filter(Boolean);
  const cfg = user ? normalizeAuConfig(user) : null;
  const auNames = normalizeBoundIds(sec.auEntryIds)
    .map((id) => cfg?.entries?.find((e) => e.id === id)?.name || id);
  return [
    sec.type ? `#${sec.type}` : '',
    wbNames.length ? `世界书 ${wbNames.length}` : '',
    auNames.length ? `AU ${auNames.length}` : '',
    sec.materialQuery ? '素材' : '',
  ].filter(Boolean).join(' · ');
}

async function collectForumWebMaterials(query, label = '') {
  const q = String(query || '').trim();
  if (!q) return '';
  const cfg = await loadWebSearchConfig().catch(() => null);
  if (!cfg?.enabled) return '';
  try {
    const result = await runWebSearch(q, { category: label || 'forum', maxResults: 5, searchDepth: 'basic', config: cfg });
    if (!result) return '';
    const rows = (result.results || []).slice(0, 5).map((item, idx) => (
      `${idx + 1}. ${item.title || item.url || '素材'}\n${item.content || ''}\n${item.url || ''}`.trim()
    ));
    return [
      `搜索词：${q}`,
      result.summary ? `摘要：${result.summary}` : '',
      rows.length ? `来源：\n${rows.join('\n')}` : '',
    ].filter(Boolean).join('\n');
  } catch (err) {
    console.warn('[forum web material]', err);
    return '';
  }
}

function openGlobalModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {} };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet modal-sheet-tall" role="dialog" aria-modal="true" data-modal-sheet>
        ${innerHtml}
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  return { close, root: host };
}

function buildThreadRows(rows = [], sections = [], stickerPool = []) {
  if (!rows.length) {
    return '<div class="forum-empty"><strong>这里还没有帖子</strong><span>点下方 + 发第一篇，或从菜单生成内容</span></div>';
  }
  const sectionMap = new Map((sections || []).map((s) => [s.id, s]));
  return `<div class="forum-thread-list">${rows.map((t) => {
    const rc = Array.isArray(t.replies) ? t.replies.length : 0;
    const imgN = Array.isArray(t.images) && t.images.length
      ? t.images.length
      : (t.imageKind === 'textimg' && t.textImage ? 1 : 0);
    const sec = sectionMap.get(t.sectionId || '');
    const excerpt = stripSocialStickerMarkers(safeForumDisplayText(String(t.content || '')), stickerPool)
      .replace(/\s+/g, ' ').slice(0, 72);
    const title = stripSocialStickerMarkers(safeForumDisplayText(t.title || ''), stickerPool) || '无标题';
    return `
      <div class="forum-swipe-row forum-thread-row" data-swipe-row data-thread-row="${escapeAttr(t.id)}">
        <div class="forum-swipe-actions" data-swipe-actions>
          <button type="button" class="forum-swipe-action is-share" data-thread-share="${escapeAttr(t.id)}">${icon('share')}<span>分享</span></button>
          <button type="button" class="forum-swipe-action is-danger" data-thread-delete="${escapeAttr(t.id)}">${icon('trash')}<span>删除</span></button>
        </div>
        <div class="forum-swipe-content" data-swipe-content>
          <button type="button" class="forum-thread-card forum-thread-open" data-thread-id="${escapeAttr(t.id)}">
            <div class="forum-thread-kicker">${escapeHtml(sec?.name || '社区广场')}</div>
            <div class="forum-thread-title">${escapeHtml(title)}</div>
            ${excerpt ? `<div class="forum-thread-excerpt">${escapeHtml(excerpt)}</div>` : ''}
            <div class="forum-thread-meta">
              <span>${escapeHtml(safeForumActorLabel(t.authorName, '论坛匿名'))}${t.authorVestBadge ? `<span class="forum-author-badge">${escapeHtml(t.authorVestBadge)}</span>` : ''}</span>
              <span>${rc} 回复</span>
              ${imgN ? `<span>${imgN} 图</span>` : ''}
              <span>${escapeHtml(formatTime(t.timestamp || 0))}</span>
            </div>
          </button>
          <button type="button" class="forum-row-more" data-swipe-more aria-expanded="false" aria-label="帖子操作">${icon('more')}</button>
        </div>
      </div>`;
  }).join('')}</div>`;
}

export function orderForumSections(sections = [], pinnedSectionIds = [], sectionOrder = []) {
  const pinned = new Set(Array.isArray(pinnedSectionIds) ? pinnedSectionIds : []);
  const rank = new Map((Array.isArray(sectionOrder) ? sectionOrder : []).map((id, index) => [id, index]));
  return [...(sections || [])].sort((a, b) => (
    Number(pinned.has(b.id)) - Number(pinned.has(a.id))
    || (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  ));
}

export function moveForumSectionOrder(sections = [], sectionOrder = [], sectionId = '', direction = 'up') {
  const ids = orderForumSections(sections, [], sectionOrder).map((section) => section.id);
  const index = ids.indexOf(sectionId);
  const target = direction === 'down' ? index + 1 : index - 1;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return ids;
}

export function forumThreadLastActivity(thread = {}) {
  let latest = Number(thread?.timestamp || 0) || 0;
  const visit = (rows = []) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      latest = Math.max(latest, Number(row?.timestamp || 0) || 0);
      visit(row?.childReplies);
    }
  };
  visit(thread?.replies);
  return latest;
}

export function sortForumThreads(threads = [], mode = 'activity', promotedIds = []) {
  const useCreatedAt = mode === 'created';
  const promoted = promotedIds instanceof Set ? promotedIds : new Set(promotedIds || []);
  return [...(Array.isArray(threads) ? threads : [])].sort((a, b) => {
    const promotedOrder = Number(promoted.has(b?.id)) - Number(promoted.has(a?.id));
    if (promotedOrder) return promotedOrder;
    const aTime = useCreatedAt ? Number(a?.timestamp || 0) : forumThreadLastActivity(a);
    const bTime = useCreatedAt ? Number(b?.timestamp || 0) : forumThreadLastActivity(b);
    return bTime - aTime || Number(b?.timestamp || 0) - Number(a?.timestamp || 0);
  });
}

export function planForumSectionDeletion(threads = [], sectionId = '', {
  mode = 'move',
  targetSectionId = 'general',
} = {}) {
  const affectedIds = [];
  const nextThreads = [];
  for (const thread of threads || []) {
    if ((thread.sectionId || '') !== sectionId) {
      nextThreads.push(thread);
      continue;
    }
    affectedIds.push(thread.id);
    if (mode !== 'delete') nextThreads.push({ ...thread, sectionId: targetSectionId });
  }
  return { affectedIds, threads: nextThreads };
}

function orderedSections(meta = {}) {
  return orderForumSections(meta.sections || [], meta.pinnedSectionIds || [], meta.sectionOrder || []);
}

function directorySections(meta = {}) {
  return orderForumSections(meta.sections || [], [], meta.sectionOrder || []);
}

function buildForumMainHtml(meta, threads, viewMode, wbList = [], user = null, stickerPool = [], promotedIds = []) {
  const sections = orderedSections(meta);
  const orderedThreads = sortForumThreads(threads, meta.forumAuto?.threadSort, promotedIds);
  const active = meta.activeSectionId || sections[0]?.id || '';
  const current = sections.find((s) => s.id === active) || sections[0] || {};
  if (viewMode === 'section') {
    const rows = orderedThreads.filter((t) => (t.sectionId || '') === current.id);
    return `
      <section class="forum-board-head">
        <button type="button" class="forum-board-back" data-forum-home>${icon('back')}<span>社区广场</span></button>
        <div class="forum-board-title-row">
          <div>
            <span>${escapeHtml(current.type || '闲聊')}</span>
            <h2>${escapeHtml(current.name || '版块')}</h2>
          </div>
          <button type="button" class="forum-quiet-action" data-forum-ai-post-current>${icon('sparkle')}<span>生成</span></button>
        </div>
        ${current.desc ? `<p>${escapeHtml(String(current.desc).split('\n')[0].slice(0, 100))}</p>` : ''}
      </section>
      ${buildThreadRows(rows, sections, stickerPool)}
      <button type="button" class="forum-compose-fab" data-forum-compose aria-label="发帖">${icon('plus')}</button>
    `;
  }

  const pinnedIds = new Set(Array.isArray(meta.pinnedSectionIds) ? meta.pinnedSectionIds : []);
  const shown = sections;
  return `
    <section class="forum-plaza-head">
      <span>COMMUNITY</span>
      <h2>社区广场</h2>
    </section>
    <section class="forum-featured">
      <div class="forum-section-heading"><h3>版块</h3><button type="button" data-forum-menu-open>打开目录</button></div>
      <div class="forum-featured-grid">
        ${shown.map((sec) => {
          const count = threads.filter((t) => (t.sectionId || '') === sec.id).length;
          return `<button type="button" class="forum-featured-card" data-section-open="${escapeAttr(sec.id)}">
            <span>${escapeHtml(sec.type || '闲聊')}</span>
            <strong>${escapeHtml(sec.name || '版块')}</strong>
            <small>${count} 篇帖子</small>
          </button>`;
        }).join('')}
      </div>
    </section>
    <section class="forum-latest">
      <div class="forum-section-heading"><h3>最新讨论</h3><span>${threads.length} 篇</span></div>
      ${buildThreadRows(orderedThreads.slice(0, 30), sections, stickerPool)}
    </section>
  `;
}

function buildForumDrawerHtml(meta, threads, profile = {}) {
  const pinned = new Set(Array.isArray(meta.pinnedSectionIds) ? meta.pinnedSectionIds : []);
  const sections = directorySections(meta);
  return `
    <div class="forum-nav-backdrop" data-forum-menu-close hidden>
      <aside class="forum-nav-sheet" role="dialog" aria-modal="true" aria-label="论坛导航">
        <header><h2>论坛目录</h2><button type="button" data-forum-menu-close aria-label="关闭">${icon('close')}</button></header>
        <button type="button" class="forum-nav-profile" data-forum-vest-home>
          <img src="${escapeAttr(profile.avatar || resolveDefaultAvatar('forum'))}" alt="">
          <span class="forum-nav-profile-copy"><strong>${escapeHtml(profile.displayName || '我的论坛主页')}</strong><small>个人主页与身份编辑</small></span>
          <span aria-hidden="true">›</span>
        </button>
        <div class="forum-nav-directory-head">
          <strong>版块</strong>
          <div>
            <button type="button" data-forum-new-sec aria-label="创建版块">${icon('plus')}</button>
            <button type="button" data-forum-ai-board aria-label="AI 创建版块">${icon('sparkle')}</button>
            <button type="button" data-forum-sec-edit aria-label="编辑当前版块">${icon('edit')}</button>
          </div>
        </div>
        <div class="forum-nav-sections">
          ${sections.map((sec, index) => {
            const count = threads.filter((t) => (t.sectionId || '') === sec.id).length;
            return `<div class="forum-swipe-row forum-nav-section-row" data-swipe-row data-section-row="${escapeAttr(sec.id)}">
              <div class="forum-swipe-actions" data-swipe-actions>
                <button type="button" class="forum-swipe-action is-pin" data-section-pin="${escapeAttr(sec.id)}">${icon('pin')}<span>${pinned.has(sec.id) ? '取消置顶' : '置顶'}</span></button>
                <button type="button" class="forum-swipe-action is-danger" data-section-delete="${escapeAttr(sec.id)}">${icon('trash')}<span>删除</span></button>
              </div>
              <div class="forum-swipe-content" data-swipe-content>
                <button type="button" class="forum-nav-section-main" data-section-open="${escapeAttr(sec.id)}">
                  <span>${escapeHtml(sec.type || '闲聊')}</span>
                  <strong>${escapeHtml(sec.name || '版块')}</strong>
                  <small>${count} 篇${pinned.has(sec.id) ? ' · 已置顶' : ''}</small>
                </button>
                <div class="forum-nav-section-order">
                  <button type="button" data-section-move="up" data-section-id="${escapeAttr(sec.id)}" aria-label="上移${escapeAttr(sec.name || '版块')}" ${index === 0 ? 'disabled' : ''}>↑</button>
                  <button type="button" data-section-move="down" data-section-id="${escapeAttr(sec.id)}" aria-label="下移${escapeAttr(sec.name || '版块')}" ${index === sections.length - 1 ? 'disabled' : ''}>↓</button>
                </div>
                <button type="button" class="forum-row-more" data-swipe-more aria-expanded="false" aria-label="版块操作">${icon('more')}</button>
              </div>
            </div>`;
          }).join('')}
        </div>
        <footer class="forum-nav-footer">
          <button type="button" data-forum-settings>${icon('settings')}<span>论坛设置</span></button>
          <button type="button" class="forum-nav-danger" data-forum-clear-all>清空全部帖子</button>
        </footer>
      </aside>
    </div>
  `;
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  const userId = user?.id || null;
  const virtualNow = await getVirtualNow(userId || '', 0);
  const wbOptions = await listAllWorldBookRows();
  const characterList = await listForumVisibleCharacters(user, { excludeAnonNpc: true }).catch(() => []);
  const characterMap = characterMapFromList(characterList);
  let threads = await loadThreadsForUser(userId);
  const stickerPool = await getAllStickersFlat();
  let meta = await loadForumMeta(userId);
  const promotedThreadIds = new Set();
  const forumProfile = await loadForumProfile(userId, user);
  const forumIdentityUser = { ...user, nickname: forumProfile.displayName };
  const forumVests = await listForumVests(userId);
  await materializeForumActors({
    userId,
    user: forumIdentityUser,
    forbiddenNames: forumVests.map((vest) => vest.displayId),
    threads,
    useStickerAvatars: meta.forumAuto?.passerbyStickerAvatars === true,
    stickerPool,
  });
  const generatedAuthorOptions = {
    user: forumIdentityUser,
    userId,
    forbiddenNames: forumVests.map((vest) => vest.displayId),
  };
  const forbiddenGeneratedNames = [
    forumProfile.displayName,
    user?.name,
    user?.nickname,
    ...forumVests.map((vest) => vest.displayId),
  ].filter(Boolean);
  const requestedSectionId = String(params?.sectionId || '').trim();
  if (requestedSectionId && (meta.sections || []).some((section) => section.id === requestedSectionId)) {
    meta.activeSectionId = requestedSectionId;
  }
  let viewMode = requestedSectionId ? 'section' : 'home';
  for (const sec of meta.sections || []) {
    if (!sec.forumRules) sec.forumRules = normalizeForumRules(null, sec.name || '', sec.desc || '');
  }

  container.className = 'page forum-page';
  container.innerHTML = `
    <header class="navbar forum-navbar">
      <button type="button" class="forum-nav-icon" data-back aria-label="返回">${icon('back')}</button>
      <button type="button" class="forum-profile-entry" data-forum-vest-home aria-label="论坛主页">
        <img src="${escapeAttr(forumProfile.avatar || resolveDefaultAvatar('forum'))}" alt="">
      </button>
      <h1 class="navbar-title">论坛</h1>
      <button type="button" class="forum-nav-icon" data-forum-menu-open aria-label="论坛导航">${icon('menu')}</button>
    </header>
    <div class="generation-activity forum-generation-activity" data-forum-generation-activity role="status" aria-live="polite" hidden></div>
    <main class="forum-scroll"><div class="forum-list">${buildForumMainHtml(meta, threads, viewMode, wbOptions, user, stickerPool, promotedThreadIds)}</div></main>
    <div class="forum-drawer-host">${buildForumDrawerHtml(meta, threads, forumProfile)}</div>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelector('[data-forum-vest-home]')?.addEventListener('click', () => navigate('forum-vest-home', {}));
  const generationStateKey = `forum:${userId || 'guest'}`;
  const generationRenderToken = `forum-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  container.dataset.manualGenerationRender = generationRenderToken;
  let stopGenerationState = () => {};
  stopGenerationState = subscribeManualGeneration(generationStateKey, (state) => {
    if (!container.isConnected
      || container.dataset.page !== 'forum'
      || container.dataset.manualGenerationRender !== generationRenderToken) {
      stopGenerationState();
      return;
    }
    setGenerationActivity(container.querySelector('[data-forum-generation-activity]'), state);
    if (state?.status === 'success') void reloadForumFromStore({ force: true });
  });

  const refreshListDom = () => {
    const el = container.querySelector('.forum-list');
    if (el) {
      el.innerHTML = buildForumMainHtml(meta, threads, viewMode, wbOptions, user, stickerPool, promotedThreadIds);
      bindThreadClicks();
      bindSectionTabs();
      bindInlineActions();
      bindNavigation();
    }
  };

  let lastForumSignature = `${forumMetaSignature(meta)}::${forumThreadSignature(threads)}`;
  let refreshInFlight = false;
  let forumRefreshSeq = 0;
  async function reloadForumFromStore({ force = false } = {}) {
    if (refreshInFlight) return;
    if (!container.isConnected || container.dataset.page !== 'forum') return;
    refreshInFlight = true;
    const refreshSeq = ++forumRefreshSeq;
    try {
      const [nextMeta, nextThreads] = await Promise.all([
        loadForumMeta(userId),
        loadThreadsForUser(userId),
      ]);
      await materializeForumActors({
        userId,
        user: forumIdentityUser,
        forbiddenNames: forumVests.map((vest) => vest.displayId),
        threads: nextThreads,
        useStickerAvatars: nextMeta.forumAuto?.passerbyStickerAvatars === true,
        stickerPool,
      });
      const nextSignature = `${forumMetaSignature(nextMeta)}::${forumThreadSignature(nextThreads)}`;
      if (refreshSeq !== forumRefreshSeq) return;
      if (!force && nextSignature === lastForumSignature) return;
      meta = nextMeta;
      for (const sec of meta.sections || []) {
        if (!sec.forumRules) sec.forumRules = normalizeForumRules(null, sec.name || '', sec.desc || '');
      }
      threads = nextThreads;
      lastForumSignature = nextSignature;
      refreshListDom();
    } finally {
      refreshInFlight = false;
    }
  }

  const stopAutoRefresh = () => {
    clearInterval(refreshTimer);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('forum-auto-generated', onForumAutoGenerated);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
  const ensureStillActive = () => {
    if (!container.isConnected || container.dataset.page !== 'forum') {
      stopAutoRefresh();
      return false;
    }
    return true;
  };
  const onWindowFocus = () => {
    if (ensureStillActive()) reloadForumFromStore();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && ensureStillActive()) reloadForumFromStore();
  };
  const onForumAutoGenerated = () => {
    if (ensureStillActive()) reloadForumFromStore({ force: true });
  };
  const refreshTimer = setInterval(() => {
    if (ensureStillActive()) reloadForumFromStore();
  }, 4500);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('forum-auto-generated', onForumAutoGenerated);
  document.addEventListener('visibilitychange', onVisibilityChange);

  function bindSectionTabs() {
    container.querySelectorAll('.forum-list [data-section-open]').forEach((button) => {
      button.addEventListener('click', async () => {
        meta.activeSectionId = button.getAttribute('data-section-open') || meta.activeSectionId;
        await saveForumMeta(userId, meta);
        closeForumDrawer();
        viewMode = 'section';
        syncCurrentRoute('forum', { sectionId: meta.activeSectionId });
        refreshListDom();
        container.querySelector('.forum-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    container.querySelector('[data-forum-home]')?.addEventListener('click', () => {
      viewMode = 'home';
      syncCurrentRoute('forum', {});
      refreshListDom();
      container.querySelector('.forum-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  async function shareForumThread(thread) {
    if (!userId || !thread) return;
    const dest = await openForwardPicker({
      userId,
      title: '转发帖子到聊天',
      includeAnonymous: false,
      emptyText: '暂无可转发的普通会话',
    });
    if (!dest?.chatId) return;
    const destChat = await db.getRecord('chats', dest.chatId).catch(() => null);
    if (!destChat || !isUserPresentInChat(destChat) || isAnonymousChat(destChat)) {
      showToast('论坛分享只能转发到普通聊天');
      return;
    }
    const timestamp = await nextChatMessageTimestamp(userId, dest.chatId);
    await saveMessage(createMessage({
      chatId: dest.chatId,
      senderId: 'user',
      type: 'link',
      content: `forum://${thread.id}`,
      timestamp,
      metadata: {
        title: `论坛：${stripSocialStickerMarkers(thread.title || '', stickerPool) || '帖子'}`,
        desc: String(thread.content || '').slice(0, 80),
        url: `forum://${thread.id}`,
        source: '论坛',
        forumThreadId: thread.id,
        forumAuthorName: thread.authorName || '',
        forumAuthorId: thread.authorId || '',
        forumAuthorRoleId: thread.authorRoleId || '',
        forumAuthorAlias: thread.authorAlias || '',
      },
    }));
    await updateChatPreview(dest.chatId, '[论坛分享]', timestamp);
    showToast('已转发到聊天');
  }

  function bindThreadClicks() {
    bindSwipeActions(container.querySelector('.forum-list'));
    container.querySelectorAll('.forum-thread-open').forEach((el) => {
      el.addEventListener('click', () => {
        navigate('forum-detail', {
          threadId: el.dataset.threadId,
          returnSectionId: viewMode === 'section' ? meta.activeSectionId : '',
        });
      });
    });
    container.querySelectorAll('[data-thread-delete]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const threadId = btn.getAttribute('data-thread-delete');
        if (!threadId || !window.confirm('删除这篇帖子？')) return;
        await db.deleteRecord('forumThreads', threadId);
        threads = threads.filter((t) => t.id !== threadId);
        refreshListDom();
        showToast('帖子已删除');
      });
    });
    container.querySelectorAll('[data-thread-share]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const thread = threads.find((item) => item.id === btn.getAttribute('data-thread-share'));
        void shareForumThread(thread);
      });
    });
  }

  function closeForumDrawer() {
    const backdrop = container.querySelector('.forum-nav-backdrop');
    if (!backdrop) return;
    backdrop.classList.remove('is-open');
    window.setTimeout(() => {
      if (!backdrop.classList.contains('is-open')) backdrop.hidden = true;
    }, 220);
  }

  function openForumDrawer() {
    const backdrop = container.querySelector('.forum-nav-backdrop');
    if (!backdrop) return;
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add('is-open'));
  }

  function refreshDrawerDom({ focusSectionId = '', focusDirection = '' } = {}) {
    const host = container.querySelector('.forum-drawer-host');
    if (!host) return;
    const wasOpen = host.querySelector('.forum-nav-backdrop')?.classList.contains('is-open') === true;
    const scrollTop = host.querySelector('.forum-nav-sections')?.scrollTop || 0;
    host.innerHTML = buildForumDrawerHtml(meta, threads, forumProfile);
    bindDrawerActions(host);
    if (wasOpen) {
      const backdrop = host.querySelector('.forum-nav-backdrop');
      if (backdrop) {
        backdrop.hidden = false;
        backdrop.classList.add('is-open');
      }
      const sections = host.querySelector('.forum-nav-sections');
      if (sections) sections.scrollTop = scrollTop;
      const focusTarget = [...host.querySelectorAll('[data-section-move]')].find((button) => (
        button.getAttribute('data-section-id') === focusSectionId
        && button.getAttribute('data-section-move') === focusDirection
      ));
      if (focusTarget && !focusTarget.disabled) {
        try { focusTarget.focus({ preventScroll: true }); } catch (_) { focusTarget.focus(); }
      }
    }
  }

  async function deleteSectionWithChoice(sectionId) {
    const section = (meta.sections || []).find((item) => item.id === sectionId);
    if (!section || (meta.sections || []).length <= 1) {
      showToast('至少保留一个版块');
      return;
    }
    const affected = threads.filter((thread) => (thread.sectionId || '') === sectionId);
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>删除「${escapeHtml(section.name)}」</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body forum-delete-section-options">
        <button type="button" class="forum-delete-choice" data-section-delete-move>
          <strong>转移帖子后删除</strong><span>${affected.length} 篇帖子将移到「综合」</span>
        </button>
        <button type="button" class="forum-delete-choice is-danger" data-section-delete-all>
          <strong>全部删除</strong><span>帖子与回复都会永久删除</span>
        </button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    const finish = async ({ removeThreads }) => {
      if (removeThreads && !window.confirm(`确认永久删除「${section.name}」及其中 ${affected.length} 篇帖子？`)) return;
      let targetId = '';
      if (!removeThreads) {
        let general = (meta.sections || []).find((item) => item.id === 'general');
        if (!general) {
          general = normalizeForumSection({ id: 'general', name: '综合', type: '闲聊', desc: '社区里的综合讨论。' });
          general.forumRules = normalizeForumRules(null, general.name, general.desc);
          meta.sections = [general, ...(meta.sections || [])];
        }
        targetId = general.id;
      }
      const deletionPlan = planForumSectionDeletion(threads, sectionId, {
        mode: removeThreads ? 'delete' : 'move',
        targetSectionId: targetId,
      });
      for (const threadId of deletionPlan.affectedIds) {
        if (removeThreads) {
          await db.deleteRecord('forumThreads', threadId);
        } else {
          const moved = deletionPlan.threads.find((thread) => thread.id === threadId);
          if (moved) await db.put('forumThreads', moved);
        }
      }
      threads = deletionPlan.threads;
      meta.sections = (meta.sections || []).filter((item) => item.id !== sectionId);
      meta.deletedSectionIds = [...new Set([...(meta.deletedSectionIds || []), sectionId])];
      meta.pinnedSectionIds = (meta.pinnedSectionIds || []).filter((id) => id !== sectionId);
      meta.sectionOrder = (meta.sectionOrder || []).filter((id) => id !== sectionId);
      meta.activeSectionId = targetId || meta.sections[0]?.id || '';
      await saveForumMeta(userId, meta);
      close();
      showToast(removeThreads ? '版块及帖子已删除' : '帖子已转移，版块已删除');
      threads = await loadThreadsForUser(userId);
      viewMode = 'home';
      refreshDrawerDom();
      refreshListDom();
    };
    root.querySelector('[data-section-delete-move]')?.addEventListener('click', () => void finish({ removeThreads: false }));
    root.querySelector('[data-section-delete-all]')?.addEventListener('click', () => void finish({ removeThreads: true }));
  }

  async function openForumSettings() {
    const next = await openForumSettingsModal({
      prefs: meta.forumAuto || {},
      sections: meta.sections || [],
    });
    if (!next) return;
    meta.forumAuto = next;
    await saveForumMeta(userId, meta);
    refreshListDom();
    showToast(next.enabled ? '论坛自动更新已开启' : '论坛设置已保存');
  }

  function bindDrawerActions(scope) {
    scope.querySelectorAll('[data-forum-menu-close]').forEach((el) => {
      el.addEventListener('click', (event) => {
        if (event.currentTarget === event.target || event.currentTarget.matches('button')) closeForumDrawer();
      });
    });
    scope.querySelector('.forum-nav-sheet')?.addEventListener('click', (event) => event.stopPropagation());
    scope.querySelector('[data-forum-vest-home]')?.addEventListener('click', () => navigate('forum-vest-home', {}));
    bindSwipeActions(scope.querySelector('.forum-nav-sections'));
    scope.querySelectorAll('[data-section-open]').forEach((button) => {
      button.addEventListener('click', async () => {
        meta.activeSectionId = button.getAttribute('data-section-open') || meta.activeSectionId;
        await saveForumMeta(userId, meta);
        closeForumDrawer();
        viewMode = 'section';
        syncCurrentRoute('forum', { sectionId: meta.activeSectionId });
        refreshListDom();
      });
    });
    scope.querySelectorAll('[data-section-pin]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-section-pin') || '';
        const pinned = new Set(meta.pinnedSectionIds || []);
        if (pinned.has(id)) pinned.delete(id);
        else pinned.add(id);
        meta.pinnedSectionIds = [...pinned];
        await saveForumMeta(userId, meta);
        showToast(pinned.has(id) ? '版块已置顶' : '已取消置顶');
        refreshDrawerDom();
        refreshListDom();
      });
    });
    scope.querySelectorAll('[data-section-move]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sectionId = btn.getAttribute('data-section-id') || '';
        const direction = btn.getAttribute('data-section-move') || 'up';
        meta.sectionOrder = moveForumSectionOrder(
          meta.sections || [],
          meta.sectionOrder || [],
          sectionId,
          direction,
        );
        await saveForumMeta(userId, meta);
        refreshDrawerDom({ focusSectionId: sectionId, focusDirection: direction });
        refreshListDom();
      });
    });
    scope.querySelectorAll('[data-section-delete]').forEach((btn) => {
      btn.addEventListener('click', () => void deleteSectionWithChoice(btn.getAttribute('data-section-delete') || ''));
    });
    scope.querySelector('[data-forum-new-sec]')?.addEventListener('click', openNewSectionModal);
    scope.querySelector('[data-forum-ai-board]')?.addEventListener('click', openAiBoardModal);
    scope.querySelector('[data-forum-sec-edit]')?.addEventListener('click', openSectionEditor);
    scope.querySelector('[data-forum-settings]')?.addEventListener('click', () => void openForumSettings());
    scope.querySelector('[data-forum-clear-all]')?.addEventListener('click', () => void clearAllForumThreads());
  }

  function bindNavigation() {
    container.querySelectorAll('[data-forum-menu-open]').forEach((btn) => btn.addEventListener('click', openForumDrawer));
    const drawerHost = container.querySelector('.forum-drawer-host');
    if (drawerHost) bindDrawerActions(drawerHost);
  }

  bindSectionTabs();
  bindThreadClicks();
  bindInlineActions();
  bindNavigation();

  async function clearAllForumThreads() {
    if (!threads.length) {
      showToast('暂无帖子可清空');
      return;
    }
    if (!window.confirm(`确定清空全部 ${threads.length} 篇帖子吗？跨所有板块，不可恢复；板块结构不受影响。`)) return;
    for (const t of threads) {
      await db.deleteRecord('forumThreads', t.id);
    }
    threads = [];
    lastForumSignature = `${forumMetaSignature(meta)}::${forumThreadSignature(threads)}`;
    refreshListDom();
    showToast('已清空全部帖子');
  }

  async function openComposeModal() {
    if (!userId) {
      showToast('请先选择用户档案后再发帖');
      return;
    }
    const vests = await listForumVests(userId);
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>发帖</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">发布到板块</label>
          ${sectionSelectMarkup('forum-new-section', meta.sections || [], meta.activeSectionId || DEFAULT_FORUM_SECTIONS[0].id)}
        </div>
        <div class="form-group">
          <label class="form-label">发帖身份</label>
          <select class="form-input forum-new-vest">${buildVestSelectOptionsHtml(vests, forumIdentityUser, meta.lastVestId || '')}</select>
        </div>
        <div class="form-group">
          <label class="form-label">标题</label>
          <input type="text" class="form-input forum-new-title" placeholder="标题" />
        </div>
        <div class="form-group">
          <label class="form-label">正文</label>
          <textarea class="form-input forum-new-content" rows="8" placeholder="正文内容…"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">图片（最多 9 张）</label>
          <input type="file" class="forum-new-images-input" accept="image/*" multiple hidden />
          <div class="forum-compose-images"></div>
        </div>
        <div class="form-group">
          <label class="form-label">文字图（可选）</label>
          <textarea class="form-input forum-new-text-image" rows="4" maxlength="1200" placeholder="写下图片里要展示的文字…"></textarea>
        </div>
        <button type="button" class="btn btn-primary forum-new-submit" style="width:100%;margin-top:8px;">发布</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    mountStickerPickerAfterTextarea(root, '.forum-new-content');
    const pickedImages = [];
    const imageGrid = root.querySelector('.forum-compose-images');
    const imageInput = root.querySelector('.forum-new-images-input');
    const renderPickedImages = () => {
      if (!imageGrid) return;
      imageGrid.innerHTML = pickedImages.map((url, index) => `
        <div class="forum-compose-image-cell">
          <img src="${escapeAttr(url)}" alt="" />
          <button type="button" class="forum-compose-image-remove" data-forum-remove-image="${index}" aria-label="移除图片">${icon('close')}</button>
        </div>
      `).join('') + (pickedImages.length < 9 ? `
        <button type="button" class="forum-compose-image-cell forum-compose-image-add" data-forum-add-image aria-label="添加图片">${icon('plus')}</button>
      ` : '');
      imageGrid.querySelector('[data-forum-add-image]')?.addEventListener('click', () => imageInput?.click());
      imageGrid.querySelectorAll('[data-forum-remove-image]').forEach((button) => {
        button.addEventListener('click', () => {
          pickedImages.splice(Number(button.getAttribute('data-forum-remove-image')), 1);
          renderPickedImages();
        });
      });
    };
    renderPickedImages();
    imageInput?.addEventListener('change', async (event) => {
      const files = [...(event.target.files || [])].slice(0, Math.max(0, 9 - pickedImages.length));
      for (const file of files) {
        try {
          let url = await readForumImageAsDataUrl(file);
          try {
            const optimized = await fileToOptimizedChatImageDataUrl(file);
            if (optimized?.dataUrl) url = optimized.dataUrl;
          } catch {
            // 优化失败时保留原图，不阻断发帖。
          }
          if (url) pickedImages.push(url);
        } catch {
          showToast('有图片读取失败，已跳过');
        }
      }
      imageInput.value = '';
      renderPickedImages();
    });
    root.querySelector('.forum-new-submit')?.addEventListener('click', async () => {
      const title = (root.querySelector('.forum-new-title')?.value || '').trim();
      const raw = (root.querySelector('.forum-new-content')?.value || '').trim();
      const textImage = (root.querySelector('.forum-new-text-image')?.value || '').trim();
      const { text, imageUrls } = extractStickerTagsToImageUrls(raw, stickerPool);
      if (!title || (!text && !textImage && !imageUrls.length && !pickedImages.length)) return;
      const sectionId = (root.querySelector('.forum-new-section')?.value || meta.activeSectionId || DEFAULT_FORUM_SECTIONS[0].id).trim();
      const vestId = (root.querySelector('.forum-new-vest')?.value || '').trim();
      const vest = vestId ? await getForumVestById(userId, vestId) : null;
      const identity = resolveVestIdentity(vest, forumIdentityUser);
      const thread = {
        id: `forum_${Date.now()}`,
        title,
        content: text,
        images: mergeSocialPostImageUrls(pickedImages, imageUrls).slice(0, 9),
        textImage: pickedImages.length || imageUrls.length ? '' : textImage,
        textImageCaption: pickedImages.length || imageUrls.length ? '' : textImage,
        imageKind: pickedImages.length || imageUrls.length ? 'photo' : (textImage ? 'textimg' : ''),
        authorName: identity.authorName,
        authorVestId: identity.authorVestId,
        authorVestBadge: identity.authorVestBadge,
        authorSource: 'user',
        userId,
        sectionId,
        timestamp: virtualNow,
        replies: [],
      };
      await db.put('forumThreads', thread);
      meta.activeSectionId = sectionId;
      meta.lastVestId = identity.authorVestId;
      await saveForumMeta(userId, meta);
      close();
      threads = await loadThreadsForUser(userId);
      refreshListDom();
      if (meta.forumAuto?.enrichReplies !== false) {
        showToast('已发布，正在回复评论…');
        navigate('forum-detail', {
          threadId: thread.id,
          returnSectionId: sectionId,
          autoReplies: '1',
        });
      } else {
        showToast('已发布');
      }
    });
  }

  function openNewSectionModal() {
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>新建板块</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <label class="form-label">板块类型</label>
        ${forumTypeSelectMarkup('fs-type', '生活')}
        <input class="form-input fs-name" placeholder="板块名" />
        <textarea class="form-input fs-desc" rows="5" placeholder="描述要求：这个板块聊什么、有什么禁忌、希望生成时注意什么" style="margin-top:8px;"></textarea>
        ${worldBookSelectMarkup('fs-wb', { multiple: true })}
        ${auSelectMarkup('fs-au')}
        <label class="form-label" style="margin-top:10px;">联网素材关键词（可选）</label>
        <input class="form-input fs-material" placeholder="如：最近游戏热梗、厨房翻车、校园墙投稿" />
        <button type="button" class="btn btn-primary fs-save" style="margin-top:8px;width:100%;">保存</button>
      </div>
    `);
    void fillWorldBookSelect(root, 'fs-wb', wbOptions, []);
    fillAuSelect(root, 'fs-au', user, []);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.fs-save')?.addEventListener('click', async () => {
      const name = (root.querySelector('.fs-name')?.value || '').trim();
      if (!name) return;
      const sec = {
        id: `sec_${Date.now()}`,
        name,
        type: (root.querySelector('.fs-type')?.value || '生活').trim(),
        desc: (root.querySelector('.fs-desc')?.value || '').trim(),
        worldBookIds: selectedValues(root, 'select.fs-wb'),
        auEntryIds: selectedValues(root, 'select.fs-au'),
        materialQuery: (root.querySelector('.fs-material')?.value || '').trim(),
      };
      sec.forumRules = normalizeForumRules(null, sec.name, sec.desc);
      meta.sections = [...(meta.sections || []), sec];
      meta.activeSectionId = sec.id;
      await saveForumMeta(userId, meta);
      close();
      refreshDrawerDom();
      refreshListDom();
      showToast('板块已创建');
    });
  }

  function openAiBoardModal() {
    if (!userId) {
      showToast('请先选择用户档案');
      return;
    }
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>AI 创建版块</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <label class="form-label">板块类型</label>
        ${forumTypeSelectMarkup('fab-type', '八卦')}
        ${worldBookSelectMarkup('fab-wb', { multiple: true })}
        ${auSelectMarkup('fab-au')}
        <label class="form-label" style="margin-top:10px;">主题</label>
        <input class="form-input fab-theme" placeholder="如：某次活动后的舆论、绑定世界书内的事件讨论" />
        <label class="form-label" style="margin-top:10px;">联网素材关键词（可选）</label>
        <input class="form-input fab-material" placeholder="配置搜索 API 后会自动取素材参考" />
        <label class="form-label" style="margin-top:10px;">描述要求</label>
        <textarea class="form-input fab-ref" rows="5" placeholder="这个板块聊什么、谁会出没、禁忌、希望生成的氛围"></textarea>
        <label class="form-label" style="margin-top:10px;">出场构成</label>
        ${forumCastModeMarkup('fab-cast-mode', meta.boardCastMode || 'mixed')}
        <label class="chat-details-row chat-details-toggle" style="margin-top:12px;">
          <span>正文可带表情包</span>
          <input type="checkbox" class="fab-stickers" ${meta.forumAuto?.allowStickers !== false ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>帖子可含文字图</span>
          <input type="checkbox" class="fab-text-images" ${meta.forumAuto?.allowTextImages === true ? 'checked' : ''} />
        </label>
        <button type="button" class="btn btn-primary fab-go" style="margin-top:8px;width:100%;">生成</button>
        <div class="forum-gen-status" data-forum-gen-status role="status" hidden></div>
      </div>
    `);
    void fillWorldBookSelect(root, 'fab-wb', wbOptions, []);
    fillAuSelect(root, 'fab-au', user, []);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.fab-go')?.addEventListener('click', async () => {
      const theme = (root.querySelector('.fab-theme')?.value || '').trim();
      if (!theme) return;
      const ref = (root.querySelector('.fab-ref')?.value || '').trim();
      const sectionType = (root.querySelector('.fab-type')?.value || '八卦').trim();
      const secKey = buildRandomGenerationKey('forum_section');
      const postKey = buildRandomGenerationKey('forum_post');
      const worldBookIds = selectedValues(root, 'select.fab-wb');
      const auEntryIds = selectedValues(root, 'select.fab-au');
      const materialQuery = (root.querySelector('.fab-material')?.value || '').trim();
      const castMode = (root.querySelector('.fab-cast-mode')?.value || 'mixed').trim();
      const allowStickers = !!root.querySelector('.fab-stickers')?.checked;
      const allowTextImages = !!root.querySelector('.fab-text-images')?.checked;
      meta.forumAuto = { ...(meta.forumAuto || {}), allowTextImages };
      meta.boardCastMode = castMode;
      await saveForumMeta(userId, meta).catch(() => {});
      const cast = await resolveForumCast({
        mode: castMode,
        scopeKey: 'forum-section',
        characters: characterList,
      });
      if (!cast) return;
      const scopedCharacters = cast.characters;
      if ((cast.mode === 'roles' || cast.mode === 'scoped-mixed') && !scopedCharacters.length) {
        showToast('所选范围里没有角色');
        return;
      }
      const scopedCharacterMap = characterMapFromList(scopedCharacters);
      const btn = root.querySelector('.fab-go');
      const status = root.querySelector('[data-forum-gen-status]');
      const setStatus = (text, opts = {}) => {
        setGenStatus(status, text, opts);
        if (text) updateManualGeneration(generationStateKey, text);
      };
      const genCap = await resolveGenerationMaxTokens();
      let lastForumRaw = '';
      if (isManualGenerationRunning(generationStateKey)) {
        showToast('论坛已有生成任务正在进行');
        return;
      }
      beginManualGeneration(generationStateKey, {
        kind: 'board',
        message: '正在创建论坛版块…',
      });
      setButtonLoading(btn, true);
      close();
      try {
        setStatus('正在整理素材…');
        showToast('论坛版块生成中，请稍候…');
        const webMaterials = await collectForumWebMaterials(materialQuery || theme, `论坛-${sectionType}`);
        setStatus('正在准备上下文…');
        const systemPrompt = await buildForumAiSystemPrompt(user, {
          worldBookIds,
          auEntryIds,
          referenceNotes: ref,
          webMaterials,
          section: { name: theme, type: sectionType, desc: ref },
          characters: scopedCharacters,
          allowStickers,
          passerbyIsolation: cast.mode !== 'roles',
        });
        const rpHints = scopedCharacters.length
          ? await collectForumRoleplayHints(userId, {
            focusCharacterIds: scopedCharacters.map((row) => row.id),
            strictFocus: true,
          })
          : { relation: [], snippets: [], relayGroupNames: [] };
        const relayHint = (rpHints.relayGroupNames || []).length
          ? `用户存档中的群聊名称（chatShares 若 targetType 为 group，groupName 须与下列之一一致或明显匹配）:${rpHints.relayGroupNames.join('、')}`
          : '用户当前无存档群聊：chatShares 请只用 private_user（角色与用户的私聊转发），不要写 group。';
        const socialHint = buildSocialLinkPromptHint(await loadSocialLinkConfig());
        const authorPrompt = buildForumAuthorPrompt(scopedCharacters, { name: theme, type: sectionType });
        const watchingStylePrompt = buildWatchingYouStylePrompt({ name: theme, type: sectionType });
        const allowImages = meta.forumAuto?.allowImages === true;
        const imageRules = await buildForumGeneratedImageRules(allowImages, allowTextImages, allowStickers);
        const topicPlan = buildForumTopicPlan({
          count: watchingStylePrompt ? 3 : 8,
          recentThreads: [],
          allowPrivateContext: cast.mode !== 'passersby' && scopedCharacters.length > 0,
          weiboAvailable: await hasFreshForumWeiboMaterial(userId),
          seed: `${userId}|${secKey}|${theme}`,
        });
        const userTask = [
          `当前任务：根据主题「${theme}」设计一个论坛新版块，并生成若干首开帖（含少量回复楼层）。`,
          `板块类型：${sectionType}`,
          `版块生成键：${secKey}`,
          `帖子生成键：${postKey}`,
          worldBookIds.length || auEntryIds.length || materialQuery
            ? '用户已绑定世界书/AU/联网素材；生成版块和帖子时必须参考这些设定，但不得牺牲角色人设与口吻。'
            : '',
          '只允许使用当前虚拟时间线与已建立的角色关系，禁止未来剧情穿越。',
          '【本轮角色范围】通讯录角色只能使用下方作者候选名单；范围外角色不得作为作者、回复者或被点名提及。普通匿名路人不受此限制。',
          relayHint,
          socialHint,
          watchingStylePrompt || '帖子风格要有差异：理性分析、情绪吐槽、带链接转发、错窗/错群后的补救口吻可混合出现，但不要统一模板语气。',
          ref ? `用户提供的描述要求（优先融合）：\n${ref}` : '',
          rpHints.relation.length ? `角色关系速记：\n${rpHints.relation.join('\n')}` : '角色关系速记：暂无',
          rpHints.snippets.length ? `历史聊天口吻片段（当前存档）：\n${rpHints.snippets.join('\n')}` : '历史聊天口吻片段：暂无',
          buildForumTopicPlanPrompt(topicPlan),
          buildForumCastPrompt(cast.mode, scopedCharacters, { name: theme, type: sectionType }),
          meta.forumAuto?.multiNpcInteraction !== false
            ? '允许多个角色与 NPC 在回复区自然接话，但不要机械凑齐所有人。'
            : '本轮每篇帖子最多安排一个主要回复者，不要写多人围攻式互动。',
          authorPrompt,
          buildForumTranslationPrompt(scopedCharacters),
          `每条首批帖子都生成恰好 ${meta.forumAuto?.newThreadReplyCount ?? 3} 条 replies。`,
          imageRules,
          'title 只能写纯文字帖子标题，禁止包含 [表情包:名称]、[贴纸:名称] 或单独的表情包名称。zh 只翻译 content 正文，不得抄写、翻译或解释表情包标记与名称。',
          'chatShares：默认必须输出空数组 []。仅当剧情明确需要「把某帖转进聊天」时再填 1～2 条；postIndex 为 threads 下标；字段同微博（可 wrongSend、wrongGroupName、recallLink）。',
          '回复和回复内容不要分段，必须同一条回复文本内完整表达。',
          '如果楼层是回复某一层，使用 replyToFloor 数字字段，禁止把「[回复 XXX: ...]」写进 content。',
          allowStickers
            ? '正文与楼层可带 [表情包:名称]（与本地表情包列表一致）；请整段文字写完后再把表情包放在末尾，不要插进词语中间。'
            : '本次不要在正文或楼层里写 [表情包:名称]。',
          'threads 主帖及 replies 楼层的 authorId/authorName/author/authorRoleId/forumActorId 均不得为 user、不得冒充当前用户档案 id/显示名或用户论坛马甲名；禁止 AI 代用户发帖或回复。',
          '路人新旧比例遵守上文路人池规则。复用旧路人必须填写池中 forumActorId；新路人必须留空 forumActorId，并填写 authorPersonality、authorSpeechStyle、authorBackground、authorInterests。',
          'threads 每项都输出 wantsImage、imagePrompt、imageCharacterId、textImageCaption；不配图时 wantsImage=false，其余三项留空。',
          '硬性要求：只输出一个合法 JSON 对象，不要用 markdown 代码块包裹。',
          'JSON 结构：',
          '{"section":{"name":"版块名","type":"板块类型","desc":"版块描述要求"},"threads":[{"title":"帖子标题","content":"帖子正文","zh":"外语正文才需要","authorName":"伪装ID或小号名","authorId":"","authorRoleId":"","forumActorId":"复用常驻路人时填写","authorPersonality":"新路人才填","authorSpeechStyle":"新路人才填","authorBackground":"新路人才填","authorInterests":["新路人才填"],"authorAlias":"","replies":[{"author":"回复者伪装ID","authorRoleId":"可空角色id","forumActorId":"复用常驻路人时填写","authorPersonality":"新路人才填","authorSpeechStyle":"新路人才填","authorBackground":"新路人才填","authorInterests":["新路人才填"],"content":"回复内容","zh":"外语回复才需要"},{"author":"回复者伪装ID","authorRoleId":"可空角色id","forumActorId":"复用常驻路人时填写","replyToFloor":1,"content":"回复内容","zh":"外语回复才需要"}]}],"chatShares":[]}',
          watchingStylePrompt ? 'threads 数量建议 1～3 条。' : 'threads 数量建议 3～8 条；允许匿名、小号、忘切号、观点对立等真实论坛气质。',
        ].filter(Boolean).join('\n');
        setStatus(`正在生成版块和首批帖子…（max≈${genCap}）`);
        const generated = await chatJsonGeneration({
          scope: 'forum-board',
          retryOnInvalid: false,
          messages: [
            { role: 'system', content: `${systemPrompt}\n\n---\n\n你是论坛内容生成助手。严格遵守上文世界观与绑定世界书（若有）。` },
            { role: 'user', content: userTask },
          ],
          temperature: 0.9,
          maxTokens: genCap,
          parse: parseForumJson,
          validate: (value) => value && typeof value === 'object' && coerceForumThreadRows(value).length > 0,
        });
        const raw = generated.raw;
        const parsed = generated.data;
        lastForumRaw = String(raw || '');
        const secDesc = parsed.section?.desc || ref || '';
        const normalizedRules = normalizeForumRules(parsed.rules, theme, secDesc);
        const sec = {
          id: `sec_${Date.now()}`,
          name: parsed.section?.name || theme,
          type: parsed.section?.type || sectionType,
          desc: secDesc,
          generationKey: secKey,
          postGenerationKey: postKey,
          generationPrompt: `主题:${theme}\n类型:${sectionType}\n补充说明:${ref || '无'}\n素材:${materialQuery || '无'}\n生成时间:${formatTime(virtualNow)}`,
          forumRules: normalizedRules,
          worldBookIds,
          auEntryIds,
          materialQuery,
        };
        setStatus('正在写入论坛…');
        meta = await loadForumMeta(userId);
        meta.sections = [...(meta.sections || []), sec];
        meta.activeSectionId = sec.id;
        const insertedThreads = [];
        let generatedRows = coerceForumThreadRows(parsed);
        if (!generatedRows.length) {
          throw new Error(`生成结果没有可用帖子字段（收到字段：${objectKeys(parsed).join('、') || '无'}）`);
        }
        if (allowImages) setStatus('正在生成帖子配图…');
        generatedRows = await applyForumGeneratedImages(generatedRows, allowImages, allowTextImages, allowStickers);
        for (const [idx, t] of generatedRows.entries()) {
          const authorInput = cast.mode === 'roles'
            ? enforceForumRoleScopedAuthor(t, scopedCharacters, idx)
            : t;
          const normalizedAuthor = sanitizeGeneratedForumAuthor(authorInput, scopedCharacterMap, generatedAuthorOptions);
          const author = cast.mode === 'passersby'
            ? { ...normalizedAuthor, authorId: '', authorRoleId: '' }
            : normalizedAuthor;
          const content = pickForumThreadContent(t);
          const contentTranslation = sanitizeForumTranslation(content, pickForumTranslation(t), stickerPool);
          const thread = {
            id: `forum_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
            title: pickForumThreadTitle(t, '无标题', stickerPool),
            content,
            authorName: author.authorName,
            authorId: author.authorId,
            authorRoleId: author.authorRoleId,
            authorAlias: author.authorAlias,
            forumActorId: String(t?.forumActorId || '').trim(),
            authorPersonality: String(t?.authorPersonality || t?.authorProfile?.personality || '').trim(),
            authorSpeechStyle: String(t?.authorSpeechStyle || t?.authorProfile?.speechStyle || '').trim(),
            authorBackground: String(t?.authorBackground || t?.authorProfile?.background || '').trim(),
            authorInterests: (Array.isArray(t?.authorInterests) ? t.authorInterests : t?.authorProfile?.interests || [])
              .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 8),
            authorSource: 'generated',
            topicSource: topicPlan[idx] || 'section',
            ...pickForumGeneratedImageFields(t),
            userId,
            sectionId: sec.id,
            timestamp: virtualNow - Math.floor(Math.random() * 7200000),
            replies: normalizeForumReplies(pickForumThreadReplies(t), virtualNow, forbiddenGeneratedNames, stickerPool, {
              user: forumIdentityUser,
              characters: scopedCharacterMap,
            }).slice(0, meta.forumAuto?.newThreadReplyCount ?? 3),
            ...(contentTranslation ? { contentTranslation } : {}),
          };
          await db.put('forumThreads', thread);
          insertedThreads.push(thread);
        }
        await applyGeneratedChatShares({
          userId: userId || '',
          chatShares: parsed.chatShares,
          relayItems: insertedThreads,
          virtualNow,
          relaySpec: {
            urlScheme: 'forum',
            sourceLabel: '论坛',
            lastMessagePreview: '[论坛分享]',
            linkTitle: (th, fname) => `论坛：${stripSocialStickerMarkers(th.title || '', stickerPool) || fname}`,
            linkDesc: (th) => th.content || '',
            extraLinkMetadata: (th) => ({
              fromForumRelay: true,
              forumThreadId: th.id || '',
              forumAuthorName: th.authorName || '',
              forumAuthorId: th.authorId || '',
              forumAuthorRoleId: th.authorRoleId || '',
              forumAuthorAlias: th.authorAlias || '',
            }),
          },
        });
        await saveForumMeta(userId, meta);
        forumRefreshSeq += 1;
        promotedThreadIds.clear();
        insertedThreads.forEach((thread) => promotedThreadIds.add(thread.id));
        threads = await loadThreadsForUser(userId);
        lastForumSignature = `${forumMetaSignature(meta)}::${forumThreadSignature(threads)}`;
        refreshDrawerDom();
        refreshListDom();
        finishManualGeneration(generationStateKey, {
          message: `版块「${sec.name}」与首批帖子已生成`,
        });
        showToast('论坛版块已生成');
        void saveForumGenerationDebug(userId, 'board_parsed', {
          raw,
          parsedKeys: objectKeys(parsed),
        });
        void applyForumGenerationActorPlanBestEffort({
          userId,
          user: forumIdentityUser,
          forbiddenNames: forbiddenGeneratedNames,
          roots: insertedThreads,
          knownCharacterIds: scopedCharacters.map((character) => character.id),
        }).then((actorPlan) => {
          if (!actorPlan.ok) {
            console.warn('[forum] 版块身份整理未完成，正文已正常保存', actorPlan.error || 'timeout');
            return;
          }
          for (const inserted of insertedThreads) void db.put('forumThreads', inserted).catch(() => {});
        }).catch((error) => console.warn('[forum] 版块身份整理异常，正文已正常保存', error));
      } catch (e) {
        if (container.isConnected && container.dataset.page === 'forum') {
          showGenerationErrorReport(generationErrorFromCatch(e, {
            scope: '论坛 / 版块生成',
            title: '论坛版块生成失败',
            rawText: lastForumRaw,
          }));
        }
        finishManualGeneration(generationStateKey, {
          ok: false,
          message: `版块生成失败：${e?.message || '未知错误'}`,
        });
        showToast(`生成失败：${e?.message || '未知错误'}`);
        setStatus(`生成失败：${e?.message || '未知错误'}`);
      } finally {
        setButtonLoading(btn, false);
      }
    });
  }

  function openSectionEditor() {
    const activeId = meta.activeSectionId || 'general';
    const idx = (meta.sections || []).findIndex((s) => s.id === activeId);
    if (idx < 0) return;
    const sec = meta.sections[idx];
    const sectionId = sec.id;
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>编辑当前板块</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <label class="form-label">板块名</label>
        <input class="form-input fs-edit-name" value="${escapeAttr(sec.name || '')}" />
        <label class="form-label" style="margin-top:8px;">板块类型</label>
        ${forumTypeSelectMarkup('fs-edit-type', sec.type || '闲聊')}
        <label class="form-label" style="margin-top:8px;">描述要求</label>
        <textarea class="form-input fs-edit-desc" rows="6" placeholder="这个板块聊什么、有什么禁忌、希望生成时注意什么">${escapeHtml(sec.desc || '')}</textarea>
        ${worldBookSelectMarkup('fs-edit-wb', { multiple: true })}
        ${auSelectMarkup('fs-edit-au')}
        <label class="form-label" style="margin-top:10px;">联网素材关键词（可选）</label>
        <input class="form-input fs-edit-material" value="${escapeAttr(sec.materialQuery || '')}" placeholder="配置搜索 API 后生成时参考" />
        <p class="text-hint" style="font-size:11px;margin-top:8px;">生成帖子和回复会参考板块描述、绑定世界书、AU 与联网素材；同时会优先保持角色人设和口吻。</p>
        <button type="button" class="btn btn-primary fs-rule-save" style="margin-top:10px;width:100%;">保存</button>
      </div>
    `);
    void fillWorldBookSelect(root, 'fs-edit-wb', wbOptions, sec.worldBookIds || sec.worldBookId || []);
    fillAuSelect(root, 'fs-edit-au', user, sec.auEntryIds || []);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.fs-rule-save')?.addEventListener('click', async () => {
      // 轮询可能在弹窗打开期间用新对象替换 meta；按 id 合并到当前 meta，
      // 不再修改已经脱离 sections 的旧 sec 引用。
      const current = (meta.sections || []).find((item) => item.id === sectionId) || sec;
      const name = (root.querySelector('.fs-edit-name')?.value || '').trim() || current.name || '未命名板块';
      const type = (root.querySelector('.fs-edit-type')?.value || '').trim() || '闲聊';
      const desc = (root.querySelector('.fs-edit-desc')?.value || '').trim();
      meta = mergeForumSectionEdit(meta, sectionId, {
        name,
        type,
        desc,
        worldBookIds: selectedValues(root, 'select.fs-edit-wb'),
        auEntryIds: selectedValues(root, 'select.fs-edit-au'),
        materialQuery: (root.querySelector('.fs-edit-material')?.value || '').trim(),
        forumRules: normalizeForumRules(null, name, desc),
      });
      await saveForumMeta(userId, meta);
      lastForumSignature = `${forumMetaSignature(meta)}::${forumThreadSignature(threads)}`;
      close();
      refreshDrawerDom();
      refreshListDom();
      showToast('板块已保存');
    });
  }

  function openAiPostModal(defaultSectionId = '') {
    if (!userId) {
      showToast('请先选择用户档案');
      return;
    }
    const initialId = defaultSectionId || meta.activeSectionId || DEFAULT_FORUM_SECTIONS[0].id;
    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>AI 生成帖子</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body">
        <label class="form-label">选择板块</label>
        ${sectionSelectMarkup('fap-section', meta.sections || [], initialId)}
        <label class="form-label">生成要求（可空）</label>
        <textarea class="form-input fap-demand" rows="4" placeholder="如：延续上次争论，新增 2 条互怼回复；也可以写补贴/补评论方向"></textarea>
        <label class="form-label">本次生成</label>
        <select class="form-input fap-count">
          ${[1, 2, 3, 4, 5].map((count) => `<option value="${count}" ${count === normalizeForumPostCount(meta.postGenerationCount) ? 'selected' : ''}>${count} 篇新帖</option>`).join('')}
        </select>
        <label class="form-label">出场构成</label>
        ${forumCastModeMarkup('fap-cast-mode', meta.postCastMode || 'mixed')}
        <label class="chat-details-row chat-details-toggle" style="margin-top:12px;">
          <span>正文可带表情包</span>
          <input type="checkbox" class="fap-stickers" ${meta.forumAuto?.allowStickers !== false ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>帖子可含文字图</span>
          <input type="checkbox" class="fap-text-images" ${meta.forumAuto?.allowTextImages === true ? 'checked' : ''} />
        </label>
        <button type="button" class="btn btn-primary fap-go" style="margin-top:10px;width:100%;">生成帖子</button>
        <div class="forum-gen-status" data-forum-post-status role="status" hidden></div>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    root.querySelector('.fap-go')?.addEventListener('click', async () => {
      const sectionId = (root.querySelector('.fap-section')?.value || initialId).trim();
      const sec = (meta.sections || []).find((s) => s.id === sectionId);
      if (!sec) return;
      const demand = (root.querySelector('.fap-demand')?.value || '').trim();
      const postCount = normalizeForumPostCount(root.querySelector('.fap-count')?.value);
      const onceKey = `${sec.postGenerationKey || buildRandomGenerationKey('forum_post')}_${Math.random().toString(36).slice(2, 5)}`;
      const castMode = (root.querySelector('.fap-cast-mode')?.value || 'mixed').trim();
      const allowStickers = !!root.querySelector('.fap-stickers')?.checked;
      const allowTextImages = !!root.querySelector('.fap-text-images')?.checked;
      meta.forumAuto = { ...(meta.forumAuto || {}), allowTextImages };
      meta.postCastMode = castMode;
      meta.postGenerationCount = postCount;
      await saveForumMeta(userId, meta).catch(() => {});
      const cast = await resolveForumCast({
        mode: castMode,
        scopeKey: 'forum-posts',
        characters: characterList,
      });
      if (!cast) return;
      const scopedCharacters = cast.characters;
      if (sec.id === 'watching_you' && cast.mode === 'passersby') {
        showToast('这个特殊版块必须有角色小号出场');
        return;
      }
      if ((cast.mode === 'roles' || cast.mode === 'scoped-mixed') && !scopedCharacters.length) {
        showToast('所选范围里没有角色');
        return;
      }
      const scopedCharacterMap = characterMapFromList(scopedCharacters);
      const btn = root.querySelector('.fap-go');
      const status = root.querySelector('[data-forum-post-status]');
      const setStatus = (text, opts = {}) => {
        setGenStatus(status, text, opts);
        if (text) updateManualGeneration(generationStateKey, text);
      };
      const genCap = await resolveGenerationMaxTokens();
      let lastForumPostRaw = '';
      if (isManualGenerationRunning(generationStateKey)) {
        showToast('论坛已有生成任务正在进行');
        return;
      }
      beginManualGeneration(generationStateKey, {
        kind: 'posts',
        message: `正在为「${sec.name || '当前版块'}」生成帖子…`,
      });
      setButtonLoading(btn, true);
      close();
      try {
        setStatus('正在整理版块素材…');
        const webMaterials = await collectForumWebMaterials(sec.materialQuery || `${sec.name || ''} ${sec.type || ''}`.trim(), `论坛-${sec.type || '素材'}`);
        setStatus('正在准备上下文…');
        const systemPrompt = await buildForumAiSystemPrompt(user, {
          worldBookIds: sec.worldBookIds || sec.worldBookId || [],
          auEntryIds: sec.auEntryIds || [],
          referenceNotes: [`同版块续写。版块名:${sec.name || ''}`, sec.desc ? `描述要求:${sec.desc}` : ''].filter(Boolean).join('\n'),
          section: sec,
          webMaterials,
          characters: scopedCharacters,
          allowStickers,
          passerbyIsolation: cast.mode !== 'roles',
        });
        const sectionThreads = threads
          .filter((t) => (t.sectionId || 'general') === sec.id)
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, 8);
        const topicPlan = buildForumTopicPlan({
          count: postCount,
          recentThreads: sectionThreads,
          allowPrivateContext: cast.mode !== 'passersby' && scopedCharacters.length > 0,
          weiboAvailable: await hasFreshForumWeiboMaterial(userId),
          seed: `${userId}|${sec.id}|${onceKey}`,
        });
        const history = sectionThreads.map((t, i) => {
          const rs = Array.isArray(t.replies) ? t.replies.slice(0, 3).map((r) => `${r.author}:${r.content}`).join(' | ') : '';
          const title = stripSocialStickerMarkers(t.title || '', stickerPool) || '无标题';
          return `${i + 1}. ${title}\n正文:${String(t.content || '').slice(0, 180)}\n回复样例:${rs || '无'}`;
        }).join('\n\n');
        const watchingStylePrompt = buildWatchingYouStylePrompt(sec);
        const allowImages = meta.forumAuto?.allowImages === true;
        const imageRules = await buildForumGeneratedImageRules(allowImages, allowTextImages, allowStickers);
        const task = [
          `任务：在论坛版块「${sec.name || '当前版块'}」下恰好生成 ${postCount} 条新帖子，每条附带恰好 ${meta.forumAuto?.newThreadReplyCount ?? 3} 条回复。threads 数组必须恰好有 ${postCount} 项。`,
          `板块类型：${sec.type || '闲聊'}`,
          `版块生成键：${sec.generationKey || buildRandomGenerationKey('forum_section')}`,
          `版块帖子主生成键：${sec.postGenerationKey || buildRandomGenerationKey('forum_post')}`,
          `本次帖子生成键：${onceKey}`,
          `版块规则如下：\n${rulesToText(sec.forumRules)}`,
          sec.desc ? `版块描述要求：${sec.desc}` : '',
          (sec.worldBookIds?.length || sec.auEntryIds?.length || sec.materialQuery) ? '本版块绑定了世界书/AU/联网素材，必须参考；但角色口吻和人设优先，不要 OOC。' : '',
          demand ? `本次额外定制要求：${demand}` : '本次额外定制要求：无（可随机，但必须符合版块风格）',
          history
            ? `同版块历史帖子摘要（已写过的具体事件/梗本轮禁止同题或换皮新帖；可换新话题，或只给旧帖补楼）：\n${history}`
            : '同版块历史帖子摘要：暂无',
          buildForumTopicPlanPrompt(topicPlan),
          '硬性：本轮新帖必须是新内容。聊天记录若标了过期近况，只能作背景口吻，不得再写成今天主事件；没有今日新鲜聊天时另开新题。',
          watchingStylePrompt,
          buildForumCastPrompt(cast.mode, scopedCharacters, sec),
          meta.forumAuto?.multiNpcInteraction !== false
            ? '允许多个角色与 NPC 在回复区自然接话，但不要机械凑齐所有人。'
            : '本轮每篇帖子最多安排一个主要回复者，不要写多人围攻式互动。',
          buildForumAuthorPrompt(scopedCharacters, sec),
          buildForumTranslationPrompt(scopedCharacters),
          imageRules,
          'title 只能写纯文字帖子标题，禁止包含 [表情包:名称]、[贴纸:名称] 或单独的表情包名称。zh 只翻译 content 正文，不得抄写、翻译或解释表情包标记与名称。',
          allowStickers
            ? '正文与回复中宜含 [表情包:名称]（放在整段文字末尾）；主帖及楼层的 authorId/authorName/author/authorRoleId/forumActorId 不得为 user、当前用户 id/显示名或用户论坛马甲名。'
            : '本次不要在正文或回复里写 [表情包:名称]；主帖及楼层的 authorId/authorName/author/authorRoleId/forumActorId 不得为 user、当前用户 id/显示名或用户论坛马甲名。',
          '强制：回复和回复内容不要分段，回复文本中一次写完整。',
          '如果楼层是回复某一层，使用 replyToFloor 数字字段，禁止把「[回复 XXX: ...]」写进 content。',
          '路人新旧比例遵守上文路人池规则。复用旧路人必须填写池中 forumActorId；新路人必须留空 forumActorId，并填写 authorPersonality、authorSpeechStyle、authorBackground、authorInterests。',
          'threads 每项都输出 wantsImage、imagePrompt、imageCharacterId、textImageCaption；不配图时 wantsImage=false，其余三项留空。',
          '只输出 JSON 对象，不要 markdown：{"threads":[{"title":"标题","content":"正文","zh":"外语正文才需要","authorName":"伪装ID或小号名","authorId":"","authorRoleId":"","forumActorId":"复用常驻路人时填写","authorPersonality":"新路人才填","authorSpeechStyle":"新路人才填","authorBackground":"新路人才填","authorInterests":["新路人才填"],"authorAlias":"","replies":[{"author":"回复者伪装ID","authorRoleId":"可空角色id","forumActorId":"复用常驻路人时填写","authorPersonality":"新路人才填","authorSpeechStyle":"新路人才填","authorBackground":"新路人才填","authorInterests":["新路人才填"],"content":"回复内容","zh":"外语回复才需要"},{"author":"回复者伪装ID","authorRoleId":"可空角色id","forumActorId":"复用常驻路人时填写","replyToFloor":1,"content":"回复内容","zh":"外语回复才需要"}]}]}',
        ].filter(Boolean).join('\n');
        setStatus(`正在生成 ${postCount} 篇${watchingStylePrompt ? '短帖' : '新帖'}…（max≈${genCap}）`);
        const generated = await chatJsonGeneration({
          scope: 'forum-posts',
          messages: [
            { role: 'system', content: `${systemPrompt}\n\n---\n\n你是论坛帖子生成助手，当前任务只允许输出同版块新增帖子。` },
            { role: 'user', content: task },
          ],
          temperature: 0.95,
          maxTokens: genCap,
          onProgress: (message) => setStatus(message),
          repairInstruction: `根对象必须包含 threads 数组；保留最多 ${postCount} 篇完整新帖，宁可缩短正文和回复，也要闭合 JSON。`,
          parse: parseForumJson,
          validate: (value) => value && typeof value === 'object' && coerceForumThreadRows(value).length > 0,
        });
        const raw = generated.raw;
        const parsed = generated.data;
        lastForumPostRaw = String(raw || '');
        let rows = coerceForumThreadRows(parsed).slice(0, postCount);
        if (!rows.length) {
          throw new Error(`生成结果没有可用帖子字段（收到字段：${objectKeys(parsed).join('、') || '无'}）`);
        }
        if (allowImages) setStatus('正在生成帖子配图…');
        rows = await applyForumGeneratedImages(rows, allowImages, allowTextImages, allowStickers);
        setStatus('正在写入版块…');
        const nowTs = await getVirtualNow(userId || '', 0);
        const insertedThreads = [];
        for (const [idx, th] of rows.entries()) {
          const authorInput = cast.mode === 'roles'
            ? enforceForumRoleScopedAuthor(th, scopedCharacters, idx)
            : th;
          const normalizedAuthor = sanitizeGeneratedForumAuthor(authorInput, scopedCharacterMap, generatedAuthorOptions);
          const author = cast.mode === 'passersby'
            ? { ...normalizedAuthor, authorId: '', authorRoleId: '' }
            : normalizedAuthor;
          const content = pickForumThreadContent(th);
          const contentTranslation = sanitizeForumTranslation(content, pickForumTranslation(th), stickerPool);
          const thread = {
            id: `forum_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`,
            title: pickForumThreadTitle(th, `${sec.name || '版块'}新帖`, stickerPool),
            content,
            authorName: author.authorName,
            authorId: author.authorId,
            authorRoleId: author.authorRoleId,
            authorAlias: author.authorAlias,
            forumActorId: String(th?.forumActorId || '').trim(),
            authorPersonality: String(th?.authorPersonality || th?.authorProfile?.personality || '').trim(),
            authorSpeechStyle: String(th?.authorSpeechStyle || th?.authorProfile?.speechStyle || '').trim(),
            authorBackground: String(th?.authorBackground || th?.authorProfile?.background || '').trim(),
            authorInterests: (Array.isArray(th?.authorInterests) ? th.authorInterests : th?.authorProfile?.interests || [])
              .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 8),
            authorSource: 'generated',
            topicSource: topicPlan[idx] || 'section',
            ...pickForumGeneratedImageFields(th),
            userId,
            sectionId: sec.id,
            timestamp: nowTs - idx * 60000,
            generationKey: `${onceKey}_${idx + 1}`,
            replies: normalizeForumReplies(pickForumThreadReplies(th), nowTs - idx * 60000, forbiddenGeneratedNames, stickerPool, {
              user: forumIdentityUser,
              characters: scopedCharacterMap,
            }).slice(0, meta.forumAuto?.newThreadReplyCount ?? 3),
            ...(contentTranslation ? { contentTranslation } : {}),
          };
          await db.put('forumThreads', thread);
          insertedThreads.push(thread);
        }
        meta = await loadForumMeta(userId);
        meta.activeSectionId = sec.id;
        await saveForumMeta(userId, meta);
        forumRefreshSeq += 1;
        promotedThreadIds.clear();
        insertedThreads.forEach((thread) => promotedThreadIds.add(thread.id));
        threads = await loadThreadsForUser(userId);
        lastForumSignature = `${forumMetaSignature(meta)}::${forumThreadSignature(threads)}`;
        refreshListDom();
        finishManualGeneration(generationStateKey, {
          message: `已为「${sec.name || '当前版块'}」生成 ${insertedThreads.length} 条帖子`,
        });
        showToast(`已在当前版块生成 ${insertedThreads.length} 条帖子`);
        void saveForumGenerationDebug(userId, 'post_parsed', {
          raw,
          parsedKeys: objectKeys(parsed),
        });
        void applyForumGenerationActorPlanBestEffort({
          userId,
          user: forumIdentityUser,
          forbiddenNames: forbiddenGeneratedNames,
          roots: insertedThreads,
          knownCharacterIds: scopedCharacters.map((character) => character.id),
        }).then((actorPlan) => {
          if (!actorPlan.ok) {
            console.warn('[forum] 帖子身份整理未完成，正文已正常保存', actorPlan.error || 'timeout');
            return;
          }
          for (const inserted of insertedThreads) void db.put('forumThreads', inserted).catch(() => {});
        }).catch((error) => console.warn('[forum] 帖子身份整理异常，正文已正常保存', error));
      } catch (e) {
        if (container.isConnected && container.dataset.page === 'forum') {
          showGenerationErrorReport(generationErrorFromCatch(e, {
            scope: '论坛 / 帖子生成',
            title: '论坛帖子生成失败',
            rawText: lastForumPostRaw,
          }));
        }
        finishManualGeneration(generationStateKey, {
          ok: false,
          message: `帖子生成失败：${e?.message || '未知错误'}`,
        });
        showToast(`生成失败：${e?.message || '未知错误'}`);
        setStatus(`生成失败：${e?.message || '未知错误'}`);
      } finally {
        setButtonLoading(btn, false);
      }
    });
  }

  function bindInlineActions() {
    container.querySelectorAll('[data-forum-compose]').forEach((btn) => {
      btn.addEventListener('click', () => void openComposeModal());
    });
    container.querySelector('[data-forum-ai-post-current]')?.addEventListener('click', () => {
      openAiPostModal(meta.activeSectionId || DEFAULT_FORUM_SECTIONS[0].id);
    });
  }
}
