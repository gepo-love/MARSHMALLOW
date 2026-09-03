import { chat as apiChat, resolveGenerationMaxTokens } from '../api.js';
import { buildForumAiSystemPrompt } from '../context/build-forum-context.js';
import * as db from '../db.js';
import {
  buildForumPublicAliasBoundary,
  sanitizeGeneratedForumAuthor,
  sanitizeGeneratedForumReplyAuthor,
} from '../forum-identity.js';
import { listForumVests, loadForumProfile } from '../forum-vests.js';
import { ensureDefaultUser } from '../user-slot.js';
import { dateKeyFromTimestamp } from '../character-phone-store.js';
import { getNowForUser } from '../time-mode.js';
import { applyForumGenerationActorPlanBestEffort } from './forum-actors.js';
import { listForumVisibleCharacters } from './forum-character-scope.js';
import { loadForumMetaCompat, saveForumMetaCompat } from './forum-meta-store.js';
import {
  buildForumTopicPlan,
  buildForumTopicPlanPrompt,
  hasFreshForumWeiboMaterial,
} from './forum-topic-plan.js';
import {
  applySocialPostImages,
  buildSocialImageGenPromptRules,
  resolveSocialImageGenMode,
} from '../social-image-generation.js';

export const FORUM_AUTO_CHECK_MS = 10 * 60 * 1000;

export const DEFAULT_FORUM_AUTO = Object.freeze({
  enabled: false,
  intervalHours: 6,
  dailyMaxBatches: 3,
  scope: 'all',
  selectedSectionIds: Object.freeze([]),
  allowStickers: true,
  allowImages: false,
  allowTextImages: false,
  passerbyStickerAvatars: false,
  multiNpcInteraction: true,
  generatePosts: true,
  enrichReplies: true,
  replyGenerationCount: 5,
  newThreadReplyCount: 3,
  threadSort: 'activity',
});

// Name kept explicit for settings consumers that use the longer convention.
export const DEFAULT_FORUM_AUTO_PREFS = DEFAULT_FORUM_AUTO;
export const DEFAULT_FORUM_AUTO_CONFIG = DEFAULT_FORUM_AUTO;

let autoInFlight = false;

function clean(value = '', max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function uniqueIds(value) {
  const rows = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(rows.map((item) => clean(item)).filter(Boolean))];
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function normalizeForumAutoPrefs(raw = {}, sections = []) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const validIds = new Set((Array.isArray(sections) ? sections : []).map((section) => clean(section?.id)).filter(Boolean));
  const selected = uniqueIds(src.selectedSectionIds || src.sectionIds);
  const scope = ['all', 'current', 'selected'].includes(src.scope) ? src.scope : DEFAULT_FORUM_AUTO.scope;
  return {
    enabled: src.enabled === true,
    intervalHours: clampNumber(src.intervalHours ?? src.interval, DEFAULT_FORUM_AUTO.intervalHours, 1, 168),
    dailyMaxBatches: Math.round(clampNumber(
      src.dailyMaxBatches ?? src.dailyMax,
      DEFAULT_FORUM_AUTO.dailyMaxBatches,
      1,
      24,
    )),
    scope,
    selectedSectionIds: validIds.size ? selected.filter((id) => validIds.has(id)) : selected,
    allowStickers: src.allowStickers !== false && src.defaultStickers !== false,
    allowImages: src.allowImages === true,
    allowTextImages: src.allowTextImages === true,
    passerbyStickerAvatars: src.passerbyStickerAvatars === true,
    multiNpcInteraction: src.multiNpcInteraction !== false && src.multiNpc !== false,
    generatePosts: src.generatePosts !== false,
    enrichReplies: src.enrichReplies !== false,
    replyGenerationCount: Math.round(clampNumber(
      src.replyGenerationCount ?? src.replyCount,
      DEFAULT_FORUM_AUTO.replyGenerationCount,
      1,
      12,
    )),
    newThreadReplyCount: Math.round(clampNumber(
      src.newThreadReplyCount,
      DEFAULT_FORUM_AUTO.newThreadReplyCount,
      0,
      8,
    )),
    threadSort: src.threadSort === 'created' ? 'created' : DEFAULT_FORUM_AUTO.threadSort,
  };
}

export const normalizeForumAutoConfig = normalizeForumAutoPrefs;

function stateKey(userId) {
  return `forumAutoState_${clean(userId) || 'guest'}`;
}

async function loadMeta(userId) {
  return loadForumMetaCompat(userId);
}

export async function loadForumAutoPrefs(userId, sections = null) {
  const meta = await loadMeta(userId);
  const sectionRows = Array.isArray(sections) ? sections : (Array.isArray(meta.sections) ? meta.sections : []);
  return normalizeForumAutoPrefs(meta.forumAuto || meta.autoForum || {}, sectionRows);
}

export async function saveForumAutoPrefs(userId, prefs, sections = null) {
  const meta = await loadMeta(userId);
  const sectionRows = Array.isArray(sections) ? sections : (Array.isArray(meta.sections) ? meta.sections : []);
  const forumAuto = normalizeForumAutoPrefs(prefs, sectionRows);
  await saveForumMetaCompat(userId, { ...meta, forumAuto });
  return forumAuto;
}

export const loadForumAutoConfig = loadForumAutoPrefs;
export const saveForumAutoConfig = saveForumAutoPrefs;

async function loadState(userId) {
  const row = await db.get(stateKey(userId)).catch(() => null);
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    dateKey: clean(value.dateKey),
    batches: Number(value.batches) || 0,
    lastRunAt: Number(value.lastRunAt) || 0,
    lastSectionId: clean(value.lastSectionId),
  };
}

async function saveState(userId, state) {
  await db.put('settings', { key: stateKey(userId), value: state });
}

function resolveSections(meta, prefs) {
  const sections = (Array.isArray(meta.sections) ? meta.sections : []).filter((section) => section?.id);
  if (prefs.scope === 'current') {
    return sections.filter((section) => clean(section.id) === clean(meta.activeSectionId));
  }
  if (prefs.scope === 'selected') {
    const selected = new Set(prefs.selectedSectionIds);
    return sections.filter((section) => selected.has(clean(section.id)));
  }
  return sections;
}

export function pickNextForumAutoSection(sections = [], lastSectionId = '') {
  const rows = (Array.isArray(sections) ? sections : []).filter((section) => clean(section?.id));
  if (rows.length <= 1) return rows[0] || null;
  const index = rows.findIndex((section) => clean(section.id) === clean(lastSectionId));
  return rows[(index + 1 + rows.length) % rows.length] || rows[0];
}

function extractJsonObject(raw = '') {
  const text = clean(raw);
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(text ? '论坛自动更新返回了无效 JSON' : '论坛自动更新接口返回为空');
  return JSON.parse(body.slice(start, end + 1));
}

function characterMap(rows = []) {
  return Object.fromEntries(rows.filter((row) => row?.id).map((row) => [row.id, row]));
}

function normalizeGeneratedReplies(rows, timestamp, {
  user = {},
  characters = {},
  forbiddenNames = [],
} = {}) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, 6)
    .map((row) => {
      const identity = sanitizeGeneratedForumReplyAuthor(row, characters, {
        user,
        forbiddenNames,
        strictRoleScope: true,
      });
      return {
        author: clean(identity.author, 60) || '匿名',
        content: clean(row?.content || row?.text, 600),
        timestamp,
        childReplies: [],
        authorSource: identity.authorSource,
        authorRoleId: identity.authorRoleId,
        forumActorId: identity.forumActorId,
        authorPersonality: clean(row?.authorPersonality || row?.authorProfile?.personality, 700),
        authorSpeechStyle: clean(row?.authorSpeechStyle || row?.authorProfile?.speechStyle, 500),
        authorBackground: clean(row?.authorBackground || row?.authorProfile?.background, 600),
        authorInterests: (Array.isArray(row?.authorInterests) ? row.authorInterests : row?.authorProfile?.interests || [])
          .map((value) => clean(value, 40)).filter(Boolean).slice(0, 8),
        replyToFloor: Number(row?.replyToFloor || row?.parentFloor || 0) || 0,
      };
    })
    .filter((row) => row.content);
}

async function listThreads(userId) {
  try {
    return await db.getAllByIndex('forumThreads', 'userId', userId);
  } catch (_) {
    const all = await db.getAllRecords('forumThreads');
    return all.filter((thread) => clean(thread?.userId) === clean(userId));
  }
}

function sectionSummary(section = {}) {
  return [
    `sectionId=${clean(section.id)}`,
    `名称=${clean(section.name || '未命名板块', 80)}`,
    `类型=${clean(section.type || '闲聊', 40)}`,
    clean(section.desc, 500) ? `要求=${clean(section.desc, 500)}` : '',
  ].filter(Boolean).join('；');
}

function replyTargetSummary(thread = {}, user = {}) {
  const privateAlias = !!buildForumPublicAliasBoundary(thread, user);
  return [
    clean(thread.id),
    clean(thread.title, 100),
    `公开作者=${clean(thread.authorName || thread.author, 80) || '匿名'}`,
    privateAlias ? '作者账号本体未知，禁止与用户档案/私聊/记忆绑定' : '',
    `已有${Array.isArray(thread.replies) ? thread.replies.length : 0}回复`,
  ].filter(Boolean).join('｜');
}

async function generateBatch({ user, prefs, sections, threads, characters }) {
  const section = sections[0] || null;
  const scopedCharacters = prefs.multiNpcInteraction
    ? characters.slice(0, 24)
    : characters.slice().sort(() => Math.random() - 0.5).slice(0, 1);
  const recent = threads
    .filter((thread) => sections.some((section) => clean(section.id) === clean(thread.sectionId)))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, 12);
  const topicPlan = buildForumTopicPlan({
    count: prefs.generatePosts ? 2 : 1,
    recentThreads: recent,
    // 混合批次按 authorRoleId 分包；mainline 来源必须由有对应 ownerId 的角色作者承担。
    allowPrivateContext: scopedCharacters.length > 0,
    weiboAvailable: await hasFreshForumWeiboMaterial(user?.id),
    seed: `${user?.id || ''}|${section?.id || ''}|${recent[0]?.id || ''}`,
  });
  const systemPrompt = await buildForumAiSystemPrompt(user, {
    worldBookIds: section?.worldBookIds || section?.worldBookId || [],
    auEntryIds: section?.auEntryIds || section?.auEntryId || [],
    referenceNotes: '后台自动更新论坛。只使用当前档案可见信息，保持角色关系、口吻和时间线一致。',
    section,
    characters: scopedCharacters,
    allowStickers: prefs.allowStickers,
    // 自动更新会混入普通 NPC；不向它提供用户与角色的私有关系上下文。
    passerbyIsolation: true,
  });
  const imageGenMode = prefs.allowImages
    ? await resolveSocialImageGenMode('momentsImages').catch(() => '')
    : '';
  const imageOptions = {
    allowLifePhoto: prefs.allowImages,
    allowPersonPhoto: prefs.allowImages,
    allowTextImage: prefs.allowTextImages,
    allowStickers: prefs.allowStickers,
  };
  const imageRules = buildSocialImageGenPromptRules(imageGenMode, {
    imageOptions,
    surface: 'forum',
  });
  const task = [
    '任务：为论坛做一次后台自动更新。',
    `可用板块：\n${sections.map(sectionSummary).join('\n')}`,
    scopedCharacters.length
      ? `可用角色（角色发言必须使用伪装论坛 ID）：${scopedCharacters.map((row) => `${row.id}=${row.name || row.realName || row.id}`).join('、')}`
      : '没有可用通讯录角色，只能使用普通路人或匿名 NPC。',
    prefs.multiNpcInteraction
      ? '允许多个角色与 NPC 自然互动，但不要强行让所有人同时出现。'
      : '本轮最多使用一个通讯录角色；其他作者与回复者只能是普通 NPC。',
    prefs.allowStickers
      ? '正文和回复可少量使用 [表情包:名称]，放在完整句子末尾。'
      : '不要输出 [表情包:名称]。',
    imageRules,
    prefs.generatePosts
      ? '生成 1-2 条新帖，sectionId 必须来自可用板块；主帖作者不得是用户。新帖必须写新话题/新切口，禁止复述或换皮下方已有帖的同一件具体事；聊天里过期近况不得再当今天主事件。'
      : '不要生成新帖，threads 输出空数组。',
    prefs.generatePosts
      ? `每条新帖的 replies 必须恰好有 ${prefs.newThreadReplyCount} 条。`
      : '',
    prefs.generatePosts ? buildForumTopicPlanPrompt(topicPlan) : '',
    prefs.generatePosts && recent.length
      ? `近期已有帖（新帖禁止同题/换皮）：\n${recent.map((thread) => `${clean(thread.title, 100)}｜${clean(thread.content, 120)}`).join('\n')}`
      : '',
    prefs.enrichReplies && recent.length
      ? `可给以下旧帖各补恰好 ${prefs.replyGenerationCount} 条新回复；只使用列出的 threadId：\n${recent.map((thread) => replyTargetSummary(thread, user)).join('\n')}`
      : '不要补旧帖回复，replyUpdates 输出空数组。',
    prefs.enrichReplies && recent.some((thread) => buildForumPublicAliasBoundary(thread, user))
      ? '【公开账号隔离】标注“作者账号本体未知”的旧帖只能按公开标题、作者昵称与已有楼层互动；不得使用用户卡、用户私聊、私人记忆、论坛关系进度或文风相似度把作者认作用户，也不得写“我知道是你/你的小号”。'
      : '',
    '所有新帖及楼层都禁止代替当前用户发言；authorName/author/authorRoleId/forumActorId 不得写 user、当前用户 id、当前用户显示名或用户论坛马甲名。',
    '路人新旧比例遵守上文路人池规则。复用旧路人必须填写池中 forumActorId；新路人必须留空 forumActorId，并填写 authorPersonality、authorSpeechStyle、authorBackground、authorInterests。',
    '只输出合法 JSON 对象，不要解释：',
    '{"threads":[{"sectionId":"板块id","title":"标题","content":"正文","authorName":"伪装ID","authorRoleId":"可空角色id","forumActorId":"复用常驻路人时填写","authorPersonality":"新路人才填","authorSpeechStyle":"新路人才填","authorBackground":"新路人才填","authorInterests":["新路人才填"],"authorAlias":"伪装ID","wantsImage":false,"imagePrompt":"英文画面描述，无图留空","imageCharacterId":"图中角色id，无则none","textImageCaption":"生图失败时的中文画面描述","replies":[{"author":"伪装ID","authorRoleId":"可空角色id","forumActorId":"复用常驻路人时填写","authorPersonality":"新路人才填","authorSpeechStyle":"新路人才填","authorBackground":"新路人才填","authorInterests":["新路人才填"],"replyToFloor":0,"content":"回复"}]}],"replyUpdates":[{"threadId":"旧帖id","replies":[{"author":"伪装ID","authorRoleId":"可空角色id","forumActorId":"复用常驻路人时填写","authorPersonality":"新路人才填","authorSpeechStyle":"新路人才填","authorBackground":"新路人才填","authorInterests":["新路人才填"],"replyToFloor":0,"content":"新增回复"}]}]}',
  ].filter(Boolean).join('\n\n');
  const maxTokens = await resolveGenerationMaxTokens();
  const raw = await apiChat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ], { temperature: 0.9, maxTokens });
  const parsed = extractJsonObject(raw);
  if (Array.isArray(parsed?.threads) && parsed.threads.length) {
    parsed.threads = await applySocialPostImages(parsed.threads, {
      scene: 'momentsImages',
      imageField: 'images',
      maxImages: 2,
      imageOptions,
    });
  }
  return {
    parsed,
    scopedCharacters,
    topicPlan,
  };
}

async function storeBatch({
  user,
  userId,
  prefs,
  sections,
  threads,
  characters,
  parsed,
  topicPlan = [],
  virtualNow,
  forbiddenNames = [],
}) {
  const sectionIds = new Set(sections.map((section) => clean(section.id)));
  const charactersById = characterMap(characters);
  let posts = 0;
  let replies = 0;
  const actorRoots = [];
  const actorRecords = [];

  if (prefs.generatePosts) {
    const generatedThreads = Array.isArray(parsed?.threads) ? parsed.threads.slice(0, 2) : [];
    for (const [index, raw] of generatedThreads.entries()) {
      const sectionId = clean(raw?.sectionId);
      const content = clean(raw?.content || raw?.body, 4000);
      const hasTextImage = raw?.imageKind === 'textimg' && !!clean(raw?.textImage || raw?.textImageCaption);
      if (!sectionIds.has(sectionId) || (!content && !hasTextImage)) continue;
      const author = sanitizeGeneratedForumAuthor(raw, charactersById, { user, userId, forbiddenNames });
      const authorRoleId = charactersById[author.authorRoleId] ? author.authorRoleId : '';
      const timestamp = virtualNow - index * 60_000;
      const storedThread = {
        id: `forum_auto_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        userId,
        sectionId,
        title: clean(raw?.title || raw?.subject, 120) || '无标题',
        content,
        images: Array.isArray(raw?.images) ? raw.images.filter(Boolean).slice(0, 2) : [],
        imagePrompt: clean(raw?.imagePrompt, 2000),
        imageCharacterId: clean(raw?.imageCharacterId, 180),
        textImage: clean(raw?.textImage || raw?.textImageCaption, 1200),
        textImageCaption: clean(raw?.textImageCaption || raw?.textImage, 1200),
        imageKind: Array.isArray(raw?.images) && raw.images.some(Boolean)
          ? 'photo'
          : (raw?.imageKind === 'textimg' && clean(raw?.textImage || raw?.textImageCaption) ? 'textimg' : ''),
        authorName: author.authorName,
        authorId: authorRoleId,
        authorRoleId,
        authorAlias: author.authorAlias,
        forumActorId: clean(raw?.forumActorId, 180),
        authorPersonality: clean(raw?.authorPersonality || raw?.authorProfile?.personality, 700),
        authorSpeechStyle: clean(raw?.authorSpeechStyle || raw?.authorProfile?.speechStyle, 500),
        authorBackground: clean(raw?.authorBackground || raw?.authorProfile?.background, 600),
        authorInterests: (Array.isArray(raw?.authorInterests) ? raw.authorInterests : raw?.authorProfile?.interests || [])
          .map((value) => clean(value, 40)).filter(Boolean).slice(0, 8),
        authorSource: 'generated',
        topicSource: clean(topicPlan[index]) || 'section',
        timestamp,
        replies: normalizeGeneratedReplies(raw?.replies || raw?.comments, timestamp, {
          user,
          characters: charactersById,
          forbiddenNames: [userId, ...forbiddenNames],
        }).slice(0, prefs.newThreadReplyCount),
      };
      await db.put('forumThreads', storedThread);
      actorRoots.push(storedThread);
      actorRecords.push(storedThread);
      posts += 1;
    }
  }

  if (prefs.enrichReplies) {
    const byId = new Map(threads.map((thread) => [clean(thread.id), thread]));
    for (const update of (Array.isArray(parsed?.replyUpdates) ? parsed.replyUpdates.slice(0, 4) : [])) {
      const thread = byId.get(clean(update?.threadId));
      if (!thread || !sectionIds.has(clean(thread.sectionId))) continue;
      const additions = normalizeGeneratedReplies(update?.replies, virtualNow, {
        user,
        characters: charactersById,
        forbiddenNames: [userId, ...forbiddenNames],
      }).slice(0, prefs.replyGenerationCount);
      if (!additions.length) continue;
      const storedThread = {
        ...thread,
        replies: [...(Array.isArray(thread.replies) ? thread.replies : []), ...additions],
      };
      await db.put('forumThreads', storedThread);
      actorRoots.push(...additions);
      actorRecords.push(storedThread);
      replies += additions.length;
    }
  }
  return { posts, replies, stored: posts + replies, actorRoots, actorRecords };
}

export async function runForumAutoCheck(reason = 'timer', suppliedUser = null) {
  if (autoInFlight) return { ok: false, reason: 'in-flight' };
  autoInFlight = true;
  try {
    const user = suppliedUser || await ensureDefaultUser();
    const userId = clean(user?.id);
    if (!userId) return { ok: false, reason: 'missing-user' };
    const meta = await loadMeta(userId);
    const prefs = normalizeForumAutoPrefs(meta.forumAuto || meta.autoForum || {}, meta.sections || []);
    if (!prefs.enabled) return { ok: false, reason: 'disabled' };
    if (!prefs.generatePosts && !prefs.enrichReplies) return { ok: false, reason: 'no-actions' };
    const availableSections = resolveSections(meta, prefs);
    if (!availableSections.length) return { ok: false, reason: 'no-sections' };

    const now = Date.now();
    const virtualNow = await getNowForUser(userId).catch(() => now);
    const today = dateKeyFromTimestamp(virtualNow);
    const state = await loadState(userId);
    const batchesToday = state.dateKey === today ? state.batches : 0;
    if (now - state.lastRunAt < prefs.intervalHours * 3600_000) {
      return { ok: false, reason: 'interval-not-due' };
    }
    if (batchesToday >= prefs.dailyMaxBatches) return { ok: false, reason: 'daily-cap' };

    const section = pickNextForumAutoSection(availableSections, state.lastSectionId);
    const sections = section ? [section] : [];
    const [threads, characters, vests, profile] = await Promise.all([
      listThreads(userId),
      listForumVisibleCharacters(user, { excludeAnonNpc: true }).catch(() => []),
      listForumVests(userId).catch(() => []),
      loadForumProfile(userId, user).catch(() => null),
    ]);
    const generated = await generateBatch({ user, prefs, sections, threads, characters });
    const storedResult = await storeBatch({
      user,
      userId,
      prefs,
      sections,
      threads,
      characters: generated.scopedCharacters,
      parsed: generated.parsed,
      topicPlan: generated.topicPlan,
      virtualNow,
      forbiddenNames: [
        profile?.displayName,
        ...(vests || []).map((vest) => vest.displayId),
      ].filter(Boolean),
    });
    const {
      actorRoots = [],
      actorRecords = [],
      ...result
    } = storedResult;
    await saveState(userId, {
      dateKey: today,
      batches: batchesToday + (result.stored ? 1 : 0),
      lastRunAt: now,
      lastSectionId: clean(section?.id),
    });
    if (result.stored && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('forum-auto-generated', {
        detail: { ...result, source: 'scheduled', reason },
      }));
    }
    if (result.stored && actorRoots.length) {
      void applyForumGenerationActorPlanBestEffort({
        userId,
        user,
        forbiddenNames: [profile?.displayName, ...(vests || []).map((vest) => vest.displayId)].filter(Boolean),
        roots: actorRoots,
        knownCharacterIds: generated.scopedCharacters.map((character) => character.id),
      }).then((actorPlan) => {
        if (!actorPlan.ok) {
          console.warn('[forum-auto] 身份整理未完成，正文已正常保存', actorPlan.error || 'timeout');
          return;
        }
        for (const record of actorRecords) void db.put('forumThreads', record).catch(() => {});
      }).catch((error) => console.warn('[forum-auto] 身份整理异常，正文已正常保存', error));
    }
    return { ok: true, reason, ...result };
  } catch (err) {
    console.warn('[forum-auto] automatic update failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    autoInFlight = false;
  }
}
