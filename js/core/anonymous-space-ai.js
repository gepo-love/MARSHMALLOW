import { resolveGenerationMaxTokens } from './api.js';
import { chatJsonGeneration } from './chat-json-generation.js';
import { isCharacterAiAvailable } from './character-ai-fill.js';
import { getCharacterAiContextName } from '../models/character.js';
import { getUserDisplayName, formatUserSignatureStatusContextLines } from '../models/user.js';
import {
  buildAnonymousHardBoundaryRules,
  getAnonymousDisplayProfile,
  buildAnonymousRealLifeBlurRules,
} from './anonymous-chat.js';
import {
  buildAnonymousActorGroundingBlock,
  buildAnonymousFrontStageRosterBlock,
} from './anonymous-identity-presenter.js';
import {
  countAnonymousSpaceUnlockRequests,
  normalizeAnonymousSpaceGroupFootprint,
  normalizeAnonymousSpacePost,
  normalizeAnonymousSpaceProfile,
} from './anonymous-space.js';
import {
  generateImageForScene,
  loadImageToolConfig,
  persistGeneratedImageUrlLocally,
} from './image-generation-tools.js';
import {
  anonymizeImagePrompt,
  applySceneStyleToPrompt,
  applySocialPostImages,
  buildSocialImageGenPromptRules,
  isAnonymousSpaceImageGenEnabled,
  resolveSceneStyleFragment,
  resolveSocialImageGenMode,
  resolveTextImageCaption,
} from './social-image-generation.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import { buildSurfacePresetBlock } from './preset-store.js';
import { buildSocialFormatGuidancePrompt } from './social-helpers.js';
import { collectRoleplayContextForSocialGeneration } from './context/build-weibo-context.js';
import {
  buildMomentsCharacterCard,
  buildMomentsMemoryBlock,
} from './moments/build-moments-context.js';
import { buildTimeAndHolidayPromptBlock, getNowForUser } from './time-mode.js';

async function resolveStoryNow(userId = '') {
  const uid = clean(userId);
  if (!uid) return Date.now();
  return getNowForUser(uid).catch(() => Date.now());
}

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

function extractFirstBalancedJsonObject(text = '') {
  const raw = normalizeAiPasteText(text);
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
      const slice = normalizeAiPasteText(raw.slice(start, i + 1));
      try {
        return JSON.parse(slice);
      } catch (_) {
        start = -1;
      }
    }
  }
  return null;
}

function extractFirstBalancedJsonArray(text = '') {
  const raw = normalizeAiPasteText(text);
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
    if (ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== ']') continue;
    if (depth > 0) depth -= 1;
    if (depth === 0 && start >= 0) {
      const slice = normalizeAiPasteText(raw.slice(start, i + 1));
      try {
        return JSON.parse(slice);
      } catch (_) {
        start = -1;
      }
    }
  }
  return null;
}

function parseAnonymousSpaceJson(text) {
  const raw = clean(text);
  if (!raw) return null;
  const tryParse = (s) => {
    try { return JSON.parse(normalizeAiPasteText(s)); } catch (_) { return null; }
  };
  let parsed = tryParse(raw);
  if (parsed) return parsed;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    parsed = tryParse(fence[1].trim()) || extractFirstBalancedJsonObject(fence[1]);
    if (parsed) return parsed;
  }
  parsed = extractFirstBalancedJsonObject(raw);
  if (parsed) return parsed;
  parsed = extractFirstBalancedJsonArray(raw);
  if (parsed) return parsed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    parsed = tryParse(raw.slice(start, end + 1));
    if (parsed) return parsed;
  }
  const arrStart = raw.indexOf('[');
  const arrEnd = raw.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    parsed = tryParse(raw.slice(arrStart, arrEnd + 1));
    if (parsed) return parsed;
  }
  return null;
}

function throwAnonymousSpaceJsonError(response, label = '模型') {
  const rawText = String(response ?? '').trim();
  const err = new Error(`${label}未返回有效 JSON，已保留返回原文`);
  err.reason = rawText ? 'json-parse-failed' : 'empty-api-response';
  err.rawText = rawText;
  err.rawResponse = rawText;
  throw err;
}

/** @deprecated 使用 parseAnonymousSpaceJson */
function extractJson(text) {
  return parseAnonymousSpaceJson(text);
}

function buildVirtualAnonSpaceChat(actorId, actorProfile = {}, userProfile = {}) {
  const aid = clean(actorId);
  const actorHandle = clean(actorProfile.handle) || '匿名网友';
  const userHandle = clean(userProfile.handle) || '匿名网友';
  return {
    type: 'private',
    id: `anon_space_virtual_${aid}`,
    participants: ['user', aid],
    metadata: {
      channel: 'anonymous',
      anonymousMode: true,
      anonymousRoomKind: 'private',
      memoryMode: 'inherit_full',
      sourceAnonymousType: 'space',
    },
    anonymousPrivateConfig: {
      counterpartActorId: aid,
      identities: {
        user: {
          currentId: userHandle,
          signature: clean(userProfile.signature || userProfile.bio),
        },
        [aid]: {
          currentId: actorHandle,
          signature: clean(actorProfile.signature || actorProfile.bio),
        },
      },
    },
  };
}

function buildAnonymousSpaceAiContext({
  chat,
  user,
  characters = {},
  userSpaceProfile = null,
  actorSpaceProfile = null,
}) {
  const userName = clean(userSpaceProfile?.handle) || '匿名网友';
  const anonOpts = {
    currentUserName: getUserDisplayName(user),
    userRow: user,
    spaceProfile: userSpaceProfile,
  };
  return [
    buildAnonymousHardBoundaryRules(chat),
    buildAnonymousFrontStageRosterBlock(chat, anonOpts),
    buildAnonymousActorGroundingBlock(chat, characters, anonOpts),
    actorSpaceProfile?.bio ? `【当前匿名空间公开简介】${clean(actorSpaceProfile.bio)}` : '',
    actorSpaceProfile?.signature ? `【空间签名】${clean(actorSpaceProfile.signature)}` : '',
    actorSpaceProfile?.mood ? `【空间状态】${clean(actorSpaceProfile.mood)}` : '',
    (actorSpaceProfile?.interests || []).length
      ? `【公开兴趣】${actorSpaceProfile.interests.join('、')}`
      : '',
    `【任务身份提醒】你是 actorId=${Object.keys(characters).find((id) => id !== 'user') || 'character'} 的匿名小号；访客是 user，前台只称「${userName}」，禁止认出外部真名。`,
  ].filter(Boolean).join('\n\n');
}

async function ensureAiReady() {
  if (!(await isCharacterAiAvailable())) {
    const err = new Error('请先在设置里配置聊天或工具 API');
    err.code = 'api-not-configured';
    throw err;
  }
}

const ANON_SPACE_VOICE_RULES = [
  '【匿名空间动态 · 口吻硬性规则】',
  '1. posts 是空间时间线上的「说说」动态，解锁后访客才能阅读；不要另写 hiddenSeed/隐藏心事。',
  '2. 每条动态 15-45 字，像这个人半夜在小号随手敲的：口语、碎、可吐槽可丧可文艺，但不要长段散文/公告/心灵鸡汤。',
  '3. 必须完全贴合下方人设卡、说话风格、语料底色与世界书；禁止 AI 解说腔、翻译腔、统一文艺模板。',
  '4. 禁止出现「作为AI/根据设定/世界书/角色卡/聊天记录」等元叙述；禁止写真名、联系方式、可定位信息。',
  '5. 同一批动态话题要有变化（吐槽/烦恼/回忆/迷茫/日常碎念/配图心情等），不要五条都在说同一件事。',
  buildAnonymousRealLifeBlurRules(),
].join('\n');

function resolvePastPostTimestamp(row = {}, idx = 0, now = Date.now()) {
  const daysAgo = Number(row.daysAgo ?? row.days_ago);
  if (Number.isFinite(daysAgo) && daysAgo > 0) {
    return now - Math.round(daysAgo * 86400000) - idx * 1800000;
  }
  const hoursAgo = Number(row.hoursAgo ?? row.hours_ago);
  if (Number.isFinite(hoursAgo) && hoursAgo >= 6) {
    return now - Math.round(hoursAgo * 3600000);
  }
  const ts = Number(row.timestamp);
  if (ts > 0 && ts < now - 3600000) return ts;
  const daySpread = 3 + idx * 5 + (idx % 3) * 6;
  return now - daySpread * 86400000 - idx * 7200000;
}

function buildDefaultPostTextImage(post = {}) {
  return resolveTextImageCaption(post);
}

function resolvePostTextImage(post = {}) {
  const raw = clean(post.textImage || post.text_image || post.textImageCaption);
  if (raw) return raw.slice(0, 480);
  if (clean(post.imagePrompt) || clean(post.text)) return buildDefaultPostTextImage(post);
  return '';
}

export { isAnonymousSpaceImageGenEnabled } from './social-image-generation.js';

function parsePostsFromAi(rawPosts = [], now = Date.now()) {
  return (Array.isArray(rawPosts) ? rawPosts : [])
    .map((row, idx) => normalizeAnonymousSpacePost({
      id: `aspost_${now}_${idx}`,
      text: clean(row.text || row.content || row.body).slice(0, 120),
      mood: clean(row.mood || row.tag || row.type),
      imagePrompt: clean(row.imagePrompt || row.image_prompt || row.imageHint),
      textImage: clean(row.textImage || row.text_image || row.textImageCaption).slice(0, 480),
      wantsImage: row.wantsImage === true || row.wantsImage === 'true' || !!clean(row.imagePrompt),
      timestamp: resolvePastPostTimestamp(row, idx, now),
      replies: Array.isArray(row.replies) ? row.replies : [],
    }))
    .filter((p) => p.text && p.text.length >= 4)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 12);
}

async function buildRichAnonymousSpaceGenerationContext({
  character,
  user,
  actorId,
  userSpaceProfile = null,
  actorSpaceProfile = null,
}) {
  const aid = clean(actorId);
  const userProfile = normalizeAnonymousSpaceProfile(userSpaceProfile || {});
  const actorProfile = normalizeAnonymousSpaceProfile(actorSpaceProfile || {});
  const chat = buildVirtualAnonSpaceChat(aid, actorProfile, userProfile);
  const base = buildAnonymousSpaceAiContext({
    chat,
    user,
    characters: character ? { [aid]: character } : {},
    userSpaceProfile: userProfile,
    actorSpaceProfile: actorProfile,
  });
  const presetBlock = await buildSurfacePresetBlock('anon_space').catch(() => '');
  const timeBlock = user?.id ? await buildTimeAndHolidayPromptBlock(user.id).catch(() => '') : '';
  const blocks = [base, timeBlock, ANON_SPACE_VOICE_RULES, buildSocialFormatGuidancePrompt('anon_space'), presetBlock];
  if (character && aid) {
    const charCard = buildMomentsCharacterCard(character, aid);
    if (charCard) blocks.push(charCard);
    const memoryBlock = await buildMomentsMemoryBlock(user?.id, [aid], {
      memoryLimit: 6,
      factLimit: 8,
    }).catch(() => '');
    if (memoryBlock) blocks.push(memoryBlock);
    const selectiveBlob = [
      character.personality,
      character.speechStyle,
      character.speechCorpus,
      character.promptCorpus,
      character.currentRole,
      character.notes,
    ].filter(Boolean).join('\n');
    const wbBlock = await buildWorldBookContextBlock(user, selectiveBlob, {
      worldBookMode: 'selective',
      characterIds: [aid],
    }).catch(() => '');
    if (wbBlock) blocks.push(wbBlock);
    const roleplay = await collectRoleplayContextForSocialGeneration(user?.id, null, {
      focusCharacterIds: [aid],
      excludeAnonymous: false,
      strictFocus: true,
    }).catch(() => null);
    if (roleplay?.relationLines?.length) {
      blocks.push(`【人物关系网】\n${roleplay.relationLines.join('\n')}`);
    }
    if (roleplay?.snippets?.length) {
      blocks.push(`【近期聊天口吻参考 · 学语气别抄原句】\n${roleplay.snippets.slice(0, 14).join('\n')}`);
    }
  } else if (user) {
    const userLines = [];
    if (user.persona) userLines.push(`用户人设：${clean(user.persona).slice(0, 200)}`);
    if (user.hobbies) userLines.push(`兴趣：${clean(user.hobbies).slice(0, 120)}`);
    userLines.push(...formatUserSignatureStatusContextLines(user, {
      clean,
      signatureMax: 80,
      statusMax: 80,
    }));
    if (userLines.length) blocks.push(`【用户小号底色】\n${userLines.join('\n')}`);
  }
  return blocks.filter(Boolean).join('\n\n');
}

function buildActorSpaceGenerationTask(existingProfile = {}, imageRules = '', reservedHandles = []) {
  const prevSig = clean(existingProfile.signature);
  const prevMood = clean(existingProfile.mood || existingProfile.statusText);
  const prevLines = [
    prevSig ? `当前签名：${prevSig}` : '',
    prevMood ? `当前状态：${prevMood}` : '',
  ].filter(Boolean);
  const reserved = [...new Set(
    (Array.isArray(reservedHandles) ? reservedHandles : [])
      .map((h) => clean(h))
      .filter(Boolean),
  )];
  return [
    '本次任务：为这名角色生成匿名空间资料 + 一批空间动态 posts（早年 QQ 小号时间线）。',
    prevLines.length ? `【可改写】${prevLines.join('；')} —— 生成时请一并刷新马甲网名 handle、匿名签名 signature、在线状态 mood，使其贴合角色口吻与即将生成的动态氛围。` : '',
    '要求：',
    '- handle 2-6 字马甲；可与旧网名不同，但要像同一个人会换的小号名。',
    reserved.length
      ? `- 【硬性】handle 绝不能与访客已有马甲撞名或近似：${reserved.join('、')}`
      : '',
    '- signature：12-36 字匿名签名，像 QQ 签名档，可丧可皮可文艺，贴合角色说话风格。',
    '- mood：4-16 字在线状态/心情（如「深夜失眠」「潜水」「刚上线」「不想说话」），与近期动态情绪一致。',
    '- bio 一句空间简介；interests 3-5 个、joinedGroups 2-4 个。',
    '- posts【重点】一次输出 4-8 条空间动态，每条独立：',
    '  · 15-45 字，角色口吻，像深夜发说说；提到外面的人/工作/亲友必须模糊指代。',
    '  · daysAgo 必填（3-90 天前，彼此错开）。',
    imageRules,
    '- groupFootprints 2-4 条小组足迹。',
    '禁止：一条超长动态顶替多条；输出 hiddenSeed/隐藏心事字段。',
    '只输出 JSON：',
    '{"handle":"马甲","signature":"签名","bio":"简介","mood":"状态","interests":["兴趣"],"joinedGroups":["小组"],"posts":[{"text":"短说说","mood":"吐槽","daysAgo":18,"wantsImage":true,"imagePrompt":"desk lamp, instant noodles, laptop glow, night","textImageCaption":"加班桌\\n台灯照着泡面和键盘\\n窗外是黑的"}],"groupFootprints":[{"groupName":"小组","action":"joined","text":"足迹"}]}',
  ].filter(Boolean).join('\n');
}

function buildUserSpaceGenerationTask(existingProfile = {}, imageRules = '') {
  const prevSig = clean(existingProfile.signature);
  const prevMood = clean(existingProfile.mood || existingProfile.statusText);
  const prevLines = [
    prevSig ? `当前签名：${prevSig}` : '',
    prevMood ? `当前状态：${prevMood}` : '',
  ].filter(Boolean);
  return [
    '本次任务：为用户生成匿名空间 + 4-8 条过去时间线的空间动态 + 访客足迹。',
    prevLines.length ? `【可改写】${prevLines.join('；')} —— 请刷新 handle、signature、mood。` : '',
    '- signature 12-36 字；mood 4-16 字在线状态，与动态氛围一致。',
    '- posts 每条 15-45 字，daysAgo 3-60。',
    imageRules,
    '- footprints 3-6 条访客记录（visitorName、note、daysAgo、durationSec 30-600）。',
    '- messages 0-3 条路人留言。',
    '只输出 JSON：',
    '{"handle":"网名","signature":"签名","bio":"简介","mood":"状态","interests":["兴趣"],"posts":[{"text":"动态","mood":"迷茫","daysAgo":9,"wantsImage":true,"imagePrompt":"window rain, coffee cup","textImageCaption":"窗边的杯\\n玻璃上全是雨痕\\n桌角一杯没喝完的咖啡"}],"footprints":[{"visitorName":"网友","note":"看了看","daysAgo":2,"durationSec":95}],"messages":[{"from":"网友","text":"留言"}]}',
  ].filter(Boolean).join('\n');
}

async function anonSpaceMaxTokens() {
  return resolveGenerationMaxTokens();
}

async function callAnonymousSpaceGeneration({
  context,
  actorLabel,
  task,
  temperature = 0.88,
}) {
  const maxTokens = await anonSpaceMaxTokens();
  const generated = await chatJsonGeneration({
    scope: 'anonymous-space',
    retryOnInvalid: false,
    task: 'anonymousSpace',
    messages: [
      { role: 'system', content: `${context}\n\n${actorLabel}` },
      { role: 'user', content: task },
    ],
    temperature,
    maxTokens,
    parse: parseAnonymousSpaceJson,
    validate: (value) => value && typeof value === 'object',
  });
  return generated.data;
}

async function buildSupplementAnonymousSpaceContext({
  character,
  user,
  actorId,
  userSpaceProfile = null,
  actorSpaceProfile = null,
  existingPostTexts = [],
}) {
  const userProfile = normalizeAnonymousSpaceProfile(userSpaceProfile || {});
  const actorProfile = normalizeAnonymousSpaceProfile(actorSpaceProfile || {});
  const chat = buildVirtualAnonSpaceChat(actorId, actorProfile, userProfile);
  const charCard = buildMomentsCharacterCard(character, actorId);
  const presetBlock = await buildSurfacePresetBlock('anon_space').catch(() => '');
  const timeBlock = user?.id ? await buildTimeAndHolidayPromptBlock(user.id).catch(() => '') : '';
  return [
    buildAnonymousHardBoundaryRules(chat),
    buildAnonymousActorGroundingBlock(chat, { [actorId]: character }, {
      currentUserName: getUserDisplayName(user),
      userRow: user,
      spaceProfile: userProfile,
    }),
    charCard,
    timeBlock,
    ANON_SPACE_VOICE_RULES,
    buildSocialFormatGuidancePrompt('anon_space'),
    presetBlock,
    actorProfile.signature ? `【当前签名】${actorProfile.signature}` : '',
    actorProfile.mood ? `【当前状态】${actorProfile.mood}` : '',
    existingPostTexts.length ? `【已有动态 · 勿重复】\n${existingPostTexts.join('\n')}` : '',
    '【输出硬性要求】只输出一个 JSON 对象；首字符必须是 {，末字符必须是 }；禁止 Markdown 解释、禁止前后缀废话。',
  ].filter(Boolean).join('\n\n');
}

function parseSupplementPostReplies(raw = [], posts = [], actorId = '', actorHandle = '') {
  const list = Array.isArray(raw) ? raw : [];
  const handle = clean(actorHandle) || actorId || '空间主人';
  return list.map((row, idx) => {
    const replyText = clean(row.reply || row.text || row.content);
    if (!replyText) return null;
    const postIdHint = clean(row.postId || row.id);
    const postTextHint = clean(row.postText || row.post || row.textMatch || row.dynamic);
    let post = postIdHint
      ? (posts || []).find((p) => clean(p.id) === postIdHint)
      : null;
    if (!post && postTextHint) {
      post = (posts || []).find((p) => {
        const t = clean(p.text);
        return t && (t.includes(postTextHint.slice(0, 12)) || postTextHint.includes(t.slice(0, 12)));
      });
    }
    if (!post?.id) return null;
    return {
      postId: post.id,
      reply: replyText,
      from: handle,
      fromId: actorId,
      id: `asreply_${Date.now()}_${idx}`,
    };
  }).filter(Boolean).slice(0, 6);
}

function collectPendingPostReplies(posts = [], visitorHandle = '') {
  const handle = clean(visitorHandle);
  const pending = [];
  for (const post of (Array.isArray(posts) ? posts : []).slice(0, 10)) {
    const replies = Array.isArray(post.replies) ? post.replies : [];
    if (!replies.length) continue;
    const latest = replies[0];
    const fromId = clean(latest.fromId);
    const fromName = clean(latest.from);
    const isVisitor = fromId === 'user' || (handle && fromName === handle);
    if (!isVisitor) continue;
    pending.push({
      postId: post.id,
      postText: clean(post.text),
      visitorNote: clean(latest.text),
    });
  }
  return pending.slice(0, 4);
}

function normalizeSupplementPayload(parsed, now = Date.now(), posts = [], actorId = '', actorHandle = '') {
  if (!parsed) return null;
  if (Array.isArray(parsed)) {
    const extraPosts = parsePostsFromAi(parsed, now);
    return extraPosts.length ? { reply: '', extraPosts, postReplies: [] } : null;
  }
  if (typeof parsed !== 'object') return null;
  const nested = parsed.data || parsed.result || parsed.output;
  const source = (nested && typeof nested === 'object') ? nested : parsed;
  const extraRaw = source.extraPosts || source.posts || source.newPosts || source.dynamics;
  const reply = clean(source.reply || source.message || source.response || parsed.reply);
  const extraPosts = extraRaw ? parsePostsFromAi(extraRaw, now) : [];
  const postReplies = parseSupplementPostReplies(
    source.postReplies || source.commentReplies || source.repliesToVisitor,
    posts,
    actorId,
    actorHandle,
  );
  if (!extraPosts.length && !reply && !postReplies.length) return null;
  return { reply, extraPosts, postReplies };
}

async function requestAnonymousSpaceJson({
  context,
  actorLabel,
  task,
  temperature = 0.88,
  label = '模型',
}) {
  const maxTokens = await anonSpaceMaxTokens();
  const generated = await chatJsonGeneration({
    scope: `anonymous-space-${label}`,
    retryOnInvalid: false,
    task: 'anonymousSpace',
    messages: [
      { role: 'system', content: `${context}\n\n${actorLabel}` },
      { role: 'user', content: task },
    ],
    temperature,
    maxTokens,
    parse: parseAnonymousSpaceJson,
    validate: (value) => value != null,
  });
  return { parsed: generated.data, response: generated.raw };
}

function parseGroupFootprintsFromAi(raw = [], now = Date.now()) {
  return (Array.isArray(raw) ? raw : [])
    .map((row, idx) => normalizeAnonymousSpaceGroupFootprint({
      id: `asgf_${now}_${idx}`,
      groupName: clean(row.groupName || row.group),
      action: clean(row.action || 'joined'),
      text: clean(row.text || row.note),
      timestamp: Number(row.timestamp || now - idx * 7200000) || (now - idx * 7200000),
    }))
    .filter((e) => e.groupName || e.text)
    .slice(0, 8);
}

function parseMessagesFromAi(raw = [], now = Date.now()) {
  return (Array.isArray(raw) ? raw : [])
    .map((row, idx) => ({
      id: `asmsg_${now}_${idx}`,
      from: clean(row.from || row.visitorName || '路过网友'),
      fromId: clean(row.fromId || 'visitor'),
      text: clean(row.text || row.content),
      timestamp: Number(row.timestamp || now - idx * 5400000) || (now - idx * 5400000),
      read: false,
    }))
    .filter((m) => m.text)
    .slice(0, 8);
}

function parseFootprintsFromAi(raw = [], now = Date.now()) {
  return (Array.isArray(raw) ? raw : [])
    .map((row, idx) => {
      const daysAgo = Number(row.daysAgo ?? row.days_ago);
      const hoursAgo = Number(row.hoursAgo ?? row.hours_ago);
      let timestamp = Number(row.timestamp || 0) || 0;
      if (!timestamp || timestamp >= now) {
        if (Number.isFinite(daysAgo) && daysAgo > 0) {
          timestamp = now - Math.round(daysAgo * 86400000);
        } else if (Number.isFinite(hoursAgo) && hoursAgo > 0) {
          timestamp = now - Math.round(hoursAgo * 3600000);
        } else {
          timestamp = now - (idx + 1) * 86400000;
        }
      }
      return {
        id: `fp_${now}_${idx}`,
        visitorId: clean(row.visitorId || row.visitorName || 'visitor'),
        visitorName: clean(row.visitorName || row.from || '路过网友'),
        note: clean(row.note || '看了看空间'),
        timestamp,
        durationMs: Math.max(3000, Number(row.durationMs || row.durationSec * 1000 || 0) || 0),
        leftAt: Number(row.leftAt || 0) || 0,
      };
    })
    .filter((f) => f.visitorName)
    .slice(0, 12);
}

export async function applyAnonymousSpacePostVisuals(posts = [], options = {}) {
  return applySocialPostImages(posts, {
    scene: 'chatImages',
    imageField: 'image',
    maxImages: options.maxImages ?? 2,
    signal: options.signal,
    config: options.config,
    anonymize: true,
  });
}

/** @deprecated 使用 applyAnonymousSpacePostVisuals */
export const maybeGenerateAnonymousSpacePostImages = applyAnonymousSpacePostVisuals;

export async function generateAnonymousSpacePostImage(post = {}, options = {}) {
  const prompt = clean(post.imagePrompt || post.text);
  if (!prompt) throw new Error('这条动态没有配图描述');
  const textImage = resolvePostTextImage(post);
  const genEnabled = await isAnonymousSpaceImageGenEnabled();
  if (genEnabled) {
    try {
      // 匿名马甲配图不套角色本体锁脸/参考图（那会直接暴露真实长相），只兜底追加不露脸后缀
      const cfg = await loadImageToolConfig().catch(() => ({}));
      const styledPrompt = applySceneStyleToPrompt(prompt, resolveSceneStyleFragment('', cfg));
      const genPrompt = anonymizeImagePrompt(styledPrompt);
      const genOptions = { portraitStyleAllowed: false };
      const result = await generateImageForScene(genPrompt, 'chatImages', genOptions);
      let url = clean(result?.url);
      if (url) {
        url = await persistGeneratedImageUrlLocally(url);
        return { image: url, imageKind: 'photo', textImage };
      }
    } catch (_) { /* fallback */ }
  }
  if (!textImage) throw new Error('生图不可用，且没有文字图内容');
  return { image: '', imageKind: 'textimg', textImage };
}

function mapActorProfileResult(parsed = {}, now = Date.now(), reservedHandles = []) {
  const reserved = new Set(
    (Array.isArray(reservedHandles) ? reservedHandles : [])
      .map((h) => clean(h).toLowerCase())
      .filter(Boolean),
  );
  let handle = clean(parsed.handle || parsed.anonymousId).slice(0, 24) || '路过网友';
  let n = 2;
  const base = handle;
  while (reserved.has(handle.toLowerCase())) {
    handle = `${base}${n}`.slice(0, 24);
    n += 1;
    if (n > 20) {
      handle = `网友${Math.floor(Math.random() * 90) + 10}`;
      break;
    }
  }
  return {
    handle,
    signature: clean(parsed.signature || parsed.bio).slice(0, 80) || `${handle}，在线潜水`,
    bio: clean(parsed.bio || parsed.signature).slice(0, 200) || '还没想好怎么介绍自己。',
    mood: clean(parsed.mood || parsed.statusText).slice(0, 40) || '在线潜水',
    statusText: clean(parsed.mood || parsed.statusText).slice(0, 40) || '在线潜水',
    interests: (Array.isArray(parsed.interests) ? parsed.interests : [])
      .map(clean).filter(Boolean).slice(0, 8),
    joinedGroups: (Array.isArray(parsed.joinedGroups) ? parsed.joinedGroups : [])
      .map(clean).filter(Boolean).slice(0, 8),
    posts: parsePostsFromAi(parsed.posts, now),
    groupFootprints: parseGroupFootprintsFromAi(parsed.groupFootprints, now),
  };
}

export async function generateActorAnonymousSpaceProfileAI({
  character,
  user,
  userSpaceProfile = null,
  existingProfile = null,
  withImages = true,
} = {}) {
  await ensureAiReady();
  const actorId = clean(character?.id);
  if (!actorId) throw new Error('角色无效');
  const actorName = getCharacterAiContextName(character, actorId);
  const userProfile = normalizeAnonymousSpaceProfile(userSpaceProfile || {});
  const reservedHandles = [
    clean(userProfile.handle),
  ].filter(Boolean);
  const context = await buildRichAnonymousSpaceGenerationContext({
    character,
    user,
    actorId,
    userSpaceProfile,
    actorSpaceProfile: existingProfile || {},
  });
  const actorLabel = `角色：${actorName}（actorId=${actorId}）`;
  const imageRules = buildSocialImageGenPromptRules(await resolveSocialImageGenMode('chatImages'), { anonymize: true });
  const parsed = await callAnonymousSpaceGeneration({
    context,
    actorLabel,
    task: buildActorSpaceGenerationTask(existingProfile || {}, imageRules, reservedHandles),
    temperature: 0.86,
  });
  const now = await resolveStoryNow(user?.id);
  const result = mapActorProfileResult(parsed, now, reservedHandles);
  if (result.posts.length) {
    result.posts = await applyAnonymousSpacePostVisuals(result.posts, {
      maxImages: withImages ? 2 : 0,
    });
  }
  return result;
}

function buildUserSpaceAmbientTask(existingFootprints = []) {
  const prev = (Array.isArray(existingFootprints) ? existingFootprints : []).slice(0, 4)
    .map((f) => `- ${clean(f.visitorName)}：${clean(f.note)}`)
    .join('\n');
  return [
    '本次任务：只为用户匿名空间补充访客足迹 footprints（不要生成 posts、不要改资料）。',
    prev ? `【已有足迹 · 勿重复】\n${prev}` : '',
    '- 输出 3-5 条新访客记录：visitorName 2-6 字虚构网名，note 短句，daysAgo 1-45，durationSec 30-900。',
    '只输出 JSON：',
    '{"footprints":[{"visitorName":"网友","note":"看了看","daysAgo":3,"durationSec":120}]}',
  ].filter(Boolean).join('\n');
}

export async function generateUserSpaceFootprintsAI({
  user,
  userSpaceProfile = null,
  characters = [],
  existingFootprints = [],
} = {}) {
  await ensureAiReady();
  const userProfile = normalizeAnonymousSpaceProfile(userSpaceProfile || {});
  const context = await buildRichAnonymousSpaceGenerationContext({
    character: null,
    user,
    actorId: 'user',
    userSpaceProfile: userProfile,
    actorSpaceProfile: userProfile,
  });
  const castHint = (Array.isArray(characters) ? characters : []).slice(0, 6)
    .map((c) => clean(c?.name || c?.realName || c?.id))
    .filter(Boolean)
    .join('、');
  const actorLabel = `用户：${getUserDisplayName(user)}${castHint ? `\n通讯录角色（访客足迹可用其小号网名意象，勿用真名）：${castHint}` : ''}`;
  const parsed = await callAnonymousSpaceGeneration({
    context,
    actorLabel,
    task: buildUserSpaceAmbientTask(existingFootprints),
    temperature: 0.9,
  });
  return parseFootprintsFromAi(parsed.footprints, await resolveStoryNow(user?.id));
}

/** @deprecated 用户空间动态改用手动发布；保留兼容 */
export async function generateUserAnonymousSpaceProfileAI({
  user,
  userSpaceProfile = null,
  characters = [],
} = {}) {
  await ensureAiReady();
  const userProfile = normalizeAnonymousSpaceProfile(userSpaceProfile || {});
  const context = await buildRichAnonymousSpaceGenerationContext({
    character: null,
    user,
    actorId: 'user',
    userSpaceProfile: userProfile,
    actorSpaceProfile: userProfile,
  });
  const castHint = (Array.isArray(characters) ? characters : []).slice(0, 6)
    .map((c) => clean(c?.name || c?.realName || c?.id))
    .filter(Boolean)
    .join('、');
  const actorLabel = `用户：${getUserDisplayName(user)}${castHint ? `\n通讯录角色（访客足迹用虚构网名）：${castHint}` : ''}`;
  const imageRules = buildSocialImageGenPromptRules(await resolveSocialImageGenMode('chatImages'), { anonymize: true });
  const parsed = await callAnonymousSpaceGeneration({
    context,
    actorLabel,
    task: buildUserSpaceGenerationTask(userProfile, imageRules),
    temperature: 0.88,
  });
  const now = await resolveStoryNow(user?.id);
  let posts = parsePostsFromAi(parsed.posts, now);
  posts = await applyAnonymousSpacePostVisuals(posts, { maxImages: 2 });
  const handle = clean(parsed.handle).slice(0, 24) || userProfile.handle || '路过网友';
  return {
    handle,
    signature: clean(parsed.signature || parsed.bio).slice(0, 80) || `${handle}，在线潜水`,
    bio: clean(parsed.bio || parsed.signature).slice(0, 200) || '还没想好怎么介绍自己。',
    mood: clean(parsed.mood || parsed.statusText).slice(0, 40) || '在线潜水',
    statusText: clean(parsed.mood || parsed.statusText).slice(0, 40) || '在线潜水',
    interests: (Array.isArray(parsed.interests) ? parsed.interests : [])
      .map(clean).filter(Boolean).slice(0, 8),
    posts,
    footprints: parseFootprintsFromAi(parsed.footprints, now),
    messages: parseMessagesFromAi(parsed.messages, now),
  };
}

export async function resolveAnonymousSpaceUnlockAI({
  character,
  user,
  userSpaceProfile = null,
  actorSpaceProfile = null,
  actorSpaceState = null,
  requestNote = '',
} = {}) {
  await ensureAiReady();
  const actorId = clean(character?.id);
  if (!actorId) throw new Error('角色无效');
  const actorName = getCharacterAiContextName(character, actorId);
  const userProfile = normalizeAnonymousSpaceProfile(userSpaceProfile || {});
  const actorProfile = normalizeAnonymousSpaceProfile(actorSpaceProfile || {});
  const visitorHandle = clean(userProfile.handle) || '匿名网友';
  const chat = buildVirtualAnonSpaceChat(actorId, actorProfile, userProfile);
  const requestCount = actorSpaceState
    ? countAnonymousSpaceUnlockRequests(actorSpaceState)
    : 1;
  const postCount = (actorSpaceState?.posts || []).length;
  const context = await buildRichAnonymousSpaceGenerationContext({
    character,
    user,
    actorId,
    userSpaceProfile: userProfile,
    actorSpaceProfile: actorProfile,
  });
  const note = clean(requestNote);
  const task = [
    `访客「${visitorHandle}」请求查看你的匿名空间动态（小号说说时间线），希望解锁阅读权限。`,
    `这是对方第 ${requestCount} 次申请。`,
    note ? `访客附言：${note}` : '',
    postCount ? `【空间内共有 ${postCount} 条动态，解锁后对方才能全部阅读】` : '',
    '请以这名角色的匿名小号身份决定：是否同意让对方查看空间动态。',
    '规则：',
    '- granted=true 表示同意解锁；granted=false 表示拒绝。按人设与信任感决定；多次申请可松动，也可更烦。',
    '- reply 写一段给访客看的短回复（1-3 句，像空间留言/私戳，用网友口吻，不要真名）。',
    '- 若同意，你应记住自己给对方开了锁；之后聊天里可以自然提起，但不要重复掉马。',
    '只输出 JSON：',
    '{"granted":true,"reply":"给访客的短回复"}',
  ].filter(Boolean).join('\n');
  const { parsed } = await requestAnonymousSpaceJson({
    context,
    actorLabel: `角色：${actorName}（actorId=${actorId}）`,
    task,
    temperature: 0.88,
    label: '解锁判定',
  });
  const granted = parsed.granted === true || parsed.granted === 'true';
  return {
    granted,
    reply: clean(parsed.reply || parsed.message || (granted ? '好吧，给你看。' : '先不了。')).slice(0, 320),
    visitorHandle,
    requestCount,
    actorHandle: clean(actorProfile.handle)
      || clean(getAnonymousDisplayProfile(chat, actorId, { currentUserName: getUserDisplayName(user) })?.anonymousId)
      || actorId,
  };
}

export async function supplementAnonymousSpacePostsAI({
  character,
  user,
  userSpaceProfile = null,
  actorSpaceProfile = null,
  actorSpaceState = null,
} = {}) {
  await ensureAiReady();
  const actorId = clean(character?.id);
  if (!actorId) throw new Error('角色无效');
  const actorName = getCharacterAiContextName(character, actorId);
  const userProfile = normalizeAnonymousSpaceProfile(userSpaceProfile || {});
  const actorProfile = normalizeAnonymousSpaceProfile(actorSpaceProfile || {});
  const visitorHandle = clean(userProfile.handle) || '匿名网友';
  const actorHandle = clean(actorProfile.handle) || actorId;
  const posts = (actorSpaceState?.posts || []);
  const existingPostTexts = posts.slice(0, 6).map((p) => `- ${p.text}`);
  const pendingReplies = collectPendingPostReplies(posts, visitorHandle);
  const context = await buildSupplementAnonymousSpaceContext({
    character,
    user,
    actorId,
    userSpaceProfile: userProfile,
    actorSpaceProfile: actorProfile,
    existingPostTexts,
  });
  const actorLabel = `角色：${actorName}（actorId=${actorId}）`;
  const imageRules = buildSocialImageGenPromptRules(await resolveSocialImageGenMode('chatImages'), { anonymize: true });
  const pendingBlock = pendingReplies.length
    ? [
      '【访客评论 · 请一并回复】',
      ...pendingReplies.map((row) => `- 动态「${row.postText.slice(0, 40)}」下访客说：「${row.visitorNote}」`),
      '- 在 postReplies 里写你的回一句（postText 填动态摘要便于匹配）。',
    ].join('\n')
    : '';
  const task = [
    `访客「${visitorHandle}」已解锁你的匿名空间，点了「补充动态」，希望再多看 2-3 条说说。`,
    pendingBlock,
    imageRules,
    '要求：',
    '- extraPosts：2-3 条，每条 text 15-45 字，daysAgo 1-30，口吻贴合人设。',
    '- reply：给访客一句短回复（1-2 句）。',
    pendingReplies.length ? '- postReplies：回应上面列出的访客评论。' : '',
    '- 提到现实人际须模糊指代。',
    '只输出 JSON，示例：',
    '{"reply":"行，再给你看几条","extraPosts":[{"text":"新动态","mood":"吐槽","daysAgo":5,"wantsImage":true,"imagePrompt":"rainy window, coffee mug","textImageCaption":"窗边的杯\\n玻璃上全是雨痕\\n桌角一杯没喝完的咖啡"}],"postReplies":[{"postText":"原动态摘要","reply":"回一句"}]}',
  ].filter(Boolean).join('\n');
  const now = await resolveStoryNow(user?.id);
  const { parsed, response } = await requestAnonymousSpaceJson({
    context,
    actorLabel,
    task,
    temperature: 0.86,
    label: '补充动态',
  });
  const result = normalizeSupplementPayload(parsed, now, posts, actorId, actorHandle);
  if (!result?.extraPosts?.length && !result?.postReplies?.length) {
    throwAnonymousSpaceJsonError(response, '补充动态');
  }
  const extraPosts = result.extraPosts?.length
    ? await applyAnonymousSpacePostVisuals(result.extraPosts, { maxImages: 2 })
    : [];
  return {
    reply: clean(result.reply).slice(0, 200),
    extraPosts,
    postReplies: result.postReplies || [],
  };
}

/** @deprecated 使用 supplementAnonymousSpacePostsAI */
export const supplementAnonymousSpaceHiddenAI = supplementAnonymousSpacePostsAI;

/** @deprecated 动态评论改由用户本地保存；角色回评在「补充动态」或聊天记忆里处理 */
export async function generateAnonymousSpacePostReplyAI({
  character,
  user,
  userSpaceProfile = null,
  actorSpaceProfile = null,
  post = {},
  visitorNote = '',
} = {}) {
  await ensureAiReady();
  const actorId = clean(character?.id);
  if (!actorId) throw new Error('角色无效');
  const actorName = getCharacterAiContextName(character, actorId);
  const userProfile = normalizeAnonymousSpaceProfile(userSpaceProfile || {});
  const actorProfile = normalizeAnonymousSpaceProfile(actorSpaceProfile || {});
  const visitorHandle = clean(userProfile.handle) || '匿名网友';
  const chat = buildVirtualAnonSpaceChat(actorId, actorProfile, userProfile);
  const context = await buildRichAnonymousSpaceGenerationContext({
    character,
    user,
    actorId,
    userSpaceProfile: userProfile,
    actorSpaceProfile: actorProfile,
  });
  const note = clean(visitorNote) || '路过留了一句';
  const task = [
    `访客「${visitorHandle}」在你匿名空间的一条动态下回复：${note}`,
    `原动态：${clean(post.text)}`,
    '请以空间主人身份回一条短回复（1-2 句，网友口吻，可冷淡可热络，不要真名）。',
    '只输出 JSON：{"reply":"回复正文"}',
  ].join('\n');
  const { parsed, response } = await requestAnonymousSpaceJson({
    context,
    actorLabel: `角色：${actorName}（actorId=${actorId}）`,
    task,
    temperature: 0.86,
    label: '空间回复',
  });
  const reply = clean(parsed?.reply || parsed?.text || '').slice(0, 200);
  if (!reply) {
    const err = new Error('模型未返回回复，已保留返回原文');
    err.reason = 'json-parse-failed';
    err.rawText = String(response ?? '').trim();
    err.rawResponse = err.rawText;
    throw err;
  }
  return {
    reply,
    from: clean(actorProfile.handle) || actorId,
    fromId: actorId,
  };
}

export async function generateAnonymousSpaceMessagesBatchAI({
  character,
  user,
  userSpaceProfile = null,
  actorSpaceProfile = null,
  count = 4,
} = {}) {
  await ensureAiReady();
  const actorId = clean(character?.id);
  const userProfile = normalizeAnonymousSpaceProfile(userSpaceProfile || {});
  const actorProfile = normalizeAnonymousSpaceProfile(actorSpaceProfile || {});
  const actorName = character ? getCharacterAiContextName(character, actorId) : '空间主人';
  const chat = buildVirtualAnonSpaceChat(actorId || 'user', actorProfile, userProfile);
  const context = buildAnonymousSpaceAiContext({
    chat,
    user,
    characters: character ? { [actorId]: character } : {},
    userSpaceProfile: userProfile,
    actorSpaceProfile: actorProfile,
  });
  const n = Math.max(2, Math.min(8, Number(count || 4) || 4));
  const task = [
    `为这块匿名空间留言板批量生成 ${n} 条路人留言。`,
    '- 每条 1-2 句，像早年空间留言板：寒暄、调侃、共鸣、路过打招呼。',
    '- from 用虚构网名 2-6 字，不要真名。',
    '只输出 JSON 数组：',
    '[{"from":"网友名","text":"留言内容"}]',
  ].join('\n');
  const { parsed } = await requestAnonymousSpaceJson({
    context,
    actorLabel: actorId ? `角色：${actorName}（actorId=${actorId}）` : '用户空间',
    task,
    temperature: 0.9,
    label: '留言板',
  });
  const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.messages) ? parsed.messages : []);
  return parseMessagesFromAi(rows);
}
