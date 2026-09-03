import { get as dbGet, put as dbPut } from '../db.js';
import { getNowForUser } from '../time-mode.js';
import { dateKeyFromTimestamp } from '../character-phone-store.js';
import { ensureDefaultUser, getCurrentUserId } from '../user-slot.js';
import {
  loadMomentsPrefs,
  allocMomentTimestamp,
  putMomentPost,
  confirmMomentPostsForUser,
} from './moments-store.js';
import { buildMomentsActors, sampleActorIds } from './moments-actors.js';
import {
  claimEnsembleResource,
  loadEnsembleModeConfig,
  settleEnsembleResource,
} from '../ensemble-mode.js';

/**
 * 朋友圈自动生成：定时批次 + 对话后触发。
 * 真正的生成节流靠状态记录（间隔 + 每日批次上限），外层探测器可以随便密集喊。
 */

// 探测频率：只是「醒来看一眼到没到点」，到点才真的调 AI
export const MOMENTS_AUTO_CHECK_MS = 10 * 60 * 1000;

const POST_CHAT_COOLDOWN_MS = 45 * 60 * 1000;
const POST_CHAT_PROBABILITY = 0.35;

let autoInFlight = false;
let postChatTriggerBound = false;

function stateKey(userId) {
  return `momentsAutoGenState_${String(userId || 'guest').trim()}`;
}

async function loadState(userId) {
  const row = await dbGet(stateKey(userId)).catch(() => null);
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    dateKey: String(v.dateKey || ''),
    batches: Number(v.batches) || 0,
    lastRunAt: Number(v.lastRunAt) || 0,
    lastPostChatAt: Number(v.lastPostChatAt) || 0,
  };
}

async function saveState(userId, state) {
  await dbPut({ key: stateKey(userId), value: state }).catch(() => {});
}

function autoImageOptions(autoGen) {
  return {
    allowLifePhoto: autoGen.allowImages === true,
    allowPersonPhoto: false,
    allowTextImage: autoGen.allowTextImages === true,
    allowStickers: autoGen.allowStickers !== false,
    imageStyleId: '',
  };
}

async function resolveAuthorPool(user, autoGen, { preferIds = [] } = {}) {
  const { characterIds } = await buildMomentsActors(user);
  const all = new Set(characterIds);
  const configured = (autoGen.authorIds || []).filter((id) => all.has(id));
  const base = configured.length ? configured : characterIds;
  // 对话后触发时把刚聊过的角色顶到池子前面（若在允许名单内），发圈更可能与刚才那场对话有关
  const preferred = preferIds.filter((id) => base.includes(id));
  const rest = sampleActorIds(base.filter((id) => !preferred.includes(id)), 8);
  return [...preferred, ...rest].slice(0, 8);
}

async function generateAndStore(user, autoGen, { count, preferIds = [] } = {}) {
  let authorIds = await resolveAuthorPool(user, autoGen, { preferIds });
  if (!authorIds.length) return 0;
  const ensembleEnabled = (await loadEnsembleModeConfig(user.id).catch(() => ({ enabled: false }))).enabled === true;
  const ensembleResource = ensembleEnabled
    ? await claimEnsembleResource({
      userId: user.id,
      target: 'moments',
      preferredAuthorIds: authorIds,
    }).catch(() => null)
    : null;
  if (ensembleResource?.authorId) {
    authorIds = [
      ensembleResource.authorId,
      ...authorIds.filter((id) => id !== ensembleResource.authorId),
    ];
  }
  const { aiGenerateMomentsFeedBatch } = await import('./moments-ai.js');
  let generated = [];
  try {
    generated = await aiGenerateMomentsFeedBatch({
      user,
      authorIds,
      count: ensembleResource ? 1 : count,
      commentLevel: autoGen.reactionCommentLevel,
      imageOptions: autoImageOptions(autoGen),
      intentSeed: ensembleResource?.brief || '',
      sourceChatId: ensembleResource?.sourceChatId || '',
    });
  } catch (error) {
    if (ensembleResource?.id) {
      await settleEnsembleResource(user.id, ensembleResource.id, false).catch(() => null);
    }
    throw error;
  }
  let ensembleResourcePublished = false;
  const insertedPosts = [];
  try {
    for (let i = 0; i < generated.length; i += 1) {
      if (String(await getCurrentUserId() || '').trim() !== String(user.id || '').trim()) {
        throw new Error('moments-user-mismatch');
      }
      const ts = await allocMomentTimestamp(user.id);
      const generatedPost = generated[i];
      const inserted = await putMomentPost({
        id: `moment_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
        timestamp: ts,
        visibility: 'all',
        ...generatedPost,
        metadata: {
          ...(generatedPost?.metadata || {}),
          ...(ensembleResource?.id ? {
            ensembleResourceId: ensembleResource.id,
            ensembleEventId: ensembleResource.eventId,
            ensembleSourceChatId: ensembleResource.sourceChatId,
          } : {}),
        },
        userId: user.id,
      }, user.id);
      insertedPosts.push(inserted);
    }
    ensembleResourcePublished = generated.some(
      (post) => String(post?.authorId || '').trim() === ensembleResource?.authorId,
    );
  } finally {
    if (ensembleResource?.id) {
      await settleEnsembleResource(
        user.id,
        ensembleResource.id,
        ensembleResourcePublished,
      ).catch(() => null);
    }
  }
  const confirmedPosts = await confirmMomentPostsForUser(user.id, insertedPosts);
  if (confirmedPosts.length && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('moments-auto-generated', {
      detail: {
        count: confirmedPosts.length,
        userId: user.id,
        postIds: confirmedPosts.map((post) => post.id),
        posts: confirmedPosts,
      },
    }));
  }
  return confirmedPosts.length;
}

/** 定时批次：到点且没超每日上限才真的生成 */
export async function runMomentsAutoCheck(reason = 'timer', suppliedUser = null) {
  if (autoInFlight) return { ok: false, reason: 'in-flight' };
  autoInFlight = true;
  try {
    const user = suppliedUser || await ensureDefaultUser();
    const prefs = await loadMomentsPrefs(user.id).catch(() => null);
    const autoGen = prefs?.autoGen;
    if (!autoGen?.enabled) return { ok: false, reason: 'disabled' };

    const now = Date.now();
    const virtualNow = await getNowForUser(user.id).catch(() => now);
    const todayKey = dateKeyFromTimestamp(virtualNow);
    const state = await loadState(user.id);
    const batchesToday = state.dateKey === todayKey ? state.batches : 0;

    if (now - state.lastRunAt < autoGen.intervalHours * 3600_000) {
      return { ok: false, reason: 'interval-not-due' };
    }
    if (batchesToday >= autoGen.dailyMaxBatches) {
      return { ok: false, reason: 'daily-cap' };
    }

    const count = autoGen.autoPostCount;
    const stored = await generateAndStore(user, autoGen, { count });
    await saveState(user.id, {
      dateKey: todayKey,
      batches: batchesToday + (stored ? 1 : 0),
      lastRunAt: now,
      lastPostChatAt: state.lastPostChatAt,
    });
    return { ok: true, reason, stored };
  } catch (err) {
    console.warn('[moments-auto] auto generation failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    autoInFlight = false;
  }
}

/** 对话后触发：概率 + 冷却 + 与定时批次共享每日上限 */
export async function runPostChatMomentsTrigger({ userId = '', partnerIds = [] } = {}) {
  if (autoInFlight) return { ok: false, reason: 'in-flight' };
  autoInFlight = true;
  try {
    const user = await ensureDefaultUser();
    if (userId && user.id !== userId) return { ok: false, reason: 'user-mismatch' };
    const prefs = await loadMomentsPrefs(user.id).catch(() => null);
    const autoGen = prefs?.autoGen;
    if (!autoGen?.enabled || !autoGen.postChatTrigger) return { ok: false, reason: 'disabled' };

    const now = Date.now();
    const virtualNow = await getNowForUser(user.id).catch(() => now);
    const todayKey = dateKeyFromTimestamp(virtualNow);
    const state = await loadState(user.id);
    const batchesToday = state.dateKey === todayKey ? state.batches : 0;

    if (now - state.lastPostChatAt < POST_CHAT_COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
    if (batchesToday >= autoGen.dailyMaxBatches) return { ok: false, reason: 'daily-cap' };
    if (Math.random() > POST_CHAT_PROBABILITY) {
      // 没抽中也刷新冷却？不——没抽中不消耗冷却，下一场对话还有机会
      return { ok: false, reason: 'dice' };
    }

    const count = 1 + Math.floor(Math.random() * 2);
    const stored = await generateAndStore(user, autoGen, {
      count,
      preferIds: (partnerIds || []).filter(Boolean),
    });
    await saveState(user.id, {
      dateKey: todayKey,
      batches: batchesToday + (stored ? 1 : 0),
      lastRunAt: state.lastRunAt,
      lastPostChatAt: now,
    });
    return { ok: true, stored };
  } catch (err) {
    console.warn('[moments-auto] post-chat generation failed', err);
    return { ok: false, reason: err?.message || String(err || 'failed') };
  } finally {
    autoInFlight = false;
  }
}

/** 监听 AI 回合完成事件（幕后/无 user 会话不触发），延迟几秒错开主对话流量 */
export function initMomentsPostChatTrigger() {
  if (postChatTriggerBound || typeof window === 'undefined') return;
  postChatTriggerBound = true;
  window.addEventListener('marshmallow-ai-round-complete', (e) => {
    const detail = e?.detail || {};
    if (detail.userPresent !== true) return;
    window.setTimeout(() => {
      runPostChatMomentsTrigger({
        userId: detail.userId,
        partnerIds: Array.isArray(detail.partnerIds) ? detail.partnerIds : [],
      }).catch(() => {});
    }, 8000);
  });
}
