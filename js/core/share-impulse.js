/**
 * 分享冲动：让「主动分享/提起社媒内容」有一个自然的触发节奏，
 * 而不是把可分享素材常驻塞在上下文里指望模型自己挑时机。
 *
 * 三路触发信号，命中任意一路都会激活（不互斥，同一天防打转的注入次数/熄火共用一套状态）：
 * - 随机窗口：每天随机掷「今天想不想分享点什么」（概率取自角色的 shareEagerness 主动性档位），
 *   命中则随机选一个当天的时间窗口（WINDOW_MINUTES 长），不限定在白天——上班摸鱼/通勤路上/夜聊
 *   都算正常时机，唯一要避开的是角色真的在睡觉的时段（见下面"睡眠时间"）。
 * - 已读不回破冰：角色发的最后一条消息，用户超过 coldReplyHours 小时没回，允许拿分享当由头破冰。
 * - 分享间隔：距上次真的分享出去已经超过 shareIntervalHours 小时（含从没分享过），允许主动分享一次，
 *   不用死等随机窗口——这也覆盖"没别的话题时可以拿来兜底"的诉求：反正攒够时间就该聊一次。
 * 两个小时阈值可在兴趣页按角色单独调（loadShareImpulseSettings/saveShareImpulseSettings）。
 *
 * 睡眠时间兜底：三路信号命中后，还会再查一次角色当前日程骨架里标了 isSleep=true 的那一段
 * （character-phone-store.js#isCharacterAsleepAt）——真的在睡就整体按掉，不管是随机窗口还是
 * 破冰/间隔兜底都不会在这时候点亮；没有日程数据时按凌晨 2~6 点保守兜底。除了这一段，
 * 全天（包括上班时间）都可能被点亮，不再额外画一条"只能在白天"的线。
 *
 * 一天可以触发几次由角色的 shareDailyTarget（每天最多分享几条）决定：每消耗一次冲动
 * （consumeShareImpulse），只要当天次数还没到目标，立刻重新掷一轮新的冲动窗口，而不是
 * 直接给这一天判死刑——这样"每天分享几条"才会真的体现在触发节奏上，而不仅仅是精搜攒了几条。
 *
 * 三路都只在真有目标（用户新动态没聊过 / 深读帖没分享过）时才会真正注入提示块，
 * 防打转：单轮冲动最多注入 MAX_INJECTIONS 次提示就自动熄火；角色真的发出链接时
 * 由 ai-round 调 consumeShareImpulse 立即熄火（并视情况开启下一轮）。
 *
 * 由头（摸鱼/通勤/睡前刷手机…）不在这里生成——主模型上下文里本来就有角色当前
 * 日程时段，提示块只要求它结合日程自己想一个自然的由头，不额外调用小模型。
 */
import * as db from './db.js';
import {
  markUserSocialPostMentioned, loadUserSocialWatchSettings, listUserSocialPosts, isFreshUserSocialPost,
} from './user-social-watch.js';
import { findPrivateChat, listMessagesForChat } from './chat-store.js';
import {
  listVerifiedPosts,
  collectRecentSharedTopics,
  isLowQualityPooledPost,
  isFreshSharePost,
} from './interest-search-orchestrator.js';
import {
  listInterestEntries,
  loadInterestTrackingSettings,
  SHARE_EAGERNESS_PROBABILITY,
} from './character-interest-table.js';
import { isCharacterAsleepAt } from './character-phone-store.js';

const WINDOW_MINUTES = 150;
const MAX_INJECTIONS = 3;
const DEFAULT_COLD_REPLY_HOURS = 6;
const DEFAULT_SHARE_INTERVAL_HOURS = 48;
const HOUR_MS = 3600000;

/** 每角色每天最多分享几条 + 主动性档位，读取失败时按最保守的出厂默认兜底。 */
async function loadSharePace(userId, characterId) {
  const tracking = await loadInterestTrackingSettings(userId, characterId).catch(() => null);
  const dailyTarget = Number.isFinite(tracking?.shareDailyTarget) ? tracking.shareDailyTarget : 1;
  const probability = SHARE_EAGERNESS_PROBABILITY[tracking?.shareEagerness] ?? SHARE_EAGERNESS_PROBABILITY.normal;
  return { dailyTarget, probability };
}

/**
 * 掷一轮新的冲动窗口：命中则随机选当天剩余时间里一段 WINDOW_MINUTES 长的窗口，不再限定
 * 必须在某个钟点前——摸鱼、深夜都可能是窗口；真正的睡眠时段由 getShareImpulseForNow 里
 * 的 isCharacterAsleepAt 实时按掉，这里不用提前猜。
 */
function rollImpulseCycle(nowTs, probability) {
  const nowMin = minutesOfDay(nowTs);
  const active = Math.random() < probability;
  let windowStart = 0;
  let windowEnd = 0;
  if (active) {
    const dayMax = 24 * 60 - 1;
    windowStart = nowMin + Math.floor(Math.random() * Math.max(1, dayMax - nowMin + 1));
    windowEnd = Math.min(24 * 60, windowStart + WINDOW_MINUTES);
  }
  return {
    active, windowStart, windowEnd, injectedCount: 0, consumedAt: 0, target: null,
  };
}

function stateKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `shareImpulse_${uid}_${cid}`;
}

function settingsKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `shareImpulseSettings_${uid}_${cid}`;
}

function dayKeyOf(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesOfDay(ts = Date.now()) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

async function loadState(userId, characterId) {
  const row = await db.get('settings', stateKey(userId, characterId)).catch(() => null);
  return row?.value && typeof row.value === 'object' ? row.value : null;
}

async function saveState(userId, characterId, state) {
  await db.put('settings', { key: stateKey(userId, characterId), value: state });
  return state;
}

/** 单角色可调阈值：多久没回算「已读不回」、多久没分享算「该主动分享一次了」。 */
export async function loadShareImpulseSettings(userId, characterId) {
  const row = await db.get('settings', settingsKey(userId, characterId)).catch(() => null);
  const v = row?.value || {};
  return {
    coldReplyHours: Number(v.coldReplyHours) > 0 ? Number(v.coldReplyHours) : DEFAULT_COLD_REPLY_HOURS,
    shareIntervalHours: Number(v.shareIntervalHours) > 0 ? Number(v.shareIntervalHours) : DEFAULT_SHARE_INTERVAL_HOURS,
  };
}

export async function saveShareImpulseSettings(userId, characterId, patch = {}) {
  const current = await loadShareImpulseSettings(userId, characterId);
  const next = {
    coldReplyHours: Number(patch.coldReplyHours) > 0 ? Number(patch.coldReplyHours) : current.coldReplyHours,
    shareIntervalHours: Number(patch.shareIntervalHours) > 0 ? Number(patch.shareIntervalHours) : current.shareIntervalHours,
  };
  await db.put('settings', { key: settingsKey(userId, characterId), value: next });
  return next;
}

/** 角色发的最后一条消息，用户已经晾了超过 hours 小时没回——允许拿分享当破冰由头。 */
async function isColdReplyDue(userId, characterId, nowTs, hours) {
  try {
    const chat = await findPrivateChat(userId, characterId);
    if (!chat?.id) return false;
    const recent = await listMessagesForChat(chat.id, 1).catch(() => []);
    const last = recent[recent.length - 1];
    if (!last || last.deleted || last.recalled) return false;
    if (String(last.senderId || '') !== String(characterId || '')) return false;
    return nowTs - Number(last.timestamp || 0) >= hours * HOUR_MS;
  } catch (_) {
    return false;
  }
}

/**
 * 距上次真正分享/提起过已经超过 hours 小时（含从没分享过），且手里确实有能分享的东西——
 * 精搜深读帖和「关注小红书」抓到的用户动态两个素材来源都算，不然只开了关注小红书、没开
 * 精搜的角色，攒了动态也永远等不到这一路信号，只能靠概率很低的随机窗口去带。
 */
async function isShareIntervalDue(userId, characterId, nowTs, hours) {
  try {
    const [pool, entries, watchSettings] = await Promise.all([
      listVerifiedPosts(userId, characterId).catch(() => []),
      listInterestEntries(userId, characterId).catch(() => []),
      loadUserSocialWatchSettings(userId, characterId).catch(() => null),
    ]);
    const quietKeywords = new Set(entries.filter((e) => e.surfaceMode === 'quiet').map((e) => e.keyword));
    const hasVerifiedTarget = pool.some((p) => p.depth === 'read' && !p.sharedAt && p.url
      && isFreshSharePost(p, nowTs) && !quietKeywords.has(p.keyword) && !isLowQualityPooledPost(p));
    let socialPosts = [];
    if (watchSettings?.enabled) {
      socialPosts = await listUserSocialPosts(userId, characterId).catch(() => []);
    }
    // 常规上下文已经交付过的动态不再进入专属分享通道；只有新 noteId 才能重新触发。
    const hasSocialTarget = socialPosts.some(isFreshUserSocialPost);
    if (!hasVerifiedTarget && !hasSocialTarget) return false;
    const lastVerifiedSharedAt = pool.reduce((max, p) => Math.max(max, Number(p.sharedAt || 0)), 0);
    const lastSocialActivityAt = socialPosts.reduce(
      (max, p) => Math.max(max, Number(p.mentionedAt || 0), Number(p.lastSurfacedAt || 0)),
      0,
    );
    const lastActedAt = Math.max(lastVerifiedSharedAt, lastSocialActivityAt);
    return nowTs - lastActedAt >= hours * HOUR_MS;
  } catch (_) {
    return false;
  }
}

/**
 * 取当前的分享冲动状态；跨天时自动重掷随机窗口。nowTs 由调用方传（用聊天侧的 getNowForUser，
 * 尊重时间模式），这里不自己取时间。已读不回/分享间隔两路信号是实时判断，不受跨天重掷影响。
 */
export async function getShareImpulseForNow(userId, characterId, nowTs = Date.now()) {
  const dateKey = dayKeyOf(nowTs);
  const { dailyTarget, probability } = await loadSharePace(userId, characterId);
  let state = await loadState(userId, characterId);
  if (!state || state.dateKey !== dateKey) {
    state = { dateKey, firedCount: 0, ...rollImpulseCycle(nowTs, probability) };
    await saveState(userId, characterId, state);
  }
  const firedCount = Number(state.firedCount || 0);
  const canFire = firedCount < dailyTarget && !state.consumedAt && state.injectedCount < MAX_INJECTIONS;
  const nowMin = minutesOfDay(nowTs);
  const windowActive = state.active && nowMin >= state.windowStart && nowMin < state.windowEnd;

  let extraActive = false;
  if (canFire && !windowActive) {
    const settings = await loadShareImpulseSettings(userId, characterId);
    const [coldReplyActive, intervalActive] = await Promise.all([
      isColdReplyDue(userId, characterId, nowTs, settings.coldReplyHours),
      isShareIntervalDue(userId, characterId, nowTs, settings.shareIntervalHours),
    ]);
    extraActive = coldReplyActive || intervalActive;
  }

  let activeNow = canFire && (windowActive || extraActive);
  if (activeNow) {
    const asleep = await isCharacterAsleepAt(userId, characterId, nowTs).catch(() => false);
    if (asleep) activeNow = false;
  }
  return {
    ...state, dailyTarget, activeNow,
  };
}

/**
 * 冲动激活后，实际要分享的目标是什么：优先复用同一冲动周期已经锁定过的 target（避免中途换目标），
 * 没锁定过再按「用户小红书新动态 > 精搜深读帖」的优先级挑一个。返回 null 表示冲动亮着但手里其实
 * 没东西可分享，调用方不该为了这种情况白白拉起一轮对话。
 */
export async function resolveShareImpulseTarget(userId, characterId, impulse) {
  if (impulse?.target && impulse.target.kind !== 'verified_post') return impulse.target;
  if (impulse?.target?.kind === 'verified_post') {
    const [lockedPool, lockedEntries] = await Promise.all([
      listVerifiedPosts(userId, characterId).catch(() => []),
      listInterestEntries(userId, characterId).catch(() => []),
    ]);
    const quietKeywords = new Set(lockedEntries.filter((e) => e.surfaceMode === 'quiet').map((e) => e.keyword));
    const lockedPost = lockedPool.find((post) => post.url === impulse.target.id);
    if (lockedPost && !lockedPost.sharedAt && isFreshSharePost(lockedPost)
      && !quietKeywords.has(lockedPost.keyword) && !isLowQualityPooledPost(lockedPost)) {
      return impulse.target;
    }
    await saveState(userId, characterId, { ...impulse, target: null }).catch(() => {});
  }
  const watchSettings = await loadUserSocialWatchSettings(userId, characterId).catch(() => null);
  if (watchSettings?.enabled) {
    const posts = await listUserSocialPosts(userId, characterId).catch(() => []);
    // 只认主页本轮新抓到、从未交付过的动态；旧帖不会跨天重新成为分享目标。
    const fresh = posts.find(isFreshUserSocialPost);
    if (fresh) {
      return {
        kind: 'user_social',
        id: fresh.noteId,
        title: fresh.title || fresh.desc || '',
        secret: watchSettings.disclosureMode !== 'open',
        source: 'user_social',
        reason: '',
      };
    }
  }
  const [pool, entries] = await Promise.all([
    listVerifiedPosts(userId, characterId).catch(() => []),
    listInterestEntries(userId, characterId).catch(() => []),
  ]);
  // 话题冷却：最近几天刚分享过的话题面（topicTag）先跳过，避免连着几天都是同一类内容；
  // 全池都在冷却期时放开限制兜底（宁可同话题也别让分享冲动空转）。
  // 低质量旧存货（质检上线前入池的广告/应用商店页）任何情况下都不当分享目标。
  const cooledTopics = new Set(collectRecentSharedTopics(pool));
  const quietKeywords = new Set(entries.filter((e) => e.surfaceMode === 'quiet').map((e) => e.keyword));
  const shareable = (p) => p.depth === 'read' && !p.sharedAt && p.url
    && isFreshSharePost(p) && !quietKeywords.has(p.keyword) && !isLowQualityPooledPost(p);
  const candidates = pool.filter(shareable).sort((a, b) => Number(b.foundAt || 0) - Number(a.foundAt || 0));
  const candidate = candidates.find((p) => !p.topicTag || !cooledTopics.has(p.topicTag))
    || candidates[0];
  if (candidate) {
    return {
      kind: 'verified_post',
      id: candidate.url,
      title: candidate.title || candidate.summary || '',
      url: candidate.url,
      summary: candidate.summary || '',
      source: candidate.source || 'web',
      reason: candidate.reason || '',
    };
  }
  return null;
}

/**
 * 提示块每注入一次记一笔，并锁定这次冲动的目标（同一窗口内不换目标，避免每轮换一个想分享的东西）。
 * 注满 MAX_INJECTIONS 次自动熄火。
 */
export async function noteShareImpulseInjected(userId, characterId, target = null) {
  const state = await loadState(userId, characterId);
  if (!state) return;
  const next = {
    ...state,
    injectedCount: Number(state.injectedCount || 0) + 1,
    target: state.target || target || null,
  };
  await saveState(userId, characterId, next);
}

/**
 * 角色真的把内容分享/提起了（目前只在发出 link 事件时能可靠检测到）：本轮冲动立即熄火，
 * 目标如果是用户动态则同时打上「已聊过」标记；如果今天分享次数还没到 shareDailyTarget，
 * 立刻重新掷一轮新的冲动窗口，而不是直接让这一天不再有分享——这是"每天分享几条"的调度落点。
 */
export async function consumeShareImpulse(userId, characterId) {
  const state = await loadState(userId, characterId);
  if (!state || state.consumedAt) return;
  if (state.target?.kind === 'user_social' && state.target?.id) {
    await markUserSocialPostMentioned(userId, characterId, { noteId: state.target.id }).catch(() => {});
  }
  const firedCount = Number(state.firedCount || 0) + 1;
  const { dailyTarget, probability } = await loadSharePace(userId, characterId);
  if (firedCount < dailyTarget) {
    await saveState(userId, characterId, { ...state, ...rollImpulseCycle(Date.now(), probability), firedCount });
  } else {
    await saveState(userId, characterId, { ...state, firedCount, consumedAt: Date.now() });
  }
}
