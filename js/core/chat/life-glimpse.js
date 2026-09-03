import * as db from '../db.js';
import { createMessage } from '../../models/chat.js';
import { getUnansweredRealUserMessage } from './marshmallow-presence.js';
import { chatJsonGeneration } from '../chat-json-generation.js';
import { resolveGenerationMaxTokens } from '../api.js';
import { resolveSceneApiConfig } from '../api-presets.js';
import { stripLeakedReasoning } from '../narration-sanitize.js';
import { getZonedDateParts } from '../user-timezone.js';

export const LIFE_GLIMPSE_SCHEMA_VERSION = 2;
export const LIFE_GLIMPSE_SETTINGS_UPDATED_EVENT = 'marshmallow-life-glimpse-settings-updated';
export const LIFE_GLIMPSE_STORY_KIND = 'life_glimpse';
export const LIFE_GLIMPSE_LOCAL_COST_CLASS = 'zero_api';
export const LIFE_GLIMPSE_AI_COST_CLASS = 'one_api';
export const LIFE_GLIMPSE_WAIT_DELAY_MS = 90 * 1000;

const LIFE_GLIMPSE_WAIT_REASONS = new Set([
  'busy-waiting',
  'manual-busy',
  'manual-offline',
  'schedule-busy',
  'soft-offline',
  'soft-offline-waiting',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '', max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function identity(value = '') {
  return String(value ?? '').trim();
}

function positiveTimestamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function lifeGlimpseTimePeriod(hour = 0) {
  const value = Math.max(0, Math.min(23, Math.trunc(Number(hour) || 0)));
  if (value < 5) return '凌晨';
  if (value < 9) return '早晨';
  if (value < 12) return '上午';
  if (value < 14) return '中午';
  if (value < 18) return '下午';
  if (value < 21) return '傍晚/晚间';
  return '深夜';
}

/**
 * 生活侧面是会进入时间线的已发生事实，因此把语义发生时刻按角色
 * 时区换算后放在最后一条生成任务里，不依赖模型从长上下文里找时钟。
 */
export function buildLifeGlimpseTimeAnchor(occurredAt = 0, timeZone = '') {
  const timestamp = positiveTimestamp(occurredAt);
  if (!timestamp) return '';
  const parts = getZonedDateParts(timestamp, timeZone);
  const clock = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  const period = lifeGlimpseTimePeriod(parts.hour);
  const zone = clean(timeZone, 80) || '跟随用户世界时区';
  return [
    `【角色当地时间 · 硬性】${parts.year}年${parts.month}月${parts.day}日 ${clock}（${period}；${zone}）。`,
    `本片段就发生在这个当地时刻；钟点、天色、用餐、作息和“刚刚/快要”等时间语义必须与「${period}」一致，禁止跳到与上述钟点不符的其他时段（例如把早晨写成凌晨，或把深夜写成白天）。人物可以因夜班、通宵等设定在该时刻做非典型活动，但不得改写当地钟点。`,
  ].join('\n');
}

function encodedIdPart(value = '', fallback = 'unknown') {
  return encodeURIComponent(clean(value, 240) || fallback);
}

export function lifeGlimpseSettingsKey(userId = '', characterId = '') {
  return `lifeGlimpseSettings:v${LIFE_GLIMPSE_SCHEMA_VERSION}:${encodedIdPart(userId, 'guest')}:${encodedIdPart(characterId)}`;
}

export function normalizeLifeGlimpseSettings(raw = {}) {
  const source = asObject(raw);
  return {
    schemaVersion: LIFE_GLIMPSE_SCHEMA_VERSION,
    enabled: source.enabled === true,
    // 正式生活侧面是一轮独立生成。local card 仅保留给旧档/显式降级，不能冒充正文。
    localCardsEnabled: source.localCardsEnabled === true,
    aiStoryCardsEnabled: source.aiStoryCardsEnabled !== false,
    notifyOnCard: source.notifyOnCard === true,
    updatedAt: positiveTimestamp(source.updatedAt),
  };
}

export function isLifeGlimpseWaitReason(reason = '') {
  return LIFE_GLIMPSE_WAIT_REASONS.has(clean(reason, 40));
}

/**
 * 生活侧面只说明「TA 此刻确实没在回消息时，正在做什么」。待办到点后必须
 * 再看一遍 Current Context；如果角色已经在线、日程已经不忙，旧等待票不能补卡。
 */
export function resolveLifeGlimpseWaitEvidence(currentContext = {}, options = {}) {
  const context = asObject(currentContext);
  if (context.activeOffline) return null;
  const presenceState = clean(context.publicStatus?.presenceState, 20).toLowerCase();
  if (['away', 'busy', 'offline'].includes(presenceState)) {
    return { kind: 'presence', value: presenceState };
  }
  const effectiveSource = resolvedSource(context.effective?.source);
  if (
    effectiveSource === 'schedule'
    && (context.schedule?.isSleep === true || context.schedule?.busy === true)
  ) {
    return {
      kind: context.schedule?.isSleep === true ? 'sleep' : 'schedule',
      value: clean(context.schedule?.activity || context.effective?.activity, 120),
    };
  }
  if (
    effectiveSource === 'runtime'
    && typeof options.isBusyLikeStatusText === 'function'
    && options.isBusyLikeStatusText(context.effective?.activity || context.runtime?.activity)
  ) {
    return { kind: 'runtime', value: clean(context.effective?.activity, 120) };
  }
  return null;
}

export async function loadLifeGlimpseSettings(userId = '', characterId = '') {
  if (!clean(userId, 120) || !clean(characterId, 120)) return normalizeLifeGlimpseSettings();
  const key = lifeGlimpseSettingsKey(userId, characterId);
  // 存储读取失败不能降级成默认关闭；执行器需要把它保留为 retryable，避免
  // 一次 IndexedDB / native cache 瞬态故障永久吃掉已经排好的等待票。
  const row = await db.get('settings', key);
  if (row?.value) return normalizeLifeGlimpseSettings(row.value);
  // v1 曾把生活侧面保存成零 API 摘要卡。只迁移用户是否开启，不继承旧执行模式。
  const legacyKey = `lifeGlimpseSettings:v1:${encodedIdPart(userId, 'guest')}:${encodedIdPart(characterId)}`;
  const legacy = await db.get('settings', legacyKey);
  if (legacy?.value?.enabled !== true) return normalizeLifeGlimpseSettings();
  return normalizeLifeGlimpseSettings({
    enabled: true,
    aiStoryCardsEnabled: true,
    localCardsEnabled: false,
    notifyOnCard: legacy.value.notifyOnCard === true,
  });
}

export async function saveLifeGlimpseSettings(userId = '', characterId = '', patch = {}) {
  if (!clean(userId, 120) || !clean(characterId, 120)) {
    throw new Error('life glimpse settings require userId and characterId');
  }
  const key = lifeGlimpseSettingsKey(userId, characterId);
  const saved = await db.updateRecord('settings', key, (current) => ({
    key,
    value: normalizeLifeGlimpseSettings({
      ...asObject(current?.value),
      ...asObject(patch),
      updatedAt: Date.now(),
    }),
  }));
  const settings = normalizeLifeGlimpseSettings(saved.record?.value);
  try {
    globalThis.window?.dispatchEvent?.(new CustomEvent(LIFE_GLIMPSE_SETTINGS_UPDATED_EVENT, {
      detail: {
        userId: clean(userId, 120),
        characterId: clean(characterId, 120),
        settings,
      },
    }));
  } catch (_) { /* 设置已保存；旧 WebView 没有 CustomEvent 时由下次读取兜底。 */ }
  return settings;
}

function factToken(parts = []) {
  return parts.map((part) => encodedIdPart(part, '-')).join(':');
}

function resolvedSource(value = '') {
  const source = clean(value, 32).toLowerCase();
  if (source === 'scene' || source === 'scene_fact') return 'scene_fact';
  if (source === 'runtime') return 'runtime';
  if (source === 'schedule') return 'schedule';
  if (source === 'offline') return 'offline';
  return 'none';
}

function matchesEffectiveActivity(context = {}, activity = '') {
  const effectiveActivity = clean(context?.effective?.activity, 120);
  return !!effectiveActivity && effectiveActivity === clean(activity, 120);
}

/**
 * 只把已经由 Current Context 仲裁为当前有效的事实变成素材。公开状态短句本身
 * 不是线下活动证据；activeOffline 又代表用户可能正在场，因此两者都不生成卡。
 */
export function resolveLocalLifeGlimpseFact(currentContext = {}, options = {}) {
  const context = asObject(currentContext);
  const source = resolvedSource(context.effective?.source);
  const characterId = clean(options.characterId, 120);
  const occurredAt = positiveTimestamp(options.occurredAt, positiveTimestamp(options.now));
  const occurredAtClockDomain = ['world', 'story', 'wall'].includes(
    clean(options.occurredAtClockDomain, 16),
  )
    ? clean(options.occurredAtClockDomain, 16)
    : 'world';
  const effectiveExpiresAt = positiveTimestamp(context.effective?.expiresAt);
  // 生活侧面进入聊天时间线后就是可见事实。缺少语义时间时不能拿 Date.now()
  // 冒充 world clock；已经过期的 scene/runtime 快照也不能被晚到执行器重新展示。
  if (!occurredAt || (effectiveExpiresAt && effectiveExpiresAt <= occurredAt)) return null;
  if (source === 'offline' || source === 'none') return null;

  if (source === 'scene_fact') {
    const scene = asObject(context.sceneFact);
    const activity = clean(scene.activity, 120);
    const updatedAt = positiveTimestamp(scene.updatedAt);
    const sourceRoundId = clean(scene.sourceRoundId, 120);
    if (!activity || !matchesEffectiveActivity(context, activity) || (!updatedAt && !sourceRoundId)) return null;
    return {
      source,
      activity,
      place: clean(scene.place, 100),
      occurredAt,
      occurredAtClockDomain,
      sourceFactIds: [
        `scene:${factToken([characterId, sourceRoundId || updatedAt, activity, scene.place])}`,
      ],
      sourceRevision: sourceRoundId || String(updatedAt),
    };
  }

  if (source === 'runtime') {
    const runtime = asObject(context.runtime);
    const activity = clean(runtime.activity, 120);
    const updatedAt = positiveTimestamp(runtime.updatedAt);
    if (!activity || !matchesEffectiveActivity(context, activity) || !updatedAt) return null;
    return {
      source,
      activity,
      place: '',
      occurredAt,
      occurredAtClockDomain,
      sourceFactIds: [`runtime:${factToken([characterId, updatedAt, activity])}`],
      sourceRevision: String(updatedAt),
    };
  }

  const schedule = asObject(context.schedule);
  const activity = clean(schedule.activity, 120);
  const timeRange = clean(schedule.timeRange, 32);
  const planRevision = Math.max(0, Math.trunc(Number(schedule.planRevision) || 0));
  const planDate = clean(options.planDate, 32);
  // Current Context 只有命中当天有效 block 才会给 schedule；旧计划可能还没有 revision，
  // 此时用日期 + 时间段 + 活动组成可追溯的 legacy fact id，而不是丢弃真实旧数据。
  if (!activity
    || !matchesEffectiveActivity(context, activity)
    || (!planRevision && !planDate && !timeRange)) return null;
  return {
    source: 'schedule',
    activity,
    place: clean(schedule.place, 100),
    occurredAt,
    occurredAtClockDomain,
    sourceFactIds: [
      `schedule:${factToken([
        characterId,
        planDate || 'current-day',
        planRevision || 'legacy',
        timeRange,
        schedule.currentStep?.at,
        activity,
      ])}`,
    ],
    sourceRevision: planRevision ? String(planRevision) : 'legacy',
    schedulePlanRevision: planRevision,
  };
}

/**
 * AI 生活侧面可以描写「顶栏已离线，但角色实际仍在过自己的生活」。因此在有效
 * public status 之外，允许回看同一份 fresh Current Context 里的日程/runtime/scene
 * 作为叙事锚点；仍要求可追溯 revision，绝不凭空造一张本地事实卡。
 */
export function resolveAiLifeGlimpseFact(currentContext = {}, options = {}) {
  const strict = resolveLocalLifeGlimpseFact(currentContext, options);
  if (strict) return strict;
  const context = asObject(currentContext);
  const characterId = clean(options.characterId, 120);
  const occurredAt = positiveTimestamp(options.occurredAt, positiveTimestamp(options.now));
  if (!characterId || !occurredAt) return null;
  const schedule = asObject(context.schedule);
  const activity = clean(schedule.activity, 120);
  const timeRange = clean(schedule.timeRange, 32);
  const planRevision = Math.max(0, Math.trunc(Number(schedule.planRevision) || 0));
  const planDate = clean(options.planDate, 32);
  if (activity && (planRevision || planDate || timeRange)) {
    return {
      source: 'schedule',
      activity,
      place: clean(schedule.place, 100),
      occurredAt,
      occurredAtClockDomain: 'world',
      sourceFactIds: [`schedule:${factToken([
        characterId,
        planDate || 'current-day',
        planRevision || 'legacy',
        timeRange,
        schedule.currentStep?.at,
        activity,
      ])}`],
      sourceRevision: planRevision ? String(planRevision) : 'legacy',
      schedulePlanRevision: planRevision,
    };
  }
  const runtime = asObject(context.runtime);
  const runtimeActivity = clean(runtime.activity, 120);
  const runtimeUpdatedAt = positiveTimestamp(runtime.updatedAt);
  if (runtimeActivity && runtimeUpdatedAt) {
    return {
      source: 'runtime',
      activity: runtimeActivity,
      place: '',
      occurredAt,
      occurredAtClockDomain: 'world',
      sourceFactIds: [`runtime:${factToken([characterId, runtimeUpdatedAt, runtimeActivity])}`],
      sourceRevision: String(runtimeUpdatedAt),
    };
  }
  const scene = asObject(context.sceneFact);
  const sceneActivity = clean(scene.activity, 120);
  const sceneUpdatedAt = positiveTimestamp(scene.updatedAt);
  const sourceRoundId = clean(scene.sourceRoundId, 120);
  if (sceneActivity && (sceneUpdatedAt || sourceRoundId)) {
    return {
      source: 'scene_fact',
      activity: sceneActivity,
      place: clean(scene.place, 100),
      occurredAt,
      occurredAtClockDomain: 'world',
      sourceFactIds: [`scene:${factToken([
        characterId,
        sourceRoundId || sceneUpdatedAt,
        sceneActivity,
        scene.place,
      ])}`],
      sourceRevision: sourceRoundId || String(sceneUpdatedAt),
    };
  }
  return null;
}

export function lifeGlimpseEpisodeId({
  chatId = '',
  characterId = '',
  relatedUserMessageId = '',
} = {}) {
  const cid = String(chatId || '').trim();
  const actorId = String(characterId || '').trim();
  const messageId = String(relatedUserMessageId || '').trim();
  return cid && actorId && messageId
    ? `waiting:${encodeURIComponent(cid)}:${encodeURIComponent(actorId)}:${encodeURIComponent(messageId)}`
    : '';
}

export function scheduledLifeGlimpseEpisodeId({
  chatId = '',
  characterId = '',
  slotKey = '',
} = {}) {
  const cid = identity(chatId);
  const actorId = identity(characterId);
  const scheduleSlot = identity(slotKey);
  return cid && actorId && scheduleSlot
    ? `schedule:${encodeURIComponent(cid)}:${encodeURIComponent(actorId)}:${encodeURIComponent(scheduleSlot)}`
    : '';
}

export function lifeGlimpseMessageId(chatId = '', episodeId = '') {
  const cid = String(chatId || '').trim();
  const eid = String(episodeId || '').trim();
  if (!cid || !eid) return '';
  // 使用完整 URI 编码而非短 hash；不对身份组件做截断。
  return `life_glimpse:${encodeURIComponent(cid)}:${encodeURIComponent(eid)}`;
}

export function formatLocalLifeGlimpseSummary(fact = {}) {
  const activity = clean(fact.activity, 120);
  const place = clean(fact.place, 100);
  return [place, activity].filter(Boolean).join(' · ');
}

/**
 * 只组装本地卡，不落库、不排通知、不改聊天摘要。调用方必须给出等待 episode，
 * 防止普通状态刷新也在时间线里不断冒卡。
 */
export function buildLocalLifeGlimpse(input = {}) {
  const settings = normalizeLifeGlimpseSettings(input.settings);
  if (!settings.enabled || !settings.localCardsEnabled) {
    return { ok: false, reason: 'disabled', card: null, fact: null };
  }
  const chatId = identity(input.chatId);
  const characterId = identity(input.characterId);
  const relatedUserMessageId = identity(input.relatedUserMessageId);
  const episodeId = identity(input.episodeId)
    || lifeGlimpseEpisodeId({ chatId, characterId, relatedUserMessageId });
  if (!chatId || !characterId || !episodeId) {
    return { ok: false, reason: 'missing-scope', card: null, fact: null };
  }
  const observedAt = positiveTimestamp(input.observedAt, Date.now());
  const occurredAt = positiveTimestamp(input.occurredAt, positiveTimestamp(input.now));
  if (!occurredAt) {
    return { ok: false, reason: 'missing-semantic-time', card: null, fact: null };
  }
  const fact = resolveLocalLifeGlimpseFact(input.currentContext, {
    characterId,
    planDate: input.planDate,
    occurredAt,
    now: input.now,
    occurredAtClockDomain: input.occurredAtClockDomain,
  });
  if (!fact?.sourceFactIds?.length) {
    return { ok: false, reason: 'no-trusted-fact', card: null, fact: null };
  }
  const messageId = lifeGlimpseMessageId(chatId, episodeId);
  const characterName = clean(input.characterName, 40);
  const summary = formatLocalLifeGlimpseSummary(fact);
  const replyDeferredUntil = positiveTimestamp(input.replyDeferredUntil);
  const replyDeferredUntilClockDomain = ['world', 'story', 'wall', 'pacing'].includes(
    clean(input.replyDeferredUntilClockDomain, 16),
  )
    ? clean(input.replyDeferredUntilClockDomain, 16)
    : 'world';
  const card = createMessage({
    id: messageId,
    chatId,
    senderId: 'system',
    senderName: '系统',
    type: 'storyCard',
    content: summary,
    timestamp: fact.occurredAt,
    metadata: {
      artifactKind: LIFE_GLIMPSE_STORY_KIND,
      storyKind: LIFE_GLIMPSE_STORY_KIND,
      lifeGlimpse: true,
      compactOnly: true,
      readOnly: true,
      title: characterName ? `${characterName}的这一刻` : '这一刻',
      badge: '生活侧面',
      summary,
      activity: fact.activity,
      place: fact.place,
      characterId,
      episodeId,
      occurredAt: fact.occurredAt,
      occurredAtClockDomain: fact.occurredAtClockDomain,
      observedAt,
      observedAtClockDomain: 'wall',
      sourceFactIds: [...fact.sourceFactIds],
      sourceFactKind: fact.source,
      sourceRevision: fact.sourceRevision,
      schedulePlanRevision: Math.max(0, Number(fact.schedulePlanRevision) || 0),
      relatedUserMessageId,
      replyDeferredUntil,
      replyDeferredUntilClockDomain,
      conversationMutating: false,
      countsAsReply: false,
      countsAsProactiveMessage: false,
      consumesProactiveSlot: false,
      mutatesChatPreview: false,
      unreadPolicy: 'none',
      notificationPolicy: settings.notifyOnCard ? 'life_glimpse_only' : 'none',
      generationMode: 'local_fact',
      costClass: LIFE_GLIMPSE_LOCAL_COST_CLASS,
      apiRequestCount: 0,
      generationStatus: 'complete',
      createdAtReal: observedAt,
    },
  });
  return { ok: true, reason: '', card, fact };
}

/**
 * messages 主键按 episode 固定，跨窗口重复执行只会看到同一张卡。这里故意不走
 * saveMessage/updateChatPreview/bumpChatUnread：卡片是生活产物，不是一次会话回复。
 */
export async function persistLocalLifeGlimpse(input = {}) {
  const userId = identity(input.userId);
  const chatId = identity(input.chatId);
  const characterId = identity(input.characterId);
  const relatedUserMessageId = identity(input.relatedUserMessageId);
  if (!userId || !chatId || !characterId || !relatedUserMessageId) {
    return {
      ok: false,
      reason: 'missing-persist-scope',
      card: null,
      fact: null,
      created: false,
      deduped: false,
    };
  }
  // 落库边界永远 fresh 读取真实开关与会话范围。纯函数 build 可以接测试配置，
  // 但执行器不能靠 options.settings 绕过用户刚关闭的角色级选择。
  const [chat, settings, threadMessages] = await Promise.all([
    db.getRecord('chats', chatId),
    loadLifeGlimpseSettings(userId, characterId),
    db.getAllByIndex('messages', 'chatId', chatId),
  ]);
  const participants = Array.isArray(chat?.participants) ? chat.participants.map(String) : [];
  if (
    !chat
    || identity(chat.userId) !== userId
    || !participants.includes('user')
    || !participants.includes(characterId)
  ) {
    return {
      ok: false,
      reason: 'scope-mismatch',
      card: null,
      fact: null,
      created: false,
      deduped: false,
    };
  }
  const unanswered = getUnansweredRealUserMessage(threadMessages);
  const expectedAnchorTimestamp = positiveTimestamp(input.relatedUserMessageTimestamp);
  if (
    identity(unanswered?.id) !== relatedUserMessageId
    || (expectedAnchorTimestamp && positiveTimestamp(unanswered?.timestamp) !== expectedAnchorTimestamp)
  ) {
    return {
      ok: false,
      reason: 'related-message-not-unanswered',
      card: null,
      fact: null,
      created: false,
      deduped: false,
    };
  }
  const built = buildLocalLifeGlimpse({ ...input, settings });
  if (!built.ok) return { ...built, created: false, deduped: false };

  // 这里是“落卡前最后一次 fresh unanswered 校验”，但当前并非 chats/messages/
  // settings 的跨索引单事务 CAS：真实回复仍可能在校验后、put 前极窄窗口落库。
  // 卡本身不算回复且主键按 episode 幂等，因此允许这条可见竞态；后续统一 LifeTask
  // 交付闸门再收敛为原子 guard，不在这里声称严格原子。
  const persisted = await db.updateRecord('messages', built.card.id, (current) => {
    if (current) return null;
    return built.card;
  });
  const record = persisted.record || built.card;
  const sameEpisode = record?.metadata?.lifeGlimpse === true
    && identity(record.chatId) === identity(built.card.chatId)
    && identity(record.metadata.characterId) === characterId
    && identity(record.metadata.episodeId) === identity(built.card.metadata.episodeId);
  return {
    ...built,
    ok: persisted.updated === true || sameEpisode,
    reason: persisted.updated === true || sameEpisode ? '' : 'message-id-conflict',
    card: record,
    created: persisted.updated === true,
    deduped: persisted.updated !== true && sameEpisode,
  };
}

function cleanParagraph(value = '', max = 900) {
  return stripLeakedReasoning(String(value || '').trim()).replace(/\n{3,}/g, '\n\n').slice(0, max);
}

export function normalizeAiLifeGlimpseStory(raw = {}) {
  const source = asObject(raw);
  const paragraphs = (Array.isArray(source.paragraphs) ? source.paragraphs : [])
    .map((value) => cleanParagraph(value, 900))
    .filter(Boolean)
    .slice(0, 5);
  const fullText = paragraphs.join('\n\n');
  // 提示目标是 300—600 字；解析只设较低容错线，短少时明确保留这一轮结果，
  // 不因几十字偏差自动追加第二次计费请求。
  if (fullText.length < 160) return null;
  const presenceState = ['online', 'away', 'busy', 'offline']
    .includes(clean(source.statusSuggestion?.presenceState, 20).toLowerCase())
    ? clean(source.statusSuggestion.presenceState, 20).toLowerCase()
    : '';
  return {
    title: cleanParagraph(source.title, 60) || '生活侧面',
    summary: cleanParagraph(source.summary, 120)
      || fullText.replace(/\s+/g, ' ').slice(0, 100),
    paragraphs,
    fullText,
    digest: cleanParagraph(source.digest, 320)
      || fullText.replace(/\s+/g, ' ').slice(0, 260),
    activity: cleanParagraph(source.activity, 120),
    place: cleanParagraph(source.place, 100),
    phoneAwareness: ['unaware', 'not_seen', 'seen_no_reply', 'unknown']
      .includes(clean(source.phoneAwareness, 24))
      ? clean(source.phoneAwareness, 24)
      : 'unknown',
    statusSuggestion: {
      presenceState,
      statusText: cleanParagraph(source.statusSuggestion?.statusText, 40),
    },
  };
}

export function buildLifeGlimpseContinuityBlock(messages = [], characterId = '', limit = 3) {
  const actorId = identity(characterId);
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((message) => (
      !message?.deleted
      && !message?.recalled
      && message?.metadata?.storyKind === LIFE_GLIMPSE_STORY_KIND
      && (!actorId || identity(message.metadata?.characterId) === actorId)
      && message?.metadata?.generationStatus === 'complete'
    ))
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0))
    .slice(-Math.max(1, Math.min(5, Number(limit) || 3)));
  if (!rows.length) return '';
  return [
    '【角色已经历的生活侧面 · 连续性事实】',
    ...rows.map((message) => {
      const md = message.metadata || {};
      const text = cleanParagraph(md.digest || md.summary || md.fullText || message.content, 520);
      return `- ${cleanParagraph(md.title, 60) || '片段'}：${text}`;
    }),
    '这些是角色本人已经经历的线下事件，可延续其情绪、动作与未完事项；用户只是看见了叙事卡，不等于角色曾向用户讲述，也不等于角色知道用户看见了。',
  ].join('\n');
}

export async function generateAiLifeGlimpse(input = {}) {
  const chat = input.chat;
  const user = input.user;
  const character = input.character;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const fact = input.fact;
  if (!chat || !user || !character || !fact?.sourceFactIds?.length) {
    return { ok: false, reason: 'missing-generation-context', story: null };
  }
  let timeZone = clean(input.currentContext?.timeZone, 80);
  if (!timeZone) {
    const { resolveCharacterScheduleTimezone } = await import('./chat-timezone.js');
    timeZone = await resolveCharacterScheduleTimezone(
      input.userId,
      character.id,
      character,
    ).catch(() => '');
  }
  if (!timeZone) {
    const { getUserTimezone } = await import('../time-mode.js');
    timeZone = await getUserTimezone(input.userId).catch(() => '');
  }
  const timeAnchor = buildLifeGlimpseTimeAnchor(fact.occurredAt, timeZone);
  const { buildChatContext } = await import('../context/build-chat-context.js');
  const built = await buildChatContext({
    chat,
    chatId: chat.id,
    user,
    userId: input.userId,
    messages,
    characters: { [character.id]: character },
    presetMode: 'offline',
    readOnly: true,
    contextNow: positiveTimestamp(fact.occurredAt),
    disableMcpCapabilityIntent: true,
  });
  const continuity = buildLifeGlimpseContinuityBlock(messages, character.id, 3);
  const factualAnchor = [fact.place, fact.activity].filter(Boolean).join(' · ');
  const task = [
    '【生活侧面 · 独立线下叙事】',
    `角色：${clean(character.customNickname || character.name, 60)}`,
    timeAnchor,
    `此刻可靠生活锚点：${factualAnchor || '只按上方日程、场景与人物连续性自然推演'}`,
    continuity,
    '',
    '写一段发生在角色自己生活中的细腻片段，正文约 300—600 个中文字符，分 2—4 段。它填补角色没有即时聊天时的生活，而不是给用户的回复、报备或解释。',
    '必须延续人物、日程、当前场景、心理余波与先前生活片段；可以有环境、动作、感官、短对白和没说出口的念头，但不要总结式流水账。',
    '用户与手机都不是必选元素。角色可能完全没察觉消息、手机不在身边、看见但暂不想回，或此刻与用户毫无关系；只按情境自然决定，禁止每次都写手机震动、未读消息或“忙完再回”。',
    '不要替用户行动或读心，不要让角色知道只有叙事视角/用户才知道的事。不要把顶栏状态当正文复述。',
    'statusSuggestion 只是此刻顶栏状态建议：确有忙闲/地点/上下线变化才填写；不需要变化则两个字段都留空。statusText 是角色愿意公开的一句短句，不是地点说明。',
    '',
    '只输出 JSON：',
    '{"title":"短标题","summary":"不剧透细节的一句摘要","paragraphs":["第一段","第二段"],"digest":"供后续连续性使用的事件摘要","activity":"此刻在做什么","place":"地点或空字符串","phoneAwareness":"unaware|not_seen|seen_no_reply|unknown","statusSuggestion":{"presenceState":"online|away|busy|offline|空字符串","statusText":"公开短句或空字符串"}}',
  ].filter(Boolean).join('\n');
  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  const maxTokens = await resolveGenerationMaxTokens(apiOverride);
  const generated = await chatJsonGeneration({
    scope: 'life-glimpse-story',
    messages: [...built.messages, { role: 'user', content: task }],
    temperature: 0.9,
    maxTokens,
    retryOnInvalid: false,
    requestOptions: {
      configOverride: apiOverride || undefined,
      auditContext: {
        operation: 'life-glimpse-story',
        initiator: clean(input.initiator, 40) || 'real-person-mode',
      },
    },
    validate: (value) => !!normalizeAiLifeGlimpseStory(value),
  });
  const story = normalizeAiLifeGlimpseStory(generated?.data);
  return story
    ? { ok: true, reason: '', story, raw: String(generated?.raw || '') }
    : { ok: false, reason: 'invalid-life-glimpse-output', story: null, raw: String(generated?.raw || '') };
}

export function buildAiLifeGlimpse(input = {}) {
  const settings = normalizeLifeGlimpseSettings(input.settings);
  const story = normalizeAiLifeGlimpseStory(input.story);
  const chatId = identity(input.chatId);
  const characterId = identity(input.characterId);
  const relatedUserMessageId = identity(input.relatedUserMessageId);
  const consumesProactiveSlot = input.consumesProactiveSlot === true;
  const scheduleSlotKey = identity(input.scheduleSlotKey);
  const episodeId = identity(input.episodeId)
    || lifeGlimpseEpisodeId({ chatId, characterId, relatedUserMessageId });
  if (!settings.enabled || !settings.aiStoryCardsEnabled) return { ok: false, reason: 'disabled', card: null };
  if (!story || !chatId || !characterId || !episodeId) return { ok: false, reason: 'invalid-story', card: null };
  const observedAt = positiveTimestamp(input.observedAt, Date.now());
  const occurredAt = positiveTimestamp(input.occurredAt);
  if (!occurredAt) return { ok: false, reason: 'missing-semantic-time', card: null };
  const card = createMessage({
    id: lifeGlimpseMessageId(chatId, episodeId),
    chatId,
    senderId: 'system',
    senderName: '系统',
    type: 'storyCard',
    content: story.fullText,
    timestamp: occurredAt,
    metadata: {
      artifactKind: LIFE_GLIMPSE_STORY_KIND,
      storyKind: LIFE_GLIMPSE_STORY_KIND,
      lifeGlimpse: true,
      compactOnly: false,
      readOnly: true,
      title: story.title,
      badge: '生活侧面',
      summary: story.summary,
      fullText: story.fullText,
      paragraphs: story.paragraphs,
      digest: story.digest,
      activity: story.activity || input.fact?.activity || '',
      place: story.place || input.fact?.place || '',
      phoneAwareness: story.phoneAwareness,
      characterId,
      episodeId,
      occurredAt,
      occurredAtClockDomain: 'world',
      observedAt,
      observedAtClockDomain: 'wall',
      sourceFactIds: [...(input.fact?.sourceFactIds || [])],
      sourceFactKind: input.fact?.source || '',
      relatedUserMessageId,
      conversationMutating: false,
      countsAsReply: false,
      countsAsProactiveMessage: false,
      consumesProactiveSlot,
      ...(consumesProactiveSlot ? {
        scheduleProactive: true,
        scheduleSlotKey,
        proactiveChannel: clean(input.proactiveChannel, 40) || 'schedule',
        proactiveMotive: clean(input.proactiveMotive, 40) || 'life-fragment',
        proactiveIdempotencyKey: clean(input.proactiveIdempotencyKey, 160) || scheduleSlotKey,
      } : {}),
      mutatesChatPreview: false,
      unreadPolicy: 'none',
      notificationPolicy: settings.notifyOnCard ? 'life_glimpse_only' : 'none',
      generationMode: 'ai_story',
      costClass: LIFE_GLIMPSE_AI_COST_CLASS,
      apiRequestCount: 1,
      generationStatus: 'complete',
      createdAtReal: observedAt,
    },
  });
  return { ok: true, reason: '', card, story };
}

/**
 * 用户主动重新生成一张既有生活侧面。沿用原 episode、语义时间与事实锚点，
 * 成功后由调用方原位替换；失败时不修改旧卡。这里刻意不应用 statusSuggestion，
 * 避免重生成历史叙事时再次改变当前顶栏状态。
 */
export async function regenerateAiLifeGlimpseCard(input = {}, overrides = {}) {
  const previous = input.card;
  const metadata = asObject(previous?.metadata);
  const isLifeGlimpse = metadata.storyKind === LIFE_GLIMPSE_STORY_KIND
    || metadata.lifeGlimpse === true;
  const sourceFactIds = Array.isArray(metadata.sourceFactIds)
    ? metadata.sourceFactIds.map((value) => clean(value, 300)).filter(Boolean).slice(0, 12)
    : [];
  const occurredAt = positiveTimestamp(metadata.occurredAt, positiveTimestamp(previous?.timestamp));
  if (!isLifeGlimpse || !previous?.id || !occurredAt || !sourceFactIds.length) {
    return { ok: false, reason: 'invalid-existing-life-glimpse', card: null, modelRequestAttempted: false };
  }
  const messages = (Array.isArray(input.messages) ? input.messages : [])
    .filter((message) => identity(message?.id) !== identity(previous.id));
  const fact = {
    source: clean(metadata.sourceFactKind, 60) || 'existing_life_glimpse',
    sourceFactIds,
    activity: cleanParagraph(metadata.activity, 120),
    place: cleanParagraph(metadata.place, 100),
    occurredAt,
    occurredAtClockDomain: clean(metadata.occurredAtClockDomain, 20) || 'world',
  };
  const generate = overrides.generate || generateAiLifeGlimpse;
  let generated;
  try {
    generated = await generate({
      userId: input.userId,
      chat: input.chat,
      user: input.user,
      character: input.character,
      messages,
      fact,
    });
  } catch (error) {
    return {
      ok: false,
      reason: clean(error?.reason || error?.code || error?.message || 'life-glimpse-regenerate-failed', 120),
      card: null,
      modelRequestAttempted: true,
    };
  }
  if (!generated?.ok || !generated.story) {
    return {
      ok: false,
      reason: clean(generated?.reason, 120) || 'invalid-life-glimpse-output',
      card: null,
      modelRequestAttempted: true,
    };
  }
  const rebuilt = buildAiLifeGlimpse({
    settings: normalizeLifeGlimpseSettings({ enabled: true, aiStoryCardsEnabled: true }),
    chatId: previous.chatId || input.chat?.id,
    characterId: metadata.characterId || input.character?.id,
    relatedUserMessageId: metadata.relatedUserMessageId,
    episodeId: metadata.episodeId,
    occurredAt,
    observedAt: Date.now(),
    fact,
    story: generated.story,
  });
  if (!rebuilt.ok || !rebuilt.card) {
    return { ok: false, reason: rebuilt.reason || 'life-glimpse-rebuild-failed', card: null, modelRequestAttempted: true };
  }
  const now = Date.now();
  return {
    ok: true,
    reason: '',
    modelRequestAttempted: true,
    card: {
      ...rebuilt.card,
      id: previous.id,
      timestamp: previous.timestamp,
      editedAt: now,
      metadata: {
        ...rebuilt.card.metadata,
        expanded: true,
        readOnly: false,
        generationMode: 'ai_story_reroll',
        rerollCount: Math.max(0, Number(metadata.rerollCount) || 0) + 1,
        rerolledAt: now,
        // 原卡可能来自旧版轻量模式；保留 episode 因果身份，但不保留其短正文。
        relatedUserMessageTimestamp: metadata.relatedUserMessageTimestamp,
      },
    },
  };
}

export async function persistAiLifeGlimpse(input = {}) {
  const userId = identity(input.userId);
  const chatId = identity(input.chatId);
  const characterId = identity(input.characterId);
  const relatedUserMessageId = identity(input.relatedUserMessageId);
  if (!userId || !chatId || !characterId || !relatedUserMessageId) {
    return { ok: false, reason: 'missing-persist-scope', card: null, created: false };
  }
  const [chat, settings, threadMessages] = await Promise.all([
    db.getRecord('chats', chatId),
    loadLifeGlimpseSettings(userId, characterId),
    db.getAllByIndex('messages', 'chatId', chatId),
  ]);
  const participants = Array.isArray(chat?.participants) ? chat.participants.map(String) : [];
  if (!chat || identity(chat.userId) !== userId || !participants.includes('user') || !participants.includes(characterId)) {
    return { ok: false, reason: 'scope-mismatch', card: null, created: false };
  }
  const unanswered = getUnansweredRealUserMessage(threadMessages);
  if (identity(unanswered?.id) !== relatedUserMessageId) {
    return { ok: false, reason: 'related-message-not-unanswered', card: null, created: false };
  }
  const built = buildAiLifeGlimpse({ ...input, settings });
  if (!built.ok) return { ...built, created: false };
  const persisted = await db.updateRecord('messages', built.card.id, (current) => current ? null : built.card);
  const record = persisted.record || built.card;
  const deduped = persisted.updated !== true
    && record?.metadata?.storyKind === LIFE_GLIMPSE_STORY_KIND
    && identity(record.metadata?.episodeId) === identity(built.card.metadata.episodeId);
  return {
    ...built,
    ok: persisted.updated === true || deduped,
    reason: persisted.updated === true || deduped ? '' : 'message-id-conflict',
    card: record,
    created: persisted.updated === true,
    deduped,
  };
}

/**
 * 日程主动轮生成的生活侧面没有“待回复用户消息”锚点，但必须绑定已经仲裁完成的
 * schedule slot。它仍不改变聊天预览或未读，只消费这一轮主动额度与时段。
 */
export async function persistScheduledAiLifeGlimpse(input = {}) {
  const userId = identity(input.userId);
  const chatId = identity(input.chatId);
  const characterId = identity(input.characterId);
  const scheduleSlotKey = identity(input.scheduleSlotKey);
  const episodeId = identity(input.episodeId)
    || scheduledLifeGlimpseEpisodeId({ chatId, characterId, slotKey: scheduleSlotKey });
  if (!userId || !chatId || !characterId || !scheduleSlotKey || !episodeId) {
    return { ok: false, reason: 'missing-schedule-persist-scope', card: null, created: false };
  }
  const [chat, settings] = await Promise.all([
    db.getRecord('chats', chatId),
    loadLifeGlimpseSettings(userId, characterId),
  ]);
  const participants = Array.isArray(chat?.participants) ? chat.participants.map(String) : [];
  if (!chat || identity(chat.userId) !== userId || !participants.includes('user') || !participants.includes(characterId)) {
    return { ok: false, reason: 'scope-mismatch', card: null, created: false };
  }
  const built = buildAiLifeGlimpse({
    ...input,
    settings,
    episodeId,
    relatedUserMessageId: '',
    scheduleSlotKey,
    consumesProactiveSlot: true,
    proactiveChannel: 'schedule',
    proactiveMotive: 'life-fragment',
  });
  if (!built.ok) return { ...built, created: false };
  const persisted = await db.updateRecord('messages', built.card.id, (current) => current ? null : built.card);
  const record = persisted.record || built.card;
  const deduped = persisted.updated !== true
    && record?.metadata?.storyKind === LIFE_GLIMPSE_STORY_KIND
    && record?.metadata?.consumesProactiveSlot === true
    && identity(record.metadata?.episodeId) === episodeId;
  return {
    ...built,
    ok: persisted.updated === true || deduped,
    reason: persisted.updated === true || deduped ? '' : 'message-id-conflict',
    card: record,
    created: persisted.updated === true,
    deduped,
  };
}

/**
 * 把一次已经获准的日程主动轮转换成生活侧面。每个 slot 固定一个 episode，
 * 请求一旦发出即终结本轮，不因空回、格式错误或落库结果不明自动二次计费。
 */
export async function generateScheduledAiLifeGlimpse(input = {}, overrides = {}) {
  const userId = identity(input.userId);
  const chatId = identity(input.chat?.id || input.chatId);
  const characterId = identity(input.character?.id || input.characterId);
  const scheduleSlotKey = identity(input.scheduleSlotKey);
  const occurredAt = positiveTimestamp(input.occurredAt || input.fact?.occurredAt);
  const episodeId = scheduledLifeGlimpseEpisodeId({ chatId, characterId, slotKey: scheduleSlotKey });
  if (!userId || !chatId || !characterId || !scheduleSlotKey || !occurredAt || !episodeId) {
    return { ok: false, reason: 'invalid-scheduled-life-glimpse', modelRequestAttempted: false };
  }
  const settings = await loadLifeGlimpseSettings(userId, characterId);
  if (!settings.enabled || !settings.aiStoryCardsEnabled) {
    return { ok: false, reason: 'life-glimpse-disabled', skipped: true, modelRequestAttempted: false };
  }
  const existing = await db.getRecord('messages', lifeGlimpseMessageId(chatId, episodeId));
  if (
    existing?.metadata?.storyKind === LIFE_GLIMPSE_STORY_KIND
    && existing?.metadata?.consumesProactiveSlot === true
    && identity(existing.metadata?.episodeId) === episodeId
  ) {
    return {
      ok: true,
      reason: 'life-glimpse-deduped',
      modelRequestAttempted: false,
      created: false,
      deduped: true,
      card: existing,
      messages: [],
      cards: [existing],
      messageCount: 0,
      cardCount: 1,
      deliverableCount: 1,
      lifeGlimpse: true,
      scheduleProactiveLifeGlimpse: true,
    };
  }
  const generate = overrides.generate || generateAiLifeGlimpse;
  let generated;
  try {
    generated = await generate({
      ...input,
      userId,
      initiator: 'schedule-proactive',
    });
  } catch (error) {
    return {
      ok: false,
      reason: clean(error?.reason || error?.code || error?.message || 'scheduled-life-glimpse-generation-failed', 120),
      modelRequestAttempted: true,
    };
  }
  if (!generated?.ok || !generated.story) {
    return {
      ok: false,
      reason: clean(generated?.reason, 120) || 'invalid-life-glimpse-output',
      modelRequestAttempted: true,
    };
  }
  const persist = overrides.persist || persistScheduledAiLifeGlimpse;
  let persisted;
  try {
    persisted = await persist({
      ...input,
      userId,
      chatId,
      characterId,
      episodeId,
      scheduleSlotKey,
      occurredAt,
      observedAt: Date.now(),
      story: generated.story,
    });
  } catch (error) {
    return {
      ok: false,
      reason: clean(error?.message || 'scheduled-life-glimpse-persist-failed', 120),
      modelRequestAttempted: true,
    };
  }
  if (!persisted?.ok || !persisted.card) {
    return {
      ok: false,
      reason: clean(persisted?.reason, 120) || 'scheduled-life-glimpse-persist-failed',
      modelRequestAttempted: true,
    };
  }
  return {
    ok: true,
    reason: 'life-glimpse',
    modelRequestAttempted: true,
    created: persisted.created === true,
    deduped: persisted.deduped === true,
    card: persisted.card,
    story: generated.story,
    messages: [],
    cards: [persisted.card],
    messageCount: 0,
    cardCount: 1,
    deliverableCount: 1,
    lifeGlimpse: true,
    scheduleProactiveLifeGlimpse: true,
  };
}

function terminalLifeGlimpseResult(reason = '') {
  return {
    ok: false,
    reason: clean(reason, 80) || 'life-glimpse-unavailable',
    terminal: true,
    modelRequestAttempted: false,
    apiRequestCount: 0,
  };
}

/**
 * 持久等待票的生活侧面执行边界。请求只发一次；一旦进入生成，无论空回、格式错
 * 或传输结果不明都终结本票，禁止后台自动二次计费。
 */
export async function executePendingLifeGlimpseAction(action = {}, context = {}, overrides = {}) {
  const userId = identity(action.userId);
  const chatId = identity(action.chatId);
  const characterId = identity(action.characterId);
  const payload = asObject(action.payload);
  const relatedUserMessageId = identity(payload.anchorMessageId || payload.relatedUserMessageId);
  const relatedUserMessageTimestamp = positiveTimestamp(
    payload.anchorTimestamp || payload.relatedUserMessageTimestamp,
  );
  const waitingReason = clean(payload.waitingReason, 40);
  if (
    !userId
    || !chatId
    || !characterId
    || !relatedUserMessageId
    || !relatedUserMessageTimestamp
    || !isLifeGlimpseWaitReason(waitingReason)
  ) {
    return terminalLifeGlimpseResult('invalid-life-glimpse-action');
  }

  const loadPolicy = overrides.loadPolicy || (async () => {
    const module = await import('../character-autonomy-settings.js');
    return module.loadResolvedCharacterAutonomyPolicy(userId, characterId, chatId);
  });
  const policy = await loadPolicy(userId, characterId, chatId);
  if (policy?.realPersonMode?.enabled !== true) {
    return terminalLifeGlimpseResult('real-person-disabled');
  }

  const getWorldNow = overrides.getWorldNow || (async () => {
    const module = await import('../time-mode.js');
    return module.getNowForUser(userId);
  });
  const worldNow = positiveTimestamp(await getWorldNow(userId));
  if (!worldNow) return terminalLifeGlimpseResult('missing-semantic-time');

  const loadCharacter = overrides.loadCharacter || (async () => {
    const module = await import('../character-store.js');
    return module.getCharacter(characterId, { userId });
  });
  const loadPhone = overrides.loadPhone || (async () => {
    const module = await import('../character-phone-store.js');
    return module.loadCharacterPhone(userId, characterId);
  });
  const [character, phone] = await Promise.all([
    loadCharacter(characterId, userId),
    loadPhone(userId, characterId),
  ]);
  if (!character) return terminalLifeGlimpseResult('character-missing');

  const collectCurrentContext = overrides.collectCurrentContext || (async (input) => {
    const module = await import('../character-phone-current-context.js');
    return module.collectCharacterPhoneCurrentContext(input);
  });
  const currentContext = await collectCurrentContext({
    userId,
    characterId,
    character,
    phone,
    now: worldNow,
  });
  let waitEvidence = resolveLifeGlimpseWaitEvidence(currentContext);
  if (!waitEvidence && resolvedSource(currentContext?.effective?.source) === 'runtime') {
    const resolveBusyText = overrides.isBusyLikeStatusText || (async (value) => {
      const module = await import('../character-phone-proactive.js');
      return module.isBusyLikeStatusText(value);
    });
    const runtimeActivity = currentContext?.effective?.activity || currentContext?.runtime?.activity || '';
    const runtimeBusy = await resolveBusyText(runtimeActivity);
    waitEvidence = resolveLifeGlimpseWaitEvidence(currentContext, {
      isBusyLikeStatusText: () => runtimeBusy === true,
    });
  }
  if (!waitEvidence) return terminalLifeGlimpseResult('waiting-ended');

  const resolvePlanDate = overrides.resolvePlanDate || (async () => {
    const module = await import('../character-phone-store.js');
    return module.dateKeyFromTimestamp(worldNow, currentContext?.timeZone || '');
  });
  const planDate = await resolvePlanDate(worldNow, currentContext?.timeZone || '');
  const fact = resolveAiLifeGlimpseFact(currentContext, {
    characterId,
    planDate,
    occurredAt: worldNow,
    occurredAtClockDomain: 'world',
  });
  if (!fact?.sourceFactIds?.length) return terminalLifeGlimpseResult('no-trusted-fact');

  const settings = await loadLifeGlimpseSettings(userId, characterId);
  if (!settings.enabled || !settings.aiStoryCardsEnabled) return terminalLifeGlimpseResult('disabled');
  const [chat, messages] = await Promise.all([
    db.getRecord('chats', chatId),
    db.getAllByIndex('messages', 'chatId', chatId),
  ]);
  const user = context.user || await db.getRecord('users', userId);
  if (!chat || !user) return terminalLifeGlimpseResult('chat-or-user-missing');
  const unanswered = getUnansweredRealUserMessage(messages);
  if (
    identity(unanswered?.id) !== relatedUserMessageId
    || positiveTimestamp(unanswered?.timestamp) !== relatedUserMessageTimestamp
  ) return terminalLifeGlimpseResult('related-message-not-unanswered');

  const consumeBudget = overrides.consumeBudget || (async () => {
    const module = await import('../character-api-budget.js');
    return module.consumeCharacterApiBudget({ userId, characterId, chatId, policy });
  });
  const budget = await consumeBudget({ userId, characterId, chatId, policy });
  if (!budget?.ok) return terminalLifeGlimpseResult(budget?.reason || 'budget-unavailable');

  const generate = overrides.generate || generateAiLifeGlimpse;
  let generated;
  try {
    generated = await generate({
      userId,
      chat,
      user,
      character,
      messages,
      currentContext,
      fact,
    });
  } catch (error) {
    return {
      ok: false,
      reason: clean(error?.reason || error?.code || error?.message || 'life-glimpse-generation-failed', 120),
      terminal: true,
      modelRequestAttempted: true,
      apiRequestCount: 1,
    };
  }
  if (!generated?.ok || !generated.story) {
    return {
      ok: false,
      reason: clean(generated?.reason, 120) || 'invalid-life-glimpse-output',
      terminal: true,
      modelRequestAttempted: true,
      apiRequestCount: 1,
    };
  }

  const persist = overrides.persist || persistAiLifeGlimpse;
  let persisted;
  try {
    persisted = await persist({
      userId,
      chatId,
      characterId,
      relatedUserMessageId,
      relatedUserMessageTimestamp,
      occurredAt: worldNow,
      observedAt: Date.now(),
      fact,
      story: generated.story,
    });
  } catch (error) {
    return {
      ok: false,
      reason: clean(error?.message || 'life-glimpse-persist-failed', 120),
      terminal: true,
      modelRequestAttempted: true,
      apiRequestCount: 1,
    };
  }
  if (!persisted?.ok) {
    return {
      ok: false,
      reason: clean(persisted?.reason, 120) || 'life-glimpse-persist-failed',
      terminal: true,
      modelRequestAttempted: true,
      apiRequestCount: 1,
    };
  }

  const status = generated.story.statusSuggestion || {};
  if (status.presenceState || status.statusText) {
    const applyStatus = overrides.applyStatus || (async () => {
      const module = await import('./marshmallow-status.js');
      return module.applyMarshmallowStatusEvents([{
        t: 'status',
        actor: characterId,
        presenceState: status.presenceState
          || clean(currentContext?.publicStatus?.presenceState, 20)
          || 'online',
        statusText: status.statusText
          || clean(currentContext?.publicStatus?.statusText, 40),
        reason: 'life-glimpse',
      }], {
        sourceChatId: chatId,
        sourceChat: chat,
        userId,
        aiRoundId: `life-glimpse:${persisted.card?.metadata?.episodeId || action.id}`,
        aiRoundCreatedAt: Date.now(),
        sceneSource: 'schedule',
        statusStoryScenes: {},
      });
    });
    await applyStatus().catch(() => null);
  }
  return {
    ok: true,
    reason: '',
    terminal: true,
    modelRequestAttempted: true,
    apiRequestCount: 1,
    created: persisted.created === true,
    deduped: persisted.deduped === true,
    card: persisted.card,
    waitEvidence,
    result: {
      ok: true,
      messages: [],
      cards: persisted.card ? [persisted.card] : [],
      messageCount: 0,
      cardCount: persisted.created === true ? 1 : 0,
      deliverableCount: persisted.created === true ? 1 : 0,
      apiRequestCount: 1,
      lifeGlimpse: true,
    },
  };
}
