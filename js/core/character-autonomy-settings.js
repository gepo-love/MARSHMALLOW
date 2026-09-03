/**
 * 角色主动行为统一策略。
 *
 * v1 只做惰性、可逆迁移：旧角色手机日程与 chat.autoActive 仍保留，
 * 新策略作为统一读取入口；写入时在可行范围内双写旧字段。
 */
import * as db from './db.js';
import { listChatsForUser, saveChat } from './chat-store.js';
import { isFixedFallbackChatEligible } from './fixed-fallback-policy.js';
import {
  getScheduleProactiveSettings,
  loadCharacterPhone,
  saveScheduleProactiveSettings,
} from './character-phone-store.js';
import { getZonedDateParts } from './user-timezone.js';

export const CHARACTER_AUTONOMY_SCHEMA_VERSION = 1;
export const AUTONOMY_FREQUENCY_PRESETS = ['low', 'normal', 'high', 'custom'];
export const AUTONOMY_TRIGGER_PRIORITY = [
  'due-explicit-action',
  'schedule-current-trigger',
  'interest-share',
  'cold-follow-up',
  'fixed-fallback',
];
/** 真人感「无输入后最少等多久再回」：未自定义时用内置 2.5 秒；自定义最少 1 秒，上限按天防溢出。 */
export const REAL_PERSON_IDLE_REPLY_FLOOR_DEFAULT_MS = 2500;
export const REAL_PERSON_IDLE_REPLY_FLOOR_MIN_SECONDS = 1;
export const REAL_PERSON_IDLE_REPLY_FLOOR_MAX_SECONDS = 24 * 60 * 60;
export const REAL_PERSON_IDLE_REPLY_FLOOR_DEFAULT_SECONDS = 3;
export const DEFAULT_PROACTIVE_DAILY_LIMIT = 20;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RECENT_GUARD_MS = 2 * 60 * 1000;
const activeGuards = new Set();
const recentGuards = new Map();

function cleanId(value = '') {
  return String(value ?? '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(asObject(object), key);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback)));
}

function positiveInt(value, fallback = DEFAULT_PROACTIVE_DAILY_LIMIT) {
  const number = Number(value);
  return Math.max(1, Math.round(Number.isFinite(number) ? number : fallback));
}

export function characterAutonomySettingsKey(userId, characterId) {
  return `characterAutonomySettings:v${CHARACTER_AUTONOMY_SCHEMA_VERSION}:${encodeURIComponent(cleanId(userId) || 'guest')}:${encodeURIComponent(cleanId(characterId) || 'unknown')}`;
}

export function characterIdForAutonomyChat(chat = {}) {
  if (chat?.type === 'group') return '';
  const participants = Array.isArray(chat?.participants) ? chat.participants : [];
  return cleanId(participants.find((id) => id && id !== 'user'));
}

function normalizeSchedule(value = {}) {
  const source = asObject(value);
  return {
    enabled: source.enabled === true,
    autoGenerate: source.autoGenerate === true,
    dailyCount: Math.max(0, Math.round(Number.isFinite(Number(source.dailyCount)) ? Number(source.dailyCount) : 1)),
    minGapMinutes: clampInt(source.minGapMinutes, 0, 1440, 20),
    busyReplyMode: source.busyReplyMode === 'auto' ? 'auto' : 'soft',
  };
}

function normalizeFallback(value = {}) {
  const source = asObject(value);
  return {
    enabled: source.enabled === true,
    intervalMs: clampInt(source.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    // 兼容旧记录保留此字段；触发层始终按真正的「日程不可用时兜底」解释。
    explicitEnabled: source.explicitEnabled === true,
  };
}

function normalizeMailboxProactive(value = {}) {
  const source = asObject(value);
  return {
    enabled: source.enabled === true,
    intervalHours: clampInt(source.intervalHours, 12, 720, 72),
  };
}

function normalizeRealPerson(value = {}) {
  const source = asObject(value);
  return {
    enabled: source.enabled === true,
    // 忙碌时是否让已登记的 auto_reply 以零 API 系统气泡挡刀；默认关闭，避免抢走正常真人感回复。
    systemAutoReplyEnabled: source.systemAutoReplyEnabled === true,
    // 允许 AI 在明确离线/断联剧情里登记硬静默；默认关闭，避免普通用户误遇长时间无回应。
    allowHardOffline: source.allowHardOffline === true,
    frequencyPreset: AUTONOMY_FREQUENCY_PRESETS.includes(source.frequencyPreset)
      ? source.frequencyPreset
      : 'normal',
    statusActivityLevel: ['quiet', 'natural', 'active'].includes(source.statusActivityLevel)
      ? source.statusActivityLevel
      : 'natural',
    idleReplyFloorEnabled: source.idleReplyFloorEnabled === true,
    idleReplyFloorSeconds: clampInt(
      source.idleReplyFloorSeconds,
      REAL_PERSON_IDLE_REPLY_FLOOR_MIN_SECONDS,
      REAL_PERSON_IDLE_REPLY_FLOOR_MAX_SECONDS,
      REAL_PERSON_IDLE_REPLY_FLOOR_DEFAULT_SECONDS,
    ),
  };
}

/** 「最小间隔=0」不再增加统一冷却，由追发等各条链路采用用户自己的间隔。 */
export function resolveEffectiveProactiveMinGapMinutes(policy = {}) {
  return Math.max(
    0,
    Math.min(1440, Math.round(Number(policy?.scheduleProactive?.minGapMinutes) || 0)),
  );
}

/** 无输入后接话的最短等待（毫秒）。未开自定义时用内置默认。 */
export function resolveRealPersonIdleReplyFloorMs(realPersonMode = {}) {
  const mode = normalizeRealPerson(realPersonMode);
  if (!mode.idleReplyFloorEnabled) return REAL_PERSON_IDLE_REPLY_FLOOR_DEFAULT_MS;
  return mode.idleReplyFloorSeconds * 1000;
}

function normalizeReferences(value = {}) {
  const source = asObject(value);
  return {
    interestEnabled: source.interestEnabled === true,
    shareEnabled: source.shareEnabled === true,
    interestSettingsKey: cleanId(source.interestSettingsKey),
    shareSettingsKey: cleanId(source.shareSettingsKey),
  };
}

/** 静音时段：0–23 点；支持跨午夜（如 23→7）。start===end 视为未生效。 */
export function normalizeMuteHours(value = {}) {
  const source = asObject(value);
  return {
    enabled: source.enabled === true,
    start: clampInt(source.start, 0, 23, 23),
    end: clampInt(source.end, 0, 23, 7),
  };
}

/**
 * 当前是否落在角色主动静音时段内（硬禁：不主动找人）。
 * @param {{ muteHours?: { enabled?: boolean, start?: number, end?: number } } | { enabled?: boolean, start?: number, end?: number }} policyOrMute
 */
export function isAutonomyMuteHourActive(policyOrMute = {}, now = Date.now(), timeZone = '') {
  const mute = normalizeMuteHours(
    hasOwn(policyOrMute, 'muteHours') ? policyOrMute.muteHours : policyOrMute,
  );
  if (!mute.enabled) return false;
  const hour = getZonedDateParts(now, timeZone).hour;
  const { start, end } = mute;
  if (start === end) return false;
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

function normalizeChatOverride(value = {}) {
  const source = asObject(value);
  const result = {};
  if (hasOwn(source, 'totalEnabled')) result.totalEnabled = source.totalEnabled === true;
  if (hasOwn(source, 'fixedFallback')) result.fixedFallback = normalizeFallback(source.fixedFallback);
  return result;
}

export function normalizeCharacterAutonomySettings(raw = {}, userId = '', characterId = '') {
  const source = asObject(raw);
  const defaults = asObject(source.roleDefaults);
  const overrides = asObject(source.chatOverrides);
  const legacySchedule = asObject(defaults.scheduleProactive);
  const proactiveDailyLimit = hasOwn(defaults, 'proactiveDailyLimit')
    ? positiveInt(defaults.proactiveDailyLimit)
    : (hasOwn(legacySchedule, 'dailyCount')
      ? positiveInt(legacySchedule.dailyCount)
      : DEFAULT_PROACTIVE_DAILY_LIMIT);
  return {
    schemaVersion: CHARACTER_AUTONOMY_SCHEMA_VERSION,
    userId: cleanId(userId || source.userId),
    characterId: cleanId(characterId || source.characterId),
    roleDefaults: {
      totalEnabled: defaults.totalEnabled === true,
      proactiveDailyLimit,
      scheduleProactive: normalizeSchedule(defaults.scheduleProactive),
      fixedFallback: normalizeFallback(defaults.fixedFallback),
      mailboxProactive: normalizeMailboxProactive(defaults.mailboxProactive),
      realPersonMode: normalizeRealPerson(defaults.realPersonMode),
      muteHours: normalizeMuteHours(defaults.muteHours),
      references: normalizeReferences(defaults.references),
    },
    chatOverrides: Object.fromEntries(
      Object.entries(overrides)
        .map(([chatId, value]) => [cleanId(chatId), normalizeChatOverride(value)])
        .filter(([chatId]) => chatId),
    ),
    migratedFromLegacy: source.migratedFromLegacy === true,
    updatedAt: Math.max(0, Number(source.updatedAt) || 0),
  };
}

function legacyChatValue(chat = {}) {
  return {
    enabled: chat.autoActive === true,
    intervalMs: clampInt(chat.autoInterval, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    explicitEnabled: chat.autoActive === true,
  };
}

/**
 * 纯迁移函数，供测试与惰性读取共用。
 * 相同 chat 值提升为角色默认；混合值逐 chat 留作例外，确保迁移前后逐窗一致。
 */
export function migrateLegacyCharacterAutonomy({
  userId = '',
  characterId = '',
  phone = {},
  chats = [],
  dailyScheduleEnabled = false,
  references = {},
} = {}) {
  const schedule = getScheduleProactiveSettings(phone);
  const relatedChats = (Array.isArray(chats) ? chats : []).filter((chat) => (
    cleanId(chat?.userId) === cleanId(userId)
    && isFixedFallbackChatEligible(chat)
    && Array.isArray(chat?.participants)
    && chat.participants.map(String).includes(cleanId(characterId))
  ));
  const values = relatedChats.map(legacyChatValue);
  const first = values[0] || normalizeFallback();
  const allEqual = values.length > 0 && values.every((value) => (
    value.enabled === first.enabled && value.intervalMs === first.intervalMs
  ));
  const defaultFallback = allEqual ? first : normalizeFallback();
  const chatOverrides = {};
  if (!allEqual) {
    relatedChats.forEach((chat, index) => {
      chatOverrides[chat.id] = { fixedFallback: values[index] };
    });
  }
  const anyLegacyEnabled = schedule.enabled === true || values.some((value) => value.enabled);
  return normalizeCharacterAutonomySettings({
    roleDefaults: {
      totalEnabled: anyLegacyEnabled,
      proactiveDailyLimit: schedule.enabled === true && hasOwn(schedule, 'dailyCount')
        ? positiveInt(schedule.dailyCount)
        : DEFAULT_PROACTIVE_DAILY_LIMIT,
      scheduleProactive: {
        enabled: schedule.enabled === true,
        autoGenerate: dailyScheduleEnabled === true,
        dailyCount: schedule.dailyCount,
        minGapMinutes: schedule.minGapMinutes,
        busyReplyMode: schedule.busyReplyMode,
      },
      fixedFallback: defaultFallback,
      realPersonMode: {},
      muteHours: {},
      references,
    },
    chatOverrides,
    migratedFromLegacy: true,
  }, userId, characterId);
}

function mergeSettings(current, patch) {
  const source = asObject(patch);
  const rolePatch = asObject(source.roleDefaults);
  return {
    ...current,
    ...source,
    roleDefaults: {
      ...current.roleDefaults,
      ...rolePatch,
      scheduleProactive: {
        ...current.roleDefaults.scheduleProactive,
        ...asObject(rolePatch.scheduleProactive),
      },
      fixedFallback: {
        ...current.roleDefaults.fixedFallback,
        ...asObject(rolePatch.fixedFallback),
      },
      mailboxProactive: {
        ...current.roleDefaults.mailboxProactive,
        ...asObject(rolePatch.mailboxProactive),
      },
      realPersonMode: {
        ...current.roleDefaults.realPersonMode,
        ...asObject(rolePatch.realPersonMode),
      },
      muteHours: {
        ...current.roleDefaults.muteHours,
        ...asObject(rolePatch.muteHours),
      },
      references: {
        ...current.roleDefaults.references,
        ...asObject(rolePatch.references),
      },
    },
    chatOverrides: {
      ...current.chatOverrides,
      ...asObject(source.chatOverrides),
    },
  };
}

export async function loadCharacterAutonomySettings(userId, characterId, options = {}) {
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  const key = characterAutonomySettingsKey(uid, cid);
  const row = await db.get('settings', key).catch(() => null);
  if (row?.value) return normalizeCharacterAutonomySettings(row.value, uid, cid);

  const [phone, chats] = await Promise.all([
    options.phone ? Promise.resolve(options.phone) : loadCharacterPhone(uid, cid).catch(() => ({})),
    options.chats ? Promise.resolve(options.chats) : listChatsForUser(uid).catch(() => []),
  ]);
  const migrated = migrateLegacyCharacterAutonomy({
    userId: uid,
    characterId: cid,
    phone,
    chats,
    dailyScheduleEnabled: options.dailyScheduleEnabled === true,
    references: options.references,
  });
  const value = { ...migrated, updatedAt: Date.now() };
  await db.put('settings', { key, value }).catch(() => {});
  return value;
}

export async function saveCharacterAutonomySettings(userId, characterId, patch = {}, options = {}) {
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  const current = await loadCharacterAutonomySettings(uid, cid, options);
  const next = normalizeCharacterAutonomySettings(
    { ...mergeSettings(current, patch), updatedAt: Date.now() },
    uid,
    cid,
  );
  await db.put('settings', { key: characterAutonomySettingsKey(uid, cid), value: next });

  if (options.dualWrite !== false && asObject(patch.roleDefaults).scheduleProactive) {
    const schedule = next.roleDefaults.scheduleProactive;
    await saveScheduleProactiveSettings(uid, cid, {
      enabled: schedule.enabled,
      dailyCount: schedule.dailyCount,
      minGapMinutes: schedule.minGapMinutes,
      busyReplyMode: schedule.busyReplyMode,
    }).catch(() => {});
  }
  if (options.dualWrite !== false && asObject(patch.roleDefaults).fixedFallback) {
    const chats = await listChatsForUser(uid).catch(() => []);
    const related = chats.filter((chat) => (
      Array.isArray(chat?.participants)
      && chat.participants.map(String).includes(cid)
    ));
    await Promise.all(related.map((chat) => {
      if (!isFixedFallbackChatEligible(chat)) {
        return saveChat({ ...chat, autoActive: false }).catch(() => chat);
      }
      const fallback = resolveCharacterAutonomyPolicy(next, chat.id).fixedFallback;
      return saveChat({
        ...chat,
        autoActive: fallback.enabled,
        autoInterval: fallback.intervalMs,
      }).catch(() => chat);
    }));
  }
  try {
    globalThis.window?.dispatchEvent?.(new CustomEvent('marshmallow-autonomy-changed', {
      detail: {
        userId: uid,
        characterId: cid,
        patch,
        settings: next,
        at: Date.now(),
      },
    }));
  } catch (_) { /* 设置已保存；旧 WebView 不支持事件时由下次读取兜底。 */ }
  return next;
}

export async function saveCharacterAutonomyChatOverride(userId, characterId, chat, patch = {}) {
  const chatId = cleanId(chat?.id);
  if (!chatId) throw new Error('chat.id required');
  const current = await loadCharacterAutonomySettings(userId, characterId);
  const previous = asObject(current.chatOverrides[chatId]);
  const override = normalizeChatOverride({
    ...previous,
    ...patch,
    fixedFallback: {
      ...asObject(previous.fixedFallback),
      ...asObject(patch.fixedFallback),
    },
  });
  const next = await saveCharacterAutonomySettings(userId, characterId, {
    chatOverrides: { [chatId]: override },
  }, { dualWrite: false });
  const fallback = resolveCharacterAutonomyPolicy(next, chatId).fixedFallback;
  await saveChat({
    ...chat,
    autoActive: isFixedFallbackChatEligible(chat) && fallback.enabled,
    autoInterval: fallback.intervalMs,
  });
  return next;
}

export function resolveCharacterAutonomyPolicy(settings, chatId = '') {
  const normalized = normalizeCharacterAutonomySettings(settings);
  const override = asObject(normalized.chatOverrides[cleanId(chatId)]);
  return {
    schemaVersion: normalized.schemaVersion,
    userId: normalized.userId,
    characterId: normalized.characterId,
    totalEnabled: hasOwn(override, 'totalEnabled')
      ? override.totalEnabled === true
      : normalized.roleDefaults.totalEnabled,
    proactiveDailyLimit: normalized.roleDefaults.proactiveDailyLimit,
    scheduleProactive: { ...normalized.roleDefaults.scheduleProactive },
    fixedFallback: {
      ...normalized.roleDefaults.fixedFallback,
      ...asObject(override.fixedFallback),
    },
    mailboxProactive: { ...normalized.roleDefaults.mailboxProactive },
    realPersonMode: { ...normalized.roleDefaults.realPersonMode },
    muteHours: { ...normalized.roleDefaults.muteHours },
    references: { ...normalized.roleDefaults.references },
    isChatOverride: Object.keys(override).length > 0,
  };
}

export async function loadResolvedCharacterAutonomyPolicy(userId, characterId, chatId = '', options = {}) {
  const settings = await loadCharacterAutonomySettings(userId, characterId, options);
  return resolveCharacterAutonomyPolicy(settings, chatId);
}

function alignProactiveChatOverrides(settings = {}, enabled = false) {
  return Object.fromEntries(
    Object.entries(asObject(settings.chatOverrides))
      .map(([chatId, override]) => [chatId, { ...asObject(override), totalEnabled: enabled === true }]),
  );
}

export async function saveCharacterProactiveEnabled(userId, characterId, enabled, options = {}) {
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  const turnOn = enabled === true;
  const current = await loadCharacterAutonomySettings(uid, cid, options);
  const settings = await saveCharacterAutonomySettings(uid, cid, {
    roleDefaults: {
      totalEnabled: turnOn,
      ...(turnOn && options.enableSchedule !== false
        ? { scheduleProactive: { enabled: true } }
        : {}),
    },
    chatOverrides: alignProactiveChatOverrides(current, turnOn),
  }, options);
  if (!turnOn) {
    await cancelCharacterProactiveWork(uid, cid);
  }
  return settings;
}

const PROACTIVE_AUTONOMY_PENDING_KINDS = new Set([
  'social_followup',
  'share_followup',
  'chase_beat',
  'cold_follow_up',
]);

const REAL_PERSON_AUTONOMY_PENDING_KINDS = new Set([
  'real_person_reply',
  'delayed_reply',
  'chase_beat',
  'cold_follow_up',
]);

async function cancelCharacterAutonomyWork(userId, characterId, pendingKinds) {
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  if (!uid || !cid) return;
  const chats = await listChatsForUser(uid).catch(() => []);
  const related = chats.filter((chat) => (
    chat?.id
    && Array.isArray(chat.participants)
    && chat.participants.map(String).includes(cid)
  ));
  const [{ abortHeadlessChatReply }, { cancelPendingActions }] = await Promise.all([
    import('./chat/headless-reply.js'),
    import('./chat/pending-actions.js'),
  ]);
  for (const chat of related) abortHeadlessChatReply(chat.id, 'autonomy-disabled');
  // Timers/cloud cleanup may use network or worker coordination; the persisted off switch and
  // execution-time policy gates are authoritative, so cleanup never delays the settings UI.
  void Promise.all([
    import('./background-scheduler.js')
      .then(({ unscheduleChat }) => related.forEach((chat) => unscheduleChat?.(chat.id))),
    import('./cloud-background-coordinator.js')
      .then(({ cancelCloudChatSchedules }) => Promise.all(
        related.map((chat) => cancelCloudChatSchedules?.(chat.id)),
      )),
  ]).catch(() => {});
  await cancelPendingActions(uid, (action) => (
    cleanId(action?.characterId) === cid
    && pendingKinds.has(String(action?.kind || ''))
  )).catch(() => {});
}

async function cancelCharacterProactiveWork(userId, characterId) {
  return cancelCharacterAutonomyWork(userId, characterId, PROACTIVE_AUTONOMY_PENDING_KINDS);
}

async function cancelRealPersonAutonomyWork(userId, characterId) {
  return cancelCharacterAutonomyWork(userId, characterId, REAL_PERSON_AUTONOMY_PENDING_KINDS);
}

/**
 * 真人感只控制对用户消息的自动接话；主动消息与自动日程都保持用户自己的独立选择。
 */
export async function saveRealPersonExperienceEnabled(userId, characterId, enabled, options = {}) {
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  const turnOn = enabled === true;
  const settings = await saveCharacterAutonomySettings(uid, cid, {
    roleDefaults: {
      realPersonMode: { enabled: turnOn },
    },
  }, options);
  if (!turnOn) {
    await cancelRealPersonAutonomyWork(uid, cid);
    return settings;
  }

  return settings;
}

/** 读取角色策略并判断当前是否在静音时段（供闲置续聊等独立链路复用）。 */
export async function isCharacterAutonomyMutedNow(userId, characterId, now = Date.now(), options = {}) {
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  if (!uid || !cid) return false;
  const policy = await loadResolvedCharacterAutonomyPolicy(uid, cid, '', options).catch(() => null);
  return isAutonomyMuteHourActive(policy || {}, now, options.timeZone || '');
}

/**
 * 统一触发优先级。明确约定优先于日程，日程 trigger 优先于普通联系；
 * fixedFallback 保留用户原有频率的普通主动机会，并由共享 guard / 冷却避免双发。
 */
export function resolveAutonomyTrigger(policy = {}, signals = {}) {
  if (policy.totalEnabled !== true) return { kind: 'none', reason: 'total-disabled' };
  const now = Number(signals.now) || Date.now();
  if (isAutonomyMuteHourActive(policy, now, signals.timeZone || '')) {
    return { kind: 'none', reason: 'mute-hours' };
  }
  const schedule = asObject(policy.scheduleProactive);
  const fixed = asObject(policy.fixedFallback);
  if (signals.dueExplicitAction) {
    return { kind: 'due-explicit-action', payload: signals.dueExplicitAction };
  }
  if (schedule.enabled && signals.scheduleUsable !== false && signals.currentScheduleTrigger) {
    return { kind: 'schedule-current-trigger', payload: signals.currentScheduleTrigger };
  }
  if (signals.interestShareDue) {
    return { kind: 'interest-share', payload: signals.interestShareDue };
  }
  if (signals.coldFollowUpDue) {
    return { kind: 'cold-follow-up', payload: signals.coldFollowUpDue };
  }
  // 固定间隔现在是“普通主动联系机会”，不再因为整段日程可用就永久熄火。
  // 真正的日程 trigger 已在上方优先拿走本轮；并发和刷屏仍由角色级 guard、共享冷却与额度控制。
  if (fixed.enabled === true && signals.fixedFallbackDue !== false) {
    return { kind: 'fixed-fallback', payload: signals.fixedFallbackDue || true };
  }
  return { kind: 'none', reason: 'no-trigger-due' };
}

/** 临时条件：应跳过本轮，但不要拆掉已挂好的本地/云端定时器。 */
export function isTemporaryAutonomySkipReason(reason = '') {
  return reason === 'mute-hours' || reason === 'schedule-first' || reason === 'no-trigger-due';}

function guardKey({ userId = '', characterId = '', chatId = '' } = {}) {
  return `${cleanId(userId)}:${cleanId(characterId)}:${cleanId(chatId)}`;
}

export function acquireCharacterAutonomyGuard(identity = {}, now = Date.now()) {
  const key = guardKey(identity);
  if (!key || activeGuards.has(key)) return null;
  const recentAt = Number(recentGuards.get(key) || 0);
  if (recentAt && now - recentAt < RECENT_GUARD_MS) return null;
  activeGuards.add(key);
  return { key };
}

export function releaseCharacterAutonomyGuard(guard, { generated = false, now = Date.now() } = {}) {
  if (!guard?.key) return;
  activeGuards.delete(guard.key);
  if (generated) recentGuards.set(guard.key, now);
}
