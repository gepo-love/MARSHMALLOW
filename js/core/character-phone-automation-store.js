/**
 * 角色手机自动化统一存储。
 *
 * 配置与运行状态使用不同的 settings 键，避免保存开关时覆盖调度进度。
 * 旧键仅在新键尚不存在时惰性读取；迁移不会删除或改写旧数据。
 */

import * as db from './db.js';

export const CHARACTER_PHONE_AUTOMATION_SCHEMA_VERSION = 1;

export const PHONE_CHAT_INTERVAL_MINUTES_MIN = 15;
export const PHONE_CHAT_INTERVAL_MINUTES_MAX = 1440;
export const PHONE_CHAT_DAILY_LIMIT_MAX = 30;
export const SCHEDULE_PROACTIVE_MIN_GAP_MINUTES_MAX = 240;
export const INTEREST_TRACK_INTERVAL_HOURS_MIN = 4;
export const INTEREST_TRACK_INTERVAL_HOURS_MAX = 72;
export const INTEREST_TRACK_CANDIDATES_MAX = 5;
export const SHARE_DAILY_TARGET_MAX = 20;

const SOCIAL_SEARCH_CHANNELS = ['xiaohongshu', 'weibo', 'bilibili'];
const SHARE_SEARCH_CHANNELS = ['web', 'xiaohongshu', 'weibo', 'bilibili'];
const SHARE_EAGERNESS_LEVELS = ['low', 'normal', 'high'];
const BUSY_REPLY_MODES = ['auto', 'soft'];

export function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : min;
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : safeFallback));
}

export function clampInteger(value, min, max, fallback = min) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Math.max(0, Math.round(Number.isFinite(number) ? number : fallback));
}

function cleanId(value, fallback = '') {
  return String(value ?? '').trim() || fallback;
}

function encodedId(value, fallback = '') {
  return encodeURIComponent(cleanId(value, fallback));
}

function configKey(userId, characterId) {
  return `characterPhoneAutomationConfig:${encodedId(userId, 'guest')}:${encodedId(characterId, 'unknown')}`;
}

function runtimeKey(userId, characterId) {
  return `characterPhoneAutomationRuntime:${encodedId(userId, 'guest')}:${encodedId(characterId, 'unknown')}`;
}

function legacyPhoneKey(userId, characterId) {
  return `characterPhone_${encodedId(userId, 'guest')}_${encodedId(characterId, 'unknown')}`;
}

function legacyPhoneChatKey(userId, characterId) {
  return `characterPhoneChatAuto:${cleanId(userId)}:${cleanId(characterId)}`;
}

function legacyPhoneChatRuntimeKey(userId, characterId) {
  return `characterPhoneChatAutoState:${cleanId(userId)}:${cleanId(characterId)}`;
}

function legacyInterestKey(userId, characterId) {
  return `characterInterestTracking_${encodedId(userId, 'guest')}_${encodedId(characterId)}`;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asStringList(value, max = 160) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))].slice(0, max);
}

function normalizeSocialSearchChannels(value) {
  const channels = asStringList(value).filter((channel) => SOCIAL_SEARCH_CHANNELS.includes(channel));
  return channels.length ? channels : [...SOCIAL_SEARCH_CHANNELS];
}

function normalizeShareSearchChannels(value) {
  const channels = asStringList(value).filter((channel) => SHARE_SEARCH_CHANNELS.includes(channel));
  return channels.length ? channels : [...SHARE_SEARCH_CHANNELS];
}

function defaultConfig(userId, characterId) {
  return {
    schemaVersion: CHARACTER_PHONE_AUTOMATION_SCHEMA_VERSION,
    userId: cleanId(userId),
    characterId: cleanId(characterId),
    dailySchedule: {
      enabled: false,
    },
    scheduleProactive: {
      enabled: false,
      dailyCount: 1,
      minGapMinutes: 20,
      busyReplyMode: 'soft',
    },
    phoneChatAuto: {
      enabled: false,
      intervalMinutes: 120,
      dailyLimit: 6,
      allowUser: true,
      allowPeers: true,
      allowGroups: true,
      allowProactive: false,
    },
    interestTrack: {
      autoTrackEnabled: false,
      autoTrackIntervalHours: 12,
      autoTrackCandidatesPerRound: 2,
      socialSearchChannels: [...SOCIAL_SEARCH_CHANNELS],
    },
    share: {
      sharePostSearchEnabled: false,
      shareDailyTarget: 1,
      shareEagerness: 'normal',
      avoidNotes: '',
      includeHotComments: false,
      shareSearchChannels: [...SHARE_SEARCH_CHANNELS],
      setupCardDismissed: false,
    },
  };
}

function normalizeConfig(raw, userId, characterId) {
  const source = asObject(raw);
  const defaults = defaultConfig(userId, characterId);
  const dailySchedule = asObject(source.dailySchedule);
  const scheduleProactive = asObject(source.scheduleProactive);
  const phoneChatAuto = asObject(source.phoneChatAuto);
  const interestTrack = asObject(source.interestTrack);
  const share = asObject(source.share);

  return {
    ...source,
    ...defaults,
    dailySchedule: {
      ...dailySchedule,
      enabled: dailySchedule.enabled === true,
    },
    scheduleProactive: {
      ...scheduleProactive,
      enabled: scheduleProactive.enabled === true,
      dailyCount: nonNegativeInteger(scheduleProactive.dailyCount, defaults.scheduleProactive.dailyCount),
      minGapMinutes: clampInteger(
        scheduleProactive.minGapMinutes,
        0,
        SCHEDULE_PROACTIVE_MIN_GAP_MINUTES_MAX,
        defaults.scheduleProactive.minGapMinutes,
      ),
      busyReplyMode: BUSY_REPLY_MODES.includes(scheduleProactive.busyReplyMode)
        ? scheduleProactive.busyReplyMode
        : defaults.scheduleProactive.busyReplyMode,
    },
    phoneChatAuto: {
      ...phoneChatAuto,
      enabled: phoneChatAuto.enabled === true,
      intervalMinutes: clampInteger(
        phoneChatAuto.intervalMinutes,
        PHONE_CHAT_INTERVAL_MINUTES_MIN,
        PHONE_CHAT_INTERVAL_MINUTES_MAX,
        defaults.phoneChatAuto.intervalMinutes,
      ),
      dailyLimit: clampInteger(
        phoneChatAuto.dailyLimit,
        1,
        PHONE_CHAT_DAILY_LIMIT_MAX,
        defaults.phoneChatAuto.dailyLimit,
      ),
      // 旧版开启自动回复时三个权限均为默认允许；缺失字段必须继续允许。
      allowUser: phoneChatAuto.allowUser !== false,
      allowPeers: phoneChatAuto.allowPeers !== false,
      allowGroups: phoneChatAuto.allowGroups !== false,
      // 默认不在没有新消息的窗口独角戏；主动开话题须由用户明确允许。
      allowProactive: phoneChatAuto.allowProactive === true,
    },
    interestTrack: {
      ...interestTrack,
      autoTrackEnabled: interestTrack.autoTrackEnabled === true,
      autoTrackIntervalHours: clampInteger(
        interestTrack.autoTrackIntervalHours,
        INTEREST_TRACK_INTERVAL_HOURS_MIN,
        INTEREST_TRACK_INTERVAL_HOURS_MAX,
        defaults.interestTrack.autoTrackIntervalHours,
      ),
      autoTrackCandidatesPerRound: clampInteger(
        interestTrack.autoTrackCandidatesPerRound,
        1,
        INTEREST_TRACK_CANDIDATES_MAX,
        defaults.interestTrack.autoTrackCandidatesPerRound,
      ),
      socialSearchChannels: normalizeSocialSearchChannels(interestTrack.socialSearchChannels),
    },
    share: {
      ...share,
      sharePostSearchEnabled: share.sharePostSearchEnabled === true,
      shareDailyTarget: clampInteger(
        share.shareDailyTarget,
        0,
        SHARE_DAILY_TARGET_MAX,
        defaults.share.shareDailyTarget,
      ),
      shareEagerness: SHARE_EAGERNESS_LEVELS.includes(share.shareEagerness)
        ? share.shareEagerness
        : defaults.share.shareEagerness,
      avoidNotes: String(share.avoidNotes ?? '').trim().slice(0, 200),
      includeHotComments: share.includeHotComments === true,
      shareSearchChannels: normalizeShareSearchChannels(share.shareSearchChannels),
      setupCardDismissed: share.setupCardDismissed === true,
    },
    schemaVersion: CHARACTER_PHONE_AUTOMATION_SCHEMA_VERSION,
    userId: cleanId(userId),
    characterId: cleanId(characterId),
  };
}

function defaultRuntime(userId, characterId) {
  return {
    schemaVersion: CHARACTER_PHONE_AUTOMATION_SCHEMA_VERSION,
    userId: cleanId(userId),
    characterId: cleanId(characterId),
    dailySchedule: {},
    scheduleProactive: {
      lastRunDate: '',
      triggeredKeys: [],
      lastTriggeredAt: 0,
      lastStatus: '',
      runningSlotKey: '',
      runningAt: 0,
      runHistory: [],
    },
    phoneChatAuto: {
      day: '',
      count: 0,
      lastRunAt: 0,
      lastChatId: '',
      reason: '',
    },
    interestTrack: {},
    share: {},
  };
}

function normalizeRunHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object').map((item) => ({ ...item })).slice(0, 80);
}

function normalizeRuntime(raw, userId, characterId) {
  const source = asObject(raw);
  const defaults = defaultRuntime(userId, characterId);
  const scheduleProactive = asObject(source.scheduleProactive);
  const phoneChatAuto = asObject(source.phoneChatAuto);

  return {
    ...source,
    ...defaults,
    dailySchedule: { ...asObject(source.dailySchedule) },
    scheduleProactive: {
      ...scheduleProactive,
      lastRunDate: String(scheduleProactive.lastRunDate ?? '').trim(),
      triggeredKeys: asStringList(scheduleProactive.triggeredKeys),
      lastTriggeredAt: Math.max(0, Number(scheduleProactive.lastTriggeredAt) || 0),
      lastStatus: String(scheduleProactive.lastStatus ?? '').trim().slice(0, 80),
      runningSlotKey: String(scheduleProactive.runningSlotKey ?? '').trim().slice(0, 80),
      runningAt: Math.max(0, Number(scheduleProactive.runningAt) || 0),
      runHistory: normalizeRunHistory(scheduleProactive.runHistory),
    },
    phoneChatAuto: {
      ...phoneChatAuto,
      day: String(phoneChatAuto.day ?? '').trim(),
      count: Math.max(0, Math.floor(Number(phoneChatAuto.count) || 0)),
      lastRunAt: Math.max(0, Number(phoneChatAuto.lastRunAt) || 0),
      lastChatId: String(phoneChatAuto.lastChatId ?? '').trim(),
      reason: String(phoneChatAuto.reason ?? '').trim().slice(0, 80),
    },
    interestTrack: { ...asObject(source.interestTrack) },
    share: { ...asObject(source.share) },
    schemaVersion: CHARACTER_PHONE_AUTOMATION_SCHEMA_VERSION,
    userId: cleanId(userId),
    characterId: cleanId(characterId),
  };
}

async function readSetting(key) {
  return db.get('settings', key).then((row) => row?.value).catch(() => undefined);
}

/**
 * 角色手机 store 本身没有反向依赖本模块时，可复用它的规范化读取；
 * 动态导入避免把两者锁成静态循环。失败时仍可从 settings 原始值安全迁移。
 */
async function loadLegacyPhoneData(userId, characterId) {
  try {
    const store = await import('./character-phone-store.js');
    const [autoSettings, phone] = await Promise.all([
      store.loadCharacterPhoneAutoSettings(userId),
      store.loadCharacterPhone(userId, characterId),
    ]);
    return { autoSettings, phone };
  } catch (_) {
    const [autoSettings, phone] = await Promise.all([
      readSetting(`characterPhoneAutoSettings:${encodedId(userId, 'guest')}`),
      readSetting(legacyPhoneKey(userId, characterId)),
    ]);
    return { autoSettings: asObject(autoSettings), phone: asObject(phone) };
  }
}

async function readLegacy(userId, characterId) {
  const [phoneData, phoneChatAuto, phoneChatRuntime, interestTracking] = await Promise.all([
    loadLegacyPhoneData(userId, characterId),
    readSetting(legacyPhoneChatKey(userId, characterId)),
    readSetting(legacyPhoneChatRuntimeKey(userId, characterId)),
    readSetting(legacyInterestKey(userId, characterId)),
  ]);
  const autoSettings = asObject(phoneData.autoSettings);
  const perCharacter = asObject(autoSettings.perCharacter);
  const cid = cleanId(characterId);
  const dailyEnabled = Object.prototype.hasOwnProperty.call(perCharacter, cid)
    ? perCharacter[cid] === true
    : autoSettings.globalEnabled === true;
  const schedule = asObject(asObject(phoneData.phone).scheduleProactiveSettings);
  const chat = asObject(phoneChatAuto);
  const interest = asObject(interestTracking);

  return {
    config: {
      dailySchedule: { enabled: dailyEnabled },
      scheduleProactive: {
        enabled: schedule.enabled,
        dailyCount: schedule.dailyCount,
        minGapMinutes: schedule.minGapMinutes,
        busyReplyMode: schedule.busyReplyMode,
      },
      phoneChatAuto: { ...chat },
      interestTrack: {
        autoTrackEnabled: interest.autoTrackEnabled,
        autoTrackIntervalHours: interest.autoTrackIntervalHours,
        autoTrackCandidatesPerRound: interest.autoTrackCandidatesPerRound,
        socialSearchChannels: interest.socialSearchChannels,
      },
      share: {
        sharePostSearchEnabled: interest.sharePostSearchEnabled,
        shareDailyTarget: interest.shareDailyTarget,
        shareEagerness: interest.shareEagerness,
        avoidNotes: interest.avoidNotes,
        includeHotComments: interest.includeHotComments === true,
        shareSearchChannels: interest.shareSearchChannels,
        setupCardDismissed: interest.setupCardDismissed,
      },
    },
    runtime: {
      scheduleProactive: {
        lastRunDate: schedule.lastRunDate,
        triggeredKeys: schedule.triggeredKeys,
        lastTriggeredAt: schedule.lastTriggeredAt,
        lastStatus: schedule.lastStatus,
        runningSlotKey: schedule.runningSlotKey,
        runningAt: schedule.runningAt,
        runHistory: schedule.runHistory,
      },
      phoneChatAuto: asObject(phoneChatRuntime),
    },
  };
}

function mergeChannels(current, patch) {
  const next = { ...current, ...asObject(patch) };
  for (const channel of ['dailySchedule', 'scheduleProactive', 'phoneChatAuto', 'interestTrack', 'share']) {
    if (Object.prototype.hasOwnProperty.call(asObject(patch), channel)) {
      next[channel] = { ...asObject(current[channel]), ...asObject(patch[channel]) };
    }
  }
  return next;
}

export async function loadCharacterPhoneAutomationConfig(userId, characterId) {
  const key = configKey(userId, characterId);
  const stored = await readSetting(key);
  if (stored && typeof stored === 'object') return normalizeConfig(stored, userId, characterId);

  const legacy = await readLegacy(userId, characterId);
  const migrated = normalizeConfig(legacy.config, userId, characterId);
  await db.put('settings', { key, value: { ...migrated, updatedAt: Date.now() } });
  return migrated;
}

export async function saveCharacterPhoneAutomationConfig(userId, characterId, patch = {}) {
  const current = await loadCharacterPhoneAutomationConfig(userId, characterId);
  const next = normalizeConfig(mergeChannels(current, patch), userId, characterId);
  const value = { ...next, updatedAt: Date.now() };
  await db.put('settings', { key: configKey(userId, characterId), value });
  return value;
}

export async function loadCharacterPhoneAutomationRuntime(userId, characterId) {
  const key = runtimeKey(userId, characterId);
  const stored = await readSetting(key);
  if (stored && typeof stored === 'object') return normalizeRuntime(stored, userId, characterId);

  const legacy = await readLegacy(userId, characterId);
  const migrated = normalizeRuntime(legacy.runtime, userId, characterId);
  await db.put('settings', { key, value: { ...migrated, updatedAt: Date.now() } });
  return migrated;
}

export async function saveCharacterPhoneAutomationRuntime(userId, characterId, patch = {}) {
  const current = await loadCharacterPhoneAutomationRuntime(userId, characterId);
  const next = normalizeRuntime(mergeChannels(current, patch), userId, characterId);
  const value = { ...next, updatedAt: Date.now() };
  await db.put('settings', { key: runtimeKey(userId, characterId), value });
  return value;
}
