import { createMessage } from '../../models/chat.js';
import {
  get as dbGet,
  getAllByIndex as dbGetAllByIndex,
  put as dbPut,
} from '../db.js';
import {
  ensurePeerPrivateChat,
  listChatsForUser,
  previewFromMessage,
  saveMessage,
  updateChatPreview,
} from '../chat-store.js';
import { isStrangerInterceptChat } from '../stranger-thread-model.js';
import { appendDebugEvent } from '../debug-log.js';
import { getNowForUser, getPacingNowForUser } from '../time-mode.js';
import { showToast } from '../../components/toast.js';
import { canPhoneCharacterIdsKnowEachOther } from '../phone-social-eligibility.js';
import { isActiveWeiboPost } from '../weibo/weibo-post-store.js';

export const SOCIAL_POST_COOLDOWN_MS = 45 * 60 * 1000;
export const OPEN_ALIAS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const SOCIAL_REACT_COOLDOWN_MS = 20 * 60 * 1000;
export const SHARE_BACK_COOLDOWN_MS = 30 * 60 * 1000;
export const ALIAS_POKE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// 只对「最近还新鲜」的帖子点赞评论，避免翻出几周前的旧帖显得诡异。
export const SOCIAL_REACT_POST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const inFlight = new Set();

function clean(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

export function stableIntentHash(value = '') {
  const input = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function fingerprintAliasIntent(value = '') {
  return clean(value, 300).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function actorName(characters, actorId) {
  const row = characters?.[actorId] || {};
  return clean(row.realName || row.name || row.customNickname || actorId, 80);
}

function intentReceiptId(event, context) {
  return [
    clean(context.userId),
    clean(context.chat?.id || context.chatId),
    clean(context.aiRoundId),
    String(event?.sourceIndex ?? ''),
    clean(event?.t),
    clean(event?.from),
    clean(event?.target || event?.intent),
  ].join('|');
}

function isNormalOwnedPrivateChat(chat, userId, actorId) {
  if (!chat || chat.type === 'group' || isStrangerInterceptChat(chat)) return false;
  if (chat.userId && clean(chat.userId) !== clean(userId)) return false;
  const participants = Array.isArray(chat.participants) ? chat.participants : [];
  return participants.includes('user') && participants.includes(actorId);
}

async function consumeRealPersonSocialBudget(userId, actorId, chatId) {
  try {
    const [{ loadResolvedCharacterAutonomyPolicy }, { consumeCharacterApiBudget }] = await Promise.all([
      import('../character-autonomy-settings.js'),
      import('../character-api-budget.js'),
    ]);
    const policy = await loadResolvedCharacterAutonomyPolicy(userId, actorId, chatId);
    if (policy?.realPersonMode?.enabled !== true) return { ok: true, skipped: true };
    return consumeCharacterApiBudget({
      userId,
      characterId: actorId,
      chatId,
      category: 'social_post',
      policy,
    });
  } catch (_) {
    return { ok: true, skipped: true };
  }
}

async function scheduleRealPersonSocialFollowup({
  userId,
  actorId,
  chatId,
  target,
  post,
  receipt,
} = {}) {
  try {
    const [{ loadResolvedCharacterAutonomyPolicy }, { enqueuePendingAction }] = await Promise.all([
      import('../character-autonomy-settings.js'),
      import('./pending-actions.js'),
    ]);
    const policy = await loadResolvedCharacterAutonomyPolicy(userId, actorId, chatId);
    if (policy?.realPersonMode?.enabled !== true || !post?.id) return null;
    const seed = parseInt(stableIntentHash(receipt), 36) || Date.now();
    const delayMinutes = 15 + (seed % 46);
    const pacingNow = await getPacingNowForUser(userId);
    return enqueuePendingAction({
      userId,
      characterId: actorId,
      chatId,
      kind: 'social_followup',
      dueAt: pacingNow + delayMinutes * 60 * 1000,
      createdAt: pacingNow,
      dedupeKey: `social-followup:${target}:${post.id}`,
      payload: {
        target,
        postId: post.id,
        sourceIntentReceipt: receipt,
      },
    });
  } catch (_) {
    return null;
  }
}

async function readLedger(key) {
  const row = await dbGet(key).catch(() => null);
  return row?.value && typeof row.value === 'object' ? row.value : {};
}

async function writeLedger(key, value) {
  await dbPut({ key, value });
}

async function createMomentsIntentPost({
  user,
  userId,
  actorId,
  brief,
  exactContent = '',
  target = 'moments',
  chatId,
  recentMessages,
  idempotencyKey,
  allowRecentReuse = true,
} = {}) {
  const [
    { aiGenerateMomentsFeedBatch },
    {
      allocMomentTimestamp,
      getMomentPost,
      listMomentPostsForAuthor,
      loadMomentsPrefs,
      putMomentPost,
    },
  ] = await Promise.all([
    import('../moments/moments-ai.js'),
    import('../moments/moments-store.js'),
  ]);
  const postId = `moment_intent_${stableIntentHash(idempotencyKey)}`;
  const existing = await getMomentPost(postId).catch(() => null);
  if (existing && clean(existing.userId) === clean(userId) && clean(existing.authorId) === clean(actorId)) {
    return { ok: true, stored: 1, post: existing, reused: true };
  }
  if (existing && clean(existing.userId) && clean(existing.userId) !== clean(userId)) {
    // 同 id 已属别档：绝不覆盖，避免把对方档位动态挪到当前时间线
    return { ok: false, reason: 'moments-slot-collision' };
  }
  const recentIntentPost = allowRecentReuse
    ? (await listMomentPostsForAuthor(userId, actorId).catch(() => []))
      .find((post) => post?.metadata?.chatIntent === true
        && clean(post.metadata.intentTarget || 'moments') === clean(target)
        && Date.now() - Number(post.metadata.intentCompletedAt || 0) < SOCIAL_POST_COOLDOWN_MS)
    : null;
  if (recentIntentPost) {
    return { ok: true, stored: 1, post: recentIntentPost, reused: true };
  }
  const budget = await consumeRealPersonSocialBudget(userId, actorId, chatId);
  if (!budget?.ok) return { ok: false, reason: budget?.reason || 'budget-unavailable' };
  const prefs = await loadMomentsPrefs(userId).catch(() => null);
  const allowImages = prefs?.autoGen?.allowImages === true;
  const allowTextImages = prefs?.autoGen?.allowTextImages === true;
  const allowStickers = prefs?.autoGen?.allowStickers === true;
  const { getStickerPoolForMessageResolve } = await import('./sticker-resolve.js');
  const stickerPool = await getStickerPoolForMessageResolve(actorId, userId).catch(() => []);
  const stickerPackIds = [...new Set(stickerPool.map((item) => String(item?.packId || '').trim()).filter(Boolean))];
  const generated = await aiGenerateMomentsFeedBatch({
    user,
    authorIds: [actorId],
    count: 1,
    intentSeed: brief,
    sourceRecentMessages: recentMessages,
    sourceChatId: chatId,
    imageOptions: {
      allowLifePhoto: allowImages,
      allowPersonPhoto: false,
      allowTextImage: allowTextImages,
      allowStickers: allowStickers && stickerPackIds.length > 0,
      stickerPackIds,
      imageStyleId: '',
    },
  });
  const post = generated.find((row) => clean(row?.authorId) === clean(actorId));
  if (!post) return { ok: false, reason: 'moments-empty' };
  const saved = await putMomentPost({
    ...post,
    // 线下叙事与真实朋友圈必须同源；二次模型只负责配图和互动素材，
    // 不得再次改写角色按下发布键时已经确定的正文。
    content: clean(exactContent, 600) || post.content,
    id: postId,
    userId,
    timestamp: await allocMomentTimestamp(userId),
    metadata: {
      ...(post.metadata || {}),
      sourceType: post.metadata?.sourceType || 'chat',
      chatIntent: true,
      intentTarget: target,
      intentCompletedAt: Date.now(),
      sourceChatId: chatId,
      intentBrief: clean(brief, 300),
      ...(clean(exactContent, 600) ? { exactIntentContent: clean(exactContent, 600) } : {}),
      // 该动态由这段私聊触发：作者和用户是来源当事人；其它可见角色只能算知情。
      involvedActorIds: ['user', actorId],
    },
  }, userId);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('moments-auto-generated', {
      detail: {
        count: 1,
        source: 'chat-intent',
        userId,
        postIds: [saved.id],
        posts: [saved],
      },
    }));
  }
  return { ok: true, stored: 1, post: saved };
}

export async function createWeiboIntentPost({
  user,
  userId,
  actorId,
  brief,
  target = 'weibo',
  chatId,
  recentMessages,
  idempotencyKey,
} = {}) {
  const { aiGenerateWeiboIntentPost } = await import('../weibo/weibo-ai.js');
  const postId = `weibo_intent_${stableIntentHash(idempotencyKey)}`;
  const existing = await dbGet('weiboPosts', postId).catch(() => null);
  if (isActiveWeiboPost(existing)
    && clean(existing.ownerUserId) === clean(userId)
    && clean(existing.authorId) === clean(actorId)) {
    return { ok: true, stored: 1, post: existing, reused: true };
  }
  const recentIntentPost = (await dbGetAllByIndex('weiboPosts', 'authorId', actorId).catch(() => []))
    .find((post) => isActiveWeiboPost(post)
      && clean(post.ownerUserId) === clean(userId)
      && post?.metadata?.chatIntent === true
      && clean(post.metadata.intentTarget || 'weibo') === clean(target)
      && Date.now() - Number(post.metadata.intentCompletedAt || 0) < SOCIAL_POST_COOLDOWN_MS);
  if (recentIntentPost) {
    return { ok: true, stored: 1, post: recentIntentPost, reused: true };
  }
  const budget = await consumeRealPersonSocialBudget(userId, actorId, chatId);
  if (!budget?.ok) return { ok: false, reason: budget?.reason || 'budget-unavailable' };
  const generated = await aiGenerateWeiboIntentPost({
    user,
    userId,
    authorId: actorId,
    brief,
    sourceChatId: chatId,
    recentMessages,
  });
  if (!generated || clean(generated.authorId) !== clean(actorId)) {
    return { ok: false, reason: 'weibo-empty' };
  }
  const post = {
    ...generated,
    id: postId,
    ownerUserId: userId,
    authorId: actorId,
    timestamp: await getNowForUser(userId),
    metadata: {
      ...(generated.metadata || {}),
      sourceType: generated.metadata?.sourceType || 'chat',
      chatIntent: true,
      intentTarget: target,
      intentCompletedAt: Date.now(),
      sourceChatId: chatId,
      intentBrief: clean(brief, 300),
      ownerUserId: userId,
    },
  };
  await dbPut('weiboPosts', post);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('weibo-auto-generated', {
      detail: { count: 1, source: 'chat-intent' },
    }));
  }
  return { ok: true, stored: 1, post };
}

export async function createForumIntentPost({
  user,
  userId,
  actorId,
  brief,
  target = 'forum',
  chatId,
  recentMessages,
  idempotencyKey,
} = {}) {
  const { aiGenerateForumIntentThread } = await import('../forum/forum-ai.js');
  const postId = `forum_intent_${stableIntentHash(idempotencyKey)}`;
  const existing = await dbGet('forumThreads', postId).catch(() => null);
  if (existing
    && clean(existing.userId) === clean(userId)
    && clean(existing.authorRoleId || existing.authorId) === clean(actorId)) {
    return { ok: true, stored: 1, post: existing, reused: true };
  }
  const recentIntentPost = (await dbGetAllByIndex('forumThreads', 'userId', userId).catch(() => []))
    .find((post) => clean(post.authorRoleId || post.authorId) === clean(actorId)
      && post?.metadata?.chatIntent === true
      && clean(post.metadata.intentTarget || 'forum') === clean(target)
      && Date.now() - Number(post.metadata.intentCompletedAt || 0) < SOCIAL_POST_COOLDOWN_MS);
  if (recentIntentPost) {
    return { ok: true, stored: 1, post: recentIntentPost, reused: true };
  }
  const budget = await consumeRealPersonSocialBudget(userId, actorId, chatId);
  if (!budget?.ok) return { ok: false, reason: budget?.reason || 'budget-unavailable' };
  const generated = await aiGenerateForumIntentThread({
    user,
    userId,
    authorId: actorId,
    brief,
    sourceChatId: chatId,
    recentMessages,
  });
  if (!generated || clean(generated.authorRoleId) !== clean(actorId)) {
    return { ok: false, reason: 'forum-empty' };
  }
  const post = {
    ...generated,
    id: postId,
    userId,
    authorId: actorId,
    authorRoleId: actorId,
    authorSource: 'generated',
    timestamp: await getNowForUser(userId),
    metadata: {
      ...(generated.metadata || {}),
      sourceType: generated.metadata?.sourceType || 'chat',
      chatIntent: true,
      intentTarget: target,
      intentCompletedAt: Date.now(),
      sourceChatId: chatId,
      intentBrief: clean(brief, 300),
      ownerUserId: userId,
    },
  };
  await dbPut('forumThreads', post);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('forum-auto-generated', {
      detail: { count: 1, source: 'chat-intent' },
    }));
  }
  return { ok: true, stored: 1, post };
}

export const SOCIAL_POST_ADAPTERS = Object.freeze({
  moments: Object.freeze({
    supported: true,
    execute: createMomentsIntentPost,
  }),
  weibo: Object.freeze({
    supported: true,
    execute: createWeiboIntentPost,
  }),
  forum: Object.freeze({
    supported: true,
    execute: createForumIntentPost,
  }),
});

function defaultWarning({ code, message, context }) {
  appendDebugEvent({
    type: code || 'chat_intent_side_effect_warning',
    level: 'warn',
    message: message || '聊天意图旁路动作已跳过',
    context: context || {},
  });
  if (typeof window !== 'undefined') showToast(message || '旁路动作未执行', 4000);
}

function socialPostTargetLabel(target = '') {
  return {
    moments: '朋友圈',
    weibo: '微博',
    forum: '论坛',
  }[clean(target).toLowerCase()] || '社交动态';
}

async function persistSocialPostIntentStatus(event = {}, result = {}, context = {}) {
  const placeholderMessageId = clean(event.placeholderMessageId);
  if (!placeholderMessageId) return;
  const placeholder = await dbGet('messages', placeholderMessageId).catch(() => null);
  if (!placeholder || clean(placeholder.chatId) !== clean(context.chat?.id || context.chatId)) return;
  const completed = result?.ok === true;
  const target = clean(event.target).toLowerCase();
  const targetLabel = socialPostTargetLabel(target);
  const actionText = completed
    ? `${targetLabel}已发布`
    : `${targetLabel}未发布`;
  placeholder.content = actionText;
  placeholder.metadata = {
    ...(placeholder.metadata || {}),
    marshmallowEventType: 'social_post',
    chatAction: 'social_post',
    actionKind: targetLabel,
    actionText,
    socialPostStatus: completed ? 'completed' : 'failed',
    socialPostTarget: target,
    socialPostBrief: clean(event.brief, 300),
    socialPostCompletedAt: completed ? Date.now() : 0,
    socialPostPostId: completed ? clean(result.post?.id) : '',
    socialPostFailureReason: completed ? '' : clean(result?.reason || 'failed', 120),
  };
  await saveMessage(placeholder);
}

function resolveConsultCharacter(raw, actorId, characters = {}) {
  const needle = clean(raw);
  if (!needle) return null;
  const normalized = needle.toLowerCase();
  return Object.values(characters || {}).find((row) => {
    if (!row?.id || clean(row.id) === clean(actorId)) return false;
    return [row.id, row.name, row.realName, row.customNickname, ...(Array.isArray(row.aliases) ? row.aliases : [])]
      .some((value) => clean(value).toLowerCase() === normalized);
  }) || null;
}

async function persistConsultationRecap({
  userId,
  ownerId,
  consultedId,
  intent,
  sourceChatId,
  characters,
  messageId,
} = {}) {
  const chats = await listChatsForUser(userId);
  const targetInSlot = chats.some((chat) => (chat?.participants || []).includes(consultedId));
  if (!targetInSlot) return { ok: false, reason: 'consult-target-not-in-user-slot' };
  const sociallyEligible = await canPhoneCharacterIdsKnowEachOther(
    ownerId,
    consultedId,
    userId,
  ).catch(() => false);
  if (sociallyEligible === false) {
    return { ok: false, reason: 'consult-target-cross-group-without-network' };
  }
  const peerChat = await ensurePeerPrivateChat(userId, [ownerId, consultedId], {
    parentChatId: sourceChatId,
    focalActorId: ownerId,
  });
  const owner = actorName(characters, ownerId) || '角色';
  const consulted = actorName(characters, consultedId) || '对方';
  const recap = createMessage({
    id: messageId,
    chatId: peerChat.id,
    senderId: 'system',
    senderName: '咨询记录',
    type: 'system',
    content: `[咨询记录] ${owner}在开设新马甲前，就“${clean(intent, 160)}”向${consulted}征询过意见。这里只记录咨询事实，未生成双方对白。`,
    timestamp: await getNowForUser(userId),
    metadata: {
      aliasConsultation: true,
      ownerId,
      consultedId,
      sourceChatId,
      generatedDialogue: false,
    },
  });
  await saveMessage(recap);
  await updateChatPreview(peerChat.id, previewFromMessage(recap), recap.timestamp);
  return { ok: true, chatId: peerChat.id };
}

function runtimeDeps(overrides = {}) {
  return {
    now: overrides.now || (() => Date.now()),
    readLedger: overrides.readLedger || readLedger,
    writeLedger: overrides.writeLedger || writeLedger,
    socialAdapters: overrides.socialAdapters || SOCIAL_POST_ADAPTERS,
    generateAlias: overrides.generateAlias || (async (options) => {
      const { generateCharacterAliasAccount } = await import('../alias-account-generation.js');
      return generateCharacterAliasAccount(options);
    }),
    listAliasAccounts: overrides.listAliasAccounts || (async (ownerId, userId) => {
      const { listAliasAccounts } = await import('../alias-account-store.js');
      return listAliasAccounts('character', ownerId, { userId });
    }),
    persistConsultation: overrides.persistConsultation || persistConsultationRecap,
    upsertAwareness: overrides.upsertAwareness || (async (payload) => {
      const { upsertAliasAwareness } = await import('../memory/memory-facts.js');
      return upsertAliasAwareness(payload);
    }),
    reactAdapters: overrides.reactAdapters || null,
    enqueuePendingAction: overrides.enqueuePendingAction || (async (input) => {
      const { enqueuePendingAction } = await import('./pending-actions.js');
      return enqueuePendingAction(input);
    }),
    loadChatPrefs: overrides.loadChatPrefs || (async (chatId) => {
      const { loadChatPrefs } = await import('../chat-block-state.js');
      return loadChatPrefs(chatId);
    }),
    getPacingNowForUser: overrides.getPacingNowForUser || getPacingNowForUser,
    generateAliasPoke: overrides.generateAliasPoke || (async (payload) => {
      const { maybeGenerateUserIntercepts } = await import('../user-intercept-auto.js');
      return maybeGenerateUserIntercepts(payload);
    }),
    consumeSocialBudget: overrides.consumeSocialBudget || consumeRealPersonSocialBudget,
    warn: overrides.warn || defaultWarning,
  };
}

export async function dispatchSocialPostIntent(event, context = {}, overrides = {}) {
  const deps = runtimeDeps(overrides);
  const userId = clean(context.userId);
  const actorId = clean(event?.from);
  const target = clean(event?.target).toLowerCase();
  const brief = clean(event?.brief, 300);
  const chat = context.chat || null;
  if (!userId || !actorId || !brief || !isNormalOwnedPrivateChat(chat, userId, actorId)) {
    const reason = isStrangerInterceptChat(chat) ? 'alias-social-post-denied' : 'unsupported-source-context';
    deps.warn({
      code: reason,
      message: reason === 'alias-social-post-denied'
        ? '马甲窗口内容不能直接用于公开社交动态'
        : '当前会话不支持角色公开发帖',
      context: { userId, actorId, target, chatId: chat?.id || '' },
    });
    return { ok: false, reason };
  }
  const adapter = deps.socialAdapters[target];
  if (!adapter?.supported || typeof adapter.execute !== 'function') {
    deps.warn({
      code: 'social-post-adapter-unsupported',
      message: `${target || '该平台'}暂不支持角色单作者发帖，已安全跳过`,
      context: { userId, actorId, target, reason: adapter?.reason || 'missing-adapter' },
    });
    return { ok: false, reason: 'unsupported-target', target };
  }
  const receipt = intentReceiptId(event, context);
  const ledgerKey = `chatIntentSocial_${stableIntentHash(`${userId}|${actorId}|${target}`)}`;
  const flightKey = ledgerKey;
  if (inFlight.has(flightKey)) return { ok: false, reason: 'in-flight' };
  inFlight.add(flightKey);
  try {
    const state = await deps.readLedger(ledgerKey);
    const now = Number(deps.now()) || Date.now();
    if ((state.receipts || []).includes(receipt)) return { ok: true, reason: 'already-completed', reused: true };
    if (Number(state.lastSuccessAt || 0) > 0
      && now - Number(state.lastSuccessAt) < SOCIAL_POST_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown' };
    }
    const result = await adapter.execute({
      user: context.user,
      userId,
      actorId,
      brief,
      target,
      chatId: chat.id,
      recentMessages: context.recentMessages || [],
      idempotencyKey: receipt,
    });
    if (!result?.ok || Number(result.stored || 0) < 1) {
      deps.warn({
        code: 'social-post-adapter-failed',
        message: '角色动态未能生成，聊天回复已正常保留',
        context: { userId, actorId, target, reason: result?.reason || 'adapter-empty' },
      });
      return { ok: false, reason: result?.reason || 'adapter-empty' };
    }
    await deps.writeLedger(ledgerKey, {
      lastSuccessAt: now,
      receipts: [...new Set([...(state.receipts || []).slice(-19), receipt])],
      lastPostId: clean(result.post?.id),
    });
    void scheduleRealPersonSocialFollowup({
      userId,
      actorId,
      chatId: chat.id,
      target,
      post: result.post,
      receipt,
    });
    return { ...result, target };
  } finally {
    inFlight.delete(flightKey);
  }
}

export async function dispatchOpenAliasIntent(event, context = {}, overrides = {}) {
  const deps = runtimeDeps(overrides);
  const userId = clean(context.userId);
  const actorId = clean(event?.from);
  const intent = clean(event?.intent, 300);
  const chat = context.chat || null;
  if (!userId || !actorId || !intent || !isNormalOwnedPrivateChat(chat, userId, actorId)) {
    const reason = isStrangerInterceptChat(chat) ? 'alias-window-open-alias-denied' : 'unsupported-source-context';
    deps.warn({
      code: reason,
      message: '只能由普通私聊里的角色为自己开设马甲',
      context: { userId, actorId, chatId: chat?.id || '' },
    });
    return { ok: false, reason };
  }
  const fingerprint = fingerprintAliasIntent(intent);
  const receipt = intentReceiptId(event, context);
  const ledgerKey = `chatIntentAlias_${stableIntentHash(`${userId}|${actorId}`)}`;
  const flightKey = `${ledgerKey}|${fingerprint}`;
  if (inFlight.has(flightKey)) return { ok: false, reason: 'in-flight' };
  inFlight.add(flightKey);
  try {
    const state = await deps.readLedger(ledgerKey);
    const entry = state?.entries?.[fingerprint] || null;
    const now = Number(deps.now()) || Date.now();
    if (entry && now - Number(entry.lastSuccessAt || 0) < OPEN_ALIAS_COOLDOWN_MS) {
      const accounts = await deps.listAliasAccounts(actorId, userId).catch(() => []);
      const existing = accounts.find((account) => clean(account.id) === clean(entry.accountId));
      return existing
        ? { ok: true, reason: 'already-completed', account: existing, reused: true }
        : { ok: false, reason: 'cooldown' };
    }
    const bucket = Math.floor(now / OPEN_ALIAS_COOLDOWN_MS);
    const accountId = `alias_intent_${stableIntentHash(`${userId}|${actorId}|${fingerprint}|${bucket}`)}`;
    const accounts = await deps.listAliasAccounts(actorId, userId).catch(() => []);
    let account = accounts.find((row) => clean(row.id) === accountId) || null;

    const consultRow = resolveConsultCharacter(event?.consult, actorId, context.characters || {});
    let consultation = null;
    if (clean(event?.consult) && !consultRow) {
      deps.warn({
        code: 'open-alias-consult-unresolved',
        message: '未找到要咨询的角色，已不编造咨询内容',
        context: { userId, actorId, consult: clean(event.consult), chatId: chat.id },
      });
    } else if (consultRow) {
      consultation = await deps.persistConsultation({
        userId,
        ownerId: actorId,
        consultedId: consultRow.id,
        intent,
        sourceChatId: chat.id,
        characters: context.characters || {},
        messageId: `msg_alias_consult_${stableIntentHash(receipt)}`,
      });
      if (!consultation?.ok) {
        deps.warn({
          code: 'open-alias-consult-skipped',
          message: '咨询对象不在当前用户档位，已跳过咨询且未编造对白',
          context: { userId, actorId, consultedId: consultRow.id, reason: consultation?.reason || '' },
        });
        consultation = null;
      }
    }

    if (!account) {
      account = await deps.generateAlias({
        userId,
        characterId: actorId,
        intent,
        windowLabel: intent,
        personaSeed: consultation?.ok
          ? `${intent}\n开号前已向${actorName(context.characters, consultRow.id)}征询过意见；未生成或假定具体对白。`
          : intent,
        accountId,
        sourceChatId: chat.id,
        sourceRecentMessages: context.recentMessages || [],
      });
    }
    if (!account?.id) {
      deps.warn({
        code: 'open-alias-generation-empty',
        message: '角色马甲未能生成，聊天回复已正常保留',
        context: { userId, actorId, chatId: chat.id },
      });
      return { ok: false, reason: 'alias-generation-empty' };
    }

    await deps.upsertAwareness({
      userId,
      accountId: account.id,
      awareCharacterId: actorId,
      awarenessLevel: 'knows_purpose',
      confidence: 1,
      provenance: {
        source: 'told',
        sourceChatId: chat.id,
        note: `本人创建并知道用途：${intent}`,
      },
      ownerId: actorId,
      accountLabel: account.displayName || account.windowLabel || '',
    });
    if (consultation?.ok && consultRow?.id) {
      await deps.upsertAwareness({
        userId,
        accountId: account.id,
        awareCharacterId: consultRow.id,
        awarenessLevel: 'knows_purpose',
        confidence: 1,
        provenance: {
          source: 'consulted',
          sourceChatId: consultation.chatId || chat.id,
          note: `开号前被咨询用途：${intent}`,
        },
        ownerId: actorId,
        accountLabel: account.displayName || account.windowLabel || '',
      });
    }
    await deps.writeLedger(ledgerKey, {
      entries: {
        ...(state.entries || {}),
        [fingerprint]: {
          lastSuccessAt: now,
          accountId: account.id,
          receipt,
        },
      },
    });
    return { ok: true, account, consultation };
  } finally {
    inFlight.delete(flightKey);
  }
}

function resolveReactAuthor(who, actorId, context = {}) {
  const needle = clean(who);
  if (!needle) return null;
  const lowered = needle.toLowerCase();
  const user = context.user || {};
  const userNames = [user.id, 'user', user.name, user.nickname, user.displayName]
    .map((value) => clean(value).toLowerCase())
    .filter(Boolean);
  if (userNames.includes(lowered)) {
    return { id: clean(context.userId), isUser: true, isSelf: false, name: clean(user.name || user.nickname || '用户', 40) };
  }
  const actor = context.characters?.[actorId] || {};
  const selfNames = [
    actorId, 'self', '自己', '我', '本人',
    actor.name, actor.realName, actor.customNickname,
    ...(Array.isArray(actor.aliases) ? actor.aliases : []),
  ]
    .map((value) => clean(value).toLowerCase())
    .filter(Boolean);
  if (selfNames.includes(lowered)) {
    return {
      id: clean(actorId),
      isUser: false,
      isSelf: true,
      name: actorName(context.characters, actorId) || clean(actor.name || actorId, 40),
    };
  }
  const row = resolveConsultCharacter(needle, actorId, context.characters || {});
  return row
    ? { id: clean(row.id), isUser: false, isSelf: false, name: actorName(context.characters, row.id) }
    : null;
}

/** 统计一条朋友圈楼下用户评论与是否已被 replyTo。 */
export function collectUserMomentCommentMeta(post, userId, user = {}) {
  const userDisplayName = clean(user?.nickname || user?.name || user?.displayName || '用户', 40);
  const nameSet = new Set(
    [userDisplayName, user?.nickname, user?.name, user?.displayName, '用户']
      .map((value) => clean(value))
      .filter(Boolean),
  );
  const comments = Array.isArray(post?.comments) ? post.comments : [];
  const userComments = comments.filter((comment) => {
    if (clean(comment?.authorId) === clean(userId)) return true;
    return nameSet.has(clean(comment?.author));
  });
  const userNamesInThread = new Set(userComments.map((comment) => clean(comment.author)).filter(Boolean));
  if (!userNamesInThread.size && userComments.length) userNamesInThread.add(userDisplayName);
  const repliedToUser = comments.some((comment) => {
    if (clean(comment?.authorId) === clean(userId)) return false;
    return userNamesInThread.has(clean(comment?.replyTo));
  });
  const unrepliedUserComment = userComments.find((comment) => {
    const name = clean(comment.author) || userDisplayName;
    return !comments.some((other) => (
      clean(other?.authorId) !== clean(userId) && clean(other?.replyTo) === name
    ));
  }) || null;
  return {
    hasUserComment: userComments.length > 0,
    unrepliedUserComment,
    repliedToUser,
    userDisplayName: [...userNamesInThread][0] || userDisplayName,
  };
}

/** 评论时优先楼中楼回用户；尤其角色自己朋友圈楼下有用户留言。 */
export function resolveMomentReactReplyTo({
  action,
  post,
  actorId,
  userId,
  user = {},
} = {}) {
  if (clean(action).toLowerCase() !== 'comment' || !post) return '';
  const meta = collectUserMomentCommentMeta(post, userId, user);
  if (!meta.hasUserComment) return '';
  const postIsOwn = clean(post.authorId) === clean(actorId);
  // 用户有评论：必回（自己动态优先，别人动态楼下用户留言同样接）。
  if (postIsOwn || meta.unrepliedUserComment || !meta.repliedToUser) {
    return meta.userDisplayName;
  }
  return meta.userDisplayName;
}

/**
 * 点赞/评论后是否排延时私聊回访。
 * - 动作用在用户动态 / 回了用户评论：一定回访
 * - 其他（别人动态上的安静互动）：按与用户的关系标签疏密决定
 */
export function shouldScheduleMomentReactPrivateFollowup({
  targetAuthorIsUser = false,
  repliedToUser = false,
  action = '',
  relationLabel = '',
  userRelationStatus = '',
} = {}) {
  if (targetAuthorIsUser || repliedToUser) return true;
  const relation = clean(relationLabel || userRelationStatus);
  if (!relation) return clean(action).toLowerCase() === 'comment';
  if (/陌生|路人|不认识|刚认识|仅认识|普通同事|点头之交/.test(relation)) return false;
  return true;
}

export function buildMomentReactFollowupDirective({
  action = '',
  targetAuthor = null,
  replyTo = '',
  postContent = '',
  postIsOwn = false,
} = {}) {
  const snippet = clean(postContent, 120);
  const who = targetAuthor?.isUser
    ? '对方'
    : (clean(targetAuthor?.name, 40) || '朋友');
  if (clean(action).toLowerCase() === 'like') {
    if (targetAuthor?.isUser) {
      return [
        `你刚才给对方的朋友圈点了赞${snippet ? `（内容大概是：${snippet}）` : ''}。`,
        '现在回到私聊，按人格自然提一句或接着之前的话头；不要汇报“系统让我点赞”。',
      ].join('\n');
    }
    return [
      `你刚才给${who}的朋友圈点了赞${snippet ? `（内容大概是：${snippet}）` : ''}。`,
      '若按你们的关系距离值得提，就在私聊里随口带一句；不熟就别硬提。不要说系统提醒。',
    ].join('\n');
  }
  if (replyTo || postIsOwn || targetAuthor?.isUser) {
    const where = postIsOwn ? '自己的朋友圈' : `${who}的朋友圈`;
    return [
      `你刚才在${where}楼下回复了对方${replyTo ? `（回复 ${replyTo}）` : ''}，评论已经留下。`,
      '现在回到私聊，可以轻轻提一句「刚回了你」或接着评论里的话头；不要复述系统提示。',
    ].join('\n');
  }
  return [
    `你刚才在${who}的朋友圈留了评${snippet ? `（动态大概：${snippet}）` : ''}。`,
    '若关系够近、值得带一嘴，私聊里随口提；否则可以当没发生。不要说系统提醒。',
  ].join('\n');
}

function scoreMomentPostForReact(post, {
  actorId,
  userId,
  user,
  action,
} = {}) {
  if (clean(action).toLowerCase() !== 'comment') return 0;
  const meta = collectUserMomentCommentMeta(post, userId, user);
  if (!meta.hasUserComment) return 0;
  const ownBoost = clean(post.authorId) === clean(actorId) ? 50 : 0;
  if (meta.unrepliedUserComment || !meta.repliedToUser) return 100 + ownBoost;
  return 40 + ownBoost;
}

async function reactOnMomentPost({
  userId,
  actorId,
  action,
  text,
  targetAuthor,
  characters,
  now,
  user = {},
}) {
  const { listMomentPostsForAuthor, putMomentPost } = await import('../moments/moments-store.js');
  const posts = (await listMomentPostsForAuthor(userId, targetAuthor.id).catch(() => []))
    .filter((post) => post?.id
      && now - Number(post.timestamp || 0) < SOCIAL_REACT_POST_WINDOW_MS
      && !(Array.isArray(post.hiddenFromIds) ? post.hiddenFromIds : []).includes(actorId))
    .sort((a, b) => {
      const scoreDiff = scoreMomentPostForReact(b, {
        actorId, userId, user, action,
      }) - scoreMomentPostForReact(a, {
        actorId, userId, user, action,
      });
      if (scoreDiff) return scoreDiff;
      return Number(b.timestamp || 0) - Number(a.timestamp || 0);
    });
  const post = posts[0];
  if (!post) return { ok: false, reason: 'react-target-post-not-found' };
  const selfName = actorName(characters, actorId) || 'TA';
  const postIsOwn = clean(post.authorId) === clean(actorId);
  const postContent = clean(post.content, 220);
  if (action === 'like') {
    const likesIds = Array.isArray(post.likesIds) ? [...post.likesIds] : [];
    if (likesIds.includes(actorId)) {
      return {
        ok: true, reused: true, postId: post.id, postIsOwn, postContent, repliedToUser: false, replyTo: '',
      };
    }
    likesIds.push(actorId);
    const likes = Array.isArray(post.likes) ? [...post.likes] : [];
    if (!likes.includes(selfName)) likes.push(selfName);
    await putMomentPost({ ...post, likes, likesIds }, userId);
    return {
      ok: true, postId: post.id, postIsOwn, postContent, repliedToUser: false, replyTo: '',
    };
  }
  const replyTo = resolveMomentReactReplyTo({
    action, post, actorId, userId, user,
  });
  const comments = Array.isArray(post.comments) ? [...post.comments] : [];
  comments.push({
    author: selfName,
    authorId: actorId,
    text: clean(text, 120),
    replyTo,
  });
  await putMomentPost({ ...post, comments }, userId);
  return {
    ok: true,
    postId: post.id,
    postIsOwn,
    postContent,
    replyTo,
    repliedToUser: Boolean(replyTo),
  };
}

async function reactOnWeiboPost({ userId, actorId, action, text, targetAuthor, characters, now }) {
  const posts = (await dbGetAllByIndex('weiboPosts', 'authorId', targetAuthor.id).catch(() => []))
    .filter((post) => post?.id
      && isActiveWeiboPost(post)
      && clean(post.ownerUserId) === clean(userId)
      && now - Number(post.timestamp || 0) < SOCIAL_REACT_POST_WINDOW_MS)
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const post = posts[0];
  if (!post) return { ok: false, reason: 'react-target-post-not-found' };
  const selfName = actorName(characters, actorId) || 'TA';
  const metadata = post.metadata && typeof post.metadata === 'object' ? { ...post.metadata } : {};
  if (action === 'like') {
    const likedBy = Array.isArray(metadata.chatReactLikedBy) ? [...metadata.chatReactLikedBy] : [];
    if (likedBy.includes(actorId)) return { ok: true, reused: true, postId: post.id };
    likedBy.push(actorId);
    metadata.chatReactLikedBy = likedBy;
    await dbPut('weiboPosts', { ...post, likes: Math.max(0, Number(post.likes || 0)) + 1, metadata });
    return { ok: true, postId: post.id };
  }
  const hotComments = Array.isArray(post.hotComments) ? [...post.hotComments] : [];
  hotComments.push({ author: selfName, content: clean(text, 120), likes: 0 });
  await dbPut('weiboPosts', {
    ...post,
    hotComments: hotComments.slice(-12),
    comments: Math.max(0, Number(post.comments || 0)) + 1,
    metadata,
  });
  return { ok: true, postId: post.id };
}

export async function dispatchSocialReactIntent(event, context = {}, overrides = {}) {
  const deps = runtimeDeps(overrides);
  const userId = clean(context.userId);
  const actorId = clean(event?.from);
  const target = clean(event?.target).toLowerCase();
  const action = clean(event?.action).toLowerCase();
  const chat = context.chat || null;
  if (!userId || !actorId
    || !['moments', 'weibo'].includes(target)
    || !['like', 'comment'].includes(action)
    || (action === 'comment' && !clean(event?.text))
    || !isNormalOwnedPrivateChat(chat, userId, actorId)) {
    deps.warn({
      code: 'social-react-unsupported-context',
      message: '当前会话不支持角色点赞/评论动态',
      context: { userId, actorId, target, action, chatId: chat?.id || '' },
    });
    return { ok: false, reason: 'unsupported-source-context' };
  }
  const targetAuthor = resolveReactAuthor(event?.who, actorId, { ...context, userId });
  if (!targetAuthor?.id) {
    deps.warn({
      code: 'social-react-who-unresolved',
      message: '没找到要互动的对象动态，已安全跳过',
      context: { userId, actorId, who: clean(event?.who), chatId: chat.id },
    });
    return { ok: false, reason: 'react-who-unresolved' };
  }
  const receipt = intentReceiptId(event, context);
  const ledgerKey = `chatIntentReact_${stableIntentHash(`${userId}|${actorId}`)}`;
  if (inFlight.has(ledgerKey)) return { ok: false, reason: 'in-flight' };
  inFlight.add(ledgerKey);
  try {
    const state = await deps.readLedger(ledgerKey);
    const now = Number(deps.now()) || Date.now();
    if ((state.receipts || []).includes(receipt)) return { ok: true, reason: 'already-completed', reused: true };
    if (Number(state.lastSuccessAt || 0) > 0
      && now - Number(state.lastSuccessAt) < SOCIAL_REACT_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown' };
    }
    const budget = await deps.consumeSocialBudget(userId, actorId, chat.id);
    if (!budget?.ok) return { ok: false, reason: budget?.reason || 'budget-unavailable' };
    const args = {
      userId,
      actorId,
      action,
      text: clean(event?.text, 200),
      targetAuthor,
      characters: context.characters || {},
      now,
      user: context.user || {},
    };
    const reactAdapter = deps.reactAdapters?.[target]
      || (target === 'moments' ? reactOnMomentPost : reactOnWeiboPost);
    const result = await reactAdapter(args);
    if (!result?.ok) {
      deps.warn({
        code: 'social-react-target-missing',
        message: '没找到可互动的近期动态，点赞/评论已跳过',
        context: { userId, actorId, target, who: targetAuthor.id, reason: result?.reason || '' },
      });
      return result || { ok: false, reason: 'react-failed' };
    }
    await deps.writeLedger(ledgerKey, {
      lastSuccessAt: now,
      receipts: [...new Set([...(state.receipts || []).slice(-19), receipt])],
      lastPostId: clean(result.postId),
    });
    let followup = null;
    if (target === 'moments' && !result.reused) {
      const character = context.characters?.[actorId] || {};
      const shouldFollow = shouldScheduleMomentReactPrivateFollowup({
        targetAuthorIsUser: targetAuthor.isUser === true,
        repliedToUser: result.repliedToUser === true,
        action,
        relationLabel: context.chatPrefs?.relationLabel || '',
        userRelationStatus: character.userRelationStatus || '',
      });
      if (shouldFollow) {
        const seed = parseInt(stableIntentHash(receipt), 36) || now;
        const delayMinutes = 3 + (seed % 8);
        const pacingNow = await getPacingNowForUser(userId);
        const sceneDirective = buildMomentReactFollowupDirective({
          action,
          targetAuthor,
          replyTo: result.replyTo || '',
          postContent: result.postContent || '',
          postIsOwn: result.postIsOwn === true,
        });
        followup = await deps.enqueuePendingAction({
          userId,
          characterId: actorId,
          chatId: chat.id,
          kind: 'delayed_reply',
          dueAt: pacingNow + delayMinutes * 60 * 1000,
          createdAt: pacingNow,
          dedupeKey: `moment-react-followup:${chat.id}:${result.postId}:${action}`,
          payload: {
            sceneDirective,
            reason: action === 'like' ? '刚点了个赞' : '刚评论了动态',
            sourceIntentReceipt: receipt,
          },
        }).catch(() => null);
      }
    }
    return { ...result, target, action, followup };
  } finally {
    inFlight.delete(ledgerKey);
  }
}

export async function dispatchShareBackIntent(event, context = {}, overrides = {}) {
  const deps = runtimeDeps(overrides);
  const userId = clean(context.userId);
  const actorId = clean(event?.from);
  const topic = clean(event?.topic, 200);
  const chat = context.chat || null;
  if (!userId || !actorId || !isNormalOwnedPrivateChat(chat, userId, actorId)) {
    return { ok: false, reason: 'unsupported-source-context' };
  }
  const receipt = intentReceiptId(event, context);
  const ledgerKey = `chatIntentShareBack_${stableIntentHash(`${userId}|${actorId}`)}`;
  if (inFlight.has(ledgerKey)) return { ok: false, reason: 'in-flight' };
  inFlight.add(ledgerKey);
  try {
    const state = await deps.readLedger(ledgerKey);
    const now = Number(deps.now()) || Date.now();
    if ((state.receipts || []).includes(receipt)) return { ok: true, reason: 'already-completed', reused: true };
    if (Number(state.lastSuccessAt || 0) > 0
      && now - Number(state.lastSuccessAt) < SHARE_BACK_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown' };
    }
    const seed = parseInt(stableIntentHash(receipt), 36) || now;
    const delayMinutes = 4 + (seed % 9);
    const pacingNow = await getPacingNowForUser(userId);
    const sceneDirective = [
      `你之前说要去网上/论坛刷一会儿${topic ? `（想看：${topic}）` : ''}，现在刷完回来了。`,
      '优先从上文的兴趣/分享素材块里挑一条真实内容或链接分享给对方：有真实完整 URL 才用 link 事件且逐字照抄；没有可用素材就用大白话说说大概刷到了什么，不要编造可点开、可查证的具体链接或标题。',
      '自然接回之前的话头，交出具体发现和角色自己的反应；消息数量与分条服从【回复节奏 · 错落】，不要汇报式罗列。',
    ].join('\n');
    const enqueue = await deps.enqueuePendingAction({
      userId,
      characterId: actorId,
      chatId: chat.id,
      kind: 'delayed_reply',
      dueAt: pacingNow + delayMinutes * 60 * 1000,
      createdAt: pacingNow,
      dedupeKey: `share-back:${chat.id}`,
      payload: { topic, sceneDirective, reason: topic ? `去刷${topic}` : '去刷论坛' },
    });
    if (!enqueue?.ok) return { ok: false, reason: enqueue?.reason || 'enqueue-failed' };
    await deps.writeLedger(ledgerKey, {
      lastSuccessAt: now,
      receipts: [...new Set([...(state.receipts || []).slice(-19), receipt])],
    });
    return { ok: true, delayMinutes, action: enqueue.action };
  } finally {
    inFlight.delete(ledgerKey);
  }
}

export async function dispatchAliasPokeIntent(event, context = {}, overrides = {}) {
  const deps = runtimeDeps(overrides);
  const userId = clean(context.userId);
  const actorId = clean(event?.from);
  const chat = context.chat || null;
  if (!userId || !actorId || !isNormalOwnedPrivateChat(chat, userId, actorId)) {
    return { ok: false, reason: 'unsupported-source-context' };
  }
  const receipt = intentReceiptId(event, context);
  const ledgerKey = `chatIntentAliasPoke_${stableIntentHash(`${userId}|${actorId}`)}`;
  if (inFlight.has(ledgerKey)) return { ok: false, reason: 'in-flight' };
  inFlight.add(ledgerKey);
  try {
    const state = await deps.readLedger(ledgerKey);
    const now = Number(deps.now()) || Date.now();
    if ((state.receipts || []).includes(receipt)) return { ok: true, reason: 'already-completed', reused: true };
    if (Number(state.lastSuccessAt || 0) > 0
      && now - Number(state.lastSuccessAt) < ALIAS_POKE_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown' };
    }
    const accounts = (await deps.listAliasAccounts(actorId, userId).catch(() => []))
      .filter((row) => row?.id && row.status === 'active');
    if (!accounts.length) {
      deps.warn({
        code: 'alias-poke-no-alias',
        message: '该角色还没有可用马甲，小号动作已跳过',
        context: { userId, actorId, chatId: chat.id },
      });
      return { ok: false, reason: 'alias-poke-no-alias' };
    }
    const budget = await deps.consumeSocialBudget(userId, actorId, chat.id);
    if (!budget?.ok) return { ok: false, reason: budget?.reason || 'budget-unavailable' };
    // 已完善（有昵称/账号/头像）的号可强制复用；不完整时退回按角色选号的通用链路。
    const complete = accounts.find((row) => clean(row.displayName)
      && clean(row.handle)
      && (clean(row.avatar) || clean(row.avatarPrompt)));
    const run = await deps.generateAliasPoke({
      force: true,
      forceCharacterIds: [actorId],
      forceAliasId: complete?.id || '',
      sourceChatId: chat.id,
    }).catch((error) => ({ ok: false, reason: String(error?.message || error || 'failed') }));
    if (!run?.ok) {
      deps.warn({
        code: 'alias-poke-generation-failed',
        message: '小号消息未能生成，聊天回复已正常保留',
        context: { userId, actorId, chatId: chat.id, reason: run?.reason || 'empty' },
      });
      return { ok: false, reason: run?.reason || 'alias-poke-empty' };
    }
    await deps.writeLedger(ledgerKey, {
      lastSuccessAt: now,
      receipts: [...new Set([...(state.receipts || []).slice(-19), receipt])],
    });
    return { ok: true, results: run.results || [] };
  } finally {
    inFlight.delete(ledgerKey);
  }
}

export async function dispatchInteractionPlanIntent(event, context = {}, overrides = {}) {
  const deps = runtimeDeps(overrides);
  const userId = clean(context.userId);
  const actorId = clean(event?.from);
  const idea = clean(event?.idea, 500);
  const chat = context.chat || null;
  if (!userId || !actorId || !idea || !isNormalOwnedPrivateChat(chat, userId, actorId)) {
    return { ok: false, reason: 'unsupported-source-context' };
  }
  if (context.chatPrefs?.interactionProactiveEnabled !== true) {
    return { ok: false, reason: 'interaction-proactive-disabled' };
  }
  const currentPrefs = await deps.loadChatPrefs(chat.id).catch(() => null);
  if (currentPrefs?.interactionProactiveEnabled !== true) {
    return { ok: false, reason: 'interaction-proactive-disabled' };
  }
  const { normalizeChatInteractionSession } = await import('../chat-interactions.js');
  if (normalizeChatInteractionSession(currentPrefs.interactionSession)) {
    return { ok: false, reason: 'interaction-already-active' };
  }
  if (currentPrefs?.interactionDraft?.plan) {
    return { ok: false, reason: 'interaction-draft-pending' };
  }
  const afterMinutes = Math.max(5, Math.min(10080, Math.round(Number(event?.afterMinutes || 30) || 30)));
  const pacingNow = Number(await deps.getPacingNowForUser(userId).catch(() => 0))
    || Number(deps.now())
    || Date.now();
  const dueAt = pacingNow + afterMinutes * 60 * 1000;
  const scheduled = await deps.enqueuePendingAction({
    userId,
    characterId: actorId,
    chatId: chat.id,
    kind: 'interaction_invite',
    dueAt,
    dedupeKey: `interaction-invite:${chat.id}:${actorId}`,
    payload: {
      title: clean(event?.title, 48),
      idea,
      note: clean(event?.note, 320),
      sourceAiRoundId: clean(context.aiRoundId, 160),
    },
  });
  return scheduled?.ok
    ? { ...scheduled, dueAt, afterMinutes }
    : { ok: false, reason: scheduled?.reason || 'interaction-schedule-failed' };
}

const INTENT_DISPATCHERS = Object.freeze({
  social_post: dispatchSocialPostIntent,
  open_alias: dispatchOpenAliasIntent,
  social_react: dispatchSocialReactIntent,
  share_back: dispatchShareBackIntent,
  alias_poke: dispatchAliasPokeIntent,
  interaction_plan: dispatchInteractionPlanIntent,
});

export async function executeChatIntentSideEffects(events = [], context = {}, overrides = {}) {
  const intentEvents = (Array.isArray(events) ? events : [])
    .filter((event) => typeof INTENT_DISPATCHERS[event?.t] === 'function');
  const results = [];
  for (const event of intentEvents) {
    let result;
    try {
      result = await INTENT_DISPATCHERS[event.t](event, context, overrides);
    } catch (error) {
      const deps = runtimeDeps(overrides);
      deps.warn({
        code: 'chat-intent-side-effect-failed',
        message: '角色的旁路动作执行失败，聊天回复已正常保留',
        context: {
          chatId: context.chat?.id || context.chatId || '',
          aiRoundId: context.aiRoundId || '',
          eventType: event.t,
          error: String(error?.message || error || ''),
        },
      });
      result = { ok: false, reason: 'failed', error };
    }
    if (event.t === 'social_post') {
      try {
        await persistSocialPostIntentStatus(event, result, context);
      } catch (error) {
        appendDebugEvent({
          type: 'social_post_status_persist_failed',
          level: 'warn',
          message: '朋友圈发布结果未能同步到聊天回执',
          context: {
            chatId: context.chat?.id || context.chatId || '',
            messageId: event.placeholderMessageId || '',
            error: String(error?.message || error || ''),
          },
        });
      }
    }
    results.push({ event, result });
  }
  return results;
}
