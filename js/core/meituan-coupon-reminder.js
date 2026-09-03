/**
 * 美团优惠素材与提醒。
 *
 * 自然分享只读取已经由可信接口写入的真实活动；是否提起、怎么说由当前聊天里的角色决定。
 * 定时催领是独立的可选兜底，不处理手机号、短信验证码或美团登录凭证。
 */
import * as db from './db.js';
import { createMessage } from '../models/chat.js';
import { getCharacter } from './character-store.js';
import {
  bumpChatUnread,
  ensurePrivateChat,
  saveMessage,
  updateChatPreview,
} from './chat-store.js';
import { shouldSuppressAiDelivery } from './chat-block-state.js';
import {
  isCharacterAutonomyMutedNow,
  loadResolvedCharacterAutonomyPolicy,
} from './character-autonomy-settings.js';
import { dateKeyInUserTimezone, getZonedDateParts } from './user-timezone.js';
import { getUserTimezone } from './time-mode.js';
import {
  notifyCharacterSentMessageIfEnabled,
  shouldNotifyForBackgroundReason,
} from './native-notifications.js';
import {
  reserveProactiveDelivery,
  settleProactiveDelivery,
} from './character-proactive-usage.js';

export const MEITUAN_COUPON_REMINDER_CHECK_MS = 60 * 1000;
export const MEITUAN_COUPON_VENUE_URL = 'https://click.meituan.com/t?t=1&c=2&p=Zcjq1Lxzawjj';
const REMINDER_WINDOW_MINUTES = 3 * 60;
const OFFER_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const OFFER_MAX_COUNT = 24;
const TRUSTED_OFFER_SOURCE_KINDS = new Set([
  'meituan-official-skill',
  'meituan-official-api',
]);

function settingsKey(userId = '') {
  return `meituanCouponReminder_${String(userId || '').trim()}`;
}

function offersKey(userId = '') {
  return `meituanOfferMaterials_${String(userId || '').trim()}`;
}

function cleanTime(value = '') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return '10:00';
  const hour = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minute = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeMeituanCouponReminderConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 2,
    enabled: source.enabled === true,
    scheduledReminderEnabled: source.scheduledReminderEnabled === true,
    minimumOfferScore: Math.max(40, Math.min(90, Number(source.minimumOfferScore || 65) || 65)),
    characterId: String(source.characterId || '').trim().slice(0, 120),
    time: cleanTime(source.time),
    lastSentDateKey: String(source.lastSentDateKey || '').trim().slice(0, 20),
    lastSentAt: Math.max(0, Number(source.lastSentAt || 0) || 0),
  };
}

export async function loadMeituanCouponReminderConfig(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return normalizeMeituanCouponReminderConfig();
  const row = await db.get(settingsKey(id)).catch(() => null);
  return normalizeMeituanCouponReminderConfig(row?.value);
}

export async function saveMeituanCouponReminderConfig(userId = '', patch = {}) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('缺少用户身份');
  const previous = await loadMeituanCouponReminderConfig(id);
  const next = normalizeMeituanCouponReminderConfig({ ...previous, ...patch });
  if (next.scheduledReminderEnabled && !next.characterId) throw new Error('请先选择定时提醒角色');
  await db.put({ key: settingsKey(id), value: next });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meituan-coupon-reminder-changed', {
      detail: { userId: id, enabled: next.enabled },
    }));
  }
  return next;
}

export function resolveMeituanCouponReminderDue(config = {}, now = Date.now(), timeZone = '') {
  const normalized = normalizeMeituanCouponReminderConfig(config);
  const dateKey = dateKeyInUserTimezone(now, timeZone);
  if (!normalized.enabled || !normalized.scheduledReminderEnabled || !normalized.characterId) {
    return { due: false, reason: 'disabled', dateKey };
  }
  if (normalized.lastSentDateKey === dateKey) return { due: false, reason: 'already-sent', dateKey };
  const [hour, minute] = normalized.time.split(':').map(Number);
  const parts = getZonedDateParts(now, timeZone);
  const currentMinute = parts.hour * 60 + parts.minute;
  const targetMinute = hour * 60 + minute;
  if (currentMinute < targetMinute) return { due: false, reason: 'too-early', dateKey };
  if (currentMinute >= targetMinute + REMINDER_WINDOW_MINUTES) {
    return { due: false, reason: 'expired-window', dateKey };
  }
  return { due: true, reason: 'due', dateKey };
}

function cleanOfferText(value = '', max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function deriveOfferScore(source = {}) {
  const explicit = Number(source.valueScore ?? source.offerScore);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, explicit));
  const originalPrice = Math.max(0, Number(source.originalPrice || 0) || 0);
  const finalPrice = Math.max(0, Number(source.finalPrice || 0) || 0);
  const savings = Math.max(0, Number(source.savings || (originalPrice > finalPrice ? originalPrice - finalPrice : 0)) || 0);
  const ratio = originalPrice > 0 ? savings / originalPrice : 0;
  return Math.max(0, Math.min(100, Math.round((ratio * 70) + (Math.min(savings, 30) / 30 * 30))));
}

export function normalizeMeituanOfferMaterial(raw = {}, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const title = cleanOfferText(source.title || source.name, 100);
  const brand = cleanOfferText(source.brand || source.merchantName, 60);
  const sourceName = cleanOfferText(source.sourceName || source.source, 40);
  const sourceKind = cleanOfferText(source.sourceKind, 40).toLowerCase();
  const verifiedAt = Math.max(0, Number(source.verifiedAt || source.fetchedAt || 0) || 0);
  const endsAt = Math.max(0, Number(source.endsAt || source.expiresAt || 0) || 0);
  return {
    id: cleanOfferText(source.id || `${brand}:${title}:${endsAt}`, 160),
    title,
    brand,
    category: cleanOfferText(source.category, 40),
    summary: cleanOfferText(source.summary || source.description, 240),
    city: cleanOfferText(source.city, 40),
    url: /^https:\/\//i.test(String(source.url || '').trim()) ? String(source.url).trim().slice(0, 800) : '',
    sourceName,
    sourceKind,
    sourceUrl: /^https:\/\//i.test(String(source.sourceUrl || '').trim()) ? String(source.sourceUrl).trim().slice(0, 800) : '',
    originalPrice: Math.max(0, Number(source.originalPrice || 0) || 0),
    finalPrice: Math.max(0, Number(source.finalPrice || 0) || 0),
    savings: Math.max(0, Number(source.savings || 0) || 0),
    startsAt: Math.max(0, Number(source.startsAt || 0) || 0),
    endsAt,
    verifiedAt,
    offerScore: deriveOfferScore(source),
    verified: source.verified === true
      && TRUSTED_OFFER_SOURCE_KINDS.has(sourceKind)
      && !!sourceName
      && verifiedAt > 0
      && verifiedAt <= now + 5 * 60 * 1000,
  };
}

export async function saveMeituanOfferMaterials(userId = '', offers = [], now = Date.now()) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('缺少用户身份');
  const normalized = (Array.isArray(offers) ? offers : [])
    .map((offer) => normalizeMeituanOfferMaterial(offer, now))
    .filter((offer) => offer.id && offer.title && offer.verified)
    .slice(0, OFFER_MAX_COUNT);
  await db.put({ key: offersKey(id), value: { version: 1, updatedAt: now, offers: normalized } });
  return normalized;
}

export async function loadMeituanOfferMaterials(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return [];
  const row = await db.get(offersKey(id)).catch(() => null);
  return (Array.isArray(row?.value?.offers) ? row.value.offers : [])
    .map((offer) => normalizeMeituanOfferMaterial(offer));
}

function formatPrice(value = 0) {
  const amount = Number(value || 0);
  if (!(amount > 0)) return '';
  return Number.isInteger(amount) ? `${amount}元` : `${amount.toFixed(2)}元`;
}

export function buildMeituanOfferDecisionBlock({ config = {}, offers = [], recentText = '', now = Date.now() } = {}) {
  const normalizedConfig = normalizeMeituanCouponReminderConfig(config);
  if (!normalizedConfig.enabled) return '';
  const recent = String(recentText || '').toLowerCase();
  const eligible = (Array.isArray(offers) ? offers : [])
    .map((offer) => normalizeMeituanOfferMaterial(offer, now))
    .filter((offer) => offer.verified)
    .filter((offer) => now - offer.verifiedAt <= OFFER_MAX_AGE_MS)
    .filter((offer) => !offer.startsAt || offer.startsAt <= now)
    .filter((offer) => !offer.endsAt || offer.endsAt > now)
    .filter((offer) => offer.offerScore >= normalizedConfig.minimumOfferScore)
    .filter((offer) => ![offer.title, offer.brand].filter(Boolean).some((term) => recent.includes(term.toLowerCase())))
    .sort((a, b) => b.offerScore - a.offerScore)
    .slice(0, 3);
  if (!eligible.length) return '';
  const lines = eligible.map((offer, index) => {
    const price = [
      offer.originalPrice ? `原价${formatPrice(offer.originalPrice)}` : '',
      offer.finalPrice ? `到手${formatPrice(offer.finalPrice)}` : '',
      offer.savings ? `约省${formatPrice(offer.savings)}` : '',
    ].filter(Boolean).join('，');
    return [
      `${index + 1}. ${[offer.brand, offer.title].filter(Boolean).join(' · ')}`,
      offer.summary,
      price,
      offer.city ? `适用城市：${offer.city}` : '',
      offer.endsAt ? `截止时间：${new Date(offer.endsAt).toISOString()}` : '',
      `优惠力度：${offer.offerScore}/100`,
      `核验来源：${offer.sourceName}`,
      offer.url ? `活动入口：${offer.url}` : '',
    ].filter(Boolean).join('；');
  });
  return [
    '【真实优惠素材 · 只作可选生活信息】',
    ...lines,
    '',
    '先结合长期记忆里的用户口味、品牌偏好、预算、忌口、过敏、控糖/减脂与最近消费判断是否匹配；负面偏好和健康限制优先。',
    '是否分享由当前角色自己决定：必须符合性格、关系和眼前话题；不匹配或插入生硬就完全不提，不要为了使用素材打断聊天。最多自然分享一项，不要罗列，不要写广告口号。',
    '只能陈述上面明确给出的事实；不得把“可领/可能适用”说成已领取，不得补造门店、库存、折扣、口味或用户去过的经历。地域或门店资格未确认时要明确保留。',
    '如果决定分享，用角色自己的发现和关心方式自然说；活动入口只在用户表现出兴趣、询问详情或确实准备下单时再给。',
  ].join('\n');
}

export async function buildMeituanNaturalShareContext({ userId = '', recentMessages = [], now = Date.now() } = {}) {
  const id = String(userId || '').trim();
  if (!id) return '';
  const [config, offers] = await Promise.all([
    loadMeituanCouponReminderConfig(id),
    loadMeituanOfferMaterials(id),
  ]);
  const recentText = (Array.isArray(recentMessages) ? recentMessages : [])
    .slice(-40)
    .map((message) => String(message?.content || message?.metadata?.text || ''))
    .join('\n');
  return buildMeituanOfferDecisionBlock({ config, offers, recentText, now });
}

export function buildMeituanCouponReminderMessage({ dateKey = '', characterId = '', hour = 10 } = {}) {
  const variants = hour < 12
    ? [
      '早，提醒你一下：今天要用美团的话，可以先看看有没有合适的券。',
      '差点忘了说，今天如果准备点东西，先去看看美团有没有能用的券。',
      '路过提醒一下，美团今天有没有合适的优惠，可以先瞄一眼。',
    ]
    : hour < 18
      ? [
        '提醒你一下，今天要用美团的话，先看看有没有合适的券。',
        '如果等会儿准备点东西，记得先看看美团有没有能用的券。',
        '顺手提醒你，美团今天的券和活动可以去看一眼。',
      ]
      : [
        '晚上如果准备点东西，记得先看看美团有没有合适的券。',
        '提醒一下，今天的美团券还可以去看一眼，用得上再领。',
        '别急着直接下单，先看看美团今天有没有能用的券。',
      ];
  const seed = `${dateKey}:${characterId}`;
  const hash = [...seed].reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) >>> 0, 0);
  return `${variants[hash % variants.length]}\n${MEITUAN_COUPON_VENUE_URL}`;
}

async function isCharacterBusy(userId, characterId) {
  try {
    const { isCharacterBusyInOfflineSession } = await import('./character-phone-proactive.js');
    return await isCharacterBusyInOfflineSession(userId, characterId);
  } catch (_) {
    return false;
  }
}

export async function runMeituanCouponReminderCheck(user, now = Date.now(), reason = '') {
  if (!user?.id) return { ok: false, reason: 'missing-user' };
  const config = await loadMeituanCouponReminderConfig(user.id);
  const timeZone = await getUserTimezone(user.id).catch(() => String(user.timezone || ''));
  const due = resolveMeituanCouponReminderDue(config, now, timeZone);
  if (!due.due) return { ok: true, skipped: true, reason: due.reason };

  const character = await getCharacter(config.characterId, { userId: user.id }).catch(() => null);
  if (!character) return { ok: true, skipped: true, reason: 'missing-character' };
  const policy = await loadResolvedCharacterAutonomyPolicy(user.id, config.characterId).catch(() => null);
  if (policy?.totalEnabled !== true) return { ok: true, skipped: true, reason: 'proactive-disabled' };
  if (await isCharacterAutonomyMutedNow(user.id, config.characterId, now)) {
    return { ok: true, skipped: true, reason: 'mute-hours' };
  }
  if (await isCharacterBusy(user.id, config.characterId)) {
    return { ok: true, skipped: true, reason: 'active-offline-session' };
  }

  const characterName = String(character.customNickname || character.name || 'TA').trim() || 'TA';
  const chat = await ensurePrivateChat(user.id, config.characterId, characterName);
  const blocked = await shouldSuppressAiDelivery(chat);
  if (blocked.blocked) return { ok: true, skipped: true, reason: 'blocked-by-user' };

  const reservation = await reserveProactiveDelivery({
    userId: user.id,
    characterId: config.characterId,
    chatId: chat.id,
    channel: 'meituan-coupon',
    reason: 'scheduled-reminder',
    idempotencyKey: `meituan-coupon:${due.dateKey}`,
    now,
    policy,
  });
  if (!reservation?.ok) {
    return { ok: true, skipped: true, reason: reservation?.reason || 'proactive-reservation-failed' };
  }

  const hour = getZonedDateParts(now, timeZone).hour;
  const content = buildMeituanCouponReminderMessage({
    dateKey: due.dateKey,
    characterId: config.characterId,
    hour,
  });
  const message = createMessage({
    id: `msg_meituan_coupon_${encodeURIComponent(user.id)}_${due.dateKey}`,
    chatId: chat.id,
    senderId: config.characterId,
    senderName: characterName,
    type: 'text',
    content,
    timestamp: now,
    metadata: {
      source: 'meituan-coupon-reminder',
      factualState: 'reminder-only',
      externalUrl: MEITUAN_COUPON_VENUE_URL,
    },
  });
  try {
    await saveMessage(message);
    await updateChatPreview(chat.id, content, now);
    await saveMeituanCouponReminderConfig(user.id, {
      lastSentDateKey: due.dateKey,
      lastSentAt: now,
    });
    await settleProactiveDelivery({
      userId: user.id,
      characterId: config.characterId,
      reservationId: reservation.reservationId,
      ok: true,
      reason: 'sent',
      messageCount: 1,
      now,
    });
  } catch (error) {
    await settleProactiveDelivery({
      userId: user.id,
      characterId: config.characterId,
      reservationId: reservation.reservationId,
      ok: false,
      reason: 'persist-failed',
      error: error?.message || String(error || 'failed'),
      now,
    }).catch(() => {});
    throw error;
  }

  if (shouldNotifyForBackgroundReason(reason, chat.id)) {
    await bumpChatUnread(chat.id, 1).catch(() => {});
    await notifyCharacterSentMessageIfEnabled({
      characterName,
      chatId: chat.id,
      tag: `meituan-coupon-${user.id}-${due.dateKey}`,
      messages: [message],
      requireHidden: false,
      avatar: character.avatar || '',
    }).catch(() => {});
  }
  return { ok: true, generated: true, characterId: config.characterId, chatId: chat.id, message };
}
